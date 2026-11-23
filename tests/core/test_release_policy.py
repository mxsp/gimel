"""Die Freigaberegel: wann wird gesammelt, wann geschnitten, und was bleibt liegen.

Diese Datei prüft die Entscheidung, nicht die Schachtelung. Der Rechenkern hat
seine eigenen Prüfungen (test_invariants.py, test_parity.py); hier geht es um
die Frage, die dem Betrieb gehört: **welche Teile gehen jetzt auf die Maschine
und warum**.

Der Grundsatz dahinter: jeder der sechs Gründe genügt für sich, und jeder muss
einzeln nachweisbar sein. Eine Regel, bei der man nur das Ergebnis sieht und
nicht den Grund, wird beim ersten Zweifel abgeschaltet — deshalb prüft fast
jeder Test hier auch den Klartext der Begründung.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from gimel.core.batch import (MODE_BATCH, MODE_IMMEDIATE, BatchPart, NestOptions,
                              ReleasePolicy, decide_release, group_key, plan_batch,
                              releases_at, solo_area)


NOW = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)


def part(pid: int, *, order="AB-26-0001", mat="klingersil-c4400", thk=2.0,
         od=120.0, di=60.0, q=1, age_min=0, due_h=None, rush=False,
         customer="Kunde") -> BatchPart:
    return BatchPart(
        position_id=pid, order_no=order, customer=customer, customer_ref="",
        label=f"Teil {pid}", mat=mat, thk=thk, od=od, di=di, q=q,
        ordered_at=NOW - timedelta(minutes=age_min),
        due_date=(NOW + timedelta(hours=due_h)) if due_h is not None else None,
        rush=rush,
    )


def plan(parts, products, rates, policy=None, **kw):
    resolve = (lambda _m, _t: policy) if policy else None
    return plan_batch(parts, products, rates, policy_for=resolve, now=NOW, **kw)


# --------------------------------------------------------------------------
# Eimerbildung: was darf gemeinsam auf eine Platte
# --------------------------------------------------------------------------
def test_thickness_never_shares_a_plate(products, rates):
    """2 mm und 3 mm sind physisch verschiedene Platten. Wer das zusammenwirft,
    produziert Ausschuss."""
    parts = [part(1, thk=2.0), part(2, thk=3.0)]
    groups, _ = plan(parts, products, rates, ReleasePolicy(min_utilisation=0.0))
    assert len(groups) == 2
    assert {(g.mat, g.thk) for g in groups} == {("klingersil-c4400", 2.0),
                                                ("klingersil-c4400", 3.0)}


def test_materials_never_share_a_plate(products, rates):
    parts = [part(1, mat="klingersil-c4400"), part(2, mat="klingersil-c4300")]
    groups, _ = plan(parts, products, rates, ReleasePolicy(min_utilisation=0.0))
    assert len(groups) == 2
    for g in groups:
        mats = {pl_item["position_id"] for pl in g.plates for pl_item in pl.placements}
        assert mats                                  # jede Gruppe trägt Teile
        assert len({p.mat for p in g.parts}) == 1


def test_immediate_mode_never_mixes_two_orders(products, rates):
    """``sofort`` heißt: ein Innenauftrag je Kundenauftrag und Werkstoff.

    Das ist der 1:1-Fall — kürzeste Durchlaufzeit, kein Mengeneffekt.
    """
    parts = [part(1, order="AB-26-0001"), part(2, order="AB-26-0002")]
    groups, held = plan(parts, products, rates, ReleasePolicy(mode=MODE_IMMEDIATE))
    assert not held
    assert len(groups) == 2
    for g in groups:
        assert len(g.order_nos) == 1
        assert g.policy_mode == MODE_IMMEDIATE


def test_batch_mode_pools_two_orders_onto_one_plate(products, rates):
    parts = [part(1, order="AB-26-0001"), part(2, order="AB-26-0002")]
    groups, _ = plan(parts, products, rates,
                     ReleasePolicy(mode=MODE_BATCH, min_utilisation=0.0))
    assert len(groups) == 1
    assert sorted(groups[0].order_nos) == ["AB-26-0001", "AB-26-0002"]


def test_group_key_is_the_only_difference_between_the_modes(products, rates):
    p = part(1)
    assert group_key(p, MODE_BATCH) == ("", p.mat, p.thk)
    assert group_key(p, MODE_IMMEDIATE) == (p.order_no, p.mat, p.thk)


def test_customer_grouping_can_keep_two_customers_apart(products, rates):
    """Auf Wunsch bleibt jeder Kunde auf seiner eigenen Platte, auch im Sammelmodus."""
    a = part(1, order="AB-26-0001", customer="Kunde A")
    b = part(2, order="AB-26-0002", customer="Kunde B")
    a.customer_key, b.customer_key = "user:1", "user:2"
    policy = ReleasePolicy(mode=MODE_BATCH, min_utilisation=0.0)
    together, _ = plan([a, b], products, rates, policy, group_by="material")
    apart, _ = plan([a, b], products, rates, policy, group_by="customer")
    assert len(together) == 1 and len(apart) == 2
    assert {tuple(sorted(g.order_nos)) for g in apart} == {("AB-26-0001",), ("AB-26-0002",)}


# --------------------------------------------------------------------------
# Die sechs Freigabegründe, einzeln
# --------------------------------------------------------------------------
def test_nothing_fires_means_the_bucket_keeps_collecting(products, rates):
    """Unter allen Schwellen: liegen bleiben, mit Begründung."""
    parts = [part(1, od=90, di=40, q=1)]
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(min_parts=50, min_utilisation=0.9,
                                      max_age_minutes=10_000, due_lead_hours=1))
    assert not groups
    assert len(held) == 1
    assert "sammelt weiter" in held[0].reason
    assert held[0].n_pieces == 1


def test_force_cuts_regardless(products, rates):
    parts = [part(1, od=90, di=40)]
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(min_parts=50, min_utilisation=0.9,
                                      max_age_minutes=10_000, due_lead_hours=1),
                        force=True)
    assert not held and len(groups) == 1
    assert groups[0].release_reason == "Von Hand ausgelöst"


def test_immediate_mode_cuts_regardless(products, rates):
    parts = [part(1, od=90, di=40)]
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(mode=MODE_IMMEDIATE, min_parts=50,
                                      min_utilisation=0.9, max_age_minutes=10_000))
    assert not held and len(groups) == 1
    assert "sofort" in groups[0].release_reason


def test_a_rush_order_never_waits(products, rates):
    parts = [part(1, od=90, di=40, rush=True)]
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(min_parts=50, min_utilisation=0.9,
                                      max_age_minutes=10_000, due_lead_hours=1))
    assert not held and len(groups) == 1
    assert "Eilauftrag" in groups[0].release_reason


def test_an_approaching_promise_beats_material_yield(products, rates):
    """Die Zusage schlägt die Ausnutzung. Eine Optimierung, die eine zugesagte
    Lieferung aufisst, ist keine."""
    parts = [part(1, od=90, di=40, due_h=12)]
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(min_parts=50, min_utilisation=0.9,
                                      max_age_minutes=10_000, due_lead_hours=48))
    assert not held and len(groups) == 1
    assert "Zusage" in groups[0].release_reason
    # Und mit reichlich Vorlauf sammelt derselbe Eimer weiter.
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(min_parts=50, min_utilisation=0.9,
                                      max_age_minutes=10_000, due_lead_hours=2))
    assert not groups and held


def test_waiting_too_long_forces_the_cut(products, rates):
    """Ohne Altersgrenze bliebe ein exotischer Werkstoff liegen, bis ein zweiter
    Kunde ihn bestellt — und das kann nie passieren."""
    parts = [part(1, od=90, di=40, age_min=2000)]
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(min_parts=50, min_utilisation=0.9,
                                      max_age_minutes=1440, due_lead_hours=1))
    assert not held and len(groups) == 1
    assert "Wartezeit" in groups[0].release_reason


def test_a_full_plate_fires_even_below_the_piece_count(products, rates):
    """Der eigentliche Materialhebel: die Platte entscheidet, nicht die Stückzahl."""
    parts = [part(i, od=400, di=200, q=4) for i in range(1, 6)]
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(min_parts=10_000, min_utilisation=0.5,
                                      max_age_minutes=10_000, due_lead_hours=1))
    assert not held and len(groups) == 1
    assert "Platte zu" in groups[0].release_reason


def test_piece_count_fires_when_the_plate_stays_empty(products, rates):
    parts = [part(i, od=60, di=20) for i in range(1, 9)]
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(min_parts=4, min_utilisation=0.0,
                                      max_age_minutes=10_000, due_lead_hours=1))
    assert not held and len(groups) == 1
    assert "Teile beisammen" in groups[0].release_reason


# --------------------------------------------------------------------------
# Angebrochene Platte: der größte einzelne Materialgewinn
# --------------------------------------------------------------------------
def test_full_plates_go_out_and_the_partial_one_keeps_collecting(products, rates):
    """Zwei volle Platten schneiden, die angebrochene dritte weitersammeln lassen."""
    parts = [part(i, od=300, di=140, q=3) for i in range(1, 12)]
    policy = ReleasePolicy(min_parts=1, min_utilisation=0.6,
                           max_age_minutes=10_000, due_lead_hours=1)
    groups, held = plan(parts, products, rates, policy)
    assert len(groups) == 1
    g = groups[0]
    # Jede freigegebene Platte erreicht die Schwelle …
    assert all(pl.fill >= policy.min_utilisation - 1e-9 for pl in g.plates)
    # … und was zurückbleibt, ist als solches ausgewiesen.
    if g.held:
        assert g.hold_reason
        held_ids = {p.position_id for p in g.held}
        placed_ids = {i["position_id"] for pl in g.plates for i in pl.placements}
        # Eine zurückgestellte Position liegt auf keiner freigegebenen Platte —
        # sonst zeigte die Zeichnung ein Teil, das gar nicht geschnitten wird.
        assert not (held_ids & placed_ids)


def test_a_held_position_is_never_split_across_the_boundary(products, rates):
    """Positionen bleiben ganz. Sonst wäre ``production_status`` eine Aussage
    über einzelne Stücke, und die Zusage „eine Position lebt in genau einem
    Innenauftrag" hielte nicht mehr."""
    parts = [part(i, od=260, di=120, q=5) for i in range(1, 10)]
    groups, _ = plan(parts, products, rates,
                     ReleasePolicy(min_parts=1, min_utilisation=0.65,
                                   max_age_minutes=10_000, due_lead_hours=1))
    for g in groups:
        held_ids = {p.position_id for p in g.held}
        for pl in g.plates:
            for item in pl.placements:
                assert item["position_id"] not in held_ids


