"""Supply-Chain-Management-API: Auto-Lieferant, Smart-Lager (MRP), Einkauf,
Wareneingang, Chargenrückverfolgung (EN 10204), Ausschuss und Warnungen."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import (
    AuditLog,
    FactoryStation,
    GoodsReceipt,
    MailMessage,
    MaterialLot,
    Product,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    ScrapEvent,
    StationDowntime,
    StockLocation,
    Supplier,
    SupplierMaterial,
    SupplyAlert,
    User,
)
from ..security import require_staff, require_worker
from ..services import floor_view, scm_analytics, smtp_client
from ..services.inventory import move_stock
from ..services.numbering import next_number

router = APIRouter(prefix="/api/scm", tags=["scm"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(raw: str | None) -> datetime | None:
    if not raw or not str(raw).strip():
        return None
    txt = str(raw).strip()
    try:
        if len(txt) == 10:
            return datetime.fromisoformat(txt + "T12:00:00+00:00")
        dt = datetime.fromisoformat(txt.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise HTTPException(422, f"Ungültiges Datum: {txt}") from exc


def _supplier_out(db: Session, s: Supplier, rel: dict | None = None) -> dict:
    r = rel or scm_analytics.supplier_reliability(db, s)
    n_mats = (
        db.query(SupplierMaterial)
        .filter(SupplierMaterial.supplier_id == s.id, SupplierMaterial.active.is_(True))
        .count()
    )
    return {
        "id": s.id,
        "code": s.code,
        "name": s.name,
        "email": s.email,
        "phone": s.phone,
        "country": s.country,
        "city": s.city,
        "region": s.region,
        "currency": s.currency,
        "payment_terms": s.payment_terms,
        "incoterms": s.incoterms,
        "default_lead_days": s.default_lead_days,
        "reliability_override": s.reliability_override,
        "reliability": r["score"],
        "completed_pos": r["completed_pos"],
        "on_time_pos": r["on_time_pos"],
        "open_pos": r["open_pos"],
        "overdue_pos": r["overdue_pos"],
        "material_count": n_mats,
        "active": s.active,
        "office_note": s.office_note or "",
    }


def _po_out(db: Session, po: PurchaseOrder, sup_map: dict[int, Supplier], prod_map: dict[str, Product]) -> dict:
    sup = sup_map.get(po.supplier_id)
    now = _now()
    eta = scm_analytics._aware(po.confirmed_eta or po.requested_eta)
    overdue = bool(
        po.status in scm_analytics.COMMITTED_PO_STATUSES and eta is not None and eta < now
    )
    return {
        "id": po.id,
        "no": po.no,
        "supplier_id": po.supplier_id,
        "supplier_code": sup.code if sup else "",
        "supplier_name": sup.name if sup else f"#{po.supplier_id}",
        "supplier_email": sup.email if sup else "",
        "status": po.status.value,
        "currency": po.currency,
        "order_date": po.order_date.isoformat() if po.order_date else None,
        "requested_eta": po.requested_eta.isoformat() if po.requested_eta else None,
        "confirmed_eta": po.confirmed_eta.isoformat() if po.confirmed_eta else None,
        "received_at": po.received_at.isoformat() if po.received_at else None,
        "overdue": overdue,
        "total_net": round(float(po.total_net or 0.0), 2),
        "note": po.note or "",
        "created_by": po.created_by,
        "lines": [
            {
                "id": ln.id,
                "product_id": ln.product_id,
                "product_name": prod_map[ln.product_id].name if ln.product_id in prod_map else ln.product_id,
                "thk": ln.thk,
                "sheet_w": ln.sheet_w,
                "sheet_h": ln.sheet_h,
                "qty_ordered": ln.qty_ordered,
                "qty_received": ln.qty_received,
                "qty_open": max(0, int(ln.qty_ordered or 0) - int(ln.qty_received or 0)),
                "unit_price_eur": ln.unit_price_eur,
                "line_net": round(int(ln.qty_ordered or 0) * float(ln.unit_price_eur or 0.0), 2),
                "note": ln.note or "",
            }
            for ln in po.lines
        ],
    }


# --------------------------------------------------------------------------
# Smart-Lager & Auto-Lieferant
# --------------------------------------------------------------------------
@router.get("/smart-stock", dependencies=[Depends(require_staff)])
def get_smart_stock(
    db: Annotated[Session, Depends(get_db)],
    include_inactive: bool = False,
) -> dict:
    """MRP-Übersicht über alle Werkstoffe inkl. Reichweite, ABC-Klasse und Auto-Lieferant."""
    return scm_analytics.compute_smart_inventory(db, include_inactive=include_inactive)


@router.get("/auto-supplier/{product_id}", dependencies=[Depends(require_staff)])
def get_auto_supplier(
    product_id: str,
    db: Annotated[Session, Depends(get_db)],
    thk: float = Query(default=0.0, ge=0),
    qty: int = Query(default=2, ge=1, le=100_000),
    urgent: bool = False,
) -> dict:
    """Liefert das transparente Lieferanten-Ranking für einen Werkstoff."""
    prod = db.get(Product, product_id)
    if prod is None:
        raise HTTPException(404, "Werkstoff nicht gefunden.")
    ranked = scm_analytics.rank_suppliers_for_product(db, prod, thk=thk, qty_needed=qty, urgent=urgent)
    return {
        "product_id": prod.id,
        "product_name": prod.name,
        "preferred_supplier_id": getattr(prod, "preferred_supplier_id", None),
        "auto_reorder": getattr(prod, "auto_reorder", "propose"),
        "recommended": ranked[0] if ranked else None,
        "candidates": ranked,
    }


class QuickAutoOrderIn(BaseModel):
    supplier_id: Optional[int] = None
    thk: float = Field(default=2.0, gt=0, le=500)
    qty: int = Field(default=0, ge=0, le=100_000)
    urgent: bool = False
    mode: Literal["propose", "order"] = "propose"
    create_mail_draft: bool = True
    note: str = Field(default="", max_length=300)


@router.post("/auto-supplier/{product_id}/order")
def create_auto_supplier_order(
    product_id: str,
    body: QuickAutoOrderIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Wählt den besten (oder angegebenen) Lieferanten und legt sofort Vorschlag/Bestellung an."""
    prod = db.get(Product, product_id)
    if prod is None:
        raise HTTPException(404, "Werkstoff nicht gefunden.")
    ranked = scm_analytics.rank_suppliers_for_product(
        db, prod, thk=body.thk, qty_needed=max(1, body.qty or 2), urgent=body.urgent
    )
    if not ranked:
        raise HTTPException(422, "Für diesen Werkstoff ist noch kein aktiver Lieferant hinterlegt.")
    chosen = (
        next((r for r in ranked if r["supplier_id"] == body.supplier_id), None)
        if body.supplier_id
        else ranked[0]
    )
    if chosen is None:
        raise HTTPException(404, "Gewählter Lieferant führt diesen Werkstoff nicht aktiv.")

    sup = db.get(Supplier, int(chosen["supplier_id"]))
    if sup is None:
        raise HTTPException(404, "Lieferant nicht gefunden.")

    qty = max(int(body.qty or chosen["order_qty"]), int(chosen["moq_sheets"] or 1))
    uprice = float(chosen["plate_eur"])
    now = _now()
    eta = now + timedelta(days=int(chosen["lead_days"]))
    po_status = PurchaseOrderStatus.ordered if body.mode == "order" else PurchaseOrderStatus.proposed
    po = PurchaseOrder(
        no=next_number(db, "purchase_order", "BE-"),
        supplier_id=sup.id,
        status=po_status,
        currency=sup.currency or "EUR",
        order_date=now,
        requested_eta=eta,
        total_net=round(qty * uprice, 2),
        note=body.note.strip() or f"Auto-Lieferant ({chosen['score']} Pkt.): {chosen['reason']}"[:280],
        created_by=actor.email,
    )
    db.add(po)
    db.flush()
    ln = PurchaseOrderLine(
        purchase_order_id=po.id,
        product_id=prod.id,
        thk=body.thk,
        sheet_w=float(chosen["sheet_w"]),
        sheet_h=float(chosen["sheet_h"]),
        qty_ordered=qty,
        qty_received=0,
        unit_price_eur=uprice,
        requested_eta=eta,
        note=chosen["reason"][:290],
    )
    db.add(ln)
    db.flush()

    mail_draft_id = None
    if body.create_mail_draft and sup.email:
        subj, txt = scm_analytics.build_po_email_text(po, sup, [(ln, prod.name)])
        m = MailMessage(
            direction="draft",
            folder="drafts",
            status="draft",
            to_addrs=[sup.email],
            subject=subj,
            body_text=txt,
            ai_drafted=True,
            purchase_order_no=po.no,
            supplier_id=sup.id,
            thread_key=f"po:{po.no}",
            actor=actor.email,
        )
        db.add(m)
        db.flush()
        mail_draft_id = m.id

    db.add(
        AuditLog(
            actor=actor.email,
            action="po_create_auto",
            entity="purchase_order",
            entity_id=po.no,
            detail={"product_id": prod.id, "supplier": sup.code, "qty": qty, "status": po_status.value},
        )
    )
    scm_analytics.refresh_alerts(db, now=now)
    db.commit()
    db.refresh(po)
    return {
        "purchase_order": _po_out(db, po, {sup.id: sup}, {prod.id: prod}),
        "chosen_supplier": chosen,
        "mail_draft_id": mail_draft_id,
    }


