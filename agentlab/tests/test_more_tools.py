from __future__ import annotations

import pytest


def invoke(client, chat_id: int, name: str, args: dict | None = None) -> dict:
    r = client.post(f"/api/agent/chats/{chat_id}/tools/{name}",
                    json={"arguments": args or {}})
    assert r.status_code == 200, f"{name}: {r.status_code} {r.text}"
    return r.json()


def undo(client, chat_id: int, change_id: int) -> None:
    r = client.post(f"/api/agent/chats/{chat_id}/changes/{change_id}/revert")
    assert r.status_code == 200, r.text


def test_create_order_accepts_quantity_aliases_and_position_update(client):
    chat = client.post("/api/agent/chats", json={"write_mode": True}).json()
    try:
        created = invoke(client, chat["id"], "create_order", {
            "kind": "internal", "internal_owner": "Test",
            "lines": [{
                "kind": "custom", "mat": "service", "label": "Testposition",
                "desc": "Menge aus Text", "qty": "3 Stück", "price_gross": 10,
            }],
        })
        order_no = created["data"]["no"]
        position = created["data"]["positions"][0]
        assert position["qty"] == 3
        assert created["data"]["gross"] > 0

        changed = invoke(client, chat["id"], "update_order_position", {
            "order_no": order_no, "position_id": position["id"], "qty": "7",
        })
        assert changed["data"]["positions"][0]["qty"] == 7
        assert changed["data"]["gross"] > created["data"]["gross"]
        undo(client, chat["id"], changed["change_id"])
        from gimel.db import SessionLocal
        from gimel.models import Order

        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == order_no).one()
            assert order.positions[0].qty == 3
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_admin_delete_paths_and_robot_reads(client):
    from gimel.db import SessionLocal
    from gimel.models import Order

    chat = client.post("/api/agent/chats", json={"write_mode": True}).json()
    try:
        created = invoke(client, chat["id"], "create_order", {
            "kind": "internal", "internal_owner": "Test",
            "lines": [
                {"kind": "custom", "mat": "service", "label": "A",
                 "qty": "2", "price_gross": 5},
                {"kind": "custom", "mat": "service", "label": "B",
                 "qty": "1", "price_gross": 5},
            ],
        })
        order_no = created["data"]["no"]
        removed = invoke(client, chat["id"], "delete_order_position", {
            "order_no": order_no, "position_index": 1,
        })
        assert len(removed["data"]["positions"]) == 1
        gone = invoke(client, chat["id"], "delete_order", {"order_no": order_no})
        assert gone["data"]["deleted"] is True
        with SessionLocal() as db:
            assert db.query(Order).filter(Order.no == order_no).first() is None

        for name, args in [
            ("list_robots", {}),
            ("list_robot_gateways", {}),
            ("list_robot_programs", {}),
            ("list_robot_jobs", {}),
        ]:
            result = invoke(client, chat["id"], name, args)
            assert "summary" in result and "data" in result
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_manual_tool_probe_and_write_guard(client):
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        result = invoke(client, chat["id"], "platform_overview")
        assert "summary" in result
        r = client.post(f"/api/agent/chats/{chat['id']}/tools/update_setting",
                        json={"arguments": {"key": "delivery_days", "value": "5"}})
        assert r.status_code == 409
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_more_read_tools(client):
    from gimel.db import SessionLocal
    from gimel.models import FactoryStation, Order, WorkOrder

    chat = client.post("/api/agent/chats", json={}).json()
    try:
        with SessionLocal() as db:
            order_no = db.query(Order.no).first()[0]
            wo_no = (db.query(WorkOrder.no)
                     .filter(WorkOrder.n_plates > 0)
                     .first()[0])
            station_id = db.query(FactoryStation.id).first()[0]
        for name, args in [
            ("get_production_queue", {}),
            ("get_worklist", {}),
            ("list_tasks", {}),
            ("get_staging", {}),
            ("get_picking", {}),
            ("get_topology", {}),
            ("get_order_scope", {"order_no": order_no}),
            ("get_work_order_layout", {"work_order_no": wo_no}),
            ("get_nesting_policies", {}),
            ("get_rates", {}),
            ("get_shipping_ready", {}),
            ("get_audit_actions", {}),
            ("get_compliance", {}),
            ("get_account", {}),
            ("get_station_queue", {"station_id": station_id}),
        ]:
            result = invoke(client, chat["id"], name, args)
            assert "summary" in result, name
            assert "data" in result, name
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_more_write_tools_and_rollback(client):
    from gimel.db import SessionLocal
    from gimel.models import (
        Address, FactoryHall, FactorySite, FactoryStation, FactoryFloor,
        Order, Role, User, WorkOrder,
    )

    chat = client.post("/api/agent/chats", json={"write_mode": True}).json()
    created_orders: list[str] = []
    try:
        with SessionLocal() as db:
            order_no = db.query(Order.no).filter(Order.blocked.is_(False)).first()[0]
            wo_no = (db.query(WorkOrder.no)
                     .filter(WorkOrder.status == "open", WorkOrder.n_plates > 0)
                     .first()[0])
            customer = db.query(User).filter(User.role == Role.customer).first()
            site = db.query(FactorySite).first()
            hall = db.query(FactoryHall).first()

        # clone and reorder
        clone = invoke(client, chat["id"], "clone_order", {"order_no": order_no})
        created_orders.append(clone["data"]["no"])
        undo(client, chat["id"], clone["change_id"])
        reorder = invoke(client, chat["id"], "reorder_order", {"order_no": order_no})
        created_orders.append(reorder["data"]["no"])
        undo(client, chat["id"], reorder["change_id"])

        # scope
        scope = invoke(client, chat["id"], "set_order_scope",
                       {"order_no": order_no, "route_scope": "site:1"})
        undo(client, chat["id"], scope["change_id"])
        wscope = invoke(client, chat["id"], "set_work_order_scope",
                        {"work_order_no": wo_no, "route_scope": "floor:1"})
        undo(client, chat["id"], wscope["change_id"])

        # plate status
        plate = invoke(client, chat["id"], "set_plate_status",
                       {"work_order_no": wo_no, "plate_idx": 0, "status": "running"})
        undo(client, chat["id"], plate["change_id"])

        # addresses: create, change, then undo both in reverse order
        assert customer is not None
        new_addr = invoke(client, chat["id"], "add_customer_address", {
            "customer_id": customer.id, "street": "Testweg 1",
            "zip": "12345", "city": "Teststadt", "country": "DE",
        })
        new_addr_id = new_addr["data"]["id"]
        changed = invoke(client, chat["id"], "update_customer_address", {
            "customer_id": customer.id, "address_id": new_addr_id,
            "city": "Geändertstadt",
        })
        undo(client, chat["id"], changed["change_id"])
        undo(client, chat["id"], new_addr["change_id"])

        # site and hall
        site_create = invoke(client, chat["id"], "create_site",
                             {"name": "Agent-Teststandort", "code": "AT"})
        undo(client, chat["id"], site_create["change_id"])
        hall_create = invoke(client, chat["id"], "create_hall",
                             {"site_id": site.id, "name": "Agent-Test-Halle"})
        undo(client, chat["id"], hall_create["change_id"])

        # floor under the existing hall
        floor = invoke(client, chat["id"], "create_floor",
                       {"hall_id": hall.id, "level": 9, "level_name": "Testebene"})
        undo(client, chat["id"], floor["change_id"])
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")