def test_a_deadline_releases_the_partial_plate_too(products, rates):
    """Frist-, Eil- und Handgründe schneiden alles — sie sind der Grund, warum
    überhaupt nicht länger gesammelt wird."""
    parts = [part(i, od=300, di=140, q=3, age_min=5000) for i in range(1, 12)]
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(min_parts=1, min_utilisation=0.6,
                                      max_age_minutes=1440, due_lead_hours=1))
    assert not held
    assert len(groups) == 1 and not groups[0].held


def test_nothing_is_lost_between_released_and_held(products, rates):
    """Die Erhaltungsregel des Sammellaufs: jede eingesammelte Position ist
    danach entweder eingeplant, zurückgestellt oder Übergröße. Verschwinden
    darf keine — sie ist bezahlt."""
    parts = ([part(i, od=280, di=130, q=2) for i in range(1, 9)]
             + [part(20, od=4000, di=100)]                       # Übergröße
             + [part(i, mat="klingersil-c4300", od=90, di=40) for i in range(30, 34)])
    groups, held = plan(parts, products, rates,
                        ReleasePolicy(min_parts=1, min_utilisation=0.6,
                                      max_age_minutes=10_000, due_lead_hours=1))
    seen: set[int] = set()
    for g in groups:
        seen |= {i["position_id"] for pl in g.plates for i in pl.placements}
        seen |= {p.position_id for p in g.held}
        seen |= {p.position_id for p in g.oversize}
    for h in held:
        seen |= {p.position_id for p in h.parts}
    assert seen == {p.position_id for p in parts}


