# IAM Identity Center 조직 변경 감사 설계

## 배경

금융권 감사 대응을 위해 IAM Identity Center 권한 보유자 중 부서 이동자가 계속 AWS 권한을 가지고 있는지 점검해야 한다. AWS Identity Store에는 현재 부서 정보가 노출되지 않으므로, 조직 정보는 사내 knock API를 기준 데이터로 사용한다.

이 기능은 awsops의 기존 자산관리 방향과 맞춘다. AWS 리소스를 생성하거나 수정하지 않고, 기존 VPC Endpoint와 설정된 AWS profile을 통해 읽기 전용으로 수집한다.

## 목표

- IAM Identity Center 사용자, 그룹, Permission Set, Account Assignment 현황을 수집한다.
- Identity Center 사용자 `DisplayName`을 사내 조직 API의 `{accountid}` lookup key로 사용한다.
- 조직 API 응답의 `data.mainPosition.orgCode`, `data.mainPosition.orgName`을 저장한다.
- 이전 수집값과 현재 수집값의 `orgCode`를 비교해 부서 변경 이벤트를 만든다.
- 부서 변경자 중 AWS 권한이 남아 있는 사용자를 감사 finding으로 표시한다.
- 매주 화요일 10시 KST 자동 점검과 수동 실행을 모두 지원한다.

## 비목표

- AWS 리소스 생성, 수정, 삭제는 하지 않는다.
- IAM Identity Center, Permission Set, Account Assignment를 변경하지 않는다.
- LDAP/AD를 직접 조회하지 않는다.
- 조직 API Key를 Git에 저장하지 않는다.
- 초기 버전에서는 메일/메신저 발송을 필수 구현 범위로 두지 않는다. 알림은 DB finding과 화면 표시를 먼저 만든 뒤 확장한다.

## 데이터 출처

### AWS

IAM Identity Center 관련 호출은 별도 profile을 사용한다. 이 profile은 Bedrock profile, 자산수집 profile과 독립적이어야 한다.

필요한 읽기 API 범위:

- `sso-admin:ListInstances`
- `sso-admin:ListPermissionSets`
- `sso-admin:DescribePermissionSet`
- `sso-admin:ListAccountsForProvisionedPermissionSet`
- `sso-admin:ListAccountAssignments`
- `identitystore:ListUsers`
- `identitystore:DescribeUser`
- `identitystore:ListGroups`
- `identitystore:DescribeGroup`
- `identitystore:ListGroupMemberships`
- `identitystore:ListGroupMembershipsForMember`

구현은 AWS SDK를 우선 사용한다. Steampipe 사용 여부와 무관하게 앱 DB에 스냅샷을 저장해야 7일 전/지난 실행 비교가 가능하다.

### 조직 API

사용자별 조직 정보는 다음 API로 조회한다.

```bash
curl -H "X-API-Key: $KREW_API_KEY" \
  "https://knock-api.kakaopay.com/papi/v1/krew/{DisplayName}"
```

필요 응답 필드:

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

변경 판단 기준은 `orgCode`다. `orgName`은 표시와 이력 설명에 사용한다.

## 설정

`data/config.json`에는 비밀값을 저장하지 않는다. 조직 API Key는 환경변수로 주입한다.

예시:

