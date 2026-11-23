"""Pfadfinder: Wege um Hindernisse, innerhalb des Hallenumrisses.

Sichtbarkeitsgraph statt Raster: Wegpunkte sind die Ecken der Hindernisse
(ein Stück nach außen versetzt, damit der Weg nicht an der Wand klebt) und die
einspringenden Ecken des Umrisses (nach innen versetzt). Der kürzeste Weg
zwischen zwei Punkten läuft immer über solche Ecken. A* findet ihn.

Rein und deterministisch: keine Uhr, kein I/O, gleiche Eingabe gleicher Weg.
Die Grenze der Rechenzeit ist eine Zahl Sichtprüfungen (``max_tests``), keine
Sekundenzahl — ein Plan, der heute klappt, klappt morgen genauso. Wird sie
überschritten, gibt es ``None`` (kein Vorschlag), nie einen halben Weg.

Dieselbe Rechnung steht in ``web/src/factory.ts`` (``Pathfinder``); beide Seiten
stimmen über ``tests/core/fixtures/aisle_parity.json`` überein.
"""

from __future__ import annotations

import heapq
import math
from typing import Optional, Sequence

from .layout import (
    AisleGraph,
    Point,
    point_in_polygon,
    project_on_segment,
    segment_blocked,
    segment_leaves_outline,
)

MARGIN_M = 0.3  # Abstand der Wegpunkte zur Wand
MAX_WAYPOINTS = 400
MAX_TESTS = 400_000
MAX_CANDIDATES = 6  # so viele nächste Anschlüsse werden um die Hindernisse herum versucht


class _Budget(Exception):
    pass


def _offset_corners(poly: Sequence[Point], margin: float, outward: bool) -> list[Point]:
    """Ecken eines Polygons, entlang der Winkelhalbierenden um ``margin`` versetzt."""
    n = len(poly)
    ccw = polygon_area_signed(poly) > 0
    out: list[Point] = []
    for i in range(n):
        u, v, w = poly[i - 1], poly[i], poly[(i + 1) % n]
        n1 = _normal(u, v, ccw)
        n2 = _normal(v, w, ccw)
        bx, by = n1[0] + n2[0], n1[1] + n2[1]
        bl = math.hypot(bx, by)
        if bl < 1e-9:
            continue
        bx, by = bx / bl, by / bl
        cos_half = max(0.3, bx * n1[0] + by * n1[1])  # Ecken nicht ins Unendliche schieben
        k = margin / cos_half * (1 if outward else -1)
        out.append((v[0] + bx * k, v[1] + by * k))
    return out


def simplify_polyline(points: Sequence[Point]) -> list[Point]:
    """Punkte ohne Doppel und ohne Zwischenpunkte auf gerader Strecke.

    Der Pfadfinder liefert den kürzesten Weg über Sichtkanten; auf einer
    geraden Sichtlinie entstehen dabei manchmal Zwischenpunkte, die niemand
    braucht. Sie kosten im Gangnetz Knoten und im Editor Platz. Die Länge
    bleibt gleich — nur die Zahl der Stücke wird kleiner.
    """
    out: list[Point] = []
    for p in points:
        if out and math.dist(out[-1], p) < 1e-9:
            continue
        while len(out) >= 2:
            a, b = out[-2], out[-1]
            cross = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0])
            if abs(cross) > 1e-9 * max(1.0, math.dist(a, b)):
                break
            out.pop()
        out.append(p)
    return out


def polygon_area_signed(poly: Sequence[Point]) -> float:
    a = 0.0
    for i in range(len(poly)):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        a += p[0] * q[1] - q[0] * p[1]
    return a / 2


