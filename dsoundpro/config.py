"""Configuration and runtime path management for DSoundPro."""

from __future__ import annotations

import os
import socket
import sys
from pathlib import Path

IS_FROZEN = bool(getattr(sys, "frozen", False))
BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def _resolve_writable_base() -> Path:
    if not IS_FROZEN:
        return Path(__file__).resolve().parent.parent
    exe_dir = Path(sys.executable).resolve().parent
    try:
        probe = exe_dir / ".dsoundpro_write_test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return exe_dir
    except OSError:
        fallback = Path.home() / "DSoundPro"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


BASE_DIR = _resolve_writable_base()
DATA_DIR = BASE_DIR / "data"
DOWNLOADS_DIR = BASE_DIR / "downloads"
UPLOADS_DIR = DATA_DIR / "uploads"
COVERS_DIR = DATA_DIR / "covers"
STATIC_DIR = BUNDLE_DIR / "static"
DB_PATH = DATA_DIR / "dsoundpro.db"

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = int(os.environ.get("DSOUNDPRO_PORT", "8765"))


def ensure_directories() -> None:
    """Ensure all required runtime directories exist."""
    for directory in (DATA_DIR, DOWNLOADS_DIR, UPLOADS_DIR, COVERS_DIR):
        directory.mkdir(parents=True, exist_ok=True)
    if not IS_FROZEN:
        STATIC_DIR.mkdir(parents=True, exist_ok=True)


def get_ffmpeg_path() -> str:
    """Return the path to the ffmpeg executable (bundled via imageio-ffmpeg or system PATH)."""
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).exists():
            return exe
    except Exception:
        pass
    # Fallback search inside frozen PyInstaller bundle
    bundled_bins = BUNDLE_DIR / "imageio_ffmpeg" / "binaries"
    if bundled_bins.is_dir():
        for candidate in bundled_bins.glob("ffmpeg*"):
            if candidate.is_file():
                return str(candidate)
    return "ffmpeg"


def get_local_ip() -> str:
    """Detect the machine's primary LAN IPv4 address for mobile Wi-Fi access."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(1.5)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127."):
                return ip
    except Exception:
        pass

    return "127.0.0.1"


def sanitize_filename(name: str, max_length: int = 120) -> str:
    """Create a cross-platform safe filename for exported MP3/M4A files."""
    invalid = '<>:"/\\|?*\r\n\t'
    cleaned = "".join("_" if ch in invalid else ch for ch in (name or "track"))
    cleaned = " ".join(cleaned.split()).strip(" .")
    if not cleaned:
        cleaned = "track"
    return cleaned[:max_length].rstrip(" .")
