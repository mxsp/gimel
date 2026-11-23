"""Plattenbelegung von Hand ändern: laden, prüfen, speichern, zurücknehmen.

Was hier gespeichert wird, schneidet die Maschine. Deshalb bringt der Browser nur
Marke, Lage und Drehung mit; Kontur, Auftrag und Position kommen aus dem Plan.
Eine Lage gilt erst, wenn jedes Teil genau einmal da ist und ``plate_check`` sie
mit exakter Geometrie durchlässt. Was läuft oder fertig ist, bleibt eingefroren.
"""

from __future__ import annotations

import hashlib
import json
import math
import threading
from dataclasses import replace
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.batch import NestOptions, plan_batch
from ..core.nesting_kerf import _allowed
from ..core.nesting import resolve_policy
from ..core.plate_check import Window, check_plate, in_hole_of, local_rings, plate_metrics
from ..core.routing import eligibility, job_minutes, needs_changeover
from ..models import (AuditLog, Order, OrderPosition, Product, WorkItem, WorkOrder,
                      WorkOrderStatus, WorkPlate)
from ..render.dxf import _find_host
from .batch_runner import (STANDALONE_NEST_MS, RenestError, _batch_part, _run_lock, load_products,
                           load_rates, options_resolver, policy_resolver)
from .factory_router import job_spec, station_specs
from .inventory import move_stock

MAX_PLATES = 200
#: Mehr liest niemand, und jede weitere Meldung kostet einen Paarvergleich.
MAX_ISSUES = 40
_MAX_MOVED_IN_AUDIT = 200
_auto_lock = threading.Lock()
_check_lock = threading.Lock()
_STALE = "Die Belegung wurde inzwischen geändert. Bitte neu laden."
_FROZEN = "Mindestens eine Platte ist schon gemeldet."
_NO_OPTIONS = "Abstand oder Rand dieses Plans sind nicht gespeichert: die Lage lässt sich nicht prüfen."


class LayoutError(Exception):
    """Eine Lage, die nicht gelten darf — mit Klartext für den Editor."""

    def __init__(self, detail: str, status: int = 422):
        super().__init__(detail)
        self.detail = detail
        self.status = status


def _stored(wo: WorkOrder) -> dict[str, dict]:
    return {str(p["tag"]): p for plate in wo.plates for p in plate.placements or []}


def version_of(wo: WorkOrder) -> str:
    """Stand der Lage. Wer auf einem alten Stand speichert, bekommt 409."""
    rows = [[p.idx, p.fmt, bool(p.turned),
             [[i.get("tag"), i.get("cx"), i.get("cy"), i.get("rot")] for i in p.placements or []]]
            for p in sorted(wo.plates, key=lambda p: p.idx)]
    return hashlib.sha256(json.dumps([wo.layout_rev or 0, rows], sort_keys=True).encode()).hexdigest()[:16]


def _has_options(wo: WorkOrder) -> bool:
    """Ein fehlender Abstand ist unbekannt, nicht null."""
    o = _options(wo)
    return o.get("gap") is not None and o.get("margin") is not None


def blocked_reason(wo: WorkOrder) -> str:
    """Warum diese Lage nicht geändert werden darf; leer, wenn sie es darf."""
    if wo.status != WorkOrderStatus.open:
        return "Der Innenauftrag ist nicht mehr offen: die Lage bleibt, wie sie geschnitten wird."
    if any(p.status != WorkOrderStatus.open for p in wo.plates):
        return _FROZEN
    if wo.material_staged_at:
        return "Das Material ist bereitgestellt: erst die Bereitstellung zurücknehmen."
    if not _has_options(wo):
        return _NO_OPTIONS
    tags = [str(p.get("tag")) for plate in wo.plates for p in plate.placements or []]
    if not tags or len(tags) != len(set(tags)):
        return "Diese Belegung hat keine eindeutigen Marken."
    return ""


def _options(wo: WorkOrder) -> dict:
    return wo.nest_options or {}


def _corner_max(wo: WorkOrder) -> float | None:
    value = _options(wo).get("corner_max_dist")
    return float(value) if value else None


