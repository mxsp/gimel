"""Auftragsweg-Regressionen: Detailansicht, Zeitstrahl, Storno/Intern, Querverweise."""

from __future__ import annotations

import uuid

from gimel.db import SessionLocal
from gimel.models import Order, OrderPosition, Role, Shipment, ShipmentItem, ShipmentStatus, User
from gimel.security import create_access_token, hash_password


def _auth_header(role: Role) -> dict[str, str]:
    email = f"{role.value}-{uuid.uuid4().hex[:6]}@example.test"
    with SessionLocal() as db:
        u = User(
            email=email,
            name=role.value,
            role=role,
            password_hash=hash_password("cedar-brook-8841"),
        )
        db.add(u)
        db.commit()
        token = create_access_token(u)
    return {"Authorization": f"Bearer {token}"}


def _cleanup_order(no: str, customer_id: int | None = None) -> None:
    with SessionLocal() as db:
        order = db.query(Order).filter(Order.no == no).first()
        if order is not None:
            for si in db.query(ShipmentItem).filter(ShipmentItem.order_id == order.id).all():
                sh = db.get(Shipment, si.shipment_id)
                db.delete(si)
                if sh is not None:
                    db.delete(sh)
            db.delete(order)
        if customer_id is not None:
            u = db.get(User, customer_id)
            if u is not None:
                db.delete(u)
        db.commit()


def test_internal_order_detail_keeps_owner_and_omits_ship_paid_timeline(client):
    r = client.post(
        "/api/desk/orders",
        json={
            "kind": "internal",
            "internal_owner": "Frau Meister",
            "lines": [{"id": 1, "mat": "epdm-70", "thk": 2, "label": "Ring", "od": 100, "di": 50, "q": 2}],
        },
    )
    assert r.status_code == 201, r.text
    no = r.json()["no"]
    try:
        detail = client.get(f"/api/admin/orders/{no}").json()
        assert detail["kind"] == "internal"
        assert detail["customer"] == "Frau Meister"

        tl = client.get(f"/api/admin/orders/{no}/timeline").json()
        ids = [s["id"] for s in tl["steps"]]
        assert "shipped" not in ids
        assert "paid" not in ids
        assert tl["state"] == "active"
    finally:
        _cleanup_order(no)


def test_order_detail_office_note_visibility_and_shipment_dedup(client):
    c = client.post(
        "/api/customers",
        json={"email": f"path-{uuid.uuid4().hex[:8]}@musterwerk.example", "company": "Pfad GmbH"},
    )
    assert c.status_code == 201, c.text
    cid = c.json()["id"]
    r = client.post(
        "/api/desk/orders",
        json={
            "customer_id": cid,
            "payment_mode": "account",
            "lines": [
                {"id": 1, "mat": "epdm-70", "thk": 2, "label": "Ring A", "od": 100, "di": 50, "q": 2},
                {"id": 2, "mat": "epdm-70", "thk": 2, "label": "Ring B", "od": 120, "di": 60, "q": 3},
            ],
            "ship_address": {"company": "Pfad GmbH", "street": "Str. 1", "zip": "06366", "city": "Köthen", "country": "DE"},
        },
    )
    assert r.status_code == 201, r.text
    no = r.json()["no"]
    try:
        # Büronotiz speichern: Büro sieht sie, Werker nie.
        patch = client.patch(f"/api/desk/orders/{no}", json={"office_note": "Abholung nach Anruf"})
        assert patch.status_code == 200, patch.text

        office_detail = client.get(f"/api/admin/orders/{no}").json()
        assert office_detail["office_note"] == "Abholung nach Anruf"

        worker_detail = client.get(f"/api/admin/orders/{no}", headers=_auth_header(Role.worker)).json()
        assert worker_detail["office_note"] == ""

        # Zwei Positionen in derselben Sendung: order_detail nennt den Versand genau einmal.
        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one()
            positions = db.query(OrderPosition).filter(OrderPosition.order_id == order.id).all()
            sh = Shipment(no=f"VS-TEST-{uuid.uuid4().hex[:6]}", status=ShipmentStatus.packing, carrier="UPS")
            db.add(sh)
            db.flush()
            for p in positions:
                db.add(ShipmentItem(shipment_id=sh.id, order_id=order.id, order_no=order.no, position_id=p.id, label=p.label, qty=p.qty))
            db.commit()
            ship_no = sh.no

        dedup_detail = client.get(f"/api/admin/orders/{no}").json()
        assert len(dedup_detail["shipments"]) == 1
        assert dedup_detail["shipments"][0]["no"] == ship_no
        assert dedup_detail["shipments"][0]["n_items"] == 2

        # Querverweis springt direkt zur Sendung.
        links = client.get(f"/api/links/{no}").json()
        ship_links = [it for g in links["groups"] for it in g["items"] if it["kind"] == "shipment"]
        assert ship_links and ship_links[0]["route"] == f"versand/{ship_no}"
    finally:
        _cleanup_order(no, cid)


def test_cancelled_order_timeline_has_no_current_step_or_rollback(client):
    c = client.post(
        "/api/customers",
        json={"email": f"cancel-{uuid.uuid4().hex[:8]}@musterwerk.example", "company": "Storno GmbH"},
    )
    assert c.status_code == 201, c.text
    cid = c.json()["id"]
    r = client.post(
        "/api/desk/orders",
        json={
            "customer_id": cid,
            "payment_mode": "account",
            "lines": [{"id": 1, "mat": "epdm-70", "thk": 2, "label": "Ring", "od": 100, "di": 50, "q": 1}],
            "ship_address": {"company": "Storno GmbH", "street": "Str. 1", "zip": "06366", "city": "Köthen", "country": "DE"},
        },
    )
    assert r.status_code == 201, r.text
    no = r.json()["no"]
    try:
        res = client.post(f"/api/desk/orders/{no}/cancel", json={"reason": "Kunde hat abgesagt"})
        assert res.status_code == 200, res.text
        tl = client.get(f"/api/admin/orders/{no}/timeline").json()
        assert tl["state"] == "cancelled"
        assert not any(s["current"] for s in tl["steps"])
        assert not any(s["can_rollback"] for s in tl["steps"])
    finally:
        _cleanup_order(no, cid)
