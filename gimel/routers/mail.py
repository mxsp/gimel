"""E-Mail-Zentrale für ERP & Copilot Lab: Posteingang, Entwürfe, Gesendet,
Vorlagen (Bestellung, Preisanfrage/RFQ, Kundenupdate), SMTP-Versand & optionaler IMAP-Abruf."""

from __future__ import annotations

import email as pyemail
import imaplib
import re
import ssl
from datetime import datetime, timezone
from email.header import decode_header
from email.utils import parseaddr
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import (
    AuditLog,
    FactorySetting,
    MailMessage,
    Order,
    Product,
    PurchaseOrder,
    Supplier,
    User,
)
from ..security import require_admin, require_staff
from ..services import scm_analytics, secretbox, smtp_client

router = APIRouter(prefix="/api/mail", tags=["mail"])

ORDER_REF_RE = re.compile(r"\b(AB-[A-Z0-9\-]+)\b", re.I)
PO_REF_RE = re.compile(r"\b(BE-[A-Z0-9\-]+)\b", re.I)
WO_REF_RE = re.compile(r"\b(IA-[A-Z0-9\-]+)\b", re.I)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _get_fset(db: Session, key: str, default: str = "") -> str:
    row = db.get(FactorySetting, f"mail.{key}")
    return (row.value or default) if row else default


def _set_fset(db: Session, key: str, value: str, actor: str) -> None:
    full = f"mail.{key}"
    row = db.get(FactorySetting, full)
    if row is None:
        db.add(FactorySetting(key=full, value=value[:400], updated_by=actor))
    else:
        row.value = value[:400]
        row.updated_by = actor


def resolve_mail_config(db: Session) -> dict:
    """Kombiniert Umgebungskonfiguration (smtp_client) mit optionaler DB-Konfiguration."""
    env_cfg = smtp_client.config()
    smtp_host = _get_fset(db, "smtp_host") or env_cfg.host
    smtp_port = int(_get_fset(db, "smtp_port") or env_cfg.port or 587)
    smtp_secure = _get_fset(db, "smtp_secure") or env_cfg.secure or "starttls"
    smtp_user = _get_fset(db, "smtp_user") or env_cfg.user
    smtp_from = _get_fset(db, "smtp_from") or env_cfg.sender or smtp_user
    smtp_from_name = _get_fset(db, "smtp_from_name") or env_cfg.sender_name or "Gimel ERP"
    smtp_pass_enc = _get_fset(db, "smtp_pass_enc")
    smtp_pass = secretbox.open_(smtp_pass_enc) if smtp_pass_enc else env_cfg.password
    silent_str = _get_fset(db, "silent")
    silent = (silent_str == "1") if silent_str != "" else (env_cfg.silent or not bool(smtp_host and smtp_from))

    imap_host = _get_fset(db, "imap_host")
    imap_port = int(_get_fset(db, "imap_port") or 993)
    imap_user = _get_fset(db, "imap_user")
    imap_pass_enc = _get_fset(db, "imap_pass_enc")
    imap_pass = secretbox.open_(imap_pass_enc) if imap_pass_enc else ""
    imap_folder = _get_fset(db, "imap_folder") or "INBOX"

    return {
        "smtp_host": smtp_host,
        "smtp_port": smtp_port,
        "smtp_secure": smtp_secure,
        "smtp_user": smtp_user,
        "smtp_pass": smtp_pass,
        "smtp_from": smtp_from,
        "smtp_from_name": smtp_from_name,
        "silent": silent,
        "smtp_configured": bool(smtp_host and smtp_from),
        "imap_host": imap_host,
        "imap_port": imap_port,
        "imap_user": imap_user,
        "imap_pass": imap_pass,
        "imap_folder": imap_folder,
        "imap_configured": bool(imap_host and imap_user and imap_pass),
    }


