"""Vom Foto zum gezählten Teil: ein Teil aus dem Plan liegt auf dem Tisch."""

from __future__ import annotations

import time

import numpy as np
import pytest

from gimel.core import vision as core
from gimel.core.nesting_kerf import rings_of
from gimel.core.types import Position
from gimel.db import SessionLocal
from gimel.models import AuditLog, Role, User, VisionConfirmation, WorkPlate
from gimel.security import create_access_token
from gimel.services import vision

cv2 = pytest.importorskip("cv2")
W, H = 1280, 960


def a_placed_part() -> tuple[str, dict]:
    with SessionLocal() as db:
        for plate in db.query(WorkPlate).all():
            for pl in plate.placements or []:
                return plate.work_order.no, pl
    raise AssertionError("demo plant has no plate")


def photo(pl: dict, cal: core.Calibration, at=(40.0, -30.0), deg=30.0) -> bytes:
    """Dunkler Tisch, helles Teil, gesehen durch die Kamera aus ``cal``."""
    scale = core.TableScale(cal, W, H)
    rings = rings_of(Position(id=0, od=pl["od"], di=pl.get("di") or 0, shape=pl.get("shape")))
    a = np.radians(deg)
    r = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    img = np.full((H, W, 3), 35, np.uint8)
    polys = [np.round(scale.to_pixels(np.asarray(x) @ r.T + at)).astype(np.int32) for x in rings]
    cv2.fillPoly(img, polys, (205, 205, 205))
    ok, jpg = cv2.imencode(".png", img)
    assert ok
    return jpg.tobytes()


def post(client, data: bytes, work_order=None, **kw):
    return client.post("/api/vision/identify", content=data, headers={"Content-Type": "image/png"},
                       params={"work_order": work_order} if work_order else {}, **kw)


def calibrate(client, **over):
    body = {"height_mm": 900, "hfov_deg": 70, "thickness_mm": 0, **over}
    assert client.put("/api/vision/calibration", json=body).status_code == 200
    return core.Calibration.from_dict(body)


def test_status_says_whether_it_can_run(client):
    assert client.get("/api/vision/status").json()["available"] is True


def test_a_planned_part_is_recognised_counted_and_capped(client):
    no, pl = a_placed_part()
    cal = calibrate(client)
    body = post(client, photo(pl, cal), no).json()
    assert body["unknown"] == [] and len(body["parts"]) == 1
    hit = body["parts"][0]
    assert (hit["work_order"], hit["position_id"]) == (no, pl["position_id"])
    assert hit["confidence"] > 0.85
    assert hit["x_mm"] == pytest.approx(40, abs=3) and hit["y_mm"] == pytest.approx(-30, abs=3)

    left = hit["remaining"]
    payload = {"work_order": no, "position_id": pl["position_id"], "confidence": hit["confidence"]}
    for n in range(left):
        r = client.post("/api/vision/confirm", json=payload)
        assert r.status_code == 200 and r.json()["remaining"] == left - n - 1
    assert client.post("/api/vision/confirm", json=payload).status_code == 409
    with SessionLocal() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "vision_confirm",
                                         AuditLog.entity_id == no).count() == left
        db.query(VisionConfirmation).delete()
        db.commit()


def test_a_tilted_camera_finds_the_same_part(client):
    no, pl = a_placed_part()
    cal = calibrate(client, pitch_deg=10, roll_deg=-6)
    hit = post(client, photo(pl, cal), no).json()["parts"]
    calibrate(client)
    assert hit and hit[0]["position_id"] == pl["position_id"]


def test_something_else_on_the_table_is_reported_as_unknown(client):
    no, _ = a_placed_part()
    cal = calibrate(client)
    odd = {"od": 0, "shape": {"outer": {"kind": "rect", "w": 611, "h": 37}, "holes": [], "bolts": None}}
    body = post(client, photo(odd, cal), no).json()
    assert body["parts"] == [] and len(body["unknown"]) == 1
    assert body["unknown"][0]["length_mm"] == pytest.approx(611, abs=6)


def test_a_part_of_another_work_order_cannot_be_counted_here(client):
    no, pl = a_placed_part()
    r = client.post("/api/vision/confirm", json={"work_order": no, "position_id": 999999})
    assert r.status_code == 404


@pytest.mark.parametrize("data,code", [(b"<svg onload=alert(1)>", 415), (b"\xff\xd8\xff" + b"0" * 64, 415)])
def test_what_is_not_an_image_is_refused(client, data, code):
    assert post(client, data).status_code == code


def test_an_oversized_upload_is_refused(client):
    data = b"\xff\xd8\xff" + b"0" * vision.MAX_IMAGE_BYTES
    assert post(client, data).status_code == 413


