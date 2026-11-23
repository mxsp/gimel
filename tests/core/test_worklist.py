"""Der Arbeitsvorrat hält, was er verspricht — und sagt, was er nicht weiß.

Zuerst der reine Kern (``domain/worklist``), dann die Naht über die API.
Die Reihenfolge ist Absicht, wie in ``test_factory_routing``: eine Regel, die
sich nur über HTTP prüfen lässt, ist keine Regel, sondern ein Endpunkt.

Die Prüfungen sind bewusst so geschrieben, dass sie die *Aussage* prüfen und
nicht die Zahl: „gleiche Werkstoffe landen zusammen", „ein Termin schlägt das
Rüstsparen", „eine Maschine bekommt alles, zwei teilen sich". Wer die
Gewichte anpasst, soll die Tests nicht anfassen müssen — wer die Regel
umdreht, soll sie nicht grün bekommen.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone

import pytest

from gimel.core.routing import RoutingContext, StationSpec, eligibility
from gimel.core.worklist import (
    KIND_STATION_TYPE,
    Task,
    WorklistPolicy,
    changeover_between,
    options_for,
    priority,
    sequence,
    spread,
    task_minutes,
)



# ==========================================================================
# Bausteine
# ==========================================================================
def plotter(sid: int, label: str, **kw) -> StationSpec:
    base = dict(
        type="production",
        routing="smart_auto",
        machine_kind="plotter",
        speed_mm_s=50.0,
        pierce_s=2.0,
        setup_min=10.0,
        changeover_min=15.0,
        handling_min_per_plate=2.0,
        capacity_min_per_day=480.0,
    )
    base.update(kw)
    return StationSpec(id=sid, label=label, **base)


def bench(sid: int, label: str, stype: str, **kw) -> StationSpec:
    base = dict(type=stype, routing="smart_auto", task_min=5.0, unit_min=2.0)
    base.update(kw)
    return StationSpec(id=sid, label=label, **base)


def cut(ref: str, mat: str = "EPDM", thk: float = 3.0, **kw) -> Task:
    base = dict(
        kind="cut",
        ref=ref,
        mat=mat,
        thk=thk,
        units=1,
        n_plates=1,
        n_parts=10,
        cut_len_mm=8000.0,
        due_in_h=48.0,
    )
    base.update(kw)
    return Task(**base)


# ==========================================================================
# Priorität
# ==========================================================================
def test_every_priority_factor_carries_a_sentence():
    p = priority(cut("IA-1", rush=True, waiting_h=10.0))
    assert {f.key for f in p.factors} == {"deadline", "rush", "age", "started"}
    assert all(f.reason for f in p.factors)


def test_an_overdue_promise_scores_the_full_deadline_and_says_so():
    p = priority(cut("IA-1", due_in_h=-5.0))
    d = next(f for f in p.factors if f.key == "deadline")
    assert d.points == pytest.approx(d.max_points)
    assert p.overdue is True
    assert "überfällig" in d.reason


def test_without_a_promise_there_is_no_deadline_pressure_rather_than_a_guess():
    p = priority(cut("IA-1", due_in_h=None))
    d = next(f for f in p.factors if f.key == "deadline")
    assert d.points == 0.0
    assert "keine Zusage" in d.reason
    assert p.overdue is False


def test_waiting_lifts_a_task_but_never_past_a_real_deadline():
    pol = WorklistPolicy()
    old = priority(cut("IA-alt", due_in_h=70.0, waiting_h=60.0), pol)
    urgent = priority(cut("IA-eilig", due_in_h=2.0, waiting_h=0.0), pol)
    assert urgent.score > old.score
    # …und trotzdem trägt die Liegezeit sichtbar bei.
    fresh = priority(cut("IA-neu", due_in_h=70.0, waiting_h=0.0), pol)
    assert old.score > fresh.score


def test_a_rush_flag_is_a_named_factor_not_a_hidden_multiplier():
    plain = priority(cut("IA-1"))
    rush = priority(cut("IA-1", rush=True))
    delta = rush.score - plain.score
    assert delta == pytest.approx(WorklistPolicy().weights.rush)


# ==========================================================================
# Zeitmodell
# ==========================================================================
def test_a_bench_without_times_makes_no_promise_rather_than_a_made_up_one():
    naked = bench(1, "Packtisch", "shipping", task_min=0.0, unit_min=0.0)
    t = Task(kind="pack", ref="AB-1", units=4)
    assert task_minutes(t, naked) is None


def test_a_bench_charges_a_base_plus_a_per_unit_time():
    b = bench(1, "Packtisch", "shipping", task_min=5.0, unit_min=2.0)
    t = Task(kind="pack", ref="AB-1", units=4)
    assert task_minutes(t, b) == pytest.approx(5.0 + 4 * 2.0)


def test_a_shipment_has_no_setup_family_so_nothing_is_ever_changed_over():
    t = Task(kind="pack", ref="AB-1", units=2)
    assert t.has_family is False
    assert changeover_between(("EPDM", 3.0), t) is False


# ==========================================================================
# Eignung — jede Arbeitsart an ihrer Station
# ==========================================================================
def test_a_packing_task_does_not_belong_on_a_plotter_and_the_reason_says_so():
    job = Task(kind="pack", ref="AB-1", units=2).as_job()
    blockers = eligibility(job, plotter(1, "Plotter 1"))
    assert blockers and "Versandstation" in blockers[0]


def test_a_cut_still_needs_a_production_station():
    job = cut("IA-1").as_job()
    blockers = eligibility(job, bench(9, "Packtisch", "shipping"))
    assert blockers and "Fertigungsstation" in blockers[0]


def test_a_warehouse_restricted_to_materials_refuses_the_others():
    store = bench(3, "Regal Gummi", "warehouse", materials=["EPDM"])
    ok = Task(kind="pick", ref="IA-1", mat="EPDM", thk=3.0, units=2)
    no = Task(kind="pick", ref="IA-2", mat="PTFE", thk=3.0, units=2)
    assert eligibility(ok.as_job(), store) == []
    assert "PTFE" in eligibility(no.as_job(), store)[0]


def test_a_table_size_is_a_machine_limit_and_does_not_apply_to_a_bench():
    """Eine Sendung passt nicht „nicht auf den Packtisch" — sie hat kein Maß."""
    b = bench(4, "Packtisch", "shipping", max_sheet_w=100.0, max_sheet_h=100.0)
    t = Task(kind="pack", ref="AB-1", units=2)
    assert eligibility(t.as_job(), b) == []


