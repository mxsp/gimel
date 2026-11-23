"""Transportaufträge mit Auftragskontext — planen, zuweisen, fahren, abschließen.

Ein Transport ist kein zweiter Arbeitsvorrat. Er entsteht aus einem
Innenauftrag, einer Kundenposition oder einer Stationsaufgabe, trägt deren
Nummern als Schnappschuss mit und wird dann zu einem hochstufigen Auftrag an
die Flotte. Der Zustandsautomat ist absichtlich klein:

    proposed → approved → assigned → running → done
                     ↘ cancelled / failed

Jeder Wechsel schreibt eine Protokollzeile. Ein simulierter Roboter fährt den
geplanten Weg in der Halle; ein echtes Gateway bekommt denselben Weg als
Auftrag. Gimel sendet nie Geschwindigkeit oder Gelenkwinkel.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..core import robot_state
from ..core.robot_dispatch import rank_robots
from ..models import (
    AuditLog,
    FactoryStation,
    Order,
    RobotAsset,
    RobotGateway,
    RobotJob,
    RobotJobRestore,
    StationTask,
    WorkItem,
    WorkOrder,
)
from . import robot_gateway, robot_ways

JOB_KINDS = ("pickup", "delivery", "transfer", "return")
JOB_STATES = ("proposed", "approved", "assigned", "running", "done", "failed", "cancelled")
ACTIVE_STATES = ("proposed", "approved", "assigned", "running")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp(now: Optional[datetime] = None) -> datetime:
    """Der einzige Zeitgeber dieser Datei; ein Aufrufer darf die Zeit vorgeben."""
    return now or _now()


def _busy(db: Session, robot_id: int, *, exclude_job_id: Optional[int] = None) -> bool:
    """Fährt dieser Roboter schon einen offenen Transport?"""
    query = (
        db.query(RobotJob.id)
        .filter(RobotJob.robot_id == robot_id)
        .filter(RobotJob.state.in_(("assigned", "running")))
    )
    if exclude_job_id is not None:
        query = query.filter(RobotJob.id != exclude_job_id)
    return query.first() is not None


def _iso(value: Optional[datetime]) -> str:
    return value.isoformat() if value else ""


def _audit(db: Session, actor: str, action: str, row: RobotJob,
           *, detail: Optional[dict] = None) -> None:
    body = {"ref": row.ref, "state": row.state, "order": row.order_no,
            "work_order": row.work_order_no}
    if detail:
        body.update(detail)
    db.add(AuditLog(actor=actor, action=action, entity="robot_job",
                    entity_id=str(row.id), detail=body))


def _first_station(db: Session, *, storage: bool = False,
                   type_value: str = "") -> Optional[FactoryStation]:
    query = db.query(FactoryStation).filter(FactoryStation.active.is_(True))
    if storage:
        query = query.filter(FactoryStation.is_storage.is_(True))
    if type_value:
        query = query.filter(FactoryStation.type == type_value)
    return query.order_by(FactoryStation.id.asc()).first()


def _context(db: Session, *, work_order: Optional[WorkOrder] = None,
             task: Optional[StationTask] = None, order_no: str = "") -> dict:
    """Was der Transport über seinen Auftrag weiß — ohne Personenbezug."""
    data: dict = {}
    order_nos: set[str] = set()
    if work_order is not None:
        items = db.query(WorkItem).filter(WorkItem.work_order_id == work_order.id).all()
        order_nos |= {i.order_no for i in items if i.order_no}
        data.update(
            {
                "work_order_no": work_order.no,
                "material": work_order.mat,
                "material_name": work_order.mat_name,
                "thickness": float(work_order.thk or 0.0),
                "plates": int(work_order.n_plates or 0),
                "parts": int(work_order.n_parts or 0),
                "due_date": _iso(work_order.due_date),
                "scope": work_order.route_scope or "",
                "work_order_status": (
                    work_order.status.value if hasattr(work_order.status, "value")
                    else str(work_order.status or "")
                ),
            }
        )
    if order_no:
        order_nos.add(order_no)
    if order_nos:
        rows = db.query(Order).filter(Order.no.in_(sorted(order_nos))).all()
        data["order_nos"] = sorted(order_nos)
        data["rush"] = any(bool(o.rush) for o in rows)
        dues = [o.due_date for o in rows if o.due_date]
        if dues:
            earliest = min(dues)
            if not data.get("due_date") or _iso(earliest) < data["due_date"]:
                data["due_date"] = _iso(earliest)
        refs = sorted({o.customer_ref for o in rows if o.customer_ref})
        if refs:
            data["customer_refs"] = refs
    if task is not None:
        data["task"] = {
            "id": task.id,
            "kind": task.kind,
            "ref": task.ref,
            "label": task.label,
            "units": int(task.units or 0),
            "station_id": task.station_id,
            "to_station_id": task.to_station_id,
        }
    return data


def _resolve(db: Session, body: dict) -> dict:
    task: Optional[StationTask] = None
    if body.get("station_task_id"):
        task = db.get(StationTask, int(body["station_task_id"]))
        if task is None:
            raise ValueError("Aufgabe nicht gefunden.")
    work_order: Optional[WorkOrder] = None
    if body.get("work_order_id"):
        work_order = db.get(WorkOrder, int(body["work_order_id"]))
        if work_order is None:
            raise ValueError("Innenauftrag nicht gefunden.")
    elif body.get("work_order_no"):
        work_order = (
            db.query(WorkOrder)
            .filter(WorkOrder.no == str(body["work_order_no"]).strip())
            .first()
        )
        if work_order is None:
            raise ValueError("Innenauftrag nicht gefunden.")
    if work_order is None and task is not None and task.kind in ("pick", "cut"):
        work_order = db.query(WorkOrder).filter(WorkOrder.no == task.ref).first()
    order_no = str(body.get("order_no") or "").strip()
    order: Optional[Order] = None
    if order_no:
        order = db.query(Order).filter(Order.no == order_no).first()
        if order is None:
            raise ValueError("Auftrag nicht gefunden.")
    ctx = _context(db, work_order=work_order, task=task, order_no=order_no)

    from_id = body.get("from_station_id") or (task.station_id if task else None)
    to_id = body.get("to_station_id") or (task.to_station_id if task else None)
    if to_id is None and work_order is not None:
        to_id = work_order.station_id
    kind = str(body.get("kind") or "transfer").strip().lower()
    if kind not in JOB_KINDS:
        raise ValueError("Transportart muss pickup, delivery, transfer oder return sein.")
    if task is not None and to_id is None and task.kind == "cut":
        shipping = _first_station(db, type_value="shipping")
        to_id = shipping.id if shipping else None
    if from_id is None:
        storage = _first_station(db, storage=True)
        from_id = storage.id if storage else None

    start = db.get(FactoryStation, int(from_id)) if from_id else None
    end = db.get(FactoryStation, int(to_id)) if to_id else None
    if start is None or end is None:
        raise ValueError("Ein Transport braucht Start und Ziel — bitte beide Stationen wählen.")
    if start.id == end.id:
        raise ValueError("Start und Ziel sind dieselbe Station.")

    order_id = order.id if order is not None else None
    if order_id is None and work_order is not None and ctx.get("order_nos"):
        first = db.query(Order).filter(Order.no == ctx["order_nos"][0]).first()
        order_id = first.id if first else None
    return {
        "kind": kind,
        "from": start,
        "to": end,
        "work_order": work_order,
        "task": task,
        "order": order,
        "order_id": order_id,
        "order_no": order.no if order is not None else "",
        "context": ctx,
    }


def _payload(body: dict, ctx: dict) -> dict:
    payload = dict(body.get("payload") or {})
    if "material" not in payload and ctx.get("material"):
        payload["material"] = ctx["material"]
    if "thickness" not in payload and ctx.get("thickness"):
        payload["thickness"] = ctx["thickness"]
    if "parts" not in payload and ctx.get("parts"):
        payload["parts"] = ctx["parts"]
    return payload


def plan(db: Session, body: dict) -> dict:
    """Einen Transport durchrechnen, ohne eine Zeile zu schreiben."""
    resolved = _resolve(db, body)
    start, end = resolved["from"], resolved["to"]
    way = robot_ways.plan_between_stations(db, start.id, end.id)
    payload = _payload(body, resolved["context"])
    try:
        weight = max(0.0, float(payload.get("weight_kg") or 0.0))
    except (TypeError, ValueError):
        weight = 0.0
    capability = str(body.get("capability") or "transport").strip()
    options = robot_ways.robot_options(db, way["floor_id"])
    choices, rejected = rank_robots(
        start=(float(start.x or 0.0), float(start.y or 0.0)),
        robots=options,
        payload_kg=weight,
        capability=capability,
    )
    speeds = {o.id: o.speed_m_s for o in options}
    recommended = None
    if choices:
        first = choices[0]
        recommended = {
            "robot_id": first.robot_id,
            "name": first.name,
            "distance_m": first.distance_m,
            "reason": first.reason,
            "eta_s": robot_ways.drive_seconds(way["route_m"], speeds.get(first.robot_id, 0.0)),
        }
    return {
        "kind": resolved["kind"],
        "context": resolved["context"],
        "order_id": resolved["order_id"],
        "order_no": resolved["order_no"],
        "work_order_id": resolved["work_order"].id if resolved["work_order"] else None,
        "work_order_no": (resolved["work_order"].no if resolved["work_order"] else ""),
        "station_task_id": resolved["task"].id if resolved["task"] else None,
        "from": way["from"],
        "to": way["to"],
        "floor_id": way["floor_id"],
        "route": way["route"],
        "route_m": way["route_m"],
        "route_exact": way["route_exact"],
        "route_note": way["route_note"],
        "payload": payload,
        "candidates": [
            {"robot_id": c.robot_id, "name": c.name, "distance_m": c.distance_m,
             "score": c.score, "reason": c.reason,
             "eta_s": robot_ways.drive_seconds(way["route_m"], speeds.get(c.robot_id, 0.0))}
            for c in choices
        ],
        "rejected": [
            {"robot_id": r.robot_id, "name": r.name, "reason": r.reason}
            for r in rejected
        ],
        "recommended": recommended,
    }


def _choice(planned: dict, robot_id: int) -> dict:
    for row in planned["candidates"]:
        if row["robot_id"] == robot_id:
            return row
    for row in planned["rejected"]:
        if row["robot_id"] == robot_id:
            raise ValueError(f"Roboter nicht geeignet: {row['reason']}")
    raise ValueError("Roboter ist nicht auf dieser Ebene oder nicht aktiv.")


def create(db: Session, body: dict, actor: str, *,
           now: Optional[datetime] = None) -> RobotJob:
    """Einen Transport anlegen; optional gleich zuweisen."""
    stamp = _stamp(now)
    planned = plan(db, body)
    robot_id = body.get("robot_id")
    chosen: Optional[dict] = None
    if robot_id is not None:
        chosen = _choice(planned, int(robot_id))
    elif body.get("auto_assign") and planned["recommended"]:
        chosen = planned["recommended"]
    if chosen is not None and _busy(db, int(chosen["robot_id"])):
        raise ValueError("Dieser Roboter fährt bereits einen offenen Transport.")

    row = RobotJob(
        ref="",
        kind=planned["kind"],
        state="proposed",
        priority=max(1, min(9, int(body.get("priority") or 5))),
        order_id=planned["order_id"],
        order_no=str(planned["order_no"] or "")[:30],
        work_order_id=planned["work_order_id"],
        work_order_no=str(planned["work_order_no"] or "")[:30],
        station_task_id=planned["station_task_id"],
        task_kind=str(planned["context"].get("task", {}).get("kind") or "")[:16],
        task_ref=str(planned["context"].get("task", {}).get("ref") or "")[:30],
        from_station_id=planned["from"]["id"],
        to_station_id=planned["to"]["id"],
        floor_id=planned["floor_id"],
        route=planned["route"],
        route_m=planned["route_m"],
        route_exact=planned["route_exact"],
        route_note=planned["route_note"][:300],
        payload=planned["payload"],
        context=planned["context"],
        note=str(body.get("note") or "")[:2000],
        created_by=actor,
    )
    # Die Auftragsnummer folgt der id; sie ist die stabile Kennung für Etikett,
    # Gateway und Protokoll. Sie wird nach dem Flush gesetzt und bleibt.
    db.add(row)
    db.flush()
    row.ref = f"RT-{row.id:05d}"
    if body.get("approve"):
        row.state = "approved"
        row.approved_by = actor
        row.approved_at = stamp
    if chosen is not None:
        row.robot_id = int(chosen["robot_id"])
        row.eta_s = float(chosen.get("eta_s") or 0.0)
        row.state = "assigned"
        row.assigned_by = actor
        row.assigned_at = stamp
        if row.approved_at is None:
            row.approved_by = actor
            row.approved_at = row.assigned_at
    _audit(db, actor, "robot_job_create", row,
           detail={"robot_id": row.robot_id, "auto": bool(body.get("auto_assign"))})
    db.commit()
    return row


def _job(db: Session, job_id: int) -> RobotJob:
    row = db.get(RobotJob, job_id)
    if row is None:
        raise ValueError("Transport nicht gefunden.")
    return row


def _gateway_of(db: Session, robot: RobotAsset) -> Optional[RobotGateway]:
    code = (robot.gateway_id or "sim").strip() or "sim"
    return db.query(RobotGateway).filter(RobotGateway.code == code).first()


def _remember_robot(db: Session, row: RobotJob, robot: RobotAsset) -> None:
    """Den Zustand vor dem Transport in einer eigenen Zeile sichern."""
    before = (
        db.query(RobotJobRestore)
        .filter(RobotJobRestore.job_id == row.id)
        .first()
    )
    if before is None:
        before = RobotJobRestore(job_id=row.id)
        db.add(before)
    before.robot_id = robot.id
    before.route = list(robot.route or [])
    before.route_mode = robot.route_mode or "pingpong"
    before.sim_started_at = robot.sim_started_at
    before.state = robot.state or "idle"


def _restore_robot(db: Session, row: RobotJob) -> None:
    before = (
        db.query(RobotJobRestore)
        .filter(RobotJobRestore.job_id == row.id)
        .first()
    )
    robot = db.get(RobotAsset, row.robot_id) if row.robot_id else None
    if robot is not None and before is not None:
        robot.route = list(before.route or [])
        robot.route_mode = before.route_mode or "pingpong"
        robot.sim_started_at = before.sim_started_at
        robot.state = "idle"
    elif robot is not None:
        legacy = (row.context or {}).get("_robot_before")
        if isinstance(legacy, dict):
            robot.route = list(legacy.get("route") or [])
            robot.route_mode = str(legacy.get("route_mode") or "pingpong")
            stamp = legacy.get("sim_started_at")
            if stamp:
                try:
                    robot.sim_started_at = datetime.fromisoformat(str(stamp))
                except ValueError:
                    robot.sim_started_at = None
            robot.state = "idle"
    if before is not None:
        db.delete(before)
    context = dict(row.context or {})
    context.pop("_robot_before", None)
    row.context = context


def approve(db: Session, job_id: int, actor: str, *,
            now: Optional[datetime] = None) -> RobotJob:
    row = _job(db, job_id)
    if robot_state.is_idempotent("approve", row.state):
        return row
    reason = robot_state.guard_reason("approve", row.state)
    if reason:
        raise ValueError(reason)
    row.state = robot_state.target_state("approve")
    row.approved_by = actor
    row.approved_at = _stamp(now)
    _audit(db, actor, "robot_job_approve", row)
    db.commit()
    return row


def assign(db: Session, job_id: int, actor: str, robot_id: Optional[int] = None,
           *, now: Optional[datetime] = None) -> RobotJob:
    row = _job(db, job_id)
    reason = robot_state.guard_reason("assign", row.state)
    if reason:
        raise ValueError(reason)
    if row.from_station_id is None or row.to_station_id is None:
        raise ValueError("Dem Transport fehlen Start oder Ziel.")
    way = robot_ways.plan_between_stations(db, row.from_station_id, row.to_station_id)
    options = robot_ways.robot_options(db, way["floor_id"])
    try:
        weight = max(0.0, float((row.payload or {}).get("weight_kg") or 0.0))
    except (TypeError, ValueError):
        weight = 0.0
    choices, rejected = rank_robots(
        start=(float(way["from"]["x"]), float(way["from"]["y"])),
        robots=options,
        payload_kg=weight,
    )
    chosen_id = int(robot_id) if robot_id is not None else (choices[0].robot_id if choices else 0)
    if not chosen_id:
        reason = rejected[0].reason if rejected else "kein Roboter auf dieser Ebene"
        raise ValueError(f"Kein Roboter verfügbar: {reason}")
    if robot_id is not None and chosen_id not in {c.robot_id for c in choices}:
        reason = next(
            (r.reason for r in rejected if r.robot_id == chosen_id),
            "nicht auf dieser Ebene oder nicht aktiv",
        )
        raise ValueError(f"Roboter nicht geeignet: {reason}")
    if _busy(db, chosen_id, exclude_job_id=row.id):
        raise ValueError("Dieser Roboter fährt bereits einen offenen Transport.")
    speed = next((o.speed_m_s for o in options if o.id == chosen_id), 0.0)
    row.robot_id = chosen_id
    row.route = way["route"]
    row.route_m = way["route_m"]
    row.route_exact = way["route_exact"]
    row.route_note = way["route_note"][:300]
    row.floor_id = way["floor_id"]
    row.eta_s = robot_ways.drive_seconds(way["route_m"], speed)
    row.state = robot_state.target_state("assign")
    row.assigned_by = actor
    row.assigned_at = _stamp(now)
    if row.approved_at is None:
        row.approved_by = actor
        row.approved_at = row.assigned_at
    _audit(db, actor, "robot_job_assign", row, detail={"robot_id": chosen_id})
    db.commit()
    return row


def start(db: Session, job_id: int, actor: str, *,
          now: Optional[datetime] = None) -> RobotJob:
    stamp = _stamp(now)
    row = _job(db, job_id)
    if robot_state.is_idempotent("start", row.state):
        return row
    if row.robot_id is None:
        raise ValueError("Nur ein zugewiesener Transport kann starten.")
    reason = robot_state.guard_reason("start", row.state)
    if reason:
        raise ValueError(reason)
    robot = db.get(RobotAsset, row.robot_id)
    if robot is not None:
        _remember_robot(db, row, robot)
        if (robot.gateway_id or "sim").strip().lower() == "sim":
            robot.route = list(row.route or [])
            robot.route_mode = "pingpong"
            robot.sim_started_at = stamp
        else:
            gateway = _gateway_of(db, robot)
            if gateway is None:
                raise ValueError("Für diesen Roboter ist kein Gateway eingerichtet.")
            result = robot_gateway.deliver(
                gateway,
                "command",
                {
                    "type": "job.command",
                    "job": {
                        "id": row.id,
                        "ref": row.ref,
                        "kind": row.kind,
                        "priority": row.priority,
                        "from_station_id": row.from_station_id,
                        "to_station_id": row.to_station_id,
                        "route": list(row.route or []),
                        "route_m": row.route_m,
                        "payload": dict(row.payload or {}),
                    },
                    "context": {k: v for k, v in (row.context or {}).items()
                                if not str(k).startswith("_")},
                },
            )
            if not result["ok"]:
                raise ValueError(f"Gateway hat den Auftrag nicht angenommen: {result['message']}")
        robot.state = "moving"
    row.state = robot_state.target_state("start")
    row.started_at = stamp
    _audit(db, actor, "robot_job_start", row, detail={"robot_id": row.robot_id})
    db.commit()
    return row


def done(db: Session, job_id: int, actor: str, *, note: str = "",
         now: Optional[datetime] = None) -> RobotJob:
    row = _job(db, job_id)
    if robot_state.is_idempotent("done", row.state):
        return row
    reason = robot_state.guard_reason("done", row.state)
    if reason:
        raise ValueError(reason)
    row.state = robot_state.target_state("done")
    row.finished_at = _stamp(now)
    row.finished_by = actor
    if note:
        row.note = note[:2000]
    _restore_robot(db, row)
    _audit(db, actor, "robot_job_done", row, detail={"robot_id": row.robot_id})
    db.commit()
    return row


def _finish(db: Session, row: RobotJob, state: str, actor: str, note: str,
            action: str, *, now: Optional[datetime] = None) -> RobotJob:
    transition = "cancel" if state == "cancelled" else "fail"
    if robot_state.is_idempotent(transition, row.state):
        return row
    reason = robot_state.guard_reason(transition, row.state)
    if reason:
        raise ValueError(reason)
    robot = db.get(RobotAsset, row.robot_id) if row.robot_id else None
    if state in ("cancelled", "failed") and robot is not None:
        gateway = _gateway_of(db, robot)
        if gateway is not None:
            robot_gateway.deliver(
                gateway,
                "cancel",
                {"type": "job.cancel", "job": {"id": row.id, "ref": row.ref}},
            )
    row.state = state
    row.finished_at = _stamp(now)
    row.finished_by = actor
    if note:
        row.note = note[:2000]
    _restore_robot(db, row)
    _audit(db, actor, action, row, detail={"robot_id": row.robot_id, "note": note[:200]})
    db.commit()
    return row


def cancel(db: Session, job_id: int, actor: str, *, note: str = "",
           now: Optional[datetime] = None) -> RobotJob:
    return _finish(db, _job(db, job_id), "cancelled", actor, note,
                   "robot_job_cancel", now=now)


def fail(db: Session, job_id: int, actor: str, *, note: str = "",
         now: Optional[datetime] = None) -> RobotJob:
    return _finish(db, _job(db, job_id), "failed", actor, note,
                   "robot_job_fail", now=now)


def as_dict(db: Session, row: RobotJob) -> dict:
    start = db.get(FactoryStation, row.from_station_id) if row.from_station_id else None
    end = db.get(FactoryStation, row.to_station_id) if row.to_station_id else None
    robot = db.get(RobotAsset, row.robot_id) if row.robot_id else None
    return {
        "id": row.id,
        "ref": row.ref,
        "kind": row.kind,
        "state": row.state,
        "priority": row.priority,
        "order_id": row.order_id,
        "order_no": row.order_no,
        "work_order_id": row.work_order_id,
        "work_order_no": row.work_order_no,
        "station_task_id": row.station_task_id,
        "task_kind": row.task_kind,
        "task_ref": row.task_ref,
        "from": {"id": start.id, "label": start.label} if start else None,
        "to": {"id": end.id, "label": end.label} if end else None,
        "robot_id": row.robot_id,
        "robot_name": robot.name if robot else "",
        "floor_id": row.floor_id,
        "route": list(row.route or []),
        "route_m": round(float(row.route_m or 0.0), 2),
        "route_exact": bool(row.route_exact),
        "route_note": row.route_note,
        "eta_s": round(float(row.eta_s or 0.0), 1),
        "payload": dict(row.payload or {}),
        "context": dict(row.context or {}),
        "note": row.note,
        "created_by": row.created_by,
        "created_at": _iso(row.created_at),
        "approved_by": row.approved_by,
        "approved_at": _iso(row.approved_at),
        "assigned_by": row.assigned_by,
        "assigned_at": _iso(row.assigned_at),
        "started_at": _iso(row.started_at),
        "finished_at": _iso(row.finished_at),
        "finished_by": row.finished_by,
    }


def query(
    db: Session,
    *,
    state: str = "",
    active_only: bool = False,
    floor_id: Optional[int] = None,
    order_no: str = "",
    work_order_no: str = "",
    limit: int = 200,
) -> list[dict]:
    q = db.query(RobotJob)
    if state:
        q = q.filter(RobotJob.state == state)
    if active_only:
        q = q.filter(RobotJob.state.in_(ACTIVE_STATES))
    if floor_id is not None:
        q = q.filter(RobotJob.floor_id == floor_id)
    if order_no:
        q = q.filter(RobotJob.order_no == order_no)
    if work_order_no:
        q = q.filter(RobotJob.work_order_no == work_order_no)
    rows = q.order_by(RobotJob.id.desc()).limit(max(1, min(1000, limit))).all()
    return [as_dict(db, row) for row in rows]
