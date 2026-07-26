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
- Cloud Asset Inventory persists selected resources to SQLite so the dashboard can answer historical and metadata questions without relying only on live Steampipe query output.
- S3 bucket sync, the S3 dashboard, and AI Assistant live S3 questions use the same Steampipe `aws_s3_bucket` table and account-scoped search path.
- `scripts/16-start-steampipe-private.sh` injects the configured S3 VPCE endpoint and region into the Steampipe service process.

### Private AI Runtime

- The AI path uses a local MCP + LangGraph runtime.
- `agent/langgraph_api.py` exposes the local chat API.
- `agent/mcp_server.py` provides private MCP tool scaffolding.
- `agent/private_runtime/` loads environment config, endpoint URLs, runtime limits, boto3 clients, and audit logging.
- Bedrock calls use `bedrockProfile` from `data/config.json`.
- Both the Next.js AI route and local LangGraph API reject request bodies over 512 KB, more than 50 messages, messages over 50,000 characters, or combined message content over 200,000 characters.

### Cloud Asset Inventory

- Stored in `data/awsops.db` through `assetInventory.sqlitePath`.
- Current built-in sync support is allowlisted with `assetInventory.supportedResourceTypes`.
- The sample default supports `ec2_instance` and `s3_bucket`.
- Custom fields are managed by admin-token protected APIs.
- AI answers for Cloud Asset Inventory use the saved ledger instead of triggering live discovery.
- An empty account-scoped Steampipe result marks existing assets missing only after `aws_caller_identity` confirms that the same account data path is healthy. An unscoped empty result is not treated as proof that every saved asset was deleted.

### S3 Governance

S3 관리대장은 Cloud Asset Inventory의 `s3_bucket` record와 별도 governance record를 연결한다.

It is intended for audit-friendly fields such as account name, account ID, phase, bucket name, 담당조직, 용도, 이력, 개인정보 여부, 개인정보 데이터 유효기간 인지/적용 여부, 적용 데이터 유효기간, and 비고.

Deleted buckets remain in the ledger as historical records. Governance metadata changes are kept as history so audit reviewers can see what changed and when.

### IAM Identity Center Org Audit

Identity 감사 detects users whose organization changed but who still have AWS account assignments.

Data sources:

- IAM Identity Center / Identity Store through AWS SDK read-only calls
- Knock organization API keyed by IAM Identity Center `DisplayName`
- Existing SQLite database for snapshots, findings, and run history

The audit uses `identityAudit.awsProfile` first. If it is not set, it falls back to `environments.<active>.identityCenterProfile`, then `environments.<active>.awsProfile`.

The weekly scheduler starts lazily when `/awsops/api/identity-audit` is called. Module import and `npm run build` must not make AWS or organization API calls.

### Configuration

`data/config.json` owns environment selection:

- `activeEnvironment`: one of `local`, `dev`, or `prod`
- `environments.<name>.endpointMode`: `explicit`, `privateDns`, or `hybrid`
- `environments.<name>.bedrockProfile`: AWS credentials profile for Bedrock
- `environments.<name>.awsProfile`: AWS credentials profile for other AWS API calls
- `environments.<name>.identityCenterProfile`: AWS credentials profile for IAM Identity Center calls
- `environments.<name>.endpointUrls`: explicit VPCE service URLs when required
- `agent.provider`: `local-mcp-langgraph` for private mode
- `identityAudit`: scheduler, Identity Center profile override, and organization API settings
- `assetInventory`: SQLite path, supported resource types, and admin token hash

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

### Persistence Model

`data/awsops.db` is the local persistence layer for governance and audit data.

| Table group | Purpose |
| --- | --- |
| Asset records/custom fields/history | Cloud Asset Inventory and admin-defined metadata |
| S3 governance records/history | S3 관리대장 and deleted bucket history |
| Identity audit runs/users/snapshots/assignments/findings | IAM Identity Center organization-change audit |

Steampipe remains the live query layer. SQLite is the audit/governance ledger.

## Verification

Run from the repository root:

```bash
python3 -m unittest discover -s tests/private -p 'test_*.py' -v
node tests/assets/test_identity_audit_config.mjs
node tests/assets/test_identity_audit_db.mjs
node tests/assets/test_identity_audit_runner.mjs
bash -n scripts/*.sh
python3 -m json.tool docs/examples/config.vm-private.example.json >/dev/null
npm run build
```
