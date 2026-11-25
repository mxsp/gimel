"""Interne Kollegen-Notizen & Schichtübergaben (ERP-Portal, Digitale Laufkarte & Copilot Lab).

Unterstützt Direktnachrichten an Kollegen, Kanal-Notizen (alle, buero, halle, schicht),
@Erwähnungen, Objekt-Verknüpfungen (Auftrag, Innenauftrag, Werkstoff, Bestellung, Station, Kalender)
sowie Lesebestätigungen und Quittierung (ack_required).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditLog, Role, TeamNote, User
from ..security import require_worker
from ..services import floor_view

router = APIRouter(prefix="/api/notes", tags=["notes"])

MENTION_RE = re.compile(r"@([a-zA-Z0-9._\-]+)")
INTERNAL_ROLES = (Role.admin, Role.staff, Role.worker)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _visible_to_user(note: TeamNote, user: User) -> bool:
    if note.sender_id == user.id or note.recipient_id == user.id:
        return True
    if note.recipient_email and note.recipient_email.lower() == user.email.lower():
        return True
    if user.email.lower() in [str(m).lower() for m in (note.mentions or [])]:
        return True
    if note.recipient_id is not None and note.channel == "direkt":
        return False
    if note.channel == "alle":
        return True
    if user.role == Role.worker:
        return note.channel in ("halle", "schicht")
    return note.channel in ("buero", "halle", "schicht")


def _is_unread(note: TeamNote, user: User) -> bool:
    if note.sender_id == user.id:
        return False
    read_map = note.read_by or {}
    return str(user.id) not in read_map


def _note_out(n: TeamNote, viewer: User) -> dict:
    return {
        "id": n.id,
        "sender_id": n.sender_id,
        "sender_email": n.sender_email,
        "sender_name": n.sender_name or n.sender_email,
        "recipient_id": n.recipient_id,
        "recipient_email": n.recipient_email,
        "recipient_name": n.recipient_name,
        "channel": n.channel,
        "priority": n.priority,
        "subject": n.subject,
        "body": n.body or "",
        "mentions": n.mentions or [],
        "entity_type": n.entity_type,
        "entity_id": n.entity_id,
        "parent_id": n.parent_id,
        "pinned": bool(n.pinned),
        "archived": bool(n.archived),
        "ack_required": bool(n.ack_required),
        "acknowledged_by": n.acknowledged_by,
        "acknowledged_at": n.acknowledged_at.isoformat() if n.acknowledged_at else None,
        "unread": _is_unread(n, viewer),
        "read_count": len(n.read_by or {}),
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


def ensure_sample_notes_if_demo(db: Session) -> None:
    """Legt im Playground Start-Notizen zwischen Büro & Werkstatt an."""
    from .. import demo
    from ..models import WorkOrder

    if db.query(TeamNote.id).first() is not None or not demo.is_demo(db):
        return
    users = db.query(User).filter(User.role.in_(INTERNAL_ROLES), User.active.is_(True)).all()
    if not users:
        return
    admin_u = next((u for u in users if u.role == Role.admin), users[0])
    worker_u = next((u for u in users if u.role == Role.worker), None)
    first_wo = db.query(WorkOrder).first()
    wo_no = first_wo.no if first_wo else ""

    db.add(
        TeamNote(
            sender_id=admin_u.id,
            sender_email=admin_u.email,
            sender_name=admin_u.name or "Leitstand",
            recipient_id=worker_u.id if worker_u else None,
            recipient_email=worker_u.email if worker_u else "",
            recipient_name=(worker_u.name or worker_u.email) if worker_u else "",
            channel="schicht",
            priority="important",
            subject="Schichtübergabe Zuschnitt & Reststücke",
            body=(
                "Bitte bei EPDM 70 Shore zuerst die verfügbaren Reststücke R-0001 / Charge CH-26-0001 "
                "prüfen, bevor eine neue Vollplatte angerissen wird. Eilaufträge heute bevorzugt abarbeiten!"
            ),
            entity_type="work_order" if wo_no else "",
            entity_id=wo_no,
            pinned=True,
            ack_required=True,
            read_by={str(admin_u.id): _now().isoformat()},
        )
    )
    db.commit()


@router.get("/coworkers")
def list_coworkers(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[User, Depends(require_worker)],
) -> list[dict]:
    """Listet alle aktiven internen Mitarbeiter (Admin, Personal, Werker — nie externe Kunden)."""
    rows = (
        db.query(User)
        .filter(User.active.is_(True), User.role.in_(INTERNAL_ROLES))
        .order_by(User.role, User.name, User.email)
        .all()
    )
    return [
        {
            "id": u.id,
            "email": u.email,
            "name": u.name or u.email.split("@")[0],
            "role": u.role.value,
            "handle": (u.name or u.email.split("@")[0]).strip().lower().replace(" ", "."),
        }
        for u in rows
    ]


@router.get("")
def list_notes(
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
    box: Literal["inbox", "sent", "pinned", "all"] = "all",
    channel: Optional[str] = None,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    unread_only: bool = False,
    include_archived: bool = False,
    limit: int = Query(default=100, ge=1, le=300),
) -> dict:
    ensure_sample_notes_if_demo(db)
    q = db.query(TeamNote)
    if not include_archived:
        q = q.filter(TeamNote.archived.is_(False))
    if channel:
        q = q.filter(TeamNote.channel == channel)
    if entity_type:
        q = q.filter(TeamNote.entity_type == entity_type)
    if entity_id:
        q = q.filter(TeamNote.entity_id == entity_id)

    raw_rows = q.order_by(TeamNote.pinned.desc(), TeamNote.id.desc()).limit(400).all()
    visible = [n for n in raw_rows if _visible_to_user(n, actor)]
    unread_total = sum(1 for n in visible if _is_unread(n, actor))

    filtered: list[TeamNote] = []
    for n in visible:
        if box == "sent" and n.sender_id != actor.id:
            continue
        if box == "inbox" and n.sender_id == actor.id and n.recipient_id != actor.id:
            continue
        if box == "pinned" and not n.pinned:
            continue
        if unread_only and not _is_unread(n, actor):
            continue
        filtered.append(n)

    office = floor_view.is_office(actor)
    out = []
    for n in filtered[:limit]:
        d = _note_out(n, actor)
        if not office and d["entity_type"] == "purchase_order":
            d["entity_type"] = ""
            d["entity_id"] = ""
        out.append(d)

    return {"notes": out, "unread_count": unread_total}


class NoteCreateIn(BaseModel):
    recipient_id: Optional[int] = None
    recipient_email: str = Field(default="", max_length=254)
    channel: Literal["alle", "buero", "halle", "schicht", "direkt"] = "alle"
    priority: Literal["normal", "important", "urgent"] = "normal"
    subject: str = Field(default="", max_length=200)
    body: str = Field(min_length=1, max_length=8000)
    entity_type: str = Field(default="", max_length=30)
    entity_id: str = Field(default="", max_length=80)
    parent_id: Optional[int] = None
    pinned: bool = False
    ack_required: bool = False


@router.post("", status_code=status.HTTP_201_CREATED)
def create_note(
    body: NoteCreateIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    rec_user: User | None = None
    if body.recipient_id is not None:
        rec_user = db.get(User, body.recipient_id)
    elif body.recipient_email.strip():
        rec_user = (
            db.query(User)
            .filter(User.email == body.recipient_email.strip().lower(), User.role.in_(INTERNAL_ROLES))
            .first()
        )
    if (body.recipient_id is not None or body.recipient_email.strip()) and (
        rec_user is None or rec_user.role not in INTERNAL_ROLES
    ):
        raise HTTPException(404, "Empfänger (Kollege) nicht gefunden.")

    # @Erwähnungen auflösen
    coworkers = db.query(User).filter(User.active.is_(True), User.role.in_(INTERNAL_ROLES)).all()
    mentions: list[str] = []
    for tok in {m.lower() for m in MENTION_RE.findall(body.body)}:
        for cw in coworkers:
            local = cw.email.split("@")[0].lower()
            nm = (cw.name or "").strip().lower().replace(" ", ".")
            if tok in (cw.email.lower(), local, nm, (cw.name or "").strip().lower()):
                if cw.email not in mentions:
                    mentions.append(cw.email)

    chan = "direkt" if (rec_user and body.channel == "direkt") else body.channel
    if rec_user and body.channel == "alle":
        chan = "direkt"

    now = _now()
    note = TeamNote(
        sender_id=actor.id,
        sender_email=actor.email,
        sender_name=actor.name or actor.email.split("@")[0],
        recipient_id=rec_user.id if rec_user else None,
        recipient_email=rec_user.email if rec_user else "",
        recipient_name=(rec_user.name or rec_user.email) if rec_user else "",
        channel=chan,
        priority=body.priority,
        subject=body.subject.strip(),
        body=body.body.strip(),
        mentions=mentions,
        entity_type=body.entity_type.strip(),
        entity_id=body.entity_id.strip(),
        parent_id=body.parent_id,
        pinned=body.pinned,
        ack_required=body.ack_required,
        read_by={str(actor.id): now.isoformat()},
    )
    db.add(note)
    db.flush()
    db.add(
        AuditLog(
            actor=actor.email,
            action="team_note_send",
            entity="team_note",
            entity_id=str(note.id),
            detail={
                "to": note.recipient_email or f"#{note.channel}",
                "priority": note.priority,
                "entity": f"{note.entity_type}:{note.entity_id}" if note.entity_id else "",
            },
        )
    )
    db.commit()
    db.refresh(note)
    return _note_out(note, actor)


@router.post("/{note_id}/read")
def mark_note_read(
    note_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    note = db.get(TeamNote, note_id)
    if note is None or not _visible_to_user(note, actor):
        raise HTTPException(404, "Notiz nicht gefunden.")
    rmap = dict(note.read_by or {})
    rmap[str(actor.id)] = _now().isoformat()
    note.read_by = rmap
    db.commit()
    return _note_out(note, actor)


@router.post("/{note_id}/ack")
def acknowledge_note(
    note_id: int,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    note = db.get(TeamNote, note_id)
    if note is None or not _visible_to_user(note, actor):
        raise HTTPException(404, "Notiz nicht gefunden.")
    now = _now()
    rmap = dict(note.read_by or {})
    rmap[str(actor.id)] = now.isoformat()
    note.read_by = rmap
    note.acknowledged_by = actor.name or actor.email
    note.acknowledged_at = now
    db.add(AuditLog(actor=actor.email, action="team_note_ack", entity="team_note", entity_id=str(note.id)))
    db.commit()
    db.refresh(note)
    return _note_out(note, actor)


class NotePatchIn(BaseModel):
    pinned: Optional[bool] = None
    archived: Optional[bool] = None


@router.patch("/{note_id}")
def update_note(
    note_id: int,
    body: NotePatchIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_worker)],
) -> dict:
    note = db.get(TeamNote, note_id)
    if note is None or not _visible_to_user(note, actor):
        raise HTTPException(404, "Notiz nicht gefunden.")
    if body.pinned is not None:
        note.pinned = body.pinned
    if body.archived is not None:
        note.archived = body.archived
    db.commit()
    db.refresh(note)
    return _note_out(note, actor)
