"""Kundenstamm des Auftragsbüros — die Kundendatenbank für das interne Portal.

Es gibt bereits ``/api/users/customers`` (nur Admin, Benutzerverwaltung). Was
dem Vertrieb fehlt, ist dieselbe Wahrheit ohne Adminrechte und mit dem Blick
aus dem Auftragsbüro: suchen, anlegen, Konditionen pflegen — Preisgruppe,
Rabatt, Zahlungsziel, Kreditrahmen. Liest und schreibt dieselben ``users``-
und ``addresses``-Zeilen wie der Rest des Systems; es gibt genau einen
Kundenstamm, keine zweite Kundentabelle.
"""

from __future__ import annotations

import secrets
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import chunked_in, get_db
from ..models import Address, AuditLog, Order, Role, User
from ..security import hash_password, require_staff
from .auth import check_password_strength
from ..services import erasure, settings_store
from ..services.addressbook import clear_flag_on_others, ensure_flags

router = APIRouter(
    prefix="/api/customers", tags=["customers"], dependencies=[Depends(require_staff)]
)


class AddressOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    label: str
    company: str
    dept: str
    contact: str
    street: str
    zip: str
    city: str
    country: str
    vat_id: str
    is_billing: bool
    is_delivery: bool


class AddressIn(BaseModel):
    label: str = ""
    company: str = ""
    dept: str = ""
    contact: str = ""
    street: str = Field(min_length=1, max_length=200)
    zip: str = Field(min_length=1, max_length=20)
    city: str = Field(min_length=1, max_length=120)
    country: str = Field(default="DE", min_length=2, max_length=2)
    vat_id: str = ""
    is_billing: bool = False
    #: Standard-Lieferanschrift — der Vorschlag an der Auftragserfassung.
    is_delivery: bool = False


class CustomerOut(BaseModel):
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
    credit_limit: float
    vat_id: str
    created_at: datetime
    last_login: Optional[datetime] = None
    n_orders: int = 0
    total_net: float = 0.0
    open_net: float = 0.0
    #: Stand des Kunden (Aufgabe 45). Stornierte Aufträge zählen nirgends.
    open_gross: float = 0.0
    n_open: int = 0
    n_cancelled: int = 0
    last_order_at: Optional[datetime] = None
    #: Kreditrahmen: 0 heißt „kein Rahmen gesetzt", nicht „kein Kredit". Dann
    #: bleiben ``credit_free`` und ``credit_pct`` leer.
    credit_used: float = 0.0
    credit_free: Optional[float] = None
    credit_pct: Optional[float] = None
    order_block: bool = False
    order_block_reason: str = ""
    office_note: str = ""


class CustomerCreate(BaseModel):
    email: EmailStr
    name: str = Field(default="", max_length=160)
    company: str = Field(default="", max_length=160)
    # Passwort optional: ohne eines vergibt das System ein Zufallspasswort und
    # der Kunde bekommt es über den üblichen Weg — das Auftragsbüro bestellt
    # hier für jemanden, wer das Konto später nutzt, ist eine andere Frage.
    password: str = Field(default="", max_length=200)
    price_group: str = Field(default="standard", max_length=40)
    discount_pct: float = Field(default=0.0, ge=0, le=100)
    payment_terms: str = Field(default="30 Tage netto", max_length=80)
    customer_no: str = Field(default="", max_length=40)
    credit_limit: float = Field(default=0.0, ge=0)
    vat_id: str = Field(default="", max_length=40)
    office_note: str = Field(default="", max_length=2000)
    #: Anschriften gleich mit anlegen. Ein Kunde ohne Anschrift kann nichts
    #: bestellen, also entsteht sie ohnehin im selben Gespräch — sie hinterher
    #: einzeln nachzutragen war ein Umweg, auf dem sie liegen bleiben konnte.
    addresses: list[AddressIn] = Field(default_factory=list)


