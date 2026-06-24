# Cloud Asset Inventory Design

## Goal

AWSops에 클라우드 자산관리 기능을 추가한다. 이 기능은 AWS에 실제 존재하는 리소스를 Steampipe로 자동 발견하고, 운영자가 관리해야 하는 담당팀, 모듈, 용도, 중요도, 보안 등급 같은 자산관리 메타데이터를 AWSops 내부 DB에 저장한다.

1차 목표는 전사 CMDB 대체가 아니라, NetBox가 현재 커버하지 못하는 AWS 클라우드 리소스의 빠른 변경, 누락 메타데이터, 신규/삭제 리소스를 추적하는 것이다.

## Non-Goals

- AWS 리소스를 생성, 수정, 삭제하지 않는다.
- CDK, Terraform, CloudFormation 등 인프라 생성 기능을 추가하지 않는다.
- NetBox를 즉시 대체하지 않는다.
- AI가 자산 메타데이터를 직접 저장하거나 수정하지 않는다.
- 1차 범위에서 SSO, Cognito, IAM Identity Center 인증을 새로 붙이지 않는다.

## Product Shape

새 메뉴는 `Cloud Assets` 또는 `자산관리`로 추가한다. 자산관리의 기준 단위는 개별 AWS 리소스 1개다.

예시는 다음과 같다.

```text
EC2 instance 1개 = 자산 1개
S3 bucket 1개 = 자산 1개
RDS instance 1개 = 자산 1개
Security Group 1개 = 자산 1개
```

업무시스템이나 서비스 단위 묶음은 1차 기능으로 만들지 않는다. 대신 각 자산 row에 `담당팀`, `사용 모듈`, `업무 시스템명` 같은 필드를 입력할 수 있게 해서 같은 목적을 단순하게 달성한다.

## Data Sources

### Steampipe

Steampipe는 실제 AWS 리소스의 현재 상태를 조회한다. 1차 지원 리소스는 다음 테이블을 기준으로 한다.

```text
aws_ec2_instance
aws_ebs_volume
aws_ec2_network_interface
aws_ec2_application_load_balancer
aws_ec2_network_load_balancer
aws_vpc
aws_vpc_subnet
aws_vpc_security_group
aws_rds_db_instance
aws_s3_bucket
aws_lambda_function
```

CloudFront는 내부망 운영 제약상 기본 지원 리소스에서 제외한다.

### AWSops DB

AWSops DB는 사람이 관리하는 메타데이터, 커스텀 필드 정의, 변경 이력을 저장한다. 기본 저장소는 새 AWS 리소스가 필요 없는 SQLite 파일이다.

```text
data/awsops.db
```

향후 사내 승인 PostgreSQL을 사용할 수 있으면 config로 DB provider를 전환할 수 있게 설계한다.

## Storage Design

### asset_records

Steampipe에서 발견한 현재 리소스를 정규화해서 저장한다.

```text
id
provider
account_id
account_name
region
service
resource_type
resource_id
resource_name
arn
status
native_state
tags_json
source_table
source_updated_at
first_discovered_at
last_seen_at
is_active
last_hash
created_at
updated_at
```

`id`는 안정적인 synthetic key다.

```text
aws:{account_id}:{region}:{service}:{resource_type}:{resource_id}
```

글로벌 리소스는 region을 `global`로 저장한다.

### asset_metadata

운영자가 입력하는 기본 자산관리 필드를 저장한다.

```text
asset_id
owner_team
owner_person
business_system
module_name
phase
purpose
criticality
security_grade
cost_center
contains_personal_info
remarks
updated_by
updated_at
```

기본 phase 값은 `local`, `dev`, `stg`, `prod`, `unknown`을 지원한다. 조직에서 다른 phase를 쓰는 경우 커스텀 필드로 확장하거나 config 옵션으로 추가한다.

### asset_custom_field_definitions

관리자가 커스텀 필드를 정의한다.

```text
id
key
label
type
options_json
required
applies_to_services_json
applies_to_resource_types_json
display_order
active
created_by
created_at
updated_at
```

지원 타입은 다음으로 제한한다.

```text
text
textarea
select
multi_select
boolean
date
number
url
owner
```

