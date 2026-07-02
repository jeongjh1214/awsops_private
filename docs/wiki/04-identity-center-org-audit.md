# IAM Identity Center 조직 변경 감사

## 목적

부서 이동자가 기존 AWS 권한을 계속 보유하는 문제를 탐지하기 위한 감사 기능이다.

AWS Identity Store에는 부서 정보가 노출되지 않는 경우가 있으므로, 조직 정보는 사내 knock API를 기준 데이터로 사용한다.

## 핵심 판단 기준

| 항목 | 기준 |
| --- | --- |
| 사용자 연결 key | IAM Identity Center `DisplayName` |
| 조직 lookup | `GET /papi/v1/krew/{DisplayName}` |
| 변경 판단 | `data.mainPosition.orgCode` |
| 표시값 | `data.mainPosition.orgName` |
| 위험 finding | orgCode가 바뀐 사용자에게 AWS assignment가 남아 있음 |

## 수집 대상

IAM Identity Center:

- users
- groups
- group memberships
- permission sets
- account assignments

조직 API:

```http
GET https://knock-api.kakaopay.com/papi/v1/krew/{DisplayName}
X-API-Key: ${KREW_API_KEY}
```

필요 응답:

```json
{
  "data": {
    "mainPosition": {
      "orgCode": "ABC12345",
      "orgName": "클라우드파트"
    }
  }
}
```

## 처리 흐름

```text
Identity 감사 실행
  -> IAM Identity Center instance 조회
  -> Identity Store users/groups/memberships 수집
  -> SSO Admin permission set/account assignment 수집
  -> group assignment를 사용자 단위로 펼침
  -> DisplayName 기준 knock API 호출
  -> orgCode/orgName 스냅샷 저장
  -> 이전 orgCode와 현재 orgCode 비교
  -> 변경자 중 assignment_count > 0이면 finding 생성
```

## 저장 테이블

| 테이블 | 설명 |
| --- | --- |
| `identity_audit_runs` | 감사 실행 단위 |
| `identity_users` | 사용자 현재 상태 |
| `identity_org_snapshots` | 실행 시점별 조직정보 원본 |
| `identity_org_change_events` | orgCode 변경 이벤트 |
| `identity_aws_assignments` | 사용자 단위로 펼친 AWS 권한 assignment |
| `identity_audit_findings` | 부서 이동 후 권한 잔존 finding |

## Finding 조건

Finding type:

```text
ORG_CHANGED_WITH_AWS_ACCESS
```

조건:

1. 이전 `current_org_code`가 존재한다.
2. 현재 `orgCode`가 비어 있지 않다.
3. 이전 `orgCode`와 현재 `orgCode`가 다르다.
4. 해당 사용자에게 AWS assignment가 1개 이상 남아 있다.

Severity:

- assignment 1~2개: `medium`
- assignment 3개 이상: `high`

## 실행 방법

수동 실행:

```bash
curl -fsS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"action":"run"}' \
  http://127.0.0.1:3000/awsops/api/identity-audit | python3 -m json.tool
```

결과 조회:

```bash
curl -fsS http://127.0.0.1:3000/awsops/api/identity-audit | python3 -m json.tool
```

CSV export:

```bash
curl -fsS \
  http://127.0.0.1:3000/awsops/api/identity-audit?action=export \
  -o identity-audit-findings.csv
```

## 스케줄

기본 스케줄:

```text
매주 화요일 10:00 KST
```

스케줄러 특징:

- Next.js API route가 호출된 뒤 lazy start
- module import 또는 `npm run build` 중 AWS/API 호출 없음
- 5분마다 due check
- 같은 화요일 10시 hour 안에서 중복 실행 방지
- 실패 시 log만 남기고 프로세스를 죽이지 않음

## 설정

`data/config.json`:

```json
{
  "identityAudit": {
    "enabled": true,
    "region": "ap-northeast-2",
    "awsProfile": "identity-audit-profile",
    "schedule": {
      "dayOfWeek": 2,
      "hourKst": 10,
      "timezone": "Asia/Seoul"
    },
    "organizationApi": {
      "baseUrl": "https://knock-api.kakaopay.com/papi/v1/krew",
      "apiKeyEnv": "KREW_API_KEY",
      "lookupField": "displayName",
      "concurrency": 10,
      "timeoutMs": 5000,
      "retryCount": 2
    }
  }
}
```

환경변수:

```bash
export KREW_API_KEY='...'
```

## 필요한 AWS 권한

읽기 권한만 필요하다.

- `sso-admin:ListInstances`
- `sso-admin:ListPermissionSets`
- `sso-admin:DescribePermissionSet`
- `sso-admin:ListAccountsForProvisionedPermissionSet`
- `sso-admin:ListAccountAssignments`
- `identitystore:ListUsers`
- `identitystore:ListGroups`
- `identitystore:ListGroupMemberships`

## 운영 확인 쿼리

최근 실행:

```bash
sqlite3 data/awsops.db \
  "select id, status, started_at, finished_at, total_users, changed_users, risky_users, error_count from identity_audit_runs order by started_at desc limit 5;"
```

Finding:

```bash
sqlite3 data/awsops.db \
  "select display_name, old_org_name, new_org_name, assignment_count, severity from identity_audit_findings order by created_at desc limit 20;"
```

사용자 권한:

```bash
sqlite3 data/awsops.db \
  "select display_name, account_id, permission_set_name, assignment_type, group_name from identity_aws_assignments where display_name='billy.j';"
```

## 현재 제한

- 조직 기준 데이터는 knock API의 `mainPosition`만 사용한다.
- 퇴사/휴직 상태 판단은 조직 API 응답에 상태값이 추가되면 확장한다.
- Identity 감사 finding의 AI 질의 연동은 설계 완료 상태이며 구현 예정이다.
