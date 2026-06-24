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
2. `docs/architecture.md`
3. `docs/INSTALL_GUIDE.md`
4. `docs/examples/config.vm-private.example.json`
5. `docs/runbooks/company-pc-local-test.md`
6. `docs/examples/steampipe-aws.spc.example`
7. `agent/private_runtime/config.py`
8. `src/lib/app-config.ts`

## Local Test Checklist

1. Configure `~/.aws/credentials` with the AWSops and Bedrock profiles.
2. Copy `docs/examples/config.vm-private.example.json` to `data/config.json`.
3. Set `activeEnvironment` to `local`.
4. Fill `endpointUrls` with approved VPCE hostnames.
   Include `endpointUrls.s3` when `s3_bucket` sync is enabled.
5. Review `assetInventory.supportedResourceTypes`; keep only resource types approved for collection.
6. Create the local data directory with `mkdir -p data`.
7. Start Steampipe with `bash scripts/16-start-steampipe-private.sh`.
8. Run `npm run dev`.
9. Run `bash scripts/13-start-private-agent.sh`.
10. Open `http://127.0.0.1:3000/awsops`.
11. If something is missing, run `bash scripts/14-check-local-private.sh`.

## Cloud Asset Inventory Notes

Cloud Assets stores discovered AWS resources and human-managed metadata in local SQLite at `assetInventory.sqlitePath`.

Current sync support is intentionally allowlisted by `assetInventory.supportedResourceTypes`. Keep the sample default (`ec2_instance`, `s3_bucket`) until additional resource normalizers and Steampipe queries are added.

Admin-only custom field changes require `x-awsops-asset-admin-token`. Configure `AWSOPS_ASSET_ADMIN_TOKEN_HASH` or `assetInventory.adminTokenHash` with:

```bash
node -e "const {createHash}=require('crypto'); const token=process.argv[1]; console.log('sha256:'+createHash('sha256').update(token).digest('hex'))" '<admin-token>'
```

AI answers for 자산관리 / Cloud Asset Inventory questions use the saved SQLite ledger only. They do not perform live AWS discovery, Steampipe sync, CSV import, or metadata updates.

## Development Rules

- Prefer config-driven behavior over environment-specific code.
- Fail closed when config cannot confirm a restricted surface is allowed.
- Keep AWS SDK calls profile-aware and endpoint-aware.
- Do not reintroduce `infra-cdk/`.
- Do not add setup scripts that create AWS resources.
- Keep docs aligned with private VM-only deployment.
