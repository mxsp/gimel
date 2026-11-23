"""`gimel demo --enrich`: die Demo lebt — idempotent, über Namen, ohne etwas zu verschieben.

Jede Prüfung arbeitet auf einer eigenen Kopie einer eigenen Demo-Datenbank. Gesät wird
über die CLI in einem eigenen Prozess (wie ``test_cli.py``), damit weder die Sperre des
Sammellaufs noch eine Sitzung in die gemeinsame Testdatenbank greift.
"""

from __future__ import annotations

import math
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, func, inspect, select, table
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from gimel import demo
from gimel.core import route_improve as ri
from gimel.core.layout import Layout, point_in_polygon, segment_blocked
from gimel.core.robot_way import route_problems
from gimel.db import Base
from gimel.models import (
    AuditLog,
    FactoryFloor,
    FactoryHall,
    FactoryStation,
    RobotAsset,
    StationTask,
    WorkOrder,
    WorkOrderStatus,
)
from gimel.services import robot_fleet, robot_ways, worklist

ROOT = Path(__file__).resolve().parents[2]

#: Die Saat ohne Belebung — so sah jede Demo vor `--enrich` aus.
_OLD_SEED = (
    "import gimel.demo as d\n"
    "d.enrich = lambda db, now=None: None\n"
    "from gimel.cli import main\n"
    "raise SystemExit(main(['demo']))\n"
)


def _gimel(data: Path, *cmd: str, check: bool = True) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items()
           if k not in ("GIMEL_APP_ROOT", "GIMEL_SECRET_KEY", "GIMEL_ENV_PREFIX", "GIMEL_DATABASE_URL")}
    env |= {"GIMEL_DATA": str(data), "PYTHONPATH": str(ROOT), "GIMEL_MAIL_SILENT": "1"}
    return subprocess.run([sys.executable, *cmd], env=env, cwd=data.parent, check=check,
                          capture_output=True, text=True)


