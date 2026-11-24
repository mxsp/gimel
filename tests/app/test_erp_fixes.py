"""Gezielte Regressionstests für die 12 geprüften ERP-Backend-Fixes."""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import func, inspect, select
from sqlalchemy.exc import IntegrityError

from gimel import demo, seed
from gimel.db import SessionLocal, engine
from gimel.models import (
    Address,
    AuditLog,
    LocalInvoice,
    NestRun,
    Offcut,
    Order,
    OrderPosition,
    Product,
    Role,
    Shipment,
    ShipmentItem,
    ShipmentStatus,
    StationTask,
    StockMovement,
    User,
    WorkItem,
    WorkOrder,
    WorkOrderStatus,
    WorkPlate,
)
from gimel.schemas import QuoteLine
from gimel.services import batch_runner, csv_io, local_invoices, plate_edit, run_lock, stripe_client, worklist
from gimel.services.orders import place_order
from gimel.services.work_orders import cancel_work_order

_CLEANUP_MATS: list[str] = []
_CLEANUP_ORDERS: list[str] = []
_CLEANUP_SHIPMENTS: list[int] = []
_CLEANUP_ADDRESSES: list[int] = []
_CLEANUP_USERS: list[str] = []


@pytest.fixture(autouse=True)
def _cleanup_erp_fixes(plant):
    with SessionLocal() as db:
        before_audit_id = db.scalar(select(func.max(AuditLog.id))) or 0
    yield
    try:
        with SessionLocal() as db:
            for sid in _CLEANUP_SHIPMENTS:
                s = db.get(Shipment, sid)
                if s is not None:
                    db.delete(s)
            for aid in _CLEANUP_ADDRESSES:
                a = db.get(Address, aid)
                if a is not None:
                    db.delete(a)
            for ono in _CLEANUP_ORDERS:
                o = db.query(Order).filter(Order.no == ono).first()
                if o is not None:
                    db.query(StationTask).filter(StationTask.ref == ono).delete(synchronize_session=False)
                    db.query(AuditLog).filter(AuditLog.entity_id == ono).delete(synchronize_session=False)
                    db.delete(o)
            for mat in _CLEANUP_MATS:
                wos = db.query(WorkOrder).filter(WorkOrder.mat == mat).all()
                wo_ids = [w.id for w in wos]
                runs = {w.run_id for w in wos}
                if wo_ids:
                    db.query(WorkItem).filter(WorkItem.work_order_id.in_(wo_ids)).delete(synchronize_session=False)
                    db.query(WorkPlate).filter(WorkPlate.work_order_id.in_(wo_ids)).delete(synchronize_session=False)
                    db.query(StationTask).filter(StationTask.ref.in_([w.no for w in wos])).delete(synchronize_session=False)
                    db.query(AuditLog).filter(AuditLog.entity_id.in_([w.no for w in wos])).delete(synchronize_session=False)
                    db.query(WorkOrder).filter(WorkOrder.id.in_(wo_ids)).delete(synchronize_session=False)
                for run in db.query(NestRun).filter(NestRun.id.in_(runs)).all():
                    if not db.query(WorkOrder).filter(WorkOrder.run_id == run.id).count():
                        db.delete(run)
                db.query(Offcut).filter(Offcut.product_id == mat).delete(synchronize_session=False)
                db.query(StockMovement).filter(StockMovement.product_id == mat).delete(synchronize_session=False)
                db.query(Product).filter(Product.id == mat).delete(synchronize_session=False)
            for email in _CLEANUP_USERS:
                u = db.query(User).filter(User.email == email).first()
                if u is not None:
                    for o in db.query(Order).filter(Order.user_id == u.id).all():
                        db.delete(o)
                    db.delete(u)
            db.query(AuditLog).filter(AuditLog.id > before_audit_id).delete(synchronize_session=False)
            db.commit()
    finally:
        _CLEANUP_MATS.clear()
        _CLEANUP_ORDERS.clear()
        _CLEANUP_SHIPMENTS.clear()
        _CLEANUP_ADDRESSES.clear()
        _CLEANUP_USERS.clear()


def _addr() -> dict:
    return {
        "company": "Test Kunde GmbH",
        "street": "Testweg 1",
        "zip": "12345",
        "city": "Teststadt",
        "country": "DE",
    }


