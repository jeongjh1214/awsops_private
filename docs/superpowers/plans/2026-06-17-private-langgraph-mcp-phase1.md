# Private LangGraph MCP Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AgentCore-dependent AI path with a local private foundation that supports config-driven VPCE endpoints, a required Bedrock AWS profile, a Python MCP server scaffold, and a LangGraph API scaffold.

**Architecture:** Phase 1 keeps the existing Next.js dashboard and Steampipe pages intact while adding a private Python agent runtime beside it. Next.js `/awsops/api/ai` becomes a thin adapter that can call the local LangGraph API when enabled, while the Python side owns endpoint resolution, Bedrock profile usage, MCP tool execution limits, health checks, and audit records. Public CloudFront/Cognito removal is planned as infrastructure work in this phase, but no AWS resources are created.

**Tech Stack:** Next.js 14, TypeScript, Python 3.12, boto3, FastAPI, Uvicorn, LangGraph, MCP Python SDK, unittest, existing Steampipe PostgreSQL.

---

## File Structure

Create Python private runtime modules:

- `agent/private_runtime/__init__.py`: package marker.
- `agent/private_runtime/config.py`: load and validate `data/config.json` for active environment, endpoints, and concurrency.
- `agent/private_runtime/endpoint_resolver.py`: resolve AWS service endpoint URLs based on `explicit`, `privateDns`, or `hybrid` mode.
- `agent/private_runtime/aws_clients.py`: cached boto3 sessions and clients with mandatory Bedrock profile support.
- `agent/private_runtime/limits.py`: named asyncio semaphores for Bedrock, AWS, Steampipe, and slow tools.
- `agent/private_runtime/audit.py`: structured JSONL audit writer.
- `agent/private_runtime/health.py`: startup health checks for config, STS, Bedrock profile, and Steampipe.
- `agent/mcp_server.py`: local MCP server scaffold with health and Steampipe SELECT tool.
- `agent/langgraph_api.py`: FastAPI service that streams responses and calls MCP tools through a local adapter.
- `agent/requirements-private.txt`: private runtime dependencies.

Create tests:

- `tests/private/test_config.py`
- `tests/private/test_endpoint_resolver.py`
- `tests/private/test_limits.py`
- `tests/private/test_audit.py`

Modify TypeScript config and API files:

- `src/lib/app-config.ts`: add private environment and agent config types.
- `src/app/api/ai/route.ts`: add local LangGraph adapter path controlled by config.
- `src/app/api/agentcore/route.ts`: leave existing route functional for now, but make it report local private agent config when `agent.provider === "local-mcp-langgraph"`.

Modify infrastructure files:

- `infra-cdk/lib/awsops-stack.ts`: add parameters/context for internal ALB mode and disable VPCE creation by default for private mode.
- `infra-cdk/bin/app.ts`: gate CognitoStack creation behind context.
- `infra-cdk/README.md`: document private deployment contexts.

Create scripts:

- `scripts/13-start-private-agent.sh`: start local MCP and LangGraph services.
- `scripts/13-verify-private-agent.sh`: run local health checks.

Do not modify `.github/workflows`. The private branch intentionally omits workflow files.

---

### Task 1: Add Private Config Schema In TypeScript

**Files:**
- Modify: `src/lib/app-config.ts`
- Test: use `npm run build`

- [ ] **Step 1: Add TypeScript interfaces**

In `src/lib/app-config.ts`, after `AccountConfig`, add:

```ts
export type EndpointMode = 'explicit' | 'privateDns' | 'hybrid';
export type NetworkMode = 'external-explicit-vpce' | 'vpc-private-dns' | 'vpc-hybrid';

export interface PrivateEnvironmentConfig {
  networkMode: NetworkMode;
  endpointMode: EndpointMode;
  bedrockProfile: string;
  endpointUrls?: Record<string, string>;
  requiredEndpoints?: string[];
  awsProfile?: string;
}

export interface PrivateAgentConfig {
  provider: 'agentcore' | 'local-mcp-langgraph';
  modelId: string;
  langgraphApiUrl?: string;
  mcpServerUrl?: string;
  maxConcurrentBedrockCalls: number;
  maxConcurrentAwsCalls: number;
  maxConcurrentSteampipeQueries: number;
  toolTimeoutMs: number;
  queryCacheTtlSec: number;
  maxToolResultBytes: number;
}
```

