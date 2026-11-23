"""SQLite persistence layer for DSoundPro."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .config import DB_PATH, ensure_directories

_DB_LOCK = threading.RLock()


class Database:
    """Thread-safe SQLite database for tracks, playlists, likes, history, downloads, and settings."""

    def __init__(self, db_path: Path = DB_PATH) -> None:
        ensure_directories()
        self.db_path = db_path
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def _init_schema(self) -> None:
        with _DB_LOCK, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS tracks (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    artist TEXT NOT NULL,
                    album TEXT DEFAULT '',
                    duration INTEGER DEFAULT 0,
                    cover_url TEXT DEFAULT '',
                    source TEXT DEFAULT 'online',
                    youtube_id TEXT DEFAULT '',
                    preview_url TEXT DEFAULT '',
                    local_path TEXT DEFAULT '',
                    file_format TEXT DEFAULT '',
                    file_size INTEGER DEFAULT 0,
                    is_downloaded INTEGER DEFAULT 0,
                    is_local_import INTEGER DEFAULT 0,
                    play_count INTEGER DEFAULT 0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS likes (
                    track_id TEXT PRIMARY KEY,
                    liked_at REAL NOT NULL,
                    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS playlists (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    cover_gradient TEXT DEFAULT 'linear-gradient(135deg, #1ed760 0%, #0d5c2e 100%)',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS playlist_tracks (
                    playlist_id TEXT NOT NULL,
                    track_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    added_at REAL NOT NULL,
                    PRIMARY KEY (playlist_id, track_id),
                    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS play_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    track_id TEXT NOT NULL,
                    played_at REAL NOT NULL,
                    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS lyrics_cache (
                    track_id TEXT PRIMARY KEY,
                    synced_lyrics TEXT DEFAULT '',
                    plain_lyrics TEXT DEFAULT '',
                    fetched_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_history_played_at ON play_history(played_at DESC);
                CREATE INDEX IF NOT EXISTS idx_tracks_downloaded ON tracks(is_downloaded);
                CREATE INDEX IF NOT EXISTS idx_playlist_pos ON playlist_tracks(playlist_id, position);
                """
            )
            # Default starter playlists if none exist
            count = conn.execute("SELECT COUNT(*) FROM playlists").fetchone()[0]
            if count == 0:
                now = time.time()
                starter_playlists = [
                    (
                        "pl-favorites-mix",
                        "Mi Mix Diario",
                        "Tus canciones guardadas para cualquier momento del día.",
                        "linear-gradient(135deg, #1ed760 0%, #0e7a57 55%, #121212 100%)",
                        now,
                        now,
                    ),
                    (
                        "pl-focus-mode",
                        "Modo Enfoque & Chill",
                        "Beats suaves y música ideal para estudiar o programar.",
                        "linear-gradient(135deg, #6366f1 0%, #3b0764 100%)",
                        now,
                        now,
                    ),
                ]
                conn.executemany(
                    """
                    INSERT OR IGNORE INTO playlists (id, name, description, cover_gradient, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    starter_playlists,
                )

    def _row_to_track(self, row: sqlite3.Row, liked_ids: set[str] | None = None) -> dict[str, Any]:
        d = dict(row)
        local_path = d.get("local_path") or ""
        file_exists = bool(local_path and Path(local_path).is_file())
        d["is_downloaded"] = bool(d.get("is_downloaded") and file_exists)
        d["is_local_import"] = bool(d.get("is_local_import") and file_exists)
        d["has_local_file"] = file_exists
        if liked_ids is not None:
            d["is_liked"] = d["id"] in liked_ids
        return d

    def get_liked_ids(self) -> set[str]:
        with _DB_LOCK, self._connect() as conn:
            rows = conn.execute("SELECT track_id FROM likes").fetchall()
            return {r["track_id"] for r in rows}

    def upsert_track(self, track: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        track_id = str(track["id"])
        with _DB_LOCK, self._connect() as conn:
            existing = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
            if existing:
                conn.execute(
                    """
                    UPDATE tracks SET
                        title = COALESCE(NULLIF(?, ''), title),
                        artist = COALESCE(NULLIF(?, ''), artist),
                        album = COALESCE(NULLIF(?, ''), album),
                        duration = CASE WHEN ? > 0 THEN ? ELSE duration END,
                        cover_url = COALESCE(NULLIF(?, ''), cover_url),
                        youtube_id = COALESCE(NULLIF(?, ''), youtube_id),
                        preview_url = COALESCE(NULLIF(?, ''), preview_url),
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        track.get("title", ""),
                        track.get("artist", ""),
                        track.get("album", ""),
                        int(track.get("duration") or 0),
                        int(track.get("duration") or 0),
                        track.get("cover_url", ""),
                        track.get("youtube_id", ""),
                        track.get("preview_url", ""),
                        now,
                        track_id,
                    ),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO tracks (
                        id, title, artist, album, duration, cover_url, source,
                        youtube_id, preview_url, local_path, file_format, file_size,
                        is_downloaded, is_local_import, play_count, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                    """,
                    (
                        track_id,
                        track.get("title") or "Sin título",
                        track.get("artist") or "Artista desconocido",
                        track.get("album") or "",
                        int(track.get("duration") or 0),
                        track.get("cover_url") or "",
                        track.get("source") or "online",
                        track.get("youtube_id") or "",
                        track.get("preview_url") or "",
                        track.get("local_path") or "",
                        track.get("file_format") or "",
                        int(track.get("file_size") or 0),
                        1 if track.get("is_downloaded") else 0,
                        1 if track.get("is_local_import") else 0,
                        now,
                        now,
                    ),
                )
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
            liked_ids = self.get_liked_ids()
            return self._row_to_track(row, liked_ids)

    def get_track(self, track_id: str) -> dict[str, Any] | None:
        with _DB_LOCK, self._connect() as conn:
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
            if not row:
                return None
            return self._row_to_track(row, self.get_liked_ids())

    def set_track_youtube_id(self, track_id: str, youtube_id: str, duration: int = 0) -> None:
        now = time.time()
        with _DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                UPDATE tracks
                SET youtube_id = ?,
                    duration = CASE WHEN ? > 0 AND duration = 0 THEN ? ELSE duration END,
                    updated_at = ?
                WHERE id = ?
                """,
                (youtube_id, duration, duration, now, track_id),
            )

    def mark_track_downloaded(
        self, track_id: str, local_path: str, file_format: str, file_size: int
    ) -> dict[str, Any] | None:
        now = time.time()
        with _DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                UPDATE tracks
                SET local_path = ?, file_format = ?, file_size = ?,
                    is_downloaded = 1, updated_at = ?
                WHERE id = ?
                """,
                (local_path, file_format, file_size, now, track_id),
            )
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
            return self._row_to_track(row, self.get_liked_ids()) if row else None

    def remove_download_flag(self, track_id: str) -> None:
        now = time.time()
        with _DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                UPDATE tracks
                SET local_path = '', file_format = '', file_size = 0,
                    is_downloaded = 0, updated_at = ?
                WHERE id = ?
                """,
                (now, track_id),
            )

    def delete_local_track(self, track_id: str) -> None:
        with _DB_LOCK, self._connect() as conn:
            conn.execute("DELETE FROM tracks WHERE id = ? AND is_local_import = 1", (track_id,))

    def get_downloaded_tracks(self) -> list[dict[str, Any]]:
        with _DB_LOCK, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM tracks
                WHERE is_downloaded = 1 OR is_local_import = 1
                ORDER BY updated_at DESC
                """
            ).fetchall()
            liked_ids = self.get_liked_ids()
            tracks = []
            for r in rows:
                t = self._row_to_track(r, liked_ids)
                if t["has_local_file"]:
                    tracks.append(t)
            return tracks

    def toggle_like(self, track: dict[str, Any]) -> bool:
        saved = self.upsert_track(track)
        track_id = saved["id"]
        with _DB_LOCK, self._connect() as conn:
            existing = conn.execute("SELECT 1 FROM likes WHERE track_id = ?", (track_id,)).fetchone()
            if existing:
                conn.execute("DELETE FROM likes WHERE track_id = ?", (track_id,))
                return False
            conn.execute(
                "INSERT INTO likes (track_id, liked_at) VALUES (?, ?)",
                (track_id, time.time()),
            )
            return True

    def get_liked_tracks(self) -> list[dict[str, Any]]:
        with _DB_LOCK, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT t.* FROM tracks t
                INNER JOIN likes l ON l.track_id = t.id
                ORDER BY l.liked_at DESC
                """
            ).fetchall()
            liked_ids = self.get_liked_ids()
            return [self._row_to_track(r, liked_ids) for r in rows]

    def record_play(self, track: dict[str, Any]) -> dict[str, Any]:
        saved = self.upsert_track(track)
        track_id = saved["id"]
        now = time.time()
        with _DB_LOCK, self._connect() as conn:
            conn.execute(
                "INSERT INTO play_history (track_id, played_at) VALUES (?, ?)",
                (track_id, now),
            )
            conn.execute(
                "UPDATE tracks SET play_count = play_count + 1, updated_at = ? WHERE id = ?",
                (now, track_id),
            )
            # Keep history tidy (latest 200 entries)
            conn.execute(
                """
                DELETE FROM play_history WHERE id NOT IN (
                    SELECT id FROM play_history ORDER BY played_at DESC LIMIT 200
                )
                """
            )
        return self.get_track(track_id) or saved

    def get_recently_played(self, limit: int = 16) -> list[dict[str, Any]]:
        with _DB_LOCK, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT t.*, MAX(h.played_at) AS last_played
                FROM play_history h
                INNER JOIN tracks t ON t.id = h.track_id
                GROUP BY t.id
                ORDER BY last_played DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            liked_ids = self.get_liked_ids()
            return [self._row_to_track(r, liked_ids) for r in rows]

    def get_most_played(self, limit: int = 12) -> list[dict[str, Any]]:
        with _DB_LOCK, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM tracks
                WHERE play_count > 0
                ORDER BY play_count DESC, updated_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            liked_ids = self.get_liked_ids()
            return [self._row_to_track(r, liked_ids) for r in rows]

    # --- Playlists ---

    def list_playlists(self) -> list[dict[str, Any]]:
        with _DB_LOCK, self._connect() as conn:
            rows = conn.execute("SELECT * FROM playlists ORDER BY created_at DESC").fetchall()
            result = []
            for r in rows:
                pl = dict(r)
                stats = conn.execute(
                    """
                    SELECT COUNT(*) AS cnt,
                           (SELECT t.cover_url FROM playlist_tracks pt2
                            JOIN tracks t ON t.id = pt2.track_id
                            WHERE pt2.playlist_id = ? AND t.cover_url != ''
                            ORDER BY pt2.position ASC LIMIT 1) AS first_cover
                    FROM playlist_tracks WHERE playlist_id = ?
                    """,
                    (pl["id"], pl["id"]),
                ).fetchone()
                pl["track_count"] = stats["cnt"] if stats else 0
                pl["cover_url"] = (stats["first_cover"] or "") if stats else ""
                result.append(pl)
            return result

    def create_playlist(
        self, name: str, description: str = "", cover_gradient: str = ""
    ) -> dict[str, Any]:
        pl_id = f"pl-{uuid.uuid4().hex[:10]}"
        now = time.time()
        gradients = [
            "linear-gradient(135deg, #1ed760 0%, #0d5c2e 100%)",
            "linear-gradient(135deg, #ec4899 0%, #6d28d9 100%)",
            "linear-gradient(135deg, #06b6d4 0%, #1d4ed8 100%)",
            "linear-gradient(135deg, #f97316 0%, #b91c1c 100%)",
            "linear-gradient(135deg, #a855f7 0%, #3b0764 100%)",
        ]
        grad = cover_gradient or gradients[int(now) % len(gradients)]
        with _DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO playlists (id, name, description, cover_gradient, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (pl_id, name.strip() or "Nueva Playlist", description.strip(), grad, now, now),
            )
        return self.get_playlist(pl_id)  # type: ignore[return-value]

    def get_playlist(self, playlist_id: str) -> dict[str, Any] | None:
        with _DB_LOCK, self._connect() as conn:
            row = conn.execute("SELECT * FROM playlists WHERE id = ?", (playlist_id,)).fetchone()
            if not row:
                return None
            pl = dict(row)
            track_rows = conn.execute(
                """
                SELECT t.*, pt.added_at FROM playlist_tracks pt
                INNER JOIN tracks t ON t.id = pt.track_id
                WHERE pt.playlist_id = ?
                ORDER BY pt.position ASC, pt.added_at ASC
                """,
                (playlist_id,),
            ).fetchall()
            liked_ids = self.get_liked_ids()
            tracks = [self._row_to_track(r, liked_ids) for r in track_rows]
            pl["tracks"] = tracks
            pl["track_count"] = len(tracks)
            pl["cover_url"] = next((t["cover_url"] for t in tracks if t.get("cover_url")), "")
            return pl

    def update_playlist(self, playlist_id: str, name: str, description: str) -> dict[str, Any] | None:
        now = time.time()
        with _DB_LOCK, self._connect() as conn:
            conn.execute(
                "UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                (name.strip(), description.strip(), now, playlist_id),
            )
        return self.get_playlist(playlist_id)

    def delete_playlist(self, playlist_id: str) -> bool:
        with _DB_LOCK, self._connect() as conn:
            cur = conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
            return cur.rowcount > 0

    def add_track_to_playlist(self, playlist_id: str, track: dict[str, Any]) -> dict[str, Any] | None:
        saved = self.upsert_track(track)
        now = time.time()
        with _DB_LOCK, self._connect() as conn:
            pos_row = conn.execute(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM playlist_tracks WHERE playlist_id = ?",
                (playlist_id,),
            ).fetchone()
            pos = int(pos_row[0]) if pos_row else 1
            conn.execute(
                """
                INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at)
                VALUES (?, ?, ?, ?)
                """,
                (playlist_id, saved["id"], pos, now),
            )
            conn.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (now, playlist_id))
        return self.get_playlist(playlist_id)

    def remove_track_from_playlist(self, playlist_id: str, track_id: str) -> dict[str, Any] | None:
        with _DB_LOCK, self._connect() as conn:
            conn.execute(
                "DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
                (playlist_id, track_id),
            )
            conn.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (time.time(), playlist_id))
        return self.get_playlist(playlist_id)

    # --- Lyrics cache ---

    def get_cached_lyrics(self, track_id: str) -> dict[str, Any] | None:
        with _DB_LOCK, self._connect() as conn:
            row = conn.execute(
                "SELECT synced_lyrics, plain_lyrics FROM lyrics_cache WHERE track_id = ?",
                (track_id,),
            ).fetchone()
            return dict(row) if row else None

    def save_cached_lyrics(self, track_id: str, synced: str, plain: str) -> None:
        with _DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO lyrics_cache (track_id, synced_lyrics, plain_lyrics, fetched_at)
                VALUES (?, ?, ?, ?)
                """,
                (track_id, synced, plain, time.time()),
            )

    # --- Settings ---

    def get_settings(self) -> dict[str, Any]:
        defaults: dict[str, Any] = {
            "download_format": "mp3",
            "download_bitrate": "320",
            "eq_preset": "Flat",
            "eq_gains": [0, 0, 0, 0, 0],
            "crossfade": False,
        }
        with _DB_LOCK, self._connect() as conn:
            rows = conn.execute("SELECT key, value FROM settings").fetchall()
            for r in rows:
                try:
                    defaults[r["key"]] = json.loads(r["value"])
                except Exception:
                    defaults[r["key"]] = r["value"]
        return defaults

    def save_settings(self, updates: dict[str, Any]) -> dict[str, Any]:
        with _DB_LOCK, self._connect() as conn:
            for k, v in updates.items():
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    (k, json.dumps(v)),
                )
        return self.get_settings()

    def enrich_tracks_with_flags(self, tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Attach is_liked and is_downloaded status from local DB onto catalog/search results."""
        if not tracks:
            return []
        liked_ids = self.get_liked_ids()
        ids = [str(t["id"]) for t in tracks]
        placeholders = ",".join("?" for _ in ids)
        local_map: dict[str, dict[str, Any]] = {}
        with _DB_LOCK, self._connect() as conn:
            rows = conn.execute(
                f"SELECT id, local_path, file_format, file_size, is_downloaded, youtube_id FROM tracks WHERE id IN ({placeholders})",
                ids,
            ).fetchall()
            for r in rows:
                local_map[r["id"]] = dict(r)

        enriched = []
        for t in tracks:
            item = dict(t)
            tid = str(item["id"])
            item["is_liked"] = tid in liked_ids
            saved = local_map.get(tid)
            if saved:
                lp = saved.get("local_path") or ""
                exists = bool(lp and Path(lp).is_file())
                item["is_downloaded"] = bool(saved.get("is_downloaded") and exists)
                item["has_local_file"] = exists
                item["file_format"] = saved.get("file_format") or ""
                item["file_size"] = saved.get("file_size") or 0
                if not item.get("youtube_id") and saved.get("youtube_id"):
                    item["youtube_id"] = saved["youtube_id"]
            else:
                item.setdefault("is_downloaded", False)
                item.setdefault("has_local_file", False)
            enriched.append(item)
        return enriched
