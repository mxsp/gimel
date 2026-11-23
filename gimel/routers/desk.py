"""Auftragsbüro — Aufträge am Commander, Person-zu-Person.

Das Spiegelportal des Bestellportals: derselbe Rechenkern, dieselben
Auftragsobjekte, aber die Richtung dreht sich um. Nicht der Kunde bestellt im
Browser und bezahlt an der Kasse — ein Mitarbeiter im Gespräch mit dem Kunden
erfasst den Auftrag hier, lädt dessen DXF hoch (oder lässt aus einer
PDF-Zeichnung eine entwerfen) und schickt hinterher die Rechnung darüber.

Regeln, die vom Bestellportal unverändert übernommen sind:

* Der Preis wird hier ein einziges Mal gerechnet und friert mit dem Auftrag
  ein (services/orders.place_order — CLAUDE.md §8.1).
* Übergrößen bleiben Anfrage an die Technik, nie automatisch bepreist (§5.1).
* Bezahlt heißt freigegeben — außer der Preis sagt etwas anderes (§2.6).

Der Freigabeunterschied zum Kassenweg: am Auftragsbüro entscheidet der
Zahlungsweg. „Rechnung" gibt erst den Zahlungseingang frei (der Webhook
schaltet weiter), „auf Rechnung/Offenrechnung" ist ab Auftrag freigegeben —
außer der Kreditrahmen des Kunden reichte nicht.
"""

from __future__ import annotations

import logging

from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditLog, Order, OrderPosition, Role, User
from ..schemas import QuoteLine
from ..security import has_admin_work, require_staff
from ..services import csv_io, mailer
from ..services.catalog import load_products
from ..services.dimension_limits import load_limits, validate_all
from ..services.dxf_import import parse_dxf
from ..services.events import bus
from ..services.orders import place_order, release_on_account

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/desk", tags=["desk"], dependencies=[Depends(require_staff)]
)


# --------------------------------------------------------------------------
# DXF-Upload — Geometrie erfassen, ohne dass ein Browser im Spiel war
# --------------------------------------------------------------------------
@router.post("/dxf")
def upload_dxf(
    file: Annotated[UploadFile, File()], actor: Annotated[User, Depends(require_staff)]
) -> dict:
    """Eine Kundenzeichnung lesen und die Kontur zurückgeben.

    Die Antwort ist eine Position im Rohbau (shape, od, di, cut_len) — genau
    die Felder, die ``POST /api/desk/orders`` für eine Zeile haben will.
    """
    raw = file.file.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Die Datei ist größer als 4 MB.",
        )
    try:
        text = raw.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Das ist keine ASCII-DXF-Datei (oder sie trägt "
            "eine andere Kodierung).",
        )
    if not file.filename or not file.filename.lower().endswith((".dxf", ".txt")):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Erwartet wird eine .dxf-Datei.",
        )
    result = parse_dxf(text)
    if result.get("error"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=result["error"]
        )
    result["filename"] = file.filename
    return result


# --------------------------------------------------------------------------
# CSV: Aufträge herein, Aufträge hinaus
# --------------------------------------------------------------------------
@router.post("/import/orders")
def import_orders(
    file: Annotated[UploadFile, File()],
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
    commit: bool = Query(default=False, description="False = nur prüfen, es entsteht nichts"),
) -> dict:
    """Aufträge aus einer CSV-Datei: erst die Vorschau, dann derselbe Upload mit ``commit=true``."""
    raw = file.file.read(csv_io.MAX_BYTES + 1)
    if len(raw) > csv_io.MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Die Datei ist größer als 4 MB.")
    if not (file.filename or "").lower().endswith((".csv", ".txt")):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Erwartet wird eine .csv-Datei.")
    plan = csv_io.plan_import(db, raw)
    if not commit:
        return plan.out("preview")
    if plan.errors or not plan.orders:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, plan.out("commit"))
    created = csv_io.commit_import(db, plan, actor.email, file.filename or "")
    for no in created:
        bus.publish("order_created", {"order_no": no, "created": True, "source": "csv"})
    return plan.out("commit", created)