def _window(wo: WorkOrder, fmt) -> Window:
    o = _options(wo)
    return Window(float(fmt[0]), float(fmt[1]), float(o.get("gap") or 0), float(o.get("margin") or 0),
                  float(o.get("trim_w") or 0), float(o.get("trim_h") or 0), _corner_max(wo))


def _formats(db: Session, wo: WorkOrder) -> list[list[float]]:
    product = db.get(Product, wo.mat)
    known = [[float(w), float(h)] for w, h in (product.sheets if product else [])]
    for p in wo.plates:
        fmt = [float(p.fmt[0]), float(p.fmt[1])]
        if fmt not in known:
            known.append(fmt)
    return known


def _rotations(db: Session, wo: WorkOrder) -> list[float]:
    product = load_products(db).get(wo.mat)
    if product is None:
        return [0.0]
    return [float(r) for r in _allowed(product, resolve_policy(load_rates(db), None))]


def _view_part(p: dict) -> dict:
    return {"tag": str(p["tag"]), "label": p.get("label") or "", "order_no": p.get("order_no") or "",
            "od": p.get("od") or 0, "di": p.get("di") or 0, "cx": p["cx"], "cy": p["cy"],
            "rot": float(p.get("rot") or 0), "rings": local_rings(p)}


def load_layout(db: Session, wo: WorkOrder) -> dict:
    o = _options(wo)
    return {
        "no": wo.no, "mat": wo.mat, "mat_name": wo.mat_name or wo.mat, "thk": wo.thk, "status": wo.status.value,
        "version": version_of(wo), "blocked": blocked_reason(wo),
        "gap": float(o.get("gap") or 0), "margin": float(o.get("margin") or 0),
        "trim_w": float(o.get("trim_w") or 0), "trim_h": float(o.get("trim_h") or 0),
        "corner_max": _corner_max(wo),
        "formats": _formats(db, wo), "rotations": _rotations(db, wo),
        "has_auto": wo.auto_layout is not None,
        "edited_at": wo.layout_edited_at.isoformat() if wo.layout_edited_at else None,
        "edited_by": wo.layout_edited_by or "",
        "files_issued_at": wo.cut_files_issued_at.isoformat() if wo.cut_files_issued_at else None,
        "plates": [{"fmt": [float(p.fmt[0]), float(p.fmt[1])], "turned": bool(p.turned),
                    "placements": [_view_part(i) for i in p.placements or []]}
                   for p in sorted(wo.plates, key=lambda p: p.idx)],
    }


def _may_turn(wo: WorkOrder) -> bool:
    """Gedreht verbaut ist eine Eigenschaft des Plans, keine Wahl im Browser."""
    snapshot = (wo.auto_layout or {}).get("plates") or []
    return any(p.turned for p in wo.plates) or any(p.get("turned") for p in snapshot)


def _resolve(db: Session, wo: WorkOrder, plates: list[dict], *, restored: bool = False) -> list[list[dict]]:
    """Die Lage des Browsers auf die gespeicherten Teile legen. Wirft bei allem, was
    nicht genau dieselben Teile sind. Die Rücknahme bringt die eigene Lage des
    Rechenkerns: sie darf Formate und Drehungen haben, die heute nicht mehr erlaubt
    sind, aber keine anderen Teile."""
    if not plates or len(plates) > MAX_PLATES:
        raise LayoutError("Eine Belegung braucht mindestens eine Platte.")
    stored = _stored(wo)
    rotations = set(_rotations(db, wo))
    formats = _formats(db, wo)
    may_turn = restored or _may_turn(wo)
    seen: set[str] = set()
    out = []
    for plate in plates:
        if not restored and [float(v) for v in plate["fmt"]] not in formats:
            raise LayoutError("Dieses Plattenformat gibt es für den Werkstoff nicht.")
        if plate.get("turned") and not may_turn:
            raise LayoutError("Dieser Plan kennt keine gedreht verbaute Platte.")
        if not plate["placements"]:
            raise LayoutError("Eine leere Platte kann nicht gespeichert werden.")
        items = []
        for row in plate["placements"]:
            tag = str(row["tag"])
            if tag not in stored:
                raise LayoutError(f"Marke {tag} gehört nicht zu diesem Innenauftrag.")
            if tag in seen:
                raise LayoutError(f"Marke {tag} liegt doppelt.")
            seen.add(tag)
            cx, cy, rot = float(row["cx"]), float(row["cy"]), float(row["rot"])
            if not all(math.isfinite(v) for v in (cx, cy, rot)):
                raise LayoutError(f"Marke {tag} hat keine gültige Lage.")
            rot %= 360
            if not restored and rot not in rotations and rot != float(stored[tag].get("rot") or 0) % 360:
                raise LayoutError(f"Marke {tag}: diese Drehung erlaubt der Werkstoff nicht.")
            items.append({**stored[tag], "cx": round(cx, 3), "cy": round(cy, 3), "rot": rot})
        out.append(items)
    missing = sorted(set(stored) - seen)
    if missing:
        raise LayoutError(f"Es fehlen {len(missing)} Teile, zum Beispiel {missing[0]}.")
    return out


