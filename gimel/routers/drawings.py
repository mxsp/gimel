"""Zeichnungsbibliothek des freien Schachtelns: Konturen ohne Auftrag ablegen und suchen.

Dateien kommen als roher Körper (nie als Formular, nie auf eine Platte) und werden
auf 2 MiB begrenzt, bevor ein Parser sie sieht. Nur Personal und Admin.
"""

from __future__ import annotations

from typing import Annotated, Callable, Optional, TypeVar
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..security import require_staff
from ..services import drawings
from ..services.drawings import DrawingError
from .nesting import BoundedRoute

T = TypeVar("T")


class DrawingRoute(BoundedRoute):
    too_big = "Die Datei ist größer als 2 MiB."


router = APIRouter(prefix="/api/drawings", tags=["drawings"], route_class=DrawingRoute)

Point = Annotated[list[float], Field(min_length=2, max_length=2)]


class PointsIn(BaseModel):
    """Entweder ``text`` (x,y-Paare, Leerzeile vor jeder Aussparung) oder ``outer`` und ``holes``."""
    model_config = ConfigDict(allow_inf_nan=False)

    name: str = Field(default="", max_length=200)
    note: str = Field(default="", max_length=500)
    text: Optional[str] = Field(default=None, max_length=400_000)
    outer: Optional[list[Point]] = Field(default=None, max_length=drawings.MAX_RING_VERTICES + 1)
    holes: list[Annotated[list[Point], Field(max_length=drawings.MAX_RING_VERTICES + 1)]] = Field(
        default_factory=list, max_length=drawings.MAX_RINGS)


class RenameIn(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    note: Optional[str] = Field(default=None, max_length=500)


def _guard(call: Callable[[], T]) -> T:
    try:
        return call()
    except DrawingError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@router.get("", dependencies=[Depends(require_staff)])
def list_drawings(db: Annotated[Session, Depends(get_db)],
                  q: str = Query(default="", max_length=80),
                  limit: int = Query(default=200, ge=1, le=500),
                  offset: int = Query(default=0, ge=0, le=100_000)) -> dict:
    return drawings.search(db, q, limit, offset)


@router.get("/{drawing_id}", dependencies=[Depends(require_staff)])
def get_drawing(drawing_id: int, db: Annotated[Session, Depends(get_db)]) -> dict:
    return _guard(lambda: drawings.to_dict(drawings.get(db, drawing_id), full=True))


@router.post("")
def create_from_points(body: PointsIn, db: Annotated[Session, Depends(get_db)],
                       actor: Annotated[User, Depends(require_staff)]) -> dict:
    def run() -> dict:
        if body.text is not None:
            if body.outer is not None:
                raise DrawingError("Entweder Text oder Außenkontur angeben, nicht beides.")
            parsed = drawings.parse_points(body.text)
        elif body.outer is not None:
            parsed = drawings.Parsed(shapes=[(body.outer, body.holes)])
        else:
            raise DrawingError("Punkte fehlen.")
        return drawings.store(db, parsed, "points", body.name, body.note, actor.email)

    return _guard(run)


async def _import(request: Request, db: Session, actor: User, kind: str,
                  parse: Callable[[bytes], drawings.Parsed], x_name: str, note: str) -> dict:
    data = await request.body()
    if not data.strip():
        raise HTTPException(status_code=422, detail="Die Datei ist leer.")

    def run() -> dict:
        parsed = parse(data)
        return drawings.store(db, parsed, kind, unquote(x_name)[:300], note, actor.email)

    return await run_in_threadpool(_guard, run)


@router.post("/import/dxf")
async def import_dxf(request: Request, db: Annotated[Session, Depends(get_db)],
                     actor: Annotated[User, Depends(require_staff)],
                     x_name: Annotated[str, Header(max_length=600)] = "",
                     note: str = Query(default="", max_length=500)) -> dict:
    return await _import(request, db, actor, "dxf", drawings.parse_dxf,
                         x_name, note)


@router.post("/import/svg")
async def import_svg(request: Request, db: Annotated[Session, Depends(get_db)],
                     actor: Annotated[User, Depends(require_staff)],
                     x_name: Annotated[str, Header(max_length=600)] = "",
                     note: str = Query(default="", max_length=500)) -> dict:
    return await _import(request, db, actor, "svg", drawings.parse_svg,
                         x_name, note)


@router.patch("/{drawing_id}")
def rename_drawing(drawing_id: int, body: RenameIn, db: Annotated[Session, Depends(get_db)],
                   actor: Annotated[User, Depends(require_staff)]) -> dict:
    return _guard(lambda: drawings.to_dict(
        drawings.rename(db, drawing_id, body.name, body.note, actor.email), full=True))


@router.delete("/{drawing_id}")
def delete_drawing(drawing_id: int, db: Annotated[Session, Depends(get_db)],
                   actor: Annotated[User, Depends(require_staff)]) -> dict:
    _guard(lambda: drawings.delete(db, drawing_id, actor.email))
    return {"deleted": drawing_id}
