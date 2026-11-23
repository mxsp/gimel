"""Kundenstand (Aufgabe 45): Auftragssperre, Büronotiz, offener Betrag gegen
den Kreditrahmen, Dublettenhinweis. Stornierte Aufträge zählen nirgends."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select, type_coerce
from sqlalchemy.types import NullType

from gimel import fieldcrypt as fc
from gimel.config import get_settings
from gimel.db import Base, SessionLocal
from gimel.models import AuditLog, Order, Role, User
from gimel.security import create_access_token
from gimel.services import batch_runner, erasure
from gimel.services.orders import place_order
from gimel.schemas import QuoteLine

LINES = [{"id": 1, "mat": "epdm-70", "thk": 2, "label": "Ring", "od": 120, "di": 60, "q": 2}]
SHIP = {"company": "Stand GmbH", "street": "Weg 1", "zip": "06366", "city": "Köthen", "country": "DE"}
K1 = "k1:" + "A" * 43


def _new(client, **extra) -> dict:
    body = {"email": f"stand-{uuid.uuid4().hex[:8]}@musterwerk.example", "company": "Stand GmbH"}
    body.update(extra)
    r = client.post("/api/customers", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _order(client, cid: int, **extra):
    return client.post("/api/desk/orders", json={
        "customer_id": cid, "lines": LINES, "ship_address": SHIP, "payment_mode": "account", **extra})


@pytest.fixture
def sealed(monkeypatch):
    """Feldverschlüsselung für einen Test einschalten — und die dabei
    versiegelten Protokollzeilen wieder entfernen: nach dem Test gibt es den
    Schlüssel nicht mehr, und eine unlesbare Zeile bräche spätere Tests."""
    from sqlalchemy import func, select

    from gimel.config import get_settings

    with SessionLocal() as db:
        before = db.scalar(select(func.max(AuditLog.id))) or 0
    monkeypatch.setattr(get_settings(), "data_keys", "k1:" + "A" * 43)
    yield
    with SessionLocal() as db:
        db.query(AuditLog).filter(AuditLog.id > before).delete(synchronize_session=False)
        db.commit()


@pytest.fixture
def customer(client):
    made: list[int] = []

    def make(**extra) -> dict:
        c = _new(client, **extra)
        made.append(c["id"])
        return c

    yield make
    with SessionLocal() as db:
        for cid in made:
            for o in db.query(Order).filter(Order.user_id == cid).all():
                db.delete(o)
            u = db.get(User, cid)
            if u is not None:
                db.delete(u)
        db.commit()


def test_standing_counts_open_amount_and_ignores_cancelled(client, customer):
    c = customer(credit_limit=1000.0)
    assert c["n_orders"] == 0 and c["credit_free"] == 1000.0 and c["credit_pct"] == 0.0
    first = _order(client, c["id"]).json()
    second = _order(client, c["id"]).json()
    now = client.get(f"/api/customers/{c['id']}").json()
    assert now["n_orders"] == 2 and now["n_open"] == 2 and now["n_cancelled"] == 0
    assert now["open_gross"] == pytest.approx(first["gross"] + second["gross"], abs=0.01)
    assert now["credit_used"] == now["open_gross"]
    assert now["credit_free"] == pytest.approx(1000.0 - now["open_gross"], abs=0.01)
    assert now["last_order_at"]

    assert client.post(f"/api/desk/orders/{second['no']}/cancel", json={"reason": "abgesagt"}).status_code == 200
    after = client.get(f"/api/customers/{c['id']}").json()
    assert after["n_orders"] == 1 and after["n_open"] == 1 and after["n_cancelled"] == 1
    assert after["open_gross"] == pytest.approx(first["gross"], abs=0.01)
    assert after["total_net"] == pytest.approx(first["net"], abs=0.01)

    # Die Liste rechnet dasselbe wie die Karte.
    row = next(r for r in client.get("/api/customers", params={"q": c["email"]}).json() if r["id"] == c["id"])
    assert {k: row[k] for k in ("n_orders", "n_open", "open_gross", "credit_free")} == \
           {k: after[k] for k in ("n_orders", "n_open", "open_gross", "credit_free")}


def test_no_credit_limit_means_unknown_not_zero(client, customer):
    c = customer()
    assert c["credit_limit"] == 0 and c["credit_free"] is None and c["credit_pct"] is None


def test_a_cancelled_order_frees_the_credit_limit(client, customer):
    c = customer(credit_limit=1.0)            # kleiner als jeder Auftrag
    first = _order(client, c["id"]).json()
    assert first["released"] is False and "Kreditrahmen" in first["release_note"]
    client.post(f"/api/desk/orders/{first['no']}/cancel", json={"reason": "abgesagt"})
    client.patch(f"/api/customers/{c['id']}", json={"credit_limit": first["gross"] + 1})
    second = _order(client, c["id"]).json()
    assert second["released"] is True, "der stornierte Auftrag belastet den Rahmen nicht mehr"


def test_block_needs_a_reason_and_stops_new_desk_orders(client, customer):
    c = customer()
    r = client.patch(f"/api/customers/{c['id']}", json={"order_block": True})
    assert r.status_code == 422 and "Grund" in r.json()["detail"]

    r = client.patch(f"/api/customers/{c['id']}", json={
        "order_block": True, "order_block_reason": "Zwei Rechnungen überfällig"})
    assert r.status_code == 200, r.text
    assert r.json()["order_block"] is True

    refused = _order(client, c["id"])
    assert refused.status_code == 409
    assert "Auftragssperre" in refused.json()["detail"] and "überfällig" in refused.json()["detail"]

    # Übergehen: ausdrücklich, nur Admin, mit Protokollzeile; der Auftrag läuft dann normal.
    with SessionLocal() as db:
        staff = User(email=f"buero-{uuid.uuid4().hex[:6]}@example.test", name="Büro",
                     role=Role.staff, password_hash="x")
        db.add(staff)
        db.commit()
        head = {"Authorization": f"Bearer {create_access_token(staff)}"}
    as_staff = client.post("/api/desk/orders", headers=head, json={
        "customer_id": c["id"], "lines": LINES, "ship_address": SHIP,
        "payment_mode": "account", "override_block": True})
    assert as_staff.status_code == 403
    ok = _order(client, c["id"], override_block=True)
    assert ok.status_code == 201, ok.text
    assert ok.json()["held_at"] is None
    with SessionLocal() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "customer_block_override",
                                         AuditLog.entity_id == str(c["id"])).count() == 1
        assert db.query(AuditLog).filter(AuditLog.action == "customer_block",
                                         AuditLog.entity_id == str(c["id"])).count() == 1

    # Der Weg über „neuer Kunde" mit bekannter E-Mail führt nicht an der Sperre vorbei.
    by_mail = client.post("/api/desk/orders", headers=head, json={
        "new_customer": {"email": c["email"], "company": "Stand GmbH"}, "lines": LINES,
        "ship_address": SHIP, "payment_mode": "account"})
    assert by_mail.status_code == 409 and "Auftragssperre" in by_mail.json()["detail"]
    # Ein gesperrter Kunde behält seinen Grund: leeren geht nicht.
    assert client.patch(f"/api/customers/{c['id']}", json={"order_block_reason": " "}).status_code == 422

    # Aufheben nimmt den Grund mit.
    r = client.patch(f"/api/customers/{c['id']}", json={"order_block": False})
    assert r.json()["order_block"] is False and r.json()["order_block_reason"] == ""
    assert _order(client, c["id"]).status_code == 201


def test_a_portal_order_of_a_blocked_customer_arrives_on_hold(client, customer):
    c = customer()
    client.patch(f"/api/customers/{c['id']}", json={"order_block": True, "order_block_reason": "Mahnstufe 2"})
    with SessionLocal() as db:
        user = db.get(User, c["id"])
        order = place_order(db, lines=[QuoteLine(**LINES[0])], cert="2.2", ship_address=SHIP,
                            bill_address=SHIP, tax_status={"rate": 0.19, "type": "domestic"},
                            user=user, released=True, paid=True)
        no = order.no
        # Angehalten, aber ohne den Grund der Sperre: der bleibt in der Kundenkarte.
        assert order.held_at is not None and order.hold_reason == "Auftragssperre des Kunden"
        # Bezahlt und freigegeben — und trotzdem nicht im Sammellauf.
        assert no not in {p.order_no for p in batch_runner.collect_pending(db)}
    assert client.post(f"/api/desk/orders/{no}/resume", json={}).status_code == 200
    with SessionLocal() as db:
        assert no in {p.order_no for p in batch_runner.collect_pending(db)}


def test_office_note_is_sealed_never_logged_and_erased(client, customer, sealed):
    c = customer()
    r = client.patch(f"/api/customers/{c['id']}", json={"office_note": "Zahlt nur nach Anruf bei Frau Beispiel"})
    assert r.status_code == 200 and r.json()["office_note"].startswith("Zahlt nur")
    with SessionLocal() as db:
        t = Base.metadata.tables["users"]
        raw = db.execute(select(type_coerce(t.c.office_note, NullType())).where(t.c.id == c["id"])).scalar()
        assert fc.is_token(raw) and "Beispiel" not in raw
        row = (db.query(AuditLog).filter(AuditLog.action == "desk_customer_update",
                                         AuditLog.entity_id == str(c["id"])).order_by(AuditLog.id.desc()).first())
        assert row.detail == {"office_note": {"changed": True}}
        user = db.get(User, c["id"])
        user.order_block, user.order_block_reason = True, "Grund"
        # Freitext an den Aufträgen der Person geht mit, der Auftrag bleibt.
        o = place_order(db, lines=[QuoteLine(**LINES[0])], cert="2.2", ship_address=SHIP, bill_address=SHIP,
                        tax_status={"rate": 0.19, "type": "domestic"}, user=user, commit=False)
        o.office_note, o.hold_reason = "ruft Frau Beispiel an", "wartet auf Frau Beispiel"
        db.add(AuditLog(actor="x", action="order_hold", entity="order", entity_id=o.no,
                        detail={"reason": "wartet auf Frau Beispiel"}))
        db.flush()
        erasure.erase_user(db, user)
        assert user.office_note == "" and user.order_block is False and user.order_block_reason == ""
        assert o.office_note == "" and o.hold_reason == ""
        held = db.query(AuditLog).filter(AuditLog.entity_id == o.no, AuditLog.action == "order_hold").all()
        assert held and all(r.detail == {"erased": True} for r in held)
        db.rollback()
    # Keine versiegelte Zeile zurücklassen: nach dem Test gibt es den Schlüssel nicht mehr.
    assert client.patch(f"/api/customers/{c['id']}", json={"office_note": ""}).status_code == 200


def test_unchanged_patch_writes_no_audit_line(client, customer):
    c = customer()

    def n():
        with SessionLocal() as db:
            return db.query(AuditLog).filter(AuditLog.entity == "user",
                                             AuditLog.entity_id == str(c["id"])).count()
    before = n()
    assert client.patch(f"/api/customers/{c['id']}", json={"company": "Stand GmbH"}).status_code == 200
    assert n() == before


def test_duplicates_are_a_hint_by_mail_vat_company_and_domain(client, customer):
    tag = uuid.uuid4().hex[:6]
    a = customer(email=f"einkauf@dichtwerk-{tag}.example", company=f"Dichtwerk {tag} GmbH & Co. KG",
                 vat_id="DE 123 456 789")

    def find(**params):
        return client.get("/api/customers/duplicates", params=params).json()

    assert find() == []
    assert [h["why"] for h in find(email=f"EINKAUF@dichtwerk-{tag}.example")] == [["email"]]
    assert find(vat_id="de123456789")[0]["why"] == ["vat_id"]
    assert find(company=f"dichtwerk {tag}")[0]["why"] == ["company"]        # Rechtsform zählt nicht
    assert find(email=f"vertrieb@dichtwerk-{tag}.example")[0]["why"] == ["domain"]
    assert find(email=f"vertrieb@dichtwerk-{tag}.example", exclude_id=a["id"]) == []
    # Ein Sammelpostfach sagt nichts über die Firma.
    b = customer(email=f"firma-{tag}@gmx.de", company=f"Andere {tag}")
    assert all(h["id"] != b["id"] for h in find(email=f"wer-anders-{tag}@gmx.de"))


def test_customer_routes_stay_closed_for_workers(client, customer):
    c = customer()
    with SessionLocal() as db:
        w = User(email=f"halle-{uuid.uuid4().hex[:6]}@example.test", name="Halle",
                 role=Role.worker, password_hash="x")
        db.add(w)
        db.commit()
        head = {"Authorization": f"Bearer {create_access_token(w)}"}
    assert client.get("/api/customers/duplicates", params={"company": "Stand"}, headers=head).status_code == 403
    assert client.patch(f"/api/customers/{c['id']}", json={"order_block": True, "order_block_reason": "nein"},
                        headers=head).status_code == 403


def test_erased_customers_are_gone_from_list_and_duplicates(client, customer):
    tag = uuid.uuid4().hex[:6]
    c = customer(email=f"weg@loesch-{tag}.example", company=f"Löschwerk {tag}")
    assert client.delete(f"/api/customers/{c['id']}").status_code == 204
    assert all(r["id"] != c["id"] for r in client.get("/api/customers").json())
    assert client.get("/api/customers/duplicates", params={"company": f"Löschwerk {tag}"}).json() == []


def test_desk_orders_refuse_staff_accounts_and_erased_customers(client, customer):
    with SessionLocal() as db:
        staff = User(email=f"meister-{uuid.uuid4().hex[:6]}@musterwerk.example", name="Meister",
                     role=Role.staff, password_hash="x")
        db.add(staff)
        db.commit()
        staff_email = staff.email
    r = client.post("/api/desk/orders", json={
        "new_customer": {"email": staff_email}, "lines": LINES, "ship_address": SHIP,
        "payment_mode": "account"})
    assert r.status_code == 409 and "Personalkonto" in r.json()["detail"]

    c = customer()
    assert client.delete(f"/api/customers/{c['id']}").status_code == 204
    r = _order(client, c["id"])
    assert r.status_code == 409 and "gelöscht" in r.json()["detail"]
