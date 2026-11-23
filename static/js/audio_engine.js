/* DSoundPro Audio Engine: HTML5 Audio + Web Audio 5-Band EQ + Live Visualizer + Media Session + Sleep Timer */

const EQ_BANDS = [60, 230, 910, 3600, 14000];
const EQ_LABELS = ["60Hz", "230Hz", "910Hz", "3.6kHz", "14kHz"];

const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0],
  "Bass Boost": [6, 4, 0, 0, 1],
  Pop: [-1, 2, 4, 2, -1],
  Rock: [4, 2, -1, 3, 4],
  Electrónica: [5, 3, 0, 2, 5],
  Vocal: [-2, 1, 5, 3, 0],
  Acústico: [2, 1, 2, 2, 1],
};

class AudioEngine {
  constructor() {
    this.audio = new Audio();
    this.audio.crossOrigin = "anonymous";
    this.audio.preload = "auto";
    this.audio.volume = 0.85;

    this.ctx = null;
    this.source = null;
    this.filters = [];
    this.analyser = null;
    this.eqGains = [0, 0, 0, 0, 0];
    this.eqPreset = "Flat";
    this.playbackRate = 1.0;

    this.sleepTimeout = null;
    this.sleepEndOfTrack = false;
    this.sleepLabel = "Apagado";

    this.visualizerRaf = null;
    this.visualizerCanvases = new Set();
  }

  ensureGraph() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.source = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.82;

      this.filters = EQ_BANDS.map((freq, idx) => {
        const f = this.ctx.createBiquadFilter();
        f.type = idx === 0 ? "lowshelf" : idx === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
        f.frequency.value = freq;
        f.Q.value = 1.0;
        f.gain.value = this.eqGains[idx] || 0;
        return f;
      });

      let node = this.source;
      for (const filter of this.filters) {
        node.connect(filter);
        node = filter;
      }
      node.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this._startVisualizerLoop();
    } catch (err) {
      console.warn("Web Audio EQ no disponible:", err);
    }
  }

  setBandGain(index, gainDb) {
    this.eqGains[index] = Number(gainDb);
    this.eqPreset = "Personalizado";
    if (this.filters[index]) {
      this.filters[index].gain.value = Number(gainDb);
    }
  }

  applyPreset(name) {
    const gains = EQ_PRESETS[name] || EQ_PRESETS.Flat;
    this.eqPreset = name;
    this.eqGains = [...gains];
    this.filters.forEach((f, i) => {
      f.gain.value = gains[i];
    });
  }

  setPlaybackRate(rate) {
    this.playbackRate = Number(rate) || 1.0;
    this.audio.playbackRate = this.playbackRate;
  }

  setSleepTimer(minutes, onTrigger) {
    if (this.sleepTimeout) {
      clearTimeout(this.sleepTimeout);
      this.sleepTimeout = null;
    }
    this.sleepEndOfTrack = false;

    if (minutes === "off") {
      this.sleepLabel = "Apagado";
      return;
    }
    if (minutes === "eot") {
      this.sleepEndOfTrack = true;
      this.sleepLabel = "Al terminar la canción";
      return;
    }
    const mins = Number(minutes);
    this.sleepLabel = `${mins} min`;
    this.sleepTimeout = setTimeout(() => {
      this.audio.pause();
      this.sleepLabel = "Apagado";
      if (onTrigger) onTrigger();
    }, mins * 60 * 1000);
  }

  registerVisualizer(canvas) {
    if (canvas) this.visualizerCanvases.add(canvas);
  }

  unregisterVisualizer(canvas) {
    this.visualizerCanvases.delete(canvas);
  }

  _startVisualizerLoop() {
    if (this.visualizerRaf) return;
    const render = () => {
      this.visualizerRaf = requestAnimationFrame(render);
      if (!this.analyser || this.visualizerCanvases.size === 0) return;

      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);

      for (const canvas of this.visualizerCanvases) {
        if (!document.body.contains(canvas)) {
          this.visualizerCanvases.delete(canvas);
          continue;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        const w = (canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1));
        const h = (canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1));
        if (!w || !h) continue;

        ctx.clearRect(0, 0, w, h);
        const bars = 32;
        const gap = w * 0.008;
        const barW = (w - gap * (bars - 1)) / bars;

        const grad = ctx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, "rgba(30, 215, 96, 0.35)");
        grad.addColorStop(0.6, "rgba(30, 215, 96, 0.88)");
        grad.addColorStop(1, "rgba(110, 255, 168, 1)");
        ctx.fillStyle = grad;

        for (let i = 0; i < bars; i++) {
          const val = this.audio.paused ? 8 : data[i] || 6;
          const barH = Math.max(4, (val / 255) * h * 0.92);
          const x = i * (barW + gap);
          const y = h - barH;
          ctx.beginPath();
          ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]);
          ctx.fill();
        }
      }
    };
    this.visualizerRaf = requestAnimationFrame(render);
  }

  updateMediaSession(track, handlers) {
    if (!("mediaSession" in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || "DSoundPro",
        artist: track.artist || "DSoundPro",
        album: track.album || "DSoundPro Hi-Fi",
        artwork: track.cover_url
          ? [
              { src: track.cover_url, sizes: "512x512", type: "image/jpeg" },
              { src: track.cover_url, sizes: "256x256", type: "image/jpeg" },
            ]
          : [{ src: "/static/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
      });
      navigator.mediaSession.setActionHandler("play", handlers.play);
      navigator.mediaSession.setActionHandler("pause", handlers.pause);
      navigator.mediaSession.setActionHandler("previoustrack", handlers.prev);
      navigator.mediaSession.setActionHandler("nexttrack", handlers.next);
      navigator.mediaSession.setActionHandler("seekto", (d) => {
        if (d.seekTime != null && Number.isFinite(this.audio.duration)) {
          this.audio.currentTime = d.seekTime;
        }
      });
    } catch (_) {}
  }
}
