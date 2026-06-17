# AWSops Private LangGraph MCP Design

## Status

Draft approved for implementation planning.

## Context

AWSops must be internalized for a financial-sector environment. The target deployment is not internet-facing. Users access the service through Direct Connect into the customer network, and the application must be served only on the internal network.

The upstream project currently uses:

- CloudFront, public ALB, Lambda@Edge, and Cognito Hosted UI for access control.
- EC2-hosted Next.js and Steampipe for dashboard data.
- Amazon Bedrock AgentCore Runtime, Gateways, Code Interpreter, and Lambda targets for AI tools.
- AWS service collection through normal AWS SDK, AWS CLI, boto3, and Steampipe endpoint resolution.

This does not match the target constraints:

- CloudFront cannot be used.
- Cognito authentication must be removed for the first internal release.
- AgentCore public network mode is not acceptable.
- Existing VPC endpoints must be used; AWSops must not create new VPC endpoints.
- Bedrock must be called through a specific AWS CLI profile configured in credentials.
- Development runs outside AWS and must call explicit VPCE URLs. Production runs inside AWS and can use Private DNS where available.

## Goals

- Serve AWSops through Direct Connect and internal load balancing only.
- Remove CloudFront, Cognito, Lambda@Edge, and browser authentication for the first release.
- Replace AgentCore with a self-hosted LangGraph plus local MCP architecture.
- Keep Bedrock usage, but force it through a configured AWS profile and VPCE-aware endpoint resolution.
- Make VPCE usage config-driven. Do not create VPCE resources from CDK or scripts.
- Preserve existing Steampipe dashboards and reuse Python tool logic where practical.
- Add explicit concurrency limits, timeouts, caching, and audit logging for predictable performance.

## Non-Goals

- Do not implement end-user authentication in the first release.
- Do not create, update, or delete VPC endpoints.
- Do not keep AgentCore Runtime, Gateway, or Code Interpreter in the first private release.
- Do not support public internet access.
- Do not solve package installation mirroring in the first pass, except to document it as an operational follow-up.
- Do not depend on GitHub Actions. The eventual internal repository may not support GitHub Actions or outbound GitHub automation.

## Recommended Architecture

```text
Internal users over Direct Connect
  -> Corporate DNS or Route 53 Private Hosted Zone
  -> Internal ALB
  -> EC2 in private subnet

EC2 services:
  Next.js Dashboard :3000
    -> /awsops/api/ai
    -> Python LangGraph API :7000
        -> local MCP client
        -> Python awsops-mcp-server :7100
            -> Steampipe PostgreSQL :9193
            -> boto3 AWS tools
            -> Bedrock Runtime with configured AWS profile
```

The local MCP server replaces AgentCore Gateway. LangGraph owns conversation state, route selection, tool orchestration, retries, streaming, and synthesis. MCP owns the tool boundary, endpoint resolution, concurrency controls, timeouts, and audit records.

## Infrastructure Changes

### Remove Public Entry Path

Remove or disable:

- CloudFront distribution.
- CloudFront custom header origin path.
- Lambda@Edge authentication function.
- Cognito User Pool, app client, Hosted UI, and setup scripts.
- CloudFront auth setup scripts.

### Internal ALB

Change the ALB to internal:

- `internetFacing: false`.
- Allow inbound only from approved Direct Connect or internal CIDR ranges.
- Keep EC2 in private subnets.
- Route dashboard traffic to EC2 port `3000`.
- Optionally keep code-server disabled or restricted separately. It should not be exposed through the same general path unless explicitly approved.

### VPC Endpoints

AWSops must not create VPCE resources. CDK should expose configuration fields for known endpoint usage and validation, but should not instantiate `InterfaceVpcEndpoint` or `GatewayVpcEndpoint` constructs for collection services.

Existing SSM endpoints in the upstream stack should become optional and disabled by default for this private deployment. If SSM is already available in the customer environment, AWSops should use it without creating it.

## Config Model

Add environment-aware config to `data/config.json`.

