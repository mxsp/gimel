"""Hallengeometrie — Flächen, Hindernisse, Gänge, Wege.

Rein: keine Datenbank, kein I/O, keine Globals. Der Router und die Panels
bauen die Werttypen aus ihren Zeilen und geben sie hier hinein.

Der eine Grund, warum es diese Datei gibt: **die Entfernung zum Lager ist
eine Zahl, mit der gerechnet wird**, und eine Zahl, mit der gerechnet wird,
muss man nachlesen können. Luftlinie durch eine Wand ist keine Entfernung.
Deshalb trägt der Grundriss ein Gangnetz (``AisleGraph``), und die Strecke
zwischen zwei Stationen ist der kürzeste Weg über dieses Netz.

Ist kein Gang erfasst, wird die Luftlinie genommen — aber sie kommt als
solche zurück (``Route.exact = False``), und jede Anzeige sagt es dazu.
Ein geschätzter Wert, der wie ein gemessener aussieht, ist schlimmer als
gar keiner (CLAUDE.md §7).
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

Point = tuple[float, float]
PATH_EPS = 1e-6  # ein Pfad von Hand gehört zu dem Standpunkt, an dem er beginnt
Poly = list[Point]


# --------------------------------------------------------------------------
# Polygone
# --------------------------------------------------------------------------
def polygon_area(pts: Sequence[Point]) -> float:
    """Flächeninhalt (Shoelace), in m². Vorzeichenfrei."""
    if len(pts) < 3:
        return 0.0
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def polygon_perimeter(pts: Sequence[Point]) -> float:
    """Umfang inklusive der schließenden Kante, in m."""
    if len(pts) < 2:
        return 0.0
    return sum(math.dist(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts)))


def point_in_polygon(p: Point, poly: Sequence[Point]) -> bool:
    """Ray casting. Punkte genau auf der Kante gelten als innen genug."""
    if len(poly) < 3:
        return False
    x, y = p
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def _orient(a: Point, b: Point, c: Point) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_cross(a1: Point, a2: Point, b1: Point, b2: Point) -> bool:
    """Echte Kreuzung — Berührungen an Endpunkten zählen nicht.

    Berührungen bleiben draußen, weil ein Gang, der an einer Hindernisecke
    entlangläuft, kein Durchgang durch das Hindernis ist.
    """
    d1, d2 = _orient(a1, a2, b1), _orient(a1, a2, b2)
    d3, d4 = _orient(b1, b2, a1), _orient(b1, b2, a2)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def polygon_self_intersects(pts: Sequence[Point]) -> bool:
    n = len(pts)
    if n < 4:
        return False
    for i in range(n):
        a1, a2 = pts[i], pts[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue  # benachbarte Kanten teilen einen Punkt
            b1, b2 = pts[j], pts[(j + 1) % n]
            if segments_cross(a1, a2, b1, b2):
                return True
    return False


def segment_blocked(a: Point, b: Point, obstacles: Iterable[Sequence[Point]]) -> bool:
    """Kreuzt die Strecke ein Hindernis oder liegt sie ganz darin?"""
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    for poly in obstacles:
        if len(poly) < 3:
            continue
        if point_in_polygon(mid, poly):
            return True
        for i in range(len(poly)):
            p1, p2 = poly[i], poly[(i + 1) % len(poly)]
            if segments_cross(a, b, p1, p2):
                return True
    return False


def segment_leaves_outline(a: Point, b: Point, outline: Sequence[Point]) -> bool:
    """Verlässt die Strecke den Hallenumriss? Ohne Umriss (< 3 Punkte): nein.

    Eine Strecke ist draußen, wenn ihre Mitte außerhalb liegt oder sie eine
    Umrisskante echt kreuzt (bei einer L- oder U-Halle läuft sie sonst durch
    die ausgesparte Ecke).
    """
    if len(outline) < 3:
        return False
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    if not point_in_polygon(mid, outline):
        return True
    for i in range(len(outline)):
        if segments_cross(a, b, outline[i], outline[(i + 1) % len(outline)]):
            return True
    return False


def project_on_segment(p: Point, a: Point, b: Point) -> tuple[Point, float]:
    """Lotfußpunkt von p auf die Strecke a-b und sein Parameter t in [0, 1]."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    len2 = dx * dx + dy * dy
    if len2 <= 0.0:
        return a, 0.0
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
    t = max(0.0, min(1.0, t))
    return (a[0] + t * dx, a[1] + t * dy), t


