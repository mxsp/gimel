"""Sprachausgabe für den Assistenten — lokal als Vorgabe.

Zwei Wege, gewählt in den Labor-Einstellungen (``agent_tts_backend``):

- ``lokal`` (Vorgabe): **Piper**, ein kleines neuronales Sprachmodell
  (ONNX, CPU), das auf diesem Rechner spricht. Kein Text verlässt den
  Rechner. Stimmen liegen als ``<name>.onnx`` + ``.onnx.json`` in
  ``GIMEL_VOICE_PIPER_DIR`` (Vorgabe ``~/.local/share/gimel/piper-voices``).
  Fehlt Piper oder eine Stimme, antwortet der Endpunkt 503 und die
  Oberfläche spricht mit einer *lokalen* Browserstimme.
- ``edge``: ``edge-tts``, ein inoffizieller Client für Microsofts
  Vorlesedienst. Der Antworttext geht an Microsoft (kein Vertrag, keine
  AVV, der Dienst kann jederzeit wegfallen) — nur für fiktive Demodaten.
  Ausdrücklich einzuschalten; das Paket steckt nur im Extra ``[tts]``.
"""

from __future__ import annotations

import asyncio
import io
import os
import threading
import wave
from pathlib import Path

BACKENDS = ("lokal", "edge")
DEFAULT_BACKEND = "lokal"

EDGE_VOICES: dict[str, str] = {
    "de-DE-KatjaNeural": "Katja (Microsoft)",
    "de-DE-ConradNeural": "Conrad (Microsoft)",
    "de-DE-FlorianMultilingualNeural": "Florian (Microsoft)",
    "de-DE-SeraphinaMultilingualNeural": "Seraphina (Microsoft)",
}
EDGE_DEFAULT = "de-DE-KatjaNeural"
# Älterer Name, den Tests und das Labor kennen.
VOICES = EDGE_VOICES
DEFAULT_VOICE = EDGE_DEFAULT

PIPER_DEFAULT = "de_DE-thorsten-medium"
MAX_CHARS = 3000

_piper_cache: dict[str, object] = {}
_piper_lock = threading.Lock()
# Höchstens zwei Synthesen zugleich (Gimel Voice holt den nächsten Satz vorab).
# Wartende halten keinen Thread: das Semaphor sitzt vor ``to_thread``.
# Je Ereignisschleife eines (ein Semaphor gehört zu genau einer Schleife).
_piper_slots: dict[int, asyncio.Semaphore] = {}


def _slots() -> asyncio.Semaphore:
    key = id(asyncio.get_running_loop())
    slot = _piper_slots.get(key)
    if slot is None:
        slot = _piper_slots[key] = asyncio.Semaphore(2)
    return slot


class SpeechUnavailable(RuntimeError):
    """Kein Server-TTS verfügbar; der Aufrufer fällt auf den Browser zurück."""


def piper_dir() -> Path:
    raw = os.environ.get("GIMEL_VOICE_PIPER_DIR", "")
    return Path(raw).expanduser() if raw else Path.home() / ".local/share/gimel/piper-voices"


def _piper_installed() -> bool:
    try:
        import piper  # noqa: F401
    except ImportError:
        return False
    return True


def _edge_installed() -> bool:
    try:
        import edge_tts  # noqa: F401
    except ImportError:
        return False
    return True


def piper_voices() -> dict[str, str]:
    """Stimmen im Stimmordner: Dateiname ohne Endung → lesbarer Name."""
    folder = piper_dir()
    if not folder.is_dir():
        return {}
    out: dict[str, str] = {}
    for model in sorted(folder.glob("*.onnx")):
        if not model.with_suffix(".onnx.json").exists():
            continue
        name = model.stem  # z. B. de_DE-thorsten-medium
        parts = name.split("-")
        speaker = parts[1].replace("_", " ").title() if len(parts) > 1 else name
        quality = parts[2] if len(parts) > 2 else ""
        out[name] = f"{speaker} ({parts[0]}, {quality}, lokal)" if quality else f"{speaker} (lokal)"
    return out


def voices(backend: str) -> dict[str, str]:
    return EDGE_VOICES if backend == "edge" else piper_voices()


