"""Interne Aufträge: kein Kunde, keine Zahlung, keine Rechnung — aber ein
verantwortlicher Mitarbeiter. Der externe Weg bleibt unverändert."""

from __future__ import annotations

from gimel.db import SessionLocal
from gimel.models import Order

LINES = [
    {"id": 1, "mat": "epdm-70", "thk": 2, "label": "Innenring", "od": 120, "di": 60, "q": 2}
]


def _internal_order(client, owner: str = "Meister Meier"):
    return client.post(
        "/api/desk/orders",
        json={"kind": "internal", "internal_owner": owner, "lines": LINES},
    )


def test_internal_order_requires_a_responsible_worker(client):
    response = _internal_order(client, owner="   ")
    assert response.status_code == 422
    assert "verantwortlichen Mitarbeiter" in response.json()["detail"]


def test_internal_order_has_no_customer_payment_or_invoice(client):
    response = _internal_order(client)
    assert response.status_code == 201, response.text
    body = response.json()
    no = body["no"]
    try:
        assert body["kind"] == "internal"
        assert body["internal_owner"] == "Meister Meier"
        assert body["customer_id"] is None
        assert body["customer_name"] == "Meister Meier"
        assert body["customer_email"] == ""
        assert body["paid"] is False
        assert body["invoice_no"] == ""
        assert body["released"] is True
        assert body["gross"] == body["net"], "kein Kunde, keine Umsatzsteuer"

        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one()
            assert order.kind == "internal"
            assert order.internal_owner == "Meister Meier"
            assert order.user_id is None
            assert order.ship_address == {}
            assert order.bill_address == {}
            assert order.payment_method == "internal"

        # Der interne Auftrag steht mit seinem Verantwortlichen in der Liste.
        row = next(
            o for o in client.get("/api/desk/orders").json() if o["no"] == no
        )
        assert row["kind"] == "internal"
        assert row["internal_owner"] == "Meister Meier"

        # Rechnungen sind für interne Aufträge nicht vorgesehen.
        invoice = client.post(f"/api/invoicing/orders/{no}/invoice", json={})
        assert invoice.status_code == 409
        assert "Interner Auftrag" in invoice.json()["detail"]
    finally:
        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one_or_none()
            if order is not None:
                db.delete(order)
                db.commit()
