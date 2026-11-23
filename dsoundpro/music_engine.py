"""Music Discovery, Full-Audio Stream Resolution, and Synced Lyrics Engine."""

from __future__ import annotations

import asyncio
import hashlib
import re
import time
from typing import Any
from urllib.parse import quote

import httpx
import yt_dlp

from .database import Database

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

GENRE_CARDS = [
    {"id": "latin", "name": "Reggaetón & Urbano", "query": "reggaeton hits 2025", "color": "#e11d48", "accent": "#fb7185"},
    {"id": "pop", "name": "Pop Global", "query": "top pop hits", "color": "#8b5cf6", "accent": "#c084fc"},
    {"id": "rock", "name": "Rock & Alternativo", "query": "best rock classics", "color": "#dc2626", "accent": "#f87171"},
    {"id": "electronic", "name": "Electrónica & House", "query": "deep house electronic mix", "color": "#0891b2", "accent": "#22d3ee"},
    {"id": "hiphop", "name": "Hip-Hop & Trap", "query": "hip hop rap hits", "color": "#d97706", "accent": "#fbbf24"},
    {"id": "lofi", "name": "Lo-Fi & Estudio", "query": "lofi chill beats", "color": "#4f46e5", "accent": "#818cf8"},
    {"id": "salsa", "name": "Salsa & Bachata", "query": "salsa romantica bachata", "color": "#ea580c", "accent": "#fb923c"},
    {"id": "indie", "name": "Indie & Chill", "query": "indie chill vibes", "color": "#059669", "accent": "#34d399"},
    {"id": "workout", "name": "Entrenamiento", "query": "workout gym motivation music", "color": "#be123c", "accent": "#f43f5e"},
    {"id": "classics", "name": "Clásicos 80s & 90s", "query": "80s 90s greatest hits", "color": "#0284c7", "accent": "#38bdf8"},
    {"id": "acoustic", "name": "Acústico", "query": "acoustic guitar covers", "color": "#65a30d", "accent": "#a3e635"},
    {"id": "soundtracks", "name": "Cine & Gaming", "query": "epic movie soundtrack ost", "color": "#7c3aed", "accent": "#a78bfa"},
]

CURATED_MIXES = [
    {
        "id": "mix-top-global",
        "title": "Top Éxitos Mundiales",
        "subtitle": "Las canciones más escuchadas hoy en todo el planeta",
        "query": "top hits 2025",
        "gradient": "linear-gradient(135deg, #1ed760 0%, #0f5132 100%)",
    },
    {
        "id": "mix-latino",
        "title": "Vibras Latinas",
        "subtitle": "Reggaetón, pop latino y ritmos que prenden el día",
        "query": "bad bunny karol g feid rauw alejandro",
        "gradient": "linear-gradient(135deg, #f43f5e 0%, #881337 100%)",
    },
    {
        "id": "mix-focus",
        "title": "Deep Focus & Coding",
        "subtitle": "Instrumentales, synthwave y lo-fi para concentrarte al 100%",
        "query": "lofi synthwave chill instrumental",
        "gradient": "linear-gradient(135deg, #6366f1 0%, #1e1b4b 100%)",
    },
    {
        "id": "mix-rock",
        "title": "Leyendas del Rock",
        "subtitle": "Guitarras inolvidables de todas las décadas",
        "query": "queen arctic monkeys coldplay linkin park",
        "gradient": "linear-gradient(135deg, #f97316 0%, #7c2d12 100%)",
    },
]

_LRC_LINE_RE = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)")


def _make_track_id(prefix: str, raw_key: str) -> str:
    digest = hashlib.sha1(raw_key.encode("utf-8")).hexdigest()[:14]
    return f"{prefix}_{digest}"


