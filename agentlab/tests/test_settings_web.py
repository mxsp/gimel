from __future__ import annotations

import pytest


def test_settings_are_readable_and_validated(client):
    data = client.get("/api/agent/settings").json()
    assert data["admin"] is True
    assert data["values"]["agent_web_enabled"] == "true"
    assert data["values"]["agent_pdf_max_pages"] == "250"
    fields = {field["key"]: field for field in data["fields"]}
    assert fields["agent_web_provider"]["kind"] == "select"
    assert fields["agent_web_api_key"]["secret"] is True

    changed = client.put("/api/agent/settings", json={
        "values": {
            "agent_web_max_results": "7",
            "agent_max_steps": "50",
            "agent_orchestrator_max_steps": "80",
            "agent_subagent_max_steps": "25",
        },
    })
    assert changed.status_code == 200, changed.text
    assert changed.json()["values"]["agent_web_max_results"] == "7"
    assert changed.json()["values"]["agent_max_steps"] == "50"
    assert changed.json()["values"]["agent_orchestrator_max_steps"] == "80"
    assert changed.json()["values"]["agent_subagent_max_steps"] == "25"

    bad = client.put("/api/agent/settings", json={"values": {"agent_max_steps": "101"}})
    assert bad.status_code == 422
    bad_sub = client.put("/api/agent/settings", json={"values": {"agent_subagent_max_steps": "51"}})
    assert bad_sub.status_code == 422
    unknown = client.put("/api/agent/settings", json={"values": {"nicht_da": "1"}})
    assert unknown.status_code == 422

    client.post("/api/agent/settings/reset",
                json={"keys": [
                    "agent_web_max_results",
                    "agent_max_steps",
                    "agent_orchestrator_max_steps",
                    "agent_subagent_max_steps",
                ]})


def test_web_key_is_sealed_and_masked(client):
    try:
        changed = client.put("/api/agent/settings", json={
            "values": {"agent_web_api_key": "tvly-test-secret-123"},
        })
        assert changed.status_code == 200, changed.text
        assert "tvly-test-secret-123" not in changed.text
        assert changed.json()["has_web_key"] is True
        assert changed.json()["values"]["agent_web_api_key"] == ""

        from agentlab.models import AgentSetting
        from gimel.db import SessionLocal

        with SessionLocal() as db:
            row = db.get(AgentSetting, "agent_web_api_key")
            assert row.value.startswith("v1:")
            assert "tvly-test-secret-123" not in row.value
    finally:
        client.put("/api/agent/settings", json={"values": {"agent_web_api_key": ""}})


def test_web_tools_follow_the_switch_and_use_the_search(client, monkeypatch):
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        tools = {tool["name"]: tool for tool in client.get("/api/agent/tools").json()["tools"]}
        assert tools["web_search"]["network"] is True
        assert tools["web_search"]["available"] is True

        client.put("/api/agent/settings", json={"values": {"agent_web_enabled": "false"}})
        tools = {tool["name"]: tool for tool in client.get("/api/agent/tools").json()["tools"]}
        assert tools["web_search"]["available"] is False
        denied = client.post(f"/api/agent/chats/{chat['id']}/tools/web_search",
                             json={"arguments": {"query": "Gimel"}})
        assert denied.status_code == 422
        assert "ausgeschaltet" in denied.text

        client.put("/api/agent/settings", json={"values": {"agent_web_enabled": "true"}})

        import agentlab.tools as tools_module

        def fake_search(db, query, *, limit=None):
            return {"provider": "duckduckgo", "query": query, "results": [
                {"title": "Gimel", "url": "https://example.org/gimel",
                 "snippet": "Beispiel", "source": "web"},
            ]}

        monkeypatch.setattr(tools_module.websearch, "search", fake_search)
        result = client.post(f"/api/agent/chats/{chat['id']}/tools/web_search",
                             json={"arguments": {"query": "Gimel"}})
        assert result.status_code == 200, result.text
        assert result.json()["data"]["results"][0]["url"] == "https://example.org/gimel"
    finally:
        client.put("/api/agent/settings", json={"values": {"agent_web_enabled": "true"}})
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_url_guard_rejects_local_and_odd_schemes():
    from agentlab.websearch import WebSearchError, check_url

    for url in ("http://127.0.0.1:8000/api", "http://localhost/", "file:///etc/passwd",
                "http://10.0.0.5/", "https://user:pass@example.org/"):
        with pytest.raises(WebSearchError):
            check_url(url)
    assert check_url("https://example.org/") == "https://example.org/"


def test_new_tools_are_available_and_read_real_data(client):
    from gimel.db import SessionLocal
    from gimel.models import Order, Product, Role, User

    chat = client.post("/api/agent/chats", json={}).json()
    try:
        with SessionLocal() as db:
            order = db.query(Order).first()
            customer = db.query(User).filter(User.role == Role.customer).first()
            product = db.query(Product).first()
        calls = [
            ("global_search", {"query": order.no[:4]}),
            ("get_customer_orders", {"customer_id": customer.id}),
            ("get_order_timeline", {"order_no": order.no}),
            ("get_low_stock", {"threshold": 1000}),
            ("get_stock_history", {"product_id": product.id}),
            ("get_price_history", {"product_id": product.id}),
            ("get_station_load", {}),
            ("get_due_orders", {"days": 3650}),
            ("get_shipment_board", {}),
            ("get_activity", {"days": 3650}),
        ]
        for name, args in calls:
            r = client.post(f"/api/agent/chats/{chat['id']}/tools/{name}",
                            json={"arguments": args})
            assert r.status_code == 200, f"{name}: {r.status_code} {r.text}"
            assert "summary" in r.json() and "data" in r.json()
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_block_order_and_handler_are_reversible(client):
    from gimel import demo
    from gimel.db import SessionLocal
    from gimel.models import Order

    with SessionLocal() as db:
        order = db.query(Order).filter(Order.blocked.is_(False)).first()
    chat = client.post("/api/agent/chats", json={"write_mode": True}).json()
    try:
        blocked = client.post(f"/api/agent/chats/{chat['id']}/tools/block_order",
                              json={"arguments": {"order_no": order.no,
                                                  "blocked": True, "reason": "Test"}})
        assert blocked.status_code == 200, blocked.text
        with SessionLocal() as db:
            assert db.query(Order).filter(Order.no == order.no).one().blocked is True
        undo = client.post(
            f"/api/agent/chats/{chat['id']}/changes/{blocked.json()['change_id']}/revert"
        )
        assert undo.status_code == 200, undo.text
        with SessionLocal() as db:
            assert db.query(Order).filter(Order.no == order.no).one().blocked is False

        handler = client.post(f"/api/agent/chats/{chat['id']}/tools/set_order_handler",
                              json={"arguments": {"order_no": order.no,
                                                  "email": demo.ADMIN_EMAIL,
                                                  "reason": "Test"}})
        assert handler.status_code == 200, handler.text
        undo = client.post(
            f"/api/agent/chats/{chat['id']}/changes/{handler.json()['change_id']}/revert"
        )
        assert undo.status_code == 200, undo.text
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")
