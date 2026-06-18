from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any


VALID_ENDPOINT_MODES = {"explicit", "privateDns", "hybrid"}
VALID_AGENT_PROVIDERS = {"agentcore", "local-mcp-langgraph"}


@dataclass(frozen=True)
class EnvironmentConfig:
    network_mode: str
    endpoint_mode: str
    bedrock_profile: str
    endpoint_urls: dict[str, str] = field(default_factory=dict)
    required_endpoints: list[str] = field(default_factory=lambda: ["bedrock-runtime", "sts"])
    aws_profile: str | None = None


@dataclass(frozen=True)
class AgentConfig:
    provider: str = "agentcore"
    model_id: str = "anthropic.claude-sonnet-4-6"
    langgraph_api_url: str = "http://127.0.0.1:7000"
    mcp_server_url: str = "http://127.0.0.1:7100"
    max_concurrent_bedrock_calls: int = 3
    max_concurrent_aws_calls: int = 8
    max_concurrent_steampipe_queries: int = 5
    tool_timeout_ms: int = 30000
    query_cache_ttl_sec: int = 300
    max_tool_result_bytes: int = 200000


@dataclass(frozen=True)
class PrivateConfig:
    active_environment_name: str
    environment: EnvironmentConfig
    agent: AgentConfig


def _agent_config(raw: dict[str, Any]) -> AgentConfig:
    provider = raw.get("provider", "agentcore")
    if provider not in VALID_AGENT_PROVIDERS:
        raise ValueError(f"agent.provider must be one of {sorted(VALID_AGENT_PROVIDERS)}")
    return AgentConfig(
        provider=provider,
        model_id=raw.get("modelId", "anthropic.claude-sonnet-4-6"),
        langgraph_api_url=raw.get("langgraphApiUrl", "http://127.0.0.1:7000"),
        mcp_server_url=raw.get("mcpServerUrl", "http://127.0.0.1:7100"),
        max_concurrent_bedrock_calls=int(raw.get("maxConcurrentBedrockCalls", 3)),
        max_concurrent_aws_calls=int(raw.get("maxConcurrentAwsCalls", 8)),
        max_concurrent_steampipe_queries=int(raw.get("maxConcurrentSteampipeQueries", 5)),
        tool_timeout_ms=int(raw.get("toolTimeoutMs", 30000)),
        query_cache_ttl_sec=int(raw.get("queryCacheTtlSec", 300)),
        max_tool_result_bytes=int(raw.get("maxToolResultBytes", 200000)),
    )


def _environment_config(name: str, raw: dict[str, Any]) -> EnvironmentConfig:
    endpoint_mode = raw.get("endpointMode", "privateDns")
    if endpoint_mode not in VALID_ENDPOINT_MODES:
        raise ValueError(f"environments.{name}.endpointMode must be one of {sorted(VALID_ENDPOINT_MODES)}")

    bedrock_profile = raw.get("bedrockProfile", "")
    if not bedrock_profile:
        raise ValueError(f"environments.{name}.bedrockProfile is required")

    endpoint_urls = dict(raw.get("endpointUrls") or {})
    required_endpoints = list(raw.get("requiredEndpoints") or ["bedrock-runtime", "sts"])
    if endpoint_mode == "explicit":
        missing = [service for service in required_endpoints if not endpoint_urls.get(service)]
        if missing:
            raise ValueError(f"environments.{name} missing endpointUrls for: {', '.join(missing)}")

    return EnvironmentConfig(
        network_mode=raw.get("networkMode", "vpc-private-dns"),
        endpoint_mode=endpoint_mode,
        bedrock_profile=bedrock_profile,
        endpoint_urls=endpoint_urls,
        required_endpoints=required_endpoints,
        aws_profile=raw.get("awsProfile") or None,
    )


def load_private_config(path: str | Path = "data/config.json") -> PrivateConfig:
    config_path = Path(path)
    data = json.loads(config_path.read_text(encoding="utf-8"))
    active = data.get("activeEnvironment", "dev")
    environments = data.get("environments") or {}
    if active not in environments:
        raise ValueError(f"activeEnvironment {active!r} not found in environments")
    env = _environment_config(active, environments[active])
    agent = _agent_config(data.get("agent") or {})
    return PrivateConfig(active_environment_name=active, environment=env, agent=agent)
