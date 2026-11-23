"""Freies Schachteln: ein Lauf ohne Auftrag, wiederholbar, geprüft und ohne Folgen für den Plan."""

from __future__ import annotations

import threading
import time

import pytest

from gimel.db import Base, SessionLocal
from gimel.models import AuditLog, Drawing, Role, User
from gimel.security import create_access_token
from gimel.services import free_nesting as fn

RING = "0,0 100,0 100,100 0,100\n\n30,30 70,30 70,70 30,70"


@pytest.fixture(autouse=True)
def quiet():
    yield
    for r in list(fn._runs.values()):                     # nichts läuft in den nächsten Test hinein
        r["_stop"].set()
    end = time.time() + 60
    while any(r["status"] in fn.ACTIVE for r in fn._runs.values()) and time.time() < end:
        time.sleep(0.05)
    with SessionLocal() as db:
        db.query(Drawing).delete()
        db.commit()


def make(client, text: str = "0,0 60,0 60,40 0,40", name: str = "Teil") -> int:
    r = client.post("/api/drawings", json={"name": name, "text": text})
    assert r.status_code == 200, r.text
    return r.json()["created"][0]["id"]


def spec(parts, **over) -> dict:
    base = {"sheet_w": 400, "sheet_h": 300, "spacing": 5, "margin": 5, "stock": 0, "rotations": "90",
            "gravity": "left", "quality": "manual", "cell": 10, "max_steps": 12, "stall": 0, "seed": 7,
            "refine": False, "parts": parts}
    return {**base, **over}


def wait(client, run_id: str, timeout: float = 90) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        r = client.get(f"/api/free-nesting/runs/{run_id}")
        assert r.status_code == 200, r.text
        if r.json()["status"] not in fn.ACTIVE:
            return r.json()
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def run(client, body: dict) -> dict:
    r = client.post("/api/free-nesting/runs", json=body)
    assert r.status_code == 200, r.text
    return wait(client, r.json()["id"])


def lines(action: str) -> int:
    with SessionLocal() as db:
        return db.query(AuditLog).filter(AuditLog.action == action).count()


def snapshot() -> dict:
    """Zeilenzahl jeder Tabelle außer Protokoll und Zeichnungen."""
    with SessionLocal() as db:
        return {t.name: db.query(t).count() for t in Base.metadata.sorted_tables
                if t.name not in ("audit_log", "drawings")}


def placements(res: dict) -> list:
    return [(p["partIndex"], p["instance"], p["sheet"], p["rotation"], p["tx"], p["ty"])
            for p in res["layout"]["placements"]]


# ------------------------------------------------------------------ the run
def test_a_run_finishes_with_a_verified_layout_and_its_numbers(client):
    a, b = make(client), make(client, RING, "Ring")
    res = run(client, spec([{"drawing_id": a, "qty": 6}, {"drawing_id": b, "qty": 2}]))
    assert res["status"] == "done", res
    assert res["verify"]["valid"] is True and res["exportable"] is True
    stats = res["layout"]["stats"]
    assert stats["placed"] == 8 and stats["total"] == 8 and not res["layout"]["unplaced"]
    assert stats["iterations"] <= 12
    assert {p["id"] for p in res["parts"]} == {str(a), str(b)}
    assert "kein Fertigungsauftrag" in res["notice"]
    assert res["job"]["maxSteps"] == 12 and res["job"]["seed"] == 7


def test_the_same_seed_and_steps_give_the_same_layout(client):
    a, b = make(client), make(client, "0,0 50,0 25,45", "Dreieck")
    body = spec([{"drawing_id": a, "qty": 7}, {"drawing_id": b, "qty": 5}], max_steps=15)
    first, second = run(client, body), run(client, body)
    assert placements(first) == placements(second)
    assert first["layout"]["stats"]["iterations"] == second["layout"]["stats"]["iterations"]
    other = run(client, {**body, "seed": 99})
    assert other["status"] == "done"                      # eine andere Zahl darf eine andere Lage geben


