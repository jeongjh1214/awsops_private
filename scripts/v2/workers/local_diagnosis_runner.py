#!/usr/bin/env python3
"""Run an AI diagnosis report locally against SQLite.

Production diagnosis runs through SQS/Fargate/Aurora/S3. Company-PC local testing uses this
runner instead: it reuses diagnosis.report.generate(), reads inventory_resources from SQLite,
and stores the markdown artifact under data/diagnosis/.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
WORKERS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(WORKERS_DIR))


class LocalSqliteConn:
    def __init__(self, path: Path):
        self.path = path
        self.conn = sqlite3.connect(path, timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.ensure_schema()

    def close(self) -> None:
        self.conn.close()

    def ensure_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS worker_jobs (
              job_id TEXT PRIMARY KEY,
              type TEXT NOT NULL DEFAULT '',
              payload TEXT NOT NULL DEFAULT '{}',
              dry_run INTEGER NOT NULL DEFAULT 0,
              idempotency_key TEXT,
              status TEXT NOT NULL DEFAULT 'queued',
              result TEXT,
              artifact_uri TEXT,
              error TEXT,
              runtime TEXT,
              attempt INTEGER NOT NULL DEFAULT 0,
              plan_id TEXT,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS diagnosis_reports (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              worker_job_id TEXT,
              parent_report_id INTEGER,
              tier TEXT NOT NULL DEFAULT 'mid',
              status TEXT NOT NULL DEFAULT 'running',
              requested_by TEXT NOT NULL DEFAULT '',
              sources_used TEXT NOT NULL DEFAULT '[]',
              summary TEXT NOT NULL DEFAULT '{}',
              artifact_uri TEXT,
              error TEXT,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              model TEXT,
              title TEXT,
              tags TEXT NOT NULL DEFAULT '[]',
              deleted_at TEXT,
              progress TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS architecture_intent (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL DEFAULT '',
              target TEXT,
              params TEXT NOT NULL DEFAULT '{}',
              severity TEXT NOT NULL DEFAULT 'info',
              status TEXT NOT NULL DEFAULT 'draft'
            );
            """
        )
        self.conn.commit()

    def run(self, sql: str, **params: Any) -> list[tuple[Any, ...]]:
        normalized = " ".join(sql.strip().lower().split())
        if "from integrations" in normalized:
            return []
        if "from datasource_" in normalized:
            return []
        if "from architecture_intent" in normalized:
            return self._query("SELECT id, kind, target, params, severity FROM architecture_intent WHERE status='active'")
        if "from inventory_resources" in normalized:
            special = self._inventory_query(normalized, params)
            if special is not None:
                return special

        converted = self._convert_sql(sql)
        bound = {key: self._bind_value(value) for key, value in params.items()}
        cur = self.conn.execute(converted, bound)
        rows = cur.fetchall()
        self.conn.commit()
        return [tuple(row) for row in rows]

    def _inventory_query(self, normalized: str, params: dict[str, Any]) -> list[tuple[Any, ...]] | None:
        scope = str(params.get("scope") or "self")
        if "select resource_type, count(*) from inventory_resources" in normalized:
            return self._query(
                "SELECT resource_type, count(*) FROM inventory_resources WHERE account_id = ? GROUP BY resource_type ORDER BY 2 DESC",
                [scope],
            )
        if "select resource_id, region, data from inventory_resources" in normalized:
            return self._query(
                "SELECT resource_id, region, data FROM inventory_resources WHERE account_id = ? AND resource_type = ? ORDER BY resource_id LIMIT ?",
                [scope, params.get("rtype"), int(os.environ.get("DIAG_INV_PER_TYPE", "15"))],
            )
        if "select resource_id from inventory_resources" in normalized:
            return self._query(
                "SELECT resource_id FROM inventory_resources WHERE resource_type = 'ec2' AND account_id = 'self' LIMIT 50",
            )
        if "resource_type='ebs_volume'" in normalized and "data->>'state'" in normalized:
            rows = self._query(
                "SELECT data FROM inventory_resources WHERE account_id = ? AND resource_type = 'ebs_volume'",
                [scope],
            )
            count, gb, usd = 0, 0.0, 0.0
            prices = {"gp3": 0.0912, "gp2": 0.114, "io1": 0.125, "io2": 0.125, "st1": 0.045, "sc1": 0.025}
            for (raw,) in rows:
                data = self._json(raw)
                if data.get("state") != "available":
                    continue
                size = float(data.get("size") or 0)
                count += 1
                gb += size
                usd += size * prices.get(str(data.get("volume_type") or ""), 0.10)
            return [(count, gb, usd)]
        if "resource_type='ec2'" in normalized and "instance_state" in normalized:
            rows = self._query(
                "SELECT data FROM inventory_resources WHERE account_id = ? AND resource_type = 'ec2'",
                [scope],
            )
            stopped = sum(1 for (raw,) in rows if self._json(raw).get("instance_state") == "stopped")
            return [(stopped,)]
        return None

    def _query(self, sql: str, args: list[Any] | None = None) -> list[tuple[Any, ...]]:
        cur = self.conn.execute(sql, args or [])
        return [tuple(row) for row in cur.fetchall()]

    @staticmethod
    def _json(raw: Any) -> dict[str, Any]:
        if isinstance(raw, dict):
            return raw
        if not isinstance(raw, str):
            return {}
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except ValueError:
            return {}

    @staticmethod
    def _bind_value(value: Any) -> Any:
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False, default=str)
        return value

    @staticmethod
    def _convert_sql(sql: str) -> str:
        sql = re.sub(r"::[A-Za-z_][A-Za-z0-9_]*(\[\])?", "", sql)
        sql = sql.replace("now()", "CURRENT_TIMESTAMP")
        return sql


