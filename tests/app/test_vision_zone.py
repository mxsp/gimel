"""Zählbereich: was im eingezeichneten Rechteck liegt, zählt einmal und wird abgezogen."""

from __future__ import annotations

import numpy as np
import pytest

from gimel.core import vision as core
from gimel.core.nesting_kerf import rings_of
from gimel.core.types import Position
from gimel.db import SessionLocal
from gimel.models import AuditLog, VisionConfirmation, WorkPlate
from gimel.services import vision

cv2 = pytest.importorskip("cv2")
W, H = 1280, 960


def a_placed_part(min_remaining: int = 1) -> tuple[str, dict]:
    with SessionLocal() as db:
        open_rows = {(r["work_order"], r["position_id"]) for r in vision.expected(db)
                     if r["remaining"] >= min_remaining}
        for plate in db.query(WorkPlate).all():
            for pl in plate.placements or []:
                if (plate.work_order.no, pl["position_id"]) in open_rows:
                    return plate.work_order.no, pl
    raise AssertionError("demo plan has no open part")


def photo(pl: dict, cal: core.Calibration, at=(40.0, -30.0), deg=30.0) -> bytes:
    scale = core.TableScale(cal, W, H)
    rings = rings_of(Position(id=0, od=pl["od"], di=pl.get("di") or 0, shape=pl.get("shape")))
    a = np.radians(deg)
    r = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    img = np.full((H, W, 3), 35, np.uint8)
    polys = [np.round(scale.to_pixels(np.asarray(x) @ r.T + at)).astype(np.int32) for x in rings]
    cv2.fillPoly(img, polys, (205, 205, 205))
    ok, png = cv2.imencode(".png", img)
    assert ok
    return png.tobytes()


def post(client, data: bytes, work_order: str, preview: bool = False):
    params = {"work_order": work_order}
    if preview:
        params["preview"] = "true"
    return client.post("/api/vision/identify", content=data, headers={"Content-Type": "image/png"},
                       params=params)


def calibrate(client) -> core.Calibration:
    body = {"height_mm": 900, "hfov_deg": 70, "thickness_mm": 0}
    assert client.put("/api/vision/calibration", json=body).status_code == 200
    return core.Calibration.from_dict(body)


def zone_around(cal: core.Calibration, at=(40.0, -30.0), half: float = 160.0) -> dict:
    scale = core.TableScale(cal, W, H)
    mm = np.array([[at[0] - half, at[1] - half], [at[0] + half, at[1] - half],
                   [at[0] + half, at[1] + half], [at[0] - half, at[1] + half]], float)
    pts = scale.to_pixels(mm) / [W, H]
    return {"points": np.round(pts, 5).tolist(), "width_px": W, "height_px": H,
            "enabled": True, "auto_count": True}


@pytest.fixture(autouse=True)
def _clean_zone(client):
    calibrate(client)
    client.delete("/api/vision/zone")
    vision.reset_zone_tracking()
    with SessionLocal() as db:
        db.query(VisionConfirmation).delete()
        db.query(AuditLog).filter(AuditLog.action.in_(("vision_confirm", "vision_undo"))).delete()
        db.commit()
    yield
    client.delete("/api/vision/zone")
    vision.reset_zone_tracking()
    with SessionLocal() as db:
        db.query(VisionConfirmation).delete()
        db.query(AuditLog).filter(AuditLog.action.in_(("vision_confirm", "vision_undo"))).delete()
        db.commit()


def test_a_drawn_zone_is_saved_in_table_millimetres(client):
    cal = calibrate(client)
    body = zone_around(cal)
    saved = client.put("/api/vision/zone", json=body).json()
    assert saved["enabled"] is True and len(saved["points_mm"]) == 4
    assert min(p[0] for p in saved["points_mm"]) == pytest.approx(-120, abs=6)
    assert client.get("/api/vision/status").json()["zone"]["auto_count"] is True


def test_a_zone_must_lie_in_the_picture_and_cover_something(client):
    bad = {"points": [[0.5, 0.5], [0.505, 0.5], [0.505, 0.505]], "width_px": W, "height_px": H}
    assert client.put("/api/vision/zone", json=bad).status_code == 400
    outside = {"points": [[1.2, 0.1], [1.3, 0.1], [1.3, 0.2]], "width_px": W, "height_px": H}
    assert client.put("/api/vision/zone", json=outside).status_code == 400


