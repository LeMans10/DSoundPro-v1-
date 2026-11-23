"""FastAPI backend server for DSoundPro (REST API, Range Audio Streaming, MP3 Downloads, QR Pairing, PWA)."""

from __future__ import annotations

import hashlib
import io
import mimetypes
import os
import subprocess
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import qrcode
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from mutagen import File as MutagenFile
from pydantic import BaseModel, Field

from . import __version__
from .config import (
    COVERS_DIR,
    DEFAULT_PORT,
    DOWNLOADS_DIR,
    STATIC_DIR,
    UPLOADS_DIR,
    ensure_directories,
    get_local_ip,
    sanitize_filename,
)
from .database import Database
from .downloader import DownloadManager
from .music_engine import MusicEngine

ensure_directories()

db = Database()
engine = MusicEngine(db)
downloader = DownloadManager(db)

AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".aac", ".webm"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_directories()
    _scan_downloads_folder_sync()
    yield
    await engine.close()


app = FastAPI(title="DSoundPro API", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------------------------------------------
# Request Models
# ------------------------------------------------------------------


class TrackPayload(BaseModel):
    id: str
    title: str
    artist: str = "Artista desconocido"
    album: str = ""
    duration: int = 0
    cover_url: str = ""
    source: str = "online"
    youtube_id: str = ""
    preview_url: str = ""


class DownloadRequest(BaseModel):
    track: TrackPayload
    format: str = "mp3"
    bitrate: str = "320"


class PlaylistCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str = ""
    cover_gradient: str = ""


class PlaylistUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str = ""


class SettingsUpdate(BaseModel):
    download_format: str | None = None
    download_bitrate: str | None = None
    eq_preset: str | None = None
    eq_gains: list[float] | None = None
    crossfade: bool | None = None


# ------------------------------------------------------------------
# Helper: Extract tags & cover art from local audio files
# ------------------------------------------------------------------


def _extract_local_metadata(file_path: Path, track_id: str) -> dict[str, Any]:
    title = file_path.stem
    artist = "Música Local"
    album = "Archivo Local"
    duration = 0
    cover_url = ""

    if " - " in title:
        parts = title.split(" - ", 1)
        artist, title = parts[0].strip(), parts[1].strip()

    try:
        audio = MutagenFile(str(file_path))
        if audio is not None:
            if getattr(audio, "info", None) and getattr(audio.info, "length", None):
                duration = int(audio.info.length)
            tags = audio.tags
            if tags:
                # ID3 (MP3)
                if "TIT2" in tags:
                    title = str(tags["TIT2"])
                elif "\xa9nam" in tags:
                    title = str(tags["\xa9nam"][0])
                elif "title" in tags:
                    title = str(tags["title"][0])

                if "TPE1" in tags:
                    artist = str(tags["TPE1"])
                elif "\xa9ART" in tags:
                    artist = str(tags["\xa9ART"][0])
                elif "artist" in tags:
                    artist = str(tags["artist"][0])

                if "TALB" in tags:
                    album = str(tags["TALB"])
                elif "\xa9alb" in tags:
                    album = str(tags["\xa9alb"][0])
                elif "album" in tags:
                    album = str(tags["album"][0])

                # Embedded cover art
                art_bytes: bytes | None = None
                for key in list(tags.keys()):
                    if key.startswith("APIC"):
                        art_bytes = tags[key].data
                        break
                if art_bytes is None and "covr" in tags and tags["covr"]:
                    art_bytes = bytes(tags["covr"][0])
                if art_bytes is None and hasattr(audio, "pictures") and audio.pictures:
                    art_bytes = audio.pictures[0].data

                if art_bytes:
                    cover_file = COVERS_DIR / f"{track_id}.jpg"
                    cover_file.write_bytes(art_bytes)
                    cover_url = f"/api/covers/{cover_file.name}"
    except Exception:
        pass

    return {
        "id": track_id,
        "title": title,
        "artist": artist,
        "album": album,
        "duration": duration,
        "cover_url": cover_url,
        "source": "local",
        "local_path": str(file_path),
        "file_format": file_path.suffix.lstrip(".").lower(),
        "file_size": file_path.stat().st_size,
        "is_downloaded": True,
        "is_local_import": True,
    }


def _scan_downloads_folder_sync() -> int:
    """Register any manually placed audio files in downloads/ so they appear in DSoundPro."""
    existing_paths = {
        Path(t["local_path"]).resolve()
        for t in db.get_downloaded_tracks()
        if t.get("local_path") and Path(t["local_path"]).exists()
    }
    added = 0
    for f in DOWNLOADS_DIR.iterdir():
        if f.is_file() and f.suffix.lower() in AUDIO_EXTS:
            if f.resolve() in existing_paths:
                continue
            tid = "loc_" + hashlib.sha1(str(f.resolve()).encode("utf-8")).hexdigest()[:12]
            meta = _extract_local_metadata(f, tid)
            meta["is_local_import"] = False
            meta["is_downloaded"] = True
            db.upsert_track(meta)
            added += 1
    return added


# ------------------------------------------------------------------
# Core Discovery & Search Endpoints
# ------------------------------------------------------------------


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "app": "DSoundPro", "version": __version__}