@router.get("/export/orders.csv", response_class=Response)
def export_orders(
    db: Annotated[Session, Depends(get_db)], actor: Annotated[User, Depends(require_staff)]
) -> Response:
    """Alle Aufträge. Eine Massenausgabe von Kundendaten, darum mit Protokollzeile."""
    return csv_io.orders_response(db, actor.email)


# --------------------------------------------------------------------------
# Aufträge am Commander
# --------------------------------------------------------------------------
class NewCustomer(BaseModel):
    """Ein Kunde, der im Gespräch entsteht — angelegt und dann bestellt."""

    email: EmailStr
    name: str = ""
    company: str = ""
    price_group: str = "standard"
    discount_pct: float = Field(default=0.0, ge=0, le=100)
    payment_terms: str = "30 Tage netto"
    customer_no: str = ""
    credit_limit: float = Field(default=0.0, ge=0)
    vat_id: str = ""


class ManualShipmentIn(BaseModel):
    """Manueller Versand: Spedition, Sendungsnummer, Versandkosten und Notiz
    werden am Auftrag von Hand erfasst. Der Versand liest sie später als
    Vorgabe — vorausgefüllt, aber editierbar."""

    carrier: str = Field(default="", max_length=80)
    tracking: str = Field(default="", max_length=120)
    price: float = Field(default=0.0, ge=0)
    note: str = Field(default="", max_length=500)


class DeskOrderIn(BaseModel):
    lines: list[QuoteLine]
    cert: str = "2.2"
    plate: dict[str, int] = Field(default_factory=dict)
    tax_status: dict = Field(default_factory=dict)

    #: ``external`` ist der Kundenauftrag (Kunde, Lieferung, Zahlung,
    #: Rechnung). ``internal`` ist ein betriebsinterner Auftrag: kein Kunde,
    #: keine Zahlung, keine Rechnung — dafür ein verantwortlicher Mitarbeiter.
    kind: Literal["external", "internal"] = "external"
    internal_owner: str = Field(default="", max_length=160)

    #: Bestehender Kunde ODER ein neuer mit Konditionen — genau einer von beiden.
    #: Bei einem internen Auftrag bleibt beides leer.
    customer_id: Optional[int] = None
    new_customer: Optional[NewCustomer] = None

    contact_email: Optional[EmailStr] = None
    customer_ref: str = ""
    ship_address: dict = Field(default_factory=dict)
    bill_address: dict = Field(default_factory=dict)
    rush: bool = False
    #: Fertigungsort-Vorgabe und Eingangsstandort (Aufgabe 32), siehe services/sites.py.
    route_scope: str = Field(default="", max_length=200)
    site_id: Optional[int] = None
    #: "invoice" → Freigabe erst mit Zahlungseingang der Stripe-Rechnung.
    #: "account" → Offenrechnung, ab Auftrag freigegeben, sofern der
    #: Kreditrahmen reicht.
    payment_mode: str = Field(default="invoice", pattern=r"^(invoice|account)$")

    #: Manueller Versand — Spedition und Tracking kennt der Erfasser schon
    #: (Kunde liefert selbst, eigene Abholung, vereinbarter Versandweg). Der
    #: Versand muss ihn dann nicht mehr erfragen; die Vorgabe bleibt editierbar.
    manual_shipment: Optional[ManualShipmentIn] = None
    #: Auftragssperre des Kunden für diesen einen Auftrag übergehen (nur Admin).
    override_block: bool = False


