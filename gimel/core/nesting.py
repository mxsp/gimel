"""Schachtelung — Portierung von nest()/nestBest()/nestFor() aus engine.js.

Verhaltensgleich zu ENGINE_VERSION 2.11.0-lite (vorher 2.10.0-lite). Die Reihenfolge der
Vergleiche, die Epsilon-Toleranzen und die Sortierschlüssel sind absichtlich
wörtlich übernommen: Determinismus (Invariante 5) hängt daran, und ein Angebot
darf nach dem Port nicht anders ausfallen als vorher. Siehe CLAUDE.md §5.1.

WELCHE SCHACHTELUNG IST DAS? Die 2.9.0-lite — Skyline auf der *Standfläche*
+ Hex + echte Fläche + Eckverdichtung, Suchbudget in Arbeitseinheiten, Eckschranke
(kein Hüllkreis mehr, Rect 70% Fix), der Großauftragsmodus:
ab LARGE_PARTS ein Kandidat ohne Nachpässe und höchstens zwei Formate in
nest_best(), ab LARGE_NO_HOLES keine Restflächen-Schachtelung — plus zwei
entscheidungsgleiche Beschleunigungen (Lochwirt-Liste, Skyline-Fail-Memo),
die kleine Körbe byteidentisch lassen — und seit 2.9.0 die Drehungs- und
Spiegeloption: jede Lage darf (Bedienervorgabe ∩ Werkstoffrichtung
``product.grain`` vorausgesetzt) auch um exakt 90° gedreht abgelegt werden,
jede Platzierung trägt ``rot``/``mirror`` bis in Zeichnung und Schnittdatei.
Nur 90°-Schritte: exakte Isometrien der Standfläche, keine Trigonometrie im
Preisweg, in beiden Kernen bytegleich fällbar. Zwilling von
``assets/engine.js``. (lite, per keystroke, cached). Der bessere Rechenkern
liegt in ``gre_foundation/gre/nesting/`` (5.1.0: exakte Geometrie, freie
Drehung, NFP, rekursive Restflächen, beam, Synthese) und ist über
``pricing_gre.py`` als lite (quote) und heavy (yard) verfügbar. Vor einer
Verbesserung docs/NESTING-ALGORITHM.md §1 lesen.
"""

from __future__ import annotations

import json
import math
import time
from collections import OrderedDict
from typing import Optional

from .types import PlacedPart, Position, Product, Rates, Sheet

ENGINE_VERSION = "2.11.0-lite"
EPS = 1e-7

# --------------------------------------------------------------------------
# Schachtelungsrichtlinie — Zwilling von NEST_POLICY_DEFAULT in engine.js.
#
# ``max_candidates`` ist das Budget, und es zählt *bewertete Layouts*, keine
# Sekunden: docs/NESTING-ALGORITHM.md §10 verlangt ein Budget in
# reproduzierbaren Arbeitseinheiten, weil derselbe Warenkorb auf einer
# schnelleren Maschine sonst anders ausfällt und ein festgeschriebenes Angebot
# damit zur Lüge wird.
#
# ``max_ms`` ist die Wanduhr-Notbremse, nicht das Budget. Im Preisweg aus
# (``None``); sie gehört der Fertigung, wo ein Plan fertig werden muss und
# niemand daraus einen Preis ableitet. Greift sie, trägt das Ergebnis
# ``exhausted=False`` — und das wird gemeldet, nicht verschluckt.
#
# ``corner_max_dist`` ist die Eckschranke als echte Platzierungsbedingung.
# Bisher prüfte ``validate_corner_distance`` gegen eine *gedachte* größte
# Platte statt gegen die wirkliche Lage (docs/NESTING-ALGORITHM.md §5.1).
# --------------------------------------------------------------------------
NEST_POLICY_DEFAULT = {
    "max_candidates": 5,
    "max_ms": None,
    "corner_max_dist": None,
    "compact": True,
    "repack": True,
    "allow_rotation": True,
    "allow_mirror": True,
}

# Oberhalb dieser Teilezahl wird nicht mehr umverteilt: der Versuch ist kubisch
# in der Belegung einer Platte und kostet bei großen Körben mehr, als die
# eingesparte Platte wert ist. Bewusst eine Zahl und keine Zeitmessung — eine
# Zeitmessung wäre wieder die Wanduhr im Preis.
REPACK_MAX_PARTS = 160

# Große Aufträge — ab welcher Teilezahl der Kern sich einschränkt, damit ein
# Zehntausende-Teile-Eimer nicht minutenlang rechnet. Identische Zahlen und
# identische Regeln wie im JS-Kern (assets/engine.js) — die Parität der beiden
# Kerne gilt auch im großen Maßstab.
#   > LARGE_PARTS    — ein einziger Kandidat, keine Nachpässe, und nest_best()
#                      prüft höchstens zwei Formate.
#   > LARGE_NO_HOLES — keine Restflächen-Schachtelung mehr; der Lochwirt-
#                      Suchlauf dominiert dort die Laufzeit.
# Kleinere Körbe rechnen exakt wie zuvor — byteidentisch.
LARGE_PARTS = 1500
LARGE_NO_HOLES = 4000

STRATEGIES = ("cavity_first", "standard", "hex", "area_desc", "grouped_by_size")


def _pick(src: dict, *names):
    for n in names:
        if n in src and src[n] is not None:
            return src[n]
    return None


def resolve_policy(rates: Rates, override: Optional[dict] = None) -> dict:
    src = override if override is not None else (getattr(rates, "nest", None) or {})
    if not isinstance(src, dict):
        src = {}

    def positive(v):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return f if f > 0 else None

    def whole(v, lo: int = 1):
        try:
            i = int(float(v))
        except (TypeError, ValueError):
            return None
        return i if i >= lo else None

    def flag(v):
        if v is None:
            return None
        if isinstance(v, str):
            return v.strip().lower() in ("1", "true", "yes", "ja")
        return bool(v)

    raw = _pick(src, "max_candidates", "maxCandidates")
    try:
        n = int(_js_round(float(raw))) if raw is not None else None
    except (TypeError, ValueError):
        n = None
    compact = _pick(src, "compact")
    allow_rotation = _pick(src, "allow_rotation", "allowRotation")
    allow_mirror = _pick(src, "allow_mirror", "allowMirror")
    gravity = _pick(src, "kerf_gravity", "kerfGravity")
    gravity = str(gravity).strip().lower() if gravity is not None else None
    if gravity not in ("top", "left"):
        gravity = None
    return {
        "max_candidates": min(len(STRATEGIES), n)
        if (n is not None and n >= 1)
        else NEST_POLICY_DEFAULT["max_candidates"],
        "max_ms": positive(_pick(src, "max_ms", "maxMs")),
        "corner_max_dist": positive(_pick(src, "corner_max_dist", "cornerMaxDist")),
        "compact": True if compact is None else bool(compact),
        "repack": True if _pick(src, "repack") is None else bool(_pick(src, "repack")),
        "allow_rotation": True if allow_rotation is None else bool(flag(allow_rotation)),
        "allow_mirror": True if allow_mirror is None else bool(flag(allow_mirror)),
        # Kerf-Feinschliff. Unbekannte oder unplausible Werte fallen auf die
        # Vorgabe des Kerns zurück, statt einen Lauf mit Unsinn zu starten.
        "kerf_steps": whole(_pick(src, "kerf_steps", "kerfSteps")),
        "kerf_stall": whole(_pick(src, "kerf_stall", "kerfStall"), 0),
        "kerf_cell": positive(_pick(src, "kerf_cell", "kerfCell")),
        "kerf_gravity": gravity,
        "kerf_seed": whole(_pick(src, "kerf_seed", "kerfSeed")),
        "kerf_refine": flag(_pick(src, "kerf_refine", "kerfRefine")),
    }


