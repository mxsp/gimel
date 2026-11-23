"""Regressionen für die erste Betriebsstufe (2026-11).

Jeder Test hält eine Naht fest, an der die Fertigung vorher zwei Wahrheiten
hatte: eine geschlossene Packaufgabe, die wieder aufging; ein bezahlter Auftrag,
der nicht freigegeben wurde; ein stornierter Innenauftrag, der den Bestand nicht
zurückgab; ein Versand mit falscher Adresse oder doppelten Positionen.
"""

from __future__ import annotations

import threading
import uuid

from gimel.db import SessionLocal
from gimel.models import (
    AuditLog,
    NestRun,
    Order,
    OrderPosition,
    Product,
    Shipment,
    ShipmentItem,
    StationTask,
    StockMovement,
    User,
    WorkItem,
    WorkOrder,
    WorkOrderStatus,
    WorkPlate,
)
from gimel.schemas import QuoteLine
from gimel.services import run_lock, worklist
from gimel.services.inventory import move_stock
from gimel.services.orders import place_order
from gimel.services.work_orders import cancel_work_order


def _suffix() -> str:
    return uuid.uuid4().hex[:10]


def _order(db, *, released: bool = False, address: dict | None = None) -> Order:
    customer = db.query(User).filter(User.email == "einkauf1@musterwerk.example").one()
    addr = address or {
        "company": "Test GmbH", "street": "Weg 1", "zip": "99999",
        "city": "Ort", "country": "DE",
    }
    line = QuoteLine(id=1, mat="epdm-70", thk=2, label="Ring", od=100, di=50, q=1)
    kwargs = dict(
        db=db, lines=[line], cert="", ship_address=addr, bill_address=addr,
        tax_status={"rate": 0.19}, customer_ref=f"T-{_suffix()}", user=customer,
    )
    if released:
        kwargs["released"] = True
    return place_order(**kwargs)


def _drop_order(db, order: Order) -> None:
    db.query(StationTask).filter(StationTask.ref == order.no).delete(
        synchronize_session=False
    )
    db.query(OrderPosition).filter(OrderPosition.order_id == order.id).delete(
        synchronize_session=False
    )
    db.query(Order).filter(Order.id == order.id).delete(synchronize_session=False)


def test_a_finished_pack_task_stays_finished_until_its_source_changes(client):
    with SessionLocal() as db:
        order = _order(db)
        db.commit()
        order_no = order.no
        db.query(OrderPosition).filter(OrderPosition.order_id == order.id).update(
            {OrderPosition.production_status: "done"}, synchronize_session=False
        )
        db.commit()

        worklist.reconcile(db)
        task = (
            db.query(StationTask)
            .filter(StationTask.kind == "pack", StationTask.ref == order_no)
            .one()
        )
        worklist.set_state(db, task, "done", who="tester")
        assert task.closed_at is not None

        # Der Abgleich darf die Fertigmeldung nicht zurücknehmen.
        worklist.reconcile(db)
        db.refresh(task)
        assert task.state == "done" and task.closed_at is not None

        # Erst wenn wirklich neue Arbeit entsteht (eine weitere fertige
        # Position), wird die Aufgabe wieder offen.
        db.add(
            OrderPosition(
                order_id=order.id, kind="gasket", mat="epdm-70", thk=2,
                qty=1, production_status="done",
            )
        )
        db.commit()
        worklist.reconcile(db)
        db.refresh(task)
        assert task.state in ("ready", "running") and task.closed_at is None

        _drop_order(db, order)
        db.commit()


def test_manual_invoice_payment_releases_and_unmarking_withdraws(client):
    with SessionLocal() as db:
        order = _order(db, released=False)
        db.commit()
        order_no = order.no

    r = client.post(
        f"/api/invoicing/orders/{order_no}/invoice/paid",
        json={"note": "Überweisung vom 30.10.2026"},
    )
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        fresh = db.query(Order).filter(Order.no == order_no).one()
        assert fresh.paid is True and fresh.released is True
        assert fresh.release_note == "Freigegeben: Rechnung bezahlt"

    r = client.post(
        f"/api/admin/orders/{order_no}/paid",
        json={"paid": False, "note": "Zahlung zurückgebucht"},
    )
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        fresh = db.query(Order).filter(Order.no == order_no).one()
        assert fresh.paid is False and fresh.released is False
        _drop_order(db, fresh)
        db.commit()


