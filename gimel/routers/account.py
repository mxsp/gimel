"""Kundenkonto — eigene Daten, Adressen, Aufträge, Übernahme von Gast-Bestellungen."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Annotated, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import (Address, AuditLog, AuthSession, Order, OrderPosition, PartGeometry,
                      Shipment, ShipmentItem, ShipmentStatus, StructuredInvoiceDocument, User, WorkItem)
from ..schemas import (AccountUpdate, ClaimRequest, EmailChange, MfaConfirm,
                       MfaDisable, MfaStart, PartIn, PartOut, PartPatch, UserOut)
from ..security import current_session_id, current_user, verify_password, require_internal_email
from ..services import erasure, identity, mfa
from ..services.addressbook import clear_flag_on_others, ensure_flags

router = APIRouter(prefix="/api/account", tags=["account"])


@router.get("/me", response_model=UserOut)
def get_me(user: Annotated[User, Depends(current_user)]) -> User:
    return user


@router.patch("/me", response_model=UserOut)
def update_me(body: AccountUpdate, user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_db)]) -> User:
    if body.name is not None:
        user.name = body.name.strip()
    if body.company is not None:
        user.company = body.company.strip()
    db.add(AuditLog(actor=user.email, action="account_update", entity="user", entity_id=str(user.id), detail=body.model_dump()))
    db.commit()
    db.refresh(user)
    return user


# --------------------------------------------------------------------------
# Sicherheit: zweiter Faktor, Sitzungen, Anmeldeadresse
#
# Alles auf dieser Seite verlangt einen frischen Nachweis — Passwort, und wo
# ein zweiter Faktor läuft, auch den. Der Grund ist immer derselbe: ein
# geöffneter Laptop ist ein realistischerer Angreifer als ein gestohlener
# Passworthash, und ein Zugangstoken allein sagt nur, dass irgendwann einmal
# jemand das Passwort kannte.
# --------------------------------------------------------------------------
def _require_password(user: User, password: str) -> None:
    if not verify_password(password or "", user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Das Passwort stimmt nicht.")


def _require_factor(db: Session, user: User, code: str) -> None:
    """Den zweiten Faktor verlangen, wenn einer eingeschaltet ist.

    Ohne diesen Riegel wäre jede Einstellung hier mit dem Passwort allein
    änderbar — und damit der zweite Faktor mit dem ersten abschaltbar.
    """
    if not mfa.is_enabled(user):
        return
    try:
        mfa.check(db, user, code)
    except PermissionError as exc:
        left = int(str(exc))
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail=f"Zu viele falsche Codes — in {left // 60 + 1} Minuten erneut.",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail=str(exc)) from exc


@router.get("/security")
def security_overview(
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
    sid: Annotated[Optional[int], Depends(current_session_id)] = None,
) -> dict:
    """Was die Kontoseite über die Sicherheit des Kontos wissen muss.

    Eine Antwort statt vier: der Zustand des zweiten Faktors, wie viele
    Wiederherstellungscodes noch offen sind, und die Liste der laufenden
    Sitzungen. Ohne diese Liste ist „mein Konto wurde übernommen" eine
    Vermutung; mit ihr ist es eine Zeile mit einem Knopf daneben.
    """
    return {
        "email": user.email,
        "email_verified": bool(user.email_verified),
        "totp_enabled": mfa.is_enabled(user),
        "totp_confirmed_at": (user.totp_confirmed_at.isoformat()
                              if user.totp_confirmed_at else None),
        "recovery_left": mfa.unused_recovery_count(db, user) if mfa.is_enabled(user) else 0,
        "recovery_total": 10,
        "last_login": user.last_login.isoformat() if user.last_login else None,
        "sessions": mfa.sessions_of(db, user, sid),
    }


@router.post("/2fa/start")
def mfa_start(
    body: MfaStart,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Ein Geheimnis erzeugen und als ``otpauth://``-URI ausgeben.

    Der QR wird im Browser gezeichnet (assets/qr.js) und nicht hier: die URI
    ist kurz, ein Bild wäre groß, und ein Geheimnis, das als PNG durch
    Protokolle und Zwischenspeicher reist, ist schlechter aufgehoben als
    eines, das im Textkörper einer einzigen Antwort steht.

    Eingeschaltet wird hier noch nichts — siehe services/mfa.begin_setup.
    """
    _require_password(user, body.current_password)
    try:
        return mfa.begin_setup(db, user)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/2fa/enable")
