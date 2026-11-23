"""PyInstaller entrypoint for standalone Gimel executable (Playground & Production)."""

from __future__ import annotations

import multiprocessing
import sys


def main() -> int:
    multiprocessing.freeze_support()
    from gimel.launcher import main as launcher_main

    return launcher_main(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
