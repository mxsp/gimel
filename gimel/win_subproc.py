"""Windows hidden subprocess helpers — prevents console window flashing.

When ``Gimel.exe`` runs with ``console=False`` on Windows, spawning child console
processes (``docker``, ``git``, ``winget``, ``powershell``, ``robocopy``, ``cmd.exe``,
``piper``, or child ``Gimel.exe`` servers) would otherwise pop up a transient
black console window unless ``CREATE_NO_WINDOW`` and ``SW_HIDE`` are passed.
"""

from __future__ import annotations

import os
import subprocess
from typing import Any


def hidden_subprocess_kwargs() -> dict[str, Any]:
    """Return ``subprocess.run`` / ``subprocess.Popen`` kwargs that hide any console window on Windows."""
    if os.name != "nt":
        return {}
    si = subprocess.STARTUPINFO()  # type: ignore[attr-defined]
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW  # type: ignore[attr-defined]
    si.wShowWindow = 0  # SW_HIDE
    return {
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
        "startupinfo": si,
    }
