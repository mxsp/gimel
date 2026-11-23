"""Roboterwege: Linienzug über das Gangnetz, ehrliche Luftlinie, Prüfung."""

from __future__ import annotations

from gimel.core.layout import AisleGraph, Layout, Obstacle
from gimel.core.robot_way import plan_way, route_problems


def hall(aisles: AisleGraph | None = None) -> Layout:
    return Layout(
        outline=[(0, 0), (20, 0), (20, 20), (0, 20)],
        aisles=aisles or AisleGraph(),
    )


def test_a_straight_aisle_becomes_a_way_with_both_ends():
    graph = AisleGraph(nodes=[(0, 10), (10, 10), (20, 10)], edges=[(0, 1), (1, 2)])
    way = plan_way(hall(graph), (1, 10), (19, 10))
    assert way.exact is True
    assert way.metres == 18
    assert way.points[0] == (1, 10)
    assert way.points[-1] == (19, 10)
    # Der Zwischenknoten liegt auf der Geraden und wird bewusst weggelassen.
    assert way.points == [(1, 10), (19.0, 10.0)]


def test_without_an_aisle_the_result_is_an_honest_air_line():
    way = plan_way(hall(), (1, 2), (19, 18))
    assert way.exact is False
    assert "Luftlinie" in way.note
    assert way.points == [(1, 2), (19, 18)]


def test_a_way_that_crosses_an_obstacle_is_refused():
    layout = hall()
    layout.obstacles = [Obstacle(points=[(5, 5), (15, 5), (15, 15), (5, 15)])]
    problems = route_problems(layout, [(1, 10), (19, 10)])
    assert problems
    assert "Hindernis" in problems[0]


def test_a_way_outside_the_outline_is_refused():
    problems = route_problems(hall(), [(1, 1), (21, 1)])
    assert problems
    assert "außerhalb" in problems[0]


def test_a_route_with_one_point_has_no_way():
    assert route_problems(hall(), [(1, 1)]) == ["Ein Weg braucht mindestens zwei Punkte."]