def _host_issues(items: list[dict]) -> list[str]:
    """Ein Gast muss vor seinem Wirt fallen. Die Schnittfolge findet den Wirt mit
    ``_find_host`` (nur um dessen Mitte): wen sie nicht findet, schneidet sie irgendwann,
    womöglich auf einer losen Scheibe. Deshalb dieselbe Frage hier, vor dem Speichern."""
    nested = in_hole_of(items)
    marked = [{**i, "from_remnant": i["tag"] in nested} for i in items]
    return [f"Marke {i['tag']} liegt außermittig in einem Loch: die Schnittfolge findet keinen Wirt, "
            "das Teil läge beim Schnitt lose." for i in marked
            if i["from_remnant"] and _find_host(i, marked) is None]


def check_layout(db: Session, wo: WorkOrder, plates: list[dict]) -> dict:
    """Immer nur eine Prüfung zugleich: sie läuft im einzigen Prozess der Anwendung."""
    if not _check_lock.acquire(blocking=False):
        raise LayoutError("Es läuft schon eine Prüfung.", 409)
    try:
        return _check(db, wo, plates)
    finally:
        _check_lock.release()


def _check(db: Session, wo: WorkOrder, plates: list[dict]) -> dict:
    if not _has_options(wo):
        raise LayoutError(_NO_OPTIONS, 409)
    resolved = _resolve(db, wo, plates)
    issues: list[str] = []
    metrics = []
    for i, (plate, items) in enumerate(zip(plates, resolved), 1):
        window = _window(wo, plate["fmt"])
        left = MAX_ISSUES - len(issues)
        if left > 0:
            found = check_plate(window, items, left)["issues"] + _host_issues(items)
            issues += [f"Platte {i}: {text}" for text in found]
        m = plate_metrics(window, items, bool(plate.get("turned")))
        metrics.append({"fill": round(m["fill"], 4), "utilisation": round(m["utilisation"], 4)})
    return {"valid": not issues, "issues": issues[:MAX_ISSUES], "plates": metrics}


def _snapshot(wo: WorkOrder) -> dict:
    """Die automatische Lage, ohne Kundennamen: Marken und Koordinaten genügen."""
    return {"plates": [{"fmt": p.fmt, "turned": bool(p.turned),
                        "placements": [{"tag": i["tag"], "cx": i["cx"], "cy": i["cy"],
                                        "rot": float(i.get("rot") or 0)} for i in p.placements or []]}
                       for p in sorted(wo.plates, key=lambda p: p.idx)]}


def _unchanged(wo: WorkOrder, plates: list[dict], resolved: list[list[dict]]) -> bool:
    """Ist das genau die gespeicherte Lage? Dann gibt es nichts zu speichern."""
    rows = sorted(wo.plates, key=lambda p: p.idx)
    if len(rows) != len(plates):
        return False
    for row, plate, items in zip(rows, plates, resolved):
        if [float(v) for v in row.fmt] != [float(v) for v in plate["fmt"]]:
            return False
        if bool(row.turned) != bool(plate.get("turned")):
            return False
        have = [(str(i["tag"]), float(i["cx"]), float(i["cy"]), float(i.get("rot") or 0) % 360)
                for i in row.placements or []]
        if have != [(str(i["tag"]), i["cx"], i["cy"], i["rot"]) for i in items]:
            return False
    return True


