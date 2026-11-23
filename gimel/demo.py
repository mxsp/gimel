"""The demo plant "Musterwerk GmbH" — fictional, for trying Gimel out.

Every name, number and customer here is made up. Machine values are plausible
round numbers, not measurements.

The demo is deliberately more than a single hall: one site with two halls and
five levels, with machines, offices, racks and shipping points on each. That
gives the floor switcher, the 3D view, the worklist and the "Fertigen in"
scope something real to show. A few orders carry a routing scope so the effect
of a scope is visible without editing data.

The seed leaves the plant mid-day: earlier orders are combined and planned,
today's orders are still waiting for the next combined run. ``enrich`` then
brings it to life — machines with a queue start their first job, the stores
carry their kind, and a second AMR drives in Halle 2. ``gimel demo --enrich``
does the same to an existing demo database, idempotently.
"""

from __future__ import annotations

import hashlib
import math
import random
import secrets
from dataclasses import dataclass, field
from typing import Sequence
from datetime import datetime, timedelta, timezone

from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from .core import conveyor as conveyor_core, robot_traffic, route_improve
from .core.geometry import rect_from_params
from .core.layout import Layout, point_in_polygon, segment_blocked
from .models import (
    AuditLog,
    FactoryFloor,
    FactoryHall,
    FactorySite,
    FactoryStation,
    FactoryStationType,
    Order,
    Product,
    Rate,
    RobotAsset,
    RobotGateway,
    RobotProgram,
    Role,
    StationRouting,
    StationTask,
    StockLocation,
    User,
    WorkOrder,
    WorkOrderStatus,
)
from .schemas import QuoteLine
from .security import hash_password
from .services import batch_runner, identity, robot_ways, settings_store, worklist
from .services.orders import place_order

ADMIN_EMAIL = "admin@musterwerk.example"

MATERIALS = [
    # id, name, colour, sheets, thicknesses, cat, grain, €/m²
    ("epdm-70", "EPDM 70 Shore", "#2f3b46", [[1000, 1000], [1500, 1000], [2000, 1000]], [1, 2, 3, 5], "rubber", "none", 28),
    ("nbr-70", "NBR 70 Shore", "#6b4f3a", [[1000, 1000], [1500, 1000], [2000, 1000]], [1, 2, 3], "rubber", "none", 34),
    ("fa-200", "Faserplatte FA-200", "#9a7b3f", [[1500, 1500], [2000, 1500]], [1, 1.5, 2, 3], "fibre", "none", 46),
    ("ptfe-w", "PTFE weiß", "#8fa3b5", [[1000, 1000], [1500, 1500]], [1, 2, 3], "ptfe", "none", 120),
    ("graphit-f", "Graphit flexibel", "#4a5560", [[1000, 1000], [1500, 1500]], [1, 1.5, 2], "graphite", "axis", 95),
    ("kork-g", "Kork-Gummi", "#b5803f", [[1000, 1000]], [2, 3, 5], "cork", "none", 22),
]

#: Sätze der einfachen Preisformel (gimel.core.pricing), erfunden wie alles hier.
RATES = {"cut": 0.45, "freight": 18.0, "wasteMin": 1.25, "vat": 0.19, "gap": 3.0, "margin": 8.0}

CUSTOMERS = [
    ("Stadtwerke Musterstadt", "SWM", "Musterstadt"),
    ("Pumpenbau Nord GmbH", "PBN", "Rostock"),
    ("Brauerei Hopfenfeld", "BHF", "Bamberg"),
    ("Anlagenbau Süd AG", "ASA", "Augsburg"),
    ("Kälte Krause KG", "KKK", "Leipzig"),
    ("Chemiepark Ost", "CPO", "Bitterfeld"),
    ("Mühlenwerke Elbe", "MWE", "Magdeburg"),
    ("Heiztechnik Weber", "HTW", "Dessau"),
]

#: Der Verkäufer des Musterwerks, damit die Demo Rechnungen schreiben kann. Erfunden:
#: die Kennungen haben absichtlich kein echtes Format und gehören niemandem.
SELLER = {
    "name": "Musterwerk GmbH", "street": "Musterstraße 1", "zip": "12345", "city": "Musterstadt",
    "country": "DE", "vatId": "DE-MUSTER-0000", "taxNumber": "000/000/00000",
    "email": "rechnung@musterwerk.example", "website": "https://musterwerk.example",
    "partners": "", "manufacturer": "Musterwerk GmbH", "brandMark": "",
    "register": "Amtsgericht Musterstadt, HRB 00000", "managers": "Erika Muster",
    "iban": "DE00 0000 0000 0000 0000 00", "bic": "MUSTDEXX", "bank": "Musterbank",
}

# Flange gaskets (inner bolt circle): label, od, di
RINGS = [("DN15", 51, 22), ("DN25", 71, 34), ("DN40", 92, 49), ("DN50", 107, 61),
         ("DN80", 142, 90), ("DN100", 162, 115), ("DN150", 218, 169), ("DN200", 273, 220)]
# Full-face gaskets: label, od, di, bolts, bolt Ø, bolt circle
FULL_FACE = [("DN50 PN16 voll", 165, 61, 4, 18, 125), ("DN80 PN16 voll", 200, 90, 8, 18, 160),
             ("DN100 PN16 voll", 220, 115, 8, 18, 180)]
# Rectangles: label, w, h, centre hole
RECTS = [("Deckeldichtung", 320, 220, 0), ("Leiste", 600, 40, 0), ("Schaugläser", 180, 120, 60),
         ("Pumpendeckel", 260, 260, 140), ("Unterlage", 400, 300, 0)]

#: Farben der Stationstypen — dieselben wie im Grundriss-Editor.
TYPE_COLOUR = {
    FactoryStationType.warehouse: "#8e5cb8",
    FactoryStationType.production: "#106ba3",
    FactoryStationType.shipping: "#217e56",
    FactoryStationType.accounting: "#ca9c19",
}


# ---------------------------------------------------------------------------
# Geometrie-Helfer
# ---------------------------------------------------------------------------
def _rect(x1: float, y1: float, x2: float, y2: float) -> list[list[float]]:
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def _zone(name: str, kind: str, colour: str, x1: float, y1: float, x2: float, y2: float) -> dict:
    return {"name": name, "kind": kind, "colour": colour, "points": _rect(x1, y1, x2, y2)}


def _columns(xs: tuple[float, ...], ys: tuple[float, ...], size: float = 0.3) -> list[dict]:
    return [
        {"name": "Stütze", "points": _rect(x - size, y - size, x + size, y + size)}
        for x in xs for y in ys
    ]


def _floor(
    hall: FactoryHall,
    *,
    level: int,
    level_name: str,
    elevation_m: float,
    height_m: float,
    outline: list[list[float]],
    zones: list[dict],
    obstacles: list[dict] | None = None,
    doors: list[dict] | None = None,
    aisles: dict,
) -> FactoryFloor:
    return FactoryFloor(
        name=hall.name,
        hall_id=hall.id,
        level=level,
        level_name=level_name,
        elevation_m=elevation_m,
        height_m=height_m,
        outline=outline,
        zones=zones,
        obstacles=obstacles or [],
        doors=doors or [],
        aisles=aisles,
        scale=40.0,
        grid=1.0,
        snap=0.25,
    )


# ---------------------------------------------------------------------------
# Werk Musterstadt · Halle 1 — Zuschnitt, Versand, Verwaltung
# ---------------------------------------------------------------------------
def _hq_ground(hall: FactoryHall) -> FactoryFloor:
    return _floor(
        hall,
        level=0,
        level_name="EG",
        elevation_m=0.0,
        height_m=6.0,
        outline=_rect(0, 0, 64, 32),
        zones=[
            _zone("Material", "storage", "#8e5cb8", 0, 0, 12, 32),
            _zone("Zuschnitt", "production", "#106ba3", 12, 0, 46, 32),
            _zone("Versand", "shipping", "#217e56", 46, 0, 64, 20),
            _zone("Meisterbereich", "office", "#ca9c19", 46, 20, 64, 32),
        ],
        obstacles=_columns((16, 30, 44), (10, 22)) + [
            {"name": "Trennwand", "points": [[50, 19.8], [64, 19.8], [64, 20.2], [50, 20.2]]},
        ],
        doors=[
            {"name": "Tor Versand", "x": 64, "y": 8, "width": 5, "kind": "gate"},
            {"name": "Tor Anlieferung", "x": 0, "y": 8, "width": 4, "kind": "gate"},
            {"name": "Treppe", "x": 30, "y": 32, "width": 2.5, "kind": "stair"},
            {"name": "Aufzug", "x": 34, "y": 32, "width": 2.5, "kind": "lift"},
        ],
        aisles={
            "nodes": [
                [6, 16], [14, 16], [22, 16], [30, 16], [38, 16], [46, 16], [56, 16],
                [22, 8], [38, 8], [22, 24], [38, 24], [56, 8], [48, 24], [56, 25],
            ],
            "edges": [
                [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6],
                [2, 7], [4, 8], [2, 9], [4, 10], [6, 11], [5, 12], [12, 13],
            ],
        },
    )


