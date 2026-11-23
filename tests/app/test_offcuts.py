"""Reststücke: der Rest einer Platte spart beim nächsten Auftrag eine volle Platte.

Gehalten wird der ganze Kreis: ein verfügbares Reststück nimmt eine Platte auf,
der Bestand bleibt unberührt, die Kommissionierung nennt das Stück, ein Storno
gibt es frei, ein fertiger Auftrag verbraucht es — und jede geschnittene Platte
hinterlässt ihr Schnittband als neues Reststück.
"""

from __future__ import annotations

import uuid

import pytest

from gimel.db import SessionLocal
from gimel.models import (
    AuditLog, NestRun, Offcut, Order, OrderPosition, Product, StationTask, StockMovement, User,
    WorkItem, WorkOrder, WorkOrderStatus, WorkPlate,
)
from gimel.schemas import QuoteLine
from gimel.services import offcuts as oc
from gimel.services.batch_runner import run_batch
from gimel.services.orders import place_order
from gimel.services.work_orders import cancel_work_order


# ---------------------------------------------------------------- Geometrie
def test_leftover_is_the_band_behind_the_cut():
    pl = [{"cx": 60, "cy": 60, "od": 100}]
    assert oc.leftover([1000, 1000], 120, False, pl, 5) == (1000.0, 875.0)
    # gedreht: das Band wächst über die Breite
    assert oc.leftover([1000, 1000], 120, True, pl, 5) == (875.0, 1000.0)
    # Teile reichen weiter als das gemeldete Band: die Teile zählen
    assert oc.leftover([1000, 1000], 50, False, pl, 5) == (1000.0, 885.0)
    assert oc.leftover([1000, 1000], 998, False, pl, 5) is None


def test_big_enough_and_orientation():
    assert oc.big_enough((1000, 150), 150, 0.05)
    assert not oc.big_enough((1000, 140), 150, 0.05)
    assert not oc.big_enough((200, 200), 150, 0.05)
    assert oc.orient((300, 200), 400, 250) == (400, 250)
    assert oc.orient((200, 300), 400, 250) == (250, 400)
    assert oc.orient((500, 100), 400, 250) is None


def test_choose_takes_the_smallest_fitting_offcut():
    class P:  # schlanker Ersatz für BatchPlate
        def __init__(self, idx, placements):
            self.idx, self.placements = idx, placements

    big = Offcut(id=1, w=1000, h=800)
    small = Offcut(id=2, w=300, h=200)
    plates = [P(0, [{"cx": 500, "cy": 500, "od": 900}]),   # volle Platte
              P(1, [{"cx": 60, "cy": 60, "od": 100}])]      # fast leer
    got = oc.choose(plates, [big, small], margin=10)
    assert 0 not in got
    assert got[1][0] is small


# ---------------------------------------------------------- ganzer Kreislauf
_MADE: list[str] = []


@pytest.fixture(autouse=True)
def _cleanup():
    """Die Testaufträge wieder entfernen — andere Tests zählen Aufträge."""
    yield
    with SessionLocal() as db:
        for mat in _MADE:
            wos = db.query(WorkOrder).filter(WorkOrder.mat == mat).all()
            ids = [w.id for w in wos]
            runs = {w.run_id for w in wos}
            if ids:
                db.query(WorkItem).filter(WorkItem.work_order_id.in_(ids)).delete(synchronize_session=False)
                db.query(WorkPlate).filter(WorkPlate.work_order_id.in_(ids)).delete(synchronize_session=False)
                db.query(StationTask).filter(StationTask.ref.in_([w.no for w in wos])).delete(synchronize_session=False)
                db.query(AuditLog).filter(AuditLog.entity_id.in_([w.no for w in wos])).delete(synchronize_session=False)
                db.query(WorkOrder).filter(WorkOrder.id.in_(ids)).delete(synchronize_session=False)
            for run in db.query(NestRun).filter(NestRun.id.in_(runs)).all():
                if not db.query(WorkOrder).filter(WorkOrder.run_id == run.id).count():
                    db.delete(run)
            order_ids = {p.order_id for p in db.query(OrderPosition).filter(OrderPosition.mat == mat).all()}
            for oid in order_ids:
                order = db.get(Order, oid)
                db.query(StationTask).filter(StationTask.ref == order.no).delete(synchronize_session=False)
                db.query(OrderPosition).filter(OrderPosition.order_id == oid).delete(synchronize_session=False)
                db.delete(order)
            db.query(Offcut).filter(Offcut.product_id == mat).delete(synchronize_session=False)
            db.query(StockMovement).filter(StockMovement.product_id == mat).delete(synchronize_session=False)
            db.query(Product).filter(Product.id == mat).delete(synchronize_session=False)
        db.commit()
    _MADE.clear()


def _setup():
    suffix = uuid.uuid4().hex[:8]
    with SessionLocal() as db:
        prod = Product(id=f"rest-{suffix}", name="Reststoff", cat="gasket", eur_m2=10.0,
                       sheets=[[1000, 1000]], thicknesses=[2.0], stock=10, active=True)
        db.add(prod)
        db.commit()
        _MADE.append(prod.id)
        customer = db.query(User).filter(User.email == "einkauf1@musterwerk.example").one()
        addr = {"company": "Test GmbH", "street": "Weg 1", "zip": "99999",
                "city": "Ort", "country": "DE"}
        line = QuoteLine(id=1, mat=prod.id, thk=2, label="Ring", od=100, di=50, q=1)
        place_order(db=db, lines=[line], cert="", ship_address=addr, bill_address=addr,
                    tax_status={"rate": 0.19}, customer_ref=f"R-{suffix}", user=customer,
                    released=True)
        off = Offcut(code=f"RT-{suffix}", product_id=prod.id, thk=2.0, w=400, h=300,
                     status="available")
        db.add(off)
        db.commit()
        return prod.id, off.id