def mfa_enable(
    body: MfaConfirm,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
    sid: Annotated[Optional[int], Depends(current_session_id)] = None,
) -> dict:
    """Den Code aus der App bestätigen — und die Wiederherstellungscodes zeigen.

    Genau einmal. Danach liegen nur Hashes, und wer sie nicht notiert hat,
    braucht sie hoffentlich nie.
    """
    if mfa.is_enabled(user):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Der zweite Faktor ist bereits eingeschaltet.")
    try:
        codes = mfa.confirm_setup(db, user, body.code, keep_session=sid)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {"enabled": True, "recovery_codes": codes}


@router.post("/2fa/disable", status_code=204)
def mfa_off(
    body: MfaDisable,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
    sid: Annotated[Optional[int], Depends(current_session_id)] = None,
) -> None:
    """Abschalten — Passwort *und* ein gültiger Code.

    Beides, weil sonst ein gestohlenes Passwort genügt, um den Faktor
    loszuwerden, den es gerade aufhalten soll.
    """
    _require_password(user, body.current_password)
    if not mfa.is_enabled(user):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Der zweite Faktor ist nicht eingeschaltet.")
    _require_factor(db, user, body.code)
    mfa.disable(db, user, keep_session=sid)


@router.post("/2fa/recovery")
def mfa_new_recovery(
    body: MfaDisable,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
    sid: Annotated[Optional[int], Depends(current_session_id)] = None,
) -> dict:
    """Neue Wiederherstellungscodes. Die alten gelten sofort nicht mehr."""
    _require_password(user, body.current_password)
    if not mfa.is_enabled(user):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Ohne zweiten Faktor gibt es keine Wiederherstellungscodes.")
    _require_factor(db, user, body.code)
    return {"recovery_codes": mfa.regenerate_recovery(db, user, keep_session=sid)}


@router.post("/email", response_model=UserOut)
def change_email(
    body: EmailChange,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
    sid: Annotated[Optional[int], Depends(current_session_id)] = None,
) -> User:
    """Die Anmeldeadresse wechseln.

    Der Übernahmeweg schlechthin: wer sie ändern kann, lässt sich anschließend
    ein Passwort zurücksetzen. Deshalb Passwort *und* zweiter Faktor, deshalb
    fällt ``email_verified``, und deshalb fliegen alle anderen Sitzungen
    hinaus — die eigene bleibt, sonst wirft sich der Kunde mit der Änderung
    selbst hinaus.
    """
    new = body.new_email.strip().lower()
    require_internal_email(new, user.role)
    if new == user.email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Das ist bereits Ihre Adresse.")
    _require_password(user, body.current_password)
    _require_factor(db, user, body.code)
    if db.query(User).filter(User.email == new).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Diese E-Mail ist bereits vergeben.")
    old = user.email
    user.email = new
    user.email_verified = False
    mfa.revoke_other_sessions(db, user, keep_id=sid)
    db.add(AuditLog(actor=old, action="email_change", entity="user",
                    entity_id=str(user.id), detail={"to": new}))
    db.commit()
    db.refresh(user)
    return user


