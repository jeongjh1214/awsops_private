# AWSops Private VM Install Guide

## Principle

Install AWSops only on an existing host. Do not create AWS infrastructure from this repository.

The host can be:

- a developer workstation for `local`
- an existing internal development server for `dev`
- an existing AWS VM for `prod`

Network access, VPC endpoints, IAM roles, credentials, DNS, and VM provisioning must already exist.

## Prerequisites

- Node.js 20+
- Python 3.11+
- AWS CLI v2
- Steampipe and the AWS plugin
- Powerpipe if CIS benchmark pages are used
- kubectl if Kubernetes pages are used
- `~/.aws/credentials` profiles for AWSops, Bedrock, and IAM Identity Center when Identity 감사 is enabled
- Existing approved VPC endpoint URLs or private DNS
- `KREW_API_KEY` environment variable when Identity 감사 is enabled

For company workstation testing, also read `docs/runbooks/company-pc-local-test.md`.

## 1. Configure AWS Profiles

Example local profile checks:

```bash
aws sts get-caller-identity \
  --profile awsops-local-profile \
  --endpoint-url https://vpce-xxxxxxxx.sts.ap-northeast-2.vpce.amazonaws.com
```

Bedrock uses its own profile when required:

```bash
AWS_PROFILE=bedrock-local-profile aws bedrock-runtime invoke-model \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.bedrock-runtime.ap-northeast-2.vpce.amazonaws.com \
  --model-id '<model-id-or-inference-profile-arn>' \
  --content-type application/json \
  --accept application/json \
  --cli-binary-format raw-in-base64-out \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":8,"messages":[{"role":"user","content":"ping"}]}' \
  /tmp/awsops-bedrock-response.json
```

The endpoint URL above must be a Bedrock Runtime VPCE URL. The hostname should contain `bedrock-runtime`.

If Identity 감사 is enabled, verify the dedicated IAM Identity Center profile and endpoint path:

```bash
aws sso-admin list-instances \
  --profile identity-audit-profile \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.sso.ap-northeast-2.vpce.amazonaws.com
```

## 2. Configure AWSops

```bash
mkdir -p data
cp docs/examples/config.vm-private.example.json data/config.json
```

Edit:

- `activeEnvironment`
- `bedrockProfile`
- `awsProfile`
- `identityCenterProfile`
- `endpointUrls`
- `assetInventory`
- `identityAudit`
- `accounts`

Use `activeEnvironment: "local"` for workstation testing.

`npm run dev` is the Next.js development server command. It does not select the AWSops `dev` environment. Environment selection comes only from `data/config.json`.

## 3. Install Host Runtime

```bash
bash scripts/01-install-base.sh
bash scripts/02-setup-nextjs.sh
```

These scripts install application runtime dependencies on the host. They do not create AWS resources.

## 4. Build and Start Dashboard

```bash
bash scripts/03-build-deploy.sh
```

For local development:

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:3000/awsops
```

## 5. Start Local Private AI Agent

```bash
bash scripts/13-start-private-agent.sh
```

Verify:

```bash
bash scripts/13-verify-private-agent.sh
```

## 6. Optional Identity 감사

Enable `identityAudit.enabled` in `data/config.json`, set the Identity Center profile, and export the organization API key:

```bash
export KREW_API_KEY='...'
```

Required endpoint URLs for explicit local/dev mode:

- `endpointUrls.identitystore`
- `endpointUrls.sso-admin`
- `endpointUrls.sts`

Run the audit manually:

```bash
curl -fsS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"action":"run"}' \
  http://127.0.0.1:3000/awsops/api/identity-audit | python3 -m json.tool
```

Check findings:

```bash
sqlite3 data/awsops.db \
  "select display_name, old_org_name, new_org_name, assignment_count, severity from identity_audit_findings order by created_at desc limit 20;"
```

The weekly scheduler runs only after the API route has been touched by the running app. It does not run during `npm run build`.

## 7. Optional Kubernetes Access

If Kubernetes pages are used, kubeconfig must already be approved. You may update local kubeconfig for an existing cluster:

```bash
bash scripts/04-setup-eks-access.sh
```

Do not use AWSops to create EKS clusters or IAM roles.

## 8. General Verification

```bash
bash scripts/10-verify.sh
```

Private runtime unit tests:

```bash
python3 -m unittest discover -s tests/private -p 'test_*.py' -v
node tests/assets/test_identity_audit_config.mjs
node tests/assets/test_identity_audit_db.mjs
node tests/assets/test_identity_audit_runner.mjs
```

Company workstation diagnostics:

```bash
bash scripts/14-check-local-private.sh
```

If the company network blocks Steampipe plugin registry access on a matching macOS arm64 workstation, install the vendored AWS CLI plugin package:

```bash
bash scripts/15-install-vendored-steampipe-aws-plugin.sh
```

## Removed Deployment Paths

This branch intentionally excludes:

- `infra-cdk/`
- CDK deploy/update scripts
- Cognito setup scripts
- CloudFront/Lambda@Edge setup scripts
- AgentCore runtime/gateway/memory/code-interpreter setup scripts
- ECR/Lambda/IAM creation scripts

If a future environment needs any of those resources, create them outside AWSops through the approved internal process and add only the resulting profile or endpoint metadata to `data/config.json`.
