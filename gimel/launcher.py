"""Unified Playground & Production launcher for Gimel (CLI, Docker, and Executable).

Always supports both isolated environments out of the box:

* **playground** — Pre-seeded sandbox plant ("Musterwerk GmbH") in ``<base>/playground``
  with SQLite, demo credentials printed on startup, and ``--reset`` support.
* **production** — Clean, empty production database in ``<base>/production`` (or
  PostgreSQL via ``GIMEL_DATABASE_URL``), ``GIMEL_ENV=production`` (no Swagger/docs,
  strict secret key, refuses demo data), optional initial admin bootstrap via
  ``GIMEL_ADMIN_EMAIL`` / ``GIMEL_ADMIN_PASSWORD``.
* **both** — Starts Playground (port 8040) and Production (port 8041) concurrently
  in isolated subprocesses (works identically in Python and PyInstaller bundles).
"""

from __future__ import annotations

import argparse
import os
import secrets
import signal
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Literal

Mode = Literal["playground", "production", "both"]

DEFAULT_HOST = "127.0.0.1"
PLAYGROUND_PORT = 8040
PRODUCTION_PORT = 8041


def _default_base_dir() -> Path:
    env_dir = os.environ.get("GIMEL_HOME") or os.environ.get("GIMEL_BASE_DATA")
    if env_dir:
        return Path(env_dir).expanduser()
    if getattr(sys, "frozen", False):
        return Path.home() / ".local" / "share" / "gimel"
    return Path(os.environ.get("GIMEL_DATA") or (Path.home() / ".local" / "share" / "gimel")).expanduser()


def _mode_data_dir(base: Path, mode: Literal["playground", "production"]) -> Path:
    explicit = os.environ.get("GIMEL_DATA")
    if explicit and Path(explicit).name in ("playground", "production"):
        target = Path(explicit).expanduser()
    elif explicit and os.environ.get("GIMEL_DATA_EXACT") == "1":
        target = Path(explicit).expanduser()
    else:
        target = base / mode
    target.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(target, 0o700)
    except OSError:
        pass
    return target


def _ensure_key_file(data_dir: Path, filename: str, env_var: str) -> str:
    existing = os.environ.get(env_var, "").strip()
    if existing and len(existing) >= 32:
        return existing
    key_file = data_dir / filename
    if key_file.is_file():
        key = key_file.read_text(encoding="utf-8").strip()
        if len(key) >= 32:
            os.environ[env_var] = key
            return key
    key = secrets.token_urlsafe(48)
    key_file.write_text(key, encoding="utf-8")
    try:
        os.chmod(key_file, 0o600)
    except OSError:
        pass
    os.environ[env_var] = key
    return key


def _configure_env_before_import(
    mode: Literal["playground", "production"],
    data_dir: Path,
    host: str,
) -> None:
    os.environ["GIMEL_MODE"] = mode
    os.environ["GIMEL_DATA"] = str(data_dir)
    os.environ["GIMEL_APP_ROOT"] = str(data_dir)
    os.environ["GIMEL_ENV"] = "production" if mode == "production" else "development"
    # Robots disabled by default in packaged releases (opt-in via GIMEL_ENABLE_ROBOTS=1)
    os.environ.setdefault("GIMEL_ENABLE_ROBOTS", "0")
    _ensure_key_file(data_dir, "secret.key", "GIMEL_SECRET_KEY")
    if mode == "production":
        _ensure_key_file(data_dir, "portal.token", "GIMEL_PORTAL_TOKEN")
        os.environ.setdefault("GIMEL_BOOTSTRAP_ADMIN_PASSWORD", "")
        os.environ.setdefault("GIMEL_MAIL_SILENT", "1")
        if host in ("0.0.0.0", "::") and not os.environ.get("GIMEL_ALLOWED_HOSTS"):
            os.environ["GIMEL_ALLOWED_HOSTS"] = "127.0.0.1,localhost,*"


