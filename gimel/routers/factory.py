"""Der Digitale Grundriss als API — Halle, Stationen, Zuordnung, Fluss.

Die Zuordnung liegt bewusst *nicht* im Sammellauf (``services/batch_runner``).
Der Sammellauf entscheidet, **wann** geschnitten wird — eine Entscheidung über
Material und Termine (CLAUDE.md §5.5). Diese Datei entscheidet, **wo**
geschnitten wird: eine Entscheidung über Wege, Rüstzustände und Kapazität.
Die zweite darf sich jeden Tag ändern, ohne dass die erste wackelt oder ein
Preis sich bewegt.
"""

from __future__ import annotations

import math
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from ..config import API_ROOT
from ..db import get_db
from ..core.layout import Layout, polygon_area, polygon_perimeter
from ..models import (
    AuditLog,
    FactoryFloor,
    FactoryHall,
    FactorySetting,
    FactorySite,
    FactoryStation,
    FactoryStationType,
    Order,
    OrderPosition,
    Product,
    StationRouting,
    StationTask,
    StationVisibility,
    Offcut,
    StockLocation,
    TwinView,
    FleetScenario,
    User,
    WorkItem,
    WorkOrder,
    WorkOrderStatus,
    WorkPlate,
)
from ..security import has_admin_work, require_admin, require_staff, require_worker
from ..services import factory_router as fr
from ..services import floor_view
from ..services import sites as site_svc
from ..services import stock_locations as stockloc
from ..services import offcuts as offcut_svc
from ..services import twin_analysis as twin
from ..services import worklist as wl
from ..services.dxf_import import parse_dxf

router = APIRouter(prefix="/api/factory", tags=["factory"])

#: 3D-Modelle liegen neben der Datenbank, nicht im Web-Build. Der Name ist die
#: einzige Referenz in der Datenbank; Pfade werden nie aus JSON übernommen.
MODEL_DIR = API_ROOT / "factory-models"
MODEL_SUFFIXES = {".glb", ".obj", ".stl"}
MODEL_MEDIA = {".glb": "model/gltf-binary", ".obj": "model/obj", ".stl": "model/stl"}
MODEL_MAX_BYTES = 25 * 1024 * 1024


# ==========================================================================
# Grundriss
# ==========================================================================
class ZoneIn(BaseModel):
    name: str = ""
    kind: str = "zone"
    colour: str = "#8e5cb8"
    points: list[list[float]] = []


class ObstacleIn(BaseModel):
    name: str = ""
    points: list[list[float]] = []
    kind: Optional[str] = None
    height_m: Optional[float] = None


class DoorIn(BaseModel):
    name: str = ""
    x: float = 0
    y: float = 0
    width: float = 2.5
    kind: str = "door"


class ConveyorIn(BaseModel):
    """Ein Förderband: Mittellinie in Förderrichtung, je Punkt optional die Bandhöhe (m)."""

    name: str = Field(default="Förderband", max_length=120)
    points: list[list[float]] = Field(default_factory=list, max_length=32)
    width: float = Field(default=0.8, ge=0.3, le=2.0)
    from_station_id: Optional[int] = None
    to_station_id: Optional[int] = None


class AislesIn(BaseModel):
    nodes: list[list[float]] = []
    edges: list[list[int]] = []
    # Wege von Hand: [{"station": id|null, "points": [[x, y], ...]}] — im selben JSON, keine neue Spalte.
    paths: list[dict] = []


class FloorIn(BaseModel):
    name: str = "Halle"
    outline: list[list[float]] = []
    zones: list[ZoneIn] = []
    obstacles: list[ObstacleIn] = []
    doors: list[DoorIn] = []
    aisles: AislesIn = Field(default_factory=AislesIn)
    #: Fehlt beim PUT = bleibt, wie es ist (ältere Editoren kennen das Feld nicht).
    conveyors: Optional[list[ConveyorIn]] = None
    scale: float = 40.0
    grid: float = 1.0
    snap: float = 0.25
    bg: str = "#f5f5f0"
    #: Halle und Ebene. Leer beim PUT = bleibt, wie es ist.
    hall_id: Optional[int] = None
    level: int = 0
    level_name: str = ""
    elevation_m: float = 0.0
    height_m: float = 6.0


class FloorOut(FloorIn):
    id: int
    updated_at: Optional[datetime] = None
    updated_by: str = ""
    #: Abgeleitet, damit die Oberfläche nicht dieselbe Formel zweimal führt.
    area_m2: float = 0.0
    perimeter_m: float = 0.0
    aisle_m: float = 0.0
    issues: list[str] = []


def _floor_out(row: Optional[FactoryFloor], db: Optional[Session] = None) -> FloorOut:
    if row is None:
        return FloorOut(id=0)
    layout = Layout.from_row(row)
    # Gänge ↔ Objekte: die Stationen gehören zur Prüfung dazu, denn eine
    # Entfernung, die „über Gänge" heißt, aber mit einem Stichweg durch die
    # Wand beginnt, ist keine. Ohne DB-Session (Legacy-Aufrufer) entfällt
    # dieser Teil der Prüfung.
    station_issues: list[str] = []
    if db is not None:
        default = site_svc.default_floor(db)
        default_id = default.id if default else None
        stations = [
            st
            for st in db.query(FactoryStation)
            .filter(FactoryStation.active.is_(True))
            .order_by(FactoryStation.id.asc())
            .all()
            if site_svc.station_floor_id(st, default_id) == row.id
        ]
        station_issues = layout.connect_issues(
            [
                (s.label or f"Station {s.id}", (float(s.x or 0), float(s.y or 0)))
                for s in stations
            ]
        )
    return FloorOut(
        id=row.id,
        name=row.name or "Halle",
        outline=[[p[0], p[1]] for p in (row.outline or [])],
        zones=[ZoneIn(**z) for z in (row.zones or []) if isinstance(z, dict)],
        obstacles=[
            ObstacleIn(**o) for o in (row.obstacles or []) if isinstance(o, dict)
        ],
        doors=[DoorIn(**d) for d in (row.doors or []) if isinstance(d, dict)],
        aisles=AislesIn(**(row.aisles or {"nodes": [], "edges": []})),
        conveyors=[ConveyorIn(**{**c, "points": [list(p)[:3] for p in c.get("points", [])][:32]})
                   for c in (getattr(row, "conveyors", None) or []) if isinstance(c, dict)],
        scale=row.scale or 40.0,
        grid=row.grid or 1.0,
        snap=row.snap or 0.25,
        bg=row.bg or "#f5f5f0",
        hall_id=row.hall_id,
        level=int(row.level or 0),
        level_name=row.level_name or "",
        elevation_m=float(row.elevation_m or 0.0),
        height_m=float(row.height_m or 6.0),
        updated_at=row.updated_at,
        updated_by=row.updated_by or "",
        area_m2=round(layout.area_m2, 2),
        perimeter_m=round(polygon_perimeter(layout.outline), 2),
        aisle_m=round(layout.aisles.length_m(), 2),
        issues=layout.check() + station_issues,
    )


