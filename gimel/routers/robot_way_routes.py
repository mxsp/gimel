"""Roboterwege aus dem Grundriss — planen und einen gemeldeten Weg prüfen."""

from __future__ import annotations

import math
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..security import require_worker
from ..services import robot_ways

router = APIRouter(tags=["robots"])


class WayIn(BaseModel):
    floor_id: Optional[int] = None
    from_station_id: Optional[int] = None
    to_station_id: Optional[int] = None
    start: Optional[list[float]] = None
    end: Optional[list[float]] = None


class WayCheckIn(BaseModel):
    floor_id: Optional[int] = None
    points: list[list[float]] = Field(default_factory=list, max_length=5000)


class WayOptimizeIn(BaseModel):
    floor_id: Optional[int] = None
    points: list[list[float]] = Field(default_factory=list, max_length=5000)
    loop: bool = False


def _point(values: list[float], label: str) -> tuple[float, float]:
    if len(values) != 2:
        raise HTTPException(status_code=400, detail=f"{label} braucht x und y.")
    try:
        x, y = float(values[0]), float(values[1])
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{label} ist keine Zahl.")
    if not (math.isfinite(x) and math.isfinite(y)):
        raise HTTPException(status_code=400, detail=f"{label} muss endlich sein.")
    if abs(x) > 1_000_000 or abs(y) > 1_000_000:
        raise HTTPException(status_code=400, detail=f"{label} liegt außerhalb der Halle.")
    return x, y


@router.post("/robot-ways/plan")
def plan_way(
    body: WayIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    try:
        if body.from_station_id and body.to_station_id:
            return robot_ways.plan_between_stations(
                db, body.from_station_id, body.to_station_id
            )
        if not body.start or not body.end:
            raise HTTPException(status_code=400,
                                detail="Bitte Start und Ziel oder zwei Stationen angeben.")
        start = _point(body.start, "Start")
        end = _point(body.end, "Ziel")
        return robot_ways.plan_between_points(db, body.floor_id, start, end)
    except robot_ways.WayError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/robot-ways/optimize")
def optimize_way(
    body: WayOptimizeIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Einen Weg vor dem Speichern verbessern — Vorschlag, schreibt nichts."""
    points = [_point(p, f"Punkt {i + 1}") for i, p in enumerate(body.points)]
    if len(points) < 2:
        raise HTTPException(status_code=400,
                            detail="Ein Weg braucht mindestens zwei Punkte.")
    try:
        return robot_ways.optimize_way(db, body.floor_id, points, loop=body.loop)
    except robot_ways.WayError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/robot-ways/check")
def check_way(
    body: WayCheckIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    points = [_point(p, f"Punkt {i + 1}") for i, p in enumerate(body.points)]
    try:
        return robot_ways.check_points(db, body.floor_id, points)
    except robot_ways.WayError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
