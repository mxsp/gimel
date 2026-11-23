# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Gimel standalone executables (Windows Desktop App & Linux Binary).

Bundles both Playground and Production modes, plus all built SPAs:
  - /app    (gimel/webapp/dist)
  - /studio (gimel/studio/dist)
  - /twin   (gimel/twin/dist)
  - /lab    (agentlab/webapp/dist)

On Windows (--onedir), produces BOTH executables sharing one _internal/ directory:
  - Gimel.exe      (windowed native desktop program, console=False, WebView2 / Edge app window)
  - gimel-cli.exe  (console CLI/server launcher, console=True)
"""

import os
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parent

datas = []
binaries = []
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
    "tkinter",
    "tkinter.ttk",
    "tkinter.messagebox",
    "tkinter.simpledialog",
    "_tkinter",
]

# On Windows, bundle pywebview + WebView2 bindings when installed so Gimel.exe
# opens a true native desktop window (with clean Edge --app= fallback if absent).
if sys.platform == "win32":
    for pkg in ("webview", "pythonnet", "clr_loader"):
        try:
            p_datas, p_bins, p_hidden = collect_all(pkg)
            datas += p_datas
            binaries += p_bins
            hiddenimports += p_hidden
        except Exception:
            pass

# Use --onedir on Windows by default (no self-extracting %TEMP%\_MEI* unpacker ->
# faster startup and dramatically fewer Windows Defender false positives).
USE_ONEDIR = sys.platform == "win32" or os.environ.get("GIMEL_PYINSTALLER_ONEDIR") == "1"

if USE_ONEDIR:
    a_desktop = Analysis(
        [str(ROOT / "packaging" / "desktop_entrypoint.py")],
        pathex=[str(ROOT)],
        binaries=binaries,
        datas=datas,
        hiddenimports=hiddenimports,
        hookspath=[],
        hooksconfig={},
        runtime_hooks=[],
        excludes=["matplotlib", "pytest", "cv2", "PIL.ImageTk"],
        noarchive=False,
    )
    a_cli = Analysis(
        [str(ROOT / "packaging" / "entrypoint.py")],
        pathex=[str(ROOT)],
        binaries=binaries,
        datas=datas,
        hiddenimports=hiddenimports,
        hookspath=[],
        hooksconfig={},
        runtime_hooks=[],
        excludes=["matplotlib", "pytest", "cv2", "PIL.ImageTk"],
        noarchive=False,
    )
    MERGE((a_desktop, "Gimel", "Gimel"), (a_cli, "gimel-cli", "gimel-cli"))

    pyz_desktop = PYZ(a_desktop.pure)
    exe_desktop = EXE(
        pyz_desktop,
        a_desktop.scripts,
        [],
        exclude_binaries=True,
        name="Gimel",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        icon=str(win_ico) if win_ico.is_file() else None,
        disable_windowed_traceback=False,
    )

    pyz_cli = PYZ(a_cli.pure)
    exe_cli = EXE(
        pyz_cli,
        a_cli.scripts,
        [],
        exclude_binaries=True,
        name="gimel-cli",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=True,
        icon=str(win_ico) if win_ico.is_file() else None,
        disable_windowed_traceback=False,
    )

    coll = COLLECT(
        exe_desktop,
        a_desktop.binaries,
        a_desktop.datas,
        exe_cli,
        a_cli.binaries,
        a_cli.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name="gimel",
    )
else:
    a = Analysis(
        [str(ROOT / "packaging" / "entrypoint.py")],
        pathex=[str(ROOT)],
        binaries=binaries,
        datas=datas,
        hiddenimports=hiddenimports,
        hookspath=[],
        hooksconfig={},
        runtime_hooks=[],
        excludes=["matplotlib", "pytest", "cv2", "PIL.ImageTk"],
        noarchive=False,
    )
    pyz = PYZ(a.pure)
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
