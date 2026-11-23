"""Localhost-only Master Admin Console for the Gimel Desktop Program.

Runs exclusively on ``127.0.0.1`` with a per-launch random ``X-Master-Token`` so
only the local desktop user on the host machine can access it. Provides a simple,
clean UI to:
- Start, stop, and open Gimel Production (:8041) and Playground (:8040)
- Manage all local Admin / Staff / Worker accounts directly (create, reset password,
  change role, unlock, enable/disable, revoke all sessions) even when locked out
- View local LAN URLs and Python / Docker runtime status
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Literal

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from . import launcher, setup_ui
from .localnet import local_lan_ips
from .models import AuditLog, AuthSession, Base, User
from .security import hash_password
from .version import APP_VERSION

EnvName = Literal["production", "playground"]
VALID_ROLES = ("admin", "staff", "worker")


def _db_path(base_dir: Path, env: EnvName) -> Path:
    d = base_dir / env
    d.mkdir(parents=True, exist_ok=True)
    return d / "gimel.db"


def _open_session(base_dir: Path, env: EnvName):
    db_file = _db_path(base_dir, env)
    engine = create_engine(f"sqlite:///{db_file}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    return engine, Session


def _is_locked(user: User) -> bool:
    lu = user.locked_until
    if lu is None:
        return False
    now = datetime.now(timezone.utc)
    if lu.tzinfo is None:
        return lu > now.replace(tzinfo=None)
    return lu > now


def _serialize_user(user: User, active_sessions: int = 0) -> dict:
    return {
        "id": user.id,
        "username": user.email,
        "name": user.name or user.email,
        "role": user.role,
        "active": bool(user.active),
        "locked": _is_locked(user),
        "active_sessions": active_sessions,
        "last_login": user.last_login.isoformat() if user.last_login else None,
    }


def list_accounts(base_dir: Path, env: EnvName) -> list[dict]:
    engine, Session = _open_session(base_dir, env)
    try:
        with Session() as db:
            users = db.query(User).order_by(User.id.asc()).all()
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            out: list[dict] = []
            for u in users:
                sess_cnt = (
                    db.query(AuthSession)
                    .filter(
                        AuthSession.user_id == u.id,
                        AuthSession.revoked_at.is_(None),
                        AuthSession.expires_at > now,
                    )
                    .count()
                )
                out.append(_serialize_user(u, sess_cnt))
            return out
    finally:
        engine.dispose()


def create_account(
    base_dir: Path,
    env: EnvName,
    *,
    username: str,
    password: str,
    role: str = "admin",
    name: str = "",
) -> dict:
    uname = username.strip().lower()
    if not uname or len(uname) < 2 or " " in uname:
        raise ValueError("Benutzername muss mindestens 2 Zeichen lang sein (ohne Leerzeichen).")
    if len(password) < 8:
        raise ValueError("Passwort muss mindestens 8 Zeichen lang sein.")
    if role not in VALID_ROLES:
        raise ValueError(f"Ungültige Rolle: {role}")

    engine, Session = _open_session(base_dir, env)
    try:
        with Session() as db:
            if db.query(User).filter(User.email == uname).first():
                raise ValueError(f"Konto '{uname}' existiert bereits.")
            u = User(
                email=uname,
                password_hash=hash_password(password),
                name=(name or uname).strip(),
                role=role,
                active=True,
                email_verified=True,
            )
            db.add(u)
            db.flush()
            db.add(
                AuditLog(
                    actor="master-admin-desktop",
                    action="master_account_create",
                    entity="user",
                    entity_id=str(u.id),
                    detail={"username": uname, "role": role, "env": env},
                )
            )
            db.commit()
            return _serialize_user(u, 0)
    finally:
        engine.dispose()


def upsert_account(
    base_dir: Path,
    env: EnvName,
    *,
    username: str,
    password: str,
    role: str = "admin",
    name: str = "",
) -> dict:
    uname = username.strip().lower()
    if not uname or len(uname) < 2 or " " in uname:
        raise ValueError("Benutzername muss mindestens 2 Zeichen lang sein (ohne Leerzeichen).")
    if len(password) < 8:
        raise ValueError("Passwort muss mindestens 8 Zeichen lang sein.")
    if role not in VALID_ROLES:
        raise ValueError(f"Ungültige Rolle: {role}")

    engine, Session = _open_session(base_dir, env)
    try:
        with Session() as db:
            u = db.query(User).filter(User.email == uname).first()
            if u is not None:
                u.password_hash = hash_password(password)
                u.role = role
                u.active = True
                u.email_verified = True
                u.failed_login_count = 0
                u.locked_until = None
                u.mfa_failed_count = 0
                u.mfa_locked_until = None
                if name.strip():
                    u.name = name.strip()
                db.add(
                    AuditLog(
                        actor="master-admin-desktop",
                        action="master_account_upsert",
                        entity="user",
                        entity_id=str(u.id),
                        detail={"username": uname, "role": role, "env": env, "updated": True},
                    )
                )
                db.commit()
                now = datetime.now(timezone.utc).replace(tzinfo=None)
                sess_cnt = (
                    db.query(AuthSession)
                    .filter(
                        AuthSession.user_id == u.id,
                        AuthSession.revoked_at.is_(None),
                        AuthSession.expires_at > now,
                    )
                    .count()
                )
                return _serialize_user(u, sess_cnt)

            u = User(
                email=uname,
                password_hash=hash_password(password),
                name=(name or uname).strip(),
                role=role,
                active=True,
                email_verified=True,
            )
            db.add(u)
            db.flush()
            db.add(
                AuditLog(
                    actor="master-admin-desktop",
                    action="master_account_upsert",
                    entity="user",
                    entity_id=str(u.id),
                    detail={"username": uname, "role": role, "env": env, "created": True},
                )
            )
            db.commit()
            return _serialize_user(u, 0)
    finally:
        engine.dispose()


def update_account(
    base_dir: Path,
    env: EnvName,
    user_id: int,
    *,
    password: str | None = None,
    role: str | None = None,
    active: bool | None = None,
    unlock: bool = False,
    logout_all: bool = False,
) -> dict:
    engine, Session = _open_session(base_dir, env)
    try:
        with Session() as db:
            u = db.query(User).filter(User.id == user_id).first()
            if not u:
                raise KeyError("Konto nicht gefunden.")

            active_admins = (
                db.query(User).filter(User.role == "admin", User.active.is_(True)).count()
            )
            is_last_admin = u.role == "admin" and u.active and active_admins <= 1

            changes: dict = {"env": env}
            if role is not None:
                if role not in VALID_ROLES:
                    raise ValueError(f"Ungültige Rolle: {role}")
                if is_last_admin and role != "admin":
                    raise ValueError("Das letzte aktive Admin-Konto kann nicht herabgestuft werden.")
                u.role = role
                changes["role"] = role

            if active is not None:
                if is_last_admin and not active:
                    raise ValueError("Das letzte aktive Admin-Konto kann nicht deaktiviert werden.")
                u.active = bool(active)
                changes["active"] = bool(active)

            if password is not None:
                if len(password) < 8:
                    raise ValueError("Passwort muss mindestens 8 Zeichen lang sein.")
                u.password_hash = hash_password(password)
                u.failed_login_count = 0
                u.locked_until = None
                changes["password_reset"] = True

            if unlock:
                u.failed_login_count = 0
                u.locked_until = None
                u.mfa_failed_count = 0
                u.mfa_locked_until = None
                changes["unlocked"] = True

            if logout_all or (active is False):
                now = datetime.now(timezone.utc).replace(tzinfo=None)
                revoked = (
                    db.query(AuthSession)
                    .filter(AuthSession.user_id == u.id, AuthSession.revoked_at.is_(None))
                    .update({AuthSession.revoked_at: now}, synchronize_session=False)
                )
                changes["sessions_revoked"] = int(revoked or 0)

            db.add(
                AuditLog(
                    actor="master-admin-desktop",
                    action="master_account_update",
                    entity="user",
                    entity_id=str(u.id),
                    detail=changes,
                )
            )
            db.commit()
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            sess_cnt = (
                db.query(AuthSession)
                .filter(
                    AuthSession.user_id == u.id,
                    AuthSession.revoked_at.is_(None),
                    AuthSession.expires_at > now,
                )
                .count()
            )
            return _serialize_user(u, sess_cnt)
    finally:
        engine.dispose()


def _port_alive(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def _wait_health(port: int, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/api/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=0.6) as resp:
                if 200 <= resp.status < 500:
                    return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.25)
    return False


HTML = r"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Gimel — Master Admin</title>
<style>
  :root {
    --bg: #0f1216; --panel: #161b22; --surface: #1d242d; --line: #2a333f;
    --text: #f1f4f8; --muted: #8f9aa8; --accent: #0f8a73; --accent-hi: #2dd4b4;
    --ok: #22c55e; --warn: #f59e0b; --err: #ef4444;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: var(--bg); color: var(--text); min-height: 100vh;
  }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px 20px 36px; display: grid; gap: 18px; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .mark {
    width: 40px; height: 40px; border-radius: 11px; display: grid; place-items: center;
    background: linear-gradient(145deg, #2dd4b4, #0a7b66); color: #fff; font-size: 21px; font-weight: 800;
  }
  h1 { margin: 0; font-size: 19px; }
  .sub { color: var(--muted); font-size: 12.5px; margin: 2px 0 0; }
  .pills { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .pill {
    padding: 4px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
    background: var(--surface); border: 1px solid var(--line); color: var(--muted);
  }
  .pill.ok { background: #0f2d24; border-color: #1f5c4a; color: #5eead4; }
  .pill.warn { background: #2d2210; border-color: #6b4e16; color: #fbbf24; }
  .tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
  .tab {
    background: transparent; border: 1px solid transparent; color: var(--muted);
    padding: 8px 14px; border-radius: 8px; font-size: 13.5px; font-weight: 600; cursor: pointer;
  }
  .tab.active { background: var(--surface); border-color: var(--line); color: var(--text); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    padding: 18px 20px; display: grid; gap: 12px;
  }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .card h2 { margin: 0; font-size: 15.5px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  button, select, input {
    font: inherit; font-size: 13px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--surface); color: var(--text); padding: 8px 12px;
  }
  button { cursor: pointer; font-weight: 600; }
  button:hover { border-color: #415064; }
  button.primary { background: var(--accent); border-color: #13a488; color: #fff; }
  button.primary:hover { background: #129c82; }
  button.danger { color: #fca5a5; border-color: #5b252a; background: #261417; }
  button.sm { padding: 5px 9px; font-size: 12px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  input:focus, select:focus { outline: none; border-color: var(--accent-hi); }
  .seg { display: inline-flex; background: var(--surface); border: 1px solid var(--line); border-radius: 9px; padding: 3px; }
  .seg button { border: none; background: transparent; color: var(--muted); padding: 6px 12px; border-radius: 6px; }
  .seg button.active { background: var(--accent); color: #fff; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-size: 12px; font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .toast {
    padding: 10px 14px; border-radius: 9px; font-size: 13px; display: none;
    background: #102a24; border: 1px solid #1d5d50; color: #a7f3d0;
  }
  .toast.err { background: #2d1417; border-color: #6f222a; color: #fecaca; }
  .add-form { display: grid; grid-template-columns: 1.1fr 1.2fr auto auto auto; gap: 8px; }
  @media (max-width: 720px) { .add-form { grid-template-columns: 1fr; } }
  .footer-bar {
    display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;
    padding: 12px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; font-size: 12.5px;
  }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="brand">
      <div class="mark">&#1490;</div>
      <div>
        <h1>Gimel Master Admin</h1>
        <p class="sub">Lokale Steuerung &amp; Admin-Kontenverwaltung · Nur dieser PC (127.0.0.1)</p>
      </div>
    </div>
    <div class="pills">
      <span class="pill ok" id="ver-pill">v__VERSION__</span>
      <span class="pill" id="lan-pill">Localnet</span>
    </div>
  </div>

  <div class="tabs">
    <button type="button" class="tab active" data-tab="start">Start &amp; Betrieb</button>
    <button type="button" class="tab" data-tab="accounts">Konten (Master Admin)</button>
  </div>

  <div id="toast" class="toast"></div>

  <!-- TAB 1: START & CONTROL -->
  <div id="panel-start" class="grid2">
    <div class="card">
      <div class="card-head">
        <h2>Production (Echtbetrieb)</h2>
        <span class="pill" id="st-production">Prüfe…</span>
      </div>
      <p class="sub">Saubere Produktivdatenbank · Port 8041 · <span class="mono" id="url-production">http://127.0.0.1:8041/app/</span></p>
      <div class="row">
        <button type="button" class="primary" onclick="openApp('production', '/app/')">ERP öffnen</button>
        <button type="button" onclick="openApp('production', '/studio/')">3D Twin</button>
        <button type="button" onclick="openApp('production', '/lab/')">Agent Lab</button>
        <button type="button" class="danger sm" id="stop-production" onclick="stopServer('production')" style="margin-left:auto;">Stoppen</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Playground (Demo-Werk)</h2>
        <span class="pill" id="st-playground">Prüfe…</span>
      </div>
      <p class="sub">Musterwerk GmbH Sandkasten · Port 8040 · <span class="mono" id="url-playground">http://127.0.0.1:8040/app/</span></p>
      <div class="row">
        <button type="button" class="primary" onclick="openApp('playground', '/app/')">Demo öffnen</button>
        <button type="button" onclick="openApp('playground', '/studio/')">3D Twin</button>
        <button type="button" onclick="openApp('playground', '/lab/')">Agent Lab</button>
        <button type="button" class="danger sm" id="stop-playground" onclick="stopServer('playground')" style="margin-left:auto;">Stoppen</button>
      </div>
    </div>
  </div>

  <!-- TAB 2: MASTER ADMIN ACCOUNTS -->
  <div id="panel-accounts" class="card hidden">
    <div class="card-head">
      <div>
        <h2>Admin- &amp; Benutzerkonten</h2>
        <p class="sub">Direkter Master-Zugriff auf die lokale Datenbank — funktioniert auch bei vergessenem Passwort oder Sperre.</p>
      </div>
      <div class="seg">
        <button type="button" id="env-production" class="active" onclick="setEnv('production')">Production</button>
        <button type="button" id="env-playground" onclick="setEnv('playground')">Playground</button>
      </div>
    </div>

    <form class="add-form" id="add-form">
      <input id="new-user" placeholder="Benutzername (z. B. admin)" required autocomplete="off" />
      <input id="new-pass" type="text" placeholder="Passwort (mind. 8 Zeichen)" required autocomplete="off" />
      <button type="button" onclick="suggestPass()">Vorschlag</button>
      <select id="new-role">
        <option value="admin">Admin</option>
        <option value="staff">Büro (Staff)</option>
        <option value="worker">Halle (Worker)</option>
      </select>
      <button type="submit" class="primary">+ Konto anlegen</button>
    </form>

    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Benutzername</th>
            <th>Rolle</th>
            <th>Status</th>
            <th>Aktionen</th>
          </tr>
        </thead>
        <tbody id="acc-body">
          <tr><td colspan="4" class="sub">Lade Konten…</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="footer-bar">
    <div class="pills" id="deps-pills">
      <span class="pill">System wird geprüft…</span>
    </div>
    <div class="row">
      <button type="button" class="sm hidden" id="btn-deps" onclick="installDeps()">Python / Docker installieren</button>
      <button type="button" class="sm" onclick="refreshAll()">Aktualisieren</button>
    </div>
  </div>
</div>

<script>
const TOKEN = "__TOKEN__";
let currentEnv = "production";

function toast(msg, isErr = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast" + (isErr ? " err" : "");
  el.style.display = "block";
  clearTimeout(window._t);
  window._t = setTimeout(() => { el.style.display = "none"; }, 5000);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Master-Token": TOKEN, ...(opts.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || `Fehler (${r.status})`);
  return d;
}

document.querySelectorAll(".tab").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const t = btn.dataset.tab;
    document.getElementById("panel-start").classList.toggle("hidden", t !== "start");
    document.getElementById("panel-accounts").classList.toggle("hidden", t !== "accounts");
    if (t === "accounts") loadAccounts();
  };
});

function genPw() {
  const w = ["Hobel","Fraese","Platte","Ring","Werkbank","Laser","Zange","Feder"];
  const p = () => w[Math.floor(Math.random() * w.length)];
  return `${p()}-${p()}-${10 + Math.floor(Math.random() * 89)}`;
}
function suggestPass() { document.getElementById("new-pass").value = genPw(); }

async function loadStatus() {
  const d = await api("/api/master/status");
  document.getElementById("ver-pill").textContent = `v${d.version}`;
  document.getElementById("lan-pill").textContent = d.lan_ips.length ? `LAN: ${d.lan_ips[0]}` : "Lokal (127.0.0.1)";

  for (const mode of ["production", "playground"]) {
    const info = d.servers[mode];
    const badge = document.getElementById(`st-${mode}`);
    badge.textContent = info.running ? "Läuft" : "Gestoppt";
    badge.className = "pill " + (info.running ? "ok" : "");
    document.getElementById(`stop-${mode}`).disabled = !info.running;
    document.getElementById(`url-${mode}`).textContent = d.lan_ips.length
      ? `http://${d.lan_ips[0]}:${info.port}/app/`
      : `http://127.0.0.1:${info.port}/app/`;
  }

  const pyClass = d.deps.python_ok ? "ok" : "warn";
  const dkClass = d.deps.docker_ok ? "ok" : "warn";
  const dkLabel = d.deps.docker_ok ? (d.deps.docker_running ? `${d.deps.docker_version} · aktiv` : d.deps.docker_version) : "nicht installiert";
  document.getElementById("deps-pills").innerHTML =
    `<span class="pill ${pyClass}">Python ${d.deps.python_version || "?"}</span>` +
    `<span class="pill ${dkClass}">Docker: ${dkLabel}</span>`;
  document.getElementById("btn-deps").classList.toggle("hidden", d.deps.python_ok && d.deps.docker_ok);
}

async function openApp(mode, path) {
  toast(`Starte Gimel ${mode}…`);
  try {
    const d = await api("/api/master/start", { method: "POST", body: JSON.stringify({ mode }) });
    window.location.href = d.base_url + path;
  } catch (e) {
    toast(e.message, true);
  }
}

async function stopServer(mode) {
  try {
    await api("/api/master/stop", { method: "POST", body: JSON.stringify({ mode }) });
    toast(`Gimel ${mode} gestoppt.`);
    loadStatus();
  } catch (e) {
    toast(e.message, true);
  }
}

function setEnv(env) {
  currentEnv = env;
  document.getElementById("env-production").classList.toggle("active", env === "production");
  document.getElementById("env-playground").classList.toggle("active", env === "playground");
  loadAccounts();
}

async function loadAccounts() {
  const body = document.getElementById("acc-body");
  try {
    const d = await api(`/api/master/accounts?env=${currentEnv}`);
    if (!d.accounts.length) {
      body.innerHTML = `<tr><td colspan="4" class="sub">Noch keine Konten in ${currentEnv}. Oben das erste Admin-Konto anlegen.</td></tr>`;
      return;
    }
    body.innerHTML = d.accounts.map(a => {
      const st = !a.active ? '<span class="pill warn">Deaktiviert</span>'
        : a.locked ? '<span class="pill warn">Gesperrt</span>'
        : `<span class="pill ok">Aktiv${a.active_sessions ? ` (${a.active_sessions})` : ""}</span>`;
      return `<tr>
        <td><strong class="mono">${esc(a.username)}</strong></td>
        <td>
          <select onchange="changeRole(${a.id}, this.value)">
            <option value="admin"${a.role === "admin" ? " selected" : ""}>Admin</option>
            <option value="staff"${a.role === "staff" ? " selected" : ""}>Büro (Staff)</option>
            <option value="worker"${a.role === "worker" ? " selected" : ""}>Halle (Worker)</option>
          </select>
        </td>
        <td>${st}</td>
        <td>
          <div class="row">
            <button type="button" class="sm" onclick="resetPw(${a.id}, '${esc(a.username)}')">Passwort</button>
            ${a.locked ? `<button type="button" class="sm" onclick="patchAcc(${a.id}, {unlock:true}, 'Konto entsperrt.')">Entsperren</button>` : ""}
            <button type="button" class="sm" onclick="patchAcc(${a.id}, {active:${!a.active}}, '${a.active ? "Konto deaktiviert." : "Konto aktiviert."}')">${a.active ? "Deaktivieren" : "Aktivieren"}</button>
            <button type="button" class="sm" onclick="patchAcc(${a.id}, {logout_all:true}, 'Alle Sitzungen abgemeldet.')">Abmelden</button>
          </div>
        </td>
      </tr>`;
    }).join("");
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" class="sub">${esc(e.message)}</td></tr>`;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

document.getElementById("add-form").onsubmit = async (e) => {
  e.preventDefault();
  const username = document.getElementById("new-user").value.trim();
  const password = document.getElementById("new-pass").value;
  const role = document.getElementById("new-role").value;
  try {
    await api(`/api/master/accounts?env=${currentEnv}`, {
      method: "POST",
      body: JSON.stringify({ username, password, role }),
    });
    document.getElementById("new-user").value = "";
    document.getElementById("new-pass").value = "";
    toast(`Konto '${username}' angelegt.`);
    loadAccounts();
  } catch (err) {
    toast(err.message, true);
  }
};

async function changeRole(id, role) {
  await patchAcc(id, { role }, "Rolle aktualisiert.");
}

async function resetPw(id, uname) {
  const pw = window.prompt(`Neues Passwort für '${uname}' (mind. 8 Zeichen):`, genPw());
  if (!pw) return;
  await patchAcc(id, { password: pw }, `Passwort für '${uname}' geändert.`);
}

async function patchAcc(id, payload, okMsg) {
  try {
    await api(`/api/master/accounts/${id}?env=${currentEnv}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    toast(okMsg);
    loadAccounts();
  } catch (e) {
    toast(e.message, true);
    loadAccounts();
  }
}

async function installDeps() {
  const btn = document.getElementById("btn-deps");
  btn.disabled = true;
  btn.textContent = "Installiere…";
  try {
    const d = await api("/api/master/install-deps", { method: "POST", body: "{}" });
    toast(d.detail || "Komponenten geprüft.");
    loadStatus();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Python / Docker installieren";
  }
}

function refreshAll() { loadStatus(); if (!document.getElementById("panel-accounts").classList.contains("hidden")) loadAccounts(); }
loadStatus();
</script>
</body>
</html>
"""


