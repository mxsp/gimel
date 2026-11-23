"""Der Zwilling sagt, was er weiß: Sätze, Reihenfolge und Warteschlange als Regeln.

Eigene Datenbank im Speicher: die Regeln brauchen eine bekannte Schlange, nicht die Demo.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from gimel.db import Base
from gimel.models import (
    FactoryFloor,
    FactoryStation,
    FactoryStationType,
    StationTask,
    WorkOrder,
    WorkOrderStatus,
)
from gimel.routers.factory import _station_context, station_view
from gimel.services import factory_router as fr
from gimel.services import twin_analysis as twin

T0 = datetime(2026, 11, 2, 8, 0)


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def station(db, label, kind=FactoryStationType.production, **extra) -> FactoryStation:
    s = FactoryStation(label=label, type=kind, **extra)
    db.add(s)
    db.flush()
    return s


def job(db, no, st, *, age=0, mat="epdm", planned=30.0, status=WorkOrderStatus.open) -> WorkOrder:
    wo = WorkOrder(
        no=no,
        run_id=1,
        mat=mat,
        station_id=st.id if st else None,
        planned_min=planned,
        status=status,
        created_at=T0 + timedelta(minutes=age),
    )
    db.add(wo)
    db.flush()
    return wo


def task(db, ref, st, *, seq=0, kind="cut", planned=0.0, state="waiting") -> StationTask:
    t = StationTask(kind=kind, ref=ref, station_id=st.id, seq=seq, planned_min=planned, state=state)
    db.add(t)
    db.flush()
    return t


def load_of(db, st) -> twin.StationLoad:
    spec = next(s for s in fr.station_specs(db) if s.id == st.id)
    return twin.StationLoad(station=spec, jobs=twin._open_jobs(db, st.id))


# --------------------------------------------------------------------------
# Reihenfolge
# --------------------------------------------------------------------------
def test_the_queue_follows_the_worklist_not_the_creation_date(db):
    m = station(db, "Plotter")
    job(db, "IA-1", m, age=0)
    job(db, "IA-2", m, age=1)
    job(db, "IA-3", m, age=2)
    task(db, "IA-1", m, seq=3)
    task(db, "IA-2", m, seq=1)
    task(db, "IA-3", m, seq=2)
    assert [w.no for w in twin._open_jobs(db, m.id)] == ["IA-2", "IA-3", "IA-1"]


def test_a_job_without_a_task_stays_behind_in_creation_order(db):
    m = station(db, "Plotter")
    job(db, "IA-1", m, age=0)
    job(db, "IA-2", m, age=1)
    job(db, "IA-3", m, age=2)
    task(db, "IA-3", m, seq=1)
    assert [w.no for w in twin._open_jobs(db, m.id)] == ["IA-3", "IA-1", "IA-2"]


def test_seq_zero_means_not_sorted_in_yet(db):
    m = station(db, "Plotter")
    job(db, "IA-1", m, age=0)
    job(db, "IA-2", m, age=1)
    task(db, "IA-1", m, seq=0)
    task(db, "IA-2", m, seq=4)
    assert [w.no for w in twin._open_jobs(db, m.id)] == ["IA-2", "IA-1"]


def test_only_cut_tasks_at_this_station_set_the_place(db):
    m, other = station(db, "Plotter"), station(db, "Stanze")
    job(db, "IA-1", m, age=0)
    job(db, "IA-2", m, age=1)
    task(db, "IA-2", m, seq=1, kind="pick")
    task(db, "IA-1", other, seq=9)
    task(db, "IA-2", other, seq=1, kind="pack")
    assert [w.no for w in twin._open_jobs(db, m.id)] == ["IA-1", "IA-2"]


def test_the_station_view_lists_every_job_in_worklist_order(db):
    m = station(db, "Plotter")
    db.add(FactoryFloor(name="Halle"))
    job(db, "IA-1", m, age=0)
    job(db, "IA-2", m, age=1)
    job(db, "IA-3", m, age=2, status=WorkOrderStatus.done)
    task(db, "IA-1", m, seq=2)
    task(db, "IA-2", m, seq=1)
    admin = SimpleNamespace(id=1, role=SimpleNamespace(value="admin"))
    view = station_view(sid=m.id, db=db, user=admin)
    # Das Erledigte bleibt drin: die Stationsseite braucht es für „nicht zugeordnet".
    assert [q["no"] for q in view["queue"]] == ["IA-2", "IA-1", "IA-3"]


# --------------------------------------------------------------------------
# Sätze
# --------------------------------------------------------------------------
def test_an_empty_machine_is_called_without_orders_not_standing_still(db):
    busy = station(db, "Plotter", capacity_min_per_day=60.0)
    idle = station(db, "Stanze", capacity_min_per_day=60.0)
    job(db, "IA-1", busy, planned=200.0)
    specs = fr.station_specs(db)
    titles = [
        f.title
        for f in twin._capacity_findings(db, twin._loads(db, specs), specs, fr.context(db))
    ]
    assert f"{idle.label} ohne Aufträge" in titles
    assert not any("steht still" in t for t in titles)


def test_the_changeover_sentence_counts_changes_on_both_sides(db):
    m = station(db, "Plotter", changeover_min=10.0)
    job(db, "IA-1", m, age=0, mat="epdm")
    job(db, "IA-2", m, age=1, mat="nbr")
    job(db, "IA-3", m, age=2, mat="epdm")
    [finding] = twin._changeover_findings(db, [load_of(db, m)])
    # Zwei Werkstoffe brauchen einen Wechsel, nicht zwei.
    assert "wechselt 2× den Werkstoff, 1× würde reichen" in finding.detail
    assert finding.metric.startswith("1 Wechsel")


def test_the_changeover_finding_reads_the_worklist_order(db):
    m = station(db, "Plotter", changeover_min=10.0)
    job(db, "IA-1", m, age=0, mat="epdm")
    job(db, "IA-2", m, age=1, mat="nbr")
    job(db, "IA-3", m, age=2, mat="epdm")
    # Nach Anlage wären es zwei Wechsel; die Liste hat die Werkstoffe schon gruppiert.
    task(db, "IA-1", m, seq=1)
    task(db, "IA-3", m, seq=2)
    task(db, "IA-2", m, seq=3)
    assert twin._changeover_findings(db, [load_of(db, m)]) == []


def _transport_hall(db):
    store = station(db, "Regal", FactoryStationType.warehouse, is_storage=True, x=0.0, y=0.0)
    far = station(db, "Stanze", x=100.0, y=0.0)
    near = station(db, "Plotter", x=10.0, y=0.0)
    return store, far, near


def test_the_transport_sentence_says_it_is_inferred(db):
    _, far, near = _transport_hall(db)
    job(db, "IA-1", far, age=0)
    job(db, "IA-2", far, age=1)
    specs = fr.station_specs(db)
    findings = twin._transport_findings(db, specs, fr.context(db))
    detail = next(f.detail for f in findings if f.title.startswith("Materialweg"))
    assert "abgeleitet" in detail
    assert "liefen" not in detail
    assert near.label in detail


def test_a_cancelled_work_order_leaves_no_flow(db):
    _, far, _ = _transport_hall(db)
    job(db, "IA-1", far, age=0)
    job(db, "IA-2", far, age=1, status=WorkOrderStatus.cancelled)
    job(db, "IA-3", far, age=2, status=WorkOrderStatus.done)
    edge = next(e for e in fr.material_flow(db) if e["to"] == far.id)
    # Fertig war echte Arbeit und zählt, storniert nie.
    assert edge["count"] == 2


# --------------------------------------------------------------------------
# Warteschlange auf der Karte
# --------------------------------------------------------------------------
def test_the_map_counts_minutes_on_packing_and_picking_stations(db):
    pack = station(db, "Packtisch", FactoryStationType.shipping)
    shelf = station(db, "Regal", FactoryStationType.warehouse)
    task(db, "AB-1", pack, kind="pack", planned=25.0)
    task(db, "IA-1", shelf, kind="pick", planned=12.0)
    task(db, "AB-2", pack, kind="pack", planned=99.0, state="done")
    queue, counts, _ = _station_context(db)
    assert queue[pack.id] == 25.0
    assert queue[shelf.id] == 12.0
    assert counts[pack.id] == 1


def test_a_task_without_a_duration_still_counts_as_open_work(db):
    pack = station(db, "Packtisch", FactoryStationType.shipping)
    task(db, "AB-1", pack, kind="pack", planned=0.0)
    queue, counts, _ = _station_context(db)
    assert queue[pack.id] == 0.0
    assert counts[pack.id] == 1


def test_a_stale_cut_task_does_not_outvote_its_work_order(db):
    m = station(db, "Plotter")
    job(db, "IA-1", m, planned=40.0)
    task(db, "IA-1", m, planned=120.0)
    queue, counts, _ = _station_context(db)
    assert queue[m.id] == 40.0
    assert counts[m.id] == 1


def test_a_cut_task_left_behind_after_a_move_counts_nowhere(db):
    old, new = station(db, "Plotter"), station(db, "Stanze")
    job(db, "IA-1", new, planned=40.0)
    task(db, "IA-1", old, planned=40.0)
    queue, counts, _ = _station_context(db)
    assert queue.get(old.id, 0.0) == 0.0
    assert counts.get(old.id, 0) == 0
    assert queue[new.id] == 40.0


def test_a_cut_station_adds_its_other_open_tasks(db):
    m = station(db, "Plotter")
    job(db, "IA-1", m, planned=40.0)
    task(db, "IA-1", m, planned=40.0)
    task(db, "AB-1", m, kind="process", planned=5.0)
    queue, counts, _ = _station_context(db)
    assert queue[m.id] == 45.0
    assert counts[m.id] == 2


def test_a_freshly_assigned_job_shows_before_the_next_reconcile(db):
    m = station(db, "Plotter")
    job(db, "IA-1", m, planned=45.0)
    queue, _, _ = _station_context(db)
    assert queue[m.id] == 45.0


def test_a_job_and_its_task_count_once(db):
    m = station(db, "Plotter")
    job(db, "IA-1", m, planned=45.0)
    task(db, "IA-1", m, planned=45.0)
    queue, counts, _ = _station_context(db)
    assert queue[m.id] == 45.0
    assert counts[m.id] == 1
