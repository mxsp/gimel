"""Tabellen des Assistenten — additiv, keine Änderung an Gimel-Tabellen."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from gimel.db import Base
from gimel.fieldcrypt import EncryptedJSON, EncryptedText


def _now() -> datetime:
    return datetime.now(timezone.utc)


class AgentProvider(Base):
    """Ein konfigurierbarer OpenAI-kompatibler Endpunkt."""

    __tablename__ = "agent_providers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(40), default="custom")
    base_url: Mapped[str] = mapped_column(String(400))
    models_url: Mapped[str] = mapped_column(String(400), default="")
    api_key_enc: Mapped[str] = mapped_column(Text, default="")
    headers: Mapped[dict] = mapped_column(EncryptedJSON("agent_providers.headers"), default=dict)
    default_model: Mapped[str] = mapped_column(String(160), default="")
    models_cache: Mapped[list] = mapped_column(JSON, default=list)
    models_fetched_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(String(254), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_by: Mapped[str] = mapped_column(String(254), default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class AgentChat(Base):
    """Ein Gespräch. Gehört genau einem Konto."""

    __tablename__ = "agent_chats"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(160), default="")
    provider_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_providers.id", ondelete="SET NULL"), nullable=True
    )
    model: Mapped[str] = mapped_column(String(160), default="")
    write_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    #: Art des Chats: ``classic`` (bisheriger Einzelchat) oder ``orchestrator``
    #: (ein durchgängiger Chat mit 200k-Kontext, der über einen Wissensgraphen
    #: erinnert und massiv Subagenten nutzt).
    kind: Mapped[str] = mapped_column(String(40), default="classic", index=True)
    agent_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    agent_key: Mapped[str] = mapped_column(String(60), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    last_message_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class AgentMessage(Base):
    """Eine Zeile im Gespräch: Nutzer, Assistent oder Werkzeugergebnis."""

    __tablename__ = "agent_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    chat_id: Mapped[int] = mapped_column(
        ForeignKey("agent_chats.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(EncryptedText("agent_messages.content"), default="")
    tool_calls: Mapped[list] = mapped_column(
        EncryptedJSON("agent_messages.tool_calls"), default=list
    )
    tool_call_id: Mapped[str] = mapped_column(String(160), default="")
    name: Mapped[str] = mapped_column(String(80), default="")
    #: Modell und Anbieter der Runde. Der Chat kann beides wechseln; die
    #: Statistik soll trotzdem wissen, wer die Token wirklich gerechnet hat.
    model: Mapped[str] = mapped_column(String(160), default="")
    provider_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_providers.id", ondelete="SET NULL"), nullable=True
    )
    usage: Mapped[dict] = mapped_column(JSON, default=dict)
    interrupted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    #: Ausgeblendet durch „Neu erzeugen“ oder „Bearbeiten und erneut senden“.
    #: Die Zeile bleibt (Nachweis, Änderungsregister), nur Verlauf und Modell
    #: sehen sie nicht mehr.
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentChange(Base):
    """Eine Änderung des Assistenten mit Vorher/Nachher und Rücknahme.

    Rücknahme ist ein Vergleich-und-Setzen: nur wenn der aktuelle Wert noch dem
    ``after`` entspricht, wird zurückgeschrieben. So überschreibt ein spätes
    „Rückgängig" keine neuere Arbeit.
    """

    __tablename__ = "agent_changes"

    id: Mapped[int] = mapped_column(primary_key=True)
    chat_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_chats.id", ondelete="SET NULL"), nullable=True, index=True
    )
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL"), nullable=True, index=True
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    tool: Mapped[str] = mapped_column(String(80))
    action: Mapped[str] = mapped_column(String(80), default="")
    entity: Mapped[str] = mapped_column(String(60), default="")
    entity_id: Mapped[str] = mapped_column(String(120), default="")
    before: Mapped[dict | None] = mapped_column(
        EncryptedJSON("agent_changes.before"), nullable=True
    )
    after: Mapped[dict | None] = mapped_column(
        EncryptedJSON("agent_changes.after"), nullable=True
    )
    reversible: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(20), default="applied")
    summary: Mapped[str] = mapped_column(
        EncryptedText("agent_changes.summary"), default=""
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    reverted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reverted_by: Mapped[str] = mapped_column(String(254), default="")


class AgentSetting(Base):
    """Ein Betriebsparameter des Labors — getrennt von Gimels ``settings``.

    Die Werte bleiben im Assistenten und tauchen nicht in Gimels
    Betriebsparametern auf. Geheimnisse (etwa der Schlüssel einer Websuche)
    werden zusätzlich über ``secretbox`` versiegelt.
    """

    __tablename__ = "agent_settings"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[str] = mapped_column(String(254), default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class AgentAttachment(Base):
    """Ein Anhang am Chat: extrahierter Text, nie die Originaldatei.

    Die Datei wird im Speicher gelesen, geprüft und nach der Textextraktion
    verworfen. Gespeichert bleiben Name, Typ, Größe, Prüfsumme und der Text —
    genug, um ihn dem Modell erneut vorzulegen, ohne einen Dateispeicher zu
    betreiben.
    """

    __tablename__ = "agent_attachments"

    id: Mapped[int] = mapped_column(primary_key=True)
    chat_id: Mapped[int] = mapped_column(
        ForeignKey("agent_chats.id", ondelete="CASCADE"), index=True
    )
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL"), nullable=True, index=True
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    filename: Mapped[str] = mapped_column(String(240), default="")
    content_type: Mapped[str] = mapped_column(String(120), default="")
    size: Mapped[int] = mapped_column(Integer, default=0)
    pages: Mapped[int] = mapped_column(Integer, default=0)
    chars: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    #: Art der Extraktion, Seitenauswahl, OCR und PDF-Metadaten. Nie das
    #: Passwort einer geschützten Datei.
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    text: Mapped[str] = mapped_column(EncryptedText("agent_attachments.text"), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)



class AgentPrompt(Base):
    """Eine gespeicherte Vorlage für den Chat — je Konto, auf Wunsch geteilt.

    Teilen darf nur, wer Admin-Arbeit hat; geteilte Vorlagen sehen alle
    Teammitglieder. Der Text kann Interna enthalten und liegt deshalb wie
    Chatinhalte verschlüsselt, sobald ``DATA_KEYS`` gesetzt sind.
    """

    __tablename__ = "agent_prompts"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(120), default="")
    text: Mapped[str] = mapped_column(EncryptedText("agent_prompts.text"), default="")
    shared: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class AgentActionProposal(Base):
    """Vorgeschlagene Aktion (Palantir-AIP-Muster): auch ohne Schreibmodus entwerfbar.

    Der Assistent legt den Vorschlag samt simulierter Wirkung ab; erst die
    menschliche Freigabe (``POST /api/agent/proposals/{id}/approve``) führt das
    hinterlegte Werkzeug aus, protokolliert im ``AuditLog`` und erzeugt einen
    rückholbaren ``AgentChange``-Eintrag.
    """

    __tablename__ = "agent_action_proposals"

    id: Mapped[int] = mapped_column(primary_key=True)
    chat_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_chats.id", ondelete="SET NULL"), nullable=True, index=True
    )
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL"), nullable=True, index=True
    )
    alert_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    kind: Mapped[str] = mapped_column(String(40), default="generic", index=True)
    title: Mapped[str] = mapped_column(String(200))
    rationale: Mapped[str] = mapped_column(EncryptedText("agent_action_proposals.rationale"), default="")
    tool_name: Mapped[str] = mapped_column(String(80))
    arguments: Mapped[dict] = mapped_column(
        EncryptedJSON("agent_action_proposals.arguments"), default=dict
    )
    impact_summary: Mapped[dict] = mapped_column(
        EncryptedJSON("agent_action_proposals.impact_summary"), default=dict
    )
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)  # pending|approved|rejected|failed|expired
    decided_by: Mapped[str] = mapped_column(String(254), default="")
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decision_note: Mapped[str] = mapped_column(String(400), default="")
    change_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_changes.id", ondelete="SET NULL"), nullable=True
    )
    result_summary: Mapped[str] = mapped_column(String(400), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class AgentArtifact(Base):
    """Ein im Chat erzeugtes Artefakt (HTML-App, Bericht, SVG, Markdown, CSV, JSON, Code)."""

    __tablename__ = "agent_artifacts"

    id: Mapped[int] = mapped_column(primary_key=True)
    chat_id: Mapped[int] = mapped_column(
        ForeignKey("agent_chats.id", ondelete="CASCADE"), index=True
    )
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL"), nullable=True, index=True
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(160), default="")
    kind: Mapped[str] = mapped_column(String(32), default="html", index=True)
    filename: Mapped[str] = mapped_column(String(200), default="")
    language: Mapped[str] = mapped_column(String(40), default="")
    version: Mapped[int] = mapped_column(Integer, default=1)
    content: Mapped[str] = mapped_column(EncryptedText("agent_artifacts.content"), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class AgentRoutine(Base):
    """Wiederverwendbare Routine (Vorlage oder benutzerdefinierter Arbeitsablauf)."""

    __tablename__ = "agent_routines"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    template_key: Mapped[str] = mapped_column(String(60), default="", index=True)
    name: Mapped[str] = mapped_column(String(140), default="")
    description: Mapped[str] = mapped_column(String(400), default="")
    category: Mapped[str] = mapped_column(String(40), default="custom", index=True)
    icon: Mapped[str] = mapped_column(String(40), default="repeat")
    prompt: Mapped[str] = mapped_column(EncryptedText("agent_routines.prompt"), default="")
    steps: Mapped[list] = mapped_column(JSON, default=list)
    schedule: Mapped[str] = mapped_column(String(32), default="manual")
    schedule_time: Mapped[str] = mapped_column(String(16), default="")
    output_format: Mapped[str] = mapped_column(String(32), default="html_report")
    write_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    shared: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_chat_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_chats.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class AgentRoutineRun(Base):
    """Protokolleintrag eines Routinen-Laufs (verknüpft mit dem ausgeführten Chat)."""

    __tablename__ = "agent_routine_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    routine_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_routines.id", ondelete="SET NULL"), nullable=True, index=True
    )
    template_key: Mapped[str] = mapped_column(String(60), default="")
    routine_name: Mapped[str] = mapped_column(String(140), default="")
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    chat_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_chats.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(24), default="started")
    summary: Mapped[str] = mapped_column(String(400), default="")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class AgentPersona(Base):
    """Spezialisierter Agent (mit oder ohne feste Routinen)."""

    __tablename__ = "agent_personas"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    slug: Mapped[str] = mapped_column(String(80), default="")
    name: Mapped[str] = mapped_column(String(120), default="")
    role_title: Mapped[str] = mapped_column(String(120), default="")
    description: Mapped[str] = mapped_column(String(400), default="")
    category: Mapped[str] = mapped_column(String(40), default="custom", index=True)
    icon: Mapped[str] = mapped_column(String(40), default="predictive-analysis")
    color: Mapped[str] = mapped_column(String(24), default="#0b7a67")
    system_prompt: Mapped[str] = mapped_column(EncryptedText("agent_personas.system_prompt"), default="")
    tool_categories: Mapped[list] = mapped_column(JSON, default=list)
    preferred_model: Mapped[str] = mapped_column(String(160), default="")
    temperature: Mapped[str] = mapped_column(String(16), default="")
    default_write_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    has_routines: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    orchestration: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    #: Temporärer Subagent, der vom Orchestrator erzeugt und nach Gebrauch
    #: entsorgt wird. Temporäre Subagenten dürfen keine weiteren Subagenten
    #: erzeugen (keine Rekursion).
    temporary: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    routine_ids: Mapped[list] = mapped_column(JSON, default=list)
    template_keys: Mapped[list] = mapped_column(JSON, default=list)
    starter_prompts: Mapped[list] = mapped_column(JSON, default=list)
    shared: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    chat_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class AgentSubagent(Base):
    """Ein temporärer Subagent innerhalb EINES durchgängigen Orchestrator-Chats.

    Es wird kein eigener Chat angelegt: der Subagent ist ein Eintrag im selben
    Gespräch, der mit ``dispatch_subagent`` erzeugt, mit ``list_subagents``
    aufgeführt und mit ``dispose_subagent`` wieder entsorgt wird.
    """

    __tablename__ = "agent_subagents"

    id: Mapped[int] = mapped_column(primary_key=True)
    chat_id: Mapped[int] = mapped_column(
        ForeignKey("agent_chats.id", ondelete="CASCADE"), index=True
    )
    persona_id: Mapped[int | None] = mapped_column(
        ForeignKey("agent_personas.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(120), default="")
    task: Mapped[str] = mapped_column(EncryptedText("agent_subagents.task"), default="")
    capabilities: Mapped[list] = mapped_column(JSON, default=list)
    used_calls: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="running", index=True)
    result: Mapped[str] = mapped_column(EncryptedText("agent_subagents.result"), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    disposed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class AgentKnowledgeNode(Base):
    """Knoten im plattformweiten Wissensgraphen (Plattform-Entität oder Erkenntnis)."""

    __tablename__ = "agent_knowledge_nodes"

    id: Mapped[int] = mapped_column(primary_key=True)
    node_key: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    label: Mapped[str] = mapped_column(String(200), default="")
    subtitle: Mapped[str] = mapped_column(String(240), default="")
    status: Mapped[str] = mapped_column(String(40), default="")
    source: Mapped[str] = mapped_column(String(32), default="platform", index=True)  # platform | insight
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class AgentKnowledgeEdge(Base):
    """Gerichtete Kante zwischen zwei Knoten im Wissensgraphen."""

    __tablename__ = "agent_knowledge_edges"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_key: Mapped[str] = mapped_column(String(160), index=True)
    target_key: Mapped[str] = mapped_column(String(160), index=True)
    relation: Mapped[str] = mapped_column(String(60), index=True)
    weight: Mapped[int] = mapped_column(Integer, default=1)
    source: Mapped[str] = mapped_column(String(32), default="platform", index=True)  # platform | insight
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)
