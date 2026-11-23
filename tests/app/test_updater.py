"""Tests for the GitHub Release updater (service + API)."""

from __future__ import annotations

import pytest

from gimel.services import updater
from gimel.version import APP_VERSION


def test_semver_comparison():
    assert updater.is_newer_version("0.2.0", "v0.2.1")
    assert updater.is_newer_version("0.2.0", "v0.3.0")
    assert updater.is_newer_version("0.2.0", "1.0.0")
    assert not updater.is_newer_version("0.2.0", "v0.2.0")
    assert not updater.is_newer_version("0.2.0", "v0.1.9")
    assert not updater.is_newer_version("0.2.0", "v0.2.0-rc1")
    assert updater.is_newer_version("0.2.0-rc1", "v0.2.0")


def test_check_for_update_parses_github_release(monkeypatch):
    updater.clear_cache()
    fake_release = {
        "tag_name": "v9.9.9",
        "name": "Gimel v9.9.9",
        "body": "## Changes\n- Better performance",
        "html_url": "https://github.com/mxsp/gimel/releases/tag/v9.9.9",
        "published_at": "2026-12-01T10:00:00Z",
        "assets": [
            {
                "name": "gimel-linux-x64.tar.gz",
                "browser_download_url": "https://github.com/mxsp/gimel/releases/download/v9.9.9/gimel-linux-x64.tar.gz",
                "size": 12345678,
            },
            {
                "name": "gimel-windows-x64.zip",
                "browser_download_url": "https://github.com/mxsp/gimel/releases/download/v9.9.9/gimel-windows-x64.zip",
                "size": 12345679,
            },
            {
                "name": "SHA256SUMS.txt",
                "browser_download_url": "https://github.com/mxsp/gimel/releases/download/v9.9.9/SHA256SUMS.txt",
                "size": 256,
            },
        ],
    }
    monkeypatch.setattr(updater, "_http_get_json", lambda url, timeout=12.0: fake_release)

    info = updater.check_for_update(force=True, repo="mxsp/gimel")
    assert info.repo == "mxsp/gimel"
    assert info.current_version == APP_VERSION
    assert info.latest_tag == "v9.9.9"
    assert info.latest_version == "9.9.9"
    assert info.update_available is True
    assert info.matched_asset is not None
    assert info.checksum_url.endswith("SHA256SUMS.txt")
    assert info.error == ""


def test_update_status_api_endpoint(client, monkeypatch):
    updater.clear_cache()
    fake_release = {
        "tag_name": f"v{APP_VERSION}",
        "name": f"Gimel v{APP_VERSION}",
        "body": "Initial release",
        "html_url": f"https://github.com/mxsp/gimel/releases/tag/v{APP_VERSION}",
        "published_at": "2026-11-23T15:00:00Z",
        "assets": [],
    }
    monkeypatch.setattr(updater, "_http_get_json", lambda url, timeout=12.0: fake_release)

    r = client.get("/api/updates/status", params={"force": "true"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["repo"] == "mxsp/gimel"
    assert data["current_version"] == APP_VERSION
    assert data["update_available"] is False

    # Already up to date -> POST /api/updates/apply succeeds with restart_required=False
    r_apply = client.post("/api/updates/apply", json={})
    assert r_apply.status_code == 200, r_apply.text
    res = r_apply.json()
    assert res["ok"] is True
    assert res["restart_required"] is False


def test_restart_command_handles_module_and_frozen(monkeypatch):
    import sys
    from types import SimpleNamespace

    monkeypatch.setattr(sys, "argv", ["/app/gimel/launcher.py", "--mode", "playground", "--port", "9000"])
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setitem(sys.modules, "__main__", SimpleNamespace(__spec__=SimpleNamespace(name="gimel.launcher")))
    cmd = updater._restart_command()
    assert cmd == [sys.executable, "-m", "gimel.launcher", "--mode", "playground", "--port", "9000"]

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    cmd_frozen = updater._restart_command()
    assert cmd_frozen == [sys.executable, "--mode", "playground", "--port", "9000"]


def test_clean_restart_env_strips_pyinstaller_meipass(monkeypatch):
    import sys

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEI12345")
    monkeypatch.delenv("LD_LIBRARY_PATH_ORIG", raising=False)
    monkeypatch.setenv("_MEIPASS2", "/tmp/_MEI12345")

    env = updater._clean_restart_env()
    assert "LD_LIBRARY_PATH" not in env
    assert "_MEIPASS2" not in env
    assert env["PYINSTALLER_RESET_ENVIRONMENT"] == "1"

    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/usr/local/lib")
    env2 = updater._clean_restart_env()
    assert env2["LD_LIBRARY_PATH"] == "/usr/local/lib"