class DeskOrderOut(BaseModel):
    no: str
    created_at: datetime
    kind: str = "external"
    internal_owner: str = ""
    customer_id: Optional[int]
    customer_name: str
    customer_email: str
    customer_ref: str
    cert: str
    net: float
    vat: float
    gross: float
    blocked: bool
    released: bool
    release_note: str
    paid: bool
    paid_at: Optional[datetime] = None
    payment_method: str
    invoice_no: str
    invoiced_at: Optional[datetime] = None
    invoice_due_at: Optional[datetime] = None
    due_date: Optional[datetime] = None
    rush: bool
    n_positions: int
    price_breakdown: dict
    manual_shipment: dict = Field(default_factory=dict)
    #: Lebenslauf (Aufgabe 45). ``rev`` schickt die Oberfläche bei jeder
    #: Aktion zurück; ein veralteter Stand bekommt 409.
    held_at: Optional[datetime] = None
    hold_reason: str = ""
    cancelled_at: Optional[datetime] = None
    cancel_reason: str = ""
    office_note: str = ""
    rev: int = 0


def _order_out(order: Order, customer: User | None, *, n_positions: int | None = None) -> DeskOrderOut:
    internal = (order.kind or "external") == "internal"
    if internal:
        customer_name = order.internal_owner or ""
    elif customer:
        customer_name = customer.company or customer.name
    else:
        customer_name = (order.ship_address or {}).get("company", "")
    return DeskOrderOut(
        no=order.no,
        created_at=order.created_at,
        kind=order.kind or "external",
        internal_owner=order.internal_owner or "",
        customer_id=order.user_id,
        customer_name=customer_name,
        customer_email=customer.email if customer else order.contact_email,
        customer_ref=order.customer_ref,
        cert=order.cert,
        net=order.net,
        vat=order.vat,
        gross=order.gross,
        blocked=order.blocked,
        released=order.released,
        release_note=order.release_note,
        paid=order.paid,
        paid_at=order.paid_at,
        payment_method=order.payment_method,
        invoice_no=order.invoice_no,
        invoiced_at=order.invoiced_at,
        invoice_due_at=order.invoice_due_at,
        due_date=order.due_date,
        rush=order.rush,
        n_positions=len(order.positions) if n_positions is None else n_positions,
        price_breakdown=order.price_breakdown or {},
        manual_shipment=order.manual_shipment or {},
        held_at=order.held_at,
        hold_reason=order.hold_reason or "",
        cancelled_at=order.cancelled_at,
        cancel_reason=order.cancel_reason or "",
        office_note=order.office_note or "",
        rev=int(order.rev or 0),
    )


def _validate_lines(db: Session, lines: list[QuoteLine]) -> None:
    limits = load_limits(db)
    products = load_products(db)
    for line in lines:
        # Freie Positionen tragen keine Maße — es gibt nichts zu prüfen.
        if line.kind in ("sheet", "custom"):
            continue
        product = products.get(line.mat)
        web = product.min_web if product else None
        w = line.fmt[0] if line.fmt and len(line.fmt) >= 2 else None
        h = line.fmt[1] if line.fmt and len(line.fmt) >= 2 else None
        errors = validate_all(line.od, line.di, w, h, limits, web)
        if errors:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f'Position "{line.label or line.mat}" '
                f"verletzt Maßbeschränkungen: {' '.join(errors)}",
            )