def _hq_upper(hall: FactoryHall) -> FactoryFloor:
    return _floor(
        hall,
        level=1,
        level_name="1. OG",
        elevation_m=6.0,
        height_m=4.2,
        outline=_rect(0, 0, 64, 32),
        zones=[
            _zone("Büro", "office", "#ca9c19", 0, 0, 26, 20),
            _zone("Besprechung", "office", "#ca9c19", 0, 20, 26, 32),
            _zone("Arbeitsvorbereitung", "office", "#ca9c19", 26, 0, 44, 20),
            _zone("Qualitätssicherung", "production", "#106ba3", 26, 20, 44, 32),
            _zone("Kleinteilelager", "storage", "#8e5cb8", 44, 0, 64, 32),
        ],
        obstacles=_columns((16, 30, 44), (10, 22)),
        doors=[
            {"name": "Treppe", "x": 30, "y": 32, "width": 2.5, "kind": "stair"},
            {"name": "Aufzug", "x": 34, "y": 32, "width": 2.5, "kind": "lift"},
        ],
        aisles={
            "nodes": [
                [6, 8], [14, 8], [22, 8], [30, 8], [38, 8], [48, 8], [58, 8],
                [6, 24], [14, 24], [22, 24], [30, 24], [38, 24], [48, 24], [58, 24],
                [30, 15], [38, 15], [48, 15], [58, 15],
            ],
            "edges": [
                [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6],
                [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13],
                [0, 7], [1, 8], [2, 9], [3, 14], [4, 15], [5, 16], [6, 17],
                [14, 10], [15, 11], [16, 12], [17, 13],
            ],
        },
    )


# ---------------------------------------------------------------------------
# Werk Musterstadt · Halle 2 — Logistik, Kommissionierung, Versand
# ---------------------------------------------------------------------------
def _logistics_basement(hall: FactoryHall) -> FactoryFloor:
    return _floor(
        hall,
        level=-1,
        level_name="KG",
        elevation_m=-4.0,
        height_m=3.4,
        outline=_rect(0, 0, 40, 24),
        zones=[
            _zone("Langzeitlager", "storage", "#8e5cb8", 0, 0, 24, 24),
            _zone("Technik", "zone", "#5c7080", 24, 0, 32, 24),
            _zone("Archiv", "storage", "#8e5cb8", 32, 0, 40, 24),
        ],
        obstacles=_columns((8, 20, 28, 36), (6, 18)),
        doors=[
            {"name": "Aufzug", "x": 20, "y": 24, "width": 2.5, "kind": "lift"},
            {"name": "Treppe", "x": 24, "y": 24, "width": 2.5, "kind": "stair"},
        ],
        aisles={
            "nodes": [
                [5, 12], [12, 12], [20, 12], [27, 12], [34, 12], [38, 12],
                [12, 5], [12, 19], [20, 5], [20, 19], [27, 5], [27, 19], [34, 5], [34, 19],
            ],
            "edges": [
                [0, 1], [1, 2], [2, 3], [3, 4], [4, 5],
                [1, 6], [1, 7], [2, 8], [2, 9], [3, 10], [3, 11], [4, 12], [4, 13],
            ],
        },
    )


def _logistics_ground(hall: FactoryHall) -> FactoryFloor:
    return _floor(
        hall,
        level=0,
        level_name="EG",
        elevation_m=0.0,
        height_m=7.0,
        outline=_rect(0, 0, 40, 24),
        zones=[
            _zone("Warenannahme", "shipping", "#217e56", 0, 0, 10, 24),
            _zone("Hochregal", "storage", "#8e5cb8", 10, 0, 28, 24),
            _zone("Versand", "shipping", "#217e56", 28, 0, 40, 14),
            _zone("Logistikbüro", "office", "#ca9c19", 28, 14, 40, 24),
        ],
        obstacles=_columns((8, 28, 36), (6, 18)) + [
            {"name": "Trennwand", "points": [[28, 13.8], [40, 13.8], [40, 14.2], [28, 14.2]]},
        ],
        doors=[
            {"name": "Tor Anlieferung", "x": 0, "y": 12, "width": 5, "kind": "gate"},
            {"name": "Tor Versand", "x": 40, "y": 6, "width": 4, "kind": "gate"},
            {"name": "Treppe", "x": 20, "y": 24, "width": 2.5, "kind": "stair"},
            {"name": "Aufzug", "x": 24, "y": 24, "width": 2.5, "kind": "lift"},
        ],
        aisles={
            "nodes": [
                [5, 12], [10, 12], [18, 12], [26, 12], [30, 12], [36, 12],
                [18, 4], [18, 20], [30, 4], [30, 20],
            ],
            "edges": [
                [0, 1], [1, 2], [2, 3], [3, 4], [4, 5],
                [2, 6], [2, 7], [4, 8], [4, 9],
            ],
        },
    )


def _logistics_upper(hall: FactoryHall) -> FactoryFloor:
    return _floor(
        hall,
        level=1,
        level_name="1. OG",
        elevation_m=7.0,
        height_m=4.0,
        outline=_rect(0, 0, 40, 24),
        zones=[
            _zone("Kommissionierung", "storage", "#8e5cb8", 0, 0, 20, 24),
            _zone("Leergut", "storage", "#8e5cb8", 20, 0, 28, 24),
            _zone("Logistikleitung", "office", "#ca9c19", 28, 0, 40, 24),
        ],
        obstacles=_columns((8, 16, 24, 34), (6, 18)),
        doors=[
            {"name": "Treppe", "x": 20, "y": 24, "width": 2.5, "kind": "stair"},
            {"name": "Aufzug", "x": 24, "y": 24, "width": 2.5, "kind": "lift"},
        ],
        aisles={
            "nodes": [
                [10, 12], [16, 12], [23, 12], [28, 12], [34, 12],
                [10, 5], [10, 19], [23, 5], [23, 19], [34, 5], [34, 19],
            ],
            "edges": [
                [0, 1], [1, 2], [2, 3], [3, 4],
                [0, 5], [0, 6], [2, 7], [2, 8], [4, 9], [4, 10],
            ],
        },
    )


