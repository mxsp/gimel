"""Wer macht was — Maschinenwahl und Bearbeiterzuordnung, als reine Funktion.

Rein: keine Datenbank, keine Uhr, keine Globals. Eingabe sind Werttypen,
Ausgabe ist eine Bewertung, die sich vorlesen lässt.

Die Regel dieses Hauses steht in CLAUDE.md §5.5: *eine Regel, deren
Entscheidung man nicht nachlesen kann, wird beim ersten Zweifel
abgeschaltet.* Deshalb liefert dieser Rechenkern nie nur eine Zahl. Jede
Bewertung zerfällt in benannte Faktoren, jeder Faktor trägt seinen Beitrag
**und** seinen Satz auf Deutsch, und jeder Ausschluss sagt, warum
ausgeschlossen wurde. Die Oberfläche zeigt diese Zerlegung; der Meister
kann sie überstimmen — die Überstimmung steht als Begründung auf dem
Innenauftrag, sie fließt nicht in die Regel zurück. **Diese Zuordnung
lernt nicht.** Sie rechnet mit dem, was messbar vorliegt: Maschinenwerte,
Warteschlangen, Rüstzustand, Wege. Eine Regel, die mitzählt, was gewesen
ist, hört auf eine Logik, die niemand mehr nachlesen kann.

Zweitens, genauso wichtig: **die Zuordnung ist kein Preis.** Sie darf sich
ändern, sobald die Halle sich ändert, ohne dass irgendein Angebot wackelt.
Deshalb ist sie hier und nicht im Nester (CLAUDE.md §5.5, „eine
Werkstattentscheidung darf einen bestätigten Preis nie bewegen").
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional, Sequence

from .layout import Layout, Route


# --------------------------------------------------------------------------
# Gewichte. Zusammen 100 — damit eine Bewertung eine Prozentzahl ist und die
# Balken in der Oberfläche vergleichbar bleiben.
#
# ACHTUNG: Diese Zahlen sind eine Voreinstellung, keine Messung. Sie stehen
# an einer Stelle, sind pro Betrieb überschreibbar (``Weights``) und gehören
# auf die Liste in CLAUDE.md §7, sobald der erste Monat Fertigungsdaten da
# ist. Was sie ausdrückt, ist eine Reihenfolge, die begründbar ist:
# Rüsten spart Stunden, Wege sparen Minuten — also wiegt Rüsten schwerer.
# Alle Faktoren sind Physik oder ausdrückliche Eingrenzung; Erfahrung aus
# früheren Aufträgen ist bewusst kein Faktor (siehe Moduldocstring).
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Weights:
    changeover: float = 25.0  # kein Werkstoff-/Dickenwechsel = kein Rüsten
    speed: float = 18.0  # reine Schnittzeit auf dieser Maschine
    load: float = 18.0  # freie Kapazität — hält die schnellste Maschine offen
    distance: float = 12.0  # Weg zum Lager, das den Werkstoff führt
    fit: float = 9.0  # ausdrückliche Eingrenzung der Station
    deadline: float = 18.0  # Puffer bis zur Zusage — hält das Versprechen

    def total(self) -> float:
        return (
            self.changeover
            + self.speed
            + self.load
            + self.distance
            + self.fit
            + self.deadline
        )


@dataclass(frozen=True)
class HandlerWeights:
    customer: float = 45.0  # denselben Kunden kennt man
    load: float = 25.0  # wer wenig offen hat, bekommt den nächsten
    material: float = 15.0  # Werkstofferfahrung
    station: float = 15.0  # an einer passenden Station eingetragen

    def total(self) -> float:
        return self.customer + self.load + self.material + self.station


# --------------------------------------------------------------------------
# Eingaben
# --------------------------------------------------------------------------
@dataclass
class StationSpec:
    """Eine Station, so wie der Rechenkern sie sieht."""

    id: int
    label: str
    type: str  # production | warehouse | shipping | accounting
    x: float = 0.0
    y: float = 0.0
    active: bool = True
    routing: str = "pull"  # pull | smart_suggest | smart_auto
    machine_kind: str = ""  # plotter | punch | waterjet | manual | ""
    materials: list[str] = field(default_factory=list)
    thicknesses: list[float] = field(default_factory=list)
    assigned_users: list[int] = field(default_factory=list)

    # Maschinenparameter. 0 heißt „unbekannt" und wird nirgends als 0 gerechnet,
    # sondern schaltet den betroffenen Faktor ab — eine erfundene
    # Schnittgeschwindigkeit wäre schlimmer als gar keine (CLAUDE.md §7).
    speed_mm_s: float = 0.0  # Schnittvorschub
    pierce_s: float = 0.0  # Anstechen/Positionieren je Teil
    setup_min: float = 0.0  # Rüsten je Innenauftrag
    changeover_min: float = 0.0  # Aufschlag bei Werkstoff-/Dickenwechsel
    handling_min_per_plate: float = 0.0  # Platte auflegen und abräumen
    max_sheet_w: float = 0.0  # mm, 0 = keine Grenze bekannt
    max_sheet_h: float = 0.0
    thk_min: float = 0.0
    thk_max: float = 0.0
    cost_per_h: float = 0.0
    capacity_min_per_day: float = 0.0
    is_storage: bool = False

    # Zeitwerte der nicht schneidenden Stationen. Ein Packtisch hat keinen
    # Vorschub in mm/s, aber er hat ein Aufsetzen und ein Pro-Stück — und ohne
    # die beiden Zahlen kann er so wenig eine Fertigstellung versprechen wie
    # ein Plotter ohne Vorschub. 0 heißt auch hier „unbekannt", nicht „null".
    #: Grundzeit je Vorgang, in Minuten (Sendung anlegen, Auftrag aufrufen).
    task_min: float = 0.0
    #: Zeit je Einheit, in Minuten (Platte holen, Position packen, prüfen).
    unit_min: float = 0.0

    #: Belegte Minuten aus bereits zugeordneten Innenaufträgen.
    queue_min: float = 0.0
    #: Werkstoff und Dicke des zuletzt hier eingeplanten Auftrags — die
    #: Grundlage des Rüstwechsel-Faktors. None = die Maschine steht kalt.
    last_mat: Optional[str] = None
    last_thk: Optional[float] = None
    #: Ebene und Halle, auf der die Station steht. None = einzige/erste Ebene;
    #: zwei Stationen mit None stehen im selben Grundriss.
    floor_id: Optional[int] = None
    hall_id: Optional[int] = None

    @property
    def point(self) -> tuple[float, float]:
        return (self.x, self.y)


@dataclass
class JobSpec:
    """Ein Innenauftrag, so wie der Rechenkern ihn sieht."""

    no: str
    mat: str
    mat_name: str = ""
    thk: float = 0.0
    n_plates: int = 1
    n_parts: int = 0
    #: Summe der Schnittlängen aller Teile, in Millimetern. Aus den
    #: Bestellpositionen, nicht geschätzt.
    cut_len_mm: float = 0.0
    #: Größte Platte des Auftrags [Breite, Höhe] in mm.
    plate_mm: tuple[float, float] = (0.0, 0.0)
    rush: bool = False
    due_in_days: Optional[float] = None
    customer_refs: list[str] = field(default_factory=list)
    #: Welcher Stationstyp diese Arbeit macht. Voreinstellung ist die
    #: Fertigung, weil ein Innenauftrag die häufigste Eingabe ist — aber der
    #: Kern ist nicht auf sie beschränkt: Kommissionieren, Packen und
    #: Auftragsbearbeitung laufen durch dieselbe Eignungsprüfung und
    #: dieselbe Bewertung, nur auf Stationen ihres eigenen Typs.
    station_type: str = "production"
    #: Mengengerüst der nicht schneidenden Arbeiten (Platten, Positionen).
    units: int = 1
    #: Fertigungsort-Vorgabe als Menge erlaubter Ebenen. None = überall.
    #: Leere Menge = nirgends (unvereinbare Vorgaben) — nie still „überall".
    allowed_floors: Optional[frozenset[int]] = None
    #: Klartext der Vorgabe für den Ausschlussgrund, z. B. „nur Halle 2".
    scope_label: str = ""


@dataclass
class Factor:
    """Ein Beitrag zur Bewertung, mit seinem Satz."""

    key: str
    label: str
    points: float
    max_points: float
    reason: str

    @property
    def share(self) -> float:
        return self.points / self.max_points if self.max_points > 0 else 0.0


@dataclass
class Assessment:
    """Was für eine Station herauskam — Zahl, Zerlegung, Klartext."""

    station_id: int
    label: str
    routing: str
    eligible: bool
    score: float
    factors: list[Factor] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    minutes: float = 0.0
    #: Wann der Auftrag hier fertig wäre: Warteschlange plus Belegzeit.
    #: ``None``, solange die Maschine keine Schnittgeschwindigkeit hat —
    #: dann kann sie keine Fertigstellung versprechen.
    completion_min: Optional[float] = None
    cost_eur: float = 0.0
    route_m: float = 0.0
    route_exact: bool = False
    changeover: bool = True

    @property
    def summary(self) -> str:
        if not self.eligible:
            return "; ".join(self.blockers) or "nicht geeignet"
        top = sorted(self.factors, key=lambda f: f.points, reverse=True)[:3]
        return " · ".join(f.reason for f in top if f.reason)

    def to_dict(self) -> dict:
        return {
            "station_id": self.station_id,
            "label": self.label,
            "routing": self.routing,
            "eligible": self.eligible,
            "score": round(self.score, 1),
            "minutes": round(self.minutes, 1),
            "completion_min": round(self.completion_min, 1)
            if self.completion_min is not None
            else None,
            "cost_eur": round(self.cost_eur, 2),
            "route_m": round(self.route_m, 1),
            "route_exact": self.route_exact,
            "changeover": self.changeover,
            "summary": self.summary,
            "blockers": list(self.blockers),
            "factors": [
                {
                    "key": f.key,
                    "label": f.label,
                    "points": round(f.points, 1),
                    "max": round(f.max_points, 1),
                    "share": round(f.share, 3),
                    "reason": f.reason,
                }
                for f in self.factors
            ],
        }


@dataclass
class RoutingContext:
    """Alles, was nicht am Auftrag und nicht an der Station hängt.

    Bewusst ohne Lerndaten: was hier drinsteht, ist Halle (Layout), Uhr
    (Gehgeschwindigkeit) und die vom Betrieb überschriebenen Gewichte. Kein
    Zähler, kein Verlauf — dieselbe Halle ergibt immer dieselbe Bewertung.
    """

    layout: Layout = field(default_factory=Layout)
    weights: Weights = field(default_factory=Weights)
    #: Gehgeschwindigkeit in der Halle, m/min — Hubwagen, nicht Sprint.
    walk_m_per_min: float = 60.0
    #: Grundriss je Ebene. Leer = nur ``layout`` (eine Halle, eine Ebene).
    layouts: dict[int, Layout] = field(default_factory=dict)
    #: Kartenlage je Halle (Aufgabe 33). Nur Hallen mit Anker stehen hier.
    halls: dict[int, "HallGeo"] = field(default_factory=dict)

    def layout_for(self, floor_id: Optional[int]) -> Layout:
        if floor_id is not None and floor_id in self.layouts:
            return self.layouts[floor_id]
        return self.layout

    def route_between(self, a: "StationSpec", b: "StationSpec") -> Optional[Route]:
        """Weg zwischen zwei Stationen über Ebenen und Hallen hinweg.

        Dieselbe Ebene: über deren Gänge. Andere Ebene derselben Halle: die
        Grundrisse teilen das Koordinatensystem, also Luftlinie plus ein
        fester Aufschlag für Treppe oder Aufzug — als Schätzung markiert.
        Andere Halle am selben Standort: nur wenn beide auf der Karte liegen,
        dann Luftlinie über die Kartenlage mal Hofumweg plus Tor zu Tor —
        geschätzt. Ohne Anker oder an einem anderen Standort: kein Weg, denn
        zwei Grundrisse haben verschiedene Ursprünge und eine Zahl wäre geraten.
        """
        if a.floor_id == b.floor_id:
            return self.layout_for(a.floor_id).route(a.point, b.point)
        if a.hall_id is not None and a.hall_id == b.hall_id:
            d = ((a.x - b.x) ** 2 + (a.y - b.y) ** 2) ** 0.5 + LEVEL_CHANGE_M
            return Route(metres=d, exact=False, note="andere Ebene — geschätzt", kind="air")
        ha = self.halls.get(a.hall_id) if a.hall_id is not None else None
        hb = self.halls.get(b.hall_id) if b.hall_id is not None else None
        if ha and hb and ha.site_id is not None and ha.site_id == hb.site_id:
            # Beide Hallen liegen auf der Karte: Luftlinie über die Kartenlage,
            # mal Umwegfaktor, plus Tor-zu-Tor. Eine Schätzung, und so markiert.
            ea, na = ha.to_world(a.x, a.y, ha)
            eb, nb = hb.to_world(b.x, b.y, ha)
            d = ((ea - eb) ** 2 + (na - nb) ** 2) ** 0.5 * YARD_DETOUR + HALL_CHANGE_M
            return Route(metres=d, exact=False, note="andere Halle — über die Kartenlage geschätzt", kind="air")
        return None


#: Aufschlag für einen Ebenenwechsel (Treppe, Aufzug), in Metern Weg.
LEVEL_CHANGE_M = 30.0
#: Hallenwechsel am selben Standort: Umweg über den Hof und Tor zu Tor.
YARD_DETOUR = 1.3
HALL_CHANGE_M = 20.0
_M_PER_DEG = 111_320.0


@dataclass(frozen=True)
class HallGeo:
    """Wo der Ursprung eines Hallengrundrisses auf der Erde liegt.

    Dieselbe Abbildung wie die Oberfläche (``web/src/sites.ts`` hallToWorld):
    der Plan zählt y nach Süden, ``rotation_deg`` dreht die x-Achse gegen den
    Uhrzeigersinn aus Osten. Für Entfernungen auf einem Werksgelände genügt die
    lokale Tangentialebene um den Bezugsanker.
    """

    lat: float
    lon: float
    rotation_deg: float = 0.0
    site_id: Optional[int] = None

    def to_world(self, x: float, y: float, ref: "HallGeo") -> tuple[float, float]:
        """Hallenmeter → Meter Ost/Nord, bezogen auf den Anker ``ref``."""
        t = math.radians(self.rotation_deg)
        e = x * math.cos(t) + y * math.sin(t)
        n = x * math.sin(t) - y * math.cos(t)
        de = (self.lon - ref.lon) * _M_PER_DEG * math.cos(math.radians(ref.lat))
        dn = (self.lat - ref.lat) * _M_PER_DEG
        return e + de, n + dn


# --------------------------------------------------------------------------
# Zeit- und Wegmodell
# --------------------------------------------------------------------------
def cut_minutes(job: JobSpec, st: StationSpec) -> Optional[float]:
    """Reine Bearbeitungszeit auf dieser Maschine, in Minuten.

    ``None``, wenn die Maschine keine hinterlegte Geschwindigkeit hat — dann
    fällt der Geschwindigkeitsfaktor weg, statt eine Zahl zu erfinden.
    """
    if st.speed_mm_s <= 0:
        return None
    cutting = job.cut_len_mm / st.speed_mm_s / 60.0
    piercing = job.n_parts * st.pierce_s / 60.0
    handling = job.n_plates * st.handling_min_per_plate
    return cutting + piercing + handling


def job_minutes(job: JobSpec, st: StationSpec, changeover: bool) -> Optional[float]:
    """Belegzeit gesamt: Rüsten (+ Wechsel) plus Bearbeitung."""
    cut = cut_minutes(job, st)
    if cut is None:
        return None
    setup = st.setup_min + (st.changeover_min if changeover else 0.0)
    return setup + cut


def needs_changeover(job: JobSpec, st: StationSpec) -> bool:
    """Muss umgerüstet werden? Kalte Maschine zählt als Wechsel."""
    if st.last_mat is None:
        return True
    if st.last_mat != job.mat:
        return True
    if st.last_thk is None:
        return True
    return abs(float(st.last_thk) - float(job.thk)) > 1e-6


def storage_route(
    job: JobSpec, st: StationSpec, stations: Sequence[StationSpec], ctx: RoutingContext
) -> tuple[Optional[Route], Optional[StationSpec]]:
    """Weg vom nächsten Lager, das diesen Werkstoff führt, zur Station.

    Ein Lager ohne Werkstoff-Eingrenzung führt alles — das ist der Normalfall
    einer kleinen Halle und darf kein Ausschluss sein.
    """
    stores = [s for s in stations if s.is_storage and s.active]
    if not stores:
        return None, None
    matching = [s for s in stores if not s.materials or job.mat in s.materials]
    pool = matching or stores
    best_route: Optional[Route] = None
    best_store: Optional[StationSpec] = None
    for store in pool:
        r = ctx.route_between(store, st)
        if r is None:
            continue
        if best_route is None or r.metres < best_route.metres:
            best_route, best_store = r, store
    return best_route, best_store


# --------------------------------------------------------------------------
# Maschinenwahl
# --------------------------------------------------------------------------
def _fmt_m(v: float) -> str:
    return f"{v:.0f} m".replace(".", ",")


def _fmt_min(v: float) -> str:
    if v >= 60:
        return f"{v / 60:.1f} h".replace(".", ",")
    return f"{v:.0f} min"


#: Wie eine Station in einem Ausschlusssatz heißt. Nur Beschriftung — der
#: Vergleich läuft über ``JobSpec.station_type``.
_TYPE_NOUN: dict[str, str] = {
    "production": "Fertigungsstation",
    "warehouse": "Lagerstation",
    "shipping": "Versandstation",
    "accounting": "Bearbeitungsstation",
}

#: Stationstypen, bei denen die Werkstoff-Eingrenzung greift. Ein Lager führt
#: bestimmte Werkstoffe, eine Maschine ist für bestimmte freigegeben — ein
#: Packtisch und ein Schreibtisch nicht, dort wäre die Eingrenzung ein
#: wortloser Ausschluss ohne Sinn.
_MATERIAL_TYPES = {"production", "warehouse"}


def eligibility(job: JobSpec, st: StationSpec) -> list[str]:
    """Harte Ausschlüsse. Leer heißt: darf.

    Ausschlüsse sind bewusst wenige und alle physisch — was nicht auf die
    Maschine passt, passt nicht. Vorlieben gehören in die Faktoren, nicht
    hierher; sonst verschwindet eine Station wortlos aus der Liste.

    Der Typ ist der erste Ausschluss, und er ist **nicht auf die Fertigung
    festgenagelt**: die Arbeit sagt, welchen Stationstyp sie braucht
    (``JobSpec.station_type``), und dieselbe Prüfung gilt dann für einen
    Packtisch wie für einen Plotter. Was danach kommt, sind Maschinenmaße —
    Tischgröße und Dickenbereich —, und die prüft nur, wer eine Maschine ist.
    """
    out: list[str] = []
    want = job.station_type or "production"
    if not st.active:
        out.append("Station ist inaktiv")
    if job.allowed_floors is not None and st.floor_id not in job.allowed_floors:
        out.append(f"außerhalb der Vorgabe ({job.scope_label or 'Fertigungsort'})")
    if st.type != want:
        out.append(f"keine {_TYPE_NOUN.get(want, 'passende Station')}")
    if (
        st.type in _MATERIAL_TYPES
        and st.materials
        and job.mat
        and job.mat not in st.materials
    ):
        out.append(f"Werkstoff {job.mat} nicht freigegeben")
    if (
        st.type in _MATERIAL_TYPES
        and st.thicknesses
        and job.thk
        and not any(abs(float(t) - float(job.thk)) < 1e-6 for t in st.thicknesses)
    ):
        out.append(f"Dicke {job.thk:g} mm nicht freigegeben".replace(".", ","))
    if st.type != "production":
        # Tischgröße und Dickenbereich sind Maschinenmaße. Ein Regal hat keinen
        # Tisch, und eine Sendung passt nicht „nicht auf den Packtisch".
        return out
    if st.thk_min > 0 and job.thk and job.thk < st.thk_min - 1e-6:
        out.append(f"unter der Mindestdicke {st.thk_min:g} mm".replace(".", ","))
    if st.thk_max > 0 and job.thk and job.thk > st.thk_max + 1e-6:
        out.append(f"über der Maximaldicke {st.thk_max:g} mm".replace(".", ","))
    pw, ph = job.plate_mm
    if st.max_sheet_w > 0 and st.max_sheet_h > 0 and pw > 0 and ph > 0:
        fits = (pw <= st.max_sheet_w + 1e-6 and ph <= st.max_sheet_h + 1e-6) or (
            ph <= st.max_sheet_w + 1e-6 and pw <= st.max_sheet_h + 1e-6
        )
        if not fits:
            out.append(
                f"Platte {pw:.0f} × {ph:.0f} mm größer als der Tisch "
                f"{st.max_sheet_w:.0f} × {st.max_sheet_h:.0f} mm"
            )
    return out


def assess(
    job: JobSpec, st: StationSpec, stations: Sequence[StationSpec], ctx: RoutingContext
) -> Assessment:
    """Eine Station gegen einen Innenauftrag bewerten."""
    blockers = eligibility(job, st)
    w = ctx.weights
    change = needs_changeover(job, st)
    minutes = job_minutes(job, st, change)
    route, store = storage_route(job, st, stations, ctx)

    a = Assessment(
        station_id=st.id,
        label=st.label,
        routing=st.routing,
        eligible=not blockers,
        score=0.0,
        blockers=blockers,
        minutes=minutes or 0.0,
        # Fertigstellung = Warteschlange + Belegzeit. Ohne hinterlegter
        # Schnittgeschwindigkeit keine Zahl — und damit keine Zusage.
        completion_min=(st.queue_min + minutes) if minutes is not None else None,
        cost_eur=(minutes or 0.0) / 60.0 * st.cost_per_h if st.cost_per_h > 0 else 0.0,
        route_m=route.metres if route else 0.0,
        route_exact=bool(route and route.exact),
        changeover=change,
    )
    if blockers:
        return a

    # ---- Rüstwechsel ------------------------------------------------------
    if not change:
        a.factors.append(
            Factor(
                "changeover",
                "Rüstwechsel",
                w.changeover,
                w.changeover,
                f"läuft schon auf {job.mat_name or job.mat} {job.thk:g} mm — kein Rüsten".replace(
                    ".", ","
                ),
            )
        )
    elif st.last_mat is None:
        # Kalte Maschine ist kein Vorwurf, aber auch kein Vorteil.
        a.factors.append(
            Factor(
                "changeover",
                "Rüstwechsel",
                w.changeover * 0.35,
                w.changeover,
                "Maschine steht frei — Rüsten fällt an",
            )
        )
    else:
        penalty_free = w.changeover * 0.1
        a.factors.append(
            Factor(
                "changeover",
                "Rüstwechsel",
                penalty_free,
                w.changeover,
                f"umrüsten von {st.last_mat} {(st.last_thk or 0):g} mm".replace(
                    ".", ","
                ),
            )
        )

    # ---- Weg zum Lager ----------------------------------------------------
    if route is None:
        a.factors.append(
            Factor(
                "distance",
                "Weg zum Lager",
                w.distance * 0.5,
                w.distance,
                "kein Lager erfasst — Weg unbekannt",
            )
        )
    else:
        # Bezugsgröße ist die Hallendiagonale: 0 m volle Punkte, eine ganze
        # Diagonale null. Ohne Umriss: 50 m als Ersatzmaß.
        span = _hall_span(ctx.layout_for(st.floor_id)) or 50.0
        rel = min(1.0, route.metres / span)
        pts = w.distance * (1.0 - rel)
        # Luftlinie ist weniger belastbar — 15 % Abzug, damit ein echtes
        # Gangmaß gewinnt, selbst wenn die Luftlinie kürzer wirkt.
        if not route.exact:
            pts *= 0.85
        walk = route.metres / max(ctx.walk_m_per_min, 1.0)
        note = "" if route.exact else " (Luftlinie)"
        a.factors.append(
            Factor(
                "distance",
                "Weg zum Lager",
                pts,
                w.distance,
                f"{_fmt_m(route.metres)} von {store.label if store else 'Lager'}"
                f" ≈ {walk:.0f} min Transport{note}",
            )
        )

    # ---- Geschwindigkeit --------------------------------------------------
    if minutes is None:
        a.factors.append(
            Factor(
                "speed",
                "Bearbeitungszeit",
                0.0,
                w.speed,
                "keine Schnittgeschwindigkeit hinterlegt — Zeit unbekannt",
            )
        )
    else:
        # Gegen die schnellste geeignete Maschine, nicht gegen eine Konstante:
        # was „schnell" heißt, entscheidet der Maschinenpark, nicht der Code.
        best = _fastest_minutes(job, stations)
        rel = (best / minutes) if (best and minutes > 0) else 1.0
        pts = w.speed * max(0.0, min(1.0, rel))
        # Kostenblick: die günstigste Maschine bekommt die vollen Punkte,
        # teurere verlieren proportional — aber nur leicht, damit ein
        # eiliger Auftrag nicht zur billigsten, sondern zur schnellsten geht.
        cheapest = _cheapest_cost(job, stations)
        if cheapest is not None and a.cost_eur > 0 and cheapest > 0:
            cost_rel = cheapest / a.cost_eur
            # Nur 20 % des Unterschieds schlagen auf den Faktor durch.
            pts *= 0.8 + 0.2 * max(0.0, min(1.0, cost_rel))
        queue_note = (
            f" · {_fmt_min(st.queue_min)} Warteschlange" if st.queue_min > 0 else ""
        )
        cost_note = (
            f" · {a.cost_eur:,.2f} €".replace(",", "#").replace(".", ",").replace("#", ".")
            if a.cost_eur > 0
            else ""
        )
        a.factors.append(
            Factor(
                "speed",
                "Bearbeitungszeit",
                pts,
                w.speed,
                f"{_fmt_min(minutes)} inkl. Rüsten{queue_note}{cost_note}"
                + (
                    f" — schnellste Maschine {_fmt_min(best)}"
                    if best and best < minutes * 0.98
                    else ""
                ),
            )
        )

    # ---- Auslastung -------------------------------------------------------
    if st.capacity_min_per_day > 0:
        after = st.queue_min + (minutes or 0.0)
        rel = min(1.5, after / st.capacity_min_per_day)
        pts = w.load * max(0.0, 1.0 - rel / 1.5)
        a.factors.append(
            Factor(
                "load",
                "Auslastung",
                pts,
                w.load,
                f"Warteschlange {_fmt_min(st.queue_min)} von {_fmt_min(st.capacity_min_per_day)}/Tag"
                + (" — überlastet" if after > st.capacity_min_per_day else ""),
            )
        )
    else:
        pts = w.load * (0.6 if st.queue_min <= 0 else 0.3)
        a.factors.append(
            Factor(
                "load",
                "Auslastung",
                pts,
                w.load,
                "keine Tageskapazität hinterlegt"
                + (
                    " · Warteschlange leer"
                    if st.queue_min <= 0
                    else f" · {_fmt_min(st.queue_min)} in der Schlange"
                ),
            )
        )

    # ---- Zusage / Termin --------------------------------------------------
    # Neu seit 2026-08: die Zusage ist ein eigener Faktor. Der Plan hat eine
    # Meterzahl (Fertigstellung), die Halle hat ein Versprechen (due_in_days) —
    # hier werden sie verglichen. Eine Station, die das Versprechen bricht,
    # bekommt 0 Punkte, auch wenn sie sonst die beste wäre.
    if job.due_in_days is None:
        a.factors.append(
            Factor(
                "deadline",
                "Zusage",
                w.deadline * 0.5,
                w.deadline,
                "keine Zusage hinterlegt — kein Termindruck",
            )
        )
    elif a.completion_min is None:
        a.factors.append(
            Factor(
                "deadline",
                "Zusage",
                w.deadline * 0.3,
                w.deadline,
                "keine Zeitprognose — Zusage nicht prüfbar",
            )
        )
    else:
        slack_min = job.due_in_days * 24.0 * 60.0 - a.completion_min
        if slack_min < 0:
            pts = 0.0
            reason = f"Zusage um {_fmt_min(-slack_min)} verfehlt — Termin gebrochen"
        elif slack_min < 60:
            pts = w.deadline * 0.15
            reason = f"Zusage in {_fmt_min(slack_min)} — kaum Puffer"
        elif slack_min < 240:
            pts = w.deadline * 0.45
            reason = f"Zusage in {_fmt_min(slack_min)} — knapper Puffer"
        elif slack_min < 24 * 60:
            pts = w.deadline * 0.75
            reason = f"Zusage in {_fmt_min(slack_min)} — Puffer ok"
        elif slack_min < 3 * 24 * 60:
            pts = w.deadline * 0.9
            reason = f"Zusage in {_fmt_min(slack_min)} — viel Puffer"
        else:
            pts = w.deadline
            reason = f"Zusage in {_fmt_min(slack_min)} — sehr viel Puffer"
        a.factors.append(
            Factor("deadline", "Zusage", pts, w.deadline, reason)
        )

    # ---- Ausdrückliche Eingrenzung ---------------------------------------
    # Bewusst der letzte feste Faktor und bewusst ohne „Erfahrung": welche Maschine
    # welche Aufträge schon gemacht hat, ist keine Physik. Was hier zählt,
    # ist allein, was der Betrieb der Station ausdrücklich zugewiesen hat.
    fit_bits = []
    fit = 0.0
    if st.materials and job.mat in st.materials:
        fit += w.fit * 0.6
        fit_bits.append(f"{job.mat} ausdrücklich freigegeben")
    if st.thicknesses and any(
        abs(float(t) - float(job.thk)) < 1e-6 for t in st.thicknesses
    ):
        fit += w.fit * 0.4
        fit_bits.append(f"{job.thk:g} mm ausdrücklich freigegeben".replace(".", ","))
    a.factors.append(
        Factor(
            "fit",
            "Eingrenzung",
            fit,
            w.fit,
            " · ".join(fit_bits) or "Station ohne Eingrenzung — nimmt alles",
        )
    )

    a.score = sum(f.points for f in a.factors)

    # Ein Eilauftrag verschiebt das Gewicht: Zeit vor Material. Nicht durch
    # andere Gewichte, sondern durch einen sichtbaren Zuschlag — sonst hätte
    # dieselbe Bewertung zwei Bedeutungen. Seit deadline-Faktor zählt er mit.
    if job.rush or (job.due_in_days is not None and job.due_in_days <= 1):
        speed_f = next((f for f in a.factors if f.key == "speed"), None)
        load_f = next((f for f in a.factors if f.key == "load"), None)
        dead_f = next((f for f in a.factors if f.key == "deadline"), None)
        bonus = 0.5 * (
            (speed_f.points if speed_f else 0.0)
            + (load_f.points if load_f else 0.0)
            + (dead_f.points if dead_f else 0.0) * 0.6
        )
        a.factors.append(
            Factor(
                "rush",
                "Termindruck",
                bonus,
                w.speed + w.load + w.deadline,
                "Eilauftrag — Zeit und freie Kapazität zählen doppelt"
                if job.rush
                else "Zusage läuft ab — Zeit zählt doppelt",
            )
        )
        a.score += bonus

    return a


def _hall_span(layout: Layout) -> float:
    """Diagonale der Halle in Metern — das Bezugsmaß für „weit weg"."""
    if len(layout.outline) < 2:
        return 0.0
    xs = [p[0] for p in layout.outline]
    ys = [p[1] for p in layout.outline]
    return math.hypot(max(xs) - min(xs), max(ys) - min(ys))