- [ ] **Step 2: Extend `AppConfig`**

In `src/lib/app-config.ts`, add these fields to `AppConfig`:

```ts
  activeEnvironment?: string;
  environments?: Record<string, PrivateEnvironmentConfig>;
  agent?: PrivateAgentConfig;
```

- [ ] **Step 3: Extend `DEFAULT_CONFIG`**

In `src/lib/app-config.ts`, extend `DEFAULT_CONFIG`:

```ts
  activeEnvironment: 'dev',
  environments: {
    dev: {
      networkMode: 'external-explicit-vpce',
      endpointMode: 'explicit',
      bedrockProfile: '',
      endpointUrls: {},
      requiredEndpoints: ['bedrock-runtime', 'sts'],
    },
    prod: {
      networkMode: 'vpc-private-dns',
      endpointMode: 'privateDns',
      bedrockProfile: '',
      endpointUrls: {},
      requiredEndpoints: ['bedrock-runtime', 'sts'],
    },
  },
  agent: {
    provider: 'agentcore',
    modelId: 'anthropic.claude-sonnet-4-6',
    langgraphApiUrl: 'http://127.0.0.1:7000',
    mcpServerUrl: 'http://127.0.0.1:7100',
    maxConcurrentBedrockCalls: 3,
    maxConcurrentAwsCalls: 8,
    maxConcurrentSteampipeQueries: 5,
    toolTimeoutMs: 30000,
    queryCacheTtlSec: 300,
    maxToolResultBytes: 200000,
  },
```

Expected behavior: existing installs still use `provider: 'agentcore'` unless config changes it.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: build completes or fails only on pre-existing unrelated upstream issues. If it fails because of the new interfaces, fix `src/lib/app-config.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/app-config.ts
git commit -m "feat: add private runtime config schema"
```

---

### Task 2: Add Python Config Loader

**Files:**
- Create: `agent/private_runtime/__init__.py`
- Create: `agent/private_runtime/config.py`
- Create: `tests/private/test_config.py`

- [ ] **Step 1: Create package marker**

Create `agent/private_runtime/__init__.py`:

```python
"""Private AWSops runtime helpers."""
```

- [ ] **Step 2: Write failing config tests**

Create `tests/private/test_config.py`:

```python
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
            }
        })

        cfg = load_private_config(path)

        self.assertEqual(cfg.active_environment_name, "dev")
        self.assertEqual(cfg.environment.bedrock_profile, "bedrock-dev")
        self.assertEqual(cfg.environment.endpoint_urls["sts"], "https://vpce-sts.example")
        self.assertEqual(cfg.agent.provider, "local-mcp-langgraph")

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
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
python3 -m unittest tests.private.test_config -v
```

Expected: FAIL with `ModuleNotFoundError` or missing `load_private_config`.

- [ ] **Step 4: Implement config loader**

Create `agent/private_runtime/config.py`:

```python
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
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
python3 -m unittest tests.private.test_config -v
```

Expected: PASS with 3 tests.

- [ ] **Step 6: Commit**

```bash
git add agent/private_runtime/__init__.py agent/private_runtime/config.py tests/private/test_config.py
git commit -m "feat: add private runtime config loader"
```

---

### Task 3: Add Endpoint Resolver And Boto3 Client Factory

**Files:**
- Create: `agent/private_runtime/endpoint_resolver.py`
- Create: `agent/private_runtime/aws_clients.py`
- Create: `tests/private/test_endpoint_resolver.py`

- [ ] **Step 1: Write endpoint resolver tests**

Create `tests/private/test_endpoint_resolver.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python3 -m unittest tests.private.test_endpoint_resolver -v
```

Expected: FAIL with missing `EndpointResolver`.

- [ ] **Step 3: Implement endpoint resolver**

