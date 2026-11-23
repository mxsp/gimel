"""Der Schachtel-Editor: was gespeichert wird, schneidet die Maschine."""

from __future__ import annotations

import copy
import io
import threading
import time
import zipfile
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from gimel.core import kerf
from gimel.core.plate_check import CHORD_TOLERANCE, Window, check_plate, plate_metrics
from gimel.db import SessionLocal
from gimel.models import (AuditLog, FactoryStation, NestRun, Product, Role, StockMovement, User,
                          WorkItem, WorkOrder, WorkOrderStatus, WorkPlate)
from gimel.routers.nesting import MAX_BODY_BYTES
from gimel.security import create_access_token
from gimel.services import batch_report, batch_runner, cutfiles, plate_edit, smtp_client


@pytest.fixture
def no(client):
    with SessionLocal() as db:
        if not db.query(WorkOrder).filter(WorkOrder.status == WorkOrderStatus.open).count():
            batch_runner.run_batch(db, trigger="manual", actor="test", force=True)
        wo = (db.query(WorkOrder).filter(WorkOrder.status == WorkOrderStatus.open,
                                         WorkOrder.material_staged_at.is_(None))
                .order_by(WorkOrder.n_parts.desc()).first())
        return wo.no


def layout(client, no) -> dict:
    r = client.get(f"/api/production/work-orders/{no}/layout")
    assert r.status_code == 200, r.text
    return r.json()


def body(data) -> dict:
    return {"version": data["version"],
            "plates": [{"fmt": p["fmt"], "turned": p["turned"],
                        "placements": [{k: i[k] for k in ("tag", "cx", "cy", "rot")} for i in p["placements"]]}
                       for p in data["plates"]]}


def save(client, no, b):
    return client.put(f"/api/production/work-orders/{no}/layout", json=b)


def test_every_stored_plate_passes_its_own_check(client):
    """Sonst stünde jede automatische Lage im Editor rot da."""
    with SessionLocal() as db:
        nos = [w.no for w in db.query(WorkOrder).all()]
    for no in nos:
        b = body(layout(client, no))
        r = client.post(f"/api/production/work-orders/{no}/layout/check", json={"plates": b["plates"]})
        assert r.status_code == 200 and r.json()["valid"], (no, r.json()["issues"][:3])


def test_an_overlap_is_refused_and_nothing_changes(client, no):
    data = layout(client, no)
    b = body(data)
    plate = next(p for p in b["plates"] if len(p["placements"]) > 1)
    plate["placements"][1].update(cx=plate["placements"][0]["cx"], cy=plate["placements"][0]["cy"])
    r = save(client, no, b)
    assert r.status_code == 422 and "überlappt" in r.json()["detail"]
    assert layout(client, no)["version"] == data["version"]


def test_a_part_off_the_plate_is_refused(client, no):
    b = body(layout(client, no))
    b["plates"][0]["placements"][0]["cx"] = -500
    r = save(client, no, b)
    assert r.status_code == 422 and "Nutzfläche" in r.json()["detail"]


@pytest.mark.parametrize("change,word", [
    (lambda b: b["plates"][0]["placements"].pop(), "fehlen"),
    (lambda b: b["plates"][0]["placements"].append(copy.copy(b["plates"][0]["placements"][0])), "doppelt"),
    (lambda b: b["plates"][0]["placements"][0].update(tag="ZZ9"), "gehört nicht"),
    (lambda b: b["plates"][0].update(fmt=[111, 222]), "Plattenformat"),
])
def test_the_part_set_must_match_exactly(client, no, change, word):
    b = body(layout(client, no))
    if word == "fehlen" and len(b["plates"][0]["placements"]) == 1:
        pytest.skip("eine leere Platte hat ihren eigenen Test")
    change(b)
    r = save(client, no, b)
    assert r.status_code == 422 and word in r.json()["detail"], r.text


def test_nan_is_refused_at_the_door(client, no):
    b = body(layout(client, no))
    raw = str(b).replace("'", '"').replace("True", "true").replace("False", "false")
    assert client.put(f"/api/production/work-orders/{no}/layout", content=raw.replace(
        str(b["plates"][0]["placements"][0]["cx"]), "NaN", 1),
        headers={"content-type": "application/json"}).status_code == 422


def test_a_stale_version_is_refused(client, no):
    b = body(layout(client, no))
    b["version"] = "alt"
    assert save(client, no, b).status_code == 409


