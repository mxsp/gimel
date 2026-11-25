"""Lieferketten-Analytik, Auto-Lieferantenauswahl und Smart-Lagermanagement (MRP).

Bewertet Lieferanten je Werkstoff transparent nach Preis, Lieferzeit,
Zuverlässigkeit und Mindestbestellmenge (MOQ), berechnet Nettobedarf,
Reichweite sowie ABC-Klassen und erzeugt bei Unterdeckung Bestellvorschläge
oder automatische Bestellungen samt E-Mail-Entwurf.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import (
    AuditLog,
    FactoryStation,
    MailMessage,
    MaterialLot,
    Offcut,
    Order,
    OrderPosition,
    Product,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    ScrapEvent,
    StationDowntime,
    StockMovement,
    Supplier,
    SupplierMaterial,
    SupplyAlert,
    WorkOrder,
    WorkOrderStatus,
)
from .numbering import next_number

OPEN_PO_STATUSES = (
    PurchaseOrderStatus.proposed,
    PurchaseOrderStatus.ordered,
    PurchaseOrderStatus.confirmed,
    PurchaseOrderStatus.partial,
)
COMMITTED_PO_STATUSES = (
    PurchaseOrderStatus.ordered,
    PurchaseOrderStatus.confirmed,
    PurchaseOrderStatus.partial,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def supplier_reliability(
    db: Session,
    supplier: Supplier,
    po_rows: list[PurchaseOrder] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Berechnet Liefertreue und Kennzahlen eines Lieferanten aus echten Bestellungen."""
    ref_now = now or _now()
    rows = (
        po_rows
        if po_rows is not None
        else db.query(PurchaseOrder).filter(PurchaseOrder.supplier_id == supplier.id).all()
    )
    completed = 0
    on_time = 0
    overdue_open = 0
    open_count = 0
    for po in rows:
        eta = _aware(po.confirmed_eta or po.requested_eta)
        if po.status == PurchaseOrderStatus.received:
            completed += 1
            rec = _aware(po.received_at)
            if eta is None or rec is None or rec <= eta + timedelta(days=1):
                on_time += 1
        elif po.status in COMMITTED_PO_STATUSES:
            open_count += 1
            if eta is not None and eta < ref_now:
                overdue_open += 1

    hist_score = (on_time / completed) if completed > 0 else None
    if supplier.reliability_override is not None and hist_score is not None:
        score = round(0.6 * float(supplier.reliability_override) + 0.4 * hist_score, 3)
    elif supplier.reliability_override is not None:
        score = round(float(supplier.reliability_override), 3)
    elif hist_score is not None:
        score = round(hist_score, 3)
    else:
        score = 0.85
    if overdue_open > 0:
        score = max(0.2, round(score - 0.08 * overdue_open, 3))
    return {
        "score": min(1.0, max(0.0, score)),
        "completed_pos": completed,
        "on_time_pos": on_time,
        "open_pos": open_count,
        "overdue_pos": overdue_open,
    }


