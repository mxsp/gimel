"""Tests für die temporäre Container-Sandbox des Gimel-Assistenten (Docker & Bubblewrap)."""

from __future__ import annotations

from datetime import timedelta

import pytest


def _invoke(client, chat_id: int, name: str, args: dict | None = None):
    return client.post(
        f"/api/agent/chats/{chat_id}/tools/{name}",
        json={"arguments": args or {}},
    )


@pytest.fixture()
def chat(client):
    data = client.post("/api/agent/chats", json={"write_mode": False}).json()
    yield data
    client.delete(f"/api/agent/chats/{data['id']}")


def test_sandbox_runtime_status_and_selftest(client):
    status = client.get("/api/agent/sandbox/status")
    assert status.status_code == 200, status.text
    body = status.json()
    assert body["enabled"] is True
    assert body["available"] is True
    assert body["effective_backend"] in ("docker", "bwrap")
    assert "backends" in body

    tested = client.post("/api/agent/sandbox/test")
    assert tested.status_code == 200, tested.text
    res = tested.json()
    assert res["ok"] is True
    assert res["exit_code"] == 0
    assert "OK python=" in res["stdout"]
    assert res["network_enabled"] is False


def test_sandbox_full_tool_workflow_and_artifact_export(client, chat):
    # Funktioniert bewusst auch mit write_mode=False (schreibt nie in Gimel-Kerntabellen)
    created = _invoke(client, chat["id"], "sandbox_create", {})
    assert created.status_code == 200, created.text
    sb = created.json()["data"]["sandbox"]
    assert sb["active"] is True
    assert sb["backend"] in ("docker", "bwrap")
    assert sb["network_enabled"] is False

    # Datei in /workspace schreiben
    written = _invoke(client, chat["id"], "sandbox_write_file", {
        "path": "data/werte.csv",
        "content": "werkstoff,stueck\nEPDM,12\nNBR,8\nEPDM,15\n",
    })
    assert written.status_code == 200, written.text
    assert written.json()["data"]["path"] == "data/werte.csv"

    # Python im Container ausführen: CSV lesen und SVG-Bericht erzeugen
    py_code = (
        "import csv, collections\n"
        "totals = collections.Counter()\n"
        "with open('data/werte.csv') as f:\n"
        "    for row in csv.DictReader(f):\n"
        "        totals[row['werkstoff']] += int(row['stueck'])\n"
        "print('EPDM=', totals['EPDM'], 'NBR=', totals['NBR'])\n"
        "svg = f'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"60\">"
        "<text x=\"10\" y=\"35\">EPDM:{totals[\"EPDM\"]} NBR:{totals[\"NBR\"]}</text></svg>'\n"
        "with open('out/chart.svg', 'w') as out:\n"
        "    out.write(svg)\n"
    )
    # Erst Verzeichnis anlegen und Python ausführen
    mk = _invoke(client, chat["id"], "sandbox_exec", {"command": "mkdir -p out"})
    assert mk.status_code == 200, mk.text
    assert mk.json()["data"]["exit_code"] == 0

    ran = _invoke(client, chat["id"], "sandbox_run_python", {
        "code": py_code,
        "filename": "analyse.py",
    })
    assert ran.status_code == 200, ran.text
    run_data = ran.json()["data"]
    assert run_data["exit_code"] == 0, run_data["stderr"]
    assert "EPDM= 27 NBR= 8" in run_data["stdout"]
    assert "out/chart.svg" in run_data["changed_files"]

    # Dateien auflisten & lesen
    listed = _invoke(client, chat["id"], "sandbox_list_files", {})
    assert listed.status_code == 200
    paths = [e["path"] for e in listed.json()["data"]["files"]]
    assert "data/werte.csv" in paths
    assert "out/chart.svg" in paths

    read_back = _invoke(client, chat["id"], "sandbox_read_file", {"path": "/workspace/out/chart.svg"})
    assert read_back.status_code == 200
    assert "EPDM:27 NBR:8" in read_back.json()["data"]["content"]

    # REST-Endpunkt für Datei-Vorschau aus dem Container
    rest_file = client.get(f"/api/agent/chats/{chat['id']}/sandbox/files/out/chart.svg")
    assert rest_file.status_code == 200, rest_file.text
    assert "EPDM:27 NBR:8" in rest_file.json()["content"]

    # Container-Datei als Chat-Artefakt mit Vorschau veröffentlichen
    exported = _invoke(client, chat["id"], "sandbox_export_artifact", {
        "path": "out/chart.svg",
        "title": "Werkstoff-Auswertung",
    })
    assert exported.status_code == 200, exported.text
    exp_body = exported.json()
    assert exp_body["data"]["artifact"]["kind"] == "svg"
    assert exp_body["client_action"]["type"] == "open_preview"
    assert "EPDM:27 NBR:8" in exp_body["client_action"]["content"]

    # Container beenden & /workspace entfernen
    from agentlab import sandbox as sandbox_service

    ws_dir = sandbox_service.get_sandbox(chat["id"]).workspace_dir
    assert ws_dir.exists()

    destroyed = _invoke(client, chat["id"], "sandbox_destroy", {})
    assert destroyed.status_code == 200, destroyed.text
    assert destroyed.json()["data"]["destroyed"] is True
    assert not ws_dir.exists()
    assert sandbox_service.get_sandbox(chat["id"]) is None


