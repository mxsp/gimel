"""Bestehende Roboterwege verbessern — über das Gangnetz statt quer durch die Halle.

Rein und deterministisch. Eingabe ist ein gespeicherter Weg (Wegpunkte, die ein
Mensch gesetzt hat) und der Grundriss; Ausgabe ein Vorschlag mit Begründung.
Geschrieben wird hier nichts — ob der Vorschlag übernommen wird, entscheidet
der Admin (``routers/robots.py``).

Was der Verbesserer tut, in dieser Reihenfolge:

1. **Aufräumen:** ungültige und doppelte Punkte fallen weg.
2. **Einrasten:** ein Wegpunkt, der weniger als ``snap_m`` neben einem
   Gangknoten liegt, wird auf den Knoten gezogen. Anfang und Ende bleiben, wo
   sie sind — dort steht meist eine Station oder eine Ladestelle.
3. **Über die Gänge:** jeder Abschnitt zwischen zwei Wegpunkten wird über
   ``Layout.path`` gelegt. Gibt es keinen Weg über das Netz, bleibt der
   Abschnitt gerade und wird als Luftlinie gemeldet — nie ein erfundener Gang.
   Bei einem Rundkurs gilt das auch für den schließenden Abschnitt.
4. **Glätten:** Punkte mitten auf einer Geraden fallen weg; ein Hin-und-zurück
   (Stichweg zu einer Station) bleibt erhalten.

Die Prüfung vorher und nachher ist ``robot_way.route_problems`` — dieselbe,
die beim Speichern eines Weges gilt.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

import heapq

from .layout import Layout, Point, point_in_polygon, segment_blocked, segment_leaves_outline
from .robot_way import route_problems

SNAP_M = 0.75
#: Abstand, den ein Roboterweg zu Hindernissen und Stationskörpern hält (halbe
#: Fahrzeugbreite plus etwas Luft).
CLEARANCE_M = 0.45
#: Nur Körper in dieser Umgebung des Abschnitts kommen in die Umwegsuche.
SEARCH_MARGIN_M = 12.0


def _box(poly: Sequence[Point], pad: float) -> list[Point]:
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    x0, x1, y0, y1 = min(xs) - pad, max(xs) + pad, min(ys) - pad, max(ys) + pad
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def _clear(a: Point, b: Point, walls: Sequence[Sequence[Point]], outline: Sequence[Point]) -> bool:
    return not segment_blocked(a, b, walls) and not segment_leaves_outline(a, b, outline)


def _overlaps_box(poly: Sequence[Point], lo_x: float, hi_x: float, lo_y: float, hi_y: float) -> bool:
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return max(xs) >= lo_x and min(xs) <= hi_x and max(ys) >= lo_y and min(ys) <= hi_y


def detour(a: Point, b: Point, blockers: Sequence[Sequence[Point]], outline: Sequence[Point],
           *, pad: float = CLEARANCE_M) -> list[Point] | None:
    """Kürzester freier Weg a → b um die Körper herum (Sichtgraph über die
    Ecken der aufgeweiteten Körper). ``None``, wenn es keinen gibt."""
    lo_x, hi_x = min(a[0], b[0]) - SEARCH_MARGIN_M - pad, max(a[0], b[0]) + SEARCH_MARGIN_M + pad
    lo_y, hi_y = min(a[1], b[1]) - SEARCH_MARGIN_M - pad, max(a[1], b[1]) + SEARCH_MARGIN_M + pad
    near = [p for p in blockers if len(p) >= 3 and _overlaps_box(p, lo_x, hi_x, lo_y, hi_y)]
    walls = [_box(p, pad) for p in near]
    if _clear(a, b, walls, outline):
        return [a, b]
    corners: list[Point] = []
    for p in near:
        for c in _box(p, pad + 0.08):
            if len(outline) >= 3 and not point_in_polygon(c, outline):
                continue
            if any(point_in_polygon(c, w) for w in walls):
                continue
            corners.append(c)
    pts = [a, b] + corners
    n = len(pts)
    dist = [math.inf] * n
    prev = [-1] * n
    dist[0] = 0.0
    queue = [(0.0, 0)]
    done: set[int] = set()
    while queue:
        d, u = heapq.heappop(queue)
        if u in done:
            continue
        if u == 1:
            break
        done.add(u)
        for v in range(n):
            if v in done or v == u:
                continue
            w = math.dist(pts[u], pts[v])
            if d + w >= dist[v] or not _clear(pts[u], pts[v], walls, outline):
                continue
            dist[v] = d + w
            prev[v] = u
            heapq.heappush(queue, (dist[v], v))
    if not math.isfinite(dist[1]):
        return None
    chain = []
    k = 1
    while k != -1:
        chain.append(pts[k])
        k = prev[k]
    return list(reversed(chain))


def safe_leg(layout: Layout, a: Point, b: Point,
             bodies: Sequence[Sequence[Point]] = ()) -> tuple[list[Point], str]:
    """Ein Abschnitt a → b: über das Gangnetz, aber nie durch einen Körper.

    Körper sind die Hindernisse des Grundrisses und ``bodies`` (Stationen).
    Ein Körper, in dem a oder b selbst liegt (Station am Anfang oder Ende),
    zählt nicht. Rückgabe: Punkte und Art (``netz``, ``umweg``, ``luft``,
    ``blockiert``)."""
    obstacles = [o.points for o in layout.obstacles if len(o.points) >= 3]
    blockers = [p for p in list(obstacles) + [list(q) for q in bodies]
                if len(p) >= 3 and not point_in_polygon(a, p) and not point_in_polygon(b, p)]
    walls = [_box(p, CLEARANCE_M) for p in blockers]
    route = layout.aisles.path(a, b, obstacles, layout.outline) if layout.aisles.usable else None
    if route is not None and route.exact and len(route.points) >= 2:
        pts = [(float(x), float(y)) for x, y in route.points]
        out: list[Point] = [pts[0]]
        repaired = False
        for p, q in zip(pts, pts[1:]):
            if _clear(p, q, walls, layout.outline):
                out.append(q)
                continue
            around = detour(p, q, blockers, layout.outline)
            if around is None:
                return [a, b], "blockiert"
            out.extend(around[1:])
            repaired = True
        return out, ("umweg" if repaired else "netz")
    if _clear(a, b, walls, layout.outline):
        return [a, b], "luft"
    around = detour(a, b, blockers, layout.outline)
    return (around, "umweg") if around else ([a, b], "blockiert")


@dataclass
class Improvement:
    points: list[Point]
    changed: bool
    metres_before: float
    metres_after: float
    legs: int
    rerouted: int
    air_legs: int
    snapped: int
    problems_before: list[str] = field(default_factory=list)
    problems_after: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    detours: int = 0
    blocked: int = 0

    def as_dict(self) -> dict:
        return {
            "route": [[round(x, 3), round(y, 3)] for x, y in self.points],
            "changed": self.changed,
            "metres_before": round(self.metres_before, 2),
            "metres_after": round(self.metres_after, 2),
            "legs": self.legs,
            "rerouted": self.rerouted,
            "air_legs": self.air_legs,
            "snapped": self.snapped,
            "detours": self.detours,
            "blocked": self.blocked,
            "problems_before": self.problems_before,
            "problems_after": self.problems_after,
            "notes": self.notes,
        }


def _clean(points: Sequence[Sequence[float]]) -> list[Point]:
    out: list[Point] = []
    for p in points or []:
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            continue
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        if out and math.dist(out[-1], (x, y)) < 1e-6:
            continue
        out.append((x, y))
    return out


def length(points: Sequence[Point], loop: bool) -> float:
    total = sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))
    if loop and len(points) >= 2:
        total += math.dist(points[-1], points[0])
    return total


def simplify(points: Sequence[Point]) -> list[Point]:
    """Zwischenpunkte auf einer Geraden entfernen, Wendepunkte behalten.

    Anders als ``layout._simplify_polyline`` bleibt ein Punkt, an dem der Weg
    umkehrt: ein Stichweg zur Station und zurück ist Absicht."""
    out: list[Point] = []
    for p in points:
        if out and math.dist(out[-1], p) < 1e-6:
            continue
        while len(out) >= 2:
            a, b = out[-2], out[-1]
            abx, aby = b[0] - a[0], b[1] - a[1]
            bpx, bpy = p[0] - b[0], p[1] - b[1]
            cross = abx * bpy - aby * bpx
            dot = abx * bpx + aby * bpy
            if abs(cross) > 1e-6 * max(1.0, math.hypot(abx, aby)) or dot <= 0:
                break
            out.pop()
        out.append(p)
    return out


#: Ein Hin-und-zurück kürzer als das ist ein Rest des Einrastens, kein Stichweg.
SPIKE_M = 1.0


def _drop_spikes(points: list[Point]) -> list[Point]:
    """A → B → A mit kurzem |AB| entfernen (wiederholt, bis nichts mehr fällt)."""
    out = list(points)
    changed = True
    while changed and len(out) >= 3:
        changed = False
        for i in range(1, len(out) - 1):
            a, b, c = out[i - 1], out[i], out[i + 1]
            if math.dist(a, c) < 1e-6 and math.dist(a, b) < SPIKE_M:
                del out[i:i + 2]
                changed = True
                break
    return out


def _snap(p: Point, nodes: Sequence[Point], snap_m: float) -> tuple[Point, bool]:
    best, best_d = p, snap_m
    for n in nodes:
        d = math.dist(p, n)
        if d < best_d - 1e-9:
            best, best_d = (float(n[0]), float(n[1])), d
    return best, best != p


#: Ein freier Abschnitt bis zu dieser Länge bleibt, wie er ist (Umwegstück, Stichweg).
KEEP_SHORT_M = 6.0


def _on_network(a: Point, b: Point, nodes: Sequence[Point], edges: Sequence[Sequence[int]],
                tol: float = 0.06) -> bool:
    """Liegt der Abschnitt ganz auf Gangkanten (auch über mehrere hinweg)?"""
    segs = [(nodes[i], nodes[j]) for i, j in edges if i < len(nodes) and j < len(nodes)]
    if not segs:
        return False
    steps = max(1, int(math.dist(a, b) // 0.5))
    for k in range(steps + 1):
        u = k / steps
        p = (a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u)
        if not any(_dist_to_seg(p, s0, s1) <= tol for s0, s1 in segs):
            return False
    return True


def _dist_to_seg(p: Point, a: Point, b: Point) -> float:
    abx, aby = b[0] - a[0], b[1] - a[1]
    l2 = abx * abx + aby * aby
    if l2 <= 1e-12:
        return math.dist(p, a)
    t = max(0.0, min(1.0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2))
    return math.dist(p, (a[0] + abx * t, a[1] + aby * t))


def improve(layout: Layout, raw: Sequence[Sequence[float]], *, loop: bool,
            snap_m: float = SNAP_M, bodies: Sequence[Sequence[Point]] = ()) -> Improvement:
    """Einen Vorschlag für einen besseren Weg rechnen."""
    pts = _clean(raw)
    before_m = length(pts, loop)
    problems_before = route_problems(layout, pts + ([pts[0]] if loop and len(pts) >= 2 else []))
    if len(pts) < 2:
        return Improvement(pts, False, before_m, before_m, 0, 0, 0, 0, problems_before, problems_before,
                           ["Zu wenige Punkte für einen Weg."])
    nodes = list(getattr(layout.aisles, "nodes", []) or [])
    edges = list(getattr(layout.aisles, "edges", []) or [])
    ends = (pts[0], pts[-1])
    blockers = [p for p in [o.points for o in layout.obstacles] + [list(q) for q in bodies]
                if len(p) >= 3 and not any(point_in_polygon(e, p) for e in ends)]
    walls = [_box(p, CLEARANCE_M) for p in blockers]

    def free(a: Point, b: Point) -> bool:
        local = [w for w, q in zip(walls, blockers) if not point_in_polygon(a, q) and not point_in_polygon(b, q)]
        return _clear(a, b, local, layout.outline)

    snapped = 0
    way: list[Point] = [pts[0]]
    for i in range(1, len(pts)):
        p = pts[i]
        if i < len(pts) - 1 or loop:
            q, moved = _snap(p, nodes, snap_m)
            nxt = pts[(i + 1) % len(pts)] if (i < len(pts) - 1 or loop) else None
            # Nur einrasten, wenn beide Nachbarabschnitte danach frei bleiben —
            # sonst zöge der Knoten einen Umwegpunkt zurück an das Hindernis.
            if moved and free(way[-1], q) and (nxt is None or free(q, nxt)):
                p = q
                snapped += 1
        way.append(p)
    legs_src = list(zip(way, way[1:]))
    if loop:
        legs_src.append((way[-1], way[0]))
    rerouted = air = detours = blocked = 0
    out: list[Point] = [way[0]]
    for a, b in legs_src:
        if math.dist(a, b) < 1e-6:
            continue
        # Schon gut: frei und auf den Gängen, oder ein kurzes freies Stück
        # (Umweg, Stichweg). So ist ein verbesserter Weg ein Fixpunkt.
        if free(a, b) and (math.dist(a, b) <= KEEP_SHORT_M or _on_network(a, b, nodes, edges)):
            out.append(b)
            continue
        leg, kind = safe_leg(layout, a, b, bodies)
        if kind == "netz":
            # Nur zählen, wenn der Netzweg wirklich anders verläuft als die Gerade.
            if len(simplify(leg)) > 2:
                rerouted += 1
        elif kind == "umweg":
            detours += 1
        elif kind == "luft":
            air += 1
        else:
            blocked += 1
        out.extend(leg[1:])
    if loop and len(out) >= 2 and math.dist(out[-1], out[0]) < 1e-6:
        out.pop()
    out = simplify(_drop_spikes(simplify(out)))
    if loop and len(out) >= 3:
        # Am Übergang Ende → Anfang ebenfalls Zwischenpunkte auf der Geraden entfernen.
        while len(out) >= 3:
            a, b, c = out[-1], out[0], out[1]
            abx, aby = b[0] - a[0], b[1] - a[1]
            bcx, bcy = c[0] - b[0], c[1] - b[1]
            if abs(abx * bcy - aby * bcx) <= 1e-6 * max(1.0, math.hypot(abx, aby)) and abx * bcx + aby * bcy > 0:
                out.pop(0)
            else:
                break
    after_m = length(out, loop)
    problems_after = route_problems(layout, out + ([out[0]] if loop and len(out) >= 2 else []))
    changed = len(out) != len(pts) or any(math.dist(p, q) > 1e-3 for p, q in zip(out, pts))
    notes: list[str] = []
    if not layout.aisles.usable:
        notes.append("Kein Gangnetz erfasst — nur aufgeräumt, nichts umgelegt.")
    if air:
        notes.append(f"{air} Abschnitt(e) ohne Weg über das Gangnetz bleiben Luftlinie (frei von Körpern).")
    if detours:
        notes.append(f"{detours} Abschnitt(e) mit Umweg um Hindernisse oder Stationen.")
    if blocked:
        notes.append(f"{blocked} Abschnitt(e) ohne freien Weg — bitte im Hallen-Editor prüfen.")
    if snapped:
        notes.append(f"{snapped} Wegpunkt(e) auf Gangknoten eingerastet.")
    if rerouted:
        notes.append(f"{rerouted} Abschnitt(e) über die Gänge gelegt.")
    if problems_before and not problems_after:
        notes.append("Die Prüfung findet nach der Verbesserung nichts mehr.")
    return Improvement(out, changed, before_m, after_m, len(legs_src), rerouted, air, snapped,
                       problems_before, problems_after, notes, detours, blocked)


def network_findings(layout: Layout, bodies: Sequence[Sequence[Point]] = ()) -> list[dict]:
    """Gangkanten, die durch ein Hindernis oder eine Station laufen — Befunde für den Editor."""
    g = layout.aisles
    nodes = list(getattr(g, "nodes", []) or [])
    obstacles = [(getattr(o, "name", "") or "Hindernis", o.points) for o in layout.obstacles if len(o.points) >= 3]
    out: list[dict] = []
    for i, j in getattr(g, "edges", []) or []:
        if i >= len(nodes) or j >= len(nodes):
            continue
        a, b = nodes[i], nodes[j]
        for name, poly in obstacles:
            if segment_blocked(a, b, [poly]):
                out.append({"edge": [i, j], "from": list(a), "to": list(b), "hits": name})
                break
        else:
            for poly in bodies:
                if len(poly) >= 3 and not point_in_polygon(a, poly) and not point_in_polygon(b, poly) \
                        and segment_blocked(a, b, [list(poly)]):
                    out.append({"edge": [i, j], "from": list(a), "to": list(b), "hits": "Station"})
                    break
    return out
