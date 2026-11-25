"""Temporäre Container-Sandboxen für den Gimel-Assistenten.

Stellt pro Chat eine isolierte, kurzlebige Arbeitsumgebung (``/workspace``)
bereit, in der der Assistent Python-Skripte, Datenanalysen, Berechnungen,
Dateikonvertierungen oder HTML/SVG/CSV-Ausgaben ausführen kann — vollständig
getrennt vom Host-System und von Gimels Produktivdatenbank.

Unterstützte Backends:
- ``docker``: Gehärteter Wegwerf-Container (``--cap-drop ALL``, ``--read-only``,
  ``no-new-privileges``, Speicher-/CPU-/PID-Limits, standardmäßig ``--network none``).
- ``bwrap``: Linux-Namespace-Isolation über Bubblewrap (``--unshare-all``,
  ``--die-with-parent``, Nur-Lese-Systempfade, eigener ``/workspace``).
- ``auto``: Nutzt Docker wenn der Daemon erreichbar ist, sonst Bubblewrap.
  Fällt niemals still auf eine ungeschützte Host-Shell zurück.
"""

from __future__ import annotations

import atexit
import os
import re
try:
    import resource
except ImportError:  # Windows hat kein POSIX-resource-Modul (bwrap ist Linux-only)
    resource = None  # type: ignore[assignment]
import secrets
import shutil
import stat
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from . import settings as agent_settings

LABEL_MANAGED = "gimel.agentlab.sandbox"
LABEL_CHAT_ID = "gimel.agentlab.chat_id"
LABEL_USER_ID = "gimel.agentlab.user_id"
LABEL_SANDBOX_ID = "gimel.agentlab.sandbox_id"
LABEL_PID = "gimel.agentlab.pid"

MAX_PIDS = 256
MAX_WORKSPACE_BYTES = 128 * 1024 * 1024  # Standard 128 MB, konfigurierbar bis 16 GB
MAX_WRITE_BYTES = 16 * 1024 * 1024       # Bis 16 MB je direktem Schreibvorgang
MAX_FILES = 2000
MAX_OUTPUT_CHARS = 64 * 1024
MAX_COMMAND_CHARS = 20_000
MAX_CODE_CHARS = 200_000

SANDBOX_PROFILES: dict[str, dict[str, Any]] = {
    "standard": {
        "label": "Standard",
        "summary": "Leicht & sparsam für schnelle Skripte und kleine Auswertungen.",
        "values": {
            "agent_sandbox_profile": "standard",
            "agent_sandbox_memory_mb": "512",
            "agent_sandbox_cpus": "1",
            "agent_sandbox_timeout_s": "30",
            "agent_sandbox_ttl_min": "20",
            "agent_sandbox_workspace_mb": "128",
            "agent_sandbox_tmpfs_mb": "128",
            "agent_sandbox_pids_limit": "256",
            "agent_sandbox_max_files": "2000",
            "agent_sandbox_output_kb": "64",
            "agent_sandbox_allow_swap": "false",
            "agent_sandbox_allow_exec_tmp": "false",
        },
    },
    "heavy": {
        "label": "Intensiv",
        "summary": "Datenanalysen, größere Datensätze, Simulationen und längere Skripte.",
        "values": {
            "agent_sandbox_profile": "heavy",
            "agent_sandbox_memory_mb": "2048",
            "agent_sandbox_cpus": "2",
            "agent_sandbox_timeout_s": "180",
            "agent_sandbox_ttl_min": "60",
            "agent_sandbox_workspace_mb": "512",
            "agent_sandbox_tmpfs_mb": "256",
            "agent_sandbox_pids_limit": "512",
            "agent_sandbox_max_files": "10000",
            "agent_sandbox_output_kb": "128",
            "agent_sandbox_allow_swap": "true",
            "agent_sandbox_allow_exec_tmp": "true",
        },
    },
    "extensive": {
        "label": "Extensiv (Hard Work)",
        "summary": "Maximale Leistung für schwere Builds, ML, Optimierung, Compiler & große Datenmengen.",
        "values": {
            "agent_sandbox_profile": "extensive",
            "agent_sandbox_memory_mb": "8192",
            "agent_sandbox_cpus": "4",
            "agent_sandbox_timeout_s": "600",
            "agent_sandbox_ttl_min": "180",
            "agent_sandbox_workspace_mb": "2048",
            "agent_sandbox_tmpfs_mb": "1024",
            "agent_sandbox_pids_limit": "1024",
            "agent_sandbox_max_files": "25000",
            "agent_sandbox_output_kb": "256",
            "agent_sandbox_allow_swap": "true",
            "agent_sandbox_allow_exec_tmp": "true",
        },
    },
}

_IMAGE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,127}$")
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")

_ROOT_TMP = Path(tempfile.gettempdir()) / "gimel-agent-sandboxes"


class SandboxError(RuntimeError):
    """Fachlicher oder Laufzeitfehler der Container-Sandbox."""

    def __init__(self, detail: str, status: int = 422) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status = status


@dataclass
class SandboxSession:
    sandbox_id: str
    chat_id: int
    user_id: int
    backend: str  # "docker" | "bwrap"
    image: str
    container_name: str
    container_id: str
    workspace_dir: Path
    network_enabled: bool
    memory_mb: int
    cpus: float
    ttl_minutes: int
    created_at: datetime
    last_used_at: datetime
    profile: str = "standard"
    workspace_mb: int = 128
    tmpfs_mb: int = 128
    pids_limit: int = MAX_PIDS
    max_files: int = MAX_FILES
    output_kb: int = 64
    allow_swap: bool = False
    allow_exec_tmp: bool = False
    gpu_enabled: bool = False
    command_count: int = 0
    status: str = "running"
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def expires_at(self) -> datetime:
        return self.last_used_at + timedelta(minutes=max(1, self.ttl_minutes))

    def is_expired(self, now: datetime | None = None) -> bool:
        ref = now or _now()
        return ref >= self.expires_at


_LOCK = threading.RLock()
_SESSIONS: dict[int, SandboxSession] = {}
_REAPER_STARTED = False
_REAPER_STOP = threading.Event()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _clip(text: str, limit: int = MAX_OUTPUT_CHARS) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit] + "\n… (Ausgabe gekürzt)", True


def _validate_image(image: str) -> str:
    clean = (image or "").strip()
    if not clean or not _IMAGE_RE.fullmatch(clean):
        raise SandboxError(
            "Ungültiger Container-Image-Name. Erlaubt sind z. B. „python:3.11-slim“ oder „ubuntu:22.04“."
        )
    if ".." in clean or clean.startswith("-"):
        raise SandboxError("Ungültiger Container-Image-Name.")
    return clean