def _make_product_and_order(
    *,
    stock: int = 10,
    released: bool = True,
    blocked: bool = False,
    qty: int = 1,
    od: float = 100.0,
    di: float = 50.0,
):
    suffix = uuid.uuid4().hex[:8]
    mat = f"erpfix-{suffix}"
    with SessionLocal() as db:
        prod = Product(
            id=mat,
            name=f"ERP-Fix-{suffix}",
            cat="gasket",
            eur_m2=12.0,
            sheets=[[1000, 1000]],
            thicknesses=[2.0],
            stock=stock,
            active=True,
        )
        db.add(prod)
        db.commit()
        customer = db.query(User).filter(User.email == "einkauf1@musterwerk.example").one()
        order = place_order(
            db=db,
            lines=[QuoteLine(id=1, mat=mat, thk=2.0, label="Ring", od=od, di=di, q=qty)],
            cert="",
            ship_address=_addr(),
            bill_address=_addr(),
            tax_status={"rate": 0.19},
            customer_ref=f"FIX-{suffix}",
            user=customer,
            released=released,
        )
        if blocked:
            order.blocked = True
            order.released = False
            db.commit()
        _CLEANUP_MATS.append(mat)
        _CLEANUP_ORDERS.append(order.no)
        return mat, order.no, order.id, order.positions[0].id


# ---------------------------------------------------------------------------
# 1. batch_runner: BOM, TOCTOU-Prüfung unter Schreibsperre, renest-Sperre
# ---------------------------------------------------------------------------
def test_batch_runner_has_no_utf8_bom():
    raw = Path(batch_runner.__file__).read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")


def test_batch_runner_skips_order_cancelled_during_plan_batch(client, monkeypatch):
    mat, order_no, _oid, pos_id = _make_product_and_order(stock=10, released=True)
    orig_plan_batch = batch_runner.plan_batch

    def cancel_mid_plan(*args, **kwargs):
        res = orig_plan_batch(*args, **kwargs)
        with SessionLocal() as other:
            o = other.query(Order).filter(Order.no == order_no).one()
            o.cancelled_at = datetime.now(timezone.utc)
            other.commit()
        return res

    monkeypatch.setattr(batch_runner, "plan_batch", cancel_mid_plan)
    with SessionLocal() as db:
        run = batch_runner.run_batch(db, trigger="manual", actor="tester", force=True, only={(mat, 2.0)})
        assert "geändert" in (run.note or "")
        assert run.n_work_orders == 0
        pos = db.get(OrderPosition, pos_id)
        assert pos.production_status == "pending"
        assert db.get(Product, mat).stock == 10
        assert db.query(WorkOrder).filter(WorkOrder.mat == mat).count() == 0


def test_renest_acquires_run_lock_before_cancelling(client, monkeypatch):
    mat, _order_no, _oid, _pos_id = _make_product_and_order(stock=10, released=True)
    with SessionLocal() as db:
        batch_runner.run_batch(db, trigger="manual", actor="tester", force=True, only={(mat, 2.0)})
        wo_no = db.query(WorkOrder).filter(WorkOrder.mat == mat).one().no

    from contextlib import contextmanager

    @contextmanager
    def busy_lock(*_a, **_kw):
        raise run_lock.Busy("Ein anderer Lauf hält die Sperre.")
        yield

    monkeypatch.setattr(run_lock, "hold", busy_lock)
    r = client.post("/api/production/renest", json={"work_order_nos": [wo_no]})
    assert r.status_code == 409
    with SessionLocal() as db:
        wo = db.query(WorkOrder).filter(WorkOrder.no == wo_no).one()
        assert wo.status == WorkOrderStatus.open


