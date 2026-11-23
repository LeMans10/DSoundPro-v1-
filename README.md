# DSoundPro — Tu Música Sin Límites

**DSoundPro** es una aplicación de música hecha en **Python** inspirada en Spotify, diseñada con una interfaz moderna, fluida y adaptable tanto para **ordenador (Windows / macOS / Linux)** como para **celulares (Android / iOS)**, con **descarga universal en MP3/M4A** lista para usarse en cualquier otro reproductor.

## Características principales

- **Interfaz estilo Spotify (PC y Celular)**: Diseño oscuro glassmórfico con brillo ambiental dinámico según la canción, tarjetas de géneros, mixes curados, tendencias globales, mini-reproductor flotante en celular y vista de reproducción a pantalla completa.
- **Descarga universal sin DRM (MP3 / M4A)**: Descarga cualquier canción en **MP3 (320 / 192 / 128 kbps)** o **M4A AAC** con **carátula en alta resolución y metadatos ID3 incrustados** (Título, Artista, Álbum) para reproducirla en VLC, reproductor del auto, USB, Windows Media Player, Samsung Music, Poweramp o iOS/Android.
- **Compatible con celulares (Wi-Fi + PWA)**: Escanea el **código QR** desde el botón *"Conectar Celular (QR)"* para abrir DSoundPro en tu teléfono e incluso instalarlo en la pantalla de inicio como una app nativa (con controles en pantalla de bloqueo vía Media Session API).
- **Todas las comodidades de Spotify**:
  - Búsqueda instantánea en Catálogo HD o directo en YouTube / pegando URLs.
  - **Letras sincronizadas en tiempo real** (estilo karaoke interactivo: toca cualquier verso para saltar a ese momento).
  - **Ecualizador gráfico de 5 bandas** (`60Hz`, `230Hz`, `910Hz`, `3.6kHz`, `14kHz`) con presets (*Bass Boost, Pop, Rock, Electrónica, Vocal, Acústico*) y **visualizador de espectro en vivo**.
  - Playlists personalizadas (crear, editar, eliminar y **descargar una playlist entera a MP3**).
  - **Tus Me Gusta**, historial reciente, canciones más escuchadas, cola de reproducción, modo aleatorio, repetir lista/canción, velocidad de reproducción y **temporizador de apagado (Sleep Timer)**.
  - **Importar música local**: sube tus propios archivos `.mp3`, `.m4a`, `.wav`, `.flac` u `.ogg` y úsalos offline.

## Cómo iniciar DSoundPro

### Opción rápida (Windows)
Haz doble clic en **`iniciar_dsoundpro.bat`**.

### Desde la terminal
```bash
# Usando el entorno virtual incluido
.\.venv\Scripts\python.exe run.py
```

Al iniciarse:
- Se abrirá automáticamente en modo aplicación de escritorio en `http://localhost:8765`.
- En la consola y en el botón **Conectar Celular (QR)** verás la dirección local (ej. `http://192.168.1.X:8765`) para abrirla desde tu celular en el mismo Wi-Fi.
- Todas las descargas MP3 se guardan en la carpeta `downloads/`.
