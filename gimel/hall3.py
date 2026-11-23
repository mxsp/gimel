"""Halle 3 "Experimental" — die dritte Halle des Digitalen Zwillings.

Eine Ebene (EG), rechts neben Halle 2, mit genau einem Tor. Darauf stehen der
7-Achs-Roboter (als ``RobotAsset`` mit ``kind="arm"``), sein Arbeitstisch und
die Pakete. Die Sortierzelle selbst ist die 3D-Ansicht im Portal unter
Roboter → Arme & Zellen; die Halle ist ihr Platz im Grundriss.

Die Funktion ist **idempotent**: ein schon vorhandenes "Hall 3 Experimental"
wird nicht verändert. Der Kartenanker wird aus Halle 2 und dessen EG-Umriss
berechnet — bleibt also auch dann „neben Halle 2", wenn jemand die Anker in
der Oberfläche verschiebt. Mathematisch dieselbe Abbildung wie
``web/src/sites.ts::hallToWorld`` (worldToHall ist ihre eigene Inverse).
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Sequence

from sqlalchemy.orm import Session

from .models import (
    FactoryFloor,
    FactoryHall,
    FactorySite,
    FactoryStation,
    FactoryStationType,
    RobotAsset,
    RobotProgram,
    StationRouting,
)

HALL_NAME = "Hall 3 Experimental"
HALL_CODE = "H3"
ARM_NAME = "7-Achs-Roboter Experimental"
M_PER_DEG_LAT = 111_320.0
#: Derselbe Gang zwischen Hallen wie in ThreeFloorPlan.placeNeighbors.
HALL_GAP_M = 24.0
HALL_W = 32.0
HALL_H = 20.0

_TYPE_COLOUR = {
    FactoryStationType.production: "#106ba3",
    FactoryStationType.shipping: "#217e56",
    FactoryStationType.accounting: "#ca9c19",
    FactoryStationType.warehouse: "#8e5cb8",
}

#: „Hello World" — die erste Bewegungsfolge des Arms, in Radiant je Achse.
#: Dieselbe Folge zeichnet web/src/components/twin/robotModel.ts im Zwilling.
#: Gimel führt Programme nie aus (siehe RobotProgram): gespeichert, ausgeliefert,
#: im Digitalen Zwilling **dargestellt**, nie eine echte Steuerung.
HELLO_WORLD = [
    [0.35, -0.35, 1.95, 0.08, 1.60, 0.00, 0.00],
    [0.95, -0.62, 2.15, 0.30, 1.53, -0.40, -0.40],
    [0.05, -0.18, 1.62, -0.28, 1.42, 0.45, 0.45],
    [0.35, -0.35, 1.95, 0.08, 1.60, 0.00, 0.00],
]
HELLO_CYCLE_S = 6.4
PROGRAM_NAME = "Hello World"


def _ensure_hello_world(db: Session, arm_id: int) -> bool:
    """Die Mission einmalig anlegen — idempotent wie die ganze Halle."""
    if db.query(RobotProgram).filter(RobotProgram.name == PROGRAM_NAME,
                                     RobotProgram.robot_id == arm_id).first():
        return False
    body = json.dumps({
        "name": PROGRAM_NAME,
        "axes": ["A1", "A2", "A3", "A4", "A5", "A6", "A7"],
        "poses_rad": HELLO_WORLD,
        "cycle_s": HELLO_CYCLE_S,
        "note": "Darstellung im Digitalen Zwilling; Gimel führt Programme nicht aus.",
    }, ensure_ascii=False, indent=2)
    db.add(RobotProgram(
        name=PROGRAM_NAME, version=1, kind="mission", language="json",
        body=body, checksum=hashlib.sha256(body.encode("utf-8")).hexdigest(),
        status="approved", robot_id=arm_id, gateway_id="sim",
        notes="Erste Fahrt des 7-Achs-Arms: Grundstellung, Winken, Gegenseite, zurück. "
              "Wird im Twin Studio als Bewegung gezeigt, nicht an eine Steuerung gesendet.",
        created_by="gimel hall3",
    ))
    db.commit()
    return True


def _rect(x1: float, y1: float, x2: float, y2: float) -> list[list[float]]:
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def _hall_width(floor: FactoryFloor | None, fallback: float = 40.0) -> float:
    outline = (floor.outline or []) if floor else []
    pts = [float(p[0]) for p in outline if isinstance(p, Sequence) and len(p) >= 2]
    return max(pts) - min(pts) if len(pts) >= 2 else fallback


def _anchor_next_to(hall2: FactoryHall, dx_m: float) -> tuple[float, float]:
    """Anker von Halle 3: ``dx_m`` Meter entlang der x-Achse von Halle 2.

    ``hallToWorld(x, y, rot)`` = ``[x·cos t + y·sin t, x·sin t − y·cos t]``.
    Weil die Abbildung selbstinvers ist, liefert derselbe Ausdruck mit dem
    gewünschten Hallenversatz die Metern nach Osten/Norden.
    """
    t = math.radians(float(hall2.rotation_deg or 0.0))
    east = dx_m * math.cos(t)
    north = dx_m * math.sin(t)
    lat0 = float(hall2.lat or 0.0)
    lon0 = float(hall2.lon or 0.0)
    lat = lat0 + north / M_PER_DEG_LAT
    lon = lon0 + east / (M_PER_DEG_LAT * math.cos(math.radians(lat0)))
    return lat, lon


def _shrink_legacy_cell(db: Session, hall: FactoryHall) -> int:
    """Ältere Fassung hatte einen Stationskörper genau auf dem Arm — der
    verdeckte ihn im 3D-Bild. Statt ihn zu löschen (Fremdschlüssel!) wird er
    zu einer kleinen Bodenplatte, die unter der Zelle verschwindet."""
    floor_ids = [r[0] for r in db.query(FactoryFloor.id)
                 .filter(FactoryFloor.hall_id == hall.id).all()]
    if not floor_ids:
        return 0
    stale = (db.query(FactoryStation)
             .filter(FactoryStation.floor_id.in_(floor_ids),
                     FactoryStation.label == "Sortierzelle 7-Achs").all())
    changed = 0
    for s in stale:
        if s.model_kind == "box" and (s.w or 0) <= 1.2 and (s.h or 0) <= 1.2:
            continue  # schon beim letzten Lauf verkleinert
        s.model_kind = "box"
        s.w, s.h = 1.2, 1.2
        changed += 1
    if changed:
        db.commit()
    return changed


def ensure_hall3(db: Session) -> str:
    """Halle 3 anlegen, wenn sie fehlt. Rückgabe: eine kurze Statuszeile."""
    existing = db.query(FactoryHall).filter(FactoryHall.name == HALL_NAME).first()
    if existing:
        fixed = _shrink_legacy_cell(db, existing)
        arm = db.query(RobotAsset).filter(RobotAsset.name == ARM_NAME).first()
        added = _ensure_hello_world(db, arm.id) if arm else False
        note = (" · verdeckende Station verkleinert" if fixed else "") + \
               (" · Hello-World-Mission angelegt" if added else "")
        return f"{HALL_NAME} ist schon vorhanden{note or ' — nichts geändert'}."

    site = db.query(FactorySite).order_by(FactorySite.id.asc()).first()
    if site is None:
        raise RuntimeError("Kein Standort vorhanden — erst `gimel demo` ausführen.")

    hall2 = (db.query(FactoryHall).filter(FactoryHall.name == "Halle 2").first()
             or db.query(FactoryHall).filter(FactoryHall.code == "LOG").first()
             or db.query(FactoryHall).order_by(FactoryHall.sort.asc(), FactoryHall.id.asc()).first())
    if hall2 is None:
        raise RuntimeError("Halle 2 fehlt — Halle 3 kann nicht daneben gesetzt werden.")

    h2_eg = (db.query(FactoryFloor)
             .filter(FactoryFloor.hall_id == hall2.id, FactoryFloor.level >= 0)
             .order_by(FactoryFloor.level.asc(), FactoryFloor.id.asc())
             .first())
    dx = _hall_width(h2_eg) + HALL_GAP_M
    lat, lon = _anchor_next_to(hall2, dx)
    highest = db.query(FactoryHall.sort).order_by(FactoryHall.sort.desc()).first()
    sort = int((highest[0] if highest else 0) or 0) + 1

    hall = FactoryHall(
        site_id=site.id, name=HALL_NAME, code=HALL_CODE, sort=sort,
        lat=lat, lon=lon, rotation_deg=float(hall2.rotation_deg or 0.0),
        map_enabled=bool(hall2.map_enabled),
        note="Experimentierhalle: 7-Achs-Roboter sortiert Dichtungen und Formteile "
             "mit Teileerkennung. Eine Ebene, ein Tor zu Halle 2.",
    )
    db.add(hall)
    db.flush()

    floor = FactoryFloor(
        name=HALL_NAME, hall_id=hall.id, level=0, level_name="EG",
        elevation_m=0.0, height_m=6.0,
        outline=_rect(0, 0, HALL_W, HALL_H),
        zones=[{"name": "Experimentierfläche", "kind": "production", "colour": "#106ba3",
                "points": _rect(10, 4, 24, 16)}],
        obstacles=[],
        # Genau ein Tor: Westwand, in der Mitte, zur Nachbarhalle.
        doors=[{"name": "Tor Halle 2", "x": 0.0, "y": HALL_H / 2,
                "width": 3.0, "kind": "gate"}],
        aisles={"nodes": [[2, 10], [7, 5], [16, 8], [25, 14], [16, 16], [30, 10]],
                "edges": [[0, 1], [1, 2], [2, 3], [2, 4], [4, 5]]},
        conveyors=[],
        scale=40.0, grid=1.0, snap=0.25, bg="#f5f5f0",
    )
    db.add(floor)
    db.flush()

    def station(label: str, kind: FactoryStationType, x: float, y: float,
                w: float, h: float, model: str, note: str, **kw) -> FactoryStation:
        return FactoryStation(
            label=label, type=kind, floor_id=floor.id,
            x=x, y=y, w=w, h=h, rotation=0.0,
            colour=_TYPE_COLOUR[kind], routing=StationRouting.pull,
            model_kind=model, note=note, **kw,
        )

    # Nur Tisch und Pakete sind Stationen. Der Arm selbst ist ein Roboter
    # („Ein Roboter ist kein Arbeitsplatz", siehe pages/Robots.tsx): ein
    # Stationskörper an derselben Stelle würde ihn im 3D-Bild verdecken.
    db.add_all([
        station("Arm-Arbeitstisch", FactoryStationType.accounting,
                7, 5, 4, 3, "office",
                "Arbeitstisch am Roboter: Schreibtischinsel für Einmessung, Prüfung und Protokoll.",
                task_min=3, unit_min=1),
        station("Pakete", FactoryStationType.shipping,
                25, 14, 4, 3, "packing",
                "Kartons und Pakete, die der Arm nach der Teileerkennung sortiert ablegt.",
                task_min=4, unit_min=1.5),
    ])

    # Ein stationärer Arm: kein Weg, aber eine gemeldete Position (x/y), damit
    # der Zwilling ihn zeichnet. gateway_id="sim" hält ihn ohne Altersprüfung
    # sichtbar; ohne route fährt er nicht.
    arm = RobotAsset(
        name=ARM_NAME, kind="arm", floor_id=floor.id,
        route=[], route_mode="pingpong", speed_m_s=0.0,
        x=16.0, y=8.0, heading_deg=0.0,
        state="idle", gateway_id="sim", capabilities=["arm", "pick", "sort"],
        payload_kg=8.0, active=True,
    )
    db.add(arm)
    db.flush()
    _ensure_hello_world(db, arm.id)
    db.commit()
    return (f"{HALL_NAME} angelegt: 1 Ebene, 1 Tor, Arbeitstisch + Pakete, "
            f"{ARM_NAME} mit Mission 'Hello World' · {dx:.0f} m neben Halle 2 "
            f"(Anker {lat:.6f}/{lon:.6f}).")