def test_a_saved_layout_reaches_the_drawing_and_can_be_undone(client, no):
    data = layout(client, no)
    b = body(data)
    first = b["plates"][0]["placements"][0]
    old = first["cx"]
    # Ein Schritt, der frei ist, sonst gilt der Test nichts: ein Teil für sich auf die neue Platte.
    if len(b["plates"][0]["placements"]) > 1:
        moved = b["plates"][0]["placements"].pop(0)
        b["plates"].append({"fmt": b["plates"][0]["fmt"], "turned": False, "placements": [moved]})
    with SessionLocal() as db:
        wo = db.query(WorkOrder).filter(WorkOrder.no == no).one()
        stock = db.get(Product, wo.mat).stock
        plates = wo.n_plates
    r = save(client, no, b)
    assert r.status_code == 200, r.text
    after = r.json()
    assert after["has_auto"] and after["edited_by"]
    with SessionLocal() as db:
        wo = db.query(WorkOrder).filter(WorkOrder.no == no).one()
        assert wo.n_plates == len(b["plates"]) and sum(p.n_parts for p in wo.plates) == wo.n_parts
        assert db.get(Product, wo.mat).stock == stock - (wo.n_plates - plates)
        if wo.n_plates > plates:
            last = max(wo.plates, key=lambda p: p.idx)
            tag = last.placements[0]["tag"]
            assert db.query(WorkItem).filter(WorkItem.work_order_id == wo.id, WorkItem.tag == tag).one().plate_id == last.id
        assert db.query(AuditLog).filter(AuditLog.action == "layout_edit", AuditLog.entity_id == no).count() == 1
        assert not any("customer" in i for p in wo.auto_layout["plates"] for i in p["placements"])
    svg = client.get(f"/api/production/work-orders/{no}/plate/0.svg")
    assert svg.status_code == 200 and svg.headers["cache-control"] == "no-store"

    r = client.post(f"/api/production/work-orders/{no}/layout/reset", json={"version": after["version"]})
    assert r.status_code == 200, r.text
    assert not r.json()["has_auto"] and r.json()["plates"][0]["placements"][0]["cx"] == old
    with SessionLocal() as db:
        wo = db.query(WorkOrder).filter(WorkOrder.no == no).one()
        assert wo.n_plates == plates and db.get(Product, wo.mat).stock == stock


def test_a_running_order_is_frozen(client, no):
    data = layout(client, no)
    with SessionLocal() as db:
        wo = db.query(WorkOrder).filter(WorkOrder.no == no).one()
        wo.status = WorkOrderStatus.running
        db.commit()
    try:
        assert layout(client, no)["blocked"]
        assert save(client, no, body(data)).status_code == 409
        assert client.post(f"/api/production/work-orders/{no}/layout/auto").status_code == 409
    finally:
        with SessionLocal() as db:
            db.query(WorkOrder).filter(WorkOrder.no == no).one().status = WorkOrderStatus.open
            db.commit()


def propose(client, no):
    """Der Takt startet selbst Läufe; solange einer rechnet, gibt es zu Recht 409."""
    for _ in range(200):
        r = client.post(f"/api/production/work-orders/{no}/layout/auto")
        if r.status_code != 409 or "Sammellauf" not in r.text:
            return r
        time.sleep(0.1)
    raise AssertionError("der Sammellauf wird nicht fertig")


def test_auto_proposes_the_same_parts_and_saves_nothing(client, no):
    data = layout(client, no)
    r = propose(client, no)
    assert r.status_code == 200, r.text
    tags = sorted(i["tag"] for p in r.json()["plates"] for i in p["placements"])
    assert tags == sorted(i["tag"] for p in data["plates"] for i in p["placements"])
    assert layout(client, no)["version"] == data["version"]
    c = client.post(f"/api/production/work-orders/{no}/layout/check", json=r.json())
    assert c.status_code == 200 and c.json()["valid"], c.json()["issues"][:3]


def test_a_worker_cannot_touch_a_layout(client, no):
    with SessionLocal() as db:
        worker = db.query(User).filter(User.email == "schachtel@example.test").first()
        if worker is None:
            worker = User(email="schachtel@example.test", name="Halle", role=Role.worker, password_hash="x")
            db.add(worker)
            db.commit()
            db.refresh(worker)
        token = create_access_token(worker)
    head = {"Authorization": f"Bearer {token}"}
    url = f"/api/production/work-orders/{no}/layout"
    assert client.get(url, headers=head).status_code == 403
    assert client.put(url, headers=head, json={"version": "x", "plates": [{"fmt": [1, 1], "placements": []}]}).status_code == 403
    assert client.post(f"{url}/auto", headers=head).status_code == 403