def test_sandbox_attachment_staging_and_chat_delete_cleanup(client):
    from agentlab import sandbox as sandbox_service

    chat = client.post("/api/agent/chats", json={}).json()
    chat_id = chat["id"]
    csv_bytes = b"position,preis\nA1,12.5\nA2,7.5\n"
    up = client.post(
        f"/api/agent/chats/{chat_id}/attachments",
        files={"file": ("preise.csv", csv_bytes, "text/csv")},
    )
    assert up.status_code == 201, up.text

    # Über REST starten inkl. Anhang-Staging
    started = client.post(
        f"/api/agent/chats/{chat_id}/sandbox",
        json={"stage_attachments": True},
    )
    assert started.status_code == 201, started.text
    staged = started.json()["staged_attachments"]
    assert len(staged) == 1
    assert staged[0].startswith("attachments/")

    # Python liest den kopierten Anhang im Container
    res = _invoke(client, chat_id, "sandbox_run_python", {
        "code": (
            f"import csv\n"
            f"with open({staged[0]!r}) as f:\n"
            f"    s = sum(float(r['preis']) for r in csv.DictReader(f))\n"
            f"print(f'SUM={{s:.2f}}')\n"
        ),
    })
    assert res.status_code == 200, res.text
    assert "SUM=20.00" in res.json()["data"]["stdout"]

    session = sandbox_service.get_sandbox(chat_id)
    assert session is not None
    ws_dir = session.workspace_dir

    # Chat löschen räumt den Container automatisch mit auf
    deleted = client.delete(f"/api/agent/chats/{chat_id}")
    assert deleted.status_code == 200
    assert sandbox_service.get_sandbox(chat_id) is None
    assert not ws_dir.exists()


def test_sandbox_security_isolation_and_path_guards(client, chat):
    # Path-Traversal abweisen
    for bad_path in ("../secret.txt", "../../etc/passwd", "/etc/passwd"):
        r = _invoke(client, chat["id"], "sandbox_write_file", {
            "path": bad_path, "content": "nope",
        })
        assert r.status_code == 422, f"expected 422 for {bad_path}: {r.status_code}"

    # Ungültiges Image abweisen (Flag-Injection)
    bad_img = _invoke(client, chat["id"], "sandbox_create", {"image": "--privileged"})
    assert bad_img.status_code == 422

    # Container-Härtung prüfen: Root-Dateisystem ist nur lesbar
    ro = _invoke(client, chat["id"], "sandbox_exec", {"command": "touch /usr/should_fail 2>&1"})
    assert ro.status_code == 200
    assert ro.json()["data"]["exit_code"] != 0

    # Zeitlimit greift sauber
    to = _invoke(client, chat["id"], "sandbox_exec", {"command": "sleep 10", "timeout_s": 2})
    assert to.status_code == 200
    assert to.json()["data"]["timed_out"] is True

    client.delete(f"/api/agent/chats/{chat['id']}/sandbox")


def test_sandbox_switch_and_hands_free_guard(client, chat):
    try:
        tools = {t["name"]: t for t in client.get("/api/agent/tools").json()["tools"]}
        assert tools["sandbox_run_python"]["sandbox"] is True
        assert tools["sandbox_run_python"]["available"] is True
        assert tools["sandbox_run_python"]["category"] == "Container & Sandbox"

        # Sandbox ausschalten
        off = client.put("/api/agent/settings", json={"values": {"agent_sandbox_enabled": "false"}})
        assert off.status_code == 200
        assert off.json()["sandbox_enabled"] is False

        tools_off = {t["name"]: t for t in client.get("/api/agent/tools").json()["tools"]}
        assert tools_off["sandbox_run_python"]["available"] is False

        denied = _invoke(client, chat["id"], "sandbox_exec", {"command": "echo hi"})
        assert denied.status_code == 422
        assert "ausgeschaltet" in denied.text

        # hands_free sperrt Sandbox-Werkzeuge immer
        from agentlab.tools import TOOLS, live_write_ok

        assert live_write_ok(TOOLS["sandbox_exec"]) is False
        assert live_write_ok(TOOLS["sandbox_run_python"]) is False
    finally:
        client.put("/api/agent/settings", json={"values": {"agent_sandbox_enabled": "true"}})


