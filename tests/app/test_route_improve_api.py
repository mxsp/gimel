"""Roboterwege prüfen und verbessern über die API: Vorschau schreibt nichts, Übernahme protokolliert."""

from __future__ import annotations


def test_route_check_and_apply(client):
    from gimel.db import SessionLocal
    from gimel.models import AuditLog, RobotAsset

    r = client.get("/api/factory/robots/route-check")
    assert r.status_code == 200, r.text
    data = r.json()
    assert "robots" in data and "network" in data
    if not data["robots"]:
        return
    rid = data["robots"][0]["id"]
    with SessionLocal() as db:
        before = db.get(RobotAsset, rid).route
    prev = client.post(f"/api/factory/robots/{rid}/improve-route", json={"apply": False}).json()
    assert prev["applied"] is False
    with SessionLocal() as db:
        assert db.get(RobotAsset, rid).route == before
    done = client.post(f"/api/factory/robots/{rid}/improve-route", json={"apply": True})
    assert done.status_code in (200, 409), done.text
    if done.status_code == 200 and done.json()["applied"]:
        with SessionLocal() as db:
            assert db.query(AuditLog).filter(AuditLog.action == "robot_route_improve",
                                             AuditLog.entity_id == str(rid)).count() == 1
        again = client.post(f"/api/factory/robots/{rid}/improve-route", json={"apply": True}).json()
        assert again["applied"] is False, "ein verbesserter Weg bleibt stehen"


def test_optimize_way_previews_without_writing(client):
    floor = client.get("/api/factory/floor").json()
    nodes = ((floor.get("aisles") or {}).get("nodes") or [])
    if len(nodes) < 2:
        return
    payload = {"floor_id": floor["id"], "points": [nodes[0], nodes[1]], "loop": False}
    r = client.post("/api/factory/robot-ways/optimize", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["floor_id"] == floor["id"]
    assert isinstance(body["route"], list) and len(body["route"]) >= 2
    assert body["route"][0] == [round(float(nodes[0][0]), 3), round(float(nodes[0][1]), 3)]
    assert body["route"][-1] == [round(float(nodes[1][0]), 3), round(float(nodes[1][1]), 3)]
    assert isinstance(body["changed"], bool)
    assert body["metres_after"] >= 0
    # Zwei Vorschauen hintereinander sind gleich — die Vorschau schreibt nichts.
    again = client.post("/api/factory/robot-ways/optimize", json=payload).json()
    assert again["route"] == body["route"]


def test_optimize_way_needs_two_points(client):
    floor = client.get("/api/factory/floor").json()
    r = client.post("/api/factory/robot-ways/optimize",
                    json={"floor_id": floor["id"], "points": [[1, 1]], "loop": False})
    assert r.status_code == 400
    assert "zwei Punkte" in r.json()["detail"]


def test_route_endpoints_need_admin(client):
    from tests.app.test_twin_studio import _login

    staff = _login(client, "staff")
    assert staff.get("/api/factory/robots/route-check").status_code == 403
    assert staff.post("/api/factory/robots/1/improve-route", json={"apply": True}).status_code == 403
    assert client.post("/api/factory/robots/999999/improve-route", json={}).status_code == 404
