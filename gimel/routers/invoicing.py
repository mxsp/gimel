"""Rechnungswesen — Stripe Invoicing aus dem Auftragsbüro.

Der Weg, den der Mitarbeiter mit einem Klick auslöst: aus dem Auftrag wird
eine echte Stripe-Rechnung, Stripe mailt sie an den Kunden, der Kunde zahlt
per Karte oder Überweisung, und der Zahlungseingang läuft als Webhook zurück
und bucht den Auftrag bezahlt. Buchen tut nur der Webhook — kein Browser und
kein Panel darf behaupten, Geld sei geflossen (dieselbe Vertrauensstufe wie
die Portalübernahme in routers/portal.py).

Vier Regeln, an denen sich alles festhält:

1. **Der Cent stimmt.** Die Positionen werden in Cent an Stripe übergeben und
   der Restcent wandert auf die größte Zeile — dieselbe Regel wie an der Kasse
   (CLAUDE.md §2.3). Die Rechnungssumme weicht nie vom Auftrag ab, und weicht
   der Aufbau trotzdem um mehr als Rundung, wird gar keine Rechnung erstellt.
2. **Die Mehrwertsteuer ist eine eigene Zeile**, kein tax_percent: Stripe
   rundet Steuer selbst, und dann liegt die Rechnung einen Cent neben dem
   Auftrag. Genau das ist die Fehlerklasse, die Checkout-Check absichert.
3. **Erneute Zustellung ist umsonst.** Ein Webhook für einen bereits bezahlten
   Auftrag antwortet 200 und bucht nichts zweimal.
4. **Erst das Geld, dann die Freigabe.** Nur ``invoice.paid`` gibt frei —
   ``invoice.created`` und ``invoice.finalized`` sind Papiere, kein Geld.
"""

from __future__ import annotations
from ..config import ENV_PREFIX

import hashlib
import json
import os
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Annotated, Optional

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import AuditLog, InvoiceDocument, LocalInvoice, StructuredInvoiceDocument, Order, Role, User
from ..render.invoice import invoice_html
from ..security import require_admin, require_staff
from ..services import csv_io, identity, local_invoices, smtp_client, stripe_client
from ..services.stripe_client import StripeUnavailable
from ..services import einvoice

router = APIRouter(prefix="/api/invoicing", tags=["invoicing"])


