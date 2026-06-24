# Troubleshooting

## Config Fails To Load

Check JSON syntax:

```bash
python3 -m json.tool data/config.json >/dev/null
```

Check active environment:

```bash
python3 - <<'PY'
import json
cfg=json.load(open('data/config.json'))
print(cfg.get('activeEnvironment'))
print(cfg.get('environments', {}).keys())
PY
```

If config cannot be read, restricted surfaces such as AgentCore and CloudFront should fail closed.

## VPCE Endpoint URL Fails

For local and dev, test the exact endpoint URL:

```bash
aws sts get-caller-identity \
  --profile awsops-local-profile \
  --endpoint-url https://vpce-xxxxxxxx.sts.ap-northeast-2.vpce.amazonaws.com
```

For Bedrock:

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

If TLS hostname verification fails, use the VPCE DNS hostname in `endpointUrls`. Do not replace the hostname with an arbitrary private IP.

For S3:

```bash
AWS_PROFILE=awsops-local-profile aws s3api list-buckets \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.s3.ap-northeast-2.vpce.amazonaws.com
```

When `s3_bucket` sync is enabled, set `environments.<active>.endpointUrls.s3` and start Steampipe with:

```bash
bash scripts/16-start-steampipe-private.sh
```

The script exports `AWS_ENDPOINT_URL_S3` for the Steampipe service process. Keep `s3_force_path_style = true` in `~/.steampipe/config/aws.spc`.
It also exports `AWS_REGION` and `AWS_DEFAULT_REGION` from the matching account in `data/config.json`; this prevents S3 signing errors such as `the region 'us-east-1' is wrong; expecting 'ap-northeast-2'`.

If the same region error still appears in Steampipe, set the AWS plugin default region explicitly:

```hcl
connection "aws" {
  plugin = "aws"
  profile = "awsops-local-profile"
  default_region = "ap-northeast-2"
  regions = ["ap-northeast-2"]
  s3_force_path_style = true
}
```

For AI Assistant, confirm the private agent is using the expected Bedrock profile and Runtime endpoint:

```bash
curl -fsS http://127.0.0.1:7000/health | python3 -m json.tool
```

`bedrockEndpointUrl` must point to the Bedrock Runtime endpoint. The VPCE hostname should contain `bedrock-runtime`; a control-plane `bedrock` endpoint can return `UnknownOperationException` for `InvokeModelWithResponseStream`.

## Private Agent Does Not Start

Install dependencies and start again:

```bash
python3 -m pip install -r agent/requirements-private.txt
bash scripts/13-start-private-agent.sh
```

Inspect logs:

```bash
tail -n 80 data/private-agent/langgraph-api.log
```

Verify health:

```bash
curl -fsS http://127.0.0.1:7000/health | python3 -m json.tool
```

## Dashboard Does Not Start

Build and start:

```bash
npm install
npm run build
PORT=3000 npm run start
```

Check:

```bash
curl -i http://127.0.0.1:3000/awsops
```

## Steampipe Query Fails

Confirm the service:

```bash
steampipe service status
```

Confirm the AWS profile and region in the Steampipe connection file. For local/dev environments, the configured profile must be able to reach AWS through the approved endpoint path.

## Cloud Assets Sync Fails

Confirm the SQLite DB path is writable:

```bash
mkdir -p data
touch data/awsops.db
```

Confirm `data/config.json` only enables currently supported resource types:

```bash
python3 - <<'PY'
import json
cfg=json.load(open('data/config.json'))
print(cfg.get('assetInventory', {}).get('supportedResourceTypes', []))
PY
```

Current built-in sync support is `ec2_instance` and `s3_bucket`.

Confirm Steampipe can read the selected resources:

```bash
steampipe query "select instance_id from aws_ec2_instance limit 1"
steampipe query "select name from aws_s3_bucket limit 1"
```

If your Steampipe config has an aggregator connection, plain `aws_s3_bucket` can fan out across every `aws_*` connection. Test the configured account schema directly:

```bash
steampipe query "select name from aws_123456789012.aws_s3_bucket limit 5"
```