Create `agent/private_runtime/endpoint_resolver.py`:

```python
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
```

- [ ] **Step 4: Implement boto3 client factory**

Create `agent/private_runtime/aws_clients.py`:

```python
from __future__ import annotations

from functools import lru_cache
import boto3

from agent.private_runtime.config import PrivateConfig
from agent.private_runtime.endpoint_resolver import EndpointResolver


@lru_cache(maxsize=32)
def _session(profile_name: str | None, region_name: str):
    if profile_name:
        return boto3.Session(profile_name=profile_name, region_name=region_name)
    return boto3.Session(region_name=region_name)


@lru_cache(maxsize=128)
def _client(profile_name: str | None, region_name: str, service: str, endpoint_url: str | None):
    session = _session(profile_name, region_name)
    kwargs = {"region_name": region_name}
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

    def service_client(self, service: str):
        endpoint_url = self.resolver.url_for(service)
        profile_name = self.config.environment.aws_profile
        return _client(profile_name, self.region_name, service, endpoint_url)
```

- [ ] **Step 5: Run endpoint tests**

Run:

```bash
python3 -m unittest tests.private.test_endpoint_resolver -v
```

Expected: PASS with 3 tests.

- [ ] **Step 6: Commit**

```bash
git add agent/private_runtime/endpoint_resolver.py agent/private_runtime/aws_clients.py tests/private/test_endpoint_resolver.py
git commit -m "feat: add vpce endpoint resolver"
```

---

### Task 4: Add Concurrency Limits And Audit Logging

**Files:**
- Create: `agent/private_runtime/limits.py`
- Create: `agent/private_runtime/audit.py`
- Create: `tests/private/test_limits.py`
- Create: `tests/private/test_audit.py`

- [ ] **Step 1: Write limits test**

Create `tests/private/test_limits.py`:

```python
import asyncio
import unittest

from agent.private_runtime.config import AgentConfig
from agent.private_runtime.limits import RuntimeLimits


class RuntimeLimitsTests(unittest.TestCase):
    def test_steampipe_limit_blocks_extra_work(self):
        async def scenario():
            limits = RuntimeLimits(AgentConfig(max_concurrent_steampipe_queries=1))
            entered = []

            async def work(name):
                async with limits.steampipe:
                    entered.append(name)
                    await asyncio.sleep(0.05)

            first = asyncio.create_task(work("first"))
            await asyncio.sleep(0.01)
            second = asyncio.create_task(work("second"))
            await asyncio.gather(first, second)
            return entered

        self.assertEqual(asyncio.run(scenario()), ["first", "second"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Write audit test**

Create `tests/private/test_audit.py`:

```python
import json
import tempfile
import unittest
from pathlib import Path

from agent.private_runtime.audit import AuditLogger


