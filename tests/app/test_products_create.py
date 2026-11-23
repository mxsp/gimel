"""Ein neuer Werkstoff ist mehr als eine Zeile im Katalog: Preis und Protokoll
müssen im selben Zug entstehen.

Bis 2026-11-03 legte ``POST /api/products`` die Preiszeile vor dem Werkstoff an;
SQLite verweigerte den Fremdschlüssel, und der einzige Weg, einen Werkstoff
anzulegen, endete mit 500. Der Test hält die Reihenfolge fest.
"""

from __future__ import annotations

from gimel import demo
from gimel.db import SessionLocal
from gimel.models import AuditLog, PriceHistory, Product

PID = "test-neuer-werkstoff"


def _cleanup() -> None:
    with SessionLocal() as db:
        db.query(PriceHistory).filter(PriceHistory.product_id == PID).delete()
        db.query(AuditLog).filter(AuditLog.action == "product_create",
                                  AuditLog.entity_id == PID).delete()
        row = db.get(Product, PID)
        if row:
            db.delete(row)
        db.commit()


def test_a_new_material_gets_a_price_line_and_an_audit_line(client):
    _cleanup()
    body = {
        "id": PID,
        "name": "Test-Werkstoff",
        "short": "Test",
        "brand": "",
        "cat": "elastomer",
        "colour": "#2f3b46",
        "eur_m2": 42,
        "sheets": [[1000, 1000]],
        "thicknesses": [2, 3],
        "lead_days": 3,
        "cnc": "check",
        "grain": "none",
        "active": True,
        "kerf": None,
        "web": None,
        "min_web": None,
    }
    try:
        r = client.post("/api/products", json=body)
        assert r.status_code == 201, r.text
        created = r.json()
        assert created["id"] == PID
        assert created["eur_m2"] == 42
        assert created["sheets"] == [[1000.0, 1000.0]]
        assert created["thicknesses"] == [2.0, 3.0]

        history = client.get(f"/api/products/{PID}/price-history")
        assert history.status_code == 200, history.text
        assert history.json()[0]["reason"] == "angelegt"
        assert history.json()[0]["new_eur_m2"] == 42

        with SessionLocal() as db:
            audit = (db.query(AuditLog)
                       .filter(AuditLog.action == "product_create",
                               AuditLog.entity_id == PID).one())
            assert audit.actor == demo.ADMIN_EMAIL
            assert audit.detail["eur_m2"] == 42
    finally:
        _cleanup()


def test_a_new_material_without_a_sheet_is_refused(client):
    _cleanup()
    body = {
        "id": PID,
        "name": "Test-Werkstoff",
        "cat": "elastomer",
        "eur_m2": 42,
        "sheets": [],
    }
    r = client.post("/api/products", json=body)
    assert r.status_code == 422, r.text
    assert "Plattenformat" in r.text
    _cleanup()