```json
{
  "activeEnvironment": "dev",
  "environments": {
    "dev": {
      "networkMode": "external-explicit-vpce",
      "endpointMode": "explicit",
      "bedrockProfile": "bedrock-dev-profile",
      "endpointUrls": {
        "bedrock-runtime": "https://vpce-xxx.vpce.amazonaws.com",
        "sts": "https://vpce-yyy.vpce.amazonaws.com",
        "ec2": "https://vpce-zzz.vpce.amazonaws.com"
      }
    },
    "prod": {
      "networkMode": "vpc-private-dns",
      "endpointMode": "privateDns",
      "bedrockProfile": "bedrock-prod-profile",
      "endpointUrls": {}
    }
  },
  "agent": {
    "provider": "local-mcp-langgraph",
    "modelId": "anthropic.claude-sonnet-4-6",
    "maxConcurrentBedrockCalls": 3,
    "maxConcurrentAwsCalls": 8,
    "maxConcurrentSteampipeQueries": 5,
    "toolTimeoutMs": 30000,
    "queryCacheTtlSec": 300,
    "maxToolResultBytes": 200000
  }
}
```

Endpoint modes:

- `explicit`: use `endpointUrls` for each service. This is the development default because the development environment is outside AWS and reaches VPCE DNS names directly.
- `privateDns`: do not set service endpoint URLs. Let AWS private DNS resolve standard AWS service hostnames to VPCE addresses. This is the production default.
- `hybrid`: use Private DNS by default, but override selected services from `endpointUrls`.

The app must fail startup health checks if a required endpoint for the active environment is missing.

## Bedrock Credentials

Bedrock must use the configured profile from credentials.

Python services should create Bedrock clients like:

```python
session = boto3.Session(
    profile_name=active_environment.bedrock_profile,
    region_name=region,
)

client = session.client(
    "bedrock-runtime",
    endpoint_url=endpoint_resolver.url_for("bedrock-runtime"),
)
```

The Bedrock client should be cached per `(profile, region, endpoint_url)` and reused. Do not create a new boto3 session and client for every token stream or tool call.

Non-Bedrock AWS calls can use either:

- the EC2 instance role in production, or
- configured profiles for development and target-account operations.

This should remain explicit in config rather than inferred from ambient shell state.

## Local MCP Server

Create a Python MCP server that exposes AWSops tools. Initial tool groups:

- `steampipe.run_query`
- `network.*`
- `monitoring.*`
- `cost.*`
- `security.*`
- `data.*`
- `container.*`
- `iac.*`

The first implementation should prioritize parity for the current AgentCore routes used by `/api/ai`, not every upstream Lambda helper.

Existing files under `agent/lambda/*.py` should be refactored into importable modules:

- Move pure AWS logic into `agent/tools/`.
- Keep Lambda handler wrappers only if needed for backwards compatibility.
- Convert each approved operation into an MCP tool with typed input.

Tool registration must use an allowlist. Avoid exposing arbitrary AWS CLI execution or arbitrary SQL beyond controlled Steampipe SELECT-only execution.

## LangGraph API

Create a Python LangGraph API service that:

- Accepts chat requests from Next.js.
- Streams responses with SSE or a compatible chunk protocol.
- Classifies requests into tool routes.
- Calls MCP tools through a local MCP client.
- Synthesizes tool outputs with Bedrock.
- Enforces per-request budgets and cancellation.

The LangGraph service should replace current AgentCore calls in `src/app/api/ai/route.ts`.

The Next.js API should become a thin adapter:

- validate request body,
- add selected account and UI context,
- call LangGraph API,
- proxy streaming output back to the browser,
- record usage stats.

## Concurrency And Performance

Concurrency must be enforced in the MCP server, not only in the UI.

Initial default limits:

- Steampipe queries: 5 concurrent.
- Bedrock calls: 3 concurrent.
- General AWS API calls: 8 concurrent.
- Cost Explorer, CloudWatch Logs Insights, and long-running tools: 2 concurrent each.

Each tool must have:

- timeout,
- retry policy for throttling,
- exponential backoff with jitter,
- output size cap,
- audit log entry,
- structured error response.

Caching:

- Cache deterministic Steampipe query results for `queryCacheTtlSec`.
- Cache static account, region, and endpoint validation results.
- Do not cache user-specific or credential-sensitive data unless the cache key includes account and profile context.

Large-result handling:

- Return row counts and samples to the LLM.
- Store full result payload temporarily if the UI needs drill-down.
- Avoid feeding huge raw JSON into Bedrock.

## VPCE Health Checks

At startup and on demand, run health checks for the active environment:

- `sts:GetCallerIdentity` through configured STS endpoint.
- Bedrock minimal model access check through configured Bedrock Runtime endpoint and profile.
- Steampipe connectivity check.
- Required AWS service endpoint reachability checks for enabled tool groups.

Health check results should be visible on an internal status page or existing AgentCore page replacement.

TLS verification must remain enabled by default. If a specific endpoint URL causes hostname mismatch, that endpoint should be fixed through DNS or config rather than disabling TLS globally.

## Security

The first release has no user authentication by request. Security boundary is:

- Direct Connect routing,
- internal DNS,
- internal ALB,
- security groups,
- VPCE policies,
- IAM roles and profile permissions.

Even without user auth, the app should:

- avoid write-capable tools by default,
- enforce SELECT-only SQL for Steampipe,
- log tool calls with timestamp, route, service, account, duration, and result status,
- avoid logging secrets,
- keep Bedrock profile names in config but never expose access keys in UI,
- require explicit config to enable any tool that can mutate AWS resources.

## Migration Plan

1. Add config schema for environments, endpoints, Bedrock profile, and agent runtime settings.
2. Remove CloudFront, Cognito, and Lambda@Edge deployment path from CDK/scripts.
3. Convert ALB to internal and CIDR-restricted.
4. Add Python MCP server scaffold with Steampipe and Bedrock health tools.
5. Add endpoint resolver and boto3 client factory.
6. Add LangGraph API service with route classification and Bedrock streaming.
7. Replace Next.js AgentCore calls with LangGraph API adapter.
8. Port current AgentCore Lambda tools into MCP tool modules incrementally.
9. Add status page replacement for local agent, MCP, endpoints, and concurrency metrics.
10. Validate dev explicit VPCE mode and prod private DNS mode separately.
11. Remove or archive GitHub Actions workflows from the private/internal distribution path.

## Operational Follow-Ups

The current install scripts fetch packages from public locations:

- npm registry,
- pip,
- GitHub,
- Steampipe and Powerpipe installers,
- Helm charts,
- AWS CLI download,
- kubectl download.

For a strict financial-sector environment, these should be replaced by internal artifact mirrors, internal ECR images, or pre-baked AMIs. This is a separate packaging hardening track and should not block the first architecture conversion design.

The upstream repository includes GitHub Actions workflow files under `.github/workflows/`. The internalized repository must not rely on these workflows because the future corporate Git hosting environment may not support GitHub Actions. Verification and deployment should be expressed as portable scripts first, then optionally wired into the customer's approved CI system such as Jenkins, GitLab CI, Bamboo, Argo Workflows, or a manual change pipeline.

Private repository handling should therefore follow these rules:

- Treat `.github/workflows` as upstream-only metadata.
- Do not make GitHub Actions required for build, test, deploy, or documentation generation.
- Keep all required checks runnable from scripts such as `tests/run-all.sh`, `npm run build`, CDK synth commands, and Python test commands.
- Document the internal CI adapter separately once the target corporate repository platform is known.

## Open Decisions

- Which exact tool groups are required in the first private release.
- Whether code-server remains installed and, if so, how it is restricted.
- Which AWS services have existing VPCEs in development and production.
- Whether non-Bedrock AWS API calls use instance role, service profiles, or account-specific profiles in development.
- Whether the status page should replace `/agentcore` or become a new `/agent` page.
- Which internal CI/CD platform will replace GitHub Actions, if any.

## Acceptance Criteria

- No CloudFront, Cognito, Lambda@Edge, or AgentCore resources are required to run the private release.
- The dashboard is reachable through Internal ALB only.
- Bedrock calls use the configured AWS profile.
- Development can force explicit VPCE endpoint URLs from config.
- Production can use Private DNS endpoint resolution from config.
- MCP server enforces concurrency, timeout, output cap, and audit logging.
- LangGraph streams AI responses and can call local MCP tools.
- Existing Steampipe dashboard pages continue to work.
- Build, test, and deployment procedures are runnable without GitHub Actions.