def _fastest_minutes(job: JobSpec, stations: Sequence[StationSpec]) -> Optional[float]:
    best: Optional[float] = None
    for s in stations:
        if s.type != (job.station_type or "production") or not s.active:
            continue
        if eligibility(job, s):
            continue
        m = job_minutes(job, s, needs_changeover(job, s))
        if m is not None and (best is None or m < best):
            best = m
    return best


def _cheapest_cost(job: JobSpec, stations: Sequence[StationSpec]) -> Optional[float]:
    best: Optional[float] = None
    for s in stations:
        if s.type != (job.station_type or "production") or not s.active:
            continue
        if eligibility(job, s):
            continue
        m = job_minutes(job, s, needs_changeover(job, s))
        if m is None:
            continue
        cost = m / 60.0 * (s.cost_per_h or 0.0) if s.cost_per_h > 0 else 0.0
        # 0 cost (unknown) is not cheaper — it is unknown, ignore.
        if s.cost_per_h <= 0:
            continue
        if best is None or cost < best:
            best = cost
    return best


def rank_stations(
    job: JobSpec, stations: Sequence[StationSpec], ctx: RoutingContext
) -> list[Assessment]:
    """Alle Stationen bewerten, beste zuerst — nach Fertigstellungszeit.

    Die Ordnung ist die Effizienzregel selbst: **der Auftrag geht dorthin,
    wo er zuerst fertig ist.** Eine freie Maschine schlägt eine volle, weil
    die Warteschlange in die Fertigstellung eingeht; eine eingerichtete
    schlägt eine kalte, weil das Umrüsten mitzählt; und der Planer gibt jede
    Zuteilung der nächsten als Warteschlange mit (``plan_open_work_orders``),
    sodass ein ganzer Stapel Aufträge sich von selbst über den Park verteilt.
    Erst bei Gleichstand entscheidet der Punktwert (Wege, Eingrenzung),
    dann die Id — stabil, damit dieselbe Halle zweimal dieselbe Reihenfolge
    ergibt.

    Stationen ohne hinterlegte Schnittgeschwindigkeit können keine
    Fertigstellung versprechen; sie folgen hinter allen, die es können, und
    werden untereinander nach Punkten geordnet. Das ist keine Strafe,
    sondern Ehrlichkeit: eine Effizienz, die auf einer erfundenen Zahl
    beruhte, wäre keine (CLAUDE.md §7).

    Ungeeignete kommen mit, ganz unten und mit ihrem Grund — eine Station,
    die wortlos aus der Liste verschwindet, ist ein Rätsel für den Meister.
    """
    out = [assess(job, s, stations, ctx) for s in stations]
    # Deadline-Bruch schlägt Geschwindigkeit: eine Maschine, die das
    # Versprechen hält, gewinnt gegen eine schnellere, die es bricht — auch
    # wenn die schnelle früher fertig wäre (fertig zu spät ist nicht fertig).
    def _misses(a: Assessment) -> int:
        if job.due_in_days is None or a.completion_min is None:
            return 0
        return 1 if (job.due_in_days * 24.0 * 60.0 - a.completion_min) < -1e-9 else 0

    out.sort(
        key=lambda a: (
            a.eligible,
            a.completion_min is not None,
            -_misses(a),
            -(a.completion_min or 0.0),
            a.score,
            -a.station_id,
        ),
        reverse=True,
    )
    return out