def test_a_second_run_while_one_is_active_is_409(client, monkeypatch):
    release = threading.Event()
    real = fn.kerf.nest

    def slow(job, on_progress=None, clock=None):
        release.wait(30)
        return real(job, on_progress, clock)

    monkeypatch.setattr(fn.kerf, "nest", slow)
    a = make(client)
    body = spec([{"drawing_id": a, "qty": 2}])
    first = client.post("/api/free-nesting/runs", json=body)
    assert first.status_code == 200
    second = client.post("/api/free-nesting/runs", json=body)
    assert second.status_code == 409 and "läuft schon" in second.json()["detail"]
    release.set()
    assert wait(client, first.json()["id"])["status"] == "done"
    assert client.post("/api/free-nesting/runs", json=body).status_code == 200      # frei, sobald fertig


def test_stop_keeps_the_best_layout_so_far_and_checks_it(client):
    a = make(client)
    body = spec([{"drawing_id": a, "qty": 60}], max_steps=1000, sheet_w=1500, sheet_h=1000)
    r = client.post("/api/free-nesting/runs", json=body)
    rid = r.json()["id"]
    for _ in range(400):                                   # warten, bis eine Lage da ist
        if client.get(f"/api/free-nesting/runs/{rid}").json()["rev"] > 0:
            break
        time.sleep(0.05)
    client.post(f"/api/free-nesting/runs/{rid}/stop")
    res = wait(client, rid)
    assert res["status"] == "stopped"
    assert res["layout"]["stats"]["iterations"] < 1000
    assert res["verify"] and res["verify"]["valid"]
    assert res["reproducible"] is False
    assert lines("free_nesting_stop") >= 1


def test_the_hard_limit_ends_the_run_with_the_best_so_far(client, monkeypatch):
    monkeypatch.setattr(fn, "HARD_LIMIT_S", 0.0)
    a = make(client)
    res = run(client, spec([{"drawing_id": a, "qty": 30}], max_steps=1000, sheet_w=1500, sheet_h=1000))
    assert res["status"] == "timeout" and res["layout"] and res["verify"]["valid"]


def test_progress_polls_skip_the_layout_when_nothing_changed(client):
    a = make(client)
    res = run(client, spec([{"drawing_id": a, "qty": 3}]))
    again = client.get(f"/api/free-nesting/runs/{res['id']}?rev={res['rev']}").json()
    assert "layout" not in again and again["status"] == "done"
    assert "layout" in client.get(f"/api/free-nesting/runs/{res['id']}?rev=0").json()


def test_a_part_larger_than_the_sheet_stays_unplaced_and_is_reported(client):
    big = make(client, "0,0 900,0 900,50 0,50", "Zu lang")
    ok = make(client)
    res = run(client, spec([{"drawing_id": big, "qty": 1}, {"drawing_id": ok, "qty": 2}]))
    assert len(res["layout"]["unplaced"]) == 1 and res["layout"]["stats"]["placed"] == 2


# ------------------------------------------------------------------ limits
def test_limits_are_enforced_before_a_thread_starts(client):
    a = make(client)
    one = [{"drawing_id": a, "qty": 1}]
    post = lambda body: client.post("/api/free-nesting/runs", json=body)       # noqa: E731
    assert "2000" in post(spec([{"drawing_id": a, "qty": 2001}])).json()["detail"]
    assert "Mehr als 2000" in post(spec([{"drawing_id": a, "qty": 1500}, {"drawing_id": make(client), "qty": 600}])).json()["detail"]
    assert post(spec(one, max_steps=1001)).status_code == 422
    assert post(spec(one, max_steps=0)).status_code == 422
    assert post(spec(one, sheet_w=10)).status_code == 422
    assert post(spec(one, margin=200)).status_code == 422
    assert post(spec(one, rotations="7")).status_code == 422
    assert post(spec(one, seed=0)).status_code == 422
    assert post(spec([{"drawing_id": a, "qty": 0}])).json()["detail"] == "Alle Mengen sind 0."
    assert post(spec([{"drawing_id": 999999, "qty": 1}])).status_code == 404
    assert post(spec([])).status_code == 422
    assert post(spec(one, quality="manual", cell=0.01)).status_code == 422
    assert post(spec(one, sheet_w=10000, sheet_h=10000, quality="manual", cell=1)).status_code == 422
    assert fn.MAX_TYPES == 200 and fn.MAX_INSTANCES == 2000 and fn.MAX_STEPS == 1000 and fn.HARD_LIMIT_S == 60