# --------------------------------------------------------------------------
# Hilfsbau
# --------------------------------------------------------------------------
def _cents(v: float) -> int:
    return int((Decimal(str(v)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _transfer_enabled() -> bool:
    """Banküberweisung anbieten? Dieselbe Schaltung wie im Bestellportal
    (``ALPHA_BANK_TRANSFER``), damit beide Wege dasselbe Bild ergeben."""
    return str(os.environ.get(ENV_PREFIX + "BANK_TRANSFER", "1")) != "0"


def _transfer_country() -> str:
    return str(os.environ.get(ENV_PREFIX + "TRANSFER_COUNTRY", "DE")).upper()[:2] or "DE"


def _payment_settings() -> dict:
    """Karte und klassische Banküberweisung — wie an der Kasse des Portals.

    Ohne ``customer_balance`` mit ``funding_type: bank_transfer`` zeigt die
    gehostete Rechnungsseite überhaupt kein Konto an: es gäbe nur Karte. Erst
    diese Einstellung lässt Stripe IBAN, BIC und den Referenzcode ausgeben, auf
    den der Zahlungseingang später gematcht wird.
    """
    types = ["card", "customer_balance"] if _transfer_enabled() else ["card"]
    settings: dict = {"payment_method_types": types}
    if _transfer_enabled():
        settings["payment_method_options"] = {
            "customer_balance": {
                "funding_type": "bank_transfer",
                "bank_transfer": {
                    "type": "eu_bank_transfer",
                    "eu_bank_transfer": {"country": _transfer_country()},
                },
            }
        }
    return settings


def _verwendungszweck(order: Order) -> str:
    """Was der Kunde bei der Überweisung angeben soll — Stripes eigener Code.

    Bei einer Überweisung ordnet **Stripe** den Eingang zu, nicht wir: das Geld
    landet auf dem Guthabenkonto des Kunden und wird von dort gegen die offene
    Rechnung verrechnet. Stripe gleicht dabei in dieser Reihenfolge ab
    (docs.stripe.com/payments/customer-balance/reconciliation):

      1. der Referenzcode aus den Überweisungsanweisungen der Rechnung
         (``payment_intent.next_action.display_bank_transfer_instructions.reference``),
      2. die Stripe-Rechnungsnummer,
      3. der überwiesene Betrag.

    Unsere Auftragsnummer steht auf keiner dieser Stufen. Sie trotzdem als
    Verwendungszweck auszuweisen hiess: auf demselben Beleg standen *zwei*
    Verwendungszwecke — unserer oben im Feld, Stripes im Zahlungsblock darunter.
    Wer unseren abschrieb, dessen Zahlung fiel auf die Betragsstufe zurück oder
    blieb ganz unzugeordnet im Kundenguthaben liegen.

    Also gilt der Stripe-Code, sobald er feststeht (``order.invoice_reference``,
    gesetzt beim Ausstellen). Vorher — solange die Rechnung ein Entwurf ist und
    es weder PaymentIntent noch Rechnungsnummer gibt — bleibt die
    Auftragsnummer als vorläufige Angabe stehen; sie wird beim Finalisieren
    überschrieben.

    Das Bestellzeichen des Kunden wird dem Zweck *nicht* mehr angehängt: der
    Abgleich vergleicht den Code, und „CODE / 4500123456" ist er nicht mehr.
    Das Bestellzeichen steht als eigenes Feld auf der Rechnung — siehe
    ``_custom_fields``.
    """
    ref = (order.invoice_reference or "").strip()
    return (ref or order.no or "")[:140]  # Stripe begrenzt den Wert eines Feldes


def _bank_transfer_reference(stripe, invoice) -> str:
    """Der Referenzcode, den Stripe für diese Rechnung ausgibt.

    Er entsteht erst beim Finalisieren, zusammen mit dem PaymentIntent, und
    hängt seit API-Fassung 2025-03-31 nicht mehr direkt an der Rechnung:
    ``invoice.payment_intent`` gibt es nicht mehr, der Weg führt über
    ``invoice.payments`` auf den PaymentIntent und von dort auf die
    Überweisungsanweisung.

    Fällt unterwegs etwas aus — Entwurf, keine Überweisung angeboten, kein
    PaymentIntent, eine Antwort anderen Zuschnitts —, bleibt die
    Stripe-Rechnungsnummer. Auch sie ordnet zu (Stufe 2 des Abgleichs) und
    steht sichtbar auf dem Beleg. Leer heisst: noch nichts, das der Kunde
    abschreiben könnte — dann bleibt es bei der vorläufigen Auftragsnummer.
    """
    if (getattr(invoice, "status", "") or "draft") == "draft":
        return ""
    number = str(getattr(invoice, "number", "") or "").strip()
    if not _transfer_enabled():
        return number  # ohne Überweisung gibt es keinen Code
    try:
        full = stripe.Invoice.retrieve(
            invoice.id, expand=["payments.data.payment.payment_intent"]
        )
    except Exception:  # noqa: BLE001
        return number
    for entry in getattr(getattr(full, "payments", None), "data", None) or []:
        # Unbezahlt ist der PaymentIntent noch eine Kennung statt eines
        # Objekts, wenn das expand nicht griff — dann findet getattr nichts
        # und die Schleife geht zur nächsten Zahlung weiter.
        pi = getattr(getattr(entry, "payment", None), "payment_intent", None)
        instructions = getattr(
            getattr(pi, "next_action", None), "display_bank_transfer_instructions", None
        )
        code = str(getattr(instructions, "reference", "") or "").strip()
        if code:
            return code[:140]
    return (number or str(getattr(full, "number", "") or "").strip())[:140]


def _custom_fields(order: Order) -> list[dict]:
    fields = [
        {"name": "Auftrag", "value": (order.no or "")[:140]},
    ]
    ref = (order.customer_ref or "").strip()
    if ref:
        fields.append({"name": "Ihre Bestell-Nr.", "value": ref[:140]})
    kd = (order.user.customer_no if order.user else "") or ""
    if kd.strip():
        fields.append({"name": "Kunden-Nr.", "value": kd.strip()[:140]})
    return fields[:4]


def _footer(order: Order) -> str:
    return einvoice.footer()


def _invoice_metadata(order: Order) -> dict:
    return {
        "order_no": order.no,
        "verwendungszweck": _verwendungszweck(order),
        "customer_ref": (order.customer_ref or "")[:200],
    }


def _invoice_idempotency_key(order_no: str, customer_id: str, due_days: int) -> str:
    """Idempotenzschlüssel je Auftrag *und* Parametersatz.

    Stripe lehnt denselben Schlüssel mit anderen Parametern ab („Keys for
    idempotent requests can only be used with the same parameters …"). Ein
    reiner Auftragsschlüssel stößt genau da an seine Grenze, wo der zweite
    Anlauf eine andere Frist oder einen anderen Stripe-Kunden trägt. Der Hash
    über die Erzeugungsparameter trennt die Fälle: gleicher Inhalt → gleicher
    Schlüssel (Wiederholung bleibt kostenlos), geänderter Inhalt → neuer
    Schlüssel (statt einer harten Ablehnung)."""
    raw = f"{customer_id}|{due_days}|eur|send_invoice|exclude"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"desk-invoice-{order_no}-{digest}"


def _find_draft_invoice(stripe, customer_id: str, order_no: str):
    """Vorhandenen Entwurf zu diesem Auftrag finden — statt streng zu scheitern.

    Ein abgebrochener erster Anlauf hinterlässt bisweilen einen Draft. Ohne
    diese Suche würde der nächste Versuch denselben Idempotenzschlüssel mit
    geänderten Parametern senden und von Stripe abgewiesen. Der Draft wird
    wiederverwendet und unten mit Positionen gefüllt; eine geänderte Frist
    gilt dann nicht rückwirkend — dafür muss der Draft verworfen werden."""
    try:
        drafts = stripe.Invoice.list(customer=customer_id, status="draft", limit=100)
    except Exception:
        return None
    for inv in drafts.data or []:
        if ((inv.metadata or {}).get("order_no") or "") == order_no:
            return inv
    return None


def _line_description(order: Order, line: dict) -> str:
    """Der Text einer Rechnungszeile.

    Bisher stand vor jeder Zeile die volle Auftragsnummer — auf einer Rechnung
    mit acht Positionen achtmal dieselbe Nummer, die einen Zentimeter darüber
    schon im Kopf steht, und der eigentliche Text rutschte dabei aus der
    Spalte. Jetzt steht dort die Positionsnummer *dieser* Zeile:
    ``AU-2026-0042 - 3``. Bei einer Rückfrage ist Position 3 damit ohne Zählen
    am Beleg zu finden, und die Auftragsnummer bleibt einmal je Zeile lesbar,
    ohne den Text zu verdrängen.

    Die Steuerzeile trägt keine Positionsnummer: sie ist keine Position,
    sondern die Steuer auf sie.
    """
    pos = int(line.get("pos") or 0)
    if not pos:
        return str(line["description"])
    return f"{order.no} - {pos} · {line['description']}"


def _stripe_message(exc: Exception) -> str:
    """Die Klartextmeldung von Stripe, ohne den Anfragebezeichner davor.

    Stripe stellt jeder Meldung „Request req_…: " voran. Für das Log ist das
    Gold wert, in einer Oberfläche ist es Rauschen vor dem eigentlichen Satz.
    """
    text = str(getattr(exc, "user_message", None) or exc).strip()
    marker = ": "
    if text.startswith("Request ") and marker in text:
        text = text.split(marker, 1)[1].strip()
    return text


def _stripe_error(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=f"Stripe hat die Anfrage abgelehnt: {exc}",
    )


def _archive_invoice(db: Session, order: Order, inv) -> Optional[InvoiceDocument]:
    """Das PDF ins Haus holen und ablegen.

    Ein Entwurf hat noch keines — dann gibt es nichts abzulegen und die Funktion
    meldet das durch ``None``. Fehler beim Holen werden geschluckt: die
    Ablage ist eine Bequemlichkeit, sie darf das Ausstellen einer Rechnung
    nicht scheitern lassen. Was fehlt, wird beim nächsten Abruf nachgeholt.
    """
    url = getattr(inv, "invoice_pdf", "") or ""
    if not url:
        return None
    doc = db.query(InvoiceDocument).filter(InvoiceDocument.invoice_no == inv.id).first()
    if doc and doc.pdf:
        return doc
    try:
        import urllib.request

        with urllib.request.urlopen(url, timeout=20) as resp:  # noqa: S310
            data = resp.read()
    except Exception:  # noqa: BLE001
        return doc
    if doc is None:
        doc = InvoiceDocument(order_no=order.no, invoice_no=inv.id)
        db.add(doc)
    doc.number = getattr(inv, "number", "") or ""
    doc.total_cents = int(getattr(inv, "total", 0) or 0)
    doc.recipient = getattr(inv, "customer_email", "") or ""
    doc.hosted_url = getattr(inv, "hosted_invoice_url", "") or ""
    doc.pdf = data
    doc.pdf_size = len(data)
    doc.fetched_at = datetime.now(timezone.utc)
    return doc


def _billing_input(order: Order, lines: list[dict], email: str, db: Session | None = None) -> dict:
    address = order.bill_address or order.ship_address or {}
    return {
        "seller": einvoice.seller(db),
        "buyer": {**address, "name": address.get("company") or _customer_name(order, "")
                  or address.get("contact") or "", "country": address.get("country") or "DE", "email": email},
        "ship_country": (order.ship_address or {}).get("country") or "DE",
        "order_no": order.no, "buyer_reference": order.customer_ref or "",
        "net": _cents(order.net), "vat": _cents(order.vat), "gross": _cents(order.gross),
        "rate": (order.tax_status or {}).get("rate", 0.19), "lines": lines,
    }


def _check_billing(order: Order, lines: list[dict], email: str, db: Session | None = None) -> dict:
    data = _billing_input(order, lines, email, db)
    errors = einvoice.validate(data)
    if errors:
        raise HTTPException(409, "Rechnung noch nicht bereit: " + "; ".join(errors))
    return data


def _archive_structured(db: Session, order: Order, invoice, data: dict) -> None:
    # Only called during issuance with the preflight snapshot, never rebuilt
    # from an edited order when downloading a historical invoice.
    if db.query(StructuredInvoiceDocument).filter_by(invoice_no=invoice.id).first():
        return
    number = getattr(invoice, "number", "") or ""
    data = {**data, "prepaid": int(getattr(invoice, "amount_paid", 0) or 0)}
    xml = einvoice.build(data, number, order.invoiced_at.date().isoformat(),
                         order.invoice_due_at.date().isoformat() if order.invoice_due_at else None)
    db.add(StructuredInvoiceDocument(invoice_no=invoice.id, order_no=order.no, number=number,
                                    xml=xml, sha256=hashlib.sha256(xml.encode("utf-8")).hexdigest()))


@router.get("/orders/{no}/billing-check", dependencies=[Depends(require_staff)])
def billing_check(no: str, db: Annotated[Session, Depends(get_db)]) -> dict:
    order = _require_order(no, db)
    local = local_invoices.enabled()
    delivered = local_invoices.delivery_date(db, order) if local else None
    try:
        # Ohne Stripe geht keine Mail hinaus: die Adresse ist dann keine Bedingung.
        email = next(iter(v for _, v in _email_candidates(order)), "") if local else _invoice_email(order)[0]
        lines, _ = _invoice_lines(order)
        data = _billing_input(order, lines, email, db)
        errors = einvoice.validate(data)
        if order.blocked:
            errors.append("Auftrag gesperrt")
        if order.cancelled_at is not None:
            errors.append("Auftrag ist storniert")
        if order.invoice_no:
            errors.append("Rechnung bereits gestellt")
    except HTTPException as exc:
        errors = [str(exc.detail)]
    result = {"ready": not errors, "errors": errors, "net": order.net, "vat": order.vat,
              "gross": order.gross, "tax_rate": (order.tax_status or {}).get("rate", 0.19),
              "format": "EN 16931 · UBL 2.1 (Kernformat)",
              "validation": "Pflichtangaben und Beträge; keine XRechnung-/Peppol-Profilvalidierung"}
    if local:
        result |= {"local": True, "delivery_date": delivered.isoformat() if delivered else None}
    return result


@router.get("/orders/{no}/invoice.xml", dependencies=[Depends(require_staff)])
def invoice_xml(no: str, db: Annotated[Session, Depends(get_db)]) -> Response:
    order = _require_order(no, db)
    row = local_invoices.current(db, order)
    if row:
        return _local_xml(row)
    doc = db.query(StructuredInvoiceDocument).filter_by(invoice_no=order.invoice_no, order_no=no).first()
    if not doc:
        raise HTTPException(404, "Keine archivierte E-Rechnung. Historische Belege werden nicht aus geänderten Auftragsdaten neu erzeugt.")
    return Response(doc.xml, media_type="application/xml", headers={
        "Content-Disposition": 'attachment; filename="E-Rechnung.xml"', "Cache-Control": "no-store",
    })


def _backfill_reference(
    stripe, order: Order, invoice, db: Session | None = None
) -> str:
    if order.invoice_reference:
        return order.invoice_reference
    code = _bank_transfer_reference(stripe, invoice)
    if code:
        order.invoice_reference = code
        try:
            stripe.Invoice.modify(invoice.id, metadata=_invoice_metadata(order))
        except Exception:
            pass
    return code


def _require_order(no: str, db: Session) -> Order:
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    if (order.kind or "external") == "internal":
        raise HTTPException(
            status_code=409,
            detail="Interner Auftrag — dafür gibt es keine Rechnung.",
        )
    return order


def _email_candidates(order: Order) -> list[tuple[str, str]]:
    """Alle bekannten Adressen zu diesem Auftrag, in der Reihenfolge ihres
    Vorrangs, jeweils mit der Stelle, aus der sie stammt."""
    raw = (
        ("Bestell-E-Mail", order.contact_email),
        ("Rechnungsanschrift", (order.bill_address or {}).get("email")),
        ("Lieferanschrift", (order.ship_address or {}).get("email")),
        ("Kundenkonto", order.user.email if order.user else ""),
    )
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for label, value in raw:
        v = str(value or "").strip()
        if v and "@" in v and v.lower() not in seen:
            seen.add(v.lower())
            out.append((label, v))
    return out


def _invoice_email(order: Order, override: str = "") -> tuple[str, str, list[dict]]:
    """Empfänger, Herkunft und die übrigen bekannten Adressen.

    Bei der Bestellung eingetippte Adresse und Adresse am Kundenkonto laufen
    im Alltag auseinander: bestellt der Einkauf, soll die Rechnung trotzdem in
    die Buchhaltung. Beides ist richtig, und welche gilt, kann die Software
    nicht wissen.

    Also weder stillschweigend die eine nehmen noch den Vorgang anhalten: die
    vorrangige wird benutzt, die abweichenden kommen als ``alternatives``
    zurück, und wer es besser weiss, gibt ``email`` ausdrücklich mit. Eine
    still an die falsche Stelle geschickte Rechnung ist teurer als ein Hinweis.
    """
    candidates = _email_candidates(order)
    if override:
        chosen = override.strip()
        if "@" not in chosen:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"„{chosen}“ ist keine E-Mail-Adresse.",
            )
        source = next(
            (lbl for lbl, v in candidates if v.lower() == chosen.lower()),
            "von Hand angegeben",
        )
    elif candidates:
        source, chosen = candidates[0]
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Der Auftrag trägt keine E-Mail-Adresse — ohne "
            "Empfänger kann keine Rechnung versendet werden.",
        )
    others = [
        {"source": lbl, "email": v}
        for lbl, v in candidates
        if v.lower() != chosen.lower()
    ]
    return chosen, source, others


def _customer_name(order: Order, email: str) -> str:
    for source in (
        (order.bill_address or {}).get("company"),
        (order.bill_address or {}).get("contact"),
        order.user.company if order.user else "",
        order.user.name if order.user else "",
    ):
        if source:
            return str(source)
    return email


def _invoice_lines(order: Order) -> tuple[list[dict], dict]:
    """Die Rechnungszeilen in Cent — Summe exakt der Auftragssumme.

    Struktur wie an der Kasse: jede Position über ihren eigenen Gesamtbetrag
    (die Stückzahl steht im Text), der Restcent auf die größte Zeile, die
    Umsatzsteuer als eigene Zeile und nicht als tax_percent — sonst rundet
    Stripe die Steuer selbst und der Cent wandert.

    Jede Zeile bekommt ihre Positionsnummer (``pos``), fortlaufend über
    Zuschnitt, Rüsten, Zeugnis und Versand — die Steuerzeile bleibt bei 0.
    Daraus baut ``_line_description`` den Zeilentext.
    """
    br = order.price_breakdown or {}
    lines: list[dict] = []

    for p in order.positions:
        if p.kind == "custom":
            ext = (getattr(p, "external_note", "") or "").strip()
            base = f"{p.qty} × {p.label or p.mat}"
            if ext:
                base = f"{base} — {ext}"
            desc = base
        else:
            desc = f"{p.qty} × {p.label or p.mat} ({p.mat}, {p.thk:g} mm)"
        amount = (p.mat_cost + p.cut_cost) if p.kind != "sheet" else p.mat_cost
        lines.append(
            {
                "description": desc,
                "amount_cents": _cents(amount),
                "is_vat": False,
            }
        )

    for key, label in (
        ("setup", "Rüsten"),
        ("cert", "Abnahmeprüfzeugnis 3.1"),
        ("freight", "Versand"),
    ):
        if key in br and br[key] and br[key] > 0.004:
            lines.append(
                {"description": label, "amount_cents": _cents(br[key]), "is_vat": False}
            )

    # VAT belongs in Stripe's tax summary, never in a product line.
    target = _cents(order.net)
    diff = target - sum(l["amount_cents"] for l in lines)
    if abs(diff) > 10:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Rechnungsaufbau weicht vom Auftrag ab — "
            "bitte den Auftrag prüfen, bevor eine "
            "Rechnung erstellt wird.",
        )
    if diff and lines:
        biggest = max(lines, key=lambda l: l["amount_cents"])
        biggest["amount_cents"] += diff

    pos = 0
    for line in lines:
        if line["is_vat"]:
            line["pos"] = 0
            continue
        pos += 1
        line["pos"] = pos
    return lines, {"target_cents": _cents(order.gross), "net_cents": target, "diff_cents": diff}