class MusicEngine:
    """Handles catalog discovery, YouTube full-stream resolution, and synced lyrics."""

    def __init__(self, db: Database) -> None:
        self.db = db
        # Cache of resolved direct stream URLs: track_id -> {url, mime, expires_at, youtube_id, headers}
        self._stream_cache: dict[str, dict[str, Any]] = {}
        # Cache of home charts: {data, expires_at}
        self._home_cache: dict[str, Any] = {}
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        )

    async def close(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------------
    # Catalog & Charts (Deezer + iTunes + yt-dlp fallback)
    # ------------------------------------------------------------------

    def _normalize_deezer_track(self, item: dict[str, Any]) -> dict[str, Any]:
        album = item.get("album") or {}
        artist = item.get("artist") or {}
        cover = (
            album.get("cover_xl")
            or album.get("cover_big")
            or album.get("cover_medium")
            or artist.get("picture_big")
            or ""
        )
        return {
            "id": f"dz_{item['id']}",
            "title": item.get("title_short") or item.get("title") or "Sin título",
            "artist": artist.get("name") or "Artista desconocido",
            "album": album.get("title") or "Single",
            "duration": int(item.get("duration") or 0),
            "cover_url": cover,
            "source": "deezer",
            "youtube_id": "",
            "preview_url": item.get("preview") or "",
        }

    def _normalize_itunes_track(self, item: dict[str, Any]) -> dict[str, Any]:
        art = (item.get("artworkUrl100") or "").replace("100x100bb", "600x600bb")
        tid = str(item.get("trackId") or _make_track_id("it", f"{item.get('artistName')}-{item.get('trackName')}"))
        return {
            "id": f"it_{tid}",
            "title": item.get("trackName") or "Sin título",
            "artist": item.get("artistName") or "Artista desconocido",
            "album": item.get("collectionName") or "Single",
            "duration": int((item.get("trackTimeMillis") or 0) // 1000),
            "cover_url": art,
            "source": "itunes",
            "youtube_id": "",
            "preview_url": item.get("previewUrl") or "",
        }

    async def _deezer_get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        try:
            resp = await self._http.get(f"https://api.deezer.com{path}", params=params)
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, dict) and "error" not in data:
                    return data
        except Exception:
            pass
        return None

    async def _itunes_search(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        try:
            resp = await self._http.get(
                "https://itunes.apple.com/search",
                params={"term": query, "media": "music", "entity": "song", "limit": limit},
            )
            if resp.status_code == 200:
                items = resp.json().get("results") or []
                return [self._normalize_itunes_track(x) for x in items if x.get("trackName")]
        except Exception:
            pass
        return []

    async def _ytdlp_search(self, query: str, limit: int = 12) -> list[dict[str, Any]]:
        """Direct YouTube search via yt-dlp (supports URLs and niche songs/remixes)."""
        is_url = query.startswith("http://") or query.startswith("https://")
        target = query if is_url else f"ytsearch{limit}:{query}"

        def _run() -> list[dict[str, Any]]:
            opts = {
                "quiet": True,
                "no_warnings": True,
                "extract_flat": "in_playlist",
                "skip_download": True,
                "noplaylist": not is_url,
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(target, download=False)
                if not info:
                    return []
                entries = info.get("entries") if "entries" in info else [info]
                results: list[dict[str, Any]] = []
                for e in entries or []:
                    if not e or not e.get("id"):
                        continue
                    vid = str(e["id"])
                    raw_title = (e.get("title") or "Sin título").strip()
                    channel = (e.get("channel") or e.get("uploader") or "YouTube").replace(" - Topic", "").strip()
                    # Try splitting "Artist - Song"
                    artist, title = channel, raw_title
                    if " - " in raw_title and len(raw_title.split(" - ", 1)[0]) < 45:
                        parts = raw_title.split(" - ", 1)
                        artist, title = parts[0].strip(), parts[1].strip()
                    thumbs = e.get("thumbnails") or []
                    cover = ""
                    if thumbs:
                        cover = thumbs[-1].get("url") or ""
                    if not cover:
                        cover = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                    results.append(
                        {
                            "id": f"yt_{vid}",
                            "title": title,
                            "artist": artist,
                            "album": "YouTube Music",
                            "duration": int(e.get("duration") or 0),
                            "cover_url": cover,
                            "source": "youtube",
                            "youtube_id": vid,
                            "preview_url": "",
                        }
                    )
                return results

        try:
            return await asyncio.to_thread(_run)
        except Exception:
            return []

    async def search(self, query: str, mode: str = "all", limit: int = 24) -> dict[str, Any]:
        """Search tracks & artists across catalog (Deezer/iTunes) and/or YouTube directly."""
        q = (query or "").strip()
        if not q:
            return {"tracks": [], "artists": [], "query": ""}

        is_url = q.startswith("http://") or q.startswith("https://")
        if is_url or mode == "youtube":
            yt_tracks = await self._ytdlp_search(q, limit=min(limit, 15))
            return {
                "tracks": self.db.enrich_tracks_with_flags(yt_tracks),
                "artists": [],
                "query": q,
                "mode": "youtube",
            }

        # Fast catalog search via Deezer (tracks + artists in parallel)
        dz_tracks_task = self._deezer_get("/search/track", {"q": q, "limit": limit})
        dz_artists_task = self._deezer_get("/search/artist", {"q": q, "limit": 8})
        dz_tracks_data, dz_artists_data = await asyncio.gather(dz_tracks_task, dz_artists_task)

        tracks: list[dict[str, Any]] = []
        artists: list[dict[str, Any]] = []

        if dz_tracks_data and dz_tracks_data.get("data"):
            tracks = [self._normalize_deezer_track(x) for x in dz_tracks_data["data"]]
        else:
            tracks = await self._itunes_search(q, limit=limit)

        if dz_artists_data and dz_artists_data.get("data"):
            for a in dz_artists_data["data"][:8]:
                artists.append(
                    {
                        "id": str(a.get("id")),
                        "name": a.get("name") or "",
                        "picture_url": a.get("picture_big") or a.get("picture_medium") or "",
                        "fans": int(a.get("nb_fan") or 0),
                    }
                )

        # Fallback to yt-dlp if catalog returned nothing
        if not tracks:
            tracks = await self._ytdlp_search(q, limit=12)

        return {
            "tracks": self.db.enrich_tracks_with_flags(tracks),
            "artists": artists,
            "query": q,
            "mode": "catalog",
        }

    async def get_home_feed(self) -> dict[str, Any]:
        """Return personalized home sections: recently played, global charts, artists, genres, mixes."""
        now = time.time()
        cached = self._home_cache.get("data")
        if not cached or now > self._home_cache.get("expires_at", 0):
            chart_data = await self._deezer_get("/chart/0", {"limit": 24})
            trending: list[dict[str, Any]] = []
            top_artists: list[dict[str, Any]] = []
            if chart_data:
                for t in (chart_data.get("tracks") or {}).get("data") or []:
                    trending.append(self._normalize_deezer_track(t))
                for a in ((chart_data.get("artists") or {}).get("data") or [])[:12]:
                    top_artists.append(
                        {
                            "id": str(a.get("id")),
                            "name": a.get("name") or "",
                            "picture_url": a.get("picture_big") or a.get("picture_medium") or "",
                            "fans": int(a.get("nb_fan") or 0),
                        }
                    )
            if not trending:
                trending = await self._itunes_search("top hits 2025", limit=20)

            cached = {"trending": trending, "top_artists": top_artists}
            self._home_cache = {"data": cached, "expires_at": now + 900}

        return {
            "recently_played": self.db.get_recently_played(12),
            "most_played": self.db.get_most_played(10),
            "trending": self.db.enrich_tracks_with_flags(cached["trending"]),
            "top_artists": cached["top_artists"],
            "genres": GENRE_CARDS,
            "curated_mixes": CURATED_MIXES,
            "playlists": self.db.list_playlists(),
        }

    # ------------------------------------------------------------------
    # Full-Length Audio Stream Resolution (via yt-dlp)
    # ------------------------------------------------------------------

    def _resolve_yt_audio_sync(self, query_or_id: str, is_video_id: bool) -> dict[str, Any]:
        target = f"https://www.youtube.com/watch?v={query_or_id}" if is_video_id else f"ytsearch1:{query_or_id}"
        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio[acodec=opus]/bestaudio/best",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "skip_download": True,
            "geo_bypass": True,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(target, download=False)
            if not info:
                raise RuntimeError("No se encontró fuente de audio.")
            if "entries" in info:
                entries = [e for e in (info.get("entries") or []) if e]
                if not entries:
                    raise RuntimeError("Sin resultados de audio.")
                info = entries[0]

            stream_url = info.get("url")
            ext = (info.get("ext") or "m4a").lower()
            mime_map = {
                "m4a": "audio/mp4",
                "mp4": "audio/mp4",
                "webm": "audio/webm",
                "opus": "audio/webm",
                "mp3": "audio/mpeg",
                "ogg": "audio/ogg",
            }
            if not stream_url:
                # Pick best audio-only format manually
                fmts = [f for f in (info.get("formats") or []) if f.get("url") and f.get("acodec") != "none"]
                audio_only = [f for f in fmts if f.get("vcodec") in (None, "none")]
                chosen = (audio_only or fmts)[-1]
                stream_url = chosen["url"]
                ext = (chosen.get("ext") or "m4a").lower()

            return {
                "url": stream_url,
                "mime": mime_map.get(ext, "audio/mp4"),
                "youtube_id": str(info.get("id") or ""),
                "duration": int(info.get("duration") or 0),
                "headers": info.get("http_headers") or {"User-Agent": USER_AGENT},
                "expires_at": time.time() + 5400,  # 90 min
            }

    async def resolve_stream(self, track: dict[str, Any]) -> dict[str, Any]:
        """Resolve a streamable full-length audio URL for the given track."""
        track_id = str(track["id"])
        cached = self._stream_cache.get(track_id)
        if cached and time.time() < cached["expires_at"]:
            return cached

        youtube_id = (track.get("youtube_id") or "").strip()
        if not youtube_id and track_id.startswith("yt_"):
            youtube_id = track_id[3:]

        try:
            if youtube_id:
                resolved = await asyncio.to_thread(self._resolve_yt_audio_sync, youtube_id, True)
            else:
                search_query = f"{track.get('artist', '')} - {track.get('title', '')} official audio".strip()
                resolved = await asyncio.to_thread(self._resolve_yt_audio_sync, search_query, False)

            if resolved.get("youtube_id"):
                self.db.set_track_youtube_id(
                    track_id, resolved["youtube_id"], resolved.get("duration", 0)
                )
            self._stream_cache[track_id] = resolved
            return resolved
        except Exception as exc:
            # Graceful fallback to preview URL if full stream couldn't resolve
            preview = track.get("preview_url") or ""
            if preview:
                return {
                    "url": preview,
                    "mime": "audio/mpeg",
                    "youtube_id": youtube_id,
                    "duration": 30,
                    "headers": {"User-Agent": USER_AGENT},
                    "expires_at": time.time() + 600,
                    "is_preview_fallback": True,
                }
            raise RuntimeError(f"No se pudo obtener el audio: {exc}") from exc

    def invalidate_stream_cache(self, track_id: str) -> None:
        self._stream_cache.pop(track_id, None)

    # ------------------------------------------------------------------
    # Synced & Plain Lyrics (LRCLIB)
    # ------------------------------------------------------------------

    @staticmethod
    def parse_lrc(lrc_text: str) -> list[dict[str, Any]]:
        lines: list[dict[str, Any]] = []
        for raw in (lrc_text or "").splitlines():
            m = _LRC_LINE_RE.match(raw.strip())
            if m:
                mins = int(m.group(1))
                secs = float(m.group(2))
                text = m.group(3).strip()
                if text:
                    lines.append({"time": round(mins * 60 + secs, 2), "text": text})
        lines.sort(key=lambda x: x["time"])
        return lines

    async def get_lyrics(self, track: dict[str, Any]) -> dict[str, Any]:
        """Fetch synced LRC or plain lyrics via LRCLIB with SQLite caching."""
        track_id = str(track["id"])
        cached = self.db.get_cached_lyrics(track_id)
        if cached is not None:
            synced_lines = self.parse_lrc(cached.get("synced_lyrics") or "")
            return {
                "track_id": track_id,
                "synced": synced_lines,
                "plain": cached.get("plain_lyrics") or "",
                "found": bool(synced_lines or cached.get("plain_lyrics")),
            }

        title = re.sub(r"\s*[\(\[].*?[\)\]]", "", track.get("title") or "").strip()
        artist = (track.get("artist") or "").split(",")[0].strip()

        synced_raw = ""
        plain_raw = ""

        try:
            resp = await self._http.get(
                "https://lrclib.net/api/get",
                params={"artist_name": artist, "track_name": title},
                timeout=8.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                synced_raw = data.get("syncedLyrics") or ""
                plain_raw = data.get("plainLyrics") or ""
        except Exception:
            pass

        if not synced_raw and not plain_raw:
            try:
                q = quote(f"{artist} {title}".strip())
                resp = await self._http.get(f"https://lrclib.net/api/search?q={q}", timeout=8.0)
                if resp.status_code == 200:
                    items = resp.json()
                    if isinstance(items, list) and items:
                        best = next((i for i in items if i.get("syncedLyrics")), items[0])
                        synced_raw = best.get("syncedLyrics") or ""
                        plain_raw = best.get("plainLyrics") or ""
            except Exception:
                pass

        if synced_raw or plain_raw:
            self.db.save_cached_lyrics(track_id, synced_raw, plain_raw)

        synced_lines = self.parse_lrc(synced_raw)
        return {
            "track_id": track_id,
            "synced": synced_lines,
            "plain": plain_raw,
            "found": bool(synced_lines or plain_raw),
        }
