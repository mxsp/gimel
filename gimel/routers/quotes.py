"""Kalkulation und Bestellung."""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..core.nesting import ENGINE_VERSION
from ..models import AuditLog, Order, PortalSync, Role, User
from ..schemas import QuoteGroup, QuoteRequest, QuoteResponse
from ..security import current_user, optional_user
from ..services import trace
from ..services.dimension_limits import load_limits, validate_all
from ..services.events import bus
from ..services.orders import place_order, quote
from ..services.catalog import load_products

router = APIRouter(prefix="/api", tags=["quotes"])


def _to_response(pc: dict) -> QuoteResponse:
    groups = [
        QuoteGroup(
            mat=g["mat"],
            thk=g["thk"],
            sheet_idx=g["nested"]["sheet_idx"],
            fmt=[g["nested"]["W"], g["nested"]["H"]],
            n_sheets=g["g"]["nSheets"],
            n_rest=g["g"]["nRest"],
            waste=round(g["g"]["waste"], 6),
            used_area=round(g["g"]["usedA"], 6),
            cut_len=round(g["g"]["cutLen"], 6),
            leftover_fraction=round(g["g"]["leftoverFraction"], 6),
            leftover_credit=round(g["g"]["leftoverCredit"], 4),
        )
        for g in pc["groups"]
    ]
    return QuoteResponse(
        engine_version=ENGINE_VERSION,
        mat_c=round(pc["matC"], 4),
        cut_c=round(pc["cutC"], 4),
        sheet_c=round(pc["sheetC"], 4),
        custom_c=round(pc.get("customC", 0.0), 4),
        setup=round(pc["setup"], 4),
        setup_rate=round(pc.get("setupRate", pc["setup"]), 4),
        setup_fix=round(pc.get("setupFix", 0.0), 4),
        setup_tier=int(pc.get("setupTier", 0) or 0),
        discount_pct=round(float(pc.get("discountPct", 0.0) or 0.0), 4),
        discount=round(float(pc.get("discount", 0.0) or 0.0), 4),
        cert=round(pc["cert"], 4),
        freight=round(pc["freight"], 4),
        goods=round(pc["goods"], 4),
        total=round(pc["total"], 4),
        vat_rate=pc["vatRate"],
        vat=round(pc["vat"], 4),
        gross=round(pc["gross"], 4),
        leftover_credit=round(pc["leftoverCredit"], 4),
        mat_gross=round(pc["matGross"], 4),
        cut_len_m=round(float(pc.get("cutLenM", 0.0) or 0.0), 4),
        machine_min=round(float(pc.get("machineMin", 0.0) or 0.0), 4),
        derived_cut=round(float(pc.get("derivedCut", 0.0) or 0.0), 6),
        over=sorted(p.id for p in pc["over"]),
        per={
            k: {
                kk: (round(vv, 4) if isinstance(vv, float) else vv)
                for kk, vv in v.items()
            }
            for k, v in pc["per"].items()
        },
        groups=groups,
    )


@router.post("/quote", response_model=QuoteResponse)
def calculate(
    body: QuoteRequest,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[Optional[User], Depends(optional_user)],
) -> QuoteResponse:
    """Preis und Schachtelbefund — dieselbe Rechnung, die die Bestellung
    einfriert. Client-Vorschau und Server dürfen nie auseinanderlaufen."""
    if not body.lines:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Ohne Positionen gibt es nichts zu rechnen.",
        )
    # Manueller Versand: eine handerfasste Versandkostenposition nimmt nur das
    # Personal an. Wer nicht nachweisbar zum Personal gehört, bekommt die
    # Pauschale — der Browser eines Kunden darf keine Preisbestandteile
    # vorgeben, sonst gibt er den Preis her.
    is_staff = user is not None and user.role in (Role.staff, Role.admin)
    freight_override = body.freight if is_staff else None
    limits = load_limits(db)
    products = load_products(db)
    for line in body.lines:
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
    price_for = user
    if is_staff and body.customer_id:
        customer = db.get(User, body.customer_id)
        if not customer or customer.role != Role.customer:
            raise HTTPException(status_code=404, detail="Kunde nicht gefunden.")
        price_for = customer
    elif is_staff and (body.discount_pct is not None or body.price_group):
        # Noch kein Konto: ein ungespeicherter Stellvertreter mit den Konditionen,
        # mit denen das Auftragsbüro den Kunden gleich anlegt.
        price_for = User(email="", role=Role.customer, discount_pct=body.discount_pct or 0.0,
                         price_group=body.price_group or "standard")
    elif is_staff:
        price_for = None  # Personal ohne Kundenbezug rechnet den Listenpreis, nicht mit eigenem Rabatt
    return _to_response(
        quote(
            db,
            body.lines,
            body.cert,
            body.plate,
            body.vat_rate,
            freight_override=freight_override,
            user=price_for,
        )
    )


