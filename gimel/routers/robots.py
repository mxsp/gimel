"""Roboter als Ressource — lesen für die Halle, pflegen für den Admin.

Die Route ist bewusst klein: die Flotte zeigt ihren Zustand, ein Admin kann
einen virtuellen Roboter anlegen. Es gibt **keinen** Befehl an einen Antrieb,
keine Geschwindigkeit und keinen Not-Halt über diese API — das bleibt Sache
eines Flotten-Gateways und seiner Sicherheitsfunktionen.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core.layout import Layout
from ..core.robot_way import route_problems
from ..db import get_db
from ..models import AuditLog, FactoryFloor, RobotAsset, User
from ..security import require_admin, require_worker
from ..services import robot_fleet

router = APIRouter(prefix="/api/factory", tags=["factory"])

ROUTE_MODES = {"loop", "pingpong"}
ROBOT_STATES = {"idle", "moving", "charging", "blocked", "error", "offline"}


class RobotIn(BaseModel):
    name: str = "Roboter"
    kind: str = "agv"
    floor_id: Optional[int] = None
    route: list[list[float]] = Field(default_factory=list, max_length=5000)
    route_mode: str = "pingpong"
    # Finitheit prüft `_clean`, damit ein NaN/Infinity als 400 endet und nicht
    # in der Fehlerantwort selbst wieder serialisiert werden muss.
    speed_m_s: float = 0.8
    battery_pct: Optional[int] = None
    state: str = "idle"
    gateway_id: str = "sim"
    capabilities: list[str] = Field(default_factory=list)
    payload_kg: float = 0.0
    active: bool = True


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _audit(db: Session, user: User, action: str, row: RobotAsset,
           changed: Optional[list[str]] = None, **extra) -> None:
    detail: dict = {"name": row.name, **extra}
    if changed is not None:
        detail["changed"] = changed
    db.add(AuditLog(actor=user.email, action=action, entity="robot_asset",
                    entity_id=str(row.id), detail=detail))
    db.commit()


def _clean(body: RobotIn, db: Session) -> dict:
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Der Roboter braucht einen Namen.")
    if body.floor_id is not None and db.get(FactoryFloor, body.floor_id) is None:
        raise HTTPException(status_code=400, detail="Ebene nicht gefunden.")
    mode = (body.route_mode or "").strip().lower()
    if mode not in ROUTE_MODES:
        raise HTTPException(status_code=400, detail="route_mode muss loop oder pingpong sein.")
    state = (body.state or "").strip().lower()
    if state not in ROBOT_STATES:
        raise HTTPException(status_code=400, detail="Unbekannter Roboterzustand.")
    route: list[list[float]] = []
    for p in body.route:
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            raise HTTPException(status_code=400, detail="Jeder Wegpunkt braucht x und y.")
        if not (math.isfinite(x) and math.isfinite(y)):
            raise HTTPException(status_code=400, detail="Wegpunkte müssen endliche Zahlen sein.")
        if abs(x) > 1_000_000 or abs(y) > 1_000_000:
            raise HTTPException(status_code=400, detail="Wegpunkte liegen außerhalb der Halle.")
        route.append([round(x, 3), round(y, 3)])
    if len(route) == 1:
        raise HTTPException(status_code=400, detail="Ein Weg braucht mindestens zwei Punkte.")
    # Ein Weg, der die Halle verlässt oder ein Hindernis kreuzt, ist kein
    # Roboterweg. Geprüft wird nur, wenn die Ebene ausdrücklich dazugehört;
    # ein Bestandsroboter ohne Ebene hat keinen Grundriss, gegen den man
    # prüfen könnte.
    if route and body.floor_id is not None:
        floor = db.get(FactoryFloor, body.floor_id)
        if floor is not None:
            problems = route_problems(Layout.from_row(floor), route)
            if problems:
                raise HTTPException(status_code=400, detail=problems[0])
    if body.battery_pct is not None and not (0 <= body.battery_pct <= 100):
        raise HTTPException(status_code=400, detail="Die Batterie liegt zwischen 0 und 100 %.")
    if not math.isfinite(body.speed_m_s) or body.speed_m_s < 0:
        raise HTTPException(status_code=400, detail="Die Geschwindigkeit muss endlich und nicht negativ sein.")
    if not math.isfinite(body.payload_kg) or body.payload_kg < 0:
        raise HTTPException(status_code=400, detail="Die Nutzlast muss endlich und nicht negativ sein.")
    return {
        "name": name[:120],
        "kind": (body.kind or "agv").strip()[:20] or "agv",
        "floor_id": body.floor_id,
        "route": route,
        "route_mode": mode,
        "speed_m_s": round(float(body.speed_m_s), 2),
        "battery_pct": body.battery_pct,
        "state": state,
        "gateway_id": (body.gateway_id or "sim").strip()[:60] or "sim",
        "capabilities": [str(c)[:40] for c in body.capabilities][:20],
        "payload_kg": round(float(body.payload_kg), 1),
        "active": bool(body.active),
    }


def _store(row: RobotAsset, values: dict, db: Session,
           *, new: bool = False) -> tuple[RobotAsset, list[str]]:
    """Werte setzen und flushen; gibt die tatsächlich geänderten Felder zurück.

    Eine unveränderte Speichern-Geste ist kein Ereignis: sie schreibt keine
    Protokollzeile und setzt den Simulationsstart nicht zurück. Sonst würde
    jedes no-op-Speichern den Roboter an den Weganfang teleportieren.
    """
    if new:
        changed = list(values)
    else:
        before = {key: getattr(row, key, None) for key in values}
        changed = [key for key, value in values.items() if before[key] != value]
    if not changed:
        return row, []
    for key in changed:
        setattr(row, key, values[key])
    # Eine geänderte Route beginnt am Anfang — sonst stünde der Roboter
    # mitten auf einem Weg, den es nicht mehr gibt.
    if (row.gateway_id or "sim").strip().lower() == "sim":
        if any(key in changed for key in ("route", "route_mode", "speed_m_s", "gateway_id")):
            row.sim_started_at = _now()
    else:
        row.sim_started_at = None
    db.add(row)
    # Flush, nicht Commit: die Audit-Zeile gehört in dieselbe Transaktion.
    db.flush()
    return row, changed


@router.get("/robots")
def list_robots(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    floor_id: Optional[int] = Query(None),
) -> dict:
    """Die Flotte, wie sie jetzt steht. Lesen ändert nichts."""
    return robot_fleet.snapshot(db, floor_id=floor_id)


@router.get("/robots/route-check")
def route_check(
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
    floor_id: Optional[int] = Query(None),
) -> dict:
    """Alle Roboterwege prüfen und je einen besseren Vorschlag rechnen. Schreibt nichts."""
    from ..core import route_improve
    from ..services.robot_ways import station_bodies

    rows = db.query(RobotAsset).filter(RobotAsset.active.is_(True)).order_by(RobotAsset.id).all()
    if floor_id is not None:
        rows = [r for r in rows if r.floor_id == floor_id]
    floors: dict[int, tuple[Layout, list]] = {}
    out: list[dict] = []
    for r in rows:
        if r.floor_id is None or len(r.route or []) < 2:
            continue
        if r.floor_id not in floors:
            fl = db.get(FactoryFloor, r.floor_id)
            floors[r.floor_id] = (Layout.from_row(fl), station_bodies(db, r.floor_id))
        layout, bodies = floors[r.floor_id]
        imp = route_improve.improve(layout, r.route, loop=(r.route_mode == "loop"), bodies=bodies)
        out.append({"id": r.id, "name": r.name, "floor_id": r.floor_id, "route_mode": r.route_mode,
                    "current": r.route, **imp.as_dict()})
    network = [{"floor_id": fid, "findings": route_improve.network_findings(lay, bodies)}
               for fid, (lay, bodies) in floors.items()]
    return {"robots": out, "network": network}


class ImproveIn(BaseModel):
    apply: bool = False


@router.post("/robots/{robot_id}/improve-route")
def improve_route(
    robot_id: int,
    body: ImproveIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict:
    """Vorschlag für einen besseren Weg; mit ``apply`` übernehmen (protokolliert)."""
    from ..core import route_improve
    from ..services.robot_ways import station_bodies

    row = db.get(RobotAsset, robot_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Roboter nicht gefunden.")
    if row.floor_id is None or len(row.route or []) < 2:
        raise HTTPException(status_code=409, detail="Dieser Roboter hat keinen Weg auf einer Ebene.")
    floor = db.get(FactoryFloor, row.floor_id)
    imp = route_improve.improve(Layout.from_row(floor), row.route, loop=(row.route_mode == "loop"),
                                bodies=station_bodies(db, row.floor_id))
    result = {"id": row.id, "name": row.name, "current": row.route, **imp.as_dict(), "applied": False}
    if not body.apply or not imp.changed:
        return result
    if imp.problems_after and not imp.problems_before:
        raise HTTPException(status_code=409, detail="Der Vorschlag wäre schlechter als der jetzige Weg.")
    before_m = round(imp.metres_before, 2)
    _row, changed = _store(row, {"route": [[round(x, 3), round(y, 3)] for x, y in imp.points]}, db)
    if changed:
        _audit(db, admin, "robot_route_improve", _row, changed=changed, metres_before=before_m,
               metres_after=round(imp.metres_after, 2), detours=imp.detours, rerouted=imp.rerouted)
    result["applied"] = bool(changed)
    result["robot"] = robot_fleet.as_dict(_row)
    return result


@router.get("/robots/{robot_id}")
def get_robot(
    robot_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    row = db.get(RobotAsset, robot_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Roboter nicht gefunden.")
    return robot_fleet.as_dict(row)


@router.post("/robots", status_code=201)
def create_robot(
    body: RobotIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict:
    row, _changed = _store(RobotAsset(), _clean(body, db), db, new=True)
    _audit(db, admin, "robot_create", row)
    return robot_fleet.as_dict(row)


@router.put("/robots/{robot_id}")
def update_robot(
    robot_id: int,
    body: RobotIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict:
    row = db.get(RobotAsset, robot_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Roboter nicht gefunden.")
    _row, changed = _store(row, _clean(body, db), db)
    if changed:
        _audit(db, admin, "robot_update", _row, changed=changed)
    return robot_fleet.as_dict(_row)


@router.delete("/robots/{robot_id}", status_code=204)
def delete_robot(
    robot_id: int,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> None:
    row = db.get(RobotAsset, robot_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Roboter nicht gefunden.")
    name = row.name
    db.delete(row)
    db.add(AuditLog(actor=admin.email, action="robot_delete", entity="robot_asset",
                    entity_id=str(robot_id), detail={"name": name}))
    db.commit()