`key`는 API와 CSV에서 안정적으로 쓰기 위해 영문 소문자, 숫자, underscore만 허용한다.

### asset_custom_field_values

자산별 커스텀 필드 값을 저장한다.

```text
asset_id
field_id
value_json
updated_by
updated_at
```

### asset_change_events

자동 발견과 수동 변경 이력을 저장한다.

```text
id
asset_id
event_type
event_source
summary
before_json
after_json
created_by
created_at
```

event_type은 다음 값을 사용한다.

```text
discovered
rediscovered
changed
missing
restored
metadata_updated
custom_field_updated
custom_field_definition_changed
```

## Sync Design

동기화는 읽기 전용 Steampipe 쿼리로 수행한다.

1. 지원 리소스별 Steampipe SQL을 실행한다.
2. 각 row를 `asset_records` 형태로 정규화한다.
3. 같은 `asset_id`가 있으면 `last_seen_at`, `status`, `tags_json`, `last_hash`를 갱신한다.
4. 기존 asset이 이번 sync에서 보이지 않으면 즉시 삭제하지 않고 `is_active=false`, `event_type=missing`으로 표시한다.
5. 다시 발견되면 `is_active=true`, `event_type=restored`로 표시한다.

삭제 판단은 보수적으로 한다. 단일 sync 실패로 자산을 missing 처리하지 않도록 sync run 단위의 성공/실패 상태를 기록한다.

## API Design

새 API route는 `/awsops/api/assets`를 사용한다.

```text
GET  /api/assets
GET  /api/assets/:id
POST /api/assets/sync
PATCH /api/assets/:id/metadata
GET  /api/assets/custom-fields
POST /api/assets/custom-fields
PATCH /api/assets/custom-fields/:id
DELETE /api/assets/custom-fields/:id
GET  /api/assets/export.csv
POST /api/assets/import.csv
```

자산 조회와 메타데이터 수정은 내부망 사용자에게 허용한다. 커스텀 필드 정의 변경은 admin 권한이 필요하다.

## Admin Control

현재 private VM 모드에서는 Cognito와 일반 인증을 제거했으므로 1차 admin 제어는 admin token으로 한다.

설정은 환경변수를 우선 사용한다.

```text
AWSOPS_ASSET_ADMIN_TOKEN_HASH
```

개발 편의를 위해 `data/config.json`에도 다음 값을 허용할 수 있지만, 운영에서는 환경변수를 권장한다.

```json
{
  "assetInventory": {
    "adminTokenHash": "sha256:..."
  }
}
```

admin token은 커스텀 필드 정의 추가, 수정, 삭제와 destructive import에만 필요하다. 일반 메타데이터 값 입력은 내부망 사용자 작업으로 본다.

## UI Design

### List View

자산 목록은 조밀한 운영형 테이블로 구성한다.

기본 컬럼:

```text
Account
Region
Service
Resource Type
Resource Name
Resource ID
Status
Owner Team
Module
Phase
Criticality
Security Grade
Last Seen
Metadata Completeness
```

필터:

```text
account
region
service
resource_type
phase
owner_team
module_name
is_active
metadata_missing
newly_discovered
missing
```

### Detail Panel

자산 row 클릭 시 상세 패널을 연다.

상세 패널 섹션:

```text
Resource Identity
AWS Tags
Managed Metadata
Custom Fields
Change History
```

### Custom Field Admin

admin token이 확인된 사용자만 커스텀 필드 관리 화면에 접근한다.

관리 화면 기능:

```text
필드 추가
필드 수정
비활성화
표시 순서 변경
서비스/리소스 타입 적용 범위 설정
필수 여부 설정
```

필드 삭제는 물리 삭제 대신 `active=false`로 비활성화한다.

### CSV Import/Export

CSV export는 현재 필터 결과를 내보낸다. CSV import는 기존 자산의 메타데이터와 커스텀 필드 값을 갱신한다.

필수 식별 컬럼:

```text
account_id
region
service
resource_type
resource_id
```

또는 `asset_id` 단일 컬럼을 사용할 수 있다.

## AI Design

AI Assistant는 자산관리 데이터를 읽고 표, 요약, 누락 진단, CSV 초안을 생성한다.

허용되는 AI 사용:

```text
담당팀 없는 자산 표로 정리
운영 phase인데 보안등급 없는 자산 요약
최근 7일 신규 발견 자산 목록
사라진 자산 중 prod phase만 필터링
특정 팀이 사용하는 리소스 목록
커스텀 필드 기준으로 누락 항목 찾기
```

금지되는 AI 사용:

```text
AI가 asset_metadata 직접 저장
AI가 custom field 정의 변경
AI가 Steampipe 외 AWS API로 리소스 변경
AI가 승인 없이 CSV import 실행
```

AI route는 asset DB 조회 결과를 컨텍스트로 Bedrock에 전달한다. 응답에는 사용한 필터와 row count를 포함한다.

## Configuration

`data/config.json` 예시는 다음과 같다.

```json
{
  "assetInventory": {
    "enabled": true,
    "dbProvider": "sqlite",
    "sqlitePath": "data/awsops.db",
    "syncOnDemandOnly": true,
    "adminTokenHash": "",
    "supportedResourceTypes": [
      "ec2_instance",
      "ebs_volume",
      "network_interface",
      "load_balancer",
      "vpc",
      "subnet",
      "security_group",
      "rds_instance",
      "s3_bucket",
      "lambda_function"
    ]
  }
}
```

`syncOnDemandOnly=true`가 기본이다. 운영 초기에는 자동 주기 sync를 켜지 않고 사용자가 버튼으로 sync를 실행한다.

## Error Handling

- Steampipe 쿼리 실패 시 해당 리소스 타입만 실패로 표시하고 전체 sync를 중단하지 않는다.
- sync run 자체가 실패한 경우 기존 자산을 missing 처리하지 않는다.
- SQLite 파일이 없으면 앱 시작 또는 첫 API 호출 때 생성한다.
- DB migration 실패 시 읽기 기능도 fail closed하고 명확한 오류를 보여준다.
- custom field type이 맞지 않는 값은 저장 전에 validation error를 반환한다.

## Security And Compliance

- 모든 AWS 조회는 기존 Steampipe 경로를 사용한다.
- AWS 리소스 생성/수정/삭제 API는 호출하지 않는다.
- 커스텀 필드 정의 변경은 admin token을 요구한다.
- admin token 원문은 저장하지 않고 hash만 비교한다.
- 변경 이력은 누가, 언제, 어떤 필드를 바꿨는지 남긴다.
- CSV import는 preview 단계와 apply 단계를 분리한다.

## Rollout Plan

1. SQLite storage와 migration helper를 추가한다.
2. 자산 정규화 쿼리와 sync API를 만든다.
3. 목록/상세 UI를 추가한다.
4. 기본 메타데이터 편집을 추가한다.
5. 커스텀 필드 admin UI와 token 검증을 추가한다.
6. CSV export/import를 추가한다.
7. AI Assistant에 read-only asset query route를 추가한다.
8. 문서와 sample config를 업데이트한다.

## Testing

테스트는 다음을 포함한다.

```text
asset_id 생성 규칙
Steampipe row 정규화
SQLite migration idempotency
metadata update validation
custom field type validation
admin token required behavior
sync missing/restored behavior
CSV import preview/apply
AI asset query read-only guard
```

빌드 검증은 다음 명령을 기준으로 한다.

```bash
node tests/private/test_private_ai_runtime.mjs
python3 -m unittest discover -s tests/private -p 'test_*.py' -v
./node_modules/.bin/tsc --noEmit --pretty false
npm run build
```

## Acceptance Criteria

- 사용자는 AWS 리소스 목록을 자산관리 테이블로 볼 수 있다.
- 사용자는 자산별 담당팀, 모듈, phase, 용도, 중요도, 보안등급, 비고를 저장할 수 있다.
- 관리자는 커스텀 필드를 추가, 수정, 비활성화할 수 있다.
- 일반 사용자는 커스텀 필드 정의를 변경할 수 없다.
- 신규 발견, 사라짐, 복구, 메타데이터 변경 이력이 남는다.
- AI Assistant는 자산 데이터를 기반으로 표와 요약을 생성하지만 DB를 직접 수정하지 않는다.
- CloudFront는 기본 지원 대상에서 제외된다.
- 새 AWS 인프라 리소스를 생성하지 않는다.