@router.delete("/sessions/{session_id}", status_code=204)
def revoke_session(
    session_id: int,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    """Eine einzelne Sitzung beenden — auch die eigene, wenn man will."""
    sess = db.get(AuthSession, session_id)
    if not sess or sess.user_id != user.id or sess.revoked_at:
        raise HTTPException(status_code=404, detail="Sitzung nicht gefunden.")
    sess.revoked_at = datetime.now(timezone.utc)
    db.add(AuditLog(actor=user.email, action="session_revoke", entity="user",
                    entity_id=str(user.id), detail={"session": session_id}))
    db.commit()


@router.post("/sessions/revoke-others")
def revoke_other_sessions(
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
    sid: Annotated[Optional[int], Depends(current_session_id)] = None,
) -> dict:
    """Überall abmelden außer hier. Der Knopf für den verlorenen Laptop."""
    n = mfa.revoke_other_sessions(db, user, keep_id=sid)
    db.add(AuditLog(actor=user.email, action="session_revoke_others", entity="user",
                    entity_id=str(user.id), detail={"revoked": n}))
    db.commit()
    return {"revoked": n}


@router.delete("/me", status_code=204)
def delete_me(
    body: MfaDisable,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    """Konto schließen — mit Passwort und, wenn eingeschaltet, zweitem Faktor.

    Bis 2026-09 genügte das Zugangstoken: ein offener Laptop und ein Klick,
    und das Konto war weg. Jetzt hängt es an denselben Nachweisen wie jede
    andere unumkehrbare Änderung.

    Anonymisiert statt gelöscht — die Aufträge müssen aus steuerlichen Gründen
    stehen bleiben (sie tragen ihre eigene Rechnungsanschrift), der Mensch
    dahinter nicht. Gelöscht wird, was nicht aufbewahrt werden muss (Art. 17
    DSGVO): Adressbuch, eigene Formen, Sitzungen samt IP und Browserkennung,
    Wiederherstellungscodes. Die alte E-Mail-Adresse bleibt nirgends stehen,
    auch nicht im Änderungsprotokoll (services/erasure.py).
    """
    _require_password(user, body.current_password)
    _require_factor(db, user, body.code)
    from .users import assert_not_last_admin
    assert_not_last_admin(db, user)
    pseudonym = erasure.erase_user(db, user)
    db.add(AuditLog(actor=pseudonym, action="account_delete", entity="user", entity_id=str(user.id)))
    db.commit()


# ---------- Adressen ----------

class AddressIn(BaseModel):
    label: str = ""
    company: str = ""
    dept: str = ""
    contact: str = ""
    street: str
    zip: str
    city: str
    country: str = "DE"
    vat_id: str = ""
    is_billing: bool = False
    is_delivery: bool = False


class AddressOut(AddressIn):
    id: int

    class Config:
        from_attributes = True


@router.get("/addresses", response_model=List[AddressOut])
def list_addresses(user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_db)]) -> list[Address]:
    return db.query(Address).filter(Address.user_id == user.id).order_by(Address.id).all()


@router.post("/addresses", response_model=AddressOut, status_code=201)
def create_address(body: AddressIn, user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_db)]) -> Address:
    addr = Address(user_id=user.id, **body.model_dump())
    if body.is_billing:
        clear_flag_on_others(db, user.id, keep_id=addr.id, flag="is_billing")
    if body.is_delivery:
        clear_flag_on_others(db, user.id, keep_id=addr.id, flag="is_delivery")
    db.add(addr)
    db.commit()
    ensure_flags(db, user.id)
    db.commit()
    db.refresh(addr)
    return addr


@router.put("/addresses/{addr_id}", response_model=AddressOut)
def update_address(addr_id: int, body: AddressIn, user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_db)]) -> Address:
    addr = db.get(Address, addr_id)
    if not addr or addr.user_id != user.id:
        raise HTTPException(404, "Adresse nicht gefunden.")
    for k, v in body.model_dump().items():
        setattr(addr, k, v)
    if body.is_billing:
        clear_flag_on_others(db, user.id, keep_id=addr.id, flag="is_billing")
    if body.is_delivery:
        clear_flag_on_others(db, user.id, keep_id=addr.id, flag="is_delivery")
    db.commit()
    ensure_flags(db, user.id)
    db.commit()
    db.refresh(addr)
    return addr


