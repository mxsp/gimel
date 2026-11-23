"""A combined run in the background: the answer comes at once, the result later."""

from __future__ import annotations

import time

import pytest

from gimel.db import SessionLocal
from gimel.models import NestRun, Order, User, WorkItem, WorkOrder, WorkPlate
from gimel.schemas import QuoteLine
from gimel.services import batch_runner, settings_store
from gimel.services.orders import place_order


def wait(client, job_id: str) -> dict:
    for _ in range(600):
        job = client.get(f"/api/production/runs/jobs/{job_id}").json()
        if job["status"] != "running":
            return job
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def test_a_run_starts_in_the_background_and_reports_its_result(client):
    r = client.post("/api/production/runs/start")
    assert r.status_code == 202
    job = wait(client, r.json()["id"])
    assert job["status"] == "done"
    with SessionLocal() as db:
        assert db.query(NestRun).filter(NestRun.no == job["run"]["no"]).count() == 1


def test_an_unknown_job_is_404(client):
    assert client.get("/api/production/runs/jobs/nope").status_code == 404


def test_a_failed_run_says_why(client, monkeypatch):
    def fail(*a, **k):
        raise RuntimeError("Platte klemmt")

    monkeypatch.setattr("gimel.services.run_jobs.run_batch", fail)
    job = wait(client, client.post("/api/production/runs/start").json()["id"])
    assert (job["status"], job["error"]) == ("failed", "Platte klemmt")


def test_a_kerf_run_is_labelled_and_the_preview_stays_on_lite(client, monkeypatch):
    seen = []
    real = batch_runner.plan_batch
    monkeypatch.setattr(batch_runner, "plan_batch",
                        lambda *a, **k: seen.append(k["engine"]) or real(*a, **k))
    with SessionLocal() as db:
        settings_store.set_value(db, "nesting_engine", "kerf", actor="test")
        db.commit()
    assert client.get("/api/production/queue").status_code == 200
    assert seen == ["lite"]
    with SessionLocal() as db:
        assert batch_runner.nesting_engine(db) == "kerf"
    assert batch_runner._engine_label("kerf").startswith("kerf-")


