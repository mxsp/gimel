"""Reine Roboterbewegung: ein Punkt auf einem Weg, sonst nichts.

Ein Roboter ist im Zwilling zuerst eine *Stelle* und eine *Richtung*. Diese
Datei rechnet beides aus einem Linienzug und einer zurückgelegten Strecke —
ohne Uhr, ohne Netz, ohne Datenbank. Die Uhr und die echte Flotte kommen aus
``services/robot_fleet``; hier steht nur die Geometrie, die ein Simulator und
eine echte Weganzeige gemeinsam brauchen.

Zwei Betriebsarten, mehr braucht die erste Ausbaustufe nicht:

* ``loop`` — der Weg ist ein Rundkurs, das letzte Stück schließt zum ersten.
* ``pingpong`` — der Roboter fährt hin und zurück; dieselbe Strecke, andere
  Richtung. Das ist der ehrliche Weg für eine Halle, deren Gangnetz noch keine
  geschlossene Runde hergibt.

Die Richtung ist ein Winkel in Grad gegen Osten, im selben Koordinatensystem
wie der Grundriss (x nach Osten, y nach Süden). Die 3D-Ansicht dreht daraus
``-heading`` um die Hochachse — dieselbe Regel wie bei einer Station.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Sequence

Point = tuple[float, float]


@dataclass(frozen=True)
class PathPose:
    """Wo ein Roboter nach einer Strecke steht und wohin er schaut."""

    x: float
    y: float
    heading_deg: float
    distance_m: float
    route_m: float
    segment: int


def _points(raw: Sequence[Sequence[float]]) -> list[Point]:
    out: list[Point] = []
    for p in raw or ():
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            continue
        if math.isfinite(x) and math.isfinite(y):
            out.append((x, y))
    return out


def _segments(points: list[Point], *, loop: bool) -> list[tuple[Point, Point, float]]:
    segs: list[tuple[Point, Point, float]] = []
    for a, b in zip(points, points[1:]):
        length = math.dist(a, b)
        if not math.isfinite(length):
            return []
        segs.append((a, b, length))
    if loop and len(points) >= 2 and math.dist(points[-1], points[0]) > 1e-9:
        length = math.dist(points[-1], points[0])
        if not math.isfinite(length):
            return []
        segs.append((points[-1], points[0], length))
    return segs


def route_length_m(raw: Sequence[Sequence[float]], *, loop: bool = False) -> float:
    """Länge des Weges in Metern. ``loop`` schließt die letzte Lücke."""
    points = _points(raw)
    if len(points) < 2:
        return 0.0
    return sum(length for _a, _b, length in _segments(points, loop=loop))


def pose_on_route(
    raw: Sequence[Sequence[float]],
    distance_m: float,
    *,
    loop: bool = False,
) -> PathPose | None:
    """Punkt und Richtung nach ``distance_m`` — oder None ohne brauchbaren Weg.

    ``pingpong`` spiegelt die Strecke an ihrem Ende. Ein negativer Abstand ist
    erlaubt und wird genauso gespiegelt; so kann ein Aufrufer eine kleine
    Zeitdifferenz abziehen, ohne vorher zu prüfen.
    """
    points = _points(raw)
    if len(points) < 2:
        return None
    segs = _segments(points, loop=loop)
    total = sum(length for _a, _b, length in segs)
    if total <= 1e-9:
        return PathPose(points[0][0], points[0][1], 0.0, 0.0, 0.0, 0)

    reverse = False
    if loop:
        d = float(distance_m) % total
    else:
        period = total * 2.0
        d = float(distance_m) % period
        if d < 0:
            d += period
        if d > total:
            reverse = True
            d = period - d

    run = 0.0
    for i, (a, b, length) in enumerate(segs):
        if length <= 1e-9:
            continue
        if run + length >= d - 1e-12:
            u = 0.0 if length <= 0 else max(0.0, min(1.0, (d - run) / length))
            x = a[0] + (b[0] - a[0]) * u
            y = a[1] + (b[1] - a[1]) * u
            heading = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
            if reverse:
                heading += 180.0
            return PathPose(
                x=round(x, 4),
                y=round(y, 4),
                heading_deg=round(heading % 360.0, 2),
                distance_m=round(d, 4),
                route_m=round(total, 4),
                segment=i,
            )
        run += length

    end = segs[-1][1] if segs else points[-1]
    return PathPose(end[0], end[1], 0.0, round(total, 4), round(total, 4), max(0, len(segs) - 1))