class CustomerUpdate(BaseModel):
    """Alle Felder optional — PATCH ändert nur, was mitkommt."""

    name: Optional[str] = Field(default=None, max_length=160)
    company: Optional[str] = Field(default=None, max_length=160)
    active: Optional[bool] = None
    price_group: Optional[str] = Field(default=None, max_length=40)
    discount_pct: Optional[float] = Field(default=None, ge=0, le=100)
    payment_terms: Optional[str] = Field(default=None, max_length=80)
    customer_no: Optional[str] = Field(default=None, max_length=40)
    credit_limit: Optional[float] = Field(default=None, ge=0)
    vat_id: Optional[str] = Field(default=None, max_length=40)
    order_block: Optional[bool] = None
    order_block_reason: Optional[str] = Field(default=None, max_length=200)
    office_note: Optional[str] = Field(default=None, max_length=2000)


_EMPTY_STATS = {
    "n_orders": 0, "total_net": 0.0, "open_net": 0.0, "open_gross": 0.0,
    "n_open": 0, "n_cancelled": 0, "last_order_at": None,
}


def _stats_many(db: Session, user_ids: list[int]) -> dict[int, dict]:
    """Auftragszahlen für viele Kunden in einer Abfrage.

    Bis 2026-11 lief je Kundenzeile eine eigene Abfrage; bei einigen hundert
    Kunden war das die langsamste Seite des Büros. Stornierte Aufträge zählen
    weder zum Umsatz noch zum offenen Betrag — sie stehen nur als eigene Zahl da.
    """
    out: dict[int, dict] = {uid: dict(_EMPTY_STATS) for uid in user_ids}
    if not user_ids:
        return out
    cancelled = Order.cancelled_at.isnot(None)
    rows = (
        db.query(
            Order.user_id,
            Order.paid,
            cancelled,
            func.count(Order.id),
            func.coalesce(func.sum(Order.net), 0.0),
            func.coalesce(func.sum(Order.gross), 0.0),
            func.max(Order.created_at),
        )
        .filter(chunked_in(Order.user_id, user_ids))
        .group_by(Order.user_id, Order.paid, cancelled)
        .all()
    )
    for uid, paid, is_cancelled, count, net_sum, gross_sum, last in rows:
        s = out[uid]
        if is_cancelled:
            s["n_cancelled"] += count
            continue
        if last is not None and (s["last_order_at"] is None or last > s["last_order_at"]):
            s["last_order_at"] = last
        s["n_orders"] += count
        s["total_net"] += float(net_sum or 0)
        if not paid:
            s["n_open"] += count
            s["open_net"] += float(net_sum or 0)
            s["open_gross"] += float(gross_sum or 0)
    for s in out.values():
        for key in ("total_net", "open_net", "open_gross"):
            s[key] = round(s[key], 2)
    return out


def _stats(db: Session, user_id: int) -> dict:
    return _stats_many(db, [user_id])[user_id]


def _credit(limit: float, open_gross: float) -> dict:
    """Ausschöpfung des Kreditrahmens — gegen brutto, wie die Freigaberegel
    (``services/orders.release_on_account``) rechnet."""
    if not limit or limit <= 0:
        return {"credit_used": open_gross, "credit_free": None, "credit_pct": None}
    return {
        "credit_used": open_gross,
        "credit_free": round(limit - open_gross, 2),
        "credit_pct": round(100.0 * open_gross / limit, 1),
    }


def _out(db: Session, u: User, stats: Optional[dict] = None) -> CustomerOut:
    stats = stats if stats is not None else _stats(db, u.id)
    return CustomerOut(
        id=u.id,
        email=u.email,
        name=u.name,
        company=u.company,
        role=u.role,
        active=u.active,
        price_group=u.price_group,
        discount_pct=u.discount_pct,
        payment_terms=u.payment_terms,
        customer_no=u.customer_no,
        credit_limit=u.credit_limit,
        vat_id=u.vat_id,
        created_at=u.created_at,
        last_login=u.last_login,
        order_block=bool(u.order_block),
        order_block_reason=u.order_block_reason or "",
        office_note=u.office_note or "",
        **stats,
        **_credit(u.credit_limit or 0.0, stats["open_gross"]),
    )


def _get_customer(db: Session, customer_id: int) -> User:
    """Nur Kundenkonten: Personal- und Adminkonten werden hier weder gelesen noch geändert."""
    user = db.get(User, customer_id)
    if not user or user.role != Role.customer:
        raise HTTPException(status_code=404, detail="Kunde nicht gefunden.")
    return user


