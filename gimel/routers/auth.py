"""Anmeldung, Registrierung, Token, eigenes Konto."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import AuditLog, AuthSession, PasswordReset, Role, User
from ..schemas import (MfaLogin, PasswordChange, PasswordResetConfirm,
                       PasswordResetRequest, PinLogin, RegisterRequest, Token, UserOut)
from ..services import identity, mfa, pin_guard, smtp_client
from ..security import (
    REFRESH_COOKIE,
    create_access_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    verify_password,
    current_user,
    current_session_id,
    has_admin_work,
    require_internal_email,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])
settings = get_settings()

MAX_FAILED = 5
LOCKOUT_MINUTES = 15

#: Die eine Antwort auf jede abgelehnte Passworteingabe — unbekannte Adresse,
#: falsches Passwort, pausiertes Konto, Mitarbeiterkonto über das Portal. Bis
#: 2026-11 antwortete ein pausiertes Konto 423 „Konto gesperrt", eine
#: unbekannte Adresse 401: wer fünfmal falsch tippte, wusste danach, ob es das
#: Konto gibt (Sicherheitsprüfung 2026-11-13, F1).
LOGIN_FAILED = ("Benutzername oder Passwort falsch. Nach mehreren Fehlversuchen "
                "pausiert die Anmeldung 15 Minuten.")

#: Höchstens eine Pausen-Mail je Konto und Stunde: wer die Sperre absichtlich
#: auslöst, soll damit kein Postfach fluten.
LOCK_NOTICE_HOURS = 1

#: Passwort vergessen: Code per E-Mail, acht Ziffern, kurz gültig, wenige
#: Versuche. 10^8 Möglichkeiten bei fünf Versuchen je Code und fünf Codes je
#: Stunde sind ein Treffer in rund 450 Jahren.
RESET_CODE_MINUTES = 15
RESET_MAX_ATTEMPTS = 5
RESET_PER_HOUR = 5
RESET_KEEP_HOURS = 24
RESET_ACCEPTED = {
    "accepted": True,
    "detail": ("Wenn zu dieser E-Mail-Adresse ein Kundenkonto besteht, ist ein Code "
               "unterwegs. Er gilt 15 Minuten."),
}
RESET_INVALID = "Der Code ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an."

_dummy: str = ""


def _burn(secret: str) -> None:
    """Ein bcrypt-Vergleich ohne Ergebnis — damit „gibt es nicht" so lange
    dauert wie „stimmt nicht". Der Hash entsteht einmal; bis 2026-11 wurde er
    bei jeder unbekannten Adresse neu gerechnet, das waren zwei bcrypt-Läufe
    gegen einen und damit selbst ein Unterschied."""
    global _dummy
    if not _dummy:
        _dummy = hash_password("dummy-password-for-timing")
    verify_password(secret or "", _dummy)


def _login_failed() -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=LOGIN_FAILED)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _from_portal(request: Request) -> bool:
    """Kommt die Anfrage über das öffentliche Bestellportal?

    ``server/api-proxy.mjs`` setzt ``x-alpha-portal-token`` auf jede
    ``/auth/*``-Anfrage und verwirft, was der Browser selbst mitschickt. Ohne
    eingerichtetes Geheimnis ist nichts vom Portal.
    """
    expected = get_settings().portal_token
    got = request.headers.get("x-alpha-portal-token", "")
    return bool(expected and got) and hmac.compare_digest(got.encode(), expected.encode())

#: Lebensdauer des Zwischentickets zwischen Passwort und zweitem Faktor.
#: Lang genug, um eine App zu öffnen und abzutippen; kurz genug, dass ein
#: abgefangenes Ticket wertlos ist, bevor jemand es benutzt.
MFA_TICKET_MINUTES = 5

#: Die zehn Passwörter, die in jedem Wörterbuchangriff zuerst stehen, plus die
#: hausgemachten. Eine vollständige Sperrliste ist Unsinn — sie erzieht zu
#: „Passwort1!" statt zu langen Passphrasen. Der Zweck ist, die Handvoll
#: abzufangen, die sonst wirklich gewählt werden.
_WEAK = {
    "password", "passwort", "12345678", "123456789", "1234567890",
    "qwertzuiop", "qwertyuiop", "alpha123", "dichtung", "geheim12",
    "changeme", "letmein1", "willkommen", "welcome1", "admin123",
}


def check_password_strength(password: str, *, email: str = "", name: str = "") -> None:
    """Mindestgüte prüfen — wirft mit einem Satz, der sagt, was fehlt.

    Bewusst *keine* Zeichenklassen-Vorschrift. Die erzwingt „P@ssw0rt" und
    verbietet „korrektes pferd batterie klammer", was genau verkehrt herum
    ist. Geprüft wird Länge, die offensichtliche Liste, und ob das Passwort
    aus den eigenen Kontodaten besteht — die drei Fälle, in denen ein Konto
    wirklich in Minuten fällt.
    """
    pw = password or ""
    if len(pw) < 8:
        raise HTTPException(status_code=400,
                            detail="Das Passwort braucht mindestens 8 Zeichen.")
    if len(pw) > 200:
        raise HTTPException(status_code=400,
                            detail="Das Passwort ist zu lang (höchstens 200 Zeichen).")
    low = pw.strip().lower()
    if low in _WEAK:
        raise HTTPException(
            status_code=400,
            detail="Dieses Passwort steht auf jeder Rateliste — bitte ein anderes.")
    if len(set(low)) < 4:
        raise HTTPException(
            status_code=400,
            detail="Das Passwort besteht aus zu wenigen verschiedenen Zeichen.")
    local = (email or "").split("@")[0].lower()
    for part in filter(None, [local, (name or "").lower()]):
        if len(part) >= 4 and part in low:
            raise HTTPException(
                status_code=400,
                detail="Das Passwort darf nicht aus E-Mail oder Name bestehen.")


def _set_refresh_cookie(
    resp: Response,
    token: str,
    max_age: int | None = None,
    request: Request | None = None,
) -> None:
    s = get_settings()
    if s.localnet_only:
        is_https = (
            request is not None
            and (
                request.url.scheme == "https"
                or request.headers.get("x-forwarded-proto", "").lower() == "https"
            )
        )
        secure = is_https
    else:
        secure = s.is_production()
    resp.set_cookie(
        REFRESH_COOKIE,
        token,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/api/auth",
        max_age=max_age if max_age is not None else s.refresh_token_days * 86400,
    )


def _clear_refresh_cookie(resp: Response) -> None:
    resp.delete_cookie(REFRESH_COOKIE, path="/api/auth")


def client_ip(request: Request) -> str:
    """Die Adresse des Menschen, nicht die der QEMU-Weiterleitung.

    Hinter dem Pförtner kommt jede Anfrage von 10.0.2.2. Der Pförtner verwirft,
    was der Client als X-Forwarded-For mitbringt, und setzt die Adresse, die
    Cloudflare meldet — geglaubt wird der Kopfzeile nur von ``ALPHA_TRUST_PROXY``.
    """
    peer = request.client.host if request.client else ""
    trusted = {t.strip() for t in get_settings().trust_proxy.split(",") if t.strip()}
    fwd = request.headers.get("x-forwarded-for", "")
    if peer in trusted and fwd:
        return fwd.split(",")[0].strip()[:64]
    return peer


def _create_session(db: Session, user: User, request: Request,
                    lifetime: timedelta | None = None) -> tuple[str, int]:
    """Refresh-Token und die Kennung der Sitzung.

    Die Kennung wandert in das Zugangstoken (``sid``), damit die Kontoseite
    „dieses Gerät" erkennen und beim Aufräumen die eigene Sitzung verschonen
    kann — der Refresh-Cookie kann das nicht leisten, er liegt auf
    ``path=/api/auth``. Siehe security.create_access_token.
    """
    raw = generate_refresh_token()
    hashed = hash_refresh_token(raw)
    sess = AuthSession(
        user_id=user.id,
        refresh_hash=hashed,
        expires_at=datetime.now(timezone.utc)
        + (lifetime or timedelta(days=settings.refresh_token_days)),
        ip=client_ip(request),
        user_agent=request.headers.get("user-agent", "")[:300],
    )
    db.add(sess)
    db.commit()
    mfa.purge_stale_sessions(db)
    return raw, sess.id


@router.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
def register(
    body: RegisterRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> Token:
    email = body.email.strip().lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Diese E-Mail ist bereits registriert.",
        )
    check_password_strength(body.password, email=email, name=body.name)
    user = User(
        email=email,
        password_hash=hash_password(body.password),
        name=body.name.strip(),
        company=body.company.strip(),
        role=Role.customer,
        active=True,
        email_verified=False,
    )
    try:
        db.add(user)
        db.flush()
        db.add(
            AuditLog(actor=email, action="register", entity="user", entity_id=str(user.id))
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Diese E-Mail ist bereits registriert.",
        ) from exc
    raw, sid = _create_session(db, user, request)
    _set_refresh_cookie(response, raw, request=request)
    db.refresh(user)
    return Token(
        access_token=create_access_token(user, sid),
        role=user.role,
        admin_work=has_admin_work(user),
        email=user.email,
        name=user.name,
    )


@router.post("/login", response_model=Token)
def login(
    form: Annotated[OAuth2PasswordRequestForm, Depends()],
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> Token:
    email = form.username.strip().lower()
    user = db.query(User).filter(User.email == email).first()
    # Jede Ablehnung kostet einen bcrypt-Vergleich und sagt denselben Satz.
    if not user:
        _burn(form.password)
        raise _login_failed()
    # Über das öffentliche Portal melden sich nur Kunden an. Für ein
    # Mitarbeiterkonto wird dort weder geprüft noch gezählt: sonst sperrt jeder
    # mit fünf Versuchen das Büro aus (der Pförtner prüft die Rolle erst an der
    # Antwort, gezählt war bis dahin schon).
    if user.role != Role.customer and _from_portal(request):
        _burn(form.password)
        raise _login_failed()
    now = datetime.now(timezone.utc)
    lu = _aware(user.locked_until)
    if lu and lu > now:
        # Pausiert: dieselbe Antwort wie ein falsches Passwort, auch bei einem
        # richtigen. Ein eigener Status verriete, dass es das Konto gibt.
        _burn(form.password)
        raise _login_failed()
    if lu:
        user.failed_login_count = 0
        user.locked_until = None
    if not verify_password(form.password, user.password_hash):
        user.failed_login_count = (user.failed_login_count or 0) + 1
        if user.failed_login_count >= MAX_FAILED:
            user.locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
            db.add(AuditLog(actor=user.email, action="login_locked", entity="user",
                            entity_id=str(user.id)))
            _lock_notice(db, user, now)
        db.commit()
        raise _login_failed()
    if not user.active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Dieses Konto ist gesperrt."
        )
    require_internal_email(user.email, user.role)
    # Passwort stimmt. Der Zähler geht auf null — auch dann, wenn gleich noch
    # der zweite Faktor kommt: gezählt wird das Passwort, und das war richtig.
    user.failed_login_count = 0
    user.locked_until = None

    # ---- Zweiter Faktor -------------------------------------------------
    # Hier entsteht keine Sitzung und kein Zugangstoken, sondern ein Ticket.
    # Der Unterschied ist der ganze Sinn der Übung: wer nur das Passwort hat,
    # bekommt nichts, womit er einen Endpunkt aufrufen könnte.
    if mfa.is_enabled(user):
        left = mfa.locked_for(user)
        if left:
            db.commit()
            raise HTTPException(
                status_code=status.HTTP_423_LOCKED,
                detail=f"Zu viele falsche Codes — in {left // 60 + 1} Minuten erneut.",
            )
        db.add(AuditLog(actor=user.email, action="login_mfa_pending", entity="user",
                        entity_id=str(user.id)))
        db.commit()
        return Token(
            access_token="",
            role=user.role,
            email=user.email,
            name=user.name,
            mfa_required=True,
            mfa_token=_mfa_ticket(user),
        )

    user.last_login = datetime.now(timezone.utc)
    db.add(
        AuditLog(
            actor=user.email, action="login", entity="user", entity_id=str(user.id)
        )
    )
    db.commit()
    raw, sid = _create_session(db, user, request)
    _set_refresh_cookie(response, raw, request=request)
    return Token(
        access_token=create_access_token(user, sid),
        role=user.role,
        admin_work=has_admin_work(user),
        email=user.email,
        name=user.name,
    )


def _lock_notice(db: Session, user: User, now: datetime) -> None:
    """Eine Mail, wenn die Anmeldung eines Kundenkontos pausiert — mit dem Weg
    zum Zurücksetzen. Höchstens eine je ``LOCK_NOTICE_HOURS``; nur Kunden,
    denn nur sie können ihr Passwort selbst zurücksetzen."""
    if user.role != Role.customer or not user.active:
        return
    recent = db.query(AuditLog).filter(
        AuditLog.actor == user.email,
        AuditLog.action == "login_lock_notice",
        AuditLog.at > now - timedelta(hours=LOCK_NOTICE_HOURS),
    ).first()
    if recent:
        return
    brand = identity.texts(db)
    db.add(AuditLog(actor=user.email, action="login_lock_notice", entity="user",
                    entity_id=str(user.id)))
    smtp_client.send(
        to=user.email,
        subject=f"{brand.mail_subject} · Anmeldung pausiert",
        text=(f"Für Ihr Konto bei {brand.product} wurde mehrmals ein falsches Passwort "
              f"eingegeben. Die Anmeldung pausiert deshalb {LOCKOUT_MINUTES} Minuten.\n\n"
              "Waren Sie das, und haben Sie Ihr Passwort vergessen? Auf der Anmeldeseite "
              "unter „Passwort vergessen?“ schicken wir Ihnen einen Code, mit dem Sie ein "
              "neues Passwort setzen.\n\n"
              "Waren Sie das nicht, müssen Sie nichts tun: ohne das richtige Passwort kommt "
              "niemand in Ihr Konto.\n" + brand.signature),
        background=True,
    )


# --------------------------------------------------------------------------
# Passwort vergessen: Code per E-Mail (roadmap task 47 C)
#
# Zwei Regeln tragen den Weg. Erstens: die Antwort sagt nie, ob es das Konto
# gibt — Anfrage immer 202 mit demselben Text und einem bcrypt-Lauf auf jedem
# Zweig, Bestätigung mit demselben Satz für unbekannt, falsch, abgelaufen und
# verbraucht. Zweitens: das Zurücksetzen meldet nicht an. Wer danach
# hineinwill, geht durch die normale Anmeldung samt zweitem Faktor; ein
# Postfach allein ersetzt keinen zweiten Faktor.
# --------------------------------------------------------------------------
def _reset_eligible(user: User | None) -> bool:
    return bool(user and user.active and user.role == Role.customer)


def _reset_allowed(db: Session, user: User, now: datetime) -> bool:
    """Höchstens ein Code je Minute und ``RESET_PER_HOUR`` je Stunde und Adresse."""
    rows = db.query(AuditLog.at).filter(
        AuditLog.actor == user.email,
        AuditLog.action == "password_reset_request",
        AuditLog.at > now - timedelta(hours=1),
    ).all()
    if len(rows) >= RESET_PER_HOUR:
        return False
    return not any((_aware(at) or now) > now - timedelta(minutes=1) for (at,) in rows)


@router.post("/reset/request", status_code=status.HTTP_202_ACCEPTED)
def reset_request(
    body: PasswordResetRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    email = body.email.strip().lower()
    now = datetime.now(timezone.utc)
    # Aufräumen bei jeder Anfrage statt in einem Nachtdienst — wie
    # mfa.purge_stale_sessions. Ein Code-Hash bleibt höchstens einen Tag.
    gone = (db.query(PasswordReset)
              .filter(PasswordReset.created_at < now - timedelta(hours=RESET_KEEP_HOURS))
              .delete(synchronize_session=False))
    if gone:
        db.commit()
    user = db.query(User).filter(User.email == email).first() if email else None
    if not (_reset_eligible(user) and _reset_allowed(db, user, now)):
        hash_password("0" * 8)  # dieselbe Arbeit wie der Zweig mit Code
        return RESET_ACCEPTED
    code = f"{secrets.randbelow(10 ** 8):08d}"
    # Nur der jüngste Code gilt.
    db.query(PasswordReset).filter(
        PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None)
    ).update({"used_at": now}, synchronize_session=False)
    db.add(PasswordReset(user_id=user.id, code_hash=hash_password(code),
                         expires_at=now + timedelta(minutes=RESET_CODE_MINUTES),
                         attempts=0, created_at=now))
    db.add(AuditLog(actor=user.email, action="password_reset_request", entity="user",
                    entity_id=str(user.id)))
    db.commit()
    brand = identity.texts(db)
    # Im Hintergrund: die Antwortzeit darf nicht verraten, dass eine Mail geht.
    smtp_client.send(
        to=user.email,
        subject=f"{brand.mail_subject} · Passwort zurücksetzen",
        text=(f"Ihr Code zum Zurücksetzen des Passworts: {code}. Er gilt 15 Minuten. "
              "Haben Sie das nicht angefordert, können Sie diese E-Mail ignorieren.\n\n"
              + brand.signature),
        background=True,
    )
    return RESET_ACCEPTED


@router.post("/reset/confirm")
def reset_confirm(
    body: PasswordResetConfirm,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    email = body.email.strip().lower()
    now = datetime.now(timezone.utc)
    digits = "".join(ch for ch in body.code if ch.isdigit())
    user = db.query(User).filter(User.email == email).first() if email else None
    row = None
    if _reset_eligible(user):
        row = (db.query(PasswordReset)
                 .filter(PasswordReset.user_id == user.id,
                         PasswordReset.used_at.is_(None),
                         PasswordReset.attempts < RESET_MAX_ATTEMPTS)
                 .order_by(PasswordReset.id.desc())
                 .first())
        if row is not None and (_aware(row.expires_at) or now) <= now:
            row = None
    if row is None:
        _burn(digits)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=RESET_INVALID)
    # Erst zählen, dann vergleichen — als bedingtes UPDATE, damit zwei
    # gleichzeitige Versuche nicht beide den fünften bekommen.
    counted = (db.query(PasswordReset)
                 .filter(PasswordReset.id == row.id,
                         PasswordReset.used_at.is_(None),
                         PasswordReset.attempts < RESET_MAX_ATTEMPTS)
                 .update({PasswordReset.attempts: PasswordReset.attempts + 1},
                         synchronize_session=False))
    db.commit()
    if not counted or len(digits) != 8 or not verify_password(digits, row.code_hash):
        if not counted or len(digits) != 8:
            _burn(digits)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=RESET_INVALID)
    # Die Güte erst jetzt: ihre Meldung nennt Kontodaten (Name, E-Mail) und
    # darf nur antworten, wer den Code hat. Ein zu schwaches Passwort
    # verbraucht den Code nicht, nur den Versuch.
    check_password_strength(body.new_password, email=user.email, name=user.name)
    claimed = (db.query(PasswordReset)
                 .filter(PasswordReset.id == row.id, PasswordReset.used_at.is_(None))
                 .update({"used_at": now}, synchronize_session=False))
    if not claimed:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=RESET_INVALID)
    user.password_hash = hash_password(body.new_password)
    # Nur die Passwortsperre fällt: wer ein neues Passwort hat, soll damit hinein.
    # Die 2FA-Sperre bleibt — wer nur das Postfach hat, bekäme sonst je Reset
    # frische Code-Versuche (Sicherheitsprüfung 2026-11-15).
    user.failed_login_count = 0
    user.locked_until = None
    user.email_verified = True  # der Code kam in diesem Postfach an
    db.query(PasswordReset).filter(
        PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None)
    ).update({"used_at": now}, synchronize_session=False)
    revoked = mfa.revoke_other_sessions(db, user, keep_id=None)
    db.add(AuditLog(actor=user.email, action="password_reset_self", entity="user",
                    entity_id=str(user.id), detail={"sitzungen_beendet": revoked}))
    db.commit()
    return {"reset": True,
            "detail": "Ihr Passwort ist geändert. Bitte melden Sie sich mit dem neuen Passwort an."}


# --------------------------------------------------------------------------
# Das Zwischenticket
# --------------------------------------------------------------------------
def _mfa_ticket(user: User) -> str:
    """Ein JWT, das *nur* den zweiten Schritt öffnet.

    Zwei Eigenschaften machen es ungefährlich, und beide werden unten geprüft:
    ``scope: "mfa"`` — ``security.current_user`` akzeptiert es nicht, weil es
    keinen gültigen Zugriffstoken-Aufbau hat, und der Endpunkt unten weist
    alles zurück, was diesen Bereich nicht trägt. Und ``pwd`` bindet es an den
    Passworthash: wer zwischen den beiden Schritten sein Passwort ändert (oder
    ändern lässt), entwertet damit jedes offene Ticket.
    """
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": str(user.id),
            "scope": "mfa",
            "pwd": hashlib.sha256(user.password_hash.encode()).hexdigest()[:16],
            "iat": now,
            "exp": now + timedelta(minutes=MFA_TICKET_MINUTES),
        },
        settings.secret_key,
        algorithm="HS256",
    )


def _read_mfa_ticket(db: Session, token: str) -> User:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Der Anmeldevorgang ist abgelaufen — bitte neu beginnen.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Ungültiger Anmeldevorgang.")
    if payload.get("scope") != "mfa":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Ungültiger Anmeldevorgang.")
    user = db.get(User, int(payload.get("sub", 0)))
    if not user or not user.active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Konto gesperrt oder gelöscht.")
    expect = hashlib.sha256(user.password_hash.encode()).hexdigest()[:16]
    require_internal_email(user.email, user.role)
    if not hmac.compare_digest(str(payload.get("pwd", "")), expect):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Der Anmeldevorgang ist nicht mehr gültig.")
    return user


@router.post("/2fa", response_model=Token)
def login_second_factor(
    body: MfaLogin,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> Token:
    """Zweiter Schritt: Ticket plus Code aus der App — oder ein Wiederherstellungscode.

    Es gibt bewusst **kein „diesem Gerät vertrauen"**. Ein solcher Haken ist
    ein zweites, dauerhaftes Geheimnis im Browser, das den Faktor für Wochen
    ausschaltet, und der Kunde, der ihn setzt, versteht das nicht. Wer sich
    das Tippen sparen will, hat die lange Refresh-Sitzung — die tut dasselbe,
    nur ehrlich benannt und jederzeit auf der Kontoseite kündbar.
    """
    user = _read_mfa_ticket(db, body.mfa_token)
    if not mfa.is_enabled(user):
        # Das Ticket wurde unter der Zusage „zweiter Faktor erforderlich"
        # ausgestellt. Wird diese Voraussetzung inzwischen geändert, muss der
        # Anmeldevorgang neu beginnen statt den Code-Schritt zu überspringen.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Die Sicherheitseinstellung wurde geändert — bitte neu anmelden.",
        )
    else:
        try:
            how = mfa.check(db, user, body.code)
        except PermissionError as exc:
            left = int(str(exc))
            raise HTTPException(
                status_code=status.HTTP_423_LOCKED,
                detail=f"Zu viele falsche Codes — in {left // 60 + 1} Minuten erneut.",
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                                detail=str(exc)) from exc
        db.add(AuditLog(actor=user.email, action=f"login_2fa_{how}", entity="user",
                        entity_id=str(user.id)))

    user.last_login = datetime.now(timezone.utc)
    db.commit()
    raw, sid = _create_session(db, user, request)
    _set_refresh_cookie(response, raw, request=request)
    return Token(
        access_token=create_access_token(user, sid),
        role=user.role,
        admin_work=has_admin_work(user),
        email=user.email,
        name=user.name,
    )


@router.post("/refresh", response_model=Token)
def refresh(
    request: Request, response: Response, db: Annotated[Session, Depends(get_db)]
) -> Token:
    raw = request.cookies.get(REFRESH_COOKIE)
    if not raw:
        raise HTTPException(status_code=401, detail="Keine Sitzung.")
    hashed = hash_refresh_token(raw)
    sess = db.query(AuthSession).filter(AuthSession.refresh_hash == hashed).first()
    if not sess or sess.revoked_at:
        raise HTTPException(status_code=401, detail="Sitzung abgelaufen.")
    exp = sess.expires_at
    if exp and exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if exp and exp < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="Sitzung abgelaufen.")
    user = db.get(User, sess.user_id)
    if not user or not user.active:
        raise HTTPException(status_code=401, detail="Konto gesperrt.")
    require_internal_email(user.email, user.role)
    # rotate
    sess.revoked_at = datetime.now(timezone.utc)
    db.flush()
    new_raw = generate_refresh_token()
    new_hashed = hash_refresh_token(new_raw)
    # Die Gimel-PIN-Sitzung endet hart nach gimel_session_hours: das Erneuern
    # behält ihr Ende, statt es wie bei persönlichen Konten weiterzuschieben.
    gimel = user.email == get_settings().gimel_account.strip().lower()
    new_sess = AuthSession(
        user_id=user.id,
        refresh_hash=new_hashed,
        expires_at=exp if (gimel and exp) else datetime.now(timezone.utc)
        + timedelta(days=settings.refresh_token_days),
        ip=client_ip(request) or sess.ip,
        user_agent=request.headers.get("user-agent", sess.user_agent)[:300],
    )
    db.add(new_sess)
    db.commit()
    _set_refresh_cookie(response, new_raw, max_age=int((exp - datetime.now(timezone.utc)).total_seconds()) if (gimel and exp) else None, request=request)
    return Token(
        access_token=create_access_token(user, new_sess.id),
        role=user.role,
        admin_work=has_admin_work(user),
        email=user.email,
        name=user.name,
    )


@router.post("/logout", status_code=204)
def logout(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    sid: Annotated[int | None, Depends(current_session_id)] = None,
) -> None:
    changed = False
    raw = request.cookies.get(REFRESH_COOKIE)
    if raw:
        hashed = hash_refresh_token(raw)
        sess = db.query(AuthSession).filter(AuthSession.refresh_hash == hashed).first()
        if sess and not sess.revoked_at:
            sess.revoked_at = datetime.now(timezone.utc)
            changed = True
    # Der Cookie kann bereits fehlen oder rotiert worden sein. Das im
    # Bearer-Token benannte Gerät wird trotzdem zuverlässig beendet.
    if sid is not None:
        sess = db.get(AuthSession, sid)
        if sess and not sess.revoked_at:
            sess.revoked_at = datetime.now(timezone.utc)
            changed = True
    if changed:
        db.commit()
    _clear_refresh_cookie(response)


@router.get("/login-options")
def login_options() -> dict:
    """Expose availability, never the configured credential."""
    s = get_settings()
    gimel = bool(s.gimel_pin_hash)
    return {"test_pin_enabled": bool(s.staff_pin) and not gimel and not s.is_production(),
            "gimel_pin_enabled": gimel}


def _gimel_account(db: Session) -> User:
    """Das Betriebskonto, an dem PIN-Sitzungen hängen. Rolle staff: Aufträge,
    Fertigung, Versand, Kunden, Preise — keine Benutzerverwaltung. Ein Passwort
    hat es nicht ("!" passt auf keinen bcrypt-Hash); hinein geht es nur mit
    der PIN."""
    s = get_settings()
    email = s.gimel_account.strip().lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        require_internal_email(email, Role.staff)
        user = User(email=email, password_hash="!", name="Gimel-Betrieb",
                    company=identity.texts(db).signature, role=Role.staff, active=True,
                    email_verified=True)
        db.add(user)
        db.flush()
        db.add(AuditLog(actor="system", action="gimel_account_create", entity="user",
                        entity_id=str(user.id)))
    return user


def _gimel_pin_ok(pin: str, pin_hash: str) -> bool:
    try:
        return verify_password(pin, pin_hash)
    except Exception:  # noqa: BLE001 — ein kaputter Hash ist eine falsche PIN
        return False


@router.post("/pin", response_model=Token)
def pin_login(
    body: PinLogin,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> Token:
    s = get_settings()
    if s.gimel_pin_hash:
        return _gimel_pin_login(body, request, response, db)
    # Ohne Gimel-PIN bleibt nur die alte Test-PIN der Entwicklung. Sie macht den
    # Inhaber zum Administrator; im Produktionsbetrieb ist sie deshalb ein Stopp:
    # eine vergessene 2468 wäre ein offenes Admin-Konto (§11, Punkt 4).
    # Ohne gesetzte PIN (Gimel allein) ebenso: eine leere Eingabe wäre sonst ein Treffer.
    if s.is_production() or not s.staff_pin.strip():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bitte mit persönlicher E-Mail und Passwort anmelden. Die gemeinsame PIN ist im Produktionsbetrieb deaktiviert.",
        )
    if not hmac.compare_digest(body.pin.strip().encode(), s.staff_pin.strip().encode()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Die PIN stimmt nicht."
        )
    admin = (
        db.query(User)
        .filter(User.role == Role.admin, User.active.is_(True))
        .order_by(User.id.asc())
        .first()
    )
    if not admin:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Kein Administrateur eingerichtet.",
        )
    admin.last_login = datetime.now(timezone.utc)
    require_internal_email(admin.email, admin.role)
    db.add(
        AuditLog(
            actor=admin.email,
            action="pin_login",
            entity="user",
            entity_id=str(admin.id),
        )
    )
    db.commit()
    raw, sid = _create_session(db, admin, request)
    _set_refresh_cookie(response, raw)
    return Token(
        access_token=create_access_token(admin, sid),
        role=admin.role,
        admin_work=has_admin_work(admin),
        email=admin.email,
        name=admin.name,
    )


def _gimel_pin_login(body: PinLogin, request: Request, response: Response, db: Session) -> Token:
    """Gimel-PIN: gedrosselt (services/pin_guard.py), jeder Versuch protokolliert."""
    s = get_settings()
    ip = client_ip(request)
    agent = request.headers.get("user-agent", "")[:200]
    wait = pin_guard.blocked(ip)
    if wait:
        db.add(AuditLog(actor="gimel-pin", action="gimel_pin_throttled", entity="auth",
                        entity_id=pin_guard.rate_key(ip), detail={"ip": ip, "ua": agent}))
        db.commit()
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Zu viele Versuche. Bitte später erneut versuchen.",
                            headers={"Retry-After": str(wait)})
    if not _gimel_pin_ok(body.pin.strip(), s.gimel_pin_hash):
        locked = pin_guard.failed(ip)
        db.add(AuditLog(actor="gimel-pin", action="gimel_pin_lockout" if locked else "gimel_pin_failed",
                        entity="auth", entity_id=pin_guard.rate_key(ip), detail={"ip": ip, "ua": agent}))
        db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Die PIN stimmt nicht.")
    pin_guard.succeeded(ip)
    user = _gimel_account(db)
    if not user.active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Der Gimel-Zugang ist gesperrt.")
    user.last_login = datetime.now(timezone.utc)
    db.add(AuditLog(actor=user.email, action="gimel_pin_login", entity="user",
                    entity_id=str(user.id), detail={"ip": ip, "ua": agent}))
    db.commit()
    raw, sid = _create_session(db, user, request, lifetime=timedelta(hours=s.gimel_session_hours))
    _set_refresh_cookie(response, raw, max_age=s.gimel_session_hours * 3600)
    return Token(
        access_token=create_access_token(user, sid),
        role=user.role,
        admin_work=has_admin_work(user),
        email=user.email,
        name=user.name,
    )


@router.get("/me", response_model=UserOut)
def me(user: Annotated[User, Depends(current_user)]) -> User:
    return user


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    body: PasswordChange,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
    sid: Annotated[int | None, Depends(current_session_id)] = None,
) -> None:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Das aktuelle Passwort stimmt nicht.",
        )
    check_password_strength(body.new_password, email=user.email, name=user.name)
    if verify_password(body.new_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Das neue Passwort ist das alte.",
        )
    if mfa.is_enabled(user):
        try:
            mfa.check(db, user, body.code)
        except PermissionError as exc:
            left = int(str(exc))
            raise HTTPException(
                status_code=status.HTTP_423_LOCKED,
                detail=f"Zu viele falsche Codes — in {left // 60 + 1} Minuten erneut.",
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                                detail=str(exc)) from exc
    user.password_hash = hash_password(body.new_password)
    # Alle anderen Sitzungen enden, die eigene bleibt — wie beim zweiten Faktor
    # und beim E-Mail-Wechsel. Bis 2026-11 flog auch dieser Tab hinaus, und der
    # Kunde stand nach dem Speichern vor der Anmeldemaske. Ohne ``sid`` (alte
    # Tokens) endet sicherheitshalber jede.
    revoked = mfa.revoke_other_sessions(db, user, keep_id=sid)
    db.add(
        AuditLog(
            actor=user.email,
            action="password_change",
            entity="user",
            entity_id=str(user.id),
            detail={"sitzungen_beendet": revoked},
        )
    )
    db.commit()