def test_a_part_in_a_hole_is_allowed_and_counts_like_in_the_batch_run():
    w = Window(1000, 1000, gap=2, margin=5)
    ring = {"tag": "A", "cx": 300, "cy": 300, "rot": 0, "od": 400, "di": 300}
    small = {"tag": "B", "cx": 300, "cy": 300, "rot": 0, "od": 100, "di": 0}
    assert check_plate(w, [ring, small])["valid"]
    alone = plate_metrics(w, [ring])
    both = plate_metrics(w, [ring, small])
    assert both["utilisation"] > alone["utilisation"]
    assert both["used_h"] == alone["used_h"]
    assert not check_plate(w, [ring, {**small, "cx": 490}])["valid"]


def test_the_gap_counts_exactly_enough():
    w = Window(1000, 1000, gap=5, margin=5)
    a = {"tag": "A", "cx": 100, "cy": 100, "rot": 0, "od": 100, "di": 0}
    assert check_plate(w, [a, {**a, "tag": "B", "cx": 205.5}])["valid"]
    assert not check_plate(w, [a, {**a, "tag": "B", "cx": 203}])["valid"]


# ---------------------------------------------------------------------------
# Handlage und alles, was danach kommt
# ---------------------------------------------------------------------------
def _row(obj) -> dict:
    return {c.name: copy.deepcopy(getattr(obj, c.name)) for c in obj.__table__.columns}


def _restore(obj, row: dict) -> None:
    for name, value in row.items():
        setattr(obj, name, copy.deepcopy(value))


@pytest.fixture
def scratch(client, no):
    """Dieser Innenauftrag gehört dem Test; danach steht er wieder wie vorher."""
    with SessionLocal() as db:
        wo = db.query(WorkOrder).filter(WorkOrder.no == no).one()
        saved = _row(wo)
        plates = [_row(p) for p in wo.plates]
        items = [(i.id, i.plate_id, i.from_remnant) for i in db.query(WorkItem).filter(WorkItem.work_order_id == wo.id)]
        stock = db.get(Product, wo.mat).stock
    yield no
    with SessionLocal() as db:
        wo = db.query(WorkOrder).filter(WorkOrder.no == no).one()
        _restore(wo, saved)
        db.get(Product, wo.mat).stock = stock
        keep = {row["id"] for row in plates}
        for row in plates:
            plate = db.get(WorkPlate, row["id"])
            if plate is None:
                plate = WorkPlate(id=row["id"], work_order_id=wo.id)
                db.add(plate)
            _restore(plate, row)
        db.flush()
        for item_id, plate_id, remnant in items:
            db.query(WorkItem).filter(WorkItem.id == item_id).update({WorkItem.plate_id: plate_id,
                                                                      WorkItem.from_remnant: remnant})
        for plate in db.query(WorkPlate).filter(WorkPlate.work_order_id == wo.id, WorkPlate.id.notin_(keep)):
            db.delete(plate)
        db.commit()


def work_order(db, no) -> WorkOrder:
    return db.query(WorkOrder).filter(WorkOrder.no == no).one()


def change(fn, no) -> None:
    with SessionLocal() as db:
        fn(db, work_order(db, no))
        db.commit()


def spread(b) -> str:
    """Ein freier Schritt: das erste Teil für sich auf eine neue Platte. Gibt die Marke."""
    source = next(p for p in b["plates"] if len(p["placements"]) > 1)
    part = source["placements"].pop(0)
    w, h = source["fmt"]
    b["plates"].append({"fmt": source["fmt"], "turned": False,
                        "placements": [{**part, "cx": w / 2, "cy": h / 2}]})
    return part["tag"]


def audit_lines(no) -> list[AuditLog]:
    with SessionLocal() as db:
        return (db.query(AuditLog).filter(AuditLog.entity_id == no,
                                          AuditLog.action.in_(("layout_edit", "layout_reset")))
                  .order_by(AuditLog.id).all())


