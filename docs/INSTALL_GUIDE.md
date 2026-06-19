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
- `~/.aws/credentials` profiles for AWSops and Bedrock
- Existing approved VPC endpoint URLs or private DNS

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
AWS_PROFILE=bedrock-local-profile aws bedrock-runtime list-foundation-models \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.bedrock-runtime.ap-northeast-2.vpce.amazonaws.com
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
- `endpointUrls`
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

## 6. Optional Kubernetes Access

If Kubernetes pages are used, kubeconfig must already be approved. You may update local kubeconfig for an existing cluster:

```bash
bash scripts/04-setup-eks-access.sh
```

Do not use AWSops to create EKS clusters or IAM roles.

## 7. General Verification

```bash
bash scripts/10-verify.sh
```

Private runtime unit tests:

```bash
python3 -m unittest discover -s tests/private -p 'test_*.py' -v
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
