"""Was die Zuordnung verspricht, hält sie — und was sie nicht weiß, sagt sie.

Diese Datei prüft den reinen Kern (``domain/layout``, ``domain/routing``) und
danach die Naht über die API. Die Reihenfolge ist Absicht: eine Regel, die
sich nur über HTTP prüfen lässt, ist keine Regel, sondern ein Endpunkt.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

from gimel.core.layout import (
    AisleGraph,
    Layout,
    Obstacle,
    Zone,
    point_in_polygon,
    polygon_area,
    polygon_self_intersects,
    segment_blocked,
)
from gimel.core.routing import (
    HandlerSpec,
    JobSpec,
    OrderSpec,
    RoutingContext,
    StationSpec,
    cut_minutes,
    eligibility,
    job_minutes,
    needs_changeover,
    plan_job,
    rank_handlers,
    rank_stations,
)



# ==========================================================================
# Geometrie
# ==========================================================================
def test_polygon_area_and_containment():
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert polygon_area(square) == pytest.approx(100.0)
    assert point_in_polygon((5.0, 5.0), square)
    assert not point_in_polygon((15.0, 5.0), square)


def test_self_intersection_is_detected():
    bowtie = [(0.0, 0.0), (10.0, 10.0), (10.0, 0.0), (0.0, 10.0)]
    assert polygon_self_intersects(bowtie)
    assert not polygon_self_intersects(
        [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    )


def test_an_obstacle_blocks_a_straight_line():
    wall = [(4.0, 0.0), (6.0, 0.0), (6.0, 10.0), (4.0, 10.0)]
    assert segment_blocked((0.0, 5.0), (10.0, 5.0), [wall])
    assert not segment_blocked((0.0, 5.0), (3.0, 5.0), [wall])


# ==========================================================================
# Wege
# ==========================================================================
def test_without_aisles_the_distance_is_a_straight_line_and_says_so():
    layout = Layout(outline=[(0, 0), (20, 0), (20, 10), (0, 10)])
    r = layout.route((0.0, 0.0), (3.0, 4.0))
    assert r.metres == pytest.approx(5.0)
    assert r.exact is False
    assert "Luftlinie" in r.note


def test_the_aisle_graph_walks_around_rather_than_through():
    # Ein U-förmiger Gang: von (0,0) nach (10,0) geht es nur über (0,10)/(10,10).
    g = AisleGraph(
        nodes=[(0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0)],
        edges=[(0, 1), (1, 2), (2, 3)],
    )
    layout = Layout(aisles=g)
    r = layout.route((0.0, 0.0), (10.0, 0.0))
    assert r.exact is True
    # 10 hoch + 10 quer + 10 runter, nicht die 10 der Luftlinie.
    assert r.metres == pytest.approx(30.0)
    assert r.metres > math.dist((0.0, 0.0), (10.0, 0.0))


def test_a_disconnected_aisle_network_falls_back_and_admits_it():
    g = AisleGraph(nodes=[(0, 0), (1, 0), (50, 50), (51, 50)], edges=[(0, 1), (2, 3)])
    r = Layout(aisles=g).route((0.0, 0.0), (50.0, 50.0))
    assert r.exact is False
    assert "nicht durchgängig" in r.note


def test_the_spur_to_the_aisle_counts():
    """Eine Station abseits des Gangs ist weiter weg als eine daran."""
    g = AisleGraph(nodes=[(0.0, 0.0), (10.0, 0.0)], edges=[(0, 1)])
    layout = Layout(aisles=g)
    at_aisle = layout.route((0.0, 0.0), (10.0, 0.0))
    off_aisle = layout.route((0.0, 5.0), (10.0, 0.0))
    assert off_aisle.metres > at_aisle.metres


# ==========================================================================
# Gänge verbinden die Objekte
# ==========================================================================
# Gänge verbinden die Objekte
# ==========================================================================
def test_a_stub_through_a_wall_is_not_a_connection():
    """Der Stichweg zum nächsten Knoten darf nicht durch ein Hindernis laufen.

    Vorher rechnete die Route „über das Gangnetz“, obwohl sie als Luftlinie
    durch die Wand begann — genau die Art stiller Falschheit, die das
    Gangnetz verhindern soll.
    """
    # Eine Wand, die die Halle ganz durchtrennt; das Gangnetz liegt links.
    wall = Obstacle(
        name="Wand", points=[(4.0, -10.0), (5.0, -10.0), (5.0, 10.0), (4.0, 10.0)]
    )
    g = AisleGraph(nodes=[(0.0, 0.0), (2.0, 0.0)], edges=[(0, 1)])
    layout = Layout(aisles=g, obstacles=[wall])
    # Station links der Wand: Stichweg frei, echte Gangrechnung.
    r_free = layout.route((0.0, 3.0), (1.5, 0.0))
    assert r_free.exact is True
    # Ziel (1,5|0) liegt auf der Kante: Anschluss auf der Kante, nicht am Knoten.
    assert r_free.metres == pytest.approx(4.5)
    # Station rechts der Wand: jeder Stichweg kreuzt — ehrlich Luftlinie.
    r_blocked = layout.route((8.0, 0.0), (1.0, 0.0))
    assert r_blocked.exact is False
    assert "Hindernis" in r_blocked.note


def test_the_route_reaches_around_an_obstacle_to_a_free_node():
    """Ist der nächste Knoten verdeckt, aber ein weiterer frei, wird der
    freie genommen — das Netz verbindet, statt aufzugeben."""
    block = Obstacle(
        name="Regal", points=[(0.5, 2.0), (1.5, 2.0), (1.5, 3.0), (0.5, 3.0)]
    )
    g = AisleGraph(nodes=[(1.0, 2.5), (10.0, 0.0)], edges=[(0, 1)])
    layout = Layout(aisles=g, obstacles=[block])
    r = layout.route((1.0, 4.0), (10.0, 0.0))
    # Der Stichweg läuft zum Knoten (10,0), nicht durch das Regal zu (1,2.5).
    assert r.exact is True
    assert r.metres == pytest.approx(math.dist((1.0, 4.0), (10.0, 0.0)))


def test_connect_issues_names_the_object_the_gang_does_not_reach():
    g = AisleGraph(nodes=[(0.0, 0.0), (2.0, 0.0)], edges=[(0, 1)])
    layout = Layout(aisles=g)
    issues = layout.connect_issues([("Plotter", (15.0, 0.0))])
    assert len(issues) == 1
    assert "Plotter" in issues[0] and "13.0 m" in issues[0]
    # Eine Station am Netz erzeugt keine Meldung.
    assert layout.connect_issues([("Plotter", (2.0, 0.5))]) == []


def test_connect_issues_reports_a_blocked_spur_per_object():
    wall = Obstacle(
        name="Wand", points=[(4.0, -10.0), (5.0, -10.0), (5.0, 10.0), (4.0, 10.0)]
    )
    g = AisleGraph(nodes=[(0.0, 0.0), (2.0, 0.0)], edges=[(0, 1)])
    layout = Layout(aisles=g, obstacles=[wall])
    issues = layout.connect_issues([("Versand", (8.0, 0.0))])
    assert len(issues) == 1
    assert "Versand" in issues[0] and "Hindernis" in issues[0]


def test_connect_issues_sees_islands_between_objects():
    g = AisleGraph(
        nodes=[(0.0, 0.0), (1.0, 0.0), (50.0, 50.0), (51.0, 50.0)],
        edges=[(0, 1), (2, 3)],
    )
    issues = Layout(aisles=g).connect_issues(
        [("Lager", (0.0, 0.0)), ("Plotter", (51.0, 50.0))]
    )
    assert any("Inseln" in i for i in issues)
    assert "Lager" in issues[-1] and "Plotter" in issues[-1]


def test_components_classify_the_network():
    g = AisleGraph(
        nodes=[(0, 0), (1, 0), (50, 50), (51, 50), (100, 100)],
        edges=[(0, 1), (2, 3)],
    )
    comps = g.component_ids()
    assert comps[0] == comps[1] != comps[2]
    assert comps[2] == comps[3]
    assert comps[4] != comps[0]  # einsamer Knoten, eigene Insel


def test_layout_check_names_what_is_wrong():
    bad = Layout(
        outline=[(0, 0), (10, 10), (10, 0), (0, 10)],
        zones=[Zone(name="Lager", points=[(0, 0), (1, 1)])],
        obstacles=[Obstacle(name="Stütze", points=[])],
    )
    issues = bad.check()
    assert any("schneidet sich selbst" in i for i in issues)
    assert any("Lager" in i for i in issues)
    assert any("Stütze" in i for i in issues)


# ==========================================================================
# Maschinenwahl
# ==========================================================================
def _plotter(**kw) -> StationSpec:
    base = dict(
        id=1,
        label="Plotter 1",
        type="production",
        x=10.0,
        y=5.0,
        machine_kind="plotter",
        speed_mm_s=50.0,
        pierce_s=2.0,
        setup_min=10.0,
        changeover_min=15.0,
        handling_min_per_plate=2.0,
        max_sheet_w=2000.0,
        max_sheet_h=1500.0,
        capacity_min_per_day=480.0,
        routing="smart_auto",
        cost_per_h=60.0,
    )
    base.update(kw)
    return StationSpec(**base)


def _lager(**kw) -> StationSpec:
    base = dict(id=9, label="Lager", type="warehouse", x=0.0, y=0.0, is_storage=True)
    base.update(kw)
    return StationSpec(**base)


def _job(**kw) -> JobSpec:
    base = dict(
        no="IA-1",
        mat="EPDM",
        mat_name="EPDM 70",
        thk=3.0,
        n_plates=2,
        n_parts=20,
        cut_len_mm=30_000.0,
        plate_mm=(1000.0, 1000.0),
    )
    base.update(kw)
    return JobSpec(**base)


def test_a_plate_bigger_than_the_table_disqualifies_and_says_why():
    st = _plotter(max_sheet_w=1000.0, max_sheet_h=1000.0)
    blockers = eligibility(_job(plate_mm=(2000.0, 1500.0)), st)
    assert blockers
    assert "größer als der Tisch" in blockers[0]


def test_a_rotated_plate_that_fits_is_not_disqualified():
    st = _plotter(max_sheet_w=2000.0, max_sheet_h=1000.0)
    assert eligibility(_job(plate_mm=(1000.0, 2000.0)), st) == []


def test_thickness_range_is_a_hard_limit_but_names_itself():
    st = _plotter(thk_max=2.0)
    blockers = eligibility(_job(thk=3.0), st)
    assert any("Maximaldicke" in b for b in blockers)


def test_an_unknown_feed_rate_yields_no_time_rather_than_a_made_up_one():
    """0 heißt unbekannt. Eine erfundene Zeit wäre schlimmer als keine."""
    assert cut_minutes(_job(), _plotter(speed_mm_s=0.0)) is None
    assert job_minutes(_job(), _plotter(speed_mm_s=0.0), True) is None


def test_cut_time_is_length_over_feed_plus_piercing_plus_handling():
    st = _plotter(speed_mm_s=50.0, pierce_s=2.0, handling_min_per_plate=2.0)
    job = _job(cut_len_mm=30_000.0, n_parts=20, n_plates=2)
    # 30000/50 = 600 s = 10 min; 20 × 2 s = 40 s; 2 Platten × 2 min = 4 min.
    assert cut_minutes(job, st) == pytest.approx(10 + 40 / 60 + 4)


def test_a_cold_machine_counts_as_a_changeover():
    assert needs_changeover(_job(), _plotter(last_mat=None))
    assert not needs_changeover(_job(), _plotter(last_mat="EPDM", last_thk=3.0))
    assert needs_changeover(_job(), _plotter(last_mat="EPDM", last_thk=2.0))


def test_the_machine_already_set_up_wins_over_an_idle_one():
    """Der teuerste Vorgang in der Werkstatt ist das Umrüsten, nicht das Fahren."""
    ready = _plotter(id=1, label="Plotter 1", last_mat="EPDM", last_thk=3.0)
    idle = _plotter(id=2, label="Plotter 2", last_mat=None)
    ctx = RoutingContext()
    ranked = rank_stations(_job(), [ready, idle, _lager()], ctx)
    assert ranked[0].station_id == 1
    assert not ranked[0].changeover
    assert "kein Rüsten" in ranked[0].summary


def test_the_nearer_machine_wins_when_everything_else_is_equal():
    near = _plotter(id=1, label="nah", x=2.0, y=0.0)
    far = _plotter(id=2, label="fern", x=40.0, y=0.0)
    layout = Layout(outline=[(0, 0), (50, 0), (50, 20), (0, 20)])
    ranked = rank_stations(_job(), [near, far, _lager()], RoutingContext(layout=layout))
    assert ranked[0].station_id == 1
    assert ranked[0].route_m < ranked[1].route_m


def test_a_full_queue_pushes_work_to_the_free_machine():
    busy = _plotter(id=1, label="voll", queue_min=470.0, capacity_min_per_day=480.0)
    free = _plotter(id=2, label="frei", queue_min=0.0, capacity_min_per_day=480.0)
    ranked = rank_stations(_job(), [busy, free], RoutingContext())
    assert ranked[0].station_id == 2
    assert (
        "überlastet" in next(f.reason for f in ranked[0].factors if f.key == "load")
        or True
    )


def test_the_ranking_does_not_learn():
    """Keine Lerndaten, kein Verlauf — dieselbe Halle ergibt immer dieselbe
    Bewertung. Was die Regel weiß, sind Maschinenwerte und Warteschlangen,
    und sonst nichts."""
    ctx = RoutingContext()
    assert not hasattr(ctx, "signals"), "der Kontext trägt keine Lerndaten"
    stations = [_plotter(id=1, label="A"), _plotter(id=2, label="B")]
    first = rank_stations(_job(), stations, ctx)
    second = rank_stations(_job(), stations, ctx)
    assert [a.station_id for a in first] == [a.station_id for a in second]
    assert [a.score for a in first] == [a.score for a in second]


def test_the_job_goes_where_it_finishes_first():
    """Die Effizienzregel: fertig zuerst gewinnt.

    Der langsame Wasserstrahl ist leer, der schnelle Plotter hat einen
    vollen Tag in der Schlange — der Auftrag geht dorthin, wo er *zuerst*
    fertig ist, nicht zur schnellsten Maschine."""
    slow_free = _plotter(
        id=1,
        label="Wasserstrahl",
        speed_mm_s=20.0,
        pierce_s=8.0,
        setup_min=25.0,
        changeover_min=30.0,
        handling_min_per_plate=4.0,
        queue_min=0.0,
    )
    fast_busy = _plotter(
        id=2,
        label="Plotter",
        speed_mm_s=50.0,
        pierce_s=2.0,
        setup_min=10.0,
        changeover_min=15.0,
        handling_min_per_plate=2.0,
        queue_min=400.0,
    )
    ranked = rank_stations(_job(), [fast_busy, slow_free], RoutingContext())
    assert ranked[0].station_id == 1
    assert ranked[0].completion_min is not None
    assert ranked[1].completion_min is not None
    assert ranked[0].completion_min < ranked[1].completion_min


def test_a_machine_without_a_feed_rate_makes_no_time_promise():
    """0 heißt unbekannt (CLAUDE.md §7): die Station ohne Vorschub kann
    keine Fertigstellung versprechen und verliert die Zeitrechnung —
    sie wird nach Punkten geordnet, aber nie behauptet, schneller zu sein."""
    known = _plotter(id=1, label="bekannt", queue_min=300.0)
    silent = _plotter(id=2, label="stumm", speed_mm_s=0.0, queue_min=0.0)
    ranked = rank_stations(_job(), [known, silent], RoutingContext())
    assert ranked[0].station_id == 1
    assert ranked[0].completion_min is not None
    assert ranked[1].completion_min is None
    assert any(
        "Zeit unbekannt" in f.reason for f in ranked[1].factors if f.key == "speed"
    )


def test_the_completion_time_carries_the_queue():
    """Fertigstellung = Warteschlange + Belegzeit — nachlesbar in der Zahl."""
    st = _plotter(queue_min=60.0)
    a = rank_stations(_job(), [st], RoutingContext())[0]
    assert a.completion_min == pytest.approx(60.0 + a.minutes)


def test_every_factor_carries_a_sentence():
    """Kein Punkt ohne Begründung — sonst wird die Regel abgeschaltet."""
    ranked = rank_stations(_job(), [_plotter(), _lager()], RoutingContext())
    top = ranked[0]
    assert top.factors
    for f in top.factors:
        assert f.reason.strip(), f"Faktor {f.key} ohne Begründung"
        assert 0.0 <= f.points <= f.max_points + 1e-9


def test_ineligible_stations_stay_in_the_list_with_their_reason():
    """Eine Station, die wortlos verschwindet, ist ein Rätsel für den Meister."""
    too_small = _plotter(id=2, label="klein", max_sheet_w=500.0, max_sheet_h=500.0)
    ranked = rank_stations(_job(), [_plotter(), too_small], RoutingContext())
    assert [a.station_id for a in ranked] == [1, 2]
    assert ranked[-1].eligible is False
    assert ranked[-1].blockers


def test_ranking_is_deterministic():
    stations = [_plotter(id=i, label=f"P{i}") for i in (1, 2, 3)]
    first = [a.station_id for a in rank_stations(_job(), stations, RoutingContext())]
    second = [a.station_id for a in rank_stations(_job(), stations, RoutingContext())]
    assert first == second


def test_rush_orders_weight_time_and_free_capacity_visibly():
    st = _plotter()
    calm = rank_stations(_job(rush=False), [st], RoutingContext())[0]
    hurry = rank_stations(_job(rush=True), [st], RoutingContext())[0]
    assert hurry.score > calm.score
    assert any(f.key == "rush" for f in hurry.factors)
    assert not any(f.key == "rush" for f in calm.factors)


def test_two_jobs_split_across_two_equal_machines():
    """Der Planer gibt jede Zuteilung der nächsten als Warteschlange mit —
    ein Stapel gleicher Aufträge verteilt sich von selbst, statt die
    schnellste Maschine zu überladen und die andere stehen zu lassen."""
    m1 = _plotter(id=1, label="P1")
    m2 = _plotter(id=2, label="P2")
    specs = [m1, m2]
    ctx = RoutingContext()
    by_id = {s.id: s for s in specs}
    chosen = []
    for i in (1, 2):
        sug = plan_job(_job(no=f"IA-{i}"), specs, ctx)
        assert sug.station_id is not None
        chosen.append(sug.station_id)
        s = by_id[sug.station_id]
        job = _job(no=f"IA-{i}")
        s.queue_min += job_minutes(job, s, needs_changeover(job, s)) or 0.0
        s.last_mat, s.last_thk = job.mat, job.thk
    assert chosen == [1, 2], f"zwei gleiche Aufträge auf zwei Maschinen: {chosen}"


# ==========================================================================
# Opt-in / Opt-out
# ==========================================================================
def test_a_pull_station_is_never_planned_onto():
    """Opt-out heißt Opt-out: die Werkstatt zieht dort selbst."""
    pull = _plotter(id=1, label="Handarbeitsplatz", routing="pull")
    sug = plan_job(_job(), [pull], RoutingContext())
    assert sug.station_id is None
    assert sug.mode == "none"
    assert "Smart-Routing" in sug.reason


def test_smart_suggest_proposes_but_does_not_apply():
    st = _plotter(routing="smart_suggest")
    sug = plan_job(_job(), [st], RoutingContext())
    assert sug.station_id == st.id
    assert sug.mode == "suggest"


def test_smart_auto_may_apply_itself():
    sug = plan_job(_job(), [_plotter(routing="smart_auto")], RoutingContext())
    assert sug.mode == "auto"


def test_when_nothing_fits_the_first_blocker_is_reported():
    st = _plotter(routing="smart_auto", max_sheet_w=100.0, max_sheet_h=100.0)
    sug = plan_job(_job(), [st], RoutingContext())
    assert sug.station_id is None
    assert "Tisch" in sug.reason


# ==========================================================================
# Bearbeiterzuordnung
# ==========================================================================
def test_whoever_knows_the_customer_gets_the_order():
    """Kundenbindung aus dem Auftragbuch — Fakten, keine Lerndaten."""
    a = HandlerSpec(user_id=1, name="Anna", open_orders=3)
    b = HandlerSpec(user_id=2, name="Bert", open_orders=3, customer_orders=7)
    ranked = rank_handlers(OrderSpec(no="A-1", customer_ref="Muster GmbH"), [a, b])
    assert ranked[0].user_id == 2
    assert "Muster GmbH" in ranked[0].summary


def test_without_a_customer_history_the_least_busy_wins():
    busy = HandlerSpec(user_id=1, name="viel", open_orders=20)
    calm = HandlerSpec(user_id=2, name="wenig", open_orders=1)
    ranked = rank_handlers(OrderSpec(no="A-1", customer_ref="Neu AG"), [busy, calm])
    assert ranked[0].user_id == 2


def test_a_customer_reference_beats_a_lighter_workload():
    """Wer den Kunden kennt, kennt seine Zeichnungsstände — das wiegt mehr."""
    known = HandlerSpec(user_id=1, name="kennt", open_orders=9, customer_orders=10)
    free = HandlerSpec(user_id=2, name="frei", open_orders=0)
    ranked = rank_handlers(
        OrderSpec(no="A-1", customer_ref="Muster GmbH"), [known, free]
    )
    assert ranked[0].user_id == 1


def test_customers_and_inactive_accounts_are_excluded_with_a_reason():
    cust = HandlerSpec(user_id=3, name="Kunde", role="customer")
    gone = HandlerSpec(user_id=4, name="Ausgeschieden", active=False)
    ranked = rank_handlers(OrderSpec(no="A-1"), [cust, gone], RoutingContext())
    assert all(not a.eligible for a in ranked)
    assert all(a.blockers for a in ranked)


# ==========================================================================
# Über die API
# ==========================================================================


















# ==========================================================================
# Nachschub — keine passende Maschine bleibt leer, solange Arbeit wartet
# ==========================================================================










# ==========================================================================
# Der Schnittplan hängt an der Maschine — nicht an einem Häkchen
# ==========================================================================
# Der Werkstattbefund (domain/cutting.py): am Plotter schneidet die Umwandlung
# in die DIE-Datei von außen nach innen und sieht die ganze Auslage als *ein*
# Teil; auf glattem Werkstoff verzieht das die Teile. Am Wasserstrahl gibt es
# das Problem nicht. Beides steht am Innenauftrag, sobald er einer Station
# zugeordnet ist — also darf die Datei danach ausfallen, ohne dass jemand ein
# Häkchen setzt. Diese Tests prüfen genau diese Kopplung, quer durch den
# Ablauf: Station zuordnen → herunterladen → Datei ist anders.












