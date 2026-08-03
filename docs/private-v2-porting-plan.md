# Private v2 Porting Plan

## Current Branch

- Branch: `codex/private-v2-port`
- Base: `upstream/v2`
- Purpose: bring the regulated/private-VM features from `codex/private-langgraph-mcp-phase1` onto the v2 application structure without merging unrelated histories.

## Why Not Merge

The private branch and upstream v2 have unrelated git roots. A trial merge reports add/add conflicts in core files such as `README.md`, `agent/agent.py`, `agent/lambda/*`, `web/package.json`, and repo hooks. The safer path is a v2-based branch with selected feature ports.

## Existing Private Features To Preserve

| Feature | v1/private source | v2 target | Porting note |
| --- | --- | --- | --- |
| Cloud Asset metadata | `src/lib/assets/*`, `src/app/assets` | `web/lib/private-governance/*`, `web/app/assets` or inventory detail extensions | Use v2 `inventory_resources` as the discovered-resource source; store only human-managed metadata and audit events separately. |
| S3 governance register | `src/lib/assets/s3-governance.ts`, `src/app/s3-governance` | `web/lib/private-governance/s3-governance.ts`, `web/app/api/private-governance/s3/*`, `web/app/s3-governance` | Repository and API are ported with `aurora` and `sqlite` providers. UI remains. Keep deleted bucket evidence independent from live inventory rows. |
| Identity Center org audit | `src/lib/identity-audit/*`, `src/app/identity-audit` | `web/lib/private-governance/identity-audit/*`, `web/app/identity-audit` | Convert SQLite repository calls to Aurora `pg` queries. |
| Local private AI | `agent/langgraph_api.py`, `agent/mcp_server.py`, `agent/private_runtime/*` | `agent/*`, `web/lib/local-private-agent.ts`, `web/lib/private-runtime-config.ts` | Compatibility mode is ported. `agent.provider=local-mcp-langgraph` sends v2 chat traffic to the local LangGraph API instead of AgentCore. |
| Live Steampipe | `src/lib/steampipe.ts`, `scripts/16-start-steampipe-private.sh` | `scripts/16-start-steampipe-private.sh`, local private agent MCP tool | Restored for local/private operation. This is not Terraform-managed infrastructure; it expects the operator-created internal network, profiles, and endpoints. |
| AI data integrity controls | not implemented yet | New `ai_dataset_*` tables + UI/API | Needed for financial-sector evaluation: dataset versioning, manifests, checksum verification, anomaly/integrity events. |

## First Porting Slice

1. Add Aurora tables for private governance and AI data integrity controls. Done in `01KZ0000000000000000000000_private_governance.sql`.
2. Add repository helpers with tests for S3 governance and dataset manifests. S3 governance is done for Aurora plus local SQLite; dataset manifests remain.
3. Add API routes. S3 list/detail/update/export/seed routes are done under `/api/private-governance/s3`.
4. Add compact v2 UI pages and navigation entries.
5. Decide whether private mode uses v2 AgentCore, local LangGraph, or both behind a feature flag.

## Local/Internal Deployment Assumption

For the private branch, infrastructure can be created manually in the AWS console. Local testing does not require ALB or CloudFront. The expected private path is:

```text
web dev server -> local private LangGraph API -> Bedrock Runtime VPCE / local Steampipe
```

Use `data/config.json` with `agent.provider = "local-mcp-langgraph"` and `activeEnvironment = "local"` to select this mode.

Local private governance data uses SQLite by default:

```json
{
  "assetInventory": {
    "dbProvider": "sqlite",
    "sqlitePath": "data/awsops.db"
  }
}
```

Operating environments should select Aurora explicitly, either with `AWSOPS_PRIVATE_DB_PROVIDER=aurora` or an operating config that sets `assetInventory.dbProvider = "aurora"`.

## Data Model Decision

For operating environments, do not copy the old SQLite `asset_records` table into v2 Aurora. v2 already persists discovered resources in `inventory_resources`. Private governance tables should reference the resource identity shape:

```text
account_id + region + resource_type + resource_id
```

but should not require a hard foreign key to `inventory_resources`, because audit evidence should remain after a resource disappears from AWS.

For local company-PC tests, the SQLite provider keeps the v1-compatible `asset_records` table so existing local sync scripts and Steampipe flows can work without Aurora.
