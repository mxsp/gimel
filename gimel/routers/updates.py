"""GitHub Release update endpoints (/api/updates)."""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditLog, User
from ..security import current_user, has_admin_work, require_admin
from ..services import updater

router = APIRouter(prefix="/api/updates", tags=["updates"])


class ApplyUpdateRequest(BaseModel):
    tag: Optional[str] = None
    rebuild_web: bool = True
    auto_restart: bool = True


@router.get("/status")
def update_status(
    user: Annotated[User, Depends(current_user)],
    force: bool = Query(default=False),
) -> dict:
    # Only admins may bypass the 6h GitHub API cache.
    allow_force = bool(force and has_admin_work(user))
    return updater.check_for_update(force=allow_force).to_dict()


@router.post("/apply")
def apply_release_update(
    body: ApplyUpdateRequest,
    actor: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    try:
        result = updater.apply_update(
            target_tag=body.tag,
            rebuild_web=body.rebuild_web,
            auto_restart=body.auto_restart,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Update fehlgeschlagen: {exc}") from exc

    db.add(
        AuditLog(
            actor=actor.email,
            action="system_update",
            entity="system",
            entity_id=result.to_version,
            detail={
                "ok": result.ok,
                "install_kind": result.install_kind,
                "from": result.from_version,
                "to": result.to_version,
                "restart_required": result.restart_required,
                "restarting": result.restarting,
            },
        )
    )
    db.commit()
    return result.to_dict()


@router.post("/restart")
def restart_server(
    actor: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    ok = updater.schedule_restart()
    db.add(
        AuditLog(
            actor=actor.email,
            action="system_restart",
            entity="system",
            entity_id="server",
            detail={"scheduled": ok},
        )
    )
    db.commit()
    return {
        "ok": ok,
        "restarting": ok,
        "detail": "Gimel startet neu…" if ok else "Automatischer Neustart wird im Container über Docker ausgeführt.",
    }
