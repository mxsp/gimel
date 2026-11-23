"""Kerf — true-shape nesting, Python port of the Kerf sandbox engine 1.4.0.

Same job and result format as the sandbox (camelCase keys), and with ``maxSteps``
set the same placements for the same seed: ``tests/core/test_kerf.py`` holds the
results of the JavaScript original. Without a budget in steps the run depends on
the clock and is not reproducible.

How it works: every part is rasterised per rotation, conservatively, so disjoint
cells mean real clearance. A part is stored twice, as body and as halo grown by
its own spacing, and a position is legal when halo(new) misses every body and
body(new) misses every halo. Placement is bottom-left greedy, the search is
simulated annealing over part order and rotation, and the last 30 % of the budget
runs on a grid half the size. ``verify`` re-checks a layout with exact polygons.

One difference to the original, for speed in Python, with identical decisions:
instead of testing masks against an occupancy grid, each variant keeps a map of
forbidden offsets on each sheet. A placed part adds its raster no-fit polygon to
that map, computed once per pair of variants and applied only when the variant is
next searched. ``part["rotations"]`` is an addition: a per-part list that replaces
the job's rotations (a ring needs one, not four).

Pure: no database, no I/O, no clock. A job with ``timeLimit`` needs ``clock`` from
the caller (milliseconds); Gimel's plans use ``maxSteps`` so they stay reproducible.
"""

from __future__ import annotations

import math
from typing import Callable, Optional

import numpy as np

KERF_VERSION = "1.4.0"
_NFP_CACHE_BYTES = 512 * 1024 * 1024


# ---------------- geometry ----------------
def _trig(deg: float) -> tuple[float, float]:
    d = ((deg % 360) + 360) % 360
    if d == 0:
        return 1.0, 0.0
    if d == 90:
        return 0.0, 1.0
    if d == 180:
        return -1.0, 0.0
    if d == 270:
        return 0.0, -1.0
    t = d * math.pi / 180
    return math.cos(t), math.sin(t)


def rot_ring(ring: list, deg: float) -> list:
    c, s = _trig(deg)
    return [[p[0] * c - p[1] * s, p[0] * s + p[1] * c] for p in ring]


def _ring_area(ring: list) -> float:
    a = 0.0
    j = len(ring) - 1
    for i in range(len(ring)):
        a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
        j = i
    return a / 2


def shape_area(shape: dict) -> float:
    a = abs(_ring_area(shape["outer"]))
    for h in shape.get("holes") or []:
        a -= abs(_ring_area(h))
    return a


def bbox(ring: list) -> dict:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return {"minx": min(xs), "miny": min(ys), "maxx": max(xs), "maxy": max(ys)}


def _rotated_normalized(part: dict, deg: float) -> dict:
    outer = rot_ring(part["outer"], deg)
    holes = [rot_ring(h, deg) for h in part.get("holes") or []]
    b = bbox(outer)

    def f(ring: list) -> list:
        return [[p[0] - b["minx"], p[1] - b["miny"]] for p in ring]

    return {"outer": f(outer), "holes": [f(h) for h in holes],
            "w": b["maxx"] - b["minx"], "h": b["maxy"] - b["miny"],
            "offx": b["minx"], "offy": b["miny"]}


def _swap_shape(s: dict) -> dict:
    def f(ring: list) -> list:
        return [[p[1], p[0]] for p in ring]

    return {"outer": f(s["outer"]), "holes": [f(h) for h in s["holes"]],
            "w": s["h"], "h": s["w"]}


def _edges_of(shape: dict) -> np.ndarray:
    out = []
    for ring in [shape["outer"], *shape["holes"]]:
        n = len(ring)
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            out.append((a[0], a[1], b[0], b[1]))
    return np.array(out, dtype=np.float64).reshape(-1, 4)


def _pt_seg_d2(px, py, ax, ay, bx, by):
    """Squared distance point to segment; all arguments broadcast."""
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    with np.errstate(divide="ignore", invalid="ignore"):
        t = np.where(length > 0, ((px - ax) * dx + (py - ay) * dy) / length, 0.0)
    t = np.clip(t, 0.0, 1.0)
    qx, qy = ax + t * dx - px, ay + t * dy - py
    return qx * qx + qy * qy


def _pt_box_d2(px, py, x0, y0, x1, y1):
    dx = np.where(px < x0, x0 - px, np.where(px > x1, px - x1, 0.0))
    dy = np.where(py < y0, y0 - py, np.where(py > y1, py - y1, 0.0))
    return dx * dx + dy * dy


