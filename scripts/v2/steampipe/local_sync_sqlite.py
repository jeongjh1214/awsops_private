#!/usr/bin/env python3
"""Local-only Steampipe -> SQLite inventory sync.

This is the company-PC counterpart of sync_lambda.py. The Lambda path writes Steampipe
inventory into Aurora; local development writes the same shape into data/awsops.db so the
Next.js UI can inspect real data without Aurora.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sqlite3
import sys
import types
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
SYNC_LAMBDA_PATH = Path(__file__).resolve().with_name("sync_lambda.py")

TYPE_ALIASES = {
    "ec2_instance": "ec2",
    "lambda_function": "lambda",
    "rds_instance": "rds",
    "dynamodb_table": "dynamodb",
    "s3_bucket": "s3",
}

LOCAL_QUERIES = {
    "s3": (
        "SELECT name, region, account_id, arn, creation_date, tags "
        "FROM aws_s3_bucket ORDER BY name",
        "name",
        "region",
    ),
}


def load_sync_lambda_queries() -> dict[str, tuple[str, str, str]]:
    # sync_lambda imports boto3 for SDK-sourced inventory; local Steampipe sync only needs QUERIES.
    sys.modules["boto3"] = types.SimpleNamespace(client=lambda *a, **k: object())
    sys.modules.setdefault("botocore", types.SimpleNamespace())
    sys.modules["botocore.exceptions"] = types.SimpleNamespace(ClientError=Exception)
    spec = importlib.util.spec_from_file_location("awsops_sync_lambda_queries", SYNC_LAMBDA_PATH)
    if not spec or not spec.loader:
        raise RuntimeError(f"Cannot load {SYNC_LAMBDA_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    queries = dict(module.QUERIES)
    queries.update(LOCAL_QUERIES)
    return queries


def read_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Missing config: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def sqlite_path(config_path: Path, config: dict[str, Any]) -> Path:
    configured = (
        os.environ.get("AWSOPS_PRIVATE_SQLITE_PATH")
        or os.environ.get("AWSOPS_ASSET_DB_PATH")
        or (config.get("assetInventory") or {}).get("sqlitePath")
        or "data/awsops.db"
    )
    path = Path(configured)
    if path.is_absolute():
        return path
    if path.parts and path.parts[0] == "data":
        return (ROOT / path).resolve()
    return (config_path.parent / path).resolve()


def default_types(config: dict[str, Any], queries: dict[str, tuple[str, str, str]]) -> list[str]:
    supported = (config.get("assetInventory") or {}).get("supportedResourceTypes") or []
    mapped = [TYPE_ALIASES.get(str(item), str(item)) for item in supported]
    selected = [item for item in mapped if item in queries]
    return selected or ["ec2", "s3"]


def host_account_id(config: dict[str, Any]) -> str:
    accounts = config.get("accounts") or []
    host = next((item for item in accounts if item.get("isHost")), None) or (accounts[0] if accounts else {})
    return str(host.get("accountId") or "")


def steampipe_password(config: dict[str, Any]) -> str:
    return os.environ.get("STEAMPIPE_PASSWORD") or str(config.get("steampipePassword") or "")


def connect_steampipe(config: dict[str, Any]):
    try:
        import pg8000
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing Python dependency pg8000. Run: "
            "python3 -m pip install -r scripts/v2/steampipe/requirements.txt"
        ) from exc

    password = steampipe_password(config)
    if not password:
        raise SystemExit(
            "Missing Steampipe password. Set STEAMPIPE_PASSWORD or data/config.json steampipePassword "
            "from: steampipe service status --show-password"
        )
    return pg8000.connect(
        host=os.environ.get("STEAMPIPE_HOST", "127.0.0.1"),
        port=int(os.environ.get("STEAMPIPE_PORT", "9193")),
        database=os.environ.get("STEAMPIPE_DB", "steampipe"),
        user=os.environ.get("STEAMPIPE_USER", "steampipe"),
        password=password,
        timeout=30,
    )


def prefixed_sql(sql: str, connection: str) -> str:
    return re.sub(r"\b(FROM|JOIN)\s+(aws_[A-Za-z0-9_]+)", rf"\1 {connection}.\2", sql)


def run_steampipe_query(config: dict[str, Any], sql: str, connection: str) -> list[dict[str, Any]]:
    candidates = [sql]
    if connection:
        candidates.append(prefixed_sql(sql, connection))

    last_error: Exception | None = None
    for candidate in candidates:
        conn = None
        cur = None
        try:
            conn = connect_steampipe(config)
            cur = conn.cursor()
            cur.execute(candidate)
            columns = [item[0] for item in (cur.description or [])]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        finally:
            if cur is not None:
                cur.close()
            if conn is not None:
                conn.close()
    raise RuntimeError(str(last_error))


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS inventory_resources (
          resource_id TEXT NOT NULL,
          region TEXT NOT NULL DEFAULT '',
          account_id TEXT NOT NULL DEFAULT 'self',
          resource_type TEXT NOT NULL,
          data TEXT NOT NULL DEFAULT '{}',
          captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(account_id, resource_type, resource_id, region)
        );
        CREATE INDEX IF NOT EXISTS idx_inventory_resources_type_account
          ON inventory_resources(resource_type, account_id, region);

        CREATE TABLE IF NOT EXISTS inventory_sync_runs (
          resource_type TEXT NOT NULL,
          account_id TEXT NOT NULL DEFAULT 'self',
          status TEXT NOT NULL DEFAULT '',
          started_at TEXT,
          finished_at TEXT,
          row_count INTEGER,
          error TEXT,
          PRIMARY KEY(resource_type, account_id)
        );

        CREATE TABLE IF NOT EXISTS inventory_snapshots (
          account_id TEXT NOT NULL DEFAULT 'self',
          captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resource_type TEXT NOT NULL,
          resource_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS asset_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id TEXT NOT NULL,
          account_name TEXT DEFAULT '',
          service TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          arn TEXT DEFAULT '',
          name TEXT DEFAULT '',
          region TEXT DEFAULT '',
          data_json TEXT NOT NULL DEFAULT '{}',
          discovered_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          UNIQUE(account_id, service, resource_type, resource_id)
        );
        """
    )
    migrate_schema(conn)