def rank_suppliers_for_product(
    db: Session,
    product: Product,
    *,
    thk: float = 0.0,
    qty_needed: int = 1,
    urgent: bool = False,
    suppliers_by_id: dict[int, Supplier] | None = None,
    links_for_product: list[SupplierMaterial] | None = None,
    rel_by_supplier: dict[int, dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Bewertet alle aktiven Bezugsquellen eines Werkstoffs (0..100 Punkte) mit Klartext-Begründung."""
    ref_now = now or _now()
    links = (
        links_for_product
        if links_for_product is not None
        else db.query(SupplierMaterial)
        .filter(SupplierMaterial.product_id == product.id, SupplierMaterial.active.is_(True))
        .all()
    )
    if thk > 0:
        exact = [lk for lk in links if abs(float(lk.thk or 0.0) - thk) < 1e-6]
        generic = [lk for lk in links if float(lk.thk or 0.0) == 0.0]
        links = exact + [g for g in generic if g.supplier_id not in {e.supplier_id for e in exact}]

    if not links:
        return []

    sup_map = suppliers_by_id
    if sup_map is None:
        sids = list({lk.supplier_id for lk in links})
        sup_map = {s.id: s for s in db.query(Supplier).filter(Supplier.id.in_(sids)).all()}

    active_pairs: list[tuple[SupplierMaterial, Supplier]] = []
    for lk in links:
        sup = sup_map.get(lk.supplier_id)
        if sup and sup.active:
            active_pairs.append((lk, sup))

    if not active_pairs:
        return []

    prices = [float(lk.unit_eur_m2) for lk, _ in active_pairs if float(lk.unit_eur_m2 or 0) > 0]
    min_price = min(prices) if prices else 0.0
    max_price = max(prices) if prices else 0.0

    leads = [
        max(1, int(lk.quoted_lead_days or sup.default_lead_days or product.lead_days or 7))
        for lk, sup in active_pairs
    ]
    min_lead = min(leads) if leads else 1
    max_lead = max(leads) if leads else 1

    # Gewichtung: im Eilfall zählt Lieferzeit deutlich stärker als Einkaufspreis.
    w_price = 20.0 if urgent else 35.0
    w_lead = 45.0 if urgent else 28.0
    w_rel = 25.0
    w_fit = 10.0

    default_sheet = (product.sheets[0] if product.sheets else [1500.0, 1000.0])
    out: list[dict[str, Any]] = []
    need = max(1, int(qty_needed or 1))

    for lk, sup in active_pairs:
        rel_info = (
            rel_by_supplier[sup.id]
            if (rel_by_supplier is not None and sup.id in rel_by_supplier)
            else supplier_reliability(db, sup, now=ref_now)
        )
        rel = float(rel_info["score"])
        ek = float(lk.unit_eur_m2 or 0.0)
        lead = max(1, int(lk.quoted_lead_days or sup.default_lead_days or product.lead_days or 7))
        moq = max(1, int(lk.moq_sheets or 1))
        sw = float(lk.sheet_w or default_sheet[0] or 1500.0)
        sh = float(lk.sheet_h or default_sheet[1] or 1000.0)
        area_m2 = max(0.01, (sw * sh) / 1_000_000.0)
        unit_eur_eff = ek if ek > 0 else round(float(product.eur_m2 or 20.0) * 0.55, 2)
        plate_eur = round(unit_eur_eff * area_m2, 2)
        order_qty = max(need, moq)
        total_net = round(order_qty * plate_eur, 2)

        if ek <= 0 or max_price <= min_price:
            p_norm = 0.7 if ek <= 0 else 1.0
        else:
            p_norm = 1.0 - ((ek - min_price) / (max_price - min_price)) * 0.85

        if max_lead <= min_lead:
            l_norm = 1.0
        else:
            l_norm = 1.0 - ((lead - min_lead) / (max_lead - min_lead)) * 0.9

        overshoot = max(0, moq - need) / max(1, need)
        moq_norm = max(0.2, 1.0 - min(0.8, overshoot * 0.35))
        rank_norm = 1.0 if int(lk.preferred_rank or 1) == 1 else max(0.4, 1.0 - 0.2 * (int(lk.preferred_rank or 1) - 1))
        fit_norm = 0.6 * moq_norm + 0.4 * rank_norm

        pref_bonus = 8.0 if (product.preferred_supplier_id and product.preferred_supplier_id == sup.id) else 0.0
        total_score = min(
            100.0,
            round(w_price * p_norm + w_lead * l_norm + w_rel * rel + w_fit * fit_norm + pref_bonus, 1),
        )

        reasons: list[str] = []
        if product.preferred_supplier_id == sup.id:
            reasons.append("gesetzter Vorzugslieferant")
        elif int(lk.preferred_rank or 1) == 1:
            reasons.append("Rang 1 Stammbezug")
        if ek > 0 and abs(ek - min_price) < 1e-6 and len(prices) > 1:
            reasons.append(f"bester EK ({ek:.2f} €/m²)")
        elif ek > 0:
            reasons.append(f"EK {ek:.2f} €/m²")
        if lead == min_lead and len(leads) > 1:
            reasons.append(f"schnellste Lieferzeit ({lead} Tg.)")
        else:
            reasons.append(f"{lead} Tg. Lieferzeit")
        reasons.append(f"{int(round(rel * 100))} % Liefertreue")
        if moq > need:
            reasons.append(f"MOQ {moq} Pl.")

        eta = (ref_now + timedelta(days=lead)).date().isoformat()
        out.append(
            {
                "supplier_material_id": lk.id,
                "supplier_id": sup.id,
                "supplier_code": sup.code,
                "supplier_name": sup.name,
                "supplier_email": sup.email,
                "country": sup.country,
                "city": sup.city,
                "currency": sup.currency or "EUR",
                "supplier_sku": lk.supplier_sku,
                "thk": float(lk.thk or 0.0),
                "sheet_w": sw,
                "sheet_h": sh,
                "unit_eur_m2": ek,
                "plate_eur": plate_eur,
                "moq_sheets": moq,
                "order_qty": order_qty,
                "total_net_eur": total_net,
                "lead_days": lead,
                "eta_date": eta,
                "reliability": rel,
                "overdue_pos": rel_info["overdue_pos"],
                "preferred_rank": int(lk.preferred_rank or 1),
                "score": total_score,
                "is_recommended": False,
                "reason": " · ".join(reasons),
            }
        )

    out.sort(key=lambda r: (-r["score"], r["lead_days"], r["plate_eur"], r["preferred_rank"]))
    if out:
        out[0]["is_recommended"] = True
    return out


def compute_smart_inventory(
    db: Session, *, include_inactive: bool = False, now: datetime | None = None
) -> dict[str, Any]:
    """Vollständige Smart-Lager- & MRP-Rechnung über alle Werkstoffe."""
    ref_now = now or _now()
    q = db.query(Product)
    if not include_inactive:
        q = q.filter(Product.active.is_(True))
    products = q.order_by(Product.cat, Product.name).all()
    if not products:
        return {"items": [], "summary": {"total": 0, "critical": 0, "reorder": 0, "single_source": 0, "open_pos": 0}}

    cut_30 = ref_now - timedelta(days=30)
    cut_90 = ref_now - timedelta(days=90)

    # 1. Verbrauch (30 & 90 Tage)
    burn_30 = dict(
        db.query(StockMovement.product_id, func.coalesce(func.sum(-StockMovement.delta), 0))
        .filter(StockMovement.delta < 0, StockMovement.created_at >= cut_30)
        .group_by(StockMovement.product_id)
        .all()
    )
    burn_90 = dict(
        db.query(StockMovement.product_id, func.coalesce(func.sum(-StockMovement.delta), 0))
        .filter(StockMovement.delta < 0, StockMovement.created_at >= cut_90)
        .group_by(StockMovement.product_id)
        .all()
    )

    # 2. Verfügbare Reststücke & aktive Chargen
    offcuts_map: dict[str, tuple[int, float]] = {}
    for pid, cnt, area in (
        db.query(
            Offcut.product_id,
            func.count(Offcut.id),
            func.coalesce(func.sum(Offcut.w * Offcut.h / 1_000_000.0), 0.0),
        )
        .filter(Offcut.status == "available")
        .group_by(Offcut.product_id)
        .all()
    ):
        offcuts_map[pid] = (int(cnt or 0), round(float(area or 0.0), 2))

    lots_map = dict(
        db.query(MaterialLot.product_id, func.count(MaterialLot.id))
        .filter(MaterialLot.status == "available", MaterialLot.qty_remaining > 0)
        .group_by(MaterialLot.product_id)
        .all()
    )

    # 3. Offener Bedarf aus noch nicht bereitgestellten Innenaufträgen + ungeschachtelten Auftragspositionen
    demand_sheets: dict[str, int] = {}
    rush_demand: set[str] = set()
    earliest_due: dict[str, datetime] = {}

    open_wos = (
        db.query(WorkOrder)
        .filter(
            WorkOrder.status.in_((WorkOrderStatus.open, WorkOrderStatus.running)),
            WorkOrder.material_staged_at.is_(None),
        )
        .all()
    )
    for wo in open_wos:
        # Hinweis: Der Sammellauf zieht Platten bereits beim Anlegen (move_stock).
        # Wir merken uns aber die Fälligkeit für Terminrisiko-Warnungen.
        due = _aware(wo.due_date)
        if due and (wo.mat not in earliest_due or due < earliest_due[wo.mat]):
            earliest_due[wo.mat] = due

    # Ungeschachtelte offene Auftragspositionen brauchen künftig Platten aus dem Lager
    unnested_rows = (
        db.query(OrderPosition, Order)
        .join(Order, OrderPosition.order_id == Order.id)
        .filter(
            Order.cancelled_at.is_(None),
            Order.held_at.is_(None),
            Order.stage < 2,
            OrderPosition.kind != "custom",
            OrderPosition.production_status == "pending",
        )
        .all()
    )
    area_by_mat: dict[str, float] = {}
    for pos, ord_row in unnested_rows:
        mat = pos.mat
        od = float(pos.od or 100.0)
        part_m2 = max(0.005, ((od * od) / 1_000_000.0) * int(pos.qty or 1) * 1.25)
        area_by_mat[mat] = area_by_mat.get(mat, 0.0) + part_m2
        if ord_row.rush:
            rush_demand.add(mat)
        due = _aware(ord_row.due_date)
        if due and (mat not in earliest_due or due < earliest_due[mat]):
            earliest_due[mat] = due

    prod_by_id = {p.id: p for p in products}
    for mat, total_m2 in area_by_mat.items():
        p = prod_by_id.get(mat)
        sh = (p.sheets[0] if (p and p.sheets) else [1500.0, 1000.0])
        sheet_m2 = max(0.25, (float(sh[0]) * float(sh[1])) / 1_000_000.0 * 0.72)
        demand_sheets[mat] = max(1, math.ceil(total_m2 / sheet_m2))

    # 4. Offener Zulauf aus Bestellungen (PurchaseOrders)
    incoming_committed: dict[str, int] = {}
    incoming_proposed: dict[str, int] = {}
    next_eta_by_mat: dict[str, datetime] = {}
    po_nos_by_mat: dict[str, list[str]] = {}
    overdue_pos_by_mat: dict[str, int] = {}

    open_po_lines = (
        db.query(PurchaseOrderLine, PurchaseOrder)
        .join(PurchaseOrder, PurchaseOrderLine.purchase_order_id == PurchaseOrder.id)
        .filter(PurchaseOrder.status.in_(OPEN_PO_STATUSES))
        .all()
    )
    for line, po in open_po_lines:
        rem = max(0, int(line.qty_ordered or 0) - int(line.qty_received or 0))
        if rem <= 0:
            continue
        pid = line.product_id
        po_nos_by_mat.setdefault(pid, [])
        if po.no not in po_nos_by_mat[pid]:
            po_nos_by_mat[pid].append(po.no)
        if po.status == PurchaseOrderStatus.proposed:
            incoming_proposed[pid] = incoming_proposed.get(pid, 0) + rem
        else:
            incoming_committed[pid] = incoming_committed.get(pid, 0) + rem
            eta = _aware(line.confirmed_eta or po.confirmed_eta or line.requested_eta or po.requested_eta)
            if eta:
                if pid not in next_eta_by_mat or eta < next_eta_by_mat[pid]:
                    next_eta_by_mat[pid] = eta
                if eta < ref_now:
                    overdue_pos_by_mat[pid] = overdue_pos_by_mat.get(pid, 0) + 1

    # 5. Lieferanten & Zuverlässigkeit vorladen
    all_suppliers = {s.id: s for s in db.query(Supplier).all()}
    all_pos = db.query(PurchaseOrder).all()
    pos_by_sup: dict[int, list[PurchaseOrder]] = {}
    for po in all_pos:
        pos_by_sup.setdefault(po.supplier_id, []).append(po)
    rel_by_sup = {
        sid: supplier_reliability(db, sup, pos_by_sup.get(sid, []), now=ref_now)
        for sid, sup in all_suppliers.items()
    }
    links_by_prod: dict[str, list[SupplierMaterial]] = {}
    for lk in db.query(SupplierMaterial).filter(SupplierMaterial.active.is_(True)).all():
        links_by_prod.setdefault(lk.product_id, []).append(lk)

    # 6. ABC-Klassifikation nach Wertumsatz (90 Tage Verbrauch + Bestandswert)
    value_scores: dict[str, float] = {}
    for p in products:
        sh = p.sheets[0] if p.sheets else [1500.0, 1000.0]
        plate_m2 = max(0.1, (float(sh[0]) * float(sh[1])) / 1_000_000.0)
        b90 = float(burn_90.get(p.id, 0) or 0)
        turn_eur = (b90 + max(1, int(p.stock or 0)) * 0.25) * plate_m2 * float(p.eur_m2 or 10.0)
        value_scores[p.id] = turn_eur

    total_val = sum(value_scores.values()) or 1.0
    abc_by_id: dict[str, str] = {}
    cum = 0.0
    for pid, val in sorted(value_scores.items(), key=lambda kv: -kv[1]):
        ratio = cum / total_val
        if ratio < 0.70:
            abc_by_id[pid] = "A"
        elif ratio < 0.90:
            abc_by_id[pid] = "B"
        else:
            abc_by_id[pid] = "C"
        cum += val

    items: list[dict[str, Any]] = []
    critical_n = 0
    reorder_n = 0
    single_source_n = 0

    for p in products:
        b30 = int(burn_30.get(p.id, 0) or 0)
        b90 = int(burn_90.get(p.id, 0) or 0)
        daily_burn = round(max(b30 / 30.0, b90 / 90.0), 3)
        stock = int(p.stock or 0)
        dem = int(demand_sheets.get(p.id, 0))
        inc = int(incoming_committed.get(p.id, 0))
        prop = int(incoming_proposed.get(p.id, 0))
        net_avail = stock + inc - dem

        safety = int(getattr(p, "safety_stock", 1) or 0)
        min_st = int(getattr(p, "min_stock", 0) or 0)
        tgt_st = int(getattr(p, "target_stock", 0) or 0)
        auto_mode = getattr(p, "auto_reorder", "propose") or "propose"
        unit = getattr(p, "sku_unit", "Platte") or "Platte"

        lead_eff = max(1, int(p.lead_days or 7))
        rop = min_st if min_st > 0 else max(safety, math.ceil(daily_burn * lead_eff + safety))
        target = tgt_st if tgt_st > 0 else max(rop + 3, math.ceil(rop + daily_burn * 14))

        days_cover = round(max(0, stock) / daily_burn, 1) if daily_burn > 0.005 else None
        urgent = (
            (p.id in rush_demand)
            or (net_avail < 0)
            or (days_cover is not None and days_cover < lead_eff)
        )
        shortage = max(0, target - (net_avail + prop)) if (net_avail < rop or net_avail < 0) else 0
        ranked = rank_suppliers_for_product(
            db,
            p,
            qty_needed=max(1, shortage or 2),
            urgent=urgent,
            suppliers_by_id=all_suppliers,
            links_for_product=links_by_prod.get(p.id, []),
            rel_by_supplier=rel_by_sup,
            now=ref_now,
        )
        rec = ranked[0] if ranked else None
        n_suppliers = len({r["supplier_id"] for r in ranked})
        is_single_source = n_suppliers == 1
        if is_single_source:
            single_source_n += 1

        if net_avail < 0 or (stock <= 0 and (dem > 0 or rop > 0)):
            health = "critical"
            critical_n += 1
        elif net_avail < rop:
            health = "reorder"
            reorder_n += 1
        elif stock > target * 2 and b90 == 0 and stock >= 10:
            health = "overstock"
        else:
            health = "healthy"

        off_cnt, off_m2 = offcuts_map.get(p.id, (0, 0.0))
        items.append(
            {
                "product_id": p.id,
                "name": p.name,
                "short": p.short,
                "cat": p.cat,
                "colour": p.colour,
                "active": p.active,
                "sku_unit": unit,
                "eur_m2": float(p.eur_m2 or 0.0),
                "stock": stock,
                "offcuts": off_cnt,
                "offcuts_m2": off_m2,
                "available_lots": int(lots_map.get(p.id, 0) or 0),
                "open_demand": dem,
                "incoming_ordered": inc,
                "incoming_proposed": prop,
                "net_available": net_avail,
                "effective_rop": rop,
                "effective_target": target,
                "min_stock": min_st,
                "target_stock": tgt_st,
                "safety_stock": safety,
                "auto_reorder": auto_mode,
                "preferred_supplier_id": getattr(p, "preferred_supplier_id", None),
                "burn_30d": b30,
                "burn_90d": b90,
                "daily_burn": daily_burn,
                "days_of_cover": days_cover,
                "lead_days": rec["lead_days"] if rec else lead_eff,
                "abc_class": abc_by_id.get(p.id, "C"),
                "health": health,
                "urgent": urgent,
                "suggested_order_qty": rec["order_qty"] if (rec and shortage > 0) else shortage,
                "open_po_nos": po_nos_by_mat.get(p.id, []),
                "next_eta": next_eta_by_mat[p.id].date().isoformat() if p.id in next_eta_by_mat else None,
                "overdue_pos": overdue_pos_by_mat.get(p.id, 0),
                "earliest_due": earliest_due[p.id].date().isoformat() if p.id in earliest_due else None,
                "supplier_count": n_suppliers,
                "single_source": is_single_source,
                "recommended_supplier": rec,
                "alternatives": ranked[1:4],
            }
        )

    open_pos_total = (
        db.query(func.count(PurchaseOrder.id))
        .filter(PurchaseOrder.status.in_(OPEN_PO_STATUSES))
        .scalar()
        or 0
    )
    return {
        "items": items,
        "summary": {
            "total": len(items),
            "critical": critical_n,
            "reorder": reorder_n,
            "healthy": sum(1 for i in items if i["health"] == "healthy"),
            "overstock": sum(1 for i in items if i["health"] == "overstock"),
            "single_source": single_source_n,
            "open_pos": int(open_pos_total),
        },
    }


def build_po_email_text(po: PurchaseOrder, supplier: Supplier, lines: list[tuple[PurchaseOrderLine, str]]) -> tuple[str, str]:
    """Erzeugt Betreff und deutschen Bestelltext für eine Lieferantenbestellung."""
    eta_str = (po.requested_eta.strftime("%d.%m.%Y") if po.requested_eta else "schnellstmöglich")
    subject = f"Bestellung {po.no} — Plattenmaterial (Wunschtermin {eta_str})"
    pos_lines = []
    for idx, (ln, pname) in enumerate(lines, start=1):
        fmt = f"{int(ln.sheet_w)}×{int(ln.sheet_h)} mm" if (ln.sheet_w and ln.sheet_h) else "Standardformat"
        pos_lines.append(
            f"  {idx}. {pname} ({ln.product_id}) · {ln.thk:g} mm · {fmt} · "
            f"{ln.qty_ordered} Platten à {ln.unit_price_eur:.2f} {po.currency}"
        )
    body = (
        f"Guten Tag {supplier.name},\n\n"
        f"hiermit bestellen wir verbindlich unter der Bestellnummer {po.no}:\n\n"
        + "\n".join(pos_lines)
        + f"\n\nGesamtsumme netto: {po.total_net:.2f} {po.currency}\n"
        f"Gewünschter Liefertermin: {eta_str}\n"
        f"Lieferbedingung: {supplier.incoterms or 'DAP'} · Zahlungsziel: {supplier.payment_terms or '30 Tage netto'}\n\n"
        "Bitte bestätigen Sie uns kurz den Liefertermin und geben Sie bei Anlieferung die Chargen- bzw. "
        "Werkszeugnisnummer (EN 10204) auf dem Lieferschein an.\n\n"
        "Freundliche Grüße\nEinkauf & Disposition"
    )
    return subject, body


def run_auto_replenishment(
    db: Session,
    *,
    actor: str = "auto-scm",
    dry_run: bool = False,
    product_ids: list[str] | None = None,
    force_order: bool = False,
) -> dict[str, Any]:
    """Prüft Unterdeckungen und erzeugt gebündelte Bestellvorschläge oder Direktbestellungen."""
    report = compute_smart_inventory(db)
    wanted_set = set(product_ids) if product_ids else None
    candidates: list[dict[str, Any]] = []

    for row in report["items"]:
        pid = row["product_id"]
        if wanted_set is not None and pid not in wanted_set:
            continue
        if wanted_set is None and row["auto_reorder"] == "off":
            continue
        if row["health"] not in ("critical", "reorder") and wanted_set is None:
            continue
        qty = int(row["suggested_order_qty"] or 0)
        if qty <= 0 and wanted_set is not None:
            qty = max(1, (row["recommended_supplier"] or {}).get("moq_sheets", 2))
        if qty <= 0:
            continue
        rec = row["recommended_supplier"]
        if not rec:
            candidates.append(
                {
                    "product_id": pid,
                    "name": row["name"],
                    "action": "skipped_no_supplier",
                    "qty": qty,
                    "reason": "Kein aktiver Lieferant hinterlegt.",
                }
            )
            continue
        mode = "auto" if (force_order or row["auto_reorder"] == "auto") else "propose"
        candidates.append(
            {
                "product_id": pid,
                "name": row["name"],
                "mode": mode,
                "qty": max(qty, int(rec["moq_sheets"] or 1)),
                "supplier": rec,
                "reason": f"Netto {row['net_available']} < Meldebestand {row['effective_rop']} · {rec['reason']}",
            }
        )

    if dry_run or not candidates:
        return {"dry_run": dry_run, "candidates": candidates, "created_pos": []}

    # Gruppieren nach (supplier_id, mode)
    grouped: dict[tuple[int, str], list[dict[str, Any]]] = {}
    skipped: list[dict[str, Any]] = []
    for c in candidates:
        if c.get("action") == "skipped_no_supplier":
            skipped.append(c)
            continue
        grouped.setdefault((int(c["supplier"]["supplier_id"]), c["mode"]), []).append(c)

    now = _now()
    created_pos: list[dict[str, Any]] = []
    prod_objs = {p.id: p for p in db.query(Product).all()}

    for (sup_id, mode), lines in grouped.items():
        sup = db.get(Supplier, sup_id)
        if sup is None:
            continue
        status = PurchaseOrderStatus.ordered if mode == "auto" else PurchaseOrderStatus.proposed
        max_lead = max(int(item["supplier"]["lead_days"]) for item in lines)
        eta = now + timedelta(days=max_lead)
        po_no = next_number(db, "purchase_order", "BE-")
        po = PurchaseOrder(
            no=po_no,
            supplier_id=sup.id,
            status=status,
            currency=sup.currency or "EUR",
            order_date=now,
            requested_eta=eta,
            total_net=0.0,
            note="Automatische Disposition (Auto-Lieferant)" if mode == "auto" else "Smart-Lager Bestellvorschlag",
            created_by=actor,
        )
        db.add(po)
        db.flush()

        total_net = 0.0
        mail_lines: list[tuple[PurchaseOrderLine, str]] = []
        for item in lines:
            rec = item["supplier"]
            p_obj = prod_objs.get(item["product_id"])
            thk = float(rec["thk"]) if float(rec["thk"] or 0) > 0 else (
                float(p_obj.thicknesses[0]) if (p_obj and p_obj.thicknesses) else 2.0
            )
            qty = int(item["qty"])
            uprice = float(rec["plate_eur"])
            ln = PurchaseOrderLine(
                purchase_order_id=po.id,
                product_id=item["product_id"],
                thk=thk,
                sheet_w=float(rec["sheet_w"]),
                sheet_h=float(rec["sheet_h"]),
                qty_ordered=qty,
                qty_received=0,
                unit_price_eur=uprice,
                requested_eta=now + timedelta(days=int(rec["lead_days"])),
                note=item["reason"][:290],
            )
            db.add(ln)
            total_net += qty * uprice
            mail_lines.append((ln, item["name"]))

        po.total_net = round(total_net, 2)
        db.flush()

        mail_draft_id: int | None = None
        if sup.email:
            subj, body_txt = build_po_email_text(po, sup, mail_lines)
            mail = MailMessage(
                direction="draft",
                folder="drafts",
                status="draft",
                to_addrs=[sup.email],
                subject=subj,
                body_text=body_txt,
                ai_drafted=True,
                purchase_order_no=po.no,
                supplier_id=sup.id,
                thread_key=f"po:{po.no}",
                actor=actor,
            )
            db.add(mail)
            db.flush()
            mail_draft_id = mail.id

        db.add(
            AuditLog(
                actor=actor,
                action="scm_auto_replenish",
                entity="purchase_order",
                entity_id=po.no,
                detail={
                    "supplier": sup.code,
                    "status": status.value,
                    "total_net": po.total_net,
                    "lines": [i["product_id"] for i in lines],
                },
            )
        )
        created_pos.append(
            {
                "no": po.no,
                "supplier_id": sup.id,
                "supplier_name": sup.name,
                "status": status.value,
                "total_net": po.total_net,
                "requested_eta": eta.date().isoformat(),
                "line_count": len(lines),
                "mail_draft_id": mail_draft_id,
            }
        )

    refresh_alerts(db, now=now)
    db.commit()
    return {"dry_run": False, "candidates": candidates, "skipped": skipped, "created_pos": created_pos}


def check_auto_reorder_for_product(db: Session, product_id: str, actor: str = "auto-scm") -> dict | None:
    """Wird bei Lagerabgang gerufen: steht der Werkstoff auf ``auto``, legt er bei Unterdeckung nach."""
    prod = db.get(Product, product_id)
    if prod is None or not prod.active or getattr(prod, "auto_reorder", "propose") != "auto":
        return None
    res = run_auto_replenishment(db, actor=actor, product_ids=[product_id], force_order=True)
    created = res.get("created_pos") or []
    return created[0] if created else None


def refresh_alerts(db: Session, *, now: datetime | None = None) -> list[SupplyAlert]:
    """Aktualisiert deterministische Lieferketten-Warnungen idempotent über ``dedup_key``."""
    ref_now = now or _now()
    inv = compute_smart_inventory(db, now=ref_now)
    desired: dict[str, dict[str, Any]] = {}

    for item in inv["items"]:
        pid = item["product_id"]
        if item["health"] == "critical":
            desired[f"stockout:{pid}"] = {
                "kind": "stockout",
                "severity": "danger",
                "title": f"Unterdeckung {item['name']} ({item['stock']} {item['sku_unit']})",
                "detail": (
                    f"Bestand {item['stock']}, offener Bedarf {item['open_demand']}, "
                    f"Zulauf {item['incoming_ordered']} → Netto {item['net_available']} "
                    f"(Meldebestand {item['effective_rop']})."
                ),
                "metric": f"Netto {item['net_available']} {item['sku_unit']}",
                "entity_type": "product",
                "entity_id": pid,
                "product_id": pid,
            }
        elif item["health"] == "reorder":
            desired[f"reorder:{pid}"] = {
                "kind": "stockout",
                "severity": "warning",
                "title": f"Meldebestand unterschritten: {item['name']}",
                "detail": (
                    f"Netto verfügbar {item['net_available']} < Meldebestand {item['effective_rop']}. "
                    + (
                        f"Empfehlung: {item['recommended_supplier']['supplier_name']} ({item['suggested_order_qty']} Pl.)."
                        if item["recommended_supplier"]
                        else "Bitte Lieferant zuordnen."
                    )
                ),
                "metric": f"{item['net_available']} / {item['effective_rop']}",
                "entity_type": "product",
                "entity_id": pid,
                "product_id": pid,
            }
        if item["single_source"] and (item["abc_class"] == "A" or item["burn_90d"] > 0 or item["stock"] <= 5):
            rec = item["recommended_supplier"]
            desired[f"single_source:{pid}"] = {
                "kind": "single_source",
                "severity": "info",
                "title": f"Einzelquellen-Risiko: {item['name']}",
                "detail": (
                    f"Nur ein aktiver Lieferant ({rec['supplier_name'] if rec else '—'}) hinterlegt. "
                    "Zweitlieferant für Ausfallsicherheit empfohlen."
                ),
                "metric": "1 Lieferant",
                "entity_type": "product",
                "entity_id": pid,
                "product_id": pid,
            }

    # Überfällige Einkaufsbestellungen
    open_pos = (
        db.query(PurchaseOrder, Supplier)
        .join(Supplier, PurchaseOrder.supplier_id == Supplier.id)
        .filter(PurchaseOrder.status.in_(COMMITTED_PO_STATUSES))
        .all()
    )
    for po, sup in open_pos:
        eta = _aware(po.confirmed_eta or po.requested_eta)
        if eta and eta < ref_now:
            days_late = max(1, (ref_now - eta).days)
            desired[f"overdue_po:{po.no}"] = {
                "kind": "overdue_po",
                "severity": "danger" if days_late >= 3 else "warning",
                "title": f"Lieferung {po.no} ({sup.name}) {days_late} Tg. überfällig",
                "detail": f"Bestellt am {po.order_date.strftime('%d.%m.%Y')}, bestätigter Termin war {eta.strftime('%d.%m.%Y')}.",
                "metric": f"+{days_late} Tage",
                "entity_type": "purchase_order",
                "entity_id": po.no,
            }

    existing = {a.dedup_key: a for a in db.query(SupplyAlert).all()}
    for key, spec in desired.items():
        row = existing.get(key)
        if row is None:
            row = SupplyAlert(
                dedup_key=key,
                kind=spec["kind"],
                severity=spec["severity"],
                title=spec["title"],
                detail=spec["detail"],
                metric=spec["metric"],
                entity_type=spec.get("entity_type", ""),
                entity_id=spec.get("entity_id", ""),
                product_id=spec.get("product_id"),
                status="open",
                first_seen_at=ref_now,
                last_seen_at=ref_now,
            )
            db.add(row)
        else:
            row.severity = spec["severity"]
            row.title = spec["title"]
            row.detail = spec["detail"]
            row.metric = spec["metric"]
            row.last_seen_at = ref_now
            if row.status == "resolved":
                row.status = "open"
                row.resolved_at = None
                row.resolved_by = ""

    for key, row in existing.items():
        if key not in desired and row.status in ("open", "acknowledged"):
            row.status = "resolved"
            row.resolved_at = ref_now
            row.resolved_by = "auto-watchdog"

    db.flush()
    return (
        db.query(SupplyAlert)
        .filter(SupplyAlert.status.in_(("open", "acknowledged")))
        .order_by(SupplyAlert.id.desc())
        .all()
    )


sync_supply_alerts = refresh_alerts