def test_oversize_is_routed_out_and_never_held(products, rates):
    """Eine Übergröße wartet auf einen Menschen, nicht auf eine volle Platte
    (CLAUDE.md §5.1, Invariante 6)."""
    parts = [part(1, od=90, di=40), part(2, od=4000, di=200)]
    groups, _ = plan(parts, products, rates,
                     ReleasePolicy(min_utilisation=0.0), force=True)
    over_ids = {p.position_id for g in groups for p in g.oversize}
    held_ids = {p.position_id for g in groups for p in g.held}
    placed = {i["position_id"] for g in groups for pl in g.plates for i in pl.placements}
    assert 2 in over_ids
    assert 2 not in held_ids and 2 not in placed


# --------------------------------------------------------------------------
# Mehrere Plattenformate im selben Innenauftrag
# --------------------------------------------------------------------------
def test_one_work_order_may_mix_plate_formats(products, rates):
    """Derselbe Werkstoff liegt in mehreren Größen im Regal. Ein großes Teil
    braucht eine andere Platte als die dreißig kleinen daneben — und beide
    gehören in denselben Rüstvorgang."""
    product = products["klingersil-c4400"]
    if len({tuple(f) for f in product.sheets}) < 2:
        pytest.skip("dieser Werkstoff wird nur in einem Format geführt")
    parts = ([part(1, od=min(min(f) for f in product.sheets) - 40, di=100)]
             + [part(i, od=70, di=30, q=6) for i in range(2, 12)])
    groups, _ = plan(parts, products, rates,
                     ReleasePolicy(min_utilisation=0.0), force=True)
    g = groups[0]
    assert g.formats, "jeder Innenauftrag nennt seine Formate"
    assert sum(n for *_f, n in g.formats) == len(g.plates)
    for pl in g.plates:
        assert tuple(pl.fmt) in {tuple(f[:2]) for f in g.formats}


