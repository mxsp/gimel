"""Kalkulationssätze. Alle Werte sind bis auf Weiteres Richtwerte (CLAUDE.md §7)."""

from __future__ import annotations

import math
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditLog, Rate, User
from ..schemas import RateOut, RateUpdate
from ..security import require_staff
from ..services.catalog import RATE_FIELDS

router = APIRouter(prefix="/api/rates", tags=["rates"])

# Werte, bei denen ein Tippfehler direkt in einen falschen Preis läuft.
LIMITS = {
    "cut": (0.0, 100.0), "machineH": (0.0, 500.0), "cutSpeed": (1.0, 2000.0),
    "cutThk1": (0.0, 100.0), "cutThk15": (0.0, 100.0),
    "cutThk2": (0.0, 100.0), "cutThk3": (0.0, 100.0),
    "pierceS": (0.0, 30.0), "setupMin": (0.0, 240.0),
    "handlingMinPerPlate": (0.0, 60.0),
    "setupPct": (0.0, 1.0),
    "setupFix1": (0.0, 5000.0), "setupFix2": (0.0, 5000.0), "setupFix3": (0.0, 5000.0),
    "gap": (0.0, 100.0),
    "margin": (0.0, 200.0), "wasteMin": (1.0, 5.0), "wasteMax": (1.0, 10.0),
    "cert31": (0.0, 5000.0), "freight": (0.0, 5000.0), "sheetMarkup": (0.5, 5.0),
    "vat": (0.0, 1.0), "leftoverThreshold": (0.0, 1.0),
}


@router.get("", response_model=list[RateOut])
def list_rates(db: Annotated[Session, Depends(get_db)]) -> list[Rate]:
    return db.query(Rate).order_by(Rate.key).all()


@router.patch("/{key}", response_model=RateOut)
def update_rate(key: str, body: RateUpdate, db: Annotated[Session, Depends(get_db)],
                actor: Annotated[User, Depends(require_staff)]) -> Rate:
    row = db.get(Rate, key)
    if not row:
        raise HTTPException(status_code=404, detail="Diesen Satz gibt es nicht.")
    if not math.isfinite(body.value):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Wert für {key} muss eine endliche Zahl sein.")
    lo, hi = LIMITS.get(key, (None, None))
    if lo is not None and not (lo <= body.value <= hi):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Wert für {key} muss zwischen {lo} und {hi} liegen.")
    if key == "wasteMin":
        cap = db.get(Rate, "wasteMax")
        if cap and body.value > cap.value:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail="Untergrenze des Verschnittfaktors über der Obergrenze.")
    if key == "wasteMax":
        floor = db.get(Rate, "wasteMin")
        if floor and body.value < floor.value:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail="Obergrenze des Verschnittfaktors unter der Untergrenze.")

    old = row.value
    reason = (body.reason or "").strip()
    changed = abs(float(old) - float(body.value)) > 1e-12
    row.value = body.value
    if body.note is not None:
        row.note = body.note
    if body.verified is not None:
        row.verified = body.verified
    elif changed and not reason:
        row.verified = False  # ein neuer Satz ohne Quelle ist wieder ein Richtwert
    row.updated_by = actor.email
    db.add(AuditLog(actor=actor.email, action="rate_update", entity="rate", entity_id=key,
                    detail={"old": old, "new": body.value, "reason": reason,
                            "verified": row.verified}))
    db.commit()
    db.refresh(row)
    return row


@router.get("/{key}/history", dependencies=[Depends(require_staff)])
def rate_history(key: str, db: Annotated[Session, Depends(get_db)], limit: int = 50) -> list[dict]:
    """Verlauf eines Satzes aus dem Audit-Protokoll — wer, wann, von wie viel auf wie viel, warum."""
    rows = (db.query(AuditLog)
              .filter(AuditLog.action == "rate_update", AuditLog.entity_id == key)
              .order_by(AuditLog.at.desc(), AuditLog.id.desc()).limit(max(1, min(limit, 500))).all())
    return [{"at": r.at, "actor": r.actor, "old": (r.detail or {}).get("old"),
             "new": (r.detail or {}).get("new"), "reason": (r.detail or {}).get("reason", "")}
            for r in rows]


@router.get("/engine/keys", response_model=list[str])
def engine_keys() -> list[str]:
    """Welche Sätze der Rechenkern tatsächlich liest — damit im Admin-Panel
    sichtbar ist, welcher Wert wirkt und welcher nur dokumentiert ist."""
    return sorted(RATE_FIELDS.keys())