# ---------------------------------------------------------------------------
# Stationen — jede mit einer Ebene, damit der Umschalter nie raten muss
# ---------------------------------------------------------------------------
def _stations(floors: dict[str, FactoryFloor]) -> list[FactoryStation]:
    def at(key: str, **kw) -> FactoryStation:
        return FactoryStation(floor_id=floors[key].id, colour=TYPE_COLOUR[kw["type"]], **kw)

    return [
        # Halle 1 · EG: Zuschnitt und Versand
        at("h1_eg", label="Plattenregal", type=FactoryStationType.warehouse,
           x=6, y=16, w=4, h=22, is_storage=True, task_min=3, unit_min=2,
           routing=StationRouting.smart_auto, machine_kind="",
           note="Platten und Reststücke, alle Werkstoffe"),
        at("h1_eg", label="Plotter 1", type=FactoryStationType.production,
           machine_kind="plotter", x=22, y=5, w=5, h=3,
           speed_mm_s=50, pierce_s=2, setup_min=8, changeover_min=12,
           handling_min_per_plate=2, max_sheet_w=2000, max_sheet_h=1600,
           thk_max=6, cost_per_h=65, capacity_min_per_day=450,
           routing=StationRouting.smart_auto,
           note="Große Formate bis 2000 × 1600 mm"),
        at("h1_eg", label="Plotter 2", type=FactoryStationType.production,
           machine_kind="plotter", x=22, y=27, w=4, h=3,
           speed_mm_s=40, pierce_s=2, setup_min=8, changeover_min=12,
           handling_min_per_plate=2, max_sheet_w=1500, max_sheet_h=1500,
           thk_max=5, cost_per_h=55, capacity_min_per_day=450,
           routing=StationRouting.smart_auto,
           note="Kleinere Formate und Eilaufträge"),
        at("h1_eg", label="Wasserstrahl", type=FactoryStationType.production,
           machine_kind="waterjet", x=38, y=5, w=6, h=4,
           speed_mm_s=15, pierce_s=6, setup_min=15, changeover_min=10,
           handling_min_per_plate=4, max_sheet_w=3000, max_sheet_h=2000,
           thk_max=50, cost_per_h=95, capacity_min_per_day=450,
           routing=StationRouting.smart_auto,
           note="Dicke und harte Werkstoffe bis 50 mm"),
        at("h1_eg", label="Stanze", type=FactoryStationType.production,
           machine_kind="punch", x=38, y=27, w=4, h=3,
           speed_mm_s=120, pierce_s=1, setup_min=25, changeover_min=15,
           handling_min_per_plate=2, max_sheet_w=1500, max_sheet_h=1000,
           thk_max=3, materials=["epdm-70", "nbr-70", "kork-g"],
           cost_per_h=70, capacity_min_per_day=450,
           routing=StationRouting.smart_suggest,
           note="Nur weiche Werkstoffe bis 3 mm; Werkzeugwechsel dauert"),
        at("h1_eg", label="Nacharbeit", type=FactoryStationType.production,
           machine_kind="manual", x=43, y=16, w=3, h=2.5,
           setup_min=5, changeover_min=5, handling_min_per_plate=1,
           capacity_min_per_day=420, routing=StationRouting.pull,
           note="Entgraten, Nacharbeiten, Sonderfälle"),
        at("h1_eg", label="Packtisch", type=FactoryStationType.shipping,
           x=56, y=8, w=4, h=2, task_min=5, unit_min=1.5,
           routing=StationRouting.smart_auto, note="Versand und Kommissionierung"),

        # Halle 1 · 1. OG: Verwaltung, Arbeitsvorbereitung, Kleinteile
        at("h1_og", label="Auftragsbüro", type=FactoryStationType.accounting,
           x=3, y=5, w=5, h=3, task_min=4, unit_min=1,
           routing=StationRouting.smart_auto, note="Aufträge, Papiere, Kunden"),
        at("h1_og", label="Arbeitsvorbereitung", type=FactoryStationType.accounting,
           x=14, y=5, w=5, h=3, task_min=5, unit_min=1.2,
           routing=StationRouting.smart_auto, note="Zeichnungen und Schachtelpläne"),
        at("h1_og", label="Werkleitung", type=FactoryStationType.accounting,
           x=3, y=22, w=5, h=3, task_min=4, unit_min=1,
           routing=StationRouting.pull, note="Meisterbüro und Besprechung"),
        at("h1_og", label="Kleinteilelager", type=FactoryStationType.warehouse,
           x=48, y=6, w=5, h=4, is_storage=True, task_min=3, unit_min=1.5,
           routing=StationRouting.smart_auto, note="Kleinteile, Werkzeuge, Normteile"),

        # Halle 2 · KG: Langzeitlager und Archiv
        at("h2_kg", label="Langzeitlager", type=FactoryStationType.warehouse,
           x=4, y=7, w=6, h=10, is_storage=True, task_min=3, unit_min=2,
           routing=StationRouting.smart_auto, note="Vorrat und seltene Werkstoffe"),
        at("h2_kg", label="Archiv", type=FactoryStationType.warehouse,
           x=34, y=9, w=4, h=6, task_min=2, unit_min=1,
           routing=StationRouting.pull, note="Alte Aufträge und Zeichnungen"),

        # Halle 2 · EG: Annahme, Hochregal, Packen, Versandbüro
        at("h2_eg", label="Warenannahme", type=FactoryStationType.warehouse,
           x=2, y=10, w=4, h=4, task_min=4, unit_min=1.5,
           routing=StationRouting.smart_auto, note="Wareneingang und Prüfung"),
        at("h2_eg", label="Hochregal A", type=FactoryStationType.warehouse,
           x=18, y=4, w=6, h=4, is_storage=True, task_min=3, unit_min=2,
           routing=StationRouting.smart_auto, note="Platten und Rollen"),
        at("h2_eg", label="Hochregal B", type=FactoryStationType.warehouse,
           x=18, y=16, w=6, h=4, is_storage=True, task_min=3, unit_min=2,
           routing=StationRouting.smart_auto, note="Reststücke und Sonderposten"),
        at("h2_eg", label="Kommissionierung", type=FactoryStationType.warehouse,
           x=20, y=10, w=4, h=3, task_min=3, unit_min=2,
           routing=StationRouting.smart_auto, note="Teile für den Versand zusammenstellen"),
        at("h2_eg", label="Packtisch Logistik", type=FactoryStationType.shipping,
           x=30, y=4, w=4, h=3, task_min=5, unit_min=1.5,
           routing=StationRouting.smart_auto, note="Pakete, Paletten, Laufkarten"),
        at("h2_eg", label="Versandbüro", type=FactoryStationType.accounting,
           x=30, y=16, w=5, h=3, task_min=4, unit_min=1,
           routing=StationRouting.smart_auto, note="Frachtpapiere und Sendungen"),

        # Halle 2 · 1. OG: Kommissionierung und Leergut
        at("h2_og", label="Kommissionierung OG", type=FactoryStationType.warehouse,
           x=6, y=8, w=8, h=8, task_min=3, unit_min=2,
           routing=StationRouting.smart_auto, note="Nachschub für die Fertigung"),
        at("h2_og", label="Leergut", type=FactoryStationType.warehouse,
           x=21, y=9, w=4, h=6, task_min=2, unit_min=1,
           routing=StationRouting.pull, note="Paletten, Kisten, Verpackung"),
        at("h2_og", label="Logistikleitung", type=FactoryStationType.accounting,
           x=31, y=9, w=5, h=3, task_min=4, unit_min=1,
           routing=StationRouting.pull, note="Disposition und Tourenplanung"),
    ]


def _robots(floors: dict[str, FactoryFloor], now: datetime) -> list[RobotAsset]:
    """Drei erfundene Transportroboter auf den Gängen der Demo-Hallen.

    Die Wege liegen genau auf dem gespeicherten Gangnetz. Die Position rechnet
    ``services.robot_fleet`` aus Startzeit und Geschwindigkeit; hier stehen nur
    Weg, Tempo und ein plausibler Akkustand. Keine echte Verbindung, keine
    Steuerung — die Demo zeigt, wo eine Flotte später sichtbar wäre.
    """
    return [
        RobotAsset(
            name="AGV 1", kind="agv", floor_id=floors["h1_eg"].id,
            route=[[6, 16], [14, 16], [22, 16], [30, 16], [38, 16], [46, 16], [56, 16], [56, 8]],
            route_mode="pingpong", speed_m_s=1.2, battery_pct=82, state="moving",
            gateway_id="sim", capabilities=["transport", "pallet"], payload_kg=250,
            sim_started_at=now,
        ),
        RobotAsset(
            name="AGV 2", kind="agv", floor_id=floors["h1_eg"].id,
            route=[[22, 8], [22, 16], [38, 16], [38, 8], [22, 8]],
            route_mode="loop", speed_m_s=0.9, battery_pct=64, state="moving",
            gateway_id="sim", capabilities=["transport"], payload_kg=150,
            sim_started_at=now,
        ),
        RobotAsset(
            name="AMR Logistik", kind="amr", floor_id=floors["h2_eg"].id,
            route=[[5, 12], [10, 12], [18, 12], [26, 12], [30, 12], [36, 12]],
            route_mode="pingpong", speed_m_s=1.0, battery_pct=91, state="moving",
            gateway_id="sim", capabilities=["transport", "lift"], payload_kg=300,
            sim_started_at=now,
        ),
    ]


def _robot_platform() -> list:
    """Ein simuliertes Gateway und eine freigegebene Demo-Mission.

    Keine echte Adresse, kein Token, kein Code, der irgendwo läuft: die Demo
    zeigt die Form der Plattform, nicht eine Verbindung. Die Mission ist ein
    schlichtes JSON, das ein Gateway später interpretieren würde.
    """
    body = '{"steps": ["pick", "drive", "drop"], "handover": "Packtisch"}'
    return [
        RobotGateway(
            code="sim", name="Simulation", kind="sim", enabled=True,
            note="Virtuelle Flotte — kein Gerät, keine Netzverbindung.",
        ),
        RobotProgram(
            name="Palette zum Packtisch",
            version=1,
            kind="mission",
            language="json",
            body=body,
            checksum=hashlib.sha256(body.encode("utf-8")).hexdigest(),
            status="approved",
            gateway_id="sim",
            notes="Demo-Mission ohne echte Ausführung.",
            created_by="demo",
            approved_by="demo",
        ),
    ]


def _line(rng: random.Random, n: int) -> QuoteLine:
    mat, _n, _c, _s, thks, _cat, _g, _eur = rng.choice(MATERIALS)
    thk = rng.choice(thks)
    r = rng.random()
    common = {"id": n, "mat": mat, "thk": thk}
    if r < 0.55:
        label, od, di = rng.choice(RINGS)
        return QuoteLine(**common, label=f"Flanschdichtung {label}", od=od, di=di,
                         q=rng.choice([4, 6, 8, 10, 12, 16, 20, 24, 30, 40]))
    if r < 0.75:
        label, od, di, bolts, bolt_d, circle = rng.choice(FULL_FACE)
        return QuoteLine(**common, label=f"Flanschdichtung {label}", od=od, di=di, bn=bolts,
                         bd=bolt_d, bc=circle, q=rng.choice([2, 4, 6, 8, 10]))
    label, w, h, hole = rng.choice(RECTS)
    shape = rect_from_params(w, h, di=hole)
    od = (w * w + h * h) ** 0.5
    return QuoteLine(**common, label=label, od=od, di=hole, shape=shape, fam="rect",
                     q=rng.choice([2, 4, 5, 8, 10]))