def _floor_row(db: Session, floor_id: Optional[int]) -> Optional[FactoryFloor]:
    if floor_id:
        row = db.get(FactoryFloor, floor_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Ebene nicht gefunden.")
        return row
    return site_svc.default_floor(db)


@router.get("/floor", response_model=FloorOut)
def get_floor(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    floor_id: Optional[int] = Query(None),
) -> FloorOut:
    """Eine Ebene. Ohne ``floor_id`` die erste — so lesen alte Oberflächen weiter."""
    return _floor_out(_floor_row(db, floor_id), db)


def _audit(db: Session, user: User, action: str, entity: str, entity_id, **detail) -> None:
    """Eine Zeile im Protokoll, und der Commit dazu. Wo die Route selbst schreibt, landen
    Änderung und Zeile in einem Commit; die Dienste committen vorher schon selbst."""
    db.add(AuditLog(actor=user.email, action=action, entity=entity,
                    entity_id=str(entity_id), detail=detail))
    db.commit()


@router.put("/floor", response_model=FloorOut)
def put_floor(
    body: FloorIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
    floor_id: Optional[int] = Query(None),
) -> FloorOut:
    row = _floor_row(db, floor_id)
    if not row:
        row = FactoryFloor()
        db.add(row)
    if body.hall_id is not None:
        if db.get(FactoryHall, body.hall_id) is None:
            raise HTTPException(status_code=400, detail="Halle nicht gefunden.")
        row.hall_id = body.hall_id
    row.level = int(body.level)
    row.level_name = body.level_name[:60]
    row.elevation_m = float(body.elevation_m)
    row.height_m = max(1.0, float(body.height_m or 6.0))
    row.name = body.name
    row.outline = [[p[0], p[1]] for p in body.outline]
    row.zones = [z.model_dump() for z in body.zones]
    row.obstacles = [o.model_dump(exclude_none=True) for o in body.obstacles]
    row.doors = [d.model_dump() for d in body.doors]
    row.aisles = body.aisles.model_dump()
    if body.conveyors is not None:
        row.conveyors = [
            {**c.model_dump(), "points": [[float(v) for v in p[:3]] for p in c.points if len(p) >= 2]}
            for c in body.conveyors
        ]
    row.scale = body.scale
    row.grid = body.grid
    row.snap = body.snap
    row.bg = body.bg
    row.updated_by = admin.email
    db.flush()
    _audit(db, admin, "floor_update", "factory_floor", row.id, name=row.name)
    if row.hall_id is None:
        from ..seed import backfill_sites

        backfill_sites()
    db.refresh(row)
    return _floor_out(row, db)


class RouteQuery(BaseModel):
    from_id: int
    to_id: int


@router.get("/route")
def route_between(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    from_id: int = Query(...),
    to_id: int = Query(...),
) -> dict:
    """Die Strecke zwischen zwei Stationen — mit der Angabe, wie sie entstand.

    Dieselbe Rechnung, die in die Zuordnung eingeht. Wer im Editor einen Gang
    zieht, sieht hier sofort, was er damit an Weg gespart hat.
    """
    a = db.get(FactoryStation, from_id)
    b = db.get(FactoryStation, to_id)
    if not a or not b:
        raise HTTPException(status_code=404, detail="Station nicht gefunden.")
    specs = {sp.id: sp for sp in fr.station_specs(db, [a, b])}
    r = fr.context(db).route_between(specs[a.id], specs[b.id])
    if r is None:
        return {
            "from": {"id": a.id, "label": a.label},
            "to": {"id": b.id, "label": b.label},
            "metres": None, "minutes": None, "exact": False, "hops": 0,
            "note": "andere Halle — kein Weg erfasst (beide Hallen auf die Karte legen)",
        }
    return {
        "from": {"id": a.id, "label": a.label},
        "to": {"id": b.id, "label": b.label},
        "metres": round(r.metres, 1),
        "minutes": round(r.minutes, 1),
        "exact": r.exact,
        "hops": r.hops,
        "note": r.note,
    }


# ==========================================================================
# Stationen
# ==========================================================================
#: Eingebaute Gerätemodelle, die eine Station wählen darf. Die Oberfläche hat dieselbe Liste
#: (``web/src/factory.ts::MODEL_KINDS``); ``box`` und leer sind die zwei Sonderfälle.
MODEL_KINDS = ("plotter", "waterjet", "punch", "manual", "generic", "storage", "packing", "office")


class StationIn(BaseModel):
    label: str
    type: FactoryStationType
    subtype: str = ""
    x: float = 0
    y: float = 0
    w: float = 4
    h: float = 2.5
    rotation: float = 0
    colour: str = "#0a5b9c"
    materials: list[str] = []
    thicknesses: list[float] = []
    assigned_users: list[int] = []
    routing: StationRouting = StationRouting.pull
    visibility: StationVisibility = StationVisibility.collapse
    active: bool = True

    machine_kind: str = ""
    speed_mm_s: float = 0
    pierce_s: float = 0
    setup_min: float = 0
    changeover_min: float = 0
    handling_min_per_plate: float = 0
    max_sheet_w: float = 0
    max_sheet_h: float = 0
    thk_min: float = 0
    thk_max: float = 0
    cost_per_h: float = 0
    capacity_min_per_day: float = 0
    is_storage: bool = False
    #: Zeiten der nicht schneidenden Stationen: Grundzeit je Vorgang und Zeit
    #: je Einheit. Ohne sie kann ein Packtisch so wenig eine Fertigstellung
    #: versprechen wie ein Plotter ohne Vorschub — 0 heißt „unbekannt".
    task_min: float = 0
    unit_min: float = 0
    note: str = ""
    #: Vom Upload gesetzt; ein PUT darf den Dateinamen nicht frei ändern.
    model_file: str = ""
    model_scale: float = 1.0
    model_rotation: float = 0.0
    #: Eingebautes Modell ohne Datei: leer = automatisch, ``box`` = Quader, sonst eine Art aus ``MODEL_KINDS``.
    model_kind: str = ""
    #: Mitarbeiter am Arbeitsplatz: die 3D-Ansicht zeigt eine Figur (Darstellung, keine Ortung).
    staffed: bool = False
    #: Ebene der Station; leer = erste Ebene.
    floor_id: Optional[int] = None

    @field_validator("model_kind")
    @classmethod
    def _model_kind(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if v not in ("", "box", *MODEL_KINDS):
            raise ValueError("Unbekannte Modellart.")
        return v


class StationOut(StationIn):
    id: int
    #: Relative URL des hinterlegten Modells; leer = kein Modell.
    model_url: str = ""
    #: Belegte Minuten aus allen offenen Aufgaben, auch Packtisch und Regal.
    queue_min: float = 0
    #: Offene Innenaufträge oder Aufgaben; mit queue_min 0 heißt das: Dauer unbekannt.
    queue_jobs: int = 0
    #: Was zuletzt hier eingeplant war — der Rüstzustand.
    last_mat: str = ""
    last_thk: float = 0


_STATION_FIELDS = tuple(StationIn.model_fields.keys())


def _station_out(
    s: FactoryStation,
    queue: Optional[dict] = None,
    counts: Optional[dict] = None,
    last: Optional[dict] = None,
) -> StationOut:
    data = {f: getattr(s, f) for f in _STATION_FIELDS}
    data["materials"] = list(s.materials or [])
    data["thicknesses"] = [float(t) for t in (s.thicknesses or [])]
    data["assigned_users"] = [int(u) for u in (s.assigned_users or [])]
    lj = (last or {}).get(s.id)
    return StationOut(
        id=s.id,
        queue_min=round(float((queue or {}).get(s.id, 0.0)), 1),
        queue_jobs=int((counts or {}).get(s.id, 0)),
        last_mat=lj[0] if lj else "",
        last_thk=lj[1] if lj else 0.0,
        model_url=(f"/api/factory/stations/{s.id}/model?v={s.model_file}" if s.model_file else ""),
        **data,
    )


def _station_context(db: Session) -> tuple[dict, dict, dict]:
    queue = dict(fr._queue_minutes(db))
    last = fr._last_job(db)
    counts: dict[int, int] = {}
    rows = (
        db.query(WorkOrder.station_id)
        .filter(WorkOrder.station_id.isnot(None))
        .filter(WorkOrder.status.in_(fr.OPEN_STATUSES))
        .all()
    )
    for (sid,) in rows:
        if sid is not None:
            counts[int(sid)] = counts.get(int(sid), 0) + 1
    # Schneiden zählt nur über den Innenauftrag: planned_min der cut-Aufgabe
    # bleibt nach Umzug oder Plattenänderung bis zum Abgleich auf dem alten Stand.
    rows = (
        db.query(StationTask.station_id, StationTask.planned_min)
        .filter(StationTask.station_id.isnot(None))
        .filter(StationTask.kind != "cut")
        .filter(StationTask.state.in_(wl.OPEN_STATES))
        .all()
    )
    for sid, minutes in rows:
        sid = int(sid)
        queue[sid] = queue.get(sid, 0.0) + float(minutes or 0.0)
        counts[sid] = counts.get(sid, 0) + 1
    return queue, counts, last


@router.get("/stations", response_model=list[StationOut])
def list_stations(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> list[StationOut]:
    queue, counts, last = _station_context(db)
    return [
        _station_out(s, queue, counts, last)
        for s in db.query(FactoryStation).order_by(FactoryStation.id.asc()).all()
    ]


@router.post("/stations", response_model=StationOut)
def create_station(
    body: StationIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> StationOut:
    data = body.model_dump()
    data["model_file"] = ""  # nur der Upload setzt eine Datei
    _check_floor(db, data.get("floor_id"))
    s = FactoryStation(**data)
    db.add(s)
    db.flush()
    _audit(db, admin, "station_create", "factory_station", s.id, label=s.label)
    db.refresh(s)
    return _station_out(s)


@router.put("/stations/{sid}", response_model=StationOut)
def update_station(
    sid: int,
    body: StationIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> StationOut:
    s = db.get(FactoryStation, sid)
    if not s:
        raise HTTPException(status_code=404, detail="Station nicht gefunden.")
    data = body.model_dump()
    data.pop("model_file", None)  # Dateiname nur über Upload/Delete
    _check_floor(db, data.get("floor_id"))
    changed = {k: v for k, v in data.items() if getattr(s, k) != v}
    for k, v in changed.items():
        setattr(s, k, v)
    if changed:
        _audit(db, admin, "station_update", "factory_station", s.id, fields=sorted(changed))
    db.refresh(s)
    queue, counts, last = _station_context(db)
    return _station_out(s, queue, counts, last)


def _check_floor(db: Session, floor_id: Optional[int]) -> None:
    if floor_id is not None and db.get(FactoryFloor, floor_id) is None:
        raise HTTPException(status_code=400, detail="Ebene nicht gefunden.")


def _model_path(name: str) -> Path:
    """Nur der reine Dateiname aus der Datenbank wird zum Pfad."""
    return MODEL_DIR / Path(name).name


@router.post("/stations/{sid}/model", response_model=StationOut)
async def upload_station_model(
    sid: int,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
    file: UploadFile = File(...),
) -> StationOut:
    """Ein 3D-Modell für eine Station ablegen.

    Erlaubt sind GLB (selbstenthaltend), OBJ und STL. Die Datei bleibt im
    Datenordner; in der Datenbank steht nur der Name. Größe und Endung sind
    begrenzt, GLB wird am Kopf erkannt. Ein vorhandenes Modell wird ersetzt.
    """
    s = db.get(FactoryStation, sid)
    if not s:
        raise HTTPException(status_code=404, detail="Station nicht gefunden.")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in MODEL_SUFFIXES:
        raise HTTPException(status_code=400, detail="Nur .glb, .obj oder .stl erlaubt.")
    data = bytearray()
    try:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MODEL_MAX_BYTES:
                raise HTTPException(status_code=413, detail="Modell ist größer als 25 MB.")
    finally:
        await file.close()
    if not data:
        raise HTTPException(status_code=400, detail="Die Datei ist leer.")
    if suffix == ".glb" and bytes(data[:4]) != b"glTF":
        raise HTTPException(status_code=400, detail="Das ist keine gültige GLB-Datei.")
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    name = f"station-{sid}-{uuid.uuid4().hex}{suffix}"
    path = _model_path(name)
    path.write_bytes(data)
    old = s.model_file
    s.model_file = name
    if old and old != name:
        try:
            _model_path(old).unlink(missing_ok=True)
        except OSError:
            pass
    _audit(db, admin, "station_model_upload", "factory_station", sid,
           file=name, bytes=len(data))
    db.refresh(s)
    queue, counts, last = _station_context(db)
    return _station_out(s, queue, counts, last)


@router.get("/stations/{sid}/model")
def get_station_model(
    sid: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> FileResponse:
    """Das hinterlegte Modell — nur für angemeldete Mitarbeiter."""
    s = db.get(FactoryStation, sid)
    if not s or not s.model_file:
        raise HTTPException(status_code=404, detail="Kein Modell hinterlegt.")
    path = _model_path(s.model_file)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Modelldatei fehlt.")
    media_type = MODEL_MEDIA.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, filename=path.name)


@router.delete("/stations/{sid}/model", response_model=StationOut)
def delete_station_model(
    sid: int,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> StationOut:
    s = db.get(FactoryStation, sid)
    if not s:
        raise HTTPException(status_code=404, detail="Station nicht gefunden.")
    old = s.model_file
    s.model_file = ""
    if old:
        try:
            _model_path(old).unlink(missing_ok=True)
        except OSError:
            pass
    _audit(db, admin, "station_model_delete", "factory_station", sid)
    db.refresh(s)
    queue, counts, last = _station_context(db)
    return _station_out(s, queue, counts, last)


@router.delete("/stations/{sid}", status_code=204)
def delete_station(
    sid: int,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> None:
    s = db.get(FactoryStation, sid)
    if not s:
        raise HTTPException(status_code=404, detail="Station nicht gefunden.")
    # Zuordnungen lösen, statt sie mit ins Nichts zu reißen: ein Innenauftrag
    # ohne Station ist planbar, ein Innenauftrag mit einer gelöschten nicht.
    released = db.query(WorkOrder).filter(WorkOrder.station_id == sid).all()
    for wo in released:
        wo.station_id = None
        wo.assign_mode = ""
        wo.assign_reason = "Station gelöscht — neu zu planen"
        wo.planned_min = 0.0
    label = s.label
    if s.model_file:
        try:
            _model_path(s.model_file).unlink(missing_ok=True)
        except OSError:
            pass
    db.delete(s)
    _audit(db, admin, "station_delete", "factory_station", sid, label=label,
           released=[wo.no for wo in released])


# ==========================================================================
# Einstellungen
# ==========================================================================
class SettingIn(BaseModel):
    value: str


class SettingOut(BaseModel):
    key: str
    value: str


@router.get("/settings", response_model=list[SettingOut])
def list_settings(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> list[SettingOut]:
    rows = db.query(FactorySetting).order_by(FactorySetting.key.asc()).all()
    return [SettingOut(key=r.key, value=r.value) for r in rows]


@router.get("/settings/{key}", response_model=SettingOut)
def get_setting(
    key: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> SettingOut:
    return SettingOut(key=key, value=fr.setting(db, key))


@router.put("/settings/{key}", response_model=SettingOut)
def put_setting(
    key: str,
    body: SettingIn,
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
) -> SettingOut:
    before = fr.setting(db, key)
    fr.set_setting(db, key, body.value, admin.email)
    if before != body.value:
        db.add(AuditLog(actor=admin.email, action="factory_setting", entity="factory_setting",
                        entity_id=key, detail={"before": before, "after": body.value}))
    db.commit()
    return SettingOut(key=key, value=body.value)


# ==========================================================================
# Stationssicht
# ==========================================================================
def _stage_of(o: Order) -> dict:
    """Wo der Auftrag steht — als Stufe *und* als Zeitpunkt.

    Die Stufen stehen an jedem Auftrag (``stages``), aber als rohe Liste; die
    Oberfläche braucht daraus einen Fortschritt, den man ansehen kann.
    """
    stages = o.stages or []
    return {
        "stage": int(o.stage or 0),
        "blocked": bool(o.blocked),
        "steps": [
            {
                "idx": i,
                "name": (s.get("name") if isinstance(s, dict) else str(s))
                or f"Stufe {i}",
                "at": (s.get("at") if isinstance(s, dict) else None),
                "done": i <= int(o.stage or 0),
            }
            for i, s in enumerate(stages)
        ],
    }


@router.get("/stations/{sid}/view")
def station_view(
    sid: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Alles, was diese Station braucht — und nichts, was sie nichts angeht.

    Die Zusammenstellung folgt dem Typ: eine Fertigungsstation bekommt ihre
    Innenaufträge und ihre Warteschlange, ein Lager seine Bestände und die
    Kommissionierung, der Versand seine Sendungen, die Buchhaltung ihre
    Belege. Die Filterung nach Werkstoff und Dicke gilt überall gleich.
    """
    # Halle: Bestellzeichen statt Kundenname (services/floor_view.py).
    office = floor_view.is_office(user)
    station = db.get(FactoryStation, sid)
    if not station:
        raise HTTPException(status_code=404, detail="Station nicht gefunden.")
    is_admin = has_admin_work(user)
    is_assigned = user.id in (station.assigned_users or [])
    all_for_all = fr.setting(db, "all_for_all", "0") == "1"
    if not (is_admin or all_for_all or is_assigned):
        if station.visibility == StationVisibility.hide:
            raise HTTPException(
                status_code=403, detail="Kein Zugriff auf diese Station."
            )

    mats = set(station.materials or [])
    thks = {float(t) for t in (station.thicknesses or [])}
    stype = station.type.value if hasattr(station.type, "value") else str(station.type)

    from sqlalchemy.orm import defer as _defer, selectinload as _selectinload
    from ..db import chunked_in as _chunked_in

    orders = (
        db.query(Order)
        .options(
            _selectinload(Order.positions).defer(OrderPosition.shape),
            _defer(Order.ship_address),
            _defer(Order.bill_address),
            _defer(Order.office_note),
            _defer(Order.manual_shipment),
        )
        .order_by(Order.created_at.desc(), Order.id.desc())
        .limit(200)
        .all()
    )
    handler_ids = {o.handler_user_id for o in orders if o.handler_user_id}
    handlers = (
        {
            uid: (uname or uemail)
            for uid, uname, uemail in db.query(User.id, User.name, User.email)
            .filter(_chunked_in(User.id, handler_ids))
            .all()
        }
        if handler_ids
        else {}
    )

    # Plattenfortschritt je Kundenauftrag: begrenzt auf die geladenen Aufträge
    # statt Vollscan über alle historischen WorkItems.
    order_nos = [o.no for o in orders if o.no]
    plate_rows = (
        db.query(
            WorkItem.order_no,
            WorkItem.work_order_id,
            WorkPlate.idx,
            WorkPlate.status,
        )
        .join(WorkPlate, WorkItem.plate_id == WorkPlate.id)
        .join(WorkOrder, WorkItem.work_order_id == WorkOrder.id)
        .filter(_chunked_in(WorkItem.order_no, order_nos))
        .distinct()
        .all()
        if order_nos
        else []
    )
    plate_progress: dict[str, dict[str, int]] = {}
    for order_no, _wo_id, _idx, pl_status in plate_rows:
        if not order_no:
            continue
        e = plate_progress.setdefault(order_no, {"total": 0, "done": 0})
        e["total"] += 1
        val = pl_status.value if hasattr(pl_status, "value") else str(pl_status)
        if val == "done":
            e["done"] += 1

    filtered: list[dict] = []
    hidden = 0
    for o in orders:
        relevant = not mats and not thks
        for p in o.positions:
            if mats and p.mat in mats:
                relevant = True
            if thks and p.thk in thks:
                relevant = True
        if (
            not relevant
            and station.visibility == StationVisibility.hide
            and not (is_admin or all_for_all)
        ):
            hidden += 1
            continue
        filtered.append(
            {
                "no": o.no,
                "customer_ref": o.customer_ref,
                "stage": o.stage,
                "relevant": relevant,
                "rush": bool(o.rush),
                "released": bool(o.released),
                "blocked": bool(o.blocked),
                "due_date": o.due_date.isoformat() if o.due_date else None,
                "created_at": o.created_at.isoformat() if o.created_at else None,
                "handler_user_id": o.handler_user_id,
                "handler": handlers.get(o.handler_user_id or 0, ""),
                "handler_reason": o.handler_reason or "",
                "progress": _stage_of(o),
                "plates_done": plate_progress.get(o.no, {}).get("done", 0),
                "n_plates": plate_progress.get(o.no, {}).get("total", 0),
                "positions": [
                    {
                        "id": p.id,
                        "mat": p.mat,
                        "thk": p.thk,
                        "qty": p.qty,
                        "label": p.label,
                        "od": p.od,
                        "di": p.di,
                        "production_status": getattr(p, "production_status", ""),
                    }
                    for p in o.positions
                ],
            }
        )

    visible_materials = []
    for prod in db.query(Product).order_by(Product.name.asc()).all():
        if mats and prod.id not in mats:
            continue
        if thks and not any(float(t) in thks for t in (prod.thicknesses or [])):
            continue
        visible_materials.append(
            {
                "id": prod.id,
                "name": prod.name,
                "stock": prod.stock,
                "eur_m2": prod.eur_m2,
                "thicknesses": list(prod.thicknesses or []),
                "lead_days": getattr(prod, "lead_days", 0),
            }
        )

    queue, counts, last = _station_context(db)
    out = _station_out(station, queue, counts, last)

    # Warteschlange: alle offenen/laufenden Innenaufträge dieser Station plus
    # die letzten 50 abgeschlossenen (statt Millionen historische Einträge).
    active_wos = (
        db.query(WorkOrder)
        .options(_defer(WorkOrder.auto_layout))
        .filter(
            WorkOrder.station_id == sid,
            WorkOrder.status.in_((WorkOrderStatus.open, WorkOrderStatus.running)),
        )
        .order_by(WorkOrder.created_at.asc())
        .all()
    )
    recent_done_wos = (
        db.query(WorkOrder)
        .options(_defer(WorkOrder.auto_layout))
        .filter(
            WorkOrder.station_id == sid,
            WorkOrder.status.notin_((WorkOrderStatus.open, WorkOrderStatus.running)),
        )
        .order_by(WorkOrder.created_at.desc())
        .limit(50)
        .all()
    )
    q_rows = twin.in_worklist_order(db, sid, active_wos + list(reversed(recent_done_wos)))
    # Welche Kundenaufträge stecken in jedem Innenauftrag — der Werker soll
    # sehen, wessen Teile auf der Platte liegen, ohne den Laufkartendruck zu
    # suchen. Nach Auftrag zusammengefasst, Stückzahl summiert.
    wo_ids = [w.id for w in q_rows]
    items_by_wo: dict[int, dict[str, dict]] = {}
    if wo_ids:
        item_rows = (
            db.query(
                WorkItem.work_order_id,
                WorkItem.order_no,
                WorkItem.customer,
                WorkItem.customer_ref,
                WorkItem.qty,
            )
            .filter(WorkItem.work_order_id.in_(wo_ids))
            .all()
        )
        for wo_id, order_no, customer, customer_ref, qty in item_rows:
            slot = items_by_wo.setdefault(int(wo_id), {})
            entry = slot.setdefault(
                order_no or "",
                {
                    "order_no": order_no or "",
                    "customer": floor_view.customer_or_ref(customer, customer_ref, office),
                    "n_parts": 0,
                },
            )
            entry["n_parts"] += int(qty or 1)
    queue_jobs = [
        {
            "no": w.no,
            "mat": w.mat,
            "mat_name": w.mat_name,
            "thk": w.thk,
            "status": w.status.value if hasattr(w.status, "value") else str(w.status),
            "n_plates": w.n_plates,
            "n_parts": w.n_parts,
            "n_orders": w.n_orders,
            "utilisation": round(w.utilisation or 0.0, 4),
            "planned_min": round(w.planned_min or 0.0, 1),
            "assign_mode": w.assign_mode or "",
            "assign_reason": w.assign_reason or "",
            "assign_score": round(w.assign_score or 0.0, 1),
            "due_date": w.due_date.isoformat() if w.due_date else None,
            "release_reason": w.release_reason or "",
            "note": w.note or "",
            "created_at": w.created_at.isoformat() if w.created_at else None,
            "started_at": w.started_at.isoformat() if w.started_at else None,
            "orders": sorted(
                items_by_wo.get(w.id, {}).values(),
                key=lambda o: o["order_no"],
            ),
        }
        for w in q_rows
    ]

    # Der Weg zum Lager — die Zahl, mit der die Zuordnung gerechnet hat.
    layout = fr.layout_of(db)
    stores = [
        s
        for s in db.query(FactoryStation)
        .filter(FactoryStation.is_storage.is_(True))
        .all()
        if s.active
    ]
    supply = []
    for s in stores:
        r = layout.route((s.x, s.y), (station.x, station.y))
        supply.append(
            {
                "id": s.id,
                "label": s.label,
                "metres": round(r.metres, 1),
                "minutes": round(r.minutes, 1),
                "exact": r.exact,
                "note": r.note,
                "materials": list(s.materials or []),
            }
        )
    supply.sort(key=lambda e: e["metres"])

    return {
        "station": out.model_dump(),
        "station_type": stype,
        "all_for_all": all_for_all,
        "can_edit": is_admin,
        "orders": filtered,
        "hidden_count": hidden,
        "materials": visible_materials,
        "queue": queue_jobs,
        "supply": supply,
        "auto_routing": fr.auto_routing_enabled(db),
    }


# ==========================================================================
# Zuordnung: Maschinen
# ==========================================================================
@router.get("/work-orders/{no}/ranking")
def work_order_ranking(
    no: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    """Warum welche Maschine — die volle Zerlegung, auch der Ausschlüsse."""
    wo = db.query(WorkOrder).filter(WorkOrder.no == no).first()
    if not wo:
        raise HTTPException(status_code=404, detail="Innenauftrag nicht gefunden.")
    job = fr.job_spec(db, wo)
    ranking = fr.rank_for_work_order(db, wo)
    return {
        "job": {
            "no": job.no,
            "mat": job.mat,
            "mat_name": job.mat_name,
            "thk": job.thk,
            "n_plates": job.n_plates,
            "n_parts": job.n_parts,
            "cut_len_mm": round(job.cut_len_mm, 1),
            "plate_mm": list(job.plate_mm),
            "rush": job.rush,
            "due_in_days": round(job.due_in_days, 2)
            if job.due_in_days is not None
            else None,
            "customer_refs": job.customer_refs,
        },
        "assigned_station_id": wo.station_id,
        "ranking": [a.to_dict() for a in ranking],
    }


class SimulateIn(BaseModel):
    mat: str = "EPDM"
    thk: float = 3.0
    n_plates: int = 1
    n_parts: int = 10
    cut_len_mm: float = 8000.0
    plate_mm: list[float] = Field(default_factory=lambda: [1000.0, 1000.0])
    rush: bool = False
    due_in_days: Optional[float] = None
    customer_ref: str = ""


@router.post("/routing/simulate")
def simulate_routing(
    body: SimulateIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    """Was wäre wenn — Routing für einen hypothetischen Auftrag testen.

    Ohne Datenbank-Schreiben: nimmt dieselbe Bewertung wie der echte
    Innenauftrag, aber mit freien Parametern. Der Meister sieht sofort, ob
    ein Eilauftrag die eingerichtete Maschine schlägt oder ob eine andere
    Dickenfreigabe den Zuschlag ändern würde.
    """
    from ..core.routing import JobSpec

    job = JobSpec(
        no="SIM",
        mat=body.mat,
        mat_name=body.mat,
        thk=float(body.thk),
        n_plates=int(body.n_plates),
        n_parts=int(body.n_parts),
        cut_len_mm=float(body.cut_len_mm),
        plate_mm=(float(body.plate_mm[0]), float(body.plate_mm[1]))
        if len(body.plate_mm) >= 2
        else (0.0, 0.0),
        rush=body.rush,
        due_in_days=body.due_in_days,
        customer_refs=[body.customer_ref] if body.customer_ref else [],
    )
    ranking = fr.rank_for_job(db, job)
    weights = fr.weights_from_settings(db)
    return {
        "job": {
            "mat": job.mat,
            "thk": job.thk,
            "n_plates": job.n_plates,
            "n_parts": job.n_parts,
            "cut_len_mm": job.cut_len_mm,
            "plate_mm": list(job.plate_mm),
            "rush": job.rush,
            "due_in_days": job.due_in_days,
        },
        "weights": {
            "changeover": weights.changeover,
            "deadline": weights.deadline,
            "speed": weights.speed,
            "load": weights.load,
            "distance": weights.distance,
            "fit": weights.fit,
        },
        "ranking": [a.to_dict() for a in ranking],
    }


class AssignIn(BaseModel):
    station_id: Optional[int] = None
    note: str = ""


@router.post("/work-orders/{no}/assign")
def assign_work_order(
    no: str,
    body: AssignIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    """Von Hand zuordnen — die Werkstattentscheidung des Meisters.

    Sie ändert die Planung nicht rückwirkend und fließt in keine Regel
    zurück: die Zuordnung lernt nicht (siehe ``domain/routing.py``). Was
    bleibt, ist die Begründung auf dem Innenauftrag — der nächste, der
    sich fragt, warum diese Maschine, liest sie dort nach.
    """
    wo = db.query(WorkOrder).filter(WorkOrder.no == no).first()
    if not wo:
        raise HTTPException(status_code=404, detail="Innenauftrag nicht gefunden.")
    if wo.status in (WorkOrderStatus.done, WorkOrderStatus.cancelled):
        raise HTTPException(
            status_code=409,
            detail="Fertige und stornierte Innenaufträge werden nicht umgeplant.",
        )
    before = wo.station_id
    try:
        fr.assign(
            db, wo, body.station_id, mode="manual", who=user.email, reason=body.note
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    _audit(db, user, "work_order_assign", "work_order", wo.no,
           before=before, station_id=wo.station_id, note=body.note)
    return {
        "no": wo.no,
        "station_id": wo.station_id,
        "planned_min": round(wo.planned_min or 0.0, 1),
        "assign_reason": wo.assign_reason,
    }


@router.get("/plan")
def get_plan(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
    limit: int = Query(default=60, le=200),
    include_assigned: bool = Query(default=False),
) -> dict:
    """Was der Planer täte — ohne es zu tun.

    Die Trennung ist der Punkt: der Vorschlag ist lesbar, bevor er wirkt.
    ``auto`` heißt „diese Station hat sich dafür angemeldet", ``suggest``
    heißt „hier drückt ein Mensch", ``none`` heißt „keine Station im Smart-
    Routing" — und dann steht daneben, warum.
    """
    sugs = fr.plan_open_work_orders(db, limit=limit, include_assigned=include_assigned)
    return {
        "auto_routing": fr.auto_routing_enabled(db),
        "suggestions": [s.to_dict() for s in sugs],
        "counts": {
            "auto": sum(1 for s in sugs if s.mode == "auto"),
            "suggest": sum(1 for s in sugs if s.mode == "suggest"),
            "none": sum(1 for s in sugs if s.mode == "none"),
        },
    }


class ApplyIn(BaseModel):
    #: Leer = alles anwenden, was das Opt-in erlaubt.
    job_nos: list[str] = []
    #: True übernimmt auch Vorschläge, die nur „vorschlagen" dürfen — das ist
    #: der Knopf, den ein Mensch drückt.
    include_suggested: bool = False


@router.post("/plan/apply")
def apply_plan_endpoint(
    body: ApplyIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    if not body.include_suggested and not fr.auto_routing_enabled(db):
        raise HTTPException(
            status_code=409,
            detail="Automatische Zuordnung ist ausgeschaltet. "
            "Einzelne Vorschläge lassen sich trotzdem übernehmen.",
        )
    sugs = fr.plan_open_work_orders(db, limit=200)
    if body.job_nos:
        wanted = set(body.job_nos)
        sugs = [s for s in sugs if s.job_no in wanted]
    applied = fr.apply_plan(
        db, sugs, who=user.email, only_auto=not body.include_suggested
    )
    # Danach gilt die Nachschub-Regel: was nach dem Übernehmen noch leer ist,
    # wird gefüllt, solange passende Aufträge warten.
    fed = fr.ensure_fed(db, who=user.email)
    if applied or fed:
        _audit(db, user, "plan_apply", "work_order", "plan",
               applied=len(applied), fed=len(fed))
    return {"applied": applied, "count": len(applied), "fed": fed}


@router.post("/plan/feed")
def feed_empty_stations(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    """Nachschub auf Knopfdruck: leere Stationen füllen, solange Arbeit wartet.

    Derselbe Lauf, den auch der Sammellauf-Takt und jedes Übernehmen des
    Plans anstößt — hier von Hand, für den Moment, in dem der Meister sieht,
    dass eine Maschine dasteht und nichts tut.
    """
    if not fr.auto_routing_enabled(db):
        raise HTTPException(
            status_code=409,
            detail="Automatische Zuordnung ist ausgeschaltet — der Nachschub "
            "greift nur, wenn der Hauptschalter an ist.",
        )
    if not fr.feed_empty_enabled(db):
        raise HTTPException(
            status_code=409,
            detail="Der Nachschub ist in den Betriebsschaltern ausgeschaltet.",
        )
    fed = fr.ensure_fed(db, who=user.email)
    if fed:
        _audit(db, user, "plan_feed", "work_order", "plan", fed=len(fed))
    return {"fed": fed, "count": len(fed)}


@router.get("/stations/{sid}/queue")
def station_queue(
    sid: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    station = db.get(FactoryStation, sid)
    if not station:
        raise HTTPException(status_code=404, detail="Station nicht gefunden.")
    rows = (
        db.query(WorkOrder)
        .filter(WorkOrder.station_id == sid)
        .filter(WorkOrder.status.in_(fr.OPEN_STATUSES))
        .order_by(WorkOrder.created_at.asc())
        .all()
    )
    total = sum(float(w.planned_min or 0.0) for w in rows)
    cap = float(station.capacity_min_per_day or 0.0)
    return {
        "station_id": sid,
        "label": station.label,
        "jobs": [
            {
                "no": w.no,
                "mat": w.mat,
                "thk": w.thk,
                "planned_min": round(w.planned_min or 0.0, 1),
                "status": w.status.value
                if hasattr(w.status, "value")
                else str(w.status),
                "due_date": w.due_date.isoformat() if w.due_date else None,
            }
            for w in rows
        ],
        "total_min": round(total, 1),
        "capacity_min_per_day": cap,
        "days": round(total / cap, 2) if cap > 0 else None,
    }


# ==========================================================================
# Zuordnung: Auftragsbearbeitung
# ==========================================================================
@router.get("/orders/{order_no}/handlers")
def order_handlers(
    order_no: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    o = db.query(Order).filter(Order.no == order_no).first()
    if not o:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    return {
        "order_no": order_no,
        "customer_ref": o.customer_ref,
        "handler_user_id": o.handler_user_id,
        "handler_reason": o.handler_reason or "",
        "ranking": [a.to_dict() for a in fr.rank_for_order(db, o)],
    }


class HandlerIn(BaseModel):
    user_id: Optional[int] = None
    note: str = ""


@router.post("/orders/{order_no}/handler")
def set_order_handler(
    order_no: str,
    body: HandlerIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    o = db.query(Order).filter(Order.no == order_no).first()
    if not o:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    reason = body.note
    if body.user_id is not None and not reason:
        top = next(
            (a for a in fr.rank_for_order(db, o) if a.user_id == body.user_id), None
        )
        reason = top.summary if top else ""
    before = o.handler_user_id
    try:
        fr.set_handler(db, o, body.user_id, reason=reason)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    if before != o.handler_user_id:
        _audit(db, user, "order_handler", "order", o.no,
               before=before, handler_user_id=o.handler_user_id)
    return {
        "order_no": order_no,
        "handler_user_id": o.handler_user_id,
        "handler_reason": o.handler_reason,
    }


@router.get("/handlers/plan")
def handler_plan(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
    limit: int = Query(default=40, le=200),
) -> dict:
    """Vorschläge für alle Aufträge, die noch keinen Bearbeiter haben."""
    rows = (
        db.query(Order)
        .filter(Order.handler_user_id.is_(None))
        .filter(Order.stage < 4)
        .filter(Order.cancelled_at.is_(None))
        .order_by(Order.created_at.desc())
        .limit(limit)
        .all()
    )
    out = []
    for o in rows:
        ranking = fr.rank_for_order(db, o)
        best = next((a for a in ranking if a.eligible), None)
        out.append(
            {
                "order_no": o.no,
                "customer_ref": o.customer_ref,
                "created_at": o.created_at.isoformat() if o.created_at else None,
                "rush": bool(o.rush),
                "user_id": best.user_id if best else None,
                "name": best.name if best else "",
                "score": round(best.score, 1) if best else 0.0,
                "reason": best.summary if best else "kein Bearbeiter verfügbar",
                "ranking": [a.to_dict() for a in ranking[:5]],
            }
        )
    return {"suggestions": out, "count": len(out)}


# ==========================================================================
# Fluss
# ==========================================================================
@router.get("/flow")
def flow(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Was zwischen den Stationen läuft — die Pfeile im Plan."""
    edges = fr.material_flow(db)
    total_m = sum(e["metres"] * e["count"] for e in edges)
    return {
        "edges": edges,
        "total_transport_m": round(total_m, 1),
        "exact": all(e["exact"] for e in edges) if edges else False,
    }


@router.post("/stations/{sid}/complete/{order_no}")
def mark_completed(
    sid: int,
    order_no: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Fertigmeldung an der Station — ein Produktionsakt, kein Lernvorgang.

    Alle Innenaufträge dieses Kundenauftrags an dieser Station gehen auf
    ``done``, mit denselben Folgen wie die einzelne Statusmeldung in
    ``/production``: Platten und Positionen fertig, Zeitpunkt und Melder
    festgehalten, Audit-Eintrag. Die Zuordnung zieht daraus kein „Erfahrung“
    — sie rechnet mit Physik, nicht mit Zählern.
    """
    station = db.get(FactoryStation, sid)
    if not station:
        raise HTTPException(status_code=404, detail="Station nicht gefunden.")
    order = db.query(Order).filter(Order.no == order_no).first()
    if not order:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    now = datetime.now(timezone.utc)
    wos = (
        db.query(WorkOrder)
        .join(WorkItem, WorkItem.work_order_id == WorkOrder.id)
        .filter(WorkOrder.station_id == sid)
        .filter(WorkItem.order_no == order_no)
        .filter(WorkOrder.status.in_(fr.OPEN_STATUSES))
        .distinct()
        .all()
    )
    closed: list[str] = []
    if not wos:
        # Stille Erfolgsmeldungen sind verboten: ein Knopf, der „fertig"
        # sagt und nichts tut, lässt Aufträge zwischen Fertigung und Versand
        # verschwinden. Der Fehlertext sagt, wo der Innenauftrag stattdessen
        # liegt bzw. warum es hier nichts zu schließen gibt.
        assigned = (
            db.query(WorkOrder)
            .join(WorkItem, WorkItem.work_order_id == WorkOrder.id)
            .filter(WorkItem.order_no == order_no)
            .filter(WorkOrder.status.in_(fr.OPEN_STATUSES))
            .distinct()
            .all()
        )
        if assigned:
            names = ", ".join(
                f"{w.no} an {db.get(FactoryStation, w.station_id).label}"
                if w.station_id else f"{w.no} ohne Station"
                for w in assigned
            )
            raise HTTPException(
                status_code=409,
                detail=f"Kein offener Innenauftrag von {order_no} an dieser "
                f"Station — der Auftrag läuft hier: {names}.",
            )
        raise HTTPException(
            status_code=409,
            detail=f"Zu {order_no} gibt es keinen offenen Innenauftrag — "
            "der Auftrag ist noch nicht im Sammellauf geplant oder bereits fertig.",
        )
    for wo in wos:
        wo.status = WorkOrderStatus.done
        wo.done_at, wo.done_by = now, user.email
        for p in wo.plates:
            p.status = WorkOrderStatus.done
        item_orders = {
            i.order_no
            for i in db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
        }
        wo.order_done = {ono: now.isoformat() for ono in item_orders}
        ids = [
            i.position_id
            for i in db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
            if i.position_id
        ]
        if ids:
            (
                db.query(OrderPosition)
                .filter(OrderPosition.id.in_(ids))
                .update(
                    {OrderPosition.production_status: "done"},
                    synchronize_session=False,
                )
            )
        db.add(
            AuditLog(
                actor=user.email,
                action="station_complete",
                entity="work_order",
                entity_id=wo.no,
                detail={"order_no": order_no, "station_id": sid},
            )
        )
        closed.append(wo.no)
    db.commit()
    return {"ok": True, "done": closed}


# Alter Pfad der Stationsseite — bleibt, damit verteilte Links weiter landen.
@router.get("/orders/ranking/{order_no}")
def order_ranking_legacy(
    order_no: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    o = db.query(Order).filter(Order.no == order_no).first()
    if not o:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    # Ein Kundenauftrag hat keine Maschine — seine Innenaufträge haben eine.
    # Was hier gefragt ist, ist trotzdem beantwortbar: die beste Station über
    # alle Innenaufträge dieses Auftrags.
    item_wos = (
        db.query(WorkOrder)
        .join(WorkItem, WorkItem.work_order_id == WorkOrder.id)
        .filter(WorkItem.order_no == order_no)
        .distinct()
        .all()
    )
    if not item_wos:
        return {
            "order_no": order_no,
            "ranking": [],
            "note": "Noch kein Innenauftrag — der Sammellauf hat diesen Auftrag nicht geplant.",
        }
    merged: dict[int, dict] = {}
    factor_acc: dict[int, dict[str, dict]] = {}
    for wo in item_wos:
        for a in fr.rank_for_work_order(db, wo):
            e = merged.setdefault(
                a.station_id,
                {
                    "station_id": a.station_id,
                    "label": a.label,
                    "score": 0.0,
                    "routing": a.routing,
                    "reason": a.summary,
                    "eligible": a.eligible,
                    "blockers": a.blockers,
                    "minutes": a.minutes,
                    "completion_min": a.completion_min,
                    "cost_eur": a.cost_eur,
                    "route_m": a.route_m,
                    "changeover": a.changeover,
                },
            )
            e["score"] += a.score
            e["eligible"] = e["eligible"] and a.eligible
            # Faktoren über alle Innenaufträge des Auftrags mitteln — nur Punkte,
            # nicht die Texte, damit „Rüsten spart Stunden" nicht dreimal zählt.
            acc = factor_acc.setdefault(a.station_id, {})
            for f in a.factors:
                prev = acc.get(f.key)
                if prev is None:
                    acc[f.key] = {
                        "key": f.key,
                        "label": f.label,
                        "points": f.points,
                        "max": f.max_points,
                        "reason": f.reason,
                        "count": 1,
                    }
                else:
                    prev["points"] += f.points
                    prev["count"] += 1
                    # Längsten/clearest Reason behalten
                    if len(f.reason) > len(prev["reason"]):
                        prev["reason"] = f.reason
    ranking = sorted(merged.values(), key=lambda e: -e["score"])
    for e in ranking:
        n = max(1, len(item_wos))
        e["score"] = round(e["score"] / n, 1)
        if e["station_id"] in factor_acc:
            acc = factor_acc[e["station_id"]]
            factors = []
            for fd in acc.values():
                factors.append(
                    {
                        "key": fd["key"],
                        "label": fd["label"],
                        "points": round(fd["points"] / fd["count"], 1),
                        "max": round(fd["max"], 1),
                        "share": round((fd["points"] / fd["count"]) / fd["max"], 3)
                        if fd["max"] > 0
                        else 0,
                        "reason": fd["reason"],
                    }
                )
            # Gleiche Ordnung wie im Kern: Rüsten, Zusage, Speed, Last, Weg, Eingrenzung, Termindruck
            order = {"changeover": 0, "deadline": 1, "speed": 2, "load": 3, "distance": 4, "fit": 5, "rush": 6}
            factors.sort(key=lambda f: order.get(f["key"], 99))
            e["factors"] = factors
        if e.get("blockers") is None:
            e["blockers"] = []
        if e.get("minutes") is not None:
            e["minutes"] = round(e["minutes"], 1)
        if e.get("completion_min") is not None:
            e["completion_min"] = round(e["completion_min"], 1)
        if e.get("cost_eur") is not None:
            e["cost_eur"] = round(e["cost_eur"], 2)
        if e.get("route_m") is not None:
            e["route_m"] = round(e["route_m"], 1)
    return {"order_no": order_no, "ranking": ranking}


# ==========================================================================
# Materialfluss — die Daten hinter der Zwilling-Übersicht
# ==========================================================================
def _customer_slots(
    db: Session, wo_ids: list[int], office: bool = True
) -> tuple[dict[int, dict[str, dict]], dict[str, tuple[bool, Optional[datetime]]]]:
    """Teile je Innenauftrag nach Kundenauftrag — eine Abfrage für alle.

    Eil und Termine stehen am Kundenauftrag, nicht am Innenauftrag — dieselbe
    Regel wie in job_spec, hier als Sammelabfrage. Die Zwilling-Übersicht und
    die Bereitstellungsliste lesen daraus dieselben Zahlen.
    """
    per_wo: dict[int, dict[str, dict]] = {}
    if not wo_ids:
        return per_wo, {}
    item_rows = (
        db.query(
            WorkItem.work_order_id,
            WorkItem.order_no,
            WorkItem.customer,
            WorkItem.customer_ref,
            WorkItem.qty,
        )
        .filter(WorkItem.work_order_id.in_(wo_ids))
        .all()
    )
    for wo_id, order_no, customer, customer_ref, qty in item_rows:
        slot = per_wo.setdefault(int(wo_id), {})
        entry = slot.setdefault(
            order_no or "",
            {
                "order_no": order_no or "",
                "customer": floor_view.customer_or_ref(customer, customer_ref, office),
                "n_parts": 0,
            },
        )
        entry["n_parts"] += int(qty or 1)

    order_nos = sorted({o for v in per_wo.values() for o in v if o})
    order_info: dict[str, tuple[bool, Optional[datetime]]] = {}
    if order_nos:
        for o in db.query(Order).filter(Order.no.in_(order_nos)).all():
            order_info[o.no] = (bool(o.rush), o.due_date)
    return per_wo, order_info


def _wo_slots(
    w: WorkOrder,
    per_wo: dict[int, dict[str, dict]],
    order_info: dict[str, tuple[bool, Optional[datetime]]],
) -> tuple[list[dict], bool, Optional[str]]:
    """Kundenslots, Eilflag und frühester Termin (ISO) eines Innenauftrags."""
    slot = per_wo.get(w.id, {})
    o_nos = sorted(slot)
    rush = any(order_info.get(n, (False, None))[0] for n in o_nos)
    dues: list[datetime] = []
    for n in o_nos:
        d = order_info.get(n, (False, None))[1]
        if d is not None:
            dues.append(d)
    if w.due_date:
        dues.append(w.due_date)
    due = min(dues).isoformat() if dues else None
    return sorted(slot.values(), key=lambda o: o["order_no"]), rush, due


@router.get("/pipeline")
def pipeline(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    limit: int = Query(default=200, le=500),
) -> dict:
    """Jeder offene Innenauftrag, jede Station, alles in einem Abruf.

    Die Flussansicht zeichnet die Halle als Ablauf: Planung (noch ohne
    Maschine) → Fertigungsstationen (Schlange) → Versandfertig. Dafür braucht
    sie pro Innenauftrag dieselben Dinge wie die Stationsseite — Werkstoff,
    Platten, geplante Zeit, Fälligkeit, die Kunden dahinter — und die
    Stationen mit ihrer Kapazität. Ein Abruf, nicht zwanzig: die Ansicht
    aktualisiert sich von selbst, und zwanzig Abrufe alle dreißig Sekunden
    wären eine Last, die niemand bestellt hat.
    """
    rows = (
        db.query(WorkOrder)
        .filter(WorkOrder.status.in_(fr.OPEN_STATUSES))
        .order_by(WorkOrder.created_at.asc())
        .limit(limit)
        .all()
    )
    wo_ids = [w.id for w in rows]
    per_wo, order_info = _customer_slots(db, wo_ids, floor_view.is_office(user))

    jobs: list[dict] = []
    for w in rows:
        slots, rush, due = _wo_slots(w, per_wo, order_info)
        jobs.append(
            {
                "no": w.no,
                "mat": w.mat,
                "mat_name": w.mat_name,
                "thk": float(w.thk or 0.0),
                "status": w.status.value
                if hasattr(w.status, "value")
                else str(w.status),
                "n_plates": int(w.n_plates or 0),
                "n_parts": int(w.n_parts or 0),
                "planned_min": round(w.planned_min or 0.0, 1),
                "utilisation": round(w.utilisation or 0.0, 4),
                "station_id": w.station_id,
                "assign_mode": w.assign_mode or "",
                "assign_reason": w.assign_reason or "",
                "assign_score": round(w.assign_score or 0.0, 1),
                "release_reason": w.release_reason or "",
                "due_date": due,
                "rush": rush,
                "created_at": w.created_at.isoformat() if w.created_at else None,
                "order_done": sorted((w.order_done or {}).keys()),
                "orders": slots,
            }
        )

    # Wo die Station steht: Die Flussansicht zeigt sonst Maschinen aus allen
    # Hallen und Standorten untereinander, ohne dass man sie auseinanderhalten
    # kann. Ein Abruf der Topologie, keine Abfrage je Station.
    topo = site_svc.topology(db)
    stations = []
    for s in db.query(FactoryStation).order_by(FactoryStation.id.asc()).all():
        stype = s.type.value if hasattr(s.type, "value") else str(s.type)
        fid = site_svc.station_floor_id(s, topo.default_floor_id)
        hall = topo.halls.get(topo.floor_hall.get(fid)) if fid is not None else None
        site = topo.sites.get(hall.site_id) if hall is not None else None
        floor = topo.floors.get(fid) if fid is not None else None
        stations.append(
            {
                "id": s.id,
                "label": s.label,
                "type": stype,
                "routing": s.routing.value
                if hasattr(s.routing, "value")
                else str(s.routing),
                "machine_kind": s.machine_kind or "",
                "active": bool(s.active),
                "is_storage": bool(s.is_storage),
                "capacity_min_per_day": float(s.capacity_min_per_day or 0.0),
                "floor_id": s.floor_id,
                "hall_id": hall.id if hall is not None else None,
                "site_id": site.id if site is not None else None,
                "floor_name": (floor.level_name or floor.name) if floor is not None else "",
                "hall_name": hall.name if hall is not None else "",
                "site_name": site.name if site is not None else "",
            }
        )
    queue, counts, last = _station_context(db)
    for st in stations:
        st["queue_min"] = round(float(queue.get(st["id"], 0.0)), 1)
        st["queue_jobs"] = int(counts.get(st["id"], 0))
        lj = last.get(st["id"])
        if lj:
            st["last_mat"], st["last_thk"] = lj[0], lj[1]

    from ..services.shipping import order_ready_rows

    return {
        "stations": stations,
        "jobs": jobs,
        "ready": order_ready_rows(db),
        "auto_routing": fr.auto_routing_enabled(db),
    }


# ==========================================================================
# Bereitstellen — der Produktionsschritt zwischen Zuordnung und Schnitt
# ==========================================================================
@router.get("/staging")
def staging(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    limit: int = Query(default=200, le=500),
) -> dict:
    """Welche Platten an welche Maschine müssen, und was ist schon da.

    Die Bereitstellung ist ein eigener Produktionsschritt: ein Innenauftrag
    kann einer Maschine zugeordnet sein und warten, bis jemand die Platten
    aus dem Regal geholt hat. Diese Sicht ist die Einkaufsliste des Halls
    Diensts — je Zielstation eine Gruppe, je Innenauftrag die Formate zum
    Zählen. Bereitgestellte stehen unten, damit der Weg vom Regal zur
    Maschine aus einer Liste lesbar bleibt.
    """
    rows = (
        db.query(WorkOrder)
        .filter(WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.running]))
        .order_by(WorkOrder.created_at.asc())
        .limit(limit)
        .all()
    )
    per_wo, order_info = _customer_slots(db, [w.id for w in rows], floor_view.is_office(user))

    station_rows = db.query(FactoryStation).order_by(FactoryStation.id.asc()).all()
    # Was an jeder Maschine zuletzt (bzw. jetzt) aufgespannt ist — dieselbe
    # Zahl, die die Zwilling-Übersicht zeigt. Der Rüstwechsel-Hinweis rechnet
    # nichts nach, er liest sie nur.
    last = fr._last_job(db)
    stations = [
        {
            "id": s.id,
            "label": s.label,
            "machine_kind": s.machine_kind or "",
            "type": s.type.value if hasattr(s.type, "value") else str(s.type),
            "active": bool(s.active),
            "last_mat": (last.get(s.id) or ("", 0.0))[0] or "",
            "last_thk": round(float((last.get(s.id) or ("", 0.0))[1] or 0.0), 2),
        }
        for s in station_rows
        if s.type == FactoryStationType.production
    ]
    station_names = {s.id: s.label for s in station_rows}
    station_xy = {s.id: (float(s.x or 0.0), float(s.y or 0.0)) for s in station_rows}

    out: list[dict] = []
    for w in rows:
        slots, rush, due = _wo_slots(w, per_wo, order_info)
        staged = w.material_staged_at is not None
        out.append(
            {
                "no": w.no,
                "mat": w.mat,
                "mat_name": w.mat_name,
                "thk": float(w.thk or 0.0),
                "status": w.status.value
                if hasattr(w.status, "value")
                else str(w.status),
                "formats": w.formats
                or ([[w.fmt[0], w.fmt[1], w.n_plates]] if w.fmt and w.n_plates else []),
                "n_plates": int(w.n_plates or 0),
                "n_parts": int(w.n_parts or 0),
                "planned_min": round(w.planned_min or 0.0, 1),
                "station_id": w.station_id,
                "station_label": station_names.get(w.station_id, "")
                if w.station_id
                else "",
                "due_date": due,
                "rush": rush,
                "staged": staged,
                "staged_at": w.material_staged_at.isoformat()
                if w.material_staged_at
                else None,
                "staged_by": w.material_staged_by or "",
                "staged_location_id": w.material_staged_location_id,
                "staged_location": w.material_staged_location or "",
                "started": w.started_at is not None,
                "release_reason": w.release_reason or "",
                "orders": slots,
            }
        )

    # Reststücke: welche Platten dieses Innenauftrags kommen aus einem Rest?
    # Der Dienst holt dann für sie keine volle Platte, sondern genau dieses
    # Stück (Marke, Maße, Ort) — sonst bricht er doch eine neue Platte an.
    off_by_wo: dict[int, list[dict]] = {}
    if rows:
        where = stockloc._where(db)
        pairs = (db.query(WorkPlate.work_order_id, WorkPlate.idx, Offcut)
                 .join(Offcut, Offcut.id == WorkPlate.offcut_id)
                 .filter(WorkPlate.work_order_id.in_([w.id for w in rows])).all())
        for wo_id, idx, off in pairs:
            item = offcut_svc.row_out(off, where)
            item["plate_idx"] = int(idx)
            off_by_wo.setdefault(wo_id, []).append(item)
    for w, r in zip(rows, out):
        picks = sorted(off_by_wo.get(w.id, []), key=lambda o: o["plate_idx"])
        r["offcuts"] = picks
        r["n_full_plates"] = max(0, r["n_plates"] - len(picks))
        full: dict[tuple[float, float], int] = {}
        taken = {(o["w"], o["h"]) for o in picks}
        for p in w.plates:
            if getattr(p, "offcut_id", None):
                continue
            key = (float(p.fmt[0]), float(p.fmt[1])) if p.fmt else (0.0, 0.0)
            full[key] = full.get(key, 0) + 1
        if w.plates:
            r["full_formats"] = [[a, b, n] for (a, b), n in sorted(full.items())]
        else:
            r["full_formats"] = [f for f in r["formats"] if (f[0], f[1]) not in taken]

    # Bestand daneben: dieselbe Regel wie beim Kommissionieren — eine
    # Bereitstellliste ohne Bestand schickt den Dienst in ein leeres Regal.
    # Bedarf ist, was noch nicht an der Maschine steht; bereitgestellte
    # Platten sind aus dem Regal raus und zählen nicht mehr als Weg.
    stock = {p.id: int(p.stock or 0) for p in db.query(Product).all()}
    # Wo es liegt: je Zeile die Orte genau dieser Dicke, größte Menge zuerst.
    locs = stockloc.for_materials(db, {r["mat"] for r in out})
    for r in out:
        info = stockloc.summarise(locs.get(r["mat"], []), stock.get(r["mat"], 0), r["thk"])
        r["locations"] = info["locations"]
        r["located"] = info["located"]
        # Wo zuerst greifen? Der Vorschlag ist eine Auskunft, keine Buchung:
        # der Werker kann im Dialog jeden anderen Ort wählen.
        target = station_xy.get(r["station_id"]) if r["station_id"] is not None else None
        rec = stockloc.recommend(info["locations"], r["thk"], r["n_full_plates"], target)
        r["recommended_location_id"] = rec["location"]["id"] if rec else None
        r["location_hint"] = rec["reason"] if rec else ""
    demand: dict[str, int] = {}
    for r in out:
        if not r["staged"]:
            demand[r["mat"]] = demand.get(r["mat"], 0) + int(r["n_full_plates"] or 0)
    materials = {
        mat: {
            "stock": stock.get(mat, 0),
            "demand": need,
            "short": stock.get(mat, 0) < need,
        }
        for mat, need in demand.items()
    }

    # Noch nicht bereitgestellt zuerst; unter gleichen: Eil, dann Termin.
    out.sort(
        key=lambda r: (
            r["staged"],
            not r["rush"],
            r["due_date"] or "9999",
            r["no"],
        )
    )
    return {
        "rows": out,
        "stations": stations,
        "counts": {
            "open": sum(1 for r in out if not r["staged"] and not r["started"]),
            "staged": sum(1 for r in out if r["staged"]),
            "plates": sum(r["n_plates"] for r in out if not r["staged"]),
        },
        "materials": materials,
    }


# ==========================================================================
# Zwilling-Analyse — was die Halle heute kostet, was sie besser macht
# ==========================================================================
@router.get("/twin/analysis")
def twin_analysis(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Befunde, keine Aktionen: Engpass, Stillstand, Rüstwechsel, Wege, Termine.

    Rechnet, empfiehlt, ändert nichts. Ausführen darf der Mensch — die
    Verlagerungen eines Befunds landen als konkrete Zuordnungen in der
    Flussansicht, ein Klick je Innenauftrag.
    """
    return twin.analyse(db)


# ==========================================================================
# Umriss aus DXF — die Halle aus dem CAD übernehmen
# ==========================================================================
def _simplify_points(pts: list[list[float]], *, keep: int = 400) -> list[list[float]]:
    """Kollineare Punkte werfen, dann notfalls gleichmäßig ausdünnen.

    Ein CAD-Grundriss trägt gern tausend Zwischenpunkte auf geraden Wänden;
    davon lebt weder die Zeichnung noch die Fläche. Gespart wird nur, was
    keine Form ändert — die Ecken bleiben.
    """
    if len(pts) < 3:
        return pts
    out: list[list[float]] = [pts[0]]
    for i in range(1, len(pts) - 1):
        a, b, c = out[-1], pts[i], pts[i + 1]
        v1 = (b[0] - a[0], b[1] - a[1])
        v2 = (c[0] - b[0], c[1] - b[1])
        n1 = math.hypot(*v1) or 1e-9
        n2 = math.hypot(*v2) or 1e-9
        cos = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
        if abs(math.degrees(math.acos(cos))) > 0.5:
            out.append(b)
    out.append(pts[-1])
    while len(out) > keep:
        step = math.ceil(len(out) / keep)
        out = out[::step]
    return out


@router.post("/floor/outline/from-dxf")
async def outline_from_dxf(
    file: Annotated[UploadFile, File()],
    db: Annotated[Session, Depends(get_db)],
    admin: Annotated[User, Depends(require_admin)],
    unit: float = Query(
        default=0, ge=0, description="Dateieinheiten je Meter (0 = automatisch raten)"
    ),
    target_w_m: float = Query(
        default=0, ge=0, description="Soll-Breite in Metern; kalibriert die Skala"
    ),
) -> dict:
    """Hallenumriss aus einer DXF-Zeichnung — als Entwurf, nicht als Wahrheit.

    Gelesen wird dieselbe Dateiklasse wie beim Teile-Import; es gewinnt die
    größte geschlossene Kontur. Die Einheit wird geraten oder über
    ``target_w_m`` (echte Breite) bzw. ``unit`` (Einheiten je Meter)
    festgelegt — und die Wahl wird zurückgemeldet. Die Punkte kommen als
    *Entwurf* zurück — ziehen, prüfen, übernehmen bleibt Handarbeit.
    """
    raw = await file.read(8_000_001)
    if len(raw) > 8_000_000:
        raise HTTPException(status_code=413, detail="Die Datei ist größer als 8 MB.")
    text = raw.decode("utf-8-sig", errors="replace")
    parsed = parse_dxf(text)
    if parsed.get("error"):
        raise HTTPException(status_code=422, detail=parsed["error"])

    outer = (parsed.get("shape") or {}).get("outer") or {}
    kind = outer.get("kind")
    if kind == "rect":
        pts = [
            [0.0, 0.0],
            [outer["w"], 0.0],
            [outer["w"], outer["h"]],
            [0.0, outer["h"]],
        ]
    elif kind == "circle":
        r = outer["d"] / 2.0
        pts = [
            [r + r * math.cos(a), r + r * math.sin(a)]
            for a in [i * math.pi / 12 for i in range(24)]
        ]
    elif kind == "poly":
        pts = [[float(p[0]), float(p[1])] for p in (outer.get("pts") or [])]
    else:
        raise HTTPException(
            status_code=422, detail="Keine geschlossene Kontur in der Datei."
        )
    if len(pts) < 3:
        raise HTTPException(
            status_code=422, detail="Die größte Kontur hat weniger als drei Punkte."
        )

    # Der Teile-Import normalisiert auf Millimeter ($INSUNITS); ohne Header
    # stehen rohe Dateieinheiten da. In beiden Fällen rechnen wir über einen
    # Faktor Dateiwert → Meter, der geraten oder kalibriert wird — und der
    # wird zurückgemeldet, nicht verschwiegen.
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    width = max(xs) - min(xs)
    if target_w_m > 0 and width > 0:
        factor = target_w_m / width
        unit_note = f"Skala kalibriert auf {target_w_m:g} m Breite."
    elif unit > 0:
        factor = 1.0 / (unit * parsed["unit_scale_mm"])
        unit_note = f"Einheit vorgegeben: {unit:g} Dateieinheiten je Meter."
    elif parsed["unit_code"] != 0:
        factor, unit_note = 0.001, "DXF-Einheit aus dem Header gelesen."
    else:
        factor, unit_note = 1 / 1000.0, ""
        for label, cand in (
            ("Millimeter", 1 / 1000.0),
            ("Zentimeter", 1 / 100.0),
            ("Meter", 1.0),
            ("Zoll", 0.0254),
        ):
            if 2.0 <= span * cand <= 500.0:
                factor, unit_note = cand, f"Einheit als {label} gelesen."
                break
        if not unit_note:
            factor, unit_note = (
                1 / 1000.0,
                "Einheit unbekannt — als Millimeter gelesen.",
            )

    pts_m = [[round(p[0] * factor, 3), round(p[1] * factor, 3)] for p in pts]
    # DXF zählt nach oben, der Plan nach unten — dieselbe Spiegelung wie in
    # dxf.js. Danach auf (0|0) setzen, damit die Punkte ins Raster passen.
    pts_m = [[p[0], -p[1]] for p in pts_m]
    min_x, min_y = min(p[0] for p in pts_m), min(p[1] for p in pts_m)
    pts_m = [[round(p[0] - min_x, 3), round(p[1] - min_y, 3)] for p in pts_m]
    pts_m = _simplify_points(pts_m)

    area = polygon_area([(p[0], p[1]) for p in pts_m])
    note = unit_note
    if area < 10 or area > 100_000:
        note += (
            f" Achtung: die Fläche wäre {area:,.0f} m² — ungewöhnlich für "
            "eine Halle; Breite kalibrieren oder Einheit prüfen."
        ).replace(",", ".")
    return {
        "points": pts_m,
        "bbox": {
            "w": round(max(p[0] for p in pts_m), 2),
            "h": round(max(p[1] for p in pts_m), 2),
        },
        "area_m2": round(area, 1),
        "unit": unit_note,
        "loops": int(parsed.get("count") or 0),
        "skipped": int(parsed.get("skipped") or 0),
        "note": note,
    }


# ==========================================================================
# Arbeitsvorrat — die Abarbeitungsliste jeder Station
# ==========================================================================
# Bis hierher hatte nur die Fertigung eine Warteschlange, und die war eine
# Sortierung nach Anlagedatum. Diese Endpunkte geben jedem Arbeitsplatz —
# Regal, Maschine, Packtisch, Schreibtisch — dieselbe Sache: eine Liste mit
# Reihenfolge, Priorität und Begründung, und dieselben Knöpfe, sie zu ändern.
# Was sie *nicht* tun, ist selbst entscheiden: geplant wird auf Abruf,
# angewendet auf ausdrückliches Drücken oder auf das Opt-in der Station.
def _task_or_404(db: Session, task_id: int) -> StationTask:
    row = db.get(StationTask, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Aufgabe nicht gefunden.")
    return row


@router.get("/worklist")
def get_worklist(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    kind: str = Query(default=""),
) -> dict:
    """Der ganze Arbeitsvorrat: Stationen mit Reihenfolge, plus der freie Vorrat.

    ``kind`` grenzt auf eine Arbeitsart ein (``pick`` · ``cut`` · ``pack`` ·
    ``process``) und damit zugleich auf den Stationstyp, der sie macht.
    """
    if kind and kind not in wl.KIND_STATION_TYPE:
        raise HTTPException(status_code=400, detail=f"Unbekannte Arbeitsart: {kind}")
    # Halle: Kunden nur an Packaufgaben (Versand), sonst Bestellzeichen/Auftragsnummer.
    return floor_view.floor_tasks(wl.board(db, kind=kind), floor_view.is_office(user))


@router.post("/worklist/reconcile")
def run_worklist_reconcile(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    """Abgleich ausdrücklich anstoßen — Anlegen, Auffrischen, Schließen.

    Der Taktgeber macht das alle dreißig Sekunden von selbst; dieser Endpunkt
    ist für den Moment dazwischen („jetzt gleich, ich lege gerade los") und
    für die Prüfung, was ein Abgleich getan hat. Die Antwort zählt — eine
    Naht, die still arbeitet, lässt sich nicht prüfen.
    """
    counts = wl.reconcile(db, who=user.email)
    wl.resequence(db)
    if any(counts.values()):
        _audit(db, user, "worklist_reconcile", "station_task", "worklist", **counts)
    return counts


@router.get("/stations/{sid}/worklist")
def get_station_worklist(
    sid: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Die Abarbeitungsliste **einer** Station — was hier der Reihe nach dran ist."""
    station = db.get(FactoryStation, sid)
    if not station:
        raise HTTPException(status_code=404, detail="Station nicht gefunden.")
    sched = wl.schedule_for(db, sid)
    rows = {(r.kind, r.ref): r for r in wl.open_rows(db, station_id=sid)}
    out = sched.to_dict() if sched else {"slots": [], "times_known": False}
    for slot in out.get("slots", []):
        row = rows.get((slot["kind"], slot["ref"]))
        if row is not None:
            slot["task_id"] = row.id
            slot["state"] = row.state
            slot["pinned"] = bool(row.seq_pinned)
            slot["assign_mode"] = row.assign_mode or ""
            slot["assign_reason"] = row.assign_reason or ""
            slot["to_station_id"] = row.to_station_id
            slot["note"] = row.note or ""
    out["capacity_min_per_day"] = float(station.capacity_min_per_day or 0.0)
    out["days"] = (
        round(out.get("total_min", 0.0) / float(station.capacity_min_per_day), 2)
        if station.capacity_min_per_day
        else None
    )
    return floor_view.floor_tasks(out, floor_view.is_office(user))


@router.get("/worklist/plan")
def get_worklist_plan(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
    kind: str = Query(default=""),
) -> dict:
    """Was die Verteilung täte — ohne es zu tun.

    Dieselbe Trennung wie beim Maschinenplaner: der Vorschlag ist lesbar,
    bevor er wirkt. ``auto`` heißt „diese Station hat sich dafür angemeldet",
    ``suggest`` heißt „hier drückt ein Mensch", ``none`` heißt „keine Station"
    — und daneben steht, warum.
    """
    wl.reconcile(db)
    kinds = [kind] if kind else []
    pls = wl.plan(db, kinds=kinds)
    return {
        "auto_routing": wl.worklist_auto_enabled(db),
        "placements": [p.to_dict() for p in pls],
        "counts": {
            "auto": sum(1 for p in pls if p.mode == "auto"),
            "suggest": sum(1 for p in pls if p.mode == "suggest"),
            "none": sum(1 for p in pls if p.mode == "none"),
        },
    }


class WorklistApplyIn(BaseModel):
    #: Leer = alles anwenden, was das Opt-in erlaubt.
    refs: list[str] = Field(default_factory=list)  # "kind:ref"
    #: True übernimmt auch Vorschläge, die nur „vorschlagen" dürfen — das ist
    #: der Knopf, den ein Mensch drückt.
    include_suggested: bool = False
    kind: str = ""


@router.post("/worklist/apply")
def apply_worklist_plan(
    body: WorklistApplyIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    if not body.include_suggested and not wl.worklist_auto_enabled(db):
        raise HTTPException(
            status_code=409,
            detail="Automatische Zuordnung ist ausgeschaltet. "
            "Einzelne Vorschläge lassen sich trotzdem übernehmen.",
        )
    wl.reconcile(db)
    pls = wl.plan(db, kinds=[body.kind] if body.kind else [])
    refs: list[tuple[str, str]] = []
    for raw in body.refs:
        kind, _, ref = raw.partition(":")
        if kind and ref:
            refs.append((kind, ref))
    applied = wl.apply_plan(
        db,
        pls,
        who=user.email,
        only_auto=not body.include_suggested,
        refs=refs,
    )
    if applied:
        _audit(db, user, "worklist_apply", "station_task", "worklist", applied=len(applied))
    return {"applied": applied, "count": len(applied)}


class TaskAssignIn(BaseModel):
    station_id: Optional[int] = None
    note: str = ""


@router.post("/tasks/{task_id}/assign")
def assign_task(
    task_id: int,
    body: TaskAssignIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    """Eine Aufgabe von Hand an eine Station geben (oder wieder freigeben).

    Die Überstimmung steht als Begründung an der Aufgabe; sie fließt nicht in
    die Regel zurück. Diese Zuordnung lernt nicht (CLAUDE.md §5.5).
    """
    row = _task_or_404(db, task_id)
    before = row.station_id
    try:
        wl.assign(
            db,
            row,
            body.station_id,
            mode="manual",
            who=user.email,
            reason=body.note or ("von Hand zugeordnet" if body.station_id else ""),
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    if row.station_id:
        wl.resequence(db, row.station_id)
    if before != row.station_id:
        _audit(db, user, "task_assign", "station_task", row.id, ref=f"{row.kind}:{row.ref}",
               before=before, station_id=row.station_id, note=body.note)
    return {
        "task_id": row.id,
        "kind": row.kind,
        "ref": row.ref,
        "station_id": row.station_id,
        "seq": row.seq,
    }


class TaskStateIn(BaseModel):
    state: str
    note: str = ""


@router.post("/tasks/{task_id}/state")
def set_task_state(
    task_id: int,
    body: TaskStateIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Anfangen, fertig melden oder zurücknehmen.

    Die Fertigmeldung ist keine Statusspalte, sondern eine Tatsache: eine
    fertige ``pick``-Aufgabe *ist* die gebuchte Bereitstellung am
    Innenauftrag, eine laufende ``cut``-Aufgabe *ist* der laufende
    Innenauftrag. Deshalb schreibt sie durch.
    """
    row = _task_or_404(db, task_id)
    before = row.state
    try:
        wl.set_state(db, row, body.state, who=user.email, note=body.note)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if before != row.state:
        _audit(db, user, "task_state", "station_task", row.id, ref=f"{row.kind}:{row.ref}",
               before=before, state=row.state, note=body.note)
    return {"task_id": row.id, "state": row.state, "ref": row.ref, "kind": row.kind}


class ReorderIn(BaseModel):
    #: Reihenfolge als „kind:ref"-Liste, Platz 1 zuerst.
    keys: list[str] = Field(default_factory=list)


@router.post("/stations/{sid}/worklist/order")
def reorder_worklist(
    sid: int,
    body: ReorderIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    """Die Reihenfolge von Hand setzen — und festzurren.

    Was ein Mensch verschoben hat, rechnet der nächste Lauf nicht wieder weg.
    ``DELETE`` auf denselben Pfad gibt sie wieder frei.
    """
    keys: list[tuple[str, str]] = []
    for raw in body.keys:
        kind, _, ref = raw.partition(":")
        if kind and ref:
            keys.append((kind, ref))
    n = wl.reorder(db, sid, keys, who=user.email)
    if n:
        _audit(db, user, "worklist_reorder", "factory_station", sid, pinned=n)
    return {"station_id": sid, "pinned": n}


@router.delete("/stations/{sid}/worklist/order")
def free_worklist_order(
    sid: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    """Die Handreihenfolge lösen — es gilt wieder die gerechnete Ordnung."""
    freed = wl.unpin(db, sid)
    if freed:
        _audit(db, user, "worklist_unpin", "factory_station", sid, freed=freed)
    return {"station_id": sid, "freed": freed}


@router.get("/picking")
def picking_board(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Die Kommissionierung — was aus welchem Regal an welche Maschine muss.

    Das ist die Lagersicht auf denselben Arbeitsvorrat: je Lagerstation die
    Aufgaben in ihrer Reihenfolge, dazu die Zusammenfassung nach Werkstoff und
    Dicke — denn genau so wird aus dem Regal geholt, nicht nach
    Innenauftragsnummer. Erledigt heißt hier: die Platten stehen an der
    Maschine, und das ist dieselbe Tatsache wie der Haken in „Bereitstellen".
    """
    data = wl.board(db, kind="pick")
    # Rüstliste: nach Werkstoff und Dicke zusammengefasst, über alle offenen
    # Kommissionieraufgaben. Der Weg durch das Regal ist einer, nicht zwanzig.
    by_mat: dict[tuple[str, float], dict] = {}
    for st in data["stations"]:
        for slot in st["schedule"]["slots"]:
            key = (slot["mat"], float(slot["thk"] or 0.0))
            e = by_mat.setdefault(
                key,
                {
                    "mat": slot["mat"],
                    "mat_name": slot["mat_name"] or slot["mat"],
                    "thk": float(slot["thk"] or 0.0),
                    "plates": 0,
                    "jobs": [],
                    "stations": set(),
                },
            )
            e["plates"] += int(slot["units"] or 0)
            e["jobs"].append(slot["ref"])
            e["stations"].add(st["label"])
    for row in data["pool"]:
        key = (row["mat"], float(row["thk"] or 0.0))
        e = by_mat.setdefault(
            key,
            {
                "mat": row["mat"],
                "mat_name": row["mat_name"] or row["mat"],
                "thk": float(row["thk"] or 0.0),
                "plates": 0,
                "jobs": [],
                "stations": set(),
            },
        )
        e["plates"] += int(row["units"] or 0)
        e["jobs"].append(row["ref"])
    # Bereitgestellt heißt nicht verschwunden. Mit dem Haken endet der
    # Kommissionieraufgabe — aber der Innenauftrag ist weiter Bedarf, nur
    # kein Weg mehr durchs Regal. Fiele seine Zeile hier weg, verschwände
    # Werkstoff und Bestand komplett aus der Sicht, sobald jemand
    # bereitstellt: genau der Fehler, der gemeldet wurde. Also bleiben
    # bereitgestellte, noch nicht geschnittene Innenaufträge in der Tabelle
    # — ausgezeichnet, damit „herauszusuchen" und „steht an der Maschine"
    # nicht in einer Zahl verschwimmen.
    staged_wos = (
        db.query(WorkOrder)
        .filter(WorkOrder.material_staged_at.isnot(None))
        .filter(WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.running]))
        .all()
    )
    for wo in staged_wos:
        key = (wo.mat, float(wo.thk or 0.0))
        e = by_mat.setdefault(
            key,
            {
                "mat": wo.mat,
                "mat_name": wo.mat_name or wo.mat,
                "thk": float(wo.thk or 0.0),
                "plates": 0,
                "jobs": [],
                "stations": set(),
            },
        )
        e["plates_staged"] = e.get("plates_staged", 0) + int(wo.n_plates or 0)
        e.setdefault("staged_jobs", []).append(wo.no)

    # Frisch bereitgestellt — noch zehn Minuten sichtbar, dann weg. Der Haken
    # lässt die Aufgabe aus der offenen Queue fallen (das ist richtig: sie ist
    # keine Arbeit mehr), aber im Moment des Abhakens wäre sie *lautlos*
    # verschwunden, und niemand könnte sehen, was er gerade getan hat — oder
    # sich vertan hat. Also: die Aufgaben der letzten zehn Minuten bleiben
    # als eigene Liste stehen, mit Restlaufzeit für die Oberfläche.
    now = datetime.now(timezone.utc)
    recent_rows = (
        db.query(StationTask)
        .filter(StationTask.kind == "pick")
        .filter(StationTask.state == "done")
        .filter(StationTask.done_at.isnot(None))
        .order_by(StationTask.done_at.desc())
        .limit(50)
        .all()
    )
    station_label_by_id = {s["id"]: s["label"] for s in data["stations"]}
    recent: list[dict] = []
    for r in recent_rows:
        d = r.done_at if r.done_at.tzinfo else r.done_at.replace(tzinfo=timezone.utc)
        age_min = (now - d).total_seconds() / 60.0
        if age_min > 10.0:
            break  # absteigend sortiert — der Rest ist älter
        recent.append(
            {
                "task_id": r.id,
                "ref": r.ref,
                "label": r.label or "",
                "mat": r.mat or "",
                "mat_name": r.mat_name or r.mat,
                "thk": float(r.thk or 0.0),
                "units": int(r.units or 0),
                "station_id": r.station_id,
                "station_label": station_label_by_id.get(r.station_id, ""),
                "done_at": d.isoformat(),
                "done_by": r.done_by or "",
                "minutes_left": round(max(0.0, 10.0 - age_min), 1),
            }
        )
    data["recent"] = recent

    # Bestand daneben: was im Regal liegt, gegen das, was heraus soll. Eine
    # Kommissionierliste ohne Bestand ist eine Wunschliste.
    stock = {
        p.id: {"name": p.name, "stock": int(p.stock or 0), "lead_days": int(getattr(p, "lead_days", 0) or 0)}
        for p in db.query(Product).all()
    }
    materials = []
    locs = stockloc.for_materials(db, {k[0] for k in by_mat})
    # Reststücke je offenem Kommissionierauftrag: sie kommen nicht aus dem
    # Plattenbestand und dürfen ihn nicht knapp rechnen.
    job_nos = {j for e in by_mat.values() for j in e["jobs"]}
    off_rows = (
        db.query(WorkOrder.no, Offcut)
        .join(WorkPlate, WorkPlate.work_order_id == WorkOrder.id)
        .join(Offcut, Offcut.id == WorkPlate.offcut_id)
        .filter(WorkOrder.no.in_(job_nos)).all()
    ) if job_nos else []
    where_all = stockloc._where(db) if off_rows else {}
    off_by_no: dict[str, list[dict]] = {}
    for no, off in off_rows:
        off_by_no.setdefault(no, []).append(offcut_svc.row_out(off, where_all))
    for e in sorted(by_mat.values(), key=lambda x: (-(x["plates"] + x.get("plates_staged", 0)), x["mat"])):
        e_off = [o for j in e["jobs"] for o in off_by_no.get(j, [])]
        e["offcuts"] = e_off
        e["plates_full"] = max(0, e["plates"] - len(e_off))
        s = stock.get(e["mat"], {})
        info = stockloc.summarise(locs.get(e["mat"], []), s.get("stock", 0), e["thk"])
        materials.append(
            {
                **e,
                "locations": info["locations"],
                "located": info["located"],
                "stations": sorted(e["stations"]),
                "plates_staged": e.get("plates_staged", 0),
                "staged_jobs": e.get("staged_jobs", []),
                "stock": s.get("stock", 0),
                "lead_days": s.get("lead_days", 0),
                "short": s.get("stock", 0) < e["plates_full"],
            }
        )
    data["materials"] = materials
    pick = data["kinds"].get("pick", {})
    pick["plates_open"] = sum(m["plates"] for m in materials)
    pick["plates_staged"] = sum(m["plates_staged"] for m in materials)
    pick["materials_short"] = sum(1 for m in materials if m["short"])
    return data


# ==========================================================================
# Lagerorte — wo das Material liegt
# ==========================================================================
class StockLocationIn(BaseModel):
    mat: str = Field(min_length=1, max_length=60)
    thk: float = Field(0.0, ge=0, le=500)
    station_id: Optional[int] = None
    bin: str = Field("", max_length=80)
    qty: int = Field(0, ge=0, le=1_000_000)
    note: str = Field("", max_length=200)


def _check_location(db: Session, body: StockLocationIn) -> None:
    if db.get(Product, body.mat) is None:
        raise HTTPException(404, "Werkstoff unbekannt.")
    if body.station_id is not None:
        st = db.get(FactoryStation, body.station_id)
        if st is None:
            raise HTTPException(404, "Station unbekannt.")
        if not st.is_storage:
            raise HTTPException(422, f"{st.label} ist kein Lager.")


@router.get("/stock-locations")
def list_stock_locations(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    mat: Optional[str] = Query(default=None, max_length=60),
) -> dict:
    """Alle Lagerorte, optional für einen Werkstoff — plus die Lager zur Auswahl."""
    locs = stockloc.for_materials(db, {mat} if mat else None)
    storages = [
        {"id": s.id, "label": s.label}
        for s in db.query(FactoryStation).filter(FactoryStation.is_storage.is_(True))
        .order_by(FactoryStation.id.asc()).all()
    ]
    return {"locations": locs, "storages": storages}


@router.post("/stock-locations")
def create_stock_location(
    body: StockLocationIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    _check_location(db, body)
    row = StockLocation(product_id=body.mat, thk=body.thk, station_id=body.station_id,
                        bin=body.bin.strip(), qty=body.qty, note=body.note.strip(),
                        updated_by=user.email)
    db.add(row)
    db.flush()
    _audit(db, user, "stock_location_create", "stock_location", row.id, mat=body.mat,
           thk=body.thk, station_id=body.station_id, bin=row.bin, qty=body.qty)
    return stockloc.row_out(row, stockloc._where(db))


@router.put("/stock-locations/{loc_id}")
def update_stock_location(
    loc_id: int,
    body: StockLocationIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    row = db.get(StockLocation, loc_id)
    if row is None:
        raise HTTPException(404, "Lagerort unbekannt.")
    _check_location(db, body)
    before = {"thk": row.thk, "station_id": row.station_id, "bin": row.bin, "qty": row.qty}
    row.product_id, row.thk, row.station_id = body.mat, body.thk, body.station_id
    row.bin, row.qty, row.note = body.bin.strip(), body.qty, body.note.strip()
    row.updated_by = user.email
    _audit(db, user, "stock_location_update", "stock_location", row.id, mat=body.mat,
           before=before, qty=body.qty, bin=row.bin, station_id=body.station_id, thk=body.thk)
    return stockloc.row_out(row, stockloc._where(db))


@router.delete("/stock-locations/{loc_id}")
def delete_stock_location(
    loc_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    row = db.get(StockLocation, loc_id)
    if row is None:
        raise HTTPException(404, "Lagerort unbekannt.")
    detail = {"mat": row.product_id, "bin": row.bin, "qty": row.qty, "station_id": row.station_id}
    db.delete(row)
    _audit(db, user, "stock_location_delete", "stock_location", loc_id, **detail)
    return {"deleted": loc_id}


# ==========================================================================
# Standorte, Hallen, Ebenen (Aufgabe 32)
# ==========================================================================
class SiteIn(BaseModel):
    name: str = Field("Standort", min_length=1, max_length=120)
    code: str = Field("", max_length=20)
    address: str = Field("", max_length=300)
    lat: float = Field(0.0, ge=-90, le=90)
    lon: float = Field(0.0, ge=-180, le=180)
    note: str = Field("", max_length=2000)


class SiteOut(SiteIn):
    id: int


class HallIn(BaseModel):
    site_id: Optional[int] = None
    name: str = Field("Halle", min_length=1, max_length=120)
    code: str = Field("", max_length=20)
    sort: int = 0
    lat: float = Field(0.0, ge=-90, le=90)
    lon: float = Field(0.0, ge=-180, le=180)
    rotation_deg: float = Field(0.0, ge=-360, le=360)
    map_enabled: bool = False
    note: str = Field("", max_length=2000)


class HallOut(HallIn):
    id: int


class LevelIn(BaseModel):
    hall_id: int
    level: int = Field(0, ge=-5, le=50)
    level_name: str = Field("", max_length=60)
    elevation_m: Optional[float] = None
    height_m: float = Field(6.0, ge=1, le=60)
    #: Umriss einer anderen Ebene übernehmen — ein Obergeschoss hat meist
    #: denselben Grundriss wie das Erdgeschoss.
    copy_outline_from: Optional[int] = None


def _site_out(s: FactorySite) -> SiteOut:
    return SiteOut(id=s.id, name=s.name, code=s.code or "", address=s.address or "",
                   lat=float(s.lat or 0), lon=float(s.lon or 0), note=s.note or "")


def _hall_out(h: FactoryHall) -> HallOut:
    return HallOut(id=h.id, site_id=h.site_id, name=h.name, code=h.code or "",
                   sort=int(h.sort or 0), lat=float(h.lat or 0), lon=float(h.lon or 0),
                   rotation_deg=float(h.rotation_deg or 0), map_enabled=bool(h.map_enabled),
                   note=h.note or "")


def _level_name(level: int) -> str:
    if level == 0:
        return "EG"
    if level < 0:
        return f"{-level}. UG"
    return f"{level}. OG"


@router.get("/topology")
def topology(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
) -> dict:
    """Standorte → Hallen → Ebenen, mit Stationszahl — eine Anfrage für jeden Umschalter."""
    topo = site_svc.topology(db)
    counts: dict[Optional[int], int] = {}
    for st in db.query(FactoryStation).all():
        fid = site_svc.station_floor_id(st, topo.default_floor_id)
        counts[fid] = counts.get(fid, 0) + 1

    def floor_dict(f: FactoryFloor) -> dict:
        return {
            "id": f.id, "hall_id": f.hall_id, "level": int(f.level or 0),
            "level_name": f.level_name or _level_name(int(f.level or 0)),
            "elevation_m": float(f.elevation_m or 0), "height_m": float(f.height_m or 6),
            "name": f.name or "", "stations": counts.get(f.id, 0),
            "default": f.id == topo.default_floor_id,
        }

    halls_by_site: dict[Optional[int], list[dict]] = {}
    for h in sorted(topo.halls.values(), key=lambda h: (h.sort or 0, h.id)):
        floors = sorted(
            (f for f in topo.floors.values() if f.hall_id == h.id),
            key=lambda f: (int(f.level or 0), f.id),
        )
        halls_by_site.setdefault(h.site_id, []).append(
            {**_hall_out(h).model_dump(), "floors": [floor_dict(f) for f in floors]}
        )
    sites = [
        {**_site_out(s).model_dump(), "halls": halls_by_site.get(s.id, [])}
        for s in topo.sites.values()
    ]
    loose_halls = halls_by_site.get(None, [])
    loose_floors = [floor_dict(f) for f in topo.floors.values() if f.hall_id is None]
    return {
        "sites": sites,
        "unsited_halls": loose_halls,
        "unassigned_floors": loose_floors,
        "default_floor_id": topo.default_floor_id,
        "default_site_id": site_svc.default_site_id(db),
    }


@router.post("/sites", response_model=SiteOut)
def create_site(body: SiteIn, db: Annotated[Session, Depends(get_db)],
                admin: Annotated[User, Depends(require_admin)]) -> SiteOut:
    s = FactorySite(**body.model_dump())
    db.add(s)
    db.flush()
    _audit(db, admin, "site_create", "factory_site", s.id, name=s.name)
    return _site_out(s)


@router.put("/sites/{site_id}", response_model=SiteOut)
def update_site(site_id: int, body: SiteIn, db: Annotated[Session, Depends(get_db)],
                admin: Annotated[User, Depends(require_admin)]) -> SiteOut:
    s = db.get(FactorySite, site_id)
    if s is None:
        raise HTTPException(status_code=404, detail="Standort nicht gefunden.")
    for k, v in body.model_dump().items():
        setattr(s, k, v)
    _audit(db, admin, "site_update", "factory_site", s.id, name=s.name)
    return _site_out(s)


@router.delete("/sites/{site_id}", status_code=204)
def delete_site(site_id: int, db: Annotated[Session, Depends(get_db)],
                admin: Annotated[User, Depends(require_admin)]) -> None:
    s = db.get(FactorySite, site_id)
    if s is None:
        raise HTTPException(status_code=404, detail="Standort nicht gefunden.")
    if db.query(FactoryHall).filter(FactoryHall.site_id == site_id).count():
        raise HTTPException(status_code=409, detail="Der Standort hat noch Hallen.")
    if db.query(FactorySite).count() <= 1:
        raise HTTPException(status_code=409, detail="Der letzte Standort bleibt.")
    _check_scope_unused(db, "site", site_id)
    db.delete(s)
    _audit(db, admin, "site_delete", "factory_site", site_id, name=s.name)


@router.post("/halls", response_model=HallOut)
def create_hall(body: HallIn, db: Annotated[Session, Depends(get_db)],
                admin: Annotated[User, Depends(require_admin)]) -> HallOut:
    if body.site_id is not None and db.get(FactorySite, body.site_id) is None:
        raise HTTPException(status_code=400, detail="Standort nicht gefunden.")
    h = FactoryHall(**body.model_dump())
    db.add(h)
    db.flush()
    # Jede Halle hat mindestens ein Erdgeschoss — sonst gäbe es nichts zu zeichnen.
    db.add(FactoryFloor(name=h.name, hall_id=h.id, level=0, level_name="EG"))
    db.flush()
    _audit(db, admin, "hall_create", "factory_hall", h.id, name=h.name, site_id=h.site_id)
    return _hall_out(h)


@router.put("/halls/{hall_id}", response_model=HallOut)
def update_hall(hall_id: int, body: HallIn, db: Annotated[Session, Depends(get_db)],
                admin: Annotated[User, Depends(require_admin)]) -> HallOut:
    h = db.get(FactoryHall, hall_id)
    if h is None:
        raise HTTPException(status_code=404, detail="Halle nicht gefunden.")
    if body.site_id is not None and db.get(FactorySite, body.site_id) is None:
        raise HTTPException(status_code=400, detail="Standort nicht gefunden.")
    changed = {k: v for k, v in body.model_dump().items() if getattr(h, k) != v}
    for k, v in changed.items():
        setattr(h, k, v)
    if changed:
        _audit(db, admin, "hall_update", "factory_hall", h.id, fields=sorted(changed))
    return _hall_out(h)


@router.delete("/halls/{hall_id}", status_code=204)
def delete_hall(hall_id: int, db: Annotated[Session, Depends(get_db)],
                admin: Annotated[User, Depends(require_admin)]) -> None:
    h = db.get(FactoryHall, hall_id)
    if h is None:
        raise HTTPException(status_code=404, detail="Halle nicht gefunden.")
    floors = db.query(FactoryFloor).filter(FactoryFloor.hall_id == hall_id).all()
    default = site_svc.default_floor(db)
    for f in floors:
        _check_floor_empty(db, f, default)
    _check_scope_unused(db, "hall", hall_id)
    for f in floors:
        db.delete(f)
    db.delete(h)
    _audit(db, admin, "hall_delete", "factory_hall", hall_id, name=h.name)


@router.post("/floors", response_model=FloorOut)
def create_level(body: LevelIn, db: Annotated[Session, Depends(get_db)],
                 admin: Annotated[User, Depends(require_admin)]) -> FloorOut:
    h = db.get(FactoryHall, body.hall_id)
    if h is None:
        raise HTTPException(status_code=400, detail="Halle nicht gefunden.")
    taken = db.query(FactoryFloor).filter(FactoryFloor.hall_id == h.id,
                                          FactoryFloor.level == body.level).first()
    if taken is not None:
        raise HTTPException(status_code=409, detail="Diese Ebene gibt es in der Halle schon.")
    below = (db.query(FactoryFloor).filter(FactoryFloor.hall_id == h.id)
             .order_by(FactoryFloor.level.desc()).first())
    f = FactoryFloor(
        name=h.name, hall_id=h.id, level=body.level,
        level_name=body.level_name or _level_name(body.level),
        elevation_m=(body.elevation_m if body.elevation_m is not None
                     else body.level * (float(below.height_m or 6) if below else 6.0)),
        height_m=body.height_m,
    )
    if body.copy_outline_from:
        src = db.get(FactoryFloor, body.copy_outline_from)
        if src is None:
            raise HTTPException(status_code=400, detail="Vorlage nicht gefunden.")
        f.outline = [list(p) for p in (src.outline or [])]
        f.scale, f.grid, f.snap, f.bg = src.scale, src.grid, src.snap, src.bg
    db.add(f)
    db.flush()
    _audit(db, admin, "floor_create", "factory_floor", f.id, hall_id=h.id, level=f.level)
    db.refresh(f)
    return _floor_out(f, db)


@router.delete("/floors/{floor_id}", status_code=204)
def delete_level(floor_id: int, db: Annotated[Session, Depends(get_db)],
                 admin: Annotated[User, Depends(require_admin)]) -> None:
    f = db.get(FactoryFloor, floor_id)
    if f is None:
        raise HTTPException(status_code=404, detail="Ebene nicht gefunden.")
    _check_floor_empty(db, f, site_svc.default_floor(db))
    _check_scope_unused(db, "floor", floor_id)
    db.delete(f)
    _audit(db, admin, "floor_delete", "factory_floor", floor_id, hall_id=f.hall_id, level=f.level)


def _check_floor_empty(db: Session, f: FactoryFloor, default: Optional[FactoryFloor]) -> None:
    if default is not None and f.id == default.id:
        raise HTTPException(status_code=409, detail="Die erste Ebene bleibt — dort stehen alle Stationen ohne Ebene.")
    if db.query(FactoryStation).filter(FactoryStation.floor_id == f.id).count():
        raise HTTPException(status_code=409, detail="Auf der Ebene stehen noch Stationen.")


def _check_scope_unused(db: Session, kind: str, ident: int) -> None:
    """Nichts löschen, an das ein offener Auftrag gebunden ist."""
    for raw, ref in (
        *((w.route_scope, w.no) for w in db.query(WorkOrder)
          .filter(WorkOrder.status.in_(fr.OPEN_STATUSES), WorkOrder.route_scope != "").all()),
        # Ein Auftrag bindet, solange noch Positionen auf den Sammellauf warten.
        *((o.route_scope, o.no) for o in db.query(Order).filter(Order.route_scope != "")
          .join(OrderPosition, OrderPosition.order_id == Order.id)
          .filter(OrderPosition.production_status == "pending")
          .filter(Order.cancelled_at.is_(None)).distinct().all()),
    ):
        try:
            sc = site_svc.parse(raw)
        except site_svc.ScopeError:
            continue
        if sc.kind == kind and ident in sc.ids:
            raise HTTPException(status_code=409, detail=f"{ref} ist daran gebunden.")


# --------------------------------------------------------------------------
# Fertigungsort-Vorgabe
# --------------------------------------------------------------------------
class ScopeIn(BaseModel):
    route_scope: str = Field("", max_length=200)
    #: Nur Aufträge: Eingangsstandort. Leer lässt ihn, wie er ist.
    site_id: Optional[int] = None


def _scope_view(db: Session, raw: str, site_id: Optional[int] = None) -> dict:
    topo = site_svc.topology(db)
    try:
        sc = site_svc.parse(raw)
    except site_svc.ScopeError:
        return {"route_scope": raw, "label": f"ungültig: {raw}", "floors": []}
    fl = site_svc.allowed_floors(sc, topo)
    if sc.kind == "received" and (site_id or site_svc.default_site_id(db)):
        sid = site_id or site_svc.default_site_id(db)
        fl = site_svc.allowed_floors(site_svc.Scope("site", (sid,)), topo)
    return {"route_scope": str(sc), "label": site_svc.label(sc, topo),
            "floors": sorted(fl) if fl is not None else None}


@router.get("/orders/{order_no}/scope")
def get_order_scope(order_no: str, db: Annotated[Session, Depends(get_db)],
                    user: Annotated[User, Depends(require_staff)]) -> dict:
    o = db.query(Order).filter(Order.no == order_no).first()
    if o is None:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    return {**_scope_view(db, o.route_scope or "", o.site_id),
            "site_id": o.site_id, "default_site_id": site_svc.default_site_id(db)}


@router.put("/orders/{order_no}/scope")
def set_order_scope(order_no: str, body: ScopeIn, db: Annotated[Session, Depends(get_db)],
                    user: Annotated[User, Depends(require_staff)]) -> dict:
    """Wo ein Auftrag gefertigt werden darf. Gilt ab dem nächsten Sammellauf;
    schon geschachtelte Innenaufträge behalten ihre eigene Vorgabe."""
    o = db.query(Order).filter(Order.no == order_no).first()
    if o is None:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden.")
    if o.cancelled_at is not None:
        raise HTTPException(status_code=409, detail="Stornierter Auftrag kann nicht mehr umgeplant werden.")
    try:
        raw = site_svc.validate(db, body.route_scope)
    except site_svc.ScopeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.site_id is not None and db.get(FactorySite, body.site_id) is None:
        raise HTTPException(status_code=400, detail="Standort nicht gefunden.")
    before = (o.route_scope or "", o.site_id)
    o.route_scope = raw
    if body.site_id is not None:
        o.site_id = body.site_id
    if before != (o.route_scope, o.site_id):
        _audit(db, user, "order_scope", "order", o.no, route_scope=raw, site_id=o.site_id,
               before=before[0])
    return get_order_scope(order_no, db, user)


@router.put("/work-orders/{no}/scope")
def set_work_order_scope(no: str, body: ScopeIn, db: Annotated[Session, Depends(get_db)],
                         user: Annotated[User, Depends(require_staff)]) -> dict:
    """Vorgabe eines Innenauftrags ändern. Steht er an einer Station außerhalb,
    wird die Zuordnung gelöst — angefangene Arbeit wird nicht verschoben."""
    wo = db.query(WorkOrder).filter(WorkOrder.no == no).first()
    if wo is None:
        raise HTTPException(status_code=404, detail="Innenauftrag nicht gefunden.")
    if wo.status != WorkOrderStatus.open:
        raise HTTPException(status_code=409, detail="Nur offene Innenaufträge.")
    try:
        raw = site_svc.validate(db, body.route_scope)
    except site_svc.ScopeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if raw == "received":
        raise HTTPException(status_code=400, detail="Ein Innenauftrag bündelt Aufträge — Standort, Halle oder Ebene wählen.")
    released = False
    if raw != (wo.route_scope or ""):
        wo.route_scope = raw
        db.flush()
        if wo.station_id is not None:
            allowed, _ = fr.scope_of(db, raw)
            spec = next((s for s in fr.station_specs(db) if s.id == wo.station_id), None)
            if allowed is not None and spec is not None and spec.floor_id not in allowed:
                fr.assign(db, wo, None, mode="", who=user.email)
                task = db.query(StationTask).filter(StationTask.kind == "cut",
                                                    StationTask.ref == wo.no).first()
                if task is not None and task.state in ("ready", "waiting"):
                    task.station_id = None
                released = True
        _audit(db, user, "work_order_scope", "work_order", wo.no, route_scope=raw,
               released=released)
    return {**_scope_view(db, raw), "released": released}


# ---------------------------------------------------------------------------
# Twin Studio: gespeicherte Ansichten (Kamera-Lesezeichen je Ebene)
# ---------------------------------------------------------------------------

MAX_VIEWS_PER_FLOOR = 50
VIEW_LIMIT_M = 10_000.0


class TwinCamera(BaseModel):
    position: list[float] = Field(min_length=3, max_length=3)
    target: list[float] = Field(min_length=3, max_length=3)
    mode: str = Field("orbit", pattern="^(orbit|walk)$")
    view: str = Field("three", pattern="^(three|iso|2d)$")


class TwinViewIn(BaseModel):
    floor_id: Optional[int] = None
    name: str = Field(min_length=1, max_length=80)
    camera: TwinCamera


class TwinViewOut(BaseModel):
    id: int
    floor_id: Optional[int]
    name: str
    camera: dict
    created_by: str
    created_at: datetime


def _view_out(v: TwinView) -> TwinViewOut:
    return TwinViewOut(id=v.id, floor_id=v.floor_id, name=v.name, camera=v.camera or {},
                       created_by=v.created_by or "", created_at=v.created_at)


@router.get("/views", response_model=list[TwinViewOut])
def list_views(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_worker)],
    floor_id: Optional[int] = Query(None),
) -> list[TwinViewOut]:
    """Gespeicherte Ansichten einer Ebene (ohne ``floor_id``: der ersten)."""
    row = _floor_row(db, floor_id)
    if row is None:
        return []
    rows = (db.query(TwinView).filter(TwinView.floor_id == row.id)
            .order_by(TwinView.name, TwinView.id).all())
    return [_view_out(v) for v in rows]


@router.post("/views", response_model=TwinViewOut, status_code=201)
def create_view(
    body: TwinViewIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> TwinViewOut:
    row = _floor_row(db, body.floor_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Ebene nicht gefunden.")
    cam = body.camera
    for v in (*cam.position, *cam.target):
        if not math.isfinite(v) or abs(v) > VIEW_LIMIT_M:
            raise HTTPException(status_code=422, detail="Kamera außerhalb des Bereichs.")
    if db.query(TwinView).filter(TwinView.floor_id == row.id).count() >= MAX_VIEWS_PER_FLOOR:
        raise HTTPException(status_code=409,
                            detail=f"Höchstens {MAX_VIEWS_PER_FLOOR} Ansichten je Ebene.")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name fehlt.")
    view = TwinView(floor_id=row.id, name=name, camera=cam.model_dump(), created_by=user.email,
                    created_by_id=user.id)
    db.add(view)
    db.flush()
    _audit(db, user, "twin_view_create", "twin_view", view.id, floor_id=row.id, name=name)
    db.refresh(view)
    return _view_out(view)


@router.delete("/views/{view_id}", status_code=204)
def delete_view(
    view_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> None:
    """Eigene Ansicht löschen; fremde nur mit Admin-Recht."""
    view = db.get(TwinView, view_id)
    if view is None:
        raise HTTPException(status_code=404, detail="Ansicht nicht gefunden.")
    own = view.created_by_id == user.id if view.created_by_id is not None else view.created_by == user.email
    if not own and not has_admin_work(user):
        raise HTTPException(status_code=403, detail="Nur eigene Ansichten löschen.")
    floor_id, name = view.floor_id, view.name
    db.delete(view)
    _audit(db, user, "twin_view_delete", "twin_view", view_id, floor_id=floor_id, name=name)


# ---------------------------------------------------------------------------
# Twin Studio: Simulation geplanter Roboter (Flotten-Was-wäre-wenn)
# ---------------------------------------------------------------------------

MAX_SCENARIOS_PER_FLOOR = 30


class PlannedRobotIn(BaseModel):
    name: str = Field("Geplant", min_length=1, max_length=60)
    kind: str = Field("amr", pattern="^(agv|amr)$")
    speed_m_s: float = Field(1.0, ge=0.2, le=3.0)
    count: int = Field(1, ge=1, le=8)


class FleetSimParams(BaseModel):
    planned: list[PlannedRobotIn] = Field(default_factory=list, max_length=6)
    per_shift: int = Field(60, ge=1, le=600)
    load_factor: float = Field(1.0, ge=0.25, le=10.0)
    horizon_h: float = Field(8.0, ge=0.5, le=12.0)
    handling_s: float = Field(60.0, ge=0.0, le=900.0)
    include_existing: bool = False
    wait_target_min: float = Field(10.0, ge=1.0, le=240.0)
    seed: int = Field(1, ge=0, le=2**31 - 1)
    sizing: bool = True
    sizing_upto: int = Field(6, ge=1, le=8)


class FleetSimIn(BaseModel):
    floor_id: Optional[int] = None
    params: FleetSimParams


class FleetScenarioIn(BaseModel):
    floor_id: Optional[int] = None
    name: str = Field(min_length=1, max_length=80)
    params: FleetSimParams


def _scenario_out(sc: FleetScenario) -> dict:
    return {"id": sc.id, "floor_id": sc.floor_id, "name": sc.name, "params": sc.params or {},
            "created_by": sc.created_by or "", "created_at": sc.created_at,
            "updated_at": sc.updated_at}


@router.get("/fleet-sim/defaults")
def fleet_sim_defaults(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
    floor_id: Optional[int] = Query(None),
) -> dict:
    """Vorschlag für ein Szenario auf dieser Ebene — Bedarf je Schicht und Startpunkt."""
    from ..services import fleet_sim

    try:
        return fleet_sim.defaults(db, floor_id)
    except fleet_sim.SimError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/fleet-sim/run")
def fleet_sim_run(
    body: FleetSimIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    """Ein Szenario rechnen. Liest nur; geplante Roboter werden nie angelegt."""
    from ..services import fleet_sim

    total = sum(p.count for p in body.params.planned)
    if total > 12:
        raise HTTPException(status_code=422, detail="Höchstens 12 geplante Roboter je Szenario.")
    try:
        return fleet_sim.run(db, body.floor_id, body.params.model_dump())
    except fleet_sim.SimError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.get("/fleet-sim/scenarios")
def list_fleet_scenarios(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
    floor_id: Optional[int] = Query(None),
) -> list[dict]:
    row = _floor_row(db, floor_id)
    if row is None:
        return []
    rows = (db.query(FleetScenario).filter(FleetScenario.floor_id == row.id)
            .order_by(FleetScenario.name, FleetScenario.id).all())
    return [_scenario_out(sc) for sc in rows]


@router.post("/fleet-sim/scenarios", status_code=201)
def create_fleet_scenario(
    body: FleetScenarioIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> dict:
    row = _floor_row(db, body.floor_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Ebene nicht gefunden.")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name fehlt.")
    if sum(p.count for p in body.params.planned) > 12:
        raise HTTPException(status_code=422, detail="Höchstens 12 geplante Roboter je Szenario.")
    if db.query(FleetScenario).filter(FleetScenario.floor_id == row.id).count() >= MAX_SCENARIOS_PER_FLOOR:
        raise HTTPException(status_code=409,
                            detail=f"Höchstens {MAX_SCENARIOS_PER_FLOOR} Szenarien je Ebene.")
    sc = FleetScenario(floor_id=row.id, name=name, params=body.params.model_dump(),
                       created_by=user.email, created_by_id=user.id)
    db.add(sc)
    db.flush()
    _audit(db, user, "fleet_scenario_create", "fleet_scenario", sc.id, floor_id=row.id, name=name,
           planned=sum(p.count for p in body.params.planned))
    db.refresh(sc)
    return _scenario_out(sc)


@router.delete("/fleet-sim/scenarios/{scenario_id}", status_code=204)
def delete_fleet_scenario(
    scenario_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_staff)],
) -> None:
    sc = db.get(FleetScenario, scenario_id)
    if sc is None:
        raise HTTPException(status_code=404, detail="Szenario nicht gefunden.")
    own = sc.created_by_id == user.id if sc.created_by_id is not None else sc.created_by == user.email
    if not own and not has_admin_work(user):
        raise HTTPException(status_code=403, detail="Nur eigene Szenarien löschen.")
    floor_id, name = sc.floor_id, sc.name
    db.delete(sc)
    _audit(db, user, "fleet_scenario_delete", "fleet_scenario", scenario_id, floor_id=floor_id, name=name)