def test_mixed_formats_can_be_switched_off(products, rates):
    """Wer einen Rüstvorgang auf ein Format festlegen will, darf das."""
    parts = [part(i, od=200, di=90, q=4) for i in range(1, 10)]
    groups, _ = plan(parts, products, rates, ReleasePolicy(min_utilisation=0.0),
                     force=True, mixed_formats=False)
    for g in groups:
        assert len({tuple(pl.fmt) for pl in g.plates}) == 1


# --------------------------------------------------------------------------
# Determinismus und Rückverfolgbarkeit
# --------------------------------------------------------------------------
def test_the_same_queue_plans_identically_twice(products, rates):
    """Invariante 5 gilt auch für den Sammellauf: ohne Reproduzierbarkeit ist
    ein Fehler in der Fertigung nicht auffindbar."""
    parts = [part(i, od=90 + i * 11, di=40 + i * 6, q=2,
                  order=f"AB-26-{i % 3:04d}") for i in range(1, 14)]
    policy = ReleasePolicy(min_utilisation=0.0)
    a, _ = plan(parts, products, rates, policy)
    b, _ = plan(parts, products, rates, policy)
    fingerprint = lambda gs: [(g.mat, g.thk, g.formats,
                               [(pl.idx, pl.fmt, round(pl.used_h, 6),
                                 [(i["tag"], i["position_id"], i["cx"], i["cy"])
                                  for i in pl.placements])
                                for pl in g.plates]) for g in gs]
    assert fingerprint(a) == fingerprint(b)


