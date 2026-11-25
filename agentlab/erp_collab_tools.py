"""Werkzeuge für Lieferkette (Auto-Lieferant & Smart-Lager), E-Mail-Zentrale,
Kollegen-Notizen und Betriebskalender in Copilot Lab & angedocktem Assistenten."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from gimel.models import (
    AuditLog,
    CalendarEvent,
    MailMessage,
    Product,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    Role,
    Supplier,
    TeamNote,
    User,
)
from gimel.routers import calendar_api, mail as mail_router, notes as notes_router
from gimel.services import scm_analytics
from gimel.services.numbering import next_number

from .models import AgentActionProposal
from .rollback import record
from .tools import ALL, OFFICE, ToolContext, ToolError, ToolSpec, _limit, _need, _schema


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------
# 1. Supply Chain & Smart-Lager
# --------------------------------------------------------------------------
def get_smart_stock(ctx: ToolContext, args: dict) -> dict:
    """Liest MRP, Reichweite, ABC-Klassen und empfohlene Auto-Lieferanten."""
    data = scm_analytics.compute_smart_inventory(ctx.db, include_inactive=bool(args.get("include_inactive")))
    health_filter = (args.get("health") or "").strip()
    items = data["items"]
    if health_filter:
        items = [i for i in items if i["health"] == health_filter]
    return {"summary": data["summary"], "items": items[: _limit(args.get("limit"), 40, 100)]}


def rank_material_suppliers(ctx: ToolContext, args: dict) -> dict:
    """Bewertet alle aktiven Lieferanten eines Werkstoffs nach Preis, Lieferzeit, Treue und MOQ."""
    pid = str(_need(args, "product_id")).strip()
    prod = ctx.db.get(Product, pid)
    if prod is None:
        raise ToolError(f"Werkstoff „{pid}“ nicht gefunden.")
    qty = max(1, int(args.get("qty") or 2))
    thk = float(args.get("thk") or 0.0)
    urgent = bool(args.get("urgent"))
    ranked = scm_analytics.rank_suppliers_for_product(ctx.db, prod, thk=thk, qty_needed=qty, urgent=urgent)
    return {
        "product_id": prod.id,
        "product_name": prod.name,
        "recommended": ranked[0] if ranked else None,
        "candidates": ranked,
    }


def create_supplier_purchase_order(ctx: ToolContext, args: dict) -> dict:
    """Legt eine Bestellung beim besten (oder gewählten) Lieferanten samt E-Mail-Entwurf an."""
    pid = str(_need(args, "product_id")).strip()
    prod = ctx.db.get(Product, pid)
    if prod is None:
        raise ToolError(f"Werkstoff „{pid}“ nicht gefunden.")
    qty_in = max(1, int(args.get("qty") or 2))
    thk = float(args.get("thk") or (prod.thicknesses[0] if prod.thicknesses else 2.0))
    urgent = bool(args.get("urgent"))
    ranked = scm_analytics.rank_suppliers_for_product(ctx.db, prod, thk=thk, qty_needed=qty_in, urgent=urgent)
    if not ranked:
        raise ToolError(f"Für „{prod.name}“ ist kein aktiver Lieferant hinterlegt.")

    sup_id = args.get("supplier_id")
    chosen = next((r for r in ranked if r["supplier_id"] == int(sup_id)), None) if sup_id else ranked[0]
    if chosen is None:
        raise ToolError("Gewählter Lieferant führt diesen Werkstoff nicht aktiv.")

    sup = ctx.db.get(Supplier, int(chosen["supplier_id"]))
    if sup is None:
        raise ToolError("Lieferant nicht gefunden.")

    qty = max(qty_in, int(chosen["moq_sheets"] or 1))
    uprice = float(chosen["plate_eur"])
    now = _now()
    eta = now + timedelta(days=int(chosen["lead_days"]))
    mode = str(args.get("status") or "proposed")
    po_status = PurchaseOrderStatus.ordered if mode == "ordered" else PurchaseOrderStatus.proposed

    po = PurchaseOrder(
        no=next_number(ctx.db, "purchase_order", "BE-"),
        supplier_id=sup.id,
        status=po_status,
        currency=sup.currency or "EUR",
        order_date=now,
        requested_eta=eta,
        total_net=round(qty * uprice, 2),
        note=str(args.get("note") or f"Auto-Lieferant via Copilot: {chosen['reason']}")[:280],
        created_by=ctx.user.email,
    )
    ctx.db.add(po)
    ctx.db.flush()
    ln = PurchaseOrderLine(
        purchase_order_id=po.id,
        product_id=prod.id,
        thk=thk,
        sheet_w=float(chosen["sheet_w"]),
        sheet_h=float(chosen["sheet_h"]),
        qty_ordered=qty,
        qty_received=0,
        unit_price_eur=uprice,
        requested_eta=eta,
        note=chosen["reason"][:280],
    )
    ctx.db.add(ln)
    ctx.db.flush()

    mail_id = None
    if sup.email:
        subj, txt = scm_analytics.build_po_email_text(po, sup, [(ln, prod.name)])
        m = MailMessage(
            direction="draft",
            folder="drafts",
            status="draft",
            to_addrs=[sup.email],
            subject=subj,
            body_text=txt,
            ai_drafted=True,
            purchase_order_no=po.no,
            supplier_id=sup.id,
            thread_key=f"po:{po.no}",
            actor=ctx.user.email,
        )
        ctx.db.add(m)
        ctx.db.flush()
        mail_id = m.id

    ctx.db.add(
        AuditLog(
            actor=ctx.user.email,
            action="agent_po_create",
            entity="purchase_order",
            entity_id=po.no,
            detail={"product_id": prod.id, "supplier": sup.code, "qty": qty, "status": po_status.value},
        )
    )
    change = record(
        ctx.db,
        chat_id=ctx.chat.id if ctx.chat else None,
        message_id=ctx.message_id,
        user=ctx.user,
        tool="create_supplier_purchase_order",
        action="create",
        entity="purchase_order",
        entity_id=str(po.id),
        before=None,
        after={"id": po.id, "no": po.no, "status": po.status.value},
        summary=f"Bestellung {po.no} ({qty} Pl. {prod.name} bei {sup.name}) angelegt.",
    )
    return {
        "po_no": po.no,
        "status": po.status.value,
        "supplier": sup.name,
        "qty": qty,
        "total_net_eur": po.total_net,
        "eta_date": eta.date().isoformat(),
        "mail_draft_id": mail_id,
        "change": change,
    }


def run_smart_replenishment(ctx: ToolContext, args: dict) -> dict:
    """Prüft alle unterdeckten Werkstoffe und legt Bestellvorschläge an."""
    dry_run = bool(args.get("dry_run", True))
    res = scm_analytics.run_auto_replenishment(ctx.db, actor=ctx.user.email, dry_run=dry_run)
    return res


# --------------------------------------------------------------------------
# 2. E-Mail-Zentrale für Copilot Lab
# --------------------------------------------------------------------------
def list_emails(ctx: ToolContext, args: dict) -> dict:
    """Durchsucht Posteingang, Entwürfe und gesendete E-Mails."""
    mail_router.ensure_sample_mails_if_demo(ctx.db)
    folder = str(args.get("folder") or "all")
    q = ctx.db.query(MailMessage)
    if folder in ("inbox", "drafts", "sent", "archive"):
        q = q.filter(MailMessage.folder == folder)
    if args.get("unread_only"):
        q = q.filter(MailMessage.is_read.is_(False))
    if args.get("order_no"):
        q = q.filter(MailMessage.order_no == str(args["order_no"]).strip())
    if args.get("purchase_order_no"):
        q = q.filter(MailMessage.purchase_order_no == str(args["purchase_order_no"]).strip())
    rows = q.order_by(MailMessage.id.desc()).limit(_limit(args.get("limit"), 25, 80)).all()
    search = str(args.get("query") or "").strip().lower()
    if search:
        rows = [
            r
            for r in rows
            if search in f"{r.subject} {r.from_addr} {r.from_name} {' '.join(r.to_addrs or [])} {r.body_text}".lower()
        ]
    return {
        "count": len(rows),
        "emails": [
            {
                "id": r.id,
                "folder": r.folder,
                "status": r.status,
                "from": f"{r.from_name} <{r.from_addr}>".strip(" <>") if (r.from_name or r.from_addr) else "",
                "to": r.to_addrs or [],
                "subject": r.subject,
                "snippet": (r.body_text or "")[:240],
                "order_no": r.order_no,
                "purchase_order_no": r.purchase_order_no,
                "is_read": bool(r.is_read),
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


def read_email(ctx: ToolContext, args: dict) -> dict:
    """Liest den vollständigen Inhalt einer E-Mail."""
    mid = int(_need(args, "email_id"))
    row = ctx.db.get(MailMessage, mid)
    if row is None:
        raise ToolError(f"E-Mail #{mid} nicht gefunden.")
    sups = {s.id: s for s in ctx.db.query(Supplier).all()}
    return mail_router._msg_out(row, sups)


def draft_email(ctx: ToolContext, args: dict) -> dict:
    """Erstellt einen E-Mail-Entwurf im Postfach und schlägt auf Wunsch den Versand zur Freigabe vor."""
    to_raw = args.get("to") or []
    to_list = [str(x).strip() for x in (to_raw if isinstance(to_raw, list) else [to_raw]) if str(x).strip()]
    subject = str(_need(args, "subject")).strip()[:300]
    body_text = str(_need(args, "body")).strip()[:20_000]
    order_no = str(args.get("order_no") or "").strip()[:30]
    po_no = str(args.get("purchase_order_no") or "").strip()[:30]

    row = MailMessage(
        direction="draft",
        folder="drafts",
        status="draft",
        to_addrs=to_list,
        subject=subject,
        body_text=body_text,
        ai_drafted=True,
        order_no=order_no,
        purchase_order_no=po_no,
        is_read=True,
        actor=ctx.user.email,
    )
    ctx.db.add(row)
    ctx.db.flush()

    proposal_id = None
    if bool(args.get("propose_send", True)) and to_list:
        prop = AgentActionProposal(
            chat_id=ctx.chat.id if ctx.chat else None,
            message_id=ctx.message_id,
            created_by_user_id=ctx.user.id,
            kind="email_send",
            title=f"E-Mail senden an {', '.join(to_list)}: {subject[:80]}",
            rationale=str(args.get("rationale") or "Vom Assistenten entworfene E-Mail — bitte vor dem Versand prüfen."),
            tool_name="send_email",
            arguments={"email_id": row.id},
            impact_summary={"to": to_list, "subject": subject, "draft_id": row.id},
            status="pending",
        )
        ctx.db.add(prop)
        ctx.db.flush()
        proposal_id = prop.id
        row.proposal_id = prop.id

    ctx.db.add(
        AuditLog(
            actor=ctx.user.email,
            action="agent_mail_draft",
            entity="mail_message",
            entity_id=str(row.id),
            detail={"to": to_list, "subject": subject[:120], "proposal_id": proposal_id},
        )
    )
    return {
        "draft_id": row.id,
        "to": to_list,
        "subject": subject,
        "proposal_id": proposal_id,
        "note": (
            f"Entwurf #{row.id} im Postfach gespeichert und als Freigabe-Vorschlag #{proposal_id} hinterlegt."
            if proposal_id
            else f"Entwurf #{row.id} unter Entwürfe gespeichert."
        ),
    }


def send_email(ctx: ToolContext, args: dict) -> dict:
    """Versendet einen bestehenden E-Mail-Entwurf oder eine neue Nachricht."""
    mid = args.get("email_id")
    if mid is not None:
        row = ctx.db.get(MailMessage, int(mid))
        if row is None:
            raise ToolError(f"E-Mail-Entwurf #{mid} nicht gefunden.")
    else:
        to_raw = _need(args, "to")
        to_list = [str(x).strip() for x in (to_raw if isinstance(to_raw, list) else [to_raw]) if str(x).strip()]
        row = MailMessage(
            direction="outbound",
            folder="drafts",
            status="draft",
            to_addrs=to_list,
            subject=str(_need(args, "subject")).strip()[:300],
            body_text=str(_need(args, "body")).strip()[:20_000],
            ai_drafted=True,
            order_no=str(args.get("order_no") or "").strip()[:30],
            purchase_order_no=str(args.get("purchase_order_no") or "").strip()[:30],
            actor=ctx.user.email,
        )
        ctx.db.add(row)
        ctx.db.flush()

    ok, mode = mail_router.deliver_mail_message(ctx.db, row, ctx.user.email)
    change = record(
        ctx.db,
        chat_id=ctx.chat.id if ctx.chat else None,
        message_id=ctx.message_id,
        user=ctx.user,
        tool="send_email",
        action="send",
        entity="mail_message",
        entity_id=str(row.id),
        before=None,
        after={"id": row.id, "status": row.status, "mode": mode},
        reversible=False,
        summary=f"E-Mail „{row.subject[:80]}“ an {', '.join(row.to_addrs or [])} gesendet ({mode}).",
    )
    return {"ok": ok, "delivery_mode": mode, "email_id": row.id, "status": row.status, "change": change}


# --------------------------------------------------------------------------
# 3. Kollegen-Notizen & Schichtübergabe (Coworker Notes)
# --------------------------------------------------------------------------
def list_coworkers(ctx: ToolContext, _args: dict) -> dict:
    """Listet alle internen Kollegen (Büro, Leitstand, Werkstatt) für Notizen & @Erwähnungen."""
    rows = notes_router.list_coworkers(ctx.db, ctx.user)
    return {"count": len(rows), "coworkers": rows}


def list_coworker_notes(ctx: ToolContext, args: dict) -> dict:
    """Liest interne Kollegen-Notizen und Schichtübergaben."""
    res = notes_router.list_notes(
        ctx.db,
        ctx.user,
        box=str(args.get("box") or "all"),  # type: ignore[arg-type]
        channel=args.get("channel"),
        entity_type=args.get("entity_type"),
        entity_id=args.get("entity_id"),
        unread_only=bool(args.get("unread_only", False)),
        limit=_limit(args.get("limit"), 25, 100),
    )
    return res


def send_coworker_note(ctx: ToolContext, args: dict) -> dict:
    """Sendet eine Notiz an einen Kollegen oder einen Team-Kanal (alle, buero, halle, schicht)."""
    body_text = str(_need(args, "body")).strip()
    subject = str(args.get("subject") or "").strip()[:200]
    channel = str(args.get("channel") or "alle").strip()
    if channel not in ("alle", "buero", "halle", "schicht", "direkt"):
        channel = "alle"
    priority = str(args.get("priority") or "normal").strip()
    if priority not in ("normal", "important", "urgent"):
        priority = "normal"

    rec_email = str(args.get("recipient_email") or "").strip().lower()
    rec_id = args.get("recipient_id")
    rec_user: User | None = None
    if rec_id is not None:
        rec_user = ctx.db.get(User, int(rec_id))
    elif rec_email:
        rec_user = (
            ctx.db.query(User)
            .filter(User.email == rec_email, User.role.in_((Role.admin, Role.staff, Role.worker)))
            .first()
        )
        if rec_user is None:
            # Suche auch über den Namen / Handle
            for u in ctx.db.query(User).filter(User.active.is_(True), User.role.in_((Role.admin, Role.staff, Role.worker))).all():
                if rec_email in ((u.name or "").strip().lower(), u.email.split("@")[0].lower()):
                    rec_user = u
                    break
        if rec_user is None:
            raise ToolError(f"Kollege „{rec_email}“ wurde nicht gefunden.")

    if rec_user is not None and channel == "alle":
        channel = "direkt"

    now = _now()
    note = TeamNote(
        sender_id=ctx.user.id,
        sender_email=ctx.user.email,
        sender_name=ctx.user.name or ctx.user.email.split("@")[0],
        recipient_id=rec_user.id if rec_user else None,
        recipient_email=rec_user.email if rec_user else "",
        recipient_name=(rec_user.name or rec_user.email) if rec_user else "",
        channel=channel,
        priority=priority,
        subject=subject,
        body=body_text,
        entity_type=str(args.get("entity_type") or "").strip()[:30],
        entity_id=str(args.get("entity_id") or "").strip()[:80],
        pinned=bool(args.get("pinned", False)),
        ack_required=bool(args.get("ack_required", False)),
        read_by={str(ctx.user.id): now.isoformat()},
    )
    ctx.db.add(note)
    ctx.db.flush()

    ctx.db.add(
        AuditLog(
            actor=ctx.user.email,
            action="agent_team_note_send",
            entity="team_note",
            entity_id=str(note.id),
            detail={"to": note.recipient_email or f"#{note.channel}", "subject": subject},
        )
    )
    change = record(
        ctx.db,
        chat_id=ctx.chat.id if ctx.chat else None,
        message_id=ctx.message_id,
        user=ctx.user,
        tool="send_coworker_note",
        action="create",
        entity="team_note",
        entity_id=str(note.id),
        before=None,
        after={"id": note.id, "subject": note.subject, "body": note.body},
        summary=f"Kollegen-Notiz #{note.id} an {note.recipient_name or ('#' + note.channel)} gesendet.",
    )
    return {"note_id": note.id, "to": note.recipient_name or f"#{note.channel}", "priority": priority, "change": change}


# --------------------------------------------------------------------------
# 4. Betriebskalender
# --------------------------------------------------------------------------
def get_calendar_schedule(ctx: ToolContext, _args: dict) -> dict:
    """Liest die Kalender- und Kapazitätsübersicht (Aufträge, Lieferungen, Innenaufträge, Termine)."""
    data = calendar_api.calendar_overview(ctx.db, ctx.user)
    return {
        "daily_capacity_min": data["daily_capacity_min"],
        "orders_count": len(data["orders"]),
        "upcoming_orders": [o for o in data["orders"] if o.get("due_date") and not o.get("cancelled_at")][:30],
        "inbound_purchase_orders": data["purchase_orders"][:25],
        "events": data["events"][:30],
    }


def create_calendar_event_tool(ctx: ToolContext, args: dict) -> dict:
    """Trägt einen neuen Termin (Wartung, Lieferfenster, Meilenstein, Schicht) in den Kalender ein."""
    title = str(_need(args, "title")).strip()[:200]
    start_date = str(_need(args, "start_date")).strip()[:10]
    kind = str(args.get("kind") or "termin").strip()
    if kind not in ("termin", "wartung", "lieferung", "meilenstein", "schicht"):
        kind = "termin"
    ev = CalendarEvent(
        title=title,
        kind=kind,
        start_date=start_date,
        end_date=str(args.get("end_date") or start_date).strip()[:10],
        start_time=str(args.get("start_time") or "").strip()[:8],
        end_time=str(args.get("end_time") or "").strip()[:8],
        station_id=int(args["station_id"]) if args.get("station_id") is not None else None,
        order_no=str(args.get("order_no") or "").strip()[:30],
        purchase_order_no=str(args.get("purchase_order_no") or "").strip()[:30],
        capacity_block_min=float(args.get("capacity_block_min") or 0.0),
        note=str(args.get("note") or "").strip()[:2000],
        created_by=ctx.user.email,
    )
    ctx.db.add(ev)
    ctx.db.flush()
    change = record(
        ctx.db,
        chat_id=ctx.chat.id if ctx.chat else None,
        message_id=ctx.message_id,
        user=ctx.user,
        tool="create_calendar_event",
        action="create",
        entity="calendar_event",
        entity_id=str(ev.id),
        before=None,
        after={"id": ev.id, "title": ev.title, "start_date": ev.start_date},
        summary=f"Kalendertermin „{ev.title}“ am {ev.start_date} eingetragen.",
    )
    return {"event_id": ev.id, "title": ev.title, "start_date": ev.start_date, "kind": ev.kind, "change": change}


ERP_COLLAB_SPECS: list[ToolSpec] = [
    ToolSpec(
        "get_smart_stock",
        "Read Smart Inventory / MRP across materials: net available sheets, open demand, incoming POs, days of cover, ABC class, reorder point, and recommended auto-supplier.",
        _schema(
            {
                "health": {"type": "string", "enum": ["critical", "reorder", "healthy", "overstock"]},
                "include_inactive": {"type": "boolean"},
                "limit": {"type": "integer"},
            }
        ),
        get_smart_stock,
        roles=frozenset(OFFICE),
    ),
    ToolSpec(
        "rank_material_suppliers",
        "Rank and score all active suppliers for a material (Werkstoff) by price, lead time, on-time reliability, and MOQ.",
        _schema(
            {
                "product_id": {"type": "string"},
                "thk": {"type": "number"},
                "qty": {"type": "integer"},
                "urgent": {"type": "boolean"},
            },
            ["product_id"],
        ),
        rank_material_suppliers,
        roles=frozenset(OFFICE),
    ),
    ToolSpec(
        "create_supplier_purchase_order",
        "Create a supplier purchase order (or proposal) using the auto-ranked best supplier for a material, including a ready-to-send PO email draft.",
        _schema(
            {
                "product_id": {"type": "string"},
                "qty": {"type": "integer"},
                "thk": {"type": "number"},
                "supplier_id": {"type": "integer"},
                "urgent": {"type": "boolean"},
                "status": {"type": "string", "enum": ["proposed", "ordered"]},
                "note": {"type": "string"},
            },
            ["product_id"],
        ),
        create_supplier_purchase_order,
        write=True,
        roles=frozenset(OFFICE),
    ),
    ToolSpec(
        "run_smart_replenishment",
        "Evaluate all materials below reorder point and bundle purchase order proposals per auto-selected supplier (dry_run=true previews without writing).",
        _schema({"dry_run": {"type": "boolean"}}),
        run_smart_replenishment,
        write=True,
        roles=frozenset(OFFICE),
    ),
    ToolSpec(
        "list_emails",
        "List and search emails in the ERP & Copilot Lab Mail Center (inbox, drafts, sent, archive).",
        _schema(
            {
                "folder": {"type": "string", "enum": ["all", "inbox", "drafts", "sent", "archive"]},
                "unread_only": {"type": "boolean"},
                "query": {"type": "string"},
                "order_no": {"type": "string"},
                "purchase_order_no": {"type": "string"},
                "limit": {"type": "integer"},
            }
        ),
        list_emails,
        roles=frozenset(OFFICE),
    ),
    ToolSpec(
        "read_email",
        "Read the full body and metadata of an email message by id.",
        _schema({"email_id": {"type": "integer"}}, ["email_id"]),
        read_email,
        roles=frozenset(OFFICE),
    ),
    ToolSpec(
        "draft_email",
        "Create an email draft in the Mail Center (and optionally stage an Action Proposal for human approval to send). Works without write mode.",
        _schema(
            {
                "to": {"type": "array", "items": {"type": "string"}},
                "subject": {"type": "string"},
                "body": {"type": "string"},
                "order_no": {"type": "string"},
                "purchase_order_no": {"type": "string"},
                "propose_send": {"type": "boolean"},
                "rationale": {"type": "string"},
            },
            ["to", "subject", "body"],
        ),
        draft_email,
        write=False,
        roles=frozenset(OFFICE),
    ),
    ToolSpec(
        "send_email",
        "Send an existing email draft (email_id) or a new email message via the ERP Mail Center.",
        _schema(
            {
                "email_id": {"type": "integer"},
                "to": {"type": "array", "items": {"type": "string"}},
                "subject": {"type": "string"},
                "body": {"type": "string"},
                "order_no": {"type": "string"},
                "purchase_order_no": {"type": "string"},
            }
        ),
        send_email,
        write=True,
        reversible=False,
        roles=frozenset(OFFICE),
    ),
    ToolSpec(
        "list_coworkers",
        "List active internal coworkers (office, dispatch, shopfloor) who can receive platform notes.",
        _schema({}),
        list_coworkers,
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "list_coworker_notes",
        "List internal coworker notes and shift handoffs (optionally filtered by channel or linked entity).",
        _schema(
            {
                "box": {"type": "string", "enum": ["all", "inbox", "sent", "pinned"]},
                "channel": {"type": "string", "enum": ["alle", "buero", "halle", "schicht", "direkt"]},
                "entity_type": {"type": "string"},
                "entity_id": {"type": "string"},
                "unread_only": {"type": "boolean"},
                "limit": {"type": "integer"},
            }
        ),
        list_coworker_notes,
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "send_coworker_note",
        "Send a note or shift handoff to a coworker or team channel (alle, buero, halle, schicht), optionally linked to an order, work_order, product, or purchase_order.",
        _schema(
            {
                "recipient_email": {"type": "string"},
                "recipient_id": {"type": "integer"},
                "channel": {"type": "string", "enum": ["alle", "buero", "halle", "schicht", "direkt"]},
                "priority": {"type": "string", "enum": ["normal", "important", "urgent"]},
                "subject": {"type": "string"},
                "body": {"type": "string"},
                "entity_type": {"type": "string"},
                "entity_id": {"type": "string"},
                "pinned": {"type": "boolean"},
                "ack_required": {"type": "boolean"},
            },
            ["body"],
        ),
        send_coworker_note,
        write=True,
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "get_calendar_schedule",
        "Read the master schedule calendar: upcoming order due dates, inbound supplier PO ETAs, events, and daily plant capacity.",
        _schema({}),
        get_calendar_schedule,
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "create_calendar_event",
        "Create a calendar event (termin, wartung, lieferung, meilenstein, schicht) on the ERP master schedule.",
        _schema(
            {
                "title": {"type": "string"},
                "start_date": {"type": "string"},
                "end_date": {"type": "string"},
                "kind": {"type": "string", "enum": ["termin", "wartung", "lieferung", "meilenstein", "schicht"]},
                "station_id": {"type": "integer"},
                "order_no": {"type": "string"},
                "purchase_order_no": {"type": "string"},
                "capacity_block_min": {"type": "number"},
                "note": {"type": "string"},
            },
            ["title", "start_date"],
        ),
        create_calendar_event_tool,
        write=True,
        roles=frozenset(OFFICE),
    ),
]