def test_two_saves_at_once_give_one_winner_and_one_consistent_layout(client, scratch, monkeypatch):
    no = scratch
    b = body(layout(client, no))
    spread(b)
    with SessionLocal() as db:
        wo = work_order(db, no)
        stock, plates, parts, rev = db.get(Product, wo.mat).stock, wo.n_plates, wo.n_parts, wo.layout_rev
        moves = db.query(StockMovement).filter(StockMovement.work_order_no == no).count()
    lines = len(audit_lines(no))
    both_validated = threading.Barrier(2, timeout=30)
    monkeypatch.setattr(plate_edit, "_refuse_oversize", lambda *a: both_validated.wait())
    answers = []
    threads = [threading.Thread(target=lambda: answers.append(save(client, no, b).status_code)) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(answers) == [200, 409]
    with SessionLocal() as db:
        wo = work_order(db, no)
        indices = [p.idx for p in wo.plates]
        tags = [i["tag"] for p in wo.plates for i in p.placements]
        assert len(indices) == len(set(indices)) == plates + 1 == wo.n_plates
        assert len(tags) == len(set(tags)) == parts
        assert db.get(Product, wo.mat).stock == stock - 1
        assert db.query(StockMovement).filter(StockMovement.work_order_no == no).count() == moves + 1
        assert wo.layout_rev == rev + 1
    assert len(audit_lines(no)) == lines + 1


def _running(db, wo):
    wo.status = WorkOrderStatus.running


def _staged(db, wo):
    wo.material_staged_at = datetime.now(timezone.utc)


def _plate_reported(db, wo):
    wo.plates[0].status = WorkOrderStatus.done


@pytest.mark.parametrize("meanwhile", [_running, _staged, _plate_reported])
def test_a_status_committed_during_the_save_wins(client, scratch, monkeypatch, meanwhile):
    no = scratch
    data = layout(client, no)
    b = body(data)
    spread(b)
    monkeypatch.setattr(plate_edit, "_refuse_oversize", lambda *a: change(meanwhile, no))
    with SessionLocal() as db:
        wo = work_order(db, no)
        plates, stock, rev = wo.n_plates, db.get(Product, wo.mat).stock, wo.layout_rev
    assert save(client, no, b).status_code == 409
    with SessionLocal() as db:
        wo = work_order(db, no)
        assert (wo.n_plates, db.get(Product, wo.mat).stock, wo.layout_rev, wo.auto_layout) == (plates, stock, rev, None)


@pytest.mark.parametrize("options", [{}, None, {"gap": None, "margin": 8}, {"gap": 3}])
def test_a_plan_without_gap_or_margin_stays_blocked(client, scratch, options):
    no = scratch
    b = body(layout(client, no))
    change(lambda db, wo: setattr(wo, "nest_options", options), no)
    assert layout(client, no)["blocked"]
    assert save(client, no, b).status_code == 409
    url = f"/api/production/work-orders/{no}/layout"
    assert client.post(f"{url}/check", json={"plates": b["plates"]}).status_code == 409
    assert client.post(f"{url}/auto").status_code == 409


def _with_off_centre_hole(db, wo):
    """Teil A trägt ein Loch 80 mm neben der Mitte, Teil B passt hinein."""
    plate = next(p for p in wo.plates if len(p.placements) > 2)
    rows = copy.deepcopy(plate.placements)
    rows[0].update(shape={"outer": {"kind": "rect", "w": 300, "h": 300},
                          "holes": [{"kind": "circle", "d": 90, "x": 80, "y": 0}]}, od=424, di=0)
    rows[1].update(shape=None, od=40, di=0)
    plate.placements = rows


def test_a_guest_the_cutter_cannot_order_is_refused(client, scratch):
    no = scratch
    change(_with_off_centre_hole, no)
    b = body(layout(client, no))
    source = next(p for p in b["plates"] if len(p["placements"]) > 2)
    host, guest = source["placements"][:2]
    del source["placements"][:2]
    host.update(cx=500, cy=500, rot=0)
    guest.update(cx=580, cy=500, rot=0)
    b["plates"].append({"fmt": source["fmt"], "turned": False, "placements": [host, guest]})
    r = save(client, no, b)
    assert r.status_code == 422 and "außermittig" in r.json()["detail"], r.text
    c = client.post(f"/api/production/work-orders/{no}/layout/check", json={"plates": b["plates"]})
    assert not c.json()["valid"] and any("außermittig" in i for i in c.json()["issues"])


def test_a_centred_guest_has_a_host():
    ring = {"tag": "A", "cx": 300, "cy": 300, "rot": 0, "od": 400, "di": 300}
    assert plate_edit._host_issues([ring, {"tag": "B", "cx": 340, "cy": 300, "rot": 0, "od": 100, "di": 0}]) == []


def test_turned_changes_the_version_and_is_not_a_free_choice(client, scratch):
    no = scratch
    data = layout(client, no)
    b = body(data)
    b["plates"][0]["turned"] = True
    r = save(client, no, b)
    assert r.status_code == 422 and "gedreht" in r.json()["detail"]
    change(lambda db, wo: setattr(wo.plates[0], "turned", True), no)
    assert layout(client, no)["version"] != data["version"]


def test_turned_is_accepted_when_the_plan_knows_it(client, scratch):
    no = scratch
    change(lambda db, wo: setattr(wo.plates[0], "turned", True), no)
    data = layout(client, no)
    b = body(data)
    b["plates"][0]["turned"] = False
    r = save(client, no, b)
    assert r.status_code == 200, r.text
    assert r.json()["version"] != data["version"]
    b = body(r.json())
    b["plates"][0]["turned"] = True     # steht jetzt nur noch in der automatischen Lage
    assert save(client, no, b).status_code == 200


def test_a_save_without_a_change_leaves_no_trace(client, scratch):
    no = scratch
    data = layout(client, no)
    lines = len(audit_lines(no))
    r = save(client, no, body(data))
    assert r.status_code == 200 and r.json()["version"] == data["version"]
    assert not r.json()["edited_at"] and not r.json()["has_auto"]
    assert len(audit_lines(no)) == lines


def test_the_audit_line_names_versions_and_moved_tags(client, scratch):
    no = scratch
    data = layout(client, no)
    b = body(data)
    tag = spread(b)
    after = save(client, no, b).json()
    line = audit_lines(no)[-1]
    assert line.action == "layout_edit"
    assert (line.detail["from"], line.detail["to"]) == (data["version"], after["version"])
    assert tag in line.detail["moved"]
    r = client.post(f"/api/production/work-orders/{no}/layout/reset", json={"version": after["version"]})
    assert r.status_code == 200, r.text
    line = audit_lines(no)[-1]
    assert line.action == "layout_reset" and line.detail["from"] == after["version"]
    assert line.detail["to"] == r.json()["version"] and tag in line.detail["moved"]


def test_a_plate_reducing_save_keeps_every_item(client, scratch):
    no = scratch
    start = body(layout(client, no))
    b = copy.deepcopy(start)
    spread(b)
    after = save(client, no, b).json()
    with SessionLocal() as db:
        wo = work_order(db, no)
        items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).count()
        for plate in wo.plates:
            assert plate.items is not None     # geladen: so greift die Kaskade am ehesten
        start["version"] = after["version"]
        plate_edit.save_layout(db, wo, start["plates"], start["version"], "test")
    with SessionLocal() as db:
        wo = work_order(db, no)
        assert db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).count() == items == wo.n_parts
        assert wo.n_plates == len(start["plates"])
        for plate in wo.plates:
            tags = {i["tag"] for i in plate.placements}
            assert {i.tag for i in db.query(WorkItem).filter(WorkItem.plate_id == plate.id)} == tags


