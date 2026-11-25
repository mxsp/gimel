"""Kalender-API: Mehr-Ebenen-Terminübersicht (Aufträge, Einkauf/Lieferungen,
Innenaufträge, Wartung/Termine, Tageskapazität), schnelles Umterminieren & iCal-Export."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import (
    AuditLog,
    CalendarEvent,
    FactoryStation,
    FactoryStationType,
    Order,
    OrderPosition,
    PurchaseOrder,
    PurchaseOrderLine,
    Supplier,
    User,
    WorkOrder,
    WorkOrderStatus,
)
from ..security import require_staff, require_worker
from ..services import floor_view
from ..services.scm_analytics import OPEN_PO_STATUSES

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _date_key(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()[:10]


def _order_status(o: Order) -> tuple[str, str]:
    if o.cancelled_at:
        return "storniert", "Storniert"
    if o.held_at:
        return "angehalten", "Angehalten"
    if o.stage >= 2:
        return "abgeschlossen", "Gefertigt"
    if o.stage == 1:
        return "in_produktion", "In Fertigung"
    return "bestaetigt", "Bestätigt"


@router.get("/overview")
def calendar_overview(
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    """Vereinte Kalenderdaten: Kunden-/Innenaufträge, Lieferanten-ETAs, Termine & Kapazität."""
    office = floor_view.is_office(actor)

    # 1. Gesamtkapazität der aktiven Fertigungsstationen pro Werktag (Minuten)
    prod_stations = (
        db.query(FactoryStation)
        .filter(FactoryStation.active.is_(True), FactoryStation.type == FactoryStationType.production)
        .all()
    )
    daily_capacity_min = sum(float(s.capacity_min_per_day or 480.0) for s in prod_stations) or 480.0
    station_names = {s.id: s.label for s in db.query(FactoryStation).all()}

    # 2. Offene Einkaufsbestellungen (Lieferanten-Zulauf) + frühestes ETA je Werkstoff
    sups = {s.id: s for s in db.query(Supplier).all()}
    po_rows = (
        db.query(PurchaseOrder)
        .filter(PurchaseOrder.status.in_(OPEN_PO_STATUSES))
        .order_by(PurchaseOrder.id.desc())
        .limit(300)
        .all()
    )
    latest_mat_eta: dict[str, str] = {}
    inbound_pos: list[dict] = []
    for po in po_rows:
        eta_dt = po.confirmed_eta or po.requested_eta
        eta_key = _date_key(eta_dt)
        mats = sorted({ln.product_id for ln in po.lines})
        qty_sum = sum(max(0, int(ln.qty_ordered or 0) - int(ln.qty_received or 0)) for ln in po.lines)
        if eta_key:
            for m in mats:
                if m not in latest_mat_eta or eta_key > latest_mat_eta[m]:
                    latest_mat_eta[m] = eta_key
        if office:
            sup = sups.get(po.supplier_id)
            inbound_pos.append(
                {
                    "no": po.no,
                    "supplier_name": sup.name if sup else f"#{po.supplier_id}",
                    "status": po.status.value,
                    "eta_date": eta_key,
                    "materials": mats,
                    "qty_open": qty_sum,
                    "total_net": float(po.total_net or 0.0),
                }
            )

    # 3. Aufträge (mit Material-Engpasshinweis, wenn Zulauf nach Fälligkeit ankommt)
    orders = db.query(Order).order_by(Order.id.desc()).limit(600).all()
    pos_by_order: dict[int, list[OrderPosition]] = {}
    if orders:
        oids = [o.id for o in orders]
        for p in db.query(OrderPosition).filter(OrderPosition.order_id.in_(oids)).all():
            pos_by_order.setdefault(p.order_id, []).append(p)

    out_orders: list[dict] = []
    for o in orders:
        st_code, st_label = _order_status(o)
        pos_list = pos_by_order.get(o.id, [])
        due_key = _date_key(o.due_date)
        cust = ""
        if office:
            if o.kind == "internal":
                cust = o.internal_owner or "Intern"
            else:
                ship = o.ship_address or {}
                cust = ship.get("company") or ship.get("contact") or (o.user.company if o.user else "") or (o.user.name if o.user else "")

        # Geschätzte Fertigungsminuten & Material-Engpassprüfung
        est_min = max(10.0, sum(max(4.0, int(p.qty or 1) * 1.5) for p in pos_list))
        mat_risk = ""
        if due_key and o.stage < 2 and not o.cancelled_at:
            for p in pos_list:
                if p.production_status == "pending" and p.mat in latest_mat_eta and latest_mat_eta[p.mat] > due_key:
                    mat_risk = f"Zulauf {p.mat} erst am {latest_mat_eta[p.mat]}"
                    break

        out_orders.append(
            {
                "no": o.no,
                "kind": o.kind,
                "customer": cust,
                "customer_ref": o.customer_ref if office else "",
                "due_date": o.due_date.isoformat() if o.due_date else None,
                "rush": bool(o.rush),
                "gross": float(o.gross or 0.0) if office else 0.0,
                "n_positions": len(pos_list),
                "n_done": sum(1 for p in pos_list if p.production_status != "pending"),
                "est_min": round(est_min, 1),
                "material_risk": mat_risk,
                "status": st_code,
                "status_label": st_label,
                "blocked": bool(o.blocked),
                "cancelled_at": o.cancelled_at.isoformat() if o.cancelled_at else None,
                "held_at": o.held_at.isoformat() if o.held_at else None,
            }
        )

    # 4. Innenaufträge (Fertigung)
    wos = (
        db.query(WorkOrder)
        .filter(WorkOrder.status.in_((WorkOrderStatus.open, WorkOrderStatus.running, WorkOrderStatus.done)))
        .order_by(WorkOrder.id.desc())
        .limit(300)
        .all()
    )
    out_wos = [
        {
            "no": w.no,
            "mat": w.mat,
            "mat_name": w.mat_name or w.mat,
            "thk": w.thk,
            "n_plates": w.n_plates,
            "status": w.status.value,
            "due_date": _date_key(w.due_date or w.created_at),
            "planned_min": round(float(w.planned_min or (w.n_plates * 18.0)), 1),
            "station_id": w.station_id,
            "station_label": station_names.get(w.station_id, ""),
        }
        for w in wos
    ]

    # 5. Betriebstermine (Wartung, Lieferfenster, Meilensteine, Schicht)
    ev_rows = db.query(CalendarEvent).order_by(CalendarEvent.start_date.asc(), CalendarEvent.id.asc()).limit(500).all()
    out_events = [
        {
            "id": ev.id,
            "title": ev.title,
            "kind": ev.kind,
            "start_date": ev.start_date,
            "end_date": ev.end_date or ev.start_date,
            "start_time": ev.start_time,
            "end_time": ev.end_time,
            "all_day": ev.all_day,
            "colour": ev.colour,
            "station_id": ev.station_id,
            "station_label": station_names.get(ev.station_id, ""),
            "order_no": ev.order_no,
            "work_order_no": ev.work_order_no,
            "purchase_order_no": ev.purchase_order_no if office else "",
            "assigned_to": ev.assigned_to,
            "capacity_block_min": float(ev.capacity_block_min or 0.0),
            "done": bool(ev.done),
            "note": ev.note or "",
            "created_by": ev.created_by,
        }
        for ev in ev_rows
    ]

    return {
        "daily_capacity_min": round(daily_capacity_min, 1),
        "stations": [{"id": s.id, "label": s.label, "capacity_min": s.capacity_min_per_day or 480} for s in prod_stations],
        "orders": out_orders,
        "purchase_orders": inbound_pos,
        "work_orders": out_wos,
        "events": out_events,
    }


class CalendarEventIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    kind: Literal["termin", "wartung", "lieferung", "meilenstein", "schicht"] = "termin"
    start_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: str = Field(default="", max_length=10)
    start_time: str = Field(default="", max_length=8)
    end_time: str = Field(default="", max_length=8)
    all_day: bool = True
    colour: str = Field(default="#2d72d2", max_length=20)
    station_id: Optional[int] = None
    order_no: str = Field(default="", max_length=30)
    work_order_no: str = Field(default="", max_length=30)
    purchase_order_no: str = Field(default="", max_length=30)
    assigned_to: str = Field(default="", max_length=160)
    capacity_block_min: float = Field(default=0.0, ge=0, le=10_000)
    done: bool = False
    note: str = Field(default="", max_length=2000)


class CalendarEventPatch(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    kind: Optional[Literal["termin", "wartung", "lieferung", "meilenstein", "schicht"]] = None
    start_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: Optional[str] = Field(default=None, max_length=10)
    start_time: Optional[str] = Field(default=None, max_length=8)
    end_time: Optional[str] = Field(default=None, max_length=8)
    colour: Optional[str] = Field(default=None, max_length=20)
    station_id: Optional[int] = None
    assigned_to: Optional[str] = Field(default=None, max_length=160)
    capacity_block_min: Optional[float] = Field(default=None, ge=0, le=10_000)
    done: Optional[bool] = None
    note: Optional[str] = Field(default=None, max_length=2000)


@router.post("/events", status_code=status.HTTP_201_CREATED)
def create_calendar_event(
    body: CalendarEventIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    ev = CalendarEvent(
        title=body.title.strip(),
        kind=body.kind,
        start_date=body.start_date,
        end_date=body.end_date.strip() or body.start_date,
        start_time=body.start_time.strip(),
        end_time=body.end_time.strip(),
        all_day=body.all_day,
        colour=body.colour.strip() or "#2d72d2",
        station_id=body.station_id,
        order_no=body.order_no.strip(),
        work_order_no=body.work_order_no.strip(),
        purchase_order_no=body.purchase_order_no.strip(),
        assigned_to=body.assigned_to.strip(),
        capacity_block_min=body.capacity_block_min,
        done=body.done,
        note=body.note.strip(),
        created_by=actor.email,
    )
    db.add(ev)
    db.flush()
    db.add(AuditLog(actor=actor.email, action="calendar_event_create", entity="calendar_event", entity_id=str(ev.id), detail={"title": ev.title, "date": ev.start_date, "kind": ev.kind}))
    db.commit()
    db.refresh(ev)
    return {"id": ev.id, "title": ev.title, "start_date": ev.start_date, "kind": ev.kind}


@router.patch("/events/{event_id}")
def update_calendar_event(
    event_id: int,
    body: CalendarEventPatch,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    ev = db.get(CalendarEvent, event_id)
    if ev is None:
        raise HTTPException(404, "Kalendertermin nicht gefunden.")
    patch = body.model_dump(exclude_unset=True)
    for k, v in patch.items():
        if isinstance(v, str):
            v = v.strip()
        setattr(ev, k, v)
    db.add(AuditLog(actor=actor.email, action="calendar_event_update", entity="calendar_event", entity_id=str(ev.id), detail={"fields": sorted(patch.keys())}))
    db.commit()
    return {"id": ev.id, "title": ev.title, "start_date": ev.start_date, "done": ev.done}


@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_calendar_event(
    event_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> None:
    ev = db.get(CalendarEvent, event_id)
    if ev is None:
        raise HTTPException(404, "Kalendertermin nicht gefunden.")
    db.delete(ev)
    db.add(AuditLog(actor=actor.email, action="calendar_event_delete", entity="calendar_event", entity_id=str(event_id)))
    db.commit()


class RescheduleIn(BaseModel):
    entity_type: Literal["order", "purchase_order", "event"]
    entity_id: str
    target_date: Optional[str] = Field(default=None, pattern=r"^(\d{4}-\d{2}-\d{2})?$")


@router.post("/reschedule")
def reschedule_item(
    body: RescheduleIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Verschiebt Fälligkeit/Termin per Drag & Drop oder Schnellauswahl im Kalender."""
    tdate = (body.target_date or "").strip()
    target_dt = (
        datetime.combine(date.fromisoformat(tdate), time(16, 0), tzinfo=timezone.utc)
        if tdate
        else None
    )
    if body.entity_type == "order":
        row = db.query(Order).filter(Order.no == body.entity_id).first()
        if row is None:
            raise HTTPException(404, "Auftrag nicht gefunden.")
        before = _date_key(row.due_date)
        row.due_date = target_dt
        db.add(AuditLog(actor=actor.email, action="order_reschedule", entity="order", entity_id=row.no, detail={"from": before, "to": tdate or None}))
        db.commit()
        return {"ok": True, "entity_type": "order", "entity_id": row.no, "date": tdate or None}

    if body.entity_type == "purchase_order":
        if target_dt is None:
            raise HTTPException(422, "Liefertermin darf nicht leer sein.")
        po = db.query(PurchaseOrder).filter(PurchaseOrder.no == body.entity_id).first()
        if po is None:
            raise HTTPException(404, "Bestellung nicht gefunden.")
        before = _date_key(po.confirmed_eta or po.requested_eta)
        po.confirmed_eta = target_dt
        db.add(AuditLog(actor=actor.email, action="po_reschedule", entity="purchase_order", entity_id=po.no, detail={"from": before, "to": tdate}))
        db.commit()
        return {"ok": True, "entity_type": "purchase_order", "entity_id": po.no, "date": tdate}

    ev = db.get(CalendarEvent, int(body.entity_id))
    if ev is None or not tdate:
        raise HTTPException(404, "Termin nicht gefunden.")
    before = ev.start_date
    ev.start_date = tdate
    if ev.end_date < tdate:
        ev.end_date = tdate
    db.add(AuditLog(actor=actor.email, action="calendar_event_reschedule", entity="calendar_event", entity_id=str(ev.id), detail={"from": before, "to": tdate}))
    db.commit()
    return {"ok": True, "entity_type": "event", "entity_id": str(ev.id), "date": tdate}


