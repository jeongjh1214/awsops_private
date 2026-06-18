# AWSops Private VM Dashboard

> Internal-only AWS operations dashboard for regulated environments. This private branch runs on existing local, development, or production VMs and does not create AWS infrastructure.

## Deployment Rule

AWSops private mode is **application/runtime only**.

It must not create or modify these AWS resources:

- CDK or CloudFormation stacks
- VPCs, subnets, route tables, security groups, VPC endpoints, NAT gateways, transit gateways, or load balancers
- CloudFront distributions or Lambda@Edge
- Cognito user pools or app clients
- Bedrock AgentCore runtimes, gateways, memory stores, or code interpreters
- Lambda functions, ECR repositories, or IAM roles/policies

The platform/security team must pre-provision network paths, VPC endpoints, VM access, IAM roles, and credentials. AWSops only reads configuration and calls AWS APIs through the configured profiles and endpoint URLs.

## Architecture

```text
Internal user/browser
  |
  | internal DNS, proxy, or direct VM URL
  v
Existing server or AWS VM
  |
  |-- Next.js dashboard :3000
  |-- Steampipe PostgreSQL :9193
  |-- Local LangGraph API :7000
  |-- Local MCP tools over stdio/http
  |
  | AWS SDK / Steampipe / Bedrock calls
  v
Existing VPC endpoints or private DNS
  |
  v
Approved AWS service APIs
```

No CloudFront, Cognito, ALB, AgentCore, or CDK deployment path is used in private mode.

## Environments

AWSops supports three private VM environments through `data/config.json`.

| Environment | Where it runs | Endpoint mode | Credential source |
| --- | --- | --- | --- |
| `local` | Developer workstation | Explicit VPCE URLs | `~/.aws/credentials` profile |
| `dev` | Existing development server | Explicit VPCE URLs | Server AWS profile |
| `prod` | Existing AWS VM | Private DNS or hybrid | VM/profile provided by platform team |

Copy the example config and edit profile names and endpoint URLs:

```bash
mkdir -p data
cp docs/examples/config.vm-private.example.json data/config.json
```

Set the active environment:

```json
{
  "activeEnvironment": "local"
}
```

For local and dev, configure explicit endpoint URLs such as:

```json
{
  "endpointMode": "explicit",
  "bedrockProfile": "bedrock-local-profile",
  "awsProfile": "awsops-local-profile",
  "endpointUrls": {
    "bedrock-runtime": "https://vpce-xxxxxxxx.bedrock-runtime.ap-northeast-2.vpce.amazonaws.com",
    "sts": "https://vpce-xxxxxxxx.sts.ap-northeast-2.vpce.amazonaws.com"
  }
}
```

For prod on an AWS VM, use `privateDns` when service private DNS is already enabled. Use `hybrid` when only selected services need explicit VPCE hostnames.

## Required Host Software

- Node.js 20+
- Python 3.11+
- AWS CLI v2
- Steampipe with the AWS plugin
- Powerpipe if CIS benchmark pages are used
- kubectl and kubeconfig only if Kubernetes pages are used
- Existing `~/.aws/credentials` profiles for AWSops and Bedrock

## Install on an Existing VM

Install base runtime software:

```bash
bash scripts/01-install-base.sh
```

Install Node dependencies and prepare the dashboard:

```bash
bash scripts/02-setup-nextjs.sh
```

Build and start the dashboard:

```bash
bash scripts/03-build-deploy.sh
```

Start the local private AI agent:

```bash
bash scripts/13-start-private-agent.sh
```

Verify the private agent:

```bash
bash scripts/13-verify-private-agent.sh
```

Run the general dashboard verification:

```bash
bash scripts/10-verify.sh
```

## Local Test Flow

1. Configure AWS credentials:

```bash
aws sts get-caller-identity --profile awsops-local-profile --endpoint-url https://vpce-xxxxxxxx.sts.ap-northeast-2.vpce.amazonaws.com
```

2. Configure `data/config.json` with `activeEnvironment: "local"`.

3. Start Steampipe with a connection that uses the same profile.

4. Start the dashboard and local agent:

```bash
npm run dev
bash scripts/13-start-private-agent.sh
```

5. Open the internal URL:

```text
http://127.0.0.1:3000/awsops
```

## Private AI Path

The private branch uses local MCP + LangGraph instead of Bedrock AgentCore.

- `/awsops/api/ai` routes streaming and non-streaming local-provider requests to the local LangGraph API.
- `/awsops/agentcore` and `/awsops/cloudfront-cdn` are disabled when `agent.provider` is `local-mcp-langgraph`.
- CloudFront collection is skipped in dashboard and cache warmer when private local mode is active.
- Bedrock calls use the configured `bedrockProfile` from `data/config.json`.

## Repository Layout

```text
src/                         Next.js app and API routes
agent/private_runtime/        Private config, endpoint, client, audit, and limit helpers
agent/langgraph_api.py        Local private LangGraph-compatible API
agent/mcp_server.py           Local MCP tool server scaffold
scripts/01-*.sh               Host runtime installation
scripts/02-*.sh               Next.js setup
scripts/03-*.sh               Build and deployment on existing VM
scripts/13-*.sh               Local private agent start/verify
docs/examples/                Private config examples
tests/private/                Private runtime unit tests
```

There is intentionally no `infra-cdk/` directory in this branch.

## Verification

```bash
python3 -m unittest discover -s tests/private -p 'test_*.py' -v
bash -n scripts/*.sh
python3 -m json.tool docs/examples/config.vm-private.example.json >/dev/null
npm run build
```

Existing unrelated duplicate untracked files ending with ` 2` are not part of this branch.
