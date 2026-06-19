from __future__ import annotations

from functools import lru_cache
import boto3
from botocore.config import Config

from agent.private_runtime.config import PrivateConfig
from agent.private_runtime.endpoint_resolver import EndpointResolver


CLIENT_CONFIG = Config(
    connect_timeout=5,
    read_timeout=90,
    retries={"max_attempts": 2, "mode": "standard"},
)


@lru_cache(maxsize=32)
def _session(profile_name: str | None, region_name: str):
    if profile_name:
        return boto3.Session(profile_name=profile_name, region_name=region_name)
    return boto3.Session(region_name=region_name)


@lru_cache(maxsize=128)
def _client(profile_name: str | None, region_name: str, service: str, endpoint_url: str | None):
    session = _session(profile_name, region_name)
    kwargs = {"region_name": region_name, "config": CLIENT_CONFIG}
    if endpoint_url:
        kwargs["endpoint_url"] = endpoint_url
    return session.client(service, **kwargs)


class AwsClientFactory:
    def __init__(self, config: PrivateConfig, region_name: str = "ap-northeast-2"):
        self.config = config
        self.region_name = region_name
        self.resolver = EndpointResolver(config.environment)

    def bedrock_runtime(self):
        endpoint_url = self.resolver.url_for("bedrock-runtime")
        return _client(
            self.config.environment.bedrock_profile,
            self.region_name,
            "bedrock-runtime",
            endpoint_url,
        )

    def bedrock_runtime_context(self) -> dict[str, str | None]:
        return {
            "profile": self.config.environment.bedrock_profile,
            "region": self.region_name,
            "endpointMode": self.config.environment.endpoint_mode,
            "endpointUrl": self.resolver.url_for("bedrock-runtime"),
        }

    def service_client(self, service: str):
        endpoint_url = self.resolver.url_for(service)
        profile_name = self.config.environment.aws_profile
        return _client(profile_name, self.region_name, service, endpoint_url)
