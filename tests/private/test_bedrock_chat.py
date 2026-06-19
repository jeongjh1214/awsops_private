import json
import unittest

from agent.private_runtime.bedrock_chat import (
    format_bedrock_error,
    resolve_bedrock_model_id,
    stream_anthropic_response,
)


class FakeBedrockClient:
    def __init__(self):
        self.calls = []

    def invoke_model_with_response_stream(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "body": [
                {
                    "chunk": {
                        "bytes": json.dumps({
                            "type": "message_start",
                            "message": {"usage": {"input_tokens": 11}},
                        }).encode("utf-8")
                    }
                },
                {
                    "chunk": {
                        "bytes": json.dumps({
                            "type": "content_block_delta",
                            "delta": {"text": "hello"},
                        }).encode("utf-8")
                    }
                },
                {
                    "chunk": {
                        "bytes": json.dumps({
                            "type": "message_delta",
                            "usage": {"output_tokens": 7},
                        }).encode("utf-8")
                    }
                },
            ]
        }


class BedrockChatTests(unittest.TestCase):
    def test_configured_model_id_wins_over_request_model(self):
        self.assertEqual(
            resolve_bedrock_model_id("anthropic.configured-model", "opus-4.6"),
            "anthropic.configured-model",
        )

    def test_request_model_alias_is_fallback_when_config_is_empty(self):
        self.assertEqual(
            resolve_bedrock_model_id("", "sonnet-4.6"),
            "global.anthropic.claude-sonnet-4-6",
        )

    def test_stream_invokes_bedrock_with_resolved_model_id_and_payload(self):
        client = FakeBedrockClient()
        deltas = []

        result = stream_anthropic_response(
            client,
            model_id="anthropic.configured-model",
            messages=[{"role": "user", "content": "비용 현황 알려줘"}],
            on_delta=deltas.append,
        )

        self.assertEqual(client.calls[0]["modelId"], "anthropic.configured-model")
        body = json.loads(client.calls[0]["body"].decode("utf-8"))
        self.assertEqual(body["messages"], [{"role": "user", "content": "비용 현황 알려줘"}])
        self.assertEqual(deltas, ["hello"])
        self.assertEqual(result["content"], "hello")
        self.assertEqual(result["inputTokens"], 11)
        self.assertEqual(result["outputTokens"], 7)

    def test_unknown_operation_error_points_to_runtime_endpoint(self):
        error = format_bedrock_error(
            Exception(
                "An error occured 404 when calling the invokemodelwithresponsestream operation: "
                "<UnknownOperationException>"
            ),
            "https://vpce-12345.bedrock.ap-northeast-2.vpce.amazonaws.com",
        )

        self.assertIn("bedrock-runtime", error)
        self.assertIn("endpointUrls[\"bedrock-runtime\"]", error)
        self.assertIn("vpce-12345.bedrock.ap-northeast-2.vpce.amazonaws.com", error)


if __name__ == "__main__":
    unittest.main()
