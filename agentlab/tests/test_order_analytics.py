"""Tests für Großdaten-Analytik, 128-Tool-Priorisierung und korrigierte Agent-Werkzeuge."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from gimel.db import SessionLocal
from gimel.models import Order, OrderPosition, Role, Shipment, ShipmentStatus, User
from agentlab.models import AgentChat
from agentlab.tools import ToolContext, execute_tool, schemas_for


def _admin_ctx(db, *, context: dict | None = None) -> tuple[User, ToolContext]:
    user = db.query(User).filter(User.role == Role.admin).first()
    assert user is not None
    chat = AgentChat(user_id=user.id, title="Analytics Test", write_mode=True)
    db.add(chat)
    db.commit()
    db.refresh(chat)
    return user, ToolContext(db=db, user=user, chat=chat, message_id=None, context=context)


def test_schemas_for_keeps_analytics_and_web_tools_in_write_mode(client):
    with SessionLocal() as db:
        user, _ = _admin_ctx(db)
        schemas = schemas_for(user, write_mode=True, web_enabled=True)
        names = {s["function"]["name"] for s in schemas}
        assert len(schemas) <= 128
        for must_have in (
            "query_orders", "aggregate_orders", "get_order_aging_and_bottlenecks",
            "get_customer_analytics", "get_inventory_forecast", "get_production_trends",
            "get_ar_aging", "get_kpis", "analyse_twin", "calculate", "web_search", "fetch_url",
        ):
            assert must_have in names, f"{must_have} fehlt im Schreibmodus!"


def test_get_due_orders_excludes_completed_and_cancelled(client):
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        _, ctx = _admin_ctx(db)
        db.add_all([
            Order(no="AB-OPEN-1", stage=0, released=True, blocked=False,
                  due_date=now - timedelta(days=2), net=100.0, gross=119.0),
            Order(no="AB-DONE-1", stage=2, released=True, blocked=False,
                  due_date=now - timedelta(days=10), net=200.0, gross=238.0),
            Order(no="AB-CANC-1", stage=0, released=True, blocked=False,
                  due_date=now - timedelta(days=5), cancelled_at=now, net=300.0, gross=357.0),
        ])
        db.commit()

        res = execute_tool(ctx, "get_due_orders", {"days": 7}, write_mode=False)
        nos = [o["no"] for o in res["data"]["orders"]]
        assert "AB-OPEN-1" in nos
        assert "AB-DONE-1" not in nos
        assert "AB-CANC-1" not in nos
        assert res["data"]["total_matching"] >= 1


def test_get_shipment_board_finds_open_beyond_hundred_delivered(client):
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        _, ctx = _admin_ctx(db)
        for i in range(110):
            db.add(Shipment(no=f"VS-OLD-{i:03d}", status=ShipmentStatus.delivered,
                            created_at=now - timedelta(days=200 - i)))
        db.add(Shipment(no="VS-OPEN-999", status=ShipmentStatus.packing, created_at=now))
        db.commit()

        res = execute_tool(ctx, "get_shipment_board", {}, write_mode=False)
        nos = [s["no"] for s in res["data"]["shipments"]]
        assert "VS-OPEN-999" in nos
        assert res["data"]["counts"].get("delivered", 0) >= 110


def test_query_and_aggregate_orders_and_ar_aging(client):
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        _, ctx = _admin_ctx(db)
        o1 = Order(
            no="AB-BIG-001", stage=0, released=False, blocked=False, paid=False,
            invoice_no="RE-BIG-001", invoiced_at=now - timedelta(days=40),
            invoice_due_at=now - timedelta(days=20),
            due_date=now - timedelta(days=1), net=1000.0, gross=1190.0,
            created_at=now - timedelta(days=5),
        )
        o2 = Order(
            no="AB-BIG-002", stage=1, released=True, blocked=False, paid=True,
            paid_at=now - timedelta(days=1),
            due_date=now + timedelta(days=5), net=500.0, gross=595.0,
            created_at=now - timedelta(days=2),
        )
        db.add_all([o1, o2])
        db.flush()
        db.add(OrderPosition(order_id=o1.id, kind="gasket", mat="EPDM70", thk=2.0, qty=50,
                             production_status="pending"))
        db.commit()

        q_res = execute_tool(ctx, "query_orders", {"material": "EPDM70", "min_gross": 1000}, write_mode=False)
        assert q_res["data"]["total_count"] == 1
        assert q_res["data"]["orders"][0]["no"] == "AB-BIG-001"
        assert q_res["data"]["sum_gross"] == 1190.0

        agg = execute_tool(ctx, "aggregate_orders", {"group_by": "month"}, write_mode=False)
        assert agg["data"]["buckets"]
        assert agg["data"]["chart"]["kind"] == "line"

        aging = execute_tool(ctx, "get_order_aging_and_bottlenecks", {}, write_mode=False)
        assert aging["data"]["funnel"]["open_total"] >= 2
        assert aging["data"]["funnel"]["overdue"] >= 1

        ar = execute_tool(ctx, "get_ar_aging", {}, write_mode=False)
        assert ar["data"]["overdue_count"] >= 1
        assert ar["data"]["buckets"]["15-30 Tage"] >= 1190.0


def test_bulk_update_orders_dry_run_then_apply(client):
    with SessionLocal() as db:
        _, ctx = _admin_ctx(db)
        o = Order(no="AB-BULK-1", stage=0, released=False, blocked=False, net=50.0, gross=59.5)
        db.add(o)
        db.commit()

        preview = execute_tool(
            ctx, "bulk_update_orders",
            {"order_nos": ["AB-BULK-1"], "action": "release", "dry_run": True},
            write_mode=True,
        )
        assert preview["data"]["dry_run"] is True
        assert preview["data"]["would_update"] == ["AB-BULK-1"]
        db.refresh(o)
        assert o.released is False

        applied = execute_tool(
            ctx, "bulk_update_orders",
            {"order_nos": ["AB-BULK-1"], "action": "release", "dry_run": False, "note": "Batch-Freigabe"},
            write_mode=True,
        )
        assert applied["data"]["updated"] == ["AB-BULK-1"]
        db.refresh(o)
        assert o.released is True
