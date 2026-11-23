"""Halle 3 Experimental — idempotent neben Halle 2, eine Ebene, ein Tor.

Eigene, leere Datenbank: dieser Test verändert die Demo-Pflanze der anderen
Tests nicht. Geprüft werden Anker („neben Halle 2"), Daten und Wiederholung.
"""

from __future__ import annotations

import json
import math

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from gimel.db import Base
from gimel.hall3 import HELLO_WORLD, HALL_GAP_M, HALL_NAME, PROGRAM_NAME, ensure_hall3
from gimel.models import (
    FactoryFloor,
    FactoryHall,
    FactorySite,
    FactoryStation,
    FactoryStationType,
    RobotAsset,
    RobotProgram,
)

M_PER_DEG_LAT = 111_320.0


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    site = FactorySite(name="Werk", code="W", lat=51.554817, lon=12.307577)
    session.add(site)
    session.flush()
    session.add_all([
        FactoryHall(site_id=site.id, name="Halle 1", code="H1", sort=0,
                    lat=51.554817, lon=12.307577, rotation_deg=-23.3),
        FactoryHall(site_id=site.id, name="Halle 2", code="LOG", sort=1,
                    lat=51.554556, lon=12.308544, rotation_deg=-24.2),
        FactoryFloor(name="Halle 2", hall_id=2, level=0, level_name="EG",
                     outline=[[0, 0], [40, 0], [40, 24], [0, 24]]),
    ])
    session.commit()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _offset(h2: FactoryHall, h3: FactoryHall) -> tuple[float, float]:
    """Dieselbe Rechnung wie web/src/sites.ts::hallOffset."""
    t = math.radians(h2.rotation_deg or 0)
    east = (h3.lon - h2.lon) * M_PER_DEG_LAT * math.cos(math.radians(h2.lat))
    north = (h3.lat - h2.lat) * M_PER_DEG_LAT
    return east * math.cos(t) + north * math.sin(t), east * math.sin(t) - north * math.cos(t)


def test_hall3_is_one_floor_next_to_hall2(db):
    first = ensure_hall3(db)
    assert "angelegt" in first

    hall = db.query(FactoryHall).filter_by(name=HALL_NAME).one()
    assert (hall.code, hall.sort, hall.rotation_deg) == ("H3", 2, -24.2)
    h2 = db.query(FactoryHall).filter_by(name="Halle 2").one()
    x, y = _offset(h2, hall)
    assert abs(x - (40 + HALL_GAP_M)) < 0.01, f"Versatz in x: {x}"
    assert abs(y) < 0.01, f"Versatz in y: {y}"

    floors = db.query(FactoryFloor).filter_by(hall_id=hall.id).all()
    assert len(floors) == 1
    floor = floors[0]
    assert (floor.level, floor.level_name) == (0, "EG")
    assert floor.outline == [[0, 0], [32, 0], [32, 20], [0, 20]]
    assert len(floor.doors) == 1
    assert floor.doors[0]["kind"] == "gate" and floor.doors[0]["x"] == 0

    stations = db.query(FactoryStation).filter_by(floor_id=floor.id).all()
    assert len(stations) == 2, "der Arm ist ein Roboter, kein Stationskörper"
    assert {s.model_kind for s in stations} == {"office", "packing"}
    assert {s.label for s in stations} == {"Arm-Arbeitstisch", "Pakete"}

    arm = db.query(RobotAsset).filter_by(floor_id=floor.id).one()
    assert arm.kind == "arm" and arm.route == []
    assert (arm.x, arm.y, arm.gateway_id, arm.active) == (16.0, 8.0, "sim", True)

    # „Hello World": Mission am Arm, Text mit Prüfsumme, nie ausgeführt.
    program = db.query(RobotProgram).filter_by(name=PROGRAM_NAME).one()
    assert program.robot_id == arm.id and program.status == "approved"
    assert len(program.checksum) == 64
    assert json.loads(program.body)["poses_rad"] == HELLO_WORLD


def test_hall3_is_idempotent_and_shrinks_a_legacy_cell(db):
    assert "angelegt" in ensure_hall3(db)
    floor = db.query(FactoryFloor).filter_by(name=HALL_NAME).one()
    db.add(FactoryStation(label="Sortierzelle 7-Achs", type=FactoryStationType.production, floor_id=floor.id,
                          x=16, y=8, w=6, h=5, model_kind="generic"))
    db.commit()
    assert "verkleinert" in ensure_hall3(db)
    legacy = db.query(FactoryStation).filter_by(label="Sortierzelle 7-Achs").one()
    assert (legacy.model_kind, legacy.w, legacy.h) == ("box", 1.2, 1.2)
    assert "nichts geändert" in ensure_hall3(db)
    assert db.query(FactoryHall).filter_by(name=HALL_NAME).count() == 1
    assert db.query(FactoryFloor).filter_by(name=HALL_NAME).count() == 1
    assert db.query(RobotAsset).filter_by(kind="arm").count() == 1
    assert db.query(RobotProgram).filter_by(name=PROGRAM_NAME).count() == 1
