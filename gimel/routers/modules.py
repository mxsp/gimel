"""REST API für Gimel-Module und semi-externe Anwendungen (/api/modules)."""

from __future__ import annotations

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import modules as mod_registry
from ..db import get_db
from ..models import User
from ..security import has_admin_work, require_admin, require_worker

router = APIRouter(prefix="/api/modules", tags=["modules"])


class ModuleCreate(BaseModel):
    id: Optional[str] = Field(default=None, max_length=48)
    label: str = Field(min_length=1, max_length=60)
    short_label: str = Field(default="", max_length=20)
    icon: str = Field(default="applications", max_length=40)
    description: str = Field(default="", max_length=240)
    kind: Literal["embedded", "external", "mounted"] = "embedded"
    href: str = Field(default="", max_length=500)
    embed_url: str = Field(default="", max_length=500)
    placement: Literal["switcher", "sidebar", "menu", "hub"] = "hub"
    area: Literal["buero", "leitstand", "beide"] = "beide"
    group: str = Field(default="Erweiterungen", max_length=40)
    roles: list[Literal["admin", "staff", "worker"]] = Field(default_factory=list)
    new_tab: bool = False
    enabled: bool = True
    order: int = Field(default=100, ge=0, le=9999)


class ModulePatch(BaseModel):
    label: Optional[str] = Field(default=None, min_length=1, max_length=60)
    short_label: Optional[str] = Field(default=None, max_length=20)
    icon: Optional[str] = Field(default=None, max_length=40)
    description: Optional[str] = Field(default=None, max_length=240)
    kind: Optional[Literal["embedded", "external", "mounted"]] = None
    href: Optional[str] = Field(default=None, max_length=500)
    embed_url: Optional[str] = Field(default=None, max_length=500)
    placement: Optional[Literal["switcher", "sidebar", "menu", "hub"]] = None
    area: Optional[Literal["buero", "leitstand", "beide"]] = None
    group: Optional[str] = Field(default=None, max_length=40)
    roles: Optional[list[Literal["admin", "staff", "worker"]]] = None
    new_tab: Optional[bool] = None
    enabled: Optional[bool] = None
    order: Optional[int] = Field(default=None, ge=0, le=9999)


def _agent_enabled(request: Request) -> bool:
    return bool(getattr(request.app.state, "agent_enabled", False))


@router.get("")
def list_modules(
    request: Request,
    actor: Annotated[User, Depends(require_worker)],
    db: Annotated[Session, Depends(get_db)],
    all: bool = False,
) -> dict:
    is_admin = has_admin_work(actor)
    effective_role = "admin" if is_admin else actor.role.value
    items = mod_registry.all_modules(
        db,
        agent_enabled=_agent_enabled(request),
        role=None if (all and is_admin) else effective_role,
        include_disabled=bool(all and is_admin),
    )
    return {
        "modules": [m.to_dict() for m in items],
        "can_manage": is_admin,
    }


@router.post("", status_code=status.HTTP_201_CREATED)
def create_module(
    body: ModuleCreate,
    request: Request,
    actor: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    try:
        mid = mod_registry.normalize_slug(body.id or body.label)
        href = mod_registry.validate_url(body.href, allow_empty=(body.kind == "embedded"))
        embed_url = mod_registry.validate_url(body.embed_url, allow_empty=True)
        if body.kind == "embedded" and not embed_url:
            embed_url = href
        if body.kind == "embedded" and not embed_url:
            raise ValueError("Für eingebettete Anwendungen muss eine URL angegeben werden.")
        if not href:
            href = embed_url
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    existing_all = mod_registry.all_modules(
        db, agent_enabled=_agent_enabled(request), include_disabled=True
    )
    if any(m.id == mid for m in existing_all):
        raise HTTPException(status_code=409, detail=f"Modul-ID '{mid}' ist bereits vergeben.")

    db_mods = mod_registry.load_db_modules(db)
    created = mod_registry.AppModule(
        id=mid,
        label=body.label.strip(),
        short_label=(body.short_label or body.label).strip()[:20],
        icon=body.icon.strip() or "applications",
        description=body.description.strip(),
        kind=body.kind,
        href=href,
        embed_url=embed_url,
        placement=body.placement,
        area=body.area,
        group=body.group.strip() or "Erweiterungen",
        roles=tuple(body.roles),
        new_tab=body.new_tab if body.kind != "embedded" else False,
        enabled=body.enabled,
        order=body.order,
        source="db",
    )
    db_mods.append(created)
    mod_registry.save_db_modules(db, db_mods, actor=actor.email)
    return created.to_dict()


@router.patch("/{module_id}")
def update_module(
    module_id: str,
    body: ModulePatch,
    actor: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    db_mods = mod_registry.load_db_modules(db)
    idx = next((i for i, m in enumerate(db_mods) if m.id == module_id), None)
    if idx is None:
        raise HTTPException(
            status_code=404,
            detail="Nur benutzerdefinierte Module können bearbeitet werden.",
        )
    cur = db_mods[idx]
    kind = body.kind or cur.kind
    try:
        href = mod_registry.validate_url(body.href, allow_empty=(kind == "embedded")) if body.href is not None else cur.href
        embed_url = mod_registry.validate_url(body.embed_url, allow_empty=True) if body.embed_url is not None else cur.embed_url
        if kind == "embedded" and not embed_url:
            embed_url = href
        if kind == "embedded" and not embed_url:
            raise ValueError("Für eingebettete Anwendungen muss eine URL angegeben werden.")
        if not href:
            href = embed_url
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    updated = mod_registry.AppModule(
        id=cur.id,
        label=(body.label.strip() if body.label is not None else cur.label),
        short_label=(body.short_label.strip()[:20] if body.short_label is not None else cur.short_label)
            or (body.label.strip()[:20] if body.label is not None else cur.label[:20]),
        icon=(body.icon.strip() or "applications") if body.icon is not None else cur.icon,
        description=body.description.strip() if body.description is not None else cur.description,
        kind=kind,
        href=href,
        embed_url=embed_url,
        placement=body.placement or cur.placement,
        area=body.area or cur.area,
        group=(body.group.strip() or "Erweiterungen") if body.group is not None else cur.group,
        roles=tuple(body.roles) if body.roles is not None else cur.roles,
        new_tab=(body.new_tab if body.new_tab is not None else cur.new_tab) if kind != "embedded" else False,
        enabled=body.enabled if body.enabled is not None else cur.enabled,
        order=body.order if body.order is not None else cur.order,
        source="db",
    )
    db_mods[idx] = updated
    mod_registry.save_db_modules(db, db_mods, actor=actor.email)
    return updated.to_dict()


@router.delete("/{module_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_module(
    module_id: str,
    actor: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    db_mods = mod_registry.load_db_modules(db)
    next_mods = [m for m in db_mods if m.id != module_id]
    if len(next_mods) == len(db_mods):
        raise HTTPException(
            status_code=404,
            detail="Nur benutzerdefinierte Module können entfernt werden.",
        )
    mod_registry.save_db_modules(db, next_mods, actor=actor.email)
