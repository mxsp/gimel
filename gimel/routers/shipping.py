"""Versand — Aufträge gruppieren, Pakete anlegen, Versandmarke drucken.

Der Versand lebt nach der Fertigung: ein Innenauftrag ist „fertig" (done),
wenn alle Teile geschnitten sind. Danach müssen die Teile sortiert, gepackt
und verschickt werden. Die Versandmarke (Paketbrief/Packing List) zeigt dem
Werker, was in welches Paket kommt — sortiert nach Auftragsnummer, nicht nach
Innenauftrag, weil der Innenauftrag bei Abbruch und Neuvergabe wechselt, die
Auftragsnummer aber stabil bleibt.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import (
    AuditLog,
    Order,
    OrderPosition,
    Shipment,
    ShipmentItem,
    ShipmentStatus,
    User,
    WorkItem,
    WorkOrder,
)
from ..security import require_staff, require_worker
from ..services.numbering import next_number
from ..services.shipping import (
    is_in_shipment as _is_in_shipment,
    order_ready_rows as _order_ready_rows,
)
from ..services.trace import STATUS_TEXT
from ..services.ups_tracking import client_from_settings, is_ups_shipment

router = APIRouter(prefix="/api/shipping", tags=["shipping"])
settings = get_settings()


# ---------------------------------------------------------------------------
#  Pydantic schemas
# ---------------------------------------------------------------------------


class ShipmentCreate(BaseModel):
    order_nos: list[str]
    carrier: str = ""
    tracking: str = ""
    note: str = ""
    #: Versandkosten, von Hand erfasst — Vorgabe kommt vom manuellen Versand
    #: des Auftragsbüros, wenn dort einer erfasst wurde. ``None`` heißt „nicht
    #: angegeben"; 0 ist ein echter Preis (Eigenabholung).
    price: float | None = None


class ShipmentUpdate(BaseModel):
    status: ShipmentStatus | None = None
    carrier: str | None = None
    tracking: str | None = None
    note: str | None = None
    price: float | None = None


class ItemNote(BaseModel):
    note: str = ""


# ---------------------------------------------------------------------------
#  Hilfsfunktionen
# ---------------------------------------------------------------------------


def _shipment_prefix() -> str:
    return f"VS-{datetime.now(timezone.utc).strftime('%y')}-"


def _shipment_out(s: Shipment) -> dict:
    items = []
    for it in s.items:
        items.append(
            {
                "id": it.id,
                "order_no": it.order_no,
                "order_id": it.order_id,
                "position_id": it.position_id,
                "work_order_no": it.work_order_no,
                "tag": it.tag,
                "label": it.label,
                "mat": it.mat,
                "thk": it.thk,
                "qty": it.qty,
                "note": it.note,
            }
        )
    return {
        "id": s.id,
        "no": s.no,
        "status": s.status.value,
        "carrier": s.carrier,
        "tracking": s.tracking,
        "price": s.price,
        "ship_to": s.ship_to,
        "note": s.note,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "shipped_at": s.shipped_at.isoformat() if s.shipped_at else None,
        "delivered_at": s.delivered_at.isoformat() if s.delivered_at else None,
        "packed_by": s.packed_by,
        "shipped_by": s.shipped_by,
        "n_items": len(items),
        "items": items,
    }


_SHIPMENT_TRANSITIONS: dict[ShipmentStatus, set[ShipmentStatus]] = {
    ShipmentStatus.packing: {ShipmentStatus.shipped, ShipmentStatus.delivered,
                             ShipmentStatus.returned},
    ShipmentStatus.shipped: {ShipmentStatus.delivered, ShipmentStatus.returned},
    ShipmentStatus.delivered: {ShipmentStatus.returned},
    ShipmentStatus.returned: set(),
}


def _mark_shipment_status(s: Shipment, status: ShipmentStatus, actor: str):
    """Statuswechsel mit geprüften Übergängen und stimmigen Zeitstempeln.

    Eine Rücksendung ist kein Versand, und ein direkter Sprung auf „zugestellt"
    darf kein fehlendes Versanddatum hinterlassen. Was einmal passiert ist,
    bleibt als Zeitpunkt erhalten; nur der Weg zurück auf „in Vorbereitung"
    räumt ihn ab.
    """
    if status == s.status:
        return
    if status not in _SHIPMENT_TRANSITIONS.get(s.status, set()):
        raise ValueError(
            f"Versand {s.no}: {s.status.value} → {status.value} ist kein "
            "erlaubter Schritt."
        )
    now = datetime.now(timezone.utc)
    if status == ShipmentStatus.packing:
        s.shipped_at = None
        s.shipped_by = ""
        s.delivered_at = None
    elif status == ShipmentStatus.shipped:
        s.shipped_at = s.shipped_at or now
        s.shipped_by = s.shipped_by or actor
        if not s.packed_by:
            s.packed_by = actor
        s.delivered_at = None
    elif status == ShipmentStatus.delivered:
        s.shipped_at = s.shipped_at or now
        s.shipped_by = s.shipped_by or actor
        if not s.packed_by:
            s.packed_by = actor
        s.delivered_at = now
    elif status == ShipmentStatus.returned:
        # Eine Rücksendung ist kein Versand: vorhandene Zeitpunkte bleiben,
        # aber aus „in Vorbereitung" wird kein erfundenes Versanddatum.
        pass
    s.status = status


def _apply_ups_status(s: Shipment, ups_status: str, actor: str) -> str:
    """UPS-Status in den Versand übersetzen — Rückgabe: was geändert wurde.

    UPS ist führend, wenn es etwas weiß, das wir nicht wissen: zugestellt und
    Rücksendung werden immer übernommen, „unterwegs" zieht nur nach, solange
    der Versand noch als „in Vorbereitung" hängt. Zurück stuft niemand um —
    das bleibt der Handarbeit vorbehalten."""
    if ups_status == "delivered" and s.status != ShipmentStatus.delivered:
        _mark_shipment_status(s, ShipmentStatus.delivered, actor)
        return "delivered"
    if ups_status == "returned" and s.status not in (
        ShipmentStatus.returned,
        ShipmentStatus.delivered,
    ):
        _mark_shipment_status(s, ShipmentStatus.returned, actor)
        return "returned"
    if ups_status == "in_transit" and s.status == ShipmentStatus.packing:
        _mark_shipment_status(s, ShipmentStatus.shipped, actor)
        return "shipped"
    return ""


# ---------------------------------------------------------------------------
#  Endpunkte
# ---------------------------------------------------------------------------


@router.get("/ready", dependencies=[Depends(require_worker)])
def ready_orders(db: Annotated[Session, Depends(get_db)]):
    """Aufträge mit geschnittenen, aber noch nicht verpackten Positionen."""
    return {"orders": _order_ready_rows(db)}


@router.get("/", dependencies=[Depends(require_worker)])
def list_shipments(
    db: Annotated[Session, Depends(get_db)],
    status: str = "",
    q: str = "",
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    from sqlalchemy import or_
    from sqlalchemy.orm import selectinload

    query = db.query(Shipment).options(selectinload(Shipment.items))
    if status:
        query = query.filter(Shipment.status == status)
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.filter(
            or_(
                Shipment.no.ilike(like),
                Shipment.tracking.ilike(like),
                Shipment.carrier.ilike(like),
            )
        )
    total = int(query.count() or 0)
    rows = query.order_by(Shipment.created_at.desc(), Shipment.id.desc()).offset(offset).limit(limit).all()
    return {
        "shipments": [_shipment_out(s) for s in rows],
        "total": total,
        "has_more": offset + len(rows) < total,
    }


@router.get("/{no}", dependencies=[Depends(require_worker)])
def get_shipment(no: str, db: Annotated[Session, Depends(get_db)]):
    s = db.query(Shipment).filter(Shipment.no == no).first()
    if not s:
        raise HTTPException(404, f"Versand {no} nicht gefunden.")
    return _shipment_out(s)


@router.post("/")
def create_shipment(
    body: ShipmentCreate,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
):
    """Neuen Versand anlegen: Auftragsnummern übergeben, Teile werden
    automatisch zugeordnet."""
    if not body.order_nos:
        raise HTTPException(400, "Mindestens einen Auftrag angeben.")

    # Dieselbe Auftragsnummer zweimal in einer Anfrage würde dieselben
    # Positionen doppelt anlegen; die Reihenfolge bleibt erhalten.
    order_nos = list(dict.fromkeys(body.order_nos))
    addresses: dict[str, dict] = {}
    items = []
    seen_positions: set[int] = set()
    # Vorgabe aus dem manuellen Versand des Auftragsbüros: der erste gewählte
    # Auftrag mit handerfassten Versandangaben liefert Spedition, Tracking,
    # Notiz und Preis — solange der Anfrage selbst nichts (oder nur ein Teil)
    # mitgegeben wurde. Der Versand kann alles danach editieren.
    ms_default = {"carrier": "", "tracking": "", "note": "", "price": 0.0}
    for order_no in order_nos:
        order = db.query(Order).filter(Order.no == order_no).first()
        if not order:
            raise HTTPException(404, f"Auftrag {order_no} nicht gefunden.")
        if (order.kind or "external") == "internal":
            raise HTTPException(
                409, f"{order_no} ist ein interner Auftrag und wird nicht versendet."
            )
        if order.cancelled_at is not None:
            raise HTTPException(409, f"{order_no} ist storniert und wird nicht versendet.")
        address = order.ship_address or {}
        if address:
            addresses.setdefault(
                json.dumps(address, sort_keys=True, ensure_ascii=False), address
            )
        ms = order.manual_shipment or {}
        if ms:
            for k in ms_default:
                if not ms_default[k] and ms.get(k):
                    ms_default[k] = ms[k]
        # Alle done-Positionen, die noch nicht in einem Versand sind
        positions = (
            db.query(OrderPosition)
            .filter(
                OrderPosition.order_id == order.id,
                OrderPosition.production_status == "done",
            )
            .all()
        )
        for p in positions:
            if p.id in seen_positions or _is_in_shipment(db, p.id):
                continue
            seen_positions.add(p.id)
            wi = db.query(WorkItem).filter(WorkItem.position_id == p.id).first()
            wo_no = ""
            tag = ""
            if wi:
                tag = wi.tag
                wo = db.get(WorkOrder, wi.work_order_id)
                wo_no = wo.no if wo else ""
            items.append(
                ShipmentItem(
                    order_id=order.id,
                    order_no=order_no,
                    position_id=p.id,
                    work_order_no=wo_no,
                    tag=tag,
                    label=p.label,
                    mat=p.mat,
                    thk=p.thk,
                    qty=p.qty,
                )
            )

    if not items:
        raise HTTPException(
            400, "Keine versandfertigen Positionen für die angegebenen Aufträge."
        )
    if len(addresses) > 1:
        raise HTTPException(
            409,
            "Die gewählten Aufträge haben unterschiedliche Lieferanschriften. "
            "Bitte je Anschrift einen eigenen Versand anlegen.",
        )
    ship_to = next(iter(addresses.values()), {})

    s = Shipment(
        no=next_number(db, "shipment", _shipment_prefix()),
        carrier=body.carrier.strip() or ms_default["carrier"],
        tracking=body.tracking.strip() or ms_default["tracking"],
        price=body.price if body.price is not None else ms_default["price"],
        ship_to=ship_to,
        note=body.note.strip() or ms_default["note"],
    )
    s.items = items
    db.add(s)
    db.add(
        AuditLog(
            actor=actor.email,
            action="shipment_create",
            entity="shipment",
            entity_id=s.no,
            detail={
                "order_nos": body.order_nos,
                "n_items": len(items),
                "prefill_manual_shipment": bool(
                    ms_default["carrier"] or ms_default["tracking"]
                ),
            },
        )
    )
    db.commit()
    db.refresh(s)
    return _shipment_out(s)


@router.patch("/{no}")
def update_shipment(
    no: str,
    body: ShipmentUpdate,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
):
    s = db.query(Shipment).filter(Shipment.no == no).first()
    if not s:
        raise HTTPException(404, f"Versand {no} nicht gefunden.")
    if body.status:
        try:
            _mark_shipment_status(s, body.status, actor.email)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    if body.carrier is not None:
        s.carrier = body.carrier
    if body.tracking is not None:
        s.tracking = body.tracking
    if body.note is not None:
        s.note = body.note
    if body.price is not None:
        s.price = body.price
    db.add(
        AuditLog(
            actor=actor.email,
            action="shipment_update",
            entity="shipment",
            entity_id=s.no,
            detail={"status": s.status.value},
        )
    )
    db.commit()
    db.refresh(s)
    return _shipment_out(s)


@router.delete("/{no}")
def delete_shipment(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
):
    s = db.query(Shipment).filter(Shipment.no == no).first()
    if not s:
        raise HTTPException(404, f"Versand {no} nicht gefunden.")
    if s.status != ShipmentStatus.packing:
        raise HTTPException(400, "Nur offene Versände können gelöscht werden.")
    db.add(
        AuditLog(
            actor=actor.email,
            action="shipment_delete",
            entity="shipment",
            entity_id=s.no,
        )
    )
    db.delete(s)
    db.commit()
    return {"deleted": no}


@router.get("/{no}/label", response_class=HTMLResponse, dependencies=[Depends(require_worker)])
def shipment_label_html(no: str, db: Annotated[Session, Depends(get_db)]):
    """Versandmarke als HTML —Auftragsnummer als Hauptkennung,
    sortiert nach Auftrag und Marke."""
    from ..render.label import shipment_label

    s = db.query(Shipment).filter(Shipment.no == no).first()
    if not s:
        raise HTTPException(404, f"Versand {no} nicht gefunden.")
    return shipment_label(s)


@router.get("/{no}/orders", dependencies=[Depends(require_worker)])
def shipment_orders(no: str, db: Annotated[Session, Depends(get_db)]):
    """Aufträge dieses Versands, gruppiert nach Auftragsnummer."""
    s = db.query(Shipment).filter(Shipment.no == no).first()
    if not s:
        raise HTTPException(404, f"Versand {no} nicht gefunden.")
    groups: dict[str, list] = {}
    for it in s.items:
        groups.setdefault(it.order_no, []).append(
            {
                "tag": it.tag,
                "label": it.label,
                "mat": it.mat,
                "thk": it.thk,
                "qty": it.qty,
                "work_order_no": it.work_order_no,
                "note": it.note,
            }
        )
    return {"orders": [{"order_no": k, "items": v} for k, v in groups.items()]}


@router.get("/by-order/{order_no}", dependencies=[Depends(require_worker)])
def shipments_by_order(order_no: str, db: Annotated[Session, Depends(get_db)]):
    """Staff lookup; customer shipments travel through authenticated order tracking."""
    rows = (
        db.query(Shipment)
        .join(ShipmentItem, ShipmentItem.shipment_id == Shipment.id)
        .filter(ShipmentItem.order_no == order_no)
        .order_by(Shipment.created_at.desc())
        .all()
    )
    seen = {}
    for s in rows:
        seen[s.no] = s
    uniq = list(seen.values())
    return {
        "order_no": order_no,
        "shipments": [
            {
                "no": s.no,
                "status": s.status.value,
                "carrier": s.carrier,
                "tracking": s.tracking,
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "shipped_at": s.shipped_at.isoformat() if s.shipped_at else None,
                "delivered_at": s.delivered_at.isoformat() if s.delivered_at else None,
            }
            for s in uniq
        ],
    }


@router.get("/{no}/tracking")
def shipment_tracking(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
):
    """Live-Status von UPS abrufen und den Versand bei Abweichung nachziehen.

    Der Aufruf ist ein Sync, kein bloßes Nachschlagen: meldet UPS „zugestellt"
    oder „Rücksendung", springt der Versandstatus mit (Audit-Log
    ``shipment_tracking_sync``). Ist UPS nicht konfiguriert oder antwortet
    nicht, kommt das als ``ups.ok=False`` zurück — der Versand bleibt unangetastet."""
    s = db.query(Shipment).filter(Shipment.no == no).first()
    if not s:
        raise HTTPException(404, f"Versand {no} nicht gefunden.")
    if not s.tracking.strip():
        raise HTTPException(400, "Kein Tracking-Code hinterlegt.")
    if not is_ups_shipment(s.carrier, s.tracking):
        raise HTTPException(
            400,
            "Dieser Versand ist kein UPS-Versand — die Live-Abfrage bleibt "
            "beim passenden Spediteur.",
        )

    result = client_from_settings().track(s.tracking)
    if not result.get("ok"):
        return {"shipment": _shipment_out(s), "ups": result}

    changed = _apply_ups_status(s, result.get("status", ""), "ups-api")
    if changed:
        db.add(
            AuditLog(
                actor=actor.email,
                action="shipment_tracking_sync",
                entity="shipment",
                entity_id=s.no,
                detail={"ups_status": result.get("status"), "changed": changed},
            )
        )
        db.commit()
        db.refresh(s)
    return {"shipment": _shipment_out(s), "ups": result}
