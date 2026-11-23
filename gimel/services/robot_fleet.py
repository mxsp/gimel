"""Die Roboterflotte als Sicht — noch ohne echten Funkspruch.

Der erste Schritt zu Robotern im Regelkreis ist der billigste: **zeigen, wo
sie wären.** Ein virtueller Roboter hat einen Weg im Gangnetz, eine
Geschwindigkeit und einen Startzeitpunkt; seine Position ist damit eine reine
Funktion der Zeit. Das ist kein Trick, sondern die ehrlichste Form der
Simulation: derselbe Weg, dieselbe Uhr, dieselbe Anzeige wie später bei einer
echten Flotte — nur die Quelle ist ``sim``.

Eine echte Flotte schreibt ``x``/``y``/``heading_deg``; fehlt eine Position,
bleibt sie ``None`` und die Oberfläche sagt „Position unbekannt". Batterie und
Position kennen keine 0-ist-unbekannt-Regel: 0 % ist leer, (0, 0) ist ein
Punkt. Beides ist nullable und wird nie erfunden.

Die Datei ist die Naht zwischen Datenbank und 3D-Ansicht. Sie rechnet nicht
selbst: die Geometrie steht in ``core/robot.py``, die Zeit kommt von hier.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional

from sqlalchemy.orm import Session, object_session

from ..core import robot_traffic as traffic
from ..core.robot import pose_on_route, route_length_m
from ..models import AuditLog, RobotAsset, RobotEvent, RobotGateway, RobotJob

OPEN_STATES = ("idle", "moving", "charging", "blocked", "error", "offline")
QUALITIES = ("measured", "reported", "estimated", "unknown")
#: Ab dieser Stille gilt eine gemeldete Position als veraltet. Die Zahl ist
#: eine Anzeigegrenze, keine Sicherheitsfunktion — die Flottensteuerung
#: entscheidet, ob ein Roboter noch fahren darf.
STALE_SECONDS = 60
#: Roboterereignisse sind kein Historiker. Ältere Takte werden verworfen;
#: Zustandswechsel bleiben in ``AuditLog`` erhalten.
ROBOT_EVENT_KEEP_DAYS = 30


#: Gemeinsamer Bezug aller Fahrpläne simulierter Roboter. Fest, damit Portal,
#: Studio und Agent Lab zu jeder Zeit dieselbe Lage rechnen (kein Zustand).
TRAFFIC_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _is_sim(row: RobotAsset) -> bool:
    return (row.gateway_id or "sim").strip().lower() == "sim"


@lru_cache(maxsize=64)
def _plan_for(signature: tuple) -> traffic.TrafficResult:
    robots = [traffic.TrafficRobot(rid, tuple(tuple(p) for p in json.loads(route)), loop, speed)
              for rid, route, loop, speed in signature]
    return traffic.plan_floor(robots)


def floor_plans(rows: list[RobotAsset]) -> dict[int, traffic.Plan]:
    """Fahrpläne aller aktiven simulierten Roboter, je Ebene gemeinsam geplant
    (``core.robot_traffic``): keiner kommt einem anderen näher als ``SAFE_M``.
    Zwischengespeichert nach Wegen und Tempi; eine Änderung plant neu."""
    groups: dict[Optional[int], list[tuple]] = {}
    for r in rows:
        route = _route(r.route)
        if not (_is_sim(r) and r.active and len(route) >= 2):
            continue
        loop = (r.route_mode or "").lower() == "loop"
        groups.setdefault(r.floor_id, []).append(
            (r.id, json.dumps(route), loop, round(max(0.0, float(r.speed_m_s or 0.0)), 4)))
    out: dict[int, traffic.Plan] = {}
    for _floor, sig in groups.items():
        out.update(_plan_for(tuple(sorted(sig))).plans)
    return out


def _floor_rows(db: Session, floor_id: Optional[int]) -> list[RobotAsset]:
    q = db.query(RobotAsset).filter(RobotAsset.active.is_(True))
    q = q.filter(RobotAsset.floor_id.is_(None)) if floor_id is None else q.filter(RobotAsset.floor_id == floor_id)
    return q.order_by(RobotAsset.id.asc()).all()


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _route(raw: object) -> list[list[float]]:
    out: list[list[float]] = []
    if not isinstance(raw, list):
        return out
    for p in raw:
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            continue
        if math.isfinite(x) and math.isfinite(y):
            out.append([x, y])
    return out


def _state(row: RobotAsset, *, simulated: bool, moving: bool) -> str:
    if not row.active:
        return "offline"
    value = (row.state or "idle").strip().lower()
    if value not in OPEN_STATES:
        value = "idle"
    if simulated:
        if moving:
            return "moving"
        # Ein simulierter Roboter ohne Bewegung ist im Stillstand; besondere
        # Zustände (lädt, blockiert, Störung) bleiben seine eigene Aussage.
        return value if value in ("charging", "blocked", "error") else "idle"
    return value


def _active_job(db: Optional[Session], robot_id: int) -> Optional[dict]:
    """Der Transport, den dieser Roboter gerade fährt — für die Anzeige."""
    if db is None:
        return None
    row = (
        db.query(RobotJob)
        .filter(RobotJob.robot_id == robot_id)
        .filter(RobotJob.state.in_(("assigned", "running")))
        .order_by(RobotJob.id.desc())
        .first()
    )
    if row is None:
        return None
    return {
        "id": row.id,
        "ref": row.ref,
        "state": row.state,
        "order_no": row.order_no,
        "work_order_no": row.work_order_no,
        "from_station_id": row.from_station_id,
        "to_station_id": row.to_station_id,
    }


def _dict(row: RobotAsset, now: datetime, db: Optional[Session] = None,
          plans: Optional[dict[int, traffic.Plan]] = None) -> dict:
    stamp = _aware(now) or _now()
    route = _route(row.route)
    loop = (row.route_mode or "").lower() == "loop"
    length = route_length_m(route, loop=loop)
    if not math.isfinite(length) or length < 0:
        route, length = [], 0.0
    simulated = _is_sim(row)
    speed = max(0.0, float(row.speed_m_s or 0.0))
    progress = 0.0
    pose = None
    plan: Optional[traffic.Plan] = None
    planned_moving: Optional[bool] = None

    if simulated and route and row.active:
        if plans is None:
            session = db or object_session(row)
            if session is not None:
                plans = floor_plans(_floor_rows(session, row.floor_id))
        plan = (plans or {}).get(row.id)
        period = length if loop else length * 2.0
        if plan is not None:
            # Fahrplan: Vorfahrt nach Kennung, Warten nur an sicheren Halten.
            t = (stamp - TRAFFIC_EPOCH).total_seconds()
            travelled = traffic.distance_at(plan, t)
            planned_moving = traffic.moving_at(plan, t)
        else:
            start = _aware(row.sim_started_at) or _aware(row.created_at) or stamp
            travelled = max(0.0, (stamp - start).total_seconds()) * speed
        progress = travelled % period if period > 1e-9 else 0.0
        pose = pose_on_route(route, travelled, loop=loop)

    x = pose.x if pose is not None else (float(row.x) if row.x is not None else None)
    y = pose.y if pose is not None else (float(row.y) if row.y is not None else None)
    heading = (
        pose.heading_deg
        if pose is not None
        else (float(row.heading_deg) if row.heading_deg is not None else None)
    )
    moving = bool(simulated and pose is not None and speed > 0
                  and (planned_moving if planned_moving is not None else True))
    updated = _aware(row.updated_at)
    age_s = None if simulated or updated is None else max(0.0, (stamp - updated).total_seconds())
    stale = (not simulated) and (age_s is None or age_s > STALE_SECONDS)
    return {
        "id": row.id,
        "name": row.name or "Roboter",
        "kind": row.kind or "agv",
        "floor_id": row.floor_id,
        "active": bool(row.active),
        "state": _state(row, simulated=simulated, moving=moving),
        "simulated": simulated,
        "gateway_id": row.gateway_id or "sim",
        "battery_pct": int(row.battery_pct) if row.battery_pct is not None else None,
        "payload_kg": float(row.payload_kg or 0.0),
        "capabilities": list(row.capabilities or []),
        "route": route,
        "route_mode": "loop" if loop else "pingpong",
        "route_m": round(length, 2),
        "speed_m_s": round(speed, 2),
        "progress_m": round(progress, 2),
        "x": round(x, 3) if x is not None else None,
        "y": round(y, 3) if y is not None else None,
        "heading_deg": round(heading, 1) if heading is not None else None,
        "position_known": x is not None and y is not None,
        "heading_known": heading is not None,
        "age_s": round(age_s, 1) if age_s is not None else None,
        "stale": stale,
        "updated_at": updated.isoformat() if updated else None,
        "active_job": _active_job(db, row.id),
        # Fahrplan der Simulation: die Oberfläche rechnet damit dieselbe Lage
        # wie der Server, auch zwischen zwei Abrufen.
        "sim_plan": ({**plan.as_dict(), "epoch": TRAFFIC_EPOCH.isoformat()} if plan is not None else None),
    }


def as_dict(
    row: RobotAsset,
    *,
    now: Optional[datetime] = None,
    db: Optional[Session] = None,
) -> dict:
    """Eine Zeile als Sicht — für die Liste und die Antwort nach dem Anlegen."""
    return _dict(row, _aware(now) or _now(), db)


def snapshot(
    db: Session,
    *,
    floor_id: Optional[int] = None,
    now: Optional[datetime] = None,
) -> dict:
    """Alle Roboter als Sicht — mit Position, Weg und Quelle.

    ``now`` ist der einzige Zeitgeber. Ein Test reicht eine feste Zeit hinein
    und bekommt eine feste Antwort; die Oberfläche nimmt die Serverzeit als
    Bezug und rechnet zwischen zwei Abrufen weiter.
    """
    stamp = _aware(now) or _now()
    q = db.query(RobotAsset).order_by(RobotAsset.id.asc())
    if floor_id is not None:
        q = q.filter(RobotAsset.floor_id == floor_id)
    rows = q.all()
    plans = floor_plans(rows)
    robots = [_dict(r, stamp, db, plans) for r in rows]
    return {
        "robots": robots,
        "sampled_at": stamp.isoformat(),
        "simulated": any(r["simulated"] for r in robots),
    }


def of_station(db: Session, station_id: int) -> list[RobotAsset]:
    """Roboter auf derselben Ebene wie eine Station — für spätere Transporte.

    Eine Station ohne ``floor_id`` steht laut Hausregel auf der ersten Ebene
    (kleinste id); dieselbe Auflösung gilt hier, sonst fände ein späterer
    Transport an Alt-Stationen nie einen Roboter.
    """
    from ..models import FactoryFloor, FactoryStation

    st = db.get(FactoryStation, station_id)
    if st is None:
        return []
    floor_id = st.floor_id
    if floor_id is None:
        first = db.query(FactoryFloor.id).order_by(FactoryFloor.id.asc()).first()
        floor_id = int(first[0]) if first else None
    if floor_id is None:
        return []
    return (
        db.query(RobotAsset)
        .filter(RobotAsset.floor_id == floor_id)
        .filter(RobotAsset.active.is_(True))
        .order_by(RobotAsset.id.asc())
        .all()
    )


def _when(value: object, fallback: datetime) -> datetime:
    if isinstance(value, datetime):
        return _aware(value) or fallback
    if isinstance(value, str) and value.strip():
        try:
            return _aware(datetime.fromisoformat(value.strip().replace("Z", "+00:00"))) or fallback
        except ValueError:
            return fallback
    return fallback


def gateway_by_code(db: Session, code: str) -> Optional[RobotGateway]:
    return db.query(RobotGateway).filter(RobotGateway.code == code).first()


def prune_events(
    db: Session,
    *,
    keep_days: int = ROBOT_EVENT_KEEP_DAYS,
    now: Optional[datetime] = None,
) -> int:
    """Alte Roboterereignisse verwerfen und die Zahl zurückgeben.

    ``now`` ist der einzige Zeitgeber. Der Aufrufer entscheidet, wann geputzt
    wird (Scheduler, CLI, Wartungsfenster); diese Datei putzt nie von selbst,
    damit ein Lesen der Flotte keine Schreiblast erzeugt.
    """
    stamp = _aware(now) or _now()
    days = max(0, int(keep_days))
    cutoff = stamp - timedelta(days=days)
    removed = (
        db.query(RobotEvent)
        .filter(RobotEvent.received_at < cutoff)
        .delete(synchronize_session=False)
    )
    db.commit()
    return int(removed or 0)


def ingest(
    db: Session,
    gateway: RobotGateway,
    payload: dict,
    *,
    now: Optional[datetime] = None,
) -> dict:
    """Eine Telemetriemeldung eines Gateways übernehmen.

    Nur Zustandswechsel und ein Takt werden gespeichert. Eine doppelte
    ``idempotency_key`` ist folgenlos. Ein Zustandswechsel schreibt eine
    Protokollzeile; ein reiner Herzschlag nicht — sonst wäre das Protokoll
    nach einer Schicht unlesbar.
    """
    stamp = _aware(now) or _now()
    try:
        robot_id = int(payload.get("robot_id") or 0)
    except (TypeError, ValueError):
        raise ValueError("Die Meldung nennt keinen Roboter.")
    row = db.get(RobotAsset, robot_id)
    if row is None:
        raise ValueError("Roboter nicht gefunden.")
    if (row.gateway_id or "").strip() != gateway.code:
        raise ValueError("Der Roboter gehört zu einem anderen Gateway.")

    key = str(payload.get("idempotency_key") or "").strip()[:160]
    if key:
        seen = (
            db.query(RobotEvent.id)
            .filter(RobotEvent.gateway_id == gateway.code)
            .filter(RobotEvent.robot_id == row.id)
            .filter(RobotEvent.idempotency_key == key)
            .first()
        )
        if seen is not None:
            return {**as_dict(row, now=stamp, db=db), "duplicate": True}

    changed: list[str] = []
    for field, limit in (("x", 1_000_000.0), ("y", 1_000_000.0)):
        if field in payload:
            raw = payload.get(field)
            if raw is None:
                setattr(row, field, None)
                changed.append(field)
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                raise ValueError(f"{field} ist keine Zahl.")
            if not math.isfinite(value) or abs(value) > limit:
                raise ValueError(f"{field} liegt außerhalb der Halle.")
            setattr(row, field, value)
            changed.append(field)
    if "heading_deg" in payload:
        raw = payload.get("heading_deg")
        if raw is None:
            row.heading_deg = None
        else:
            try:
                value = float(raw)
            except (TypeError, ValueError):
                raise ValueError("heading_deg ist keine Zahl.")
            if not math.isfinite(value):
                raise ValueError("heading_deg ist keine endliche Zahl.")
            row.heading_deg = value % 360.0
        changed.append("heading_deg")
    if "battery_pct" in payload:
        raw = payload.get("battery_pct")
        if raw is None:
            row.battery_pct = None
        else:
            try:
                value = int(raw)
            except (TypeError, ValueError):
                raise ValueError("battery_pct ist keine ganze Zahl.")
            if not (0 <= value <= 100):
                raise ValueError("battery_pct liegt zwischen 0 und 100.")
            row.battery_pct = value
        changed.append("battery_pct")
    old_state = (row.state or "idle").strip().lower()
    if "state" in payload:
        state = str(payload.get("state") or "").strip().lower()
        if state not in OPEN_STATES:
            raise ValueError("Unbekannter Roboterzustand.")
        row.state = state
        changed.append("state")
    else:
        state = old_state

    row.updated_at = stamp
    gateway.last_seen_at = stamp
    quality = str(payload.get("quality") or "reported").strip().lower()
    if quality not in QUALITIES:
        quality = "reported"
    db.add(
        RobotEvent(
            robot_id=row.id,
            gateway_id=gateway.code,
            type=str(payload.get("type") or "telemetry")[:40],
            ts=_when(payload.get("ts"), stamp),
            received_at=stamp,
            quality=quality,
            idempotency_key=key,
            payload={
                "x": row.x,
                "y": row.y,
                "heading_deg": row.heading_deg,
                "battery_pct": row.battery_pct,
                "state": state,
            },
        )
    )
    if old_state != state:
        db.add(
            AuditLog(
                actor=f"gateway:{gateway.code}",
                action="robot_state",
                entity="robot_asset",
                entity_id=str(row.id),
                detail={"from": old_state, "to": state, "gateway": gateway.code},
            )
        )
    db.commit()
    return {**as_dict(row, now=stamp, db=db), "duplicate": False}
