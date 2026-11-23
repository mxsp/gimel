"""Werkzeuge für den digitalen Zwilling (roadmap task 38 D–F, Owner 2026-11-08 „much more tools").

Lesen und Rechnen laufen durch ``_readonly``: was ein Dienst unterwegs anlegt,
wird nach dem Aufruf verworfen. Rechnungen auf einer Kopie („Was wäre wenn“)
schreiben nie; ihre Antwort sagt „Annahme“. Geschrieben wird nur durch
``move_station``, ``rotate_station``, ``save_twin_view`` und ``delete_twin_view`` —
alle zurücknehmbar über das Änderungsregister, damit sie auch im Live-Gespräch
erlaubt sind (``tools.live_write_ok``).

``show_in_view`` ändert nichts in Gimel: es gibt der Seite eine geprüfte
Anweisung („zeige Station 4“). Die Seite entscheidet selbst, was sie tut.

Koordinaten und Größen sind durchgehend Meter (wie ``FactoryFloor``).
"""

from __future__ import annotations

import math
from typing import Any

from gimel.core.layout import Layout, point_in_polygon
from gimel.models import (
    FactoryFloor,
    FactoryStation,
    TwinView,
    WorkOrder,
)

from .analysis_tools import _int_arg, _readonly
from .rollback import record
from .tools import (
    ALL,
    OFFICE,
    ToolContext,
    ToolError,
    ToolSpec,
    _limit,
    _need,
    _number,
    _schema,
    _station_snapshot,
    update_station,
)

Point = tuple[float, float]

MAX_VIEWS_PER_FLOOR = 24
VIEW_LIMIT_M = 5000.0
#: Aktionen, die ``show_in_view`` an die Seite geben darf. Alles andere lehnt der Server ab.
UI_ACTIONS = ("navigate", "select_station", "focus", "highlight", "set_floor",
              "set_view_mode", "clear_highlight")
#: Seiten, zu denen ``navigate`` führen darf (Portal-Routen, keine freie URL).
UI_ROUTES = (
    "/app", "/app/#/heute", "/app/#/auftraege", "/app/#/auftragserfassung",
    "/app/#/produktion", "/app/#/disposition", "/app/#/schachteln",
    "/app/#/lager", "/app/#/werkstoffe", "/app/#/versand", "/app/#/kunden",
    "/app/#/buchhaltung", "/app/#/arbeitsvorrat",
    "/app/#/optimierung", "/app/#/kommissionierung", "/app/#/roboter",
    "/twin/", "/studio/", "/lab",
    # Ältere englische Pfade bleiben erlaubt und werden im Portal abgebildet.
    "/app/orders", "/app/production", "/app/dispatch", "/app/nesting", "/app/inventory",
    "/app/shipping", "/app/customers", "/app/robots", "/app/factory", "/app/factory/twin",
    "/app/accounting", "/app/worklist",
)
VIEW_MODES = ("plan", "iso", "three", "walk")


# ---------------------------------------------------------------------------
# Geometrie
# ---------------------------------------------------------------------------
def _corners(s: FactoryStation) -> list[Point]:
    w, h = float(s.w or 0.0), float(s.h or 0.0)
    rot = math.radians(float(s.rotation or 0.0))
    c, si = math.cos(rot), math.sin(rot)
    x, y = float(s.x or 0.0), float(s.y or 0.0)
    return [(x + dx * c - dy * si, y + dx * si + dy * c)
            for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]


def _rect(x: float, y: float, w: float, h: float, rot_deg: float) -> list[Point]:
    rot = math.radians(rot_deg)
    c, si = math.cos(rot), math.sin(rot)
    return [(x + dx * c - dy * si, y + dx * si + dy * c)
            for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]


def _overlap(a: list[Point], b: list[Point], gap: float = 0.0) -> bool:
    """Trennachsensatz für zwei Vierecke; ``gap`` verlangt Abstand in Metern."""
    for poly in (a, b):
        for i in range(len(poly)):
            x1, y1 = poly[i]
            x2, y2 = poly[(i + 1) % len(poly)]
            nx, ny = y1 - y2, x2 - x1
            norm = math.hypot(nx, ny) or 1.0
            nx, ny = nx / norm, ny / norm
            pa = [p[0] * nx + p[1] * ny for p in a]
            pb = [p[0] * nx + p[1] * ny for p in b]
            if max(pa) + gap <= min(pb) or max(pb) + gap <= min(pa):
                return False
    return True


def _floor_of(db, s: FactoryStation) -> int | None:
    if s.floor_id:
        return int(s.floor_id)
    row = db.query(FactoryFloor.id).order_by(FactoryFloor.id.asc()).first()
    return int(row[0]) if row else None


