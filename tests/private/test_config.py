import json
import tempfile
import unittest
from pathlib import Path

from agent.private_runtime.config import load_private_config


class PrivateConfigTests(unittest.TestCase):
    def write_config(self, payload):
        tmp = tempfile.TemporaryDirectory()
        path = Path(tmp.name) / "config.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        self.addCleanup(tmp.cleanup)
        return path

    def test_loads_active_environment(self):
        path = self.write_config({
            "activeEnvironment": "dev",
            "environments": {
                "dev": {
                    "networkMode": "external-explicit-vpce",
                    "endpointMode": "explicit",
                    "bedrockProfile": "bedrock-dev",
                    "endpointUrls": {"sts": "https://vpce-sts.example"},
                    "requiredEndpoints": ["sts"]
                }
            },
            "agent": {
                "provider": "local-mcp-langgraph",
                "modelId": "anthropic.claude-sonnet-4-6",
                "maxConcurrentBedrockCalls": 3,
                "maxConcurrentAwsCalls": 8,
                "maxConcurrentSteampipeQueries": 5,
                "toolTimeoutMs": 30000,
                "queryCacheTtlSec": 300,
                "maxToolResultBytes": 200000
            },
            "queryPolicy": {
                "enabledServices": ["ec2", "s3", "iam"]
            },
        })

        cfg = load_private_config(path)

        self.assertEqual(cfg.active_environment_name, "dev")
        self.assertEqual(cfg.environment.bedrock_profile, "bedrock-dev")
        self.assertEqual(cfg.environment.endpoint_urls["sts"], "https://vpce-sts.example")
        self.assertEqual(cfg.agent.provider, "local-mcp-langgraph")
        self.assertEqual(cfg.enabled_query_services, ("ec2", "s3", "iam"))

    def test_missing_bedrock_profile_fails(self):
        path = self.write_config({
            "activeEnvironment": "dev",
            "environments": {
                "dev": {
                    "networkMode": "external-explicit-vpce",
                    "endpointMode": "explicit",
                    "bedrockProfile": "",
                    "endpointUrls": {},
                    "requiredEndpoints": ["sts"]
                }
            }
        })

        with self.assertRaisesRegex(ValueError, "bedrockProfile"):
            load_private_config(path)

    def test_explicit_mode_requires_endpoint_urls(self):
        path = self.write_config({
            "activeEnvironment": "dev",
            "environments": {
                "dev": {
                    "networkMode": "external-explicit-vpce",
                    "endpointMode": "explicit",
                    "bedrockProfile": "bedrock-dev",
                    "endpointUrls": {},
                    "requiredEndpoints": ["sts"]
                }
            }
        })

        with self.assertRaisesRegex(ValueError, "missing endpointUrls"):
            load_private_config(path)


if __name__ == "__main__":
    unittest.main()
