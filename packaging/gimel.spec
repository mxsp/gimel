# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Gimel standalone executable (Linux binary & Windows .exe).

Bundles both Playground and Production modes, plus all built SPAs:
  - /app    (gimel/webapp/dist)
  - /studio (gimel/studio/dist)
  - /twin   (gimel/twin/dist)
  - /lab    (agentlab/webapp/dist)
"""

import os
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parent

datas = []
for rel in (
    "gimel/webapp/dist",
    "gimel/studio/dist",
    "gimel/twin/dist",
    "agentlab/webapp/dist",
):
    src = ROOT / rel
    if src.is_dir():
        datas.append((str(src), rel))

laufkarte_js = ROOT / "gimel" / "admin" / "laufkarte.js"
if laufkarte_js.is_file():
    datas.append((str(laufkarte_js), "gimel/admin"))

win_ico = ROOT / "packaging" / "windows" / "gimel.ico"

# Include timezone / cert / ezdxf package data if present
for pkg in ("certifi", "ezdxf"):
    try:
        datas += collect_data_files(pkg)
    except Exception:
        pass

hiddenimports = [
    *collect_submodules("gimel"),
    *collect_submodules("agentlab"),
    *collect_submodules("uvicorn"),
    *collect_submodules("starlette"),
    *collect_submodules("fastapi"),
    *collect_submodules("sqlalchemy.dialects.sqlite"),
    "email_validator",
    "multipart",
    "python_multipart",
    "bcrypt",
    "jwt",
    "cryptography",
    "pydantic_settings",
]

a = Analysis(
    [str(ROOT / "packaging" / "entrypoint.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest", "cv2", "PIL.ImageTk"],
    noarchive=False,
)

pyz = PYZ(a.pure)

# Use --onedir on Windows by default (no self-extracting %TEMP%\_MEI* unpacker ->
# faster startup and dramatically fewer Windows Defender false positives).
# Inno Setup compresses the entire directory cleanly into Gimel-Setup-x64.exe.
USE_ONEDIR = sys.platform == "win32" or os.environ.get("GIMEL_PYINSTALLER_ONEDIR") == "1"

if USE_ONEDIR:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="gimel",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=True,
        icon=str(win_ico) if win_ico.is_file() else None,
        disable_windowed_traceback=False,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name="gimel",
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name="gimel",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=True,
        icon=str(win_ico) if win_ico.is_file() else None,
        disable_windowed_traceback=False,
    )