def _orientation_policy(product: Product, policy: dict) -> dict:
    """Dreh- und Spiegelfähigkeit eines Werkstoffs — Zwilling von
    ``orientationPolicy`` in engine.js.

    Zwei Schranken stehen zwischen einem Teil und seiner gedrehten Lage, und
    beide müssen passen: die Bedienervorgabe (``allow_rotation``/
    ``allow_mirror``) und die Werkstoffrichtung ``product.grain``. Eine
    gedrehte Lage auf gerichtetem Werkstoff ist kein Verschnitt, sondern
    Ausschuss, der richtig *aussieht* — deshalb ist die Werkstoffrichtung
    restriktiver als jede Vorgabe:

      none     — Drehung frei, Spiegelung frei (``flip_ok`` vorausgesetzt)
      axis     — {0°, 180°}: dieselbe Standfläche, für die Skyline also
                 nichts zu entscheiden; die 90°-Lage bleibt zu
      directed — nur 0°, keine Spiegelung

    Die Spiegelung ändert niemals die Standfläche — ein gespiegeltes Teil
    belegt exakt dieselbe Kiste. In dieser Skyline kann der Kern eine
    Spiegelung also nirgends *gewinnen*, und er wählt sie nie; die Fähigkeit
    samt Sperre reist auf jedem platzierten Teil mit (``mirror``), damit
    Zeichnung und Schnittdatei sie anwenden können, sobald eine Lage sie
    trägt.
    """
    grain = product.grain or "none"
    return {
        "rot90": bool(policy["allow_rotation"]) and grain == "none",
        "mirror": bool(policy["allow_mirror"]) and grain != "directed"
        and product.flip_ok is not False,
    }


def _js_round(v: float) -> float:
    """``Math.round`` von JavaScript, nicht Pythons ``round``.

    JS rundet die halbe Stelle immer nach +∞, Python kaufmännisch zur geraden
    Zahl: ``Math.round(0.5)`` ist 1, ``round(0.5)`` ist 0. Bei Durchmesser 25
    oder 75 trifft die 50-mm-Bandgrenze genau die Hälfte — dort liefen die
    beiden Kerne sonst auseinander, und der Paritätstest ist die teuerste
    Zusage im Haus.
    """
    return math.floor(v + 0.5)


def round6(v: float) -> float:
    """Auf sechs Nachkommastellen (docs/NESTING-ALGORITHM.md §10, §6.6)."""
    return _js_round(v * 1e6) / 1e6


def footprint(pos: Position) -> tuple[float, float]:
    """Was das Teil auf der Platte *belegt* — nicht, was es umschreibt.

    Bis 2.6.0 belegte jedes Teil sein Hüllquadrat mit der Kantenlänge des
    Umkreisdurchmessers. Für einen Ring ist das exakt; für alles andere grob
    falsch, und zwar in zwei Richtungen:

      * Ein Streifen 600 × 80 hat einen Umkreis von 605 mm. Er belegte damit
        das Sechsfache seiner Fläche, und auf eine 1500 × 1000er Platte gingen
        zwei statt zweiundzwanzig.
      * Ein Streifen 1200 × 120 hat einen Umkreis von 1206 mm und galt auf
        derselben Platte als **übergroß** — obwohl er längs bequem daraufliegt.
        Er wurde zur Technik geleitet statt geschachtelt: keine Vorsicht,
        sondern eine grundlose Absage.

    Ohne ``shape`` bleibt es das Hüllquadrat — Ringe und Normteile rechnen auf
    die letzte Stelle wie bisher.

    **Drehung nur in 90°-Schritten.** Ein 90°-gedrehtes Teil belegt dasselbe
    Umschließende mit vertauschten Kanten — eine exakte Isometrie, ohne
    Trigonometrie, in beiden Kernen bytegleich fällbar. Ein freier Winkel
    würde ein gröberes Umschließendes beanspruchen und müsste bis in die
    Schnittdatei durchgereicht werden; das ist die Kontur-Schachtelung von
    5.x, nicht hier. Die Lage selbst reist als ``rot`` auf dem platzierten
    Teil — Plattenzeichnung (render/plate.py) und Schnittdatei
    (render/dxf.py) wenden sie an, sonst schneidet die Maschine das Teil in
    der falschen Lage.
    """
    od = float(pos.od or 0)
    shape = getattr(pos, "shape", None)
    outer = shape.get("outer") if isinstance(shape, dict) else None
    if not isinstance(outer, dict):
        return od, od
    kind = outer.get("kind")
    if kind in ("rect", "oval"):
        w = float(outer.get("w") or 0)
        h = float(outer.get("h") or 0)
        if w > 0 and h > 0:
            return w, h
        return od, od
    if kind == "poly" and outer.get("pts"):
        pts = outer["pts"]
        xs = [float(q[0]) for q in pts]
        ys = [float(q[1]) for q in pts]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if w > 0 and h > 0:
            return w, h
    return od, od


def is_round(part: PlacedPart) -> bool:
    """Rund im Sinne der Schachtelung: Standfläche ist das Hüllquadrat des
    Umkreises. Nur zwischen zwei solchen Teilen darf der engere Kreisabstand
    gelten — bei allem anderen wäre er eine Kollision."""
    return abs(part.fw - part.od) < EPS and abs(part.fh - part.od) < EPS


def corner_sq(cx: float, cy: float, hw: float, hh: Optional[float] = None) -> float:
    """Quadrierter Abstand der äußeren Teilecke von der Nullecke.

    Quadriert und nicht über ``hypot``: ``Math.hypot`` und ``math.hypot``
    dürfen sich in der letzten Stelle unterscheiden, und an einer Schranke
    kippt daraus ein anderes Layout. Multiplizieren und Addieren tun beide
    Kerne gleich.
    """
    x, y = cx + hw, cy + (hw if hh is None else hh)
    return x * x + y * y


