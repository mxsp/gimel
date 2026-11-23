"""Tests für Routinen (Vorlagen + benutzerdefiniert) und globale Artefakt-Bibliothek."""

from __future__ import annotations


def test_routines_templates_custom_crud_and_run(client):
    listed = client.get("/api/agent/routines")
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert len(body["templates"]) >= 6
    assert any(t["key"] == "morning_shift_briefing" for t in body["templates"])

    # Benutzerdefinierte Routine erstellen
    created = client.post("/api/agent/routines", json={
        "name": "Abend-Check",
        "description": "Prüft offene Aufträge vor Schichtende.",
        "category": "schicht",
        "icon": "flame",
        "prompt": "Fasse alle offenen Aufträge und Engpässe zusammen.",
        "steps": ["Tageslage lesen", "HTML-Bericht erstellen"],
        "schedule": "daily",
        "schedule_time": "17:00",
        "output_format": "html_report",
        "shared": True,
    })
    assert created.status_code == 201, created.text
    routine = created.json()
    rid = routine["id"]
    assert routine["name"] == "Abend-Check"
    assert routine["steps"] == ["Tageslage lesen", "HTML-Bericht erstellen"]
    assert routine["shared"] is True

    # Aktualisieren
    upd = client.put(f"/api/agent/routines/{rid}", json={"name": "Abend-Check Pro", "output_format": "chart_dashboard"})
    assert upd.status_code == 200
    assert upd.json()["name"] == "Abend-Check Pro"
    assert upd.json()["output_format"] == "chart_dashboard"

    # Routine ausführen -> legt Chat + Lauf-Eintrag an und gibt kompilierten Prompt zurück
    ran = client.post(f"/api/agent/routines/{rid}/run")
    assert ran.status_code == 200, ran.text
    run_body = ran.json()
    assert run_body["chat"]["title"] == "Routine: Abend-Check Pro"
    assert "Tageslage lesen" in run_body["prompt"]
    assert "generate_chart_artifact" in run_body["prompt"]
    assert run_body["routine"]["run_count"] == 1
    chat_id_1 = run_body["chat"]["id"]

    # Vorlage direkt ausführen
    ran_tpl = client.post("/api/agent/routines/templates/morning_shift_briefing/run")
    assert ran_tpl.status_code == 200, ran_tpl.text
    chat_id_2 = ran_tpl.json()["chat"]["id"]
    assert "Frühschicht-Lagebericht" in ran_tpl.json()["prompt"]

    # Verlauf prüfen
    after = client.get("/api/agent/routines").json()
    assert len(after["runs"]) >= 2

    # Aufräumen
    assert client.delete(f"/api/agent/routines/{rid}").status_code == 200
    client.delete(f"/api/agent/chats/{chat_id_1}")
    client.delete(f"/api/agent/chats/{chat_id_2}")


def test_global_artifacts_library_crud(client):
    created = client.post("/api/agent/artifacts", json={
        "title": "Hallen-Übersicht",
        "kind": "html",
        "content": "<!doctype html><h1>Halle 1</h1>",
    })
    assert created.status_code == 201, created.text
    art = created.json()
    aid = art["id"]
    assert art["title"] == "Hallen-Übersicht"
    assert art["version"] == 1

    # Global listen & filtern
    listed = client.get("/api/agent/artifacts", params={"kind": "html", "q": "Hallen"}).json()
    assert any(a["id"] == aid for a in listed["artifacts"])

    # Einzeln lesen & bearbeiten
    one = client.get(f"/api/agent/artifacts/{aid}")
    assert one.status_code == 200
    assert "Halle 1" in one.json()["content"]

    upd = client.put(f"/api/agent/artifacts/{aid}", json={"content": "<!doctype html><h1>Halle 2</h1>"})
    assert upd.status_code == 200
    assert upd.json()["version"] == 2

    # Löschen
    assert client.delete(f"/api/agent/artifacts/{aid}").status_code == 200
    assert client.get(f"/api/agent/artifacts/{aid}").status_code == 404