def _tax_rate(stripe, order: Order) -> str:
    rate = Decimal(str((order.tax_status or {}).get("rate", "0.19")))
    if rate != Decimal("0.19"):
        raise HTTPException(409, "Steuerfreie oder abweichend besteuerte Lieferungen benötigen eine Prüfung durch die Buchhaltung.")
    configured = os.environ.get("STRIPE_TAX_RATE_ID", "")
    result = stripe.TaxRate.retrieve(configured) if configured else stripe.TaxRate.create(
        display_name="Umsatzsteuer", percentage=19, inclusive=False, country="DE", jurisdiction="Deutschland",
        description=identity.texts().tax_rate_description, idempotency_key=identity.texts().tax_rate_key,
    )
    if not result.active or result.inclusive or Decimal(str(result.percentage)) != 19 or result.country != "DE":
        raise HTTPException(409, "Der Stripe-Umsatzsteuersatz passt nicht zur Bestellung.")
    return result.id


def _check_invoice_total(invoice, order: Order) -> None:
    if int(invoice.total) != _cents(order.gross) or getattr(invoice, "currency", "") != "eur":
        raise HTTPException(409, "Stripe-Rechnung und Auftragssumme stimmen nicht überein. Entwurf prüfen; in Stripe Steuer auf Rechnungsebene runden. Es wurde keine Rechnung ausgestellt.")


# --------------------------------------------------------------------------
# Rechnung erstellen und senden
# --------------------------------------------------------------------------
class InvoiceIn(BaseModel):
    send: bool = Field(
        default=True,
        description="True = Stripe mailt die Rechnung; "
        "False = Entwurf im Stripe-Dashboard",
    )
    due_days: int = Field(default=14, ge=0, le=365)
    email: str = Field(
        default="",
        max_length=250,
        description="Empfänger ausdrücklich festlegen. Leer = die "
        "vorrangige Adresse des Auftrags.",
    )
    delivery_date: Optional[date] = Field(
        default=None,
        description="Nur lokale Rechnung: Tag der Lieferung. Leer = letzter Versandtag.",
    )


class InvoiceOut(BaseModel):
    order_no: str
    invoice_id: str
    status: str
    sent: bool
    hosted_url: str = ""
    pdf_url: str = ""
    send_error: str = ""
    due_at: Optional[datetime] = None
    total_cents: int
    customer_email: str
    #: Was der Kunde bei der Überweisung angeben soll.
    verwendungszweck: str = ""
    #: Welche Zahlwege die Rechnung anbietet.
    payment_methods: list[str] = Field(default_factory=list)
    #: Woher der Empfänger stammt — Bestell-E-Mail, Kundenkonto, von Hand.
    email_source: str = ""
    #: Weitere bekannte Adressen, die *nicht* benutzt wurden. Ist die Liste
    #: nicht leer, weichen die Angaben am Auftrag voneinander ab.
    email_alternatives: list[dict] = Field(default_factory=list)


class LocalInvoiceOut(InvoiceOut):
    """Antwort einer lokalen Rechnung: Stripes Felder plus die Wege zum Beleg."""

    local: bool = True
    number: str
    issue_date: date
    delivery_date: date
    html_url: str
    xml_url: str


@router.get("/config")
def config() -> dict:
    """Ist das Rechnungswesen eingerichtet? — die UI fragt das vor dem Knopf.

    ``test_mode`` ist die Angabe, an der die häufigste Rückfrage hängt: im
    Testmodus nimmt Stripe ``send_invoice`` an, meldet Erfolg und stellt
    trotzdem keine E-Mail an ein echtes Postfach zu. Ohne diesen Hinweis sucht
    das Büro den Fehler bei sich — und findet ihn nie, weil keiner da ist.
    """
    key = stripe_client.secret_key()
    local = local_invoices.enabled()
    result = {
        "configured": bool(key),
        "seller": einvoice.seller()["name"],
        "manufacturer": identity.texts().manufacturer,
        "document_format": "PDF",
        "structured_einvoice": True,
        "structured_format": "EN 16931 UBL 2.1 core",
        "tax_rounding": "invoice",
        "webhook_configured": bool(stripe_client.webhook_secret()),
        "test_mode": key.startswith("sk_test"),
        "payment_methods": _payment_settings()["payment_method_types"],
        "transfer_country": _transfer_country() if _transfer_enabled() else "",
        "default_due_days": get_settings().invoice_due_days,
    }
    if local_invoices.allowed():
        result["local_invoicing"] = local
        if local:
            result |= {"document_format": "HTML", "payment_methods": []}
    return result


def _seller_out(db: Session) -> dict:
    values = einvoice.seller(db)
    rows = identity.stored(db)
    fields = {k: values.get(k, rows.get(k, "")) for k in identity.EDITABLE}
    data = {"seller": values, "buyer": {"name": "-", "street": "-", "zip": "-", "city": "-", "country": "DE"},
            "net": 0, "vat": 0, "gross": 0, "rate": 0.19, "lines": []}
    problem = [e for e in einvoice.validate(data) if e.startswith("Verkäuferdaten")]
    return {"values": fields, "editable": identity.editable(), "env_locked": identity.env_locked(),
            "complete": not problem, "problem": problem[0] if problem else ""}


class SellerIn(BaseModel):
    name: str = Field(default="", max_length=200)
    street: str = Field(default="", max_length=200)
    zip: str = Field(default="", max_length=20)
    city: str = Field(default="", max_length=120)
    country: str = Field(default="DE", pattern=r"^[A-Za-z]{2}$")
    vatId: str = Field(default="", max_length=40)
    taxNumber: str = Field(default="", max_length=40)
    email: str = Field(default="", max_length=254)
    partners: str = Field(default="", max_length=300)
    website: str = Field(default="", max_length=200)
    manufacturer: str = Field(default="", max_length=200)
    brandMark: str = Field(default="", max_length=8)
    register: str = Field(default="", max_length=200)
    managers: str = Field(default="", max_length=300)
    iban: str = Field(default="", max_length=42)
    bic: str = Field(default="", max_length=11)
    bank: str = Field(default="", max_length=120)
    smallBusiness: str = Field(default="", max_length=1)


@router.get("/seller")
def get_seller(db: Annotated[Session, Depends(get_db)],
               actor: Annotated[User, Depends(require_admin)]) -> dict:
    """Verkäufer und Markenangaben. ``env_locked``: von der Umgebung festgelegt."""
    return _seller_out(db)


