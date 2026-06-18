from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from contextlib import suppress
from typing import Any

import pg8000
from mcp.server.fastmcp import FastMCP

from agent.private_runtime.audit import AuditLogger
from agent.private_runtime.config import load_private_config
from agent.private_runtime.limits import RuntimeLimits


mcp = FastMCP("awsops-private")
config = load_private_config(os.environ.get("AWSOPS_CONFIG", "data/config.json"))
limits = RuntimeLimits(config.agent)
audit = AuditLogger()

MAX_STEAMPIPE_ROWS = 1000


def _select_only(sql: str) -> None:
    # Scaffold guard only; pair this with read-only Steampipe/Postgres credentials.
    first = sql.strip().split(None, 1)[0].lower() if sql.strip() else ""
    if first != "select":
        raise ValueError("Only SELECT statements are allowed")
    blocked = {"insert", "update", "delete", "drop", "alter", "truncate", "create"}
    tokens = {token.strip(" ;\n\t").lower() for token in sql.replace(",", " ").split()}
    found = sorted(blocked & tokens)
    if found:
        raise ValueError(f"Blocked SQL keyword: {found[0]}")


def _validate_max_rows(max_rows: int) -> None:
    if not isinstance(max_rows, int) or isinstance(max_rows, bool):
        raise ValueError("max_rows must be an integer")
    if max_rows < 1 or max_rows > MAX_STEAMPIPE_ROWS:
        raise ValueError(f"max_rows must be between 1 and {MAX_STEAMPIPE_ROWS}")


def _validate_result_size(result: dict[str, Any]) -> None:
    encoded = json.dumps(result, ensure_ascii=False).encode("utf-8")
    if len(encoded) > config.agent.max_tool_result_bytes:
        raise ValueError("Tool result exceeds max_tool_result_bytes")


def _steampipe_connection():
    return pg8000.connect(
        host=os.environ.get("STEAMPIPE_HOST", "127.0.0.1"),
        port=int(os.environ.get("STEAMPIPE_PORT", "9193")),
        database=os.environ.get("STEAMPIPE_DB", "steampipe"),
        user=os.environ.get("STEAMPIPE_USER", "steampipe"),
        password=os.environ.get("STEAMPIPE_PASSWORD", ""),
        timeout=10,
    )


@mcp.tool()
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "activeEnvironment": config.active_environment_name,
        "agentProvider": config.agent.provider,
        "endpointMode": config.environment.endpoint_mode,
    }


@mcp.tool()
async def run_steampipe_query(sql: str, max_rows: int = 100) -> dict[str, Any]:
    started = time.time()
    status = "success"
    try:
        _select_only(sql)
        _validate_max_rows(max_rows)
        async with limits.steampipe:
            def run_query():
                conn = None
                cur = None
                try:
                    conn = _steampipe_connection()
                    cur = conn.cursor()
                    cur.execute(sql)
                    columns = [item[0] for item in cur.description] if cur.description else []
                    rows = [dict(zip(columns, row)) for row in cur.fetchmany(max_rows)]
                    result = {"columns": columns, "rows": rows, "rowCount": len(rows)}
                    _validate_result_size(result)
                    return result
                finally:
                    if cur is not None:
                        with suppress(Exception):
                            cur.close()
                    if conn is not None:
                        with suppress(Exception):
                            conn.close()

            return await asyncio.to_thread(run_query)
    except Exception:
        status = "error"
        raise
    finally:
        audit.record(
            event="tool_call",
            route="steampipe",
            service="steampipe",
            account_id=None,
            status=status,
            duration_ms=int((time.time() - started) * 1000),
            detail={"sqlPreview": sql[:160]},
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--transport", default="stdio", choices=["stdio", "sse"])
    args = parser.parse_args()
    mcp.run(transport=args.transport)


if __name__ == "__main__":
    main()