def _moved(wo: WorkOrder, resolved: list[list[dict]]) -> list[str]:
    """Die Marken, die jetzt woanders liegen: das steht im Prüfprotokoll."""
    def where(idx: int, i: dict) -> tuple:
        return idx, float(i["cx"]), float(i["cy"]), float(i.get("rot") or 0) % 360

    before = {str(i["tag"]): where(p.idx, i) for p in wo.plates for i in p.placements or []}
    after = {str(i["tag"]): where(idx, i) for idx, items in enumerate(resolved) for i in items}
    return sorted(tag for tag, spot in after.items() if before.get(tag) != spot)


def _station(db: Session, wo: WorkOrder):
    if not wo.station_id:
        return None
    return next((s for s in station_specs(db) if s.id == wo.station_id), None)


def _refuse_oversize(db: Session, wo: WorkOrder, plates: list[dict]) -> None:
    """Passt jede Platte auf den Tisch der zugeordneten Station? Die Frage stellt
    ``eligibility``, sie kennt auch die Lage quer. Was schon ohne Platte blockiert
    (Station inaktiv, Dicke), ist nicht die Sache dieser Lage."""
    station = _station(db, wo)
    if station is None:
        return
    job = job_spec(db, wo)
    known = set(eligibility(replace(job, plate_mm=(0.0, 0.0)), station))
    for i, plate in enumerate(plates, 1):
        size = (float(plate["fmt"][0]), float(plate["fmt"][1]))
        extra = [text for text in eligibility(replace(job, plate_mm=size), station) if text not in known]
        if extra:
            raise LayoutError(f"Platte {i}: {extra[0]}.")


def _replan(db: Session, wo: WorkOrder) -> None:
    """Die Belegzeit folgt den Platten: dieselbe Rechnung wie bei der Zuordnung."""
    station = _station(db, wo)
    if station is None:
        return
    job = job_spec(db, wo)
    wo.planned_min = job_minutes(job, station, needs_changeover(job, station)) or 0.0


