from __future__ import annotations

import json

from agentlab.providers import _parse_models


def test_provider_is_seeded_without_key(client):
    data = client.get("/api/agent/providers").json()
    assert data["providers"]
    default = next(p for p in data["providers"] if p["is_default"])
    assert default["kind"] == "opencode-go"
    assert default["base_url"] == "https://opencode.ai/inference/go/openai/v1"
    assert "api_key" not in json.dumps(data).lower()
    assert default["has_key"] is False


def test_chat_crud_and_rename(client):
    created = client.post("/api/agent/chats", json={})
    assert created.status_code == 201, created.text
    chat = created.json()
    try:
        assert client.get(f"/api/agent/chats/{chat['id']}").status_code == 200
        renamed = client.patch(f"/api/agent/chats/{chat['id']}", json={"title": "Lager prüfen"})
        assert renamed.status_code == 200
        assert renamed.json()["title"] == "Lager prüfen"
    finally:
        assert client.delete(f"/api/agent/chats/{chat['id']}").status_code == 200
    assert client.get(f"/api/agent/chats/{chat['id']}").status_code == 404


def test_tools_are_role_and_write_filtered(client):
    tools = client.get("/api/agent/tools").json()["tools"]
    names = {t["name"] for t in tools}
    assert "search_orders" in names and "release_order" in names
    assert "update_setting" in names  # Admin
    release = next(t for t in tools if t["name"] == "release_order")
    assert release["write"] is True and release["reversible"] is True
    assert next(t for t in tools if t["name"] == "start_batch_run")["reversible"] is False


def test_key_is_sealed_and_never_returned(client):
    providers = client.get("/api/agent/providers").json()["providers"]
    pid = providers[0]["id"]
    try:
        changed = client.put(f"/api/agent/providers/{pid}", json={"api_key": "sk-test-secret-123"})
        assert changed.status_code == 200, changed.text
        assert "sk-test-secret-123" not in changed.text
        assert changed.json()["has_key"] is True
        from agentlab.models import AgentProvider
        from gimel.db import SessionLocal

        with SessionLocal() as db:
            row = db.get(AgentProvider, pid)
            assert row.api_key_enc and row.api_key_enc.startswith("v1:")
            assert "sk-test-secret-123" not in row.api_key_enc
    finally:
        assert client.delete(f"/api/agent/providers/{pid}/key").status_code == 200


def test_speech_route_local_by_default_edge_only_on_request(client, monkeypatch, tmp_path):
    from agentlab import speech

    # Eigener, leerer Stimmordner: der Test hängt nicht an installierten Stimmen.
    monkeypatch.setenv("GIMEL_VOICE_PIPER_DIR", str(tmp_path))
    info = client.get("/api/agent/speech")
    assert info.status_code == 200, info.text
    assert info.json()["backend"] == "lokal"
    assert info.json()["voices"] == []

    calls: list[tuple[str, str, str]] = []

    async def fake_synthesize(text: str, voice: str = "", backend: str = "lokal") -> bytes:
        calls.append((text, voice, backend))
        return b"RIFF-test-audio" if backend == "lokal" else b"ID3-test-audio"

    monkeypatch.setattr(speech, "synthesize", fake_synthesize)
    spoken = client.post("/api/agent/speech", json={"text": "Guten Tag."})
    assert spoken.status_code == 200, spoken.text
    assert spoken.headers["content-type"].startswith("audio/wav")
    assert calls[-1] == ("Guten Tag.", "", "lokal")

    # Microsoft nur, wenn ein Admin es ausdrücklich einstellt.
    assert client.put("/api/agent/settings",
                      json={"values": {"agent_tts_backend": "edge"}}).status_code == 200
    try:
        assert client.get("/api/agent/speech").json()["backend"] == "edge"
        spoken = client.post("/api/agent/speech", json={"text": "Guten Tag."})
        assert spoken.headers["content-type"].startswith("audio/mpeg")
        assert calls[-1][2] == "edge"
    finally:
        client.post("/api/agent/settings/reset", json={"keys": ["agent_tts_backend"]})
    assert client.get("/api/agent/speech").json()["backend"] == "lokal"
    assert client.put("/api/agent/settings",
                      json={"values": {"agent_tts_backend": "google"}}).status_code == 422

    async def missing(text: str, voice: str = "", backend: str = "lokal") -> bytes:
        raise speech.SpeechUnavailable("kein TTS installiert")

    monkeypatch.setattr(speech, "synthesize", missing)
    failed = client.post("/api/agent/speech", json={"text": "Guten Tag."})
    assert failed.status_code == 503
    assert "kein TTS" in failed.json()["detail"]


def test_local_speech_without_voice_explains_download(monkeypatch, tmp_path):
    import asyncio

    import pytest

    from agentlab import speech

    monkeypatch.setenv("GIMEL_VOICE_PIPER_DIR", str(tmp_path))
    monkeypatch.setattr(speech, "_piper_installed", lambda: True)
    assert speech.piper_voices() == {}
    assert speech.available("lokal") is False
    with pytest.raises(speech.SpeechUnavailable, match="Keine Piper-Stimme"):
        asyncio.run(speech.synthesize("Hallo.", "", "lokal"))
    # Eine Stimme gilt erst mit ihrer .json als vorhanden.
    (tmp_path / "de_DE-thorsten-medium.onnx").write_bytes(b"x")
    assert speech.piper_voices() == {}
    (tmp_path / "de_DE-thorsten-medium.onnx.json").write_text("{}")
    assert list(speech.piper_voices()) == ["de_DE-thorsten-medium"]
    assert speech.default_voice("lokal") == "de_DE-thorsten-medium"
    assert speech.media_type("lokal") == "audio/wav"
    assert speech.media_type("edge") == "audio/mpeg"


