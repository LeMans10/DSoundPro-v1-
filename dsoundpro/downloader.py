"""Universal Music Downloader: exports standard MP3/M4A files with embedded ID3 metadata & cover art."""

from __future__ import annotations

import asyncio
import io
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx
import yt_dlp
from mutagen.id3 import APIC, COMM, ID3, TALB, TIT2, TPE1, error as ID3Error
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover
from PIL import Image

from .config import DOWNLOADS_DIR, ensure_directories, get_ffmpeg_path, sanitize_filename
from .database import Database
from .music_engine import USER_AGENT


class DownloadManager:
    """Manages async track downloads with live progress and universal player compatibility."""

    def __init__(self, db: Database) -> None:
        ensure_directories()
        self.db = db
        self.jobs: dict[str, dict[str, Any]] = {}
        self._semaphore = asyncio.Semaphore(3)  # Up to 3 concurrent downloads

    def get_all_jobs(self) -> list[dict[str, Any]]:
        return sorted(self.jobs.values(), key=lambda j: j.get("started_at", 0), reverse=True)

    def get_job(self, track_id: str) -> dict[str, Any] | None:
        return self.jobs.get(track_id)

    async def enqueue_download(
        self,
        track: dict[str, Any],
        fmt: str = "mp3",
        bitrate: str = "320",
    ) -> dict[str, Any]:
        saved = self.db.upsert_track(track)
        track_id = saved["id"]

        # Already downloaded and file exists in requested format?
        if saved.get("is_downloaded") and saved.get("local_path") and Path(saved["local_path"]).is_file():
            existing_fmt = (saved.get("file_format") or "").lower()
            if existing_fmt == fmt.lower():
                job = {
                    "track_id": track_id,
                    "title": saved["title"],
                    "artist": saved["artist"],
                    "cover_url": saved.get("cover_url", ""),
                    "format": existing_fmt,
                    "bitrate": bitrate,
                    "status": "completed",
                    "progress": 100,
                    "message": "Listo para reproducir en cualquier dispositivo",
                    "file_path": saved["local_path"],
                    "file_name": Path(saved["local_path"]).name,
                    "file_size": saved.get("file_size", 0),
                    "started_at": time.time(),
                }
                self.jobs[track_id] = job
                return job

        # Already active?
        active = self.jobs.get(track_id)
        if active and active.get("status") in ("queued", "downloading", "converting", "tagging"):
            return active

        job = {
            "track_id": track_id,
            "title": saved["title"],
            "artist": saved["artist"],
            "cover_url": saved.get("cover_url", ""),
            "format": fmt.lower() if fmt.lower() in ("mp3", "m4a") else "mp3",
            "bitrate": bitrate if bitrate in ("128", "192", "256", "320") else "320",
            "status": "queued",
            "progress": 2,
            "message": "En cola...",
            "file_path": "",
            "file_name": "",
            "file_size": 0,
            "started_at": time.time(),
        }
        self.jobs[track_id] = job
        asyncio.create_task(self._run_download(saved, job))
        return job

    async def _run_download(self, track: dict[str, Any], job: dict[str, Any]) -> None:
        async with self._semaphore:
            try:
                await asyncio.to_thread(self._download_sync, track, job)
            except Exception as exc:
                job["status"] = "error"
                job["message"] = f"Error al descargar: {exc}"

    def _download_cover_jpeg(self, cover_url: str) -> bytes | None:
        if not cover_url or not cover_url.startswith("http"):
            return None
        try:
            with httpx.Client(timeout=10.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True) as client:
                resp = client.get(cover_url)
                if resp.status_code != 200 or not resp.content:
                    return None
                img = Image.open(io.BytesIO(resp.content)).convert("RGB")
                img.thumbnail((800, 800), Image.Resampling.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=90)
                return buf.getvalue()
        except Exception:
            return None

    def _embed_metadata(
        self, file_path: Path, fmt: str, track: dict[str, Any], cover_bytes: bytes | None
    ) -> None:
        title = track.get("title") or "Sin título"
        artist = track.get("artist") or "Artista desconocido"
        album = track.get("album") or "DSoundPro"

        if fmt == "mp3":
            audio = MP3(str(file_path))
            try:
                audio.add_tags()
            except ID3Error:
                pass
            tags: ID3 = audio.tags  # type: ignore[assignment]
            tags.delall("APIC")
            tags.add(TIT2(encoding=3, text=title))
            tags.add(TPE1(encoding=3, text=artist))
            tags.add(TALB(encoding=3, text=album))
            tags.add(COMM(encoding=3, lang="spa", desc="Source", text="Descargado con DSoundPro"))
            if cover_bytes:
                tags.add(
                    APIC(
                        encoding=3,
                        mime="image/jpeg",
                        type=3,
                        desc="Cover",
                        data=cover_bytes,
                    )
                )
            audio.save(v2_version=3)  # ID3v2.3 = maximum compatibility with car stereos, Windows, Android, iOS
        elif fmt == "m4a":
            audio_mp4 = MP4(str(file_path))
            audio_mp4["\xa9nam"] = [title]
            audio_mp4["\xa9ART"] = [artist]
            audio_mp4["\xa9alb"] = [album]
            audio_mp4["\xa9cmt"] = ["Descargado con DSoundPro"]
            if cover_bytes:
                audio_mp4["covr"] = [MP4Cover(cover_bytes, imageformat=MP4Cover.FORMAT_JPEG)]
            audio_mp4.save()

    def _download_sync(self, track: dict[str, Any], job: dict[str, Any]) -> None:
        track_id = track["id"]
        fmt = job["format"]
        bitrate = job["bitrate"]
        ffmpeg_exe = get_ffmpeg_path()

        job["status"] = "downloading"
        job["progress"] = 8
        job["message"] = "Buscando audio de alta calidad..."

        youtube_id = (track.get("youtube_id") or "").strip()
        if not youtube_id and track_id.startswith("yt_"):
            youtube_id = track_id[3:]

        target = (
            f"https://www.youtube.com/watch?v={youtube_id}"
            if youtube_id
            else f"ytsearch1:{track.get('artist', '')} - {track.get('title', '')} official audio"
        )

        safe_name = sanitize_filename(f"{track.get('artist', 'Artista')} - {track.get('title', 'Cancion')}")
        final_path = DOWNLOADS_DIR / f"{safe_name}.{fmt}"

        with tempfile.TemporaryDirectory(prefix="dsoundpro_dl_") as tmp_dir:
            tmp_template = str(Path(tmp_dir) / "raw.%(ext)s")

            def _progress_hook(d: dict[str, Any]) -> None:
                if d.get("status") == "downloading":
                    total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                    downloaded = d.get("downloaded_bytes") or 0
                    if total > 0:
                        pct = int(10 + (downloaded / total) * 62)
                        job["progress"] = min(72, max(10, pct))
                    job["message"] = "Descargando audio..."
                elif d.get("status") == "finished":
                    job["progress"] = 75

            opts = {
                "format": "bestaudio[ext=m4a]/bestaudio/best",
                "outtmpl": tmp_template,
                "quiet": True,
                "no_warnings": True,
                "noplaylist": True,
                "geo_bypass": True,
                "progress_hooks": [_progress_hook],
            }

            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(target, download=True)
                if info and "entries" in info:
                    entries = [e for e in (info.get("entries") or []) if e]
                    info = entries[0] if entries else None
                if info and info.get("id"):
                    self.db.set_track_youtube_id(
                        track_id, str(info["id"]), int(info.get("duration") or 0)
                    )

            raw_files = list(Path(tmp_dir).glob("raw.*"))
            if not raw_files:
                raise RuntimeError("No se pudo descargar el archivo de audio.")
            raw_file = raw_files[0]

            # Convert to universal MP3 or M4A with ffmpeg
            job["status"] = "converting"
            job["progress"] = 80
            job["message"] = f"Convirtiendo a {fmt.upper()} ({bitrate} kbps)..."

            tmp_out = Path(tmp_dir) / f"converted.{fmt}"
            if fmt == "mp3":
                cmd = [
                    ffmpeg_exe,
                    "-y",
                    "-i",
                    str(raw_file),
                    "-vn",
                    "-acodec",
                    "libmp3lame",
                    "-b:a",
                    f"{bitrate}k",
                    "-ar",
                    "44100",
                    "-ac",
                    "2",
                    str(tmp_out),
                ]
            else:
                cmd = [
                    ffmpeg_exe,
                    "-y",
                    "-i",
                    str(raw_file),
                    "-vn",
                    "-acodec",
                    "aac",
                    "-b:a",
                    f"{bitrate}k",
                    "-movflags",
                    "+faststart",
                    str(tmp_out),
                ]

            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if proc.returncode != 0 or not tmp_out.is_file():
                raise RuntimeError("Error en conversión de audio con FFmpeg.")

            # Embed ID3 / MP4 metadata & album art for universal player support
            job["status"] = "tagging"
            job["progress"] = 92
            job["message"] = "Incrustando portada y metadatos..."
            cover_bytes = self._download_cover_jpeg(track.get("cover_url") or "")
            try:
                self._embed_metadata(tmp_out, fmt, track, cover_bytes)
            except Exception:
                pass

            shutil.move(str(tmp_out), str(final_path))
            size = final_path.stat().st_size
            self.db.mark_track_downloaded(track_id, str(final_path), fmt, size)

            job["status"] = "completed"
            job["progress"] = 100
            job["message"] = f"Guardado ({fmt.upper()} {bitrate} kbps)"
            job["file_path"] = str(final_path)
            job["file_name"] = final_path.name
            job["file_size"] = size
