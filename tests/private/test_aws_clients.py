import importlib
import sys
import types
import unittest
from unittest.mock import patch

from agent.private_runtime.config import AgentConfig, EnvironmentConfig, PrivateConfig


class FakeSession:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.client_calls = []

    def client(self, service, **kwargs):
        client = {"service": service, "kwargs": kwargs, "session": self}
        self.client_calls.append(client)
        return client


class FakeBoto3(types.SimpleNamespace):
    def __init__(self):
        super().__init__()
        self.sessions = []

    def Session(self, **kwargs):
        session = FakeSession(**kwargs)
        self.sessions.append(session)
        return session


class FakeBotocoreConfig:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class AwsClientFactoryTests(unittest.TestCase):
    def setUp(self):
        self.fake_boto3 = FakeBoto3()
        fake_botocore_config = types.SimpleNamespace(Config=FakeBotocoreConfig)
        with patch.dict(sys.modules, {"boto3": self.fake_boto3, "botocore.config": fake_botocore_config}):
            sys.modules.pop("agent.private_runtime.aws_clients", None)
            self.aws_clients = importlib.import_module("agent.private_runtime.aws_clients")
        self.addCleanup(sys.modules.pop, "agent.private_runtime.aws_clients", None)
        self.aws_clients._session.cache_clear()
        self.aws_clients._client.cache_clear()

    def config_for(self, env):
        return PrivateConfig(
            active_environment_name="test",
            environment=env,
            agent=AgentConfig(),
        )

    def test_bedrock_runtime_uses_bedrock_profile_and_endpoint_url(self):
        env = EnvironmentConfig(
            network_mode="external-explicit-vpce",
            endpoint_mode="explicit",
            bedrock_profile="bedrock-dev",
            endpoint_urls={"bedrock-runtime": "https://vpce-bedrock.example"},
        )
        factory = self.aws_clients.AwsClientFactory(self.config_for(env), region_name="ap-northeast-2")

        client = factory.bedrock_runtime()

        self.assertEqual(self.fake_boto3.sessions[0].kwargs, {
            "profile_name": "bedrock-dev",
            "region_name": "ap-northeast-2",
        })
        self.assertEqual(client["service"], "bedrock-runtime")
        self.assertEqual(client["kwargs"]["region_name"], "ap-northeast-2")
        self.assertEqual(client["kwargs"]["endpoint_url"], "https://vpce-bedrock.example")
        self.assertEqual(client["kwargs"]["config"].kwargs, {
            "connect_timeout": 5,
            "read_timeout": 90,
            "retries": {"max_attempts": 2, "mode": "standard"},
        })

    def test_service_client_uses_aws_profile_and_endpoint_url(self):
        env = EnvironmentConfig(
            network_mode="vpc-hybrid",
            endpoint_mode="hybrid",
            bedrock_profile="bedrock-prod",
            endpoint_urls={"sts": "https://vpce-sts.example"},
            aws_profile="aws-dev",
        )
        factory = self.aws_clients.AwsClientFactory(self.config_for(env), region_name="us-east-1")

        client = factory.service_client("sts")

        self.assertEqual(self.fake_boto3.sessions[0].kwargs, {
            "profile_name": "aws-dev",
            "region_name": "us-east-1",
        })
        self.assertEqual(client["service"], "sts")
        self.assertEqual(client["kwargs"]["region_name"], "us-east-1")
        self.assertEqual(client["kwargs"]["endpoint_url"], "https://vpce-sts.example")
        self.assertEqual(client["kwargs"]["config"].kwargs["connect_timeout"], 5)

    def test_private_dns_omits_endpoint_url(self):
        env = EnvironmentConfig(
            network_mode="vpc-private-dns",
            endpoint_mode="privateDns",
            bedrock_profile="bedrock-prod",
            endpoint_urls={"sts": "https://ignored.example"},
            aws_profile="aws-prod",
        )
        factory = self.aws_clients.AwsClientFactory(self.config_for(env), region_name="ap-northeast-2")

        client = factory.service_client("sts")

        self.assertEqual(client["kwargs"]["region_name"], "ap-northeast-2")
        self.assertNotIn("endpoint_url", client["kwargs"])
        self.assertEqual(client["kwargs"]["config"].kwargs["read_timeout"], 90)

    def test_explicit_missing_endpoint_fails_before_creating_client(self):
        env = EnvironmentConfig(
            network_mode="external-explicit-vpce",
            endpoint_mode="explicit",
            bedrock_profile="bedrock-prod",
            endpoint_urls={},
            aws_profile="aws-prod",
        )
        factory = self.aws_clients.AwsClientFactory(self.config_for(env), region_name="ap-northeast-2")

        with self.assertRaisesRegex(ValueError, "Missing explicit endpoint URL for sts"):
            factory.service_client("sts")

        self.assertEqual(self.fake_boto3.sessions, [])

    def test_equivalent_calls_reuse_cached_session_and_client(self):
        env = EnvironmentConfig(
            network_mode="vpc-hybrid",
            endpoint_mode="hybrid",
            bedrock_profile="bedrock-prod",
            endpoint_urls={"sts": "https://vpce-sts.example"},
            aws_profile="aws-prod",
        )
        factory = self.aws_clients.AwsClientFactory(self.config_for(env), region_name="ap-northeast-2")

        first = factory.service_client("sts")
        second = factory.service_client("sts")

        self.assertIs(first, second)
        self.assertEqual(len(self.fake_boto3.sessions), 1)
        self.assertEqual(len(self.fake_boto3.sessions[0].client_calls), 1)
        self.assertEqual(self.aws_clients._session.cache_info().hits, 0)
        self.assertEqual(self.aws_clients._client.cache_info().hits, 1)


if __name__ == "__main__":
    unittest.main()
