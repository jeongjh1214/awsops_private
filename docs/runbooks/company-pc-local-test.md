# Company PC Local Test Runbook

This runbook is for testing AWSops from a company workstation.

The repository does not create AWS infrastructure. VPC endpoints, DNS, IAM, credentials, and network routes must already exist.

## Key Point

`npm --prefix web run dev` means "run the Next.js development server".

It does not select the AWSops `dev` environment. AWSops selects `local`, `dev`, or `prod` from `data/config.json`:

```json
{
  "activeEnvironment": "local"
}
```

If `activeEnvironment` is `local`, `npm --prefix web run dev` still uses the `local` profile and endpoint settings.

## Required Local Tools

```bash
node -v
npm -v
python3 --version
aws --version
steampipe --version
```

If `steampipe --version` is missing, the dashboard can render but resource pages will not work. Most pages query AWS through Steampipe on `127.0.0.1:9193`.

If Steampipe exists but `steampipe plugin install aws` cannot reach the plugin registry, place the approved macOS arm64 plugin artifact at:

```text
vendor/steampipe/aws/v1.31.0/darwin_arm64/steampipe-cli-plugin-aws-1.31.0-darwin-arm64.tgz
```

Then run:

```bash
bash scripts/15-install-vendored-steampipe-aws-plugin.sh
```

The artifact is not committed to git. The installer verifies its SHA-256 and installs it into `~/.steampipe/plugins/hub.steampipe.io/plugins/turbot/aws@1.31.0`, where it should appear in `steampipe plugin list`.

## Configure AWSops

```bash
mkdir -p data
cp docs/examples/config.vm-private.example.json data/config.json
```

Edit `data/config.json`:

- set `activeEnvironment` to `local`
- keep `assetInventory.dbProvider` as `sqlite` for local testing
- keep or update `assetInventory.sqlitePath`, for example `data/awsops.db`
- set `environments.local.awsProfile`
- set `environments.local.bedrockProfile`
- set `environments.local.endpointUrls`
- set `environments.local.endpointUrls.s3` to the approved S3 VPCE hostname when `s3_bucket` sync is enabled
- set `agent.modelId` to the approved Bedrock model ID or inference profile ARN
- set `accounts[0].profile` to the local AWSops profile

Do not commit `data/config.json`. It is intentionally gitignored.

For production or shared internal environments that use Aurora, set:

```bash
export AWSOPS_PRIVATE_DB_PROVIDER=aurora
```

or set `assetInventory.dbProvider` to `aurora` in the environment-specific runtime config.

## Configure Steampipe

Create the Steampipe AWS connection:

```bash
mkdir -p ~/.steampipe/config
cp docs/examples/steampipe-aws.spc.example ~/.steampipe/config/aws.spc
```

Edit `~/.steampipe/config/aws.spc` and set the profile and region. Keep `default_region = "ap-northeast-2"` and `s3_force_path_style = true` for explicit S3 VPCE access.

Start Steampipe:

```bash
bash scripts/16-start-steampipe-private.sh
steampipe service status --show-password
```

Copy the displayed password into `data/config.json`:

```json
{
  "steampipePassword": "replace-with-steampipe-service-password"
}
```

Alternatively, set it before starting Next.js:

```bash
export STEAMPIPE_PASSWORD='replace-with-steampipe-service-password'
```

## Install And Build

```bash
npm --prefix web ci
python3 -m pip install -r agent/requirements-private.txt
python3 -m py_compile agent/langgraph_api.py agent/mcp_server.py agent/private_runtime/*.py
bash -n scripts/*.sh
npm --prefix web run build
```

## Start Services

For local development:

```bash
npm --prefix web run dev
```

In a second terminal:

```bash
bash scripts/13-start-private-agent.sh
```

Open:

```text
http://127.0.0.1:3000
```

If every page action returns `401`, check authentication first:

```bash
curl -i http://127.0.0.1:3000/api/me
```