def _copy(src: Path, dst: Path) -> Path:
    """Kopie über die Backup-Schnittstelle von SQLite, nie über das Dateisystem (WAL)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(f"file:{src}?mode=ro", uri=True) as a, sqlite3.connect(dst) as b:
        a.backup(b)
    return dst


def _engine(path: Path):
    return create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False},
                         poolclass=NullPool, future=True)


def _counts(engine) -> dict[str, int]:
    """Zeilen je Tabelle — je Tabelle, die in *dieser* Datei steht (die Metadaten des
    Testprozesses kennen mehr Tabellen, sobald andere Module geladen sind)."""
    with engine.connect() as conn:
        names = inspect(conn).get_table_names()
        return {n: conn.execute(select(func.count()).select_from(table(n))).scalar_one()
                for n in names}


@pytest.fixture(scope="module")
def seeded(tmp_path_factory) -> Path:
    data = tmp_path_factory.mktemp("enrich") / "fresh"
    _gimel(data, "-m", "gimel", "demo")
    return data / "gimel.db"


@pytest.fixture(scope="module")
def old_demo(tmp_path_factory) -> Path:
    data = tmp_path_factory.mktemp("enrich") / "old"
    _gimel(data, "-c", _OLD_SEED)
    return data / "gimel.db"


def _floor_h2_eg(db: Session) -> FactoryFloor:
    hall = db.query(FactoryHall).filter(FactoryHall.name == demo.AMR_HALL).one()
    return db.query(FactoryFloor).filter(FactoryFloor.hall_id == hall.id,
                                         FactoryFloor.level == demo.AMR_LEVEL).one()


def _snapshot(db: Session) -> dict:
    """Was ``enrich`` nie bewegen darf: Lage der Stationen, Gänge, bestehende Roboter."""
    return {
        "stations": sorted((s.id, s.label, s.floor_id, s.x, s.y, s.w, s.h, s.rotation)
                           for s in db.query(FactoryStation)),
        "floors": sorted((f.id, repr(f.outline), repr(f.obstacles), repr(f.aisles))
                         for f in db.query(FactoryFloor)),
        "robots": sorted((r.id, r.name, r.floor_id, repr(r.route), r.route_mode, r.speed_m_s,
                          str(r.sim_started_at)) for r in db.query(RobotAsset)),
    }


# ---------------------------------------------------------------------------
# Keine Demo — keine Änderung
# ---------------------------------------------------------------------------
def test_refuses_a_database_that_is_not_the_demo_plant(tmp_path):
    engine = _engine(tmp_path / "plain.db")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        with pytest.raises(demo.NotADemo):
            demo.enrich(db)
    with pytest.raises(demo.NotADemo):
        demo.enrich_atomic(engine)
    assert set(_counts(engine).values()) == {0}


# ---------------------------------------------------------------------------
# Eine frische Demo endet belebt
# ---------------------------------------------------------------------------
def test_a_fresh_demo_has_machines_running_with_audit_lines(seeded, tmp_path):
    engine = _engine(_copy(seeded, tmp_path / "gimel.db"))
    with Session(engine) as db:
        running = db.query(WorkOrder).filter(WorkOrder.status == WorkOrderStatus.running).all()
        assert 1 <= len(running) <= len(demo.RUNNING_AT)
        stations = {s.id: s for s in db.query(FactoryStation)}
        assert {stations[wo.station_id].label for wo in running} <= set(demo.RUNNING_AT)
        assert len({wo.station_id for wo in running}) == len(running), "eine Maschine, ein Auftrag"
        for wo in running:
            assert wo.started_by == demo.ACTOR and wo.started_at is not None
            assert wo.material_staged_at is not None, "Material steht bereit, bevor geschnitten wird"
            cut = db.query(StationTask).filter_by(kind="cut", ref=wo.no).one()
            assert cut.state == "running" and cut.station_id == wo.station_id
            line = (db.query(AuditLog)
                    .filter_by(action="task_state", entity="station_task", entity_id=str(cut.id)).one())
            assert line.actor == demo.ACTOR
            assert line.detail["state"] == "running" and line.detail["ref"] == f"cut:{wo.no}"
            pick = db.query(StationTask).filter_by(kind="pick", ref=wo.no).first()
            if pick is not None:
                assert pick.state == "done"
                assert db.query(AuditLog).filter_by(action="task_state",
                                                    entity_id=str(pick.id)).count() == 1
            # Der Zwilling liest „läuft“ aus dem Plan der Station.
            sched = worklist.schedule_for(db, wo.station_id)
            assert any(s.task.ref == wo.no and s.task.started for s in sched.slots)
        # Still bleibt nur, wer nichts in der Warteschlange hat — kein Auftrag wird erfunden.
        busy = {wo.station_id for wo in running}
        for label in demo.RUNNING_AT:
            st = db.query(FactoryStation).filter_by(label=label).one()
            if st.id not in busy:
                assert not db.query(WorkOrder).filter(WorkOrder.station_id == st.id,
                                                      WorkOrder.status == WorkOrderStatus.open).count()


def test_a_fresh_demo_carries_storage_kinds_and_capacities(seeded, tmp_path):
    engine = _engine(_copy(seeded, tmp_path / "gimel.db"))
    with Session(engine) as db:
        for label, subtype in demo.STORAGE_SUBTYPES.items():
            assert db.query(FactoryStation).filter_by(label=label).one().subtype == subtype, label
        for label, minutes in demo.CAPACITIES.items():
            assert db.query(FactoryStation).filter_by(label=label).one().capacity_min_per_day == minutes


def test_the_second_amr_exists_once_and_its_loop_is_clear(seeded, tmp_path):
    engine = _engine(_copy(seeded, tmp_path / "gimel.db"))
    with Session(engine) as db:
        rows = db.query(RobotAsset).filter(RobotAsset.name == demo.AMR_NAME).all()
        assert len(rows) == 1
        amr = rows[0]
        floor = _floor_h2_eg(db)
        assert amr.floor_id == floor.id
        assert (amr.kind, amr.gateway_id, amr.state) == ("amr", "sim", "moving")
        # Rundkurs, wenn er in den Fahrplan passt; sonst eine Pendelstrecke abseits des Hauptgangs.
        assert amr.route_mode in ("loop", "pingpong")
        loop = amr.route_mode == "loop"
        assert (amr.speed_m_s, amr.battery_pct, amr.payload_kg) == (0.8, 73, 300)
        assert amr.capabilities == ["transport", "lift"] and amr.sim_started_at is not None
        assert db.query(AuditLog).filter_by(action="robot_create", entity_id=str(amr.id),
                                            actor=demo.ACTOR).count() == 1

        layout = Layout.from_row(floor)
        bodies = robot_ways.station_bodies(db, floor.id)
        route = [(float(x), float(y)) for x, y in amr.route]
        assert len(route) >= 2
        # Die Prüfung der Verbesserung: nichts mehr zu verbessern, nichts blockiert.
        imp = ri.improve(layout, route, loop=loop, bodies=bodies)
        assert not imp.changed and not imp.problems_after
        assert imp.blocked == 0 and imp.air_legs == 0
        assert not route_problems(layout, route + (route[:1] if loop else []))
        # Fahrplan der Ebene (core.robot_traffic): niemand muss stehen bleiben.
        plans = robot_fleet.floor_plans(db.query(RobotAsset).filter(RobotAsset.floor_id == floor.id).all())
        assert plans and not any(p.parked for p in plans.values()), {k: p.note for k, p in plans.items()}
        # Unabhängig nachgerechnet: kein Abschnitt (auch nicht der schließende) streift
        # ein Hindernis oder einen Stationskörper im Sicherheitsabstand.
        walls = [ri._box(p, ri.CLEARANCE_M) for p in [o.points for o in layout.obstacles] + bodies]
        legs = list(zip(route, route[1:] + (route[:1] if loop else [])))
        for a, b in legs:
            assert not segment_blocked(a, b, walls), (a, b)
            assert point_in_polygon(a, layout.outline)
        # Auf dem Gangnetz: Halte sind Gangknoten, längere Abschnitte liegen auf Gängen.
        nodes = [tuple(map(float, n)) for n in layout.aisles.nodes]
        edges = list(layout.aisles.edges)
        assert sum(1 for p in route if p in nodes) >= 2
        for a, b in legs:
            assert ri._on_network(a, b, nodes, edges) or math.dist(a, b) <= ri.KEEP_SHORT_M, (a, b)


def test_a_second_run_changes_nothing(seeded, tmp_path):
    engine = _engine(_copy(seeded, tmp_path / "gimel.db"))
    with Session(engine) as db:
        before = _snapshot(db)
    counts = _counts(engine)
    result = demo.enrich_atomic(engine)
    assert result.changes == []
    assert _counts(engine) == counts
    with Session(engine) as db:
        assert _snapshot(db) == before


# ---------------------------------------------------------------------------
# Eine bestehende Demo nachrüsten
# ---------------------------------------------------------------------------
def test_enrich_brings_an_old_demo_to_life_without_moving_anything(old_demo, seeded, tmp_path):
    engine = _engine(_copy(old_demo, tmp_path / "gimel.db"))
    with Session(engine) as db:
        assert not db.query(WorkOrder).filter(WorkOrder.status == WorkOrderStatus.running).count()
        assert not db.query(RobotAsset).filter(RobotAsset.name == demo.AMR_NAME).count()
        before = _snapshot(db)
        audit_before = db.query(AuditLog).count()

    result = demo.enrich_atomic(engine)
    assert result.changes
    with Session(engine) as db:
        # Eine Zeile im Ergebnis je Protokollzeile, jede mit „demo“ als Akteur.
        new = db.query(AuditLog).order_by(AuditLog.id).offset(audit_before).all()
        assert len(new) == len(result.changes)
        assert {line.actor for line in new} == {demo.ACTOR}
        after = _snapshot(db)
        assert after["stations"] == before["stations"]
        assert after["floors"] == before["floors"]
        old_robots = {r[0] for r in before["robots"]}
        assert [r for r in after["robots"] if r[0] in old_robots] == before["robots"]
        assert len(after["robots"]) == len(before["robots"]) + 1
        state = _demo_state(db)

    # Zweiter Lauf: nichts mehr zu tun, keine Zeile mehr in irgendeiner Tabelle.
    counts = _counts(engine)
    again = demo.enrich_atomic(engine)
    assert again.changes == [] and _counts(engine) == counts

    # Und eine frische Demo landet im selben Zustand.
    with Session(_engine(_copy(seeded, tmp_path / "fresh.db"))) as db:
        assert _demo_state(db) == state


def _demo_state(db: Session) -> dict:
    return {
        "running": sorted((wo.no, wo.station_id) for wo in
                          db.query(WorkOrder).filter(WorkOrder.status == WorkOrderStatus.running)),
        "staged": sorted(wo.no for wo in db.query(WorkOrder) if wo.material_staged_at is not None),
        "stations": sorted((s.label, s.subtype, s.capacity_min_per_day) for s in db.query(FactoryStation)),
        "amr": [(r.floor_id, r.route, r.route_mode) for r in
                db.query(RobotAsset).filter(RobotAsset.name == demo.AMR_NAME)],
    }


def test_a_failure_rolls_everything_back(old_demo, tmp_path, monkeypatch):
    engine = _engine(_copy(old_demo, tmp_path / "gimel.db"))
    counts = _counts(engine)

    def boom(*_a, **_k):
        raise RuntimeError("Ebene nicht lesbar")

    # Der letzte Schritt scheitert — nach den Zustandswechseln, die selbst committen.
    monkeypatch.setattr(demo, "_second_amr", boom)
    with pytest.raises(RuntimeError):
        demo.enrich_atomic(engine)
    assert _counts(engine) == counts
    with Session(engine) as db:
        assert not db.query(WorkOrder).filter(WorkOrder.status == WorkOrderStatus.running).count()
        assert not db.query(FactoryStation).filter(FactoryStation.subtype != "").count()


# ---------------------------------------------------------------------------
# Die CLI
# ---------------------------------------------------------------------------
def test_cli_enrich_refuses_reset_missing_and_foreign_databases(seeded, tmp_path):
    empty = tmp_path / "empty"
    out = _gimel(empty, "-m", "gimel", "demo", "--reset", "--enrich", check=False)
    assert out.returncode == 2 and "not allowed with" in out.stderr

    out = _gimel(empty, "-m", "gimel", "demo", "--enrich", check=False)
    assert out.returncode == 1 and "no database" in out.stderr
    assert not (empty / "gimel.db").exists(), "--enrich legt keine Datenbank an"

    foreign = tmp_path / "foreign"
    foreign.mkdir()
    Base.metadata.create_all(_engine(foreign / "gimel.db"))
    out = _gimel(foreign, "-m", "gimel", "demo", "--enrich", check=False)
    assert out.returncode == 1 and "does not hold the demo plant" in out.stderr

    plant = tmp_path / "plant"
    _copy(seeded, plant / "gimel.db")
    out = _gimel(plant, "-m", "gimel", "demo", "--enrich", check=False)
    assert out.returncode == 0, out.stderr
    assert "0 change(s)" in out.stdout
