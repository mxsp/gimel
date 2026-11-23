"""Task 43: Live-Gespräch mit Schreibzugriff nur für zurücknehmbare Änderungen (Owner 2026-11-08).

Der Browser kennt den Schalter nur vom Laden; in einem anderen Tab umgelegt,
schickte ein laufendes Live-Gespräch sonst Gehörtes an schreibende Werkzeuge
(security-advisor 2026-11-08).
"""

from __future__ import annotations


def _messages(client, chat_id: int) -> int:
    return len(client.get(f"/api/agent/chats/{chat_id}").json()["messages"])


def test_hands_free_with_write_access_allowed(client):
    chat = client.post("/api/agent/chats", json={"write_mode": True}).json()
    try:
        with client.stream("POST", f"/api/agent/chats/{chat['id']}/messages",
                           json={"content": "Wie viele Aufträge sind offen?", "hands_free": True}) as r:
            assert r.status_code == 200, r.read()
            "".join(r.iter_text())
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_hands_free_offers_only_reversible_writes():
    from agentlab.tools import TOOL_SPECS, execute_tool, schemas_for, ToolError, ToolContext

    class U:  # Administrator mit allen Rechten genügt für die Auswahl
        pass

    from agentlab.tools import live_write_ok
    writes = [s for s in TOOL_SPECS if s.write]
    assert writes
    risky = [s for s in writes if not live_write_ok(s)]
    safe = [s for s in writes if live_write_ok(s)]
    assert risky and safe
    assert all(s.reversible and not s.admin_only for s in safe)
    for name in ("delete_order", "issue_invoice", "delete_user", "set_user_password"):
        spec = next(s for s in TOOL_SPECS if s.name == name)
        assert not live_write_ok(spec), name


def test_hands_free_allowed_without_write_access(client):
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        with client.stream("POST", f"/api/agent/chats/{chat['id']}/messages",
                           json={"content": "Wie viele Aufträge sind offen?", "hands_free": True}) as r:
            assert r.status_code == 200
            "".join(r.iter_text())
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_typed_message_with_write_access_still_works(client):
    chat = client.post("/api/agent/chats", json={"write_mode": True}).json()
    try:
        with client.stream("POST", f"/api/agent/chats/{chat['id']}/messages",
                           json={"content": "Zeige mir die Aufträge."}) as r:
            assert r.status_code == 200
            "".join(r.iter_text())
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_lab_cli_refuses_network_host():
    import pytest

    from agentlab.__main__ import main

    with pytest.raises(SystemExit) as exc:
        main(["serve", "--host", "0.0.0.0", "--no-browser"])
    assert "127.0.0.1" in str(exc.value)


def test_speech_rate_is_passed_and_bounded(client, monkeypatch):
    from agentlab import speech

    seen = {}

    async def fake(text, voice="", backend="lokal", rate=1.0):
        seen["rate"] = rate
        return b"RIFF" + b"\0" * 60

    monkeypatch.setattr(speech, "synthesize", fake)
    assert client.post("/api/agent/speech", json={"text": "Hallo", "rate": 1.3}).status_code == 200
    assert seen["rate"] == 1.3
    assert client.post("/api/agent/speech", json={"text": "Hallo", "rate": 2.0}).status_code == 422
    assert client.post("/api/agent/speech", json={"text": "Hallo", "rate": 0.5}).status_code == 422
