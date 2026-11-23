"""Opt-in Netz-Freigabe für die digitale Laufkarte eines Innenauftrags.

Standardmäßig ist keine Laufkarte über das Netz erreichbar. Erst wenn das Büro
die Freigabe für einen Innenauftrag ausdrücklich einschaltet, entsteht ein
zufälliger, widerrufbarer Link unter ``/laufkarte/<token>`` — wahlweise
anonymisiert für die Werkstatt (``floor``, Vorgabe: ohne Kundennamen,
Anschriften und Preise) oder vollständig (``office``).

Gespeichert wird in der vorhandenen Tabelle ``settings`` unter dem Schlüssel
``laufkarte_share:<IA-Nr>``, damit kein Schema-Umbau nötig ist.
"""

from __future__ import annotations

import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal

from sqlalchemy.orm import Session

from ..models import Setting

PREFIX = "laufkarte_share:"
ShareMode = Literal["floor", "office"]
DEFAULT_EXPIRES_DAYS = 14


def _key(wo_no: str) -> str:
    return f"{PREFIX}{wo_no.strip()}"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _is_expired(expires_at: str | None) -> bool:
    if not expires_at:
        return False
    try:
        dt = datetime.fromisoformat(expires_at)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt <= _now()
    except ValueError:
        return True


def _parse(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            return None
        return data
    except Exception:
        return None


def get_share(db: Session, wo_no: str) -> dict | None:
    """Liefert den Freigabestand eines Innenauftrags (oder ``None``, wenn nie freigegeben)."""
    row = db.get(Setting, _key(wo_no))
    if not row:
        return None
    data = _parse(row.value)
    if not data:
        return None
    expired = _is_expired(data.get("expires_at"))
    return {
        "enabled": bool(data.get("enabled")) and not expired and bool(data.get("token")),
        "expired": expired,
        "token": str(data.get("token") or ""),
        "mode": "office" if data.get("mode") == "office" else "floor",
        "created_at": str(data.get("created_at") or ""),
        "created_by": str(data.get("created_by") or ""),
        "expires_at": data.get("expires_at") or None,
    }


def set_share(
    db: Session,
    wo_no: str,
    *,
    enabled: bool,
    mode: ShareMode = "floor",
    expires_days: int | None = DEFAULT_EXPIRES_DAYS,
    rotate: bool = False,
    actor_email: str = "",
) -> dict:
    """Aktiviert, aktualisiert, rotiert oder pausiert die Netz-Freigabe."""
    key = _key(wo_no)
    existing = get_share(db, wo_no) or {}
    clean_mode: ShareMode = "office" if mode == "office" else "floor"

    token = existing.get("token") or ""
    if enabled and (rotate or not token):
        token = secrets.token_urlsafe(24)

    now = _now()
    if enabled:
        if expires_days is not None and expires_days > 0:
            expires_at = (now + timedelta(days=min(365, int(expires_days)))).isoformat()
        else:
            expires_at = None
    else:
        expires_at = existing.get("expires_at")

    payload = {
        "enabled": bool(enabled),
        "token": token,
        "mode": clean_mode,
        "created_at": now.isoformat() if (rotate or not existing.get("created_at")) else existing["created_at"],
        "created_by": actor_email or existing.get("created_by") or "",
        "expires_at": expires_at,
    }
    row = db.get(Setting, key)
    if row is None:
        row = Setting(key=key, value=json.dumps(payload))
        db.add(row)
    else:
        row.value = json.dumps(payload)
    db.commit()
    return {
        **payload,
        "expired": False,
    }


def revoke_share(db: Session, wo_no: str) -> None:
    """Widerruft die Netz-Freigabe sofort und löscht das Token."""
    row = db.get(Setting, _key(wo_no))
    if row is not None:
        db.delete(row)
        db.commit()


def resolve_token(db: Session, token: str) -> tuple[str, dict] | None:
    """Findet den freigegebenen Innenauftrag per konstant-zeitigem Token-Vergleich."""
    candidate = (token or "").strip()
    if len(candidate) < 16 or len(candidate) > 128:
        return None
    rows = db.query(Setting).filter(Setting.key.like(f"{PREFIX}%")).all()
    matched: tuple[str, dict] | None = None
    for row in rows:
        data = _parse(row.value)
        if not data:
            continue
        stored = str(data.get("token") or "")
        if stored and hmac.compare_digest(stored, candidate):
            wo_no = row.key[len(PREFIX):]
            if data.get("enabled") and not _is_expired(data.get("expires_at")):
                matched = (
                    wo_no,
                    {
                        "enabled": True,
                        "expired": False,
                        "token": stored,
                        "mode": "office" if data.get("mode") == "office" else "floor",
                        "created_at": str(data.get("created_at") or ""),
                        "created_by": str(data.get("created_by") or ""),
                        "expires_at": data.get("expires_at") or None,
                    },
                )
    return matched


def share_url(base_url: str, token: str) -> str:
    return f"{base_url.rstrip('/')}/laufkarte/{token}"
