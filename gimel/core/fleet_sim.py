"""Flottensimulation: geplante Roboter gegen den echten Transportbedarf.

Eine Was-wäre-wenn-Rechnung für Roboter, die es noch nicht gibt. Sie kennt
keine Datenbank, keine Uhr und keinen Zufall von außen: der Aufrufer gibt
Bedarf, Wege und einen Startwert (``seed``) hinein, dieselbe Eingabe liefert
dasselbe Ergebnis. Nichts davon wird ein echter Transportauftrag.

Modell (absichtlich schlicht, und so beschrieben, wie es rechnet):

* **Bedarf:** Transporte von Station A nach B, je mit Freigabezeit in der
  Schicht. ``demand_from_flow`` verteilt eine Tagesmenge nach den gewichteten
  Kanten des Materialflusses über die Schicht (Poisson-ähnlich, gesät).
* **Zuteilung:** der nächste freigegebene Transport geht an den Roboter, der
  ihn am frühesten abholen kann (frei ab + Leerfahrt). Kein Vorausplanen,
  keine Bündelung — so dispatcht auch der echte Dienst.
* **Fahrt:** leer zur Quelle, Laden, beladen zum Ziel, Entladen. Wege und
  Längen kommen vom Aufrufer (Gangnetz); geschätzte Wege tragen ``exact=False``.
* **Begegnungen:** alle ``sample_s`` Sekunden wird geprüft, ob zwei fahrende
  Roboter näher als ``encounter_m`` kommen. Das ist ein Hinweis auf Engstellen, keine
  Kollisionsprüfung mit Ausweichen.

Gimel hat kein Maschinensignal; die Simulation behauptet keine Genauigkeit,
die der Bedarf nicht hergibt. Jede Kennzahl ist eine Schätzung.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Optional, Sequence

Point = tuple[float, float]

#: Grenzen, die den einen Prozess schützen.
MAX_ROBOTS = 12
MAX_DEMANDS = 600
MAX_HORIZON_S = 12 * 3600
MAX_SIZING = 8


@dataclass(frozen=True)
class SimRobot:
    id: str
    name: str
    kind: str = "amr"
    speed_m_s: float = 1.0
    start: Point = (0.0, 0.0)
    #: Laden plus Entladen je Transport, in Sekunden.
    handling_s: float = 60.0
    #: Bestehender Roboter (Vergleichsbasis) oder geplanter.
    planned: bool = True


@dataclass(frozen=True)
class Demand:
    id: str
    from_id: int
    to_id: int
    release_s: float
    kind: str = "transfer"


@dataclass(frozen=True)
class Way:
    points: tuple[Point, ...]
    metres: float
    exact: bool


@dataclass
class Segment:
    """Ein Stück Zeitleiste eines Roboters. ``points`` leer = steht."""

    robot: str
    t0: float
    t1: float
    state: str  # leer | beladen | laden | entladen
    points: list[Point] = field(default_factory=list)
    demand: str = ""

    def as_dict(self) -> dict:
        return {"t0": round(self.t0, 2), "t1": round(self.t1, 2), "state": self.state,
                "points": [[round(x, 3), round(y, 3)] for x, y in self.points], "demand": self.demand}


@dataclass
class SimResult:
    horizon_s: float
    robots: list[dict]
    tracks: dict[str, list[Segment]]
    served: int
    unserved: int
    late: int
    wait_mean_s: float
    wait_p90_s: float
    wait_max_s: float
    loaded_m: float
    empty_m: float
    encounters: int
    hotspots: list[dict]
    estimated_ways: int
    demands: int

    def summary(self) -> dict:
        total_m = self.loaded_m + self.empty_m
        return {
            "horizon_s": self.horizon_s,
            "demands": self.demands,
            "served": self.served,
            "unserved": self.unserved,
            "late": self.late,
            "wait_mean_s": round(self.wait_mean_s, 1),
            "wait_p90_s": round(self.wait_p90_s, 1),
            "wait_max_s": round(self.wait_max_s, 1),
            "loaded_m": round(self.loaded_m, 1),
            "empty_m": round(self.empty_m, 1),
            "empty_share": round(self.empty_m / total_m, 3) if total_m > 0 else 0.0,
            "per_hour": round(self.served / (self.horizon_s / 3600), 2) if self.horizon_s else 0.0,
            "encounters": self.encounters,
            "hotspots": self.hotspots,
            "estimated_ways": self.estimated_ways,
            "robots": self.robots,
        }


class _Rng:
    """xorshift32 — ein eigener, gesäter Generator; der Kern importiert kein ``random``."""

    def __init__(self, seed: int) -> None:
        self.s = (int(seed) & 0xFFFFFFFF) or 0x9E3779B9

    def next(self) -> float:
        s = self.s
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        self.s = s & 0xFFFFFFFF
        return self.s / 0x100000000


def demand_from_flow(
    edges: Sequence[dict],
    per_shift: int,
    horizon_s: float,
    *,
    seed: int = 1,
) -> list[Demand]:
    """Eine Schicht Transporte aus dem Materialfluss.

    ``edges``: ``[{"from": id, "to": id, "count": n, "kind": ...}]``. Die
    Anzahl je Kante gewichtet, welche Strecke gezogen wird; die Freigaben
    kommen mit exponentiellen Abständen, also mal dicht, mal mit Luft.
    """
    pool = [e for e in edges if int(e.get("count") or 0) > 0 and e.get("from") != e.get("to")]
    n = max(0, min(int(per_shift), MAX_DEMANDS))
    if not pool or n == 0 or horizon_s <= 0:
        return []
    weights = [float(e["count"]) for e in pool]
    total = sum(weights)
    rng = _Rng(seed)
    mean_gap = horizon_s / n
    t = 0.0
    out: list[Demand] = []
    for i in range(n):
        t += -math.log(1.0 - rng.next() * 0.999999) * mean_gap
        # Rückt der letzte Abstand über die Schicht hinaus, wird gleichmäßig
        # gestaucht statt Transporte zu verlieren.
        pick = rng.next() * total
        run = 0.0
        edge = pool[-1]
        for e, w in zip(pool, weights):
            run += w
            if pick <= run:
                edge = e
                break
        out.append(Demand(id=f"T{i + 1:03d}", from_id=int(edge["from"]), to_id=int(edge["to"]),
                          release_s=t, kind=str(edge.get("kind") or "transfer")))
    if out and out[-1].release_s > horizon_s * 0.97:
        scale = horizon_s * 0.97 / out[-1].release_s
        out = [Demand(d.id, d.from_id, d.to_id, d.release_s * scale, d.kind) for d in out]
    return out


def _poly_metres(points: Sequence[Point]) -> float:
    return sum(math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1])
               for i in range(len(points) - 1))


def _pose(points: Sequence[Point], u: float) -> Point:
    """Punkt bei Anteil ``u`` (0…1) eines Linienzugs."""
    if not points:
        return (0.0, 0.0)
    if len(points) == 1:
        return points[0]
    total = _poly_metres(points)
    if total <= 1e-9:
        return points[0]
    target = max(0.0, min(1.0, u)) * total
    run = 0.0
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        if run + length >= target - 1e-9:
            k = 0.0 if length <= 1e-9 else (target - run) / length
            return (a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k)
        run += length
    return points[-1]


def position_at(track: Sequence[Segment], t: float, start: Point) -> Point:
    """Wo ein Roboter zur Simulationszeit ``t`` steht."""
    last = start
    for seg in track:
        if t < seg.t0:
            return last
        if seg.t0 <= t <= seg.t1:
            if not seg.points:
                return last
            span = seg.t1 - seg.t0
            return _pose(seg.points, 0.0 if span <= 0 else (t - seg.t0) / span)
        if seg.points:
            last = seg.points[-1]
    return last


def simulate(
    robots: Sequence[SimRobot],
    demands: Sequence[Demand],
    station_points: dict[int, Point],
    way: Callable[[Point, Point], Way],
    horizon_s: float,
    *,
    late_after_s: float = 15 * 60,
    sample_s: float = 2.0,
    encounter_m: float = 1.6,
) -> SimResult:
    """Den Bedarf mit dieser Flotte abarbeiten — gierig, wie der echte Dienst."""
    robots = list(robots)[:MAX_ROBOTS]
    horizon_s = max(0.0, min(float(horizon_s), MAX_HORIZON_S))
    demands = sorted((d for d in demands
                      if d.from_id in station_points and d.to_id in station_points
                      and d.release_s <= horizon_s), key=lambda d: (d.release_s, d.id))[:MAX_DEMANDS]
    cache: dict[tuple[Point, Point], Way] = {}

    def route(a: Point, b: Point) -> Way:
        key = (a, b)
        w = cache.get(key)
        if w is None:
            if math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6:
                w = Way(points=(a,), metres=0.0, exact=True)
            else:
                w = way(a, b)
            cache[key] = w
        return w

    free_at = {r.id: 0.0 for r in robots}
    pos = {r.id: (float(r.start[0]), float(r.start[1])) for r in robots}
    tracks: dict[str, list[Segment]] = {r.id: [] for r in robots}
    busy = {r.id: 0.0 for r in robots}
    jobs = {r.id: 0 for r in robots}
    loaded = {r.id: 0.0 for r in robots}
    empty = {r.id: 0.0 for r in robots}
    waits: list[float] = []
    served = unserved = late = 0
    estimated: set[tuple[Point, Point]] = set()

    for d in demands:
        src, dst = station_points[d.from_id], station_points[d.to_id]
        best: Optional[tuple[float, SimRobot, Way]] = None
        for r in robots:
            speed = max(0.1, r.speed_m_s)
            approach = route(pos[r.id], src)
            pickup = max(free_at[r.id], d.release_s) + approach.metres / speed
            if best is None or pickup < best[0] - 1e-9:
                best = (pickup, r, approach)
        if best is None:
            unserved += 1
            continue
        _, r, approach = best
        speed = max(0.1, r.speed_m_s)
        start = max(free_at[r.id], d.release_s)
        t = start
        if t >= horizon_s:
            unserved += 1
            continue
        segs = tracks[r.id]
        if approach.metres > 0:
            t1 = t + approach.metres / speed
            segs.append(Segment(r.id, t, t1, "leer", list(approach.points), d.id))
            empty[r.id] += approach.metres
            if not approach.exact:
                estimated.add((pos[r.id], src))
            t = t1
        wait = t - d.release_s
        half = max(0.0, r.handling_s) / 2
        segs.append(Segment(r.id, t, t + half, "laden", [], d.id))
        t += half
        carry = route(src, dst)
        t1 = t + carry.metres / speed
        segs.append(Segment(r.id, t, t1, "beladen", list(carry.points), d.id))
        loaded[r.id] += carry.metres
        if not carry.exact:
            estimated.add((src, dst))
        t = t1
        segs.append(Segment(r.id, t, t + half, "entladen", [], d.id))
        t += half
        busy[r.id] += t - start
        free_at[r.id] = t
        pos[r.id] = dst
        jobs[r.id] += 1
        served += 1
        waits.append(wait)
        if wait > late_after_s:
            late += 1

    # Begegnungen: Stichproben über die Schicht, je Paar höchstens eine je Minute.
    encounters = 0
    spots: dict[tuple[int, int], int] = {}
    ids = [r.id for r in robots]
    starts = {r.id: (float(r.start[0]), float(r.start[1])) for r in robots}
    if len(ids) > 1 and sample_s > 0:
        last_hit: dict[tuple[str, str], float] = {}
        steps = int(horizon_s // sample_s) if horizon_s else 0
        steps = min(steps, 20_000)
        step = horizon_s / steps if steps else 0
        for k in range(steps + 1):
            t = k * step
            where = {i: position_at(tracks[i], t, starts[i]) for i in ids}
            moving = {i for i in ids if any(s.t0 <= t <= s.t1 and s.points for s in tracks[i])}
            for a_i in range(len(ids)):
                for b_i in range(a_i + 1, len(ids)):
                    a, b = ids[a_i], ids[b_i]
                    # Nur wo beide fahren: zwei Roboter, die am selben Lager
                    # warten, sind keine Engstelle im Gang.
                    if a not in moving or b not in moving:
                        continue
                    pa, pb = where[a], where[b]
                    if math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < encounter_m:
                        if t - last_hit.get((a, b), -1e9) >= 60:
                            encounters += 1
                            last_hit[(a, b)] = t
                            cell = (int((pa[0] + pb[0]) / 2 // 4), int((pa[1] + pb[1]) / 2 // 4))
                            spots[cell] = spots.get(cell, 0) + 1
    hotspots = [{"x": cx * 4 + 2, "y": cy * 4 + 2, "count": n}
                for (cx, cy), n in sorted(spots.items(), key=lambda kv: -kv[1])[:6]]

    waits_sorted = sorted(waits)
    p90 = waits_sorted[min(len(waits_sorted) - 1, int(math.ceil(0.9 * len(waits_sorted))) - 1)] if waits_sorted else 0.0
    per_robot = [{
        "id": r.id, "name": r.name, "kind": r.kind, "planned": r.planned,
        "speed_m_s": r.speed_m_s, "start": [round(r.start[0], 3), round(r.start[1], 3)],
        "jobs": jobs[r.id], "busy_s": round(busy[r.id], 1),
        "utilisation": round(min(1.0, busy[r.id] / horizon_s), 3) if horizon_s else 0.0,
        "loaded_m": round(loaded[r.id], 1), "empty_m": round(empty[r.id], 1),
    } for r in robots]
    return SimResult(
        horizon_s=horizon_s, robots=per_robot, tracks=tracks, served=served, unserved=unserved,
        late=late, wait_mean_s=(sum(waits) / len(waits)) if waits else 0.0, wait_p90_s=p90,
        wait_max_s=max(waits) if waits else 0.0, loaded_m=sum(loaded.values()),
        empty_m=sum(empty.values()), encounters=encounters, hotspots=hotspots,
        estimated_ways=len(estimated), demands=len(demands),
    )


def size_fleet(
    template: SimRobot,
    base: Sequence[SimRobot],
    demands: Sequence[Demand],
    station_points: dict[int, Point],
    way: Callable[[Point, Point], Way],
    horizon_s: float,
    *,
    target_p90_s: float = 10 * 60,
    upto: int = MAX_SIZING,
) -> dict:
    """Wie viele geplante Roboter dieser Art braucht der Bedarf?

    Rechnet 1 … ``upto`` geplante Roboter zusätzlich zu ``base`` und nennt den
    kleinsten Bestand, der alles schafft und dessen 90-%-Wartezeit unter dem
    Ziel bleibt. ``None``, wenn auch ``upto`` nicht reicht.
    """
    rows: list[dict] = []
    pick: Optional[int] = None
    upto = max(1, min(int(upto), MAX_SIZING))
    for n in range(1, upto + 1):
        fleet = list(base) + [
            SimRobot(id=f"{template.id}-{k + 1}", name=f"{template.name} {k + 1}", kind=template.kind,
                     speed_m_s=template.speed_m_s,
                     start=(template.start[0] + 1.6 * (k % 4), template.start[1] + 1.6 * (k // 4)),
                     handling_s=template.handling_s)
            for k in range(n)
        ]
        res = simulate(fleet, demands, station_points, way, horizon_s, sample_s=0)
        ok = res.unserved == 0 and res.wait_p90_s <= target_p90_s
        util = [r["utilisation"] for r in res.robots if r["planned"]]
        rows.append({"planned": n, "served": res.served, "unserved": res.unserved,
                     "wait_p90_s": round(res.wait_p90_s, 1), "wait_mean_s": round(res.wait_mean_s, 1),
                     "utilisation": round(sum(util) / len(util), 3) if util else 0.0, "ok": ok})
        if ok and pick is None:
            pick = n
            # Einer mehr zeigt, was die Reserve bringt; danach ist Schluss.
            if n + 1 <= upto:
                continue
            break
        if pick is not None:
            break
    return {"target_p90_s": target_p90_s, "rows": rows, "recommended": pick}
