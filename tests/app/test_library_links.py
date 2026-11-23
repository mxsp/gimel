"""Die Form aus der Bibliothek bleibt an der Bestellposition erkennbar.

Ohne ``shape_id`` war die Herkunft einer Position nach dem Anlegen nur noch
an der Kontur zu erraten. Der Test hält den Weg fest, an dem die Querverweise
hängen: Bibliothek → Auftrag → Innenauftrag.
"""

from __future__ import annotations

from gimel.db import SessionLocal
from gimel.models import LibraryShape, Order, OrderPosition

LINES = [
    {
        "id": 1,
        "mat": "epdm-70",
        "thk": 2,
        "label": "Form aus dem Haus",
        "od": 162,
        "di": 115,
        "q": 3,
    }
]


def _make_shape() -> int:
    with SessionLocal() as db:
        row = LibraryShape(
            key="test-querverweis",
            label="Testform Querverweis",
            cat="frei",
            od=162,
            di=115,
            cut_len=435,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row.id


def test_a_library_form_survives_into_the_order_and_its_trace(client):
    shape_id = _make_shape()
    no = ""
    try:
        body = {
            "kind": "internal",
            "internal_owner": "Testwerkstatt",
            "lines": [{**LINES[0], "shape_id": shape_id}],
        }
        r = client.post("/api/desk/orders", json=body)
        assert r.status_code == 201, r.text
        no = r.json()["no"]

        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one()
            position = order.positions[0]
            assert position.shape_id == shape_id

        detail = client.get(f"/api/admin/orders/{no}")
        assert detail.status_code == 200, detail.text
        pos = detail.json()["positions"][0]
        assert pos["shape_id"] == shape_id
        assert pos["shape_key"] == "test-querverweis"
        assert pos["shape_label"] == "Testform Querverweis"

        trace = client.get(f"/api/production/orders/{no}")
        assert trace.status_code == 200, trace.text
        assert trace.json()["positions"][0]["shape_id"] == shape_id
    finally:
        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one_or_none()
            if order is not None:
                db.delete(order)
            shape = db.get(LibraryShape, shape_id)
            if shape is not None:
                db.delete(shape)
            db.commit()


def test_a_position_without_a_library_form_has_no_shape_id(client):
    body = {
        "kind": "internal",
        "internal_owner": "Testwerkstatt",
        "lines": [dict(LINES[0])],
    }
    r = client.post("/api/desk/orders", json=body)
    assert r.status_code == 201, r.text
    no = r.json()["no"]
    try:
        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one()
            assert order.positions[0].shape_id is None
        assert client.get(f"/api/admin/orders/{no}").json()["positions"][0]["shape_id"] is None
    finally:
        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one_or_none()
            if order is not None:
                db.delete(order)
                db.commit()


def test_an_unknown_shape_id_is_ignored_instead_of_stored(client):
    """Eine Kennung aus einem fremden Browser darf keine Verwendung erfinden."""
    body = {
        "kind": "internal",
        "internal_owner": "Testwerkstatt",
        "lines": [{**LINES[0], "shape_id": 999_999}],
    }
    r = client.post("/api/desk/orders", json=body)
    assert r.status_code == 201, r.text
    no = r.json()["no"]
    try:
        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one()
            assert order.positions[0].shape_id is None
    finally:
        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == no).one_or_none()
            if order is not None:
                db.delete(order)
                db.commit()


def test_a_cloned_order_keeps_the_form(client):
    shape_id = _make_shape()
    no = ""
    clone_no = ""
    try:
        r = client.post("/api/desk/orders", json={
            "kind": "internal",
            "internal_owner": "Testwerkstatt",
            "lines": [{**LINES[0], "shape_id": shape_id}],
        })
        assert r.status_code == 201, r.text
        no = r.json()["no"]

        r = client.post(f"/api/admin/orders/{no}/clone")
        assert r.status_code == 200, r.text
        clone_no = r.json()["no"]

        with SessionLocal() as db:
            order = db.query(Order).filter(Order.no == clone_no).one()
            assert order.positions[0].shape_id == shape_id
    finally:
        with SessionLocal() as db:
            for number in (no, clone_no):
                order = db.query(Order).filter(Order.no == number).one_or_none()
                if order is not None:
                    db.delete(order)
            shape = db.get(LibraryShape, shape_id)
            if shape is not None:
                db.delete(shape)
            db.commit()
