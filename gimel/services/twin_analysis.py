"""Der Zwilling rechnet zurück — was die Halle heute kostet und was sie besser macht.

Der Digitale Grundriss zeigt, *wo* etwas steht. Diese Datei fragt, *was an
dem, was dort steht, zu ändern lohnt*: Engpässe, stehende Maschinen neben
überlasteten, Rüstwechsel in der Schlange, Wege, die viermal am Tag
durchlaufen werden, Termine, die die eigene Schätzung schon heute reißt.

Die Aufteilung folgt dem Hausgesetz aus CLAUDE.md §3: die *Rechnung* liegt
in reinen Funktionen (unten, auf Werttypen aus ``domain/routing``), die
*Beschaffung* der Zeilen hier. Jeder Befund trägt seinen Satz auf Deutsch
mit — ein Vorschlag ohne Begründung ist dasselbe Vertrauensrisiko wie eine
Zuordnung ohne Faktoren (§5.5).

Bewusst fehlt: eine Automatik, die diese Befunde ausführt. Umordnen darf
der Mensch — per Klick in der Flussansicht. Der Vorschlag sagt, was er
bringt; das Übernehmen bleibt ein eigener Schritt.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..core.routing import (
    Assessment,
    RoutingContext,
    StationSpec,
    assess,
    job_minutes,
    needs_changeover,
    rank_stations,
)
from ..models import StationTask, WorkOrder, WorkOrderStatus
from . import factory_router as fr
from .worklist import OPEN_STATES

OPEN = (WorkOrderStatus.open, WorkOrderStatus.running)


# --------------------------------------------------------------------------
# Werttypen
# --------------------------------------------------------------------------
@dataclass
class Finding:
    """Ein Befund mit Zahl und Satz — die Währung dieser Datei."""

    kind: str  # capacity | changeover | transport | layout | dates | data
    severity: str  # danger | warning | info | success
    title: str
    detail: str
    metric: str = ""
    station_ids: list[int] = field(default_factory=list)
    job_nos: list[str] = field(default_factory=list)
    #: Konkrete Verlagerungen, die der Mensch per Klick ausführen kann.
    moves: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "severity": self.severity,
            "title": self.title,
            "detail": self.detail,
            "metric": self.metric,
            "station_ids": list(self.station_ids),
            "job_nos": list(self.job_nos),
            "moves": list(self.moves),
        }


@dataclass
class StationLoad:
    """Die Auslastung einer Fertigungsstation — die Grundlage aller Befunde."""

    station: StationSpec
    jobs: list[WorkOrder] = field(default_factory=list)

    @property
    def capacity(self) -> float:
        return self.station.capacity_min_per_day

    @property
    def ratio(self) -> float | None:
        if self.capacity <= 0:
            return None
        return self.station.queue_min / self.capacity

    @property
    def state(self) -> str:
        """idle | ok | warm | over | unknown — so, wie das Panel sie färbt."""
        r = self.ratio
        if r is None:
            return "unknown"
        if self.station.queue_min <= 0:
            return "idle"
        if r > 1.0:
            return "over"
        if r >= 0.7:
            return "warm"
        return "ok"

    def to_dict(self) -> dict:
        s = self.station
        return {
            "station_id": s.id,
            "label": s.label,
            "routing": s.routing,
            "queue_min": round(s.queue_min, 1),
            "capacity": round(self.capacity, 1),
            "ratio": round(self.ratio, 3) if self.ratio is not None else None,
            "state": self.state,
            "jobs": len(self.jobs),
            "last_mat": s.last_mat or "",
            "last_thk": s.last_thk or 0.0,
            "machine_kind": s.machine_kind,
        }


# --------------------------------------------------------------------------
# Hilfen
# --------------------------------------------------------------------------
def _fmt_min(v: float) -> str:
    if v >= 480:
        return f"{v / 480:.1f} Tage".replace(".", ",")
    if v >= 90:
        return f"{v / 60:.1f} h".replace(".", ",")
    return f"{v:.0f} min"


def _pct(ratio: float | None) -> str:
    return "—" if ratio is None else f"{round(ratio * 100)} %"


def in_worklist_order(
    db: Session, station_id: int, jobs: list[WorkOrder]
) -> list[WorkOrder]:
    """Innenaufträge einer Station in der Reihenfolge der Abarbeitungsliste.

    Maßgeblich ist ``StationTask.seq`` der ``cut``-Aufgaben. Ein Auftrag ohne
    einsortierte Aufgabe an dieser Station steht dahinter, in der Reihenfolge,
    in der er hereinkam: 0 heißt „noch nicht einsortiert", nicht „zuerst".
    """
    rows = (
        db.query(StationTask.ref, StationTask.seq)
        .filter(StationTask.kind == "cut")
        .filter(StationTask.station_id == station_id)
        .filter(StationTask.state.in_(OPEN_STATES))
        .filter(StationTask.seq > 0)
        .all()
    )
    seq = {ref: n for ref, n in rows}
    # sorted ist stabil: wer keinen Platz hat, bleibt in der übergebenen Reihenfolge.
    return sorted(jobs, key=lambda w: seq.get(w.no, float("inf")))


def _open_jobs(db: Session, station_id: int) -> list[WorkOrder]:
    jobs = (
        db.query(WorkOrder)
        .filter(WorkOrder.station_id == station_id)
        .filter(WorkOrder.status.in_(OPEN))
        .order_by(WorkOrder.created_at.asc(), WorkOrder.id.asc())
        .all()
    )
    return in_worklist_order(db, station_id, jobs)


def _loads(db: Session, specs: list[StationSpec]) -> list[StationLoad]:
    by_id = {s.id: s for s in specs}
    out: list[StationLoad] = []
    for s in specs:
        if s.type != "production" or not s.active:
            continue
        out.append(
            StationLoad(station=s, jobs=_open_jobs(db, s.id) if s.id in by_id else [])
        )
    return out


def _machine_gaps(s: StationSpec) -> list[str]:
    """Dasselbe, was die Oberfläche „stumme Faktoren" nennt — serverseitig."""
    gaps: list[str] = []
    if s.speed_mm_s <= 0:
        gaps.append("Vorschub")
    if s.setup_min <= 0:
        gaps.append("Rüstzeit")
    if s.capacity_min_per_day <= 0:
        gaps.append("Tageskapazität")
    if s.max_sheet_w <= 0 or s.max_sheet_h <= 0:
        gaps.append("Tischgröße")
    return gaps


