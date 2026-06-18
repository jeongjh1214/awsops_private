from __future__ import annotations

import asyncio

from agent.private_runtime.config import AgentConfig


class RuntimeLimits:
    def __init__(self, config: AgentConfig):
        self.bedrock = asyncio.Semaphore(config.max_concurrent_bedrock_calls)
        self.aws = asyncio.Semaphore(config.max_concurrent_aws_calls)
        self.steampipe = asyncio.Semaphore(config.max_concurrent_steampipe_queries)
        self.slow = asyncio.Semaphore(2)
