"""Teileerkennung am Sortiertisch: Bild lesen, offene Teile holen, Treffer zählen.

Die Kamera hängt am Browser, nicht am Server: das Portal schickt ein Standbild. So
geht es auch dort, wo der Server keine Kamera erreicht, etwa aus der VM. Das Bild
wird nur im Speicher gelesen und nie gespeichert.

OpenCV ist eine Zusatzabhängigkeit (``pip install gimel[vision]``). Fehlt es, meldet
``available()`` das, und alles andere in Gimel läuft weiter.
"""

from __future__ import annotations

import json
import math
import os
import struct
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional

import numpy as np
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core import vision as core
from ..core.nesting_kerf import rings_of
from ..core.types import Position
from ..models import AuditLog, VisionConfirmation, WorkOrder, WorkOrderStatus
from . import settings_store

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 12_000_000
#: Gerechnet wird höchstens in dieser Größe; mehr bringt der Erkennung nichts.
LONG_SIDE_PX = 1600
#: Ein Bild voller Kleinteile darf den einen Prozess nicht minutenlang belegen.
MAX_PARTS = 40
MAX_HOLES = 32
SETTING = "vision_calibration"
ZONE_SETTING = "vision_zone"
#: Bei 640 Pixeln Breite; wächst mit der Bildfläche.
MIN_AREA_PX = 400
#: Ein Teil gilt als sicher genug, um ohne Knopfdruck im Zählbereich zu zählen.
AUTO_SURE = 0.9
#: So lange muss ein Teil aus dem Zählbereich verschwunden sein, bevor ein neues an
#: derselben Stelle wieder zählt. Kurz genug für den Takt, lang genug gegen Doppelzählen.
ZONE_RESET_S = 8.0
#: Zwei Treffer sind dasselbe Teil, wenn ihre Mitten so nah beieinander liegen.
ZONE_SAME_MM = 30.0


#: Immer nur eine Erkennung zugleich; ``Busy`` wird 429.
_gate = threading.Semaphore(1)
#: Prüfen und Zählen gehören zusammen, sonst überholen sich zwei Bestätigungen.
_confirm_lock = threading.Lock()
#: Was zuletzt im Zählbereich lag: ``(work_order, position_id, x, y, seen)``. Ein Teil,
#: das im laufenden Bild erneut gesehen wird, ist schon gezählt; erst nach einer Pause
#: zählt ein neues Teil an derselben Stelle. Ohne das würde „laufend messen“ alle zwei
#: Sekunden dieselbe Dichtung abziehen.
_zone_tracks: dict[int, dict] = {}
_zone_lock = threading.Lock()
_zone_seq = 0


class VisionError(ValueError):
    """Eine Eingabe, die der Bediener verstehen und beheben kann."""


class Busy(RuntimeError):
    """Es läuft schon eine Erkennung."""


def _cv2():
    # Bevor OpenCV lädt: eine kleine Datei darf nicht zu Gigabytes aufgehen.
    os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", str(MAX_PIXELS))
    try:
        import cv2
    except ImportError:
        return None
    return cv2


def available() -> bool:
    return _cv2() is not None


def load_calibration(db: Session) -> core.Calibration:
    try:
        data = json.loads(settings_store.get(db, SETTING, "{}") or "{}")
    except ValueError:
        data = {}
    return core.Calibration.from_dict(data if isinstance(data, dict) else {})


def save_calibration(db: Session, cal: core.Calibration, actor: str) -> None:
    settings_store.set_value(db, SETTING, json.dumps(cal.to_dict()), actor=actor)
    db.add(AuditLog(actor=actor, action="vision_calibration", entity="setting",
                    entity_id=SETTING, detail=cal.to_dict()))


def load_zone(db: Session) -> core.CountZone:
    try:
        data = json.loads(settings_store.get(db, ZONE_SETTING, "{}") or "{}")
    except ValueError:
        data = {}
    return core.CountZone.from_dict(data if isinstance(data, dict) else {})


def save_zone(db: Session, zone: core.CountZone, actor: str) -> None:
    settings_store.set_value(db, ZONE_SETTING, json.dumps(zone.to_dict()), actor=actor)
    db.add(AuditLog(actor=actor, action="vision_zone", entity="setting",
                    entity_id=ZONE_SETTING, detail=zone.to_dict()))
    reset_zone_tracking()


