# Cloud Asset Inventory와 S3 관리대장

## 목적

Cloud Asset Inventory는 AWS resource를 내부 자산관리 대상으로 원장화하기 위한 기능이다.

기존 NetBox가 VM 중심이라면, AWSops는 cloud resource의 생성/변경/삭제 흐름과 담당조직, 업무 모듈, phase, 용도 같은 운영 메타데이터를 관리한다.

## Cloud Asset Inventory

### 저장 위치

SQLite DB:

```text
data/awsops.db
```

주요 테이블:

- `asset_records`: AWS resource 수집 원장
- `asset_metadata`: 담당팀, 담당자, 업무 시스템, module, phase, 용도 등 운영 메타데이터
- `asset_custom_field_definitions`: custom field 정의
- `asset_custom_field_values`: custom field 값
- `asset_change_events`: 자산 변경 이벤트
- `asset_sync_runs`: sync 실행 이력

### 현재 sync 대상

기본 allowlist:

- `ec2_instance`
- `s3_bucket`

S3 bucket은 Steampipe hydrate 문제가 있을 수 있어 AWS SDK `ListBuckets`로 직접 수집한다. 이때 `data/config.json`의 account profile, region, `endpointUrls.s3`를 사용한다.

### AI 사용 방식

Cloud Asset Inventory AI 답변은 저장된 SQLite 원장을 기준으로 한다.

AI가 직접 수행하지 않는 작업:

- live AWS discovery
- Steampipe sync 실행
- CSV import 적용
- metadata 수정

## S3 관리대장

S3 관리대장은 일반 S3 현황 화면과 분리된 관리 목적의 원장이다.

관리 컬럼:

- account name
- account id
- phase
- bucket name
- 담당조직
- 용도
- 이력
- 개인정보 데이터 유무 여부
- 개인정보 데이터 유효기간 인지여부
- 개인정보 데이터 유효기간 적용여부
- 적용 데이터 유효기간
- 비고

## S3 관리대장 데이터 흐름

```text
S3 bucket sync
  -> asset_records에 s3_bucket 저장
  -> S3 관리대장 화면에서 "수집 버킷 불러오기"
  -> s3_governance_records row 생성
  -> 운영자가 담당조직/용도/개인정보 항목 입력
  -> 변경 이력 s3_governance_events 저장
```

## 삭제된 bucket 처리

S3 관리대장 row는 bucket 삭제 후에도 유지된다.

이유:

- 감사 이력 보존
- 개인정보/보존기간 관련 운영 증적 유지
- bucket 삭제 전후 담당조직/용도 변경 이력 확인

현재 bucket 존재 여부는 `asset_records.is_active`와 join해서 표시한다.

## 운영 절차

1. `data/config.json`에서 `assetInventory.enabled`를 확인한다.
2. `supportedResourceTypes`에 `s3_bucket`이 있는지 확인한다.
3. `endpointUrls.s3`와 account profile을 설정한다.
4. Cloud Assets sync를 실행한다.
5. S3 관리대장에서 `수집 버킷 불러오기`를 실행한다.
6. 각 bucket의 담당조직/용도/개인정보 항목을 입력한다.
7. CSV export로 감사 제출용 데이터를 만든다.

## 장애 확인

S3 bucket이 보이지 않을 때:

```bash
AWS_PROFILE=awsops-local-profile aws s3api list-buckets \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.s3.ap-northeast-2.vpce.amazonaws.com
```

DB 확인:

```bash
sqlite3 data/awsops.db \
  "select account_id, resource_name, is_active from asset_records where service='s3' order by resource_name;"
```

관리대장 확인:

```bash
sqlite3 data/awsops.db \
  "select account_id, bucket_name, owner_team, purpose from s3_governance_records order by bucket_name;"
```