def _normalize_rel_path(raw: str, *, allow_root: bool = False) -> str:
    text = (raw or "").strip().replace("\\", "/")
    if "\x00" in text:
        raise SandboxError("Ungültiger Dateipfad.")
    if text == "/workspace" or text == "/workspace/":
        text = "."
    elif text.startswith("/workspace/"):
        text = text[len("/workspace/"):]
    elif text.startswith("/"):
        raise SandboxError("Absolute Pfade außerhalb von /workspace sind nicht erlaubt.")
    if not text or text == ".":
        if allow_root:
            return "."
        raise SandboxError("Bitte einen relativen Dateipfad innerhalb von /workspace angeben.")
    return text


def _resolve_workspace_path(workspace_dir: Path, raw: str, *, allow_root: bool = False) -> Path:
    rel = _normalize_rel_path(raw, allow_root=allow_root)
    base = workspace_dir.resolve()
    candidate = (base / rel).resolve()
    if not candidate.is_relative_to(base):
        raise SandboxError("Pfad verlässt das isolierte /workspace-Verzeichnis.")
    return candidate


def _workspace_stats(workspace_dir: Path) -> tuple[int, int]:
    """Zählt Dateien und Gesamtgröße (Bytes) im temporären Arbeitsverzeichnis."""
    if not workspace_dir.exists():
        return 0, 0
    base = workspace_dir.resolve()
    count = 0
    total_bytes = 0
    for root, _dirs, files in os.walk(base, followlinks=False):
        for fname in files:
            fpath = Path(root) / fname
            try:
                if fpath.is_symlink():
                    continue
                st = fpath.stat()
                count += 1
                total_bytes += st.st_size
            except OSError:
                continue
    return count, total_bytes


def _list_workspace_entries(
    workspace_dir: Path, *, subdir: str = ".", max_entries: int = 200
) -> list[dict[str, Any]]:
    base = workspace_dir.resolve()
    target = _resolve_workspace_path(base, subdir, allow_root=True)
    if not target.exists():
        return []
    if not target.is_dir():
        raise SandboxError(f"„{subdir}“ ist kein Verzeichnis.")
    entries: list[dict[str, Any]] = []
    for root, dirs, files in os.walk(target, followlinks=False):
        dirs.sort()
        files.sort()
        root_path = Path(root)
        for dname in dirs:
            dpath = root_path / dname
            if dpath.is_symlink():
                continue
            rel = dpath.relative_to(base).as_posix()
            entries.append({"path": rel, "kind": "dir", "size": 0, "updated_at": None})
            if len(entries) >= max_entries:
                return entries
        for fname in files:
            fpath = root_path / fname
            if fpath.is_symlink():
                continue
            try:
                st = fpath.stat()
            except OSError:
                continue
            rel = fpath.relative_to(base).as_posix()
            entries.append({
                "path": rel,
                "kind": "file",
                "size": st.st_size,
                "updated_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            })
            if len(entries) >= max_entries:
                return entries
    return entries


def _snapshot_files(workspace_dir: Path) -> dict[str, tuple[int, float]]:
    snap: dict[str, tuple[int, float]] = {}
    if not workspace_dir.exists():
        return snap
    base = workspace_dir.resolve()
    for root, _dirs, files in os.walk(base, followlinks=False):
        for fname in files:
            fpath = Path(root) / fname
            if fpath.is_symlink():
                continue
            try:
                st = fpath.stat()
                rel = fpath.relative_to(base).as_posix()
                snap[rel] = (st.st_size, st.st_mtime)
            except OSError:
                continue
    return snap


# --------------------------------------------------------------------------
# Runtime-Erkennung (Docker & Bubblewrap)
# --------------------------------------------------------------------------
def _docker_bin() -> str | None:
    return shutil.which("docker")


def _bwrap_bin() -> str | None:
    return shutil.which("bwrap")


def probe_docker() -> dict[str, Any]:
    binary = _docker_bin()
    if not binary:
        return {"available": False, "version": "", "images": [], "detail": "docker nicht installiert"}
    try:
        proc = subprocess.run(
            [binary, "info", "--format", "{{.ServerVersion}}"],
            capture_output=True, text=True, timeout=4, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "version": "", "images": [], "detail": f"Docker-Daemon nicht erreichbar: {exc}"}
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip().splitlines()
        msg = err[-1] if err else "Docker-Daemon nicht erreichbar"
        return {"available": False, "version": "", "images": [], "detail": msg}
    version = proc.stdout.strip()
    images: list[str] = []
    try:
        img_proc = subprocess.run(
            [binary, "images", "--format", "{{.Repository}}:{{.Tag}}"],
            capture_output=True, text=True, timeout=4, check=False,
        )
        if img_proc.returncode == 0:
            for line in img_proc.stdout.splitlines():
                tag = line.strip()
                if tag and "<none>" not in tag and tag not in images:
                    images.append(tag)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {"available": True, "version": version, "images": images[:40], "detail": f"Docker {version}"}


def probe_bwrap() -> dict[str, Any]:
    binary = _bwrap_bin()
    if not binary:
        return {"available": False, "version": "", "detail": "bubblewrap (bwrap) nicht installiert"}
    version = ""
    try:
        v = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=3, check=False)
        if v.returncode == 0:
            version = v.stdout.strip()
        smoke = subprocess.run(
            [
                binary, "--unshare-all", "--die-with-parent",
                "--ro-bind", "/usr", "/usr",
                "--ro-bind", "/bin", "/bin",
                "--ro-bind", "/lib", "/lib",
                *(["--ro-bind", "/lib64", "/lib64"] if Path("/lib64").exists() else []),
                "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
                "/bin/true",
            ],
            capture_output=True, text=True, timeout=4, check=False,
        )
        if smoke.returncode != 0:
            msg = (smoke.stderr or smoke.stdout or "Namespace-Test fehlgeschlagen").strip()
            return {"available": False, "version": version, "detail": msg}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "version": version, "detail": f"bwrap-Test fehlgeschlagen: {exc}"}
    return {"available": True, "version": version, "detail": version or "bwrap verfügbar"}