def _like(q: str) -> str:
    """Suchtext für LIKE, mit maskierten Platzhaltern (\\, %, _)."""
    esc = q.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{esc}%"


@router.get("", response_model=list[CustomerOut])
def list_customers(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    q: Optional[str] = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
    include_removed: bool = False,
) -> list[CustomerOut]:
    """Kundenliste mit Auftragsstatistik — die Tabelle der Kundenpflege."""
    query = db.query(User).filter(User.role == Role.customer)
    if not include_removed:
        query = query.filter(~User.email.like("%@invalid"))
    if q and q.strip():
        like = _like(q)
        query = query.filter(
            or_(
                User.email.ilike(like, escape="\\"),
                User.name.ilike(like, escape="\\"),
                User.company.ilike(like, escape="\\"),
                User.customer_no.ilike(like, escape="\\"),
            )
        )
    total = int(query.count() or 0)
    response.headers["X-Total-Count"] = str(total)
    users = query.order_by(User.company, User.name, User.email, User.id).offset(offset).limit(limit).all()
    stats = _stats_many(db, [u.id for u in users])
    return [_out(db, u, stats[u.id]) for u in users]


def next_customer_no(db: Session) -> str:
    """Nächste freie Kundennummer, fortlaufend hinter dem Präfix.

    Gezählt wird nicht die Zahl der Kunden, sondern die höchste bereits
    vergebene Nummer: ein stillgelegtes Konto darf seine Nummer nicht an einen
    neuen Kunden weiterreichen — auf alten Rechnungen steht sie noch.
    """
    prefix = settings_store.get(db, "customer_prefix", "KD-26")
    # Indiziertes ORDER BY DESC holt die höchsten Nummern ohne Vollscan.
    used = (
        db.query(User.customer_no)
        .filter(User.customer_no.like(f"{prefix}-%"))
        .order_by(func.length(User.customer_no).desc(), User.customer_no.desc())
        .limit(50)
        .all()
    )
    highest = 0
    for (no,) in used:
        tail = (no or "").rsplit("-", 1)[-1]
        if tail.isdigit():
            highest = max(highest, int(tail))
    return f"{prefix}-{highest + 1:04d}"


@router.get("/next-number")
def peek_customer_no(
    db: Annotated[Session, Depends(get_db)], _: Annotated[User, Depends(require_staff)]
) -> dict:
    """Die Nummer, die der nächste neue Kunde bekäme — damit die Maske sie
    zeigen kann, bevor gespeichert wird. Sie wird nicht reserviert."""
    return {"customer_no": next_customer_no(db)}


class DuplicateOut(BaseModel):
    id: int
    customer_no: str
    company: str
    name: str
    email: str
    #: Woran der Treffer hängt: "email", "vat_id", "company", "domain".
    why: list[str]


#: Postfächer, bei denen dieselbe Domain nichts über dieselbe Firma sagt.
_FREEMAIL = {
    "gmail.com", "googlemail.com", "gmx.de", "gmx.net", "web.de", "t-online.de",
    "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "yahoo.com", "yahoo.de",
    "icloud.com", "posteo.de", "mailbox.org", "freenet.de", "aol.com", "live.de",
}


def _norm_company(text: str) -> str:
    """Firmenname ohne Rechtsform, Satzzeichen und Großschreibung."""
    words = "".join(c if c.isalnum() else " " for c in (text or "").lower()).split()
    drop = {"gmbh", "ag", "kg", "ohg", "gbr", "ug", "mbh", "co", "se", "ev", "e", "k",
            "und", "the", "ltd", "inc"}
    return " ".join(w for w in words if w not in drop)


def _norm_vat(text: str) -> str:
    return "".join(c for c in (text or "").upper() if c.isalnum())


