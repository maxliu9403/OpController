# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules, copy_metadata


project_root = Path.cwd()

hiddenimports = (
    collect_submodules("playwright")
    + collect_submodules("uvicorn")
    + collect_submodules("sqlalchemy.dialects.sqlite")
    + [
        "aiosqlite",
        "greenlet",
    ]
)

datas = []
for package_name in (
    "fastapi",
    "playwright",
    "uvicorn",
    "sqlalchemy",
    "pydantic",
    "pydantic-settings",
):
    datas += copy_metadata(package_name)


a = Analysis(
    [str(project_root / "app" / "main.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="opcontroller-runtime",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="opcontroller-runtime",
)
