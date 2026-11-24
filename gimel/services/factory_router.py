"""Die Naht zwischen Datenbank und Zuordnungskern.

Hier steht kein einziger Punktwert. Diese Datei liest Zeilen, baut daraus die
Werttypen aus ``domain/routing.py``, gibt sie hinein und schreibt zurück, was
herauskam. Wer die Regeln ändern will, ändert den Kern; wer die Anbindung
ändern will, ändert diese Datei. Das ist dieselbe Trennung, die der
Rechenkern der Preise hat (CLAUDE.md §3 „Rule: the engine is pure").

Drei Dinge passieren hier und sonst nirgends:

1. **Warteschlangen**: was einer Station schon zugeordnet und noch nicht
   fertig ist, ergibt ihre belegten Minuten — die Eingabe der
   Fertigstellungszeit.
2. **Rüstzustand**: der zuletzt an einer Station eingeplante Werkstoff, damit
   der Wechselfaktor weiß, was aufgespannt ist.
3. **Auftragbuch als einzige Historie**: die Kundenbindung des Bearbeiters
   liest hier, wer welche Aufträge tatsächlich bearbeitet hat — abgefragt im
   Moment der Entscheidung, ohne eigenen Lerndatenbestand. Was die
   Zuordnung weiß, steht in den Tabellen der Buchhaltung, und nirgends
   sonst.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional, Sequence

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.layout import Layout, Route
from ..core.routing import (
    Assessment,
    HandlerAssessment,
    HandlerSpec,
    JobSpec,
    OrderSpec,
    RoutingContext,
    StationSpec,
    Suggestion,
    Weights,
    assess,
    job_minutes,
    needs_changeover,
    plan_job,
    rank_handlers,
    rank_stations,
)
from ..models import (
    FactoryFloor,
    FactorySetting,
    FactoryStation,
    Order,
    OrderPosition,
    Role,
    User,
    WorkItem,
    WorkOrder,
    WorkOrderStatus,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


OPEN_STATUSES = (WorkOrderStatus.open, WorkOrderStatus.running)


# --------------------------------------------------------------------------
# Einstellungen
# --------------------------------------------------------------------------
def setting(db: Session, key: str, default: str = "") -> str:
    row = db.get(FactorySetting, key)
    return row.value if row and row.value != "" else default


def set_setting(db: Session, key: str, value: str, who: str = "") -> None:
    row = db.get(FactorySetting, key)
    if row:
        row.value = value
        row.updated_by = who
    else:
        db.add(FactorySetting(key=key, value=value, updated_by=who))


def auto_routing_enabled(db: Session) -> bool:
    """Der globale Hauptschalter. Aus heißt: nichts wird von selbst zugeteilt.

    Bewusst voreingestellt auf **aus**. Eine Halle, die beim ersten Start
    anfängt, Aufträge auf Maschinen zu schieben, deren Parameter noch niemand
    eingetragen hat, verliert das Vertrauen, bevor sie es verdient hat.
    """
    return setting(db, "auto_routing", "0") == "1"


def weights_from_settings(db: Session) -> Weights:
    """Gewichte, sofern der Betrieb sie überschrieben hat.

    Ein altes ``weight_experience`` in der Tabelle wird bewusst ignoriert:
    der Faktor existiert nicht mehr, die Zuordnung lernt nicht.
    """
    base = Weights()
    vals = {}
    for f in ("changeover", "distance", "speed", "load", "fit", "deadline"):
        raw = setting(db, f"weight_{f}", "")
        if raw:
            try:
                vals[f] = max(0.0, float(raw))
            except ValueError:
                continue
    return Weights(**{**base.__dict__, **vals}) if vals else base


# --------------------------------------------------------------------------
# Zeilen → Werttypen
# --------------------------------------------------------------------------
def layout_of(db: Session, floor_id: Optional[int] = None) -> Layout:
    row = db.get(FactoryFloor, floor_id) if floor_id else None
    if row is None:
        row = db.query(FactoryFloor).order_by(FactoryFloor.id.asc()).first()
    return Layout.from_row(row)


def _placement(db: Session) -> tuple[Optional[int], dict[int, Optional[int]]]:
    """Erste Ebene und Halle je Ebene — die Heimat der Stationen ohne Ebene."""
    rows = db.query(FactoryFloor.id, FactoryFloor.hall_id).order_by(FactoryFloor.id).all()
    halls = {int(i): (int(h) if h else None) for i, h in rows}
    return (min(halls) if halls else None), halls


def _queue_minutes(db: Session) -> dict[int, float]:
    """Belegte Minuten je Station aus den noch offenen Innenaufträgen."""
    rows = (
        db.query(WorkOrder.station_id, func.sum(WorkOrder.planned_min))
        .filter(WorkOrder.station_id.isnot(None))
        .filter(WorkOrder.status.in_(OPEN_STATUSES))
        .group_by(WorkOrder.station_id)
        .all()
    )
    return {int(sid): float(m or 0.0) for sid, m in rows if sid is not None}


def _last_job(db: Session) -> dict[int, tuple[str, float]]:
    """Werkstoff und Dicke des zuletzt an einer Station eingeplanten Auftrags.

    „Zuletzt" heißt: der jüngste zugeordnete Innenauftrag, unabhängig davon,
    ob er schon fertig ist — es geht um das, was aufgespannt ist bzw. zuletzt
    war, nicht um den Fertigungsstand.
    """
    out: dict[int, tuple[str, float]] = {}
    rows = (
        db.query(WorkOrder)
        .filter(WorkOrder.station_id.isnot(None))
        .order_by(WorkOrder.id.desc())
        .limit(400)
        .all()
    )
    # Nach Zuordnungszeitpunkt, wo es einen gibt — sonst nach Anlage. In Python
    # sortiert, weil SQL-Dialekte NULL verschieden einordnen und die Antwort
    # auf „was ist aufgespannt" nicht von der Datenbank abhängen darf.
    rows.sort(
        key=lambda w: (w.assigned_at is not None, w.assigned_at or w.created_at, w.id),
        reverse=True,
    )
    for wo in rows:
        if wo.station_id is None or wo.station_id in out:
            continue
        if wo.status == WorkOrderStatus.cancelled:
            continue
        out[int(wo.station_id)] = (wo.mat, float(wo.thk or 0.0))
    return out


def station_spec(
    s: FactoryStation,
    queue: dict[int, float],
    last: dict[int, tuple[str, float]],
    placement: Optional[tuple[Optional[int], dict[int, Optional[int]]]] = None,
) -> StationSpec:
    lj = last.get(s.id)
    default_floor, floor_hall = placement or (None, {})
    fid = int(s.floor_id) if getattr(s, "floor_id", None) else default_floor
    return StationSpec(
        floor_id=fid,
        hall_id=floor_hall.get(fid) if fid is not None else None,
        id=s.id,
        label=s.label,
        type=s.type.value if hasattr(s.type, "value") else str(s.type),
        x=float(s.x or 0.0),
        y=float(s.y or 0.0),
        active=bool(s.active),
        routing=s.routing.value if hasattr(s.routing, "value") else str(s.routing),
        machine_kind=s.machine_kind or "",
        materials=list(s.materials or []),
        thicknesses=[float(t) for t in (s.thicknesses or [])],
        assigned_users=[int(u) for u in (s.assigned_users or [])],
        speed_mm_s=float(s.speed_mm_s or 0.0),
        pierce_s=float(s.pierce_s or 0.0),
        setup_min=float(s.setup_min or 0.0),
        changeover_min=float(s.changeover_min or 0.0),
        handling_min_per_plate=float(s.handling_min_per_plate or 0.0),
        max_sheet_w=float(s.max_sheet_w or 0.0),
        max_sheet_h=float(s.max_sheet_h or 0.0),
        thk_min=float(s.thk_min or 0.0),
        thk_max=float(s.thk_max or 0.0),
        cost_per_h=float(s.cost_per_h or 0.0),
        capacity_min_per_day=float(s.capacity_min_per_day or 0.0),
        is_storage=bool(s.is_storage),
        queue_min=queue.get(s.id, 0.0),
        last_mat=lj[0] if lj else None,
        last_thk=lj[1] if lj else None,
    )


def station_specs(
    db: Session, stations: Optional[Sequence[FactoryStation]] = None
) -> list[StationSpec]:
    rows = (
        list(stations)
        if stations is not None
        else (db.query(FactoryStation).order_by(FactoryStation.id.asc()).all())
    )
    queue = _queue_minutes(db)
    last = _last_job(db)
    place = _placement(db)
    return [station_spec(s, queue, last, place) for s in rows]


def job_spec(db: Session, wo: WorkOrder) -> JobSpec:
    """Ein Innenauftrag als Rechenkern-Eingabe.

    Die Schnittlänge kommt aus den Bestellpositionen, nicht aus einer
    Schätzung über die Fläche: ``OrderPosition.cut_len`` ist die echte
    Konturlänge aus ``geometry.js`` (CLAUDE.md §2.1), und der Innenauftrag
    weiß über seine Marken, welche Positionen auf seinen Platten liegen.
    """
    items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
    pos_ids = {int(i.position_id) for i in items if i.position_id}
    cut_len = 0.0
    if pos_ids:
        rows = (
            db.query(
                OrderPosition.id,
                OrderPosition.cut_len,
                OrderPosition.od,
                OrderPosition.di,
                OrderPosition.bolt_count,
                OrderPosition.bolt_d,
            )
            .filter(OrderPosition.id.in_(pos_ids))
            .all()
        )
        per_pos = {int(r[0]): r for r in rows}
        for it in items:
            r = per_pos.get(int(it.position_id or 0))
            if not r:
                continue
            _, cl, od, di, nb, bd = r
            if cl and cl > 0:
                cut_len += float(cl)
            else:
                # Ringformel — dieselbe wie im Preiskern (CLAUDE.md §5.2),
                # damit Zeit und Preis nicht von verschiedenen Längen reden.
                import math

                cut_len += math.pi * (float(od or 0.0) + float(di or 0.0))
                cut_len += int(nb or 0) * math.pi * float(bd or 0.0)

    plate = (0.0, 0.0)
    for p in wo.plates:
        fmt = list(p.fmt or [])
        if len(fmt) >= 2:
            plate = max(
                plate, (float(fmt[0]), float(fmt[1])), key=lambda t: t[0] * t[1]
            )
    if plate == (0.0, 0.0) and wo.fmt:
        fmt = list(wo.fmt or [])
        if len(fmt) >= 2:
            plate = (float(fmt[0]), float(fmt[1]))

    refs = sorted({i.customer_ref for i in items if i.customer_ref})
    order_nos = {i.order_no for i in items if i.order_no}
    rush = False
    due_days: Optional[float] = None
    # SQLite speichert Zeitstempel ohne Zeitzone; _now() trägt eine. Erst
    # angleichen, sonst stirbt die Rechnung — und mit ihr der ganze Planer,
    # sobald ein Auftrag ein Fälligkeitsdatum hat.
    now = _now()

    def days_until(dt: datetime) -> float:
        d = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        return (d - now).total_seconds() / 86400.0

    if order_nos:
        for o in db.query(Order).filter(Order.no.in_(order_nos)).all():
            rush = rush or bool(o.rush)
            if o.due_date:
                d = days_until(o.due_date)
                due_days = d if due_days is None else min(due_days, d)
    if wo.due_date:
        d = days_until(wo.due_date)
        due_days = d if due_days is None else min(due_days, d)

    allowed, scope_label = scope_of(db, getattr(wo, "route_scope", "") or "")
    return JobSpec(
        no=wo.no,
        mat=wo.mat,
        mat_name=wo.mat_name or "",
        thk=float(wo.thk or 0.0),
        n_plates=int(wo.n_plates or 0) or 1,
        n_parts=int(wo.n_parts or 0),
        cut_len_mm=cut_len,
        plate_mm=plate,
        rush=rush,
        due_in_days=due_days,
        customer_refs=refs,
        allowed_floors=allowed,
        scope_label=scope_label,
    )


def scope_of(db: Session, raw: str) -> tuple[Optional[frozenset[int]], str]:
    """Fertigungsort-Vorgabe → (erlaubte Ebenen, Klartext). Kaputt = nirgends."""
    from . import sites

    if not raw:
        return None, ""
    topo = sites.topology(db)
    try:
        sc = sites.parse(raw)
    except sites.ScopeError:
        return frozenset(), f"ungültige Vorgabe „{raw}“"
    return sites.allowed_floors(sc, topo), sites.label(sc, topo)


def context(db: Session) -> RoutingContext:
    """Der Rechenkern-Kontext — Halle, Gewichte, Gehgeschwindigkeit.

    Kein Verlauf, keine Zähler: dieselben Tabellen ergeben jederzeit
    dieselbe Bewertung. Was der Kern über Vergangenes weiß, sind allein die
    Fakten der Buchhaltung (Warteschlange, Rüstzustand, Auftragsbuch).
    """
    walk = 60.0
    raw = setting(db, "walk_m_per_min", "")
    if raw:
        try:
            walk = max(1.0, float(raw))
        except ValueError:
            pass
    from ..core.routing import HallGeo
    from ..models import FactoryHall

    floors = db.query(FactoryFloor).order_by(FactoryFloor.id.asc()).all()
    halls = {
        h.id: HallGeo(float(h.lat), float(h.lon), float(h.rotation_deg or 0.0), h.site_id)
        for h in db.query(FactoryHall).all()
        if h.lat or h.lon
    }
    return RoutingContext(
        layout=Layout.from_row(floors[0] if floors else None),
        weights=weights_from_settings(db),
        walk_m_per_min=walk,
        layouts={f.id: Layout.from_row(f) for f in floors},
        halls=halls,
    )


# --------------------------------------------------------------------------
# Maschinenzuordnung
# --------------------------------------------------------------------------
def rank_for_work_order(db: Session, wo: WorkOrder) -> list[Assessment]:
    return rank_stations(job_spec(db, wo), station_specs(db), context(db))


def rank_for_job(db: Session, job: JobSpec) -> list[Assessment]:
    """Ranking für einen frei definierten Job — die Simulation."""
    return rank_stations(job, station_specs(db), context(db))


def suggest_for_work_order(db: Session, wo: WorkOrder) -> Suggestion:
    return plan_job(job_spec(db, wo), station_specs(db), context(db))


def assign(
    db: Session,
    wo: WorkOrder,
    station_id: Optional[int],
    *,
    mode: str,
    who: str = "",
    score: float = 0.0,
    reason: str = "",
) -> WorkOrder:
    """Einen Innenauftrag einer Station zuordnen (oder die Zuordnung lösen).

    Die geplante Belegzeit wird hier festgeschrieben, nicht später gerechnet:
    ändert jemand morgen den Vorschub der Maschine, darf sich die
    Warteschlange von gestern nicht rückwirkend verschieben.
    """
    if station_id is None:
        wo.station_id = None
        wo.assign_mode = ""
        wo.assign_score = 0.0
        wo.assign_reason = ""
        wo.assigned_at = None
        wo.assigned_by = who
        wo.planned_min = 0.0
        db.commit()
        return wo

    st = db.get(FactoryStation, station_id)
    if st is None:
        raise ValueError("Station nicht gefunden.")

    specs = station_specs(db)
    spec = next((s for s in specs if s.id == station_id), None)
    job = job_spec(db, wo)
    if spec is not None and job.allowed_floors is not None and spec.floor_id not in job.allowed_floors:
        # Die Vorgabe gilt auch für die Hand: wer woanders fertigen will,
        # ändert erst die Vorgabe — sichtbar und protokolliert.
        raise ValueError(
            f"{st.label} liegt außerhalb der Vorgabe ({job.scope_label}). "
            "Erst den Fertigungsort des Innenauftrags ändern."
        )
    minutes = 0.0
    if spec is not None:
        m = job_minutes(job, spec, needs_changeover(job, spec))
        minutes = m or 0.0
        if not reason:
            from ..core.routing import assess

            reason = assess(job, spec, specs, context(db)).summary

    wo.station_id = station_id
    wo.assign_mode = mode
    wo.assign_score = float(score)
    wo.assign_reason = (reason or "")[:400]
    wo.assigned_at = _now()
    wo.assigned_by = who
    wo.planned_min = minutes
    if st.machine_kind or st.label:
        wo.machine = st.label
    db.commit()
    return wo


def plan_open_work_orders(
    db: Session, *, limit: int = 60, include_assigned: bool = False
) -> list[Suggestion]:
    """Vorschläge für alles, was noch keine Maschine hat.

    Rechnet vor, ändert nichts. Anwenden ist ein zweiter, ausdrücklicher
    Schritt (``apply_plan``) — auch wenn der Hauptschalter an ist, damit die
    Oberfläche zeigen kann, *was* passieren würde.
    """
    q = db.query(WorkOrder).filter(WorkOrder.status.in_(OPEN_STATUSES))
    if not include_assigned:
        q = q.filter(WorkOrder.station_id.is_(None))
    rows = q.order_by(WorkOrder.created_at.asc()).limit(limit).all()
    if not rows:
        return []

    specs = station_specs(db)
    ctx = context(db)
    out: list[Suggestion] = []
    # Der Reihe nach planen, und jede Zuteilung dem nächsten mitgeben: sonst
    # empfiehlt der Planer zwanzigmal dieselbe schnellste Maschine und die
    # Halle steht daneben. Das ist derselbe Gedanke wie bei der Freigabe —
    # eine Entscheidung, die die nächste nicht kennt, ist keine Planung.
    by_id = {s.id: s for s in specs}
    for wo in rows:
        job = job_spec(db, wo)
        sug = plan_job(job, specs, ctx)
        out.append(sug)
        if sug.station_id is not None and sug.station_id in by_id:
            s = by_id[sug.station_id]
            m = job_minutes(job, s, needs_changeover(job, s)) or 0.0
            s.queue_min += m
            s.last_mat, s.last_thk = job.mat, job.thk
    return out


def apply_plan(
    db: Session,
    suggestions: Iterable[Suggestion],
    *,
    who: str = "",
    only_auto: bool = True,
) -> list[dict]:
    """Vorschläge übernehmen. ``only_auto`` folgt dem Opt-in der Station."""
    applied: list[dict] = []
    for sug in suggestions:
        if sug.station_id is None:
            continue
        if only_auto and sug.mode != "auto":
            continue
        wo = db.query(WorkOrder).filter(WorkOrder.no == sug.job_no).first()
        if not wo or wo.station_id is not None:
            continue
        assign(
            db,
            wo,
            sug.station_id,
            mode=sug.mode,
            who=who,
            score=sug.score,
            reason=sug.reason,
        )
        applied.append(
            {
                "job_no": sug.job_no,
                "station_id": sug.station_id,
                "label": sug.label,
                "score": round(sug.score, 1),
                "reason": sug.reason,
            }
        )
    return applied


# --------------------------------------------------------------------------
# Nachschub — keine passende Maschine bleibt leer, solange Arbeit wartet
# --------------------------------------------------------------------------
def feed_empty_enabled(db: Session) -> bool:
    """Der eigene Schalter für die Nachschub-Regel.

    Der Betrieb hat sie so bestellt: eine Fertigungsstation, die fertig ist,
    während passende Aufträge in der Planung liegen, ist Stillstand, den
    niemand bestellt hat. Wer die Regel für die ganze Halle nicht will, dreht
    diesen Schalter zu; wer sie für *eine* Station nicht will, stellt sie
    auf „Pull“ — die bleibt unberührt.
    """
    return setting(db, "feed_empty", "1") == "1"


def ensure_fed(db: Session, *, who: str = "system") -> list[dict]:
    """Leere Stationen füllen — mit dem am besten passenden offenen Auftrag.

    Die Reihenfolge der Frage ist wichtig und deshalb bewusst umgekehrt zur
    Planung: nicht *„welche Maschine will diesen Auftrag?“*, sondern
    *„welcher Auftrag darf auf diese Maschine?“*. Eine leere Station ist der
    Ausgangspunkt, die harte Eignung die Schwelle, der Punktwert die Wahl
    unter den Passenden. Ein Auftrag geht an höchstens eine Maschine; jede
    leere Station bekommt höchstens einen Auftrag pro Lauf — der Rest gehört
    zur normalen Planung, nicht zum Nachschub.

    Steht hinter zwei Schaltern: dem Hauptschalter („Automatische
    Maschinenzuordnung“) und ``feed_empty``. Ist einer aus, wird nichts
    zugeteilt — Vorschlagen bleibt Sache der Planansicht.
    """
    if not auto_routing_enabled(db) or not feed_empty_enabled(db):
        return []
    specs = station_specs(db)
    ctx = context(db)
    candidates = (
        db.query(WorkOrder)
        .filter(WorkOrder.station_id.is_(None))
        .filter(WorkOrder.status == WorkOrderStatus.open)
        .order_by(WorkOrder.created_at.asc())
        .all()
    )
    if not candidates:
        return []
    waiting: list[tuple[WorkOrder, JobSpec]] = [
        (w, job_spec(db, w)) for w in candidates
    ]

    fed: list[dict] = []
    for spec in sorted(
        (
            s
            for s in specs
            if s.type == "production"
            and s.active
            and s.routing in ("smart_auto", "smart_suggest")
        ),
        key=lambda s: s.id,
    ):
        if spec.queue_min > 0:
            continue  # die Regel heißt „nie leer“, nicht „immer voll“
        best: tuple[float, WorkOrder, JobSpec, Assessment] | None = None
        for wo, job in waiting:
            a = assess(job, spec, specs, ctx)
            if not a.eligible:
                continue
            if best is None or a.score > best[0]:
                best = (a.score, wo, job, a)
        if best is None:
            continue  # nichts, was auf diese Maschine darf — das ist ehrlich
        score, wo, job, a = best
        minutes = job_minutes(job, spec, needs_changeover(job, spec)) or 0.0
        assign(
            db,
            wo,
            spec.id,
            mode="auto",
            who=who,
            score=score,
            reason=f"Nachschub — Station war leer: {a.summary}",
        )
        spec.queue_min += minutes
        spec.last_mat, spec.last_thk = job.mat, job.thk
        waiting = [(w, j) for w, j in waiting if w.id != wo.id]
        fed.append(
            {
                "job_no": wo.no,
                "station_id": spec.id,
                "label": spec.label,
                "score": round(score, 1),
                "reason": a.summary,
                "minutes": round(minutes, 1),
            }
        )
    return fed


# --------------------------------------------------------------------------
# Bearbeiterzuordnung
# --------------------------------------------------------------------------
def handler_specs(db: Session, order: Optional[OrderSpec] = None) -> list[HandlerSpec]:
    """Bearbeiter samt der Fakten, die die Zuordnung sieht.

    ``order`` ist die Zuordnung, für die bewertet wird: daraus liest diese
    Naht aus dem Auftragbuch, wie viele Aufträge dieses Kunden und mit
    diesen Werkstoffen jeder Bearbeiter **tatsächlich** bearbeitet hat. Das
    ist Abfrage, kein Lernen — die Zahl steht in der Buchhaltung und ändert
    sich nicht durch die Zuordnung selbst.
    """
    users = (
        db.query(User)
        .filter(User.role.in_([Role.staff, Role.admin]))
        .order_by(User.id.asc())
        .all()
    )
    open_counts = dict(
        db.query(Order.handler_user_id, func.count(Order.id))
        .filter(Order.handler_user_id.isnot(None))
        .filter(Order.stage < 4)
        .filter(Order.cancelled_at.is_(None))
        .group_by(Order.handler_user_id)
        .all()
    )
    customer_counts: dict[int, int] = {}
    material_counts: dict[int, int] = {}
    if order is not None:
        if order.customer_ref:
            customer_counts = {
                int(uid): int(n or 0)
                for uid, n in (
                    db.query(Order.handler_user_id, func.count(Order.id))
                    .filter(Order.handler_user_id.isnot(None))
                    .filter(Order.customer_ref == order.customer_ref)
                    .group_by(Order.handler_user_id)
                    .all()
                )
            }
        if order.materials:
            material_counts = {
                int(uid): int(n or 0)
                for uid, n in (
                    db.query(Order.handler_user_id, func.count(Order.id.distinct()))
                    .join(OrderPosition, OrderPosition.order_id == Order.id)
                    .filter(Order.handler_user_id.isnot(None))
                    .filter(OrderPosition.mat.in_(order.materials))
                    .group_by(Order.handler_user_id)
                    .all()
                )
            }
    stations = db.query(FactoryStation).all()
    by_user: dict[int, list[int]] = {}
    for s in stations:
        for uid in s.assigned_users or []:
            by_user.setdefault(int(uid), []).append(s.id)
    return [
        HandlerSpec(
            user_id=u.id,
            name=u.name or u.email,
            email=u.email,
            role=u.role.value if hasattr(u.role, "value") else str(u.role),
            active=bool(u.active),
            open_orders=int(open_counts.get(u.id, 0) or 0),
            station_ids=by_user.get(u.id, []),
            customer_orders=customer_counts.get(u.id, 0),
            material_orders=material_counts.get(u.id, 0),
        )
        for u in users
    ]


def order_spec(o: Order) -> OrderSpec:
    return OrderSpec(
        no=o.no,
        customer_ref=o.customer_ref or "",
        customer_user_id=o.user_id,
        materials=sorted({p.mat for p in o.positions if p.mat}),
        rush=bool(o.rush),
    )


def rank_for_order(db: Session, o: Order) -> list[HandlerAssessment]:
    return rank_handlers(order_spec(o), handler_specs(db, order_spec(o)))


def set_handler(
    db: Session, o: Order, user_id: Optional[int], *, reason: str = ""
) -> Order:
    if user_id is None:
        o.handler_user_id = None
        o.handler_reason = ""
        o.handler_at = None
    else:
        u = db.get(User, user_id)
        if u is None:
            raise ValueError("Bearbeiter nicht gefunden.")
        o.handler_user_id = user_id
        o.handler_reason = (reason or "")[:300]
        o.handler_at = _now()
    db.commit()
    return o


# --------------------------------------------------------------------------
# Materialfluss — was den Stationen zugeordnet ist, abgeleitet, nicht gemeldet
# --------------------------------------------------------------------------
def material_flow(db: Session, *, limit: int = 300) -> list[dict]:
    """Kanten Lager → Maschine → Versand, mit Menge und Weg.

    Gezählt wird, was zugeordnet ist, nicht was gedacht war: eine Kante
    entsteht erst, wenn ein Innenauftrag wirklich auf einer Station liegt.
    Der Weg nutzt ``RoutingContext.route_between`` über Ebenen und verankerte
    Hallen hinweg — dieselbe Rechnung wie in der Zuordnung.
    """
    stations = db.query(FactoryStation).all()
    specs = {s.id: s for s in station_specs(db, stations)}
    stores = [s for s in specs.values() if s.is_storage and s.active]
    ships = [s for s in specs.values() if s.type == "shipping" and s.active]
    ctx = context(db)
    route_cache: dict[tuple[int, int], Optional[Route]] = {}

    def route_of(a: int, b: int) -> Optional[Route]:
        key = (a, b)
        if key not in route_cache:
            sa, sb = specs.get(a), specs.get(b)
            route_cache[key] = ctx.route_between(sa, sb) if (sa and sb) else None
        return route_cache[key]

    rows = (
        db.query(WorkOrder)
        .filter(WorkOrder.station_id.isnot(None))
        .filter(WorkOrder.status != WorkOrderStatus.cancelled)
        .order_by(WorkOrder.created_at.desc())
        .limit(limit)
        .all()
    )
    edges: dict[tuple[int, int], dict] = {}

    def add(a: int, b: int, kind: str, mat: str) -> None:
        if a == b or a not in specs or b not in specs:
            return
        key = (a, b)
        e = edges.get(key)
        if not e:
            r = route_of(a, b)
            e = edges[key] = {
                "from": a,
                "to": b,
                "kind": kind,
                "count": 0,
                "metres": round(r.metres, 1) if r is not None else 0.0,
                "exact": bool(r and r.exact),
                "materials": set(),
            }
        e["count"] += 1
        if mat:
            e["materials"].add(mat)

    for wo in rows:
        sid = int(wo.station_id)  # type: ignore[arg-type]
        if sid not in specs:
            continue
        pool = [s for s in stores if not s.materials or wo.mat in s.materials] or stores
        reachable_stores = [(r.metres, s) for s in pool if (r := route_of(s.id, sid)) is not None]
        if reachable_stores:
            _, nearest = min(reachable_stores, key=lambda item: (item[0], item[1].id))
            add(nearest.id, sid, "supply", wo.mat)
        reachable_ships = [(r.metres, s) for s in ships if (r := route_of(sid, s.id)) is not None]
        if reachable_ships:
            _, nearest = min(reachable_ships, key=lambda item: (item[0], item[1].id))
            add(sid, nearest.id, "dispatch", wo.mat)

    return [
        {**e, "materials": sorted(e["materials"])}
        for e in sorted(edges.values(), key=lambda e: -e["count"])
    ]