def test_every_placement_resolves_back_to_its_order(products, rates):
    """Ohne diese Zuordnung entsteht in der Fertigung genau die Verwechslung,
    die das Zusammenlegen erst gefährlich macht."""
    parts = [part(i, od=110 + i * 9, di=50, q=2,
                  order=f"AB-26-{i % 4:04d}", customer=f"Kunde {i % 4}")
             for i in range(1, 12)]
    groups, _ = plan(parts, products, rates, ReleasePolicy(min_utilisation=0.0))
    for g in groups:
        tags = [i["tag"] for pl in g.plates for i in pl.placements]
        assert len(tags) == len(set(tags)), "Marken müssen eindeutig sein"
        for pl in g.plates:
            for item in pl.placements:
                assert item["order_no"] and item["customer"] and item["position_id"]


def test_releases_at_names_the_moment_the_bucket_goes_out(products, rates):
    """Die Frage, an der eine Freigaberegel steht oder fällt: wann wird das
    geschnitten, wenn nichts mehr dazukommt."""
    policy = ReleasePolicy(max_age_minutes=600, due_lead_hours=24)
    by_age = releases_at([part(1, age_min=0)], policy)
    assert by_age == NOW + timedelta(minutes=600)
    # Die nähere der beiden Fristen gewinnt.
    by_due = releases_at([part(1, age_min=0, due_h=30)], policy)
    assert by_due == NOW + timedelta(hours=6)
    assert releases_at([part(1)], ReleasePolicy(mode=MODE_IMMEDIATE)) is None


# --------------------------------------------------------------------------
# Der Materialgewinn, gemessen statt behauptet
# --------------------------------------------------------------------------
def test_pooling_never_needs_more_plate_than_cutting_separately(products, rates):
    """Der Beleg für CLAUDE.md §8.2. Wäre er falsch, wäre das Sammeln sinnlos."""
    parts = [part(i, od=100 + (i % 7) * 40, di=40 + (i % 5) * 20, q=2,
                  order=f"AB-26-{i % 5:04d}") for i in range(1, 26)]
    groups, _ = plan(parts, products, rates, ReleasePolicy(min_utilisation=0.0),
                     force=True)
    batch_area = sum(g.used_area_m2 for g in groups)
    released = [p for g in groups for p in g.parts]
    assert batch_area <= solo_area(released, products, rates) + 1e-9


def test_decide_release_reports_a_reason_either_way(products, rates):
    """Freigabe oder nicht — es gibt immer genau einen Klartextgrund."""
    from gimel.core.batch import _peel_plates
    product = products["klingersil-c4400"]
    bucket = [part(1, od=90, di=40)]
    plates, _ = _peel_plates(bucket, product, rates, None, True)
    for policy, expect_release in [
        (ReleasePolicy(min_parts=1, min_utilisation=0.9, max_age_minutes=10_000,
                       due_lead_hours=1), True),
        (ReleasePolicy(min_parts=50, min_utilisation=0.9, max_age_minutes=10_000,
                       due_lead_hours=1), False),
    ]:
        reason, hold = decide_release(bucket, plates, policy, now=NOW)
        assert bool(reason) is expect_release
        assert bool(hold) is not expect_release
        assert (reason or hold).strip()


# --------------------------------------------------------------------------
# Schachtelungsoptionen: Abstand, Rand, nutzbares Format
# --------------------------------------------------------------------------
def _plates(products, rates, parts, options=None):
    groups, _ = plan_batch(parts, products, rates,
                           policy_for=lambda m, t: ReleasePolicy(min_utilisation=0.0),
                           options_for=(lambda m, t: options) if options else None,
                           force=True, now=NOW)
    return groups


