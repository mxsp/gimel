"""The order search finds what a caller quotes on the phone, once per order."""

from __future__ import annotations

import pytest

from gimel.config import get_settings
from gimel.db import SessionLocal
from gimel.models import (
    InvoiceDocument,
    Order,
    OrderPosition,
    Shipment,
    ShipmentItem,
    WorkItem,
    WorkOrder,
)

KEY = "k1:" + "A" * 43  # 32 bytes base64url, tests only


def search(client, q: str) -> list[str]:
    body = client.get("/api/admin/orders", params={"q": q, "limit": 500}).json()
    nos = [o["no"] for o in body["items"]]
    assert body["total"] == len(nos), "total and rows must agree"
    assert len(nos) == len(set(nos)), "an order appears once"
    return nos


def _order_in_a_run(db) -> tuple[Order, WorkOrder]:
    item = db.query(WorkItem).filter(WorkItem.position_id.isnot(None)).first()
    position = db.get(OrderPosition, item.position_id)
    return db.get(Order, position.order_id), db.get(WorkOrder, item.work_order_id)


def test_finds_the_customer_company_from_the_account(client):
    with SessionLocal() as db:
        order = db.query(Order).filter(Order.user_id.isnot(None)).first()
        company, no = order.user.company, order.no
    assert no in search(client, company.upper())


def test_finds_a_guest_by_the_company_on_the_address(client):
    with SessionLocal() as db:
        order = db.query(Order).order_by(Order.id).first()
        user_id, no = order.user_id, order.no
        order.user_id = None
        order.ship_address = {"company": "Gastfirma Zuckerbäcker KG"}
        db.commit()
    try:
        assert search(client, "zuckerbäcker") == [no]
    finally:
        with SessionLocal() as db:
            db.query(Order).filter(Order.no == no).one().user_id = user_id
            db.commit()


def test_address_and_manual_tracking_are_found_when_encrypted(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "data_keys", KEY)
    with SessionLocal() as db:
        order = db.query(Order).order_by(Order.id.desc()).first()
        no, ship = order.no, dict(order.ship_address)
        order.ship_address = {"company": "Verschluesselt AG"}
        order.manual_shipment = {"carrier": "Spedition", "tracking": "MANUELL-77"}
        db.commit()
        raw = db.connection().exec_driver_sql(
            "SELECT ship_address FROM orders WHERE no = ?", (no,)
        ).scalar()
    try:
        assert "Verschluesselt" not in raw
        assert search(client, "verschluesselt") == [no]
        assert search(client, "manuell-77") == [no]
    finally:
        # Read under the key, write without it: later tests run with no key.
        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one()
            monkeypatch.setattr(get_settings(), "data_keys", "")
            order.ship_address, order.manual_shipment = ship, {}
            db.commit()


def test_a_work_order_number_finds_its_orders_once_each(client):
    with SessionLocal() as db:
        order, wo = _order_in_a_run(db)
        order_no, wo_no = order.no, wo.no
        members = {i.order_no for i in db.query(WorkItem).filter(WorkItem.work_order_id == wo.id)}
    assert set(search(client, wo_no)) == members
    row = next(
        o for o in client.get("/api/admin/orders", params={"q": wo_no}).json()["items"]
        if o["no"] == order_no
    )
    assert wo_no in [w["no"] for w in row["work_orders"]], "the hit shows why it matched"


def test_finds_invoice_number_and_stripe_reference(client):
    with SessionLocal() as db:
        order = db.query(Order).order_by(Order.id).offset(3).first()
        no = order.no
        order.invoice_no = "in_1Abc"
        order.invoice_reference = "VZ-4711"
        db.add(InvoiceDocument(order_no=no, invoice_no="in_1Abc", number="RE-2026-0815"))
        db.commit()
    assert search(client, "RE-2026-0815") == [no]
    assert search(client, "vz-4711") == [no]
    assert search(client, "in_1abc") == [no]


def test_finds_a_tracking_number_with_two_items_in_the_parcel(client):
    with SessionLocal() as db:
        order = db.query(Order).order_by(Order.id).offset(4).first()
        shipment = Shipment(no="LS-T-1", tracking="1Z999AA10123456784")
        shipment.items = [
            ShipmentItem(order_id=order.id, order_no=order.no),
            ShipmentItem(order_id=order.id, order_no=order.no),
        ]
        no = order.no
        db.add(shipment)
        db.commit()
    assert search(client, "1z999aa1012") == [no]


@pytest.mark.parametrize("q", ["%", "PO-_", "\\"])
def test_like_wildcards_are_plain_characters(client, q):
    assert search(client, q) == []


def test_no_match_and_empty_query(client):
    assert search(client, "gibt-es-nicht") == []
    assert client.get("/api/admin/orders", params={"q": "  "}).json()["total"] == 8


def test_a_worker_finds_only_what_the_list_shows_and_sees_no_money(client):
    from gimel.models import Role, User
    from gimel.security import create_access_token

    with SessionLocal() as db:
        order = db.query(Order).filter(Order.user_id.isnot(None)).first()
        saved = order.bill_address, order.contact_email, order.net
        order.bill_address = {"company": "Nur-im-Büro GmbH"}
        order.contact_email = "buero@example.test"
        order.net = 100.0
        no = order.no
        worker = db.query(User).filter(User.email == "halle@example.test").first()
        if worker is None:
            worker = User(email="halle@example.test", name="Halle", role=Role.worker,
                          password_hash="x")
            db.add(worker)
        db.commit()
        token = create_access_token(worker)
    assert no in search(client, "Nur-im-Büro")
    assert no in search(client, "buero@example.test")
    auth = {"Authorization": f"Bearer {token}"}

    def as_worker(q):
        return client.get("/api/admin/orders", params={"q": q, "limit": 500}, headers=auth).json()

    try:
        assert as_worker("Nur-im-Büro")["items"] == []
        assert as_worker("buero@example.test")["items"] == []
        row = as_worker(no)["items"][0]
        assert (row["net"], row["gross"], row["invoice_no"], row["paid"]) == (0, 0, "", False)
    finally:
        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one()
            order.bill_address, order.contact_email, order.net = saved
            db.commit()
