"""Flotten-Gateways: lokale Adresse, Endpunkte, Token, Erreichbarkeitsprobe.

Ein Gateway ist die Naht zur Halle. Gimel ruft nur lokale Ziele auf; ein
öffentlicher Endpunkt wird beim Speichern abgelehnt, nicht erst beim Senden.
Das Token wird einmal bei der Anlage gezeigt und danach nur als ``token_set``.
"""

from __future__ import annotations

import re
import secrets
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditLog, RobotAsset, RobotGateway, Role, User
from ..security import require_admin, require_worker
from ..services import robot_gateway

router = APIRouter(tags=["robots"])

GATEWAY_KINDS = {"sim", "http", "vda5050"}
ENDPOINT_KEYS = {"health", "deploy", "command", "cancel"}
CODE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,59}$")


class GatewayIn(BaseModel):
    code: str
    name: str = "Gateway"
    kind: str = "sim"
    base_url: str = ""
    endpoints: dict[str, str] = Field(default_factory=dict)
    token: Optional[str] = None
    enabled: bool = True
    note: str = ""


def _audit(db: Session, user: User, action: str, row: RobotGateway,
           *, detail: Optional[dict] = None) -> None:
    body = {"code": row.code, "name": row.name, "kind": row.kind}
    if detail:
        body.update(detail)
    db.add(AuditLog(actor=user.email, action=action, entity="robot_gateway",
                    entity_id=str(row.id), detail=body))
    db.commit()


def _gateway_dict(row: RobotGateway) -> dict:
    return {
        "id": row.id,
        "code": row.code,
        "name": row.name,
        "kind": row.kind,
        "base_url": row.base_url,
        "endpoints": dict(row.endpoints or {}),
        "enabled": bool(row.enabled),
        "note": row.note,
        "token_set": bool(row.token),
        "last_seen_at": row.last_seen_at.isoformat() if row.last_seen_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _clean_gateway(body: GatewayIn, db: Session) -> dict:
    code = (body.code or "").strip().lower()
    if not CODE_RE.match(code):
        raise HTTPException(
            status_code=400,
            detail="Gateway-Code: 1–60 Zeichen, nur a–z, 0–9, Punkt, Strich, Unterstrich.",
        )
    kind = (body.kind or "").strip().lower()
    if kind not in GATEWAY_KINDS:
        raise HTTPException(status_code=400, detail="Gateway-Art muss sim, http oder vda5050 sein.")
    endpoints: dict[str, str] = {}
    for key, value in (body.endpoints or {}).items():
        key = str(key).strip().lower()
        if key not in ENDPOINT_KEYS:
            raise HTTPException(status_code=400, detail=f"Unbekannter Endpunkt: {key}")
        text = str(value or "").strip()[:300]
        if not text:
            continue
        try:
            if text.startswith(("http://", "https://")):
                robot_gateway.check_url(text)
            elif not text.startswith("/") or ".." in text.split("/"):
                raise robot_gateway.GatewayError(
                    "Ein Endpunkt ist ein lokaler Pfad wie /robots/orders oder eine lokale URL."
                )
        except robot_gateway.GatewayError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        endpoints[key] = text
    base_url = (body.base_url or "").strip()
    if kind == "sim":
        base_url = ""
    else:
        try:
            base_url = robot_gateway.check_url(base_url) if base_url else ""
        except robot_gateway.GatewayError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return {
        "code": code,
        "name": (body.name or "Gateway").strip()[:120] or "Gateway",
        "kind": kind,
        "base_url": base_url,
        "endpoints": endpoints,
        "enabled": bool(body.enabled),
        "note": (body.note or "")[:2000],
    }


@router.get("/robot-gateways")
def list_gateways(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    rows = db.query(RobotGateway).order_by(RobotGateway.code.asc()).all()
    out = [_gateway_dict(r) for r in rows]
    # Netzadressen und Befehlspfade braucht nur, wer Gateways einrichtet; die
    # Halle sieht Code, Art und Zustand, nicht wo und wie man sie erreicht.
    if user.role not in (Role.staff, Role.admin):
        for g in out:
            g["base_url"], g["endpoints"], g["note"] = "", {}, ""
    return {"gateways": out}


@router.post("/robot-gateways", status_code=201)
def create_gateway(
    body: GatewayIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict:
    values = _clean_gateway(body, db)
    if db.query(RobotGateway).filter(RobotGateway.code == values["code"]).first() is not None:
        raise HTTPException(status_code=409, detail="Diesen Gateway-Code gibt es schon.")
    token = body.token if body.token is not None else (
        "" if values["kind"] == "sim" else secrets.token_urlsafe(24)
    )
    row = RobotGateway(**values, token=token)
    db.add(row)
    db.flush()
    _audit(db, admin, "robot_gateway_create", row)
    out = _gateway_dict(row)
    if token and body.token is None:
        out["token"] = token
    return out


@router.put("/robot-gateways/{gateway_id}")
def update_gateway(
    gateway_id: int,
    body: GatewayIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict:
    row = db.get(RobotGateway, gateway_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Gateway nicht gefunden.")
    values = _clean_gateway(body, db)
    other = db.query(RobotGateway).filter(
        RobotGateway.code == values["code"], RobotGateway.id != row.id
    ).first()
    if other is not None:
        raise HTTPException(status_code=409, detail="Diesen Gateway-Code gibt es schon.")
    changed = []
    for key, value in values.items():
        if getattr(row, key) != value:
            setattr(row, key, value)
            changed.append(key)
    if body.token is not None and (body.token or "") != (row.token or ""):
        row.token = body.token or ""
        changed.append("token")
    if changed:
        _audit(db, admin, "robot_gateway_update", row, detail={"changed": changed})
    return _gateway_dict(row)


@router.delete("/robot-gateways/{gateway_id}", status_code=204)
def delete_gateway(
    gateway_id: int,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> None:
    row = db.get(RobotGateway, gateway_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Gateway nicht gefunden.")
    in_use = db.query(RobotAsset).filter(RobotAsset.gateway_id == row.code).count()
    if in_use:
        raise HTTPException(status_code=409,
                            detail=f"Am Gateway hängen noch {in_use} Roboter.")
    code = row.code
    db.delete(row)
    db.add(AuditLog(actor=admin.email, action="robot_gateway_delete",
                    entity="robot_gateway", entity_id=str(gateway_id),
                    detail={"code": code}))
    db.commit()


@router.post("/robot-gateways/{gateway_id}/test")
def test_gateway(
    gateway_id: int,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict:
    row = db.get(RobotGateway, gateway_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Gateway nicht gefunden.")
    return robot_gateway.probe(row)
