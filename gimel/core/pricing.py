"""Gimel's plain price formula, used when no application brings its own.

Material by part area, cutting by length, nothing trade-specific. The result has
the same keys as an application's formula, because the order, quote and invoice
code reads them. The price is computed once and frozen with the order.
"""

from __future__ import annotations

from typing import Callable, Optional, Sequence

from .geometry import gross_area
from .nesting import nest_for
from .types import Position, Product, Rates, SheetLine


def _part_area_m2(p: Position) -> float:
    outer = gross_area(p.shape) if getattr(p, "shape", None) else 0.0
    if outer > 0:
        return outer / 1e6
    return 3.141592653589793 * (float(p.od) / 1000) ** 2 / 4


def _cut_m(p: Position) -> float:
    if getattr(p, "cut_len", None):
        return float(p.cut_len) / 1000
    return 3.141592653589793 * (float(p.od) + float(p.di or 0)) / 1000


def price_cart(
    lines: Sequence[Position | SheetLine],
    by_id: Callable[[str], Optional[Product]],
    rates: Rates,
    cert: str = "",
    plate_choice: Optional[Callable[[str], Optional[int]]] = None,
    discount_pct: float = 0.0,
) -> dict:
    choose = plate_choice if callable(plate_choice) else (lambda _mat: None)
    per: dict = {}
    over: list = []
    groups: list = []
    mat_c = cut_c = sheet_c = custom_c = 0.0
    vat_rate = rates.vat_rate if rates.vat_rate is not None else rates.vat
    parts = [l for l in lines if getattr(l, "kind", "part") not in ("sheet", "custom")]

    by_mat: dict = {}
    for p in parts:
        by_mat.setdefault((p.mat, p.thk), []).append(p)
    for (mat, thk), group in sorted(by_mat.items()):
        product = by_id(mat)
        if not product:
            continue
        nested = nest_for(group, product, rates, choose(mat))
        over_ids = {o.id for o in nested["over"]}
        over += nested["over"]
        rate = product.eur_m2_thk.get(str(thk), product.eur_m2) if product.eur_m2_thk else product.eur_m2
        cut_len = used_a = 0.0
        for p in group:
            if p.id in over_ids:
                continue
            mat_line = _part_area_m2(p) * p.q * float(rate) * float(rates.waste_min or 1.0)
            cut_line = _cut_m(p) * p.q * float(rates.cut or 0.0)
            per[p.id] = {"mat": mat_line, "cut": cut_line, "n": p.q, "free": 0.0}
            mat_c += mat_line
            cut_c += cut_line
            cut_len += _cut_m(p) * p.q
            used_a += _part_area_m2(p) * p.q
        # Dieselben Schlüssel wie die Formel einer Anwendung: Angebot und Auftrag lesen
        # sie alle. Reste rechnet die schlichte Formel nicht gut, also 0.
        sheets = nested["sheets"]
        sheet_a = len(sheets) * float(nested.get("W") or 0) * float(nested.get("H") or 0) / 1e6
        groups.append({"mat": mat, "thk": thk, "product": product, "nested": nested,
                       "g": {"cutLen": cut_len, "nSheets": len(sheets),
                             "nRest": sum(len(getattr(sh, "rest", ()) or ()) for sh in sheets),
                             "usedA": used_a,
                             "waste": max(0.0, 1 - used_a / sheet_a) if sheet_a > 0 else 0.0,
                             "leftoverFraction": 0.0, "leftoverCredit": 0.0}})

    for l in lines:
        kind = getattr(l, "kind", "part")
        if kind == "custom":
            net = max(0.0, float(getattr(l, "price_gross", 0.0) or 0.0)) * max(1, int(l.q))
            custom_c += net
            per[l.id] = {"mat": net, "cut": 0.0, "n": float(max(1, int(l.q))), "free": 0.0, "custom": True}
        elif kind == "sheet":
            product = by_id(l.mat)
            if product:
                w, h = l.fmt
                v = float(w) * float(h) / 1e6 * float(product.eur_m2) * l.q
                sheet_c += v
                per[l.id] = {"mat": v, "cut": 0.0, "n": l.q, "free": 0.0, "sheet": True}

    goods = mat_c + cut_c + sheet_c + custom_c
    disc = max(0.0, min(50.0, float(discount_pct or 0.0)))
    discount = goods * disc / 100.0
    freight = float(rates.freight or 0.0) if per else 0.0
    total = goods - discount + freight
    return {
        "groups": groups, "per": per, "over": over,
        "matC": mat_c, "cutC": cut_c, "sheetC": sheet_c, "customC": custom_c,
        "setup": 0.0, "setupRate": 0.0, "setupFix": 0.0, "setupTier": 0,
        "discountPct": disc, "discount": discount, "cert": 0.0, "freight": freight,
        "goods": goods, "total": total, "vatRate": vat_rate,
        "vat": total * vat_rate, "gross": total * (1 + vat_rate),
        "leftoverCredit": 0.0, "matGross": mat_c,
        "cutLenM": sum(g["g"]["cutLen"] for g in groups), "machineMin": 0.0, "derivedCut": 0.0,
    }
