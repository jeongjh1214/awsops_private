#!/bin/bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

LOG_PATH="${AWSOPS_S3_DIAG_LOG:-data/steampipe-s3-diagnosis.log}"
RESTART="${1:-}"

mkdir -p "$(dirname "$LOG_PATH")"
: > "$LOG_PATH"

log() {
  echo "$@" | tee -a "$LOG_PATH"
}

run() {
  log ""
  log "$ $*"
  "$@" 2>&1 | tee -a "$LOG_PATH"
  status=${PIPESTATUS[0]}
  log "exit: $status"
  return "$status"
}

extract_config() {
  python3 - <<'PY'
import json
import shlex
from pathlib import Path

cfg_path = Path("data/config.json")
if not cfg_path.exists():
    values = {
        "ACTIVE_ENVIRONMENT": "",
        "AWSOPS_PROFILE": "",
        "AWSOPS_ACCOUNT_ID": "",
        "AWSOPS_CONNECTION_NAME": "",
        "AWSOPS_REGION": "",
        "S3_ENDPOINT_URL": "",
    }
else:
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    active = cfg.get("activeEnvironment") or "dev"
    env = (cfg.get("environments") or {}).get(active) or {}
    accounts = cfg.get("accounts") or []
    profile = env.get("awsProfile") or ""
    account = next((item for item in accounts if item.get("profile") == profile), None)
    if account is None:
        account = next((item for item in accounts if item.get("isHost")), None)
    if account is None and accounts:
        account = accounts[0]
    account_id = str((account or {}).get("accountId") or "")
    values = {
        "ACTIVE_ENVIRONMENT": active,
        "AWSOPS_PROFILE": str((account or {}).get("profile") or profile),
        "AWSOPS_ACCOUNT_ID": account_id,
        "AWSOPS_CONNECTION_NAME": str((account or {}).get("connectionName") or (f"aws_{account_id}" if account_id else "")),
        "AWSOPS_REGION": str((account or {}).get("region") or ""),
        "S3_ENDPOINT_URL": str((env.get("endpointUrls") or {}).get("s3") or ""),
    }

for key, value in values.items():
    print(f"{key}={shlex.quote(value)}")
PY
}

CONFIG_EXPORTS="$(extract_config)"
eval "$CONFIG_EXPORTS"

log "AWSops Steampipe S3 diagnosis"
log "repo: $ROOT_DIR"
log "log: $LOG_PATH"
log "activeEnvironment: ${ACTIVE_ENVIRONMENT:-not set}"
log "accountId: ${AWSOPS_ACCOUNT_ID:-not set}"
log "connectionName: ${AWSOPS_CONNECTION_NAME:-not set}"
log "profile: ${AWSOPS_PROFILE:-not set}"
log "region: ${AWSOPS_REGION:-not set}"
log "s3Endpoint: ${S3_ENDPOINT_URL:-not set}"

if [ "$RESTART" = "--restart" ]; then
  run steampipe service stop --force || true
  run bash scripts/16-start-steampipe-private.sh || true
fi

log ""
log "## Required commands"
for cmd in python3 aws steampipe; do
  if command -v "$cmd" >/dev/null 2>&1; then
    log "OK $cmd: $(command -v "$cmd")"
  else
    log "MISSING $cmd"
  fi
done

log ""
log "## data/config.json summary"
if [ -f data/config.json ]; then
  run python3 - <<'PY'
import json
cfg = json.load(open("data/config.json", encoding="utf-8"))
active = cfg.get("activeEnvironment")
env = (cfg.get("environments") or {}).get(active, {})
print("activeEnvironment:", active)
print("env.awsProfile:", env.get("awsProfile"))
print("env.endpointUrls keys:", sorted((env.get("endpointUrls") or {}).keys()))
for account in cfg.get("accounts") or []:
    print("account:", {
        "accountId": account.get("accountId"),
        "connectionName": account.get("connectionName"),
        "profile": account.get("profile"),
        "region": account.get("region"),
        "isHost": account.get("isHost"),
    })
PY
else
  log "MISSING data/config.json"
fi

log ""
log "## Steampipe config files"
if [ -d "$HOME/.steampipe/config" ]; then
  run find "$HOME/.steampipe/config" -maxdepth 1 -type f -name "*.spc" -print
  run grep -R "connection \\|profile\\|default_region\\|regions\\|s3_force_path_style\\|type\\|connections" "$HOME/.steampipe/config"/*.spc
else
  log "MISSING $HOME/.steampipe/config"
fi

log ""
log "## Generated AWSops Steampipe config"
if [ -f "$HOME/.steampipe/config/awsops-private.spc" ]; then
  run sed -n '1,220p' "$HOME/.steampipe/config/awsops-private.spc"
else
  log "MISSING $HOME/.steampipe/config/awsops-private.spc"
  log "Run: bash scripts/16-start-steampipe-private.sh"
fi

log ""
log "## AWS CLI direct checks"
if [ -n "${AWSOPS_PROFILE:-}" ] && [ -n "${AWSOPS_REGION:-}" ]; then
  run aws sts get-caller-identity --profile "$AWSOPS_PROFILE" --region "$AWSOPS_REGION" --output json || true
  if [ -n "${S3_ENDPOINT_URL:-}" ]; then
    run aws s3api list-buckets --profile "$AWSOPS_PROFILE" --region "$AWSOPS_REGION" --endpoint-url "$S3_ENDPOINT_URL" --query 'Buckets[0:5].Name' --output text || true
  else
    log "SKIP aws s3api list-buckets: S3 endpoint URL is empty"
  fi
else
  log "SKIP AWS CLI checks: profile or region is empty"
fi

log ""
log "## Steampipe service"
if command -v steampipe >/dev/null 2>&1; then
  run steampipe service status || true
  run steampipe plugin list || true
fi

log ""
log "## Steampipe schema/table checks"
if command -v steampipe >/dev/null 2>&1; then
  run steampipe query "select current_database(), current_schema();" || true
  run steampipe query "select nspname from pg_namespace where nspname like 'aws%' order by 1;" || true
  run steampipe query "select table_schema, table_name from information_schema.tables where table_schema like 'aws%' and table_name = 'aws_s3_bucket' order by 1;" || true
  if [ -n "${AWSOPS_CONNECTION_NAME:-}" ]; then
    run steampipe query "select name from ${AWSOPS_CONNECTION_NAME}.aws_s3_bucket limit 5;" || true
  fi
  run steampipe query "select name from aws.aws_s3_bucket limit 5;" || true
  run steampipe query "select name from aws_s3_bucket limit 5;" || true
fi

log ""
log "Diagnosis complete. Share this log after removing anything your policy treats as sensitive:"
log "$LOG_PATH"
