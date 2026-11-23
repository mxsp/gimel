"""Fahrplan für simulierte Roboter einer Ebene: nie zwei zu nah beieinander.

Bis 2026-11-07 fuhr jeder simulierte Roboter stur nach Startzeit und Tempo
seinen Weg; zwei Roboter auf sich kreuzenden oder gemeinsamen Gängen fuhren
durcheinander hindurch (Demo: AGV 1/AGV 2 rund 45 min, die beiden AMR in
Halle 2 rund 88 min am Tag näher als zwei Fahrzeugradien).

Rein: keine Datenbank, keine Uhr. Der Aufrufer reicht die Wege und Tempi
hinein und bekommt je Roboter einen periodischen Fahrplan zurück — eine
Liste von Stützpunkten ``(t, s)``: Zeit im Zyklus und gefahrene Strecke. Die
Lage zu einer Zeit ist dann ``pose_on_route(route, s(t mod P))``; Server und
Oberfläche rechnen dieselbe Funktion, ohne Zustand.

Regel (Vorfahrt nach Kennung, kleinste zuerst):
- Stehende Roboter (kein Weg, Tempo 0) sind feste Hindernisse.
- Ein Roboter fährt mit seinem Tempo. Er wartet nur an *sicheren Halten* —
  Wegpunkten, an denen ihm kein vorfahrtsberechtigter Roboter je näher als
  ``safe_m`` kommt — und fährt von dort erst los, wenn er die ganze Strecke
  bis zum nächsten sicheren Halt ohne Begegnung schafft. So wartet er nie
  mitten in einer Engstelle.
- Alle Roboter einer Ebene teilen einen Zyklus ``P``: wer früher fertig ist,
  wartet am Start. Gelingt das nicht, wird ``P`` länger; gelingt es auch dann
  nicht, bleibt der Roboter an seinem sichersten Halt stehen (``parked``) —
  ehrlich still statt durch einen anderen hindurch.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional, Sequence

import numpy as np

from .robot import pose_on_route, route_length_m

#: Mittenabstand, den der Plan hält (Radius 0,72 m je Fahrzeug + Luft).
SAFE_M = 1.8
#: Zeitschritt des Plans in Sekunden.
DT_S = 0.25
#: Abtastung der Haltepunkte entlang des Weges in Metern.
STEP_M = 0.25
#: Vielfache des längsten Eigenzyklus, die versucht werden.
STRETCH = (1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0)

Point = tuple[float, float]


@dataclass(frozen=True)
class TrafficRobot:
    id: int
    route: tuple[Point, ...]
    loop: bool
    speed_m_s: float


@dataclass
class Plan:
    """Fahrplan eines Roboters. ``keys`` sind Stützpunkte (t s, Strecke m) über
    genau einen Zyklus, beginnend bei t = 0 und endend bei t = ``period_s``."""

    robot_id: int
    period_s: float
    keys: list[tuple[float, float]]
    cycle_m: float
    wait_s: float = 0.0
    parked: bool = False
    note: str = ""

    def as_dict(self) -> dict:
        return {
            "period_s": round(self.period_s, 3),
            "keys": [[round(t, 3), round(s, 3)] for t, s in self.keys],
            "cycle_m": round(self.cycle_m, 3),
            "wait_s": round(self.wait_s, 1),
            "parked": self.parked,
            "note": self.note,
        }


@dataclass
class TrafficResult:
    plans: dict[int, Plan] = field(default_factory=dict)
    period_s: float = 0.0
    min_gap_m: Optional[float] = None


def distance_at(plan: Plan, t: float) -> float:
    """Gefahrene Strecke zur Zeit ``t`` (beliebig, periodisch)."""
    keys = plan.keys
    if not keys:
        return 0.0
    if plan.period_s <= 0 or len(keys) == 1:
        return keys[0][1]
    u = t % plan.period_s
    lo, hi = 0, len(keys) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if keys[mid][0] <= u:
            lo = mid
        else:
            hi = mid
    (t0, s0), (t1, s1) = keys[lo], keys[hi]
    if t1 <= t0:
        return s1
    return s0 + (s1 - s0) * max(0.0, min(1.0, (u - t0) / (t1 - t0)))


def moving_at(plan: Plan, t: float) -> bool:
    """Fährt der Roboter zur Zeit ``t`` (oder wartet er)?"""
    if plan.parked or plan.period_s <= 0 or len(plan.keys) < 2:
        return False
    u = t % plan.period_s
    for (t0, s0), (t1, s1) in zip(plan.keys, plan.keys[1:]):
        if t0 <= u <= t1:
            return s1 - s0 > 1e-6 and t1 > t0
    return False


def _pos(r: TrafficRobot, s: float) -> Point:
    p = pose_on_route(list(r.route), s, loop=r.loop)
    return (p.x, p.y) if p else r.route[0]


def _positions(r: TrafficRobot, ss) -> np.ndarray:
    """Lage für viele Strecken auf einmal — dieselbe Regel wie ``pose_on_route``
    (Rundkurs oder Hin und zurück, auf 4 Stellen gerundet), ohne Python-Schleife je Punkt."""
    ss = np.asarray(ss, dtype=float)
    pts = [tuple(map(float, p)) for p in r.route]
    pairs = list(zip(pts, pts[1:]))
    if r.loop and len(pts) >= 2 and math.dist(pts[-1], pts[0]) > 1e-9:
        pairs.append((pts[-1], pts[0]))
    segs = [(a, b, math.dist(a, b)) for a, b in pairs]
    segs = [g for g in segs if g[2] > 1e-9]
    total = sum(g[2] for g in segs)
    if not segs or total <= 1e-9:
        return np.tile(np.array(pts[0] if pts else (0.0, 0.0)), (len(ss), 1))
    if r.loop:
        d = ss % total
    else:
        period = total * 2.0
        d = ss % period
        d = np.where(d > total, period - d, d)
    length = np.array([g[2] for g in segs])
    end = np.cumsum(length)
    run = end - length
    idx = np.minimum(np.searchsorted(end, d - 1e-12, side="left"), len(segs) - 1)
    u = np.clip((d - run[idx]) / length[idx], 0.0, 1.0)
    a = np.array([g[0] for g in segs])[idx]
    b = np.array([g[1] for g in segs])[idx]
    return np.round(a + (b - a) * u[:, None], 4)


def _distances(plan: Plan, ts) -> np.ndarray:
    """``distance_at`` für viele Zeiten auf einmal."""
    ts = np.asarray(ts, dtype=float)
    keys = plan.keys
    if not keys:
        return np.zeros(len(ts))
    if plan.period_s <= 0 or len(keys) == 1:
        return np.full(len(ts), keys[0][1])
    kt = np.array([k[0] for k in keys])
    ks = np.array([k[1] for k in keys])
    return np.interp(ts % plan.period_s, kt, ks)


def _compress(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Kollineare Stützpunkte zusammenfassen (gleiche Geschwindigkeit)."""
    if len(points) <= 2:
        return points
    out = [points[0]]
    for i in range(1, len(points) - 1):
        (ta, sa), (tb, sb), (tc, sc) = out[-1], points[i], points[i + 1]
        v1 = (sb - sa) / (tb - ta) if tb > ta else 0.0
        v2 = (sc - sb) / (tc - tb) if tc > tb else 0.0
        if abs(v1 - v2) > 1e-6:
            out.append(points[i])
    out.append(points[-1])
    return out