def _floor(ctx: ToolContext, args: dict) -> FactoryFloor:
    raw = args.get("floor_id")
    if raw in (None, ""):
        view = (ctx.context or {}).get("view") if ctx.context else None
        raw = view.get("floor_id") if isinstance(view, dict) else None
    row = ctx.db.get(FactoryFloor, int(raw)) if raw not in (None, "") else None
    if row is None:
        row = ctx.db.query(FactoryFloor).order_by(FactoryFloor.id.asc()).first()
    if row is None:
        raise ToolError("Keine Halle erfasst.")
    return row


def _stations_on(ctx: ToolContext, floor_id: int, *, active_only: bool = True) -> list[FactoryStation]:
    rows = ctx.db.query(FactoryStation).order_by(FactoryStation.id).all()
    return [s for s in rows if _floor_of(ctx.db, s) == floor_id and (s.active or not active_only)]


def _station(ctx: ToolContext, args: dict, key: str = "station_id") -> FactoryStation:
    sid = _int_arg(args, key)
    row = ctx.db.get(FactoryStation, sid)
    if row is None:
        raise ToolError("Station nicht gefunden.")
    return row


def _small(s: FactoryStation) -> dict:
    return {"id": s.id, "label": s.label, "type": getattr(s.type, "value", s.type),
            "x": round(float(s.x or 0), 2), "y": round(float(s.y or 0), 2),
            "w": round(float(s.w or 0), 2), "h": round(float(s.h or 0), 2),
            "rotation": round(float(s.rotation or 0), 1),
            "machine_kind": s.machine_kind or ""}


def _collisions(stations: list[FactoryStation], gap: float = 0.0) -> list[dict]:
    out = []
    for i, a in enumerate(stations):
        ca = _corners(a)
        for b in stations[i + 1:]:
            if _overlap(ca, _corners(b), gap):
                out.append({"a": a.id, "a_label": a.label, "b": b.id, "b_label": b.label})
    return out


def _outline_issue(layout: Layout, poly: list[Point]) -> str | None:
    if len(layout.outline) < 3:
        return None
    outside = [p for p in poly if not point_in_polygon(p, layout.outline)]
    if outside:
        return "Die Station ragt über den Hallenumriss hinaus."
    return None


# ---------------------------------------------------------------------------
# Lesen
# ---------------------------------------------------------------------------
def get_floor_layout(ctx: ToolContext, args: dict) -> dict:
    row = _floor(ctx, args)
    layout = Layout.from_row(row)
    stations = _stations_on(ctx, row.id)
    coll = _collisions(stations)
    xs = [p[0] for p in layout.outline] or [0.0]
    ys = [p[1] for p in layout.outline] or [0.0]
    aisles = row.aisles or {}
    data = {
        "floor": {"id": row.id, "name": row.name, "level": row.level,
                  "level_name": row.level_name, "hall_id": row.hall_id},
        "outline": [[round(x, 2), round(y, 2)] for x, y in layout.outline],
        "bounds_m": {"min_x": round(min(xs), 2), "max_x": round(max(xs), 2),
                     "min_y": round(min(ys), 2), "max_y": round(max(ys), 2)},
        "area_m2": round(layout.area_m2, 1),
        "stations": [_small(s) for s in stations],
        "station_area_m2": round(sum(float(s.w or 0) * float(s.h or 0) for s in stations), 1),
        "zones": [{"name": z.get("name"), "kind": z.get("kind")} for z in (row.zones or [])][:30],
        "obstacles": len(row.obstacles or []),
        "doors": [{"name": d.get("name"), "x": d.get("x"), "y": d.get("y"),
                   "width": d.get("width"), "kind": d.get("kind")} for d in (row.doors or [])][:30],
        "conveyors": len(row.conveyors or []),
        "aisle_nodes": len(aisles.get("nodes") or []),
        "aisle_edges": len(aisles.get("edges") or []),
        "collisions": coll,
    }
    free = max(0.0, layout.area_m2 - data["station_area_m2"])
    data["free_area_m2"] = round(free, 1)
    return {"summary": (f"Ebene {row.name or row.id}: {len(stations)} Station(en), "
                        f"{data['area_m2']} m², {len(coll)} Überlappung(en)."),
            "data": data}


