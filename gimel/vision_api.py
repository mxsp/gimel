"""Teileerkennung: Standbild rein, erkannte Teile raus, Treffer zählen.

Nicht unter ``routers/``: dort stehen die Routen, die jede Anwendung bekommt, und
Alef prüft diese Fläche für die Rolle Werker. Diese hier kommen nur auf Wunsch dazu.
"""

from __future__ import annotations

from typing import Annotated, Optional

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from .core.vision import Calibration, CountZone, TableScale
from .db import get_db
from .models import Role, User
from .security import require_staff, require_worker
from .services import vision

router = APIRouter(prefix="/api/vision", tags=["vision"])

NOT_INSTALLED = ("Die Bilderkennung ist nicht installiert: "
                 "pip install opencv-python-headless (gimel[vision]).")


def _office(user: User) -> bool:
    return user.role in (Role.staff, Role.admin)


@router.get("/status", dependencies=[Depends(require_worker)])
def status(db: Annotated[Session, Depends(get_db)]) -> dict:
    return {"available": vision.available(),
            "calibration": vision.load_calibration(db).to_dict(),
            "zone": vision.load_zone(db).to_dict()}


class ZoneIn(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    points: list[list[float]] = Field(default_factory=list, max_length=8)
    width_px: int = Field(gt=0, le=20000)
    height_px: int = Field(gt=0, le=20000)
    enabled: bool = True
    auto_count: bool = True


@router.get("/zone", dependencies=[Depends(require_worker)])
def get_zone(db: Annotated[Session, Depends(get_db)]) -> dict:
    return vision.load_zone(db).to_dict()


@router.put("/zone")
def set_zone(body: ZoneIn, db: Annotated[Session, Depends(get_db)],
             actor: Annotated[User, Depends(require_staff)]) -> dict:
    """Den Zählbereich so speichern, wie er im Kamerabild aufgezogen wurde.

    Gespeichert wird das Rechteck in Tisch-Millimetern; nur damit stimmt es auch,
    wenn die Kamera schräg steht. Die Bildpunkte bleiben für das Overlay daneben.
    """
    zone = vision.load_zone(db)
    zone.enabled = body.enabled
    zone.auto_count = body.auto_count
    if not body.points:
        zone.points, zone.points_mm = [], []
        vision.save_zone(db, zone, actor.email)
        db.commit()
        return zone.to_dict()
    if len(body.points) < 3:
        raise HTTPException(status_code=400, detail="Ein Zählbereich braucht mindestens drei Ecken.")
    if any(len(p) != 2 or not (0 <= p[0] <= 1 and 0 <= p[1] <= 1) for p in body.points):
        raise HTTPException(status_code=400, detail="Die Ecken liegen nicht im Bild (0 bis 1).")
    cal = vision.load_calibration(db)
    px = np.asarray(body.points, dtype=np.float64) * [body.width_px, body.height_px]
    try:
        pts_mm = TableScale(cal, body.width_px, body.height_px).to_table(px)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    x, y = pts_mm[:, 0], pts_mm[:, 1]
    area = 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))
    if area < 400:
        raise HTTPException(status_code=400, detail="Der Zählbereich ist zu klein.")
    zone.points = [[round(float(v), 5) for v in p] for p in body.points]
    zone.points_mm = [[round(float(v), 1) for v in p] for p in pts_mm]
    vision.save_zone(db, zone, actor.email)
    db.commit()
    return zone.to_dict()


@router.delete("/zone")
def clear_zone(db: Annotated[Session, Depends(get_db)],
               actor: Annotated[User, Depends(require_staff)]) -> dict:
    zone = CountZone()
    zone.points, zone.points_mm, zone.enabled = [], [], False
    vision.save_zone(db, zone, actor.email)
    db.commit()
    return zone.to_dict()


@router.get("/expected")
def expected(db: Annotated[Session, Depends(get_db)],
             actor: Annotated[User, Depends(require_worker)],
             work_order: Optional[str] = Query(default=None, max_length=30)) -> list[dict]:
    return vision.public_expected(db, work_order, _office(actor))


TOO_BIG = "Das Bild ist größer als 8 MB."


@router.post("/identify")
async def identify(request: Request, db: Annotated[Session, Depends(get_db)],
                   actor: Annotated[User, Depends(require_worker)],
                   work_order: Optional[str] = Query(default=None, max_length=30),
                   preview: bool = Query(default=False)) -> dict:
    """Das Bild kommt als roher Körper, nicht als Formular: ein Formular würde Python
    in eine temporäre Datei schreiben, und das Bild soll den Speicher nie verlassen."""
    if not vision.available():
        raise HTTPException(status_code=503, detail=NOT_INSTALLED)
    if int(request.headers.get("content-length") or 0) > vision.MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail=TOO_BIG)
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > vision.MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail=TOO_BIG)
    try:
        return await run_in_threadpool(vision.identify, db, bytes(data), work_order or None,
                                       _office(actor), actor.email, preview)
    except vision.Busy:
        raise HTTPException(status_code=429, detail="Es läuft schon eine Erkennung.")
    except vision.VisionError as e:
        raise HTTPException(status_code=415, detail=str(e))
    except ValueError as e:  # Kamera zu stark geneigt
        raise HTTPException(status_code=422, detail=str(e))