def migrate_schema(conn: sqlite3.Connection) -> None:
    sync_run_columns = {row[1] for row in conn.execute("PRAGMA table_info(inventory_sync_runs)").fetchall()}
    if "started_at" not in sync_run_columns:
        conn.execute("ALTER TABLE inventory_sync_runs ADD COLUMN started_at TEXT")
    ensure_columns(conn, "asset_records", {
        "account_name": "TEXT DEFAULT ''",
        "arn": "TEXT DEFAULT ''",
        "name": "TEXT DEFAULT ''",
        "region": "TEXT DEFAULT ''",
        "data_json": "TEXT NOT NULL DEFAULT '{}'",
        "discovered_at": "TEXT",
        "last_seen_at": "TEXT",
        "is_active": "INTEGER NOT NULL DEFAULT 1",
    })


def ensure_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def account_for(row: dict[str, Any], host: str) -> str:
    account_id = str(row.get("account_id") or "")
    if not account_id or account_id == host:
        return "self"
    return account_id


def service_for(resource_type: str) -> str:
    if resource_type.startswith("ebs_"):
        return "ebs"
    if resource_type.startswith("iam_"):
        return "iam"
    if resource_type.startswith("apigateway"):
        return "apigateway"
    if resource_type in {"alb", "nlb", "target_group"}:
        return "elb"
    return resource_type.split("_", 1)[0]


def display_name(row: dict[str, Any], resource_id: str) -> str:
    tags = row.get("tags")
    tag_name = tags.get("Name") if isinstance(tags, dict) else None
    return str(row.get("name") or tag_name or resource_id)