# ---------------------------------------------------------------------------
# 2. work_orders.cancel_work_order: atomare CAS-Sperre
# ---------------------------------------------------------------------------
def test_cancel_work_order_atomic_cas_blocks_double_stock_return(client):
    mat, _order_no, _oid, _pos_id = _make_product_and_order(stock=10, released=True)
    with SessionLocal() as db:
        batch_runner.run_batch(db, trigger="manual", actor="tester", force=True, only={(mat, 2.0)})
        wo = db.query(WorkOrder).filter(WorkOrder.mat == mat).one()
        wo_no = wo.no
        assert db.get(Product, mat).stock == 9

    with SessionLocal() as s1, SessionLocal() as s2:
        wo1 = s1.query(WorkOrder).filter(WorkOrder.no == wo_no).one()
        wo2 = s2.query(WorkOrder).filter(WorkOrder.no == wo_no).one()
        # Beide Sitzungen sehen open vorab; erste storniert und committet
        res1 = cancel_work_order(s1, wo1, actor="t1", commit=True)
        assert res1["already_cancelled"] is False
        assert res1["stock_returned"] == 1
        # Zweite Sitzung mit veraltetem ORM-Stand darf NICHT ein zweites Mal gutschreiben
        res2 = cancel_work_order(s2, wo2, actor="t2", commit=True)
        assert res2["already_cancelled"] is True
        assert res2["stock_returned"] == 0

    with SessionLocal() as db:
        assert db.get(Product, mat).stock == 10


# ---------------------------------------------------------------------------
# 3. plate_edit.save_layout: Reststück freigeben & Bestand nur für volle Platten
# ---------------------------------------------------------------------------
def test_plate_edit_save_layout_releases_offcut_and_counts_non_offcut_delta(client):
    mat, _order_no, _oid, _pos_id = _make_product_and_order(stock=10, released=True)
    with SessionLocal() as db:
        off = Offcut(
            code=f"RO-{uuid.uuid4().hex[:6]}",
            product_id=mat,
            thk=2.0,
            w=400.0,
            h=300.0,
            status="available",
        )
        db.add(off)
        db.commit()
        off_id = off.id
        batch_runner.run_batch(db, trigger="manual", actor="tester", force=True, only={(mat, 2.0)})
        wo = db.query(WorkOrder).filter(WorkOrder.mat == mat).one()
        plate = db.query(WorkPlate).filter(WorkPlate.work_order_id == wo.id).one()
        assert plate.offcut_id == off_id
        assert db.get(Product, mat).stock == 10

        # Reststückplatte im Schachteleditor auf volles Format [1000, 1000] vergrößern
        ver = plate_edit.version_of(wo)
        new_plates = [
            {
                "fmt": [1000, 1000],
                "turned": bool(plate.turned),
                "placements": [
                    {
                        "tag": i["tag"],
                        "cx": i["cx"],
                        "cy": i["cy"],
                        "rot": i.get("rot") or 0,
                    }
                    for i in plate.placements
                ],
            }
        ]
        plate_edit.save_layout(db, wo, new_plates, ver, "tester")
        db.expire_all()
        assert db.get(Offcut, off_id).status == "available"
        assert db.get(Offcut, off_id).work_order_no == ""
        assert db.query(WorkPlate).filter(WorkPlate.work_order_id == wo.id).one().offcut_id is None
        assert db.get(Product, mat).stock == 9


