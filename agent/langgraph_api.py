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
    content = f"Private agent scaffold received: {last[:120]}"
    done_data: dict[str, Any] = {
        "content": content,
        "route": request.route or "general",
        "via": "private-langgraph-api",
        "queriedResources": [],
    }
    if request.accountId:
        done_data["accountId"] = request.accountId

    events = [
        {"type": "status", "data": {"message": "private LangGraph API connected"}},
        {"type": "chunk", "data": {"delta": content}},
        {"type": "done", "data": done_data},
    ]
    for event in events:
        yield f"event: {event['type']}\n"
        yield "data: " + json.dumps(event["data"], ensure_ascii=False) + "\n\n"
        await asyncio.sleep(0.01)


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    return StreamingResponse(_stream_scaffold_response(request), media_type="text/event-stream")
