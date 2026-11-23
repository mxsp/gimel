"""Die Agent-Lab-Anwendung: Gimel + Assistent, ohne Änderung an Gimel.

Sie wird als eigenes Uvicorn-Programm gestartet. Die Datenbank ist die des
laufenden Gimel (siehe ``__main__``); der Taktgeber bleibt allein dort, damit
zwei Prozesse nicht zwei Sammelläufe planen.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

# Zuerst die Tabellen anmelden, dann die Anwendung bauen: init_db legt beim
# Start nur an, was in der Metadata steht.
from . import models as _models  # noqa: F401

from gimel.extensions import Plugin, use


async def _idle_scheduler() -> None:
    """Platzhalter für Gimels Taktgeber: das Labor plant keinen Sammellauf."""
    while True:
        await asyncio.sleep(3600)


def create_lab_app(*, voice_warmup: bool = False) -> FastAPI:
    # gimel.app hat das Modul bereits importiert; das Attribut wird bei jedem
    # Aufruf neu gelesen, deshalb wirkt der Austausch auch bei einem Factory-Aufruf.
    from gimel.services import scheduler

    scheduler.loop = _idle_scheduler

    from .router import router
    from .seed import seed
    from .voice_router import voice_router

    use(
        Plugin(
            name="agentlab",
            title="Gimel Agent Lab",
            description="Assistent für Gimel — Laborbetrieb auf derselben Datenbank.",
            routers=lambda: [router, voice_router],
            seed=seed,
        )
    )

    from gimel.app import create_app

    app = create_app()
    _mount_voice(app)
    _mount_lab(app)
    _register_sandbox_lifecycle(app)
    from .knowledge_graph import start_auto_sync
    start_auto_sync()
    if voice_warmup:
        from . import transcribe

        transcribe.warm_up()
    return app


def _register_sandbox_lifecycle(app: FastAPI) -> None:
    from contextlib import asynccontextmanager

    from . import sandbox as sandbox_service

    try:
        sandbox_service.cleanup_orphans()
    except Exception:  # noqa: BLE001
        pass

    prev_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def _wrapped_lifespan(target_app: FastAPI):
        async with prev_lifespan(target_app):
            try:
                yield
            finally:
                sandbox_service.cleanup_all()

    app.router.lifespan_context = _wrapped_lifespan


def create_voice_app() -> FastAPI:
    """Gimel Voice als eigener Prozess: dasselbe Labor, ``/`` führt nach ``/voice``.

    ``/voice`` gibt es auch im Agent Lab selbst (8008, mit PIN-Anmeldung).
    """
    app = create_lab_app(voice_warmup=True)

    # Die Startseite des Portals bleibt erreichbar unter /app; die Wurzel
    # führt in diesem Prozess direkt zur Sprachoberfläche. Eine eingebundene
    # Route lässt sich nicht entfernen, also vorn einfügen.
    app.add_api_route("/", lambda: RedirectResponse("/voice", status_code=307),
                      methods=["GET"], include_in_schema=False)
    app.router.routes.insert(0, app.router.routes.pop())

    # Wie im Studio: die PIN-Sperre zählt Fehlversuche je Prozess im Speicher.
    # Ein weiterer Prozess verdoppelte die erlaubten Versuche, deshalb gibt es
    # hier keine PIN-Anmeldung. Mit PIN: /voice im Agent Lab (8008) öffnen.
    def pin_not_here() -> None:
        raise HTTPException(status_code=404, detail="PIN-Anmeldung nur im Portal und im Agent Lab.")

    def login_options() -> dict:
        return {"test_pin_enabled": False, "gimel_pin_enabled": False}

    for path, fn, method in (("/api/auth/pin", pin_not_here, "POST"),
                             ("/api/auth/login-options", login_options, "GET")):
        app.add_api_route(path, fn, methods=[method], include_in_schema=False)
        app.router.routes.insert(0, app.router.routes.pop())
    return app


def _mount_voice(app: FastAPI) -> None:
    dist = Path(__file__).resolve().parent / "webapp" / "dist"
    page = dist / "voice.html"

    @app.middleware("http")
    async def voice_no_stale_cache(request, call_next):
        response = await call_next(request)
        if request.url.path == "/voice":
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            # Mikrofon nur für diese Seite selbst, nie für eingebettete Fremdseiten.
            response.headers["Permissions-Policy"] = "microphone=(self)"
        return response

    @app.get("/voice", include_in_schema=False)
    def voice_page():
        if not page.exists():
            return HTMLResponse(
                "<!doctype html><meta charset='utf-8'><title>Gimel Voice</title>"
                "<h1>Gimel Voice</h1><p>Die Oberfläche ist noch nicht gebaut: "
                "<code>cd agentlab/web &amp;&amp; npm run build</code>.</p>"
            )
        return FileResponse(page)


def _mount_lab(app: FastAPI) -> None:
    @app.middleware("http")
    async def lab_no_stale_cache(request, call_next):
        response = await call_next(request)
        path = request.url.path
        if (path == "/lab" or path.startswith("/lab/")) and not path.startswith("/lab/assets/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        # Im Agent Lab darf das Seiten-Vorschaufenster (Side Preview) HTML-Artefakte
        # (srcDoc/blob:), lokale Portal-Ansichten (/app, /twin) und Webseiten in
        # einem isolierten iframe darstellen.
        csp = response.headers.get("Content-Security-Policy")
        if path == "/lab" or path.startswith("/lab/"):
            if csp and "frame-src" not in csp:
                response.headers["Content-Security-Policy"] = (
                    csp + "; frame-src 'self' blob: data: https: http:"
                )
        elif path in ("/app", "/twin", "/studio") or path.startswith(("/app/", "/twin/", "/studio/")):
            response.headers["X-Frame-Options"] = "SAMEORIGIN"
            if csp:
                updated = csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'")
                if "frame-src" not in updated:
                    updated += "; frame-src 'self' blob: data:"
                response.headers["Content-Security-Policy"] = updated
        return response

    root = Path(__file__).resolve().parent
    dist = root / "webapp" / "dist"
    if not dist.exists():
        @app.get("/lab", include_in_schema=False)
        @app.get("/lab/{full_path:path}", include_in_schema=False)
        def lab_missing(full_path: str = "") -> HTMLResponse:
            return HTMLResponse(
                "<!doctype html><meta charset='utf-8'>"
                "<title>Agent Lab</title>"
                "<h1>Agent Lab</h1>"
                "<p>Die Oberfläche ist noch nicht gebaut. Bitte im Ordner "
                "<code>agentlab/web</code> <code>npm install &amp;&amp; npm run build</code> "
                "ausführen und den Server neu starten.</p>"
            )
        return

    assets = dist / "assets"
    if assets.exists():
        app.mount("/lab/assets", StaticFiles(directory=assets), name="agentlab-assets")

    @app.get("/lab", include_in_schema=False)
    @app.get("/lab/{full_path:path}", include_in_schema=False)
    def lab(full_path: str = "") -> FileResponse:
        candidate = (dist / full_path.lstrip("/")) if full_path else None
        if candidate and candidate.is_file() and candidate.resolve().is_relative_to(dist.resolve()):
            return FileResponse(candidate)
        return FileResponse(dist / "index.html")
