"""Was die Halle sieht und tut (Durchsicht der Werker-Routen, 2026-11-14).

Rechnungsnummern, Gateway-Adressen und das Wegwerfen geplanter Robotertransporte
sind Bürosache; die Halle sieht Stand und Weg und meldet einen laufenden
Transport als gescheitert.
"""

from __future__ import annotations

import uuid

from gimel.db import SessionLocal
from gimel.models import AuditLog, Order, RobotGateway, RobotJob, Role, User
from gimel.security import create_access_token


def _head(role: Role) -> dict:
    with SessionLocal() as db:
        u = User(email=f"{role.value}-{uuid.uuid4().hex[:6]}@example.test", name=role.value,
                 role=role, password_hash="x")
        db.add(u)
        db.commit()
        return {"Authorization": f"Bearer {create_access_token(u)}"}


def _order_with_invoice() -> str:
    with SessionLocal() as db:
        o = db.query(Order).filter(Order.invoice_no == "").first()
        no, before = o.no, o.invoice_no
        o.invoice_no = "RE-SCOPE-1"
        db.commit()
    return no


def test_the_hall_gets_no_invoice_link(client):
    no = _order_with_invoice()
    try:
        office = client.get(f"/api/links/{no}").json()
        assert any(g["kind"] == "invoice" for g in office["groups"])
        hall = client.get(f"/api/links/{no}", headers=_head(Role.worker)).json()
        assert all(g["kind"] != "invoice" for g in hall["groups"])
        assert "RE-SCOPE-1" not in str(hall)
    finally:
        with SessionLocal() as db:
            db.query(Order).filter(Order.no == no).update({"invoice_no": ""})
            db.commit()


def test_the_hall_sees_gateways_without_addresses(client):
    code = f"gw-scope-{uuid.uuid4().hex[:6]}"
    with SessionLocal() as db:
        db.add(RobotGateway(code=code, name="Prüf-Gateway", kind="http",
                            base_url="http://10.0.0.7:8080", endpoints={"start": "/cmd/start"},
                            note="Schrank 3"))
        db.commit()
    try:
        def row(head=None):
            body = client.get("/api/factory/robot-gateways", headers=head or {}).json()
            return next(g for g in body["gateways"] if g["code"] == code)
        assert row()["base_url"] == "http://10.0.0.7:8080"
        hall = row(_head(Role.worker))
        assert hall["base_url"] == "" and hall["endpoints"] == {} and hall["note"] == ""
        assert hall["name"] == "Prüf-Gateway"
    finally:
        with SessionLocal() as db:
            db.query(RobotGateway).filter(RobotGateway.code == code).delete()
            db.commit()


def test_the_hall_reports_only_a_running_transport_as_failed(client):
    with SessionLocal() as db:
        job = RobotJob(ref=f"RJ-SCOPE-{uuid.uuid4().hex[:6]}", state="proposed")
        db.add(job)
        db.commit()
        job_id = job.id
    try:
        worker = _head(Role.worker)
        r = client.post(f"/api/factory/robot-jobs/{job_id}/fail", json={"note": "weg"}, headers=worker)
        assert r.status_code == 403 and "laufender Transport" in r.json()["detail"]
        with SessionLocal() as db:
            assert db.get(RobotJob, job_id).state == "proposed"
            db.get(RobotJob, job_id).state = "running"
            db.commit()
        r = client.post(f"/api/factory/robot-jobs/{job_id}/fail", json={"note": "klemmt"}, headers=worker)
        assert r.status_code == 200, r.text
        with SessionLocal() as db:
            assert db.query(AuditLog).filter(AuditLog.action == "robot_job_fail",
                                             AuditLog.entity_id == str(job_id)).count() >= 1
    finally:
        with SessionLocal() as db:
            db.query(RobotJob).filter(RobotJob.id == job_id).delete()
            db.commit()