@pytest.fixture
def guest(client):
    """Ein Innenauftrag mit einem Gast im Loch und die Marke des Gasts."""
    with SessionLocal() as db:
        item = (db.query(WorkItem).join(WorkOrder, WorkItem.work_order_id == WorkOrder.id)
                  .filter(WorkItem.from_remnant.is_(True), WorkOrder.status == WorkOrderStatus.open,
                          WorkOrder.material_staged_at.is_(None)).first())
        if item is None:
            pytest.skip("kein Gast im Demoplan")
        return db.get(WorkOrder, item.work_order_id).no, item.tag


def test_from_remnant_follows_the_part(client, guest):
    no, tag = guest
    data = layout(client, no)
    b = body(data)
    source = next(p for p in b["plates"] if any(i["tag"] == tag for i in p["placements"]))
    part = next(i for i in source["placements"] if i["tag"] == tag)
    source["placements"].remove(part)
    w, h = source["fmt"]
    b["plates"].append({"fmt": source["fmt"], "turned": False, "placements": [{**part, "cx": w / 2, "cy": h / 2}]})
    r = save(client, no, b)
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        assert db.query(WorkItem).filter(WorkItem.tag == tag, WorkItem.work_order_id == work_order(db, no).id).one().from_remnant is False
    r = client.post(f"/api/production/work-orders/{no}/layout/reset", json={"version": r.json()["version"]})
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        assert db.query(WorkItem).filter(WorkItem.tag == tag, WorkItem.work_order_id == work_order(db, no).id).one().from_remnant is True


def test_metrics_reproduce_every_stored_plate(client):
    with SessionLocal() as db:
        plates = 0
        for wo in db.query(WorkOrder).all():
            for plate in wo.plates:
                m = plate_metrics(plate_edit._window(wo, plate.fmt), plate.placements, bool(plate.turned))
                assert m["utilisation"] == pytest.approx(plate.utilisation, abs=1e-5), (wo.no, plate.idx)
                assert m["used_h"] == pytest.approx(plate.used_h, abs=0.01), (wo.no, plate.idx)
                plates += 1
        assert plates