def probe_host_resources() -> dict[str, Any]:
    cpus = os.cpu_count() or 1
    mem_mb = 0
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    mem_mb = kb // 1024
                    break
    except (OSError, ValueError, IndexError):
        pass
    gpu_name = ""
    gpu_available = False
    nvsmi = shutil.which("nvidia-smi")
    if nvsmi:
        try:
            proc = subprocess.run(
                [nvsmi, "--query-gpu=name,memory.total", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=3, check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                gpu_available = True
                gpu_name = proc.stdout.strip().splitlines()[0].strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
    return {
        "cpus": cpus,
        "memory_mb": mem_mb,
        "gpu_available": gpu_available,
        "gpu_name": gpu_name,
    }


def _config(db: Session | None) -> dict[str, Any]:
    if db is None:
        return {
            "enabled": True,
            "profile": "standard",
            "backend": "auto",
            "image": "python:3.11-slim",
            "memory_mb": 512,
            "cpus": 1.0,
            "timeout_s": 30,
            "ttl_min": 20,
            "workspace_mb": 128,
            "tmpfs_mb": 128,
            "pids_limit": MAX_PIDS,
            "max_files": MAX_FILES,
            "output_kb": 64,
            "max_concurrent": 4,
            "allow_swap": False,
            "allow_exec_tmp": False,
            "network": False,
            "gpu": False,
        }
    return {
        "enabled": agent_settings.get_bool(db, "agent_sandbox_enabled"),
        "profile": agent_settings.get(db, "agent_sandbox_profile").strip().lower() or "standard",
        "backend": agent_settings.get(db, "agent_sandbox_backend").strip().lower() or "auto",
        "image": agent_settings.get(db, "agent_sandbox_image").strip() or "python:3.11-slim",
        "memory_mb": max(128, min(agent_settings.get_int(db, "agent_sandbox_memory_mb"), 32768)),
        "cpus": max(0.25, min(agent_settings.get_float(db, "agent_sandbox_cpus"), 32.0)),
        "timeout_s": max(5, min(agent_settings.get_int(db, "agent_sandbox_timeout_s"), 3600)),
        "ttl_min": max(2, min(agent_settings.get_int(db, "agent_sandbox_ttl_min"), 1440)),
        "workspace_mb": max(32, min(agent_settings.get_int(db, "agent_sandbox_workspace_mb"), 16384)),
        "tmpfs_mb": max(32, min(agent_settings.get_int(db, "agent_sandbox_tmpfs_mb"), 8192)),
        "pids_limit": max(32, min(agent_settings.get_int(db, "agent_sandbox_pids_limit"), 4096)),
        "max_files": max(100, min(agent_settings.get_int(db, "agent_sandbox_max_files"), 50000)),
        "output_kb": max(16, min(agent_settings.get_int(db, "agent_sandbox_output_kb"), 512)),
        "max_concurrent": max(1, min(agent_settings.get_int(db, "agent_sandbox_max_concurrent"), 20)),
        "allow_swap": agent_settings.get_bool(db, "agent_sandbox_allow_swap"),
        "allow_exec_tmp": agent_settings.get_bool(db, "agent_sandbox_allow_exec_tmp"),
        "network": agent_settings.get_bool(db, "agent_sandbox_network"),
        "gpu": agent_settings.get_bool(db, "agent_sandbox_gpu"),
    }


def _select_backend(requested: str) -> str:
    req = (requested or "auto").strip().lower()
    if req == "docker":
        info = probe_docker()
        if not info["available"]:
            raise SandboxError(f"Docker-Backend nicht verfügbar: {info['detail']}", status=503)
        return "docker"
    if req == "bwrap":
        info = probe_bwrap()
        if not info["available"]:
            raise SandboxError(f"Bubblewrap-Backend nicht verfügbar: {info['detail']}", status=503)
        return "bwrap"
    docker_info = probe_docker()
    if docker_info["available"]:
        return "docker"
    bwrap_info = probe_bwrap()
    if bwrap_info["available"]:
        return "bwrap"
    raise SandboxError(
        "Keine Container-Laufzeit verfügbar. Weder Docker noch Bubblewrap (bwrap) konnten gestartet werden.",
        status=503,
    )


def _docker_list_running() -> list[dict[str, Any]]:
    """Liest laufende Gimel-Sandbox-Container direkt vom Docker-Daemon (prozessübergreifend)."""
    binary = _docker_bin()
    if not binary:
        return []
    fmt = (
        "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t"
        '{{.Label "' + LABEL_CHAT_ID + '"}}\t'
        '{{.Label "' + LABEL_USER_ID + '"}}\t'
        '{{.Label "' + LABEL_SANDBOX_ID + '"}}'
    )
    try:
        proc = subprocess.run(
            [binary, "ps", "--filter", f"label={LABEL_MANAGED}=1", "--filter", "status=running", "--format", fmt],
            capture_output=True, text=True, timeout=4, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode != 0:
        return []
    rows: list[dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 4 or not parts[1].strip():
            continue
        cid = parts[0].strip()[:12]
        cname = parts[1].strip()
        image = parts[2].strip()
        uptime = parts[3].strip()
        try:
            chat_id = int(parts[4].strip()) if len(parts) > 4 and parts[4].strip() else 0
        except ValueError:
            chat_id = 0
        try:
            owner_id = int(parts[5].strip()) if len(parts) > 5 and parts[5].strip() else 0
        except ValueError:
            owner_id = 0
        sb_id = parts[6].strip() if len(parts) > 6 else ""
        rows.append({
            "active": True,
            "sandbox_id": sb_id,
            "chat_id": chat_id,
            "user_id": owner_id,
            "profile": "",
            "backend": "docker",
            "image": image,
            "container_name": cname,
            "container_id": cid,
            "network_enabled": False,
            "memory_mb": 0,
            "cpus": 0.0,
            "ttl_minutes": 0,
            "remaining_seconds": 0,
            "command_count": 0,
            "file_count": 0,
            "workspace_bytes": 0,
            "created_at": None,
            "last_used_at": None,
            "expires_at": None,
            "status": uptime or "running",
            "managed_locally": False,
        })
    return rows


def stop_container_by_name(container_name: str, *, user_id: int | None = None, is_admin: bool = False) -> dict[str, Any]:
    """Stoppt einen laufenden Gimel-Sandbox-Container anhand seines Namens (auch prozessübergreifend)."""
    clean = (container_name or "").strip()
    if not clean or not (clean.startswith("gimel-agent-sbx-") or clean.startswith("gimel-bwrap-")):
        raise SandboxError("Ungültiger Container-Name.", status=422)
    with _LOCK:
        for cid, session in list(_SESSIONS.items()):
            if session.container_name == clean:
                if not is_admin and user_id is not None and session.user_id != user_id:
                    raise SandboxError("Keine Berechtigung für diesen Container.", status=403)
                return destroy_sandbox(cid)
    # Prüfen, ob ein externer (z. B. vom anderen Gimel-Prozess gestarteter) Docker-Container existiert
    for item in _docker_list_running():
        if item["container_name"] == clean:
            if not is_admin and user_id is not None and item["user_id"] != user_id:
                raise SandboxError("Keine Berechtigung für diesen Container.", status=403)
            _docker_remove_container(clean)
            return {
                "destroyed": True,
                "chat_id": item["chat_id"],
                "sandbox_id": item["sandbox_id"],
                "backend": "docker",
                "container_name": clean,
                "command_count": 0,
            }
    return {"destroyed": False, "container_name": clean, "message": "Container nicht gefunden."}


def runtime_info(db: Session | None = None, *, user_id: int | None = None, is_admin: bool = False) -> dict[str, Any]:
    cleanup_expired()
    cfg = _config(db)
    docker_info = probe_docker()
    bwrap_info = probe_bwrap()
    effective = ""
    if cfg["backend"] == "docker" and docker_info["available"]:
        effective = "docker"
    elif cfg["backend"] == "bwrap" and bwrap_info["available"]:
        effective = "bwrap"
    elif cfg["backend"] == "auto":
        effective = "docker" if docker_info["available"] else ("bwrap" if bwrap_info["available"] else "")
    with _LOCK:
        sessions = list(_SESSIONS.values())
    seen_names: set[str] = set()
    own_sessions: list[dict[str, Any]] = []
    for s in sessions:
        seen_names.add(s.container_name)
        if is_admin or (user_id is not None and s.user_id == user_id):
            row = session_out(s, include_files=False)
            row["managed_locally"] = True
            own_sessions.append(row)
    external_total = 0
    if docker_info["available"]:
        for ext in _docker_list_running():
            if ext["container_name"] in seen_names:
                continue
            external_total += 1
            if is_admin or (user_id is not None and ext["user_id"] == user_id):
                own_sessions.append(ext)
    return {
        "enabled": cfg["enabled"],
        "profile": cfg["profile"],
        "configured_backend": cfg["backend"],
        "effective_backend": effective,
        "available": bool(effective),
        "default_image": cfg["image"],
        "memory_mb": cfg["memory_mb"],
        "cpus": cfg["cpus"],
        "timeout_s": cfg["timeout_s"],
        "ttl_min": cfg["ttl_min"],
        "workspace_mb": cfg["workspace_mb"],
        "tmpfs_mb": cfg["tmpfs_mb"],
        "pids_limit": cfg["pids_limit"],
        "max_files": cfg["max_files"],
        "output_kb": cfg["output_kb"],
        "max_concurrent": cfg["max_concurrent"],
        "allow_swap": cfg["allow_swap"],
        "allow_exec_tmp": cfg["allow_exec_tmp"],
        "network_enabled": cfg["network"],
        "gpu_enabled": cfg["gpu"],
        "host": probe_host_resources(),
        "profiles": SANDBOX_PROFILES,
        "backends": {
            "docker": docker_info,
            "bwrap": bwrap_info,
        },
        "active_count": len(sessions) + external_total,
        "sessions": own_sessions,
    }


def session_out(session: SandboxSession, *, include_files: bool = True) -> dict[str, Any]:
    now = _now()
    file_count, total_bytes = _workspace_stats(session.workspace_dir)
    remaining_s = max(0, int((session.expires_at - now).total_seconds()))
    out: dict[str, Any] = {
        "active": session.status == "running",
        "sandbox_id": session.sandbox_id,
        "chat_id": session.chat_id,
        "profile": session.profile,
        "backend": session.backend,
        "image": session.image,
        "container_name": session.container_name,
        "container_id": session.container_id[:12] if session.container_id else "",
        "network_enabled": session.network_enabled,
        "memory_mb": session.memory_mb,
        "cpus": session.cpus,
        "workspace_mb": session.workspace_mb,
        "tmpfs_mb": session.tmpfs_mb,
        "pids_limit": session.pids_limit,
        "max_files": session.max_files,
        "allow_swap": session.allow_swap,
        "allow_exec_tmp": session.allow_exec_tmp,
        "gpu_enabled": session.gpu_enabled,
        "ttl_minutes": session.ttl_minutes,
        "remaining_seconds": remaining_s,
        "command_count": session.command_count,
        "file_count": file_count,
        "workspace_bytes": total_bytes,
        "created_at": _iso(session.created_at),
        "last_used_at": _iso(session.last_used_at),
        "expires_at": _iso(session.expires_at),
        "status": session.status,
    }
    if include_files:
        out["files"] = _list_workspace_entries(session.workspace_dir, max_entries=100)
    return out


# --------------------------------------------------------------------------
# Container-Lebenszyklus (Docker / Bubblewrap)
# --------------------------------------------------------------------------
def _ensure_reaper() -> None:
    global _REAPER_STARTED
    if _REAPER_STARTED:
        return
    _REAPER_STARTED = True

    def _loop() -> None:
        while not _REAPER_STOP.wait(60.0):
            try:
                cleanup_expired()
            except Exception:  # noqa: BLE001
                pass

    t = threading.Thread(target=_loop, name="agentlab-sandbox-reaper", daemon=True)
    t.start()


def _create_workspace_dir(chat_id: int, sandbox_id: str) -> Path:
    _ROOT_TMP.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(_ROOT_TMP, 0o700)
    except OSError:
        pass
    ws = _ROOT_TMP / f"c{chat_id}-{sandbox_id}"
    ws.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(ws, 0o755)
    except OSError:
        pass
    return ws


def _docker_start_container(
    *,
    chat_id: int,
    user_id: int,
    sandbox_id: str,
    image: str,
    workspace_dir: Path,
    memory_mb: int,
    cpus: float,
    network_enabled: bool,
    tmpfs_mb: int = 128,
    pids_limit: int = MAX_PIDS,
    allow_swap: bool = False,
    allow_exec_tmp: bool = False,
    gpu_enabled: bool = False,
) -> tuple[str, str]:
    binary = _docker_bin()
    if not binary:
        raise SandboxError("Docker ist nicht installiert.", status=503)
    container_name = f"gimel-agent-sbx-c{chat_id}-{sandbox_id}"
    tmpfs_opts = f"rw,exec,nosuid,size={tmpfs_mb}m" if allow_exec_tmp else f"rw,noexec,nosuid,size={tmpfs_mb}m"
    mem_swap_mb = memory_mb * 2 if allow_swap else memory_mb
    cmd = [
        binary, "run", "-d",
        "--name", container_name,
        "--hostname", f"gimel-sbx-{chat_id}",
        "--label", f"{LABEL_MANAGED}=1",
        "--label", f"{LABEL_CHAT_ID}={chat_id}",
        "--label", f"{LABEL_USER_ID}={user_id}",
        "--label", f"{LABEL_SANDBOX_ID}={sandbox_id}",
        "--label", f"{LABEL_PID}={os.getpid()}",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--read-only",
        "--tmpfs", f"/tmp:{tmpfs_opts}",
        "--pids-limit", str(pids_limit),
        "--memory", f"{memory_mb}m",
        "--memory-swap", f"{mem_swap_mb}m",
        "--cpus", f"{cpus:g}",
        "--network", "bridge" if network_enabled else "none",
        "-v", f"{workspace_dir.resolve()}:/workspace:rw",
        "-w", "/workspace",
        "-e", "HOME=/workspace",
        "-e", "TMPDIR=/tmp",
        "-e", "PYTHONUSERBASE=/workspace/.local",
        "-e", "PIP_CACHE_DIR=/tmp/pip-cache",
        "-e", "PATH=/workspace/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "-e", "PYTHONDONTWRITEBYTECODE=1",
        "-e", "PYTHONUNBUFFERED=1",
        "-e", "LANG=C.UTF-8",
        "-e", "LC_ALL=C.UTF-8",
    ]
    if gpu_enabled:
        cmd.extend(["--gpus", "all"])
    if hasattr(os, "getuid"):
        cmd.extend(["--user", f"{os.getuid()}:{os.getgid()}"])
    cmd.extend([image, "sh", "-c", "while true; do sleep 3600; done"])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    except subprocess.TimeoutExpired as exc:
        _docker_remove_container(container_name)
        raise SandboxError("Container-Start hat das Zeitlimit überschritten.", status=504) from exc
    except OSError as exc:
        raise SandboxError(f"Docker konnte nicht gestartet werden: {exc}", status=503) from exc
    if proc.returncode != 0:
        _docker_remove_container(container_name)
        err = (proc.stderr or proc.stdout or "").strip()
        raise SandboxError(f"Container konnte nicht gestartet werden ({image}): {err}", status=502)
    container_id = proc.stdout.strip()
    return container_name, container_id


def _docker_is_running(container_name: str) -> bool:
    binary = _docker_bin()
    if not binary or not container_name:
        return False
    try:
        proc = subprocess.run(
            [binary, "inspect", "-f", "{{.State.Running}}", container_name],
            capture_output=True, text=True, timeout=5, check=False,
        )
        return proc.returncode == 0 and proc.stdout.strip().lower() == "true"
    except (OSError, subprocess.TimeoutExpired):
        return False


def _docker_remove_container(container_name: str) -> None:
    binary = _docker_bin()
    if not binary or not container_name:
        return
    try:
        subprocess.run(
            [binary, "rm", "-f", container_name],
            capture_output=True, text=True, timeout=15, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def _teardown_session(session: SandboxSession) -> None:
    session.status = "destroyed"
    if session.backend == "docker" and session.container_name:
        _docker_remove_container(session.container_name)
    try:
        if session.workspace_dir.exists():
            shutil.rmtree(session.workspace_dir, ignore_errors=True)
    except OSError:
        pass


def get_sandbox(chat_id: int) -> SandboxSession | None:
    cleanup_expired()
    with _LOCK:
        session = _SESSIONS.get(chat_id)
        if session is None:
            return None
        if session.backend == "docker" and not _docker_is_running(session.container_name):
            _SESSIONS.pop(chat_id, None)
            _teardown_session(session)
            return None
        return session


def ensure_sandbox(
    db: Session | None,
    chat_id: int,
    user_id: int,
    *,
    image: str | None = None,
    backend_override: str | None = None,
    recreate: bool = False,
) -> tuple[SandboxSession, bool]:
    """Gibt die laufende Sandbox des Chats zurück oder startet eine neue.

    Mit ``recreate=True`` wird ein laufender Container mit den aktuellen
    Einstellungen (z. B. nach Wechsel auf „Extensiv / Hard Work“) neu erstellt,
    während bestehende Dateien im ``/workspace`` erhalten bleiben.

    Rückgabe: ``(session, created)``.
    """
    cfg = _config(db)
    if not cfg["enabled"]:
        raise SandboxError("Die Container-Sandbox ist in den Einstellungen ausgeschaltet.", status=409)
    if image is not None and str(image).strip():
        _validate_image(str(image))
    cleanup_expired()
    _ensure_reaper()

    with _LOCK:
        preserved_ws: Path | None = None
        existing = _SESSIONS.get(chat_id)
        if existing is not None:
            if recreate:
                _SESSIONS.pop(chat_id, None)
                with existing.lock:
                    existing.status = "destroyed"
                    if existing.backend == "docker" and existing.container_name:
                        _docker_remove_container(existing.container_name)
                    if existing.workspace_dir.exists():
                        preserved_ws = existing.workspace_dir
            elif existing.backend == "docker" and not _docker_is_running(existing.container_name):
                _SESSIONS.pop(chat_id, None)
                _teardown_session(existing)
            else:
                existing.last_used_at = _now()
                return existing, False

        if len(_SESSIONS) >= cfg["max_concurrent"]:
            if preserved_ws is not None:
                shutil.rmtree(preserved_ws, ignore_errors=True)
            raise SandboxError(
                f"Höchstzahl gleichzeitiger Container ({cfg['max_concurrent']}) erreicht. "
                "Bitte einen laufenden Container beenden oder warten.",
                status=429,
            )

        backend = _select_backend(backend_override or cfg["backend"])
        chosen_image = _validate_image(image or cfg["image"]) if backend == "docker" else "host-ro (bwrap)"
        sandbox_id = secrets.token_hex(6)
        workspace_dir = preserved_ws if preserved_ws is not None else _create_workspace_dir(chat_id, sandbox_id)

        try:
            if backend == "docker":
                cname, cid = _docker_start_container(
                    chat_id=chat_id,
                    user_id=user_id,
                    sandbox_id=sandbox_id,
                    image=chosen_image,
                    workspace_dir=workspace_dir,
                    memory_mb=cfg["memory_mb"],
                    cpus=cfg["cpus"],
                    network_enabled=cfg["network"],
                    tmpfs_mb=cfg["tmpfs_mb"],
                    pids_limit=cfg["pids_limit"],
                    allow_swap=cfg["allow_swap"],
                    allow_exec_tmp=cfg["allow_exec_tmp"],
                    gpu_enabled=cfg["gpu"],
                )
            else:
                cname = f"gimel-bwrap-c{chat_id}-{sandbox_id}"
                cid = ""
        except Exception:
            if preserved_ws is None:
                shutil.rmtree(workspace_dir, ignore_errors=True)
            raise

        now = _now()
        session = SandboxSession(
            sandbox_id=sandbox_id,
            chat_id=chat_id,
            user_id=user_id,
            backend=backend,
            image=chosen_image,
            container_name=cname,
            container_id=cid,
            workspace_dir=workspace_dir,
            network_enabled=cfg["network"],
            memory_mb=cfg["memory_mb"],
            cpus=cfg["cpus"],
            ttl_minutes=cfg["ttl_min"],
            created_at=now,
            last_used_at=now,
            profile=cfg["profile"],
            workspace_mb=cfg["workspace_mb"],
            tmpfs_mb=cfg["tmpfs_mb"],
            pids_limit=cfg["pids_limit"],
            max_files=cfg["max_files"],
            output_kb=cfg["output_kb"],
            allow_swap=cfg["allow_swap"],
            allow_exec_tmp=cfg["allow_exec_tmp"],
            gpu_enabled=cfg["gpu"] if backend == "docker" else False,
        )
        _SESSIONS[chat_id] = session
        return session, True


def destroy_sandbox(chat_id: int) -> dict[str, Any]:
    with _LOCK:
        session = _SESSIONS.pop(chat_id, None)
    if session is None:
        return {"destroyed": False, "chat_id": chat_id, "message": "Kein aktiver Container für diesen Chat."}
    with session.lock:
        info = {
            "destroyed": True,
            "chat_id": chat_id,
            "sandbox_id": session.sandbox_id,
            "backend": session.backend,
            "container_name": session.container_name,
            "command_count": session.command_count,
        }
        _teardown_session(session)
    return info


def cleanup_expired() -> int:
    now = _now()
    expired: list[SandboxSession] = []
    with _LOCK:
        for cid, session in list(_SESSIONS.items()):
            if session.is_expired(now):
                expired.append(_SESSIONS.pop(cid))
    for session in expired:
        with session.lock:
            _teardown_session(session)
    return len(expired)


def cleanup_all() -> int:
    with _LOCK:
        sessions = list(_SESSIONS.values())
        _SESSIONS.clear()
    for session in sessions:
        try:
            _teardown_session(session)
        except Exception:  # noqa: BLE001
            pass
    return len(sessions)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def cleanup_orphans() -> int:
    """Entfernt verwaiste Gimel-Sandbox-Container früherer, nicht mehr laufender Prozesse."""
    binary = _docker_bin()
    if not binary:
        return 0
    removed = 0
    try:
        proc = subprocess.run(
            [
                binary, "ps", "-a",
                "--filter", f"label={LABEL_MANAGED}=1",
                "--format", "{{.Names}}\t{{.Label \"" + LABEL_PID + "\"}}",
            ],
            capture_output=True, text=True, timeout=6, check=False,
        )
        if proc.returncode != 0:
            return 0
        for line in proc.stdout.splitlines():
            parts = line.strip().split("\t")
            if not parts or not parts[0]:
                continue
            cname = parts[0]
            try:
                owner_pid = int(parts[1]) if len(parts) > 1 and parts[1].strip() else 0
            except ValueError:
                owner_pid = 0
            if owner_pid == 0 or not _pid_alive(owner_pid):
                _docker_remove_container(cname)
                removed += 1
    except (OSError, subprocess.TimeoutExpired):
        return 0
    return removed


atexit.register(cleanup_all)


# --------------------------------------------------------------------------
# Befehlsausführung & Dateizugriff innerhalb der temporären Umgebung
# --------------------------------------------------------------------------
def _clean_env(env: dict[str, Any] | None) -> dict[str, str]:
    if not env:
        return {}
    out: dict[str, str] = {}
    for k, v in env.items():
        key = str(k).strip()
        if not _ENV_KEY_RE.fullmatch(key):
            raise SandboxError(f"Ungültiger Umgebungsname „{key}“.")
        if key in ("PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH"):
            continue
        out[key] = str(v)[:2000]
        if len(out) >= 20:
            break
    return out


def _container_workdir(workspace_dir: Path, workdir: str) -> str:
    resolved = _resolve_workspace_path(workspace_dir, workdir, allow_root=True)
    if not resolved.exists():
        raise SandboxError(f"Arbeitsverzeichnis „{workdir}“ existiert nicht in /workspace.")
    if not resolved.is_dir():
        raise SandboxError(f"„{workdir}“ ist kein Verzeichnis.")
    rel = resolved.relative_to(workspace_dir.resolve()).as_posix()
    return "/workspace" if rel == "." else f"/workspace/{rel}"


def _exec_in_docker(
    session: SandboxSession,
    command: str,
    *,
    container_workdir: str,
    timeout_s: int,
    env: dict[str, str],
) -> tuple[int, str, str, bool]:
    binary = _docker_bin()
    if not binary:
        raise SandboxError("Docker ist nicht verfügbar.", status=503)
    cmd = [binary, "exec", "-i", "-w", container_workdir]
    for k, v in env.items():
        cmd.extend(["-e", f"{k}={v}"])
    # Wenn GNU/BusyBox timeout im Container vorhanden ist, bricht der Prozess im
    # Container hart ab, statt nach dem Host-Timeout als Waise weiterzulaufen.
    wrapper = (
        'if command -v timeout >/dev/null 2>&1; then '
        'exec timeout -k 2 "$1" sh -c "$2"; '
        'else exec sh -c "$2"; fi'
    )
    cmd.extend([session.container_name, "sh", "-c", wrapper, "_", str(timeout_s), command])
    timed_out = False
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout_s + 4, check=False,
        )
        rc = proc.returncode
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        if rc == 124:
            timed_out = True
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        rc = 124
        stdout = (exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""))
        stderr = (exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or ""))
    return rc, stdout, stderr, timed_out


def _bwrap_preexec(
    timeout_s: int,
    max_fsize_bytes: int,
    memory_mb: int = 512,
    pids_limit: int = MAX_PIDS,
) -> Any:
    if resource is None:
        return None

    def _apply() -> None:
        if resource is None:
            return
        try:
            cpu = max(5, timeout_s + 2)
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 2))
        except (ValueError, OSError):
            pass
        try:
            resource.setrlimit(resource.RLIMIT_FSIZE, (max_fsize_bytes, max_fsize_bytes))
        except (ValueError, OSError):
            pass
        try:
            as_bytes = max(1024, int(memory_mb) * 2) * 1024 * 1024
            soft_as, hard_as = resource.getrlimit(resource.RLIMIT_AS)
            limit_as = min(as_bytes, hard_as) if hard_as > 0 else as_bytes
            if soft_as <= 0 or limit_as < soft_as:
                resource.setrlimit(resource.RLIMIT_AS, (limit_as, limit_as))
        except (ValueError, OSError):
            pass
        try:
            # RLIMIT_NPROC zählt auf Linux pro realer UID (inkl. Host-Threads); daher nur sanfte Obergrenze über aktuellem Stand.
            soft_np, hard_np = resource.getrlimit(resource.RLIMIT_NPROC)
            cap_np = max(4096, int(pids_limit) * 16)
            if (hard_np <= 0 or cap_np < hard_np) and (soft_np <= 0 or cap_np < soft_np):
                resource.setrlimit(resource.RLIMIT_NPROC, (cap_np, cap_np))
        except (ValueError, OSError):
            pass
    return _apply