class OrderRequest(QuoteRequest):
    ship_address: dict = Field(default_factory=dict)
    bill_address: dict = Field(default_factory=dict)
    tax_status: dict = Field(default_factory=dict)
    customer_ref: str = ""
    anon_id: str = ""
    # Kennung der Zahlung aus dem Portal (Stripe-Sitzung bzw. Rechnung).
    # Mit ihr ist die Übernahme idempotent — Stripe stellt Webhooks erneut zu.
    external_key: str = ""


class OrderOut(BaseModel):
    no: str
    net: float
    vat: float
    gross: float
    blocked: bool
    engine_version: str
    n_positions: int


@router.post("/orders", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(
    body: OrderRequest,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[Optional[User], Depends(optional_user)],
) -> OrderOut:
    """Bestellung anlegen — auch als Gast (CLAUDE.md §6, 0.4)."""
    if not body.lines:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Der Warenkorb ist leer.",
        )
    ship = body.ship_address or {}
    if not (ship.get("street") and ship.get("city")):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Ohne vollständige Lieferadresse keine Bestellung.",
        )
    limits = load_limits(db)
    products = load_products(db)
    for line in body.lines:
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
    # Erneut zugestellter Webhook: derselbe Auftrag darf nicht zweimal in die
    # Fertigung laufen. Die Kennung sitzt genau hier, vor dem Anlegen.
    if body.external_key:
        seen = db.query(PortalSync).filter(PortalSync.key == body.external_key).first()
        if seen:
            prior = db.query(Order).filter(Order.no == seen.order_no).first()
            if prior:
                return OrderOut(
                    no=prior.no,
                    net=prior.net,
                    vat=prior.vat,
                    gross=prior.gross,
                    blocked=prior.blocked,
                    engine_version=prior.engine_version,
                    n_positions=len(prior.positions),
                )
    order = place_order(
        db,
        lines=body.lines,
        cert=body.cert,
        ship_address=ship,
        bill_address=body.bill_address or ship,
        tax_status=body.tax_status or {"rate": 0.19, "type": "domestic"},
        customer_ref=body.customer_ref,
        anon_id=body.anon_id,
        user=user,
        plate=body.plate,
    )
    if body.external_key:
        db.add(PortalSync(key=body.external_key, order_no=order.no))
    db.add(AuditLog(actor=user.email if user else "public", action="order_create",
                    entity="order", entity_id=order.no, detail={"gross": order.gross}))
    db.commit()
    bus.publish(
        "order_created",
        {
            "order_no": order.no,
            "net": order.net,
            "gross": order.gross,
            "paid": order.paid,
            "blocked": order.blocked,
        },
    )
    return OrderOut(
        no=order.no,
        net=order.net,
        vat=order.vat,
        gross=order.gross,
        blocked=order.blocked,
        engine_version=order.engine_version,
        n_positions=len(order.positions),
    )