class AuditLoggerTests(unittest.TestCase):
    def test_writes_jsonl_event_without_secret_value(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audit.jsonl"
            logger = AuditLogger(path)

            logger.record(
                event="tool_call",
                route="network",
                service="ec2",
                account_id="123456789012",
                status="success",
                duration_ms=12,
                detail={"secretAccessKey": "do-not-log", "resultCount": 3},
            )

            row = json.loads(path.read_text(encoding="utf-8").strip())
            self.assertEqual(row["event"], "tool_call")
            self.assertEqual(row["detail"]["secretAccessKey"], "[REDACTED]")
            self.assertEqual(row["detail"]["resultCount"], 3)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
python3 -m unittest tests.private.test_limits tests.private.test_audit -v
```

Expected: FAIL with missing modules.

- [ ] **Step 4: Implement limits**

Create `agent/private_runtime/limits.py`:

```python
from __future__ import annotations

import asyncio

from agent.private_runtime.config import AgentConfig


class RuntimeLimits:
    def __init__(self, config: AgentConfig):
        self.bedrock = asyncio.Semaphore(config.max_concurrent_bedrock_calls)
        self.aws = asyncio.Semaphore(config.max_concurrent_aws_calls)
        self.steampipe = asyncio.Semaphore(config.max_concurrent_steampipe_queries)
        self.slow = asyncio.Semaphore(2)
```

- [ ] **Step 5: Implement audit logger**

Create `agent/private_runtime/audit.py`:

```python
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any


SECRET_KEYS = {
    "secret",
    "secretkey",
    "secretaccesskey",
    "password",
    "token",
    "sessiontoken",
    "authorization",
}


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key.lower() in SECRET_KEYS:
                result[key] = "[REDACTED]"
            else:
                result[key] = _redact(item)
        return result
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


class AuditLogger:
    def __init__(self, path: str | Path = "data/private-agent/audit.jsonl"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def record(
        self,
        *,
        event: str,
        route: str,
        service: str,
        account_id: str | None,
        status: str,
        duration_ms: int,
        detail: dict[str, Any] | None = None,
    ) -> None:
        row = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "route": route,
            "service": service,
            "accountId": account_id,
            "status": status,
            "durationMs": duration_ms,
            "detail": _redact(detail or {}),
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
python3 -m unittest tests.private.test_limits tests.private.test_audit -v
```

Expected: PASS with 2 tests.

- [ ] **Step 7: Commit**

```bash
git add agent/private_runtime/limits.py agent/private_runtime/audit.py tests/private/test_limits.py tests/private/test_audit.py
git commit -m "feat: add private runtime limits and audit"
```

---

### Task 5: Add Local MCP Server Scaffold

**Files:**
- Create: `agent/requirements-private.txt`
- Create: `agent/mcp_server.py`

- [ ] **Step 1: Add private runtime dependencies**

Create `agent/requirements-private.txt`:

```text
boto3>=1.35.0
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
langgraph>=0.2.0
langchain-core>=0.3.0
mcp>=1.0.0
pg8000>=1.31.0
```

- [ ] **Step 2: Create MCP server scaffold**

Create `agent/mcp_server.py`:

```python
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from typing import Any

import pg8000
from mcp.server.fastmcp import FastMCP

from agent.private_runtime.audit import AuditLogger
from agent.private_runtime.config import load_private_config
from agent.private_runtime.limits import RuntimeLimits


mcp = FastMCP("awsops-private")
config = load_private_config(os.environ.get("AWSOPS_CONFIG", "data/config.json"))
limits = RuntimeLimits(config.agent)
audit = AuditLogger()


def _select_only(sql: str) -> None:
    first = sql.strip().split(None, 1)[0].lower() if sql.strip() else ""
    if first != "select":
        raise ValueError("Only SELECT statements are allowed")
    blocked = {"insert", "update", "delete", "drop", "alter", "truncate", "create"}
    tokens = {token.strip(" ;\n\t").lower() for token in sql.replace(",", " ").split()}
    found = sorted(blocked & tokens)
    if found:
        raise ValueError(f"Blocked SQL keyword: {found[0]}")


def _steampipe_connection():
    return pg8000.connect(
        host=os.environ.get("STEAMPIPE_HOST", "127.0.0.1"),
        port=int(os.environ.get("STEAMPIPE_PORT", "9193")),
        database=os.environ.get("STEAMPIPE_DB", "steampipe"),
        user=os.environ.get("STEAMPIPE_USER", "steampipe"),
        password=os.environ.get("STEAMPIPE_PASSWORD", ""),
        timeout=10,
    )


@mcp.tool()
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "activeEnvironment": config.active_environment_name,
        "agentProvider": config.agent.provider,
        "endpointMode": config.environment.endpoint_mode,
    }


@mcp.tool()
async def run_steampipe_query(sql: str, max_rows: int = 100) -> dict[str, Any]:
    started = time.time()
    status = "success"
    try:
        _select_only(sql)
        async with limits.steampipe:
            def run_query():
                conn = _steampipe_connection()
                cur = conn.cursor()
                cur.execute(sql)
                columns = [item[0] for item in cur.description] if cur.description else []
                rows = [dict(zip(columns, row)) for row in cur.fetchmany(max_rows)]
                cur.close()
                conn.close()
                return {"columns": columns, "rows": rows, "rowCount": len(rows)}

            return await asyncio.to_thread(run_query)
    except Exception:
        status = "error"
        raise
    finally:
        audit.record(
            event="tool_call",
            route="steampipe",
            service="steampipe",
            account_id=None,
            status=status,
            duration_ms=int((time.time() - started) * 1000),
            detail={"sqlPreview": sql[:160]},
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--transport", default="stdio", choices=["stdio", "sse"])
    args = parser.parse_args()
    mcp.run(transport=args.transport)


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run import smoke test**

Run:

```bash
python3 -m py_compile agent/mcp_server.py
```

Expected: PASS. If it fails because `mcp` is missing, run the command after installing `agent/requirements-private.txt` in the target environment and record the dependency gap.

- [ ] **Step 4: Commit**

```bash
git add agent/requirements-private.txt agent/mcp_server.py
git commit -m "feat: add local mcp server scaffold"
```

---

### Task 6: Add LangGraph API Scaffold

**Files:**
- Create: `agent/langgraph_api.py`

- [ ] **Step 1: Create FastAPI LangGraph scaffold**

Create `agent/langgraph_api.py`:

```python
from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agent.private_runtime.config import load_private_config


app = FastAPI(title="AWSops Private LangGraph API")
config = load_private_config(os.environ.get("AWSOPS_CONFIG", "data/config.json"))


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    accountId: str | None = None
    route: str | None = None


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "activeEnvironment": config.active_environment_name,
        "provider": config.agent.provider,
        "mcpServerUrl": config.agent.mcp_server_url,
    }


async def _stream_scaffold_response(request: ChatRequest):
    last = request.messages[-1].content if request.messages else ""
    events = [
        {"type": "status", "data": {"message": "private LangGraph API connected"}},
        {"type": "delta", "data": {"text": f"Private agent scaffold received: {last[:120]}"}},
        {"type": "done", "data": {"route": request.route or "general"}},
    ]
    for event in events:
        yield f"event: {event['type']}\n"
        yield "data: " + json.dumps(event["data"], ensure_ascii=False) + "\n\n"
        await asyncio.sleep(0.01)


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    return StreamingResponse(_stream_scaffold_response(request), media_type="text/event-stream")
```

- [ ] **Step 2: Run import smoke test**

Run:

```bash
python3 -m py_compile agent/langgraph_api.py
```

Expected: PASS after dependencies are installed. If `fastapi` is missing, install `agent/requirements-private.txt` in the target environment and rerun.

- [ ] **Step 3: Commit**

```bash
git add agent/langgraph_api.py
git commit -m "feat: add private langgraph api scaffold"
```

---

### Task 7: Add Next.js Local Agent Adapter

**Files:**
- Modify: `src/app/api/ai/route.ts`

- [ ] **Step 1: Add local provider helper**

In `src/app/api/ai/route.ts`, below `getCodeInterpreterName`, add:

```ts
function useLocalPrivateAgent(): boolean {
  const config = getConfig();
  return config.agent?.provider === 'local-mcp-langgraph';
}

function getLangGraphApiUrl(): string {
  const config = getConfig();
  return config.agent?.langgraphApiUrl || 'http://127.0.0.1:7000';
}
```

- [ ] **Step 2: Add streaming proxy helper**

In `src/app/api/ai/route.ts`, before the main `POST` handler, add:

```ts
async function streamLocalPrivateAgent(requestBody: any): Promise<Response> {
  const upstream = await fetch(`${getLangGraphApiUrl()}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Local private agent unavailable: HTTP ${upstream.status}` },
      { status: 502 }
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 3: Route local provider at start of POST**

At the start of the main `POST` handler, after parsing the body and before AgentCore-specific logic, add:

```ts
if (useLocalPrivateAgent()) {
  return streamLocalPrivateAgent(body);
}
```

Use the existing body variable name in the file. If the file currently parses JSON inside a later block, move `const body = await request.json();` to the top of the handler so both local and existing AgentCore paths share it.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: PASS or fail only for pre-existing unrelated upstream issues. If it fails due to `body` scoping or missing helper imports, fix `src/app/api/ai/route.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ai/route.ts
git commit -m "feat: route ai requests to private local agent"
```

---

### Task 8: Add Private Agent Start And Verify Scripts

**Files:**
- Create: `scripts/13-start-private-agent.sh`
- Create: `scripts/13-verify-private-agent.sh`

- [ ] **Step 1: Create start script**

Create `scripts/13-start-private-agent.sh`:

```bash
#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export AWSOPS_CONFIG="${AWSOPS_CONFIG:-data/config.json}"

mkdir -p data/private-agent

echo "[private-agent] starting MCP server on stdio is handled by LangGraph in later phases"
echo "[private-agent] starting LangGraph API on 127.0.0.1:7000"

nohup python3 -m uvicorn agent.langgraph_api:app \
  --host 127.0.0.1 \
  --port 7000 \
  > data/private-agent/langgraph-api.log 2>&1 &

echo "$!" > data/private-agent/langgraph-api.pid
sleep 2

curl -fsS http://127.0.0.1:7000/health
echo
echo "[private-agent] started"
```

- [ ] **Step 2: Create verify script**

Create `scripts/13-verify-private-agent.sh`:

```bash
#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[verify] Python unit tests"
python3 -m unittest discover -s tests/private -p 'test_*.py' -v

echo "[verify] LangGraph API health"
curl -fsS http://127.0.0.1:7000/health | python3 -m json.tool

echo "[verify] LangGraph API stream"
curl -fsS -N \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"health check"}]}' \
  http://127.0.0.1:7000/chat/stream

