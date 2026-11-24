"""Innenauftrag stornieren — die Gegenbuchung zum Sammellauf.

Der Sammellauf zieht Platten und legt Marken an, sobald er plant. Wird ein
Innenauftrag danach storniert, muss beides zurück: der Bestand und die Marken.
Bis 2026-11 setzte die Stornierung nur den Status und die Positionen zurück;
der nächste Lauf zog dieselben Platten ein zweites Mal und alte Marken blieben
für Versand und Rückverfolgung sichtbar. Diese Datei macht die Stornierung zur
einen, idempotenten Gegenbuchung.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from ..db import chunked_in
from ..models import AuditLog, OrderPosition, Product, WorkItem, WorkOrder, WorkOrderStatus
from .inventory import move_stock
from . import offcuts as offcut_svc


def cancel_work_order(
    db: Session,
    wo: WorkOrder,
    *,
    actor: str,
    reason: str = "",
    commit: bool = False,
) -> dict:
    """Einen **offenen** Innenauftrag stornieren.

    Nur ``open`` ist zulässig. Ein laufender oder fertiger Auftrag hat
    geschnittenes Material gegen sich; ihn hier zurückzubuchen würde die
    Werkstatt und die Rückverfolgung belügen. Für diesen Fall bleibt die
    ausdrückliche Korrektur im Support.
    """
    if wo.status == WorkOrderStatus.cancelled:
        return {"work_order_no": wo.no, "already_cancelled": True,
                "position_ids": [], "items_removed": 0, "stock_returned": 0}
    if wo.status != WorkOrderStatus.open:
        raise ValueError(
            f"{wo.no} ist {wo.status.value} — nur offene Innenaufträge können "
            "storniert werden."
        )

    # Atomarer Zustandsübergang: verhindert doppelte Bestandsrückbuchung bei
    # gleichzeitigen Storno-Anfragen.
    claimed = (
        db.query(WorkOrder)
        .filter(WorkOrder.id == wo.id, WorkOrder.status == WorkOrderStatus.open)
        .update({WorkOrder.status: WorkOrderStatus.cancelled}, synchronize_session=False)
    )
    if claimed != 1:
        db.expire(wo, ["status"])
        if wo.status == WorkOrderStatus.cancelled:
            return {"work_order_no": wo.no, "already_cancelled": True,
                    "position_ids": [], "items_removed": 0, "stock_returned": 0}
        raise ValueError(
            f"{wo.no} ist {wo.status.value} — nur offene Innenaufträge können "
            "storniert werden."
        )
    wo.status = WorkOrderStatus.cancelled

    items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
    position_ids = sorted({int(i.position_id) for i in items if i.position_id})
    if items:
        db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).delete(
            synchronize_session=False
        )

    stock_returned = 0
    # Platten aus Reststücken waren nie vom Bestand abgezogen — sie gehen als
    # Reststück zurück, nicht als volle Platte.
    n_from_offcut = sum(1 for p in wo.plates if getattr(p, "offcut_id", None))
    full_plates = max(0, int(wo.n_plates or 0) - n_from_offcut)
    offcut_result = offcut_svc.release_for(db, wo)
    if full_plates:
        product = db.get(Product, wo.mat)
        if product is not None:
            move_stock(
                db,
                product,
                full_plates,
                reason="storno",
                actor=actor,
                work_order_no=wo.no,
                note=f"{wo.no} storniert — geplanter Schnitt fand nicht statt",
            )
            stock_returned = full_plates

    if position_ids:
        (
            db.query(OrderPosition)
            .filter(chunked_in(OrderPosition.id, position_ids))
            .filter(OrderPosition.production_status != "done")
            .update({OrderPosition.production_status: "pending"},
                    synchronize_session=False)
        )

    for plate in wo.plates:
        plate.status = WorkOrderStatus.open

    wo.order_done = {}
    wo.material_staged_at = None
    wo.material_staged_by = ""
    if reason:
        wo.note = f"{wo.note}\n{reason}".strip()[:2000]

    db.add(
        AuditLog(
            actor=actor,
            action="work_order_cancel",
            entity="work_order",
            entity_id=wo.no,
            detail={
                "reason": reason[:200],
                "positions": len(position_ids),
                "items_removed": len(items),
                "stock_returned": stock_returned,
                **offcut_result,
            },
        )
    )
    if commit:
        db.commit()
    return {
        "work_order_no": wo.no,
        "already_cancelled": False,
        "position_ids": position_ids,
        "items_removed": len(items),
        "stock_returned": stock_returned,
        **offcut_result,
    }
