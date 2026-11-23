"""Die vier Stellschrauben der Schachtelung 2.7.0-lite.

Rechenzeit, Plattenzahl, Teile je Platte, Abstand zur Nullecke. Jede wird hier
gegen das *Ergebnis* geprüft, nicht gegen ihre eigene Meldung: eine Eckschranke,
die sich selbst für eingehalten erklärt, ist keine Schranke.

Die Kollisionsprüfung läuft überall mit. Verdichtung und Umverteilung rücken
Teile *nach* dem Packen — genau dort entstünde ein Schnitt in den anderen, und
das ist der teuerste Fehler, den dieser Modul machen kann (CLAUDE.md §10).
"""

from __future__ import annotations

import math

import pytest

from gimel.core.nesting import (EPS, NEST_POLICY_DEFAULT, STRATEGIES, nest,
                                nest_best, resolve_policy)
from gimel.core.types import Position

from nest_asserts import assert_no_collisions


def _pos(specs) -> list[Position]:
    return [Position(id=i + 1, od=od, di=di, q=q, mat="x")
            for i, (od, di, q) in enumerate(specs)]


MIXED = [(220.0, 140.0, 14), (120.0, 60.0, 10)]
MANY = [(300.0, 200.0, 9), (165.0, 90.0, 12), (90.0, 40.0, 20)]


def _worst_corner(nested) -> float:
    worst = 0.0
    for sh in nested["sheets"]:
        for p in list(sh.top) + list(sh.rest):
            worst = max(worst, math.hypot(p.cx + p.od / 2, p.cy + p.od / 2))
    return worst


# --------------------------------------------------------------------------
# Rechenzeit
# --------------------------------------------------------------------------
def test_budget_counts_layouts_not_seconds(products, rates):
    """Das Budget ist eine Anzahl bewerteter Layouts.

    Sekunden wären auf einer schnelleren Maschine ein anderes Ergebnis und
    damit ein anderer Preis (docs/NESTING-ALGORITHM.md §10).
    """
    prod = products["epdm-60"] if "epdm-60" in products else next(iter(products.values()))
    for n in range(1, len(STRATEGIES) + 1):
        res = nest(_pos(MIXED), prod, rates, 0, {"max_candidates": n})
        assert res["candidates"] == n
        assert res["exhausted"] is True


def test_budget_is_reproducible(products, rates):
    prod = next(iter(products.values()))
    a = nest(_pos(MANY), prod, rates, 0, {"max_candidates": 3})
    b = nest(_pos(MANY), prod, rates, 0, {"max_candidates": 3})
    for sa, sb in zip(a["sheets"], b["sheets"]):
        assert [(p.pos.id, p.seq, p.cx, p.cy) for p in sa.top] == \
               [(p.pos.id, p.seq, p.cx, p.cy) for p in sb.top]


def test_less_budget_is_never_a_better_layout(products, rates):
    """Mehr Kandidaten dürfen das Ergebnis nie verschlechtern — die Suche
    behält immer den besten, nicht den letzten."""
    prod = next(iter(products.values()))
    few = nest(_pos(MANY), prod, rates, 0, {"max_candidates": 1})
    many = nest(_pos(MANY), prod, rates, 0, {"max_candidates": len(STRATEGIES)})
    assert len(many["sheets"]) <= len(few["sheets"])


def test_wall_clock_brake_reports_itself(products, rates):
    """Greift die Notbremse, wird das gemeldet und nicht verschluckt."""
    prod = next(iter(products.values()))
    cut = nest(_pos(MANY), prod, rates, 0, {"max_ms": 1e-6})
    assert cut["exhausted"] is False
    assert 1 <= cut["candidates"] < len(STRATEGIES)
    # Auch ein abgebrochener Lauf liefert ein *vollständiges* Layout.
    assert cut["sheets"]
    assert_no_collisions(cut)

    full = nest(_pos(MANY), prod, rates, 0, {"max_ms": 60_000})
    assert full["exhausted"] is True