echo
echo "[verify] complete"
```

- [ ] **Step 3: Make scripts executable**

Run:

```bash
chmod +x scripts/13-start-private-agent.sh scripts/13-verify-private-agent.sh
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/13-start-private-agent.sh scripts/13-verify-private-agent.sh
git commit -m "feat: add private agent service scripts"
```

---

### Task 9: Add Internal ALB And Cognito/CloudFront Gates

**Files:**
- Modify: `infra-cdk/lib/awsops-stack.ts`
- Modify: `infra-cdk/bin/app.ts`
- Modify: `infra-cdk/README.md`

- [ ] **Step 1: Add private context handling in stack**

In `infra-cdk/lib/awsops-stack.ts`, define these values near the existing parameters:

```ts
const privateMode = this.node.tryGetContext('privateMode') === 'true';
const internalAlbCidrs = ((this.node.tryGetContext('internalAlbCidrs') as string) || '')
  .split(',')
  .map(c => c.trim())
  .filter(Boolean);
```

- [ ] **Step 2: Make CloudFront prefix list optional in private mode**

Change `CloudFrontPrefixListId` parameter usage so private mode does not require it. If `privateMode` is true, skip `ALBIngressFromCloudFront` and instead add ingress rules from `internalAlbCidrs`.

Use this code after `albSg` creation:

```ts
if (privateMode) {
  if (internalAlbCidrs.length === 0) {
    throw new Error('privateMode=true requires -c internalAlbCidrs=CIDR1,CIDR2');
  }
  internalAlbCidrs.forEach((cidr, idx) => {
    albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(3000), `Dashboard from internal CIDR ${idx + 1}`);
  });
} else {
  new ec2.CfnSecurityGroupIngress(this, 'ALBIngressFromCloudFront', {
    groupId: albSg.securityGroupId,
    ipProtocol: 'tcp',
    fromPort: 80,
    toPort: 3000,
    sourcePrefixListId: cloudFrontPrefixListId.valueAsString,
    description: 'HTTP/Dashboard ports from CloudFront origin-facing',
  });
}
```

- [ ] **Step 3: Make ALB internal in private mode**

Change the ALB creation:

```ts
this.alb = new elbv2.ApplicationLoadBalancer(this, 'PublicALB', {
  loadBalancerName: 'awsops-alb',
  vpc: this.vpc,
  internetFacing: !privateMode,
  securityGroup: albSg,
  idleTimeout: cdk.Duration.seconds(3600),
});
```

- [ ] **Step 4: Skip CloudFront distribution creation in private mode**

Wrap CloudFront distribution and Route53 public alias creation in `if (!privateMode) { ... }`. In private mode, do not instantiate `cloudfront.Distribution`.

Because `distribution` is currently a required public readonly property, change it to:

```ts
public readonly distribution?: cloudfront.Distribution;
```

Update outputs so `CloudFrontURL` is only emitted when `this.distribution` exists. Add private output:

```ts
new cdk.CfnOutput(this, 'InternalALBEndpoint', {
  value: `http://${this.alb.loadBalancerDnsName}:3000/awsops`,
  description: 'Internal ALB dashboard URL',
});
```

- [ ] **Step 5: Gate Cognito stack creation**

In `infra-cdk/bin/app.ts`, wrap Cognito stack creation:

```ts
const privateMode = app.node.tryGetContext('privateMode') === 'true';

