"""Regressionstests für die Agent-Lab- & Copilot-Korrekturen (fix/lab)."""

from __future__ import annotations

import asyncio
import json
import os
import weakref

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_config_reports_voice_enabled_accurately(client, monkeypatch):
    # Im Labor-App-Kontext ist voice_router eingebunden.
    res = client.get("/api/agent/config")
    assert res.status_code == 200, res.text
    assert res.json()["voice_enabled"] is True

    # Ohne voice_router (wie im Standard-Portal ohne GIMEL_VOICE=1) ist voice_enabled False.
    from gimel import agent_bridge

    monkeypatch.delenv("GIMEL_VOICE", raising=False)
    agent_router, _ = agent_bridge.load()
    assert agent_router is not None
    portal_like = FastAPI()
    portal_like.include_router(agent_router)
    # Auth-Abhängigkeiten über das bestehende Lab-App-Muster umgehen: Admin direkt einhängen.
    from gimel.db import SessionLocal
    from gimel.models import User
    from gimel import demo
    from gimel.security import require_worker

    with SessionLocal() as db:
        admin_user = db.query(User).filter(User.email == demo.ADMIN_EMAIL).one()
    portal_like.dependency_overrides[require_worker] = lambda: admin_user

    with TestClient(portal_like) as pc:
        cfg = pc.get("/api/agent/config")
        assert cfg.status_code == 200, cfg.text
        assert cfg.json()["voice_enabled"] is False
        assert pc.get("/api/agent/voice").status_code == 404