# --------------------------------------------------------------------------
# Befunde
# --------------------------------------------------------------------------
def _capacity_findings(
    db: Session, loads: list[StationLoad], specs: list[StationSpec], ctx: RoutingContext
) -> list[Finding]:
    """Engpass, Ausgleich, Stillstand — die drei Kapazitätsbefunde.

    Der Ausgleich wird *durchgerechnet*, nicht behauptet: jede Verlagerung
    wird gegen die Eignung der Zielmaschine geprüft (dieselben harten
    Ausschlüsse wie bei der Zuordnung) und die Warteschlangen beider Seiten
    werden im Gedanken mitgeführt. Was am Ende steht, hält einer Prüfung stand.
    """
    findings: list[Finding] = []
    by_id = {s.id: s for s in specs}
    over = [l for l in loads if l.state == "over"]
    idle = [l for l in loads if l.state == "idle"]

    for l in over:
        s = l.station
        cap = l.capacity
        queue = {t.id: t.queue_min for t in specs}
        moves: list[dict] = []
        moved_min = 0.0
        # Größte Aufträge zuerst — ein Umzug muss den Engpass wirklich entlasten.
        remaining = queue[s.id] - cap
        for wo in sorted(l.jobs, key=lambda w: -(w.planned_min or 0.0)):
            if remaining <= 0:
                break
            job = fr.job_spec(db, wo)
            best: Assessment | None = None
            best_m = 0.0
            for a in rank_stations(job, specs, ctx):
                if not a.eligible:
                    continue
                t = by_id.get(a.station_id)
                if t is None or t.id == s.id:
                    continue
                m = a.minutes or job_minutes(job, t, a.changeover) or 0.0
                if m <= 0:
                    continue
                # Die Zielmaschine soll den Auftrag schaffen, ohne selbst
                # überzulaufen — sonst wandert der Engpass nur weiter.
                if queue[t.id] + m > t.capacity_min_per_day > 0:
                    continue
                if best is None or a.score > best.score:
                    best, best_m = a, m
            if best is None or best_m <= 0:
                continue
            queue[s.id] -= best_m
            queue[best.station_id] += best_m
            remaining = queue[s.id] - cap
            moved_min += best_m
            moves.append(
                {
                    "job_no": wo.no,
                    "from_id": s.id,
                    "from_label": s.label,
                    "station_id": best.station_id,
                    "label": best.label,
                    "minutes": round(best_m, 1),
                    "score": round(best.score, 1),
                    "reason": best.summary,
                }
            )

        if moves:
            findings.append(
                Finding(
                    kind="capacity",
                    severity="danger",
                    title=f"{s.label} ist überbucht",
                    detail=(
                        f"Warteschlange {_fmt_min(l.station.queue_min)} bei "
                        f"{_fmt_min(cap)} Tageskapazität ({_pct(l.ratio)}). "
                        f"{len(moves)} Innenauftrag/Aufträge passen auch auf eine freiere "
                        "Maschine — die Verlagerung rechnet der Zwilling durch, ausgeführt "
                        "wird sie erst per Klick in der Flussansicht."
                    ),
                    metric=(
                        f"{len(moves)} verlagerbar · {_fmt_min(moved_min)} · danach "
                        f"{_pct(queue[s.id] / cap if cap else None)}"
                    ),
                    station_ids=[s.id],
                    job_nos=[m["job_no"] for m in moves],
                    moves=moves,
                )
            )
        else:
            findings.append(
                Finding(
                    kind="capacity",
                    severity="danger",
                    title=f"{s.label} ist überbucht",
                    detail=(
                        f"Warteschlange {_fmt_min(l.station.queue_min)} bei "
                        f"{_fmt_min(cap)} Tageskapazität ({_pct(l.ratio)}). Kein offener "
                        "Auftrag darf auf eine andere freigebene Maschine — der Engpass "
                        "löst sich nur durch Kapazität, Zusatzschicht oder Annahme­stopp."
                    ),
                    metric=f"{_pct(l.ratio)} · {_fmt_min(l.station.queue_min - cap)} über Kapazität",
                    station_ids=[s.id],
                    job_nos=[w.no for w in l.jobs],
                )
            )

    if idle and over:
        for l in idle:
            findings.append(
                Finding(
                    kind="capacity",
                    severity="warning",
                    title=f"{l.station.label} ohne Aufträge",
                    detail=(
                        f"Kein Auftrag in der Warteschlange, während "
                        f"{', '.join(x.station.label for x in over)} überbucht ist. "
                        "Wenn diese Maschine denselben Werkstoff schneiden darf, lohnt ein "
                        "Blick in die Zuordnung — oft ist nur das Routing auf „Pull“ "
                        "gestellt oder der Werkstoff nicht freigegeben."
                    ),
                    metric=f"{_pct(l.ratio)} · {_pct(over[0].ratio)} nebenan",
                    station_ids=[l.station.id] + [x.station.id for x in over],
                )
            )
    elif idle and not over and len(loads) > 1:
        findings.append(
            Finding(
                kind="capacity",
                severity="info",
                title=f"{len(idle)} {'Maschine' if len(idle) == 1 else 'Maschinen'} ohne Aufträge",
                detail=" — ".join([f"{l.station.label}" for l in idle][:4])
                + f" {'hat' if len(idle) == 1 else 'haben'} nichts in der Schlange. Solange niemand überbucht ist, ist das "
                "ein Zustand, kein Fehler.",
                station_ids=[l.station.id for l in idle],
            )
        )

    warm = [l for l in loads if l.state == "warm"]
    if warm and not over:
        findings.append(
            Finding(
                kind="capacity",
                severity="info",
                title="Auslastung läuft voll",
                detail=" · ".join(f"{l.station.label} {_pct(l.ratio)}" for l in warm)
                + " — der nächste große Auftrag macht daraus einen Engpass.",
                station_ids=[l.station.id for l in warm],
            )
        )
    return findings


