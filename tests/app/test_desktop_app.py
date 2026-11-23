"""Tests for the Gimel Native Desktop App & Local Master Admin Console."""

from __future__ import annotations

import importlib.util
import json
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from gimel import desktop, master_admin, setup_ui

ROOT = Path(__file__).resolve().parents[2]


def test_desktop_target_resolution_defaults_to_master(tmp_path: Path) -> None:
    assert desktop.resolve_desktop_target("auto", tmp_path) == "master"
    assert desktop.resolve_desktop_target("master", tmp_path) == "master"
    assert desktop.resolve_desktop_target("playground", tmp_path) == "playground"
    assert desktop.resolve_desktop_target("production", tmp_path) == "production"
    assert desktop.resolve_desktop_target("setup", tmp_path) == "setup"


def test_master_admin_account_crud_and_last_admin_guard(tmp_path: Path) -> None:
    assert master_admin.list_accounts(tmp_path, "production") == []

    admin = master_admin.create_account(
        tmp_path, "production", username="chef", password="StrongPassword123", role="admin"
    )
    assert admin["username"] == "chef"
    assert admin["role"] == "admin"
    assert admin["active"] is True

    # Safety guard: cannot deactivate or demote the last active admin
    with pytest.raises(ValueError, match="letzte aktive Admin"):
        master_admin.update_account(tmp_path, "production", admin["id"], active=False)
    with pytest.raises(ValueError, match="letzte aktive Admin"):
        master_admin.update_account(tmp_path, "production", admin["id"], role="staff")

    # Add second user, reset password, promote, then deactivate
    staff = master_admin.create_account(
        tmp_path, "production", username="buero", password="OfficePassword123", role="staff"
    )
    updated = master_admin.update_account(
        tmp_path, "production", staff["id"], role="admin", password="NewPassword456", unlock=True, logout_all=True
    )
    assert updated["role"] == "admin"
    assert updated["locked"] is False

    deactivated = master_admin.update_account(tmp_path, "production", staff["id"], active=False)
    assert deactivated["active"] is False


def test_master_admin_http_requires_session_token(tmp_path: Path) -> None:
    ctrl = master_admin.MasterAdminController(tmp_path)
    port = ctrl.start_http(port=0)
    try:
        # Root HTML loads cleanly on 127.0.0.1
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=3) as resp:
            assert resp.status == 200
            html = resp.read().decode("utf-8")
        assert "Gimel Master Admin" in html

        # API without token is rejected with 403
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/master/status", timeout=3)
        assert exc.value.code == 403

        # API with valid X-Master-Token succeeds
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/master/status",
            headers={"X-Master-Token": ctrl.token},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        assert "servers" in data
        assert "production" in data["servers"]
        assert "playground" in data["servers"]
    finally:
        ctrl.shutdown_all()


def test_desktop_entrypoint_defaults_to_desktop_mode() -> None:
    spec = importlib.util.spec_from_file_location("desktop_ep", ROOT / "packaging" / "desktop_entrypoint.py")
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    assert mod.build_argv([]) == ["--mode", "desktop"]
    assert mod.build_argv(["--target", "playground"]) == ["--mode", "desktop", "--target", "playground"]
    assert mod.build_argv(["--mode", "production", "--no-browser"]) == ["--mode", "production", "--no-browser"]


def test_setup_ui_background_server_for_desktop(tmp_path: Path) -> None:
    srv, port = setup_ui.start_setup_ui_background(port=0, base_dir=tmp_path)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info", timeout=3) as resp:
            assert resp.status == 200
            data = json.loads(resp.read().decode("utf-8"))
        assert "version" in data
        assert "python_ok" in data
        assert "docker_ok" in data
    finally:
        srv.shutdown()
        srv.server_close()


def test_windows_packaging_builds_windowed_desktop_app() -> None:
    spec_text = (ROOT / "packaging" / "gimel.spec").read_text(encoding="utf-8")
    assert "desktop_entrypoint.py" in spec_text
    assert 'name="Gimel"' in spec_text
    assert "console=False" in spec_text
    assert 'name="gimel-cli"' in spec_text
    assert "webview" in spec_text

    iss_text = (ROOT / "packaging" / "windows" / "gimel-setup.iss").read_text(encoding="utf-8")
    assert 'UninstallDisplayIcon={app}\\Gimel.exe' in iss_text
    assert 'Name: "{autodesktop}\\Gimel"; Filename: "{app}\\Gimel.exe"' in iss_text
    assert 'Filename: "{app}\\Gimel.exe"; Description: "Gimel Desktop & Master Admin jetzt öffnen"' in iss_text
    assert '--mode production --init-only --admin-user' in iss_text