def test_provider_models_falls_back_to_default_model_when_offline(client, monkeypatch):
    from agentlab import providers as prov_mod
    from agentlab.models import AgentProvider
    from gimel.db import SessionLocal

    with SessionLocal() as db:
        row = AgentProvider(
            name="Offline Ollama Test",
            kind="ollama",
            base_url="http://192.168.178.250:11434/v1",
            models_url="http://192.168.178.250:11434/api/tags",
            default_model="gpt-oss:20b",
            enabled=True,
            is_default=False,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        pid = row.id

    try:
        # 1) Verbindungsfehler → HTTP 200 mit default_model + Warnung
        class FailingClient:
            def __init__(self, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def get(self, url):
                raise httpx.ConnectError("offline")

        monkeypatch.setattr(prov_mod.httpx, "AsyncClient", FailingClient)
        r1 = client.get(f"/api/agent/providers/{pid}/models")
        assert r1.status_code == 200, r1.text
        body1 = r1.json()
        assert body1["models"] == [{"id": "gpt-oss:20b"}]
        assert body1["warning"]

        # 2) HTTP >= 400 → ebenfalls Fallback statt 502
        class ErrorRespClient:
            def __init__(self, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def get(self, url):
                return httpx.Response(503, content=b"unavailable")

        monkeypatch.setattr(prov_mod.httpx, "AsyncClient", ErrorRespClient)
        r2 = client.get(f"/api/agent/providers/{pid}/models")
        assert r2.status_code == 200, r2.text
        assert r2.json()["models"] == [{"id": "gpt-oss:20b"}]
        assert "503" in r2.json()["warning"]
    finally:
        with SessionLocal() as db:
            obj = db.get(AgentProvider, pid)
            if obj is not None:
                db.delete(obj)
                db.commit()


def test_proposal_cas_and_standalone_change_revert(client, admin):
    from agentlab.models import AgentActionProposal, AgentChange
    from gimel.db import SessionLocal
    from gimel.services import settings_store

    with SessionLocal() as db:
        old_val = settings_store.get(db, "batch_mode")
        prop = AgentActionProposal(
            kind="setting",
            title="Test CAS Proposal",
            rationale="Unit-Test",
            tool_name="update_setting",
            arguments={"key": "batch_mode", "value": "sofort" if old_val != "sofort" else "sammel"},
            impact_summary={},
            status="pending",
        )
        db.add(prop)
        db.commit()
        db.refresh(prop)
        pid = prop.id

    try:
        # Erste Freigabe läuft durch und legt AgentChange ohne chat_id an.
        ok = client.post(f"/api/agent/proposals/{pid}/approve", json={"note": "ok"})
        assert ok.status_code == 200, ok.text
        change_id = ok.json()["proposal"]["change_id"]
        assert change_id is not None

        # Zweite Freigabe wird abgewiesen (409).
        dup = client.post(f"/api/agent/proposals/{pid}/approve", json={"note": "dup"})
        assert dup.status_code == 409

        # Rücknahme funktioniert über /api/agent/changes/{change_id}/revert auch ohne chat_id.
        rev = client.post(f"/api/agent/changes/{change_id}/revert")
        assert rev.status_code == 200, rev.text
        assert rev.json()["status"] == "reverted"
    finally:
        with SessionLocal() as db:
            p = db.get(AgentActionProposal, pid)
            if p is not None:
                db.delete(p)
            for c in db.query(AgentChange).filter(AgentChange.tool == "update_setting", AgentChange.chat_id.is_(None)).all():
                db.delete(c)
            db.commit()


def test_schemas_for_gating_aliases_and_subagent_helpers(admin):
    from agentlab.models import AgentChat
    from agentlab.subagent_runner import wait_for_subagents
    from agentlab.tools import TOOL_SPECS, TOOLS, schemas_for
    from gimel.db import SessionLocal

    # 1) Nur ein Schema für set_order_due_date in TOOL_SPECS, aber Aliase bleiben in TOOLS ausführbar.
    spec_names = [s.name for s in TOOL_SPECS]
    assert "set_order_due_date" in spec_names
    for alias in ("update_order_due_date", "change_order_due_date", "set_order_due"):
        assert alias not in spec_names
        assert alias in TOOLS

    # 2) Subagent-Werkzeuge nur im Orchestrator-Modus sichtbar.
    classic_names = {t["function"]["name"] for t in schemas_for(admin, True, is_orchestrator=False)}
    assert "dispatch_subagent" not in classic_names
    assert "wait_for_subagents" not in classic_names

    orch_names = {t["function"]["name"] for t in schemas_for(admin, True, is_orchestrator=True)}
    assert {"dispatch_subagent", "list_subagents", "wait_for_subagents", "dispose_subagent"} <= orch_names

    # 3) wait_for_subagents unterscheidet leere Liste (timed_out=False) sauber.
    with SessionLocal() as db:
        chat = AgentChat(user_id=admin.id, title="Empty Subagent Test", kind="orchestrator")
        db.add(chat)
        db.commit()
        cid = chat.id
    try:
        rows, timed_out = wait_for_subagents(cid, timeout_s=1.0)
        assert rows == []
        assert timed_out is False
    finally:
        with SessionLocal() as db:
            c = db.get(AgentChat, cid)
            if c is not None:
                db.delete(c)
                db.commit()


def test_sandbox_symlink_nofollow_and_speech_weak_slots(client, tmp_path):
    from agentlab import sandbox as sandbox_service
    from agentlab import speech as speech_service

    # 1) Sandbox blockiert Symlink-Schreiben/Lesen mit O_NOFOLLOW
    chat = client.post("/api/agent/chats", json={}).json()
    cid = chat["id"]
    try:
        created = client.post(f"/api/agent/chats/{cid}/sandbox", json={})
        assert created.status_code == 201, created.text
        session = sandbox_service.get_sandbox(cid)
        assert session is not None
        outside = tmp_path / "secret.txt"
        outside.write_text("top-secret", encoding="utf-8")
        link_path = session.workspace_dir / "escape.txt"
        os.symlink(outside, link_path)

        with pytest.raises(sandbox_service.SandboxError):
            sandbox_service.read_workspace_file(cid, "escape.txt")
        with pytest.raises(sandbox_service.SandboxError):
            sandbox_service.write_workspace_file(None, cid, 0, "escape.txt", "overwrite")
        assert outside.read_text(encoding="utf-8") == "top-secret"
    finally:
        client.delete(f"/api/agent/chats/{cid}")

    # 2) Speech _piper_slots nutzt WeakKeyDictionary je Event-Loop
    assert isinstance(speech_service._piper_slots, weakref.WeakKeyDictionary)

    async def get_slot():
        return speech_service._slots()

    sem = asyncio.run(get_slot())
    assert isinstance(sem, asyncio.Semaphore)
