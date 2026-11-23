"""Gimel Voice: Spracherkennung und Auskunft — nur im Agent Lab eingebunden.

Absichtlich ein eigener Router: ``gimel.agent_bridge`` bindet ``router`` in
jedes eigenständige Gimel ein, auch in die öffentlich getunnelte Demo. Die
Erkennung kostet Rechenzeit und Speicher je Anfrage; sie gehört nur in das
Labor (``create_lab_app``), das Studio und den eigenen Voice-Prozess — sowie
als ausdrückliches Opt-in (``GIMEL_VOICE=1``) in das Test-Portal auf 8040,
solange kein Tunnel darauf zeigt.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from gimel.db import get_db
from gimel.models import User
from gimel.security import require_worker

from . import speech as speech_service
from . import transcribe as transcribe_service
from .models import AgentProvider
from .router import _tts_backend

voice_router = APIRouter(prefix="/api/agent", tags=["agent-voice"])

_AUDIO_TYPES = ("audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/wave",
                "audio/mp4", "audio/mpeg", "audio/aac", "video/webm")


@voice_router.get("/voice")
def voice_info(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    backend = _tts_backend(db)
    provider = (db.query(AgentProvider).filter(AgentProvider.is_default.is_(True))
                .order_by(AgentProvider.id).first())
    return {
        "tts_backend": backend,
        "llm_provider": getattr(provider, "name", "") or "",
        "stt_available": transcribe_service.available(),
        "stt_loaded": transcribe_service.loaded(),
        "stt_model": transcribe_service.MODEL_NAME,
        "max_seconds": int(transcribe_service.MAX_SECONDS),
        "tts_available": speech_service.available(backend),
        "default_voice": speech_service.default_voice(backend),
        "voices": [{"id": key, "name": name} for key, name in speech_service.voices(backend).items()],
    }


@voice_router.post("/transcribe")
async def transcribe_audio(
    request: Request,
    user: Annotated[User, Depends(require_worker)],
    language: str = "de",
) -> dict:
    """Aufnahme als roher Körper (kein Formular, keine Datei auf der Platte)."""
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype not in _AUDIO_TYPES:
        raise HTTPException(status_code=415, detail="Bitte eine Audioaufnahme senden.")
    if not transcribe_service.available():
        raise HTTPException(
            status_code=503,
            detail="Spracherkennung fehlt. Bitte `pip install -e \".[voice]\"` nachholen.",
        )
    limit = transcribe_service.MAX_BYTES
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=413, detail="Die Aufnahme ist zu groß.")
    # Erst die Sperre, dann der Körper: wartende Anfragen halten so weder
    # Speicher noch einen Thread.
    if not transcribe_service.try_begin():
        raise HTTPException(status_code=409, detail="Die Spracherkennung ist gerade belegt. Bitte gleich noch einmal.",
                            headers={"Retry-After": "3"})
    handed = False
    try:
        chunks: list[bytes] = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > limit:
                raise HTTPException(status_code=413, detail="Die Aufnahme ist zu groß.")
            chunks.append(chunk)
        handed = True
        return await transcribe_service.transcribe_held(b"".join(chunks), language)
    except transcribe_service.TranscribeError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    finally:
        if not handed:
            transcribe_service.end()