def sync_type(
    db: sqlite3.Connection,
    config: dict[str, Any],
    resource_type: str,
    sql: str,
    id_col: str,
    region_col: str,
    connection: str,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    host = host_account_id(config)
    rows = run_steampipe_query(config, render_local_sql(sql, config), connection)
    service = service_for(resource_type)

    with db:
        db.execute(
            """
            INSERT INTO inventory_sync_runs(resource_type, account_id, status, started_at, finished_at, row_count, error)
            VALUES (?, 'self', 'running', ?, NULL, NULL, NULL)
            ON CONFLICT(resource_type, account_id) DO UPDATE SET
              status='running', started_at=excluded.started_at, finished_at=NULL, row_count=NULL, error=NULL
            """,
            (resource_type, now),
        )
        db.execute("DELETE FROM inventory_resources WHERE resource_type = ?", (resource_type,))
        db.execute("UPDATE asset_records SET is_active = 0 WHERE resource_type = ?", (resource_type,))

        self_count = 0
        for row in rows:
            resource_id = str(row.get(id_col) or "")
            if not resource_id:
                continue
            region = str(row.get(region_col) or "")
            account_id = account_for(row, host)
            if account_id == "self":
                self_count += 1
            data_json = json.dumps(row, default=str, ensure_ascii=False)
            arn = str(row.get("arn") or row.get("cluster_arn") or row.get("transit_gateway_arn") or "")
            name = display_name(row, resource_id)

            db.execute(
                """
                INSERT OR REPLACE INTO inventory_resources
                  (resource_id, region, account_id, resource_type, data, captured_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (resource_id, region, account_id, resource_type, data_json, now),
            )
            db.execute(
                """
                INSERT INTO asset_records
                  (account_id, service, resource_type, resource_id, arn, name, region, data_json, discovered_at, last_seen_at, is_active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(account_id, service, resource_type, resource_id) DO UPDATE SET
                  arn=excluded.arn,
                  name=excluded.name,
                  region=excluded.region,
                  data_json=excluded.data_json,
                  last_seen_at=excluded.last_seen_at,
                  is_active=1
                """,
                (account_id, service, resource_type, resource_id, arn, name, region, data_json, now, now),
            )

        db.execute(
            """
            UPDATE inventory_sync_runs
               SET status='succeeded', finished_at=?, row_count=?, error=NULL
             WHERE resource_type=? AND account_id='self'
            """,
            (now, len(rows), resource_type),
        )
        db.execute(
            "DELETE FROM inventory_snapshots WHERE account_id='self' AND resource_type=? AND substr(captured_at, 1, 10)=?",
            (resource_type, now[:10]),
        )
        db.execute(
            "INSERT INTO inventory_snapshots(account_id, captured_at, resource_type, resource_count) VALUES ('self', ?, ?, ?)",
            (now, resource_type, self_count),
        )
    return {"type": resource_type, "rowCount": len(rows), "selfCount": self_count}


def render_local_sql(sql: str, config: dict[str, Any]) -> str:
    if "{owner_ids}" in sql:
        ids = [str(item.get("accountId")) for item in (config.get("accounts") or []) if re.fullmatch(r"\d{12}", str(item.get("accountId") or ""))]
        if not ids:
            ids = [host_account_id(config)]
        sql = sql.replace("{owner_ids}", ",".join(f"'{item}'" for item in sorted(set(ids)) if item))
    if "{account_id}" in sql:
        account_id = host_account_id(config)
        if not re.fullmatch(r"\d{12}", account_id):
            raise ValueError("Cannot render {account_id}; data/config.json accounts[0].accountId must be 12 digits")
        sql = sql.replace("{account_id}", account_id)
    return sql


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync local Steampipe inventory into SQLite")
    parser.add_argument("--config", default="data/config.json")
    parser.add_argument("--types", help="Comma-separated resource types. Defaults to assetInventory.supportedResourceTypes.")
    parser.add_argument("--all", action="store_true", help="Sync every Steampipe-backed registered type.")
    parser.add_argument("--connection", default=os.environ.get("AWSOPS_STEAMPIPE_CONNECTION", "aws"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config_path = (ROOT / args.config).resolve() if not Path(args.config).is_absolute() else Path(args.config)
    config = read_config(config_path)
    queries = load_sync_lambda_queries()

    if args.all:
        selected = sorted(queries)
    elif args.types:
        selected = [TYPE_ALIASES.get(item.strip(), item.strip()) for item in args.types.split(",") if item.strip()]
    else:
        selected = default_types(config, queries)

    db_path = sqlite_path(config_path, config)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"[local-sync] sqlite: {db_path}")
    print(f"[local-sync] types: {', '.join(selected)}")

    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    try:
        ensure_schema(db)
        summary = []
        failed = []
        for resource_type in selected:
            if resource_type not in queries:
                print(f"[local-sync] skip unsupported type: {resource_type}", file=sys.stderr)
                continue
            sql, id_col, region_col = queries[resource_type]
            try:
                item = sync_type(db, config, resource_type, sql, id_col, region_col, args.connection)
                summary.append(item)
                print(f"[local-sync] {resource_type}: {item['rowCount']} rows")
            except Exception as exc:  # noqa: BLE001
                failed.append({"type": resource_type, "error": str(exc)})
                now = datetime.now(timezone.utc).isoformat()
                with db:
                    db.execute(
                        """
                        INSERT INTO inventory_sync_runs(resource_type, account_id, status, started_at, finished_at, row_count, error)
                        VALUES (?, 'self', 'failed', ?, ?, NULL, ?)
                        ON CONFLICT(resource_type, account_id) DO UPDATE SET
                          status='failed', finished_at=excluded.finished_at, error=excluded.error
                        """,
                        (resource_type, now, now, str(exc)[:2000]),
                    )
                print(f"[local-sync] {resource_type}: failed: {exc}", file=sys.stderr)
        total_rows = sum(int(item["rowCount"]) for item in summary)
        status = "failed" if failed else "ok"
        if not failed and total_rows == 0:
            print(
                "[local-sync] completed, but Steampipe returned 0 rows. "
                "Check AWS profile/SSO, account IDs, selected types, and Steampipe connection.",
                file=sys.stderr,
            )
        print(json.dumps({"status": status, "summary": summary, "failed": failed}, ensure_ascii=False))
        return 1 if failed else 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
