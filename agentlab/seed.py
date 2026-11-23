"""Erststart des Labors: einen OpenCode-Go-Anbieter anlegen, ohne Schlüssel."""

from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from gimel.db import engine

from .models import AgentProvider
from .providers import (
    FYREFLY_DEFAULT_MODEL,
    FYREFLY_MODELS_NAME,
    FYREFLY_OLLAMA_BASE,
    OPENCODE_BASE,
    OPENCODE_MODELS,
)


def ensure_columns(verbose: bool = False) -> list[str]:
    """Fehlende Labor-Spalten nachziehen; ``create_all`` legt nur Tabellen an."""
    added: list[str] = []
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if "agent_attachments" in tables:
        have = {column["name"] for column in inspector.get_columns("agent_attachments")}
        if "meta" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_attachments ADD COLUMN meta JSON"))
            added.append("agent_attachments.meta")
    if "agent_messages" in tables:
        have = {column["name"] for column in inspector.get_columns("agent_messages")}
        if "hidden_at" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_messages ADD COLUMN hidden_at DATETIME"))
            added.append("agent_messages.hidden_at")
        if "model" not in have:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE agent_messages ADD COLUMN model VARCHAR(160) DEFAULT ''"
                ))
            added.append("agent_messages.model")
        if "provider_id" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_messages ADD COLUMN provider_id INTEGER"))
            added.append("agent_messages.provider_id")
    if "agent_subagents" in tables:
        have = {column["name"] for column in inspector.get_columns("agent_subagents")}
        if "last_used_at" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_subagents ADD COLUMN last_used_at DATETIME"))
            added.append("agent_subagents.last_used_at")
        if "status" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_subagents ADD COLUMN status VARCHAR(20) DEFAULT 'running'"))
            added.append("agent_subagents.status")
        if "result" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_subagents ADD COLUMN result TEXT DEFAULT ''"))
            added.append("agent_subagents.result")
    if "agent_personas" in tables:
        have = {column["name"] for column in inspector.get_columns("agent_personas")}
        if "orchestration" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_personas ADD COLUMN orchestration BOOLEAN DEFAULT 0"))
            added.append("agent_personas.orchestration")
        if "temporary" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_personas ADD COLUMN temporary BOOLEAN DEFAULT 0"))
            added.append("agent_personas.temporary")
    if "agent_chats" in tables:
        have = {column["name"] for column in inspector.get_columns("agent_chats")}
        if "agent_id" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_chats ADD COLUMN agent_id INTEGER"))
            added.append("agent_chats.agent_id")
        if "agent_key" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_chats ADD COLUMN agent_key VARCHAR(60) DEFAULT ''"))
            added.append("agent_chats.agent_key")
        if "kind" not in have:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE agent_chats ADD COLUMN kind VARCHAR(40) DEFAULT 'classic'"))
            added.append("agent_chats.kind")
    if verbose and added:
        print("Agent Lab: Spalten ergänzt: " + ", ".join(added))
    return added


def seed(db: Session, verbose: bool = False) -> dict:
    ensure_columns(verbose=verbose)
    created = 0
    if not db.query(AgentProvider).count():
        db.add(
            AgentProvider(
                name="OpenCode Go",
                kind="opencode-go",
                base_url=OPENCODE_BASE,
                models_url=OPENCODE_MODELS,
                default_model="deepseek-v4.1-flash",
                enabled=True,
                is_default=True,
                created_by="system",
                updated_by="system",
            )
        )
        created += 1
    has_fyrefly = (
        db.query(AgentProvider)
        .filter(AgentProvider.name == FYREFLY_MODELS_NAME)
        .first()
        is not None
    )
    if not has_fyrefly:
        db.add(
            AgentProvider(
                name=FYREFLY_MODELS_NAME,
                kind="ollama",
                base_url=f"{FYREFLY_OLLAMA_BASE}/v1",
                models_url=f"{FYREFLY_OLLAMA_BASE}/api/tags",
                default_model=FYREFLY_DEFAULT_MODEL,
                enabled=True,
                is_default=False,
                created_by="system",
                updated_by="system",
            )
        )
        created += 1
    if created:
        db.commit()
        if verbose:
            print(f"Agent Lab: {created} Anbieter angelegt.")
    return {"agent_providers": created}