def save_layout(db: Session, wo: WorkOrder, plates: list[dict], version: str, actor: str,
                *, restored: bool = False) -> dict:
    reason = blocked_reason(wo)
    if reason:
        raise LayoutError(reason, 409)
    if version != version_of(wo):
        raise LayoutError(_STALE, 409)
    resolved = _resolve(db, wo, plates, restored=restored)
    # Die Rücknahme nie: sie räumt auch die Handmarke ab, selbst wenn die Lage gleich ist.
    if not restored and _unchanged(wo, plates, resolved):
        return load_layout(db, wo)
    for i, (plate, items) in enumerate(zip(plates, resolved), 1):
        problem = check_plate(_window(wo, plate["fmt"]), items, 1)["issues"] + _host_issues(items)
        if problem:
            raise LayoutError(f"Platte {i}: {problem[0]}")
    _refuse_oversize(db, wo, plates)

    # Bis hierher ist nichts geschrieben: die Prüfung darf dauern, ohne die Anwendung
    # zu sperren. Der erste Schreibbefehl entscheidet, und SQLite reiht ihn ein: wer
    # nach dem Gewinner oder nach einer Bereitstellung kommt, trifft keine Zeile mehr.
    rev = wo.layout_rev or 0
    start_version = version_of(wo)
    moved = _moved(wo, resolved)
    before = {"plates": wo.n_plates, "utilisation": wo.utilisation}
    claimed = (db.query(WorkOrder)
                 .filter(WorkOrder.id == wo.id, func.coalesce(WorkOrder.layout_rev, 0) == rev,
                         WorkOrder.status == WorkOrderStatus.open, WorkOrder.material_staged_at.is_(None))
                 .update({WorkOrder.layout_rev: rev + 1}, synchronize_session=False))
    if not claimed:
        db.rollback()
        raise LayoutError(_STALE, 409)
    # Eine Platte kann gemeldet werden, ohne dass der Auftrag sich rührt.
    if db.query(WorkPlate.id).filter(WorkPlate.work_order_id == wo.id,
                                     WorkPlate.status != WorkOrderStatus.open).first():
        db.rollback()
        raise LayoutError(_FROZEN, 409)
    db.expire(wo, ["layout_rev"])

    if wo.auto_layout is None and not restored:
        wo.auto_layout = _snapshot(wo)
    rows = sorted(wo.plates, key=lambda p: p.idx)
    used = plate_area = 0.0
    for idx, (plate, items) in enumerate(zip(plates, resolved)):
        window = _window(wo, plate["fmt"])
        turned = bool(plate.get("turned"))
        metrics = plate_metrics(window, items, turned)
        nested = in_hole_of(items)
        placements = [{**i, "from_remnant": i["tag"] in nested} for i in items]
        if idx < len(rows):
            row = rows[idx]
        else:
            row = WorkPlate(work_order_id=wo.id, idx=idx, status=WorkOrderStatus.open)
            db.add(row)
            db.flush()
        row.fmt, row.turned = [window.w, window.h], turned
        row.used_h, row.utilisation = metrics["used_h"], round(metrics["utilisation"], 6)
        row.n_parts, row.placements = len(placements), placements
        for flag in (True, False):
            tags = [p["tag"] for p in placements if p["from_remnant"] is flag]
            if tags:
                (db.query(WorkItem).filter(WorkItem.work_order_id == wo.id, WorkItem.tag.in_(tags))
                   .update({WorkItem.plate_id: row.id, WorkItem.from_remnant: flag},
                           synchronize_session=False))
        used += metrics["used_area_m2"]
        plate_area += metrics["plate_area_m2"]
    for row in rows[len(plates):]:
        # Die Teile sind schon umgehängt. Eine geladene alte Liste nähme sie sonst
        # über die Kaskade mit, und der Innenauftrag verlöre Marken.
        db.expire(row, ["items"])
        db.delete(row)

    delta = len(plates) - wo.n_plates
    product = db.get(Product, wo.mat)
    if delta and product is not None:
        move_stock(db, product, -delta, reason="layout", actor=actor, work_order_no=wo.no,
                   note=f"{wo.no} von Hand auf {len(plates)} Platten gelegt")
    counts: dict[tuple, int] = {}
    for plate in plates:
        key = (float(plate["fmt"][0]), float(plate["fmt"][1]))
        counts[key] = counts.get(key, 0) + 1
    wo.n_plates = len(plates)
    wo.fmt = [float(plates[0]["fmt"][0]), float(plates[0]["fmt"][1])]
    wo.formats = [[w, h, n] for (w, h), n in sorted(counts.items())]
    wo.used_area_m2, wo.plate_area_m2 = round(used, 6), round(plate_area, 6)
    wo.utilisation = round(used / plate_area, 6) if plate_area else 0.0
    wo.layout_edited_at = None if restored else datetime.now(timezone.utc)
    wo.layout_edited_by = "" if restored else actor
    if restored:
        wo.auto_layout = None
    db.flush()
    db.expire(wo, ["plates"])
    _replan(db, wo)
    db.add(AuditLog(actor=actor, action="layout_reset" if restored else "layout_edit",
                    entity="work_order", entity_id=wo.no,
                    detail={"before": before, "plates": wo.n_plates, "utilisation": wo.utilisation,
                            "from": start_version, "to": version_of(wo),
                            "moved": moved[:_MAX_MOVED_IN_AUDIT], "n_moved": len(moved)}))
    db.commit()
    db.refresh(wo)
    try:
        from .worklist import reconcile
        reconcile(db, who=actor)
    except Exception:
        pass  # Der 30-Sekunden-Takt gleicht Aufgaben ohnehin nach.
    return load_layout(db, wo)


def reset_layout(db: Session, wo: WorkOrder, version: str, actor: str) -> dict:
    if wo.auto_layout is None:
        raise LayoutError("Diese Belegung ist nicht von Hand geändert.", 409)
    return save_layout(db, wo, wo.auto_layout["plates"], version, actor, restored=True)


