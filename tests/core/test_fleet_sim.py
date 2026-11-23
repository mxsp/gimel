"""Flottensimulation: gesät, wiederholbar, ehrlich über Wartezeit und Begegnungen."""

from __future__ import annotations

import math

from gimel.core import fleet_sim as fs


def straight(a, b):
    return fs.Way(points=(a, b), metres=math.hypot(b[0] - a[0], b[1] - a[1]), exact=True)


POINTS = {1: (0.0, 0.0), 2: (50.0, 0.0), 3: (50.0, 30.0)}
EDGES = [{"from": 1, "to": 2, "count": 6, "kind": "supply"}, {"from": 2, "to": 3, "count": 4, "kind": "dispatch"}]


def robot(i, speed=1.0, start=(0.0, 0.0), handling=60.0, planned=True):
    return fs.SimRobot(id=f"r{i}", name=f"R{i}", speed_m_s=speed, start=start, handling_s=handling, planned=planned)


def test_demand_is_seeded_and_stays_in_the_shift():
    a = fs.demand_from_flow(EDGES, 40, 8 * 3600, seed=7)
    b = fs.demand_from_flow(EDGES, 40, 8 * 3600, seed=7)
    c = fs.demand_from_flow(EDGES, 40, 8 * 3600, seed=8)
    assert a == b and a != c
    assert len(a) == 40
    assert all(0 <= d.release_s <= 8 * 3600 for d in a)
    assert [d.release_s for d in a] == sorted(d.release_s for d in a)
    share = sum(1 for d in a if d.from_id == 1) / len(a)
    assert 0.35 < share < 0.85, share  # Gewichtung 6:4 schlägt durch
    assert fs.demand_from_flow([], 10, 3600) == []
    assert fs.demand_from_flow(EDGES, 0, 3600) == []
    assert len(fs.demand_from_flow(EDGES, 10_000, 3600)) == fs.MAX_DEMANDS


def test_one_transport_is_timed_exactly():
    d = [fs.Demand("T1", 1, 2, release_s=100.0)]
    res = fs.simulate([robot(1, speed=2.0, handling=60)], d, POINTS, straight, 3600)
    segs = res.tracks["r1"]
    assert [s.state for s in segs] == ["laden", "beladen", "entladen"]  # steht schon an der Quelle
    assert segs[0].t0 == 100.0 and segs[1].t1 - segs[1].t0 == 25.0
    assert res.served == 1 and res.unserved == 0 and res.wait_mean_s == 0
    assert res.loaded_m == 50 and res.empty_m == 0
    assert fs.position_at(segs, 0, (0.0, 0.0)) == (0.0, 0.0)
    mid = fs.position_at(segs, 130 + 12.5, (0.0, 0.0))
    assert abs(mid[0] - 25.0) < 1e-6
    assert fs.position_at(segs, 10_000, (0.0, 0.0)) == (50.0, 0.0)


def test_more_robots_never_wait_longer_and_sizing_recommends():
    demands = fs.demand_from_flow(EDGES, 80, 4 * 3600, seed=3)
    one = fs.simulate([robot(1)], demands, POINTS, straight, 4 * 3600, sample_s=0)
    three = fs.simulate([robot(i) for i in range(3)], demands, POINTS, straight, 4 * 3600, sample_s=0)
    assert three.wait_p90_s <= one.wait_p90_s
    assert three.served >= one.served
    sizing = fs.size_fleet(robot(0), [], demands, POINTS, straight, 4 * 3600, target_p90_s=300, upto=6)
    rows = sizing["rows"]
    assert rows[0]["planned"] == 1
    assert sizing["recommended"] is None or rows[sizing["recommended"] - 1]["ok"]
    if sizing["recommended"]:
        assert all(not r["ok"] for r in rows[: sizing["recommended"] - 1])


def test_existing_robot_is_baseline_not_planned():
    demands = fs.demand_from_flow(EDGES, 10, 3600, seed=1)
    res = fs.simulate([robot(1, planned=False), robot(2)], demands, POINTS, straight, 3600)
    assert {r["id"]: r["planned"] for r in res.robots} == {"r1": False, "r2": True}


def test_encounters_are_counted_when_two_robots_meet():
    # Zwei Roboter fahren gegeneinander auf derselben Linie.
    pts = {1: (0.0, 0.0), 2: (40.0, 0.0)}
    d = [fs.Demand("A", 1, 2, 0.0), fs.Demand("B", 2, 1, 0.0)]
    res = fs.simulate([robot(1, start=(0.0, 0.0), handling=0), robot(2, start=(40.0, 0.0), handling=0)],
                      d, pts, straight, 600, sample_s=0.5)
    assert res.encounters >= 1
    assert res.hotspots and res.hotspots[0]["count"] >= 1


def test_unknown_stations_and_late_releases_are_skipped():
    d = [fs.Demand("A", 1, 99, 10.0), fs.Demand("B", 1, 2, 99_999.0)]
    res = fs.simulate([robot(1)], d, POINTS, straight, 3600)
    assert res.demands == 0 and res.served == 0


def test_summary_shape():
    demands = fs.demand_from_flow(EDGES, 20, 3600, seed=2)
    s = fs.simulate([robot(1), robot(2)], demands, POINTS, straight, 3600).summary()
    for key in ("served", "unserved", "late", "wait_mean_s", "wait_p90_s", "empty_share", "per_hour",
                "encounters", "hotspots", "robots"):
        assert key in s
    assert 0 <= s["empty_share"] <= 1