def test_sandbox_bwrap_backend_and_ttl_expiry(client, chat):
    from agentlab import sandbox as sandbox_service

    if not sandbox_service.probe_bwrap()["available"]:
        pytest.skip("bwrap nicht verfügbar")

    try:
        client.put("/api/agent/settings", json={"values": {"agent_sandbox_backend": "bwrap"}})
        res = _invoke(client, chat["id"], "sandbox_run_python", {
            "code": "import os; print('BWRAP_OK', os.getcwd())",
        })
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        assert data["exit_code"] == 0, data["stderr"]
        assert data["sandbox"]["backend"] == "bwrap"
        assert "BWRAP_OK /workspace" in data["stdout"]

        # TTL-Ablauf simulieren und cleanup_expired prüfen
        session = sandbox_service.get_sandbox(chat["id"])
        assert session is not None
        ws_dir = session.workspace_dir
        session.last_used_at = session.last_used_at - timedelta(minutes=session.ttl_minutes + 5)

        cleaned = sandbox_service.cleanup_expired()
        assert cleaned >= 1
        assert sandbox_service.get_sandbox(chat["id"]) is None
        assert not ws_dir.exists()
    finally:
        client.put("/api/agent/settings", json={"values": {"agent_sandbox_backend": "auto"}})
        client.delete(f"/api/agent/chats/{chat['id']}/sandbox")


def test_sandbox_extensive_hard_work_profile_and_hot_recreate(client, chat):
    from agentlab import sandbox as sandbox_service

    status = client.get("/api/agent/sandbox/status").json()
    assert "extensive" in status["profiles"]
    assert status["host"]["cpus"] >= 1
    assert status["host"]["memory_mb"] > 0

    extensive_values = dict(status["profiles"]["extensive"]["values"])
    try:
        # Erst im Standard-Modus starten und eine Datei anlegen
        w = _invoke(client, chat["id"], "sandbox_write_file", {
            "path": "persist.txt", "content": "bleibt-erhalten",
        })
        assert w.status_code == 200, w.text
        old_id = w.json()["data"]["sandbox"]["sandbox_id"]

        # Auf „Extensiv (Hard Work)“ umstellen
        saved = client.put("/api/agent/settings", json={"values": extensive_values})
        assert saved.status_code == 200, saved.text
        assert saved.json()["values"]["agent_sandbox_profile"] == "extensive"
        assert saved.json()["values"]["agent_sandbox_memory_mb"] == "8192"
        assert saved.json()["values"]["agent_sandbox_workspace_mb"] == "2048"
        assert saved.json()["values"]["agent_sandbox_tmpfs_mb"] == "1024"
        assert saved.json()["values"]["agent_sandbox_pids_limit"] == "1024"
        assert saved.json()["values"]["agent_sandbox_allow_exec_tmp"] == "true"

        # Container mit recreate=True neu starten -> neue Limits, alte Dateien bleiben!
        restarted = client.post(
            f"/api/agent/chats/{chat['id']}/sandbox",
            json={"recreate": True},
        )
        assert restarted.status_code == 201, restarted.text
        sb = restarted.json()["sandbox"]
        assert sb["sandbox_id"] != old_id
        assert sb["profile"] == "extensive"
        assert sb["memory_mb"] == 8192
        assert sb["cpus"] == pytest.approx(4.0)
        assert sb["workspace_mb"] == 2048
        assert sb["tmpfs_mb"] == 1024
        assert sb["pids_limit"] == 1024
        assert sb["allow_swap"] is True
        assert sb["allow_exec_tmp"] is True

        # Vorherige Datei in /workspace blieb erhalten
        read_back = _invoke(client, chat["id"], "sandbox_read_file", {"path": "persist.txt"})
        assert read_back.status_code == 200
        assert read_back.json()["data"]["content"] == "bleibt-erhalten"

        # Ausführbares /tmp funktioniert im Extensiv-Profil (wichtig für Compiler / pip-Builds)
        exec_tmp = _invoke(client, chat["id"], "sandbox_exec", {
            "command": "printf '#!/bin/sh\\necho TMP_EXEC_OK\\n' > /tmp/runme.sh && chmod +x /tmp/runme.sh && /tmp/runme.sh",
        })
        assert exec_tmp.status_code == 200, exec_tmp.text
        assert exec_tmp.json()["data"]["exit_code"] == 0, exec_tmp.json()["data"]["stderr"]
        assert "TMP_EXEC_OK" in exec_tmp.json()["data"]["stdout"]
    finally:
        client.post("/api/agent/settings/reset", json={"keys": list(extensive_values.keys())})
        client.delete(f"/api/agent/chats/{chat['id']}/sandbox")
        sandbox_service.cleanup_expired()


def test_sandbox_list_and_stop_running_containers(client, chat):
    started = client.post(f"/api/agent/chats/{chat['id']}/sandbox", json={})
    assert started.status_code == 201, started.text
    cname = started.json()["sandbox"]["container_name"]

    status = client.get("/api/agent/sandbox/status")
    assert status.status_code == 200, status.text
    sessions = status.json()["sessions"]
    match = [s for s in sessions if s["container_name"] == cname]
    assert len(match) == 1
    assert match[0]["chat_id"] == chat["id"]
    assert match[0]["chat_title"]

    stopped = client.delete(f"/api/agent/sandbox/containers/{cname}")
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["destroyed"] is True

    after = client.get("/api/agent/sandbox/status").json()["sessions"]
    assert not any(s["container_name"] == cname for s in after)
