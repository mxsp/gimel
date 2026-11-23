"""Vorlagen und „neu erzeugen / bearbeiten“ (task 36 D+E)."""

from __future__ import annotations

import pytest


def _worker_client(client, password):
    """Ein zweiter Client als Werker der Demo."""
    from fastapi.testclient import TestClient

    from agentlab.app import create_lab_app
    from gimel.db import SessionLocal
    from gimel.models import Role, User
    from gimel.security import hash_password

    with SessionLocal() as db:
        worker = db.query(User).filter(User.email == "prompt-worker@example.test").first()
        if worker is None:
            worker = User(email="prompt-worker@example.test", name="Werker Test",
                          role=Role.worker, password_hash=hash_password("Werker-Test-123!"))
            db.add(worker)
            db.commit()
    c = TestClient(create_lab_app())
    r = c.post("/api/auth/login", data={"username": "prompt-worker@example.test",
                                       "password": "Werker-Test-123!"})
    assert r.status_code == 200, r.text
    c.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
    return c


def test_prompt_crud_and_audit(client):
    from gimel.db import SessionLocal
    from gimel.models import AuditLog

    listed = client.get("/api/agent/prompts").json()
    assert listed["can_share"] is True
    assert any(p["key"] == "today" for p in listed["builtin"])
    created = client.post("/api/agent/prompts",
                          json={"title": "Wochenstart", "text": "Was steht an?"}).json()
    assert created["own"] and created["editable"] and not created["shared"]
    updated = client.put(f"/api/agent/prompts/{created['id']}",
                         json={"text": "Was steht diese Woche an?", "shared": True}).json()
    assert updated["shared"] is True and updated["text"].endswith("Woche an?")
    assert client.delete(f"/api/agent/prompts/{created['id']}").status_code == 200
    with SessionLocal() as db:
        actions = {a.action for a in db.query(AuditLog)
                   .filter(AuditLog.entity == "agent_prompt",
                           AuditLog.entity_id == str(created["id"])).all()}
    assert actions == {"agent_prompt_create", "agent_prompt_update", "agent_prompt_delete"}


def test_prompt_text_is_encrypted_column():
    from agentlab.models import AgentPrompt
    from gimel.fieldcrypt import EncryptedText

    column = AgentPrompt.__table__.c.text
    assert isinstance(column.type, EncryptedText)


def test_worker_cannot_share_or_touch_foreign_prompts(client, password):
    worker = _worker_client(client, password)
    try:
        assert worker.post("/api/agent/prompts", json={"title": "x", "text": "y", "shared": True}
                           ).status_code == 403
        own = worker.post("/api/agent/prompts", json={"title": "Meine", "text": "privat"}).json()
        admin_private = client.post("/api/agent/prompts",
                                    json={"title": "Admin privat", "text": "geheim"}).json()
        admin_shared = client.post("/api/agent/prompts",
                                   json={"title": "Team", "text": "für alle", "shared": True}).json()
        listed = worker.get("/api/agent/prompts").json()
        ids = {p["id"] for p in listed["prompts"]}
        assert own["id"] in ids and admin_shared["id"] in ids
        assert admin_private["id"] not in ids
        assert listed["can_share"] is False
        assert all(p["key"] != "quote" for p in listed["builtin"])
        assert worker.put(f"/api/agent/prompts/{admin_shared['id']}",
                          json={"text": "überschrieben"}).status_code == 403
        assert worker.delete(f"/api/agent/prompts/{admin_private['id']}").status_code == 404
        assert worker.put(f"/api/agent/prompts/{own['id']}", json={"shared": True}).status_code == 403
        # Admin sieht die private Vorlage des Werkers nicht.
        assert own["id"] not in {p["id"] for p in client.get("/api/agent/prompts").json()["prompts"]}
        for pid in (admin_private["id"], admin_shared["id"]):
            client.delete(f"/api/agent/prompts/{pid}")
        worker.delete(f"/api/agent/prompts/{own['id']}")
    finally:
        worker.close()


def test_prompt_limits(client):
    assert client.post("/api/agent/prompts", json={"title": "", "text": "x"}).status_code == 422
    assert client.post("/api/agent/prompts",
                       json={"title": "t", "text": "x" * 4001}).status_code == 422


@pytest.fixture()
def chat_with_turns(client):
    from agentlab.models import AgentAttachment, AgentMessage
    from gimel.db import SessionLocal

    chat = client.post("/api/agent/chats", json={}).json()
    with SessionLocal() as db:
        rows = [
            AgentMessage(chat_id=chat["id"], role="user", content="Erste Frage"),
            AgentMessage(chat_id=chat["id"], role="assistant", content="Erste Antwort",
                         usage={"prompt_tokens": 10, "completion_tokens": 5}),
            AgentMessage(chat_id=chat["id"], role="user", content="Zweite Frage"),
            AgentMessage(chat_id=chat["id"], role="assistant", content="Zweite Antwort"),
        ]
        db.add_all(rows)
        db.flush()
        db.add(AgentAttachment(chat_id=chat["id"], message_id=rows[2].id, filename="a.txt",
                               text="Anhang", chars=6))
        db.commit()
        ids = [r.id for r in rows]
    yield chat, ids
    client.delete(f"/api/agent/chats/{chat['id']}")


def test_rewind_hides_from_the_question_on(client, chat_with_turns):
    chat, ids = chat_with_turns
    r = client.post(f"/api/agent/chats/{chat['id']}/rewind", json={"message_id": ids[2]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["content"] == "Zweite Frage"
    assert body["hidden"] == 2
    assert len(body["attachment_ids"]) == 1
    detail = client.get(f"/api/agent/chats/{chat['id']}").json()
    assert [m["content"] for m in detail["messages"]] == ["Erste Frage", "Erste Antwort"]
    # Der Anhang ist wieder offen und geht mit der nächsten Frage mit.
    assert [a["id"] for a in detail["attachments"]] == body["attachment_ids"]
    # Nochmals dieselbe Frage: schon ausgeblendet.
    assert client.post(f"/api/agent/chats/{chat['id']}/rewind",
                       json={"message_id": ids[2]}).status_code == 404
    # Eine Antwort lässt sich nicht als Frage zurückspulen.
    assert client.post(f"/api/agent/chats/{chat['id']}/rewind",
                       json={"message_id": ids[1]}).status_code == 404


def test_rewind_history_skips_hidden(client, chat_with_turns):
    from agentlab.models import AgentChat
    from agentlab.runner import _history
    from gimel.db import SessionLocal

    chat, ids = chat_with_turns
    client.post(f"/api/agent/chats/{chat['id']}/rewind", json={"message_id": ids[2]})
    with SessionLocal() as db:
        history = _history(db, db.get(AgentChat, chat["id"]))
    assert all("Zweite" not in str(m.get("content")) for m in history)


def test_rewind_is_owner_only(client, password, chat_with_turns):
    chat, ids = chat_with_turns
    worker = _worker_client(client, password)
    try:
        assert worker.post(f"/api/agent/chats/{chat['id']}/rewind",
                           json={"message_id": ids[0]}).status_code == 404
    finally:
        worker.close()
