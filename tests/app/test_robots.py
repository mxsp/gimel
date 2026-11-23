"""Roboter im Zwilling: lesen, filtern und ein virtueller Roboter von Hand."""

from __future__ import annotations


def fleet(client) -> dict:
    r = client.get("/api/factory/robots")
    assert r.status_code == 200, r.text
    return r.json()


def test_demo_has_virtual_robots_with_pose_and_route(client):
    body = fleet(client)
    assert body["simulated"] is True
    assert body["sampled_at"]
    assert len(body["robots"]) >= 3
    names = {r["name"] for r in body["robots"]}
    assert {"AGV 1", "AGV 2", "AMR Logistik"} <= names

    for robot in body["robots"]:
        assert robot["gateway_id"] == "sim"
        assert robot["simulated"] is True
        assert robot["active"] is True
        assert robot["route_mode"] in {"loop", "pingpong"}
        assert len(robot["route"]) >= 2
        assert robot["route_m"] > 0
        assert robot["x"] is not None and robot["y"] is not None
        assert robot["battery_pct"] is not None
        # Fahrplan (core/robot_traffic): ein Roboter kann gerade auf Vorfahrt warten.
        assert robot["state"] in ("moving", "idle")


def test_floor_filter_is_exact(client):
    robots = fleet(client)["robots"]
    floor_id = robots[0]["floor_id"]
    r = client.get(f"/api/factory/robots?floor_id={floor_id}")
    assert r.status_code == 200, r.text
    filtered = r.json()["robots"]
    assert filtered
    assert {x["floor_id"] for x in filtered} == {floor_id}


def test_admin_can_create_update_and_delete_a_virtual_robot(client):
    from gimel.db import SessionLocal
    from gimel.models import AuditLog

    floor_id = fleet(client)["robots"][0]["floor_id"]
    body = {
        "name": "Test-AGV",
        "kind": "agv",
        "floor_id": floor_id,
        "route": [[1, 1], [5, 1], [5, 5]],
        "route_mode": "loop",
        "speed_m_s": 0.5,
        "battery_pct": None,
        "state": "moving",
        "gateway_id": "sim",
        "capabilities": ["transport"],
        "payload_kg": 120,
        "active": True,
    }
    created = client.post("/api/factory/robots", json=body)
    assert created.status_code == 201, created.text
    robot = created.json()
    rid = robot["id"]
    try:
        assert robot["name"] == "Test-AGV"
        assert robot["battery_pct"] is None
        assert robot["route_m"] > 0
        assert robot["simulated"] is True

        body["name"] = "Test-AGV 2"
        body["speed_m_s"] = 0.75
        changed = client.put(f"/api/factory/robots/{rid}", json=body)
        assert changed.status_code == 200, changed.text
        assert changed.json()["name"] == "Test-AGV 2"
        assert changed.json()["speed_m_s"] == 0.75

        assert client.get(f"/api/factory/robots/{rid}").status_code == 200
        with SessionLocal() as db:
            actions = {
                a.action for a in db.query(AuditLog)
                .filter(AuditLog.entity == "robot_asset", AuditLog.entity_id == str(rid))
                .all()
            }
        assert {"robot_create", "robot_update"} <= actions
    finally:
        assert client.delete(f"/api/factory/robots/{rid}").status_code == 204
    assert client.get(f"/api/factory/robots/{rid}").status_code == 404
    with SessionLocal() as db:
        assert db.query(AuditLog).filter(
            AuditLog.entity == "robot_asset", AuditLog.entity_id == str(rid),
            AuditLog.action == "robot_delete",
        ).count() == 1


def test_a_route_with_one_point_is_refused(client):
    r = client.post("/api/factory/robots", json={"name": "Kaputt", "route": [[1, 1]]})
    assert r.status_code == 400
    assert "zwei Punkte" in r.json()["detail"]


def test_a_negative_speed_is_refused(client):
    r = client.post("/api/factory/robots",
                    json={"name": "Rückwärts", "route": [[0, 0], [1, 1]], "speed_m_s": -1})
    assert r.status_code in (400, 422)


