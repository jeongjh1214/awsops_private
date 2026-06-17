# ADR-003: SCP 차단 컬럼 처리 / SCP-Blocked Column Handling

## 상태: 승인됨 / Status: Accepted

## 컨텍스트 / Context
AWS Organizations에서 서비스 제어 정책(SCP)이 특정 API 호출(iam:ListMFADevices, lambda:GetFunction)을 차단합니다. Steampipe가 이러한 컬럼을 하이드레이트하려 하면 전체 쿼리가 실패합니다.
(In AWS Organizations, Service Control Policies block certain API calls (iam:ListMFADevices, lambda:GetFunction). When Steampipe tries to hydrate these columns, the entire query fails.)

## 결정 / Decision
1. `aws.spc`에서 테이블 수준 오류를 위한 `ignore_error_codes` 설정
   (Set `ignore_error_codes` in `aws.spc` for table-level errors)
2. 리스트 쿼리에서 SCP 차단 컬럼 제거 — mfa_enabled, tags, attached_policy_arns
   (Remove SCP-blocked columns from list queries — mfa_enabled, tags, attached_policy_arns)
3. 상세 쿼리에서는 차단 컬럼 유지 — 단일 리소스, 실패 가능성 낮음
   (Keep blocked columns in detail queries — single-resource, less likely to fail)

## 차단된 API 목록 / Blocked APIs Found
| 컬럼 (Column) | API | 테이블 (Table) |
|--------|-----|-------|
| mfa_enabled | iam:ListMFADevices | aws_iam_user |
| attached_policy_arns | iam:ListAttachedUserPolicies | aws_iam_user |
| tags (리스트에서 / in list) | lambda:GetFunction | aws_lambda_function |

## 결과 / Consequences
- `aws.spc`의 `ignore_error_codes`가 테이블 수준 오류를 처리
  (`ignore_error_codes` in `aws.spc` handles table-level errors)
- 컬럼 하이드레이트 오류 발생 시 SQL에서 해당 컬럼을 제거해야 함
  (Column hydrate errors require removing the column from SQL)
- 일부 대시보드 카드에서 MFA 관련 지표가 0으로 표시됨
  (Some dashboard cards show 0 for MFA-related metrics)
