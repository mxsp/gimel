"""Reststücke — der Rest einer Platte, der beim nächsten Auftrag eine volle Platte spart.

Der Sammellauf schneidet in Bändern (``WorkPlate.used_h``). Hinter dem Band liegt
ein Rechteck; ist es groß genug (``offcut_min_side_mm``, ``offcut_min_area_m2``),
wird es hier als Reststück geführt:

* geplant (``pending``), solange die Quellplatte noch nicht geschnitten ist,
* verfügbar (``available``), sobald ihr Innenauftrag fertig gemeldet ist,
* reserviert (``reserved``), wenn ein neuer Lauf eine Platte darauf legt,
* verbraucht (``used``), wenn dieser Innenauftrag fertig ist.

Der Sammellauf prüft je Platte, ob alle Teile mit Rand in ein verfügbares
Reststück desselben Werkstoffs und derselben Dicke passen, und nimmt dann das
kleinste passende. Die Teile behalten ihre Lage; das Reststück darf gedreht
aufgelegt werden, weil es nur ein Rechteck ist. ``Product.stock`` zählt
weiter nur volle Platten — ein Reststück wird nie als Platte abgebucht.

Die Zustandswechsel hängen an den Innenaufträgen und werden beim Lesen
nachgezogen (``refresh``), statt an jeder Stelle, die einen Auftrag fertig
meldet, eine Zeile mehr zu verlangen.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional, Sequence

from sqlalchemy.orm import Session

from ..models import FactoryStation, Offcut, WorkOrder, WorkOrderStatus, WorkPlate
from . import settings_store
from .numbering import next_number

STATUSES = ("pending", "available", "reserved", "used", "scrapped")
_THK_EPS = 0.005


def _now() -> datetime:
    return datetime.now(timezone.utc)


def config(db: Session) -> dict:
    return {
        "enabled": settings_store.get_bool(db, "offcut_enabled", True),
        "min_side": max(0.0, settings_store.get_float(db, "offcut_min_side_mm", 150.0)),
        "min_area": max(0.0, settings_store.get_float(db, "offcut_min_area_m2", 0.05)),
        "saw": max(0.0, settings_store.get_float(db, "offcut_saw_mm", 5.0)),
    }


# --------------------------------------------------------------------------
# Geometrie — rein, ohne Datenbank
# --------------------------------------------------------------------------
def extent(placements: Iterable[dict]) -> tuple[float, float]:
    """Wie weit die Teile auf der Platte reichen (x, y), über den Umkreis.

    Der Umkreis ist konservativ: ein gedrehtes Rechteck ragt nie weiter als
    sein Umkreis."""
    mx = my = 0.0
    for p in placements:
        r = float(p.get("od") or 0.0) / 2
        mx = max(mx, float(p.get("cx") or 0.0) + r)
        my = max(my, float(p.get("cy") or 0.0) + r)
    return mx, my


def need_of(placements: Sequence[dict], margin: float) -> tuple[float, float]:
    """Kleinstes Rechteck (ab Nullecke), auf dem diese Lage samt Rand liegt."""
    mx, my = extent(placements)
    return mx + max(0.0, margin), my + max(0.0, margin)


def leftover(fmt: Sequence[float], used_h: float, turned: bool,
             placements: Sequence[dict], saw: float) -> tuple[float, float] | None:
    """Das Rechteck hinter dem Schnittband, als (Breite, Länge), oder None.

    Das Band wächst auf der ungedrehten Platte über die Höhe, auf der gedrehten
    über die Breite. Gemessen wird das Weitere von Band und Teilen, dazu die
    Trennfuge — lieber ein Reststück zu klein als eines, in dem ein Teil fehlt."""
    if not fmt or len(fmt) < 2:
        return None
    W, H = float(fmt[0]), float(fmt[1])
    ex, ey = extent(placements)
    if turned:
        used = max(float(used_h or 0.0), ex) + saw
        rest = (W - used, H)
    else:
        used = max(float(used_h or 0.0), ey) + saw
        rest = (W, H - used)
    if rest[0] <= 0 or rest[1] <= 0:
        return None
    return round(rest[0], 1), round(rest[1], 1)


def big_enough(rect: tuple[float, float] | None, min_side: float, min_area_m2: float) -> bool:
    if not rect:
        return False
    w, h = rect
    return min(w, h) >= min_side and (w / 1000) * (h / 1000) >= min_area_m2


def orient(need: tuple[float, float], w: float, h: float) -> tuple[float, float] | None:
    """Wie das Reststück aufgelegt werden muss, damit ``need`` darauf passt."""
    nw, nh = need
    if nw <= w + 1e-6 and nh <= h + 1e-6:
        return (w, h)
    if nw <= h + 1e-6 and nh <= w + 1e-6:
        return (h, w)
    return None


# --------------------------------------------------------------------------
# Datenbank
# --------------------------------------------------------------------------
def default_place(db: Session) -> tuple[int | None, str]:
    """Wohin ein neues Reststück kommt: ein Lager, das „Rest" im Namen oder in
    der Notiz trägt; sonst kein Ort (die Oberfläche sagt dann „Ort unbekannt")."""
    for st in (db.query(FactoryStation).filter(FactoryStation.is_storage.is_(True))
               .order_by(FactoryStation.id.asc()).all()):
        if "rest" in f"{st.label or ''} {st.note or ''}".lower():
            return st.id, "Reste"
    return None, ""


def refresh(db: Session) -> int:
    """Zustände an die Innenaufträge angleichen. Gibt die Zahl der Änderungen zurück.

    * Quelle fertig → geplantes Reststück liegt jetzt im Lager.
    * Quelle storniert → geplantes Reststück entsteht nie.
    * Verbraucher fertig → reserviertes Reststück ist verbraucht.
    * Verbraucher storniert → reserviertes Reststück ist wieder frei.
    """
    open_rows = (db.query(Offcut)
                 .filter(Offcut.status.in_(("pending", "reserved"))).all())
    if not open_rows:
        return 0
    nos = {r.source_work_order_no for r in open_rows} | {r.work_order_no for r in open_rows}
    nos.discard("")
    from ..db import chunked_in as _chunked_in

    status = (
        {
            no: st
            for no, st in db.query(WorkOrder.no, WorkOrder.status)
            .filter(_chunked_in(WorkOrder.no, nos))
            .all()
        }
        if nos
        else {}
    )
    now = _now()
    changed = 0
    for r in open_rows:
        if r.status == "pending":
            st = status.get(r.source_work_order_no)
            if st == WorkOrderStatus.done:
                r.status, r.available_at = "available", now
                changed += 1
            elif st == WorkOrderStatus.cancelled or st is None:
                db.delete(r)
                changed += 1
        elif r.status == "reserved":
            st = status.get(r.work_order_no)
            if st == WorkOrderStatus.done:
                r.status, r.used_at = "used", now
                changed += 1
            elif st == WorkOrderStatus.cancelled or st is None:
                r.status, r.work_order_no = "available", ""
                changed += 1
    if changed:
        db.flush()
    return changed


def available_for(db: Session, mat: str, thk: float) -> list[Offcut]:
    rows = (db.query(Offcut)
            .filter(Offcut.product_id == mat, Offcut.status == "available").all())
    return [r for r in rows if abs(float(r.thk or 0.0) - float(thk or 0.0)) < _THK_EPS]


def choose(plates: Sequence, pool: list[Offcut], margin: float) -> dict[int, tuple[Offcut, tuple[float, float]]]:
    """Welche Platte auf welches Reststück kommt: je Platte das kleinste, das passt.

    Die Platte mit dem kleinsten Bedarf zuerst — sie hat die meisten Kandidaten,
    und ein großes Reststück bleibt für die große Lage frei. Deterministisch:
    gleiche Reststücke, gleiche Lage, gleicher Plan. Gibt ``idx → (Reststück,
    aufgelegte Maße)`` zurück."""
    free = sorted(pool, key=lambda o: (o.w * o.h, o.id))
    needs = []
    for pl in plates:
        if not pl.placements:
            continue
        needs.append((pl.idx, need_of(pl.placements, margin)))
    needs.sort(key=lambda t: (t[1][0] * t[1][1], t[0]))
    out: dict[int, tuple[Offcut, tuple[float, float]]] = {}
    for idx, need in needs:
        for o in free:
            dims = orient(need, float(o.w), float(o.h))
            if dims is not None:
                out[idx] = (o, dims)
                free.remove(o)
                break
    return out


def record_leftover(db: Session, wo: WorkOrder, plate: WorkPlate, cfg: dict,
                    place: tuple[int | None, str] | None = None) -> Offcut | None:
    """Das Reststück, das beim Schnitt dieser Platte entsteht, als ``pending``."""
    rect = leftover(plate.fmt, plate.used_h, bool(plate.turned), plate.placements or [], cfg["saw"])
    if not big_enough(rect, cfg["min_side"], cfg["min_area"]):
        return None
    station_id, bin_ = place if place is not None else default_place(db)
    row = Offcut(
        code=next_number(db, "offcut", "R-"), product_id=wo.mat, thk=float(wo.thk or 0.0),
        w=rect[0], h=rect[1], status="pending", station_id=station_id, bin=bin_,
        source_work_order_no=wo.no, source_plate_id=plate.id, updated_by="system",
    )
    db.add(row)
    return row


def release_for(db: Session, wo: WorkOrder) -> dict:
    """Storno eines Innenauftrags: Reserviertes zurück, Geplantes verwerfen."""
    freed = dropped = 0
    for r in db.query(Offcut).filter(Offcut.work_order_no == wo.no,
                                     Offcut.status == "reserved").all():
        r.status, r.work_order_no = "available", ""
        freed += 1
    for r in db.query(Offcut).filter(Offcut.source_work_order_no == wo.no,
                                     Offcut.status == "pending").all():
        db.delete(r)
        dropped += 1
    return {"offcuts_freed": freed, "offcuts_dropped": dropped}


def row_out(r: Offcut, where: Optional[dict[int, dict]] = None) -> dict:
    w = (where or {}).get(r.station_id or -1, {})
    return {
        "id": r.id,
        "code": r.code,
        "mat": r.product_id,
        "thk": float(r.thk or 0.0),
        "w": float(r.w or 0.0),
        "h": float(r.h or 0.0),
        "area_m2": round((float(r.w or 0) / 1000) * (float(r.h or 0) / 1000), 4),
        "status": r.status,
        "station_id": r.station_id,
        "station_label": w.get("station_label", ""),
        "hall_name": w.get("hall_name", ""),
        "bin": r.bin or "",
        "note": r.note or "",
        "source_work_order_no": r.source_work_order_no or "",
        "work_order_no": r.work_order_no or "",
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "available_at": r.available_at.isoformat() if r.available_at else None,
        "used_at": r.used_at.isoformat() if r.used_at else None,
    }


def describe(r: Offcut, where: Optional[dict[int, dict]] = None) -> str:
    """„R-0042 · 1500×420 mm · Restregal · Reste" — für Kommissionierung und Notiz."""
    info = row_out(r, where)
    place = " · ".join(p for p in (info["station_label"], info["bin"]) if p) or "Ort unbekannt"
    return f"{r.code} · {info['w']:g}×{info['h']:g} mm · {place}"
