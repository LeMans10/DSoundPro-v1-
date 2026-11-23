/* ==========================================================================
   DSoundPro — Full Spotify-Grade SPA Controller (Desktop + Mobile)
   ========================================================================== */

const FALLBACK_COVER = "/static/icons/icon-192.png";

const state = {
  view: "home",
  viewHistory: [],
  activePlaylistId: null,
  libraryTab: "likes",
  searchQuery: "",
  searchMode: "all", // "all" | "youtube"
  searchResults: null,
  homeData: null,
  playlists: [],
  likedIds: new Set(),
  likedTracks: [],
  downloadedTracks: [],
  downloadJobs: [],
  settings: {
    download_format: "mp3",
    download_bitrate: "320",
    eq_preset: "Flat",
    eq_gains: [0, 0, 0, 0, 0],
  },

  // Player state
  queue: [],
  queueIndex: -1,
  currentTrack: null,
  isPlaying: false,
  isBuffering: false,
  shuffle: false,
  repeatMode: "off", // "off" | "all" | "one"
  isMuted: false,
  lastVolume: 0.85,

  // Lyrics state
  lyrics: { trackId: null, synced: [], plain: "", found: false, loading: false },
  activeLyricIdx: -1,

  // Panels
  rightOpen: false,
  rightTab: "queue",
  fsOpen: false,
  fsMode: "player",

  // Track registry for clean DOM click delegation
  trackMap: new Map(),
};

const audioEngine = new AudioEngine();
const audio = audioEngine.audio;
let dlPollTimer = null;
let searchDebounce = null;
let isSeeking = false;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

function fmtBytes(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Buenos días";
  if (h < 19) return "Buenas tardes";
  return "Buenas noches";
}

function registerTrack(track) {
  if (!track || !track.id) return track;
  state.trackMap.set(track.id, track);
  return track;
}

function showToast(msg) {
  const wrap = $("#toast-container");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.25s";
    setTimeout(() => el.remove(), 260);
  }, 2900);
}

function updateSliderFill(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const val = Number(input.value) || 0;
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--pct", `${pct}%`);
}

function setAmbientFromTrack(track) {
  const palette = [
    "30, 215, 96",
    "99, 102, 241",
    "236, 72, 153",
    "6, 182, 212",
    "249, 115, 22",
    "168, 85, 247",
    "225, 29, 72",
  ];
  const seed = (track?.title || "DSoundPro")
    .split("")
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const rgb = palette[seed % palette.length];
  document.documentElement.style.setProperty("--ambient-rgb", rgb);
}

// --------------------------------------------------------------------------
// Initialization & Data Sync
// --------------------------------------------------------------------------