def test_more_than_200_part_types_are_refused(client):
    ids = []
    with SessionLocal() as db:
        for i in range(201):
            d = Drawing(name=f"T{i}", source="points", outer=[[0, 0], [10, 0], [10, 10], [0, 10]], holes=[],
                        width=10, height=10, area=100, cut_len=40)
            db.add(d)
            db.flush()
            ids.append(d.id)
        db.commit()
    r = client.post("/api/free-nesting/runs", json=spec([{"drawing_id": i, "qty": 1} for i in ids]))
    assert r.status_code == 422 and "200 Teilearten" in r.json()["detail"]
    assert client.post("/api/free-nesting/runs", json=spec([{"drawing_id": i, "qty": 1} for i in ids[:200]])
                       ).status_code == 200


def test_the_default_budget_is_steps_not_time(client):
    a = make(client)
    body = spec([{"drawing_id": a, "qty": 2}])
    body["max_steps"] = None
    res = run(client, body)
    assert res["job"]["maxSteps"] and res["job"].get("timeLimit") is None


# ------------------------------------------------------------------ nothing else is touched
def test_a_run_writes_nothing_to_orders_plates_stock_or_the_plan(client):
    a = make(client)
    before = snapshot()
    res = run(client, spec([{"drawing_id": a, "qty": 5}]))
    client.get(f"/api/free-nesting/runs/{res['id']}/export?format=json")
    client.get(f"/api/free-nesting/runs/{res['id']}/export?format=dxf&sheet=1")
    assert snapshot() == before
    assert "work_orders" in before and "orders" in before and "work_plates" in before


def test_start_and_export_leave_audit_lines(client):
    a = make(client)
    starts, exports = lines("free_nesting_start"), lines("free_nesting_export")
    res = run(client, spec([{"drawing_id": a, "qty": 2}]))
    assert lines("free_nesting_start") == starts + 1
    client.get(f"/api/free-nesting/runs/{res['id']}/export?format=svg")
    assert lines("free_nesting_export") == exports + 1
    client.get(f"/api/free-nesting/runs/{res['id']}")
    assert lines("free_nesting_export") == exports + 1, "reads leave no line"
    assert client.get("/api/free-nesting/runs/nope/export?format=svg").status_code == 404
    assert lines("free_nesting_export") == exports + 1, "a miss leaves no line"


# ------------------------------------------------------------------ the verify gate
def test_an_invalid_layout_is_never_offered_for_export(client, monkeypatch):
    monkeypatch.setattr(fn.kerf, "verify", lambda job, result, max_issues=None: {
        "valid": False, "issues": ["Teil#0 overlaps Teil#1"], "minGap": 0, "minSlack": -5, "pairsChecked": 1})
    a = make(client)
    res = run(client, spec([{"drawing_id": a, "qty": 3}]))
    assert res["status"] == "done" and res["verify"]["valid"] is False
    assert res["exportable"] is False
    for q in ("format=dxf&sheet=1", "format=svg", "format=json"):
        r = client.get(f"/api/free-nesting/runs/{res['id']}/export?{q}")
        assert r.status_code == 409 and "nicht zum Export freigegeben" in r.json()["detail"]


