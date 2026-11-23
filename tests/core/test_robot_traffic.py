"""Fahrplan simulierter Roboter (core/robot_traffic.py): nie zwei zu nah beieinander."""

from __future__ import annotations

import math

import pytest

from gimel.core import robot_traffic as traffic
from gimel.core.robot import pose_on_route
from gimel.core.robot_traffic import (
    SAFE_M, TrafficRobot, distance_at, min_gap, moving_at, plan_floor,
)


def R(rid, route, loop=False, speed=1.0):
    return TrafficRobot(rid, tuple((float(x), float(y)) for x, y in route), loop, speed)


def naive_gap(robots, seconds=600):
    worst = math.inf
    for t in range(seconds):
        pts = [pose_on_route(list(r.route), t * r.speed_m_s, loop=r.loop) for r in robots]
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                worst = min(worst, math.dist((pts[i].x, pts[i].y), (pts[j].x, pts[j].y)))
    return worst


def test_crossing_loops_never_meet():
    a = R(1, [(0, 10), (30, 10), (30, 12), (0, 12)], loop=True, speed=1.2)
    b = R(2, [(15, 0), (15, 25), (17, 25), (17, 0)], loop=True, speed=0.9)
    assert naive_gap([a, b]) < 1.0, "ohne Fahrplan fahren sie durcheinander"
    res = plan_floor([a, b])
    assert not any(p.parked for p in res.plans.values())
    assert res.min_gap_m >= SAFE_M - 0.15
    # Vorfahrt nach Kennung: der erste fährt ohne Halt durch (er wartet höchstens
    # am Zyklusende am Start); der zweite wartet unterwegs oder findet einen
    # Startversatz, bei dem er gar nicht warten muss.
    def mid_waits(p):
        return sum(1 for (t0, s0), (t1, s1) in zip(p.keys[:-2], p.keys[1:-1]) if t1 > t0 and s1 - s0 < 1e-9)
    assert mid_waits(res.plans[1]) == 0


def test_shared_corridor_in_both_directions():
    a = R(1, [(0, 0), (40, 0)], speed=1.0)
    b = R(2, [(40, 3), (20, 3), (20, 0.0), (5, 0.0), (5, -6)], speed=0.8)
    res = plan_floor([a, b])
    assert res.min_gap_m is not None and res.min_gap_m >= SAFE_M - 0.15 or res.plans[2].parked


def test_plan_is_periodic_and_continuous():
    a = R(1, [(0, 0), (20, 0)], speed=1.0)
    b = R(2, [(10, -10), (10, 10)], loop=False, speed=1.0)
    res = plan_floor([a, b])
    for p in res.plans.values():
        assert p.keys[0][0] == 0 and abs(p.keys[-1][0] - p.period_s) < 1e-9
        s0, s1 = p.keys[0][1], p.keys[-1][1]
        assert abs((s1 - s0) - p.cycle_m) < 1e-6, "ein Zyklus ist genau eine Runde"
        assert all(t1 >= t0 and s1_ >= s0_ for (t0, s0_), (t1, s1_) in zip(p.keys, p.keys[1:])), "monoton"
        assert abs(distance_at(p, p.period_s * 3 + 1.5) - distance_at(p, 1.5)) < 1e-9


def test_full_speed_when_nobody_is_in_the_way():
    a = R(1, [(0, 0), (30, 0)], speed=1.5)
    b = R(2, [(0, 50), (30, 50)], speed=1.0)
    res = plan_floor([a, b])
    pa = res.plans[1]
    assert distance_at(pa, 10.0) - pa.keys[0][1] == 15.0, "volles Tempo, kein Kriechen"
    assert moving_at(pa, 10.0)


def test_impossible_route_parks_instead_of_driving_through():
    route = [(0, 0), (20, 0)]
    a, b = R(1, route), R(2, route)
    res = plan_floor([a, b])
    assert res.plans[2].parked and "kein begegnungsfreier" in res.plans[2].note
    assert not moving_at(res.plans[2], 5.0)


def test_standing_robot_is_an_obstacle():
    standing = R(1, [(10, 0)], speed=0.0)
    mover = R(2, [(0, 0), (20, 0)], speed=1.0)
    res = plan_floor([standing, mover])
    assert res.plans[1].parked
    # Der Weg führt durch den stehenden Roboter: also bleibt der Fahrende stehen.
    assert res.plans[2].parked or res.min_gap_m >= SAFE_M - 0.15


def test_deterministic():
    a = R(1, [(0, 10), (30, 10), (30, 12), (0, 12)], loop=True, speed=1.2)
    b = R(2, [(15, 0), (15, 25), (17, 25), (17, 0)], loop=True, speed=0.9)
    assert plan_floor([a, b]).plans[2].keys == plan_floor([b, a]).plans[2].keys
    assert min_gap([a, b], plan_floor([a, b]).plans) == plan_floor([a, b]).min_gap_m


# --- Speed: long, shared routes used to take two minutes to plan --------------------

def test_vectorised_positions_match_pose_on_route():
    route = ((56.0, 10.25), (56.0, 16.0), (45.03, 14.22), (40.97, 14.22), (9.25, 16.0), (22.0, 16.0))
    for loop in (True, False):
        r = TrafficRobot(1, route, loop, 1.0)
        ss = [-3.0, 0.0, 0.3, 17.77, 40.0, 99.9, 150.0, 400.0]
        got = traffic._positions(r, ss)
        for s, (x, y) in zip(ss, got.tolist()):
            p = pose_on_route(list(route), s, loop=loop)
            assert (x, y) == pytest.approx((p.x, p.y), abs=1e-3)


def test_two_long_robots_on_shared_aisles_plan_in_seconds():
    """Halle 1 with changed waypoints: two long routes over the same aisles. The
    search used to run for two minutes in pure Python and blocked the robot
    request; it must stay in seconds, and a robot without a clean schedule is
    parked, not sent through the other."""
    import time
    a = TrafficRobot(1, ((56.0, 10.25), (56.0, 16.0), (45.03, 14.22), (40.97, 14.22), (9.25, 16.0), (22.0, 16.0),
                         (22.0, 24.0), (22.0, 8.0), (22.0, 16.0), (38.0, 16.0), (38.0, 24.0), (38.0, 8.25),
                         (38.0, 16.0), (40.97, 14.22), (45.03, 14.22), (56.0, 16.0)), True, 1.2)
    b = TrafficRobot(2, ((38.0, 8.25), (38.0, 24.0), (38.0, 16.0), (22.0, 16.0), (22.0, 8.0), (22.0, 24.0),
                         (22.0, 16.0), (9.25, 16.0), (38.0, 16.0)), False, 0.9)
    t0 = time.perf_counter()
    res = traffic.plan_floor([a, b])
    assert time.perf_counter() - t0 < 30
    assert set(res.plans) == {1, 2}
    assert not res.plans[1].parked
