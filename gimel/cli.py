"""``gimel`` — run the server, seed the demo plant, create users."""

from __future__ import annotations

import argparse
import getpass
import os
import secrets
import sys
import threading
import webbrowser
from pathlib import Path

from sqlalchemy.engine import make_url

from . import __version__

HOST = "127.0.0.1"
PORT = 8040


def _data_dir() -> Path:
    from .config import API_ROOT

    API_ROOT.mkdir(parents=True, exist_ok=True)
    return API_ROOT


def _lock_down(data: Path) -> None:
    """Only this user reads a standalone plant: folder 0700, database 0600. Also on files
    from an older version. An application looks after its own folder."""
    from .config import STANDALONE, get_settings

    if not STANDALONE:
        return
    paths = [(data, 0o700)]
    url = make_url(get_settings().database_url)
    if url.get_backend_name() == "sqlite" and url.database:
        paths += [(Path(f"{url.database}{suffix}"), 0o600) for suffix in ("", "-wal", "-shm")]
    for path, mode in paths:
        if not path.exists():
            continue
        try:
            os.chmod(path, mode)
        except OSError as e:
            print(f"WARNING: could not restrict {path}: {e}", file=sys.stderr)


def _ensure_secret(data: Path) -> None:
    """Sessions survive a restart: the key lives in the data folder, not in the code."""
    if os.environ.get("GIMEL_SECRET_KEY"):
        return
    path = data / "secret.key"
    if not path.exists():
        path.write_text(secrets.token_urlsafe(48))
        os.chmod(path, 0o600)
    os.environ["GIMEL_SECRET_KEY"] = path.read_text().strip()


def _init(args: argparse.Namespace | None = None) -> Path:
    data = _data_dir()
    _ensure_secret(data)
    if args is not None and getattr(args, "reset", False):
        for suffix in ("", "-wal", "-shm"):
            p = data / f"gimel.db{suffix}"
            if p.exists():
                p.unlink()
    from .seed import init_db

    init_db(verbose=False)
    _lock_down(data)
    return data


def _demo_enrich() -> int:
    """Bring the existing demo plant to life — never resets, never reseeds."""
    from .config import ENV_PREFIX

    data = _data_dir()
    if not (data / "gimel.db").exists() and not os.environ.get(f"{ENV_PREFIX}DATABASE_URL"):
        print(f"gimel demo --enrich: no database in {data} — run `gimel demo` first.",
              file=sys.stderr)
        return 1
    _ensure_secret(data)
    from sqlalchemy.exc import SQLAlchemyError

    from . import demo
    from .db import SessionLocal

    # Refuse before `_init` migrates anything: a database that is not the demo is not upgraded either.
    try:
        with SessionLocal() as db:
            plant = demo.is_demo(db)
    except SQLAlchemyError:
        plant = False
    if not plant:
        print(f"gimel demo --enrich: {demo.NotADemo.MESSAGE}", file=sys.stderr)
        return 1
    data = _init()
    try:
        result = demo.enrich_atomic()
    except demo.NotADemo as e:
        print(f"gimel demo --enrich: {e}", file=sys.stderr)
        return 1
    except Exception:
        print("gimel demo --enrich: failed, rolled back — nothing changed.", file=sys.stderr)
        raise
    print(f"Demo plant 'Musterwerk GmbH' in {data}: {len(result.changes)} change(s)")
    for line in result.changes:
        print(f"  + {line}")
    for line in result.notes:
        print(f"  - {line}")
    return 0