# ==========================================================================
# Reihenfolge
# ==========================================================================
def test_same_material_runs_together_when_the_promises_allow_it():
    st = plotter(1, "Plotter 1", last_mat="EPDM", last_thk=3.0)
    tasks = [
        cut("IA-E1", "EPDM"),
        cut("IA-P1", "PTFE"),
        cut("IA-E2", "EPDM"),
        cut("IA-P2", "PTFE"),
        cut("IA-E3", "EPDM"),
    ]
    sched = sequence(tasks, st)
    mats = [s.task.mat for s in sched.slots]
    # Drei EPDM am Stück, dann zwei PTFE — genau ein Wechsel statt vier.
    assert mats == ["EPDM", "EPDM", "EPDM", "PTFE", "PTFE"]
    assert sched.changeovers == 1


def test_the_saving_is_measured_against_the_pure_due_date_order():
    st = plotter(1, "Plotter 1", last_mat="EPDM", last_thk=3.0)
    tasks = [
        cut("IA-1", "EPDM", due_in_h=40.0),
        cut("IA-2", "PTFE", due_in_h=41.0),
        cut("IA-3", "EPDM", due_in_h=42.0),
        cut("IA-4", "PTFE", due_in_h=43.0),
    ]
    sched = sequence(tasks, st)
    assert sched.changeovers < sched.changeovers_edd
    assert sched.changeover_min_saved > 0


def test_a_promise_beats_the_setup_saving():
    """Der eine harte Satz dieses Moduls: umsortieren ja — Zusage brechen nein."""
    st = plotter(1, "Plotter 1", last_mat="EPDM", last_thk=3.0)
    # Ausdrücklich ohne Eilkennzeichen: hier soll allein der Termin ziehen,
    # nicht die Ansage des Betriebs.
    tasks = [
        cut("IA-E1", "EPDM", due_in_h=48.0),
        cut("IA-PTFE-KNAPP", "PTFE", due_in_h=0.8),
        cut("IA-E2", "EPDM", due_in_h=48.0),
    ]
    sched = sequence(tasks, st)
    assert sched.slots[0].task.ref == "IA-PTFE-KNAPP"
    assert sched.slots[0].changeover is True
    assert "Zusage" in sched.slots[0].reason
    assert not sched.late, "die knappe Zusage wird gehalten, nicht nur vorgezogen"


def test_a_task_that_cannot_make_its_promise_is_not_pushed_further_back():
    """Wer schon zu spät ist, wird durch das Rüstsparen nicht *später*."""
    st = plotter(1, "Plotter 1", last_mat="EPDM", last_thk=3.0)
    tasks = [
        cut("IA-E1", "EPDM", due_in_h=48.0),
        cut("IA-SPAET", "PTFE", due_in_h=-6.0),
        cut("IA-E2", "EPDM", due_in_h=48.0),
    ]
    sched = sequence(tasks, st)
    assert sched.slots[0].task.ref == "IA-SPAET"