def deliver_mail_message(db: Session, msg: MailMessage, actor_email: str) -> tuple[bool, str]:
    """Versendet eine MailMessage über SMTP oder bucht sie im lokalen Trockenlauf."""
    cfg = resolve_mail_config(db)
    recipients = [str(x).strip() for x in (msg.to_addrs or []) if str(x).strip()]
    if not recipients:
        raise HTTPException(422, "Mindestens ein Empfänger erforderlich.")

    sender = cfg["smtp_from"] or actor_email or "erp@gimel.local"
    now = _now()
    mode = "silent"
    ok = True
    err_note = ""

    if cfg["smtp_configured"] and not cfg["silent"]:
        mcfg = smtp_client.MailConfig(
            host=cfg["smtp_host"],
            port=int(cfg["smtp_port"]),
            secure=cfg["smtp_secure"],
            user=cfg["smtp_user"],
            password=cfg["smtp_pass"],
            sender=sender,
            sender_name=cfg["smtp_from_name"],
            reply_to=msg.reply_to or "",
            silent=False,
        )
        built = smtp_client._build(
            mcfg,
            to=recipients,
            subject=msg.subject or "(Kein Betreff)",
            text=msg.body_text or "",
            html=msg.body_html or "",
        )
        try:
            smtp_client._deliver(mcfg, recipients, built)
            mode = "smtp"
        except Exception as exc:  # noqa: BLE001
            ok = False
            mode = "failed"
            err_note = f"{type(exc).__name__}: {exc}"[:380]

    msg.from_addr = sender
    msg.from_name = cfg["smtp_from_name"]
    msg.direction = "outbound"
    msg.folder = "sent" if ok else "drafts"
    msg.status = "sent" if ok else "failed"
    msg.delivery_mode = mode
    msg.error_note = err_note
    msg.actor = actor_email
    if ok:
        msg.sent_at = now
    db.add(
        AuditLog(
            actor=actor_email,
            action="mail_center_send" if ok else "mail_center_fail",
            entity="mail_message",
            entity_id=str(msg.id),
            detail={"to": recipients, "subject": msg.subject[:120], "mode": mode},
        )
    )
    return ok, mode


def _msg_out(m: MailMessage, sups: dict[int, Supplier] | None = None) -> dict:
    sup_name = ""
    if sups and m.supplier_id and m.supplier_id in sups:
        sup_name = sups[m.supplier_id].name
    return {
        "id": m.id,
        "direction": m.direction,
        "folder": m.folder,
        "status": m.status,
        "from_addr": m.from_addr,
        "from_name": m.from_name,
        "to_addrs": m.to_addrs or [],
        "cc_addrs": m.cc_addrs or [],
        "reply_to": m.reply_to,
        "subject": m.subject,
        "body_text": m.body_text or "",
        "ai_summary": m.ai_summary or "",
        "ai_drafted": bool(m.ai_drafted),
        "thread_key": m.thread_key,
        "order_no": m.order_no,
        "work_order_no": m.work_order_no,
        "purchase_order_no": m.purchase_order_no,
        "supplier_id": m.supplier_id,
        "supplier_name": sup_name,
        "customer_id": m.customer_id,
        "proposal_id": m.proposal_id,
        "is_read": bool(m.is_read),
        "starred": bool(m.starred),
        "delivery_mode": m.delivery_mode,
        "error_note": m.error_note,
        "actor": m.actor,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "sent_at": m.sent_at.isoformat() if m.sent_at else None,
        "received_at": m.received_at.isoformat() if m.received_at else None,
    }


