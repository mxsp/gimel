"""Spracherkennung auf diesem Rechner (faster-whisper, CPU).

Das Mikrofon-Audio verlässt den Rechner nicht: kein Browser-Dienst, kein
Cloud-Anbieter. Das Modell wird beim ersten Gebrauch geladen (einmaliger
Download nach ``~/.cache/huggingface``) und dann von allen Anfragen geteilt.

Schutz des einen Prozesses (Sicherheitsprüfung 2026-11-08):

- **Format aus den ersten Bytes**, nicht aus dem Content-Type: WebM/Matroska,
  OGG, MP4, WAV, MP3. Nur diese Demuxer und die Codecs in ``CODECS`` erreichen
  FFmpeg; genau eine Tonspur, ein Decoder-Thread.
- **Dekodieren mit Obergrenze:** eine kleine Datei kann Stunden Audio
  enthalten (1,5 MB Opus-Stille = 6000 s = 1 GB entpackt). Der Decoder hört
  auf, sobald ``MAX_SECONDS`` erreicht sind, und antwortet 413.
- **Eine Erkennung zur Zeit, ohne Warteschlange:** ``try_begin`` greift die
  Sperre nicht blockierend (sonst 409); der Arbeits-Thread gibt sie erst frei,
  wenn er wirklich fertig ist — auch wenn der Client längst weg ist.

Das Paket ist optional (``pip install -e ".[voice]"``); fehlt es, meldet
``available()`` False und der Endpunkt antwortet mit 503.
"""

from __future__ import annotations

import asyncio
import io
import os
import threading
import time

MODEL_NAME = os.environ.get("GIMEL_VOICE_STT_MODEL", "small")
CPU_THREADS = int(os.environ.get("GIMEL_VOICE_STT_THREADS", "4") or 4)
MAX_BYTES = 10 * 1024 * 1024
MAX_SECONDS = 120.0
RATE = 16000
LANGUAGES = {"de", "en", "auto"}
CODECS = {"opus", "vorbis", "aac", "mp3", "mp3float", "pcm_s16le", "pcm_f32le"}

_model = None
_model_lock = threading.Lock()
_gate = threading.Lock()


class TranscribeError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def loaded() -> bool:
    return _model is not None


def try_begin() -> bool:
    """Die eine Erkennung reservieren; False heißt: gerade belegt (409)."""
    return _gate.acquire(blocking=False)


def end() -> None:
    _gate.release()


def _get_model():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise TranscribeError(
                    503,
                    "Spracherkennung fehlt. Bitte `pip install -e \".[voice]\"` "
                    "im Gimel-Umfeld nachholen.",
                ) from exc
            _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8",
                                  cpu_threads=CPU_THREADS)
    return _model


def warm_up() -> None:
    """Modell im Hintergrund laden, damit die erste Frage nicht wartet."""
    if not available():
        return

    def _load() -> None:
        try:
            _get_model()
        except Exception:  # noqa: BLE001 — beim ersten echten Aufruf erneut
            pass

    threading.Thread(target=_load, name="voice-stt-warmup", daemon=True).start()