`401 unauthenticated` means the browser is not sending a valid `awsops_token` cookie. Open `/login`, sign in, and confirm the browser has an `awsops_token` cookie for `127.0.0.1`. Local `npm run dev` omits the cookie `Secure` attribute so the cookie works over `http://127.0.0.1`; production keeps `Secure`.

## Quick Diagnostics

Run:

```bash
bash scripts/14-check-local-private.sh
```

For S3/Steampipe issues:

```bash
bash scripts/17-diagnose-steampipe-s3.sh --restart
```

Review `data/steampipe-s3-diagnosis.log`.

Manual checks:

```bash
curl -i http://127.0.0.1:3000/api/db

curl -i http://127.0.0.1:7000/health
tail -n 80 data/private-agent/langgraph-api.log
```

## Common Symptoms

`next: command not found`

Run `npm ci` from the repository root.

`zombie cleanup failed: connect ECONNREFUSED 127.0.0.1:9193`

Steampipe is not running. Start it with:

```bash
bash scripts/16-start-steampipe-private.sh
```

`aws_ec2_instance does not exist`

The Steampipe AWS plugin is not loaded. Check:

```bash
steampipe plugin list
steampipe query "select table_schema, table_name from information_schema.tables where table_name = 'aws_ec2_instance';"
```

If the plugin registry is blocked on a matching macOS arm64 workstation:

```bash
bash scripts/15-install-vendored-steampipe-aws-plugin.sh
steampipe service restart --force
```

Initial page loads but resource pages are empty

Next.js is running, but Steampipe, AWS profile, or endpoint access is not working. Run `scripts/14-check-local-private.sh`.

EC2 works but S3 buckets are empty

S3 needs explicit service endpoint handling because bucket requests can use bucket-specific hostnames. Check:

```bash
AWS_PROFILE=awsops-local-profile aws s3api list-buckets \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.s3.ap-northeast-2.vpce.amazonaws.com

bash scripts/16-start-steampipe-private.sh
steampipe query "select name from aws_123456789012.aws_s3_bucket limit 5"
```

If Steampipe says `the region 'us-east-1' is wrong; expecting 'ap-northeast-2'`, add this to `~/.steampipe/config/aws.spc` inside the AWS connection:

```hcl
default_region = "ap-northeast-2"
regions = ["ap-northeast-2"]
s3_force_path_style = true
```

Cloud Asset Inventory S3 sync, the S3 dashboard, and AI Assistant live S3 queries all use Steampipe `aws_s3_bucket`. After changing `endpointUrls.s3`, profile, region, or Steampipe connection settings, restart the service with `scripts/16-start-steampipe-private.sh`.

If it still checks other regions, inspect all loaded Steampipe config files. Steampipe loads every `.spc` file under `~/.steampipe/config`.

```bash
grep -R "regions\\|default_region\\|aggregator\\|connections" ~/.steampipe/config/*.spc
```

If `aws_123456789012.aws_s3_bucket` does not exist, the configured account connection is not loaded. Generate the AWSops connection file and restart Steampipe:

```bash
bash scripts/16-start-steampipe-private.sh
cat ~/.steampipe/config/awsops-private.spc
steampipe query "select nspname from pg_namespace where nspname like 'aws_%' order by 1"
steampipe query "select table_schema, table_name from information_schema.tables where table_schema like 'aws_%' and table_name = 'aws_s3_bucket' order by 1"
```

If only the `aws` schema exists, query it directly and align `data/config.json` with that connection name:

```bash
steampipe query "select name from aws.aws_s3_bucket limit 5"
```

```json
"connectionName": "aws"
```

Steampipe does not read AWSops `data/config.json` by itself. The start script writes `~/.steampipe/config/awsops-private.spc` and starts the Steampipe service with the S3 endpoint environment. If the service was started before those settings existed, stop it and start it through the AWSops script:

```bash
steampipe service stop --force
bash scripts/16-start-steampipe-private.sh
```

AI returns 502

The private agent is not running or cannot call Bedrock. Check:

```bash
bash scripts/13-verify-private-agent.sh
```
