"""Die Roboterplattform: Gateways, Programme, Transporte, Wege und Telemetrie.

Die Routen sind bewusst von ``/robots`` getrennt: die Flotte bleibt lesbar,
die Plattform bekommt eigene Namen. Dieses Modul ist nur noch die Klammer —
die fünf Themen liegen in eigenen Dateien, damit keine davon wieder 600 Zeilen
bekommt. Der Präfix und damit jede URL bleiben unverändert; ``app.py`` und
Alefs ``app/_moved.py`` registrieren weiterhin genau diesen einen Router.

Sicherheit: Telemetrie meldet ein Gateway mit seinem Token, nicht mit einem
Benutzerkonto. Alles, was schreibt, ist protokolliert. Es gibt keinen Befehl
an einen Antrieb und keinen Not-Halt über diese API.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import (
    robot_gateway_routes,
    robot_job_routes,
    robot_program_routes,
    robot_telemetry_routes,
    robot_way_routes,
)

router = APIRouter(prefix="/api/factory", tags=["robots"])

router.include_router(robot_gateway_routes.router)
router.include_router(robot_program_routes.router)
router.include_router(robot_job_routes.router)
router.include_router(robot_way_routes.router)
router.include_router(robot_telemetry_routes.router)
