"""OpenAI-kompatibler Streaming-Client mit Werkzeugaufrufen.

Bewusst ohne SDK: Gimel spricht HTTP mit httpx, und ein zweiter Client würde
nur eine zweite Quelle für Zeitlimits und Fehlertexte schaffen.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .models import AgentProvider
from .providers import (
    OLLAMA_DEFAULT_CTX,
    ProviderError,
    _request_headers,
    api_key,
    chat_url,
    is_ollama,
    ollama_chat_url,
    provider_context_length,
    provider_protocol,
)

_TRANSIENT_STATUSES = {429, 502, 503, 504}


def _join(parts: list[str]) -> str:
    return "".join(part for part in parts if part)


def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            str(part.get("text", ""))
            for part in value
            if isinstance(part, dict)
        )
    return ""


def _ollama_messages(messages: list[dict]) -> list[dict]:
    """Konvertiert OpenAI-Verlauf ins native Ollama-/api/chat-Format (inkl. Tool-Calls)."""
    out: list[dict] = []
    for msg in messages:
        role = msg.get("role") or "user"
        item: dict[str, Any] = {"role": role, "content": _content_text(msg.get("content"))}
        if role == "tool" and msg.get("name"):
            item["tool_name"] = str(msg["name"])
        if role == "assistant" and msg.get("tool_calls"):
            ocalls = []
            for call in msg["tool_calls"]:
                fn = call.get("function") or {}
                raw_args = fn.get("arguments", {})
                if isinstance(raw_args, str):
                    try:
                        parsed = json.loads(raw_args or "{}")
                        args_obj = parsed if isinstance(parsed, dict) else {}
                    except json.JSONDecodeError:
                        args_obj = {}
                elif isinstance(raw_args, dict):
                    args_obj = raw_args
                else:
                    args_obj = {}
                ocalls.append({
                    "function": {
                        "name": str(fn.get("name") or ""),
                        "arguments": args_obj,
                    }
                })
            if ocalls:
                item["tool_calls"] = ocalls
        out.append(item)
    return out


async def _stream_ollama_chat(
    provider: AgentProvider,
    *,
    model: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    temperature: float = 0.2,
    timeout_s: int = 300,
    max_tokens: int | None = None,
    num_ctx: int | None = None,
) -> AsyncIterator[dict]:
    """Nativer Ollama-/api/chat-Client mit explizitem ``options.num_ctx`` (Standard 32k)."""
    effective_ctx = num_ctx or provider_context_length(provider) or OLLAMA_DEFAULT_CTX
    options: dict[str, Any] = {
        "num_ctx": int(effective_ctx),
        "temperature": temperature,
    }
    if max_tokens:
        options["num_predict"] = int(max_tokens)

    payload: dict[str, Any] = {
        "model": model,
        "messages": _ollama_messages(messages),
        "stream": True,
        "options": options,
    }
    if tools:
        payload["tools"] = tools

    headers = {
        "User-Agent": "gimel-agentlab/0.1",
        "Content-Type": "application/json",
    }
    key = api_key(provider)
    if key:
        headers["Authorization"] = f"Bearer {key}"
    headers.update(
        {str(k): str(v) for k, v in (provider.headers or {}).items()
         if str(k).lower() not in {"authorization", "host", "cookie", "content-length", "x-ollama-num-ctx", "x-context-length"}}
    )

    content: list[str] = []
    reasoning: list[str] = []
    tool_calls: list[dict] = []
    usage: dict = {}
    finish_reason = ""
    raw_lines = 0

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_s, connect=15.0),
            follow_redirects=False,
            headers=headers,
        ) as client:
            async with client.stream("POST", ollama_chat_url(provider), json=payload) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread())[:2000].decode("utf-8", "replace")
                    raise ProviderError(
                        f"Der Ollama-Endpunkt antwortet mit {resp.status_code}: {body}", 502
                    )
                async for line in resp.aiter_lines():
                    raw_lines += 1
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    if chunk.get("error"):
                        raise ProviderError(f"Ollama meldet: {chunk['error']}", 502)
                    msg = chunk.get("message") or {}
                    think = _content_text(msg.get("thinking"))
                    if think:
                        reasoning.append(think)
                        yield {"type": "reasoning", "text": think}
                    text = _content_text(msg.get("content"))
                    if text:
                        content.append(text)
                        yield {"type": "text", "text": text}
                    for call in msg.get("tool_calls") or []:
                        if not isinstance(call, dict):
                            continue
                        fn = call.get("function") or {}
                        name = str(fn.get("name") or "").strip()
                        if not name:
                            continue
                        raw_args = fn.get("arguments")
                        args_str = (
                            raw_args if isinstance(raw_args, str)
                            else json.dumps(raw_args if raw_args is not None else {}, ensure_ascii=False)
                        )
                        tool_calls.append({
                            "id": str(call.get("id") or f"call_{len(tool_calls) + 1}"),
                            "type": "function",
                            "function": {"name": name, "arguments": args_str},
                        })
                    if chunk.get("done"):
                        prompt_tok = int(chunk.get("prompt_eval_count") or 0)
                        comp_tok = int(chunk.get("eval_count") or 0)
                        if prompt_tok or comp_tok:
                            usage = {
                                "prompt_tokens": prompt_tok,
                                "completion_tokens": comp_tok,
                                "total_tokens": prompt_tok + comp_tok,
                                "num_ctx": int(effective_ctx),
                            }
                        finish_reason = str(chunk.get("done_reason") or finish_reason or "stop")
                        break
    except ProviderError:
        raise
    except httpx.TimeoutException as exc:
        raise ProviderError("Der Ollama-Server hat nicht rechtzeitig geantwortet.", 504) from exc
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"Verbindung zum Ollama-Server fehlgeschlagen: {exc}", 502) from exc

    yield {
        "type": "done",
        "content": _join(content),
        "reasoning": _join(reasoning),
        "tool_calls": tool_calls,
        "usage": usage,
        "finish_reason": finish_reason,
        "raw_lines": raw_lines,
    }


class _ThinkSplitter:
    """Trennt inline ``<think>…</think>``-Blöcke über Chunk-Grenzen hinweg sauber in ``reasoning`` und ``text``."""

    OPEN_TAG = "<think>"
    CLOSE_TAG = "</think>"

    def __init__(self) -> None:
        self._in_think = False
        self._buf = ""

    def feed(self, chunk: str) -> list[tuple[str, str]]:
        if not chunk:
            return []
        self._buf += chunk
        out: list[tuple[str, str]] = []
        while self._buf:
            tag = self.CLOSE_TAG if self._in_think else self.OPEN_TAG
            kind = "reasoning" if self._in_think else "text"
            idx = self._buf.find(tag)
            if idx != -1:
                before = self._buf[:idx]
                if before:
                    out.append((kind, before))
                self._buf = self._buf[idx + len(tag):]
                self._in_think = not self._in_think
                continue
            keep = 0
            max_check = min(len(tag) - 1, len(self._buf))
            for n in range(max_check, 0, -1):
                if self._buf.endswith(tag[:n]):
                    keep = n
                    break
            emit = self._buf[:-keep] if keep else self._buf
            self._buf = self._buf[-keep:] if keep else ""
            if emit:
                out.append((kind, emit))
            break
        return out

    def flush(self) -> list[tuple[str, str]]:
        if not self._buf:
            return []
        kind = "reasoning" if self._in_think else "text"
        text = self._buf
        self._buf = ""
        return [(kind, text)]


def _to_anthropic_messages(messages: list[dict]) -> tuple[str, list[dict]]:
    system_parts: list[str] = []
    out: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        text = _content_text(msg.get("content"))
        if role == "system":
            if text:
                system_parts.append(text)
            continue
        if role == "tool":
            block = {
                "type": "tool_result",
                "tool_use_id": str(msg.get("tool_call_id") or ""),
                "content": text or "{}",
            }
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
            continue
        if role == "assistant":
            blocks: list[dict] = []
            if text:
                blocks.append({"type": "text", "text": text})
            for tc in msg.get("tool_calls") or []:
                fn = tc.get("function") or {}
                raw_args = fn.get("arguments") or "{}"
                try:
                    parsed = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                    if not isinstance(parsed, dict):
                        parsed = {}
                except json.JSONDecodeError:
                    parsed = {}
                blocks.append({
                    "type": "tool_use",
                    "id": str(tc.get("id") or f"toolu_{len(blocks) + 1}"),
                    "name": str(fn.get("name") or ""),
                    "input": parsed,
                })
            if blocks:
                out.append({"role": "assistant", "content": blocks})
            continue
        if out and out[-1]["role"] == "user":
            if isinstance(out[-1]["content"], list):
                out[-1]["content"].append({"type": "text", "text": text or " "})
            else:
                out[-1]["content"] = f"{out[-1]['content']}\n\n{text}"
        else:
            out.append({"role": "user", "content": text or " "})
    return "\n\n".join(system_parts), out


def _to_anthropic_tools(tools: list[dict] | None) -> list[dict]:
    out: list[dict] = []
    for item in tools or []:
        fn = item.get("function") or {}
        name = fn.get("name")
        if not name:
            continue
        schema = fn.get("parameters") or {"type": "object", "properties": {}}
        out.append({
            "name": name,
            "description": fn.get("description") or "",
            "input_schema": schema,
        })
    return out


async def _stream_anthropic(
    provider: AgentProvider,
    *,
    model: str,
    messages: list[dict],
    tools: list[dict] | None,
    session_id: str,
    temperature: float,
    timeout_s: int,
    max_tokens: int | None,
) -> AsyncIterator[dict]:
    system_text, anthropic_msgs = _to_anthropic_messages(messages)
    payload: dict[str, Any] = {
        "model": model,
        "messages": anthropic_msgs,
        "max_tokens": max_tokens or 8192,
        "stream": True,
        "temperature": min(1.0, max(0.0, temperature)),
    }
    if system_text:
        payload["system"] = system_text
    ant_tools = _to_anthropic_tools(tools)
    if ant_tools:
        payload["tools"] = ant_tools

    headers = _request_headers(provider, session_id=session_id)
    headers["Accept"] = "text/event-stream"

    content: list[str] = []
    reasoning: list[str] = []
    blocks: dict[int, dict] = {}
    usage: dict[str, Any] = {}
    finish_reason = ""
    raw_lines = 0

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_s, connect=15.0),
            follow_redirects=False,
            headers=headers,
        ) as client:
            async with client.stream("POST", chat_url(provider, model), json=payload) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread())[:2000].decode("utf-8", "replace")
                    raise ProviderError(f"Anthropic antwortet mit {resp.status_code}: {body}", 502)
                async for line in resp.aiter_lines():
                    raw_lines += 1
                    line = line.strip()
                    if not line or line.startswith(":") or line.startswith("event:"):
                        continue
                    data = line[5:].strip() if line.startswith("data:") else line
                    if not data or data == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    etype = chunk.get("type")
                    if etype == "error":
                        err = chunk.get("error") or {}
                        detail = err.get("message") if isinstance(err, dict) else str(err)
                        raise ProviderError(f"Anthropic meldet: {detail}", 502)
                    elif etype == "message_start":
                        msg_usage = (chunk.get("message") or {}).get("usage") or {}
                        if msg_usage:
                            usage["prompt_tokens"] = int(msg_usage.get("input_tokens") or 0)
                            if msg_usage.get("cache_read_input_tokens"):
                                usage["prompt_tokens_details"] = {
                                    "cached_tokens": int(msg_usage["cache_read_input_tokens"])
                                }
                    elif etype == "content_block_start":
                        idx = int(chunk.get("index") or 0)
                        cb = chunk.get("content_block") or {}
                        if cb.get("type") == "tool_use":
                            cid = str(cb.get("id") or f"toolu_{idx + 1}")
                            cname = str(cb.get("name") or "")
                            blocks[idx] = {"id": cid, "name": cname, "arguments": ""}
                            if cname:
                                yield {"type": "tool_call_start", "index": idx, "id": cid, "name": cname}
                    elif etype == "content_block_delta":
                        idx = int(chunk.get("index") or 0)
                        delta = chunk.get("delta") or {}
                        dtype = delta.get("type")
                        if dtype == "text_delta" and delta.get("text"):
                            piece = str(delta["text"])
                            content.append(piece)
                            yield {"type": "text", "text": piece}
                        elif dtype == "thinking_delta" and delta.get("thinking"):
                            piece = str(delta["thinking"])
                            reasoning.append(piece)
                            yield {"type": "reasoning", "text": piece}
                        elif dtype == "input_json_delta" and delta.get("partial_json"):
                            if idx in blocks:
                                blocks[idx]["arguments"] += str(delta["partial_json"])
                    elif etype == "message_delta":
                        delta = chunk.get("delta") or {}
                        if delta.get("stop_reason"):
                            finish_reason = str(delta["stop_reason"])
                        du = chunk.get("usage") or {}
                        if du.get("output_tokens") is not None:
                            usage["completion_tokens"] = int(du["output_tokens"])
    except ProviderError:
        raise
    except httpx.TimeoutException as exc:
        raise ProviderError("Der Anbieter hat nicht rechtzeitig geantwortet.", 504) from exc
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"Verbindung zum Anbieter fehlgeschlagen: {exc}", 502) from exc

    if usage:
        usage["total_tokens"] = int(usage.get("prompt_tokens") or 0) + int(usage.get("completion_tokens") or 0)
    tool_calls = []
    for key in sorted(blocks):
        slot = blocks[key]
        if not slot["name"]:
            continue
        tool_calls.append({
            "id": slot["id"],
            "type": "function",
            "function": {"name": slot["name"], "arguments": slot["arguments"] or "{}"},
        })
    yield {
        "type": "done",
        "content": _join(content),
        "reasoning": _join(reasoning),
        "tool_calls": tool_calls,
        "usage": usage,
        "finish_reason": finish_reason,
        "raw_lines": raw_lines,
    }


def _clean_gemini_schema(schema: Any) -> Any:
    if isinstance(schema, list):
        return [_clean_gemini_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    drop = {"additionalProperties", "$schema", "maxItems", "default", "title"}
    return {k: _clean_gemini_schema(v) for k, v in schema.items() if k not in drop}


def _to_gemini_payload(
    messages: list[dict],
    tools: list[dict] | None,
    temperature: float,
    max_tokens: int | None,
) -> dict[str, Any]:
    system_parts: list[str] = []
    contents: list[dict] = []
    call_names: dict[str, str] = {}

    for msg in messages:
        role = msg.get("role")
        text = _content_text(msg.get("content"))
        if role == "system":
            if text:
                system_parts.append(text)
            continue
        if role == "assistant":
            parts: list[dict] = []
            if text:
                parts.append({"text": text})
            for tc in msg.get("tool_calls") or []:
                fn = tc.get("function") or {}
                cid = str(tc.get("id") or "")
                cname = str(fn.get("name") or "")
                if cid and cname:
                    call_names[cid] = cname
                raw_args = fn.get("arguments") or "{}"
                try:
                    parsed = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                    if not isinstance(parsed, dict):
                        parsed = {}
                except json.JSONDecodeError:
                    parsed = {}
                parts.append({"functionCall": {"name": cname, "args": parsed}})
            if parts:
                contents.append({"role": "model", "parts": parts})
            continue
        if role == "tool":
            cid = str(msg.get("tool_call_id") or "")
            cname = call_names.get(cid) or str(msg.get("name") or "tool")
            try:
                parsed = json.loads(text) if text else {}
                if not isinstance(parsed, dict):
                    parsed = {"result": parsed}
            except json.JSONDecodeError:
                parsed = {"result": text}
            part = {"functionResponse": {"name": cname, "response": parsed}}
            if contents and contents[-1]["role"] == "user" and any("functionResponse" in p for p in contents[-1]["parts"]):
                contents[-1]["parts"].append(part)
            else:
                contents.append({"role": "user", "parts": [part]})
            continue
        contents.append({"role": "user", "parts": [{"text": text or " "}]})

    payload: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            **({"maxOutputTokens": max_tokens} if max_tokens else {}),
        },
    }
    if system_parts:
        payload["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
    if tools:
        decls = []
        for item in tools:
            fn = item.get("function") or {}
            name = fn.get("name")
            if not name:
                continue
            params = _clean_gemini_schema(fn.get("parameters") or {"type": "object", "properties": {}})
            decl: dict[str, Any] = {"name": name, "description": fn.get("description") or ""}
            if params.get("properties"):
                decl["parameters"] = params
            decls.append(decl)
        if decls:
            payload["tools"] = [{"functionDeclarations": decls}]
    return payload


async def _stream_gemini(
    provider: AgentProvider,
    *,
    model: str,
    messages: list[dict],
    tools: list[dict] | None,
    session_id: str,
    temperature: float,
    timeout_s: int,
    max_tokens: int | None,
) -> AsyncIterator[dict]:
    payload = _to_gemini_payload(messages, tools, temperature, max_tokens)
    headers = _request_headers(provider, session_id=session_id)
    headers["Accept"] = "text/event-stream"

    content: list[str] = []
    reasoning: list[str] = []
    tool_calls: list[dict] = []
    usage: dict[str, Any] = {}
    finish_reason = ""
    raw_lines = 0

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_s, connect=15.0),
            follow_redirects=False,
            headers=headers,
        ) as client:
            async with client.stream("POST", chat_url(provider, model), json=payload) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread())[:2000].decode("utf-8", "replace")
                    raise ProviderError(f"Google Gemini antwortet mit {resp.status_code}: {body}", 502)
                async for line in resp.aiter_lines():
                    raw_lines += 1
                    line = line.strip()
                    if not line or line.startswith(":"):
                        continue
                    data = line[5:].strip() if line.startswith("data:") else line
                    if not data or data == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    if chunk.get("error"):
                        err = chunk["error"]
                        detail = err.get("message") if isinstance(err, dict) else str(err)
                        raise ProviderError(f"Google Gemini meldet: {detail}", 502)
                    um = chunk.get("usageMetadata") or {}
                    if um:
                        usage = {
                            "prompt_tokens": int(um.get("promptTokenCount") or 0),
                            "completion_tokens": int(um.get("candidatesTokenCount") or 0),
                            "total_tokens": int(um.get("totalTokenCount") or 0),
                        }
                        if um.get("cachedContentTokenCount"):
                            usage["prompt_tokens_details"] = {"cached_tokens": int(um["cachedContentTokenCount"])}
                        if um.get("thoughtsTokenCount"):
                            usage["completion_tokens_details"] = {"reasoning_tokens": int(um["thoughtsTokenCount"])}
                    candidates = chunk.get("candidates") or []
                    if not candidates:
                        continue
                    cand = candidates[0] or {}
                    if cand.get("finishReason"):
                        finish_reason = str(cand["finishReason"])
                    parts = (cand.get("content") or {}).get("parts") or []
                    for part in parts:
                        if not isinstance(part, dict):
                            continue
                        if part.get("thought") and part.get("text"):
                            piece = str(part["text"])
                            reasoning.append(piece)
                            yield {"type": "reasoning", "text": piece}
                        elif part.get("text"):
                            piece = str(part["text"])
                            content.append(piece)
                            yield {"type": "text", "text": piece}
                        elif part.get("functionCall"):
                            fc = part["functionCall"]
                            cname = str(fc.get("name") or "")
                            if not cname:
                                continue
                            cid = f"call_{len(tool_calls) + 1}"
                            args_json = json.dumps(fc.get("args") or {}, ensure_ascii=False)
                            yield {"type": "tool_call_start", "index": len(tool_calls), "id": cid, "name": cname}
                            tool_calls.append({
                                "id": cid,
                                "type": "function",
                                "function": {"name": cname, "arguments": args_json},
                            })
    except ProviderError:
        raise
    except httpx.TimeoutException as exc:
        raise ProviderError("Der Anbieter hat nicht rechtzeitig geantwortet.", 504) from exc
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"Verbindung zum Anbieter fehlgeschlagen: {exc}", 502) from exc

    yield {
        "type": "done",
        "content": _join(content),
        "reasoning": _join(reasoning),
        "tool_calls": tool_calls,
        "usage": usage,
        "finish_reason": finish_reason,
        "raw_lines": raw_lines,
    }


async def stream_completion(
    provider: AgentProvider,
    *,
    model: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    session_id: str = "",
    temperature: float = 0.2,
    timeout_s: int = 180,
    max_tokens: int | None = None,
    num_ctx: int | None = None,
) -> AsyncIterator[dict]:
    proto = provider_protocol(provider)
    if proto == "ollama" or is_ollama(provider):
        async for event in _stream_ollama_chat(
            provider,
            model=model,
            messages=messages,
            tools=tools,
            temperature=temperature,
            timeout_s=timeout_s,
            max_tokens=max_tokens,
            num_ctx=num_ctx,
        ):
            yield event
        return
    if proto == "anthropic":
        async for ev in _stream_anthropic(
            provider, model=model, messages=messages, tools=tools,
            session_id=session_id, temperature=temperature,
            timeout_s=timeout_s, max_tokens=max_tokens,
        ):
            yield ev
        return
    if proto == "gemini":
        async for ev in _stream_gemini(
            provider, model=model, messages=messages, tools=tools,
            session_id=session_id, temperature=temperature,
            timeout_s=timeout_s, max_tokens=max_tokens,
        ):
            yield ev
        return

    base_payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": temperature,
        "stream_options": {"include_usage": True},
    }
    if tools:
        base_payload["tools"] = tools
        base_payload["tool_choice"] = "auto"
    if max_tokens:
        base_payload["max_tokens"] = max_tokens

    headers = _request_headers(provider, session_id=session_id)
    headers["Accept"] = "text/event-stream"

    content: list[str] = []
    reasoning: list[str] = []
    calls: dict[int, dict] = {}
    slot_for_id: dict[str, int] = {}
    announced_slots: set[int] = set()
    usage: dict = {}
    finish_reason = ""
    raw_lines = 0
    emitted_any = False
    splitter = _ThinkSplitter()

    payload = dict(base_payload)
    max_attempts = 2

    for attempt in range(1, max_attempts + 1):
        retry = False
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout_s, connect=15.0),
                follow_redirects=False,
                headers=headers,
            ) as client:
                async with client.stream("POST", chat_url(provider, model), json=payload) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread())[:2000].decode("utf-8", "replace")
                        if (
                            resp.status_code == 400
                            and "stream_options" in payload
                            and "stream_options" in body.lower()
                            and attempt < max_attempts
                        ):
                            payload = {k: v for k, v in payload.items() if k != "stream_options"}
                            retry = True
                        elif resp.status_code in _TRANSIENT_STATUSES and not emitted_any and attempt < max_attempts:
                            retry = True
                            await asyncio.sleep(0.8 * attempt)
                        else:
                            raise ProviderError(
                                f"Der Anbieter antwortet mit {resp.status_code}: {body}", 502
                            )
                    if not retry:
                        async for line in resp.aiter_lines():
                            raw_lines += 1
                            line = line.strip()
                            if not line or line.startswith(":"):
                                continue
                            if line.startswith("data:"):
                                data = line[5:].strip()
                            elif line.startswith("{"):
                                data = line
                            else:
                                continue
                            if data == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data)
                            except json.JSONDecodeError:
                                continue
                            if isinstance(chunk, dict) and chunk.get("error"):
                                err = chunk["error"]
                                detail = err.get("message") if isinstance(err, dict) else str(err)
                                raise ProviderError(f"Der Anbieter meldet: {detail}", 502)
                            if not isinstance(chunk, dict):
                                continue
                            if chunk.get("usage"):
                                usage = chunk["usage"] or {}
                            choices = chunk.get("choices") or []
                            if not choices:
                                continue
                            choice = choices[0] or {}
                            delta = choice.get("delta") or {}
                            if not delta and choice.get("message"):
                                delta = choice["message"]

                            think = _content_text(
                                delta.get("reasoning_content") or delta.get("reasoning")
                            )
                            if think:
                                reasoning.append(think)
                                emitted_any = True
                                yield {"type": "reasoning", "text": think}

                            text = _content_text(delta.get("content"))
                            if text:
                                for kind, piece in splitter.feed(text):
                                    emitted_any = True
                                    if kind == "reasoning":
                                        reasoning.append(piece)
                                        yield {"type": "reasoning", "text": piece}
                                    else:
                                        content.append(piece)
                                        yield {"type": "text", "text": piece}

                            for pos, call in enumerate(delta.get("tool_calls") or []):
                                if not isinstance(call, dict):
                                    continue
                                raw_id = str(call.get("id") or "").strip()
                                raw_idx = call.get("index")
                                idx = raw_idx if isinstance(raw_idx, int) else pos
                                if raw_id:
                                    if raw_id in slot_for_id:
                                        idx = slot_for_id[raw_id]
                                    else:
                                        existing = calls.get(idx)
                                        if existing and existing.get("id") and existing["id"] != raw_id:
                                            idx = (max(calls) + 1) if calls else 0
                                        slot_for_id[raw_id] = idx

                                slot = calls.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                                if raw_id:
                                    slot["id"] = raw_id
                                fn = call.get("function") or {}
                                if fn.get("name"):
                                    slot["name"] += str(fn["name"])
                                if fn.get("arguments"):
                                    slot["arguments"] += str(fn["arguments"])
                                if slot["name"] and idx not in announced_slots:
                                    announced_slots.add(idx)
                                    emitted_any = True
                                    yield {
                                        "type": "tool_call_start",
                                        "index": idx,
                                        "id": slot["id"] or f"call_{idx + 1}",
                                        "name": slot["name"],
                                    }
                            finish_reason = choice.get("finish_reason") or finish_reason
        except ProviderError:
            raise
        except httpx.TimeoutException as exc:
            if not emitted_any and attempt < max_attempts:
                await asyncio.sleep(0.5)
                continue
            raise ProviderError("Der Anbieter hat nicht rechtzeitig geantwortet.", 504) from exc
        except Exception as exc:  # noqa: BLE001
            if not emitted_any and attempt < max_attempts:
                await asyncio.sleep(0.5)
                continue
            raise ProviderError(f"Verbindung zum Anbieter fehlgeschlagen: {exc}", 502) from exc

        if not retry:
            break

    for kind, piece in splitter.flush():
        if kind == "reasoning":
            reasoning.append(piece)
            yield {"type": "reasoning", "text": piece}
        else:
            content.append(piece)
            yield {"type": "text", "text": piece}

    tool_calls = []
    for key in sorted(calls):
        slot = calls[key]
        if not slot["name"]:
            continue
        tool_calls.append(
            {
                "id": slot["id"] or f"call_{len(tool_calls) + 1}",
                "type": "function",
                "function": {"name": slot["name"].strip(), "arguments": slot["arguments"] or "{}"},
            }
        )
    yield {
        "type": "done",
        "content": _join(content),
        "reasoning": _join(reasoning),
        "tool_calls": tool_calls,
        "usage": usage,
        "finish_reason": finish_reason,
        "raw_lines": raw_lines,
    }
