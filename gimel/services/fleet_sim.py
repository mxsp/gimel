"""Flottensimulation für geplante Roboter — Daten holen, Kern rechnen lassen.

Die geplanten Roboter gibt es nur in dieser Rechnung und in gespeicherten
Szenarien (``fleet_scenarios``). Sie sind keine ``RobotAsset``-Zeilen, bekommen
nie einen Transportauftrag und tauchen in keiner Zuteilung auf. Der Bedarf
kommt aus dem echten Materialfluss dieser Ebene, die Wege aus ihrem Gangnetz.
Gerechnet wird in ``gimel.core.fleet_sim`` — rein, gesät, ohne Uhr.
"""

from __future__ import annotations

import math

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..core import fleet_sim as core
from ..core.layout import Layout
from ..core.route_improve import safe_leg
from ..models import FactoryFloor, FactoryStation, RobotAsset, WorkOrder, WorkOrderStatus
from .robot_ways import _first_floor_id, floor_id_of_station, station_bodies

#: Arbeitstage, aus denen die Tagesmenge geschätzt wird.
WINDOW_DAYS = 14
WORKDAYS_IN_WINDOW = 10


class SimError(ValueError):
    pass


def _floor(db: Session, floor_id: Optional[int]) -> FactoryFloor:
    row = db.get(FactoryFloor, floor_id) if floor_id else None
    if row is None and not floor_id:
        row = db.query(FactoryFloor).order_by(FactoryFloor.id.asc()).first()
    if row is None:
        raise SimError("Ebene nicht gefunden.")
    return row


def _stations_on(db: Session, floor_id: int) -> list[FactoryStation]:
    default_floor_id = _first_floor_id(db)
    return [s for s in db.query(FactoryStation).filter(FactoryStation.active.is_(True)).all()
            if floor_id_of_station(db, s, default_floor_id=default_floor_id) == floor_id]


def _robots_on(db: Session, floor_id: int) -> list[RobotAsset]:
    default_floor_id = _first_floor_id(db)
    return [
        r for r in db.query(RobotAsset).filter(RobotAsset.active.is_(True)).all()
        if (r.floor_id if r.floor_id is not None else default_floor_id) == floor_id
    ]


def _home(floor: FactoryFloor, stations: list[FactoryStation]) -> tuple[float, float]:
    """Wo geplante Roboter stehen, bevor die Schicht beginnt: am Lager, sonst am
    ersten Tor, sonst in der Mitte der Stationen."""
    stores = [s for s in stations if s.is_storage]
    if stores:
        return (float(stores[0].x or 0.0), float(stores[0].y or 0.0))
    doors = floor.doors or []
    if doors:
        return (float(doors[0].get("x", 0.0)), float(doors[0].get("y", 0.0)))
    if stations:
        return (sum(float(s.x or 0) for s in stations) / len(stations),
                sum(float(s.y or 0) for s in stations) / len(stations))
    return (0.0, 0.0)


def _type(s: FactoryStation) -> str:
    return s.type.value if hasattr(s.type, "value") else str(s.type)