# --------------------------------------------------------------------------
# Skyline-Packung (bottom-left)
# --------------------------------------------------------------------------
def sky_fit(
    sky: list[dict],
    w: float,
    h: float,
    W: float,
    H: float,
    margin: float,
    corner_max2: Optional[float] = None,
    span_w: Optional[float] = None,
    span_h: Optional[float] = None,
) -> Optional[dict]:
    """``corner_max2`` (quadriert) und ``span`` sind nachgestellt und optional:
    ohne sie verhält sich die Funktion wie zuvor. Mit ihnen fällt eine Lage aus,
    deren äußere Teilecke weiter als erlaubt von der Nullecke liegt — die
    nächstbeste rückt nach, statt dass die Schranke hinterher auffällt."""
    best = None
    for i in range(len(sky)):
        x = sky[i]["x"]
        if x + w > W - margin + EPS:
            continue
        y, rest, j = 0.0, w, i
        while rest > 0 and j < len(sky):
            y = max(y, sky[j]["y"])
            rest -= sky[j]["w"]
            j += 1
        if rest > 0 or y + h > H - margin + EPS:
            continue
        if corner_max2 is not None:
            ex = x + (w if span_w is None else span_w)
            ey = y + ((h if span_w is None else span_w) if span_h is None else span_h)
            if ex * ex + ey * ey > corner_max2 + EPS:
                continue
        if best is None or y < best["y"] or (y == best["y"] and x < best["x"]):
            best = {"x": x, "y": y, "i": i}
    return best


def sky_add(sky: list[dict], pos: dict, w: float, h: float) -> None:
    sky.insert(pos["i"], {"x": pos["x"], "y": pos["y"] + h, "w": w})
    i = pos["i"] + 1
    while i < len(sky):
        p, c = sky[i - 1], sky[i]
        if c["x"] < p["x"] + p["w"]:
            cut = p["x"] + p["w"] - c["x"]
            c["x"] += cut
            c["w"] -= cut
            if c["w"] <= 0:
                sky.pop(i)
                continue
            break
        break
    i = 0
    while i < len(sky) - 1:
        if abs(sky[i]["y"] - sky[i + 1]["y"]) < EPS:
            sky[i]["w"] += sky[i + 1]["w"]
            sky.pop(i + 1)
            continue  # dieselbe Stelle erneut prüfen (JS: i-- gefolgt von i++)
        i += 1


# --------------------------------------------------------------------------
# Restflächen-Schachtelung: ein Teil in das Innenloch eines anderen legen.
# Hier liegt die Marge — eine DN300 lässt eine 325-mm-Scheibe Abfall, in der
# DN25er kostenlos wohnen (CLAUDE.md §5.1).
# --------------------------------------------------------------------------
def _try_fit_in_hole(
    sh: Sheet, part: PlacedPart, gap: float, margin: float, W: float, H: float
) -> bool:
    r = part.od / 2
    # Nur Wirte mit Bohrung, in Einfügereihenfolge — dieselbe Teilfolge wie
    # über sh.top, aber ohne die Teile dazwischen, die hier ohnehin nur
    # per continue übersprungen wurden.
    for host in sh.holes:
        if not host.di or host.di < part.od + 2 * gap - EPS:
            continue
        host_hole_r = host.di / 2 - gap
        if host_hole_r < r - EPS:
            continue

        # 1. Zentrisch, solange das Loch noch leer ist
        if not host.nested:
            cx, cy = host.cx, host.cy
            if (
                cx - r >= margin - EPS
                and cx + r <= W - margin + EPS
                and cy - r >= margin - EPS
                and cy + r <= H - margin + EPS
            ):
                placed = _copy_part(part, cx=cx, cy=cy, host_id=host.uid)
                sh.rest.append(placed)
                host.nested.append(placed)
                return True

        # 2. Mehrfachbelegung großer Innenlöcher
        max_off = host_hole_r - r
        if max_off >= gap:
            offsets = [
                (host.cx - max_off * 0.7, host.cy - max_off * 0.7),
                (host.cx + max_off * 0.7, host.cy - max_off * 0.7),
                (host.cx - max_off * 0.7, host.cy + max_off * 0.7),
                (host.cx + max_off * 0.7, host.cy + max_off * 0.7),
                (host.cx, host.cy - max_off),
                (host.cx, host.cy + max_off),
                (host.cx - max_off, host.cy),
                (host.cx + max_off, host.cy),
            ]
            for px, py in offsets:
                # Die Bohrung trägt nur bis auf den Spalt an die Wand heran —
                # sonst schneidet der zweite Schnitt in den ersten. Wie im
                # JS-Zwilling gegen host_hole_r (= di/2 − gap), nicht di/2.
                if math.hypot(px - host.cx, py - host.cy) + r > host_hole_r + EPS:
                    continue
                if (
                    px - r < margin - EPS
                    or px + r > W - margin + EPS
                    or py - r < margin - EPS
                    or py + r > H - margin + EPS
                ):
                    continue
                coll = False
                for ex in host.nested:
                    if (
                        math.hypot(px - ex.cx, py - ex.cy) + EPS
                        < (part.od + ex.od) / 2 + gap
                    ):
                        coll = True
                        break
                if not coll:
                    placed = _copy_part(part, cx=px, cy=py, host_id=host.uid)
                    sh.rest.append(placed)
                    host.nested.append(placed)
                    return True
    return False


def _copy_part(p: PlacedPart, **over) -> PlacedPart:
    # Jede Lage bekommt ihre EIGENE Gästeliste — wie im JS-Zwilling, wo die
    # erste Belegung per `host.nested ??= []` auf der Kopie entsteht und nie
    # auf der Vorlage. Die zuvor geteilte Liste ließ Gäste eines
    # Strategielaufs in die Schachtel der nachfolgenden Läufe wandern: ab dem
    # zweiten Lauf fand kein Wirt mehr ein leeres Loch, die zentrische
    # Einzelbelegung fiel aus, und der Läufervergleich wählte ein Layout, das
    # der JS-Kern nie baut (Parität!). Verwendet wird `nested` aus `over` nur,
    # wo ein Aufrufer es ausdrücklich mitgibt — derzeit keiner.
    nested = list(over["nested"]) if "nested" in over else []
    return PlacedPart(
        pos=p.pos,
        od=p.od,
        di=p.di,
        seq=p.seq,
        fw=over.get("fw", p.fw),
        fh=over.get("fh", p.fh),
        cx=over.get("cx", p.cx),
        cy=over.get("cy", p.cy),
        rot=over.get("rot", p.rot),
        mirror=over.get("mirror", p.mirror),
        uid=over.get("uid", p.uid),
        host_id=over.get("host_id", p.host_id),
        nested=nested,
    )


