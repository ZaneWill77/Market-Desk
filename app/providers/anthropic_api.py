"""Provider: the Claude API with the signed-in user's own Anthropic API key.

Runs a streaming tool-use loop with the official Anthropic SDK. Each user's key stays in
their server-side session (see app/auth.py); conversation history is kept per session.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import AsyncIterator

import anthropic

from ..tools import TOOLS, label_for, run_tool
from .base import SYSTEM_PROMPT, context_line

ID = "anthropic"
NAME = "Anthropic API key"
NEEDS_API_KEY = True
LOCAL_ONLY = False
MODELS = [
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
]
MAX_ITERATIONS = 20

# Refusal fallbacks: if a model declines, the API re-runs the request on a suitable fallback
# model inside the same call. Not available for Haiku.
FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _client(api_key: str) -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=api_key, max_retries=2)


async def validate_key(api_key: str) -> None:
    """Raises anthropic.AuthenticationError (or another APIError) if the key doesn't work."""
    await _client(api_key).models.list(limit=1)


def _tools(model: str) -> list[dict]:
    tools = [
        {"name": t.name, "description": t.description, "input_schema": t.input_schema,
         "eager_input_streaming": True}
        for t in TOOLS.values()
    ]
    # Dynamic-filtering web search needs Opus/Sonnet; Haiku gets the basic version.
    web = "web_search_20250305" if "haiku" in model else "web_search_20260209"
    tools.append({"type": web, "name": "web_search", "max_uses": 5})
    return tools


def _valid_input(name: str, args) -> bool:
    tool = TOOLS.get(name)
    if tool is None or not isinstance(args, dict):
        return False
    props = tool.input_schema["properties"]
    return all(isinstance(args.get(k), str) for k in tool.input_schema["required"]) and \
        all(k in props and (v is None or isinstance(v, str)) for k, v in args.items())


async def _run_one(block) -> dict:
    if not _valid_input(block.name, block.input):
        return {"type": "tool_result", "tool_use_id": block.id, "is_error": True,
                "content": json.dumps({"INVALID_JSON": json.dumps(block.input, default=str)})}
    try:
        out = await asyncio.to_thread(run_tool, block.name, block.input)
        return {"type": "tool_result", "tool_use_id": block.id, "content": out}
    except Exception as e:  # tool errors go back to Claude, not the user
        return {"type": "tool_result", "tool_use_id": block.id, "is_error": True, "content": f"Error: {e}"}


async def chat(session, message: str, conversation_id: str | None, model: str | None,
               effort: str | None) -> AsyncIterator[dict]:
    if not session.api_key:
        yield {"type": "error", "message": "Not signed in with an API key."}
        return
    model = model if model in dict(MODELS) else MODELS[0][0]
    conv_id = conversation_id if conversation_id in session.conversations else uuid.uuid4().hex
    history = session.conversations.setdefault(conv_id, [])
    yield {"type": "conversation", "conversation_id": conv_id}

    history.append({"role": "user", "content": f"{context_line()}\n\n{message}"})

    client = _client(session.api_key)
    params = dict(
        model=model,
        max_tokens=64000,
        system=[{"type": "text", "text": SYSTEM_PROMPT}],
        tools=_tools(model),
        cache_control={"type": "ephemeral"},  # caches system + tools + history prefix
    )
    if effort in ("low", "medium", "high", "xhigh", "max"):
        params["output_config"] = {"effort": effort}
    if model in FALLBACK_MODELS:
        params["betas"] = [FALLBACK_BETA]
        params["fallbacks"] = "default"

    json_retries = 0
    try:
        for i in range(MAX_ITERATIONS):
            if i:
                yield {"type": "turn"}
            try:
                async with client.beta.messages.stream(messages=history, **params) as stream:
                    async for event in stream:
                        if event.type == "content_block_delta" and event.delta.type == "text_delta":
                            yield {"type": "text", "text": event.delta.text}
                        elif event.type == "content_block_start" and event.content_block.type == "server_tool_use":
                            yield {"type": "tool", "label": "Searching the web"}
                    response = await stream.get_final_message()
                json_retries = 0
            except ValueError:
                # Tool input JSON the SDK couldn't parse at all; re-issue the turn (bounded).
                json_retries += 1
                if json_retries > 2:
                    raise
                continue

            # Keep the full assistant turn (thinking, tool calls, fallback blocks) unchanged.
            history.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "pause_turn":  # server tool paused; resume
                continue
            if response.stop_reason == "refusal":
                yield {"type": "error", "message": "Claude declined to answer this request."}
                break

            tool_uses = [b for b in response.content if b.type == "tool_use"]
            if not tool_uses:
                break
            if response.stop_reason == "max_tokens":
                # Don't run a truncated tool call, but keep the history valid.
                history.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": b.id, "is_error": True,
                     "content": "Tool input was truncated."} for b in tool_uses]})
                yield {"type": "error", "message": "The response hit the length limit."}
                break

            for b in tool_uses:
                yield {"type": "tool", "label": label_for(b.name, b.input if isinstance(b.input, dict) else {})}
            results = await asyncio.gather(*(_run_one(b) for b in tool_uses))
            history.append({"role": "user", "content": list(results)})
        else:
            yield {"type": "error", "message": "Stopped after too many tool steps."}
    except anthropic.AuthenticationError:
        yield {"type": "error", "message": "Your API key was rejected. Sign out and sign in again with a valid key."}
    except anthropic.PermissionDeniedError:
        yield {"type": "error", "message": f"Your API key doesn't have access to {model}."}
    except anthropic.RateLimitError:
        yield {"type": "error", "message": "Rate limited by the Claude API. Wait a moment and try again."}
    except anthropic.APIStatusError as e:
        yield {"type": "error", "message": f"Claude API error {e.status_code}: {e.message}"}
    except anthropic.APIConnectionError:
        yield {"type": "error", "message": "Couldn't reach the Claude API. Check your connection."}
    yield {"type": "done"}
