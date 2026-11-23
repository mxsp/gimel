"""Roboterprogramme und Auslieferungen — versioniert, geprüft, nie ausgeführt.

Der Text ist ein Artefakt. Gimel speichert Version und Prüfsumme, liefert an
das Gateway aus und hält jeden Versuch fest, auch den abgelehnten. Zurücknehmen
ist eine neue Auslieferung, keine stille Rückdatierung.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import RobotDeployment, RobotProgram, User
from ..security import require_admin, require_worker
from ..services import robot_programs

router = APIRouter(tags=["robots"])


class ProgramIn(BaseModel):
    name: str
    kind: str = "mission"
    language: str = "json"
    body: str = ""
    robot_id: Optional[int] = None
    gateway_id: str = ""
    notes: str = ""


class DeployIn(BaseModel):
    robot_id: int


@router.get("/robot-programs")
def list_programs(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    status: str = Query(""),
    limit: int = Query(200),
) -> dict:
    q = db.query(RobotProgram).order_by(
        RobotProgram.name.asc(),
        RobotProgram.version.desc(),
    )
    if status:
        q = q.filter(RobotProgram.status == status)
    rows = q.limit(max(1, min(500, limit))).all()
    return {"programs": [
        robot_programs.program_dict(db, r, include_body=False) for r in rows
    ]}


@router.post("/robot-programs", status_code=201)
def create_program(
    body: ProgramIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict:
    try:
        row = robot_programs.create_version(
            db, name=body.name, body=body.body, actor=admin.email,
            kind=body.kind, language=body.language, robot_id=body.robot_id,
            gateway_id=body.gateway_id, notes=body.notes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return robot_programs.program_dict(db, row)


@router.post("/robot-programs/{program_id}/approve")
def approve_program(
    program_id: int,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict:
    try:
        row = robot_programs.approve(db, program_id, admin.email)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return robot_programs.program_dict(db, row)


@router.post("/robot-programs/{program_id}/deploy", status_code=201)
def deploy_program(
    program_id: int,
    body: DeployIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict:
    try:
        row = robot_programs.deploy(db, program_id, robot_id=body.robot_id, actor=admin.email)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return robot_programs.deployment_dict(db, row)


@router.get("/robot-deployments")
def list_deployments(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    limit: int = Query(100),
) -> dict:
    rows = (
        db.query(RobotDeployment)
        .order_by(RobotDeployment.id.desc())
        .limit(max(1, min(500, limit)))
        .all()
    )
    return {"deployments": [robot_programs.deployment_dict(db, r) for r in rows]}


@router.post("/robot-deployments/{deployment_id}/rollback", status_code=201)
def rollback_deployment(
    deployment_id: int,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict:
    try:
        row = robot_programs.rollback(db, deployment_id, admin.email)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return robot_programs.deployment_dict(db, row)