# --------------------------------------------------------------------------
# Hex-Gitter für gleiche Durchmesser — 20 statt 16 auf 1000×1000 (ARCHITECTURE.md)
# --------------------------------------------------------------------------
def _try_hex_pack(
    parts: list[PlacedPart],
    W: float,
    H: float,
    margin: float,
    gap: float,
    corner_max2: Optional[float] = None,
):
    if not parts:
        return None
    od0 = parts[0].od
    # Das Hexgitter setzt Kreise gleichen Durchmessers voraus. Eine
    # unsymmetrische Standfläche in dieses Raster zu legen hieße, sie als Kreis
    # zu behandeln — genau der Fehler, den diese Fassung abstellt.
    if any(abs(p.od - od0) > 1e-6 or not is_round(p) for p in parts):
        return None
    pitch = od0 + gap
    row_h = pitch * math.sqrt(3) / 2
    avail_w = W - 2 * margin
    avail_h = H - 2 * margin
    if od0 > avail_w + EPS or od0 > avail_h + EPS:
        return None
    sheets: list[Sheet] = []
    host_uid = [1]
    idx = 0
    while idx < len(parts):
        sh = Sheet(sky=[{"x": margin, "w": avail_w, "y": margin}])
        sheets.append(sh)
        row = 0
        y = margin + od0 / 2
        while y + od0 / 2 <= H - margin + EPS and idx < len(parts):
            offset = (row % 2) * (pitch / 2)
            cols = int(math.floor((avail_w - offset + EPS) / pitch))
            for c in range(cols):
                if idx >= len(parts):
                    break
                x = margin + od0 / 2 + offset + c * pitch
                sh.top.append(_copy_part(parts[idx], cx=x, cy=y, uid=host_uid[0]))
                host_uid[0] += 1
                idx += 1
            row += 1
            y = margin + od0 / 2 + row * row_h
        if not sh.top:
            sheets.pop()
            break
    if idx < len(parts):
        return None
    # Das Hexgitter legt fest ab und kennt keine Ausweichlage. Verletzt es die
    # Eckschranke, ist diese Strategie für den Fall nicht zuständig — dann
    # packt die Skyline, die ausweichen kann.
    if corner_max2 is not None:
        for sh in sheets:
            for p in sh.top:
                if corner_sq(p.cx, p.cy, p.fw / 2, p.fh / 2) > corner_max2 + EPS:
                    return None
    for sh in sheets:
        max_top = margin
        for p in list(sh.top) + list(sh.rest):
            if p.cy + p.od / 2 > max_top:
                max_top = p.cy + p.od / 2
        sky_max = max((n["y"] for n in sh.sky), default=margin) if sh.sky else max_top
        sh.used_h = min(max(max_top + margin, sky_max), H)
    return {"sheets": sheets, "over": []}


# --------------------------------------------------------------------------
# Ein Packungslauf mit einer Heuristik
# --------------------------------------------------------------------------
def _execute_pass(
    parts: list[PlacedPart],
    W: float,
    H: float,
    margin: float,
    gap: float,
    strategy: str,
    corner_max2: Optional[float] = None,
    skip_holes: bool = False,
    orient: Optional[dict] = None,
) -> dict:
    if orient is None:
        orient = {"rot90": False, "mirror": False}
    if strategy == "hex":
        hex_res = _try_hex_pack(parts, W, H, margin, gap, corner_max2)
        if hex_res is not None:
            return hex_res
    if strategy == "cavity_first":
        # Lochwirte zuerst. docs/NESTING-ALGORITHM.md §9.8: diese Ordnung
        # verkehrt herum zu fahren ist der teuerste Sortierfehler hier — wer
        # die Wirte zuletzt legt, hat keine Löcher mehr zu füllen.
        ordered = sorted(parts, key=lambda p: (-p.di, -p.od, p.pos.id, p.seq))
    elif strategy == "hex":
        ordered = sorted(parts, key=lambda p: (p.od, p.pos.id, p.seq))
    elif strategy == "area_desc":
        # Nach wirklicher Ringfläche statt nach Außendurchmesser: ein großer
        # dünner Ring braucht wenig Material und viel Platz, ein kleiner
        # voller Kreis umgekehrt.
        ordered = sorted(
            parts, key=lambda p: (-(p.od * p.od - p.di * p.di), -p.od, p.pos.id, p.seq)
        )
    elif strategy == "grouped_by_size":
        # In 50-mm-Bändern gruppiert, Bänder von groß nach klein: gleich große
        # Teile landen in einer Reihe, und eine Reihe gleicher Höhe lässt die
        # Skyline flach. Zerklüftet wird sie erst durch Mischgrößen.
        ordered = sorted(
            parts, key=lambda p: (-_js_round(p.od / 50), -p.di, -p.od, p.pos.id, p.seq)
        )
    else:
        ordered = sorted(parts, key=lambda p: (-p.od, p.pos.id, p.seq))

    sheets: list[Sheet] = []
    host_uid = [1]

    def fresh() -> Sheet:
        s = Sheet(sky=[{"x": margin, "w": W - 2 * margin, "y": margin}])
        sheets.append(s)
        return s

    fresh()
    over: list[Position] = []

    for part in ordered:
        done = False

        # 1) In eine bestehende Restfläche
        if not skip_holes:
            for sh in sheets:
                if _try_fit_in_hole(sh, part, gap, margin, W, H):
                    done = True
                    break
            if done:
                continue

        # 2) Übergröße — an der Standfläche, nicht am Umkreis. Ein Streifen
        #    1200 × 120 liegt längs auf einer 1500er Platte; sein Umkreis von
        #    1206 mm hat ihn früher grundlos zur Technik geschickt. Mit
        #    Drehung zählt auch die gedrehte Lage: über ist ein Teil erst,
        #    wenn es in *keiner* erlaubten Lage auf die Platte passt.
        def fits_here(w: float, h: float) -> bool:
            return w <= W - 2 * margin + EPS and h <= H - 2 * margin + EPS

        can_turn = orient["rot90"] and part.fw != part.fh
        if not fits_here(part.fw, part.fh) and not (
            can_turn and fits_here(part.fh, part.fw)
        ):
            if not any(o is part.pos for o in over):
                over.append(part.pos)
            continue

        # 3) Skyline-Packung auf der Standfläche — in der besten erlaubten
        #    Lage. Pro Platte werden beide Lagen geprüft; die gedrehte gewinnt
        #    nur bei *straffer* Überlegenheit (niedrigere Kante, Gleichstand
        #    weiter links), sonst bleibt es beim ungedrehten Teil. Ringe und
        #    Quadrate verhalten sich dadurch exakt wie zuvor, und die
        #    Entscheidung ist eine reine Funktion der Eingabe. Das Fail-Memo
        #    trägt sein Boxmaß im Schlüssel — zwei Lagen sind zwei Schlüssel
        #    und stören sich nicht.

        def pick_on_sheet(sh: Sheet) -> Optional[dict]:
            best: Optional[dict] = None

            def consider(rot: int, fw: float, fh: float) -> None:
                nonlocal best
                bw, bh = fw + gap, fh + gap
                key = f"{bw}x{bh}"
                if sh.fails.get(key) == sh.ver:
                    return
                p = sky_fit(sh.sky, bw, bh, W, H, margin, corner_max2, fw, fh)
                if p is not None:
                    if best is None or p["y"] < best["p"]["y"] or (
                        p["y"] == best["p"]["y"] and p["x"] < best["p"]["x"]
                    ):
                        best = {"p": p, "rot": rot, "fw": fw, "fh": fh,
                                "bw": bw, "bh": bh}
                else:
                    sh.fails[key] = sh.ver

            consider(0, part.fw, part.fh)
            if can_turn:
                consider(90, part.fh, part.fw)
            return best

        pick: Optional[dict] = None
        target: Optional[Sheet] = None
        for sh in sheets:
            pick = pick_on_sheet(sh)
            if pick is not None:
                target = sh
                break
        if target is None:
            target = fresh()
            pick = pick_on_sheet(target)
        if pick is None:
            # Passt es auch auf der leeren Platte nicht, liegt das an der
            # Größe oder an der Eckschranke. Beides heißt: nicht
            # automatisch bepreisen, ab zur Technik (Invariante 6).
            if not any(o is part.pos for o in over):
                over.append(part.pos)
            continue
        rx, ry = pick["fw"] / 2, pick["fh"] / 2
        placed = _copy_part(
            part,
            fw=pick["fw"],
            fh=pick["fh"],
            cx=pick["p"]["x"] + rx,
            cy=pick["p"]["y"] + ry,
            rot=float(pick["rot"]),
            mirror=False,
            uid=host_uid[0],
        )
        target.top.append(placed)
        if part.di > 0:
            target.holes.append(placed)
        host_uid[0] += 1
        sky_add(target.sky, pick["p"], pick["bw"], pick["bh"])
        target.ver += 1

    while len(sheets) > 1 and not sheets[-1].top and not sheets[-1].rest:
        sheets.pop()

    _recompute_used_h(sheets, margin, H, True)
    return {"sheets": sheets, "over": over}