def is_demo(db: Session) -> bool:
    """Does this database hold the demo plant? Asked of the data, not of
    ``demo-login.txt``: that file can be deleted, or outlive the database it belongs to."""
    return db.query(User.id).filter(User.email == ADMIN_EMAIL,
                                    User.role == Role.admin).first() is not None


def seed(db: Session, *, now: datetime | None = None) -> str:
    """Fill an empty database with the demo plant. Returns the admin password."""
    if db.query(User).count() or db.query(Order).count():
        raise RuntimeError("database is not empty — use `gimel demo --reset`")
    now = now or datetime.now(timezone.utc)
    rng = random.Random(7)

    settings_store.set_value(db, "nesting_engine", "kerf", actor="demo")
    for mid, name, colour, sheets, thks, cat, grain, eur in MATERIALS:
        db.add(Product(id=mid, name=name, colour=colour, sheets=sheets, thicknesses=thks,
                       cat=cat, grain=grain, eur_m2=eur, active=True, cnc="confirmed",
                       stock=rng.randint(20, 60)))
    for key, value in RATES.items():
        db.add(Rate(key=key, value=value))
    customers = []
    for i, (name, _ref, city) in enumerate(CUSTOMERS, 1):
        c = User(email=f"einkauf{i}@musterwerk.example", name="Einkauf", company=name,
                 role=Role.customer, customer_no=f"K-{1000 + i}",
                 password_hash=hash_password(secrets.token_urlsafe(16)))
        c.demo_city = city
        customers.append(c)
        db.add(c)

    # Ein erfundener Standort mit zwei Hallen: Zuschnitt und Verwaltung in
    # Halle 1, Logistik und Versand in Halle 2. Die Kartenanker sind
    # Demo-Koordinaten; die Karte bleibt je Halle eine bewusste Entscheidung
    # (map_enabled).
    site_hq = FactorySite(
        name="Werk Musterstadt", code="MS", address="Musterweg 1, 00000 Musterstadt",
        lat=51.4810, lon=12.0050,
        note="Hauptwerk — Zuschnitt, Verwaltung und Logistik. Demo-Daten.",
    )
    db.add(site_hq)
    db.flush()

    hall1 = FactoryHall(
        site_id=site_hq.id, name="Halle 1", code="H1", sort=0,
        lat=51.4806, lon=12.0046, rotation_deg=0, map_enabled=True,
        note="Zuschnitt, Versand und Verwaltung über zwei Ebenen.",
    )
    hall2 = FactoryHall(
        site_id=site_hq.id, name="Halle 2", code="LOG", sort=1,
        lat=51.4814, lon=12.0058, rotation_deg=8, map_enabled=True,
        note="Logistik, Kommissionierung und Versand über drei Ebenen.",
    )
    db.add_all([hall1, hall2])
    db.flush()

    # Die Reihenfolge ist wichtig: Halle 1 EG ist die erste Ebene und bleibt
    # der Rückfall für Stationen ohne floor_id (siehe services.sites).
    h1_eg = _hq_ground(hall1)
    h1_og = _hq_upper(hall1)
    h2_kg = _logistics_basement(hall2)
    h2_eg = _logistics_ground(hall2)
    h2_og = _logistics_upper(hall2)
    db.add_all([h1_eg, h1_og, h2_kg, h2_eg, h2_og])
    db.flush()

    floors = {
        "h1_eg": h1_eg, "h1_og": h1_og,
        "h2_kg": h2_kg, "h2_eg": h2_eg, "h2_og": h2_og,
    }
    for station in _stations(floors):
        db.add(station)
    for robot in _robots(floors, now):
        db.add(robot)
    for row in _robot_platform():
        db.add(row)

    password = secrets.token_urlsafe(12)
    db.add(User(email=ADMIN_EMAIL, name="Demo-Admin", role=Role.admin,
                password_hash=hash_password(password)))
    db.flush()
    settings_store.ensure_defaults(db)
    identity.save(db, SELLER, "demo")

    line_id = [0]

    def make(*, rush: bool = False, scope: str = "") -> Order:
        c = rng.choice(customers)
        lines = []
        for _ in range(rng.choice([1, 1, 2, 2, 3, 4])):
            line_id[0] += 1
            lines.append(_line(rng, line_id[0]))
        address = {"company": c.company, "street": f"Werkstraße {c.id}", "zip": "12345",
                   "city": c.demo_city, "country": "DE"}
        order = place_order(db, lines=lines, cert="", ship_address=address, bill_address=address,
                            tax_status={"rate": 0.19}, customer_ref=f"PO-{rng.randint(1000, 9999)}",
                            user=c, rush=rush, released=True)
        order.site_id = site_hq.id
        order.route_scope = scope
        return order

    # Earlier orders have gone through the combined run; today's are still
    # waiting. A few are deliberately bound to a hall or a level so the
    # "Fertigen in" column is not an empty option list in the demo.
    for i in range(5):
        if i == 2:
            scope = "received"
        elif i == 3:
            scope = f"hall:{hall1.id}"
        elif i == 4:
            scope = f"floor:{h1_eg.id}"
        else:
            scope = ""
        make(rush=i in (1, 4), scope=scope)

    db.commit()
    batch_runner.run_batch(db, trigger="manual", actor="demo", force=True)

    for i in range(3):
        scope = f"hall:{hall2.id}" if i == 1 else ""
        make(rush=i == 2, scope=scope)

    db.commit()
    worklist.reconcile(db, who="demo")
    worklist.apply_plan(db, worklist.plan(db), who="demo")
    # Ein großer Auftrag bleibt bewusst offen: die Demo zeigt neben den
    # automatisch verteilten Innenaufträgen auch den Zustand „wartet auf den
    # Meister“. Das ist derselbe Vorgang, den die Oberfläche unter „Offene
    # Zuordnungen“ anbietet.
    largest = (
        db.query(WorkOrder)
        .filter(WorkOrder.status == WorkOrderStatus.open)
        .order_by(WorkOrder.n_parts.desc(), WorkOrder.id.asc())
        .first()
    )
    if largest is not None:
        largest.station_id = None
        largest.assign_mode = ""
        largest.assign_reason = "wartet auf die Werkstatt"
        largest.planned_min = 0.0
    db.commit()
    # Derselbe Weg wie `gimel demo --enrich`: eine frische Demo endet im
    # selben Zustand wie eine nachgerüstete.
    enrich(db, now=now)
    return password


# ---------------------------------------------------------------------------
# Belebung — laufende Aufträge, Lagerarten, Kapazitäten, ein zweiter AMR
# ---------------------------------------------------------------------------
#: Kurzzeichen der Lager („Lager · <Kurzzeichen>“). Das 3D-Modell wählt daraus
#: seine Bauart; ohne Kurzzeichen rät es aus dem Namen.
STORAGE_SUBTYPES = {
    "Plattenregal": "Plattenregal",
    "Hochregal A": "Hochregal",
    "Hochregal B": "Hochregal",
    "Kommissionierung": "Kommissionierung",
    "Kommissionierung OG": "Kommissionierung",
    "Warenannahme": "Wareneingang",
    "Leergut": "Leergut",
    "Archiv": "Archiv",
    "Kleinteilelager": "Kleinteile",
    "Langzeitlager": "Langzeitlager",
}
#: Minuten je Arbeitstag, erfunden wie alles hier. Gesetzt wird nur, wo 0
#: („unbekannt“) steht — ein gepflegter Wert bleibt.
CAPACITIES = {"Kommissionierung": 420.0, "Packtisch Logistik": 420.0}
#: An diesen Maschinen läuft in der Demo der erste wartende Innenauftrag.
RUNNING_AT = ("Plotter 1", "Wasserstrahl", "Stanze")
#: Der zweite Roboter in Halle 2 EG und die Stationen, zwischen denen er fährt.
AMR_NAME = "AMR Nachschub"
AMR_HALL = "Halle 2"
AMR_LEVEL = 0
AMR_STOPS = ("Hochregal A", "Kommissionierung", "Hochregal B", "Packtisch Logistik")
ACTOR = "demo"


class NotADemo(RuntimeError):
    """Die Datenbank hält nicht das Musterwerk — ``enrich`` fasst sie nicht an."""

    MESSAGE = "this database does not hold the demo plant 'Musterwerk GmbH' — nothing changed"

    def __init__(self, message: str = MESSAGE) -> None:
        super().__init__(message)


@dataclass
class Enrichment:
    """Was ``enrich`` getan hat: eine Zeile je Änderung (= je Protokollzeile)
    und Hinweise auf das, was schon stand oder bewusst ausblieb."""

    changes: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _audit(db: Session, action: str, entity: str, entity_id, **detail) -> None:
    db.add(AuditLog(actor=ACTOR, action=action, entity=entity, entity_id=str(entity_id),
                    detail={**detail, "source": "demo enrich"}))