@app.get("/api/home")
async def api_home() -> dict[str, Any]:
    return await engine.get_home_feed()


@app.get("/api/search")
async def api_search(
    q: str = Query(..., min_length=1),
    mode: str = Query("all"),
    limit: int = Query(24, ge=1, le=40),
) -> dict[str, Any]:
    return await engine.search(q, mode=mode, limit=limit)


# ------------------------------------------------------------------
# Track Registration, History, Likes, Lyrics
# ------------------------------------------------------------------


@app.post("/api/tracks/play")
async def api_record_play(track: TrackPayload) -> dict[str, Any]:
    saved = db.record_play(track.model_dump())
    return {"track": saved}


@app.post("/api/tracks/prepare")
async def api_prepare_track(track: TrackPayload) -> dict[str, Any]:
    """Ensure a track is persisted in SQLite before streaming or downloading."""
    saved = db.upsert_track(track.model_dump())
    return {"track": saved}


@app.get("/api/likes")
async def api_get_likes() -> dict[str, Any]:
    return {"tracks": db.get_liked_tracks()}


@app.post("/api/likes/toggle")
async def api_toggle_like(track: TrackPayload) -> dict[str, Any]:
    liked = db.toggle_like(track.model_dump())
    return {"track_id": track.id, "is_liked": liked}


@app.get("/api/history")
async def api_get_history() -> dict[str, Any]:
    return {
        "recently_played": db.get_recently_played(30),
        "most_played": db.get_most_played(16),
    }


@app.get("/api/lyrics/{track_id}")
async def api_lyrics(
    track_id: str,
    title: str = Query(""),
    artist: str = Query(""),
) -> dict[str, Any]:
    track = db.get_track(track_id) or {"id": track_id, "title": title, "artist": artist}
    if title and not track.get("title"):
        track["title"] = title
    if artist and not track.get("artist"):
        track["artist"] = artist
    return await engine.get_lyrics(track)


# ------------------------------------------------------------------
# Audio Streaming Proxy (Local + Online Full-Length with Range Support)
# ------------------------------------------------------------------


@app.get("/api/stream/{track_id}")
async def api_stream_track(track_id: str, request: Request):
    track = db.get_track(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Canción no encontrada.")

    # 1. Serve immediately from disk if downloaded or locally imported
    local_path = track.get("local_path") or ""
    if local_path and Path(local_path).is_file():
        mime, _ = mimetypes.guess_type(local_path)
        return FileResponse(
            path=local_path,
            media_type=mime or "audio/mpeg",
            headers={"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600"},
        )

    # 2. Resolve online full-length stream and proxy with HTTP Range support
    try:
        resolved = await engine.resolve_stream(track)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    range_header = request.headers.get("range")
    upstream_headers = dict(resolved.get("headers") or {})
    if range_header:
        upstream_headers["Range"] = range_header

    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0), follow_redirects=True)
    req = client.build_request("GET", resolved["url"], headers=upstream_headers)
    upstream = await client.send(req, stream=True)

    # Retry once if cached URL expired (403/410)
    if upstream.status_code in (403, 410):
        await upstream.aclose()
        engine.invalidate_stream_cache(track_id)
        try:
            resolved = await engine.resolve_stream(track)
            upstream_headers = dict(resolved.get("headers") or {})
            if range_header:
                upstream_headers["Range"] = range_header
            req = client.build_request("GET", resolved["url"], headers=upstream_headers)
            upstream = await client.send(req, stream=True)
        except Exception as exc:
            await client.aclose()
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    if upstream.status_code >= 400:
        status_code = upstream.status_code
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"Fuente de audio respondió {status_code}")

    resp_headers: dict[str, str] = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
    }
    for h in ("content-length", "content-range"):
        val = upstream.headers.get(h)
        if val:
            resp_headers[h.title()] = val

    media_type = upstream.headers.get("content-type") or resolved.get("mime") or "audio/mp4"

    async def _body_iter():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        _body_iter(),
        status_code=upstream.status_code,
        media_type=media_type,
        headers=resp_headers,
    )


