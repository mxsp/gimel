"""Die Gimel-Anwendung.

``create_app()`` baut sie: REST unter ``/api/…``, das interne Portal unter
``/app``, der Grundriss unter ``/twin``. Eine Anwendung auf Gimel registriert
vorher ihr Plugin (``gimel.extensions.use``); allein läuft Gimel ohne eines.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from .config import get_settings
from . import demo, fieldcrypt, modules as module_registry
from .agent_bridge import load as _agent_bridge
from .db import get_db
from .extensions import active
from .hostguard import HostGuardMiddleware
from .localnet import LocalnetGuardMiddleware
from . import vision_api
from .routers import (
    account,
    accounts,
    admin,
    auth,
    compliance,
    customers,
    desk,
    drawings,
    factory,
    free_nesting,
    integration,
    inventory,
    invoicing,
    links,
    modules as modules_router,
    nesting,
    production,
    products,
    punchout,
    quotes,
    rates,
    robot_platform,
    robots,
    shipping,
    system_info,
    updates,
    users,
)
from .seed import init_db
from .services import scheduler
from .version import APP_NAME, APP_VERSION

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s"
)
log = logging.getLogger("gimel")

#: Für jede Antwort. Inline-Stile bleiben erlaubt (Blueprint, Laufkarte); ein
#: Inline-Skript nicht, auch nicht im Fenster, in das das Portal eine Laufkarte
#: schreibt: das erbt diese Regel (render/plate.py).
CSP = (
    # 'wasm-unsafe-eval' für MediaPipe (Handführung in der Sortierzelle): die
    # Modelle laufen als WASM im Browser, lokal, auf dem Hauptfaden. Kein
    # worker-src blob: — es gibt keinen Worker (Inhaber 2026-11-14).
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
    "style-src 'self' 'unsafe-inline'; "
    # Kartenkacheln für den Hallenanker (Aufgabe 32): nur Bilder, nur diese zwei Hosts (Karte, Luftbild),
    # und geladen wird erst, wenn eine Halle die Karte eingeschaltet hat. Die
    # Adresssuche (Nominatim) nur auf Knopfdruck im Standort-Dialog.
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://server.arcgisonline.com; font-src 'self' data:; connect-src 'self' https://nominatim.openstreetmap.org; "
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
)
#: Nur die Swagger- und ReDoc-Seite, die es in Produktion nicht gibt. FastAPI liefert
#: sie mit Inline-Skript und lädt ihr Bündel von jsDelivr, ReDoc dazu Schriften von
#: Google und einen Worker aus einem blob:.
DOCS_PATHS = ("/docs", "/docs/oauth2-redirect", "/redoc")
DOCS_CSP = (
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; "
    "img-src 'self' data: blob: https://fastapi.tiangolo.com https://cdn.redoc.ly; "
    "font-src 'self' data: https://fonts.gstatic.com; worker-src 'self' blob:; connect-src 'self'; "
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
)


def create_app() -> FastAPI:
    settings = get_settings()
    plugin = active()
    extra_modules = module_registry.load_env_modules()
    # Der Assistent ist optional: liegt ``agentlab`` neben Gimel, bringt das
    # Hauptportal seine /api/agent-Routen und Tabellen gleich mit. Unter einem
    # anderen Plugin (Alef, Agent Lab selbst) bleibt die Zuständigkeit dort.
    agent_router, agent_seed = (None, None) if plugin else _agent_bridge()
    STATIC_DIR = Path(__file__).resolve().parent / "admin"

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            get_settings().validate_production()
            fieldcrypt.validate()  # DATA_KEYS gesetzt, aber kaputt → lieber jetzt abbrechen als beim ersten Schreiben
        except Exception:
            log.exception("Konfiguration ungültig — Start abgebrochen")
            raise
        try:
            init_db(verbose=True)
        except Exception:
            log.exception("DB-Init fehlgeschlagen")
            raise
        if agent_seed is not None:
            # Der Assistent ist ein Zusatz. Scheitert seine Erstinitialisierung,
            # muss das Portal trotzdem starten.
            try:
                from gimel.db import SessionLocal

                with SessionLocal() as _db:
                    agent_seed(_db, verbose=True)
            except Exception:
                log.exception("Assistent-Init fehlgeschlagen")
        # Optionale Python-Module initialisieren (isoliert wie der Assistent)
        # und DB-konfigurierte eingebettete Origins für CSP vorladen.
        try:
            from gimel.db import SessionLocal

            with SessionLocal() as _db:
                module_registry.load_db_modules(_db)
                for _mod in extra_modules:
                    if _mod.seed is not None and _mod.enabled:
                        try:
                            _mod.seed(_db, True)
                        except Exception:
                            log.exception("Modul-Init '%s' fehlgeschlagen", _mod.id)
        except Exception:
            log.exception("Modul-Registry-Init fehlgeschlagen")
        try:
            from gimel.db import SessionLocal
            from .services import mailer, mfa

            with SessionLocal() as _db:
                mailer.purge_expired_contacts(_db)
                mfa.purge_stale_sessions(_db)
        except Exception:
            log.exception("Mailer-Cleanup fehlgeschlagen")
        try:
            from gimel.db import SessionLocal

            with SessionLocal() as _db:
                compliance.purge_reporter_contacts(_db)
        except Exception:
            log.exception("Bereinigung der Meldekontakte fehlgeschlagen")
        task = asyncio.create_task(scheduler.loop(), name="batch-scheduler")
        log.info("Sammellauf-Taktgeber gestartet")
        try:
            yield
        except Exception:
            log.exception("Unbehandelte Ausnahme im Lifespan")
            raise
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                log.exception("Scheduler-Task Crash beim Beenden")
            log.info("Sammellauf-Taktgeber beendet")



    app = FastAPI(
        title=(plugin.title if plugin and plugin.title else APP_NAME),
        version=APP_VERSION,
        description=(
            plugin.description if plugin and plugin.description
            else "Auftrags- und Fertigungssteuerung: Aufträge, Sammellauf, Grundriss, "
                 "Lager, Arbeitslisten, Versand und Rechnungen."
        ),
        lifespan=lifespan,
        # Schema und Swagger-Oberfläche nur in der Entwicklung: in Produktion
        # verraten sie jede interne Route (Fertigung, Buchhaltung, Admin).
        docs_url=None if settings.is_production() else "/docs",
        redoc_url=None if settings.is_production() else "/redoc",
        openapi_url=None if settings.is_production() else "/openapi.json",
    )
    app.state.agent_enabled = agent_router is not None

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_list,
        allow_credentials=bool(settings.cors_list) and "*" not in settings.cors_list,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["WWW-Authenticate"],
    )
    # Außen um CORS: ein fremder Host-Name (DNS-Rebinding) kommt nicht bis zu einer Route.
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(HostGuardMiddleware, allowed_hosts=settings.allowed_hosts)
    # Äußerste Schicht: im Localnet-Modus bleiben öffentliche IPs und öffentliche Proxy-Header draußen.
    app.add_middleware(
        LocalnetGuardMiddleware,
        enabled=settings.localnet_only,
        allow=settings.localnet_allow,
    )


    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request, exc):  # type: ignore[no-untyped-def]
        log.exception("Unbehandelte Ausnahme: %s %s", request.method, request.url.path)
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=500, content={"detail": "Interner Fehler — wurde protokolliert."}
        )


    @app.middleware("http")
    async def no_cache_static(request, call_next):
        """Admin- und Werksicht-JS immer gegenprüfen lassen — ohne diesen Header
        hält der Browser die Module minutenlang im Heuristik-Cache und zeigt nach
        einer Änderung noch die alte Anmeldung."""
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        if request.url.path in DOCS_PATHS:
            response.headers["Content-Security-Policy"] = DOCS_CSP
        else:
            extra_frames = module_registry.frame_src_origins()
            if extra_frames:
                response.headers["Content-Security-Policy"] = (
                    f"{CSP}; frame-src 'self' {' '.join(extra_frames)}"
                )
            else:
                response.headers["Content-Security-Policy"] = CSP
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        mod_prefixes = module_registry.mounted_prefixes()
        if (
            request.url.path.startswith("/static")
            or request.url.path
            in (
                "/admin",
                "/produktion",
                "/hub",
                "/disposition",
                "/kunden",
                "/versand",
            )
            or request.url.path.startswith("/app")
            or request.url.path.startswith("/twin")
            or request.url.path.startswith("/studio")
            or (mod_prefixes and request.url.path.startswith(mod_prefixes))
        ):
            response.headers["Cache-Control"] = "no-cache"
        # Vite setzt den Inhaltshash in den Dateinamen: diese Dateien ändern sich nie.
        asset_prefixes = ("/app/assets/", "/twin/assets/", "/studio/assets/") + tuple(
            f"{p}/assets/" for p in mod_prefixes
        )
        if request.url.path.startswith(asset_prefixes) and response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


    for r in (
            auth.router, account.router, accounts.router, system_info.router, updates.router, users.router, products.router, rates.router,
            quotes.router, production.router, production.public_router, nesting.router, punchout.router, admin.router,
            shipping.router, links.router, inventory.router, integration.router, customers.router,
            desk.router, invoicing.router, factory.router,
            *((robots.router, robot_platform.router) if os.environ.get("GIMEL_ENABLE_ROBOTS") == "1" else ()),
            drawings.router, free_nesting.router,
            modules_router.router,
            # Compliance (CRA): Schwachstellenmeldungen, Sicherheitshinweise,
            # Supportzeiträume.
            compliance.router,
            # Die Teileerkennung erweitert, was die Rolle Werker erreicht. Eine Anwendung
            # entscheidet das selbst, über ``Plugin.features``.
            *((vision_api.router,) if not plugin or "vision" in plugin.features else ()),
            *((agent_router,) if agent_router is not None else ()),
            *(r for m in extra_modules if m.enabled and m.routers for r in m.routers()),
            *(plugin.routers() if plugin and plugin.routers else ()),
    ):
        app.include_router(r)


    # Das Gimel-Zeichen als Favicon. Ohne diese Route fragt jede ausgelieferte Seite
    # — auch die Laufkarte und /docs — ein /favicon.ico an, das es nicht gibt, und
    # jeder Rauchtest sieht einen 404, der nichts bedeutet.
    FAVICON = (
        b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        b'<rect width="32" height="32" rx="6" fill="#1c2127"/>'
        b'<text x="16" y="24" font-family="system-ui,sans-serif" font-size="21"'
        b' font-weight="600" fill="#fff" text-anchor="middle">&#1490;</text></svg>'
    )


    @app.get("/favicon.ico", include_in_schema=False)
    def favicon() -> Response:
        return Response(
            FAVICON,
            media_type="image/svg+xml",
            headers={"Cache-Control": "public, max-age=86400"},
        )


    @app.get("/api/health", tags=["meta"])
    def health() -> dict:
        from gimel.core.nesting import ENGINE_VERSION

        return {
            "status": "ok",
            "version": APP_VERSION,
            "engine_version": ENGINE_VERSION,
            "scheduler": scheduler.state,
            "worklist": scheduler.worklist_state,
        }


    @app.get("/api/version", tags=["meta"])
    def version(db: Annotated[Session, Depends(get_db)]) -> dict:
        from gimel.core.nesting import ENGINE_VERSION

        is_demo = False if plugin else demo.is_demo(db)
        mode = "playground" if (os.environ.get("GIMEL_MODE") == "playground" or is_demo) else "production"
        return {
            "version": APP_VERSION,
            "engine_version": ENGINE_VERSION,
            "label": f"v{APP_VERSION}",
            "name": plugin.name if plugin else "gimel",
            "features": list(plugin.features) if plugin else [],
            "agent": agent_router is not None,
            "vision": not plugin or "vision" in plugin.features,
            "robots": os.environ.get("GIMEL_ENABLE_ROBOTS") == "1",
            "localnet_only": settings.localnet_only,
            "mode": mode,
            # Das Musterwerk gibt es nur ohne Anwendung; Alef fragt die DB hier nicht.
            "demo": is_demo,
            "modules": [
                m.to_dict()
                for m in module_registry.all_modules(db, agent_enabled=agent_router is not None)
            ],
        }


    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

        # Die fünf alten Subapps sind in das interne Portal unter /app übernommen
        # (Verwaltung, Werkeransicht, Versand, Disposition, Kundenstamm). Ihre
        # Adressen bleiben als Umleitung bestehen: Lesezeichen, Aushänge an der
        # Maschine und verlinkte Laufkarten sollen nicht ins Leere laufen.
        #
        # Die Dateien selbst liegen weiter unter /static — erreichbar, wenn jemand
        # sie ausdrücklich sucht, aber nicht mehr verlinkt.
        LEGACY_ROUTES = {
            "/": "/app",
            "/hub": "/app",
            "/admin": "/app#/admin",
            "/produktion": "/app#/produktion",
            "/disposition": "/app#/disposition",
            "/kunden": "/app#/kunden",
            "/versand": "/app#/versand",
        }

        def _make_redirect(target: str):
            def endpoint() -> RedirectResponse:
                # 307 statt 301: eine dauerhafte Umleitung brennt sich in den
                # Browser-Cache und macht ein Zurückrollen zur Geduldsprobe.
                return RedirectResponse(target, status_code=307)

            return endpoint

        for _path, _target in LEGACY_ROUTES.items():
            app.add_api_route(
                _path,
                _make_redirect(_target),
                methods=["GET"],
                include_in_schema=False,
            )

    # --------------------------------------------------------------------------
    # Internes Portal (Auftragsbüro) — React/Blueprint-SPA, gebaut mit Vite.
    # Liegt nur, wenn gebaut wurde (apps/api/app/webapp/dist); ohne Build laufen
    # die bestehenden Subapps unverändert weiter.
    # --------------------------------------------------------------------------
    # Digitaler Grundriss: als eigene Oberfläche unter /twin (wie Studio & Agent Lab).
    # ``gimel twin`` startet dieselbe Oberfläche auch als eigenen Prozess (Port 8010).
    from . import twin_app as _twin_app

    _twin_app.mount(app)


    # Twin Studio: der Zwilling als eigene Oberfläche. Das Portal liefert sie
    # mit aus; ``gimel studio`` startet dieselbe Oberfläche als eigenen Prozess.
    from . import studio as _studio

    _studio.mount(app)

    # Agent Lab: liegt ``agentlab`` neben Gimel, liefert das Portal auch dessen
    # Oberfläche unter /lab aus (die /api/agent-Routen sind oben schon dabei).
    if agent_router is not None:
        try:
            from agentlab.app import _mount_lab
            from agentlab.knowledge_graph import start_auto_sync

            _mount_lab(app)
            start_auto_sync()
        except ImportError:
            log.warning("Agent Lab: Oberfläche nicht verfügbar")

    # Spracheingabe im Test-Portal (task 43): Erkennung auf diesem Rechner, nur
    # mit GIMEL_VOICE=1. Nie einschalten, solange ein Tunnel auf diesen Prozess
    # zeigt (``fyrefly gimel public``) — die Erkennung kostet CPU je Anfrage.
    if agent_router is not None and os.environ.get("GIMEL_VOICE") == "1":
        from .agent_bridge import load_voice

        voice_router, warm_up = load_voice()
        if voice_router is not None:
            app.include_router(voice_router)
            # Vor die Sammelrouten des Portals, wie im Studio.
            count = len(voice_router.routes)
            app.router.routes[:0] = app.router.routes[-count:]
            del app.router.routes[-count:]
            if warm_up is not None and os.environ.get("GIMEL_VOICE_WARMUP", "1") != "0":
                warm_up()

    # Composable semi-external SPAs (Python-Module oder GIMEL_MODULES_FILE mit mount_path + dist_dir)
    for _mod in (*extra_modules, *module_registry.load_file_modules()):
        if _mod.enabled and _mod.mount_path and _mod.dist_dir:
            module_registry.mount_spa(app, _mod.mount_path, _mod.dist_dir, _mod.id)

    WEBAPP_DIR = Path(__file__).resolve().parent / "webapp" / "dist"

    if WEBAPP_DIR.exists():
        if (WEBAPP_DIR / "assets").exists():
            app.mount(
                "/app/assets",
                StaticFiles(directory=WEBAPP_DIR / "assets"),
                name="webapp-assets",
            )

        @app.get("/app/{full_path:path}", include_in_schema=False)
        @app.get("/app", include_in_schema=False)
        def webapp(full_path: str = "") -> Response:
            # Echte Dateien (favicon, ...) direkt, jeder andere Pfad ist eine
            # Route der SPA und bekommt die Hülle.
            candidate = (WEBAPP_DIR / full_path.lstrip("/")) if full_path else None
            if (
                candidate
                and candidate.is_file()
                and candidate.resolve().is_relative_to(WEBAPP_DIR.resolve())
            ):
                return FileResponse(candidate)
            return FileResponse(WEBAPP_DIR / "index.html")

    return app
