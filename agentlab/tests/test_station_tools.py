"""Stationswerkzeuge: Platzierung vor dem Nutzer, Auswahl, keine geratenen Punkte."""

from __future__ import annotations

import pytest

from agentlab.models import AgentChat
from agentlab.tools import ToolContext, ToolError, execute_tool


@pytest.fixture()
def work(admin):
    """Ein Schreibchat und eine Ebene, auf der eine Station entstehen darf."""
    from gimel.db import SessionLocal
    from gimel.models import FactoryFloor

    with SessionLocal() as db:
        user = db.merge(admin)
        floor = db.query(FactoryFloor).order_by(FactoryFloor.id).first()
        assert floor is not None
        chat = AgentChat(user_id=user.id, title="Test", write_mode=True)
        db.add(chat)
        db.commit()
        db.refresh(chat)
        yield db, user, chat, floor.id
        db.rollback()


def _context(floor_id: int, *, x: float = 10.0, y: float = 20.0, heading: float = 90.0) -> dict:
    return {
        "route": "studio",
        "title": "Twin Studio · Test",
        "view": {"floor_id": floor_id, "standpunkt_x": x, "standpunkt_y": y,
                 "blick_richtung": heading, "ansicht": "begehen"},
    }


def test_new_station_tools_are_in_the_catalog(client):
    tools = {t["name"]: t for t in client.get("/api/agent/tools").json()["tools"]}
    for name in ("create_station", "update_station", "select_station",
                 "prepare_station_placement", "get_station_view"):
        assert name in tools, name
    assert tools["create_station"]["write"] is True
    assert tools["create_station"]["admin_only"] is True
    assert tools["select_station"]["write"] is False
    assert tools["prepare_station_placement"]["write"] is False


def test_create_station_in_front_uses_the_reported_view(work):
    db, user, chat, floor_id = work
    ctx = ToolContext(db=db, user=user, chat=chat, context=_context(floor_id))
    result = execute_tool(ctx, "create_station", {
        "label": "Plotter vor mir", "type": "production",
        "machine_kind": "plotter", "distance_m": 4,
    }, write_mode=True)

    data = result["data"]
    assert data["x"] == pytest.approx(14.0)
    assert data["y"] == pytest.approx(20.0)
    assert data["rotation"] == pytest.approx(90.0)
    assert data["floor_id"] == floor_id
    # Richtwerte der Maschine sind gesetzt, aber als Vorschlag.
    assert data["speed_mm_s"] == 50
    assert result["client_action"]["type"] == "select_station"
    assert result["client_action"]["station_id"] == data["id"]

    # Die Änderung ist rücknehmbar und verschwindet dann wieder.
    from gimel.models import FactoryStation
    from agentlab.models import AgentChange
    from agentlab.rollback import revert

    assert db.get(FactoryStation, data["id"]) is not None
    change = db.get(AgentChange, result["change_id"])
    revert(db, change, user)
    db.commit()
    assert db.get(FactoryStation, data["id"]) is None


def test_create_station_without_a_viewpoint_is_an_honest_error(work):
    db, user, chat, _floor_id = work
    ctx = ToolContext(db=db, user=user, chat=chat, context=None)
    with pytest.raises(ToolError, match="Standpunkt"):
        execute_tool(ctx, "create_station", {"label": "Ohne Ort"}, write_mode=True)


def test_update_station_moves_in_front_without_touching_other_fields(work):
    db, user, chat, floor_id = work
    from gimel.models import FactoryStation

    station = db.query(FactoryStation).order_by(FactoryStation.id).first()
    assert station is not None
    before_label = station.label

    ctx = ToolContext(db=db, user=user, chat=chat, context=_context(floor_id, x=2, y=3, heading=0))
    result = execute_tool(ctx, "update_station", {
        "station_id": station.id, "placement": "in_front", "distance_m": 5,
    }, write_mode=True)

    assert result["data"]["x"] == pytest.approx(2.0)
    assert result["data"]["y"] == pytest.approx(8.0)
    assert result["data"]["label"] == before_label


def test_prepare_placement_returns_an_action_and_writes_nothing(work):
    db, user, chat, floor_id = work
    from gimel.models import FactoryStation

    count = db.query(FactoryStation).count()
    ctx = ToolContext(db=db, user=user, chat=chat, context=_context(floor_id))
    result = execute_tool(ctx, "prepare_station_placement", {
        "label": "Stanze", "type": "production", "machine_kind": "punch",
    }, write_mode=False)

    assert "change_id" not in result
    assert db.query(FactoryStation).count() == count
    action = result["client_action"]
    assert action["type"] == "prepare_station_placement"
    assert action["floor_id"] == floor_id
    assert action["station"]["machine_kind"] == "punch"


def test_select_station_by_label_returns_the_ui_action(work):
    db, user, chat, _floor_id = work
    from gimel.models import FactoryStation

    station = db.query(FactoryStation).order_by(FactoryStation.id).first()
    assert station is not None
    ctx = ToolContext(db=db, user=user, chat=chat)
    result = execute_tool(ctx, "select_station", {
        "query": station.label, "edit": True,
    }, write_mode=False)

    action = result["client_action"]
    assert action["station_id"] == station.id
    assert action["edit"] is True


def test_where_am_i_reports_the_view_and_the_station_in_front(work):
    db, user, chat, floor_id = work
    ctx = ToolContext(db=db, user=user, chat=chat, context={
        **_context(floor_id),
        "view": {
            **_context(floor_id)["view"],
            "vor_mir": "Laser 2", "vor_mir_id": 77, "vor_mir_abstand_m": 2.4,
            "naechste_station": "Laser 2", "naechste_station_id": 77,
            "naechste_abstand_m": 2.4,
        },
    })
    result = execute_tool(ctx, "where_am_i", {}, write_mode=False)
    assert result["data"]["x"] == pytest.approx(10.0)
    assert result["data"]["heading_deg"] == pytest.approx(90.0)
    assert result["data"]["in_front"] == {
        "id": 77, "label": "Laser 2", "distance_m": 2.4,
    }
    assert "Laser 2" in result["summary"]
    assert "change_id" not in result


def test_select_station_in_front_uses_the_reported_station(work):
    db, user, chat, floor_id = work
    from gimel.models import FactoryStation

    station = db.query(FactoryStation).order_by(FactoryStation.id).first()
    ctx = ToolContext(db=db, user=user, chat=chat, context={
        **_context(floor_id),
        "view": {**_context(floor_id)["view"], "vor_mir_id": station.id},
    })
    result = execute_tool(ctx, "select_station", {"in_front": True, "edit": True},
                          write_mode=False)
    assert result["client_action"]["station_id"] == station.id
    assert result["client_action"]["edit"] is True
