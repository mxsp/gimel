"""Werkzeugfamilie Subagenten: nur der Orchestrator darf erzeugen, keine Rekursion."""

from __future__ import annotations

import pytest

from agentlab import tools as _tools  # noqa: F401  (Tools zuerst laden → kein Importkreis)
from agentlab.models import AgentChat, AgentPersona, AgentSubagent
from agentlab.subagent_tools import dispatch_subagent, dispose_subagent, list_subagents, wait_for_subagent_results
from agentlab.tools import ToolContext, ToolError
from gimel.db import SessionLocal
from gimel.models import User


def _chat(db, user, *, kind="orchestrator"):
    chat = AgentChat(user_id=user.id, title="Test", kind=kind)
    db.add(chat)
    db.flush()
    return chat


def test_dispatch_and_list_blocked_for_subagent(password):
    with SessionLocal() as db:
        user = db.query(User).filter(User.email == "admin@musterwerk.local").one_or_none()
        if user is None:
            from gimel import demo
            user = db.query(User).filter(User.email == demo.ADMIN_EMAIL).one()
        parent = _chat(db, user)
        ctx = ToolContext(db=db, user=user, chat=parent)

        made = dispatch_subagent(ctx, {
            "name": "Lager-Checker", "task": "Prüfe den Lagerbestand.",
            "capabilities": ["analyse", "lager & werkstoffe", "unbekannt"],
        })
        assert made["ok"] is True
        assert "unbekannt" not in made["capabilities"]
        assert made["chat_id"] == parent.id

        listed = list_subagents(ctx, {})
        assert listed["count"] == 1
        assert listed["subagents"][0]["name"] == "Lager-Checker"

        # Kein zweiter Chat wurde angelegt, der orchestrator bleibt durchgängig.
        assert made["chat_id"] == parent.id
        with pytest.raises(ToolError):
            dispatch_subagent(ToolContext(db=db, user=user, chat=parent), {})  # fehlender task

        # Nach dispose_subagent sind sowohl AgentSubagent als auch temporäre Persona gelöscht.
        sub_id = made["subagent_id"]
        sub_row = db.get(AgentSubagent, sub_id)
        assert sub_row is not None
        persona_id = sub_row.persona_id
        assert persona_id is not None
        disposed = dispose_subagent(ctx, {"subagent_id": sub_id})
        assert disposed["ok"] is True
        assert db.get(AgentSubagent, sub_id) is None
        assert db.get(AgentPersona, persona_id) is None
        assert list_subagents(ctx, {})["count"] == 0

        # Nach wait_for_subagent_results werden erledigte temporäre Subagenten automatisch gelöscht.
        made2 = dispatch_subagent(ctx, {
            "name": "Temp-Prüfer", "task": "Prüfe Lagerbestand EPDM und Plotter 1.",
            "capabilities": ["inventory", "stations"],
        })
        assert "lager & werkstoffe" in made2["capabilities"]
        assert "halle & stationen" in made2["capabilities"]
        sub2 = db.get(AgentSubagent, made2["subagent_id"])
        assert sub2 is not None
        p2_id = sub2.persona_id
        waited = wait_for_subagent_results(ctx, {"timeout_s": 5})
        assert waited["ok"] is True
        assert waited["purged"] == 1
        assert waited["results"][0]["result"]
        assert db.get(AgentSubagent, made2["subagent_id"]) is None
        assert db.get(AgentPersona, p2_id) is None
        db.delete(parent)
        db.commit()


def test_knowledge_graph_rebuild_and_insights(password):
    from agentlab.knowledge_graph import (
        add_custom_edge,
        add_insight,
        delete_edge,
        delete_node,
        find_shortest_path,
        get_graph,
        rebuild_platform_graph,
        update_insight,
    )

    with SessionLocal() as db:
        summary = rebuild_platform_graph(db)
        assert summary["ok"] is True
        graph = get_graph(db)
        assert "stats" in graph
        assert "nodes" in graph
        assert "edges" in graph
        assert "hotspots" in graph["stats"]
        assert "by_relation" in graph["stats"]

        # Stationen sollten über FactoryFloor.hall_id an Hallen angebunden sein
        edge_rels = {e["relation"] for e in graph["edges"]}
        if graph["stats"]["by_kind"].get("station", 0) > 0 and graph["stats"]["by_kind"].get("hall", 0) > 0:
            assert "steht_in" in edge_rels

        # Jeder Knoten liefert Grad-Metriken
        if graph["nodes"]:
            assert "degree" in graph["nodes"][0]

        target_keys = [n["key"] for n in graph["nodes"][:2]]
        ins = add_insight(
            db,
            title="Test-Erkenntnis Engpass",
            detail="Verknüpft mit erstem Plattform-Knoten",
            linked_keys=target_keys[:1],
            author="admin@musterwerk.local",
            severity="warning",
        )
        assert ins["ok"] is True

        # Erkenntnis aktualisieren
        upd = update_insight(
            db,
            ins["key"],
            title="Aktualisierte Erkenntnis",
            detail="Neuer Kontext",
            severity="danger",
            linked_keys=target_keys,
        )
        assert upd["ok"] is True
        assert upd["label"] == "Aktualisierte Erkenntnis"

        # Benutzerdefinierte Kante anlegen & über Rebuild hinweg bewahren
        custom_edge_id = None
        if len(target_keys) >= 2:
            ce = add_custom_edge(db, source_key=target_keys[0], target_key=target_keys[1], relation="test_bezug")
            assert ce["ok"] is True
            custom_edge_id = ce["id"]

            # Pfadsuche zwischen den verbundenen Knoten
            path = find_shortest_path(db, target_keys[0], target_keys[1])
            assert path["found"] is True
            assert path["hops"] >= 1

            # Ego-Netz um ersten Knoten
            ego = get_graph(db, focus=target_keys[0], depth=1)
            assert ego["focus"] == target_keys[0]
            assert any(n["key"] == target_keys[0] for n in ego["nodes"])

        # Rebuild darf gespeicherte Erkenntnisse und manuelle Kanten nicht löschen.
        rebuild_platform_graph(db)
        after = get_graph(db, kind="insight")
        assert any(n["key"] == ins["key"] and n["label"] == "Aktualisierte Erkenntnis" for n in after["nodes"])
        if custom_edge_id is not None:
            deleted_edge = delete_edge(db, custom_edge_id)
            assert deleted_edge["deleted"] is True

        deleted = delete_node(db, ins["key"])
        assert deleted["deleted"] is True
