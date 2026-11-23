"""Tests für die optimierte digitale Laufkarte, echte QR-Codes und opt-in Netz-Freigabe."""

from __future__ import annotations

import uuid
import pytest

from gimel.db import SessionLocal
from gimel.models import Order, OrderPosition, Role, User, WorkItem, WorkOrder, WorkOrderStatus
from gimel.render.qr import encode_qr, qr_svg
from gimel.security import create_access_token, hash_password
from gimel.services import batch_runner


def _worker_headers() -> dict:
    email = f"worker-lk-{uuid.uuid4().hex[:6]}@example.test"
    with SessionLocal() as db:
        u = User(email=email, name="Werker Test", role=Role.worker, password_hash=hash_password("maple-river-7429"))
        db.add(u)
        db.commit()
        token = create_access_token(u)
    return {"Authorization": f"Bearer {token}"}


def _seed_work_order(client) -> tuple[str, int]:
    """Legt einen Auftrag an, führt einen Sammellauf aus und gibt (wo_no, position_id) zurück."""
    with SessionLocal() as db:
        existing = db.query(WorkOrder).filter(WorkOrder.status != WorkOrderStatus.cancelled).first()
        if existing:
            items = db.query(WorkItem).filter(WorkItem.work_order_id == existing.id).all()
            pos_id = next((it.position_id for it in items if it.position_id), 0)
            if pos_id:
                return existing.no, pos_id

    r = client.post(
        "/api/desk/orders",
        json={
            "customer": {
                "company": "Laufkarte Test GmbH",
                "contact": "Erika Muster",
                "email": "erika@laufkarte-test.example",
                "street": "Werkstraße 9",
                "zip": "80331",
                "city": "München",
                "country": "DE",
            },
            "customer_ref": "LK-REF-99",
            "positions": [
                {"mat": "epdm-70", "thk": 3.0, "od": 120.0, "di": 60.0, "qty": 2, "label": "Ring DN50"}
            ],
        },
    )
    assert r.status_code in (200, 201), r.text
    order_no = r.json()["order_no"]
    client.post(f"/api/admin/orders/{order_no}/release", json={"note": "Test"})
    with SessionLocal() as db:
        batch_runner.run_batch(db, trigger="manual", force=True)
        wo = db.query(WorkOrder).order_by(WorkOrder.id.desc()).first()
        assert wo is not None
        items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
        pos_id = next((it.position_id for it in items if it.position_id), 0)
        return wo.no, pos_id


def test_qr_encoder_generates_valid_svg_for_short_and_url_payloads():
    m1 = encode_qr("IA-26-0001")
    assert len(m1) == 21
    url = "https://gimel.example.com/laufkarte/AbCdEfGhIjKlMnOpQrStUvWxYz012345"
    m2 = encode_qr(url)
    assert len(m2) >= 29
    svg = qr_svg(url, size=96)
    assert svg.startswith("<svg ")
    assert 'shape-rendering="crispEdges"' in svg
    assert "<path d=" in svg


def test_digital_laufkarte_opt_in_net_share_lifecycle(client):
    wo_no, pos_id = _seed_work_order(client)
    worker_headers = _worker_headers()

    # 1. Standardmäßig AUS — nicht öffentlich erreichbar.
    r0 = client.get(f"/api/production/work-orders/{wo_no}/share")
    assert r0.status_code == 200
    assert r0.json()["enabled"] is False
    assert r0.json()["url"] == ""
    assert client.get("/laufkarte/not-a-valid-token-at-all-123456").status_code == 404

    # 2. Werker darf Status lesen, aber nicht freigeben oder widerrufen.
    rw = client.get(f"/api/production/work-orders/{wo_no}/share", headers=worker_headers)
    assert rw.status_code == 200
    assert client.post(
        f"/api/production/work-orders/{wo_no}/share",
        json={"enabled": True, "mode": "floor"},
        headers=worker_headers,
    ).status_code == 403
    assert client.delete(
        f"/api/production/work-orders/{wo_no}/share",
        headers=worker_headers,
    ).status_code == 403

    # 3. Büro schaltet opt-in Netz-Freigabe im Werkstatt-Modus (floor) ein.
    r_on = client.post(
        f"/api/production/work-orders/{wo_no}/share",
        json={"enabled": True, "mode": "floor", "expires_days": 7},
    )
    assert r_on.status_code == 200
    share = r_on.json()
    assert share["enabled"] is True
    assert share["mode"] == "floor"
    assert share["token"]
    assert share["url"].endswith(f"/laufkarte/{share['token']}")
    assert "<svg " in share["qr_svg"]

    # 4. Öffentliche Netz-URL ohne Login erreichbar — anonymisiert (kein €, kein Kundenname).
    pub_path = f"/laufkarte/{share['token']}"
    pub = client.get(pub_path, headers={"Authorization": ""})
    assert pub.status_code == 200
    assert pub.headers.get("x-robots-tag") == "noindex, nofollow"
    assert pub.headers.get("cache-control") == "no-store"
    assert wo_no in pub.text
    assert 'data-check="step:1"' in pub.text
    assert 'data-check="marke:' in pub.text
    assert 'data-check="qc:l1"' in pub.text
    assert "Digital · Netz" in pub.text
    assert "€" not in pub.text
    assert "Laufkarte Test GmbH" not in pub.text

    # 5. Token-gebundene DXF-Downloads funktionieren direkt über den Netz-Link.
    plate_dxf_resp = client.get(f"{pub_path}/plate/0.dxf", headers={"Authorization": ""})
    assert plate_dxf_resp.status_code == 200
    assert "SECTION" in plate_dxf_resp.text
    if pos_id:
        part_dxf_resp = client.get(f"{pub_path}/part/{pos_id}.dxf", headers={"Authorization": ""})
        assert part_dxf_resp.status_code == 200
        assert "SECTION" in part_dxf_resp.text

    # 6. Auch die interne Laufkarte trägt jetzt den Netz-QR-Code.
    internal_sheet = client.get(f"/api/production/work-orders/{wo_no}/sheet")
    assert internal_sheet.status_code == 200
    assert "DIGITAL · NETZ" in internal_sheet.text

    # 7. Token rotieren — alter Link sofort 404, neuer Link 200.
    r_rot = client.post(
        f"/api/production/work-orders/{wo_no}/share",
        json={"enabled": True, "mode": "office", "rotate": True},
    )
    assert r_rot.status_code == 200
    new_token = r_rot.json()["token"]
    assert new_token != share["token"]
    assert client.get(pub_path, headers={"Authorization": ""}).status_code == 404
    assert client.get(f"{pub_path}/plate/0.dxf", headers={"Authorization": ""}).status_code == 404
    pub2 = client.get(f"/laufkarte/{new_token}", headers={"Authorization": ""})
    assert pub2.status_code == 200
    assert "€" in pub2.text

    # 8. Widerrufen — sofort 404.
    r_del = client.delete(f"/api/production/work-orders/{wo_no}/share")
    assert r_del.status_code == 200
    assert r_del.json()["enabled"] is False
    assert client.get(f"/laufkarte/{new_token}", headers={"Authorization": ""}).status_code == 404