def _demo(args: argparse.Namespace) -> int:
    if getattr(args, "enrich", False):
        return _demo_enrich()
    data = _init(args)
    from . import demo
    from .db import SessionLocal

    with SessionLocal() as db:
        try:
            password = demo.seed(db)
        except RuntimeError as e:
            print(f"gimel demo: {e}", file=sys.stderr)
            return 1
    cred = data / "demo-login.txt"
    cred.write_text(f"{demo.ADMIN_EMAIL}\n{password}\n")
    os.chmod(cred, 0o600)
    print(f"Demo plant 'Musterwerk GmbH' created in {data}")
    print(f"Sign in as {demo.ADMIN_EMAIL} — password in {cred}")
    return 0


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    if getattr(args, "voice", False):
        # Opt-in fürs Test-Portal: Spracherkennung auf diesem Rechner (task 43).
        os.environ["GIMEL_VOICE"] = "1"
    data = _init()
    host = args.host or HOST
    port = args.port or PORT
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}/app"
    if host not in ("127.0.0.1", "localhost", "::1"):
        print(f"WARNING: Gimel is reachable from other machines on {host}. "
              "Put it behind HTTPS before anyone uses it over a network.", file=sys.stderr)
    print(f"Gimel {__version__} — {url}  (data: {data})")
    if os.environ.get("GIMEL_VOICE") == "1":
        print("Spracherkennung an (GIMEL_VOICE=1) — nur fürs Test-Portal, nie mit Tunnel.")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run("gimel.app:create_app", factory=True, host=host, port=port, log_level="info",
                proxy_headers=False)
    return 0


def _studio(args: argparse.Namespace) -> int:
    """Twin Studio als eigener Prozess auf demselben Datenordner (ohne Taktgeber)."""
    import uvicorn

    from .studio import PORT as STUDIO_PORT

    data = _data_dir()
    if not (data / "gimel.db").exists() and not os.environ.get("GIMEL_DATABASE_URL"):
        print(f"gimel studio: keine Datenbank in {data}. Erst `gimel demo` oder `gimel serve` "
              "mit diesem Datenordner starten.", file=sys.stderr)
        return 1
    data = _init()
    host = args.host or HOST
    port = args.port or STUDIO_PORT
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}/studio/"
    if host not in ("127.0.0.1", "localhost", "::1"):
        # Netzzugang läuft über das Portal (/studio) hinter dessen HTTPS-Tor;
        # der zweite Prozess bleibt auf diesem Rechner.
        print(f"gimel studio: only 127.0.0.1, localhost or ::1 — use /studio in the portal for "
              f"access over the network (got {host}).", file=sys.stderr)
        return 2
    print(f"Gimel Twin Studio {__version__} — {url}  (data: {data}, no scheduler)")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run("gimel.studio:create_studio_app", factory=True, host=host, port=port,
                log_level="info", proxy_headers=False)
    return 0


def _twin(args: argparse.Namespace) -> int:
    """Digitaler Grundriss als eigener Prozess auf demselben Datenordner (ohne Taktgeber)."""
    import uvicorn

    from .twin_app import PORT as TWIN_PORT

    data = _data_dir()
    if not (data / "gimel.db").exists() and not os.environ.get("GIMEL_DATABASE_URL"):
        print(f"gimel twin: keine Datenbank in {data}. Erst `gimel demo` oder `gimel serve` "
              "mit diesem Datenordner starten.", file=sys.stderr)
        return 1
    data = _init()
    host = args.host or HOST
    port = args.port or TWIN_PORT
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}/twin/"
    if host not in ("127.0.0.1", "localhost", "::1"):
        print(f"gimel twin: only 127.0.0.1, localhost or ::1 — use /twin in the portal for "
              f"access over the network (got {host}).", file=sys.stderr)
        return 2
    print(f"Gimel Digitaler Grundriss {__version__} — {url}  (data: {data}, no scheduler)")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run("gimel.twin_app:create_twin_app", factory=True, host=host, port=port,
                log_level="info", proxy_headers=False)
    return 0


def _hall3(args: argparse.Namespace) -> int:
    """Halle 3 Experimental idempotent daneben setzen — ohne Demo zurückzusetzen."""
    _init()
    from . import hall3
    from .db import SessionLocal

    with SessionLocal() as db:
        print(hall3.ensure_hall3(db))
    return 0


