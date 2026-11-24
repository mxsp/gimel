"""Standorte, Hallen, Ebenen und die Fertigungsort-Vorgabe (Aufgabe 32).

Die Regeln laufen auf einer eigenen Datenbank im Speicher; die API-Tests auf der Demo.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from gimel.core.batch import BatchPart, group_key
from gimel.core.routing import JobSpec, RoutingContext, StationSpec, eligibility, storage_route
from gimel.db import Base
from gimel.models import (
    FactoryFloor,
    FactoryHall,
    FactorySite,
    FactoryStation,
    FactoryStationType,
    Order,
    WorkOrder,
    WorkOrderStatus,
)
from gimel.services import factory_router as fr
from gimel.services import sites


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


@pytest.fixture()
def halls_db(db):
    """Zwei Standorte; am ersten Halle 1 mit EG und 1. OG und Halle 2, am zweiten Halle 3."""
    a = FactorySite(name="Köthen")
    b = FactorySite(name="Halle (Saale)")
    db.add_all([a, b])
    db.flush()
    h1 = FactoryHall(site_id=a.id, name="Halle 1")
    h2 = FactoryHall(site_id=a.id, name="Halle 2")
    h3 = FactoryHall(site_id=b.id, name="Halle 3")
    db.add_all([h1, h2, h3])
    db.flush()
    f1 = FactoryFloor(hall_id=h1.id, level=0, level_name="EG")
    f1b = FactoryFloor(hall_id=h1.id, level=1, level_name="1. OG")
    f2 = FactoryFloor(hall_id=h2.id, level=0, level_name="EG")
    f3 = FactoryFloor(hall_id=h3.id, level=0, level_name="EG")
    db.add_all([f1, f1b, f2, f3])
    db.flush()
    st = {}
    for key, floor in (("p1", None), ("p1b", f1b), ("p2", f2), ("p3", f3)):
        s = FactoryStation(label=key, type=FactoryStationType.production,
                           floor_id=floor.id if floor else None, speed_mm_s=10)
        db.add(s)
        st[key] = s
    store = FactoryStation(label="Lager", type=FactoryStationType.warehouse, is_storage=True, x=0, y=0)
    db.add(store)
    db.flush()
    st["store"] = store
    return dict(sites=(a, b), halls=(h1, h2, h3), floors=(f1, f1b, f2, f3), st=st)


def wo(db, no, scope="") -> WorkOrder:
    w = WorkOrder(no=no, run_id=1, mat="epdm", thk=2, status=WorkOrderStatus.open, route_scope=scope)
    db.add(w)
    db.flush()
    return w


def ranked_ids(db, w) -> list[int]:
    return [a.station_id for a in fr.rank_for_work_order(db, w) if a.eligible]


def test_parse_and_print_round_trip():
    assert str(sites.parse("hall:2,1,2")) == "hall:1,2"
    assert sites.parse("").any and sites.parse("any").any
    assert str(sites.parse("received")) == "received"
    for bad in ("hall:", "room:1", "floor:x"):
        with pytest.raises(sites.ScopeError):
            sites.parse(bad)


def test_no_scope_keeps_every_station(db, halls_db):
    st = halls_db["st"]
    assert set(ranked_ids(db, wo(db, "IA-1"))) == {st["p1"].id, st["p1b"].id, st["p2"].id, st["p3"].id}


def test_only_hall_one_means_both_of_its_levels(db, halls_db):
    st, (h1, _, _) = halls_db["st"], halls_db["halls"]
    w = wo(db, "IA-2", f"hall:{h1.id}")
    assert set(ranked_ids(db, w)) == {st["p1"].id, st["p1b"].id}
    blocked = [a for a in fr.rank_for_work_order(db, w) if not a.eligible and a.label != "Lager"]
    assert all("nur Halle 1" in a.blockers[0] for a in blocked)


def test_only_one_level(db, halls_db):
    st, floors = halls_db["st"], halls_db["floors"]
    assert ranked_ids(db, wo(db, "IA-3", f"floor:{floors[1].id}")) == [st["p1b"].id]


def test_only_a_site_covers_all_its_halls(db, halls_db):
    st, (a, b) = halls_db["st"], halls_db["sites"]
    assert set(ranked_ids(db, wo(db, "IA-4", f"site:{a.id}"))) == {st["p1"].id, st["p1b"].id, st["p2"].id}
    assert ranked_ids(db, wo(db, "IA-5", f"site:{b.id}")) == [st["p3"].id]


def test_received_resolves_to_the_order_site(db, halls_db):
    _, b = halls_db["sites"]
    o = Order(no="A-1", route_scope="received", site_id=b.id)
    assert sites.resolve_received(o, db) == f"site:{b.id}"
    o2 = Order(no="A-2", route_scope="received")
    assert sites.resolve_received(o2, db) == f"site:{halls_db['sites'][0].id}"


def test_manual_assignment_outside_the_scope_is_refused(db, halls_db):
    st, (_, h2, _) = halls_db["st"], halls_db["halls"]
    w = wo(db, "IA-6", f"hall:{h2.id}")
    with pytest.raises(ValueError, match="außerhalb der Vorgabe"):
        fr.assign(db, w, st["p1"].id, mode="manual")
    fr.assign(db, w, st["p2"].id, mode="manual")
    assert w.station_id == st["p2"].id


def test_storage_in_another_hall_gives_no_route_and_another_level_an_estimate(db, halls_db):
    specs = {s.label: s for s in fr.station_specs(db)}
    ctx = fr.context(db)
    job = JobSpec(no="x", mat="epdm")
    r, store = storage_route(job, specs["p1b"], list(specs.values()), ctx)
    assert store.label == "Lager" and not r.exact and r.metres >= 30
    r, store = storage_route(job, specs["p2"], list(specs.values()), ctx)
    assert r is None and store is None


def test_two_anchored_halls_of_one_site_get_an_estimate(db, halls_db):
    h1, h2, h3 = halls_db["halls"]
    # Halle 2 liegt 100 m östlich von Halle 1; Halle 3 am anderen Standort.
    h1.lat, h1.lon = 51.75, 11.97
    h2.lat, h2.lon = 51.75, 11.97 + 100 / (111_320 * __import__("math").cos(__import__("math").radians(51.75)))
    h3.lat, h3.lon = 51.48, 11.97
    db.flush()
    specs = {s.label: s for s in fr.station_specs(db)}
    ctx = fr.context(db)
    r = ctx.route_between(specs["p1"], specs["p2"])
    assert r is not None and not r.exact and "Kartenlage" in r.note
    assert abs(r.metres - (100 * 1.3 + 20)) < 1
    assert ctx.route_between(specs["p1"], specs["p3"]) is None


def test_rotation_turns_the_hall_on_the_map():
    from gimel.core.routing import HallGeo

    ref = HallGeo(51.75, 11.97, 0.0)
    assert HallGeo(51.75, 11.97, 0.0).to_world(10, 0, ref) == (10.0, 0.0)
    e, n = HallGeo(51.75, 11.97, 90.0).to_world(10, 0, ref)
    assert abs(e) < 1e-9 and abs(n - 10) < 1e-9
    e, n = HallGeo(51.75, 11.97, 0.0).to_world(0, 10, ref)
    assert abs(n + 10) < 1e-9  # Plan-y zählt nach Süden


def test_conflicting_scopes_intersect_to_nothing_not_everything(db, halls_db):
    topo = sites.topology(db)
    h1, h2, _ = halls_db["halls"]
    assert sites.intersect([f"hall:{h1.id}", f"hall:{h2.id}"], topo) == "floor:0"
    assert sites.intersect(["", f"hall:{h1.id}"], topo) == f"hall:{h1.id}"


def test_scopes_never_share_a_plate():
    a = BatchPart(1, "A", "", "", "", "epdm", 2, 10, 0, 1)
    b = BatchPart(2, "B", "", "", "", "epdm", 2, 10, 0, 1, route_scope="hall:2")
    assert group_key(a) == ("", "epdm", 2.0)
    assert group_key(a) != group_key(b)


def test_pipeline_names_the_hall_of_each_station(client):
    """Die Flussansicht muss Maschinen aus mehreren Hallen auseinanderhalten."""
    r = client.get("/api/factory/pipeline")
    assert r.status_code == 200, r.text
    production = [s for s in r.json()["stations"] if s["type"] == "production"]
    assert production
    for station in production:
        for field in ("site_id", "hall_id", "site_name", "hall_name", "floor_name"):
            assert field in station
    assert any(s["hall_name"] for s in production)


def test_core_without_floors_is_unchanged():
    st = StationSpec(id=1, label="P", type="production")
    assert eligibility(JobSpec(no="x", mat="m"), st) == []
    assert eligibility(JobSpec(no="x", mat="m", allowed_floors=frozenset({2}), scope_label="nur Halle 2"), st) == [
        "außerhalb der Vorgabe (nur Halle 2)"
    ]
    assert RoutingContext().route_between(st, st) is not None


# ---------------------------------------------------------------------------
# API auf der Demo
# ---------------------------------------------------------------------------
def test_backfill_puts_the_old_floor_in_a_hall(client):
    topo = client.get("/api/factory/topology").json()
    assert topo["sites"], topo
    hall = topo["sites"][0]["halls"][0]
    assert hall["floors"][0]["level_name"] == "EG"
    assert topo["default_floor_id"] == hall["floors"][0]["id"]


def test_sites_halls_levels_round_trip(client):
    s = client.post("/api/factory/sites", json={"name": "Zweitwerk", "lat": 51.48, "lon": 11.97}).json()
    h = client.post("/api/factory/halls", json={"site_id": s["id"], "name": "Halle Z",
                                                "lat": 51.48, "lon": 11.97, "map_enabled": True}).json()
    topo = client.get("/api/factory/topology").json()
    mine = next(x for x in topo["sites"] if x["id"] == s["id"])
    ground = mine["halls"][0]["floors"][0]
    assert ground["level"] == 0
    # Lage kommt aus Karte und Ankerfeldern: sie muss den PUT überleben.
    moved = {k: h[k] for k in ("site_id", "name", "code", "sort", "map_enabled", "note")}
    r = client.put(f"/api/factory/halls/{h['id']}", json={
        **moved, "lat": 52.123456, "lon": 13.654321, "rotation_deg": 27.5,
    })
    assert r.status_code == 200, r.text
    assert r.json()["lat"] == 52.123456 and r.json()["rotation_deg"] == 27.5
    saved = next(x for x in client.get("/api/factory/topology").json()["sites"]
                 if x["id"] == s["id"])["halls"][0]
    assert (saved["lat"], saved["lon"], saved["rotation_deg"]) == (52.123456, 13.654321, 27.5)
    up = client.post("/api/factory/floors", json={"hall_id": h["id"], "level": 1,
                                                  "copy_outline_from": ground["id"]})
    assert up.status_code == 200, up.text
    assert up.json()["level_name"] == "1. OG" and up.json()["elevation_m"] == 6.0
    assert client.post("/api/factory/floors", json={"hall_id": h["id"], "level": 1}).status_code == 409
    # Eine Station auf dem OG, die Ebene lässt sich dann nicht löschen.
    st = client.post("/api/factory/stations", json={"label": "OG-Tisch", "type": "production",
                                                     "floor_id": up.json()["id"]}).json()
    assert st["floor_id"] == up.json()["id"]
    assert client.delete(f"/api/factory/floors/{up.json()['id']}").status_code == 409
    assert client.get(f"/api/factory/floor?floor_id={up.json()['id']}").json()["level"] == 1
    assert client.delete(f"/api/factory/stations/{st['id']}").status_code == 204
    assert client.delete(f"/api/factory/floors/{up.json()['id']}").status_code == 204
    assert client.delete(f"/api/factory/halls/{h['id']}").status_code == 204
    assert client.delete(f"/api/factory/sites/{s['id']}").status_code == 204


def test_order_scope_is_validated_and_audited(client):
    from gimel.db import SessionLocal

    with SessionLocal() as s:
        no = s.query(Order.no).order_by(Order.id).first()[0]
    topo = client.get("/api/factory/topology").json()
    hall = topo["sites"][0]["halls"][0]["id"]
    assert client.put(f"/api/factory/orders/{no}/scope", json={"route_scope": "hall:99999"}).status_code == 400
    r = client.put(f"/api/factory/orders/{no}/scope", json={"route_scope": f"hall:{hall}"})
    assert r.status_code == 200 and r.json()["label"].startswith("nur ")
    r = client.put(f"/api/factory/orders/{no}/scope", json={"route_scope": "received"})
    assert r.json()["floors"]
    client.put(f"/api/factory/orders/{no}/scope", json={"route_scope": ""})


def test_the_demo_plant_has_sites_halls_levels_and_stations(client):
    topo = client.get("/api/factory/topology").json()
    assert [s["name"] for s in topo["sites"]] == ["Werk Musterstadt"]
    halls = [h for site in topo["sites"] for h in site["halls"]]
    assert [h["name"] for h in halls] == ["Halle 1", "Halle 2"]
    floors = [f for h in halls for f in h["floors"]]
    assert len(floors) == 5
    assert {f["level"] for f in floors} == {-1, 0, 1}
    assert all(f["stations"] > 0 for f in floors), "every level in the demo has something on it"
    stations = client.get("/api/factory/stations").json()
    assert len(stations) >= 20
    assert all(s["floor_id"] for s in stations)
    assert {s["floor_id"] for s in stations} == {f["id"] for f in floors}


def test_the_demo_floor_definitions_have_connected_aisles():
    """Die Grundrisse selbst, ohne die von anderen Tests veränderte Demo-Datenbank."""
    from gimel import demo
    from gimel.core.layout import Layout

    halls = [FactoryHall(id=i, name=name, code=code)
             for i, (name, code) in enumerate((("Halle 1", "H1"), ("Halle 2", "LOG")), 1)]
    floors = {
        "h1_eg": demo._hq_ground(halls[0]),
        "h1_og": demo._hq_upper(halls[0]),
        "h2_kg": demo._logistics_basement(halls[1]),
        "h2_eg": demo._logistics_ground(halls[1]),
        "h2_og": demo._logistics_upper(halls[1]),
    }
    for i, f in enumerate(floors.values(), 1):
        f.id = i
    stations = demo._stations(floors)
    for key, f in floors.items():
        layout = Layout.from_row(f)
        own = [s for s in stations if s.floor_id == f.id]
        assert own, key
        assert layout.check() == [], key
        assert layout.connect_issues([(s.label, (s.x, s.y)) for s in own]) == [], key


def test_the_demo_orders_show_site_and_scope(client):
    from gimel.db import SessionLocal

    topo = client.get("/api/factory/topology").json()
    site_ids = {s["id"] for s in topo["sites"]}
    with SessionLocal() as db:
        orders = db.query(Order).all()
        scoped = [o for o in orders if o.route_scope]
        assert {o.site_id for o in orders} == site_ids
        assert any(o.route_scope == "received" for o in scoped)
        assert any(o.route_scope.startswith("hall:") for o in scoped)
        assert any(o.route_scope.startswith("floor:") for o in scoped)


def test_duplicate_hall_name_rejected_within_same_site(client):
    s = client.post("/api/factory/sites", json={"name": "Werk Nord"}).json()
    h1 = client.post("/api/factory/halls", json={"site_id": s["id"], "name": "Halle A"})
    assert h1.status_code == 200, h1.text
    dup = client.post("/api/factory/halls", json={"site_id": s["id"], "name": "  halle a "})
    assert dup.status_code == 409
    assert client.delete(f"/api/factory/halls/{h1.json()['id']}").status_code == 204
    assert client.delete(f"/api/factory/sites/{s['id']}").status_code == 204