@router.delete("/addresses/{addr_id}", status_code=204)
def delete_address(addr_id: int, user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_db)]) -> None:
    addr = db.get(Address, addr_id)
    if not addr or addr.user_id != user.id:
        raise HTTPException(404, "Adresse nicht gefunden.")
    had_role = addr.is_billing or addr.is_delivery
    db.delete(addr)
    db.commit()
    if had_role:
        ensure_flags(db, user.id)
        db.commit()


# ---------- Meine Formen ----------
#
# Bis 2026-11 lag die Teilebibliothek nur im Browser (localStorage): auf dem
# nächsten Gerät war sie leer, und an einem geteilten Rechner sah der Nächste
# die Formen des Vorgängers. Jetzt gehört sie dem Konto. Jede Zeile trägt
# ``user_id``; eine fremde Kennung antwortet 404 wie eine, die es nicht gibt.

#: Größte Kontur als JSON. Ein Vieleck aus einer DXF hat selten mehr als ein
#: paar tausend Punkte (≈ 60 KB); 256 KB lassen Luft und halten die
#: verschlüsselte Spalte klein.
PART_SHAPE_MAX_BYTES = 256 * 1024
#: Formen je Konto.
PART_MAX_PER_USER = 500

_PART_FIELDS = {"t": "label", "fam": "norm_ref", "mat": "mat", "thk": "thk", "od": "od",
                "di": "di", "bn": "bolt_count", "bc": "bolt_circle", "bd": "bolt_d",
                "cutLen": "cut_len", "shape": "shape", "source": "source"}


#: Alle Konturen eines Kontos zusammen. 500 × 256 KB wären ≈ 125 MiB je Konto —
#: genug, um mit ein paar unbestätigten Konten die Platte der VM zu füllen.
PART_BYTES_PER_USER = 8 * 1024 * 1024


