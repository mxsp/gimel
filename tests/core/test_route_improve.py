"""Roboterwege verbessern: über die Gänge, nie durch einen Körper, nichts erfinden."""

from __future__ import annotations

import math
from types import SimpleNamespace

from gimel.core import route_improve as ri
from gimel.core.layout import Layout


def floor(nodes, edges, obstacles=(), outline=((0, 0), (60, 0), (60, 30), (0, 30))):
    return Layout.from_row(SimpleNamespace(
        outline=[list(p) for p in outline], zones=[], doors=[], scale=40, grid=1, snap=0.25,
        obstacles=[{"name": n, "points": [list(p) for p in pts]} for n, pts in obstacles],
        aisles={"nodes": [list(n) for n in nodes], "edges": [list(e) for e in edges]},
    ))


SQUARE = floor([(10, 10), (30, 10), (30, 20), (10, 20)], [(0, 1), (1, 2), (2, 3)])


def test_loop_closing_leg_goes_over_the_aisles_not_across():
    imp = ri.improve(SQUARE, [[10, 10], [30, 10], [30, 20], [10, 20]], loop=True)
    # Ohne Kante 3–0 fährt der Rundkurs über die Gänge zurück statt quer.
    assert imp.changed
    assert imp.rerouted >= 1
    pts = imp.points
    for a, b in zip(pts, pts[1:] + [pts[0]]):
        assert a[0] == b[0] or a[1] == b[1], (a, b)  # nur achsparallel, wie die Gänge


def test_waypoints_snap_but_ends_stay():
    imp = ri.improve(SQUARE, [[9.5, 10.2], [20, 10.4], [30.3, 10.2]], loop=False)
    assert imp.points[0] == (9.5, 10.2) and imp.points[-1] == (30.3, 10.2)
    assert imp.snapped == 0 or all(abs(p[1] - 10.0) < 1e-6 for p in imp.points[1:-1])


def test_detour_around_a_rack_on_the_aisle():
    rack = ("Regal", [(18, 8), (22, 8), (22, 12), (18, 12)])
    lay = floor([(10, 10), (30, 10)], [(0, 1)], obstacles=[rack])
    imp = ri.improve(lay, [[10, 10], [30, 10]], loop=False)
    assert imp.problems_before and not imp.problems_after
    assert imp.detours == 1
    assert imp.metres_after > 20
    pts, kind = ri.safe_leg(lay, (10, 10), (30, 10))
    assert kind == "umweg"
    walls = [ri._box(rack[1], ri.CLEARANCE_M)]
    from gimel.core.layout import segment_blocked
    assert not any(segment_blocked(a, b, walls) for a, b in zip(pts, pts[1:]))


def test_station_bodies_are_avoided_except_at_the_ends():
    station = [(19, 9), (21, 9), (21, 11), (19, 11)]
    pts, kind = ri.safe_leg(SQUARE, (10, 10), (30, 10), [station])
    assert kind == "umweg"
    # Die Station am Ziel selbst stört nicht.
    end_station = [(29, 9), (31, 9), (31, 11), (29, 11)]
    pts2, kind2 = ri.safe_leg(SQUARE, (10, 10), (30, 10), [end_station])
    assert kind2 == "netz" and pts2[-1] == (30, 10)


def test_pingpong_spur_to_a_station_is_kept():
    out = ri.simplify([(0, 0), (10, 0), (10, 5), (10, 0), (20, 0)])
    assert (10, 5) in out


def test_nothing_to_improve_and_no_network():
    lay = floor([], [])
    imp = ri.improve(lay, [[5, 5], [15, 5]], loop=False)
    assert not imp.changed and imp.air_legs == 1
    assert any("Kein Gangnetz" in n for n in imp.notes)
    assert not ri.improve(lay, [[5, 5]], loop=False).changed


def test_network_findings_name_the_blocked_edge():
    rack = ("Regal", [(18, 8), (22, 8), (22, 12), (18, 12)])
    lay = floor([(10, 10), (30, 10), (30, 20)], [(0, 1), (1, 2)], obstacles=[rack])
    found = ri.network_findings(lay)
    assert found == [{"edge": [0, 1], "from": [10.0, 10.0], "to": [30.0, 10.0], "hits": "Regal"}]


def test_lengths():
    assert ri.length([(0, 0), (3, 4)], loop=False) == 5
    assert math.isclose(ri.length([(0, 0), (3, 0), (3, 4)], loop=True), 12)


def test_short_spikes_go_long_stubs_stay():
    assert ri._drop_spikes([(0, 0), (10, 0), (10, 0.5), (10, 0), (20, 0)]) == [(0, 0), (10, 0), (20, 0)]
    assert ri._drop_spikes([(0, 0), (10, 0), (10, 5), (10, 0), (20, 0)]) == [(0, 0), (10, 0), (10, 5), (10, 0), (20, 0)]


def test_improving_twice_changes_nothing():
    rack = ("Regal", [(18, 8), (22, 8), (22, 12), (18, 12)])
    lay = floor([(10, 10), (20, 10.4), (30, 10), (30, 20)], [(0, 1), (1, 2), (2, 3)], obstacles=[rack])
    for raw, loop in (([[8, 10], [20, 10.2], [30, 10], [30, 20]], False), ([[10, 10], [30, 10], [30, 20]], True)):
        once = ri.improve(lay, raw, loop=loop)
        twice = ri.improve(lay, [list(p) for p in once.points], loop=loop)
        assert not twice.changed, (raw, once.points, twice.points)