def test_a_rush_job_is_not_leapfrogged_by_the_setup_saving():
    """Ein Eilkennzeichen ist eine Ansage des Betriebs, keine Feinheit der
    Terminrechnung — dieselbe Lesart wie in der Freigaberegel."""
    st = plotter(1, "Plotter 1", last_mat="EPDM", last_thk=3.0)
    tasks = [
        cut("IA-E1", "EPDM", due_in_h=48.0),
        cut("IA-PTFE-EIL", "PTFE", due_in_h=48.0, rush=True),
        cut("IA-E2", "EPDM", due_in_h=48.0),
    ]
    sched = sequence(tasks, st)
    assert sched.slots[0].task.ref == "IA-PTFE-EIL"
    assert "Eil" in sched.slots[0].reason


def test_two_rush_jobs_of_one_material_still_run_together():
    """Vorrang schaltet das Rüstsparen nicht ab — es begrenzt es auf die
    Aufgaben, die Vorrang haben."""
    st = plotter(1, "Plotter 1", last_mat="PTFE", last_thk=3.0)
    tasks = [
        cut("IA-P1", "PTFE", due_in_h=40.0, rush=True),
        cut("IA-E1", "EPDM", due_in_h=20.0, rush=True),
        cut("IA-P2", "PTFE", due_in_h=44.0, rush=True),
        cut("IA-X1", "EPDM", due_in_h=60.0),
    ]
    sched = sequence(tasks, st)
    order = [s.task.ref for s in sched.slots]
    assert order[-1] == "IA-X1", "der Nicht-Eilauftrag kommt zuletzt"
    assert order.index("IA-P2") < order.index("IA-E1"), (
        "unter den Eilaufträgen gruppiert das Material weiter"
    )


def test_an_overdue_job_is_never_overtaken_again():
    st = plotter(1, "Plotter 1", last_mat="EPDM", last_thk=3.0)
    tasks = [
        cut("IA-E1", "EPDM", due_in_h=48.0),
        cut("IA-ALT", "PTFE", due_in_h=-12.0),
        cut("IA-E2", "EPDM", due_in_h=48.0),
    ]
    sched = sequence(tasks, st)
    assert sched.slots[0].task.ref == "IA-ALT"


def test_what_is_already_running_stays_at_the_top():
    st = plotter(1, "Plotter 1")
    tasks = [
        cut("IA-EIL", due_in_h=1.0, rush=True),
        cut("IA-LAEUFT", due_in_h=60.0, started=True),
    ]
    sched = sequence(tasks, st)
    assert sched.slots[0].task.ref == "IA-LAEUFT"
    assert "läuft" in sched.slots[0].reason


def test_the_schedule_reports_the_setup_now_and_the_setup_after():
    """Zwei verschiedene Zustände, die gern verwechselt werden."""
    st = plotter(1, "Plotter 1", last_mat="EPDM", last_thk=3.0)
    sched = sequence([cut("IA-1", "EPDM"), cut("IA-2", "PTFE")], st)
    d = sched.to_dict()
    assert d["setup_mat"] == "EPDM", "jetzt läuft EPDM"
    assert d["setup_end_mat"] == "PTFE", "danach liegt PTFE auf dem Tisch"


def test_every_slot_says_why_it_is_where_it_is():
    st = plotter(1, "Plotter 1", last_mat="EPDM", last_thk=3.0)
    sched = sequence([cut("IA-1"), cut("IA-2", "PTFE"), cut("IA-3")], st)
    assert all(s.reason for s in sched.slots)
    assert all(s.priority.summary for s in sched.slots)


def test_the_sequence_is_deterministic():
    st = plotter(1, "Plotter 1", last_mat="EPDM", last_thk=3.0)
    tasks = [cut(f"IA-{i}", "EPDM" if i % 2 else "PTFE") for i in range(8)]
    a = [s.task.ref for s in sequence(tasks, st).slots]
    b = [s.task.ref for s in sequence(list(reversed(tasks)), st).slots]
    assert a == b


def test_without_station_times_there_is_an_order_but_no_clock():
    naked = bench(1, "Packtisch", "shipping", task_min=0.0, unit_min=0.0)
    tasks = [
        Task(kind="pack", ref="AB-2", units=2, due_in_h=10.0),
        Task(kind="pack", ref="AB-1", units=1, due_in_h=4.0),
    ]
    sched = sequence(tasks, naked)
    assert sched.times_known is False
    assert [s.task.ref for s in sched.slots] == ["AB-1", "AB-2"]
    assert all(s.finish_min is None for s in sched.slots)