def _recompute_used_h(
    sheets: list[Sheet], margin: float, H: float, use_sky: bool
) -> None:
    """Angeschnittene Plattenhöhe — NICHT die ganze Platte. Das unberührte Band
    geht als Rest zurück ins Regal (CLAUDE.md §5.2).

    ``use_sky`` entscheidet, ob das Skyline-Profil mitzählt. Nach dem Packen
    ja: es steht für den belegten Raum. Nach der Eckverdichtung nein — die
    Teile sind heruntergerückt, das Profil ist veraltet und wiese ein Band
    aus, das gar nicht mehr geschnitten wird.
    """
    for sh in sheets:
        max_top_y = margin
        for p in list(sh.top) + list(sh.rest):
            if p.cy + p.fh / 2 > max_top_y:
                max_top_y = p.cy + p.fh / 2
        sky_max = (
            max((n["y"] for n in sh.sky), default=margin)
            if (use_sky and sh.sky)
            else max_top_y
        )
        sh.used_h = min(max(max_top_y + margin, sky_max), H)


# --------------------------------------------------------------------------
# Eckverdichtung
#
# Die Skyline legt auf Hüllquadraten ab; zwei benachbarte Kreise stehen dadurch
# um bis zu eine halbe Quadratdiagonale weiter auseinander, als sie müssten.
# Diese Nachbearbeitung zieht jedes Teil zur Nullecke, solange es frei ist —
# und rechnet dabei mit den *Kreisen*, nicht mit den Quadraten.
#
# Deterministisch (feste Reihenfolge, feste Schrittfolge, gerundete
# Koordinaten), kollisionsfrei nach Invariante 1 (Kreisabstand samt Spalt, also
# strenger als die Quadratpackung), und Gäste reisen mit ihrem Wirt: ein Teil
# in einer Bohrung liegt *im* Wirt, bewegt sich der Wirt ohne den Gast,
# schneidet der zweite Schnitt in den ersten.
# --------------------------------------------------------------------------
COMPACT_STEPS = (16.0, 4.0, 1.0, 0.25)


def _parts_clash(
    a: PlacedPart, ax: float, ay: float, b: PlacedPart, gap: float
) -> bool:
    """Stoßen sich zwei Teile?

    Zwischen zwei Kreisen gilt der Kreisabstand — er ist enger und genau das,
    was die Verdichtung holen soll. Sobald eines unsymmetrisch ist, gilt die
    Standfläche: ein Kreisabstand um einen Streifen herum wäre keine Vorsicht,
    sondern eine Kollision.
    """
    if is_round(a) and is_round(b):
        need = (a.od + b.od) / 2 + gap
        dx, dy = ax - b.cx, ay - b.cy
        # Quadriert verglichen — dieselbe Rechnung in beiden Kernen (corner_sq).
        return dx * dx + dy * dy + EPS < need * need
    dx, dy = abs(ax - b.cx), abs(ay - b.cy)
    return dx + EPS < (a.fw + b.fw) / 2 + gap and dy + EPS < (a.fh + b.fh) / 2 + gap


def _can_sit(
    sh: Sheet,
    part: PlacedPart,
    nx: float,
    ny: float,
    W: float,
    H: float,
    margin: float,
    gap: float,
    corner_max2: Optional[float],
) -> bool:
    hw, hh = part.fw / 2, part.fh / 2
    if nx - hw < margin - EPS or nx + hw > W - margin + EPS:
        return False
    if ny - hh < margin - EPS or ny + hh > H - margin + EPS:
        return False
    if corner_max2 is not None and corner_sq(nx, ny, hw, hh) > corner_max2 + EPS:
        return False
    for q in sh.top:
        if q is part:
            continue
        if _parts_clash(part, nx, ny, q, gap):
            return False
    return True


def _shift_part(part: PlacedPart, dx: float, dy: float) -> None:
    part.cx += dx
    part.cy += dy
    for g in part.nested:
        g.cx += dx
        g.cy += dy


# --------------------------------------------------------------------------
# Umverteilung: die leerste Platte auflösen
#
# Die eine Bewegung, die die Plattenzahl überhaupt senken kann
# (docs/NESTING-ALGORITHM.md §9.8, Ruin-Operator „plate"). Die Skyline legt
# streng der Reihe nach ab und eröffnet eine Platte, sobald ein Teil nicht mehr
# passt; nach der Verdichtung ist auf den früheren Platten mitunter wieder
# Raum, den kein späterer Durchgang mehr sieht.
#
# Eng gefasst auf die Fälle, in denen es sicher stimmt: nur Platten ohne Gäste
# in Bohrungen (ein Gast, dessen Wirt auf einer anderen Platte landet, wäre ein
# Schnitt in ein Loch, das dort nicht mehr ist), Kandidatenlagen nur an den
# Berührpunkten schon liegender Teile, und alles oder nichts — eine halb
# aufgelöste Platte ist schlechter als eine ganze.
# --------------------------------------------------------------------------
def _relocation_spots(
    sh: Sheet, hw: float, hh: float, W: float, H: float, margin: float, gap: float
) -> tuple[list[float], list[float]]:
    xs = [margin + hw]
    ys = [margin + hh]
    for q in sh.top:
        reach_x, reach_y = q.fw / 2 + gap + hw, q.fh / 2 + gap + hh
        xs.extend((q.cx + reach_x, q.cx - reach_x))
        ys.extend((q.cy + reach_y, q.cy - reach_y))

    def clean(arr: list[float], hi: float, half: float) -> list[float]:
        seen: set[float] = set()
        out: list[float] = []
        for v in arr:
            v = round6(v)
            if v < margin + half - EPS or v > hi - margin - half + EPS:
                continue
            if v in seen:
                continue
            seen.add(v)
            out.append(v)
        out.sort()
        return out

    return clean(xs, W, hw), clean(ys, H, hh)


