#!/usr/bin/env python3
"""Gimel Browser GUI Installer — zero-dependency one-time setup UI.

Runs a local-only HTTP wizard on http://127.0.0.1:8099 using Python's standard
library only (works on Linux, macOS, and Windows before any packages are
installed):

  python3 scripts/install-ui.py
  python3 scripts/install-ui.py --port 8099 --no-browser
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IS_WIN = platform.system().lower() == "windows"


def _venv_bin(name: str) -> Path:
    if IS_WIN:
        return ROOT / ".venv" / "Scripts" / f"{name}.exe"
    return ROOT / ".venv" / "bin" / name


def _cmd_version(cmd: list[str]) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5, check=False)
        out = (r.stdout or r.stderr or "").strip().splitlines()
        return out[0].strip() if r.returncode == 0 and out else ""
    except Exception:  # noqa: BLE001
        return ""


def _lan_ips() -> list[str]:
    ips: list[str] = []
    for target in (("10.255.255.255", 1), ("192.0.2.1", 80)):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.settimeout(0.2)
                s.connect(target)
                ip = s.getsockname()[0]
                addr = ipaddress.ip_address(ip)
                if addr.is_private and not addr.is_loopback and ip not in ips:
                    ips.append(ip)
        except OSError:
            pass
    return ips


def system_check() -> dict:
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    node_ver = _cmd_version(["node", "--version"]) if shutil.which("node") else ""
    npm_ver = _cmd_version(["npm", "--version"]) if shutil.which("npm") else ""
    git_ver = _cmd_version(["git", "--version"]) if shutil.which("git") else ""
    docker_ver = _cmd_version(["docker", "--version"]) if shutil.which("docker") else ""
    docker_running = False
    if docker_ver:
        try:
            chk_d = subprocess.run(["docker", "info"], capture_output=True, timeout=2, check=False)
            docker_running = chk_d.returncode == 0
        except Exception:  # noqa: BLE001
            docker_running = False
    venv_ready = _venv_bin("python").is_file()
    web_built = (ROOT / "gimel" / "webapp" / "dist" / "index.html").is_file()
    lab_built = (ROOT / "agentlab" / "webapp" / "dist" / "index.html").is_file()
    piper_ready = False
    if venv_ready:
        chk = subprocess.run(
            [str(_venv_bin("python")), "-c", "import piper"],
            capture_output=True,
            check=False,
        )
        piper_ready = chk.returncode == 0
    return {
        "root": str(ROOT),
        "platform": f"{platform.system()} {platform.machine()}",
        "python": {"ok": sys.version_info >= (3, 11), "version": py_ver},
        "node": {"ok": bool(node_ver), "version": node_ver or "nicht gefunden"},
        "npm": {"ok": bool(npm_ver), "version": npm_ver or "nicht gefunden"},
        "git": {"ok": bool(git_ver), "version": git_ver or "nicht gefunden"},
        "docker": {"ok": bool(docker_ver), "version": docker_ver or "nicht installiert", "running": docker_running},
        "venv_ready": venv_ready,
        "web_built": web_built and lab_built,
        "piper_ready": piper_ready,
        "lan_ips": _lan_ips(),
    }


class InstallState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.running = False
        self.done = False
        self.ok = False
        self.step = ""
        self.logs: list[str] = []
        self.mode = "both"
        self.host = "0.0.0.0"
        self.launched_url = ""
        self.lan_url = ""

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "running": self.running,
                "done": self.done,
                "ok": self.ok,
                "step": self.step,
                "logs": self.logs[-400:],
                "mode": self.mode,
                "host": self.host,
                "launched_url": self.launched_url,
                "lan_url": self.lan_url,
            }

    def log(self, line: str) -> None:
        with self.lock:
            self.logs.append(line.rstrip())

    def set_step(self, step: str) -> None:
        with self.lock:
            self.step = step
            self.logs.append(f"\n==> {step}")


STATE = InstallState()


def _run_stream(cmd: list[str], cwd: Path, env: dict | None = None) -> int:
    STATE.log(f"$ {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        STATE.log(line)
    return proc.wait()


def _install_docker_auto() -> None:
    """Best-effort automatic Docker installation without crashing Gimel setup."""
    if shutil.which("docker"):
        STATE.log("Docker ist bereits installiert.")
        return
    if IS_WIN:
        deps_ps1 = ROOT / "packaging" / "windows" / "install-deps.ps1"
        if deps_ps1.is_file():
            rc = _run_stream(
                ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(deps_ps1), "-InstallDocker"],
                ROOT,
            )
            if rc != 0:
                STATE.log("Hinweis: Docker-Installation konnte nicht automatisch abgeschlossen werden.")
            return
        if shutil.which("winget"):
            _run_stream(
                ["winget", "install", "--id", "Docker.DockerDesktop", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"],
                ROOT,
            )
            return
        STATE.log("Hinweis: Bitte Docker Desktop manuell installieren (https://www.docker.com/products/docker-desktop/).")
        return

    if platform.system().lower() == "darwin":
        if shutil.which("brew"):
            _run_stream(["brew", "install", "--cask", "docker"], ROOT)
        else:
            STATE.log("Hinweis: Homebrew nicht gefunden. Bitte Docker Desktop manuell installieren.")
        return

    is_root = hasattr(os, "geteuid") and os.geteuid() == 0
    if is_root:
        _run_stream(["sh", "-c", "curl -fsSL https://get.docker.com | sh"], ROOT)
        return
    if shutil.which("sudo"):
        chk = subprocess.run(["sudo", "-n", "true"], capture_output=True, check=False)
        if chk.returncode == 0:
            _run_stream(["sudo", "sh", "-c", "curl -fsSL https://get.docker.com | sh"], ROOT)
            return
    STATE.log("Hinweis: Docker-Installation benötigt Root/sudo. Später ausführen: curl -fsSL https://get.docker.com | sudo sh")


def _install_worker(opts: dict) -> None:
    mode = opts.get("mode", "both")
    if mode not in ("playground", "production", "both"):
        mode = "both"
    host = "0.0.0.0" if opts.get("lan_access", True) else "127.0.0.1"
    build_web = bool(opts.get("build_web", True))
    admin_user = str(opts.get("admin_user") or "").strip().lower()
    admin_password = str(opts.get("admin_password") or "")
    reset_pg = bool(opts.get("reset_playground", False))
    install_docker = bool(opts.get("install_docker", True))
    install_piper = bool(opts.get("install_piper", False))
    piper_voice = str(opts.get("piper_voice") or "de_DE-thorsten-medium").strip()

    with STATE.lock:
        STATE.running = True
        STATE.done = False
        STATE.ok = False
        STATE.logs = []
        STATE.mode = mode
        STATE.host = host
        STATE.launched_url = ""
        STATE.lan_url = ""

    try:
        if install_docker and not shutil.which("docker"):
            STATE.set_step("0/4 Docker automatisch installieren (falls nicht vorhanden)")
            _install_docker_auto()

        # 1. Python virtual environment + editable install
        STATE.set_step("1/4 Python-Umgebung (.venv) & Gimel installieren")
        py_bin = _venv_bin("python")
        if not py_bin.is_file():
            rc = _run_stream([sys.executable, "-m", "venv", str(ROOT / ".venv")], ROOT)
            if rc != 0:
                raise RuntimeError("Erstellen der Python-Umgebung (.venv) fehlgeschlagen.")
        rc = _run_stream([str(py_bin), "-m", "pip", "install", "--upgrade", "pip", "--quiet"], ROOT)
        if rc != 0:
            raise RuntimeError("pip-Upgrade fehlgeschlagen.")
        rc = _run_stream([str(py_bin), "-m", "pip", "install", "-e", str(ROOT), "--quiet"], ROOT)
        if rc != 0:
            raise RuntimeError("Gimel-Installation fehlgeschlagen.")

        # 2. Frontend builds
        if build_web:
            STATE.set_step("2/4 Oberflächen bauen (ERP, Twin, Studio, Agent Lab)")
            npm = shutil.which("npm")
            if not npm:
                raise RuntimeError("npm nicht gefunden — bitte Node.js 20+ installieren oder Frontend-Build deaktivieren.")
            for rel in ("web", "agentlab/web"):
                wdir = ROOT / rel
                if not (wdir / "package.json").is_file():
                    continue
                if not (wdir / "node_modules").is_dir():
                    rc = _run_stream([npm, "ci", "--no-audit", "--no-fund"], wdir)
                    if rc != 0:
                        rc = _run_stream([npm, "install", "--no-audit", "--no-fund"], wdir)
                    if rc != 0:
                        raise RuntimeError(f"npm install in {rel} fehlgeschlagen.")
                rc = _run_stream([npm, "run", "build"], wdir)
                if rc != 0:
                    raise RuntimeError(f"Frontend-Build in {rel} fehlgeschlagen.")
        else:
            STATE.set_step("2/4 Frontend-Build übersprungen")

        # 3. Playground setup
        if mode in ("playground", "both"):
            STATE.set_step("3/4 Playground-Sandkasten (Musterwerk GmbH) einrichten")
            cmd = [str(py_bin), "-m", "gimel.cli", "setup", "--mode", "playground", "--host", host]
            if reset_pg:
                cmd.append("--reset")
            rc = _run_stream(cmd, ROOT)
            if rc != 0:
                raise RuntimeError("Playground-Einrichtung fehlgeschlagen.")
        else:
            STATE.set_step("3/4 Playground übersprungen")

        # 4. Production setup
        if mode in ("production", "both"):
            STATE.set_step("4/4 Production-Umgebung & Admin-Konto einrichten")
            cmd = [str(py_bin), "-m", "gimel.cli", "setup", "--mode", "production", "--host", host]
            if admin_user and admin_password:
                cmd += ["--admin-user", admin_user, "--admin-password", admin_password]
            rc = _run_stream(cmd, ROOT)
            if rc != 0:
                raise RuntimeError("Production-Einrichtung fehlgeschlagen.")
        else:
            STATE.set_step("4/4 Production übersprungen")

        if install_piper:
            STATE.set_step(f"Opt-In: Lokale Sprachausgabe mit Piper TTS (GPL-3.0 · {piper_voice}) installieren")
            rc = _run_stream(
                [str(py_bin), "-m", "gimel.cli", "piper-install", "--voice", piper_voice, "--accept-gpl"],
                ROOT,
            )
            if rc != 0:
                raise RuntimeError("Opt-In Installation von Piper TTS fehlgeschlagen.")

        STATE.log("\nInstallation erfolgreich abgeschlossen!")
        with STATE.lock:
            STATE.ok = True
    except Exception as exc:  # noqa: BLE001
        STATE.log(f"\nFEHLER: {exc}")
        with STATE.lock:
            STATE.ok = False
    finally:
        with STATE.lock:
            STATE.running = False
            STATE.done = True


def _launch_gimel(mode: str, host: str) -> dict:
    py_bin = _venv_bin("python")
    if not py_bin.is_file():
        return {"ok": False, "detail": ".venv nicht gefunden — bitte zuerst installieren."}
    port = 8040 if mode == "playground" else 8041
    cmd = [
        str(py_bin), "-m", "gimel.launcher",
        "--mode", mode,
        "--host", host,
        "--no-browser",
    ]
    kwargs: dict = {
        "cwd": str(ROOT),
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if IS_WIN:
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(cmd, **kwargs)
    local_url = f"http://127.0.0.1:{port}/app"
    lan_ips = _lan_ips()
    lan_url = f"http://{lan_ips[0]}:{port}/app" if (host == "0.0.0.0" and lan_ips) else ""
    with STATE.lock:
        STATE.launched_url = local_url
        STATE.lan_url = lan_url
    return {"ok": True, "url": local_url, "lan_url": lan_url}


HTML = r"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Gimel — UI Installer</title>
<style>
  :root {
    --bg: #111316; --panel: #16191d; --surface: #1d2127; --line: #2a303a;
    --text: #f1f3f6; --muted: #8e97a6; --accent: #0f8a73; --accent-hi: #2dd4b4;
    --ok: #22c55e; --warn: #f59e0b; --err: #ef4444;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.5;
    display: flex; justify-content: center; padding: 32px 16px;
  }
  .wrap { width: 100%; max-width: 760px; display: grid; gap: 18px; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    padding: 22px 24px;
  }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .mark {
    width: 40px; height: 40px; border-radius: 11px; display: grid; place-items: center;
    background: linear-gradient(145deg, #2dd4b4, #0a7b66); color: #fff;
    font-size: 22px; font-weight: 800;
  }
  h1 { margin: 0; font-size: 20px; }
  .sub { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
    border-radius: 999px; font-size: 12px; font-weight: 600;
    background: #123833; color: var(--accent-hi); border: 1px solid #1e564d;
  }
  .checks { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-top: 12px; }
  .chk {
    background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 12px; font-size: 12.5px;
  }
  .chk strong { display: block; font-size: 13px; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .err { color: var(--err); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
  label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 600; }
  input, select {
    background: var(--surface); border: 1px solid var(--line); color: var(--text);
    border-radius: 8px; padding: 9px 11px; font-size: 13.5px; outline: none;
  }
  input:focus, select:focus { border-color: var(--accent-hi); }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .check-row { flex-direction: row; align-items: center; gap: 8px; font-weight: 500; cursor: pointer; }
  .check-row input { width: auto; }
  button {
    border: 1px solid var(--line); background: var(--surface); color: var(--text);
    padding: 9px 16px; border-radius: 9px; font-size: 13.5px; font-weight: 600;
    cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: #13a488; color: #fff; }
  button.primary:hover { background: #129c82; }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  pre.log {
    margin: 12px 0 0; padding: 12px; border-radius: 10px; background: #0c0e11;
    border: 1px solid var(--line); font-size: 12px; color: #cbd5e1;
    max-height: 280px; overflow: auto; white-space: pre-wrap;
  }
  .banner {
    margin-top: 14px; padding: 12px 14px; border-radius: 10px;
    background: #102a24; border: 1px solid #1c584c; font-size: 13.5px;
  }
  a.btn {
    display: inline-block; text-decoration: none; background: var(--accent);
    color: #fff; padding: 8px 14px; border-radius: 8px; font-weight: 600; font-size: 13px;
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="head">
      <div class="brand">
        <div class="mark">&#1490;</div>
        <div>
          <h1>Gimel UI Installer</h1>
          <p class="sub">Einmalige Einrichtung für lokales Netzwerk · Playground &amp; Production</p>
        </div>
      </div>
      <span class="pill">Localnet-only</span>
    </div>
    <div id="checks" class="checks"><div class="chk">Systemprüfung läuft…</div></div>
  </div>

  <form id="form" class="card" style="display:grid;gap:14px;">
    <div class="grid">
      <label>Betriebsmodus
        <select id="mode">
          <option value="both">Beide (Playground :8040 + Production :8041)</option>
          <option value="production">Nur Production (Echtbetrieb :8041)</option>
          <option value="playground">Nur Playground (Demo Musterwerk :8040)</option>
        </select>
      </label>
      <label>Netzwerkzugriff
        <select id="lan">
          <option value="1">Lokales Netzwerk (LAN · 0.0.0.0, Localnet-Schutz)</option>
          <option value="0">Nur dieser Rechner (127.0.0.1)</option>
        </select>
      </label>
    </div>

    <div id="admin-fields" class="grid">
      <label>Erster Admin-Benutzername (Production)
        <input id="admin_user" placeholder="z. B. admin" value="admin" />
      </label>
      <label>Admin-Passwort (mind. 8 Zeichen)
        <div class="row">
          <input id="admin_password" type="text" placeholder="Leer = später im Browser setzen" style="flex:1;" />
          <button type="button" id="gen-pw">Vorschlag</button>
        </div>
      </label>
    </div>

    <div class="row" style="justify-content:space-between;align-items:flex-start;">
      <div style="display:grid;gap:8px;">
        <label class="check-row"><input id="build_web" type="checkbox" checked /> Frontend-Oberflächen bauen (/app, /studio, /twin, /lab)</label>
        <label class="check-row"><input id="install_docker" type="checkbox" checked /> Docker installieren (falls nicht vorhanden)</label>
        <label class="check-row"><input id="install_piper" type="checkbox" /> Optional (Opt-In): Lokale Sprachausgabe mit Piper TTS installieren (GPL-3.0 · de_DE-thorsten-medium)</label>
      </div>
      <button id="install-btn" class="primary" type="submit">Gimel jetzt einrichten</button>
    </div>
  </form>

  <div id="progress-card" class="card" style="display:none;">
    <div class="head">
      <strong id="step-title">Installation startet…</strong>
      <span id="status-badge" class="sub">Läuft…</span>
    </div>
    <pre id="log" class="log"></pre>
    <div id="done-box" class="banner" style="display:none;"></div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let pollTimer = null;

function genPw() {
  const w = ["Hobel","Fraese","Platte","Ring","Werkbank","Laser","Zange","Feder"];
  const p = () => w[Math.floor(Math.random() * w.length)];
  return `${p()}-${p()}-${10 + Math.floor(Math.random() * 89)}`;
}
$("gen-pw").onclick = () => { $("admin_password").value = genPw(); };
$("mode").onchange = () => {
  $("admin-fields").style.display = $("mode").value === "playground" ? "none" : "grid";
};

async function loadCheck() {
  const r = await fetch("/api/check");
  const d = await r.json();
  if (d.web_built) $("build_web").checked = false;
  const items = [
    ["Python", d.python.version, d.python.ok ? "ok" : "err"],
    ["Docker", d.docker.ok ? (d.docker.running ? `${d.docker.version} (aktiv)` : `${d.docker.version} (installiert)`) : "nicht installiert", d.docker.ok ? "ok" : "warn"],
    ["Node.js / npm", d.node.ok ? `${d.node.version} · npm ${d.npm.version}` : "nicht gefunden", d.node.ok ? "ok" : "warn"],
    ["Umgebung (.venv)", d.venv_ready ? "vorhanden" : "wird angelegt", "ok"],
    ["Oberflächen", d.web_built ? "bereits gebaut" : "werden gebaut", d.web_built ? "ok" : "warn"],
    ["Piper TTS", d.piper_ready ? "installiert (GPL-3.0)" : "Opt-In (optional)", d.piper_ready ? "ok" : "warn"],
    ["LAN-Adresse", d.lan_ips.length ? d.lan_ips[0] : "127.0.0.1", "ok"],
  ];
  $("checks").innerHTML = items.map(([k, v, cls]) =>
    `<div class="chk"><strong>${k}</strong><span class="${cls}">${v}</span></div>`
  ).join("");
}

async function poll() {
  const r = await fetch("/api/progress");
  const s = await r.json();
  $("step-title").textContent = s.step || "Einrichtung";
  const logEl = $("log");
  logEl.textContent = (s.logs || []).join("\n");
  logEl.scrollTop = logEl.scrollHeight;
  if (s.running) {
    $("status-badge").textContent = "Läuft…";
  } else if (s.done) {
    clearInterval(pollTimer);
    pollTimer = null;
    $("install-btn").disabled = false;
    $("status-badge").textContent = s.ok ? "Fertig" : "Fehlgeschlagen";
    $("status-badge").className = s.ok ? "ok" : "err";
    if (s.ok) {
      const box = $("done-box");
      box.style.display = "block";
      box.innerHTML = `
        <div class="row" style="justify-content:space-between;">
          <div><strong>Gimel ist eingerichtet!</strong><div class="sub">Jetzt direkt starten und im Browser öffnen.</div></div>
          <div class="row">
            <button type="button" class="primary" onclick="launchNow('production')">Production starten (:8041)</button>
            <button type="button" onclick="launchNow('playground')">Playground starten (:8040)</button>
          </div>
        </div>
        <div id="launch-links" style="margin-top:10px;"></div>
      `;
    }
  }
}

window.launchNow = async (m) => {
  const r = await fetch("/api/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: m, host: $("lan").value === "1" ? "0.0.0.0" : "127.0.0.1" }),
  });
  const d = await r.json();
  if (d.ok) {
    $("launch-links").innerHTML = `
      <a class="btn" href="${d.url}" target="_blank">Gimel öffnen (${d.url})</a>
      ${d.lan_url ? `<span class="sub" style="margin-left:10px;">Im LAN: <code>${d.lan_url}</code></span>` : ""}
    `;
  } else {
    $("launch-links").textContent = d.detail || "Start fehlgeschlagen.";
  }
};

$("form").onsubmit = async (e) => {
  e.preventDefault();
  $("install-btn").disabled = true;
  $("progress-card").style.display = "block";
  $("done-box").style.display = "none";
  const payload = {
    mode: $("mode").value,
    lan_access: $("lan").value === "1",
    admin_user: $("admin_user").value.trim(),
    admin_password: $("admin_password").value,
    build_web: $("build_web").checked,
    install_docker: $("install_docker").checked,
    install_piper: $("install_piper").checked,
    piper_voice: "de_DE-thorsten-medium",
  };
  await fetch("/api/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  poll();
  pollTimer = setInterval(poll, 700);
};

loadCheck();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    def _send_json(self, payload: dict, status: int = 200) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/", "/index.html"):
            body = HTML.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/api/check":
            self._send_json(system_check())
            return
        if self.path == "/api/progress":
            self._send_json(STATE.snapshot())
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(min(length, 65536)) if length > 0 else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            self._send_json({"ok": False, "detail": "Ungültige JSON-Anfrage."}, 400)
            return

        if self.path == "/api/install":
            if STATE.running:
                self._send_json({"ok": False, "detail": "Installation läuft bereits."}, 409)
                return
            t = threading.Thread(target=_install_worker, args=(data,), daemon=True)
            t.start()
            self._send_json({"ok": True})
            return

        if self.path == "/api/launch":
            mode = str(data.get("mode") or "production")
            host = str(data.get("host") or "0.0.0.0")
            self._send_json(_launch_gimel(mode, host))
            return

        self.send_error(HTTPStatus.NOT_FOUND)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Gimel Browser GUI Installer")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)

    port = args.port
    server: ThreadingHTTPServer | None = None
    for candidate in (port, port + 1, port + 2, 0):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            port = server.server_address[1]
            break
        except OSError:
            continue
    if server is None:
        print("Fehler: Konnte keinen lokalen Port binden.", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{port}/"
    print("=" * 64)
    print("  Gimel UI Installer")
    print(f"  Öffnen im Browser: {url}")
    print("  Beenden mit Strg+C")
    print("=" * 64)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nInstaller beendet.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