# ------------------------------------------------------------------
# Downloads (Universal MP3/M4A for External Players & Mobile)
# ------------------------------------------------------------------


@app.post("/api/downloads/start")
async def api_start_download(payload: DownloadRequest) -> dict[str, Any]:
    job = await downloader.enqueue_download(
        payload.track.model_dump(),
        fmt=payload.format,
        bitrate=payload.bitrate,
    )
    return {"job": job}


@app.get("/api/downloads")
async def api_list_downloads() -> dict[str, Any]:
    _scan_downloads_folder_sync()
    return {
        "tracks": db.get_downloaded_tracks(),
        "jobs": downloader.get_all_jobs(),
        "downloads_dir": str(DOWNLOADS_DIR),
    }


@app.get("/api/downloads/status/{track_id}")
async def api_download_status(track_id: str) -> dict[str, Any]:
    job = downloader.get_job(track_id)
    track = db.get_track(track_id)
    return {"job": job, "track": track}


@app.get("/api/downloads/{track_id}/file")
async def api_download_file(track_id: str):
    """Serve the downloaded MP3/M4A as a browser/mobile attachment for external players."""
    track = db.get_track(track_id)
    if not track or not track.get("local_path"):
        raise HTTPException(status_code=404, detail="Archivo no descargado todavía.")
    path = Path(track["local_path"])
    if not path.is_file():
        db.remove_download_flag(track_id)
        raise HTTPException(status_code=404, detail="El archivo ya no existe en disco.")

    mime, _ = mimetypes.guess_type(str(path))
    safe_ascii = sanitize_filename(path.stem).encode("ascii", "ignore").decode("ascii") or "track"
    ext = path.suffix.lower() or ".mp3"
    utf8_name = quote(path.name)
    return FileResponse(
        path=str(path),
        media_type=mime or "audio/mpeg",
        headers={
            "Content-Disposition": f"attachment; filename=\"{safe_ascii}{ext}\"; filename*=UTF-8''{utf8_name}"
        },
    )


