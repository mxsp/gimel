"""Sammelschachtelung über Aufträge hinweg — Einteilung und Freigabe.

Der Kunde bekommt seinen Preis aus der Einzelkalkulation seines Auftrags —
nachvollziehbar, an seine Positionen gebunden, unabhängig davon, wer sonst
gerade bestellt. Geschnitten wird anders: alle wartenden Positionen eines
Werkstoffs und einer Dicke wandern gemeinsam auf die Platte. Das ist die
Entscheidung aus CLAUDE.md §8.2 ("price per order, nest across orders in
production"), und der Unterschied bleibt als Marge im Haus.

Dieser Modul beantwortet zwei Fragen, und nur diese:

  1. **Was darf jetzt geschnitten werden?**  Eine Freigaberegel je Eimer
     (Werkstoff, Dicke) mit sechs Gründen, von denen jeder für sich genügt.
  2. **Wie liegt es auf der Platte?**  Der Plan, aus dem Innenauftrag,
     Zeichnung und Schnittdatei entstehen.

Zwei Betriebsarten, ein Rechenweg: ``sofort`` ist ``sammel`` mit einem um die
Auftragsnummer erweiterten Eimerschlüssel und Schwellen bei null. Es gibt
bewusst keinen zweiten Codepfad — sonst hätte die eilige Fertigung andere
Fehler als die normale.

Wichtig: dieser Modul rechnet **keine Preise**. Ein Sammellauf darf einen
bereits bestätigten Auftrag nie teurer oder billiger machen.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence

from .geometry import gross_area
from .nesting import _orientation_policy, footprint, nest_best, nest_for, resolve_policy
from .nesting_gre import engine_label as gre_engine_label
from .nesting_gre import gre_available, nest_best_gre, nest_for_gre
from .types import Position, Product, Rates, Sheet

# Betriebsarten
MODE_BATCH = "sammel"
MODE_IMMEDIATE = "sofort"
MODES = (MODE_BATCH, MODE_IMMEDIATE)

#: Verfügbare Schachtel-Motoren. „gre" bricht laut, wenn 5.3.0 fehlt —
#: kein stiller Rückfall (siehe nesting_gre.py).


@dataclass
class BatchPart:
    """Eine wartende Position mit ihrer Herkunft.

    Die Herkunft ist der ganze Zweck: nach dem Schnitt muss jedes Teil wieder
    seinem Auftrag zuzuordnen sein, sonst entsteht in der Fertigung genau die
    Verwechslung, die das Sammeln erst nötig macht.
    """

    position_id: int
    order_no: str
    customer: str
    customer_ref: str
    label: str
    mat: str
    thk: float
    od: float
    di: float
    q: int
    bn: int = 0
    bd: float = 0.0
    bc: float = 0.0
    cut_len: float = 0.0
    shape: Optional[dict] = None
    # Was die Freigaberegel über das Warten und die Zusage weiß.
    ordered_at: Optional[datetime] = None
    due_date: Optional[datetime] = None
    rush: bool = False
    #: Fertigungsort-Vorgabe des Auftrags, aufgelöst ("" = überall). Teile mit
    #: verschiedener Vorgabe kommen nie auf dieselbe Platte — die Platte kann
    #: nur an einem Ort geschnitten werden.
    route_scope: str = ""
    #: Stabile Kundenkennung für die freiwillige Trennung „nur je Kunde“;
    #: ``customer`` bleibt der lesbare Name auf der Laufkarte.
    customer_key: str = ""
    #: Kundenkonto, sofern der Auftrag eines hat (für den Lauf-Filter).
    customer_id: Optional[int] = None


@dataclass(frozen=True)
class ReleasePolicy:
    """Wann ein Eimer geschnitten wird.

    Jeder Grund genügt für sich — das sind Gründe zu schneiden, keine
    Bedingungen, die gemeinsam erfüllt sein müssen. Die Reihenfolge in
    ``decide_release`` ist die Reihenfolge, in der sie berichtet werden.
    """

    mode: str = MODE_BATCH
    #: So viele wartende Stück müssen zusammenkommen.
    min_parts: int = 1
    #: Anteil der Plattenhöhe, ab dem eine Platte als voll gilt. Das ist der
    #: eigentliche Materialhebel: 40 DN25 und 3 DN800 sind nicht dieselbe
    #: Platte, und die Stückzahl allein sagt darüber nichts.
    min_utilisation: float = 0.70
    #: Spätestens nach dieser Wartezeit wird geschnitten. Ohne diese Grenze
    #: bliebe ein exotischer Werkstoff liegen, bis ein zweiter Kunde ihn
    #: bestellt — und das kann nie passieren.
    max_age_minutes: int = 1440
    #: Rückt eine zugesagte Lieferung näher als das, wird geschnitten.
    #: Materialoptimierung darf nie eine Zusage aufessen.
    due_lead_hours: int = 48
    #: Höchstens Aufträge je Innenauftrag (0 = ohne Deckel). Ein Kundenauftrag
    #: wird dabei nie auf mehrere Innenaufträge verteilt.
    max_orders_per_group: int = 0
    #: Höchstens Platten je Innenauftrag (0 = ohne Deckel). Überschreitet ein
    #: freigegebener Eimer den Wert, wird er auftrags-weise in mehrere IAs zerlegt;
    #: ein einzelner großer Auftrag darf den Wert als einziger überziehen.
    max_plates_per_group: int = 0

    def for_mode(self) -> "ReleasePolicy":
        """In ``sofort`` fallen die sammelnden Schwellen weg."""
        if self.mode != MODE_IMMEDIATE:
            return self
        return ReleasePolicy(mode=MODE_IMMEDIATE, min_parts=1, min_utilisation=0.0,
                             max_age_minutes=0, due_lead_hours=self.due_lead_hours,
                             max_orders_per_group=self.max_orders_per_group,
                             max_plates_per_group=self.max_plates_per_group)


@dataclass(frozen=True)
class NestOptions:
    """Wie eng geschachtelt wird — die geometrischen Stellschrauben.

    **Bewusst getrennt von den Kalkulationssätzen.** ``rates.gap`` und
    ``rates.margin`` gehen in den Preis ein: der Verschnittfaktor hängt an der
    angeschnittenen Fläche, und die hängt an Abstand und Rand. Wer sie
    verstellt, verschiebt jedes Angebot — auch die schon bestätigten, sobald
    etwas neu gerechnet wird.

    Diese Werte hier gelten nur für die *Fertigung*. Der Kunde hat seinen Preis
    aus seiner eigenen Schachtelung bekommen; was die Werkstatt daraus macht,
    ist genau der Unterschied, der als Marge im Haus bleibt (CLAUDE.md §8.2).
    Enger schachteln macht die Platte besser aus, ohne dass jemand nachrechnet;
    weiter schachteln kostet Fläche, ohne dass jemand nachzahlt.
    """

    #: Abstand Teil zu Teil in mm. ``None`` = Kerf des Werkstoffs, sonst der
    #: Satz aus der Kalkulation. Der Wert muss die Schnittfuge tragen: was der
    #: Strahl oder das Messer wegnimmt, fehlt beiden Nachbarn.
    gap: Optional[float] = None
    #: Abstand zum nutzbaren Rand in mm. ``None`` = Steg des Werkstoffs.
    margin: Optional[float] = None
    #: Nutzbare Breite = Format − ``trim_w``. Für Spannkante, beschädigten Rand
    #: oder eine Zuführung, die den Anfang der Platte nicht erreicht.
    trim_w: float = 0.0
    #: Nutzbare Höhe = Format − ``trim_h``.
    trim_h: float = 0.0
    #: Rechenzeit-Notbremse in Millisekunden. ``None`` = ohne. Hier ist sie
    #: erlaubt, im Preisweg nicht: ein Plan muss irgendwann fertig sein, und
    #: aus ihm wird kein festgeschriebener Preis abgeleitet. Greift sie, trägt
    #: das Ergebnis ``exhausted=False`` (docs/NESTING-ALGORITHM.md §10).
    max_ms: Optional[float] = None
    #: Wie viele Saatordnungen bewertet werden — das *deterministische* Budget,
    #: gezählt in Layouts statt in Sekunden. ``None`` = Vorgabe des Kerns.
    max_candidates: Optional[int] = None
    #: Kein Teil weiter als n mm von der Nullecke der Platte. Für Maschinen,
    #: deren Portal nicht die ganze Platte erreicht, und um den Rest der Platte
    #: als *ein* zusammenhängendes Stück zu erhalten statt als Streifen ringsum.
    #: ``None`` = keine Schranke.
    corner_max_dist: Optional[float] = None
    #: Dreh- und Spiegeloption des Kerns (2.9.0-lite): Teile dürfen auch um 90°
    #: gedreht abgelegt werden. ``None`` = Vorgabe des Kerns (an). Die
    #: Werkstoffrichtung (``grain``) bleibt auch bei ``True`` Schranke — eine
    #: gedrehte Lage auf gerichtetem Werkstoff ist Ausschuss, der richtig
    #: aussieht, nicht Verschnitt.
    allow_rotation: Optional[bool] = None
    #: Spiegelung: auf jedem platzierten Teil mitreisende Fähigkeit, die
    #: Zeichnung und Schnittdatei anwenden, sobald eine Lage sie trägt.
    #: ``None`` = Vorgabe des Kerns (an).
    allow_mirror: Optional[bool] = None
    #: Kerf: Schritte des Rechenkerns. ``None`` = aus Teilezahl und Lagen
    #: geschätzt. Eine Zahl in Schritten, nie in Sekunden — derselbe Korb
    #: ergibt dieselbe Lage.
    kerf_steps: Optional[int] = None
    #: Kerf: Abbruch nach so vielen Schritten ohne Gewinn. ``None`` = aus.
    kerf_stall: Optional[int] = None
    #: Kerf: Rasterweite in mm. ``None`` = aus Plattengröße und kleinstem Teil.
    kerf_cell: Optional[float] = None
    #: Kerf: Füllrichtung, ``"top"`` oder ``"left"``. ``None`` = ``"top"``.
    kerf_gravity: Optional[str] = None
    #: Kerf: Startwert der Suche. ``None`` = 1. Ein anderer Wert ist ein
    #: anderer Versuch, keine bessere Lage.
    kerf_seed: Optional[int] = None
    #: Kerf: letztes Budgetdrittel auf halbem Raster. ``None`` = Vorgabe.
    kerf_refine: Optional[bool] = None

    def policy(self) -> dict:
        """Die Richtlinie für ``nest()`` — nur die gesetzten Werte."""
        pol: dict = {}
        if self.max_ms is not None:
            pol["max_ms"] = self.max_ms
        if self.max_candidates is not None:
            pol["max_candidates"] = self.max_candidates
        if self.corner_max_dist is not None:
            pol["corner_max_dist"] = self.corner_max_dist
        if self.allow_rotation is not None:
            pol["allow_rotation"] = self.allow_rotation
        if self.allow_mirror is not None:
            pol["allow_mirror"] = self.allow_mirror
        if self.kerf_steps is not None:
            pol["kerf_steps"] = self.kerf_steps
        if self.kerf_stall is not None:
            pol["kerf_stall"] = self.kerf_stall
        if self.kerf_cell is not None:
            pol["kerf_cell"] = self.kerf_cell
        if self.kerf_gravity is not None:
            pol["kerf_gravity"] = self.kerf_gravity
        if self.kerf_seed is not None:
            pol["kerf_seed"] = self.kerf_seed
        if self.kerf_refine is not None:
            pol["kerf_refine"] = self.kerf_refine
        return pol

    def usable(self, w: float, h: float) -> tuple[float, float]:
        """Nutzbares Fenster einer Platte. Nie kleiner als nichts."""
        return (max(1.0, w - max(0.0, self.trim_w)),
                max(1.0, h - max(0.0, self.trim_h)))

    def offset(self) -> tuple[float, float]:
        """Wo das nutzbare Fenster auf der Platte liegt — mittig.

        Mittig und nicht in einer Ecke: ein beschädigter Rand ist selten genau
        an einer Seite, und eine Spannkante hält von zwei Seiten.
        """
        return (max(0.0, self.trim_w) / 2, max(0.0, self.trim_h) / 2)


@dataclass
class BatchPlate:
    idx: int
    fmt: tuple[float, float]
    used_h: float
    utilisation: float
    #: Anteil der Plattenhöhe, den das Schnittband beansprucht. Anders als
    #: ``utilisation`` (Füllgrad *innerhalb* des Bandes, fast immer hoch)
    #: beantwortet das die Frage, die über die Freigabe entscheidet: wie viel
    #: von der Platte ist verbraucht?
    fill: float
    #: Gedreht verbaut (GRE) — ``used_h`` misst dann über die Plattenbreite.
    turned: bool = False
    placements: list[dict] = field(default_factory=list)
    engine: str = ""


@dataclass
class BatchGroup:
    """Ein Innenauftrag in spe: ein Werkstoff, eine Dicke, n Platten."""

    mat: str
    thk: float
    #: Format der ersten Platte. Ein Innenauftrag kann mehrere Formate
    #: enthalten (siehe ``formats``) — ein Werkstoff wird in mehreren Größen
    #: gelagert, und ein DN800 braucht eine andere Platte als dreißig DN25.
    fmt: tuple[float, float]
    #: Alle vorkommenden Formate mit ihrer Anzahl: [[w, h, n], …]
    formats: list[list[float]]
    sheet_idx: int
    plates: list[BatchPlate]
    parts: list[BatchPart]
    order_nos: list[str]
    n_parts: int
    used_area_m2: float
    plate_area_m2: float
    utilisation: float
    oversize: list[BatchPart] = field(default_factory=list)
    #: Positionen, die diesmal liegen bleiben — samt Begründung. Sie behalten
    #: ``production_status = "pending"`` und laufen im nächsten Takt wieder mit.
    held: list[BatchPart] = field(default_factory=list)
    hold_reason: str = ""
    release_reason: str = ""
    #: Frühestes zugesagtes Lieferdatum im Eimer — die Fertigung sortiert danach.
    due_date: Optional[datetime] = None
    policy_mode: str = MODE_BATCH
    #: Womit geschachtelt wurde. Steht am Innenauftrag, damit in der Werkstatt
    #: nachlesbar ist, welchen Abstand der Plan angenommen hat — und damit ein
    #: alter Plan nicht stillschweigend mit neuen Werten gelesen wird.
    nest_options: dict = field(default_factory=dict)


@dataclass
class HeldBucket:
    """Ein Eimer, der diesmal gar nicht geschnitten wird."""

    mat: str
    thk: float
    parts: list[BatchPart]
    reason: str
    n_pieces: int
    fill: float
    releases_at: Optional[datetime] = None


def _tag(group_letter: str, n: int) -> str:
    """Marke eines Teils auf der Platte — kurz genug, um sie auf das Teil zu
    schreiben, eindeutig innerhalb des Innenauftrags.

    Führende Null, damit die Marken in jeder Liste in der Reihenfolge stehen,
    in der sie auf der Platte liegen: ohne sie sortiert A10 vor A3, und der
    Werker sucht das Teil an der falschen Stelle.
    """
    return f"{group_letter}{n:02d}"


def group_key(p: BatchPart, mode: str = MODE_BATCH, group_by: str = "material") -> tuple:
    """Was gemeinsam auf eine Platte darf.

    In ``sammel``: gleicher Werkstoff, gleiche Dicke — über alle Kunden hinweg.
    Mit ``group_by="customer"`` zusätzlich derselbe Kunde: die Werkstatt kann
    Kundenaufträge bewusst getrennt halten, ohne in den Einzelauftrag zu gehen.
    In ``sofort``: derselbe Kundenauftrag, also ein Innenauftrag je Auftrag und
    Werkstoff, ohne Vermischung.

    Die Dicke ist keine Formalie — 2 mm und 3 mm sind physisch verschiedene
    Platten. Wer das zusammenwirft, produziert Ausschuss.
    """
    if mode == MODE_IMMEDIATE:
        return (p.order_no, p.mat, float(p.thk))
    scope = f"@{p.route_scope}" if p.route_scope else ""
    if group_by == "customer":
        return (scope, p.customer_key or p.customer, p.mat, float(p.thk))
    # Ohne Vorgabe bleibt der Schlüssel, wie er war — dieselben Marken wie vorher.
    return (scope, p.mat, float(p.thk))


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    """SQLite gibt naive Zeitstempel zurück; Vergleiche brauchen UTC-behaftete."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _to_positions(bucket: Sequence[BatchPart]) -> list[Position]:
    """Teile für den Rechenkern. Die id bleibt die Positions-id, damit jedes
    platzierte Teil rückwärts auflösbar ist.

    ``shape`` muss mit: ohne Kontur schachtelt der Kern jedes Teil als
    Hüllquadrat seines Umkreises — ein 400 × 300 belegte 500 × 500, und der
    Sammellauf verbrauchte mehr Platte, als der Preis (``footprint``)
    angenommen hatte."""
    return [Position(id=p.position_id, od=p.od, di=p.di, q=p.q, mat=p.mat,
                     thk=p.thk, t=p.label, bn=p.bn, bd=p.bd, bc=p.bc,
                     cut_len=p.cut_len, shape=p.shape)
            for p in bucket]


