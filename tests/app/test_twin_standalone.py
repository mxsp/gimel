"""Eigenständiger Digitaler Grundriss (/twin & `gimel twin`) — wie Twin Studio & Agent Lab."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from gimel import cli, twin_app


def test_mount_returns_503_hint_when_not_built(tmp_path, monkeypatch):
    monkeypatch.setattr(twin_app, "DIST", tmp_path / "missing")
    app = FastAPI()
    twin_app.mount(app)
    c = TestClient(app)
    r = c.get("/twin")
    assert r.status_code == 503
    assert "Digitaler Grundriss" in r.text


def test_mount_serves_entry_and_blocks_traversal(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "twin.html").write_text("<html><body>Grundriss OK</body></html>", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("TOPSECRET", encoding="utf-8")
    monkeypatch.setattr(twin_app, "DIST", dist)

    app = FastAPI()
    twin_app.mount(app)
    c = TestClient(app)

    r = c.get("/twin/")
    assert r.status_code == 200
    assert "Grundriss OK" in r.text

    r2 = c.get("/twin/../secret.txt")
    assert "TOPSECRET" not in r2.text


def test_create_twin_app_redirects_root_and_disables_pin(monkeypatch):
    app = twin_app.create_twin_app()
    c = TestClient(app)

    r_root = c.get("/", follow_redirects=False)
    assert r_root.status_code == 307
    assert r_root.headers["location"] == "/twin/"

    r_opts = c.get("/api/auth/login-options")
    assert r_opts.status_code == 200
    assert r_opts.json() == {"test_pin_enabled": False, "gimel_pin_enabled": False}

    r_pin = c.post("/api/auth/pin", json={"pin": "2468"})
    assert r_pin.status_code == 404


def test_cli_twin_refuses_non_loopback(tmp_path, monkeypatch):
    (tmp_path / "gimel.db").write_bytes(b"")
    monkeypatch.setattr(cli, "_data_dir", lambda: tmp_path)
    monkeypatch.setattr(cli, "_init", lambda: tmp_path)
    rc = cli.main(["twin", "--host", "0.0.0.0", "--no-browser"])
    assert rc == 2