def test_the_corner_limit_means_what_it_means_in_the_nester():
    ring = {"tag": "A", "cx": 100, "cy": 100, "rot": 0, "od": 100, "di": 0}
    assert check_plate(Window(1000, 1000, corner_max=212.2), [ring])["valid"]
    assert "Nullecke" in check_plate(Window(1000, 1000, corner_max=212), [ring])["issues"][0]
    assert check_plate(Window(1000, 1000, corner_max=None), [ring])["valid"]
    assert check_plate(Window(1000, 1000, corner_max=0.0), [ring])["valid"]    # 0 ist unbekannt
    assert check_plate(Window(1000, 1000, trim_w=20, trim_h=20, corner_max=199), [ring])["valid"]


def test_a_stored_corner_limit_is_enforced(client, scratch):
    no = scratch
    b = body(layout(client, no))
    spread(b)

    def tight(db, wo):
        wo.nest_options = {**wo.nest_options, "corner_max_dist": 50.0}
    change(tight, no)
    assert layout(client, no)["corner_max"] == 50.0
    r = save(client, no, b)
    assert r.status_code == 422 and "Nullecke" in r.json()["detail"]


def test_without_a_stored_limit_corner_max_is_null(client, scratch):
    assert layout(client, scratch)["corner_max"] is None


def _assign(no, **values) -> None:
    def assign(db, wo):
        st = db.query(FactoryStation).filter(FactoryStation.type == "production").first()
        for key, value in values.items():
            setattr(st, key, value)
        wo.station_id = st.id
        wo.planned_min = 1.0
    change(assign, no)


@pytest.fixture
def station():
    with SessionLocal() as db:
        st = db.query(FactoryStation).filter(FactoryStation.type == "production").first()
        saved = _row(st)
    yield
    with SessionLocal() as db:
        _restore(db.get(FactoryStation, saved["id"]), saved)
        db.commit()


def test_planned_minutes_follow_the_plates(client, scratch, station):
    no = scratch
    _assign(no, speed_mm_s=100.0, handling_min_per_plate=7.0, max_sheet_w=0.0, max_sheet_h=0.0, thk_min=0.0, thk_max=0.0)
    b = body(layout(client, no))
    spread(b)
    r = save(client, no, b)
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        wo = work_order(db, no)
        assert wo.planned_min > 7.0 * wo.n_plates - 1e-6
        first = wo.planned_min
    r = client.post(f"/api/production/work-orders/{no}/layout/reset", json={"version": r.json()["version"]})
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        assert work_order(db, no).planned_min == pytest.approx(first - 7.0)


def test_a_plate_that_leaves_the_table_is_refused(client, scratch, station):
    no = scratch
    _assign(no, speed_mm_s=100.0, max_sheet_w=100.0, max_sheet_h=100.0)
    b = body(layout(client, no))
    spread(b)
    r = save(client, no, b)
    assert r.status_code == 422 and "Tisch" in r.json()["detail"]


def test_without_a_station_the_planned_minutes_stay(client, scratch):
    no = scratch
    change(lambda db, wo: setattr(wo, "planned_min", 5.5), no)
    b = body(layout(client, no))
    spread(b)
    assert save(client, no, b).status_code == 200
    with SessionLocal() as db:
        assert work_order(db, no).planned_min == 5.5


def test_reset_may_bring_back_retired_formats_and_rotations(client, scratch):
    no = scratch
    b = body(layout(client, no))
    spread(b)
    after = save(client, no, b).json()

    def retire(db, wo):
        snapshot = copy.deepcopy(wo.auto_layout)
        snapshot["plates"][0]["fmt"] = [4321.0, 4321.0]
        snapshot["plates"][0]["placements"][0]["rot"] = 37.0
        wo.auto_layout = snapshot
    change(retire, no)
    r = client.post(f"/api/production/work-orders/{no}/layout/reset", json={"version": after["version"]})
    assert r.status_code == 200, r.text
    assert r.json()["plates"][0]["fmt"] == [4321.0, 4321.0]