@router.get("/orders/{no}")
def get_order(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(current_user)],
) -> dict:
    """Ein Auftrag, nur für den, dem er gehört — und für das Personal.

    Auftragsnummern laufen fortlaufend (AB-26-0001, -0002, …). Ohne
    Eigentumsprüfung ist die Nummer selbst das Geheimnis, und ein Kunde könnte
    sich durch die Lieferadressen und Geometrien aller anderen blättern. Ein
    fremder Auftrag antwortet mit 404 statt 403: sonst verrät der
    Statuscode, welche Nummern vergeben sind.
    """
    order = db.query(Order).filter(Order.no == no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    is_staff = user.role in (Role.staff, Role.admin)
    if not is_staff and order.user_id != user.id:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    positions_out = []
    for p in order.positions:
        base = {
            "id": p.id,
            "kind": p.kind,
            "label": p.label,
            "mat": p.mat,
            "thk": p.thk,
            "qty": p.qty,
            "od": p.od,
            "di": p.di,
            "production_status": p.production_status,
            "mat_cost": p.mat_cost,
            "cut_cost": p.cut_cost,
        }
        if is_staff:
            base["desc"] = p.note or ""
            base["external_note"] = getattr(p, "external_note", "") or ""
            base["shape_id"] = p.shape_id
        else:
            # Kunde sieht nur den externen Hinweis, nie die interne Beschreibung
            base["external_note"] = getattr(p, "external_note", "") or ""
            if p.kind == "custom" and base["external_note"]:
                base["desc"] = base["external_note"]
        positions_out.append(base)
    return {
        "no": order.no,
        "created_at": order.created_at,
        "customer_ref": order.customer_ref,
        "cert": order.cert,
        "net": order.net,
        "vat": order.vat,
        "gross": order.gross,
        "blocked": order.blocked,
        "stage": order.stage,
        "engine_version": order.engine_version,
        "ship_address": order.ship_address,
        "bill_address": order.bill_address,
        "tax_status": order.tax_status,
        "price_breakdown": order.price_breakdown,
        "due_date": order.due_date,
        "rush": order.rush,
        "paid": order.paid,
        "paid_at": order.paid_at,
        "payment_method": order.payment_method,
        "positions": positions_out,
        # Wo die Positionen dieses Auftrags gerade liegen: Innenauftrag, Platte,
        # Marke. Ohne diesen Verweis war der Fertigungsstatus ein Wort ohne
        # Bezug — „eingeplant", aber nirgends nachschlagbar wo.
        "production": trace.order_trace(db, order),
    }


@router.post("/orders/{no}/reorder", response_model=OrderOut,
             status_code=status.HTTP_201_CREATED)
def reorder(no: str, db: Annotated[Session, Depends(get_db)],
            user: Annotated[User, Depends(current_user)]) -> OrderOut:
    """Nachbestellen in einem Klick (Wiederverkäufer-Pipeline): legt aus den
    Positionen eines eigenen Auftrags einen neuen Auftrag mit frischer
    Kalkulation an — Geometrien bleiben im System (der Burggraben), der Kunde
    tippt nichts erneut. Preis, Platte und Engine-Version werden neu
    eingefroren; Adressen/Steuerstatus werden übernommen."""
    from ..schemas import QuoteLine

    src = db.query(Order).filter(Order.no == no).first()
    if not src:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    is_staff = user.role in (Role.staff, Role.admin)
    if not is_staff and src.user_id != user.id:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    lines = []
    for i, p in enumerate(src.positions, start=1):
        lines.append(QuoteLine(id=i, kind=p.kind or "gasket", mat=p.mat,
                               q=max(1, int(p.qty or 1)), thk=float(p.thk or 0),
                               label=p.label or "", od=float(p.od or 0),
                               di=float(p.di or 0), bn=int(p.bolt_count or 0),
                               bd=float(p.bolt_d or 0), bc=float(p.bolt_circle or 0),
                               cut_len=float(p.cut_len or 0),
                               fmt=list(p.fmt) if p.fmt else None,
                               desc=p.note or "",
                               external_note=getattr(p, "external_note", "") or "",
                               price_gross=float(p.price_gross or 0.0),
                               shape=p.shape, shape_id=p.shape_id))
    order = place_order(
        db, lines=lines, cert=src.cert or "2.2",
        ship_address=dict(src.ship_address or {}),
        bill_address=dict(src.bill_address or {}),
        tax_status=dict(src.tax_status or {"rate": 0.19, "type": "domestic"}),
        customer_ref=f"Nachbestellung zu {src.no}", user=user)
    db.add(AuditLog(actor=user.email, action="order_reorder", entity="order", entity_id=order.no,
                    detail={"reorder_of": src.no, "gross": order.gross}))
    db.commit()
    bus.publish("order_created", {"order_no": order.no, "net": order.net,
                                  "gross": order.gross, "paid": order.paid,
                                  "blocked": order.blocked,
                                  "reorder_of": src.no})
    return OrderOut(no=order.no, net=order.net, vat=order.vat, gross=order.gross,
                    blocked=order.blocked, engine_version=order.engine_version,
                    n_positions=len(order.positions))
