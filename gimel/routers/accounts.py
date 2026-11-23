"""Gimel Account Manager — proper admin account management (username + password).

Stores the login identifier in ``User.email`` so existing sessions, audit logs,
and database schemas work without migrations. Accepts plain usernames (e.g.
``admin``, ``max``, ``schicht-1``) as well as existing email-formatted accounts.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..localnet import local_lan_ips
from ..models import AuditLog, AuthSession, Order, Role, User
from ..schemas import Token
from ..security import (
    create_access_token,
    current_session_id,
    current_user,
    has_admin_work,
    hash_password,
    require_admin,
    verify_password,
)
from ..services import identity
from ..services.mfa import revoke_other_sessions
from ..version import APP_VERSION
from .auth import _create_session, _set_refresh_cookie, check_password_strength
from .users import assert_not_last_admin

router = APIRouter(prefix="/api/accounts", tags=["accounts"])

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._@+-]{1,119}$")
ALLOWED_ROLES = (Role.admin, Role.staff, Role.worker)


def normalize_username(raw: str) -> str:
    value = (raw or "").strip().lower()
    if len(value) < 2 or len(value) > 120:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Der Benutzername muss zwischen 2 und 120 Zeichen lang sein.",
        )
    if not USERNAME_RE.match(value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Benutzername darf nur Buchstaben, Ziffern und . _ - + @ enthalten und muss mit Buchstabe oder Ziffer beginnen.",
        )
    return value


def _is_locked(user: User) -> bool:
    now = datetime.now(timezone.utc)
    for dt in (user.locked_until, user.mfa_locked_until):
        if dt is None:
            continue
        aware = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        if aware > now:
            return True
    return False


def _active_session_counts(db: Session, user_ids: list[int]) -> dict[int, int]:
    if not user_ids:
        return {}
    now = datetime.now(timezone.utc)
    rows = (
        db.query(AuthSession.user_id, func.count(AuthSession.id))
        .filter(
            AuthSession.user_id.in_(user_ids),
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
        )
        .group_by(AuthSession.user_id)
        .all()
    )
    return {int(uid): int(cnt) for uid, cnt in rows}


class AccountOut(BaseModel):
    id: int
    username: str
    role: Role
    active: bool
    created_at: datetime
    last_login: Optional[datetime] = None
    locked: bool = False
    failed_login_count: int = 0
    active_sessions: int = 0


class AccountSessionOut(BaseModel):
    id: int
    ip: str
    user_agent: str
    created_at: datetime
    expires_at: datetime
    current: bool = False


class AccountAuditOut(BaseModel):
    id: int
    at: datetime
    actor: str
    action: str
    detail: dict = Field(default_factory=dict)


class AccountSummaryOut(BaseModel):
    total: int
    admins: int
    staff: int
    workers: int
    customers: int
    active: int
    inactive: int
    locked: int
    active_sessions: int


def _to_out(user: User, active_sessions: int = 0) -> AccountOut:
    return AccountOut(
        id=user.id,
        username=user.email,
        role=user.role,
        active=bool(user.active),
        created_at=user.created_at,
        last_login=user.last_login,
        locked=_is_locked(user),
        failed_login_count=int(user.failed_login_count or 0),
        active_sessions=active_sessions,
    )


class AccountCreate(BaseModel):
    username: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=200)
    role: Role = Role.staff


class AccountSetup(BaseModel):
    username: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=200)
    plant_name: str = Field(default="", max_length=160)


class AccountUpdate(BaseModel):
    username: Optional[str] = Field(default=None, min_length=2, max_length=120)
    role: Optional[Role] = None
    active: Optional[bool] = None


class AccountPasswordSet(BaseModel):
    password: str = Field(min_length=8, max_length=200)


class OwnPasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


# ---------------------------------------------------------------------------
# First-run setup wizard (only open when 0 accounts exist in the database)
# ---------------------------------------------------------------------------
@router.get("/setup-status")
def setup_status(request: Request, db: Annotated[Session, Depends(get_db)]) -> dict:
    s = get_settings()
    try:
        db_backend = make_url(s.database_url).get_backend_name()
    except Exception:  # noqa: BLE001
        db_backend = "sqlite"
    port = request.url.port or (8041 if s.is_production() else 8040)
    return {
        "needs_setup": db.query(User).count() == 0,
        "localnet_only": s.localnet_only,
        "mode": "production" if s.is_production() else os.environ.get("GIMEL_MODE", "playground"),
        "db_backend": db_backend,
        "version": APP_VERSION,
        "lan_urls": [f"http://{ip}:{port}/app" for ip in local_lan_ips()],
    }


@router.post("/setup", response_model=Token, status_code=status.HTTP_201_CREATED)
def setup_first_admin(
    body: AccountSetup,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> Token:
    if db.query(User).count() > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ein Konto existiert bereits — Ersteinrichtung ist abgeschlossen.",
        )
    username = normalize_username(body.username)
    check_password_strength(body.password, email=username, name=username)
    user = User(
        email=username,
        name=username,
        password_hash=hash_password(body.password),
        role=Role.admin,
        active=True,
    )
    db.add(user)
    db.flush()
    plant_name = (body.plant_name or "").strip()
    if plant_name and identity.editable():
        identity.save(db, {"name": plant_name}, actor=username)
    db.add(
        AuditLog(
            actor=username,
            action="account_setup_admin",
            entity="user",
            entity_id=str(user.id),
            detail={"username": username, "role": Role.admin.value, "plant_name": plant_name},
        )
    )
    db.commit()
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


# ---------------------------------------------------------------------------
# Self-service password change (any signed-in user)
# ---------------------------------------------------------------------------
@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT)
def change_own_password(
    body: OwnPasswordChange,
    user: Annotated[User, Depends(current_user)],
    sid: Annotated[int | None, Depends(current_session_id)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Das aktuelle Passwort stimmt nicht.",
        )
    check_password_strength(body.new_password, email=user.email, name=user.name)
    user.password_hash = hash_password(body.new_password)
    user.failed_login_count = 0
    user.locked_until = None
    revoke_other_sessions(db, user, keep_id=sid)
    db.add(
        AuditLog(
            actor=user.email,
            action="account_password_self",
            entity="user",
            entity_id=str(user.id),
        )
    )
    db.commit()


# ---------------------------------------------------------------------------
# Admin Account Manager Summary & CRUD
# ---------------------------------------------------------------------------
@router.get("/summary", response_model=AccountSummaryOut, dependencies=[Depends(require_admin)])
def accounts_summary(db: Annotated[Session, Depends(get_db)]) -> AccountSummaryOut:
    users = db.query(User).all()
    team = [u for u in users if u.role != Role.customer]
    now = datetime.now(timezone.utc)
    active_sessions = (
        db.query(func.count(AuthSession.id))
        .filter(AuthSession.revoked_at.is_(None), AuthSession.expires_at > now)
        .scalar()
        or 0
    )
    return AccountSummaryOut(
        total=len(team),
        admins=sum(1 for u in team if u.role == Role.admin and u.active),
        staff=sum(1 for u in team if u.role == Role.staff and u.active),
        workers=sum(1 for u in team if u.role == Role.worker and u.active),
        customers=sum(1 for u in users if u.role == Role.customer),
        active=sum(1 for u in team if u.active),
        inactive=sum(1 for u in team if not u.active),
        locked=sum(1 for u in team if _is_locked(u)),
        active_sessions=int(active_sessions),
    )


@router.get("", response_model=list[AccountOut], dependencies=[Depends(require_admin)])
def list_accounts(
    db: Annotated[Session, Depends(get_db)],
    q: Optional[str] = None,
    role: Optional[Role] = None,
    active: Optional[bool] = None,
    include_customers: bool = False,
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[AccountOut]:
    query = db.query(User)
    if role is not None:
        query = query.filter(User.role == role)
    elif not include_customers:
        query = query.filter(User.role != Role.customer)
    if q and q.strip():
        esc = q.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{esc}%"
        query = query.filter(
            or_(User.email.ilike(like, escape="\\"), User.name.ilike(like, escape="\\"))
        )
    if active is not None:
        query = query.filter(User.active.is_(active))
    rows = query.order_by(User.email, User.id).limit(limit).all()
    counts = _active_session_counts(db, [u.id for u in rows])
    return [_to_out(u, counts.get(u.id, 0)) for u in rows]


@router.post(
    "",
    response_model=AccountOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_admin)],
)
def create_account(
    body: AccountCreate,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(current_user)],
) -> AccountOut:
    username = normalize_username(body.username)
    if body.role not in ALLOWED_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Erlaubte Rollen: admin, staff, worker.",
        )
    if db.query(User).filter(User.email == username).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Dieser Benutzername ist bereits vergeben.",
        )
    check_password_strength(body.password, email=username, name=username)
    user = User(
        email=username,
        name=username,
        password_hash=hash_password(body.password),
        role=body.role,
        active=True,
    )
    db.add(user)
    db.flush()
    db.add(
        AuditLog(
            actor=actor.email,
            action="account_create",
            entity="user",
            entity_id=str(user.id),
            detail={"username": username, "role": body.role.value},
        )
    )
    db.commit()
    db.refresh(user)
    return _to_out(user, 0)


@router.patch("/{user_id}", response_model=AccountOut, dependencies=[Depends(require_admin)])
def update_account(
    user_id: int,
    body: AccountUpdate,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(current_user)],
) -> AccountOut:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Konto nicht gefunden.")

    changed: dict[str, object] = {}
    revoke_sessions = False

    if body.username is not None:
        new_username = normalize_username(body.username)
        if new_username != user.email:
            clash = (
                db.query(User)
                .filter(User.email == new_username, User.id != user.id)
                .first()
            )
            if clash:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Dieser Benutzername ist bereits vergeben.",
                )
            changed["username"] = [user.email, new_username]
            if not user.name or user.name == user.email:
                user.name = new_username
            user.email = new_username

    if body.role is not None and body.role != user.role:
        if body.role not in ALLOWED_ROLES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Erlaubte Rollen: admin, staff, worker.",
            )
        if user.role == Role.admin and body.role != Role.admin:
            assert_not_last_admin(db, user)
        changed["role"] = [user.role.value, body.role.value]
        user.role = body.role
        revoke_sessions = True

    if body.active is not None and body.active != user.active:
        if not body.active:
            assert_not_last_admin(db, user)
            revoke_sessions = True
        changed["active"] = [bool(user.active), bool(body.active)]
        user.active = body.active

    if not changed:
        counts = _active_session_counts(db, [user.id])
        return _to_out(user, counts.get(user.id, 0))

    if revoke_sessions:
        revoke_other_sessions(db, user, keep_id=None)

    db.add(
        AuditLog(
            actor=actor.email,
            action="account_update",
            entity="user",
            entity_id=str(user.id),
            detail=changed,
        )
    )
    db.commit()
    db.refresh(user)
    counts = _active_session_counts(db, [user.id])
    return _to_out(user, counts.get(user.id, 0))


@router.get("/{user_id}/sessions", response_model=list[AccountSessionOut], dependencies=[Depends(require_admin)])
def list_account_sessions(
    user_id: int,
    db: Annotated[Session, Depends(get_db)],
    sid: Annotated[int | None, Depends(current_session_id)],
) -> list[AccountSessionOut]:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Konto nicht gefunden.")
    now = datetime.now(timezone.utc)
    rows = (
        db.query(AuthSession)
        .filter(
            AuthSession.user_id == user.id,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
        )
        .order_by(AuthSession.created_at.desc())
        .all()
    )
    return [
        AccountSessionOut(
            id=s.id,
            ip=s.ip or "",
            user_agent=s.user_agent or "",
            created_at=s.created_at,
            expires_at=s.expires_at,
            current=(sid is not None and s.id == sid),
        )
        for s in rows
    ]


@router.post("/{user_id}/logout-all", dependencies=[Depends(require_admin)])
def logout_all_sessions(
    user_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(current_user)],
    sid: Annotated[int | None, Depends(current_session_id)],
) -> dict:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Konto nicht gefunden.")
    keep = sid if user.id == actor.id else None
    revoked = revoke_other_sessions(db, user, keep_id=keep)
    db.add(
        AuditLog(
            actor=actor.email,
            action="account_logout_all",
            entity="user",
            entity_id=str(user.id),
            detail={"revoked": revoked, "kept_current": keep is not None},
        )
    )
    db.commit()
    return {"revoked": revoked}


@router.get("/{user_id}/audit", response_model=list[AccountAuditOut], dependencies=[Depends(require_admin)])
def account_audit(
    user_id: int,
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=200),
) -> list[AccountAuditOut]:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Konto nicht gefunden.")
    rows = (
        db.query(AuditLog)
        .filter(AuditLog.entity == "user", AuditLog.entity_id == str(user.id))
        .order_by(AuditLog.at.desc(), AuditLog.id.desc())
        .limit(limit)
        .all()
    )
    return [
        AccountAuditOut(
            id=r.id,
            at=r.at,
            actor=r.actor,
            action=r.action,
            detail=r.detail if isinstance(r.detail, dict) else {},
        )
        for r in rows
    ]


@router.post(
    "/{user_id}/password",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_admin)],
)
def set_account_password(
    user_id: int,
    body: AccountPasswordSet,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(current_user)],
) -> None:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Konto nicht gefunden.")
    check_password_strength(body.password, email=user.email, name=user.name)
    user.password_hash = hash_password(body.password)
    user.failed_login_count = 0
    user.locked_until = None
    user.mfa_failed_count = 0
    user.mfa_locked_until = None
    revoke_other_sessions(db, user, keep_id=None)
    db.add(
        AuditLog(
            actor=actor.email,
            action="account_password_set",
            entity="user",
            entity_id=str(user.id),
        )
    )
    db.commit()


@router.post("/{user_id}/unlock", response_model=AccountOut, dependencies=[Depends(require_admin)])
def unlock_account(
    user_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(current_user)],
) -> AccountOut:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Konto nicht gefunden.")
    user.failed_login_count = 0
    user.locked_until = None
    user.mfa_failed_count = 0
    user.mfa_locked_until = None
    db.add(
        AuditLog(
            actor=actor.email,
            action="account_unlock",
            entity="user",
            entity_id=str(user.id),
        )
    )
    db.commit()
    db.refresh(user)
    counts = _active_session_counts(db, [user.id])
    return _to_out(user, counts.get(user.id, 0))


@router.delete("/{user_id}", dependencies=[Depends(require_admin)])
def delete_account(
    user_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(current_user)],
) -> dict:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Konto nicht gefunden.")
    assert_not_last_admin(db, user)
    revoke_other_sessions(db, user, keep_id=None)

    has_orders = db.query(Order.id).filter(Order.user_id == user.id).first() is not None
    if has_orders:
        user.active = False
        db.add(
            AuditLog(
                actor=actor.email,
                action="account_deactivate",
                entity="user",
                entity_id=str(user.id),
                detail={"reason": "has_orders"},
            )
        )
        db.commit()
        return {
            "action": "deactivated",
            "detail": "Konto stillgelegt (verknüpfte Aufträge bleiben erhalten).",
        }

    username = user.email
    db.delete(user)
    db.add(
        AuditLog(
            actor=actor.email,
            action="account_delete",
            entity="user",
            entity_id=str(user_id),
            detail={"username": username},
        )
    )
    db.commit()
    return {"action": "deleted", "detail": "Konto gelöscht."}
