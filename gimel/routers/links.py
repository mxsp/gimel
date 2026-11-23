"""Beziehungen eines Belegs: ``GET /api/links/{no}`` (nur lesen, Werker und Büro)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Role, User
from ..security import require_worker
from ..services import links

router = APIRouter(prefix="/api/links", tags=["links"])


@router.get("/{no}")
def related(no: str, db: Annotated[Session, Depends(get_db)],
            user: Annotated[User, Depends(require_worker)]) -> dict:
    """Alle Nachbarn einer Auftrags-, Innenauftrags-, Sammellauf-, Versand- oder
    Reststücknummer, gruppiert, mit dem Weg in die Oberfläche."""
    out = links.related(db, no.strip())
    if out is None:
        raise HTTPException(status_code=404, detail="Nummer unbekannt.")
    # Rechnungen sind Bürosache (TOM: die Halle sieht keine Rechnungen).
    if user.role not in (Role.staff, Role.admin):
        out["groups"] = [g for g in out.get("groups", []) if g.get("kind") != "invoice"]
    return out
