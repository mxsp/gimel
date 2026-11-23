"""Transportaufträge: planen, freigeben, zuweisen, fahren, abschließen.

Ein Transport trägt den Auftragskontext als Schnappschuss und den geplanten
Weg. Planen schreibt nichts; jeder Zustandswechsel ist protokolliert. Ein
laufender Transport wird nicht mitten auf dem Weg umgehängt.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import RobotJob, Role, User
from ..security import require_staff, require_worker
from ..services import robot_jobs, robot_ways

router = APIRouter(tags=["robots"])


class JobIn(BaseModel):
    kind: str = "transfer"
    from_station_id: Optional[int] = None
    to_station_id: Optional[int] = None
    work_order_id: Optional[int] = None
    work_order_no: str = ""
    order_no: str = ""
    station_task_id: Optional[int] = None
    robot_id: Optional[int] = None
    priority: int = 5
    payload: dict = Field(default_factory=dict)
    capability: str = "transport"
    note: str = ""
    approve: bool = False
    auto_assign: bool = False


@router.get("/robot-jobs")
def list_jobs(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    state: str = Query(""),
    active: bool = Query(False),
    floor_id: Optional[int] = Query(None),
    order_no: str = Query(""),
    work_order_no: str = Query(""),
) -> dict:
    return {"jobs": robot_jobs.query(
        db, state=state, active_only=active, floor_id=floor_id,
        order_no=order_no, work_order_no=work_order_no,
    )}


@router.post("/robot-jobs/plan")
def plan_job(
    body: JobIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    try:
        return robot_jobs.plan(db, body.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except robot_ways.WayError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/robot-jobs", status_code=201)
def create_job(
    body: JobIn,
    db: Annotated[Session, Depends(get_db)],
    staff: Annotated[User, Depends(require_staff)],
) -> dict:
    try:
        row = robot_jobs.create(db, body.model_dump(exclude_none=True), staff.email)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except robot_ways.WayError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return robot_jobs.as_dict(db, row)


@router.get("/robot-jobs/{job_id}")
def get_job(
    job_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    row = db.get(RobotJob, job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Transport nicht gefunden.")
    return robot_jobs.as_dict(db, row)


def _job_action(db: Session, job_id: int, action: str, actor: str,
                body: Optional[dict] = None) -> dict:
    body = body or {}
    try:
        if action == "approve":
            row = robot_jobs.approve(db, job_id, actor)
        elif action == "assign":
            row = robot_jobs.assign(db, job_id, actor, robot_id=body.get("robot_id"))
        elif action == "start":
            row = robot_jobs.start(db, job_id, actor)
        elif action == "done":
            row = robot_jobs.done(db, job_id, actor, note=str(body.get("note") or ""))
        elif action == "cancel":
            row = robot_jobs.cancel(db, job_id, actor, note=str(body.get("note") or ""))
        elif action == "fail":
            row = robot_jobs.fail(db, job_id, actor, note=str(body.get("note") or ""))
        else:
            raise HTTPException(status_code=404, detail="Unbekannte Aktion.")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return robot_jobs.as_dict(db, row)


@router.post("/robot-jobs/{job_id}/approve")
def approve_job(
    job_id: int,
    db: Annotated[Session, Depends(get_db)],
    staff: Annotated[User, Depends(require_staff)],
) -> dict:
    return _job_action(db, job_id, "approve", staff.email)


class AssignIn(BaseModel):
    robot_id: Optional[int] = None


@router.post("/robot-jobs/{job_id}/assign")
def assign_job(
    job_id: int,
    body: AssignIn,
    db: Annotated[Session, Depends(get_db)],
    staff: Annotated[User, Depends(require_staff)],
) -> dict:
    return _job_action(db, job_id, "assign", staff.email, body.model_dump(exclude_none=True))


class NoteIn(BaseModel):
    note: str = ""


@router.post("/robot-jobs/{job_id}/start")
def start_job(
    job_id: int,
    db: Annotated[Session, Depends(get_db)],
    worker: Annotated[User, Depends(require_worker)],
) -> dict:
    return _job_action(db, job_id, "start", worker.email)


@router.post("/robot-jobs/{job_id}/done")
def done_job(
    job_id: int,
    body: NoteIn,
    db: Annotated[Session, Depends(get_db)],
    worker: Annotated[User, Depends(require_worker)],
) -> dict:
    return _job_action(db, job_id, "done", worker.email, body.model_dump())


@router.post("/robot-jobs/{job_id}/cancel")
def cancel_job(
    job_id: int,
    body: NoteIn,
    db: Annotated[Session, Depends(get_db)],
    staff: Annotated[User, Depends(require_staff)],
) -> dict:
    return _job_action(db, job_id, "cancel", staff.email, body.model_dump())


@router.post("/robot-jobs/{job_id}/fail")
def fail_job(
    job_id: int,
    body: NoteIn,
    db: Annotated[Session, Depends(get_db)],
    worker: Annotated[User, Depends(require_worker)],
) -> dict:
    # „Gescheitert" schließt den Auftrag wie ein Abbruch. Abbrechen darf nur das
    # Büro; die Halle meldet nur einen laufenden Transport als gescheitert.
    if worker.role not in (Role.staff, Role.admin):
        job = db.get(RobotJob, job_id)
        if job is not None and job.state != "running":
            raise HTTPException(
                status_code=403,
                detail="Nur ein laufender Transport kann in der Halle als gescheitert gemeldet werden.",
            )
    return _job_action(db, job_id, "fail", worker.email, body.model_dump())
