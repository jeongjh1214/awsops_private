# Architecture

## Scope

This private branch is designed for regulated internal networks. It deploys only application software to an existing host. Infrastructure, network, identity, and endpoint resources are managed outside this repository.

AWSops must not provision AWS resources. In particular, this branch has no CDK project and no scripts for CloudFront, Cognito, AgentCore, Lambda, ECR, VPC endpoint, ALB, or IAM role creation.

## Runtime Topology

```text
Internal user/browser
  |
  | existing internal DNS, proxy, bastion, or direct VM access
  v
Existing local/dev/prod host
  |
  |-- Next.js app :3000
  |-- Steampipe PostgreSQL :9193
  |-- Local LangGraph API :7000
  |-- Local MCP tool process
  |
  | AWS SDK, Steampipe, and Bedrock calls
  v
Existing VPC endpoints or private DNS
  |
  v
Approved AWS APIs
```

## Components

### Frontend

- Next.js 14 App Router under `basePath: "/awsops"`
- Dashboard pages for AWS resource inventory, cost, security, compliance, topology, and observability
- AgentCore and CloudFront screens are disabled in private local-agent mode

### Data Collection

- Steampipe provides SQL access to AWS and Kubernetes inventory.
- Queries are read-only and run from the existing host.
- Dashboard collection follows the host's Steampipe connection configuration and configured AWS profiles.
- Services without an approved endpoint path must be disabled or excluded from collection.

### Private AI Runtime

- The AI path uses a local MCP + LangGraph runtime.
- `agent/langgraph_api.py` exposes the local chat API.
- `agent/mcp_server.py` provides private MCP tool scaffolding.
- `agent/private_runtime/` loads environment config, endpoint URLs, runtime limits, boto3 clients, and audit logging.
- Bedrock calls use `bedrockProfile` from `data/config.json`.

### Configuration

`data/config.json` owns environment selection:

- `activeEnvironment`: one of `local`, `dev`, or `prod`
- `environments.<name>.endpointMode`: `explicit`, `privateDns`, or `hybrid`
- `environments.<name>.bedrockProfile`: AWS credentials profile for Bedrock
- `environments.<name>.awsProfile`: AWS credentials profile for other AWS API calls
- `environments.<name>.endpointUrls`: explicit VPCE service URLs when required
- `agent.provider`: `local-mcp-langgraph` for private mode

See `docs/examples/config.vm-private.example.json`.

## Environment Modes

| Mode | Intended use | Behavior |
| --- | --- | --- |
| `local` | Developer workstation | Uses explicit VPCE URLs and local `~/.aws/credentials` profiles |
| `dev` | Existing development server | Uses explicit VPCE URLs and server-local AWS profiles |
| `prod` | Existing AWS VM | Uses private DNS or hybrid endpoint overrides, depending on the existing network |

## Prohibited Deployment Actions

The repository must not include active deployment paths for:

- CDK or CloudFormation stack deployment
- Creating VPC endpoints, VPCs, subnets, route tables, security groups, load balancers, or transit attachments
- Creating CloudFront, Lambda@Edge, Cognito, AgentCore, Lambda, ECR, or IAM resources
- Writing permanent AWS access keys as part of deployment

If the application needs one of these resources, the platform/security team must create it through the approved internal process and provide the resulting profile, endpoint, role, or DNS information to AWSops configuration.

## Data Flow

1. User opens `/awsops` on the internal host URL.
2. Browser calls Next.js API routes.
3. Dashboard routes query Steampipe or local data files.
4. AI routes call the local LangGraph API.
5. The private runtime resolves AWS clients from `data/config.json`.
6. AWS calls use configured profiles and endpoint URLs or existing private DNS.

## Verification

Run from the repository root:

```bash
python3 -m unittest discover -s tests/private -p 'test_*.py' -v
bash -n scripts/*.sh
python3 -m json.tool docs/examples/config.vm-private.example.json >/dev/null
npm run build
```
