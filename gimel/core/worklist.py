"""Arbeitsvorrat — was an einer Station in welcher Reihenfolge dran ist.

Rein: keine Datenbank, keine Uhr, keine Globals. Eingabe sind Werttypen,
Ausgabe ist eine Reihenfolge, die sich vorlesen lässt.

Dieses Modul beantwortet die drei Fragen, die ``domain/routing.py`` offen
lässt:

1. **Was gehört überhaupt zu einer Station?** Nicht nur Schneiden. Ein
   Kundenauftrag durchläuft vier Arten von Arbeit — kommissionieren
   (``pick``), schneiden (``cut``), packen (``pack``) und bearbeiten
   (``process``) —, und jede gehört einem Stationstyp. Ein Lager, ein Plotter,
   ein Packtisch und ein Schreibtisch sind vier Arbeitsplätze mit derselben
   Frage: was ist als Nächstes dran?
2. **In welcher Reihenfolge?** Nicht „wer zuerst kam". Jede Aufgabe trägt eine
   Priorität aus benannten Faktoren — Zusage, Eil, Liegezeit, angefangen — und
   die Reihenfolge darf *innerhalb des Zusagefensters* umgestellt werden, um
   Rüstwechsel zu sparen. Fünf Innenaufträge desselben Werkstoffs hintereinander
   sind eine Stunde Rüsten weniger; sie dürfen aber keinen Termin fressen.
   Das ist die eine harte Regel dieses Moduls: **der Familienbonus zieht nur,
   solange dadurch keine einzige Zusage bricht.**
3. **Auf welche von mehreren gleichen Stationen?** Ein Plotter bekommt alles,
   zwei teilen sich die Arbeit. Das fällt nicht aus einer Quote, sondern aus
   der Frage „wo ist der Auftrag am frühesten fertig" — Warteschlange plus
   Rüsten plus Bearbeitung plus Transportweg vom Lager. Wer das rechnet,
   verteilt von selbst und clustert von selbst nach Werkstoff.

Wie überall in diesem Haus (CLAUDE.md §5.5): eine Regel, deren Entscheidung
man nicht nachlesen kann, wird beim ersten Zweifel abgeschaltet. Deshalb
trägt jede Aufgabe ihre Faktoren, jeder Platz seinen Satz und jede
Verschiebung ihren Grund.

**Und wie die Zuordnung lernt auch die Reihenfolge nicht.** Sie rechnet mit
dem, was messbar vorliegt: Zusagedatum, Eilkennzeichen, Liegezeit,
Maschinenwerte, Wege. Dieselben Zeilen ergeben dieselbe Reihenfolge.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional, Sequence

from .routing import (
    Factor,
    JobSpec,
    RoutingContext,
    StationSpec,
    job_minutes,
    needs_changeover,
    storage_route,
)

# --------------------------------------------------------------------------
# Arten von Arbeit — und welcher Stationstyp sie macht
# --------------------------------------------------------------------------
#: Die vier Arbeitsarten. Nicht erweiterbar durch Zufall: wer eine fünfte
#: hinzufügt, muss ihr einen Stationstyp, eine Zeitformel und einen Satz für
#: die Oberfläche geben — sonst steht sie in einer Liste und niemand weiß, was
#: sie bedeutet.
KIND_STATION_TYPE: dict[str, str] = {
    "pick": "warehouse",  # Material aus dem Regal holen und bereitstellen
    "cut": "production",  # Innenauftrag schneiden
    "pack": "shipping",  # fertige Teile zu einer Sendung packen
    "process": "accounting",  # Auftrag bearbeiten (Prüfen, Papiere, Rechnung)
}

KIND_LABEL: dict[str, str] = {
    "pick": "Kommissionieren",
    "cut": "Schneiden",
    "pack": "Packen",
    "process": "Auftragsbearbeitung",
}

#: Reihenfolge der Arbeitsarten im Durchlauf eines Auftrags. Nur Anzeige und
#: Sortierung — die Fertigmeldung entscheidet, nicht diese Liste.
KIND_ORDER: list[str] = ["process", "pick", "cut", "pack"]

TYPE_LABEL: dict[str, str] = {
    "production": "Fertigungs",
    "warehouse": "Lager",
    "shipping": "Versand",
    "accounting": "Bearbeitungs",
}


# --------------------------------------------------------------------------
# Gewichte der Priorität. Zusammen 100 — damit die Zahl eine Prozentzahl ist
# und die Balken in der Oberfläche vergleichbar bleiben, genau wie bei den
# Zuordnungsgewichten in ``routing.Weights``.
#
# ACHTUNG: Voreinstellung, keine Messung. Sie gehört auf die Liste in
# CLAUDE.md §7, sobald der erste Monat Fertigungsdaten da ist. Was sie
# ausdrückt, ist eine begründbare Reihenfolge: eine Zusage ist ein
# Versprechen an einen Kunden, ein Eilkennzeichen ist eine Ansage des
# Betriebs, und Liegezeit ist das, was verhindert, dass ein kleiner Auftrag
# ewig von größeren überholt wird.
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class PriorityWeights:
    deadline: float = 45.0  # wie nah die Zusage ist
    rush: float = 25.0  # ausdrücklich als Eilauftrag gekennzeichnet
    age: float = 20.0  # wie lange die Aufgabe schon liegt
    started: float = 10.0  # was angefangen ist, bleibt oben

    def total(self) -> float:
        return self.deadline + self.rush + self.age + self.started


@dataclass(frozen=True)
class WorklistPolicy:
    """Die Stellschrauben der Reihenfolge — alle an einer Stelle.

    ``window_h`` ist das Zusagefenster in Stunden: die Zeit, die ein
    Durchschnittsauftrag von der Übernahme bis zur Lieferung hat. Es ist das
    Bezugsmaß für Termindruck *und* für Liegezeit — dieselbe Zahl, damit
    „halb abgelaufen" in beiden Faktoren dasselbe heißt.

    ``safety_min`` ist der Puffer vor einer Zusage. Eine Reihenfolge, die
    eine Zusage auf die Minute genau ausreizt, hält sie beim ersten
    Telefonat nicht mehr.

    ``family_bonus`` ist kein Punktwert, sondern eine *Erlaubnis*: er
    entscheidet nur zwischen zwei Aufgaben, die beide ihre Zusage halten.
    Deshalb kann er beliebig groß sein, ohne je einen Termin zu kosten.
    """

    #: Zusagefenster in Stunden (3 Werktage = 72 h ist die Hausvorgabe).
    window_h: float = 72.0
    #: Puffer vor der Zusage, in Minuten.
    safety_min: float = 30.0
    #: Punkte, die „gleiche Rüstfamilie" in der freien Wahl wert ist.
    family_bonus: float = 40.0
    #: Wie schwer eingesparte Rüstzeit gegen frühe Fertigstellung wiegt, wenn
    #: die Verteilung zwischen zwei Stationen wählt. 1,0 heißt: eine Minute
    #: Rüsten ist eine Minute wert — die Halle zahlt sie genauso wie
    #: Wartezeit. 0 macht die Verteilung blind für Rüstkosten und lässt sie
    #: zwischen zwei Maschinen hin- und herspringen; Werte über 1 halten
    #: Werkstoffe auch dann zusammen, wenn eine Maschine dafür wartet.
    overhead_weight: float = 1.0
    #: Obergrenze für die Reihenfolge — darüber wird nur noch nach Priorität
    #: sortiert, weil die Prüfung „bricht dadurch eine Zusage" quadratisch ist.
    max_sequence: int = 200
    weights: PriorityWeights = field(default_factory=PriorityWeights)


# --------------------------------------------------------------------------
# Eingaben
# --------------------------------------------------------------------------
@dataclass
class Task:
    """Eine Aufgabe im Arbeitsvorrat — die Einheit, die ein Mensch abarbeitet.

    Bewusst *eine* Klasse für alle vier Arten: ein Packtisch und ein Plotter
    unterscheiden sich in der Zeitformel und im Stationstyp, nicht in der
    Frage, was als Nächstes dran ist. Zwei Klassen hätten zwei
    Reihenfolgeregeln, und die zweite wäre die schlechtere.
    """

    kind: str  # pick | cut | pack | process
    #: Fachliche Nummer — Innenauftrag (cut/pick) oder Auftrag (pack/process).
    ref: str
    label: str = ""
    #: Werkstoff und Dicke bilden die **Rüstfamilie**. Bei ``pack``/``process``
    #: leer — dort gibt es nichts umzurüsten, und der Familienbonus entfällt.
    mat: str = ""
    mat_name: str = ""
    thk: float = 0.0
    #: Mengengerüst. ``units`` ist das, was die Station wirklich anfasst:
    #: Platten beim Kommissionieren, Positionen beim Packen und Bearbeiten.
    units: int = 1
    n_parts: int = 0
    n_plates: int = 0
    cut_len_mm: float = 0.0
    plate_mm: tuple[float, float] = (0.0, 0.0)
    #: Termin und Druck.
    rush: bool = False
    #: Stunden bis zur Zusage. Negativ heißt überfällig, ``None`` heißt: es
    #: gibt keine Zusage — dann trägt der Termindruck nichts bei, statt eine
    #: Dringlichkeit zu erfinden.
    due_in_h: Optional[float] = None
    #: Stunden, seit der Auftrag im Haus ist (Übernahme, nicht Anlage der
    #: Aufgabe): die Liegezeit, die einen kleinen Auftrag nach oben schiebt.
    waiting_h: float = 0.0
    #: Wurde hier schon angefangen? Dann bleibt die Aufgabe oben — was auf
    #: dem Tisch liegt, räumt man nicht für eine Punktzahl wieder weg.
    started: bool = False
    #: Minuten, die für diese Aufgabe eingeplant waren, als sie anfing. Nur
    #: sinnvoll zusammen mit ``started_min_ago`` — aus beiden wird der
    #: **Rest**, und der Rest ist die einzige Zahl, mit der die Uhr an der
    #: Wand lügenfrei bleibt.
    planned_min: float = 0.0
    #: Minuten seit dem Anfangen. ``None`` heißt: läuft nicht oder Beginn
    #: unbekannt — dann rechnet die Liste mit der vollen geplanten Zeit.
    started_min_ago: Optional[float] = None
    #: Wo sie im Moment liegt (falls zugeordnet).
    station_id: Optional[int] = None
    #: Wohin das Ergebnis muss. Nur beim Kommissionieren belegt: die Maschine,
    #: an der die Platten stehen sollen — der Weg dorthin ist die Arbeit.
    to_station_id: Optional[int] = None
    to_station_label: str = ""
    customer_refs: list[str] = field(default_factory=list)
    order_nos: list[str] = field(default_factory=list)
    note: str = ""
    #: Fertigungsort-Vorgabe (siehe ``JobSpec.allowed_floors``).
    allowed_floors: Optional[frozenset[int]] = None
    scope_label: str = ""

    # ---- Abgeleitetes ----------------------------------------------------
    @property
    def station_type(self) -> str:
        return KIND_STATION_TYPE.get(self.kind, "production")

    @property
    def family(self) -> tuple[str, float]:
        """Die Rüstfamilie. Leerer Werkstoff = keine Familie (kein Rüsten)."""
        return (self.mat or "", float(self.thk or 0.0))

    @property
    def has_family(self) -> bool:
        return bool(self.mat)

    def as_job(self) -> JobSpec:
        """Als Zuordnungs-Eingabe — damit Zeit und Eignung *eine* Quelle haben.

        Der Rechenkern der Maschinenwahl kennt bereits Schnittzeit,
        Tischgröße und Dickenbereich. Sie hier zweitens zu rechnen hieße,
        zwei Zahlen für dieselbe Maschine zu haben, und die zweite wäre die
        falsche.
        """
        return JobSpec(
            no=self.ref,
            mat=self.mat,
            mat_name=self.mat_name,
            thk=float(self.thk or 0.0),
            n_plates=int(self.n_plates or 0) or 1,
            n_parts=int(self.n_parts or 0),
            cut_len_mm=float(self.cut_len_mm or 0.0),
            plate_mm=self.plate_mm,
            rush=bool(self.rush),
            due_in_days=(self.due_in_h / 24.0) if self.due_in_h is not None else None,
            customer_refs=list(self.customer_refs),
            station_type=self.station_type,
            units=int(self.units or 1),
            allowed_floors=self.allowed_floors,
            scope_label=self.scope_label,
        )


# --------------------------------------------------------------------------
# Priorität
# --------------------------------------------------------------------------
@dataclass
class Priority:
    """Der Rang einer Aufgabe — Zahl, Zerlegung, Klartext."""

    score: float
    factors: list[Factor] = field(default_factory=list)
    #: Überfällig? Getrennt von der Punktzahl, weil ein Rückstand keine
    #: Abstufung ist, sondern ein Zustand.
    overdue: bool = False

    @property
    def summary(self) -> str:
        top = sorted(self.factors, key=lambda f: f.points, reverse=True)[:2]
        return " · ".join(f.reason for f in top if f.points > 0 and f.reason) or (
            "keine Dringlichkeit hinterlegt"
        )

    def to_dict(self) -> dict:
        return {
            "score": round(self.score, 1),
            "overdue": self.overdue,
            "summary": self.summary,
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


def _fmt_h(v: float) -> str:
    if abs(v) >= 48:
        return f"{v / 24:.1f} Tage".replace(".", ",")
    return f"{v:.0f} h"


def priority(task: Task, policy: Optional[WorklistPolicy] = None) -> Priority:
    """Wie dringend diese Aufgabe ist — in benannten Faktoren.

    Die vier Faktoren sind bewusst unabhängig voneinander messbar: das
    Zusagedatum steht am Auftrag, das Eilkennzeichen ist ein Häkchen, die
    Liegezeit ist eine Subtraktion, und „angefangen" ist ein Zeitstempel.
    Keiner davon ist eine Schätzung, und keiner wächst durch Benutzung.
    """
    p = policy or WorklistPolicy()
    w = p.weights
    out = Priority(0.0)

    # ---- Zusage -----------------------------------------------------------
    if task.due_in_h is None:
        out.factors.append(
            Factor(
                "deadline",
                "Zusage",
                0.0,
                w.deadline,
                "keine Zusage hinterlegt — kein Termindruck",
            )
        )
    else:
        # Voller Druck ab überfällig, kein Druck ab einem ganzen Fenster
        # Vorlauf. Dazwischen linear: das ist nachrechenbar, und es macht
        # „halb abgelaufen" zu genau der Hälfte der Punkte.
        rel = 1.0 - max(0.0, min(1.0, task.due_in_h / max(p.window_h, 1.0)))
        out.overdue = task.due_in_h < 0
        out.factors.append(
            Factor(
                "deadline",
                "Zusage",
                w.deadline * rel,
                w.deadline,
                f"überfällig seit {_fmt_h(-task.due_in_h)}"
                if out.overdue
                else f"Zusage in {_fmt_h(task.due_in_h)}",
            )
        )

    # ---- Eil --------------------------------------------------------------
    out.factors.append(
        Factor(
            "rush",
            "Eilauftrag",
            w.rush if task.rush else 0.0,
            w.rush,
            "als Eilauftrag gekennzeichnet" if task.rush else "kein Eilauftrag",
        )
    )

    # ---- Liegezeit --------------------------------------------------------
    # Sättigend, nicht linear: nach einem halben Fenster sind knapp zwei
    # Drittel erreicht, danach flacht es ab. So überholt Liegezeit allein nie
    # eine echte Zusage, verhindert aber, dass ein kleiner Auftrag endlos
    # von größeren überholt wird.
    if task.waiting_h > 0:
        val = 1.0 - math.exp(-task.waiting_h / max(p.window_h / 2.0, 1.0))
        out.factors.append(
            Factor(
                "age",
                "Liegezeit",
                w.age * val,
                w.age,
                f"seit {_fmt_h(task.waiting_h)} im Haus",
            )
        )
    else:
        out.factors.append(
            Factor("age", "Liegezeit", 0.0, w.age, "gerade erst übernommen")
        )

    # ---- Angefangen -------------------------------------------------------
    out.factors.append(
        Factor(
            "started",
            "Angefangen",
            w.started if task.started else 0.0,
            w.started,
            "läuft bereits an dieser Station"
            if task.started
            else "noch nicht angefangen",
        )
    )

    out.score = sum(f.points for f in out.factors)
    return out


# --------------------------------------------------------------------------
# Zeitmodell je Arbeitsart
# --------------------------------------------------------------------------
def task_minutes(
    task: Task, st: StationSpec, *, changeover: bool = False
) -> Optional[float]:
    """Belegzeit dieser Aufgabe an dieser Station, in Minuten.

    ``None`` heißt „unbekannt" und wird nirgends als 0 gerechnet: eine
    Station ohne hinterlegte Zeiten kann keine Fertigstellung versprechen,
    und eine erfundene Minutenzahl wäre schlimmer als gar keine
    (CLAUDE.md §7). Die Reihenfolge kommt trotzdem zustande — sie fällt dann
    auf reine Termin- und Prioritätsordnung zurück, ohne Uhrzeiten.
    """
    if task.kind == "cut":
        return job_minutes(task.as_job(), st, changeover)
    # Alle anderen Arten: Grundzeit je Vorgang plus Zeit je Einheit. Das ist
    # die ehrlichste Form, in der ein Packtisch oder ein Regal sich messen
    # lässt — beide haben ein Aufsetzen und ein Pro-Stück.
    if st.task_min <= 0 and st.unit_min <= 0:
        return None
    base = st.task_min + (st.changeover_min if changeover else 0.0)
    return base + st.unit_min * max(1, int(task.units or 1))


def changeover_between(a: Optional[tuple[str, float]], task: Task) -> bool:
    """Wechselt die Rüstfamilie? Ohne Familie gibt es nichts zu wechseln."""
    if not task.has_family:
        return False
    if a is None or not a[0]:
        return True
    return a[0] != task.mat or abs(float(a[1]) - float(task.thk or 0.0)) > 1e-6


# --------------------------------------------------------------------------
# Reihenfolge an einer Station
# --------------------------------------------------------------------------
@dataclass
class Slot:
    """Ein Platz in der Abarbeitungsliste."""

    seq: int
    task: Task
    priority: Priority
    #: Minuten ab jetzt — ``None``, solange die Station keine Zeiten hat.
    start_min: Optional[float] = None
    finish_min: Optional[float] = None
    #: Muss vor dieser Aufgabe umgerüstet werden?
    changeover: bool = False
    #: Minuten Luft bis zur Zusage, nachdem sie hier fertig wäre.
    slack_min: Optional[float] = None
    late: bool = False
    #: Auf welchen Arbeitstag diese Aufgabe fällt — aus der Tageskapazität
    #: der Station. 1 = heute. Ohne hinterlegte Kapazität bleibt alles 1.
    day: int = 1
    #: Warum sie an dieser Stelle steht — der Satz, den der Meister liest.
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "kind": self.task.kind,
            "ref": self.task.ref,
            "label": self.task.label,
            "mat": self.task.mat,
            "mat_name": self.task.mat_name,
            "thk": self.task.thk,
            "units": self.task.units,
            "n_parts": self.task.n_parts,
            "n_plates": self.task.n_plates,
            "rush": self.task.rush,
            "started": self.task.started,
            "orders": list(self.task.order_nos),
            "customers": list(self.task.customer_refs),
            "start_min": round(self.start_min, 1) if self.start_min is not None else None,
            "finish_min": round(self.finish_min, 1)
            if self.finish_min is not None
            else None,
            "changeover": self.changeover,
            "slack_min": round(self.slack_min, 1) if self.slack_min is not None else None,
            "late": self.late,
            "day": self.day,
            "reason": self.reason,
            "priority": self.priority.to_dict(),
        }


@dataclass
class Schedule:
    """Die fertige Abarbeitungsliste einer Station — samt Rechenschaft."""

    station_id: Optional[int]
    label: str = ""
    slots: list[Slot] = field(default_factory=list)
    #: Ob überhaupt mit Uhrzeiten gerechnet werden konnte.
    times_known: bool = True
    #: Rüstwechsel in dieser Reihenfolge …
    changeovers: int = 0
    #: … und in der reinen Terminreihenfolge, als Vergleichsmaß. Die Differenz
    #: ist, was das Umsortieren wirklich einspart — gemessen, nicht behauptet.
    changeovers_edd: int = 0
    changeover_min_saved: float = 0.0
    total_min: float = 0.0
    late: list[str] = field(default_factory=list)
    #: Zwei verschiedene Zustände, und sie werden gern verwechselt:
    #: ``setup_start`` ist, was **jetzt** aufgespannt ist — die Zahl, die am
    #: Arbeitsplatz steht. ``setup_family`` ist, was **nach** dieser Liste
    #: aufgespannt sein wird — die Zahl, mit der die Verteilung weiterrechnet,
    #: wenn sie die nächste Aufgabe auf dieselbe Station legt.
    setup_start: Optional[tuple[str, float]] = None
    setup_start_name: str = ""
    setup_family: Optional[tuple[str, float]] = None
    #: Der Klarname des zuletzt aufgespannten Werkstoffs. Die Kennung allein
    #: („epdm-70") steht auf keinem Regal und auf keiner Maschine.
    setup_name: str = ""
    #: Tageskapazität der Station und Last in Arbeitstagen — gefüllt aus
    #: ``capacity_min_per_day``. 0/None heißt: keine Angabe, dann rechnet
    #: die Liste ohne Tagewerk und sagt das auch.
    capacity_min_per_day: float = 0.0
    days: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            "station_id": self.station_id,
            "label": self.label,
            "times_known": self.times_known,
            "changeovers": self.changeovers,
            "changeovers_edd": self.changeovers_edd,
            "changeovers_saved": max(0, self.changeovers_edd - self.changeovers),
            "changeover_min_saved": round(self.changeover_min_saved, 1),
            "total_min": round(self.total_min, 1),
            "late": list(self.late),
            # „setup_*" ist der Zustand jetzt; „setup_end_*" der danach.
            "setup_mat": self.setup_start[0] if self.setup_start else "",
            "setup_name": self.setup_start_name
            or (self.setup_start[0] if self.setup_start else ""),
            "setup_thk": self.setup_start[1] if self.setup_start else 0.0,
            "setup_end_mat": self.setup_family[0] if self.setup_family else "",
            "setup_end_name": self.setup_name
            or (self.setup_family[0] if self.setup_family else ""),
            "setup_end_thk": self.setup_family[1] if self.setup_family else 0.0,
            "capacity_min_per_day": self.capacity_min_per_day,
            "days": round(self.days, 2) if self.days is not None else None,
            "slots": [s.to_dict() for s in self.slots],
        }


def _count_changeovers(
    tasks: Sequence[Task], start_family: Optional[tuple[str, float]]
) -> int:
    fam = start_family
    n = 0
    for t in tasks:
        if not t.has_family:
            continue
        if changeover_between(fam, t):
            n += 1
        fam = t.family
    return n


def sequence(
    tasks: Sequence[Task],
    st: StationSpec,
    *,
    policy: Optional[WorklistPolicy] = None,
) -> Schedule:
    """Die Reihenfolge an einer Station — Termine hart, Rüsten weich.

    Der Kern in einem Satz: **umsortieren ist erlaubt, solange keine Zusage
    dabei bricht.** In jedem Schritt stehen zwei Kandidaten zur Wahl —

    * der *Termin-Kandidat*: die Aufgabe mit der frühesten Zusage (bei
      Gleichstand die mit der höheren Priorität). Das ist die klassische
      Terminreihenfolge, und sie ist immer sicher.
    * der *Familien-Kandidat*: die beste Aufgabe, die ohne Umrüsten läuft,
      weil sie denselben Werkstoff und dieselbe Dicke hat wie das, was gerade
      aufgespannt ist.

    Der Familien-Kandidat gewinnt nur, wenn danach **jede** verbleibende
    Aufgabe ihre Zusage noch halten kann. Sonst gewinnt der Termin, und der
    Rüstwechsel wird bezahlt. Genau so entsteht „fünf Innenaufträge desselben
    Materials hintereinander", ohne dass ein Kunde dafür wartet.

    Die Aufgaben, die schon laufen, stehen vorn — was auf dem Tisch liegt,
    räumt man nicht für eine Punktzahl wieder weg.
    """
    p = policy or WorklistPolicy()
    fam0: Optional[tuple[str, float]] = (
        (st.last_mat, float(st.last_thk or 0.0)) if st.last_mat else None
    )
    sched = Schedule(
        station_id=st.id, label=st.label, setup_family=fam0, setup_start=fam0
    )

    prios = {id(t): priority(t, p) for t in tasks}
    # Zeiten je Aufgabe, einmal mit und einmal ohne Rüstwechsel — sonst
    # rechnet die Schleife dieselbe Formel n² mal.
    m_change = {id(t): task_minutes(t, st, changeover=True) for t in tasks}
    m_keep = {id(t): task_minutes(t, st, changeover=False) for t in tasks}
    # Was **läuft**, zählt nicht mit der vollen geplanten Zeit: von einer
    # angefangenen Aufgabe ist nur der Rest übrig — geplant minus gelaufen.
    # Und sie muss nicht mehr gerüstet werden, was auf dem Tisch liegt, ist
    # aufgespannt. Beides zusammen ist der Unterschied zwischen einer Liste,
    # die die Maschine nachfährt, und einer, die um halb so viel falsch liegt.
    for t in tasks:
        if t.started and t.started_min_ago is not None:
            base = m_keep[id(t)]
            if base is not None:
                planned = t.planned_min if t.planned_min > 0 else base
                rest = max(0.0, planned - t.started_min_ago)
                m_keep[id(t)] = rest
                m_change[id(t)] = rest
    sched.times_known = all(v is not None for v in m_keep.values()) and bool(tasks)

    def minutes_of(t: Task, change: bool) -> float:
        v = (m_change if change else m_keep)[id(t)]
        return float(v or 0.0)

    def due_min(t: Task) -> Optional[float]:
        return t.due_in_h * 60.0 if t.due_in_h is not None else None

    # Angefangene zuerst, in sich nach Priorität: sie sind keine Wahl mehr.
    running = [t for t in tasks if t.started]
    pool = [t for t in tasks if not t.started]
    running.sort(key=lambda t: (-prios[id(t)].score, t.ref))

    # Vergleichsmaß: was die reine Terminreihenfolge an Rüstwechseln kostete.
    edd_order = sorted(
        tasks,
        key=lambda t: (
            not t.started,
            due_min(t) if due_min(t) is not None else float("inf"),
            -prios[id(t)].score,
            t.ref,
        ),
    )
    sched.changeovers_edd = _count_changeovers(edd_order, fam0)

    cursor = 0.0
    family = fam0
    ordered: list[tuple[Task, bool, str]] = []

    def take(t: Task, why: str) -> None:
        nonlocal cursor, family
        change = changeover_between(family, t)
        ordered.append((t, change, why))
        cursor += minutes_of(t, change)
        if t.has_family:
            family = t.family

    for t in running:
        take(t, "läuft bereits — bleibt an erster Stelle")

    # Über der Obergrenze wird nicht mehr umsortiert: die Zusageprüfung ist
    # quadratisch, und eine Halle mit zweihundert offenen Aufgaben an *einer*
    # Station hat ein anderes Problem als die Reihenfolge.
    if len(pool) > p.max_sequence:
        rest = sorted(
            pool,
            key=lambda t: (
                -prios[id(t)].score,
                due_min(t) if due_min(t) is not None else float("inf"),
                t.ref,
            ),
        )
        for t in rest:
            take(t, "nur nach Priorität — Liste zu lang zum Umsortieren")
        pool = []

    while pool:
        # --- Vorrang: Eil und Überfälligkeit stehen über dem Rüstsparen ----
        # Ein Eilkennzeichen ist eine Ansage des Betriebs („diese zuerst"),
        # keine Feinheit der Terminrechnung — dieselbe Lesart wie in der
        # Freigaberegel, wo ein Eilauftrag am Sammeln vorbeigeht, egal wie
        # leer die Platte bleibt (CLAUDE.md §5.5). Und wer schon überfällig
        # ist, wird nicht noch einmal überholt. Solange solche Aufgaben
        # warten, wird nur unter *ihnen* gewählt; das Material sortieren sie
        # untereinander weiter, aber sie treten nicht zurück.
        vorrang = [
            t
            for t in pool
            if t.rush or (due_min(t) is not None and (due_min(t) or 0.0) < 0)
        ]
        choose_from = vorrang or pool

        # --- Termin-Kandidat: die früheste Zusage, sicher in jedem Fall ----
        edd = min(
            choose_from,
            key=lambda t: (
                due_min(t) if due_min(t) is not None else float("inf"),
                -prios[id(t)].score,
                t.ref,
            ),
        )
        # --- Familien-Kandidat: ohne Umrüsten, bester Punktwert ------------
        same = [t for t in choose_from if not changeover_between(family, t)]
        fam_pick = (
            max(same, key=lambda t: (prios[id(t)].score, -_ref_key(t)))
            if same
            else None
        )

        pick, why = edd, ""
        if fam_pick is not None and fam_pick is not edd:
            delay = minutes_of(fam_pick, False)
            # Bricht das eine Zusage? Gemessen wird nicht „ist danach jemand
            # zu spät", sondern **wird jemand *später* als er ohnehin wäre**.
            # Der Unterschied ist der ganze Punkt: eine Aufgabe, die ihren
            # Termin schon jetzt nicht mehr halten kann, darf durch das
            # Rüstsparen nicht noch weiter nach hinten rutschen — sie ist
            # dann die dringendste, nicht die billigste.
            #
            # Geprüft gegen *alle* übrigen, nicht nur gegen den Termin-
            # Kandidaten: die zweitdringendste Aufgabe zählt genauso, und eine
            # Regel, die nur den Ersten prüft, verliert den Zweiten still.
            breaks = False
            for other in pool:
                if other is fam_pick:
                    continue
                d = due_min(other)
                if d is None:
                    continue
                before = max(
                    0.0,
                    cursor
                    + minutes_of(other, changeover_between(family, other))
                    + p.safety_min
                    - d,
                )
                after = max(
                    0.0,
                    cursor
                    + delay
                    + minutes_of(other, changeover_between(fam_pick.family, other))
                    + p.safety_min
                    - d,
                )
                if after > before + 1e-9:
                    breaks = True
                    break
            if not breaks:
                pick, why = (
                    fam_pick,
                    f"gleiches Material {fam_pick.mat_name or fam_pick.mat}"
                    f" {fam_pick.thk:g} mm — kein Rüsten, keine Zusage betroffen".replace(
                        ".", ","
                    ),
                )
            else:
                why = "Zusage läuft ab — Rüstwechsel in Kauf genommen"
        if not why:
            if pick.rush:
                why = "Eilauftrag — geht vor"
            elif prios[id(pick)].overdue:
                why = "überfällig — geht vor"
            elif fam_pick is edd and not changeover_between(family, edd):
                why = "früheste Zusage und ohne Rüstwechsel"
            else:
                why = (
                    "früheste Zusage"
                    if due_min(edd) is not None
                    else prios[id(edd)].summary
                )
        pool.remove(pick)
        take(pick, why)

    # --- Aus der Reihenfolge die Liste bauen -------------------------------
    cursor = 0.0
    family = fam0
    change_min_used = 0.0
    # Tagesgrenzen: eine Schicht hat so viele Minuten, wie die Station an
    # Kapazität meldet. Ohne Angabe bleibt alles „Tag 1" — dann ist die
    # Liste eine Arbeitsmenge, keine Wanduhr, und das sagt sie auch so.
    cap = float(st.capacity_min_per_day or 0.0)
    day = 1
    day_used = 0.0
    for i, (t, change, why) in enumerate(ordered, start=1):
        m = minutes_of(t, change)
        start = cursor if sched.times_known else None
        cursor += m
        finish = cursor if sched.times_known else None
        d = due_min(t)
        slack = (d - cursor) if (d is not None and sched.times_known) else None
        late = bool(slack is not None and slack < 0)
        if change:
            sched.changeovers += 1
            change_min_used += st.changeover_min
        if cap > 0 and day_used + m > cap and day_used > 0:
            day += 1
            day_used = 0.0
        day_used += m
        sched.slots.append(
            Slot(
                seq=i,
                task=t,
                priority=prios[id(t)],
                start_min=start,
                finish_min=finish,
                changeover=change,
                slack_min=slack,
                late=late,
                day=day,
                reason=why,
            )
        )
        if late:
            sched.late.append(t.ref)
        if t.has_family:
            if (
                not sched.setup_start_name
                and fam0
                and t.mat == fam0[0]
            ):
                sched.setup_start_name = t.mat_name or t.mat
            family = t.family
            sched.setup_name = t.mat_name or t.mat

    sched.total_min = cursor if sched.times_known else 0.0
    sched.changeover_min_saved = max(
        0.0, (sched.changeovers_edd - sched.changeovers) * st.changeover_min
    )
    sched.setup_family = family
    # Tageskapazität: Last in Arbeitstagen — erst ab einer hinterlegten
    # Kapazität, denn eine erfundene Schichtlänge wäre eine zweite Uhr, die
    # nichts mit der an der Wand zu tun hat (CLAUDE.md §7).
    sched.capacity_min_per_day = cap
    if cap > 0 and sched.times_known:
        sched.days = max(1.0, cursor / cap)
    return sched


def _ref_key(t: Task) -> int:
    """Stabiler Tiebreak über die Nummer — gleiche Halle, gleiche Ordnung."""
    return sum((i + 1) * ord(c) for i, c in enumerate(t.ref[-8:]))


# --------------------------------------------------------------------------
# Verteilung über gleichartige Stationen
# --------------------------------------------------------------------------
@dataclass
class StationOption:
    """Was eine Station für eine Aufgabe kostet — alle Zahlen nebeneinander."""

    station_id: int
    label: str
    routing: str
    eligible: bool
    blockers: list[str] = field(default_factory=list)
    minutes: Optional[float] = None
    transport_min: float = 0.0
    queue_min: float = 0.0
    finish_min: Optional[float] = None
    changeover: bool = True
    route_m: float = 0.0
    route_exact: bool = False
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "station_id": self.station_id,
            "label": self.label,
            "routing": self.routing,
            "eligible": self.eligible,
            "blockers": list(self.blockers),
            "minutes": round(self.minutes, 1) if self.minutes is not None else None,
            "transport_min": round(self.transport_min, 1),
            "queue_min": round(self.queue_min, 1),
            "finish_min": round(self.finish_min, 1)
            if self.finish_min is not None
            else None,
            "changeover": self.changeover,
            "route_m": round(self.route_m, 1),
            "route_exact": self.route_exact,
            "reason": self.reason,
        }


@dataclass
class Placement:
    """Wohin eine Aufgabe soll — und ob das von selbst gilt."""

    task: Task
    station_id: Optional[int]
    label: str
    mode: str  # auto | suggest | none
    reason: str
    priority: Priority
    options: list[StationOption] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "kind": self.task.kind,
            "ref": self.task.ref,
            "label": self.task.label,
            "mat": self.task.mat,
            "mat_name": self.task.mat_name,
            "thk": self.task.thk,
            "units": self.task.units,
            "rush": self.task.rush,
            "orders": list(self.task.order_nos),
            "station_id": self.station_id,
            "station_label": self.label,
            "mode": self.mode,
            "reason": self.reason,
            "priority": self.priority.to_dict(),
            "options": [o.to_dict() for o in self.options],
        }


def transport_minutes(
    task: Task,
    st: StationSpec,
    stations: Sequence[StationSpec],
    ctx: RoutingContext,
) -> tuple[float, float, bool, str]:
    """Der Weg, den diese Aufgabe an dieser Station kostet.

    Zwei verschiedene Wege, weil es zwei verschiedene Arbeiten sind:

    * **Schneiden** misst vom nächsten Lager, das den Werkstoff führt, zur
      Maschine — dieselbe Zahl, mit der ``routing.assess`` rechnet, damit der
      Pfeil im Plan und der Faktor in der Begründung nicht auseinanderlaufen.
    * **Kommissionieren** misst vom Regal zur Zielmaschine: das ist der Weg,
      den der Mensch mit dem Hubwagen wirklich geht.

    Packen und Bearbeiten haben keinen Transportweg — dort ist der Auftrag
    schon da, wo er hingehört.
    """
    if task.kind == "cut":
        route, store = storage_route(task.as_job(), st, stations, ctx)
        if route is None:
            return 0.0, 0.0, False, "kein Lager erfasst — Weg unbekannt"
        return (
            route.metres / max(ctx.walk_m_per_min, 1.0),
            route.metres,
            route.exact,
            f"{route.metres:.0f} m von {store.label if store else 'Lager'}"
            + ("" if route.exact else " (Luftlinie)"),
        )
    if task.kind == "pick" and task.to_station_id is not None:
        target = next((s for s in stations if s.id == task.to_station_id), None)
        if target is None:
            return 0.0, 0.0, False, "Zielstation unbekannt"
        r = ctx.route_between(st, target)
        if r is None:
            return 0.0, 0.0, False, f"{target.label} steht in einer anderen Halle — Weg unbekannt"
        return (
            r.metres / max(ctx.walk_m_per_min, 1.0),
            r.metres,
            r.exact,
            f"{r.metres:.0f} m bis {target.label}"
            + ("" if r.exact else " (Luftlinie)"),
        )
    return 0.0, 0.0, False, ""


def options_for(
    task: Task,
    stations: Sequence[StationSpec],
    ctx: RoutingContext,
    *,
    setup: Optional[dict[int, tuple[str, float]]] = None,
    queue: Optional[dict[int, float]] = None,
) -> list[StationOption]:
    """Jede Station gegen eine Aufgabe — auch die ungeeigneten, mit Grund.

    Eine Station, die wortlos aus der Liste verschwindet, ist ein Rätsel für
    den Meister (dieselbe Regel wie in ``routing.rank_stations``).
    """
    from .routing import eligibility  # spät, um den Zyklus im Kopf zu halten

    job = task.as_job()
    out: list[StationOption] = []
    for st in stations:
        blockers = eligibility(job, st)
        fam = (setup or {}).get(st.id) or (
            (st.last_mat, float(st.last_thk or 0.0)) if st.last_mat else None
        )
        change = changeover_between(fam, task)
        minutes = task_minutes(task, st, changeover=change)
        t_min, t_m, t_exact, t_note = transport_minutes(task, st, stations, ctx)
        q = (queue or {}).get(st.id, st.queue_min)
        opt = StationOption(
            station_id=st.id,
            label=st.label,
            routing=st.routing,
            eligible=not blockers,
            blockers=blockers,
            minutes=minutes,
            transport_min=t_min,
            queue_min=q,
            finish_min=(q + minutes + t_min) if minutes is not None else None,
            changeover=change,
            route_m=t_m,
            route_exact=t_exact,
        )
        bits = []
        if not change and task.has_family:
            bits.append("eingerichtet — kein Rüsten")
        elif change and task.has_family:
            bits.append("Rüstwechsel nötig")
        if q > 0:
            bits.append(f"{q:.0f} min in der Schlange")
        else:
            bits.append("Station frei")
        if t_note:
            bits.append(t_note)
        if minutes is None:
            bits.append("keine Zeiten hinterlegt — kein Fertigstellungsversprechen")
        opt.reason = " · ".join(bits)
        out.append(opt)
    out.sort(
        key=lambda o: (
            not o.eligible,
            o.finish_min is None,
            o.finish_min if o.finish_min is not None else 0.0,
            o.changeover,
            o.station_id,
        )
    )
    return out


def _family_key(t: Task) -> tuple[str, str, float]:
    """Womit eine Aufgabe zusammen läuft. Ohne Werkstoff: alles einer Art."""
    return (t.kind, t.mat or "", float(t.thk or 0.0))


def deal_families(
    tasks: Sequence[Task],
    stations: Sequence[StationSpec],
    *,
    policy: Optional[WorklistPolicy] = None,
) -> dict[tuple[str, str, float], list[int]]:
    """Welche Station welche Rüstfamilie führt — die Entscheidung *vor* der Zuteilung.

    Das ist der Schritt, den eine reine „wo ist es am frühesten fertig"-Regel
    nicht leisten kann und den jeder Meister im Kopf macht: **erst wird
    entschieden, welche Maschine welches Material fährt, dann werden die
    Aufträge verteilt.** Ohne ihn nimmt jede zweite Aufgabe die gerade freie
    Nachbarmaschine, und am Abend haben beide Maschinen beide Werkstoffe
    gefahren — doppelt gerüstet, für nichts.

    Die Regel ist die klassische Längste-Arbeit-zuerst-Verteilung:

    1. Familien nach Gesamtarbeit absteigend.
    2. Jede Familie an die Station mit der geringsten geplanten Last.
    3. **Bleibt eine geeignete Station leer, bekommt sie die Familie mit der
       meisten Arbeit je Station dazu.** Deshalb bekommt ein einzelner
       Werkstoff auf zwei Plottern beide — und zwei Werkstoffe auf zwei
       Plottern je einen.

    Zurück kommt je Familie die Liste ihrer Stationen, größte zuerst.
    """
    p = policy or WorklistPolicy()
    groups: dict[tuple[str, str, float], list[Task]] = {}
    for t in tasks:
        groups.setdefault(_family_key(t), []).append(t)

    def work_of(group: Sequence[Task], st: StationSpec) -> float:
        total = 0.0
        for t in group:
            total += task_minutes(t, st, changeover=False) or 0.0
        return total + float(st.changeover_min or 0.0)

    load: dict[int, float] = {s.id: s.queue_min for s in stations}
    homes: dict[tuple[str, str, float], list[int]] = {}

    def eligible_ids(group: Sequence[Task]) -> list[int]:
        from .routing import eligibility

        out = []
        for st in stations:
            if st.routing == "pull":
                continue
            if all(not eligibility(t.as_job(), st) for t in group):
                out.append(st.id)
        return out

    by_id = {s.id: s for s in stations}
    ranked = sorted(
        groups.items(),
        key=lambda kv: (
            -work_of(kv[1], by_id[eligible_ids(kv[1])[0]])
            if eligible_ids(kv[1])
            else 0.0,
            kv[0],
        ),
    )
    for key, group in ranked:
        ids = eligible_ids(group)
        if not ids:
            homes[key] = []
            continue
        home = min(ids, key=lambda i: (load[i], i))
        homes[key] = [home]
        load[home] += work_of(group, by_id[home])

    # Leerstehende geeignete Stationen bekommen Arbeit dazu — dieselbe Regel
    # wie der Nachschub in ``factory_router.ensure_fed``: eine passende
    # Maschine, die dasteht, während Arbeit wartet, ist Stillstand, den
    # niemand bestellt hat.
    used = {i for ids in homes.values() for i in ids}
    idle = [
        s.id
        for s in stations
        if s.id not in used
        and s.active
        and s.routing != "pull"
        and any(s.id in eligible_ids(g) for g in groups.values())
    ]
    for sid in sorted(idle):
        best_key = None
        best_share = 0.0
        for key, group in groups.items():
            if not homes.get(key) or sid not in eligible_ids(group):
                continue
            share = work_of(group, by_id[homes[key][0]]) / max(1, len(homes[key]))
            if share > best_share:
                best_key, best_share = key, share
        if best_key is not None:
            homes[best_key].append(sid)
    return homes


def spread(
    tasks: Sequence[Task],
    stations: Sequence[StationSpec],
    ctx: RoutingContext,
    *,
    policy: Optional[WorklistPolicy] = None,
) -> list[Placement]:
    """Den Arbeitsvorrat über die Stationen legen — eine oder zehn.

    Kein Verteilungsschlüssel, keine Quote, kein Rundlauf. Jede Aufgabe geht
    dorthin, **wo sie am frühesten fertig ist** — Warteschlange plus Rüsten
    plus Bearbeitung plus Weg. Daraus fällt alles Weitere von selbst:

    * Steht **eine** Maschine zur Verfügung, bekommt sie alles: es gibt keine
      zweite, die früher fertig wäre.
    * Stehen **zwei** zur Verfügung, teilt sich die Arbeit: die erste Aufgabe
      geht auf die schnellere, die zweite auf die dann leere zweite, und so
      weiter — die wachsende Warteschlange ist der Ausgleich.
    * Gleiche Werkstoffe **sammeln sich**, ohne dass es jemand vorschreibt:
      liegt eine Aufgabe erst auf einer Maschine, spart die nächste desselben
      Werkstoffs dort den Rüstwechsel und ist damit früher fertig.

    Die Reihenfolge, in der geplant wird, ist die Priorität — der dringendste
    Auftrag darf sich die beste Maschine aussuchen, nicht der erste in der
    Datenbank. Und wie in ``routing.plan_open_work_orders`` bekommt jede
    Entscheidung die vorige als Warteschlange mit; eine Planung, die die
    eigene letzte Zuteilung nicht kennt, ist keine.
    """
    p = policy or WorklistPolicy()
    queue: dict[int, float] = {s.id: s.queue_min for s in stations}
    setup: dict[int, tuple[str, float]] = {
        s.id: (s.last_mat, float(s.last_thk or 0.0)) for s in stations if s.last_mat
    }
    prios = {id(t): priority(t, p) for t in tasks}
    order = sorted(
        tasks,
        key=lambda t: (-prios[id(t)].score, t.due_in_h or 1e9, t.kind, t.ref)
    )
    # Erst die Familien auf die Stationen verteilen, dann die Aufträge — sonst
    # fährt am Abend jede Maschine jeden Werkstoff (siehe ``deal_families``).
    homes = deal_families(tasks, stations, policy=p)

    out: list[Placement] = []
    for task in order:
        opts = options_for(task, stations, ctx, setup=setup, queue=queue)
        usable = [o for o in opts if o.eligible and o.routing != "pull"]
        # Die Stationen dieser Familie zuerst. Nur wenn keine davon diese
        # eine Aufgabe nehmen kann (eine Platte, die auf den Tisch nicht
        # passt), gilt wieder das ganze Feld — die Familie ist eine
        # Vorentscheidung, kein Käfig.
        home_ids = set(homes.get(_family_key(task), []))
        at_home = [o for o in usable if o.station_id in home_ids]
        if at_home:
            usable = at_home
        if not usable:
            blocked = [o for o in opts if not o.eligible]
            why = (
                f"keine {TYPE_LABEL.get(task.station_type, '')}station im Smart-Routing"
                if not blocked
                else f"keine geeignete Station ({blocked[0].blockers[0]})"
            )
            out.append(
                Placement(task, None, "", "none", why, prios[id(task)], opts)
            )
            continue
        # Die Wahl unter den Brauchbaren — und hier steckt die eigentliche
        # Effizienzregel. Nicht „wo ist es am frühesten fertig", sondern
        # **was kostet es die Halle**: Fertigstellung plus das Rüsten, das
        # diese Platzierung auslöst. Der Unterschied ist genau der Fall, den
        # ein Meister nie machen würde — einen Auftrag auf die kalte zweite
        # Maschine legen, weil sie frei ist, und dafür ein zweites Mal
        # rüsten, um zehn Minuten früher fertig zu sein.
        #
        # Daraus fällt beides von selbst: Werkstoffe bleiben zusammen, solange
        # das Rüsten teurer ist als das Warten, und sie verteilen sich, sobald
        # die Warteschlange das Rüsten bezahlt. Der Termin bleibt darüber:
        # eine Station, an der die Zusage bricht, verliert gegen eine, an der
        # sie hält — auch wenn sie billiger wäre.
        due = task.due_in_h * 60.0 if task.due_in_h is not None else None

        def cost(o: StationOption) -> tuple:
            finish = o.finish_min if o.finish_min is not None else 1e9
            extra = (
                _changeover_cost(o, stations) if o.changeover and task.has_family else 0.0
            )
            misses = bool(due is not None and o.finish_min is not None and o.finish_min > due)
            return (
                misses,
                finish + p.overhead_weight * extra,
                o.changeover,
                o.queue_min,
                o.station_id,
            )

        best = min(usable, key=cost)
        mode = "auto" if best.routing == "smart_auto" else "suggest"
        out.append(
            Placement(
                task,
                best.station_id,
                best.label,
                mode,
                best.reason,
                prios[id(task)],
                opts,
            )
        )
        # Die Zuteilung der nächsten Entscheidung mitgeben — das ist der
        # Mechanismus, der zwei gleiche Maschinen halbe-halbe belädt.
        queue[best.station_id] = (best.finish_min or best.queue_min) - best.transport_min
        if task.has_family:
            setup[best.station_id] = task.family
    return out


def _changeover_cost(opt: StationOption, stations: Sequence[StationSpec]) -> float:
    """Die Rüstminuten, die eine Platzierung an dieser Station auslöst."""
    st = next((s for s in stations if s.id == opt.station_id), None)
    return float(st.changeover_min or 0.0) if st else 0.0
