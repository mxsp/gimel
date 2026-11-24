"""Werkzeugfamilie „Subagenten“ für den durchgängigen Orchestrator-Chat.

Der Orchestrator bleibt EIN Chat. Subagenten sind temporäre Einträge in genau
diesem Chat (``agent_subagents``), keine neuen Chats. Sie werden mit
``dispatch_subagent`` erzeugt, mit ``list_subagents`` aufgeführt und mit
``dispose_subagent`` entsorgt.

Ein Subagent kann keine weiteren Subagenten erzeugen (keine Rekursion): nur der
Orchestrator-Chat darf diese Werkzeuge aufrufen, und temporäre Subagent-Personas
haben ``orchestration=False``.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import func

from .models import AgentPersona, AgentProvider, AgentSubagent
from .tools import (
    ALL,
    ToolContext,
    ToolError,
    ToolSpec,
    _iso,
    _need,
    _schema,
)

CAPABILITY_CATALOG: list[dict[str, str]] = [
    {"id": "analyse", "label": "Analyse", "hint": "KPIs, Auswertungen, Engpass-Checks"},
    {"id": "aufträge", "label": "Aufträge", "hint": "Auftragsliste, Status, Termine, Details"},
    {"id": "fertigung", "label": "Fertigung", "hint": "Innenaufträge, Disposition, Schachteln"},
    {"id": "halle & stationen", "label": "Halle & Stationen", "hint": "Arbeitsvorrat, Stationen, Rüstzeiten"},
    {"id": "lager & werkstoffe", "label": "Lager & Werkstoffe", "hint": "Bestände, Platten, Reststücke, Preise"},
    {"id": "kunden", "label": "Kunden", "hint": "Kundenstamm, Konditionen, Historie"},
    {"id": "rechnungen", "label": "Rechnungen", "hint": "Offene Posten, Zahlungsstand, Fälligkeit"},
    {"id": "versand", "label": "Versand", "hint": "Sendungen, Lieferstatus, Versandbereitschaft"},
    {"id": "roboter", "label": "Roboter", "hint": "AGV/AMR-Flotte, Fahraufträge, Wege"},
    {"id": "zwilling", "label": "Zwilling", "hint": "2D/3D-Grundriss, Befunde, Simulation"},
    {"id": "vorschau & dateien", "label": "Vorschau & Dateien", "hint": "Artefakte, Berichte, HTML/SVG/CSV"},
    {"id": "web", "label": "Web", "hint": "Externe Websuche & Recherche"},
    {"id": "einstellungen & protokoll", "label": "Protokoll", "hint": "Audit-Log, Betriebsdaten, Systemstatus"},
    {"id": "sonstiges", "label": "Sonstiges", "hint": "Hilfswerkzeuge & Einheitenrechner"},
]

VALID_CAPABILITIES = {item["id"] for item in CAPABILITY_CATALOG}

_CAPABILITY_ALIASES: dict[str, str] = {
    "analysis": "analyse", "analytics": "analyse", "kpi": "analyse", "kpis": "analyse", "statistik": "analyse",
    "orders": "aufträge", "order": "aufträge", "auftraege": "aufträge", "auftrag": "aufträge",
    "production": "fertigung", "produktion": "fertigung", "nesting": "fertigung", "schachteln": "fertigung",
    "disposition": "fertigung", "workorders": "fertigung",
    "hall": "halle & stationen", "halle": "halle & stationen", "stations": "halle & stationen",
    "stationen": "halle & stationen", "arbeitsvorrat": "halle & stationen", "leitstand": "halle & stationen",
    "inventory": "lager & werkstoffe", "stock": "lager & werkstoffe", "lager": "lager & werkstoffe",
    "materials": "lager & werkstoffe", "werkstoffe": "lager & werkstoffe", "material": "lager & werkstoffe",
    "customers": "kunden", "customer": "kunden", "crm": "kunden",
    "invoices": "rechnungen", "accounting": "rechnungen", "buchhaltung": "rechnungen", "billing": "rechnungen",
    "shipping": "versand", "delivery": "versand", "logistik": "versand",
    "robots": "roboter", "robot": "roboter", "agv": "roboter", "amr": "roboter", "flotte": "roboter",
    "twin": "zwilling", "digital_twin": "zwilling", "grundriss": "zwilling", "studio": "zwilling", "layout": "zwilling",
    "preview": "vorschau & dateien", "files": "vorschau & dateien", "artifacts": "vorschau & dateien",
    "artefakte": "vorschau & dateien", "dateien": "vorschau & dateien", "vorschau": "vorschau & dateien",
    "search": "web", "websearch": "web", "internet": "web",
    "settings": "einstellungen & protokoll", "protocol": "einstellungen & protokoll",
    "protokoll": "einstellungen & protokoll", "audit": "einstellungen & protokoll", "admin": "einstellungen & protokoll",
    "misc": "sonstiges", "other": "sonstiges",
}

_TASK_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("aufträge", ("auftrag", "aufträge", "ab-", "termin", "überfällig", "eilauftrag")),
    ("fertigung", ("fertigung", "produktion", "innenauftrag", "ia-", "schachtel", "nesting", "disposition")),
    ("halle & stationen", ("station", "plotter", "wasserstrahl", "stanze", "arbeitsvorrat", "rüst", "engpass")),
    ("lager & werkstoffe", ("lager", "bestand", "werkstoff", "platte", "epdm", "graphit", "ptfe", "reststück")),
    ("kunden", ("kunde", "kunden", "firma", "anschrift")),
    ("rechnungen", ("rechnung", "zahlung", "buchhaltung", "mahnung", "offene posten")),
    ("versand", ("versand", "sendung", "lieferung", "paket")),
    ("roboter", ("roboter", "agv", "amr", "flotte", "gang", "fahrweg")),
    ("zwilling", ("zwilling", "twin", "grundriss", "halle", "3d", "layout", "befund")),
    ("vorschau & dateien", ("artefakt", "bericht", "dashboard", "diagramm", "csv", "html", "svg")),
    ("web", ("web", "internet", "recherchier", "suche online")),
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _slug(text: str, fallback: str = "subagent") -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:60] or fallback


def _orchestrator_chat(ctx: ToolContext):
    chat = ctx.chat
    if (getattr(chat, "kind", "classic") or "classic").lower() != "orchestrator":
        raise ToolError("Subagenten darf nur ein Orchestrator-Chat erzeugen.")
    return chat


def normalize_capability(raw: str) -> str | None:
    key = str(raw or "").strip().lower()
    if not key:
        return None
    if key in VALID_CAPABILITIES:
        return key
    return _CAPABILITY_ALIASES.get(key)


def _infer_capabilities(task: str) -> list[str]:
    low = (task or "").lower()
    inferred: list[str] = []
    for cap, words in _TASK_KEYWORDS:
        if any(w in low for w in words) and cap not in inferred:
            inferred.append(cap)
    if "analyse" not in inferred:
        inferred.insert(0, "analyse")
    return inferred[:5]


def _capabilities(args: dict, task: str = "") -> list[str]:
    raw = args.get("capabilities") or []
    if isinstance(raw, str):
        raw = [part.strip() for part in raw.split(",")]
    out: list[str] = []
    for item in raw[:25]:
        cap = normalize_capability(str(item))
        if cap and cap not in out:
            out.append(cap)
    if not out and task:
        return _infer_capabilities(task)
    return out


def dispatch_subagent(ctx: ToolContext, args: dict) -> dict:
    """Erzeugt einen temporären Subagenten im selben Orchestrator-Chat."""
    chat = _orchestrator_chat(ctx)
    name = str(_need(args, "name")).strip()[:120]
    task = str(_need(args, "task")).strip()[:6000]
    role_title = str(args.get("role_title") or "Temporärer Subagent").strip()[:120]
    capabilities = _capabilities(args, task=task)
    count = ctx.db.query(func.count(AgentSubagent.id)).filter(
        AgentSubagent.chat_id == chat.id,
        AgentSubagent.disposed_at.is_(None),
    ).scalar() or 0
    if count >= 20:
        raise ToolError("Zu viele temporäre Subagenten. Entsorge zuerst einen.")

    provider = (
        ctx.db.get(AgentProvider, chat.provider_id)
        if getattr(chat, "provider_id", None)
        else None
    )
    if provider is None or not provider.enabled:
        provider = (
            ctx.db.query(AgentProvider)
            .filter_by(enabled=True)
            .order_by(AgentProvider.is_default.desc(), AgentProvider.id)
            .first()
        )
    model = str(args.get("model") or getattr(chat, "model", "") or (provider.default_model if provider else ""))[:160]
    persona = AgentPersona(
        user_id=ctx.user.id,
        slug=_slug(name, "subagent"),
        name=name,
        role_title=role_title,
        description="Vom Orchestrator erzeugter temporärer Subagent (kein eigener Chat).",
        category="custom",
        icon="predictive-analysis",
        color="#0b7a67",
        system_prompt=(
            f"Du bist der temporäre Subagent „{name}“ ({role_title}). "
            f"Führe ausschließlich diese Aufgabe aus: {task}\n"
            "Du darfst keine weiteren Subagenten erzeugen. Melde dein Ergebnis knapp "
            "und sachlich an den Orchestrator zurück."
        ),
        tool_categories=capabilities,
        preferred_model=model,
        default_write_mode=False,
        has_routines=False,
        orchestration=False,
        temporary=True,
        routine_ids=[],
        template_keys=[],
        starter_prompts=[task[:300]],
        shared=False,
        enabled=True,
    )
    ctx.db.add(persona)
    ctx.db.flush()
    sub = AgentSubagent(
        chat_id=chat.id,
        persona_id=persona.id,
        name=name,
        task=task,
        capabilities=capabilities,
        used_calls=0,
        status="queued",
        result="",
    )
    ctx.db.add(sub)
    ctx.db.commit()
    from .subagent_runner import start_subagent

    start_subagent(sub.id)
    return {
        "ok": True,
        "subagent_id": sub.id,
        "persona_id": persona.id,
        "chat_id": chat.id,
        "name": name,
        "role_title": role_title,
        "capabilities": capabilities,
        "task": task,
        "status": "queued",
        "note": (
            "Subagent läuft im Hintergrund im selben Chat. Rufe wait_for_subagents "
            "auf, bevor du antwortest; erst dann mit dispose_subagent entsorgen."
        ),
    }


def list_subagents(ctx: ToolContext, args: dict) -> dict:
    """Listet alle Subagenten dieses einen Orchestrator-Chats."""
    chat = _orchestrator_chat(ctx)
    rows = (
        ctx.db.query(AgentSubagent)
        .filter(AgentSubagent.chat_id == chat.id)
        .order_by(AgentSubagent.id)
        .all()
    )
    items = []
    for row in rows:
        persona = ctx.db.get(AgentPersona, row.persona_id) if row.persona_id else None
        items.append({
            "subagent_id": row.id,
            "persona_id": row.persona_id,
            "name": row.name,
            "task": row.task,
            "capabilities": list(row.capabilities or []),
            "used_calls": int(row.used_calls or 0),
            "status": row.status or "running",
            "result": row.result or "",
            "disposed": row.disposed_at is not None,
            "created_at": _iso(row.created_at),
            "last_used_at": _iso(row.last_used_at),
            "disposed_at": _iso(row.disposed_at),
            "enabled": bool(persona.enabled) if persona else False,
        })
    active = [i for i in items if not i["disposed"]]
    return {
        "ok": True, "chat_id": chat.id, "count": len(items),
        "active_count": len(active),
        "active": active,
        "subagents": items,
    }


def purge_subagent(db, sub: AgentSubagent) -> None:
    """Löscht einen temporären Subagenten samt zugehöriger temporärer Persona aus der DB."""
    row = db.get(AgentSubagent, sub.id)
    if row is None:
        return
    persona = db.get(AgentPersona, row.persona_id) if row.persona_id else None
    db.delete(row)
    if persona is not None and getattr(persona, "temporary", False):
        db.delete(persona)


def dispose_subagent(ctx: ToolContext, args: dict) -> dict:
    """Löscht einen temporären Subagenten samt Persona nach Gebrauch endgültig."""
    chat = _orchestrator_chat(ctx)
    subagent_id = int(_need(args, "subagent_id"))
    sub = ctx.db.get(AgentSubagent, subagent_id)
    if sub is None:
        return {"ok": True, "subagent_id": subagent_id, "chat_id": chat.id, "disposed": True}
    if sub.chat_id != chat.id:
        raise ToolError("Subagent nicht in diesem Chat gefunden.")
    purge_subagent(ctx.db, sub)
    ctx.db.commit()
    return {"ok": True, "subagent_id": subagent_id, "chat_id": chat.id, "disposed": True}


def wait_for_subagent_results(ctx: ToolContext, args: dict) -> dict:
    """Wartet auf alle Subagenten, gibt ihre Ergebnisse zurück und löscht erledigte Subagenten sofort."""
    chat = _orchestrator_chat(ctx)
    timeout = float(args.get("timeout_s") or 90)
    from .subagent_runner import wait_for_subagents

    rows, timed_out = wait_for_subagents(chat.id, timeout_s=timeout)
    results = []
    purged = 0
    for r in rows:
        finished = r.status in ("done", "error", "cancelled")
        results.append({
            "subagent_id": r.id,
            "name": r.name,
            "status": r.status or "running",
            "result": r.result or "",
            "disposed": finished or (r.disposed_at is not None),
        })
        if finished or r.disposed_at is not None:
            purge_subagent(ctx.db, r)
            purged += 1
    ctx.db.commit()
    note = (
        "Zeitlimit beim Warten auf Subagenten erreicht; mindestens ein Subagent läuft noch."
        if timed_out
        else "Fasse alle Ergebnisse zusammen. Erledigte temporäre Subagenten wurden bereits automatisch gelöscht."
    )
    return {
        "ok": True, "chat_id": chat.id, "count": len(results),
        "purged": purged,
        "timed_out": timed_out,
        "results": results,
        "note": note,
    }


SUBAGENT_SPECS: list[ToolSpec] = [
    ToolSpec(
        "dispatch_subagent",
        "Erzeugt einen temporären Subagenten im selben Orchestrator-Chat (kein neuer Chat) mit festgelegten Fähigkeiten. Nur im Orchestrator-Chat; Subagenten können selbst keine erzeugen.",
        _schema({
            "name": {"type": "string"},
            "task": {"type": "string"},
            "role_title": {"type": "string"},
            "capabilities": {"type": "array", "items": {"type": "string"}},
            "model": {"type": "string"},
        }, ["name", "task"]),
        dispatch_subagent, roles=frozenset(ALL), reversible=True, orchestrator_only=True,
    ),
    ToolSpec(
        "list_subagents",
        "Listet alle temporären Subagenten dieses einen Orchestrator-Chats mit Aufgabe, Fähigkeiten und Verwendung.",
        _schema({}, []),
        list_subagents, roles=frozenset(ALL), reversible=True, orchestrator_only=True,
    ),
    ToolSpec(
        "wait_for_subagents",
        "Wartet, bis alle temporären Subagenten fertig sind, und liefert ihre Ergebnisse. Vor der Gesamtantwort aufrufen.",
        _schema({"timeout_s": {"type": "number"}}, []),
        wait_for_subagent_results, roles=frozenset(ALL), reversible=True, orchestrator_only=True,
    ),
    ToolSpec(
        "dispose_subagent",
        "Entsorgt einen temporären Subagenten nach Gebrauch — der Chat bleibt bestehen.",
        _schema({"subagent_id": {"type": "integer"}}, ["subagent_id"]),
        dispose_subagent, roles=frozenset(ALL), reversible=True, orchestrator_only=True,
    ),
]
