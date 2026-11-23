"""Teileerkennung: Maß auf dem Tisch, Form samt Löchern, alle Lagen."""

from __future__ import annotations

import math

import numpy as np
import pytest

from gimel.core import vision


def rect(w, h):
    return np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], float)


def circle(d, n=96):
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    return np.column_stack([np.cos(t), np.sin(t)]) * d / 2


def ell():
    return np.array([[0, 0], [300, 0], [300, 60], [60, 60], [60, 200], [0, 200]], float)


def turned(pts, deg, dx=0.0, dy=0.0):
    a = math.radians(deg)
    r = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    return np.asarray(pts) @ r.T + [dx, dy]


def test_oriented_box_finds_a_turned_rectangle():
    box = vision.oriented_box(turned(rect(120, 60), 25, 40, -10))
    assert box["length_mm"] == pytest.approx(120)
    assert box["width_mm"] == pytest.approx(60)
    assert box["angle_deg"] == pytest.approx(25)
    assert (box["x_mm"], box["y_mm"]) == pytest.approx((40, -10))


@pytest.mark.parametrize("deg", [0, 37, 90, 151])
def test_the_same_part_in_any_position_is_the_same_part(deg):
    a = vision.normalize([ell()])
    b = vision.normalize([turned(ell(), deg, 500, 200)])
    assert vision.shape_distance(a, b) < 0.03


def test_a_part_turned_over_is_the_same_part():
    flipped = ell() * [-1, 1]
    assert vision.shape_distance(vision.normalize([ell()]), vision.normalize([flipped])) < 0.03


def test_same_outline_with_another_bore_is_another_part():
    small = vision.candidate("Bohrung 60", [circle(200), circle(60)])
    big = vision.candidate("Bohrung 120", [circle(200), circle(120)])
    hit = vision.match([circle(200), circle(120)], [small, big])
    assert hit["ref"] == "Bohrung 120" and hit["confidence"] > 0.95


def test_wrong_size_and_wrong_shape_find_nothing():
    cand = [vision.candidate("Winkel", [ell()])]
    assert vision.match([rect(500, 100)], cand) is None
    assert vision.match([rect(300, 200)], cand) is None


def test_two_equal_parts_are_named_as_ambiguous():
    cands = [vision.candidate("A", [rect(120, 60)]), vision.candidate("B", [rect(120, 60)])]
    hit = vision.match([rect(120, 60)], cands)
    assert hit["ref"] == "A" and hit["ambiguous"] == ["B"]


def test_a_noisy_polygon_still_matches_its_drawing():
    """Eine Kamera liefert keine sauberen Ecken; ein Millimeter Rauschen ist normal."""
    rng = np.random.default_rng(3)
    seen = ell() + rng.normal(0, 1.0, ell().shape)
    hit = vision.match([seen], [vision.candidate("Winkel", [ell()])])
    assert hit is not None and hit["confidence"] > 0.9


def test_the_same_outer_box_with_less_material_is_another_part():
    """Nur die Maße zu prüfen würde ein L und ein Quadrat verwechseln."""
    full = vision.candidate("Quadrat", [rect(100, 100)])
    assert vision.match([[[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]]], [full]) is None


def test_a_concave_polygon_is_recognised_in_every_pose():
    cand = vision.candidate("L", [ell()])
    for deg in (0, 23, 90, 167, 270):
        hit = vision.match([turned(ell(), deg, 30, -20)], [cand])
        assert hit is not None and hit["ref"] == "L" and hit["confidence"] > 0.95


@pytest.mark.parametrize("pitch,roll", [(0, 0), (12, 0), (0, -9), (10, 7)])
def test_table_and_pixels_are_inverse_also_when_tilted(pitch, roll):
    cal = vision.Calibration(height_mm=800, pitch_deg=pitch, roll_deg=roll, origin_x_mm=30,
                             origin_y_mm=-20, yaw_deg=8)
    sc = vision.TableScale(cal, 1280, 720)
    pts = np.array([[100.0, 80.0], [-200.0, 40.0], [0.0, 0.0]])
    assert sc.to_table(sc.to_pixels(pts)) == pytest.approx(pts)


def test_a_tilted_camera_still_measures_true_size_on_the_table():
    cal = vision.Calibration(height_mm=700, pitch_deg=14, roll_deg=6)
    sc = vision.TableScale(cal, 1280, 720)
    seen = sc.to_table(sc.to_pixels(turned(rect(240, 90), 33, 50, 20)))
    box = vision.oriented_box(seen)
    assert box["length_mm"] == pytest.approx(240) and box["width_mm"] == pytest.approx(90)


def test_part_thickness_moves_the_measuring_plane_closer():
    thin = vision.TableScale(vision.Calibration(height_mm=600), 640, 480)
    thick = vision.TableScale(vision.Calibration(height_mm=600, thickness_mm=60), 640, 480)
    px = np.array([[420.0, 240.0]])
    assert thick.to_table(px)[0, 0] == pytest.approx(thin.to_table(px)[0, 0] * 0.9)


def test_measured_points_replace_the_field_of_view():
    cal = vision.Calibration()
    cal.add_point(500, 100, 200)
    assert cal.mm_per_px_at(1000, 640) == pytest.approx(1.0)
    cal.add_point(1000, 100, 50)
    assert cal.mm_per_px_at(750, 640) == pytest.approx(1.25)


def test_too_much_tilt_is_refused():
    sc = vision.TableScale(vision.Calibration(pitch_deg=80, hfov_deg=120), 640, 480)
    with pytest.raises(ValueError):
        sc.to_table(np.array([[320.0, 0.0]]))


def test_calibration_ignores_unknown_keys_from_old_settings():
    assert vision.Calibration.from_dict({"height_mm": 500, "weg": 1}).height_mm == 500