def test_a_small_file_that_claims_a_huge_picture_is_refused_before_decoding(client):
    head = b"\x89PNG\r\n\x1a\n" + b"\0\0\0\rIHDR" + (20000).to_bytes(4, "big") * 2 + b"\x08\x02\0\0\0"
    r = post(client, head)
    assert r.status_code == 415 and "Megapixel" in r.json()["detail"]


def test_jpeg_size_is_read_from_the_header():
    ok, jpg = cv2.imencode(".jpg", np.zeros((123, 456, 3), np.uint8))
    assert vision.image_size(jpg.tobytes()) == (456, 123)


def test_a_picture_full_of_small_shapes_cannot_stall_the_server(client):
    no, _ = a_placed_part()
    calibrate(client)
    img = np.full((1200, 1600, 3), 30, np.uint8)
    for x in range(10, 1590, 40):
        for y in range(10, 1190, 40):
            cv2.rectangle(img, (x, y), (x + 26, y + 26), (220, 220, 220), -1)
    _, png = cv2.imencode(".png", img)
    t0 = time.perf_counter()
    r = post(client, png.tobytes(), no)
    assert r.status_code == 200 and time.perf_counter() - t0 < 3
    assert len(r.json()["parts"]) + len(r.json()["unknown"]) <= vision.MAX_PARTS


def test_a_second_recognition_at_the_same_time_waits_its_turn(client):
    assert vision._gate.acquire(blocking=False)
    try:
        assert post(client, b"\xff\xd8\xff").status_code == 429
    finally:
        vision._gate.release()


def test_a_broken_setting_falls_back_to_the_default(client):
    from gimel.services import settings_store

    with SessionLocal() as db:
        settings_store.set_value(db, vision.SETTING, "[1]", actor="test")
        db.commit()
        assert vision.load_calibration(db).height_mm == core.Calibration().height_mm
    calibrate(client)


def test_without_opencv_only_this_screen_stops(client, monkeypatch):
    monkeypatch.setattr(vision, "_cv2", lambda: None)
    assert client.get("/api/vision/status").json()["available"] is False
    r = post(client, b"\xff\xd8\xff")
    assert r.status_code == 503 and "opencv" in r.json()["detail"]
    assert client.get("/api/vision/expected").status_code == 200


def worker_headers():
    with SessionLocal() as db:
        u = db.query(User).filter(User.email == "kamera@example.test").first()
        if u is None:
            u = User(email="kamera@example.test", name="Kamera", role=Role.worker, password_hash="x")
            db.add(u)
            db.commit()
        return {"Authorization": f"Bearer {create_access_token(u)}"}


def test_the_hall_sees_no_customer_and_cannot_recalibrate(client):
    head = worker_headers()
    rows = client.get("/api/vision/expected", headers=head).json()
    assert rows and all("customer" not in r for r in rows)
    r = client.put("/api/vision/calibration", json={"height_mm": 500}, headers=head)
    assert r.status_code == 403


def test_a_second_person_needs_a_login():
    from fastapi.testclient import TestClient

    from gimel.app import create_app

    with TestClient(create_app()) as anon:
        assert anon.get("/api/vision/status").status_code == 401


def test_camera_pose_comes_back_from_a_known_rectangle():
    cal = core.Calibration(height_mm=820, pitch_deg=11, roll_deg=-7, hfov_deg=70)
    scale = core.TableScale(cal, W, H)
    corners = np.array([[-200.0, -120.0], [240.0, -120.0], [240.0, 180.0], [-200.0, 180.0]])
    r = vision.estimate_pose(scale.to_pixels(corners).tolist(), 440, 300, W, H, 70)
    assert r["height_mm"] == pytest.approx(820, rel=0.01)
    assert r["pitch_deg"] == pytest.approx(11, abs=0.3)
    assert r["roll_deg"] == pytest.approx(-7, abs=0.3)
    assert r["measured_sides_mm"] == pytest.approx([440, 300], abs=1.5)


def test_rectangle_calibration_fills_the_setting_only_when_applied(client):
    calibrate(client)
    scale = core.TableScale(core.Calibration(height_mm=750, hfov_deg=70), W, H)
    corners = scale.to_pixels(np.array([[-150.0, -100.0], [150.0, -100.0], [150.0, 100.0], [-150.0, 100.0]]))
    body = {"corners": (corners / [W, H]).tolist(), "side1_mm": 300, "side2_mm": 200,
            "width_px": W, "height_px": H}
    assert client.post("/api/vision/calibration/rectangle", json=body).json()["applied"] is False
    assert client.get("/api/vision/status").json()["calibration"]["height_mm"] == 900
    client.post("/api/vision/calibration/rectangle", json={**body, "apply": True})
    assert client.get("/api/vision/status").json()["calibration"]["height_mm"] == pytest.approx(750, rel=0.01)
    calibrate(client)