@router.get("/duplicates", response_model=list[DuplicateOut])
def find_duplicates(
    db: Annotated[Session, Depends(get_db)],
    email: str = Query(default="", max_length=254),
    company: str = Query(default="", max_length=160),
    vat_id: str = Query(default="", max_length=40),
    exclude_id: Optional[int] = None,
) -> list[DuplicateOut]:
    """Mögliche Dubletten, bevor ein Kunde gespeichert wird.

    Ein Hinweis, keine Sperre: zwei Niederlassungen derselben Firma sind zwei
    Kunden. Verglichen wird im Programm, nicht in SQL — die Normalisierung
    (Rechtsform, Leerzeichen in der USt-IdNr.) kennt die Datenbank nicht, und
    ein Kundenstamm hat hunderte Zeilen, nicht Millionen.
    """
    want_email = email.strip().lower()
    want_domain = want_email.rsplit("@", 1)[-1] if "@" in want_email else ""
    if want_domain in _FREEMAIL:
        want_domain = ""
    want_company = _norm_company(company)
    want_vat = _norm_vat(vat_id)
    if not (want_email or want_company or want_vat):
        return []
    # SQL-Vorfilter, damit Dublettenprüfung auch bei hunderttausenden Kunden schnell bleibt.
    prefilters = []
    if want_email:
        prefilters.append(func.lower(User.email) == want_email)
    if want_domain:
        prefilters.append(User.email.ilike(f"%@{want_domain}"))
    if want_vat and len(want_vat) >= 8:
        vat_clean = func.replace(func.replace(func.replace(User.vat_id, " ", ""), "-", ""), ".", "")
        prefilters.append(vat_clean.ilike(f"%{want_vat[-6:]}%"))
    if want_company and len(want_company) >= 3:
        first_token = want_company.split()[0]
        if len(first_token) >= 2:
            prefilters.append(User.company.ilike(f"%{first_token}%"))
    if not prefilters:
        return []
    rows = (
        db.query(User.id, User.email, User.company, User.name, User.vat_id,
                 User.customer_no)
        .filter(User.role == Role.customer)
        .filter(~User.email.like("%@invalid"))
        .filter(or_(*prefilters))
        .limit(500)
        .all()
    )
    hits: list[DuplicateOut] = []
    for u in rows:
        if exclude_id is not None and u.id == exclude_id:
            continue
        why: list[str] = []
        u_email = (u.email or "").lower()
        if want_email and u_email == want_email:
            why.append("email")
        if want_vat and len(want_vat) >= 8 and _norm_vat(u.vat_id) == want_vat:
            why.append("vat_id")
        if want_company and len(want_company) >= 3 and _norm_company(u.company) == want_company:
            why.append("company")
        if (want_domain and "email" not in why
                and u_email.rsplit("@", 1)[-1] == want_domain):
            why.append("domain")
        if why:
            hits.append(DuplicateOut(id=u.id, customer_no=u.customer_no or "",
                                     company=u.company or "", name=u.name or "",
                                     email=u.email, why=why))
    order = {"email": 0, "vat_id": 1, "company": 2, "domain": 3}
    hits.sort(key=lambda h: (order[h.why[0]], h.company.lower()))
    return hits[:10]


