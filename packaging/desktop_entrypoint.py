"""Windowed PyInstaller entrypoint for the Gimel Desktop App (Gimel.exe).

Double-clicking Gimel.exe (no --mode argument) launches Gimel directly as a
native desktop program with no console window. Explicit CLI arguments such as
``--mode production --no-browser`` continue to work seamlessly (used by the
built-in setup wizard and auto-restart updater).
"""

from __future__ import annotations

import multiprocessing
import sys


def build_argv(raw_argv: list[str]) -> list[str]:
    if not any(arg == "--mode" or arg.startswith("--mode=") for arg in raw_argv):
        return ["--mode", "desktop", *raw_argv]
    return list(raw_argv)


def main(argv: list[str] | None = None) -> int:
    multiprocessing.freeze_support()
    from gimel.launcher import main as launcher_main

    effective = build_argv(list(sys.argv[1:] if argv is None else argv))
    return launcher_main(effective)


if __name__ == "__main__":
    raise SystemExit(main())