def _nest(bucket: Sequence[BatchPart], product: Product, rates: Rates,
          plate_idx: Optional[int], policy: Optional[dict] = None,
          engine: str = "lite") -> dict:
    positions = _to_positions(bucket)
    if engine == "kerf":
        from .nesting_kerf import nest_best_kerf, nest_for_kerf

        if plate_idx is None:
            return nest_best_kerf(positions, product, rates, policy)
        return nest_for_kerf(positions, product, rates, plate_idx, policy)
    if engine == "gre":
        if not gre_available():
            raise RuntimeError(
                "nesting_engine=gre, aber die GRE-Engine (5.3.0) ist nicht "
                "installierbar/importierbar — Schalter prüfen oder zurück auf lite."
            )
        if plate_idx is None:
            return nest_best_gre(positions, product, rates, policy)
        return nest_for_gre(positions, product, rates, plate_idx, policy)
    if plate_idx is None:
        return nest_best(positions, product, rates, policy)
    return nest_for(positions, product, rates, plate_idx, policy)


@dataclass
class PlannedPlate:
    """Eine physische Platte im Plan — mit ihrem eigenen Format.

    Ein Werkstoff wird in mehreren Formaten gelagert, und ein Innenauftrag darf
    sie mischen: eine DN800 braucht 1500 × 3000, die dreißig DN25 daneben füllen
    eine 1000 × 1000 besser aus, als sie am Rand der großen Platte verloren
    gingen. Deshalb trägt jede Platte ihr Format selbst und nicht die Gruppe.

    ``W``/``H`` sind das ECHTE Format — die Platte, die aus dem Regal kommt.
    Geschachtelt wurde im nutzbaren Fenster (``usable_w``/``usable_h``), das um
    ``off_x``/``off_y`` versetzt darin liegt. Zeichnung und Schnittdatei zeigen
    die ganze Platte mit dem eingerückten Teilefeld: der Werker legt eine echte
    1500 × 3000 auf, nicht ein gedachtes Fenster.
    """

    W: float
    H: float
    sheet_idx: int
    sheet: Sheet
    usable_w: float = 0.0
    usable_h: float = 0.0
    off_x: float = 0.0
    off_y: float = 0.0
    #: Hat der Motor die Platte um 90° gedreht verbaut (GRE,
    #: ``allow_plate_rotation``)? Die Lagen stehen dann schon im Rahmen des
    #: Lagerformats — zurückgedreht hat der Adapter —, aber das Schnittband
    #: läuft über die Platten*breite*: ``used_h`` misst quer, nicht hoch.
    #: Zeichnung, Schnittdatei und Laufkarte stellen das Band danach dar.
    turned: bool = False
    #: Lief die Suche zu Ende, oder hat die Rechenzeit-Notbremse abgebrochen?
    #: ``False`` heißt: dieser Plan ist nicht reproduzierbar entstanden. Das
    #: muss am Innenauftrag stehen und darf nicht verschluckt werden
    #: (docs/NESTING-ALGORITHM.md §10).
    exhausted: bool = True
    #: Wer diese Platte wirklich geschachtelt hat: mit ``kerf`` kann es lite sein.
    engine: str = ""

    @property
    def used_h(self) -> float:
        """Wie weit das Schnittband reicht, von der Plattenkante aus gemessen.

        Auf der ungedrehten Platte wächst es über die Höhe, auf der gedrehten
        über die Breite — deshalb der Offset von der passenden Achse.
        """
        return (self.off_x if self.turned else self.off_y) + self.sheet.used_h

    @property
    def used_area_m2(self) -> float:
        """Angeschnittene Fläche in m² — Band × Plattenbreite je Achsenlage."""
        band_w = self.H if self.turned else self.W
        return (band_w / 1000) * (self.used_h / 1000)

    @property
    def fill(self) -> float:
        """Welcher Anteil der Platte ist angeschnitten — die Freigabegröße."""
        denom = self.W if self.turned else self.H
        return min(1.0, self.used_h / denom) if denom else 0.0