@router.post("", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
def create_customer(
    body: CustomerCreate,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> CustomerOut:
    """Neuer Kunde mit Konditionen — vom Auftragsbüro, für den Personalkontakt."""
    email = str(body.email).strip().lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Diese E-Mail-Adresse ist bereits vergeben.",
        )
    if body.password:
        check_password_strength(body.password, email=email, name=body.name)
    customer_no = (body.customer_no or "").strip()
    if customer_no and db.query(User).filter(User.customer_no == customer_no).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Diese Kundennummer ist bereits vergeben.",
        )
    # Kein Zahlungslimit gesetzt → ein Standard, der vorsichtig ist: Rechnung
    # erst nach Zahlungseingang ist die sichere Seite im B2B-Neugeschäft.
    user = User(
        email=email,
        password_hash=hash_password(body.password or secrets.token_urlsafe(24)),
        name=body.name,
        company=body.company,
        role=Role.customer,
        price_group=body.price_group,
        discount_pct=body.discount_pct,
        payment_terms=body.payment_terms,
        # Leer gelassen heisst „vergib eine": eine Kundennummer von Hand zu
        # tippen ist die haeufigste Quelle doppelter Nummern.
        customer_no=customer_no or next_customer_no(db),
        credit_limit=body.credit_limit,
        vat_id=body.vat_id,
        office_note=body.office_note.strip(),
    )
    try:
        db.add(user)
        db.flush()

        # Anschriften im selben Vorgang. Rechnungs- und Lieferstandard arbitriert
        # der gemeinsame Helfer — zwei Rechnungsanschriften sind keine Angabe,
        # sondern ein Fehler, der später an der Kasse auffällt.
        for addr in body.addresses:
            db.add(Address(user_id=user.id, **addr.model_dump()))
        db.flush()
        ensure_flags(db, user.id)

        db.add(
            AuditLog(
                actor=actor.email,
                action="desk_customer_create",
                entity="user",
                entity_id=str(user.id),
                detail={
                    "email": email,
                    "company": body.company,
                    "price_group": body.price_group,
                    "discount_pct": body.discount_pct,
                    "payment_terms": body.payment_terms,
                    "addresses": len(body.addresses),
                },
            )
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="E-Mail-Adresse oder Kundennummer ist bereits vergeben.",
        ) from exc
    db.refresh(user)
    return _out(db, user)


@router.get("/{customer_id}", response_model=CustomerOut)
def get_customer(
    customer_id: int, db: Annotated[Session, Depends(get_db)]
) -> CustomerOut:
    user = _get_customer(db, customer_id)
    return _out(db, user)


@router.patch("/{customer_id}", response_model=CustomerOut)
def update_customer(
    customer_id: int,
    body: CustomerUpdate,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> CustomerOut:
    user = _get_customer(db, customer_id)
    changes = body.model_dump(exclude_unset=True)
    # Ein ausdrückliches ``null`` heißt „nicht angegeben", nie „leeren".
    changes = {k: v for k, v in changes.items() if v is not None}
    # Eine Sperre ohne Grund ist später nicht mehr nachvollziehbar; beim
    # Aufheben fällt der Grund mit weg.
    if changes.get("order_block") is True and not user.order_block:
        reason = (changes.get("order_block_reason") or "").strip()
        if len(reason) < 3:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Eine Auftragssperre braucht einen Grund (mindestens drei Zeichen).",
            )
        changes["order_block_reason"] = reason
    if changes.get("order_block") is False:
        changes["order_block_reason"] = ""
    # Der Grund allein lässt sich ändern, aber nicht leeren, solange gesperrt ist.
    will_block = changes.get("order_block", user.order_block)
    if (will_block and "order_block_reason" in changes
            and len((changes["order_block_reason"] or "").strip()) < 3):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Eine Auftragssperre braucht einen Grund (mindestens drei Zeichen).",
        )
    for key in ("order_block_reason", "office_note", "customer_no"):
        if isinstance(changes.get(key), str):
            changes[key] = changes[key].strip()
    if changes.get("customer_no") and changes["customer_no"] != user.customer_no:
        if db.query(User).filter(User.customer_no == changes["customer_no"], User.id != user.id).first():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Diese Kundennummer ist bereits vergeben.",
            )
    # Nur was sich wirklich ändert, wird geschrieben und protokolliert.
    changes = {k: v for k, v in changes.items() if getattr(user, k) != v}
    if not changes:
        return _out(db, user)
    for key, value in changes.items():
        setattr(user, key, value)
    logged = dict(changes)
    # Die Büronotiz ist Freitext über einen Kunden — im Protokoll steht nur,
    # dass sie geändert wurde, nicht was darin steht.
    if "office_note" in logged:
        logged["office_note"] = {"changed": True}
    db.add(
        AuditLog(
            actor=actor.email,
            action="desk_customer_update",
            entity="user",
            entity_id=str(user.id),
            detail=logged,
        )
    )
    if "order_block" in changes:
        db.add(
            AuditLog(
                actor=actor.email,
                action="customer_block" if changes["order_block"] else "customer_unblock",
                entity="user",
                entity_id=str(user.id),
                detail={"reason": user.order_block_reason},
            )
        )
    db.commit()
    db.refresh(user)
    return _out(db, user)


