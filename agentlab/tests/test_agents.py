"""Tests für Spezialisten-Agenten (mit & ohne Routinen), Runner-Einbindung und Portal-Integration."""

from __future__ import annotations

from agentlab import runner, tools
from agentlab.models import AgentChat
from gimel.db import SessionLocal
from gimel.models import Role, User


def test_builtin_agents_with_and_without_routines(client):
    res = client.get("/api/agent/agents")
    assert res.status_code == 200, res.text
    data = res.json()
    builtin = data["builtin"]
    assert len(builtin) >= 7

    keys = {a["key"] for a in builtin}
    for expected in (
        "optimierer",
        "planer",
        "buchhaltung",
        "schicht_versand",
        "kunden_service",
        "kalkulator",
        "dashboard_studio",
        "twin_studio",
    ):
        assert expected in keys

    with_routines = [a for a in builtin if a["has_routines"]]
    without_routines = [a for a in builtin if not a["has_routines"]]
    assert len(with_routines) >= 4
    assert len(without_routines) >= 3
    assert all(len(a["template_keys"]) >= 1 for a in with_routines)
    assert all(len(a["template_keys"]) == 0 for a in without_routines)


def test_start_builtin_agent_direct_and_with_routine(client):
    # 1. Direkt-Agent ohne Routine (Kunden- & Angebots-Agent)
    direct = client.post("/api/agent/agents/builtin/kunden_service/start", json={})
    assert direct.status_code == 200, direct.text
    body = direct.json()
    assert body["prompt"] == ""
    chat = body["chat"]
    assert chat["agent_key"] == "kunden_service"
    assert chat["agent_name"] == "Kunden- & Angebots-Agent"
    assert len(chat["agent_starters"]) >= 2

    # 2. Agent mit Routine (Fertigungs-Optimierer + bottleneck_audit)
    with_rt = client.post(
        "/api/agent/agents/builtin/optimierer/start",
        json={"template_key": "bottleneck_audit"},
    )
    assert with_rt.status_code == 200, with_rt.text
    rt_body = with_rt.json()
    assert rt_body["chat"]["agent_key"] == "optimierer"
    assert "Engpass" in rt_body["prompt"]
    assert "Fertigungs-Optimierer" in rt_body["chat"]["title"]

    # Aufräumen
    client.delete(f"/api/agent/chats/{chat['id']}")
    client.delete(f"/api/agent/chats/{rt_body['chat']['id']}")


def test_custom_agent_crud_with_and_without_routines(client):
    # Routine anlegen, um sie mit einem eigenen Agenten zu verknüpfen
    routine_res = client.post("/api/agent/routines", json={
        "name": "OPOS-Mahnlauf-Check",
        "category": "schicht",
        "prompt": "Prüfe offene Rechnungen und Mahnstufen.",
        "steps": ["Offene Posten listen", "Prioritäten sortieren"],
    })
    assert routine_res.status_code == 201, routine_res.text
    rid = routine_res.json()["id"]

    # Eigenen Agenten MIT Routine anlegen
    created = client.post("/api/agent/agents", json={
        "name": "Debitorenbuchhalter",
        "role_title": "Buchhaltung & Mahnwesen",
        "description": "Überwacht offene Posten und Zahlungsziele.",
        "category": "buchhaltung",
        "icon": "euro",
        "color": "#8a5a14",
        "system_prompt": "Du bist Debitorenbuchhalter der Musterwerk GmbH und arbeitest zahlenbasiert.",
        "tool_categories": ["Rechnungen", "Kunden", "Vorschau & Dateien"],
        "has_routines": True,
        "routine_ids": [rid],
        "template_keys": ["kpi_weekly_dashboard"],
        "starter_prompts": ["Welche Rechnungen sind überfällig?", "Top-5 Debitoren nach Betrag"],
        "shared": True,
    })
    assert created.status_code == 201, created.text
    agent = created.json()
    aid = agent["id"]
    assert agent["has_routines"] is True
    assert agent["routine_ids"] == [rid]

    # Eigenen Direkt-Agenten OHNE Routine anlegen
    direct_created = client.post("/api/agent/agents", json={
        "name": "Schnell-Kalkulator",
        "role_title": "Direkte Angebotsprüfung",
        "category": "kunden",
        "system_prompt": "Du prüfst Preise und Lieferzeiten direkt im Gespräch.",
        "tool_categories": ["Kunden", "Aufträge"],
        "has_routines": False,
        "routine_ids": [rid],  # muss bei has_routines=False geleert werden
    })
    assert direct_created.status_code == 201, direct_created.text
    direct_agent = direct_created.json()
    assert direct_agent["has_routines"] is False
    assert direct_agent["routine_ids"] == []

    # Aktualisieren
    upd = client.put(f"/api/agent/agents/{aid}", json={"temperature": "0.2"})
    assert upd.status_code == 200
    assert upd.json()["temperature"] == "0.2"

    # Starten mit verknüpfter Routine
    started = client.post(f"/api/agent/agents/{aid}/start", json={"routine_id": rid})
    assert started.status_code == 200, started.text
    sbody = started.json()
    assert sbody["chat"]["agent_id"] == aid
    assert sbody["chat"]["agent_name"] == "Debitorenbuchhalter"
    assert "OPOS-Mahnlauf-Check" in sbody["prompt"]

    # Chat-Zähler wurde hochgezählt
    listed = client.get("/api/agent/agents").json()["agents"]
    updated_agent = next(a for a in listed if a["id"] == aid)
    assert updated_agent["chat_count"] == 1

    # Aufräumen
    client.delete(f"/api/agent/chats/{sbody['chat']['id']}")
    assert client.delete(f"/api/agent/agents/{aid}").status_code == 200
    assert client.delete(f"/api/agent/agents/{direct_agent['id']}").status_code == 200
    assert client.delete(f"/api/agent/routines/{rid}").status_code == 200


def test_runner_persona_prompt_and_tool_category_boost(client):
    with SessionLocal() as db:
        user = db.query(User).filter(User.role == Role.admin).first()
        assert user is not None
        chat = AgentChat(user_id=user.id, title="Test", write_mode=False)
        prompt = runner._system_prompt(
            db,
            user,
            chat,
            "/app",
            active_agent={
                "name": "Fertigungs-Optimierer",
                "role_title": "OEE & Engpass-Analyst",
                "system_prompt": "Analysiere stets Engpässe und Rüstzeiten zuerst.",
            },
        )
        assert "Fertigungs-Optimierer" in prompt
        assert "Analysiere stets Engpässe und Rüstzeiten zuerst." in prompt

        # Kategorie-Boost: bei Buchhaltungs-Kategorie erhalten Rechnungs-Tools einen klaren Relevanz-Boost
        inv_spec = tools.TOOLS["list_invoices"]
        base_score = tools._tool_relevance(inv_spec, {"hilf"}, "", set(), set())
        boosted_score = tools._tool_relevance(inv_spec, {"hilf"}, "", set(), {"Rechnungen"})
        assert boosted_score >= base_score + 100

        selected = tools.schemas_for(
            user,
            write_mode=False,
            query="Hilf mir bitte",
            preferred_categories={"Rechnungen"},
        )
    names = {s["function"]["name"] for s in selected}
    assert "list_invoices" in names