def floor_flow(db: Session, floor: FactoryFloor, stations: list[FactoryStation]) -> tuple[list[dict], int]:
    """Materialfluss nur dieser Ebene: Lager → Station → Versand, je Innenauftrag.

    Wie ``factory_router.material_flow``, aber mit Lager und Versand derselben
    Ebene — ein Roboter fährt keine Treppe. Liefert Kanten und die Zahl der
    Innenaufträge, die dahinterstehen."""
    ids = {s.id: s for s in stations}
    stores = [s for s in stations if s.is_storage]
    ships = [s for s in stations if _type(s) == "shipping"]
    rows = (db.query(WorkOrder).filter(WorkOrder.station_id.isnot(None))
            .filter(WorkOrder.status != WorkOrderStatus.cancelled)
            .order_by(WorkOrder.created_at.desc()).limit(300).all())
    edges: dict[tuple[int, int], dict] = {}
    used = 0

    def add(a: FactoryStation, b: FactoryStation, kind: str) -> None:
        if a.id == b.id:
            return
        e = edges.setdefault((a.id, b.id), {"from": a.id, "to": b.id, "kind": kind, "count": 0})
        e["count"] += 1

    def near(pool: list[FactoryStation], to: FactoryStation) -> Optional[FactoryStation]:
        return min(pool, key=lambda s: (float(s.x or 0) - float(to.x or 0)) ** 2
                   + (float(s.y or 0) - float(to.y or 0)) ** 2) if pool else None

    for wo in rows:
        st = ids.get(int(wo.station_id or 0))
        if st is None or st.is_storage or _type(st) == "shipping":
            continue
        used += 1
        pool = [s for s in stores if not s.materials or wo.mat in s.materials] or stores
        src = near(pool, st)
        if src is not None:
            add(src, st, "supply")
        dst = near(ships, st)
        if dst is not None:
            add(st, dst, "dispatch")
    return sorted(edges.values(), key=lambda e: -e["count"]), used