def test_a_timed_run_is_never_remembered(products, rates):
    """Ein Ergebnis, das je nach Tageslast anders ausfällt, darf nicht als
    „dasselbe" aus dem Gedächtnis zurückkommen."""
    from gimel.core import nesting
    nesting.clear_nest_cache()
    prod = next(iter(products.values()))
    nesting.nest_cached(_pos(MIXED), prod, rates, 0, {"max_ms": 5000})
    assert not nesting._NEST_CACHE
    nesting.nest_cached(_pos(MIXED), prod, rates, 0, None)
    assert nesting._NEST_CACHE


# --------------------------------------------------------------------------
# Plattenzahl und Belegung
# --------------------------------------------------------------------------
def test_fill_is_reported_and_adds_up(products, rates):
    prod = next(iter(products.values()))
    res = nest(_pos(MANY), prod, rates, 0)
    assert len(res["fill"]) == len(res["sheets"])
    for sh, n in zip(res["sheets"], res["fill"]):
        assert n == len(sh.top) + len(sh.rest)


def test_redistribution_never_loses_a_part(products, rates):
    """Die Umverteilung darf Platten auflösen, aber kein Teil verlieren — und
    keine Platte halb aufgelöst zurücklassen."""
    prod = next(iter(products.values()))
    off = nest(_pos(MANY), prod, rates, 0, {"repack": False})
    on = nest(_pos(MANY), prod, rates, 0, {"repack": True})
    count = lambda r: sum(len(sh.top) + len(sh.rest) for sh in r["sheets"])
    assert count(on) == count(off)
    assert len(on["sheets"]) <= len(off["sheets"])
    assert_no_collisions(on)


def test_no_empty_plate_survives(products, rates):
    prod = next(iter(products.values()))
    res = nest(_pos(MANY), prod, rates, 0)
    for i, sh in enumerate(res["sheets"]):
        if len(res["sheets"]) > 1:
            assert sh.top or sh.rest, f"Platte {i} ist leer"


# --------------------------------------------------------------------------
# Abstand zur Nullecke
# --------------------------------------------------------------------------
@pytest.mark.parametrize("limit", [1200.0, 900.0, 700.0])
def test_corner_limit_holds_on_the_actual_layout(products, rates, limit):
    """Nachgemessen an der wirklichen Lage, nicht an einer gedachten Platte.

    Genau das war der Mangel, den docs/NESTING-ALGORITHM.md §5.1 an
    ``validate_corner_distance`` anstreicht: geprüft wurde gegen eine
    *hypothetische* größte Platte, nie gegen das Layout.
    """
    prod = next(iter(products.values()))
    res = nest(_pos(MIXED), prod, rates, 0, {"corner_max_dist": limit})
    assert _worst_corner(res) <= limit + 1e-6
    assert res["corner_max"] <= limit + 1e-6
    assert_no_collisions(res)


def test_corner_limit_costs_plates_rather_than_breaking(products, rates):
    """Eine engere Schranke darf Platten kosten — aber nie eine Kollision und
    nie ein stillschweigend danebengelegtes Teil."""
    prod = next(iter(products.values()))
    wide = nest(_pos(MIXED), prod, rates, 0, {"corner_max_dist": 5000.0})
    tight = nest(_pos(MIXED), prod, rates, 0, {"corner_max_dist": 700.0})
    assert len(tight["sheets"]) >= len(wide["sheets"])
    placed = lambda r: sum(len(sh.top) + len(sh.rest) for sh in r["sheets"])
    assert placed(tight) + sum(p.q for p in tight["over"]) >= placed(wide)


def test_an_impossible_corner_limit_routes_to_technik(products, rates):
    """Passt unter der Schranke gar nichts mehr, wird nicht stillschweigend
    irgendwo abgelegt, sondern zur Technik geleitet (Invariante 6)."""
    prod = next(iter(products.values()))
    res = nest(_pos([(220.0, 140.0, 3)]), prod, rates, 0, {"corner_max_dist": 20.0})
    assert res["over"]
    assert not any(sh.top or sh.rest for sh in res["sheets"])


