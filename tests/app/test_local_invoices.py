"""Invoices without Stripe: gap-free numbers, immutable rows, correction by Storno only."""

from __future__ import annotations

import threading
from xml.etree import ElementTree as ET

import pytest
from sqlalchemy import text

from gimel import demo
from gimel.db import SessionLocal
from gimel.extensions import Plugin, use
from gimel.models import AuditLog, LocalInvoice, LocalInvoiceCounter, Order, User
from gimel.schemas import QuoteLine
from gimel.services import einvoice, local_invoices, stripe_client
from gimel.services.orders import place_order

ADDRESS = {"company": "Test Kunde GmbH", "street": "Testweg 1", "zip": "99999", "city": "Teststadt", "country": "DE"}
UBL = {"cbc": einvoice.NS["cbc"], "cac": einvoice.NS["cac"]}


@pytest.fixture(autouse=True)
def no_stripe(monkeypatch):
    monkeypatch.setattr(stripe_client, "secret_key", lambda: "")


@pytest.fixture
def make_order(plant):
    made = []

    def make(address=ADDRESS, tax=None) -> str:
        with SessionLocal() as db:
            customer = db.query(User).filter(User.email == "einkauf1@musterwerk.example").one()
            line = QuoteLine(id=1, mat="epdm-70", thk=2, label="Ring", od=100, di=50, q=4)
            order = place_order(db, lines=[line], cert="", ship_address=address, bill_address=address,
                                tax_status=tax or {"rate": 0.19}, customer_ref="T-1", user=customer)
            made.append(order.no)
            return order.no

    yield make
    with SessionLocal() as db:
        for order in db.query(Order).filter(Order.no.in_(made)):
            db.delete(order)
        db.commit()


def post(client, no, **body):
    return client.post(f"/api/invoicing/orders/{no}/invoice",
                       json={"delivery_date": "2026-10-30", "due_days": 14, **body})


def last_seq() -> tuple[int, int]:
    with SessionLocal() as db:
        year = local_invoices.today().year
        row = db.get(LocalInvoiceCounter, year)
        return year, row.last if row else 0


def test_an_invoice_carries_every_paragraph_14_field_and_the_order_totals(client, make_order):
    no = make_order()
    r = post(client, no)
    assert r.status_code == 201, r.text
    out = r.json()
    number = out["number"]
    assert out["local"] is True and out["sent"] is False and out["status"] == "open"
    assert number.startswith(f"RE-{local_invoices.today().year}-")
    with SessionLocal() as db:
        order = db.query(Order).filter(Order.no == no).one()
        assert order.invoice_no == number
        net, vat, gross = round(order.net * 100), round(order.vat * 100), round(order.gross * 100)
        row = db.query(LocalInvoice).filter_by(number=number).one()
        assert (row.net_cents, row.vat_cents, row.gross_cents) == (net, vat, gross)
        line = db.query(AuditLog).filter_by(action="invoice_create", entity_id=no).order_by(AuditLog.id.desc()).first()
        assert line.detail["invoice_id"] == number and line.actor == demo.ADMIN_EMAIL

    page = client.get(f"/api/invoicing/orders/{no}/invoice.html")
    assert page.status_code == 200 and "<script" not in page.text
    for needed in ("Musterwerk GmbH", "Musterstraße 1", "12345 Musterstadt", "DE-MUSTER-0000", "000/000/00000",
                   "Test Kunde GmbH", "Testweg 1", "99999 Teststadt", number, "30.10.2026", "4 × Ring",
                   "Umsatzsteuer 19 %", "Summe netto", "Summe brutto"):
        assert needed in page.text, needed

    xml = client.get(f"/api/invoicing/orders/{no}/invoice.xml")
    assert xml.status_code == 200
    root = ET.fromstring(xml.text)
    assert root.tag.endswith("}Invoice")
    assert root.findtext("cbc:ID", namespaces=UBL) == number
    assert root.findtext("cbc:InvoiceTypeCode", namespaces=UBL) == "380"
    assert root.findtext("cac:Delivery/cbc:ActualDeliveryDate", namespaces=UBL) == "2026-10-30"
    assert root.find("cbc:DueDate", UBL) is not None
    payable = root.find("cac:LegalMonetaryTotal/cbc:PayableAmount", UBL)
    assert round(float(payable.text) * 100) == gross
    assert client.get(f"/api/invoicing/orders/{no}/invoice.pdf", follow_redirects=False).status_code == 307
    listed = [r for r in client.get("/api/invoicing/invoices").json() if r["order_no"] == no]
    assert listed[0]["has_einvoice"] is True


