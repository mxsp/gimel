"""Meine Formen am Konto (roadmap task 47 C): ``/api/account/parts``.

Die Bibliothek gehört dem Konto, nicht dem Browser. Jede Zeile trägt die
Kennung ihres Besitzers; eine fremde Kennung antwortet wie eine, die es nicht
gibt. Grenzen: 256 KB Kontur, 500 Formen je Konto. Jede Änderung hinterlässt
eine Protokollzeile ohne Namen und Kontur.
"""

from __future__ import annotations

import secrets

import pytest

from gimel.db import SessionLocal
from gimel.models import AuditLog, PartGeometry, Role, User
from gimel.routers import account as account_router
from gimel.security import create_access_token, hash_password
from gimel.services import erasure

RING = {"t": "Flansch DN 50", "mat": "epdm-70", "thk": 2, "od": 107, "di": 61,
        "bn": 4, "bc": 125, "bd": 18, "fam": "EN 1514-1"}
POLY = {"t": "Deckel", "mat": "fkm-75", "thk": 3, "od": 200, "di": 0, "cutLen": 812.5,
        "shape": {"outer": {"kind": "poly", "pts": [[0, 0], [200, 0], [200, 120], [0, 120]]},
                  "holes": []}}


@pytest.fixture()
def anon(plant):
    from fastapi.testclient import TestClient

    from gimel.app import create_app

    return TestClient(create_app())


def _account(role: Role = Role.customer) -> tuple[int, str, dict]:
    email = f"parts-{secrets.token_hex(4)}@example.test"
    with SessionLocal() as db:
        u = User(email=email, name="Paula Teil", role=role, active=True,
                 password_hash=hash_password("weide-pappel-esche-55"))
        db.add(u)
        db.commit()
        return u.id, email, {"Authorization": f"Bearer {create_access_token(u)}"}


def _actions(email: str) -> list[tuple[str, str, dict]]:
    with SessionLocal() as db:
        return [(a.action, a.entity_id, a.detail or {}) for a in
                db.query(AuditLog).filter(AuditLog.actor == email).order_by(AuditLog.id)]


def test_needs_a_signed_in_account(anon):
    assert anon.get("/api/account/parts").status_code == 401
    assert anon.post("/api/account/parts", json=RING).status_code == 401


def test_create_list_get_patch_delete_round_trip(anon):
    _, email, head = _account()
    r = anon.post("/api/account/parts", headers=head, json=RING)
    assert r.status_code == 201, r.text
    ring = r.json()
    assert {k: ring[k] for k in RING} == {**RING, "thk": 2.0, "od": 107.0, "di": 61.0,
                                          "bc": 125.0, "bd": 18.0}
    assert ring["source"] == "NORM" and len(ring["fingerprint"]) == 64

    poly = anon.post("/api/account/parts", headers=head, json={**POLY, "source": "dxf"}).json()
    assert poly["source"] == "DXF" and poly["shape"] == POLY["shape"]

    listed = anon.get("/api/account/parts", headers=head).json()
    assert [p["id"] for p in listed] == [poly["id"], ring["id"]], "neueste zuerst"
    assert anon.get(f"/api/account/parts/{ring['id']}", headers=head).json() == ring

    r = anon.patch(f"/api/account/parts/{ring['id']}", headers=head, json={"t": "Flansch DN 50 neu"})
    assert r.status_code == 200 and r.json()["t"] == "Flansch DN 50 neu"
    assert r.json()["fingerprint"] == ring["fingerprint"], "der Name ist nicht die Form"
    r = anon.patch(f"/api/account/parts/{ring['id']}", headers=head, json={"thk": 3})
    assert r.json()["thk"] == 3.0 and r.json()["fingerprint"] != ring["fingerprint"]
    r = anon.patch(f"/api/account/parts/{poly['id']}", headers=head, json={"shape": None})
    assert r.status_code == 200 and r.json()["shape"] is None

    assert anon.delete(f"/api/account/parts/{ring['id']}", headers=head).status_code == 204
    assert anon.get(f"/api/account/parts/{ring['id']}", headers=head).status_code == 404
    assert [p["id"] for p in anon.get("/api/account/parts", headers=head).json()] == [poly["id"]]

    log = _actions(email)
    assert [a for a, _, _ in log] == ["part_create", "part_create", "part_update", "part_update",
                                      "part_update", "part_delete"]
    for _, _, detail in log:
        flat = repr(detail)
        assert "Flansch" not in flat and "pts" not in flat, "kein Name, keine Kontur im Protokoll"


def test_same_shape_twice_is_one_shape(anon):
    _, email, head = _account()
    first = anon.post("/api/account/parts", headers=head, json=RING)
    again = anon.post("/api/account/parts", headers=head, json={**RING, "t": "anderer Name"})
    assert first.status_code == 201 and again.status_code == 200
    assert again.json()["id"] == first.json()["id"]
    assert len(anon.get("/api/account/parts", headers=head).json()) == 1
    assert [a for a, _, _ in _actions(email)] == ["part_create"], "kein Protokoll ohne Änderung"

    other = anon.post("/api/account/parts", headers=head, json={**RING, "thk": 4}).json()
    r = anon.patch(f"/api/account/parts/{other['id']}", headers=head, json={"thk": 2})
    assert r.status_code == 409


