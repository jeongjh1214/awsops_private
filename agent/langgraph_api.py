from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agent.private_runtime.aws_clients import AwsClientFactory
from agent.private_runtime.bedrock_chat import (
    format_bedrock_error,
    resolve_bedrock_model_id,
    stream_anthropic_response,
)
from agent.private_runtime.config import load_private_config
from agent.private_runtime.limits import RuntimeLimits


app = FastAPI(title="AWSops Private LangGraph API")
config = load_private_config(os.environ.get("AWSOPS_CONFIG", "data/config.json"))
aws_clients = AwsClientFactory(config)
limits = RuntimeLimits(config.agent)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    accountId: str | None = None
    route: str | None = None
    model: str | None = None


@app.get("/health")
async def health() -> dict[str, Any]:
    bedrock_context = aws_clients.bedrock_runtime_context()
    return {
        "status": "ok",
        "activeEnvironment": config.active_environment_name,
        "provider": config.agent.provider,
        "modelId": config.agent.model_id,
        "bedrockProfile": bedrock_context["profile"],
        "bedrockEndpointMode": bedrock_context["endpointMode"],
        "bedrockEndpointUrl": bedrock_context["endpointUrl"],
        "mcpServerUrl": config.agent.mcp_server_url,
    }


def _sse_event(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _stream_bedrock_response(request: ChatRequest):
    model_id = resolve_bedrock_model_id(config.agent.model_id, request.model)
    bedrock_context = aws_clients.bedrock_runtime_context()
    yield _sse_event("status", {
        "message": "calling private Bedrock Runtime",
        "model": model_id,
        "bedrockProfile": bedrock_context["profile"],
        "bedrockEndpointMode": bedrock_context["endpointMode"],
        "bedrockEndpointUrl": bedrock_context["endpointUrl"],
    })

    async with limits.bedrock:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue()

        def publish(event: str, data: dict[str, Any]) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, (event, data))

        def invoke() -> None:
            try:
                result = stream_anthropic_response(
                    aws_clients.bedrock_runtime(),
                    model_id=model_id,
                    messages=request.messages,
                    on_delta=lambda delta: publish("chunk", {"delta": delta}),
                )
                done_data: dict[str, Any] = {
                    **result,
                    "model": model_id,
                    "route": request.route or "general",
                    "via": "private-langgraph-api",
                    "queriedResources": [],
                }
                if request.accountId:
                    done_data["accountId"] = request.accountId
                publish("done", done_data)
            except Exception as exc:
                publish("error", {
                    "error": format_bedrock_error(exc, bedrock_context["endpointUrl"]),
                    "model": model_id,
                    "via": "private-langgraph-api",
                })

        task = asyncio.create_task(asyncio.to_thread(invoke))
        while True:
            event, data = await queue.get()
            yield _sse_event(event, data)
            if event in {"done", "error"}:
                break
        await task


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    return StreamingResponse(_stream_bedrock_response(request), media_type="text/event-stream")