def _exec_in_bwrap(
    session: SandboxSession,
    command: str,
    *,
    container_workdir: str,
    timeout_s: int,
    env: dict[str, str],
) -> tuple[int, str, str, bool]:
    binary = _bwrap_bin()
    if not binary:
        raise SandboxError("Bubblewrap (bwrap) ist nicht verfügbar.", status=503)
    cmd: list[str] = [binary]
    if session.network_enabled:
        cmd.extend(["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts"])
    else:
        cmd.append("--unshare-all")
    cmd.extend(["--die-with-parent", "--new-session"])
    for sys_dir in ("/usr", "/bin", "/lib", "/lib64", "/sbin"):
        if Path(sys_dir).exists():
            cmd.extend(["--ro-bind", sys_dir, sys_dir])
    for etc_item in (
        "/etc/alternatives", "/etc/ssl", "/etc/ca-certificates",
        "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d",
    ):
        if Path(etc_item).exists():
            cmd.extend(["--ro-bind", etc_item, etc_item])
    if session.network_enabled:
        for net_etc in ("/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"):
            if Path(net_etc).exists():
                cmd.extend(["--ro-bind", net_etc, net_etc])
    cmd.extend([
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--bind", str(session.workspace_dir.resolve()), "/workspace",
        "--chdir", container_workdir,
        "--clearenv",
        "--setenv", "PATH", "/workspace/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "--setenv", "HOME", "/workspace",
        "--setenv", "TMPDIR", "/tmp",
        "--setenv", "PYTHONUSERBASE", "/workspace/.local",
        "--setenv", "PIP_CACHE_DIR", "/tmp/pip-cache",
        "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
        "--setenv", "PYTHONUNBUFFERED", "1",
        "--setenv", "LANG", "C.UTF-8",
        "--setenv", "LC_ALL", "C.UTF-8",
    ])
    for k, v in env.items():
        cmd.extend(["--setenv", k, v])
    cmd.extend(["/bin/sh", "-c", command])
    max_fsize = max(32, session.workspace_mb) * 1024 * 1024
    timed_out = False
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
            preexec_fn=_bwrap_preexec(
                timeout_s, max_fsize, memory_mb=session.memory_mb, pids_limit=session.pids_limit,
            ),
        )
        rc = proc.returncode
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        rc = 124
        stdout = (exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""))
        stderr = (exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or ""))
    return rc, stdout, stderr, timed_out