```json
{
  "identityAudit": {
    "enabled": true,
    "awsProfile": "identity-center-audit-profile",
    "region": "ap-northeast-2",
    "schedule": {
      "dayOfWeek": 2,
      "hour": 10,
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

환경별 profile은 다음 우선순위로 해석한다.

1. `identityAudit.awsProfile`
2. 현재 environment의 `identityCenterProfile`
3. 현재 environment의 `awsProfile`

운영 혼선을 줄이기 위해 실제 구현에서는 1번을 권장하고, 설정 누락 시 경고를 남긴다.

## 저장 모델

기존 `data/awsops.db` SQLite 파일을 사용한다. 현재 자산관리와 S3 관리대장이 같은 DB를 쓰므로 운영과 백업 모델을 단순하게 유지할 수 있다.

### identity_audit_runs

실행 단위 메타데이터를 저장한다.

- `id`
- `status`: `running`, `completed`, `failed`
- `started_at`
- `finished_at`
- `total_users`
- `org_resolved_users`
- `changed_users`
- `risky_users`
- `error_count`
- `error_message`

### identity_users

사용자의 현재 상태를 저장한다.

- `display_name` primary key
- `identity_store_user_id`
- `user_name`
- `email`
- `current_org_code`
- `current_org_name`
- `current_assignment_count`
- `is_active`
- `first_seen_at`
- `last_seen_at`
- `updated_at`

### identity_org_snapshots

실행 시점별 조직 원본 스냅샷을 저장한다.

- `id`
- `run_id`
- `display_name`
- `org_code`
- `org_name`
- `raw_json`
- `collected_at`

### identity_org_change_events

조직 변경 이벤트를 저장한다.

- `id`
- `run_id`
- `display_name`
- `old_org_code`
- `old_org_name`
- `new_org_code`
- `new_org_name`
- `detected_at`

같은 실행에서 같은 사용자의 동일 변경 이벤트는 중복 저장하지 않는다.

### identity_aws_assignments

실행 시점의 AWS 권한 연결 상태를 저장한다.

- `id`
- `run_id`
- `display_name`
- `identity_store_user_id`
- `account_id`
- `account_name`
- `permission_set_arn`
- `permission_set_name`
- `assignment_type`: `USER` 또는 `GROUP`
- `group_id`
- `group_name`
- `collected_at`

그룹 assignment는 실제 사용자 단위로 펼쳐 저장한다. 그래야 "이 사용자가 아직 권한이 있는가"를 화면과 AI에서 바로 답할 수 있다.

### identity_audit_findings

감사 대상 결과를 저장한다.

- `id`
- `run_id`
- `display_name`
- `finding_type`: `ORG_CHANGED_WITH_AWS_ACCESS`
- `severity`: `medium`, `high`
- `old_org_code`
- `old_org_name`
- `new_org_code`
- `new_org_name`
- `assignment_count`
- `message`
- `created_at`

## 처리 흐름

1. 실행 시작 시 `identity_audit_runs`에 `running` row를 만든다.
2. IAM Identity Center instance와 Identity Store ID를 조회한다.
3. 사용자, 그룹, 그룹 멤버십, Permission Set, Account Assignment를 수집한다.
4. 사용자 `DisplayName`을 기준으로 조직 API를 호출한다.
5. 조직 API는 동시성 제한을 둔다. 기본값은 10이고, 실패 요청은 최대 2회 재시도한다.
6. 현재 사용자 상태와 조직 스냅샷을 저장한다.
7. 이전 `identity_users.current_org_code`와 현재 `orgCode`를 비교한다.
8. `orgCode`가 달라진 사용자는 `identity_org_change_events`에 저장한다.
9. 변경 사용자에게 남아 있는 assignment가 있으면 `identity_audit_findings`에 저장한다.
10. 실행 통계를 갱신하고 run 상태를 `completed`로 바꾼다.

실행 중 일부 조직 API가 실패해도 전체 run은 계속 진행한다. 실패한 사용자는 비교 대상에서 제외하고 `error_count`에 반영한다.

## UI

새 메뉴는 `Identity 감사`로 둔다.

화면 구성:

- 최근 실행 상태: 시작/종료 시각, 전체 사용자, 부서 변경자, 권한 잔존자, 오류 수
- 수동 실행 버튼
- 스케줄 표시: 매주 화요일 10시 KST
- 감사 finding 목록
- 사용자별 상세: 이전 조직, 현재 조직, 남아 있는 AWS 계정/Permission Set
- CSV export

초기 버전은 인증 없는 내부망 전제를 따른다. 이후 어드민 권한이 도입되면 수동 실행과 설정 변경은 어드민 전용으로 분리한다.

## AI 활용

AI는 저장된 DB 기준으로만 답한다. 실시간으로 조직 API나 AWS API를 직접 호출하지 않는다.

지원 질문 예:

- "이번 주 부서 이동 후 권한 남은 사람 보여줘"
- "billy.j가 어떤 계정 권한을 가지고 있어?"
- "지난 실행 대비 조직 변경자는 몇 명이야?"
- "클라우드파트에서 다른 조직으로 이동했는데 권한 남은 사용자 표로 만들어줘"

AI 응답에는 데이터 기준 시각과 run id를 포함한다.

## 성능과 동시성

- Identity Center 수집은 pagination을 사용한다.
- 조직 API 호출은 `organizationApi.concurrency`로 제한한다.
- 7000명 기준으로 동시성 10, timeout 5초, retry 2회가 기본값이다.
- 대량 assignment는 DB transaction으로 batch insert한다.
- 실행 중복을 막기 위해 in-process lock을 둔다.
- 장기적으로는 별도 worker process로 분리할 수 있지만, 초기 버전은 기존 Next.js API route와 SQLite 구조를 유지한다.

## 네트워크와 보안

- AWS 호출은 설정된 Identity Center profile과 region을 사용한다.
- AWS endpoint URL은 기존 private config 체계를 따른다. 필요한 경우 `sso`, `identitystore`, `sso-admin`, `sts` endpoint URL을 명시할 수 있어야 한다.
- 조직 API는 내부망에서만 접근 가능한 URL로 본다.
- `KREW_API_KEY`는 환경변수로만 읽고 로그에 남기지 않는다.
- API 실패 로그에는 URL 전체나 API Key를 남기지 않는다.

## 테스트 전략

- DB migration 테스트: 테이블과 인덱스 생성 검증
- 조직 변경 비교 테스트: 신규, 변경 없음, orgCode 변경, API 실패
- assignment 펼치기 테스트: USER assignment와 GROUP assignment를 사용자 단위로 변환
- finding 생성 테스트: 부서 변경자 중 assignment가 있는 사용자만 생성
- config 테스트: `identityAudit.awsProfile` 우선순위 검증
- AI 컨텍스트 테스트: 저장된 finding 기반 답변 확인

## 단계별 구현

1. 설정 스키마와 DB migration 추가
2. Identity Center 수집기 추가
3. knock 조직 API client 추가
4. 감사 실행 orchestrator 추가
5. API route와 화면 추가
6. AI 컨텍스트 연결
7. 스케줄러 연결
8. 문서와 예시 config 업데이트

## 미해결 운영 결정

- 조직 API 응답에 재직 상태가 추가될 경우 퇴사자/휴직자 점검을 같은 기능에 포함할지 결정한다.
- 알림 채널은 초기 범위에서 제외한다. 추후 Slack, 메일, 사내 알림 중 운영 가능한 채널을 선택한다.
- 장기 보관 기간은 감사 정책에 맞춰 정한다. 기본 구현은 삭제하지 않고 누적한다.