@router.post(
    "/orders", response_model=DeskOrderOut, status_code=status.HTTP_201_CREATED
)
def create_order(
    body: DeskOrderIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> DeskOrderOut:
    """Auftrag anlegen — extern für einen Kunden, intern ohne Kunde und Zahlung."""
    if not body.lines:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Ohne Positionen kein Auftrag.",
        )
    internal = body.kind == "internal"
    owner = body.internal_owner.strip()
    if internal:
        if not owner:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Ein interner Auftrag braucht einen verantwortlichen Mitarbeiter.",
            )
        if body.customer_id or body.new_customer:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Ein interner Auftrag hat keinen Kunden.",
            )
    elif bool(body.customer_id) == bool(body.new_customer):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Genau ein Kunde: bestehend (customer_id) oder neu (new_customer).",
        )

    if internal:
        # Kein Kunde, keine Lieferanschrift: der Auftrag bleibt im Haus.
        ship: dict = {}
    else:
        ship = body.ship_address or {}
        if not (ship.get("street") and ship.get("city")):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Ohne vollständige Lieferadresse kein Auftrag.",
            )

    # ---- Kunde ----------------------------------------------------------
    customer: User | None = None
    if not internal:
        if body.customer_id:
            customer = db.get(User, body.customer_id)
            if not customer:
                raise HTTPException(status_code=404, detail="Kunde nicht gefunden.")
        else:
            nc = body.new_customer
            email = str(nc.email).strip().lower()
            existing = db.query(User).filter(User.email == email).first()
            if existing:
                customer = existing
            else:
                import secrets as _secrets

                from ..security import hash_password

                customer = User(
                    email=email,
                    password_hash=hash_password(_secrets.token_urlsafe(24)),
                    name=nc.name,
                    company=nc.company,
                    role=Role.customer,
                    price_group=nc.price_group,
                    discount_pct=nc.discount_pct,
                    payment_terms=nc.payment_terms,
                    customer_no=nc.customer_no,
                    credit_limit=nc.credit_limit,
                    vat_id=nc.vat_id,
                )
                db.add(customer)
                db.flush()
                db.add(
                    AuditLog(
                        actor=actor.email,
                        action="desk_customer_create",
                        entity="user",
                        entity_id=str(customer.id),
                        detail={"email": email, "company": nc.company, "via": "desk_order"},
                    )
                )

    if not internal:
        # Beide Wege (gewählter Kunde, „neuer" Kunde mit bekannter E-Mail) enden
        # hier: nur Kundenkonten bekommen Aufträge, und die Auftragssperre gilt
        # unabhängig davon, wie der Kunde gefunden wurde.
        if customer.email.endswith("@invalid"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Dieses Kundenkonto wurde gelöscht.",
            )
        if customer.role != Role.customer:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Diese E-Mail-Adresse gehört zu einem Personalkonto, nicht zu einem Kunden.",
            )
        # Auftragssperre (Aufgabe 45): das Büro nimmt für diesen Kunden
        # nichts Neues an. Übergehen darf sie nur ein Admin, ausdrücklich
        # und mit Protokollzeile.
        if customer.order_block:
            reason = (customer.order_block_reason or "").strip()
            if not body.override_block:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Für diesen Kunden besteht eine Auftragssperre"
                    + (f": {reason}" if reason else ".")
                    + " Die Sperre in der Kundenkarte aufheben oder von einem"
                    " Admin für diesen Auftrag übergehen lassen.",
                )
            if not has_admin_work(actor):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Eine Auftragssperre darf nur ein Admin übergehen.",
                )
            db.add(
                AuditLog(
                    actor=actor.email,
                    action="customer_block_override",
                    entity="user",
                    entity_id=str(customer.id),
                    detail={"reason": reason},
                )
            )

    # ---- Maße prüfen, Preis rechnen, Auftrag einfrieren ------------------
    _validate_lines(db, body.lines)
    # Interne Aufträge werden nicht berechnet: kein Kunde, keine Rechnung,
    # also auch keine Umsatzsteuer auf dem Beleg.
    tax_status = body.tax_status or (
        {"rate": 0.0, "type": "internal"}
        if internal
        else {"rate": 0.19, "type": "domestic"}
    )
    contact = "" if internal else (
        str(body.contact_email) if body.contact_email else customer.email
    )
    # Manueller Versand: die handerfassten Versandkosten sind die Versandzeile
    # der Rechnung — anstelle der Pauschale, auch als 0 (Abholung ohne Kosten).
    # Der Preis läuft durch denselben Pfad wie die Vorschau, damit beide nie
    # auseinanderlaufen. Ein interner Auftrag wird nicht versendet.
    # Fertigungsort vor dem Anlegen prüfen: ein Fehler darf keinen halben Auftrag hinterlassen.
    from ..models import FactorySite
    from ..services import sites

    try:
        scope_raw = sites.validate(db, body.route_scope)
    except sites.ScopeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.site_id is not None and db.get(FactorySite, body.site_id) is None:
        raise HTTPException(status_code=400, detail="Standort nicht gefunden.")

    freight_override = (
        body.manual_shipment.price
        if not internal and body.manual_shipment is not None
        else None
    )
    order = place_order(
        db,
        lines=body.lines,
        cert=body.cert,
        ship_address=ship,
        bill_address={} if internal else (body.bill_address or ship),
        tax_status=tax_status,
        customer_ref=body.customer_ref,
        user=customer,
        plate=body.plate,
        rush=body.rush,
        contact_email=contact,
        paid=False,
        payment_method="internal" if internal else body.payment_mode,
        freight_override=freight_override,
        kind=body.kind,
        internal_owner=owner,
        # Wer bis hierher kam, hat keine Sperre oder sie als Admin übergangen.
        hold_for_customer_block=False,
    )

    # ---- Manueller Versand ----------------------------------------------
    # Nur speichern, wenn der Haken gesetzt war — ein leeres Dict ließe sonst
    # den Versand glauben, es gebe eine Vorgabe, die es nicht gibt.
    if not internal and body.manual_shipment is not None:
        order.manual_shipment = body.manual_shipment.model_dump()

    # ---- Fertigungsort (vorher geprüft) ------------------------------------
    order.route_scope = scope_raw
    if body.site_id is not None:
        order.site_id = body.site_id

    # ---- Freigabe je Auftragsart und Zahlungsweg -------------------------
    if internal:
        # Kein Geld, das die Freigabe aufhalten könnte: der interne Auftrag
        # geht direkt in die Fertigung (eine Übergröße bleibt gesperrt).
        order.released = not order.blocked
        order.release_note = "Interner Auftrag — keine Zahlung nötig"
    elif body.payment_mode == "account":
        release_on_account(db, order, customer)
    else:
        order.released = False
        order.release_note = "Freigabe mit Zahlungseingang der Rechnung"

    db.add(
        AuditLog(
            actor=actor.email,
            action="desk_order_create",
            entity="order",
            entity_id=order.no,
            detail={
                "kind": order.kind,
                "customer": customer.email if customer else "",
                "internal_owner": order.internal_owner,
                "payment_mode": "internal" if internal else body.payment_mode,
                "net": order.net,
                "gross": order.gross,
                "positions": len(order.positions),
                "manual_shipment": not internal and body.manual_shipment is not None,
            },
        )
    )
    db.commit()
    db.refresh(order)
    if (
        not internal
        and body.payment_mode == "invoice"
        and not order.blocked
        and not order.invoice_no
    ):
        try:
            from .invoicing import ensure_invoice_for_order

            ensure_invoice_for_order(
                db, order, send=False, email_override=contact, actor_email=actor.email
            )
            db.refresh(order)
        except Exception as exc:  # noqa: BLE001 — der Auftrag steht, die Rechnung holt die Buchhaltung nach
            db.rollback()
            log.exception("Automatische Rechnung zu %s fehlgeschlagen", order.no)
            db.add(AuditLog(actor=actor.email, action="invoice_auto_failed", entity="order",
                            entity_id=order.no, detail={"error": f"{type(exc).__name__}: {exc}"[:300]}))
            db.commit()
        if not order.invoice_no:
            db.add(AuditLog(actor=actor.email, action="invoice_auto_missing", entity="order",
                            entity_id=order.no,
                            detail={"hinweis": "Keine Rechnung erstellt — in der Buchhaltung nachholen."}))
            db.commit()
    bus.publish(
        "order_created",
        {
            "order_no": order.no,
            "net": order.net,
            "gross": order.gross,
            "paid": False,
            "blocked": order.blocked,
            "created": True,
            "source": "desk",
        },
    )
    # Ein interner Auftrag hat keinen Empfänger — keine Bestätigungsmail.
    if not internal:
        mailer.send_order_confirmation(order, db)
    return _order_out(order, customer)