def test_zero_battery_and_origin_are_real_values(client):
    """0 % Akku und (0, 0) sind echte Werte, kein unbekannt."""
    from gimel.db import SessionLocal
    from gimel.models import RobotAsset

    with SessionLocal() as db:
        row = RobotAsset(name="Real-AGV", gateway_id="vda", route=[], speed_m_s=0.0,
                         battery_pct=0, x=0.0, y=0.0, heading_deg=0.0, active=True)
        db.add(row)
        db.commit()
        rid = row.id
    try:
        got = client.get(f"/api/factory/robots/{rid}")
        assert got.status_code == 200, got.text
        robot = got.json()
        assert robot["battery_pct"] == 0
        assert robot["x"] == 0.0 and robot["y"] == 0.0
        assert robot["heading_deg"] == 0.0
        assert robot["simulated"] is False
    finally:
        assert client.delete(f"/api/factory/robots/{rid}").status_code == 204


def test_a_two_point_loop_is_an_out_and_back_route(client):
    body = {"name": "Pendel", "gateway_id": "sim", "route": [[0, 0], [10, 0]],
            "route_mode": "loop", "speed_m_s": 1, "active": True}
    created = client.post("/api/factory/robots", json=body)
    assert created.status_code == 201, created.text
    rid = created.json()["id"]
    try:
        assert created.json()["route_m"] == 20.0
        assert created.json()["x"] is not None
    finally:
        assert client.delete(f"/api/factory/robots/{rid}").status_code == 204


def test_a_noop_update_writes_no_audit_and_does_not_reset_the_simulation(client):
    from gimel.db import SessionLocal
    from gimel.models import AuditLog, RobotAsset

    body = {"name": "No-op", "gateway_id": "sim", "route": [[0, 0], [10, 0]],
            "route_mode": "pingpong", "speed_m_s": 1, "active": True}
    created = client.post("/api/factory/robots", json=body)
    assert created.status_code == 201, created.text
    rid = created.json()["id"]
    def updates() -> int:
        with SessionLocal() as db:
            return db.query(AuditLog).filter(
                AuditLog.entity == "robot_asset", AuditLog.entity_id == str(rid),
                AuditLog.action == "robot_update",
            ).count()

    try:
        with SessionLocal() as db:
            before = db.get(RobotAsset, rid).sim_started_at
        baseline = updates()
        same = client.put(f"/api/factory/robots/{rid}", json=body)
        assert same.status_code == 200, same.text
        with SessionLocal() as db:
            after = db.get(RobotAsset, rid).sim_started_at
        assert after == before
        assert updates() == baseline
        body["name"] = "No-op 2"
        assert client.put(f"/api/factory/robots/{rid}", json=body).status_code == 200
        assert updates() == baseline + 1
    finally:
        assert client.delete(f"/api/factory/robots/{rid}").status_code == 204


def test_naive_now_is_normalised_for_the_snapshot():
    from datetime import datetime, timezone as tz

    from gimel.db import SessionLocal
    from gimel.services import robot_fleet

    with SessionLocal() as db:
        snap = robot_fleet.snapshot(db, now=datetime(2026, 1, 1, 12, 0, 0))
    assert snap["sampled_at"].endswith("+00:00")
    assert datetime.fromisoformat(snap["sampled_at"]).tzinfo == tz.utc


def test_extreme_route_points_are_refused(client):
    r = client.post("/api/factory/robots",
                    json={"name": "Weit", "route": [[0, 0], [1e12, 0]]})
    assert r.status_code == 400
    assert "außerhalb" in r.json()["detail"]


def test_non_finite_speed_is_refused(client):
    # JSON kennt kein Infinity; als Text muss der Server es ablehnen.
    r = client.post("/api/factory/robots",
                    content='{"name":"Schnell","route":[[0,0],[1,1]],"speed_m_s":Infinity}',
                    headers={"Content-Type": "application/json"})
    assert r.status_code in (400, 422)


def test_a_route_outside_the_floor_is_refused(client):
    floor_id = fleet(client)["robots"][0]["floor_id"]
    r = client.post("/api/factory/robots", json={
        "name": "Draußen", "floor_id": floor_id, "route": [[-10, -10], [-5, -10]],
    })
    assert r.status_code == 400
    assert "außerhalb" in r.json()["detail"]
