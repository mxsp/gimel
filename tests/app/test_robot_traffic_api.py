"""Die Demo-Roboter folgen dem Fahrplan: über einen ganzen Zyklus keine Begegnung."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from gimel.core.robot_traffic import SAFE_M
from gimel.db import SessionLocal
from gimel.models import RobotAsset
from gimel.services import robot_fleet


def test_demo_robots_never_come_too_close(client):
    with SessionLocal() as db:
        t0 = datetime(2026, 11, 7, 12, 0, tzinfo=timezone.utc)
        worst = math.inf
        first = robot_fleet.snapshot(db, now=t0)["robots"]
        assert any(r["sim_plan"] for r in first), "simulierte Roboter tragen ihren Fahrplan"
        period = max(r["sim_plan"]["period_s"] for r in first if r["sim_plan"])
        for k in range(int(period * 2)):
            rs = [r for r in robot_fleet.snapshot(db, now=t0 + timedelta(seconds=k * 0.5))["robots"]
                  if r["x"] is not None]
            for i in range(len(rs)):
                for j in range(i + 1, len(rs)):
                    if rs[i]["floor_id"] == rs[j]["floor_id"]:
                        worst = min(worst, math.hypot(rs[i]["x"] - rs[j]["x"], rs[i]["y"] - rs[j]["y"]))
        assert worst >= SAFE_M - 0.2, worst


def test_one_robot_view_matches_the_list(client):
    with SessionLocal() as db:
        now = datetime(2026, 11, 7, 12, 0, 7, tzinfo=timezone.utc)
        listed = {r["id"]: r for r in robot_fleet.snapshot(db, now=now)["robots"]}
        for row in db.query(RobotAsset).all():
            one = robot_fleet.as_dict(row, now=now)
            assert (one["x"], one["y"], one["state"]) == (listed[row.id]["x"], listed[row.id]["y"], listed[row.id]["state"])


def test_api_returns_plan(client):
    body = client.get("/api/factory/robots").json()
    robots = body.get("robots", body)
    plan = next(r["sim_plan"] for r in robots if r.get("sim_plan"))
    assert plan["period_s"] > 0 and len(plan["keys"]) >= 2 and plan["epoch"].startswith("2026-01-01")
