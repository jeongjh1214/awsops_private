from __future__ import annotations

import asyncio

from agent.private_runtime.config import AgentConfig


def _positive_limit(name: str, value: int) -> int:
    if value < 1:
        raise ValueError(f"{name} must be >= 1")
    return value


class RuntimeLimits:
    def __init__(self, config: AgentConfig):
        self.bedrock = asyncio.Semaphore(
            _positive_limit(
                "max_concurrent_bedrock_calls",
                config.max_concurrent_bedrock_calls,
            )
        )
        self.aws = asyncio.Semaphore(
            _positive_limit(
                "max_concurrent_aws_calls",
                config.max_concurrent_aws_calls,
            )
        )
        self.steampipe = asyncio.Semaphore(
            _positive_limit(
                "max_concurrent_steampipe_queries",
                config.max_concurrent_steampipe_queries,
            )
        )
        self.slow = asyncio.Semaphore(2)
