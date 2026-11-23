"""Tests for automatic Python 3.12+ and Docker installation across Gimel installers."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

from gimel import setup_ui

ROOT = Path(__file__).resolve().parents[2]


def test_inno_setup_iss_has_python_and_docker_tasks() -> None:
    iss = (ROOT / "packaging" / "windows" / "gimel-setup.iss").read_text(encoding="utf-8")
    assert 'GroupDescription: "System-Komponenten (empfohlen)"' in iss
    assert 'Name: "installpython"' in iss
    assert 'Name: "installdocker"' in iss
    assert 'Source: "..\\dist\\gimel\\*"; DestDir: "{app}"' in iss
    assert 'Source: "install-deps.ps1"; DestDir: "{app}"; Flags: ignoreversion' in iss
    assert "-ExecutionPolicy Bypass" not in iss

    run_section = iss[iss.index("[Run]"):iss.index("[UninstallRun]")]
    idx_py = run_section.index("Python.Python.3.12")
    idx_dk = run_section.index("Docker.DockerDesktop")
    idx_ui = run_section.index('Parameters: "--mode setup-ui"')
    assert idx_py < idx_ui
    assert idx_dk < idx_ui
    assert "winget.exe" in run_section
    assert "Tasks: installpython" in iss
    assert "Tasks: installdocker" in iss


def test_install_deps_ps1_exists_and_uses_winget_without_temp_dropper() -> None:
    ps1_path = ROOT / "packaging" / "windows" / "install-deps.ps1"
    assert ps1_path.is_file()
    text = ps1_path.read_text(encoding="utf-8")
    assert "Python.Python.3.12" in text
    assert "Docker.DockerDesktop" in text
    assert "Invoke-WebRequest" not in text
    assert "install-deps.log" in text
    assert "exit 0" in text


def test_setup_ps1_has_skip_docker_and_deps_call() -> None:
    text = (ROOT / "scripts" / "setup.ps1").read_text(encoding="utf-8")
    assert "[switch]$SkipDocker" in text
    assert "install-deps.ps1" in text


def test_setup_sh_syntax_and_flags() -> None:
    sh_path = ROOT / "scripts" / "setup.sh"
    res = subprocess.run(["bash", "-n", str(sh_path)], capture_output=True, text=True, check=False)
    assert res.returncode == 0, res.stderr
    text = sh_path.read_text(encoding="utf-8")
    assert "--skip-docker" in text
    assert "apt-get" in text
    assert "brew install python@3.12" in text
    assert "get.docker.com" in text


def test_install_ui_system_check_and_docker_option() -> None:
    spec = importlib.util.spec_from_file_location("install_ui", ROOT / "scripts" / "install-ui.py")
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    chk = mod.system_check()
    assert "python" in chk
    assert "ok" in chk["python"]
    assert "version" in chk["python"]
    assert "docker" in chk
    assert "ok" in chk["docker"]
    assert "version" in chk["docker"]
    assert "running" in chk["docker"]
    assert "Docker installieren (falls nicht vorhanden)" in mod.HTML


def test_setup_ui_detect_deps_and_api_info() -> None:
    deps = setup_ui._detect_deps()
    for key in ("python_ok", "python_version", "docker_ok", "docker_version", "docker_running"):
        assert key in deps
    assert isinstance(deps["python_ok"], bool)
    assert isinstance(deps["python_version"], str)
    assert isinstance(deps["docker_ok"], bool)
    assert isinstance(deps["docker_version"], str)
    assert isinstance(deps["docker_running"], bool)
    assert "/api/install-deps" in setup_ui.HTML

    # Also verify HTTP /api/info and /api/install-deps with an ephemeral port
    from http.server import ThreadingHTTPServer

    deps_snapshot = setup_ui._detect_deps()

    class TestHandler(setup_ui.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:  # noqa: A002
            return

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/api/info":
                raw = json.dumps({"version": "test", "lan_ips": [], **deps_snapshot}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        time.sleep(0.05)
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info", timeout=2) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        for key in ("python_ok", "python_version", "docker_ok", "docker_version", "docker_running"):
            assert key in payload
    finally:
        srv.shutdown()
        srv.server_close()