def _shape_size(shape: Optional[dict]) -> int:
    if shape is None:
        return 0
    return len(json.dumps(shape, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def _shape_ok(shape: Optional[dict]) -> None:
    if _shape_size(shape) > PART_SHAPE_MAX_BYTES:
        raise HTTPException(413,
                            "Die Kontur ist zu groß (höchstens 256 KB).")


def _budget_ok(db: Session, user: User, adding: int, replacing_id: Optional[int] = None) -> None:
    """Gespeicherte Konturen des Kontos plus die neue, ohne die ersetzte, höchstens
    PART_BYTES_PER_USER. Gezählt wird der gespeicherte Text (verschlüsselt etwas
    größer als das JSON) — so muss nichts entschlüsselt werden."""
    used = db.query(func.coalesce(func.sum(func.length(PartGeometry.shape)), 0)).filter(
        PartGeometry.user_id == user.id)
    if replacing_id is not None:
        used = used.filter(PartGeometry.id != replacing_id)
    if int(used.scalar() or 0) + adding > PART_BYTES_PER_USER:
        raise HTTPException(413, "Meine Formen ist voll: die gespeicherten Konturen sind zusammen "
                                 "zu groß. Bitte nicht mehr gebrauchte Formen löschen.")


def _part_fingerprint(p: PartGeometry) -> str:
    """Dieselbe Form zweimal ist eine Form: Werkstoff, Maße, Norm und Kontur,
    nicht der Name (wie ``rememberPart`` im Portal)."""
    key = [p.mat or "", float(p.od or 0), float(p.di or 0), float(p.thk or 0),
           int(p.bolt_count or 0), float(p.bolt_circle or 0), float(p.bolt_d or 0),
           p.norm_ref or "", p.shape]
    raw = json.dumps(key, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _part_out(p: PartGeometry) -> PartOut:
    return PartOut(id=p.id, t=p.label or "", source=p.source or "NORM", fam=p.norm_ref or "",
                   mat=p.mat or "", thk=p.thk or 0.0, od=p.od or 0.0, di=p.di or 0.0,
                   bn=p.bolt_count or 0, bc=p.bolt_circle or 0.0, bd=p.bolt_d or 0.0,
                   cutLen=p.cut_len or 0.0, shape=p.shape, fingerprint=p.fingerprint,
                   last_ordered=p.last_ordered, created_at=p.created_at)


def _own_part(db: Session, user: User, part_id: int) -> PartGeometry:
    part = db.get(PartGeometry, part_id)
    if not part or part.user_id != user.id:
        raise HTTPException(404, "Form nicht gefunden.")
    return part


def _same_part(db: Session, user: User, fingerprint: str) -> Optional[PartGeometry]:
    return (db.query(PartGeometry)
              .filter(PartGeometry.user_id == user.id, PartGeometry.fingerprint == fingerprint)
              .first())


@router.get("/parts", response_model=List[PartOut])
def list_parts(user: Annotated[User, Depends(current_user)],
               db: Annotated[Session, Depends(get_db)]) -> list[PartOut]:
    rows = (db.query(PartGeometry).filter(PartGeometry.user_id == user.id)
              .order_by(PartGeometry.id.desc()).limit(PART_MAX_PER_USER).all())
    return [_part_out(p) for p in rows]


@router.get("/parts/{part_id}", response_model=PartOut)
def get_part(part_id: int, user: Annotated[User, Depends(current_user)],
             db: Annotated[Session, Depends(get_db)]) -> PartOut:
    return _part_out(_own_part(db, user, part_id))


@router.post("/parts", response_model=PartOut, status_code=201)
def create_part(body: PartIn, response: Response, user: Annotated[User, Depends(current_user)],
                db: Annotated[Session, Depends(get_db)]) -> PartOut:
    """Eine Form ablegen. Liegt dieselbe Form schon da, kommt sie zurück
    (200 statt 201) — so kann das Portal seinen lokalen Bestand gefahrlos
    nachschieben."""
    _shape_ok(body.shape)
    _budget_ok(db, user, _shape_size(body.shape))
    part = PartGeometry(user_id=user.id, label=body.t.strip(),
                        source=body.source or ("FREEFORM" if body.shape else "NORM"),
                        norm_ref=(body.fam or "").strip(), mat=body.mat.strip(), thk=body.thk,
                        od=body.od, di=body.di, bolt_count=body.bn, bolt_circle=body.bc,
                        bolt_d=body.bd, cut_len=body.cutLen, shape=body.shape)
    part.fingerprint = _part_fingerprint(part)
    same = _same_part(db, user, part.fingerprint)
    if same:
        response.status_code = status.HTTP_200_OK
        return _part_out(same)
    if db.query(PartGeometry).filter(PartGeometry.user_id == user.id).count() >= PART_MAX_PER_USER:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Meine Formen ist voll (höchstens {PART_MAX_PER_USER}). "
                            "Bitte zuerst nicht mehr gebrauchte Formen löschen.")
    db.add(part)
    db.flush()
    # Name und Kontur stehen nicht im Protokoll: sie sind Kundendaten und in
    # der Tabelle verschlüsselt.
    db.add(AuditLog(actor=user.email, action="part_create", entity="part",
                    entity_id=str(part.id), detail={"source": part.source}))
    db.commit()
    db.refresh(part)
    return _part_out(part)


@router.patch("/parts/{part_id}", response_model=PartOut)
def update_part(part_id: int, body: PartPatch, user: Annotated[User, Depends(current_user)],
                db: Annotated[Session, Depends(get_db)]) -> PartOut:
    part = _own_part(db, user, part_id)
    changed = []
    for field in sorted(body.model_fields_set):
        value = getattr(body, field)
        if field != "shape" and value is None:
            continue  # nur ``shape`` lässt sich leeren
        if field == "shape":
            _shape_ok(value)
            _budget_ok(db, user, _shape_size(value), replacing_id=part_id)
        if isinstance(value, str):
            value = value.strip()
        column = _PART_FIELDS[field]
        if getattr(part, column) != value:
            setattr(part, column, value)
            changed.append(field)
    if not changed:
        return _part_out(part)
    fingerprint = _part_fingerprint(part)
    other = _same_part(db, user, fingerprint)
    if other and other.id != part.id:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Diese Form liegt bereits in Meine Formen.")
    part.fingerprint = fingerprint
    db.add(AuditLog(actor=user.email, action="part_update", entity="part",
                    entity_id=str(part.id), detail={"fields": changed}))
    db.commit()
    db.refresh(part)
    return _part_out(part)


@router.delete("/parts/{part_id}", status_code=204)
def delete_part(part_id: int, user: Annotated[User, Depends(current_user)],
                db: Annotated[Session, Depends(get_db)]) -> None:
    part = _own_part(db, user, part_id)
    db.delete(part)
    db.add(AuditLog(actor=user.email, action="part_delete", entity="part",
                    entity_id=str(part_id)))
    db.commit()


# ---------- Eigene Aufträge ----------

@router.get("/orders/{no}/tracking")
def my_order_tracking(no: str, user: Annotated[User, Depends(current_user)],
                      db: Annotated[Session, Depends(get_db)]) -> dict:
    order = db.query(Order).filter(Order.no == no, Order.user_id == user.id).first()
    if not order:
        raise HTTPException(404, "Auftrag nicht gefunden.")
    from .admin import _build_timeline
    from .shipping import shipments_by_order
    timeline = [{k: s.get(k) for k in ("id", "label", "done", "current", "at", "blocked")}
                for s in _build_timeline(db, order)]
    doc = db.query(StructuredInvoiceDocument).filter_by(invoice_no=order.invoice_no, order_no=no).first()
    return {"no": no, "account": True, "created_at": order.created_at,
            "checked_at": datetime.now(timezone.utc), "due_date": order.due_date,
            "blocked": order.blocked, "released": order.released,
            "stage_label": next((s["label"] for s in timeline if s["current"]), "Bestellt"),
            "timeline": timeline, "shipments": shipments_by_order(no, db)["shipments"],
            "ship_address": order.ship_address, "bill_address": order.bill_address,
            "positions": [{"label": p.label, "mat": p.mat, "thk": p.thk, "q": p.qty} for p in order.positions],
            "billing": {"status": "paid" if order.paid else "open", "invoice_no": doc.number if doc else order.invoice_no,
                        "due_at": order.invoice_due_at, "einvoice": bool(doc)}}

@router.get("/orders/{no}/invoice.xml")
def my_invoice_xml(no: str, user: Annotated[User, Depends(current_user)],
                   db: Annotated[Session, Depends(get_db)]) -> Response:
    order = db.query(Order).filter(Order.no == no, Order.user_id == user.id).first()
    doc = db.query(StructuredInvoiceDocument).filter_by(invoice_no=order.invoice_no, order_no=no).first() if order else None
    if not doc:
        raise HTTPException(404, "E-Rechnung nicht gefunden.")
    return Response(doc.xml, media_type="application/xml", headers={
        "Content-Disposition": 'attachment; filename="E-Rechnung.xml"', "Cache-Control": "no-store"})

@router.get("/orders")
def my_orders(user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_db)]) -> list[dict]:
    rows = db.query(Order).filter(Order.user_id == user.id).order_by(Order.created_at.desc()).limit(100).all()
    if not rows:
        return []
    structured = {d.invoice_no for d in db.query(StructuredInvoiceDocument.invoice_no)
                  .filter(StructuredInvoiceDocument.invoice_no.in_([o.invoice_no for o in rows] or [""])).all()}
    # Der Kundenstand kommt aus der Fertigung, nicht aus der Spalte: Order.stage
    # wird beim Anlegen geschrieben und danach von keinem Pfad mehr angehoben
    # (weder Sammellauf noch Versand fassen sie an) — wer sie hier roh
    # ausgibt, zeigt „Eingegangen", während das Auftragsbüro längst
    # „In Produktion" sieht. Dieselbe Ableitung wie die Auftragsübersicht
    # (admin.list_orders) und der Portalserver (server/orders.mjs: stageOf),
    # abgebildet auf die drei Kundenstufen 0/1/2.
    order_ids = [o.id for o in rows]
    pos_by_order: dict[int, list] = {}
    for p in db.query(OrderPosition).filter(OrderPosition.order_id.in_(order_ids)).all():
        pos_by_order.setdefault(p.order_id, []).append(p)
    pos_ids = [p.id for ps in pos_by_order.values() for p in ps]
    in_work: set[int] = set()
    if pos_ids:
        for (pid,) in db.query(WorkItem.position_id).filter(WorkItem.position_id.in_(pos_ids)).all():
            if pid is not None:
                in_work.add(pid)
    shipments_by_order: dict[int, dict[int, Shipment]] = {}
    shipped_positions_by_order: dict[int, set[int]] = {}
    if order_ids:
        shipment_rows = (
            db.query(ShipmentItem, Shipment)
            .join(Shipment, ShipmentItem.shipment_id == Shipment.id)
            .filter(ShipmentItem.order_id.in_(order_ids))
            .order_by(Shipment.created_at.desc())
            .all()
        )
        for item, shipment in shipment_rows:
            shipments_by_order.setdefault(item.order_id, {})[shipment.id] = shipment
            if (item.position_id is not None
                    and shipment.status in (ShipmentStatus.shipped,
                                            ShipmentStatus.delivered,
                                            ShipmentStatus.returned)):
                shipped_positions_by_order.setdefault(item.order_id, set()).add(item.position_id)

    shipped_ids = {
        order_id for order_id, positions in pos_by_order.items()
        if positions and {p.id for p in positions}.issubset(
            shipped_positions_by_order.get(order_id, set()))
    }

    def customer_stage(o: Order) -> int:
        o_positions = pos_by_order.get(o.id, [])
        gaskets = [p for p in o_positions if p.kind == "gasket"]
        # Anfrage-Positionen (manual) werden von Hand gefertigt und erreichen
        # nie „done" — sie zählen nicht zum fertigbaren Rest (wie
        # server/orders.mjs stageOf und der Portal-Abgleich).
        producible = [p for p in gaskets if p.production_status != "manual"]
        n_done = sum(1 for p in producible if p.production_status == "done")
        has_work = any(p.id in in_work for p in o_positions)
        n_batched = sum(1 for p in o_positions if p.production_status == "batched")
        if o.id in shipped_ids or (len(producible) > 0 and n_done >= len(producible)):
            derived = 2
        elif has_work or n_batched > 0 or (0 < n_done < len(producible)):
            derived = 1
        else:
            derived = 0
        try:
            stored = max(0, min(2, int(o.stage or 0)))
        except (TypeError, ValueError):
            stored = 0
        return max(stored, derived)

    return [
        {
            "no": o.no,
            "created_at": o.created_at.isoformat() if o.created_at else None,
            "net": o.net,
            "vat": o.vat,
            "gross": o.gross,
            "has_einvoice": o.invoice_no in structured,
            "invoice_no": o.invoice_no,
            "stage": customer_stage(o),
            # Storniert (Aufgabe 45): eigener Schlüssel, die Stufe bleibt, wie
            # sie war — ältere Oberflächen lesen nur ``stage``.
            "cancelled": o.cancelled_at is not None,
            "cert": o.cert,
            "rush": o.rush,
            "paid": o.paid,
            "ref": o.customer_ref or "",
            "ship_address": o.ship_address or {},
            "bill_address": o.bill_address or {},
            "shipments": [
                {
                    "no": s.no,
                    "status": s.status.value,
                    "carrier": s.carrier,
                    "tracking": s.tracking,
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                    "shipped_at": s.shipped_at.isoformat() if s.shipped_at else None,
                    "delivered_at": s.delivered_at.isoformat() if s.delivered_at else None,
                }
                for s in shipments_by_order.get(o.id, {}).values()
            ],
            # Positionen im Portalformat — damit ein Auftrag auf jedem Gerät
            # des Kontos gleich aussieht, nicht nur dort, wo bestellt wurde.
            "pos": [
                {
                    "id": p.id,
                    "kind": p.kind,
                    "t": p.label,
                    "mat": p.mat,
                    "thk": p.thk,
                    "q": p.qty,
                    "od": p.od,
                    "di": p.di,
                    "bn": p.bolt_count,
                    "bc": p.bolt_circle,
                    "bd": p.bolt_d,
                    "cutLen": p.cut_len,
                    "fmt": p.fmt,
                    "shape": p.shape,
                    "fam": p.fam,
                }
                for p in pos_by_order.get(o.id, [])
            ],
        }
        for o in rows
    ]