# ==========================================================================
# Verteilung über gleichartige Stationen
# ==========================================================================
def test_one_machine_gets_everything_and_two_share_it():
    tasks = [cut(f"IA-{i}") for i in range(6)]
    ctx = RoutingContext()
    one = Counter(p.label for p in spread(tasks, [plotter(1, "P1")], ctx))
    assert one == Counter({"P1": 6})
    two = Counter(
        p.label for p in spread(tasks, [plotter(1, "P1"), plotter(2, "P2")], ctx)
    )
    assert set(two) == {"P1", "P2"}
    assert abs(two["P1"] - two["P2"]) <= 1, "zwei gleiche Maschinen teilen sich"


def test_three_machines_split_three_ways():
    tasks = [cut(f"IA-{i}") for i in range(9)]
    got = Counter(
        p.label
        for p in spread(
            tasks,
            [plotter(1, "P1"), plotter(2, "P2"), plotter(3, "P3")],
            RoutingContext(),
        )
    )
    assert set(got) == {"P1", "P2", "P3"}
    assert max(got.values()) - min(got.values()) <= 1


def test_the_same_material_gathers_on_one_machine_without_being_told_to():
    """Kein Werkstoff-Schlüssel, keine Quote — nur „wo ist es früher fertig"."""
    tasks = [cut(f"IA-E{i}", "EPDM") for i in range(4)] + [
        cut(f"IA-P{i}", "PTFE") for i in range(4)
    ]
    placed = spread(
        tasks, [plotter(1, "P1"), plotter(2, "P2")], RoutingContext()
    )
    per_station: dict[str, set[str]] = {}
    for p in placed:
        per_station.setdefault(p.label, set()).add(p.task.mat)
    # Jede Maschine trägt am Ende genau eine Rüstfamilie.
    assert all(len(v) == 1 for v in per_station.values()), per_station


def test_a_pull_station_is_never_planned_onto():
    placed = spread([cut("IA-1")], [plotter(1, "P1", routing="pull")], RoutingContext())
    assert placed[0].station_id is None
    assert placed[0].mode == "none"


def test_smart_suggest_proposes_and_smart_auto_may_apply_itself():
    a = spread([cut("IA-1")], [plotter(1, "P1", routing="smart_suggest")], RoutingContext())
    assert a[0].mode == "suggest"
    b = spread([cut("IA-2")], [plotter(1, "P1", routing="smart_auto")], RoutingContext())
    assert b[0].mode == "auto"


def test_each_kind_goes_to_its_own_station_type():
    stations = [
        plotter(1, "Plotter"),
        bench(2, "Regal", "warehouse"),
        bench(3, "Packtisch", "shipping"),
        bench(4, "Schreibtisch", "accounting"),
    ]
    ctx = RoutingContext()
    for kind, stype in KIND_STATION_TYPE.items():
        t = Task(kind=kind, ref=f"X-{kind}", mat="EPDM" if kind in ("cut", "pick") else "",
                 thk=3.0, units=2, n_plates=1, n_parts=4, cut_len_mm=5000.0)
        placed = spread([t], stations, ctx)[0]
        assert placed.station_id is not None, f"{kind} fand keine Station"
        target = next(s for s in stations if s.id == placed.station_id)
        assert target.type == stype


def test_an_ineligible_station_stays_in_the_list_with_its_reason():
    """Eine Station, die wortlos verschwindet, ist ein Rätsel für den Meister."""
    opts = options_for(
        cut("IA-1", mat="PTFE"),
        [plotter(1, "P1", materials=["EPDM"]), plotter(2, "P2")],
        RoutingContext(),
    )
    assert len(opts) == 2
    blocked = next(o for o in opts if o.station_id == 1)
    assert blocked.eligible is False and blocked.blockers


def test_the_distance_to_the_material_moves_the_decision():
    """Zwei gleiche Maschinen, ein Lager — die nähere gewinnt."""
    store = bench(9, "Lager", "warehouse", x=0.0, y=0.0, is_storage=True)
    near = plotter(1, "Nah", x=5.0, y=0.0)
    far = plotter(2, "Fern", x=200.0, y=0.0)
    placed = spread([cut("IA-1")], [store, near, far], RoutingContext())
    assert placed[0].label == "Nah"


def test_a_pick_measures_the_way_from_the_rack_to_the_machine():
    machine = plotter(1, "Plotter", x=100.0, y=0.0)
    near = bench(2, "Regal nah", "warehouse", x=90.0, y=0.0, is_storage=True)
    far = bench(3, "Regal fern", "warehouse", x=0.0, y=0.0, is_storage=True)
    t = Task(kind="pick", ref="IA-1", mat="EPDM", thk=3.0, units=2, to_station_id=1)
    placed = spread([t], [machine, near, far], RoutingContext())
    assert placed[0].label == "Regal nah"


# ==========================================================================
# Über die API
# ==========================================================================




































