#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ARTIFACT_DIR="vendor/steampipe/aws/v1.31.0/darwin_arm64"
ARTIFACT="${ARTIFACT_DIR}/steampipe_postgres_aws.pg15.darwin_arm64.tar.gz"
EXPECTED_SHA256="03fc349ee5de50143c737ed9aa24b84b162f6442087a9aee90c3d13a582c855f"
WORK_DIR="${TMPDIR:-/tmp}/awsops-steampipe-aws-plugin"

find_pg_config() {
  if command -v pg_config >/dev/null 2>&1; then
    command -v pg_config
    return 0
  fi

  for candidate in \
    "$HOME"/.steampipe/db/*/bin/pg_config \
    "$HOME"/.steampipe/db/*/*/bin/pg_config \
    /opt/homebrew/opt/postgresql@15/bin/pg_config \
    /opt/homebrew/bin/pg_config \
    /usr/local/opt/postgresql@15/bin/pg_config \
    /usr/local/bin/pg_config; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

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

if ! PG_CONFIG="$(find_pg_config)"; then
  echo "[steampipe-plugin] pg_config is required to install the PostgreSQL FDW files."
  echo "[steampipe-plugin] It is usually provided by PostgreSQL 15 or Steampipe's embedded PostgreSQL."
  echo "[steampipe-plugin] Try:"
  echo "  find ~/.steampipe -name pg_config -type f"
  echo "  brew install postgresql@15"
  echo "  export PATH=\"/opt/homebrew/opt/postgresql@15/bin:\$PATH\""
  exit 1
fi

pg_major="$("$PG_CONFIG" --version | sed 's/[^0-9]*\([0-9]\{1,\}\.[0-9]\{1,\}\).*/\1/' | cut -d'.' -f1)"
if [ "$pg_major" != "15" ]; then
  echo "[steampipe-plugin] This artifact targets PostgreSQL 15, but pg_config reports: $("$PG_CONFIG" --version)"
  echo "[steampipe-plugin] pg_config path: $PG_CONFIG"
  echo "[steampipe-plugin] If your Steampipe/PostgreSQL is pg14, add the pg14 artifact instead."
  exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
tar xzf "$ARTIFACT" -C "$WORK_DIR"

echo "[steampipe-plugin] Installing AWS PostgreSQL FDW from vendored artifact."
echo "[steampipe-plugin] The upstream installer will ask for confirmation."
cd "$WORK_DIR/steampipe_postgres_aws.pg15.darwin_arm64"
PATH="$(dirname "$PG_CONFIG"):$PATH" ./install.sh

echo "[steampipe-plugin] Installed. Restart Steampipe service:"
echo "  steampipe service restart --force"
echo ""
echo "[steampipe-plugin] Then verify:"
echo "  steampipe query \"select table_schema, table_name from information_schema.tables where table_name = 'aws_ec2_instance';\""
