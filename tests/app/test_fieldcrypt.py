"""Feldverschlüsselung: Rundlauf, Klartext-Durchgriff, falscher Schlüssel, Schlüsselwechsel, Suchen."""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import text, type_coerce
from sqlalchemy.types import NullType

from gimel import fieldcrypt as fc
from gimel import fieldmigrate
from gimel.config import get_settings

K1 = "k1:" + "A" * 43          # 32 Byte base64url, nur für Tests
K2 = "k2:" + "B" * 43
K3 = "k3:" + "C" * 43


@pytest.fixture
def keys(monkeypatch):
    def setter(raw: str):
        monkeypatch.setattr(get_settings(), "data_keys", raw)
    setter("")
    return setter


# ---- Baustein ----------------------------------------------------------------

def test_no_key_means_plaintext_everywhere(keys):
    assert not fc.enabled()
    assert fc.encrypt_text("a.b", "Musterstr. 1") == "Musterstr. 1"
    assert fc.encrypt_bytes("a.b", b"%PDF-1.7") == b"%PDF-1.7"
    assert fc.encrypt_json("a.b", {"city": "Köthen"}) == {"city": "Köthen"}


def test_round_trip_text_bytes_json(keys):
    keys(K1)
    t = fc.encrypt_text("addresses.street", "Hauptstr. 1, Köthen")
    assert t.startswith("fe1:k1:") and "Köthen" not in t
    assert fc.decrypt_text("addresses.street", t) == "Hauptstr. 1, Köthen"
    b = fc.encrypt_bytes("invoice_documents.pdf", b"%PDF-1.7 secret")
    assert b.startswith(b"fe1:k1:") and b"secret" not in b
    assert fc.decrypt_bytes("invoice_documents.pdf", b) == b"%PDF-1.7 secret"
    j = fc.encrypt_json("orders.ship_address", {"street": "Hauptstr. 1", "n": [1, 2]})
    assert isinstance(j, str) and "Hauptstr" not in j
    assert fc.decrypt_json("orders.ship_address", j) == {"street": "Hauptstr. 1", "n": [1, 2]}
    # zwei Verschlüsselungen desselben Wertes sind verschieden (zufälliger Nonce)
    assert fc.encrypt_text("x.y", "same") != fc.encrypt_text("x.y", "same")


def test_empty_values_stay_as_they_are(keys):
    keys(K1)
    for v in (None, ""):
        assert fc.encrypt_text("x.y", v) == v
    for v in (None, "", {}, []):
        assert fc.encrypt_json("x.y", v) == v
    assert fc.encrypt_bytes("x.y", b"") == b""


def test_plaintext_passes_through_with_a_key(keys):
    keys(K1)
    assert fc.decrypt_text("a.b", "Altbestand") == "Altbestand"
    assert fc.decrypt_text("a.b", "fe1:das ist nur Text") == "fe1:das ist nur Text"
    assert fc.decrypt_bytes("a.b", b"%PDF-1.4") == b"%PDF-1.4"
    assert fc.decrypt_json("a.b", {"alt": 1}) == {"alt": 1}
    assert fc.decrypt_json("a.b", "ein String") == "ein String"


def test_a_value_is_bound_to_its_field(keys):
    keys(K1)
    t = fc.encrypt_text("addresses.street", "geheim")
    with pytest.raises(fc.UnreadableField) as e:
        fc.decrypt_text("addresses.city", t)
    assert "geheim" not in str(e.value)


def test_wrong_or_missing_key_raises_and_never_leaks(keys):
    keys(K1)
    t = fc.encrypt_text("a.b", "geheim")
    keys(K2)
    with pytest.raises(fc.UnreadableField) as e:
        fc.decrypt_text("a.b", t)
    assert "k1" in str(e.value) and "geheim" not in str(e.value)
    keys("k1:" + "D" * 43)  # gleiche Kennung, anderer Schlüssel
    with pytest.raises(fc.UnreadableField):
        fc.decrypt_text("a.b", t)
    keys("")
    with pytest.raises(fc.UnreadableField):
        fc.decrypt_text("a.b", t)


def test_rotation_new_key_writes_old_key_still_reads(keys):
    keys(K1)
    old = fc.encrypt_text("a.b", "alt")
    keys(f"{K2},{K1}")
    assert fc.active_key_id() == "k2"
    assert fc.decrypt_text("a.b", old) == "alt"
    new = fc.encrypt_text("a.b", "neu")
    assert fc.token_key_id(new) == "k2" and fc.token_key_id(old) == "k1"
    keys(K2)   # alter Schlüssel entfernt
    assert fc.decrypt_text("a.b", new) == "neu"
    with pytest.raises(fc.UnreadableField):
        fc.decrypt_text("a.b", old)