async function initApp() {
  registerServiceWorker();
  bindGlobalEvents();
  bindAudioEvents();
  audioEngine.registerVisualizer($("#fs-visualizer"));

  try {
    const [homeData, likesRes, dlRes, settingsRes] = await Promise.all([
      API.getHome(),
      API.getLikes(),
      API.getDownloads(),
      API.getSettings(),
    ]);
    state.homeData = homeData;
    state.playlists = homeData.playlists || [];
    state.likedTracks = likesRes.tracks || [];
    state.likedIds = new Set(state.likedTracks.map((t) => t.id));
    state.downloadedTracks = dlRes.tracks || [];
    state.downloadJobs = dlRes.jobs || [];
    state.settings = { ...state.settings, ...(settingsRes.settings || {}) };

    // Apply saved EQ settings
    if (state.settings.eq_preset && EQ_PRESETS[state.settings.eq_preset]) {
      audioEngine.applyPreset(state.settings.eq_preset);
    } else if (Array.isArray(state.settings.eq_gains)) {
      state.settings.eq_gains.forEach((g, i) => audioEngine.setBandGain(i, g));
    }

    renderSidebarPlaylists();
    updateDownloadBadge();
    renderCurrentView();
    maybeStartDownloadPolling();
  } catch (err) {
    $("#main-content").innerHTML = `
      <div class="empty-state">
        <h3>No se pudo conectar con el servidor DSoundPro</h3>
        <p>${esc(err.message)}</p>
        <button class="pill-btn accent-pill" onclick="location.reload()">Reintentar</button>
      </div>`;
  }
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

async function refreshSidebarAndMeta() {
  try {
    const [plRes, likesRes, dlRes] = await Promise.all([
      API.getPlaylists(),
      API.getLikes(),
      API.getDownloads(),
    ]);
    state.playlists = plRes.playlists || [];
    state.likedTracks = likesRes.tracks || [];
    state.likedIds = new Set(state.likedTracks.map((t) => t.id));
    state.downloadedTracks = dlRes.tracks || [];
    state.downloadJobs = dlRes.jobs || [];
    renderSidebarPlaylists();
    updateDownloadBadge();
  } catch (_) {}
}

function updateDownloadBadge() {
  const badge = $("#nav-dl-badge");
  const activeCount = state.downloadJobs.filter((j) =>
    ["queued", "downloading", "converting", "tagging"].includes(j.status)
  ).length;
  const total = activeCount > 0 ? activeCount : state.downloadedTracks.length;
  if (total > 0) {
    badge.hidden = false;
    badge.textContent = activeCount > 0 ? `${activeCount}↓` : String(total);
  } else {
    badge.hidden = true;
  }
}

function renderSidebarPlaylists() {
  $("#sidebar-likes-count").textContent = `${state.likedTracks.length} canciones`;
  const list = $("#sidebar-playlists");
  list.innerHTML = state.playlists
    .map((pl) => {
      const active = state.view === "playlist" && state.activePlaylistId === pl.id ? "active" : "";
      const art = pl.cover_url
        ? `<img src="${esc(pl.cover_url)}" alt="" />`
        : `<span style="color:#fff">♫</span>`;
      return `
        <button class="playlist-mini-item ${active}" data-open-playlist="${esc(pl.id)}">
          <div class="playlist-mini-art" style="background:${esc(pl.cover_gradient || "#222")}">${art}</div>
          <div class="playlist-mini-meta">
            <span class="playlist-mini-title">${esc(pl.name)}</span>
            <span class="playlist-mini-sub">Playlist • ${pl.track_count || 0} canciones</span>
          </div>
        </button>`;
    })
    .join("");
}

// --------------------------------------------------------------------------
// Navigation & View Rendering
// --------------------------------------------------------------------------

function navigate(view, opts = {}) {
  if (!opts.skipHistory && (state.view !== view || opts.playlistId !== state.activePlaylistId)) {
    state.viewHistory.push({ view: state.view, playlistId: state.activePlaylistId });
    if (state.viewHistory.length > 25) state.viewHistory.shift();
  }
  state.view = view;
  if (opts.playlistId) state.activePlaylistId = opts.playlistId;

  $$(".nav-item, .mnav-item").forEach((el) => {
    const match = el.dataset.view === view || (view === "liked" && el.dataset.view === "library");
    el.classList.toggle("active", match);
  });
  renderSidebarPlaylists();
  renderCurrentView();
  $("#main-content").scrollTo({ top: 0, behavior: "instant" });
}

async function renderCurrentView() {
  const main = $("#main-content");
  if (state.view === "home") {
    renderHomeView(main);
  } else if (state.view === "search") {
    renderSearchView(main);
  } else if (state.view === "library") {
    await renderLibraryView(main);
  } else if (state.view === "liked") {
    await renderLikedView(main);
  } else if (state.view === "downloads") {
    await renderDownloadsView(main);
  } else if (state.view === "playlist") {
    await renderPlaylistView(main, state.activePlaylistId);
  }
}

// --- HOME VIEW ---
function renderHomeView(container) {
  const data = state.homeData;
  if (!data) return;

  const recent = data.recently_played || [];
  const trending = data.trending || [];
  const artists = data.top_artists || [];
  const mixes = data.curated_mixes || [];

  recent.forEach(registerTrack);
  trending.forEach(registerTrack);

  // Quick picks: liked + playlists + recent tracks (up to 6)
  const quickCards = [
    {
      title: "Tus Me Gusta",
      artHtml: `<div class="quick-card-art liked-art"><svg viewBox="0 0 24 24" fill="currentColor" style="width:24px;height:24px"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/></svg></div>`,
      attrs: `data-quick-view="liked"`,
    },
    {
      title: "Descargas Offline (MP3)",
      artHtml: `<div class="quick-card-art" style="background:linear-gradient(135deg,#1ed760,#0f5132)"><svg viewBox="0 0 24 24" fill="none" stroke="#08080a" stroke-width="2.4" style="width:26px;height:26px"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 19h16" stroke-linecap="round"/></svg></div>`,
      attrs: `data-quick-view="downloads"`,
    },
    ...state.playlists.slice(0, 2).map((pl) => ({
      title: pl.name,
      artHtml: pl.cover_url
        ? `<div class="quick-card-art"><img src="${esc(pl.cover_url)}" alt=""/></div>`
        : `<div class="quick-card-art" style="background:${esc(pl.cover_gradient)}"><span style="font-size:1.3rem">♫</span></div>`,
      attrs: `data-open-playlist="${esc(pl.id)}"`,
    })),
    ...recent.slice(0, 2).map((t) => ({
      title: t.title,
      artHtml: `<div class="quick-card-art"><img src="${esc(t.cover_url || FALLBACK_COVER)}" alt=""/></div>`,
      attrs: `data-play-track="${esc(t.id)}"`,
    })),
  ].slice(0, 6);

  container.innerHTML = `
    <div class="greeting-header">
      <div>
        <h1 class="greeting-title">${getGreeting()}</h1>
        <p class="greeting-sub">Escucha en streaming Hi-Fi o descarga tus canciones en MP3 para cualquier reproductor.</p>
      </div>
    </div>

    <div class="quick-grid">
      ${quickCards
        .map(
          (c) => `
        <div class="quick-card" ${c.attrs}>
          ${c.artHtml}
          <span class="quick-card-title">${esc(c.title)}</span>
          <span class="floating-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg></span>
        </div>`
        )
        .join("")}
    </div>

    ${
      recent.length
        ? `
      <section class="section-block">
        <div class="section-head">
          <h2 class="section-title">Escuchado recientemente</h2>
        </div>
        <div class="cards-grid">
          ${recent.slice(0, 8).map((t) => renderTrackCard(t, "recent")).join("")}
        </div>
      </section>`
        : ""
    }

    <section class="section-block">
      <div class="section-head">
        <h2 class="section-title">Mixes hechos para ti</h2>
      </div>
      <div class="mixes-grid">
        ${mixes
          .map(
            (m) => `
          <div class="mix-card" style="background:${esc(m.gradient)}" data-run-query="${esc(m.query)}">
            <h3>${esc(m.title)}</h3>
            <p>${esc(m.subtitle)}</p>
          </div>`
          )
          .join("")}
      </div>
    </section>

    <section class="section-block">
      <div class="section-head">
        <h2 class="section-title">Tendencias Globales</h2>
        <button class="section-link" id="btn-play-all-trending">Reproducir todo</button>
      </div>
      <div class="cards-grid">
        ${trending.slice(0, 12).map((t) => renderTrackCard(t, "trending")).join("")}
      </div>
    </section>

    ${
      artists.length
        ? `
      <section class="section-block">
        <div class="section-head">
          <h2 class="section-title">Artistas populares</h2>
        </div>
        <div class="cards-grid">
          ${artists
            .slice(0, 8)
            .map(
              (a) => `
            <div class="media-card" data-run-query="${esc(a.name)}">
              <div class="media-card-art round">
                <img src="${esc(a.picture_url || FALLBACK_COVER)}" alt="${esc(a.name)}" loading="lazy" />
                <span class="floating-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg></span>
              </div>
              <div class="media-card-title">${esc(a.name)}</div>
              <div class="media-card-sub">Artista</div>
            </div>`
            )
            .join("")}
        </div>
      </section>`
        : ""
    }
  `;

  const playTrendingBtn = $("#btn-play-all-trending", container);
  if (playTrendingBtn) {
    playTrendingBtn.onclick = () => {
      if (trending.length) playTrack(trending[0], trending);
    };
  }
}

function renderTrackCard(track, listKey = "") {
  const isLocal = track.is_downloaded || track.has_local_file;
  return `
    <div class="media-card" data-play-track="${esc(track.id)}" data-list-key="${esc(listKey)}" data-ctx-track="${esc(track.id)}">
      <div class="media-card-art">
        <img src="${esc(track.cover_url || FALLBACK_COVER)}" alt="${esc(track.title)}" loading="lazy" />
        ${isLocal ? `<span class="media-card-badge">MP3 ✓</span>` : ""}
        <span class="floating-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg></span>
      </div>
      <div class="media-card-title">${esc(track.title)}</div>
      <div class="media-card-sub">${esc(track.artist)}</div>
    </div>`;
}

// --- SEARCH VIEW ---
function renderSearchView(container) {
  const genres = state.homeData?.genres || [];
  const res = state.searchResults;

  const modeBar = `
    <div class="sub-tabs" style="margin-bottom:16px">
      <button class="sub-tab ${state.searchMode === "all" ? "active" : ""}" data-search-mode="all">Catálogo HD</button>
      <button class="sub-tab ${state.searchMode === "youtube" ? "active" : ""}" data-search-mode="youtube">YouTube / URL Directa</button>
    </div>`;

  if (!state.searchQuery) {
    container.innerHTML = `
      <div class="section-head"><h1 class="greeting-title">Explorar géneros</h1></div>
      ${modeBar}
      <p class="greeting-sub" style="margin-bottom:18px">Escribe el nombre de una canción, artista, álbum o pega un enlace de YouTube arriba.</p>
      <div class="genres-grid">
        ${genres
          .map(
            (g) => `
          <div class="genre-tile" style="background:linear-gradient(135deg, ${g.color}, ${g.accent})" data-run-query="${esc(g.query)}">
            <span>${esc(g.name)}</span>
          </div>`
          )
          .join("")}
      </div>`;
    return;
  }

  if (!res || res.loading) {
    container.innerHTML = `
      ${modeBar}
      <div class="loading-splash"><div class="spinner"></div><p>Buscando "${esc(state.searchQuery)}"...</p></div>`;
    return;
  }

  const tracks = res.tracks || [];
  const artists = res.artists || [];
  tracks.forEach(registerTrack);

  container.innerHTML = `
    <div class="section-head">
      <h1 class="section-title">Resultados para "${esc(state.searchQuery)}"</h1>
      ${tracks.length ? `<button class="pill-btn accent-pill" id="btn-play-search-all">Reproducir resultados</button>` : ""}
    </div>
    ${modeBar}
    ${
      artists.length
        ? `
      <section class="section-block">
        <h3 class="section-title" style="font-size:1.05rem;margin-bottom:12px">Artistas</h3>
        <div class="cards-grid">
          ${artists
            .slice(0, 6)
            .map(
              (a) => `
            <div class="media-card" data-run-query="${esc(a.name)}">
              <div class="media-card-art round">
                <img src="${esc(a.picture_url || FALLBACK_COVER)}" alt="${esc(a.name)}" loading="lazy" />
              </div>
              <div class="media-card-title">${esc(a.name)}</div>
              <div class="media-card-sub">Artista</div>
            </div>`
            )
            .join("")}
        </div>
      </section>`
        : ""
    }
    <section class="section-block">
      <h3 class="section-title" style="font-size:1.05rem;margin-bottom:10px">Canciones (${tracks.length})</h3>
      ${
        tracks.length
          ? `<div class="track-list">${tracks.map((t, i) => renderTrackRow(t, i, "search")).join("")}</div>`
          : `<div class="empty-state"><p>No encontramos canciones. Prueba cambiar a modo <strong>YouTube / URL Directa</strong> arriba.</p></div>`
      }
    </section>
  `;

  const playAllBtn = $("#btn-play-search-all", container);
  if (playAllBtn) {
    playAllBtn.onclick = () => playTrack(tracks[0], tracks);
  }
}

async function performSearch(query, mode = state.searchMode) {
  state.searchQuery = (query || "").trim();
  state.searchMode = mode;
  $("#global-search-input").value = state.searchQuery;
  $("#btn-clear-search").hidden = !state.searchQuery;

  if (state.view !== "search") {
    navigate("search");
  }
  if (!state.searchQuery) {
    state.searchResults = null;
    renderCurrentView();
    return;
  }

  state.searchResults = { loading: true, tracks: [], artists: [] };
  renderCurrentView();

  try {
    const data = await API.search(state.searchQuery, state.searchMode);
    state.searchResults = data;
    if (state.view === "search") renderCurrentView();
  } catch (err) {
    showToast(`Error en búsqueda: ${err.message}`);
    state.searchResults = { tracks: [], artists: [] };
    if (state.view === "search") renderCurrentView();
  }
}

// --- LIBRARY VIEW ---
async function renderLibraryView(container) {
  await refreshSidebarAndMeta();
  const histRes = await API.getHistory().catch(() => ({ recently_played: [], most_played: [] }));
  const recent = histRes.recently_played || [];
  const most = histRes.most_played || [];
  recent.forEach(registerTrack);
  most.forEach(registerTrack);
  state.likedTracks.forEach(registerTrack);

  let bodyHtml = "";
  if (state.libraryTab === "likes") {
    bodyHtml = state.likedTracks.length
      ? `<div class="track-list">${state.likedTracks.map((t, i) => renderTrackRow(t, i, "likes")).join("")}</div>`
      : `<div class="empty-state"><p>Aún no tienes canciones en Me Gusta. Toca el corazón ♥ en cualquier canción.</p></div>`;
  } else if (state.libraryTab === "playlists") {
    bodyHtml = `
      <div class="cards-grid">
        <div class="media-card" id="card-create-pl" style="border:1px dashed rgba(30,215,96,0.45);display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:210px;text-align:center">
          <div style="width:54px;height:54px;border-radius:50%;background:var(--accent-dim);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:1.8rem;margin-bottom:10px">+</div>
          <div class="media-card-title">Crear Playlist</div>
          <div class="media-card-sub">Organiza tu música</div>
        </div>
        ${state.playlists
          .map(
            (pl) => `
          <div class="media-card" data-open-playlist="${esc(pl.id)}">
            <div class="media-card-art" style="background:${esc(pl.cover_gradient)};display:flex;align-items:center;justify-content:center">
              ${pl.cover_url ? `<img src="${esc(pl.cover_url)}" alt="" />` : `<span style="font-size:3rem;opacity:0.7">♫</span>`}
              <span class="floating-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg></span>
            </div>
            <div class="media-card-title">${esc(pl.name)}</div>
            <div class="media-card-sub">${pl.track_count || 0} canciones</div>
          </div>`
          )
          .join("")}
      </div>`;
  } else {
    bodyHtml = `
      ${
        most.length
          ? `<h3 class="section-title" style="font-size:1.05rem;margin-bottom:10px">Tus más escuchadas</h3>
             <div class="track-list" style="margin-bottom:24px">${most.map((t, i) => renderTrackRow(t, i, "most")).join("")}</div>`
          : ""
      }
      <h3 class="section-title" style="font-size:1.05rem;margin-bottom:10px">Historial reciente</h3>
      ${
        recent.length
          ? `<div class="track-list">${recent.map((t, i) => renderTrackRow(t, i, "history")).join("")}</div>`
          : `<div class="empty-state"><p>Tu historial de reproducción aparecerá aquí.</p></div>`
      }`;
  }

  container.innerHTML = `
    <div class="section-head">
      <h1 class="greeting-title">Tu Biblioteca</h1>
      <button class="pill-btn accent-pill" id="btn-lib-new-pl">+ Nueva Playlist</button>
    </div>
    <div class="sub-tabs">
      <button class="sub-tab ${state.libraryTab === "likes" ? "active" : ""}" data-lib-tab="likes">Me Gusta (${state.likedTracks.length})</button>
      <button class="sub-tab ${state.libraryTab === "playlists" ? "active" : ""}" data-lib-tab="playlists">Playlists (${state.playlists.length})</button>
      <button class="sub-tab ${state.libraryTab === "history" ? "active" : ""}" data-lib-tab="history">Historial</button>
    </div>
    ${bodyHtml}
  `;

  state._tempLists = { likes: state.likedTracks, most, history: recent };
  const newPl = $("#btn-lib-new-pl", container);
  if (newPl) newPl.onclick = openCreatePlaylistModal;
  const cardPl = $("#card-create-pl", container);
  if (cardPl) cardPl.onclick = openCreatePlaylistModal;
}

// --- LIKED SONGS VIEW ---
async function renderLikedView(container) {
  await refreshSidebarAndMeta();
  state.likedTracks.forEach(registerTrack);
  state._tempLists = { likes: state.likedTracks };

  container.innerHTML = `
    <div class="view-hero" style="background:linear-gradient(135deg, rgba(79,70,229,0.55), rgba(147,51,234,0.35), rgba(18,18,22,0.95))">
      <div class="view-hero-art liked-art">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/></svg>
      </div>
      <div class="view-hero-meta">
        <span class="hero-kicker">COLECCIÓN PRIVADA</span>
        <h1 class="hero-title">Tus Me Gusta</h1>
        <p class="hero-desc">${state.likedTracks.length} canciones favoritas listas para reproducir o descargar en MP3.</p>
        <div class="hero-actions">
          <button class="pill-btn accent-pill" id="btn-play-likes">▶ Reproducir</button>
          <button class="pill-btn ghost-pill" id="btn-shuffle-likes">🔀 Aleatorio</button>
          ${state.likedTracks.length ? `<button class="pill-btn ghost-pill" id="btn-dl-all-likes">⬇ Descargar todas (MP3)</button>` : ""}
        </div>
      </div>
    </div>
    ${
      state.likedTracks.length
        ? `<div class="track-list">${state.likedTracks.map((t, i) => renderTrackRow(t, i, "likes")).join("")}</div>`
        : `<div class="empty-state"><p>Marca canciones con ♥ y aparecerán aquí al instante.</p></div>`
    }
  `;

  $("#btn-play-likes", container).onclick = () => {
    if (state.likedTracks.length) playTrack(state.likedTracks[0], state.likedTracks);
  };
  $("#btn-shuffle-likes", container).onclick = () => {
    if (state.likedTracks.length) {
      state.shuffle = true;
      updateTransportUI();
      const idx = Math.floor(Math.random() * state.likedTracks.length);
      playTrack(state.likedTracks[idx], state.likedTracks);
    }
  };
  const dlAll = $("#btn-dl-all-likes", container);
  if (dlAll) {
    dlAll.onclick = () => downloadBatch(state.likedTracks);
  }
}

// --- PLAYLIST DETAIL VIEW ---
async function renderPlaylistView(container, playlistId) {
  let pl;
  try {
    const res = await API.getPlaylist(playlistId);
    pl = res.playlist;
  } catch (err) {
    navigate("library");
    return;
  }

  const tracks = pl.tracks || [];
  tracks.forEach(registerTrack);
  state._tempLists = { playlist: tracks };

  container.innerHTML = `
    <div class="view-hero" style="background:linear-gradient(135deg, rgba(30,215,96,0.28), rgba(18,18,22,0.94))">
      <div class="view-hero-art" style="background:${esc(pl.cover_gradient)}">
        ${pl.cover_url ? `<img src="${esc(pl.cover_url)}" alt="" />` : `<span style="font-size:4rem">♫</span>`}
      </div>
      <div class="view-hero-meta">
        <span class="hero-kicker">PLAYLIST</span>
        <h1 class="hero-title">${esc(pl.name)}</h1>
        <p class="hero-desc">${esc(pl.description || "Tu playlist personalizada en DSoundPro")} • ${tracks.length} canciones</p>
        <div class="hero-actions">
          <button class="pill-btn accent-pill" id="btn-pl-play">▶ Reproducir</button>
          ${tracks.length ? `<button class="pill-btn ghost-pill" id="btn-pl-dl-all">⬇ Descargar Playlist (MP3)</button>` : ""}
          <button class="pill-btn ghost-pill" id="btn-pl-edit">✎ Editar</button>
          <button class="pill-btn danger-pill" id="btn-pl-delete">Eliminar</button>
        </div>
      </div>
    </div>
    ${
      tracks.length
        ? `<div class="track-list">${tracks.map((t, i) => renderTrackRow(t, i, "playlist", { playlistId: pl.id })).join("")}</div>`
        : `<div class="empty-state">
             <p>Esta playlist aún está vacía. Busca canciones y pulsa <strong>⋯ → Añadir a playlist</strong>.</p>
             <button class="pill-btn accent-pill" onclick="navigate('search')">Buscar música</button>
           </div>`
    }
  `;

  $("#btn-pl-play", container).onclick = () => {
    if (tracks.length) playTrack(tracks[0], tracks);
  };
  const dlBtn = $("#btn-pl-dl-all", container);
  if (dlBtn) dlBtn.onclick = () => downloadBatch(tracks);

  $("#btn-pl-edit", container).onclick = () => openEditPlaylistModal(pl);
  $("#btn-pl-delete", container).onclick = async () => {
    if (!confirm(`¿Eliminar la playlist "${pl.name}"?`)) return;
    await API.deletePlaylist(pl.id);
    showToast("Playlist eliminada");
    await refreshSidebarAndMeta();
    navigate("library");
  };
}

// --- DOWNLOADS VIEW (Universal Offline MP3/M4A Manager) ---
async function renderDownloadsView(container) {
  const res = await API.getDownloads();
  state.downloadedTracks = res.tracks || [];
  state.downloadJobs = res.jobs || [];
  state.downloadedTracks.forEach(registerTrack);
  state._tempLists = { downloads: state.downloadedTracks };
  updateDownloadBadge();

  const activeJobs = state.downloadJobs.filter((j) =>
    ["queued", "downloading", "converting", "tagging", "error"].includes(j.status)
  );

  container.innerHTML = `
    <div class="view-hero" style="background:linear-gradient(135deg, rgba(30,215,96,0.34), rgba(16,185,129,0.16), rgba(18,18,22,0.95))">
      <div class="view-hero-art" style="background:linear-gradient(135deg,#1ed760,#0d5c2e)">
        <svg viewBox="0 0 24 24" fill="none" stroke="#08080a" stroke-width="2.2"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 19h16" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="view-hero-meta">
        <span class="hero-kicker">DESCARGAS UNIVERSALES • SIN DRM</span>
        <h1 class="hero-title">Descargas &amp; Música Local</h1>
        <p class="hero-desc">Archivos estándar MP3/M4A con portada y metadatos ID3 incrustados. Úsalos en VLC, celulares, USB de auto o cualquier reproductor.</p>
        <div class="hero-actions">
          ${state.downloadedTracks.length ? `<button class="pill-btn accent-pill" id="btn-dl-play-all">▶ Reproducir Offline</button>` : ""}
          <button class="pill-btn ghost-pill" id="btn-dl-open-folder">📁 Abrir Carpeta en PC</button>
          <button class="pill-btn ghost-pill" id="btn-dl-upload">⬆ Importar MP3 / WAV</button>
        </div>
      </div>
    </div>

    <div class="dl-settings-bar">
      <div class="dl-setting-group">
        <strong>Formato universal:</strong>
        <select id="sel-dl-format" class="styled-select">
          <option value="mp3" ${state.settings.download_format === "mp3" ? "selected" : ""}>MP3 (100% compatible con todo)</option>
          <option value="m4a" ${state.settings.download_format === "m4a" ? "selected" : ""}>M4A AAC (Apple / Alta eficiencia)</option>
        </select>
        <select id="sel-dl-bitrate" class="styled-select">
          <option value="320" ${state.settings.download_bitrate === "320" ? "selected" : ""}>320 kbps (Calidad Estudio)</option>
          <option value="192" ${state.settings.download_bitrate === "192" ? "selected" : ""}>192 kbps (Equilibrado)</option>
          <option value="128" ${state.settings.download_bitrate === "128" ? "selected" : ""}>128 kbps (Ligero)</option>
        </select>
      </div>
      <div style="font-size:0.76rem;color:var(--text-muted)">
        Carpeta: <code>${esc(res.downloads_dir || "downloads/")}</code>
      </div>
    </div>

    ${
      activeJobs.length
        ? `
      <div class="jobs-list">
        ${activeJobs
          .map(
            (j) => `
          <div class="job-card ${j.status === "error" ? "error" : ""}">
            <img class="track-thumb" src="${esc(j.cover_url || FALLBACK_COVER)}" alt="" />
            <div class="job-info">
              <div class="track-row-title">${esc(j.title)} — <span style="color:var(--text-secondary)">${esc(j.artist)}</span></div>
              <div style="font-size:0.76rem;color:var(--text-secondary);margin-top:2px">${esc(j.message)} (${j.progress}%)</div>
              <div class="job-progress-bar"><div class="job-progress-fill" style="width:${j.progress}%"></div></div>
            </div>
          </div>`
          )
          .join("")}
      </div>`
        : ""
    }

    ${
      state.downloadedTracks.length
        ? `<div class="track-list">${state.downloadedTracks.map((t, i) => renderTrackRow(t, i, "downloads", { isDownloadsView: true })).join("")}</div>`
        : `<div class="empty-state">
             <p>Todavía no has descargado canciones. Pulsa el ícono <strong>⬇</strong> en cualquier canción para guardarla en MP3 con su portada.</p>
             <button class="pill-btn accent-pill" onclick="navigate('search')">Buscar canciones para descargar</button>
           </div>`
    }
  `;

  const playAll = $("#btn-dl-play-all", container);
  if (playAll) {
    playAll.onclick = () => playTrack(state.downloadedTracks[0], state.downloadedTracks);
  }
  $("#btn-dl-open-folder", container).onclick = async () => {
    const r = await API.openDownloadsFolder();
    showToast(r.opened ? "Carpeta de descargas abierta" : `Ruta: ${r.path}`);
  };
  $("#btn-dl-upload", container).onclick = () => $("#local-file-input").click();

  $("#sel-dl-format", container).onchange = async (e) => {
    state.settings.download_format = e.target.value;
    await API.saveSettings({ download_format: e.target.value });
    showToast(`Formato de descarga: ${e.target.value.toUpperCase()}`);
  };
  $("#sel-dl-bitrate", container).onchange = async (e) => {
    state.settings.download_bitrate = e.target.value;
    await API.saveSettings({ download_bitrate: e.target.value });
    showToast(`Calidad de descarga: ${e.target.value} kbps`);
  };
}

// --- REUSABLE TRACK ROW ---
function renderTrackRow(track, idx, listKey, extra = {}) {
  const isCurrent = state.currentTrack && state.currentTrack.id === track.id;
  const isLiked = state.likedIds.has(track.id) || track.is_liked;
  const isLocal = track.is_downloaded || track.has_local_file;
  const activeJob = state.downloadJobs.find(
    (j) => j.track_id === track.id && ["queued", "downloading", "converting", "tagging"].includes(j.status)
  );

  const numCell =
    isCurrent && state.isPlaying
      ? `<div class="eq-bars"><span></span><span></span><span></span></div>`
      : `<span>${idx + 1}</span>`;

  const downloadBtn = isLocal
    ? `<button class="icon-btn active" data-save-file="${esc(track.id)}" title="Guardar archivo ${esc((track.file_format || "MP3").toUpperCase())} en este dispositivo para otros reproductores">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
       </button>`
    : activeJob
    ? `<button class="icon-btn active" title="${esc(activeJob.message)} (${activeJob.progress}%)"><div class="mini-spinner" style="border-top-color:var(--accent);border-color:rgba(255,255,255,0.2)"></div></button>`
    : `<button class="icon-btn" data-dl-track="${esc(track.id)}" title="Descargar MP3 con portada y metadatos">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 19h16" stroke-linecap="round" stroke-linejoin="round"/></svg>
       </button>`;

  const extraBtn = extra.isDownloadsView
    ? `<button class="icon-btn" data-save-file="${esc(track.id)}" title="Descargar archivo a este dispositivo (Celular / PC)">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 19h16" stroke-linecap="round"/></svg>
       </button>
       <button class="icon-btn" data-del-dl="${esc(track.id)}" title="Eliminar descarga">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6" stroke-linecap="round"/></svg>
       </button>`
    : extra.playlistId
    ? `<button class="icon-btn" data-rm-pl-track="${esc(track.id)}" data-pl-id="${esc(extra.playlistId)}" title="Quitar de la playlist">&times;</button>`
    : "";

  return `
    <div class="track-row ${isCurrent ? "playing" : ""}" data-ctx-track="${esc(track.id)}">
      <div class="track-num">${numCell}</div>
      <div class="track-row-main" data-play-track="${esc(track.id)}" data-list-key="${esc(listKey)}">
        <img class="track-thumb" src="${esc(track.cover_url || FALLBACK_COVER)}" alt="" loading="lazy" />
        <div class="track-text">
          <div class="track-row-title">${esc(track.title)}</div>
          <div class="track-row-artist">
            ${isLocal ? `<span class="dl-pill">${esc(track.file_format || "MP3")} ${fmtBytes(track.file_size)}</span>` : ""}
            <span>${esc(track.artist)}</span>
          </div>
        </div>
      </div>
      <div class="track-album">${esc(track.album || "")}</div>
      <div class="track-actions">
        <button class="icon-btn ${isLiked ? "liked" : ""}" data-like-track="${esc(track.id)}" title="Me gusta">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/></svg>
        </button>
        ${extra.isDownloadsView ? extraBtn : `${downloadBtn}${extraBtn}`}
        <button class="icon-btn" data-open-ctx="${esc(track.id)}" title="Más opciones">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
        </button>
      </div>
      <div class="track-dur">${track.duration ? fmtTime(track.duration) : "—"}</div>
    </div>`;
}

// --------------------------------------------------------------------------
// Playback Engine & Queue Controller
// --------------------------------------------------------------------------

async function playTrack(track, contextList = null) {
  if (!track) return;
  registerTrack(track);

  if (Array.isArray(contextList) && contextList.length) {
    state.queue = contextList.map((t) => registerTrack(t));
    state.queueIndex = state.queue.findIndex((t) => t.id === track.id);
    if (state.queueIndex < 0) {
      state.queue.unshift(track);
      state.queueIndex = 0;
    }
  } else {
    const idx = state.queue.findIndex((t) => t.id === track.id);
    if (idx >= 0) {
      state.queueIndex = idx;
    } else {
      state.queue.splice(state.queueIndex + 1, 0, track);
      state.queueIndex = state.queueIndex + 1;
    }
  }

  state.currentTrack = track;
  state.isBuffering = true;
  state.isPlaying = false;
  setAmbientFromTrack(track);
  updatePlayerMetaUI();
  updatePlayPauseUI();
  highlightPlayingRows();
  renderRightPanelIfOpen();

  try {
    await API.prepareTrack(track);
    audioEngine.ensureGraph();
    audio.src = `/api/stream/${encodeURIComponent(track.id)}`;
    audio.playbackRate = audioEngine.playbackRate;
    await audio.play();
    API.recordPlay(track).catch(() => {});
    loadLyricsForTrack(track);
    audioEngine.updateMediaSession(track, {
      play: () => audio.play(),
      pause: () => audio.pause(),
      prev: playPrevious,
      next: playNext,
    });
  } catch (err) {
    state.isBuffering = false;
    updatePlayPauseUI();
    showToast(`No se pudo reproducir "${track.title}": ${err.message}`);
  }
}

function togglePlayPause() {
  if (!state.currentTrack) {
    const first = state.homeData?.trending?.[0] || state.downloadedTracks[0];
    if (first) playTrack(first, state.homeData?.trending || state.downloadedTracks);
    return;
  }
  audioEngine.ensureGraph();
  if (audio.paused) {
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
}

function playNext() {
  if (!state.queue.length) return;
  if (state.repeatMode === "one") {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  let nextIdx;
  if (state.shuffle && state.queue.length > 1) {
    do {
      nextIdx = Math.floor(Math.random() * state.queue.length);
    } while (nextIdx === state.queueIndex);
  } else {
    nextIdx = state.queueIndex + 1;
    if (nextIdx >= state.queue.length) {
      if (state.repeatMode === "all") nextIdx = 0;
      else return;
    }
  }
  state.queueIndex = nextIdx;
  playTrack(state.queue[nextIdx]);
}

function playPrevious() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  let prevIdx = state.queueIndex - 1;
  if (prevIdx < 0) prevIdx = state.repeatMode === "all" ? state.queue.length - 1 : 0;
  state.queueIndex = prevIdx;
  playTrack(state.queue[prevIdx]);
}

function addToQueue(track, playNextFlag = false) {
  registerTrack(track);
  if (playNextFlag) {
    state.queue.splice(state.queueIndex + 1, 0, track);
    showToast(`Siguiente: ${track.title}`);
  } else {
    state.queue.push(track);
    showToast(`Añadido a la cola: ${track.title}`);
  }
  renderRightPanelIfOpen();
}

function bindAudioEvents() {
  audio.addEventListener("playing", () => {
    state.isPlaying = true;
    state.isBuffering = false;
    updatePlayPauseUI();
    highlightPlayingRows();
  });

  audio.addEventListener("pause", () => {
    state.isPlaying = false;
    updatePlayPauseUI();
    highlightPlayingRows();
  });

  audio.addEventListener("waiting", () => {
    state.isBuffering = true;
    updatePlayPauseUI();
  });

  audio.addEventListener("canplay", () => {
    state.isBuffering = false;
    updatePlayPauseUI();
  });

  audio.addEventListener("timeupdate", () => {
    if (isSeeking) return;
    const cur = audio.currentTime || 0;
    const dur = Number.isFinite(audio.duration) ? audio.duration : state.currentTrack?.duration || 0;
    $("#time-current").textContent = fmtTime(cur);
    $("#time-duration").textContent = fmtTime(dur);
    $("#fs-time-current").textContent = fmtTime(cur);
    $("#fs-time-duration").textContent = fmtTime(dur);

    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    const s1 = $("#seek-slider");
    const s2 = $("#fs-seek-slider");
    s1.value = pct;
    s2.value = pct;
    updateSliderFill(s1);
    updateSliderFill(s2);
    $("#mini-progress-fill").style.width = `${pct}%`;

    syncActiveLyric(cur);
  });

  audio.addEventListener("ended", () => {
    if (audioEngine.sleepEndOfTrack) {
      audioEngine.sleepEndOfTrack = false;
      audioEngine.sleepLabel = "Apagado";
      showToast("Temporizador: reproducción pausada");
      renderRightPanelIfOpen();
      return;
    }
    playNext();
  });

  audio.addEventListener("error", () => {
    state.isBuffering = false;
    state.isPlaying = false;
    updatePlayPauseUI();
  });
}

function updatePlayerMetaUI() {
  const t = state.currentTrack;
  if (!t) return;
  const cover = t.cover_url || FALLBACK_COVER;
  const liked = state.likedIds.has(t.id);

  $("#player-cover").src = cover;
  $("#player-title").textContent = t.title;
  $("#player-artist").textContent = t.artist;
  $("#btn-player-like").classList.toggle("liked", liked);

  $("#mini-cover").src = cover;
  $("#mini-title").textContent = t.title;
  $("#mini-artist").textContent = t.artist;
  $("#btn-mini-like").classList.toggle("liked", liked);
  $("#mobile-mini-player").hidden = false;

  $("#fs-cover").src = cover;
  $("#fs-title").textContent = t.title;
  $("#fs-artist").textContent = t.artist;
  $("#fs-album").textContent = t.album || "DSoundPro Hi-Fi";
  $("#btn-fs-like").classList.toggle("liked", liked);
}

function updatePlayPauseUI() {
  $("#icon-play").hidden = state.isPlaying || state.isBuffering;
  $("#icon-pause").hidden = !state.isPlaying || state.isBuffering;
  $("#icon-buffering").hidden = !state.isBuffering;

  $("#mini-icon-play").hidden = state.isPlaying;
  $("#mini-icon-pause").hidden = !state.isPlaying;

  $("#fs-icon-play").hidden = state.isPlaying;
  $("#fs-icon-pause").hidden = !state.isPlaying;
}

function updateTransportUI() {
  $("#btn-shuffle").classList.toggle("active", state.shuffle);
  $("#btn-fs-shuffle").classList.toggle("active", state.shuffle);
  $("#btn-repeat").classList.toggle("active", state.repeatMode !== "off");
  $("#btn-fs-repeat").classList.toggle("active", state.repeatMode !== "off");
  $("#repeat-one-badge").hidden = state.repeatMode !== "one";
}

function highlightPlayingRows() {
  $$(".track-row").forEach((row) => {
    const tid = row.dataset.ctxTrack;
    const isCur = state.currentTrack && tid === state.currentTrack.id;
    row.classList.toggle("playing", Boolean(isCur));
  });
}

// --------------------------------------------------------------------------
// Likes & Universal Downloads
// --------------------------------------------------------------------------

async function toggleLikeTrack(track) {
  if (!track) return;
  try {
    const res = await API.toggleLike(track);
    if (res.is_liked) {
      state.likedIds.add(track.id);
      showToast(`Añadido a Tus Me Gusta`);
    } else {
      state.likedIds.delete(track.id);
      showToast(`Quitado de Tus Me Gusta`);
    }
    updatePlayerMetaUI();
    await refreshSidebarAndMeta();
    if (["liked", "library"].includes(state.view)) renderCurrentView();
    else {
      $$(`[data-like-track="${CSS.escape(track.id)}"]`).forEach((b) =>
        b.classList.toggle("liked", res.is_liked)
      );
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
}

async function startTrackDownload(track) {
  if (!track) return;
  try {
    const fmt = state.settings.download_format || "mp3";
    const bitrate = state.settings.download_bitrate || "320";
    const res = await API.startDownload(track, fmt, bitrate);
    showToast(`Descargando "${track.title}" en ${fmt.toUpperCase()} (${bitrate} kbps)...`);
    if (res.job) {
      const idx = state.downloadJobs.findIndex((j) => j.track_id === track.id);
      if (idx >= 0) state.downloadJobs[idx] = res.job;
      else state.downloadJobs.unshift(res.job);
    }
    updateDownloadBadge();
    maybeStartDownloadPolling();
    if (state.view === "downloads") renderCurrentView();
  } catch (err) {
    showToast(`Error al iniciar descarga: ${err.message}`);
  }
}

async function downloadBatch(tracks) {
  const pending = tracks.filter((t) => !t.is_downloaded && !t.has_local_file);
  if (!pending.length) {
    showToast("Todas estas canciones ya están descargadas en MP3");
    return;
  }
  showToast(`Iniciando descarga de ${pending.length} canciones en ${state.settings.download_format.toUpperCase()}...`);
  for (const t of pending) {
    await API.startDownload(t, state.settings.download_format, state.settings.download_bitrate).catch(() => {});
  }
  maybeStartDownloadPolling();
  navigate("downloads");
}

function triggerDeviceFileSave(trackId) {
  const a = document.createElement("a");
  a.href = `/api/downloads/${encodeURIComponent(trackId)}/file`;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast("Guardando archivo MP3 en tu dispositivo...");
}

function maybeStartDownloadPolling() {
  if (dlPollTimer) return;
  const poll = async () => {
    try {
      const res = await API.getDownloads();
      const prevCompleted = new Set(
        state.downloadJobs.filter((j) => j.status === "completed").map((j) => j.track_id)
      );
      state.downloadedTracks = res.tracks || [];
      state.downloadJobs = res.jobs || [];
      updateDownloadBadge();

      for (const j of state.downloadJobs) {
        if (j.status === "completed" && !prevCompleted.has(j.track_id)) {
          showToast(`✓ Descarga lista: ${j.title} (${(j.format || "MP3").toUpperCase()})`);
          const t = state.trackMap.get(j.track_id);
          if (t) {
            t.is_downloaded = true;
            t.has_local_file = true;
            t.file_format = j.format;
            t.file_size = j.file_size;
          }
        }
      }

      if (state.view === "downloads") {
        renderDownloadsView($("#main-content"));
      }

      const stillActive = state.downloadJobs.some((j) =>
        ["queued", "downloading", "converting", "tagging"].includes(j.status)
      );
      if (!stillActive) {
        clearInterval(dlPollTimer);
        dlPollTimer = null;
      }
    } catch (_) {}
  };
  dlPollTimer = setInterval(poll, 1400);
}

// --------------------------------------------------------------------------
// Synced Lyrics Engine
// --------------------------------------------------------------------------

async function loadLyricsForTrack(track) {
  state.lyrics = { trackId: track.id, synced: [], plain: "", found: false, loading: true };
  state.activeLyricIdx = -1;
  renderRightPanelIfOpen();
  renderFsExtraIfOpen();

  try {
    const res = await API.getLyrics(track);
    if (state.currentTrack?.id !== track.id) return;
    state.lyrics = {
      trackId: track.id,
      synced: res.synced || [],
      plain: res.plain || "",
      found: Boolean(res.found),
      loading: false,
    };
  } catch (_) {
    state.lyrics.loading = false;
  }
  renderRightPanelIfOpen();
  renderFsExtraIfOpen();
}

function syncActiveLyric(currentSec) {
  const lines = state.lyrics.synced;
  if (!lines || !lines.length) return;
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (currentSec + 0.25 >= lines[i].time) active = i;
    else break;
  }
  if (active !== state.activeLyricIdx) {
    state.activeLyricIdx = active;
    $$(".lyric-line").forEach((el) => {
      const idx = Number(el.dataset.lrcIdx);
      const isAct = idx === active;
      el.classList.toggle("active", isAct);
      if (isAct) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }
}

// --------------------------------------------------------------------------
// Right Panel & Fullscreen Extra Renderers (Queue, Lyrics, Audio EQ Studio)
// --------------------------------------------------------------------------

function openRightPanel(tab) {
  if (state.rightOpen && state.rightTab === tab) {
    state.rightOpen = false;
  } else {
    state.rightOpen = true;
    state.rightTab = tab;
  }
  $("#app").classList.toggle("right-open", state.rightOpen);
  $$(".rp-tab").forEach((b) => b.classList.toggle("active", b.dataset.rp === state.rightTab));
  $("#btn-toggle-queue").classList.toggle("active", state.rightOpen && state.rightTab === "queue");
  $("#btn-toggle-lyrics").classList.toggle("active", state.rightOpen && state.rightTab === "lyrics");
  $("#btn-toggle-studio").classList.toggle("active", state.rightOpen && state.rightTab === "studio");
  renderRightPanelIfOpen();
}

function renderRightPanelIfOpen() {
  if (!state.rightOpen) return;
  const body = $("#right-panel-body");
  if (state.rightTab === "queue") renderQueueInto(body);
  else if (state.rightTab === "lyrics") renderLyricsInto(body);
  else renderStudioInto(body);
}

function renderFsExtraIfOpen() {
  if (!state.fsOpen || state.fsMode === "player") return;
  const box = $("#fs-stage-extra");
  if (state.fsMode === "queue") renderQueueInto(box);
  else if (state.fsMode === "lyrics") renderLyricsInto(box);
  else if (state.fsMode === "eq") renderStudioInto(box);
}

function renderQueueInto(container) {
  const cur = state.currentTrack;
  const upcoming = state.queue.slice(state.queueIndex + 1);

  container.innerHTML = `
    ${
      cur
        ? `
      <div style="font-size:0.74rem;font-weight:800;color:var(--text-muted);margin-bottom:8px;letter-spacing:0.08em">SONANDO AHORA</div>
      <div class="playlist-mini-item active" style="margin-bottom:16px">
        <div class="playlist-mini-art"><img src="${esc(cur.cover_url || FALLBACK_COVER)}" alt="" /></div>
        <div class="playlist-mini-meta">
          <span class="playlist-mini-title" style="color:var(--accent)">${esc(cur.title)}</span>
          <span class="playlist-mini-sub">${esc(cur.artist)}</span>
        </div>
      </div>`
        : ""
    }
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <span style="font-size:0.74rem;font-weight:800;color:var(--text-muted);letter-spacing:0.08em">A CONTINUACIÓN (${upcoming.length})</span>
      ${upcoming.length ? `<button class="section-link" data-clear-queue="1">Limpiar</button>` : ""}
    </div>
    ${
      upcoming.length
        ? upcoming
            .map(
              (t, i) => `
          <div class="playlist-mini-item" data-jump-queue="${state.queueIndex + 1 + i}">
            <div class="playlist-mini-art"><img src="${esc(t.cover_url || FALLBACK_COVER)}" alt="" /></div>
            <div class="playlist-mini-meta" style="flex:1">
              <span class="playlist-mini-title">${esc(t.title)}</span>
              <span class="playlist-mini-sub">${esc(t.artist)}</span>
            </div>
          </div>`
            )
            .join("")
        : `<div class="empty-state" style="padding:28px 10px"><p>No hay más canciones en cola.</p></div>`
    }
  `;
}

function renderLyricsInto(container) {
  if (!state.currentTrack) {
    container.innerHTML = `<div class="empty-state"><p>Reproduce una canción para ver su letra sincronizada.</p></div>`;
    return;
  }
  if (state.lyrics.loading) {
    container.innerHTML = `<div class="loading-splash"><div class="spinner"></div><p>Buscando letra sincronizada...</p></div>`;
    return;
  }
  if (state.lyrics.synced.length) {
    container.innerHTML = `
      <div class="lyrics-container">
        ${state.lyrics.synced
          .map(
            (l, i) => `
          <div class="lyric-line ${i === state.activeLyricIdx ? "active" : ""}" data-lrc-idx="${i}" data-lrc-time="${l.time}">
            ${esc(l.text)}
          </div>`
          )
          .join("")}
      </div>`;
    return;
  }
  if (state.lyrics.plain) {
    container.innerHTML = `<div class="lyric-plain">${esc(state.lyrics.plain)}</div>`;
    return;
  }
  container.innerHTML = `<div class="empty-state"><p>No encontramos la letra de "${esc(state.currentTrack.title)}".</p></div>`;
}

function renderStudioInto(container) {
  const presets = Object.keys(EQ_PRESETS);
  const speeds = [0.75, 1.0, 1.15, 1.25, 1.5];
  const timers = [
    { v: "off", l: "Apagado" },
    { v: "15", l: "15 min" },
    { v: "30", l: "30 min" },
    { v: "45", l: "45 min" },
    { v: "60", l: "60 min" },
    { v: "eot", l: "Fin canción" },
  ];

  container.innerHTML = `
    <div class="studio-card">
      <h4>Visualizador en vivo</h4>
      <canvas class="visualizer-canvas" id="panel-visualizer"></canvas>
    </div>

    <div class="studio-card">
      <h4>Ecualizador 5 Bandas</h4>
      <div class="preset-chips">
        ${presets
          .map(
            (p) => `<button class="preset-chip ${audioEngine.eqPreset === p ? "active" : ""}" data-eq-preset="${esc(p)}">${esc(p)}</button>`
          )
          .join("")}
      </div>
      <div class="eq-sliders">
        ${EQ_LABELS.map(
          (lbl, i) => `
          <div class="eq-band">
            <span class="eq-val" id="eq-val-${i}">${audioEngine.eqGains[i] > 0 ? "+" : ""}${audioEngine.eqGains[i]}dB</span>
            <input type="range" min="-12" max="12" step="1" value="${audioEngine.eqGains[i]}" data-eq-band="${i}" />
            <span>${lbl}</span>
          </div>`
        ).join("")}
      </div>
    </div>

    <div class="studio-card">
      <h4>Velocidad de reproducción</h4>
      <div class="preset-chips">
        ${speeds
          .map(
            (s) => `<button class="preset-chip ${audioEngine.playbackRate === s ? "active" : ""}" data-speed="${s}">${s}x</button>`
          )
          .join("")}
      </div>
    </div>

    <div class="studio-card">
      <h4>Temporizador (${esc(audioEngine.sleepLabel)})</h4>
      <div class="preset-chips">
        ${timers
          .map(
            (t) => `<button class="preset-chip ${audioEngine.sleepLabel === t.l ? "active" : ""}" data-sleep="${t.v}">${t.l}</button>`
          )
          .join("")}
      </div>
    </div>
  `;

  audioEngine.registerVisualizer($("#panel-visualizer", container));
}

// --------------------------------------------------------------------------
// Modals (Playlists, Add to Playlist, QR Connect Mobile)
// --------------------------------------------------------------------------

function openModal(html) {
  const overlay = $("#modal-overlay");
  $("#modal-card").innerHTML = html;
  overlay.hidden = false;
}

function closeModal() {
  $("#modal-overlay").hidden = true;
}

function openCreatePlaylistModal() {
  openModal(`
    <div class="modal-header">
      <h3>Nueva Playlist</h3>
      <button class="icon-btn-sm" onclick="closeModal()">&times;</button>
    </div>
    <form id="form-new-pl">
      <div class="form-field">
        <label>Nombre</label>
        <input type="text" id="pl-name-in" required placeholder="Ej. Roadtrip 2026" maxlength="80" />
      </div>
      <div class="form-field">
        <label>Descripción (opcional)</label>
        <textarea id="pl-desc-in" rows="2" placeholder="Describe el mood de tu playlist..."></textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button type="button" class="pill-btn ghost-pill" onclick="closeModal()">Cancelar</button>
        <button type="submit" class="pill-btn accent-pill">Crear Playlist</button>
      </div>
    </form>
  `);
  $("#pl-name-in").focus();
  $("#form-new-pl").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("#pl-name-in").value.trim();
    const desc = $("#pl-desc-in").value.trim();
    if (!name) return;
    const res = await API.createPlaylist(name, desc);
    closeModal();
    await refreshSidebarAndMeta();
    showToast(`Playlist "${name}" creada`);
    navigate("playlist", { playlistId: res.playlist.id });
  };
}

function openEditPlaylistModal(pl) {
  openModal(`
    <div class="modal-header">
      <h3>Editar Playlist</h3>
      <button class="icon-btn-sm" onclick="closeModal()">&times;</button>
    </div>
    <form id="form-edit-pl">
      <div class="form-field">
        <label>Nombre</label>
        <input type="text" id="pl-edit-name" required value="${esc(pl.name)}" maxlength="80" />
      </div>
      <div class="form-field">
        <label>Descripción</label>
        <textarea id="pl-edit-desc" rows="2">${esc(pl.description || "")}</textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button type="button" class="pill-btn ghost-pill" onclick="closeModal()">Cancelar</button>
        <button type="submit" class="pill-btn accent-pill">Guardar</button>
      </div>
    </form>
  `);
  $("#form-edit-pl").onsubmit = async (e) => {
    e.preventDefault();
    await API.updatePlaylist(pl.id, $("#pl-edit-name").value.trim(), $("#pl-edit-desc").value.trim());
    closeModal();
    await refreshSidebarAndMeta();
    renderCurrentView();
    showToast("Playlist actualizada");
  };
}

function openAddToPlaylistModal(track) {
  openModal(`
    <div class="modal-header">
      <h3>Añadir a Playlist</h3>
      <button class="icon-btn-sm" onclick="closeModal()">&times;</button>
    </div>
    <p style="font-size:0.84rem;color:var(--text-secondary);margin-bottom:14px">${esc(track.title)} — ${esc(track.artist)}</p>
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
      ${state.playlists
        .map(
          (pl) => `
        <button class="playlist-mini-item" data-pick-pl="${esc(pl.id)}">
          <div class="playlist-mini-art" style="background:${esc(pl.cover_gradient)}">♫</div>
          <div class="playlist-mini-meta">
            <span class="playlist-mini-title">${esc(pl.name)}</span>
            <span class="playlist-mini-sub">${pl.track_count || 0} canciones</span>
          </div>
        </button>`
        )
        .join("")}
    </div>
    <button class="pill-btn accent-pill" style="width:100%;justify-content:center" id="btn-modal-new-pl">+ Crear nueva playlist</button>
  `);

  $$("[data-pick-pl]", $("#modal-card")).forEach((btn) => {
    btn.onclick = async () => {
      await API.addTrackToPlaylist(btn.dataset.pickPl, track);
      closeModal();
      await refreshSidebarAndMeta();
      showToast("Canción añadida a la playlist");
    };
  });
  $("#btn-modal-new-pl").onclick = () => {
    closeModal();
    openCreatePlaylistModal();
  };
}

async function openQrMobileModal() {
  openModal(`<div class="loading-splash"><div class="spinner"></div><p>Generando enlace móvil...</p></div>`);
  try {
    const info = await API.getNetworkInfo();
    openModal(`
      <div class="modal-header">
        <h3>Usar DSoundPro en tu Celular</h3>
        <button class="icon-btn-sm" onclick="closeModal()">&times;</button>
      </div>
      <div class="qr-box">
        <img src="/api/network/qr?t=${Date.now()}" alt="QR DSoundPro" />
        <p style="font-size:0.86rem;color:var(--text-secondary);line-height:1.45">
          Escanea este código con la cámara de tu <strong>Android o iPhone</strong> (conectado al mismo Wi-Fi) para abrir DSoundPro al instante.
        </p>
        <div class="url-copy-box">
          <span>${esc(info.mobile_url)}</span>
          <button class="pill-btn accent-pill" id="btn-copy-url" style="padding:5px 11px">Copiar</button>
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted);text-align:left;background:rgba(255,255,255,0.04);padding:12px;border-radius:10px;width:100%;line-height:1.5">
          <strong>Tip App Nativa (PWA):</strong><br/>
          • <strong>Android (Chrome):</strong> Menú ⋮ → <em>"Instalar aplicación"</em><br/>
          • <strong>iPhone (Safari):</strong> Compartir ↑ → <em>"Añadir a pantalla de inicio"</em><br/>
          • Las canciones descargadas se guardan en MP3 directamente en tu teléfono para usarlas en cualquier reproductor.
        </div>
      </div>
    `);
    $("#btn-copy-url").onclick = () => {
      navigator.clipboard?.writeText(info.mobile_url);
      showToast("Enlace copiado al portapapeles");
    };
  } catch (err) {
    closeModal();
    showToast("No se pudo obtener la IP local");
  }
}

// --------------------------------------------------------------------------
// Context Menu
// --------------------------------------------------------------------------

function showContextMenu(track, x, y) {
  if (!track) return;
  const menu = $("#context-menu");
  const isLiked = state.likedIds.has(track.id);
  const isLocal = track.is_downloaded || track.has_local_file;

  menu.innerHTML = `
    <button class="ctx-item" data-ctx-act="play">▶ Reproducir ahora</button>
    <button class="ctx-item" data-ctx-act="next">⏭ Reproducir a continuación</button>
    <button class="ctx-item" data-ctx-act="queue">➕ Añadir a la cola</button>
    <div class="ctx-divider"></div>
    <button class="ctx-item" data-ctx-act="like">${isLiked ? "💔 Quitar de Me Gusta" : "💚 Añadir a Me Gusta"}</button>
    <button class="ctx-item" data-ctx-act="playlist">🎵 Añadir a Playlist...</button>
    <div class="ctx-divider"></div>
    <button class="ctx-item" data-ctx-act="download">⬇ ${isLocal ? "Guardar archivo MP3 en dispositivo" : "Descargar MP3 (Universal)"}</button>
    <button class="ctx-item" data-ctx-act="artist">🎤 Ver más de ${esc(track.artist)}</button>
  `;

  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 12);
  const top = Math.min(y, window.innerHeight - rect.height - 12);
  menu.style.left = `${Math.max(10, left)}px`;
  menu.style.top = `${Math.max(10, top)}px`;

  menu.onclick = (e) => {
    const btn = e.target.closest("[data-ctx-act]");
    if (!btn) return;
    menu.hidden = true;
    const act = btn.dataset.ctxAct;
    if (act === "play") playTrack(track);
    else if (act === "next") addToQueue(track, true);
    else if (act === "queue") addToQueue(track, false);
    else if (act === "like") toggleLikeTrack(track);
    else if (act === "playlist") openAddToPlaylistModal(track);
    else if (act === "download") {
      if (isLocal) triggerDeviceFileSave(track.id);
      else startTrackDownload(track);
    } else if (act === "artist") {
      performSearch(track.artist, "all");
    }
  };
}

// --------------------------------------------------------------------------
// Global Event Delegation & Keyboard Shortcuts
// --------------------------------------------------------------------------

function getContextListByKey(listKey) {
  if (!listKey) return null;
  if (listKey === "trending") return state.homeData?.trending || null;
  if (listKey === "recent") return state.homeData?.recently_played || null;
  if (listKey === "search") return state.searchResults?.tracks || null;
  if (state._tempLists && state._tempLists[listKey]) return state._tempLists[listKey];
  return null;
}

function bindGlobalEvents() {
  // Navigation clicks
  $$(".nav-item, .mnav-item").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.view));
  });
  $("#brand-home").addEventListener("click", () => navigate("home"));
  $("#btn-nav-back").addEventListener("click", () => {
    const prev = state.viewHistory.pop();
    if (prev) navigate(prev.view, { playlistId: prev.playlistId, skipHistory: true });
    else navigate("home", { skipHistory: true });
  });

  // Search bar
  const searchInput = $("#global-search-input");
  searchInput.addEventListener("input", () => {
    $("#btn-clear-search").hidden = !searchInput.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      performSearch(searchInput.value, state.searchMode);
    }, 380);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(searchDebounce);
      performSearch(searchInput.value, state.searchMode);
    }
  });
  $("#btn-clear-search").addEventListener("click", () => {
    performSearch("", state.searchMode);
    searchInput.focus();
  });

  // Topbar & Sidebar actions
  $("#btn-new-playlist-side").onclick = openCreatePlaylistModal;
  $("#btn-open-qr").onclick = openQrMobileModal;
  $("#btn-open-qr-top").onclick = openQrMobileModal;
  $("#btn-import-top").onclick = () => $("#local-file-input").click();

  // Local file upload
  $("#local-file-input").addEventListener("change", async (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    showToast(`Importando ${files.length} archivo(s) de audio...`);
    try {
      const res = await API.uploadLocalFiles(files);
      showToast(`✓ ${res.count} canción(es) importada(s)`);
      await refreshSidebarAndMeta();
      navigate("downloads");
    } catch (err) {
      showToast(`Error importando: ${err.message}`);
    } finally {
      e.target.value = "";
    }
  });

  // Player controls (Desktop + Mobile + Fullscreen)
  $("#btn-play-pause").onclick = togglePlayPause;
  $("#btn-mini-play").onclick = togglePlayPause;
  $("#btn-fs-play").onclick = togglePlayPause;

  $("#btn-next").onclick = playNext;
  $("#btn-fs-next").onclick = playNext;
  $("#btn-prev").onclick = playPrevious;
  $("#btn-fs-prev").onclick = playPrevious;

  const toggleShuffle = () => {
    state.shuffle = !state.shuffle;
    updateTransportUI();
    showToast(state.shuffle ? "Modo aleatorio activado" : "Modo aleatorio desactivado");
  };
  $("#btn-shuffle").onclick = toggleShuffle;
  $("#btn-fs-shuffle").onclick = toggleShuffle;

  const cycleRepeat = () => {
    const order = ["off", "all", "one"];
    state.repeatMode = order[(order.indexOf(state.repeatMode) + 1) % order.length];
    updateTransportUI();
    const labels = { off: "Repetición desactivada", all: "Repetir lista", one: "Repetir esta canción" };
    showToast(labels[state.repeatMode]);
  };
  $("#btn-repeat").onclick = cycleRepeat;
  $("#btn-fs-repeat").onclick = cycleRepeat;

  const likeCurrent = () => state.currentTrack && toggleLikeTrack(state.currentTrack);
  $("#btn-player-like").onclick = likeCurrent;
  $("#btn-mini-like").onclick = likeCurrent;
  $("#btn-fs-like").onclick = likeCurrent;

  const dlCurrent = () => {
    if (!state.currentTrack) return;
    if (state.currentTrack.is_downloaded || state.currentTrack.has_local_file) {
      triggerDeviceFileSave(state.currentTrack.id);
    } else {
      startTrackDownload(state.currentTrack);
    }
  };
  $("#btn-player-download").onclick = dlCurrent;
  $("#btn-fs-download").onclick = dlCurrent;

  // Seek sliders
  ["#seek-slider", "#fs-seek-slider"].forEach((sel) => {
    const sl = $(sel);
    sl.addEventListener("input", () => {
      isSeeking = true;
      updateSliderFill(sl);
    });
    sl.addEventListener("change", () => {
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (dur > 0) audio.currentTime = (Number(sl.value) / 100) * dur;
      isSeeking = false;
    });
  });

  // Volume
  const volSlider = $("#volume-slider");
  updateSliderFill(volSlider);
  volSlider.addEventListener("input", () => {
    const v = Number(volSlider.value);
    audio.volume = v;
    state.isMuted = v === 0;
    if (v > 0) state.lastVolume = v;
    updateSliderFill(volSlider);
  });
  $("#btn-mute").onclick = () => {
    if (audio.volume > 0) {
      state.lastVolume = audio.volume;
      audio.volume = 0;
      volSlider.value = 0;
    } else {
      audio.volume = state.lastVolume || 0.8;
      volSlider.value = audio.volume;
    }
    updateSliderFill(volSlider);
  };

  // Right panel controls
  $("#btn-toggle-queue").onclick = () => openRightPanel("queue");
  $("#btn-toggle-lyrics").onclick = () => openRightPanel("lyrics");
  $("#btn-toggle-studio").onclick = () => openRightPanel("studio");
  $("#btn-close-rp").onclick = () => {
    state.rightOpen = false;
    $("#app").classList.remove("right-open");
  };
  $$(".rp-tab").forEach((b) => {
    b.onclick = () => {
      state.rightTab = b.dataset.rp;
      $$(".rp-tab").forEach((x) => x.classList.toggle("active", x === b));
      renderRightPanelIfOpen();
    };
  });

  // Fullscreen Now Playing sheet
  const openFs = () => {
    state.fsOpen = true;
    $("#fullscreen-player").classList.add("open");
    $("#fullscreen-player").setAttribute("aria-hidden", "false");
  };
  const closeFs = () => {
    state.fsOpen = false;
    $("#fullscreen-player").classList.remove("open");
    $("#fullscreen-player").setAttribute("aria-hidden", "true");
  };
  $("#btn-open-fullscreen").onclick = openFs;
  $("#mobile-mini-open").onclick = openFs;
  $("#btn-close-fs").onclick = closeFs;
  $("#btn-fs-menu").onclick = (e) => {
    if (state.currentTrack) showContextMenu(state.currentTrack, e.clientX, e.clientY);
  };

  $$(".fs-mode-btn").forEach((btn) => {
    btn.onclick = () => {
      state.fsMode = btn.dataset.fsmode;
      $$(".fs-mode-btn").forEach((x) => x.classList.toggle("active", x === btn));
      const isPlayer = state.fsMode === "player";
      $("#fs-stage-player").hidden = !isPlayer;
      $("#fs-stage-extra").hidden = isPlayer;
      renderFsExtraIfOpen();
    };
  });

  // Close modal / context menu on outside click
  $("#modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#context-menu") && !e.target.closest("[data-open-ctx]")) {
      $("#context-menu").hidden = true;
    }
  });

  // Right-click context menu on tracks
  document.addEventListener("contextmenu", (e) => {
    const row = e.target.closest("[data-ctx-track]");
    if (!row) return;
    e.preventDefault();
    const track = state.trackMap.get(row.dataset.ctxTrack);
    if (track) showContextMenu(track, e.clientX, e.clientY);
  });

  // Unified click delegation across main viewport, sidebar, right panel & fullscreen
  document.addEventListener("click", async (e) => {
    const openCtx = e.target.closest("[data-open-ctx]");
    if (openCtx) {
      e.stopPropagation();
      const t = state.trackMap.get(openCtx.dataset.openCtx);
      const r = openCtx.getBoundingClientRect();
      showContextMenu(t, r.left - 160, r.bottom + 4);
      return;
    }

    const likeBtn = e.target.closest("[data-like-track]");
    if (likeBtn) {
      e.stopPropagation();
      toggleLikeTrack(state.trackMap.get(likeBtn.dataset.likeTrack));
      return;
    }

    const dlBtn = e.target.closest("[data-dl-track]");
    if (dlBtn) {
      e.stopPropagation();
      startTrackDownload(state.trackMap.get(dlBtn.dataset.dlTrack));
      return;
    }

    const saveBtn = e.target.closest("[data-save-file]");
    if (saveBtn) {
      e.stopPropagation();
      triggerDeviceFileSave(saveBtn.dataset.saveFile);
      return;
    }

    const delDl = e.target.closest("[data-del-dl]");
    if (delDl) {
      e.stopPropagation();
      if (!confirm("¿Eliminar este archivo descargado del disco?")) return;
      await API.deleteDownload(delDl.dataset.delDl);
      showToast("Archivo eliminado");
      renderCurrentView();
      return;
    }

    const rmPlTrack = e.target.closest("[data-rm-pl-track]");
    if (rmPlTrack) {
      e.stopPropagation();
      await API.removeTrackFromPlaylist(rmPlTrack.dataset.plId, rmPlTrack.dataset.rmPlTrack);
      await refreshSidebarAndMeta();
      renderCurrentView();
      showToast("Canción quitada de la playlist");
      return;
    }

    const playEl = e.target.closest("[data-play-track]");
    if (playEl) {
      const t = state.trackMap.get(playEl.dataset.playTrack);
      const list = getContextListByKey(playEl.dataset.listKey);
      playTrack(t, list);
      return;
    }

    const openPl = e.target.closest("[data-open-playlist]");
    if (openPl) {
      navigate("playlist", { playlistId: openPl.dataset.openPlaylist });
      return;
    }

    const quickV = e.target.closest("[data-quick-view]");
    if (quickV) {
      navigate(quickV.dataset.quickView);
      return;
    }

    const runQ = e.target.closest("[data-run-query]");
    if (runQ) {
      performSearch(runQ.dataset.runQuery, "all");
      return;
    }

    const searchModeBtn = e.target.closest("[data-search-mode]");
    if (searchModeBtn) {
      const newMode = searchModeBtn.dataset.searchMode;
      state.searchMode = newMode;
      if (state.searchQuery) performSearch(state.searchQuery, newMode);
      else renderCurrentView();
      return;
    }

    const libTab = e.target.closest("[data-lib-tab]");
    if (libTab) {
      state.libraryTab = libTab.dataset.libTab;
      renderCurrentView();
      return;
    }

    const jumpQ = e.target.closest("[data-jump-queue]");
    if (jumpQ) {
      const idx = Number(jumpQ.dataset.jumpQueue);
      if (state.queue[idx]) {
        state.queueIndex = idx;
        playTrack(state.queue[idx]);
      }
      return;
    }

    if (e.target.closest("[data-clear-queue]")) {
      state.queue = state.currentTrack ? [state.currentTrack] : [];
      state.queueIndex = state.currentTrack ? 0 : -1;
      renderRightPanelIfOpen();
      renderFsExtraIfOpen();
      return;
    }

    const lrcLine = e.target.closest("[data-lrc-time]");
    if (lrcLine) {
      audio.currentTime = Number(lrcLine.dataset.lrcTime) || 0;
      return;
    }

    const eqPreset = e.target.closest("[data-eq-preset]");
    if (eqPreset) {
      audioEngine.ensureGraph();
      audioEngine.applyPreset(eqPreset.dataset.eqPreset);
      API.saveSettings({ eq_preset: eqPreset.dataset.eqPreset, eq_gains: audioEngine.eqGains }).catch(() => {});
      renderRightPanelIfOpen();
      renderFsExtraIfOpen();
      return;
    }

    const spdBtn = e.target.closest("[data-speed]");
    if (spdBtn) {
      audioEngine.setPlaybackRate(Number(spdBtn.dataset.speed));
      renderRightPanelIfOpen();
      renderFsExtraIfOpen();
      showToast(`Velocidad: ${spdBtn.dataset.speed}x`);
      return;
    }

    const slpBtn = e.target.closest("[data-sleep]");
    if (slpBtn) {
      audioEngine.setSleepTimer(slpBtn.dataset.sleep, () => {
        showToast("Temporizador finalizado — audio en pausa");
        renderRightPanelIfOpen();
      });
      renderRightPanelIfOpen();
      renderFsExtraIfOpen();
      showToast(`Temporizador: ${audioEngine.sleepLabel}`);
      return;
    }
  });

  // EQ band sliders (input event delegation)
  document.addEventListener("input", (e) => {
    const band = e.target.closest("[data-eq-band]");
    if (!band) return;
    audioEngine.ensureGraph();
    const idx = Number(band.dataset.eqBand);
    const val = Number(band.value);
    audioEngine.setBandGain(idx, val);
    const lbl = document.getElementById(`eq-val-${idx}`);
    if (lbl) lbl.textContent = `${val > 0 ? "+" : ""}${val}dB`;
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlayPause();
    } else if (e.code === "ArrowRight") {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
    } else if (e.code === "ArrowLeft") {
      audio.currentTime = Math.max(0, audio.currentTime - 5);
    } else if (e.key.toLowerCase() === "m") {
      $("#btn-mute").click();
    } else if (e.key.toLowerCase() === "s") {
      $("#btn-shuffle").click();
    } else if (e.key.toLowerCase() === "r") {
      $("#btn-repeat").click();
    } else if (e.key.toLowerCase() === "l") {
      openRightPanel("lyrics");
    }
  });
}

window.addEventListener("DOMContentLoaded", initApp);
