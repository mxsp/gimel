"""Beziehungen eines Belegs: von jeder Nummer zu den Nachbarn, in beide Richtungen."""

from __future__ import annotations

from gimel.db import SessionLocal
from gimel.models import WorkItem, WorkOrder


def _pair():
    """Ein Innenauftrag der Demo mit mindestens einem Auftrag darauf."""
    with SessionLocal() as db:
        item = db.query(WorkItem).first()
        assert item is not None, "Demo ohne Platzierung"
        wo = db.get(WorkOrder, item.work_order_id)
        return wo.no, item.order_no


def _nos(body, kind):
    return {i["no"] for g in body["groups"] for i in g["items"] if i["kind"] == kind}


def test_work_order_lists_its_orders_and_run(client):
    wo_no, order_no = _pair()
    r = client.get(f"/api/links/{wo_no}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "work_order"
    assert order_no in _nos(body, "order")
    assert _nos(body, "run")
    assert all(i["route"] for g in body["groups"] for i in g["items"])


def test_order_lists_the_work_order_back(client):
    wo_no, order_no = _pair()
    body = client.get(f"/api/links/{order_no}").json()
    assert body["kind"] == "order"
    assert wo_no in _nos(body, "work_order")


def test_run_links_both_sides(client):
    wo_no, order_no = _pair()
    run_no = next(iter(_nos(client.get(f"/api/links/{wo_no}").json(), "run")))
    body = client.get(f"/api/links/{run_no}").json()
    assert body["kind"] == "run"
    assert wo_no in _nos(body, "work_order")
    assert order_no in _nos(body, "order")


def test_unknown_number_is_404(client):
    assert client.get("/api/links/XX-00-0000").status_code == 404


def test_order_detail_names_the_work_order_not_itself(client):
    """Regression: ``WorkItem.order_no`` ist der Kundenauftrag, nicht der Innenauftrag."""
    wo_no, order_no = _pair()
    d = client.get(f"/api/admin/orders/{order_no}").json()
    assert wo_no in {w["no"] for w in d["work_orders"]}
    placed = [p["work_order_no"] for p in d["positions"] if p["work_order_no"]]
    assert placed and order_no not in placed
    w = next(w for w in d["work_orders"] if w["no"] == wo_no)
    assert w["run_no"] and w["own_parts"] >= 1
