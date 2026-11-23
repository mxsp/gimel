"""Lagermanagement: Plattenbestand je Werkstoff, mit Verlauf, Orten und Reststücken.

Der Sammellauf bucht Verbrauch selbst (``services/batch_runner.run_batch``,
Reason ``sammellauf``); dieser Router ist der Weg für Personal — Wareneingang
und Zählkorrekturen. Beide laufen durch ``services.inventory.move_stock``,
damit jede Änderung eine Zeile im Verlauf hinterlässt (CLAUDE.md §9: eine
Änderung ohne Spur ist in diesem Portal nirgends vorgesehen, siehe Preise).

Reststücke (``services/offcuts.py``) sind keine Platten und tauchen in
``stock`` nicht auf; sie haben eigene Zeilen und eigene Zustände.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditLog, FactoryStation, Offcut, Product, StockMovement, User
from ..schemas import StockAdjust, StockMovementOut, StockRow
from ..security import require_staff, require_worker
from ..services import offcuts as offcut_svc
from ..services import stock_locations as stockloc
from ..services.inventory import move_stock
from ..services.numbering import next_number

router = APIRouter(prefix="/api/inventory", tags=["inventory"])


@router.get("", response_model=list[StockRow], dependencies=[Depends(require_worker)])
def list_stock(db: Annotated[Session, Depends(get_db)],
               include_inactive: bool = False) -> list[StockRow]:
    q = db.query(Product)
    if not include_inactive:
        q = q.filter(Product.active.is_(True))
    rows = q.order_by(Product.cat, Product.name).all()

    last = dict(
        db.query(StockMovement.product_id, func.max(StockMovement.created_at))
          .group_by(StockMovement.product_id).all()
    )
    if offcut_svc.refresh(db):
        db.commit()
    offs = dict(
        db.query(Offcut.product_id, func.count(Offcut.id))
          .filter(Offcut.status == "available").group_by(Offcut.product_id).all()
    )
    return [StockRow(id=p.id, name=p.name, short=p.short, cat=p.cat, stock=p.stock,
                     lead_days=p.lead_days, sheets=p.sheets, active=p.active,
                     last_movement_at=last.get(p.id), offcuts=int(offs.get(p.id, 0)))
            for p in rows]


# --------------------------------------------------------------------------
# Reststücke — vor den /{product_id}-Pfaden, sonst fängt jene Route „offcuts"
# --------------------------------------------------------------------------
class OffcutIn(BaseModel):
    mat: str = Field(min_length=1, max_length=60)
    thk: float = Field(gt=0, le=500)
    w: float = Field(gt=0, le=20_000)
    h: float = Field(gt=0, le=20_000)
    station_id: Optional[int] = None
    bin: str = Field("", max_length=80)
    note: str = Field("", max_length=200)


class OffcutPatch(BaseModel):
    station_id: Optional[int] = None
    bin: Optional[str] = Field(None, max_length=80)
    note: Optional[str] = Field(None, max_length=200)
    w: Optional[float] = Field(None, gt=0, le=20_000)
    h: Optional[float] = Field(None, gt=0, le=20_000)
    #: Nur diese Übergänge von Hand: aussondern, oder ein ausgesondertes zurück.
    status: Optional[Literal["available", "scrapped"]] = None
    #: ``station_id`` ausdrücklich leeren (None allein heißt „nicht ändern").
    clear_station: bool = False


def _check_station(db: Session, station_id: Optional[int]) -> None:
    if station_id is None:
        return
    st = db.get(FactoryStation, station_id)
    if st is None:
        raise HTTPException(404, "Station unbekannt.")
    if not st.is_storage:
        raise HTTPException(422, f"{st.label} ist kein Lager.")


@router.get("/offcuts")
def list_offcuts(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    mat: Optional[str] = Query(default=None, max_length=60),
    status: Optional[str] = Query(default=None, max_length=40),
    limit: int = Query(default=300, ge=1, le=1000),
) -> dict:
    """Reststücke, neueste zuerst. ``status`` als Komma-Liste; Vorgabe: alles
    außer verbraucht und ausgesondert."""
    if offcut_svc.refresh(db):
        db.commit()
    wanted = ([s.strip() for s in status.split(",") if s.strip()] if status
              else ["pending", "available", "reserved"])
    bad = [s for s in wanted if s not in offcut_svc.STATUSES]
    if bad:
        raise HTTPException(422, "Unbekannter Zustand: " + ", ".join(bad))
    q = db.query(Offcut).filter(Offcut.status.in_(wanted))
    if mat:
        q = q.filter(Offcut.product_id == mat)
    rows = q.order_by(Offcut.id.desc()).limit(limit).all()
    where = stockloc._where(db)
    totals = dict(db.query(Offcut.status, func.count(Offcut.id)).group_by(Offcut.status).all())
    return {
        "offcuts": [offcut_svc.row_out(r, where) for r in rows],
        "totals": {s: int(totals.get(s, 0)) for s in offcut_svc.STATUSES},
        "config": offcut_svc.config(db),
    }


@router.post("/offcuts")
def create_offcut(body: OffcutIn, db: Annotated[Session, Depends(get_db)],
                  actor: Annotated[User, Depends(require_staff)]) -> dict:
    """Ein Reststück von Hand erfassen — etwa eines, das vor dieser Funktion
    schon im Regal lag. Es ist sofort verfügbar."""
    if db.get(Product, body.mat) is None:
        raise HTTPException(404, "Werkstoff nicht gefunden.")
    _check_station(db, body.station_id)
    now = datetime.now(timezone.utc)
    row = Offcut(code=next_number(db, "offcut", "R-"), product_id=body.mat, thk=body.thk,
                 w=round(body.w, 1), h=round(body.h, 1), status="available",
                 station_id=body.station_id, bin=body.bin.strip(), note=body.note.strip(),
                 available_at=now, updated_by=actor.email)
    db.add(row)
    db.flush()
    db.add(AuditLog(actor=actor.email, action="offcut_create", entity="offcut",
                    entity_id=row.code, detail={"mat": body.mat, "thk": body.thk,
                                                "w": row.w, "h": row.h}))
    db.commit()
    return offcut_svc.row_out(row, stockloc._where(db))


@router.patch("/offcuts/{offcut_id}")
def update_offcut(offcut_id: int, body: OffcutPatch, db: Annotated[Session, Depends(get_db)],
                  actor: Annotated[User, Depends(require_staff)]) -> dict:
    row = db.get(Offcut, offcut_id)
    if row is None:
        raise HTTPException(404, "Reststück nicht gefunden.")
    before = offcut_svc.row_out(row)
    if body.status is not None and body.status != row.status:
        allowed = {"scrapped": ("available", "pending"), "available": ("scrapped",)}
        if row.status not in allowed[body.status]:
            raise HTTPException(409, f"{row.code} ist {row.status} — so nicht änderbar.")
        row.status = body.status
        if body.status == "available" and row.available_at is None:
            row.available_at = datetime.now(timezone.utc)
    if body.clear_station:
        row.station_id = None
    elif body.station_id is not None:
        _check_station(db, body.station_id)
        row.station_id = body.station_id
    if body.bin is not None:
        row.bin = body.bin.strip()
    if body.note is not None:
        row.note = body.note.strip()
    if body.w is not None or body.h is not None:
        if row.status not in ("available", "pending", "scrapped"):
            raise HTTPException(409, f"{row.code} ist {row.status} — Maße sind verplant.")
        row.w = round(body.w, 1) if body.w is not None else row.w
        row.h = round(body.h, 1) if body.h is not None else row.h
    row.updated_by = actor.email
    after = offcut_svc.row_out(row)
    changed = {k: [before[k], after[k]] for k in ("status", "station_id", "bin", "note", "w", "h")
               if before[k] != after[k]}
    if changed:
        db.add(AuditLog(actor=actor.email, action="offcut_update", entity="offcut",
                        entity_id=row.code, detail=changed))
    db.commit()
    return offcut_svc.row_out(row, stockloc._where(db))


# --------------------------------------------------------------------------
# Je Werkstoff
# --------------------------------------------------------------------------
@router.get("/{product_id}/movements", response_model=list[StockMovementOut],
            dependencies=[Depends(require_staff)])
def stock_movements(product_id: str, db: Annotated[Session, Depends(get_db)],
                    limit: int = 100) -> list[StockMovement]:
    if not db.get(Product, product_id):
        raise HTTPException(status_code=404, detail="Werkstoff nicht gefunden.")
    return (db.query(StockMovement)
              .filter(StockMovement.product_id == product_id)
              .order_by(StockMovement.created_at.desc()).limit(min(limit, 500)).all())


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@router.get("/{product_id}/timeline", dependencies=[Depends(require_staff)])
def stock_timeline(product_id: str, db: Annotated[Session, Depends(get_db)],
                   days: int = Query(default=90, ge=7, le=730)) -> dict:
    """Bestand je Tag über ``days`` Tage, mit Zu- und Abgang.

    Rückwärts vom heutigen Bestand gerechnet, nicht aus ``balance_after``: so
    stimmt der letzte Punkt immer mit der Lagerzeile überein, auch wenn eine
    alte Buchung einmal falsch stand. Dazu der mittlere Verbrauch und die
    Reichweite — eine Schätzung aus der Vergangenheit, kein Versprechen."""
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Werkstoff nicht gefunden.")
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=days - 1)
    start_dt = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    from sqlalchemy import case

    day_expr = func.date(StockMovement.created_at)
    daily_rows = (
        db.query(
            day_expr.label("d"),
            func.coalesce(func.sum(StockMovement.delta), 0),
            func.coalesce(func.sum(case((StockMovement.delta > 0, StockMovement.delta), else_=0)), 0),
            func.coalesce(func.sum(case((StockMovement.delta < 0, -StockMovement.delta), else_=0)), 0),
            func.coalesce(
                func.sum(
                    case(
                        ((StockMovement.delta < 0) & (StockMovement.reason == "sammellauf"), -StockMovement.delta),
                        else_=0,
                    )
                ),
                0,
            ),
            func.coalesce(
                func.sum(
                    case(
                        ((StockMovement.delta > 0) & (StockMovement.reason == "storno"), StockMovement.delta),
                        else_=0,
                    )
                ),
                0,
            ),
            func.coalesce(
                func.sum(
                    case(
                        ((StockMovement.delta > 0) & (StockMovement.reason != "storno"), StockMovement.delta),
                        else_=0,
                    )
                ),
                0,
            ),
        )
        .filter(StockMovement.product_id == product_id, StockMovement.created_at >= start_dt)
        .group_by(day_expr)
        .all()
    )
    stock_now = int(product.stock or 0)
    total_delta = 0
    consumed = 0
    returned = 0
    received = 0
    per_day: dict[str, dict[str, int]] = {}
    for d_val, net_d, in_d, out_d, cons_d, ret_d, rec_d in daily_rows:
        d_key = d_val.isoformat() if hasattr(d_val, "isoformat") else str(d_val)
        per_day[d_key] = {"in": int(in_d or 0), "out": int(out_d or 0)}
        total_delta += int(net_d or 0)
        consumed += int(cons_d or 0)
        returned += int(ret_d or 0)
        received += int(rec_d or 0)
    opening = stock_now - total_delta

    points = []
    bal = opening
    for i in range(days):
        d_str = (start + timedelta(days=i)).isoformat()
        slot = per_day.get(d_str, {"in": 0, "out": 0})
        bal += slot["in"] - slot["out"]
        points.append({"day": d_str, "balance": bal, "in": slot["in"], "out": slot["out"]})

    net_use = max(0, consumed - returned)
    per_day_use = net_use / days
    reach = (stock_now / per_day_use) if per_day_use > 0 and stock_now > 0 else None

    offs_counts = dict(
        db.query(Offcut.status, func.count(Offcut.id))
        .filter(
            Offcut.product_id == product_id,
            Offcut.status.in_(("pending", "available", "reserved")),
        )
        .group_by(Offcut.status)
        .all()
    )
    return {
        "mat": product_id,
        "days": days,
        "stock": stock_now,
        "opening": opening,
        "points": points,
        "received": received,
        "consumed": net_use,
        "avg_per_day": round(per_day_use, 3),
        "reach_days": round(reach, 1) if reach is not None else None,
        "lead_days": int(product.lead_days or 0),
        "offcuts": {
            s: int(offs_counts.get(s, 0)) for s in ("pending", "available", "reserved")
        },
    }


@router.post("/{product_id}/adjust", response_model=StockMovementOut)
def adjust_stock(product_id: str, body: StockAdjust, db: Annotated[Session, Depends(get_db)],
                 actor: Annotated[User, Depends(require_staff)]) -> StockMovement:
    row = db.get(Product, product_id)
    if not row:
        raise HTTPException(status_code=404, detail="Werkstoff nicht gefunden.")
    movement = move_stock(db, row, body.delta, reason=body.reason, actor=actor.email,
                          note=body.note)
    db.add(AuditLog(actor=actor.email, action="stock_adjust", entity="product",
                    entity_id=product_id,
                    detail={"delta": body.delta, "reason": body.reason, "note": body.note}))
    db.commit()
    db.refresh(movement)
    return movement
