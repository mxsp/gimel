"""Embedded browser Setup UI — works inside frozen Windows/Linux binaries and CLI.

Launched via ``gimel.exe --mode setup-ui`` (for example right after the Windows
Inno Setup wizard finishes) or ``gimel setup-ui``. Configures Playground and/or
Production, creates the first Admin username + password, shows LAN URLs, and
starts Gimel in one click.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import launcher
from .localnet import local_lan_ips
from .version import APP_VERSION

HTML = r"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Gimel — Einrichtungs-Assistent</title>
<style>
  :root {
    --bg: #0f1216; --panel: #161a20; --surface: #1d222a; --line: #2b323d;
    --text: #f1f4f8; --muted: #8f99a8; --accent: #0f8a73; --accent-hi: #2dd4b4;
    --ok: #22c55e; --err: #ef4444;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: radial-gradient(circle at top, #132522 0%, var(--bg) 52%);
    color: var(--text); min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
  }
  .card {
    width: 100%; max-width: 560px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 16px; padding: 26px 28px; box-shadow: 0 24px 64px rgb(0 0 0 / 0.45);
  }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .mark {
    width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center;
    background: linear-gradient(145deg, #2dd4b4, #0a7b66); color: #fff; font-size: 22px; font-weight: 800;
  }
  h1 { margin: 0; font-size: 20px; }
  .sub { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
  .pill {
    padding: 4px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 700;
    background: #123833; color: var(--accent-hi); border: 1px solid #1e564d;
  }
  .grid { display: grid; gap: 14px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 520px) { .two { grid-template-columns: 1fr; } }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; }
  input, select {
    background: var(--surface); border: 1px solid var(--line); color: var(--text);
    border-radius: 9px; padding: 10px 12px; font-size: 13.5px; outline: none;
  }
  input:focus, select:focus { border-color: var(--accent-hi); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button {
    border: 1px solid var(--line); background: var(--surface); color: var(--text);
    padding: 10px 14px; border-radius: 9px; font-size: 13.5px; font-weight: 600; cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: #13a488; color: #fff; width: 100%; padding: 12px; font-size: 14.5px; }
  button.primary:hover { background: #129c82; }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  .info {
    background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 12px; font-size: 12.5px; color: var(--muted);
  }
  .info code { color: var(--accent-hi); }
  .err { color: var(--err); font-size: 13px; }
  .done {
    background: #102a24; border: 1px solid #1d5d50; border-radius: 12px; padding: 16px;
    display: grid; gap: 10px;
  }
  a.btn {
    display: inline-block; text-align: center; text-decoration: none; background: var(--accent);
    color: #fff; padding: 11px 16px; border-radius: 9px; font-weight: 700; font-size: 14px;
  }
</style>
</head>
<body>
<div class="card">
  <div class="head">
    <div class="brand">
      <div class="mark">&#1490;</div>
      <div>
        <h1>Willkommen bei Gimel</h1>
        <p class="sub" id="subtitle">Einmalige Einrichtung · Lokal &amp; sicher im Heim-/Firmennetz</p>
      </div>
    </div>
    <span class="pill" id="ver-pill">v__VERSION__</span>
  </div>

  <form id="form" class="grid">
    <div class="info" id="lan-box">Lokales Netzwerk wird erkannt…</div>

    <div class="two">
      <label>Startmodus
        <select id="mode">
          <option value="production">Production (Echtbetrieb · :8041)</option>
          <option value="playground">Playground (Demo Musterwerk · :8040)</option>
          <option value="both">Beide parallel (:8040 &amp; :8041)</option>
        </select>
      </label>
      <label>Netzwerkzugriff
        <select id="lan">
          <option value="1">Lokales Netzwerk (LAN · empfohlen)</option>
          <option value="0">Nur dieser Computer (127.0.0.1)</option>
        </select>
      </label>
    </div>

    <div id="admin-box" class="grid">
      <label>Admin-Benutzername (Production)
        <input id="admin_user" value="admin" placeholder="z. B. admin" />
      </label>
      <label>Admin-Passwort (mind. 8 Zeichen)
        <div class="row">
          <input id="admin_password" type="text" placeholder="Passwort eingeben oder vorschlagen" style="flex:1;" />
          <button type="button" id="gen">Vorschlag</button>
        </div>
      </label>
    </div>

    <div id="err" class="err" style="display:none;"></div>
    <button id="go" class="primary" type="submit">Einrichten &amp; Gimel starten</button>
  </form>

  <div id="done" class="done" style="display:none;margin-top:12px;"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
function genPw() {
  const w = ["Hobel","Fraese","Platte","Ring","Werkbank","Laser","Zange","Feder"];
  const p = () => w[Math.floor(Math.random() * w.length)];
  return `${p()}-${p()}-${10 + Math.floor(Math.random() * 89)}`;
}
$("gen").onclick = () => { $("admin_password").value = genPw(); };
$("mode").onchange = () => {
  $("admin-box").style.display = $("mode").value === "playground" ? "none" : "grid";
};

fetch("/api/info").then(r => r.json()).then(d => {
  $("ver-pill").textContent = `v${d.version}`;
  $("lan-box").innerHTML = d.lan_ips.length
    ? `Erkannte LAN-Adresse: <code>${d.lan_ips[0]}</code> · Nur lokales Netzwerk (Localnet-Schutz aktiv)`
    : `Lokal auf diesem Computer (<code>127.0.0.1</code>) · Localnet-Schutz aktiv`;
});

$("form").onsubmit = async (e) => {
  e.preventDefault();
  $("err").style.display = "none";
  $("go").disabled = true;
  $("go").textContent = "Richte ein & starte Gimel…";
  try {
    const r = await fetch("/api/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: $("mode").value,
        lan_access: $("lan").value === "1",
        admin_user: $("admin_user").value.trim(),
        admin_password: $("admin_password").value,
      }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      $("err").textContent = d.detail || "Einrichtung fehlgeschlagen.";
      $("err").style.display = "block";
      $("go").disabled = false;
      $("go").textContent = "Einrichten & Gimel starten";
      return;
    }
    $("form").style.display = "none";
    $("done").style.display = "grid";
    $("done").innerHTML = `
      <strong>Gimel läuft!</strong>
      <div class="sub">${d.detail || ""}</div>
      <a class="btn" href="${d.url}">Gimel jetzt öffnen (${d.url})</a>
      ${d.lan_url ? `<div class="sub">Auf anderen Geräten im LAN: <code>${d.lan_url}</code></div>` : ""}
    `;
    setTimeout(() => { window.location.href = d.url; }, 2200);
  } catch (err) {
    $("err").textContent = String(err);
    $("err").style.display = "block";
    $("go").disabled = false;
    $("go").textContent = "Einrichten & Gimel starten";
  }
};
</script>
</body>
</html>
"""


