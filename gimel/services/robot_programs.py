"""Roboterprogramme versionieren und ausliefern — nicht ausführen.

Der Text eines Programms ist ein Artefakt. Gimel prüft Länge, Version und
Prüfsumme, schreibt eine Protokollzeile und schickt ihn an das eingetragene
Gateway. Es interpretiert ihn nicht: eine Python-Datei, ein VDA-5050-Job und
eine JSON-Konfiguration sind hier gleich viel Text. Ausführen, Prüfen und
Sicherhalten ist Sache der Robotersteuerung.

Eine Version wird nie überschrieben. ``deploy`` legt einen Versuch an, der
auch dann sichtbar bleibt, wenn das Gateway ihn ablehnt oder nicht erreichbar
ist. ``rollback`` nimmt den letzten angenommenen Stand desselben Roboters —
als neuer Versuch, nicht als stille Rückdatierung.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..models import AuditLog, RobotAsset, RobotDeployment, RobotGateway, RobotProgram
from . import robot_gateway

KINDS = ("mission", "driver", "config")
LANGUAGES = ("python", "vda5050", "json", "text")
MAX_BODY = 256 * 1024


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _audit(db: Session, actor: str, action: str, row: RobotProgram | RobotDeployment,
           *, detail: Optional[dict] = None) -> None:
    body = {"name": getattr(row, "name", "") or getattr(row, "ref", "")}
    if detail:
        body.update(detail)
    db.add(AuditLog(actor=actor, action=action, entity="robot_program",
                    entity_id=str(row.id), detail=body))


def _gateway(db: Session, code: str) -> RobotGateway:
    row = db.query(RobotGateway).filter(RobotGateway.code == code).first()
    if row is None and code == "sim":
        row = RobotGateway(code="sim", name="Simulation", kind="sim", enabled=True)
        db.add(row)
        db.flush()
    if row is None:
        raise ValueError(f"Gateway „{code}“ ist nicht eingerichtet.")
    return row


def program_dict(db: Session, row: RobotProgram, *, include_body: bool = True) -> dict:
    robot = db.get(RobotAsset, row.robot_id) if row.robot_id else None
    return {
        "id": row.id,
        "name": row.name,
        "version": row.version,
        "kind": row.kind,
        "language": row.language,
        "body": row.body if include_body else "",
        "checksum": row.checksum,
        "status": row.status,
        "robot_id": row.robot_id,
        "robot_name": robot.name if robot else "",
        "gateway_id": row.gateway_id,
        "notes": row.notes,
        "created_by": row.created_by,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "approved_by": row.approved_by,
        "approved_at": row.approved_at.isoformat() if row.approved_at else None,
        "deployed_at": row.deployed_at.isoformat() if row.deployed_at else None,
    }


def deployment_dict(db: Session, row: RobotDeployment) -> dict:
    program = db.get(RobotProgram, row.program_id) if row.program_id else None
    robot = db.get(RobotAsset, row.robot_id) if row.robot_id else None
    return {
        "id": row.id,
        "program_id": row.program_id,
        "program_name": program.name if program else "",
        "program_version": program.version if program else None,
        "checksum": program.checksum if program else "",
        "robot_id": row.robot_id,
        "robot_name": robot.name if robot else "",
        "gateway_id": row.gateway_id,
        "state": row.state,
        "message": row.message,
        "actor": row.actor,
        "rollback_of_id": row.rollback_of_id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
    }


def create_version(
    db: Session,
    *,
    name: str,
    body: str,
    actor: str,
    kind: str = "mission",
    language: str = "json",
    robot_id: Optional[int] = None,
    gateway_id: str = "",
    notes: str = "",
) -> RobotProgram:
    """Eine neue Version anlegen; gleicher Name zählt eins hoch."""
    clean_name = (name or "").strip()[:120]
    if not clean_name:
        raise ValueError("Das Programm braucht einen Namen.")
    kind = (kind or "").strip().lower()
    if kind not in KINDS:
        raise ValueError("Programmart muss mission, driver oder config sein.")
    language = (language or "").strip().lower()
    if language not in LANGUAGES:
        raise ValueError("Programmsprache muss python, vda5050, json oder text sein.")
    text = body or ""
    if len(text.encode("utf-8")) > MAX_BODY:
        raise ValueError("Das Programm ist größer als 256 KiB.")
    if robot_id is not None and db.get(RobotAsset, robot_id) is None:
        raise ValueError("Roboter nicht gefunden.")
    code = (gateway_id or "").strip()[:60]
    if code:
        _gateway(db, code)
    last = (
        db.query(RobotProgram.version)
        .filter(RobotProgram.name == clean_name)
        .order_by(RobotProgram.version.desc())
        .first()
    )
    version = int(last[0]) + 1 if last else 1
    checksum = hashlib.sha256(text.encode("utf-8")).hexdigest()
    row = RobotProgram(
        name=clean_name,
        version=version,
        kind=kind,
        language=language,
        body=text,
        checksum=checksum,
        status="draft",
        robot_id=robot_id,
        gateway_id=code,
        notes=(notes or "")[:2000],
        created_by=actor,
    )
    db.add(row)
    db.flush()
    _audit(db, actor, "robot_program_create", row,
           detail={"version": version, "checksum": checksum})
    db.commit()
    return row


def approve(db: Session, program_id: int, actor: str) -> RobotProgram:
    row = db.get(RobotProgram, program_id)
    if row is None:
        raise ValueError("Programm nicht gefunden.")
    if row.status == "deployed":
        raise ValueError("Eine ausgelieferte Version bleibt unverändert — bitte eine neue Version anlegen.")
    if row.status == "approved":
        return row
    row.status = "approved"
    row.approved_by = actor
    row.approved_at = _now()
    _audit(db, actor, "robot_program_approve", row)
    db.commit()
    return row


def deploy(
    db: Session,
    program_id: int,
    *,
    robot_id: int,
    actor: str,
    rollback_of_id: Optional[int] = None,
) -> RobotDeployment:
    """Ein Programm an genau einen Roboter ausliefern — mit sichtbarem Versuch."""
    program = db.get(RobotProgram, program_id)
    if program is None:
        raise ValueError("Programm nicht gefunden.")
    if program.status not in ("approved", "deployed"):
        raise ValueError("Nur freigegebene Programme dürfen ausgeliefert werden.")
    if program.robot_id is not None and program.robot_id != robot_id:
        raise ValueError("Das Programm ist an einen anderen Roboter gebunden.")
    robot = db.get(RobotAsset, robot_id)
    if robot is None:
        raise ValueError("Roboter nicht gefunden.")
    robot_code = (robot.gateway_id or "sim").strip() or "sim"
    code = (program.gateway_id or robot_code).strip() or "sim"
    if code != robot_code:
        raise ValueError("Das Programm-Gateway passt nicht zum Roboter.")
    gateway = _gateway(db, code)
    row = RobotDeployment(
        program_id=program.id,
        robot_id=robot.id,
        gateway_id=code,
        state="queued",
        actor=actor,
        rollback_of_id=rollback_of_id,
    )
    db.add(row)
    db.flush()
    result = robot_gateway.deliver(
        gateway,
        "deploy",
        {
            "type": "program.deploy",
            "deployment_id": row.id,
            "program": {
                "id": program.id,
                "name": program.name,
                "version": program.version,
                "kind": program.kind,
                "language": program.language,
                "checksum": program.checksum,
                "body": program.body,
            },
            "robot": {"id": robot.id, "name": robot.name, "kind": robot.kind},
        },
    )
    row.state = result["state"]
    row.message = str(result.get("message") or "")[:500]
    row.finished_at = _now()
    if result["ok"]:
        program.status = "deployed"
        program.deployed_at = row.finished_at
    _audit(db, actor, "robot_program_deploy", row,
           detail={"program": program.name, "version": program.version,
                   "state": row.state, "rollback_of": rollback_of_id})
    db.commit()
    return row


def rollback(db: Session, deployment_id: int, actor: str) -> RobotDeployment:
    """Den vorherigen angenommenen Stand desselben Roboters erneut ausliefern."""
    target = db.get(RobotDeployment, deployment_id)
    if target is None:
        raise ValueError("Auslieferung nicht gefunden.")
    if target.state != "accepted" or target.robot_id is None:
        raise ValueError("Nur eine angenommene Auslieferung lässt sich zurücknehmen.")
    previous = (
        db.query(RobotDeployment)
        .filter(RobotDeployment.robot_id == target.robot_id)
        .filter(RobotDeployment.state == "accepted")
        .filter(RobotDeployment.id < target.id)
        .filter(RobotDeployment.program_id.isnot(None))
        .order_by(RobotDeployment.id.desc())
        .first()
    )
    if previous is None or previous.program_id is None:
        raise ValueError("Es gibt keinen früheren Stand für diesen Roboter.")
    return deploy(db, previous.program_id, robot_id=target.robot_id, actor=actor,
                  rollback_of_id=target.id)