def _prepare_playground(data_dir: Path, reset: bool) -> tuple[str, str]:
    if reset:
        for suffix in ("", "-wal", "-shm"):
            p = data_dir / f"gimel.db{suffix}"
            if p.exists():
                p.unlink()

    from gimel import demo
    from gimel.db import SessionLocal
    from gimel.models import User
    from gimel.seed import init_db

    init_db(verbose=False)
    cred_file = data_dir / "demo-login.txt"
    with SessionLocal() as db:
        has_users = db.query(User).count() > 0
        if not has_users:
            password = demo.seed(db)
            cred_file.write_text(f"{demo.ADMIN_EMAIL}\n{password}\n", encoding="utf-8")
            try:
                os.chmod(cred_file, 0o600)
            except OSError:
                pass
            return demo.ADMIN_EMAIL, password
    if cred_file.is_file():
        lines = cred_file.read_text(encoding="utf-8").splitlines()
        if len(lines) >= 2:
            return lines[0].strip(), lines[1].strip()
    return demo.ADMIN_EMAIL, "(siehe demo-login.txt)"


def _prepare_production(
    admin_email: str,
    admin_password: str,
    admin_name: str,
) -> int:
    from gimel import demo
    from gimel.db import SessionLocal
    from gimel.models import Role, User
    from gimel.security import hash_password
    from gimel.seed import init_db

    init_db(verbose=False)
    with SessionLocal() as db:
        if demo.is_demo(db):
            print(
                "FEHLER: Der Produktions-Datenordner enthält eine Demo-Datenbank. "
                "Bitte einen leeren Datenordner oder PostgreSQL (GIMEL_DATABASE_URL) nutzen.",
                file=sys.stderr,
            )
            return 2
        user_count = db.query(User).count()
        email = (admin_email or os.environ.get("GIMEL_ADMIN_EMAIL", "")).strip().lower()
        pw = (admin_password or os.environ.get("GIMEL_ADMIN_PASSWORD", "")).strip()
        name = (admin_name or os.environ.get("GIMEL_ADMIN_NAME", "Administrator")).strip()
        if user_count == 0 and email and pw:
            if len(pw) < 12:
                print(
                    "FEHLER: GIMEL_ADMIN_PASSWORD muss mindestens 12 Zeichen lang sein.",
                    file=sys.stderr,
                )
                return 2
            db.add(
                User(
                    email=email,
                    name=name,
                    role=Role.admin,
                    password_hash=hash_password(pw),
                    active=True,
                )
            )
            db.commit()
            print(f"[Production] Erstes Admin-Konto angelegt: {email}")
        elif user_count == 0:
            print(
                "[Production] Noch kein Benutzerkonto vorhanden. Legen Sie eines an mit:\n"
                "  GIMEL_ADMIN_EMAIL=admin@firma.de GIMEL_ADMIN_PASSWORD='<min-12-zeichen>' "
                "oder `gimel adduser admin@firma.de --role admin`",
                file=sys.stderr,
            )
    return 0


def run_single(
    mode: Literal["playground", "production"],
    *,
    host: str,
    port: int,
    base_dir: Path,
    reset: bool = False,
    no_browser: bool = False,
    admin_email: str = "",
    admin_password: str = "",
    admin_name: str = "Administrator",
) -> int:
    data_dir = _mode_data_dir(base_dir, mode)
    _configure_env_before_import(mode, data_dir, host)

    if mode == "playground":
        email, password = _prepare_playground(data_dir, reset=reset)
        print("=" * 64)
        print("  GIMEL PLAYGROUND (Sandkasten · Musterwerk GmbH)")
        print(f"  URL:      http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}/app")
        print(f"  Daten:    {data_dir}")
        print(f"  Login:    {email}")
        print(f"  Passwort: {password}")
        print("=" * 64)
    else:
        rc = _prepare_production(admin_email, admin_password, admin_name)
        if rc != 0:
            return rc
        print("=" * 64)
        print("  GIMEL PRODUCTION (Echtbetrieb)")
        print(f"  URL:      http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}/app")
        print(f"  Daten:    {os.environ.get('GIMEL_DATABASE_URL') or data_dir}")
        print("=" * 64)

    import uvicorn
    from gimel.app import create_app

    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}/app"
    if not no_browser:
        threading.Timer(1.3, lambda: webbrowser.open(url)).start()

    app = create_app()
    uvicorn.run(app, host=host, port=port, log_level="info", proxy_headers=(mode == "production"))
    return 0


