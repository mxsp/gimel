"""Twin Studio: Auslieferung unter /studio, eigener Prozess ohne Taktgeber, gespeicherte Ansichten."""

from __future__ import annotations

import math


def _camera(**over):
    cam = {"position": [10.0, 20.0, 30.0], "target": [5.0, 0.0, 8.0], "mode": "orbit", "view": "three"}
    cam.update(over)
    return cam


def test_studio_route_is_served_or_explains(client):
    r = client.get("/studio/")
    # Gebaut: die Seite selbst; ungebaut: ein Hinweis mit 503 — nie 404.
    assert r.status_code in (200, 503)
    assert "Twin Studio" in r.text or "<div id=\"root\"" in r.text or "studio" in r.text.lower()
    assert "Content-Security-Policy" in r.headers


def test_studio_path_traversal_is_refused(client):
    r = client.get("/studio/..%2F..%2Fmodels.py")
    assert r.status_code in (200, 404, 503)
    assert "class TwinView" not in r.text


def test_views_round_trip_and_audit(client):
    floors = client.get("/api/factory/floors")
    floor_id = floors.json()[0]["id"] if floors.status_code == 200 and floors.json() else None
    r = client.post("/api/factory/views", json={"floor_id": floor_id, "name": "  Blick auf Laser ", "camera": _camera()})
    assert r.status_code == 201, r.text
    view = r.json()
    assert view["name"] == "Blick auf Laser"
    assert view["camera"]["position"] == [10.0, 20.0, 30.0]
    listed = client.get("/api/factory/views", params={"floor_id": view["floor_id"]}).json()
    assert any(v["id"] == view["id"] for v in listed)

    from gimel.db import SessionLocal
    from gimel.models import AuditLog

    with SessionLocal() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "twin_view_create",
                                         AuditLog.entity_id == str(view["id"])).count() == 1

    assert client.delete(f"/api/factory/views/{view['id']}").status_code == 204
    assert client.delete(f"/api/factory/views/{view['id']}").status_code == 404
    with SessionLocal() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "twin_view_delete").count() >= 1


def test_views_reject_bad_cameras(client):
    bad = [
        _camera(position=[1.0, 2.0]),
        _camera(position=[1.0, 2.0, 1e9]),
        _camera(mode="fly"),
        _camera(view="vr"),
    ]
    for cam in bad:
        r = client.post("/api/factory/views", json={"name": "x", "camera": cam})
        assert r.status_code == 422, (cam, r.text)
    assert client.post("/api/factory/views", json={"name": "", "camera": _camera()}).status_code == 422
    r = client.post("/api/factory/views", json={"name": "x", "camera": _camera(), "floor_id": 999999})
    assert r.status_code == 404
    assert math.isfinite(1.0)


def test_views_need_login(client):
    from fastapi.testclient import TestClient

    from gimel.app import create_app

    with TestClient(create_app()) as anon:
        assert anon.get("/api/factory/views").status_code == 401
        assert anon.post("/api/factory/views", json={"name": "x", "camera": _camera()}).status_code == 401


def test_studio_process_has_no_scheduler_and_redirects_root(plant):
    from fastapi.testclient import TestClient

    from gimel.services import scheduler

    original = scheduler.loop
    try:
        from gimel.studio import _idle_scheduler, create_studio_app

        app = create_studio_app()
        assert scheduler.loop is _idle_scheduler
        with TestClient(app) as c:
            r = c.get("/", follow_redirects=False)
            assert r.status_code == 307
            assert r.headers["location"] == "/studio/"
    finally:
        scheduler.loop = original


def test_cli_has_studio_command():
    from gimel import cli

    import pytest

    with pytest.raises(SystemExit) as e:
        cli.main(["studio", "--help"])
    assert e.value.code == 0


# --------------------------------------------------------------------------- Rechte und Grenzen


def _login(client, role: str):
    """Ein frisches Konto der Rolle anlegen und einen eigenen Client dafür liefern."""
    import secrets

    from fastapi.testclient import TestClient

    from gimel.app import create_app
    from gimel.db import SessionLocal
    from gimel.models import Role, User
    from gimel.security import hash_password

    email = f"{role}-{secrets.token_hex(4)}@example.test"
    password = secrets.token_urlsafe(16)
    with SessionLocal() as db:
        db.add(User(email=email, name=role, role=Role(role), password_hash=hash_password(password), active=True))
        db.commit()
    c = TestClient(create_app())
    r = c.post("/api/auth/login", data={"username": email, "password": password})
    assert r.status_code == 200, r.text
    c.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
    return c


def test_views_roles(client):
    worker = _login(client, "worker")
    staff_a = _login(client, "staff")
    staff_b = _login(client, "staff")
    assert worker.get("/api/factory/views").status_code == 200
    assert worker.post("/api/factory/views", json={"name": "x", "camera": _camera()}).status_code == 403
    mine = staff_a.post("/api/factory/views", json={"name": "A", "camera": _camera()})
    assert mine.status_code == 201
    vid = mine.json()["id"]
    assert worker.delete(f"/api/factory/views/{vid}").status_code == 403
    assert staff_b.delete(f"/api/factory/views/{vid}").status_code == 403
    # Admin darf fremde Ansichten löschen.
    assert client.delete(f"/api/factory/views/{vid}").status_code == 204
    other = staff_a.post("/api/factory/views", json={"name": "B", "camera": _camera()}).json()["id"]
    assert staff_a.delete(f"/api/factory/views/{other}").status_code == 204