@router.get("/{customer_id}/addresses", response_model=list[AddressOut])
def list_addresses(
    customer_id: int, db: Annotated[Session, Depends(get_db)]
) -> list[AddressOut]:
    user = _get_customer(db, customer_id)
    return list(user.addresses)


@router.post(
    "/{customer_id}/addresses",
    response_model=AddressOut,
    status_code=status.HTTP_201_CREATED,
)
def add_address(
    customer_id: int,
    body: AddressIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> Address:
    user = _get_customer(db, customer_id)
    addr = Address(user_id=user.id, **body.model_dump())
    db.add(addr)
    db.flush()
    if body.is_billing:
        clear_flag_on_others(db, user.id, keep_id=addr.id, flag="is_billing")
    if body.is_delivery:
        clear_flag_on_others(db, user.id, keep_id=addr.id, flag="is_delivery")
    ensure_flags(db, user.id)
    db.add(
        AuditLog(
            actor=actor.email,
            action="desk_address_create",
            entity="address",
            entity_id=str(customer_id),
            detail={"city": body.city},
        )
    )
    db.commit()
    db.refresh(addr)
    return addr


@router.put("/{customer_id}/addresses/{address_id}", response_model=AddressOut)
def update_address(
    customer_id: int,
    address_id: int,
    body: AddressIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> Address:
    user = _get_customer(db, customer_id)
    addr = db.get(Address, address_id)
    if not addr or addr.user_id != user.id:
        raise HTTPException(status_code=404, detail="Anschrift nicht gefunden.")
    data = body.model_dump()
    for k, v in data.items():
        setattr(addr, k, v)
    if body.is_billing:
        clear_flag_on_others(db, user.id, keep_id=addr.id, flag="is_billing")
    if body.is_delivery:
        clear_flag_on_others(db, user.id, keep_id=addr.id, flag="is_delivery")
    db.add(
        AuditLog(
            actor=actor.email,
            action="desk_address_update",
            entity="address",
            entity_id=str(address_id),
            detail={"city": body.city, "customer_id": customer_id},
        )
    )
    db.commit()
    ensure_flags(db, user.id)
    db.commit()
    db.refresh(addr)
    return addr


@router.delete(
    "/{customer_id}/addresses/{address_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_address(
    customer_id: int,
    address_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> None:
    user = _get_customer(db, customer_id)
    addr = db.get(Address, address_id)
    if not addr or addr.user_id != user.id:
        raise HTTPException(status_code=404, detail="Anschrift nicht gefunden.")
    was_billing = addr.is_billing
    was_delivery = addr.is_delivery
    db.delete(addr)
    db.flush()
    if was_billing or was_delivery:
        ensure_flags(db, user.id)
    db.add(
        AuditLog(
            actor=actor.email,
            action="desk_address_delete",
            entity="address",
            entity_id=str(address_id),
            detail={"customer_id": customer_id},
        )
    )
    db.commit()


@router.delete("/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_customer(
    customer_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> None:
    user = _get_customer(db, customer_id)
    if user.role != Role.customer:
        raise HTTPException(
            status_code=400, detail="Nur Kunden können entfernt werden."
        )
    if user.email.startswith("deleted_") or user.email.endswith("@invalid"):
        raise HTTPException(status_code=409, detail="Dieser Kunde wurde bereits entfernt.")
    customer_no = user.customer_no or ""
    pseudonym = erasure.erase_user(db, user)
    db.add(
        AuditLog(
            actor=actor.email,
            action="desk_customer_delete",
            entity="user",
            entity_id=str(user.id),
            detail={"customer": pseudonym, "customer_no": customer_no},
        )
    )
    db.commit()


@router.get("/{customer_id}/orders")
def customer_orders(
    customer_id: int,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
):
    """Aufträge eines Kunden für die Kundenkarte — für das ganze Personal.

    /api/users/{id}/orders ist Administratoren vorbehalten; die Kundenkarte im
    Auftragsbüro brach deshalb für Personal ab, bevor die Anschriften luden.
    """
    from .users import customer_orders as _orders
    _get_customer(db, customer_id)
    return _orders(customer_id, response, db, offset=offset, limit=limit)