def test_hashed_assets_are_cached_for_good_and_compressed(client):
    html = client.get("/app/").text
    asset = next(part.split('"')[0] for part in html.split('src="')[1:] if "/assets/" in part)
    r = client.get(asset, headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert "immutable" in r.headers["cache-control"]
    assert r.headers["content-encoding"] == "gzip"


@pytest.fixture
def bucket():
    """Eine eigene wartende Bestellung: andere Tests leeren die Warteschlange."""
    with SessionLocal() as db:
        known = {no for (no,) in db.query(Order.no)}
        customer = db.query(User).filter(User.email == "einkauf1@musterwerk.example").one()
        address = {"company": "Test GmbH", "street": "Weg 1", "zip": "99999", "city": "Ort", "country": "DE"}
        place_order(db, lines=[QuoteLine(id=1, mat="epdm-70", thk=7, label="Ring", od=100, di=50, q=4)],
                    cert="", ship_address=address, bill_address=address, tax_status={"rate": 0.19},
                    customer_ref="T-26", user=customer, released=True)
        db.commit()
    yield "epdm-70", 7.0
    with SessionLocal() as db:
        fresh = db.query(Order).filter(Order.no.notin_(known)).all()
        made = {i.work_order_id for i in db.query(WorkItem).filter(
            WorkItem.order_no.in_([o.no for o in fresh]))}
        for model, column in ((WorkItem, WorkItem.work_order_id), (WorkPlate, WorkPlate.work_order_id),
                              (WorkOrder, WorkOrder.id)):
            db.query(model).filter(column.in_(made)).delete(synchronize_session=False)
        for order in fresh:
            db.delete(order)
        db.commit()


def test_the_queue_says_which_rule_and_clock_decide(client, bucket):
    q = client.get("/api/production/queue").json()
    entry = next(b for b in q["held"] + q["ready"] if (b["mat"], b["thk"]) == bucket)
    assert entry["rule"]["source"] == "global"
    assert entry["rule"]["min_parts"] == q["policy"]["min_parts"]
    assert entry["release_by"] in ("age", "due", None)


def test_the_queue_names_customers_for_nest_now(client, bucket):
    q = client.get("/api/production/queue").json()
    assert q["customers"] and all({"id", "name", "n_parts", "n_orders"} <= set(c) for c in q["customers"])
    entry = next(b for b in q["held"] + q["ready"] if (b["mat"], b["thk"]) == bucket)
    assert entry["customer_id"] is not None
    assert entry["customer"]


def test_start_run_rejects_an_unknown_customer_grouping(client):
    r = client.post("/api/production/runs/start", json={"group_by": "irgendwas"})
    assert r.status_code == 422


def test_the_forecast_of_a_bucket_saves_nothing(client, bucket):
    mat, thk = bucket
    with SessionLocal() as db:
        runs = db.query(NestRun).count()
    r = client.get("/api/production/queue/bucket", params={"mat": mat, "thk": thk})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_plates"] == len(body["plates"]) > 0 and body["orders"]
    svg = client.get("/api/production/queue/bucket/plate/0.svg", params={"mat": mat, "thk": thk})
    assert svg.status_code == 200 and "<svg" in svg.text
    assert client.get("/api/production/queue/bucket/plate/999.svg",
                      params={"mat": mat, "thk": thk}).status_code == 404
    assert client.get("/api/production/queue/bucket",
                      params={"mat": "gibtsnicht", "thk": 1}).status_code == 404
    with SessionLocal() as db:
        assert db.query(NestRun).count() == runs


def test_an_empty_bucket_list_never_means_everything(client):
    assert client.post("/api/production/runs/start", json={"buckets": []}).status_code == 422


def test_a_run_for_one_bucket_touches_only_that_bucket(client, bucket):
    mat, thk = bucket
    with SessionLocal() as db:
        others = [p.position_id for p in batch_runner.collect_pending(db)
                  if (p.mat, float(p.thk)) != (mat, thk)]
    r = client.post("/api/production/runs/start", json={"buckets": [{"mat": mat, "thk": thk}]})
    assert r.status_code == 202, r.text
    job = wait(client, r.json()["id"])
    assert job["status"] == "done", job
    assert job["run"]["trigger"] == "auswahl"
    with SessionLocal() as db:
        pending = batch_runner.collect_pending(db)
        assert not [p for p in pending if (p.mat, float(p.thk)) == (mat, thk)]
        assert others == [p.position_id for p in pending]

    again = client.post("/api/production/runs/start", json={"buckets": [{"mat": mat, "thk": thk}]})
    job = wait(client, again.json()["id"])
    assert job["status"] == "failed" and "wartet nichts mehr" in job["error"]


def test_a_targeted_run_does_not_ride_on_a_running_one(client):
    from gimel.services import run_jobs
    run_jobs._jobs["busy"] = {"id": "busy", "status": "running", "run": None, "error": ""}
    try:
        r = client.post("/api/production/runs/start", json={"buckets": [{"mat": "x", "thk": 1}]})
        assert r.status_code == 409
        assert client.post("/api/production/runs/start").json()["id"] == "busy"
    finally:
        del run_jobs._jobs["busy"]


def test_a_rule_preview_shows_the_effect_and_writes_nothing(client, bucket):
    from gimel.models import BatchPolicy
    body = {"mat": bucket[0], "thk": bucket[1], "mode": "sofort"}
    r = client.post("/api/production/policies/preview", json=body)
    assert r.status_code == 200, r.text
    assert r.json() and all(c["after"] == "bereit" for c in r.json())
    with SessionLocal() as db:
        assert db.query(BatchPolicy).count() == 0
    assert client.post("/api/production/policies/preview",
                       json={**body, "min_utilisation": 7}).status_code == 422
