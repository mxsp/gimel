"""GitHub Release updater connected to mxsp/gimel.

Checks ``https://api.github.com/repos/<repo>/releases/latest`` (default:
``mxsp/gimel``, override via ``GIMEL_UPDATE_REPO``), compares semantic versions
against ``APP_VERSION``, and applies updates cleanly depending on how Gimel is
installed (standalone binary, git checkout, or Docker container).
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

from ..version import APP_VERSION

DEFAULT_UPDATE_REPO = "mxsp/gimel"
CACHE_TTL_SECONDS = 6 * 3600
_SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-.](.+))?$")

InstallKind = Literal["binary", "docker", "git", "package"]


@dataclass
class ReleaseAsset:
    name: str
    download_url: str
    size: int = 0


@dataclass
class UpdateStatus:
    repo: str
    current_version: str
    latest_version: str | None
    latest_tag: str | None
    update_available: bool
    install_kind: InstallKind
    checked_at: float
    release_name: str = ""
    release_notes: str = ""
    release_url: str = ""
    published_at: str = ""
    matched_asset: ReleaseAsset | None = None
    checksum_url: str = ""
    error: str = ""
    assets: list[ReleaseAsset] = field(default_factory=list)

    def to_dict(self) -> dict:
        data = asdict(self)
        return data


@dataclass
class UpdateResult:
    ok: bool
    install_kind: InstallKind
    from_version: str
    to_version: str
    restart_required: bool = False
    detail: str = ""
    command_hint: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


_cache: tuple[str, UpdateStatus] | None = None


def configured_repo() -> str:
    raw = os.environ.get("GIMEL_UPDATE_REPO", DEFAULT_UPDATE_REPO).strip()
    return raw.strip("/") or DEFAULT_UPDATE_REPO


def parse_semver(raw: str | None) -> tuple[int, int, int, int] | None:
    """Parse ``v0.2.0`` -> ``(0, 2, 0, 1)`` (stable) or ``(..., 0)`` (pre-release)."""
    if not raw:
        return None
    m = _SEMVER_RE.match(raw.strip())
    if not m:
        return None
    major, minor, patch = int(m.group(1)), int(m.group(2)), int(m.group(3))
    stable = 0 if m.group(4) else 1
    return (major, minor, patch, stable)


def is_newer_version(current: str, candidate: str | None) -> bool:
    cur = parse_semver(current)
    cand = parse_semver(candidate)
    if cur is None or cand is None:
        return False
    return cand > cur


def _repo_root() -> Path | None:
    if getattr(sys, "frozen", False):
        return None
    root = Path(__file__).resolve().parents[2]
    if (root / ".git").exists():
        return root
    return None


def detect_install_kind() -> InstallKind:
    if getattr(sys, "frozen", False):
        return "binary"
    if Path("/.dockerenv").exists() or os.environ.get("GIMEL_IN_DOCKER") == "1":
        return "docker"
    if _repo_root() is not None:
        return "git"
    return "package"


def _github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"gimel-updater/{APP_VERSION}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GIMEL_GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _http_get_json(url: str, timeout: float = 12.0) -> dict | list:
    req = urllib.request.Request(url, headers=_github_headers())
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _match_platform_asset(assets: list[ReleaseAsset]) -> ReleaseAsset | None:
    sys_name = platform.system().lower()
    if sys_name == "windows":
        wanted = ("windows", ".zip", ".exe")
    elif sys_name == "linux":
        wanted = ("linux", ".tar.gz")
    elif sys_name == "darwin":
        wanted = ("darwin", "macos", ".tar.gz")
    else:
        wanted = ()

    for a in assets:
        low = a.name.lower()
        if sys_name == "windows" and "windows" in low and (low.endswith(".zip") or low.endswith(".exe")):
            return a
        if sys_name == "linux" and "linux" in low and (low.endswith(".tar.gz") or low.endswith(".tgz") or low == "gimel"):
            return a
        if sys_name == "darwin" and ("darwin" in low or "macos" in low):
            return a
    if wanted:
        for a in assets:
            low = a.name.lower()
            if any(w in low for w in wanted):
                return a
    return None


def clear_cache() -> None:
    global _cache
    _cache = None


def check_for_update(*, force: bool = False, repo: str | None = None) -> UpdateStatus:
    global _cache
    target_repo = (repo or configured_repo()).strip("/")
    now = time.time()
    if not force and _cache is not None:
        cached_repo, cached_status = _cache
        if cached_repo == target_repo and (now - cached_status.checked_at) < CACHE_TTL_SECONDS:
            return cached_status

    kind = detect_install_kind()
    api_url = f"https://api.github.com/repos/{target_repo}/releases/latest"
    releases_page = f"https://github.com/{target_repo}/releases"
    try:
        payload = _http_get_json(api_url)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            status_obj = UpdateStatus(
                repo=target_repo,
                current_version=APP_VERSION,
                latest_version=None,
                latest_tag=None,
                update_available=False,
                install_kind=kind,
                checked_at=now,
                release_url=releases_page,
                error="Noch kein GitHub Release veröffentlicht.",
            )
            _cache = (target_repo, status_obj)
            return status_obj
        return UpdateStatus(
            repo=target_repo,
            current_version=APP_VERSION,
            latest_version=None,
            latest_tag=None,
            update_available=False,
            install_kind=kind,
            checked_at=now,
            release_url=releases_page,
            error=f"GitHub API Fehler (HTTP {exc.code}).",
        )
    except Exception as exc:  # noqa: BLE001
        return UpdateStatus(
            repo=target_repo,
            current_version=APP_VERSION,
            latest_version=None,
            latest_tag=None,
            update_available=False,
            install_kind=kind,
            checked_at=now,
            release_url=releases_page,
            error=f"Update-Prüfung fehlgeschlagen: {exc}",
        )

    if not isinstance(payload, dict):
        return UpdateStatus(
            repo=target_repo,
            current_version=APP_VERSION,
            latest_version=None,
            latest_tag=None,
            update_available=False,
            install_kind=kind,
            checked_at=now,
            release_url=releases_page,
            error="Unerwartete Antwort der GitHub API.",
        )

    tag = str(payload.get("tag_name") or "").strip()
    latest_ver = tag.lstrip("v") if tag else None
    raw_assets = payload.get("assets") or []
    assets = [
        ReleaseAsset(
            name=str(a.get("name") or ""),
            download_url=str(a.get("browser_download_url") or ""),
            size=int(a.get("size") or 0),
        )
        for a in raw_assets
        if isinstance(a, dict) and a.get("browser_download_url")
    ]
    matched = _match_platform_asset(assets)
    checksum_asset = next(
        (a for a in assets if "sha256" in a.name.lower() or "checksum" in a.name.lower()),
        None,
    )

    status_obj = UpdateStatus(
        repo=target_repo,
        current_version=APP_VERSION,
        latest_version=latest_ver,
        latest_tag=tag or None,
        update_available=is_newer_version(APP_VERSION, tag),
        install_kind=kind,
        checked_at=now,
        release_name=str(payload.get("name") or tag),
        release_notes=str(payload.get("body") or "").strip(),
        release_url=str(payload.get("html_url") or releases_page),
        published_at=str(payload.get("published_at") or ""),
        matched_asset=matched,
        checksum_url=checksum_asset.download_url if checksum_asset else "",
        assets=assets,
    )
    _cache = (target_repo, status_obj)
    return status_obj


def _download_file(url: str, dest: Path, timeout: float = 180.0) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": f"gimel-updater/{APP_VERSION}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp, dest.open("wb") as out:
        shutil.copyfileobj(resp, out)


def _verify_sha256(file_path: Path, asset_name: str, checksum_url: str) -> None:
    if not checksum_url:
        return
    req = urllib.request.Request(checksum_url, headers={"User-Agent": f"gimel-updater/{APP_VERSION}"})
    with urllib.request.urlopen(req, timeout=30.0) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    expected = ""
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[-1].lstrip("*").endswith(asset_name):
            expected = parts[0].lower()
            break
    if not expected:
        return
    h = hashlib.sha256()
    with file_path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    actual = h.hexdigest().lower()
    if actual != expected:
        raise RuntimeError(f"SHA-256 Prüfsummenfehler für {asset_name} (erwartet {expected[:12]}…, erhalten {actual[:12]}…).")


def _apply_binary_update(info: UpdateStatus) -> UpdateResult:
    if not info.matched_asset:
        return UpdateResult(
            ok=False,
            install_kind="binary",
            from_version=APP_VERSION,
            to_version=info.latest_version or APP_VERSION,
            detail=f"Kein passendes Release-Paket für {platform.system()} gefunden. Manueller Download: {info.release_url}",
        )

    exe_path = Path(sys.executable).resolve()
    asset = info.matched_asset
    with tempfile.TemporaryDirectory(prefix="gimel-update-") as tmp:
        tmp_dir = Path(tmp)
        dl_path = tmp_dir / asset.name
        _download_file(asset.download_url, dl_path)
        _verify_sha256(dl_path, asset.name, info.checksum_url)

        new_bin: Path | None = None
        low = asset.name.lower()
        if low.endswith(".tar.gz") or low.endswith(".tgz"):
            with tarfile.open(dl_path, "r:gz") as tf:
                tf.extractall(tmp_dir / "extracted", filter="data")
            for candidate in (tmp_dir / "extracted").rglob("gimel"):
                if candidate.is_file():
                    new_bin = candidate
                    break
        elif low.endswith(".zip"):
            with zipfile.ZipFile(dl_path, "r") as zf:
                zf.extractall(tmp_dir / "extracted")
            for candidate in (tmp_dir / "extracted").rglob("gimel.exe"):
                if candidate.is_file():
                    new_bin = candidate
                    break
        else:
            new_bin = dl_path

        if new_bin is None or not new_bin.is_file():
            return UpdateResult(
                ok=False,
                install_kind="binary",
                from_version=APP_VERSION,
                to_version=info.latest_version or APP_VERSION,
                detail="Release-Archiv enthielt keine ausführbare Gimel-Datei.",
            )

        staged = exe_path.with_suffix(exe_path.suffix + ".new")
        backup = exe_path.with_suffix(exe_path.suffix + ".bak")
        shutil.copy2(new_bin, staged)
        if platform.system().lower() != "windows":
            os.chmod(staged, 0o755)
            shutil.copy2(exe_path, backup)
            os.replace(staged, exe_path)
            return UpdateResult(
                ok=True,
                install_kind="binary",
                from_version=APP_VERSION,
                to_version=info.latest_version or APP_VERSION,
                restart_required=True,
                detail=f"Update auf {info.latest_tag} installiert (Backup: {backup.name}). Bitte Gimel neu starten.",
            )
        return UpdateResult(
            ok=True,
            install_kind="binary",
            from_version=APP_VERSION,
            to_version=info.latest_version or APP_VERSION,
            restart_required=True,
            detail=f"Update {info.latest_tag} bereitgestellt unter {staged.name}. Gimel beenden und {staged.name} nach {exe_path.name} umbenennen.",
        )


def _apply_git_update(info: UpdateStatus, *, target_tag: str | None = None, rebuild_web: bool = True) -> UpdateResult:
    root = _repo_root()
    if root is None:
        return UpdateResult(
            ok=False,
            install_kind="git",
            from_version=APP_VERSION,
            to_version=info.latest_version or APP_VERSION,
            detail="Kein Git-Repository gefunden.",
        )

    tag = target_tag or info.latest_tag
    if not tag:
        return UpdateResult(
            ok=False,
            install_kind="git",
            from_version=APP_VERSION,
            to_version=APP_VERSION,
            detail="Kein Ziel-Release auf GitHub gefunden.",
        )

    dirty = subprocess.run(
        ["git", "-C", str(root), "status", "--porcelain"],
        capture_output=True,
        text=True,
        check=False,
    )
    if dirty.stdout.strip():
        return UpdateResult(
            ok=False,
            install_kind="git",
            from_version=APP_VERSION,
            to_version=tag.lstrip("v"),
            detail="Lokale ungespeicherte Änderungen im Git-Repository — bitte zuerst committen oder stashen.",
            command_hint=f"git fetch --tags origin && git checkout {tag}",
        )

    remote_url = f"https://github.com/{info.repo}.git"
    fetch = subprocess.run(
        ["git", "-C", str(root), "fetch", "--tags", remote_url, f"refs/tags/{tag}:refs/tags/{tag}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if fetch.returncode != 0:
        return UpdateResult(
            ok=False,
            install_kind="git",
            from_version=APP_VERSION,
            to_version=tag.lstrip("v"),
            detail=f"Git fetch fehlgeschlagen: {(fetch.stderr or fetch.stdout).strip()}",
        )

    co = subprocess.run(
        ["git", "-C", str(root), "checkout", tag],
        capture_output=True,
        text=True,
        check=False,
    )
    if co.returncode != 0:
        return UpdateResult(
            ok=False,
            install_kind="git",
            from_version=APP_VERSION,
            to_version=tag.lstrip("v"),
            detail=f"Git checkout fehlgeschlagen: {(co.stderr or co.stdout).strip()}",
        )

    # Update Python editable package in current environment
    pip_res = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-e", str(root), "--no-build-isolation", "--quiet"],
        capture_output=True,
        text=True,
        check=False,
    )
    notes = [f"Repository auf {tag} aktualisiert."]
    if pip_res.returncode != 0:
        notes.append("Hinweis: Python-Abhängigkeiten bitte manuell aktualisieren (`pip install -e .`).")

    if rebuild_web and shutil.which("npm"):
        for web_dir in (root / "web", root / "agentlab" / "web"):
            if (web_dir / "package.json").is_file():
                b = subprocess.run(
                    ["npm", "run", "build"],
                    cwd=str(web_dir),
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if b.returncode != 0:
                    notes.append(f"Frontend-Build in {web_dir.name} fehlgeschlagen.")

    clear_cache()
    return UpdateResult(
        ok=True,
        install_kind="git",
        from_version=APP_VERSION,
        to_version=tag.lstrip("v"),
        restart_required=True,
        detail=" ".join(notes) + " Bitte Gimel neu starten.",
    )


def apply_update(*, target_tag: str | None = None, rebuild_web: bool = True) -> UpdateResult:
    info = check_for_update(force=True)
    kind = info.install_kind
    target_ver = (target_tag or info.latest_tag or APP_VERSION).lstrip("v")

    if kind == "docker":
        return UpdateResult(
            ok=False,
            install_kind="docker",
            from_version=APP_VERSION,
            to_version=target_ver,
            restart_required=True,
            detail="Container-Updates werden über Docker Compose auf dem Host ausgeführt.",
            command_hint="git pull && docker compose up -d --build",
        )

    if not target_tag and not info.update_available:
        return UpdateResult(
            ok=True,
            install_kind=kind,
            from_version=APP_VERSION,
            to_version=info.latest_version or APP_VERSION,
            restart_required=False,
            detail=f"Gimel v{APP_VERSION} ist bereits aktuell.",
        )

    if kind == "binary":
        return _apply_binary_update(info)
    if kind == "git":
        return _apply_git_update(info, target_tag=target_tag, rebuild_web=rebuild_web)

    tag = target_tag or info.latest_tag or "main"
    return UpdateResult(
        ok=False,
        install_kind="package",
        from_version=APP_VERSION,
        to_version=target_ver,
        detail="Paket-Installation erkannt — bitte über pip aktualisieren.",
        command_hint=f"pip install --upgrade git+https://github.com/{info.repo}.git@{tag}",
    )