def _seg_box_d2(ax, ay, bx, by, x0, y0, x1, y1):
    """Squared distance segment to box, 0 when they touch (Liang-Barsky)."""
    dx, dy = bx - ax, by - ay
    t0 = np.zeros(np.broadcast(ax, x0).shape)
    t1 = np.ones_like(t0)
    hit = np.ones_like(t0, dtype=bool)
    for p, q in ((-dx, ax - x0), (dx, x1 - ax), (-dy, ay - y0), (dy, y1 - ay)):
        with np.errstate(divide="ignore", invalid="ignore"):
            t = q / p
        hit &= ~((p == 0) & (q < 0))
        t0 = np.where(p < 0, np.maximum(t0, t), t0)
        t1 = np.where(p > 0, np.minimum(t1, t), t1)
    hit &= t0 <= t1
    d = _pt_box_d2(ax, ay, x0, y0, x1, y1)
    d = np.minimum(d, _pt_box_d2(bx, by, x0, y0, x1, y1))
    for cx, cy in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
        d = np.minimum(d, _pt_seg_d2(cx, cy, ax, ay, bx, by))
    return np.where(hit, 0.0, d)


def _rasterize(shape: dict, cell: float, sp: float) -> tuple[np.ndarray, np.ndarray, int]:
    """Conservative raster: body cell = the part reaches into the cell, halo
    cell = the part grown by ``sp`` reaches into it. Returns body, halo, pad."""
    edges = _edges_of(shape)
    pad = math.ceil(sp / cell) + 1
    mw = math.ceil(shape["w"] / cell - 1e-9) + 2 * pad
    mh = math.ceil(shape["h"] / cell - 1e-9) + 2 * pad
    e = cell * 1e-6
    hd = (cell - 2 * e) * math.sqrt(0.5)
    sp2 = sp * sp
    two = sp > 0
    ax, ay, bx, by = (edges[:, k] for k in range(4))
    idx = np.arange(mw, dtype=np.float64)
    x0 = (idx - pad) * cell + e
    x1 = (idx - pad + 1) * cell - e
    cx = (x0 + x1) / 2
    body = np.zeros((mh, mw), dtype=bool)
    halo = np.zeros((mh, mw), dtype=bool) if two else body
    for j in range(mh):
        y0 = (j - pad) * cell + e
        y1 = (j - pad + 1) * cell - e
        cy = (y0 + y1) / 2
        crossing = (ay > cy) != (by > cy)
        xs = np.sort(ax[crossing] + (cy - ay[crossing]) * (bx[crossing] - ax[crossing])
                     / (by[crossing] - ay[crossing]))
        inside = (np.searchsorted(xs, cx, side="left") % 2).astype(bool)
        body[j] = inside
        if two:
            halo[j] = inside
        rest = np.nonzero(~inside)[0]
        if not rest.size:
            continue
        d2 = _pt_seg_d2(cx[rest, None], cy, ax[None], ay[None], bx[None], by[None]).min(axis=1)
        dc = np.sqrt(d2)
        near = rest[(dc - hd < sp) | (dc <= hd)]
        if not near.size:
            continue
        dm = _seg_box_d2(ax[None], ay[None], bx[None], by[None],
                         x0[near, None], y0, x1[near, None], y1).min(axis=1)
        hb = dm == 0
        body[j, near] = hb
        if two:
            halo[j, near] = hb | (dm < sp2)
    return body, halo, pad