def auto_layout(db: Session, wo: WorkOrder) -> dict:
    """Ein neuer Vorschlag für dieselben Teile. Speichert nichts: er landet im Editor
    und geht beim Speichern durch dieselbe Prüfung wie jede Handarbeit.

    Spiegeln: der Browser bringt nur Marke, Lage und Drehung, das Spiegelbild bleibt
    beim gespeicherten Teil. Ein Vorschlag ist deshalb nie gespiegelt (``_fixed_options``),
    und für einen gespiegelten Bestand gibt es keinen: stillschweigend zurückzuspiegeln
    hieße, ein Teil verkehrt herum zu schneiden, sein Spiegelbild zu behalten hieße,
    eine Lage zu speichern, die für die andere Kontur gerechnet wurde."""
    reason = blocked_reason(wo)
    if reason:
        raise LayoutError(reason, 409)
    if any(p.get("mirror") for p in _stored(wo).values()):
        raise LayoutError("Diese Belegung enthält gespiegelte Teile: dafür gibt es keinen Vorschlag.", 409)
    if not _auto_lock.acquire(blocking=False):
        raise LayoutError("Es rechnet schon ein Vorschlag.", 409)
    try:
        # Nicht neben einem Sammellauf: beide rechnen im selben Prozess, und ein Lauf
        # kann den Innenauftrag gerade neu ordnen.
        if not _run_lock.acquire(blocking=False):
            raise LayoutError("Es läuft gerade ein Sammellauf. Bitte gleich noch einmal.", 409)
        try:
            return _propose(db, wo)
        finally:
            _run_lock.release()
    except RenestError as e:
        raise LayoutError(e.detail) from e
    finally:
        _auto_lock.release()


def _propose(db: Session, wo: WorkOrder) -> dict:
    by_position: dict[int, list[str]] = {}
    for tag, p in _stored(wo).items():
        by_position.setdefault(int(p["position_id"]), []).append(tag)
    rows = (db.query(OrderPosition, Order).join(Order, OrderPosition.order_id == Order.id)
              .filter(OrderPosition.id.in_(by_position)).all())
    # Der Innenauftrag hat eine Vorgabe; alle seine Teile tragen sie, sonst zerfiele er.
    parts = [_batch_part(pos, order, wo.route_scope or "") for pos, order in rows]
    groups, _ = plan_batch(parts, load_products(db), load_rates(db), policy_for=policy_resolver(db),
                           options_for=_fixed_options(db, wo), force=True, mixed_formats=True,
                           now=datetime.now(timezone.utc), engine="kerf")
    plates = []
    for plate in (pl for g in groups for pl in g.plates):
        placed = []
        for item in plate.placements:
            tags = by_position.get(int(item["position_id"])) or []
            if not tags:
                raise RenestError("Der Vorschlag passt nicht zu den Teilen des Innenauftrags.")
            tag = tags.pop()
            placed.append({"tag": tag, "cx": item["cx"], "cy": item["cy"], "rot": float(item.get("rot") or 0)})
        plates.append({"fmt": [float(plate.fmt[0]), float(plate.fmt[1])], "turned": bool(plate.turned),
                       "placements": placed})
    if any(by_position.values()):
        raise LayoutError("Der Vorschlag lässt Teile aus. Die Handlage bleibt.")
    return {"plates": plates}


def _fixed_options(db: Session, wo: WorkOrder):
    """Der Vorschlag rechnet mit den Maßen des Innenauftrags, nicht mit den heutigen,
    und immer mit Budget: im Editor wartet jemand, auch unter einem Lauf ohne Grenze."""
    base = options_resolver(db)(wo.mat, wo.thk)
    o = _options(wo)
    fixed = NestOptions(gap=o.get("gap"), margin=o.get("margin"), trim_w=o.get("trim_w") or 0.0,
                        trim_h=o.get("trim_h") or 0.0, max_ms=base.max_ms or STANDALONE_NEST_MS,
                        max_candidates=base.max_candidates, corner_max_dist=_corner_max(wo),
                        allow_mirror=False)
    return lambda _m, _t: fixed