def ensure_sample_mails_if_demo(db: Session) -> None:
    """Legt im Playground beim ersten Öffnen realistische Beispiel-Mails für Copilot Lab an."""
    from .. import demo

    if db.query(MailMessage.id).first() is not None or not demo.is_demo(db):
        return
    sups = {s.code: s for s in db.query(Supplier).all()}
    elbe = sups.get("ELBE")
    rhein = sups.get("RHEIN")
    now = _now()
    samples = [
        MailMessage(
            direction="inbound",
            folder="inbox",
            status="received",
            from_addr=rhein.email if rhein else "order@rheinptfe.example",
            from_name=rhein.name if rhein else "RheinPTFE Handel KG",
            to_addrs=["einkauf@musterwerk.example"],
            subject="Rückmeldung zu Bestellung BE-26-0005 — Lieferverzögerung PTFE 2 mm",
            body_text=(
                "Guten Tag,\n\n"
                "leider verzögert sich die Charge PTFE weiß 2,0 mm (1500×1500 mm) zu Ihrer Bestellung BE-26-0005 "
                "aufgrund einer Rohstoffprüfung um voraussichtlich 4 Werktage.\n"
                "Neuer Avis-Termin: Freitag dieser Woche. Werkszeugnis EN 10204 3.1 liegt der Sendung bei.\n\n"
                "Mit freundlichen Grüßen\nDisposition RheinPTFE"
            ),
            purchase_order_no="BE-26-0005",
            supplier_id=rhein.id if rhein else None,
            is_read=False,
            starred=True,
            delivery_mode="demo",
            received_at=now,
        ),
        MailMessage(
            direction="inbound",
            folder="inbox",
            status="received",
            from_addr=elbe.email if elbe else "einkauf@elbe-elastomer.example",
            from_name=elbe.name if elbe else "Elbe Elastomer GmbH",
            to_addrs=["einkauf@musterwerk.example"],
            subject="Auftragsbestätigung zu BE-26-0004 & Staffelangebot EPDM 70",
            body_text=(
                "Guten Tag,\n\n"
                "wir bestätigen Ihre Bestellung BE-26-0004 (10 Platten EPDM 70 Shore, 2000×1000×2 mm) "
                "zum vereinbarten Termin.\n"
                "Ab 20 Platten können wir Ihnen im kommenden Monat einen Aktionspreis von 12,80 €/m² anbieten.\n\n"
                "Freundliche Grüße\nElbe Elastomer Vertrieb"
            ),
            purchase_order_no="BE-26-0004",
            supplier_id=elbe.id if elbe else None,
            is_read=False,
            delivery_mode="demo",
            received_at=now,
        ),
        MailMessage(
            direction="inbound",
            folder="inbox",
            status="received",
            from_addr="technik@armaturen-nord.example",
            from_name="Armaturen Nord GmbH",
            to_addrs=["vertrieb@musterwerk.example"],
            subject="Terminanfrage Eilbedarf — vorziehen möglich?",
            body_text=(
                "Hallo Team,\n\n"
                "wir haben morgen Nachmittag einen Anlagenstillstand. Können Sie prüfen, ob unsere laufende "
                "Bestellung vorgezogen und per Express versendet werden kann?\n\n"
                "Danke und viele Grüße\nInstandhaltung Armaturen Nord"
            ),
            is_read=False,
            delivery_mode="demo",
            received_at=now,
        ),
    ]
    for s in samples:
        db.add(s)
    db.commit()