@router.put("/seller")
def put_seller(body: SellerIn, db: Annotated[Session, Depends(get_db)],
               actor: Annotated[User, Depends(require_admin)]) -> dict:
    """Verkäufer pflegen, nur ohne Anwendung: sonst bringt das Plugin die Angaben."""
    if not identity.editable():
        raise HTTPException(409, "Die Verkäuferdaten kommen aus der Anwendung und lassen sich hier nicht ändern.")
    values = {k: v.strip() for k, v in body.model_dump().items()}
    values["country"] = values["country"].upper()
    # Was die Umgebung festlegt, käme sonst als Echo aus dem Formular in die Tabelle.
    for key in identity.env_locked():
        values.pop(key, None)
    changed = identity.save(db, values, actor.email)
    if changed:
        db.add(AuditLog(actor=actor.email, action="seller_update", entity="setting",
                        entity_id="seller", detail={"fields": changed}))
        db.commit()
    return _seller_out(db)


def _local_xml(row: LocalInvoice) -> Response:
    name = "E-Gutschrift" if row.kind == "storno" else "E-Rechnung"
    return Response(row.xml, media_type="application/xml", headers={
        "Content-Disposition": f'attachment; filename="{name}-{row.number}.xml"', "Cache-Control": "no-store",
    })


def _local_page(row: LocalInvoice) -> Response:
    return Response(invoice_html(row), media_type="text/html; charset=utf-8",
                    headers={"Cache-Control": "no-store"})


def _local_row(number: str, db: Session) -> LocalInvoice:
    row = db.query(LocalInvoice).filter(LocalInvoice.number == number).first() if local_invoices.allowed() else None
    if not row:
        raise HTTPException(404, "Beleg nicht gefunden.")
    return row


def _issue_local(order: Order, body: InvoiceIn, db: Session, actor: User) -> LocalInvoiceOut:
    email, source, others = _invoice_email(order, body.email) if (body.email or _email_candidates(order)) else ("", "", [])
    lines, _ = _invoice_lines(order)
    data = _check_billing(order, lines, email, db)
    delivered = body.delivery_date or local_invoices.delivery_date(db, order)
    if not delivered:
        raise HTTPException(409, "Rechnung noch nicht bereit: Lieferdatum fehlt (§ 14 UStG). "
                                 "Erst versenden oder das Lieferdatum angeben.")
    try:
        row = local_invoices.issue(db, order.no, data, delivery=delivered, due_days=body.due_days,
                                   actor=actor.email)
    except local_invoices.Refused as exc:
        raise HTTPException(409, exc.message) from exc
    except ValueError as exc:
        raise HTTPException(409, f"Rechnung noch nicht bereit: {exc}") from exc
    db.refresh(order)
    return LocalInvoiceOut(
        order_no=order.no, invoice_id=row.number, status="paid" if order.paid else "open", sent=False,
        due_at=order.invoice_due_at, total_cents=row.gross_cents, customer_email=email,
        verwendungszweck=row.number, email_source=source, email_alternatives=others,
        number=row.number, issue_date=row.issue_date, delivery_date=delivered,
        html_url=f"/api/invoicing/local/{row.number}/invoice.html",
        xml_url=f"/api/invoicing/local/{row.number}/invoice.xml",
    )


def _cancel_local(order: Order, row: LocalInvoice, reason: str, db: Session, actor: User) -> dict:
    try:
        storno = local_invoices.cancel(db, order.no, row.number, reason, actor=actor.email)
    except local_invoices.Refused as exc:
        raise HTTPException(409, exc.message) from exc
    return {"order_no": order.no, "voided": row.number, "storno": storno.number,
            "gross_cents": storno.gross_cents,
            "html_url": f"/api/invoicing/local/{storno.number}/invoice.html",
            "xml_url": f"/api/invoicing/local/{storno.number}/invoice.xml"}


class CancelIn(BaseModel):
    reason: str = Field(min_length=5, max_length=300)


@router.post("/orders/{no}/invoice/cancel")
def cancel_local_invoice(no: str, body: CancelIn, db: Annotated[Session, Depends(get_db)],
                         actor: Annotated[User, Depends(require_staff)]) -> dict:
    """Storno einer lokalen Rechnung: eigene Nummer, Bezug aufs Original, nichts gelöscht."""
    order = _require_order(no, db)
    row = local_invoices.current(db, order)
    if not row:
        raise HTTPException(404, "Zu diesem Auftrag gibt es keine lokale Rechnung.")
    return _cancel_local(order, row, body.reason.strip(), db, actor)


@router.get("/export/invoices.csv", response_class=Response)
def export_invoices(db: Annotated[Session, Depends(get_db)],
                    actor: Annotated[User, Depends(require_staff)]) -> Response:
    """Alle Belege, auch Storni, für die Buchhaltung; mit Protokollzeile."""
    return csv_io.invoices_response(db, actor.email)


@router.get("/local", dependencies=[Depends(require_staff)])
def list_local(db: Annotated[Session, Depends(get_db)]) -> list[dict]:
    return local_invoices.listing(db) if local_invoices.allowed() else []


@router.get("/local/{number}/invoice.html", response_class=Response, dependencies=[Depends(require_staff)])
def local_html(number: str, db: Annotated[Session, Depends(get_db)]) -> Response:
    return _local_page(_local_row(number, db))


@router.get("/local/{number}/invoice.xml", response_class=Response, dependencies=[Depends(require_staff)])
def local_xml(number: str, db: Annotated[Session, Depends(get_db)]) -> Response:
    return _local_xml(_local_row(number, db))


@router.get("/orders/{no}/invoice.html", response_class=Response, dependencies=[Depends(require_staff)])
def order_invoice_html(no: str, db: Annotated[Session, Depends(get_db)]) -> Response:
    row = local_invoices.current(db, _require_order(no, db))
    if not row:
        raise HTTPException(404, "Zu diesem Auftrag gibt es keine lokale Rechnung.")
    return _local_page(row)