def test_a_running_run_cannot_be_exported(client, monkeypatch):
    release = threading.Event()
    real = fn.kerf.nest
    monkeypatch.setattr(fn.kerf, "nest", lambda j, p=None, c=None: (release.wait(30), real(j, p, c))[1])
    a = make(client)
    rid = client.post("/api/free-nesting/runs", json=spec([{"drawing_id": a, "qty": 2}])).json()["id"]
    assert client.get(f"/api/free-nesting/runs/{rid}/export?format=json").status_code == 409
    release.set()
    wait(client, rid)


# ------------------------------------------------------------------ files
def test_exports_are_labelled_as_free_nesting_and_cover_every_sheet(client):
    a, b = make(client), make(client, RING, "Ring")
    res = run(client, spec([{"drawing_id": a, "qty": 20}, {"drawing_id": b, "qty": 3}], sheet_w=300, sheet_h=200,
                           max_steps=10))
    rid, n = res["id"], res["layout"]["stats"]["sheetsUsed"]
    assert n >= 2

    dxf = client.get(f"/api/free-nesting/runs/{rid}/export?format=dxf&sheet=2")
    assert dxf.status_code == 200 and "attachment" in dxf.headers["content-disposition"]
    assert "platte2.dxf" in dxf.headers["content-disposition"]
    assert "FREIES SCHACHTELN - KEIN FERTIGUNGSAUFTRAG" in dxf.text
    assert "KONTUR" in dxf.text and "PLATTE" in dxf.text and "INFO" in dxf.text
    import ezdxf
    import io
    doc = ezdxf.read(io.StringIO(dxf.text))
    assert len([e for e in doc.modelspace() if e.dxftype() == "POLYLINE"]) >= 2
    assert client.get(f"/api/free-nesting/runs/{rid}/export?format=dxf&sheet={n + 1}").status_code == 404

    svg = client.get(f"/api/free-nesting/runs/{rid}/export?format=svg")
    assert svg.status_code == 200 and svg.headers["content-type"].startswith("image/svg+xml")
    assert "kein Fertigungsauftrag" in svg.text and svg.text.count("data-sheet=") == n
    import xml.etree.ElementTree as ET
    ET.fromstring(svg.text)

    js = client.get(f"/api/free-nesting/runs/{rid}/export?format=json").json()
    assert js["kind"] == "free-nesting" and "kein Fertigungsauftrag" in js["notice"]
    assert js["verify"]["valid"] and js["result"]["stats"]["placed"] == 23


def test_layer_names_follow_the_prefix():
    from gimel.config import ENV_PREFIX
    from gimel.render import dxf
    assert dxf.LAYER_OUTER.startswith(ENV_PREFIX)


# ------------------------------------------------------------------ access
def test_workers_and_anonymous_users_are_kept_out(client):
    from fastapi.testclient import TestClient

    from gimel.app import create_app

    with SessionLocal() as db:
        u = db.query(User).filter(User.email == "halle2@example.test").first()
        if u is None:
            u = User(email="halle2@example.test", name="Halle", role=Role.worker, password_hash="x")
            db.add(u)
            db.commit()
        head = {"Authorization": f"Bearer {create_access_token(u)}"}
    assert client.post("/api/free-nesting/runs", json=spec([]), headers=head).status_code == 403
    assert client.get("/api/free-nesting/runs/x", headers=head).status_code == 403
    assert client.post("/api/free-nesting/runs/x/stop", headers=head).status_code == 403
    assert client.get("/api/free-nesting/runs/x/export", headers=head).status_code == 403
    with TestClient(create_app()) as anon:
        assert anon.get("/api/free-nesting/runs/x").status_code == 401


