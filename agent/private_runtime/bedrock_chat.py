from __future__ import annotations

import json
from typing import Any, Callable, Iterable
from urllib.parse import urlparse


DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-6"
MODEL_ALIASES = {
    "sonnet-4.6": "global.anthropic.claude-sonnet-4-6",
    "opus-4.6": "global.anthropic.claude-opus-4-6-v1",
}

SYSTEM_PROMPT = (
    "You are AWSops running in a private enterprise network. "
    "Answer operational AWS questions using only available private tools and context."
)


def resolve_bedrock_model_id(configured_model_id: str | None, request_model: str | None = None) -> str:
    for candidate in (configured_model_id, request_model, DEFAULT_MODEL_ID):
        model_id = (candidate or "").strip()
        if model_id:
            return MODEL_ALIASES.get(model_id, model_id)
    return DEFAULT_MODEL_ID


def format_bedrock_error(error: BaseException | str, endpoint_url: str | None = None) -> str:
    message = str(error)
    normalized = message.lower()
    if "unknownoperationexception" not in normalized or "invokemodelwithresponsestream" not in normalized:
        return message

    endpoint_hint = ""
    if endpoint_url:
        hostname = urlparse(endpoint_url).netloc or endpoint_url
        endpoint_hint = f" Current endpoint host: {hostname}."

    return (
        f"{message} Bedrock Runtime returned UnknownOperationException for InvokeModelWithResponseStream. "
        "Verify data/config.json endpointUrls[\"bedrock-runtime\"] points to a Bedrock Runtime VPCE "
        "hostname that contains bedrock-runtime, not the Bedrock control-plane endpoint."
        f"{endpoint_hint}"
    )


def _message_value(message: Any, key: str) -> Any:
    if isinstance(message, dict):
        return message.get(key)
    return getattr(message, key, None)


def normalize_anthropic_messages(messages: Iterable[Any]) -> list[dict[str, str]]:
    normalized = []
    for message in messages:
        role = str(_message_value(message, "role") or "").strip()
        content = str(_message_value(message, "content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        normalized.append({"role": role, "content": content})
    if not normalized:
        raise ValueError("at least one user or assistant message is required")
    return normalized


def build_anthropic_payload(
    messages: Iterable[Any],
    *,
    system: str = SYSTEM_PROMPT,
    max_tokens: int = 4096,
) -> dict[str, Any]:
    return {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "system": system,
        "messages": normalize_anthropic_messages(messages),
    }


def _decode_stream_chunk(event: dict[str, Any]) -> dict[str, Any] | None:
    raw = (event.get("chunk") or {}).get("bytes")
    if not raw:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    return json.loads(raw)


def stream_anthropic_response(
    client: Any,
    *,
    model_id: str,
    messages: Iterable[Any],
    on_delta: Callable[[str], None],
    system: str = SYSTEM_PROMPT,
    max_tokens: int = 4096,
) -> dict[str, Any]:
    payload = build_anthropic_payload(messages, system=system, max_tokens=max_tokens)
    response = client.invoke_model_with_response_stream(
        modelId=model_id,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    )

    content = ""
    input_tokens = 0
    output_tokens = 0

    for event in response.get("body", []):
        parsed = _decode_stream_chunk(event)
        if not parsed:
            continue

        if parsed.get("type") == "content_block_delta":
            delta = (parsed.get("delta") or {}).get("text")
            if delta:
                content += delta
                on_delta(delta)
        elif parsed.get("type") == "message_start":
            input_tokens = ((parsed.get("message") or {}).get("usage") or {}).get("input_tokens", 0)
        elif parsed.get("type") == "message_delta":
            output_tokens = (parsed.get("usage") or {}).get("output_tokens", 0)

    return {
        "content": content,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
    }
