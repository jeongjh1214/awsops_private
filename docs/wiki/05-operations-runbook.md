# Operations Runbook

## 최초 설정

```bash
mkdir -p data
cp docs/examples/config.vm-private.example.json data/config.json
```

`data/config.json`에서 다음을 설정한다.

- `activeEnvironment`
- `environments.<active>.awsProfile`
- `environments.<active>.bedrockProfile`
- `environments.<active>.identityCenterProfile`
- `environments.<active>.endpointUrls`
- `queryPolicy.enabledServices`
- `accounts[]`
- `assetInventory.supportedResourceTypes`
- `identityAudit`

## 의존성 설치

```bash
node --version
npm ci
npm audit
python3 -m pip install -r agent/requirements-private.txt
```

Node.js `20.9.0` 이상을 사용한다. 정상 설치 시 `npm ci`와 `npm audit`은 `found 0 vulnerabilities`를 출력해야 한다. `npm audit fix --force`는 Next.js major version과 lint toolchain을 강제로 변경할 수 있으므로 사용하지 않는다.

회사 PC에서 `better-sqlite3` 같은 native module 오류가 나면 OS/architecture가 맞는 환경에서 `npm ci`를 다시 실행한다. macOS에서 설치한 `node_modules`를 Linux 운영 VM으로 복사하지 않는다.

## 로컬 실행

```bash
bash scripts/16-start-steampipe-private.sh
bash scripts/13-start-private-agent.sh
npm run dev
```

접속:

```text
http://127.0.0.1:3000/awsops
```

## 운영 빌드

```bash
npm run build
PORT=3000 npm run start
```

Linux 운영 VM에는 소스와 `package-lock.json`을 배포한 뒤 VM에서 직접 `npm ci && npm run build`를 실행한다.

## 기본 검증

```bash
python3 -m json.tool docs/examples/config.vm-private.example.json >/dev/null
bash -n scripts/*.sh
node tests/assets/test_identity_audit_config.mjs
node tests/assets/test_identity_audit_db.mjs
node tests/assets/test_identity_audit_runner.mjs
npm test
npm run lint
npm run build
```

## Steampipe 확인

```bash
steampipe service status
steampipe query "select instance_id, instance_state from aws_ec2_instance limit 5"
```

S3 VPCE 자체 연결과 Steampipe table을 함께 확인한다.

```bash
AWS_PROFILE=awsops-local-profile aws s3api list-buckets \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.s3.ap-northeast-2.vpce.amazonaws.com

bash scripts/16-start-steampipe-private.sh
steampipe query "select account_id, name, region from aws_s3_bucket limit 5"
```

## Private AI 확인

```bash
bash scripts/13-verify-private-agent.sh
curl -fsS http://127.0.0.1:7000/health | python3 -m json.tool
```

AI Assistant에서 Bedrock profile이 잘못 잡히면 `data/config.json`의 `bedrockProfile`과 `endpointUrls["bedrock-runtime"]`을 먼저 확인한다.

## Cloud Assets 운영

1. `Cloud Assets` 메뉴에서 sync 실행
2. DB 확인

```bash
sqlite3 data/awsops.db \
  "select service, resource_type, count(*) from asset_records group by 1,2;"
```

3. 담당팀, 업무 시스템, module, phase, 용도 등 metadata 입력
4. CSV export 또는 AI 요약 사용

## S3 관리대장 운영

1. S3 bucket sync 실행
2. `S3 관리대장` 메뉴에서 `수집 버킷 불러오기`
3. bucket별 담당조직/용도/개인정보/보존기간 항목 입력
4. 변경 이력 확인
5. CSV export

## Identity 감사 운영

환경변수:

```bash
export KREW_API_KEY='...'
```

수동 실행:

```bash
curl -fsS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"action":"run"}' \
  http://127.0.0.1:3000/awsops/api/identity-audit | python3 -m json.tool
```

결과 확인:

```bash
curl -fsS http://127.0.0.1:3000/awsops/api/identity-audit | python3 -m json.tool
```

DB 확인:

```bash
sqlite3 data/awsops.db \
  "select display_name, old_org_name, new_org_name, assignment_count, severity from identity_audit_findings order by created_at desc limit 20;"
```

## 로그 확인

Private agent:

```bash
tail -n 100 data/private-agent/langgraph-api.log
```

Next.js 운영 프로세스는 systemd, pm2, nohup 등 실제 운영 방식의 stdout/stderr 로그를 확인한다.

## 백업

최소 백업 대상:

- `data/awsops.db`
- `data/config.json`
- Steampipe config
- 운영 프로세스 로그

`data/awsops.db`에는 자산관리, S3 관리대장, Identity 감사 이력이 들어 있으므로 운영 백업 대상에 포함한다.