def artifact_path(report_id: int) -> Path:
    path = ROOT / "data" / "diagnosis" / f"{report_id}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def set_job(conn: LocalSqliteConn, job_id: str, status: str, result: dict[str, Any] | None = None, error: str | None = None) -> None:
    conn.conn.execute(
        "UPDATE worker_jobs SET status = ?, result = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?",
        (status, json.dumps(result or {}, ensure_ascii=False), error, job_id),
    )
    conn.conn.commit()


def fail_report_direct(conn: LocalSqliteConn, report_id: int, error: str) -> None:
    conn.conn.execute(
        "UPDATE diagnosis_reports SET status = 'failed', error = ? WHERE id = ? AND status = 'running'",
        (error, report_id),
    )
    conn.conn.commit()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run local SQLite-backed AI diagnosis")
    parser.add_argument("--db", default=str(ROOT / "data/awsops.db"))
    parser.add_argument("--report-id", required=True, type=int)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--account", default="local")
    parser.add_argument("--scope", default="self")
    parser.add_argument("--tier", default="mid")
    parser.add_argument("--model", default="sonnet")
    parser.add_argument("--requested-by", default="local")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    conn = LocalSqliteConn(Path(args.db).resolve())
    try:
        from diagnosis import db as ddb  # noqa: PLC0415
        from diagnosis import report as rpt  # noqa: PLC0415
    except ModuleNotFoundError as exc:
        missing = exc.name or "dependency"
        message = (
            f"Missing Python dependency: {missing}. Run: "
            "python3 -m pip install -r scripts/v2/workers/requirements.txt"
        )
        print(message, file=sys.stderr)
        fail_report_direct(conn, args.report_id, message)
        set_job(conn, args.job_id, "failed", error=message)
        conn.close()
        return 2
    try:
        set_job(conn, args.job_id, "running")
        on_progress = lambda c, t, s, p: ddb.update_progress(conn, args.report_id, c, t, s, p)
        md, summary, sources_used = rpt.generate(
            conn,
            args.account,
            args.tier,
            report_id=args.report_id,
            on_progress=on_progress,
            model=args.model,
            scope=args.scope,
        )
        path = artifact_path(args.report_id)
        path.write_text(md, encoding="utf-8")
        try:
            meta = rpt.make_title_and_tags(md)
        except Exception:  # noqa: BLE001
            meta = {"title": None, "tags": []}
        status = "partial" if summary.get("degraded") else "succeeded"
        ddb.finish_report(
            conn,
            args.report_id,
            status=status,
            sources_used=sources_used,
            summary=summary,
            artifact_uri=path.as_uri(),
            title=meta.get("title"),
            tags=meta.get("tags") or [],
        )
        set_job(conn, args.job_id, status, {"report_id": args.report_id, "artifact_uri": path.as_uri()})
        print(json.dumps({"status": status, "report_id": args.report_id, "artifact_uri": path.as_uri()}, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(traceback.format_exc(), file=sys.stderr)
        try:
            ddb.finish_report(conn, args.report_id, status="failed", error=str(exc))
            set_job(conn, args.job_id, "failed", error=str(exc))
        except Exception:  # noqa: BLE001
            pass
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
