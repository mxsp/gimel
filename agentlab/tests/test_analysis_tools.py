"""Analyse- und Planungswerkzeuge (task 36 A+B): lesen nur, rechnen richtig."""

from __future__ import annotations

import math

import pytest
from sqlalchemy import inspect, text


def _counts() -> dict[str, int]:
    from gimel.db import SessionLocal

    with SessionLocal() as db:
        names = inspect(db.get_bind()).get_table_names()
        return {n: db.execute(text(f'SELECT COUNT(*) FROM "{n}"')).scalar_one()
                for n in names if not n.startswith("agent_")}


def _invoke(client, chat_id: int, name: str, args: dict | None = None):
    return client.post(f"/api/agent/chats/{chat_id}/tools/{name}",
                       json={"arguments": args or {}})


@pytest.fixture()
def chat(client):
    data = client.post("/api/agent/chats", json={"write_mode": False}).json()
    yield data
    client.delete(f"/api/agent/chats/{data['id']}")


def _first(model, *order):
    from gimel.db import SessionLocal

    with SessionLocal() as db:
        row = db.query(model).order_by(*order).first()
        return row


def test_new_tools_are_in_the_catalog_with_category_and_schema(client):
    tools = {t["name"]: t for t in client.get("/api/agent/tools").json()["tools"]}
    for name in ("get_order_trace", "get_run_trace", "analyse_twin", "get_factory_plan",
                 "get_material_flow", "get_kpis", "get_material_demand", "get_shape_usage",
                 "quote_price", "check_part_fit", "plan_robot_way", "simulate_fleet",
                 "calculate"):
        assert name in tools, name
        assert tools[name]["write"] is False
        assert tools[name]["category"]
        assert tools[name]["parameters"]["type"] == "object"
    assert all(t["category"] for t in tools.values())


def test_read_tools_write_nothing(client, chat):
    from gimel.models import FactoryStation, NestRun, Order

    order = _first(Order, Order.id)
    stations = []
    from gimel.db import SessionLocal

    with SessionLocal() as db:
        rows = db.query(FactoryStation).order_by(FactoryStation.id).all()
        by_floor: dict = {}
        for s in rows:
            by_floor.setdefault(s.floor_id, []).append(s.id)
        stations = next((ids for ids in by_floor.values() if len(ids) >= 2), [])
    run = _first(NestRun, NestRun.id.desc())

    calls = [
        ("get_order_trace", {"order_no": order.no}),
        ("get_run_trace", {"run_no": run.no} if run else {}),
        ("analyse_twin", {"limit": 5}),
        ("get_factory_plan", {"limit": 10}),
        ("get_material_flow", {}),
        ("get_kpis", {"days": 30}),
        ("get_material_demand", {}),
        ("quote_price", {"lines": [{"mat": "epdm-70", "qty": 10, "thk": 2, "od": 162, "di": 115}]}),
        ("check_part_fit", {"od": 162, "di": 115, "material": "epdm-70"}),
        ("calculate", {"expression": "ring_area(162, 115) * 10 / 1e6", "digits": 4}),
    ]
    if len(stations) >= 2:
        calls.append(("plan_robot_way", {"from_station_id": stations[0],
                                         "to_station_id": stations[1]}))
    before = _counts()
    for name, args in calls:
        r = _invoke(client, chat["id"], name, args)
        if name == "get_run_trace" and run is None:
            assert r.status_code == 422
            continue
        assert r.status_code == 200, f"{name}: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("summary"), name
        assert "change_id" not in body, name
    assert _counts() == before


def test_simulate_fleet_reports_or_explains(client, chat):
    before = _counts()
    r = _invoke(client, chat["id"], "simulate_fleet", {"robots": 2, "horizon_h": 2})
    # Eine Ebene ohne Fluss ist eine ehrliche Antwort, kein Absturz.
    assert r.status_code in (200, 422), r.text
    if r.status_code == 200:
        text_ = str(r.json()["data"]["result"])
        assert len(text_) < 40_000
    assert _counts() == before


