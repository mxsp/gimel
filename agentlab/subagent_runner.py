"""Hintergrundlauf eines temporären Subagenten im selben Orchestrator-Chat.

Der Lauf speichert sein Ergebnis in ``agent_subagents.result``; der Orchestrator
holt es mit ``wait_for_subagents`` ab und schreibt erst dann seine Gesamtantwort.
Ein Subagent erzeugt nie einen neuen Chat und darf nie weitere Subagenten starten.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from datetime import datetime, timezone

from gimel.db import SessionLocal
from gimel.models import Role, User

from . import settings as agent_settings
from .llm import stream_completion
from .models import AgentChat, AgentPersona, AgentProvider, AgentSubagent
from .providers import api_key, provider_context_length, requires_api_key
from .tools import ToolContext, execute_tool, parse_tool_arguments, schemas_for

DEFAULT_MAX_STEPS = 15
MAX_STEPS_HARD_CAP = 50
MAX_RESULT_CHARS = 32_000


def _category_labels(caps: list[str]) -> set[str]:
    known = {
        "analyse": "Analyse", "aufträge": "Aufträge", "fertigung": "Fertigung",
        "halle & stationen": "Halle & Stationen", "lager & werkstoffe": "Lager & Werkstoffe",
        "kunden": "Kunden", "rechnungen": "Rechnungen", "versand": "Versand",
        "lieferkette": "Lieferkette", "roboter": "Roboter", "zwilling": "Zwilling",
        "vorschau & dateien": "Vorschau & Dateien", "web": "Web",
        "einstellungen & protokoll": "Einstellungen & Protokoll", "sonstiges": "Sonstiges",
    }
    return {known[c] for c in caps if c in known}


def _run_async(subagent_id: int) -> None:
    db = SessionLocal()
    try:
        sub = db.get(AgentSubagent, subagent_id)
        if sub is None or sub.disposed_at is not None:
            return
        chat = db.get(AgentChat, sub.chat_id)
        persona = db.get(AgentPersona, sub.persona_id) if sub.persona_id else None
        if chat is None or persona is None:
            sub.status = "error"
            sub.result = "Subagent-Kontext nicht mehr verfügbar."
            db.commit()
            return
        user = db.get(User, chat.user_id)
        if user is None:
            sub.status = "error"
            sub.result = "Benutzerkonto nicht mehr verfügbar."
            db.commit()
            return
        provider = (
            db.get(AgentProvider, chat.provider_id)
            if getattr(chat, "provider_id", None)
            else None
        )
        if provider is None or not provider.enabled:
            provider = (
                db.query(AgentProvider)
                .filter_by(enabled=True)
                .order_by(AgentProvider.is_default.desc(), AgentProvider.id)
                .first()
            )
        if provider is None:
            sub.status = "error"
            sub.result = "Kein Anbieter eingerichtet."
            db.commit()
            return
        model = persona.preferred_model or chat.model or provider.default_model or ""
        if not model:
            sub.status = "error"
            sub.result = "Kein Modell gewählt."
            db.commit()
            return
        if requires_api_key(provider) and not api_key(provider):
            sub.status = "error"
            sub.result = "Für diesen Anbieter fehlt der API-Schlüssel."
            db.commit()
            return

        sub.status = "running"
        sub.last_used_at = datetime.now(timezone.utc)
        db.commit()

        tools = schemas_for(
            user, write_mode=False,
            preferred_categories=_category_labels(list(sub.capabilities or [])),
            max_tools=32, query=sub.task or "",
        )
        messages: list[dict] = [
            {"role": "system", "content": (
                (persona.system_prompt or "Du bist ein temporärer Gimel-Subagent.")
                + "\nDu erzeugst keine Subagenten und keinen neuen Chat. Arbeite nur mit den "
                  "Werkzeugen deiner Kategorien und liefere ein knappes, sachliches Ergebnis "
                  "an den Orchestrator zurück."
            )},
            {"role": "user", "content": sub.task or ""},
        ]

        try:
            configured = agent_settings.get_int(db, "agent_subagent_max_steps")
        except Exception:  # noqa: BLE001
            configured = DEFAULT_MAX_STEPS
        max_steps = max(1, min(int(configured), MAX_STEPS_HARD_CAP))

        async def go() -> str:
            text = ""
            hit_limit = False
            for _step in range(max_steps):
                parts: list[str] = []
                calls: list[dict] = []
                async for event in stream_completion(
                    provider, model=model, messages=messages, tools=tools or None,
                    session_id=f"gimel-subagent-{subagent_id}", timeout_s=180,
                    num_ctx=provider_context_length(provider),
                ):
                    if event.get("type") == "text":
                        parts.append(str(event.get("text") or ""))
                    elif event.get("type") == "done":
                        calls = list(event.get("tool_calls") or [])
                text = "".join(parts)
                if not calls:
                    break
                messages.append({"role": "assistant", "content": text, "tool_calls": calls})
                for call in calls:
                    fn = call.get("function") or {}
                    name = str(fn.get("name") or "")
                    parsed, err = parse_tool_arguments(fn.get("arguments") or "{}")
                    if err:
                        result = {"ok": False, "error": err}
                    else:
                        try:
                            result = execute_tool(
                                ToolContext(db=db, user=user, chat=chat, context=None),
                                name, parsed, write_mode=False,
                            )
                        except Exception as exc:  # noqa: BLE001
                            result = {"ok": False, "error": str(exc)}
                    sub.used_calls = int(sub.used_calls or 0) + 1
                    sub.last_used_at = datetime.now(timezone.utc)
                    db.commit()
                    messages.append({
                        "role": "tool", "tool_call_id": str(call.get("id") or ""),
                        "name": name,
                        "content": json.dumps(result, ensure_ascii=False, default=str)[:12_000],
                    })
            else:
                hit_limit = True

            if hit_limit:
                synth_parts: list[str] = []
                synth_messages = messages + [{
                    "role": "system",
                    "content": "Werkzeugbudget ausgeschöpft. Fasse alle gewonnenen Fakten knapp für den Orchestrator zusammen.",
                }]
                async for event in stream_completion(
                    provider, model=model, messages=synth_messages, tools=None,
                    session_id=f"gimel-subagent-{subagent_id}", timeout_s=180,
                    num_ctx=provider_context_length(provider),
                ):
                    if event.get("type") == "text":
                        synth_parts.append(str(event.get("text") or ""))
                synth_text = "".join(synth_parts).strip()
                if synth_text:
                    text = synth_text
            return text[:MAX_RESULT_CHARS]

        result_text = asyncio.run(go()) or "(keine Antwort)"
        db.expire_all()
        fresh = db.get(AgentSubagent, subagent_id)
        if fresh is None or fresh.disposed_at is not None:
            return
        fresh.result = result_text
        fresh.status = "done"
        fresh.last_used_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        try:
            db.rollback()
            db.expire_all()
            sub = db.get(AgentSubagent, subagent_id)
            if sub is not None and sub.disposed_at is None:
                sub.status = "error"
                sub.result = str(exc)[:MAX_RESULT_CHARS]
                db.commit()
        except Exception:  # noqa: BLE001
            pass
    finally:
        db.close()


def start_subagent(subagent_id: int) -> None:
    threading.Thread(target=_run_async, args=(subagent_id,), daemon=True,
                     name=f"subagent-{subagent_id}").start()


def wait_for_subagents(chat_id: int, timeout_s: float = 120.0) -> tuple[list[AgentSubagent], bool]:
    """Wartet, bis alle Subagenten eines Chats fertig sind; gibt ``(rows, timed_out)`` zurück."""
    deadline = time.monotonic() + max(1.0, min(timeout_s, 300.0))
    from gimel.db import SessionLocal as _SL
    while True:
        with _SL() as db:
            rows = (
                db.query(AgentSubagent)
                .filter(AgentSubagent.chat_id == chat_id,
                        AgentSubagent.disposed_at.is_(None),
                        AgentSubagent.status.in_(("running", "queued")))
                .all()
            )
            if not rows:
                all_rows = (
                    db.query(AgentSubagent)
                    .filter(AgentSubagent.chat_id == chat_id)
                    .order_by(AgentSubagent.id)
                    .all()
                )
                return all_rows, False
            if time.monotonic() >= deadline:
                all_rows = (
                    db.query(AgentSubagent)
                    .filter(AgentSubagent.chat_id == chat_id)
                    .order_by(AgentSubagent.id)
                    .all()
                )
                return all_rows, True
        time.sleep(0.3)