def exec_command(
    db: Session | None,
    chat_id: int,
    user_id: int,
    command: str,
    *,
    workdir: str = ".",
    timeout_s: int | None = None,
    env: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cmd_text = str(command or "").strip()
    if not cmd_text:
        raise SandboxError("Bitte einen auszuführenden Befehl angeben.")
    if len(cmd_text) > MAX_COMMAND_CHARS:
        raise SandboxError(f"Befehl ist zu lang (höchstens {MAX_COMMAND_CHARS:,} Zeichen).")
    cfg = _config(db)
    eff_timeout = max(2, min(int(timeout_s or cfg["timeout_s"]), cfg["timeout_s"]))
    clean_env = _clean_env(env)
    session, created = ensure_sandbox(db, chat_id, user_id)

    with session.lock:
        c_workdir = _container_workdir(session.workspace_dir, workdir)
        before = _snapshot_files(session.workspace_dir)
        started = time.perf_counter()
        if session.backend == "docker":
            rc, stdout, stderr, timed_out = _exec_in_docker(
                session, cmd_text, container_workdir=c_workdir,
                timeout_s=eff_timeout, env=clean_env,
            )
        else:
            rc, stdout, stderr, timed_out = _exec_in_bwrap(
                session, cmd_text, container_workdir=c_workdir,
                timeout_s=eff_timeout, env=clean_env,
            )
        duration_ms = round((time.perf_counter() - started) * 1000)
        session.last_used_at = _now()
        session.command_count += 1
        after = _snapshot_files(session.workspace_dir)

    changed_files = sorted(
        path for path, meta in after.items()
        if path not in before or before[path] != meta
    )
    removed_files = sorted(path for path in before if path not in after)
    output_limit = max(16, session.output_kb) * 1024
    out_text, out_trunc = _clip(stdout, output_limit)
    err_text, err_trunc = _clip(stderr, output_limit)
    return {
        "exit_code": rc,
        "timed_out": timed_out,
        "duration_ms": duration_ms,
        "stdout": out_text,
        "stderr": err_text,
        "truncated": out_trunc or err_trunc,
        "changed_files": changed_files[:50],
        "removed_files": removed_files[:50],
        "sandbox_created": created,
        "sandbox": session_out(session, include_files=False),
    }


def write_workspace_file(
    db: Session | None,
    chat_id: int,
    user_id: int,
    path: str,
    content: str,
) -> dict[str, Any]:
    raw_bytes = (content or "").encode("utf-8")
    if len(raw_bytes) > MAX_WRITE_BYTES:
        raise SandboxError(f"Datei ist zu groß (höchstens {MAX_WRITE_BYTES // (1024 * 1024)} MB).")
    # Pfad vorab prüfen, damit ungültige Pfade keinen unnötigen Container starten.
    _resolve_workspace_path(Path("/workspace"), path, allow_root=False)
    session, created = ensure_sandbox(db, chat_id, user_id)
    max_ws_bytes = max(32, session.workspace_mb) * 1024 * 1024
    max_files = max(100, session.max_files)
    with session.lock:
        target = _resolve_workspace_path(session.workspace_dir, path, allow_root=False)
        file_count, total_bytes = _workspace_stats(session.workspace_dir)
        existing_size = target.stat().st_size if target.exists() and target.is_file() else 0
        if not target.exists() and file_count >= max_files:
            raise SandboxError(f"Höchstzahl von {max_files:,} Dateien im Container erreicht.")
        if total_bytes - existing_size + len(raw_bytes) > max_ws_bytes:
            raise SandboxError(
                f"Speicherlimit der temporären Umgebung ({session.workspace_mb} MB) erreicht."
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(target, flags, 0o644)
        except OSError as exc:
            raise SandboxError(f"Datei „{path}“ konnte nicht sicher geschrieben werden: {exc}") from exc
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw_bytes)
        session.last_used_at = _now()
        rel = target.relative_to(session.workspace_dir.resolve()).as_posix()
    return {
        "path": rel,
        "bytes": len(raw_bytes),
        "chars": len(content or ""),
        "sandbox_created": created,
        "sandbox": session_out(session, include_files=False),
    }


def read_workspace_file(
    chat_id: int,
    path: str,
    *,
    max_chars: int = 40_000,
) -> dict[str, Any]:
    session = get_sandbox(chat_id)
    if session is None:
        raise SandboxError("Für diesen Chat läuft aktuell keine Container-Umgebung.", status=404)
    limit = max(500, min(int(max_chars or 40_000), 400_000))
    with session.lock:
        target = _resolve_workspace_path(session.workspace_dir, path, allow_root=False)
        if target.is_symlink():
            raise SandboxError("Symlinks können nicht direkt gelesen werden.", status=422)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(target, flags)
        except FileNotFoundError as exc:
            raise SandboxError(f"Datei „{path}“ im Container nicht gefunden.", status=404) from exc
        except OSError as exc:
            raise SandboxError("Symlinks oder Sonderdateien können nicht direkt gelesen werden.", status=422) from exc
        with os.fdopen(fd, "rb") as handle:
            st = os.fstat(handle.fileno())
            if not stat.S_ISREG(st.st_mode):
                raise SandboxError(f"Datei „{path}“ ist keine reguläre Datei.", status=422)
            size = st.st_size
            raw = handle.read()
        session.last_used_at = _now()
        rel = target.relative_to(session.workspace_dir.resolve()).as_posix()
    text = raw.decode("utf-8", errors="replace")
    truncated = len(text) > limit
    return {
        "path": rel,
        "bytes": size,
        "chars": len(text),
        "truncated": truncated,
        "content": text[:limit] + ("\n… (gekürzt)" if truncated else ""),
    }


def run_python(
    db: Session | None,
    chat_id: int,
    user_id: int,
    code: str,
    *,
    filename: str = "_script.py",
    timeout_s: int | None = None,
) -> dict[str, Any]:
    code_text = str(code or "")
    if not code_text.strip():
        raise SandboxError("Bitte auszuführenden Python-Code angeben.")
    if len(code_text) > MAX_CODE_CHARS:
        raise SandboxError(f"Python-Code ist zu lang (höchstens {MAX_CODE_CHARS:,} Zeichen).")
    clean_name = _normalize_rel_path(filename or "_script.py", allow_root=False)
    if not clean_name.endswith(".py"):
        clean_name += ".py"
    written = write_workspace_file(db, chat_id, user_id, clean_name, code_text)
    rel_script = written["path"]
    quoted = "'" + rel_script.replace("'", "'\"'\"'") + "'"
    result = exec_command(
        db, chat_id, user_id, f"python3 {quoted}",
        workdir=".", timeout_s=timeout_s,
    )
    result["script"] = rel_script
    return result


def stage_attachments(
    db: Session | None,
    chat_id: int,
    user_id: int,
    attachments: list[Any],
) -> list[str]:
    """Kopiert extrahierte Chat-Anhänge nach ``/workspace/attachments/``."""
    if not attachments:
        return []
    staged: list[str] = []
    for att in attachments:
        safe = _SAFE_NAME_RE.sub("_", (getattr(att, "filename", "") or "anhang.txt")).strip("._") or "anhang.txt"
        att_id = getattr(att, "id", 0)
        rel = f"attachments/{att_id}_{safe}"
        if not any(rel.lower().endswith(ext) for ext in (".txt", ".md", ".csv", ".json", ".html", ".svg", ".log", ".xml")):
            rel += ".txt"
        text = getattr(att, "text", "") or ""
        res = write_workspace_file(db, chat_id, user_id, rel, text[:MAX_WRITE_BYTES])
        staged.append(res["path"])
    return staged


def list_workspace_files(chat_id: int, *, subdir: str = ".", max_entries: int = 200) -> dict[str, Any]:
    session = get_sandbox(chat_id)
    if session is None:
        return {
            "active": False,
            "files": [],
            "sandbox": None,
        }
    with session.lock:
        entries = _list_workspace_entries(session.workspace_dir, subdir=subdir, max_entries=max_entries)
        session.last_used_at = _now()
        info = session_out(session, include_files=False)
    return {
        "active": True,
        "subdir": _normalize_rel_path(subdir, allow_root=True),
        "files": entries,
        "sandbox": info,
    }


def self_test(db: Session | None) -> dict[str, Any]:
    """Startet eine frische Kurzzeit-Sandbox, führt einen Python-Check aus und räumt sofort auf."""
    cfg = _config(db)
    if not cfg["enabled"]:
        raise SandboxError("Die Container-Sandbox ist in den Einstellungen ausgeschaltet.", status=409)
    # Negativer Chat-ID-Bereich für isolierte Admin-Tests, kollidiert nie mit echten Chats.
    test_chat_id = -int(secrets.randbelow(1_000_000) + 1)
    started = time.perf_counter()
    try:
        res = run_python(
            db, test_chat_id, 0,
            "import os, platform, sys; print(f'OK python={platform.python_version()} uid={os.getuid()} cwd={os.getcwd()}')",
            filename="_selftest.py",
            timeout_s=min(15, cfg["timeout_s"]),
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return {
            "ok": res["exit_code"] == 0 and "OK python=" in res["stdout"],
            "backend": res["sandbox"]["backend"],
            "image": res["sandbox"]["image"],
            "network_enabled": res["sandbox"]["network_enabled"],
            "stdout": res["stdout"].strip(),
            "stderr": res["stderr"].strip(),
            "exit_code": res["exit_code"],
            "duration_ms": elapsed_ms,
        }
    finally:
        destroy_sandbox(test_chat_id)
