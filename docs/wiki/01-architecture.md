# AWSops Architecture

## 전체 구조

```text
Internal user/browser
  |
  | internal DNS, proxy, direct VM URL
  v
Existing local/dev/prod host
  |
  |-- Next.js dashboard :3000
  |-- Steampipe PostgreSQL :9193
  |-- Local LangGraph API :7000
  |-- Local MCP tool server :7100 or stdio
  |-- SQLite data/awsops.db
  |
  | AWS SDK / Steampipe / Bedrock Runtime calls
  v
Existing VPC Endpoint or private DNS
  |
  v
Approved AWS service APIs
```

## Component

### Next.js dashboard

`src/app` 아래의 화면과 API route가 운영 UI를 제공한다.

주요 메뉴:

- `Cloud Assets`: cloud resource 자산 원장
- `S3 관리대장`: S3 bucket 관리대장
- `Identity 감사`: IAM Identity Center 조직 변경 감사
- `AI 어시스턴트`: local LangGraph/MCP 기반 AI 질의

### Steampipe

Steampipe는 AWS resource 조회용 SQL runtime이다.

- AWSops가 Steampipe service를 직접 embedding하지 않는다.
- `scripts/16-start-steampipe-private.sh`가 AWSops config를 읽고 connection file과 endpoint 환경변수를 준비한다.
- EC2와 S3를 포함한 Cloud Asset sync는 Steampipe query를 사용한다.
- S3 화면과 AI Assistant의 live S3 질문도 동일한 `aws_s3_bucket` table을 사용한다.

### AWS SDK 직접 호출

다음 기능은 AWS SDK를 직접 사용한다.

- IAM Identity Center 조직 변경 감사
- Bedrock Runtime 호출

각 호출은 목적별 profile을 분리한다.

| 목적 | 설정 |
| --- | --- |
| 일반 AWS resource 조회 | `environments.<active>.awsProfile` 또는 `accounts[].profile` |
| Bedrock Runtime | `environments.<active>.bedrockProfile` |
| IAM Identity Center 감사 | `identityAudit.awsProfile` 우선, 없으면 `identityCenterProfile` |

### Local MCP + LangGraph

Private AI는 Bedrock AgentCore를 사용하지 않는다.

- `agent/langgraph_api.py`: local chat API
- `agent/mcp_server.py`: local MCP tool scaffold
- `agent/private_runtime/`: config, endpoint, client, audit, runtime limit helper
- `/awsops/api/ai`: dashboard AI route

Bedrock 호출은 Bedrock Runtime endpoint와 `bedrockProfile`을 사용한다.

Next.js AI route와 local LangGraph API에는 동일한 요청 제한이 적용된다.

- request body 최대 512 KB
- message 최대 50개
- message당 최대 50,000자
- 전체 message content 최대 200,000자

### SQLite DB

`data/awsops.db`는 AWSops의 내부 원장 DB다.

저장 영역:

- `asset_records`, `asset_metadata`: Cloud Asset Inventory
- `s3_governance_records`, `s3_governance_events`: S3 관리대장
- `identity_audit_runs`: Identity 감사 실행 이력
- `identity_users`: Identity 사용자 현재 상태
- `identity_org_snapshots`: 조직정보 스냅샷
- `identity_org_change_events`: 조직 변경 이벤트
- `identity_aws_assignments`: AWS 권한 assignment 스냅샷
- `identity_audit_findings`: 감사 finding

## Data Flow

### Cloud Asset Inventory

```text
사용자 sync 실행
  -> Next.js API
  -> Steampipe query
  -> 빈 결과이면 동일 account의 aws_caller_identity로 data path 확인
  -> resource normalize
  -> data/awsops.db 저장
  -> Cloud Assets UI / CSV / AI context
```

기존 active asset이 있는데 query 결과가 비어 있으면 account-scoped health probe가 성공한 경우에만 해당 asset을 `missing`으로 기록한다. Account를 지정하지 않은 전체 sync의 빈 결과는 삭제 증거로 사용하지 않는다.

### S3 관리대장

```text
S3 bucket sync
  -> asset_records에 bucket 저장
  -> 수집 버킷 불러오기
  -> s3_governance_records 생성
  -> 담당조직/용도/개인정보/보존기간 수동 관리
  -> 변경 이력 s3_governance_events 저장
```

### Identity 감사

```text
수동 실행 또는 화요일 10시 KST scheduler
  -> IAM Identity Center users/groups/permission sets/account assignments 수집
  -> DisplayName 기준 knock API 호출
  -> orgCode/orgName 스냅샷 저장
  -> 직전 orgCode와 비교
  -> 부서 변경자 중 AWS 권한 잔존자 finding 생성
```

## Endpoint 전략

local/dev는 explicit endpoint URL을 기본으로 한다.

예:

- `bedrock-runtime`
- `sts`
- `s3`
- `identitystore`
- `sso-admin`

prod는 AWS VM의 private DNS가 준비되어 있으면 endpoint URL을 생략할 수 있다. 일부 서비스만 explicit endpoint가 필요하면 hybrid mode를 사용한다.

## Build/Runtime 주의사항

- Identity 감사 scheduler는 module import/build 시점에 AWS API나 조직 API를 호출하지 않는다.
- Identity 감사 scheduler는 API route가 호출된 뒤 lazy start 된다.
- `NEXT_PHASE=phase-production-build`에서는 Identity 감사 scheduler start가 no-op이다.
- `npm run build` 중 생성되는 `.next`는 소스가 아니며 git에 포함하지 않는다.
