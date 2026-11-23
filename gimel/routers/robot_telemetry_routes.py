"""Telemetrie eines Gateways — Token statt Benutzerkonto, LAN-only.

Die Meldung ist ein Zustandswechsel oder ein Takt, kein Sensorstrom. Eine
doppelte ``idempotency_key`` ist folgenlos; ein fehlender Wert bleibt
``NULL`` und wird nie als Ursprung gezeichnet.
"""

from __future__ import annotations

import hmac
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import RobotEvent, User
from ..security import require_worker
from ..services import robot_fleet

router = APIRouter(tags=["robots"])


class TelemetryIn(BaseModel):
    robot_id: int
    x: Optional[float] = None
    y: Optional[float] = None
    heading_deg: Optional[float] = None
    battery_pct: Optional[int] = None
    state: Optional[str] = None
    quality: str = "reported"
    type: str = "telemetry"
    idempotency_key: str = ""
    ts: Optional[datetime] = None


@router.get("/robot-events")
def list_robot_events(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    robot_id: Optional[int] = Query(None),
    limit: int = Query(100),
) -> dict:
    """Der letzte gemeldete Zustand — kein Historiker, eine kurze Spur."""
    q = db.query(RobotEvent)
    if robot_id is not None:
        q = q.filter(RobotEvent.robot_id == robot_id)
    rows = q.order_by(RobotEvent.id.desc()).limit(max(1, min(500, limit))).all()
    return {"events": [
        {
            "id": row.id,
            "robot_id": row.robot_id,
            "gateway_id": row.gateway_id,
            "type": row.type,
            "ts": row.ts.isoformat() if row.ts else None,
            "received_at": row.received_at.isoformat() if row.received_at else None,
            "quality": row.quality,
            "payload": dict(row.payload or {}),
        }
        for row in rows
    ]}


@router.post("/robot-telemetry/{gateway_code}")
def ingest_telemetry(
    gateway_code: str,
    body: TelemetryIn,
    db: Annotated[Session, Depends(get_db)],
    x_gateway_token: Annotated[str, Header(alias="X-Gateway-Token")] = "",
) -> dict:
    """Telemetrie eines Gateways — Token statt Benutzerkonto, LAN-only."""
    gateway = robot_fleet.gateway_by_code(db, gateway_code)
    if gateway is None or not gateway.enabled or not gateway.token:
        raise HTTPException(status_code=401, detail="Gateway unbekannt oder ohne Token.")
    if not hmac.compare_digest(str(gateway.token), str(x_gateway_token)):
        raise HTTPException(status_code=401, detail="Gateway-Token ungültig.")
    payload = body.model_dump(exclude_unset=True)
    try:
        return robot_fleet.ingest(db, gateway, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