def test_a_wider_gap_costs_plate(products, rates):
    """Der Abstand muss die Schnittfuge tragen — was der Strahl wegnimmt, fehlt
    beiden Nachbarn. Weiter heißt sicherer und teurer, und beides muss man
    sehen können."""
    parts = [part(i, od=200, di=90, q=6) for i in range(1, 7)]
    tight = _plates(products, rates, parts, NestOptions(gap=2))[0]
    wide = _plates(products, rates, parts, NestOptions(gap=40))[0]
    assert wide.used_area_m2 > tight.used_area_m2


def test_a_wider_edge_margin_costs_plate(products, rates):
    parts = [part(i, od=200, di=90, q=6) for i in range(1, 7)]
    tight = _plates(products, rates, parts, NestOptions(margin=5))[0]
    wide = _plates(products, rates, parts, NestOptions(margin=120))[0]
    assert wide.used_area_m2 > tight.used_area_m2


def test_trimming_the_plate_keeps_the_real_format_and_insets_the_parts(products, rates):
    """Der Werker legt eine echte Platte auf, kein gedachtes Fenster.

    Zeichnung und Schnittdatei zeigen deshalb das volle Format; die Teile
    rücken um den halben Beschnitt ein. Stünde das Nutzfenster als Format da,
    schnitte die Maschine an der falschen Stelle an.
    """
    parts = [part(i, od=150, di=60, q=4) for i in range(1, 6)]
    plain = _plates(products, rates, parts)[0]
    trimmed = _plates(products, rates, parts, NestOptions(trim_w=200, trim_h=200))[0]
    assert tuple(trimmed.plates[0].fmt) == tuple(plain.plates[0].fmt), \
        "das Format bleibt das echte Plattenformat"
    xs = [i["cx"] for pl in trimmed.plates for i in pl.placements]
    ys = [i["cy"] for pl in trimmed.plates for i in pl.placements]
    ods = [i["od"] for pl in trimmed.plates for i in pl.placements]
    # Kein Teil ragt in den Beschnitt.
    assert min(x - o / 2 for x, o in zip(xs, ods)) >= 100 - 1e-6
    assert min(y - o / 2 for y, o in zip(ys, ods)) >= 100 - 1e-6


def test_trimming_costs_usable_area(products, rates):
    parts = [part(i, od=220, di=100, q=6) for i in range(1, 8)]
    plain = _plates(products, rates, parts)[0]
    trimmed = _plates(products, rates, parts, NestOptions(trim_w=300, trim_h=300))[0]
    assert trimmed.used_area_m2 >= plain.used_area_m2


def test_the_options_used_are_recorded_on_the_plan(products, rates):
    """Sonst wird ein alter Plan stillschweigend mit neuen Werten gelesen,
    sobald jemand die Einstellung ändert."""
    g = _plates(products, rates, [part(1, od=150, di=60, q=4)],
                NestOptions(gap=9, margin=25, trim_w=100, trim_h=50))[0]
    assert g.nest_options["gap"] == 9
    assert g.nest_options["margin"] == 25
    assert g.nest_options["trim_w"] == 100 and g.nest_options["trim_h"] == 50
    assert g.nest_options["usable"][0] == g.plates[0].fmt[0] - 100




def test_the_product_itself_is_not_modified(products, rates):
    """Die Fertigungssicht ist eine Kopie. Würde sie den Werkstoff anfassen,
    rechnete die nächste Kalkulation im selben Prozess mit Werkstattmaßen."""
    product = products["klingersil-c4400"]
    sheets_before = list(product.sheets)
    kerf_before, web_before = product.kerf, product.web
    _plates(products, rates, [part(1, od=150, di=60, q=4)],
            NestOptions(gap=30, margin=90, trim_w=250, trim_h=250))
    assert list(product.sheets) == sheets_before
    assert (product.kerf, product.web) == (kerf_before, web_before)


# --------------------------------------------------------------------------
# Die Zahl, die die Entscheidung aus CLAUDE.md §8.2 trägt
# --------------------------------------------------------------------------