def _gap_margin(product: Product, rates: Rates) -> tuple[float, float]:
    gap = product.kerf if product.kerf is not None else rates.gap
    margin = product.web if product.web is not None else rates.margin
    return gap, margin


def _fits_any_format(part: BatchPart, product: Product, margin: float,
                     can_turn: bool = False) -> bool:
    """Passt das Teil auf irgendein gelagertes Format?

    Erst wenn es auf keines passt, ist es wirklich Übergröße und geht als
    Anfrage an die Technik (CLAUDE.md §5.1). Die Prüfung je Format allein
    genügt nicht mehr, seit ein Auftrag mehrere Formate mischen darf.

    Gemessen an der Standfläche, wie im Kern (``nesting.footprint``), nicht am
    Umkreis: ein Streifen 1200 × 120 liegt längs auf einer 1500 × 1000er
    Platte, obwohl sein Umkreis 1206 mm misst. ``can_turn`` lässt auch die
    um 90° gedrehte Lage zählen — nur, wenn Vorgabe und Werkstoffrichtung sie
    erlauben. Für Ringe ist die Standfläche das Hüllquadrat; dort ändert sich
    nichts.
    """
    fw, fh = footprint(part)
    for w, h in product.sheets:
        uw, uh = float(w) - 2 * margin + 1e-7, float(h) - 2 * margin + 1e-7
        if (fw <= uw and fh <= uh) or (can_turn and fh <= uw and fw <= uh):
            return True
    return False