@dataclass
class Suggestion:
    """Was der Planer mit einem Innenauftrag vorhat."""

    job_no: str
    station_id: Optional[int]
    label: str
    score: float
    mode: str  # auto | suggest | none
    reason: str
    ranking: list[Assessment] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "job_no": self.job_no,
            "station_id": self.station_id,
            "label": self.label,
            "score": round(self.score, 1),
            "mode": self.mode,
            "reason": self.reason,
            "ranking": [a.to_dict() for a in self.ranking],
        }


def plan_job(
    job: JobSpec, stations: Sequence[StationSpec], ctx: RoutingContext
) -> Suggestion:
    """Eine Empfehlung — und ob sie von selbst gilt.

    Das Opt-in liegt an der Station, nicht am Auftrag (CLAUDE.md §5.5, dieselbe
    Trennung wie bei der Freigabe): ``smart_auto`` heißt „diese Maschine darf
    zugeteilt werden", ``smart_suggest`` heißt „vorschlagen, aber der Mensch
    drückt", ``pull`` heißt „Finger weg, die Werkstatt zieht selbst".
    """
    ranking = rank_stations(job, stations, ctx)
    usable = [a for a in ranking if a.eligible and a.routing != "pull"]
    if not usable:
        blocked = [a for a in ranking if not a.eligible]
        why = (
            "keine Station im Smart-Routing"
            if not blocked
            else f"keine geeignete Station ({blocked[0].blockers[0]})"
        )
        return Suggestion(job.no, None, "", 0.0, "none", why, ranking)

    best = usable[0]
    mode = "auto" if best.routing == "smart_auto" else "suggest"
    return Suggestion(
        job.no, best.station_id, best.label, best.score, mode, best.summary, ranking
    )


