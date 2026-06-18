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
AWS_PROFILE=bedrock-local-profile aws bedrock-runtime list-foundation-models \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.bedrock-runtime.ap-northeast-2.vpce.amazonaws.com
```

If TLS hostname verification fails, use the VPCE DNS hostname in `endpointUrls`. Do not replace the hostname with an arbitrary private IP.

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

## A Script Tries To Create AWS Resources

Stop and remove that script from this branch. Private VM mode must not create AWS resources. Request the resource through the approved internal process and configure only the resulting metadata in `data/config.json`.
