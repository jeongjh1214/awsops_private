#!/bin/bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

failures=0
warnings=0

ok() {
  echo -e "  ${GREEN}OK${NC}   $1"
}

warn() {
  echo -e "  ${YELLOW}WARN${NC} $1"
  warnings=$((warnings + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  failures=$((failures + 1))
}

check_command() {
  name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    ok "$name: $(command -v "$name")"
  else
    fail "$name is not installed or not in PATH"
  fi
}

echo ""
echo -e "${CYAN}AWSops local private environment check${NC}"
echo ""

echo -e "${CYAN}[1/6] Required commands${NC}"
check_command node
check_command npm
check_command python3
check_command aws
check_command steampipe
if command -v curl >/dev/null 2>&1; then
  ok "curl: $(command -v curl)"
else
  warn "curl is missing; HTTP checks will be skipped"
fi

echo ""
echo -e "${CYAN}[2/6] Repository dependencies${NC}"
if [ -x web/node_modules/.bin/next ]; then
  ok "Next.js binary exists at web/node_modules/.bin/next"
else
  fail "web/node_modules/.bin/next is missing; run: npm --prefix web ci"
fi

if python3 - <<'PY' >/dev/null 2>&1
import fastapi, uvicorn, boto3
PY
then
  ok "Python private-agent dependencies import"
else
  warn "Python private-agent dependencies are missing; run: python3 -m pip install -r agent/requirements-private.txt"
fi

echo ""
echo -e "${CYAN}[3/6] data/config.json${NC}"
if [ ! -f data/config.json ]; then
  fail "data/config.json is missing; run: mkdir -p data && cp docs/examples/config.vm-private.example.json data/config.json"
else
  if python3 -m json.tool data/config.json >/dev/null 2>&1; then
    ok "data/config.json is valid JSON"
    python3 - <<'PY'
import json
cfg = json.load(open("data/config.json", encoding="utf-8"))
active = cfg.get("activeEnvironment")
env = (cfg.get("environments") or {}).get(active, {})
agent = cfg.get("agent") or {}
accounts = cfg.get("accounts") or []
aws_profile = env.get("awsProfile")
account = next((item for item in accounts if item.get("profile") == aws_profile), None)
if account is None:
    account = next((item for item in accounts if item.get("isHost")), None)
if account is None and accounts:
    account = accounts[0]
print(f"       activeEnvironment: {active}")
print(f"       awsProfile: {env.get('awsProfile')}")
print(f"       awsRegion: {(account or {}).get('region')}")
print(f"       bedrockProfile: {env.get('bedrockProfile')}")
print(f"       endpointMode: {env.get('endpointMode')}")
print(f"       endpointUrls: {', '.join(sorted((env.get('endpointUrls') or {}).keys())) or '(none)'}")
print(f"       agent.provider: {agent.get('provider')}")
print(f"       agent.modelId: {agent.get('modelId')}")
print(f"       steampipePassword: {'set' if cfg.get('steampipePassword') else 'not set'}")
print(f"       accounts: {len(accounts)}")
PY
    s3_check="$(python3 - <<'PY'
import json
cfg = json.load(open("data/config.json", encoding="utf-8"))
active = cfg.get("activeEnvironment")
env = (cfg.get("environments") or {}).get(active, {})
endpoints = env.get("endpointUrls") or {}
asset = cfg.get("assetInventory") or {}
resource_types = asset.get("supportedResourceTypes") or []
if env.get("endpointMode") == "explicit" and "s3_bucket" in resource_types and not endpoints.get("s3"):
    print(f"missing:{active}")
else:
    print("ok:")
PY
)"
    if [[ "$s3_check" == missing:* ]]; then
      active_env="${s3_check#missing:}"
      fail "s3_bucket sync is enabled but environments.${active_env}.endpointUrls.s3 is missing"
    else
      ok "S3 endpoint config is compatible with the selected asset sync types"
    fi
  else
    fail "data/config.json is invalid JSON"
  fi
fi

echo ""
echo -e "${CYAN}[4/6] Steampipe service${NC}"
if command -v steampipe >/dev/null 2>&1; then
  if steampipe service status 2>&1 | grep -q "running"; then
    ok "Steampipe service is running"
  else
    fail "Steampipe service is not running; run: steampipe service start --database-listen network --database-port 9193"
  fi
else
  fail "Cannot check Steampipe service because steampipe is missing"
fi

if [ -f "$HOME/.steampipe/config/aws.spc" ]; then
  ok "~/.steampipe/config/aws.spc exists"
  if grep -R --include='*.spc' -Eq 'regions[[:space:]]*=[[:space:]]*\[[^]]*("[*]"|"us-east-1")' "$HOME/.steampipe/config" 2>/dev/null; then
    warn "Some Steampipe .spc file still contains wildcard or us-east-1 regions; inspect with: grep -R \"regions\\|default_region\\|aggregator\\|connections\" ~/.steampipe/config/*.spc"
  fi
  if grep -R --include='*.spc' -Eq 'type[[:space:]]*=[[:space:]]*"?(aggregator)"?' "$HOME/.steampipe/config" 2>/dev/null; then
    warn "A Steampipe aggregator connection exists; plain aws_s3_bucket queries may fan out across aws_* connections"
  fi
  if grep -Eq '^[[:space:]]*default_region[[:space:]]*=[[:space:]]*"ap-northeast-2"' "$HOME/.steampipe/config/aws.spc"; then
    ok "Steampipe AWS config has default_region = \"ap-northeast-2\""
  else
    warn "Set default_region = \"ap-northeast-2\" in ~/.steampipe/config/aws.spc for S3 VPCE signing"
  fi
  if grep -Eq '^[[:space:]]*s3_force_path_style[[:space:]]*=[[:space:]]*true' "$HOME/.steampipe/config/aws.spc"; then
    ok "Steampipe AWS config has s3_force_path_style = true"
  else
    warn "Set s3_force_path_style = true in ~/.steampipe/config/aws.spc for explicit S3 VPCE access"
  fi
else
  warn "~/.steampipe/config/aws.spc is missing; copy docs/examples/steampipe-aws.spc.example and edit it"
fi

if [ -f "$HOME/.steampipe/config/awsops-private.spc" ]; then
  ok "~/.steampipe/config/awsops-private.spc exists"
else
  warn "~/.steampipe/config/awsops-private.spc is missing; run: bash scripts/16-start-steampipe-private.sh"
fi

if [ -f data/config.json ] && [ -d "$HOME/.steampipe/config" ]; then
  python3 - <<'PY'
import json
from pathlib import Path

cfg = json.load(open("data/config.json", encoding="utf-8"))
accounts = cfg.get("accounts") or []
config_text = "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in (Path.home() / ".steampipe" / "config").glob("*.spc"))
for account in accounts:
    account_id = str(account.get("accountId") or "")
    connection = str(account.get("connectionName") or f"aws_{account_id}")
    status = "OK" if f'connection "{connection}"' in config_text else "MISSING"
    print(f"       steampipe connection {connection}: {status}")
PY
fi

echo ""
echo -e "${CYAN}[5/6] Local HTTP services${NC}"
if command -v curl >/dev/null 2>&1; then
  next_code="$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000 2>/dev/null || true)"
  if [ "$next_code" = "200" ]; then
    ok "Next.js responds at http://127.0.0.1:3000"
  else
    warn "Next.js is not responding on / (HTTP ${next_code:-000}); start with: npm --prefix web run dev"
  fi

  config_code="$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/db 2>/dev/null || true)"
  if [ "$config_code" = "200" ]; then
    ok "Next.js API responds"
  else
    warn "Next.js API is not responding (HTTP ${config_code:-000})"
  fi

  agent_code="$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7000/health 2>/dev/null || true)"
  if [ "$agent_code" = "200" ]; then
    ok "Private agent responds at http://127.0.0.1:7000/health"
  else
    warn "Private agent is not responding (HTTP ${agent_code:-000}); start with: bash scripts/13-start-private-agent.sh"
  fi
else
  warn "Skipping HTTP checks because curl is missing"
fi

echo ""
echo -e "${CYAN}[6/6] Guidance${NC}"
echo "  npm --prefix web run dev selects the Next.js development server only."
echo "  AWSops local/dev/prod selection comes from data/config.json activeEnvironment."
echo "  Local private AI requires the private agent on 127.0.0.1:7000."
echo "  Steampipe is used only where local/private data paths explicitly call it."
echo "  S3 bucket sync requires Steampipe to start with AWS_ENDPOINT_URL_S3 or an AWS shared-config S3 endpoint."
echo "  Recommended: bash scripts/16-start-steampipe-private.sh"
echo "  For local mode set agent.provider = local-mcp-langgraph in data/config.json."

echo ""
if [ "$failures" -gt 0 ]; then
  echo -e "${RED}Check complete: ${failures} failure(s), ${warnings} warning(s).${NC}"
  exit 1
fi

echo -e "${GREEN}Check complete: no hard failures, ${warnings} warning(s).${NC}"