def test_cancelling_a_work_order_returns_stock_and_removes_its_tags():
    suffix = _suffix()
    with SessionLocal() as db:
        product = Product(
            id=f"test-ops-{suffix}", name="Testwerkstoff", cat="gasket",
            eur_m2=10.0, sheets=[[1000, 1000]], thicknesses=[2.0], stock=10,
        )
        run = NestRun(no=f"SL-TEST-{suffix}", trigger="manual")
        db.add_all([product, run])
        db.flush()
        wo = WorkOrder(
            no=f"IA-TEST-{suffix}", run_id=run.id, mat=product.id, thk=2.0,
            fmt=[1000, 1000], n_plates=2, n_parts=1,
        )
        db.add(wo)
        db.flush()
        plate = WorkPlate(work_order_id=wo.id, idx=0, fmt=[1000, 1000])
        db.add(plate)
        db.flush()
        db.add(
            WorkItem(
                plate_id=plate.id, work_order_id=wo.id, order_no=f"AB-{suffix}",
                tag="T1", label="Ring",
            )
        )
        db.commit()

        result = cancel_work_order(db, wo, actor="tester", reason="Test")
        db.commit()
        assert result["stock_returned"] == 2
        assert db.get(Product, product.id).stock == 12
        assert db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).count() == 0
        assert wo.status == WorkOrderStatus.cancelled

        again = cancel_work_order(db, wo, actor="tester", reason="Test")
        db.commit()
        assert again["already_cancelled"] is True
        assert db.get(Product, product.id).stock == 12

        db.query(StockMovement).filter(StockMovement.product_id == product.id).delete(
            synchronize_session=False
        )
        db.query(AuditLog).filter(AuditLog.entity_id == wo.no).delete(
            synchronize_session=False
        )
        db.delete(wo)
        db.delete(run)
        db.delete(product)
        db.commit()


def test_shipping_refuses_mixed_addresses_and_duplicate_orders(client):
    suffix = _suffix()
    with SessionLocal() as db:
        first = _order(db, released=True, address={
            "company": "A", "street": "A-Weg 1", "zip": "11111",
            "city": "A-Stadt", "country": "DE",
        })
        second = _order(db, released=True, address={
            "company": "B", "street": "B-Weg 2", "zip": "22222",
            "city": "B-Stadt", "country": "DE",
        })
        for order in (first, second):
            db.query(OrderPosition).filter(OrderPosition.order_id == order.id).update(
                {OrderPosition.production_status: "done"}, synchronize_session=False
            )
        db.commit()
        first_no, second_no = first.no, second.no

    mixed = client.post("/api/shipping/", json={"order_nos": [first_no, second_no]})
    assert mixed.status_code == 409
    assert "Lieferanschriften" in mixed.json()["detail"]

    created = client.post("/api/shipping/", json={"order_nos": [first_no, first_no]})
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["n_items"] == 1, "dieselbe Position darf nicht zweimal im Versand landen"

    no = body["no"]
    assert client.patch(f"/api/shipping/{no}", json={"status": "shipped"}).status_code == 200
    assert client.patch(f"/api/shipping/{no}", json={"status": "packing"}).status_code == 409

    # 0 ist ein echter Preis und darf nicht durch die Vorgabe ersetzt werden.
    with SessionLocal() as db:
        third = _order(db, released=True)
        db.query(OrderPosition).filter(OrderPosition.order_id == third.id).update(
            {OrderPosition.production_status: "done"}, synchronize_session=False
        )
        db.commit()
        third_no = third.no
    zero = client.post(
        "/api/shipping/", json={"order_nos": [third_no], "price": 0}
    )
    assert zero.status_code == 200, zero.text
    assert zero.json()["price"] == 0.0

    with SessionLocal() as db:
        shipment_ids = [
            s.id for s in db.query(Shipment).filter(
                Shipment.no.in_([no, zero.json()["no"]])
            )
        ]
        db.query(ShipmentItem).filter(
            ShipmentItem.shipment_id.in_(shipment_ids)
        ).delete(synchronize_session=False)
        db.query(Shipment).filter(Shipment.id.in_(shipment_ids)).delete(
            synchronize_session=False
        )
        for order in db.query(Order).filter(Order.no.in_([first_no, second_no, third_no])):
            _drop_order(db, order)
        db.commit()


def test_the_run_lock_is_visible_to_a_second_session():
    key = f"test-lock-{_suffix()}"
    with run_lock.hold(key):
        errors: list[Exception] = []

        def try_take() -> None:
            try:
                with run_lock.hold(key):
                    pass
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        thread = threading.Thread(target=try_take)
        thread.start()
        thread.join()
        assert len(errors) == 1 and isinstance(errors[0], run_lock.Busy)


def test_stock_moves_do_not_lose_a_concurrent_update():
    suffix = _suffix()
    with SessionLocal() as db:
        product = Product(
            id=f"test-stock-{suffix}", name="Test", cat="gasket", eur_m2=1.0,
            sheets=[[1000, 1000]], thicknesses=[2.0], stock=0,
        )
        db.add(product)
        db.commit()
        product_id = product.id

    errors: list[Exception] = []

    def add_one() -> None:
        try:
            with SessionLocal() as db:
                row = db.get(Product, product_id)
                move_stock(db, row, 1, reason="test")
                db.commit()
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=add_one) for _ in range(10)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    with SessionLocal() as db:
        assert db.get(Product, product_id).stock == 10
        db.query(StockMovement).filter(StockMovement.product_id == product_id).delete(
            synchronize_session=False
        )
        db.delete(db.get(Product, product_id))
        db.commit()