def get_station_details(ctx: ToolContext, args: dict) -> dict:
    """Eine Station mit Last, Nachbarn, Befunden und Robotern — alles in einem Blick."""
    from gimel.services import robot_fleet, twin_analysis

    s = _station(ctx, args)
    fid = _floor_of(ctx.db, s)
    others = [o for o in _stations_on(ctx, fid) if o.id != s.id] if fid else []
    near = sorted(others, key=lambda o: math.hypot((o.x or 0) - (s.x or 0), (o.y or 0) - (s.y or 0)))[:4]
    result = twin_analysis.analyse(ctx.db)
    load = next((l for l in result.get("loads", []) if l.get("station_id") == s.id), None)
    findings = [f for f in result.get("findings", []) if s.id in (f.get("station_ids") or [])]
    jobs = (ctx.db.query(WorkOrder).filter(WorkOrder.station_id == s.id).limit(0).all())  # nur Typprüfung
    del jobs
    robots = []
    try:
        robots = [{"id": r.id, "name": r.name} for r in robot_fleet.of_station(ctx.db, s.id)]
    except Exception:  # noqa: BLE001 — ohne Roboter bleibt die Liste leer
        robots = []
    return {
        "summary": f"Station {s.label}: " + (f"{load['state']}, {load['jobs']} Auftrag/Aufträge." if load
                                              else "keine Fertigungslast."),
        "data": {"station": {**_station_snapshot(s), "id": s.id},
                 "load": load, "findings": findings[:8],
                 "neighbours": [{**_small(o), "distance_m": round(
                     math.hypot((o.x or 0) - (s.x or 0), (o.y or 0) - (s.y or 0)), 2)} for o in near],
                 "robots": robots},
    }


def get_nearby_stations(ctx: ToolContext, args: dict) -> dict:
    row = _floor(ctx, args)
    x, y = _number(args.get("x")), _number(args.get("y"))
    if x is None or y is None:
        view = (ctx.context or {}).get("view") if ctx.context else None
        if isinstance(view, dict):
            # Flache Schlüssel aus viewerProbe (page_context.sanitize lässt nur Skalare durch)
            x, y = _number(view.get("standpunkt_x")), _number(view.get("standpunkt_y"))
            if x is None or y is None:
                pose = view.get("standpunkt")
                if isinstance(pose, dict):
                    x, y = _number(pose.get("x")), _number(pose.get("y"))
    if x is None or y is None:
        raise ToolError("x und y fehlen — und die Seite meldet keinen Standpunkt.")
    radius = max(0.5, min(float(_number(args.get("radius_m")) or 10.0), 200.0))
    rows = []
    for s in _stations_on(ctx, row.id):
        d = math.hypot((s.x or 0) - x, (s.y or 0) - y)
        if d <= radius:
            rows.append({**_small(s), "distance_m": round(d, 2)})
    rows.sort(key=lambda r: r["distance_m"])
    return {"summary": f"{len(rows)} Station(en) im Umkreis von {radius:g} m.",
            "data": {"floor_id": row.id, "x": x, "y": y, "stations": rows[:_limit(args.get("limit"), 15, 60)]}}


def find_free_spot(ctx: ToolContext, args: dict) -> dict:
    """Freie Fläche für ein Rechteck: Raster abtasten, nichts anlegen."""
    row = _floor(ctx, args)
    w = _number(args.get("width_m")) or 3.0
    h = _number(args.get("depth_m")) or 2.0
    if not (0.2 <= w <= 60 and 0.2 <= h <= 60):
        raise ToolError("Breite und Tiefe: 0,2 … 60 m.")
    gap = max(0.0, min(float(_number(args.get("gap_m")) or 1.0), 5.0))
    layout = Layout.from_row(row)
    stations = _stations_on(ctx, row.id)
    bodies = [_corners(s) for s in stations]
    obstacles = [o.points for o in layout.obstacles]
    if len(layout.outline) < 3:
        raise ToolError("Die Ebene hat keinen Hallenumriss.")
    xs = [p[0] for p in layout.outline]
    ys = [p[1] for p in layout.outline]
    near = None
    ax, ay = _number(args.get("near_x")), _number(args.get("near_y"))
    if ax is not None and ay is not None:
        near = (ax, ay)
    step = max(0.5, min(w, h) / 2)
    best: tuple[float, float, float] | None = None
    y = min(ys) + h / 2
    while y <= max(ys) - h / 2:
        x = min(xs) + w / 2
        while x <= max(xs) - w / 2:
            poly = _rect(x, y, w, h, 0.0)
            if (all(point_in_polygon(p, layout.outline) for p in poly)
                    and not any(_overlap(poly, b, gap) for b in bodies)
                    and not any(_overlap(poly, list(o), 0.0) for o in obstacles)):
                score = math.dist((x, y), near) if near else (y * 1000 + x)
                if best is None or score < best[0]:
                    best = (score, x, y)
            x += step
        y += step
    if best is None:
        return {"summary": f"Kein freier Platz für {w:g} × {h:g} m mit {gap:g} m Abstand.",
                "data": {"found": False, "floor_id": row.id}}
    _, bx, by = best
    return {"summary": f"Freier Platz bei {bx:.1f} m / {by:.1f} m (Annahme: Rasterabtastung, {gap:g} m Abstand).",
            "data": {"found": True, "floor_id": row.id, "x": round(bx, 2), "y": round(by, 2),
                     "width_m": w, "depth_m": h, "gap_m": gap}}


