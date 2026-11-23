"""Förderbänder einer Ebene: Gestalt und Grundfläche (2026-11-07).

Ein Förderband ist Hallenausstattung, keine Station: es plant nichts, es hat
keine Warteschlange. Es liegt als ``FactoryFloor.conveyors`` im Grundriss:

    {"name": "Förderband Nacharbeit → Versand", "points": [[x, y, z], ...],
     "width": 0.8, "from_station_id": 6, "to_station_id": 7}

``points`` ist die Mittellinie des Bandes in Förderrichtung; ``z`` ist die
Bandhöhe in Metern über dem Boden (fehlt sie, gilt ``DEFAULT_Z_M``). Zwischen
zwei Punkten steigt oder fällt das Band gleichmäßig.

Für Wege und Kollisionen zählt nur, was im Weg steht: Abschnitte, deren
Unterkante unter ``CLEAR_UNDER_M`` liegt, sind Körper; eine Brücke darüber ist
frei — dort stehen nur die Stützen an den Eckpunkten. Rein: keine Datenbank,
keine Uhr. Die Oberfläche rechnet dieselbe Regel (``web/src/components/twin/conveyor.ts``).
"""

from __future__ import annotations

import math
from typing import Sequence

#: Bandhöhe, wenn ein Punkt keine Höhe trägt (Arbeitshöhe am Tisch).
DEFAULT_Z_M = 0.9
#: Darunter passt ein Roboter mit Ladung nicht durch.
CLEAR_UNDER_M = 2.3
#: Bauhöhe des Bandes unter der Bandoberkante (Rahmen, Rollen).
DEPTH_M = 0.25
#: Kantenlänge einer Stütze unter einem hohen Eckpunkt.
POST_M = 0.35
#: Grenzen, damit ein Grundriss kein Band mit tausend Punkten trägt.
MAX_POINTS = 32
WIDTH_MIN_M, WIDTH_MAX_M = 0.3, 2.0

Point3 = tuple[float, float, float]
Poly = list[tuple[float, float]]


def points3(raw: object) -> list[Point3]:
    """Punkte (x, y[, z]) aus dem JSON; Unbrauchbares fällt weg, nie ein Fehler."""
    out: list[Point3] = []
    for p in (raw or [])[:MAX_POINTS]:  # type: ignore[index]
        try:
            x, y = float(p[0]), float(p[1])
            z = float(p[2]) if len(p) > 2 and p[2] is not None else DEFAULT_Z_M
        except (TypeError, ValueError, IndexError):
            continue
        if all(math.isfinite(v) for v in (x, y, z)):
            out.append((x, y, max(0.1, min(8.0, z))))
    return out


def width_of(raw: object) -> float:
    try:
        w = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.8
    return max(WIDTH_MIN_M, min(WIDTH_MAX_M, w)) if math.isfinite(w) else 0.8


def _rect(a: tuple[float, float], b: tuple[float, float], half: float) -> Poly:
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / L * half, dx / L * half
    return [(a[0] + nx, a[1] + ny), (b[0] + nx, b[1] + ny), (b[0] - nx, b[1] - ny), (a[0] - nx, a[1] - ny)]


def footprint(points: Sequence[Point3], width: float) -> list[Poly]:
    """Was am Boden im Weg steht: niedrige Abschnitte als Rechtecke, Stützen
    unter hohen Eckpunkten als kleine Quadrate."""
    pts = list(points)
    half = width / 2.0
    out: list[Poly] = []
    for (ax, ay, az), (bx, by, bz) in zip(pts, pts[1:]):
        length = math.hypot(bx - ax, by - ay)
        if length < 1e-6:
            continue
        # Teilstück, dessen Unterkante unter der Durchfahrtshöhe liegt.
        lo_a, lo_b = az - DEPTH_M, bz - DEPTH_M
        if lo_a >= CLEAR_UNDER_M and lo_b >= CLEAR_UNDER_M:
            continue
        if lo_a < CLEAR_UNDER_M and lo_b < CLEAR_UNDER_M:
            u0, u1 = 0.0, 1.0
        else:
            u = (CLEAR_UNDER_M - lo_a) / (lo_b - lo_a)
            u0, u1 = (0.0, u) if lo_a < CLEAR_UNDER_M else (u, 1.0)
        a = (ax + (bx - ax) * u0, ay + (by - ay) * u0)
        b = (ax + (bx - ax) * u1, ay + (by - ay) * u1)
        if math.dist(a, b) > 1e-3:
            out.append(_rect(a, b, half))
    s = POST_M / 2.0
    for x, y, z in pts:
        if z - DEPTH_M >= CLEAR_UNDER_M:
            out.append([(x - s, y - s), (x + s, y - s), (x + s, y + s), (x - s, y + s)])
    return out


def length_m(points: Sequence[Point3]) -> float:
    pts = list(points)
    return sum(math.dist((a[0], a[1], a[2]), (b[0], b[1], b[2])) for a, b in zip(pts, pts[1:]))


def bodies(raw_conveyors: object) -> list[tuple[str, Poly]]:
    """Alle Grundflächen aller Bänder eines Grundrisses, mit Namen."""
    out: list[tuple[str, Poly]] = []
    for c in raw_conveyors or []:  # type: ignore[union-attr]
        if not isinstance(c, dict):
            continue
        pts = points3(c.get("points"))
        if len(pts) < 2:
            continue
        name = str(c.get("name") or "Förderband")
        for poly in footprint(pts, width_of(c.get("width"))):
            out.append((name, poly))
    return out
