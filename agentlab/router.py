"""REST und SSE des Agent Labors unter ``/api/agent``."""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from gimel.db import get_db
from gimel.models import AuditLog, Role, User
from gimel.security import has_admin_work, require_admin, require_staff, require_worker

from . import files as file_service
from . import page_context
from . import providers as provider_service
from . import sandbox as sandbox_service
from . import settings as agent_settings
from . import speech as speech_service
from . import stats as stats_service
from . import websearch
from .models import (AgentActionProposal, AgentArtifact, AgentAttachment, AgentChange,
                     AgentChat, AgentMessage, AgentPersona, AgentPrompt, AgentProvider,
                     AgentRoutine, AgentRoutineRun, AgentSubagent)
from .rollback import RevertConflict, revert
from .runner import run_stream
from .tools import public_catalog

router = APIRouter(prefix="/api/agent", tags=["agent"])

ACTIVE: dict[int, asyncio.Event] = {}
ACTIVE_LOCK = asyncio.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _admin(user: User) -> bool:
    return has_admin_work(user)


def _provider_out(p: AgentProvider, user: User) -> dict:
    req_key = provider_service.requires_api_key(p)
    return {
        "id": p.id,
        "name": p.name,
        "kind": p.kind,
        "base_url": p.base_url,
        "models_url": p.models_url,
        "default_model": p.default_model,
        "enabled": p.enabled,
        "is_default": p.is_default,
        "protocol": provider_service.provider_protocol(p),
        "requires_key": req_key,
        "context_length": provider_service.provider_context_length(p),
        "has_key": bool(p.api_key_enc) or provider_service.key_source(p) == "env",
        "key_source": provider_service.key_source(p),
        "models": p.models_cache or [],
        "models_fetched_at": p.models_fetched_at,
        "headers": provider_service.clean_headers(p.headers) if _admin(user) else {},
        "created_at": p.created_at,
        "updated_at": p.updated_at,
    }


def _chat_out(db: Session, chat: AgentChat) -> dict:
    last = (
        db.query(AgentMessage)
        .filter(AgentMessage.chat_id == chat.id, AgentMessage.hidden_at.is_(None))
        .order_by(AgentMessage.id.desc())
        .first()
    )
    preview = ""
    if last and last.role in ("user", "assistant") and last.content:
        text = re.sub(r"```.*?```", " ", last.content, flags=re.S)
        text = re.sub(r"[*_`#>]+", "", text)
        preview = " ".join(text.split())[:140]
    provider = db.get(AgentProvider, chat.provider_id) if chat.provider_id else None
    from . import agents as agent_service

    agent_info = agent_service.resolve_chat_agent(db, chat)
    return {
        "id": chat.id,
        "title": chat.title or "Neuer Chat",
        "provider_id": chat.provider_id,
        "provider_name": provider.name if provider else "",
        "model": chat.model,
        "write_mode": chat.write_mode,
        "kind": getattr(chat, "kind", "classic") or "classic",
        "chat_type": getattr(chat, "kind", "classic") or "classic",
        "chat_kind": getattr(chat, "kind", "classic") or "classic",
        "mode": getattr(chat, "kind", "classic") or "classic",
        "agent_id": chat.agent_id,
        "agent_key": chat.agent_key or "",
        "agent_name": agent_info["name"] if agent_info else "",
        "agent_role_title": agent_info["role_title"] if agent_info else "",
        "agent_icon": agent_info["icon"] if agent_info else "",
        "agent_color": agent_info["color"] if agent_info else "",
        "agent_starters": agent_info["starter_prompts"] if agent_info else [],
        "created_at": chat.created_at,
        "updated_at": chat.updated_at,
        "last_message_at": chat.last_message_at,
        "last_message": preview,
    }


def _message_out(row: AgentMessage, attachments: list[AgentAttachment] | None = None) -> dict:
    return {
        "id": row.id,
        "chat_id": row.chat_id,
        "role": row.role,
        "content": row.content or "",
        "tool_calls": row.tool_calls or [],
        "tool_call_id": row.tool_call_id,
        "name": row.name,
        "model": row.model,
        "usage": row.usage or {},
        "interrupted": row.interrupted,
        "created_at": row.created_at,
        "attachments": [file_service.out(a) for a in (attachments or [])],
    }


def _change_out(change: AgentChange) -> dict:
    return {
        "id": change.id,
        "chat_id": change.chat_id,
        "message_id": change.message_id,
        "tool": change.tool,
        "action": change.action,
        "entity": change.entity,
        "entity_id": change.entity_id,
        "before": change.before,
        "after": change.after,
        "reversible": change.reversible,
        "status": change.status,
        "summary": change.summary,
        "created_at": change.created_at,
        "reverted_at": change.reverted_at,
        "reverted_by": change.reverted_by,
    }


def _chat_for(db: Session, user: User, chat_id: int) -> AgentChat:
    chat = db.get(AgentChat, chat_id)
    if chat is None or chat.user_id != user.id or chat.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Chat nicht gefunden.")
    return chat


def _provider_for(db: Session, user: User, provider_id: int) -> AgentProvider:
    row = db.get(AgentProvider, provider_id)
    if row is None or (not row.enabled and not _admin(user)):
        raise HTTPException(status_code=404, detail="Anbieter nicht gefunden.")
    return row


# --------------------------------------------------------------------------
# Anbieter
# --------------------------------------------------------------------------
class ProviderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str = Field(default="custom", max_length=40)
    base_url: str = Field(min_length=1, max_length=400)
    models_url: str = Field(default="", max_length=400)
    api_key: str = Field(default="", max_length=2000)
    headers: dict = Field(default_factory=dict)
    default_model: str = Field(default="", max_length=160)
    enabled: bool = True
    is_default: bool = False


class ProviderUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    kind: str | None = Field(default=None, max_length=40)
    base_url: str | None = Field(default=None, max_length=400)
    models_url: str | None = Field(default=None, max_length=400)
    api_key: str | None = Field(default=None, max_length=2000)
    clear_key: bool = False
    headers: dict | None = None
    default_model: str | None = Field(default=None, max_length=160)
    enabled: bool | None = None
    is_default: bool | None = None


def _audit(db: Session, user: User, action: str, entity_id: str,
           detail: dict | None = None, entity: str = "agent_provider"):
    db.add(AuditLog(actor=user.email, action=action, entity=entity,
                    entity_id=str(entity_id), detail=detail or {}))


def _make_default(db: Session, row: AgentProvider) -> None:
    db.query(AgentProvider).filter(AgentProvider.id != row.id).update(
        {AgentProvider.is_default: False}, synchronize_session=False
    )
    row.is_default = True
    row.enabled = True


