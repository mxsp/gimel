"""Auftragslebenslauf (Aufgabe 45): anhalten, fortsetzen, stornieren, ändern.

Jede Aktion ist ein ausdrücklicher Schritt mit Protokollzeile und ``rev``.
Der Sammellauf lässt angehaltene und stornierte Aufträge liegen; storniert
wird nur, solange nichts geplant, berechnet oder bezahlt ist.
"""

from __future__ import annotations

import uuid

import pytest

from gimel.db import SessionLocal
from gimel.models import AuditLog, Order, OrderPosition, Role, User
from gimel.security import create_access_token, hash_password
from gimel.services import batch_runner, order_flow

LINES = [{"id": 1, "mat": "epdm-70", "thk": 2, "label": "Ring", "od": 120, "di": 60, "q": 2}]
SHIP = {"company": "Lebenslauf GmbH", "street": "Weg 1", "zip": "06366", "city": "Köthen",
        "country": "DE"}


def _customer(client) -> int:
    r = client.post("/api/customers", json={
        "email": f"lauf-{uuid.uuid4().hex[:8]}@musterwerk.example", "company": "Lebenslauf GmbH"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _order(client, customer_id: int, **extra) -> dict:
    r = client.post("/api/desk/orders", json={
        "customer_id": customer_id, "lines": LINES, "ship_address": SHIP,
        "payment_mode": "account", **extra})
    assert r.status_code == 201, r.text
    return r.json()


def _head(role: Role) -> dict:
    email = f"{role.value}-{uuid.uuid4().hex[:6]}@example.test"
    with SessionLocal() as db:
        u = User(email=email, name=role.value, role=role,
                 password_hash=hash_password("maple-river-7429"))
        db.add(u)
        db.commit()
        token = create_access_token(u)
    return {"Authorization": f"Bearer {token}"}


def _pending_orders() -> set[str]:
    with SessionLocal() as db:
        return {p.order_no for p in batch_runner.collect_pending(db)}


def _actions(no: str) -> list[str]:
    with SessionLocal() as db:
        return [a.action for a in db.query(AuditLog)
                .filter(AuditLog.entity == "order", AuditLog.entity_id == no)
                .order_by(AuditLog.id).all()]


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
def order(client):
    cid = _customer(client)
    body = _order(client, cid)
    yield body
    with SessionLocal() as db:
        for o in db.query(Order).filter(Order.user_id == cid).all():
            db.delete(o)
        u = db.get(User, cid)
        if u is not None:
            db.delete(u)
        db.commit()


def test_hold_keeps_release_and_takes_the_order_out_of_the_run(client, order):
    no = order["no"]
    assert order["released"] is True and order["rev"] == 0
    assert no in _pending_orders()

    r = client.post(f"/api/desk/orders/{no}/hold", json={"reason": "Kunde klärt Maße", "rev": 0})
    assert r.status_code == 200, r.text
    held = r.json()
    assert held["held_at"] and held["hold_reason"] == "Kunde klärt Maße"
    assert held["released"] is True, "Anhalten fasst die Freigabe nicht an"
    assert held["rev"] == 1
    assert no not in _pending_orders()

    # Zweimal anhalten geht nicht; ohne Grund auch nicht.
    assert client.post(f"/api/desk/orders/{no}/hold", json={"reason": "noch mal"}).status_code == 409

    r = client.post(f"/api/desk/orders/{no}/resume", json={"rev": 1})
    assert r.status_code == 200, r.text
    assert r.json()["held_at"] is None and r.json()["hold_reason"] == "" and r.json()["rev"] == 2
    assert no in _pending_orders()
    assert client.post(f"/api/desk/orders/{no}/resume", json={}).status_code == 409
    assert _actions(no)[-2:] == ["order_hold", "order_resume"]


def test_hold_needs_a_reason(client, order):
    r = client.post(f"/api/desk/orders/{order['no']}/hold", json={"reason": "  "})
    assert r.status_code == 422
    assert "Grund" in r.json()["detail"]


def test_stale_rev_is_refused_and_changes_nothing(client, order):
    no = order["no"]
    assert client.post(f"/api/desk/orders/{no}/hold", json={"reason": "erste Hand", "rev": 0}).status_code == 200
    r = client.post(f"/api/desk/orders/{no}/cancel", json={"reason": "zweite Hand", "rev": 0})
    assert r.status_code == 409
    assert "inzwischen geändert" in r.json()["detail"]
    assert client.get(f"/api/desk/orders/{no}").json()["cancelled_at"] is None


def test_cancel_before_planning(client, order):
    no = order["no"]
    check = client.get(f"/api/desk/orders/{no}/cancel-check").json()
    assert check == {"can_cancel": True, "blockers": [], "rev": 0}

    r = client.post(f"/api/desk/orders/{no}/cancel", json={"reason": "Kunde hat abgesagt"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cancelled_at"] and body["cancel_reason"] == "Kunde hat abgesagt"
    assert body["released"] is False
    assert no not in _pending_orders()
    assert "order_cancel" in _actions(no)

    # Nichts gelöscht: der Auftrag und seine Positionen sind noch da.
    with SessionLocal() as db:
        o = db.query(Order).filter(Order.no == no).one()
        assert db.query(OrderPosition).filter(OrderPosition.order_id == o.id).count() == 1

    # Storniert bleibt storniert: kein zweites Mal, keine Freigabe, kein Anhalten, keine Änderung.
    assert client.post(f"/api/desk/orders/{no}/cancel", json={"reason": "noch mal"}).status_code == 409
    assert client.post(f"/api/desk/orders/{no}/release", json={}).status_code == 409
    assert client.post(f"/api/production/orders/{no}/release", json={"released": True}).status_code == 409
    assert client.post(f"/api/desk/orders/{no}/hold", json={"reason": "zu spät"}).status_code == 409
    assert client.patch(f"/api/desk/orders/{no}", json={"rush": True}).status_code == 409


def test_a_late_payment_never_releases_a_cancelled_order(client, order):
    no = order["no"]
    assert client.post(f"/api/desk/orders/{no}/cancel", json={"reason": "abgesagt"}).status_code == 200
    with SessionLocal() as db:
        o = db.query(Order).filter(Order.no == no).one()
        assert order_flow.mark_paid(db, o, actor="stripe") is True
        assert o.paid is True and o.released is False
        with pytest.raises(order_flow.FlowError):
            order_flow.set_released(db, o, True, actor="x")
        db.rollback()


def test_cancel_is_refused_once_planned_invoiced_or_paid(client, order):
    no = order["no"]
    with SessionLocal() as db:
        o = db.query(Order).filter(Order.no == no).one()
        pos = db.query(OrderPosition).filter(OrderPosition.order_id == o.id).one()
        pos.production_status = "batched"
        o.invoice_no = "RE-TEST-1"
        o.paid = True
        db.commit()
    check = client.get(f"/api/desk/orders/{no}/cancel-check").json()
    assert check["can_cancel"] is False
    text = " ".join(check["blockers"])
    assert "eingeplant" in text and "RE-TEST-1" in text and "bezahlt" in text
    r = client.post(f"/api/desk/orders/{no}/cancel", json={"reason": "geht nicht mehr"})
    assert r.status_code == 409
    assert "eingeplant" in r.json()["detail"]
    assert client.get(f"/api/desk/orders/{no}").json()["cancelled_at"] is None


def test_change_due_date_rush_reference_and_note(client, order):
    no = order["no"]
    r = client.patch(f"/api/desk/orders/{no}", json={
        "due_date": "2027-01-15T00:00:00Z", "rush": True, "customer_ref": " PO-77 ",
        "office_note": "Ruft am Montag zurück", "rev": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["due_date"].startswith("2027-01-15") and body["rush"] is True
    assert body["customer_ref"] == "PO-77" and body["office_note"] == "Ruft am Montag zurück"
    assert body["rev"] == 1

    # Dasselbe noch einmal: keine Änderung, kein rev, keine Protokollzeile.
    before = _actions(no)
    r = client.patch(f"/api/desk/orders/{no}", json={"rush": True, "customer_ref": "PO-77"})
    assert r.status_code == 200 and r.json()["rev"] == 1
    assert _actions(no) == before

    # Die Notiz steht nie im Protokoll, nur dass sie geändert wurde.
    with SessionLocal() as db:
        row = (db.query(AuditLog).filter(AuditLog.entity_id == no, AuditLog.action == "order_change")
               .order_by(AuditLog.id.desc()).first())
        assert row.detail["office_note"] == {"changed": True}
        assert "Montag" not in str(row.detail)
        assert row.detail["customer_ref"] == {"old": "", "new": "PO-77"}


def test_workers_and_customers_cannot_touch_the_lifecycle(client, order):
    no = order["no"]
    for role in (Role.worker, Role.customer):
        head = _head(role)
        for call in (
            lambda: client.post(f"/api/desk/orders/{no}/hold", json={"reason": "nein"}, headers=head),
            lambda: client.post(f"/api/desk/orders/{no}/cancel", json={"reason": "nein"}, headers=head),
            lambda: client.post(f"/api/desk/orders/{no}/resume", json={}, headers=head),
            lambda: client.patch(f"/api/desk/orders/{no}", json={"rush": True}, headers=head),
            lambda: client.get(f"/api/desk/orders/{no}/cancel-check", headers=head),
        ):
            assert call().status_code == 403
    assert client.get(f"/api/desk/orders/{no}").json()["rev"] == 0


def test_lists_and_office_tasks_know_the_new_states(client, order):
    no = order["no"]

    def row():
        items = client.get("/api/admin/orders", params={"q": no}).json()["items"]
        return next(o for o in items if o["no"] == no)

    assert row()["status"] == "freigegeben"
    client.post(f"/api/desk/orders/{no}/hold", json={"reason": "Rückfrage"})
    held = row()
    assert held["status"] == "angehalten" and held["hold_reason"] == "Rückfrage"
    client.post(f"/api/desk/orders/{no}/resume", json={})
    client.post(f"/api/desk/orders/{no}/cancel", json={"reason": "abgesagt"})
    gone = row()
    assert gone["status"] == "storniert" and gone["status_label"] == "Storniert"


# ---- Nach der Durchsicht (Technik, Sicherheit, Recht) ------------------------

def test_a_cancelled_order_is_neither_invoiced_nor_shipped(client, order):
    no = order["no"]
    assert client.post(f"/api/desk/orders/{no}/cancel", json={"reason": "abgesagt"}).status_code == 200
    r = client.post(f"/api/invoicing/orders/{no}/invoice", json={})
    assert r.status_code == 409 and "storniert" in r.json()["detail"]
    # Eine fertige Position (wie Plattenware ab Bestellung) macht ihn nicht versandfähig.
    with SessionLocal() as db:
        o = db.query(Order).filter(Order.no == no).one()
        db.query(OrderPosition).filter(OrderPosition.order_id == o.id).update({"production_status": "done"})
        db.commit()
        from gimel.services.shipping import order_ready_rows
        assert no not in {row["no"] for row in order_ready_rows(db)}
    r = client.post("/api/shipping/", json={"order_nos": [no]})
    assert r.status_code == 409 and "storniert" in r.json()["detail"]


def test_rev_is_a_real_compare_and_set(client, order):
    """Zwei Sitzungen lesen denselben Stand; die zweite verliert und schreibt nichts."""
    no = order["no"]
    with SessionLocal() as a, SessionLocal() as b:
        oa = a.query(Order).filter(Order.no == no).one()
        ob = b.query(Order).filter(Order.no == no).one()
        order_flow.hold(a, oa, actor="eins", reason="erste Hand")
        a.commit()
        with pytest.raises(order_flow.FlowError):
            order_flow.cancel(b, ob, actor="zwei", reason="zweite Hand")
        b.rollback()
    body = client.get(f"/api/desk/orders/{no}").json()
    assert body["rev"] == 1 and body["held_at"] and body["cancelled_at"] is None
    assert _actions(no).count("order_cancel") == 0


def test_office_note_on_the_order_is_sealed(client, order, sealed):
    from sqlalchemy import select, type_coerce
    from sqlalchemy.types import NullType

    from gimel import fieldcrypt as fc
    from gimel.db import Base

    no = order["no"]
    assert client.patch(f"/api/desk/orders/{no}", json={"office_note": "Rückruf Frau Beispiel"}).status_code == 200
    with SessionLocal() as db:
        t = Base.metadata.tables["orders"]
        raw = db.execute(select(type_coerce(t.c.office_note, NullType())).where(t.c.no == no)).scalar()
        assert fc.is_token(raw) and "Beispiel" not in raw
    # Keine versiegelte Zeile zurücklassen: nach dem Test gibt es den Schlüssel nicht mehr.
    assert client.patch(f"/api/desk/orders/{no}", json={"office_note": ""}).status_code == 200


def test_the_hall_sees_the_state_but_not_the_reason(client, order):
    no = order["no"]
    client.post(f"/api/desk/orders/{no}/hold", json={"reason": "Rechnung überfällig"})
    head = _head(Role.worker)
    detail = client.get(f"/api/admin/orders/{no}", headers=head).json()
    assert detail["held_at"] and detail["hold_reason"] == ""
    assert "überfällig" not in str(detail["audit"])
    row = next(o for o in client.get("/api/admin/orders", params={"q": no}, headers=head).json()["items"]
               if o["no"] == no)
    assert row["status"] == "angehalten" and row["hold_reason"] == ""
    assert client.get(f"/api/admin/orders/{no}").json()["hold_reason"] == "Rechnung überfällig"


def test_changing_only_the_note_leaves_the_due_date_alone(client, order):
    no = order["no"]
    before = client.get(f"/api/desk/orders/{no}").json()["due_date"]
    r = client.patch(f"/api/desk/orders/{no}", json={"office_note": "nur die Notiz", "rush": None})
    assert r.status_code == 200 and r.json()["due_date"] == before and r.json()["rush"] is False


def test_a_payment_that_lands_meanwhile_stops_the_cancel(client, order):
    """Sitzung B lädt den Auftrag, dann geht die Zahlung ein, dann storniert B:
    die Absage prüft gegen den neuen Stand, nicht gegen den geladenen."""
    no = order["no"]
    with SessionLocal() as b:
        ob = b.query(Order).filter(Order.no == no).one()
        assert ob.paid is False
        with SessionLocal() as a:
            oa = a.query(Order).filter(Order.no == no).one()
            assert order_flow.mark_paid(a, oa, actor="stripe") is True
            a.commit()
        with pytest.raises(order_flow.FlowError) as refused:
            order_flow.cancel(b, ob, actor="zwei", reason="zu spät")
        assert "bezahlt" in refused.value.detail
        b.rollback()
    body = client.get(f"/api/desk/orders/{no}").json()
    assert body["cancelled_at"] is None and body["paid"] is True


def test_the_hall_task_list_never_carries_the_hold_reason(client, order):
    from gimel.models import StationTask
    from gimel.services import worklist

    no = order["no"]
    client.post(f"/api/desk/orders/{no}/hold", json={"reason": "Rechnung überfällig"})
    with SessionLocal() as db:
        worklist.reconcile(db)
        db.commit()
        rows = db.query(StationTask).filter(StationTask.kind == "process", StationTask.ref == no).all()
        assert rows, "ein angehaltener Auftrag ist eine offene Büroaufgabe"
        assert all("überfällig" not in (t.note or "") for t in rows)
        assert any("angehalten" in (t.note or "") for t in rows)