def _hidden_popen_kwargs() -> dict:
    """Return subprocess.Popen kwargs that suppress console windows on Windows."""
    kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        si = subprocess.STARTUPINFO()
        si.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0x00000001)
        si.wShowWindow = 0  # SW_HIDE
        kwargs["startupinfo"] = si
    return kwargs


class MasterAdminController:
    """Manages local Gimel server subprocesses and serves the localhost Master Admin UI."""

    def __init__(self, base_dir: Path, host: str = launcher.DEFAULT_HOST) -> None:
        self.base_dir = base_dir
        self.host = host
        self.token = secrets.token_urlsafe(24)
        self._lock = threading.Lock()
        self._procs: dict[EnvName, subprocess.Popen] = {}
        self.server: ThreadingHTTPServer | None = None
        self.port: int = 0

    def _port_for(self, mode: EnvName) -> int:
        return launcher.PLAYGROUND_PORT if mode == "playground" else launcher.PRODUCTION_PORT

    def is_running(self, mode: EnvName) -> bool:
        with self._lock:
            p = self._procs.get(mode)
            if p is not None and p.poll() is None:
                return True
        return _port_alive(self._port_for(mode))

    def start_mode(self, mode: EnvName) -> str:
        port = self._port_for(mode)
        if not self.is_running(mode):
            if getattr(sys, "frozen", False):
                exe = Path(sys.executable)
                if os.name == "nt":
                    gimel_gui = exe.with_name("Gimel.exe")
                    if gimel_gui.is_file():
                        exe = gimel_gui
                cmd = [str(exe)]
            else:
                cmd = [sys.executable, "-m", "gimel.launcher"]
            cmd += [
                "--mode", mode,
                "--host", self.host,
                "--port", str(port),
                "--data-dir", str(self.base_dir),
                "--no-browser",
            ]
            proc = subprocess.Popen(cmd, **_hidden_popen_kwargs())
            with self._lock:
                self._procs[mode] = proc
            if not _wait_health(port, timeout=25.0):
                raise RuntimeError(f"Gimel {mode} konnte auf Port {port} nicht gestartet werden.")
        return f"http://127.0.0.1:{port}"

    def open_url_window(self, url: str) -> None:
        """Open *url* in a standalone app window (Edge/Chrome --app= or default browser) without closing Master Admin."""
        from .desktop import _find_app_browser

        browser = _find_app_browser()
        if browser:
            profile_dir = self.base_dir / "desktop-profile"
            profile_dir.mkdir(parents=True, exist_ok=True)
            cmd = [
                browser,
                f"--app={url}",
                "--window-size=1440,920",
                f"--user-data-dir={profile_dir}",
                "--no-first-run",
                "--no-default-browser-check",
            ]
            try:
                subprocess.Popen(cmd, **_hidden_popen_kwargs())
                return
            except OSError:
                pass
        webbrowser.open(url)

    def stop_mode(self, mode: EnvName) -> None:
        with self._lock:
            proc = self._procs.pop(mode, None)
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                proc.kill()

    def shutdown_all(self) -> None:
        for mode in ("production", "playground"):
            self.stop_mode(mode)
        if self.server is not None:
            try:
                self.server.shutdown()
            except Exception:  # noqa: BLE001
                pass

    def start_http(self, port: int = 0) -> int:
        ctrl = self

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

            def _check_token(self) -> bool:
                if self.headers.get("X-Master-Token") != ctrl.token:
                    self._json({"detail": "Ungültiger Master-Token."}, 403)
                    return False
                return True

            def _parse_env(self) -> EnvName:
                if "env=playground" in self.path:
                    return "playground"
                return "production"

            def _body(self) -> dict:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0:
                    return {}
                return json.loads(self.rfile.read(min(n, 65536)).decode("utf-8") or "{}")

            def do_GET(self) -> None:  # noqa: N802
                path = self.path.split("?", 1)[0]
                if path in ("/", "/index.html"):
                    body = HTML.replace("__VERSION__", APP_VERSION).replace("__TOKEN__", ctrl.token).encode("utf-8")
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if path == "/api/master/status":
                    if not self._check_token():
                        return
                    self._json(
                        {
                            "version": APP_VERSION,
                            "lan_ips": local_lan_ips(),
                            "deps": setup_ui._detect_deps(),
                            "servers": {
                                "production": {"port": launcher.PRODUCTION_PORT, "running": ctrl.is_running("production")},
                                "playground": {"port": launcher.PLAYGROUND_PORT, "running": ctrl.is_running("playground")},
                            },
                        }
                    )
                    return
                if path == "/api/master/accounts":
                    if not self._check_token():
                        return
                    env = self._parse_env()
                    self._json({"env": env, "accounts": list_accounts(ctrl.base_dir, env)})
                    return
                self.send_error(HTTPStatus.NOT_FOUND)

            def do_POST(self) -> None:  # noqa: N802
                if not self._check_token():
                    return
                path = self.path.split("?", 1)[0]
                try:
                    data = self._body()
                    if path == "/api/master/start":
                        mode: EnvName = "playground" if data.get("mode") == "playground" else "production"
                        base_url = ctrl.start_mode(mode)
                        self._json({"ok": True, "mode": mode, "base_url": base_url})
                        return
                    if path == "/api/master/stop":
                        mode = "playground" if data.get("mode") == "playground" else "production"
                        ctrl.stop_mode(mode)
                        self._json({"ok": True, "mode": mode})
                        return
                    if path == "/api/master/accounts":
                        env = self._parse_env()
                        acc = create_account(
                            ctrl.base_dir,
                            env,
                            username=str(data.get("username") or ""),
                            password=str(data.get("password") or ""),
                            role=str(data.get("role") or "admin"),
                            name=str(data.get("name") or ""),
                        )
                        self._json({"ok": True, "account": acc}, 201)
                        return
                    if path == "/api/master/install-deps":
                        deps = setup_ui._detect_deps()
                        res = setup_ui._install_missing_deps(
                            install_python=not deps["python_ok"],
                            install_docker=not deps["docker_ok"],
                        )
                        self._json(res)
                        return
                except ValueError as exc:
                    self._json({"detail": str(exc)}, 400)
                    return
                except Exception as exc:  # noqa: BLE001
                    self._json({"detail": str(exc)}, 500)
                    return
                self.send_error(HTTPStatus.NOT_FOUND)

            def do_PATCH(self) -> None:  # noqa: N802
                if not self._check_token():
                    return
                path = self.path.split("?", 1)[0]
                if not path.startswith("/api/master/accounts/"):
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                try:
                    uid = int(path.rsplit("/", 1)[-1])
                    data = self._body()
                    acc = update_account(
                        ctrl.base_dir,
                        self._parse_env(),
                        uid,
                        password=data.get("password"),
                        role=data.get("role"),
                        active=data.get("active"),
                        unlock=bool(data.get("unlock", False)),
                        logout_all=bool(data.get("logout_all", False)),
                    )
                    self._json({"ok": True, "account": acc})
                except KeyError as exc:
                    self._json({"detail": str(exc)}, 404)
                except ValueError as exc:
                    self._json({"detail": str(exc)}, 400)
                except Exception as exc:  # noqa: BLE001
                    self._json({"detail": str(exc)}, 500)

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.port = int(self.server.server_address[1])
        threading.Thread(target=self.server.serve_forever, name="gimel-master-admin", daemon=True).start()
        return self.port