def defaults(db: Session, floor_id: Optional[int], *, now: Optional[datetime] = None) -> dict:
    """Vorschlag für ein Szenario: Bedarf je Schicht, Startpunkt, vorhandene Roboter."""
    floor = _floor(db, floor_id)
    stations = _stations_on(db, floor.id)
    ids = {s.id for s in stations}
    edges, used = floor_flow(db, floor, stations)
    total_edges = sum(int(e["count"]) for e in edges)
    # Wie viele Transporte bringt ein Innenauftrag? Aus demselben Fenster wie der Fluss.
    window = (db.query(WorkOrder).filter(WorkOrder.station_id.isnot(None))
              .filter(WorkOrder.status != WorkOrderStatus.cancelled)
              .order_by(WorkOrder.created_at.desc()).limit(300).all())
    on_floor = [w for w in window if w.station_id in ids]
    per_wo = total_edges / used if used else 0.0
    since = (now or datetime.now(timezone.utc)) - timedelta(days=WINDOW_DAYS)
    recent = 0
    for w in on_floor:
        created = w.created_at
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created is not None and created >= since:
            recent += 1
    if recent:
        estimate = round(recent / WORKDAYS_IN_WINDOW * per_wo)
        basis = (f"{recent} Innenaufträge der letzten {WINDOW_DAYS} Tage auf dieser Ebene "
                 f"(≈ {per_wo:.1f} Transporte je Innenauftrag, {WORKDAYS_IN_WINDOW} Arbeitstage)")
    else:
        estimate = min(120, total_edges)
        basis = "kein Innenauftrag in den letzten 14 Tagen — Menge aus dem gezählten Fluss"
    existing = _robots_on(db, floor.id)
    home = _home(floor, stations)
    return {
        "floor_id": floor.id,
        "per_shift": max(1, min(core.MAX_DEMANDS, int(estimate))) if edges else 0,
        "basis": basis,
        "edges": len(edges),
        "start": [round(home[0], 2), round(home[1], 2)],
        "existing": [{"id": r.id, "name": r.name, "kind": r.kind, "speed_m_s": r.speed_m_s,
                      "simulated": (r.gateway_id or "sim") == "sim"} for r in existing],
        "limits": {"robots": core.MAX_ROBOTS, "per_shift": core.MAX_DEMANDS,
                   "horizon_h": core.MAX_HORIZON_S // 3600, "sizing": core.MAX_SIZING},
    }


def _robot_start(r: RobotAsset, fallback: tuple[float, float]) -> tuple[float, float]:
    if r.x is not None and r.y is not None:
        return (float(r.x), float(r.y))
    route = [p for p in (r.route or []) if isinstance(p, (list, tuple)) and len(p) >= 2]
    if route:
        return (float(route[0][0]), float(route[0][1]))
    return fallback


def run(db: Session, floor_id: Optional[int], params: dict) -> dict:
    """Ein Szenario rechnen. Schreibt nichts."""
    floor = _floor(db, floor_id)
    stations = _stations_on(db, floor.id)
    if len(stations) < 2:
        raise SimError("Zu wenige Stationen auf dieser Ebene für Transporte.")
    points = {s.id: (float(s.x or 0.0), float(s.y or 0.0)) for s in stations}
    edges, _ = floor_flow(db, floor, stations)
    if not edges:
        raise SimError("Kein Materialfluss auf dieser Ebene — es gibt nichts zu transportieren.")
    horizon_s = float(params["horizon_h"]) * 3600
    demands = core.demand_from_flow(edges, round(int(params["per_shift"]) * float(params.get("load_factor", 1.0))),
                                    horizon_s, seed=int(params.get("seed", 1)))
    layout = Layout.from_row(floor)

    bodies = station_bodies(db, floor.id)

    def way(a: core.Point, b: core.Point) -> core.Way:
        # Derselbe Weg wie für echte Transporte: Gangnetz, Umweg um Körper.
        pts, kind = safe_leg(layout, a, b, bodies)
        metres = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
        return core.Way(points=tuple(pts), metres=metres, exact=kind in ("netz", "umweg"))

    home = _home(floor, stations)
    fleet: list[core.SimRobot] = []
    for i, spec in enumerate(params.get("planned") or []):
        for k in range(int(spec.get("count", 1))):
            fleet.append(core.SimRobot(
                id=f"p{i + 1}-{k + 1}", name=(spec.get("name") or f"Geplant {i + 1}") + (f" {k + 1}" if int(spec.get("count", 1)) > 1 else ""),
                kind=str(spec.get("kind") or "amr"), speed_m_s=float(spec.get("speed_m_s") or 1.0),
                # Nebeneinander am Startplatz, nicht alle auf demselben Punkt.
                start=(home[0] + 1.6 * (len(fleet) % 4), home[1] + 1.6 * (len(fleet) // 4)),
                handling_s=float(params.get("handling_s", 60)), planned=True))
    base: list[core.SimRobot] = []
    if params.get("include_existing"):
        for r in _robots_on(db, floor.id):
            base.append(core.SimRobot(
                id=f"r{r.id}", name=r.name, kind=r.kind, speed_m_s=float(r.speed_m_s or 0.8),
                start=_robot_start(r, home), handling_s=float(params.get("handling_s", 60)), planned=False))
    robots = (base + fleet)[:core.MAX_ROBOTS]
    if not robots:
        raise SimError("Keine Roboter im Szenario — mindestens einen geplanten Roboter anlegen.")
    target = float(params.get("wait_target_min", 10)) * 60
    result = core.simulate(robots, demands, points, way, horizon_s, late_after_s=target)
    out = {
        "floor_id": floor.id,
        "summary": result.summary(),
        "tracks": {rid: [s.as_dict() for s in segs] for rid, segs in result.tracks.items()},
        "demands": [{"id": d.id, "from": d.from_id, "to": d.to_id, "release_s": round(d.release_s, 1),
                     "kind": d.kind} for d in demands],
        "stations": {str(s.id): s.label for s in stations},
        "sizing": None,
        "notes": [
            "Simulation mit geplanten Robotern — keine echten Transportaufträge, nichts gespeichert.",
            "Bedarf aus dem Materialfluss dieser Ebene, über die Schicht gestreut (Startwert "
            f"{int(params.get('seed', 1))}). Jede Kennzahl ist eine Schätzung.",
        ],
    }
    if result.estimated_ways:
        out["notes"].append(f"{result.estimated_ways} Wege ohne Gangnetz als Luftlinie geschätzt.")
    if params.get("sizing") and fleet:
        out["sizing"] = core.size_fleet(fleet[0], base, demands, points, way, horizon_s,
                                        target_p90_s=target, upto=int(params.get("sizing_upto", 6)))
    return out
