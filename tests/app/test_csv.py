"""CSV import with a preview that creates nothing, export that cannot run as a formula."""

from __future__ import annotations

import csv
import io

import pytest

from gimel.db import SessionLocal
from gimel.models import AuditLog, Order, User
from gimel.services import csv_io

HEAD = "email;firma;strasse;plz;ort;werkstoff;dicke;menge;bezeichnung;aussen;innen;bestellzeichen\n"
GOOD = HEAD + ("neu@kunde.example;Neu GmbH;Weg 1;12345;Ort;epdm-70;2;4;Ring;100,5;50;PO-7\n"
               "neu@kunde.example;Neu GmbH;Weg 1;12345;Ort;EPDM 70 Shore;3;2;Ring 2;120;60;PO-7\n")


@pytest.fixture
def forget():
    """Other tests count the 8 demo orders."""
    with SessionLocal() as db:
        orders, users = {n for (n,) in db.query(Order.no)}, {i for (i,) in db.query(User.id)}
    yield
    with SessionLocal() as db:
        for order in db.query(Order).filter(Order.no.notin_(orders)):
            db.delete(order)
        db.flush()
        db.query(User).filter(User.id.notin_(users)).delete(synchronize_session=False)
        db.commit()


def upload(client, text, *, commit=False, encoding="utf-8", name="auftraege.csv"):
    return client.post("/api/desk/import/orders", params={"commit": commit},
                       files={"file": (name, text.encode(encoding), "text/csv")})


def order_count() -> int:
    with SessionLocal() as db:
        return db.query(Order).count()


def test_preview_calculates_and_creates_nothing(client, forget):
    n = order_count()
    r = upload(client, GOOD)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "preview" and body["ok"] is True and body["rows"] == 2
    assert len(body["orders"]) == 1
    order = body["orders"][0]
    assert order["new_customer"] is True and order["positions"] == 2 and order["rows"] == [2, 3]
    assert order["gross"] > order["net"] > 0
    assert order_count() == n
    with SessionLocal() as db:
        assert not db.query(User).filter(User.email == "neu@kunde.example").first()


def test_commit_creates_the_orders_and_one_audit_line(client, forget):
    preview = upload(client, GOOD).json()
    r = upload(client, GOOD, commit=True)
    assert r.status_code == 200, r.text
    body = r.json()
    no = body["created"][0]
    assert len(body["created"]) == 1
    with SessionLocal() as db:
        order = db.query(Order).filter(Order.no == no).one()
        assert order.gross == preview["orders"][0]["gross"], "the preview's price is the order's price"
        assert order.customer_ref == "PO-7" and len(order.positions) == 2 and order.released
        assert order.positions[0].od == 100.5
        line = db.query(AuditLog).filter_by(action="csv_import").order_by(AuditLog.id.desc()).first()
        assert line.detail["orders"] == [no] and line.entity_id == "auftraege.csv"


def test_one_bad_row_reports_per_row_and_creates_nothing_at_all(client, forget):
    text = GOOD + ("neu@kunde.example;Neu GmbH;Weg 1;12345;Ort;gibtsnicht;2;x;Ring;100;50;PO-8\n"
                   "neu@kunde.example;Neu GmbH;Weg 1;12345;Ort;epdm-70;7;1;Ring;1.500;50;PO-8\n")
    n = order_count()
    preview = upload(client, text).json()
    assert preview["ok"] is False
    found = {(e["row"], e["column"]) for e in preview["errors"]}
    assert {(4, "werkstoff"), (4, "menge"), (5, "dicke"), (5, "aussen")} <= found
    r = upload(client, text, commit=True)
    assert r.status_code == 422 and r.json()["detail"]["ok"] is False
    assert order_count() == n
    with SessionLocal() as db:
        assert not db.query(User).filter(User.email == "neu@kunde.example").first()


def test_a_failure_in_the_commit_rolls_everything_back(client, forget, monkeypatch):
    from gimel.services import orders

    n = order_count()
    real = orders.place_order
    calls = []

    def second_fails(*a, **k):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("kaputt")
        return real(*a, **k)

    monkeypatch.setattr(csv_io, "place_order", second_fails)
    text = HEAD + "a@kunde.example;A GmbH;Weg 1;12345;Ort;epdm-70;2;4;Ring;100;50;\n" \
                  "b@kunde.example;B GmbH;Weg 1;12345;Ort;epdm-70;2;4;Ring;100;50;\n"
    with pytest.raises(RuntimeError):
        upload(client, text, commit=True)
    assert order_count() == n
    with SessionLocal() as db:
        assert not db.query(User).filter(User.email == "a@kunde.example").first()


@pytest.mark.parametrize("encoding,delimiter", [("utf-8-sig", ";"), ("utf-8", ","), ("utf-8-sig", ",")])
def test_comma_files_bom_and_german_decimals(client, encoding, delimiter):
    rows = [["email", "firma", "straße", "ort", "Material", "dicke", "menge", "od", "di"],
            ["x@kunde.example", "Müller & Söhne", "Weg 1", "Köln", "epdm-70", "2", "4", "100,5", "50"]]
    out = io.StringIO()
    csv.writer(out, delimiter=delimiter).writerows(rows)
    body = upload(client, out.getvalue(), encoding=encoding).json()
    assert body["ok"] is True, body["errors"]
    assert body["orders"][0]["customer"] == "Müller & Söhne"


