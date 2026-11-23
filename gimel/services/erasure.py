"""Konto löschen, soweit das Gesetz es zulässt (Art. 17 DSGVO).

Aufträge und Rechnungen bleiben stehen — sie tragen ihre eigene Anschrift und
unterliegen der Aufbewahrungspflicht (§ 147 AO, § 257 HGB). Alles andere, was
am Konto hängt, wird gelöscht; die alte E-Mail-Adresse bleibt nirgends
stehen, auch nicht im Änderungsprotokoll. Geteilt von der Kontoseite
(``DELETE /api/account/me``), dem Auftragsbüro (``DELETE /api/customers/{id}``)
und der Benutzerverwaltung (``DELETE /api/users/{id}``).
"""

from __future__ import annotations

import json

from sqlalchemy import String, or_
from sqlalchemy.orm import Session

from .. import fieldcrypt
from ..models import Address, AuditLog, AuthSession, Order, PartGeometry, PasswordReset, StationTask, PunchoutSession, RecoveryCode, User


def _scrub(value, emails: set[str], pseudonym: str):
    """Ersetzt jede der ``emails`` in beliebig verschachteltem JSON."""
    if isinstance(value, str):
        out = value
        for e in emails:
            out = out.replace(e, pseudonym)
        return out
    if isinstance(value, list):
        return [_scrub(v, emails, pseudonym) for v in value]
    if isinstance(value, dict):
        return {k: _scrub(v, emails, pseudonym) for k, v in value.items()}
    return value


def _any_sealed_detail(db: Session) -> bool:
    """Noch Kryptogramme in der Tabelle, obwohl der Schlüssel inzwischen fehlt? Dann nicht per SQL suchen."""
    return db.query(AuditLog.id).filter(
        AuditLog.detail.cast(String).like('%"fe1:%')).first() is not None


def erase_user(db: Session, user: User) -> str:
    """Anonymisiert ``user`` und löscht seine Nebendaten. Liefert das
    Pseudonym (``user:<id>``), unter dem das Protokoll weiterläuft.
    Committet nicht — das bleibt beim Aufrufer.

    Seit 2026-09-30 (Audit P1 #8) auch: jede frühere Adresse des Kontos
    (aus ``email_change``), die Detailfelder der Protokollzeilen zu diesem
    Konto (``account_update`` trug Name, Firma, USt-IdNr.) und die
    Käuferkennung der Punchout-Sitzungen."""
    uid = user.id
    pseudonym = f"user:{uid}"
    own_rows = db.query(AuditLog).filter(AuditLog.entity == "user", AuditLog.entity_id == str(uid)).all()
    emails = {user.email.lower()} if user.email else set()
    for row in own_rows:
        if row.action == "email_change":
            if row.actor:
                emails.add(row.actor.lower())
            to = (row.detail or {}).get("to")
            if isinstance(to, str) and to:
                emails.add(to.lower())
    emails.discard("")

    user.email = f"deleted-{uid}@invalid"
    user.password_hash = "!"
    user.name = "Gelöscht"
    user.company = ""
    user.vat_id = ""
    # Büronotiz und Sperrgrund sind Freitext über die Person — sie gehen mit.
    user.office_note = ""
    user.order_block = False
    user.order_block_reason = ""
    user.active = False
    user.totp_enabled = False
    user.totp_secret_enc = ""
    # Freitext des Büros an den Aufträgen dieser Person: Notiz und Haltegrund
    # gehen, samt ihrer Spur im Protokoll. Der Auftrag selbst und der
    # Stornogrund bleiben — sie belegen den Geschäftsvorfall.
    order_nos = []
    for order in db.query(Order).filter(Order.user_id == uid).all():
        order.office_note = ""
        order.hold_reason = ""
        order_nos.append(order.no)
    if order_nos:
        for row in (db.query(AuditLog)
                    .filter(AuditLog.entity == "order", AuditLog.entity_id.in_(order_nos),
                            AuditLog.action.in_(("order_hold", "order_resume")))
                    .all()):
            row.detail = {"erased": True}
        # Aufgaben der Auftragsbearbeitung trugen bis 2026-11-14 den Haltegrund
        # in der Notiz; eine erledigte Aufgabe wird nicht mehr aufgefrischt.
        db.query(StationTask).filter(StationTask.kind == "process",
                                     StationTask.ref.in_(order_nos)).update(
            {"note": ""}, synchronize_session=False)
    for model in (Address, PartGeometry, AuthSession, RecoveryCode, PasswordReset):
        db.query(model).filter(model.user_id == uid).delete(synchronize_session=False)
    db.query(PunchoutSession).filter(PunchoutSession.user_id == uid).update(
        {"buyer_id": "", "buyer_cookie": "", "hook_url": ""}, synchronize_session=False)

    # Protokoll: wer was getan hat, bleibt — unter dem Pseudonym. Was das
    # Konto über sich selbst hinterlegt hatte, geht.
    for row in own_rows:
        if row.detail:
            row.detail = {"erased": True}
    if emails:
        db.query(AuditLog).filter(AuditLog.actor.in_(list(emails))).update(
            {"actor": pseudonym}, synchronize_session=False)
        if fieldcrypt.enabled() or _any_sealed_detail(db):
            # Das Detailfeld liegt verschlüsselt: SQL sieht darin keine Adresse.
            # Also Zeile für Zeile lesen (der Typ entschlüsselt) und prüfen.
            mentions = []
            for row in db.query(AuditLog).filter(AuditLog.detail.isnot(None)).yield_per(500):
                if row.detail and any(e in json.dumps(row.detail, ensure_ascii=False).lower() for e in emails):
                    mentions.append(row)
        else:
            mentions = db.query(AuditLog).filter(
                or_(*[AuditLog.detail.cast(String).ilike(f"%{e}%") for e in emails])).all()
        for row in mentions:
            row.detail = _scrub(row.detail, emails, pseudonym)
        db.query(AuditLog).filter(AuditLog.entity_id.in_(list(emails))).update(
            {"entity_id": pseudonym}, synchronize_session=False)
    return pseudonym