def _try_relocate(
    sh: Sheet,
    part: PlacedPart,
    W: float,
    H: float,
    margin: float,
    gap: float,
    corner_max2: Optional[float],
) -> bool:
    xs, ys = _relocation_spots(sh, part.fw / 2, part.fh / 2, W, H, margin, gap)
    # Von unten nach oben, dann von links nach rechts — dieselbe Vorliebe wie
    # die Skyline, damit das Bild ruhig bleibt.
    for y in ys:
        for x in xs:
            if _can_sit(sh, part, x, y, W, H, margin, gap, corner_max2):
                part.cx = x
                part.cy = y
                sh.top.append(part)
                return True
    return False


def _repack_sheets(
    sheets: list[Sheet],
    W: float,
    H: float,
    margin: float,
    gap: float,
    corner_max2: Optional[float],
) -> None:
    n_parts = sum(len(sh.top) + len(sh.rest) for sh in sheets)
    if n_parts > REPACK_MAX_PARTS:
        return

    progress = True
    while progress and len(sheets) > 1:
        progress = False
        # Die leerste zuerst; bei Gleichstand die hintere — vorne liegt in aller
        # Regel die vollere Platte.
        t = 0
        for i in range(1, len(sheets)):
            a = len(sheets[i].top) + len(sheets[i].rest)
            b = len(sheets[t].top) + len(sheets[t].rest)
            if a < b or (a == b and i > t):
                t = i
        target = sheets[t]
        if target.rest:
            continue
        if any(p.nested for p in target.top):
            break

        # Alles oder nichts, und deshalb zwei Rücknahmen: die Belegung der
        # Zielplatten *und* die Koordinaten der bewegten Teile. _try_relocate
        # schreibt cx/cy sofort — ohne die zweite Rücknahme bliebe ein Teil nach
        # einem gescheiterten Versuch auf seiner alten Platte liegen, aber an
        # der Stelle, an die es woanders gepasst hätte. Das ist eine Kollision,
        # die niemand mehr auf die Umverteilung zurückführt.
        moving = sorted(target.top, key=lambda p: (-p.od, p.pos.id, p.seq))
        home = [(p, p.cx, p.cy) for p in moving]
        snapshot = [None if i == t else list(sh.top) for i, sh in enumerate(sheets)]
        ok = True
        for part in moving:
            done = False
            for i, sh in enumerate(sheets):
                if i == t:
                    continue
                if _try_relocate(sh, part, W, H, margin, gap, corner_max2):
                    done = True
                    break
            if not done:
                ok = False
                break
        if ok:
            sheets.pop(t)
            progress = True
        else:
            for i, snap in enumerate(snapshot):
                if snap is not None:
                    sheets[i].top = snap
            for part, cx, cy in home:
                part.cx = cx
                part.cy = cy


def _compact_to_corner(
    sheets: list[Sheet],
    W: float,
    H: float,
    margin: float,
    gap: float,
    corner_max2: Optional[float],
) -> None:
    for sh in sheets:
        if not sh.top:
            continue
        # Nicht nach ``uid`` sortieren: die Hex-Packung vergibt andere
        # Kennungen als die Skyline. Nach Lage und Herkunft der Position —
        # das ist in beiden Kernen dasselbe.
        order = sorted(sh.top, key=lambda p: (p.cy, p.cx, p.pos.id, p.seq))
        for part in order:
            for step in COMPACT_STEPS:
                moved = True
                while moved:
                    moved = False
                    if _can_sit(
                        sh,
                        part,
                        part.cx,
                        part.cy - step,
                        W,
                        H,
                        margin,
                        gap,
                        corner_max2,
                    ):
                        _shift_part(part, 0.0, -step)
                        moved = True
                    if _can_sit(
                        sh,
                        part,
                        part.cx - step,
                        part.cy,
                        W,
                        H,
                        margin,
                        gap,
                        corner_max2,
                    ):
                        _shift_part(part, -step, 0.0)
                        moved = True
            part.cx = round6(part.cx)
            part.cy = round6(part.cy)
            for g in part.nested:
                g.cx = round6(g.cx)
                g.cy = round6(g.cy)


# --------------------------------------------------------------------------
# Bewertung eines fertigen Layouts
#
# Die Rangfolge, und warum sie so herum steht:
#   1. Übergrößen — nie gegen etwas anderes eintauschen (Invariante 6).
#   2. Wenigste Platten — das dominierende Ziel, um Größenordnungen.
#   3. Angeschnittenes Band — das ist der *Preis* (CLAUDE.md §5.2).
#   4. Teile in Restflächen — kostenloses Material, darf Band schlagen.
#   5. Teile je Platte — Konzentration, als Gleichstandsentscheid.
#   6. Abstand zur Nullecke — der letzte Entscheid.
#
# „Teile je Platte" steht *unter* dem angeschnittenen Band, obwohl es als Ziel
# weiter oben gewünscht war: darüber hieße, Fläche zu kaufen, damit eine Platte
# voller aussieht. Dieses Geschäft hat ARCHITECTURE.md §5.9 schon einmal
# gemacht und mit −46 % auf einem Vergleichsfall bezahlt
# (docs/NESTING-ALGORITHM.md §2.1). Bei gleicher Plattenzahl und gleichem Band
# ist Konzentration umsonst — dort wird sie genommen, und nur dort.
# --------------------------------------------------------------------------
def score_layout(res: dict, W: float, H: float) -> dict:
    total_used_h = 0.0
    n_rest = 0
    sum_sq = 0
    n_parts = 0
    worst = 0.0
    fill: list[int] = []
    for sh in res["sheets"]:
        total_used_h += sh.used_h
        n_rest += len(sh.rest)
        on = len(sh.top) + len(sh.rest)
        fill.append(on)
        sum_sq += on * on
        n_parts += on
        for p in sh.top:
            d = corner_sq(p.cx, p.cy, p.fw / 2, p.fh / 2)
            if d > worst:
                worst = d
        for p in sh.rest:
            d = corner_sq(p.cx, p.cy, p.fw / 2, p.fh / 2)
            if d > worst:
                worst = d
    n_sheets = len(res["sheets"])
    # Σ(Teile je Platte)² / (Σ Teile)² — 1,0 heißt alles auf einer Platte.
    conc = (sum_sq / (n_parts * n_parts)) if n_parts > 0 else 1.0
    diag = math.sqrt(W * W + H * H)
    corner_max = math.sqrt(worst)
    corner = (corner_max / diag) if diag > 0 else 0.0
    score = (
        (len(res["over"]) * 1e9)
        + (n_sheets * 1e6)
        + (total_used_h * 10)
        - (n_rest * 50)
        - (conc * 1e-2)
        + (corner * 1e-4)
    )
    return {
        "score": score,
        "n_sheets": n_sheets,
        "total_used_h": total_used_h,
        "n_rest": n_rest,
        "conc": conc,
        "corner_max": corner_max,
        "fill": fill,
    }


