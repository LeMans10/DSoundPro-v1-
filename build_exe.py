"""Build script to package DSoundPro into a clean, standalone, safely shareable Windows executable."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
ICONS_DIR = STATIC_DIR / "icons"
RELEASE_DIR = ROOT / "release"
DIST_DIR = ROOT / "dist"
BUILD_DIR = ROOT / "build"


def generate_icons() -> Path:
    """Create crisp multi-resolution PNG and ICO icons for DSoundPro.exe."""
    ICONS_DIR.mkdir(parents=True, exist_ok=True)

    def _render(size: int) -> Image.Image:
        img = Image.new("RGBA", (size, size), (8, 8, 10, 0))
        draw = ImageDraw.Draw(img)
        pad = int(size * 0.04)
        draw.ellipse((pad, pad, size - pad, size - pad), fill=(30, 215, 96, 255))
        cx, cy = size // 2, size // 2
        stroke = max(4, int(size * 0.072))
        for factor, y_shift in ((0.56, -0.05), (0.43, 0.09), (0.31, 0.22)):
            r = int(size * factor)
            bbox = (
                cx - r,
                int(cy + size * y_shift) - int(r * 0.42),
                cx + r,
                int(cy + size * y_shift) + int(r * 0.95),
            )
            draw.arc(bbox, start=212, end=328, fill=(8, 8, 10, 255), width=stroke)
        return img

    img_512 = _render(512)
    img_512.save(ICONS_DIR / "icon-512.png", format="PNG")
    img_512.resize((192, 192), Image.Resampling.LANCZOS).save(ICONS_DIR / "icon-192.png", format="PNG")

    ico_path = ICONS_DIR / "dsoundpro.ico"
    img_512.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"[OK] Icono generado: {ico_path}")
    return ico_path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_friend_readme(dest: Path, exe_hash: str) -> None:
    text = f"""============================================================
          DSoundPro v1.0 — Tu Música Sin Límites
============================================================

¡Hola! Gracias por probar DSoundPro.
Esta es una aplicación 100% portable: NO necesita instalar Python,
FFmpeg ni ningún programa adicional.

CÓMO USARLO EN TU ORDENADOR (WINDOWS)
------------------------------------------------------------
1. Extrae esta carpeta completa (o copia DSoundPro.exe en una
   carpeta propia, por ejemplo en tu Escritorio o Documentos).
2. Haz doble clic en "DSoundPro.exe".
3. Si Windows SmartScreen muestra "Windows protegió su PC"
   (es normal en apps nuevas sin firma comercial):
   -> Pulsa "Más información" y luego "Ejecutar de todas formas".
4. Se abrirá una ventana negra pequeña (el servidor local) y en
   2 segundos se abrirá la app de DSoundPro automáticamente.
   * Mantén la ventana negra abierta mientras escuchas música.
   * Cuando quieras cerrar DSoundPro, simplemente cierra esa ventana.

CÓMO USARLO EN TU CELULAR (ANDROID / IPHONE)
------------------------------------------------------------
1. Con DSoundPro abierto en el ordenador, pulsa el botón
   "Conectar Celular (QR)" dentro de la app.
2. Escanea el código QR con la cámara de tu teléfono (conectado
   al mismo Wi-Fi).
3. Opcional: pulsa "Instalar aplicación" (Android) o
   "Añadir a pantalla de inicio" (iPhone) para tenerlo como app.

DESCARGAS MP3 PARA OTROS REPRODUCTORES
------------------------------------------------------------
- Todas las canciones que descargues se guardan en formato MP3/M4A
  estándar con portada y metadatos en la carpeta "downloads/"
  junto a DSoundPro.exe.
- Puedes copiarlas a un USB, reproducirlas en VLC, tu auto o tu
  celular sin internet y sin restricciones.

VERIFICACIÓN DE SEGURIDAD (SHA-256)
------------------------------------------------------------
Para confirmar que el archivo no fue modificado en el envío,
puedes verificar su huella SHA-256 en PowerShell con:
    Get-FileHash DSoundPro.exe -Algorithm SHA256

SHA-256 esperado de DSoundPro.exe:
{exe_hash}
"""
    dest.write_text(text, encoding="utf-8")


def main() -> None:
    ico_path = generate_icons()

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        "DSoundPro",
        "--icon",
        str(ico_path),
        "--add-data",
        f"{STATIC_DIR};static",
        "--collect-data",
        "imageio_ffmpeg",
        "--collect-data",
        "certifi",
        "--collect-submodules",
        "uvicorn",
        "--hidden-import",
        "uvicorn.logging",
        "--hidden-import",
        "uvicorn.loops.auto",
        "--hidden-import",
        "uvicorn.protocols.http.auto",
        "--hidden-import",
        "uvicorn.protocols.websockets.auto",
        "--hidden-import",
        "uvicorn.lifespan.on",
        "--hidden-import",
        "multipart",
        "--hidden-import",
        "python_multipart",
        "--hidden-import",
        "mutagen.mp3",
        "--hidden-import",
        "mutagen.mp4",
        "--hidden-import",
        "mutagen.id3",
        "--hidden-import",
        "mutagen.flac",
        "--hidden-import",
        "mutagen.oggvorbis",
        "--hidden-import",
        "yt_dlp",
        str(ROOT / "run.py"),
    ]

    print("[INFO] Compilando DSoundPro.exe con PyInstaller...")
    proc = subprocess.run(cmd, cwd=str(ROOT))
    if proc.returncode != 0:
        raise SystemExit(f"PyInstaller falló con código {proc.returncode}")

    built_exe = DIST_DIR / "DSoundPro.exe"
    if not built_exe.is_file():
        raise SystemExit("No se encontró dist/DSoundPro.exe")

    if RELEASE_DIR.exists():
        shutil.rmtree(RELEASE_DIR)
    RELEASE_DIR.mkdir(parents=True, exist_ok=True)

    final_exe = RELEASE_DIR / "DSoundPro.exe"
    shutil.copy2(built_exe, final_exe)

    exe_hash = sha256_file(final_exe)
    readme_path = RELEASE_DIR / "LEEME.txt"
    write_friend_readme(readme_path, exe_hash)

    checksum_path = RELEASE_DIR / "SHA256SUMS.txt"
    checksum_path.write_text(f"{exe_hash}  DSoundPro.exe\n", encoding="utf-8")

    # Package clean ZIP ready to share safely (contains zero personal data)
    zip_path = RELEASE_DIR / "DSoundPro_v1.0_Windows.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        zf.write(final_exe, "DSoundPro/DSoundPro.exe")
        zf.write(readme_path, "DSoundPro/LEEME.txt")
        zf.write(checksum_path, "DSoundPro/SHA256SUMS.txt")

    zip_hash = sha256_file(zip_path)
    checksum_path.write_text(
        f"{exe_hash}  DSoundPro.exe\n{zip_hash}  DSoundPro_v1.0_Windows.zip\n",
        encoding="utf-8",
    )

    exe_mb = final_exe.stat().st_size / (1024 * 1024)
    zip_mb = zip_path.stat().st_size / (1024 * 1024)
    print("\n============================================================")
    print(f"[OK] Ejecutable listo : {final_exe} ({exe_mb:.1f} MB)")
    print(f"[OK] ZIP para compartir: {zip_path} ({zip_mb:.1f} MB)")
    print(f"[OK] SHA-256 EXE      : {exe_hash}")
    print(f"[OK] SHA-256 ZIP      : {zip_hash}")
    print("============================================================\n")


if __name__ == "__main__":
    main()
