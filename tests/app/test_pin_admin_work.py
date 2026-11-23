"""Das gemeinsame PIN-Konto pflegt die Betriebs-Bildschirme; Benutzer und Rollen bleiben beim Admin."""

from __future__ import annotations

import pytest

from gimel.config import get_settings
from gimel.db import SessionLocal
from gimel.models import AuditLog, FactoryStation, Role, User
from gimel.security import create_access_token, has_admin_work


def _head(email: str, role: Role, active: bool = True) -> dict:
    with SessionLocal() as db:
        u = db.query(User).filter(User.email == email).first()
        if u is None:
            u = User(email=email, name="Test", role=role, password_hash="x", active=active)
            db.add(u)
            db.commit()
        return {"Authorization": f"Bearer {create_access_token(u)}"}


@pytest.fixture
def pin():
    return _head(get_settings().gimel_account.strip().lower(), Role.staff)


@pytest.fixture
def staff():
    return _head("meister@example.test", Role.staff)


@pytest.fixture
def worker():
    return _head("werker-pin@example.test", Role.worker)


def _station() -> dict:
    with SessionLocal() as db:
        s = db.query(FactoryStation).first()
    return {"label": "PIN-Platz", "type": s.type.value, "x": 1.0, "y": 1.0}


def _calls(client, head):
    """Jede verschobene Route einmal; liefert die Statuscodes."""
    floor = client.get("/api/factory/floor").json()
    periods = client.get("/api/compliance/support-periods").json()["support_periods"]
    seller = client.get("/api/invoicing/seller").json()["values"]
    out = {
        "put_floor": client.put("/api/factory/floor", json=floor, headers=head).status_code,
        "put_setting": client.put("/api/factory/settings/w_pin", json={"value": "1"}, headers=head).status_code,
        "admin_setting": client.put("/api/admin/settings/batch_mode", json={"value": "sammel"}, headers=head).status_code,
        "get_seller": client.get("/api/invoicing/seller", headers=head).status_code,
        "put_seller": client.put("/api/invoicing/seller", json=seller, headers=head).status_code,
        "support": client.put("/api/compliance/admin/support-periods", json=periods, headers=head).status_code,
        "dxf": client.post("/api/factory/floor/outline/from-dxf", files={"file": ("a.dxf", b"0\nEOF\n")},
                           headers=head).status_code,
    }
    r = client.post("/api/factory/stations", json=_station(), headers=head)
    out["post_station"] = r.status_code
    sid = r.json().get("id") if r.status_code < 300 else client.post("/api/factory/stations", json=_station()).json()["id"]
    out["put_station"] = client.put(f"/api/factory/stations/{sid}", json=_station(), headers=head).status_code
    out["delete_station"] = client.delete(f"/api/factory/stations/{sid}", headers=head).status_code
    if out["delete_station"] == 403:
        client.delete(f"/api/factory/stations/{sid}")
    return out


def test_the_pin_account_does_the_admin_work(client, pin):
    codes = _calls(client, pin)
    assert codes["dxf"] != 403
    assert {k: v for k, v in codes.items() if k != "dxf"} == {
        "put_floor": 200, "put_setting": 200, "admin_setting": 200, "get_seller": 200, "put_seller": 200,
        "support": 200, "post_station": 200, "put_station": 200, "delete_station": 204}, codes
    with SessionLocal() as db:
        line = db.query(AuditLog).filter(AuditLog.action == "factory_setting", AuditLog.entity_id == "w_pin").first()
        assert line and line.actor == get_settings().gimel_account.strip().lower()


def test_plain_staff_and_workers_still_get_403(client, staff, worker):
    for head in (staff, worker):
        codes = _calls(client, head)
        assert set(codes.values()) == {403}, codes


def test_the_pin_account_passes_user_management_too(client, pin, staff, worker):
    calls = (
        ("get", "/api/users", {}), ("get", "/api/users/customers", {}), ("get", "/api/users/1/orders", {}),
        ("post", "/api/users/1/unlock", {}),
    )
    for method, path, kw in calls:
        assert getattr(client, method)(path, headers=pin, **kw).status_code in (200, 404), path
    r = client.post("/api/users", headers=pin, json={"email": "neu-pin@musterwerk.example", "name": "Neu",
                                                      "password": "Abcdefgh1234!xyz", "role": "worker"})
    assert r.status_code == 201, r.text
    uid = r.json()["id"]
    assert client.patch(f"/api/users/{uid}", headers=pin, json={"name": "Neu2"}).status_code == 200
    assert client.post(f"/api/users/{uid}/password", headers=pin, json={"password": "Abcdefgh1234!xyz"}).status_code == 204
    assert client.post(f"/api/users/{uid}/mfa/reset", headers=pin).status_code in (200, 400, 404, 409)
    assert client.delete(f"/api/users/{uid}", headers=pin).status_code in (200, 204)
    for head in (staff, worker):
        for method, path in (("get", "/api/users"), ("get", "/api/users/customers"), ("post", "/api/users/1/unlock"),
                             ("delete", "/api/users/1"), ("patch", "/api/users/1")):
            assert getattr(client, method)(path, headers=head).status_code == 403, path


def test_the_flag_is_for_admin_and_the_pin_account_only(client):
    with SessionLocal() as db:
        admin = db.query(User).filter(User.role == Role.admin).first()
        assert has_admin_work(admin)
        mail = get_settings().gimel_account.strip().lower()
        pin = User(email=mail, name="P", role=Role.staff, password_hash="x", active=True)
        assert has_admin_work(pin)
        pin.active = False
        assert not has_admin_work(pin)
        pin.active, pin.role = True, Role.worker
        assert not has_admin_work(pin)
        assert not has_admin_work(User(email="a@example.test", name="a", role=Role.staff, password_hash="x", active=True))


def test_the_pin_session_is_admin_in_effect_and_staff_in_the_database(client, monkeypatch):
    from gimel.security import hash_password
    s = get_settings()
    monkeypatch.setattr(s, "gimel_pin_hash", hash_password("4711-test-pin"), raising=False)
    r = client.post("/api/auth/pin", json={"pin": "4711-test-pin"}, headers={"Authorization": ""})
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "staff" and r.json()["admin_work"] is True
    tok = r.json()["access_token"]
    assert client.get("/api/users", headers={"Authorization": f"Bearer {tok}"}).status_code == 200
    assert client.get("/api/factory/floor", headers={"Authorization": f"Bearer {tok}"}).status_code == 200