If `pg_namespace` only shows `aws` and no `aws_*` schema, test the loaded single AWS connection directly:

```bash
steampipe query "select name from aws.aws_s3_bucket limit 5"
```

When the single `aws` schema is intentional, set `accounts[0].connectionName` in `data/config.json` to `"aws"`.

Remember that Steampipe does not read AWSops `data/config.json` directly. The start script converts AWSops config into `~/.steampipe/config/awsops-private.spc` and exports endpoint environment variables before starting the Steampipe service. If the service was already running from an older shell, `steampipe query` will keep using that older service process until it is stopped and started again:

```bash
steampipe service stop --force
bash scripts/16-start-steampipe-private.sh
```

If that schema says the table does not exist, generate the AWSops Steampipe connection file from `data/config.json` and restart Steampipe:

```bash
bash scripts/16-start-steampipe-private.sh
cat ~/.steampipe/config/awsops-private.spc
steampipe query "select nspname from pg_namespace where nspname like 'aws_%' order by 1"
steampipe query "select table_schema, table_name from information_schema.tables where table_schema like 'aws_%' and table_name = 'aws_s3_bucket' order by 1"
```

Find leftover wildcard or non-Seoul region config:

```bash
grep -R "regions\\|default_region\\|aggregator\\|connections" ~/.steampipe/config/*.spc
```

If EC2 works but S3 returns no buckets or endpoint errors, restart Steampipe through the private start script so the configured S3 VPCE endpoint is injected into the Steampipe service process:

```bash
bash scripts/16-start-steampipe-private.sh
steampipe query "select name from aws_123456789012.aws_s3_bucket limit 5"
```

Cloud Assets sync uses Steampipe and the existing Steampipe AWS connection. It does not create AWS resources or VPC endpoints.

## Cloud Asset Inventory AI Has No Data

AI answers for 자산관리 / Cloud Asset Inventory questions use the saved SQLite ledger only. Run a Cloud Assets sync first, then check the DB file:

```bash
ls -lh data/awsops.db
sqlite3 data/awsops.db 'select service, resource_type, count(*) from asset_records group by 1,2;'
```

If a specific account is selected in the UI, the AI context is scoped to that `account_id`.

## Cloud Asset Admin Token Fails

Admin custom field changes require `x-awsops-asset-admin-token` and a matching SHA-256 hash in `AWSOPS_ASSET_ADMIN_TOKEN_HASH` or `assetInventory.adminTokenHash`.

Generate a hash:

```bash
node -e "const {createHash}=require('crypto'); const token=process.argv[1]; console.log('sha256:'+createHash('sha256').update(token).digest('hex'))" '<admin-token>'
```

## AI Chat Returns 502

Check the local agent first:

```bash
bash scripts/13-verify-private-agent.sh
```

Then check `data/config.json`:

- `agent.provider` must be `local-mcp-langgraph`
- `agent.langgraphApiUrl` must match the local service URL
- `environments.<active>.bedrockProfile` must exist in `~/.aws/credentials`
- explicit `endpointUrls` must include required services in explicit mode
- `endpointUrls["bedrock-runtime"]` must be a Bedrock Runtime VPCE URL, not a Bedrock control-plane URL

Bypass the dashboard and test the private agent directly:

```bash
curl -N --max-time 120 -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"health check"}]}' \
  http://127.0.0.1:7000/chat/stream
```

## AI Chat Says It Cannot Access Tools

In private VM mode, resource inventory questions such as EC2, VPC, S3, RDS, and Lambda should be handled by the Next.js AI API through Steampipe SQL, then analyzed by Bedrock. Confirm Steampipe is running and the AWS plugin tables exist:

```bash
steampipe service status
steampipe query "select instance_id, instance_state from aws_ec2_instance limit 5"
```

Then restart the dashboard process and ask again. The server log should include an `[AI] AWS context` line showing the active environment, Bedrock profile, Bedrock Runtime endpoint, and model ID used by `/api/ai`.

## A Script Tries To Create AWS Resources

Stop and remove that script from this branch. Private VM mode must not create AWS resources. Request the resource through the approved internal process and configure only the resulting metadata in `data/config.json`.
