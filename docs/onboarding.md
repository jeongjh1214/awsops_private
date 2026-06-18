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
5. `agent/private_runtime/config.py`
6. `src/lib/app-config.ts`

## Local Test Checklist

1. Configure `~/.aws/credentials` with the AWSops and Bedrock profiles.
2. Copy `docs/examples/config.vm-private.example.json` to `data/config.json`.
3. Set `activeEnvironment` to `local`.
4. Fill `endpointUrls` with approved VPCE hostnames.
5. Start Steampipe.
6. Run `npm run dev`.
7. Run `bash scripts/13-start-private-agent.sh`.
8. Open `http://127.0.0.1:3000/awsops`.

## Development Rules

- Prefer config-driven behavior over environment-specific code.
- Fail closed when config cannot confirm a restricted surface is allowed.
- Keep AWS SDK calls profile-aware and endpoint-aware.
- Do not reintroduce `infra-cdk/`.
- Do not add setup scripts that create AWS resources.
- Keep docs aligned with private VM-only deployment.