def _plan_one(r: TrafficRobot, period: float, others: list[list[Point]], steps: int,
              safe_m: float) -> Optional[tuple[list[tuple[float, float]], float]]:
    """Ein Roboter gegen die schon geplanten (``others``: Lage je Zeitschritt).

    Raum-Zeit-Suche: Zellen entlang des Weges im Abstand eines Zeitschritts bei
    vollem Tempo, je Schritt „weiter" oder „warten" — beides nur, wo zu dieser
    Zeit kein anderer näher als ``safe_m`` ist. Rückwärts wird ausgerechnet, von
    wo das Zyklusende (wieder am Start) erreichbar ist; vorwärts fährt der
    Roboter, so früh es geht, und wartet nur, wenn Weiterfahren ins Aus führte.
    """
    cycle = route_length_m(list(r.route), loop=r.loop) * (1.0 if r.loop else 2.0)
    v = r.speed_m_s
    ds = v * DT_S
    n = max(1, int(math.ceil(cycle / ds - 1e-9)))
    if n > steps:
        return None
    lim = safe_m * safe_m
    if others:
        ox = np.array([[t[k][0] for k in range(steps)] for t in others], dtype=float)
        oy = np.array([[t[k][1] for k in range(steps)] for t in others], dtype=float)
    else:
        ox = oy = np.zeros((0, steps))

    def clear_grid(px: np.ndarray, py: np.ndarray, ks: np.ndarray) -> np.ndarray:
        """frei[k, i]: Punkt i ist zur Zeit ks[k] von allen anderen weit genug entfernt."""
        out = np.ones((len(ks), len(px)), dtype=bool)
        kk = ks % steps
        for m in range(ox.shape[0]):
            dx = px[None, :] - ox[m, kk][:, None]
            dy = py[None, :] - oy[m, kk][:, None]
            out &= ~(dx * dx + dy * dy < lim)
        return out

    # Startpunkte: frei zu t = 0, möglichst oft frei über den Zyklus.
    probe = max(1, int(cycle // 1.0))
    starts = [j * cycle / probe for j in range(probe)]
    sp = _positions(r, starts)
    ks_probe = np.arange(0, steps, 4)
    free = clear_grid(sp[:, 0], sp[:, 1], ks_probe)          # (Zeiten, Startpunkte)
    at0 = clear_grid(sp[:, 0], sp[:, 1], np.array([0]))[0]
    counts = free.sum(axis=0)
    scored = [(-int(counts[j]), j, starts[j]) for j in range(probe) if at0[j]]
    scored.sort()
    for _score, _j, s0 in scored[:6]:
        cells = _positions(r, s0 + np.minimum(np.arange(n + 1) * ds, cycle))
        ok = clear_grid(cells[:, 0], cells[:, 1], np.arange(steps + 1))   # (steps+1, n+1)
        # feas[k][i]: von Zelle i zur Zeit k ist das Zyklusende erreichbar.
        feas = np.zeros((steps + 1, n + 1), dtype=bool)
        feas[steps, n] = ok[steps, n]
        for k in range(steps - 1, -1, -1):
            reach = feas[k + 1].copy()
            reach[:-1] |= feas[k + 1, 1:]
            feas[k] = ok[k] & reach
        if not feas[0, 0]:
            continue
        keys: list[tuple[float, float]] = [(0.0, s0)]
        i, waited = 0, 0.0
        for k in range(steps):
            if i < n and feas[k + 1, i + 1]:
                i += 1
            else:
                waited += DT_S
            keys.append(((k + 1) * DT_S, s0 + min(i * ds, cycle)))
        keys[-1] = (period, s0 + cycle)
        return _compress(keys), waited
    return None


def plan_floor(robots: Sequence[TrafficRobot], *, safe_m: float = SAFE_M) -> TrafficResult:
    """Fahrpläne für alle simulierten Roboter einer Ebene.

    Wer keinen begegnungsfreien Fahrplan bekommt, bleibt stehen — und ist dann
    für alle anderen ein Hindernis (sonst führe ein vorfahrtsberechtigter
    Roboter durch ihn hindurch). Danach wird ohne ihn neu geplant. Zuletzt
    prüft ``min_gap`` fein (0,1 s); liegt der Abstand zwischen den Schritten
    unter dem Ziel, wird mit mehr Luft neu geplant.
    """
    movers: list[TrafficRobot] = []
    fixed: list[TrafficRobot] = []
    for r in sorted(robots, key=lambda x: x.id):
        length = route_length_m(list(r.route), loop=r.loop) if len(r.route) >= 2 else 0.0
        if length > 1e-6 and r.speed_m_s > 1e-6:
            movers.append(r)
        elif r.route:
            fixed.append(r)
    out = TrafficResult()
    for r in fixed:
        out.plans[r.id] = Plan(r.id, 0.0, [(0.0, 0.0)], 0.0, parked=True, note="steht")
    if not movers:
        return out

    margin = safe_m
    plans: dict[int, Plan] = {}
    period, gap = 0.0, None
    for _attempt in range(3):
        parked: dict[int, Plan] = {}
        for _round in range(len(movers) + 1):
            active = [r for r in movers if r.id not in parked]
            plans, period, newly = _plan_round(active, fixed, parked, movers, margin)
            if not newly:
                break
            parked.update(newly)
        plans.update(parked)
        gap = min_gap(movers + fixed, {**out.plans, **plans})
        if gap is None or gap >= safe_m - 0.15 or margin > safe_m + 0.5:
            break
        margin += 0.3
    out.plans.update(plans)
    out.period_s = period
    out.min_gap_m = gap
    return out


def _plan_round(active: list[TrafficRobot], fixed: list[TrafficRobot], parked: dict[int, Plan],
                movers: list[TrafficRobot], safe_m: float
                ) -> tuple[dict[int, Plan], float, dict[int, Plan]]:
    """Eine Runde: Stehende und Geparkte sind Hindernisse, die übrigen nach Vorfahrt.
    Gibt die Pläne, den Zyklus und den in dieser Runde neu Geparkten zurück."""
    if not active:
        return {}, 0.0, {}
    natural = max(route_length_m(list(r.route), loop=r.loop) * (1 if r.loop else 2) / r.speed_m_s
                  for r in active)
    base = math.ceil(natural / DT_S) * DT_S
    by_id = {r.id: r for r in movers}
    best: Optional[tuple[dict[int, Plan], float, dict[int, Plan]]] = None
    for stretch in STRETCH:
        period = math.ceil(base * stretch / DT_S) * DT_S
        steps = int(round(period / DT_S))
        tracks_fixed: list[list[Point]] = [[r.route[0]] * steps for r in fixed]
        # Geparkte Roboter sind Hindernisse — aber nur für Roboter mit geringerer
        # Vorfahrt (größere Kennung). Einem vorfahrtsberechtigten Roboter (kleinere
        # Kennung) darf ein geparkter mit höherer Kennung nicht den Weg versperren:
        # sonst breiten sich die Geparkten kaskadenartig aus und die ganze Flotte
        # stünde.
        parked_tracks: dict[int, list[list[Point]]] = {}
        for rid, p in parked.items():
            parked_tracks[rid] = [[_pos(by_id[rid], p.keys[0][1])] * steps]
        plans: dict[int, Plan] = {}
        newly: dict[int, Plan] = {}
        planned_tracks: list[list[Point]] = []
        for r in active:
            tracks: list[list[Point]] = [list(t) for t in tracks_fixed]
            for pid, tr in parked_tracks.items():
                if pid < r.id:
                    tracks.extend(tr)
            tracks.extend(planned_tracks)
            got = _plan_one(r, period, tracks, steps, safe_m)
            cycle = route_length_m(list(r.route), loop=r.loop) * (1.0 if r.loop else 2.0)
            if got is None:
                newly[r.id] = _park(r, tracks, steps, cycle, safe_m)
                parked_tracks[r.id] = [[_pos(r, newly[r.id].keys[0][1])] * steps]
                continue
            keys, waited = got
            plans[r.id] = Plan(r.id, period, keys, cycle, wait_s=waited)
            planned_tracks.append([tuple(q) for q in _positions(r, _distances(plans[r.id], np.arange(steps) * DT_S)).tolist()])
        if not newly:
            return plans, period, {}
        if best is None or len(newly) < len(best[2]):
            best = (plans, period, newly)
    assert best is not None
    # Nur den Ersten der Gescheiterten parken; die Übrigen bekommen ohne ihn eine neue Chance.
    first = min(best[2])
    return best[0], best[1], {first: best[2][first]}


def _park(r: TrafficRobot, tracks: list[list[Point]], steps: int, cycle: float, safe_m: float) -> Plan:
    """Kein begegnungsfreier Fahrplan: am Wegpunkt mit dem größten Abstand stehen bleiben."""
    n_s = max(1, int(math.ceil(cycle / STEP_M)))
    ss = np.arange(n_s) * cycle / n_s
    pos = _positions(r, ss)
    gap = np.full(n_s, 1e9)
    for t in tracks:
        tr = np.array([t[k] for k in range(0, steps, 4)], dtype=float)
        d = np.sqrt(((pos[:, None, :] - tr[None, :, :]) ** 2).sum(axis=2)).min(axis=1)
        gap = np.minimum(gap, d)
    # erster größter Abstand, wie die frühere Schleife mit ``>``
    best_s = float(ss[int(np.argmax(gap))])
    return Plan(r.id, 0.0, [(0.0, best_s)], cycle, parked=True,
                note="wartet: kein begegnungsfreier Fahrplan")


def min_gap(robots: Sequence[TrafficRobot], plans: dict[int, Plan], *, dt: float = 0.1) -> Optional[float]:
    """Kleinster Mittenabstand zweier Roboter über einen ganzen Zyklus (Prüfung)."""
    period = max((p.period_s for p in plans.values()), default=0.0)
    rs = [r for r in robots if r.id in plans]
    if len(rs) < 2:
        return None
    worst = math.inf
    n = max(1, int(round((period or 1.0) / dt)))
    ts = np.arange(n) * dt
    xy = np.stack([
        _positions(r, _distances(plans[r.id], ts)) if len(r.route) else np.zeros((n, 2))
        for r in rs
    ])                                              # (Roboter, Zeiten, 2)
    worst = math.inf
    for i in range(len(rs)):
        for j in range(i + 1, len(rs)):
            worst = min(worst, float(np.sqrt(((xy[i] - xy[j]) ** 2).sum(axis=1)).min()))
    return worst