# ---------- Gast-Bestellungen übernehmen ----------

@router.post("/claim")
def claim_orders(body: ClaimRequest, user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_db)]) -> dict:
    anon = body.anon_id.strip()
    if not anon:
        return {"claimed": 0}
    q = db.query(Order).filter(Order.anon_id == anon, Order.user_id.is_(None))
    rows = q.all()
    n = 0
    for o in rows:
        o.user_id = user.id
        o.claimed_at = datetime.now(timezone.utc)
        n += 1
    if n:
        db.add(AuditLog(actor=user.email, action="claim_orders", entity="order", entity_id=anon, detail={"claimed": n}))
    db.commit()
    return {"claimed": n}


class EmailVerification(BaseModel):
    token: str = Field(min_length=20, max_length=4096)


@router.post("/email-verification/request")
def request_email_verification(
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Prove ownership before exposing historical invoices matched by email."""
    from datetime import timedelta
    import jwt
    import secrets
    from ..config import get_settings
    from ..services import smtp_client

    if user.email_verified:
        return {"verified": True}
    cfg = smtp_client.config()
    if not cfg.configured or cfg.silent or cfg.override:
        raise HTTPException(503, "Die Bestätigungs-E-Mail ist derzeit nicht verfügbar. Bitte den Support kontaktieren.")
    now = datetime.now(timezone.utc)
    recent = db.query(AuditLog).filter(
        AuditLog.actor == user.email,
        AuditLog.action == "email_verification_requested",
        AuditLog.at > now - timedelta(minutes=1),
    ).first()
    if recent:
        raise HTTPException(429, "Bitte eine Minute warten, bevor Sie erneut anfordern.")
    token = jwt.encode({
        "sub": str(user.id), "email": user.email, "scope": "verify-email",
        "iat": now, "exp": now + timedelta(minutes=30), "jti": secrets.token_urlsafe(24),
    }, get_settings().secret_key, algorithm="HS256")
    db.add(AuditLog(actor=user.email, action="email_verification_requested", entity="user", entity_id=str(user.id)))
    db.commit()
    brand = identity.texts(db)
    sent = smtp_client.send(
        to=user.email, subject=f"{brand.mail_subject} · E-Mail-Adresse bestätigen",
        text=f"Bestätigen Sie Ihre E-Mail-Adresse in {brand.product} unter Konto → Rechnungen.\n"
             "Fügen Sie dort diesen Bestätigungscode ein (30 Minuten gültig):\n\n"
             + token + "\n\nFalls Sie dies nicht angefordert haben, ignorieren Sie diese Nachricht.\n" + brand.signature,
        background=False,
    )
    if not sent:
        raise HTTPException(502, "Die E-Mail konnte nicht versendet werden. Bitte später erneut versuchen.")
    return {"sent": True}


@router.post("/email-verification/confirm")
def confirm_email_verification(
    body: EmailVerification,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    import jwt
    from ..config import get_settings
    try:
        payload = jwt.decode(body.token.strip(), get_settings().secret_key, algorithms=["HS256"], options={"require": ["exp", "iat", "sub", "email", "scope"]})
        if payload["scope"] != "verify-email" or payload["sub"] != str(user.id) or payload["email"] != user.email:
            raise ValueError("wrong account")
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(400, "Der Code ist ungültig oder abgelaufen. Bitte neu anfordern.") from None
    user.email_verified = True
    db.add(AuditLog(actor=user.email, action="email_verified", entity="user", entity_id=str(user.id)))
    db.commit()
    return {"verified": True}