def _station(db: Session, label: str, *, floor_id: int | None = None) -> FactoryStation | None:
    # Über den Namen, nicht über die id: die Demo wurde seit der Saat in der
    # Oberfläche bearbeitet, ids und Lagen sind kein fester Bezug.
    q = db.query(FactoryStation).filter(FactoryStation.label == label)
    if floor_id is not None:
        q = q.filter(FactoryStation.floor_id == floor_id)
    return q.order_by(FactoryStation.id.asc()).first()


def _set_task(db: Session, row: StationTask, state: str, out: Enrichment, line: str) -> None:
    before = row.state
    # Der Dienst schreibt durch, wohin die Tatsache gehört (Bereitstellung bzw.
    # laufender Innenauftrag) und rechnet die Reihenfolge der Station neu. Eine
    # Protokollzeile schreibt er nicht; die kommt hier dazu, wie in der Route.
    worklist.set_state(db, row, state, who=ACTOR)
    _audit(db, "task_state", "station_task", row.id, ref=f"{row.kind}:{row.ref}",
           before=before, state=row.state, note="Demo-Belebung")
    db.flush()
    out.changes.append(line)


def _first_queued_cut(db: Session, st: FactoryStation) -> StationTask | None:
    """Die erste offene Schneideaufgabe in der Reihenfolge der Station."""
    rows = {r.ref: r for r in worklist.open_rows(db, kind="cut", station_id=st.id)}
    if not rows:
        return None
    sched = worklist.schedule_for(db, st.id)
    order = [s.task.ref for s in (sched.slots if sched else []) if s.task.kind == "cut"]
    for ref in order + [r for r in rows if r not in order]:
        row = rows.get(ref)
        if row is None:
            continue
        wo = db.query(WorkOrder).filter(WorkOrder.no == ref).first()
        # Maßgeblich ist die Zuordnung am Innenauftrag, nicht die Aufgabenzeile.
        if wo is not None and wo.status == WorkOrderStatus.open and wo.station_id == st.id:
            return row
    return None


def _start_jobs(db: Session, out: Enrichment) -> None:
    for label in RUNNING_AT:
        st = _station(db, label)
        if st is None or not st.active:
            out.notes.append(f"{label}: no active station of that name, skipped")
            continue
        running = (
            db.query(WorkOrder)
            .filter(WorkOrder.station_id == st.id, WorkOrder.status == WorkOrderStatus.running)
            .first()
        )
        if running is not None:
            out.notes.append(f"{label}: {running.no} already running")
            continue
        cut = _first_queued_cut(db, st)
        if cut is None:
            # Kein Auftrag wird erfunden: ohne Warteschlange bleibt die Maschine still.
            out.notes.append(f"{label}: no queued work order, left idle")
            continue
        pick = (
            db.query(StationTask)
            .filter(StationTask.kind == "pick", StationTask.ref == cut.ref)
            .first()
        )
        if pick is not None and pick.state in worklist.OPEN_STATES:
            _set_task(db, pick, "done", out, f"{label}: material for {cut.ref} staged")
        _set_task(db, cut, "running", out, f"{label}: {cut.ref} running")


def _storage_subtypes(db: Session, out: Enrichment) -> None:
    for label, subtype in STORAGE_SUBTYPES.items():
        st = _station(db, label)
        if st is None:
            out.notes.append(f"{label}: no station of that name, subtype skipped")
            continue
        if (st.subtype or "").strip():
            continue
        st.subtype = subtype
        _audit(db, "demo_enrich", "factory_station", st.id, fields=["subtype"],
               label=label, subtype=subtype)
        out.changes.append(f"{label}: subtype {subtype}")
    db.flush()


#: Lager, in denen die Demo ihre Platten verteilt, in dieser Reihenfolge.
STOCK_STORAGES = ("Plattenregal", "Hochregal A", "Hochregal B")


def _stock_locations(db: Session, out: Enrichment) -> None:
    """Verteilt den Bestand jedes Werkstoffs auf Lager und Fächer.

    Nur für Werkstoffe ohne jede Lagerort-Zeile, deshalb idempotent; die Summe
    je Werkstoff ist der Bestand zum Zeitpunkt des Laufs. Fächer sind
    erfunden wie alles hier.
    """
    stores = [st for st in (_station(db, name) for name in STOCK_STORAGES) if st is not None]
    if not stores:
        out.notes.append("stock locations: none of the storage stations exist, skipped")
        return
    have = {pid for (pid,) in db.query(StockLocation.product_id).distinct().all()}
    for i, p in enumerate(db.query(Product).order_by(Product.id.asc()).all()):
        if p.id in have or int(p.stock or 0) <= 0:
            continue
        thks = [float(t) for t in (p.thicknesses or [])] or [0.0]
        left = int(p.stock)
        for j, thk in enumerate(thks):
            qty = left if j == len(thks) - 1 else max(1, int(p.stock) // len(thks))
            qty = min(qty, left)
            left -= qty
            if qty <= 0:
                continue
            st = stores[(i + j) % len(stores)]
            # Ein Teil der Menge liegt in einem zweiten Fach, damit „woher"
            # nicht immer nur ein Ort ist.
            extra = qty // 3 if qty >= 9 else 0
            fach = f"Fach {'ABCDEF'[(i + j) % 6]}{1 + (i * 3 + j) % 4}"
            db.add(StockLocation(product_id=p.id, thk=thk, station_id=st.id, bin=fach,
                                 qty=qty - extra, updated_by=ACTOR))
            if extra:
                st2 = stores[(i + j + 1) % len(stores)]
                db.add(StockLocation(product_id=p.id, thk=thk, station_id=st2.id,
                                     bin=f"Fach {'ABCDEF'[(i + j + 2) % 6]}{1 + (i + j) % 4}",
                                     qty=extra, updated_by=ACTOR))
        _audit(db, "demo_enrich", "stock_location", p.id, product=p.id, stock=int(p.stock))
        # Eine Zeile je Protokollzeile — die Prüfung zählt sie gegeneinander.
        out.changes.append(f"{p.id}: stock placed in {', '.join(s.label for s in stores)}")
    db.flush()


def _capacities(db: Session, out: Enrichment) -> None:
    for label, minutes in CAPACITIES.items():
        st = _station(db, label)
        if st is None:
            out.notes.append(f"{label}: no station of that name, capacity skipped")
            continue
        if st.capacity_min_per_day:
            continue
        st.capacity_min_per_day = minutes
        _audit(db, "demo_enrich", "factory_station", st.id, fields=["capacity_min_per_day"],
               label=label, capacity_min_per_day=minutes)
        out.changes.append(f"{label}: capacity {minutes:g} min/day")
    db.flush()


def _near_body(p: tuple[float, float], bodies, pad: float) -> bool:
    for poly in bodies:
        if len(poly) < 3:
            continue
        xs = [q[0] for q in poly]
        ys = [q[1] for q in poly]
        if min(xs) - pad <= p[0] <= max(xs) + pad and min(ys) - pad <= p[1] <= max(ys) + pad:
            return True
    return False


def amr_route(db: Session, floor: FactoryFloor) -> tuple[list[list[float]], list[str], str]:
    """Rundkurs für den zweiten AMR, gebaut aus dem Gangnetz der Ebene.

    Halt ist je Station der nächste Gangknoten, der frei von Hindernissen und
    Stationskörpern liegt (Abstand ``route_improve.CLEARANCE_M``); gleiche
    Halte hintereinander fallen zusammen. Die Abschnitte legt
    ``route_improve.safe_leg`` über die Gänge, ``improve`` macht daraus den
    Fixpunkt. Gespeichert wird nur, was die Prüfung danach unverändert und frei
    lässt. Rückgabe: Weg, angefahrene Stationen und — bei leerem Weg — der Grund.
    """
    layout = Layout.from_row(floor)
    if not layout.aisles.usable:
        return [], [], "no aisle network on that floor"
    bodies = robot_ways.station_bodies(db, floor.id)
    blockers = [o.points for o in layout.obstacles] + bodies
    nodes = [(float(n[0]), float(n[1])) for n in layout.aisles.nodes]
    linked = {int(i) for e in layout.aisles.edges for i in e}
    free = [
        i for i, n in enumerate(nodes)
        if i in linked
        and (len(layout.outline) < 3 or point_in_polygon(n, layout.outline))
        and not _near_body(n, blockers, route_improve.CLEARANCE_M)
    ]
    if not free:
        return [], [], "no aisle node clear of bodies"
    stops: list[int] = []
    served: list[str] = []
    for label in AMR_STOPS:
        st = _station(db, label, floor_id=floor.id)
        if st is None or not st.active:
            continue
        at = (float(st.x or 0.0), float(st.y or 0.0))
        best = min(free, key=lambda i: (math.dist(nodes[i], at), i))
        served.append(label)
        if not stops or stops[-1] != best:
            stops.append(best)
    if len(stops) > 1 and stops[0] == stops[-1]:
        stops.pop()
    if len(stops) < 2:
        return [], served, "fewer than two distinct stops on the aisle network"
    pts = [nodes[i] for i in stops]
    raw: list[tuple[float, float]] = [pts[0]]
    for a, b in zip(pts, pts[1:] + pts[:1]):
        leg, kind = route_improve.safe_leg(layout, a, b, bodies)
        if kind not in ("netz", "umweg"):
            return [], served, f"no clear way over the aisles between {a} and {b} ({kind})"
        raw.extend(leg[1:])
    raw.pop()  # der Rundkurs schließt von selbst
    imp = route_improve.improve(layout, raw, loop=True, bodies=bodies)
    route = [[round(x, 3), round(y, 3)] for x, y in imp.points]
    check = route_improve.improve(layout, route, loop=True, bodies=bodies)
    if check.changed or check.problems_after or check.blocked or check.air_legs:
        return [], served, "route did not pass the route check: " + "; ".join(
            check.problems_after + check.notes)
    return route, served, ""


def _sim_robots(db: Session, floor_id: int) -> list[robot_traffic.TrafficRobot]:
    rows = db.query(RobotAsset).filter(RobotAsset.floor_id == floor_id, RobotAsset.active.is_(True)).all()
    out = []
    for r in rows:
        route = [(float(p[0]), float(p[1])) for p in (r.route or []) if len(p) >= 2]
        if (r.gateway_id or "sim").strip().lower() == "sim" and len(route) >= 2:
            out.append(robot_traffic.TrafficRobot(r.id, tuple(route), (r.route_mode or "") == "loop",
                                                  float(r.speed_m_s or 0.0)))
    return out


def traffic_ok(db: Session, floor_id: int, route: list[list[float]], loop: bool, speed: float) -> bool:
    """Passt der neue Weg in den Fahrplan der Ebene (``core.robot_traffic``), ohne
    dass irgendein Roboter stehen bleiben muss? Sonst gäbe es Stau oder Begegnungen."""
    robots = _sim_robots(db, floor_id)
    probe = robot_traffic.TrafficRobot(max([r.id for r in robots], default=0) + 1,
                                       tuple((p[0], p[1]) for p in route), loop, speed)
    plans = robot_traffic.plan_floor(robots + [probe]).plans
    return not any(p.parked for p in plans.values())


def _dist_to_route(p: tuple[float, float], route: Sequence[tuple[float, float]], loop: bool) -> float:
    pts = list(route) + ([route[0]] if loop else [])
    best = math.inf
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        u = 0.0 if L <= 1e-12 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L))
        best = min(best, math.hypot(p[0] - (ax + u * dx), p[1] - (ay + u * dy)))
    return best