def _simplify_polyline(points: Sequence[Point]) -> list[Point]:
    """Punkte ohne Doppel und ohne Zwischenpunkte auf gerader Strecke.

    Ein Roboterweg und eine DXF-Linie brauchen keine Zwischenpunkte, die nur
    auf einer Geraden liegen; die Länge bleibt gleich, die Zahl der Stücke
    sinkt.
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


# --------------------------------------------------------------------------
# Gangnetz
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Route:
    """Ein Weg zwischen zwei Punkten der Halle.

    ``exact`` sagt, ob wirklich über Gänge gelaufen wurde. Ist es False, ist
    ``metres`` eine Luftlinie und die Oberfläche muss das kenntlich machen.
    """

    metres: float
    exact: bool
    hops: int = 0
    note: str = ""
    # "manual" (von Hand gezeichneter Pfad), "auto" (Stichweg), "air" (Luftlinie)
    kind: str = "air"
    # Warnung zu einem Pfad von Hand, der nicht gilt (leer, wenn alles passt)
    warning: str = ""

    @property
    def minutes(self) -> float:
        """Gehzeit bei 60 m/min — Werkstattschritt mit Hubwagen."""
        return self.metres / 60.0


@dataclass(frozen=True)
class PolyRoute:
    """Derselbe Weg wie ``Route``, aber als Linienzug für Roboter und DXF.

    ``metres`` ist die Länge des Zuges; ``points`` beginnt am Start und endet
    am Ziel. Bei ``exact=False`` ist der Zug eine Luftlinie und die Oberfläche
    muss das sagen — ein Roboter darf nicht durch eine Wand fahren, nur weil
    die Zahl plausibel aussieht.
    """

    points: list[Point] = field(default_factory=list)
    metres: float = 0.0
    exact: bool = False
    hops: int = 0
    note: str = ""
    kind: str = "air"
    warning: str = ""


@dataclass(frozen=True)
class ManualPath:
    """Ein von Hand gezeichneter Weg einer Station zum Netz.

    ``points[0]`` ist die Station; das Ende hängt wie jeder Punkt ans Netz.
    Er gilt nur, solange die Station noch dort steht (erster Punkt = Standpunkt)
    und kein Teilstück ein Hindernis kreuzt oder die Halle verlässt — sonst
    rechnet die Strecke wieder mit dem automatischen Stichweg und sagt es.
    """

    points: tuple[Point, ...]
    station: Optional[int] = None


@dataclass(frozen=True)
class Attach:
    """Wo und wie ein Punkt ans Gangnetz anschließt.

    ``edge`` ist None, wenn der Anschluss ein Knoten ist (``node``); sonst liegt
    ``point`` mitten auf der Kante ``edge`` (Parameter ``t`` von deren erstem
    zum zweiten Knoten). ``dist`` ist der Stichweg, ``blocked`` heißt: kein
    freier Stichweg (Hindernis oder aus der Halle hinaus).
    """

    point: Point = (0.0, 0.0)
    dist: float = math.inf
    node: int = -1
    edge: Optional[tuple[int, int]] = None
    t: float = 0.0
    blocked: bool = False
    kind: str = "auto"
    warning: str = ""

    @property
    def found(self) -> bool:
        return self.node >= 0 or self.edge is not None

    @property
    def anchor(self) -> int:
        """Ein Knoten der Komponente, an der der Anschluss hängt."""
        return self.node if self.edge is None else self.edge[0]


@dataclass
class AisleGraph:
    """Transportnetz der Halle: Knoten in Metern, Kanten zwischen ihnen.

    Die Kanten sind ungerichtet und tragen ihre Länge implizit über die
    Knotenkoordinaten — eine gespeicherte Länge könnte von der Zeichnung
    abweichen, und dann wäre eine der beiden gelogen.
    """

    nodes: list[Point] = field(default_factory=list)
    edges: list[tuple[int, int]] = field(default_factory=list)
    paths: list[ManualPath] = field(default_factory=list)

    @classmethod
    def from_json(cls, raw: object) -> "AisleGraph":
        """Aus dem, was in der Spalte steht — defensiv, nie werfend.

        Der Grundriss wird von Hand gezeichnet und von Hand importiert; eine
        kaputte Kante darf die Fertigungsansicht nicht abschießen.
        """
        if not isinstance(raw, dict):
            return cls()
        nodes: list[Point] = []
        for n in raw.get("nodes") or []:
            try:
                nodes.append((float(n[0]), float(n[1])))
            except (TypeError, ValueError, IndexError):
                continue
        edges: list[tuple[int, int]] = []
        for e in raw.get("edges") or []:
            try:
                i, j = int(e[0]), int(e[1])
            except (TypeError, ValueError, IndexError):
                continue
            if i == j or not (0 <= i < len(nodes)) or not (0 <= j < len(nodes)):
                continue
            edges.append((i, j))
        paths: list[ManualPath] = []
        for e in raw.get("paths") or []:
            try:
                pts = tuple((float(q[0]), float(q[1])) for q in e["points"])
            except (TypeError, ValueError, IndexError, KeyError):
                continue
            if len(pts) < 2:
                continue
            sid = e.get("station")
            paths.append(ManualPath(pts, int(sid) if isinstance(sid, (int, float)) else None))
        return cls(nodes=nodes, edges=edges, paths=paths)

    def to_json(self) -> dict:
        out: dict = {
            "nodes": [[p[0], p[1]] for p in self.nodes],
            "edges": [[i, j] for i, j in self.edges],
        }
        if self.paths:
            out["paths"] = [
                {"station": m.station, "points": [[q[0], q[1]] for q in m.points]}
                for m in self.paths
            ]
        return out

    @property
    def usable(self) -> bool:
        return len(self.nodes) >= 2 and len(self.edges) >= 1

    def length_m(self) -> float:
        return sum(math.dist(self.nodes[i], self.nodes[j]) for i, j in self.edges)

    def _adjacency(self) -> list[list[tuple[int, float]]]:
        adj: list[list[tuple[int, float]]] = [[] for _ in self.nodes]
        for i, j in self.edges:
            d = math.dist(self.nodes[i], self.nodes[j])
            adj[i].append((j, d))
            adj[j].append((i, d))
        return adj

    def nearest_node(self, p: Point) -> tuple[int, float]:
        """Index und Abstand des nächsten Gangknotens. (-1, inf) ohne Netz."""
        best, best_d = -1, math.inf
        for i, q in enumerate(self.nodes):
            d = math.dist(p, q)
            if d < best_d:
                best, best_d = i, d
        return best, best_d

    def component_ids(self) -> list[int]:
        """Verbundkomponente je Knoten. Inseln erkennen, bevor eine Rechnung
        still über sie hinweggeht."""
        adj: list[list[int]] = [[] for _ in self.nodes]
        for i, j in self.edges:
            adj[i].append(j)
            adj[j].append(i)
        comp = [-1] * len(self.nodes)
        label = 0
        for start in range(len(self.nodes)):
            if comp[start] != -1:
                continue
            comp[start] = label
            stack = [start]
            while stack:
                u = stack.pop()
                for v in adj[u]:
                    if comp[v] == -1:
                        comp[v] = label
                        stack.append(v)
            label += 1
        return comp

    def stub(
        self, p: Point, obstacles: Iterable[Sequence[Point]] = ()
    ) -> tuple[int, float, bool]:
        """Die Anbindung eines Objekts ans Netz: Knoten, Stichweg, frei?

        Der nächste Knoten genügt nicht — sein Stichweg kann durch eine Wand
        laufen. Gesucht wird der nächste Knoten mit *freiem* Stichweg; nur wenn
        jeder Stichweg ein Hindernis kreuzt, wird der nächstgelegene mit
        ``blocked=True`` zurückgegeben. Ein Objekt, das nur durch ein Hindernis
        ans Netz kommt, ist nicht verbunden — das ehrlich zu sagen ist der
        ganze Punkt dieser Methode.
        """
        best, best_d = self.nearest_node(p)
        if best < 0:
            return -1, math.inf, False
        obs = [o for o in obstacles if len(o) >= 3]
        if not obs:
            return best, best_d, False
        order = sorted((math.dist(p, q), i) for i, q in enumerate(self.nodes))
        for d, i in order:
            if not segment_blocked(p, self.nodes[i], obs):
                return i, d, False
        return best, best_d, True

    def attach(
        self,
        p: Point,
        obstacles: Iterable[Sequence[Point]] = (),
        outline: Sequence[Point] = (),
    ) -> Attach:
        """Der nächste *freie* Anschluss von p ans Netz — Knoten oder Kantenpunkt.

        Kandidaten sind alle Knoten und der Lotfußpunkt auf jeder Kante. Der
        nächste, dessen Stichweg kein Hindernis kreuzt und den Umriss nicht
        verlässt, gewinnt; bei gleichem Abstand ein Knoten vor einer Kante.
        Gibt es keinen freien, kommt der nächste mit ``blocked=True`` zurück.
        """
        if not self.nodes:
            return Attach()
        obs = [o for o in obstacles if len(o) >= 3]
        cands: list[tuple[float, int, Point, int, Optional[tuple[int, int]], float]] = []
        for i, q in enumerate(self.nodes):
            cands.append((math.dist(p, q), 0, q, i, None, 0.0))
        for i, j in self.edges:
            q, t = project_on_segment(p, self.nodes[i], self.nodes[j])
            if 0.0 < t < 1.0:
                cands.append((math.dist(p, q), 1, q, -1, (i, j), t))
        cands.sort(key=lambda c: (c[0], c[1]))
        for d, _, q, node, edge, t in cands:
            if d > 0 and (
                segment_blocked(p, q, obs) or segment_leaves_outline(p, q, outline)
            ):
                continue
            return Attach(q, d, node, edge, t, False)
        d, _, q, node, edge, t = cands[0]
        return Attach(q, d, node, edge, t, True)

    def manual_attach(
        self,
        p: Point,
        obstacles: Iterable[Sequence[Point]] = (),
        outline: Sequence[Point] = (),
    ) -> Optional[Attach]:
        """Der Pfad von Hand für den Standpunkt p — oder None, wenn es keinen gibt.

        Ein Pfad, der nicht gilt (Hindernis, aus der Halle hinaus, kein Weg vom
        Ende ans Netz), kommt als ``Attach(kind="auto")`` mit ``warning`` zurück:
        der Aufrufer rechnet dann automatisch weiter und zeigt die Warnung.
        """
        mine = [m for m in self.paths if math.dist(m.points[0], p) <= PATH_EPS]
        if not mine:
            return None
        m = mine[-1]
        obs = [o for o in obstacles if len(o) >= 3]
        for u, v in zip(m.points, m.points[1:]):
            if segment_blocked(u, v, obs):
                return Attach(kind="auto", warning="Pfad von Hand kreuzt ein Hindernis")
            if segment_leaves_outline(u, v, outline):
                return Attach(kind="auto", warning="Pfad von Hand verlässt die Halle")
        end = self.attach(m.points[-1], obs, outline)
        if not end.found or end.blocked:
            return Attach(kind="auto", warning="Pfad von Hand endet ohne freien Anschluss ans Netz")
        length = sum(math.dist(u, v) for u, v in zip(m.points, m.points[1:]))
        return Attach(end.point, length + end.dist, end.node, end.edge, end.t, False, "manual")

    def _attach_any(self, p, obstacles, outline) -> Attach:
        man = self.manual_attach(p, obstacles, outline)
        if man is not None and man.kind == "manual":
            return man
        auto = self.attach(p, obstacles, outline)
        if man is not None and auto.found:
            return Attach(auto.point, auto.dist, auto.node, auto.edge, auto.t,
                          auto.blocked, "auto", man.warning)
        return auto

    def path(
        self,
        a: Point,
        b: Point,
        obstacles: Iterable[Sequence[Point]] = (),
        outline: Sequence[Point] = (),
    ) -> PolyRoute:
        """Kürzester Weg a → Gangnetz → b als Linienzug. Ohne Netz: Luftlinie.

        Dieselbe Rechnung wie ``route``, nur mit Zwischenpunkten. Die
        Anbindung an das Netz (Stichweg von der Station zum nächsten Punkt
        eines Gangs — Knoten *oder* Mitte einer Kante) zählt mit. Ist der
        Stichweg versperrt oder das Netz zerrissen, kommt ehrlich eine
        Luftlinie mit ``exact=False`` zurück — nie ein halber Weg.
        """
        direct = math.dist(a, b)

        def air(note: str) -> PolyRoute:
            return PolyRoute([a, b], direct, False, 0, note, "air")

        if not self.usable:
            return air("Luftlinie — kein Gangnetz erfasst")

        aa = self._attach_any(a, obstacles, outline)
        ab = self._attach_any(b, obstacles, outline)
        warn = "; ".join(w for w in (aa.warning, ab.warning) if w)
        manual = "manual" if "manual" in (aa.kind, ab.kind) else "auto"
        if not aa.found or not ab.found:
            return air("Luftlinie — kein Gangnetz erfasst")
        if aa.blocked or ab.blocked:
            who = "Start" if aa.blocked else "Ziel"
            return air(f"Luftlinie — der Stichweg zum {who} kreuzt ein Hindernis "
                       "oder verlässt die Halle")
        if aa.edge is None and ab.edge is None and aa.node == ab.node:
            pts = _simplify_polyline([a, self.nodes[aa.node], b])
            return PolyRoute(pts, aa.dist + ab.dist, True, 1, "über einen Gangknoten",
                             manual, warn)
        if aa.edge is not None and aa.edge == ab.edge:
            # Beide liegen an derselben Kante: entlang der Kante, nicht außen herum.
            pts = _simplify_polyline([a, aa.point, ab.point, b])
            return PolyRoute(pts, aa.dist + math.dist(aa.point, ab.point) + ab.dist, True, 1,
                             "über eine Gangkante", manual, warn)

        def ends(at: Attach) -> list[tuple[int, float]]:
            if at.edge is None:
                return [(at.node, 0.0)]
            return [(k, math.dist(at.point, self.nodes[k])) for k in at.edge]

        adj = self._adjacency()
        dist = [math.inf] * len(self.nodes)
        hops = [0] * len(self.nodes)
        prev = [-1] * len(self.nodes)
        queue: list[tuple[float, int]] = []
        for k, off in ends(aa):
            if off < dist[k]:
                dist[k] = off
                queue.append((off, k))
        heapq.heapify(queue)
        seen = set()
        while queue:
            d, u = heapq.heappop(queue)
            if u in seen:
                continue
            seen.add(u)
            for v, w in adj[u]:
                nd = d + w
                if nd < dist[v]:
                    dist[v] = nd
                    hops[v] = hops[u] + 1
                    prev[v] = u
                    heapq.heappush(queue, (nd, v))

        best, best_k = math.inf, -1
        for k, off in ends(ab):
            if dist[k] + off < best:
                best, best_k = dist[k] + off, k
        if not math.isfinite(best):
            # Netz zerfällt in Inseln — ehrlicher als eine erfundene Strecke.
            return air("Luftlinie — Gangnetz nicht durchgängig")

        chain: list[Point] = []
        k = best_k
        while k != -1:
            chain.append(self.nodes[k])
            k = prev[k]
        chain.reverse()
        pts = [a]
        if aa.edge is not None:
            pts.append(aa.point)
        pts.extend(chain)
        if ab.edge is not None:
            pts.append(ab.point)
        pts.append(b)
        return PolyRoute(_simplify_polyline(pts), aa.dist + best + ab.dist, True,
                         hops[best_k] + 2, "über das Gangnetz", manual, warn)

    def route(
        self,
        a: Point,
        b: Point,
        obstacles: Iterable[Sequence[Point]] = (),
        outline: Sequence[Point] = (),
    ) -> Route:
        """Kürzester Weg a → Gangnetz → b. Ohne Netz: Luftlinie.

        Die Anbindung an das Netz (Stichweg von der Station zum nächsten Punkt
        eines Gangs — Knoten *oder* Mitte einer Kante) zählt mit, sonst wäre
        eine Station weit abseits des Gangs so günstig wie eine direkt daran.
        Der Stichweg muss frei sein: keine Wand, nicht aus der Halle hinaus.
        Sonst fällt die Rechnung ehrlich auf die Luftlinie zurück, statt „über
        Gänge" zu behaupten.
        """
        p = self.path(a, b, obstacles, outline)
        return Route(p.metres, p.exact, p.hops, p.note, p.kind, p.warning)


# --------------------------------------------------------------------------
# Der Grundriss als Werttyp
# --------------------------------------------------------------------------
@dataclass
class Zone:
    """Benannte Fläche in der Halle — Lagerzone, Fertigung, Versandbereich."""

    name: str = ""
    kind: str = "zone"
    colour: str = "#8e5cb8"
    points: Poly = field(default_factory=list)

    @property
    def area_m2(self) -> float:
        return polygon_area(self.points)


@dataclass
class Obstacle:
    """Was den Weg versperrt: Stütze, Zwischenwand, Regalblock."""

    name: str = ""
    points: Poly = field(default_factory=list)

    @property
    def area_m2(self) -> float:
        return polygon_area(self.points)


@dataclass
class Door:
    """Tor oder Tür — Punkt mit Breite; heute Anschauung, morgen Wegeknoten."""

    name: str = ""
    x: float = 0.0
    y: float = 0.0
    width: float = 2.5
    kind: str = "door"  # door | gate | ramp


@dataclass
class Layout:
    """Alles, was die Halle ausmacht — die Eingabe jeder Wegerechnung."""

    outline: Poly = field(default_factory=list)
    zones: list[Zone] = field(default_factory=list)
    obstacles: list[Obstacle] = field(default_factory=list)
    doors: list[Door] = field(default_factory=list)
    aisles: AisleGraph = field(default_factory=AisleGraph)

    @property
    def area_m2(self) -> float:
        return polygon_area(self.outline)

    def route(self, a: Point, b: Point) -> Route:
        return self.aisles.route(
            a, b, [o.points for o in self.obstacles], self.outline
        )

    def path(self, a: Point, b: Point) -> PolyRoute:
        """Derselbe Weg als Linienzug — für Roboteraufträge und Zeichnungen."""
        return self.aisles.path(
            a, b, [o.points for o in self.obstacles], self.outline
        )

    def connect_issues(
        self, objects: Sequence[tuple[str, Point]], *, max_stub_m: float = 8.0
    ) -> list[str]:
        """Verbinden die Gänge die Objekte? — für die Prüfleiste des Editors.

        ``objects`` trägt (Label, Standpunkt) jeder Station. Vier Arten, wie
        eine Verbindung fehlen kann, jede mit einem Satz, der sagt, was zu
        tun ist:

        · Das Netz erreicht das Objekt nicht — der nächste Knoten ist weit.
        · Jeder Stichweg kreuzt ein Hindernis — der Gang endet hinter einer Wand.
        · Das Netz zerfällt in Inseln — zwischen zwei Objekten rechnet nichts.
        Kein Netz ist hier bewusst keine Meldung: sie kommt schon aus
        ``check()`` und würde hier nur doppelt stehen.
        """
        if not self.aisles.usable or not objects:
            return []
        issues: list[str] = []
        obstacles = [o.points for o in self.obstacles]
        comps = self.aisles.component_ids()
        islands: dict[int, list[str]] = {}
        for label, p in objects:
            at = self.aisles._attach_any(p, obstacles, self.outline)
            if not at.found:
                continue
            if at.warning:
                issues.append(
                    f"Der Pfad von Hand für „{label}“ gilt nicht ({at.warning}) — "
                    "es rechnet der automatische Stichweg. Pfad neu zeichnen oder löschen."
                )
            idx, d, blocked = at.anchor, at.dist, at.blocked
            if blocked:
                issues.append(
                    f"Kein freier Stichweg von „{label}“ ans Gangnetz — der Gang "
                    "endet hinter einem Hindernis oder außerhalb der Halle. Knoten vor das Objekt setzen."
                )
            elif d > max_stub_m:
                issues.append(
                    f"Das Gangnetz erreicht „{label}“ nicht: der nächste Gangknoten "
                    f"liegt {d:.1f} m entfernt. Einen Knoten an der Station setzen."
                )
            islands.setdefault(comps[idx] if 0 <= idx < len(comps) else -1, []).append(
                label
            )
        if len(islands) > 1:
            groups = sorted(islands.values(), key=len, reverse=True)
            head = ", ".join(f"„{n}“" for n in groups[0][:3])
            other = ", ".join(f"„{n}“" for n in groups[1][:3])
            issues.append(
                f"Das Gangnetz zerfällt in Inseln — zwischen {head} und {other} "
                "rechnet nichts über die Gänge. Die Knoten verbinden."
            )
        return issues

    def contains(self, p: Point) -> bool:
        return point_in_polygon(p, self.outline) if len(self.outline) >= 3 else True

    def zone_at(self, p: Point) -> Optional[Zone]:
        for z in self.zones:
            if point_in_polygon(p, z.points):
                return z
        return None

    def blocked(self, a: Point, b: Point) -> bool:
        return segment_blocked(a, b, [o.points for o in self.obstacles])

    def check(self) -> list[str]:
        """Was an diesem Grundriss nicht stimmt — für die Prüfleiste im Editor."""
        issues: list[str] = []
        if len(self.outline) < 3:
            issues.append("Der Umriss hat weniger als drei Punkte.")
        elif polygon_self_intersects(self.outline):
            issues.append(
                "Der Umriss schneidet sich selbst — Fläche und Wege stimmen dann nicht."
            )
        for z in self.zones:
            if len(z.points) < 3:
                issues.append(
                    f"Zone „{z.name or 'ohne Namen'}“ hat weniger als drei Punkte."
                )
        for o in self.obstacles:
            if len(o.points) < 3:
                issues.append(
                    f"Hindernis „{o.name or 'ohne Namen'}“ hat weniger als drei Punkte."
                )
        if self.aisles.nodes and not self.aisles.usable:
            issues.append("Gangknoten ohne Verbindung — die Wege zählen als Luftlinie.")
        return issues

    @classmethod
    def from_row(cls, row: object) -> "Layout":
        """Aus einer FactoryFloor-Zeile. Nimmt alles entgegen, wirft nie."""

        def pts(raw: object) -> Poly:
            out: Poly = []
            for p in raw or []:  # type: ignore[union-attr]
                try:
                    out.append((float(p[0]), float(p[1])))
                except (TypeError, ValueError, IndexError):
                    continue
            return out

        if row is None:
            return cls()
        zones = []
        for z in getattr(row, "zones", None) or []:
            if isinstance(z, dict):
                zones.append(
                    Zone(
                        name=str(z.get("name", "")),
                        kind=str(z.get("kind", "zone")),
                        colour=str(z.get("colour", "#8e5cb8")),
                        points=pts(z.get("points")),
                    )
                )
        obstacles = []
        for o in getattr(row, "obstacles", None) or []:
            if isinstance(o, dict):
                obstacles.append(
                    Obstacle(name=str(o.get("name", "")), points=pts(o.get("points")))
                )
        # Förderbänder: niedrige Abschnitte und Stützen versperren den Weg wie ein
        # Hindernis; eine Brücke darüber ist frei (core/conveyor.py).
        from .conveyor import bodies as conveyor_bodies

        for name, poly in conveyor_bodies(getattr(row, "conveyors", None)):
            obstacles.append(Obstacle(name=name, points=poly))
        doors = []
        for d in getattr(row, "doors", None) or []:
            if isinstance(d, dict):
                try:
                    doors.append(
                        Door(
                            name=str(d.get("name", "")),
                            x=float(d.get("x", 0)),
                            y=float(d.get("y", 0)),
                            width=float(d.get("width", 2.5)),
                            kind=str(d.get("kind", "door")),
                        )
                    )
                except (TypeError, ValueError):
                    continue
        return cls(
            outline=pts(getattr(row, "outline", None)),
            zones=zones,
            obstacles=obstacles,
            doors=doors,
            aisles=AisleGraph.from_json(getattr(row, "aisles", None)),
        )
