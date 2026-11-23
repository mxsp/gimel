"""Förderbänder (core/conveyor.py): was im Weg steht und was eine Brücke ist."""

from __future__ import annotations

from gimel.core import conveyor as cv
from gimel.core.layout import Layout, segment_blocked


def test_points_are_read_forgivingly():
    pts = cv.points3([[0, 0], [5, 0, 3.0], ["x", 1], [6, 1, None], [1e309, 0]])
    assert pts == [(0.0, 0.0, cv.DEFAULT_Z_M), (5.0, 0.0, 3.0), (6.0, 1.0, cv.DEFAULT_Z_M)]
    assert cv.width_of("nope") == 0.8 and cv.width_of(5) == cv.WIDTH_MAX_M


def test_a_ground_belt_blocks_its_whole_length():
    polys = cv.footprint(cv.points3([[0, 0, 0.9], [10, 0, 0.9]]), 0.8)
    assert len(polys) == 1
    xs = [p[0] for p in polys[0]]
    ys = [p[1] for p in polys[0]]
    assert min(xs) == 0 and max(xs) == 10 and abs(max(ys) - 0.4) < 1e-9


def test_a_bridge_leaves_the_aisle_free_and_stands_on_posts():
    # Rampe hoch, Brücke über einen Gang bei x = 10, Rampe runter.
    pts = cv.points3([[0, 0, 0.9], [4, 0, 2.85], [16, 0, 2.85], [20, 0, 0.9]])
    polys = cv.footprint(pts, 0.8)
    # Zwei Teilstücke der Rampen (bis zur Durchfahrtshöhe) und zwei Stützen.
    assert len(polys) == 4
    assert not segment_blocked((10, -5), (10, 5), polys), "der Gang unter der Brücke bleibt frei"
    assert segment_blocked((1, -5), (1, 5), polys), "die niedrige Rampe steht im Weg"
    posts = [p for p in polys if max(q[0] for q in p) - min(q[0] for q in p) <= cv.POST_M + 1e-9]
    assert {round(sum(q[0] for q in p) / 4, 3) for p in posts} == {4.0, 16.0}


def test_layout_counts_conveyor_bodies_as_obstacles():
    class Row:
        outline = [[0, 0], [30, 0], [30, 10], [0, 10]]
        zones, doors = [], []
        obstacles = [{"name": "Stütze", "points": [[1, 1], [2, 1], [2, 2], [1, 2]]}]
        aisles = {"nodes": [], "edges": []}
        conveyors = [{"name": "Band", "points": [[5, 5, 0.9], [25, 5, 0.9]], "width": 0.8}]

    layout = Layout.from_row(Row())
    names = [o.name for o in layout.obstacles]
    assert names == ["Stütze", "Band"]
    assert cv.bodies(Row.conveyors)[0][0] == "Band"