def sniff(data: bytes) -> str:
    """Container aus den ersten Bytes; leer heißt: kein erlaubtes Format."""
    head = data[:16]
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "matroska"  # auch WebM
    if head.startswith(b"OggS"):
        return "ogg"
    if head.startswith(b"RIFF") and head[8:12] == b"WAVE":
        return "wav"
    if head[4:8] == b"ftyp":
        return "mp4"
    if head.startswith(b"ID3") or (len(head) > 1 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
        return "mp3"
    return ""


def _decode(data: bytes):
    """Browser-Audio → 16 kHz mono float32, höchstens ``MAX_SECONDS``."""
    import av
    import numpy as np
    from av.audio.resampler import AudioResampler

    fmt = sniff(data)
    if not fmt:
        raise TranscribeError(422, "Die Aufnahme ließ sich nicht lesen (unbekanntes Format).")
    limit = int(MAX_SECONDS * RATE)
    too_long = TranscribeError(413, f"Die Aufnahme ist länger als {int(MAX_SECONDS)} Sekunden.")
    try:
        container = av.open(io.BytesIO(data), mode="r", format=fmt, metadata_errors="ignore")
    except Exception as exc:  # noqa: BLE001 — kaputte Datei
        raise TranscribeError(422, "Die Aufnahme ließ sich nicht lesen.") from exc
    try:
        audio_streams = list(container.streams.audio)
        if len(audio_streams) != 1 or len(container.streams) != 1:
            raise TranscribeError(422, "Die Aufnahme muss genau eine Tonspur und sonst nichts enthalten.")
        stream = audio_streams[0]
        if stream.codec_context.name not in CODECS:
            raise TranscribeError(422, "Dieses Audioformat wird nicht angenommen.")
        stream.codec_context.thread_count = 1
        if container.duration and container.duration / 1_000_000 > MAX_SECONDS + 1:
            raise too_long
        resampler = AudioResampler(format="s16", layout="mono", rate=RATE)
        parts: list = []
        total = 0

        def take(frames) -> None:
            nonlocal total
            for out in frames:
                arr = out.to_ndarray().reshape(-1)
                total += arr.shape[0]
                if total > limit:
                    raise too_long
                parts.append(arr)

        try:
            for frame in container.decode(stream):
                take(resampler.resample(frame))
            take(resampler.resample(None))
        except TranscribeError:
            raise
        except Exception as exc:  # noqa: BLE001 — Fehler mitten im Strom
            if not parts:
                raise TranscribeError(422, "Die Aufnahme ließ sich nicht lesen.") from exc
            # Abgeschnittenes Ende (Aufnahme abgebrochen): das Gelesene reicht.
    finally:
        container.close()

    audio = (np.concatenate(parts).astype(np.float32) / 32768.0) if parts else np.zeros(0, np.float32)
    seconds = len(audio) / RATE
    if seconds < 0.2:
        raise TranscribeError(422, "Die Aufnahme ist zu kurz.")
    return audio, seconds


# Leise Aufnahmen anheben (task 43): Whisper versteht −50 dBFS noch fast wortgenau,
# aber besser mit vollem Pegel. Höchstens +40 dB, damit reines Rauschen nicht zum
# Brüllen wird; Ziel Spitze −6 dBFS.
NORM_TARGET_PEAK = 0.5
NORM_MAX_GAIN = 100.0


def _db(x: float) -> float | None:
    import math

    return round(20 * math.log10(x), 1) if x > 0 else None


def levels(audio) -> dict:
    """Spitze und RMS der Aufnahme in dBFS (``None`` = digitale Stille)."""
    import numpy as np

    if audio.size == 0:
        return {"peak_dbfs": None, "rms_dbfs": None}
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    return {"peak_dbfs": _db(peak), "rms_dbfs": _db(rms)}


def normalise(audio):
    """Auf ``NORM_TARGET_PEAK`` anheben, nie absenken, höchstens ``NORM_MAX_GAIN``."""
    import numpy as np

    if audio.size == 0:
        return audio, 1.0
    peak = float(np.max(np.abs(audio)))
    if peak <= 0 or peak >= NORM_TARGET_PEAK:
        return audio, 1.0
    gain = min(NORM_TARGET_PEAK / peak, NORM_MAX_GAIN)
    return (audio * gain).astype(np.float32), gain


def _run(data: bytes, language: str) -> dict:
    started = time.monotonic()
    audio, seconds = _decode(data)
    measured = levels(audio)
    audio, gain = normalise(audio)
    model = _get_model()
    segments, info = model.transcribe(
        audio,
        language=None if language == "auto" else language,
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    parts = [seg.text.strip() for seg in segments if seg.text.strip()]
    after_vad = getattr(info, "duration_after_vad", None)
    return {
        "text": " ".join(parts).strip(),
        "language": info.language,
        "audio_seconds": round(seconds, 2),
        # Was die VAD des Servers als Sprache sah, und wie laut es ankam: damit
        # der Browser "zu leise" von "nicht verstanden" trennen kann.
        "speech_seconds": round(after_vad, 2) if isinstance(after_vad, (int, float)) else None,
        "peak_dbfs": measured["peak_dbfs"],
        "rms_dbfs": measured["rms_dbfs"],
        "gain_db": _db(gain),
        "processing_seconds": round(time.monotonic() - started, 2),
        "model": MODEL_NAME,
    }


def _run_and_end(data: bytes, language: str) -> dict:
    try:
        return _run(data, language)
    finally:
        end()


async def transcribe_held(data: bytes, language: str = "de") -> dict:
    """Erkennen; der Aufrufer hält die Sperre aus ``try_begin``. Sie wird hier
    freigegeben — im Arbeits-Thread, sobald er fertig ist."""
    handed = False
    try:
        if not data:
            raise TranscribeError(422, "Die Aufnahme ist leer.")
        if len(data) > MAX_BYTES:
            raise TranscribeError(413, f"Die Aufnahme ist größer als {MAX_BYTES // (1024 * 1024)} MB.")
        lang = language if language in LANGUAGES else "de"
        handed = True
        return await asyncio.to_thread(_run_and_end, data, lang)
    finally:
        if not handed:
            end()


async def transcribe(data: bytes, language: str = "de") -> dict:
    """Bequemer Einstieg für Skripte und Tests: wartet nicht, 409 wenn belegt."""
    if not try_begin():
        raise TranscribeError(409, "Die Spracherkennung ist gerade belegt.")
    return await transcribe_held(data, language)
