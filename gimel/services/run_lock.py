"""Prozessübergreifende Sperre für den Sammellauf.

Der Thread-Lock in ``batch_runner`` schützt nur einen Prozess. Sobald zwei
uvicorn-Worker oder ein zweiter CLI-Aufruf laufen, sehen beide dieselben
wartenden Positionen und planen sie doppelt. Die Sperre liegt deshalb in der
Datenbank: eine Zeile mit Eigentümer und Ablaufzeit. Ein abgestürzter Prozess
blockiert höchstens bis zum Ablauf, danach darf der nächste übernehmen.
"""

from __future__ import annotations

import os
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Iterator

from sqlalchemy.exc import IntegrityError

from ..db import SessionLocal
from ..models import RuntimeLock


class Busy(RuntimeError):
    """Ein anderer Prozess hält die Sperre."""


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


@contextmanager
def hold(key: str = "batch", *, ttl_minutes: int = 360) -> Iterator[str]:
    """Sperre holen, Arbeit tun, Sperre in jedem Fall freigeben."""
    owner = f"{os.getpid()}:{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=max(1, ttl_minutes))
    with SessionLocal() as db:
        row = db.get(RuntimeLock, key)
        if row is not None:
            held_until = _aware(row.expires_at)
            if held_until is not None and held_until > now:
                raise Busy(
                    "Ein Sammellauf läuft bereits — bitte warten, bis er fertig ist."
                )
            db.delete(row)
            db.flush()
        db.add(RuntimeLock(key=key, owner=owner, acquired_at=now,
                           expires_at=expires))
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise Busy(
                "Ein Sammellauf läuft bereits — bitte warten, bis er fertig ist."
            ) from exc
    try:
        yield owner
    finally:
        with SessionLocal() as db:
            row = db.get(RuntimeLock, key)
            if row is not None and row.owner == owner:
                db.delete(row)
                db.commit()
