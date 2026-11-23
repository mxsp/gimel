"""Gimel Account Manager — simple username + password accounts for localnet operation.

Stores the login identifier in ``User.email`` so existing sessions, audit logs,
and database schemas work without migrations. Accepts plain usernames (e.g.
``admin``, ``max``, ``schicht-1``) as well as existing email-formatted accounts.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import AuditLog, Order, Role, User
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
from ..services.mfa import revoke_other_sessions
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


class AccountOut(BaseModel):
    id: int
    username: str
    role: Role
    active: bool
    created_at: datetime
    last_login: Optional[datetime] = None
    locked: bool = False
    failed_login_count: int = 0


def _to_out(user: User) -> AccountOut:
    return AccountOut(
        id=user.id,
        username=user.email,
        role=user.role,
        active=bool(user.active),
        created_at=user.created_at,
        last_login=user.last_login,
        locked=_is_locked(user),
        failed_login_count=int(user.failed_login_count or 0),
    )


class AccountCreate(BaseModel):
    username: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=200)
    role: Role = Role.staff


class AccountSetup(BaseModel):
    username: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=200)


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
# First-run setup (only open when 0 accounts exist in the database)
# ---------------------------------------------------------------------------
@router.get("/setup-status")
def setup_status(db: Annotated[Session, Depends(get_db)]) -> dict:
    s = get_settings()
    return {
        "needs_setup": db.query(User).count() == 0,
        "localnet_only": s.localnet_only,
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
    db.add(
        AuditLog(
            actor=username,
            action="account_setup_admin",
            entity="user",
            entity_id=str(user.id),
            detail={"username": username, "role": Role.admin.value},
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
# Admin Account Manager CRUD
# ---------------------------------------------------------------------------
@router.get("", response_model=list[AccountOut], dependencies=[Depends(require_admin)])
def list_accounts(
    db: Annotated[Session, Depends(get_db)],
    q: Optional[str] = None,
    role: Optional[Role] = None,
    active: Optional[bool] = None,
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[AccountOut]:
    query = db.query(User)
    if q and q.strip():
        esc = q.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{esc}%"
        query = query.filter(
            or_(User.email.ilike(like, escape="\\"), User.name.ilike(like, escape="\\"))
        )
    if role is not None:
        query = query.filter(User.role == role)
    if active is not None:
        query = query.filter(User.active.is_(active))
    rows = query.order_by(User.email, User.id).limit(limit).all()
    return [_to_out(u) for u in rows]


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
    return _to_out(user)


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
        return _to_out(user)

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
    return _to_out(user)


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
    return _to_out(user)


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
