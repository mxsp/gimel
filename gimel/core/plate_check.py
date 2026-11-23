"""Prüfung und Kennzahlen einer von Hand gesetzten Plattenbelegung.

Die Prüfung ist ``kerf.verify`` mit exakten Polygonen, keine zweite Rechnung
daneben. Rechnet nur auf dem, was der Aufrufer aus dem gespeicherten Plan gibt.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from . import kerf
from .geometry import gross_area, holes_of
from .nesting import EPS, corner_sq
from .nesting_kerf import _in_ring, rings_of

#: Gekrümmte Kanten sind Sehnenzüge mit 0,1 mm Fehler je Teil. Ohne diese Reserve
#: fiele eine Lage durch, die lite oder Kerf exakt auf Abstand gesetzt haben.
CHORD_TOLERANCE = 0.2
#: Gerade Kanten sind exakt; es bleibt nur die Rundung der Koordinaten auf 0,001 mm.
STRAIGHT_TOLERANCE = 0.01


@dataclass(frozen=True)
class Window:
    """Die Regeln einer Platte: Format, Abstände, Beschnitt, Eckschranke."""

    w: float
    h: float
    gap: float = 0.0
    margin: float = 0.0
    trim_w: float = 0.0
    trim_h: float = 0.0
    #: Kein Teil weiter als n mm von der Nullecke des Fensters, wie ``corner_sq``
    #: in ``nesting.py``. ``None`` oder 0 heißt: keine Schranke bekannt.
    corner_max: Optional[float] = None

    @property
    def off_x(self) -> float:
        return max(0.0, self.trim_w) / 2

    @property
    def off_y(self) -> float:
        return max(0.0, self.trim_h) / 2


@dataclass
class _Shape:
    shape: Optional[dict]
    od: float
    di: float


def _rings(item: dict) -> list:
    rings = rings_of(_Shape(item.get("shape"), float(item.get("od") or 0), float(item.get("di") or 0)))
    if item.get("mirror"):
        return [[[-x, y] for x, y in ring] for ring in rings]
    return rings


def local_rings(item: dict) -> list:
    """Das Teil als Polygone um seinen Mittelpunkt; das zeichnet der Editor."""
    return [[[round(x, 3), round(y, 3)] for x, y in ring] for ring in _rings(item)]


def _german(issue: str) -> str:
    text = issue.replace("#0", "").replace(" leaves the usable area of sheet 1", " liegt außerhalb der Nutzfläche")
    text = text.replace(" overlaps ", " überlappt ").replace(" are ", " haben ").replace(" apart (min ", " Abstand (mindestens ")
    return text.replace(" and ", " und ")


def _straight_edge(geo: dict) -> bool:
    kind = geo.get("kind")
    return kind == "poly" or (kind == "rect" and not float(geo.get("r") or 0))


def _straight(item: dict) -> bool:
    """Nur gerade Kanten? Ein Teil ohne Kontur ist ein Ring, also gekrümmt."""
    shape = item.get("shape") if isinstance(item.get("shape"), dict) else None
    outer = shape.get("outer") if shape else None
    if not isinstance(outer, dict):
        return False
    return all(_straight_edge(g) for g in [outer, *holes_of(shape)] if isinstance(g, dict))


def _reduced(value: float, tolerance: float) -> float:
    """Der Prüfwert unter einem Abstand. Die Reserve frisst höchstens die Hälfte:
    ein echter Abstand von 0,2 mm darf nicht zu „kein Abstand" werden."""
    return max(value - tolerance, value / 2, 0.0)


def _verify(window: Window, items: list[dict], tolerance: float, limit: Optional[int]) -> list[str]:
    uw, uh = window.w - max(0.0, window.trim_w), window.h - max(0.0, window.trim_h)
    parts, placements = [], []
    for i, item in enumerate(items):
        rings = _rings(item)
        parts.append({"id": str(item["tag"]), "quantity": 1, "outer": rings[0], "holes": rings[1:]})
        placements.append({"partIndex": i, "partId": str(item["tag"]), "instance": 0, "sheet": 0,
                           "tx": float(item["cx"]) - window.off_x, "ty": float(item["cy"]) - window.off_y,
                           "rotation": float(item.get("rot") or 0)})
    job = {"sheet": {"width": uw, "height": uh}, "parts": parts,
           "spacing": _reduced(window.gap, tolerance),
           "margin": _reduced(window.margin, CHORD_TOLERANCE)}
    return [_german(i) for i in kerf.verify(job, {"placements": placements}, limit)["issues"]]