@router.get("/providers")
def list_providers(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    query = db.query(AgentProvider)
    if not _admin(user):
        query = query.filter(AgentProvider.enabled.is_(True))
    rows = query.order_by(AgentProvider.is_default.desc(), AgentProvider.name).all()
    return {"providers": [_provider_out(p, user) for p in rows],
            "presets": provider_service.PRESETS}


def _validate_provider_url(url: str, *, allow_empty: bool = False) -> str:
    url = (url or "").strip()
    if not url:
        if allow_empty:
            return ""
        raise HTTPException(status_code=422, detail="Die Adresse fehlt.")
    try:
        return websearch.check_url(url, allow_private=True)
    except websearch.WebSearchError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/providers", status_code=201)
def create_provider(
    body: ProviderCreate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    base = _validate_provider_url(body.base_url)
    models_url = _validate_provider_url(body.models_url, allow_empty=True)
    row = AgentProvider(
        name=body.name.strip()[:120], kind=body.kind.strip()[:40] or "custom",
        base_url=base, models_url=models_url,
        headers=provider_service.clean_headers(body.headers),
        default_model=body.default_model.strip()[:160],
        enabled=bool(body.enabled), created_by=user.email, updated_by=user.email,
    )
    if body.api_key.strip():
        provider_service.set_key(row, body.api_key)
    db.add(row)
    db.flush()
    if body.is_default or db.query(AgentProvider).count() == 1:
        _make_default(db, row)
    _audit(db, user, "agent_provider_create", str(row.id),
           {"name": row.name, "base_url": row.base_url})
    db.commit()
    db.refresh(row)
    return _provider_out(row, user)


@router.put("/providers/{provider_id}")
def update_provider(
    provider_id: int,
    body: ProviderUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    row = db.get(AgentProvider, provider_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Anbieter nicht gefunden.")
    if body.name is not None:
        row.name = body.name.strip()[:120]
    if body.kind is not None:
        row.kind = body.kind.strip()[:40] or "custom"
    if body.base_url is not None:
        row.base_url = _validate_provider_url(body.base_url)
    if body.models_url is not None:
        row.models_url = _validate_provider_url(body.models_url, allow_empty=True)
    if body.headers is not None:
        row.headers = provider_service.clean_headers(body.headers)
    if body.default_model is not None:
        row.default_model = body.default_model.strip()[:160]
    if body.enabled is not None:
        row.enabled = bool(body.enabled)
    if body.clear_key:
        provider_service.clear_key(row)
    elif body.api_key:
        provider_service.set_key(row, body.api_key)
    if body.is_default:
        _make_default(db, row)
    row.updated_by = user.email
    _audit(db, user, "agent_provider_update", str(row.id),
           {"name": row.name, "fields": [k for k, v in body.model_dump().items()
                                         if v is not None and k not in ("api_key",)]})
    db.commit()
    db.refresh(row)
    return _provider_out(row, user)


@router.post("/providers/{provider_id}/default")
def default_provider(
    provider_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    row = db.get(AgentProvider, provider_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Anbieter nicht gefunden.")
    _make_default(db, row)
    _audit(db, user, "agent_provider_default", str(row.id))
    db.commit()
    return {"id": row.id, "is_default": True}


@router.delete("/providers/{provider_id}")
def delete_provider(
    provider_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    row = db.get(AgentProvider, provider_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Anbieter nicht gefunden.")
    row.enabled = False
    row.is_default = False
    next_row = (
        db.query(AgentProvider)
        .filter(AgentProvider.id != row.id, AgentProvider.enabled.is_(True))
        .order_by(AgentProvider.id)
        .first()
    )
    if next_row:
        _make_default(db, next_row)
    _audit(db, user, "agent_provider_delete", str(row.id), {"name": row.name})
    db.commit()
    return {"id": row.id, "enabled": False}


@router.delete("/providers/{provider_id}/key")
def delete_provider_key(
    provider_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    row = db.get(AgentProvider, provider_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Anbieter nicht gefunden.")
    provider_service.clear_key(row)
    _audit(db, user, "agent_provider_key_delete", str(row.id))
    db.commit()
    return {"id": row.id, "has_key": False}


@router.post("/providers/{provider_id}/test")
async def test_provider(
    provider_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    row = db.get(AgentProvider, provider_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Anbieter nicht gefunden.")
    try:
        result = await provider_service.test_provider(db, row)
    except provider_service.ProviderError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    _audit(db, user, "agent_provider_test", str(row.id), {"ok": True})
    db.commit()
    return result


@router.get("/providers/{provider_id}/models")
async def provider_models(
    provider_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    row = _provider_for(db, user, provider_id)
    try:
        models, warning = await provider_service.fetch_models(db, row)
    except provider_service.ProviderError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return {"models": models, "warning": warning,
            "fetched_at": row.models_fetched_at,
            "default_model": row.default_model}


@router.post("/providers/{provider_id}/models/refresh")
async def refresh_provider_models(
    provider_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    row = db.get(AgentProvider, provider_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Anbieter nicht gefunden.")
    try:
        models, warning = await provider_service.fetch_models(db, row, force=True)
    except provider_service.ProviderError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return {"models": models, "warning": warning,
            "fetched_at": row.models_fetched_at,
            "default_model": row.default_model}


def _has_voice_route(routes) -> bool:
    for r in routes:
        if getattr(r, "path", "") == "/api/agent/voice":
            return True
        orig = getattr(r, "original_router", None)
        if orig is not None and _has_voice_route(getattr(orig, "routes", ())):
            return True
    return False


def _voice_mounted(request: Request) -> bool:
    if os.environ.get("GIMEL_VOICE") == "1":
        return True
    app = getattr(request, "app", None)
    if app is None:
        return False
    return _has_voice_route(getattr(app, "routes", ()))


@router.get("/config")
def config(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    row = (
        db.query(AgentProvider)
        .filter(AgentProvider.enabled.is_(True))
        .order_by(AgentProvider.is_default.desc(), AgentProvider.id)
        .first()
    )
    return {
        "configured": bool(
            row
            and (not provider_service.requires_api_key(row) or provider_service.api_key(row))
            and (row.default_model or row.models_cache)
        ),
        "provider": _provider_out(row, user) if row else None,
        "admin": _admin(user),
        "voice_enabled": _voice_mounted(request),
        "web_enabled": agent_settings.get_bool(db, "agent_web_enabled"),
        "sandbox_enabled": agent_settings.get_bool(db, "agent_sandbox_enabled"),
        "max_steps": agent_settings.get_int(db, "agent_max_steps"),
        "orchestrator_max_steps": agent_settings.get_int(db, "agent_orchestrator_max_steps"),
        "subagent_max_steps": agent_settings.get_int(db, "agent_subagent_max_steps"),
    }


# --------------------------------------------------------------------------
# Einstellungen
# --------------------------------------------------------------------------
class SettingsUpdate(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)


class SettingsReset(BaseModel):
    keys: list[str] = Field(default_factory=list)


class WebSearchTest(BaseModel):
    query: str = Field(min_length=2, max_length=500)


@router.get("/settings")
def read_settings(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    data = agent_settings.public(db)
    data["admin"] = _admin(user)
    data["web_enabled"] = agent_settings.get_bool(db, "agent_web_enabled")
    data["sandbox_enabled"] = agent_settings.get_bool(db, "agent_sandbox_enabled")
    return data


@router.put("/settings")
def write_settings(
    body: SettingsUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    if not body.values:
        raise HTTPException(status_code=422, detail="Keine Einstellung übergeben.")
    changed: list[str] = []
    try:
        for key, value in body.values.items():
            agent_settings.set_value(db, key, value, user.email)
            changed.append(key)
    except agent_settings.SettingsError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    _audit(db, user, "agent_settings_update", "settings",
           {"keys": changed}, entity="agent_setting")
    db.commit()
    data = agent_settings.public(db)
    data["admin"] = True
    data["web_enabled"] = agent_settings.get_bool(db, "agent_web_enabled")
    data["sandbox_enabled"] = agent_settings.get_bool(db, "agent_sandbox_enabled")
    return data


@router.post("/settings/reset")
def reset_settings(
    body: SettingsReset,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    unknown = [key for key in body.keys if key not in agent_settings.BY_KEY]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unbekannte Einstellung „{unknown[0]}“.")
    agent_settings.reset(db, body.keys or None, user.email)
    _audit(db, user, "agent_settings_reset", "settings",
           {"keys": body.keys or "alle"}, entity="agent_setting")
    db.commit()
    data = agent_settings.public(db)
    data["admin"] = True
    data["web_enabled"] = agent_settings.get_bool(db, "agent_web_enabled")
    data["sandbox_enabled"] = agent_settings.get_bool(db, "agent_sandbox_enabled")
    return data


@router.post("/settings/websearch/test")
def test_websearch(
    body: WebSearchTest,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    if not agent_settings.get_bool(db, "agent_web_enabled"):
        raise HTTPException(status_code=409, detail="Die Websuche ist ausgeschaltet.")
    try:
        result = websearch.search(db, body.query, limit=5)
    except websearch.WebSearchError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"Die Websuche ist fehlgeschlagen: {exc}"
        ) from exc
    _audit(db, user, "agent_websearch_test", "websearch",
           {"provider": result["provider"], "results": len(result["results"])},
           entity="agent_setting")
    db.commit()
    return result


# --------------------------------------------------------------------------
# Chats
# --------------------------------------------------------------------------
class ChatCreate(BaseModel):
    title: str = Field(default="Neuer Chat", max_length=160)
    provider_id: int | None = None
    model: str = Field(default="", max_length=160)
    write_mode: bool = False
    agent_id: int | None = None
    agent_key: str = Field(default="", max_length=60)
    #: Art des Chats: ``classic`` (bisheriger Einzelchat) oder ``orchestrator``.
    kind: str = Field(default="classic", max_length=40)
    chat_type: str | None = Field(default=None, max_length=40)
    chat_kind: str | None = Field(default=None, max_length=40)
    mode: str | None = Field(default=None, max_length=40)


class ChatUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    provider_id: int | None = None
    model: str | None = Field(default=None, max_length=160)
    write_mode: bool | None = None
    agent_id: int | None = None
    agent_key: str | None = Field(default=None, max_length=60)
    kind: str | None = Field(default=None, max_length=40)
    chat_type: str | None = Field(default=None, max_length=40)
    chat_kind: str | None = Field(default=None, max_length=40)
    mode: str | None = Field(default=None, max_length=40)


class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)
    route: str = Field(default="", max_length=200)
    attachment_ids: list[int] = Field(default_factory=list, max_length=20)
    # Was der Nutzer sieht. Roh und unvertraut: ``page_context.sanitize`` erzwingt Form und Größe.
    context: dict | None = None
    # Live-Gespräch (task 43): ohne Vorschau Gehörtes. Mit Schreibzugriff (Owner 2026-11-08)
    # nur zurücknehmbare Änderungen; der Server erzwingt das in ``tools.live_write_ok``.
    hands_free: bool = False
    # Optionales Schrittbudget für diesen Lauf (1–100); leer = Standard aus Einstellungen.
    max_steps: int | None = Field(default=None, ge=1, le=100)

    @field_validator("context")
    @classmethod
    def _context_size(cls, value: dict | None) -> dict | None:
        if value is not None and len(json.dumps(value, default=str)) > 65_536:
            raise ValueError("Der Ansichtsausschnitt ist zu groß.")
        return value


@router.get("/chats")
def list_chats(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    q: str = "",
) -> dict:
    query = db.query(AgentChat).filter(AgentChat.user_id == user.id, AgentChat.deleted_at.is_(None))
    rows = query.order_by(func.coalesce(AgentChat.last_message_at, AgentChat.updated_at).desc()).limit(100).all()
    needle = q.strip().casefold()
    if needle:
        matched: list[AgentChat] = []
        for c in rows:
            if needle in (c.title or "").casefold():
                matched.append(c)
                continue
            msgs = (
                db.query(AgentMessage.content)
                .filter(AgentMessage.chat_id == c.id, AgentMessage.hidden_at.is_(None), AgentMessage.role.in_(("user", "assistant")))
                .order_by(AgentMessage.id.desc())
                .limit(30)
                .all()
            )
            if any(needle in (content or "").casefold() for (content,) in msgs):
                matched.append(c)
        rows = matched
    return {"chats": [_chat_out(db, c) for c in rows]}


@router.get("/stats")
def stats(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    days: int = 30,
) -> dict:
    """Modelle, Token und gemeldete Kosten des eigenen Kontos.

    ``days=0`` heißt „alles“. Die Antwort enthält nur, was der Anbieter je
    Runde gemeldet hat; ausgeblendete und gelöschte Chats zählen mit, weil
    ihre Aufrufe trotzdem bezahlt wurden.
    """
    return stats_service.collect(db, user.id, days)


@router.post("/chats", status_code=201)
def create_chat(
    body: ChatCreate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    provider = None
    if body.provider_id is not None:
        provider = _provider_for(db, user, body.provider_id)
    else:
        provider = (
            db.query(AgentProvider)
            .filter(AgentProvider.enabled.is_(True))
            .order_by(AgentProvider.is_default.desc(), AgentProvider.id)
            .first()
        )
    _kind = (body.kind or body.chat_type or body.chat_kind or body.mode or "classic").strip().lower()
    if _kind not in ("classic", "orchestrator"):
        _kind = "classic"
    chat = AgentChat(
        user_id=user.id, title=(body.title or "").strip()[:160] or "Neuer Chat",
        provider_id=provider.id if provider else None,
        model=(body.model or (provider.default_model if provider else ""))[:160],
        write_mode=bool(body.write_mode),
        agent_id=body.agent_id,
        agent_key=(body.agent_key or "")[:60],
        kind=_kind,
    )
    db.add(chat)
    db.flush()
    db.add(AuditLog(actor=user.email, action="agent_chat_create", entity="agent_chat",
                    entity_id=str(chat.id), detail={"title": chat.title}))
    db.commit()
    db.refresh(chat)
    return _chat_out(db, chat)


class DispatchSubagentBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    task: str = Field(min_length=1, max_length=6000)
    role_title: str = Field(default="Temporärer Subagent", max_length=120)
    capabilities: list[str] = Field(default_factory=list)
    model: str = Field(default="", max_length=160)


class KnowledgeInsightBody(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    detail: str = Field(default="", max_length=4000)
    linked_keys: list[str] = Field(default_factory=list)
    severity: str = Field(default="info", max_length=32)


class KnowledgeInsightUpdateBody(BaseModel):
    title: str | None = Field(default=None, max_length=180)
    detail: str | None = Field(default=None, max_length=4000)
    linked_keys: list[str] | None = None
    severity: str | None = Field(default=None, max_length=32)


class KnowledgeEdgeBody(BaseModel):
    source_key: str = Field(min_length=1, max_length=160)
    target_key: str = Field(min_length=1, max_length=160)
    relation: str = Field(default="verknüpft_mit", max_length=60)


@router.get("/chats/{chat_id}/subagents")
def list_chat_subagents(
    chat_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Temporäre Subagenten EINES durchgängigen Orchestrator-Chats."""
    from .subagent_tools import CAPABILITY_CATALOG

    chat = _chat_for(db, user, chat_id)
    rows = (
        db.query(AgentSubagent)
        .filter(AgentSubagent.chat_id == chat.id)
        .order_by(AgentSubagent.id)
        .all()
    )
    items = []
    for row in rows:
        persona = db.get(AgentPersona, row.persona_id) if row.persona_id else None
        items.append({
            "subagent_id": row.id,
            "persona_id": row.persona_id,
            "name": row.name,
            "role_title": persona.role_title if persona else "Temporärer Subagent",
            "model": persona.preferred_model if persona else "",
            "task": row.task,
            "capabilities": list(row.capabilities or []),
            "used_calls": int(row.used_calls or 0),
            "status": row.status or "running",
            "result": row.result or "",
            "disposed": row.disposed_at is not None,
            "created_at": row.created_at,
            "last_used_at": row.last_used_at,
            "disposed_at": row.disposed_at,
        })
    return {
        "chat_id": chat.id,
        "subagents": items,
        "capabilities_catalog": CAPABILITY_CATALOG,
    }


@router.post("/chats/{chat_id}/subagents", status_code=201)
def create_chat_subagent(
    chat_id: int,
    body: DispatchSubagentBody,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Startet einen temporären Subagenten direkt aus der Orchestrator-Oberfläche."""
    from .subagent_tools import dispatch_subagent
    from .tools import ToolContext, ToolError

    chat = _chat_for(db, user, chat_id)
    try:
        return dispatch_subagent(
            ToolContext(db=db, user=user, chat=chat),
            {
                "name": body.name,
                "task": body.task,
                "role_title": body.role_title,
                "capabilities": body.capabilities,
                "model": body.model,
            },
        )
    except (ToolError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/chats/{chat_id}/subagents/{subagent_id}")
def remove_chat_subagent(
    chat_id: int,
    subagent_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Löscht einen temporären Subagenten samt seiner temporären Persona sofort."""
    from .subagent_tools import purge_subagent

    chat = _chat_for(db, user, chat_id)
    sub = db.get(AgentSubagent, subagent_id)
    if sub is None:
        return {"ok": True, "subagent_id": subagent_id, "deleted": True}
    if sub.chat_id != chat.id:
        raise HTTPException(status_code=404, detail="Subagent nicht in diesem Chat gefunden.")
    purge_subagent(db, sub)
    db.commit()
    return {"ok": True, "subagent_id": subagent_id, "deleted": True}


@router.get("/graph")
def get_knowledge_graph(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    kind: str = "",
    kinds: str = "",
    q: str = "",
    relation: str = "",
    focus: str = "",
    depth: int = 1,
    only_issues: bool = False,
    limit: int = 280,
) -> dict:
    """Liest den plattformweiten Wissensgraphen (baut ihn bei Bedarf initial auf)."""
    from .knowledge_graph import get_graph
    return get_graph(
        db,
        kind=kind,
        kinds=kinds,
        q=q,
        relation=relation,
        focus=focus,
        depth=depth,
        only_issues=only_issues,
        limit=limit,
    )


@router.get("/graph/path")
def get_knowledge_graph_path(
    source: str,
    target: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    max_depth: int = 6,
) -> dict:
    """Findet die kürzeste Wirkungskette zwischen zwei Knoten im Wissensgraphen."""
    from .knowledge_graph import find_shortest_path
    try:
        return find_shortest_path(db, source, target, max_depth=max_depth)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/graph/rebuild")
def rebuild_knowledge_graph_endpoint(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Synchronisiert den Wissensgraphen sofort aus allen Plattform-Modulen."""
    from .knowledge_graph import get_graph, rebuild_platform_graph
    summary = rebuild_platform_graph(db)
    return {"summary": summary, "graph": get_graph(db)}


@router.post("/graph/insights", status_code=201)
def create_knowledge_insight(
    body: KnowledgeInsightBody,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Verknüpft eine neue Erkenntnis im Wissensgraphen."""
    from .knowledge_graph import add_insight
    from .tools import ToolError
    try:
        return add_insight(
            db,
            title=body.title,
            detail=body.detail,
            linked_keys=body.linked_keys,
            author=user.email,
            severity=body.severity,
        )
    except (ToolError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/graph/insights/{node_key:path}")
def update_knowledge_insight_endpoint(
    node_key: str,
    body: KnowledgeInsightUpdateBody,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Bearbeitet eine gespeicherte Erkenntnis im Wissensgraphen."""
    from .knowledge_graph import update_insight
    try:
        return update_insight(
            db,
            node_key,
            title=body.title,
            detail=body.detail,
            severity=body.severity,
            linked_keys=body.linked_keys,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/graph/edges", status_code=201)
def create_knowledge_edge(
    body: KnowledgeEdgeBody,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Verbindet zwei Knoten dauerhaft mit einer benutzerdefinierten Relation."""
    from .knowledge_graph import add_custom_edge
    try:
        return add_custom_edge(
            db,
            source_key=body.source_key,
            target_key=body.target_key,
            relation=body.relation,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/graph/edges/{edge_id}")
def delete_knowledge_edge(
    edge_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Löscht eine manuelle Kante aus dem Wissensgraphen."""
    from .knowledge_graph import delete_edge
    try:
        return delete_edge(db, edge_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/graph/nodes/{node_key:path}")
def delete_knowledge_node(
    node_key: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Löscht einen manuellen/Erkenntnis-Knoten aus dem Wissensgraphen."""
    from .knowledge_graph import delete_node
    return delete_node(db, node_key)


@router.get("/chats/{chat_id}")
def get_chat(
    chat_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    chat = _chat_for(db, user, chat_id)
    messages = (
        db.query(AgentMessage)
        .filter(AgentMessage.chat_id == chat.id, AgentMessage.hidden_at.is_(None))
        .order_by(AgentMessage.id).all()
    )
    attachments = (
        db.query(AgentAttachment).filter(AgentAttachment.chat_id == chat.id)
        .order_by(AgentAttachment.id).all()
    )
    by_message: dict[int, list[AgentAttachment]] = {}
    pending: list[AgentAttachment] = []
    for attachment in attachments:
        if attachment.message_id is None:
            pending.append(attachment)
        else:
            by_message.setdefault(attachment.message_id, []).append(attachment)
    changes = (
        db.query(AgentChange).filter(AgentChange.chat_id == chat.id)
        .order_by(AgentChange.id.desc()).all()
    )
    from .artifact_tools import artifact_out

    artifacts = (
        db.query(AgentArtifact).filter(AgentArtifact.chat_id == chat.id)
        .order_by(AgentArtifact.updated_at.desc(), AgentArtifact.id.desc())
        .limit(100)
        .all()
    )
    return {"chat": _chat_out(db, chat),
            "messages": [_message_out(m, by_message.get(m.id)) for m in messages],
            "attachments": [file_service.out(a) for a in pending],
            "changes": [_change_out(c) for c in changes],
            "artifacts": [artifact_out(a) for a in artifacts]}


@router.patch("/chats/{chat_id}")
def update_chat(
    chat_id: int,
    body: ChatUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    chat = _chat_for(db, user, chat_id)
    if body.title is not None:
        chat.title = body.title.strip()[:160] or "Neuer Chat"
    if body.provider_id is not None:
        provider = _provider_for(db, user, body.provider_id)
        chat.provider_id = provider.id
    if body.model is not None:
        chat.model = body.model.strip()[:160]
    if body.write_mode is not None:
        chat.write_mode = bool(body.write_mode)
        db.add(AuditLog(
            actor=user.email, action="agent_chat_write_mode", entity="agent_chat",
            entity_id=str(chat.id), detail={"write_mode": chat.write_mode},
        ))
    if body.agent_id is not None:
        chat.agent_id = body.agent_id or None
        if body.agent_id:
            chat.agent_key = ""
    if body.agent_key is not None:
        chat.agent_key = body.agent_key.strip()[:60]
        if chat.agent_key:
            chat.agent_id = None
    _kind_upd = body.kind or body.chat_type or body.chat_kind or body.mode
    if _kind_upd is not None:
        _k = _kind_upd.strip().lower()
        if _k in ("classic", "orchestrator"):
            chat.kind = _k
    db.commit()
    db.refresh(chat)
    return _chat_out(db, chat)


@router.post("/chats/{chat_id}/clear")
def clear_chat(
    chat_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Nachrichten eines durchgängigen Chats leeren, den Chat aber behalten.

    Der Orchestrator-Chat bleibt bestehen (seine Identität und Einstellungen),
    nur der sichtbare Verlauf wird zurückgesetzt. Temporäre Subagenten werden
    dabei entsorgt.
    """
    chat = _chat_for(db, user, chat_id)
    now = _now()
    hidden = (
        db.query(AgentMessage)
        .filter(AgentMessage.chat_id == chat.id, AgentMessage.hidden_at.is_(None))
        .update({AgentMessage.hidden_at: now}, synchronize_session=False)
    )
    from .subagent_tools import purge_subagent
    subs = db.query(AgentSubagent).filter(AgentSubagent.chat_id == chat.id).all()
    for sub in subs:
        purge_subagent(db, sub)
    chat.last_message_at = None
    db.add(AuditLog(actor=user.email, action="agent_chat_clear", entity="agent_chat",
                    entity_id=str(chat.id), detail={"hidden": int(hidden or 0)}))
    db.commit()
    return {"id": chat.id, "cleared": int(hidden or 0), "subagents_disposed": len(subs)}


@router.delete("/chats/{chat_id}")
def delete_chat(
    chat_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from .subagent_tools import purge_subagent
    chat = _chat_for(db, user, chat_id)
    for sub in db.query(AgentSubagent).filter(AgentSubagent.chat_id == chat.id).all():
        purge_subagent(db, sub)
    sandbox_service.destroy_sandbox(chat.id)
    chat.deleted_at = _now()
    db.add(AuditLog(actor=user.email, action="agent_chat_delete", entity="agent_chat",
                    entity_id=str(chat.id), detail={"title": chat.title}))
    db.commit()
    return {"id": chat.id, "deleted": True}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


@router.post("/chats/{chat_id}/attachments", status_code=201)
async def upload_attachment(
    chat_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    file: UploadFile = File(...),
    password: str = Form(""),
    pages: str = Form(""),
) -> dict:
    chat = _chat_for(db, user, chat_id)
    max_bytes = max(1, agent_settings.get_int(db, "agent_attach_max_mb")) * 1024 * 1024
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Die Datei ist größer als {max_bytes // (1024 * 1024)} MB.",
            )
        chunks.append(chunk)
    try:
        row = file_service.store(
            db, chat, user, file.filename or "anhang",
            file.content_type or "", b"".join(chunks),
            password=password[:200], pages=pages[:200],
        )
    except file_service.AttachmentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return file_service.out(row)


@router.delete("/chats/{chat_id}/attachments/{attachment_id}")
def delete_attachment(
    chat_id: int,
    attachment_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    chat = _chat_for(db, user, chat_id)
    row = db.get(AgentAttachment, attachment_id)
    if row is None or row.chat_id != chat.id or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="Anhang nicht gefunden.")
    if row.message_id is not None:
        raise HTTPException(status_code=409, detail="Angehängte Dateien bleiben am Chat.")
    db.delete(row)
    db.commit()
    return {"id": attachment_id, "deleted": True}


@router.post("/chats/{chat_id}/messages")
async def post_message(
    chat_id: int,
    body: MessageIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
):
    chat = _chat_for(db, user, chat_id)
    if not body.content.strip():
        raise HTTPException(status_code=422, detail="Die Nachricht ist leer.")
    if body.attachment_ids:
        rows = (
            db.query(AgentAttachment)
            .filter(AgentAttachment.id.in_(body.attachment_ids),
                    AgentAttachment.chat_id == chat.id,
                    AgentAttachment.user_id == user.id,
                    AgentAttachment.message_id.is_(None))
            .all()
        )
        if len(rows) != len(set(body.attachment_ids)):
            raise HTTPException(status_code=422, detail="Unbekannter oder bereits verwendeter Anhang.")
    async with ACTIVE_LOCK:
        if chat.id in ACTIVE:
            raise HTTPException(status_code=409, detail="In diesem Chat läuft bereits eine Antwort.")
        cancel = asyncio.Event()
        ACTIVE[chat.id] = cancel

    async def events():
        try:
            async for event in run_stream(
                chat_id=chat.id, user_id=user.id, prompt=body.content.strip(),
                route=body.route, cancel_event=cancel,
                context=page_context.sanitize(body.context),
                attachment_ids=body.attachment_ids, hands_free=body.hands_free,
                max_steps_override=body.max_steps,
            ):
                yield _sse(event.get("type", "message"), event)
        finally:
            async with ACTIVE_LOCK:
                ACTIVE.pop(chat.id, None)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Content-Security-Policy": "default-src 'none'",
        },
    )


@router.post("/chats/{chat_id}/cancel")
async def cancel_chat(
    chat_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    _chat_for(db, user, chat_id)
    async with ACTIVE_LOCK:
        event = ACTIVE.get(chat_id)
    if event is None:
        return {"cancelled": False}
    event.set()
    return {"cancelled": True}


# --------------------------------------------------------------------------
# Änderungen und Werkzeuge
# --------------------------------------------------------------------------
@router.get("/changes")
def list_changes(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    chat_id: int | None = None,
    status_filter: str = "",
) -> dict:
    query = db.query(AgentChange).filter(AgentChange.user_id == user.id)
    if chat_id is not None:
        query = query.filter(AgentChange.chat_id == chat_id)
    if status_filter:
        query = query.filter(AgentChange.status == status_filter)
    rows = query.order_by(AgentChange.id.desc()).limit(200).all()
    return {"changes": [_change_out(c) for c in rows]}


@router.post("/changes/{change_id}/revert")
def revert_any_change(
    change_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    change = db.get(AgentChange, change_id)
    if change is None:
        raise HTTPException(status_code=404, detail="Änderung nicht gefunden.")
    if change.user_id != user.id and not (has_admin_work(user) or user.role == Role.staff):
        raise HTTPException(status_code=404, detail="Änderung nicht gefunden.")
    try:
        revert(db, change, user)
        db.commit()
    except RevertConflict as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    db.refresh(change)
    return _change_out(change)


@router.post("/chats/{chat_id}/changes/{change_id}/revert")
def revert_change(
    chat_id: int,
    change_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    _chat_for(db, user, chat_id)
    change = db.get(AgentChange, change_id)
    if change is None or change.chat_id != chat_id or change.user_id != user.id:
        raise HTTPException(status_code=404, detail="Änderung nicht gefunden.")
    try:
        revert(db, change, user)
        db.commit()
    except RevertConflict as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    db.refresh(change)
    return _change_out(change)


@router.post("/chats/{chat_id}/messages/{message_id}/revert")
def revert_message(
    chat_id: int,
    message_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    _chat_for(db, user, chat_id)
    message = db.get(AgentMessage, message_id)
    if message is None or message.chat_id != chat_id:
        raise HTTPException(status_code=404, detail="Nachricht nicht gefunden.")
    changes = (
        db.query(AgentChange)
        .filter(AgentChange.message_id == message_id,
                AgentChange.user_id == user.id,
                AgentChange.status == "applied")
        .order_by(AgentChange.id.desc())
        .all()
    )
    if not changes:
        raise HTTPException(status_code=422, detail="Diese Nachricht hat keine offenen Änderungen.")
    reverted = []
    try:
        for change in changes:
            revert(db, change, user)
            reverted.append(change)
        db.commit()
    except RevertConflict as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"reverted": len(reverted),
            "changes": [_change_out(c) for c in reverted]}


# --------------------------------------------------------------------------
# Neu erzeugen / bearbeiten und erneut senden (task 36 D)
# --------------------------------------------------------------------------
class RewindIn(BaseModel):
    message_id: int


@router.post("/chats/{chat_id}/rewind")
async def rewind_chat(
    chat_id: int,
    body: RewindIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Eine Nutzerfrage und alles danach ausblenden — nicht löschen.

    Danach schickt die Oberfläche dieselbe (neu erzeugen) oder eine geänderte
    Frage (bearbeiten). Die Anhänge der Frage werden wieder frei, damit sie
    mitgehen. Änderungen, die der ausgeblendete Teil schon gemacht hat, bleiben
    im Register und werden **nicht** zurückgenommen; die Antwort nennt sie.
    """
    chat = _chat_for(db, user, chat_id)
    async with ACTIVE_LOCK:
        if chat.id in ACTIVE:
            raise HTTPException(status_code=409, detail="In diesem Chat läuft gerade eine Antwort.")
        # Belegt halten, bis die Ausblendung bestätigt ist: sonst könnte eine
        # gleichzeitig gestartete Antwort ihre eigene Frage verlieren.
        ACTIVE[chat.id] = asyncio.Event()
    try:
        return _rewind(db, user, chat, body.message_id)
    finally:
        async with ACTIVE_LOCK:
            ACTIVE.pop(chat.id, None)


def _rewind(db: Session, user: User, chat: AgentChat, message_id: int) -> dict:
    message = db.get(AgentMessage, message_id)
    if (message is None or message.chat_id != chat.id or message.role != "user"
            or message.hidden_at is not None):
        raise HTTPException(status_code=404, detail="Frage nicht gefunden.")
    rows = (
        db.query(AgentMessage)
        .filter(AgentMessage.chat_id == chat.id, AgentMessage.id >= message.id,
                AgentMessage.hidden_at.is_(None))
        .all()
    )
    ids = [r.id for r in rows]
    now = _now()
    for row in rows:
        row.hidden_at = now
    attachments = (
        db.query(AgentAttachment)
        .filter(AgentAttachment.message_id == message.id, AgentAttachment.chat_id == chat.id)
        .all()
    )
    for attachment in attachments:
        attachment.message_id = None
    open_changes = (
        db.query(AgentChange)
        .filter(AgentChange.message_id.in_(ids), AgentChange.status == "applied")
        .count()
    ) if ids else 0
    db.add(AuditLog(actor=user.email, action="agent_chat_rewind", entity="agent_chat",
                    entity_id=str(chat.id),
                    detail={"from_message": message.id, "hidden": len(ids),
                            "open_changes": open_changes}))
    db.commit()
    return {"content": message.content or "", "hidden": len(ids),
            "attachment_ids": [a.id for a in attachments],
            "attachments": [file_service.out(a) for a in attachments],
            "open_changes": open_changes}


# --------------------------------------------------------------------------
# Vorlagen (task 36 E)
# --------------------------------------------------------------------------
MAX_PROMPTS_PER_USER = 100

#: Schnellstarts je Rolle — fest im Code, nicht in der Datenbank.
BUILTIN_PROMPTS: list[dict] = [
    {"key": "today", "title": "Was brennt heute?",
     "text": "Was ist heute dringend? Fällige und überfällige Aufträge, gesperrte Aufträge, "
             "Engpässe in der Halle und offene Sendungen — kurz, nach Dringlichkeit sortiert.",
     "roles": ["worker", "staff", "admin"]},
    {"key": "bottleneck", "title": "Engpass der Halle",
     "text": "Wo ist der Engpass in der Halle? Nutze die Zwillingsanalyse und die Stationslast "
             "und schlage zwei konkrete Verlagerungen vor (nichts ausführen).",
     "roles": ["worker", "staff", "admin"]},
    {"key": "kpis", "title": "Kennzahlen 30 Tage",
     "text": "Fasse die Kennzahlen der letzten 30 Tage zusammen: Durchsatz, Durchlaufzeit, "
             "Termintreue, Materialausnutzung. Was ist auffällig?",
     "roles": ["worker", "staff", "admin"]},
    {"key": "material", "title": "Materialbedarf",
     "text": "Welcher Werkstoff wird für die wartenden Positionen knapp? Zeige Bedarf, Bestand "
             "und was nachbestellt werden sollte.",
     "roles": ["worker", "staff", "admin"]},
    {"key": "dispatch", "title": "Disposition vorschlagen",
     "text": "Was würde die Disposition als Nächstes zuordnen? Liste die Vorschläge mit Grund; "
             "nichts anwenden.",
     "roles": ["staff", "admin"]},
    {"key": "quote", "title": "Preis ohne Auftrag",
     "text": "Rechne einen Preis ohne Auftrag: 50 Dichtungen EPDM 70, 2 mm, Ø 162 / 115 mm. "
             "Prüfe vorher, ob das Teil fertigbar ist.",
     "roles": ["staff", "admin"]},
    {"key": "trace", "title": "Auftrag verfolgen",
     "text": "Verfolge den Auftrag {Auftragsnummer}: wo steht er, welche Innenaufträge, "
             "welche Station, wann ist er fertig?",
     "roles": ["worker", "staff", "admin"]},
    {"key": "fleet", "title": "Roboterflotte planen",
     "text": "Wie viele Transportroboter braucht die erste Ebene? Simuliere 1 bis 3 Roboter "
             "und vergleiche die Wartezeiten.",
     "roles": ["staff", "admin"]},
    {"key": "aging", "title": "Auftrags-Engpässe & SLA",
     "text": "Analysiere alle offenen Aufträge nach Altersklasse (<1d, 1–3d, 3–7d, >7d) und zeige "
             "überfällige sowie in 48 Stunden gefährdete Liefertermine mit Handlungsempfehlungen.",
     "roles": ["worker", "staff", "admin"]},
    {"key": "revenue", "title": "Umsatz- & Monatsvergleich",
     "text": "Aggregiere den Umsatz nach Monaten und nenne die Top-10-Kunden sowie die wichtigsten "
             "Werkstoffe nach Auftragszahl.",
     "roles": ["staff", "admin"]},
    {"key": "forecast", "title": "Bestandsreichweite & Einkauf",
     "text": "Rechne die Bestandsreichweite in Tagen aus Verbrauch, offenem Bedarf, Lieferzeit und "
             "Reststücken. Welche Werkstoffe sollten jetzt nachbestellt werden?",
     "roles": ["worker", "staff", "admin"]},
    {"key": "ar", "title": "Offene Forderungen / Mahnwesen",
     "text": "Zeige alle offenen und überfälligen Rechnungen nach Altersstruktur (1–14, 15–30, "
             "31–60, >60 Tage) und nenne die dringendsten offenen Posten.",
     "roles": ["staff", "admin"]},
]


class PromptIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=4000)
    shared: bool = False


class PromptUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    text: str | None = Field(default=None, min_length=1, max_length=4000)
    shared: bool | None = None


def _prompt_out(row: AgentPrompt, user: User) -> dict:
    return {"id": row.id, "title": row.title, "text": row.text or "", "shared": row.shared,
            "own": row.user_id == user.id,
            "editable": row.user_id == user.id or (row.shared and _admin(user)),
            "updated_at": row.updated_at}


def _prompt_for_write(db: Session, user: User, prompt_id: int) -> AgentPrompt:
    row = db.get(AgentPrompt, prompt_id)
    if row is None or not (row.user_id == user.id or row.shared):
        raise HTTPException(status_code=404, detail="Vorlage nicht gefunden.")
    if row.user_id != user.id and not _admin(user):
        raise HTTPException(status_code=403, detail="Fremde Vorlagen ändert nur ein Admin.")
    return row


@router.get("/prompts")
def list_prompts(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    rows = (
        db.query(AgentPrompt)
        .filter((AgentPrompt.user_id == user.id) | (AgentPrompt.shared.is_(True)))
        .order_by(AgentPrompt.title, AgentPrompt.id)
        .limit(300).all()
    )
    role = user.role.value if hasattr(user.role, "value") else str(user.role)
    return {
        "prompts": [_prompt_out(r, user) for r in rows],
        "builtin": [{k: v for k, v in p.items() if k != "roles"}
                    for p in BUILTIN_PROMPTS if role in p["roles"]],
        "can_share": _admin(user),
    }


@router.post("/prompts", status_code=201)
def create_prompt(
    body: PromptIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if body.shared and not _admin(user):
        raise HTTPException(status_code=403, detail="Teilen darf nur ein Admin.")
    count = db.query(func.count(AgentPrompt.id)).filter(AgentPrompt.user_id == user.id).scalar()
    if count >= MAX_PROMPTS_PER_USER:
        raise HTTPException(status_code=409,
                            detail=f"Höchstens {MAX_PROMPTS_PER_USER} Vorlagen je Konto.")
    row = AgentPrompt(user_id=user.id, title=body.title.strip(), text=body.text.strip(),
                      shared=bool(body.shared))
    db.add(row)
    db.flush()
    _audit(db, user, "agent_prompt_create", row.id, {"shared": row.shared},
           entity="agent_prompt")
    db.commit()
    db.refresh(row)
    return _prompt_out(row, user)


@router.put("/prompts/{prompt_id}")
def update_prompt(
    prompt_id: int,
    body: PromptUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    row = _prompt_for_write(db, user, prompt_id)
    if body.shared is not None and body.shared != row.shared and not _admin(user):
        raise HTTPException(status_code=403, detail="Teilen darf nur ein Admin.")
    if body.title is not None:
        row.title = body.title.strip()
    if body.text is not None:
        row.text = body.text.strip()
    if body.shared is not None:
        row.shared = bool(body.shared)
    _audit(db, user, "agent_prompt_update", row.id, {"shared": row.shared},
           entity="agent_prompt")
    db.commit()
    db.refresh(row)
    return _prompt_out(row, user)


@router.delete("/prompts/{prompt_id}")
def delete_prompt(
    prompt_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    row = _prompt_for_write(db, user, prompt_id)
    _audit(db, user, "agent_prompt_delete", row.id, {"shared": row.shared},
           entity="agent_prompt")
    db.delete(row)
    db.commit()
    return {"id": prompt_id, "deleted": True}


class ToolInvokeIn(BaseModel):
    arguments: dict = Field(default_factory=dict)


@router.post("/chats/{chat_id}/tools/{name}")
def invoke_tool(
    chat_id: int,
    name: str,
    body: ToolInvokeIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Ein Werkzeug von Hand ausführen — zum Prüfen der Werkzeugkette.

    Der Chat liefert die Schreibfreigabe und das Änderungsregister. Lesende
    Werkzeuge laufen immer; schreibende nur, wenn der Chat sie erlaubt.
    """
    from .tools import TOOLS, ToolContext, ToolError, execute_tool, allowed

    chat = _chat_for(db, user, chat_id)
    spec = TOOLS.get(name)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unbekanntes Werkzeug „{name}“.")
    if not allowed(spec, user):
        raise HTTPException(status_code=403, detail="Für dieses Werkzeug fehlt die Berechtigung.")
    if spec.write and not chat.write_mode:
        raise HTTPException(
            status_code=409,
            detail="Schreibzugriffe sind für diesen Chat ausgeschaltet.",
        )
    try:
        result = execute_tool(
            ToolContext(db=db, user=user, chat=chat), name, body.arguments,
            write_mode=chat.write_mode,
        )
    except ToolError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return result


@router.get("/tools")
def list_tools(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    web_enabled = agent_settings.get_bool(db, "agent_web_enabled")
    sandbox_enabled = agent_settings.get_bool(db, "agent_sandbox_enabled")
    return {
        "tools": public_catalog(user, web_enabled=web_enabled, sandbox_enabled=sandbox_enabled),
        "web_enabled": web_enabled,
        "sandbox_enabled": sandbox_enabled,
    }


# --------------------------------------------------------------------------
# Aktionsvorschläge (Staged Governance: Entwerfen → 1-Klick-Freigabe → Audit)
# --------------------------------------------------------------------------
class ProposalDecisionIn(BaseModel):
    note: str = Field("", max_length=400)


def _proposal_out(row: AgentActionProposal) -> dict:
    return {
        "id": row.id,
        "chat_id": row.chat_id,
        "message_id": row.message_id,
        "alert_id": row.alert_id,
        "kind": row.kind,
        "title": row.title,
        "rationale": row.rationale or "",
        "tool_name": row.tool_name,
        "arguments": row.arguments or {},
        "impact_summary": row.impact_summary or {},
        "status": row.status,
        "decided_by": row.decided_by,
        "decided_at": row.decided_at.isoformat() if row.decided_at else None,
        "decision_note": row.decision_note,
        "change_id": row.change_id,
        "result_summary": row.result_summary,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.get("/proposals")
def list_proposals(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
    status: str = "pending",
    limit: int = 80,
) -> dict:
    q = db.query(AgentActionProposal)
    if status and status != "all":
        wanted = [s.strip() for s in status.split(",") if s.strip()]
        q = q.filter(AgentActionProposal.status.in_(wanted))
    rows = q.order_by(AgentActionProposal.created_at.desc(), AgentActionProposal.id.desc()).limit(max(1, min(200, limit))).all()
    pending_count = db.query(AgentActionProposal).filter(AgentActionProposal.status == "pending").count()
    return {"proposals": [_proposal_out(r) for r in rows], "pending_count": pending_count}


@router.post("/proposals/{proposal_id}/approve")
def approve_proposal(
    proposal_id: int,
    body: ProposalDecisionIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    from .tools import TOOLS, ToolContext, ToolError, allowed, execute_tool

    row = db.get(AgentActionProposal, proposal_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Aktionsvorschlag nicht gefunden.")
    if row.status != "pending":
        raise HTTPException(status_code=409, detail=f"Vorschlag steht bereits auf „{row.status}“.")
    spec = TOOLS.get(row.tool_name)
    if spec is None:
        raise HTTPException(status_code=422, detail=f"Unbekanntes Zielwerkzeug „{row.tool_name}“.")
    if not allowed(spec, user):
        raise HTTPException(status_code=403, detail="Für die Ausführung dieses Vorschlags fehlt die Berechtigung.")

    claimed = (
        db.query(AgentActionProposal)
        .filter(AgentActionProposal.id == proposal_id, AgentActionProposal.status == "pending")
        .update({"status": "executing"}, synchronize_session=False)
    )
    db.commit()
    if claimed != 1:
        db.expire_all()
        cur = db.get(AgentActionProposal, proposal_id)
        cur_status = cur.status if cur else "unbekannt"
        raise HTTPException(status_code=409, detail=f"Vorschlag steht bereits auf „{cur_status}“.")
    row = db.get(AgentActionProposal, proposal_id)
    assert row is not None

    chat = db.get(AgentChat, row.chat_id) if row.chat_id else None
    try:
        result = execute_tool(
            ToolContext(db=db, user=user, chat=chat, message_id=row.message_id),
            row.tool_name,
            dict(row.arguments or {}),
            write_mode=True,
        )
    except ToolError as exc:
        row.status = "failed"
        row.decided_by = user.email
        row.decided_at = _now()
        row.decision_note = body.note
        row.result_summary = str(exc)[:400]
        db.commit()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        row = db.get(AgentActionProposal, proposal_id)
        if row is not None:
            row.status = "failed"
            row.decided_by = user.email
            row.decided_at = _now()
            row.decision_note = body.note
            row.result_summary = str(exc)[:400]
            db.commit()
        raise

    row.status = "approved"
    row.decided_by = user.email
    row.decided_at = _now()
    row.decision_note = body.note
    row.change_id = result.get("change_id")
    row.result_summary = str(result.get("summary") or "Ausgeführt.")[:400]
    _audit(
        db, user, "agent_proposal_approve", row.id,
        {"tool": row.tool_name, "change_id": row.change_id, "summary": row.result_summary[:200]},
        entity="agent_proposal",
    )
    db.commit()
    return {"proposal": _proposal_out(row), "result": result}


@router.post("/proposals/{proposal_id}/reject")
def reject_proposal(
    proposal_id: int,
    body: ProposalDecisionIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    row = db.get(AgentActionProposal, proposal_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Aktionsvorschlag nicht gefunden.")
    if row.status != "pending":
        raise HTTPException(status_code=409, detail=f"Vorschlag steht bereits auf „{row.status}“.")
    row.status = "rejected"
    row.decided_by = user.email
    row.decided_at = _now()
    row.decision_note = body.note
    _audit(
        db, user, "agent_proposal_reject", row.id,
        {"tool": row.tool_name, "note": body.note[:200]},
        entity="agent_proposal",
    )
    db.commit()
    return {"proposal": _proposal_out(row)}


# --------------------------------------------------------------------------
# Sprachausgabe (leichtes neuronales TTS, kein Modell im Haus)
# --------------------------------------------------------------------------
class SpeechIn(BaseModel):
    text: str = Field(min_length=1, max_length=6000)
    voice: str = ""
    rate: float = Field(1.0, ge=0.8, le=1.4)


class PiperInstallIn(BaseModel):
    accept_gpl: bool = False
    voice: str = speech_service.PIPER_DEFAULT


def _tts_backend(db: Session) -> str:
    value = agent_settings.get(db, "agent_tts_backend")
    return value if value in speech_service.BACKENDS else speech_service.DEFAULT_BACKEND


@router.get("/speech/piper-status")
def piper_status_endpoint(
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    return speech_service.piper_status()


@router.post("/speech/piper-install")
async def piper_install_endpoint(
    body: PiperInstallIn,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(require_admin)],
) -> dict:
    if not body.accept_gpl:
        raise HTTPException(
            status_code=400,
            detail="Bitte bestätigen Sie das Opt-In für Piper TTS (GPL-3.0).",
        )
    try:
        status_data = await asyncio.to_thread(speech_service.install_piper, body.voice)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    agent_settings.set_value(db, "agent_tts_backend", "lokal", actor.email)
    db.add(
        AuditLog(
            actor=actor.email,
            action="piper_tts_opt_in",
            entity="settings",
            entity_id="agent_tts_backend",
            detail={"voice": body.voice, "ready": status_data.get("ready", False)},
        )
    )
    db.commit()
    return status_data


@router.get("/speech")
def speech_info(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    backend = _tts_backend(db)
    return {
        "available": speech_service.available(backend),
        "backend": backend,
        "default_voice": speech_service.default_voice(backend),
        "voices": [{"id": key, "name": name} for key, name in speech_service.voices(backend).items()],
    }


@router.post("/speech")
async def speak(
    body: SpeechIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> Response:
    backend = _tts_backend(db)
    db.close()  # die Synthese dauert; keine Verbindung währenddessen halten
    try:
        extra = {"rate": body.rate} if abs(body.rate - 1.0) > 1e-6 else {}
        audio = await speech_service.synthesize(body.text, body.voice, backend, **extra)
    except speech_service.SpeechUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(
        content=audio,
        media_type=speech_service.media_type(backend),
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.get("/chats/{chat_id}/attachments/{attachment_id}/content")
def preview_attachment(
    chat_id: int,
    attachment_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    chat = _chat_for(db, user, chat_id)
    row = db.get(AgentAttachment, attachment_id)
    if row is None or row.chat_id != chat.id or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="Anhang nicht gefunden.")
    return file_service.preview_out(row)


# --------------------------------------------------------------------------
# Artefakte & Web-Vorschau (Seiten-Vorschaufenster)
# --------------------------------------------------------------------------
class ArtifactCreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    kind: str = Field(default="html", max_length=30)
    content: str = Field(default="", max_length=400_000)
    filename: str = Field(default="", max_length=240)
    language: str = Field(default="", max_length=40)


class ArtifactUpdateIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    kind: str | None = Field(default=None, max_length=30)
    content: str | None = Field(default=None, max_length=400_000)
    filename: str | None = Field(default=None, max_length=240)
    language: str | None = Field(default=None, max_length=40)


@router.get("/chats/{chat_id}/artifacts")
def list_chat_artifacts(
    chat_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from .artifact_tools import artifact_out

    chat = _chat_for(db, user, chat_id)
    rows = (
        db.query(AgentArtifact)
        .filter(AgentArtifact.chat_id == chat.id)
        .order_by(AgentArtifact.updated_at.desc(), AgentArtifact.id.desc())
        .limit(100)
        .all()
    )
    return {"artifacts": [artifact_out(r) for r in rows]}


@router.post("/chats/{chat_id}/artifacts", status_code=201)
def create_chat_artifact(
    chat_id: int,
    body: ArtifactCreateIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from .artifact_tools import VALID_KINDS, _default_filename, artifact_out

    chat = _chat_for(db, user, chat_id)
    kind = body.kind.strip().lower() or "html"
    if kind not in VALID_KINDS:
        raise HTTPException(status_code=422, detail=f"Unbekannter Artefakt-Typ „{kind}“.")
    row = AgentArtifact(
        chat_id=chat.id,
        user_id=user.id,
        title=body.title.strip()[:200],
        kind=kind,
        filename=body.filename.strip()[:240] or _default_filename(body.title, kind, body.language),
        language=body.language.strip()[:40],
        content=body.content,
        version=1,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return artifact_out(row)


@router.put("/chats/{chat_id}/artifacts/{artifact_id}")
def update_chat_artifact(
    chat_id: int,
    artifact_id: int,
    body: ArtifactUpdateIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from .artifact_tools import VALID_KINDS, artifact_out

    chat = _chat_for(db, user, chat_id)
    row = db.get(AgentArtifact, artifact_id)
    if row is None or row.chat_id != chat.id:
        raise HTTPException(status_code=404, detail="Artefakt nicht gefunden.")
    if body.title is not None:
        row.title = body.title.strip()[:200] or row.title
    if body.kind is not None:
        k = body.kind.strip().lower()
        if k not in VALID_KINDS:
            raise HTTPException(status_code=422, detail=f"Unbekannter Artefakt-Typ „{k}“.")
        row.kind = k
    if body.filename is not None:
        row.filename = body.filename.strip()[:240]
    if body.language is not None:
        row.language = body.language.strip()[:40]
    if body.content is not None:
        row.content = body.content
        row.version = (row.version or 1) + 1
    row.updated_at = _now()
    db.commit()
    db.refresh(row)
    return artifact_out(row)


@router.delete("/chats/{chat_id}/artifacts/{artifact_id}")
def delete_chat_artifact(
    chat_id: int,
    artifact_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    chat = _chat_for(db, user, chat_id)
    row = db.get(AgentArtifact, artifact_id)
    if row is None or row.chat_id != chat.id:
        raise HTTPException(status_code=404, detail="Artefakt nicht gefunden.")
    db.delete(row)
    db.commit()
    return {"id": artifact_id, "deleted": True}


@router.get("/preview/web")
def preview_web(
    url: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Öffentliche Webseite sicher abrufen für den Seiten-Vorschaubrowser (Proxy/Lesemodus)."""
    if not agent_settings.get_bool(db, "agent_web_enabled"):
        raise HTTPException(status_code=409, detail="Die Websuche ist in den Einstellungen ausgeschaltet.")
    try:
        return websearch.fetch_preview(db, url)
    except websearch.WebSearchError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Webseite konnte nicht geladen werden: {exc}") from exc


# --------------------------------------------------------------------------
# Globale Artefakt-Bibliothek (alle Chats des Kontos)
# --------------------------------------------------------------------------
class StandaloneArtifactCreateIn(ArtifactCreateIn):
    chat_id: int | None = None


def _artifact_for_user(db: Session, user: User, artifact_id: int) -> tuple[AgentArtifact, AgentChat]:
    row = db.get(AgentArtifact, artifact_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Artefakt nicht gefunden.")
    chat = db.get(AgentChat, row.chat_id)
    if chat is None or chat.user_id != user.id or chat.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Artefakt nicht gefunden.")
    return row, chat


@router.get("/artifacts")
def list_all_artifacts(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    kind: str = "",
    chat_id: int | None = None,
    q: str = "",
    limit: int = 100,
) -> dict:
    from .artifact_tools import artifact_out

    query = (
        db.query(AgentArtifact, AgentChat.title)
        .join(AgentChat, AgentArtifact.chat_id == AgentChat.id)
        .filter(AgentChat.user_id == user.id, AgentChat.deleted_at.is_(None))
    )
    if kind and kind != "all":
        query = query.filter(AgentArtifact.kind == kind.strip().lower())
    if chat_id is not None:
        query = query.filter(AgentArtifact.chat_id == chat_id)
    rows = (
        query.order_by(AgentArtifact.updated_at.desc(), AgentArtifact.id.desc())
        .limit(max(1, min(limit, 200)))
        .all()
    )
    needle = q.strip().lower()
    items = []
    for art, chat_title in rows:
        if needle and needle not in f"{art.title} {art.filename} {art.kind} {chat_title or ''}".lower():
            continue
        item = artifact_out(art, include_content=True)
        item["chat_title"] = chat_title or "Chat"
        items.append(item)
    return {"artifacts": items, "total": len(items)}


@router.get("/artifacts/{artifact_id}")
def get_one_artifact(
    artifact_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from .artifact_tools import artifact_out

    row, chat = _artifact_for_user(db, user, artifact_id)
    data = artifact_out(row, include_content=True)
    data["chat_title"] = chat.title or "Chat"
    return data


@router.post("/artifacts", status_code=201)
def create_standalone_artifact(
    body: StandaloneArtifactCreateIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from .artifact_tools import VALID_KINDS, _default_filename, artifact_out

    if body.chat_id is not None:
        chat = _chat_for(db, user, body.chat_id)
    else:
        chat = (
            db.query(AgentChat)
            .filter(AgentChat.user_id == user.id, AgentChat.deleted_at.is_(None))
            .order_by(func.coalesce(AgentChat.last_message_at, AgentChat.updated_at).desc())
            .first()
        )
        if chat is None:
            provider = (
                db.query(AgentProvider)
                .filter(AgentProvider.enabled.is_(True))
                .order_by(AgentProvider.is_default.desc(), AgentProvider.id)
                .first()
            )
            chat = AgentChat(
                user_id=user.id,
                title="Artefakte",
                provider_id=provider.id if provider else None,
                model=(provider.default_model if provider else "")[:160],
                write_mode=False,
            )
            db.add(chat)
            db.flush()
    kind = body.kind.strip().lower() or "html"
    if kind not in VALID_KINDS:
        raise HTTPException(status_code=422, detail=f"Unbekannter Artefakt-Typ „{kind}“.")
    row = AgentArtifact(
        chat_id=chat.id,
        user_id=user.id,
        title=body.title.strip()[:200],
        kind=kind,
        filename=body.filename.strip()[:240] or _default_filename(body.title, kind, body.language),
        language=body.language.strip()[:40],
        content=body.content,
        version=1,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    data = artifact_out(row, include_content=True)
    data["chat_title"] = chat.title or "Chat"
    return data


@router.put("/artifacts/{artifact_id}")
def update_standalone_artifact(
    artifact_id: int,
    body: ArtifactUpdateIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from .artifact_tools import VALID_KINDS, artifact_out

    row, chat = _artifact_for_user(db, user, artifact_id)
    if body.title is not None:
        row.title = body.title.strip()[:200] or row.title
    if body.kind is not None:
        k = body.kind.strip().lower()
        if k not in VALID_KINDS:
            raise HTTPException(status_code=422, detail=f"Unbekannter Artefakt-Typ „{k}“.")
        row.kind = k
    if body.filename is not None:
        row.filename = body.filename.strip()[:240]
    if body.language is not None:
        row.language = body.language.strip()[:40]
    if body.content is not None:
        row.content = body.content
        row.version = (row.version or 1) + 1
    row.updated_at = _now()
    db.commit()
    db.refresh(row)
    data = artifact_out(row, include_content=True)
    data["chat_title"] = chat.title or "Chat"
    return data


@router.delete("/artifacts/{artifact_id}")
def delete_standalone_artifact(
    artifact_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    row, _chat = _artifact_for_user(db, user, artifact_id)
    db.delete(row)
    db.commit()
    return {"id": artifact_id, "deleted": True}


# --------------------------------------------------------------------------
# Routinen (Vorlagen & benutzerdefinierte Abläufe)
# --------------------------------------------------------------------------
MAX_ROUTINES_PER_USER = 100


class RoutineIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=400)
    category: str = Field(default="custom", max_length=40)
    icon: str = Field(default="repeat", max_length=40)
    prompt: str = Field(min_length=1, max_length=6000)
    steps: list[str] = Field(default_factory=list, max_length=20)
    schedule: str = Field(default="manual", max_length=40)
    schedule_time: str = Field(default="", max_length=16)
    write_mode: bool = False
    output_format: str = Field(default="html_report", max_length=30)
    shared: bool = False
    enabled: bool = True
    template_key: str = Field(default="", max_length=60)


class RoutineUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=400)
    category: str | None = Field(default=None, max_length=40)
    icon: str | None = Field(default=None, max_length=40)
    prompt: str | None = Field(default=None, min_length=1, max_length=6000)
    steps: list[str] | None = Field(default=None, max_length=20)
    schedule: str | None = Field(default=None, max_length=40)
    schedule_time: str | None = Field(default=None, max_length=16)
    write_mode: bool | None = None
    output_format: str | None = Field(default=None, max_length=30)
    shared: bool | None = None
    enabled: bool | None = None


def _routine_for_read(db: Session, user: User, routine_id: int) -> AgentRoutine:
    row = db.get(AgentRoutine, routine_id)
    if row is None or not (row.user_id == user.id or row.shared):
        raise HTTPException(status_code=404, detail="Routine nicht gefunden.")
    return row


def _routine_for_write(db: Session, user: User, routine_id: int) -> AgentRoutine:
    row = _routine_for_read(db, user, routine_id)
    if row.user_id != user.id and not _admin(user):
        raise HTTPException(status_code=403, detail="Fremde geteilte Routinen ändert nur ein Admin.")
    return row


def _create_routine_chat(db: Session, user: User, title: str, write_mode: bool) -> AgentChat:
    provider = (
        db.query(AgentProvider)
        .filter(AgentProvider.enabled.is_(True))
        .order_by(AgentProvider.is_default.desc(), AgentProvider.id)
        .first()
    )
    chat = AgentChat(
        user_id=user.id,
        title=title[:160],
        provider_id=provider.id if provider else None,
        model=(provider.default_model if provider else "")[:160],
        write_mode=bool(write_mode),
    )
    db.add(chat)
    db.flush()
    return chat


@router.get("/routines")
def list_routines(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from . import routines as routine_service

    rows = (
        db.query(AgentRoutine)
        .filter((AgentRoutine.user_id == user.id) | (AgentRoutine.shared.is_(True)))
        .order_by(AgentRoutine.updated_at.desc(), AgentRoutine.id.desc())
        .limit(200)
        .all()
    )
    runs = (
        db.query(AgentRoutineRun)
        .filter(AgentRoutineRun.user_id == user.id)
        .order_by(AgentRoutineRun.started_at.desc(), AgentRoutineRun.id.desc())
        .limit(30)
        .all()
    )
    return {
        "routines": [routine_service.routine_out(r, user) for r in rows],
        "templates": routine_service.templates_for(user),
        "runs": [routine_service.routine_run_out(run) for run in runs],
        "can_share": _admin(user),
    }


@router.post("/routines", status_code=201)
def create_routine(
    body: RoutineIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from . import routines as routine_service

    if body.shared and not _admin(user):
        raise HTTPException(status_code=403, detail="Teilen darf nur ein Admin.")
    count = db.query(func.count(AgentRoutine.id)).filter(AgentRoutine.user_id == user.id).scalar()
    if count >= MAX_ROUTINES_PER_USER:
        raise HTTPException(status_code=409, detail=f"Höchstens {MAX_ROUTINES_PER_USER} Routinen je Konto.")
    cat = body.category.strip().lower()
    if cat not in routine_service.VALID_CATEGORIES:
        cat = "custom"
    sched = body.schedule.strip().lower()
    if sched not in routine_service.VALID_SCHEDULES:
        sched = "manual"
    out_fmt = body.output_format.strip().lower()
    if out_fmt not in routine_service.VALID_OUTPUTS:
        out_fmt = "html_report"
    clean_steps = [str(s).strip()[:300] for s in body.steps if str(s).strip()][:20]
    row = AgentRoutine(
        user_id=user.id,
        name=body.name.strip()[:160],
        description=body.description.strip()[:400],
        category=cat,
        icon=(body.icon.strip() or "repeat")[:40],
        prompt=body.prompt.strip(),
        steps=clean_steps,
        schedule=sched,
        schedule_time=body.schedule_time.strip()[:16],
        write_mode=bool(body.write_mode),
        output_format=out_fmt,
        shared=bool(body.shared),
        enabled=bool(body.enabled),
        template_key=body.template_key.strip()[:60],
    )
    db.add(row)
    db.flush()
    _audit(db, user, "agent_routine_create", row.id, {"name": row.name, "shared": row.shared},
           entity="agent_routine")
    db.commit()
    db.refresh(row)
    return routine_service.routine_out(row, user)


@router.put("/routines/{routine_id}")
def update_routine(
    routine_id: int,
    body: RoutineUpdateIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from . import routines as routine_service

    row = _routine_for_write(db, user, routine_id)
    if body.shared is not None and body.shared != row.shared and not _admin(user):
        raise HTTPException(status_code=403, detail="Teilen darf nur ein Admin.")
    if body.name is not None:
        row.name = body.name.strip()[:160]
    if body.description is not None:
        row.description = body.description.strip()[:400]
    if body.category is not None and body.category.strip().lower() in routine_service.VALID_CATEGORIES:
        row.category = body.category.strip().lower()
    if body.icon is not None:
        row.icon = (body.icon.strip() or "repeat")[:40]
    if body.prompt is not None:
        row.prompt = body.prompt.strip()
    if body.steps is not None:
        row.steps = [str(s).strip()[:300] for s in body.steps if str(s).strip()][:20]
    if body.schedule is not None and body.schedule.strip().lower() in routine_service.VALID_SCHEDULES:
        row.schedule = body.schedule.strip().lower()
    if body.schedule_time is not None:
        row.schedule_time = body.schedule_time.strip()[:16]
    if body.write_mode is not None:
        row.write_mode = bool(body.write_mode)
    if body.output_format is not None and body.output_format.strip().lower() in routine_service.VALID_OUTPUTS:
        row.output_format = body.output_format.strip().lower()
    if body.shared is not None:
        row.shared = bool(body.shared)
    if body.enabled is not None:
        row.enabled = bool(body.enabled)
    row.updated_at = _now()
    _audit(db, user, "agent_routine_update", row.id, {"name": row.name}, entity="agent_routine")
    db.commit()
    db.refresh(row)
    return routine_service.routine_out(row, user)


@router.delete("/routines/{routine_id}")
def delete_routine(
    routine_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    row = _routine_for_write(db, user, routine_id)
    _audit(db, user, "agent_routine_delete", row.id, {"name": row.name}, entity="agent_routine")
    db.delete(row)
    db.commit()
    return {"id": routine_id, "deleted": True}


@router.post("/routines/{routine_id}/run")
def run_routine(
    routine_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from . import routines as routine_service

    row = _routine_for_read(db, user, routine_id)
    chat = _create_routine_chat(db, user, f"Routine: {row.name}", row.write_mode)
    prompt = routine_service.compile_routine_prompt(
        row.name, row.prompt or "", list(row.steps or []), row.output_format or "html_report"
    )
    run = AgentRoutineRun(
        routine_id=row.id,
        template_key=row.template_key or "",
        routine_name=row.name,
        user_id=user.id,
        chat_id=chat.id,
        status="started",
        summary=f"Gestartet in Chat #{chat.id}",
    )
    db.add(run)
    row.run_count = int(row.run_count or 0) + 1
    row.last_run_at = _now()
    row.last_chat_id = chat.id
    _audit(db, user, "agent_routine_run", row.id, {"chat_id": chat.id, "name": row.name},
           entity="agent_routine")
    db.commit()
    db.refresh(chat)
    db.refresh(run)
    db.refresh(row)
    return {
        "chat": _chat_out(db, chat),
        "prompt": prompt,
        "run": routine_service.routine_run_out(run),
        "routine": routine_service.routine_out(row, user),
    }


@router.post("/routines/templates/{template_key}/run")
def run_routine_template(
    template_key: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from . import routines as routine_service

    tpl = routine_service.TEMPLATES_BY_KEY.get(template_key)
    role = user.role.value if hasattr(user.role, "value") else str(user.role)
    if tpl is None or role not in tpl["roles"]:
        raise HTTPException(status_code=404, detail="Routinen-Vorlage nicht gefunden.")
    chat = _create_routine_chat(db, user, f"Routine: {tpl['name']}", bool(tpl.get("write_mode", False)))
    prompt = routine_service.compile_routine_prompt(
        tpl["name"], tpl["prompt"], list(tpl.get("steps") or []), tpl.get("output_format", "html_report")
    )
    run = AgentRoutineRun(
        routine_id=None,
        template_key=tpl["key"],
        routine_name=tpl["name"],
        user_id=user.id,
        chat_id=chat.id,
        status="started",
        summary=f"Vorlage gestartet in Chat #{chat.id}",
    )
    db.add(run)
    _audit(db, user, "agent_routine_template_run", tpl["key"], {"chat_id": chat.id},
           entity="agent_routine")
    db.commit()
    db.refresh(chat)
    db.refresh(run)
    return {
        "chat": _chat_out(db, chat),
        "prompt": prompt,
        "run": routine_service.routine_run_out(run),
    }


# --------------------------------------------------------------------------
# Spezialisierte Agenten (mit und ohne Routinen: Optimierer, Planer, Kunden, Buchhaltung …)
# --------------------------------------------------------------------------
MAX_AGENTS_PER_USER = 60


class AgentPersonaIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    role_title: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=400)
    category: str = Field(default="custom", max_length=40)
    icon: str = Field(default="predictive-analysis", max_length=40)
    color: str = Field(default="#0b7a67", max_length=24)
    system_prompt: str = Field(min_length=1, max_length=6000)
    tool_categories: list[str] = Field(default_factory=list, max_length=25)
    preferred_model: str = Field(default="", max_length=160)
    temperature: str = Field(default="", max_length=16)
    default_write_mode: bool = False
    has_routines: bool = False
    orchestration: bool = False
    temporary: bool = False
    routine_ids: list[int] = Field(default_factory=list, max_length=20)
    template_keys: list[str] = Field(default_factory=list, max_length=20)
    starter_prompts: list[str] = Field(default_factory=list, max_length=8)
    shared: bool = False
    enabled: bool = True


class AgentPersonaUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    role_title: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=400)
    category: str | None = Field(default=None, max_length=40)
    icon: str | None = Field(default=None, max_length=40)
    color: str | None = Field(default=None, max_length=24)
    system_prompt: str | None = Field(default=None, min_length=1, max_length=6000)
    tool_categories: list[str] | None = Field(default=None, max_length=25)
    preferred_model: str | None = Field(default=None, max_length=160)
    temperature: str | None = Field(default=None, max_length=16)
    default_write_mode: bool | None = None
    has_routines: bool | None = None
    orchestration: bool | None = None
    temporary: bool | None = None
    routine_ids: list[int] | None = Field(default=None, max_length=20)
    template_keys: list[str] | None = Field(default=None, max_length=20)
    starter_prompts: list[str] | None = Field(default=None, max_length=8)
    shared: bool | None = None
    enabled: bool | None = None


class AgentStartIn(BaseModel):
    routine_id: int | None = None
    template_key: str = Field(default="", max_length=60)
    initial_prompt: str = Field(default="", max_length=6000)
    orchestrate: bool = False


def _agent_for_read(db: Session, user: User, agent_id: int) -> AgentPersona:
    row = db.get(AgentPersona, agent_id)
    if row is None or not (row.user_id == user.id or row.shared):
        raise HTTPException(status_code=404, detail="Agent nicht gefunden.")
    return row


def _agent_for_write(db: Session, user: User, agent_id: int) -> AgentPersona:
    row = _agent_for_read(db, user, agent_id)
    if row.user_id != user.id and not _admin(user):
        raise HTTPException(status_code=403, detail="Fremde geteilte Agenten ändert nur ein Admin.")
    return row


@router.get("/agents")
def list_agents(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from . import agents as agent_service
    from . import routines as routine_service

    rows = (
        db.query(AgentPersona)
        .filter((AgentPersona.user_id == user.id) | (AgentPersona.shared.is_(True)))
        .order_by(AgentPersona.updated_at.desc(), AgentPersona.id.desc())
        .limit(120)
        .all()
    )
    routine_rows = (
        db.query(AgentRoutine)
        .filter((AgentRoutine.user_id == user.id) | (AgentRoutine.shared.is_(True)))
        .order_by(AgentRoutine.name)
        .limit(200)
        .all()
    )
    return {
        "agents": [agent_service.persona_out(r, user) for r in rows],
        "builtin": agent_service.builtin_agents_for(user),
        "tool_categories": list(agent_service.ALL_TOOL_CATEGORIES),
        "routines": [routine_service.routine_out(r, user) for r in routine_rows],
        "templates": routine_service.templates_for(user),
        "can_share": _admin(user),
    }


@router.post("/agents", status_code=201)
def create_agent(
    body: AgentPersonaIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from . import agents as agent_service

    if body.shared and not _admin(user):
        raise HTTPException(status_code=403, detail="Teilen darf nur ein Admin.")
    count = db.query(func.count(AgentPersona.id)).filter(AgentPersona.user_id == user.id).scalar()
    if count >= MAX_AGENTS_PER_USER:
        raise HTTPException(status_code=409, detail=f"Höchstens {MAX_AGENTS_PER_USER} Agenten je Konto.")
    cat = body.category.strip().lower()
    if cat not in agent_service.VALID_AGENT_CATEGORIES:
        cat = "custom"
    r_ids = [int(x) for x in body.routine_ids] if body.has_routines else []
    t_keys = [str(x).strip() for x in body.template_keys if str(x).strip()] if body.has_routines else []
    has_r = bool(body.has_routines and (r_ids or t_keys)) or bool(body.has_routines)
    row = AgentPersona(
        user_id=user.id,
        slug=re.sub(r"[^a-z0-9]+", "-", body.name.lower()).strip("-")[:60] or "agent",
        name=body.name.strip()[:120],
        role_title=body.role_title.strip()[:120],
        description=body.description.strip()[:400],
        category=cat,
        icon=(body.icon.strip() or "predictive-analysis")[:40],
        color=(body.color.strip() or "#0b7a67")[:24],
        system_prompt=body.system_prompt.strip(),
        tool_categories=[str(c).strip() for c in body.tool_categories if str(c).strip()],
        preferred_model=body.preferred_model.strip()[:160],
        temperature=body.temperature.strip()[:16],
        default_write_mode=bool(body.default_write_mode),
        has_routines=has_r,
        orchestration=bool(body.orchestration) and not bool(body.temporary),
        temporary=bool(body.temporary),
        routine_ids=r_ids,
        template_keys=t_keys,
        starter_prompts=[str(s).strip()[:300] for s in body.starter_prompts if str(s).strip()][:8],
        shared=bool(body.shared),
        enabled=bool(body.enabled),
    )
    db.add(row)
    db.flush()
    _audit(db, user, "agent_persona_create", row.id, {"name": row.name, "has_routines": row.has_routines},
           entity="agent_persona")
    db.commit()
    db.refresh(row)
    return agent_service.persona_out(row, user)


@router.put("/agents/{agent_id}")
def update_agent(
    agent_id: int,
    body: AgentPersonaUpdateIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from . import agents as agent_service

    row = _agent_for_write(db, user, agent_id)
    if body.shared is not None and body.shared != row.shared and not _admin(user):
        raise HTTPException(status_code=403, detail="Teilen darf nur ein Admin.")
    if body.name is not None:
        row.name = body.name.strip()[:120]
    if body.role_title is not None:
        row.role_title = body.role_title.strip()[:120]
    if body.description is not None:
        row.description = body.description.strip()[:400]
    if body.category is not None and body.category.strip().lower() in agent_service.VALID_AGENT_CATEGORIES:
        row.category = body.category.strip().lower()
    if body.icon is not None:
        row.icon = (body.icon.strip() or "predictive-analysis")[:40]
    if body.color is not None:
        row.color = (body.color.strip() or "#0b7a67")[:24]
    if body.system_prompt is not None:
        row.system_prompt = body.system_prompt.strip()
    if body.tool_categories is not None:
        row.tool_categories = [str(c).strip() for c in body.tool_categories if str(c).strip()]
    if body.preferred_model is not None:
        row.preferred_model = body.preferred_model.strip()[:160]
    if body.temperature is not None:
        row.temperature = body.temperature.strip()[:16]
    if body.default_write_mode is not None:
        row.default_write_mode = bool(body.default_write_mode)
    if body.has_routines is not None:
        row.has_routines = bool(body.has_routines)
        if not row.has_routines:
            row.routine_ids = []
            row.template_keys = []
    if body.orchestration is not None:
        row.orchestration = bool(body.orchestration)
    if body.temporary is not None:
        row.temporary = bool(body.temporary)
    if row.temporary:
        row.orchestration = False
    if body.routine_ids is not None:
        row.routine_ids = [int(x) for x in body.routine_ids]
    if body.template_keys is not None:
        row.template_keys = [str(x).strip() for x in body.template_keys if str(x).strip()]
    if body.starter_prompts is not None:
        row.starter_prompts = [str(s).strip()[:300] for s in body.starter_prompts if str(s).strip()][:8]
    if body.shared is not None:
        row.shared = bool(body.shared)
    if body.enabled is not None:
        row.enabled = bool(body.enabled)
    row.updated_at = _now()
    _audit(db, user, "agent_persona_update", row.id, {"name": row.name}, entity="agent_persona")
    db.commit()
    db.refresh(row)
    return agent_service.persona_out(row, user)


@router.delete("/agents/{agent_id}")
def delete_agent(
    agent_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    row = _agent_for_write(db, user, agent_id)
    _audit(db, user, "agent_persona_delete", row.id, {"name": row.name}, entity="agent_persona")
    db.delete(row)
    db.commit()
    return {"id": agent_id, "deleted": True}


def _resolve_optional_routine_prompt(
    db: Session, user: User, body: AgentStartIn
) -> tuple[str, str, bool | None]:
    from . import routines as routine_service

    if body.routine_id is not None:
        rt = _routine_for_read(db, user, body.routine_id)
        prompt = routine_service.compile_routine_prompt(
            rt.name, rt.prompt or "", list(rt.steps or []), rt.output_format or "html_report"
        )
        return rt.name, prompt, bool(rt.write_mode)
    if body.template_key:
        tpl = routine_service.TEMPLATES_BY_KEY.get(body.template_key)
        if tpl is None:
            raise HTTPException(status_code=404, detail="Routinen-Vorlage nicht gefunden.")
        prompt = routine_service.compile_routine_prompt(
            tpl["name"], tpl["prompt"], list(tpl.get("steps") or []), tpl.get("output_format", "html_report")
        )
        return tpl["name"], prompt, bool(tpl.get("write_mode", False))
    return "", body.initial_prompt.strip(), None


@router.post("/agents/{agent_id}/start")
def start_custom_agent(
    agent_id: int,
    body: AgentStartIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    row = _agent_for_read(db, user, agent_id)
    routine_name, prompt, rt_write = _resolve_optional_routine_prompt(db, user, body)
    orchestrate = bool(body.orchestrate or getattr(row, "orchestration", False))
    if orchestrate and not routine_name:
        from . import routines as routine_service

        parts = []
        for rid in (row.routine_ids or []):
            rrow = db.get(AgentRoutine, int(rid))
            if rrow is not None:
                parts.append(routine_service.compile_routine_prompt(
                    rrow.name, rrow.prompt or "", list(rrow.steps or []), rrow.output_format or "html_report"))
        for tk in (row.template_keys or []):
            tpl = routine_service.TEMPLATES_BY_KEY.get(str(tk))
            if tpl is not None:
                parts.append(routine_service.compile_routine_prompt(
                    tpl["name"], tpl.get("prompt", ""), list(tpl.get("steps") or []), tpl.get("output_format", "html_report")))
        if parts:
            routine_name = "Orchestrierung"
            prompt = (
                "Führe die folgenden Routinen in dieser Reihenfolge aus und fasse die Ergebnisse "
                "zu einer Gesamtantwort zusammen:\n\n" + "\n\n---\n\n".join(parts)
            )
    title = f"{row.name}: {routine_name}" if routine_name else row.name
    provider = (
        db.query(AgentProvider)
        .filter(AgentProvider.enabled.is_(True))
        .order_by(AgentProvider.is_default.desc(), AgentProvider.id)
        .first()
    )
    chat = AgentChat(
        user_id=user.id,
        title=title[:160],
        provider_id=provider.id if provider else None,
        model=(row.preferred_model or (provider.default_model if provider else ""))[:160],
        write_mode=bool(rt_write if rt_write is not None else row.default_write_mode),
        agent_id=row.id,
        agent_key="",
    )
    db.add(chat)
    db.flush()
    row.chat_count = int(row.chat_count or 0) + 1
    if routine_name:
        db.add(AgentRoutineRun(
            routine_id=body.routine_id,
            template_key=body.template_key,
            routine_name=f"{row.name} · {routine_name}",
            user_id=user.id,
            chat_id=chat.id,
            status="started",
            summary=f"Über Agent „{row.name}“ gestartet",
        ))
    _audit(db, user, "agent_persona_start", row.id, {"chat_id": chat.id, "routine": routine_name},
           entity="agent_persona")
    db.commit()
    db.refresh(chat)
    return {"chat": _chat_out(db, chat), "prompt": prompt}


@router.post("/agents/builtin/{agent_key}/start")
def start_builtin_agent(
    agent_key: str,
    body: AgentStartIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    from . import agents as agent_service

    tpl = agent_service.BUILTIN_AGENTS_BY_KEY.get(agent_key)
    role = user.role.value if hasattr(user.role, "value") else str(user.role)
    if tpl is None or role not in tpl["roles"]:
        raise HTTPException(status_code=404, detail="Agent nicht gefunden.")
    routine_name, prompt, rt_write = _resolve_optional_routine_prompt(db, user, body)
    orchestrate = bool(body.orchestrate or tpl.get("orchestration", False))
    if orchestrate and not routine_name:
        from . import routines as routine_service

        parts = []
        for tk in (tpl.get("template_keys") or []):
            t = routine_service.TEMPLATES_BY_KEY.get(str(tk))
            if t is not None:
                parts.append(routine_service.compile_routine_prompt(
                    t["name"], t.get("prompt", ""), list(t.get("steps") or []), t.get("output_format", "html_report")))
        if parts:
            routine_name = "Orchestrierung"
            prompt = (
                "Führe die folgenden Routinen in dieser Reihenfolge aus und fasse die Ergebnisse "
                "zu einer Gesamtantwort zusammen:\n\n" + "\n\n---\n\n".join(parts)
            )
    title = f"{tpl['name']}: {routine_name}" if routine_name else tpl["name"]
    provider = (
        db.query(AgentProvider)
        .filter(AgentProvider.enabled.is_(True))
        .order_by(AgentProvider.is_default.desc(), AgentProvider.id)
        .first()
    )
    chat = AgentChat(
        user_id=user.id,
        title=title[:160],
        provider_id=provider.id if provider else None,
        model=(provider.default_model if provider else "")[:160],
        write_mode=bool(rt_write if rt_write is not None else tpl.get("default_write_mode", False)),
        agent_id=None,
        agent_key=tpl["key"],
    )
    db.add(chat)
    db.flush()
    if routine_name:
        db.add(AgentRoutineRun(
            routine_id=body.routine_id,
            template_key=body.template_key,
            routine_name=f"{tpl['name']} · {routine_name}",
            user_id=user.id,
            chat_id=chat.id,
            status="started",
            summary=f"Über Agent „{tpl['name']}“ gestartet",
        ))
    _audit(db, user, "agent_builtin_start", tpl["key"], {"chat_id": chat.id, "routine": routine_name},
           entity="agent_persona")
    db.commit()
    db.refresh(chat)
    return {"chat": _chat_out(db, chat), "prompt": prompt}


# --------------------------------------------------------------------------
# Container-Sandbox (temporäre Arbeitsumgebung je Chat)
# --------------------------------------------------------------------------
class SandboxStartIn(BaseModel):
    image: str = Field(default="", max_length=128)
    stage_attachments: bool = False
    recreate: bool = False


@router.get("/sandbox/status")
def sandbox_runtime_status(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    info = sandbox_service.runtime_info(db, user_id=user.id, is_admin=_admin(user))
    chat_ids = [s["chat_id"] for s in info.get("sessions", []) if isinstance(s.get("chat_id"), int) and s["chat_id"] > 0]
    titles: dict[int, str] = {}
    if chat_ids:
        for row in db.query(AgentChat.id, AgentChat.title).filter(AgentChat.id.in_(chat_ids)).all():
            titles[row[0]] = row[1] or f"Chat #{row[0]}"
    for item in info.get("sessions", []):
        cid = item.get("chat_id")
        item["chat_title"] = titles.get(cid, f"Chat #{cid}" if cid else "Sandbox")
    return info


@router.delete("/sandbox/containers/{container_name}")
def stop_sandbox_container(
    container_name: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    try:
        info = sandbox_service.stop_container_by_name(
            container_name, user_id=user.id, is_admin=_admin(user),
        )
    except sandbox_service.SandboxError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    if info.get("destroyed"):
        _audit(
            db, user, "agent_sandbox_destroy", str(info.get("chat_id") or container_name),
            {"container_name": container_name, "backend": info.get("backend", "")},
            entity="agent_sandbox",
        )
        db.commit()
    return info


@router.post("/sandbox/test")
def test_sandbox_runtime(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    if not _admin(user):
        raise HTTPException(status_code=403, detail="Nur Administratoren.")
    try:
        result = sandbox_service.self_test(db)
    except sandbox_service.SandboxError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    _audit(
        db, user, "agent_sandbox_test", "sandbox",
        {"ok": result["ok"], "backend": result["backend"], "image": result["image"]},
        entity="agent_sandbox",
    )
    db.commit()
    return result


@router.get("/chats/{chat_id}/sandbox")
def get_chat_sandbox(
    chat_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    chat = _chat_for(db, user, chat_id)
    enabled = agent_settings.get_bool(db, "agent_sandbox_enabled")
    session = sandbox_service.get_sandbox(chat.id)
    if session is None:
        return {
            "enabled": enabled,
            "active": False,
            "chat_id": chat.id,
            "sandbox": None,
        }
    return {
        "enabled": enabled,
        "active": True,
        "chat_id": chat.id,
        "sandbox": sandbox_service.session_out(session, include_files=True),
    }


@router.post("/chats/{chat_id}/sandbox", status_code=201)
def start_chat_sandbox(
    chat_id: int,
    body: SandboxStartIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    chat = _chat_for(db, user, chat_id)
    req_image = body.image.strip() or None
    if req_image and not _admin(user):
        raise HTTPException(
            status_code=403,
            detail="Nur Administratoren dürfen ein abweichendes Container-Image wählen.",
        )
    try:
        session, created = sandbox_service.ensure_sandbox(
            db, chat.id, user.id, image=req_image, recreate=bool(body.recreate),
        )
        staged: list[str] = []
        if body.stage_attachments:
            attachments = (
                db.query(AgentAttachment)
                .filter(AgentAttachment.chat_id == chat.id)
                .order_by(AgentAttachment.id.asc())
                .all()
            )
            if attachments:
                staged = sandbox_service.stage_attachments(db, chat.id, user.id, attachments)
    except sandbox_service.SandboxError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    if created:
        _audit(
            db, user, "agent_sandbox_create", str(chat.id),
            {"sandbox_id": session.sandbox_id, "backend": session.backend, "image": session.image},
            entity="agent_sandbox",
        )
        db.commit()
    return {
        "enabled": True,
        "active": True,
        "created": created,
        "staged_attachments": staged,
        "chat_id": chat.id,
        "sandbox": sandbox_service.session_out(session, include_files=True),
    }


@router.delete("/chats/{chat_id}/sandbox")
def destroy_chat_sandbox(
    chat_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    chat = _chat_for(db, user, chat_id)
    info = sandbox_service.destroy_sandbox(chat.id)
    if info.get("destroyed"):
        _audit(
            db, user, "agent_sandbox_destroy", str(chat.id),
            {"sandbox_id": info.get("sandbox_id", ""), "backend": info.get("backend", "")},
            entity="agent_sandbox",
        )
        db.commit()
    return info


@router.get("/chats/{chat_id}/sandbox/files")
def list_chat_sandbox_files(
    chat_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    subdir: str = ".",
) -> dict:
    chat = _chat_for(db, user, chat_id)
    try:
        return sandbox_service.list_workspace_files(chat.id, subdir=subdir)
    except sandbox_service.SandboxError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.get("/chats/{chat_id}/sandbox/files/{file_path:path}")
def read_chat_sandbox_file(
    chat_id: int,
    file_path: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    max_chars: int = 120_000,
) -> dict:
    chat = _chat_for(db, user, chat_id)
    try:
        return sandbox_service.read_workspace_file(chat.id, file_path, max_chars=max_chars)
    except sandbox_service.SandboxError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.get("/health")
def health() -> dict:
    return {"ok": True}