@router.get("/orders", response_model=list[DeskOrderOut])
def list_orders(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    q: Optional[str] = None,
    uninvoiced: bool = False,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[DeskOrderOut]:
    """Die Auftragsliste des Büros — Kundenname, Rechnungsstand, Zahlung."""
    from sqlalchemy import func
    from sqlalchemy.orm import defer, joinedload
    from ..db import chunked_in

    query = db.query(Order).options(
        joinedload(Order.user).load_only(User.id, User.company, User.name, User.email),
        defer(Order.bill_address),
        defer(Order.price_check),
        defer(Order.tax_status),
    )
    if uninvoiced:
        query = query.filter(
            or_(Order.invoice_no.is_(None), Order.invoice_no == ""),
            Order.cancelled_at.is_(None),
            or_(Order.kind.is_(None), Order.kind != "internal"),
        )
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        query = query.join(User, Order.user_id == User.id, isouter=True).filter(
            or_(
                Order.no.ilike(like),
                Order.customer_ref.ilike(like),
                Order.contact_email.ilike(like),
                User.company.ilike(like),
                User.name.ilike(like),
            )
        )
    total = int(query.count() or 0)
    response.headers["X-Total-Count"] = str(total)
    orders = query.order_by(Order.created_at.desc(), Order.id.desc()).offset(offset).limit(limit).all()
    if not orders:
        return []
    pos_counts = dict(
        db.query(OrderPosition.order_id, func.count(OrderPosition.id))
        .filter(chunked_in(OrderPosition.order_id, [o.id for o in orders]))
        .group_by(OrderPosition.order_id)
        .all()
    )
    return [_order_out(o, o.user, n_positions=int(pos_counts.get(o.id, 0))) for o in orders]


@router.get("/orders/{no}", response_model=DeskOrderOut)
def get_order(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> DeskOrderOut:
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    return _order_out(order, order.user)


class ReleaseIn(BaseModel):
    note: str = ""
    #: Einen *gesperrten* Auftrag trotzdem freigeben. Ausdrücklich und nicht
    #: beiläufig: gesperrt heißt, dass die Übernahme einen Widerspruch
    #: gefunden hat — meist Preis gegen kassierten Betrag. Den zu übergehen
    #: ist eine Entscheidung, die ein Mensch trifft und die im Protokoll
    #: nachlesbar sein muss, samt der Zahlen, gegen die entschieden wurde.
    unblock: bool = False


def _blocked_detail(order: Order, check: dict) -> str:
    """Warum der Auftrag steht — mit Zahlen, nicht mit „bitte prüfen"."""
    base = order.release_note or "Auftrag gesperrt"
    if check.get("checked") and not check.get("agrees"):
        charged = (check.get("charged_gross_cents") or 0) / 100
        engine = (check.get("engine_gross_cents") or 0) / 100
        delta = (check.get("delta_gross_cents") or 0) / 100
        base = (f"{base}: kassiert {charged:.2f} €, gerechnet {engine:.2f} € "
                f"(Abweichung {delta:+.2f} €, Rechenkern "
                f"{check.get('engine_version') or '?'})")
    return (f"{base}. Zum Freigeben „unblock\" mitschicken — die Entscheidung "
            f"steht dann samt Zahlen im Protokoll.")


@router.post("/orders/{no}/release", response_model=DeskOrderOut)
def release_order(
    no: str,
    body: ReleaseIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> DeskOrderOut:
    """Von Hand freigeben — der Menschen-Ausweg, den die Regeln offen halten.

    Bis hierher war dieser Ausweg für gesperrte Aufträge zugemauert: die
    Freigabe setzte ``released``, ließ ``blocked`` aber stehen. Ein Auftrag,
    den die Übernahme wegen einer Preisabweichung gesperrt hatte, blieb damit
    für immer gesperrt — es gab keinen Knopf, der ihn wieder löste.

    Jetzt gibt es einen, aber nur ausdrücklich (``unblock``) und mit den Zahlen
    im Protokoll. Eine Sperre still zu übergehen wäre schlimmer als keine.
    """
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")

    if order.cancelled_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Der Auftrag ist storniert und kann nicht freigegeben werden.",
        )
    check = order.price_check or {}
    if order.blocked and not body.unblock:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_blocked_detail(order, check),
        )

    was_blocked = bool(order.blocked)
    order.released = True
    if body.unblock:
        order.blocked = False
    order.release_note = (
        body.note
        or (f"Sperre aufgehoben durch {actor.name or actor.email}" if was_blocked
            else f"Von Hand freigegeben durch {actor.name or actor.email}")
    )[:200]
    db.add(
        AuditLog(
            actor=actor.email,
            action="order_unblock" if was_blocked else "order_release",
            entity="order",
            entity_id=order.no,
            # Wogegen entschieden wurde, nicht nur dass entschieden wurde.
            detail={"note": order.release_note,
                    "was_blocked": was_blocked,
                    "price_check": check},
        )
    )
    db.commit()
    db.refresh(order)
    return _order_out(order, order.user)


# ---- Anhalten, Fortsetzen, Stornieren, Ändern (Aufgabe 45) -----------------

class HoldIn(BaseModel):
    reason: str = Field(default="", max_length=200)
    rev: Optional[int] = None


class ResumeIn(BaseModel):
    note: str = Field(default="", max_length=200)
    rev: Optional[int] = None


class CancelIn(BaseModel):
    reason: str = Field(default="", max_length=200)
    rev: Optional[int] = None


class OrderChangeIn(BaseModel):
    """Alle Felder optional — geändert wird nur, was mitkommt."""

    due_date: Optional[datetime] = None
    rush: Optional[bool] = None
    customer_ref: Optional[str] = Field(default=None, max_length=80)
    office_note: Optional[str] = Field(default=None, max_length=2000)
    rev: Optional[int] = None


def _order_or_404(db: Session, no: str) -> Order:
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    return order


def _flow(db: Session, order: Order, call) -> DeskOrderOut:
    """Eine Aktion aus ``order_flow`` ausführen und ihre Absage zur Antwort machen."""
    from ..services import order_flow

    try:
        call(order_flow)
    except order_flow.FlowError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status, detail=exc.detail) from None
    db.commit()
    db.refresh(order)
    return _order_out(order, order.user)


