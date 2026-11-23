"""Passwörter, Token und Rollenprüfung."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from .config import ENV_PREFIX, get_settings
from .db import get_db
from .extensions import active
from .models import AuthSession, Role, User

settings = get_settings()
oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

ALGORITHM = "HS256"
REFRESH_COOKIE = f"{ENV_PREFIX.lower()}refresh"


def require_internal_email(email: str, role: Role) -> None:
    plugin = active()
    domain = plugin.internal_email_domain if plugin else ""
    if domain and role in (Role.staff, Role.admin) and (
        str(email).strip().lower().count("@") != 1
        or str(email).strip().lower().split("@")[-1] != domain
    ):
        raise HTTPException(status_code=403,
                            detail=f"Interne Konten benötigen eine @{domain} E-Mail-Adresse.")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


#: Der Bereich eines Zugangstokens. Alles, was mit demselben Betriebsschlüssel
#: signiert ist, aber einen anderen Bereich trägt, ist *kein* Zugangstoken —
#: siehe ``current_user``.
SCOPE_ACCESS = "access"


def create_access_token(user: User, session_id: int | None = None) -> str:
    """Ein Zugangstoken, das weiß, aus welcher Sitzung es stammt.

    ``sid`` ist seit 2026-09 dabei, und der Grund ist ein handfester Fehler:
    die Kontoseite wollte „dieses Gerät" markieren und beim Einschalten des
    zweiten Faktors die *eigene* Sitzung verschonen. Beides las den
    Refresh-Cookie — der aber liegt auf ``path=/api/auth`` und erreicht
    ``/api/account/…`` nie. Die Folge war still und falsch: kein Gerät wurde
    je als das eigene erkannt, und „alle anderen abmelden" meldete auch den
    ab, der darauf drückte.

    Die Sitzungskennung im Token löst das ohne den Cookie zu verbreitern —
    ein Geheimnis auf mehr Pfade zu legen, um eine Anzeige zu reparieren, wäre
    der falsche Handel.
    """
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "email": user.email,
        "role": user.role.value,
        "scope": SCOPE_ACCESS,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_minutes),
    }
    if session_id is not None:
        payload["sid"] = int(session_id)
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def verify_refresh_token(token: str, hashed: str) -> bool:
    return hmac.compare_digest(hash_refresh_token(token), hashed)


def _unauthorized(detail: str = "Nicht angemeldet.") -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail,
                         headers={"WWW-Authenticate": "Bearer"})


def current_user(token: Annotated[Optional[str], Depends(oauth2)],
                 db: Annotated[Session, Depends(get_db)]) -> User:
    if not token:
        raise _unauthorized()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise _unauthorized("Sitzung abgelaufen — bitte neu anmelden.")
    except jwt.InvalidTokenError:
        raise _unauthorized("Ungültiges Token.")
    # Der Bereich, und warum diese drei Zeilen wichtiger sind, als sie
    # aussehen: seit dem zweiten Faktor (2026-09) gibt es ein *zweites* mit
    # demselben Schlüssel signiertes Token — das Zwischenticket zwischen
    # Passwort und Code. Ohne diese Prüfung wäre es ein vollwertiges
    # Zugangstoken, und der zweite Faktor damit eine Formalität, die man
    # überspringen kann. Der Prüflauf test_2fa.py hat genau das gefunden.
    #
    # Der Vorgabewert ist ``access``, damit ein Token aus der Zeit vor dem
    # Bereichsfeld weiter gilt und niemand von einem Aufspielen ausgeloggt wird.
    if payload.get("scope", SCOPE_ACCESS) != SCOPE_ACCESS:
        raise _unauthorized("Dieses Token öffnet keinen Zugriff.")
    user = db.get(User, int(payload.get("sub", 0)))
    if not user or not user.active:
        raise _unauthorized("Konto gesperrt oder gelöscht.")
    require_internal_email(user.email, user.role)
    # Ein JWT allein darf eine beendete Sitzung nicht künstlich am Leben
    # halten. Logout, Passwortwechsel und „Gerät beenden" widerrufen den
    # serverseitigen Sitzungsdatensatz; deshalb wird er bei *jeder* Anfrage
    # geprüft. Ältere Tokens ohne ``sid`` bleiben für die kurze Lebensdauer
    # eines Zugangstokens kompatibel.
    sid = payload.get("sid")
    if sid is not None:
        try:
            session_id = int(sid)
        except (TypeError, ValueError):
            raise _unauthorized("Ungültige Sitzung.")
        auth_session = db.get(AuthSession, session_id)
        expires = auth_session.expires_at if auth_session else None
        if expires and expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if (not auth_session or auth_session.user_id != user.id
                or auth_session.revoked_at is not None
                or (expires is not None and expires <= datetime.now(timezone.utc))):
            raise _unauthorized("Sitzung beendet — bitte neu anmelden.")
    return user


def current_session_id(token: Annotated[Optional[str], Depends(oauth2)]) -> Optional[int]:
    """Die Sitzung hinter dem vorgelegten Zugangstoken, sofern es eine nennt.

    Tokens aus der Zeit vor ``sid`` (und der PIN-Eingang, bevor er die Sitzung
    kennt) liefern ``None``; die Aufrufer behandeln das als „unbekannt" und
    verschonen dann sicherheitshalber nichts, statt das Falsche zu verschonen.
    """
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError:
        return None
    sid = payload.get("sid")
    return int(sid) if isinstance(sid, int) or (isinstance(sid, str) and sid.isdigit()) else None


def optional_user(token: Annotated[Optional[str], Depends(oauth2)],
                  db: Annotated[Session, Depends(get_db)]) -> Optional[User]:
    """Für Endpunkte, die auch Gäste bedienen — Gast darf bestellen (§6, 0.4)."""
    if not token:
        return None
    try:
        return current_user(token, db)
    except HTTPException:
        return None


def require_role(*roles: Role):
    def guard(user: Annotated[User, Depends(current_user)]) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="Für diese Aktion fehlt die Berechtigung.")
        return user
    return guard


# Hallenarbeit: Aufträge sehen, Platten schneiden, Versand. Alles, was Geld,
# Kunden oder Planung berührt, bleibt bei require_staff.
require_worker = require_role(Role.worker, Role.staff, Role.admin)
require_staff = require_role(Role.staff, Role.admin)


def is_gimel_account(user: User) -> bool:
    """Das gemeinsame PIN-Konto: die eingestellte Adresse, aktiv, Rolle staff.

    Die Rolle in der Datenbank bleibt staff; die Gleichstellung mit dem Admin
    geschieht hier zur Laufzeit, damit ein bestehendes Konto sie ohne Migration
    erhält (Beschluss des Inhabers, 2026-11-02).
    """
    return (user.role == Role.staff and bool(user.active)
            and user.email.strip().lower() == get_settings().gimel_account.strip().lower())


def has_admin_work(user: User) -> bool:
    """Admin, oder das PIN-Konto, das wie ein Admin arbeitet."""
    return user.role == Role.admin or is_gimel_account(user)


def require_admin(user: Annotated[User, Depends(current_user)]) -> User:
    if not has_admin_work(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Für diese Aktion fehlt die Berechtigung.")
    return user
