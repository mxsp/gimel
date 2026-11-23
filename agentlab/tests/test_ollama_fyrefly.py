"""Ollama / FyreFly Models: keyless provider, native /api/chat streaming, 32k num_ctx."""

from __future__ import annotations

import json

import pytest

from agentlab import llm, providers as prov_mod
from agentlab.models import AgentProvider


def test_fyrefly_models_seeded_with_32k_context_and_no_key_required(client):
    data = client.get("/api/agent/providers").json()
    assert "fyrefly-models" in data["presets"]
    ff = next((p for p in data["providers"] if p["name"] == "FyreFly Models"), None)
    assert ff is not None
    assert ff["kind"] == "ollama"
    assert ff["requires_key"] is False
    assert ff["context_length"] == 32768
    assert ff["default_model"] == "gpt-oss:20b"


def test_parse_ollama_api_tags_extracts_context_and_size():
    payload = {
        "models": [
            {
                "name": "gpt-oss:20b",
                "details": {"context_length": 131072, "parameter_size": "20.9B"},
            },
            {
                "name": "maternion/sage-a1.5:35b",
                "details": {"context_length": 262144, "parameter_size": "35.5B"},
            },
        ]
    }
    parsed = prov_mod._parse_models(payload)
    assert [m["id"] for m in parsed] == ["gpt-oss:20b", "maternion/sage-a1.5:35b"]
    assert parsed[0]["context_length"] == 131072
    assert parsed[0]["parameter_size"] == "20.9B"


def test_ollama_provider_context_override_header():
    p = AgentProvider(
        name="FyreFly Models",
        kind="ollama",
        base_url="http://192.168.178.54:11434/v1",
        headers={"X-Ollama-Num-Ctx": "65536"},
    )
    assert prov_mod.is_ollama(p) is True
    assert prov_mod.requires_api_key(p) is False
    assert prov_mod.ollama_chat_url(p) == "http://192.168.178.54:11434/api/chat"
    assert prov_mod.provider_context_length(p) == 65536


def test_ollama_stream_sends_num_ctx_32768_and_parses_thinking_and_tools(monkeypatch):
    import asyncio

    captured: dict = {}

    class FakeResp:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def aiter_lines(self):
            lines = [
                {"message": {"role": "assistant", "thinking": "Prüfe..."}, "done": False},
                {"message": {"role": "assistant", "content": "Hallo "}, "done": False},
                {
                    "message": {
                        "role": "assistant",
                        "content": "Welt",
                        "tool_calls": [
                            {"function": {"name": "platform_overview", "arguments": {"days": 7}}}
                        ],
                    },
                    "done": False,
                },
                {
                    "message": {"role": "assistant", "content": ""},
                    "done": True,
                    "done_reason": "stop",
                    "prompt_eval_count": 420,
                    "eval_count": 35,
                },
            ]
            for row in lines:
                yield json.dumps(row)

    class FakeClient:
        def __init__(self, **kwargs):
            captured["headers"] = kwargs.get("headers")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def stream(self, method, url, json=None):
            captured["method"] = method
            captured["url"] = url
            captured["json"] = json
            return FakeResp()

    monkeypatch.setattr(llm.httpx, "AsyncClient", FakeClient)

    p = AgentProvider(
        id=99,
        name="FyreFly Models",
        kind="ollama",
        base_url="http://192.168.178.54:11434/v1",
        models_url="http://192.168.178.54:11434/api/tags",
        default_model="gpt-oss:20b",
        headers={},
    )
    history = [
        {"role": "system", "content": "Du bist Gimel."},
        {"role": "user", "content": "Status?"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "get_kpis", "arguments": '{"days": 30}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "name": "get_kpis", "content": '{"orders": 10}'},
    ]

    async def collect():
        return [
            ev
            async for ev in llm.stream_completion(
                p, model="gpt-oss:20b", messages=history, tools=[], temperature=0.2
            )
        ]

    events = asyncio.run(collect())
    assert captured["url"] == "http://192.168.178.54:11434/api/chat"
    assert captured["json"]["options"]["num_ctx"] == 32768
    # Tool call arguments in history must be converted to dicts for Ollama /api/chat
    assert captured["json"]["messages"][2]["tool_calls"][0]["function"]["arguments"] == {"days": 30}
    assert captured["json"]["messages"][3]["tool_name"] == "get_kpis"

    done = events[-1]
    assert done["type"] == "done"
    assert done["reasoning"] == "Prüfe..."
    assert done["content"] == "Hallo Welt"
    assert done["usage"]["prompt_tokens"] == 420
    assert done["usage"]["completion_tokens"] == 35
    assert done["usage"]["num_ctx"] == 32768
    assert len(done["tool_calls"]) == 1
    assert done["tool_calls"][0]["function"]["name"] == "platform_overview"
    assert json.loads(done["tool_calls"][0]["function"]["arguments"]) == {"days": 7}
