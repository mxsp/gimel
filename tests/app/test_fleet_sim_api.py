"""Simulation geplanter Roboter über die API: liest nur, legt keine Roboter an."""

from __future__ import annotations


def _floor_with_flow(client):
    for f in client.get("/api/factory/topology").json().get("sites", [{}])[0].get("halls", [{}])[0].get("floors", []):
        d = client.get("/api/factory/fleet-sim/defaults", params={"floor_id": f["id"]})
        if d.status_code == 200 and d.json()["edges"] > 0:
            return f["id"], d.json()
    d = client.get("/api/factory/fleet-sim/defaults")
    return d.json()["floor_id"], d.json()


PARAMS = {"planned": [{"name": "AMR", "kind": "amr", "speed_m_s": 1.2, "count": 2}],
          "per_shift": 30, "horizon_h": 4, "handling_s": 60, "seed": 5, "sizing": True, "sizing_upto": 4}


def test_defaults_and_run_write_nothing(client):
    from gimel.db import SessionLocal
    from gimel.models import AuditLog, RobotAsset, RobotJob

    floor_id, d = _floor_with_flow(client)
    assert d["per_shift"] >= 0 and "basis" in d and len(d["start"]) == 2
    with SessionLocal() as db:
        before = (db.query(RobotAsset).count(), db.query(RobotJob).count(), db.query(AuditLog).count())
    r = client.post("/api/factory/fleet-sim/run", json={"floor_id": floor_id, "params": PARAMS})
    if r.status_code == 409:  # Ebene ohne Fluss in dieser Demo
        return
    assert r.status_code == 200, r.text
    out = r.json()
    assert set(out["tracks"]) == {"p1-1", "p1-2"}
    assert out["summary"]["demands"] == len(out["demands"]) > 0
    assert out["sizing"]["rows"][0]["planned"] == 1
    again = client.post("/api/factory/fleet-sim/run", json={"floor_id": floor_id, "params": PARAMS}).json()
    assert again["summary"] == out["summary"], "gesät heißt wiederholbar"
    with SessionLocal() as db:
        after = (db.query(RobotAsset).count(), db.query(RobotJob).count(), db.query(AuditLog).count())
    assert before == after


def test_run_limits(client):
    bad = dict(PARAMS, planned=[{"name": "x", "kind": "amr", "speed_m_s": 1, "count": 8}] * 2)
    assert client.post("/api/factory/fleet-sim/run", json={"params": bad}).status_code == 422
    assert client.post("/api/factory/fleet-sim/run", json={"params": dict(PARAMS, horizon_h=48)}).status_code == 422
    assert client.post("/api/factory/fleet-sim/run",
                       json={"params": dict(PARAMS, planned=[{"kind": "drone"}])}).status_code == 422


def test_scenarios_round_trip_and_roles(client):
    from tests.app.test_twin_studio import _login

    floor_id, _ = _floor_with_flow(client)
    r = client.post("/api/factory/fleet-sim/scenarios", json={"floor_id": floor_id, "name": " Zwei AMR ", "params": PARAMS})
    assert r.status_code == 201, r.text
    sc = r.json()
    assert sc["name"] == "Zwei AMR" and sc["params"]["planned"][0]["count"] == 2
    assert any(s["id"] == sc["id"] for s in client.get("/api/factory/fleet-sim/scenarios", params={"floor_id": floor_id}).json())
    worker = _login(client, "worker")
    assert worker.get("/api/factory/fleet-sim/scenarios").status_code == 403
    assert worker.post("/api/factory/fleet-sim/run", json={"params": PARAMS}).status_code == 403
    other = _login(client, "staff")
    assert other.delete(f"/api/factory/fleet-sim/scenarios/{sc['id']}").status_code == 403
    assert client.delete(f"/api/factory/fleet-sim/scenarios/{sc['id']}").status_code == 204

    from gimel.db import SessionLocal
    from gimel.models import AuditLog

    with SessionLocal() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "fleet_scenario_create").count() >= 1
        assert db.query(AuditLog).filter(AuditLog.action == "fleet_scenario_delete").count() >= 1
