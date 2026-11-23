"""Roboterwege: der Linienzug aus dem Gangnetz und seine Prüfung.

Rein und deterministisch: derselbe Grundriss, dieselben Punkte, derselbe Weg.
Die Datei entscheidet nicht, *ob* ein Roboter fahren darf — sie sagt nur, wo
der Weg liegt und ob er die Halle oder ein Hindernis kreuzt. Geschwindigkeit,
Auftrag und Freigabe bleiben bei ``services/robot_jobs`` und beim Flotten-
Gateway.

Ein Roboterweg ist etwas anderes als eine Gehstrecke: die Zahl allein genügt
nicht, das Gateway braucht die Punkte. Deshalb liefert ``plan_way`` beides,
und bei ``exact=False`` ausdrücklich die Luftlinie — nie einen erfundenen
Gang.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .layout import (
    Layout,
    Point,
    point_in_polygon,
    segment_blocked,
    segment_leaves_outline,
)


@dataclass(frozen=True)
class WayPlan:
    """Ein geplanter Weg: Punkte, Länge und wie sicher die Rechnung ist."""

    points: list[Point] = field(default_factory=list)
    metres: float = 0.0
    exact: bool = False
    note: str = ""


def plan_way(layout: Layout, start: Point, end: Point) -> WayPlan:
    """Kürzester Weg über die Gänge — oder ehrlich die Luftlinie."""
    route = layout.path(start, end)
    return WayPlan(
        points=[(round(x, 3), round(y, 3)) for x, y in route.points],
        metres=round(route.metres, 3),
        exact=route.exact,
        note=route.note,
    )


def route_problems(layout: Layout, points: list[Point]) -> list[str]:
    """Was an einem von Hand gemeldeten Weg nicht stimmt — leer heißt in Ordnung.

    Geprüft wird nur, was ohne Annahmen entscheidbar ist: Anzahl der Punkte,
    Umriss und Hindernisse. Ob der Weg auf einem Gang liegt, ist eine Frage
    der Route, nicht der Sicherheit; ein Roboter darf auch einen freien Hof
    queren, wenn der Grundriss das hergibt.
    """
    if len(points) < 2:
        return ["Ein Weg braucht mindestens zwei Punkte."]
    problems: list[str] = []
    outline = layout.outline
    if len(outline) >= 3:
        for i, p in enumerate(points):
            if not point_in_polygon(p, outline):
                problems.append(f"Punkt {i + 1} liegt außerhalb der Halle.")
                break
    obstacles = [o.points for o in layout.obstacles if len(o.points) >= 3]
    for i, (a, b) in enumerate(zip(points, points[1:])):
        if obstacles and segment_blocked(a, b, obstacles):
            problems.append(f"Abschnitt {i + 1} kreuzt ein Hindernis.")
            break
        if len(outline) >= 3 and segment_leaves_outline(a, b, outline):
            problems.append(f"Abschnitt {i + 1} verlässt die Halle.")
            break
    return problems
