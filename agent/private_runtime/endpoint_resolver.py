from __future__ import annotations

from agent.private_runtime.config import EnvironmentConfig


class EndpointResolver:
    def __init__(self, environment: EnvironmentConfig):
        self.environment = environment

    def url_for(self, service: str) -> str | None:
        mode = self.environment.endpoint_mode
        configured = self.environment.endpoint_urls.get(service)
        if mode == "explicit":
            return configured
        if mode == "hybrid" and configured:
            return configured
        return None