@pytest.mark.parametrize("raw", ["nokid", "bad kid:" + "A" * 43, "k1:short", "k1:" + "A" * 43 + ",k1:" + "B" * 43, "k1:!!!!"])
def test_bad_configuration_is_refused(keys, raw):
    keys(raw)
    with pytest.raises(fc.KeyConfigError):
        fc.validate()


def test_generated_key_is_valid_and_unique(keys):
    a, b = fc.generate_key("k7"), fc.generate_key("k7")
    assert a != b and a.startswith("k7:")
    keys(a)
    fc.validate()


def test_blind_index_is_deterministic_normalised_and_survives_rotation(keys):
    keys(K1)
    i1 = fc.blind_index("users.email", " Anna@Example.DE ")
    assert i1 == fc.blind_index("users.email", "anna@example.de")
    assert i1 != fc.blind_index("orders.contact_email", "anna@example.de")
    keys(f"{K2},{K1}")
    assert fc.blind_index("users.email", "anna@example.de") != i1
    assert i1 in fc.blind_indexes("users.email", "anna@example.de")   # Suche findet die alte Zeile noch


@pytest.fixture(autouse=True)
def _leave_no_rows_behind(request):
    """Die Testdatenbank gehört der ganzen Sitzung (test_platform zählt Aufträge): was hier entsteht, geht wieder."""
    if "plant" not in request.fixturenames:
        yield
        return
    from sqlalchemy import func, select
    from gimel.db import SessionLocal
    from gimel.models import Address, AuditLog, LibraryShape, Order, User
    models = (Address, Order, AuditLog, LibraryShape, User)
    with SessionLocal() as db:
        before = {m: db.scalar(select(func.max(m.id))) or 0 for m in models}
    yield
    with SessionLocal() as db:
        for m in models:
            db.query(m).filter(m.id > before[m]).delete(synchronize_session=False)
        db.commit()


# ---- Datenbank ---------------------------------------------------------------

def _raw(db, table, col, rid):
    from gimel.db import Base
    t = Base.metadata.tables[table]
    return db.execute(__import__("sqlalchemy").select(type_coerce(t.c[col], NullType())).where(t.c.id == rid)).scalar()


def _user(db):
    from gimel.models import Role, User
    u = User(email=f"{uuid.uuid4().hex[:8]}@test.invalid", password_hash="!", name="Test", role=Role.customer)
    db.add(u)
    db.flush()
    return u


def test_model_fields_are_sealed_on_disk_and_plain_in_python(plant, keys):
    from gimel.db import SessionLocal
    from gimel.models import Address, Order
    keys(K1)
    with SessionLocal() as db:
        u = _user(db)
        a = Address(user_id=u.id, street="Hauptstr. 1", city="Köthen", zip="06366", contact="Frau Müller", country="DE")
        o = Order(no=f"T-{uuid.uuid4().hex[:8]}", ship_address={"street": "Hauptstr. 1"}, bill_address={}, user_id=u.id)
        db.add_all([a, o])
        db.commit()
        aid, oid = a.id, o.id
    with SessionLocal() as db:
        assert fc.is_token(_raw(db, "addresses", "street", aid)) and "Hauptstr" not in _raw(db, "addresses", "street", aid)
        assert _raw(db, "addresses", "country", aid) == "DE"
        assert "Hauptstr" not in _raw(db, "orders", "ship_address", oid)
        assert _raw(db, "orders", "bill_address", oid) == "{}"          # leer bleibt leer
        a = db.get(Address, aid)
        assert (a.street, a.city, a.zip, a.contact) == ("Hauptstr. 1", "Köthen", "06366", "Frau Müller")
        assert db.get(Order, oid).ship_address == {"street": "Hauptstr. 1"}


def test_legacy_plaintext_rows_read_back_and_stay_without_a_key(plant, keys):
    from gimel.db import SessionLocal
    from gimel.models import Address
    with SessionLocal() as db:           # ohne Schlüssel geschrieben, wie heute
        u = _user(db)
        a = Address(user_id=u.id, street="Altstr. 2", city="Halle")
        db.add(a)
        db.commit()
        aid = a.id
        assert _raw(db, "addresses", "street", aid) == "Altstr. 2"
    keys(K1)
    with SessionLocal() as db:
        assert db.get(Address, aid).street == "Altstr. 2"     # Klartext-Zeile, Schlüssel gesetzt
        a = db.get(Address, aid)
        a.city = "Leipzig"                                    # nächster Schreibzugriff versiegelt nur die geänderte Spalte
        db.commit()
        assert fc.is_token(_raw(db, "addresses", "city", aid))
        assert _raw(db, "addresses", "street", aid) == "Altstr. 2"
    keys("")
    with SessionLocal() as db:
        with pytest.raises(fc.UnreadableField):               # Schlüssel zurückgenommen, versiegelte Spalte
            _ = db.get(Address, aid).city