def reset_zone_tracking() -> None:
    """Nach dem Umzeichnen oder im Test: kein alter Treffer blockiert den neuen Bereich."""
    with _zone_lock:
        _zone_tracks.clear()


def _zone_screen(zone: core.CountZone, scale: core.TableScale) -> list:
    """Der gespeicherte Tischbereich als Bildpunkte 0..1, für das Overlay im Portal."""
    if len(zone.points_mm) < 3:
        return [list(p) for p in zone.points]
    px = scale.to_pixels(np.asarray(zone.points_mm, dtype=np.float64))
    w, h = max(scale.width_px, 1), max(scale.height_px, 1)
    return np.round(px / [w, h], 5).tolist()


def _auto_count(db: Session, found: list[dict], zone: core.CountZone, actor: str) -> list[dict]:
    """Was im Zählbereich liegt, einmal zählen und vom Rest abziehen.

    Die Erkennung läuft alle zwei Sekunden; ohne Gedächtnis würde dieselbe Dichtung
    immer wieder zählen. Ein Treffer bleibt darum als gesehen markiert, solange er
    im Bereich liegt. Erst wenn er ``ZONE_RESET_S`` lang nicht mehr auftaucht, darf
    an dieser Stelle ein neues Teil zählen.
    """
    global _zone_seq
    if not (zone.enabled and zone.auto_count and len(zone.points_mm) >= 3):
        return []
    now = time.monotonic()
    fresh: list[tuple[int, dict]] = []
    with _zone_lock:
        matched: set[int] = set()
        for i, hit in enumerate(found):
            if hit["confidence"] < AUTO_SURE or hit.get("ambiguous", 0):
                continue
            if hit.get("remaining", 0) <= 0 or not zone.contains(hit["x_mm"], hit["y_mm"]):
                continue
            same = next(((key, t) for key, t in _zone_tracks.items()
                         if t["work_order"] == hit["work_order"]
                         and t["position_id"] == hit["position_id"]
                         and math.hypot(t["x"] - hit["x_mm"], t["y"] - hit["y_mm"])
                         <= max(ZONE_SAME_MM, 0.35 * min(hit["length_mm"], hit["width_mm"]))), None)
            if same is not None:
                key, track = same
                track.update(seen=now, x=hit["x_mm"], y=hit["y_mm"], missing_since=None)
                matched.add(key)
                continue
            fresh.append((i, hit))
        # Ein Teil, das nur lange nicht gemessen wurde, ist nicht verschwunden. Erst
        # wenn es in einer echten Messung fehlt, beginnt die Wartezeit; sonst würde
        # dieselbe Dichtung nach zehn Minuten Pause ein zweites Mal zählen.
        for key, track in list(_zone_tracks.items()):
            if key in matched:
                continue
            if track.get("missing_since") is None:
                track["missing_since"] = now
            elif now - track["missing_since"] > ZONE_RESET_S:
                _zone_tracks.pop(key, None)
        # Erst nach dem Zählen eintragen: schlägt die Bestätigung fehl, darf der
        # nächste Takt es erneut versuchen.
    counted = []
    for i, hit in fresh:
        try:
            r = confirm(db, hit["work_order"], hit["position_id"], actor,
                        confidence=hit["confidence"], x_mm=hit["x_mm"], y_mm=hit["y_mm"],
                        angle_deg=hit["angle_deg"])
        except (LookupError, VisionError, PermissionError):
            continue
        hit.update(confirmed=r["confirmed"], remaining=r["remaining"], counted=True,
                   confirmation_id=r["id"])
        with _zone_lock:
            _zone_seq += 1
            _zone_tracks[_zone_seq] = {"work_order": hit["work_order"],
                                       "position_id": hit["position_id"],
                                       "x": hit["x_mm"], "y": hit["y_mm"], "seen": now,
                                       "missing_since": None}
        counted.append({"id": r["id"], "hit": i, "work_order": hit["work_order"],
                        "position_id": hit["position_id"], "label": hit.get("label") or hit.get("tag") or "",
                        "remaining": r["remaining"]})
    return counted


