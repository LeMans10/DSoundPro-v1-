# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_data_files
from PyInstaller.utils.hooks import collect_submodules

datas = [('C:/Users/Legardes/Desktop/Antigravity/DSoundPro/static', 'static')]
hiddenimports = ['uvicorn.logging', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan.on', 'multipart', 'python_multipart', 'mutagen.mp3', 'mutagen.mp4', 'mutagen.id3', 'mutagen.flac', 'mutagen.oggvorbis', 'yt_dlp']
datas += collect_data_files('imageio_ffmpeg')
datas += collect_data_files('certifi')
hiddenimports += collect_submodules('uvicorn')


a = Analysis(
    ['C:/Users/Legardes/Desktop/Antigravity/DSoundPro/run.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='DSoundPro',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['C:/Users/Legardes/Desktop/Antigravity/DSoundPro/static/icons/dsoundpro.ico'],
)
