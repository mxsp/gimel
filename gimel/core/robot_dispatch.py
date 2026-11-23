"""Welcher Roboter bekommt den Transport? Eine reine, nachlesbare Entscheidung.

Die Auswahl ist kein Lernsystem und keine BLACKBOX: sie prüft harte Schranken
(aktiv, nicht gestört, Fähigkeit, Nutzlast, Akku-Reserve, bekannte Position)
und sortiert die Übrigen nach Nähe zum Start, mit einem kleinen Abzug für einen
schwachen Akku. Gleiche Eingabe ergibt dieselbe Reihenfolge; bei Gleichstand
gewinnt die kleinere id.

Die Datei kennt keine Wege und keine Uhr. Der Aufrufer übergibt die Positionen
und die Nutzlast; die echte Fahrstrecke rechnet ``robot_way``. So bleibt die
Entscheidung prüfbar, auch wenn später ein anderer Wegplaner dazukommt.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import math
from typing import Optional, Sequence

Point = tuple[float, float]

#: Unter diesem Akkustand wird ein Roboter nicht mehr für einen neuen Auftrag
#: vorgeschlagen. 0 % ist leer, ``None`` unbekannt — nur der bekannte Wert zählt.
MIN_BATTERY_PCT = 20


@dataclass(frozen=True)
class RobotOption:
    """Was die Auswahl über einen Roboter wissen muss."""

    id: int
    name: str = "Roboter"
    x: Optional[float] = None
    y: Optional[float] = None
    battery_pct: Optional[int] = None
    payload_kg: float = 0.0
    capabilities: tuple[str, ...] = ()
    state: str = "idle"
    active: bool = True
    floor_id: Optional[int] = None
    speed_m_s: float = 0.0


@dataclass(frozen=True)
class RobotChoice:
    """Ein geeigneter Roboter mit Abstand und Begründung."""

    robot_id: int
    name: str
    distance_m: float
    score: float
    reason: str


@dataclass(frozen=True)
class RejectedRobot:
    """Ein Roboter, der nicht darf — mit dem Grund im Klartext."""

    robot_id: int
    name: str
    reason: str


def rank_robots(
    *,
    start: Point,
    robots: Sequence[RobotOption],
    payload_kg: float = 0.0,
    capability: str = "",
    min_battery_pct: int = MIN_BATTERY_PCT,
) -> tuple[list[RobotChoice], list[RejectedRobot]]:
    """Geeignete Roboter in fahrbarer Reihenfolge und die Ausgeschlossenen.

    ``battery_pct is None`` heißt unbekannt und schließt nicht aus; es wird
    aber auch nicht als voll gewertet. ``payload_kg == 0`` beim Roboter heißt
    unbekannt, nicht „kann nichts tragen".
    """
    choices: list[RobotChoice] = []
    rejected: list[RejectedRobot] = []
    needed = max(0.0, float(payload_kg))
    for robot in robots:
        state = (robot.state or "idle").strip().lower()
        if not robot.active:
            rejected.append(RejectedRobot(robot.id, robot.name, "inaktiv"))
            continue
        if state in ("offline", "error", "blocked", "charging"):
            rejected.append(RejectedRobot(robot.id, robot.name, f"Zustand {state}"))
            continue
        if capability and capability not in robot.capabilities:
            rejected.append(RejectedRobot(robot.id, robot.name, f"kann {capability} nicht"))
            continue
        if needed > 0 and robot.payload_kg > 0 and needed > robot.payload_kg:
            rejected.append(
                RejectedRobot(robot.id, robot.name,
                              f"Nutzlast {robot.payload_kg:g} kg zu klein")
            )
            continue
        if robot.battery_pct is not None and robot.battery_pct < min_battery_pct:
            rejected.append(
                RejectedRobot(robot.id, robot.name,
                              f"Akku {robot.battery_pct} % — Reserve fehlt")
            )
            continue
        if robot.x is None or robot.y is None:
            rejected.append(RejectedRobot(robot.id, robot.name, "Position unbekannt"))
            continue
        distance = math.dist(start, (float(robot.x), float(robot.y)))
        if not math.isfinite(distance):
            rejected.append(RejectedRobot(robot.id, robot.name, "Position unbrauchbar"))
            continue
        battery_note = ("Akku unbekannt" if robot.battery_pct is None
                        else f"Akku {robot.battery_pct} %")
        load_note = ("Nutzlast unbekannt" if robot.payload_kg <= 0
                     else f"Nutzlast {robot.payload_kg:g} kg")
        score = distance + (0.0 if robot.battery_pct is None
                            else (100 - robot.battery_pct) * 0.02)
        choices.append(
            RobotChoice(
                robot_id=robot.id,
                name=robot.name,
                distance_m=round(distance, 2),
                score=round(score, 3),
                reason=f"{distance:.1f} m zum Start · {battery_note} · {load_note}",
            )
        )
    choices.sort(key=lambda c: (c.score, c.robot_id))
    rejected.sort(key=lambda r: r.robot_id)
    return choices, rejected