# ---------------- erwartete Teile ----------------
@lru_cache(maxsize=512)
def _template(od: float, di: float, shape_json: str) -> core.Candidate:
    shape = json.loads(shape_json) if shape_json else None
    return core.candidate(None, rings_of(Position(id=0, od=od, di=di, shape=shape)))


def expected(db: Session, work_order: Optional[str] = None) -> list[dict]:
    """Die Teile, die gerade auf dem Tisch liegen können, je Position und Innenauftrag.

    Ohne Nummer alles Offene. Ein fertig geschnittener Auftrag wird noch sortiert,
    deshalb geht er mit seiner Nummer weiterhin.
    """
    q = db.query(WorkOrder)
    if work_order:
        q = q.filter(WorkOrder.no == work_order,
                     WorkOrder.status != WorkOrderStatus.cancelled)
    else:
        q = q.filter(WorkOrder.status.in_((WorkOrderStatus.open, WorkOrderStatus.running)))
    parts: dict[tuple, dict] = {}
    numbers: list[str] = []
    for wo in q.all():
        numbers.append(wo.no)
        for plate in wo.plates:
            for pl in plate.placements or []:
                key = (wo.no, pl.get("position_id"))
                row = parts.get(key)
                if row is None:
                    row = parts[key] = {
                        "work_order": wo.no, "position_id": pl.get("position_id"),
                        "order_no": pl.get("order_no", ""), "customer": pl.get("customer", ""),
                        "label": pl.get("label", ""), "tag": pl.get("tag", ""), "qty": 0,
                        "confirmed": 0, "_od": float(pl.get("od") or 0),
                        "_di": float(pl.get("di") or 0),
                        "_shape": json.dumps(pl.get("shape"), sort_keys=True) if pl.get("shape") else ""}
                row["qty"] += 1
    if numbers:
        counts = (db.query(VisionConfirmation.work_order_no, VisionConfirmation.position_id,
                           func.count(VisionConfirmation.id))
                  .filter(VisionConfirmation.work_order_no.in_(numbers))
                  .group_by(VisionConfirmation.work_order_no, VisionConfirmation.position_id))
        for no, pos, n in counts:
            if (no, pos) in parts:
                parts[(no, pos)]["confirmed"] = n
    for row in parts.values():
        row["remaining"] = max(row["qty"] - row["confirmed"], 0)
    return list(parts.values())


