"""Gimel Account Manager — username + password accounts and first-run setup."""

from __future__ import annotations

from gimel.db import SessionLocal
from gimel.models import Role, User


def _login(client, username: str, password: str):
    return client.post(
        "/api/auth/login",
        data={"username": username, "password": password},
    )


def test_username_only_account_lifecycle(client):
    # Create plain username + password account (no email required)
    r = client.post(
        "/api/accounts",
        json={"username": "Schicht1", "password": "Werkbank-42!", "role": "staff"},
    )
    assert r.status_code == 201, r.text
    acc = r.json()
    assert acc["username"] == "schicht1"
    assert acc["role"] == "staff"
    assert acc["active"] is True
    uid = acc["id"]

    # Login with plain username + password
    r_login = _login(client, "schicht1", "Werkbank-42!")
    assert r_login.status_code == 200, r_login.text
    token = r_login.json()["access_token"]
    user_headers = {"Authorization": f"Bearer {token}"}

    # List accounts as admin (team-only default excludes customer accounts)
    r_list = client.get("/api/accounts", params={"q": "schicht"})
    assert r_list.status_code == 200
    rows = r_list.json()
    assert any(row["username"] == "schicht1" and row["active_sessions"] >= 1 for row in rows)
    assert all(row["role"] != "customer" for row in rows)

    # Summary KPIs
    r_sum = client.get("/api/accounts/summary")
    assert r_sum.status_code == 200
    sdata = r_sum.json()
    assert sdata["total"] >= 2 and sdata["admins"] >= 1 and sdata["active_sessions"] >= 1

    # Inspect sessions & force logout all devices
    r_sess = client.get(f"/api/accounts/{uid}/sessions")
    assert r_sess.status_code == 200
    assert len(r_sess.json()) >= 1
    r_out = client.post(f"/api/accounts/{uid}/logout-all")
    assert r_out.status_code == 200
    assert r_out.json()["revoked"] >= 1
    assert client.get("/api/auth/me", headers=user_headers).status_code == 401

    # Audit log for account
    r_aud = client.get(f"/api/accounts/{uid}/audit")
    assert r_aud.status_code == 200
    actions = {row["action"] for row in r_aud.json()}
    assert "account_create" in actions and "account_logout_all" in actions

    # Sign back in for self-service password test
    r_login2 = _login(client, "schicht1", "Werkbank-42!")
    assert r_login2.status_code == 200
    user_headers = {"Authorization": f"Bearer {r_login2.json()['access_token']}"}

    # Self-service password change
    r_self = client.post(
        "/api/accounts/me/password",
        headers=user_headers,
        json={"current_password": "Werkbank-42!", "new_password": "Hobel-Platte-99"},
    )
    assert r_self.status_code == 204
    assert _login(client, "schicht1", "Werkbank-42!").status_code == 401
    assert _login(client, "schicht1", "Hobel-Platte-99").status_code == 200

    # Rename & change role
    r_patch = client.patch(
        f"/api/accounts/{uid}",
        json={"username": "schicht_a", "role": "worker"},
    )
    assert r_patch.status_code == 200
    assert r_patch.json()["username"] == "schicht_a"
    assert r_patch.json()["role"] == "worker"

    # Admin password reset revokes prior tokens and sets new password
    r_pw = client.post(
        f"/api/accounts/{uid}/password",
        json={"password": "Laser-Ring-77"},
    )
    assert r_pw.status_code == 204
    assert _login(client, "schicht_a", "Laser-Ring-77").status_code == 200

    # Disable blocks login; re-enable restores it
    r_dis = client.patch(f"/api/accounts/{uid}", json={"active": False})
    assert r_dis.status_code == 200
    assert _login(client, "schicht_a", "Laser-Ring-77").status_code == 403

    r_en = client.patch(f"/api/accounts/{uid}", json={"active": True})
    assert r_en.status_code == 200
    assert _login(client, "schicht_a", "Laser-Ring-77").status_code == 200

    # Delete account without orders
    r_del = client.delete(f"/api/accounts/{uid}")
    assert r_del.status_code == 200
    assert r_del.json()["action"] == "deleted"


def test_setup_endpoint_only_open_when_empty(client):
    # Demo DB already has users -> needs_setup is False and POST /setup returns 409
    r_st = client.get("/api/accounts/setup-status")
    assert r_st.status_code == 200
    assert r_st.json()["needs_setup"] is False
    assert r_st.json()["localnet_only"] is True

    r_closed = client.post(
        "/api/accounts/setup",
        json={"username": "firstadmin", "password": "Super-Password-99"},
    )
    assert r_closed.status_code == 409


def test_account_validation_rejects_bad_usernames(client):
    r_bad = client.post(
        "/api/accounts",
        json={"username": "bad user!", "password": "Werkbank-42!", "role": "staff"},
    )
    assert r_bad.status_code == 400

    r_short = client.post(
        "/api/accounts",
        json={"username": "a", "password": "Werkbank-42!", "role": "staff"},
    )
    assert r_short.status_code == 422


def test_cannot_delete_last_active_admin(client):
    with SessionLocal() as db:
        admins = db.query(User).filter(User.role == Role.admin, User.active.is_(True)).all()
    if len(admins) == 1:
        r = client.delete(f"/api/accounts/{admins[0].id}")
        assert r.status_code == 409