def run_setup_ui(*, port: int = 8099, base_dir: Path | None = None, no_browser: bool = False) -> int:
    root_dir = base_dir or launcher._default_base_dir()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:  # noqa: A002
            return

        def _json(self, payload: dict, status: int = 200) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            if self.path in ("/", "/index.html"):
                body = HTML.replace("__VERSION__", APP_VERSION).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == "/api/info":
                self._json({"version": APP_VERSION, "lan_ips": local_lan_ips(), "data_dir": str(root_dir)})
                return
            self.send_error(HTTPStatus.NOT_FOUND)

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/api/finish":
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(min(length, 32768)).decode("utf-8") or "{}")
            mode = str(data.get("mode") or "production")
            if mode not in ("playground", "production", "both"):
                mode = "production"
            host = "0.0.0.0" if data.get("lan_access", True) else "127.0.0.1"
            admin_user = str(data.get("admin_user") or "").strip().lower()
            admin_password = str(data.get("admin_password") or "").strip()

            if mode in ("production", "both") and admin_password and len(admin_password) < 8:
                self._json({"ok": False, "detail": "Das Admin-Passwort braucht mindestens 8 Zeichen."}, 400)
                return

            if getattr(sys, "frozen", False):
                cmd = [sys.executable]
            else:
                cmd = [sys.executable, "-m", "gimel.launcher"]

            cmd += ["--mode", mode, "--host", host, "--data-dir", str(root_dir), "--no-browser"]
            if mode in ("production", "both") and admin_user and admin_password:
                cmd += ["--admin-user", admin_user, "--admin-password", admin_password]

            kwargs: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
            if os.name == "nt":
                kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
            else:
                kwargs["start_new_session"] = True
            subprocess.Popen(cmd, **kwargs)

            open_port = launcher.PLAYGROUND_PORT if mode == "playground" else launcher.PRODUCTION_PORT
            local_url = f"http://127.0.0.1:{open_port}/app"
            lan_ips = local_lan_ips()
            lan_url = f"http://{lan_ips[0]}:{open_port}/app" if (host == "0.0.0.0" and lan_ips) else ""
            detail = f"Modus: {mode} · Weiterleitung in 2 Sekunden…"
            self._json({"ok": True, "url": local_url, "lan_url": lan_url, "detail": detail})
            threading.Timer(4.0, server.shutdown).start()

    server: ThreadingHTTPServer | None = None
    for candidate in (port, port + 1, port + 2, 0):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            port = server.server_address[1]
            break
        except OSError:
            continue
    if server is None:
        return 1

    url = f"http://127.0.0.1:{port}/"
    print(f"Gimel Einrichtungs-Assistent: {url}")
    if not no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
