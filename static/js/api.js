/* DSoundPro API Client */

const API = {
  async request(url, options = {}) {
    const resp = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    if (!resp.ok) {
      let msg = `Error ${resp.status}`;
      try {
        const data = await resp.json();
        if (data.detail) msg = data.detail;
      } catch (_) {}
      throw new Error(msg);
    }
    return resp.json();
  },

  getHome() {
    return this.request("/api/home");
  },

  search(q, mode = "all") {
    return this.request(`/api/search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}`);
  },

  prepareTrack(track) {
    return this.request("/api/tracks/prepare", {
      method: "POST",
      body: JSON.stringify(track),
    });
  },

  recordPlay(track) {
    return this.request("/api/tracks/play", {
      method: "POST",
      body: JSON.stringify(track),
    });
  },

  getLikes() {
    return this.request("/api/likes");
  },

  toggleLike(track) {
    return this.request("/api/likes/toggle", {
      method: "POST",
      body: JSON.stringify(track),
    });
  },

  getHistory() {
    return this.request("/api/history");
  },

  getLyrics(track) {
    return this.request(
      `/api/lyrics/${encodeURIComponent(track.id)}?title=${encodeURIComponent(track.title || "")}&artist=${encodeURIComponent(track.artist || "")}`
    );
  },

  // Playlists
  getPlaylists() {
    return this.request("/api/playlists");
  },

  getPlaylist(id) {
    return this.request(`/api/playlists/${encodeURIComponent(id)}`);
  },

  createPlaylist(name, description = "") {
    return this.request("/api/playlists", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    });
  },

  updatePlaylist(id, name, description = "") {
    return this.request(`/api/playlists/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ name, description }),
    });
  },

  deletePlaylist(id) {
    return this.request(`/api/playlists/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  addTrackToPlaylist(playlistId, track) {
    return this.request(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: "POST",
      body: JSON.stringify(track),
    });
  },

  removeTrackFromPlaylist(playlistId, trackId) {
    return this.request(
      `/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`,
      { method: "DELETE" }
    );
  },

  // Downloads
  getDownloads() {
    return this.request("/api/downloads");
  },

  startDownload(track, format = "mp3", bitrate = "320") {
    return this.request("/api/downloads/start", {
      method: "POST",
      body: JSON.stringify({ track, format, bitrate }),
    });
  },

  deleteDownload(trackId) {
    return this.request(`/api/downloads/${encodeURIComponent(trackId)}`, {
      method: "DELETE",
    });
  },

  openDownloadsFolder() {
    return this.request("/api/downloads/open-folder", { method: "POST" });
  },

  async uploadLocalFiles(fileList) {
    const fd = new FormData();
    for (const f of fileList) fd.append("files", f);
    const resp = await fetch("/api/local/upload", { method: "POST", body: fd });
    if (!resp.ok) throw new Error("Error subiendo archivos locales");
    return resp.json();
  },

  // Settings & Network
  getSettings() {
    return this.request("/api/settings");
  },

  saveSettings(data) {
    return this.request("/api/settings", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  getNetworkInfo() {
    return this.request("/api/network/info");
  },
};
