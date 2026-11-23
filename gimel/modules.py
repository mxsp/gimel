"""Composable module & semi-external software registry for Gimel.

Unlike :mod:`gimel.extensions` (single host application plugin such as Alef),
this registry lets an installation compose **multiple** independent modules
and semi-external web applications:

1. **Python modules** registered via :func:`register_module` or imported at
   startup from ``GIMEL_MODULE_IMPORTS="pkg.mod:module,..."``. They may bring
   FastAPI routers, DB seed hooks, and/or a built static SPA directory.
2. **File-configured apps** loaded from ``GIMEL_MODULES_FILE`` (JSON list) so
   external or sidecar tools can be attached without touching Python code.
3. **Admin-configured apps** stored in ``settings_store`` under
   ``external_modules`` via ``/api/modules`` and editable live in the UI.

Every module—built-in (ERP, Twin Studio, Grundriss, Agent Lab), Python-mounted,
file-configured, or DB-configured—shares one uniform metadata shape so the web
shell (AppSwitcher, sidebar, JumpPalette, ExternalAppHost) renders it cleanly.
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Literal, Optional
from urllib.parse import urlparse

from fastapi import FastAPI
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from .services import settings_store

log = logging.getLogger("gimel.modules")

ModuleKind = Literal["core", "mounted", "embedded", "external"]
ModulePlacement = Literal["switcher", "sidebar", "menu", "hub"]
ModuleArea = Literal["buero", "leitstand", "beide"]
ModuleSource = Literal["builtin", "python", "config", "db"]

SETTINGS_KEY = "external_modules"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
VALID_KINDS = {"core", "mounted", "embedded", "external"}
VALID_PLACEMENTS = {"switcher", "sidebar", "menu", "hub"}
VALID_AREAS = {"buero", "leitstand", "beide"}
VALID_ROLES = {"admin", "staff", "worker"}


@dataclass(frozen=True)
class AppModule:
    """Declarative descriptor for an internal, mounted, embedded, or external app."""

    id: str
    label: str
    short_label: str = ""
    icon: str = "applications"
    description: str = ""
    kind: ModuleKind = "external"
    href: str = ""
    embed_url: str = ""
    placement: ModulePlacement = "hub"
    area: ModuleArea = "beide"
    group: str = "Erweiterungen"
    roles: tuple[str, ...] = ()
    new_tab: bool = False
    enabled: bool = True
    order: int = 100
    source: ModuleSource = "python"
    # Optional backend integration hooks (Python modules only)
    routers: Optional[Callable[[], Iterable[Any]]] = None
    seed: Optional[Callable[[Session, bool], Any]] = None
    mount_path: str = ""
    dist_dir: Optional[Path] = None
    csp_frame_src: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "short_label": self.short_label or self.label,
            "icon": self.icon,
            "description": self.description,
            "kind": self.kind,
            "href": self.href,
            "embed_url": self.embed_url,
            "placement": self.placement,
            "area": self.area,
            "group": self.group,
            "roles": list(self.roles),
            "new_tab": self.new_tab,
            "enabled": self.enabled,
            "order": self.order,
            "source": self.source,
            "editable": self.source == "db",
        }


# Process-wide Python modules registered via register_module() or GIMEL_MODULE_IMPORTS
_python_modules: dict[str, AppModule] = {}
_env_loaded: bool = False
_mounted_prefixes: set[str] = set()
_cached_frame_origins: set[str] = set()


def normalize_slug(raw: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", (raw or "").strip().lower()).strip("-_")
    if not slug or not SLUG_RE.match(slug):
        raise ValueError("Modul-ID muss aus Kleinbuchstaben, Ziffern, '-' oder '_' bestehen.")
    return slug


def validate_url(url: str, *, allow_empty: bool = False) -> str:
    val = (url or "").strip()
    if not val:
        if allow_empty:
            return ""
        raise ValueError("URL darf nicht leer sein.")
    if val.startswith("/") and not val.startswith("//"):
        return val
    parsed = urlparse(val)
    if parsed.scheme in ("http", "https") and parsed.netloc:
        return val
    raise ValueError("Nur relative Pfade (/...) oder http(s)://-URLs sind erlaubt.")


def extract_origin(url: str) -> str | None:
    """Return 'scheme://netloc' for absolute http(s) URLs, else None."""
    val = (url or "").strip()
    if not val or val.startswith("/"):
        return None
    parsed = urlparse(val)
    if parsed.scheme in ("http", "https") and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return None


def register_module(module: AppModule) -> None:
    """Register a composable Python module (idempotent by module.id)."""
    slug = normalize_slug(module.id)
    if module.id != slug:
        raise ValueError(f"Ungültige Modul-ID: {module.id!r}")
    _python_modules[module.id] = module


def unregister_module(module_id: str) -> None:
    _python_modules.pop(module_id, None)


def clear_python_modules() -> None:
    """Test helper: reset process-registered Python modules."""
    global _env_loaded
    _python_modules.clear()
    _mounted_prefixes.clear()
    _cached_frame_origins.clear()
    _env_loaded = False


def python_modules() -> list[AppModule]:
    return sorted(_python_modules.values(), key=lambda m: (m.order, m.id))


def mounted_prefixes() -> tuple[str, ...]:
    return tuple(sorted(_mounted_prefixes))


def load_env_modules() -> list[AppModule]:
    """Import modules listed in ``GIMEL_MODULE_IMPORTS`` (comma-separated ``pkg.mod:attr``)."""
    global _env_loaded
    if _env_loaded:
        return python_modules()
    _env_loaded = True
    spec_list = os.environ.get("GIMEL_MODULE_IMPORTS", "").strip()
    if not spec_list:
        return python_modules()
    for raw in spec_list.split(","):
        spec = raw.strip()
        if not spec:
            continue
        try:
            mod_name, _, attr_name = spec.partition(":")
            attr_name = attr_name or "MODULE"
            imported = importlib.import_module(mod_name)
            obj = getattr(imported, attr_name)
            if callable(obj) and not isinstance(obj, AppModule):
                obj = obj()
            if isinstance(obj, AppModule):
                register_module(obj)
            elif isinstance(obj, Iterable):
                for item in obj:
                    if isinstance(item, AppModule):
                        register_module(item)
            else:
                log.warning("GIMEL_MODULE_IMPORTS: %s lieferte kein AppModule", spec)
        except Exception:
            log.exception("Modul %s konnte nicht geladen werden", spec)
    return python_modules()


def _parse_external_dict(raw: dict[str, Any], *, source: ModuleSource) -> AppModule | None:
    try:
        mid = normalize_slug(str(raw.get("id", "")))
        label = str(raw.get("label", "")).strip()
        if not label:
            return None
        kind = str(raw.get("kind", "external")).strip().lower()
        if kind not in VALID_KINDS or kind == "core":
            kind = "external"
        placement = str(raw.get("placement", "hub")).strip().lower()
        if placement not in VALID_PLACEMENTS:
            placement = "hub"
        area = str(raw.get("area", "beide")).strip().lower()
        if area not in VALID_AREAS:
            area = "beide"
        href = validate_url(str(raw.get("href", "")), allow_empty=(kind == "embedded"))
        embed_url = validate_url(str(raw.get("embed_url", "")), allow_empty=True)
        if kind == "embedded" and not embed_url:
            embed_url = href
        if kind == "embedded" and not embed_url:
            return None
        roles_raw = raw.get("roles") or []
        roles = tuple(r for r in roles_raw if isinstance(r, str) and r in VALID_ROLES)
        mount_path = str(raw.get("mount_path", "")).strip()
        dist_raw = str(raw.get("dist_dir", "")).strip()
        dist_dir = Path(dist_raw) if dist_raw else None
        return AppModule(
            id=mid,
            label=label[:60],
            short_label=str(raw.get("short_label", "")).strip()[:20] or label[:20],
            icon=str(raw.get("icon", "applications")).strip() or "applications",
            description=str(raw.get("description", "")).strip()[:240],
            kind=kind,  # type: ignore[arg-type]
            href=href or embed_url,
            embed_url=embed_url,
            placement=placement,  # type: ignore[arg-type]
            area=area,  # type: ignore[arg-type]
            group=str(raw.get("group", "Erweiterungen")).strip() or "Erweiterungen",
            roles=roles,
            new_tab=bool(raw.get("new_tab", kind == "external")),
            enabled=bool(raw.get("enabled", True)),
            order=int(raw.get("order", 100)),
            source=source,
            mount_path=mount_path,
            dist_dir=dist_dir,
        )
    except Exception:
        log.warning("Überspringe ungültigen Moduleintrag (%s): %r", source, raw)
        return None


def load_file_modules() -> list[AppModule]:
    """Load drop-in JSON modules from ``GIMEL_MODULES_FILE`` if configured."""
    path_str = os.environ.get("GIMEL_MODULES_FILE", "").strip()
    if not path_str:
        return []
    path = Path(path_str)
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        rows = payload.get("modules", []) if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            return []
        out: list[AppModule] = []
        for item in rows:
            if isinstance(item, dict):
                mod = _parse_external_dict(item, source="config")
                if mod:
                    out.append(mod)
        return out
    except Exception:
        log.exception("GIMEL_MODULES_FILE (%s) konnte nicht gelesen werden", path)
        return []


def load_db_modules(db: Session) -> list[AppModule]:
    """Load admin-configured semi-external modules from ``settings_store``."""
    raw = settings_store.get(db, SETTINGS_KEY, "[]")
    try:
        rows = json.loads(raw or "[]")
    except Exception:
        return []
    if not isinstance(rows, list):
        return []
    out: list[AppModule] = []
    for item in rows:
        if isinstance(item, dict):
            mod = _parse_external_dict(item, source="db")
            if mod:
                out.append(mod)
    _sync_frame_origins(out)
    return out


def save_db_modules(db: Session, modules: list[AppModule], actor: str = "") -> None:
    serialized = [
        {
            "id": m.id,
            "label": m.label,
            "short_label": m.short_label,
            "icon": m.icon,
            "description": m.description,
            "kind": m.kind,
            "href": m.href,
            "embed_url": m.embed_url,
            "placement": m.placement,
            "area": m.area,
            "group": m.group,
            "roles": list(m.roles),
            "new_tab": m.new_tab,
            "enabled": m.enabled,
            "order": m.order,
        }
        for m in modules
    ]
    settings_store.set_value(db, SETTINGS_KEY, json.dumps(serialized, ensure_ascii=False), actor=actor)
    db.commit()
    _sync_frame_origins(modules)


def _sync_frame_origins(extra_modules: Iterable[AppModule] = ()) -> None:
    origins: set[str] = set()
    for mod in (*python_modules(), *load_file_modules(), *extra_modules):
        if not mod.enabled:
            continue
        for o in mod.csp_frame_src:
            parsed = extract_origin(o)
            if parsed:
                origins.add(parsed)
        if mod.kind == "embedded":
            parsed = extract_origin(mod.embed_url or mod.href)
            if parsed:
                origins.add(parsed)
    _cached_frame_origins.clear()
    _cached_frame_origins.update(origins)


def frame_src_origins() -> tuple[str, ...]:
    """Allowed external iframe origins for registered embedded modules."""
    if not _cached_frame_origins:
        _sync_frame_origins()
    return tuple(sorted(_cached_frame_origins))


def builtin_modules(*, agent_enabled: bool = False) -> list[AppModule]:
    """Built-in Gimel surfaces exposed through the same registry schema."""
    items: list[AppModule] = [
        AppModule(
            id="erp",
            label="ERP Portal",
            short_label="ERP",
            icon="applications",
            description="Aufträge, Planung, Schachteln, Arbeitsvorrat, Fertigung, Lager und Buchhaltung.",
            kind="core",
            href="/app/",
            placement="switcher",
            area="beide",
            group="Kernmodule",
            new_tab=False,
            order=10,
            source="builtin",
        ),
        AppModule(
            id="twin",
            label="Twin Studio",
            short_label="Twin",
            icon="cube",
            description="3D- & Semi-3D-Fabrikzwilling, Routenanalyse, Flottensimulation und Zeitstrahl.",
            kind="mounted",
            href="/studio/",
            placement="switcher",
            area="leitstand",
            group="Kernmodule",
            new_tab=False,
            order=20,
            source="builtin",
        ),
        AppModule(
            id="grundriss",
            label="Digitaler Grundriss",
            short_label="Grundriss",
            icon="layout",
            description="2D-Hallen-Editor für Stationen, Zonen, Gänge, Tore und Lagerwege.",
            kind="mounted",
            href="/twin/",
            placement="hub",
            area="leitstand",
            group="Kernmodule",
            new_tab=True,
            order=25,
            source="builtin",
        ),
    ]
    if agent_enabled:
        items.append(
            AppModule(
                id="lab",
                label="Agent Lab",
                short_label="Lab",
                icon="chat",
                description="KI-Assistent, Spezialisten-Agenten, Routinen, Artefakte und Wissensgraph.",
                kind="mounted",
                href="/lab/",
                placement="switcher",
                area="beide",
                group="Kernmodule",
                new_tab=False,
                order=30,
                source="builtin",
            )
        )
    return items


def all_modules(
    db: Optional[Session] = None,
    *,
    agent_enabled: bool = False,
    role: Optional[str] = None,
    include_disabled: bool = False,
) -> list[AppModule]:
    """Resolve the merged, ordered module list (builtin < python < config < db)."""
    by_id: dict[str, AppModule] = {}
    for mod in builtin_modules(agent_enabled=agent_enabled):
        by_id[mod.id] = mod
    for mod in python_modules():
        by_id[mod.id] = mod
    for mod in load_file_modules():
        if mod.id not in by_id or by_id[mod.id].source == "config":
            by_id[mod.id] = mod
    if db is not None:
        for mod in load_db_modules(db):
            # DB entries cannot hijack built-in or Python-registered IDs.
            if mod.id not in by_id:
                by_id[mod.id] = mod

    out: list[AppModule] = []
    for mod in sorted(by_id.values(), key=lambda m: (m.order, m.label.lower())):
        if not include_disabled and not mod.enabled:
            continue
        if role and mod.roles and role not in mod.roles:
            continue
        out.append(mod)
    return out


def mount_spa(app: FastAPI, mount_path: str, dist_dir: Path, name: str) -> bool:
    """Mount a built semi-external SPA under ``mount_path`` with safe file resolution."""
    prefix = "/" + mount_path.strip("/")
    if prefix == "/" or not dist_dir.is_dir():
        return False
    index_file = dist_dir / "index.html"
    if not index_file.is_file():
        return False

    assets_dir = dist_dir / "assets"
    if assets_dir.is_dir():
        app.mount(
            f"{prefix}/assets",
            StaticFiles(directory=assets_dir),
            name=f"module-{name}-assets",
        )

    resolved_root = dist_dir.resolve()

    def _serve(full_path: str = "") -> Response:
        candidate = (dist_dir / full_path.lstrip("/")) if full_path else None
        if (
            candidate
            and candidate.is_file()
            and candidate.resolve().is_relative_to(resolved_root)
        ):
            return FileResponse(candidate)
        return FileResponse(index_file)

    app.add_api_route(prefix, _serve, methods=["GET"], include_in_schema=False)
    app.add_api_route(f"{prefix}/{{full_path:path}}", _serve, methods=["GET"], include_in_schema=False)
    _mounted_prefixes.add(prefix)
    log.info("Modul-SPA '%s' eingebunden unter %s (%s)", name, prefix, dist_dir)
    return True
