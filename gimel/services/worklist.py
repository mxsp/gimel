"""Die Naht zwischen Datenbank und Arbeitsvorrat.

Hier steht kein einziger Punktwert und keine Reihenfolgeregel. Diese Datei
liest Zeilen, baut daraus die Werttypen aus ``domain/worklist.py``, gibt sie
hinein und schreibt zurück, was herauskam — dieselbe Trennung, die
``services/factory_router.py`` für die Maschinenwahl hat und die der
Preiskern seit jeher hat (CLAUDE.md §3, „Rule: the engine is pure").

Vier Dinge passieren hier und sonst nirgends:

1. **Aufgaben entstehen aus dem, was ohnehin da ist.** Ein Innenauftrag ist
   eine Schneideaufgabe; ein Innenauftrag ohne bereitgestelltes Material ist
   zusätzlich eine Kommissionieraufgabe; ein Auftrag mit geschnittenen, noch
   nicht verschickten Teilen ist eine Packaufgabe; ein Auftrag, der noch
   Aufmerksamkeit im Büro braucht, ist eine Bearbeitungsaufgabe. Nichts davon
   wird von Hand angelegt — ``reconcile`` gleicht ab.

2. **Die Aufgabenzeile trägt nur die Disposition.** Wo sie liegt, an welcher
   Stelle, mit welcher Begründung. Was zu tun ist, steht weiter am
   Innenauftrag und am Auftrag; darum schreibt jede Zuordnung und jede
   Fertigmeldung dorthin durch, statt eine zweite Wahrheit aufzumachen.

3. **Die Warteschlange einer Station ist die Summe aller ihrer Aufgaben** —
   nicht nur der Innenaufträge. Ein Packtisch mit zwölf offenen Sendungen ist
   voll, auch wenn kein Innenauftrag auf ihm liegt.

4. **Rüstzustand**: der zuletzt an einer Station abgearbeitete Werkstoff,
   damit der Wechselfaktor weiß, was aufgespannt ist — für jede Station, nicht
   nur für Maschinen. Auch ein Regal, das gerade Graphit stapelt, hat einen
   Zustand.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional, Sequence

from sqlalchemy.orm import Session

from ..core.routing import RoutingContext, StationSpec
from ..core.worklist import (
    KIND_LABEL,
    KIND_ORDER,
    KIND_STATION_TYPE,
    Placement,
    PriorityWeights,
    Schedule,
    Task,
    WorklistPolicy,
    options_for,
    priority,
    sequence,
    spread,
    task_minutes,
)
from ..models import (
    FactoryStation,
    FactoryStationType,
    Order,
    OrderPosition,
    StationTask,
    WorkItem,
    WorkOrder,
    WorkOrderStatus,
)
from . import factory_router as fr
from . import settings_store

OPEN_STATES = ("waiting", "ready", "running")
OPEN_WO = (WorkOrderStatus.open, WorkOrderStatus.running)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    """SQLite gibt Zeitstempel ohne Zeitzone zurück; hier bekommen sie eine.

    Ohne das stirbt jede Subtraktion gegen ``_now()`` — und mit ihr der ganze
    Arbeitsvorrat, sobald ein Auftrag ein Fälligkeitsdatum hat.
    """
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _hours_until(dt: Optional[datetime], now: datetime) -> Optional[float]:
    d = _aware(dt)
    return (d - now).total_seconds() / 3600.0 if d else None


def _hours_since(dt: Optional[datetime], now: datetime) -> float:
    d = _aware(dt)
    return max(0.0, (now - d).total_seconds() / 3600.0) if d else 0.0


# --------------------------------------------------------------------------
# Betriebsparameter
# --------------------------------------------------------------------------
def policy_from_settings(db: Session) -> WorklistPolicy:
    """Die Stellschrauben der Reihenfolge, sofern der Betrieb sie gesetzt hat.

    Das Zusagefenster kommt aus ``delivery_days`` — derselben Zahl, aus der
    das Zusagedatum am Auftrag entsteht. Zwei Fenster für dieselbe Zusage
    wären zwei Wahrheiten; die Reihenfolge rechnet also mit genau dem
    Versprechen, das der Kunde bekommen hat.
    """
    def num(key: str, default: float, *, store: str = "factory") -> float:
        raw = (
            fr.setting(db, key, "")
            if store == "factory"
            else settings_store.get(db, key, "")
        )
        try:
            return float(raw) if raw not in ("", None) else default
        except (TypeError, ValueError):
            return default

    days = num("delivery_days", 3.0, store="settings")
    weights = PriorityWeights(
        deadline=num("prio_deadline", PriorityWeights().deadline),
        rush=num("prio_rush", PriorityWeights().rush),
        age=num("prio_age", PriorityWeights().age),
        started=num("prio_started", PriorityWeights().started),
    )
    return WorklistPolicy(
        window_h=max(1.0, days * 24.0),
        safety_min=max(0.0, num("seq_safety_min", 30.0)),
        family_bonus=max(0.0, num("seq_family_bonus", 40.0)),
        weights=weights,
    )


def worklist_auto_enabled(db: Session) -> bool:
    """Der Schalter für die selbsttätige Verteilung des Arbeitsvorrats.

    Bewusst derselbe Hauptschalter wie die Maschinenzuordnung: eine Halle mit
    zwei Automatiken, die getrennt an- und ausgehen, ist eine Halle, in der
    niemand mehr sagen kann, warum etwas dort liegt, wo es liegt.
    """
    return fr.auto_routing_enabled(db)


# --------------------------------------------------------------------------
# Zeilen → Aufgaben
# --------------------------------------------------------------------------
class _OrderFacts:
    """Termin, Eil und Ankunft je Auftragsnummer — einmal geholt, oft gefragt."""

    def __init__(self, db: Session, nos: Iterable[str], now: datetime):
        self.due_h: dict[str, Optional[float]] = {}
        self.rush: dict[str, bool] = {}
        self.waiting_h: dict[str, float] = {}
        self.customer: dict[str, str] = {}
        nos = [n for n in set(nos) if n]
        if not nos:
            return
        for o in db.query(Order).filter(Order.no.in_(nos)).all():
            self.due_h[o.no] = _hours_until(o.due_date, now)
            self.rush[o.no] = bool(o.rush)
            # „Im Haus" heißt: bezahlt bzw. übernommen — nicht angelegt. Ein
            # Auftrag, der drei Tage im Entwurf lag, hat nicht drei Tage
            # gewartet.
            self.waiting_h[o.no] = _hours_since(o.paid_at or o.created_at, now)
            self.customer[o.no] = o.customer_ref or ""


def _wo_orders(db: Session, wo_ids: Sequence[int]) -> dict[int, list[str]]:
    """Welche Kundenaufträge in welchem Innenauftrag stecken."""
    out: dict[int, list[str]] = {}
    if not wo_ids:
        return out
    rows = (
        db.query(WorkItem.work_order_id, WorkItem.order_no)
        .filter(WorkItem.work_order_id.in_(list(wo_ids)))
        .distinct()
        .all()
    )
    for wo_id, order_no in rows:
        if order_no:
            out.setdefault(int(wo_id), []).append(order_no)
    for v in out.values():
        v.sort()
    return out


def collect(db: Session, *, now: Optional[datetime] = None) -> list[Task]:
    """Alles, was die Halle gerade zu tun hat — als Aufgabenliste.

    Bewusst aus den Quellen gelesen und nicht aus ``station_tasks``: die
    Aufgabenzeile ist die Disposition, nicht die Arbeit. Was zu tun ist,
    ergibt sich aus Innenaufträgen und Aufträgen, und wenn eine Aufgabe hier
    nicht mehr auftaucht, ist sie erledigt oder entfallen — ``reconcile``
    schließt sie dann.
    """
    now = now or _now()
    tasks: list[Task] = []

    # ---- Schneiden und Kommissionieren -----------------------------------
    wos = db.query(WorkOrder).filter(WorkOrder.status.in_(OPEN_WO)).all()
    by_wo = _wo_orders(db, [w.id for w in wos])
    # Platten aus einem Reststück: der Dienst holt dafür keine volle Platte.
    from sqlalchemy import func as _func
    from sqlalchemy.orm import defer as _defer
    from ..db import chunked_in as _chunked_in
    from ..models import OrderPosition as _OrderPosition, WorkPlate as _WorkPlate
    from_offcut = dict(
        db.query(_WorkPlate.work_order_id, _func.count(_WorkPlate.id))
        .filter(_chunked_in(_WorkPlate.work_order_id, [w.id for w in wos]))
        .filter(_WorkPlate.offcut_id.isnot(None))
        .group_by(_WorkPlate.work_order_id).all()
    ) if wos else {}
    facts = _OrderFacts(
        db, [n for v in by_wo.values() for n in v], now
    )

    for wo in wos:
        order_nos = by_wo.get(wo.id, [])
        due_list = [facts.due_h.get(n) for n in order_nos]
        due_h = min([d for d in due_list if d is not None], default=None)
        own = _hours_until(wo.due_date, now)
        if own is not None:
            due_h = own if due_h is None else min(due_h, own)
        rush = any(facts.rush.get(n) for n in order_nos)
        waiting = max([facts.waiting_h.get(n, 0.0) for n in order_nos], default=0.0)
        refs = sorted({facts.customer.get(n, "") for n in order_nos if facts.customer.get(n)})
        job = fr.job_spec(db, wo)

        tasks.append(
            Task(
                kind="cut",
                ref=wo.no,
                label=f"{wo.mat_name or wo.mat} {wo.thk:g} mm".replace(".", ","),
                mat=wo.mat,
                mat_name=wo.mat_name or "",
                thk=float(wo.thk or 0.0),
                units=int(wo.n_plates or 1),
                n_parts=int(wo.n_parts or 0),
                n_plates=int(wo.n_plates or 0),
                cut_len_mm=job.cut_len_mm,
                plate_mm=job.plate_mm,
                rush=rush,
                due_in_h=due_h,
                waiting_h=waiting,
                started=wo.started_at is not None,
                station_id=wo.station_id,
                customer_refs=refs,
                order_nos=order_nos,
                note=wo.release_reason or "",
            )
        )

        if wo.material_staged_at is None:
            # Kommissionieren ist die Arbeit *vor* dem Schnitt und hat deshalb
            # denselben Termin, aber weniger Luft: die Platten müssen da sein,
            # bevor die Maschine anfängt. Der Vorlauf ist die geplante
            # Schnittzeit — mehr Genauigkeit hätte hier keine Grundlage.
            lead_h = float(wo.planned_min or 0.0) / 60.0
            n_off = int(from_offcut.get(wo.id, 0))
            n_full = max(0, int(wo.n_plates or 0) - n_off)
            what = f"{n_full} Platten"
            if n_off:
                what = (f"{n_full} Platten + {n_off} Reststück" + ("e" if n_off > 1 else "")
                        if n_full else f"{n_off} Reststück" + ("e" if n_off > 1 else ""))
            tasks.append(
                Task(
                    kind="pick",
                    ref=wo.no,
                    label=f"{wo.mat_name or wo.mat} {wo.thk:g} mm · {what}".replace(".", ","),
                    mat=wo.mat,
                    mat_name=wo.mat_name or "",
                    thk=float(wo.thk or 0.0),
                    units=int(wo.n_plates or 1),
                    n_plates=int(wo.n_plates or 0),
                    n_parts=int(wo.n_parts or 0),
                    rush=rush,
                    due_in_h=(due_h - lead_h) if due_h is not None else None,
                    waiting_h=waiting,
                    started=False,
                    customer_refs=refs,
                    order_nos=order_nos,
                    to_station_id=wo.station_id,
                )
            )

    # ---- Packen -----------------------------------------------------------
    from .shipping import order_ready_rows

    for row in order_ready_rows(db):
        no = row["order_no"]
        mats = sorted({p.get("mat", "") for p in row.get("positions", []) if p.get("mat")})
        tasks.append(
            Task(
                kind="pack",
                ref=no,
                label=row.get("customer") or no,
                # Eine Sendung hat keine Rüstfamilie — es gibt nichts
                # aufzuspannen. Der Werkstoff steht trotzdem an der Aufgabe,
                # damit ein Versand, der auf bestimmte Werkstoffe eingegrenzt
                # ist (Gefahrgut, Übergröße), sie sehen kann.
                mat="",
                mat_name=", ".join(mats),
                units=int(row.get("n_ready") or 1),
                n_parts=int(row.get("n_ready") or 0),
                rush=bool(row.get("rush")),
                due_in_h=_hours_until(
                    _parse_iso(row.get("due_date")), now
                ),
                waiting_h=0.0,
                customer_refs=[row.get("customer", "")] if row.get("customer") else [],
                order_nos=[no],
            )
        )

    # ---- Auftragsbearbeitung ---------------------------------------------
    # Was das Büro noch anfassen muss, und zwar ausdrücklich: nicht
    # freigegeben, gesperrt, oder ohne Bearbeiter. Drei nachlesbare Gründe —
    # kein „irgendwas stimmt nicht".
    office = (
        db.query(Order)
        .options(
            _defer(Order.ship_address),
            _defer(Order.bill_address),
            _defer(Order.office_note),
            _defer(Order.manual_shipment),
        )
        .filter(Order.stage < 4)
        # Ein stornierter Auftrag ist erledigt, kein offener Vorgang.
        .filter(Order.cancelled_at.is_(None))
        .filter(
            (Order.released.is_(False))
            | (Order.blocked.is_(True))
            | (Order.handler_user_id.is_(None))
            | (Order.held_at.isnot(None))
        )
        .order_by(Order.created_at.asc())
        .limit(300)
        .all()
    )
    office_pos_counts = (
        dict(
            db.query(_OrderPosition.order_id, _func.count(_OrderPosition.id))
            .filter(_chunked_in(_OrderPosition.order_id, [o.id for o in office]))
            .group_by(_OrderPosition.order_id)
            .all()
        )
        if office
        else {}
    )
    for o in office:
        why = []
        if o.held_at is not None:
            # Ohne Grund: die Aufgabenliste sieht auch die Halle, und die Notiz
            # überlebte sonst das Löschen des Kundenkontos.
            why.append("angehalten")
        if o.blocked:
            why.append("gesperrt — Preisprüfung")
        if not o.released:
            why.append("nicht freigegeben")
        if o.handler_user_id is None:
            why.append("ohne Bearbeiter")
        tasks.append(
            Task(
                kind="process",
                ref=o.no,
                label=o.customer_ref or o.no,
                units=int(office_pos_counts.get(o.id, 0)) or 1,
                rush=bool(o.rush),
                due_in_h=_hours_until(o.due_date, now),
                waiting_h=_hours_since(o.paid_at or o.created_at, now),
                customer_refs=[o.customer_ref] if o.customer_ref else [],
                order_nos=[o.no],
                note=" · ".join(why),
            )
        )

    return tasks


def _parse_iso(v: Optional[str]) -> Optional[datetime]:
    if not v:
        return None
    try:
        return datetime.fromisoformat(v)
    except ValueError:
        return None


def _task_key(t: Task) -> str:
    """Der Stand der Quelle, den eine geschlossene Aufgabe festhält.

    Nur ``pack`` und ``process`` brauchen ihn: ihre Quelle lebt nach dem
    Erledigen weiter (fertige, noch nicht versandte Teile bzw. ein Auftrag, den
    das Büro noch anfassen muss). Ändert sich der Stand, ist die Aufgabe wieder
    offen — sonst bliebe eine neue Sendung unsichtbar.
    """
    if t.kind == "pack":
        return f"pack|{int(t.units or 1)}|{int(bool(t.rush))}"
    if t.kind == "process":
        return (f"process|{int(t.units or 1)}|{int(bool(t.rush))}|"
                f"{(t.note or '')[:80]}")
    return ""


def _row_key(r: StationTask) -> str:
    if r.kind == "pack":
        return f"pack|{int(r.units or 1)}|{int(bool(r.rush))}"
    if r.kind == "process":
        return (f"process|{int(r.units or 1)}|{int(bool(r.rush))}|"
                f"{(r.note or '')[:80]}")
    return ""


# --------------------------------------------------------------------------
# Abgleich: aus Aufgaben werden Zeilen
# --------------------------------------------------------------------------
def reconcile(db: Session, *, who: str = "system") -> dict:
    """Die Aufgabenliste mit der Wirklichkeit abgleichen.

    Anlegen, was neu ist; auffrischen, was sich geändert hat; schließen, was
    es nicht mehr gibt. Die Disposition — Station, Platz, Begründung — bleibt
    dabei unberührt: ein Abgleich, der die Zuordnung des Meisters wegwirft,
    wäre eine Zumutung, und er läuft alle dreißig Sekunden.

    Der Rückgabewert zählt, was passiert ist. Eine Naht, die still arbeitet,
    lässt sich nicht prüfen.
    """
    now = _now()
    tasks = collect(db, now=now)
    live: dict[tuple[str, str], Task] = {(t.kind, t.ref): t for t in tasks}

    # Nur offene Aufgaben + abgeschlossene Aufgaben mit aktuellem Bezug laden,
    # statt bei Millionen Aufträgen die gesamte Historie in den Speicher zu ziehen.
    from ..db import chunked_in as _chunked_in
    open_rows = (
        db.query(StationTask)
        .filter(StationTask.state.notin_(("done", "cancelled")))
        .all()
    )
    live_refs = {t.ref for t in tasks}
    closed_matching = (
        db.query(StationTask)
        .filter(StationTask.state.in_(("done", "cancelled")))
        .filter(_chunked_in(StationTask.ref, live_refs))
        .all()
        if live_refs
        else []
    )
    by_key: dict[tuple[str, str], StationTask] = {}
    for r in closed_matching:
        by_key[(r.kind, r.ref)] = r
    for r in open_rows:
        by_key[(r.kind, r.ref)] = r

    created = updated = closed = 0

    for key, t in live.items():
        row = by_key.get(key)
        due = (
            now.fromtimestamp(now.timestamp() + t.due_in_h * 3600.0, tz=timezone.utc)
            if t.due_in_h is not None
            else None
        )
        if row is None:
            row = StationTask(
                kind=t.kind,
                ref=t.ref,
                label=t.label,
                mat=t.mat,
                mat_name=t.mat_name,
                thk=float(t.thk or 0.0),
                units=int(t.units or 1),
                station_id=t.station_id,
                to_station_id=t.to_station_id,
                state="running" if t.started else "ready",
                due_date=due,
                rush=t.rush,
                note=t.note,
            )
            db.add(row)
            created += 1
        else:
            if row.state in ("done", "cancelled"):
                # Eine vom Menschen geschlossene Pack-/Bearbeitungsaufgabe
                # bleibt zu, solange ihre Quelle unverändert ist. Ohne diesen
                # Riegel macht der 30-Sekunden-Abgleich jede Fertigmeldung
                # sofort rückgängig.
                if row.kind in ("pack", "process") and row.closed_at is not None:
                    if (row.closed_key or "") == _task_key(t):
                        continue
                    row.closed_at = None
                    row.closed_by = ""
                    row.closed_key = ""
                    row.closed_reason = ""
                # Wieder aufgetaucht — der Innenauftrag wurde zurückgesetzt
                # oder die Bereitstellung zurückgenommen. Dann ist die Aufgabe
                # wieder offen, und zwar sichtbar.
                row.state = "running" if t.started else "ready"
                row.done_at = None
                row.done_by = ""
            elif t.started and row.state != "running":
                row.state = "running"
                row.started_at = row.started_at or now
            row.label = t.label
            row.mat, row.mat_name, row.thk = t.mat, t.mat_name, float(t.thk or 0.0)
            row.units = int(t.units or 1)
            row.due_date = due
            row.rush = t.rush
            row.note = t.note
            if t.to_station_id is not None:
                row.to_station_id = t.to_station_id
            # Für das Schneiden ist der Innenauftrag die maßgebliche
            # Zuordnung — er wird von der Produktionsoberfläche und vom
            # Planer geschrieben, und die Aufgabenzeile folgt ihm.
            if t.kind == "cut" and t.station_id != row.station_id:
                row.station_id = t.station_id
            updated += 1

    for key, row in by_key.items():
        if key in live or row.state in ("done", "cancelled"):
            continue
        # Nicht mehr in der Wirklichkeit: erledigt. Das ist die eine Stelle,
        # an der eine Aufgabe von selbst verschwindet — und sie sagt, warum.
        row.state = "done"
        row.done_at = row.done_at or now
        row.done_by = row.done_by or who
        if not row.note:
            row.note = "Quelle erledigt — automatisch geschlossen"
        closed += 1

    db.commit()
    return {"created": created, "updated": updated, "closed": closed}


# --------------------------------------------------------------------------
# Stationen, wie der Arbeitsvorrat sie sieht
# --------------------------------------------------------------------------
def _queue_by_station(db: Session) -> dict[int, float]:
    """Belegte Minuten je Station — aus **allen** Aufgabenarten.

    Der Unterschied zu ``factory_router._queue_minutes`` ist der Punkt: dort
    zählen nur Innenaufträge, hier zählt auch die Sendung auf dem Packtisch
    und die Palette, die noch aus dem Regal muss. Ein Arbeitsplatz ist voll,
    wenn er voll ist, nicht wenn eine bestimmte Tabelle voll ist.
    """
    out: dict[int, float] = {}
    rows = (
        db.query(StationTask.station_id, StationTask.planned_min)
        .filter(StationTask.station_id.isnot(None))
        .filter(StationTask.state.in_(OPEN_STATES))
        .all()
    )
    for sid, minutes in rows:
        out[int(sid)] = out.get(int(sid), 0.0) + float(minutes or 0.0)
    return out


def _last_family(db: Session) -> dict[int, tuple[str, float]]:
    """Was zuletzt an einer Station lief — der Rüstzustand, je Station.

    „Zuletzt" heißt: die jüngste Aufgabe mit einem Werkstoff, unabhängig davon,
    ob sie schon fertig ist. Es geht um das, was aufgespannt ist bzw. zuletzt
    war, nicht um den Fertigungsstand.

    Gewertet werden **nur die drei Zeitpunkte, die etwas bedeuten** —
    fertiggemeldet, angefangen, zugeordnet. Nicht ``updated_at``: den hebt
    jeder Abgleich an, und der läuft alle dreißig Sekunden. Danach zu
    sortieren hieße, den Rüstzustand aus der Abfragehäufigkeit zu lesen — und
    diese Naht gäbe dann eine andere Antwort als ``factory_router._last_job``
    auf dieselbe Frage. Zwei Wahrheiten über dieselbe Maschine wären eine zu
    viel; eine Aufgabe ohne einen dieser drei Zeitpunkte sagt über den
    Rüstzustand nichts und wird darum übergangen.
    """
    out: dict[int, tuple[str, float]] = {}
    rows = (
        db.query(StationTask)
        .filter(StationTask.station_id.isnot(None))
        .filter(StationTask.mat != "")
        .filter(StationTask.state != "cancelled")
        .order_by(StationTask.id.desc())
        .limit(600)
        .all()
    )
    stamped = [
        (r.done_at or r.started_at or r.assigned_at, r)
        for r in rows
        if (r.done_at or r.started_at or r.assigned_at) is not None
    ]
    stamped.sort(key=lambda pair: (_aware(pair[0]), pair[1].id), reverse=True)
    for _, r in stamped:
        sid = int(r.station_id)  # type: ignore[arg-type]
        if sid not in out:
            out[sid] = (r.mat, float(r.thk or 0.0))
    return out


def station_specs(db: Session) -> list[StationSpec]:
    """Alle Stationen als Rechenkern-Eingabe — mit Arbeitsvorrat-Warteschlange."""
    rows = db.query(FactoryStation).order_by(FactoryStation.id.asc()).all()
    queue = _queue_by_station(db)
    last = _last_family(db)
    # Der Rüstzustand der Maschinen steht auch an den Innenaufträgen; wo die
    # Aufgabenliste noch nichts weiß, gilt er weiter.
    for sid, fam in fr._last_job(db).items():
        last.setdefault(sid, fam)
    place = fr._placement(db)
    specs = []
    for s in rows:
        spec = fr.station_spec(s, queue, last, place)
        spec.task_min = float(getattr(s, "task_min", 0.0) or 0.0)
        spec.unit_min = float(getattr(s, "unit_min", 0.0) or 0.0)
        specs.append(spec)
    return specs


def context(db: Session) -> RoutingContext:
    return fr.context(db)


# --------------------------------------------------------------------------
# Planen und Anwenden
# --------------------------------------------------------------------------
def _scopes_for(db: Session, rows: Sequence[StationTask]) -> dict[tuple[str, str], str]:
    """Fertigungsort-Vorgabe je Aufgabe: cut/pick vom Innenauftrag, pack/process vom Auftrag."""
    from . import sites

    wo_refs = {r.ref for r in rows if r.kind in ("cut", "pick")}
    o_refs = {r.ref for r in rows if r.kind not in ("cut", "pick")}
    wo = dict(
        db.query(WorkOrder.no, WorkOrder.route_scope).filter(WorkOrder.no.in_(wo_refs)).all()
    ) if wo_refs else {}
    orders = db.query(Order).filter(Order.no.in_(o_refs)).all() if o_refs else []
    od = {o.no: sites.resolve_received(o, db) for o in orders}
    out: dict[tuple[str, str], str] = {}
    for r in rows:
        raw = (wo if r.kind in ("cut", "pick") else od).get(r.ref) or ""
        if raw:
            out[(r.kind, r.ref)] = raw
    return out


def _tasks_from_rows(
    rows: Sequence[StationTask], *, now: Optional[datetime] = None,
    db: Optional[Session] = None,
) -> list[Task]:
    """Aus Aufgabenzeilen wieder Werttypen — für Reihenfolge und Verteilung.

    Mit ``db`` tragen die Aufgaben ihre Fertigungsort-Vorgabe; ohne (reine
    Reihenfolge an einer Station) braucht es sie nicht.
    """
    now = now or _now()
    scopes = _scopes_for(db, rows) if db is not None else {}
    resolved: dict[str, tuple] = {}
    out: list[Task] = []
    for r in rows:
        out.append(
            Task(
                kind=r.kind,
                ref=r.ref,
                label=r.label or "",
                mat=r.mat or "",
                mat_name=r.mat_name or "",
                thk=float(r.thk or 0.0),
                units=int(r.units or 1),
                n_plates=int(r.units or 0) if r.kind in ("cut", "pick") else 0,
                rush=bool(r.rush),
                due_in_h=_hours_until(r.due_date, now),
                waiting_h=_hours_since(r.created_at, now),
                started=r.state == "running",
                # Restzeit statt Wunschzeit: was läuft, rechnet mit dem,
                # was ihm noch fehlt — geplant minus gelaufen. Ohne
                # Startzeitpunkt bleibt es bei der vollen Planzahl.
                planned_min=float(r.planned_min or 0.0),
                started_min_ago=(
                    _hours_since(r.started_at, now) * 60.0
                    if r.state == "running" and r.started_at is not None
                    else None
                ),
                station_id=r.station_id,
                to_station_id=r.to_station_id,
                note=r.note or "",
            )
        )
        raw = scopes.get((r.kind, r.ref))
        if raw and db is not None:
            if raw not in resolved:
                resolved[raw] = fr.scope_of(db, raw)
            out[-1].allowed_floors, out[-1].scope_label = resolved[raw]
    return out


def open_rows(db: Session, *, kind: str = "", station_id: Optional[int] = None,
              unassigned: bool = False) -> list[StationTask]:
    q = db.query(StationTask).filter(StationTask.state.in_(OPEN_STATES))
    if kind:
        q = q.filter(StationTask.kind == kind)
    if station_id is not None:
        q = q.filter(StationTask.station_id == station_id)
    if unassigned:
        q = q.filter(StationTask.station_id.is_(None))
    return q.order_by(StationTask.seq.asc(), StationTask.id.asc()).all()


def plan(db: Session, *, kinds: Sequence[str] = ()) -> list[Placement]:
    """Was die Verteilung täte — ohne es zu tun.

    Geplant wird nur, was noch keiner Station gehört. Eine Umverteilung
    laufender Arbeit ist eine eigene, ausdrückliche Handlung; eine Planung,
    die bei jedem Aufruf die halbe Halle umräumt, ist keine Planung, sondern
    ein Zufallsgenerator.
    """
    wanted = set(kinds) if kinds else set(KIND_STATION_TYPE)
    rows = [r for r in open_rows(db, unassigned=True) if r.kind in wanted]
    if not rows:
        return []
    tasks = _tasks_from_rows(rows, db=db)
    # Aufgaben desselben Typs teilen sich die Stationen dieses Typs; deshalb
    # wird je Art geplant und nicht alles in einen Topf geworfen.
    specs = station_specs(db)
    ctx = context(db)
    pol = policy_from_settings(db)
    out: list[Placement] = []
    for kind in KIND_ORDER:
        group = [t for t in tasks if t.kind == kind]
        if not group:
            continue
        # Bewusst **alle** Stationen hinein, nicht nur die des passenden Typs:
        # die Eignungsprüfung sortiert die falschen ohnehin aus, und der Weg
        # zum Werkstoff misst gegen die Lager — die wären sonst nicht dabei,
        # und jede Maschine bekäme „kein Lager erfasst" zu lesen.
        out.extend(spread(group, specs, ctx, policy=pol))
    return out


def assign(
    db: Session,
    row: StationTask,
    station_id: Optional[int],
    *,
    mode: str,
    who: str = "",
    reason: str = "",
) -> StationTask:
    """Eine Aufgabe einer Station zuordnen (oder die Zuordnung lösen).

    Für das Schneiden schreibt das **durch** auf den Innenauftrag: Laufkarte,
    Schnittdateien und das Produktionsmodul lesen ``WorkOrder.station_id``,
    und zwei Wahrheiten über dieselbe Maschine wären eine zu viel.
    """
    if station_id is None:
        row.station_id = None
        row.assign_mode = ""
        row.assign_reason = ""
        row.assigned_at = None
        row.assigned_by = who
        row.planned_min = 0.0
        row.seq = 0
        row.seq_pinned = False
        if row.kind == "cut":
            wo = db.query(WorkOrder).filter(WorkOrder.no == row.ref).first()
            if wo is not None:
                fr.assign(db, wo, None, mode="", who=who)
        db.commit()
        return row

    st = db.get(FactoryStation, station_id)
    if st is None:
        raise ValueError("Station nicht gefunden.")
    stype = st.type.value if hasattr(st.type, "value") else str(st.type)
    want = KIND_STATION_TYPE.get(row.kind, "production")
    if stype != want:
        raise ValueError(
            f"{KIND_LABEL.get(row.kind, row.kind)} gehört an eine "
            f"{want}-Station, {st.label} ist {stype}."
        )

    specs = station_specs(db)
    spec = next((s for s in specs if s.id == station_id), None)
    task = _tasks_from_rows([row], db=db)[0]
    if (spec is not None and task.allowed_floors is not None
            and spec.floor_id not in task.allowed_floors):
        raise ValueError(
            f"{st.label} liegt außerhalb der Vorgabe ({task.scope_label}). "
            "Erst den Fertigungsort ändern."
        )
    minutes = 0.0
    if spec is not None:
        from ..core.worklist import changeover_between

        fam = (spec.last_mat, float(spec.last_thk or 0.0)) if spec.last_mat else None
        change = changeover_between(fam, task)
        minutes = task_minutes(task, spec, changeover=change) or 0.0
        if not reason:
            opts = options_for(task, specs, context(db))
            here = next((o for o in opts if o.station_id == station_id), None)
            reason = here.reason if here else ""

    row.station_id = station_id
    row.assign_mode = mode
    row.assign_reason = (reason or "")[:400]
    row.assigned_at = _now()
    row.assigned_by = who
    row.planned_min = minutes

    if row.kind == "cut":
        wo = db.query(WorkOrder).filter(WorkOrder.no == row.ref).first()
        if wo is not None:
            fr.assign(db, wo, station_id, mode=mode, who=who, reason=reason)
    db.commit()
    return row


def apply_plan(
    db: Session,
    placements: Iterable[Placement],
    *,
    who: str = "",
    only_auto: bool = True,
    refs: Sequence[tuple[str, str]] = (),
) -> list[dict]:
    """Vorschläge übernehmen. ``only_auto`` folgt dem Opt-in der Station."""
    wanted = set(refs)
    applied: list[dict] = []
    for pl in placements:
        if pl.station_id is None:
            continue
        if only_auto and pl.mode != "auto":
            continue
        key = (pl.task.kind, pl.task.ref)
        if wanted and key not in wanted:
            continue
        row = (
            db.query(StationTask)
            .filter(StationTask.kind == pl.task.kind, StationTask.ref == pl.task.ref)
            .first()
        )
        if row is None or row.station_id is not None:
            continue
        assign(db, row, pl.station_id, mode=pl.mode, who=who, reason=pl.reason)
        applied.append(
            {
                "kind": pl.task.kind,
                "ref": pl.task.ref,
                "station_id": pl.station_id,
                "label": pl.label,
                "reason": pl.reason,
            }
        )
    if applied:
        resequence(db)
    return applied


# --------------------------------------------------------------------------
# Reihenfolge festschreiben
# --------------------------------------------------------------------------
def schedule_for(db: Session, station_id: int) -> Optional[Schedule]:
    """Die Abarbeitungsliste einer Station — gerechnet, nicht gespeichert."""
    st = db.get(FactoryStation, station_id)
    if st is None:
        return None
    specs = station_specs(db)
    spec = next((s for s in specs if s.id == station_id), None)
    if spec is None:
        return None
    rows = open_rows(db, station_id=station_id)
    if not rows:
        return Schedule(station_id=station_id, label=st.label)
    pol = policy_from_settings(db)
    # Die Warteschlange dieser Station ist die Liste selbst — sonst zählte sie
    # sich doppelt und jede Fertigstellung läge doppelt so weit weg.
    spec.queue_min = 0.0
    tasks = _tasks_from_rows(rows)
    sched = sequence(tasks, spec, policy=pol)
    # Von Hand festgezurrte Plätze gewinnen: das Verschieben muss wirken,
    # sonst ist es eine Geste. Der Rest rückt in der gerechneten Ordnung nach.
    pinned = {(r.kind, r.ref): r.seq for r in rows if r.seq_pinned and r.seq > 0}
    if pinned:
        sched.slots = _apply_pins(sched.slots, pinned)
    return sched


def _apply_pins(slots: list, pinned: dict[tuple[str, str], int]) -> list:
    """Festgezurrte Plätze einsetzen, den Rest in der Lücke weiterzählen."""
    fixed: dict[int, object] = {}
    rest = []
    for s in slots:
        want = pinned.get((s.task.kind, s.task.ref))
        if want and want not in fixed:
            fixed[want] = s
        else:
            rest.append(s)
    out = []
    i = 1
    ri = 0
    total = len(slots)
    while len(out) < total:
        if i in fixed:
            out.append(fixed.pop(i))
        elif ri < len(rest):
            out.append(rest[ri])
            ri += 1
        elif fixed:
            out.append(fixed.pop(min(fixed)))
        else:
            break
        i += 1
    for n, s in enumerate(out, start=1):
        s.seq = n
    return out


def resequence(db: Session, station_id: Optional[int] = None) -> dict[int, Schedule]:
    """Die Reihenfolge rechnen und an die Aufgaben schreiben.

    Gespeichert wird, damit alle dasselbe sehen — die Stationsseite, der
    Zettel an der Maschine und der Meister am Bildschirm. Gerechnet wird
    jedes Mal neu, damit eine neue Zusage nicht auf den nächsten Sammellauf
    warten muss.
    """
    ids = (
        [station_id]
        if station_id is not None
        else [
            int(s.id)
            for s in db.query(FactoryStation).order_by(FactoryStation.id.asc()).all()
        ]
    )
    out: dict[int, Schedule] = {}
    for sid in ids:
        sched = schedule_for(db, sid)
        if sched is None:
            continue
        out[sid] = sched
        by_key = {(s.task.kind, s.task.ref): s for s in sched.slots}
        for row in open_rows(db, station_id=sid):
            slot = by_key.get((row.kind, row.ref))
            if slot is None:
                continue
            row.seq = slot.seq
            row.priority = slot.priority.score
            row.priority_reason = slot.priority.summary[:300]
            row.seq_reason = slot.reason[:300]
    db.commit()
    return out


def reorder(
    db: Session, station_id: int, keys: Sequence[tuple[str, str]], *, who: str = ""
) -> int:
    """Die Reihenfolge von Hand setzen — und festzurren.

    Was ein Mensch verschoben hat, rechnet der nächste Lauf nicht wieder weg.
    Freigeben geht über ``unpin``: dann gilt wieder die gerechnete Ordnung,
    und man sieht am Grund, warum sie so ausfällt.
    """
    n = 0
    for i, (kind, ref) in enumerate(keys, start=1):
        row = (
            db.query(StationTask)
            .filter(
                StationTask.kind == kind,
                StationTask.ref == ref,
                StationTask.station_id == station_id,
            )
            .first()
        )
        if row is None:
            continue
        row.seq = i
        row.seq_pinned = True
        row.seq_reason = f"von Hand auf Platz {i} gesetzt ({who})"[:300]
        n += 1
    db.commit()
    resequence(db, station_id)
    return n


def unpin(db: Session, station_id: int) -> int:
    n = 0
    for row in open_rows(db, station_id=station_id):
        if row.seq_pinned:
            row.seq_pinned = False
            n += 1
    db.commit()
    resequence(db, station_id)
    return n


# --------------------------------------------------------------------------
# Zustände — und was sie in der Wirklichkeit bedeuten
# --------------------------------------------------------------------------
def set_state(
    db: Session, row: StationTask, state: str, *, who: str = "", note: str = ""
) -> StationTask:
    """Eine Aufgabe anfangen, abschließen oder zurücknehmen.

    Jeder Zustandswechsel schreibt dorthin durch, wo die Tatsache hingehört:

    * ``pick`` fertig  → die Bereitstellung am Innenauftrag ist gebucht. Der
      Haken hier und der Haken in „Bereitstellen" sind **dieselbe** Tatsache,
      nicht zwei; deshalb setzen beide denselben Zeitstempel.
    * ``cut`` angefangen/fertig → der Innenauftrag läuft bzw. ist fertig.
    * ``pack`` und ``process`` melden sich hier fertig, ohne den Auftrag
      anzufassen: Sendung anlegen und Auftrag freigeben sind eigene, bewusste
      Handlungen mit eigenen Papieren — eine Statusspalte darf sie nicht
      nebenbei erledigen.
    """
    if state not in ("waiting", "ready", "running", "done", "cancelled"):
        raise ValueError(f"Unbekannter Zustand: {state}")
    now = _now()
    # Vor dem Überschreiben der Notiz festhalten: der Schlüssel beschreibt die
    # Quelle, nicht den Text, den der Bediener beim Schließen tippt.
    source_key = _row_key(row)
    row.state = state
    if note:
        row.note = note[:500]
    if state == "running":
        row.started_at = row.started_at or now
        row.started_by = who
        row.done_at, row.done_by = None, ""
    elif state == "done":
        row.done_at = now
        row.done_by = who
    else:
        row.done_at, row.done_by = None, ""
        if state != "running":
            row.started_at, row.started_by = None, ""

    # Packen und Auftragsbearbeitung haben keine Statusspalte an der Quelle,
    # die den Abschluss trägt. Darum hält die Aufgabenzeile selbst fest, wer
    # sie wann geschlossen hat und wie die Quelle dabei aussah. Ein späterer
    # Abgleich öffnet nur wieder, wenn sich die Quelle geändert hat.
    if row.kind in ("pack", "process"):
        if state in ("done", "cancelled"):
            row.closed_at = now
            row.closed_by = who
            row.closed_key = source_key
            row.closed_reason = (note or ("erledigt" if state == "done" else "entfallen"))[:200]
        else:
            row.closed_at = None
            row.closed_by = ""
            row.closed_key = ""
            row.closed_reason = ""

    if row.kind == "pick":
        wo = db.query(WorkOrder).filter(WorkOrder.no == row.ref).first()
        if wo is not None:
            if state == "done" and wo.material_staged_at is None:
                wo.material_staged_at = now
                wo.material_staged_by = who
            elif state != "done" and wo.material_staged_at is not None:
                wo.material_staged_at = None
                wo.material_staged_by = ""
    elif row.kind == "cut":
        wo = db.query(WorkOrder).filter(WorkOrder.no == row.ref).first()
        if wo is not None:
            if state == "running" and wo.started_at is None:
                wo.started_at = now
                wo.started_by = who
                wo.status = WorkOrderStatus.running
            elif state == "done" and wo.status != WorkOrderStatus.done:
                wo.status = WorkOrderStatus.done
                wo.done_at = now
                wo.done_by = who
                # Dieselben Folgen wie die Fertigmeldung in /production und an
                # der Station (mark_completed): Platten und Positionen fertig,
                # je Kundenauftrag der Zeitpunkt — sonst bleibt ein geschnittener
                # Auftrag für den Versand unsichtbar und verschwindet zwischen
                # Fertigung und Packtisch.
                for p in wo.plates:
                    p.status = WorkOrderStatus.done
                item_orders = {
                    i.order_no
                    for i in db.query(WorkItem)
                    .filter(WorkItem.work_order_id == wo.id)
                    .all()
                }
                wo.order_done = {ono: now.isoformat() for ono in item_orders}
                ids = [
                    i.position_id
                    for i in db.query(WorkItem)
                    .filter(WorkItem.work_order_id == wo.id)
                    .all()
                    if i.position_id
                ]
                if ids:
                    (
                        db.query(OrderPosition)
                        .filter(OrderPosition.id.in_(ids))
                        .update(
                            {OrderPosition.production_status: "done"},
                            synchronize_session=False,
                        )
                    )
    db.commit()
    if row.station_id:
        resequence(db, row.station_id)
    return row


# --------------------------------------------------------------------------
# Lesemodell für die Oberfläche
# --------------------------------------------------------------------------
def _station_dict(s: FactoryStation, spec: StationSpec) -> dict:
    return {
        "id": s.id,
        "label": s.label,
        "type": spec.type,
        "subtype": s.subtype or "",
        "machine_kind": s.machine_kind or "",
        "colour": s.colour,
        "active": bool(s.active),
        "routing": spec.routing,
        "is_storage": bool(s.is_storage),
        "materials": list(s.materials or []),
        "thicknesses": [float(t) for t in (s.thicknesses or [])],
        "capacity_min_per_day": float(s.capacity_min_per_day or 0.0),
        "task_min": float(getattr(s, "task_min", 0.0) or 0.0),
        "unit_min": float(getattr(s, "unit_min", 0.0) or 0.0),
        "queue_min": round(spec.queue_min, 1),
        "last_mat": spec.last_mat or "",
        "last_thk": spec.last_thk or 0.0,
    }


def board(db: Session, *, kind: str = "") -> dict:
    """Der ganze Arbeitsvorrat in einem Abruf.

    Ein Abruf und nicht zwanzig: die Ansicht aktualisiert sich von selbst, und
    zwanzig Abrufe alle dreißig Sekunden wären eine Last, die niemand bestellt
    hat (derselbe Grund wie bei ``/pipeline``).

    Rein lesend: Abgleich und Reihenfolge rechnet der Taktgeber (alle dreißig
    Sekunden) und der ausdrückliche ``POST /worklist/reconcile``. Ein GET, das
    bei jedem Poll committet, kämpft mit dem Scheduler um dieselben Zeilen —
    und die Oberfläche, die nur liest, antwortet auch dann, während gerade
    verteilt wird.
    """
    specs = {s.id: s for s in station_specs(db)}
    rows_st = db.query(FactoryStation).order_by(FactoryStation.id.asc()).all()
    pol = policy_from_settings(db)

    kinds = [kind] if kind else KIND_ORDER
    stypes = {KIND_STATION_TYPE[k] for k in kinds if k in KIND_STATION_TYPE}

    stations: list[dict] = []
    for s in rows_st:
        spec = specs.get(s.id)
        if spec is None or spec.type not in stypes:
            continue
        sched = schedule_for(db, s.id)
        entry = _station_dict(s, spec)
        entry["schedule"] = (
            sched.to_dict()
            if sched
            else {"slots": [], "times_known": False, "changeovers": 0}
        )
        if kind:
            entry["schedule"]["slots"] = [
                sl for sl in entry["schedule"]["slots"] if sl["kind"] == kind
            ]
        stations.append(entry)

    # Der Vorrat, der noch keiner Station gehört — die Liste, an der gezogen
    # wird. Mit Priorität und Vorschlag, damit „warum die?" beantwortet ist,
    # bevor jemand fragt.
    unassigned_rows = [r for r in open_rows(db, unassigned=True) if r.kind in kinds]
    tasks = _tasks_from_rows(unassigned_rows, db=db)
    task_ids = {(r.kind, r.ref): r.id for r in unassigned_rows}
    all_specs = list(specs.values())
    ctx = context(db)
    pool: list[dict] = []
    for t in tasks:
        # Alle Stationen, aus demselben Grund wie in ``plan``: die
        # ungeeigneten kommen mit ihrem Grund mit, und die Lager tragen den
        # Weg bei, den die Bewertung braucht.
        opts = options_for(t, all_specs, ctx)
        usable = [o for o in opts if o.eligible and o.routing != "pull"]
        best = usable[0] if usable else None
        pool.append(
            {
                "task_id": task_ids.get((t.kind, t.ref)),
                "kind": t.kind,
                "ref": t.ref,
                "label": t.label,
                "mat": t.mat,
                "mat_name": t.mat_name,
                "thk": t.thk,
                "units": t.units,
                "rush": t.rush,
                "due_in_h": round(t.due_in_h, 1) if t.due_in_h is not None else None,
                "waiting_h": round(t.waiting_h, 1),
                "orders": list(t.order_nos),
                "customers": list(t.customer_refs),
                "note": t.note,
                "priority": priority(t, pol).to_dict(),
                "suggest_station_id": best.station_id if best else None,
                "suggest_label": best.label if best else "",
                "suggest_reason": best.reason
                if best
                else (opts[0].blockers[0] if opts and opts[0].blockers else "keine Station"),
                "options": [o.to_dict() for o in opts[:6]],
            }
        )
    pool.sort(key=lambda r: (-r["priority"]["score"], r["ref"]))

    counts: dict[str, dict] = {}
    for k in KIND_ORDER:
        if k not in kinds:
            continue
        rows = [r for r in open_rows(db, kind=k)]
        counts[k] = {
            "label": KIND_LABEL[k],
            "station_type": KIND_STATION_TYPE[k],
            "open": len(rows),
            "unassigned": sum(1 for r in rows if r.station_id is None),
            "running": sum(1 for r in rows if r.state == "running"),
        }

    return {
        "kinds": counts,
        "stations": stations,
        "pool": pool,
        "auto_routing": worklist_auto_enabled(db),
        "policy": {
            "window_h": pol.window_h,
            "safety_min": pol.safety_min,
            "weights": {
                "deadline": pol.weights.deadline,
                "rush": pol.weights.rush,
                "age": pol.weights.age,
                "started": pol.weights.started,
            },
        },
    }