@router.post(
    "/orders/{no}/invoice",
    response_model=LocalInvoiceOut | InvoiceOut,
    status_code=status.HTTP_201_CREATED,
)
def create_invoice(
    no: str,
    body: InvoiceIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> InvoiceOut:
    """Aus dem Auftrag eine Stripe-Rechnung machen — und sie versenden."""
    order = _require_order(no, db)
    if order.cancelled_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Der Auftrag ist storniert — für ihn wird keine Rechnung gestellt.",
        )
    local = local_invoices.enabled()
    # Lokal darf die Rechnung nach dem Geld kommen; sie weist es dann als bezahlt aus.
    if order.paid and not local:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Dieser Auftrag ist bereits bezahlt.",
        )
    if order.invoice_no:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Es gibt bereits eine Rechnung ({order.invoice_no}). "
            + ("Korrektur nur per Storno." if local else "Zustellen oder stornieren Sie sie in Stripe."),
        )
    if order.blocked:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Auftrag gesperrt: {order.release_note or 'Übergröße'}. "
            "Erst freigeben, dann Rechnung stellen.",
        )
    if local:
        return _issue_local(order, body, db, actor)

    email, email_source, email_alternatives = _invoice_email(order, body.email)
    lines, meta = _invoice_lines(order)
    billing_data = _check_billing(order, lines, email)

    try:
        stripe = _try_client()
        # Kunde: finden nach E-Mail, sonst anlegen — dieselbe Person bekommt
        # immer dieselbe Stripe-Kundenkennung.
        existing = stripe.Customer.list(email=email, limit=1)
        if existing.data:
            customer_id = existing.data[0].id
        else:
            customer_id = stripe.Customer.create(
                email=email,
                name=_customer_name(order, email) or None,
                description=identity.texts().office_label,
            ).id

        due_days = (
            body.due_days
            if body.due_days is not None
            else get_settings().invoice_due_days
        )

        # Reihenfolge: erst die Rechnung, dann die Positionen *auf* sie.
        #
        # Andersherum — Positionen als schwebende Posten am Kunden anlegen und
        # darauf hoffen, dass die nächste Rechnung sie einsammelt — hat lange
        # funktioniert und tut es nicht mehr: neuere Fassungen der Stripe-API
        # ziehen schwebende Posten nicht mehr von selbst hinein. Das Ergebnis
        # ist eine Rechnung über 0,00 €, die sich obendrein selbst als bezahlt
        # markiert. Das Bestellportal (server/stripe-routes.mjs) hängt die
        # Positionen seit jeher ausdrücklich an die Rechnung; hier nun ebenso.
        vat_rate = _tax_rate(stripe, order)
        draft = _find_draft_invoice(stripe, customer_id, order.no)
        invoice = draft or stripe.Invoice.create(
            customer=customer_id,
            auto_advance=False,
            default_tax_rates=[vat_rate],
            collection_method="send_invoice",
            days_until_due=max(0, due_days),
            currency="eur",
            # Karte oder Überweisung — dieselben Wege wie an der Kasse des
            # Bestellportals. Ohne diese Angabe böte die Rechnung nur Karte.
            payment_settings=_payment_settings(),
            # Nur, was ausdrücklich auf diese Rechnung gebucht wird. Ohne das
            # zieht eine gleichzeitig entstehende Rechnung fremde Posten mit.
            pending_invoice_items_behavior="exclude",
            description=identity.texts().invoice_description,
            # Steht oben auf der Rechnung und im PDF. Vorläufig: der wirkliche
            # Verwendungszweck ist Stripes Referenzcode, und den gibt es erst
            # nach dem Finalisieren. Beide Felder lassen sich auch danach noch
            # ändern (anders als Beträge und ``collection_method``) — das holt
            # der Block nach dem Versand nach.
            custom_fields=_custom_fields(order),
            footer=_footer(order),
            metadata=_invoice_metadata(order),
            # Ein Wiederholungsversuch desselben Auftrags mit denselben
            # Parametern ist kostenlos — ein zweiter Auftrags-Auftrag darf
            # nicht entstehen. Geänderte Parameter bekommen ihren eigenen
            # Schlüssel, statt von Stripe abgewiesen zu werden.
            idempotency_key=_invoice_idempotency_key(
                order.no, customer_id, max(0, due_days)
            ),
        )
        # Der Idempotenzschlüssel spielt die *erste* Antwort zurück, nicht den
        # heutigen Zustand. Für jede Entscheidung darüber zählt der frische.
        invoice = stripe.Invoice.retrieve(invoice.id)

        if (invoice.status or "draft") == "draft":
            for i, l in enumerate(lines):
                stripe.InvoiceItem.create(
                    customer=customer_id,
                    invoice=invoice.id,
                    currency="eur",
                    amount=l["amount_cents"],
                    description=_line_description(order, l)[:250],
                    # Der Schlüssel trägt die Rechnung mit: sonst gibt ein
                    # zweiter Anlauf den Posten der *alten* Rechnung zurück.
                    idempotency_key=f"desk-{order.no}-{invoice.id}-line-{i}",
                )
            invoice = stripe.Invoice.retrieve(invoice.id)
        # Finalisieren und versenden sind zwei Schritte, und nur der erste ist
        # unverzichtbar: eine finalisierte Rechnung hat Nummer, Zahlseite und
        # PDF und ist damit forderbar. Der E-Mail-Versand hängt am Zustand des
        # Stripe-Kontos und wird im Testmodus regelmäßig abgelehnt.
        #
        # Das Bestellportal (server/stripe-routes.mjs) handhabt das seit jeher
        # so — Versandfehler abfangen, finalisierte Rechnung behalten. Hier
        # dieselbe Regel, damit nicht zwei Wege verschieden ausgehen. Der
        # Unterschied: der Fehler wird nicht nur ins Log geschrieben, sondern
        # zurückgegeben, damit das Auftragsbüro den Zahllink selbst schicken
        # kann statt auf eine Mail zu warten, die nie kommt.
        send_error = ""
        _check_invoice_total(invoice, order)
        # Store the association before Stripe makes the invoice payable.
        order.invoice_no = invoice.id
        db.commit()
        if (invoice.status or "draft") == "draft":
            invoice = stripe.Invoice.finalize_invoice(invoice.id)
        if body.send:
            try:
                invoice = stripe.Invoice.send_invoice(invoice.id)
            except Exception as exc:  # noqa: BLE001
                send_error = _stripe_message(exc)
                invoice = stripe.Invoice.retrieve(invoice.id)

        # Jetzt erst steht Stripes Referenzcode fest — und erst jetzt lässt
        # sich der Verwendungszweck auf dem Beleg richtigstellen. Ohne diesen
        # Schritt trägt dieselbe Rechnung zwei verschiedene Zwecke: unseren im
        # Feld und Stripes im Zahlungsblock.
        zweck_error = ""
        code = _bank_transfer_reference(stripe, invoice)
        if code and code != order.invoice_reference:
            order.invoice_reference = code
            try:
                stripe.Invoice.modify(invoice.id, metadata=_invoice_metadata(order))
            except Exception:
                pass
        zweck = _verwendungszweck(order)

        # Der Auftragsnummer wird die Rechnung zugeordnet — der Zustand
        # "auf Rechnung wartend" ist am Auftrag sichtbar, nicht nur in Stripe.
        order.invoice_no = invoice.id
        order.invoiced_at = datetime.now(timezone.utc)
        order.invoice_due_at = datetime.now(timezone.utc) + timedelta(
            days=max(0, due_days)
        )
        order.payment_method = order.payment_method or "invoice"
        _archive_structured(db, order, invoice, billing_data)
        _archive_invoice(db, order, invoice)
        db.add(
            AuditLog(
                actor=actor.email,
                action="invoice_create",
                entity="order",
                entity_id=order.no,
                detail={
                    "invoice_id": invoice.id,
                    "sent": bool(body.send and not send_error),
                    "send_error": send_error,
                    "email": email,
                    "email_source": email_source,
                    "email_alternatives": [a["email"] for a in email_alternatives],
                    "total_cents": invoice.total,
                    "target_cents": meta["target_cents"],
                    "verwendungszweck": zweck,
                    "verwendungszweck_error": zweck_error,
                },
            )
        )
        db.commit()

        return InvoiceOut(
            order_no=order.no,
            invoice_id=invoice.id,
            status=invoice.status or "draft",
            sent=bool(body.send and not send_error),
            hosted_url=getattr(invoice, "hosted_invoice_url", "")
            or invoice.hosted_url
            or "",
            pdf_url=getattr(invoice, "invoice_pdf", "") or "",
            send_error=send_error,
            due_at=order.invoice_due_at,
            total_cents=invoice.total,
            customer_email=email,
            verwendungszweck=zweck,
            payment_methods=_payment_settings()["payment_method_types"],
            email_source=email_source,
            email_alternatives=email_alternatives,
        )
    except StripeUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        raise _stripe_error(exc) from exc


def ensure_invoice_for_order(
    db: Session,
    order: Order,
    *,
    send: bool = False,
    email_override: str = "",
    due_days: int | None = None,
    actor_email: str = "system",
) -> Optional[InvoiceOut]:
    """Rechnung für einen Auftrag sicherstellen — auch ohne Versand.

    Wird vom Auftragsbüro nach ``place_order`` gerufen, damit ein Auftrag auf
    ``payment_mode == invoice`` sofort eine Stripe-Rechnung (finalisiert, offen)
    besitzt, ohne auf den expliziten „Rechnung senden"-Klick zu warten.
    ``send=False`` finalisiert trotzdem — nur ``send_invoice`` entfällt.
    """
    if (order.kind or "external") == "internal":
        return None
    if order.invoice_no or order.paid or order.blocked or order.cancelled_at is not None:
        return None
    try:
        email, email_source, email_alternatives = _invoice_email(order, email_override)
    except HTTPException:
        return None
    try:
        lines, meta = _invoice_lines(order)
        billing_data = _check_billing(order, lines, email)
    except HTTPException:
        return None
    try:
        stripe = stripe_client.client()
    except StripeUnavailable:
        return None
    existing = stripe.Customer.list(email=email, limit=1)
    if existing.data:
        customer_id = existing.data[0].id
    else:
        try:
            customer_id = stripe.Customer.create(
                email=email,
                name=_customer_name(order, email) or None,
                description=identity.texts().office_label,
            ).id
        except Exception:
            return None
    dd = due_days if due_days is not None else get_settings().invoice_due_days
    try:
        vat_rate = _tax_rate(stripe, order)
        draft = _find_draft_invoice(stripe, customer_id, order.no)
        invoice = draft or stripe.Invoice.create(
            customer=customer_id,
            auto_advance=False,
            default_tax_rates=[vat_rate],
            collection_method="send_invoice",
            days_until_due=max(0, dd),
            currency="eur",
            payment_settings=_payment_settings(),
            pending_invoice_items_behavior="exclude",
            description=identity.texts().invoice_description,
            custom_fields=_custom_fields(order),
            footer=_footer(order),
            metadata=_invoice_metadata(order),
            # Gleiche Parameter → gleicher Schlüssel (Wiederholung kostenlos),
            # andere Parameter → eigener Schlüssel, statt Stripe-Ablehnung.
            idempotency_key=_invoice_idempotency_key(
                order.no, customer_id, max(0, dd)
            ),
        )
        invoice = stripe.Invoice.retrieve(invoice.id)
        if (invoice.status or "draft") == "draft":
            for i, l in enumerate(lines):
                stripe.InvoiceItem.create(
                    customer=customer_id,
                    invoice=invoice.id,
                    currency="eur",
                    amount=l["amount_cents"],
                    description=_line_description(order, l)[:250],
                    idempotency_key=f"desk-{order.no}-{invoice.id}-line-{i}",
                )
            invoice = stripe.Invoice.retrieve(invoice.id)
        _check_invoice_total(invoice, order)
        # Store the association before Stripe makes the invoice payable.
        order.invoice_no = invoice.id
        db.commit()
        if (invoice.status or "draft") == "draft":
            invoice = stripe.Invoice.finalize_invoice(invoice.id)
        send_error = ""
        if send:
            try:
                invoice = stripe.Invoice.send_invoice(invoice.id)
            except Exception as exc:  # noqa: BLE001
                send_error = _stripe_message(exc)
                invoice = stripe.Invoice.retrieve(invoice.id)
        code = _bank_transfer_reference(stripe, invoice)
        if code and code != order.invoice_reference:
            order.invoice_reference = code
            try:
                stripe.Invoice.modify(invoice.id, metadata=_invoice_metadata(order))
            except Exception:
                pass
        zweck = _verwendungszweck(order)
        order.invoice_no = invoice.id
        order.invoiced_at = datetime.now(timezone.utc)
        order.invoice_due_at = datetime.now(timezone.utc) + timedelta(days=max(0, dd))
        order.payment_method = order.payment_method or "invoice"
        _archive_structured(db, order, invoice, billing_data)
        _archive_invoice(db, order, invoice)
        db.add(
            AuditLog(
                actor=actor_email,
                action="invoice_create",
                entity="order",
                entity_id=order.no,
                detail={
                    "invoice_id": invoice.id,
                    "sent": bool(send and not send_error),
                    "send_error": send_error,
                    "email": email,
                    "email_source": email_source,
                    "email_alternatives": [a["email"] for a in email_alternatives],
                    "total_cents": invoice.total,
                    "target_cents": meta["target_cents"],
                    "verwendungszweck": zweck,
                    "auto": True,
                },
            )
        )
        db.commit()
        return InvoiceOut(
            order_no=order.no,
            invoice_id=invoice.id,
            status=invoice.status or "draft",
            sent=bool(send and not send_error),
            hosted_url=getattr(invoice, "hosted_invoice_url", "")
            or invoice.hosted_url
            or "",
            pdf_url=getattr(invoice, "invoice_pdf", "") or "",
            send_error=send_error,
            due_at=order.invoice_due_at,
            total_cents=invoice.total,
            customer_email=email,
            verwendungszweck=zweck,
            payment_methods=_payment_settings()["payment_method_types"],
            email_source=email_source,
            email_alternatives=email_alternatives,
        )
    except Exception:  # noqa: BLE001
        db.rollback()
        return None