# --------------------------------------------------------------------------
# Bearbeiterzuordnung
# --------------------------------------------------------------------------
@dataclass
class HandlerSpec:
    """Ein Mitarbeiter, der Aufträge bearbeitet.

    Die Zähler sind keine Lerndaten, sondern **Fakten aus dem Auftragbuch**,
    die zum Entscheidungszeitpunkt abgefragt werden: wie viele Aufträge
    dieses Kunden und mit diesen Werkstoffen ihm tatsächlich zugeordnet
    waren. Nichts wird gespeichert, nichts wächst außerhalb der Buchhaltung.
    """

    user_id: int
    name: str
    email: str = ""
    role: str = "staff"
    active: bool = True
    #: Offene Aufträge, die ihm schon gehören.
    open_orders: int = 0
    #: Stationen, an denen er eingetragen ist (Ids).
    station_ids: list[int] = field(default_factory=list)
    #: Aufträge dieses Kunden, die er bearbeitet hat (aus dem Auftragbuch).
    customer_orders: int = 0
    #: Aufträge mit den Werkstoffen dieses Auftrags, die er bearbeitet hat.
    material_orders: int = 0


@dataclass
class OrderSpec:
    """Ein Kundenauftrag aus Sicht der Bearbeiterzuordnung."""

    no: str
    customer_ref: str = ""
    customer_user_id: Optional[int] = None
    materials: list[str] = field(default_factory=list)
    rush: bool = False