def run_both(
    *,
    host: str,
    playground_port: int,
    production_port: int,
    base_dir: Path,
    reset: bool = False,
    no_browser: bool = False,
) -> int:
    """Launch isolated Playground and Production instances side by side."""
    if getattr(sys, "frozen", False):
        base_cmd = [sys.executable]
    else:
        base_cmd = [sys.executable, "-m", "gimel.launcher"]

    pg_cmd = [
        *base_cmd,
        "--mode", "playground",
        "--host", host,
        "--port", str(playground_port),
        "--data-dir", str(base_dir),
    ]
    if reset:
        pg_cmd.append("--reset")
    if no_browser:
        pg_cmd.append("--no-browser")

    prod_cmd = [
        *base_cmd,
        "--mode", "production",
        "--host", host,
        "--port", str(production_port),
        "--data-dir", str(base_dir),
        "--no-browser",
    ]

    print(f"Starte Gimel Playground (:{playground_port}) und Production (:{production_port}) …")
    procs = [subprocess.Popen(pg_cmd), subprocess.Popen(prod_cmd)]

    def _shutdown(*_args):
        for proc in procs:
            if proc.poll() is None:
                proc.terminate()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        while all(proc.poll() is None for proc in procs):
            for proc in procs:
                try:
                    proc.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    pass
    finally:
        _shutdown()
        for proc in procs:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
    return 0


def _pick_mode_interactive() -> Mode:
    if not sys.stdin or not sys.stdin.isatty():
        return "playground"
    print("\nGimel Launcher — Modus wählen:")
    print(f"  [1] Playground  (Demo-Werk Musterwerk GmbH, Port {PLAYGROUND_PORT})")
    print(f"  [2] Production  (Leerer Echtbetrieb, Port {PRODUCTION_PORT})")
    print(f"  [3] Beide       (Playground :{PLAYGROUND_PORT} + Production :{PRODUCTION_PORT})")
    try:
        choice = input("Auswahl [1/2/3, Standard 1]: ").strip()
    except EOFError:
        return "playground"
    if choice == "2":
        return "production"
    if choice == "3":
        return "both"
    return "playground"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="gimel-launcher",
        description="Gimel Dual-Mode Starter (Playground & Production)",
    )
    parser.add_argument(
        "--mode",
        choices=["playground", "production", "both"],
        default=os.environ.get("GIMEL_MODE") or None,
        help="Betriebsmodus: playground (Demo), production (Echtbetrieb), both (beide parallel)",
    )
    parser.add_argument("--host", default=os.environ.get("GIMEL_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("GIMEL_PORT", "0") or 0))
    parser.add_argument("--production-port", type=int, default=PRODUCTION_PORT)
    parser.add_argument("--data-dir", default=None, help="Basisordner für playground/ und production/")
    parser.add_argument("--reset", action="store_true", help="Playground-Datenbank vor Start zurücksetzen")
    parser.add_argument("--no-browser", action="store_true", default=os.environ.get("GIMEL_NO_BROWSER") == "1")
    parser.add_argument("--admin-email", default="")
    parser.add_argument("--admin-password", default="")
    parser.add_argument("--admin-name", default="Administrator")

    args = parser.parse_args(argv)
    mode: Mode = args.mode or _pick_mode_interactive()
    base_dir = Path(args.data_dir).expanduser() if args.data_dir else _default_base_dir()

    if mode == "both":
        pg_port = args.port or PLAYGROUND_PORT
        return run_both(
            host=args.host,
            playground_port=pg_port,
            production_port=args.production_port,
            base_dir=base_dir,
            reset=args.reset,
            no_browser=args.no_browser,
        )

    port = args.port or (PLAYGROUND_PORT if mode == "playground" else PRODUCTION_PORT)
    return run_single(
        mode,
        host=args.host,
        port=port,
        base_dir=base_dir,
        reset=args.reset,
        no_browser=args.no_browser,
        admin_email=args.admin_email,
        admin_password=args.admin_password,
        admin_name=args.admin_name,
    )


if __name__ == "__main__":
    raise SystemExit(main())
