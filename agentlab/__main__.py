"""Startbefehle: ``python -m agentlab serve --port 8008`` (Labor) und
``python -m agentlab voice`` (Gimel Voice auf 8012).

Die Umgebung wird gesetzt, *bevor* ``gimel`` importiert wird. Nur so liest
``gimel.config`` dieselbe Datenbank, denselben Betriebsschlüssel und dieselbe
``.env`` wie der laufende Gimel-Prozess.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import webbrowser
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8008
VOICE_PORT = 8012


def _prepare(data: Path, database_url: str) -> Path:
    data = data.resolve()
    db = data / "gimel.db"
    database_url = database_url or os.environ.get("GIMEL_DATABASE_URL", "")
    if database_url:
        os.environ["GIMEL_DATABASE_URL"] = database_url
        if database_url.startswith("sqlite:///"):
            db = Path(database_url.removeprefix("sqlite:///"))
    needs_file = not database_url or database_url.startswith("sqlite")
    if needs_file and not db.exists():
        raise SystemExit(
            f"Keine Gimel-Datenbank unter {db}.\n"
            "Bitte zuerst Gimel mit diesem Datenordner starten "
            "(gimel serve) oder --data auf den richtigen Ordner setzen."
        )
    os.environ.setdefault("GIMEL_APP_ROOT", str(data))
    if not os.environ.get("GIMEL_SECRET_KEY"):
        secret = data / "secret.key"
        if secret.exists():
            os.environ["GIMEL_SECRET_KEY"] = secret.read_text(encoding="utf-8").strip()
    if not os.environ.get("GIMEL_SECRET_KEY"):
        raise SystemExit(
            "GIMEL_SECRET_KEY fehlt und es gibt keine secret.key im Datenordner. "
            "Das Labor braucht denselben Schlüssel wie Gimel."
        )
    return data


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    # Das Labor erkennt Sprache und hat Schreibwerkzeuge: nur auf der Schleife. Ins Hausnetz
    # führt das HTTPS-Tor, nie ein offener Port (security-advisor, task 43).
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("Agent Lab lauscht nur auf 127.0.0.1, localhost oder ::1.")

    data = _prepare(Path(args.data), args.database_url)
    page = getattr(args, "page", "/lab")
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}{page}"
    print(f"{getattr(args, 'title', 'Gimel Agent Lab')} — {url}  (gemeinsame Datenbank: {data})")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(
        getattr(args, "factory", "agentlab.app:create_lab_app"),
        factory=True,
        host=args.host,
        port=args.port,
        log_level="info",
        proxy_headers=False,
    )
    return 0


def _serve_voice(args: argparse.Namespace) -> int:
    # Das Mikrofon verlangt einen sicheren Kontext: http geht nur auf localhost.
    # Wie beim Studio nimmt die CLI deshalb nur Schleifen-Adressen an; das LAN
    # erreicht die Seite über das HTTPS-Tor.
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("Gimel Voice lauscht nur auf 127.0.0.1 (Mikrofon braucht localhost oder HTTPS).")
    args.factory = "agentlab.app:create_voice_app"
    args.page = "/voice"
    args.title = "Gimel Voice"
    return _serve(args)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="agentlab", description="Gimel Agent Lab")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="Agent Lab auf Port 8008 starten")
    s.add_argument("--host", default=HOST)
    s.add_argument("--port", type=int, default=PORT)
    s.add_argument("--data", default=str(Path.cwd() / ".data"),
                   help="Datenordner der laufenden Gimel-Instanz")
    s.add_argument("--database-url", default="",
                   help="optional: abweichende DB-URL (sonst <data>/gimel.db)")
    s.add_argument("--no-browser", action="store_true")
    s.set_defaults(fn=_serve)
    v = sub.add_parser("voice", help="Gimel Voice (Sprechen mit dem Assistenten) auf Port 8012")
    v.add_argument("--host", default=HOST)
    v.add_argument("--port", type=int, default=VOICE_PORT)
    v.add_argument("--data", default=str(Path.cwd() / ".data"),
                   help="Datenordner der laufenden Gimel-Instanz")
    v.add_argument("--database-url", default="")
    v.add_argument("--no-browser", action="store_true")
    v.set_defaults(fn=_serve_voice)
    args = p.parse_args(argv)
    return int(args.fn(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
