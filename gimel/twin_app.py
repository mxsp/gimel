"""Digitaler Grundriss — die Hallenübersicht und der Hallen-Editor als eigene Anwendung.

Zwei Wege führen hinein (wie Twin Studio und Agent Lab):

* Das Hauptportal liefert ``/twin`` selbst aus (``mount``), damit der Link in
  der Seitenleiste ohne zusätzlichen Dienst funktioniert.
* ``gimel twin`` (oder ``gimel grundriss``) startet einen eigenen Prozess
  (Vorgabe Port 8010) auf demselben Datenordner: dieselbe Datenbank, derselbe
  ``secret.key``, dieselben Konten. Der Taktgeber bleibt still — nur das
  laufende Haupt-Gimel plant den Sammellauf.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

PORT = 8010
DIST = Path(__file__).resolve().parent / "twin" / "dist"


def _entry_html() -> Path | None:
    for name in ("twin.html", "index.html"):
        p = DIST / name
        if p.exists():
            return p
    return None


def mount(app: FastAPI) -> None:
    """``/twin`` als eigenständige Single-Page-App. Ohne Bau ein Hinweis statt 404."""
    entry = _entry_html()
    if entry is None:
        @app.get("/twin", include_in_schema=False)
        @app.get("/twin/{full_path:path}", include_in_schema=False)
        def twin_missing(full_path: str = "") -> HTMLResponse:
            return HTMLResponse(
                "<!doctype html><meta charset='utf-8'><title>Digitaler Grundriss</title>"
                "<h1>Digitaler Grundriss</h1><p>Die Oberfläche ist noch nicht gebaut: im Ordner "
                "<code>web</code> <code>npm run build</code> ausführen und neu starten.</p>",
                status_code=503,
            )
        return

    if (DIST / "assets").exists():
        app.mount("/twin/assets", StaticFiles(directory=DIST / "assets"), name="twin-assets")

    @app.get("/twin", include_in_schema=False)
    @app.get("/twin/{full_path:path}", include_in_schema=False)
    def twin(full_path: str = "") -> Response:
        candidate = (DIST / full_path.lstrip("/")) if full_path else None
        if candidate and candidate.is_file() and candidate.resolve().is_relative_to(DIST.resolve()):
            return FileResponse(candidate)
        return FileResponse(entry)


async def _idle_scheduler() -> None:
    """Platzhalter für den Taktgeber: der Grundriss-Prozess plant keinen Sammellauf."""
    while True:
        await asyncio.sleep(3600)


def create_twin_app() -> FastAPI:
    """Gimel ohne eigenen Taktgeber; ``/`` führt direkt in den Digitalen Grundriss."""
    from .services import scheduler

    scheduler.loop = _idle_scheduler

    from .app import create_app

    app = create_app()

    def root() -> RedirectResponse:
        return RedirectResponse("/twin/", status_code=307)

    app.add_api_route("/", root, methods=["GET"], include_in_schema=False)
    assert getattr(app.router.routes[-1], "path", None) == "/", "Grundriss-Wurzel nicht zuletzt angelegt"
    app.router.routes.insert(0, app.router.routes.pop())

    # PIN-Sperre zählt je Prozess im Speicher — wie im Studio gehört PIN allein dem Portal.
    def pin_not_here() -> None:
        raise HTTPException(status_code=404, detail="PIN-Anmeldung nur im Portal.")

    def login_options() -> dict:
        return {"test_pin_enabled": False, "gimel_pin_enabled": False}

    for path, fn, method in (
        ("/api/auth/pin", pin_not_here, "POST"),
        ("/api/auth/login-options", login_options, "GET"),
    ):
        app.add_api_route(path, fn, methods=[method], include_in_schema=False)
        app.router.routes.insert(0, app.router.routes.pop())

    return app