def find_route(ctx: ToolContext, args: dict) -> dict:
    from gimel.services import robot_ways

    try:
        if args.get("from_station_id") and args.get("to_station_id"):
            way = robot_ways.plan_between_stations(
                ctx.db, _int_arg(args, "from_station_id"), _int_arg(args, "to_station_id"))
        else:
            row = _floor(ctx, args)
            pts = [_number(args.get(k)) for k in ("from_x", "from_y", "to_x", "to_y")]
            if any(p is None for p in pts):
                raise ToolError("Entweder zwei Stationen oder from_x/from_y/to_x/to_y angeben.")
            way = robot_ways.plan_between_points(ctx.db, row.id, (pts[0], pts[1]), (pts[2], pts[3]))
    except (robot_ways.WayError, ValueError, LookupError) as exc:
        raise ToolError(str(exc)) from exc
    route = way.pop("route", [])
    return {"summary": (f"Weg {way['route_m']:.1f} m ({way.get('route_note', '')})."),
            "data": {**way, "waypoints": len(route), "route": route[:40]}}


def get_twin_findings(ctx: ToolContext, args: dict) -> dict:
    from gimel.services import twin_analysis

    result = twin_analysis.analyse(ctx.db)
    items = result.get("findings", [])
    kind = str(args.get("kind") or "").strip()
    sev = str(args.get("severity") or "").strip()
    sid = args.get("station_id")
    if kind:
        items = [f for f in items if f.get("kind") == kind]
    if sev:
        items = [f for f in items if f.get("severity") == sev]
    if sid not in (None, ""):
        items = [f for f in items if int(sid) in (f.get("station_ids") or [])]
    cut = _limit(args.get("limit"), 15, 60)
    return {"summary": f"{len(items)} Befund(e)" + (f", {cut} gezeigt." if len(items) > cut else "."),
            "data": {"findings": items[:cut], "total": len(items), "summary": result.get("summary")}}


def rank_stations_for(ctx: ToolContext, args: dict) -> dict:
    from gimel.services import factory_router as fr

    no = str(_need(args, "work_order_no")).strip()
    wo = ctx.db.query(WorkOrder).filter(WorkOrder.no == no).first()
    if wo is None:
        raise ToolError(f"Innenauftrag {no} nicht gefunden.")
    ranking = fr.rank_for_work_order(ctx.db, wo)
    rows = [{"station_id": a.station_id, "label": a.label, "eligible": a.eligible,
             "score": round(a.score, 2), "minutes": round(a.minutes, 1),
             "completion_min": None if a.completion_min is None else round(a.completion_min, 1),
             "route_m": round(a.route_m, 1), "reason": a.summary}
            for a in ranking[:_limit(args.get("limit"), 6, 20)]]
    return {"summary": f"Rangliste für {no}: {len(ranking)} Station(en) bewertet, nichts zugewiesen.",
            "data": {"work_order_no": no, "ranking": rows, "total": len(ranking)}}


def get_robot(ctx: ToolContext, args: dict) -> dict:
    from gimel.services import robot_fleet

    rid = _int_arg(args, "robot_id")
    snap = robot_fleet.snapshot(ctx.db)
    robot = next((r for r in snap["robots"] if r.get("id") == rid), None)
    if robot is None:
        raise ToolError("Roboter nicht gefunden.")
    route = robot.get("route") or []
    out = {k: v for k, v in robot.items() if k != "route"}
    out["route_points"] = len(route)
    out["route"] = route[:30]
    return {"summary": f"Roboter {robot.get('name') or rid}: {robot.get('state', 'unbekannt')}.", "data": out}


def check_robot_traffic(ctx: ToolContext, args: dict) -> dict:
    from gimel.services import robot_fleet

    row = _floor(ctx, args)
    snap = robot_fleet.snapshot(ctx.db, floor_id=row.id)
    robots = snap["robots"]
    pairs = []
    for i, a in enumerate(robots):
        pa = a.get("position") or a.get("pose") or {}
        for b in robots[i + 1:]:
            pb = b.get("position") or b.get("pose") or {}
            try:
                d = math.hypot(float(pa["x"]) - float(pb["x"]), float(pa["y"]) - float(pb["y"]))
            except (KeyError, TypeError, ValueError):
                continue
            pairs.append({"a": a.get("name") or a.get("id"), "b": b.get("name") or b.get("id"),
                          "gap_m": round(d, 2)})
    pairs.sort(key=lambda p: p["gap_m"])
    close = [p for p in pairs if p["gap_m"] < 2.0]
    return {"summary": (f"{len(robots)} Roboter auf der Ebene; kleinster Abstand "
                        f"{pairs[0]['gap_m']} m." if pairs else f"{len(robots)} Roboter auf der Ebene."),
            "data": {"floor_id": row.id, "robots": len(robots), "closest_pairs": pairs[:6],
                     "closer_than_2m": close[:6], "note": "Augenblickswerte, keine Vorhersage."}}


