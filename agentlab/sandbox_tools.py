"""Container- und Sandbox-Werkzeuge für den Gimel-Assistenten.

Alle Werkzeuge laufen in einer isolierten, temporären Container-Umgebung je Chat
(Docker oder Bubblewrap) und ändern niemals Gimels Produktivdatenbank. Sie sind
deshalb auch bei ausgeschaltetem Schreibmodus nutzbar, lassen sich aber global
über ``agent_sandbox_enabled`` in den Assistenten-Einstellungen steuern.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from gimel.models import AuditLog
from gimel.security import has_admin_work

from . import sandbox
from .artifact_tools import (
    MAX_ARTIFACT_CHARS,
    VALID_KINDS,
    _default_filename,
    _preview_action_for_artifact,
    artifact_out,
)
from .models import AgentArtifact, AgentAttachment
from .tools import ToolContext, ToolError, ToolSpec, _need, _schema

_EXT_TO_KIND: dict[str, tuple[str, str]] = {
    ".html": ("html", "html"),
    ".htm": ("html", "html"),
    ".svg": ("svg", "svg"),
    ".md": ("markdown", "markdown"),
    ".markdown": ("markdown", "markdown"),
    ".csv": ("csv", "csv"),
    ".tsv": ("csv", "csv"),
    ".json": ("json", "json"),
    ".py": ("code", "python"),
    ".js": ("code", "javascript"),
    ".ts": ("code", "typescript"),
    ".css": ("code", "css"),
    ".sql": ("code", "sql"),
    ".sh": ("code", "bash"),
    ".yaml": ("code", "yaml"),
    ".yml": ("code", "yaml"),
    ".xml": ("code", "xml"),
    ".txt": ("text", "text"),
    ".log": ("text", "text"),
}


def _wrap(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except sandbox.SandboxError as exc:
        raise ToolError(exc.detail) from exc


def _audit_sandbox(ctx: ToolContext, action: str, detail: dict[str, Any]) -> None:
    ctx.db.add(
        AuditLog(
            actor=ctx.user.email,
            action=action,
            entity="agent_sandbox",
            entity_id=str(ctx.chat.id),
            detail=detail,
        )
    )


def sandbox_create(ctx: ToolContext, args: dict) -> dict:
    requested_image = str(args.get("image") or "").strip() or None
    if requested_image and not has_admin_work(ctx.user):
        raise ToolError("Nur Administratoren dürfen ein abweichendes Container-Image wählen.")
    session, created = _wrap(
        sandbox.ensure_sandbox,
        ctx.db,
        ctx.chat.id,
        ctx.user.id,
        image=requested_image,
    )
    staged: list[str] = []
    if bool(args.get("stage_attachments", False)):
        attachments = (
            ctx.db.query(AgentAttachment)
            .filter(AgentAttachment.chat_id == ctx.chat.id)
            .order_by(AgentAttachment.id.asc())
            .all()
        )
        if attachments:
            staged = _wrap(sandbox.stage_attachments, ctx.db, ctx.chat.id, ctx.user.id, attachments)
    info = sandbox.session_out(session, include_files=True)
    if created:
        _audit_sandbox(ctx, "agent_sandbox_create", {
            "sandbox_id": session.sandbox_id,
            "backend": session.backend,
            "image": session.image,
            "network_enabled": session.network_enabled,
        })
    status_word = "neu erstellt" if created else "bereits aktiv"
    extra = f" · {len(staged)} Anhang/Anhänge nach /workspace/attachments/ kopiert" if staged else ""
    return {
        "summary": (
            f"Container-Umgebung {status_word} ({session.backend}, {session.image}, "
            f"Profil {session.profile}, {session.memory_mb} MB RAM, {session.cpus:g} CPU, "
            f"{session.workspace_mb} MB Workspace, Netzwerk {'an' if session.network_enabled else 'aus'}){extra}."
        ),
        "data": {
            "created": created,
            "staged_attachments": staged,
            "sandbox": info,
        },
    }


def sandbox_exec(ctx: ToolContext, args: dict) -> dict:
    command = str(_need(args, "command"))
    workdir = str(args.get("workdir") or ".").strip() or "."
    timeout_s = args.get("timeout_s")
    env = args.get("env") if isinstance(args.get("env"), dict) else None
    result = _wrap(
        sandbox.exec_command,
        ctx.db,
        ctx.chat.id,
        ctx.user.id,
        command,
        workdir=workdir,
        timeout_s=int(timeout_s) if timeout_s is not None else None,
        env=env,
    )
    if result.get("sandbox_created"):
        sb = result["sandbox"]
        _audit_sandbox(ctx, "agent_sandbox_create", {
            "sandbox_id": sb["sandbox_id"],
            "backend": sb["backend"],
            "image": sb["image"],
            "network_enabled": sb["network_enabled"],
        })
    rc = result["exit_code"]
    dur = result["duration_ms"]
    changed = result.get("changed_files") or []
    changed_note = f", {len(changed)} Datei(en) aktualisiert" if changed else ""
    if result.get("timed_out"):
        summary = f"Befehl im Container nach {dur} ms wegen Zeitlimit abgebrochen (Exit {rc})."
    elif rc == 0:
        summary = f"Befehl im Container erfolgreich ausgeführt ({dur} ms{changed_note})."
    else:
        summary = f"Befehl im Container mit Exit-Code {rc} beendet ({dur} ms{changed_note})."
    return {
        "summary": summary,
        "data": result,
    }


def sandbox_run_python(ctx: ToolContext, args: dict) -> dict:
    code = str(_need(args, "code"))
    filename = str(args.get("filename") or "_script.py").strip() or "_script.py"
    timeout_s = args.get("timeout_s")
    result = _wrap(
        sandbox.run_python,
        ctx.db,
        ctx.chat.id,
        ctx.user.id,
        code,
        filename=filename,
        timeout_s=int(timeout_s) if timeout_s is not None else None,
    )
    if result.get("sandbox_created"):
        sb = result["sandbox"]
        _audit_sandbox(ctx, "agent_sandbox_create", {
            "sandbox_id": sb["sandbox_id"],
            "backend": sb["backend"],
            "image": sb["image"],
            "network_enabled": sb["network_enabled"],
        })
    rc = result["exit_code"]
    dur = result["duration_ms"]
    changed = [f for f in (result.get("changed_files") or []) if f != result.get("script")]
    changed_note = f", erzeugt: {', '.join(changed[:4])}" if changed else ""
    if result.get("timed_out"):
        summary = f"Python-Skript im Container nach {dur} ms wegen Zeitlimit abgebrochen."
    elif rc == 0:
        summary = f"Python-Skript im Container erfolgreich ausgeführt ({dur} ms{changed_note})."
    else:
        summary = f"Python-Skript im Container fehlgeschlagen (Exit {rc}, {dur} ms)."
    return {
        "summary": summary,
        "data": result,
    }


def sandbox_write_file(ctx: ToolContext, args: dict) -> dict:
    path = str(_need(args, "path"))
    content = str(args.get("content") if args.get("content") is not None else "")
    result = _wrap(
        sandbox.write_workspace_file,
        ctx.db,
        ctx.chat.id,
        ctx.user.id,
        path,
        content,
    )
    if result.get("sandbox_created"):
        sb = result["sandbox"]
        _audit_sandbox(ctx, "agent_sandbox_create", {
            "sandbox_id": sb["sandbox_id"],
            "backend": sb["backend"],
            "image": sb["image"],
            "network_enabled": sb["network_enabled"],
        })
    return {
        "summary": f"Datei „/workspace/{result['path']}“ im Container geschrieben ({result['bytes']:,} Bytes).",
        "data": result,
    }


def sandbox_read_file(ctx: ToolContext, args: dict) -> dict:
    path = str(_need(args, "path"))
    max_chars = int(args.get("max_chars") or 40_000)
    result = _wrap(sandbox.read_workspace_file, ctx.chat.id, path, max_chars=max_chars)
    return {
        "summary": f"Datei „/workspace/{result['path']}“ gelesen ({result['bytes']:,} Bytes).",
        "data": result,
    }


def sandbox_list_files(ctx: ToolContext, args: dict) -> dict:
    subdir = str(args.get("subdir") or ".").strip() or "."
    result = _wrap(sandbox.list_workspace_files, ctx.chat.id, subdir=subdir)
    if not result["active"]:
        return {
            "summary": "Für diesen Chat ist aktuell keine Container-Umgebung aktiv.",
            "data": result,
        }
    files = result["files"]
    sb = result["sandbox"]
    return {
        "summary": (
            f"Container aktiv ({sb['backend']}, {sb['image']}): "
            f"{len(files)} Eintrag/Einträge in /workspace."
        ),
        "data": result,
    }


def sandbox_export_artifact(ctx: ToolContext, args: dict) -> dict:
    path = str(_need(args, "path"))
    file_data = _wrap(sandbox.read_workspace_file, ctx.chat.id, path, max_chars=MAX_ARTIFACT_CHARS)
    if file_data["truncated"]:
        raise ToolError(f"Datei ist zu groß für ein Artefakt (höchstens {MAX_ARTIFACT_CHARS:,} Zeichen).")
    rel_path = file_data["path"]
    filename = Path(rel_path).name or "export.txt"
    ext = Path(filename).suffix.lower()
    inferred_kind, inferred_lang = _EXT_TO_KIND.get(ext, ("text", "text"))

    kind = str(args.get("kind") or inferred_kind).strip().lower()
    if kind not in VALID_KINDS:
        raise ToolError(f"Unbekannter Artefakt-Typ „{kind}“. Erlaubt: {', '.join(VALID_KINDS)}.")
    language = str(args.get("language") or inferred_lang).strip()[:40]
    title = str(args.get("title") or Path(filename).stem or "Container-Export").strip()[:200]
    open_now = bool(args.get("open_preview", True))

    row = AgentArtifact(
        chat_id=ctx.chat.id,
        user_id=ctx.user.id,
        message_id=ctx.message_id,
        title=title,
        kind=kind,
        filename=filename[:240] or _default_filename(title, kind, language),
        language=language,
        content=file_data["content"],
        version=1,
    )
    ctx.db.add(row)
    ctx.db.flush()

    out: dict[str, Any] = {
        "summary": (
            f"Container-Datei „{rel_path}“ als Artefakt „{row.title}“ ({kind.upper()}) veröffentlicht."
        ),
        "data": {
            "source_path": rel_path,
            "artifact": artifact_out(row, include_content=False),
        },
    }
    if open_now:
        out["client_action"] = _preview_action_for_artifact(row)
    return out


def sandbox_destroy(ctx: ToolContext, args: dict) -> dict:
    info = sandbox.destroy_sandbox(ctx.chat.id)
    if info.get("destroyed"):
        _audit_sandbox(ctx, "agent_sandbox_destroy", {
            "sandbox_id": info.get("sandbox_id", ""),
            "backend": info.get("backend", ""),
            "command_count": info.get("command_count", 0),
        })
        return {
            "summary": (
                f"Temporäre Container-Umgebung ({info['backend']}) beendet und "
                "/workspace vollständig gelöscht."
            ),
            "data": info,
        }
    return {
        "summary": "Für diesen Chat war keine aktive Container-Umgebung vorhanden.",
        "data": info,
    }


SANDBOX_SPECS: list[ToolSpec] = [
    ToolSpec(
        "sandbox_create",
        "Create or inspect the isolated temporary container environment (/workspace) for this chat. "
        "Set stage_attachments=true to copy chat attachments into /workspace/attachments/ for Python/shell processing.",
        _schema({
            "image": {"type": "string", "description": "Optional Docker image (admin only; otherwise configured default)."},
            "stage_attachments": {"type": "boolean", "description": "Copy chat attachments into /workspace/attachments/."},
        }),
        sandbox_create,
        sandbox=True,
    ),
    ToolSpec(
        "sandbox_exec",
        "Run a shell command inside this chat's isolated temporary container (/workspace). "
        "Automatically starts a fresh ephemeral container on first use. Network is disabled by default.",
        _schema({
            "command": {"type": "string", "description": "POSIX shell command to execute inside /workspace."},
            "workdir": {"type": "string", "description": "Optional subdirectory inside /workspace (default '.')."},
            "timeout_s": {"type": "integer", "description": "Optional command timeout in seconds."},
            "env": {"type": "object", "description": "Optional extra environment variables (key -> value)."},
        }, ["command"]),
        sandbox_exec,
        sandbox=True,
    ),
    ToolSpec(
        "sandbox_run_python",
        "Execute Python 3 code inside this chat's isolated temporary container (/workspace). "
        "Great for data processing, simulations, CSV/JSON analysis, generating SVG/HTML/CSV files, and verifying calculations.",
        _schema({
            "code": {"type": "string", "description": "Python 3 source code to run."},
            "filename": {"type": "string", "description": "Optional script filename in /workspace (default '_script.py')."},
            "timeout_s": {"type": "integer", "description": "Optional timeout in seconds."},
        }, ["code"]),
        sandbox_run_python,
        sandbox=True,
    ),
    ToolSpec(
        "sandbox_write_file",
        "Write or update a UTF-8 text file inside the chat's isolated container /workspace.",
        _schema({
            "path": {"type": "string", "description": "Relative path inside /workspace (e.g. 'data.csv' or 'src/app.py')."},
            "content": {"type": "string", "description": "UTF-8 file content."},
        }, ["path", "content"]),
        sandbox_write_file,
        sandbox=True,
    ),
    ToolSpec(
        "sandbox_read_file",
        "Read a text file from the chat's isolated container /workspace.",
        _schema({
            "path": {"type": "string", "description": "Relative path inside /workspace."},
            "max_chars": {"type": "integer", "description": "Max characters to return (default 40000)."},
        }, ["path"]),
        sandbox_read_file,
        sandbox=True,
    ),
    ToolSpec(
        "sandbox_list_files",
        "List files and directories inside the chat's temporary container /workspace and return container status/TTL.",
        _schema({
            "subdir": {"type": "string", "description": "Optional subdirectory inside /workspace (default '.')."},
        }),
        sandbox_list_files,
        sandbox=True,
    ),
    ToolSpec(
        "sandbox_export_artifact",
        "Publish a file generated inside the container /workspace (HTML, SVG, Markdown, CSV, JSON, code) "
        "as a chat artifact and open it directly in the Side Preview pane.",
        _schema({
            "path": {"type": "string", "description": "Relative path in /workspace to export."},
            "title": {"type": "string", "description": "Optional artifact title."},
            "kind": {"type": "string", "enum": list(VALID_KINDS), "description": "Optional artifact kind (auto-detected from extension)."},
            "language": {"type": "string", "description": "Optional language tag for code artifacts."},
            "open_preview": {"type": "boolean", "description": "Open the Side Preview pane immediately (default true)."},
        }, ["path"]),
        sandbox_export_artifact,
        sandbox=True,
    ),
    ToolSpec(
        "sandbox_destroy",
        "Stop and remove this chat's temporary container environment and wipe its /workspace immediately.",
        _schema({}),
        sandbox_destroy,
        sandbox=True,
    ),
]