def test_a_paid_order_is_invoiced_as_paid(client, make_order):
    no = make_order()
    assert client.post(f"/api/invoicing/orders/{no}/invoice/paid", json={"note": "Überweisung vom 30.10."}).status_code == 200
    r = post(client, no)
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "paid" and r.json()["due_at"] is None
    root = ET.fromstring(client.get(f"/api/invoicing/orders/{no}/invoice.xml").text)
    assert float(root.findtext("cac:LegalMonetaryTotal/cbc:PayableAmount", namespaces=UBL)) == 0
    assert "bereits bezahlt" in client.get(f"/api/invoicing/orders/{no}/invoice.html").text


def test_payment_can_also_follow_the_invoice(client, make_order):
    no = make_order()
    assert post(client, no).status_code == 201
    r = client.post(f"/api/invoicing/orders/{no}/invoice/paid", json={"note": "Überweisung vom 30.10."})
    assert r.status_code == 200, r.text


def test_a_second_invoice_is_refused(client, make_order):
    no = make_order()
    assert post(client, no).status_code == 201
    assert post(client, no).status_code == 409


def test_numbers_stay_gap_free_and_unique_under_concurrency(make_order):
    nos = [make_order() for _ in range(12)]
    year, start = last_seq()
    barrier = threading.Barrier(len(nos))
    errors: list[Exception] = []

    def work(no: str) -> None:
        barrier.wait()
        try:
            with SessionLocal() as db:
                from gimel.routers import invoicing

                order = db.query(Order).filter(Order.no == no).one()
                lines, _ = invoicing._invoice_lines(order)
                data = invoicing._check_billing(order, lines, "", db)
                db.rollback()
                from datetime import date

                local_invoices.issue(db, no, data, delivery=date(2026, 10, 30), due_days=14, actor="test")
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(no,)) for no in nos]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    with SessionLocal() as db:
        seqs = sorted(s for (s,) in db.query(LocalInvoice.seq).filter(LocalInvoice.year == year, LocalInvoice.seq > start))
    assert seqs == list(range(start + 1, start + 13))


