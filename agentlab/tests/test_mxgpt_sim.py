"""Tests für den simulierten mx-GPT-Anbieter (OpenAI-kompatibel)."""

from __future__ import annotations

import json

import httpx
import pytest

from agentlab.mxgpt_sim import serve_in_thread


@pytest.fixture(scope="module")
def sim():
    server, _thread = serve_in_thread("127.0.0.1", 0, ["mx-gpt", "mx-gpt-mini"])
    host, port = server.server_address[:2]
    yield f"http://{host}:{port}"
    server.shutdown()
    server.server_close()


def test_models_and_health(sim):
    models = httpx.get(f"{sim}/v1/models", timeout=5).json()
    assert [m["id"] for m in models["data"]] == ["mx-gpt", "mx-gpt-mini"]
    assert httpx.get(f"{sim}/health", timeout=5).json()["status"] == "ok"


def test_chat_completion(sim):
    payload = {
        "model": "mx-gpt",
        "messages": [{"role": "user", "content": "Wie voll ist die Halle?"}],
    }
    data = httpx.post(f"{sim}/v1/chat/completions", json=payload, timeout=5).json()
    assert data["object"] == "chat.completion"
    assert data["model"] == "mx-gpt"
    content = data["choices"][0]["message"]["content"]
    assert "mx-GPT-Simulation" in content
    assert "Wie voll ist die Halle?" in content
    assert data["usage"]["total_tokens"] >= 1


def test_streaming_sse(sim):
    payload = {
        "model": "mx-gpt-mini",
        "stream": True,
        "messages": [{"role": "user", "content": "Hallo"}],
    }
    with httpx.stream("POST", f"{sim}/v1/chat/completions", json=payload, timeout=5) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        chunks = [line[6:] for line in response.iter_lines() if line.startswith("data: ")]

    assert chunks[-1] == "[DONE]"
    deltas = [json.loads(c) for c in chunks[:-1]]
    text = "".join(
        d["choices"][0]["delta"].get("content", "")
        for d in deltas
        if d.get("choices")
    )
    assert "mx-GPT-Simulation" in text
    assert deltas[-1]["choices"][0]["finish_reason"] == "stop"


def test_tool_call_trigger(sim):
    payload = {
        "model": "mx-gpt",
        "messages": [{
            "role": "user",
            "content": '[tool:get_station_load {"station_id": 3}] Bitte prüfen.',
        }],
    }
    data = httpx.post(f"{sim}/v1/chat/completions", json=payload, timeout=5).json()
    choice = data["choices"][0]
    assert choice["finish_reason"] == "tool_calls"
    call = choice["message"]["tool_calls"][0]
    assert call["function"]["name"] == "get_station_load"
    assert json.loads(call["function"]["arguments"]) == {"station_id": 3}


def test_preset_points_to_simulation():
    from agentlab.providers import PRESETS

    preset = PRESETS["mx-gpt"]
    assert preset["base_url"].endswith("/v1")
    assert preset["models_url"] == f"{preset['base_url']}/models"
    assert preset["requires_key"] == "false"