def list_twin_views(ctx: ToolContext, args: dict) -> dict:
    row = _floor(ctx, args)
    rows = (ctx.db.query(TwinView).filter(TwinView.floor_id == row.id)
            .order_by(TwinView.name, TwinView.id).all())
    return {"summary": f"{len(rows)} gespeicherte Ansicht(en) auf {row.name or row.id}.",
            "data": {"floor_id": row.id, "views": [
                {"id": v.id, "name": v.name, "camera": v.camera, "created_by": v.created_by}
                for v in rows]}}


def measure_between(ctx: ToolContext, args: dict) -> dict:
    a = _station(ctx, args, "from_station_id")
    b = _station(ctx, args, "to_station_id")
    straight = math.hypot((a.x or 0) - (b.x or 0), (a.y or 0) - (b.y or 0))
    same = _floor_of(ctx.db, a) == _floor_of(ctx.db, b)
    return {"summary": (f"Luftlinie {a.label} ↔ {b.label}: {straight:.1f} m"
                        + ("" if same else " (verschiedene Ebenen, Höhenunterschied nicht eingerechnet)") + "."),
            "data": {"from": _small(a), "to": _small(b), "straight_m": round(straight, 2),
                     "same_floor": same}}


# ---------------------------------------------------------------------------
# Was wäre wenn — auf einer Kopie, nichts wird geschrieben
# ---------------------------------------------------------------------------
def whatif_move_station(ctx: ToolContext, args: dict) -> dict:
    s = _station(ctx, args)
    x = _number(args.get("x"))
    y = _number(args.get("y"))
    rot = _number(args.get("rotation"))
    nx = s.x if x is None else x
    ny = s.y if y is None else y
    nrot = s.rotation if rot is None else rot
    fid = _floor_of(ctx.db, s)
    row = ctx.db.get(FactoryFloor, fid) if fid else None
    layout = Layout.from_row(row) if row else Layout()
    poly = _rect(nx, ny, float(s.w or 0), float(s.h or 0), float(nrot or 0))
    hits = [o for o in _stations_on(ctx, fid) if o.id != s.id and _overlap(poly, _corners(o))] if fid else []
    issue = _outline_issue(layout, poly)
    storage = [o for o in _stations_on(ctx, fid) if o.is_storage and o.id != s.id] if fid else []
    dist = []
    for o in storage[:5]:
        before = math.hypot((s.x or 0) - (o.x or 0), (s.y or 0) - (o.y or 0))
        after = math.hypot(nx - (o.x or 0), ny - (o.y or 0))
        dist.append({"storage": o.label, "before_m": round(before, 1), "after_m": round(after, 1),
                     "delta_m": round(after - before, 1)})
    ok = not hits and issue is None
    return {"summary": ("Annahme: Verschieben geht." if ok else
                        "Annahme: Verschieben geht nicht — " + (issue or f"überlappt {', '.join(h.label for h in hits)}.")),
            "data": {"assumption": True, "station": s.label, "from": {"x": s.x, "y": s.y, "rotation": s.rotation},
                     "to": {"x": nx, "y": ny, "rotation": nrot}, "possible": ok,
                     "overlaps": [h.label for h in hits], "outline_issue": issue,
                     "distance_to_storage": dist, "note": "Luftlinie; nichts wurde gespeichert."}}


def whatif_station_down(ctx: ToolContext, args: dict) -> dict:
    """Station fällt aus: wohin ihre Aufträge gehen würden (beste andere Station je Auftrag)."""
    from gimel.models import WorkOrderStatus
    from gimel.services import factory_router as fr

    s = _station(ctx, args)
    hours = max(0.5, min(float(_number(args.get("hours")) or 8.0), 24 * 30))
    open_states = [st for st in (getattr(WorkOrderStatus, n, None) for n in ("open", "planned", "queued", "in_progress"))
                   if st is not None]
    q = ctx.db.query(WorkOrder).filter(WorkOrder.station_id == s.id)
    if open_states:
        q = q.filter(WorkOrder.status.in_(open_states))
    jobs = q.order_by(WorkOrder.id).limit(12).all()
    moves = []
    for wo in jobs:
        ranking = [a for a in fr.rank_for_work_order(ctx.db, wo) if a.eligible and a.station_id != s.id]
        best = ranking[0] if ranking else None
        moves.append({"work_order": wo.no, "to": None if best is None else best.label,
                      "minutes": None if best is None else round(best.minutes, 1),
                      "completion_min": None if best is None or best.completion_min is None
                      else round(best.completion_min, 1)})
    stuck = [m["work_order"] for m in moves if m["to"] is None]
    return {"summary": (f"Annahme: {s.label} {hours:g} h aus — {len(jobs)} offene(r) Auftrag/Aufträge, "
                        f"{len(stuck)} ohne Ausweichstation."),
            "data": {"assumption": True, "station": s.label, "hours": hours, "jobs": moves,
                     "without_alternative": stuck, "note": "Rangliste der Disposition; nichts wurde zugewiesen."}}


