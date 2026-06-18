from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any


SECRET_KEYS = {
    "secret",
    "secretkey",
    "secretaccesskey",
    "password",
    "token",
    "sessiontoken",
    "authorization",
}


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key.lower() in SECRET_KEYS:
                result[key] = "[REDACTED]"
            else:
                result[key] = _redact(item)
        return result
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


class AuditLogger:
    def __init__(self, path: str | Path = "data/private-agent/audit.jsonl"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def record(
        self,
        *,
        event: str,
        route: str,
        service: str,
        account_id: str | None,
        status: str,
        duration_ms: int,
        detail: dict[str, Any] | None = None,
    ) -> None:
        row = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "route": route,
            "service": service,
            "accountId": account_id,
            "status": status,
            "durationMs": duration_ms,
            "detail": _redact(detail or {}),
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