def _changeover_findings(db: Session, loads: list[StationLoad]) -> list[Finding]:
    """Rüstwechsel in der Schlange: dieselbe Platte wieder auflegen vermeiden.

    Die Rechnung ist bewusst bescheiden: gezählt werden nur die Wechsel, die
    ein Umordnen *innerhalb derselben Schlange* erspart — nicht eine bessere
    Welt, in der alle Aufträge eines Werkstoffs an einer Maschine laufen.
    """
    findings: list[Finding] = []
    for l in loads:
        s = l.station
        if s.changeover_min <= 0 or len(l.jobs) < 2:
            continue
        # Werkstoff und Dicke gehören zusammen: 2 mm und 3 mm desselben
        # Werkstoffs sind physisch verschiedene Rüstungen. Wer nur den Namen
        # vergleicht, wirft unterschiedliche Dicken in einen Topf und zählt
        # Wechsel, die in der Wirklichkeit stattfinden, nicht mit.
        seq = [(w.mat, float(w.thk or 0.0)) for w in l.jobs]
        switches = sum(1 for a, b in zip(seq, seq[1:]) if a != b)
        distinct = len(set(seq))
        optimal = max(0, distinct - 1)
        if switches <= optimal:
            continue
        save = (switches - optimal) * s.changeover_min
        groups: dict[tuple[str, float], list[str]] = {}
        for w in l.jobs:
            groups.setdefault((w.mat, float(w.thk or 0.0)), []).append(w.no)
        order = sorted(groups, key=lambda m: -len(groups[m]))

        def _label(key: tuple[str, float]) -> str:
            mat, thk = key
            return f"{mat} {thk:g} mm" if thk > 0 else str(mat)

        findings.append(
            Finding(
                kind="changeover",
                severity="warning",
                title=f"{s.label}: Rüstwechsel in der Schlange",
                detail=(
                    f"Die Schlange wechselt {switches}× den Werkstoff, "
                    f"{optimal}× würde reichen — umgestellt nach Menge: "
                    + " → ".join(f"{_label(m)} ({len(groups[m])})" for m in order)
                    + f". Bei {_fmt_min(s.changeover_min)} je Umrüsten sind das "
                    f"{_fmt_min(save)} gesparte Stillstandszeit, ohne dass ein Auftrag "
                    "die Maschine wechselt."
                ),
                metric=f"{switches - optimal} Wechsel · {_fmt_min(save)}",
                station_ids=[s.id],
                job_nos=[w.no for w in l.jobs],
            )
        )
    return findings


