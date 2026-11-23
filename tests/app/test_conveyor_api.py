"""Förderbänder im Grundriss: API, ältere Editoren, Demo."""

from __future__ import annotations

from gimel import demo
from gimel.core.layout import Layout, segment_blocked
from gimel.core.robot_way import route_problems
from gimel.db import SessionLocal
from gimel.models import FactoryFloor, RobotAsset


def _floor_with_belt() -> FactoryFloor:
    with SessionLocal() as db:
        for f in db.query(FactoryFloor).all():
            if any(c.get("name") == demo.CONVEYOR_NAME for c in (f.conveyors or [])):
                db.expunge(f)
                return f
    raise AssertionError("die Demo trägt das Förderband")


def test_demo_has_the_belt_from_nacharbeit_to_versand(client):
    f = _floor_with_belt()
    body = client.get(f"/api/factory/floor?floor_id={f.id}").json()
    belt = next(c for c in body["conveyors"] if c["name"] == demo.CONVEYOR_NAME)
    assert len(belt["points"]) == len(demo.CONVEYOR_POINTS) and belt["from_station_id"] and belt["to_station_id"]
    assert any(p[2] > 2.5 for p in belt["points"]), "über den Gängen als Brücke"


def test_robot_routes_and_aisles_stay_clear(client):
    f = _floor_with_belt()
    layout = Layout.from_row(f)
    nodes = [(float(n[0]), float(n[1])) for n in layout.aisles.nodes]
    belt = [o.points for o in layout.obstacles if o.name == demo.CONVEYOR_NAME]
    assert belt, "das Band zählt als Körper"
    for i, j in layout.aisles.edges:
        assert not segment_blocked(nodes[int(i)], nodes[int(j)], belt), (i, j)
    with SessionLocal() as db:
        for r in db.query(RobotAsset).filter(RobotAsset.floor_id == f.id).all():
            route = [(float(p[0]), float(p[1])) for p in r.route]
            closed = route + (route[:1] if r.route_mode == "loop" else [])
            assert not [p for p in route_problems(layout, closed) if demo.CONVEYOR_NAME in p], r.name


def test_an_old_editor_without_conveyors_keeps_them(client):
    f = _floor_with_belt()
    body = client.get(f"/api/factory/floor?floor_id={f.id}").json()
    body.pop("conveyors")
    for k in ("id", "updated_at", "updated_by", "area_m2", "perimeter_m", "aisle_m", "issues"):
        body.pop(k, None)
    assert client.put(f"/api/factory/floor?floor_id={f.id}", json=body).status_code == 200
    again = client.get(f"/api/factory/floor?floor_id={f.id}").json()
    assert any(c["name"] == demo.CONVEYOR_NAME for c in again["conveyors"])
    # Ausdrücklich leer heißt: entfernen.
    body["conveyors"] = []
    assert client.put(f"/api/factory/floor?floor_id={f.id}", json=body).status_code == 200
    assert client.get(f"/api/factory/floor?floor_id={f.id}").json()["conveyors"] == []