def _ics_escape(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


@router.get("/export.ics")
def export_ics(
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> Response:
    """RFC-5545-konformer iCalendar-Export aller offenen Zusagen, Lieferungen & Betriebstermine."""
    stamp = _now().strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Gimel ERP//Master Schedule//DE",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
    ]

    for o in db.query(Order).filter(Order.cancelled_at.is_(None), Order.due_date.isnot(None)).limit(500).all():
        dkey = o.due_date.strftime("%Y%m%d")
        nxt = (o.due_date.date() + timedelta(days=1)).strftime("%Y%m%d")
        prefix = "[EIL] " if o.rush else ""
        ref_txt = o.customer_ref or "—"
        lines.extend([
            "BEGIN:VEVENT",
            f"UID:order-{o.no}@gimel.local",
            f"DTSTAMP:{stamp}",
            f"DTSTART;VALUE=DATE:{dkey}",
            f"DTEND;VALUE=DATE:{nxt}",
            f"SUMMARY:{_ics_escape(f'{prefix}Auftrag {o.no}')}",
            f"DESCRIPTION:{_ics_escape(f'Ref: {ref_txt}')}",
            "END:VEVENT",
        ])

    for po in db.query(PurchaseOrder).filter(PurchaseOrder.status.in_(OPEN_PO_STATUSES)).limit(300).all():
        eta = po.confirmed_eta or po.requested_eta
        if not eta:
            continue
        dkey = eta.strftime("%Y%m%d")
        nxt = (eta.date() + timedelta(days=1)).strftime("%Y%m%d")
        lines.extend([
            "BEGIN:VEVENT",
            f"UID:po-{po.no}@gimel.local",
            f"DTSTAMP:{stamp}",
            f"DTSTART;VALUE=DATE:{dkey}",
            f"DTEND;VALUE=DATE:{nxt}",
            f"SUMMARY:{_ics_escape(f'Wareneingang {po.no}')}",
            "END:VEVENT",
        ])

    for ev in db.query(CalendarEvent).limit(500).all():
        dkey = ev.start_date.replace("-", "")
        end_d = date.fromisoformat(ev.end_date or ev.start_date) + timedelta(days=1)
        lines.extend([
            "BEGIN:VEVENT",
            f"UID:ev-{ev.id}@gimel.local",
            f"DTSTAMP:{stamp}",
            f"DTSTART;VALUE=DATE:{dkey}",
            f"DTEND;VALUE=DATE:{end_d.strftime('%Y%m%d')}",
            f"SUMMARY:{_ics_escape(f'[{ev.kind.upper()}] {ev.title}')}",
            f"DESCRIPTION:{_ics_escape(ev.note or '')}",
            "END:VEVENT",
        ])

    lines.append("END:VCALENDAR")
    content = "\r\n".join(lines) + "\r\n"
    return Response(
        content=content.encode("utf-8"),
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="gimel-kalender.ics"'},
    )
