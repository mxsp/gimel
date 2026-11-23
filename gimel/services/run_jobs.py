"""Sammellauf im Hintergrund: ein langer Lauf hält keine Anfrage offen.

Die Aufträge leben im Prozess, wie der Takt in ``scheduler.py``: nach einem
Neustart ist ein laufender Auftrag weg, der Sammellauf selbst steht in der
Datenbank oder wurde nie gespeichert. Es läuft immer nur einer.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections import OrderedDict
from typing import Callable

from ..db import SessionLocal
from .batch_runner import run_batch

log = logging.getLogger("alpha.batch")

_KEEP = 20
_jobs: OrderedDict[str, dict] = OrderedDict()
_lock = threading.Lock()


class Busy(Exception):
    """Ein gezielter Lauf hängt sich nicht an einen fremden: dessen Ergebnis wäre nicht seines."""


def _work(job_id: str, actor: str, force: bool, serialize: Callable,
          only: set[tuple[str, float]] | None = None,
          customers: set[int] | None = None,
          group_by: str | None = None) -> None:
    try:
        with SessionLocal() as db:
            result = serialize(run_batch(
                db, trigger="auswahl" if (only or customers) else "manual",
                actor=actor, force=force, only=only, customers=customers,
                group_by=group_by,
            ))
        update = {"status": "done", "run": result}
    except Exception as exc:  # die Oberfläche soll den Grund sehen, nicht ewig warten
        log.exception("Sammellauf im Hintergrund fehlgeschlagen")
        update = {"status": "failed", "error": str(exc)[:300]}
    with _lock:
        _jobs[job_id].update(update)


def start(actor: str, force: bool, serialize: Callable,
          only: set[tuple[str, float]] | None = None,
          customers: set[int] | None = None,
          group_by: str | None = None) -> dict:
    """Startet einen Lauf; läuft schon einer, kommt dessen Auftrag zurück.
    Mit ``only`` oder ``customers`` gibt es dann ``Busy``."""
    with _lock:
        for job in _jobs.values():
            if job["status"] == "running":
                if only or customers:
                    raise Busy
                return dict(job)
        job = {"id": uuid.uuid4().hex, "status": "running", "run": None, "error": ""}
        _jobs[job["id"]] = job
        while len(_jobs) > _KEEP:
            _jobs.popitem(last=False)
    threading.Thread(target=_work,
                     args=(job["id"], actor, force, serialize, only, customers, group_by),
                     name="sammellauf", daemon=True).start()
    return dict(job)


def get(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None