def size_fleet(ctx: ToolContext, args: dict) -> dict:
    """Roboterzahl 1..N durchrechnen (Annahme). Nutzt dieselbe Simulation wie ``simulate_fleet``."""
    from .analysis_tools import simulate_fleet

    top = max(1, min(int(_number(args.get("max_robots")) or 4), 6))
    rows = []
    for n in range(1, top + 1):
        try:
            res = simulate_fleet(ctx, {**{k: v for k, v in args.items() if k != "max_robots"}, "robots": n})
        except ToolError as exc:
            raise ToolError(str(exc)) from exc
        data = res.get("data", {})
        rows.append({"robots": n, "summary": res.get("summary"),
                     "recommended": data.get("recommended") or data.get("recommended_fleet")})
    return {"summary": f"Flotte 1 bis {top} Roboter durchgerechnet (Annahme).", "data": {"assumption": True, "runs": rows}}


# ---------------------------------------------------------------------------
# Schreiben — zurücknehmbar
# ---------------------------------------------------------------------------
def move_station(ctx: ToolContext, args: dict) -> dict:
    """Station verschieben; lehnt Überlappung und Lage außerhalb der Halle ab."""
    s = _station(ctx, args)
    x, y = _number(args.get("x")), _number(args.get("y"))
    if x is None or y is None:
        raise ToolError("x und y (Meter) fehlen.")
    check = whatif_move_station(ctx, {"station_id": s.id, "x": x, "y": y, "rotation": args.get("rotation")})
    data = check["data"]
    if not data["possible"]:
        raise ToolError(check["summary"].replace("Annahme: ", ""))
    out = update_station(ctx, {"station_id": s.id, "x": x, "y": y,
                               **({"rotation": args["rotation"]} if args.get("rotation") is not None else {})})
    out["summary"] = f"Station {s.label} nach {x:.1f} m / {y:.1f} m verschoben."
    return out


def rotate_station(ctx: ToolContext, args: dict) -> dict:
    s = _station(ctx, args)
    deg = _number(args.get("degrees"))
    absolute = _number(args.get("rotation"))
    if deg is None and absolute is None:
        raise ToolError("degrees (relativ) oder rotation (absolut) fehlt.")
    target = (absolute if absolute is not None else float(s.rotation or 0) + deg) % 360
    check = whatif_move_station(ctx, {"station_id": s.id, "rotation": target})
    if not check["data"]["possible"]:
        raise ToolError(check["summary"].replace("Annahme: ", ""))
    out = update_station(ctx, {"station_id": s.id, "rotation": target})
    out["summary"] = f"Station {s.label} auf {target:g}° gedreht."
    return out


def save_twin_view(ctx: ToolContext, args: dict) -> dict:
    row = _floor(ctx, args)
    name = str(_need(args, "name")).strip()[:80]
    if not name:
        raise ToolError("Name fehlt.")
    cam = args.get("camera") if isinstance(args.get("camera"), dict) else {}
    pos, tgt = cam.get("position"), cam.get("target")
    if not (isinstance(pos, list) and isinstance(tgt, list) and len(pos) == 3 and len(tgt) == 3):
        view = (ctx.context or {}).get("view") if ctx.context else None
        if isinstance(view, dict):
            cam_ctx = view.get("kamera")
            if isinstance(cam_ctx, dict):
                pos, tgt = cam_ctx.get("position"), cam_ctx.get("target")
            else:
                sx, sy = _number(view.get("standpunkt_x")), _number(view.get("standpunkt_y"))
                if sx is not None and sy is not None:
                    pos = [sx, 1.7, sy]
                    ang = math.radians(float(_number(view.get("blick_richtung")) or 0.0))
                    tgt = [sx + math.sin(ang) * 5.0, 1.5, sy + math.cos(ang) * 5.0]
    if not (isinstance(pos, list) and isinstance(tgt, list) and len(pos) == 3 and len(tgt) == 3):
        raise ToolError("camera.position und camera.target (je [x, y, z]) fehlen, und die Seite meldet keine Kamera.")
    try:
        pos = [float(v) for v in pos]
        tgt = [float(v) for v in tgt]
    except (TypeError, ValueError) as exc:
        raise ToolError("Kamerawerte müssen Zahlen sein.") from exc
    if any(not math.isfinite(v) or abs(v) > VIEW_LIMIT_M for v in (*pos, *tgt)):
        raise ToolError("Kamera außerhalb des Bereichs.")
    if ctx.db.query(TwinView).filter(TwinView.floor_id == row.id).count() >= MAX_VIEWS_PER_FLOOR:
        raise ToolError(f"Höchstens {MAX_VIEWS_PER_FLOOR} Ansichten je Ebene.")
    mode = str(cam.get("mode") or "orbit")
    kind = str(cam.get("view") or "three")
    if mode not in ("orbit", "walk") or kind not in ("three", "iso", "2d"):
        raise ToolError("mode: orbit|walk, view: three|iso|2d.")
    view = TwinView(floor_id=row.id, name=name,
                    camera={"position": pos, "target": tgt, "mode": mode, "view": kind},
                    created_by=ctx.user.email, created_by_id=ctx.user.id)
    ctx.db.add(view)
    ctx.db.flush()
    change = record(
        ctx.db, chat=ctx.chat, message_id=ctx.message_id, user=ctx.user,
        tool="save_twin_view", action="twin_view_create", entity="twin_view",
        entity_id=str(view.id), before=None, after={"_created": True, "_pk": view.id, "name": name},
        summary=f"Ansicht „{name}“ gespeichert")
    return {"summary": f"Ansicht „{name}“ auf {row.name or row.id} gespeichert.",
            "data": {"id": view.id, "name": name}, "change": change}