class ReplenishRunIn(BaseModel):
    dry_run: bool = False
    force_order: bool = False
    product_ids: Optional[list[str]] = None


@router.post("/replenish/run")
def run_replenish(
    body: ReplenishRunIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Prüft alle unterdeckten Werkstoffe und erzeugt gebündelte Bestellvorschläge / Bestellungen."""
    return scm_analytics.run_auto_replenishment(
        db,
        actor=actor.email,
        dry_run=body.dry_run,
        product_ids=body.product_ids,
        force_order=body.force_order,
    )


# --------------------------------------------------------------------------
# Lieferanten & Bezugsquellen (Lieferant ↔ Werkstoff)
# --------------------------------------------------------------------------
class SupplierIn(BaseModel):
    code: str = Field(min_length=2, max_length=40)
    name: str = Field(min_length=2, max_length=160)
    email: str = Field(default="", max_length=254)
    phone: str = Field(default="", max_length=80)
    country: str = Field(default="DE", max_length=4)
    city: str = Field(default="", max_length=120)
    currency: str = Field(default="EUR", max_length=10)
    payment_terms: str = Field(default="30 Tage netto", max_length=80)
    incoterms: str = Field(default="DAP", max_length=40)
    default_lead_days: int = Field(default=7, ge=1, le=365)
    reliability_override: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    active: bool = True
    office_note: str = Field(default="", max_length=1000)


class SupplierPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=160)
    email: Optional[str] = Field(default=None, max_length=254)
    phone: Optional[str] = Field(default=None, max_length=80)
    country: Optional[str] = Field(default=None, max_length=4)
    city: Optional[str] = Field(default=None, max_length=120)
    currency: Optional[str] = Field(default=None, max_length=10)
    payment_terms: Optional[str] = Field(default=None, max_length=80)
    incoterms: Optional[str] = Field(default=None, max_length=40)
    default_lead_days: Optional[int] = Field(default=None, ge=1, le=365)
    reliability_override: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    active: Optional[bool] = None
    office_note: Optional[str] = Field(default=None, max_length=1000)


@router.get("/suppliers", dependencies=[Depends(require_staff)])
def list_suppliers(
    db: Annotated[Session, Depends(get_db)],
    include_inactive: bool = False,
) -> list[dict]:
    q = db.query(Supplier)
    if not include_inactive:
        q = q.filter(Supplier.active.is_(True))
    rows = q.order_by(Supplier.name).all()
    all_pos = db.query(PurchaseOrder).all()
    pos_by_sup: dict[int, list[PurchaseOrder]] = {}
    for po in all_pos:
        pos_by_sup.setdefault(po.supplier_id, []).append(po)
    return [_supplier_out(db, s, scm_analytics.supplier_reliability(db, s, pos_by_sup.get(s.id, []))) for s in rows]


@router.post("/suppliers", status_code=status.HTTP_201_CREATED)
def create_supplier(
    body: SupplierIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    code = body.code.strip().upper()
    if db.query(Supplier).filter(Supplier.code == code).first():
        raise HTTPException(409, f"Lieferantencode {code} existiert bereits.")
    row = Supplier(
        code=code,
        name=body.name.strip(),
        email=body.email.strip(),
        phone=body.phone.strip(),
        country=body.country.strip().upper() or "DE",
        city=body.city.strip(),
        currency=body.currency.strip().upper() or "EUR",
        payment_terms=body.payment_terms.strip(),
        incoterms=body.incoterms.strip(),
        default_lead_days=body.default_lead_days,
        reliability_override=body.reliability_override,
        active=body.active,
        office_note=body.office_note.strip(),
    )
    db.add(row)
    db.flush()
    db.add(AuditLog(actor=actor.email, action="supplier_create", entity="supplier", entity_id=str(row.id), detail={"code": code, "name": row.name}))
    db.commit()
    db.refresh(row)
    return _supplier_out(db, row)


@router.patch("/suppliers/{supplier_id}")
def update_supplier(
    supplier_id: int,
    body: SupplierPatch,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    row = db.get(Supplier, supplier_id)
    if row is None:
        raise HTTPException(404, "Lieferant nicht gefunden.")
    patch = body.model_dump(exclude_unset=True)
    for k, v in patch.items():
        if isinstance(v, str):
            v = v.strip()
        setattr(row, k, v)
    db.add(AuditLog(actor=actor.email, action="supplier_update", entity="supplier", entity_id=str(row.id), detail={"fields": sorted(patch.keys())}))
    db.commit()
    db.refresh(row)
    return _supplier_out(db, row)


class SupplierMaterialIn(BaseModel):
    supplier_id: int
    product_id: str = Field(min_length=1, max_length=60)
    thk: float = Field(default=0.0, ge=0, le=500)
    supplier_sku: str = Field(default="", max_length=80)
    sheet_w: float = Field(default=1500.0, ge=0, le=20_000)
    sheet_h: float = Field(default=1000.0, ge=0, le=20_000)
    unit_eur_m2: float = Field(default=0.0, ge=0, le=100_000)
    moq_sheets: int = Field(default=1, ge=1, le=100_000)
    quoted_lead_days: int = Field(default=7, ge=1, le=365)
    preferred_rank: int = Field(default=1, ge=1, le=20)
    active: bool = True


@router.get("/supplier-materials", dependencies=[Depends(require_staff)])
def list_supplier_materials(
    db: Annotated[Session, Depends(get_db)],
    product_id: Optional[str] = None,
    supplier_id: Optional[int] = None,
) -> list[dict]:
    q = db.query(SupplierMaterial)
    if product_id:
        q = q.filter(SupplierMaterial.product_id == product_id)
    if supplier_id is not None:
        q = q.filter(SupplierMaterial.supplier_id == supplier_id)
    rows = q.order_by(SupplierMaterial.product_id, SupplierMaterial.preferred_rank).all()
    sups = {s.id: s for s in db.query(Supplier).all()}
    prods = {p.id: p for p in db.query(Product).all()}
    return [
        {
            "id": r.id,
            "supplier_id": r.supplier_id,
            "supplier_code": sups[r.supplier_id].code if r.supplier_id in sups else "",
            "supplier_name": sups[r.supplier_id].name if r.supplier_id in sups else f"#{r.supplier_id}",
            "product_id": r.product_id,
            "product_name": prods[r.product_id].name if r.product_id in prods else r.product_id,
            "thk": r.thk,
            "supplier_sku": r.supplier_sku,
            "sheet_w": r.sheet_w,
            "sheet_h": r.sheet_h,
            "unit_eur_m2": r.unit_eur_m2,
            "moq_sheets": r.moq_sheets,
            "quoted_lead_days": r.quoted_lead_days,
            "preferred_rank": r.preferred_rank,
            "active": r.active,
        }
        for r in rows
    ]


@router.post("/supplier-materials", status_code=status.HTTP_201_CREATED)
def upsert_supplier_material(
    body: SupplierMaterialIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    sup = db.get(Supplier, body.supplier_id)
    if sup is None:
        raise HTTPException(404, "Lieferant nicht gefunden.")
    prod = db.get(Product, body.product_id)
    if prod is None:
        raise HTTPException(404, "Werkstoff nicht gefunden.")
    existing = (
        db.query(SupplierMaterial)
        .filter(
            SupplierMaterial.supplier_id == body.supplier_id,
            SupplierMaterial.product_id == body.product_id,
            SupplierMaterial.thk == body.thk,
        )
        .first()
    )
    if existing is not None:
        for k, v in body.model_dump().items():
            setattr(existing, k, v)
        row = existing
        action = "supplier_material_update"
    else:
        row = SupplierMaterial(**body.model_dump())
        db.add(row)
        db.flush()
        action = "supplier_material_create"
    db.add(
        AuditLog(
            actor=actor.email,
            action=action,
            entity="supplier_material",
            entity_id=str(row.id),
            detail={"supplier": sup.code, "product_id": prod.id, "unit_eur_m2": row.unit_eur_m2},
        )
    )
    scm_analytics.refresh_alerts(db)
    db.commit()
    db.refresh(row)
    return {
        "id": row.id,
        "supplier_id": row.supplier_id,
        "supplier_name": sup.name,
        "product_id": row.product_id,
        "product_name": prod.name,
        "thk": row.thk,
        "unit_eur_m2": row.unit_eur_m2,
        "moq_sheets": row.moq_sheets,
        "quoted_lead_days": row.quoted_lead_days,
        "preferred_rank": row.preferred_rank,
        "active": row.active,
    }


@router.delete("/supplier-materials/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_supplier_material(
    link_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> None:
    row = db.get(SupplierMaterial, link_id)
    if row is None:
        raise HTTPException(404, "Zuordnung nicht gefunden.")
    db.delete(row)
    db.add(AuditLog(actor=actor.email, action="supplier_material_delete", entity="supplier_material", entity_id=str(link_id)))
    db.commit()


# --------------------------------------------------------------------------
# Einkaufsbestellungen & Wareneingang
# --------------------------------------------------------------------------
class POLineIn(BaseModel):
    product_id: str
    thk: float = 2.0
    sheet_w: float = 1500.0
    sheet_h: float = 1000.0
    qty_ordered: int = Field(default=1, ge=1, le=100_000)
    unit_price_eur: float = Field(default=0.0, ge=0)
    note: str = Field(default="", max_length=300)


class PurchaseOrderIn(BaseModel):
    supplier_id: int
    status: PurchaseOrderStatus = PurchaseOrderStatus.ordered
    requested_eta: Optional[str] = None
    note: str = Field(default="", max_length=500)
    lines: list[POLineIn] = Field(min_length=1)


class PurchaseOrderPatch(BaseModel):
    status: Optional[PurchaseOrderStatus] = None
    requested_eta: Optional[str] = None
    confirmed_eta: Optional[str] = None
    note: Optional[str] = Field(default=None, max_length=500)


@router.get("/purchase-orders", dependencies=[Depends(require_staff)])
def list_purchase_orders(
    db: Annotated[Session, Depends(get_db)],
    status_filter: Optional[str] = Query(default=None, alias="status"),
    limit: int = Query(default=200, ge=1, le=500),
) -> list[dict]:
    q = db.query(PurchaseOrder)
    if status_filter:
        wanted = [s.strip() for s in status_filter.split(",") if s.strip()]
        enums = [PurchaseOrderStatus(s) for s in wanted if s in PurchaseOrderStatus._value2member_map_]
        if enums:
            q = q.filter(PurchaseOrder.status.in_(enums))
    rows = q.order_by(PurchaseOrder.id.desc()).limit(limit).all()
    sups = {s.id: s for s in db.query(Supplier).all()}
    prods = {p.id: p for p in db.query(Product).all()}
    return [_po_out(db, po, sups, prods) for po in rows]


@router.post("/purchase-orders", status_code=status.HTTP_201_CREATED)
def create_purchase_order(
    body: PurchaseOrderIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    sup = db.get(Supplier, body.supplier_id)
    if sup is None:
        raise HTTPException(404, "Lieferant nicht gefunden.")
    eta = _parse_iso(body.requested_eta) or (_now() + timedelta(days=int(sup.default_lead_days or 7)))
    po = PurchaseOrder(
        no=next_number(db, "purchase_order", "BE-"),
        supplier_id=sup.id,
        status=body.status,
        currency=sup.currency or "EUR",
        order_date=_now(),
        requested_eta=eta,
        total_net=0.0,
        note=body.note.strip(),
        created_by=actor.email,
    )
    db.add(po)
    db.flush()

    total_net = 0.0
    prods: dict[str, Product] = {}
    for ln_in in body.lines:
        prod = db.get(Product, ln_in.product_id)
        if prod is None:
            raise HTTPException(404, f"Werkstoff {ln_in.product_id} nicht gefunden.")
        prods[prod.id] = prod
        ln = PurchaseOrderLine(
            purchase_order_id=po.id,
            product_id=prod.id,
            thk=ln_in.thk,
            sheet_w=ln_in.sheet_w,
            sheet_h=ln_in.sheet_h,
            qty_ordered=ln_in.qty_ordered,
            qty_received=0,
            unit_price_eur=ln_in.unit_price_eur,
            requested_eta=eta,
            note=ln_in.note.strip(),
        )
        db.add(ln)
        total_net += ln_in.qty_ordered * ln_in.unit_price_eur
    po.total_net = round(total_net, 2)
    db.add(AuditLog(actor=actor.email, action="po_create", entity="purchase_order", entity_id=po.no, detail={"supplier": sup.code, "total_net": po.total_net}))
    scm_analytics.refresh_alerts(db)
    db.commit()
    db.refresh(po)
    return _po_out(db, po, {sup.id: sup}, prods)


@router.patch("/purchase-orders/{po_no}")
def update_purchase_order(
    po_no: str,
    body: PurchaseOrderPatch,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    po = db.query(PurchaseOrder).filter(PurchaseOrder.no == po_no).first()
    if po is None:
        raise HTTPException(404, "Bestellung nicht gefunden.")
    if body.status is not None:
        po.status = body.status
    if body.requested_eta is not None:
        po.requested_eta = _parse_iso(body.requested_eta)
    if body.confirmed_eta is not None:
        po.confirmed_eta = _parse_iso(body.confirmed_eta)
    if body.note is not None:
        po.note = body.note.strip()
    db.add(AuditLog(actor=actor.email, action="po_update", entity="purchase_order", entity_id=po.no, detail={"status": po.status.value}))
    scm_analytics.refresh_alerts(db)
    db.commit()
    db.refresh(po)
    sups = {s.id: s for s in db.query(Supplier).all()}
    prods = {p.id: p for p in db.query(Product).all()}
    return _po_out(db, po, sups, prods)


@router.post("/purchase-orders/{po_no}/send-mail")
def send_purchase_order_mail(
    po_no: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Erzeugt und versendet das Bestellschreiben an den Lieferanten (und setzt proposed → ordered)."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.no == po_no).first()
    if po is None:
        raise HTTPException(404, "Bestellung nicht gefunden.")
    sup = db.get(Supplier, po.supplier_id)
    if sup is None or not sup.email:
        raise HTTPException(422, "Am Lieferanten ist keine E-Mail-Adresse hinterlegt.")
    prods = {p.id: p for p in db.query(Product).all()}
    lines = [(ln, prods[ln.product_id].name if ln.product_id in prods else ln.product_id) for ln in po.lines]
    subject, body_text = scm_analytics.build_po_email_text(po, sup, lines)

    cfg = smtp_client.config()
    sent_live = False
    if cfg.configured and not cfg.silent:
        sent_live = smtp_client.send(to=[sup.email], subject=subject, text=body_text, background=False)
        mode = "smtp" if sent_live else "failed"
    else:
        sent_live = True
        mode = "silent"

    now = _now()
    if po.status in (PurchaseOrderStatus.draft, PurchaseOrderStatus.proposed):
        po.status = PurchaseOrderStatus.ordered

    mail = MailMessage(
        direction="outbound",
        folder="sent",
        status="sent" if sent_live else "failed",
        from_addr=cfg.sender or actor.email,
        to_addrs=[sup.email],
        subject=subject,
        body_text=body_text,
        purchase_order_no=po.no,
        supplier_id=sup.id,
        thread_key=f"po:{po.no}",
        delivery_mode=mode,
        actor=actor.email,
        sent_at=now,
    )
    db.add(mail)
    db.add(AuditLog(actor=actor.email, action="po_mail_sent", entity="purchase_order", entity_id=po.no, detail={"to": sup.email, "mode": mode}))
    db.commit()
    db.refresh(mail)
    return {"ok": sent_live, "mode": mode, "mail_id": mail.id, "po_status": po.status.value}


class GoodsReceiptIn(BaseModel):
    delivery_note_no: str = Field(default="", max_length=80)
    cert_type: str = Field(default="3.1", max_length=10)
    cert_ref: str = Field(default="", max_length=120)
    supplier_batch: str = Field(default="", max_length=80)
    station_id: Optional[int] = None
    bin: str = Field(default="Wareneingang", max_length=80)
    note: str = Field(default="", max_length=400)
    #: Optionale Teilmengen {line_id: qty}; leer = alle offenen Restmengen vereinnahmen.
    line_quantities: Optional[dict[str, int]] = None


@router.post("/purchase-orders/{po_no}/receive")
def receive_purchase_order(
    po_no: str,
    body: GoodsReceiptIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Bucht den Wareneingang: Lieferschein, Chargen (EN 10204), Lagerbewegung und Lagerort in einer Transaktion."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.no == po_no).first()
    if po is None:
        raise HTTPException(404, "Bestellung nicht gefunden.")
    if po.status == PurchaseOrderStatus.cancelled:
        raise HTTPException(409, "Stornierte Bestellung kann nicht vereinnahmt werden.")
    if po.status == PurchaseOrderStatus.received:
        raise HTTPException(409, "Bestellung ist bereits vollständig vereinnahmt.")

    storage_id = body.station_id
    if storage_id is None:
        st = db.query(FactoryStation).filter(FactoryStation.is_storage.is_(True)).first()
        storage_id = st.id if st else None

    now = _now()
    gr = GoodsReceipt(
        no=next_number(db, "goods_receipt", "WE-"),
        purchase_order_id=po.id,
        supplier_id=po.supplier_id,
        delivery_note_no=body.delivery_note_no.strip(),
        received_at=now,
        received_by=actor.email,
        station_id=storage_id,
        note=body.note.strip(),
    )
    db.add(gr)
    db.flush()

    created_lots: list[str] = []
    total_received_now = 0

    for ln in po.lines:
        rem = max(0, int(ln.qty_ordered or 0) - int(ln.qty_received or 0))
        if rem <= 0:
            continue
        take = rem
        if body.line_quantities is not None and str(ln.id) in body.line_quantities:
            take = max(0, min(rem, int(body.line_quantities[str(ln.id)])))
        if take <= 0:
            continue

        prod = db.get(Product, ln.product_id)
        if prod is None:
            continue

        area_m2 = max(0.01, (float(ln.sheet_w or 1500) * float(ln.sheet_h or 1000)) / 1_000_000.0)
        lot = MaterialLot(
            code=next_number(db, "material_lot", "CH-"),
            product_id=prod.id,
            thk=ln.thk,
            sheet_w=ln.sheet_w,
            sheet_h=ln.sheet_h,
            supplier_id=po.supplier_id,
            purchase_order_no=po.no,
            goods_receipt_id=gr.id,
            supplier_batch=body.supplier_batch.strip() or f"B-{gr.no[-4:]}",
            cert_type=body.cert_type.strip(),
            cert_ref=body.cert_ref.strip(),
            qty_initial=take,
            qty_remaining=take,
            unit_eur_m2=round(float(ln.unit_price_eur or 0.0) / area_m2, 2),
            station_id=storage_id,
            bin=body.bin.strip(),
            status="available",
            received_at=now,
            created_by=actor.email,
            note=body.note.strip(),
        )
        db.add(lot)
        db.flush()
        created_lots.append(lot.code)

        ln.qty_received = int(ln.qty_received or 0) + take
        total_received_now += take

        move_stock(
            db,
            prod,
            take,
            reason="einkauf",
            actor=actor.email,
            note=f"Wareneingang {gr.no} zu {po.no}" + (f" · LS {gr.delivery_note_no}" if gr.delivery_note_no else ""),
            thk=ln.thk,
            lot_id=lot.id,
            purchase_order_no=po.no,
        )

        # Lagerort fortschreiben, falls Lagerstation bekannt
        if storage_id is not None:
            loc = (
                db.query(StockLocation)
                .filter(
                    StockLocation.product_id == prod.id,
                    StockLocation.station_id == storage_id,
                    StockLocation.bin == body.bin.strip(),
                )
                .first()
            )
            if loc is None:
                db.add(
                    StockLocation(
                        product_id=prod.id,
                        thk=ln.thk,
                        station_id=storage_id,
                        bin=body.bin.strip(),
                        qty=take,
                        updated_by=actor.email,
                    )
                )
            else:
                loc.qty = int(loc.qty or 0) + take
                loc.updated_by = actor.email

    if total_received_now == 0:
        raise HTTPException(422, "Keine offenen Mengen zur Vereinnahmung gewählt.")

    all_done = all(int(ln.qty_received or 0) >= int(ln.qty_ordered or 0) for ln in po.lines)
    po.status = PurchaseOrderStatus.received if all_done else PurchaseOrderStatus.partial
    if all_done:
        po.received_at = now

    db.add(
        AuditLog(
            actor=actor.email,
            action="po_receive",
            entity="purchase_order",
            entity_id=po.no,
            detail={"goods_receipt": gr.no, "qty": total_received_now, "lots": created_lots},
        )
    )
    scm_analytics.refresh_alerts(db, now=now)
    db.commit()
    return {
        "goods_receipt_no": gr.no,
        "po_no": po.no,
        "po_status": po.status.value,
        "qty_received": total_received_now,
        "lots": created_lots,
    }


# --------------------------------------------------------------------------
# Chargen, Warnungen & Ausschuss (für Lager + Smarter Laufschein)
# --------------------------------------------------------------------------
@router.get("/lots")
def list_lots(
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
    product_id: Optional[str] = None,
    status_filter: Optional[str] = Query(default=None, alias="status"),
) -> list[dict]:
    office = floor_view.is_office(actor)
    q = db.query(MaterialLot)
    if product_id:
        q = q.filter(MaterialLot.product_id == product_id)
    if status_filter:
        q = q.filter(MaterialLot.status == status_filter)
    rows = q.order_by(MaterialLot.id.desc()).limit(300).all()
    sups = {s.id: s for s in db.query(Supplier).all()}
    sts = {s.id: s.label for s in db.query(FactoryStation).all()}
    return [
        {
            "id": r.id,
            "code": r.code,
            "product_id": r.product_id,
            "thk": r.thk,
            "sheet_w": r.sheet_w,
            "sheet_h": r.sheet_h,
            "supplier_name": (sups[r.supplier_id].name if (office and r.supplier_id in sups) else ""),
            "purchase_order_no": r.purchase_order_no if office else "",
            "supplier_batch": r.supplier_batch,
            "cert_type": r.cert_type,
            "cert_ref": r.cert_ref,
            "qty_initial": r.qty_initial,
            "qty_remaining": r.qty_remaining,
            "unit_eur_m2": r.unit_eur_m2 if office else 0.0,
            "station_label": sts.get(r.station_id, ""),
            "bin": r.bin,
            "status": r.status,
            "received_at": r.received_at.isoformat() if r.received_at else None,
        }
        for r in rows
    ]


@router.get("/alerts", dependencies=[Depends(require_staff)])
def list_alerts(
    db: Annotated[Session, Depends(get_db)],
    refresh: bool = True,
) -> list[dict]:
    if refresh:
        scm_analytics.refresh_alerts(db)
        db.commit()
    rows = (
        db.query(SupplyAlert)
        .filter(SupplyAlert.status.in_(("open", "acknowledged")))
        .order_by(SupplyAlert.id.desc())
        .all()
    )
    return [
        {
            "id": r.id,
            "dedup_key": r.dedup_key,
            "kind": r.kind,
            "severity": r.severity,
            "title": r.title,
            "detail": r.detail,
            "metric": r.metric,
            "entity_type": r.entity_type,
            "entity_id": r.entity_id,
            "product_id": r.product_id,
            "status": r.status,
            "last_seen_at": r.last_seen_at.isoformat() if r.last_seen_at else None,
        }
        for r in rows
    ]


class AlertActionIn(BaseModel):
    status: Literal["acknowledged", "resolved"]


@router.post("/alerts/{alert_id}/status")
def set_alert_status(
    alert_id: int,
    body: AlertActionIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    row = db.get(SupplyAlert, alert_id)
    if row is None:
        raise HTTPException(404, "Warnung nicht gefunden.")
    row.status = body.status
    if body.status == "resolved":
        row.resolved_at = _now()
        row.resolved_by = actor.email
    db.add(AuditLog(actor=actor.email, action="supply_alert_status", entity="supply_alert", entity_id=str(row.id), detail={"status": body.status}))
    db.commit()
    return {"id": row.id, "status": row.status}


class ScrapIn(BaseModel):
    work_order_no: str = Field(default="", max_length=30)
    plate_id: Optional[int] = None
    station_id: Optional[int] = None
    product_id: Optional[str] = None
    thk: float = 0.0
    lot_id: Optional[int] = None
    qty_parts: int = Field(default=1, ge=1, le=100_000)
    area_m2: float = Field(default=0.05, ge=0)
    reason: str = Field(default="schnittfehler", max_length=30)
    note: str = Field(default="", max_length=400)


@router.post("/scrap", status_code=status.HTTP_201_CREATED)
def record_scrap(
    body: ScrapIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    """Erfasst Ausschuss aus Werkstatt, Station oder digitalem Laufschein."""
    ev = ScrapEvent(
        work_order_no=body.work_order_no.strip(),
        plate_id=body.plate_id,
        station_id=body.station_id,
        product_id=body.product_id,
        thk=body.thk,
        lot_id=body.lot_id,
        qty_parts=body.qty_parts,
        area_m2=body.area_m2,
        reason=body.reason.strip() or "sonstiges",
        note=body.note.strip(),
        recorded_by=actor.email,
    )
    db.add(ev)
    db.flush()
    db.add(
        AuditLog(
            actor=actor.email,
            action="scrap_record",
            entity="scrap_event",
            entity_id=str(ev.id),
            detail={"work_order_no": ev.work_order_no, "qty_parts": ev.qty_parts, "reason": ev.reason},
        )
    )
    db.commit()
    return {"id": ev.id, "work_order_no": ev.work_order_no, "qty_parts": ev.qty_parts, "reason": ev.reason}
