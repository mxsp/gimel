"""Die Dreh- und Spiegeloption des Kerns (2.9.0-lite).

Gegenstand sind die *Schranken*, nicht Zahlen: die Bedienervorgabe
(``allow_rotation``/``allow_mirror``), die Werkstoffrichtung (``grain``) und
die Frage, ob eine gedrehte Lage auch wirklich auf dem platzierten Teil ankommt
(``rot``/``mirror`` samt vertauschter Standfläche) — denn eine Lage, die der
Kern wählt, aber Zeichnung und Schnittdatei nicht anwenden, schneidet das Teil
in die falsche Form. Ausschuss, der richtig aussieht, ist der teuerste Fehler
dieses Moduls.

Jede Layoutprüfung läuft mit ``assert_no_collisions`` — die Verdichtung rückt
Teile auch über gedrehte Lagen hinweg.
"""

from __future__ import annotations

import math

import pytest

from gimel.core.batch import NestOptions
from gimel.core.nesting import nest, nest_key, resolve_policy
from gimel.core.types import Position, Product

from nest_asserts import assert_no_collisions

# Ein Streifen 1200 × 200 liegt quer zu einer 1000 mm breiten Platte — un-
# gedreht übersteht er die Übergrößenprüfung nicht, gedreht liegt er längs.
STRIP_W, STRIP_H = 1200.0, 200.0


def _strip_pos(q: int = 4, pos_id: int = 1) -> Position:
    return Position(
        id=pos_id,
        od=math.hypot(STRIP_W, STRIP_H),
        di=0.0,
        q=q,
        mat="x",
        shape={"outer": {"kind": "rect", "w": STRIP_W, "h": STRIP_H, "r": 0},
               "holes": []},
    )


def _product(grain: str = "none", flip_ok: bool = True) -> Product:
    return Product(id="x", eur_m2=100.0, sheets=[(1000.0, 1500.0)],
                   kerf=6.0, web=12.0, grain=grain, flip_ok=flip_ok)


def _all_parts(nested) -> list:
    return [p for sh in nested["sheets"] for p in list(sh.top) + list(sh.rest)]


# --------------------------------------------------------------------------
# Die Option selbst
# --------------------------------------------------------------------------
def test_a_strip_that_only_fits_turned_is_placed_turned(rates):
    prod = _product()
    res = nest([_strip_pos()], prod, rates, 0)
    parts = _all_parts(res)
    assert parts, "Der Streifen ist gedreht untergebracht, aber fehlt im Layout"
    assert res["orient"]["rot90"] is True
    for p in parts:
        assert p.rot == 90.0
        assert (p.fw, p.fh) == (STRIP_H, STRIP_W), (
            "Die Standfläche eines gedreht platzierten Teils muss die "
            "gedrehte sein — Verdichtung, Umverteilung und Zeichnung rechnen "
            "mit ihr")
    assert_no_collisions(res)


def test_rotation_off_routes_the_same_strip_to_technik(rates):
    """Ohne die Option ist der Streifen ungedreht übergroß — genau der Fall,
    der 2.7.0-lite zur Anfrage führte (CLAUDE.md §5.7)."""
    prod = _product()
    res = nest([_strip_pos()], prod, rates, 0, {"allow_rotation": False})
    assert res["over"]
    assert not _all_parts(res)
    assert res["orient"]["rot90"] is False


def test_round_and_square_parts_never_turn(rates):
    """Eine 90°-Drehung eines Rings ist eine Identität — der Kern darf sie
    nicht einmal anbieten, sonst ändert die Lage ohne jeden Gewinn das Bild."""
    prod = _product()
    pos = Position(id=1, od=220.0, di=140.0, q=6, mat="x")
    res = nest([pos], prod, rates, 0)
    for p in _all_parts(res):
        assert p.rot == 0.0


def test_turned_layouts_holds_no_escapes(rates):
    """Auch gedreht liegt kein Teil über dem nutzbaren Rand (Invariante 2)."""
    prod = _product()
    res = nest([_strip_pos(q=8)], prod, rates, 0)
    margin = res["margin"]
    for sh in res["sheets"]:
        for p in sh.top + sh.rest:
            assert p.cx - p.fw / 2 >= margin - 1e-7
            assert p.cx + p.fw / 2 <= res["W"] - margin + 1e-7
            assert p.cy - p.fh / 2 >= margin - 1e-7
            assert p.cy + p.fh / 2 <= res["H"] - margin + 1e-7


