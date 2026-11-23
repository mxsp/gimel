"""Native Desktop Application runner for Gimel (Windows / macOS / Linux).

Launches Gimel as a standalone desktop program with zero console window:
1. Starts the local Gimel server (or first-run Setup Wizard) in a background thread.
2. Opens a native desktop window via ``pywebview`` (Microsoft Edge WebView2 on
   Windows, WebKit on macOS, GTK/WebKit on Linux) with an instant dark splash screen.
3. Falls back cleanly to Microsoft Edge / Chrome standalone ``--app=`` window mode
   (frameless desktop window, no tabs or address bar) if WebView2 is unavailable.
4. Shuts down the embedded local server cleanly when the desktop window is closed.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Literal

from . import launcher
from .version import APP_VERSION

DesktopTarget = Literal["auto", "master", "playground", "production", "setup"]

SPLASH_HTML = """<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<title>Gimel</title>
<style>
  html, body {
    margin: 0; height: 100%; background: radial-gradient(circle at top, #132522 0%, #0f1216 58%);
    color: #f1f4f8; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    display: grid; place-items: center; user-select: none;
  }
  .box { text-align: center; display: grid; gap: 14px; justify-items: center; }
  .mark {
    width: 68px; height: 68px; border-radius: 18px; display: grid; place-items: center;
    background: linear-gradient(145deg, #2dd4b4, #0a7b66); color: #fff;
    font-size: 36px; font-weight: 800; box-shadow: 0 18px 44px rgb(15 138 115 / 0.35);
  }
  .title { font-size: 22px; font-weight: 700; letter-spacing: 0.01em; }
  .sub { font-size: 13px; color: #8f99a8; }
  .spin {
    width: 24px; height: 24px; border-radius: 50%;
    border: 2.5px solid #25303b; border-top-color: #2dd4b4;
    animation: sp 0.8s linear infinite; margin-top: 4px;
  }
  @keyframes sp { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="box">
    <div class="mark">&#1490;</div>
    <div class="title">Gimel __VERSION__</div>
    <div class="sub">Lokaler Server wird gestartet…</div>
    <div class="spin"></div>
  </div>
</body>
</html>
"""


def _ensure_windowed_stdio(base_dir: Path) -> None:
    """Redirect stdout/stderr to a log file when running without a console (console=False)."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        log_dir = (
            Path(os.environ.get("LOCALAPPDATA", str(base_dir))) / "Gimel" / "logs"
            if platform.system().lower() == "windows"
            else base_dir / "logs"
        )
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = (log_dir / "gimel-desktop.log").open("a", encoding="utf-8", buffering=1)
        if sys.stdout is None:
            sys.stdout = log_file  # type: ignore[assignment]
        if sys.stderr is None:
            sys.stderr = log_file  # type: ignore[assignment]
    except OSError:
        devnull = open(os.devnull, "w", encoding="utf-8")
        if sys.stdout is None:
            sys.stdout = devnull  # type: ignore[assignment]
        if sys.stderr is None:
            sys.stderr = devnull  # type: ignore[assignment]


def desktop_config_path(base_dir: Path) -> Path:
    return base_dir / "desktop.json"


def load_desktop_config(base_dir: Path) -> dict:
    p = desktop_config_path(base_dir)
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def save_desktop_config(base_dir: Path, *, default_mode: str, host: str = "0.0.0.0") -> None:
    base_dir.mkdir(parents=True, exist_ok=True)
    cfg = load_desktop_config(base_dir)
    cfg["default_mode"] = default_mode
    cfg["host"] = host
    try:
        desktop_config_path(base_dir).write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    except OSError:
        pass


def resolve_desktop_target(target: DesktopTarget, base_dir: Path) -> Literal["master", "playground", "production", "setup"]:
    if target in ("master", "playground", "production", "setup"):
        return target
    # Default desktop launch opens the simple Master Admin & Start Control Center
    return "master"


def _url_ready(url: str, timeout: float = 0.6) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return 200 <= resp.status < 500
    except Exception:  # noqa: BLE001
        return False


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


def _wait_until_ready(check_url: str, timeout_seconds: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if _url_ready(check_url):
            return True
        time.sleep(0.25)
    return False


def _find_app_browser() -> str | None:
    """Locate Microsoft Edge or Google Chrome / Chromium for native --app= fallback."""
    sys_name = platform.system().lower()
    candidates: list[str] = []
    if sys_name == "windows":
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        pfx86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local = os.environ.get("LOCALAPPDATA", "")
        candidates = [
            rf"{pfx86}\Microsoft\Edge\Application\msedge.exe",
            rf"{pf}\Microsoft\Edge\Application\msedge.exe",
            rf"{pf}\Google\Chrome\Application\chrome.exe",
            rf"{pfx86}\Google\Chrome\Application\chrome.exe",
            rf"{local}\Google\Chrome\Application\chrome.exe",
            "msedge",
            "chrome",
        ]
    elif sys_name == "darwin":
        candidates = [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ]
    else:
        candidates = ["microsoft-edge", "google-chrome", "chromium", "chromium-browser", "brave-browser"]

    for item in candidates:
        if os.path.isabs(item) and os.path.isfile(item):
            return item
        found = shutil.which(item)
        if found:
            return found
    return None


def _start_embedded_uvicorn(
    mode: Literal["playground", "production"],
    *,
    host: str,
    port: int,
    base_dir: Path,
    reset: bool = False,
) -> tuple[object, threading.Thread]:
    """Start Gimel FastAPI via uvicorn.Server in a background thread."""
    data_dir = launcher._mode_data_dir(base_dir, mode)
    launcher._configure_env_before_import(mode, data_dir, host)
    if mode == "playground":
        launcher._prepare_playground(data_dir, reset=reset)
    else:
        launcher._prepare_production("", "", "")

    import uvicorn
    from gimel.app import create_app

    app = create_app()
    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level="warning",
        proxy_headers=(mode == "production"),
    )
    server = uvicorn.Server(config)
    # Signal handlers cannot be installed from a background thread.
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]
    thread = threading.Thread(target=server.run, name="gimel-desktop-server", daemon=True)
    thread.start()
    return server, thread


def run_desktop(
    *,
    target: DesktopTarget = "auto",
    host: str | None = None,
    port: int = 0,
    base_dir: Path | None = None,
    reset: bool = False,
) -> int:
    """Launch Gimel as a native desktop application window."""
    root_dir = base_dir or launcher._default_base_dir()
    _ensure_windowed_stdio(root_dir)

    cfg = load_desktop_config(root_dir)
    effective_host = host or str(cfg.get("host") or launcher.DEFAULT_HOST)
    resolved = resolve_desktop_target(target, root_dir)

    shutdown_cb = lambda: None  # noqa: E731
    if resolved == "master":
        from . import master_admin

        ctrl = master_admin.MasterAdminController(root_dir, host=effective_host)
        actual_port = ctrl.start_http(port=port)
        target_url = f"http://127.0.0.1:{actual_port}/"
        health_url = target_url
        window_title = f"Gimel v{APP_VERSION} — Master Admin"
        shutdown_cb = ctrl.shutdown_all
    elif resolved == "setup":
        from . import setup_ui

        srv, actual_port = setup_ui.start_setup_ui_background(port=port or 8099, base_dir=root_dir)
        target_url = f"http://127.0.0.1:{actual_port}/"
        health_url = f"http://127.0.0.1:{actual_port}/api/info"
        window_title = f"Gimel v{APP_VERSION} — Einrichtung"
        shutdown_cb = srv.shutdown
    else:
        actual_port = port or (launcher.PLAYGROUND_PORT if resolved == "playground" else launcher.PRODUCTION_PORT)
        target_url = f"http://127.0.0.1:{actual_port}/app/"
        health_url = f"http://127.0.0.1:{actual_port}/api/health"
        label = "Playground (Demo)" if resolved == "playground" else "Production"
        window_title = f"Gimel v{APP_VERSION} — {label}"

        if not _port_open(actual_port):
            server, _thread = _start_embedded_uvicorn(
                resolved,
                host=effective_host,
                port=actual_port,
                base_dir=root_dir,
                reset=reset,
            )

            def _stop_uvicorn() -> None:
                try:
                    setattr(server, "should_exit", True)
                except Exception:  # noqa: BLE001
                    pass

            shutdown_cb = _stop_uvicorn

    # Tier 1: Native OS window via pywebview (Windows WebView2 / macOS WebKit / Linux GTK)
    try:
        import webview  # type: ignore[import-not-found]

        splash = SPLASH_HTML.replace("__VERSION__", f"v{APP_VERSION}")
        win = webview.create_window(
            window_title,
            html=splash,
            width=1440,
            height=920,
            min_size=(1024, 680),
            background_color="#0f1216",
        )

        def _navigate_when_ready() -> None:
            _wait_until_ready(health_url, timeout_seconds=35.0)
            try:
                win.load_url(target_url)
            except Exception:  # noqa: BLE001
                pass

        try:
            webview.start(_navigate_when_ready)
        finally:
            shutdown_cb()
        return 0
    except Exception:  # noqa: BLE001
        pass

    # Tier 2: Standalone Microsoft Edge / Chrome --app= desktop window fallback
    _wait_until_ready(health_url, timeout_seconds=35.0)
    browser = _find_app_browser()
    if browser:
        profile_dir = root_dir / "desktop-profile"
        profile_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            browser,
            f"--app={target_url}",
            "--window-size=1440,920",
            f"--user-data-dir={profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        try:
            proc = subprocess.Popen(cmd)
            proc.wait()
        finally:
            shutdown_cb()
        return 0

    # Tier 3: System default browser fallback
    webbrowser.open(target_url)
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        shutdown_cb()
    return 0
