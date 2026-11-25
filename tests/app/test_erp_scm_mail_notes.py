"""Ende-zu-Ende-Tests für das verallgemeinerte ERP, Auto-Lieferanten, Smart-Lager,
Kalender, E-Mail-Zentrale, Kollegen-Notizen, Smarter Laufschein & Copilot-Tools."""

from __future__ import annotations

import uuid

from gimel.db import SessionLocal
from gimel.models import (
    AuditLog,
    CalendarEvent,
    FactorySetting,
    GoodsReceipt,
    MailMessage,
    MaterialLot,
    PriceHistory,
    Product,
    PurchaseOrder,
    PurchaseOrderLine,
    StockLocation,
    StockMovement,
    Supplier,
    SupplierMaterial,
    SupplyAlert,
    TeamNote,
    User,
    WorkOrder,
)


def test_generalized_material_auto_supplier_and_goods_receipt(client):
    pid = f"alu-blech-{uuid.uuid4().hex[:6]}"
    scode1 = f"ALU1{uuid.uuid4().hex[:3].upper()}"
    scode2 = f"ALU2{uuid.uuid4().hex[:3].upper()}"
    po_no = ""
    try:
        # 1. Verallgemeinerter Werkstoff (Kategorie "metall") mit Nachschubregeln
        r = client.post(
            "/api/products",
            json={
                "id": pid,
                "name": "Aluminium EN AW-5754",
                "short": "AlMg3",
                "cat": "metall",
                "eur_m2": 65.0,
                "sheets": [[2000, 1000]],
                "thicknesses": [2.0, 3.0],
                "stock": 1,
                "min_stock": 5,
                "target_stock": 10,
                "safety_stock": 2,
                "auto_reorder": "propose",
                "sku_unit": "Tafel",
            },
        )
        assert r.status_code == 201, r.text
        assert r.json()["cat"] == "metall"
        assert r.json()["sku_unit"] == "Tafel"

        # 2. Zwei Lieferanten anlegen & zuordnen
        s1 = client.post(
            "/api/scm/suppliers",
            json={"code": scode1, "name": "Nordmetall Handel", "email": "bestellung@nordmetall.example", "default_lead_days": 4, "reliability_override": 0.96},
        ).json()
        s2 = client.post(
            "/api/scm/suppliers",
            json={"code": scode2, "name": "Südblech Werk", "email": "order@suedblech.example", "default_lead_days": 14, "reliability_override": 0.80},
        ).json()

        client.post(
            "/api/scm/supplier-materials",
            json={"supplier_id": s1["id"], "product_id": pid, "unit_eur_m2": 32.0, "moq_sheets": 4, "quoted_lead_days": 4, "sheet_w": 2000, "sheet_h": 1000, "preferred_rank": 1},
        )
        client.post(
            "/api/scm/supplier-materials",
            json={"supplier_id": s2["id"], "product_id": pid, "unit_eur_m2": 39.0, "moq_sheets": 8, "quoted_lead_days": 14, "sheet_w": 2000, "sheet_h": 1000, "preferred_rank": 2},
        )

        # 3. Auto-Supplier-Ranking prüfen: Nordmetall gewinnt klar (günstiger + schneller + zuverlässiger)
        rank = client.get(f"/api/scm/auto-supplier/{pid}?qty=5").json()
        assert rank["recommended"]["supplier_id"] == s1["id"]
        assert rank["recommended"]["score"] > rank["candidates"][1]["score"]

        # 4. Smart-Stock zeigt Unterdeckung (stock=1 < min_stock=5)
        smart = client.get("/api/scm/smart-stock").json()
        row = next(i for i in smart["items"] if i["product_id"] == pid)
        assert row["health"] == "reorder"
        assert row["recommended_supplier"]["supplier_id"] == s1["id"]

        # 5. Auto-Supplier-Bestellung + Mail-Entwurf erzeugen & Wareneingang mit Charge buchen
        ordered = client.post(
            f"/api/scm/auto-supplier/{pid}/order",
            json={"qty": 6, "mode": "order", "create_mail_draft": True},
        )
        assert ordered.status_code == 200, ordered.text
        po_no = ordered.json()["purchase_order"]["no"]
        mail_id = ordered.json()["mail_draft_id"]
        assert po_no.startswith("BE-")
        assert mail_id is not None

        rec = client.post(
            f"/api/scm/purchase-orders/{po_no}/receive",
            json={"delivery_note_no": "LS-9001", "cert_type": "3.1", "cert_ref": "WZ-31-ALU", "bin": "Fach M2"},
        )
        assert rec.status_code == 200, rec.text
        assert rec.json()["qty_received"] == 6
        assert len(rec.json()["lots"]) == 1

        # Bestand ist jetzt 1 + 6 = 7
        after_prod = client.get(f"/api/products/{pid}").json()
        assert after_prod["stock"] == 7
    finally:
        with SessionLocal() as db:
            db.query(MailMessage).filter(MailMessage.purchase_order_no == po_no).delete()
            db.query(MaterialLot).filter(MaterialLot.product_id == pid).delete()
            if po_no:
                po = db.query(PurchaseOrder).filter(PurchaseOrder.no == po_no).first()
                if po:
                    db.query(GoodsReceipt).filter(GoodsReceipt.purchase_order_id == po.id).delete(synchronize_session=False)
                    db.query(PurchaseOrderLine).filter(PurchaseOrderLine.purchase_order_id == po.id).delete(synchronize_session=False)
                    db.delete(po)
                    db.flush()
            db.query(SupplierMaterial).filter(SupplierMaterial.product_id == pid).delete(synchronize_session=False)
            db.query(Supplier).filter(Supplier.code.in_([scode1, scode2])).delete(synchronize_session=False)
            db.query(SupplyAlert).filter(SupplyAlert.product_id == pid).delete(synchronize_session=False)
            db.query(StockLocation).filter(StockLocation.product_id == pid).delete(synchronize_session=False)
            db.query(StockMovement).filter(StockMovement.product_id == pid).delete(synchronize_session=False)
            db.query(PriceHistory).filter(PriceHistory.product_id == pid).delete(synchronize_session=False)
            db.query(AuditLog).filter(AuditLog.entity_id.in_([pid, po_no])).delete(synchronize_session=False)
            p = db.get(Product, pid)
            if p:
                db.delete(p)
            db.commit()


