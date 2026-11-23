"""One order from intake to e-invoice, on an empty database, in its own process:
no plugin, no Stripe key, nothing shared with the other tests. See test_standalone_flow.py."""

from __future__ import annotations

from xml.etree import ElementTree as ET

from fastapi.testclient import TestClient

from gimel import demo
from gimel.app import create_app
from gimel.db import SessionLocal
from gimel.extensions import active
from gimel.seed import init_db
from gimel.services import einvoice, stripe_client

assert active() is None and stripe_client.secret_key() == ""
init_db(verbose=False)
with SessionLocal() as db:
    password = demo.seed(db)

with TestClient(create_app()) as c:
    r = c.post("/api/auth/login", data={"username": demo.ADMIN_EMAIL, "password": password})
    assert r.status_code == 200, r.text
    c.headers["Authorization"] = f"Bearer {r.json()['access_token']}"

    def ok(r, code=200):
        assert r.status_code == code, f"{r.request.url}: {r.status_code} {r.text}"
        return r.json()

    config = ok(c.get("/api/invoicing/config"))
    assert config["configured"] is False and config["local_invoicing"] is True

    address = {"company": "Fluss Kunde GmbH", "street": "Am Fluss 3", "zip": "54321", "city": "Flussstadt", "country": "DE"}
    order = ok(c.post("/api/desk/orders", json={
        "lines": [{"id": 1, "mat": "epdm-70", "thk": 2, "label": "Ring", "od": 120, "di": 60, "q": 6}],
        "new_customer": {"email": "fluss@kunde.example", "company": "Fluss Kunde GmbH"},
        "ship_address": address, "payment_mode": "account", "customer_ref": "PO-FLOW"}), 201)
    no = order["no"]
    assert order["released"] is True

    ok(c.post("/api/production/runs", params={"force": True}), 201)
    detail = ok(c.get(f"/api/production/orders/{no}"))
    work_orders = sorted({p["work_order_no"] for p in detail["positions"] if p.get("work_order_no")}) \
        or sorted(w["no"] for w in ok(c.get("/api/production/work-orders")) if w["status"] == "open")
    assert work_orders, detail
    for wo in work_orders:
        ok(c.post(f"/api/production/work-orders/{wo}/status", json={"status": "done"}))

    shipment = ok(c.post("/api/shipping/", json={"order_nos": [no], "carrier": "Eigenabholung"}))
    ok(c.patch(f"/api/shipping/{shipment['no']}", json={"status": "shipped"}))

    ok(c.post(f"/api/invoicing/orders/{no}/invoice/paid", json={"note": "Überweisung vom 30.10.2026"}))
    assert ok(c.get(f"/api/invoicing/orders/{no}/billing-check"))["ready"] is True

    invoice = ok(c.post(f"/api/invoicing/orders/{no}/invoice", json={}), 201)
    assert invoice["status"] == "paid" and invoice["local"] is True

    xml = c.get(f"/api/invoicing/orders/{no}/invoice.xml")
    assert xml.status_code == 200, xml.text
    ns = einvoice.NS
    root = ET.fromstring(xml.text)
    assert root.findtext("cbc:ID", namespaces={"cbc": ns["cbc"]}) == invoice["number"]
    assert root.find("cac:Delivery/cbc:ActualDeliveryDate", {"cac": ns["cac"], "cbc": ns["cbc"]}) is not None
    assert "Musterwerk GmbH" in xml.text and "Fluss Kunde GmbH" in xml.text
    gross = root.findtext("cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount", namespaces={"cac": ns["cac"], "cbc": ns["cbc"]})
    assert round(float(gross) * 100) == round(order["gross"] * 100)
    page = c.get(invoice["html_url"])
    assert page.status_code == 200 and invoice["number"] in page.text
    assert not [w for w in ("FyreFly", "Alef", "Alpha") if w in xml.text + page.text]
print("flow ok", no, invoice["number"])
