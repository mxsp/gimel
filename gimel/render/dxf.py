"""Schnittdateien — DXF aus einer gespeicherten Plattenbelegung.

Das ist CLAUDE.md Phase 3.1: die Schachtelung geht als Zeichnung direkt an
Plotter und Wasserstrahl, statt in der Fertigung von Hand nachgezeichnet zu
werden. Damit schließt sich der Weg vom Kundenauftrag bis zur Maschine.

Drei Gruppen, weil in der Werkstatt drei verschiedene Fragen gestellt werden:

  1. **Vollplatte** — alles, was auf dieser Platte liegt, über alle Kunden
     hinweg. Das ist die Datei, die die Maschine tatsächlich schneidet.
  2. **Je Kunde** — dieselbe Platte, aber nur die Teile eines Kundenauftrags,
     an ihrer echten Position. Zum Sortieren, Prüfen und Verpacken: nach dem
     Schnitt liegen fünfzig Teile auf dem Tisch und müssen wieder auf Aufträge
     verteilt werden.
  3. **Einzelteil** — eine Form für sich, im Nullpunkt. Für Nachschnitt,
     Archiv und für die Rückgabe an den Kunden (Phase 2.3).

Geometrie kommt **immer** aus der gespeicherten Belegung, nie aus einer neuen
Schachtelung. Sonst zeigt die Datei an der Maschine etwas anderes als die
Zeichnung auf dem Papier, sobald der Nester besser wird.

Bewusst handgeschriebenes DXF R12 statt einer Bibliothek: R12 ist das Format,
das jede Steuerung liest, es hat keine Objekt-Handles und keine Klassen, und
die zwölf Entitätstypen, die hier vorkommen, sind in hundert Zeilen erzeugt.
``ezdxf`` gehört auf die Serverseite, wenn *gelesen* wird (Phase 2.1) — beim
Schreiben wäre es eine Abhängigkeit für nichts.
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence

from ..config import ENV_PREFIX

# Ebenen. Getrennt, damit die Steuerung die Marken nicht mitschneidet — eine
# Beschriftung auf derselben Ebene wie die Kontur ist der klassische Weg, eine
# Platte zu ruinieren.
LAYER_OUTER = ENV_PREFIX + "KONTUR"      # Außenkontur — schneiden
LAYER_HOLE = ENV_PREFIX + "LOCH"         # Innenkonturen und Schraubenlöcher — schneiden
LAYER_TAG = ENV_PREFIX + "MARKE"         # Marken — nicht schneiden, nur zur Orientierung
LAYER_SHEET = ENV_PREFIX + "PLATTE"      # Plattenrand und Schnittband — nicht schneiden
LAYER_INFO = ENV_PREFIX + "INFO"         # Kopfzeile — nicht schneiden

# Farbnummern nach AutoCAD-Farbindex (ACI). Rot für Schnitt ist die Konvention,
# die in fast jeder Steuerung voreingestellt ist.
COLOURS = {
    LAYER_OUTER: 1,     # rot
    LAYER_HOLE: 3,      # grün
    LAYER_TAG: 7,       # weiß/schwarz
    LAYER_SHEET: 8,     # grau
    LAYER_INFO: 8,
}

# --------------------------------------------------------------------------
# PlotPro — die Schnittfolge steht in den Ebenen
# --------------------------------------------------------------------------
# Der Werkstattbefund, der PlotPro erklärt (Wortlaut in domain/cutting.py):
# Die Umwandlung einer DXF in die DIE-Datei des Plotters **sieht die ganze
# Auslage als ein Teil** und schneidet von außen nach innen. Auf glattem
# Werkstoff ist das der Schaden: der Vakuumtisch hält über die Fläche, jede
# geschlossene Außenkontur ist ein Leck, und wer außen anfängt, nimmt den
# Halt weg, bevor irgendetwas fertig ist. Runde Dichtungen werden oval.
#
# PlotPro schreibt deshalb in die Datei, was der Plotter sonst selbst raten
# muss, und zwar auf drei Ebenen zugleich — „innen nach außen" heißt jedes
# Mal etwas anderes und muss jedes Mal gelten:
#
#   im Teil      Löcher und Schraubenbild vor der Außenkontur. Die
#                Außenkontur gibt das Teil frei und kommt zuletzt.
#   im Nest      ein Teil in einer Restfläche vor seinem Wirt. Wird zuerst
#                die Bohrung des Wirts geschnitten, liegt der Gast auf einer
#                losen Scheibe — genau der Eierfall.
#   auf der Platte  von der Mitte der Auslage nach außen. Das ist die Ebene,
#                von der der Werkstattbefund wörtlich handelt: die Umwandlung
#                sieht *die Auslage* als ein Teil, und ein Teil schneidet sie
#                von außen nach innen — sie schält die Auslage vom Rand her
#                ab. „Innen nach außen" heißt hier also **plattenweise**: wo
#                ein Teil in der Auslage liegt, entscheidet, wann es
#                drankommt. Nicht, wie groß es ist. Die Größe bleibt der
#                Tie-Break innerhalb eines Rings — der Halt eines Teils ist
#                seine Fläche, also das schwächste zuerst, solange die Platte
#                ringsum noch geschlossen ist.
#
# Die erste Fassung hatte die dritte Ebene als reine Größenregel („klein vor
# groß"). Die Begründung stimmt und ist geblieben, aber sie war an der
# falschen Stelle: sie beantwortet, welches von zwei gleich weit außen
# liegenden Teilen zuerst drankommt, und nicht die Frage, die „innen nach
# außen" stellt. Auf einer Platte mit einem großen Teil in der Mitte und
# kleinen am Rand lief die Folge dadurch genau verkehrt herum — von außen
# nach innen, unter dem Namen der sicheren Folge.
#
# Und es macht **jedes Teil einzeln sichtbar**: eigene Ebenen je Teil, und
# die Entitäten eines Teils stehen zusammenhängend in der Datei. Damit kann
# weder die Umwandlung noch die Steuerung die Auslage wieder zu einem Stück
# verschmelzen.
#
#   inside_out   — die sichere Folge, oben beschrieben. Vorgabe.
#   outside_in   — was die Umwandlung von sich aus tut. Bleibt wählbar, weil
#                  eine geschichtete Datei auch damit mehr sagt als gar
#                  keine; auf glattem Werkstoff steht eine Warnung daneben
#                  (domain/cutting.plan_cut).
#   largest_first / smallest_first — nach Umkreis, ohne Rücksicht auf die
#                  Verschachtelung. Für Werkstoffe, bei denen der Halt
#                  unkritisch ist und die Wegstrecke zählt.
#
# Nur die Vollplatte bekommt die Schichtung — sie ist die Datei, die die
# Maschine schneidet. Je-Kunde- und Einzelteil-Dateien bleiben klassisch.
PLOTPRO_STRATEGIES = ("inside_out", "outside_in", "largest_first", "smallest_first")

#: Die Vorgabe. Bewusst nicht ``outside_in``: das ist der Fehlerfall, nicht
#: eine Einstellung unter mehreren.
PLOTPRO_DEFAULT = "inside_out"

#: Rollen innerhalb eines Teils. Die Ebene trägt beides — die Nummer sagt
#: *wann*, das Kürzel sagt *was*.
ROLE_HOLE = "hole"
ROLE_OUTER = "outer"

#: Das Kürzel im Ebenennamen. Mit Ziffer davor, damit die Ebenen auch dann in
#: Schnittfolge stehen, wenn die Steuerung sie alphabetisch sortiert — und das
#: tun viele.
_ROLE_SUFFIX = {ROLE_HOLE: "1_LOCH", ROLE_OUTER: "2_KONTUR"}

#: Farbe nach Rolle, nicht nach laufender Nummer. Das ist der Unterschied zur
#: ersten Fassung, und er ist kein Schönheitsfehler gewesen: sie legte Loch
#: und Außenkontur eines Teils auf **dieselbe** Ebene, in einem Farbkreis nach
#: laufender Nummer. Damit war die Unterscheidung innen/außen aus der Datei
#: verschwunden — und aus ihr leitet jede Steuerung ab, auf welcher Seite der
#: Kontur sie die Schnittfuge ausgleicht. Innen wie außen zu versetzen macht
#: jedes Teil um eine Fugenbreite falsch, und zwar unauffällig.
_ROLE_COLOUR = {ROLE_HOLE: COLOURS[LAYER_HOLE], ROLE_OUTER: COLOURS[LAYER_OUTER]}


def _plotpro_pad(n_parts: int) -> int:
    """Wie viele Stellen die laufende Nummer braucht.

    Aus der Teilezahl gerechnet und nicht fest verdrahtet. Die erste Fassung
    hatte 64 Ebenen und **klemmte** darüber hinaus alles auf die letzte: eine
    Platte mit hundert DN25 hätte siebenunddreißig Teile in einer einzigen
    Ebene gehabt, ohne Fehler, ohne Hinweis — die Folge wäre stillschweigend
    weg gewesen, und genau die ist hier der Zweck. Mindestens zwei Stellen,
    damit die gewohnte Optik (01, 02, …) bei kleinen Platten bleibt.
    """
    return max(2, len(str(max(1, int(n_parts)))))


def plotpro_layer(idx: int, role: str = ROLE_OUTER, pad: int = 2) -> str:
    """Der Ebenenname für Schnittschritt ``idx`` (1-basiert) und seine Rolle."""
    if role not in _ROLE_SUFFIX:
        raise ValueError(f"Unbekannte Rolle: {role!r}")
    return f"PLOTPRO_{max(1, int(idx)):0{max(2, pad)}d}_{_ROLE_SUFFIX[role]}"


def _true_bore(item: dict) -> float:
    """Die wirkliche Restflächen-Bohrung eines Wirts.

    Ein Norm-Ring ohne ``shape`` trägt seine Bohrung in ``di``. Ein Freiform-
    Teil speichert sie in der Kontur — aber dort setzt sich ``di`` aus dem
    größten Kreis *irgendeines* Lochs zusammen, und Schraubenlöcher auf dem
    Lochkreis können größer wirken als die eigentliche Mittelbohrung. Für den
    Wirt zählt nur die Bohrung, in die ein Gast gelegt werden kann: die des
    größten Lochs, nicht die eines Schraubenlochs.
    """
    shape = item.get("shape") if isinstance(item.get("shape"), dict) else None
    if shape and shape.get("outer"):
        best = 0.0
        for hole in (shape.get("holes") or []):
            d = _geometry_diameter(hole)
            if d > best:
                best = d
        if best > 0:
            return best
    return float(item.get("di") or 0)


def _geometry_diameter(geo: dict) -> float:
    """Der Umkreis-Durchmesser einer Loch-Geometrie (für die Bohrungsgröße)."""
    kind = geo.get("kind")
    if kind == "circle":
        return float(geo.get("d") or 0)
    if kind in ("rect", "oval"):
        w, h = float(geo.get("w") or 0), float(geo.get("h") or 0)
        return (w * w + h * h) ** 0.5
    if kind == "poly" and geo.get("pts"):
        r = max((float(px) ** 2 + float(py) ** 2) ** 0.5 for px, py in geo["pts"])
        return 2 * r
    return 0.0


def _find_host(item: dict, all_items: list[dict]) -> dict | None:
    """Der Wirt, in dessen Restfläche ein Teil liegt.

    Die gespeicherte Belegung kennt den Wirt nicht mehr — der Nester legt nur
    ``from_remnant`` ab (domain/batch.py). Deshalb wird er hier geometrisch
    rekonstruiert: der kleinste Top-Level-Ring, in dessen wirkliche Bohrung
    das Teil um seinen Platz herum hineinpasst. Das ist dieselbe Regel, mit
    der der Nester Restflächen vergibt (§5.1, Schritt 1), nur rückwärts.
    """
    od = float(item.get("od") or 0)
    cx, cy = float(item.get("cx") or 0), float(item.get("cy") or 0)
    best = None
    for other in all_items:
        if other is item or other.get("from_remnant"):
            continue
        bore = _true_bore(other)
        if bore <= od + 1e-6:
            continue
        d = ((float(other.get("cx") or 0) - cx) ** 2
             + (float(other.get("cy") or 0) - cy) ** 2) ** 0.5
        if d + od / 2 <= bore / 2 + 1e-6:
            if best is None or bore < _true_bore(best):
                best = other
    return best


def _nesting_hosts(all_items: list[dict]) -> dict[int, dict | None]:
    """Zu jedem Teil sein Wirt — ``None``, wenn es direkt auf der Platte liegt.

    Eine Stelle, aus der beides folgt: die Tiefe (wie oft ineinander) und die
    Wurzel (welches Teil für dieses hier auf der Platte liegt). Die
    Schnittfolge braucht beide, für verschiedene Fragen — siehe
    ``plotpro_order``.
    """
    return {id(it): (_find_host(it, all_items) if it.get("from_remnant") else None)
            for it in all_items}


def _nesting_depths(all_items: list[dict],
                    hosts: dict[int, dict | None] | None = None) -> dict[int, int]:
    """Die Verschachtelungstiefe jedes Teils, per Identität.

    0 = liegt direkt auf der Platte, 1 = liegt in der Restfläche eines
    Top-Level-Teils, 2 = in dessen Restfläche, und so weiter. Entscheidend
    ist der Wirt, nicht die Geometrie: ein Teil in einer Restfläche muss
    **vor** seinem Wirt geschnitten werden, sonst liegt es auf einer losen
    Scheibe, sobald die Bohrung des Wirts durch ist.
    """
    if hosts is None:
        hosts = _nesting_hosts(all_items)
    depths: dict[int, int] = {}

    def depth_of(it: dict) -> int:
        key = id(it)
        if key in depths:
            return depths[key]
        depths[key] = 0          # Zykluswächter — sollte nie feuern
        host = hosts.get(key)
        d = 0 if host is None else 1 + depth_of(host)
        depths[key] = d
        return d

    for it in all_items:
        depth_of(it)
    return depths


def _nesting_roots(all_items: list[dict],
                   hosts: dict[int, dict | None]) -> dict[int, dict]:
    """Zu jedem Teil das Teil, das für es auf der Platte liegt.

    Ein Gast hat in der Auslage keine eigene Adresse: er liegt in der Bohrung
    seines Wirts, also dort, wo der Wirt liegt. Für die plattenweise Folge
    zählt deshalb die Stelle der Wurzel, und die Verschachtelung wird
    *innerhalb* dieser Stelle aufgelöst. Andernfalls risse die Folge einen
    Gast quer über die Platte von seinem Wirt weg — und die eine Regel, die
    kein Vorzug ist, sondern Geometrie (erst der Gast, dann sein Wirt), wäre
    nur noch zufällig erfüllt.
    """
    roots: dict[int, dict] = {}

    def root_of(it: dict) -> dict:
        key = id(it)
        if key in roots:
            return roots[key]
        roots[key] = it          # Zykluswächter — sollte nie feuern
        host = hosts.get(key)
        roots[key] = it if host is None else root_of(host)
        return roots[key]

    for it in all_items:
        root_of(it)
    return roots


def _layout_rings(all_items: list[dict]) -> dict[int, float]:
    """Wie weit außen jedes Teil in der Auslage liegt: 0 in der Mitte, ~1 am Rand.

    Das ist die Größe, um die es bei „innen nach außen" geht. Der Betreiber
    beschreibt die Umwandlung als eine, die *die Auslage als ein Teil* sieht
    und sie von außen nach innen schneidet — die Folge ist damit eine Aussage
    über die **Platte**: die Auslage wird von der Mitte her aufgerollt oder
    vom Rand her abgeschält.

    Bezug ist die Auslage, nicht die Platte. Die letzte Platte eines
    Sammellaufs ist oft nur halb belegt (CLAUDE.md §5.5, Teilfreigabe); deren
    Plattenmitte liegt im Leeren, und ein Abstand dorthin würde die Teile nach
    einem Punkt sortieren, an dem nichts liegt.

    Normiert wird je Achse auf die halbe Ausdehnung der Auslage, dann
    euklidisch zusammengefasst. Das hat zwei Gründe. Die Ringe folgen dem
    Seitenverhältnis der Auslage — auf einer 3000 × 1000er Platte sind sie
    lang, nicht rund. Und eine einzeilige Auslage bleibt geordnet: dort ist
    der Anteil quer zur Zeile für alle Teile gleich, der Anteil längs
    entscheidet, und die Folge läuft von der Mitte der Zeile nach beiden
    Seiten. Ein Maximum statt der Summe (Chebyshev) würde in genau diesem Fall
    alle Teile der Zeilenmitte gleichsetzen und die Folge dem Tie-Break
    überlassen.
    """
    if not all_items:
        return {}
    xs = [(float(it.get("cx") or 0), float(it.get("od") or 0) / 2) for it in all_items]
    ys = [(float(it.get("cy") or 0), float(it.get("od") or 0) / 2) for it in all_items]
    x_min, x_max = min(c - r for c, r in xs), max(c + r for c, r in xs)
    y_min, y_max = min(c - r for c, r in ys), max(c + r for c, r in ys)
    mid_x, mid_y = (x_min + x_max) / 2, (y_min + y_max) / 2
    half_w, half_h = (x_max - x_min) / 2, (y_max - y_min) / 2

    rings: dict[int, float] = {}
    for it in all_items:
        dx = (float(it.get("cx") or 0) - mid_x) / half_w if half_w > 1e-9 else 0.0
        dy = (float(it.get("cy") or 0) - mid_y) / half_h if half_h > 1e-9 else 0.0
        rings[id(it)] = (dx * dx + dy * dy) ** 0.5
    return rings


def plotpro_order(items: list[dict], strategy: str) -> list[dict]:
    """Die Teile in Schnittfolge — jedes bekommt ``plotpro_idx`` (1-basiert).

    Stabil und deterministisch: gleiche Belegung und gleiche Strategie geben
    bytegleiche Dateien, wie es der Rechenkern verspricht (§5.3, Invariante 5).
    Der Tie-Break ist die Marke, weil sie auf einer Platte eindeutig ist.

    Die Liste wird an Ort und Stelle beschriftet — die Aufrufer geben deshalb
    Kopien herein, nie die gespeicherte Belegung (siehe ``plate_dxf``).
    """
    if strategy not in PLOTPRO_STRATEGIES:
        raise ValueError(f"Unbekannte PlotPro-Strategie: {strategy!r}. "
                         f"Erlaubt: {', '.join(PLOTPRO_STRATEGIES)}")
    items = list(items)
    if strategy in ("outside_in", "inside_out"):
        hosts = _nesting_hosts(items)
        depths = _nesting_depths(items, hosts)
        roots = _nesting_roots(items, hosts)
        rings = _layout_rings(items)

        def place(it: dict) -> float:
            """Wo dieses Teil in der Auslage liegt — für einen Gast dort, wo
            sein Wirt liegt."""
            return rings[id(roots[id(it)])]

        # Drei Schlüssel, in dieser Reihenfolge, und jeder beantwortet eine
        # andere Frage:
        #
        #   1. die Stelle in der Auslage — plattenweise, das ist die Folge
        #      selbst: von der Mitte nach außen, oder vom Rand nach innen.
        #   2. die Verschachtelung, innerhalb dieser Stelle — erst der Gast,
        #      dann sein Wirt. Keine Abwägung, sondern Geometrie: die Bohrung
        #      des Wirts nimmt dem Gast die Auflage weg.
        #   3. die Größe, innerhalb eines Rings — das schwächste Teil zuerst,
        #      solange die Platte ringsum noch geschlossen ist. Der Halt eines
        #      Teils ist seine Fläche, und jede geschlossene Außenkontur ist
        #      eine Fuge, durch die der Tisch Luft zieht.
        #
        # ``outside_in`` ist die Spiegelung in allen dreien, weil es die
        # Umwandlung nachbildet und keine halbe Mischung sein soll.
        if strategy == "inside_out":
            ordered = sorted(items, key=lambda it: (place(it),
                                                    -depths[id(it)],
                                                    float(it.get("od") or 0),
                                                    str(it.get("tag") or "")))
        else:  # outside_in — vom Rand nach innen, Wirt vor Gast, groß vor klein
            ordered = sorted(items, key=lambda it: (-place(it),
                                                    depths[id(it)],
                                                    -float(it.get("od") or 0),
                                                    str(it.get("tag") or "")))
    else:
        if strategy == "largest_first":
            ordered = sorted(items,
                             key=lambda it: (-float(it.get("od") or 0),
                                             str(it.get("tag") or "")))
        else:  # smallest_first
            ordered = sorted(items,
                             key=lambda it: (float(it.get("od") or 0),
                                             str(it.get("tag") or "")))
    for i, it in enumerate(ordered):
        it["plotpro_idx"] = i + 1
    return ordered


#: Wie fein ein Bogen in Strecken zerlegt wird, wenn er keine echte Entität hat
#: (Ovale). 0,05 mm Sehnenfehler — eine Größenordnung unter der
#: Fertigungstoleranz. 0,25 mm läge „unter der Schnittfuge", stünde aber auf
#: dem Maß: bei 420×320 wären das 0,25 mm Durchmesserfehler im Bauteil.
ARC_SAG_MM = 0.05


def _g(code: int, value) -> str:
    """Eine DXF-Gruppe: Code in Zeile eins, Wert in Zeile zwei."""
    if isinstance(value, float):
        return f"{code:>3}\n{value:.4f}\n"
    return f"{code:>3}\n{value}\n"


class DxfWriter:
    """Sammelt Entitäten und schreibt am Ende eine vollständige R12-Datei."""

    def __init__(self, *, ext_min: tuple[float, float] = (0.0, 0.0),
                 ext_max: tuple[float, float] = (1000.0, 1000.0),
                 plotpro: bool = False, plotpro_pad: int = 2) -> None:
        self._out: list[str] = []
        self._ext_min = ext_min
        self._ext_max = ext_max
        self.plotpro = plotpro
        self.plotpro_pad = plotpro_pad
        #: Folge-Ebene → Farbe, in der Reihenfolge, in der sie zuerst benutzt
        #: wurde. Nur die benutzten kommen in die Tabelle: die erste Fassung
        #: meldete vierundsechzig Ebenen an, von denen zwei etwas trugen, und
        #: der Bediener suchte die Folge in einer Liste aus leeren Namen.
        self._pp_layers: dict[str, int] = {}

    def use_plotpro_layer(self, idx: int, role: str) -> str:
        """Ebenenname für einen Schnittschritt, und vormerken zum Anmelden."""
        name = plotpro_layer(idx, role, self.plotpro_pad)
        self._pp_layers.setdefault(name, _ROLE_COLOUR[role])
        return name

    # -- Entitäten ---------------------------------------------------------
    def circle(self, cx: float, cy: float, r: float, layer: str) -> None:
        if r <= 0:
            return
        self._out.append(_g(0, "CIRCLE") + _g(8, layer)
                         + _g(10, float(cx)) + _g(20, float(cy)) + _g(30, 0.0)
                         + _g(40, float(r)))

    def line(self, x1: float, y1: float, x2: float, y2: float, layer: str) -> None:
        self._out.append(_g(0, "LINE") + _g(8, layer)
                         + _g(10, float(x1)) + _g(20, float(y1)) + _g(30, 0.0)
                         + _g(11, float(x2)) + _g(21, float(y2)) + _g(31, 0.0))

    def polyline(self, pts: Sequence[tuple[float, float]], layer: str,
                 closed: bool = True) -> None:
        """POLYLINE / VERTEX / SEQEND — ein zusammenhängender Pfad.

        Bewusst die R12-Form und nicht die kompaktere LWPOLYLINE aus R13+:
        diese Datei sagt im Kopf AC1009, und eine LWPOLYLINE darin ist schlicht
        ungültig — jeder strenge Leser lehnt sie ab, eine alte Steuerung erst
        recht. (Genau daran ist der erste Entwurf gescheitert.)

        Ein Pfad und nicht vierzig einzelne Strecken, weil die Steuerung sonst
        selbst zusammensuchen muss, was zusammengehört, und im Zweifel in der
        falschen Reihenfolge fährt.
        """
        pts = list(pts)
        if len(pts) < 2:
            return
        out = (_g(0, "POLYLINE") + _g(8, layer) + _g(66, 1) + _g(70, 1 if closed else 0)
               + _g(10, 0.0) + _g(20, 0.0) + _g(30, 0.0))
        for x, y in pts:
            out += (_g(0, "VERTEX") + _g(8, layer)
                    + _g(10, float(x)) + _g(20, float(y)) + _g(30, 0.0))
        out += _g(0, "SEQEND") + _g(8, layer)
        self._out.append(out)

    def text(self, x: float, y: float, height: float, value: str, layer: str) -> None:
        self._out.append(_g(0, "TEXT") + _g(8, layer)
                         + _g(10, float(x)) + _g(20, float(y)) + _g(30, 0.0)
                         + _g(40, float(height)) + _g(1, str(value)[:250])
                         + _g(72, 1) + _g(11, float(x)) + _g(21, float(y)) + _g(31, 0.0))

    def rect(self, x: float, y: float, w: float, h: float, layer: str,
             radius: float = 0.0) -> None:
        r = max(0.0, min(float(radius), min(w, h) / 2))
        if r <= 0.01:
            self.polyline([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], layer)
            return
        # Verrundete Ecken als Sehnenzug — R12-Bögen in einer Polylinie
        # bräuchten Bulge-Werte, und die Sehne bleibt weit unter der Schnittfuge.
        pts: list[tuple[float, float]] = []
        corners = [(x + w - r, y + r, -math.pi / 2), (x + w - r, y + h - r, 0.0),
                   (x + r, y + h - r, math.pi / 2), (x + r, y + r, math.pi)]
        steps = _arc_steps(r, math.pi / 2)
        for ccx, ccy, start in corners:
            for k in range(steps + 1):
                a = start + (math.pi / 2) * k / steps
                pts.append((ccx + r * math.cos(a), ccy + r * math.sin(a)))
        self.polyline(pts, layer)

    def ellipse(self, cx: float, cy: float, rx: float, ry: float, layer: str) -> None:
        if rx <= 0 or ry <= 0:
            return
        steps = max(24, _arc_steps(max(rx, ry), 2 * math.pi))
        self.polyline([(cx + rx * math.cos(2 * math.pi * k / steps),
                        cy + ry * math.sin(2 * math.pi * k / steps))
                       for k in range(steps)], layer)

    # -- Datei -------------------------------------------------------------
    def render(self) -> str:
        head = (_g(0, "SECTION") + _g(2, "HEADER")
                + _g(9, "$ACADVER") + _g(1, "AC1009")
                + _g(9, "$INSUNITS") + _g(70, 4)                     # 4 = Millimeter
                + _g(9, "$EXTMIN") + _g(10, self._ext_min[0]) + _g(20, self._ext_min[1])
                + _g(30, 0.0)
                + _g(9, "$EXTMAX") + _g(10, self._ext_max[0]) + _g(20, self._ext_max[1])
                + _g(30, 0.0)
                + _g(0, "ENDSEC"))

        colours = dict(COLOURS)
        colours.update(self._pp_layers)
        layers = _g(0, "SECTION") + _g(2, "TABLES") + _g(0, "TABLE") + _g(2, "LAYER") \
            + _g(70, len(colours))
        for name, colour in colours.items():
            layers += (_g(0, "LAYER") + _g(2, name) + _g(70, 0)
                       + _g(62, colour) + _g(6, "CONTINUOUS"))
        layers += _g(0, "ENDTAB") + _g(0, "ENDSEC")

        body = _g(0, "SECTION") + _g(2, "ENTITIES") + "".join(self._out) + _g(0, "ENDSEC")
        return head + layers + body + _g(0, "EOF")


def _arc_steps(r: float, angle: float) -> int:
    """Wie viele Sehnen ein Bogen braucht, damit der Fehler unter ARC_SAG_MM bleibt."""
    if r <= 0:
        return 2
    per = 2 * math.acos(max(-1.0, min(1.0, 1 - ARC_SAG_MM / r)))
    return max(2, min(720, int(math.ceil(angle / per)) if per > 0 else 16))


# --------------------------------------------------------------------------
# Eine Kontur zeichnen
# --------------------------------------------------------------------------
def _bolt_holes(shape: dict | None) -> list[dict]:
    """Schraubenlöcher aus dem Lochkreis — dieselbe Rechnung wie geometry.js.

    Der Lochkreis wird als *Regel* gespeichert (Anzahl, Durchmesser,
    Teilkreis, Phase) und nicht als Lochliste; wer ihn beim Schreiben der
    Schnittdatei vergisst, liefert eine Dichtung ohne Schraubenlöcher.
    """
    b = (shape or {}).get("bolts") if isinstance(shape, dict) else None
    if not b:
        return []
    n = int(round(float(b.get("n") or 0)))
    d = float(b.get("d") or 0)
    bc = float(b.get("bc") or 0)
    if not (n > 0 and d > 0 and bc > 0):
        return []
    phase = math.radians(float(b.get("phase") or 0))
    return [{"kind": "circle", "d": d,
             "x": math.cos(phase + 2 * math.pi * k / n) * bc / 2,
             "y": math.sin(phase + 2 * math.pi * k / n) * bc / 2}
            for k in range(n)]


def _draw_geometry(w: DxfWriter, geo: dict, cx: float, cy: float, layer: str) -> None:
    """Eine einzelne Form — Außenkontur oder Loch — an ihren Platz zeichnen."""
    kind = geo.get("kind")
    ox, oy = cx + float(geo.get("x") or 0), cy + float(geo.get("y") or 0)
    if kind == "circle":
        w.circle(ox, oy, float(geo.get("d") or 0) / 2, layer)
    elif kind == "rect":
        rw, rh = float(geo.get("w") or 0), float(geo.get("h") or 0)
        if rw > 0 and rh > 0:
            w.rect(ox - rw / 2, oy - rh / 2, rw, rh, layer, float(geo.get("r") or 0))
    elif kind == "oval":
        w.ellipse(ox, oy, float(geo.get("w") or 0) / 2, float(geo.get("h") or 0) / 2, layer)
    elif kind == "poly" and geo.get("pts"):
        w.polyline([(ox + float(px), oy + float(py)) for px, py in geo["pts"]], layer)


def _norm_rot(rot: float) -> float:
    """Drehwinkel auf 0/90/180/270 normieren, wenn er dort liegt (bis auf
    Float-Rauschen) — nur für Vielfache von 90° bleiben Rechteck und Oval als
    eigene Entitäten erhalten, ein freier Winkel wird zum Sehnenzug."""
    r = rot % 360.0
    for q in (0.0, 90.0, 180.0, 270.0):
        if abs(r - q) < 1e-6:
            return q
    return r


def _xf_point(px: float, py: float, cx: float, cy: float,
              rot: float, mirror: bool) -> tuple[float, float]:
    """Lokaler Punkt relativ zum Teilzentrum → Plattenpunkt.

    Erst gespiegelt (x → −x, um die eigene Hochachse), dann gedreht — dieselbe
    Reihenfolge, die ``plate.py`` und ``bs.js`` auf ihre Transform legen: rechts
    in der Liste steht, was zuerst auf den Punkt wirkt."""
    if mirror:
        px = -px
    if rot == 0.0:
        return cx + px, cy + py
    a = math.radians(rot)
    c, s = math.cos(a), math.sin(a)
    return cx + px * c - py * s, cy + px * s + py * c


def _rect_outline(rw: float, rh: float, radius: float) -> list[tuple[float, float]]:
    """Verrundetes Rechteck als lokaler Sehnenzug um den Ursprung — dieselbe
    Zerlegung wie ``DxfWriter.rect``, nur zur Transformation gedacht."""
    r = max(0.0, min(radius, min(rw, rh) / 2))
    if r <= 0.01:
        return [(-rw / 2, -rh / 2), (rw / 2, -rh / 2),
                (rw / 2, rh / 2), (-rw / 2, rh / 2)]
    pts: list[tuple[float, float]] = []
    corners = [(rw / 2 - r, -rh / 2 + r, -math.pi / 2), (rw / 2 - r, rh / 2 - r, 0.0),
               (-rw / 2 + r, rh / 2 - r, math.pi / 2), (-rw / 2 + r, -rh / 2 + r, math.pi)]
    steps = _arc_steps(r, math.pi / 2)
    for ccx, ccy, start in corners:
        for k in range(steps + 1):
            a = start + (math.pi / 2) * k / steps
            pts.append((ccx + r * math.cos(a), ccy + r * math.sin(a)))
    return pts


def _draw_placed_geometry(w: DxfWriter, geo: dict, cx: float, cy: float,
                          layer: str, rot: float, mirror: bool) -> None:
    """Eine Form in der Lage zeichnen, die die Belegung für sie trägt.

    Ohne ``rot`` und ``mirror`` — jede alte Belegung — ruft ``draw_part``
    weiter ``_draw_geometry`` und erzeugt bytegleiche Dateien. Mit Lage gilt:
    Kreise bleiben Kreise, nur ihr Mittelpunkt wandert; Rechteck und Oval
    bleiben bei Vielfachen von 90° dieselbe Form mit vertauschten Kanten (ein
    um die eigene Achse gespiegeltes Rechteck ist sich selbst gleich, deshalb
    wandert nur der Anker); ein freier Winkel wird zum Sehnenzug, weil R12
    weder gedrehte Rechtecke noch gedrehte Ellipsen kennt und eine Sehne unter
    ARC_SAG_MM wie die Form schneidet. Eine Belegung ohne Lageangabe falsch zu
    zeichnen wäre der alte Fehler in neuem Gewand — deshalb der unveränderte
    Regelpfad."""
    kind = geo.get("kind")
    gx, gy = float(geo.get("x") or 0), float(geo.get("y") or 0)
    ax, ay = _xf_point(gx, gy, cx, cy, rot, mirror)
    if kind == "circle":
        w.circle(ax, ay, float(geo.get("d") or 0) / 2, layer)
        return
    quarter = (rot % 180.0) == 90.0
    exact = (rot % 90.0) == 0.0
    if kind == "rect":
        rw, rh = float(geo.get("w") or 0), float(geo.get("h") or 0)
        if rw > 0 and rh > 0:
            if exact:
                if quarter:
                    rw, rh = rh, rw
                w.rect(ax - rw / 2, ay - rh / 2, rw, rh, layer,
                       float(geo.get("r") or 0))
            else:
                w.polyline([(ax + px, ay + py) for px, py in
                            _rect_outline(rw, rh, float(geo.get("r") or 0))], layer)
        return
    if kind == "oval":
        rw, rh = float(geo.get("w") or 0), float(geo.get("h") or 0)
        if rw > 0 and rh > 0:
            if exact:
                if quarter:
                    rw, rh = rh, rw
                w.ellipse(ax, ay, rw / 2, rh / 2, layer)
            else:
                steps = max(24, _arc_steps(max(rw, rh) / 2, 2 * math.pi))
                w.polyline([(ax + px, ay + py) for px, py in
                            ((rw / 2 * math.cos(2 * math.pi * k / steps),
                              rh / 2 * math.sin(2 * math.pi * k / steps))
                             for k in range(steps))], layer)
        return
    if kind == "poly" and geo.get("pts"):
        w.polyline([_xf_point(gx + float(px), gy + float(py), cx, cy, rot, mirror)
                    for px, py in geo["pts"]], layer)


def draw_part(w: DxfWriter, item: dict, cx: float, cy: float, *,
              tag: str = "", tag_height: float = 0.0) -> None:
    """Ein Teil mit Außenkontur, Innenkonturen und Schraubenlöchern.

    Ohne ``shape`` ist es ein Ring aus Außendurchmesser und Bohrung — genau der
    Fall, in dem der Rechenkern auch preislich mit der Ringformel arbeitet
    (CLAUDE.md §5).

    Im PlotPro-Modus (``w.plotpro``) bekommt das Teil **zwei** Ebenen seiner
    Schnittnummer: ``PLOTPRO_07_1_LOCH`` und ``PLOTPRO_07_2_KONTUR``. Beide
    gehören zu Teil sieben — daran erkennt die Steuerung, dass hier ein Teil
    zu Ende ist und das nächste anfängt —, und die Ziffer im Namen hält
    Löcher vor Außenkontur, auch bei einer Steuerung, die Ebenen alphabetisch
    abarbeitet statt in Dateireihenfolge.

    Zwei Ebenen und nicht eine, weil die Rolle in der Datei stehen muss: aus
    innen/außen leitet die Steuerung die Seite ab, auf der sie die Schnittfuge
    ausgleicht. Auf einer gemeinsamen Ebene ist diese Angabe weg und jedes
    Teil wird um eine Fugenbreite falsch.
    """
    plotpro = getattr(w, "plotpro", False)
    shape = item.get("shape") if isinstance(item.get("shape"), dict) else None
    if shape and shape.get("outer"):
        holes = list(shape.get("holes") or []) + _bolt_holes(shape)
        outer = shape["outer"]
    else:
        outer = {"kind": "circle", "d": float(item.get("od") or 0)}
        holes = []
        di = float(item.get("di") or 0)
        if di > 0:
            holes.append({"kind": "circle", "d": di})
        # Schraubenbild eines Normteils, das ohne shape gespeichert wurde.
        bn = int(item.get("bn") or 0)
        bd = float(item.get("bd") or 0)
        bc = float(item.get("bc") or 0)
        if bn > 0 and bd > 0 and bc > 0:
            for k in range(bn):
                a = 2 * math.pi * k / bn
                holes.append({"kind": "circle", "d": bd,
                              "x": math.cos(a) * bc / 2, "y": math.sin(a) * bc / 2})

    # Die Lage reist auf dem platzierten Teil (rot in Grad, mirror um die
    # eigene Hochachse) — hier wird sie Wirklichkeit. Ohne Lageangabe bleibt
    # alles wie zuvor, bytegleich; mit Lage geht sie in jede Geometrie hinein,
    # Löcher und Schraubenbild eingeschlossen. Eine gedreht abgelegte Dichtung
    # ungedreht zu zeichnen schneidet sie in die falsche Form — Ausschuss, der
    # richtig aussieht.
    rot = _norm_rot(float(item.get("rot") or item.get("angle_deg")
                          or item.get("rotation_deg") or 0.0))
    mirror = bool(item.get("mirror"))
    transformed = abs(rot) > 1e-9 or mirror

    def emit(geo: dict, layer: str) -> None:
        if transformed:
            _draw_placed_geometry(w, geo, cx, cy, layer, rot, mirror)
        else:
            _draw_geometry(w, geo, cx, cy, layer)

    if plotpro:
        # Innen vor außen, auch in der Dateireihenfolge — für Leser, die nicht
        # nach Ebenen fahren. Die Außenkontur gibt das Teil frei und kommt
        # zuletzt. Die Ebenen werden in derselben Reihenfolge angefordert,
        # damit die Ebenentabelle die Schnittfolge von oben nach unten liest,
        # und erst dann, wenn feststeht, was das Teil hat: ein Teil ohne Loch
        # meldet keine leere Lochebene an.
        idx = int(item.get("plotpro_idx") or 1)
        if holes:
            hole_layer = w.use_plotpro_layer(idx, ROLE_HOLE)
            for hole in holes:
                emit(hole, hole_layer)
        emit(outer, w.use_plotpro_layer(idx, ROLE_OUTER))
    else:
        emit(outer, LAYER_OUTER)
        for hole in holes:
            emit(hole, LAYER_HOLE)

    if tag:
        h = tag_height or max(4.0, float(item.get("od") or 40) * 0.12)
        w.text(cx, cy - h / 2, h, tag, LAYER_TAG)


# --------------------------------------------------------------------------
# Die drei Dateigruppen
# --------------------------------------------------------------------------
def plate_dxf(fmt: Sequence[float], placements: Iterable[dict], *,
              header: str = "", used_h: float | None = None,
              turned: bool = False,
              only_order: str | None = None,
              plotpro_strategy: str | None = None) -> str:
    """Eine Platte als Schnittdatei.

    ``only_order`` blendet alles aus, was einem anderen Kundenauftrag gehört —
    daraus entsteht Gruppe 2. Die Teile behalten dabei ihre Position auf der
    Platte: nur so lässt sich die Datei gegen die geschnittene Platte legen.

    Mit ``plotpro_strategy`` wird die Datei geschichtet: jedes Teil liegt mit
    seiner ganzen Kontur auf einer nummerierten Ebene, und die Steuerung fährt
    die Ebenen der Nummer nach ab. Die Strategie (siehe ``PLOTPRO_STRATEGIES``)
    sagt, welches Teil zuerst drankommt. Ohne Strategie bleibt es die klassische
    Zweiebenen-Datei (Kontur/Loch).

    ``turned``: die Platte wurde gedreht verbaut (GRE) — das Schnittband läuft
    über die Breite, die Hochwassermarke steht senkrecht.
    """
    W, H = float(fmt[0]), float(fmt[1])
    # Flache Kopien, nie die übergebenen Sätze selbst. ``plotpro_order``
    # schreibt ``plotpro_idx`` in jedes Teil, und die Aufrufer reichen hier
    # ``WorkPlate.placements`` herein — eine JSON-Spalte, also genau das
    # Objekt, das die Sitzung später zurückschreiben könnte. Eine Nummer aus
    # einem Download hat in der gespeicherten Belegung nichts verloren.
    items = [dict(it) for it in placements]
    plotpro = plotpro_strategy is not None
    pad = 2
    if plotpro:
        # Nur die Maschinen-Datei (Gruppe 1) wird geschichtet. Die Strategie
        # läuft über die *ganze* Platte, auch wenn eine Kundendatei gefiltert
        # wird — die Folge ist eine Eigenschaft der Platte, nicht des Filters.
        plotpro_order(items, plotpro_strategy)
        pad = _plotpro_pad(len(items))
    w = DxfWriter(ext_min=(0.0, 0.0), ext_max=(W, H), plotpro=plotpro,
                  plotpro_pad=pad)

    # Plattenrand und Schnittband — Orientierung, nicht Kontur. Eigene Ebene,
    # damit die Steuerung sie stillegen kann.
    w.polyline([(0, 0), (W, 0), (W, H), (0, H)], LAYER_SHEET)
    if used_h and 0 < used_h < (W if turned else H):
        if turned:
            w.line(used_h, 0, used_h, H, LAYER_SHEET)
        else:
            w.line(0, used_h, W, used_h, LAYER_SHEET)

    if header:
        w.text(W / 2, H + 12, 10.0, header, LAYER_INFO)

    drawable = [it for it in items
                if not (only_order and it.get("order_no") != only_order)]
    if plotpro:
        # In Schnittfolge schreiben — auch für Leser, die nicht nach Ebenen,
        # sondern in Dateireihenfolge fahren.
        drawable = sorted(drawable, key=lambda it: int(it.get("plotpro_idx") or 0))
    for item in drawable:
        draw_part(w, item, float(item["cx"]), float(item["cy"]), tag=item.get("tag", ""))
    return w.render()


def part_dxf(item: dict, *, header: str = "") -> str:
    """Ein einzelnes Teil im Nullpunkt — ohne Marke, ohne Plattenrand.

    Keine Marke, weil diese Datei nicht auf einer bestimmten Platte liegt: sie
    ist die Form selbst, für Nachschnitt und Archiv.
    """
    od = float(item.get("od") or 0)
    r = od / 2 or 100.0
    w = DxfWriter(ext_min=(-r, -r), ext_max=(r, r))
    if header:
        w.text(0, r + 12, 8.0, header, LAYER_INFO)
    draw_part(w, item, 0.0, 0.0)
    return w.render()
