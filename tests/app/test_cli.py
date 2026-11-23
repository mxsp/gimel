"""A standalone plant is readable by its own user only, new or upgraded."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _gimel(data: Path, *cmd: str) -> None:
    env = {k: v for k, v in os.environ.items()
           if k not in ("GIMEL_APP_ROOT", "GIMEL_SECRET_KEY", "GIMEL_ENV_PREFIX")}
    env |= {"GIMEL_DATA": str(data), "PYTHONPATH": str(ROOT), "GIMEL_MAIL_SILENT": "1"}
    subprocess.run([sys.executable, *cmd], env=env, cwd=data.parent, check=True,
                   capture_output=True, text=True, preexec_fn=lambda: os.umask(0o022))


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_demo_and_the_start_of_serve_restrict_folder_and_database(tmp_path):
    data = tmp_path / "plant"
    _gimel(data, "-m", "gimel", "demo")
    assert _mode(data) == 0o700
    assert _mode(data / "gimel.db") == 0o600
    assert _mode(data / "secret.key") == 0o600
    assert _mode(data / "demo-login.txt") == 0o600

    # A folder from an older version: _init is the first step of `gimel serve`.
    os.chmod(data, 0o755)
    os.chmod(data / "gimel.db", 0o644)
    _gimel(data, "-c", "from gimel.cli import _init; _init()")
    assert _mode(data) == 0o700
    assert _mode(data / "gimel.db") == 0o600
