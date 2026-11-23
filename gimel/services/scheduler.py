"""Taktgeber für den Sammellauf.

Ein Hintergrund-Task, der im eingestellten Takt ``run_batch`` aufruft. Der Takt
kommt aus der Datenbank und wird **vor jedem Schlaf** neu gelesen — wer im
Admin-Panel von 10 Minuten auf 1 Minute stellt, soll nicht bis zum nächsten Lauf
warten müssen, um die Änderung zu sehen.

Bewusst asyncio und kein Celery/APScheduler: ein Prozess, ein Takt, keine
zusätzliche Infrastruktur. Sobald mehrere API-Instanzen laufen, braucht es eine
Sperre (Advisory Lock in Postgres), sonst schachteln zwei Prozesse dieselben
Positionen doppelt — der Platz dafür ist unten markiert.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from ..db import SessionLocal
from . import settings_store
from . import factory_router
from . import worklist
from .batch_runner import run_batch

log = logging.getLogger("alpha.scheduler")

# Sichtbarer Zustand für das Admin-Panel
state: dict[str, object] = {
    "running": False,
    "last_run_at": None,
    "last_run_no": None,
    "last_error": None,
    "next_run_at": None,
    "interval_minutes": None,
}

# Der Arbeitsvorrat läuft in seinem eigenen, kurzen Takt — unabhängig vom
# Sammellauf. Neue Aufgaben (frisch übernommene Aufträge, neue Innenaufträge)
# erscheinen so binnen einer halben Minute auf den Stationen, ohne dass die
# Oberfläche selbst schreiben darf (``board`` ist rein lesend).
WORKLIST_INTERVAL_S = 30.0
worklist_state: dict[str, object] = {
    "interval_s": WORKLIST_INTERVAL_S,
    "last_tick_at": None,
    "last_applied": 0,
    "last_error": None,
}


def _worklist_tick_once() -> None:
    """Abgleich und Verteilung des Arbeitsvorrats — in eigenen Händen.

    Eigener try-Block: ein Fehler hier darf weder den Sammellauf färben noch
    den Taktgeber sterben lassen. Das Muster stammt aus der Zeit, als dieser
    Block im Sammellauf-Tick hing.
    """
    db = SessionLocal()
    try:
        worklist.reconcile(db, who="scheduler")
        if worklist.worklist_auto_enabled(db):
            applied = worklist.apply_plan(
                db, worklist.plan(db), who="scheduler", only_auto=True
            )
            worklist_state["last_applied"] = len(applied)
            if applied:
                log.info("Arbeitsvorrat: %s Aufgaben zugeteilt", len(applied))
        else:
            worklist.resequence(db)
        worklist_state["last_error"] = None
    except Exception:  # noqa: BLE001 — der Vorrat darf den Takt nicht killen
        worklist_state["last_error"] = "Aufgabenabgleich fehlgeschlagen (siehe Log)"
        log.exception("Arbeitsvorrat fehlgeschlagen — Sammellauf blieb unberührt")
        db.rollback()
    finally:
        worklist_state["last_tick_at"] = datetime.now(timezone.utc).isoformat()
        db.close()


def _tick_once() -> None:
    db = SessionLocal()
    try:
        # TODO bei mehreren Instanzen: SELECT pg_try_advisory_lock(…) davor,
        # sonst greifen zwei Prozesse dieselben wartenden Positionen.
        run = run_batch(db, trigger="interval", actor="scheduler")
        state["last_run_at"] = datetime.now(timezone.utc).isoformat()
        state["last_run_no"] = run.no
        state["last_error"] = None
        if run.n_work_orders:
            log.info(
                "Sammellauf %s: %s Innenaufträge, %s Platten, %s Teile",
                run.no,
                run.n_work_orders,
                run.n_plates,
                run.n_parts,
            )
        # Nachschub: jede frisch freigegebene Innenauftrag ist eine Chance,
        # eine leere Maschine zu füttern — und jede Maschine, die seit dem
        # letzten Takt fertig geworden ist, ohne dass neue Zuordnung kam.
        # Eigener try-Block: ein Routing-Fehler darf den Sammellauf nicht
        # rot färben, der ist älter und wichtiger.
        try:
            fed = factory_router.ensure_fed(db, who="scheduler")
            if fed:
                log.info(
                    "Nachschub: %s Innenaufträge auf leere Stationen verteilt",
                    len(fed),
                )
        except Exception:  # noqa: BLE001
            log.exception("Nachschub fehlgeschlagen — Sammellauf blieb unberührt")
            db.rollback()
        # Der Arbeitsvorrat tickt separat (``_worklist_tick_once``, alle 30 s)
        # — hier gehört er nicht mehr hin: derselbe Abgleich zweimal im
        # Minutentakt wäre Arbeit, die niemand bestellt hat.
    except Exception as exc:  # noqa: BLE001 — Takt darf nie sterben
        state["last_error"] = f"{type(exc).__name__}: {exc}"
        log.exception("Sammellauf fehlgeschlagen")
        db.rollback()
    finally:
        db.close()


RETENTION_INTERVAL_S = 24 * 3600


def _retention_tick_once() -> None:
    """Fristen für Kontaktdaten auch auf einem Server durchsetzen, der wochenlang läuft.

    Beim Start laufen beide Bereinigungen ohnehin (main.lifespan); ohne diesen Takt
    hinge die Löschfrist der Datenschutzerklärung am nächsten Neustart.
    """
    from . import compliance, mailer

    with SessionLocal() as db:
        try:
            mailer.purge_expired_contacts(db)
            compliance.purge_reporter_contacts(db)
        except Exception:  # noqa: BLE001 — Takt darf nie sterben
            log.exception("Fristenbereinigung fehlgeschlagen")
            db.rollback()


async def loop() -> None:
    state["running"] = True
    # 0.0 = beide Takte laufen beim Start sofort an; danach halten die eigenen
    # Fristen. Geschlafen wird in kurzen Schritten, damit der Sammellauf-Takt
    # weiter vor jedem Schlaf gelesen wird (das Versprechen aus dem Kopf dieses
    # Moduls) und der Vorratstakt unabhängig davon läuft.
    next_batch = 0.0
    next_worklist = 0.0
    next_retention = datetime.now(timezone.utc).timestamp() + RETENTION_INTERVAL_S  # der Start hat schon bereinigt
    try:
        while True:
            try:
                now_ts = datetime.now(timezone.utc).timestamp()

                if now_ts >= next_retention:
                    next_retention = now_ts + RETENTION_INTERVAL_S
                    await asyncio.to_thread(_retention_tick_once)

                if now_ts >= next_worklist:
                    next_worklist = now_ts + WORKLIST_INTERVAL_S
                    await asyncio.to_thread(_worklist_tick_once)

                db = SessionLocal()
                try:
                    enabled = settings_store.get_bool(db, "batch_enabled", True)
                    minutes = max(
                        1, settings_store.get_int(db, "batch_interval_minutes", 10)
                    )
                finally:
                    db.close()
                state["interval_minutes"] = minutes

                if now_ts >= next_batch:
                    next_batch = now_ts + minutes * 60
                    if enabled:
                        await asyncio.to_thread(_tick_once)
                    else:
                        state["last_error"] = None
                    nxt = datetime.now(timezone.utc).timestamp() + minutes * 60
                    state["next_run_at"] = datetime.fromtimestamp(
                        nxt, timezone.utc
                    ).isoformat()

                await asyncio.sleep(5.0)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                state["last_error"] = f"{type(exc).__name__}: {exc}"
                log.exception("Scheduler-Loop Crash — Neustart in 10s")
                await asyncio.sleep(10)
    except asyncio.CancelledError:
        state["running"] = False
        raise
    except Exception:
        state["running"] = False
        log.exception("Scheduler-Loop endgültig abgestürzt")
        raise
