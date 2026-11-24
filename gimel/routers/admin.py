"""Admin-Endpunkte: Betriebsparameter, Kennzahlen, Änderungsspur."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, exists, func, or_
from sqlalchemy.orm import Session, defer

import jwt

from ..config import get_settings
from ..db import SessionLocal, chunked_in, get_db
from ..models import (
    AuditLog,
    LibraryShape,
    NestRun,
    Offcut,
    Order,
    OrderPosition,
    PortalSync,
    Product,
    Role,
    Setting,
    Shipment,
    ShipmentItem,
    ShipmentStatus,
    User,
    WorkItem,
    WorkOrder,
    WorkOrderStatus,
    WorkPlate,
)
from ..schemas import AuditOut
from ..security import require_admin, require_staff, require_worker
from ..services import floor_view, identity, order_flow, settings_store
from ..services.events import bus
from ..services.inventory import move_stock
from ..services.orders import search_filter
from ..services.work_orders import cancel_work_order

log = logging.getLogger("gimel.admin")
router = APIRouter(prefix="/api/admin", tags=["admin"])


SCOPE_SSE = "sse"
SSE_TICKET_SECONDS = 60


@router.post("/events/ticket")
def sse_ticket(actor: Annotated[User, Depends(require_worker)]):
    """Ein Einmal-Ticket für den Ereignisstrom, eine Minute gültig.

    EventSource kann keinen Authorization-Kopf schicken. Das Zugangstoken in
    die Adresszeile zu legen hieße, es eine halbe Stunde lang in Protokolle
    und Verläufe zu schreiben; das Ticket taugt nur für diesen Strom
    (``current_user`` lehnt jeden anderen Bereich ab) und ist nach einer
    Minute wertlos. Geprüft wird es beim Verbindungsaufbau.
    """
    now = datetime.now(timezone.utc)
    ticket = jwt.encode({"sub": str(actor.id), "scope": SCOPE_SSE, "iat": now,
                         "exp": now + timedelta(seconds=SSE_TICKET_SECONDS)},
                        get_settings().secret_key, algorithm="HS256")
    return {"ticket": ticket, "expires_in": SSE_TICKET_SECONDS}


def _check_sse_ticket(ticket: str) -> bool:
    """Prüft das Ticket; gibt zurück, ob der Hörer zum Büro gehört (Rolle aus der DB, nicht aus dem Ticket)."""
    try:
        payload = jwt.decode(ticket, get_settings().secret_key, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Ticket ungültig oder abgelaufen.")
    if payload.get("scope") != SCOPE_SSE:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Dieses Token öffnet den Ereignisstrom nicht.")
    with SessionLocal() as db:  # kurz: die Verbindung lebt lange, die DB-Sitzung nicht
        user = db.get(User, int(payload.get("sub", 0)))
        if not user or not user.active or user.role not in (Role.worker, Role.staff, Role.admin):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Für diese Aktion fehlt die Berechtigung.")
        return floor_view.is_office(user)


@router.get("/events")
async def sse_events(request: Request, ticket: str = Query(default="", max_length=2000)):
    """Server-Sent Events Stream für Echtzeit-Aktualisierung im Admin-Panel (Ticket: POST /events/ticket)."""
    office = _check_sse_ticket(ticket)
    q = bus.subscribe()

    def for_listener(payload: str) -> str:
        # Der Strom geht an Büro und Halle zugleich; die Halle bekommt kein
        # Betrag- oder Kundenfeld (services/floor_view.py).
        if office:
            return payload
        try:
            msg = json.loads(payload)
        except ValueError:
            return ""  # unlesbar: lieber nichts als ungefiltert
        msg["data"] = floor_view.scrub(msg.get("data") or {}, False)
        return json.dumps(msg)

    async def event_generator():
        try:
            yield "event: ping\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=10.0)
                    out = for_listener(payload)
                    if out:
                        yield f"data: {out}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class SettingOut(BaseModel):
    key: str
    value: str
    note: str = ""
    updated_at: Optional[datetime] = None
    updated_by: str = ""


class SettingIn(BaseModel):
    value: str = Field(max_length=400)


# Grenzen für die Betriebsparameter. Ein Tippfehler hier hält entweder die
# Fertigung an oder kippt sie voll — beides fällt erst auf, wenn es zu spät ist,
# also fällt es hier auf.
def _number(value: str, what: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail=f"{what} muss eine Zahl sein.")


def _check_setting(key: str, value: str) -> None:
    if key == "batch_interval_minutes":
        # Unter einer Minute bringt kein Sammeln mehr etwas — dann schneidet
        # jeder Auftrag wieder für sich, und genau das soll der Takt vermeiden.
        if not (1 <= _number(value, "Der Takt") <= 7 * 24 * 60):
            raise HTTPException(
                status_code=422,
                detail="Takt zwischen 1 Minute und 7 Tagen (10080 Minuten).",
            )
    elif key == "batch_mode":
        if value.strip().lower() not in ("sammel", "sofort"):
            raise HTTPException(
                status_code=422, detail="Betriebsart ist „sammel“ oder „sofort“."
            )
    elif key == "batch_group_by":
        if value.strip().lower() not in ("material", "customer"):
            raise HTTPException(
                status_code=422, detail="Schachtelgruppe ist „material“ oder „customer“."
            )
    elif key == "batch_min_parts":
        if not (1 <= _number(value, "Die Teilezahl") <= 10000):
            raise HTTPException(
                status_code=422, detail="Teilezahl zwischen 1 und 10000."
            )
    elif key == "batch_min_utilisation":
        v = _number(value, "Die Plattenbelegung")
        if not (0.0 <= v <= 1.0):
            raise HTTPException(
                status_code=422,
                detail="Plattenbelegung als Anteil zwischen 0 und 1 "
                "(0,70 = ab 70 % der Plattenhöhe schneiden).",
            )
    elif key == "batch_max_age_minutes":
        if not (0 <= _number(value, "Die Wartezeit") <= 60 * 24 * 30):
            raise HTTPException(
                status_code=422, detail="Wartezeit zwischen 0 Minuten und 30 Tagen."
            )
    elif key == "batch_due_lead_hours":
        if not (0 <= _number(value, "Der Vorlauf") <= 24 * 30):
            raise HTTPException(
                status_code=422, detail="Vorlauf zwischen 0 Stunden und 30 Tagen."
            )
    elif key == "batch_max_plates_per_run":
        if not (0 <= _number(value, "Der Plattendeckel") <= 500):
            raise HTTPException(
                status_code=422, detail="Plattendeckel zwischen 0 (aus) und 500."
            )
    elif key == "batch_max_orders_per_work_order":
        if not (0 <= _number(value, "Die Auftragsgrenze") <= 100):
            raise HTTPException(
                status_code=422,
                detail="Aufträge je Innenauftrag zwischen 0 (aus) und 100.",
            )
    elif key == "batch_max_plates_per_work_order":
        if not (0 <= _number(value, "Der Plattendeckel je IA") <= 200):
            raise HTTPException(
                status_code=422,
                detail="Platten je Innenauftrag zwischen 0 (aus) und 200.",
            )
    elif key in ("nest_gap_mm", "nest_margin_mm"):
        # Leer heißt „erben" — Kerf bzw. Steg des Werkstoffs, sonst der
        # Kalkulationssatz. Das ist etwas anderes als 0 und muss es bleiben.
        if value.strip() == "":
            return
        limit = 200 if key == "nest_gap_mm" else 300
        if not (0 <= _number(value, "Der Abstand") <= limit):
            raise HTTPException(
                status_code=422,
                detail=f"Wert zwischen 0 und {limit} mm — oder leer für "
                "den Wert des Werkstoffs.",
            )
    elif key in ("nest_trim_w_mm", "nest_trim_h_mm"):
        if not (0 <= _number(value, "Der Beschnitt") <= 500):
            raise HTTPException(
                status_code=422, detail="Beschnitt zwischen 0 und 500 mm."
            )
    elif key == "nest_max_ms":
        # Leer heißt „ohne Notbremse" und ist etwas anderes als 0.
        if value.strip() == "":
            return
        if not (10 <= _number(value, "Die Rechenzeit") <= 600_000):
            raise HTTPException(
                status_code=422,
                detail="Rechenzeit zwischen 10 und 600.000 ms — oder leer "
                "für ohne Notbremse.",
            )
    elif key == "nest_max_candidates":
        if value.strip() == "":
            return
        if not (1 <= _number(value, "Die Kandidatenzahl") <= 5):
            raise HTTPException(
                status_code=422,
                detail="Zwischen 1 und 5 Saatordnungen — oder leer für die "
                "Vorgabe des Rechenkerns.",
            )
    elif key == "nest_corner_max_mm":
        if value.strip() == "":
            return
        if not (50 <= _number(value, "Der Eckabstand") <= 10_000):
            raise HTTPException(
                status_code=422,
                detail="Eckabstand zwischen 50 und 10.000 mm — oder leer "
                "für keine Schranke.",
            )
    elif key == "nesting_engine":
        if value.strip().lower() not in ("lite", "kerf", "gre"):
            raise HTTPException(
                status_code=422,
                detail="Schachtel-Motor ist „kerf“, „lite“ oder „gre“.",
            )
    elif key in ("nest_allow_rotation", "nest_allow_mirror", "nest_kerf_refine"):
        if value.strip().lower() not in ("true", "false", "1", "0", "yes", "no", "ja", "nein"):
            raise HTTPException(
                status_code=422,
                detail="Der Schalter ist „true“ oder „false“.",
            )
    elif key == "nest_kerf_steps":
        if value.strip() == "":
            return
        if not (4 <= _number(value, "Die Schrittzahl") <= 5000):
            raise HTTPException(
                status_code=422,
                detail="Kerf-Schritte zwischen 4 und 5000 — oder leer für die "
                "Schätzung aus der Arbeitsmenge.",
            )
    elif key == "nest_kerf_stall":
        if not (0 <= _number(value, "Die Stillstands-Schritte") <= 5000):
            raise HTTPException(
                status_code=422,
                detail="Stillstands-Schritte zwischen 0 (aus) und 5000.",
            )
    elif key == "nest_kerf_cell":
        if value.strip() == "":
            return
        if not (0.25 <= _number(value, "Die Rasterweite") <= 100):
            raise HTTPException(
                status_code=422,
                detail="Rasterweite zwischen 0,25 und 100 mm — oder leer für "
                "die automatische Wahl.",
            )
    elif key == "nest_kerf_gravity":
        if value.strip().lower() not in ("top", "left"):
            raise HTTPException(
                status_code=422,
                detail="Füllrichtung ist „top“ (obere Kante) oder „left“ (linke Kante).",
            )
    elif key == "nest_kerf_seed":
        if not (1 <= _number(value, "Der Startwert") <= 4_294_967_295):
            raise HTTPException(
                status_code=422,
                detail="Startwert zwischen 1 und 4.294.967.295.",
            )
    elif key == "delivery_days":
        if not (0 <= _number(value, "Die Lieferzeit") <= 60):
            raise HTTPException(
                status_code=422, detail="Lieferzeit zwischen 0 und 60 Werktagen."
            )
    elif key.endswith("_prefix"):
        if not (1 <= len(value.strip()) <= 20):
            raise HTTPException(
                status_code=422, detail="Präfix zwischen 1 und 20 Zeichen."
            )
    elif key == "limit_max_od":
        if value.strip() == "":
            return
        v = _number(value, "Der Maximaldurchmesser")
        if v <= 0:
            raise HTTPException(
                status_code=422,
                detail="Maximaldurchmesser muss größer als 0 sein — oder leer für keine Beschränkung.",
            )
    elif key == "limit_min_od":
        if value.strip() == "":
            return
        v = _number(value, "Der Minimaldurchmesser")
        if v <= 0:
            raise HTTPException(
                status_code=422,
                detail="Minimaldurchmesser muss größer als 0 sein — oder leer für keine Beschränkung.",
            )
    elif key == "limit_min_web":
        if value.strip() == "":
            return
        v = _number(value, "Der Mindeststeg")
        if v < 0:
            raise HTTPException(
                status_code=422,
                detail="Mindeststeg darf nicht negativ sein — oder leer für den Steg des Werkstoffs.",
            )
    elif key == "limit_min_corner":
        if value.strip() == "":
            return
        v = _number(value, "Der Mindesteckabstand")
        if v < 0:
            raise HTTPException(
                status_code=422,
                detail="Mindesteckabstand darf nicht negativ sein — oder leer = 0.",
            )
    elif key == "limit_max_plate_w":
        if value.strip() == "":
            return
        v = _number(value, "Die Maximalplattenbreite")
        if v <= 0:
            raise HTTPException(
                status_code=422,
                detail="Plattenbreite muss größer als 0 sein — oder leer für keinen Deckel.",
            )
    elif key == "limit_max_plate_h":
        if value.strip() == "":
            return
        v = _number(value, "Die Maximalplattenhöhe")
        if v <= 0:
            raise HTTPException(
                status_code=422,
                detail="Plattenhöhe muss größer als 0 sein — oder leer für keinen Deckel.",
            )


@router.get(
    "/settings", response_model=list[SettingOut], dependencies=[Depends(require_staff)]
)
def list_settings(db: Annotated[Session, Depends(get_db)]) -> list[SettingOut]:
    settings_store.ensure_defaults(db)
    rows = db.query(Setting).filter(~Setting.key.startswith(identity.PREFIX)).order_by(Setting.key).all()
    return [
        SettingOut(
            key=r.key,
            value=r.value,
            note=r.note,
            updated_at=r.updated_at,
            updated_by=r.updated_by,
        )
        for r in rows
    ]


@router.put("/settings/{key}", response_model=SettingOut)
def set_setting(
    key: str,
    body: SettingIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_admin)],
) -> SettingOut:
    if key not in settings_store.DEFAULTS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unbekannter Parameter „{key}“.",
        )
    _check_setting(key, body.value)
    row = settings_store.set_value(db, key, body.value, actor.email)
    db.add(
        AuditLog(
            actor=actor.email,
            action="setting_update",
            entity="setting",
            entity_id=key,
            detail={"value": body.value},
        )
    )
    db.commit()
    db.refresh(row)
    bus.publish("setting_update", {"key": key, "value": body.value})
    return SettingOut(
        key=row.key,
        value=row.value,
        note=row.note,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
    )


@router.get(
    "/audit", response_model=list[AuditOut], dependencies=[Depends(require_staff)]
)
def audit(
    db: Annotated[Session, Depends(get_db)],
    action: Optional[str] = None,
    actor: Optional[str] = Query(default=None, max_length=254),
    entity: Optional[str] = Query(default=None, max_length=60),
    entity_id: Optional[str] = Query(default=None, max_length=80),
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    before_id: Optional[int] = Query(default=None, ge=1),
    limit: int = Query(default=100, ge=1, le=1000),
) -> list[AuditLog]:
    """Protokoll, neueste zuerst — gefiltert und blätterbar.

    Bis 2026-10 gab es nur ``action`` und ``limit``: ältere als die neuesten
    1000 Einträge waren über die Oberfläche nicht erreichbar, und die Suche lief
    nur über das Geladene. ``before_id`` blättert weiter (die id der letzten
    Zeile der vorigen Seite).
    """
    q = db.query(AuditLog)
    if action:
        q = q.filter(AuditLog.action == action)
    if actor:
        q = q.filter(AuditLog.actor.ilike(f"%{actor.strip()}%"))
    if entity:
        q = q.filter(AuditLog.entity == entity)
    if entity_id:
        q = q.filter(AuditLog.entity_id == entity_id)
    if since:
        q = q.filter(AuditLog.at >= since)
    if until:
        q = q.filter(AuditLog.at <= until)
    if before_id:
        q = q.filter(AuditLog.id < before_id)
    return q.order_by(AuditLog.id.desc()).limit(limit).all()


@router.get("/audit/actions", dependencies=[Depends(require_staff)])
def audit_actions(db: Annotated[Session, Depends(get_db)]) -> list[dict]:
    """Alle vorkommenden Aktionen mit Anzahl — für die Filterchips, auch für seltene und alte."""
    rows = (db.query(AuditLog.action, func.count(AuditLog.id))
              .group_by(AuditLog.action).order_by(AuditLog.action).all())
    return [{"action": a, "count": int(n)} for a, n in rows]


@router.get("/stats", dependencies=[Depends(require_staff)])
def stats(db: Annotated[Session, Depends(get_db)]) -> dict:
    """Kennzahlen fürs Admin-Panel — bewusst wenige und alle handlungsrelevant."""
    since = datetime.now(timezone.utc) - timedelta(days=30)
    run_cnt, solo_sum, batch_sum = (
        db.query(
            func.count(NestRun.id),
            func.coalesce(func.sum(NestRun.solo_area_m2), 0.0),
            func.coalesce(func.sum(NestRun.batch_area_m2), 0.0),
        )
        .filter(NestRun.started_at >= since)
        .one()
    )
    solo = float(solo_sum or 0.0)
    batch = float(batch_sum or 0.0)
    user_total, user_active, user_admins = (
        db.query(
            func.count(User.id),
            func.coalesce(func.sum(case((User.active.is_(True), 1), else_=0)), 0),
            func.coalesce(func.sum(case((User.role == Role.admin, 1), else_=0)), 0),
        ).one()
    )
    order_total, order_blocked = (
        db.query(
            func.count(Order.id),
            func.coalesce(func.sum(case((Order.blocked.is_(True), 1), else_=0)), 0),
        ).one()
    )
    pos_pending, pos_manual = (
        db.query(
            func.coalesce(func.sum(case((OrderPosition.production_status == "pending", 1), else_=0)), 0),
            func.coalesce(func.sum(case((OrderPosition.production_status == "manual", 1), else_=0)), 0),
        )
        .join(Order, OrderPosition.order_id == Order.id)
        .filter(Order.cancelled_at.is_(None))
        .filter(OrderPosition.production_status.in_(("pending", "manual")))
        .one()
    )
    wo_open, wo_running = (
        db.query(
            func.coalesce(func.sum(case((WorkOrder.status == WorkOrderStatus.open, 1), else_=0)), 0),
            func.coalesce(func.sum(case((WorkOrder.status == WorkOrderStatus.running, 1), else_=0)), 0),
        )
        .filter(WorkOrder.status.in_((WorkOrderStatus.open, WorkOrderStatus.running)))
        .one()
    )
    if db.bind is not None and db.bind.dialect.name == "sqlite":
        unverified_price = (
            db.query(func.count(Product.id))
            .filter(Product.active.is_(True))
            .filter(func.json_extract(Product.verified, "$.price").is_(None))
            .scalar()
        )
    else:
        unverified_price = sum(
            1
            for (v,) in db.query(Product.verified).filter(Product.active.is_(True)).all()
            if (v or {}).get("price") is None
        )
    return {
        "users": int(user_total or 0),
        "users_active": int(user_active or 0),
        "admins": int(user_admins or 0),
        "products": db.query(func.count(Product.id))
        .filter(Product.active.is_(True))
        .scalar()
        or 0,
        "orders": int(order_total or 0),
        "orders_blocked": int(order_blocked or 0),
        # Übernahmen aus dem Bestellportal — die Brücke (server/bridge.mjs)
        # legt zu jeder bezahlten Zahlung genau diese eine Zeile an.
        "orders_portal": db.query(func.count(PortalSync.id)).scalar() or 0,
        "last_portal_sync_at": db.query(func.max(PortalSync.created_at)).scalar(),
        "positions_pending": int(pos_pending or 0),
        "positions_manual": int(pos_manual or 0),
        "work_orders_open": int(wo_open or 0),
        "work_orders_running": int(wo_running or 0),
        "runs_30d": int(run_cnt or 0),
        # Der Beleg für die Sammelschachtelung: wie viel Plattenfläche das
        # Zusammenlegen gegenüber getrennter Fertigung gespart hat.
        "saved_area_m2_30d": round(max(0.0, solo - batch), 3),
        "saved_pct_30d": round((solo - batch) / solo * 100, 1) if solo else 0.0,
        "unverified_prices": unverified_price or 0,
    }


@router.get("/dimension-limits", dependencies=[Depends(require_worker)])
def get_dimension_limits(db: Annotated[Session, Depends(get_db)]) -> dict:
    """Die aktuellen Maßbeschränkungen als Schlüssel-Wert-Paar."""
    keys = [
        "limit_max_od",
        "limit_min_od",
        "limit_min_web",
        "limit_min_corner",
        "limit_max_plate_w",
        "limit_max_plate_h",
    ]
    return {k: settings_store.get(db, k, "") for k in keys}


# --------------------------------------------------------------------------
# Kundenaufträge — die Übersicht für Vertrieb und Fertigung
# --------------------------------------------------------------------------


class OrderListItem(BaseModel):
    id: int
    no: str
    kind: str = "external"
    internal_owner: str = ""
    customer: str = ""
    customer_ref: str = ""
    created_at: Optional[datetime] = None
    net: float = 0.0
    gross: float = 0.0
    paid: bool = False
    paid_at: Optional[datetime] = None
    payment_method: str = ""
    invoice_no: str = ""
    invoiced_at: Optional[datetime] = None
    invoice_due_at: Optional[datetime] = None
    released: bool = True
    blocked: bool = False
    rush: bool = False
    due_date: Optional[datetime] = None
    n_positions: int = 0
    n_done: int = 0
    n_manual: int = 0
    work_orders: list[dict] = []
    shipments: list[dict] = []
    status: str = "wartet"
    status_label: str = "Wartend"
    #: Lebenslauf (Aufgabe 45): angehalten / storniert mit Grund.
    held_at: Optional[datetime] = None
    hold_reason: str = ""
    cancelled_at: Optional[datetime] = None
    cancel_reason: str = ""


class OrderListResponse(BaseModel):
    items: list[OrderListItem]
    total: int
    has_more: bool = False
    next_cursor: Optional[str] = None


def _order_status_exprs():
    """SQL-Ausdrücke für die abgeleiteten Auftragszustände (identisch zur Listenlogik).

    Verwendet korrelierte EXISTS-Unterabfragen auf indizierten Fremdschlüsseln,
    damit Statusfilter, Gesamtzahl und Pipeline-Summen bei Millionen Aufträgen
    vollständig in SQL vor LIMIT/OFFSET laufen.
    """
    has_delivered = exists().where(
        ShipmentItem.order_id == Order.id,
        ShipmentItem.shipment_id == Shipment.id,
        Shipment.status == ShipmentStatus.delivered,
    )
    has_active_ship = exists().where(
        ShipmentItem.order_id == Order.id,
        ShipmentItem.shipment_id == Shipment.id,
        Shipment.status.in_((ShipmentStatus.shipped, ShipmentStatus.packing)),
    )
    has_any_ship = exists().where(ShipmentItem.order_id == Order.id)
    has_producible = exists().where(
        OrderPosition.order_id == Order.id,
        OrderPosition.kind == "gasket",
        OrderPosition.production_status != "manual",
    )
    has_incomplete_producible = exists().where(
        OrderPosition.order_id == Order.id,
        OrderPosition.kind == "gasket",
        OrderPosition.production_status.notin_(("manual", "done")),
    )
    all_producible_done = and_(has_producible, ~has_incomplete_producible)
    is_internal = Order.kind == "internal"
    has_work = exists().where(
        OrderPosition.order_id == Order.id,
        WorkItem.position_id == OrderPosition.id,
    )
    has_batched_or_partial = exists().where(
        OrderPosition.order_id == Order.id,
        or_(
            OrderPosition.production_status == "batched",
            and_(OrderPosition.kind == "gasket", OrderPosition.production_status == "done"),
        ),
    )

    not_cancelled = Order.cancelled_at.is_(None)
    not_blocked = Order.blocked.is_(False)
    is_storniert = Order.cancelled_at.isnot(None)
    is_abgeschlossen = and_(
        not_cancelled,
        not_blocked,
        or_(has_delivered, and_(~has_active_ship, is_internal, all_producible_done)),
    )
    is_versand = and_(
        not_cancelled,
        not_blocked,
        ~has_delivered,
        or_(has_active_ship, and_(~is_internal, all_producible_done, has_any_ship)),
    )
    is_versandbereit = and_(
        not_cancelled,
        not_blocked,
        ~has_any_ship,
        ~is_internal,
        all_producible_done,
    )
    is_terminal_or_ship = or_(is_storniert, is_abgeschlossen, is_versand, is_versandbereit)
    is_angehalten = and_(not_cancelled, Order.held_at.isnot(None), ~is_terminal_or_ship)
    not_held_or_done = and_(not_cancelled, ~is_terminal_or_ship, Order.held_at.is_(None))
    is_gesperrt = and_(not_held_or_done, Order.blocked.is_(True))
    is_in_produktion = and_(
        not_held_or_done,
        not_blocked,
        or_(has_work, has_batched_or_partial),
    )
    is_freigegeben = and_(
        not_held_or_done,
        not_blocked,
        ~has_work,
        ~has_batched_or_partial,
        Order.released.is_(True),
    )
    is_wartet = and_(
        not_held_or_done,
        not_blocked,
        ~has_work,
        ~has_batched_or_partial,
        Order.released.is_(False),
    )
    return {
        "storniert": is_storniert,
        "angehalten": is_angehalten,
        "gesperrt": is_gesperrt,
        "abgeschlossen": is_abgeschlossen,
        "versand": is_versand,
        "versandbereit": is_versandbereit,
        "in_produktion": is_in_produktion,
        "freigegeben": is_freigegeben,
        "wartet": is_wartet,
        "offen": and_(not_cancelled, ~is_abgeschlossen),
    }


def _apply_due_filter(q_filter, due: str, now: datetime):
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow_start = today_start + timedelta(days=1)
    week_end = today_start + timedelta(days=7)
    exprs = _order_status_exprs()
    if due == "overdue":
        return q_filter.filter(
            exprs["offen"],
            Order.due_date.isnot(None),
            Order.due_date < now,
        )
    if due == "today":
        return q_filter.filter(
            Order.due_date.isnot(None),
            Order.due_date >= today_start,
            Order.due_date < tomorrow_start,
        )
    if due == "week":
        return q_filter.filter(
            Order.due_date.isnot(None),
            Order.due_date >= now,
            Order.due_date <= week_end,
        )
    if due == "none":
        return q_filter.filter(Order.due_date.is_(None))
    return q_filter


@router.get("/orders/summary", dependencies=[Depends(require_worker)])
def orders_summary(
    actor: Annotated[User, Depends(require_worker)],
    db: Annotated[Session, Depends(get_db)],
    q: str = Query(default=""),
) -> dict:
    """Pipeline- und Statuszählung über ALLE passenden Aufträge direkt in SQL.

    Verhindert, dass das Portal hunderte oder tausende Aufträge laden muss, nur um
    Eingang/Fertigung/Versand/Überfällig-Karten anzuzeigen.
    """
    office = actor.role in (Role.staff, Role.admin)
    exprs = _order_status_exprs()
    now = datetime.now(timezone.utc)
    overdue_expr = and_(exprs["offen"], Order.due_date.isnot(None), Order.due_date < now)
    query = db.query(
        func.count(Order.id),
        func.coalesce(func.sum(case((exprs["offen"], 1), else_=0)), 0),
        func.coalesce(func.sum(case((overdue_expr, 1), else_=0)), 0),
        func.coalesce(func.sum(case((exprs["wartet"], 1), else_=0)), 0),
        func.coalesce(func.sum(case((exprs["freigegeben"], 1), else_=0)), 0),
        func.coalesce(func.sum(case((exprs["in_produktion"], 1), else_=0)), 0),
        func.coalesce(func.sum(case((exprs["versandbereit"], 1), else_=0)), 0),
        func.coalesce(func.sum(case((exprs["versand"], 1), else_=0)), 0),
        func.coalesce(func.sum(case((exprs["abgeschlossen"], 1), else_=0)), 0),
        func.coalesce(func.sum(case((exprs["gesperrt"], 1), else_=0)), 0),
        func.coalesce(func.sum(case((exprs["angehalten"], 1), else_=0)), 0),
        func.coalesce(func.sum(case((exprs["storniert"], 1), else_=0)), 0),
        func.coalesce(func.sum(case((and_(exprs["offen"], Order.rush.is_(True)), 1), else_=0)), 0),
    )
    if q.strip():
        query = query.filter(search_filter(db, q, office=office))
    row = query.one()
    (
        total, open_cnt, overdue, wartet, freigegeben, in_prod,
        versandbereit, versand, abgeschlossen, gesperrt, angehalten, storniert, eilig,
    ) = (int(v or 0) for v in row)
    return {
        "total": total,
        "open": open_cnt,
        "overdue": overdue,
        "eingang": wartet + gesperrt + angehalten,
        "wartet": wartet,
        "freigegeben": freigegeben,
        "fertigung": in_prod,
        "in_produktion": in_prod,
        "versandbereit": versandbereit,
        "versand": versand,
        "fertig": abgeschlossen,
        "abgeschlossen": abgeschlossen,
        "gesperrt": gesperrt,
        "angehalten": angehalten,
        "storniert": storniert,
        "eilig": eilig,
    }


@router.get(
    "/orders", response_model=OrderListResponse, dependencies=[Depends(require_worker)]
)
def list_orders(
    actor: Annotated[User, Depends(require_worker)],
    db: Annotated[Session, Depends(get_db)],
    q: str = Query(default=""),
    order_status: str = Query(default="all", alias="status"),
    due: str = Query(default="all"),
    sort: str = Query(default="created"),
    sort_dir: str = Query(default="desc"),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> OrderListResponse:
    """Alle Kundenaufträge mit Traceability zu Innenaufträgen.

    Filter, Sortierung, Zählung und Paginierung (Offset oder Keyset-Cursor)
    laufen vollständig in SQL — tauglich für Millionen Aufträge.
    """
    # Die Rolle ``worker`` sieht keine Preise (models.py): Geld, Zahlung und Rechnung
    # bleiben für sie leer, auch wenn die Felder im Schema stehen.
    office = actor.role in (Role.staff, Role.admin)
    q_filter = db.query(Order).options(
        defer(Order.bill_address),
        defer(Order.office_note),
        defer(Order.manual_shipment),
        defer(Order.price_breakdown),
        defer(Order.price_check),
        defer(Order.tax_status),
    )
    if q.strip():
        q_filter = q_filter.filter(search_filter(db, q, office=office))

    alias = {
        "new": "wartet",
        "in_production": "in_produktion",
        "done": "abgeschlossen",
        "blocked": "gesperrt",
        "shipped": "versand",
        "eingang": "eingang",
        "fertigung": "in_produktion",
        "fertig": "abgeschlossen",
    }
    want = alias.get(order_status, order_status)
    exprs = _order_status_exprs()
    now = datetime.now(timezone.utc)
    if want != "all":
        if want == "versand":
            q_filter = q_filter.filter(or_(exprs["versand"], exprs["versandbereit"]))
        elif want == "eingang":
            q_filter = q_filter.filter(or_(exprs["wartet"], exprs["gesperrt"], exprs["angehalten"]))
        elif want == "eilig":
            q_filter = q_filter.filter(exprs["offen"], Order.rush.is_(True))
        elif want == "ueberfaellig":
            q_filter = q_filter.filter(exprs["offen"], Order.due_date.isnot(None), Order.due_date < now)
        elif want == "bezahlt" and office:
            q_filter = q_filter.filter(Order.paid.is_(True))
        elif want == "unbezahlt" and office:
            q_filter = q_filter.filter(Order.paid.is_(False), Order.cancelled_at.is_(None))
        elif want == "ohne_rechnung" and office:
            q_filter = q_filter.filter(or_(Order.invoice_no.is_(None), Order.invoice_no == ""), Order.cancelled_at.is_(None))
        elif want == "rechnung_offen" and office:
            q_filter = q_filter.filter(Order.invoice_no != "", Order.paid.is_(False), Order.cancelled_at.is_(None))
        elif want in exprs:
            q_filter = q_filter.filter(exprs[want])

    if due and due != "all":
        q_filter = _apply_due_filter(q_filter, due, now)

    total = int(q_filter.count() or 0)

    # Sortierung (indizierte Spalten) + Keyset-Cursor für Standard-Sortierung created DESC
    asc = sort_dir.lower() == "asc"
    sort_cols = {
        "created": Order.created_at,
        "no": Order.no,
        "due": Order.due_date,
        "gross": Order.gross if office else Order.created_at,
        "customer": Order.customer_ref if office else Order.no,
    }
    col = sort_cols.get(sort, Order.created_at)
    use_keyset = bool(cursor) and sort == "created" and not asc
    if use_keyset and cursor:
        try:
            c_id = int(cursor)
            q_filter = q_filter.filter(Order.id < c_id)
        except ValueError:
            use_keyset = False

    if asc:
        order_clauses = (col.asc(), Order.id.asc())
    else:
        order_clauses = (col.desc(), Order.id.desc())

    page_q = q_filter.order_by(*order_clauses)
    if not use_keyset and offset:
        page_q = page_q.offset(offset)
    rows_plus = page_q.limit(limit + 1).all()
    has_more = len(rows_plus) > limit
    orders = rows_plus[:limit]
    next_cursor = str(orders[-1].id) if (has_more and orders and sort == "created" and not asc) else None

    # Positionen und Work-Item-Zuordnungen vorladen (ohne schwere Kontur-/Notiz-Blobs)
    order_ids = [o.id for o in orders]
    positions = (
        db.query(OrderPosition)
        .options(
            defer(OrderPosition.shape),
            defer(OrderPosition.note),
            defer(OrderPosition.external_note),
            defer(OrderPosition.label),
        )
        .filter(chunked_in(OrderPosition.order_id, order_ids))
        .all()
        if order_ids
        else []
    )
    pos_by_order: dict[int, list[OrderPosition]] = {}
    for p in positions:
        pos_by_order.setdefault(p.order_id, []).append(p)

    pos_ids = [p.id for p in positions]
    work_items = (
        db.query(WorkItem.position_id, WorkItem.work_order_id)
        .filter(chunked_in(WorkItem.position_id, pos_ids))
        .all()
        if pos_ids
        else []
    )
    # Innenaufträge laden für die Zuordnung. ``WorkItem.order_no`` ist der
    # Kundenauftrag; der Innenauftrag hängt an ``work_order_id``.
    work_orders_by_id: dict[int, WorkOrder] = {}
    wo_ids = {wi.work_order_id for wi in work_items}
    if wo_ids:
        work_orders_by_id = {
            wo.id: wo
            for wo in db.query(WorkOrder)
            .options(defer(WorkOrder.auto_layout), defer(WorkOrder.nest_options), defer(WorkOrder.order_done))
            .filter(chunked_in(WorkOrder.id, wo_ids))
            .all()
        }
    wo_nos_by_pos: dict[int, set[str]] = {}
    for wi in work_items:
        wo = work_orders_by_id.get(wi.work_order_id)
        if wo:
            wo_nos_by_pos.setdefault(wi.position_id, set()).add(wo.no)
    work_orders_map: dict[str, dict] = {
        wo.no: {"no": wo.no, "mat": wo.mat_name or wo.mat, "status": wo.status.value}
        for wo in work_orders_by_id.values()
    }

    # Versand-Status: hat der Auftrag ShipmentItems?
    ship_items = (
        db.query(ShipmentItem.order_id, ShipmentItem.shipment_id)
        .filter(chunked_in(ShipmentItem.order_id, order_ids))
        .all()
        if order_ids
        else []
    )
    ship_by_order: dict[int, list] = {}
    for si in ship_items:
        ship_by_order.setdefault(si.order_id, []).append(si)
    ship_ids = {si.shipment_id for si in ship_items}
    shipments_map = (
        {
            s.id: s
            for s in db.query(Shipment)
            .options(defer(Shipment.ship_to))
            .filter(chunked_in(Shipment.id, ship_ids))
            .all()
        }
        if ship_ids
        else {}
    )

    user_ids = {o.user_id for o in orders if o.user_id}
    users_by_id = (
        {
            u.id: u
            for u in db.query(User)
            .filter(chunked_in(User.id, user_ids))
            .all()
        }
        if user_ids
        else {}
    )

    items = []
    for o in orders:
        ship = o.ship_address or {}
        internal = (o.kind or "external") == "internal"
        u = users_by_id.get(o.user_id) if o.user_id else None
        raw_customer = (
            ship.get("company")
            or ship.get("contact")
            or (u.company if u else "")
            or (u.name if u else "")
            or (u.email if u else "")
            or ""
        )
        # Halle: kein Kundenname (services/floor_view.py); intern bleibt der Verantwortliche.
        customer = (
            o.internal_owner
            if internal
            else floor_view.customer_name(raw_customer, office)
        )
        o_positions = pos_by_order.get(o.id, [])

        wo_set: set[str] = set()
        for p in o_positions:
            wo_set |= wo_nos_by_pos.get(p.id, set())
        work_orders = [
            work_orders_map[n] for n in sorted(wo_set) if n in work_orders_map
        ]

        n_done = sum(1 for p in o_positions if p.production_status == "done")
        n_batched = sum(1 for p in o_positions if p.production_status == "batched")
        n_manual = sum(1 for p in o_positions if p.production_status == "manual")
        gasket_positions = [p for p in o_positions if p.kind == "gasket"]
        # Anfrage-Positionen (manual) werden von Hand gefertigt und erreichen
        # nie „done" — sie zählen nicht zum fertigbaren Rest, sonst hinge ein
        # Auftrag mit Zeichnungsposition ewig unter „versandbereit".
        producible = [p for p in gasket_positions if p.production_status != "manual"]
        n_producible = len(producible)
        n_producible_done = sum(1 for p in producible if p.production_status == "done")
        has_work = bool(wo_set)
        has_running = any(
            work_orders_map[n].get("status") == "running"
            for n in wo_set
            if n in work_orders_map
        )

        # shipments for this order
        my_ships = []
        for si in ship_by_order.get(o.id, []):
            s = shipments_map.get(si.shipment_id)
            if s:
                my_ships.append(
                    {
                        "no": s.no,
                        "status": s.status.value,
                        "carrier": s.carrier,
                        "tracking": s.tracking,
                    }
                )
        # dedup by shipment no
        uniq_ships = {s["no"]: s for s in my_ships}.values()
        my_ships = list(uniq_ships)

        # Determine overall status for Auftragsübersicht
        if o.blocked:
            status = "gesperrt"
            label = "Gesperrt"
        elif my_ships and any(s["status"] == "delivered" for s in my_ships):
            status = "abgeschlossen"
            label = "Abgeschlossen"
        elif my_ships and any(s["status"] in ("shipped", "packing") for s in my_ships):
            status = "versand"
            label = "Im Versand"
        elif n_producible and n_producible_done == n_producible:
            if internal:
                # Ein interner Auftrag wird nicht versendet; fertig ist fertig.
                status = "abgeschlossen"
                label = "Fertig"
            else:
                status = "versandbereit" if not my_ships else "versand"
                label = "Fertig / versandbereit"
        elif has_running or n_batched > 0 or (0 < n_producible_done < n_producible):
            status = "in_produktion"
            label = "In Produktion"
        elif has_work:
            status = "in_produktion"
            label = "In Produktion"
        elif o.released:
            status = "freigegeben"
            label = "Freigegeben"
        else:
            status = "wartet"
            label = "Wartend"

        # Storniert schlägt alles; angehalten gilt, solange der Auftrag noch
        # nicht fertig oder unterwegs ist (Aufgabe 45).
        if o.cancelled_at is not None:
            status = "storniert"
            label = "Storniert"
        elif o.held_at is not None and status in (
            "wartet", "freigegeben", "in_produktion", "gesperrt"
        ):
            status = "angehalten"
            label = "Angehalten"

        items.append(
            OrderListItem(
                id=o.id,
                no=o.no,
                kind=o.kind or "external",
                internal_owner=o.internal_owner or "",
                customer=customer,
                customer_ref=o.customer_ref,
                created_at=o.created_at,
                net=o.net if office else 0.0,
                gross=o.gross if office else 0.0,
                paid=o.paid if office else False,
                paid_at=o.paid_at if office else None,
                payment_method=o.payment_method if office else "",
                invoice_no=o.invoice_no if office else "",
                invoiced_at=o.invoiced_at if office else None,
                invoice_due_at=o.invoice_due_at if office else None,
                released=o.released,
                blocked=o.blocked,
                rush=o.rush,
                due_date=o.due_date,
                n_positions=len(o_positions),
                n_done=n_done,
                n_manual=n_manual,
                work_orders=work_orders,
                shipments=my_ships,
                status=status,
                status_label=label,
                held_at=o.held_at,
                # Gründe sind Bürosache; die Halle sieht nur den Stand.
                hold_reason=(o.hold_reason or "") if office else "",
                cancelled_at=o.cancelled_at,
                cancel_reason=(o.cancel_reason or "") if office else "",
            )
        )

    return OrderListResponse(items=items, total=total, has_more=has_more, next_cursor=next_cursor)


def _wo_engine(db: Session, no: str) -> str:
    wo = db.query(WorkOrder).filter(WorkOrder.no == no).first()
    return wo.engine_version if wo else ""


#: Protokollzeilen, deren Freitext nur das Büro liest (Aufgabe 45).
_OFFICE_ONLY_AUDIT = {"order_hold", "order_resume", "order_cancel", "order_change"}


@router.get("/orders/{no}", dependencies=[Depends(require_worker)])
def order_detail(no: str, db: Annotated[Session, Depends(get_db)],
                 actor: Annotated[User, Depends(require_worker)]) -> dict:
    """Einzelner Kundenauftrag mit allen Positionen, Innenaufträgen und Platten.

    Die Eine-Sicht-für-alles-Antwort: wenn jemand „wo ist mein Auftrag"
    fragt, gibt diese Seite die vollständige Antwort — von der Bestellung
    über die Fertigung bis zum Versand.
    """
    from ..models import ShipmentItem, Shipment
    from ..services.trace import STATUS_TEXT, order_trace

    office = actor.role in (Role.staff, Role.admin)

    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")

    ship = order.ship_address or {}
    is_internal = (order.kind or "external") == "internal"
    # Halle: kein Kundenname, keine Anschrift, kein Betrag (services/floor_view.py).
    internal_emails = set() if office else floor_view.internal_emails(db)
    raw_customer = (
        ship.get("company")
        or ship.get("contact")
        or (order.user.company if order.user else "")
        or (order.user.name if order.user else "")
        or (order.user.email if order.user else "")
        or ""
    )
    customer = (
        order.internal_owner
        if is_internal
        else floor_view.customer_name(raw_customer, office)
    )

    # Positionen
    positions = list(order.positions)

    # Herkunft aus der Formenbibliothek — der Name gehört neben die Kennung,
    # damit die Auftragsansicht nicht nur eine Nummer zeigt.
    shape_ids = {p.shape_id for p in positions if p.shape_id}
    shapes = (
        {s.id: s for s in db.query(LibraryShape).filter(LibraryShape.id.in_(shape_ids)).all()}
        if shape_ids
        else {}
    )

    # Innenaufträge und Platzierungen: aus ``trace.order_trace``. ``WorkItem.order_no``
    # ist die Nummer des *Kundenauftrags* — wer sie als Innenauftragsnummer liest,
    # findet nie einen Innenauftrag und verweist jede Position auf sich selbst.
    tr = order_trace(db, order)
    tr_pos = {e["position_id"]: e for e in tr["positions"]}
    wo_details = [
        {
            "no": w["no"],
            "run_no": w["run_no"],
            "mat": w["mat_name"] or w["mat"],
            "thk": w["thk"],
            "status": w["status"],
            "status_text": w["status_text"],
            "machine": w["machine"],
            "n_parts": w["own_parts"],
            "n_orders": w["n_orders"],
            "n_plates": w["n_plates"],
            "n_done_plates": w["n_done_plates"],
            "own_parts": w["own_parts"],
            "n_own_parts": w["own_parts"],
            "own_tags": w["own_tags"],
            "tags": w["own_tags"],
            "plates": w["plates"],
            "engine_version": _wo_engine(db, w["no"]),
            "release_reason": w["release_reason"],
            "created_at": w["created_at"],
            "started_at": w["started_at"],
            "done_at": w["done_at"],
        }
        for w in tr["work_orders"]
    ]

    # Positionen mit Traceability
    pos_out = []
    for p in positions:
        e = tr_pos.get(p.id) or {}
        pos_out.append(
            {
                "id": p.id,
                "kind": p.kind,
                "label": p.label,
                "mat": p.mat,
                "thk": p.thk,
                "qty": p.qty,
                "od": p.od,
                "di": p.di,
                "desc": p.note or "",
                "external_note": getattr(p, "external_note", "") or "",
                "price_gross": (p.price_gross or 0.0) if office else 0.0,
                "production_status": p.production_status,
                "status_text": e.get("status_text")
                or STATUS_TEXT.get(p.production_status, p.production_status),
                "shape_id": p.shape_id,
                "shape_key": shapes[p.shape_id].key if p.shape_id in shapes else "",
                "shape_label": shapes[p.shape_id].label if p.shape_id in shapes else "",
                "work_order_no": e.get("work_order_no"),
                "tags": e.get("tags", []),
                "plates": e.get("plates", []),
            }
        )

    # Versand (je Sendung genau eine Zeile, mit Anzahl der Positionen dieses Auftrags)
    ship_items = (
        db.query(ShipmentItem, Shipment)
        .join(Shipment, ShipmentItem.shipment_id == Shipment.id)
        .filter(ShipmentItem.order_id == order.id)
        .order_by(Shipment.created_at.asc())
        .all()
    )
    ship_by_no: dict[str, dict] = {}
    for si, s in ship_items:
        entry = ship_by_no.get(s.no)
        if entry is None:
            ship_by_no[s.no] = {
                "no": s.no,
                "status": s.status.value,
                "carrier": s.carrier,
                "tracking": s.tracking,
                "created_at": s.created_at,
                "shipped_at": s.shipped_at,
                "n_items": 1,
            }
        else:
            entry["n_items"] += 1
    shipments = list(ship_by_no.values())

    # Audit-Trail für diesen Auftrag
    audit_rows = (
        db.query(AuditLog)
        .filter(AuditLog.entity == "order", AuditLog.entity_id == no)
        .order_by(AuditLog.at.desc())
        .limit(50)
        .all()
    )

    return {
        "no": order.no,
        "kind": order.kind or "external",
        "internal_owner": order.internal_owner or "",
        "customer": customer,
        "customer_ref": order.customer_ref,
        "cert": order.cert,
        "net": order.net if office else 0.0,
        "vat": order.vat if office else 0.0,
        "gross": order.gross if office else 0.0,
        "engine_version": order.engine_version,
        "blocked": order.blocked,
        "released": order.released,
        "release_note": order.release_note if office else "",
        # Lebenslauf (Aufgabe 45). Die Büronotiz bekommt nur das Büro.
        "office_note": (order.office_note or "") if office else "",
        "held_at": order.held_at,
        # Gründe sind Bürosache; die Halle sieht nur den Stand.
        "hold_reason": (order.hold_reason or "") if office else "",
        "cancelled_at": order.cancelled_at,
        "cancel_reason": (order.cancel_reason or "") if office else "",
        "rev": int(order.rev or 0),
        "paid": order.paid if office else False,
        "paid_at": order.paid_at if office else None,
        "payment_method": order.payment_method if office else "",
        "payment_ref": order.payment_ref if office else "",
        "price_check": (order.price_check or {}) if office else {},
        "due_date": order.due_date,
        "rush": order.rush,
        "ship_address": floor_view.address(ship, office),
        "bill_address": floor_view.address(order.bill_address, office),
        "created_at": order.created_at,
        "positions": pos_out,
        "work_orders": wo_details,
        "shipments": shipments,
        "audit": [
            {"at": a.at, "actor": floor_view.actor_label(a.actor, office, internal_emails), "action": a.action,
             # Die Halle sieht, was wann geschah, nie die Einzelheiten: dort stehen
             # E-Mail, Beträge und Zahlungsreferenzen (services/floor_view.py).
             "detail": a.detail if office else {}}
            for a in audit_rows
        ],
    }


# --------------------------------------------------------------------------
# Wiederverwendung: bestehenden Auftrag als Vorlage für einen neuen
# --------------------------------------------------------------------------
@router.post("/orders/{no}/clone", dependencies=[Depends(require_staff)])
def clone_order(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    from ..schemas import QuoteLine
    from ..services.orders import lines_to_domain, place_order, quote

    src = db.query(Order).filter(Order.no == no).first()
    if not src:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    if not src.positions:
        raise HTTPException(
            status_code=422, detail="Quellauftrag hat keine Positionen."
        )
    quote_lines = []
    for p in src.positions:
        quote_lines.append(
            QuoteLine(
                id=p.id,
                kind=p.kind,
                label=p.label,
                mat=p.mat,
                thk=p.thk,
                q=p.qty,
                od=p.od,
                di=p.di,
                bn=p.bolt_count,
                bc=p.bolt_circle,
                bd=p.bolt_d,
                cut_len=p.cut_len,
                fmt=list(p.fmt) if p.fmt else None,
                shape=p.shape,
                shape_id=p.shape_id,
                desc=p.note or "",
                external_note=getattr(p, "external_note", "") or "",
                price_gross=p.price_gross or 0.0,
            )
        )
    from ..services.catalog import load_products as _lp, load_rates as _lr
    from ..extensions import price_cart as _pc

    _products = _lp(db)
    _rates = _lr(db, vat_rate=(src.tax_status or {}).get("rate", 0.19))
    domain_lines = lines_to_domain(quote_lines)
    _pc(domain_lines, lambda m: _products.get(m), _rates, src.cert, lambda m: None)
    new_order = place_order(
        db,
        lines=quote_lines,
        cert=src.cert,
        ship_address=src.ship_address or {},
        bill_address=src.bill_address or src.ship_address or {},
        tax_status=src.tax_status or {"rate": 0.19, "type": "domestic"},
        customer_ref=src.customer_ref,
        user=src.user,
        rush=src.rush,
        contact_email=src.contact_email,
        paid=False,
        payment_method="internal" if (src.kind or "external") == "internal" else "",
        kind=src.kind or "external",
        internal_owner=src.internal_owner or "",
    )
    new_order.released = not new_order.blocked
    new_order.release_note = f"Aus {src.no} übernommen"
    db.add(
        AuditLog(
            actor=actor.email,
            action="order_clone",
            entity="order",
            entity_id=new_order.no,
            detail={"source": src.no, "positions": len(quote_lines)},
        )
    )
    db.commit()
    db.refresh(new_order)
    from ..services.events import bus as _bus

    _bus.publish(
        "order_created", {"order_no": new_order.no, "source": src.no, "clone": True}
    )
    return {
        "no": new_order.no,
        "source": src.no,
        "n_positions": len(new_order.positions),
        "net": new_order.net,
        "gross": new_order.gross,
        "released": new_order.released,
    }


class MarkPaidIn(BaseModel):
    paid: bool = True
    method: str = "extern"
    ref: str = ""
    note: str = ""


@router.post("/orders/{no}/paid", dependencies=[Depends(require_staff)])
def mark_paid(
    no: str,
    body: MarkPaidIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    if (order.kind or "external") == "internal":
        raise HTTPException(
            status_code=409, detail="Interner Auftrag — keine Zahlung vorgesehen."
        )
    if order.cancelled_at is not None:
        raise HTTPException(
            status_code=409, detail="Stornierter Auftrag kann nicht als bezahlt markiert werden."
        )
    if body.paid and order.paid:
        raise HTTPException(
            status_code=422, detail="Auftrag ist bereits als bezahlt markiert."
        )
    if not body.paid and not order.paid:
        raise HTTPException(status_code=422, detail="Auftrag ist nicht bezahlt.")
    from ..services import order_flow

    if body.paid:
        order_flow.mark_paid(
            db,
            order,
            actor=actor.email,
            note=body.note,
            method=body.method or "extern",
            ref=body.ref,
            action="order_mark_paid_external",
            release=True,
            release_note="Freigegeben — extern als bezahlt markiert",
        )
    else:
        order_flow.unmark_paid(
            db, order, actor=actor.email, note=body.note,
            action="order_unmark_paid",
        )
    db.commit()
    db.refresh(order)
    from ..services.events import bus as _bus2

    _bus2.publish(
        "order_paid_external" if body.paid else "order_unmark_paid",
        {"order_no": order.no, "paid": order.paid},
    )
    return {
        "no": order.no,
        "paid": order.paid,
        "paid_at": order.paid_at,
        "payment_method": order.payment_method,
    }


# --------------------------------------------------------------------------
# Zeitstrahl + schrittweises Zurückrollen
# --------------------------------------------------------------------------
def _build_timeline(db: Session, order: Order) -> list[dict]:
    from ..models import ShipmentItem, Shipment, WorkItem

    audit_rows = (
        db.query(AuditLog)
        .filter(AuditLog.entity == "order", AuditLog.entity_id == order.no)
        .order_by(AuditLog.at.asc())
        .all()
    )
    audit_by_action: dict[str, datetime] = {}
    for a in audit_rows:
        if a.action not in audit_by_action:
            audit_by_action[a.action] = a.at

    is_internal = (order.kind or "external") == "internal"
    pos_statuses = [p.production_status for p in order.positions]
    has_batched = any(s in ("batched", "done") for s in pos_statuses)
    has_done = any(s == "done" for s in pos_statuses)
    gasket_positions = [p for p in order.positions if p.kind == "gasket"]
    producible = [p for p in gasket_positions if p.production_status != "manual"]
    if producible:
        all_done = all(p.production_status == "done" for p in producible)
        done_count = sum(1 for p in producible if p.production_status == "done")
        done_total = len(producible)
    elif order.positions:
        all_done = all(p.production_status == "done" for p in order.positions)
        done_count = sum(1 for p in order.positions if p.production_status == "done")
        done_total = len(order.positions)
    else:
        all_done = False
        done_count = 0
        done_total = 0

    work_items = []
    if order.positions:
        pids = [p.id for p in order.positions]
        work_items = db.query(WorkItem).filter(WorkItem.position_id.in_(pids)).all()
    wo_ids = {wi.work_order_id for wi in work_items}
    work_orders = []
    if wo_ids:
        from ..models import WorkOrder as _WO

        work_orders = db.query(_WO).filter(_WO.id.in_(wo_ids)).order_by(_WO.created_at).all()
    wo_nos = [wo.no for wo in work_orders]
    has_running = any(
        getattr(wo, "status", None) and wo.status.value == "running"
        for wo in work_orders
    )

    raw_shipments = (
        db.query(Shipment)
        .join(ShipmentItem, ShipmentItem.shipment_id == Shipment.id)
        .filter(ShipmentItem.order_id == order.id)
        .order_by(Shipment.created_at)
        .all()
    )
    shipment_objs = list({s.id: s for s in raw_shipments}.values())

    def _ts(dt):
        return dt.isoformat() if dt else None

    dispatched = [s for s in shipment_objs if s.status.value in ("shipped", "delivered")]
    quantities: dict[int, int] = {}
    for shipment in dispatched:
        for item in shipment.items:
            if item.order_id == order.id and item.position_id:
                quantities[item.position_id] = quantities.get(item.position_id, 0) + item.qty
    fully_shipped = bool(order.positions) and all(
        quantities.get(p.id, 0) >= p.qty for p in order.positions
    )

    steps: list[dict] = []
    steps.append(
        {
            "id": "created",
            "label": "Bestellt",
            "icon": "shopping-cart",
            "done": True,
            "current": False,
            "at": _ts(order.created_at),
            "detail": f"{len(order.positions)} Position(en) · {order.cert}",
        }
    )
    steps.append(
        {
            "id": "released",
            "label": "Freigegeben",
            "icon": "arrow-right",
            "done": bool(order.released and not order.blocked and order.cancelled_at is None),
            "current": bool(order.released and not has_batched),
            "at": _ts(
                audit_by_action.get("order_release")
                or (order.created_at if order.released else None)
            ),
            "detail": "storniert"
            if order.cancelled_at is not None
            else (
                order.release_note
                or ("freigegeben" if order.released else "wartet auf Freigabe")
            ),
            "blocked": bool(order.blocked),
        }
    )
    steps.append(
        {
            "id": "planned",
            "label": "Eingeplant",
            "icon": "cut",
            "done": bool(has_batched),
            "current": bool(has_batched and not has_running and not has_done),
            "at": _ts(work_orders[0].created_at if work_orders else None),
            "detail": ", ".join(wo_nos) if wo_nos else "noch kein Innenauftrag",
        }
    )
    steps.append(
        {
            "id": "cutting",
            "label": "Im Schnitt",
            "icon": "cog",
            "done": bool(has_running or has_done),
            "current": bool(has_running),
            "at": _ts(
                next(
                    (
                        wo.started_at
                        for wo in work_orders
                        if getattr(wo, "started_at", None)
                    ),
                    None,
                )
            ),
            "detail": "Wird geschnitten"
            if has_running
            else ("bereit" if has_batched else "wartet"),
        }
    )
    steps.append(
        {
            "id": "done",
            "label": "Fertig" if is_internal else "Geschnitten",
            "icon": "tick-circle",
            "done": bool(all_done),
            "current": bool(all_done and not shipment_objs),
            "at": _ts(
                next(
                    (wo.done_at for wo in work_orders if getattr(wo, "done_at", None)),
                    None,
                )
            ),
            "detail": (
                f"{done_count}/{done_total} "
                f"{'Schnittpositionen' if done_total < len(order.positions) else 'Positionen'} geschnitten"
            )
            if done_total
            else "—",
        }
    )
    # Interne Aufträge bleiben im Haus — kein Versand, keine Zahlung.
    if not is_internal:
        steps.append(
            {
                "id": "shipped",
                "label": "Versand",
                "icon": "truck",
                "done": fully_shipped,
                "current": False,
                "at": _ts(max((s.shipped_at for s in dispatched if s.shipped_at), default=None)) if fully_shipped else None,
                "detail": ("Vollständig versendet: " if fully_shipped else "Teilversand: " if dispatched else "Wird gepackt: ") + ", ".join(s.no for s in shipment_objs)
                if shipment_objs
                else "noch kein Versand",
            }
        )
        steps.append(
            {
                "id": "paid",
                "label": "Bezahlt",
                "icon": "euro",
                "done": bool(order.paid),
                "current": False,
                "at": _ts(order.paid_at),
                "detail": order.payment_method or "offen",
            }
        )

    # Payment is independent of fulfilment; prepayment is not the last
    # production milestone. Exactly one operational step is current unless cancelled.
    operational = [s for s in steps if s["id"] != "paid"]
    is_cancelled = order.cancelled_at is not None
    if is_cancelled:
        current = None
    else:
        current = next((s for s in operational if not s["done"]), operational[-1])
        if has_running:
            current = next(s for s in operational if s["id"] == "cutting")
        if not is_internal and fully_shipped:
            current = next(s for s in operational if s["id"] == "shipped")
        if order.blocked:
            current = next(s for s in operational if s["id"] == "released")
    for s in steps:
        s["current"] = s is current
        if s is current and order.held_at is not None and not is_cancelled:
            s["held"] = True
        can = bool(not is_cancelled and s["done"] and s["id"] != "created" and s["id"] != "paid")
        if s.get("blocked") and s["id"] == "released":
            can = False
        if s["id"] == "cutting" and not any(
            x["done"] for x in steps if x["id"] == "cutting"
        ):
            can = False
        # paid/shipped rollback is production-only; payment rollback is separate via "Extern bezahlt" button
        if s["id"] == "paid":
            can = False
        s["can_rollback"] = can
        s["rollback_hint"] = (
            "Produktionsschritt zurücksetzen — spätere Fertigungsschritte werden mit zurückgerollt"
            if can
            else ""
        )
    return steps


@router.get("/orders/{no}/timeline", dependencies=[Depends(require_worker)])
def order_timeline(no: str, db: Annotated[Session, Depends(get_db)],
                   actor: Annotated[User, Depends(require_worker)]) -> dict:
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    steps = _build_timeline(db, order)
    # Zahlung ist Bürosache: die Halle bekommt den Schritt „bezahlt" nicht.
    if not floor_view.is_office(actor):
        # Freigabenotiz und Zahlungsschritt sind Bürosache.
        steps = [{**st, "detail": "storniert" if order.cancelled_at is not None else ("freigegeben" if st.get("done") else "wartet auf Freigabe")}
                 if st.get("id") == "released" else st
                 for st in steps if st.get("id") != "paid"]
    state = (
        "cancelled"
        if order.cancelled_at is not None
        else "held"
        if order.held_at is not None
        else "blocked"
        if order.blocked
        else "active"
    )
    return {"no": order.no, "state": state, "steps": steps}


class RollbackIn(BaseModel):
    step: str = ""
    reason: str = ""


def _rollback_one(db: Session, order: Order, actor: User, step_id: str) -> dict:
    detail: dict = {}
    if step_id == "paid":
        order.paid = False
        order.paid_at = None
        detail = {"step": "paid", "to": "unpaid"}
        db.add(
            AuditLog(
                actor=actor.email,
                action="order_rollback",
                entity="order",
                entity_id=order.no,
                detail=detail,
            )
        )
        return detail
    if step_id == "shipped":
        ship_rows = (
            db.query(Shipment)
            .join(ShipmentItem, ShipmentItem.shipment_id == Shipment.id)
            .filter(ShipmentItem.order_id == order.id)
            .all()
        )
        packing = [s for s in ship_rows if s.status.value == "packing"]
        target_ships = packing if packing else ship_rows
        if not target_ships:
            raise HTTPException(
                status_code=422, detail="Kein Versand zum Zurückrollen."
            )
        victim = sorted(target_ships, key=lambda s: s.created_at, reverse=True)[0]
        if victim.status.value != "packing":
            victim.status = ShipmentStatus.packing
            victim.shipped_at = None
            victim.shipped_by = ""
            detail = {"step": "shipped", "shipment": victim.no, "to": "packing"}
            db.add(
                AuditLog(
                    actor=actor.email,
                    action="order_rollback",
                    entity="order",
                    entity_id=order.no,
                    detail=detail,
                )
            )
        else:
            other_ship_item = (
                db.query(ShipmentItem.id)
                .filter(
                    ShipmentItem.shipment_id == victim.id,
                    ShipmentItem.order_id != order.id,
                )
                .first()
            )
            db.query(ShipmentItem).filter(
                ShipmentItem.shipment_id == victim.id,
                ShipmentItem.order_id == order.id,
            ).delete(synchronize_session=False)
            if other_ship_item is None:
                db.add(
                    AuditLog(
                        actor=actor.email,
                        action="shipment_delete",
                        entity="shipment",
                        entity_id=victim.no,
                        detail={"rollback_from": order.no},
                    )
                )
                db.delete(victim)
                detail = {"step": "shipped", "deleted_shipment": victim.no}
            else:
                detail = {
                    "step": "shipped",
                    "shipment": victim.no,
                    "removed_items_for": order.no,
                }
                db.add(
                    AuditLog(
                        actor=actor.email,
                        action="order_rollback",
                        entity="order",
                        entity_id=order.no,
                        detail=detail,
                    )
                )
        return detail
    if step_id == "done":
        pids = [p.id for p in order.positions if p.production_status == "done"]
        if not pids:
            raise HTTPException(
                status_code=422, detail="Keine geschnittenen Positionen."
            )
        done_wis = db.query(WorkItem).filter(chunked_in(WorkItem.position_id, pids)).all()
        wo_nos = {wi.work_order_id for wi in done_wis}
        for wi in done_wis:
            pos = db.get(OrderPosition, wi.position_id)
            if pos:
                pos.production_status = "batched"
        for wo_id in wo_nos:
            wo = db.get(WorkOrder, wo_id)
            if wo:
                if wo.status.value == "done":
                    wo.status = WorkOrderStatus.open
                    wo.done_at = None
                    wo.done_by = ""
                wo.order_done = {
                    k: v for k, v in (wo.order_done or {}).items() if k != order.no
                }
        db.add(
            AuditLog(
                actor=actor.email,
                action="order_rollback",
                entity="order",
                entity_id=order.no,
                detail={"step": "done", "positions": len(pids)},
            )
        )
        return {"step": "done", "positions": len(pids)}
    if step_id == "cutting":
        pids = [p.id for p in order.positions]
        wis = (
            db.query(WorkItem).filter(chunked_in(WorkItem.position_id, pids)).all()
            if pids
            else []
        )
        cnt = 0
        for wo_id in {wi.work_order_id for wi in wis}:
            wo = db.get(WorkOrder, wo_id)
            if wo and wo.status == WorkOrderStatus.running:
                wo.status = WorkOrderStatus.open
                wo.started_at = None
                wo.started_by = ""
                cnt += 1
        if cnt == 0:
            db.add(
                AuditLog(
                    actor=actor.email,
                    action="order_rollback",
                    entity="order",
                    entity_id=order.no,
                    detail={
                        "step": "cutting",
                        "note": "kein laufender IA — bereits offen",
                    },
                )
            )
            return {"step": "cutting", "note": "already open"}
        db.add(
            AuditLog(
                actor=actor.email,
                action="order_rollback",
                entity="order",
                entity_id=order.no,
                detail={"step": "cutting", "to": "open", "work_orders": cnt},
            )
        )
        return {"step": "cutting", "work_orders": cnt}
    if step_id == "planned":
        pids = [p.id for p in order.positions if p.production_status == "batched"]
        if not pids:
            raise HTTPException(
                status_code=422, detail="Keine eingeplanten Positionen."
            )
        wis = db.query(WorkItem).filter(chunked_in(WorkItem.position_id, pids)).all()
        touched_wo_ids = sorted({wi.work_order_id for wi in wis})
        pid_set = set(pids)
        emptied_wo_ids: set[int] = set()
        for wo_id in touched_wo_ids:
            wo = db.get(WorkOrder, wo_id)
            if wo is None:
                continue
            other = (
                db.query(WorkItem.id)
                .filter(
                    WorkItem.work_order_id == wo_id,
                    ~chunked_in(WorkItem.position_id, pids),
                )
                .first()
            )
            if other is None:
                cancel_work_order(
                    db,
                    wo,
                    actor=actor.email,
                    reason=f"Rollback Auftrag {order.no}",
                    commit=False,
                )
                emptied_wo_ids.add(wo_id)

        partial_wis = [wi for wi in wis if wi.work_order_id not in emptied_wo_ids]
        if partial_wis:
            plate_ids = {wi.plate_id for wi in partial_wis}
            partial_wo_ids = {wi.work_order_id for wi in partial_wis}
            db.query(WorkItem).filter(
                chunked_in(WorkItem.id, [wi.id for wi in partial_wis])
            ).delete(synchronize_session=False)
            (
                db.query(OrderPosition)
                .filter(chunked_in(OrderPosition.id, pids))
                .filter(OrderPosition.production_status != "done")
                .update(
                    {OrderPosition.production_status: "pending"},
                    synchronize_session=False,
                )
            )
            for pl_id in plate_ids:
                pl = db.get(WorkPlate, pl_id)
                if not pl:
                    continue
                remaining = (
                    db.query(WorkItem).filter(WorkItem.plate_id == pl_id).count()
                )
                if remaining == 0:
                    wo = db.get(WorkOrder, pl.work_order_id)
                    if pl.offcut_id and wo is not None:
                        off = db.get(Offcut, pl.offcut_id)
                        if off is not None and off.status == "reserved" and off.work_order_no == wo.no:
                            off.status = "available"
                            off.work_order_no = ""
                    elif wo is not None:
                        product = db.get(Product, wo.mat)
                        if product is not None:
                            move_stock(
                                db,
                                product,
                                1,
                                reason="storno",
                                actor=actor.email,
                                work_order_no=wo.no,
                                note=f"{wo.no} Platte {pl.idx + 1} bei Rollback {order.no} freigegeben",
                            )
                    if wo is not None:
                        (
                            db.query(Offcut)
                            .filter(
                                Offcut.source_work_order_no == wo.no,
                                Offcut.source_plate_id == pl.id,
                                Offcut.status == "pending",
                            )
                            .delete(synchronize_session=False)
                        )
                    db.expire(pl, ["items"])
                    db.delete(pl)
                else:
                    pl.placements = [
                        x
                        for x in (pl.placements or [])
                        if x.get("position_id") not in pid_set
                    ]
                    pl.n_parts = remaining
            db.flush()
            for wo_id in partial_wo_ids:
                wo = db.get(WorkOrder, wo_id)
                if wo is None:
                    continue
                rem_plates = db.query(WorkPlate).filter(WorkPlate.work_order_id == wo.id).all()
                rem_items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
                wo.n_plates = len(rem_plates)
                wo.n_parts = len(rem_items)
                wo.n_orders = len({i.order_no for i in rem_items})
        else:
            (
                db.query(OrderPosition)
                .filter(chunked_in(OrderPosition.id, pids))
                .filter(OrderPosition.production_status == "batched")
                .update(
                    {OrderPosition.production_status: "pending"},
                    synchronize_session=False,
                )
            )
        db.add(
            AuditLog(
                actor=actor.email,
                action="order_rollback",
                entity="order",
                entity_id=order.no,
                detail={"step": "planned", "positions": len(pids)},
            )
        )
        return {"step": "planned", "positions": len(pids)}
    if step_id == "released":
        order.released = False
        order.release_note = f"Zurückgerollt durch {actor.email}"[:200]
        db.add(
            AuditLog(
                actor=actor.email,
                action="order_rollback",
                entity="order",
                entity_id=order.no,
                detail={"step": "released", "to": False},
            )
        )
        return {"step": "released"}
    raise HTTPException(
        status_code=422, detail=f"Schritt „{step_id}“ kann nicht zurückgerollt werden."
    )


@router.post("/orders/{no}/rollback", dependencies=[Depends(require_staff)])
def order_rollback(
    no: str,
    body: RollbackIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    if order.cancelled_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Stornierter Auftrag kann nicht zurückgerollt werden.",
        )
    steps = _build_timeline(db, order)
    done_ids = [s["id"] for s in steps if s["done"]]
    rollbackable_ids = [s["id"] for s in steps if s.get("can_rollback")]
    rollbackable = set(rollbackable_ids)
    if not done_ids or not rollbackable_ids:
        raise HTTPException(status_code=422, detail="Nichts zurückzurollen.")
    order_ids = [s["id"] for s in steps]
    target = (body.step or rollbackable_ids[-1]).strip()
    if target == "paid":
        raise HTTPException(
            status_code=422,
            detail="Zahlung wird nicht über die Zeitleiste zurückgerollt — nutze den „Extern bezahlt“-Schalter.",
        )
    if target not in done_ids:
        raise HTTPException(
            status_code=422,
            detail=f"Schritt „{target}“ ist nicht erledigt — nur erledigte Schritte können zurückgerollt werden.",
        )
    if target not in rollbackable:
        raise HTTPException(
            status_code=422,
            detail=f"Schritt „{target}“ kann nicht zurückgerollt werden.",
        )
    target_idx = order_ids.index(target)
    last_idx = order_ids.index(rollbackable_ids[-1])
    if target_idx > last_idx:
        raise HTTPException(status_code=422, detail="Ziel liegt in der Zukunft.")
    chain = [
        order_ids[i]
        for i in range(last_idx, target_idx - 1, -1)
        if order_ids[i] in rollbackable
    ]
    if not chain:
        raise HTTPException(
            status_code=422, detail="Kein Produktionsschritt zum Zurückrollen."
        )
    try:
        order_flow._claim(db, order, None)
    except order_flow.FlowError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    if order.cancelled_at is not None:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Stornierter Auftrag kann nicht zurückgerollt werden.",
        )
    rolled: list[dict] = []
    for sid in chain:
        try:
            d = _rollback_one(db, order, actor, sid)
            rolled.append(d)
            db.flush()
        except HTTPException:
            db.rollback()
            raise
        except ValueError as exc:
            db.rollback()
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except Exception:
            db.rollback()
            log.exception("Rollback bei %s (%s) fehlgeschlagen", order.no, sid)
            raise HTTPException(
                status_code=500, detail=f"Rollback bei {sid} fehlgeschlagen."
            )
    if body.reason:
        db.add(
            AuditLog(
                actor=actor.email,
                action="order_rollback_reason",
                entity="order",
                entity_id=order.no,
                detail={"reason": body.reason[:300], "chain": chain},
            )
        )
    db.commit()
    db.refresh(order)
    return {
        "no": order.no,
        "rolled_back": chain,
        "count": len(chain),
        "steps": _build_timeline(db, order),
        "details": rolled,
    }


@router.post("/orders/{no}/rollback_legacy", dependencies=[Depends(require_staff)])
def order_rollback_legacy(
    no: str,
    body: RollbackIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    if order.cancelled_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Stornierter Auftrag kann nicht zurückgerollt werden.",
        )
    steps = _build_timeline(db, order)
    rollbackable_ids = [s["id"] for s in steps if s.get("can_rollback")]
    if not rollbackable_ids:
        raise HTTPException(status_code=422, detail="Nichts zurückzurollen.")
    last = rollbackable_ids[-1]
    target = (body.step or last).strip()
    if target != last:
        raise HTTPException(
            status_code=422,
            detail=f"Nur der letzte Schritt kann zurückgerollt werden — erwartet „{last}“, erhalten „{target}“.",
        )

    try:
        order_flow._claim(db, order, None)
    except order_flow.FlowError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    if order.cancelled_at is not None:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Stornierter Auftrag kann nicht zurückgerollt werden.",
        )

    try:
        rolled = _rollback_one(db, order, actor, last)
        db.flush()
    except HTTPException:
        db.rollback()
        raise
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception:
        db.rollback()
        log.exception("Legacy-Rollback bei %s (%s) fehlgeschlagen", order.no, last)
        raise HTTPException(
            status_code=500, detail=f"Rollback bei {last} fehlgeschlagen."
        )

    db.commit()
    db.refresh(order)
    return {
        "no": order.no,
        "rolled_back": last,
        "detail": {"from": last, **rolled},
        "steps": _build_timeline(db, order),
    }