# --------------------------------------------------------------------------
# Richtlinie
# --------------------------------------------------------------------------
def test_policy_defaults_are_the_quoting_defaults(rates):
    """Der Preisweg rechnet ohne Wanduhr und ohne Eckschranke — beides wäre
    eine Größe, die nicht aus den Positionen folgt."""
    pol = resolve_policy(rates, None)
    assert pol["max_ms"] is None
    assert pol["corner_max_dist"] is None
    assert pol["max_candidates"] == NEST_POLICY_DEFAULT["max_candidates"]


def test_policy_is_part_of_the_cache_key(products, rates):
    from gimel.core.nesting import nest_key
    prod = next(iter(products.values()))
    pos = _pos(MIXED)
    assert nest_key(pos, prod, rates, 0, {"corner_max_dist": 900}) != \
           nest_key(pos, prod, rates, 0, None)
    assert nest_key(pos, prod, rates, 0, {"max_candidates": 2}) != \
           nest_key(pos, prod, rates, 0, None)


def test_compaction_keeps_parts_on_the_plate(products, rates):
    """Die Verdichtung rückt Teile — sie darf keines über den Rand schieben."""
    prod = next(iter(products.values()))
    res = nest(_pos(MANY), prod, rates, 0, {"compact": True})
    margin = res["margin"]
    for sh in res["sheets"]:
        for p in list(sh.top) + list(sh.rest):
            assert p.cx - p.od / 2 >= margin - EPS
            assert p.cy - p.od / 2 >= margin - EPS
            assert p.cx + p.od / 2 <= res["W"] - margin + EPS
            assert p.cy + p.od / 2 <= res["H"] - margin + EPS


# --------------------------------------------------------------------------
# Die Trennlinie: Werkstattvorgabe gegen Preis
# --------------------------------------------------------------------------


def test_default_options_carry_no_policy():
    """Ohne ausdrückliche Vorgabe bleibt die Fertigung bei den Werten des
    Rechenkerns — eine leere Einstellung heißt „erben", nicht „null"."""
    from gimel.core.batch import NestOptions
    assert NestOptions().policy() == {}


def test_a_failed_redistribution_puts_everything_back(products, rates):
    """Der Rückweg, nicht der Hinweg.

    Scheitert die Umverteilung an einem einzigen Teil, muss der Zustand exakt
    der vorherige sein — Belegung *und* Koordinaten. Ein Teil, das nach einem
    gescheiterten Versuch auf seiner alten Platte liegt, aber an der Stelle,
    an die es woanders gepasst hätte, ist eine Kollision, die niemand mehr auf
    die Umverteilung zurückführt.
    """
    from gimel.core.nesting import _compact_to_corner, _execute_pass, _repack_sheets

    prod = next(iter(products.values()))
    rates_gap = prod.kerf if prod.kerf is not None else rates.gap
    margin = prod.web if prod.web is not None else rates.margin
    W, H = float(prod.sheets[0][0]), float(prod.sheets[0][1])

    # Voll genug, dass keine Platte aufgelöst werden kann.
    parts = _pos([(300.0, 0.0, 40)])
    from gimel.core.nesting import footprint
    from gimel.core.types import PlacedPart
    flat = [PlacedPart(pos=p, od=p.od, di=p.di or 0,
                       fw=footprint(p)[0], fh=footprint(p)[1], seq=i)
            for p in parts for i in range(p.q)]
    res = _execute_pass(flat, W, H, margin, rates_gap, "standard", None)
    _compact_to_corner(res["sheets"], W, H, margin, rates_gap, None)

    before_sheets = len(res["sheets"])
    before = [[(p.pos.id, p.seq, p.cx, p.cy) for p in sh.top] for sh in res["sheets"]]
    _repack_sheets(res["sheets"], W, H, margin, rates_gap, None)

    if len(res["sheets"]) == before_sheets:          # nichts aufgelöst → alles wie vorher
        after = [[(p.pos.id, p.seq, p.cx, p.cy) for p in sh.top] for sh in res["sheets"]]
        assert after == before
    assert_no_collisions(res)