def _transport_findings(
    db: Session, specs: list[StationSpec], ctx: RoutingContext
) -> list[Finding]:
    """Wege, die die Halle jeden Tag läuft — und was ein Umzug bringen würde."""
    edges = fr.material_flow(db)
    findings: list[Finding] = []
    if not edges:
        return findings
    total = sum(e["metres"] * e["count"] for e in edges)
    span = _hall_span(ctx.layout) or 50.0
    by_id = {s.id: s for s in specs}
    stores = [s for s in specs if s.is_storage and s.active]

    for e in edges:
        if e["kind"] != "supply" or e["count"] < 2:
            continue
        target = by_id.get(e["to"])
        if target is None or e["metres"] < span * 0.35:
            continue
        mats = set(e["materials"] or [])
        # Wer denselben Werkstoff schneiden darf und näher am Lager steht?
        near: tuple[StationSpec, float] | None = None
        for s in specs:
            if s.type != "production" or not s.active or s.id == target.id:
                continue
            if s.materials and mats and not (mats & set(s.materials)):
                continue
            d = min(
                (r.metres for st in stores if (r := ctx.route_between(st, s)) is not None),
                default=None,
            )
            if d is None or d >= e["metres"] * 0.7:
                continue
            if near is None or d < near[1]:
                near = (s, d)
        if near is None:
            continue
        alt, d = near
        findings.append(
            Finding(
                kind="transport",
                severity="warning",
                title=f"Materialweg {target.label}: {e['metres']:.0f} m je Abholung",
                detail=(
                    f"Aus der Zuordnung abgeleitet, nicht gemeldet: {e['count']} Innenaufträge "
                    f"sind dieser Strecke vom Lager zugeordnet"
                    f"{' (' + ', '.join(e['materials'][:3]) + ')' if e['materials'] else ''}. "
                    f"{alt.label} darf dieselben Werkstoffe schneiden und steht "
                    f"{d:.0f} m am Lager — umgestellt spart das rund "
                    f"{(e['metres'] - d) * e['count']:.0f} m Weg."
                ),
                metric=f"{e['count']}-mal {e['metres']:.0f} m, möglich wären {d:.0f} m",
                station_ids=[target.id, alt.id],
                job_nos=[],
            )
        )

    if total > 0:
        findings.append(
            Finding(
                kind="transport",
                severity="info",
                title="Materialfluss der letzten Aufträge",
                detail=(
                    f"{len(edges)} Verbindungen, zusammen {total:.0f} m Transportweg. "
                    "Die Pfeile im Grundriss zeigen dieselben Kanten."
                ),
                metric=f"{total:.0f} m gesamt",
            )
        )
    return findings