# ---------------------------------------------------------------------------
# Die Seite steuern
# ---------------------------------------------------------------------------
def show_in_view(ctx: ToolContext, args: dict) -> dict:
    """Geprüfte Anweisung an die Seite. Ändert nichts in Gimel."""
    action = str(_need(args, "action")).strip()
    if action not in UI_ACTIONS:
        raise ToolError(f"Unbekannte Aktion. Erlaubt: {', '.join(UI_ACTIONS)}.")
    out: dict[str, Any] = {"type": action}
    note = ""
    if action == "navigate":
        route = str(args.get("route") or "").split("?")[0].rstrip("/") or "/app"
        if route not in UI_ROUTES:
            raise ToolError(f"Unbekannte Seite. Erlaubt: {', '.join(UI_ROUTES)}.")
        out["route"] = route
        note = f"Seite {route}"
    elif action in ("select_station", "focus"):
        if args.get("station_id") not in (None, ""):
            s = _station(ctx, args)
            out.update(station_id=s.id, label=s.label)
            note = f"Station {s.label}"
        else:
            x, y = _number(args.get("x")), _number(args.get("y"))
            if action == "select_station" or x is None or y is None:
                raise ToolError("station_id fehlt" + ("." if action == "select_station" else " (oder x und y)."))
            out.update(x=x, y=y)
            note = f"Punkt {x:.1f} m / {y:.1f} m"
    elif action == "highlight":
        ids = args.get("station_ids")
        if not isinstance(ids, list) or not ids or len(ids) > 40:
            raise ToolError("station_ids: 1 bis 40 Nummern.")
        rows = [ctx.db.get(FactoryStation, int(i)) for i in ids]
        if any(r is None for r in rows):
            raise ToolError("Unbekannte Station in station_ids.")
        out["station_ids"] = [r.id for r in rows]
        out["labels"] = [r.label for r in rows][:12]
        note = f"{len(rows)} Station(en) hervorgehoben"
    elif action == "set_floor":
        row = ctx.db.get(FactoryFloor, _int_arg(args, "floor_id"))
        if row is None:
            raise ToolError("Ebene nicht gefunden.")
        out.update(floor_id=row.id, label=row.name)
        note = f"Ebene {row.name or row.id}"
    elif action == "set_view_mode":
        mode = str(args.get("mode") or "")
        if mode not in VIEW_MODES:
            raise ToolError(f"mode: {', '.join(VIEW_MODES)}.")
        out["mode"] = mode
        note = f"Ansicht {mode}"
    elif action == "clear_highlight":
        note = "Hervorhebung entfernt"
    return {"summary": f"Ansicht: {note}.", "data": {"requested": out}, "client_action": out}


_S = _schema