def test_mail_center_coworker_notes_calendar_and_smarter_laufschein(client):
    ev_id = None
    note_id = None
    mail_id = None
    wo_no = ""
    try:
        # 1. Kalender-Übersicht, Termin anlegen & iCal-Export
        ov = client.get("/api/calendar/overview")
        assert ov.status_code == 200, ov.text
        assert ov.json()["daily_capacity_min"] > 0

        ev = client.post(
            "/api/calendar/events",
            json={"title": "Wartung Wasserstrahl", "kind": "wartung", "start_date": "2026-12-01", "capacity_block_min": 90},
        )
        assert ev.status_code == 201, ev.text
        ev_id = ev.json()["id"]

        ics = client.get("/api/calendar/export.ics")
        assert ics.status_code == 200
        assert "BEGIN:VCALENDAR" in ics.text
        assert "Wartung Wasserstrahl" in ics.text

        # 2. E-Mail-Entwurf & Trockenlauf-Versand
        draft = client.post(
            "/api/mail/drafts",
            json={"to_addrs": ["lieferant@example.test"], "subject": "Test-Anfrage", "body_text": "Bitte Angebot senden."},
        )
        assert draft.status_code == 201, draft.text
        mail_id = draft.json()["id"]
        sent = client.post(f"/api/mail/messages/{mail_id}/send")
        assert sent.status_code == 200
        assert sent.json()["message"]["folder"] == "sent"

        # 3. Kollegen-Notiz mit Innenauftragsbezug & Quittierung + Smarter Laufschein
        with SessionLocal() as db:
            wo_no = db.query(WorkOrder).first().no

        note = client.post(
            "/api/notes",
            json={
                "channel": "schicht",
                "priority": "urgent",
                "subject": "Schichthinweis",
                "body": "Bitte zuerst Reststücke prüfen!",
                "entity_type": "work_order",
                "entity_id": wo_no,
                "ack_required": True,
            },
        )
        assert note.status_code == 201, note.text
        note_id = note.json()["id"]

        ack = client.post(f"/api/notes/{note_id}/ack")
        assert ack.status_code == 200
        assert ack.json()["acknowledged_at"] is not None

        # Smarter Laufschein enthält die verknüpfte Kollegen-Notiz, Lagerort-Box & Live-Sync-URL (CSP-sauber!)
        sheet = client.get(f"/api/production/work-orders/{wo_no}/sheet")
        assert sheet.status_code == 200
        assert "Bitte zuerst Reststücke prüfen!" in sheet.text
        assert "data-state-url=" in sheet.text

        st_put = client.put(
            f"/api/production/work-orders/{wo_no}/traveller-state",
            json={"checked": {"step:1": 1, "qc:l1": 1}, "elapsed_sec": 125, "selected_lot": "CH-26-0001"},
        )
        assert st_put.status_code == 200
        assert st_put.json()["elapsed_sec"] == 125
        assert st_put.json()["checked"]["step:1"] == 1

        # 4. Copilot Lab Tools direkt prüfen
        from agentlab.tools import ToolContext, execute_tool

        with SessionLocal() as db:
            admin = db.query(User).filter(User.role == "admin").first()
            ctx = ToolContext(db=db, user=admin, chat=None)
            t_stock = execute_tool(ctx, "get_smart_stock", {}, write_mode=False)
            assert "summary" in t_stock
            t_cw = execute_tool(ctx, "list_coworkers", {}, write_mode=False)
            assert t_cw["count"] >= 1
    finally:
        with SessionLocal() as db:
            if ev_id:
                db.query(CalendarEvent).filter(CalendarEvent.id == ev_id).delete()
            if note_id:
                db.query(TeamNote).filter(TeamNote.id == note_id).delete()
            if mail_id:
                db.query(MailMessage).filter(MailMessage.id == mail_id).delete()
            if wo_no:
                db.query(FactorySetting).filter(FactorySetting.key == f"lk_state:{wo_no}").delete()
            db.commit()
