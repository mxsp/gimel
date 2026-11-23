"""Löschfrist für die Kontaktdaten aus Schwachstellenmeldungen.

Läuft beim Start (``app.py``) und täglich im Takt (``services/scheduler.py``); die
Routen dazu liegen in ``routers/compliance.py``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..config import ENV_PREFIX
from ..models import AuditLog, VulnerabilityReport
from . import smtp_client

log = logging.getLogger(__name__)


def retention_days() -> int:
    try:
        return max(30, int(smtp_client._env(ENV_PREFIX + "SECURITY_CONTACT_RETENTION_DAYS", "365")))
    except ValueError:
        return 365


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def purge_reporter_contacts(db: Session, now: datetime | None = None) -> int:
    """Name und E-Mail der Meldenden nach Abschluss + Frist löschen; die Meldung bleibt."""
    moment = now or datetime.now(timezone.utc)
    cutoff = moment - timedelta(days=retention_days())
    rows = [
        r for r in db.query(VulnerabilityReport).filter(
            VulnerabilityReport.contact_purged_at.is_(None),
            VulnerabilityReport.closed_at.isnot(None),
        ).all()
        if _aware(r.closed_at) < cutoff
    ]
    for r in rows:
        r.reporter_name = ""
        r.reporter_email = ""
        r.contact_purged_at = moment
        db.add(AuditLog(actor="system", action="vr_contact_purged", entity="vulnerability_report", entity_id=r.ref))
    if rows:
        db.commit()
        log.info("Meldekontakte nach Frist gelöscht: %d", len(rows))
    return len(rows)