def test_two_requests_for_one_order_make_one_invoice(make_order):
    no = make_order()
    from datetime import date

    from gimel.routers import invoicing

    with SessionLocal() as db:
        order = db.query(Order).filter(Order.no == no).one()
        lines, _ = invoicing._invoice_lines(order)
        data = invoicing._check_billing(order, lines, "", db)
    year, start = last_seq()
    outcome: list[str] = []
    barrier = threading.Barrier(2)

    def work() -> None:
        barrier.wait()
        with SessionLocal() as db:
            try:
                local_invoices.issue(db, no, data, delivery=date(2026, 10, 30), due_days=14, actor="test")
                outcome.append("ok")
            except local_invoices.Refused:
                outcome.append("refused")

    threads = [threading.Thread(target=work) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(outcome) == ["ok", "refused"]
    assert last_seq() == (year, start + 1), "the refused one gave its number back"


def test_a_failure_after_the_number_was_taken_loses_no_number(client, make_order, monkeypatch):
    no = make_order()
    year, start = last_seq()
    with SessionLocal() as db:  # order numbers come back after a test deletes its order
        audited = db.query(AuditLog).filter_by(action="invoice_create", entity_id=no).count()

    def broken(*a, **k):
        raise ValueError("XML kaputt")

    with monkeypatch.context() as m:
        m.setattr(einvoice, "build", broken)
        r = post(client, no)
    assert r.status_code == 409 and "XML kaputt" in r.json()["detail"]
    assert last_seq() == (year, start)
    with SessionLocal() as db:
        assert db.query(Order).filter(Order.no == no).one().invoice_no == ""
        assert db.query(AuditLog).filter_by(action="invoice_create", entity_id=no).count() == audited
    assert post(client, no).json()["number"] == f"RE-{year}-{start + 1:04d}"


def test_an_issued_invoice_cannot_be_changed_or_deleted(client, make_order):
    number = post(client, make_order()).json()["number"]
    with SessionLocal() as db:
        row = db.query(LocalInvoice).filter_by(number=number).one()
        row.gross_cents = 1
        with pytest.raises(ValueError, match="unveränderlich"):
            db.commit()
        db.rollback()
    with SessionLocal() as db:
        db.delete(db.query(LocalInvoice).filter_by(number=number).one())
        with pytest.raises(ValueError, match="unveränderlich"):
            db.commit()
        db.rollback()
    with SessionLocal() as db:  # past the ORM too
        for sql in ("UPDATE local_invoices SET gross_cents = 1 WHERE number = :n",
                    "DELETE FROM local_invoices WHERE number = :n"):
            with pytest.raises(Exception, match="unveränderlich"):
                db.execute(text(sql), {"n": number})
            db.rollback()


def test_storno_has_its_own_number_refers_to_the_original_and_frees_the_order(client, make_order):
    no = make_order()
    original = post(client, no).json()["number"]
    r = client.post(f"/api/invoicing/orders/{no}/invoice/cancel", json={"reason": "Adresse falsch"})
    assert r.status_code == 200, r.text
    storno = r.json()["storno"]
    assert storno != original and r.json()["voided"] == original
    with SessionLocal() as db:
        assert db.query(Order).filter(Order.no == no).one().invoice_no == ""
        assert db.query(LocalInvoice).filter_by(number=original).one().kind == "invoice", "original stays"
        line = db.query(AuditLog).filter_by(action="invoice_cancel", entity_id=no).order_by(AuditLog.id.desc()).first()
        assert line.detail["storno"] == storno and line.detail["reason"] == "Adresse falsch"
    root = ET.fromstring(client.get(f"/api/invoicing/local/{storno}/invoice.xml").text)
    assert root.tag.endswith("}CreditNote")
    assert root.findtext("cbc:CreditNoteTypeCode", namespaces=UBL) == "381"
    assert root.findtext("cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID", namespaces=UBL) == original
    assert len(root.findall("cac:CreditNoteLine", UBL)) >= 1
    page = client.get(f"/api/invoicing/local/{storno}/invoice.html").text
    assert "Stornorechnung" in page and original in page and "-" in page

    rows = {r["number"]: r for r in client.get("/api/invoicing/local").json()}
    assert rows[original]["status"] == "storniert" and rows[original]["cancelled_by"] == storno
    assert rows[storno]["status"] == "storno" and rows[storno]["refers_to"] == original
    corrected = post(client, no).json()["number"]
    assert corrected not in (original, storno)
    assert client.post(f"/api/invoicing/orders/{no}/invoice/void").json()["voided"] == corrected


def test_a_foreign_rate_or_country_is_refused_not_guessed(client, make_order):
    abroad = {**ADDRESS, "country": "AT"}
    assert "Auslandsrechnung" in post(client, make_order(address=abroad)).json()["detail"]
    r = post(client, make_order(tax={"rate": 0.0, "type": "reverse_charge"}))
    assert r.status_code == 409 and "Steuersatz" in r.json()["detail"]


def test_a_missing_seller_or_delivery_date_refuses_and_takes_no_number(client, make_order, monkeypatch):
    no = make_order()
    year, start = last_seq()
    r = client.post(f"/api/invoicing/orders/{no}/invoice", json={})
    assert r.status_code == 409 and "Lieferdatum" in r.json()["detail"]
    with monkeypatch.context() as m:
        m.setattr(einvoice, "seller", lambda db=None: {"country": "DE"})
        r = post(client, no)
    assert r.status_code == 409 and "Verkäuferdaten fehlen" in r.json()["detail"]
    assert last_seq() == (year, start)


def test_a_plugin_that_forbids_it_keeps_the_503(client, make_order):
    no = make_order()
    use(Plugin(name="x", local_invoicing=False))
    try:
        assert post(client, no).status_code == 503
        assert "local_invoicing" not in client.get("/api/invoicing/config").json()
    finally:
        use(None)


def test_a_stripe_key_turns_local_invoices_off(client, make_order, monkeypatch):
    monkeypatch.setattr(stripe_client, "secret_key", lambda: "sk_test_x")
    assert local_invoices.enabled() is False
    assert client.get("/api/invoicing/config").json()["local_invoicing"] is False
