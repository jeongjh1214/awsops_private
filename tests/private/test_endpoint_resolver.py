import unittest

from agent.private_runtime.config import EnvironmentConfig
from agent.private_runtime.endpoint_resolver import EndpointResolver


class EndpointResolverTests(unittest.TestCase):
    def test_explicit_mode_returns_configured_url(self):
        env = EnvironmentConfig(
            network_mode="external-explicit-vpce",
            endpoint_mode="explicit",
            bedrock_profile="bedrock-dev",
            endpoint_urls={"sts": "https://vpce-sts.example"},
            required_endpoints=["sts"],
        )
        resolver = EndpointResolver(env)

        self.assertEqual(resolver.url_for("sts"), "https://vpce-sts.example")

    def test_explicit_mode_fails_when_url_missing(self):
        env = EnvironmentConfig(
            network_mode="external-explicit-vpce",
            endpoint_mode="explicit",
            bedrock_profile="bedrock-dev",
            endpoint_urls={},
            required_endpoints=["sts"],
        )
        resolver = EndpointResolver(env)

        with self.assertRaisesRegex(ValueError, "Missing explicit endpoint URL for sts"):
            resolver.url_for("sts")

    def test_private_dns_returns_none(self):
        env = EnvironmentConfig(
            network_mode="vpc-private-dns",
            endpoint_mode="privateDns",
            bedrock_profile="bedrock-prod",
            endpoint_urls={"sts": "https://ignored.example"},
            required_endpoints=["sts"],
        )
        resolver = EndpointResolver(env)

        self.assertIsNone(resolver.url_for("sts"))

    def test_hybrid_uses_override_when_present(self):
        env = EnvironmentConfig(
            network_mode="vpc-hybrid",
            endpoint_mode="hybrid",
            bedrock_profile="bedrock-prod",
            endpoint_urls={"bedrock-runtime": "https://vpce-bedrock.example"},
            required_endpoints=["bedrock-runtime", "sts"],
        )
        resolver = EndpointResolver(env)

        self.assertEqual(resolver.url_for("bedrock-runtime"), "https://vpce-bedrock.example")
        self.assertIsNone(resolver.url_for("sts"))


if __name__ == "__main__":
    unittest.main()
