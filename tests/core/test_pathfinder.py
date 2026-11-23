"""Pfad von Hand und Pfadfinder: Vorrang, Rückfall, Hindernisse, Umriss, Wiederholbarkeit."""

from __future__ import annotations

import math
import time

import pytest

from gimel.core.layout import AisleGraph, Layout, ManualPath, Obstacle, point_in_polygon, segment_blocked
from gimel.core.pathfind import Pathfinder, connect_station

L_HALL = [(0.0, 0.0), (40.0, 0.0), (40.0, 10.0), (20.0, 10.0), (20.0, 30.0), (0.0, 30.0)]


def _net(**kw) -> AisleGraph:
    return AisleGraph(nodes=[(0.0, 5.0), (30.0, 5.0)], edges=[(0, 1)], **kw)


def _length(way) -> float:
    return sum(math.dist(u, v) for u, v in zip(way, way[1:]))


# ---------------------------------------------------------------- Pfad von Hand
def test_a_manual_path_wins_over_the_automatic_spur():
    station = (10.0, 9.0)
    auto = Layout(outline=L_HALL, aisles=_net()).route(station, (30.0, 5.0))
    # Pfad von Hand: erst weit nach links zum Gang — länger als der Stich von 4 m.
    g = _net(paths=[ManualPath(((10.0, 9.0), (2.0, 9.0), (2.0, 5.0)))])
    man = Layout(outline=L_HALL, aisles=g).route(station, (30.0, 5.0))
    assert auto.kind == "auto" and man.kind == "manual"
    assert man.metres == pytest.approx(8.0 + 4.0 + 28.0)
    assert man.metres > auto.metres


def test_a_manual_path_that_crosses_an_obstacle_falls_back_and_warns():
    wall = Obstacle(name="Regal", points=[(4.0, 6.0), (6.0, 6.0), (6.0, 8.0), (4.0, 8.0)])
    g = _net(paths=[ManualPath(((10.0, 9.0), (5.0, 7.0), (5.0, 5.0)))])
    layout = Layout(outline=L_HALL, obstacles=[wall], aisles=g)
    r = layout.route((10.0, 9.0), (30.0, 5.0))
    assert r.kind == "auto" and r.exact is True
    assert "Hindernis" in r.warning
    assert any("Pfad von Hand" in i for i in layout.connect_issues([("Presse", (10.0, 9.0))]))


def test_a_manual_path_that_leaves_the_hall_falls_back_and_warns():
    g = _net(paths=[ManualPath(((10.0, 9.0), (30.0, 20.0), (30.0, 5.0)))])
    r = Layout(outline=L_HALL, aisles=g).route((10.0, 9.0), (30.0, 5.0))
    assert r.kind == "auto" and "verlässt die Halle" in r.warning


def test_a_manual_path_belongs_to_the_place_where_it_starts():
    # Die Station ist umgezogen: der Pfad beginnt woanders und gilt nicht mehr.
    g = _net(paths=[ManualPath(((10.0, 9.0), (2.0, 9.0), (2.0, 5.0)))])
    r = Layout(outline=L_HALL, aisles=g).route((12.0, 9.0), (30.0, 5.0))
    assert r.kind == "auto" and r.warning == ""


def test_manual_paths_survive_the_json_round_trip_and_old_floors_still_load():
    g = _net(paths=[ManualPath(((10.0, 9.0), (2.0, 5.0)), station=7)])
    again = AisleGraph.from_json(g.to_json())
    assert again.paths == g.paths
    assert AisleGraph.from_json({"nodes": [[0, 0], [1, 0]], "edges": [[0, 1]]}).paths == []
    assert AisleGraph.from_json({"nodes": [], "edges": [], "paths": [{"points": "kaputt"}]}).paths == []


# ---------------------------------------------------------------- Pfadfinder
def test_the_pathfinder_walks_around_an_obstacle():
    wall = Obstacle(name="Wand", points=[(10.0, 0.0), (11.0, 0.0), (11.0, 8.0), (10.0, 8.0)])
    pf = Pathfinder([(0.0, 0.0), (30.0, 0.0), (30.0, 20.0), (0.0, 20.0)], [wall.points])
    way = pf.path((5.0, 4.0), (16.0, 4.0))
    assert way is not None and len(way) >= 3
    assert not any(segment_blocked(u, v, [wall.points]) for u, v in zip(way, way[1:]))
    assert _length(way) > math.dist((5.0, 4.0), (16.0, 4.0))