@pytest.mark.parametrize("raw,value", [("1,5", 1.5), ("1.5", 1.5), ("1.234,56", 1234.56), ("1,234.56", 1234.56), ("2", 2.0)])
def test_numbers(raw, value):
    assert csv_io.parse_number(raw) == value


@pytest.mark.parametrize("raw", ["1.500", "abc", "nan", "inf"])
def test_numbers_refused(raw):
    with pytest.raises(ValueError):
        csv_io.parse_number(raw)


def test_files_that_are_not_csv_are_refused(client):
    assert upload(client, GOOD, name="x.exe").status_code == 422
    assert upload(client, "werkstoff;menge;quatsch\n").json()["errors"][0]["message"].startswith("Unbekannte Spalte")
    r = client.post("/api/desk/import/orders", files={"file": ("a.csv", b"\xff\xfe\x00", "text/csv")})
    assert "UTF-8" in r.json()["errors"][0]["message"]
    r = client.post("/api/desk/import/orders", files={"file": ("a.csv", b"x" * (csv_io.MAX_BYTES + 1), "text/csv")})
    assert r.status_code == 413


def test_foreign_delivery_is_refused_not_guessed(client):
    text = HEAD.replace("ort;", "ort;land;") + "x@k.example;K;Weg;1;Ort;AT;epdm-70;2;4;R;100;50;\n"
    assert "Auslandsauftrag" in upload(client, text).json()["errors"][0]["message"]


@pytest.mark.parametrize("bad", ["=1+1", "+1", "-1", "@x", "\tx", "\rx", "  =1"])
def test_formula_cells_are_neutralised(bad):
    assert csv_io.safe_cell(bad).startswith("'")


def test_plain_text_stays_and_numbers_are_german():
    assert csv_io.safe_cell("Ring 100") == "Ring 100"
    assert csv_io.number_cell(1234.5) == "1234,50"


def test_export_of_orders_neutralises_and_audits(client, forget):
    text = HEAD + 'x@kunde.example;"=HYPERLINK(""http://böse"")";Weg 1;12345;Ort;epdm-70;2;4;Ring;100;50;=1+1\n'
    assert upload(client, text, commit=True).status_code == 200
    r = client.get("/api/desk/export/orders.csv")
    assert r.status_code == 200 and r.text.startswith("﻿Auftrag;")
    rows = list(csv.reader(io.StringIO(r.text.lstrip("﻿")), delimiter=";"))
    assert len({len(x) for x in rows}) == 1
    last = rows[-1]
    assert last[2].startswith("'=HYPERLINK") and last[4] == "'=1+1"
    with SessionLocal() as db:
        line = db.query(AuditLog).filter_by(action="csv_export", entity="orders").order_by(AuditLog.id.desc()).first()
        assert line.detail["rows"] == len(rows) - 1


def test_export_of_invoices_shows_a_storno_negative(client, forget, monkeypatch):
    from gimel.services import stripe_client

    monkeypatch.setattr(stripe_client, "secret_key", lambda: "")
    upload(client, GOOD, commit=True)
    with SessionLocal() as db:
        no = db.query(Order).order_by(Order.id.desc()).first().no
    number = client.post(f"/api/invoicing/orders/{no}/invoice", json={"delivery_date": "2026-10-30"}).json()["number"]
    storno = client.post(f"/api/invoicing/orders/{no}/invoice/cancel", json={"reason": "Testfall"}).json()["storno"]
    r = client.get("/api/invoicing/export/invoices.csv")
    rows = {x[0]: x for x in csv.reader(io.StringIO(r.text.lstrip("﻿")), delimiter=";")}
    assert rows[number][1] == "Rechnung" and rows[storno][1] == "Storno"
    assert rows[storno][3] == number and rows[storno][9] == "-" + rows[number][9]


def test_a_worker_may_neither_import_nor_export(client, plant):
    from gimel.models import Role
    from gimel.security import hash_password

    with SessionLocal() as db:
        u = User(email="w-csv@musterwerk.example", role=Role.worker, password_hash=hash_password("maple-river-7429"))
        db.add(u)
        db.commit()
    try:
        token = client.post("/api/auth/login", data={"username": "w-csv@musterwerk.example",
                                                     "password": "maple-river-7429"}).json()["access_token"]
        auth = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/desk/export/orders.csv", headers=auth).status_code == 403
        assert client.get("/api/invoicing/export/invoices.csv", headers=auth).status_code == 403
        assert client.post("/api/desk/import/orders", headers=auth,
                           files={"file": ("a.csv", GOOD.encode(), "text/csv")}).status_code == 403
    finally:
        with SessionLocal() as db:
            db.query(User).filter(User.email == "w-csv@musterwerk.example").delete()
            db.commit()