def test_the_hall_cannot_draw_the_counting_zone(client):
    from gimel.models import Role, User
    from gimel.security import create_access_token

    with SessionLocal() as db:
        u = db.query(User).filter(User.email == "zone@example.test").first()
        if u is None:
            u = User(email="zone@example.test", name="Zone", role=Role.worker, password_hash="x")
            db.add(u)
            db.commit()
        head = {"Authorization": f"Bearer {create_access_token(u)}"}
    assert client.put("/api/vision/zone", json=zone_around(calibrate(client)), headers=head).status_code == 403


def test_a_part_in_the_zone_is_counted_once_and_deducted(client):
    no, pl = a_placed_part()
    cal = calibrate(client)
    assert client.put("/api/vision/zone", json=zone_around(cal)).status_code == 200
    first = post(client, photo(pl, cal), no).json()
    hit = first["parts"][0]
    assert first["auto_counted"] and first["auto_counted"][0]["hit"] == 0
    assert hit["counted"] is True and hit["confirmation_id"]
    assert hit["remaining"] == first["auto_counted"][0]["remaining"]
    assert first["auto_counted"][0]["remaining"] >= 0

    with SessionLocal() as db:
        assert db.query(VisionConfirmation).count() == 1
    again = post(client, photo(pl, cal), no).json()
    assert again["auto_counted"] == []
    with SessionLocal() as db:
        assert db.query(VisionConfirmation).count() == 1


def test_a_test_image_never_deducts_real_parts(client):
    no, pl = a_placed_part()
    cal = calibrate(client)
    assert client.put("/api/vision/zone", json=zone_around(cal)).status_code == 200
    body = post(client, photo(pl, cal), no, preview=True).json()
    assert body["parts"] and body["auto_counted"] == []
    with SessionLocal() as db:
        assert db.query(VisionConfirmation).count() == 0


def test_a_long_pause_does_not_count_the_same_part_twice(client, monkeypatch):
    """Zwischen zwei Messungen darf beliebig viel Zeit liegen; das Teil lag durchgehend da."""
    no, pl = a_placed_part()
    cal = calibrate(client)
    assert client.put("/api/vision/zone", json=zone_around(cal)).status_code == 200
    clock = [1000.0]
    monkeypatch.setattr(vision.time, "monotonic", lambda: clock[0])
    assert post(client, photo(pl, cal), no).json()["auto_counted"]
    clock[0] += 10 * 60
    again = post(client, photo(pl, cal), no).json()
    assert again["auto_counted"] == []
    with SessionLocal() as db:
        assert db.query(VisionConfirmation).count() == 1


def test_a_part_outside_the_zone_is_not_counted(client):
    no, pl = a_placed_part()
    cal = calibrate(client)
    assert client.put("/api/vision/zone", json=zone_around(cal, at=(350.0, 250.0))).status_code == 200
    body = post(client, photo(pl, cal), no).json()
    assert body["parts"] and body["auto_counted"] == []
    with SessionLocal() as db:
        assert db.query(VisionConfirmation).count() == 0


def test_switching_auto_count_off_leaves_the_zone_visible(client):
    no, pl = a_placed_part()
    cal = calibrate(client)
    body = {**zone_around(cal), "auto_count": False}
    assert client.put("/api/vision/zone", json=body).status_code == 200
    seen = post(client, photo(pl, cal), no).json()
    assert seen["zone"]["enabled"] is True and seen["zone"]["auto_count"] is False
    assert len(seen["zone"]["points"]) == 4
    assert seen["auto_counted"] == []


def test_after_the_part_leaves_a_new_one_counts_again(client):
    no, pl = a_placed_part(min_remaining=2)
    cal = calibrate(client)
    assert client.put("/api/vision/zone", json=zone_around(cal)).status_code == 200
    first = post(client, photo(pl, cal), no).json()
    assert first["auto_counted"]
    vision.reset_zone_tracking()  # was einem neuen Teil an derselben Stelle entspricht
    second = post(client, photo(pl, cal), no).json()
    assert second["auto_counted"]
    with SessionLocal() as db:
        assert db.query(VisionConfirmation).count() == 2


def test_zone_membership_uses_the_table_rectangle():
    zone = core.CountZone(points_mm=[[0, 0], [100, 0], [100, 100], [0, 100]])
    assert zone.contains(50, 50) and zone.contains(0, 50)
    assert not zone.contains(150, 50) and not zone.contains(50, -1)