if (!privateMode && infra.distribution) {
  const cognito = new CognitoStack(app, 'AwsopsCognitoStack', {
    env: { account: env.account, region: 'us-east-1' },
    crossRegionReferences: true,
    description: 'AWSops Dashboard - Cognito authentication with Lambda@Edge',
    distribution: infra.distribution,
    customDomain,
  });
  cognito.addDependency(infra);
}
```

- [ ] **Step 6: Document private CDK command**

In `infra-cdk/README.md`, add:

````markdown
## Private/Internal Deployment

For internal Direct Connect access without CloudFront or Cognito:

```bash
cdk deploy AwsopsStack \
  -c privateMode=true \
  -c internalAlbCidrs=10.0.0.0/8,172.16.0.0/12 \
  --parameters AwsopsStack:VSCodePassword=YOUR_PASSWORD
```

Private mode creates an internal ALB and skips CloudFront/Cognito. It does not create service VPC endpoints; configure existing endpoints in `data/config.json`.
```
````

- [ ] **Step 7: Run CDK build**

Run:

```bash
cd infra-cdk && npm run build
```

Expected: PASS. If TypeScript errors mention optional `distribution`, update type checks in `infra-cdk/bin/app.ts`.

- [ ] **Step 8: Commit**

```bash
git add infra-cdk/lib/awsops-stack.ts infra-cdk/bin/app.ts infra-cdk/README.md
git commit -m "feat: support private internal alb mode"
```