def default_voice(backend: str) -> str:
    if backend == "edge":
        return EDGE_DEFAULT
    found = piper_voices()
    if PIPER_DEFAULT in found:
        return PIPER_DEFAULT
    return next(iter(found), "")


def available(backend: str = DEFAULT_BACKEND) -> bool:
    if backend == "edge":
        return _edge_installed()
    return _piper_installed() and bool(piper_voices())


def media_type(backend: str) -> str:
    return "audio/mpeg" if backend == "edge" else "audio/wav"


def _clean(text: str) -> str:
    clean = " ".join(text.split())
    if not clean:
        raise SpeechUnavailable("Der Text ist leer.")
    return clean[:MAX_CHARS]


def _piper_voice(name: str):
    with _piper_lock:
        voice = _piper_cache.get(name)
        if voice is None:
            from piper import PiperVoice

            voice = PiperVoice.load(str(piper_dir() / f"{name}.onnx"))
            _piper_cache[name] = voice
        return voice


def _piper_wav(text: str, name: str, rate: float = 1.0) -> bytes:
    voice = _piper_voice(name)
    buf = io.BytesIO()
    config = None
    if abs(rate - 1.0) > 0.01:
        from piper import SynthesisConfig

        # Piper dehnt die Laute: kleinere length_scale = schneller, Tonhöhe bleibt.
        config = SynthesisConfig(length_scale=1.0 / rate)
    with wave.open(buf, "wb") as out:
        voice.synthesize_wav(text, out, syn_config=config)  # type: ignore[attr-defined]
    return buf.getvalue()


async def _synthesize_piper(text: str, voice: str, rate: float = 1.0) -> bytes:
    if not _piper_installed():
        raise SpeechUnavailable(
            "Lokale Sprachausgabe fehlt. Bitte `pip install -e \".[voice]\"` nachholen."
        )
    found = piper_voices()
    chosen = voice if voice in found else default_voice("lokal")
    if not chosen:
        raise SpeechUnavailable(
            f"Keine Piper-Stimme in {piper_dir()}. Nachholen mit "
            "`python -m piper.download_voices --download-dir <Ordner> de_DE-thorsten-medium`."
        )
    try:
        async with _slots():
            audio = await asyncio.to_thread(_piper_wav, text, chosen, rate)
    except Exception as exc:  # beschädigte Stimme, Speicher
        raise SpeechUnavailable(f"Lokale Sprachausgabe fehlgeschlagen: {exc}") from exc
    if len(audio) <= 44:
        raise SpeechUnavailable("Die Sprachausgabe lieferte kein Audio.")
    return audio


async def _synthesize_edge(text: str, voice: str, rate: float = 1.0) -> bytes:
    try:
        import edge_tts
    except ImportError as exc:
        raise SpeechUnavailable(
            "Microsoft-Sprachausgabe fehlt (`pip install -e \".[tts]\"`)."
        ) from exc
    chosen = voice if voice in EDGE_VOICES else EDGE_DEFAULT
    audio: list[bytes] = []
    try:
        percent = round((rate - 1.0) * 100)
        communicate = edge_tts.Communicate(text, chosen, rate=f"{percent:+d}%")
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                audio.append(chunk["data"])
    except Exception as exc:  # Netzfehler, Sperre, geänderter Dienst
        raise SpeechUnavailable(f"Sprachausgabe nicht erreichbar: {exc}") from exc
    if not audio:
        raise SpeechUnavailable("Die Sprachausgabe lieferte kein Audio.")
    return b"".join(audio)


RATE_MIN, RATE_MAX = 0.8, 1.4


async def synthesize(text: str, voice: str = "", backend: str = DEFAULT_BACKEND, rate: float = 1.0) -> bytes:
    """Text sprechen: WAV (lokal) oder MP3 (edge). ``voice`` wird gegen die Liste geprüft,
    ``rate`` (Sprechtempo, 1 = normal) auf 0,8…1,4 begrenzt."""
    clean = _clean(text)
    rate = min(RATE_MAX, max(RATE_MIN, float(rate or 1.0)))
    if backend == "edge":
        return await _synthesize_edge(clean, voice, rate)
    return await _synthesize_piper(clean, voice, rate)