def test_migration_dry_run_apply_idempotent_rotate_and_back(plant, keys):
    from gimel.db import SessionLocal
    from gimel.models import Address, AuditLog, LibraryShape
    with SessionLocal() as db:
        u = _user(db)
        a = Address(user_id=u.id, street="Migrationsstr. 9", city="Dessau")
        al = AuditLog(actor="x", action="t", detail={"to": "m@test.invalid"})
        ls = LibraryShape(key=f"k-{uuid.uuid4().hex[:6]}", label="L", dxf_blob=b"0\nSECTION\n2\nENTITIES", shape={"p": [1, 2]})
        db.add_all([a, al, ls])
        db.commit()
        ids = (a.id, al.id, ls.id)
    quiet = lambda *_: None
    keys(K1)
    dry = fieldmigrate.run(apply=False, out=quiet)
    assert dry["encrypt"] >= 3
    with SessionLocal() as db:
        assert _raw(db, "addresses", "street", ids[0]) == "Migrationsstr. 9"       # Probelauf schrieb nichts
    done = fieldmigrate.run(apply=True, out=quiet, batch=2)                          # kleine Stapel: wiederaufnehmbar
    assert done["encrypt"] >= 3
    again = fieldmigrate.run(apply=True, out=quiet)
    assert again["encrypt"] == 0 and again["reseal"] == 0 and again["current"] >= 3  # idempotent
    with SessionLocal() as db:
        assert fc.token_key_id(_raw(db, "addresses", "street", ids[0])) == "k1"
        assert fc.token_key_id(_raw(db, "library_shapes", "dxf_blob", ids[2])) == "k1"
        assert db.get(LibraryShape, ids[2]).dxf_blob == b"0\nSECTION\n2\nENTITIES"
        assert db.get(AuditLog, ids[1]).detail == {"to": "m@test.invalid"}
    # Schlüsselwechsel
    keys(f"{K2},{K1}")
    rot = fieldmigrate.run(apply=True, out=quiet)
    assert rot["reseal"] >= 3
    with SessionLocal() as db:
        assert fc.token_key_id(_raw(db, "addresses", "street", ids[0])) == "k2"
    keys(K2)                                             # alter Schlüssel darf jetzt weg
    fieldmigrate.run(verify=True, apply=False, out=quiet)
    # Rückweg
    fieldmigrate.run(apply=True, decrypt=True, out=quiet)
    keys("")
    with SessionLocal() as db:
        assert _raw(db, "addresses", "street", ids[0]) == "Migrationsstr. 9"
        assert db.get(LibraryShape, ids[2]).shape == {"p": [1, 2]}


def test_migration_refuses_without_a_key(plant, keys):
    with pytest.raises(SystemExit):
        fieldmigrate.run(apply=True, out=lambda *_: None)


# ---- Suchen, Anmeldung, Löschung -----------------------------------------------

def test_login_search_and_orders_still_work_with_encryption_on(client, keys, plant):
    from gimel import demo
    keys(K1)
    r = client.post("/api/auth/login", data={"username": demo.ADMIN_EMAIL, "password": plant})
    assert r.status_code == 200
    assert client.get("/api/admin/orders").json()["total"] >= 8
    assert client.get("/api/customers", params={"q": "a"}).status_code == 200


def test_erasure_finds_mentions_inside_sealed_audit_detail(plant, keys):
    from gimel.db import SessionLocal
    from gimel.models import AuditLog
    from gimel.services.erasure import erase_user
    keys(K1)
    with SessionLocal() as db:
        u = _user(db)
        mail = u.email
        db.add(AuditLog(actor="staff@test.invalid", action="note", entity="order", entity_id="1",
                        detail={"text": f"Rückfrage an {mail} wegen Termin"}))
        db.commit()
        pseudo = erase_user(db, u)
        db.commit()
        hits = [r for r in db.query(AuditLog).all() if mail in json.dumps(r.detail or {})]
        assert hits == [] and pseudo.startswith("user:")
        assert any(pseudo in json.dumps(r.detail or {}) for r in db.query(AuditLog).all())


SPOOF = "fe1:k9:" + "A" * 60


def test_plaintext_shaped_like_a_token_cannot_block_a_read_without_a_key(keys):
    keys("")
    for typed in (SPOOF, "fe0:" + SPOOF):
        stored = fc.encrypt_text("addresses.street", typed)
        assert fc.decrypt_text("addresses.street", stored) == typed
        assert fc.decrypt_json("orders.ship_address", fc.encrypt_json("orders.ship_address", typed)) == typed
    blob = SPOOF.encode()
    assert fc.decrypt_bytes("library_shapes.dxf_blob", fc.encrypt_bytes("library_shapes.dxf_blob", blob)) == blob


def test_token_shaped_plaintext_survives_when_a_key_arrives_later(keys):
    keys("")
    stored = fc.encrypt_text("addresses.street", SPOOF)
    keys(K1)
    assert fc.decrypt_text("addresses.street", stored) == SPOOF
    assert fc.decrypt_text("addresses.street", fc.encrypt_text("addresses.street", SPOOF)) == SPOOF
