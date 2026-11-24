"""Wege für Roboter aus dem gespeicherten Grundriss.

Diese Datei ist die Naht zwischen ``core/robot_way`` und den Tabellen. Sie
löst Ebenen auf, weigert sich bei einem Wechsel zwischen Ebenen (ein Roboter
ohne Aufzug fährt nicht die Treppe) und liefert den Linienzug, den ein
Gateway wirklich fahren kann. Sie schreibt nichts.
"""

from __future__ import annotations

import math
from typing import Optional

from sqlalchemy.orm import Session

from ..core.layout import Layout
from ..core.robot_dispatch import RobotOption
from ..core.robot_way import plan_way, route_problems
from ..core.route_improve import improve, safe_leg
from ..models import FactoryFloor, FactoryStation, RobotAsset
from . import robot_fleet

Point = tuple[float, float]


class WayError(ValueError):
    """Kein Weg, den Gimel verantworten kann — mit Grund im Klartext."""


def _first_floor_id(db: Session) -> Optional[int]:
    row = db.query(FactoryFloor.id).order_by(FactoryFloor.id.asc()).first()
    return int(row[0]) if row else None


def floor_id_of_station(
    db: Session,
    station: FactoryStation,
    *,
    default_floor_id: Optional[int] = None,
) -> Optional[int]:
    """Ebene einer Station; leer heißt laut Hausregel die erste Ebene."""
    if station.floor_id:
        return int(station.floor_id)
    return default_floor_id if default_floor_id is not None else _first_floor_id(db)


def _floor(db: Session, floor_id: Optional[int]) -> FactoryFloor:
    row = db.get(FactoryFloor, floor_id) if floor_id else None
    if row is None and floor_id is None:
        row = db.query(FactoryFloor).order_by(FactoryFloor.id.asc()).first()
    if row is None:
        raise WayError("Keine Halle erfasst — es gibt keinen Weg.")
    return row


def _station(db: Session, station_id: int) -> FactoryStation:
    row = db.get(FactoryStation, station_id)
    if row is None:
        raise WayError("Station nicht gefunden.")
    return row


def _station_dict(station: FactoryStation, floor_id: Optional[int]) -> dict:
    return {
        "id": station.id,
        "label": station.label,
        "x": round(float(station.x or 0.0), 3),
        "y": round(float(station.y or 0.0), 3),
        "floor_id": floor_id,
    }


def station_bodies(db: Session, floor_id: Optional[int]) -> list[list[Point]]:
    """Stationskörper einer Ebene als Vierecke — für Wege, die nicht durch eine
    Maschine fahren dürfen."""
    default_floor_id = _first_floor_id(db)
    out: list[list[Point]] = []
    for s in db.query(FactoryStation).filter(FactoryStation.active.is_(True)).all():
        if floor_id_of_station(db, s, default_floor_id=default_floor_id) != floor_id:
            continue
        w, h = float(s.w or 0.0), float(s.h or 0.0)
        if w <= 0 or h <= 0:
            continue
        rot = math.radians(float(getattr(s, "rotation", 0.0) or 0.0))
        c, si = math.cos(rot), math.sin(rot)
        x, y = float(s.x or 0.0), float(s.y or 0.0)
        out.append([(x + dx * c - dy * si, y + dx * si + dy * c)
                    for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))])
    return out


_KIND_NOTE = {
    "netz": "über das Gangnetz",
    "umweg": "über das Gangnetz, mit Umweg um Hindernisse oder Stationen",
    "luft": "Luftlinie — frei von Hindernissen, aber ohne Gang",
    "blockiert": "Luftlinie — kein freier Weg gefunden, bitte Gangnetz prüfen",
}


def _safe_way(db: Session, layout: Layout, floor_id: Optional[int], a: Point, b: Point) -> dict:
    """Der Weg eines Roboters: über die Gänge, nie durch einen Körper."""
    pts, kind = safe_leg(layout, a, b, station_bodies(db, floor_id))
    metres = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    return {
        "route": [(round(x, 3), round(y, 3)) for x, y in pts],
        "route_m": round(metres, 3),
        "route_exact": kind in ("netz", "umweg"),
        "route_note": _KIND_NOTE[kind],
    }