def test_the_pathfinder_stays_inside_an_l_shaped_hall():
    pf = Pathfinder(L_HALL, [])
    # Von oben links nach rechts unten: die gerade Linie liefe durch die Aussparung.
    way = pf.path((5.0, 28.0), (38.0, 3.0))
    assert way is not None and len(way) >= 3
    from gimel.core.layout import segment_leaves_outline

    assert all(point_in_polygon(q, L_HALL) for q in way)
    assert not any(segment_leaves_outline(u, v, L_HALL) for u, v in zip(way, way[1:]))


def test_the_pathfinder_says_none_when_there_is_no_way():
    box = [(8.0, 8.0), (12.0, 8.0), (12.0, 12.0), (8.0, 12.0)]
    pf = Pathfinder([(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)], [box])
    assert pf.path((10.0, 10.0), (2.0, 2.0)) is None  # Start liegt im Hindernis


def test_the_pathfinder_gives_the_same_way_every_time():
    wall = [(10.0, 0.0), (11.0, 0.0), (11.0, 8.0), (10.0, 8.0)]
    hall = [(0.0, 0.0), (30.0, 0.0), (30.0, 20.0), (0.0, 20.0)]
    ways = [Pathfinder(hall, [wall]).path((5.0, 4.0), (16.0, 4.0)) for _ in range(3)]
    assert ways[0] == ways[1] == ways[2]


def test_a_step_budget_bounds_the_work_and_returns_nothing_rather_than_half_a_way():
    wall = [(10.0, 0.0), (11.0, 0.0), (11.0, 8.0), (10.0, 8.0)]
    hall = [(0.0, 0.0), (30.0, 0.0), (30.0, 20.0), (0.0, 20.0)]
    assert Pathfinder(hall, [wall], max_tests=3).path((5.0, 4.0), (16.0, 4.0)) is None


def test_a_big_hall_with_many_obstacles_is_found_quickly():
    hall = [(0.0, 0.0), (80.0, 0.0), (80.0, 50.0), (0.0, 50.0)]  # 4000 m²
    shelves = [
        [(x, y), (x + 3.0, y), (x + 3.0, y + 2.0), (x, y + 2.0)]
        for x in range(8, 72, 12)
        for y in (10.0, 22.0, 34.0)
    ]
    pf = Pathfinder(hall, shelves)
    t0 = time.perf_counter()
    way = pf.path((2.0, 2.0), (78.0, 48.0))
    assert time.perf_counter() - t0 < 3.0
    assert way is not None
    assert not any(segment_blocked(u, v, shelves) for u, v in zip(way, way[1:]))


def test_connecting_a_station_behind_a_wall_proposes_a_free_way_to_the_network():
    wall = Obstacle(name="Wand", points=[(0.0, 6.0), (20.0, 6.0), (20.0, 7.0), (0.0, 7.0)])
    layout = Layout(outline=L_HALL, obstacles=[wall], aisles=_net())
    p = (5.0, 9.0)  # hinter der Wand: jeder gerade Stich wird gesperrt
    assert layout.aisles.attach(p, [wall.points], L_HALL).blocked is True
    prop = connect_station(layout.aisles, p, Pathfinder(L_HALL, [wall.points]))
    assert prop is not None and len(prop.nodes) > len(layout.aisles.nodes)
    assert p in prop.nodes
    after = Layout(outline=L_HALL, obstacles=[wall], aisles=prop).route(p, (30.0, 5.0))
    assert after.exact is True and after.kind == "auto"


def test_a_station_already_on_the_network_gets_no_new_nodes():
    g = _net()
    prop = connect_station(g, (10.0, 5.0), Pathfinder(L_HALL, []))
    assert prop is not None and prop.nodes == g.nodes and prop.edges == g.edges