def _corner_issues(window: Window, items: list[dict]) -> list[str]:
    """Die Eckschranke des Kerns: äußere Ecke der Standfläche, gerechnet im Fenster."""
    if not window.corner_max or window.corner_max <= 0:
        return []
    limit = window.corner_max * window.corner_max
    out = []
    for item in items:
        ring = kerf.rot_ring(_rings(item)[0], float(item.get("rot") or 0))
        box = kerf.bbox(ring)
        d2 = corner_sq(float(item["cx"]) - window.off_x, float(item["cy"]) - window.off_y,
                       (box["maxx"] - box["minx"]) / 2, (box["maxy"] - box["miny"]) / 2)
        if d2 > limit + EPS:
            out.append(f"{item['tag']} liegt weiter als {window.corner_max:g} mm von der Nullecke")
    return out


def check_plate(window: Window, items: list[dict], max_issues: Optional[int] = None) -> dict:
    """``{"valid", "issues"}`` für eine Platte; jedes Teil trägt ``tag, cx, cy, rot``.

    ``max_issues`` beendet die Suche, sobald so viele gefunden sind. Gerade Paare
    werden strenger geprüft als alles mit einer gekrümmten Kante: ein Paar ist nur
    so ungenau wie seine Sehnen, und ein gerades hat keine."""
    straight = [item for item in items if _straight(item)]
    tolerance = STRAIGHT_TOLERANCE if len(straight) == len(items) else CHORD_TOLERANCE
    issues = _verify(window, items, tolerance, max_issues)
    if tolerance != STRAIGHT_TOLERANCE and len(straight) > 1:
        left = None if max_issues is None else max_issues - len(issues)
        if left is None or left > 0:
            issues += [i for i in _verify(window, straight, STRAIGHT_TOLERANCE, None)
                       if i not in issues][:left]
    issues += _corner_issues(window, items)
    if max_issues is not None:
        issues = issues[:max_issues]
    return {"valid": not issues, "issues": issues}


def _placed(item: dict) -> list:
    return [[x + float(item["cx"]), y + float(item["cy"])]
            for x, y in kerf.rot_ring(_rings(item)[0], float(item.get("rot") or 0))]


def in_hole_of(items: list[dict]) -> set:
    """Tags der Teile, die ganz im Loch eines anderen liegen: sie werden vor dem Wirt geschnitten."""
    holes = []
    for item in items:
        for ring in _rings(item)[1:]:
            turned = kerf.rot_ring(ring, float(item.get("rot") or 0))
            holes.append((item["tag"], [[x + float(item["cx"]), y + float(item["cy"])] for x, y in turned]))
    inside = set()
    for item in items:
        corners = _placed(item)
        if any(owner != item["tag"] and all(_in_ring(x, y, ring) for x, y in corners)
               for owner, ring in holes):
            inside.add(item["tag"])
    return inside


def plate_metrics(window: Window, items: list[dict], turned: bool = False) -> dict:
    """``used_h``, ``fill``, ``utilisation`` und Flächen, gerechnet wie im Sammellauf:
    das Schnittband reicht von der Plattenkante bis zum letzten Teil plus Rand, und
    jedes Teil zählt mit seiner Außenkontur, auch ein Gast im Loch (``batch.py``)."""
    axis = 0 if turned else 1
    length = window.w if turned else window.h
    band_w = window.h if turned else window.w
    reach = max((max(p[axis] for p in _placed(item)) for item in items), default=0.0)
    used = min(length, reach + window.margin)
    area = 0.0
    for item in items:
        outer = gross_area(item.get("shape"))
        area += outer / 1e6 if outer > 0 else math.pi * (float(item.get("od") or 0) / 1000) ** 2 / 4
    used_area = (band_w / 1000) * (used / 1000)
    return {"used_h": round(used, 3), "fill": min(1.0, used / length) if length else 0.0,
            "used_area_m2": used_area, "plate_area_m2": (window.w / 1000) * (window.h / 1000),
            "utilisation": area / used_area if used_area else 0.0}
