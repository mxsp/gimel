"""Werkstoffe: Katalog lesen (offen), pflegen (Personal), Preise ändern (Personal).

Preisänderungen laufen immer über ``_apply_price``, damit keine Änderung ohne
Verlaufseintrag durchkommt. Wenn ein Kunde später ein altes Angebot vorlegt,
muss beantwortbar sein, mit welchem €/m² gerechnet wurde.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditLog, PriceHistory, Product, User
from ..schemas import (NULLABLE_PRODUCT_FIELDS, BulkPriceChange, BulkPriceResult, BulkPriceRow,
                       MatrixSave, MatrixSaveResult, PriceHistoryOut, ProductCreate, ProductOut,
                       ProductUpdate)
from ..security import require_staff
from ..services.inventory import move_stock

router = APIRouter(prefix="/api/products", tags=["products"])


def _unverify_without_reason(product: Product, reason: str) -> None:
    # Ein neuer Preis ohne Quelle ist wieder ein Richtwert. Das Häkchen still
    # stehen zu lassen wäre die eine Änderung, die jemandem wirklich schaden
    # kann (CLAUDE.md §9).
    if not reason:
        verified = dict(product.verified or {})
        verified["price"] = False
        product.verified = verified


def _apply_price(db: Session, product: Product, new_price: float, reason: str,
                 actor: str) -> Optional[PriceHistory]:
    """Bezugspreis setzen und den Verlauf fortschreiben.

    ``eur_m2`` ist der Bezugspreis (2 mm, siehe domain.pricing.mat_price). Wo
    der Werkstoff Dickensätze hat, rechnet der Kern *mit ihnen* — bis 2026-10
    änderte eine Preisänderung deshalb für keinen der vier Hauswerkstoffe auch
    nur einen Cent, während der Verlauf den neuen Preis zeigte. Jetzt ziehen die
    Dickensätze im selben Verhältnis mit (die EK→VK-Staffel bleibt erhalten),
    und jeder Satz bekommt seine eigene Verlaufszeile.

    Gibt None zurück, wenn sich nichts geändert hat — ein Verlaufseintrag ohne
    Änderung wäre Rauschen.
    """
    old = float(product.eur_m2)
    new_price = round(float(new_price), 4)
    if abs(old - new_price) < 1e-9:
        return None
    entry = PriceHistory(product_id=product.id, thk=None, old_eur_m2=old, new_eur_m2=new_price,
                         reason=reason or "—", changed_by=actor)
    product.eur_m2 = new_price
    thk = dict(product.eur_m2_thk or {}) if isinstance(product.eur_m2_thk, dict) else {}
    if thk and old > 0:
        factor = new_price / old
        scaled = {k: round(float(v) * factor, 4) for k, v in thk.items()}
        _record_thk_changes(db, product, thk, scaled,
                            (reason or "—") + f" (Dickensätze ×{factor:.4f} mitgezogen)", actor)
        product.eur_m2_thk = scaled
    _unverify_without_reason(product, reason)
    db.add(entry)
    return entry


def _record_thk_changes(db: Session, product: Product, old: dict, new: dict,
                        reason: str, actor: str) -> int:
    n = 0
    for key in sorted(set(old) | set(new), key=lambda k: float(k)):
        o, nv = float(old.get(key, 0) or 0), float(new.get(key, 0) or 0)
        if abs(o - nv) < 1e-9:
            continue
        db.add(PriceHistory(product_id=product.id, thk=float(key), old_eur_m2=o, new_eur_m2=nv,
                            reason=reason or "—", changed_by=actor))
        n += 1
    return n


def _apply_thk_prices(db: Session, product: Product, new: dict, reason: str, actor: str) -> int:
    """Dickensätze ausdrücklich setzen (Werkstoffe-Editor); je geänderter Dicke eine Verlaufszeile."""
    old = dict(product.eur_m2_thk or {}) if isinstance(product.eur_m2_thk, dict) else {}
    n = _record_thk_changes(db, product, old, new, reason, actor)
    if n:
        product.eur_m2_thk = dict(new)
        _unverify_without_reason(product, reason)
    return n


def _plain(v):
    return v if isinstance(v, (str, int, float, bool, type(None), list, dict)) else str(v)


@router.get("", response_model=list[ProductOut])
def list_products(db: Annotated[Session, Depends(get_db)],
                   q: Optional[str] = None,
                   cat: Optional[str] = None,
                   cnc: Optional[str] = None,
                   plotter_only: bool = False,
                   include_inactive: bool = False,
                   limit: int = Query(default=500, le=1000)) -> list[Product]:
    """Shop-Sortiment: ``plotter_only=1`` = nur ``cnc=confirmed`` (ATOM-Plotter).

    Die Werkstatt bleibt fähig, was sie konnte — Faser/Hochtemp laufen über
    Stanze/Wasserstrahl/Handarbeit und bleiben fürs Personal bestellbar. Der
    Online-Shop (Port 8000) und der PunchOut-Katalog blenden sie aus.
    """
    query = db.query(Product)
    if not include_inactive:
        query = query.filter(Product.active.is_(True))
    if plotter_only:
        query = query.filter(Product.cnc == "confirmed")
    elif cnc:
        query = query.filter(Product.cnc == cnc)
    if cat:
        query = query.filter(Product.cat == cat)
    if q:
        like = f"%{q.strip().lower()}%"
        query = query.filter(or_(Product.name.ilike(like), Product.short.ilike(like),
                                 Product.brand.ilike(like), Product.id.ilike(like),
                                 Product.sku.ilike(like)))
    return query.order_by(Product.cat, Product.name).limit(limit).all()


@router.get("/{product_id}", response_model=ProductOut)
def get_product(product_id: str, db: Annotated[Session, Depends(get_db)]) -> Product:
    row = db.get(Product, product_id)
    if not row:
        raise HTTPException(status_code=404, detail="Werkstoff nicht gefunden.")
    return row


@router.get("/{product_id}/price-history", response_model=list[PriceHistoryOut],
            dependencies=[Depends(require_staff)])
def price_history(product_id: str, db: Annotated[Session, Depends(get_db)]) -> list[PriceHistory]:
    return (db.query(PriceHistory)
              .filter(PriceHistory.product_id == product_id)
              # Eine Änderung schreibt Bezugs- und Dickenzeilen mit gleicher Zeit;
              # die id hält die Reihenfolge stabil (Bezugszeile zuerst — sie wird zuletzt geschrieben).
              .order_by(PriceHistory.changed_at.desc(), PriceHistory.id.desc()).all())


@router.post("", response_model=ProductOut, status_code=status.HTTP_201_CREATED)
def create_product(body: ProductCreate, db: Annotated[Session, Depends(get_db)],
                   actor: Annotated[User, Depends(require_staff)]) -> Product:
    if db.get(Product, body.id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Diese Werkstoff-ID gibt es schon.")
    data = body.model_dump()
    row = Product(**data)
    db.add(row)
    # PriceHistory.product_id is a plain foreign key, not an ORM relationship;
    # without the flush SQLAlchemy may insert the history row first and SQLite
    # refuses it. The product must exist before its first price line.
    db.flush()
    db.add(PriceHistory(product_id=body.id, old_eur_m2=0.0, new_eur_m2=body.eur_m2,
                        reason="angelegt", changed_by=actor.email))
    db.add(AuditLog(actor=actor.email, action="product_create", entity="product",
                    entity_id=body.id, detail={"name": body.name, "eur_m2": body.eur_m2}))
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{product_id}", response_model=ProductOut)
def update_product(product_id: str, body: ProductUpdate,
                   db: Annotated[Session, Depends(get_db)],
                   actor: Annotated[User, Depends(require_staff)]) -> Product:
    row = db.get(Product, product_id)
    if not row:
        raise HTTPException(status_code=404, detail="Werkstoff nicht gefunden.")
    raw = body.model_dump(exclude_unset=True)
    reason = (raw.pop("price_reason", "") or "").strip()
    # null heißt „unverändert“, außer bei Feldern, die leer sein dürfen.
    changes = {k: v for k, v in raw.items() if v is not None or k in NULLABLE_PRODUCT_FIELDS}
    detail: dict = {}

    thicknesses = changes.get("thicknesses", row.thicknesses or [])
    if "eur_m2_thk" in changes:
        unknown = [k for k in changes["eur_m2_thk"] if float(k) not in [float(t) for t in thicknesses]]
        if unknown:
            raise HTTPException(status_code=422,
                                detail=f"Preis für Dicke {', '.join(unknown)} mm, die der Werkstoff nicht führt.")

    if "eur_m2" in changes:
        old = float(row.eur_m2)
        if _apply_price(db, row, float(changes.pop("eur_m2")), reason, actor.email):
            detail["eur_m2"] = {"alt": old, "neu": float(row.eur_m2)}
    if "eur_m2_thk" in changes:
        old_thk = dict(row.eur_m2_thk or {})
        if _apply_thk_prices(db, row, changes.pop("eur_m2_thk"), reason, actor.email):
            detail["eur_m2_thk"] = {"alt": old_thk, "neu": dict(row.eur_m2_thk or {})}

    # Bestand läuft, wie der Preis, nie ohne Verlaufszeile — sonst zeigt das
    # Lager-Register eine Lücke, die die Werkstoffe-Maske klaglos verursacht
    # haben könnte (CLAUDE.md §9: keine Änderung ohne Spur).
    if "stock" in changes:
        new_stock = int(changes.pop("stock"))
        delta = new_stock - int(row.stock)
        if delta:
            move_stock(db, row, delta, reason="korrektur", actor=actor.email,
                      note="Werkstoffe-Editor")
            detail["stock"] = {"alt": new_stock - delta, "neu": new_stock}

    if "verified" in changes:  # zusammenführen statt ersetzen
        changes["verified"] = {**(row.verified or {}), **changes["verified"]}
    for key, value in changes.items():
        old = getattr(row, key)
        if old != value:
            detail[key] = {"alt": _plain(old), "neu": _plain(value)}
            setattr(row, key, value)

    if detail:
        if reason:
            detail["price_reason"] = reason
        action = "product_reactivate" if detail.get("active", {}).get("neu") is True else "product_update"
        db.add(AuditLog(actor=actor.email, action=action, entity="product",
                        entity_id=product_id, detail=detail))
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_product(product_id: str, db: Annotated[Session, Depends(get_db)],
                       actor: Annotated[User, Depends(require_staff)]) -> None:
    """Deaktivieren statt löschen: bestehende Aufträge verweisen auf den
    Werkstoff, und ein Werkszeugnis muss auch in zwei Jahren noch auflösbar sein."""
    row = db.get(Product, product_id)
    if not row:
        raise HTTPException(status_code=404, detail="Werkstoff nicht gefunden.")
    if not row.active:
        return
    row.active = False
    db.add(AuditLog(actor=actor.email, action="product_deactivate", entity="product",
                    entity_id=product_id))
    db.commit()


@router.post("/plotter-only/apply")
def apply_plotter_only(db: Annotated[Session, Depends(get_db)],
                       actor: Annotated[User, Depends(require_staff)]) -> dict:
    """Ein Klick zum Plotter-Sortiment: deaktiviert alle Werkstoffe ohne
    ``cnc=confirmed`` (Faser/likely, Hochtemp/check → Stanze/Wasserstrahl/Hand).

    Reversibel (einzeln reaktivierbar), alles mit Audit-Spur, Historie bleibt
    auflösbar. Trockenlauf zuerst? Nein — die Liste steht vorher fest und wird
    zurückgegeben; wer sie nicht will, klickt sie nicht.
    """
    rows = db.query(Product).filter(Product.active.is_(True),
                                    Product.cnc != "confirmed").all()
    ids = [r.id for r in rows]
    for r in rows:
        r.active = False
        db.add(AuditLog(actor=actor.email, action="product_deactivate",
                        entity="product", entity_id=r.id,
                        detail={"reason": "plotter-only-sortiment"}))
    db.commit()
    kept = db.query(Product).filter(Product.active.is_(True)).count()
    return {"deactivated": ids, "n_deactivated": len(ids), "n_active": kept}


@router.get("/plotter-only/preview")
def plotter_only_preview(db: Annotated[Session, Depends(get_db)]) -> dict:
    rows = db.query(Product).filter(Product.active.is_(True)).all()
    keep = [r.id for r in rows if (r.cnc or "") == "confirmed"]
    drop = [r.id for r in rows if (r.cnc or "") != "confirmed"]
    return {"keep": sorted(keep), "drop": sorted(drop),
            "n_keep": len(keep), "n_drop": len(drop)}


@router.post("/prices/bulk", response_model=BulkPriceResult)
def bulk_price(body: BulkPriceChange, db: Annotated[Session, Depends(get_db)],
               actor: Annotated[User, Depends(require_staff)]) -> BulkPriceResult:
    """Preisrunde über mehrere Werkstoffe.

    Standardmäßig ein Trockenlauf: die Änderung wird gerechnet und gezeigt,
    aber nicht geschrieben. Eine Preisliste versehentlich um 15 % zu heben und
    es erst am nächsten Angebot zu merken, ist teurer als ein zweiter Klick.
    """
    if (body.pct is None) == (body.set_eur_m2 is None):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Entweder Prozentwert oder Fixpreis angeben, nicht beides.")

    query = db.query(Product).filter(Product.active.is_(True))
    if body.product_ids:
        query = query.filter(Product.id.in_(body.product_ids))
    if body.category:
        query = query.filter(Product.cat == body.category)
    rows = query.order_by(Product.cat, Product.name).all()

    result: list[BulkPriceRow] = []
    for row in rows:
        old = float(row.eur_m2)
        new = round(body.set_eur_m2 if body.set_eur_m2 is not None
                    else old * (1 + body.pct / 100), 4)
        if new <= 0 or abs(new - old) < 1e-9:
            continue
        result.append(BulkPriceRow(id=row.id, name=row.name, old_eur_m2=old, new_eur_m2=new))
        if not body.dry_run:
            _apply_price(db, row, new, body.reason, actor.email)

    if not body.dry_run and result:
        db.add(AuditLog(actor=actor.email, action="price_bulk", entity="product",
                        entity_id=f"{len(result)} Werkstoffe",
                        detail={"pct": body.pct, "set_eur_m2": body.set_eur_m2,
                                "reason": body.reason,
                                "ids": [r.id for r in result][:50]}))
        db.commit()
    return BulkPriceResult(dry_run=body.dry_run, changed=len(result), rows=result)


# --------------------------------------------------------------------------
# Werkstoffmatrix — Preis und Plattenformate aller Werkstoffe auf einem Blatt
# --------------------------------------------------------------------------
def _ab_price(r) -> float:
    """Günstigster Dickensatz (Ab-Preis) — wo keiner vorliegt, der Rückfall."""
    vals = [float(r.eur_m2 or 0)]
    for v in ((r.eur_m2_thk or {}) if isinstance(r.eur_m2_thk, dict) else {}).values():
        try:
            if float(v) > 0:
                vals.append(float(v))
        except (TypeError, ValueError):
            continue
    vals = [v for v in vals if v > 0]
    return min(vals) if vals else 0.0


STANDARD_SHEETS: list[list[float]] = [
    [1000, 1000], [1000, 2000], [1200, 1200], [1500, 1000], [1500, 1500],
    [1500, 2000], [1500, 3000], [2000, 1000], [2000, 1500],
]
"""Die recherchierte Familie handelsüblicher Plattenformate (CLAUDE.md §1.2,
Quellen: McMaster-Carr, DirectIndustry, Gasket Supply, Swift Supplies). Sie sagt,
welche Größen es im Markt gibt — nicht, welche davon Alef-2s Regal führt. Das
steht weiter unter §7 und wird hier gepflegt."""


@router.get("/matrix/view")
def matrix(db: Annotated[Session, Depends(get_db)],
           include_inactive: bool = False) -> dict:
    """Werkstoff × Preis × Plattenformat als ein Raster.

    Das ist die Ansicht, in der Stammdatenpflege tatsächlich stattfindet: man
    vergleicht Preise gegeneinander und sieht auf einen Blick, welcher Werkstoff
    in welchem Format vorrätig ist. Einzelformulare verdecken genau das.
    """
    q = db.query(Product)
    if not include_inactive:
        q = q.filter(Product.active.is_(True))
    rows = q.order_by(Product.cat, Product.name).all()
    return {
        "standard_sheets": STANDARD_SHEETS,
        "rows": [{
            "id": r.id, "name": r.name, "short": r.short, "cat": r.cat,
            "brand": r.brand, "colour": r.colour, "eur_m2": r.eur_m2,
            "eur_m2_thk": r.eur_m2_thk or {},
            "sheets": r.sheets or [], "thicknesses": r.thicknesses or [],
            "stock": r.stock, "lead_days": r.lead_days, "active": r.active,
            "min_stock": int(getattr(r, "min_stock", 0) or 0),
            "target_stock": int(getattr(r, "target_stock", 0) or 0),
            "safety_stock": int(getattr(r, "safety_stock", 1) or 0),
            "auto_reorder": getattr(r, "auto_reorder", "propose") or "propose",
            "preferred_supplier_id": getattr(r, "preferred_supplier_id", None),
            "sku_unit": getattr(r, "sku_unit", "Platte") or "Platte",
            "price_verified": bool((r.verified or {}).get("price")),
            # Fläche × Preis je Format — die Zahl, nach der ein Einkäufer fragt.
            # Wo Dickensätze vorliegen, zählt der günstigste (Ab-Preis).
            "plate_prices": [{"fmt": s, "eur": round(
                s[0] / 1000 * s[1] / 1000 * _ab_price(r), 2)}
                              for s in (r.sheets or [])],
        } for r in rows],
    }


@router.post("/matrix/save", response_model=MatrixSaveResult)
def save_matrix(body: MatrixSave, db: Annotated[Session, Depends(get_db)],
                actor: Annotated[User, Depends(require_staff)]) -> MatrixSaveResult:
    """Mehrere Zeilen der Matrix auf einmal speichern.

    Nur tatsächlich geänderte Felder werden geschrieben — sonst füllt ein
    Klick auf „Speichern“ den Preisverlauf mit Nichtänderungen.
    """
    updated = price_changes = sheet_changes = 0
    for row in body.rows:
        product = db.get(Product, row.id)
        if not product:
            raise HTTPException(status_code=404, detail=f"Werkstoff {row.id} gibt es nicht.")
        touched = False
        if _apply_price(db, product, row.eur_m2, body.reason, actor.email):
            price_changes += 1
            touched = True
        if row.eur_m2_thk is not None:
            known = [float(t) for t in (product.thicknesses or [])]
            unknown = [k for k in row.eur_m2_thk if float(k) not in known]
            if unknown:
                raise HTTPException(status_code=422, detail=(
                    f"{product.name}: Preis für Dicke {', '.join(unknown)} mm, die der Werkstoff nicht führt."))
            if _apply_thk_prices(db, product, row.eur_m2_thk, body.reason, actor.email):
                price_changes += 1
                touched = True
        new_sheets = [[float(w), float(h)] for w, h in row.sheets]
        if new_sheets != [[float(w), float(h)] for w, h in (product.sheets or [])]:
            product.sheets = new_sheets
            sheet_changes += 1
            touched = True
        if touched:
            updated += 1

    if updated:
        db.add(AuditLog(actor=actor.email, action="matrix_save", entity="product",
                        entity_id=f"{updated} Werkstoffe",
                        detail={"price_changes": price_changes,
                                "sheet_changes": sheet_changes,
                                "reason": body.reason}))
        db.commit()
    return MatrixSaveResult(updated=updated, price_changes=price_changes,
                            sheet_changes=sheet_changes)