TWIN_SPECS = [
    ToolSpec("get_floor_layout",
             "Layout of one floor in metres: outline, bounds, stations (position, size, rotation), zones, doors, aisles, free area and station overlaps. floor_id defaults to the floor on screen.",
             _S({"floor_id": {"type": "integer"}}), _readonly(get_floor_layout)),
    ToolSpec("get_station_details",
             "One station in depth: machine values, load and state, findings that name it, nearest neighbours with distance and robots assigned. Prefer this over get_station_view.",
             _S({"station_id": {"type": "integer"}}, ["station_id"]), _readonly(get_station_details)),
    ToolSpec("get_nearby_stations",
             "Stations within a radius of a point (default: where the user stands in the 3D view), nearest first.",
             _S({"x": {"type": "number"}, "y": {"type": "number"}, "radius_m": {"type": "number"},
                 "floor_id": {"type": "integer"}, "limit": {"type": "integer"}}),
             _readonly(get_nearby_stations)),
    ToolSpec("find_free_spot",
             "Find a free rectangle on a floor (inside the outline, clear of stations and obstacles, with a gap). Reads only; use move_station or create_station to act on it.",
             _S({"width_m": {"type": "number"}, "depth_m": {"type": "number"}, "gap_m": {"type": "number"},
                 "near_x": {"type": "number"}, "near_y": {"type": "number"}, "floor_id": {"type": "integer"}}),
             _readonly(find_free_spot)),
    ToolSpec("find_route",
             "Route in metres between two stations (same floor) or two points, along the aisles and around machines.",
             _S({"from_station_id": {"type": "integer"}, "to_station_id": {"type": "integer"},
                 "from_x": {"type": "number"}, "from_y": {"type": "number"},
                 "to_x": {"type": "number"}, "to_y": {"type": "number"}, "floor_id": {"type": "integer"}}),
             _readonly(find_route)),
    ToolSpec("measure_between",
             "Straight-line distance in metres between two stations.",
             _S({"from_station_id": {"type": "integer"}, "to_station_id": {"type": "integer"}},
                ["from_station_id", "to_station_id"]), _readonly(measure_between)),
    ToolSpec("get_twin_findings",
             "Twin findings with the sentence, filtered by station, kind (capacity, changeover, transport, layout, dates, data) or severity.",
             _S({"station_id": {"type": "integer"}, "kind": {"type": "string"}, "severity": {"type": "string"},
                 "limit": {"type": "integer"}}), _readonly(get_twin_findings)),
    ToolSpec("rank_stations_for",
             "Rank the stations for one work order (score, minutes, completion, route, reason). Assigns nothing.",
             _S({"work_order_no": {"type": "string"}, "limit": {"type": "integer"}}, ["work_order_no"]),
             _readonly(rank_stations_for), roles=frozenset(OFFICE)),
    ToolSpec("get_robot",
             "One robot: pose, battery, state, active job and planned path.",
             _S({"robot_id": {"type": "integer"}}, ["robot_id"]), _readonly(get_robot)),
    ToolSpec("check_robot_traffic",
             "Robot gaps on a floor right now: closest pairs and pairs nearer than 2 m.",
             _S({"floor_id": {"type": "integer"}}), _readonly(check_robot_traffic)),
    ToolSpec("list_twin_views",
             "Saved camera views of a floor.",
             _S({"floor_id": {"type": "integer"}}), _readonly(list_twin_views)),
    ToolSpec("whatif_move_station",
             "What if a station stood at x/y (metres) with rotation? Overlaps, outline, change in distance to storage. Assumption only, nothing is saved.",
             _S({"station_id": {"type": "integer"}, "x": {"type": "number"}, "y": {"type": "number"},
                 "rotation": {"type": "number"}}, ["station_id"]), _readonly(whatif_move_station)),
    ToolSpec("whatif_station_down",
             "What if a station is out for N hours? Where each open work order would go (best other station). Assumption only.",
             _S({"station_id": {"type": "integer"}, "hours": {"type": "number"}}, ["station_id"]),
             _readonly(whatif_station_down), roles=frozenset(OFFICE)),
    ToolSpec("size_fleet",
             "Run the robot simulation for 1..max_robots planned robots (what-if) and compare. Same engine as simulate_fleet.",
             _S({"floor_id": {"type": "integer"}, "max_robots": {"type": "integer"},
                 "horizon_h": {"type": "number"}, "load_factor": {"type": "number"}}),
             _readonly(size_fleet), roles=frozenset(OFFICE)),
    ToolSpec("show_in_view",
             "Ask the page to show something: navigate (route), select_station, focus (station_id or x/y), highlight (station_ids), clear_highlight, set_floor (floor_id), set_view_mode (plan|iso|three|walk). Changes no data; the page decides what it can do.",
             _S({"action": {"type": "string"}, "route": {"type": "string"}, "station_id": {"type": "integer"},
                 "station_ids": {"type": "array", "items": {"type": "integer"}},
                 "x": {"type": "number"}, "y": {"type": "number"}, "floor_id": {"type": "integer"},
                 "mode": {"type": "string"}}, ["action"]),
             _readonly(show_in_view)),
    ToolSpec("move_station",
             "Move a station to x/y (metres), optionally rotate. Refuses overlaps and positions outside the hall. Reversible.",
             _S({"station_id": {"type": "integer"}, "x": {"type": "number"}, "y": {"type": "number"},
                 "rotation": {"type": "number"}}, ["station_id", "x", "y"]),
             move_station, write=True, admin_only=True),
    ToolSpec("rotate_station",
             "Rotate a station by degrees (relative) or to a rotation (absolute). Refuses overlaps. Reversible.",
             _S({"station_id": {"type": "integer"}, "degrees": {"type": "number"},
                 "rotation": {"type": "number"}}, ["station_id"]),
             rotate_station, write=True, admin_only=True),
    ToolSpec("save_twin_view",
             "Save a named camera view of a floor (position, target, mode, view; defaults to the camera on screen). Reversible.",
             _S({"name": {"type": "string"}, "floor_id": {"type": "integer"},
                 "camera": {"type": "object"}}, ["name"]),
             save_twin_view, write=True, roles=frozenset(OFFICE)),
]
