"""Lagerorte: die Kommissionierung sagt, wo das Material liegt."""

from __future__ import annotations

from gimel.db import SessionLocal
from gimel.models import FactoryStation, Product, StockLocation
from gimel.services import stock_locations as sl


def _storage(db) -> FactoryStation:
    return db.query(FactoryStation).filter(FactoryStation.is_storage.is_(True)).first()


def _not_storage(db) -> FactoryStation:
    return db.query(FactoryStation).filter(FactoryStation.is_storage.is_(False)).first()


def test_crud_roundtrip_and_audit(client):
    with SessionLocal() as db:
        mat = db.query(Product).first().id
        st = _storage(db)
        st_id, st_label = st.id, st.label
    r = client.post("/api/factory/stock-locations", json={
        "mat": mat, "thk": 2.0, "station_id": st_id, "bin": "Fach Z9", "qty": 7})
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["station_label"] == st_label and row["bin"] == "Fach Z9" and row["qty"] == 7

    got = client.get("/api/factory/stock-locations", params={"mat": mat}).json()
    assert any(x["id"] == row["id"] for x in got["locations"][mat])
    assert any(s["id"] == st_id for s in got["storages"])

    r = client.put(f"/api/factory/stock-locations/{row['id']}", json={
        "mat": mat, "thk": 2.0, "station_id": st_id, "bin": "Fach Z8", "qty": 3})
    assert r.status_code == 200 and r.json()["qty"] == 3

    assert client.delete(f"/api/factory/stock-locations/{row['id']}").status_code == 200
    assert client.delete(f"/api/factory/stock-locations/{row['id']}").status_code == 404
    log = client.get("/api/admin/audit", params={"limit": 50})
    if log.status_code == 200:
        text = log.text
        assert "stock_location_create" in text and "stock_location_delete" in text


def test_rejects_unknown_material_and_non_storage(client):
    with SessionLocal() as db:
        mat = db.query(Product).first().id
        other = _not_storage(db)
        other_id = other.id if other else None
    r = client.post("/api/factory/stock-locations", json={"mat": "gibt-es-nicht", "qty": 1})
    assert r.status_code == 404
    if other_id is not None:
        r = client.post("/api/factory/stock-locations",
                        json={"mat": mat, "station_id": other_id, "qty": 1})
        assert r.status_code == 422


def test_staging_and_picking_carry_locations(client):
    with SessionLocal() as db:
        mat = db.query(Product).first().id
        st_id = _storage(db).id
        db.add(StockLocation(product_id=mat, thk=0.0, station_id=st_id, bin="Mischfach", qty=5))
        db.commit()
    for path in ("/api/factory/staging", "/api/factory/picking"):
        d = client.get(path).json()
        rows = d["rows"] if "rows" in d else d["materials"]
        assert rows, path
        assert all("locations" in r and "located" in r for r in rows), path


def test_thickness_match_prefers_exact_then_mixed():
    rows = [
        {"thk": 3.0, "qty": 4}, {"thk": 0.0, "qty": 9}, {"thk": 2.0, "qty": 6},
    ]
    got = sl.for_thickness(rows, 2.0)
    assert [r["qty"] for r in got] == [6, 9]
    assert sl.for_thickness(rows, 5.0) == [{"thk": 0.0, "qty": 9}]


def test_summarise_reports_unplaced_stock():
    rows = [{"thk": 2.0, "qty": 6}, {"thk": 3.0, "qty": 4}]
    info = sl.summarise(rows, stock=15, thk=2.0)
    assert info["located"] == 6 and info["unplaced"] == 5
    assert sl.summarise([], stock=15, thk=2.0)["unplaced"] == 15


def test_recommend_prefers_exact_then_enough_then_nearest():
    rows = [
        {"id": 1, "thk": 0.0, "qty": 40, "x": 0.0, "y": 0.0},
        {"id": 2, "thk": 2.0, "qty": 12, "x": 200.0, "y": 0.0},
        {"id": 3, "thk": 2.0, "qty": 12, "x": 10.0, "y": 0.0},
    ]
    rec = sl.recommend(rows, 2.0, 10, target=(0.0, 0.0))
    assert rec and rec["location"]["id"] == 3
    assert "deckt alle 10" in rec["reason"]

    # Keine exakte Dicke: das gemischte Fach ist die ehrliche Antwort.
    rec = sl.recommend(rows, 5.0, 10)
    assert rec and rec["location"]["id"] == 1
    assert "gemischtes Fach" in rec["reason"]

    assert sl.recommend([], 2.0, 10) is None


def test_staging_carries_recommendation(client):
    rows = client.get("/api/factory/staging").json()["rows"]
    open_rows = [r for r in rows if not r["staged"] and not r["started"]]
    assert open_rows
    row = open_rows[0]
    with SessionLocal() as db:
        st = _storage(db)
        db.add(StockLocation(product_id=row["mat"], thk=row["thk"],
                             station_id=st.id, bin="Empfehlungsfach", qty=99))
        db.commit()
    got = client.get("/api/factory/staging").json()["rows"]
    mine = next(r for r in got if r["no"] == row["no"])
    assert mine["recommended_location_id"] is not None
    assert mine["location_hint"]


def test_stage_records_selected_lagerort(client):
    rows = client.get("/api/factory/staging").json()["rows"]
    row = next(r for r in rows if not r["staged"] and not r["started"])
    with SessionLocal() as db:
        st = _storage(db)
        loc = StockLocation(product_id=row["mat"], thk=row["thk"],
                            station_id=st.id, bin="Fach A7", qty=5)
        db.add(loc)
        db.commit()
        loc_id, st_label = loc.id, st.label

    r = client.post(f"/api/production/work-orders/{row['no']}/stage",
                    json={"staged": True, "location_id": loc_id})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["material_staged_location_id"] == loc_id
    assert st_label in body["material_staged_location"]
    assert "Fach A7" in body["material_staged_location"]

    # Zurücknehmen räumt den Ort mit ab.
    r = client.post(f"/api/production/work-orders/{row['no']}/stage",
                    json={"staged": False})
    assert r.status_code == 200
    assert r.json()["material_staged_location"] == ""
    assert r.json()["material_staged_location_id"] is None


def test_stage_rejects_location_of_other_material(client):
    rows = client.get("/api/factory/staging").json()["rows"]
    row = next(r for r in rows if not r["staged"] and not r["started"])
    with SessionLocal() as db:
        other = db.query(Product).filter(Product.id != row["mat"]).first()
        st = _storage(db)
        loc = StockLocation(product_id=other.id, thk=0.0,
                            station_id=st.id, bin="falsch", qty=1)
        db.add(loc)
        db.commit()
        loc_id = loc.id
    r = client.post(f"/api/production/work-orders/{row['no']}/stage",
                    json={"staged": True, "location_id": loc_id})
    assert r.status_code == 409
