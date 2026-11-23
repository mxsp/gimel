"""Werttypen des Rechenkerns.

Bewusst als Dataclasses und nicht als ORM-Modelle: der Kern darf nichts über
Datenbank, Session oder Request wissen (CLAUDE.md §3 — "the engine is pure").
Die Router bauen diese Objekte aus den ORM-Zeilen zusammen und geben sie hinein.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class Rates:
    """Kalkulationssätze. Sämtlich Richtwerte — siehe CLAUDE.md §7.

    Maschinenstunde (2026-09): ``cut`` (€/m) ist hergeleitet, kein Messwert:
    ATOM FlashCut 3015/5 (reconditioned 2025, Fastweld) nennt 50 m/min
    (= 833 mm/s) Maximalvorschub; CNC-Schachtelplotter nennen 0–1800 mm/s,
    Traverse 800–2000 mm/s (AOL-1625DCS). Abrechenbar ist der *Netto*vorschub
    nach Kurven, Anstichen und Handling: Default 43 mm/s (2,6 m/min) bei
    65 €/h → 65 / 3,6 / 43 = 0,42 €/m. Wer ``machine_h`` oder ``cut_speed``
    ändert, sieht in der Hilfe/Buchhaltung sofort den hergeleiteten Satz.
    """

    cut: float = 0.42  # €/m Schnittlänge (Rückfall; hergeleitet, s.o.)
    # Schnittsatz je Plattendicke (2.10.0-lite) — aus 65 €/h und dem
    # dickenspezifischen Vorschub (1,0 mm: 3,0 m/min · 1,5 mm: 2,5 m/min ·
    # 2,0 mm: 2,0 m/min · 3,0 mm: 1,0 m/min). Andere Dicken fallen auf `cut`.
    cut_thk1: float = 65 / 60 / 3
    cut_thk15: float = 65 / 60 / 2.5
    cut_thk2: float = 65 / 60 / 2
    cut_thk3: float = 65 / 60 / 1
    machine_h: float = 65.0  # €/h Maschinensatz Plotter (Richtwert 2026-09)
    cut_speed_mm_s: float = 43.0  # mm/s Netto-Vorschub nach Kurven/Anstich/Handling
    pierce_s: float = 2.0  # s Anstechen/Positionieren je Kontur (Routing/Zeitmodell)
    setup_min: float = 8.0  # min Rüsten je Innenauftrag (Zeitmodell, Info)
    handling_min_per_plate: float = 2.0  # min Auflegen/Abräumen je Platte (Zeitmodell)
    # Rüsten als Anteil an (Material + Zuschnitt) — zusätzlich zur festen
    # Einrichtung je Stufe (Betriebsvorgabe „beides", 0,05).
    setup_pct: float = 0.05
    # Feste Einrichtung, 1× je Auftrag:
    # Stufe 1 = Norm (5 €), Stufe 2 = Sondermaß/Löcher (7,50 €),
    # Stufe 3 = Zeichnung/Sonder mit Löchern (15 €). Die Stufe bestimmt die
    # aufwendigste bepreiste Zuschnittposition im Auftrag.
    setup_fix1: float = 5.0
    setup_fix2: float = 7.5
    setup_fix3: float = 15.0
    gap: float = 6.0  # mm Standardabstand zwischen Teilen
    margin: float = 12.0  # mm Randbeschnitt
    waste_min: float = 1.15
    waste_max: float = 1.90
    cert31: float = 45.0  # € Abnahmeprüfzeugnis 3.1
    freight: float = 14.90  # € Versand
    sheet_markup: float = 1.12  # Aufschlag auf Plattenware ab Lager
    vat: float = 0.19
    leftover_threshold: float = 0.25
    vat_rate: Optional[float] = (
        None  # überschreibt vat, wenn der Steuerstatus 0 % ergibt
    )


@dataclass
class Product:
    """Werkstoff, so weit der Kern ihn braucht."""

    id: str
    eur_m2: float
    sheets: list[tuple[float, float]]  # [[w, h], …] in mm
    #: Verkaufspreis je Dicke (VK €/m², Dicke → Preis), wo die Einkaufsliste
    #: ihn nennt. Der Kern nimmt den Preis der bestellten Dicke und fällt
    #: sonst auf ``eur_m2`` zurück (2.10.0-lite, verhaltensgleich zu engine.js).
    eur_m2_thk: Optional[dict] = None
    kerf: Optional[float] = None  # mm, sonst rates.gap
    web: Optional[float] = None  # mm, sonst rates.margin
    name: str = ""
    cnc: str = "check"  # confirmed | likely | check — Shop-Sortiment filtert confirmed
    grain: str = "none"  # "none" | "axis" | "directed"
    flip_ok: bool = True
    edge_margin: Optional[float] = None  # mm, Randbeschnitt
    min_web: Optional[float] = None  # mm, Mindeststeg im Teil
    min_spacing: Optional[float] = None  # mm, Mindestabstand Teil-zu-Teil


@dataclass
class Position:
    """Eine Zuschnittposition im Warenkorb.

    ``cut_len`` ist die exakte Konturlänge in Millimetern aus geometry.js.
    Fehlt sie, greift die Ringformel — genau diese eine Regel unterscheidet
    Engine 2.1.0 von 2.0.0 (CLAUDE.md §5).
    Lite: shape/gross/net tragen echte Kontur (Rect 70% Fix, sonst Scheibe).
    """

    id: int
    od: float  # Außendurchmesser / Umkreis in mm
    di: float = 0.0  # größte konzentrische Bohrung in mm
    q: int = 1
    mat: str = ""
    thk: float = 2.0
    t: str = ""  # Bezeichnung
    bn: int = 0  # Anzahl Schraubenlöcher
    bd: float = 0.0  # Ø Schraubenloch in mm
    bc: float = 0.0  # Lochkreis-Ø in mm
    cut_len: float = 0.0  # mm, 0 = nicht gesetzt
    kind: str = "gasket"
    #: Formfamilie aus dem Konfigurator ("norm", "ring", "rect", "oval",
    #: "dxf", "saved") — bestimmt die Rüststufe der festen Einrichtung
    #: (2.10.0-lite). Leer bei alten Warenkörben: dann entscheidet die Kontur.
    fam: str = ""
    shape: Optional[dict] = None  # GEO shape outer/holes/bolts, None = Ring
    gross: Optional[float] = None  # mm2 Brutto aus GEO.metrics (true area)
    net: Optional[float] = None  # mm2 Netto


@dataclass
class CustomLine:
    id: int
    label: str = ""
    desc: str = ""
    external_note: str = ""
    q: int = 1
    price_gross: float = 0.0
    kind: str = "custom"
    mat: str = ""
    thk: float = 0.0


@dataclass
class SheetLine:
    """Plattenware ab Lager — wird nicht geschachtelt."""

    id: int
    mat: str
    fmt: tuple[float, float]
    q: int = 1
    thk: float = 2.0
    kind: str = "sheet"


@dataclass
class PlacedPart:
    """Ein platziertes Teil auf einer Platte."""

    pos: Position
    od: float
    di: float
    seq: int
    #: Standfläche — was das Teil auf der Platte belegt. Beim Ring gleich dem
    #: Umkreis, bei jeder anderen Kontur ihr achsparalleles Umschließendes.
    #: Bei einer um 90° gedrehten Lage die *gedrehte* Standfläche (Kanten
    #: vertauscht), damit Verdichtung, Umverteilung und Zeichnung mit der
    #: Lage rechnen, die tatsächlich geschnitten wird.
    fw: float = 0.0
    fh: float = 0.0
    cx: float = 0.0
    cy: float = 0.0
    #: Lage des Teils: Drehung in Grad (der Kern vergibt nur 0 und 90 —
    #: exakte Isometrien der Standfläche) und Spiegelung um die eigene
    #: Hochachse. Beides reist bis in Zeichnung und Schnittdatei; dort wird
    #: es angewendet, sonst schneidet die Maschine das Teil falsch herum.
    rot: float = 0.0
    mirror: bool = False
    uid: int = 0
    host_id: Optional[int] = None
    nested: list["PlacedPart"] = field(default_factory=list)


@dataclass
class Sheet:
    """Eine angeschnittene Platte.

    ``top`` = direkt aus der Plattenfläche geschnitten (blau in der Ansicht),
    ``rest`` = aus dem Innenloch eines anderen Teils (grün, kein Materialpreis).
    """

    top: list[PlacedPart] = field(default_factory=list)
    rest: list[PlacedPart] = field(default_factory=list)
    sky: list[dict] = field(default_factory=list)
    used_h: float = 0.0
    #: Nur Top-Teile mit Bohrung, in Einfügereihenfolge — die Kandidaten für
    #: die Restflächen-Schachtelung. Dieselbe Teilfolge wie über ``top``, aber
    #: ohne die Teile dazwischen, die der Suchlauf ohnehin nur überspringt:
    #: der Unterschied zwischen Sekunden und Minuten bei zehntausend Teilen.
    holes: list[PlacedPart] = field(default_factory=list)
    #: Fail-Memo für die Skyline: Schlüssel „bxh" → Version des Profils beim
    #: Scheitern. ``sky_fit`` ist eine Funktion des Profils — unverändertes
    #: Profil heißt dieselbe Antwort, die erneute Suche darf übersprungen
    #: werden. Verändert keine Entscheidung.
    fails: dict = field(default_factory=dict)
    #: Wächst bei jeder erfolgreichen Platzierung und macht damit alle
    #: Fail-Memo-Einträge dieser Platte obsolet.
    ver: int = 0
