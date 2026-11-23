"""Task 43: leise Aufnahmen kommen an und werden verstanden.

Gefunden 2026-11-08: Der Browser verwarf Sprache unter ≈ −42 dBFS, obwohl Whisper
sie bei −50 dBFS fast wortgenau erkennt. Der Server hebt leise Aufnahmen jetzt an
und meldet ihren Pegel, damit der Browser "zu leise" von "nicht verstanden" trennt.
"""

from __future__ import annotations

import io
import shutil
import subprocess
import wave

import numpy as np
import pytest

from agentlab import transcribe


def test_levels_of_silence_and_signal():
    assert transcribe.levels(np.zeros(16000, np.float32)) == {"peak_dbfs": None, "rms_dbfs": None}
    tone = (0.01 * np.sin(np.linspace(0, 2 * np.pi * 300, 16000))).astype(np.float32)
    lv = transcribe.levels(tone)
    assert lv["peak_dbfs"] == pytest.approx(-40.0, abs=0.2)
    assert lv["rms_dbfs"] == pytest.approx(-43.0, abs=0.3)


def test_normalise_lifts_quiet_never_lowers_and_caps_gain():
    quiet = np.full(100, 0.01, np.float32)
    out, gain = transcribe.normalise(quiet)
    assert gain == pytest.approx(50.0)
    assert float(np.max(np.abs(out))) == pytest.approx(transcribe.NORM_TARGET_PEAK)

    loud = np.full(100, 0.8, np.float32)
    out, gain = transcribe.normalise(loud)
    assert gain == 1.0 and out is loud

    hiss = np.full(100, 1e-5, np.float32)
    out, gain = transcribe.normalise(hiss)
    assert gain == transcribe.NORM_MAX_GAIN  # höchstens +40 dB

    zero = np.zeros(100, np.float32)
    assert transcribe.normalise(zero)[1] == 1.0


def test_response_reports_levels(client, monkeypatch):
    """Die Antwort trägt Pegel und Sprachdauer; Whisper bekommt die angehobene Aufnahme."""
    seen = {}

    class Info:
        language = "de"
        duration_after_vad = 0.8

    class Model:
        def transcribe(self, audio, **kw):
            seen["peak"] = float(np.max(np.abs(audio)))
            return iter(()), Info()

    quiet = (0.003 * np.sin(np.linspace(0, 2 * np.pi * 200, 16000))).astype(np.float32)
    monkeypatch.setattr(transcribe, "_decode", lambda data: (quiet, 1.0))
    monkeypatch.setattr(transcribe, "_get_model", lambda: Model())
    out = transcribe._run(b"x", "de")
    assert out["text"] == ""
    assert out["peak_dbfs"] == pytest.approx(-50.5, abs=0.3)
    assert out["speech_seconds"] == 0.8
    assert out["gain_db"] == 40.0  # gekappt
    assert seen["peak"] > 0.1


def _espeak_wav(text: str, db: float) -> bytes:
    raw = subprocess.run(["espeak", "-v", "de", "-s", "150", "--stdout", text],
                         capture_output=True, check=True, timeout=30).stdout
    with wave.open(io.BytesIO(raw)) as w:
        rate = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    rms = float(np.sqrt(np.mean(x ** 2)))
    rng = np.random.default_rng(3)
    y = x * (10 ** (db / 20) / rms)
    y = np.concatenate([np.zeros(rate // 2), y, np.zeros(rate // 2)]) + rng.normal(0, 10 ** (-63 / 20), len(y) + rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(np.clip(y * 32767, -32768, 32767).astype(np.int16).tobytes())
    return buf.getvalue()


@pytest.mark.skipif(not transcribe.available() or shutil.which("espeak") is None,
                    reason="faster-whisper oder espeak fehlt")
def test_quiet_speech_is_understood():
    """−50 dBFS mit Raumrauschen (−63 dBFS, gemessen 2026-11-08) → verstanden."""
    import asyncio

    data = _espeak_wav("Wie viele Aufträge sind heute fällig?", -50)
    out = asyncio.run(transcribe.transcribe(data, "de"))
    assert "aufträge" in out["text"].lower(), out
    assert out["peak_dbfs"] is not None and out["peak_dbfs"] < -30