def _try_client():
    try:
        return stripe_client.client()
    except StripeUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc


# --------------------------------------------------------------------------
# Zahlung buchen — aus dem Webhook, nie aus dem Browser
# --------------------------------------------------------------------------
def _book_payment(db: Session, order: Order, amount_cents: int, ref: str, currency: str = "eur") -> dict:
    """Ein Zahlungseingang am Auftrag — idempotent, mit Gegenrechnung.

    Liefert {"booked": bool, "already_paid": bool, "price_check": dict}.
    """
    if order.paid:
        return {
            "booked": False,
            "already_paid": True,
            "price_check": order.price_check or {},
        }

    engine_gross = _cents(order.gross)
    if amount_cents != engine_gross or currency.lower() != "eur":
        raise HTTPException(409, "Zahlungsbetrag oder Währung weicht vom Auftrag ab. Keine Fertigungsfreigabe; Buchhaltung muss prüfen.")
    delta = engine_gross - amount_cents
    price_check = {
        "checked": True,
        "agrees": delta == 0,
        "engine_gross_cents": engine_gross,
        "charged_gross_cents": amount_cents,
        "delta_gross_cents": delta,
        "source": "stripe_invoice",
    }
    order.paid = True
    order.paid_at = datetime.now(timezone.utc)
    order.payment_ref = ref[:120]
    order.payment_method = "invoice"
    order.price_check = price_check
    # Bezahlt heißt freigegeben — außer der Auftrag war aus anderem Grund
    # gesperrt (Übergröße wartet weiter auf einen Menschen).
    if not order.blocked and order.cancelled_at is None:
        order.released = True
        order.release_note = "Freigegeben: Rechnung bezahlt"
    db.add(
        AuditLog(
            actor="stripe",
            action="invoice_paid",
            entity="order",
            entity_id=order.no,
            detail={
                "amount_cents": amount_cents,
                "ref": ref,
                "agrees": price_check["agrees"],
            },
        )
    )
    return {"booked": True, "already_paid": False, "price_check": price_check}


def _sync_invoice_status(db: Session, order: Order) -> dict:
    """Der Zustand der Rechnung aus Stripe holen — der Abgleich für lokale
    Entwicklung ohne Webhook-Zusteller und die Schaltfläche in der Buchhaltung."""
    stripe = _try_client()
    try:
        inv = stripe.Invoice.retrieve(order.invoice_no)
    except Exception as exc:  # noqa: BLE001
        raise _stripe_error(exc) from exc
    _backfill_reference(stripe, order, inv, db)

    # ``invoice.paid`` gibt es in neueren Fassungen der Stripe-API nicht mehr;
    # der Zustand steht jetzt allein in ``status``. Ein blosser Zugriff darauf
    # warf einen AttributeError und liess den ganzen Abgleich mit 500 enden —
    # deshalb hier defensiv lesen und auf den Zustand zurückfallen.
    state = inv.status or ""
    paid = bool(getattr(inv, "paid", None) if hasattr(inv, "paid") else state == "paid")
    amount_paid = int(getattr(inv, "amount_paid", 0) or 0)

    result = {
        "invoice_id": inv.id,
        "status": state,
        "paid": paid,
        "amount_paid_cents": amount_paid,
        "verwendungszweck": _verwendungszweck(order),
    }
    if paid and state == "paid":
        booking = _book_payment(db, order, amount_paid, inv.id, getattr(inv, "currency", ""))
        result.update(booking)
    db.commit()
    return result


