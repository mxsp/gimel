"""Roboterplattform: Gateways, Programmauslieferung, Telemetrie und Transporte."""

from __future__ import annotations

from datetime import datetime, timezone


def forget_robot(robot_id: int) -> None:
    """Testreste entfernen, damit spätere Zählungen nicht auf fremden Zeilen sitzen."""
    from gimel.db import SessionLocal
    from gimel.models import AuditLog, RobotEvent

    with SessionLocal() as db:
        db.query(RobotEvent).filter(RobotEvent.robot_id == robot_id).delete()
        db.query(AuditLog).filter(
            AuditLog.entity == "robot_asset", AuditLog.entity_id == str(robot_id)
        ).delete()
        db.commit()


def make_robot(client, *, name: str, gateway: str = "sim", floor_id: int | None = None) -> dict:
    body = {
        "name": name,
        "kind": "agv",
        "floor_id": floor_id,
        "route": [],
        "route_mode": "pingpong",
        "speed_m_s": 0.0,
        "battery_pct": None,
        "state": "idle",
        "gateway_id": gateway,
        "capabilities": ["transport"],
        "payload_kg": 200,
        "active": True,
    }
    r = client.post("/api/factory/robots", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_gateway_program_deploy_and_rollback(client):
    gw = client.post("/api/factory/robot-gateways", json={
        "code": "test-sim", "name": "Test-Simulation", "kind": "sim", "enabled": True,
    })
    assert gw.status_code == 201, gw.text
    gateway = gw.json()
    robot = make_robot(client, name="Deploy-AGV", gateway="test-sim")
    try:
        first = client.post("/api/factory/robot-programs", json={
            "name": "Test-Mission", "kind": "mission", "language": "json",
            "body": '{"step": 1}', "robot_id": robot["id"], "gateway_id": "test-sim",
        })
        assert first.status_code == 201, first.text
        program = first.json()
        assert program["version"] == 1
        assert program["status"] == "draft"
        assert program["checksum"]

        approved = client.post(f"/api/factory/robot-programs/{program['id']}/approve")
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "approved"

        deployed = client.post(
            f"/api/factory/robot-programs/{program['id']}/deploy",
            json={"robot_id": robot["id"]},
        )
        assert deployed.status_code == 201, deployed.text
        assert deployed.json()["state"] == "accepted"

        second = client.post("/api/factory/robot-programs", json={
            "name": "Test-Mission", "kind": "mission", "language": "json",
            "body": '{"step": 2}', "robot_id": robot["id"], "gateway_id": "test-sim",
        })
        assert second.status_code == 201, second.text
        assert second.json()["version"] == 2
        client.post(f"/api/factory/robot-programs/{second.json()['id']}/approve")
        latest = client.post(
            f"/api/factory/robot-programs/{second.json()['id']}/deploy",
            json={"robot_id": robot["id"]},
        )
        assert latest.status_code == 201, latest.text
        assert latest.json()["state"] == "accepted"

        rolled = client.post(f"/api/factory/robot-deployments/{latest.json()['id']}/rollback")
        assert rolled.status_code == 201, rolled.text
        assert rolled.json()["state"] == "accepted"
        assert rolled.json()["rollback_of_id"] == latest.json()["id"]
        assert rolled.json()["program_version"] == 1
    finally:
        assert client.delete(f"/api/factory/robots/{robot['id']}").status_code == 204
        forget_robot(robot["id"])
        assert client.delete(f"/api/factory/robot-gateways/{gateway['id']}").status_code == 204


def test_an_unapproved_program_is_not_deployed(client):
    robot = make_robot(client, name="Kein-Freigabe-AGV")
    try:
        created = client.post("/api/factory/robot-programs", json={
            "name": "Nicht freigegeben", "body": "x", "robot_id": robot["id"],
        })
        assert created.status_code == 201, created.text
        deployed = client.post(
            f"/api/factory/robot-programs/{created.json()['id']}/deploy",
            json={"robot_id": robot["id"]},
        )
        assert deployed.status_code == 400
        assert "freigegeben" in deployed.json()["detail"]
    finally:
        assert client.delete(f"/api/factory/robots/{robot['id']}").status_code == 204
        forget_robot(robot["id"])


def test_a_public_gateway_address_is_refused(client):
    r = client.post("/api/factory/robot-gateways", json={
        "code": "cloud", "name": "Cloud", "kind": "http",
        "base_url": "https://example.com", "endpoints": {"command": "/orders"},
    })
    assert r.status_code == 400
    assert "lokalen Netz" in r.json()["detail"]


def test_telemetry_updates_pose_and_is_idempotent(client):
    from gimel.db import SessionLocal
    from gimel.models import RobotEvent

    gw = client.post("/api/factory/robot-gateways", json={
        "code": "gw-test", "name": "Hallen-Gateway", "kind": "http",
        "base_url": "http://robot-gw.local", "endpoints": {"health": "/health"},
    })
    assert gw.status_code == 201, gw.text
    gateway = gw.json()
    token = gateway["token"]
    assert token
    robot = make_robot(client, name="Melde-AGV", gateway="gw-test")
    try:
        payload = {
            "robot_id": robot["id"], "x": 0.0, "y": 0.0, "heading_deg": 0.0,
            "battery_pct": 0, "state": "idle", "quality": "measured",
            "idempotency_key": "gw-test:1",
        }
        first = client.post(
            "/api/factory/robot-telemetry/gw-test", json=payload,
            headers={"X-Gateway-Token": token},
        )
        assert first.status_code == 200, first.text
        got = first.json()
        assert got["x"] == 0.0 and got["y"] == 0.0
        assert got["battery_pct"] == 0
        assert got["position_known"] is True
        assert got["duplicate"] is False

        again = client.post(
            "/api/factory/robot-telemetry/gw-test", json=payload,
            headers={"X-Gateway-Token": token},
        )
        assert again.status_code == 200
        assert again.json()["duplicate"] is True
        with SessionLocal() as db:
            assert db.query(RobotEvent).filter(RobotEvent.gateway_id == "gw-test").count() == 1
        events = client.get(f"/api/factory/robot-events?robot_id={robot['id']}")
        assert events.status_code == 200, events.text
        assert events.json()["events"][0]["quality"] == "measured"

        wrong = client.post(
            "/api/factory/robot-telemetry/gw-test", json=payload,
            headers={"X-Gateway-Token": "falsch"},
        )
        assert wrong.status_code == 401
        bad = client.post(
            "/api/factory/robot-telemetry/gw-test",
            json={**payload, "battery_pct": 101, "idempotency_key": "gw-test:2"},
            headers={"X-Gateway-Token": token},
        )
        assert bad.status_code == 400
    finally:
        assert client.delete(f"/api/factory/robots/{robot['id']}").status_code == 204
        forget_robot(robot["id"])
        assert client.delete(f"/api/factory/robot-gateways/{gateway['id']}").status_code == 204


def test_way_between_stations_uses_the_aisle_graph(client):
    from gimel.db import SessionLocal
    from gimel.models import FactoryStation

    with SessionLocal() as db:
        first = db.query(FactoryStation).filter(FactoryStation.floor_id.isnot(None)).first()
        assert first is not None
        first_id, floor_id = first.id, first.floor_id
        other = (
            db.query(FactoryStation)
            .filter(FactoryStation.floor_id == floor_id)
            .filter(FactoryStation.id != first_id)
            .first()
        )
        other_id = other.id if other is not None else None
    assert other_id is not None
    planned = client.post("/api/factory/robot-ways/plan", json={
        "from_station_id": first_id, "to_station_id": other_id,
    })
    assert planned.status_code == 200, planned.text
    body = planned.json()
    assert len(body["route"]) >= 2
    assert body["route_m"] > 0


def test_a_job_carries_order_context_and_runs_through_the_states(client):
    from gimel.db import SessionLocal
    from gimel.models import FactoryStation, RobotAsset, RobotJob, WorkOrder, WorkOrderStatus

    with SessionLocal() as db:
        robot = (
            db.query(RobotAsset)
            .filter(RobotAsset.gateway_id == "sim", RobotAsset.active.is_(True))
            .order_by(RobotAsset.id.asc())
            .first()
        )
        assert robot is not None and robot.floor_id is not None
        stations = (
            db.query(FactoryStation)
            .filter(FactoryStation.floor_id == robot.floor_id)
            .order_by(FactoryStation.id.asc())
            .all()
        )
        assert len(stations) >= 2
        start_id, end_id = stations[0].id, stations[1].id
        wo = WorkOrder(no="TEST-RT-9001", run_id=1, mat="epdm-70", thk=2.0,
                       status=WorkOrderStatus.open, station_id=end_id)
        db.add(wo)
        db.commit()
        wo_id = wo.id
        robot_id = robot.id

    before = client.get("/api/factory/robot-jobs").json()["jobs"]
    planned = client.post("/api/factory/robot-jobs/plan", json={
        "work_order_id": wo_id, "from_station_id": start_id, "to_station_id": end_id,
    })
    assert planned.status_code == 200, planned.text
    plan = planned.json()
    assert plan["context"]["work_order_no"] == "TEST-RT-9001"
    assert plan["route_m"] > 0
    assert client.get("/api/factory/robot-jobs").json()["jobs"] == before

    created = client.post("/api/factory/robot-jobs", json={
        "work_order_id": wo_id, "from_station_id": start_id, "to_station_id": end_id,
        "priority": 2,
    })
    assert created.status_code == 201, created.text
    job = created.json()
    assert job["ref"].startswith("RT-")
    assert job["state"] == "proposed"
    assert job["work_order_no"] == "TEST-RT-9001"
    try:
        assert client.post(f"/api/factory/robot-jobs/{job['id']}/approve").status_code == 200
        assigned = client.post(f"/api/factory/robot-jobs/{job['id']}/assign",
                               json={"robot_id": robot_id})
        assert assigned.status_code == 200, assigned.text
        assert assigned.json()["state"] == "assigned"
        assert assigned.json()["robot_id"] == robot_id

        started = client.post(f"/api/factory/robot-jobs/{job['id']}/start")
        assert started.status_code == 200, started.text
        assert started.json()["state"] == "running"
        with SessionLocal() as db:
            assert db.get(RobotAsset, robot_id).state == "moving"

        finished = client.post(f"/api/factory/robot-jobs/{job['id']}/done", json={"note": "abgelegt"})
        assert finished.status_code == 200, finished.text
        assert finished.json()["state"] == "done"
        with SessionLocal() as db:
            assert db.get(RobotAsset, robot_id).state == "idle"
            assert db.query(RobotJob).filter(RobotJob.id == job["id"]).count() == 1
    finally:
        with SessionLocal() as db:
            db.query(RobotJob).filter(RobotJob.id == job["id"]).delete()
            db.query(WorkOrder).filter(WorkOrder.id == wo_id).delete()
            db.commit()


def test_a_cross_level_robot_way_is_refused(client):
    from gimel.db import SessionLocal
    from gimel.models import FactoryStation

    with SessionLocal() as db:
        a = db.query(FactoryStation).filter(FactoryStation.floor_id.isnot(None)).first()
        assert a is not None
        a_id, floor_id = a.id, a.floor_id
        b = (
            db.query(FactoryStation)
            .filter(FactoryStation.floor_id.isnot(None))
            .filter(FactoryStation.floor_id != floor_id)
            .first()
        )
        b_id = b.id if b is not None else None
    assert b_id is not None
    r = client.post("/api/factory/robot-ways/plan", json={
        "from_station_id": a_id, "to_station_id": b_id,
    })
    assert r.status_code == 400
    assert "Andere Ebene" in r.json()["detail"]
