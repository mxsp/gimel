"""Der Vertrag der Roboter-Plattform: Fläche, Uhr, Zuweisung, Wiederherstellung.

Diese Tests halten die Eigenschaften fest, die eine Neuimplementierung nicht
verlieren darf, ohne die alten API-Tests zu ersetzen.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from gimel.services import robot_fleet, robot_jobs


def _aware(value):
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _fixture(db):
    """Zwei Stationen und ein aktiver Sim-Roboter auf derselben Ebene."""
    from gimel.models import FactoryStation, RobotAsset

    robot = (
        db.query(RobotAsset)
        .filter(RobotAsset.gateway_id == "sim", RobotAsset.active.is_(True))
        .filter(RobotAsset.floor_id.isnot(None))
        .order_by(RobotAsset.id.asc())
        .first()
    )
    assert robot is not None
    stations = (
        db.query(FactoryStation)
        .filter(FactoryStation.floor_id == robot.floor_id)
        .order_by(FactoryStation.id.asc())
        .limit(2)
        .all()
    )
    assert len(stations) == 2
    return stations[0], stations[1], robot


def _drop_job(db, job_id: int) -> None:
    from gimel.models import AuditLog, RobotJob, RobotJobRestore

    db.query(RobotJobRestore).filter(RobotJobRestore.job_id == job_id).delete()
    db.query(AuditLog).filter(
        AuditLog.entity == "robot_job", AuditLog.entity_id == str(job_id)
    ).delete()
    db.query(RobotJob).filter(RobotJob.id == job_id).delete()
    db.commit()


def _new_job(db, start_id: int, end_id: int, *, now=None):
    return robot_jobs.create(
        db,
        {"from_station_id": start_id, "to_station_id": end_id},
        "contract-test",
        now=now,
    )


def test_the_robot_api_surface_is_unchanged(client):
    paths = set(client.get("/openapi.json").json()["paths"])
    expected = {
        "/api/factory/robots",
        "/api/factory/robots/{robot_id}",
        "/api/factory/robot-gateways",
        "/api/factory/robot-gateways/{gateway_id}",
        "/api/factory/robot-gateways/{gateway_id}/test",
        "/api/factory/robot-programs",
        "/api/factory/robot-programs/{program_id}/approve",
        "/api/factory/robot-programs/{program_id}/deploy",
        "/api/factory/robot-deployments",
        "/api/factory/robot-deployments/{deployment_id}/rollback",
        "/api/factory/robot-events",
        "/api/factory/robot-jobs",
        "/api/factory/robot-jobs/plan",
        "/api/factory/robot-jobs/{job_id}",
        "/api/factory/robot-jobs/{job_id}/approve",
        "/api/factory/robot-jobs/{job_id}/assign",
        "/api/factory/robot-jobs/{job_id}/start",
        "/api/factory/robot-jobs/{job_id}/done",
        "/api/factory/robot-jobs/{job_id}/cancel",
        "/api/factory/robot-jobs/{job_id}/fail",
        "/api/factory/robot-ways/plan",
        "/api/factory/robot-ways/check",
        "/api/factory/robot-telemetry/{gateway_code}",
    }
    assert expected - paths == set()


def test_services_take_the_callers_clock(plant):
    from gimel.db import SessionLocal
    from gimel.models import RobotJob

    fixed = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    with SessionLocal() as db:
        start, end, _robot = _fixture(db)
        job = _new_job(db, start.id, end.id, now=fixed)
        try:
            robot_jobs.approve(db, job.id, "contract-test", now=fixed)
            db.expire_all()
            row = db.get(RobotJob, job.id)
            assert _aware(row.approved_at) == fixed
        finally:
            robot_jobs.cancel(db, job.id, "contract-test", note="Aufräumen", now=fixed)
            _drop_job(db, job.id)


def test_an_open_job_blocks_the_same_robot(plant):
    from gimel.db import SessionLocal

    with SessionLocal() as db:
        start, end, robot = _fixture(db)
        first = _new_job(db, start.id, end.id)
        second = _new_job(db, start.id, end.id)
        try:
            robot_jobs.assign(db, first.id, "contract-test", robot.id)
            with pytest.raises(ValueError) as exc:
                robot_jobs.assign(db, second.id, "contract-test", robot.id)
            assert "bereits einen offenen Transport" in str(exc.value)
        finally:
            robot_jobs.cancel(db, first.id, "contract-test", note="Aufräumen")
            robot_jobs.cancel(db, second.id, "contract-test", note="Aufräumen")
            _drop_job(db, first.id)
            _drop_job(db, second.id)


def test_restore_state_lives_outside_the_order_context(plant):
    from gimel.db import SessionLocal
    from gimel.models import RobotAsset, RobotJob, RobotJobRestore

    with SessionLocal() as db:
        start, end, robot = _fixture(db)
        robot_id = robot.id
        original = (list(robot.route or []), robot.route_mode, robot.sim_started_at, robot.state)
        job = _new_job(db, start.id, end.id)
        try:
            robot_jobs.assign(db, job.id, "contract-test", robot_id)
            robot_jobs.start(db, job.id, "contract-test")
            db.expire_all()
            assert db.query(RobotJobRestore).filter(RobotJobRestore.job_id == job.id).count() == 1
            assert "_robot_before" not in (db.get(RobotJob, job.id).context or {})

            robot_jobs.done(db, job.id, "contract-test", note="abgelegt")
            db.expire_all()
            assert db.query(RobotJobRestore).filter(RobotJobRestore.job_id == job.id).count() == 0
            restored = db.get(RobotAsset, robot_id)
            assert restored.state == "idle"
            assert list(restored.route or []) == original[0]
        finally:
            current = db.get(RobotAsset, robot_id)
            if current is not None:
                current.route, current.route_mode, current.sim_started_at, current.state = original
                db.commit()
            _drop_job(db, job.id)


def test_pruning_removes_only_old_robot_events(plant):
    from gimel.db import SessionLocal
    from gimel.models import RobotAsset, RobotEvent

    fixed = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    with SessionLocal() as db:
        robot = db.query(RobotAsset).order_by(RobotAsset.id.asc()).first()
        assert robot is not None
        old = RobotEvent(robot_id=robot.id, type="contract-test",
                         ts=fixed - timedelta(days=40),
                         received_at=fixed - timedelta(days=40), payload={})
        new = RobotEvent(robot_id=robot.id, type="contract-test", ts=fixed,
                         received_at=fixed, payload={})
        db.add_all([old, new])
        db.commit()
        try:
            removed = robot_fleet.prune_events(db, keep_days=30, now=fixed)
            assert removed >= 1
            remaining = [
                row.id for row in db.query(RobotEvent)
                .filter(RobotEvent.type == "contract-test").all()
            ]
            assert remaining == [new.id]
        finally:
            db.query(RobotEvent).filter(RobotEvent.type == "contract-test").delete()
            db.commit()