def test_chat_without_key_streams_an_explanation(client):
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        with client.stream("POST", f"/api/agent/chats/{chat['id']}/messages",
                           json={"content": "Zeige mir die Aufträge."}) as r:
            assert r.status_code == 200
            text = "".join(r.iter_text())
        assert "event: error" in text
        assert "API-Schlüssel" in text
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_streaming_loop_executes_a_read_tool(client, monkeypatch):
    import agentlab.runner as runner

    providers = client.get("/api/agent/providers").json()["providers"]
    pid = providers[0]["id"]
    client.put(f"/api/agent/providers/{pid}", json={"api_key": "sk-test-stream"})
    state = {"n": 0}

    async def fake(provider, **kwargs):
        state["n"] += 1
        if state["n"] == 1:
            yield {
                "type": "done", "content": "",
                "tool_calls": [{"id": "call_1", "type": "function",
                                "function": {"name": "platform_overview", "arguments": "{}"}}],
                "usage": {}, "finish_reason": "tool_calls",
            }
        else:
            yield {"type": "text", "text": "Alles gelesen."}
            yield {"type": "done", "content": "Alles gelesen.", "tool_calls": [],
                   "usage": {}, "finish_reason": "stop"}

    monkeypatch.setattr(runner, "stream_completion", fake)
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        with client.stream("POST", f"/api/agent/chats/{chat['id']}/messages",
                           json={"content": "Wie steht der Betrieb?"}) as r:
            assert r.status_code == 200
            text = "".join(r.iter_text())
        assert "event: tool_call" in text
        assert "event: tool_result" in text
        assert "Alles gelesen." in text
        assert "event: done" in text
        detail = client.get(f"/api/agent/chats/{chat['id']}").json()
        assert any(m["role"] == "tool" for m in detail["messages"])
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")
        client.delete(f"/api/agent/providers/{pid}/key")


def test_setting_change_and_rollback(client):
    from agentlab.models import AgentChat
    from agentlab.tools import ToolContext, execute_tool
    from gimel.db import SessionLocal
    from gimel.models import Setting, User

    chat = client.post("/api/agent/chats", json={"write_mode": True}).json()
    try:
        from gimel import demo

        with SessionLocal() as db:
            user = db.query(User).filter(User.email == demo.ADMIN_EMAIL).one()
            row = db.get(AgentChat, chat["id"])
            ctx = ToolContext(db=db, user=user, chat=row)
            result = execute_tool(ctx, "update_setting",
                                  {"key": "delivery_days", "value": "4"},
                                  write_mode=True)
            assert result["change_id"]
            assert db.get(Setting, "delivery_days").value == "4"
            change_id = result["change_id"]
        reverted = client.post(f"/api/agent/chats/{chat['id']}/changes/{change_id}/revert")
        assert reverted.status_code == 200, reverted.text
        assert reverted.json()["status"] == "reverted"
        with SessionLocal() as db:
            assert db.get(Setting, "delivery_days").value == "3"
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_work_order_status_and_nested_rollback(client):
    from agentlab.models import AgentChat
    from agentlab.tools import ToolContext, execute_tool
    from gimel import demo
    from gimel.db import SessionLocal
    from gimel.models import User, WorkOrder, WorkOrderStatus

    work_orders = client.get("/api/production/work-orders").json()
    candidate = next((w for w in work_orders if w["status"] == "open"), None)
    assert candidate, "Demo needs an open work order"
    chat = client.post("/api/agent/chats", json={"write_mode": True}).json()
    try:
        with SessionLocal() as db:
            user = db.query(User).filter(User.email == demo.ADMIN_EMAIL).one()
            row = db.get(AgentChat, chat["id"])
            ctx = ToolContext(db=db, user=user, chat=row)
            result = execute_tool(
                ctx, "set_work_order_status",
                {"work_order_no": candidate["no"], "status": "running"},
                write_mode=True,
            )
            change_id = result["change_id"]
            assert db.query(WorkOrder).filter(WorkOrder.no == candidate["no"]).one().status \
                == WorkOrderStatus.running
        reverted = client.post(f"/api/agent/chats/{chat['id']}/changes/{change_id}/revert")
        assert reverted.status_code == 200, reverted.text
        with SessionLocal() as db:
            assert db.query(WorkOrder).filter(WorkOrder.no == candidate["no"]).one().status \
                == WorkOrderStatus.open
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_parse_models_accepts_openai_and_plain_lists():
    assert [m["id"] for m in _parse_models({"data": [{"id": "b"}, {"id": "a"}]})] == ["a", "b"]
    assert [m["id"] for m in _parse_models([{"name": "x"}])] == ["x"]

def test_registry_has_broad_unique_tool_coverage(client):
    from agentlab.tools import TOOL_SPECS

    names = [t.name for t in TOOL_SPECS]
    assert len(names) >= 70, "The lab should cover the app broadly."
    assert len(names) == len(set(names))
    assert sum(1 for t in TOOL_SPECS if t.write) >= 35
    assert all(t.description and t.parameters.get("type") == "object" for t in TOOL_SPECS)
    assert any(t.name == "get_production_queue" for t in TOOL_SPECS)
    assert any(t.name == "set_plate_status" for t in TOOL_SPECS)
    assert any(t.name == "create_hall" for t in TOOL_SPECS)


def test_create_chat_normalizes_whitespace_title(client):
    res = client.post("/api/agent/chats", json={"title": "   "})
    assert res.status_code == 201, res.text
    chat = res.json()
    try:
        assert chat["title"] == "Neuer Chat"
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")
