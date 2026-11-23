"""Nahtstelle zu SAP/ERP — Plattenstamm und Bestand.

Drei Dinge, die ein Zwei-Mann-Betrieb mit SAP nicht braucht: doppelte Pflege,
stille Ueberschreibungen und einen Stillstand, wenn SAP haengt.

Deshalb:

* **Lesen ist billig** — ``GET /plates`` und ``GET /stock`` zeigen, was SAP
  meldet, neben dem, was Alef-2 fuehrt. Keine Automatik, nur Vergleich.
* **Schreiben ist sichtbar** — ``POST /sync`` erzeugt normale Korrekturbuchungen,
  die im Lagerverlauf stehen wie jede Handkorrektur.
* **Adapter austauschbar** — ``SapRestAdapter`` hinter ENV ``SAP_BASE_URL``. Die
  Routen bleiben gleich.
* **Ohne Adapter nichts vorspielen** — die Routen bleiben erreichbar, damit die
  Oberfläche fragen kann, und antworten ``configured: false``. Lesen ist dann
  leer, ``POST /sync`` lehnt mit 503 ab.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Product, User
from ..security import require_staff
from ..services.erp_sync import (
    NOT_CONFIGURED,
    ERPNotConfigured,
    get_adapter,
    sync_from_erp,
)

router = APIRouter(prefix="/api/integration", tags=["integration"])


class SyncIn(BaseModel):
    mats: Optional[list[str]] = None


def _unbuilt(exc: NotImplementedError) -> HTTPException:
    """``SAP_BASE_URL`` gesetzt, der Adapter ist aber noch ein Skelett."""
    return HTTPException(status_code=501, detail=str(exc))


@router.get("/health", dependencies=[Depends(require_staff)])
def health(db: Annotated[Session, Depends(get_db)]):
    adapter = get_adapter(db)
    return adapter.health() if adapter else NOT_CONFIGURED


@router.get("/stock", dependencies=[Depends(require_staff)])
def stock(db: Annotated[Session, Depends(get_db)], mats: str = Query(default="")):
    adapter = get_adapter(db)
    if adapter is None:
        return {"configured": False, "items": []}
    filt = [m.strip() for m in mats.split(",") if m.strip()] or None
    try:
        levels = adapter.fetch_stock(filt)
    except NotImplementedError as exc:
        raise _unbuilt(exc)
    local = {p.id: int(p.stock) for p in db.query(Product).all()}
    return {
        "configured": True,
        "items": [
            {
                "mat": r.mat,
                "erp": r.stock,
                "alpha": local.get(r.mat, 0),
                "delta": r.stock - local.get(r.mat, 0),
                "source": r.source,
            }
            for r in levels
        ],
    }


@router.get("/plates", dependencies=[Depends(require_staff)])
def plates(db: Annotated[Session, Depends(get_db)], mats: str = Query(default="")):
    adapter = get_adapter(db)
    if adapter is None:
        return {"configured": False, "items": []}
    filt = [m.strip() for m in mats.split(",") if m.strip()] or None
    try:
        items = adapter.fetch_plates(filt)
    except NotImplementedError as exc:
        raise _unbuilt(exc)
    return {
        "configured": True,
        "items": [
            {"mat": p.mat, "sheets": p.sheets, "lead_days": p.lead_days} for p in items
        ],
    }


@router.post("/sync")
def sync(
    body: SyncIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
):
    """Im Protokoll und im Lagerverlauf steht, wer angemeldet ist. Bis 2026-10-31 kam
    der Name aus dem Request; was ein Client selbst angibt, belegt nichts."""
    try:
        return sync_from_erp(db, actor=user.email, mats=body.mats)
    except ERPNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except NotImplementedError as exc:
        raise _unbuilt(exc)
