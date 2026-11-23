"""DSoundPro Launcher — Starts the Python server, displays Mobile QR URL, and opens the Desktop App."""

from __future__ import annotations

import argparse
import multiprocessing
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from dsoundpro.config import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    DOWNLOADS_DIR,
    IS_FROZEN,
    STATIC_DIR,
    ensure_directories,
    get_local_ip,
)


def ensure_app_icons() -> None:
    """Generate crisp PNG icons for PWA, favicon, and mobile home screen if missing."""
    icons_dir = STATIC_DIR / "icons"
    icon_192 = icons_dir / "icon-192.png"
    icon_512 = icons_dir / "icon-512.png"
    if icon_192.is_file() and icon_512.is_file():
        return
    if IS_FROZEN:
        return

    icons_dir.mkdir(parents=True, exist_ok=True)
    from PIL import Image, ImageDraw

    def _draw_icon(size: int, dest: Path) -> None:
        img = Image.new("RGBA", (size, size), (8, 8, 10, 255))
        draw = ImageDraw.Draw(img)
        pad = int(size * 0.08)
        draw.ellipse((pad, pad, size - pad, size - pad), fill=(30, 215, 96, 255))
        cx, cy = size // 2, size // 2
        stroke = max(6, int(size * 0.068))
        for factor, y_shift in ((0.56, -0.05), (0.43, 0.09), (0.31, 0.22)):
            r = int(size * factor)
            bbox = (
                cx - r,
                int(cy + size * y_shift) - int(r * 0.42),
                cx + r,
                int(cy + size * y_shift) + int(r * 0.95),
            )
            draw.arc(bbox, start=212, end=328, fill=(8, 8, 10, 255), width=stroke)
        img.save(dest, format="PNG")

    _draw_icon(192, icon_192)
    _draw_icon(512, icon_512)


def find_available_port(preferred: int, max_tries: int = 20) -> int:
    """Return preferred port if free, otherwise pick the next available TCP port."""
    for port in range(preferred, preferred + max_tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
    return preferred


def open_desktop_window(url: str) -> None:
    """Open DSoundPro in a clean frameless app window (Edge/Chrome --app mode) or default browser."""
    time.sleep(1.5)
    if sys.platform.startswith("win"):
        candidates = [
            Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Microsoft/Edge/Application/msedge.exe",
            Path(os.environ.get("PROGRAMFILES", "")) / "Microsoft/Edge/Application/msedge.exe",
            Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
        ]
        for exe in candidates:
            if exe.is_file():
                try:
                    subprocess.Popen(
                        [str(exe), f"--app={url}", "--window-size=1280,820"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    return
                except Exception:
                    pass
    else:
        for cmd in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
            found = shutil.which(cmd)
            if found:
                try:
                    subprocess.Popen([found, f"--app={url}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return
                except Exception:
                    pass
    webbrowser.open(url)


def print_banner(port: int) -> None:
    local_ip = get_local_ip()
    line = "=" * 62
    if sys.platform.startswith("win"):
        try:
            import ctypes

            ctypes.windll.kernel32.SetConsoleTitleW("DSoundPro — Tu Música Sin Límites")
        except Exception:
            pass
    print(f"\n{line}")
    print("   DSoundPro — Tu Música Sin Límites (PC + Celular + MP3)")
    print(line)
    print(f"   Ordenador : http://localhost:{port}")
    print(f"   Celular   : http://{local_ip}:{port}  (mismo Wi-Fi)")
    print(f"   Descargas : {DOWNLOADS_DIR}")
    print("   (Deja esta ventana abierta mientras escuchas música)")
    print(f"{line}\n")


def main() -> None:
    multiprocessing.freeze_support()

    parser = argparse.ArgumentParser(description="Inicia DSoundPro")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Host de escucha (por defecto 0.0.0.0)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Puerto (por defecto 8765)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir ventana automáticamente")
    args = parser.parse_args()

    ensure_directories()
    ensure_app_icons()

    port = find_available_port(args.port)
    print_banner(port)

    if not args.no_browser:
        threading.Thread(
            target=open_desktop_window,
            args=(f"http://localhost:{port}",),
            daemon=True,
        ).start()

    from dsoundpro.server import app

    uvicorn.run(
        app,
        host=args.host,
        port=port,
        log_level="warning" if IS_FROZEN else "info",
        use_colors=not IS_FROZEN,
    )


if __name__ == "__main__":
    main()