---

### Task 10: Full Phase 1 Verification

**Files:**
- No new files.

- [ ] **Step 1: Run Python tests**

Run:

```bash
python3 -m unittest discover -s tests/private -p 'test_*.py' -v
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS or documented pre-existing upstream failure. If failure is caused by Phase 1 changes, fix before continuing.

- [ ] **Step 3: Run CDK build**

Run:

```bash
cd infra-cdk && npm run build
```

Expected: PASS.

- [ ] **Step 4: Verify private branch contains no GitHub Actions workflow**

Run:

```bash
git ls-files .github/workflows
```

Expected: no output.

- [ ] **Step 5: Verify private branch contains no `.sensitive` files**

Run:

```bash
git ls-files .sensitive
```

Expected: no output.

- [ ] **Step 6: Push private branch**

Run:

```bash
git push origin private-main:main
```

Expected: push succeeds without requiring GitHub `workflow` scope.

---

## Self-Review

Spec coverage:

- CloudFront/Cognito removal is covered by Task 9.
- AgentCore replacement foundation is covered by Tasks 5, 6, and 7.
- Bedrock profile enforcement is covered by Tasks 2 and 3.
- VPCE config without creation is covered by Tasks 1, 2, 3, and 9.
- Development explicit endpoint URLs and production Private DNS are covered by Tasks 1, 2, and 3.
- Concurrency, timeouts, caching foundation, and audit logging are covered by Task 4 and the MCP scaffold in Task 5.
- GitHub Actions non-dependence is covered by Task 10.

No deferred implementation markers are intentionally left in this plan. Example endpoint hostnames use `example` or `vpce-xxx` only inside tests or config examples, not as implementation constants.
