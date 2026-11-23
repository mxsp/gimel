"""Wie eine Station ans Gangnetz anschließt: Kantenpunkt, Umriss, Parität mit dem Browser."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from gimel.core.layout import AisleGraph, Layout, Obstacle, segment_leaves_outline


def _hall_with_aisle() -> Layout:
    # L-Halle: die Ecke x > 20, y > 10 fehlt.
    return Layout(
        outline=[(0.0, 0.0), (40.0, 0.0), (40.0, 10.0), (20.0, 10.0), (20.0, 30.0), (0.0, 30.0)],
        aisles=AisleGraph(nodes=[(0.0, 5.0), (30.0, 5.0)], edges=[(0, 1)]),
    )


def test_a_station_connects_to_the_middle_of_an_aisle_not_only_to_its_ends():
    g = AisleGraph(nodes=[(0.0, 0.0), (20.0, 0.0)], edges=[(0, 1)])
    at = g.attach((10.0, 3.0))
    assert at.edge == (0, 1) and at.dist == pytest.approx(3.0)
    assert at.point == pytest.approx((10.0, 0.0))
    # Zwei Stationen mitten am Gang: Weg = Stiche + Strecke entlang des Gangs.
    r = g.route((4.0, 2.0), (14.0, -3.0))
    assert r.exact is True and r.metres == pytest.approx(2.0 + 10.0 + 3.0)


def test_a_station_on_a_node_prefers_the_node_over_the_edge_point():
    g = AisleGraph(nodes=[(0.0, 0.0), (20.0, 0.0)], edges=[(0, 1)])
    at = g.attach((0.0, 0.0))
    assert at.node == 0 and at.edge is None and at.dist == 0.0


def test_a_spur_may_not_leave_the_hall_outline():
    layout = _hall_with_aisle()
    assert layout.aisles.attach((30.0, 20.0), (), layout.outline).blocked is True
    r = layout.route((30.0, 20.0), (2.0, 5.0))
    assert r.exact is False and "Halle" in r.note
    assert layout.route((10.0, 8.0), (2.0, 5.0)).exact is True


def test_a_spur_that_cuts_the_corner_of_an_l_shaped_hall_is_refused():
    layout = _hall_with_aisle()
    assert segment_leaves_outline((15.0, 20.0), (30.0, 9.0), layout.outline) is True
    assert segment_leaves_outline((15.0, 20.0), (15.0, 8.0), layout.outline) is False


def test_a_spur_goes_around_a_wall_to_a_free_edge_point():
    wall = Obstacle(name="Wand", points=[(4.0, 1.0), (5.0, 1.0), (5.0, 3.0), (4.0, 3.0)])
    g = AisleGraph(nodes=[(0.0, 0.0), (20.0, 0.0)], edges=[(0, 1)])
    # (4.5, 4) sieht den Gang nur seitlich: der Lotfuß (4.5, 0) liegt hinter der Wand.
    at = g.attach((4.5, 4.0), [wall.points])
    assert at.blocked is False and at.edge is None and at.node == 0


def test_connect_issues_says_not_connected_when_the_only_way_leaves_the_hall():
    layout = _hall_with_aisle()
    issues = layout.connect_issues([("Presse", (30.0, 20.0))])
    assert len(issues) == 1 and "Presse" in issues[0] and "außerhalb der Halle" in issues[0]


def test_a_floor_without_outline_routes_as_before():
    g = AisleGraph(nodes=[(0.0, 0.0), (20.0, 0.0)], edges=[(0, 1)])
    assert Layout(aisles=g).route((5.0, 99.0), (15.0, 0.0)).exact is True


def test_python_and_browser_agree_on_the_metres():
    """Der Browser (web/aisles.test.mjs) liest dieselbe Datei. Ändert sich eine Regel
    nur auf einer Seite, fällt einer der beiden Tests."""
    fx = json.loads((Path(__file__).parent / "fixtures" / "aisle_parity.json").read_text())
    layout = Layout(
        outline=[tuple(p) for p in fx["outline"]],
        obstacles=[
            Obstacle(name=o["name"], points=[tuple(p) for p in o["points"]])
            for o in fx["obstacles"]
        ],
        aisles=AisleGraph.from_json(fx["aisles"]),
    )
    for (a, b), want in zip(fx["pairs"], fx["expected"]):
        r = layout.route(tuple(fx["points"][a]), tuple(fx["points"][b]))
        assert r.metres == pytest.approx(want["metres"], abs=1e-5), (a, b)
        assert r.exact is want["exact"], (a, b)
        assert r.kind == want["kind"], (a, b)
        assert bool(r.warning) == bool(want["warning"]), (a, b)

    from gimel.core.pathfind import Pathfinder

    pf = Pathfinder(layout.outline, [o.points for o in layout.obstacles])
    for (a, b), want in zip(fx["pathfinder"], fx["pathfinder_expected"]):
        way = pf.path(tuple(fx["points"][a]), tuple(fx["points"][b]))
        if want is None:
            assert way is None, (a, b)
        else:
            assert way is not None and sum(
                math.dist(u, v) for u, v in zip(way, way[1:])
            ) == pytest.approx(want, abs=1e-5), (a, b)