@lru_cache(maxsize=512)
def _outline(od: float, di: float, shape_json: str) -> dict:
    """Umriss für die Liste: SVG-Pfad in Millimetern, auf die Box verschoben, je Ring 64 Punkte."""
    shape = json.loads(shape_json) if shape_json else None
    rings = [np.asarray(r, dtype=np.float64) for r in rings_of(Position(id=0, od=od, di=di, shape=shape))]
    if not rings or not len(rings[0]):
        return {"path": "", "w": 0.0, "h": 0.0}
    lo = rings[0].min(axis=0)
    size = rings[0].max(axis=0) - lo
    parts = []
    for r in rings:
        pts = (r[:: max(1, len(r) // 64)] - lo).round(1)
        parts.append("M" + "L".join(f"{x:g},{y:g}" for x, y in pts) + "Z")
    return {"path": "".join(parts), "w": round(float(size[0]), 1), "h": round(float(size[1]), 1)}


def _public(row: dict, office: bool) -> dict:
    """Die Halle sieht Auftrag und Teil, keine Kunden (Rolle ``worker``, models.py)."""
    out = {k: v for k, v in row.items() if not k.startswith("_")}
    if not office:
        out.pop("customer", None)
    if "_od" in row:
        out["outline"] = _outline(row["_od"], row["_di"], row["_shape"])
    return out


def public_expected(db: Session, work_order: Optional[str], office: bool) -> list[dict]:
    return [_public(r, office) for r in expected(db, work_order)]


# ---------------- Bild ----------------
def image_size(data: bytes) -> tuple[int, int]:
    """Breite und Höhe aus dem Dateikopf, bevor irgendetwas entpackt wird."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        if len(data) < 24:
            raise VisionError("Das Bild lässt sich nicht lesen.")
        return struct.unpack(">II", data[16:24])
    if not data.startswith(b"\xff\xd8\xff"):
        raise VisionError("Erwartet wird ein JPEG- oder PNG-Bild.")
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    raise VisionError("Das Bild lässt sich nicht lesen.")


def decode(cv2, data: bytes) -> np.ndarray:
    if len(data) > MAX_IMAGE_BYTES:
        raise VisionError("Das Bild ist größer als 8 MB.")
    w, h = image_size(data)
    if w * h > MAX_PIXELS:
        raise VisionError("Das Bild hat zu viele Bildpunkte, höchstens 12 Megapixel.")
    frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise VisionError("Das Bild lässt sich nicht lesen.")
    long_side = max(frame.shape[:2])
    if long_side > LONG_SIDE_PX:
        f = LONG_SIDE_PX / long_side
        frame = cv2.resize(frame, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    return frame


def _table_side(cv2, mask: np.ndarray) -> np.ndarray:
    """Was am Bildrand liegt, ist Tisch; Teile müssen sich vom Tisch abheben."""
    border = np.concatenate([mask[0], mask[-1], mask[:, 0], mask[:, -1]])
    return cv2.bitwise_not(mask) if border.mean() > 127 else mask


def _clean(cv2, mask: np.ndarray) -> np.ndarray:
    """Kleine Störungen weg, ohne die Löcher eines Teils zuzuschmieren."""
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))


def segment_variants(cv2, frame: np.ndarray) -> list[np.ndarray]:
    """Zwei Schwellen: gleichmäßig ausgeleuchtet und mit abgezogenem Tischverlauf.

    Eine Lampe über dem Tisch macht das Bild heller zur Mitte hin; eine globale
    Otsu-Schwelle schneidet dann Teile am Rand ab. Die zweite Maske zieht einen
    weichgezeichneten Tischverlauf ab und hält die Teile über die ganze Fläche
    zusammen. Die erste bleibt als Rückfall, wenn die Fläche sehr gleichmäßig ist.
    """
    gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    _, plain = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    h, w = gray.shape[:2]
    # Den Tischverlauf auf einem kleinen Bild schätzen: ein Gauß mit sigma 100 auf
    # 12 Megapixeln kostet Sekunden, auf einem Zehntel davon nichts.
    step = max(1, min(h, w) // 120)
    small = cv2.resize(gray, (max(24, w // step), max(24, h // step)),
                       interpolation=cv2.INTER_AREA)
    background = cv2.resize(cv2.GaussianBlur(small, (0, 0), max(2.0, small.shape[1] / 16)),
                            (w, h), interpolation=cv2.INTER_LINEAR)
    flat = cv2.addWeighted(gray, 1.0, background, -1.0, 128)
    _, levelled = cv2.threshold(flat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    masks = [_clean(cv2, _table_side(cv2, m)) for m in (levelled, plain)]
    # Bei gleichmäßigem Licht sind beide gleich; dann genügt eine Runde.
    if np.array_equal(masks[0], masks[1]):
        return masks[:1]
    return masks


def segment(cv2, frame: np.ndarray) -> np.ndarray:
    """Die bevorzugte Maske; ``segment_variants`` liefert die Rückfallvariante mit."""
    return segment_variants(cv2, frame)[0]


def _thin(cv2, contour: np.ndarray, limit: int = 256) -> np.ndarray:
    """Kontur als Polygon: Ecken bleiben, Rauschen fällt weg.

    ``approxPolyDP`` ist hier wichtiger als bei einem Rechteck-Modell: die Form wird
    über ihre Ecken verglichen, und eine Kontur mit tausend Bildpunkten trägt nur
    Sensorrauschen bei. Der Fehler bleibt unter einem Bruchteil eines Millimeters.
    """
    pts = contour.reshape(-1, 2).astype(np.float32)
    if len(pts) >= 8:
        eps = max(0.6, 0.002 * cv2.arcLength(contour, True))
        approx = cv2.approxPolyDP(contour, eps, True).reshape(-1, 2)
        if 3 <= len(approx) < len(pts):
            pts = approx.astype(np.float32)
    if len(pts) > limit:
        pts = pts[:: max(1, len(pts) // limit)]
    return pts.astype(np.float64)


def find_parts(cv2, mask: np.ndarray) -> list[dict]:
    """Je Teil die Außenkontur mit ihren Löchern, in Pixeln."""
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return []
    h, w = mask.shape[:2]
    min_area = MIN_AREA_PX * (w / 640) ** 2
    outer = [(cv2.contourArea(c), i) for i, c in enumerate(contours) if hierarchy[0][i][3] == -1]
    largest = sorted((a, i) for a, i in outer if a >= min_area)[::-1][:MAX_PARTS]
    out = []
    for _, i in largest:
        c = contours[i]
        holes, child = [], hierarchy[0][i][2]
        while child != -1 and len(holes) < MAX_HOLES:
            if cv2.contourArea(contours[child]) >= min_area / 8:
                holes.append(_thin(cv2, contours[child], limit=160))
            child = hierarchy[0][child][0]
        box = cv2.boxPoints(cv2.minAreaRect(c)) / [w, h]
        out.append({"rings": [_thin(cv2, c), *holes], "box": np.round(box, 5).tolist()})
    return out


def _geometry(row: dict) -> tuple:
    return (row["_od"], row["_di"], row["_shape"])


def identify(db: Session, data: bytes, work_order: Optional[str], office: bool,
             actor: str = "", preview: bool = False) -> dict:
    if not _gate.acquire(blocking=False):
        raise Busy()
    try:
        return _identify(db, data, work_order, office, actor, preview)
    finally:
        _gate.release()


def _identify(db: Session, data: bytes, work_order: Optional[str], office: bool,
              actor: str, preview: bool) -> dict:
    cv2 = _cv2()
    if cv2 is None:
        raise RuntimeError("OpenCV fehlt")
    frame = decode(cv2, data)
    h, w = frame.shape[:2]
    cal = load_calibration(db)
    scale = core.TableScale(cal, w, h)
    rows = expected(db, work_order)
    # Eine Form, ein Kandidat: dasselbe Teil in zehn Innenaufträgen darf die acht
    # Plätze für den Formvergleich nicht allein belegen.
    shapes: dict[tuple, list[dict]] = {}
    for row in rows:
        shapes.setdefault(_geometry(row), []).append(row)
    cands = []
    for key, same in shapes.items():
        t = _template(*key)
        cands.append(core.Candidate(same, t.length_mm, t.width_mm, t.rings))
    masks = segment_variants(cv2, frame)
    parts = find_parts(cv2, masks[0])
    if not parts:
        # Gleichmäßiges Licht, glänzende Teile: die zweite Schwelle findet sie oft noch.
        for fallback in masks[1:]:
            parts = find_parts(cv2, fallback)
            if parts:
                break
    found, unknown = [], []
    for part in parts:
        rings = [scale.to_table(r) for r in part["rings"]]
        hit = core.match(rings, cands, cal.tolerance_mm)
        if hit is None:
            box = core.oriented_box(rings[0])
            unknown.append({"length_mm": round(box["length_mm"], 1),
                            "width_mm": round(box["width_mm"], 1), "box": part["box"]})
            continue
        # Dasselbe Teil in mehreren Innenaufträgen ist keine Verwechslung: es zählt beim
        # ältesten, der noch offen ist. Unsicher ist nur eine andere Form, die fast gleich passt.
        same = hit["ref"]
        other = [r for group in hit["ambiguous"] for r in group]
        ref = min(same, key=lambda r: (r["remaining"] == 0, r["work_order"], r["position_id"]))
        found.append({**_public(ref, office), "confidence": hit["confidence"],
                      "ambiguous": len(hit["ambiguous"]), "box": part["box"],
                      "alternatives": [{k: alt[k] for k in ("work_order", "position_id", "label",
                                                            "tag", "order_no", "remaining")}
                                       for alt in [*other, *(r for r in same if r is not ref)]],
                      **{k: round(hit[k], 1)
                         for k in ("length_mm", "width_mm", "x_mm", "y_mm", "angle_deg")}})
    zone = load_zone(db)
    # Ein Testbild prüft die Einmessung; es darf keine echten Stückzahlen abziehen.
    auto_counted = _auto_count(db, found, zone, actor) if actor and not preview else []
    return {"parts": found, "unknown": unknown, "expected": len(rows),
            "width_px": w, "height_px": h, "auto_counted": auto_counted,
            "zone": {"enabled": zone.enabled, "auto_count": zone.auto_count,
                     "points": _zone_screen(zone, scale)}}


def confirm(db: Session, work_order: str, position_id: int, actor: str, confidence: float = 0.0,
            x_mm: float = 0.0, y_mm: float = 0.0, angle_deg: float = 0.0) -> dict:
    """Ein erkanntes Teil zählen. Mehr als bestellt geht nicht."""
    with _confirm_lock:
        row = next((r for r in expected(db, work_order) if r["position_id"] == position_id), None)
        if row is None:
            raise LookupError("Dieses Teil gehört nicht zu diesem Innenauftrag.")
        if row["remaining"] == 0:
            raise VisionError("Alle Teile dieser Position sind schon gezählt.")
        done = VisionConfirmation(work_order_no=work_order, position_id=position_id, actor=actor,
                                  confidence=confidence, x_mm=x_mm, y_mm=y_mm,
                                  angle_deg=angle_deg)
        db.add(done)
        db.add(AuditLog(actor=actor, action="vision_confirm", entity="work_order",
                        entity_id=work_order, detail={"position_id": position_id,
                                                      "confidence": confidence}))
        db.commit()
    return {"id": done.id, "confirmed": row["confirmed"] + 1, "remaining": row["remaining"] - 1}


#: So lange darf die Halle eine eigene Zählung zurücknehmen; das Büro immer.
UNDO_MINUTES = 15


def undo(db: Session, confirmation_id: int, actor: str, office: bool,
         now: Optional[datetime] = None) -> dict:
    """Eine Zählung zurücknehmen: falsches Teil gezählt, doppelt gedrückt."""
    with _confirm_lock:
        row = db.get(VisionConfirmation, confirmation_id)
        if row is None:
            raise LookupError("Diese Zählung gibt es nicht.")
        if not office:
            made = row.created_at if row.created_at.tzinfo else row.created_at.replace(tzinfo=timezone.utc)
            if row.actor != actor:
                raise PermissionError("Nur die eigene Zählung lässt sich zurücknehmen.")
            if (now or datetime.now(timezone.utc)) - made > timedelta(minutes=UNDO_MINUTES):
                raise PermissionError(f"Nach {UNDO_MINUTES} Minuten nimmt nur das Büro eine Zählung zurück.")
        no, pos = row.work_order_no, row.position_id
        wo = db.query(WorkOrder).filter(WorkOrder.no == no).first()
        if wo is not None and wo.status == WorkOrderStatus.cancelled:
            raise VisionError("Der Innenauftrag ist storniert; seine Zählung bleibt, wie sie ist.")
        made_at = row.created_at.isoformat() if row.created_at else ""
        db.delete(row)
        db.add(AuditLog(actor=actor, action="vision_undo", entity="work_order", entity_id=no,
                        detail={"position_id": pos, "confirmation_id": confirmation_id,
                                "counted_by": row.actor, "counted_at": made_at}))
        db.commit()
    left = next((r for r in expected(db, no) if r["position_id"] == pos), None)
    return {"work_order": no, "position_id": pos,
            "remaining": left["remaining"] if left else 0}


# ---------------- Testbild ----------------
SAMPLE_W, SAMPLE_H = 1280, 720
#: Höchstens so viele Teile auf einem Testbild.
SAMPLE_MAX = 6


def sample(db: Session, work_order: Optional[str], count: int = 1,
           seed: Optional[int] = None) -> bytes:
    if not _gate.acquire(blocking=False):
        raise Busy()
    try:
        return _sample(db, work_order, count, seed)
    finally:
        _gate.release()


def _sample(db: Session, work_order: Optional[str], count: int, seed: Optional[int]) -> bytes:
    """Ein künstliches Bild vom Tisch: offene Teile, gesehen durch die eingemessene Kamera.

    Zum Ausprobieren ohne Kamera und zum Prüfen der Einmessung: was hier nicht erkannt
    wird, wird es auch auf dem echten Tisch nicht. Das Bild entsteht im Speicher.
    """
    cv2 = _cv2()
    if cv2 is None:
        raise RuntimeError("OpenCV fehlt")
    rows = [r for r in expected(db, work_order) if r["remaining"] > 0]
    if not rows:
        raise VisionError("Kein offenes Teil für ein Testbild.")
    rng = np.random.default_rng(seed)
    cal = load_calibration(db)
    scale = core.TableScale(cal, SAMPLE_W, SAMPLE_H)
    img = np.full((SAMPLE_H, SAMPLE_W, 3), 38, np.uint8)
    noise = rng.normal(0, 4, img.shape[:2])
    img = np.clip(img + noise[..., None], 0, 255).astype(np.uint8)
    corners = scale.to_table(np.array([[0, 0], [SAMPLE_W, 0], [SAMPLE_W, SAMPLE_H], [0, SAMPLE_H]], float))
    lo, hi = corners.min(axis=0), corners.max(axis=0)
    placed: list[tuple] = []
    picks = rng.choice(len(rows), size=min(max(1, count), SAMPLE_MAX), replace=True)
    for i in picks:
        row = rows[int(i)]
        raw = [np.asarray(r, np.float64) for r in rings_of(Position(
            id=0, od=row["_od"], di=row["_di"],
            shape=json.loads(row["_shape"]) if row["_shape"] else None))]
        centre = raw[0].mean(axis=0)
        raw = [r - centre for r in raw]
        reach = float(np.linalg.norm(raw[0], axis=1).max())
        for _ in range(40):
            at = rng.uniform(lo + reach + 10, hi - reach - 10) if (hi - lo > 2 * reach + 20).all() else (lo + hi) / 2
            if all(np.linalg.norm(at - p[0]) > reach + p[1] + 15 for p in placed):
                break
        else:
            continue
        placed.append((at, reach))
        a = rng.uniform(0, 2 * math.pi)
        rot = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
        polys = [np.round(scale.to_pixels(r @ rot.T + at)).astype(np.int32) for r in raw]
        mask = np.zeros(img.shape[:2], np.uint8)
        cv2.fillPoly(mask, polys, 255)
        img[mask > 0] = (196, 200, 204)
    ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise VisionError("Das Testbild ließ sich nicht schreiben.")
    return jpg.tobytes()


def estimate_pose(corners_px: list, side1_mm: float, side2_mm: float, width_px: int,
                  height_px: int, hfov_deg: float) -> dict:
    """Kameralage aus einem Rechteck bekannter Größe auf dem Tisch.

    ``corners_px`` sind die vier Ecken der Reihe nach, Seite 1 von Ecke 1 nach 2, Seite 2
    von Ecke 2 nach 3. Der Tischrahmen beginnt in Ecke 1, X läuft längs Seite 1.
    """
    cv2 = _cv2()
    if cv2 is None:
        raise RuntimeError("OpenCV fehlt")
    img = np.asarray(corners_px, np.float64).reshape(4, 2)
    obj = np.array([[0, 0, 0], [side1_mm, 0, 0], [side1_mm, side2_mm, 0], [0, side2_mm, 0]],
                   np.float64)
    fx = (width_px / 2) / math.tan(math.radians(hfov_deg) / 2)
    k = np.array([[fx, 0, width_px / 2], [0, fx, height_px / 2], [0, 0, 1]])
    ok, rvec, tvec = cv2.solvePnP(obj, img, k, None, flags=cv2.SOLVEPNP_IPPE)
    if not ok:
        raise VisionError("Aus diesen Ecken lässt sich die Kameralage nicht bestimmen.")
    rot, _ = cv2.Rodrigues(rvec)
    n, t = rot[:, 2], tvec.ravel()
    cam_z = float(-n @ t)
    down = -n if cam_z > 0 else n
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, float(down[1])))))
    roll = math.degrees(math.atan2(float(-down[0]), float(down[2])))
    height = abs(cam_z)
    level = core.Calibration(height_mm=height, hfov_deg=hfov_deg, pitch_deg=pitch, roll_deg=roll)
    p = core.TableScale(level, width_px, height_px).to_table(img)
    yaw = math.degrees(math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]))
    proj, _ = cv2.projectPoints(obj, rvec, tvec, k, None)
    return {"height_mm": height, "pitch_deg": pitch, "roll_deg": roll, "yaw_deg": yaw,
            "origin_x_mm": float(p[0][0]), "origin_y_mm": float(p[0][1]),
            "reproj_px": float(np.abs(proj.reshape(4, 2) - img).max()),
            "measured_sides_mm": [float(np.linalg.norm(p[1] - p[0])),
                                  float(np.linalg.norm(p[2] - p[1]))]}
