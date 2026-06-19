# Company PC Local Test Runbook

This runbook is for testing AWSops from a company workstation.

The repository does not create AWS infrastructure. VPC endpoints, DNS, IAM, credentials, and network routes must already exist.

## Key Point

`npm run dev` means "run the Next.js development server".

It does not select the AWSops `dev` environment. AWSops selects `local`, `dev`, or `prod` from `data/config.json`:

```json
{
  "activeEnvironment": "local"
}
```

If `activeEnvironment` is `local`, `npm run dev` still uses the `local` profile and endpoint settings.

## Required Local Tools

```bash
node -v
npm -v
python3 --version
aws --version
steampipe --version
```

If `steampipe --version` is missing, the dashboard can render but resource pages will not work. Most pages query AWS through Steampipe on `127.0.0.1:9193`.

If Steampipe exists but `steampipe plugin install aws` cannot reach the plugin registry, this branch includes a temporary vendored package for macOS arm64 company workstations:

```bash
bash scripts/15-install-vendored-steampipe-aws-plugin.sh
```

The vendored package is `vendor/steampipe/aws/v1.31.0/darwin_arm64/steampipe_postgres_aws.pg15.darwin_arm64.tar.gz`. It is only for matching Darwin arm64 machines with PostgreSQL 15.

The vendored installer needs `pg_config` because Steampipe plugins are PostgreSQL FDW extensions. If it is not on `PATH`, the script searches common Steampipe and Homebrew locations. You can also check manually:

```bash
find ~/.steampipe -name pg_config -type f
brew install postgresql@15
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
```

## Configure AWSops

```bash
mkdir -p data
cp docs/examples/config.vm-private.example.json data/config.json
```

Edit `data/config.json`:

- set `activeEnvironment` to `local`
- set `environments.local.awsProfile`
- set `environments.local.bedrockProfile`
- set `environments.local.endpointUrls`
- set `agent.modelId` to the approved Bedrock model ID or inference profile ARN
- set `accounts[0].profile` to the local AWSops profile

Do not commit `data/config.json`. It is intentionally gitignored.

## Configure Steampipe

Create the Steampipe AWS connection:

```bash
mkdir -p ~/.steampipe/config
cp docs/examples/steampipe-aws.spc.example ~/.steampipe/config/aws.spc
```

Edit `~/.steampipe/config/aws.spc` and set the profile and region.

Start Steampipe:

```bash
steampipe service start --database-listen network --database-port 9193
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
npm ci
python3 -m pip install -r agent/requirements-private.txt
python3 -m unittest discover -s tests/private -p 'test_*.py' -v
bash -n scripts/*.sh
npm run build
```

## Start Services

For local development:

```bash
npm run dev
```

In a second terminal:

```bash
bash scripts/13-start-private-agent.sh
```

Open:

```text
http://127.0.0.1:3000/awsops
```

## Quick Diagnostics

Run:

```bash
bash scripts/14-check-local-private.sh
```

Manual checks:

```bash
curl -i http://127.0.0.1:3000/awsops/api/steampipe?action=config

curl -i -X POST http://127.0.0.1:3000/awsops/api/steampipe \
  -H 'Content-Type: application/json' \
  -d '{"queries":{"health":"select 1 as ok"}}'

curl -i http://127.0.0.1:7000/health
tail -n 80 data/private-agent/langgraph-api.log
```

## Common Symptoms

`next: command not found`

Run `npm ci` from the repository root.

`zombie cleanup failed: connect ECONNREFUSED 127.0.0.1:9193`

Steampipe is not running. Start it with:

```bash
steampipe service start --database-listen network --database-port 9193
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

AI returns 502

The private agent is not running or cannot call Bedrock. Check:

```bash
bash scripts/13-verify-private-agent.sh
```
