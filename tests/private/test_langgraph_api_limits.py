from pathlib import Path
import unittest


class LangGraphApiLimitTests(unittest.TestCase):
    def test_chat_endpoint_has_bounded_body_and_message_limits(self):
        source = Path("agent/langgraph_api.py").read_text(encoding="utf-8")

        self.assertIn("MAX_CHAT_BODY_BYTES = 512_000", source)
        self.assertIn("MAX_CHAT_MESSAGES = 50", source)
        self.assertIn("MAX_CHAT_MESSAGE_CHARS = 50_000", source)
        self.assertIn("MAX_CHAT_TOTAL_CHARS = 200_000", source)
        self.assertIn("async for chunk in request.stream()", source)
        self.assertIn("ChatRequest.model_validate_json", source)
        self.assertIn("status_code=413", source)


if __name__ == "__main__":
    unittest.main()