@dataclass
class HandlerAssessment:
    user_id: int
    name: str
    score: float
    factors: list[Factor] = field(default_factory=list)
    eligible: bool = True
    blockers: list[str] = field(default_factory=list)

    @property
    def summary(self) -> str:
        if not self.eligible:
            return "; ".join(self.blockers) or "nicht verfügbar"
        top = sorted(self.factors, key=lambda f: f.points, reverse=True)[:2]
        return " · ".join(f.reason for f in top if f.reason)

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "name": self.name,
            "score": round(self.score, 1),
            "eligible": self.eligible,
            "summary": self.summary,
            "blockers": list(self.blockers),
            "factors": [
                {
                    "key": f.key,
                    "label": f.label,
                    "points": round(f.points, 1),
                    "max": round(f.max_points, 1),
                    "share": round(f.share, 3),
                    "reason": f.reason,
                }
                for f in self.factors
            ],
        }


def assess_handler(
    order: OrderSpec,
    h: HandlerSpec,
    everyone: Sequence[HandlerSpec],
    ctx: Optional[RoutingContext] = None,
    weights: Optional[HandlerWeights] = None,
) -> HandlerAssessment:
    """Wer bearbeitet diesen Kunden? Kundenbindung schlägt alles andere.

    Der Grund ist nicht Bequemlichkeit, sondern Wissen: wer den Kunden kennt,
    kennt seine Sonderwünsche, seine Zeichnungsstände und seine Toleranz für
    Rückfragen. Das ist derselbe Gedanke wie der Burggraben aus CLAUDE.md §1,
    nur auf der Innenseite. Die Bindung wird aus dem Auftragbuch gelesen
    (``HandlerSpec.customer_orders``), nicht aus einem Lerndatenbestand —
    dieselbe Regel, aber nachlesbar bis zur Quelle.
    """
    w = weights or HandlerWeights()
    a = HandlerAssessment(h.user_id, h.name or h.email, 0.0)
    if not h.active:
        a.eligible = False
        a.blockers.append("Konto inaktiv")
        return a
    if h.role not in ("staff", "admin"):
        a.eligible = False
        a.blockers.append("keine Bearbeiterrolle")
        return a

    # ---- Kundenbindung ----------------------------------------------------
    if h.customer_orders:
        val = 1.0 - math.exp(-h.customer_orders / 3.0)
        a.factors.append(
            Factor(
                "customer",
                "Kundenbindung",
                w.customer * val,
                w.customer,
                f"{h.customer_orders}× für {order.customer_ref} bearbeitet",
            )
        )
    else:
        a.factors.append(
            Factor(
                "customer",
                "Kundenbindung",
                0.0,
                w.customer,
                f"{order.customer_ref or 'dieser Kunde'} noch nicht bearbeitet",
            )
        )

    # ---- Auslastung -------------------------------------------------------
    busiest = max((x.open_orders for x in everyone), default=0)
    rel = (h.open_orders / busiest) if busiest > 0 else 0.0
    a.factors.append(
        Factor(
            "load",
            "Auslastung",
            w.load * (1.0 - rel),
            w.load,
            f"{h.open_orders} offene Aufträge"
            + (
                " — der am wenigsten belastete"
                if h.open_orders
                == min((x.open_orders for x in everyone if x.active), default=0)
                else ""
            ),
        )
    )

    # ---- Werkstoff --------------------------------------------------------
    if h.material_orders:
        val = 1.0 - math.exp(-h.material_orders / 5.0)
        a.factors.append(
            Factor(
                "material",
                "Werkstoff",
                w.material * val,
                w.material,
                f"{h.material_orders}× mit diesen Werkstoffen",
            )
        )
    else:
        a.factors.append(
            Factor(
                "material",
                "Werkstoff",
                0.0,
                w.material,
                "keine Aufträge mit diesen Werkstoffen bearbeitet",
            )
        )

    # ---- Stationszuordnung ------------------------------------------------
    if h.station_ids:
        a.factors.append(
            Factor(
                "station",
                "Station",
                w.station,
                w.station,
                f"an {len(h.station_ids)} Station(en) eingetragen",
            )
        )
    else:
        a.factors.append(
            Factor(
                "station",
                "Station",
                0.0,
                w.station,
                "keiner Station zugeordnet",
            )
        )

    a.score = sum(f.points for f in a.factors)
    return a


def rank_handlers(
    order: OrderSpec,
    handlers: Sequence[HandlerSpec],
    ctx: Optional[RoutingContext] = None,
    weights: Optional[HandlerWeights] = None,
) -> list[HandlerAssessment]:
    out = [assess_handler(order, h, handlers, ctx, weights) for h in handlers]
    out.sort(key=lambda a: (a.eligible, a.score, -a.user_id), reverse=True)
    return out
