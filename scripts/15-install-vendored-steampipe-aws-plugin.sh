#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ARTIFACT_DIR="vendor/steampipe/aws/v1.31.0/darwin_arm64"
ARTIFACT="${ARTIFACT_DIR}/steampipe-cli-plugin-aws-1.31.0-darwin-arm64.tgz"
EXPECTED_SHA256="4e742a04cb2a2f7453a776b7dd49e1f4775f9c5b13983fc16836a90d32b0a9cd"
PLUGIN_NAME="hub.steampipe.io/plugins/turbot/aws@1.31.0"
WORK_DIR="${TMPDIR:-/tmp}/awsops-steampipe-aws-plugin"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "[steampipe-plugin] This vendored artifact is for Darwin arm64 only."
  echo "[steampipe-plugin] Current platform: $(uname -s) $(uname -m)"
  exit 1
fi

if [ ! -f "$ARTIFACT" ]; then
  echo "[steampipe-plugin] Missing artifact: $ARTIFACT"
  exit 1
fi

actual_sha256="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
  echo "[steampipe-plugin] SHA256 mismatch for $ARTIFACT"
  echo "[steampipe-plugin] expected: $EXPECTED_SHA256"
  echo "[steampipe-plugin] actual:   $actual_sha256"
  exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
tar xzf "$ARTIFACT" -C "$WORK_DIR"

echo "[steampipe-plugin] Installing AWS Steampipe CLI plugin from vendored artifact."
mkdir -p "$HOME/.steampipe/plugins/hub.steampipe.io/plugins/turbot"
rm -rf "$HOME/.steampipe/plugins/hub.steampipe.io/plugins/turbot/aws@1.31.0"
cp -R "$WORK_DIR/hub.steampipe.io/plugins/turbot/aws@1.31.0" \
  "$HOME/.steampipe/plugins/hub.steampipe.io/plugins/turbot/aws@1.31.0"
chmod +x "$HOME/.steampipe/plugins/hub.steampipe.io/plugins/turbot/aws@1.31.0/steampipe-plugin-aws.plugin"

python3 - "$WORK_DIR/versions.json" "$HOME/.steampipe/plugins/versions.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

source_path = Path(sys.argv[1])
target_path = Path(sys.argv[2])
source = json.loads(source_path.read_text(encoding="utf-8"))
if target_path.exists():
    target = json.loads(target_path.read_text(encoding="utf-8"))
else:
    target = {"plugins": {}, "struct_version": source.get("struct_version", 20220411)}

target.setdefault("plugins", {}).update(source.get("plugins", {}))
target["struct_version"] = target.get("struct_version") or source.get("struct_version", 20220411)
target_path.parent.mkdir(parents=True, exist_ok=True)
target_path.write_text(json.dumps(target, indent=2) + "\n", encoding="utf-8")
PY

echo "[steampipe-plugin] Installed. Restart Steampipe service:"
echo "  steampipe service restart --force"
echo ""
echo "[steampipe-plugin] Confirm the plugin appears:"
echo "  steampipe plugin list"
echo ""
echo "[steampipe-plugin] Then verify:"
echo "  steampipe query \"select table_schema, table_name from information_schema.tables where table_name = 'aws_ec2_instance';\""