def _run_mode(mode: str, args: argparse.Namespace) -> int:
    from . import launcher

    argv = [
        "--mode", mode,
        "--host", args.host or HOST,
        "--port", str(args.port or (PORT if mode == "playground" else 8041)),
    ]
    if getattr(args, "reset", False):
        argv.append("--reset")
    if getattr(args, "no_browser", False):
        argv.append("--no-browser")
    if getattr(args, "admin_email", ""):
        argv += ["--admin-email", args.admin_email]
    if getattr(args, "admin_password", ""):
        argv += ["--admin-password", args.admin_password]
    return launcher.main(argv)


def _adduser(args: argparse.Namespace) -> int:
    _init()
    from .db import SessionLocal
    from .models import Role, User
    from .security import hash_password

    pw = args.password or getpass.getpass("Password (min. 12 characters): ")
    if len(pw) < 12:
        print("Too short.", file=sys.stderr)
        return 1
    with SessionLocal() as db:
        if db.query(User).filter(User.email == args.email.lower()).count():
            print("User exists.", file=sys.stderr)
            return 1
        db.add(User(email=args.email.lower(), name=args.name or "", role=Role(args.role),
                    password_hash=hash_password(pw), active=True))
        db.commit()
    print(f"Created {args.role} {args.email}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="gimel", description="Gimel — orders in, parts out.")
    p.add_argument("--version", action="version", version=f"gimel {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("demo", help="create the demo plant 'Musterwerk GmbH'")
    once = d.add_mutually_exclusive_group()
    once.add_argument("--reset", action="store_true", help="delete the local database first")
    once.add_argument("--enrich", action="store_true",
                      help="bring the existing demo to life (running jobs, storage kinds, "
                           "capacities, a second AMR); idempotent, never resets")
    d.set_defaults(fn=_demo)

    s = sub.add_parser("serve", help="run Gimel and open it in the browser")
    s.add_argument("--host", default=None)
    s.add_argument("--port", type=int, default=None)
    s.add_argument("--no-browser", action="store_true")
    s.add_argument("--voice", action="store_true",
                   help="enable local speech recognition for the assistant's Live mode "
                        "(GIMEL_VOICE=1; test portal only, never while a tunnel points here)")
    s.set_defaults(fn=_serve)

    pg = sub.add_parser("playground", help="run isolated Playground sandbox ('Musterwerk GmbH', port 8040)")
    pg.add_argument("--host", default=HOST)
    pg.add_argument("--port", type=int, default=PORT)
    pg.add_argument("--reset", action="store_true", help="reset the playground database before starting")
    pg.add_argument("--no-browser", action="store_true")
    pg.set_defaults(fn=lambda a: _run_mode("playground", a))

    pr = sub.add_parser("production", help="run clean Production server (empty DB / PostgreSQL, port 8041)")
    pr.add_argument("--host", default=HOST)
    pr.add_argument("--port", type=int, default=8041)
    pr.add_argument("--admin-email", default="")
    pr.add_argument("--admin-password", default="")
    pr.add_argument("--no-browser", action="store_true")
    pr.set_defaults(fn=lambda a: _run_mode("production", a))

    t = sub.add_parser("studio", help="run Twin Studio (the digital twin on its own, port 8009)")
    t.add_argument("--host", default=None)
    t.add_argument("--port", type=int, default=None)
    t.add_argument("--no-browser", action="store_true")
    t.set_defaults(fn=_studio)

    tw = sub.add_parser("twin", aliases=["grundriss"],
                        help="run Digitaler Grundriss standalone (port 8010)")
    tw.add_argument("--host", default=None)
    tw.add_argument("--port", type=int, default=None)
    tw.add_argument("--no-browser", action="store_true")
    tw.set_defaults(fn=_twin)

    h = sub.add_parser("hall3", help="add 'Hall 3 Experimental' next to Halle 2 (one floor, one door, 7-axis arm)")
    h.set_defaults(fn=_hall3)

    u = sub.add_parser("adduser", help="create a user")
    u.add_argument("email")
    u.add_argument("--name", default="")
    u.add_argument("--password", default="", help="default: ask")
    u.add_argument("--role", choices=["admin", "staff", "worker"], default="staff")
    u.set_defaults(fn=_adduser)

    args = p.parse_args(argv)
    return int(args.fn(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
