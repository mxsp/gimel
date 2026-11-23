"""Benutzerverwaltung — nur für Administratoren."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import or_
from sqlalchemy.orm import Session, defer, selectinload

from sqlalchemy import func

from ..db import get_db
from ..models import AuditLog, Order, OrderPosition, RecoveryCode, Role, User
from ..schemas import PasswordSet, UserCreate, UserOut, UserUpdate
from ..security import current_user, hash_password, require_admin, require_internal_email
from ..services import erasure
from ..services.mfa import revoke_other_sessions


class OrderPositionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    kind: str
    label: str
    mat: str
    thk: float
    qty: int
    od: float
    di: float
    bolt_count: int
    bolt_circle: float
    bolt_d: float
    cut_len: float
    mat_cost: float
    cut_cost: float
    production_status: str


class CustomerOrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    no: str
    customer_ref: str
    cert: str
    net: float
    vat: float
    gross: float
    engine_version: str
    stage: int
    blocked: bool
    released: bool
    release_note: str
    paid: bool
    paid_at: Optional[datetime] = None
    payment_ref: str
    payment_method: str
    price_check: dict
    due_date: Optional[datetime] = None
    rush: bool
    created_at: datetime
    held_at: Optional[datetime] = None
    hold_reason: str = ""
    cancelled_at: Optional[datetime] = None
    cancel_reason: str = ""
    n_positions: int = 0
    positions: list[OrderPositionOut] = []


class CustomerWithOrders(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    name: str
    company: str
    role: Role
    active: bool
    price_group: str
    discount_pct: float
    payment_terms: str
    customer_no: str
    created_at: datetime
    last_login: Optional[datetime] = None
    n_orders: int = 0
    total_net: float = 0.0
    total_gross: float = 0.0

router = APIRouter(prefix="/api/users", tags=["users"],
                   dependencies=[Depends(require_admin)])


@router.get("", response_model=list[UserOut])
def list_users(db: Annotated[Session, Depends(get_db)],
               q: Optional[str] = None,
               role: Optional[Role] = None,
               active: Optional[bool] = None,
               limit: int = Query(default=200, ge=1, le=1000),
               offset: int = Query(default=0, ge=0)) -> list[User]:
    query = db.query(User)
    if q and q.strip():
        like = _like(q)
        query = query.filter(or_(User.email.ilike(like, escape="\\"), User.name.ilike(like, escape="\\"),
                                 User.company.ilike(like, escape="\\"), User.customer_no.ilike(like, escape="\\")))
    if role:
        query = query.filter(User.role == role)
    if active is not None:
        query = query.filter(User.active.is_(active))
    return query.order_by(User.email, User.id).offset(offset).limit(limit).all()


# --------------------------------------------------------------------------
# Kundenübersicht — VOR den /{user_id}-Routen, damit FastAPI "/customers"
# nicht als user_id auffängt.
# --------------------------------------------------------------------------
@router.get("/customers", response_model=list[CustomerWithOrders],
            dependencies=[Depends(require_admin)])
def list_customers(db: Annotated[Session, Depends(get_db)],
                   q: Optional[str] = None,
                   role: Optional[Role] = None,
                   limit: int = Query(default=200, le=1000)) -> list[CustomerWithOrders]:
    """Alle Benutzer mit Auftragsstatistik — die Kundenliste für den Verwaltungsreiter."""
    query = db.query(User)
    if q:
        like = f"%{q.strip().lower()}%"
        query = query.filter(or_(User.email.ilike(like), User.name.ilike(like),
                                 User.company.ilike(like), User.customer_no.ilike(like)))
    if role:
        query = query.filter(User.role == role)
    users = query.order_by(User.email).limit(limit).all()

    totals = {uid: (n, net or 0.0, gross or 0.0) for uid, n, net, gross in (
        db.query(Order.user_id, func.count(Order.id), func.sum(Order.net), func.sum(Order.gross))
          .filter(Order.user_id.in_([u.id for u in users])).group_by(Order.user_id).all())}
    result = []
    for u in users:
        n, net, gross = totals.get(u.id, (0, 0.0, 0.0))
        result.append(CustomerWithOrders(
            id=u.id, email=u.email, name=u.name, company=u.company,
            role=u.role, active=u.active, price_group=u.price_group,
            discount_pct=u.discount_pct, payment_terms=u.payment_terms,
            customer_no=u.customer_no, created_at=u.created_at,
            last_login=u.last_login,
            n_orders=n,
            total_net=round(net, 2),
            total_gross=round(gross, 2),
        ))
    return result


def _like(q: str) -> str:
    esc = q.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{esc}%"


def assert_not_last_admin(db: Session, user: User) -> None:
    """Der letzte aktive Administrator bleibt Administrator und bleibt aktiv.

    Eine Stelle für alle Wege, auf denen er verschwinden könnte — Rolle ändern,
    stilllegen, löschen, Konto selbst schließen. Danach käme niemand mehr an die
    Benutzerverwaltung.
    """
    if user.role != Role.admin or not user.active:
        return
    remaining = (db.query(User)
                   .filter(User.role == Role.admin, User.active.is_(True), User.id != user.id)
                   .count())
    if remaining == 0:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Das ist der letzte aktive Administrator — erst einen zweiten anlegen.")


def _check_customer_no(db: Session, value: str, user_id: int | None = None) -> None:
    if not value:
        return
    clash = db.query(User).filter(User.customer_no == value)
    if user_id is not None:
        clash = clash.filter(User.id != user_id)
    if clash.first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=f"Die Kundennummer {value} ist bereits vergeben.")


def _password_ok(password: str, user_or_email) -> None:
    """Dieselbe Güteprüfung wie bei der Selbstregistrierung — auch für Kennwörter, die ein Admin setzt."""
    from .auth import check_password_strength

    email = getattr(user_or_email, "email", user_or_email) or ""
    name = getattr(user_or_email, "name", "") or ""
    check_password_strength(password, email=email, name=name)


def _plain(v):
    return v.value if hasattr(v, "value") else v


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, db: Annotated[Session, Depends(get_db)],
                actor: Annotated[User, Depends(current_user)]) -> User:
    from .customers import next_customer_no

    email = str(body.email).strip().lower()
    require_internal_email(email, body.role)
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Diese E-Mail-Adresse ist bereits vergeben.")
    _password_ok(body.password, email)
    customer_no = body.customer_no.strip()
    if not customer_no and body.role == Role.customer:
        customer_no = next_customer_no(db)  # „leer = wird vergeben“, wie im Kundenreiter
    _check_customer_no(db, customer_no)
    user = User(email=email, password_hash=hash_password(body.password), name=body.name.strip(),
                company=body.company.strip(), role=body.role, price_group=body.price_group,
                discount_pct=body.discount_pct, payment_terms=body.payment_terms,
                customer_no=customer_no)
    db.add(user)
    db.flush()
    db.add(AuditLog(actor=actor.email, action="user_create", entity="user",
                    entity_id=str(user.id),
                    detail={"email": email, "role": body.role.value, "customer_no": customer_no}))
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, db: Annotated[Session, Depends(get_db)],
                actor: Annotated[User, Depends(current_user)]) -> User:
    """Nur was sich wirklich ändert, wird geändert, geprüft und protokolliert.

    Bis 2026-10 schickte die Oberfläche bei jedem Speichern Rolle und Aktiv-Schalter
    mit; das Backend hielt das für einen Rollenwechsel, beendete alle Sitzungen des
    Kontos (auch die eigene, wer sich selbst bearbeitete) und verweigerte dem
    einzigen Admin, seinen eigenen Namen zu ändern.
    """
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden.")
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items()
               if v is not None and getattr(user, k) != v}
    if not changes:
        return user
    new_role = changes.get("role", user.role)
    new_active = changes.get("active", user.active)
    require_internal_email(user.email, new_role)
    # Werker-Konten dürfen jede Domain haben (die Halle hat nicht überall eine
    # @fyreflysystems.de-Adresse). Deshalb wird ein Kundenkonto nie zum Werker
    # und umgekehrt: ein selbst registriertes Konto bekäme sonst Einblick in
    # alle Aufträge. Werker legt der Admin neu an.
    if "role" in changes and Role.customer in (user.role, new_role) and Role.worker in (user.role, new_role):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Kundenkonten werden nicht zu Werker-Konten. Bitte ein eigenes Werker-Konto anlegen.")
    if new_role != Role.admin or new_active is False:
        assert_not_last_admin(db, user)
    if user.id == actor.id and (new_role != user.role or new_active is False):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Die eigene Rolle und den eigenen Zugang ändert ein anderer Administrator.")
    if "customer_no" in changes:
        changes["customer_no"] = changes["customer_no"].strip()
        _check_customer_no(db, changes["customer_no"], user.id)

    detail = {k: {"alt": _plain(getattr(user, k)), "neu": _plain(v)} for k, v in changes.items()}
    for key, value in changes.items():
        setattr(user, key, value)
    revoked = 0
    if "role" in changes or changes.get("active") is False:
        revoked = revoke_other_sessions(db, user)
    if revoked:
        detail["sitzungen_beendet"] = revoked
    db.add(AuditLog(actor=actor.email, action="user_update", entity="user",
                    entity_id=str(user.id), detail=detail))
    db.commit()
    db.refresh(user)
    return user


def _clear_lock(user: User) -> None:
    user.failed_login_count = 0
    user.locked_until = None
    user.mfa_failed_count = 0
    user.mfa_locked_until = None


@router.post("/{user_id}/password", status_code=status.HTTP_204_NO_CONTENT)
def set_password(user_id: int, body: PasswordSet, db: Annotated[Session, Depends(get_db)],
                 actor: Annotated[User, Depends(current_user)]) -> None:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden.")
    _password_ok(body.password, user)
    user.password_hash = hash_password(body.password)
    _clear_lock(user)  # wer ein neues Kennwort bekommt, soll damit auch hineinkommen
    revoke_other_sessions(db, user)
    db.add(AuditLog(actor=actor.email, action="user_password_reset", entity="user",
                    entity_id=str(user.id)))
    db.commit()


@router.post("/{user_id}/unlock", response_model=UserOut)
def unlock_user(user_id: int, db: Annotated[Session, Depends(get_db)],
                actor: Annotated[User, Depends(current_user)]) -> User:
    """Sperre nach Fehlversuchen (Kennwort und zweiter Faktor) aufheben."""
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden.")
    detail = {"failed_login_count": user.failed_login_count or 0,
              "mfa_failed_count": user.mfa_failed_count or 0}
    _clear_lock(user)
    db.add(AuditLog(actor=actor.email, action="user_unlock", entity="user",
                    entity_id=str(user.id), detail=detail))
    db.commit()
    db.refresh(user)
    return user


@router.post("/{user_id}/mfa/reset", response_model=UserOut)
def reset_mfa(user_id: int, db: Annotated[Session, Depends(get_db)],
              actor: Annotated[User, Depends(current_user)]) -> User:
    """Zweiten Faktor zurücksetzen, wenn Gerät und Wiederherstellungscodes verloren sind.

    Geheimnis und Codes verschwinden, alle Sitzungen enden; das Konto meldet
    sich danach wieder mit dem Kennwort an und richtet den Faktor neu ein.
    """
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden.")
    if not user.totp_enabled and not user.totp_secret_enc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Für dieses Konto ist kein zweiter Faktor eingerichtet.")
    user.totp_secret_enc = ""
    user.totp_enabled = False
    user.totp_confirmed_at = None
    user.totp_last_slot = 0
    user.mfa_failed_count = 0
    user.mfa_locked_until = None
    db.query(RecoveryCode).filter(RecoveryCode.user_id == user.id).delete()
    revoked = revoke_other_sessions(db, user)
    db.add(AuditLog(actor=actor.email, action="mfa_reset_by_admin", entity="user",
                    entity_id=str(user.id), detail={"sitzungen_beendet": revoked}))
    db.commit()
    db.refresh(user)
    return user


@router.delete("/{user_id}")
def delete_user(user_id: int, db: Annotated[Session, Depends(get_db)],
                actor: Annotated[User, Depends(current_user)]) -> dict:
    """Löschen heißt überall dasselbe: erase_user (Art. 17 DSGVO).

    Aufträge müssen zuordenbar bleiben (user_id): wer bestellt hat, wird
    anonymisiert statt gelöscht. Bis 2026-10 wurde so ein Konto hier nur
    stillgelegt — Name, Firma, Adressbuch und Formen blieben — und eines ohne
    Aufträge gelöscht, nachdem seine E-Mail ins Protokoll geschrieben war.
    """
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden.")
    if user.id == actor.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Das eigene Konto lässt sich nicht löschen.")
    assert_not_last_admin(db, user)
    n_orders = db.query(Order).filter(Order.user_id == user.id).count()
    if user.email.endswith("@invalid") and not user.active:
        return {"action": "unchanged", "detail": "Das Konto ist bereits gelöscht."}
    role = _plain(user.role)
    pseudonym = erasure.erase_user(db, user)
    db.add(AuditLog(actor=actor.email, action="user_erase", entity="user",
                    entity_id=str(user.id), detail={"pseudonym": pseudonym, "role": role, "orders": n_orders}))
    db.commit()
    kept = f" — {n_orders} Auftrag/Aufträge bleiben zugeordnet" if n_orders else ""
    return {"action": "erased", "detail": f"Gelöscht und anonymisiert{kept}."}


# --------------------------------------------------------------------------
# Kundenübersicht
# --------------------------------------------------------------------------
@router.get("/{user_id}/orders", response_model=list[CustomerOrderOut],
            dependencies=[Depends(require_admin)])
def customer_orders(
    user_id: int,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[CustomerOrderOut]:
    """Aufträge eines Kunden mit Positionen und Zahlungsdaten (paginiert)."""
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden.")
    base_q = db.query(Order).filter(Order.user_id == user_id)
    total = int(base_q.count() or 0)
    if response is not None:
        response.headers["X-Total-Count"] = str(total)
    orders = (
        base_q.options(
            selectinload(Order.positions).defer(OrderPosition.shape),
            defer(Order.ship_address),
            defer(Order.bill_address),
            defer(Order.office_note),
            defer(Order.manual_shipment),
        )
        .order_by(Order.created_at.desc(), Order.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    result = []
    for o in orders:
        out = CustomerOrderOut.model_validate(o)
        out.n_positions = len(o.positions)
        out.positions = [OrderPositionOut.model_validate(p) for p in o.positions]
        result.append(out)
    return result
