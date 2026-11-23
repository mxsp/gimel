"""Zeichnungsbibliothek: Konturen aus Punkten, DXF und SVG, ohne Auftrag.

Gespeichert wird nur die Geometrie in Millimetern, nie die Datei. Eine Datei
kommt als roher Körper in den Speicher (der Router begrenzt ihn) und verlässt ihn
als Polygone; sie geht durch keinen Formularleser und nie auf eine Platte.

Regeln für alles, was hier hereinkommt:

* Ein Ring hat mindestens drei verschiedene, endliche Punkte; die Fläche der
  Zeichnung (außen minus Aussparungen) ist größer als 0.
* Grenzen für Ringe und Eckpunkte, damit eine Datei den einen Prozess nicht
  minutenlang beschäftigt.
* DXF und SVG können mehrere Teile enthalten. Ringe, die in einem anderen liegen,
  sind Aussparungen (Tiefe ungerade), alle anderen eigene Zeichnungen. Was nicht
  gelesen wurde, steht in ``skipped``, nie still weggelassen.
* SVG: nur die Standardbibliothek, kein DOCTYPE und keine ENTITY. Einheiten werden
  als Millimeter gelesen; ``transform`` wird nicht angewendet, die Datei wird dann
  abgelehnt, statt eine falsche Größe zu speichern.
"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

import ezdxf
import numpy as np
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..models import AuditLog, Drawing
from .dxf_import import CHAIN_TOL, TAU, DxfLimit, _area_of, _chain, _in_poly, _read_entities

MAX_RINGS = 64               # je Zeichnung: eine Außenkontur und bis zu 63 Aussparungen
MAX_RING_VERTICES = 5000
MAX_VERTICES = 20000         # je Zeichnung und je Datei
MAX_LOOPS = 200              # geschlossene Züge je Datei
MAX_PER_IMPORT = 50          # Zeichnungen je Datei
MAX_LIBRARY = 2000
MAX_DRAWING_VERTICES = 1500  # je Zeichnung nach dem Vereinfachen; so viel nimmt auch ein Lauf (free_nesting.MAX_EDGES_PER_TYPE)
SIMPLIFY_TOL = 0.01          # mm
MAX_OPEN_SEGMENTS = 5000     # DXF: Linien, Bögen, Polylinien, Splines vor dem Verketten
MAX_ROUND = 500              # DXF: Kreise plus Ellipsen
MAX_INSERTS = 100            # DXF: Blockverweise
MAX_BLOCK_WORK = 20000       # DXF: Entitäten der Datei mal Blockverweise
MAX_DXF_ENTITIES = 8000      # DXF: Entitäten nach dem Auflösen der Blöcke (5000 + 500 + 200 + Reserve)
MAX_DXF_POINTS = 150_000     # DXF: erzeugte Punkte (Bögen, Wölbungen, Ellipsen, Splines)
MAX_COORD = 1_000_000.0      # mm
MIN_AREA = 0.01              # mm²
MAX_ELEMENTS = 20000         # SVG
MAX_DEPTH = 40
DEFAULT_NAME = "Zeichnung"
SOURCES = ("dxf", "svg", "points")

SVG_UNITS = "SVG-Einheiten werden als Millimeter gelesen (1 Einheit = 1 mm), gleich welche Größe die Datei angibt."


class DrawingError(ValueError):
    """Eine Eingabe, die der Bediener verstehen und beheben kann."""

    def __init__(self, detail: str, status: int = 422) -> None:
        super().__init__(detail)
        self.detail, self.status = detail, status


@dataclass
class Parsed:
    """Was eine Datei hergab: Zeichnungen, Hinweise und was übersprungen wurde."""
    shapes: list[tuple[list, list]] = field(default_factory=list)   # (outer, holes)
    notes: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


class _Budget:
    """Zählt die Eckpunkte einer Datei, bevor sie gebaut werden. Ein Pfad mit 50 000 Bögen darf
    nicht erst Gigabytes Punkte erzeugen und dann abgelehnt werden."""

    def __init__(self, limit: int = 20000) -> None:
        self.n, self.limit = 0, limit

    def take(self, k: int) -> None:
        self.n += int(k)
        if self.n > self.limit:
            raise DrawingError(f"Mehr als {self.limit} Eckpunkte in einer Datei; bitte vereinfachen oder teilen.")


def _coord(v: float) -> float:
    if not math.isfinite(v) or abs(v) > MAX_COORD:
        raise DrawingError(f"Eine Zahl liegt außerhalb von ±{int(MAX_COORD)} mm.")
    return v


# --------------------------------------------------------------------------
# Ringe prüfen
# --------------------------------------------------------------------------
def _clean_ring(raw, what: str) -> list:
    if not isinstance(raw, (list, tuple)):
        raise DrawingError(f"{what}: keine Punkteliste.")
    if len(raw) > MAX_RING_VERTICES + 1:
        raise DrawingError(f"{what}: mehr als {MAX_RING_VERTICES} Eckpunkte.")
    pts: list = []
    for p in raw:
        if (not isinstance(p, (list, tuple)) or len(p) != 2
                or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in p)):
            raise DrawingError(f"{what}: ein Punkt ist kein Zahlenpaar.")
        x, y = float(p[0]), float(p[1])
        if not (math.isfinite(x) and math.isfinite(y)) or abs(x) > MAX_COORD or abs(y) > MAX_COORD:
            raise DrawingError(f"{what}: ein Punkt ist nicht endlich oder liegt außerhalb von ±{int(MAX_COORD)} mm.")
        q = [round(x, 4), round(y, 4)]
        if not pts or q != pts[-1]:
            pts.append(q)
    while len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        raise DrawingError(f"{what}: mindestens drei verschiedene Punkte nötig.")
    return pts


def _perimeter(ring: list) -> float:
    return sum(math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1])
               for i in range(len(ring)))


def build(outer, holes, label: str = "Zeichnung") -> dict:
    """Prüft und verschiebt auf den Nullpunkt. Ergebnis: die Spalten der Tabelle."""
    holes = holes or []
    if not isinstance(holes, (list, tuple)):
        raise DrawingError(f"{label}: Aussparungen sind keine Liste.")
    if 1 + len(holes) > MAX_RINGS:
        raise DrawingError(f"{label}: mehr als {MAX_RINGS} Konturen.")
    o = _clean_ring(outer, f"{label}, Außenkontur")
    hs = [_clean_ring(h, f"{label}, Aussparung {i + 1}") for i, h in enumerate(holes)]
    if len(o) + sum(len(h) for h in hs) > MAX_VERTICES:
        raise DrawingError(f"{label}: mehr als {MAX_VERTICES} Eckpunkte.")
    if len(o) + sum(len(h) for h in hs) > MAX_DRAWING_VERTICES:
        o = _simplify_ring(o)
        hs = [_simplify_ring(h) for h in hs]
        if len(o) + sum(len(h) for h in hs) > MAX_DRAWING_VERTICES:
            raise DrawingError(f"{label}: mehr als {MAX_DRAWING_VERTICES} Eckpunkte auch nach dem Vereinfachen "
                               f"auf {SIMPLIFY_TOL} mm; bitte die Kontur vereinfachen.")
    area_o = _area_of(o)
    area_h = [_area_of(h) for h in hs]
    for i, h in enumerate(hs):
        if area_h[i] <= 0:
            raise DrawingError(f"{label}: Aussparung {i + 1} hat keine Fläche.")
        if not _in_poly(h[0][0], h[0][1], o) and not _in_poly(
                sum(p[0] for p in h) / len(h), sum(p[1] for p in h) / len(h), o):
            raise DrawingError(f"{label}: Aussparung {i + 1} liegt nicht in der Außenkontur.")
    net = area_o - sum(area_h)
    if area_o < MIN_AREA or net < MIN_AREA:
        raise DrawingError(f"{label}: die Fläche der Zeichnung ist 0 oder die Aussparungen füllen sie ganz.")
    minx, miny = min(p[0] for p in o), min(p[1] for p in o)
    maxx, maxy = max(p[0] for p in o), max(p[1] for p in o)

    def shift(r: list) -> list:
        return [[round(p[0] - minx, 4), round(p[1] - miny, 4)] for p in r]

    return {"outer": shift(o), "holes": [shift(h) for h in hs],
            "width": round(maxx - minx, 3), "height": round(maxy - miny, 3),
            "area": round(net, 3),
            "cut_len": round(_perimeter(o) + sum(_perimeter(h) for h in hs), 3)}


def _simplify_ring(ring: list) -> list:
    """RDP mit 0,01 mm. Bleiben weniger als drei Punkte, gilt der Ring unverändert (er ist dann zu klein
    für eine Vereinfachung, und die Prüfung danach entscheidet)."""
    out = _rdp(ring + [ring[0]], SIMPLIFY_TOL)[:-1]
    return out if len(out) >= 3 else ring


def clean_name(value: str | None, default: str = DEFAULT_NAME) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", value or "")
    text = re.sub(r"\s+", " ", text).strip()[:120]
    return text or default


# --------------------------------------------------------------------------
# Punkte als Text
# --------------------------------------------------------------------------
_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"


def parse_points(text: str) -> Parsed:
    """„x,y x,y …“; der erste Block ist die Außenkontur, jeder weitere (nach einer
    Leerzeile) eine Aussparung. Punkt als Dezimaltrenner, Einheit Millimeter."""
    if len(text) > 400_000:
        raise DrawingError("Der Text ist zu lang.")
    blocks = [b for b in re.split(r"\n\s*\n", text.replace("\r", "")) if b.strip()]
    if not blocks:
        raise DrawingError("Keine Punkte angegeben.")
    rings = []
    for i, block in enumerate(blocks):
        junk = re.sub(_NUM, " ", block)
        if re.search(r"[^\s,;]", junk):
            raise DrawingError(f"Block {i + 1}: nur Zahlen, Kommas und Leerzeichen sind erlaubt (Punkt als Dezimaltrenner).")
        nums = [float(n) for n in re.findall(_NUM, block)]
        if len(nums) % 2:
            raise DrawingError(f"Block {i + 1}: ungerade Anzahl Zahlen, ein Punkt braucht x und y.")
        rings.append([[nums[k], nums[k + 1]] for k in range(0, len(nums), 2)])
    return Parsed(shapes=[(rings[0], rings[1:])],
                  notes=["Punkte werden als Millimeter gelesen."])


# --------------------------------------------------------------------------
# Ringe zu Zeichnungen: innen liegt eine Aussparung, nebenan ist ein neues Teil
# --------------------------------------------------------------------------
def _box(r: list) -> tuple:
    xs, ys = [p[0] for p in r], [p[1] for p in r]
    return min(xs), min(ys), max(xs), max(ys)


def _samples(r: list) -> list:
    n = len(r)
    return [r[0], r[n // 3], r[2 * n // 3]]


def group_rings(rings: list[list], parsed: Parsed) -> None:
    """Sortiert Ringe nach Fläche; Tiefe gerade = Außenkontur, ungerade = Aussparung
    des kleinsten Rings, der sie umschließt."""
    items = []
    for r in rings:
        pts = [p for i, p in enumerate(r) if i == 0 or p != r[i - 1]]
        if len(pts) > 1 and pts[0] == pts[-1]:
            pts.pop()
        if len(pts) < 3 or _area_of(pts) < MIN_AREA:
            parsed.skipped.append("Ein Zug ohne Fläche wurde übersprungen.")
            continue
        items.append({"pts": pts, "area": _area_of(pts), "box": _box(pts)})
    if len(items) > MAX_LOOPS:
        raise DrawingError(f"Mehr als {MAX_LOOPS} geschlossene Konturen in einer Datei.")
    if sum(len(i["pts"]) for i in items) > MAX_VERTICES:
        raise DrawingError(f"Mehr als {MAX_VERTICES} Eckpunkte in einer Datei.")
    items.sort(key=lambda i: -i["area"])
    owners: list[dict] = []            # Außenkonturen samt ihren Aussparungen
    for idx, it in enumerate(items):
        parents = []
        for j in range(idx):
            c = items[j]
            x0, y0, x1, y1 = c["box"]
            pts = [p for p in _samples(it["pts"]) if x0 <= p[0] <= x1 and y0 <= p[1] <= y1]
            if len(pts) >= 2 and sum(_in_poly(p[0], p[1], c["pts"]) for p in pts) >= 2:
                parents.append(j)
        it["depth"] = len(parents)
        it["parent"] = parents[-1] if parents else None
        if it["depth"] % 2 == 0:
            it["owner"] = {"outer": it["pts"], "holes": []}
            owners.append(it["owner"])
        else:
            items[it["parent"]]["owner"]["holes"].append(it["pts"])
    parsed.shapes.extend((o["outer"], o["holes"]) for o in owners)


# --------------------------------------------------------------------------
# DXF
# --------------------------------------------------------------------------
def _decode(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


def _circle_ring(cx: float, cy: float, rx: float, ry: float, budget: "_Budget | None" = None) -> list:
    r = max(rx, ry)
    step = 2 * math.acos(max(-1.0, 1 - 0.02 / r)) if r > 0.02 else math.pi / 4
    n = max(24, min(360, math.ceil(TAU / max(step, 1e-6))))
    if budget:
        budget.take(n)
    return [[cx + rx * math.cos(TAU * k / n), cy + ry * math.sin(TAU * k / n)] for k in range(n)]


_ENTITY = re.compile(r"^[ \t]*0[ \t]*\r?\n[ \t]*([A-Z0-9_]+)[ \t]*$", re.M)
_OPEN = {"LINE", "ARC", "LWPOLYLINE", "POLYLINE", "SPLINE"}
_ROUND = {"CIRCLE", "ELLIPSE"}


def _precheck_dxf(text: str) -> None:
    """Zählt Entitäten im Text, bevor ezdxf etwas baut. Hinter jeder Zeile „0“ steht der Typ."""
    counts: dict[str, int] = {}
    for m in _ENTITY.finditer(text):
        counts[m.group(1)] = counts.get(m.group(1), 0) + 1
    open_n = sum(counts.get(k, 0) for k in _OPEN)
    round_n = sum(counts.get(k, 0) for k in _ROUND)
    inserts = counts.get("INSERT", 0)
    if open_n > MAX_OPEN_SEGMENTS:
        raise DrawingError(f"Die Datei hat {open_n} Linien, Bögen und Polylinien; erlaubt sind {MAX_OPEN_SEGMENTS}. "
                           "Bitte vereinfachen oder in mehrere Dateien teilen.")
    if round_n > MAX_ROUND:
        raise DrawingError(f"Die Datei hat {round_n} Kreise und Ellipsen; erlaubt sind {MAX_ROUND}.")
    if inserts > MAX_INSERTS:
        raise DrawingError(f"Die Datei hat {inserts} Blockverweise; erlaubt sind {MAX_INSERTS}.")
    if inserts and (open_n + round_n) * inserts > MAX_BLOCK_WORK:
        raise DrawingError("Die Blöcke der Datei würden zu viele Konturen ergeben; bitte Blöcke auflösen.")


def _check_dxf_counts(read: dict) -> None:
    """Noch einmal nach dem Auflösen der Blöcke und vor dem Verketten, das quadratisch wächst."""
    if len(read["open"]) > MAX_OPEN_SEGMENTS:
        raise DrawingError(f"Die Datei ergibt {len(read['open'])} offene Linienstücke; erlaubt sind {MAX_OPEN_SEGMENTS}.")
    if len(read["circles"]) + len(read["ellipses"]) > MAX_ROUND:
        raise DrawingError(f"Die Datei ergibt mehr als {MAX_ROUND} Kreise und Ellipsen.")
    if len(read["closed"]) > MAX_LOOPS:
        raise DrawingError(f"Die Datei ergibt {len(read['closed'])} geschlossene Konturen; erlaubt sind {MAX_LOOPS}.")
    if sum(len(c) for c in read["closed"]) + sum(len(c) for c in read["open"]) > 4 * MAX_VERTICES:
        raise DrawingError("Die Datei hat zu viele Eckpunkte; bitte vereinfachen.")


def _parse_dxf(data: bytes) -> Parsed:
    if data[:18] == b"AutoCAD Binary DXF":
        raise DrawingError("Das ist eine binäre DXF-Datei. Bitte als ASCII-DXF (R12 oder neuer) speichern.")
    text = _decode(data).replace("\r\n", "\n").replace("\r", "\n")      # CRLF zählt wie LF, auch im Vorab-Zählen
    head = text.lstrip()[:5]
    if head.startswith("<?xml") or head.startswith("<svg"):
        raise DrawingError("Das sieht nach einer SVG-Datei aus; dafür gibt es den SVG-Import.")
    _precheck_dxf(text)
    try:
        read = _read_entities(text, max_entities=MAX_DXF_ENTITIES, max_points=MAX_DXF_POINTS,
                              max_poly=MAX_RING_VERTICES)
    except (DrawingError, DxfLimit) as exc:
        if isinstance(exc, DxfLimit):
            raise DrawingError(str(exc)) from None
        raise
    except (ValueError, TypeError, ArithmeticError, ezdxf.DXFError) as exc:
        raise DrawingError(f"DXF nicht lesbar: {exc}") from None
    if read.get("error"):
        raise DrawingError(str(read["error"]))
    _check_dxf_counts(read)
    out = Parsed()
    seen: set[str] = set()
    for s in read["skipped"]:
        if s not in seen:
            seen.add(s)
            (out.notes if s.startswith("Keine DXF-Einheit") else out.skipped).append(s)
    chains = _chain(read["open"])
    loops = [c for c in chains if len(c) > 2
             and math.hypot(c[0][0] - c[-1][0], c[0][1] - c[-1][1]) <= CHAIN_TOL]
    if len(chains) - len(loops):
        out.skipped.append(f"{len(chains) - len(loops)} offene Linienzüge ohne Schluss wurden übersprungen.")
    rings = list(read["closed"]) + loops
    cb = _Budget(MAX_VERTICES)
    rings += [_circle_ring(c["cx"], c["cy"], c["r"], c["r"], cb) for c in read["circles"]]
    rings += [_circle_ring(e["cx"], e["cy"], e["a"], e["b"], cb) for e in read["ellipses"]]
    if not rings:
        raise DrawingError("Keine geschlossene Kontur gefunden. Gelesen werden CIRCLE, ARC, LINE, "
                           "LWPOLYLINE, POLYLINE, ELLIPSE und SPLINE.")
    group_rings(rings, out)
    return out


# --------------------------------------------------------------------------
# SVG
# --------------------------------------------------------------------------
def _forbid(*_args) -> None:
    raise DrawingError("Die SVG-Datei enthält einen DOCTYPE oder eine ENTITY; beides wird nicht gelesen.")


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _f(value, default: float = 0.0) -> float:
    m = re.match(r"\s*(" + _NUM + ")", value or "")
    if not m:
        return default
    return _coord(float(m.group(1)))


def _arc_n(r: float, span: float) -> int:
    step = 2 * math.acos(max(-1.0, 1 - 0.05 / r)) if r > 0.05 else math.pi / 4
    return max(2, min(720, math.ceil(abs(span) / max(step, 1e-6))))


def _svg_arc(x0: float, y0: float, rx: float, ry: float, phi_deg: float,
             large: bool, sweep: bool, x1: float, y1: float, vb: "_Budget | None" = None) -> list:
    """Endpunktform nach Mittelpunktform (SVG 1.1, F.6.5), als Punkte ohne den Start."""
    if (x0, y0) == (x1, y1):
        return []
    rx, ry = abs(_coord(rx)), abs(_coord(ry))
    if rx == 0 or ry == 0:
        if vb:
            vb.take(1)
        return [[x1, y1]]
    phi = math.radians(phi_deg % 360)
    c, s = math.cos(phi), math.sin(phi)
    dx, dy = (x0 - x1) / 2, (y0 - y1) / 2
    xp, yp = c * dx + s * dy, -s * dx + c * dy
    lam = xp * xp / (rx * rx) + yp * yp / (ry * ry)
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
    den = rx * rx * yp * yp + ry * ry * xp * xp
    co = math.sqrt(max(0.0, num / den)) * (-1 if large == sweep else 1)
    cxp, cyp = co * rx * yp / ry, -co * ry * xp / rx
    cx, cy = c * cxp - s * cyp + (x0 + x1) / 2, s * cxp + c * cyp + (y0 + y1) / 2

    def ang(ux: float, uy: float, vx: float, vy: float) -> float:
        return math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)

    t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry)
    dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry)
    if not sweep and dt > 0:
        dt -= TAU
    elif sweep and dt < 0:
        dt += TAU
    n = _arc_n(max(rx, ry), dt)
    if vb:
        vb.take(n)
    pts = []
    for k in range(1, n + 1):
        t = t1 + dt * k / n
        px, py = rx * math.cos(t), ry * math.sin(t)
        pts.append([c * px - s * py + cx, s * px + c * py + cy])
    pts[-1] = [x1, y1]
    return pts


def _bezier(p: list, tol: float = 0.05, vb: "_Budget | None" = None) -> list:
    """Quadratisch (3 Punkte) oder kubisch (4), ohne den Startpunkt."""
    if len(p) == 3:
        dd = math.hypot(p[0][0] - 2 * p[1][0] + p[2][0], p[0][1] - 2 * p[1][1] + p[2][1])
        n = math.ceil(math.sqrt(dd * 0.25 / tol))
    else:
        dd = max(math.hypot(p[0][0] - 2 * p[1][0] + p[2][0], p[0][1] - 2 * p[1][1] + p[2][1]),
                 math.hypot(p[1][0] - 2 * p[2][0] + p[3][0], p[1][1] - 2 * p[2][1] + p[3][1]))
        n = math.ceil(math.sqrt(dd * 0.75 / tol))
    n = max(4, min(120, n))
    if vb:
        vb.take(n)
    out = []
    for k in range(1, n + 1):
        t = k / n
        u = 1 - t
        if len(p) == 3:
            out.append([u * u * p[0][0] + 2 * u * t * p[1][0] + t * t * p[2][0],
                        u * u * p[0][1] + 2 * u * t * p[1][1] + t * t * p[2][1]])
        else:
            out.append([u**3 * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t**3 * p[3][0],
                        u**3 * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t**3 * p[3][1]])
    return out


class _Scan:
    """Liest die Zahlen eines Pfades; Bogenflags dürfen ohne Trenner folgen („a1 1 0 01 5 5“)."""

    def __init__(self, text: str) -> None:
        self.t, self.i = text, 0

    def _skip(self) -> None:
        while self.i < len(self.t) and self.t[self.i] in " \t\r\n,":
            self.i += 1

    def command(self) -> str | None:
        self._skip()
        if self.i < len(self.t) and self.t[self.i].isalpha():
            self.i += 1
            return self.t[self.i - 1]
        return None

    def more(self) -> bool:
        self._skip()
        return self.i < len(self.t) and not self.t[self.i].isalpha()

    def number(self) -> float:
        self._skip()
        m = re.compile(_NUM).match(self.t, self.i)
        if not m:
            raise DrawingError("Ein SVG-Pfad ist nicht lesbar.")
        self.i = m.end()
        return _coord(float(m.group(0)))

    def flag(self) -> bool:
        self._skip()
        if self.i < len(self.t) and self.t[self.i] in "01":
            self.i += 1
            return self.t[self.i - 1] == "1"
        raise DrawingError("Ein SVG-Pfad ist nicht lesbar.")


def _path(d: str, budget: list, vb: _Budget) -> list[tuple[list, bool]]:
    """Pfad → Teilpfade (Punkte, geschlossen). Linien, Bögen und Bézierkurven."""
    sc = _Scan(d)
    subs: list[tuple[list, bool]] = []
    pts: list = []
    cur = start = [0.0, 0.0]
    prev_c = None            # letzter Kontrollpunkt für S/T
    prev_cmd = ""
    cmd = None

    def flush(closed: bool) -> None:
        nonlocal pts
        if len(pts) >= 2:
            subs.append((pts, closed))
        pts = []

    while True:
        c = sc.command()
        if c is None:
            if not sc.more():
                break
            if cmd is None:
                raise DrawingError("Ein SVG-Pfad beginnt nicht mit M.")
            c = {"M": "L", "m": "l"}.get(cmd, cmd)       # weitere Paare wiederholen den Befehl
        elif c in "zZ":
            flush(True)
            cur = start
            prev_c, prev_cmd, cmd = None, "z", c
            continue
        cmd = c
        rel = c.islower()
        u = c.upper()
        bx, by = (cur[0], cur[1]) if rel else (0.0, 0.0)
        budget[0] += 1
        if budget[0] > 50000:
            raise DrawingError("Der SVG-Pfad ist zu umfangreich.")
        if u == "M":
            flush(False)
            vb.take(1)
            cur = [_coord(bx + sc.number()), _coord(by + sc.number())]
            start = cur
            pts = [cur]
        elif u == "L":
            vb.take(1)
            cur = [_coord(bx + sc.number()), _coord(by + sc.number())]
            pts.append(cur)
        elif u == "H":
            vb.take(1)
            cur = [_coord((cur[0] if rel else 0.0) + sc.number()), cur[1]]
            pts.append(cur)
        elif u == "V":
            vb.take(1)
            cur = [cur[0], _coord((cur[1] if rel else 0.0) + sc.number())]
            pts.append(cur)
        elif u in "CS":
            if u == "C":
                c1 = [_coord(bx + sc.number()), _coord(by + sc.number())]
            else:
                c1 = ([2 * cur[0] - prev_c[0], 2 * cur[1] - prev_c[1]]
                      if prev_c and prev_cmd in "CS" else list(cur))
            c2 = [_coord(bx + sc.number()), _coord(by + sc.number())]
            end = [_coord(bx + sc.number()), _coord(by + sc.number())]
            pts.extend(_bezier([cur, c1, c2, end], vb=vb))
            prev_c, cur = c2, end
            prev_cmd = u
            continue
        elif u in "QT":
            if u == "Q":
                c1 = [_coord(bx + sc.number()), _coord(by + sc.number())]
            else:
                c1 = ([2 * cur[0] - prev_c[0], 2 * cur[1] - prev_c[1]]
                      if prev_c and prev_cmd in "QT" else list(cur))
            end = [_coord(bx + sc.number()), _coord(by + sc.number())]
            pts.extend(_bezier([cur, c1, end], vb=vb))
            prev_c, cur = c1, end
            prev_cmd = u
            continue
        elif u == "A":
            rx, ry, rot = sc.number(), sc.number(), sc.number()
            large, sweep = sc.flag(), sc.flag()
            end = [_coord(bx + sc.number()), _coord(by + sc.number())]
            pts.extend(_svg_arc(cur[0], cur[1], rx, ry, rot, large, sweep, end[0], end[1], vb))
            cur = end
        else:
            raise DrawingError(f"Der SVG-Pfadbefehl „{c}“ wird nicht gelesen.")
        prev_c, prev_cmd = None, u
    flush(False)
    return subs


def _rect_ring(x: float, y: float, w: float, h: float, rx: float, ry: float, vb: _Budget) -> list:
    rx, ry = min(rx, w / 2), min(ry, h / 2)
    if rx <= 0 or ry <= 0:
        vb.take(4)
        return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    n = max(4, _arc_n(max(rx, ry), math.pi / 2))
    vb.take(4 * (n + 1))
    pts = []
    for ccx, ccy, a0 in ((x + w - rx, y + ry, -math.pi / 2), (x + w - rx, y + h - ry, 0.0),
                         (x + rx, y + h - ry, math.pi / 2), (x + rx, y + ry, math.pi)):
        for k in range(n + 1):
            a = a0 + (math.pi / 2) * k / n
            pts.append([ccx + rx * math.cos(a), ccy + ry * math.sin(a)])
    return pts


_IGNORED = {"metadata", "title", "desc", "defs", "style", "script", "namedview", "foreignobject"}
_NOT_READ = {"text": "Text", "image": "Bilder", "use": "Verweise (use)", "line": "Einzellinien",
             "tspan": "Text", "switch": "switch-Blöcke", "symbol": "Symbole", "pattern": "Muster"}


def parse_svg(data: bytes) -> Parsed:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise DrawingError("Die SVG-Datei muss UTF-8 sein.") from None
    if re.search(r"<!\s*(doctype|entity)", text, re.I):
        _forbid()
    parser = ET.XMLParser()
    inner = getattr(parser, "parser", None)         # der C-Leser zeigt ihn nicht überall
    if inner is not None:
        inner.StartDoctypeDeclHandler = _forbid
        inner.EntityDeclHandler = _forbid
    try:
        parser.feed(text)
        root = parser.close()
    except DrawingError:
        raise
    except ET.ParseError as exc:
        raise DrawingError(f"SVG nicht lesbar: {exc}") from None
    if _local(root.tag) != "svg":
        raise DrawingError("Das ist keine SVG-Datei (Wurzelelement svg fehlt).")

    out = Parsed(notes=[SVG_UNITS])
    rings: list[list] = []
    flipped: list[list] = []
    refused: set[str] = set()
    not_read: dict[str, int] = {}
    open_n = [0]
    budget = [0]
    vb = _Budget(MAX_VERTICES)
    count = [0]

    def add(pts: list, closed: bool, what: str) -> None:
        if not closed and len(pts) > 2 and math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) <= CHAIN_TOL:
            closed = True
        if not closed:
            open_n[0] += 1
            return
        flipped.append([[p[0], -p[1]] for p in pts])      # SVG zählt nach unten, DXF nach oben

    def walk(el, depth: int) -> None:
        if depth > MAX_DEPTH:
            raise DrawingError("Die SVG-Datei ist zu tief verschachtelt.")
        count[0] += 1
        if count[0] > MAX_ELEMENTS:
            raise DrawingError("Die SVG-Datei hat zu viele Elemente.")
        tag = _local(el.tag).lower()
        if tag in _IGNORED:
            return
        if tag in _NOT_READ:
            not_read[_NOT_READ[tag]] = not_read.get(_NOT_READ[tag], 0) + 1
            return
        tr = (el.get("transform") or "").strip()
        if tr and tr != "none":
            refused.add(tag)
        style = (el.get("style") or "").replace(" ", "").lower()
        if el.get("display") == "none" or "display:none" in style:
            return
        if tag == "polygon" or tag == "polyline":
            nums = [_coord(float(n)) for n in re.findall(_NUM, el.get("points") or "")]
            vb.take(len(nums) // 2)
            pts = [[nums[k], nums[k + 1]] for k in range(0, len(nums) - 1, 2)]
            add(pts, tag == "polygon", tag)
        elif tag == "rect":
            w, h = _f(el.get("width")), _f(el.get("height"))
            rx, ry = el.get("rx"), el.get("ry")
            rxv = _f(rx, _f(ry)) if (rx or ry) else 0.0
            ryv = _f(ry, rxv) if ry else rxv
            if w > 0 and h > 0:
                add(_rect_ring(_f(el.get("x")), _f(el.get("y")), w, h, rxv, ryv, vb), True, tag)
        elif tag == "circle" or tag == "ellipse":
            rx = _f(el.get("r")) if tag == "circle" else _f(el.get("rx"))
            ry = rx if tag == "circle" else _f(el.get("ry"))
            if rx > 0 and ry > 0:
                add(_circle_ring(_f(el.get("cx")), _f(el.get("cy")), rx, ry, vb), True, tag)
        elif tag == "path":
            for pts, closed in _path(el.get("d") or "", budget, vb):
                add(pts, closed, tag)
        for child in el:
            walk(child, depth + 1)

    try:
        walk(root, 0)
    except DrawingError:
        raise
    except (OverflowError, ZeroDivisionError, ValueError, RecursionError):
        raise DrawingError("Die SVG-Datei enthält Zahlen oder Kurven, die nicht berechnet werden können.") from None
    if refused:
        raise DrawingError(
            "Die SVG-Datei enthält transform-Angaben (an: " + ", ".join(sorted(refused)) + "). "
            "Sie werden nicht angewendet, die Größe wäre falsch. Bitte im Zeichenprogramm alle "
            "Transformationen auf die Pfade anwenden und neu speichern.")
    w, h = root.get("width"), root.get("height")
    vb = re.findall(_NUM, root.get("viewBox") or "")
    unit = re.search(r"[a-zA-Z%]+\s*$", w or "")
    if unit and unit.group(0).lower() not in ("px", "mm"):
        out.notes.append(f"Die Breite ist in „{unit.group(0)}“ angegeben; gelesen wird trotzdem 1 Einheit = 1 mm.")
    elif w and h and len(vb) == 4 and float(vb[2]) > 0 and abs(_f(w) / float(vb[2]) - 1) > 0.01:
        out.notes.append("width und viewBox weichen voneinander ab; gelesen wird 1 Einheit des viewBox = 1 mm.")
    if open_n[0]:
        out.skipped.append(f"{open_n[0]} offene Züge ohne Schluss wurden übersprungen.")
    for what, n in sorted(not_read.items()):
        out.skipped.append(f"{what} ({n}) werden nicht gelesen.")
    if not flipped:
        raise DrawingError("Keine geschlossene Kontur gefunden. Gelesen werden polygon, polyline, rect, "
                           "circle, ellipse und path.")
    rings.extend(flipped)
    group_rings(rings, out)
    return out


# --------------------------------------------------------------------------
# Datenbank
# --------------------------------------------------------------------------
def to_dict(d: Drawing, full: bool = False) -> dict:
    out = {"id": d.id, "name": d.name, "note": d.note, "source": d.source,
           "width": d.width, "height": d.height, "area": d.area, "cut_len": d.cut_len,
           "n_holes": len(d.holes or []),
           "created_at": d.created_at.isoformat() if d.created_at else None,
           "created_by": d.created_by,
           "updated_at": d.updated_at.isoformat() if d.updated_at else None}
    if full:
        out.update(outer=d.outer, holes=d.holes or [])
    else:
        out["preview"] = preview(d)
    return out


def _rdp(pts: list, tol: float) -> list:
    """Ramer-Douglas-Peucker ohne Rekursion, die Abstände je Teilstück mit numpy."""
    if len(pts) < 4:
        return pts
    arr = np.asarray(pts, dtype=float)
    keep = np.zeros(len(pts), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = arr[a + 1:b]
        d = arr[b] - arr[a]
        norm = float(np.hypot(d[0], d[1]))
        if norm:
            dist = np.abs(d[0] * (arr[a, 1] - seg[:, 1]) - (arr[a, 0] - seg[:, 0]) * d[1]) / norm
        else:
            dist = np.hypot(seg[:, 0] - arr[a, 0], seg[:, 1] - arr[a, 1])
        at = int(np.argmax(dist))
        if dist[at] > tol:
            keep[a + 1 + at] = True
            stack += [(a, a + 1 + at), (a + 1 + at, b)]
    return [p for p, k in zip(pts, keep) if k]


def preview(d: Drawing) -> dict:
    tol = max(d.width, d.height) / 250
    simple = lambda r: _rdp(r, tol)                         # noqa: E731
    return {"outer": simple(d.outer), "holes": [simple(h) for h in (d.holes or [])[:12]]}


def search(db: Session, q: str = "", limit: int = 200, offset: int = 0) -> dict:
    query = db.query(Drawing)
    q = q.strip()[:80]
    if q:
        like = f"%{q.lower().replace('%', '').replace('_', '')}%"
        query = query.filter(or_(func.lower(Drawing.name).like(like), func.lower(Drawing.note).like(like)))
    total = query.count()
    rows = query.order_by(Drawing.updated_at.desc(), Drawing.id.desc()).offset(offset).limit(limit).all()
    return {"total": total, "items": [to_dict(r) for r in rows]}


def get(db: Session, drawing_id: int) -> Drawing:
    d = db.get(Drawing, drawing_id)
    if not d:
        raise DrawingError("Zeichnung nicht gefunden.", 404)
    return d


def store(db: Session, parsed: Parsed, source: str, name: str, note: str, actor: str) -> dict:
    """Prüft jede Zeichnung einzeln: was nicht taugt, steht mit Grund in ``skipped``;
    der Rest wird in einer Transaktion gespeichert, mit je einer Zeile im Protokoll."""
    base = clean_name(name)
    note = (note or "").strip()[:500]
    skipped = list(parsed.skipped)
    good: list[dict] = []
    for k, (outer, holes) in enumerate(parsed.shapes, 1):
        label = f"Teil {k}" if len(parsed.shapes) > 1 else "Zeichnung"
        try:
            good.append(build(outer, holes, label))
        except DrawingError as exc:
            skipped.append(exc.detail)
    if len(good) > MAX_PER_IMPORT:
        skipped.append(f"{len(good) - MAX_PER_IMPORT} weitere Teile über der Grenze von {MAX_PER_IMPORT} je Datei wurden übersprungen.")
        good = good[:MAX_PER_IMPORT]
    if not good:
        raise DrawingError(" ".join(skipped) or "Keine brauchbare Zeichnung gefunden.")
    if db.query(Drawing).count() + len(good) > MAX_LIBRARY:
        raise DrawingError(f"Die Bibliothek fasst höchstens {MAX_LIBRARY} Zeichnungen. Bitte erst alte löschen.", 409)
    made = []
    for k, cols in enumerate(good, 1):
        d = Drawing(name=base if len(good) == 1 else clean_name(f"{base} {k}"), note=note,
                    source=source, created_by=actor, **cols)
        db.add(d)
        db.flush()
        db.add(AuditLog(actor=actor, action="drawing_create", entity="drawing", entity_id=str(d.id),
                        detail={"name": d.name, "source": source, "width": d.width, "height": d.height,
                                "rings": 1 + len(d.holes)}))
        made.append(d)
    db.commit()
    for d in made:
        db.refresh(d)
    return {"created": [to_dict(d) for d in made], "skipped": skipped, "notes": parsed.notes}


def rename(db: Session, drawing_id: int, name: str | None, note: str | None, actor: str) -> Drawing:
    d = get(db, drawing_id)
    before = {"name": d.name, "note": d.note}
    if name is not None:
        new = clean_name(name, "")
        if not new:
            raise DrawingError("Der Name darf nicht leer sein.")
        d.name = new
    if note is not None:
        d.note = note.strip()[:500]
    if (d.name, d.note) != (before["name"], before["note"]):
        db.add(AuditLog(actor=actor, action="drawing_rename", entity="drawing", entity_id=str(d.id),
                        detail={"before": before, "after": {"name": d.name, "note": d.note}}))
        db.commit()
        db.refresh(d)
    return d


def delete(db: Session, drawing_id: int, actor: str) -> None:
    d = get(db, drawing_id)
    db.add(AuditLog(actor=actor, action="drawing_delete", entity="drawing", entity_id=str(d.id),
                    detail={"name": d.name, "source": d.source}))
    db.delete(d)
    db.commit()


def parse_dxf(data: bytes) -> Parsed:
    try:
        return _parse_dxf(data)
    except DrawingError:
        raise
    except (OverflowError, ZeroDivisionError, RecursionError, MemoryError):
        raise DrawingError("Die DXF-Datei enthält Zahlen oder Kurven, die nicht berechnet werden können.") from None
