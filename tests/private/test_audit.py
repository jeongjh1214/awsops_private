import json
import tempfile
import unittest
from pathlib import Path

from agent.private_runtime.audit import AuditLogger


class AuditLoggerTests(unittest.TestCase):
    def test_writes_jsonl_event_without_secret_value(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audit.jsonl"
            logger = AuditLogger(path)

            logger.record(
                event="tool_call",
                route="network",
                service="ec2",
                account_id="123456789012",
                status="success",
                duration_ms=12,
                detail={"secretAccessKey": "do-not-log", "resultCount": 3},
            )

            row = json.loads(path.read_text(encoding="utf-8").strip())
            self.assertEqual(row["event"], "tool_call")
            self.assertEqual(row["detail"]["secretAccessKey"], "[REDACTED]")
            self.assertEqual(row["detail"]["resultCount"], 3)


if __name__ == "__main__":
    unittest.main()