def amr_shuttles(db: Session, floor: FactoryFloor) -> list[list[list[float]]]:
    """Ausweichwege für den zweiten AMR: Pendelstrecken über das Gangnetz, die an
    einem Gangknoten abseits der Wege der anderen Roboter beginnen. Längste zuerst."""
    layout = Layout.from_row(floor)
    if not layout.aisles.usable:
        return []
    bodies = robot_ways.station_bodies(db, floor.id)
    blockers = [o.points for o in layout.obstacles] + bodies
    nodes = [(float(n[0]), float(n[1])) for n in layout.aisles.nodes]
    linked = {int(i) for e in layout.aisles.edges for i in e}
    free = [i for i, n in enumerate(nodes)
            if i in linked and (len(layout.outline) < 3 or point_in_polygon(n, layout.outline))
            and not _near_body(n, blockers, route_improve.CLEARANCE_M)]
    others = _sim_robots(db, floor.id)
    aside = [i for i in free
             if all(_dist_to_route(nodes[i], r.route, r.loop) >= robot_traffic.SAFE_M + 0.5 for r in others)]
    out: list[list[list[float]]] = []
    for u in aside:
        for v in free:
            if u == v:
                continue
            leg, kind = route_improve.safe_leg(layout, nodes[u], nodes[v], bodies)
            if kind not in ("netz", "umweg") or len(leg) < 2:
                continue
            imp = route_improve.improve(layout, leg, loop=False, bodies=bodies)
            route = [[round(x, 3), round(y, 3)] for x, y in imp.points]
            check = route_improve.improve(layout, route, loop=False, bodies=bodies)
            if check.changed or check.problems_after or check.blocked or check.air_legs:
                continue
            if route_improve.length([(p[0], p[1]) for p in route], False) >= 6.0:
                out.append(route)
    out.sort(key=lambda r: -route_improve.length([(p[0], p[1]) for p in r], False))
    return out[:24]


def _second_amr(db: Session, out: Enrichment, now: datetime) -> None:
    have = db.query(RobotAsset).filter(RobotAsset.name == AMR_NAME).first()
    if have is not None:
        return
    hall = db.query(FactoryHall).filter(FactoryHall.name == AMR_HALL).order_by(FactoryHall.id).first()
    floor = None
    if hall is not None:
        floor = (
            db.query(FactoryFloor)
            .filter(FactoryFloor.hall_id == hall.id, FactoryFloor.level == AMR_LEVEL)
            .order_by(FactoryFloor.id.asc())
            .first()
        )
    if floor is None:
        out.notes.append(f"{AMR_NAME}: no floor {AMR_HALL} level {AMR_LEVEL}, not added")
        return
    route, served, why = amr_route(db, floor)
    loop = True
    if route and not traffic_ok(db, floor.id, route, True, 0.8):
        # Der Rundkurs teilt einen Gang mit einem anderen Roboter, der dort
        # pendelt: das gäbe Stau. Dann eine Pendelstrecke abseits davon.
        why, route = "the loop jams with the other robots on that floor", []
        for alt in amr_shuttles(db, floor):
            if traffic_ok(db, floor.id, alt, False, 0.8):
                route, loop, served = alt, False, ["Pendelstrecke abseits des Hauptgangs"]
                break
    if not route:
        out.notes.append(f"{AMR_NAME}: {why}, not added")
        return
    metres = route_improve.length([(p[0], p[1]) for p in route], loop)
    row = RobotAsset(
        name=AMR_NAME, kind="amr", floor_id=floor.id, route=route, route_mode="loop" if loop else "pingpong",
        speed_m_s=0.8, battery_pct=73, state="moving", gateway_id="sim",
        capabilities=["transport", "lift"], payload_kg=300, sim_started_at=now,
    )
    db.add(row)
    db.flush()
    _audit(db, "robot_create", "robot_asset", row.id, name=AMR_NAME, floor_id=floor.id,
           route_m=round(metres, 2), stops=served)
    db.flush()
    out.changes.append(f"{AMR_NAME}: added on {AMR_HALL} {floor.level_name or AMR_LEVEL}, "
                       f"{'loop' if loop else 'shuttle'} {metres:.1f} m past {', '.join(served)}")


#: Förderband von der Nacharbeit zum Versand (Halle 1 EG). Aus der Nacharbeit
#: steigt es nach Süden-Osten an, quert den Schräggang und den Hauptgang als
#: Brücke in 2,85 m (Roboter fahren darunter durch) und fällt zum Packtisch ab.
CONVEYOR_NAME = "Förderband Nacharbeit → Versand"
CONVEYOR_FROM, CONVEYOR_TO = "Nacharbeit", "Packtisch"
CONVEYOR_POINTS = [[42.2, 17.5, 0.9], [45.2, 18.8, 2.85], [50.5, 18.8, 2.85], [50.5, 11.5, 2.85], [53.65, 8.4, 0.9]]


