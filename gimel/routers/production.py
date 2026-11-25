"""Fertigung: Sammelläufe, Innenaufträge, Plattenzeichnung, Laufkarte.

Das ist die Sicht des Werkers und die Steuerung des Sammellaufs. Die Zeichnung
und die Laufkarte werden aus den *gespeicherten* Belegungen erzeugt, nicht neu
geschachtelt — sonst zeigt das Papier an der Maschine etwas anderes als der
Bildschirm, sobald der Nester besser wird.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import chunked_in, get_db
from ..core.batch import MODE_BATCH, MODES
from ..core.cutting import MODE_AUTO, MODE_CLASSIC, STRATEGY_LABELS, CutPlan
from ..models import (
    AuditLog,
    BatchPolicy,
    FactoryStation,
    LibraryShape,
    NestRun,
    Order,
    OrderPosition,
    Product,
    StockLocation,
    User,
    WorkItem,
    WorkOrder,
    WorkOrderStatus,
    WorkPlate,
)
from ..render.dxf import part_dxf, plate_dxf
from ..render.part import part_svg
from ..render.plate import plate_svg, work_order_html
from ..render.qr import qr_svg
from ..security import require_staff, require_worker
from ..services import cutfiles, floor_view, laufkarte_share, settings_store, trace
from ..services import run_jobs, run_lock
from ..services import stock_locations as stockloc
from ..services.batch_runner import (RenestError, collect_pending, forecast_bucket,
                                     forecast_plate, preview_queue, renest_work_orders,
                                     run_batch, trial_policy)
from ..services.events import bus
from ..services.orders import promised_date
from ..services.scheduler import state as scheduler_state

router = APIRouter(prefix="/api/production", tags=["production"])
public_router = APIRouter(tags=["laufkarte"])


# --------------------------------------------------------------------------
# Sammelläufe
# --------------------------------------------------------------------------
class RunOut(BaseModel):
    id: int
    no: str
    trigger: str
    started_at: datetime
    finished_at: Optional[datetime]
    engine_version: str
    n_orders: int
    n_positions: int
    n_parts: int
    n_plates: int
    n_work_orders: int
    solo_area_m2: float
    batch_area_m2: float
    saved_area_m2: float
    saved_pct: float
    note: str
    n_open: int = 0
    n_running: int = 0
    n_done: int = 0
    n_cancelled: int = 0


def _run_out(r: NestRun, wo_counts: dict | None = None) -> RunOut:
    saved = max(0.0, r.solo_area_m2 - r.batch_area_m2)
    counts = wo_counts or {}
    return RunOut(
        id=r.id,
        no=r.no,
        trigger=r.trigger,
        started_at=r.started_at,
        finished_at=r.finished_at,
        engine_version=r.engine_version,
        n_orders=r.n_orders,
        n_positions=r.n_positions,
        n_parts=r.n_parts,
        n_plates=r.n_plates,
        n_work_orders=r.n_work_orders,
        solo_area_m2=round(r.solo_area_m2, 4),
        batch_area_m2=round(r.batch_area_m2, 4),
        saved_area_m2=round(saved, 4),
        saved_pct=round(saved / r.solo_area_m2 * 100, 2) if r.solo_area_m2 else 0.0,
        note=r.note,
        n_open=counts.get("open", 0),
        n_running=counts.get("running", 0),
        n_done=counts.get("done", 0),
        n_cancelled=counts.get("cancelled", 0),
    )


@router.get("/queue", dependencies=[Depends(require_worker)])
def queue(db: Annotated[Session, Depends(get_db)],
          actor: Annotated[User, Depends(require_worker)]) -> dict:
    """Was auf den nächsten Sammellauf wartet, gruppiert wie geschnitten wird.

    Ohne Begründung ist eine Warteschlange ein schwarzes Loch. Deshalb zwei
    Listen, und die zweite ist die wichtigere: ``ready`` sind die Eimer, die der
    nächste Takt schneidet, samt Grund; ``held`` sind die, die weiter sammeln —
    mit dem Grund und mit dem Zeitpunkt, an dem sie von selbst herausgehen.
    Damit lässt sich entscheiden, ob „Jetzt schachteln" oder noch warten richtig
    ist; ohne das wird die Freigaberegel beim ersten Zweifel abgeschaltet.

    Die Gründe kommen aus derselben Rechnung, die auch der Lauf benutzt
    (``preview_queue`` ruft ``plan_batch``), nicht aus einer zweiten Ableitung
    daneben — sonst zeigt die Vorschau irgendwann etwas anderes als der Lauf tut.
    """
    # Halle: Eimer ohne Kundennamen; „Jetzt schachteln" je Kunde ist ohnehin Bürosache.
    return floor_view.scrub({**preview_queue(db), "scheduler": scheduler_state},
                            floor_view.is_office(actor))


@router.get("/queue/bucket", dependencies=[Depends(require_staff)])
def queue_bucket(
    db: Annotated[Session, Depends(get_db)], mat: str = Query(max_length=60),
    thk: float = Query(), customer_id: Optional[int] = Query(None),
) -> dict:
    """Was herauskäme, wenn dieser Eimer jetzt geschnitten wird. Rechnet, speichert nichts."""
    forecast = forecast_bucket(db, mat, thk, customer_id)
    if forecast is None:
        raise HTTPException(status_code=404, detail="In diesem Eimer wartet nichts.")
    return forecast


@router.get("/queue/bucket/plate/{idx}.svg", response_class=Response,
            dependencies=[Depends(require_staff)])
def queue_bucket_plate(
    idx: int,
    db: Annotated[Session, Depends(get_db)],
    mat: str = Query(max_length=60),
    thk: float = Query(),
    customer_id: Optional[int] = Query(None),
) -> Response:
    """Plattenzeichnung der Vorschau. Noch kein Plan: deshalb kein Cache."""
    found = forecast_plate(db, mat, thk, idx, customer_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Diese Platte gibt es in der Vorschau nicht.")
    plate, total = found
    svg = plate_svg(plate.fmt, plate.placements, title=f"{mat} · {thk:g} mm",
                    plate_no=f"Vorschau · Platte {idx + 1}/{total}", used_h=plate.used_h,
                    turned=bool(plate.turned))
    return Response(content=svg, media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


@router.get("/runs", response_model=list[RunOut], dependencies=[Depends(require_worker)])
def list_runs(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[RunOut]:
    from sqlalchemy import func
    from ..db import chunked_in

    total = int(db.query(func.count(NestRun.id)).scalar() or 0)
    response.headers["X-Total-Count"] = str(total)
    rows = db.query(NestRun).order_by(NestRun.started_at.desc(), NestRun.id.desc()).offset(offset).limit(limit).all()
    if not rows:
        return []
    run_ids = [r.id for r in rows]
    counts_by_run: dict[int, dict[str, int]] = {}
    for run_id, st, cnt in (
        db.query(WorkOrder.run_id, WorkOrder.status, func.count(WorkOrder.id))
        .filter(chunked_in(WorkOrder.run_id, run_ids))
        .group_by(WorkOrder.run_id, WorkOrder.status)
        .all()
    ):
        counts_by_run.setdefault(run_id, {})[st.value] = int(cnt)
    return [_run_out(r, counts_by_run.get(r.id, {})) for r in rows]


@router.post("/runs", response_model=RunOut, status_code=status.HTTP_201_CREATED)
def trigger_run(
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
    force: bool = Query(
        default=False, description="Auch Gruppen schneiden, die noch sammeln"
    ),
) -> RunOut:
    """Sammellauf von Hand auslösen — für den Fall, dass etwas eilt."""
    try:
        run = run_batch(db, trigger="manual", actor=actor.email, force=force)
    except run_lock.Busy as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _run_out(run)


class BucketIn(BaseModel):
    mat: str = Field(max_length=60)
    thk: float


class StartIn(BaseModel):
    #: Leer/None = alle wartenden Eimer; gesetzt = genau diese (Werkstoff, Dicke).
    buckets: Optional[list[BucketIn]] = Field(default=None, max_length=50)
    #: Leer = alle Kunden; gesetzt = nur diese Kundenkonten.
    customer_ids: list[int] = Field(default_factory=list, max_length=200)
    #: ``material`` (mischen) oder ``customer`` (nur je Kunde schachteln).
    group_by: Optional[str] = None


@router.post("/runs/start", status_code=status.HTTP_202_ACCEPTED)
def start_run(
    actor: Annotated[User, Depends(require_staff)],
    force: bool = Query(default=False),
    body: Optional[StartIn] = None,
) -> dict:
    """Wie ``POST /runs``, aber im Hintergrund: Antwort sofort, Stand über ``/runs/jobs/{id}``.

    Mit ``buckets`` werden genau diese Eimer geschnitten — auch sammelnde.
    Mit ``customer_ids`` werden nur die Aufträge dieser Kunden eingesammelt;
    ob sammelnde Eimer mitgehen, entscheidet ``force``. ``group_by="customer"``
    trennt zusätzlich die Platten nach Kunde."""
    if body is not None and not (body.buckets or body.customer_ids or body.group_by):
        raise HTTPException(
            status_code=422,
            detail="Leere Auswahl — Buckets, Kunden oder eine Schachtelart nennen.",
        )
    body = body or StartIn()
    if body.group_by is not None and body.group_by not in ("material", "customer"):
        raise HTTPException(status_code=422, detail="Schachteln ist „material“ oder „customer“.")
    only = {(b.mat, float(b.thk)) for b in (body.buckets or [])} or None
    customers = set(body.customer_ids) or None
    try:
        return run_jobs.start(
            actor.email, force or bool(only),
            lambda run: _run_out(run).model_dump(mode="json"),
            only=only, customers=customers, group_by=body.group_by,
        )
    except run_jobs.Busy:
        raise HTTPException(status_code=409, detail="Ein Sammellauf läuft bereits — bitte warten, bis er fertig ist.")


@router.get("/runs/jobs/{job_id}", dependencies=[Depends(require_staff)])
def run_job(job_id: str) -> dict:
    job = run_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Kein solcher Lauf")
    return job


# --------------------------------------------------------------------------
# Neu schachteln — der Knopf, wenn ein Parameter sich geändert hat
# --------------------------------------------------------------------------
class RenestIn(BaseModel):
    #: Leer/None = alle offenen Innenaufträge; sonst genau diese Nummern.
    work_order_nos: Optional[list[str]] = None


@router.post("/renest", response_model=RunOut, status_code=status.HTTP_201_CREATED)
def renest(
    body: RenestIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> RunOut:
    """Offene Innenaufträge zurück in die Warteschlange und neu schachteln.

    Der Gegenpol zur eingefrorenen Belegung: Abstand, Rand, Beschnitt und die
    Freigaberegel werden beim nächsten Plan neu gelesen — aber nur, solange
    nichts geschnitten ist. Läuft ein Innenauftrag schon, wird er mit 409
    abgewiesen; seine Zeichnung bleibt die Wahrheit an der Maschine.
    """
    try:
        run = renest_work_orders(db, nos=body.work_order_nos, actor=actor.email)
    except RenestError as e:
        raise HTTPException(status_code=409, detail=e.detail)
    except run_lock.Busy as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return _run_out(run)


# --------------------------------------------------------------------------
# Auftragsfreigabe von Hand
# --------------------------------------------------------------------------
class ReleaseIn(BaseModel):
    released: bool = True
    note: str = ""
    rush: Optional[bool] = None


@router.post("/orders/{no}/release")
def release_order(
    no: str,
    body: ReleaseIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Einen Auftrag für die Fertigung freigeben oder zurückziehen.

    Zurückziehen wirkt nur, solange noch nichts geschnitten ist: bereits
    eingeplante Positionen (``batched``) bleiben, wo sie sind — sonst stünde in
    der Werkstatt eine Zeichnung für Teile, die der Auftrag gar nicht mehr
    kennt. Zurückgezogen wird also die *Zukunft*, nicht die Vergangenheit.

    ``rush`` setzt zugleich das Eilkennzeichen und zieht das Zusagedatum auf
    den nächsten Werktag — die Freigaberegel liest beides.
    """
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    if body.released and order.blocked:
        raise HTTPException(
            status_code=409,
            detail="Der Auftrag enthält eine Übergröße und wird von Hand "
            "kalkuliert — er geht nicht automatisch in die Fertigung.",
        )
    if body.released and order.cancelled_at is not None:
        raise HTTPException(
            status_code=409,
            detail="Der Auftrag ist storniert und kann nicht freigegeben werden.",
        )
    if body.rush is not None:
        order.rush = bool(body.rush)
        order.due_date = promised_date(db, rush=order.rush)
    from ..services import order_flow

    order_flow.set_released(
        db,
        order,
        bool(body.released),
        actor=actor.email,
        note=body.note or "",
        action="order_release",
        detail={"rush": order.rush},
    )
    db.commit()
    db.refresh(order)
    bus.publish(
        "order_release",
        {
            "order_no": order.no,
            "released": order.released,
            "rush": order.rush,
            "due_date": order.due_date.isoformat() if order.due_date else None,
        },
    )
    return {
        "no": order.no,
        "released": order.released,
        "rush": order.rush,
        "due_date": order.due_date,
        "note": order.release_note,
        "n_pending": len(
            [p for p in order.positions if p.production_status == "pending"]
        ),
    }


