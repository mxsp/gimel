"""The two plate routes on one path: POST ticks a plate, PATCH finishes the work order."""

from __future__ import annotations

from gimel.db import SessionLocal
from gimel.models import WorkOrder, WorkOrderStatus


def _reset(no: str) -> None:
    with SessionLocal() as db:
        wo = db.query(WorkOrder).filter(WorkOrder.no == no).one()
        wo.status, wo.done_at, wo.done_by, wo.order_done = WorkOrderStatus.open, None, "", {}
        for p in wo.plates:
            p.status = WorkOrderStatus.open
        db.commit()


def _work_order(client) -> tuple[str, int]:
    with SessionLocal() as db:
        wo = db.query(WorkOrder).filter(WorkOrder.status == WorkOrderStatus.open).first()
        return wo.no, len(wo.plates)


def test_ticking_every_plate_with_post_leaves_the_work_order_open(client):
    no, n = _work_order(client)
    try:
        for idx in range(n):
            r = client.post(f"/api/production/work-orders/{no}/plates/{idx}/status",
                            json={"done": True})
            assert r.status_code == 200, r.text
        assert r.json()["n_done"] == n
        with SessionLocal() as db:
            assert db.query(WorkOrder).filter(WorkOrder.no == no).one().status == WorkOrderStatus.open
    finally:
        _reset(no)


def test_the_last_plate_with_patch_finishes_the_work_order(client):
    no, n = _work_order(client)
    try:
        for idx in range(n):
            r = client.patch(f"/api/production/work-orders/{no}/plates/{idx}/status",
                             json={"status": "done"})
            assert r.status_code == 200, r.text
        assert r.json()["all_plates_done"] is True
        assert r.json()["status"] == "done"
    finally:
        _reset(no)