# --------------------------------------------------------------------------
# Multi-Pass-Optimierer
# --------------------------------------------------------------------------
def nest(
    positions: list[Position],
    product: Product,
    rates: Rates,
    sheet_idx: Optional[int] = None,
    policy_override: Optional[dict] = None,
) -> dict:
    gap = product.kerf if product.kerf is not None else rates.gap
    margin = product.web if product.web is not None else rates.margin
    idx = sheet_idx if sheet_idx is not None else 0
    fmt = product.sheets[idx] if 0 <= idx < len(product.sheets) else product.sheets[0]
    W, H = float(fmt[0]), float(fmt[1])

    policy = resolve_policy(rates, policy_override)
    corner_max2 = (
        policy["corner_max_dist"] * policy["corner_max_dist"]
        if policy["corner_max_dist"] is not None
        else None
    )

    parts: list[PlacedPart] = []
    for p in positions:
        n = max(1, round(p.q or 1))
        fw, fh = footprint(p)
        for i in range(n):
            parts.append(
                PlacedPart(
                    pos=p, od=float(p.od), di=float(p.di or 0), fw=fw, fh=fh,
                    seq=i, rot=0.0, mirror=False,
                )
            )

    # Dreh- und Spiegelfähigkeit: Bedienervorgabe ∩ Werkstoffrichtung. Eine
    # reine Funktion von Produkt und Richtlinie — also deterministisch und
    # im JS-Kern genauso.
    orient = _orientation_policy(product, policy)

    # Große Aufträge: ein Kandidat, keine Nachpässe (siehe LARGE_PARTS).
    # Rein eine Funktion der Teilezahl — also deterministisch und im JS-Kern
    # genauso. Der Memo-Schlüssel braucht das nicht: die Teilezahl steckt
    # schon in den Positionen.
    n_parts = len(parts)
    if n_parts > LARGE_PARTS:
        policy = {**policy, "max_candidates": 1, "compact": False, "repack": False}
    skip_holes = n_parts > LARGE_NO_HOLES

    # Saatordnungen in fester Reihenfolge; das Budget schneidet hinten ab.
    # Deshalb steht die stärkste zuerst — wer wenig Budget gibt, bekommt nicht
    # irgendeine, sondern die beste einzelne Heuristik.
    plan = STRATEGIES[: policy["max_candidates"]]
    best_result = None
    best_score = math.inf
    best_metrics = None
    candidates = 0
    exhausted = True
    t0 = time.perf_counter() if policy["max_ms"] is not None else 0.0

    for k, strat in enumerate(plan):
        res = _execute_pass(parts, W, H, margin, gap, strat, corner_max2, skip_holes, orient)
        m = score_layout(res, W, H)
        candidates += 1
        if m["score"] < best_score:
            best_score = m["score"]
            best_result = res
            best_metrics = m
        # Die Notbremse greift nur zwischen zwei Kandidaten, nie mitten in
        # einem: ein halbes Layout ist kein Layout.
        if (
            policy["max_ms"] is not None
            and k + 1 < len(plan)
            and (time.perf_counter() - t0) * 1000.0 >= policy["max_ms"]
        ):
            exhausted = False
            break

    assert best_result is not None and best_metrics is not None

    # Die Nachpässe verfeinern den *Sieger*, sie wählen ihn nicht aus.
    # Andersherum — jeden Kandidaten verdichten und umverteilen, dann
    # vergleichen — kostete das Fünffache und brachte gemessen nichts
    # zusätzlich: beide Nachpässe schieben alle Kandidaten in dieselbe
    # Richtung, die Rangfolge der Saatordnungen ändert sich dadurch kaum.
    if policy["compact"]:
        _compact_to_corner(best_result["sheets"], W, H, margin, gap, corner_max2)
    if policy["repack"]:
        # Erst verdichten, dann umverteilen: die Umverteilung lebt genau von
        # dem Raum, den die Verdichtung freigemacht hat.
        _repack_sheets(best_result["sheets"], W, H, margin, gap, corner_max2)
        if policy["compact"]:
            _compact_to_corner(best_result["sheets"], W, H, margin, gap, corner_max2)
    if policy["compact"] or policy["repack"]:
        # Ohne Skyline: die Teile sind gerückt, das Profil ist veraltet.
        _recompute_used_h(best_result["sheets"], margin, H, False)
        best_metrics = score_layout(best_result, W, H)
    return {
        "sheets": best_result["sheets"],
        "W": W,
        "H": H,
        "fmt": (W, H),
        "product": product,
        "mat_key": product.id,
        "over": best_result["over"],
        "gap": gap,
        "margin": margin,
        # Dreh- und Spiegelfähigkeit dieses Laufs — Bedienervorgabe ∩
        # Werkstoffrichtung. Die Ansicht zeigt daran, warum eine Lage nicht
        # gedreht wurde, und der Test nagt die Schranken daran fest.
        "orient": {"rot90": orient["rot90"], "mirror": orient["mirror"]},
        "v": ENGINE_VERSION,
        "sheet_idx": idx,
        # Was der Lauf gekostet hat und ob er zu Ende ging. ``exhausted=False``
        # heißt: die Wanduhr hat abgebrochen, die Determinismus-Zusage gilt für
        # dieses Ergebnis nicht, und daraus darf kein festgeschriebener Preis
        # werden (docs/NESTING-ALGORITHM.md §10).
        "candidates": candidates,
        "exhausted": exhausted,
        # Weitester Abstand einer Teilecke von der Nullecke, in mm.
        "corner_max": round6(best_metrics["corner_max"]),
        # Teile je Platte — „möglichst viele Formen je Platte", nachprüfbar.
        "fill": best_metrics["fill"],
        "policy": policy,
    }