def _for_production(product: Product, options: NestOptions) -> Product:
    """Der Werkstoff, wie die Fertigung ihn schachtelt.

    Eine Kopie mit dem nutzbaren Fenster als Format und den Fertigungsabständen
    als Kerf und Steg. Der echte Werkstoff bleibt unangetastet — er gehört der
    Kalkulation, und die darf sich hier nicht verschieben.
    """
    if options == NestOptions():
        return product
    return replace(
        product,
        sheets=[options.usable(float(w), float(h)) for w, h in product.sheets],
        kerf=options.gap if options.gap is not None else product.kerf,
        web=options.margin if options.margin is not None else product.web,
    )


def _peel_plates(bucket: Sequence[BatchPart], product: Product, rates: Rates,
                 plate_idx: Optional[int], mixed: bool,
                 options: Optional[NestOptions] = None,
                 engine: str = "lite"
                 ) -> tuple[list[PlannedPlate], list[BatchPart]]:
    """Platte für Platte planen und dabei je Platte das Format neu wählen.

    Vorgehen: den Rest schachteln, die *erste* Platte übernehmen, die darauf
    liegenden Stück abziehen, von vorn. Damit bekommt jede Platte das Format,
    das für das zu diesem Zeitpunkt noch Offene das günstigste ist — greedy,
    deterministisch, und ohne den Rechenkern anzufassen, der die Preise macht.

    Ohne ``mixed`` (oder mit fester Plattenwahl) bleibt es beim alten Verhalten:
    ein Format für den ganzen Auftrag.
    """
    options = options or NestOptions()
    prod = _for_production(product, options)
    ox, oy = options.offset()
    # Vom nutzbaren Format zurück auf das echte, je Index.
    real = {i: (float(w), float(h)) for i, (w, h) in enumerate(product.sheets)}

    def plate(nested: dict, sh: Sheet, si: int) -> PlannedPlate:
        W, H = real.get(nested["sheet_idx"], (nested["W"], nested["H"]))
        turned = bool((nested.get("turned_sheets") or [False] * len(nested["sheets"]))[si])
        return PlannedPlate(W=W, H=H, sheet_idx=nested["sheet_idx"], sheet=sh,
                            usable_w=nested["W"], usable_h=nested["H"],
                            off_x=ox, off_y=oy, turned=turned,
                            exhausted=bool(nested.get("exhausted", True)),
                            engine=str(nested.get("v") or ""))

    _gap, margin = _gap_margin(prod, rates)
    can_turn = _orientation_policy(prod, resolve_policy(rates, options.policy()))["rot90"]
    oversize = [p for p in bucket if not _fits_any_format(p, prod, margin, can_turn)]
    over_ids = {id(p) for p in oversize}
    work = [p for p in bucket if id(p) not in over_ids]

    if not work:
        return [], oversize

    if not mixed or plate_idx is not None:
        nested = _nest(work, prod, rates, plate_idx, options.policy(), engine)
        plates = [plate(nested, sh, si) for si, sh in enumerate(nested["sheets"])]
        planned_ids = {p.id for p in nested["over"]}
        oversize += [p for p in work if p.position_id in planned_ids]
        return plates, oversize

    plates: list[PlannedPlate] = []
    remaining = [replace(p) for p in work]
    # Deckel gegen eine Schleife, die nicht kleiner wird. Er greift nie bei
    # gesunden Daten; wenn doch, ist Stehenbleiben besser als ein Hänger.
    for _ in range(400):
        if not remaining:
            break
        nested = _nest(remaining, prod, rates, None, options.policy(), engine)
        sheets = nested["sheets"]
        if not sheets or (not sheets[0].top and not sheets[0].rest):
            break
        # Kerf ist teuer: er liefert alle vollen Platten auf einmal, nur die letzte
        # wird neu gerechnet, damit sie ihr günstigstes Format bekommt.
        taken = len(sheets) - 1 if engine == "kerf" and len(sheets) > 1 else 1
        used = Counter()
        for si in range(taken):
            plates.append(plate(nested, sheets[si], si))
            for placed in list(sheets[si].top) + list(sheets[si].rest):
                used[placed.pos.id] += 1
        nxt = [replace(p, q=p.q - used.get(p.position_id, 0))
               for p in remaining if p.q - used.get(p.position_id, 0) > 0]
        if sum(p.q for p in nxt) >= sum(p.q for p in remaining):
            break                      # kein Fortschritt — abbrechen statt drehen
        remaining = nxt

    # Was übrig bleibt, passt in diesem Lauf auf keine Platte mehr.
    left = {p.position_id for p in remaining}
    oversize += [p for p in work if p.position_id in left]
    return plates, oversize