def _conveyor(db: Session, out: Enrichment) -> None:
    src = _station(db, CONVEYOR_FROM)
    dst = _station(db, CONVEYOR_TO)
    if src is None or dst is None or src.floor_id is None or src.floor_id != dst.floor_id:
        out.notes.append(f"{CONVEYOR_NAME}: {CONVEYOR_FROM}/{CONVEYOR_TO} not on one floor, not added")
        return
    floor = db.get(FactoryFloor, src.floor_id)
    if floor is None:
        return
    have = [c for c in (floor.conveyors or []) if isinstance(c, dict)]
    if any(c.get("name") == CONVEYOR_NAME for c in have):
        return
    belt = {"name": CONVEYOR_NAME, "points": CONVEYOR_POINTS, "width": 0.8,
            "from_station_id": src.id, "to_station_id": dst.id}
    # Nur wenn nichts im Weg steht: kein Gang wird durchschnitten, kein
    # Roboterweg bekommt ein neues Problem, keine Station wird überbaut.
    polys = [poly for _n, poly in conveyor_core.bodies([belt])]
    layout = Layout.from_row(floor)
    nodes = [(float(n[0]), float(n[1])) for n in layout.aisles.nodes]
    for i, j in layout.aisles.edges:
        if segment_blocked(nodes[int(i)], nodes[int(j)], polys):
            out.notes.append(f"{CONVEYOR_NAME}: would cut an aisle, not added")
            return
    from .core.robot_way import route_problems

    class _With:
        def __init__(self, row, extra):
            self._row, self.conveyors = row, extra

        def __getattr__(self, name):
            return getattr(self._row, name)

    after = Layout.from_row(_With(floor, have + [belt]))
    for robot in db.query(RobotAsset).filter(RobotAsset.floor_id == floor.id).all():
        route = [(float(p[0]), float(p[1])) for p in (robot.route or [])]
        loop = (robot.route_mode or "") == "loop"
        closed = route + (route[:1] if loop else [])
        if len(closed) >= 2 and len(route_problems(after, closed)) > len(route_problems(layout, closed)):
            out.notes.append(f"{CONVEYOR_NAME}: would block {robot.name}, not added")
            return
    bodies = robot_ways.station_bodies(db, floor.id)
    others = [b for b in bodies if not any(point_in_polygon(q, b) for q in ((src.x, src.y), (dst.x, dst.y)))]
    for poly in polys:
        if any(segment_blocked(poly[k], poly[(k + 1) % len(poly)], others) for k in range(len(poly))):
            out.notes.append(f"{CONVEYOR_NAME}: would stand in a station, not added")
            return
    floor.conveyors = have + [belt]
    _audit(db, "demo_enrich", "factory_floor", floor.id, fields=["conveyors"], name=CONVEYOR_NAME,
           length_m=round(conveyor_core.length_m(conveyor_core.points3(CONVEYOR_POINTS)), 2))
    db.flush()
    out.changes.append(f"{CONVEYOR_NAME}: added on {floor.name or 'Halle'} "
                       f"({conveyor_core.length_m(conveyor_core.points3(CONVEYOR_POINTS)):.1f} m, bridge over the aisles)")


def _seed_scm(db: Session, out: Enrichment, now: datetime) -> None:
    """Fiktive Lieferanten, Bestellungen, Chargen, Verluste und Warnungen (idempotent)."""
    from .models import (
        GoodsReceipt,
        MaterialLot,
        PurchaseOrder,
        PurchaseOrderLine,
        PurchaseOrderStatus,
        ScrapEvent,
        StationDowntime,
        Supplier,
        SupplierMaterial,
        WorkPlate,
    )
    from .services import scm_analytics

    geo_defaults = {
        "ELBE": ("Hamburg", "EU-DE", 53.5511, 9.9937, "EUR", ["hamburg_port"], ["epdm", "nbr", "elastomer", "rubber"]),
        "NORD": ("Bremen", "EU-DE", 53.0793, 8.8017, "EUR", ["hamburg_port", "rotterdam_port"], ["aramid", "fiber", "gasket", "energy"]),
        "RHEIN": ("Duisburg", "EU-DE", 51.4344, 6.7623, "EUR", ["rhine_corridor", "rotterdam_port", "suez_canal"], ["ptfe", "fluoropolymer", "pfas", "graphite", "chemical"]),
        "SUED": ("Graz", "EU-AT", 47.0707, 15.4395, "EUR", ["brenner_corridor"], ["graphite", "cork", "rubber", "gasket"]),
        "ROTTER": ("Rotterdam", "EU-NL", 51.9244, 4.4777, "EUR", ["rotterdam_port", "antwerp_port", "rhine_corridor"], ["epdm", "nbr", "elastomer", "petrochemical", "oil"]),
        "SHANGHAI": ("Shanghai", "ASIA-CN", 31.2304, 121.4737, "USD", ["shanghai_port", "strait_of_malacca", "suez_canal", "rotterdam_port"], ["graphite", "carbon", "fluoropolymer", "chemical", "china export"]),
    }

    if db.query(Supplier).count() > 0:
        # Idempotentes Nachpflegen der Geo-/Korridordaten auf bestehenden Demo-Lieferanten
        updated_geo = 0
        for s in db.query(Supplier).all():
            meta = geo_defaults.get(s.code)
            if meta and (s.lat is None or not s.transit_corridors):
                s.city, s.region, s.lat, s.lon, _, s.transit_corridors, s.materials_tags = meta
                updated_geo += 1
        if updated_geo:
            out.changes.append(f"Lieferanten-Geodaten & Korridore ergänzt ({updated_geo})")
        return

    suppliers_spec = [
        ("ELBE", "Elbe Elastomer GmbH", "einkauf@elbe-elastomer.example", "DE", 5, 0.94),
        ("NORD", "Nordfaser Plattenwerk", "vertrieb@nordfaser.example", "DE", 8, 0.88),
        ("RHEIN", "RheinPTFE Handel KG", "order@rheinptfe.example", "DE", 12, 0.82),
        ("SUED", "SüdKork & Graphit GmbH", "dispo@suedkork.example", "AT", 9, 0.91),
        ("ROTTER", "Maasvlakte Elastomer Hub BV", "supply@maasvlakte-hub.example", "NL", 6, 0.93),
        ("SHANGHAI", "Yangtze Carbon & Polymer Ltd.", "export@yangtze-polymer.example", "CN", 24, 0.84),
    ]
    sup_by_code: dict[str, Supplier] = {}
    for code, name, email, country, lead, rel in suppliers_spec:
        city, region, lat, lon, ccy, corridors, mtags = geo_defaults[code]
        s = Supplier(
            code=code, name=name, email=email, country=country,
            city=city, region=region, lat=lat, lon=lon, currency=ccy,
            transit_corridors=corridors, materials_tags=mtags,
            default_lead_days=lead, reliability_override=rel, active=True,
        )
        db.add(s)
        sup_by_code[code] = s
    db.flush()

    prods = {p.id: p for p in db.query(Product).all()}
    # absichtlich: ptfe-w hat nur EINEN Lieferanten (Einzelquellen-Risiko in der Demo)
    sm_spec = [
        ("ELBE", "epdm-70", 0.0, "ELB-EPDM70", 2000, 1000, 13.5, 5, 5, 1),
        ("NORD", "epdm-70", 0.0, "NF-EPDM", 1500, 1000, 15.2, 4, 7, 2),
        ("ROTTER", "epdm-70", 0.0, "MV-EPDM70", 2000, 1000, 14.1, 6, 6, 3),
        ("ELBE", "nbr-70", 0.0, "ELB-NBR70", 2000, 1000, 16.0, 5, 6, 1),
        ("SUED", "nbr-70", 0.0, "SK-NBR70", 1500, 1000, 17.8, 3, 9, 2),
        ("ROTTER", "nbr-70", 0.0, "MV-NBR70", 2000, 1000, 16.4, 5, 6, 3),
        ("NORD", "fa-200", 0.0, "NF-FA200", 2000, 1500, 21.5, 4, 8, 1),
        ("SUED", "fa-200", 0.0, "SK-FA200", 1500, 1500, 23.0, 4, 10, 2),
        ("RHEIN", "ptfe-w", 0.0, "RP-PTFE-W", 1500, 1500, 68.0, 2, 14, 1),
        ("SUED", "graphit-f", 0.0, "SK-GRF", 1500, 1500, 48.0, 3, 9, 1),
        ("RHEIN", "graphit-f", 0.0, "RP-GRF", 1000, 1000, 52.0, 2, 11, 2),
        ("SHANGHAI", "graphit-f", 0.0, "YC-GRF-CN", 1500, 1500, 41.5, 6, 24, 3),
        ("SUED", "kork-g", 0.0, "SK-KORK", 1000, 1000, 10.5, 6, 7, 1),
    ]
    for scode, pid, thk, sku, sw, sh, ek, moq, lead, rank in sm_spec:
        if pid not in prods:
            continue
        db.add(SupplierMaterial(
            supplier_id=sup_by_code[scode].id, product_id=pid, thk=thk,
            supplier_sku=sku, sheet_w=sw, sheet_h=sh, unit_eur_m2=ek,
            moq_sheets=moq, quoted_lead_days=lead, preferred_rank=rank, active=True,
        ))

    # Lagerstation für Demo-Chargen
    storage = db.query(FactoryStation).filter(FactoryStation.is_storage.is_(True)).first()
    storage_id = storage.id if storage else None

    # 3 abgeschlossene historische Bestellungen + Wareneingänge + Chargen (ohne Bestandsänderung)
    hist_specs = [
        ("BE-26-0001", "WE-26-0001", "CH-26-0001", "ELBE", "epdm-70", 2.0, 2000, 1000, 12, 27.0, 18, 13, 13, "LS-88412", "3.1", "WZ-ELB-2601"),
        ("BE-26-0002", "WE-26-0002", "CH-26-0002", "NORD", "fa-200", 2.0, 2000, 1500, 10, 64.5, 22, 14, 12, "LS-44109", "3.1", "WZ-NF-2602"),
        ("BE-26-0003", "WE-26-0003", "CH-26-0003", "RHEIN", "ptfe-w", 2.0, 1500, 1500, 4, 153.0, 25, 11, 8, "LS-99210", "2.2", "WZ-RP-2603"),
    ]
    lots_by_mat: dict[str, MaterialLot] = {}
    for po_no, gr_no, lot_code, scode, pid, thk, sw, sh, qty, uprice, ord_ago, eta_ago, rec_ago, dn, ctype, cref in hist_specs:
        if pid not in prods:
            continue
        sup = sup_by_code[scode]
        po = PurchaseOrder(
            no=po_no, supplier_id=sup.id, status=PurchaseOrderStatus.received,
            order_date=now - timedelta(days=ord_ago),
            requested_eta=now - timedelta(days=eta_ago),
            confirmed_eta=now - timedelta(days=eta_ago),
            received_at=now - timedelta(days=rec_ago),
            total_net=round(qty * uprice, 2), created_by="demo",
        )
        db.add(po)
        db.flush()
        db.add(PurchaseOrderLine(
            purchase_order_id=po.id, product_id=pid, thk=thk, sheet_w=sw, sheet_h=sh,
            qty_ordered=qty, qty_received=qty, unit_price_eur=uprice,
            requested_eta=po.requested_eta, confirmed_eta=po.confirmed_eta,
        ))
        gr = GoodsReceipt(
            no=gr_no, purchase_order_id=po.id, supplier_id=sup.id,
            delivery_note_no=dn, received_at=po.received_at, received_by="demo",
            station_id=storage_id,
        )
        db.add(gr)
        db.flush()
        lot = MaterialLot(
            code=lot_code, product_id=pid, thk=thk, sheet_w=sw, sheet_h=sh,
            supplier_id=sup.id, purchase_order_no=po_no, goods_receipt_id=gr.id,
            supplier_batch=f"B-{lot_code[-4:]}", cert_type=ctype, cert_ref=cref,
            qty_initial=qty, qty_remaining=max(1, qty - 3),
            unit_eur_m2=round(uprice / ((sw * sh) / 1_000_000.0), 2),
            station_id=storage_id, bin="Regal A1", status="available",
            received_at=po.received_at, created_by="demo",
        )
        db.add(lot)
        db.flush()
        lots_by_mat[pid] = lot

    # Bestehende Demo-Platten mit Chargen verknüpfen für sofortige Rückverfolgung
    for wo in db.query(WorkOrder).all():
        lot = lots_by_mat.get(wo.mat)
        if lot is None:
            continue
        for pl in db.query(WorkPlate).filter(WorkPlate.work_order_id == wo.id, WorkPlate.lot_id.is_(None)).limit(2).all():
            pl.lot_id = lot.id

    # 2 offene Bestellungen: eine pünktlich, eine 4 Tage überfällig (löst Watchdog-Alarm aus)
    if "epdm-70" in prods:
        po_ok = PurchaseOrder(
            no="BE-26-0004", supplier_id=sup_by_code["ELBE"].id, status=PurchaseOrderStatus.confirmed,
            order_date=now - timedelta(days=2),
            requested_eta=now + timedelta(days=4), confirmed_eta=now + timedelta(days=4),
            total_net=270.0, note="Regelnachschub EPDM", created_by="demo",
        )
        db.add(po_ok)
        db.flush()
        db.add(PurchaseOrderLine(
            purchase_order_id=po_ok.id, product_id="epdm-70", thk=2.0, sheet_w=2000, sheet_h=1000,
            qty_ordered=10, qty_received=0, unit_price_eur=27.0,
            requested_eta=po_ok.requested_eta, confirmed_eta=po_ok.confirmed_eta,
        ))

    if "ptfe-w" in prods:
        po_late = PurchaseOrder(
            no="BE-26-0005", supplier_id=sup_by_code["RHEIN"].id, status=PurchaseOrderStatus.ordered,
            order_date=now - timedelta(days=18),
            requested_eta=now - timedelta(days=4), confirmed_eta=now - timedelta(days=4),
            total_net=612.0, note="Dringender PTFE-Nachschub", created_by="demo",
        )
        db.add(po_late)
        db.flush()
        db.add(PurchaseOrderLine(
            purchase_order_id=po_late.id, product_id="ptfe-w", thk=2.0, sheet_w=1500, sheet_h=1500,
            qty_ordered=4, qty_received=0, unit_price_eur=153.0,
            requested_eta=po_late.requested_eta, confirmed_eta=po_late.confirmed_eta,
        ))

    if "graphit-f" in prods and "SHANGHAI" in sup_by_code:
        po_sea = PurchaseOrder(
            no="BE-26-0006", supplier_id=sup_by_code["SHANGHAI"].id, status=PurchaseOrderStatus.confirmed,
            currency="USD",
            order_date=now - timedelta(days=9),
            requested_eta=now + timedelta(days=15), confirmed_eta=now + timedelta(days=18),
            total_net=560.25, note="Seefracht Shanghai → Suez → Rotterdam (Graphitfolie)", created_by="demo",
        )
        db.add(po_sea)
        db.flush()
        db.add(PurchaseOrderLine(
            purchase_order_id=po_sea.id, product_id="graphit-f", thk=2.0, sheet_w=1500, sheet_h=1500,
            qty_ordered=6, qty_received=0, unit_price_eur=93.38,
            requested_eta=po_sea.requested_eta, confirmed_eta=po_sea.confirmed_eta,
        ))

    # Beispiel-Ausschuss und kurzer Wartungsstillstand für echte OEE-Kennzahlen
    prod_st = db.query(FactoryStation).filter(FactoryStation.type == FactoryStationType.production).first()
    first_wo = db.query(WorkOrder).first()
    if prod_st is not None:
        db.add(ScrapEvent(
            work_order_no=first_wo.no if first_wo else "",
            station_id=prod_st.id,
            product_id=first_wo.mat if first_wo else "epdm-70",
            thk=float(first_wo.thk) if first_wo else 2.0,
            lot_id=lots_by_mat.get(first_wo.mat).id if (first_wo and first_wo.mat in lots_by_mat) else None,
            qty_parts=3, area_m2=0.18, reason="ruestfehler",
            note="Anfahrschnitt nach Messerwechsel", recorded_by="demo",
            recorded_at=now - timedelta(days=2),
        ))
        db.add(StationDowntime(
            station_id=prod_st.id, kind="planned", reason="Messer- und Düsenwartung",
            started_at=now - timedelta(days=3, hours=2),
            ended_at=now - timedelta(days=3, hours=1, minutes=15),
            duration_min=45.0, recorded_by="demo",
        ))

    db.flush()
    scm_analytics.sync_supply_alerts(db, now=now)
    _audit(db, "demo_enrich", "scm", "demo", suppliers=len(suppliers_spec), lots=len(lots_by_mat))
    out.changes.append("scm: 4 Lieferanten, 5 Bestellungen, 3 Chargen und Lieferketten-Warnungen angelegt")


