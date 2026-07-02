# 현재 상태와 Roadmap

## 완료

### Private VM-only 전환

- CDK/CloudFormation 기반 인프라 배포 경로 제거
- CloudFront/Cognito/AgentCore 사용 제외
- local/dev/prod 환경을 `data/config.json`으로 관리
- 기존 VPC Endpoint와 AWS profile만 사용하는 구조로 정리

### Private AI Runtime

- local MCP + LangGraph API 사용
- Bedrock Runtime profile/endpoint 분리
- AgentCore dependency 제거 방향으로 정리

### Cloud Asset Inventory

- SQLite 기반 자산 원장
- EC2 instance sync
- S3 bucket sync
- metadata/custom field 관리
- CSV import/export
- 저장된 자산 원장 기반 AI 질의

### S3 관리대장

- `s3_governance_records`
- `s3_governance_events`
- 수집 bucket 기반 seed
- 삭제된 bucket 이력 유지
- 개인정보/보존기간 관리 컬럼
- CSV export

### IAM Identity Center 조직 변경 감사

- 별도 `identityAudit.awsProfile`
- IAM Identity Center users/groups/permission sets/account assignments 수집
- group assignment 사용자 단위 확장
- knock API 기반 `orgCode/orgName` 조회
- 조직 변경 이벤트 저장
- 부서 이동 후 AWS 권한 잔존 finding 생성
- 수동 실행 API
- 매주 화요일 10시 KST scheduler
- Identity 감사 화면
- CSV export

## 진행 중 또는 예정

### Identity 감사 AI context

목표:

- AI Assistant가 저장된 `identity_audit_findings` 기반으로 답변
- "부서 이동 후 권한 남은 사람 보여줘" 같은 질문 지원
- 실시간 AWS/knock API 호출 없이 DB 기준으로만 답변

현재 상태:

- 설계와 구현 계획은 있음
- 코드 반영은 아직 남아 있음

### 지원 resource type 확대

현재 기본 sync 대상:

- `ec2_instance`
- `s3_bucket`

추가 후보:

- RDS
- Lambda
- Security Group
- EBS
- DynamoDB

추가 조건:

- Steampipe table 또는 AWS SDK collector 준비
- VPC Endpoint 경로 확인
- normalizer 구현
- tests 추가
- `assetInventory.supportedResourceTypes` allowlist 반영

### 운영 알림

Identity 감사 finding을 Slack, email, 사내 알림 중 어떤 채널로 보낼지 결정 필요.

초기 버전은 화면/CSV/DB 확인을 기준으로 한다.

## 남은 운영 결정

- `data/awsops.db` 백업 주기와 보관 기간
- Identity 감사 finding 처리 완료 상태 관리 여부
- 조직 API에 재직상태/휴직상태가 추가될 경우 감사 조건 확장 여부
- custom field 정의 변경을 어떤 방식으로 admin-only 처리할지
- 운영 VM process manager 표준화

## 주요 검증 명령

```bash
node tests/assets/test_identity_audit_config.mjs
node tests/assets/test_identity_audit_db.mjs
node tests/assets/test_identity_audit_runner.mjs
npm test
npm run build
```

## 참고 문서

- `docs/superpowers/specs/2026-06-24-cloud-asset-inventory-design.md`
- `docs/superpowers/specs/2026-06-27-identity-center-org-audit-design.md`
- `docs/superpowers/plans/2026-06-24-cloud-asset-inventory.md`
- `docs/superpowers/plans/2026-06-27-identity-center-org-audit.md`
