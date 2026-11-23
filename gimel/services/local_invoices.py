"""Rechnungen ohne Stripe: Gimel stellt sie selbst aus.

Die Regeln sind die der GoBD und des § 14 UStG:

* **Lückenlos je Jahr.** Die Nummer entsteht in derselben Transaktion wie die
  Rechnung. ``_next_seq`` ist deren erster Schreibvorgang und hält damit unter
  SQLite die Schreibsperre bis zum Commit; scheitert etwas, rollt der Zähler mit
  zurück. Keine Nummer geht verloren, keine wird doppelt vergeben.
* **Unveränderlich.** ``LocalInvoice`` wird nur angehängt (Sperre in models.py).
* **Korrektur nur per Storno** mit eigener Nummer aus derselben Folge. Danach ist
  der Auftrag wieder frei für eine berichtigte Rechnung.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..extensions import active
from ..models import AuditLog, LocalInvoice, Order, Shipment, ShipmentItem
from . import einvoice, identity, stripe_client


@dataclass
class Refused(Exception):
    """Fachliche Ablehnung; der Router macht daraus einen 409."""

    message: str


def allowed() -> bool:
    plugin = active()
    return plugin.local_invoicing if plugin else True


def enabled() -> bool:
    return allowed() and not stripe_client.secret_key()


def today() -> date:
    """Das Datum am Ort des Betriebs: um 23:30 UTC am 31.12. ist in Köln schon Neujahr."""
    return datetime.now().astimezone().date()


def current(db: Session, order: Order) -> LocalInvoice | None:
    """Die gültige lokale Rechnung des Auftrags. Unter Alef kein Blick in die Tabelle."""
    if not allowed() or not order.invoice_no:
        return None
    return db.query(LocalInvoice).filter(LocalInvoice.number == order.invoice_no).first()


def delivery_date(db: Session, order: Order) -> date | None:
    """Letzter Versandtag des Auftrags; ohne Versand gibt es keinen."""
    rows = (db.query(Shipment.shipped_at)
            .join(ShipmentItem, ShipmentItem.shipment_id == Shipment.id)
            .filter(ShipmentItem.order_id == order.id, Shipment.shipped_at.isnot(None)).all())
    return max(r[0] for r in rows).date() if rows else None


def _next_seq(db: Session, year: int) -> int:
    row = db.execute(text(
        "INSERT INTO local_invoice_counters (year, last) VALUES (:year, 1) "
        "ON CONFLICT (year) DO UPDATE SET last = local_invoice_counters.last + 1 "
        "RETURNING last"), {"year": year}).one()
    return int(row[0])


def _fresh_order(db: Session, order_no: str) -> Order:
    """Unter der Schreibsperre neu gelesen: ein paralleler Lauf ist jetzt sichtbar."""
    return db.query(Order).filter(Order.no == order_no).populate_existing().one()


def _row(data: dict, number: str, year: int, seq: int, kind: str, order_no: str, issued: date,
         due: date | None, delivery: date | None, xml: str, actor: str, refers_to: str = "") -> LocalInvoice:
    return LocalInvoice(
        number=number, year=year, seq=seq, kind=kind, order_no=order_no, refers_to=refers_to,
        issue_date=issued, due_date=due, delivery_date=delivery, net_cents=data["net"],
        vat_cents=data["vat"], gross_cents=data["gross"], data=data, xml=xml,
        sha256=hashlib.sha256(xml.encode("utf-8")).hexdigest(), created_by=actor,
    )


def issue(db: Session, order_no: str, data: dict, *, delivery: date, due_days: int, actor: str,
          on: date | None = None) -> LocalInvoice:
    """Die Rechnung ausstellen. ``data`` kommt geprüft aus ``_billing_input``."""
    issued = on or today()
    extras = identity.invoice_extras(db)
    if extras.get("smallBusiness"):
        # Ausgewiesene Steuer schuldet ein Kleinunternehmer trotzdem (§ 14c Abs. 2 UStG).
        raise Refused("Kleinunternehmer nach § 19 UStG: Gimel weist immer Umsatzsteuer aus und "
                      "stellt diese Rechnung deshalb nicht aus.")
    data = {**data, "seller": {**data["seller"], **extras}}
    try:
        seq = _next_seq(db, issued.year)
        order = _fresh_order(db, order_no)
        if order.invoice_no:
            raise Refused(f"Es gibt bereits eine Rechnung ({order.invoice_no}). "
                          "Korrektur nur per Storno.")
        number = f"RE-{issued.year}-{seq:04d}"
        paid = bool(order.paid)
        due = None if paid else issued + timedelta(days=due_days)
        stamped = {**data, "prepaid": data["gross"] if paid else 0,
                   "delivery_date": delivery.isoformat(),
                   "note": f"Lieferdatum {delivery.strftime('%d.%m.%Y')}.",
                   "payment_note": "Bereits bezahlt." if paid else ""}
        xml = einvoice.build(stamped, number, issued.isoformat(), due.isoformat() if due else None)
        row = _row(stamped, number, issued.year, seq, "invoice", order_no, issued, due, delivery, xml, actor)
        db.add(row)
        now = datetime.now(timezone.utc)
        order.invoice_no = number
        order.invoice_reference = number
        order.invoiced_at = now
        order.invoice_due_at = now + timedelta(days=due_days) if due else None
        order.payment_method = order.payment_method or "invoice"
        db.add(AuditLog(actor=actor, action="invoice_create", entity="order", entity_id=order_no,
                        detail={"invoice_id": number, "local": True, "total_cents": data["gross"],
                                "prepaid_cents": stamped["prepaid"], "email": data["buyer"].get("email", "")}))
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(row)
    return row


def cancel(db: Session, order_no: str, original_no: str, reason: str, *, actor: str,
           on: date | None = None) -> LocalInvoice:
    """Storno: eigene Nummer, Bezug auf das Original, gleiche Beträge."""
    issued = on or today()
    try:
        seq = _next_seq(db, issued.year)
        order = _fresh_order(db, order_no)
        if order.invoice_no != original_no:
            raise Refused(f"Rechnung {original_no} ist nicht mehr die gültige Rechnung dieses Auftrags.")
        original = db.query(LocalInvoice).filter(LocalInvoice.number == original_no).one()
        number = f"RE-{issued.year}-{seq:04d}"
        stamped = {**original.data, "prepaid": 0, "payment_note": "Storno",
                   "note": f"Storno der Rechnung {original_no} vom "
                           f"{original.issue_date.strftime('%d.%m.%Y')}. Grund: {reason}"}
        xml = einvoice.build(stamped, number, issued.isoformat(), None, credit_of=original_no)
        row = _row(stamped, number, issued.year, seq, "storno", order_no, issued, None,
                   original.delivery_date, xml, actor, refers_to=original_no)
        db.add(row)
        order.invoice_no = ""
        order.invoice_reference = ""
        order.invoiced_at = None
        order.invoice_due_at = None
        db.add(AuditLog(actor=actor, action="invoice_cancel", entity="order", entity_id=order_no,
                        detail={"invoice_id": original_no, "storno": number, "reason": reason,
                                "total_cents": row.gross_cents}))
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(row)
    return row


def status_of(row: LocalInvoice, cancelled_by: dict[str, str], paid: set[str]) -> str:
    if row.kind == "storno":
        return "storno"
    if row.number in cancelled_by:
        return "storniert"
    return "bezahlt" if row.order_no in paid else "offen"


def listing(db: Session) -> list[dict]:
    """Alle Belege, auch stornierte: die Auftragsliste kennt nur die gültige Rechnung."""
    rows = db.query(LocalInvoice).order_by(LocalInvoice.year.desc(), LocalInvoice.seq.desc()).all()
    cancelled_by = {r.refers_to: r.number for r in rows if r.kind == "storno"}
    nos = {r.order_no for r in rows}
    paid = {no for (no,) in db.query(Order.no).filter(Order.no.in_(nos), Order.paid.is_(True))}
    return [{
        "number": r.number, "kind": r.kind, "order_no": r.order_no, "refers_to": r.refers_to,
        "cancelled_by": cancelled_by.get(r.number, ""), "issue_date": r.issue_date.isoformat(),
        "due_date": r.due_date.isoformat() if r.due_date else None,
        "delivery_date": r.delivery_date.isoformat() if r.delivery_date else None,
        "net_cents": r.net_cents, "vat_cents": r.vat_cents, "gross_cents": r.gross_cents,
        "customer": (r.data.get("buyer") or {}).get("name", ""),
        "status": status_of(r, cancelled_by, paid),
    } for r in rows]
