"""Twin Studio — der digitale Zwilling als eigene Anwendung.

Zwei Wege führen hinein:

* Das Hauptportal liefert ``/studio`` selbst aus (``mount``), damit der Link in
  der Seitenleiste auf jeder Installation funktioniert.
* ``gimel studio`` startet einen eigenen Prozess (Vorgabe Port 8009) auf
  demselben Datenordner: dieselbe Datenbank, derselbe ``secret.key``, dieselben
  Konten. Der Taktgeber bleibt dort still — wie im Agent Lab plant nur das
  laufende Gimel, nie zwei Prozesse denselben Sammellauf.

Das Studio liest über dieselbe API wie das Portal; es bringt nur die
gespeicherten Ansichten (``/api/factory/views``) mit, und die liegen im
Fabrik-Router, damit eine Anwendung auf Gimel nichts nachtragen muss.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

PORT = 8009
DIST = Path(__file__).resolve().parent / "studio" / "dist"


def mount(app: FastAPI) -> None:
    """``/studio`` als Single-Page-App. Ohne Bau ein Hinweis statt 404."""
    if not (DIST / "studio.html").exists():
        @app.get("/studio", include_in_schema=False)
        @app.get("/studio/{full_path:path}", include_in_schema=False)
        def studio_missing(full_path: str = "") -> HTMLResponse:
            return HTMLResponse(
                "<!doctype html><meta charset='utf-8'><title>Twin Studio</title>"
                "<h1>Twin Studio</h1><p>Die Oberfläche ist noch nicht gebaut: im Ordner "
                "<code>web</code> <code>npm run build</code> ausführen und neu starten.</p>",
                status_code=503,
            )
        return

    if (DIST / "assets").exists():
        app.mount("/studio/assets", StaticFiles(directory=DIST / "assets"), name="studio-assets")

    @app.get("/studio", include_in_schema=False)
    @app.get("/studio/{full_path:path}", include_in_schema=False)
    def studio(full_path: str = "") -> Response:
        candidate = (DIST / full_path.lstrip("/")) if full_path else None
        if candidate and candidate.is_file() and candidate.resolve().is_relative_to(DIST.resolve()):
            return FileResponse(candidate)
        return FileResponse(DIST / "studio.html")


async def _idle_scheduler() -> None:
    """Platzhalter für den Taktgeber: das Studio plant keinen Sammellauf."""
    while True:
        await asyncio.sleep(3600)


def create_studio_app() -> FastAPI:
    """Gimel ohne eigenen Taktgeber; ``/`` führt ins Studio."""
    from .services import scheduler

    scheduler.loop = _idle_scheduler

    from .app import create_app

    app = create_app()

    def root() -> RedirectResponse:
        return RedirectResponse("/studio/", status_code=307)

    # Das Portal führt ``/`` nach ``/app``; hier gewinnt das Studio. Die erste
    # passende Route gilt, also kommt diese nach vorn.
    app.add_api_route("/", root, methods=["GET"], include_in_schema=False)
    assert getattr(app.router.routes[-1], "path", None) == "/", "Studio-Wurzel nicht zuletzt angelegt"
    app.router.routes.insert(0, app.router.routes.pop())

    # Die PIN-Sperre zählt Fehlversuche im Speicher, je Prozess. Ein zweiter
    # Prozess verdoppelte die erlaubten Versuche — die PIN-Anmeldung gehört
    # deshalb allein dem Portal. Die Route fällt hier weg (404 mit allen
    # Sicherheitsköpfen), und die Anmeldemaske bietet keine PIN an.
    def pin_not_here() -> None:
        raise HTTPException(status_code=404, detail="PIN-Anmeldung nur im Portal.")

    def login_options() -> dict:
        return {"test_pin_enabled": False, "gimel_pin_enabled": False}

    # Eingebundene Router liegen verschachtelt; entfernen lässt sich die Route
    # nicht, also gewinnen diese beiden, weil sie vorn stehen.
    for path, fn, method in (("/api/auth/pin", pin_not_here, "POST"),
                             ("/api/auth/login-options", login_options, "GET")):
        app.add_api_route(path, fn, methods=[method], include_in_schema=False)
        app.router.routes.insert(0, app.router.routes.pop())

    # Spracheingabe im Studio-Assistenten (task 43): Erkennung auf diesem Rechner.
    # Nur hier und im Agent Lab, nie im Portal, das ein Tunnel erreichen kann;
    # `gimel studio` lehnt andere Hosts als die Schleife ab. Abschalten mit
    # GIMEL_STUDIO_VOICE=0.
    if os.environ.get("GIMEL_STUDIO_VOICE", "1") != "0":
        from .agent_bridge import load_voice

        voice_router, warm_up = load_voice()
        if voice_router is not None:
            app.include_router(voice_router)
            # Vor die Sammelrouten des Portals, damit /api/agent/transcribe hier ankommt.
            count = len(voice_router.routes)
            app.router.routes[:0] = app.router.routes[-count:]
            del app.router.routes[-count:]
            if warm_up is not None and os.environ.get("GIMEL_VOICE_WARMUP", "1") != "0":
                warm_up()
    return app
