"""Big-data scalability invariants: indexes, chunked IN, cursor pagination, SQL summaries, streaming CSV."""

from __future__ import annotations

from sqlalchemy import text

from gimel import seed
from gimel.db import SessionLocal, chunked_in, engine
from gimel.models import Order, Shipment, ShipmentItem
from gimel.services import shipping as ship_svc


def test_ensure_indexes_is_idempotent_and_creates_composite_indexes(client):
    seed.ensure_indexes()
    assert seed.ensure_indexes() == []
    with engine.connect() as conn:
        names = {
            row[0]
            for row in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='index'")
            ).all()
        }
    for expected in (
        "ix_orders_created_id",
        "ix_orders_stage_cancel_created",
        "ix_orders_user_paid_cancel",
        "ix_work_orders_station_status",
        "ix_shipments_status_created",
        "ix_audit_log_entity_id_at",
    ):
        assert expected in names, f"missing index {expected}"


def test_chunked_in_handles_more_than_sqlite_variable_limit(client):
    with SessionLocal() as db:
        first = db.query(Order.id).order_by(Order.id).first()
        assert first is not None
        ids = [first[0]] + list(range(1_000_000, 1_001_250))
        rows = db.query(Order.id).filter(chunked_in(Order.id, ids, chunk_size=400)).all()
        assert [r[0] for r in rows] == [first[0]]


def test_admin_orders_keyset_cursor_pagination_and_summary(client):
    summary_r = client.get("/api/admin/orders/summary")
    assert summary_r.status_code == 200
    summary = summary_r.json()
    assert summary["total"] > 0
    assert summary["open"] + summary["abgeschlossen"] + summary["storniert"] == summary["total"]

    seen: list[str] = []
    cursor = None
    for _ in range(5):
        params: dict[str, object] = {"limit": 2, "sort": "created"}
        if cursor:
            params["cursor"] = cursor
        r = client.get("/api/admin/orders", params=params)
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == summary["total"]
        batch_nos = [item["no"] for item in body["items"]]
        assert not (set(seen) & set(batch_nos)), "cursor pages must not overlap"
        seen.extend(batch_nos)
        if not body["has_more"]:
            assert body["next_cursor"] is None
            break
        cursor = body["next_cursor"]
        assert cursor is not None
    assert len(seen) >= min(summary["total"], 4)


def test_invoicing_summary_and_pagination_headers(client):
    r_sum = client.get("/api/invoicing/summary")
    assert r_sum.status_code == 200
    s = r_sum.json()
    assert {
        "total",
        "open_count",
        "overdue_count",
        "paid_count",
        "open_sum",
        "overdue_sum",
        "paid_30d_sum",
        "aging",
    } <= set(s)
    assert set(s["aging"]) == {"0_14", "15_30", "31_60", "60_plus"}

    r_list = client.get("/api/invoicing/invoices", params={"limit": 5, "offset": 0})
    assert r_list.status_code == 200
    assert "x-total-count" in {k.lower() for k in r_list.headers}
    assert isinstance(r_list.json(), list)


def test_shipping_pagination_and_ready_rows_excludes_shipped(client):
    r = client.get("/api/shipping/", params={"limit": 2, "offset": 0})
    assert r.status_code == 200
    body = r.json()
    assert {"total", "has_more", "shipments"} <= set(body)
    assert len(body["shipments"]) <= 2

    with SessionLocal() as db:
        ready = ship_svc.order_ready_rows(db)
        shipped_order_ids = {
            oid
            for (oid,) in db.query(ShipmentItem.order_id)
            .join(Shipment, Shipment.id == ShipmentItem.shipment_id)
            .filter(Shipment.status != "cancelled", ShipmentItem.order_id.isnot(None))
            .distinct()
            .all()
        }
        for row in ready:
            assert row["order_id"] not in shipped_order_ids


def test_orders_export_csv_streams_utf8_bom_semicolon(client):
    r = client.get("/api/desk/export/orders.csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert r.content.startswith(b"\xef\xbb\xbf")
    text_body = r.content.decode("utf-8-sig")
    lines = [ln for ln in text_body.splitlines() if ln.strip()]
    assert len(lines) >= 2
    assert ";" in lines[0]