def _runs(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Row, start and end (exclusive) of every run of set cells."""
    d = np.diff(mask.astype(np.int8), axis=1, prepend=0, append=0)
    rows, starts = np.nonzero(d == 1)
    _, ends = np.nonzero(d == -1)
    return rows, starts, ends


def _mulberry32(a: int) -> Callable[[], float]:
    state = [a & 0xFFFFFFFF]

    def imul(x: int, y: int) -> int:
        return (x * y) & 0xFFFFFFFF

    def rng() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        s = state[0]
        t = imul(s ^ (s >> 15), 1 | s)
        t = (((t + imul(t ^ (t >> 7), 61 | t)) & 0xFFFFFFFF) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rng


def nice_cell(long_side: float, target: float) -> float:
    raw = long_side / target
    for s in (0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100):
        if s >= raw * 0.999:
            return float(s)
    return 100.0


def _lim(v, default):
    if v is None or v == "":
        return default
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return x if x > 0 else default


class _Variant:
    __slots__ = ("vid", "deg", "ns", "w", "h", "body", "halo", "pad", "cells",
                 "body_runs", "halo_runs", "ox_min", "ox_max", "oy_min", "oy_max", "ok")


class _Sheet:
    """One sheet during an evaluation. ``maps[vid]`` holds, per offset of that
    variant, whether a part already placed forbids it; ``applied[vid]`` says how
    many of ``placed`` are in the map, ``start[vid]`` the rows known to be full."""

    __slots__ = ("placed", "maps", "applied", "start", "extent", "area", "count")

    def __init__(self) -> None:
        self.placed: list = []
        self.maps: dict = {}
        self.applied: dict = {}
        self.start: dict = {}
        self.extent = 0.0
        self.area = 0.0
        self.count = 0


class _Ctx:
    """Everything that depends on the grid: masks, no-fit polygons, evaluation."""

    def __init__(self, job: "_Job", cell: float, now: Callable[[], float]) -> None:
        tp = now()
        self.job, self.cell = job, cell
        self.types = []
        nvar = 0
        for ti, p in enumerate(job.parts):
            sh = {"outer": p["outer"], "holes": p.get("holes") or []}
            sp = job.part_spacing(p)
            variants = []
            for deg in job.part_rotations[ti]:
                ns = _rotated_normalized(sh, deg)
                rs = _swap_shape(ns) if job.left else ns
                v = _Variant()
                v.deg, v.ns, v.w, v.h = deg, ns, rs["w"], rs["h"]
                v.body, v.halo, v.pad = _rasterize(rs, cell, sp)
                v.cells = int(v.body.sum())
                v.body_runs = _runs(v.body)
                v.halo_runs = v.body_runs if v.halo is v.body else _runs(v.halo)
                v.ox_min = math.ceil(job.margin / cell - 1e-9)
                v.ox_max = math.floor((job.sw - job.margin - v.w) / cell + 1e-9)
                v.oy_min = math.ceil(job.margin / cell - 1e-9)
                v.oy_max = math.floor((job.sh - job.margin - v.h) / cell + 1e-9)
                v.ok = v.ox_max >= v.ox_min and v.oy_max >= v.oy_min
                v.vid = nvar
                nvar += 1
                variants.append(v)
            b = bbox(p["outer"])
            pid = p.get("id")
            self.types.append({
                "id": pid if pid is not None else str(ti), "name": p.get("name") or pid,
                "spacing": sp, "area": shape_area(sh),
                "bw": b["maxx"] - b["minx"], "bh": b["maxy"] - b["miny"],
                "variants": variants, "ok": [v for v in variants if v.ok],
                "fits_empty": any(v.ok for v in variants)})
        pad = max([1] + [v.pad for t in self.types for v in t["variants"]]) + 2
        self.gw = math.ceil(job.sw / cell) + 2 * pad
        self.gh = math.ceil(job.sh / cell) + 2 * pad
        if self.gw * self.gh > 2.5e7:
            raise ValueError(
                f"A {cell} mm grid gives {round(self.gw * self.gh / 1e6)} M cells per sheet, "
                "too many to search. Use a coarser grid cell.")
        self.nfp: dict = {}
        self.nfp_bytes = 0
        self.prep_ms = now() - tp

    def _pair_nfp(self, a: _Variant, b: _Variant) -> tuple:
        """Offsets of ``b`` relative to ``a`` that collide, with the lowest offset."""
        key = (a.vid, b.vid)
        got = self.nfp.get(key)
        if got is not None:
            return got
        bh, bw = b.body.shape
        mh, mw = a.body.shape[0] + bh - 1, a.body.shape[1] + bw - 1

        def corr(x: tuple, y: tuple) -> np.ndarray:
            # Every pair of runs collides on one interval of offsets. The intervals
            # go into a difference array; exact, and much faster here than an FFT.
            ry, sx, ex = x
            ru, su, eu = y
            rows = ry[:, None] + (bh - 1 - ru)[None]
            lo = (rows * (mw + 1) + (sx[:, None] + bw - eu[None])).ravel()
            hi = (rows * (mw + 1) + (ex[:, None] + bw - 1 - su[None])).ravel()
            size = mh * (mw + 1)
            d = np.bincount(lo, minlength=size) - np.bincount(hi, minlength=size)
            return np.cumsum(d.reshape(mh, mw + 1), axis=1)[:, :mw] > 0

        hit = corr(a.body_runs, b.halo_runs)
        if a.halo is not a.body or b.halo is not b.body:
            hit = hit | corr(a.halo_runs, b.body_runs)
        dx0 = 1 - b.body.shape[1] - a.pad + b.pad
        dy0 = 1 - b.body.shape[0] - a.pad + b.pad
        got = (hit, dx0, dy0)
        if self.nfp_bytes + hit.size > _NFP_CACHE_BYTES:
            self.nfp.clear()
            self.nfp_bytes = 0
        self.nfp[key] = got
        self.nfp_bytes += hit.size
        return got

    def _map_for(self, sh: _Sheet, v: _Variant) -> np.ndarray:
        m = sh.maps.get(v.vid)
        if m is None:
            m = np.zeros((v.oy_max - v.oy_min + 1, v.ox_max - v.ox_min + 1), dtype=bool)
            sh.maps[v.vid] = m
            sh.applied[v.vid] = 0
            sh.start[v.vid] = 0
        done = sh.applied[v.vid]
        if done < len(sh.placed):
            ny, nx = m.shape
            for a, ax, ay in sh.placed[done:]:
                hit, dx0, dy0 = self._pair_nfp(a, v)
                x0 = ax + dx0 - v.ox_min
                y0 = ay + dy0 - v.oy_min
                left, top = max(0, -x0), max(0, -y0)
                right = min(hit.shape[1], nx - x0)
                bottom = min(hit.shape[0], ny - y0)
                if left < right and top < bottom:
                    m[y0 + top:y0 + bottom, x0 + left:x0 + right] |= hit[top:bottom, left:right]
            sh.applied[v.vid] = len(sh.placed)
        return m

    def _search(self, sh: _Sheet, variants: list) -> Optional[dict]:
        best = None
        cell = self.cell
        for v in variants:
            m = self._map_for(sh, v)
            ny = m.shape[0]
            row = sh.start[v.vid]
            stop = ny
            if best is not None:
                # higher rows cannot beat the best top edge
                stop = min(ny, int((best["top"] + 1e-9 - v.h) / cell) - v.oy_min + 2)
            found = -1
            while row < stop:
                end = min(stop, row + 64)
                blocked = m[row:end].all(axis=1)
                k = int(np.argmin(blocked))
                if not blocked[k]:
                    row += k
                    found = row
                    break
                row = end
            sh.start[v.vid] = row
            if found < 0:
                continue
            oy = found + v.oy_min
            top = oy * cell + v.h
            if best is not None and top > best["top"] + 1e-9:
                continue
            ox = int(np.argmin(m[found])) + v.ox_min
            if (best is None or top < best["top"] - 1e-9
                    or (abs(top - best["top"]) <= 1e-9
                        and (ox < best["ox"]
                             or (ox == best["ox"] and v.cells < best["v"].cells)))):
                best = {"v": v, "ox": ox, "oy": oy, "top": top}
        return best

    def evaluate(self, g: dict) -> dict:
        job, types, inst = self.job, self.types, self.job.inst
        sheets: list[_Sheet] = []
        recs: list[dict] = []
        unplaced: list[int] = []

        def commit(s: int, b: dict, idx: int, t: dict) -> None:
            sh = sheets[s]
            sh.placed.append((b["v"], b["ox"], b["oy"]))
            sh.extent = max(sh.extent, b["top"])
            sh.area += t["area"]
            sh.count += 1
            recs.append({"idx": idx, "s": s, "v": b["v"], "ox": b["ox"], "oy": b["oy"]})

        for idx in g["order"]:
            t = types[inst[idx][0]]
            if not t["fits_empty"]:
                unplaced.append(idx)
                continue
            ri = g["rot"][idx]
            pinned = ri >= 0 and ri < len(t["variants"]) and t["variants"][ri].ok
            variants = [t["variants"][ri]] if pinned else t["ok"]
            done = False
            for s in range(len(sheets)):
                b = self._search(sheets[s], variants)
                if b:
                    commit(s, b, idx, t)
                    done = True
                    break
            if done:
                continue
            if len(sheets) >= job.max_sheets:
                unplaced.append(idx)
                continue
            sheets.append(_Sheet())
            b = self._search(sheets[-1], variants)
            if b:
                commit(len(sheets) - 1, b, idx, t)
            else:
                unplaced.append(idx)
        ls = sheets[-1] if sheets else None
        last = ls.extent if ls else 0.0
        # with several sheets the last one is scored by the material still on it,
        # which pulls the search toward emptying it into gaps on earlier sheets
        tail = 0.0 if not ls else (ls.area / job.sw + 0.25 * last
                                   if len(sheets) > 1 and job.ms_area else last)
        lost = sum(types[inst[i][0]]["area"] for i in unplaced)
        fitness = ((lost / job.total_area if job.total_area > 0 else 0) * 1e12
                   + (1e10 if unplaced else 0) + max(0, len(sheets) - 1) * 1e7 + tail)
        return {"g": g, "ctx": self, "fitness": fitness,
                "sheets": [{"extent": s.extent, "area": s.area, "count": s.count} for s in sheets],
                "recs": recs, "unplaced": unplaced}


class _Job:
    def __init__(self, job: dict) -> None:
        self.w, self.h = float(job["sheet"]["width"]), float(job["sheet"]["height"])
        self.spacing = max(0.0, float(job.get("spacing") or 0))
        self.margin = max(0.0, float(job.get("margin") or 0))
        rots = job.get("rotations") or [0]
        self.rotations = list(dict.fromkeys(((float(r) % 360) + 360) % 360 for r in rots))
        self.left = (job.get("gravity") or "left") == "left"
        self.sw, self.sh = (self.h, self.w) if self.left else (self.w, self.h)
        self.ms_area = job.get("_msArea") is not False
        self.parts = job["parts"]
        self.part_rotations = []
        for p in self.parts:
            own = p.get("rotations")
            self.part_rotations.append(
                list(dict.fromkeys(((float(r) % 360) + 360) % 360 for r in own))
                if own else self.rotations)
        self.time_limit = _lim(job.get("timeLimit"), math.inf)
        steps = job.get("maxSteps") if job.get("maxSteps") is not None else job.get("maxIterations")
        self.max_steps = _lim(steps, math.inf)
        self.stall_steps = _lim(job.get("stallSteps"), math.inf)
        self.max_sheets = _lim(job.get("maxSheets"), math.inf)
        self.inst = []
        for ti, p in enumerate(self.parts):
            for k in range(max(0, int(float(p.get("quantity") or 0)))):
                self.inst.append((ti, k))
        self.total_area = sum(
            shape_area({"outer": self.parts[t]["outer"], "holes": self.parts[t].get("holes") or []})
            for t, _ in self.inst)

    def part_spacing(self, p: dict) -> float:
        s = p.get("spacing")
        if s is not None and s != "" and float(s) >= 0:
            return float(s)
        return self.spacing


def nest(job: dict, on_progress: Optional[Callable[[dict, dict], None]] = None,
         clock: Optional[Callable[[], float]] = None) -> dict:
    """Nest one job. One step is one full layout evaluation; the run ends at
    ``maxSteps``, ``timeLimit`` or after ``stallSteps`` without a better layout.
    ``clock`` returns milliseconds; without it ``timeLimit`` is refused and the
    time figures in the result stay 0."""
    now = clock or (lambda: 0.0)
    t0 = now()
    j = _Job(job)
    if not math.isinf(j.time_limit) and clock is None:
        raise ValueError("timeLimit needs a clock; use maxSteps for a reproducible run")
    base_cell = float(job["cell"]) if job.get("cell") and float(job["cell"]) > 0 \
        else nice_cell(max(j.w, j.h), 600)
    seed = int(float(job.get("seed") or 1)) & 0xFFFFFFFF or 1
    rng = _mulberry32(seed)

    def rint(n: int) -> int:
        return math.floor(rng() * n)

    inst, n = j.inst, len(j.inst)
    n_rot = max((len(r) for r in j.part_rotations), default=1)
    state = {"step": 0, "prep": 0.0, "best": None, "last": 0.0, "stop": "done"}
    history: list = []
    phases: list = []

    def elapsed() -> float:
        return now() - t0

    def out_of_budget() -> bool:
        if state["step"] >= j.max_steps:
            state["stop"] = "steps"
            return True
        if j.time_limit - elapsed() <= 0:
            state["stop"] = "time"
            return True
        return False

    def build(ev: dict, extra: dict) -> dict:
        ctx = ev["ctx"]
        cell, types = ctx.cell, ctx.types
        placements = []
        for r in ev["recs"]:
            v = r["v"]
            ux, uy = r["ox"] * cell, r["oy"] * cell
            x, y = (uy, ux) if j.left else (ux, uy)
            ti, k = inst[r["idx"]]
            placements.append({
                "partId": types[ti]["id"], "partIndex": ti, "instance": k, "sheet": r["s"],
                "rotation": v.deg, "x": x, "y": y, "width": v.ns["w"], "height": v.ns["h"],
                "tx": x - v.ns["offx"], "ty": y - v.ns["offy"]})
        count = len(ev["sheets"])
        sheet_area = j.w * j.h
        other, along = (j.h, j.w) if j.left else (j.w, j.h)
        placed_area = sum(s["area"] for s in ev["sheets"])
        last_ext = ev["sheets"][-1]["extent"] if count else 0.0
        used_area = (count - 1) * sheet_area + last_ext * other if count else 0.0
        return {
            "placements": placements,
            "sheets": [{"index": i, "parts": s["count"], "usedLength": s["extent"],
                        "utilization": s["area"] / sheet_area}
                       for i, s in enumerate(ev["sheets"])],
            "unplaced": [{"partId": types[inst[i][0]]["id"], "partIndex": inst[i][0],
                          "instance": inst[i][1]} for i in ev["unplaced"]],
            "stats": {
                "sheetsUsed": count, "placed": len(placements), "total": n,
                "placedArea": placed_area,
                "utilizationSheets": placed_area / (count * sheet_area) if count else 0,
                "utilizationUsed": placed_area / used_area if used_area > 0 else 0,
                "remnantLength": along - last_ext if count else along,
                "fitness": ev["fitness"], "iterations": state["step"],
                "maxSheets": None if math.isinf(j.max_sheets) else int(j.max_sheets),
                "stockLimited": any(types[inst[i][0]]["fits_empty"] for i in ev["unplaced"]),
                "maxSteps": None if math.isinf(j.max_steps) else int(j.max_steps),
                "elapsedMs": elapsed(), "prepMs": state["prep"], "cell": cell,
                "gridCells": ctx.gw * ctx.gh, "history": history, "phases": phases, **extra}}

    def consider(ev: dict, phase: str) -> bool:
        best = state["best"]
        if best is None or ev["fitness"] < best["fitness"] - 1e-9:
            state["best"] = ev
            history.append({"iter": state["step"], "t": elapsed(), "fitness": ev["fitness"],
                            "phase": phase})
            if on_progress and elapsed() - state["last"] > 120:
                state["last"] = elapsed()
                on_progress(build(ev, {"phase": phase}), {"phase": phase})
            return True
        return False

    def genome(order: list, rot: Optional[list] = None) -> dict:
        return {"order": order, "rot": rot if rot is not None else [-1] * n}

    def mutate(g: dict) -> dict:
        o, rot, size = list(g["order"]), list(g["rot"]), len(g["order"])
        if size < 2:
            return genome(o, rot)
        r = rng()
        if n_rot > 1 and r < 0.22:
            # pin one part to a rotation, or release it back to "best rotation"
            i = o[rint(size)]
            rot[i] = -1 if rng() < 0.3 else rint(n_rot)
        elif r < 0.55:
            a = rint(size)
            b = rint(size)
            tries = 0
            while tries < 8 and inst[o[a]][0] == inst[o[b]][0]:
                tries += 1
                b = rint(size)
            o[a], o[b] = o[b], o[a]
        elif r < 0.85:
            a = rint(size)
            b = rint(size)
            x = o.pop(a)
            o.insert(b, x)
        else:
            a = rint(size)
            length = 2 + rint(min(8, size))
            b = min(size, a + length)
            o[a:b] = o[a:b][::-1]
        return genome(o, rot)

    def anneal(ctx: _Ctx, start: dict, phase: str, step_end: float, time_end: float) -> None:
        cur = start
        since_gain = 0
        start_step, start_t = state["step"], elapsed()
        reheat_after = max(60, n * 3)
        temp0 = j.sh * 0.02
        while n > 1:
            if out_of_budget():
                return
            if state["step"] >= step_end or elapsed() >= time_end:
                return
            if since_gain >= j.stall_steps:
                state["stop"] = "stall"
                return
            if not math.isinf(step_end):
                frac = (state["step"] - start_step) / max(1, step_end - start_step)
            else:
                frac = (elapsed() - start_t) / max(1, time_end - start_t)
            temp = temp0 * math.pow(0.002, min(1, max(0, frac)))
            cand = ctx.evaluate(mutate(cur["g"]))
            state["step"] += 1
            d = cand["fitness"] - cur["fitness"]
            if d < 0 or rng() < math.exp(-d / max(1e-9, temp)):
                cur = cand
            if consider(cand, phase):
                since_gain = 0
            else:
                since_gain += 1
            if on_progress and elapsed() - state["last"] > 400:
                state["last"] = elapsed()
                on_progress(build(state["best"], {"phase": phase}), {"phase": phase})
            if since_gain > 0 and since_gain % reheat_after == 0:
                best = state["best"]
                cur = best if best["ctx"] is ctx else cur  # restart from the best layout

    # ---- phase 1: coarse grid ----
    coarse = _Ctx(j, base_cell, now)
    state["prep"] += coarse.prep_ms
    tt = coarse.types

    def by_key(f: Callable) -> list:
        return sorted(range(n), key=lambda i: (-f(inst[i]), i))

    seeds = [
        by_key(lambda o: tt[o[0]]["area"]),
        by_key(lambda o: max(tt[o[0]]["bw"], tt[o[0]]["bh"])),
        by_key(lambda o: tt[o[0]]["bw"] * tt[o[0]]["bh"]),
        by_key(lambda o: min(tt[o[0]]["bw"], tt[o[0]]["bh"])),
    ]
    seed_best = None
    for s in seeds:
        if state["step"] > 0 and out_of_budget():
            break
        ev = coarse.evaluate(genome(s))
        state["step"] += 1
        consider(ev, "coarse")
        if seed_best is None or ev["fitness"] < seed_best["fitness"]:
            seed_best = ev
    if n <= 1:
        state["stop"] = "single"

    fine_cell = base_cell / 2
    fine_cells = (math.ceil(j.sw / fine_cell) + 40) * (math.ceil(j.sh / fine_cell) + 40)
    refine = job.get("refine") is not False and n > 1 and fine_cell >= 0.25 and fine_cells <= 8e6
    share = 0.7 if refine else 1
    coarse_step_end = (math.inf if math.isinf(j.max_steps)
                       else max(state["step"], math.floor(j.max_steps * share)))
    coarse_time_end = math.inf if math.isinf(j.time_limit) else j.time_limit * share
    p1 = state["step"]
    anneal(coarse, seed_best, "coarse", coarse_step_end, coarse_time_end)
    phases.append({"name": "coarse", "cell": base_cell, "steps": state["step"] - p1 + len(seeds),
                   "best": state["best"]["fitness"]})

    # ---- phase 2: refine on a half-size grid, from the best coarse order ----
    hard_stop = state["stop"] in ("steps", "time")
    fine_affordable = (math.isinf(j.time_limit)
                       or j.time_limit - elapsed() > coarse.prep_ms * 5 + 50)
    if refine and not hard_stop and fine_affordable:
        if state["stop"] == "stall":
            state["stop"] = "done"
        fine = _Ctx(j, fine_cell, now)
        state["prep"] += fine.prep_ms
        if not out_of_budget():
            p2 = state["step"]
            start = fine.evaluate(state["best"]["g"])
            state["step"] += 1
            consider(start, "refine")
            anneal(fine, start, "refine", j.max_steps, j.time_limit)
            phases.append({"name": "refine", "cell": fine_cell, "steps": state["step"] - p2,
                           "best": state["best"]["fitness"]})
    elif refine and not hard_stop:
        # not enough time left for the finer grid: spend the rest on the coarse one
        if state["stop"] == "stall":
            state["stop"] = "done"
        else:
            p3 = state["step"]
            best = state["best"]
            anneal(coarse, best if best["ctx"] is coarse else seed_best, "coarse",
                   j.max_steps, j.time_limit)
            phases[0]["steps"] += state["step"] - p3
    if state["stop"] == "done" and state["step"] >= j.max_steps:
        state["stop"] = "steps"
    history.append({"iter": state["step"], "t": elapsed(), "fitness": state["best"]["fitness"],
                    "phase": "end"})
    return build(state["best"], {"stopReason": state["stop"]})


# ---------------- exact verification ----------------
def transform_part(part: dict, pl: dict) -> dict:
    def f(ring: list) -> list:
        return [[p[0] + pl["tx"], p[1] + pl["ty"]] for p in rot_ring(ring, pl["rotation"])]

    return {"outer": f(part["outer"]), "holes": [f(h) for h in part.get("holes") or []]}


def _rings_edges(shape: dict) -> np.ndarray:
    return _edges_of({"outer": shape["outer"], "holes": shape["holes"]})


def _in_shape_many(pts: np.ndarray, shape: dict) -> np.ndarray:
    def in_ring(ring: list) -> np.ndarray:
        r = np.array(ring, dtype=np.float64)
        q = np.roll(r, 1, axis=0)
        x, y = pts[:, 0, None], pts[:, 1, None]
        with np.errstate(divide="ignore", invalid="ignore"):
            cross = ((r[:, 1] > y) != (q[:, 1] > y)) & (
                x < (q[:, 0] - r[:, 0]) * (y - r[:, 1]) / (q[:, 1] - r[:, 1]) + r[:, 0])
        return cross.sum(axis=1) % 2 == 1

    inside = in_ring(shape["outer"])
    for h in shape["holes"]:
        inside &= ~in_ring(h)
    return inside


def _interior_point(shape: dict) -> list:
    b = bbox(shape["outer"])
    edges = _rings_edges(shape)
    for f in (0.5, 0.37, 0.63, 0.21, 0.79, 0.11, 0.89):
        y = b["miny"] + (b["maxy"] - b["miny"]) * f
        c = (edges[:, 1] > y) != (edges[:, 3] > y)
        e = edges[c]
        xs = np.sort(e[:, 0] + (y - e[:, 1]) * (e[:, 2] - e[:, 0]) / (e[:, 3] - e[:, 1]))
        best_w, bx = 0.0, 0.0
        for k in range(0, len(xs) - 1, 2):
            if xs[k + 1] - xs[k] > best_w:
                best_w, bx = float(xs[k + 1] - xs[k]), float((xs[k] + xs[k + 1]) / 2)
        if best_w > 0:
            return [bx, y]
    return list(shape["outer"][0])


def _pair_check(a: dict, b: dict, tol: float) -> tuple[bool, float]:
    """Returns (overlap, exact gap)."""
    ea, eb = _rings_edges(a), _rings_edges(b)
    ax, ay, bx, by = (ea[:, k, None] for k in range(4))
    cx, cy, dx, dy = (eb[None, :, k] for k in range(4))

    def orient(px, py, qx, qy, rx, ry):
        return (qx - px) * (ry - py) - (qy - py) * (rx - px)

    t = tol * tol
    o1, o2 = orient(ax, ay, bx, by, cx, cy), orient(ax, ay, bx, by, dx, dy)
    o3, o4 = orient(cx, cy, dx, dy, ax, ay), orient(cx, cy, dx, dy, bx, by)
    crosses = (((o1 > t) & (o2 < -t)) | ((o1 < -t) & (o2 > t))) \
        & (((o3 > t) & (o4 < -t)) | ((o3 < -t) & (o4 > t)))
    if crosses.any():
        return True, 0.0

    def probes(s: dict, e: np.ndarray) -> np.ndarray:
        mid = (e[:, :2] + e[:, 2:]) / 2
        return np.vstack([np.array([_interior_point(s)]), e[:, :2], mid])

    def strictly(pts: np.ndarray, s: dict, e: np.ndarray) -> bool:
        ins = _in_shape_many(pts, s)
        if not ins.any():
            return False
        p = pts[ins]
        d2 = _pt_seg_d2(p[:, 0, None], p[:, 1, None], e[:, 0], e[:, 1], e[:, 2], e[:, 3]).min(axis=1)
        return bool((np.sqrt(d2) > tol).any())

    if strictly(probes(a, ea), b, eb) or strictly(probes(b, eb), a, ea):
        return True, 0.0
    d = np.minimum(_pt_seg_d2(ax, ay, cx, cy, dx, dy), _pt_seg_d2(bx, by, cx, cy, dx, dy))
    d = np.minimum(d, _pt_seg_d2(cx, cy, ax, ay, bx, by))
    d = np.minimum(d, _pt_seg_d2(dx, dy, ax, ay, bx, by))
    return False, float(math.sqrt(d.min()))


def verify(job: dict, result: dict, max_issues: Optional[int] = None) -> dict:
    """Check a layout with exact polygons, independent of the raster.

    ``max_issues`` stops the search once that many are found: one bad drag in the
    editor must not cost a full pair scan. ``None`` checks everything."""
    w, h = float(job["sheet"]["width"]), float(job["sheet"]["height"])
    margin = float(job.get("margin") or 0)
    gsp = max(0.0, float(job.get("spacing") or 0))

    def sp_of(i: int) -> float:
        s = job["parts"][i].get("spacing")
        return float(s) if s is not None and s != "" and float(s) >= 0 else gsp

    tol = 1e-6 * max(w, h) + 1e-7
    issues: list[str] = []
    min_gap = min_slack = math.inf
    pairs = 0
    items = []

    def full() -> bool:
        return max_issues is not None and len(issues) >= max_issues

    for pl in result["placements"]:
        sh = transform_part(job["parts"][pl["partIndex"]], pl)
        items.append({"pl": pl, "sh": sh, "b": bbox(sh["outer"])})
    for it in items:
        if full():
            break
        b, pl = it["b"], it["pl"]
        if (b["minx"] < margin - tol or b["miny"] < margin - tol
                or b["maxx"] > w - margin + tol or b["maxy"] > h - margin + tol):
            issues.append(f"{pl['partId']}#{pl['instance']} leaves the usable area of "
                          f"sheet {pl['sheet'] + 1}")
    for i, a in enumerate(items):
        if full():
            break
        for b in items[i + 1:]:
            if full():
                break
            if a["pl"]["sheet"] != b["pl"]["sheet"]:
                continue
            spacing = max(sp_of(a["pl"]["partIndex"]), sp_of(b["pl"]["partIndex"]))
            reach = spacing + 1
            ba, bb = a["b"], b["b"]
            if (ba["minx"] > bb["maxx"] + reach or bb["minx"] > ba["maxx"] + reach
                    or ba["miny"] > bb["maxy"] + reach or bb["miny"] > ba["maxy"] + reach):
                continue
            pairs += 1
            overlap, gap = _pair_check(a["sh"], b["sh"], tol)
            la = f"{a['pl']['partId']}#{a['pl']['instance']}"
            lb = f"{b['pl']['partId']}#{b['pl']['instance']}"
            if overlap:
                issues.append(f"{la} overlaps {lb}")
                continue
            min_gap = min(min_gap, gap)
            min_slack = min(min_slack, gap - spacing)
            if gap < spacing - tol:
                issues.append(f"{la} and {lb} are {gap:.3f} mm apart (min {spacing})")
    return {"valid": not issues, "issues": issues,
            "minGap": None if math.isinf(min_gap) else min_gap,
            "minSlack": None if math.isinf(min_slack) else min_slack, "pairsChecked": pairs}
