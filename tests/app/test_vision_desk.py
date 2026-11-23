"""Teileerkennung am Tisch: Testbild, Umriss, Alternativen, Zählung zurücknehmen."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from gimel.db import SessionLocal
from gimel.models import AuditLog, VisionConfirmation
from gimel.services import vision

cv2 = pytest.importorskip("cv2")


@pytest.fixture(autouse=True)
def _level_camera(client):
    body = {"height_mm": 1400, "hfov_deg": 70, "thickness_mm": 0}
    assert client.put("/api/vision/calibration", json=body).status_code == 200
    yield
    with SessionLocal() as db:
        db.query(VisionConfirmation).delete()
        db.query(AuditLog).filter(AuditLog.action.in_(("vision_confirm", "vision_undo"))).delete()
        db.commit()


def first_order(client) -> str:
    rows = client.get("/api/vision/expected").json()
    return rows[0]["work_order"]


def test_expected_rows_carry_an_outline(client):
    row = client.get("/api/vision/expected").json()[0]
    assert row["outline"]["path"].startswith("M") and row["outline"]["w"] > 0


def test_a_test_image_is_recognised(client):
    no = first_order(client)
    r = client.get("/api/vision/sample", params={"work_order": no, "count": 2, "seed": 7})
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert r.headers["cache-control"] == "no-store"
    body = client.post("/api/vision/identify", content=r.content,
                       headers={"Content-Type": "image/jpeg"}, params={"work_order": no}).json()
    assert len(body["parts"]) >= 1 and not body["unknown"]
    hit = body["parts"][0]
    assert hit["work_order"] == no and "outline" in hit and isinstance(hit["alternatives"], list)


def test_the_test_image_is_capped(client):
    assert client.get("/api/vision/sample", params={"count": 50}).status_code == 422


def test_a_count_can_be_taken_back_and_is_logged(client):
    no = first_order(client)
    row = next(r for r in client.get("/api/vision/expected", params={"work_order": no}).json()
               if r["remaining"] > 0)
    made = client.post("/api/vision/confirm",
                       json={"work_order": no, "position_id": row["position_id"]}).json()
    assert made["remaining"] == row["remaining"] - 1
    back = client.delete(f"/api/vision/confirm/{made['id']}")
    assert back.status_code == 200 and back.json()["remaining"] == row["remaining"]
    assert client.delete(f"/api/vision/confirm/{made['id']}").status_code == 404
    with SessionLocal() as db:
        line = db.query(AuditLog).filter(AuditLog.action == "vision_undo").order_by(AuditLog.id.desc()).first()
        assert line.detail["counted_by"] and line.detail["counted_at"]


def test_the_hall_never_sees_a_customer_on_the_table(client):
    """Auch nicht über die Alternativen: die Halle sieht Auftrag und Teil, keine Kunden."""
    from tests.app.test_vision_api import worker_headers

    head = worker_headers()
    for seed in range(6):
        img = client.get("/api/vision/sample", params={"count": 4, "seed": seed}, headers=head)
        assert img.status_code == 200
        body = client.post("/api/vision/identify", content=img.content, headers={**head, "Content-Type": "image/jpeg"}).json()
        for hit in body["parts"]:
            assert "customer" not in hit
            assert all("customer" not in a for a in hit["alternatives"])


def test_the_hall_takes_back_only_its_own_recent_count():
    with SessionLocal() as db:
        row = VisionConfirmation(work_order_no="X", position_id=1, actor="a@x",
                                 created_at=datetime.now(timezone.utc) - timedelta(minutes=30))
        mine = VisionConfirmation(work_order_no="X", position_id=1, actor="b@x")
        db.add_all([row, mine])
        db.commit()
        with pytest.raises(PermissionError):
            vision.undo(db, mine.id, "a@x", office=False)
        with pytest.raises(PermissionError):
            vision.undo(db, row.id, "a@x", office=False)
        vision.undo(db, row.id, "chef@x", office=True)
        vision.undo(db, mine.id, "b@x", office=False)


def test_the_same_part_in_two_orders_is_not_ambiguous(client):
    """Die Demo hat dieselbe Dichtung in mehreren Innenaufträgen: sie zählt beim ältesten offenen."""
    rows = client.get("/api/vision/expected").json()
    by_shape: dict[str, list] = {}
    for r in rows:
        by_shape.setdefault(r["outline"]["path"], []).append(r)
    twins = next((v for v in by_shape.values() if len({r["work_order"] for r in v}) > 1), None)
    if twins is None:
        pytest.skip("Demo ohne gleiche Teile in zwei Innenaufträgen")
    hits = []
    for seed in range(12):
        img = client.get("/api/vision/sample", params={"count": 1, "seed": seed}).content
        hits += client.post("/api/vision/identify", content=img,
                            headers={"Content-Type": "image/jpeg"}).json()["parts"]
    shared = [h for h in hits if h["outline"]["path"] == twins[0]["outline"]["path"]]
    for h in shared or hits:
        orders = sorted(r["work_order"] for r in by_shape[h["outline"]["path"]] if r["remaining"] > 0)
        assert h["work_order"] == orders[0]
        assert {a["work_order"] for a in h["alternatives"]} >= set(orders[1:])