def _run(db, mat):
    run_batch(db, trigger="manual", force=True, only={(mat, 2.0)})
    return (db.query(WorkOrder).filter(WorkOrder.mat == mat,
                                       WorkOrder.status == WorkOrderStatus.open).one())


def test_batch_puts_a_small_plate_on_an_offcut_and_keeps_stock(client):
    mat, off_id = _setup()
    with SessionLocal() as db:
        wo = _run(db, mat)
        plate = db.query(WorkPlate).filter(WorkPlate.work_order_id == wo.id).one()
        off = db.get(Offcut, off_id)
        assert plate.offcut_id == off_id
        assert sorted(plate.fmt) == [300, 400]
        assert off.status == "reserved" and off.work_order_no == wo.no
        assert db.get(Product, mat).stock == 10          # keine volle Platte gezogen
        # das Schnittband des Reststücks ist selbst wieder eines (geplant)
        child = db.query(Offcut).filter(Offcut.source_work_order_no == wo.no).all()
        assert len(child) == 1 and child[0].status == "pending"
        wo_no = wo.no

    staging = client.get("/api/factory/staging").json()
    row = next(r for r in staging["rows"] if r["no"] == wo_no)
    assert row["n_full_plates"] == 0
    assert [o["id"] for o in row["offcuts"]] == [off_id]

    # Storno: Reststück wieder frei, geplantes Kind verworfen, Bestand unverändert
    with SessionLocal() as db:
        wo = db.query(WorkOrder).filter(WorkOrder.no == wo_no).one()
        res = cancel_work_order(db, wo, actor="tester", reason="Test")
        db.commit()
        assert res["stock_returned"] == 0 and res["offcuts_freed"] == 1
        assert db.get(Offcut, off_id).status == "available"
        assert db.query(Offcut).filter(Offcut.source_work_order_no == wo_no).count() == 0
        assert db.get(Product, mat).stock == 10

    # Neu planen und fertig melden: verbraucht, Kind liegt im Lager
    with SessionLocal() as db:
        wo = _run(db, mat)
        wo.status = WorkOrderStatus.done
        db.commit()
        oc.refresh(db)
        db.commit()
        assert db.get(Offcut, off_id).status == "used"
        kids = db.query(Offcut).filter(Offcut.source_work_order_no == wo.no).all()
        assert [k.status for k in kids] == ["available"]

    listing = client.get("/api/inventory/offcuts", params={"mat": mat}).json()
    assert listing["totals"]["used"] >= 1
    assert any(o["status"] == "available" for o in listing["offcuts"])
    stock = next(r for r in client.get("/api/inventory").json() if r["id"] == mat)
    assert stock["offcuts"] == 1


def test_without_offcut_a_full_plate_is_drawn_and_leftover_recorded(client):
    mat, off_id = _setup()
    with SessionLocal() as db:
        db.get(Offcut, off_id).status = "scrapped"
        db.commit()
        wo = _run(db, mat)
        plate = db.query(WorkPlate).filter(WorkPlate.work_order_id == wo.id).one()
        assert plate.offcut_id is None and plate.fmt == [1000, 1000]
        assert db.get(Product, mat).stock == 9
        kid = db.query(Offcut).filter(Offcut.source_work_order_no == wo.no).one()
        assert kid.w == 1000 and kid.h > 700
        cancel_work_order(db, wo, actor="tester")
        db.commit()
        assert db.get(Product, mat).stock == 10


def test_offcut_api_create_patch_and_rules(client):
    with SessionLocal() as db:
        mat = db.query(Product).first().id
    r = client.post("/api/inventory/offcuts",
                    json={"mat": mat, "thk": 3, "w": 600, "h": 250, "bin": "Kiste 1"})
    assert r.status_code == 200, r.text
    o = r.json()
    assert o["status"] == "available" and o["code"].startswith("R-")
    r = client.patch(f"/api/inventory/offcuts/{o['id']}", json={"status": "scrapped"})
    assert r.status_code == 200 and r.json()["status"] == "scrapped"
    r = client.patch(f"/api/inventory/offcuts/{o['id']}", json={"status": "available", "bin": "B"})
    assert r.status_code == 200 and r.json()["bin"] == "B"
    assert client.post("/api/inventory/offcuts",
                       json={"mat": "nix", "thk": 3, "w": 1, "h": 1}).status_code == 404
    assert client.get("/api/inventory/offcuts", params={"status": "kaputt"}).status_code == 422


def test_timeline_ends_at_current_stock(client):
    with SessionLocal() as db:
        mat = db.query(Product).filter(Product.active.is_(True)).first().id
    client.post(f"/api/inventory/{mat}/adjust", json={"delta": 3, "reason": "einkauf", "note": "t"})
    t = client.get(f"/api/inventory/{mat}/timeline", params={"days": 30}).json()
    assert len(t["points"]) == 30
    assert t["points"][-1]["balance"] == t["stock"]
    assert t["points"][-1]["in"] >= 3
    assert client.get("/api/inventory/gibt-es-nicht/timeline").status_code == 404