def test_reset_still_checks_parts_and_geometry(client, scratch):
    no = scratch
    b = body(layout(client, no))
    spread(b)
    after = save(client, no, b).json()
    url = f"/api/production/work-orders/{no}/layout/reset"

    def drop(db, wo):
        nonlocal spare
        snapshot = copy.deepcopy(wo.auto_layout)
        spare = snapshot["plates"][0]["placements"].pop()["tag"]
        wo.auto_layout = snapshot
    spare = ""
    change(drop, no)
    r = client.post(url, json={"version": after["version"]})
    assert r.status_code == 422 and "fehlen" in r.json()["detail"]

    def off_the_plate(db, wo):
        snapshot = copy.deepcopy(wo.auto_layout)
        snapshot["plates"][0]["placements"].append({"tag": spare, "cx": -500.0, "cy": 0.0, "rot": 0.0})
        wo.auto_layout = snapshot
    change(off_the_plate, no)
    r = client.post(url, json={"version": after["version"]})
    assert r.status_code == 422 and "Nutzfläche" in r.json()["detail"]


def test_auto_refuses_mirrored_parts(client, scratch):
    no = scratch

    def mirror(db, wo):
        rows = copy.deepcopy(wo.plates[0].placements)
        rows[0]["mirror"] = True
        wo.plates[0].placements = rows
    change(mirror, no)
    r = propose(client, no)
    assert r.status_code == 409 and "gespiegelt" in r.json()["detail"]


def test_auto_stays_out_of_a_running_batch(client, no):
    with batch_runner._run_lock:    # dieser Faden; die Anfrage läuft in einem anderen
        r = client.post(f"/api/production/work-orders/{no}/layout/auto")
    assert r.status_code == 409 and "Sammellauf" in r.json()["detail"]


def test_auto_always_has_a_budget_and_uses_the_stored_limit(scratch, monkeypatch):
    base = SimpleNamespace(max_ms=None, max_candidates=None, corner_max_dist=999.0)
    monkeypatch.setattr(plate_edit, "options_resolver", lambda db: lambda m, t: base)
    with SessionLocal() as db:
        wo = work_order(db, scratch)
        wo.nest_options = {**wo.nest_options, "corner_max_dist": 700.0}
        fixed = plate_edit._fixed_options(db, wo)("", 0)
        db.rollback()
    assert fixed.max_ms == batch_runner.STANDALONE_NEST_MS
    assert fixed.corner_max_dist == 700.0 and fixed.allow_mirror is False


def _stack(n: int) -> list[dict]:
    return [{"tag": f"T{i}", "cx": 200, "cy": 200, "rot": 0, "od": 100, "di": 0} for i in range(n)]


def test_verify_stops_early_only_when_asked():
    rings = [[[0, 0], [10, 0], [10, 10], [0, 10]]]
    job = {"sheet": {"width": 100, "height": 100}, "spacing": 1, "margin": 0,
           "parts": [{"id": "A", "quantity": 8, "outer": rings[0], "holes": []}]}
    result = {"placements": [{"partIndex": 0, "partId": "A", "instance": i, "sheet": 0, "tx": 50, "ty": 50, "rotation": 0}
                             for i in range(8)]}
    assert len(kerf.verify(job, result)["issues"]) == 28
    stopped = kerf.verify(job, result, 3)
    assert len(stopped["issues"]) == 3 and stopped["pairsChecked"] == 3 and not stopped["valid"]


def test_check_plate_stops_at_the_limit():
    assert len(check_plate(Window(1000, 1000), _stack(12), 40)["issues"]) == 40


def test_the_check_route_reports_at_most_forty_issues(client, scratch):
    no = scratch
    b = body(layout(client, no))
    for plate in b["plates"]:
        for part in plate["placements"]:
            part.update(cx=300, cy=300)
    assert sum(len(p["placements"]) for p in b["plates"]) >= 2
    r = client.post(f"/api/production/work-orders/{no}/layout/check", json={"plates": b["plates"]})
    assert r.status_code == 200 and not r.json()["valid"] and len(r.json()["issues"]) <= 40
    assert len(r.json()["plates"]) == len(b["plates"])


def test_only_one_check_at_a_time(client, no):
    b = body(layout(client, no))
    with plate_edit._check_lock:
        r = client.post(f"/api/production/work-orders/{no}/layout/check", json={"plates": b["plates"]})
    assert r.status_code == 409 and "Prüfung" in r.json()["detail"]