def _layout_findings(
    db: Session, specs: list[StationSpec], ctx: RoutingContext
) -> list[Finding]:
    """Was der Grundriss selbst noch nicht hergibt — ehrlich, nicht dekorativ."""
    layout = ctx.layout
    findings: list[Finding] = []
    if len(layout.outline) < 3:
        findings.append(
            Finding(
                kind="layout",
                severity="warning",
                title="Kein Hallenumriss",
                detail=(
                    "Ohne Umriss gibt es kein Bezugsmaß für „weit weg“ und keine "
                    "Warnung, wenn eine Station aus der Halle rutscht. Im Editor "
                    "drei Punkte zeichnen oder eine Vorlage nehmen."
                ),
            )
        )
    elif not layout.aisles.usable:
        findings.append(
            Finding(
                kind="layout",
                severity="warning",
                title="Kein Gangnetz",
                detail=(
                    "Jede Entfernung zählt als Luftlinie — durch Wände und Regale. "
                    "Das Gangnetz ist der einzige Teil des Grundrisses, der in eine "
                    "Rechnung eingeht."
                ),
            )
        )
    stores = [s for s in specs if s.is_storage and s.active]
    if not stores:
        findings.append(
            Finding(
                kind="layout",
                severity="warning",
                title="Kein Lager markiert",
                detail="Der Weg-zum-Lager-Faktor der Zuordnung kann nichts messen.",
            )
        )

    outside = []
    for s in specs:
        if s.type == "production" and layout.outline and not layout.contains(s.point):
            outside.append(s.label)
    if outside:
        verb = "liegt" if len(outside) == 1 else "liegen"
        title = (
            "1 Station liegt außerhalb der Halle"
            if len(outside) == 1
            else f"{len(outside)} Stationen liegen außerhalb der Halle"
        )
        findings.append(
            Finding(
                kind="layout",
                severity="danger",
                title=title,
                detail=", ".join(outside) + f" {verb} außerhalb des Umrisses — "
                "im Plan oder in der Halle stimmt eines von beiden nicht.",
            )
        )

    gapped = [
        s for s in specs if s.type == "production" and s.active and _machine_gaps(s)
    ]
    if gapped:
        title = (
            "1 Maschine mit lückenhaften Werten"
            if len(gapped) == 1
            else f"{len(gapped)} Maschinen mit lückenhaften Werten"
        )
        findings.append(
            Finding(
                kind="data",
                severity="warning",
                title=title,
                detail=" · ".join(
                    f"{s.label} (fehlt: {', '.join(_machine_gaps(s))})"
                    for s in gapped[:4]
                )
                + (" …" if len(gapped) > 4 else "")
                + ". Die betroffenen Faktoren bleiben stumm — die Zuordnung rät nicht.",
                station_ids=[s.id for s in gapped],
            )
        )
    return findings