def plan_between_stations(db: Session, from_station_id: int, to_station_id: int) -> dict:
    """Weg zwischen zwei Stationen derselben Ebene."""
    start = _station(db, from_station_id)
    end = _station(db, to_station_id)
    start_floor = floor_id_of_station(db, start)
    end_floor = floor_id_of_station(db, end)
    if start_floor != end_floor:
        raise WayError(
            "Andere Ebene — ein Roboterweg über Treppe oder Aufzug ist nicht erfasst."
        )
    row = _floor(db, start_floor)
    layout = Layout.from_row(row)
    way = _safe_way(db, layout, row.id, (float(start.x or 0.0), float(start.y or 0.0)),
                    (float(end.x or 0.0), float(end.y or 0.0)))
    return {
        "floor_id": row.id,
        "from": _station_dict(start, start_floor),
        "to": _station_dict(end, end_floor),
        **way,
    }


def plan_between_points(
    db: Session, floor_id: Optional[int], start: Point, end: Point
) -> dict:
    """Weg zwischen zwei freien Punkten einer Ebene — für Vorschauen."""
    row = _floor(db, floor_id)
    layout = Layout.from_row(row)
    return {"floor_id": row.id,
            **_safe_way(db, layout, row.id, (float(start[0]), float(start[1])), (float(end[0]), float(end[1])))}


def check_points(db: Session, floor_id: Optional[int], points: list[Point]) -> dict:
    """Einen gemeldeten Weg gegen Umriss und Hindernisse prüfen."""
    row = _floor(db, floor_id)
    layout = Layout.from_row(row)
    problems = route_problems(layout, [(float(p[0]), float(p[1])) for p in points])
    return {"floor_id": row.id, "ok": not problems, "problems": problems}


def optimize_way(
    db: Session,
    floor_id: Optional[int],
    points: list[Point],
    *,
    loop: bool = False,
) -> dict:
    """Einen noch nicht gespeicherten Roboterweg verbessern.

    Rechnet wie ``core/route_improve.improve``: über das Gangnetz, nie durch
    einen Körper, mit ehrlicher Luftlinie, wenn es keinen Gang gibt. Schreibt
    nichts — der Vorschlag geht erst mit dem Speichern des Roboters in die
    Tabelle. Anfang und Ende bleiben, wo sie sind.
    """
    row = _floor(db, floor_id)
    layout = Layout.from_row(row)
    result = improve(
        layout,
        [(float(p[0]), float(p[1])) for p in points],
        loop=loop,
        bodies=station_bodies(db, row.id),
    )
    return {"floor_id": row.id, **result.as_dict()}


def robot_options(db: Session, floor_id: int) -> list[RobotOption]:
    """Alle aktiven Roboter dieser Ebene mit ihrer *jetzigen* Position.

    Die Position kommt aus ``robot_fleet.as_dict``, damit ein simulierter
    Roboter nicht an seinem Startpunkt steht, während die Halle ihn längst
    weiter zeigt.
    """
    rows = (
        db.query(RobotAsset)
        .filter(RobotAsset.floor_id == floor_id)
        .filter(RobotAsset.active.is_(True))
        .order_by(RobotAsset.id.asc())
        .all()
    )
    options: list[RobotOption] = []
    for row in rows:
        view = robot_fleet.as_dict(row)
        x, y = view.get("x"), view.get("y")
        options.append(
            RobotOption(
                id=row.id,
                name=row.name or "Roboter",
                x=float(x) if x is not None else None,
                y=float(y) if y is not None else None,
                battery_pct=view.get("battery_pct"),
                payload_kg=float(view.get("payload_kg") or 0.0),
                capabilities=tuple(view.get("capabilities") or ()),
                state=str(view.get("state") or "idle"),
                active=bool(view.get("active")),
                floor_id=row.floor_id,
                speed_m_s=float(view.get("speed_m_s") or 0.0),
            )
        )
    return options


def drive_seconds(route_m: float, speed_m_s: float) -> float:
    """Fahrzeit in Sekunden; 0 heißt unbekannt, nicht sofort da."""
    if route_m <= 0 or speed_m_s <= 0:
        return 0.0
    seconds = route_m / speed_m_s
    return round(seconds, 1) if math.isfinite(seconds) else 0.0
