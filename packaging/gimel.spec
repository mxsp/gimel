# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Gimel standalone executable (Linux binary & Windows .exe).

Bundles both Playground and Production modes, plus all built SPAs:
  - /app    (gimel/webapp/dist)
  - /studio (gimel/studio/dist)
  - /twin   (gimel/twin/dist)
  - /lab    (agentlab/webapp/dist)
"""

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
    disable_windowed_traceback=False,
)