def test_views_cap_per_floor(client):
    from gimel.db import SessionLocal
    from gimel.models import TwinView
    from gimel.routers.factory import MAX_VIEWS_PER_FLOOR

    first = client.post("/api/factory/views", json={"name": "cap-0", "camera": _camera()})
    assert first.status_code == 201
    floor_id = first.json()["floor_id"]
    with SessionLocal() as db:
        have = db.query(TwinView).filter(TwinView.floor_id == floor_id).count()
        for i in range(MAX_VIEWS_PER_FLOOR - have):
            db.add(TwinView(floor_id=floor_id, name=f"cap-{i + 1}", camera=_camera()))
        db.commit()
    r = client.post("/api/factory/views", json={"name": "zu viel", "camera": _camera()})
    assert r.status_code == 409
    with SessionLocal() as db:
        db.query(TwinView).filter(TwinView.floor_id == floor_id).delete()
        db.commit()


def test_views_reject_non_finite_numbers(client):
    # JSON kennt kein NaN; Python schickt es trotzdem, wenn man es zulässt.
    import json

    body = json.dumps({"name": "x", "camera": _camera(position=[float("nan"), 1.0, 1.0])}, allow_nan=True)
    r = client.post("/api/factory/views", content=body, headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    body = json.dumps({"name": "x", "camera": _camera(target=[float("inf"), 1.0, 1.0])}, allow_nan=True)
    r = client.post("/api/factory/views", content=body, headers={"Content-Type": "application/json"})
    assert r.status_code == 422


def test_studio_traversal_returns_the_page(client):
    from gimel.studio import DIST

    r = client.get("/studio/../../models.py")
    assert "class TwinView" not in r.text
    if (DIST / "studio.html").exists():
        r = client.get("/studio/../../../gimel/models.py")
        assert "class TwinView" not in r.text


def test_studio_process_refuses_pin_and_offers_none(plant):
    from fastapi.testclient import TestClient

    from gimel.services import scheduler

    original = scheduler.loop
    try:
        from gimel.studio import create_studio_app

        with TestClient(create_studio_app()) as c:
            assert c.post("/api/auth/pin", json={"pin": "0000"}).status_code == 404
            opts = c.get("/api/auth/login-options").json()
            assert opts.get("gimel_pin_enabled") is False
            assert opts.get("test_pin_enabled") is False
    finally:
        scheduler.loop = original


def test_cli_studio_refuses_network_host(capsys):
    from gimel import cli

    assert cli.main(["studio", "--host", "0.0.0.0", "--no-browser"]) in (1, 2)


def test_studio_process_has_local_speech_recognition_portal_not(plant, monkeypatch):
    """Task 43: der Studio-Assistent erkennt Sprache auf diesem Rechner; das Portal
    (das ein Tunnel erreichen kann) bindet die Erkennung ohne GIMEL_VOICE=1 nie ein."""
    import pytest
    from fastapi.testclient import TestClient

    from gimel import agent_bridge
    from gimel.services import scheduler

    if agent_bridge.load_voice()[0] is None:
        pytest.skip("agentlab nicht vorhanden")
    monkeypatch.setenv("GIMEL_VOICE_WARMUP", "0")
    original = scheduler.loop
    try:
        from gimel.app import create_app
        from gimel.studio import create_studio_app

        with TestClient(create_studio_app()) as c:
            # Ohne Anmeldung abgewiesen — aber die Route gibt es.
            r = c.post("/api/agent/transcribe", content=b"x", headers={"Content-Type": "audio/wav"})
            assert r.status_code in (401, 403), r.status_code
            assert c.get("/api/agent/voice").status_code in (401, 403)
        with TestClient(create_app()) as c:
            r = c.post("/api/agent/transcribe", content=b"x", headers={"Content-Type": "audio/wav"})
            assert r.status_code in (404, 405), r.status_code
    finally:
        scheduler.loop = original


def test_portal_speech_recognition_opt_in(plant, monkeypatch):
    """Task 43: das Test-Portal (8040) bindet die Erkennung mit GIMEL_VOICE=1 ein —
    das Opt-in für den Demo-Modus (``gimel serve --voice``, ``fyrefly gimel demo``)."""
    import pytest
    from fastapi.testclient import TestClient

    from gimel import agent_bridge

    if agent_bridge.load_voice()[0] is None:
        pytest.skip("agentlab nicht vorhanden")
    monkeypatch.setenv("GIMEL_VOICE", "1")
    monkeypatch.setenv("GIMEL_VOICE_WARMUP", "0")
    from gimel.app import create_app

    with TestClient(create_app()) as c:
        # Ohne Anmeldung abgewiesen — aber die Route gibt es.
        r = c.post("/api/agent/transcribe", content=b"x", headers={"Content-Type": "audio/wav"})
        assert r.status_code in (401, 403), r.status_code
        assert c.get("/api/agent/voice").status_code in (401, 403)


def test_studio_voice_can_be_switched_off(plant, monkeypatch):
    from fastapi.testclient import TestClient

    from gimel.services import scheduler

    monkeypatch.setenv("GIMEL_STUDIO_VOICE", "0")
    original = scheduler.loop
    try:
        from gimel.studio import create_studio_app

        with TestClient(create_studio_app()) as c:
            r = c.post("/api/agent/transcribe", content=b"x", headers={"Content-Type": "audio/wav"})
            assert r.status_code in (404, 405)
    finally:
        scheduler.loop = original
