"""Tests für Multi-Provider-Unterstützung (Google Gemini, Anthropic, OpenRouter, DeepSeek, Mistral, Groq, xAI, Ollama …)."""

from __future__ import annotations

import json


def test_presets_include_google_anthropic_and_local_providers(client):
    data = client.get("/api/agent/providers").json()
    presets = data["presets"]
    for key in (
        "google-gemini", "google-gemini-native", "anthropic", "openai",
        "openrouter", "opencode-go", "deepseek", "mistral", "groq",
        "xai", "perplexity", "together", "azure-openai",
        "ollama", "lmstudio", "local-openai", "mx-gpt",
    ):
        assert key in presets, key
        assert presets[key]["base_url"].startswith(("http://", "https://"))


def test_provider_protocols_urls_headers_and_env_keys(monkeypatch):
    from agentlab.models import AgentProvider
    from agentlab.providers import (
        _parse_models,
        _request_headers,
        api_key,
        chat_url,
        key_source,
        models_url,
        provider_protocol,
        requires_key,
    )

    monkeypatch.setenv("GEMINI_API_KEY", "AIza-test-gemini-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key")
    monkeypatch.delenv("AGENT_API_KEY", raising=False)
    monkeypatch.delenv("GIMEL_AGENT_API_KEY", raising=False)

    # Google Gemini (OpenAI-kompatibel)
    g_oai = AgentProvider(
        id=10, name="Google Gemini", kind="google-gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        models_url="", default_model="gemini-2.5-flash",
    )
    assert provider_protocol(g_oai) == "openai"
    assert requires_key(g_oai) is True
    assert api_key(g_oai) == "AIza-test-gemini-key"
    assert key_source(g_oai) == "env"
    assert chat_url(g_oai) == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    assert _request_headers(g_oai)["Authorization"] == "Bearer AIza-test-gemini-key"

    # Google Gemini (Native API)
    g_nat = AgentProvider(
        id=11, name="Google Gemini Native", kind="google-gemini-native",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        models_url="", default_model="gemini-2.5-pro",
    )
    assert provider_protocol(g_nat) == "gemini"
    assert chat_url(g_nat, "gemini-2.5-pro") == (
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
    )
    assert _request_headers(g_nat)["x-goog-api-key"] == "AIza-test-gemini-key"

    # Anthropic (Native Messages API)
    ant = AgentProvider(
        id=12, name="Anthropic", kind="anthropic",
        base_url="https://api.anthropic.com/v1",
        models_url="", default_model="claude-sonnet-4-5-20250929",
    )
    assert provider_protocol(ant) == "anthropic"
    assert chat_url(ant) == "https://api.anthropic.com/v1/messages"
    assert models_url(ant) == "https://api.anthropic.com/v1/models"
    ant_headers = _request_headers(ant)
    assert ant_headers["x-api-key"] == "sk-ant-test-key"
    assert ant_headers["anthropic-version"] == "2023-06-01"
    assert "Authorization" not in ant_headers

    # OpenCode Go bekommt keinen fremden GEMINI_API_KEY
    oc = AgentProvider(
        id=13, name="OpenCode Go", kind="opencode-go",
        base_url="https://opencode.ai/inference/go/openai/v1",
        models_url="", default_model="deepseek-v4.1-flash",
    )
    assert api_key(oc) == ""
    assert key_source(oc) == "none"

    # Azure OpenAI behält Query-Parameter (?api-version=...) und nutzt api-key Header
    az = AgentProvider(
        id=14, name="Azure", kind="azure-openai",
        base_url="https://demo.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21",
        models_url="", default_model="gpt-4o",
    )
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "az-secret")
    assert chat_url(az) == "https://demo.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21"
    assert _request_headers(az)["api-key"] == "az-secret"

    # Lokale Anbieter brauchen keinen Schlüssel
    ol = AgentProvider(
        id=15, name="Ollama", kind="ollama",
        base_url="http://127.0.0.1:11434/v1", models_url="", default_model="llama3.2",
    )
    assert requires_key(ol) is False
    assert api_key(ol) == ""

    # Google Gemini Modell-Parser entfernt "models/" und filtert Embeddings heraus
    parsed = _parse_models({
        "models": [
            {
                "name": "models/gemini-2.5-flash",
                "displayName": "Gemini 2.5 Flash",
                "inputTokenLimit": 1048576,
                "supportedGenerationMethods": ["generateContent"],
            },
            {
                "name": "models/text-embedding-004",
                "supportedGenerationMethods": ["embedContent"],
            },
        ]
    }, kind="google-gemini-native")
    assert len(parsed) == 1
    assert parsed[0]["id"] == "gemini-2.5-flash"
    assert parsed[0]["name"] == "Gemini 2.5 Flash"
    assert parsed[0]["context_length"] == 1048576


def test_anthropic_and_gemini_payload_translators():
    from agentlab.llm import _to_anthropic_messages, _to_anthropic_tools, _to_gemini_payload

    messages = [
        {"role": "system", "content": "Du bist Gimel."},
        {"role": "user", "content": "Zeige Auftrag 1"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "get_order", "arguments": json.dumps({"order_no": "AB-1"})},
            }],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": json.dumps({"summary": "Gefunden"})},
    ]
    tools = [{
        "type": "function",
        "function": {
            "name": "get_order",
            "description": "Read order",
            "parameters": {
                "type": "object",
                "properties": {"order_no": {"type": "string"}},
                "required": ["order_no"],
                "additionalProperties": False,
            },
        },
    }]

    sys_text, ant_msgs = _to_anthropic_messages(messages)
    assert sys_text == "Du bist Gimel."
    assert ant_msgs[1]["content"][0]["type"] == "tool_use"
    assert ant_msgs[2]["content"][0]["type"] == "tool_result"
    ant_tools = _to_anthropic_tools(tools)
    assert ant_tools[0]["name"] == "get_order"
    assert "input_schema" in ant_tools[0]

    gem = _to_gemini_payload(messages, tools, temperature=0.2, max_tokens=2048)
    assert gem["systemInstruction"]["parts"][0]["text"] == "Du bist Gimel."
    assert gem["contents"][1]["parts"][0]["functionCall"]["name"] == "get_order"
    assert gem["contents"][2]["parts"][0]["functionResponse"]["name"] == "get_order"
    decls = gem["tools"][0]["functionDeclarations"]
    assert decls[0]["name"] == "get_order"
    assert "additionalProperties" not in decls[0]["parameters"]


def test_create_google_and_ollama_providers_via_api(client):
    created_g = client.post("/api/agent/providers", json={
        "name": "Google Gemini",
        "kind": "google-gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "models_url": "https://generativelanguage.googleapis.com/v1beta/openai/models",
        "default_model": "gemini-2.5-flash",
    })
    assert created_g.status_code == 201, created_g.text
    g = created_g.json()
    assert g["protocol"] == "openai"
    assert g["requires_key"] is True

    created_o = client.post("/api/agent/providers", json={
        "name": "Ollama Lokal",
        "kind": "ollama",
        "base_url": "http://127.0.0.1:11434/v1",
        "default_model": "qwen2.5:14b",
    })
    assert created_o.status_code == 201, created_o.text
    o = created_o.json()
    assert o["requires_key"] is False

    # Aufräumen (deaktivieren)
    client.delete(f"/api/agent/providers/{g['id']}")
    client.delete(f"/api/agent/providers/{o['id']}")