@router.get("/orders/{no}")
def order_for_production(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    """Ein Kundenauftrag aus Sicht der Fertigung: wo liegen seine Positionen.

    Der Gegenweg zur Laufkarte. Beim Rückruf eines Kunden ("wo ist meine
    Bestellung") ist das die Seite, die die Antwort trägt — ohne sie müsste
    jemand die Innenaufträge durchsuchen.
    """
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    ship = order.ship_address or {}
    # Halle: ohne Kunde, Anschrift und Beträge (services/floor_view.py).
    return floor_view.scrub({
        "no": order.no,
        "created_at": order.created_at,
        "customer": ship.get("company") or ship.get("contact") or "",
        "customer_ref": order.customer_ref,
        "cert": order.cert,
        "net": order.net,
        "gross": order.gross,
        "blocked": order.blocked,
        "released": order.released,
        "release_note": order.release_note,
        "paid": order.paid,
        "paid_at": order.paid_at,
        "payment_method": order.payment_method,
        "payment_ref": order.payment_ref,
        "price_check": order.price_check or {},
        "due_date": order.due_date,
        "rush": order.rush,
        "ship_address": ship,
        **trace.order_trace(db, order),
    }, floor_view.is_office(actor))


# --------------------------------------------------------------------------
# Freigaberegeln je Werkstoff — die Freiheit des Betriebs
# --------------------------------------------------------------------------
class PolicyIn(BaseModel):
    """Eine Ausnahme muss nur sagen, was sie ändert. Jedes leere Feld erbt vom
    globalen Betriebsparameter — sonst müsste jede Zeile alles wiederholen und
    würde beim nächsten globalen Umstellen still davonlaufen."""

    mat: str
    thk: Optional[float] = None
    mode: str = MODE_BATCH
    min_parts: Optional[int] = None
    min_utilisation: Optional[float] = None
    max_age_minutes: Optional[int] = None
    due_lead_hours: Optional[int] = None
    max_orders_per_group: Optional[int] = None
    max_plates_per_group: Optional[int] = None
    # Geometrie — gilt nur für die Fertigung, nie für den Preis.
    nest_gap: Optional[float] = None
    nest_margin: Optional[float] = None
    nest_trim_w: Optional[float] = None
    nest_trim_h: Optional[float] = None
    note: str = ""


class PolicyOut(PolicyIn):
    id: int
    updated_at: Optional[datetime] = None
    updated_by: str = ""


def _policy_out(row: BatchPolicy) -> PolicyOut:
    return PolicyOut(
        id=row.id,
        mat=row.mat,
        thk=row.thk,
        mode=row.mode,
        min_parts=row.min_parts,
        min_utilisation=row.min_utilisation,
        max_age_minutes=row.max_age_minutes,
        due_lead_hours=row.due_lead_hours,
        max_orders_per_group=row.max_orders_per_group,
        max_plates_per_group=row.max_plates_per_group,
        nest_gap=row.nest_gap,
        nest_margin=row.nest_margin,
        nest_trim_w=row.nest_trim_w,
        nest_trim_h=row.nest_trim_h,
        note=row.note,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
    )


def _check_policy(body: PolicyIn) -> None:
    if body.mode not in MODES:
        raise HTTPException(
            status_code=422, detail=f"Betriebsart muss {' oder '.join(MODES)} sein."
        )
    if body.min_parts is not None and not (1 <= body.min_parts <= 10000):
        raise HTTPException(status_code=422, detail="Teilezahl zwischen 1 und 10000.")
    if body.min_utilisation is not None and not (0.0 <= body.min_utilisation <= 1.0):
        raise HTTPException(
            status_code=422, detail="Plattenbelegung als Anteil zwischen 0 und 1."
        )
    if body.max_age_minutes is not None and not (
        0 <= body.max_age_minutes <= 60 * 24 * 30
    ):
        raise HTTPException(
            status_code=422, detail="Wartezeit zwischen 0 Minuten und 30 Tagen."
        )
    if body.due_lead_hours is not None and not (0 <= body.due_lead_hours <= 24 * 30):
        raise HTTPException(
            status_code=422, detail="Vorlauf zwischen 0 Stunden und 30 Tagen."
        )
    if body.max_orders_per_group is not None and not (
        0 <= body.max_orders_per_group <= 100
    ):
        raise HTTPException(
            status_code=422, detail="Aufträge je Innenauftrag zwischen 0 (aus) und 100."
        )
    if body.max_plates_per_group is not None and not (
        0 <= body.max_plates_per_group <= 200
    ):
        raise HTTPException(
            status_code=422, detail="Platten je Innenauftrag zwischen 0 (aus) und 200."
        )
    # Geometrie. Die Obergrenzen sind großzügig, aber nicht offen: ein Abstand
    # von 500 mm zwischen zwei Dichtungen ist kein Wunsch, sondern ein Tippfehler,
    # und er fällt erst auf, wenn eine Platte für zwei Teile draufgeht.
    if body.nest_gap is not None and not (0 <= body.nest_gap <= 200):
        raise HTTPException(
            status_code=422, detail="Abstand Teil zu Teil zwischen 0 und 200 mm."
        )
    if body.nest_margin is not None and not (0 <= body.nest_margin <= 300):
        raise HTTPException(
            status_code=422, detail="Randabstand zwischen 0 und 300 mm."
        )
    for value, what in (
        (body.nest_trim_w, "Beschnitt in der Breite"),
        (body.nest_trim_h, "Beschnitt in der Höhe"),
    ):
        if value is not None and not (0 <= value <= 500):
            raise HTTPException(
                status_code=422, detail=f"{what} zwischen 0 und 500 mm."
            )


@router.post("/policies/preview", dependencies=[Depends(require_staff)])
def preview_policy(body: PolicyIn, db: Annotated[Session, Depends(get_db)]) -> list[dict]:
    """Welche wartenden Eimer diese Regel anders entschiede. Speichert nichts."""
    _check_policy(body)
    if not db.get(Product, body.mat):
        raise HTTPException(status_code=404, detail=f"Werkstoff „{body.mat}“ gibt es nicht.")
    return trial_policy(db, BatchPolicy(**body.model_dump()))


@router.get(
    "/policies", response_model=list[PolicyOut], dependencies=[Depends(require_staff)]
)
def list_policies(db: Annotated[Session, Depends(get_db)]) -> list[PolicyOut]:
    rows = db.query(BatchPolicy).order_by(BatchPolicy.mat, BatchPolicy.thk).all()
    return [_policy_out(r) for r in rows]


@router.put("/policies", response_model=PolicyOut)
def upsert_policy(
    body: PolicyIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> PolicyOut:
    """Anlegen oder ändern — (Werkstoff, Dicke) ist der Schlüssel.

    ``thk = null`` gilt für alle Dicken des Werkstoffs; eine Zeile mit Dicke
    schlägt sie. So lässt sich „Graphit sammelt, aber 5 mm sofort“ sagen, ohne
    für jede Dicke eine Zeile zu pflegen.
    """
    _check_policy(body)
    if not db.get(Product, body.mat):
        raise HTTPException(
            status_code=404, detail=f"Werkstoff „{body.mat}“ gibt es nicht."
        )
    row = (
        db.query(BatchPolicy)
        .filter(
            BatchPolicy.mat == body.mat,
            BatchPolicy.thk.is_(None)
            if body.thk is None
            else BatchPolicy.thk == body.thk,
        )
        .first()
    )
    if row is None:
        row = BatchPolicy(mat=body.mat, thk=body.thk)
        db.add(row)
    row.mode = body.mode
    row.min_parts = body.min_parts
    row.min_utilisation = body.min_utilisation
    row.max_age_minutes = body.max_age_minutes
    row.due_lead_hours = body.due_lead_hours
    row.max_orders_per_group = body.max_orders_per_group
    row.max_plates_per_group = body.max_plates_per_group
    row.nest_gap = body.nest_gap
    row.nest_margin = body.nest_margin
    row.nest_trim_w = body.nest_trim_w
    row.nest_trim_h = body.nest_trim_h
    row.note = body.note
    row.updated_by = actor.email
    db.add(
        AuditLog(
            actor=actor.email,
            action="batch_policy",
            entity="batch_policy",
            entity_id=f"{body.mat}/{body.thk if body.thk is not None else 'alle'}",
            detail=body.model_dump(),
        )
    )
    db.commit()
    db.refresh(row)
    return _policy_out(row)


@router.delete("/policies/{policy_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_policy(
    policy_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> Response:
    row = db.get(BatchPolicy, policy_id)
    if not row:
        raise HTTPException(status_code=404, detail="Diese Regel gibt es nicht.")
    db.add(
        AuditLog(
            actor=actor.email,
            action="batch_policy_delete",
            entity="batch_policy",
            entity_id=f"{row.mat}/{row.thk if row.thk is not None else 'alle'}",
            detail={},
        )
    )
    db.delete(row)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------
# Innenaufträge
# --------------------------------------------------------------------------
class WorkOrderOut(BaseModel):
    id: int
    no: str
    run_no: str
    mat: str
    mat_name: str
    thk: float
    fmt: list[float]
    formats: list = []
    status: WorkOrderStatus
    n_plates: int
    n_parts: int
    n_orders: int
    utilisation: float
    engine_version: str
    created_at: datetime
    started_at: Optional[datetime] = None
    started_by: str = ""
    done_at: Optional[datetime] = None
    done_by: str = ""
    machine: str = ""
    release_reason: str = ""
    policy_mode: str = ""
    #: Materialbereitstellung — Zeitpunkt und Wer (siehe models.WorkOrder).
    material_staged_at: Optional[datetime] = None
    material_staged_by: str = ""
    #: Aus welchem Lagerort die Platten kamen — leer = Ort unbekannt.
    material_staged_location_id: Optional[int] = None
    material_staged_location: str = ""
    #: Abstand, Rand und Beschnitt, mit denen DIESER Plan gerechnet wurde.
    nest_options: dict = {}
    order_done: dict = {}
    #: Fertigungsort-Vorgabe (Aufgabe 32); "" = jede Station.
    route_scope: str = ""


def _wo_out(wo: WorkOrder) -> WorkOrderOut:
    return WorkOrderOut(
        id=wo.id,
        no=wo.no,
        run_no=wo.run.no if wo.run else "",
        mat=wo.mat,
        mat_name=wo.mat_name,
        thk=wo.thk,
        fmt=list(wo.fmt or []),
        formats=wo.formats or [],
        status=wo.status,
        n_plates=wo.n_plates,
        n_parts=wo.n_parts,
        n_orders=wo.n_orders,
        utilisation=round(wo.utilisation, 4),
        engine_version=wo.engine_version,
        created_at=wo.created_at,
        started_at=wo.started_at,
        started_by=wo.started_by,
        done_at=wo.done_at,
        done_by=wo.done_by,
        machine=wo.machine,
        release_reason=wo.release_reason or "",
        policy_mode=wo.policy_mode or "",
        material_staged_at=wo.material_staged_at,
        material_staged_by=wo.material_staged_by or "",
        material_staged_location_id=wo.material_staged_location_id,
        material_staged_location=wo.material_staged_location or "",
        nest_options=wo.nest_options or {},
        order_done=wo.order_done or {},
        route_scope=wo.route_scope or "",
    )


@router.get("/work-orders", response_model=list[WorkOrderOut])
def list_work_orders(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[User, Depends(require_worker)],
    status_filter: Optional[WorkOrderStatus] = Query(default=None, alias="status"),
    run: Optional[str] = Query(default=None, max_length=40),
    q: str = Query(default="", max_length=120),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[WorkOrderOut]:
    from sqlalchemy import or_
    from sqlalchemy.orm import defer, joinedload

    query = db.query(WorkOrder).options(
        joinedload(WorkOrder.run).load_only(NestRun.id, NestRun.no),
        defer(WorkOrder.auto_layout),
    )
    if status_filter:
        query = query.filter(WorkOrder.status == status_filter)
    if run:
        query = query.join(NestRun, WorkOrder.run_id == NestRun.id).filter(NestRun.no == run)
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.filter(
            or_(
                WorkOrder.no.ilike(like),
                WorkOrder.mat.ilike(like),
                WorkOrder.mat_name.ilike(like),
                WorkOrder.machine.ilike(like),
            )
        )
    total = int(query.count() or 0)
    response.headers["X-Total-Count"] = str(total)
    rows = query.order_by(WorkOrder.created_at.desc(), WorkOrder.id.desc()).offset(offset).limit(limit).all()
    return [_wo_out(r) for r in rows]


def _load_wo(db: Session, no: str) -> WorkOrder:
    wo = db.query(WorkOrder).filter(WorkOrder.no == no).first()
    if not wo:
        raise HTTPException(status_code=404, detail="Innenauftrag nicht gefunden.")
    return wo


def _enrich_by_order(db: Session, wo: WorkOrder, by_order: list[dict]) -> list[dict]:
    """order_done-Status in die by_order-Zusammenfassung eintragen."""
    order_done = wo.order_done or {}
    for entry in by_order:
        ono = entry["order_no"]
        entry["done"] = ono in order_done
        entry["done_at"] = order_done.get(ono)
    return by_order


@router.get("/work-orders/{no}")
def get_work_order(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    """Der Innenauftrag mit allen Platten und der Zuordnung Teil → Kundenauftrag."""
    wo = _load_wo(db, no)
    items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
    by_plate: dict[int, list[WorkItem]] = {}
    for it in items:
        by_plate.setdefault(it.plate_id, []).append(it)
    # Halle: Marke → Auftrag ja, Kunde nein (services/floor_view.py).
    return floor_view.scrub({
        **_wo_out(wo).model_dump(),
        "plates": [
            {
                "id": p.id,
                "idx": p.idx,
                "fmt": p.fmt,
                "used_h": p.used_h,
                "turned": bool(p.turned),
                "n_parts": p.n_parts,
                "utilisation": round(p.utilisation, 4),
                "status": p.status.value if p.status else "open",
                "items": [
                    {
                        "tag": i.tag,
                        "order_no": i.order_no,
                        "customer": i.customer,
                        "customer_ref": i.customer_ref,
                        "label": i.label,
                        "od": i.od,
                        "di": i.di,
                        "from_remnant": i.from_remnant,
                        "position_id": i.position_id,
                    }
                    for i in sorted(by_plate.get(p.id, []), key=lambda x: x.tag)
                ],
            }
            for p in wo.plates
        ],
        # Zusammenfassung je Kundenauftrag — die Frage "was von diesem Auftrag
        # liegt auf dieser Platte" beantwortet sich damit ohne Suchen. Samt
        # Zusagedatum, Eilkennzeichen und der Angabe, ob der Auftrag hier
        # vollständig liegt: beim Verpacken ist genau das die Frage.
        "by_order": _enrich_by_order(db, wo, trace.work_order_trace(db, wo)),
        # Je Bestellposition eine Zeile: eine Zeichnung, eine Stückzahl, alle
        # Marken. Zwölf Einzelzeichnungen desselben Teils helfen niemandem —
        # der Bearbeiter will "dieses Teil, zwölfmal, Marken A03–A14".
        "by_part": _by_part(db, wo, items),
        # Die hergeleitete Schnittfolge samt Begründung. Sie steht hier, damit
        # die Oberfläche sie *anzeigen* kann statt danach zu fragen — der
        # Download holt sie sich ohnehin selbst noch einmal (`_wo_cut_plan`),
        # dieses Feld ist Anzeige, keine Eingabe.
        "cut_plan": _cut_plan_out(db, wo),
    }, floor_view.is_office(actor))


def _by_part(db: Session, wo: WorkOrder, items: list[WorkItem]) -> list[dict]:
    """Platzierungen wieder zu Bestellpositionen zusammenfassen."""
    groups: dict[int, dict] = {}
    for it in items:
        key = it.position_id or -abs(hash(it.label))
        g = groups.setdefault(
            key,
            {
                "position_id": it.position_id,
                "label": it.label,
                "order_no": it.order_no,
                "customer": it.customer,
                "customer_ref": it.customer_ref,
                "od": it.od,
                "di": it.di,
                "qty": 0,
                "tags": [],
                "n_from_remnant": 0,
                "plates": set(),
            },
        )
        g["qty"] += 1
        g["tags"].append(it.tag)
        if it.from_remnant:
            g["n_from_remnant"] += 1
        plate = db.get(WorkPlate, it.plate_id)
        if plate:
            g["plates"].add(plate.idx + 1)

    # Bohrbild und Kontur stehen an der Bestellposition, nicht am Platzhalter
    pos_ids = [k for k in groups if k and k > 0]
    positions = (
        {
            p.id: p
            for p in db.query(OrderPosition).filter(OrderPosition.id.in_(pos_ids)).all()
        }
        if pos_ids
        else {}
    )
    shape_ids = {p.shape_id for p in positions.values() if p.shape_id}
    shapes = (
        {s.id: s for s in db.query(LibraryShape).filter(LibraryShape.id.in_(shape_ids)).all()}
        if shape_ids
        else {}
    )

    out = []
    for key, g in groups.items():
        pos = positions.get(key)
        g["tags"] = sorted(g["tags"])
        g["plates"] = sorted(g["plates"])
        g["thk"] = float(pos.thk) if pos else float(wo.thk)
        g["bolt_count"] = int(pos.bolt_count) if pos else 0
        g["bolt_d"] = float(pos.bolt_d) if pos else 0.0
        g["bolt_circle"] = float(pos.bolt_circle) if pos else 0.0
        g["cut_len"] = float(pos.cut_len or 0) if pos else 0.0
        g["has_shape"] = bool(pos and pos.shape)
        # Der Weg zurück in die Formenbibliothek: dieselbe Kennung wie an der
        # Bestellposition. Leer bei DXF-Uploads und alten Aufträgen — die haben
        # eine Kontur, aber keine Hausform.
        g["shape_id"] = pos.shape_id if pos else None
        g["shape_key"] = shapes[pos.shape_id].key if pos and pos.shape_id in shapes else ""
        g["shape_label"] = shapes[pos.shape_id].label if pos and pos.shape_id in shapes else ""
        out.append(g)
    return sorted(out, key=lambda g: (g["order_no"], g["tags"][0] if g["tags"] else ""))


class PlateStatusIn(BaseModel):
    done: bool


@router.post("/work-orders/{no}/plates/{idx}/status")
def set_plate_status(
    no: str,
    idx: int,
    body: PlateStatusIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    """Der Werker hakt Platten ab, während der Innenauftrag geschnitten wird.

    Eine von zwei Routen auf demselben Pfad, beide bleiben: POST setzt nur den
    Haken (``done``, Audit-Eintrag an der Platte) und beendet nichts; PATCH (weiter
    unten, ``status``) schließt den Innenauftrag mit der letzten Platte selbst ab.
    Wer die Fertigmeldung ausdrücklich haben will, nimmt POST.

    Der Haken ist die Tatsache „diese Platte ist fertig" — er lebt am
    ``WorkPlate.status`` und damit dort, wo auch die Platte selbst liegt, nicht
    an einer Aufgabenzeile. Der Innenauftrag wird dadurch **nicht** fertig:
    die Fertigmeldung bleibt der eigene, ausdrückliche Statuswechsel — die
    Häkchen sind der Zwischenstand, der zeigt, welche Platte dran ist.
    """
    wo = _load_wo(db, no)
    if wo.status == WorkOrderStatus.cancelled:
        raise HTTPException(
            status_code=409,
            detail="Stornierter Innenauftrag kann nicht geändert werden.",
        )
    plate = next((p for p in wo.plates if p.idx == idx), None)
    if not plate:
        raise HTTPException(
            status_code=404, detail="Diese Platte gibt es im Auftrag nicht."
        )
    plate.status = WorkOrderStatus.done if body.done else WorkOrderStatus.open
    db.add(
        AuditLog(
            actor=actor.email,
            action="plate_status",
            entity="work_plate",
            entity_id=f"{no}#{idx}",
            detail={"done": body.done},
        )
    )
    db.commit()
    n_done = sum(1 for p in wo.plates if p.status == WorkOrderStatus.done)
    return {
        "no": wo.no,
        "idx": plate.idx,
        "status": plate.status.value,
        "n_plates": int(wo.n_plates or len(wo.plates)),
        "n_done": n_done,
    }


@router.get("/work-orders/{no}/plate/{idx}.svg", response_class=Response)
def plate_drawing(
    no: str,
    idx: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
    width: int = Query(default=900, ge=200, le=3000),
    download: bool = Query(default=False),
) -> Response:
    """Maßstäbliche Plattenzeichnung mit Marken.

    Mit `download=true` wird die Zeichnung als Datei angeboten statt
    angezeigt — für den Ausdruck oder die Ablage am Arbeitsplatz.
    """
    wo = _load_wo(db, no)
    plate = next((p for p in wo.plates if p.idx == idx), None)
    if not plate:
        raise HTTPException(
            status_code=404, detail="Diese Platte gibt es im Auftrag nicht."
        )
    # Die Zeichnung liegt an der Maschine: Marken und Aufträge ja, Kunden nur fürs Büro.
    svg = plate_svg(
        plate.fmt,
        floor_view.scrub(plate.placements or [], floor_view.is_office(actor)),
        title=f"{wo.mat_name or wo.mat} · {wo.thk:g} mm",
        plate_no=f"{wo.no} · Platte {idx + 1}/{wo.n_plates}{cutfiles.rev_label(wo)}",
        used_h=plate.used_h,
        turned=bool(plate.turned),
        width_px=width,
    )
    # Die Lage ist von Hand änderbar: der Browser darf nichts Altes zeigen.
    resp = Response(
        content=svg,
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-store"},
    )
    return _attachment(resp, f"{no}-Platte-{idx + 1}-Zeichnung.svg") if download else resp


@router.get("/work-orders/{no}/part/{position_id}.svg", response_class=Response)
def part_drawing(
    no: str,
    position_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
    width: int = Query(default=340, ge=120, le=1200),
    download: bool = Query(default=False),
) -> Response:
    """Bemaßte Zeichnung eines einzelnen Teils aus diesem Innenauftrag.

    Die Plattenzeichnung sagt, wo das Teil liegt; diese sagt, was es ist. Beide
    zusammen sind der Grund, warum niemand mehr in der Fertigung nachfragen muss.
    """
    wo = _load_wo(db, no)
    items = (
        db.query(WorkItem)
        .filter(WorkItem.work_order_id == wo.id, WorkItem.position_id == position_id)
        .all()
    )
    if not items:
        raise HTTPException(
            status_code=404, detail="Diese Position liegt nicht in dem Auftrag."
        )
    pos = db.get(OrderPosition, position_id)
    first = items[0]
    svg = part_svg(
        od=first.od,
        di=first.di,
        bolt_count=int(pos.bolt_count) if pos else 0,
        bolt_d=float(pos.bolt_d) if pos else 0.0,
        bolt_circle=float(pos.bolt_circle) if pos else 0.0,
        shape=(pos.shape if pos else None) or first.shape,
        label=first.label,
        tags=sorted(i.tag for i in items),
        qty=len(items),
        thk=float(pos.thk) if pos else float(wo.thk),
        order_no=first.order_no,
        customer=floor_view.customer_name(first.customer, floor_view.is_office(actor)),
        width_px=width,
    )
    resp = Response(content=svg, media_type="image/svg+xml")
    return _attachment(resp, f"{no}-Pos-{position_id}-Zeichnung.svg") if download else resp


# --------------------------------------------------------------------------
# Schnittdateien — drei Gruppen, weil drei verschiedene Fragen gestellt werden
# --------------------------------------------------------------------------
def _dxf(db: Session, wo: WorkOrder, content: str, filename: str) -> Response:
    """Die Datei ausliefern und festhalten, dass sie das Haus verlassen hat.

    ``no-store``: die Lage ist von Hand änderbar, und ein Browser, der eine alte
    Datei aus dem Cache holt, schneidet die alte Lage."""
    resp = Response(
        content=content,
        media_type="image/vnd.dxf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"',
                 "Cache-Control": "no-store"},
    )
    cutfiles.mark_issued(db, [wo])
    return resp


def _attachment(resp: Response, filename: str) -> Response:
    """Dieselbe Antwort, aber als Datei: der Browser speichert, statt sie
    anzuzeigen. Den Zeichnungen ist nichts anzusehen, was ein Download kaputt
    machen würde — dieselben Bytes, nur mit Namen. Die Laufkarte bettet als
    Datei ihr Skript ein (render/plate.py)."""
    resp.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp


def _plate_of(wo: WorkOrder, idx: int) -> WorkPlate:
    plate = next((p for p in wo.plates if p.idx == idx), None)
    if not plate:
        raise HTTPException(
            status_code=404, detail="Diese Platte gibt es im Auftrag nicht."
        )
    return plate


def _wo_cut_plan(db: Session, wo: WorkOrder, want: str | None = None) -> CutPlan:
    """Der Schnittplan dieses Innenauftrags — aus ``services/cutfiles``.

    Die Auflösung selbst steht im Dienst, weil die Fertigungsmeldung nach dem
    Sammellauf denselben Plan braucht und dort kein Router mitläuft. Was hier
    bleibt, ist die eine Sache, die *diese* Schicht angeht: aus einer
    unbekannten Bedienervorgabe wird eine 422 und keine Ausnahme.
    """
    try:
        return cutfiles.cut_plan(db, wo, want)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _cut_plan_out(db: Session, wo: WorkOrder) -> dict:
    """Der Schnittplan für die Oberfläche — mitsamt der Auswahlliste.

    Die Liste kommt vom Server und nicht aus dem Javascript, damit die
    Beschriftungen *und die Warnungen* an einer Stelle stehen: eine zweite
    Wortliste in der Oberfläche wäre die zweite Wahrheit über dieselbe Regel.
    Jede Wahlmöglichkeit trägt deshalb ihre eigene Warnung mit — sonst müsste
    die Oberfläche selbst wissen, welche Folge auf glattem Werkstoff schadet,
    und das ist genau das Wissen, das hierher gehört.
    """
    plan = _wo_cut_plan(db, wo)
    choices = [(MODE_AUTO, f"Automatisch — {plan.label}"),
               (MODE_CLASSIC, "Klassisch (Kontur/Loch)")] \
        + [(k, v) for k, v in STRATEGY_LABELS.items()]
    return {
        "layered": plan.layered,
        "strategy": plan.strategy,
        "label": plan.label,
        "machine_kind": plan.machine_kind,
        "grip": plan.grip,
        "mandatory": plan.mandatory,
        "reason": plan.reason,
        "warning": plan.warning,
        "choices": [
            {"value": value, "label": label,
             "warning": ("" if value == MODE_AUTO
                         else _wo_cut_plan(db, wo, value).warning)}
            for value, label in choices
        ],
    }


def _cut_choice(
    plotpro: Annotated[Optional[str], Query()] = None,
    strategy: Annotated[Optional[str], Query()] = None,
) -> str | None:
    """Die Wahl des Bedieners aus der Adresszeile, roh.

    Aufgelöst wird sie erst am Innenauftrag (``_wo_cut_plan``), weil erst dort
    Maschine und Werkstoff bekannt sind.

    ``plotpro`` nimmt ``auto`` (Vorgabe), ``klassisch`` oder eine Folge direkt.
    Die alten Werte bleiben gültig, damit ein gespeicherter Link nicht
    plötzlich etwas anderes herunterlädt: ``plotpro=1`` heißt geschichtet
    (mit ``strategy``, sonst der sicheren Folge), ``plotpro=0`` heißt
    klassisch. **Fehlt der Parameter ganz, gilt ``auto``** — und das ist die
    eigentliche Änderung: die sichere Datei ist die Vorgabe, nicht das
    Häkchen, das jemand setzen muss.
    """
    raw = (plotpro or "").strip().lower()
    if raw in ("0", "false", "no", "off", "nein"):
        return MODE_CLASSIC
    if raw in ("1", "true", "yes", "on", "ja"):
        # Geschichtet gewollt, aber ohne Angabe welcher Folge: das ist die
        # sichere, nicht die alte Vorgabe outside_in.
        return strategy or MODE_AUTO
    if raw in ("", MODE_AUTO):
        return strategy or MODE_AUTO
    return raw


@router.get("/work-orders/{no}/plate/{idx}.dxf")
def plate_cutfile(
    no: str,
    idx: int,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[User, Depends(require_worker)],
    want: Annotated[str | None, Depends(_cut_choice)] = None,
) -> Response:
    """Gruppe 1 — die Vollplatte: alles, was auf dieser Platte liegt.

    Das ist die Datei, die die Maschine schneidet. Aus der *gespeicherten*
    Belegung, nie neu geschachtelt: sonst zeigt die Datei an der Maschine etwas
    anderes als die Zeichnung auf dem Papier, sobald der Nester besser wird.

    **Die Schnittfolge wird hergeleitet, nicht abgefragt** (domain/cutting):
    aus der Maschinenart der zugeordneten Station und der Werkstoffgruppe. Ein
    Plotter auf glattem Werkstoff bekommt die geschichtete Datei, ein
    Wasserstrahl die klassische. ``?plotpro=klassisch`` oder
    ``?plotpro=<folge>`` überstimmt das; der Dateiname sagt, was drin ist.
    """
    wo = _load_wo(db, no)
    plate = _plate_of(wo, idx)
    plan = _wo_cut_plan(db, wo, want)
    content = plate_dxf(
        plate.fmt,
        plate.placements,
        header=cutfiles.plate_header(wo, plate, cutfiles.plan_header_suffix(plan)),
        used_h=plate.used_h,
        turned=bool(plate.turned),
        plotpro_strategy=plan.dxf_strategy,
    )
    name = f"{wo.no}-Platte-{idx + 1}{cutfiles.rev_suffix(wo)}{cutfiles.plan_suffix(plan)}.dxf"
    return _dxf(db, wo, content, name)


@router.get("/work-orders/{no}/plate/{idx}/auftrag/{order_no}.dxf")
def plate_cutfile_for_order(
    no: str,
    idx: int,
    order_no: str,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[User, Depends(require_worker)],
) -> Response:
    """Gruppe 2 — dieselbe Platte, nur die Teile eines Kundenauftrags.

    Nach dem Schnitt liegen fünfzig Teile auf dem Tisch und müssen wieder auf
    Aufträge verteilt werden. Die Teile behalten ihre Plattenposition, damit
    sich die Datei über die geschnittene Platte legen lässt.
    """
    wo = _load_wo(db, no)
    plate = _plate_of(wo, idx)
    mine = [it for it in (plate.placements or []) if it.get("order_no") == order_no]
    if not mine:
        raise HTTPException(
            status_code=404, detail=f"Von {order_no} liegt auf dieser Platte nichts."
        )
    content = plate_dxf(
        plate.fmt,
        plate.placements,
        only_order=order_no,
        header=cutfiles.plate_header(wo, plate, f" · nur {order_no}"),
        used_h=plate.used_h,
        turned=bool(plate.turned),
    )
    return _dxf(db, wo, content, f"{wo.no}-Platte-{idx + 1}{cutfiles.rev_suffix(wo)}-{order_no}.dxf")


@router.get("/work-orders/{no}/part/{position_id}.dxf")
def part_cutfile(
    no: str,
    position_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> Response:
    """Gruppe 3 — eine Form für sich, im Nullpunkt. Für Nachschnitt und Archiv."""
    wo = _load_wo(db, no)
    item = (
        db.query(WorkItem)
        .filter(WorkItem.work_order_id == wo.id, WorkItem.position_id == position_id)
        .first()
    )
    if not item:
        raise HTTPException(
            status_code=404, detail="Diese Position liegt nicht in dem Auftrag."
        )
    pos = db.get(OrderPosition, position_id)
    payload = {
        "od": item.od,
        "di": item.di,
        "shape": (pos.shape if pos else None) or item.shape,
        "bn": int(pos.bolt_count) if pos else 0,
        "bd": float(pos.bolt_d) if pos else 0.0,
        "bc": float(pos.bolt_circle) if pos else 0.0,
    }
    # Die Datei liegt an der Maschine: Auftragsnummer ja, Kundenname nur fürs Büro.
    who = floor_view.customer_name(item.customer, floor_view.is_office(actor))
    header = (
        f"{item.label} · {wo.mat_name or wo.mat} · {wo.thk:g} mm · "
        f"{item.order_no}" + (f" · {who}" if who else "")
    )
    return _dxf(db, wo, part_dxf(payload, header=header), f"{wo.no}-Pos-{position_id}.dxf")


@router.get("/work-orders/{no}/cutfiles.zip")
def cutfile_bundle(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
    want: Annotated[str | None, Depends(_cut_choice)] = None,
) -> Response:
    """Alle drei Gruppen in einem Bündel, in Ordnern.

    Ein Innenauftrag mit sechs Platten und vier Kunden ergibt sonst zwei Dutzend
    einzelne Klicks — und der erste, den jemand vergisst, ist der, der später
    fehlt. Die Schnittfolge der Vollplatten (Gruppe 1) steht wie beim
    Einzeldownload im Schnittplan; Je-Kunde und Einzelteile bleiben klassisch,
    weil sie zum Sortieren und ins Archiv gehen und nicht an die Maschine.
    """
    wo = _load_wo(db, no)
    plan = _wo_cut_plan(db, wo, want)
    resp = Response(
        content=cutfiles.bundle(db, wo, plan, office=floor_view.is_office(actor)),
        media_type="application/zip",
        headers={
            "Content-Disposition":
                f'attachment; filename="{wo.no}{cutfiles.rev_suffix(wo)}-Schnittdateien.zip"',
            "Cache-Control": "no-store",
        },
    )
    cutfiles.mark_issued(db, [wo])
    return resp


def _public_origin(request: Request) -> str:
    """Öffentliche Basis-URL aus Request / Proxy-Headern (ohne nachgestellten Slash)."""
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}".rstrip("/")


def _render_laufkarte_html(
    db: Session,
    wo: WorkOrder,
    *,
    office: bool,
    inline_script: bool,
    public_url: str = "",
    portal_url: str = "",
) -> str:
    station = db.get(FactoryStation, wo.station_id) if wo.station_id else None
    station_label = station.label if station else ""
    payload = {
        "no": wo.no,
        "run_no": wo.run.no if wo.run else "",
        "mat": wo.mat,
        "mat_name": wo.mat_name,
        "thk": wo.thk,
        "fmt": list(wo.fmt or []),
        "formats": wo.formats or [],
        "n_plates": wo.n_plates,
        "n_orders": wo.n_orders,
        "utilisation": wo.utilisation,
        "engine_version": wo.engine_version,
        "due_date": wo.due_date.isoformat() if wo.due_date else "",
        "release_reason": wo.release_reason or "",
        "policy_mode": wo.policy_mode or "",
        "nest_options": wo.nest_options or {},
        "created_at": wo.created_at.isoformat() if wo.created_at else "",
        "status": wo.status.value if wo.status else "",
        "cut_plan": _cut_plan_out(db, wo),
    }
    plates = [
        {
            "idx": p.idx,
            "fmt": p.fmt,
            "used_h": p.used_h,
            "turned": bool(p.turned),
            "utilisation": p.utilisation,
            "placements": p.placements,
        }
        for p in wo.plates
    ]
    items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
    parts = _by_part(db, wo, items)
    for part in parts:
        pos = (
            db.get(OrderPosition, part["position_id"])
            if part.get("position_id")
            else None
        )
        part["shape"] = pos.shape if pos else None
        part["position_id"] = part.get("position_id") or 0

    order_nos = sorted({it.order_no for it in items if it.order_no})
    orders_by_no: dict[str, dict] = {}
    for ono in order_nos:
        mine = [it for it in items if it.order_no == ono]
        pos_ids = [it.position_id for it in mine if it.position_id]
        pos_objs = (
            (db.query(OrderPosition).filter(OrderPosition.id.in_(pos_ids)).all())
            if pos_ids
            else []
        )
        order_obj = pos_objs[0].order if pos_objs else None
        n_parts = len(mine)
        ship = order_obj.ship_address if order_obj else {}
        part_groups: dict[int, dict] = {}
        for it in mine:
            pid = it.position_id or -abs(hash(it.label))
            pg = part_groups.setdefault(
                pid,
                {
                    "label": it.label,
                    "tags": [],
                    "qty": 0,
                    "from_remnant": 0,
                    "plates": set(),
                },
            )
            pg["tags"].append(it.tag)
            pg["qty"] += 1
            if it.from_remnant:
                pg["from_remnant"] += 1
            plate = db.get(WorkPlate, it.plate_id)
            if plate:
                pg["plates"].add(plate.idx + 1)
        parts_list = []
        for pg in part_groups.values():
            pg["tags"] = sorted(pg["tags"])
            pg["plates"] = sorted(pg["plates"])
            parts_list.append(pg)
        parts_list.sort(key=lambda g: (g["tags"][0] if g["tags"] else "",))
        orders_by_no[ono] = {
            "order_no": ono,
            "customer": mine[0].customer if mine else "",
            "customer_ref": order_obj.customer_ref if order_obj else "",
            "ship_name": ship.get("label") or ship.get("company") or "",
            "ship_street": ship.get("street", ""),
            "ship_zip": ship.get("zip", ""),
            "ship_city": ship.get("city", ""),
            "ship_country": ship.get("country", "DE"),
            "net": order_obj.net if order_obj else 0.0,
            "rush": bool(order_obj.rush) if order_obj else False,
            "n_parts": n_parts,
            "parts": parts_list,
            "tags": sorted({it.tag for it in mine}),
        }
    orders_summary = [orders_by_no[ono] for ono in order_nos]
    total_net = sum(o["net"] for o in orders_summary)

    manual_positions: list[dict] = []
    if order_nos:
        order_ids = [
            o.id for o in db.query(Order).filter(Order.no.in_(order_nos)).all()
        ]
        if order_ids:
            manual_rows = (
                db.query(OrderPosition)
                .filter(
                    OrderPosition.order_id.in_(order_ids),
                    OrderPosition.kind == "custom",
                )
                .all()
            )
            for mp in manual_rows:
                manual_positions.append(
                    {
                        "order_no": mp.order.no,
                        "order_no_raw": mp.order.no,
                        "customer": (mp.order.ship_address or {}).get("company")
                        or (mp.order.ship_address or {}).get("contact")
                        or "",
                        "label": mp.label,
                        "qty": mp.qty,
                        "note": mp.note or "",
                        "external_note": getattr(mp, "external_note", "") or "",
                        "price_gross": mp.price_gross or 0.0,
                    }
                )

    # Smarte Laufkarten-Zusatzdaten: Lagerorte, Reststücke, Chargen (EN 10204) & Team-Notizen
    from ..models import FactorySetting, MaterialLot, Offcut, StockLocation, TeamNote

    st_names = {s.id: s.label for s in db.query(FactoryStation).all()}
    loc_rows = db.query(StockLocation).filter(StockLocation.product_id == wo.mat).all()
    storage_locations = [
        f"{st_names.get(lr.station_id, 'Lager')}{' · ' + lr.bin if lr.bin else ''} ({lr.qty} Pl.)"
        for lr in loc_rows
    ]
    off_rows = (
        db.query(Offcut)
        .filter(Offcut.product_id == wo.mat, Offcut.status == "available")
        .order_by(Offcut.id.desc())
        .limit(6)
        .all()
    )
    available_offcuts = [
        f"{oc.code}: {oc.w:.0f}×{oc.h:.0f}×{oc.thk:g} mm{' (' + oc.bin + ')' if oc.bin else ''}"
        for oc in off_rows
    ]
    lot_rows = (
        db.query(MaterialLot)
        .filter(MaterialLot.product_id == wo.mat, MaterialLot.status == "available", MaterialLot.qty_remaining > 0)
        .order_by(MaterialLot.id.desc())
        .limit(10)
        .all()
    )
    material_lots = [
        {
            "code": lt.code,
            "label": f"{lt.code} · {lt.thk:g} mm ({lt.qty_remaining} Pl.){' · EN ' + lt.cert_type if lt.cert_type else ''}{' ' + lt.cert_ref if lt.cert_ref else ''}",
        }
        for lt in lot_rows
    ]
    note_rows = (
        db.query(TeamNote)
        .filter(
            TeamNote.archived.is_(False),
            TeamNote.entity_id.in_([wo.no, *order_nos]),
        )
        .order_by(TeamNote.id.desc())
        .limit(6)
        .all()
    )
    team_notes = [
        {
            "sender": n.sender_name or n.sender_email,
            "priority": n.priority,
            "subject": n.subject,
            "body": n.body or "",
        }
        for n in note_rows
    ]

    state_url = ""
    note_url = ""
    if not inline_script:
        if public_url:
            state_url = f"{public_url.rstrip('/')}/state"
            note_url = f"{public_url.rstrip('/')}/note"
        else:
            state_url = f"/api/production/work-orders/{wo.no}/traveller-state"
            note_url = "/api/notes"

    payload["planned_min"] = round(float(wo.planned_min or (wo.n_plates * 16.0)), 1)

    return work_order_html(
        payload,
        floor_view.scrub(plates, office),
        floor_view.scrub(parts, office),
        orders=floor_view.scrub(orders_summary, office),
        total_net=total_net if office else 0.0,
        manual_positions=floor_view.scrub(manual_positions, office),
        inline_script=inline_script,
        office=office,
        public_url=public_url,
        portal_url=portal_url,
        station_label=station_label,
        staged=bool(wo.material_staged_at),
        status=wo.status.value if wo.status else "",
        storage_locations=storage_locations,
        available_offcuts=available_offcuts,
        material_lots=material_lots,
        team_notes=team_notes,
        state_url=state_url,
        note_url=note_url,
    )


@router.get("/work-orders/{no}/sheet", response_class=HTMLResponse)
def traveller(
    no: str,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
    download: bool = Query(default=False),
) -> Response:
    """Die Laufkarte zum Ausdrucken und digitalen Abhaken.

    Ist für diesen Innenauftrag eine Netz-Freigabe aktiv, trägt der QR-Code
    direkt die Netz-URL der digitalen Laufkarte; sonst zeigt er auf das Portal.
    Mit ``download=true`` landet dieselbe Karte als autarke HTML-Datei auf dem Rechner."""
    wo = _load_wo(db, no)
    office = floor_view.is_office(actor)
    origin = _public_origin(request)
    share = laufkarte_share.get_share(db, wo.no)
    pub_url = (
        laufkarte_share.share_url(origin, share["token"])
        if (share and share.get("enabled") and share.get("token"))
        else ""
    )
    portal_url = f"{origin}/app#/produktion/{wo.no}"
    resp = HTMLResponse(
        _render_laufkarte_html(
            db,
            wo,
            office=office,
            inline_script=download,
            public_url=pub_url,
            portal_url=portal_url,
        )
    )
    return _attachment(resp, f"{no}-Laufkarte.html") if download else resp


# --------------------------------------------------------------------------
# Digitale Laufkarte — Opt-in Netz-Freigabe (/api/production/.../share + /laufkarte/{token})
# --------------------------------------------------------------------------
class LaufkarteShareIn(BaseModel):
    enabled: bool
    mode: str = "floor"
    expires_days: Optional[int] = Field(default=laufkarte_share.DEFAULT_EXPIRES_DAYS, ge=0, le=365)
    rotate: bool = False


def _share_out(origin: str, share: dict | None) -> dict:
    if not share:
        return {
            "enabled": False,
            "expired": False,
            "mode": "floor",
            "url": "",
            "token": "",
            "created_at": "",
            "created_by": "",
            "expires_at": None,
            "qr_svg": "",
        }
    url = laufkarte_share.share_url(origin, share["token"]) if (share["enabled"] and share["token"]) else ""
    return {
        "enabled": bool(share["enabled"]),
        "expired": bool(share.get("expired")),
        "mode": share["mode"],
        "url": url,
        "token": share["token"] if share["enabled"] else "",
        "created_at": share.get("created_at") or "",
        "created_by": share.get("created_by") or "",
        "expires_at": share.get("expires_at"),
        "qr_svg": qr_svg(url, size=144, quiet=2, label="QR-Code Digitale Laufkarte") if url else "",
    }


@router.get("/work-orders/{no}/share")
def get_laufkarte_share(
    no: str,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[User, Depends(require_worker)],
) -> dict:
    """Liest den aktuellen Freigabestand der digitalen Netz-Laufkarte."""
    wo = _load_wo(db, no)
    share = laufkarte_share.get_share(db, wo.no)
    return _share_out(_public_origin(request), share)


@router.post("/work-orders/{no}/share")
def update_laufkarte_share(
    no: str,
    body: LaufkarteShareIn,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Aktiviert, ändert oder pausiert die Netz-Freigabe der digitalen Laufkarte."""
    wo = _load_wo(db, no)
    if body.mode not in ("floor", "office"):
        raise HTTPException(status_code=422, detail="Modus muss 'floor' oder 'office' sein.")
    exp_days = None if (body.expires_days is None or body.expires_days == 0) else int(body.expires_days)
    share = laufkarte_share.set_share(
        db,
        wo.no,
        enabled=body.enabled,
        mode="office" if body.mode == "office" else "floor",
        expires_days=exp_days,
        rotate=body.rotate,
        actor_email=actor.email,
    )
    return _share_out(_public_origin(request), share)


@router.delete("/work-orders/{no}/share")
def delete_laufkarte_share(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[User, Depends(require_staff)],
) -> dict:
    """Widerruft die Netz-Freigabe sofort — bisherige Links liefern danach 404."""
    wo = _load_wo(db, no)
    laufkarte_share.revoke_share(db, wo.no)
    return _share_out("", None)


_PUBLIC_HEADERS = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
}


def _not_found_laufkarte() -> HTMLResponse:
    body = (
        '<!doctype html><html lang="de"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>Laufkarte nicht verfügbar</title>"
        "<style>body{margin:0;padding:40px 20px;font:14px/1.6 system-ui,sans-serif;background:#f4f5f7;color:#1f2937;}"
        ".box{max-width:460px;margin:0 auto;background:#fff;border:1px solid #d5d9df;border-radius:6px;padding:24px;}"
        "h1{margin:0 0 8px;font-size:18px;}p{margin:0;color:#4b5563;}</style></head><body>"
        '<div class="box"><h1>Digitale Laufkarte nicht verfügbar</h1>'
        "<p>Dieser Link ist nicht freigegeben, wurde widerrufen oder ist abgelaufen. "
        "Bitte im Gimel-Portal neu freigeben oder direkt im Leitstand öffnen.</p></div></body></html>"
    )
    return HTMLResponse(body, status_code=404, headers=_PUBLIC_HEADERS)


def _resolve_public_wo(db: Session, token: str) -> tuple[WorkOrder, dict] | None:
    hit = laufkarte_share.resolve_token(db, token)
    if not hit:
        return None
    wo_no, share = hit
    wo = db.query(WorkOrder).filter(WorkOrder.no == wo_no).first()
    if not wo or wo.status == WorkOrderStatus.cancelled:
        return None
    return wo, share


@public_router.get("/laufkarte/{token}", response_class=HTMLResponse, include_in_schema=False)
def public_laufkarte(
    token: str,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Öffentlich per Netz erreichbare digitale Laufkarte — nur nach ausdrücklicher Freigabe."""
    resolved = _resolve_public_wo(db, token)
    if not resolved:
        return _not_found_laufkarte()
    wo, share = resolved
    origin = _public_origin(request)
    pub_url = laufkarte_share.share_url(origin, share["token"])
    html_text = _render_laufkarte_html(
        db,
        wo,
        office=(share["mode"] == "office"),
        inline_script=False,
        public_url=pub_url,
    )
    return HTMLResponse(html_text, headers=_PUBLIC_HEADERS)


@public_router.get("/laufkarte/{token}/plate/{idx}.dxf", include_in_schema=False)
def public_laufkarte_plate_dxf(
    token: str,
    idx: int,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Token-gebundener Platten-DXF-Download einer freigegebenen digitalen Laufkarte."""
    resolved = _resolve_public_wo(db, token)
    if not resolved:
        raise HTTPException(status_code=404, detail="Laufkarte nicht freigegeben.")
    wo, _share = resolved
    plate = _plate_of(wo, idx)
    plan = _wo_cut_plan(db, wo, None)
    content = plate_dxf(
        plate.fmt,
        plate.placements,
        header=cutfiles.plate_header(wo, plate, cutfiles.plan_header_suffix(plan)),
        used_h=plate.used_h,
        turned=bool(plate.turned),
        plotpro_strategy=plan.dxf_strategy,
    )
    name = f"{wo.no}-Platte-{idx + 1}{cutfiles.rev_suffix(wo)}{cutfiles.plan_suffix(plan)}.dxf"
    resp = _dxf(db, wo, content, name)
    resp.headers.update(_PUBLIC_HEADERS)
    return resp


@public_router.get("/laufkarte/{token}/part/{position_id}.dxf", include_in_schema=False)
def public_laufkarte_part_dxf(
    token: str,
    position_id: int,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Token-gebundener Teil-DXF-Download einer freigegebenen digitalen Laufkarte."""
    resolved = _resolve_public_wo(db, token)
    if not resolved:
        raise HTTPException(status_code=404, detail="Laufkarte nicht freigegeben.")
    wo, share = resolved
    item = (
        db.query(WorkItem)
        .filter(WorkItem.work_order_id == wo.id, WorkItem.position_id == position_id)
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Position nicht gefunden.")
    pos = db.get(OrderPosition, position_id)
    payload = {
        "od": item.od,
        "di": item.di,
        "shape": (pos.shape if pos else None) or item.shape,
        "bn": int(pos.bolt_count) if pos else 0,
        "bd": float(pos.bolt_d) if pos else 0.0,
        "bc": float(pos.bolt_circle) if pos else 0.0,
    }
    who = floor_view.customer_name(item.customer, share["mode"] == "office")
    header = (
        f"{item.label} · {wo.mat_name or wo.mat} · {wo.thk:g} mm · "
        f"{item.order_no}" + (f" · {who}" if who else "")
    )
    resp = _dxf(db, wo, part_dxf(payload, header=header), f"{wo.no}-Pos-{position_id}.dxf")
    resp.headers.update(_PUBLIC_HEADERS)
    return resp


# --------------------------------------------------------------------------
# Smarter Laufschein — Live-Synchronisation (Fortschritt, Stoppuhr, Charge & Notiz)
# --------------------------------------------------------------------------
class TravellerStateIn(BaseModel):
    checked: dict[str, int] = Field(default_factory=dict)
    elapsed_sec: int = Field(default=0, ge=0, le=1_000_000)
    selected_lot: str = Field(default="", max_length=40)


def _read_traveller_state(db: Session, wo_no: str) -> dict:
    import json
    from ..models import FactorySetting

    row = db.get(FactorySetting, f"lk_state:{wo_no}")
    if not row or not row.value:
        return {"checked": {}, "elapsed_sec": 0, "selected_lot": "", "updated_at": None}
    try:
        data = json.loads(row.value)
        if isinstance(data, dict):
            return {
                "checked": data.get("checked") if isinstance(data.get("checked"), dict) else {},
                "elapsed_sec": int(data.get("elapsed_sec") or 0),
                "selected_lot": str(data.get("selected_lot") or ""),
                "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            }
    except Exception:  # noqa: BLE001
        pass
    return {"checked": {}, "elapsed_sec": 0, "selected_lot": "", "updated_at": None}


def _write_traveller_state(db: Session, wo_no: str, body: TravellerStateIn, actor: str) -> dict:
    import json
    from ..models import FactorySetting

    key = f"lk_state:{wo_no}"
    clean_checked = {str(k)[:60]: 1 for k, v in (body.checked or {}).items() if v}
    raw = json.dumps(
        {
            "checked": clean_checked,
            "elapsed_sec": int(body.elapsed_sec or 0),
            "selected_lot": body.selected_lot.strip()[:40],
        },
        separators=(",", ":"),
    )[:395]
    row = db.get(FactorySetting, key)
    if row is None:
        db.add(FactorySetting(key=key, value=raw, updated_by=actor))
    else:
        row.value = raw
        row.updated_by = actor
    db.commit()
    return _read_traveller_state(db, wo_no)


@router.get("/work-orders/{no}/traveller-state")
def get_traveller_state(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[User, Depends(require_worker)],
) -> dict:
    wo = _load_wo(db, no)
    return _read_traveller_state(db, wo.no)


@router.put("/work-orders/{no}/traveller-state")
def put_traveller_state(
    no: str,
    body: TravellerStateIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    wo = _load_wo(db, no)
    return _write_traveller_state(db, wo.no, body, actor.email)


@public_router.get("/laufkarte/{token}/state", include_in_schema=False)
def get_public_laufkarte_state(token: str, db: Annotated[Session, Depends(get_db)]) -> dict:
    resolved = _resolve_public_wo(db, token)
    if not resolved:
        raise HTTPException(404, "Laufkarte nicht freigegeben.")
    wo, _ = resolved
    return _read_traveller_state(db, wo.no)


@public_router.put("/laufkarte/{token}/state", include_in_schema=False)
def put_public_laufkarte_state(
    token: str, body: TravellerStateIn, db: Annotated[Session, Depends(get_db)]
) -> dict:
    resolved = _resolve_public_wo(db, token)
    if not resolved:
        raise HTTPException(404, "Laufkarte nicht freigegeben.")
    wo, _ = resolved
    return _write_traveller_state(db, wo.no, body, "laufkarte-netz")


class PublicLaufkarteNoteIn(BaseModel):
    sender_name: str = Field(default="Werkstatt", max_length=80)
    body: str = Field(min_length=1, max_length=1500)
    priority: str = Field(default="important", max_length=16)


@public_router.post("/laufkarte/{token}/note", include_in_schema=False)
def post_public_laufkarte_note(
    token: str, body: PublicLaufkarteNoteIn, db: Annotated[Session, Depends(get_db)]
) -> dict:
    from ..models import TeamNote

    resolved = _resolve_public_wo(db, token)
    if not resolved:
        raise HTTPException(404, "Laufkarte nicht freigegeben.")
    wo, _ = resolved
    prio = body.priority if body.priority in ("normal", "important", "urgent") else "important"
    note = TeamNote(
        sender_name=body.sender_name.strip() or "Werkstatt (Laufkarte)",
        channel="schicht",
        priority=prio,
        subject=f"Rückmeldung zu {wo.no}",
        body=body.body.strip(),
        entity_type="work_order",
        entity_id=wo.no,
    )
    db.add(note)
    db.commit()
    return {"ok": True, "id": note.id}


class StatusChange(BaseModel):
    status: WorkOrderStatus
    machine: str = ""
    note: str = ""


@router.post("/work-orders/{no}/status", response_model=WorkOrderOut)
def set_status(
    no: str,
    body: StatusChange,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> WorkOrderOut:
    """Der Werker meldet den Fortschritt.

    Bei ``done`` gehen alle enthaltenen Positionen auf ``done`` — das ist der
    Punkt, an dem der Kundenauftrag in der Fertigung wirklich weiter ist.
    """
    wo = _load_wo(db, no)
    if wo.status == WorkOrderStatus.cancelled and body.status != WorkOrderStatus.cancelled:
        raise HTTPException(
            status_code=409,
            detail="Stornierter Innenauftrag kann nicht wieder geöffnet werden.",
        )
    now = datetime.now(timezone.utc)
    if body.status == WorkOrderStatus.cancelled:
        from ..services.work_orders import cancel_work_order

        try:
            cancel_work_order(
                db, wo, actor=actor.email,
                reason=body.note or "von Hand storniert", commit=False,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        db.commit()
        db.refresh(wo)
        bus.publish(
            "work_order_status",
            {"work_order_no": wo.no, "status": "cancelled", "machine": body.machine},
        )
        return _wo_out(wo)

    wo.status = body.status
    if body.machine:
        wo.machine = body.machine
    if body.note:
        wo.note = body.note
    if body.status == WorkOrderStatus.running and not wo.started_at:
        wo.started_at, wo.started_by = now, actor.email
    if body.status == WorkOrderStatus.done:
        wo.done_at, wo.done_by = now, actor.email
        # Alle Platten und alle Positionen auf done setzen
        for p in wo.plates:
            p.status = WorkOrderStatus.done
        # Alle enthaltenen Kundenaufträge als fertig markieren
        items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
        item_orders = {i.order_no for i in items}
        wo.order_done = {ono: now.isoformat() for ono in item_orders}
        ids = [i.position_id for i in items if i.position_id]
        if ids:
            (
                db.query(OrderPosition)
                .filter(chunked_in(OrderPosition.id, ids))
                .update(
                    {OrderPosition.production_status: "done"}, synchronize_session=False
                )
            )
    db.add(
        AuditLog(
            actor=actor.email,
            action="work_order_status",
            entity="work_order",
            entity_id=wo.no,
            detail={"status": body.status.value, "machine": body.machine},
        )
    )
    db.commit()
    db.refresh(wo)
    bus.publish(
        "work_order_status",
        {"work_order_no": wo.no, "status": wo.status.value, "machine": wo.machine},
    )
    return _wo_out(wo)


# --------------------------------------------------------------------------
# Materialbereitstellen — der Schritt zwischen Zuordnung und Schnittstart
# --------------------------------------------------------------------------
class StageChange(BaseModel):
    staged: bool = True
    note: str = ""
    #: Aus welchem Lagerort die Platten geholt wurden. Leer ist erlaubt —
    #: nicht jeder Werkstoff hat einen hinterlegten Ort, und ein erfundener
    #: wäre schlechter als „unbekannt".
    location_id: Optional[int] = None


@router.post("/work-orders/{no}/stage", response_model=WorkOrderOut)
def set_material_staged(
    no: str,
    body: StageChange,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> WorkOrderOut:
    """Jemand hat die Platten dieses Innenauftrags an die Maschine gebracht.

    Kein Status, sondern ein Schritt mit Zeitpunkt: die Bereitstellung ist
    physische Arbeit (Regal → Wagen → Maschine), und die Liste „was ist noch
    nicht an der Maschine" ist genau dann ehrlich, wenn sie aus Abstrichen
    besteht, die jemand wirklich gemacht hat. Zurücknehmen geht, solange
    nicht geschnitten wurde — verschrieben hat sich ja mal jemand.

    ``location_id`` hält zusätzlich fest, aus welchem Regal die Platten kamen.
    Geprüft wird nur der Werkstoff: ein Fach mit gemischten Dicken ist eine
    gültige Antwort, der Werker sieht die Platte vor sich.
    """
    wo = _load_wo(db, no)
    if wo.status in (WorkOrderStatus.done, WorkOrderStatus.cancelled):
        raise HTTPException(
            status_code=409,
            detail="Fertige und stornierte Innenaufträge brauchen kein Material mehr.",
        )
    location: StockLocation | None = None
    if body.staged and body.location_id is not None:
        location = db.get(StockLocation, body.location_id)
        if location is None:
            raise HTTPException(status_code=404, detail="Lagerort nicht gefunden.")
        if location.product_id != wo.mat:
            raise HTTPException(
                status_code=409,
                detail="Der Lagerort gehört zu einem anderen Werkstoff.",
            )
    if body.staged:
        if wo.material_staged_at:
            raise HTTPException(
                status_code=409,
                detail="Material ist bereits als bereitgestellt gebucht.",
            )
        wo.material_staged_at = datetime.now(timezone.utc)
        wo.material_staged_by = actor.email
        wo.material_staged_location_id = location.id if location else None
        wo.material_staged_location = stockloc.describe(db, location) if location else ""
    else:
        if wo.started_at:
            raise HTTPException(
                status_code=409,
                detail="Der Innenauftrag läuft schon — Bereitstellung lässt sich nicht zurücknehmen.",
            )
        wo.material_staged_at = None
        wo.material_staged_by = ""
        wo.material_staged_location_id = None
        wo.material_staged_location = ""
    db.add(
        AuditLog(
            actor=actor.email,
            action="work_order_stage" if body.staged else "work_order_unstage",
            entity="work_order",
            entity_id=wo.no,
            detail={
                "staged": body.staged,
                "note": body.note,
                "location": wo.material_staged_location or "",
                "location_id": wo.material_staged_location_id,
            },
        )
    )
    db.commit()
    db.refresh(wo)
    bus.publish(
        "work_order_stage",
        {"work_order_no": wo.no, "staged": body.staged},
    )
    return _wo_out(wo)


class PlateStatusChange(BaseModel):
    status: WorkOrderStatus


# --------------------------------------------------------------------------
# Kundenauftrag abschließen — einzelnen Auftrag auf einer Platte fertig melden
# --------------------------------------------------------------------------
class OrderDoneToggle(BaseModel):
    done: bool = True


@router.post("/work-orders/{no}/orders/{order_no}/done")
def toggle_order_done(
    no: str,
    order_no: str,
    body: OrderDoneToggle,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    """Einzelnen Kundenauftrag innerhalb eines Innenauftrags als fertig markieren.

    Der Werker schneidet eine Platte mit Teilen aus fünf Aufträgen. Vier davon
    liegen komplett auf dieser Platte — er sortiert sie aus, packt sie ein und
    markiert sie als fertig. Der fünfte hat noch Teile auf der nächsten Platte
    und bleibt offen. Das Häkchen steht für „dieser Auftrag ist hier fertig
    geschnitten und sortiert", nicht für „der Innenauftrag ist durch".

    Die Bestellpositionen dieses Auftrags werden ebenfalls auf ``done`` gesetzt
    (bzw. auf ``batched`` zurückgesetzt), damit der Fertigungsstatus in der
    Auftragsverfolgung und im Portal sichtbar wird.
    """
    wo = _load_wo(db, no)
    if wo.status == WorkOrderStatus.cancelled:
        raise HTTPException(
            status_code=409,
            detail="Stornierter Innenauftrag kann nicht geändert werden.",
        )

    # Prüfen, dass dieser Auftrag überhaupt in diesem Innenauftrag vorkommt
    item_orders = {
        i.order_no
        for i in db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
    }
    if order_no not in item_orders:
        raise HTTPException(
            status_code=404,
            detail=f"Auftrag {order_no} kommt in Innenauftrag {no} nicht vor.",
        )

    order_done = dict(wo.order_done or {})
    now = datetime.now(timezone.utc).isoformat()
    if body.done:
        order_done[order_no] = now
    else:
        order_done.pop(order_no, None)

    wo.order_done = order_done

    # Bestellpositionen dieses Auftrags auf den Fertigungsstatus setzen,
    # damit die Verfolgung (trace.py) und das Portal den Stand anzeigen.
    ids = [
        i.position_id
        for i in db.query(WorkItem)
        .filter(WorkItem.work_order_id == wo.id, WorkItem.order_no == order_no)
        .all()
        if i.position_id
    ]
    if ids:
        new_status = "done" if body.done else "batched"
        (
            db.query(OrderPosition)
            .filter(OrderPosition.id.in_(ids))
            .update(
                {OrderPosition.production_status: new_status}, synchronize_session=False
            )
        )

    db.add(
        AuditLog(
            actor=actor.email,
            action="order_done_toggle",
            entity="work_order",
            entity_id=wo.no,
            detail={
                "order_no": order_no,
                "done": body.done,
                "positions_updated": len(ids),
            },
        )
    )
    db.commit()
    db.refresh(wo)

    bus.publish(
        "order_done_toggle",
        {"work_order_no": wo.no, "order_no": order_no, "done": body.done},
    )

    return {
        "no": wo.no,
        "order_no": order_no,
        "done": body.done,
        "done_at": order_done.get(order_no),
        "order_done": order_done,
        "positions_updated": len(ids),
    }


@router.patch("/work-orders/{no}/plates/{idx}/status")
def set_plate_status_and_finish(
    no: str,
    idx: int,
    body: PlateStatusChange,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    """Einzelne Platte als fertig oder offen markieren, mit Folgen.

    Das Gegenstück zu POST auf demselben Pfad (siehe dort), das nur abhakt: diese
    Route ist die, die den Innenauftrag fertig meldet und wieder öffnet.

    Wenn alle Platten eines Innenauftrags fertig sind, wird der gesamte
    Innenauftrag automatisch auf ``done`` gesetzt und die Positionen gehen
    auf ``done`` über — das ist der Punkt, an dem der Kundenauftrag in der
    Fertigung wirklich weiter ist.
    """
    wo = _load_wo(db, no)
    if wo.status == WorkOrderStatus.cancelled:
        raise HTTPException(
            status_code=409,
            detail="Stornierter Innenauftrag kann nicht geändert werden.",
        )
    if body.status == WorkOrderStatus.cancelled:
        raise HTTPException(
            status_code=409,
            detail="Eine einzelne Platte kann nicht storniert werden.",
        )
    plate = None
    for p in wo.plates:
        if p.idx == idx:
            plate = p
            break
    if not plate:
        raise HTTPException(404, f"Platte {idx} existiert nicht im Auftrag {no}.")

    now = datetime.now(timezone.utc)
    plate.status = body.status

    # Prüfen: alle Platten fertig? → Innenauftrag abschließen
    all_done = all(p.status == WorkOrderStatus.done for p in wo.plates)
    wo_updated = False
    if all_done and wo.status != WorkOrderStatus.done:
        wo.status = WorkOrderStatus.done
        wo.done_at = now
        wo.done_by = actor.email
        wo_updated = True
        # Alle enthaltenen Kundenaufträge als fertig markieren
        items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
        item_orders = {i.order_no for i in items}
        wo.order_done = {ono: now.isoformat() for ono in item_orders}
        ids = [i.position_id for i in items if i.position_id]
        if ids:
            (
                db.query(OrderPosition)
                .filter(chunked_in(OrderPosition.id, ids))
                .update(
                    {OrderPosition.production_status: "done"}, synchronize_session=False
                )
            )
    elif not all_done and wo.status == WorkOrderStatus.done:
        # Platte wieder geöffnet → IA wieder open und Positionen zurück auf batched
        wo.status = WorkOrderStatus.open
        wo.done_at = None
        wo.done_by = ""
        wo.order_done = {}
        wo_updated = True
        ids = [
            i.position_id
            for i in db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
            if i.position_id
        ]
        if ids:
            (
                db.query(OrderPosition)
                .filter(chunked_in(OrderPosition.id, ids))
                .filter(OrderPosition.production_status == "done")
                .update(
                    {OrderPosition.production_status: "batched"},
                    synchronize_session=False,
                )
            )

    db.add(
        AuditLog(
            actor=actor.email,
            action="plate_status",
            entity="work_order",
            entity_id=wo.no,
            detail={"plate_idx": idx, "status": body.status.value, "wo_done": all_done},
        )
    )
    db.commit()
    db.refresh(wo)

    bus.publish(
        "plate_status",
        {
            "work_order_no": wo.no,
            "plate_idx": idx,
            "status": body.status.value,
            "wo_done": all_done,
        },
    )

    return {
        **_wo_out(wo).model_dump(),
        "plate_updated": idx,
        "all_plates_done": all_done,
    }