@app.delete("/api/downloads/{track_id}")
async def api_delete_download(track_id: str) -> dict[str, Any]:
    track = db.get_track(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Canción no encontrada.")
    local_path = track.get("local_path") or ""
    if local_path:
        p = Path(local_path)
        if p.is_file():
            try:
                p.unlink()
            except OSError:
                pass
    if track.get("is_local_import"):
        db.delete_local_track(track_id)
    else:
        db.remove_download_flag(track_id)
    downloader.jobs.pop(track_id, None)
    return {"deleted": True, "track_id": track_id}


@app.post("/api/downloads/open-folder")
async def api_open_downloads_folder() -> dict[str, Any]:
    ensure_directories()
    folder = str(DOWNLOADS_DIR)
    try:
        if sys.platform.startswith("win"):
            os.startfile(folder)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", folder])
        else:
            subprocess.Popen(["xdg-open", folder])
        return {"opened": True, "path": folder}
    except Exception as exc:
        return {"opened": False, "path": folder, "error": str(exc)}


# ------------------------------------------------------------------
# Local Music Upload (Import MP3/M4A/WAV/FLAC from PC or Phone)
# ------------------------------------------------------------------


@app.post("/api/local/upload")
async def api_upload_local_audio(files: list[UploadFile] = File(...)) -> dict[str, Any]:
    ensure_directories()
    imported: list[dict[str, Any]] = []
    for file in files:
        orig_name = file.filename or "audio.mp3"
        ext = Path(orig_name).suffix.lower()
        if ext not in AUDIO_EXTS:
            continue
        track_id = f"imp_{uuid.uuid4().hex[:12]}"
        safe_stem = sanitize_filename(Path(orig_name).stem)
        dest = UPLOADS_DIR / f"{safe_stem}_{track_id[-4:]}{ext}"
        content = await file.read()
        dest.write_bytes(content)
        meta = _extract_local_metadata(dest, track_id)
        saved = db.upsert_track(meta)
        imported.append(saved)
    return {"imported": imported, "count": len(imported)}


@app.get("/api/covers/{filename}")
async def api_local_cover(filename: str):
    safe = Path(filename).name
    path = COVERS_DIR / safe
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Portada no encontrada.")
    return FileResponse(str(path), media_type="image/jpeg")


# ------------------------------------------------------------------
# Playlists CRUD
# ------------------------------------------------------------------


@app.get("/api/playlists")
async def api_list_playlists() -> dict[str, Any]:
    return {"playlists": db.list_playlists()}


@app.post("/api/playlists")
async def api_create_playlist(payload: PlaylistCreate) -> dict[str, Any]:
    pl = db.create_playlist(payload.name, payload.description, payload.cover_gradient)
    return {"playlist": pl}


@app.get("/api/playlists/{playlist_id}")
async def api_get_playlist(playlist_id: str) -> dict[str, Any]:
    pl = db.get_playlist(playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist no encontrada.")
    return {"playlist": pl}


@app.put("/api/playlists/{playlist_id}")
async def api_update_playlist(playlist_id: str, payload: PlaylistUpdate) -> dict[str, Any]:
    pl = db.update_playlist(playlist_id, payload.name, payload.description)
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist no encontrada.")
    return {"playlist": pl}


@app.delete("/api/playlists/{playlist_id}")
async def api_delete_playlist(playlist_id: str) -> dict[str, Any]:
    ok = db.delete_playlist(playlist_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Playlist no encontrada.")
    return {"deleted": True}


@app.post("/api/playlists/{playlist_id}/tracks")
async def api_add_playlist_track(playlist_id: str, track: TrackPayload) -> dict[str, Any]:
    pl = db.add_track_to_playlist(playlist_id, track.model_dump())
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist no encontrada.")
    return {"playlist": pl}


@app.delete("/api/playlists/{playlist_id}/tracks/{track_id}")
async def api_remove_playlist_track(playlist_id: str, track_id: str) -> dict[str, Any]:
    pl = db.remove_track_from_playlist(playlist_id, track_id)
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist no encontrada.")
    return {"playlist": pl}


# ------------------------------------------------------------------
# Settings & Mobile Companion QR Code
# ------------------------------------------------------------------


@app.get("/api/settings")
async def api_get_settings() -> dict[str, Any]:
    return {"settings": db.get_settings()}


@app.post("/api/settings")
async def api_save_settings(payload: SettingsUpdate) -> dict[str, Any]:
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    return {"settings": db.save_settings(updates)}


@app.get("/api/network/info")
async def api_network_info(request: Request) -> dict[str, Any]:
    port = request.url.port or DEFAULT_PORT
    local_ip = get_local_ip()
    return {
        "local_url": f"http://localhost:{port}",
        "mobile_url": f"http://{local_ip}:{port}",
        "ip": local_ip,
        "port": port,
        "downloads_dir": str(DOWNLOADS_DIR),
    }


@app.get("/api/network/qr")
async def api_network_qr(request: Request):
    port = request.url.port or DEFAULT_PORT
    local_ip = get_local_ip()
    url = f"http://{local_ip}:{port}"
    qr = qrcode.QRCode(version=1, box_size=8, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#1ed760", back_color="#121212")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


# ------------------------------------------------------------------
# PWA & Frontend SPA Hosting
# ------------------------------------------------------------------


@app.get("/manifest.json")
async def pwa_manifest():
    return FileResponse(str(STATIC_DIR / "manifest.json"), media_type="application/manifest+json")


@app.get("/sw.js")
async def pwa_sw():
    return FileResponse(
        str(STATIC_DIR / "sw.js"),
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    index_file = STATIC_DIR / "index.html"
    if not index_file.is_file():
        return JSONResponse({"message": "DSoundPro frontend aún no inicializado."})
    return FileResponse(str(index_file), media_type="text/html")