@router.get("/messages", dependencies=[Depends(require_staff)])
def list_mail_messages(
    db: Annotated[Session, Depends(get_db)],
    folder: Literal["inbox", "drafts", "sent", "archive", "all"] = "all",
    unread_only: bool = False,
    q: Optional[str] = None,
    order_no: Optional[str] = None,
    purchase_order_no: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=500),
) -> dict:
    ensure_sample_mails_if_demo(db)
    query = db.query(MailMessage)
    if folder != "all":
        query = query.filter(MailMessage.folder == folder)
    if unread_only:
        query = query.filter(MailMessage.is_read.is_(False))
    if order_no:
        query = query.filter(MailMessage.order_no == order_no)
    if purchase_order_no:
        query = query.filter(MailMessage.purchase_order_no == purchase_order_no)
    rows = query.order_by(MailMessage.id.desc()).limit(limit).all()

    if q and q.strip():
        needle = q.strip().lower()
        rows = [
            r
            for r in rows
            if needle
            in f"{r.subject} {r.from_addr} {r.from_name} {' '.join(r.to_addrs or [])} {r.order_no} {r.purchase_order_no} {r.body_text}".lower()
        ]

    sups = {s.id: s for s in db.query(Supplier).all()}
    counts = dict(
        db.query(MailMessage.folder, func.count(MailMessage.id)).group_by(MailMessage.folder).all()
    )
    unread_inbox = (
        db.query(func.count(MailMessage.id))
        .filter(MailMessage.folder == "inbox", MailMessage.is_read.is_(False))
        .scalar()
        or 0
    )
    return {
        "messages": [_msg_out(r, sups) for r in rows],
        "counts": {
            "inbox": int(counts.get("inbox", 0)),
            "drafts": int(counts.get("drafts", 0)),
            "sent": int(counts.get("sent", 0)),
            "archive": int(counts.get("archive", 0)),
            "unread_inbox": int(unread_inbox),
        },
    }


class DraftCreateIn(BaseModel):
    template: Literal["custom", "po", "rfq", "order_status"] = "custom"
    to_addrs: list[str] = Field(default_factory=list)
    cc_addrs: list[str] = Field(default_factory=list)
    subject: str = Field(default="", max_length=300)
    body_text: str = Field(default="", max_length=20_000)
    order_no: str = Field(default="", max_length=30)
    work_order_no: str = Field(default="", max_length=30)
    purchase_order_no: str = Field(default="", max_length=30)
    product_id: str = Field(default="", max_length=60)
    supplier_id: Optional[int] = None
    qty: int = Field(default=5, ge=1, le=100_000)
    send_immediately: bool = False