def enrich(db: Session, *, now: datetime | None = None) -> Enrichment:
    """Die Demo beleben, idempotent: jeder Schritt entfällt, wenn sein Ziel
    schon erreicht ist, und ein zweiter Lauf ändert nichts.

    Findet alles über Namen und verschiebt nichts, was schon steht —
    Stationen, Gänge und Roboter bleiben, wo die Oberfläche sie hingelegt hat.
    Jede Änderung trägt eine Protokollzeile mit ``demo`` als Akteur. Allein
    aufgerufen committet es die Sitzung; ``enrich_atomic`` macht alles zu
    einer einzigen Transaktion.
    """
    if not is_demo(db):
        raise NotADemo()
    now = now or datetime.now(timezone.utc)
    out = Enrichment()
    _start_jobs(db, out)
    _storage_subtypes(db, out)
    _stock_locations(db, out)
    _capacities(db, out)
    _second_amr(db, out, now)
    _conveyor(db, out)
    db.commit()
    return out


def enrich_atomic(bind: Engine | None = None, *, now: datetime | None = None) -> Enrichment:
    """``enrich`` in genau einer Transaktion: alles oder nichts.

    ``worklist.set_state`` committet selbst. Deshalb hängt die Sitzung an einer
    äußeren Transaktion der Verbindung (``join_transaction_mode="rollback_only"``):
    ihre Commits schreiben nur durch, festgeschrieben wird einmal am Ende, und
    ein Fehler nimmt alles zurück. Unter SQLite beginnt die Transaktion sofort
    (``BEGIN IMMEDIATE``), damit auch die Prüfungen vorab dazugehören und der
    Taktgeber nicht dazwischen schreibt.
    """
    if bind is None:
        from .db import engine as bind
    with bind.connect() as conn, conn.begin():
        if conn.dialect.name == "sqlite":
            conn.exec_driver_sql("BEGIN IMMEDIATE")
        with Session(bind=conn, autoflush=False, join_transaction_mode="rollback_only") as db:
            return enrich(db, now=now)
