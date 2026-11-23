"""Kerf: same results as the JavaScript original, valid layouts, usable plans."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gimel.core import kerf, nesting_kerf
from gimel.core.batch import BatchPart, NestOptions, _nest, _peel_plates
from gimel.core.geometry import ring_from_params, rect_from_params
from gimel.core.nesting import nest_best
from gimel.core.types import Position, Product, Rates

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "kerf_parity.json").read_text())


def rect(w, h):
    return [[0, 0], [w, 0], [w, h], [0, h]]


def job(**over):
    base = {"sheet": {"width": 1000, "height": 500}, "spacing": 5, "margin": 5,
            "rotations": [0, 90, 180, 270], "gravity": "left", "maxSteps": 12, "seed": 7,
            "parts": [{"id": "a", "outer": rect(200, 100), "quantity": 4}]}
    return {**base, **over}


@pytest.mark.parametrize("case", GOLDEN, ids=lambda c: c["name"])
def test_same_placements_as_the_javascript_engine(case):
    r = kerf.nest(case["job"])
    got = [[p["partIndex"], p["instance"], p["sheet"], p["rotation"], p["x"], p["y"]]
           for p in r["placements"]]
    assert got == case["placements"]
    assert [[u["partIndex"], u["instance"]] for u in r["unplaced"]] == case["unplaced"]
    assert r["stats"]["iterations"] == case["iterations"]
    assert r["stats"]["stopReason"] == case["stopReason"]
    assert r["stats"]["fitness"] == pytest.approx(case["fitness"])
    assert kerf.verify(case["job"], r)["valid"] is case["valid"]


def test_time_limit_needs_a_clock():
    with pytest.raises(ValueError):
        kerf.nest(job(timeLimit=100, maxSteps=None))
    ticks = iter(range(0, 10_000_000, 50))
    r = kerf.nest(job(timeLimit=400, maxSteps=None), clock=lambda: float(next(ticks)))
    assert r["stats"]["stopReason"] == "time"


def test_verify_catches_an_overlap():
    j = job(parts=[{"id": "a", "outer": rect(200, 100), "quantity": 2}])
    r = kerf.nest(j)
    r["placements"][1].update(tx=r["placements"][0]["tx"] + 50, ty=r["placements"][0]["ty"])
    assert not kerf.verify(j, r)["valid"]


def test_verify_catches_a_gap_that_is_too_small():
    j = job(parts=[{"id": "a", "outer": rect(200, 100), "quantity": 2}], rotations=[0])
    r = kerf.nest(j)
    a, b = r["placements"]
    b.update(tx=a["tx"] + 202, ty=a["ty"], sheet=a["sheet"])
    assert any("apart" in i for i in kerf.verify(j, r)["issues"])


def test_part_rotations_replace_the_job_rotations():
    j = job(parts=[{"id": "a", "outer": rect(200, 100), "quantity": 3, "rotations": [90]}])
    assert {p["rotation"] for p in kerf.nest(j)["placements"]} == {90}


# ---- in Gimel ----
RATES = Rates(gap=4, margin=8)


def product(**over):
    base = {"id": "M", "sheets": [(1500.0, 1000.0)], "eur_m2": 10.0}
    return Product(**{**base, **over})


def ring(i, od, di, q=1):
    return Position(id=i, od=od, di=di, q=q, shape=ring_from_params(od, di))


def box(i, w, h, q=1):
    return Position(id=i, od=(w * w + h * h) ** 0.5, q=q, shape=rect_from_params(w, h))


def ell(i, q=1):
    pts = [[-150, -100], [150, -100], [150, -40], [-90, -40], [-90, 100], [-150, 100]]
    return Position(id=i, od=360, q=q, shape={"outer": {"kind": "poly", "pts": pts},
                                              "holes": [], "bolts": None})


def all_parts(res):
    return [p for sh in res["sheets"] for p in sh.top + sh.rest]


def assert_exact(res, positions):
    """Rebuilt from the plan alone, the way drawing and cut file place the parts."""
    pols = []
    for p in all_parts(res):
        outer = nesting_kerf._ring_of(nesting_kerf._outer_of(p.pos), True)
        pols.append((p, kerf.rot_ring(outer, p.rot)))
    for i, (a, ra) in enumerate(pols):
        for b, rb in pols[i + 1:]:
            same = any(a in s.top + s.rest and b in s.top + s.rest for s in res["sheets"])
            if not same or a.host_id == b.uid or b.host_id == a.uid:
                continue
            pa = [[x + a.cx, y + a.cy] for x, y in ra]
            pb = [[x + b.cx, y + b.cy] for x, y in rb]
            overlap, gap = kerf._pair_check({"outer": pa, "holes": []}, {"outer": pb, "holes": []},
                                            1e-3)
            assert not overlap and gap >= res["gap"] - 1e-3


def test_kerf_beats_lite_on_interlocking_shapes_and_stays_exact():
    positions = [ell(1, 14)]
    res = nesting_kerf.nest_best_kerf(positions, product(), RATES)
    assert res["kerf"]["used"] is True, res["kerf"]
    assert res["v"] == nesting_kerf.ENGINE_LABEL
    assert res["kerf"]["used_m2"] < res["kerf"]["lite_m2"]
    assert len(all_parts(res)) == 14
    assert_exact(res, positions)


def test_a_plan_is_reproducible_and_cached():
    positions = [ell(1, 8), box(2, 200, 120, 4)]
    nesting_kerf.clear_cache()
    a = nesting_kerf.nest_best_kerf(positions, product(), RATES)
    nesting_kerf.clear_cache()
    b = nesting_kerf.nest_best_kerf(positions, product(), RATES)
    key = lambda r: [(p.pos.id, p.cx, p.cy, p.rot) for p in all_parts(r)]
    assert key(a) == key(b)
    assert nesting_kerf.nest_best_kerf(positions, product(), RATES) is b


def test_never_worse_than_lite():
    for positions in ([ring(1, 100, 0, 30)], [box(1, 300, 200, 8)], [ell(1, 5), ring(2, 90, 30, 6)]):
        lite = nest_best(positions, product(), RATES)
        res = nesting_kerf.nest_best_kerf(positions, product(), RATES)
        area = lambda r: sum(s.used_h for s in r["sheets"])
        assert (len(res["over"]), area(res)) <= (len(lite["over"]), area(lite))


def test_small_parts_go_into_bores_as_rest_parts():
    positions = [ring(1, 400, 260, 3), ring(2, 120, 40, 12)]
    res = nesting_kerf.nest_best_kerf(positions, product(), RATES, {"kerf_steps": 12})
    assert res["kerf"].get("steps", 12) == 12
    if res["kerf"]["used"]:
        guests = [p for s in res["sheets"] for p in s.rest]
        assert guests and all(p.host_id for p in guests)
        assert len(all_parts(res)) == 15


@pytest.mark.parametrize("grain,allowed", [("none", {0, 90, 180, 270}), ("axis", {0, 180}),
                                           ("directed", {0})])
def test_grain_limits_the_rotations(grain, allowed):
    positions = [ell(1, 3)]
    job_, _ = nesting_kerf.build_job(positions, product(grain=grain), RATES, 0,
                                     nesting_kerf.resolve_policy(RATES, None))
    assert set(job_["parts"][0]["rotations"]) == allowed


def test_a_ring_needs_one_rotation_and_a_rectangle_two():
    job_, _ = nesting_kerf.build_job([ring(1, 100, 0), box(2, 200, 100)], product(), RATES, 0,
                                     nesting_kerf.resolve_policy(RATES, None))
    assert [p["rotations"] for p in job_["parts"]] == [[0], [0, 90]]


def test_identical_positions_become_one_type():
    job_, owners = nesting_kerf.build_job([ring(1, 100, 0, 2), ring(2, 100, 0, 3)], product(),
                                          RATES, 0, nesting_kerf.resolve_policy(RATES, None))
    assert len(job_["parts"]) == 1 and job_["parts"][0]["quantity"] == 5
    assert [p.id for p in owners[0]] == [1, 1, 2, 2, 2]


def test_a_tiny_bolt_hole_counts_as_material():
    pos = Position(id=1, od=300, q=1, shape=ring_from_params(300, 0, 6, 200, 12))
    job_, _ = nesting_kerf.build_job([pos, ring(2, 100, 0)], product(), RATES, 0,
                                     nesting_kerf.resolve_policy(RATES, None))
    assert job_["parts"][0]["holes"] == []


def test_a_rounded_rectangle_stays_inside_its_footprint():
    outer = {"kind": "rect", "w": 200, "h": 100, "r": 20}
    b = kerf.bbox(nesting_kerf._ring_of(outer, True))
    assert b["maxx"] - b["minx"] == pytest.approx(200) and b["maxy"] - b["miny"] == pytest.approx(100)


def test_engine_kerf_reaches_the_batch():
    bucket = [BatchPart(position_id=1, order_no="A", customer="", customer_ref="", label="L", mat="M",
                        thk=2.0, od=360, di=0, q=14, shape=ell(1).shape)]
    res = _nest(bucket, product(), RATES, None, None, "kerf")
    assert "kerf" in res and len(all_parts(res)) == 14


def test_the_budget_follows_the_work():
    assert nesting_kerf.steps_for(30, 4) == 120
    assert nesting_kerf.steps_for(300, 480) == nesting_kerf.SEEDS_ONLY


def test_a_basket_too_big_for_kerf_stays_with_lite(monkeypatch):
    monkeypatch.setattr(nesting_kerf, "MAX_MAP_BYTES", 0)
    nesting_kerf.clear_cache()
    res = nesting_kerf.nest_best_kerf([ell(1, 4)], product(), RATES)
    nesting_kerf.clear_cache()
    assert res["kerf"] == {"used": False, "reason": "Korb zu groß für Kerf"}
    assert res["v"] != nesting_kerf.ENGINE_LABEL


def test_an_oversize_part_does_not_switch_kerf_off_when_lite_answers_from_memory():
    def basket():
        return [box(1, 4000, 200), ell(2, 14)]

    nesting_kerf.clear_cache()
    nesting_kerf.nest_best_kerf(basket(), product(), RATES)
    nesting_kerf.clear_cache()
    res = nesting_kerf.nest_best_kerf(basket(), product(), RATES)
    assert res["kerf"]["used"] is True and res["kerf"]["unplaced"] == 0
    assert [p.id for p in res["over"]] == [1]


def test_nearly_equal_rings_never_lose_the_outer_one():
    positions = [ring(1, 400, 300, 2), ring(2, 300, 200, 2), ring(3, 200, 100, 4)]
    res = nesting_kerf.nest_best_kerf(positions, product(), RATES, {"kerf_steps": 12})
    if res["kerf"]["used"]:
        hosts = {p.uid for s in res["sheets"] for p in s.top + s.rest}
        for s in res["sheets"]:
            for guest in s.rest:
                assert guest.host_id in hosts and guest.host_id != guest.uid
        assert all(p.host_id is None for s in res["sheets"] for p in s.top)
        assert len(all_parts(res)) == 8


def test_mixed_formats_run_kerf_a_few_times_not_once_per_plate(monkeypatch):
    calls = []
    real = nesting_kerf.kerf.nest
    monkeypatch.setattr(nesting_kerf.kerf, "nest", lambda job: calls.append(1) or real(job))
    bucket = [BatchPart(position_id=1, order_no="A", customer="", customer_ref="", label="L",
                        mat="M", thk=2.0, od=360, di=0, q=60, shape=ell(1).shape)]
    nesting_kerf.clear_cache()
    plates, over = _peel_plates(bucket, product(sheets=[(1500.0, 1000.0), (1000.0, 800.0)]),
                                RATES, None, True, NestOptions(), "kerf")
    assert not over and len(plates) >= 3
    assert sum(len(p.sheet.top) + len(p.sheet.rest) for p in plates) == 60
    assert len(calls) <= 3


def test_an_oversize_part_stays_oversize():
    positions = [box(1, 4000, 200), ell(2, 3)]
    res = nesting_kerf.nest_best_kerf(positions, product(), RATES)
    assert [p.id for p in res["over"]] == [1]


def test_the_label_says_who_really_nested():
    from types import SimpleNamespace as Plate

    from gimel.services.batch_runner import ENGINE_VERSION, _actual_label

    assert _actual_label("kerf", [Plate(engine="kerf-1.4.0"), Plate(engine=ENGINE_VERSION)]) == "kerf-1.4.0"
    assert _actual_label("kerf", [Plate(engine=ENGINE_VERSION)]) == ENGINE_VERSION
    assert _actual_label("lite", [Plate(engine=ENGINE_VERSION)]) == ENGINE_VERSION


def test_kerf_reads_its_options_from_the_policy():
    """Budget, Raster, Füllrichtung, Startwert und Verfeinerung sind Stellschrauben
    des Laufs — nicht fest im Kern verdrahtet."""
    policy = nesting_kerf.resolve_policy(RATES, {
        "kerf_steps": 77, "kerf_stall": 25, "kerf_cell": 10,
        "kerf_gravity": "left", "kerf_seed": 9, "kerf_refine": False,
    })
    job_, _ = nesting_kerf.build_job([box(1, 200, 100, 2)], product(), RATES, 0, policy)
    assert job_["maxSteps"] == 77
    assert job_["stallSteps"] == 25
    assert job_["cell"] == 10
    assert job_["gravity"] == "left"
    assert job_["seed"] == 9
    assert job_["refine"] is False


def test_kerf_without_options_keeps_the_old_defaults():
    policy = nesting_kerf.resolve_policy(RATES, None)
    job_, _ = nesting_kerf.build_job([box(1, 200, 100, 2)], product(), RATES, 0, policy)
    assert job_["gravity"] == "top"
    assert job_["seed"] == nesting_kerf.KERF_SEED
    assert job_["refine"] is True
    assert "stallSteps" not in job_


def test_kerf_options_do_not_share_a_cache_entry(monkeypatch):
    calls = []
    real = nesting_kerf.kerf.nest
    monkeypatch.setattr(nesting_kerf.kerf, "nest", lambda job: calls.append(1) or real(job))
    positions = [ell(1, 4)]
    nesting_kerf.clear_cache()
    nesting_kerf.nest_best_kerf(positions, product(), RATES, {"kerf_steps": 12, "kerf_cell": 20})
    nesting_kerf.nest_best_kerf(positions, product(), RATES, {"kerf_steps": 12, "kerf_cell": 10})
    assert len(calls) == 2


def test_nest_options_carry_every_kerf_knob_into_the_policy():
    opts = NestOptions(kerf_steps=40, kerf_stall=15, kerf_cell=2.5, kerf_gravity="left",
                       kerf_seed=11, kerf_refine=False)
    assert opts.policy() == {
        "kerf_steps": 40, "kerf_stall": 15, "kerf_cell": 2.5,
        "kerf_gravity": "left", "kerf_seed": 11, "kerf_refine": False,
    }