# --------------------------------------------------------------------------
# Gedächtnis für Schachtelungen (Rechenkern 2.3.0)
#
# nest() ist rein: gleiche Eingabe plus gleiche Engine-Version ergibt
# byteidentisches Ergebnis (Invariante 5). Genau das erlaubt, das Ergebnis zu
# merken statt es erneut zu rechnen — CLAUDE.md §4 nennt den Schlüssel
# `NestJob.hash`, Phase 0.5 das Zwischenspeichern.
#
# Im Backend lohnt es aus einem anderen Grund als im Browser: nest_best()
# rechnet je Werkstoff alle gelagerten Formate durch, und der Sammellauf
# schachtelt jeden Eimer zweimal — einmal zur Probe für die Ausnutzung, einmal
# für den Plan. Ohne Gedächtnis wäre die Freigabeprüfung doppelt so teuer wie
# der Lauf selbst.
#
# Das Ergebnis ist als unveränderlich zu behandeln — wer eine Schachtelung
# anfasst, verändert sie für alle folgenden Aufrufe.
# --------------------------------------------------------------------------
_NEST_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_NEST_CACHE_MAX = 240


def nest_key(
    positions: list[Position],
    product: Product,
    rates: Rates,
    sheet_idx: int,
    policy_override: Optional[dict] = None,
) -> str:
    # Die Kontur gehört in den Schlüssel: seit 2.7.0-lite entscheidet der
    # Footprint der echten Kontur über Lage und Fläche. Ohne ihn teilten sich
    # zwei verschiedene Formen mit gleichem od/di/q eine gespeicherte
    # Schachtelung — die zweite wurde auf der Lage der ersten bepreist, je
    # nachdem, was der Prozess zuerst gerechnet hatte.
    parts = ";".join(
        ",".join(
            str(v)
            for v in (
                p.id,
                p.thk,
                p.gross,
                p.net,
                p.od,
                p.di or 0,
                p.q or 1,
                p.cut_len or 0,
                p.bn or 0,
                p.bd or 0,
                json.dumps(p.shape, sort_keys=True, separators=(",", ":"))
                if p.shape
                else "",
            )
        )
        for p in positions
    )
    sheets = "|".join(f"{w}x{h}" for w, h in product.sheets)
    gap = product.kerf if product.kerf is not None else rates.gap
    margin = product.web if product.web is not None else rates.margin
    # Die Richtlinie gehört in den Schlüssel: dieselben Teile unter einer
    # anderen Eckschranke oder einem anderen Budget sind eine andere
    # Schachtelung. ``max_ms`` steht bewusst nicht drin — ein Ergebnis, das die
    # Wanduhr abgeschnitten hat, wird gar nicht erst abgelegt.
    pol = resolve_policy(rates, policy_override)
    return "#".join(
        str(v)
        for v in (
            ENGINE_VERSION,
            product.id,
            sheet_idx,
            gap,
            margin,
            pol["max_candidates"],
            pol["corner_max_dist"] if pol["corner_max_dist"] is not None else "-",
            1 if pol["compact"] else 0,
            1 if pol["repack"] else 0,
            1 if pol["allow_rotation"] else 0,
            1 if pol["allow_mirror"] else 0,
            product.grain or "none",
            0 if product.flip_ok is False else 1,
            sheets,
            parts,
        )
    )


def nest_cached(
    positions: list[Position],
    product: Product,
    rates: Rates,
    sheet_idx: int,
    policy_override: Optional[dict] = None,
) -> dict:
    # Mit Wanduhr-Notbremse wird nicht gemerkt. Ein Ergebnis, das je nach
    # Tageslast anders ausfällt, darf nicht als „dasselbe" wiederkehren.
    pol = resolve_policy(rates, policy_override)
    if pol["max_ms"] is not None:
        return nest(positions, product, rates, sheet_idx, policy_override)
    key = nest_key(positions, product, rates, sheet_idx, policy_override)
    hit = _NEST_CACHE.get(key)
    if hit is not None:
        return hit
    res = nest(positions, product, rates, sheet_idx, policy_override)
    if len(_NEST_CACHE) >= _NEST_CACHE_MAX:
        _NEST_CACHE.popitem(last=False)  # ältestes zuerst hinaus
    _NEST_CACHE[key] = res
    return res


def clear_nest_cache() -> None:
    """Forget stored layouts after catalogue or policy changes."""
    _NEST_CACHE.clear()


def nest_best(
    positions: list[Position],
    product: Product,
    rates: Rates,
    policy_override: Optional[dict] = None,
) -> dict:
    """Alle gelagerten Formate durchrechnen, kleinste angeschnittene Fläche
    gewinnt. Gleichstand (≤1e-9 m²) → kleinstes ursprüngliches Format
    (deterministisch, unabhängig von der Prüfreihenfolge). Geprüft wird nach
    aufsteigender Plattenfläche; Formate, die das größte Teil in keiner Lage
    fassen, werden übersprungen, sobald ein Format ohne Übergröße vorliegt
    (strikt schlechter, kein Entscheid).

    Bei sehr großen Körben (siehe LARGE_PARTS) werden höchstens die ersten
    zwei Formate gerechnet — neun Formate × zehntausend Teile ist keine
    Probe mehr, sondern eine Kaffeepause. Der JS-Kern macht es genauso."""
    best = None
    best_key = None
    n_parts = sum(max(1, round(p.q or 1)) for p in positions)
    n_formats = (
        min(2, len(product.sheets)) if n_parts > LARGE_PARTS else len(product.sheets)
    )
    order = sorted(range(n_formats),
                   key=lambda i: (product.sheets[i][0] * product.sheets[i][1], i))
    max_fw = max_fh = 0.0
    for p in positions:
        fw, fh = footprint(p)
        max_fw = max(max_fw, fw)
        max_fh = max(max_fh, fh)
    margin0 = product.web if product.web is not None else rates.margin
    for i in order:
        W, H = float(product.sheets[i][0]), float(product.sheets[i][1])
        fits0 = ((max_fw <= W - 2 * margin0 + EPS and max_fh <= H - 2 * margin0 + EPS)
                 or (max_fh <= W - 2 * margin0 + EPS and max_fw <= H - 2 * margin0 + EPS))
        if not fits0 and best is not None and best_key is not None and best_key[0] == 0:
            continue
        n = nest_cached(positions, product, rates, i, policy_override)
        used = sum((n["W"] / 1000) * (sh.used_h / 1000) for sh in n["sheets"])
        key = (len(n["over"]), used, i)
        if (
            best is None
            or key[0] < best_key[0]
            or (key[0] == best_key[0] and (key[1] < best_key[1] - 1e-9
                or (abs(key[1] - best_key[1]) <= 1e-9 and key[2] < best_key[2])))
        ):
            best, best_key = n, key
    assert best is not None
    # sheet_idx steht schon in nest() und wird hier NICHT überschrieben: das
    # Ergebnis kann aus dem Gedächtnis kommen und gehört dann mehreren Aufrufern.
    return best


def nest_for(
    positions: list[Position],
    product: Product,
    rates: Rates,
    plate_idx: Optional[int] = None,
    policy_override: Optional[dict] = None,
) -> dict:
    """Wie nest_best(), respektiert aber die Plattenwahl des Kunden (§1.2)."""
    if plate_idx is None or plate_idx < 0 or plate_idx >= len(product.sheets):
        return nest_best(positions, product, rates, policy_override)
    return nest_cached(positions, product, rates, plate_idx, policy_override)
