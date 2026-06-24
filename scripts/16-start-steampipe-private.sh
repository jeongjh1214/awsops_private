#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

if ! command -v steampipe >/dev/null 2>&1; then
  echo "steampipe is not installed or not in PATH"
  exit 1
fi

CONFIG_EXPORTS="$(
  python3 - <<'PY'
import json
import shlex
from pathlib import Path

config_path = Path("data/config.json")
data = {}
if config_path.exists():
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    active = cfg.get("activeEnvironment") or "dev"
    env = (cfg.get("environments") or {}).get(active) or {}
    endpoints = env.get("endpointUrls") or {}
    asset = cfg.get("assetInventory") or {}
    data = {
        "ACTIVE_ENVIRONMENT": active,
        "AWSOPS_PROFILE": env.get("awsProfile") or "",
        "ENDPOINT_MODE": env.get("endpointMode") or "",
        "S3_ENDPOINT_URL": endpoints.get("s3") or "",
        "S3_SYNC_ENABLED": "yes" if "s3_bucket" in (asset.get("supportedResourceTypes") or []) else "no",
    }
else:
    data = {
        "ACTIVE_ENVIRONMENT": "",
        "AWSOPS_PROFILE": "",
        "ENDPOINT_MODE": "",
        "S3_ENDPOINT_URL": "",
        "S3_SYNC_ENABLED": "unknown",
    }

for key, value in data.items():
    print(f"{key}={shlex.quote(str(value))}")
PY
)"
eval "$CONFIG_EXPORTS"

echo ""
echo -e "${CYAN}AWSops private Steampipe start${NC}"
echo ""
echo "  activeEnvironment: ${ACTIVE_ENVIRONMENT:-unknown}"
echo "  awsProfile: ${AWSOPS_PROFILE:-not set}"
echo "  endpointMode: ${ENDPOINT_MODE:-not set}"
echo "  s3 sync enabled: ${S3_SYNC_ENABLED:-unknown}"

if [ -n "${S3_ENDPOINT_URL:-}" ]; then
  export AWS_ENDPOINT_URL_S3="$S3_ENDPOINT_URL"
  echo "  AWS_ENDPOINT_URL_S3: $AWS_ENDPOINT_URL_S3"
else
  echo -e "  ${YELLOW}WARN${NC} S3 endpoint is not set in data/config.json"
  echo "       If s3_bucket sync is enabled in explicit endpoint mode, set environments.<active>.endpointUrls.s3."
fi

if steampipe service status 2>&1 | grep -q "running"; then
  echo ""
  echo -e "${CYAN}Restarting Steampipe so endpoint environment is applied...${NC}"
  steampipe service stop --force >/dev/null 2>&1 || true
  sleep 2
else
  steampipe service stop --force >/dev/null 2>&1 || true
fi

steampipe service start --database-listen network --database-port 9193

echo ""
echo -e "${GREEN}Steampipe service started on port 9193.${NC}"
echo "Run this to copy the DB password into data/config.json if needed:"
echo "  steampipe service status --show-password"