def test_other_accounts_parts_answer_404(anon):
    _, _, owner = _account()
    _, intruder_email, intruder = _account()
    part = anon.post("/api/account/parts", headers=owner, json=POLY).json()
    pid = part["id"]
    assert anon.get(f"/api/account/parts/{pid}", headers=intruder).status_code == 404
    assert anon.patch(f"/api/account/parts/{pid}", headers=intruder, json={"t": "meins"}).status_code == 404
    assert anon.delete(f"/api/account/parts/{pid}", headers=intruder).status_code == 404
    assert anon.get(f"/api/account/parts/{pid + 10 ** 6}", headers=intruder).status_code == 404
    assert anon.get("/api/account/parts", headers=intruder).json() == []
    assert anon.get(f"/api/account/parts/{pid}", headers=owner).json()["t"] == "Deckel"
    assert _actions(intruder_email) == []
    # Auch ein Mitarbeiterkonto sieht über diesen Weg nur seine eigenen.
    _, _, staff = _account(Role.staff)
    assert anon.get(f"/api/account/parts/{pid}", headers=staff).status_code == 404


def test_shape_size_and_count_caps(anon, monkeypatch):
    _, email, head = _account()
    pts = [[i * 0.5, (i % 7) * 1.25] for i in range(20_000)]
    big = {**POLY, "shape": {"outer": {"kind": "poly", "pts": pts}, "holes": []}}
    r = anon.post("/api/account/parts", headers=head, json=big)
    assert r.status_code == 413 and "256 KB" in r.json()["detail"]
    ok = anon.post("/api/account/parts", headers=head, json=POLY).json()
    assert anon.patch(f"/api/account/parts/{ok['id']}", headers=head,
                      json={"shape": big["shape"]}).status_code == 413

    monkeypatch.setattr(account_router, "PART_MAX_PER_USER", 3)
    for thk in (4, 5):
        assert anon.post("/api/account/parts", headers=head, json={**RING, "thk": thk}).status_code == 201
    full = anon.post("/api/account/parts", headers=head, json={**RING, "thk": 6})
    assert full.status_code == 409 and "voll" in full.json()["detail"]
    # Eine Form, die schon da ist, kommt auch bei voller Bibliothek zurück.
    assert anon.post("/api/account/parts", headers=head, json={**RING, "thk": 4}).status_code == 200


def test_all_shapes_of_an_account_share_one_byte_budget(anon, monkeypatch):
    """Sicherheitsprüfung 2026-11-15: 500 × 256 KB wären ≈ 125 MiB je Konto."""
    uid, _, head = _account()
    first = anon.post("/api/account/parts", headers=head, json=POLY)
    assert first.status_code == 201, first.text
    from sqlalchemy import func
    with SessionLocal() as db:
        used = db.query(func.sum(func.length(PartGeometry.shape))).filter(PartGeometry.user_id == uid).scalar()
    # Platz für genau diese eine Kontur: die zweite gleich große passt nicht mehr dazu.
    monkeypatch.setattr(account_router, "PART_BYTES_PER_USER", int(used) + 1)
    second = anon.post("/api/account/parts", headers=head, json={**POLY, "thk": POLY.get("thk", 2) + 1})
    assert second.status_code == 413 and "zusammen" in second.json()["detail"]
    # Ersetzen zählt die alte Kontur nicht doppelt.
    same = anon.patch(f"/api/account/parts/{first.json()['id']}", headers=head, json={"shape": POLY["shape"]})
    assert same.status_code in (200, 409), same.text


def test_bad_input_is_refused(anon):
    _, _, head = _account()
    for body in ({**RING, "thk": -1}, {**RING, "source": "SECRET"}, {**RING, "shape": [1, 2]},
                 {**RING, "t": "x" * 201}, {**RING, "bn": 1.5}):
        assert anon.post("/api/account/parts", headers=head, json=body).status_code == 422, body


def test_label_and_shape_are_stored_encrypted_columns():
    # Die Spaltentypen tragen die Verschlüsselung (fieldcrypt); hier nur, dass
    # die Bibliothek genau diese Spalten benutzt und keine Klartextkopie anlegt.
    cols = PartGeometry.__table__.c
    assert type(cols.label.type).__name__ == "EncryptedText"
    assert type(cols.shape.type).__name__ == "EncryptedJSON"


def test_erasure_removes_the_library(anon):
    uid, _, head = _account()
    anon.post("/api/account/parts", headers=head, json=RING)
    with SessionLocal() as db:
        erasure.erase_user(db, db.get(User, uid))
        db.commit()
        assert db.query(PartGeometry).filter(PartGeometry.user_id == uid).count() == 0