def _normal(a: Point, b: Point, ccw: bool) -> tuple[float, float]:
    """Nach außen zeigende Einheitsnormale der Kante a→b."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dy) or 1.0
    return (dy / ln, -dx / ln) if ccw else (-dy / ln, dx / ln)


class Pathfinder:
    def __init__(
        self,
        outline: Sequence[Point] = (),
        obstacles: Sequence[Sequence[Point]] = (),
        *,
        margin: float = MARGIN_M,
        max_tests: int = MAX_TESTS,
    ) -> None:
        self.outline = list(outline) if len(outline) >= 3 else []
        self.obstacles = [list(o) for o in obstacles if len(o) >= 3]
        self.max_tests = max_tests
        self.tests = 0
        pts: list[Point] = []
        for o in self.obstacles:
            pts.extend(_offset_corners(o, margin, outward=True))
        if self.outline:
            # nur einspringende Ecken (Reflex) können einen kürzesten Weg knicken
            ccw = polygon_area_signed(self.outline) > 0
            n = len(self.outline)
            inner = _offset_corners(self.outline, margin, outward=False)
            for i, q in enumerate(self.outline):
                u, w = self.outline[i - 1], self.outline[(i + 1) % n]
                cross = (q[0] - u[0]) * (w[1] - q[1]) - (q[1] - u[1]) * (w[0] - q[0])
                if (cross < 0) if ccw else (cross > 0):
                    if i < len(inner):
                        pts.append(inner[i])
        self.waypoints = [
            q
            for q in pts
            if (not self.outline or point_in_polygon(q, self.outline))
            and not any(point_in_polygon(q, o) for o in self.obstacles)
        ][:MAX_WAYPOINTS]
        self._vis: dict[tuple[Point, Point], bool] = {}

    def visible(self, a: Point, b: Point) -> bool:
        key = (a, b) if a <= b else (b, a)
        hit = self._vis.get(key)
        if hit is not None:
            return hit
        self.tests += 1
        if self.tests > self.max_tests:
            raise _Budget()
        ok = not segment_blocked(a, b, self.obstacles) and not segment_leaves_outline(
            a, b, self.outline
        )
        self._vis[key] = ok
        return ok

    def path(self, a: Point, b: Point) -> Optional[list[Point]]:
        """Kürzester freier Weg a → b als Linienzug mit beiden Enden, sonst None."""
        try:
            return self._path(a, b)
        except _Budget:
            return None

    def _path(self, a: Point, b: Point) -> Optional[list[Point]]:
        if self.visible(a, b):
            return [a, b]
        pts = [a, b] + self.waypoints  # 0 = Start, 1 = Ziel
        g = {0: 0.0}
        prev: dict[int, int] = {}
        heap: list[tuple[float, int, int]] = [(math.dist(a, b), 0, 0)]
        done: set[int] = set()
        while heap:
            _, _, u = heapq.heappop(heap)
            if u in done:
                continue
            done.add(u)
            if u == 1:
                out = []
                while True:
                    out.append(pts[u])
                    if u == 0:
                        break
                    u = prev[u]
                out.reverse()
                return out
            for v in range(len(pts)):
                if v == u or v in done or (u == 0 and v == 1):
                    continue
                if not self.visible(pts[u], pts[v]):
                    continue
                nd = g[u] + math.dist(pts[u], pts[v])
                if nd < g.get(v, math.inf) - 1e-12:
                    g[v] = nd
                    prev[v] = u
                    heapq.heappush(heap, (nd + math.dist(pts[v], b), v, v))
        return None


def connect_station(
    aisles: AisleGraph,
    p: Point,
    finder: Pathfinder,
    *,
    candidates: int = MAX_CANDIDATES,
) -> Optional[AisleGraph]:
    """Das Gangnetz samt einem Weg von p ans Netz — um Hindernisse herum.

    Vorschlag, nichts wird gespeichert: der Aufrufer zeigt ihn und lässt den
    Admin übernehmen oder verwerfen. Es entstehen neue Knoten (die Ecken des
    Weges und die Station), eine geteilte Kante, wo der Anschluss mitten auf
    einer liegt, und die Kanten dazwischen. None, wenn kein Weg zu finden ist.
    Liegt p schon am Netz, bleibt es unverändert.
    """
    if not aisles.nodes:
        return None
    cands: list[tuple[float, int, Point, int, Optional[tuple[int, int]]]] = []
    for i, q in enumerate(aisles.nodes):
        cands.append((math.dist(p, q), 0, q, i, None))
    for i, j in aisles.edges:
        q, t = project_on_segment(p, aisles.nodes[i], aisles.nodes[j])
        if 0.0 < t < 1.0:
            cands.append((math.dist(p, q), 1, q, -1, (i, j)))
    cands.sort(key=lambda c: (c[0], c[1]))
    if cands[0][0] < 1e-9:
        return AisleGraph(list(aisles.nodes), list(aisles.edges), list(aisles.paths))
    best: Optional[tuple[float, list[Point], int, Optional[tuple[int, int]]]] = None
    for d, _, q, node, edge in cands[:candidates]:
        way = finder.path(p, q)
        if way is None:
            continue
        length = sum(math.dist(u, v) for u, v in zip(way, way[1:]))
        if best is None or length < best[0] - 1e-12:
            best = (length, way, node, edge)
    if best is None:
        return None
    _, way, node, edge = best
    way = simplify_polyline(way)
    nodes = list(aisles.nodes)
    edges = list(aisles.edges)
    target = node
    if edge is not None:
        i, j = edge
        nodes.append(way[-1])
        target = len(nodes) - 1
        edges = [e for e in edges if e not in ((i, j), (j, i))]
        edges += [(i, target), (target, j)]
    prev_idx = target
    for q in reversed(way[:-1]):  # von der Anbindung zur Station zurück
        nodes.append(q)
        edges.append((prev_idx, len(nodes) - 1))
        prev_idx = len(nodes) - 1
    return AisleGraph(nodes, edges, list(aisles.paths))
