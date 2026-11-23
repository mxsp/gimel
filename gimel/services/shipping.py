"""Die Warteschlange für den Versand: was geschnitten, aber noch nicht verschickt ist.

Liest der Versand (``routers/shipping.py``), die Fertigungssicht
(``routers/factory.py``) und die Arbeitslisten (``services/worklist.py``).
"""

from __future__ import annotations

from sqlalchemy import exists, or_
from sqlalchemy.orm import Session, defer

from ..db import chunked_in
from ..models import Order, OrderPosition, ShipmentItem, WorkItem, WorkOrder


def order_ready_rows(db: Session, *, limit: int | None = None) -> list[dict]:
    """Alle Aufträge mit mindestens einer geschnittenen, aber noch nicht
    verschickten Position — die Warteschlange für den Versand.

    Bewusst ohne Filter auf ``paid``: die Freigabe — nicht der Zahlungseingang —
    entscheidet, ob ein Auftrag in die Fertigung geht (Rechnungsbestellung,
    collect_pending). Ein geschnittener Auftrag, der hier verschwiegen wird,
    verschwindet zwischen Fertigung und Versand; bezahlt wird beim Senden
    ohnehin nicht geprüft.

    Filtert bereits verschickte Positionen direkt per NOT EXISTS in SQL und
    lädt alle zugehörigen Positionen, Sendungs- und Innenauftragsdaten im Block
    (O(1) Abfragen statt O(N) über alle historischen Aufträge).
    """
    unshipped_done = exists().where(
        OrderPosition.order_id == Order.id,
        OrderPosition.production_status == "done",
        ~exists().where(ShipmentItem.position_id == OrderPosition.id),
    )
    q = (
        db.query(Order)
        .options(defer(Order.bill_address), defer(Order.office_note))
        .filter(unshipped_done)
        # Interne Aufträge bleiben im Haus: kein Kunde, keine Lieferanschrift.
        .filter(or_(Order.kind.is_(None), Order.kind != "internal"))
        # Storniert wird nicht versendet — Plattenware steht ab Bestellung auf
        # „done" und läge sonst trotz Storno in der Versandliste (Aufgabe 45).
        .filter(Order.cancelled_at.is_(None))
        .order_by(Order.created_at.desc())
    )
    if limit is not None:
        q = q.limit(limit)
    rows = q.all()
    if not rows:
        return []

    order_ids = [o.id for o in rows]
    positions = (
        db.query(OrderPosition)
        .options(
            defer(OrderPosition.shape),
            defer(OrderPosition.note),
            defer(OrderPosition.external_note),
        )
        .filter(chunked_in(OrderPosition.order_id, order_ids))
        .all()
    )
    pos_by_order: dict[int, list[OrderPosition]] = {}
    all_pos_ids: list[int] = []
    for p in positions:
        pos_by_order.setdefault(p.order_id, []).append(p)
        all_pos_ids.append(p.id)

    shipped_pos_ids: set[int] = (
        {
            pid
            for (pid,) in db.query(ShipmentItem.position_id)
            .filter(chunked_in(ShipmentItem.position_id, all_pos_ids))
            .distinct()
            .all()
        }
        if all_pos_ids
        else set()
    )

    ready_pos_ids = [
        p.id
        for p in positions
        if p.production_status == "done" and p.id not in shipped_pos_ids
    ]
    tag_by_pos: dict[int, str] = {}
    wo_no_by_pos: dict[int, str] = {}
    if ready_pos_ids:
        wi_rows = (
            db.query(WorkItem.position_id, WorkItem.tag, WorkOrder.no)
            .join(WorkOrder, WorkOrder.id == WorkItem.work_order_id)
            .filter(chunked_in(WorkItem.position_id, ready_pos_ids))
            .all()
        )
        for pid, tag, wo_no in wi_rows:
            if pid not in tag_by_pos:
                tag_by_pos[pid] = tag or ""
                wo_no_by_pos[pid] = wo_no or ""

    result = []
    for order in rows:
        o_positions = pos_by_order.get(order.id, [])
        done = [p for p in o_positions if p.production_status == "done"]
        shipped = [
            p
            for p in o_positions
            if p.production_status in ("done", "pending") and p.id in shipped_pos_ids
        ]
        ready = [p for p in done if p.id not in shipped_pos_ids]
        if not ready:
            continue
        ship_addr = order.ship_address or {}
        ms = order.manual_shipment or {}
        result.append(
            {
                "order_no": order.no,
                "order_id": order.id,
                "customer": ship_addr.get("company", "") or ship_addr.get("street", ""),
                "ship_to": ship_addr,
                "manual_shipment": {
                    "carrier": ms.get("carrier", ""),
                    "tracking": ms.get("tracking", ""),
                    "price": ms.get("price", 0.0),
                    "note": ms.get("note", ""),
                } if ms else None,
                "n_positions": len(o_positions),
                "n_done": len(done),
                "n_ready": len(ready),
                "n_shipped": len(shipped),
                "due_date": order.due_date.isoformat() if order.due_date else None,
                "rush": order.rush,
                "positions": [
                    {
                        "id": p.id,
                        "label": p.label,
                        "mat": p.mat,
                        "thk": p.thk,
                        "qty": p.qty,
                        "od": p.od,
                        "di": p.di,
                        "production_status": p.production_status,
                        "tag": tag_by_pos.get(p.id, ""),
                        "work_order_no": wo_no_by_pos.get(p.id, ""),
                    }
                    for p in ready
                ],
            }
        )
    return result


def is_in_shipment(db: Session, position_id: int) -> bool:
    return (
        db.query(ShipmentItem).filter(ShipmentItem.position_id == position_id).first()
        is not None
    )


def tag_for_position(db: Session, position_id: int) -> str:
    wi = db.query(WorkItem).filter(WorkItem.position_id == position_id).first()
    return wi.tag if wi else ""


def wo_no_for_position(db: Session, position_id: int) -> str:
    wi = db.query(WorkItem).filter(WorkItem.position_id == position_id).first()
    if not wi:
        return ""
    wo = db.get(WorkOrder, wi.work_order_id)
    return wo.no if wo else ""