# --------------------------------------------------------------------------
# Die Schranken: Werkstoffrichtung schlägt jede Vorgabe
# --------------------------------------------------------------------------
def test_directed_grain_locks_the_turn_even_when_allowed(rates):
    """Eine gedrehte Lage auf gerichtetem Werkstoff ist kein Verschnitt,
    sondern Ausschuss, der richtig aussieht — die Richtung ist die härtere
    Schranke, auch wenn der Bediener die Drehung freigibt."""
    prod = _product(grain="directed")
    res = nest([_strip_pos()], prod, rates, 0)
    assert res["orient"]["rot90"] is False
    assert res["over"]
    assert not _all_parts(res)


def test_axis_grain_does_not_turn_parts(rates):
    """``axis`` erlaubt {0°, 180°} — beide belegen dieselbe Standfläche, die
    90°-Lage ist damit nicht dabei."""
    prod = _product(grain="axis")
    res = nest([_strip_pos()], prod, rates, 0)
    assert res["orient"]["rot90"] is False
    assert res["over"]


def test_disable_rotation_beats_a_turnable_material(rates):
    """Der Bediener-Schalter gilt poolweit — auch für einen Werkstoff, der
    die Drehung vertrüge."""
    prod = _product()
    res = nest([_strip_pos()], prod, rates, 0, {"allow_rotation": False})
    assert res["orient"]["rot90"] is False


# --------------------------------------------------------------------------
# Die Spiegeloption
# --------------------------------------------------------------------------
@pytest.mark.parametrize("kwargs", [
    {"grain": "directed"},
    {"flip_ok": False},
])
def test_mirror_capability_is_gated(rates, kwargs):
    prod = _product(**kwargs)
    res = nest([_strip_pos()], prod, rates, 0)
    assert res["orient"]["mirror"] is False


def test_disable_mirror_beats_a_flippable_material(rates):
    prod = _product()
    res = nest([_strip_pos()], prod, rates, 0, {"allow_mirror": False})
    assert res["orient"]["mirror"] is False


def test_mirror_is_recorded_on_every_placement(rates):
    """Die Fähigkeit reist auf jedem platzierten Teil — der Kern wählt in
    dieser Skyline keine Spiegelung (sie ändert die Standfläche nie), aber
    Zeichnung und Schnittdatei müssen sie anwenden können, sobald eine Lage
    sie trägt."""
    prod = _product()
    res = nest([_strip_pos()], prod, rates, 0)
    for p in _all_parts(res):
        assert p.mirror is False


# --------------------------------------------------------------------------
# Richtlinie und Gedächtnis
# --------------------------------------------------------------------------
def test_policy_defaults_allow_both(rates):
    pol = resolve_policy(rates, None)
    assert pol["allow_rotation"] is True
    assert pol["allow_mirror"] is True


def test_policy_reads_both_spellings(rates):
    camel = resolve_policy(rates, {"allowRotation": False, "allowMirror": False})
    snake = resolve_policy(rates, {"allow_rotation": False, "allow_mirror": False})
    assert camel == snake
    assert camel["allow_rotation"] is False


def test_cache_key_follows_the_rotation_options(rates):
    prod = _product()
    pos = [_strip_pos()]
    base = nest_key(pos, prod, rates, 0, None)
    assert nest_key(pos, prod, rates, 0, {"allow_rotation": False}) != base
    assert nest_key(pos, prod, rates, 0, {"allow_mirror": False}) != base
    assert nest_key(pos, _product(grain="directed"), rates, 0, None) != base
    assert nest_key(pos, _product(flip_ok=False), rates, 0, None) != base


def test_results_are_deterministic_with_rotation(rates):
    prod = _product()
    pos = [_strip_pos(q=6)]
    a = nest(pos, prod, rates, 0)
    b = nest(pos, prod, rates, 0)
    for sa, sb in zip(a["sheets"], b["sheets"]):
        assert [(p.pos.id, p.seq, p.cx, p.cy, p.rot) for p in sa.top] == \
               [(p.pos.id, p.seq, p.cx, p.cy, p.rot) for p in sb.top]


# --------------------------------------------------------------------------
# Die Fertigungsseite
# --------------------------------------------------------------------------
def test_production_options_reach_the_policy():
    """NestOptions bleibt werkstattseitig — None heißt erben, nicht null."""
    assert NestOptions().policy() == {}
    assert NestOptions(allow_rotation=False).policy() == {"allow_rotation": False}
    assert NestOptions(allow_mirror=False).policy() == {"allow_mirror": False}


