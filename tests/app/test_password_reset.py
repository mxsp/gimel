"""Passwort vergessen, neutrale Sperre, zwei Reibungen weniger (roadmap task 47 C).

Was hier festgehalten wird, in Sätzen:

- Die Anfrage antwortet für jede Adresse gleich — unbekannt, Kunde, inaktiv,
  Mitarbeiter — und rechnet auf jedem Zweig einen bcrypt-Lauf. Einen Code
  bekommt nur ein aktives Kundenkonto, höchstens einmal je Minute und fünfmal
  je Stunde.
- Ein Code gilt einmal, 15 Minuten und fünf Versuche lang; danach ist er tot,
  auch mit der richtigen Ziffernfolge.
- Zurücksetzen meldet nicht an: Sitzungen enden, die Sperre fällt, die Adresse
  gilt als bestätigt, und ein eingeschalteter zweiter Faktor wird danach
  weiter verlangt.
- Ein pausiertes Konto antwortet wie eine unbekannte Adresse; über das
  Portal wird ein Mitarbeiterkonto weder geprüft noch gezählt.
- Passwortwechsel behält die eigene Sitzung; ein schon benutzter TOTP-Code
  sagt, dass man auf den nächsten warten muss.
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta, timezone

import pytest

from gimel.config import get_settings
from gimel.db import SessionLocal
from gimel.models import AuditLog, AuthSession, PasswordReset, Role, User
from gimel.routers import auth as auth_router
from gimel.security import hash_password
from gimel.services import mfa, smtp_client, totp

PW = "fichte-ahorn-buche-42"
NEW_PW = "linde-erle-kastanie-77"


@pytest.fixture()
def anon(plant):
    """Ein Client ohne Anmeldung — wie ein Browser vor der Anmeldemaske."""
    from fastapi.testclient import TestClient

    from gimel.app import create_app

    return TestClient(create_app())


@pytest.fixture()
def mails(monkeypatch):
    sent: list[dict] = []

    def fake_send(**kw):
        sent.append(kw)
        return True

    monkeypatch.setattr(smtp_client, "send", fake_send)
    return sent


def _user(role: Role = Role.customer, active: bool = True) -> str:
    email = f"reset-{role.value}-{secrets.token_hex(4)}@example.test"
    with SessionLocal() as db:
        db.add(User(email=email, name="Rita Rücksetz", role=role, active=active,
                    password_hash=hash_password(PW), email_verified=False))
        db.commit()
    return email


def _row(email: str) -> User:
    with SessionLocal() as db:
        u = db.query(User).filter(User.email == email).one()
        db.expunge(u)
        return u


def _code(mail: dict) -> str:
    m = re.search(r"Passworts: (\d{8})\.", mail["text"])
    assert m, mail["text"]
    return m.group(1)


def _request(c, email: str):
    return c.post("/api/auth/reset/request", json={"email": email})


def _confirm(c, email: str, code: str, pw: str = NEW_PW):
    return c.post("/api/auth/reset/confirm", json={"email": email, "code": code, "new_password": pw})


def _login(c, email: str, pw: str = PW):
    return c.post("/api/auth/login", data={"username": email, "password": pw})


# --------------------------------------------------------------------------- Anfrage


def test_request_answers_the_same_for_every_kind_of_address(anon, mails, monkeypatch):
    work: list[str] = []
    real = auth_router.hash_password
    monkeypatch.setattr(auth_router, "hash_password", lambda s: work.append("bcrypt") or real(s))

    kinds = {
        "unbekannt": f"niemand-{secrets.token_hex(4)}@example.test",
        "kunde": _user(),
        "inaktiv": _user(active=False),
        "mitarbeiter": _user(Role.staff),
        "admin": _user(Role.admin),
        "keine adresse": "kein-at-zeichen",
    }
    answers = {}
    for kind, email in kinds.items():
        work.clear()
        r = _request(anon, email)
        answers[kind] = (r.status_code, r.json())
        assert work == ["bcrypt"], f"{kind}: genau ein bcrypt-Lauf je Zweig, war {work}"
    assert len(set(map(repr, answers.values()))) == 1, answers
    assert answers["kunde"][0] == 202
    # Und nur der aktive Kunde bekommt Post.
    assert [m["to"] for m in mails] == [kinds["kunde"]]
    assert "Er gilt 15 Minuten" in mails[0]["text"]
    assert "können Sie diese E-Mail ignorieren" in mails[0]["text"]
    assert mails[0]["background"] is True


def test_request_is_limited_per_address_without_a_different_answer(anon, mails):
    email = _user()
    first, second = _request(anon, email), _request(anon, email)
    assert first.json() == second.json() and second.status_code == 202
    assert len(mails) == 1, "höchstens ein Code je Minute"

    # Fünf in der letzten Stunde (älter als eine Minute) — der sechste geht nicht raus.
    with SessionLocal() as db:
        u = db.query(User).filter(User.email == email).one()
        old = datetime.now(timezone.utc) - timedelta(minutes=20)
        for row in db.query(AuditLog).filter(AuditLog.actor == email,
                                             AuditLog.action == "password_reset_request"):
            row.at = old
        for _ in range(4):
            db.add(AuditLog(actor=email, action="password_reset_request", entity="user",
                            entity_id=str(u.id), at=old))
        db.commit()
    assert _request(anon, email).status_code == 202
    assert len(mails) == 1, "höchstens fünf Codes je Stunde"


def test_code_is_stored_only_as_hash_and_only_the_newest_counts(anon, mails):
    email = _user()
    _request(anon, email)
    old_code = _code(mails[-1])
    with SessionLocal() as db:
        uid = db.query(User.id).filter(User.email == email).scalar()
        row = db.query(PasswordReset).filter(PasswordReset.user_id == uid).one()
        assert old_code not in row.code_hash and row.code_hash.startswith("$2")
        exp = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=timezone.utc)
        assert timedelta(minutes=14) < exp - datetime.now(timezone.utc) <= timedelta(minutes=15)
        # Die Minutensperre aufheben, um einen zweiten Code anzufordern.
        for a in db.query(AuditLog).filter(AuditLog.actor == email):
            a.at = datetime.now(timezone.utc) - timedelta(minutes=5)
        db.commit()
    _request(anon, email)
    new_code = _code(mails[-1])
    if new_code != old_code:
        assert _confirm(anon, email, old_code).status_code == 400
    assert _confirm(anon, email, new_code).status_code == 200


# --------------------------------------------------------------------------- Bestätigung


def test_reset_sets_the_password_ends_sessions_clears_the_lock_and_does_not_sign_in(anon, mails):
    email = _user()
    signed_in = _login(anon, email)
    assert signed_in.status_code == 200
    old_token = signed_in.json()["access_token"]
    # Pausiert nach fünf Fehlversuchen …
    for _ in range(5):
        _login(anon, email, "ganz-falsch-123")
    assert _row(email).locked_until is not None

    _request(anon, email)
    r = _confirm(anon, email, _code(mails[-1]))
    assert r.status_code == 200, r.text
    assert r.json()["reset"] is True
    assert "access_token" not in r.json(), "Zurücksetzen meldet nicht an"
    assert "set-cookie" not in {k.lower() for k in r.headers}

    u = _row(email)
    assert u.locked_until is None and (u.failed_login_count or 0) == 0
    assert u.email_verified is True
    assert anon.get("/api/account/me", headers={"Authorization": f"Bearer {old_token}"}).status_code == 401
    with SessionLocal() as db:
        assert db.query(AuthSession).filter(AuthSession.user_id == u.id,
                                            AuthSession.revoked_at.is_(None)).count() == 0
        actions = [a.action for a in db.query(AuditLog).filter(AuditLog.actor == email)]
    assert "password_reset_self" in actions
    assert _login(anon, email).status_code == 401
    assert _login(anon, email, NEW_PW).status_code == 200


def test_code_works_once(anon, mails):
    email = _user()
    _request(anon, email)
    code = _code(mails[-1])
    assert _confirm(anon, email, code).status_code == 200
    again = _confirm(anon, email, code, "noch-ein-neues-pass-91")
    assert again.status_code == 400
    assert again.json()["detail"] == auth_router.RESET_INVALID


def test_code_is_dead_after_five_wrong_tries(anon, mails):
    email = _user()
    _request(anon, email)
    code = _code(mails[-1])
    wrong = f"{(int(code) + 1) % 10 ** 8:08d}"
    for _ in range(5):
        assert _confirm(anon, email, wrong).status_code == 400
    r = _confirm(anon, email, code)
    assert r.status_code == 400 and r.json()["detail"] == auth_router.RESET_INVALID
    assert _login(anon, email).status_code == 200, "das alte Passwort gilt weiter"


def test_expired_code_is_refused(anon, mails):
    email = _user()
    _request(anon, email)
    code = _code(mails[-1])
    with SessionLocal() as db:
        uid = db.query(User.id).filter(User.email == email).scalar()
        db.query(PasswordReset).filter(PasswordReset.user_id == uid).update(
            {"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)})
        db.commit()
    r = _confirm(anon, email, code)
    assert r.status_code == 400 and r.json()["detail"] == auth_router.RESET_INVALID


def test_confirm_answers_the_same_for_unknown_staff_and_wrong(anon, mails):
    staff, customer = _user(Role.staff), _user()
    _request(anon, customer)
    answers = [
        _confirm(anon, f"niemand-{secrets.token_hex(4)}@example.test", "12345678"),
        _confirm(anon, staff, "12345678"),
        _confirm(anon, _user(), "12345678"),  # Kunde ohne Code
        _confirm(anon, customer, "1234"),
    ]
    assert {(r.status_code, r.json()["detail"]) for r in answers} == {(400, auth_router.RESET_INVALID)}


def test_weak_password_keeps_the_code_but_costs_a_try(anon, mails):
    email = _user()
    _request(anon, email)
    code = _code(mails[-1])
    r = _confirm(anon, email, code, "password")
    assert r.status_code == 400 and "Rateliste" in r.json()["detail"]
    assert _confirm(anon, email, code).status_code == 200


def test_second_factor_is_still_asked_after_a_reset(anon, mails):
    email = _user()
    tok = _login(anon, email).json()["access_token"]
    head = {"Authorization": f"Bearer {tok}"}
    secret = anon.post("/api/account/2fa/start", headers=head,
                       json={"current_password": PW}).json()["secret"]
    assert anon.post("/api/account/2fa/enable", headers=head,
                     json={"code": totp.code(secret)}).status_code == 200

    _request(anon, email)
    assert _confirm(anon, email, _code(mails[-1])).status_code == 200
    after = _login(anon, email, NEW_PW)
    assert after.status_code == 200
    assert after.json()["mfa_required"] is True and after.json()["access_token"] == ""


# --------------------------------------------------------------------------- Neutrale Sperre


def test_locked_account_answers_like_an_unknown_one(anon, mails):
    email = _user()
    for _ in range(5):
        _login(anon, email, "ganz-falsch-123")
    locked = _login(anon, email)  # richtiges Passwort, aber pausiert
    unknown = _login(anon, f"niemand-{secrets.token_hex(4)}@example.test")
    wrong = _login(anon, _user(), "ganz-falsch-123")
    assert locked.status_code == unknown.status_code == wrong.status_code == 401
    assert locked.json() == unknown.json() == wrong.json() == {"detail": auth_router.LOGIN_FAILED}

    # Genau eine Hinweis-Mail je Sperre, mit dem Weg zum Zurücksetzen.
    notices = [m for m in mails if m["to"] == email]
    assert len(notices) == 1 and "Passwort vergessen?" in notices[0]["text"]
    with SessionLocal() as db:
        u = db.query(User).filter(User.email == email).one()
        u.locked_until = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    for _ in range(5):
        _login(anon, email, "ganz-falsch-123")
    assert len([m for m in mails if m["to"] == email]) == 1, "höchstens eine je Stunde"


def test_staff_through_the_portal_is_neither_checked_nor_counted(anon, monkeypatch):
    token = "p" * 40
    monkeypatch.setattr(get_settings(), "portal_token", token)
    portal = {"x-alpha-portal-token": token}
    staff = _user(Role.staff)
    for _ in range(7):
        r = anon.post("/api/auth/login", data={"username": staff, "password": "falsch-falsch"},
                      headers=portal)
        assert r.status_code == 401 and r.json()["detail"] == auth_router.LOGIN_FAILED
    right = anon.post("/api/auth/login", data={"username": staff, "password": PW}, headers=portal)
    assert right.status_code == 401, "Mitarbeiter melden sich nicht über das Portal an"
    u = _row(staff)
    assert (u.failed_login_count or 0) == 0 and u.locked_until is None
    # Intern (ohne Portalkennung) kommt das Konto weiter hinein …
    assert _login(anon, staff).status_code == 200
    # … ein falsches Geheimnis zählt wie intern, und Kunden kommen über das Portal hinein.
    customer = _user()
    assert anon.post("/api/auth/login", data={"username": customer, "password": PW},
                     headers=portal).status_code == 200
    anon.post("/api/auth/login", data={"username": staff, "password": "falsch"},
              headers={"x-alpha-portal-token": "q" * 40})
    assert _row(staff).failed_login_count == 1


# --------------------------------------------------------------------------- Reibung


def test_password_change_keeps_this_session_and_ends_the_others(plant):
    from fastapi.testclient import TestClient

    from gimel.app import create_app

    email = _user()
    here, there = TestClient(create_app()), TestClient(create_app())
    tok = _login(here, email).json()["access_token"]
    other = _login(there, email).json()["access_token"]
    r = here.post("/api/auth/password", headers={"Authorization": f"Bearer {tok}"},
                  json={"current_password": PW, "new_password": NEW_PW})
    assert r.status_code == 204, r.text
    assert here.get("/api/account/me", headers={"Authorization": f"Bearer {tok}"}).status_code == 200
    assert here.post("/api/auth/refresh").status_code == 200, "der Tab bleibt angemeldet"
    assert there.get("/api/account/me", headers={"Authorization": f"Bearer {other}"}).status_code == 401
    assert there.post("/api/auth/refresh").status_code == 401


def test_a_just_used_totp_code_says_wait_for_the_next(anon):
    email = _user()
    head = {"Authorization": f"Bearer {_login(anon, email).json()['access_token']}"}
    secret = anon.post("/api/account/2fa/start", headers=head,
                       json={"current_password": PW}).json()["secret"]
    used = totp.code(secret)
    assert anon.post("/api/account/2fa/enable", headers=head, json={"code": used}).status_code == 200

    ticket = _login(anon, email).json()["mfa_token"]
    r = anon.post("/api/auth/2fa", json={"mfa_token": ticket, "code": used})
    assert r.status_code == 401 and r.json()["detail"] == mfa.REPLAYED
    assert _row(email).mfa_failed_count == 1, "zählt weiter als Fehlversuch"
    wrong = anon.post("/api/auth/2fa", json={"mfa_token": ticket, "code": "000000" if used != "000000" else "111111"})
    assert wrong.json()["detail"] == "Der Code stimmt nicht."


def test_replayed_is_pure_and_only_matches_spent_slots():
    secret = totp.new_secret()
    now = totp.slot()
    code = totp.code_at(secret, now)
    assert totp.replayed(secret, code, last_slot=now, at=now * totp.PERIOD)
    assert not totp.replayed(secret, code, last_slot=now - 1, at=now * totp.PERIOD)
    assert not totp.replayed(secret, code, last_slot=None, at=now * totp.PERIOD)
    assert not totp.replayed(secret, "12", last_slot=now, at=now * totp.PERIOD)


def test_reset_lifts_the_password_lock_but_keeps_the_2fa_lock(anon, mails):
    """Sicherheitsprüfung 2026-11-15: wer nur das Postfach hat, bekommt durch einen
    Reset keine frischen 2FA-Versuche. Die Passwortsperre fällt, die 2FA-Sperre bleibt."""
    email = _user()
    until = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=1)
    with SessionLocal() as db:
        u = db.query(User).filter(User.email == email).one()
        u.failed_login_count, u.locked_until = 5, until
        u.mfa_failed_count, u.mfa_locked_until = 5, until
        db.commit()
    assert _request(anon, email).status_code == 202
    assert _confirm(anon, email, _code(mails[-1])).status_code == 200
    after = _row(email)
    assert after.failed_login_count == 0 and after.locked_until is None
    assert after.mfa_failed_count == 5 and after.mfa_locked_until is not None


def test_erasure_takes_open_reset_codes_along(anon, mails):
    from gimel.services import erasure

    email = _user()
    assert _request(anon, email).status_code == 202
    with SessionLocal() as db:
        u = db.query(User).filter(User.email == email).one()
        assert db.query(PasswordReset).filter(PasswordReset.user_id == u.id).count() == 1
        erasure.erase_user(db, u)
        db.commit()
        assert db.query(PasswordReset).filter(PasswordReset.user_id == u.id).count() == 0