def test_a_huge_body_is_refused_before_it_is_parsed(client, no):
    url = f"/api/production/work-orders/{no}/layout"
    huge = b"x" * (MAX_BODY_BYTES + 1)
    head = {"content-type": "application/json"}
    assert client.put(url, content=huge, headers=head).status_code == 413
    assert client.post(f"{url}/check", content=huge, headers=head).status_code == 413

    def chunks():
        for _ in range(3):
            yield b"x" * (MAX_BODY_BYTES // 2)
    assert client.put(url, content=chunks(), headers=head).status_code == 413


def issued(client, no):
    return layout(client, no)["files_issued_at"]


@pytest.mark.parametrize("path", ["plate/0.dxf", "cutfiles.zip"])
def test_the_first_download_marks_the_files_as_issued(client, scratch, path):
    no = scratch
    change(lambda db, wo: setattr(wo, "cut_files_issued_at", None), no)
    with SessionLocal() as db:
        lines = db.query(AuditLog).count()
    assert issued(client, no) is None
    r = client.get(f"/api/production/work-orders/{no}/{path}")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    first = issued(client, no)
    assert first
    time.sleep(0.01)
    assert client.get(f"/api/production/work-orders/{no}/{path}").status_code == 200
    assert issued(client, no) == first
    with SessionLocal() as db:
        assert db.query(AuditLog).count() == lines

    b = body(layout(client, no))     # Speichern bleibt erlaubt und löscht nichts
    spread(b)
    r = save(client, no, b)
    assert r.status_code == 200 and r.json()["files_issued_at"] == first


def test_a_failing_mark_does_not_fail_the_download():
    class Broken:
        def query(self, *a):
            raise RuntimeError("database is locked")

        def rollback(self):
            raise RuntimeError("database is locked")

    cutfiles.mark_issued(Broken(), [SimpleNamespace(id=1, cut_files_issued_at=None)])


def test_the_mailed_report_marks_its_files_as_issued(client, scratch, monkeypatch):
    no = scratch
    change(lambda db, wo: setattr(wo, "cut_files_issued_at", None), no)
    monkeypatch.setattr(batch_report, "enabled", lambda: True)
    monkeypatch.setattr(batch_report, "recipients", lambda: ["ops@example.test"])
    monkeypatch.setattr(smtp_client, "send", lambda **k: False)
    with SessionLocal() as db:
        run = db.get(NestRun, work_order(db, no).run_id)
        batch_report.send_run_report(db, run, background=False)
    assert issued(client, no) is None
    monkeypatch.setattr(smtp_client, "send", lambda **k: True)
    with SessionLocal() as db:
        run = db.get(NestRun, work_order(db, no).run_id)
        assert batch_report.send_run_report(db, run, background=False) is True
    assert issued(client, no)


def test_every_file_names_its_layout_revision(client, scratch):
    no = scratch
    b = body(layout(client, no))
    with SessionLocal() as db:
        rev = work_order(db, no).layout_rev + 1
    spread(b)
    assert save(client, no, b).status_code == 200
    base = f"/api/production/work-orders/{no}"
    r = client.get(f"{base}/plate/0.dxf")
    assert f"-Stand-{rev}" in r.headers["content-disposition"] and f"Stand {rev}" in r.text
    r = client.get(f"{base}/cutfiles.zip")
    assert f"-Stand-{rev}" in r.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        name = next(n for n in z.namelist() if "/1-Vollplatte/" in n)
        assert f"-Stand-{rev}" in name and f"Stand {rev}" in z.read(name).decode()
    assert f"Stand {rev}" in client.get(f"{base}/plate/0.svg").text


def test_a_small_gap_stays_a_gap():
    w = Window(1000, 1000, gap=0.2, margin=5)
    a = {"tag": "A", "cx": 100, "cy": 100, "rot": 0, "od": 100, "di": 0}
    assert not check_plate(w, [a, {**a, "tag": "B", "cx": 200.05}])["valid"]
    assert check_plate(w, [a, {**a, "tag": "B", "cx": 200.15}])["valid"]


def _square(tag: str, cx: float) -> dict:
    return {"tag": tag, "cx": cx, "cy": 100, "rot": 0, "od": 142, "di": 0,
            "shape": {"outer": {"kind": "rect", "w": 100, "h": 100}, "holes": []}}


def test_straight_edges_get_no_chord_tolerance():
    w = Window(1000, 1000, gap=5, margin=5)
    assert CHORD_TOLERANCE > 0.1
    assert not check_plate(w, [_square("A", 100), _square("B", 204.9)])["valid"]
    assert check_plate(w, [_square("A", 100), _square("B", 204.995)])["valid"]


def test_a_pair_with_a_curved_edge_keeps_the_tolerance_on_a_mixed_plate():
    w = Window(1000, 1000, gap=5, margin=5)
    ring = {"tag": "R", "cx": 100, "cy": 300, "rot": 0, "od": 100, "di": 0}
    near_ring = _square("C", 204.9) | {"cy": 300}
    assert check_plate(w, [ring, near_ring])["valid"]
    assert not check_plate(w, [ring, _square("A", 100), _square("B", 204.9)])["valid"]
