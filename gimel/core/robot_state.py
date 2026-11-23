"""Der Zustandsautomat eines Transportauftrags — rein und nachlesbar.

Die Regeln standen bisher verstreut in ``services/robot_jobs``. Hier stehen sie
als eine Tabelle: welche Aktion aus welchem Zustand erlaubt ist, in welchen
Zustand sie führt und warum sie sonst abgelehnt wird. Die Datei kennt keine
Datenbank, keine Uhr und keine Schnittstelle; der Aufrufer entscheidet, wann er
eine Aktion versucht.

Die Wiederholung ist ausdrücklich erlaubt: ``approve`` auf einem bereits
freigegebenen Auftrag, ``start`` auf einem laufenden oder ``done`` auf einem
fertigen ist kein Fehler, sondern dieselbe Tatsache noch einmal. ``assign``
darf einen Auftrag erneut zuweisen, solange er nicht fährt.
"""

from __future__ import annotations

JOB_STATES = ("proposed", "approved", "assigned", "running", "done", "failed", "cancelled")
ACTIVE_STATES = ("proposed", "approved", "assigned", "running")
CLOSED_STATES = ("done", "failed", "cancelled")

#: Zielzustand je Aktion. ``cancel``/``fail`` werden vom Aufrufer gewählt.
TARGET_STATE = {
    "approve": "approved",
    "assign": "assigned",
    "start": "running",
    "done": "done",
    "cancel": "cancelled",
    "fail": "failed",
}

#: Aus welchen Zuständen eine Aktion überhaupt erlaubt ist. ``assign`` schließt
#: ``assigned`` ein, weil ein Auftrag vor dem Start umgehängt werden darf.
SOURCES = {
    "approve": ("proposed",),
    "assign": ("proposed", "approved", "assigned"),
    "start": ("assigned",),
    "done": ("running",),
    "cancel": ACTIVE_STATES,
    "fail": ACTIVE_STATES,
}

#: Aktionen, deren Wiederholung im Zielzustand folgenlos ist.
IDEMPOTENT = ("approve", "start", "done", "cancel", "fail")


def normalize(state: object) -> str:
    value = str(state or "").strip().lower()
    return value if value in JOB_STATES else ""


def is_idempotent(action: str, state: object) -> bool:
    """Ist die Aktion in diesem Zustand schon geschehen?"""
    return action in IDEMPOTENT and normalize(state) == TARGET_STATE.get(action)


def can(action: str, state: object) -> bool:
    """Darf die Aktion aus diesem Zustand laufen?"""
    return normalize(state) in SOURCES.get(action, ())


def target_state(action: str) -> str:
    return TARGET_STATE.get(action, "")


def guard_reason(action: str, state: object) -> str:
    """Der Grund im Klartext, warum eine Aktion nicht läuft — leer heißt ja."""
    current = normalize(state)
    if action not in SOURCES:
        return "Unbekannte Aktion."
    if is_idempotent(action, current):
        return ""
    if current in SOURCES[action]:
        return ""
    if action == "approve":
        return f"Ein Transport im Zustand {current or state} braucht keine Freigabe."
    if action == "assign":
        if current in CLOSED_STATES:
            return "Ein abgeschlossener Transport lässt sich nicht neu zuweisen."
        if current == "running":
            return "Ein laufender Transport wird nicht mitten auf dem Weg umgehängt."
        return "Dieser Transport lässt sich nicht zuweisen."
    if action == "start":
        return "Nur ein zugewiesener Transport kann starten."
    if action == "done":
        return "Nur ein laufender Transport kann abgeschlossen werden."
    return "Der Transport ist bereits abgeschlossen."
