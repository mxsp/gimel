"""Zwillingswerkzeuge (task 38): lesen, Annahmen, zurücknehmbar schreiben, Ansicht steuern."""

from __future__ import annotations

import pytest

from agentlab.models import AgentChange, AgentChat
from agentlab.rollback import revert
from agentlab.tools import ToolContext, ToolError, execute_tool, live_write_ok, TOOLS


@pytest.fixture()
def work(password, admin):
    from gimel.db import SessionLocal
    from gimel.models import FactoryFloor, FactoryStation

    with SessionLocal() as db:
        user = db.merge(admin)
        floor = db.query(FactoryFloor).order_by(FactoryFloor.id).first()
        stations = [s for s in db.query(FactoryStation).order_by(FactoryStation.id).all()
                    if (s.floor_id or floor.id) == floor.id and s.active]
        assert len(stations) >= 2
        chat = AgentChat(user_id=user.id, title="Zwilling", write_mode=True)
        db.add(chat)
        db.commit()
        db.refresh(chat)
        yield db, user, chat, floor, stations
        db.rollback()


def run(work, name, args, write=True):
    db, user, chat, *_ = work
    return execute_tool(ToolContext(db=db, user=user, chat=chat), name, args, write_mode=write)


def test_read_tools_return_data(work):
    _db, _u, _c, floor, st = work
    lay = run(work, "get_floor_layout", {"floor_id": floor.id})["data"]
    assert lay["stations"] and lay["area_m2"] > 0 and "collisions" in lay
    det = run(work, "get_station_details", {"station_id": st[0].id})["data"]
    assert det["station"]["id"] == st[0].id and det["neighbours"]
    near = run(work, "get_nearby_stations", {"x": st[0].x, "y": st[0].y, "radius_m": 500,
                                             "floor_id": floor.id})["data"]
    assert near["stations"][0]["distance_m"] == 0 or near["stations"]
    assert run(work, "measure_between", {"from_station_id": st[0].id,
                                         "to_station_id": st[1].id})["data"]["straight_m"] >= 0
    run(work, "get_twin_findings", {"limit": 5})
    run(work, "list_twin_views", {"floor_id": floor.id})
    spot = run(work, "find_free_spot", {"floor_id": floor.id, "width_m": 1, "depth_m": 1})["data"]
    assert "found" in spot


def test_whatif_writes_nothing(work):
    db, _u, _c, _f, st = work
    s = st[0]
    before = (s.x, s.y)
    res = run(work, "whatif_move_station", {"station_id": s.id, "x": s.x + 1, "y": s.y})
    assert res["data"]["assumption"] is True
    db.refresh(s)
    assert (s.x, s.y) == before
    run(work, "whatif_station_down", {"station_id": s.id, "hours": 8})


def test_move_station_refuses_overlap_and_is_reversible(work):
    db, user, _c, _f, st = work
    a, b = st[0], st[1]
    with pytest.raises(ToolError):
        run(work, "move_station", {"station_id": a.id, "x": b.x, "y": b.y})
    with pytest.raises(ToolError):
        run(work, "move_station", {"station_id": a.id, "x": 99999, "y": 99999})
    # Auf einen freien Platz geht es, und die Änderung lässt sich zurücknehmen.
    spot = run(work, "find_free_spot", {"floor_id": _f.id, "width_m": a.w, "depth_m": a.h})["data"]
    if spot["found"]:
        ox, oy = a.x, a.y
        out = run(work, "move_station", {"station_id": a.id, "x": spot["x"], "y": spot["y"]})
        db.refresh(a)
        assert (a.x, a.y) == (pytest.approx(spot["x"]), pytest.approx(spot["y"]))
        revert(db, db.get(AgentChange, out["change_id"]), user)
        db.commit()
        db.refresh(a)
        assert (a.x, a.y) == (pytest.approx(ox), pytest.approx(oy))


def test_save_twin_view_reversible(work):
    db, user, _c, floor, _s = work
    out = run(work, "save_twin_view", {"name": "Test-Blick", "floor_id": floor.id, "camera": {
        "position": [1, 2, 3], "target": [0, 0, 0], "mode": "orbit", "view": "three"}})
    from gimel.models import TwinView
    vid = out["data"]["id"]
    assert db.get(TwinView, vid) is not None
    revert(db, db.get(AgentChange, out["change_id"]), user)
    db.commit()
    assert db.get(TwinView, vid) is None
    with pytest.raises(ToolError):
        run(work, "save_twin_view", {"name": "x", "floor_id": floor.id})  # keine Kamera


def test_show_in_view_whitelist(work):
    _db, _u, _c, floor, st = work
    ok = run(work, "show_in_view", {"action": "highlight", "station_ids": [st[0].id]}, write=False)
    assert ok["client_action"]["type"] == "highlight"
    assert run(work, "show_in_view", {"action": "set_floor", "floor_id": floor.id},
               write=False)["client_action"]["floor_id"] == floor.id
    for bad in ({"action": "eval"}, {"action": "navigate", "route": "https://evil.example"},
                {"action": "navigate", "route": "/app/../admin"},
                {"action": "highlight", "station_ids": [10**9]},
                {"action": "set_view_mode", "mode": "vr"}):
        with pytest.raises(ToolError):
            run(work, "show_in_view", bad, write=False)


def test_live_mode_only_gets_reversible_twin_writes():
    for name in ("move_station", "rotate_station"):
        assert not live_write_ok(TOOLS[name])  # admin_only → bleibt dem Tippen
    assert live_write_ok(TOOLS["save_twin_view"])
    assert not live_write_ok(TOOLS["delete_station"])
