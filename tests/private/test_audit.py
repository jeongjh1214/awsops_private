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

    def test_redacts_common_secret_key_shapes_recursively(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audit.jsonl"
            logger = AuditLogger(path)

            logger.record(
                event="tool_call",
                route="network",
                service="sts",
                account_id=None,
                status="success",
                duration_ms=7,
                detail={
                    "aws_secret_access_key": "do-not-log",
                    "api_token": "do-not-log",
                    "access-token": "do-not-log",
                    "nested": [
                        {"session_token": "do-not-log"},
                        {"x-amz-security-token": "do-not-log"},
                    ],
                    "safe": {"resultCount": 3},
                },
            )

            detail = json.loads(path.read_text(encoding="utf-8").strip())["detail"]
            self.assertEqual(detail["aws_secret_access_key"], "[REDACTED]")
            self.assertEqual(detail["api_token"], "[REDACTED]")
            self.assertEqual(detail["access-token"], "[REDACTED]")
            self.assertEqual(detail["nested"][0]["session_token"], "[REDACTED]")
            self.assertEqual(detail["nested"][1]["x-amz-security-token"], "[REDACTED]")
            self.assertEqual(detail["safe"]["resultCount"], 3)

    def test_preserves_unicode_creates_parent_directory_and_appends_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "audit.jsonl"
            logger = AuditLogger(path)

            logger.record(
                event="tool_call",
                route="network",
                service="ec2",
                account_id="123456789012",
                status="success",
                duration_ms=12,
                detail={"message": "서울"},
            )
            logger.record(
                event="tool_call",
                route="network",
                service="s3",
                account_id="123456789012",
                status="error",
                duration_ms=34,
                detail={"password": "do-not-log"},
            )

            text = path.read_text(encoding="utf-8")
            rows = [json.loads(line) for line in text.splitlines()]
            self.assertIn("서울", text)
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["detail"]["message"], "서울")
            self.assertEqual(rows[1]["detail"]["password"], "[REDACTED]")


if __name__ == "__main__":
    unittest.main()