@router.post("/orders/{no}/hold", response_model=DeskOrderOut)
def hold_order(
    no: str,
    body: HoldIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> DeskOrderOut:
    """Auftrag anhalten — der Sammellauf lässt ihn liegen, bis er fortgesetzt wird."""
    order = _order_or_404(db, no)
    return _flow(db, order, lambda f: f.hold(
        db, order, actor=actor.email, reason=body.reason, rev=body.rev))


@router.post("/orders/{no}/resume", response_model=DeskOrderOut)
def resume_order(
    no: str,
    body: ResumeIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> DeskOrderOut:
    order = _order_or_404(db, no)
    return _flow(db, order, lambda f: f.resume(
        db, order, actor=actor.email, note=body.note, rev=body.rev))


@router.get("/orders/{no}/cancel-check")
def cancel_check(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Kann der Auftrag storniert werden — und wenn nicht, warum nicht."""
    from ..services import order_flow

    order = _order_or_404(db, no)
    why = order_flow.cancel_blockers(db, order)
    return {"can_cancel": not why, "blockers": why, "rev": int(order.rev or 0)}


@router.post("/orders/{no}/cancel", response_model=DeskOrderOut)
def cancel_order(
    no: str,
    body: CancelIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> DeskOrderOut:
    """Auftrag stornieren — nur vor der Planung, nichts wird gelöscht."""
    order = _order_or_404(db, no)
    out = _flow(db, order, lambda f: f.cancel(
        db, order, actor=actor.email, reason=body.reason, rev=body.rev))
    bus.publish("order_cancelled", {"order_no": order.no})
    return out


@router.patch("/orders/{no}", response_model=DeskOrderOut)
def change_order(
    no: str,
    body: OrderChangeIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> DeskOrderOut:
    """Liefertermin, Eilkennzeichen, Kundenreferenz, Büronotiz ändern."""
    order = _order_or_404(db, no)
    changes = body.model_dump(exclude_unset=True)
    rev = changes.pop("rev", None)
    return _flow(db, order, lambda f: f.change(
        db, order, changes, actor=actor.email, rev=rev))
