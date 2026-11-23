"""Schachtel-Editor: Plattenbelegung eines Innenauftrags sehen und von Hand ändern."""

from __future__ import annotations

from typing import Annotated, Callable, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User, WorkOrder
from ..security import require_staff
from ..services import plate_edit
from ..services.plate_edit import LayoutError

T = TypeVar("T")
#: Eine Belegung mit 40 000 Teilen. Mehr ist kein Editor, und die Pydantic-Grenzen je
#: Liste multiplizieren sich zu Millionen Teilen, bevor eine Zeile Prüfung läuft.
MAX_BODY_BYTES = 2 * 1024 * 1024


class BoundedRoute(APIRoute):
    """Liest den Rumpf selbst und bricht ab, bevor er ganz im Speicher liegt. Eine
    Abhängigkeit käme zu spät: FastAPI parst zuerst. Zählt auch ohne Content-Length.
    Andere Router erben davon und setzen ``too_big`` und gegebenenfalls ``max_bytes``."""

    too_big = "Diese Belegung ist zu groß."
    max_bytes = MAX_BODY_BYTES

    def get_route_handler(self) -> Callable:
        inner = super().get_route_handler()

        async def handler(request: Request):
            if request.method in ("POST", "PUT", "PATCH"):
                too_big = HTTPException(status_code=413, detail=self.too_big)
                declared = request.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > self.max_bytes:
                    raise too_big
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > self.max_bytes:
                        raise too_big
                    chunks.append(chunk)
                request._body = b"".join(chunks)
            return await inner(request)

        return handler


router = APIRouter(prefix="/api/production/work-orders", tags=["nesting"], route_class=BoundedRoute)


class PlacementIn(BaseModel):
    tag: str = Field(max_length=20)
    cx: float
    cy: float
    rot: float = 0.0


class PlateIn(BaseModel):
    fmt: list[float] = Field(min_length=2, max_length=2)
    turned: bool = False
    placements: list[PlacementIn] = Field(max_length=5000)


class LayoutIn(BaseModel):
    plates: list[PlateIn] = Field(min_length=1, max_length=plate_edit.MAX_PLATES)


class SaveIn(LayoutIn):
    version: str = Field(max_length=32)


class ResetIn(BaseModel):
    version: str = Field(max_length=32)


def _wo(db: Session, no: str) -> WorkOrder:
    wo = db.query(WorkOrder).filter(WorkOrder.no == no).first()
    if not wo:
        raise HTTPException(status_code=404, detail="Innenauftrag nicht gefunden.")
    return wo


def _plain(body: LayoutIn) -> list[dict]:
    return [p.model_dump() for p in body.plates]


def _guard(call: Callable[[], T]) -> T:
    try:
        return call()
    except LayoutError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@router.get("/{no}/layout", dependencies=[Depends(require_staff)])
def get_layout(no: str, db: Annotated[Session, Depends(get_db)]) -> dict:
    return plate_edit.load_layout(db, _wo(db, no))


@router.post("/{no}/layout/check", dependencies=[Depends(require_staff)])
def check_layout(no: str, body: LayoutIn, db: Annotated[Session, Depends(get_db)]) -> dict:
    """Prüft mit exakter Geometrie und speichert nichts."""
    return _guard(lambda: plate_edit.check_layout(db, _wo(db, no), _plain(body)))


@router.post("/{no}/layout/auto", dependencies=[Depends(require_staff)])
def auto_layout(no: str, db: Annotated[Session, Depends(get_db)]) -> dict:
    """Ein Vorschlag des Rechenkerns für den Editor. Speichert nichts."""
    return _guard(lambda: plate_edit.auto_layout(db, _wo(db, no)))


@router.put("/{no}/layout")
def save_layout(
    no: str, body: SaveIn, db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    return _guard(lambda: plate_edit.save_layout(db, _wo(db, no), _plain(body), body.version, actor.email))


@router.post("/{no}/layout/reset")
def reset_layout(
    no: str, body: ResetIn, db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    return _guard(lambda: plate_edit.reset_layout(db, _wo(db, no), body.version, actor.email))