def test_quote_price_matches_the_shop_engine(client, chat):
    lines = [{"mat": "epdm-70", "q": 25, "thk": 2, "od": 200, "di": 150}]
    shop = client.post("/api/quote", json={"lines": [{"id": 1, **lines[0]}]})
    assert shop.status_code == 200, shop.text
    tool = _invoke(client, chat["id"], "quote_price", {"lines": lines}).json()
    assert tool["data"]["gross"] == pytest.approx(shop.json()["gross"])


def test_check_part_fit_flags_a_too_thin_web(client, chat):
    r = _invoke(client, chat["id"], "check_part_fit",
                {"od": 100, "di": 99.8, "material": "epdm-70"}).json()
    assert r["data"]["web_mm"] == pytest.approx(0.1)
    unknown = _invoke(client, chat["id"], "check_part_fit", {"od": 100, "material": "nope"})
    assert unknown.status_code == 422


def test_kpis_keep_unknown_as_null(client, chat):
    data = _invoke(client, chat["id"], "get_kpis", {"days": 1}).json()["data"]
    assert "Ausschuss" in data["not_recorded"]
    for key in ("lead_time_days_median", "on_time_rate"):
        assert key in data["orders"]
        assert data["orders"][key] is None or data["orders"][key] >= 0


def test_role_limits(client, chat):
    tools = {t["name"]: t for t in client.get("/api/agent/tools").json()["tools"]}
    assert tools["quote_price"]["roles"] == ["admin", "staff"]
    assert "worker" in tools["calculate"]["roles"]


@pytest.mark.parametrize("expr,expected", [
    ("1 + 2 * 3", 7), ("(1 + 2) * 3", 9), ("2 ^ 10", 1024), ("10 // 3", 3),
    ("sqrt(16) + abs(-2)", 6), ("circle_area(10)", math.pi * 25),
    ("ring_area(10, 4)", math.pi * (100 - 16) / 4), ("max(1, 5, 3)", 5),
    ("mean(2, 4, 6)", 4), ("round(pi, 3)", 3.142), ("3 × 4 ÷ 2", 6),
])
def test_calculate_is_exact(expr, expected):
    from agentlab.analysis_tools import safe_calculate

    assert safe_calculate(expr) == pytest.approx(expected)


def test_calculate_variables():
    from agentlab.analysis_tools import safe_calculate

    assert safe_calculate("qty * price", {"qty": 3, "price": "2,5"}) == pytest.approx(7.5)


@pytest.mark.parametrize("expr", [
    "__import__('os')", "open('x')", "(1).__class__", "[1, 2]", "a if 1 else 2",
    "lambda: 1", "9 ** 9 ** 9", "10 ** 1000", "1 / 0", "x", "sqrt(-1)",
    "'a' * 3", "True + 1", "f'{1}'", "1" * 700, "-" * 400 + "1",
    "exp(1000)",
])
def test_calculate_refuses(expr):
    from agentlab.analysis_tools import safe_calculate
    from agentlab.tools import ToolError

    with pytest.raises(ToolError):
        safe_calculate(expr)


def test_calculate_refuses_bad_variable_names():
    from agentlab.analysis_tools import safe_calculate
    from agentlab.tools import ToolError

    for name in ("sqrt", "1a", "a b", "__x__ "):
        with pytest.raises(ToolError):
            safe_calculate("1", {name: 1})


@pytest.mark.parametrize("expr", [
    "(" * 18 + "9**100" + ")**2" * 18,
    "round(1, -30000000)",
    "round(1, 2.5)",
    "floor(1e300)**2**2**2",
    "2**100**2",
    "(10**99)**4",
    "9" * 400 + " * " + "9" * 150,
])
def test_calculate_cannot_block_the_process(expr):
    import time

    from agentlab.analysis_tools import safe_calculate
    from agentlab.tools import ToolError

    started = time.perf_counter()
    with pytest.raises(ToolError):
        safe_calculate(expr)
    assert time.perf_counter() - started < 1.0


def test_calculate_refuses_huge_variables():
    from agentlab.analysis_tools import safe_calculate
    from agentlab.tools import ToolError

    with pytest.raises(ToolError):
        safe_calculate("x * x", {"x": 10 ** 400})
