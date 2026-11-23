"""The assistant is part of the portal when agentlab is installed beside Gimel."""

from __future__ import annotations


def test_assistant_routes_are_mounted(client):
    assert client.get("/api/agent/health").json() == {"ok": True}
    assert client.get("/api/version").json()["agent"] is True


def test_assistant_chat_can_be_created(client):
    created = client.post("/api/agent/chats", json={})
    assert created.status_code == 201, created.text
    chat = created.json()
    assert chat["title"]
    listed = client.get("/api/agent/chats").json()["chats"]
    assert any(row["id"] == chat["id"] for row in listed)
