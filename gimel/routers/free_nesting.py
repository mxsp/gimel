"""Freies Schachteln: ein Lauf mit Zeichnungen aus der Bibliothek, ohne Auftrag.

Starten, Stand und beste Lage abfragen, anhalten, ausgeben. Der Lauf lebt im Speicher
(``services/free_nesting.py``), es läuft immer nur einer. Geschrieben wird nur eine Zeile
im Protokoll; Aufträge, Platten, Lager und Plan bleiben unberührt.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditLog, User
from ..security import require_staff
from ..services import free_nesting as fn
from .nesting import BoundedRoute


class FreeRoute(BoundedRoute):
    max_bytes = 256 * 1024
    too_big = "Die Angaben sind zu groß."


router = APIRouter(prefix="/api/free-nesting", tags=["free-nesting"], route_class=FreeRoute)


class PartIn(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    drawing_id: int
    qty: int
    gap: Optional[float] = None


class RunIn(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    sheet_w: float
    sheet_h: float
    spacing: float
    margin: float
    stock: int = 0
    rotations: Literal["0", "180", "90", "45", "15"] = "90"
    gravity: Literal["left", "top"] = "left"
    quality: Literal["draft", "standard", "fine", "mm1", "manual"] = "standard"
    cell: Optional[float] = None
    max_steps: Optional[int] = None
    stall: int = 0
    seed: int = 1
    refine: bool = True
    parts: list[PartIn] = Field(max_length=400)


def _guard(call):
    try:
        return call()
    except fn.FreeNestingError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@router.post("/runs")
def start_run(body: RunIn, db: Annotated[Session, Depends(get_db)],
              actor: Annotated[User, Depends(require_staff)]) -> dict:
    job = _guard(lambda: fn.build_job(db, body.model_dump()))
    try:
        out = fn.start(job, actor.email)
    except fn.Busy:
        raise HTTPException(status_code=409, detail="Es läuft schon ein Lauf. Bitte warten oder ihn anhalten.")
    db.add(AuditLog(actor=actor.email, action="free_nesting_start", entity="free_nesting", entity_id=out["id"],
                    detail={"types": len(job["parts"]), "parts": sum(p["quantity"] for p in job["parts"]),
                            "sheet": [job["sheet"]["width"], job["sheet"]["height"]],
                            "seed": job["seed"], "max_steps": job["maxSteps"]}))
    db.commit()
    return out


@router.get("/runs/{run_id}", dependencies=[Depends(require_staff)])
def get_run(run_id: str, rev: Optional[int] = Query(default=None, ge=0)) -> dict:
    return _guard(lambda: fn.view(run_id, rev))


@router.post("/runs/{run_id}/stop")
def stop_run(run_id: str, db: Annotated[Session, Depends(get_db)],
             actor: Annotated[User, Depends(require_staff)]) -> dict:
    before = _guard(lambda: fn.view(run_id, 0))["status"]
    out = _guard(lambda: fn.stop(run_id))
    if before == "running":
        db.add(AuditLog(actor=actor.email, action="free_nesting_stop", entity="free_nesting",
                        entity_id=run_id, detail={}))
        db.commit()
    return out


_TYPES = {"dxf": "application/dxf", "svg": "image/svg+xml", "json": "application/json"}


@router.get("/runs/{run_id}/export")
def export_run(run_id: str, db: Annotated[Session, Depends(get_db)],
               actor: Annotated[User, Depends(require_staff)],
               format: Literal["dxf", "svg", "json"] = Query(default="dxf"),
               sheet: int = Query(default=1, ge=1, le=1000)) -> Response:
    """DXF je Platte (``sheet`` zählt ab 1), SVG und JSON für den ganzen Lauf. Nur für
    eine Lage, die ``kerf.verify`` bestanden hat. Jede Datei sagt, dass sie kein
    Fertigungsauftrag ist."""
    if format == "dxf":
        text, name = _guard(lambda: fn.export_dxf(run_id, sheet - 1))
    elif format == "svg":
        text, name = _guard(lambda: fn.export_svg(run_id))
    else:
        text, name = _guard(lambda: fn.export_json(run_id))
    db.add(AuditLog(actor=actor.email, action="free_nesting_export", entity="free_nesting",
                    entity_id=run_id, detail={"format": format, "file": name}))
    db.commit()
    return Response(text, media_type=_TYPES[format],
                    headers={"Content-Disposition": f'attachment; filename="{name}"',
                             "Cache-Control": "no-store"})