def _date_findings(db: Session, loads: list[StationLoad]) -> list[Finding]:
    """Termine gegen die eigene Schätzung — die Schlinge, die man früh sieht.

    Pro Station wird die Schlange in der Reihenfolge der Abarbeitungsliste kumuliert;
    reicht die kumulierte Belegzeit über das Fälligkeitsdatum eines Auftrags,
    hält die Schätzung den Termin für gefährdet. Das ist eine Warnung, keine
    Zusage — die Kapazität ist eine Tageszahl, kein Kalender.
    """
    findings: list[Finding] = []
    now = datetime.now(timezone.utc)
    for l in loads:
        if not l.jobs:
            continue
        cum = 0.0
        late: list[tuple[WorkOrder, float]] = []
        for w in l.jobs:
            cum += w.planned_min or 0.0
            if not w.due_date:
                continue
            due = (
                w.due_date
                if w.due_date.tzinfo
                else w.due_date.replace(tzinfo=timezone.utc)
            )
            finish = now + timedelta(minutes=cum)
            if finish > due:
                late.append((w, (finish - due).total_seconds() / 3600.0))
        if not late:
            continue
        late.sort(key=lambda t: -t[1])
        w, hours = late[0]
        findings.append(
            Finding(
                kind="dates",
                severity="danger",
                title=f"{l.station.label}: {w.no} läuft Gefahr",
                detail=(
                    f"{len(late)} von {len(l.jobs)} Innenaufträgen erreichen ihren Termin "
                    f"nicht, wenn die Schlange in dieser Reihenfolge läuft — "
                    f"{w.no} würde {_fmt_min(hours * 60)} zu spät fertig. Der Plan ist "
                    "kein Kalender, aber die Reihenfolge lässt sich drehen oder der "
                    "Auftrag wandert auf eine freiere Maschine."
                ),
                metric=f"{len(late)} Aufträge · bis {_fmt_min(hours * 60)} zu spät",
                station_ids=[l.station.id],
                job_nos=[x[0].no for x in late[:6]],
            )
        )
    return findings


