"""Tests for the Gimel Native Desktop App (Gimel.exe + gimel.desktop)."""

from __future__ import annotations

import importlib.util
import json
import urllib.request
from pathlib import Path

from gimel import desktop, setup_ui

ROOT = Path(__file__).resolve().parents[2]


def test_desktop_target_resolution_and_config(tmp_path: Path) -> None:
    # Fresh base dir -> opens setup wizard inside desktop window
    assert desktop.resolve_desktop_target("auto", tmp_path) == "setup"
    assert desktop.resolve_desktop_target("playground", tmp_path) == "playground"
    assert desktop.resolve_desktop_target("production", tmp_path) == "production"

    # Saving desktop preference switches auto resolution to saved mode
    desktop.save_desktop_config(tmp_path, default_mode="production", host="0.0.0.0")
    cfg = desktop.load_desktop_config(tmp_path)
    assert cfg["default_mode"] == "production"
    assert desktop.resolve_desktop_target("auto", tmp_path) == "production"

    desktop.save_desktop_config(tmp_path, default_mode="playground", host="127.0.0.1")
    assert desktop.resolve_desktop_target("auto", tmp_path) == "playground"


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
    assert 'Filename: "{app}\\Gimel.exe"; Description: "Gimel Desktop-App jetzt starten"' in iss_text
    assert 'gimel-cli.exe' in iss_text
