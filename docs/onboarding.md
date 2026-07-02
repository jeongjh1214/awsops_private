# Onboarding

## What This Branch Is

This is the private VM-only branch of AWSops.

It runs the dashboard, Steampipe, and local MCP/LangGraph agent on an existing host. It does not create or manage AWS infrastructure.

## What Not To Do

Do not add scripts or code paths that create:

- CDK or CloudFormation stacks
- VPC endpoints, VPCs, subnets, route tables, security groups, load balancers, or transit attachments
- CloudFront, Lambda@Edge, Cognito, AgentCore, Lambda, ECR, or IAM resources
- Kubernetes add-ons unless explicitly approved for that environment

If a resource is needed, request it through the approved platform/security process and add only the resulting endpoint, profile, role name, or DNS name to `data/config.json`.

## First Files To Read

1. `README.md`
2. `docs/wiki/00-overview.md`
3. `docs/wiki/01-architecture.md`
4. `docs/wiki/02-configuration.md`
5. `docs/architecture.md`
6. `docs/INSTALL_GUIDE.md`
7. `docs/examples/config.vm-private.example.json`
8. `docs/runbooks/company-pc-local-test.md`
9. `docs/examples/steampipe-aws.spc.example`
10. `agent/private_runtime/config.py`
11. `src/lib/app-config.ts`

## Local Test Checklist

1. Configure `~/.aws/credentials` with the AWSops and Bedrock profiles.
2. Copy `docs/examples/config.vm-private.example.json` to `data/config.json`.
3. Set `activeEnvironment` to `local`.
4. Fill `endpointUrls` with approved VPCE hostnames.
   Include `endpointUrls.s3` when `s3_bucket` sync is enabled.
5. Review `assetInventory.supportedResourceTypes`; keep only resource types approved for collection.
6. If Identity 감사 is tested, set `identityAudit.enabled`, `identityAudit.awsProfile`, `endpointUrls.identitystore`, `endpointUrls.sso-admin`, and `KREW_API_KEY`.
7. Create the local data directory with `mkdir -p data`.
8. Start Steampipe with `bash scripts/16-start-steampipe-private.sh`.
9. Run `npm run dev`.
10. Run `bash scripts/13-start-private-agent.sh`.
11. Open `http://127.0.0.1:3000/awsops`.
12. If something is missing, run `bash scripts/14-check-local-private.sh`.

## Cloud Asset Inventory Notes

Cloud Assets stores discovered AWS resources and human-managed metadata in local SQLite at `assetInventory.sqlitePath`.

Current sync support is intentionally allowlisted by `assetInventory.supportedResourceTypes`. Keep the sample default (`ec2_instance`, `s3_bucket`) until additional resource normalizers and Steampipe queries are added.

Admin-only custom field changes require `x-awsops-asset-admin-token`. Configure `AWSOPS_ASSET_ADMIN_TOKEN_HASH` or `assetInventory.adminTokenHash` with:

```bash
node -e "const {createHash}=require('crypto'); const token=process.argv[1]; console.log('sha256:'+createHash('sha256').update(token).digest('hex'))" '<admin-token>'
```

AI answers for 자산관리 / Cloud Asset Inventory questions use the saved SQLite ledger only. They do not perform live AWS discovery, Steampipe sync, CSV import, or metadata updates.

## S3 Governance Notes

S3 관리대장은 S3 현황 화면과 목적이 다르다.

- S3 현황: live/synced AWS bucket state
- S3 관리대장: 감사용 업무 메타데이터와 변경 이력

초기에는 bucket별 governance record를 채워야 한다. 이후에는 deleted bucket과 컬럼 변경 이력이 `data/awsops.db`에 남는다.

관리 대상 컬럼은 account name, accountid, phase, bucketname, 담당조직, 용도, 이력, 개인정보 유무, 개인정보 데이터 유효기간 인지 여부, 개인정보 데이터 유효기간 적용 여부, 적용 데이터 유효기간, 비고를 기준으로 한다.

## IAM Identity Center Audit Notes

Identity 감사는 부서 이동자가 AWS 권한을 계속 보유하는지 확인한다.

- IAM Identity Center profile은 `identityAudit.awsProfile`로 별도 지정할 수 있다.
- 조직 정보는 IAM Identity Store가 아니라 knock API에서 `DisplayName` 기준으로 조회한다.
- API key는 config에 쓰지 않고 `KREW_API_KEY` 환경변수로만 주입한다.
- 기본 스케줄은 한국시간 매주 화요일 10시다.
- 스케줄러는 `/awsops/api/identity-audit`가 호출된 뒤 lazy start한다.

수동 실행:

```bash
curl -fsS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"action":"run"}' \
  http://127.0.0.1:3000/awsops/api/identity-audit | python3 -m json.tool
```

## Development Rules

- Prefer config-driven behavior over environment-specific code.
- Fail closed when config cannot confirm a restricted surface is allowed.
- Keep AWS SDK calls profile-aware and endpoint-aware.
- Do not reintroduce `infra-cdk/`.
- Do not add setup scripts that create AWS resources.
- Keep docs aligned with private VM-only deployment.
