"""System-Informationen, Versionierung und allgemeine Instanz-Einstellungen (/api/system)."""

from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import demo
from ..config import API_ROOT, get_settings
from ..db import get_db
from ..extensions import active
from ..localnet import local_lan_ips
from ..models import AuditLog, Setting, User
from ..security import current_user, has_admin_work, require_admin
from ..services import updater
from ..version import APP_NAME, APP_VERSION, ENGINE_VERSION, VERSION_LABEL

router = APIRouter(prefix="/api/system", tags=["system"])

_STARTED_MONO = time.monotonic()
_STARTED_AT = datetime.now(timezone.utc).isoformat()

_DOCKER_CACHE_TTL = 60.0
_docker_cache: tuple[float, dict] | None = None

_GIT_CACHE: tuple[str, str] | None = None

SYSTEM_SETTING_PREFIX = "system."
_DEFAULTS = {
    "instance_name": "Gimel",
    "update_channel": "stable",
    "auto_check_updates": "true",
    "default_language": "de",
}

LICENSE_NAME = "Gimel Non-Commercial Source License (v1.0)"
REPO_URL = "https://github.com/mxsp/gimel"
RELEASES_URL = "https://github.com/mxsp/gimel/releases"
WEBSITE_URL = "https://fyreflysystems.de/scientific/gimel/"
TELEMETRY_NOTICE = "Keine Telemetrie — 100% lokal"


def _repo_root() -> Path | None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / ".git").exists():
            return parent
    return None


def _git_info() -> tuple[str, str]:
    global _GIT_CACHE
    if _GIT_CACHE is not None:
        return _GIT_CACHE
    root = _repo_root()
    if root is None or shutil.which("git") is None:
        _GIT_CACHE = ("", "")
        return _GIT_CACHE

    def _run_git(args: list[str]) -> str:
        try:
            proc = subprocess.run(
                ["git", *args],
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=1.5,
                check=False,
            )
            return proc.stdout.strip() if proc.returncode == 0 else ""
        except Exception:  # noqa: BLE001
            return ""

    commit = _run_git(["rev-parse", "--short", "HEAD"])
    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    _GIT_CACHE = (commit, branch)
    return _GIT_CACHE


def _docker_status() -> dict:
    """Detect Docker CLI & daemon availability with a short timeout and 60s cache."""
    global _docker_cache
    now = time.monotonic()
    if _docker_cache is not None and (now - _docker_cache[0]) < _DOCKER_CACHE_TTL:
        return dict(_docker_cache[1])

    if shutil.which("docker") is None:
        res = {"installed": False, "version": "", "running": False}
        _docker_cache = (now, res)
        return dict(res)

    version = ""
    try:
        v_proc = subprocess.run(
            ["docker", "--version"],
            capture_output=True,
            text=True,
            timeout=1.5,
            check=False,
        )
        if v_proc.returncode == 0:
            raw = v_proc.stdout.strip()
            # e.g. "Docker version 27.3.1, build ce12230" -> "27.3.1"
            if "version " in raw:
                version = raw.split("version ", 1)[1].split(",", 1)[0].strip()
            else:
                version = raw
    except Exception:  # noqa: BLE001
        version = ""

    running = False
    try:
        i_proc = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True,
            text=True,
            timeout=1.5,
            check=False,
        )
        running = i_proc.returncode == 0
    except Exception:  # noqa: BLE001
        running = False

    res = {"installed": True, "version": version, "running": running}
    _docker_cache = (now, res)
    return dict(res)


def _safe_update_summary() -> dict:
    try:
        st = updater.check_for_update(force=False)
        return {
            "latest_version": st.latest_version,
            "latest_tag": st.latest_tag,
            "update_available": bool(st.update_available),
            "release_url": st.release_url or RELEASES_URL,
        }
    except Exception:  # noqa: BLE001
        return {
            "latest_version": None,
            "latest_tag": None,
            "update_available": False,
            "release_url": RELEASES_URL,
        }


