"""State-changing routes leave a line in the audit log; reads and no-ops leave none."""

from __future__ import annotations

import pytest

from gimel import demo
from gimel.db import SessionLocal
from gimel.models import AuditLog, FactoryStation, Order, Product, StationTask, User, WorkOrder


@pytest.fixture
def forget_new_orders():
    """Other tests count the 8 demo orders."""
    with SessionLocal() as db:
        known = {no for (no,) in db.query(Order.no)}
    yield
    with SessionLocal() as db:
        for order in db.query(Order).filter(Order.no.notin_(known)):
            db.delete(order)
        db.commit()


def lines(action: str) -> list[AuditLog]:
    with SessionLocal() as db:
        return db.query(AuditLog).filter(AuditLog.action == action).order_by(AuditLog.id).all()


def count() -> int:
    with SessionLocal() as db:
        return db.query(AuditLog).count()


def _station_body() -> dict:
    with SessionLocal() as db:
        s = db.query(FactoryStation).first()
    return {"label": "Prüfplatz", "type": s.type.value, "x": 1.0, "y": 1.0}


def test_a_station_leaves_a_line_when_made_changed_and_deleted(client):
    r = client.post("/api/factory/stations", json=_station_body())
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    assert lines("station_create")[-1].entity_id == str(sid)
    assert lines("station_create")[-1].actor == demo.ADMIN_EMAIL

    body = _station_body()
    assert client.put(f"/api/factory/stations/{sid}", json=body).status_code == 200
    assert not lines("station_update"), "saving the same values changes nothing"

    body["label"] = "Prüfplatz 2"
    assert client.put(f"/api/factory/stations/{sid}", json=body).status_code == 200
    assert lines("station_update")[-1].detail["fields"] == ["label"]

    assert client.delete(f"/api/factory/stations/{sid}").status_code == 204
    assert lines("station_delete")[-1].detail["label"] == "Prüfplatz 2"


def test_the_floor_and_a_setting_leave_a_line(client):
    floor = client.get("/api/factory/floor").json()
    keep = {k: floor[k] for k in ("name", "outline", "zones", "obstacles", "doors", "aisles",
                                  "scale", "grid", "snap", "bg")}
    assert client.put("/api/factory/floor", json=keep).status_code == 200
    assert lines("floor_update")

    assert client.put("/api/factory/settings/w_test", json={"value": "1"}).status_code == 200
    n = count()
    assert client.put("/api/factory/settings/w_test", json={"value": "1"}).status_code == 200
    assert count() == n, "the same value again is not a change"
    assert client.put("/api/factory/settings/w_test", json={"value": "2"}).status_code == 200
    assert lines("factory_setting")[-1].detail == {"before": "1", "after": "2"}


def test_a_hand_assignment_leaves_a_line(client):
    with SessionLocal() as db:
        wo = db.query(WorkOrder).first()
        no = wo.no
        sid = db.query(FactoryStation).filter(
            FactoryStation.type == "production").first().id
    r = client.post(f"/api/factory/work-orders/{no}/assign",
                    json={"station_id": sid, "note": "Meister"})
    assert r.status_code == 200, r.text
    last = lines("work_order_assign")[-1]
    assert last.entity_id == no
    assert last.detail["note"] == "Meister"


def test_a_handler_leaves_a_line_only_when_it_changes(client):
    with SessionLocal() as db:
        no = db.query(Order).first().no
        uid = db.query(User).filter(User.email == demo.ADMIN_EMAIL).one().id
    path = f"/api/factory/orders/{no}/handler"
    assert client.post(path, json={"user_id": uid, "note": "x"}).status_code == 200
    n = len(lines("order_handler"))
    assert n and lines("order_handler")[-1].detail["handler_user_id"] == uid
    assert client.post(path, json={"user_id": uid, "note": "x"}).status_code == 200
    assert len(lines("order_handler")) == n


def test_a_task_state_and_a_pinned_order_leave_a_line(client):
    with SessionLocal() as db:
        task = db.query(StationTask).filter(StationTask.state == "ready",
                                            StationTask.station_id.isnot(None)).first()
        tid, key, sid = task.id, f"{task.kind}:{task.ref}", task.station_id
    assert client.post(f"/api/factory/stations/{sid}/worklist/order",
                       json={"keys": [key]}).status_code == 200
    assert lines("worklist_reorder")[-1].detail["pinned"] == 1
    assert client.delete(f"/api/factory/stations/{sid}/worklist/order").status_code == 200
    assert lines("worklist_unpin")

    r = client.post(f"/api/factory/tasks/{tid}/state", json={"state": "running"})
    assert r.status_code == 200, r.text
    assert lines("task_state")[-1].detail["state"] == "running"
    assert client.post(f"/api/factory/tasks/{tid}/state", json={"state": "ready"}).status_code == 200


def test_a_read_and_a_simulation_leave_no_line(client):
    n = count()
    client.get("/api/factory/floor")
    client.get("/api/factory/plan")
    assert client.post("/api/factory/routing/simulate", json={}).status_code == 200
    assert count() == n


def _order_body() -> dict:
    with SessionLocal() as db:
        p = db.query(Product).first()
        mat, thk = p.id, float(p.thicknesses[0])
    return {"lines": [{"id": 1, "kind": "gasket", "mat": mat, "q": 1, "thk": thk,
                       "od": 120, "di": 60, "label": "Test"}],
            "ship_address": {"company": "Prüf GmbH", "street": "Weg 1", "city": "Köthen"},
            "cert": ""}


def test_a_new_order_and_a_reorder_leave_a_line(client, forget_new_orders):
    r = client.post("/api/orders", json=_order_body())
    assert r.status_code == 201, r.text
    no = r.json()["no"]
    last = lines("order_create")[-1]
    assert (last.entity_id, last.actor) == (no, demo.ADMIN_EMAIL)
    r = client.post(f"/api/orders/{no}/reorder")
    assert r.status_code == 201, r.text
    assert lines("order_reorder")[-1].detail["reorder_of"] == no


def test_a_guest_order_names_no_account(client, forget_new_orders):
    token = client.headers.pop("Authorization")
    try:
        r = client.post("/api/orders", json=_order_body())
    finally:
        client.headers["Authorization"] = token
    assert r.status_code == 201, r.text
    assert lines("order_create")[-1].actor == "public"


def test_an_erp_sync_is_booked_under_the_signed_in_user(client, monkeypatch):
    from gimel.services import erp_sync
    from gimel.services.erp_sync import StockLevel

    with SessionLocal() as db:
        mat, stock = db.query(Product.id, Product.stock).first()

    class Adapter:
        def fetch_stock(self, mats=None):
            return [StockLevel(mat=mat, stock=int(stock) + 5, source="test-erp")]

        def health(self):
            return {"mode": "test"}

    monkeypatch.setattr(erp_sync, "get_adapter", lambda db: Adapter())
    r = client.post("/api/integration/sync", json={"actor": "jemand-anderes"})
    assert r.status_code == 200, r.text
    last = lines("erp_sync")[-1]
    assert last.actor == demo.ADMIN_EMAIL
    assert last.entity_id == mat
    with SessionLocal() as db:
        p = db.get(Product, mat)
        p.stock = stock
        db.commit()