# ---------------------------------------------------------------------------
# 4. production & worklist: Storno-Sperre und Positionen beim Wiederöffnen
# ---------------------------------------------------------------------------
def test_cancelled_work_order_cannot_be_resurrected_and_reopen_resets_positions(client):
    mat, order_no, _oid, pos_id = _make_product_and_order(stock=10, released=True)
    with SessionLocal() as db:
        batch_runner.run_batch(db, trigger="manual", actor="tester", force=True, only={(mat, 2.0)})
        wo_no = db.query(WorkOrder).filter(WorkOrder.mat == mat).one().no

    # Platte fertig -> WO done -> Position done; danach wieder öffnen -> Position batched
    r_done = client.patch(
        f"/api/production/work-orders/{wo_no}/plates/0/status",
        json={"status": "done"},
    )
    assert r_done.status_code == 200, r_done.text
    with SessionLocal() as db:
        assert db.get(OrderPosition, pos_id).production_status == "done"

    r_reopen = client.patch(
        f"/api/production/work-orders/{wo_no}/plates/0/status",
        json={"status": "open"},
    )
    assert r_reopen.status_code == 200, r_reopen.text
    with SessionLocal() as db:
        assert db.get(WorkOrder, db.query(WorkOrder).filter(WorkOrder.no == wo_no).one().id).status == WorkOrderStatus.open
        assert db.get(OrderPosition, pos_id).production_status == "batched"

    # Einzelne Platte darf nicht auf cancelled gesetzt werden
    assert (
        client.patch(
            f"/api/production/work-orders/{wo_no}/plates/0/status",
            json={"status": "cancelled"},
        ).status_code
        == 409
    )

    # Arbeitsvorrat-Task anlegen, dann WO stornieren
    with SessionLocal() as db:
        worklist.reconcile(db, who="tester")
        wo = db.query(WorkOrder).filter(WorkOrder.no == wo_no).one()
        cancel_work_order(db, wo, actor="tester", commit=True)
        cut_task = (
            db.query(StationTask)
            .filter(StationTask.kind == "cut", StationTask.ref == wo_no)
            .first()
        )
        if cut_task is not None:
            with pytest.raises(ValueError, match="storniert"):
                worklist.set_state(db, cut_task, "running", who="tester")

    assert (
        client.post(
            f"/api/production/work-orders/{wo_no}/status",
            json={"status": "open"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/production/work-orders/{wo_no}/plates/0/status",
            json={"done": True},
        ).status_code
        == 409
    )
    assert (
        client.patch(
            f"/api/production/work-orders/{wo_no}/plates/0/status",
            json={"status": "open"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/production/work-orders/{wo_no}/orders/{order_no}/done",
            json={"done": True},
        ).status_code
        == 409
    )


# ---------------------------------------------------------------------------
# 5. admin: Rollback-Prüfungen, rev, multi-order Shipment, stats
# ---------------------------------------------------------------------------
def test_admin_order_rollback_guards_stock_shipments_rev_and_stats(client, monkeypatch):
    mat, ono1, oid1, pid1 = _make_product_and_order(stock=10, released=True)
    with SessionLocal() as db:
        batch_runner.run_batch(db, trigger="manual", actor="tester", force=True, only={(mat, 2.0)})
        wo_no = db.query(WorkOrder).filter(WorkOrder.mat == mat).one().no
        assert db.get(Product, mat).stock == 9
        rev_before = db.get(Order, oid1).rev

    # Rollback planned leert WO über cancel_work_order (Bestand zurück) und erhöht rev
    r_rb = client.post(f"/api/admin/orders/{ono1}/rollback", json={"step": "planned"})
    assert r_rb.status_code == 200, r_rb.text
    with SessionLocal() as db:
        assert db.get(Product, mat).stock == 10
        assert db.query(WorkOrder).filter(WorkOrder.no == wo_no).one().status == WorkOrderStatus.cancelled
        assert db.get(Order, oid1).rev == rev_before + 1
        assert db.get(OrderPosition, pid1).production_status == "pending"

    # Stornierter Auftrag darf weder über rollback noch rollback_legacy zurückgerollt werden
    with SessionLocal() as db:
        o = db.get(Order, oid1)
        o.cancelled_at = datetime.now(timezone.utc)
        o.paid = True
        db.commit()
    assert client.post(f"/api/admin/orders/{ono1}/rollback", json={}).status_code == 409
    assert client.post(f"/api/admin/orders/{ono1}/rollback_legacy", json={}).status_code == 409

    # Sammel-Sendung (2 Aufträge): erst shipped -> packing über HTTP, dann
    # partielles Entfernen von ShipmentItems im packing-Zustand ohne Verlust der Sendung
    _m2, ono2, oid2, pid2 = _make_product_and_order(stock=10, released=True)
    _m3, ono3, oid3, pid3 = _make_product_and_order(stock=10, released=True)
    with SessionLocal() as db:
        for pid in (pid2, pid3):
            db.get(OrderPosition, pid).production_status = "done"
        ship = Shipment(
            no=f"SHP-FIX-{uuid.uuid4().hex[:6]}",
            status=ShipmentStatus.shipped,
            shipped_at=datetime.now(timezone.utc),
            packed_by="tester",
            shipped_by="tester",
        )
        db.add(ship)
        db.flush()
        db.add(ShipmentItem(shipment_id=ship.id, order_id=oid2, order_no=ono2, position_id=pid2, qty=1))
        db.add(ShipmentItem(shipment_id=ship.id, order_id=oid3, order_no=ono3, position_id=pid3, qty=1))
        db.commit()
        ship_id = ship.id
        _CLEANUP_SHIPMENTS.append(ship_id)

    r_reopen_ship = client.post(f"/api/admin/orders/{ono2}/rollback", json={"step": "shipped"})
    assert r_reopen_ship.status_code == 200, r_reopen_ship.text
    with SessionLocal() as db:
        assert db.get(Shipment, ship_id).status == ShipmentStatus.packing

    from gimel.routers import admin as admin_router

    with SessionLocal() as db:
        actor = db.query(User).filter(User.email == demo.ADMIN_EMAIL).one()
        admin_router._rollback_one(db, db.get(Order, oid2), actor, "shipped")
        db.commit()
        assert db.get(Shipment, ship_id) is not None
        items = db.query(ShipmentItem).filter(ShipmentItem.shipment_id == ship_id).all()
        assert [i.order_id for i in items] == [oid3]

        admin_router._rollback_one(db, db.get(Order, oid3), actor, "shipped")
        db.commit()
        assert db.get(Shipment, ship_id) is None

    # Fehler in _rollback_one leakt keine rohe Exception-Meldung
    from gimel.routers import admin as admin_router

    def boom(*_a, **_kw):
        raise RuntimeError("GEHEIMER-DB-PFAD-/tmp/secret.db")

    _m4, ono4, _oid4, _pid4 = _make_product_and_order(stock=5, released=True)
    monkeypatch.setattr(admin_router, "_rollback_one", boom)
    r_err = client.post(f"/api/admin/orders/{ono4}/rollback", json={"step": "released"})
    assert r_err.status_code == 500
    assert "GEHEIMER-DB-PFAD" not in r_err.json()["detail"]

    r_stats = client.get("/api/admin/stats")
    assert r_stats.status_code == 200
    assert "unverified_prices" in r_stats.json()


# ---------------------------------------------------------------------------
# 6. customers.add_address: keep_id nach flush()
# ---------------------------------------------------------------------------
def test_add_address_clears_flags_on_others_with_valid_keep_id(client):
    with SessionLocal() as db:
        cust = db.query(User).filter(User.role == Role.customer).first()
        cid = cust.id
    r1 = client.post(
        f"/api/customers/{cid}/addresses",
        json={**_addr(), "label": "Alt", "is_billing": True, "is_delivery": True},
    )
    assert r1.status_code == 201, r1.text
    a1 = r1.json()["id"]

    r2 = client.post(
        f"/api/customers/{cid}/addresses",
        json={**_addr(), "label": "Neu", "is_billing": True, "is_delivery": True},
    )
    assert r2.status_code == 201, r2.text
    a2 = r2.json()["id"]
    _CLEANUP_ADDRESSES.extend([a1, a2])
    assert r2.json()["is_billing"] is True and r2.json()["is_delivery"] is True

    with SessionLocal() as db:
        old = db.get(Address, a1)
        new = db.get(Address, a2)
        assert old.is_billing is False and old.is_delivery is False
        assert new.is_billing is True and new.is_delivery is True


# ---------------------------------------------------------------------------
# 7. seed: ix_local_invoices_kind_issued auf issue_date DESC
# ---------------------------------------------------------------------------
def test_local_invoices_index_uses_issue_date():
    entry = dict((name, expr) for name, _tbl, expr in seed.INDEXES)
    assert entry["ix_local_invoices_kind_issued"] == "kind, issue_date DESC"
    seed.ensure_indexes()
    names = {idx["name"] for idx in inspect(engine).get_indexes("local_invoices")}
    assert "ix_local_invoices_kind_issued" in names


# ---------------------------------------------------------------------------
# 8. IntegrityError -> HTTP 409 bei Konto-/Kundenerstellung
# ---------------------------------------------------------------------------
def test_integrity_error_returns_409_on_user_customer_creation(client, monkeypatch):
    # Doppelte customer_no bei customers.create_customer (umgeht E-Mail-Precheck nicht, aber Race auf flush)
    from sqlalchemy.orm import Session as SASession

    orig_flush = SASession.flush

    def fake_flush_conflict(self, *a, **kw):
        for obj in self.new:
            if isinstance(obj, User):
                raise IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed: users.email"))
        return orig_flush(self, *a, **kw)

    monkeypatch.setattr(SASession, "flush", fake_flush_conflict)

    r_cust = client.post(
        "/api/customers",
        json={
            "email": f"race-{uuid.uuid4().hex[:6]}@example.com",
            "name": "Race",
            "company": "Race GmbH",
        },
    )
    assert r_cust.status_code == 409

    r_usr = client.post(
        "/api/users",
        json={
            "email": f"race-u-{uuid.uuid4().hex[:6]}@example.com",
            "name": "Race",
            "password": "Strong-Password-123!",
            "role": "customer",
        },
    )
    assert r_usr.status_code == 409

    r_acc = client.post(
        "/api/accounts",
        json={
            "username": f"race_{uuid.uuid4().hex[:6]}",
            "password": "Strong-Password-123!",
            "role": "staff",
        },
    )
    assert r_acc.status_code == 409

    r_reg = client.post(
        "/api/auth/register",
        json={
            "email": f"race-r-{uuid.uuid4().hex[:6]}@example.com",
            "password": "Strong-Password-123!",
            "name": "Race",
            "company": "Race GmbH",
        },
    )
    assert r_reg.status_code == 409

    r_desk = client.post(
        "/api/desk/orders",
        json={
            "new_customer": {
                "email": f"race-d-{uuid.uuid4().hex[:6]}@example.com",
                "name": "Race",
                "company": "Race GmbH",
            },
            "lines": [{"id": 1, "mat": "epdm-70", "thk": 2, "label": "R", "od": 100, "di": 50, "q": 1}],
            "ship_address": _addr(),
        },
    )
    assert r_desk.status_code == 409


# ---------------------------------------------------------------------------
# 9. invoicing & local_invoices: Webhook-Mismatch 200, bezahltes Storno, Links
# ---------------------------------------------------------------------------
def test_invoicing_webhook_mismatch_paid_cancel_and_links(client, monkeypatch):
    # Webhook mismatch -> 200 + AuditLog (statt 409)
    _m, ono, oid, _pid = _make_product_and_order(stock=5, released=False)
    inv_id = f"in_test_{uuid.uuid4().hex[:8]}"
    with SessionLocal() as db:
        o = db.get(Order, oid)
        o.invoice_no = inv_id
        o.paid = False
        db.commit()

    monkeypatch.setattr(stripe_client, "webhook_secret", lambda: "whsec_test")
    import stripe

    monkeypatch.setattr(
        stripe.Webhook,
        "construct_event",
        lambda payload, sig, sec: {
            "type": "invoice.paid",
            "data": {"object": {"id": inv_id, "amount_paid": 1, "currency": "eur"}},
        },
    )
    r_wh = client.post("/api/invoicing/stripe/webhook", content=b"{}", headers={"stripe-signature": "sig"})
    assert r_wh.status_code == 200
    with SessionLocal() as db:
        assert db.get(Order, oid).paid is False
        assert (
            db.query(AuditLog)
            .filter(AuditLog.action == "invoice_paid_mismatch", AuditLog.entity_id == ono)
            .first()
            is not None
        )

    # Lokale Rechnung: bezahlte Rechnung darf weder über /void noch /cancel storniert werden
    monkeypatch.setattr(stripe_client, "secret_key", lambda: "")
    _m2, ono2, oid2, _pid2 = _make_product_and_order(stock=5, released=True)
    r_inv = client.post(
        f"/api/invoicing/orders/{ono2}/invoice",
        json={"delivery_date": "2026-11-20", "due_days": 14},
    )
    assert r_inv.status_code == 201, r_inv.text
    inv_no = r_inv.json()["number"]

    assert (
        client.post(
            f"/api/invoicing/orders/{ono2}/invoice/paid",
            json={"note": "Überweisung eingegangen"},
        ).status_code
        == 200
    )
    assert client.post(f"/api/invoicing/orders/{ono2}/invoice/void").status_code == 409
    assert (
        client.post(
            f"/api/invoicing/orders/{ono2}/invoice/cancel",
            json={"reason": "Test Storno"},
        ).status_code
        == 409
    )
    with SessionLocal() as db:
        with pytest.raises(local_invoices.Refused):
            local_invoices.cancel(db, ono2, inv_no, "Test", actor="tester")

    # invoice_links ohne data["buyer"] wirft keinen KeyError 500
    with SessionLocal() as db:
        li = db.query(LocalInvoice).filter(LocalInvoice.number == inv_no).one()
        # Direkt per SQL prüfen nicht nötig — Mock über local_invoices.current
        fake_row = SimpleNamespace(number=inv_no, gross_cents=li.gross_cents, data={})
        monkeypatch.setattr(local_invoices, "current", lambda _db, _o: fake_row)
        r_links = client.get(f"/api/invoicing/orders/{ono2}/invoice/links")
        assert r_links.status_code == 200
        assert r_links.json()["recipient"] == ""

    # local_invoices.issue prüft cancelled_at / blocked nach _fresh_order()
    _m3, ono3, oid3, _pid3 = _make_product_and_order(stock=5, released=True)
    with SessionLocal() as db:
        o3 = db.get(Order, oid3)
        o3.cancelled_at = datetime.now(timezone.utc)
        db.commit()
        with pytest.raises(local_invoices.Refused, match="storniert"):
            local_invoices.issue(
                db,
                ono3,
                {
                    "seller": {"name": "Musterwerk", "country": "DE", "vatId": "DE123"},
                    "buyer": {"name": "Kunde", "country": "DE"},
                    "lines": [],
                    "net": 100,
                    "vat": 19,
                    "gross": 119,
                    "vat_rate": 0.19,
                },
                delivery=date(2026, 11, 20),
                due_days=14,
                actor="tester",
            )


# ---------------------------------------------------------------------------
# 10. inventory GET: kein unbedingtes db.commit()
# ---------------------------------------------------------------------------
def test_inventory_get_only_commits_when_offcuts_change(client, monkeypatch):
    from gimel.services import offcuts as offcut_svc

    monkeypatch.setattr(offcut_svc, "refresh", lambda _db: 0)
    commits = 0
    orig_commit = SessionLocal.class_ if hasattr(SessionLocal, "class_") else None
    from sqlalchemy.orm import Session as SASession

    real_commit = SASession.commit

    def counted_commit(self):
        nonlocal commits
        commits += 1
        return real_commit(self)

    monkeypatch.setattr(SASession, "commit", counted_commit)
    assert client.get("/api/inventory").status_code == 200
    assert client.get("/api/inventory/offcuts").status_code == 200
    assert commits == 0


# ---------------------------------------------------------------------------
# 11. accounts: Selbst-Sperre/Löschung & customer <-> worker Verbot
# ---------------------------------------------------------------------------
def test_accounts_self_lockout_deletion_and_customer_worker_guards(client):
    me = client.get("/api/auth/me").json()
    my_id = me["id"]

    assert client.patch(f"/api/accounts/{my_id}", json={"active": False}).status_code == 409
    assert client.patch(f"/api/accounts/{my_id}", json={"role": "staff"}).status_code == 409
    assert client.delete(f"/api/accounts/{my_id}").status_code == 409

    with SessionLocal() as db:
        cust = db.query(User).filter(User.role == Role.customer).first()
        cid = cust.id
    r_cw = client.patch(f"/api/accounts/{cid}", json={"role": "worker"})
    assert r_cw.status_code == 409


# ---------------------------------------------------------------------------
# 12. csv_io.commit_import: hash_password vor Schreibtransaktion
# ---------------------------------------------------------------------------
def test_csv_commit_import_precomputes_hash_before_db_writes(plant, monkeypatch):
    events: list[str] = []
    orig_hash = csv_io.hash_password

    def tracked_hash(pw: str) -> str:
        events.append("hash")
        return orig_hash(pw)

    monkeypatch.setattr(csv_io, "hash_password", tracked_hash)

    with SessionLocal() as db:
        orig_flush = db.flush

        def tracked_flush(*a, **kw):
            events.append("flush")
            return orig_flush(*a, **kw)

        monkeypatch.setattr(db, "flush", tracked_flush)
        email = f"csv-prehash-{uuid.uuid4().hex[:6]}@example.com"
        _CLEANUP_USERS.append(email)
        csv_text = (
            "email;firma;bestellzeichen;werkstoff;dicke;bezeichnung;od;di;menge;strasse;plz;ort;land\n"
            f"{email};CSV GmbH;C-1;epdm-70;2;Ring;100;50;2;Weg 1;12345;Ort;DE\n"
        )
        plan = csv_io.plan_import(db, csv_text.encode("utf-8"))
        assert not plan.errors
        created = csv_io.commit_import(db, plan, actor="tester", filename="test.csv")
        _CLEANUP_ORDERS.extend(created)
        assert len(created) == 1
        assert events[0] == "hash"
        assert "flush" in events
        assert events.index("hash") < events.index("flush")