class ConfirmIn(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    work_order: str = Field(max_length=30)
    position_id: int
    confidence: float = Field(default=0.0, ge=0, le=1)
    x_mm: float = 0.0
    y_mm: float = 0.0
    angle_deg: float = 0.0


@router.post("/confirm")
def confirm(body: ConfirmIn, db: Annotated[Session, Depends(get_db)],
            actor: Annotated[User, Depends(require_worker)]) -> dict:
    try:
        return vision.confirm(db, body.work_order, body.position_id, actor.email,
                              body.confidence, body.x_mm, body.y_mm, body.angle_deg)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except vision.VisionError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.delete("/confirm/{confirmation_id}")
def undo(confirmation_id: int, db: Annotated[Session, Depends(get_db)],
         actor: Annotated[User, Depends(require_worker)]) -> dict:
    """Eine Zählung zurücknehmen. Die Halle nur die eigene und nur kurz danach."""
    try:
        return vision.undo(db, confirmation_id, actor.email, _office(actor))
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except vision.VisionError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.get("/sample", dependencies=[Depends(require_worker)])
def sample(db: Annotated[Session, Depends(get_db)],
           work_order: Optional[str] = Query(default=None, max_length=30),
           count: int = Query(default=1, ge=1, le=vision.SAMPLE_MAX),
           seed: Optional[int] = Query(default=None, ge=0, le=2**31)) -> Response:
    """Testbild: offene Teile, gerechnet durch die eingemessene Kamera. Nichts wird gespeichert."""
    if not vision.available():
        raise HTTPException(status_code=503, detail=NOT_INSTALLED)
    try:
        data = vision.sample(db, work_order or None, count, seed)
    except vision.Busy:
        raise HTTPException(status_code=429, detail="Es läuft schon eine Erkennung.")
    except vision.VisionError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:  # Kamera zu stark geneigt
        raise HTTPException(status_code=422, detail=str(e))
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


class CalibrationIn(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    height_mm: float = Field(gt=0, le=10000)
    thickness_mm: float = Field(default=0.0, ge=0, le=1000)
    hfov_deg: float = Field(default=70.0, gt=5, lt=170)
    tolerance_mm: float = Field(default=3.0, gt=0, le=100)
    pitch_deg: float = Field(default=0.0, ge=-60, le=60)
    roll_deg: float = Field(default=0.0, ge=-60, le=60)
    origin_x_mm: float = 0.0
    origin_y_mm: float = 0.0
    yaw_deg: float = 0.0


@router.put("/calibration")
def set_calibration(body: CalibrationIn, db: Annotated[Session, Depends(get_db)],
                    actor: Annotated[User, Depends(require_staff)]) -> dict:
    old = vision.load_calibration(db)
    cal = Calibration.from_dict({**body.model_dump(), "points": old.points})
    vision.save_calibration(db, cal, actor.email)
    db.commit()
    return cal.to_dict()


class PointIn(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    distance_mm: float = Field(gt=0)
    known_mm: float = Field(gt=0)
    measured_px: float = Field(gt=0)


@router.post("/calibration/point")
def add_point(body: PointIn, db: Annotated[Session, Depends(get_db)],
              actor: Annotated[User, Depends(require_staff)]) -> dict:
    """Ein Maßstab: Gegenstand bekannter Länge, im Bild gemessen, in bekanntem Abstand."""
    cal = vision.load_calibration(db)
    cal.add_point(body.distance_mm, body.known_mm, body.measured_px)
    vision.save_calibration(db, cal, actor.email)
    db.commit()
    return cal.to_dict()


@router.delete("/calibration/points")
def clear_points(db: Annotated[Session, Depends(get_db)],
                 actor: Annotated[User, Depends(require_staff)]) -> dict:
    cal = vision.load_calibration(db)
    cal.points = []
    vision.save_calibration(db, cal, actor.email)
    db.commit()
    return cal.to_dict()


class RectangleIn(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    corners: list[list[float]]  # vier Ecken der Reihe nach, in Bildkoordinaten 0..1
    side1_mm: float = Field(gt=0)
    side2_mm: float = Field(gt=0)
    width_px: int = Field(gt=0, le=20000)
    height_px: int = Field(gt=0, le=20000)
    apply: bool = False


@router.post("/calibration/rectangle")
def calibrate_rectangle(body: RectangleIn, db: Annotated[Session, Depends(get_db)],
                        actor: Annotated[User, Depends(require_staff)]) -> dict:
    """Höhe, Neigung und Tischrahmen aus einem Rechteck bekannter Größe im Bild."""
    if not vision.available():
        raise HTTPException(status_code=503, detail=NOT_INSTALLED)
    if len(body.corners) != 4 or any(len(c) != 2 for c in body.corners):
        raise HTTPException(status_code=400, detail="Vier Ecken mit je x und y.")
    cal = vision.load_calibration(db)
    px = [[u * body.width_px, v * body.height_px] for u, v in body.corners]
    try:
        r = vision.estimate_pose(px, body.side1_mm, body.side2_mm, body.width_px, body.height_px,
                                 cal.hfov_deg)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if body.apply:
        for key in ("height_mm", "pitch_deg", "roll_deg", "origin_x_mm", "origin_y_mm", "yaw_deg"):
            setattr(cal, key, r[key])
        vision.save_calibration(db, cal, actor.email)
        db.commit()
    return {**r, "applied": body.apply}