def _insert(n_points: int, count: int = 1) -> list[int]:
    """Rows straight into the table: the API would simplify or refuse what we want to meet at run start."""
    import math
    ring = [[round(50 + 50 * math.cos(2 * math.pi * i / n_points), 4), round(50 + 50 * math.sin(2 * math.pi * i / n_points), 4)]
            for i in range(n_points)]
    ids = []
    with SessionLocal() as db:
        for i in range(count):
            d = Drawing(name=f"K{n_points}-{i}", source="points", outer=ring, holes=[], width=100, height=100,
                        area=7800, cut_len=314)
            db.add(d)
            db.flush()
            ids.append(d.id)
        db.commit()
    return ids


def test_a_part_type_with_too_many_edges_is_refused_at_start(client, monkeypatch):
    monkeypatch.setattr(fn, "start", lambda job, actor: {"id": "stub"})          # only the start caps are under test
    (big,) = _insert(1501)
    r = client.post("/api/free-nesting/runs", json=spec([{"drawing_id": big, "qty": 1}]))
    assert r.status_code == 422 and "1500" in r.json()["detail"] and "Kanten" in r.json()["detail"]
    (ok,) = _insert(1500)
    assert client.post("/api/free-nesting/runs", json=spec([{"drawing_id": ok, "qty": 1}], rotations="0")).status_code == 200
    assert fn.MAX_EDGES_PER_TYPE == 1500 and fn.MAX_WORK_EDGES == 2_000_000 and fn.MAX_EDGES_TOTAL == 400_000


def test_edges_times_quantity_is_capped_over_the_whole_run(client, monkeypatch):
    """The brief's example (2000 x 1500 edges) is 3 M, far over the 400,000 cap; these are the boundaries."""
    monkeypatch.setattr(fn, "start", lambda job, actor: {"id": "stub"})
    (e1500,) = _insert(1500)
    (e200,) = _insert(200)
    (e500,) = _insert(500)
    post = lambda i, q: client.post("/api/free-nesting/runs", json=spec([{"drawing_id": i, "qty": q}], rotations="0"))   # noqa: E731
    assert post(e1500, 266).status_code == 200            # 399,000
    r = post(e1500, 267)                                   # 400,500
    assert r.status_code == 422 and "Kanten mal Menge" in r.json()["detail"]
    assert post(e200, 2000).status_code == 200            # 400,000 exactly, and 2000 instances
    r = post(e500, 2000)                                   # 1,000,000
    assert r.status_code == 422 and "Kanten mal Menge" in r.json()["detail"]
    assert post(e500, 801).status_code == 422 and post(e500, 800).status_code == 200


def test_the_sum_of_rotations_times_edges_is_capped(client):
    ids = _insert(450, 200)                                # 200 x 450 x 24 rotations = 2.16 M
    r = client.post("/api/free-nesting/runs", json=spec([{"drawing_id": i, "qty": 1} for i in ids], rotations="15"))
    assert r.status_code == 422 and "Kanten zu rechnen" in r.json()["detail"]
    r = client.post("/api/free-nesting/runs", json=spec([{"drawing_id": i, "qty": 1} for i in ids[:100]], rotations="15",
                                                        max_steps=1, quality="draft"))
    assert r.status_code != 422 or "Kanten zu rechnen" not in r.json()["detail"]


def test_the_map_cap_for_this_feature_is_256_mib_not_1_gib(client):
    assert fn.MAP_CAP_BYTES == 256 * 1024 * 1024
    ids = [make(client, name=f"Q{i}") for i in range(5)]
    body = spec([{"drawing_id": i, "qty": 1} for i in ids], sheet_w=4000, sheet_h=4000, cell=1, refine=False)
    r = client.post("/api/free-nesting/runs", json=body)       # 20 variants x 16 M cells = 305 MiB
    assert r.status_code == 422 and "Zu viele Teile und Drehungen" in r.json()["detail"]
    assert client.post("/api/free-nesting/runs", json={**body, "rotations": "0", "max_steps": 1}).status_code == 200


def test_unknown_runs_are_404(client):
    assert client.get("/api/free-nesting/runs/nope").status_code == 404
    assert client.post("/api/free-nesting/runs/nope/stop").status_code == 404