@router.post("/orders/{no}/invoice/sync")
def sync_invoice(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    order = _require_order(no, db)
    if not order.invoice_no:
        raise HTTPException(
            status_code=404, detail="Zu diesem Auftrag gibt es keine Rechnung."
        )
    if local_invoices.current(db, order):
        return {"invoice_id": order.invoice_no, "status": "paid" if order.paid else "open",
                "paid": bool(order.paid), "local": True}
    return _sync_invoice_status(db, order)


class InvoiceRow(BaseModel):
    """Eine Zeile der Rechnungsliste — was das Büro sehen muss, ohne zu klicken."""

    order_no: str
    invoice_no: str
    customer: str
    email: str
    net: float
    gross: float
    vat: float = 0
    tax_rate: float = 0.19
    has_einvoice: bool = False
    invoiced_at: Optional[datetime] = None
    due_at: Optional[datetime] = None
    paid: bool
    paid_at: Optional[datetime] = None
    days_overdue: int = 0
    status: str = ""
    #: Was der Kunde bei der Überweisung angeben soll.
    verwendungszweck: str = ""
    #: Liegt das PDF im Haus? Dann geht der Abruf ohne Stripe.
    has_copy: bool = False
    copy_number: str = ""


@router.get("/summary", dependencies=[Depends(require_staff)])
def invoices_summary(db: Annotated[Session, Depends(get_db)]) -> dict:
    """SQL-aggregierte Buchhaltungs-Kennzahlen über ALLE Rechnungen (auch Millionen)."""
    from sqlalchemy import and_, case, func

    now = datetime.now(timezone.utc)
    d30 = now - timedelta(days=30)
    d14 = now - timedelta(days=14)
    d60 = now - timedelta(days=60)

    is_open = Order.paid.is_(False)
    is_overdue = and_(is_open, Order.invoice_due_at.isnot(None), Order.invoice_due_at < now)
    is_paid_30 = and_(Order.paid.is_(True), Order.paid_at.isnot(None), Order.paid_at >= d30)

    row = (
        db.query(
            func.count(Order.id),
            func.coalesce(func.sum(case((is_open, 1), else_=0)), 0),
            func.coalesce(func.sum(case((is_overdue, 1), else_=0)), 0),
            func.coalesce(func.sum(case((Order.paid.is_(True), 1), else_=0)), 0),
            func.coalesce(func.sum(case((is_open, Order.gross), else_=0.0)), 0.0),
            func.coalesce(func.sum(case((is_overdue, Order.gross), else_=0.0)), 0.0),
            func.coalesce(func.sum(case((is_paid_30, Order.gross), else_=0.0)), 0.0),
            func.coalesce(
                func.sum(case((and_(is_overdue, Order.invoice_due_at >= d14), Order.gross), else_=0.0)), 0.0
            ),
            func.coalesce(
                func.sum(
                    case(
                        (and_(is_overdue, Order.invoice_due_at < d14, Order.invoice_due_at >= d30), Order.gross),
                        else_=0.0,
                    )
                ),
                0.0,
            ),
            func.coalesce(
                func.sum(
                    case(
                        (and_(is_overdue, Order.invoice_due_at < d30, Order.invoice_due_at >= d60), Order.gross),
                        else_=0.0,
                    )
                ),
                0.0,
            ),
            func.coalesce(
                func.sum(case((and_(is_overdue, Order.invoice_due_at < d60), Order.gross), else_=0.0)), 0.0
            ),
        )
        .filter(Order.invoice_no != "")
        .filter(Order.cancelled_at.is_(None))
        .one()
    )
    return {
        "total": int(row[0] or 0),
        "open_count": int(row[1] or 0),
        "overdue_count": int(row[2] or 0),
        "paid_count": int(row[3] or 0),
        "open_sum": round(float(row[4] or 0.0), 2),
        "overdue_sum": round(float(row[5] or 0.0), 2),
        "paid_30d_sum": round(float(row[6] or 0.0), 2),
        "aging": {
            "0_14": round(float(row[7] or 0.0), 2),
            "15_30": round(float(row[8] or 0.0), 2),
            "31_60": round(float(row[9] or 0.0), 2),
            "60_plus": round(float(row[10] or 0.0), 2),
        },
    }


@router.get(
    "/invoices", response_model=list[InvoiceRow], dependencies=[Depends(require_staff)]
)
def list_invoices(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    only_open: bool = False,
    q: str = Query(default=""),
    status_filter: str = Query(default="", alias="status"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=500, ge=1, le=2000),
) -> list[InvoiceRow]:
    """Alle Aufträge mit Rechnung, mit Überfälligkeit.

    Bewusst aus der eigenen Datenbank und nicht aus Stripe: die Liste muss auch
    dastehen, wenn Stripe gerade nicht erreichbar ist. Den Abgleich besorgt
    ``/invoices/sync-open``, wenn jemand ihn anstösst.
    """
    from sqlalchemy import or_
    from sqlalchemy.orm import defer, joinedload
    from ..db import chunked_in

    now = datetime.now(timezone.utc)
    query = (
        db.query(Order)
        .options(
            joinedload(Order.user).load_only(User.id, User.email, User.company, User.name),
            defer(Order.office_note),
            defer(Order.manual_shipment),
            defer(Order.price_breakdown),
            defer(Order.price_check),
        )
        .filter(Order.invoice_no != "")
    )
    if only_open:
        query = query.filter(Order.paid.is_(False))
    if status_filter == "bezahlt":
        query = query.filter(Order.paid.is_(True))
    elif status_filter == "offen":
        query = query.filter(Order.paid.is_(False))
    elif status_filter == "überfällig":
        query = query.filter(
            Order.paid.is_(False),
            Order.invoice_due_at.isnot(None),
            Order.invoice_due_at < now,
        )
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.outerjoin(User, Order.user_id == User.id).filter(
            or_(
                Order.invoice_no.ilike(like),
                Order.no.ilike(like),
                Order.customer_ref.ilike(like),
                Order.contact_email.ilike(like),
                User.company.ilike(like),
                User.name.ilike(like),
                User.email.ilike(like),
            )
        )
    total = int(query.count() or 0)
    response.headers["X-Total-Count"] = str(total)
    rows = query.order_by(Order.invoiced_at.desc(), Order.id.desc()).offset(offset).limit(limit).all()
    inv_nos = [o.invoice_no for o in rows if o.invoice_no]
    # Nur Metadaten (pdf_size, number) statt das gesamte verschlüsselte PDF-Blob laden!
    docs = (
        {
            inv_no: (num or "", int(pdf_sz or 0) > 0)
            for inv_no, num, pdf_sz in db.query(
                InvoiceDocument.invoice_no, InvoiceDocument.number, InvoiceDocument.pdf_size
            )
            .filter(chunked_in(InvoiceDocument.invoice_no, inv_nos))
            .all()
        }
        if inv_nos
        else {}
    )
    structured = (
        {
            inv_no
            for (inv_no,) in db.query(StructuredInvoiceDocument.invoice_no)
            .filter(chunked_in(StructuredInvoiceDocument.invoice_no, inv_nos))
            .all()
        }
        if inv_nos
        else set()
    )
    if local_invoices.allowed() and inv_nos:
        structured |= {
            n
            for (n,) in db.query(LocalInvoice.number)
            .filter(chunked_in(LocalInvoice.number, inv_nos))
            .all()
        }
    out: list[InvoiceRow] = []
    for o in rows:
        due = o.invoice_due_at
        if due and due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
        overdue = 0
        if due and not o.paid and due < now:
            overdue = (now - due).days
        doc_num, doc_has_pdf = docs.get(o.invoice_no, ("", False))
        out.append(
            InvoiceRow(
                order_no=o.no,
                invoice_no=o.invoice_no,
                customer=_customer_name(o, "") or (o.user.email if o.user else ""),
                email=o.contact_email or (o.user.email if o.user else ""),
                net=float(o.net or 0),
                gross=float(o.gross or 0),
                vat=float(o.vat or 0),
                tax_rate=float((o.tax_status or {}).get("rate", 0.19)),
                has_einvoice=o.invoice_no in structured,
                invoiced_at=o.invoiced_at,
                due_at=o.invoice_due_at,
                paid=bool(o.paid),
                paid_at=o.paid_at,
                days_overdue=overdue,
                status="bezahlt" if o.paid else ("überfällig" if overdue else "offen"),
                verwendungszweck=_verwendungszweck(o),
                has_copy=doc_has_pdf,
                copy_number=doc_num,
            )
        )
    return out


@router.get(
    "/orders/{no}/invoice.pdf",
    response_class=Response,
    dependencies=[Depends(require_staff)],
)
def invoice_pdf(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    refresh: bool = Query(
        default=False,
        description="Erneut bei Stripe holen statt das abgelegte Exemplar zu nehmen",
    ),
) -> Response:
    """Die Rechnung als PDF — vorzugsweise aus der eigenen Ablage.

    Der Mailversand von Stripe hängt am Zustand des Kontos und bleibt oft aus;
    die Rechnung gibt es trotzdem. Sie hier abzuholen macht das Büro davon
    unabhängig: herunterladen, selbst versenden, ablegen.

    Zuerst das Haus-Exemplar (``InvoiceDocument``) — das ist da, auch wenn
    Stripe es gerade nicht ist. Fehlt es, wird es geholt und dabei abgelegt,
    sodass es beim nächsten Mal ohne fremden Dienst geht.
    """
    order = _require_order(no, db)
    if not order.invoice_no:
        raise HTTPException(
            status_code=404, detail="Zu diesem Auftrag gibt es keine Rechnung."
        )
    if local_invoices.current(db, order):  # kein PDF-Renderer: die Druckseite
        return RedirectResponse(f"/api/invoicing/orders/{no}/invoice.html", status_code=307)

    doc = (
        db.query(InvoiceDocument)
        .filter(InvoiceDocument.invoice_no == order.invoice_no)
        .first()
    )
    if doc and doc.pdf and not refresh:
        return Response(
            doc.pdf,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="Rechnung-{doc.number or order.no}.pdf"',
                f"X-{smtp_client.HEADER_NAME}-Quelle": "ablage",
                "Cache-Control": "no-store",
            },
        )

    try:
        stripe = _try_client()
        inv = stripe.Invoice.retrieve(order.invoice_no)
        if not (getattr(inv, "invoice_pdf", "") or ""):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Diese Rechnung ist noch ein Entwurf — ein PDF entsteht erst "
                "beim Finalisieren.",
            )
        doc = _archive_invoice(db, order, inv)
        if doc is None or not doc.pdf:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Das PDF liess sich bei Stripe nicht abholen.",
            )
        db.commit()
    except StripeUnavailable as exc:
        # Kein Stripe und kein Exemplar — dann ehrlich sagen, was fehlt.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _stripe_error(exc) from exc

    return Response(
        doc.pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="Rechnung-{doc.number or order.no}.pdf"',
            f"X-{smtp_client.HEADER_NAME}-Quelle": "stripe",
            "Cache-Control": "no-store",
        },
    )


class InvoiceLinks(BaseModel):
    """Wege zu einer Rechnung — ohne sie herunterzuladen."""

    order_no: str
    invoice_no: str = ""
    number: str = ""
    status: str = ""
    total_cents: int = 0
    recipient: str = ""
    #: Was der Kunde bei der Überweisung angeben soll.
    verwendungszweck: str = ""
    #: Welche Zahlwege die Rechnung anbietet — damit die Oberfläche keinen
    #: Weg nennt, der abgeschaltet ist.
    payment_methods: list[str] = Field(default_factory=list)
    #: Kundenseite zum Bezahlen — die darf weitergegeben werden.
    hosted_url: str = ""
    #: Die Rechnung im Stripe-Dashboard — nur fürs Haus.
    dashboard_url: str = ""
    #: Liegt das PDF im Haus? Dann geht der Abruf ohne Stripe.
    has_copy: bool = False
    live: bool = False


@router.get(
    "/orders/{no}/invoice/links",
    response_model=InvoiceLinks,
    dependencies=[Depends(require_staff)],
)
def invoice_links(no: str, db: Annotated[Session, Depends(get_db)]) -> InvoiceLinks:
    """Zahlseite und Dashboard-Adresse zu einer Rechnung.

    Bewusst zuerst aus der eigenen Ablage: die Auftragsliste soll Verweise
    zeigen können, ohne für jede Zeile bei Stripe anzufragen. Nur wenn nichts
    abgelegt ist, wird einmal nachgesehen — und das Ergebnis dann abgelegt.
    """
    order = _require_order(no, db)
    if not order.invoice_no:
        raise HTTPException(
            status_code=404, detail="Zu diesem Auftrag gibt es keine Rechnung."
        )

    row = local_invoices.current(db, order)
    if row:
        buyer = (row.data or {}).get("buyer") or {}
        return InvoiceLinks(order_no=order.no, invoice_no=row.number, number=row.number,
                            status="bezahlt" if order.paid else "offen", total_cents=row.gross_cents,
                            recipient=buyer.get("email", ""), verwendungszweck=row.number)
    live = not stripe_client.secret_key().startswith("sk_test")
    # Die Dashboard-Adresse folgt einem festen Muster und braucht keinen Aufruf.
    dash = (
        f"https://dashboard.stripe.com/{'' if live else 'test/'}"
        f"invoices/{order.invoice_no}"
    )

    doc = (
        db.query(InvoiceDocument)
        .filter(InvoiceDocument.invoice_no == order.invoice_no)
        .first()
    )
    # Die Abkürzung über die Ablage gilt nur, wenn auch der Verwendungszweck
    # schon dasteht — sonst nennte die Auftragsansicht dauerhaft die
    # Auftragsnummer statt des Codes, auf den der Eingang gematcht wird. Beim
    # ersten Mal kostet das einen Aufruf, danach greift die Abkürzung wieder.
    if doc and doc.hosted_url and order.invoice_reference:
        return InvoiceLinks(
            order_no=order.no,
            invoice_no=order.invoice_no,
            number=doc.number,
            status="bezahlt" if order.paid else "offen",
            total_cents=doc.total_cents,
            recipient=doc.recipient,
            verwendungszweck=_verwendungszweck(order),
            payment_methods=_payment_settings()["payment_method_types"],
            hosted_url=doc.hosted_url,
            dashboard_url=dash,
            has_copy=bool(doc.pdf),
            live=live,
        )

    try:
        stripe = _try_client()
        inv = stripe.Invoice.retrieve(order.invoice_no)
        _backfill_reference(stripe, order, inv, db)
        doc = _archive_invoice(db, order, inv)
        db.commit()
    except StripeUnavailable:
        # Ohne Stripe bleibt wenigstens die Dashboard-Adresse — sie ist
        # aus der Rechnungsnummer ableitbar und braucht keinen Dienst.
        return InvoiceLinks(
            order_no=order.no,
            invoice_no=order.invoice_no,
            verwendungszweck=_verwendungszweck(order),
            payment_methods=_payment_settings()["payment_method_types"],
            dashboard_url=dash,
            live=live,
        )
    except Exception as exc:  # noqa: BLE001
        raise _stripe_error(exc) from exc

    return InvoiceLinks(
        order_no=order.no,
        invoice_no=order.invoice_no,
        number=getattr(inv, "number", "") or "",
        status=inv.status or "",
        total_cents=int(getattr(inv, "total", 0) or 0),
        recipient=getattr(inv, "customer_email", "") or "",
        verwendungszweck=_verwendungszweck(order),
        payment_methods=_payment_settings()["payment_method_types"],
        hosted_url=getattr(inv, "hosted_invoice_url", "") or "",
        dashboard_url=dash,
        has_copy=bool(doc and doc.pdf),
        live=live,
    )