def _plate_fills(plates: Sequence[PlannedPlate]) -> list[float]:
    """Je Platte: welcher Anteil der Plattenhöhe ist angeschnitten."""
    return [pl.fill for pl in plates]


def decide_release(bucket: Sequence[BatchPart], plates: Sequence["PlannedPlate"],
                   policy: ReleasePolicy, *, force: bool = False,
                   now: Optional[datetime] = None) -> tuple[str, str]:
    """Warum dieser Eimer jetzt geschnitten wird — oder warum nicht.

    Rückgabe ``(grund, "")`` bei Freigabe, ``("", grund)`` beim Zurückstellen.
    Der Grund ist Klartext und wandert unverändert in den Lauf und ins
    Admin-Panel: eine Regel, deren Entscheidung man nicht nachlesen kann, wird
    beim ersten Zweifel abgeschaltet.

    ``now`` kommt vom Aufrufer, der Kern liest keine Uhr. Nur ein von Hand
    ausgelöster Lauf (``force``) kommt ohne aus: dort zählt keine Frist.
    """
    if now is None and not force:
        raise ValueError("decide_release braucht now — der Kern liest keine Uhr")
    pieces = sum(max(1, p.q) for p in bucket)
    fills = _plate_fills(plates)
    best_fill = max(fills) if fills else 0.0

    if force:
        return "Von Hand ausgelöst", ""
    if policy.mode == MODE_IMMEDIATE:
        return "Betriebsart sofort — jeder Auftrag für sich", ""
    if any(p.rush for p in bucket):
        return "Eilauftrag im Eimer", ""

    due = min((d for d in (_aware(p.due_date) for p in bucket) if d), default=None)
    if due is not None and due - now <= timedelta(hours=policy.due_lead_hours):
        return f"Zusage fällig am {due:%d.%m.%Y}", ""

    oldest = min((d for d in (_aware(p.ordered_at) for p in bucket) if d), default=None)
    if policy.max_age_minutes <= 0:
        return "Wartezeit ohne Grenze — sofortige Freigabe", ""
    if oldest is not None and now - oldest >= timedelta(minutes=policy.max_age_minutes):
        wait = int((now - oldest).total_seconds() // 60)
        return f"Wartezeit {wait} min über der Grenze von {policy.max_age_minutes} min", ""

    if best_fill >= policy.min_utilisation > 0:
        return f"Platte zu {best_fill * 100:.0f} % belegt", ""
    if pieces >= policy.min_parts:
        return f"{pieces} Teile beisammen (Grenze {policy.min_parts})", ""

    return "", (f"{pieces} von {policy.min_parts} Teilen · Platte zu {best_fill * 100:.0f} % "
                f"belegt (Freigabe ab {policy.min_utilisation * 100:.0f} %) — sammelt weiter")


def release_times(bucket: Sequence[BatchPart],
                  policy: ReleasePolicy) -> tuple[Optional[datetime], Optional[datetime]]:
    """Die beiden Uhren eines Eimers: ``(nach Wartezeit, nach Zusage)``."""
    if policy.mode == MODE_IMMEDIATE or policy.max_age_minutes <= 0:
        return None, None
    oldest = min((d for d in (_aware(p.ordered_at) for p in bucket) if d), default=None)
    by_age = oldest + timedelta(minutes=policy.max_age_minutes) if oldest else None
    due = min((d for d in (_aware(p.due_date) for p in bucket) if d), default=None)
    by_due = due - timedelta(hours=policy.due_lead_hours) if due else None
    return by_age, by_due


def releases_at(bucket: Sequence[BatchPart], policy: ReleasePolicy) -> Optional[datetime]:
    """Wann der Eimer spätestens von selbst herausgeht, wenn nichts dazukommt.

    Das ist die Zahl, die den Unterschied macht zwischen einer Regel, der die
    Werkstatt vertraut, und einer Blackbox: "warum ist das noch nicht
    geschnitten, und wann wird es das".
    """
    candidates = [d for d in release_times(bucket, policy) if d]
    return min(candidates) if candidates else None


def _split_at_full_plates(bucket: Sequence[BatchPart], plates: Sequence["PlannedPlate"],
                          policy: ReleasePolicy) -> tuple[list[BatchPart], list[BatchPart]]:
    """Volle Platten schneiden, die angebrochene weitersammeln lassen.

    Das ist der größte einzelne Materialgewinn dieser Regel. Bisher ging ein
    Eimer ganz oder gar nicht: 2,3 Platten voll hieß entweder 2,3 Platten
    schneiden — die dritte fast leer — oder gar nichts.

    Eine Position wird dabei **nie geteilt**. Liegt auch nur ein Stück von ihr
    auf einer zurückgestellten Platte, bleibt die ganze Position liegen. Damit
    bleibt ``production_status`` eine Aussage über die Position und nicht über
    einzelne Stücke, und die Zusage "eine Position lebt in genau einem
    Innenauftrag" hält. Der Preis dafür: eine große Position kann eine Platte
    offen halten — dagegen stehen Wartezeit- und Zusagegrenze.
    """
    held_ids: set[int] = set()
    for pl in plates:
        if pl.fill >= policy.min_utilisation:
            continue
        for placed in list(pl.sheet.top) + list(pl.sheet.rest):
            held_ids.add(placed.pos.id)
    if not held_ids:
        return list(bucket), []
    released = [p for p in bucket if p.position_id not in held_ids]
    held = [p for p in bucket if p.position_id in held_ids]
    return released, held


def _partition_by_order_limits(
    bucket: Sequence[BatchPart],
    policy: ReleasePolicy,
    product: Product,
    rates: Rates,
    plate_idx: Optional[int],
    mixed: bool,
    opts: NestOptions,
    engine: str = "lite",
) -> list[list[BatchPart]]:
    """Eimer auftrags-weise in Innenauftrags-Cluster zerlegen.

    Grenzen:
    * ``max_orders_per_group`` — höchstens so viele Kundenaufträge je IA (0 = ohne Deckel).
    * ``max_plates_per_group`` — höchstens so viele Platten je IA (0 = ohne Deckel).

    Garantie: ein Kundenauftrag wandert **nie auseinander**. Alle Positionen
    desselben ``order_no`` landen im selben Cluster, egal wie die Deckel stehen.
    Ein einzelner großer Auftrag darf seinen eigenen Plattendeckel als einziger
    überziehen — zerteilen ist schlimmer als eine übervolle Platte.

    Sortierung deterministisch (Invariante 5): früheste Zusage zuerst, dann
    früheste Bestellung, dann Auftragsnummer.
    """
    max_orders = max(0, int(policy.max_orders_per_group or 0))
    max_plates = max(0, int(policy.max_plates_per_group or 0))
    if max_orders <= 0 and max_plates <= 0:
        return [list(bucket)]
    if not bucket:
        return []

    # Positionen je Auftrag sammeln — Auftrag bleibt ganz.
    by_order: dict[str, list[BatchPart]] = {}
    for p in bucket:
        by_order.setdefault(p.order_no, []).append(p)

    # Metadaten je Auftrag für Sortierung
    far = datetime.max.replace(tzinfo=timezone.utc)
    order_metas: list[tuple[datetime, datetime, str, str]] = []
    for order_no, parts in by_order.items():
        due = min((_aware(p.due_date) for p in parts if p.due_date), default=None)
        ordered = min((_aware(p.ordered_at) for p in parts if p.ordered_at), default=None)
        order_metas.append((
            due or far,
            ordered or far,
            order_no,
            order_no,
        ))
    order_metas.sort(key=lambda t: (t[0], t[1], t[2]))
    sorted_order_nos = [t[3] for t in order_metas]

    clusters: list[list[BatchPart]] = []
    cur: list[BatchPart] = []
    cur_orders: set[str] = set()

    def _plate_count(parts: Sequence[BatchPart]) -> int:
        if not parts:
            return 0
        pls, _ = _peel_plates(parts, product, rates, plate_idx, mixed, opts, engine)
        return len(pls)

    for order_no in sorted_order_nos:
        oparts = by_order[order_no]
        would_orders = len(cur_orders) + (0 if order_no in cur_orders else 1)
        # Deckel 1: Aufträge
        if max_orders > 0 and would_orders > max_orders and cur:
            clusters.append(cur)
            cur = []
            cur_orders = set()
            would_orders = 1
        # Deckel 2: Platten — nur prüfen wenn max_plates gesetzt
        if max_plates > 0 and cur:
            # Probeschachtelung: passen die beiden zusammen noch in den Deckel?
            combined = cur + oparts
            # Ein einzelner Auftrag darf den Deckel alleine überziehen — deshalb
            # nur dann schließen, wenn der aktuelle Cluster nicht leer ist UND
            # der kombinierte Bedarf den Deckel sprengt.
            if _plate_count(combined) > max_plates:
                # Aktueller Cluster abschließen, neuen mit diesem Auftrag beginnen.
                clusters.append(cur)
                cur = list(oparts)
                cur_orders = {order_no}
                # Falls dieser einzelne Auftrag alleine schon > max_plates ist,
                # lassen wir ihn so stehen (Überzug erlaubt) und schließen ihn
                # gleich wieder, damit der nächste Auftrag nicht dranhängt.
                if _plate_count(cur) > max_plates:
                    clusters.append(cur)
                    cur = []
                    cur_orders = set()
                continue
        # Passt — anhängen
        if order_no not in cur_orders:
            cur_orders.add(order_no)
        cur.extend(oparts)

    if cur:
        clusters.append(cur)

    # Falls alles in einem Cluster blieb, Originalreihenfolge (position_id) wahren
    # für deterministische Zeichnung — Sortierung war nur für das Packen.
    if len(clusters) == 1:
        return [sorted(clusters[0], key=lambda p: (p.position_id, p.order_no))]
    # Innerhalb jedes Clusters wieder nach position_id sortieren (stabile Zeichnung)
    return [sorted(c, key=lambda p: (p.position_id, p.order_no)) for c in clusters]


def _effective_options(product: Product, rates: Rates, opts: NestOptions,
                       first: PlannedPlate,
                       plates: Optional[Sequence[PlannedPlate]] = None) -> dict:
    """Die Werte, mit denen tatsächlich geschachtelt wurde.

    Sie wandern an den Innenauftrag, damit in der Werkstatt nachlesbar ist, was
    der Plan angenommen hat — und damit ein alter Plan nicht stillschweigend mit
    neuen Werten gelesen wird, nachdem jemand die Einstellung geändert hat.
    """
    gap = opts.gap if opts.gap is not None else (
        product.kerf if product.kerf is not None else rates.gap)
    margin = opts.margin if opts.margin is not None else (
        product.web if product.web is not None else rates.margin)
    return {
        "gap": round(float(gap), 2),
        "margin": round(float(margin), 2),
        "trim_w": round(float(opts.trim_w), 2),
        "trim_h": round(float(opts.trim_h), 2),
        "usable": [round(first.usable_w, 1), round(first.usable_h, 1)],
        # Auch die Suchvorgaben wandern mit: ein Plan, der unter einer
        # Eckschranke oder einer Notbremse entstanden ist, sieht sonst in der
        # Werkstatt aus wie einer, der frei rechnen durfte.
        "max_ms": opts.max_ms,
        "max_candidates": opts.max_candidates,
        "corner_max_dist": opts.corner_max_dist,
        # Hat die Notbremse gegriffen, ist dieser Plan nicht reproduzierbar
        # entstanden. Das steht hier, damit es in der Werkstatt zu lesen ist
        # statt nur im Log (docs/NESTING-ALGORITHM.md §10).
        "exhausted": all(p.exhausted for p in (plates or [first])),
    }


def plan_batch(parts: Sequence[BatchPart],
               products: dict[str, Product],
               rates: Rates,
               plate_choice: Optional[dict[str, int]] = None,
               policy_for: Optional[callable] = None,
               *, force: bool = False,
               mixed_formats: bool = True,
               options_for: Optional[callable] = None,
               now: Optional[datetime] = None,
               engine: str = "lite",
               group_by: str = "material") -> tuple[list[BatchGroup], list[HeldBucket]]:
    """Alle wartenden Teile in Innenaufträge einteilen.

    Rückgabe ist nach (Werkstoff, Dicke) sortiert, damit zwei Läufe mit
    demselben Bestand dieselbe Einteilung ergeben (Invariante 5 gilt auch hier
    — sonst ist ein Lauf nicht reproduzierbar und ein Fehler nicht auffindbar).

    ``policy_for(mat, thk)`` liefert die Regel für einen Eimer; ohne sie gilt
    die Vorgabe. Zurückgestellte Eimer und zurückgestellte Positionen kommen
    getrennt zurück — beides muss im Panel begründet erscheinen.

    ``engine`` wählt den Schachtelkern: ``kerf`` (Vorgabe der Fertigung — echte
    Kontur, mit ``lite`` als Untergrenze), ``lite`` (2.8.0, die Kasse rechnet
    damit und bleibt unangetastet) oder ``gre`` (5.3.0, nur Fertigung —
    bessere Ausnutzung, Rechenzeit egal, Preise bleiben wo sie sind).

    ``group_by="customer"`` trennt die Eimer zusätzlich nach Kunde; die
    Freigaberegeln und alle übrigen Schwellen bleiben dieselben.
    """
    plate_choice = plate_choice or {}
    resolve = policy_for or (lambda _m, _t: ReleasePolicy())
    resolve_opts = options_for or (lambda _m, _t: NestOptions())

    buckets: dict[tuple, list[BatchPart]] = {}
    for p in parts:
        mode = resolve(p.mat, float(p.thk)).mode
        buckets.setdefault(group_key(p, mode, group_by), []).append(p)

    groups: list[BatchGroup] = []
    held_buckets: list[HeldBucket] = []

    for key in sorted(buckets.keys()):
        if len(key) == 4:
            _order_scope, _customer_key, mat, thk = key
        else:
            _order_scope, mat, thk = key
        product = products.get(mat)
        if not product:
            continue
        bucket = sorted(buckets[key], key=lambda p: (p.position_id, p.order_no))
        policy = resolve(mat, thk).for_mode()
        opts = resolve_opts(mat, thk)
        idx = plate_choice.get(mat)

        # Erster Lauf: Probeschachtelung des ganzen Eimers, Platte für Platte.
        # Sie beantwortet die Freigabefrage und sagt, welche Platten voll sind.
        trial, trial_over = _peel_plates(bucket, product, rates, idx, mixed_formats,
                                         opts, engine)
        reason, hold = decide_release(bucket, trial, policy, force=force, now=now)
        if hold:
            held_buckets.append(HeldBucket(
                mat=mat, thk=thk, parts=bucket, reason=hold,
                n_pieces=sum(max(1, p.q) for p in bucket),
                fill=max(_plate_fills(trial), default=0.0),
                releases_at=releases_at(bucket, policy),
            ))
            continue

        # Nur die reinen Mengen- und Füllgründe stellen die angebrochene Platte
        # zurück. Frist-, Eil- und Handgründe schneiden alles — sie sind der
        # Grund, warum überhaupt nicht länger gesammelt wird.
        defers = reason.startswith("Platte zu") or "Teile beisammen" in reason
        released, held = ([*bucket], []) if not defers \
            else _split_at_full_plates(bucket, trial, policy)

        # Übergrößen bleiben nie liegen — sie warten auf einen Menschen, nicht
        # auf eine volle Platte.
        over_ids = {p.position_id for p in trial_over}
        held = [p for p in held if p.position_id not in over_ids]
        if not [p for p in released if p.position_id not in over_ids] and not trial_over:
            held_buckets.append(HeldBucket(
                mat=mat, thk=thk, parts=bucket,
                reason=f"{reason} — aber keine volle Platte, sammelt weiter",
                n_pieces=sum(max(1, p.q) for p in bucket),
                fill=max(_plate_fills(trial), default=0.0),
                releases_at=releases_at(bucket, policy),
            ))
            continue

        # Aufteilen nach IA-Deckeln (Aufträge/Platten) — auftrags-weise, nie ein Auftrag zerteilt.
        clusters = _partition_by_order_limits(released, policy, product, rates, idx,
                                              mixed_formats, opts, engine)
        split_suffix = ""
        if len(clusters) > 1:
            _reasons: list[str] = []
            if policy.max_orders_per_group > 0:
                _reasons.append(f"max {policy.max_orders_per_group} Aufträge/IA")
            if policy.max_plates_per_group > 0:
                _reasons.append(f"max {policy.max_plates_per_group} Platten/IA")
            split_suffix = f" — aufgeteilt ({' + '.join(_reasons)}): Teil {{i}}/{{n}}"

        # Für jedes Cluster einen eigenen Innenauftrag planen.
        for ci, cluster in enumerate(clusters):
            # Zweiter Lauf pro Cluster falls Split oder angebrochene Platte:
            # neu schachteln, sonst trial wiederverwenden wenn identisch.
            if len(clusters) == 1 and not held and set(p.position_id for p in cluster) == set(p.position_id for p in released):
                planned, over_parts = trial, trial_over
                # Falls released == cluster aber held non-empty wäre, dürfte trial nicht wiederverwendet werden —
                # oben bereits ausgeschlossen (held -> Neuplanung). Hier ist held leer, also exakt.
            else:
                planned, over_parts = _peel_plates(cluster, product, rates, idx,
                                                   mixed_formats, opts, engine)
            by_pos = {p.position_id: p for p in cluster}

            plate_area_m2 = sum((pl.W / 1000) * (pl.H / 1000) for pl in planned)
            used_area_m2 = sum(pl.used_area_m2 for pl in planned)

            letter = chr(ord("A") + (len(groups) % 26))
            counter = 0
            plates: list[BatchPlate] = []
            n_parts = 0
            seen_orders: list[str] = []

            for si, pl in enumerate(planned):
                placements = []
                part_area = 0.0
                # Erst die Hauptteile, dann die Restflächenteile — dieselbe
                # Reihenfolge wie in der Ansicht, damit Marke und Bild übereinstimmen.
                for placed, from_remnant in ([(x, False) for x in pl.sheet.top]
                                             + [(x, True) for x in pl.sheet.rest]):
                    counter += 1
                    src = by_pos.get(placed.pos.id)
                    if src is None:
                        continue
                    if src.order_no not in seen_orders:
                        seen_orders.append(src.order_no)
                    # Echte Teilefläche (Außenkontur), nicht die Scheibe des
                    # Umkreises — ein 400 × 300 hat 0,12 m², nicht 0,196 m².
                    # Ohne Kontur bleibt es der Ring, wie bisher.
                    outer_mm2 = gross_area(src.shape)
                    part_area += (outer_mm2 / 1e6 if outer_mm2 > 0
                                  else math.pi * (placed.od / 1000) ** 2 / 4)
                    placements.append({
                        "tag": _tag(letter, counter),
                        "position_id": src.position_id,
                        "order_no": src.order_no,
                        "customer": src.customer,
                        "customer_ref": src.customer_ref,
                        "label": src.label,
                        # Auf die echte Platte umgerechnet: geschachtelt wurde im
                        # nutzbaren Fenster, gezeichnet und geschnitten wird auf der
                        # Platte, die aus dem Regal kommt.
                        "cx": round(placed.cx + pl.off_x, 3),
                        "cy": round(placed.cy + pl.off_y, 3),
                        "od": placed.od,
                        "di": placed.di,
                        "bn": src.bn,
                        "bd": src.bd,
                        "bc": src.bc,
                        "seq": placed.seq,
                        # Lage des Teils — render/plate.py und render/dxf.py
                        # wenden beides an, sonst schneidet die Maschine das
                        # Teil in der falschen Lage.
                        "rot": float(getattr(placed, "rot", 0.0) or 0.0),
                        "mirror": bool(getattr(placed, "mirror", False)),
                        "from_remnant": from_remnant,
                        "shape": src.shape,
                    })
                    n_parts += 1
                sheet_used = pl.used_area_m2
                plates.append(BatchPlate(
                    idx=si, fmt=(pl.W, pl.H), used_h=pl.used_h, engine=pl.engine,
                    utilisation=(part_area / sheet_used) if sheet_used else 0.0,
                    fill=pl.fill,
                    turned=pl.turned,
                    placements=placements,
                ))

            if not plates:
                continue

            # Welche Formate kommen vor, und wie oft. Die Werkstatt holt danach die
            # Platten aus dem Regal, bevor sie den Auftrag anfängt.
            counts: dict[tuple[float, float], int] = {}
            for pl in planned:
                counts[(pl.W, pl.H)] = counts.get((pl.W, pl.H), 0) + 1
            formats = [[w, h, n] for (w, h), n in sorted(counts.items())]

            due = min((d for d in (_aware(p.due_date) for p in cluster) if d), default=None)
            # Held gehört zum Eimer insgesamt, nicht je Teil-IA — nur am ersten
            # Teil-IA ausweisen, sonst steht dieselbe Warnung n-mal.
            is_first_cluster = (ci == 0)
            cluster_reason = reason
            if split_suffix:
                cluster_reason = f"{reason}{split_suffix.format(i=ci + 1, n=len(clusters))}"
            groups.append(BatchGroup(
                mat=mat, thk=thk, fmt=(planned[0].W, planned[0].H), formats=formats,
                sheet_idx=planned[0].sheet_idx,
                plates=plates, parts=cluster, order_nos=seen_orders, n_parts=n_parts,
                used_area_m2=used_area_m2, plate_area_m2=plate_area_m2,
                utilisation=(used_area_m2 / plate_area_m2) if plate_area_m2 else 0.0,
                oversize=[p for p in over_parts],
                held=(held if is_first_cluster else []),
                hold_reason=("Angebrochene Platte sammelt weiter" if (held and is_first_cluster) else ""),
                release_reason=cluster_reason,
                due_date=due,
                policy_mode=policy.mode,
                nest_options=_effective_options(product, rates, opts, planned[0], planned),
            ))
    return groups, held_buckets


def _nested_used_area(nested: dict) -> float:
    """Angeschnittene Fläche eines nest()-Ergebnisses in m².

    Bei gedreht verbauten Platten (GRE, ``turned_sheets``) misst ``used_h``
    über die Plattenbreite — die Fläche rechnet dann Höhe × Band.
    """
    turned = nested.get("turned_sheets") or []
    total = 0.0
    for si, sh in enumerate(nested["sheets"]):
        w = nested["H"] if si < len(turned) and turned[si] else nested["W"]
        total += (w / 1000) * (sh.used_h / 1000)
    return total


def solo_area(parts: Sequence[BatchPart], products: dict[str, Product],
              rates: Rates, engine: str = "lite") -> float:
    """Angeschnittene Fläche, wenn jeder Auftrag für sich geschachtelt würde.

    Der Vergleichswert zur Sammelschachtelung — nur so lässt sich belegen, dass
    das Sammeln überhaupt etwas bringt, statt es zu behaupten. Derselbe Motor
    wie die Sammelschachtelung, sonst vergleicht der Bericht Äpfel mit Birnen.
    """
    buckets: dict[tuple[str, str, float], list[BatchPart]] = {}
    for p in parts:
        buckets.setdefault((p.order_no, p.mat, float(p.thk)), []).append(p)

    total = 0.0
    for key in sorted(buckets.keys()):
        product = products.get(key[1])
        if not product:
            continue
        # Der Vergleichswert darf den Lauf nicht verdoppeln: je Auftrag ein Kerf-Lauf
        # wäre teurer als der Plan, also nur seine Startreihenfolgen.
        policy = {"kerf_steps": 4} if engine == "kerf" else None
        nested = _nest(buckets[key], product, rates, None, policy, engine)
        total += _nested_used_area(nested)
    return total