@router.post("/drafts", status_code=status.HTTP_201_CREATED)
def create_or_send_draft(
    body: DraftCreateIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Erstellt einen E-Mail-Entwurf (optional aus Vorlage für Bestellung, Preisanfrage/RFQ oder Auftrag) oder sendet direkt."""
    to_list = [t.strip() for t in body.to_addrs if t and t.strip()]
    subj = body.subject.strip()
    txt = body.body_text.strip()
    sup_id = body.supplier_id
    po_no = body.purchase_order_no.strip()
    ord_no = body.order_no.strip()

    if body.template == "po" and po_no:
        po = db.query(PurchaseOrder).filter(PurchaseOrder.no == po_no).first()
        if po is None:
            raise HTTPException(404, f"Bestellung {po_no} nicht gefunden.")
        sup = db.get(Supplier, po.supplier_id)
        if sup:
            sup_id = sup.id
            if not to_list and sup.email:
                to_list = [sup.email]
            prods = {p.id: p for p in db.query(Product).all()}
            lines = [(ln, prods[ln.product_id].name if ln.product_id in prods else ln.product_id) for ln in po.lines]
            gen_subj, gen_txt = scm_analytics.build_po_email_text(po, sup, lines)
            subj = subj or gen_subj
            txt = txt or gen_txt

    elif body.template == "rfq" and body.product_id:
        prod = db.get(Product, body.product_id)
        if prod is None:
            raise HTTPException(404, "Werkstoff nicht gefunden.")
        ranked = scm_analytics.rank_suppliers_for_product(db, prod, qty_needed=body.qty)
        chosen = (
            next((r for r in ranked if r["supplier_id"] == sup_id), None)
            if sup_id
            else (ranked[0] if ranked else None)
        )
        sup_name = "Damen und Herren"
        if chosen:
            sup_id = int(chosen["supplier_id"])
            sup_name = chosen["supplier_name"]
            if not to_list and chosen.get("supplier_email"):
                to_list = [chosen["supplier_email"]]
        fmt = f"{int(prod.sheets[0][0])}×{int(prod.sheets[0][1])} mm" if prod.sheets else "Standardformat"
        thk = prod.thicknesses[0] if prod.thicknesses else 2.0
        subj = subj or f"Preisanfrage (RFQ) — {prod.name} ({body.qty} {getattr(prod, 'sku_unit', 'Platte')})"
        txt = txt or (
            f"Guten Tag {sup_name},\n\n"
            f"bitte senden Sie uns ein aktuelles Angebot inkl. Lieferzeit und Staffelpreis für:\n\n"
            f"  · Werkstoff: {prod.name} ({prod.id})\n"
            f"  · Format / Dicke: {fmt} · {thk:g} mm\n"
            f"  · Menge: {body.qty} {getattr(prod, 'sku_unit', 'Platte')}\n"
            f"  · Zeugnis: EN 10204 3.1 erwünscht\n\n"
            "Vielen Dank für eine kurze Rückmeldung.\n\nFreundliche Grüße\nEinkauf"
        )

    elif body.template == "order_status" and ord_no:
        ord_row = db.query(Order).filter(Order.no == ord_no).first()
        if ord_row is None:
            raise HTTPException(404, f"Auftrag {ord_no} nicht gefunden.")
        if not to_list and ord_row.contact_email:
            to_list = [ord_row.contact_email]
        due = ord_row.due_date.strftime("%d.%m.%Y") if ord_row.due_date else "nach Vereinbarung"
        stage_lbl = "Gefertigt / Versandbereit" if ord_row.stage >= 2 else ("In Fertigung" if ord_row.stage == 1 else "Eingeplant")
        subj = subj or f"Status-Update zu Ihrem Auftrag {ord_row.no}"
        txt = txt or (
            f"Guten Tag,\n\n"
            f"kurzes Update zu Ihrem Auftrag {ord_row.no}"
            + (f" (Ihre Referenz: {ord_row.customer_ref})" if ord_row.customer_ref else "")
            + f":\n\n  · Aktueller Stand: {stage_lbl}\n  · Geplanter Termin: {due}\n\n"
            "Bei Rückfragen antworten Sie gern direkt auf diese Nachricht.\n\nFreundliche Grüße"
        )

    row = MailMessage(
        direction="draft",
        folder="drafts",
        status="draft",
        to_addrs=to_list,
        cc_addrs=[c.strip() for c in body.cc_addrs if c and c.strip()],
        subject=subj or "(Kein Betreff)",
        body_text=txt,
        order_no=ord_no,
        work_order_no=body.work_order_no.strip(),
        purchase_order_no=po_no,
        supplier_id=sup_id,
        is_read=True,
        actor=actor.email,
    )
    db.add(row)
    db.flush()

    if body.send_immediately:
        deliver_mail_message(db, row, actor.email)
    else:
        db.add(AuditLog(actor=actor.email, action="mail_draft_create", entity="mail_message", entity_id=str(row.id), detail={"subject": row.subject[:120]}))
    db.commit()
    db.refresh(row)
    sups = {s.id: s for s in db.query(Supplier).all()}
    return _msg_out(row, sups)


class MailPatchIn(BaseModel):
    to_addrs: Optional[list[str]] = None
    cc_addrs: Optional[list[str]] = None
    subject: Optional[str] = Field(default=None, max_length=300)
    body_text: Optional[str] = Field(default=None, max_length=20_000)
    ai_summary: Optional[str] = Field(default=None, max_length=4_000)
    folder: Optional[Literal["inbox", "drafts", "sent", "archive"]] = None
    is_read: Optional[bool] = None
    starred: Optional[bool] = None
    order_no: Optional[str] = Field(default=None, max_length=30)
    purchase_order_no: Optional[str] = Field(default=None, max_length=30)


@router.patch("/messages/{msg_id}")
def update_mail_message(
    msg_id: int,
    body: MailPatchIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    row = db.get(MailMessage, msg_id)
    if row is None:
        raise HTTPException(404, "Nachricht nicht gefunden.")
    patch = body.model_dump(exclude_unset=True)
    for k, v in patch.items():
        if isinstance(v, str):
            v = v.strip()
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    sups = {s.id: s for s in db.query(Supplier).all()}
    return _msg_out(row, sups)


@router.post("/messages/{msg_id}/send")
def send_existing_draft(
    msg_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    row = db.get(MailMessage, msg_id)
    if row is None:
        raise HTTPException(404, "Entwurf nicht gefunden.")
    ok, mode = deliver_mail_message(db, row, actor.email)
    db.commit()
    db.refresh(row)
    sups = {s.id: s for s in db.query(Supplier).all()}
    return {"ok": ok, "mode": mode, "message": _msg_out(row, sups)}


@router.get("/config", dependencies=[Depends(require_staff)])
def get_mail_config(db: Annotated[Session, Depends(get_db)]) -> dict:
    cfg = resolve_mail_config(db)
    return {
        "smtp_host": cfg["smtp_host"],
        "smtp_port": cfg["smtp_port"],
        "smtp_secure": cfg["smtp_secure"],
        "smtp_user": cfg["smtp_user"],
        "smtp_has_password": bool(cfg["smtp_pass"]),
        "smtp_from": cfg["smtp_from"],
        "smtp_from_name": cfg["smtp_from_name"],
        "silent": cfg["silent"],
        "smtp_configured": cfg["smtp_configured"],
        "imap_host": cfg["imap_host"],
        "imap_port": cfg["imap_port"],
        "imap_user": cfg["imap_user"],
        "imap_has_password": bool(cfg["imap_pass"]),
        "imap_folder": cfg["imap_folder"],
        "imap_configured": cfg["imap_configured"],
    }


class MailConfigIn(BaseModel):
    smtp_host: str = ""
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_secure: Literal["starttls", "tls"] = "starttls"
    smtp_user: str = ""
    smtp_pass: Optional[str] = None
    smtp_from: str = ""
    smtp_from_name: str = ""
    silent: bool = True
    imap_host: str = ""
    imap_port: int = Field(default=993, ge=1, le=65535)
    imap_user: str = ""
    imap_pass: Optional[str] = None
    imap_folder: str = "INBOX"


@router.put("/config")
def save_mail_config(
    body: MailConfigIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_admin)],
) -> dict:
    _set_fset(db, "smtp_host", body.smtp_host.strip(), actor.email)
    _set_fset(db, "smtp_port", str(body.smtp_port), actor.email)
    _set_fset(db, "smtp_secure", body.smtp_secure, actor.email)
    _set_fset(db, "smtp_user", body.smtp_user.strip(), actor.email)
    _set_fset(db, "smtp_from", body.smtp_from.strip(), actor.email)
    _set_fset(db, "smtp_from_name", body.smtp_from_name.strip(), actor.email)
    _set_fset(db, "silent", "1" if body.silent else "0", actor.email)
    if body.smtp_pass is not None:
        _set_fset(db, "smtp_pass_enc", secretbox.seal(body.smtp_pass) if body.smtp_pass else "", actor.email)

    _set_fset(db, "imap_host", body.imap_host.strip(), actor.email)
    _set_fset(db, "imap_port", str(body.imap_port), actor.email)
    _set_fset(db, "imap_user", body.imap_user.strip(), actor.email)
    _set_fset(db, "imap_folder", body.imap_folder.strip() or "INBOX", actor.email)
    if body.imap_pass is not None:
        _set_fset(db, "imap_pass_enc", secretbox.seal(body.imap_pass) if body.imap_pass else "", actor.email)

    db.add(AuditLog(actor=actor.email, action="mail_config_update", entity="mail_config", entity_id="default", detail={"smtp_host": body.smtp_host, "imap_host": body.imap_host, "silent": body.silent}))
    db.commit()
    return get_mail_config(db)


def _decode_mime(val: str | None) -> str:
    if not val:
        return ""
    parts = []
    for chunk, enc in decode_header(val):
        if isinstance(chunk, bytes):
            parts.append(chunk.decode(enc or "utf-8", errors="replace"))
        else:
            parts.append(str(chunk))
    return "".join(parts).strip()


@router.post("/sync-imap")
def sync_imap_inbox(
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_staff)],
) -> dict:
    """Ruft die neuesten E-Mails sicher über IMAP4-SSL ab und verknüpft Auftrags-/Bestellnummern."""
    cfg = resolve_mail_config(db)
    if not cfg["imap_configured"]:
        raise HTTPException(422, "Kein IMAP-Postfach konfiguriert (Host, Benutzer und Passwort erforderlich).")

    imported = 0
    ctx = ssl.create_default_context()
    try:
        with imaplib.IMAP4_SSL(cfg["imap_host"], int(cfg["imap_port"]), ssl_context=ctx) as client:
            client.login(cfg["imap_user"], cfg["imap_pass"])
            client.select(cfg["imap_folder"], readonly=True)
            typ, data = client.uid("search", None, "ALL")
            if typ != "OK" or not data or not data[0]:
                return {"imported": 0}
            uids = data[0].split()[-25:]
            sups_by_mail = {s.email.lower(): s.id for s in db.query(Supplier).all() if s.email}
            for uid_b in uids:
                uid_str = f"{cfg['imap_host']}:{cfg['imap_folder']}:{uid_b.decode('ascii', errors='ignore')}"
                if db.query(MailMessage.id).filter(MailMessage.external_uid == uid_str).first():
                    continue
                ftyp, fdata = client.uid("fetch", uid_b, "(RFC822)")
                if ftyp != "OK" or not fdata or not isinstance(fdata[0], tuple):
                    continue
                raw_bytes = fdata[0][1][:262_144]
                parsed = pyemail.message_from_bytes(raw_bytes)
                subj = _decode_mime(parsed.get("Subject"))[:300]
                disp_name, addr = parseaddr(_decode_mime(parsed.get("From")))
                to_disp, to_addr = parseaddr(_decode_mime(parsed.get("To")))

                body_txt = ""
                if parsed.is_multipart():
                    for part in parsed.walk():
                        if part.get_content_type() == "text/plain" and not part.get_filename():
                            payload = part.get_payload(decode=True) or b""
                            body_txt = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
                            break
                else:
                    payload = parsed.get_payload(decode=True) or b""
                    body_txt = payload.decode(parsed.get_content_charset() or "utf-8", errors="replace")

                hay = f"{subj}\n{body_txt}"
                m_ord = ORDER_REF_RE.search(hay)
                m_po = PO_REF_RE.search(hay)
                m_wo = WO_REF_RE.search(hay)

                db.add(
                    MailMessage(
                        direction="inbound",
                        folder="inbox",
                        status="received",
                        from_addr=addr[:254],
                        from_name=disp_name[:160],
                        to_addrs=[to_addr] if to_addr else [],
                        subject=subj or "(Kein Betreff)",
                        body_text=body_txt[:20_000],
                        external_uid=uid_str,
                        message_id_header=(parsed.get("Message-ID") or "")[:240],
                        in_reply_to=(parsed.get("In-Reply-To") or "")[:240],
                        order_no=m_ord.group(1).upper() if m_ord else "",
                        purchase_order_no=m_po.group(1).upper() if m_po else "",
                        work_order_no=m_wo.group(1).upper() if m_wo else "",
                        supplier_id=sups_by_mail.get(addr.lower()),
                        is_read=False,
                        delivery_mode="imap",
                        received_at=_now(),
                    )
                )
                imported += 1
        if imported:
            db.add(AuditLog(actor=actor.email, action="mail_imap_sync", entity="mail_config", entity_id="imap", detail={"imported": imported}))
            db.commit()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"IMAP-Abruf fehlgeschlagen: {type(exc).__name__}: {exc}") from exc

    return {"imported": imported}