@router.post("/orders/{no}/invoice/send")
def resend_invoice(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Den Versand noch einmal versuchen.

    Scheitert er wieder, ist das kein Fehler des Vorgangs: die Rechnung steht,
    und der Zahllink lässt sich von Hand verschicken. Deshalb kommt der Grund
    als Feld zurück und nicht als 502.
    """
    order = _require_order(no, db)
    if not order.invoice_no:
        raise HTTPException(
            status_code=404, detail="Zu diesem Auftrag gibt es keine Rechnung."
        )
    if local_invoices.current(db, order):
        raise HTTPException(409, "Eine lokale Rechnung verschickt Gimel nicht: Druckseite oder XML weitergeben.")
    try:
        stripe = _try_client()
        inv = stripe.Invoice.retrieve(order.invoice_no)
        if (inv.status or "draft") == "draft":
            _check_invoice_total(inv, order)
            inv = stripe.Invoice.finalize_invoice(inv.id)
        sent, send_error = True, ""
        try:
            inv = stripe.Invoice.send_invoice(inv.id)
        except Exception as exc:  # noqa: BLE001
            sent, send_error = False, _stripe_message(exc)
            inv = stripe.Invoice.retrieve(inv.id)
        _backfill_reference(stripe, order, inv, db)
    except StripeUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _stripe_error(exc) from exc

    _archive_invoice(db, order, inv)
    db.add(
        AuditLog(
            actor=actor.email,
            action="invoice_resend",
            entity="order",
            entity_id=order.no,
            detail={"invoice_id": inv.id, "sent": sent, "send_error": send_error},
        )
    )
    db.commit()
    return {
        "order_no": order.no,
        "invoice_id": inv.id,
        "sent": sent,
        "send_error": send_error,
        "status": inv.status or "",
        "verwendungszweck": _verwendungszweck(order),
        "hosted_url": getattr(inv, "hosted_invoice_url", "") or "",
        "pdf_url": getattr(inv, "invoice_pdf", "") or "",
    }


@router.post("/orders/{no}/invoice/void")
def void_invoice(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Eine Rechnung stornieren und den Auftrag wieder freigeben.

    Storniert wird in Stripe, nicht gelöscht — eine ausgestellte Rechnung
    verschwindet nicht, sie wird ungültig. Am Auftrag fällt die Zuordnung
    danach weg, damit eine berichtigte Rechnung entstehen kann.
    """
    order = _require_order(no, db)
    if not order.invoice_no:
        raise HTTPException(
            status_code=404, detail="Zu diesem Auftrag gibt es keine Rechnung."
        )
    if order.paid:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Eine bezahlte Rechnung wird nicht storniert, "
            "sondern gutgeschrieben.",
        )
    row = local_invoices.current(db, order)
    if row:
        return _cancel_local(order, row, "Storno aus dem Auftragsbüro", db, actor)
    old = order.invoice_no
    try:
        stripe = _try_client()
        inv = stripe.Invoice.retrieve(old)
        state = inv.status or "draft"
        # Jeder Zustand kann etwas anderes — und „paid" kann gar nichts.
        if state == "draft":
            stripe.Invoice.delete(old)  # nie ausgestellt, also spurlos weg
        elif state == "open":
            stripe.Invoice.void_invoice(old)  # ausgestellt: ungültig, nicht gelöscht
        elif state in ("void", "uncollectible"):
            pass  # schon erledigt; unten nur noch lösen
        else:  # paid
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stripe führt diese Rechnung als bezahlt. Bezahlte Rechnungen "
                "werden nicht storniert, sondern gutgeschrieben — bitte im "
                "Stripe-Dashboard eine Gutschrift anlegen.",
            )
    except StripeUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    except HTTPException:
        # Die eigene, erklärte Ablehnung darf nicht als Stripe-Fehler enden.
        raise
    except Exception as exc:  # noqa: BLE001
        raise _stripe_error(exc) from exc

    order.invoice_no = ""
    order.invoiced_at = None
    order.invoice_due_at = None
    db.add(
        AuditLog(
            actor=actor.email,
            action="invoice_void",
            entity="order",
            entity_id=order.no,
            detail={"invoice_id": old},
        )
    )
    db.commit()
    return {"order_no": order.no, "voided": old}


class ManualPayment(BaseModel):
    note: str = Field(min_length=12, max_length=300)


@router.post("/orders/{no}/invoice/paid")
def mark_paid(
    no: str,
    body: ManualPayment,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Zahlungseingang von Hand buchen.

    Für das Geld, das neben Stripe ankommt: Überweisung aufs Hauskonto, Bar
    bei Abholung, Verrechnung. Ohne diesen Weg bliebe so ein Auftrag ewig als
    „offen" stehen und die Mahnliste wäre wertlos.
    """
    order = _require_order(no, db)
    if order.paid:
        return {"order_no": order.no, "already_paid": True}
    if order.invoice_no and not local_invoices.current(db, order):
        raise HTTPException(409, "Für eine Stripe-Rechnung den Zahlungseingang in Stripe abgleichen. Externe Zahlung dort als außerhalb von Stripe bezahlt erfassen und anschließend synchronisieren.")
    if not body.note.strip() or len(body.note.strip()) < 12:
        raise HTTPException(422, "Bitte einen nachvollziehbaren Zahlungsnachweis angeben.")
    from ..services import order_flow

    order_flow.mark_paid(
        db,
        order,
        actor=actor.email,
        note=body.note,
        method=order.payment_method or "manual",
        action="invoice_paid_manual",
        release=True,
        release_note="Freigegeben: Rechnung bezahlt",
        detail={"invoice_id": order.invoice_no},
    )
    db.commit()
    return {"order_no": order.no, "paid": True, "paid_at": order.paid_at}


@router.post("/invoices/sync-open")
def sync_all_open(
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Alle offenen Rechnungen abgleichen — einmal für die Buchhaltungsliste."""
    orders = [o for o in db.query(Order).filter(Order.invoice_no != "", Order.paid.is_(False)).all()
              if not local_invoices.current(db, o)]
    booked: list[str] = []
    errors: list[dict] = []
    for order in orders:
        try:
            r = _sync_invoice_status(db, order)
            if r.get("booked"):
                booked.append(order.no)
        except HTTPException as exc:
            errors.append({"order_no": order.no, "detail": exc.detail})
    return {"checked": len(orders), "booked": booked, "errors": errors}


# --------------------------------------------------------------------------
# Webhook — Stripe ruft hier an, wenn Geld geflossen ist
# --------------------------------------------------------------------------
@router.post("/stripe/webhook", include_in_schema=False)
async def stripe_webhook(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    stripe_signature: Annotated[Optional[str], Header()] = None,
) -> dict:
    """Nur echte Zahlungsereignisse buchen — mit Signaturprüfung.

    Konfiguriert über ``stripe listen --forward-to
    localhost:8000/api/invoicing/stripe/webhook`` (lokal) bzw. einen
    Webhook-Endpunkt im Stripe-Dashboard (live).
    """
    secret = stripe_client.webhook_secret()
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Webhook nicht eingerichtet (STRIPE_WEBHOOK_SECRET fehlt).",
        )
    payload = await request.body()
    try:
        import stripe

        event = stripe.Webhook.construct_event(payload, stripe_signature or "", secret)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ungültige Webhook-Signatur.",
        ) from exc

    etype = event["type"]
    obj = event["data"]["object"]

    if etype == "invoice.paid":
        order = db.query(Order).filter(Order.invoice_no == obj.get("id")).first()
        if order:
            try:
                _book_payment(
                    db, order, int(obj.get("amount_paid") or 0), obj.get("id") or "", obj.get("currency") or ""
                )
            except HTTPException as exc:
                if exc.status_code != status.HTTP_409_CONFLICT:
                    raise
                db.add(
                    AuditLog(
                        actor="stripe",
                        action="invoice_paid_mismatch",
                        entity="order",
                        entity_id=order.no,
                        detail={
                            "invoice_id": obj.get("id") or "",
                            "amount_paid": obj.get("amount_paid"),
                            "currency": obj.get("currency") or "",
                            "expected_gross_cents": _cents(order.gross),
                            "detail": exc.detail,
                        },
                    )
                )
            db.commit()
        else:
            # Eine Rechnung, die keinem Auftrag hier gehört — protokollieren,
            # nicht verschweigen, aber nicht abweisen: Stripe wiederholt sonst.
            db.add(
                AuditLog(
                    actor="stripe",
                    action="invoice_paid_unmatched",
                    entity="invoice",
                    entity_id=obj.get("id") or "",
                    detail={"amount_paid": obj.get("amount_paid")},
                )
            )
            db.commit()
    elif etype in (
        "invoice.payment_failed",
        "invoice.voided",
        "invoice.marked_uncollectible",
    ):
        order = db.query(Order).filter(Order.invoice_no == obj.get("id")).first()
        if order:
            db.add(
                AuditLog(
                    actor="stripe",
                    action=etype,
                    entity="order",
                    entity_id=order.no,
                    detail={"status": obj.get("status")},
                )
            )
            db.commit()

    return {"received": True, "type": etype}
