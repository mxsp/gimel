"""Querverweis zwischen Kundenauftrag und Innenauftrag — in beide Richtungen.

Die Sammelschachtelung zerlegt einen Kundenauftrag über mehrere Innenaufträge
(je Werkstoff und Dicke einer) und legt in denselben Innenauftrag die Teile
mehrerer Kunden. Damit ist keine der beiden naheliegenden Fragen mehr von
selbst beantwortet:

  * **Vom Auftrag aus:** wo steckt meine Position gerade, auf welcher Platte
    liegt sie, unter welcher Marke — und wie weit ist der Schnitt?
  * **Vom Innenauftrag aus:** wem gehört welches Teil auf dieser Platte?

Die zweite beantwortet die Laufkarte schon lange. Die erste blieb offen, und
ohne sie kann weder der Vertrieb eine Rückfrage beantworten noch der Kunde
seinen Auftrag verfolgen: der Fertigungsstatus stand als Wort an der Position
(``pending`` / ``batched`` / ``done``) und verwies auf nichts.

Beide Richtungen kommen aus derselben Tabelle: ``work_items`` trägt
``position_id`` und ``order_no``. Es gibt bewusst keine zweite Zuordnungsspur —
zwei Wahrheiten über dieselbe Platte wären schlimmer als keine.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import (
    GoodsReceipt,
    MaterialLot,
    NestRun,
    Offcut,
    Order,
    OrderPosition,
    PurchaseOrder,
    ScrapEvent,
    Shipment,
    ShipmentItem,
    StockMovement,
    Supplier,
    WorkItem,
    WorkOrder,
    WorkOrderStatus,
    WorkPlate,
)
#: Wie der Fertigungsstatus einer Position auf Deutsch heißt. Der Kunde liest
#: ihn, also steht er nicht als englisches Kürzel in der Oberfläche.
STATUS_TEXT = {
    "pending": "wartet auf Einplanung",
    "batched": "eingeplant",
    "done": "geschnitten",
    "manual": "Anfrage an die Technik",
}

#: Ein Innenauftragsstatus, übersetzt auf den Fortschritt der Position.
WO_STATUS_TEXT = {
    WorkOrderStatus.open: "eingeplant",
    WorkOrderStatus.running: "im Schnitt",
    WorkOrderStatus.done: "geschnitten",
    WorkOrderStatus.cancelled: "zurückgestellt",
}


def _rows(db: Session, position_ids: list[int]):
    """Alle Platzierungen zu diesen Positionen, mit Platte und Innenauftrag."""
    if not position_ids:
        return []
    return (db.query(WorkItem, WorkPlate, WorkOrder)
              .join(WorkPlate, WorkItem.plate_id == WorkPlate.id)
              .join(WorkOrder, WorkItem.work_order_id == WorkOrder.id)
              .filter(WorkItem.position_id.in_(position_ids))
              .all())


def order_trace(db: Session, order: Order) -> dict:
    """Vom Kundenauftrag zu seinen Innenaufträgen.

    Rückgabe: eine Liste der beteiligten Innenaufträge und je Position, wo sie
    liegt. Positionen ohne Platzierung erscheinen trotzdem — mit dem Grund,
    warum sie noch nirgends liegen; ein leerer Eintrag wäre nicht dasselbe wie
    „wartet noch“.
    """
    positions = list(order.positions)
    rows = _rows(db, [p.id for p in positions])

    by_wo: dict[str, dict] = {}
    by_pos: dict[int, dict] = {}

    for item, plate, wo in rows:
        w = by_wo.setdefault(wo.no, {
            "no": wo.no,
            "id": wo.id,
            "run_no": wo.run.no if wo.run else "",
            "mat": wo.mat, "mat_name": wo.mat_name, "thk": wo.thk,
            "status": wo.status.value,
            "status_text": WO_STATUS_TEXT.get(wo.status, wo.status.value),
            "machine": wo.machine,
            "formats": wo.formats or ([wo.fmt] if wo.fmt else []),
            "n_plates": wo.n_plates,
            "n_orders": wo.n_orders,
            "release_reason": wo.release_reason,
            "policy_mode": wo.policy_mode,
            "created_at": wo.created_at,
            "started_at": wo.started_at,
            "done_at": wo.done_at,
            "due_date": wo.due_date,
            # Wie viele Teile DIESES Auftrags auf diesem Innenauftrag liegen —
            # nicht wie viele insgesamt. Der Unterschied ist der ganze Punkt
            # der Sammelschachtelung.
            "own_parts": 0,
            "own_tags": [],
            "plates": set(),
            "lot_ids": set(),
        })
        w["own_parts"] += 1
        w["own_tags"].append(item.tag)
        w["plates"].add(plate.idx + 1)
        if plate.lot_id:
            w["lot_ids"].add(plate.lot_id)

        e = by_pos.setdefault(item.position_id, {
            "work_order_no": wo.no, "tags": [], "plates": set(),
            "from_remnant": 0,
        })
        e["tags"].append(item.tag)
        e["plates"].add(plate.idx + 1)
        if item.from_remnant:
            e["from_remnant"] += 1

    all_lot_ids = {lid for w in by_wo.values() for lid in w["lot_ids"]}
    lot_codes = (
        {l.id: l.code for l in db.query(MaterialLot).filter(MaterialLot.id.in_(all_lot_ids)).all()}
        if all_lot_ids else {}
    )
    work_orders = []
    for w in by_wo.values():
        w["plates"] = sorted(w["plates"])
        w["own_tags"] = sorted(w["own_tags"])
        w["lots"] = sorted(lot_codes[lid] for lid in w.pop("lot_ids") if lid in lot_codes)
        work_orders.append(w)
    work_orders.sort(key=lambda w: w["no"])

    # Wie viele Platten jedes beteiligten Innenauftrags am Plotter schon
    # abgehakt sind — über ALLE Platten, nicht nur die eigenen dieses
    # Auftrags: der Haken hängt an der Platte, und der Fortschritt am
    # Innenauftrag ist eine Zahl über seine Platte, nicht über einen Teil von
    # ihr. Ohne Platzierung (leere Liste) bleibt der Zähler bei 0.
    wo_ids = [w["id"] for w in work_orders]
    done_by_wo: dict[int, int] = {}
    if wo_ids:
        for wo_id, pl_status in (
            db.query(WorkPlate.work_order_id, WorkPlate.status)
            .filter(WorkPlate.work_order_id.in_(wo_ids))
            .all()
        ):
            val = pl_status.value if hasattr(pl_status, "value") else str(pl_status)
            if val == "done":
                done_by_wo[wo_id] = done_by_wo.get(wo_id, 0) + 1
    for w in work_orders:
        w["n_done_plates"] = done_by_wo.get(w.pop("id"), 0)

    pos_out = []
    for p in positions:
        e = by_pos.get(p.id)
        entry = {
            "position_id": p.id,
            "label": p.label,
            "mat": p.mat,
            "thk": p.thk,
            "qty": p.qty,
            "kind": p.kind,
            "production_status": p.production_status,
            "status_text": STATUS_TEXT.get(p.production_status, p.production_status),
            "shape_id": p.shape_id,
            "work_order_no": e["work_order_no"] if e else None,
            "tags": sorted(e["tags"]) if e else [],
            "plates": sorted(e["plates"]) if e else [],
            "n_from_remnant": e["from_remnant"] if e else 0,
        }
        if p.kind == "sheet":
            entry["status_text"] = "Plattenware ab Lager"
        pos_out.append(entry)

    planned = sum(1 for p in pos_out if p["work_order_no"])
    return {
        "work_orders": work_orders,
        "positions": pos_out,
        "n_positions": len(pos_out),
        "n_planned": planned,
        "n_waiting": sum(1 for p in positions if p.production_status == "pending"),
        "n_manual": sum(1 for p in positions if p.production_status == "manual"),
        "n_done": sum(1 for p in positions if p.production_status == "done"),
    }


def work_order_trace(db: Session, wo: WorkOrder) -> list[dict]:
    """Vom Innenauftrag zu den Kundenaufträgen darauf.

    Je Kundenauftrag: Kunde, Bestellzeichen, Zusagedatum, die Marken und auf
    welchen Platten sie liegen. Das ist die Zeile, die der Werker beim Sortieren
    liest, und die Zeile, die der Vertrieb bei einer Rückfrage aufschlägt.
    """
    items = (db.query(WorkItem, WorkPlate)
               .join(WorkPlate, WorkItem.plate_id == WorkPlate.id)
               .filter(WorkItem.work_order_id == wo.id).all())
    if not items:
        return []

    order_nos = sorted({i.order_no for i, _ in items})
    orders = {o.no: o for o in db.query(Order).filter(Order.no.in_(order_nos)).all()}

    out = []
    for no in order_nos:
        mine = [(i, pl) for i, pl in items if i.order_no == no]
        order = orders.get(no)
        pos_ids = sorted({i.position_id for i, _ in mine if i.position_id})
        out.append({
            "order_no": no,
            "customer": mine[0][0].customer,
            "customer_ref": mine[0][0].customer_ref,
            "tags": sorted(i.tag for i, _ in mine),
            "plates": sorted({pl.idx + 1 for _, pl in mine}),
            "n_parts": len(mine),
            "n_positions": len(pos_ids),
            "position_ids": pos_ids,
            "due_date": order.due_date if order else None,
            "rush": bool(order.rush) if order else False,
            "cert": order.cert if order else "",
            # Liegt der ganze Auftrag hier, oder nur ein Teil davon? Beim
            # Verpacken ist genau das die Frage.
            "complete": bool(order and len(pos_ids) == len(
                [p for p in order.positions if p.kind != "sheet"])),
        })
    return out


def run_trace(db: Session, run: NestRun) -> dict:
    """Ein Sammellauf und die Kundenaufträge, die er berührt hat."""
    wos = db.query(WorkOrder).filter(WorkOrder.run_id == run.id).all()
    order_nos: set[str] = set()
    for wo in wos:
        order_nos |= {i.order_no for i in
                      db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()}
    return {
        "work_orders": [{"no": w.no, "mat": w.mat, "mat_name": w.mat_name, "thk": w.thk,
                         "status": w.status.value, "n_plates": w.n_plates,
                         "n_parts": w.n_parts, "n_orders": w.n_orders,
                         "release_reason": w.release_reason} for w in wos],
        "orders": sorted(order_nos),
    }


def lot_trace(db: Session, lot: MaterialLot) -> dict:
    """Bidirektionale Rückverfolgung einer Materialcharge (Palantir-Genealogie).

    Aufwärts: Lieferant, Bestellung, Wareneingang, Prüfzeugnis (2.2 / 3.1).
    Abwärts: Lagerbewegungen, Reststücke, geschnittene Platten, Innenaufträge,
    Kundenaufträge, betroffene Sendungen und Ausschussmeldungen.
    """
    supplier = db.get(Supplier, lot.supplier_id) if lot.supplier_id else None
    receipt = db.get(GoodsReceipt, lot.goods_receipt_id) if lot.goods_receipt_id else None
    po = (
        db.query(PurchaseOrder).filter(PurchaseOrder.no == lot.purchase_order_no).first()
        if lot.purchase_order_no else None
    )

    movements = (
        db.query(StockMovement)
        .filter(StockMovement.lot_id == lot.id)
        .order_by(StockMovement.created_at.asc(), StockMovement.id.asc())
        .all()
    )
    plates = (
        db.query(WorkPlate, WorkOrder)
        .join(WorkOrder, WorkPlate.work_order_id == WorkOrder.id)
        .filter(WorkPlate.lot_id == lot.id)
        .order_by(WorkOrder.no.asc(), WorkPlate.idx.asc())
        .all()
    )
    offcuts = (
        db.query(Offcut)
        .filter(Offcut.lot_id == lot.id)
        .order_by(Offcut.id.asc())
        .all()
    )
    scrap = (
        db.query(ScrapEvent)
        .filter(ScrapEvent.lot_id == lot.id)
        .order_by(ScrapEvent.recorded_at.desc())
        .all()
    )

    plate_ids = [pl.id for pl, _ in plates]
    items = (
        db.query(WorkItem)
        .filter(WorkItem.plate_id.in_(plate_ids))
        .all()
        if plate_ids else []
    )
    order_nos = sorted({it.order_no for it in items if it.order_no})
    orders = (
        db.query(Order).filter(Order.no.in_(order_nos)).all()
        if order_nos else []
    )
    shipments = (
        db.query(Shipment)
        .join(ShipmentItem, ShipmentItem.shipment_id == Shipment.id)
        .filter(ShipmentItem.order_no.in_(order_nos))
        .distinct()
        .all()
        if order_nos else []
    )

    return {
        "lot": {
            "id": lot.id,
            "code": lot.code,
            "product_id": lot.product_id,
            "thk": lot.thk,
            "sheet_w": lot.sheet_w,
            "sheet_h": lot.sheet_h,
            "supplier_batch": lot.supplier_batch,
            "cert_type": lot.cert_type,
            "cert_ref": lot.cert_ref,
            "qty_initial": lot.qty_initial,
            "qty_remaining": lot.qty_remaining,
            "unit_eur_m2": lot.unit_eur_m2,
            "station_id": lot.station_id,
            "bin": lot.bin,
            "status": lot.status,
            "received_at": lot.received_at.isoformat() if lot.received_at else None,
        },
        "upstream": {
            "supplier": (
                {"id": supplier.id, "code": supplier.code, "name": supplier.name}
                if supplier else None
            ),
            "purchase_order": (
                {
                    "no": po.no,
                    "status": po.status.value,
                    "order_date": po.order_date.isoformat() if po.order_date else None,
                }
                if po else ({"no": lot.purchase_order_no} if lot.purchase_order_no else None)
            ),
            "goods_receipt": (
                {
                    "no": receipt.no,
                    "delivery_note_no": receipt.delivery_note_no,
                    "received_at": receipt.received_at.isoformat() if receipt.received_at else None,
                    "received_by": receipt.received_by,
                }
                if receipt else None
            ),
        },
        "downstream": {
            "movements": [
                {
                    "id": m.id, "delta": m.delta, "balance_after": m.balance_after,
                    "reason": m.reason, "work_order_no": m.work_order_no,
                    "purchase_order_no": m.purchase_order_no, "actor": m.actor,
                    "created_at": m.created_at.isoformat() if m.created_at else None,
                }
                for m in movements
            ],
            "plates": [
                {
                    "plate_id": pl.id, "plate_idx": pl.idx + 1, "work_order_no": wo.no,
                    "status": pl.status.value if hasattr(pl.status, "value") else str(pl.status),
                    "n_parts": pl.n_parts, "utilisation": round(float(pl.utilisation or 0), 3),
                }
                for pl, wo in plates
            ],
            "work_orders": sorted({wo.no for _, wo in plates}),
            "offcuts": [
                {
                    "code": oc.code, "status": oc.status, "w": oc.w, "h": oc.h,
                    "work_order_no": oc.work_order_no,
                }
                for oc in offcuts
            ],
            "orders": [
                {
                    "no": o.no, "stage": o.stage, "cert": o.cert,
                    "customer_ref": o.customer_ref,
                    "due_date": o.due_date.isoformat() if o.due_date else None,
                }
                for o in sorted(orders, key=lambda r: r.no)
            ],
            "shipments": [
                {
                    "no": s.no, "status": s.status.value, "carrier": s.carrier,
                    "tracking": s.tracking,
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                }
                for s in sorted(shipments, key=lambda r: r.no)
            ],
            "scrap": [
                {
                    "id": sc.id, "work_order_no": sc.work_order_no,
                    "qty_parts": sc.qty_parts, "area_m2": sc.area_m2,
                    "reason": sc.reason,
                    "recorded_at": sc.recorded_at.isoformat() if sc.recorded_at else None,
                }
                for sc in scrap
            ],
        },
        "blast_radius": {
            "n_plates": len(plates),
            "n_work_orders": len({wo.no for _, wo in plates}),
            "n_orders": len(orders),
            "n_shipments": len(shipments),
            "n_offcuts": len(offcuts),
            "n_scrap_events": len(scrap),
        },
    }