def _read_system_settings(db: Session) -> dict:
    rows = (
        db.query(Setting)
        .filter(Setting.key.startswith(SYSTEM_SETTING_PREFIX))
        .all()
    )
    raw = {r.key[len(SYSTEM_SETTING_PREFIX) :]: r.value for r in rows}
    instance_name = (raw.get("instance_name") or _DEFAULTS["instance_name"]).strip() or "Gimel"
    update_channel = (raw.get("update_channel") or _DEFAULTS["update_channel"]).strip()
    if update_channel not in ("stable", "beta"):
        update_channel = "stable"
    auto_raw = (raw.get("auto_check_updates") or _DEFAULTS["auto_check_updates"]).strip().lower()
    auto_check_updates = auto_raw in ("1", "true", "yes", "on")
    lang = (raw.get("default_language") or _DEFAULTS["default_language"]).strip().lower()
    if lang not in ("de", "en"):
        lang = "de"
    return {
        "instance_name": instance_name,
        "update_channel": update_channel,
        "auto_check_updates": auto_check_updates,
        "default_language": lang,
        "telemetry_enabled": False,
        "telemetry_notice": TELEMETRY_NOTICE,
    }


class SystemSettingsPatch(BaseModel):
    instance_name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    update_channel: Optional[Literal["stable", "beta"]] = None
    auto_check_updates: Optional[bool] = None
    default_language: Optional[Literal["de", "en"]] = None


@router.get("/info")
def get_system_info(
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    settings = get_settings()
    plugin = active()
    is_demo = False if plugin else demo.is_demo(db)
    mode = "playground" if (os.environ.get("GIMEL_MODE") == "playground" or is_demo) else "production"
    install_kind = updater.detect_install_kind()
    git_commit, git_branch = _git_info() if install_kind == "git" else ("", "")
    is_admin = has_admin_work(user)
    db_backend = "postgresql" if settings.database_url.lower().startswith("postgres") else "sqlite"

    return {
        "app_name": APP_NAME,
        "version": APP_VERSION,
        "engine_version": ENGINE_VERSION,
        "version_label": VERSION_LABEL,
        "mode": mode,
        "demo": is_demo,
        "install_kind": install_kind,
        "git_commit": git_commit,
        "git_branch": git_branch,
        "python_version": platform.python_version(),
        "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "hostname": socket.gethostname(),
        "docker": _docker_status(),
        "localnet_only": bool(settings.localnet_only),
        "lan_ips": local_lan_ips(),
        "uptime_seconds": max(0, int(time.monotonic() - _STARTED_MONO)),
        "started_at": _STARTED_AT,
        "license": LICENSE_NAME,
        "repo_url": REPO_URL,
        "releases_url": RELEASES_URL,
        "website_url": WEBSITE_URL,
        "data_dir": str(API_ROOT) if is_admin else "",
        "database_backend": db_backend,
        "update": _safe_update_summary(),
    }


@router.get("/settings")
def get_system_settings(
    user: Annotated[User, Depends(current_user)],  # noqa: ARG001
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return _read_system_settings(db)


@router.patch("/settings")
def patch_system_settings(
    body: SystemSettingsPatch,
    actor: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    updates: dict[str, str] = {}
    if body.instance_name is not None:
        cleaned = body.instance_name.strip()
        if not cleaned:
            raise HTTPException(status_code=422, detail="Instanzname darf nicht leer sein.")
        updates["instance_name"] = cleaned
    if body.update_channel is not None:
        updates["update_channel"] = body.update_channel
    if body.auto_check_updates is not None:
        updates["auto_check_updates"] = "true" if body.auto_check_updates else "false"
    if body.default_language is not None:
        updates["default_language"] = body.default_language

    for k, val in updates.items():
        full_key = f"{SYSTEM_SETTING_PREFIX}{k}"
        row = db.get(Setting, full_key)
        if row is None:
            row = Setting(key=full_key, value=val, note="Systemeinstellung", updated_by=actor.email)
            db.add(row)
        else:
            row.value = val
            row.updated_by = actor.email

    if updates:
        db.add(
            AuditLog(
                actor=actor.email,
                action="system_settings_update",
                entity="system",
                entity_id="settings",
                detail=updates,
            )
        )
        db.commit()

    return _read_system_settings(db)