def _feed_findings(
    db: Session, loads: list[StationLoad], specs: list[StationSpec], ctx: RoutingContext
) -> list[Finding]:
    """Leere Maschine, aber Arbeit, die dürfte — der Nachschub, der fehlt.

    Läuft der Nachschub (Automatik + feed_empty), ist dieser Zustand schon
    behoben, bevor jemand hinsieht. Der Befund erscheint also genau dann,
    wenn die Automatik aus ist oder die Station auf Pull steht: als Zahl,
    was der Stillstand kostet, und als konkreter Vorschlag, wer hin sollte.
    """
    findings: list[Finding] = []
    idle = [l for l in loads if l.state == "idle"]
    if not idle:
        return findings
    waiting = (
        db.query(WorkOrder)
        .filter(WorkOrder.station_id.is_(None))
        .filter(WorkOrder.status == WorkOrderStatus.open)
        .order_by(WorkOrder.created_at.asc())
        .all()
    )
    jobs = [(w, fr.job_spec(db, w)) for w in waiting]
    for l in idle:
        s = l.station
        if s.routing == "pull":
            continue  # wer Pull stellt, hat sich den Nachschub verboten
        best: tuple[float, WorkOrder, float, str] | None = None
        for wo, job in jobs:
            a = assess(job, s, specs, ctx)
            if not a.eligible:
                continue
            if best is None or a.score > best[0]:
                m = job_minutes(job, s, needs_changeover(job, s)) or 0.0
                best = (a.score, wo, m, a.summary)
        if best is None:
            continue
        score, wo, minutes, why = best
        findings.append(
            Finding(
                kind="feed",
                severity="warning",
                title=f"{s.label} steht leer, während Arbeit wartet",
                detail=(
                    f"{len(jobs)} Innenaufträge liegen in der Planung, und {wo.no} "
                    f"dürfte auf diese Maschine: {why}. Der Nachschub hätte es "
                    "zugeordnet — er ist ausgeschaltet (Betriebsschalter) oder "
                    "der nächste Takt kommt noch. Ein Klick erledigt es jetzt."
                ),
                metric=f"beste Wahl: {wo.no} · {minutes:.0f} min",
                station_ids=[s.id],
                job_nos=[wo.no],
                moves=[
                    {
                        "job_no": wo.no,
                        "from_id": None,
                        "from_label": "Planung",
                        "station_id": s.id,
                        "label": s.label,
                        "minutes": round(minutes, 1),
                        "score": round(score, 1),
                        "reason": why,
                    }
                ],
            )
        )
    return findings


def _hall_span(layout) -> float:
    if len(layout.outline) < 2:
        return 0.0
    import math

    xs = [p[0] for p in layout.outline]
    ys = [p[1] for p in layout.outline]
    return math.hypot(max(xs) - min(xs), max(ys) - min(ys))


# --------------------------------------------------------------------------
# Öffentlich
# --------------------------------------------------------------------------
def analyse(db: Session, *, limit_jobs: int = 200) -> dict:
    """Die ganze Zwillingssicht: Auslastungstabelle plus Befunde, ohne Aktion."""
    specs = fr.station_specs(db)
    ctx = fr.context(db)
    loads = _loads(db, specs)

    findings: list[Finding] = []
    findings += _capacity_findings(db, loads, specs, ctx)
    findings += _feed_findings(db, loads, specs, ctx)
    findings += _changeover_findings(db, loads)
    findings += _transport_findings(db, specs, ctx)
    findings += _layout_findings(db, specs, ctx)
    findings += _date_findings(db, loads)

    # Termine zuletzt — ihre kumulierte Schlange kennt keine Verlagerungen.
    open_unassigned = (
        db.query(WorkOrder)
        .filter(WorkOrder.station_id.is_(None))
        .filter(WorkOrder.status.in_(OPEN))
        .order_by(WorkOrder.created_at.asc())
        .limit(limit_jobs)
        .all()
    )
    severity_rank = {"danger": 0, "warning": 1, "info": 2, "success": 3}
    return {
        "loads": [l.to_dict() for l in loads],
        "findings": [
            f.to_dict()
            for f in sorted(findings, key=lambda f: severity_rank.get(f.severity, 9))
        ],
        "unassigned": len(open_unassigned),
        "summary": {
            "danger": sum(1 for f in findings if f.severity == "danger"),
            "warning": sum(1 for f in findings if f.severity == "warning"),
            "info": sum(1 for f in findings if f.severity == "info"),
            "total_queue_min": round(sum(l.station.queue_min for l in loads), 1),
            "total_capacity_min": round(sum(l.capacity for l in loads), 1),
        },
    }
