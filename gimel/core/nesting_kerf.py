"""Kerf als Schachtel-Motor der Fertigung (``nesting_engine = kerf``).

Übersetzt zwischen Gimels Positionen und dem Auftrag von :mod:`gimel.core.kerf`
und liefert dieselbe Ergebnisform wie ``nesting.nest``, damit Sammellauf,
Plattenzeichnung und Schnittdatei nichts davon wissen müssen.

Drei Regeln, und jede ist eine Absicherung:

* **Die Kasse bleibt unberührt.** Preise rechnet weiter ``lite``; Kerf rührt nur
  der Sammellauf an.
* **Reproduzierbar.** Das Budget sind Schritte, nie Zeit, mit festem Startwert
  (einstellbar, Vorgabe 1): gleicher Korb, gleiche Einstellungen, gleiche Platten.
  Die Probe vor der Freigabe und der Plan danach müssen dieselbe Lage ergeben.
* **Nie schlechter und nie ungeprüft.** Jede Lage geht durch ``kerf.verify`` mit
  exakter Geometrie, und ``lite`` rechnet als Untergrenze mit. Besteht Kerf die
  Prüfung nicht oder braucht mehr Platte, gilt das Ergebnis von ``lite``, und
  ``kerf["used"]`` sagt es.

Kontur: gekrümmte Außenkanten werden als umschriebener Sehnenzug gerechnet,
Löcher als einbeschriebener. Beides liegt auf der sicheren Seite. Löcher, in die
kein Teil des Korbs passt, zählen als Vollmaterial; das spart Kanten.
"""

from __future__ import annotations

import json
import math
from collections import OrderedDict
from typing import Optional

from . import kerf
from .geometry import holes_of
from .nesting import (
    ENGINE_VERSION,
    _orientation_policy,
    footprint,
    nest_best,
    nest_for,
    nest_key,
    resolve_policy,
    round6,
    score_layout,
)
from .types import PlacedPart, Position, Product, Rates, Sheet

ENGINE_LABEL = f"kerf-{kerf.KERF_VERSION}"
#: Fester Startwert: der Lauf soll wiederholbar sein, nicht zufällig gut.
KERF_SEED = 1
#: Schritte je Arbeitsmenge (Teile × Lagen aller Teiletypen). Eine Zahl und keine
#: Zeitmessung, siehe oben; gemessen 2026-10-31: ein Korb bleibt unter etwa einer Minute.
STEPS_BY_WORK = ((1500, 120), (8000, 60), (80000, 24), (120000, 8))
#: Darüber nur die vier Startreihenfolgen.
SEEDS_ONLY = 4
#: Über diesem Speicherbedarf der Lagenkarten rechnet Kerf nicht, sondern lite.
MAX_MAP_BYTES = 1024 ** 3
#: Bis zu dieser Teilezahl läuft das letzte Budgetdrittel auf dem halben Raster.
REFINE_MAX_PARTS = 200

_CACHE_MAX = 64
_cache: OrderedDict = OrderedDict()


def steps_for(n_parts: int, n_variants: int) -> int:
    work = n_parts * n_variants
    for limit, steps in STEPS_BY_WORK:
        if work <= limit:
            return steps
    return SEEDS_ONLY


def cell_for(long_side: float, short_part: float) -> float:
    """Rasterweite: fein genug für das kleinste Teil, bezahlbar für die Platte."""
    coarse = kerf.nice_cell(long_side, 600)
    finest = kerf.nice_cell(long_side, 1500)
    wanted = short_part / 12
    for step in (20.0, 10.0, 5.0, 2.5, 2.0, 1.0, 0.5):
        if finest <= step <= coarse and step <= wanted:
            return step
    return finest


def _steps(r: float) -> int:
    """Sehnenzahl für 0,1 mm Sehnenfehler; durch 4 teilbar, damit die Kanten des
    Zuges die Standfläche genau treffen."""
    if r <= 0.1:
        return 16
    n = math.ceil(math.pi / math.acos(1 - 0.1 / r))
    return max(16, min(96, (n + 3) // 4 * 4))


def _ellipse(rx: float, ry: float, x: float, y: float, outer: bool) -> list:
    n = _steps(max(rx, ry))
    grow = 1 / math.cos(math.pi / n) if outer else 1.0
    return [[x + rx * grow * math.cos(2 * math.pi * (k + 0.5) / n),
             y + ry * grow * math.sin(2 * math.pi * (k + 0.5) / n)] for k in range(n)]


def _corner(cx: float, cy: float, r: float, start: float, steps: int, outer: bool) -> list:
    grow = 1 / math.cos(math.pi / (4 * steps)) if outer else 1.0
    return [[cx + r * grow * math.cos(start + (k + 0.5) * math.pi / (2 * steps)),
             cy + r * grow * math.sin(start + (k + 0.5) * math.pi / (2 * steps))]
            for k in range(steps)]


def _rounded(w: float, h: float, r: float, x: float, y: float, outer: bool) -> list:
    r = max(0.0, min(r, w / 2, h / 2))
    hw, hh = w / 2, h / 2
    if r <= 0:
        return [[x - hw, y - hh], [x + hw, y - hh], [x + hw, y + hh], [x - hw, y + hh]]
    steps = max(4, _steps(r) // 4)
    pts = []
    for sx, sy, start in ((1, -1, -math.pi / 2), (1, 1, 0.0),
                          (-1, 1, math.pi / 2), (-1, -1, math.pi)):
        ccx, ccy = x + sx * (hw - r), y + sy * (hh - r)
        if outer:
            # Die Ecke beginnt und endet auf der Rechteckkante, sonst stünde der
            # umschriebene Bogen über die Standfläche hinaus.
            pts.append([ccx + r * math.cos(start), ccy + r * math.sin(start)])
        pts.extend(_corner(ccx, ccy, r, start, steps, outer))
        if outer:
            end = start + math.pi / 2
            pts.append([ccx + r * math.cos(end), ccy + r * math.sin(end)])
    return pts


def _ring_of(g: dict, outer: bool) -> list:
    """Eine Kontur der Geometrie als Polygon, um (x, y) wie in den Zeichnungen."""
    kind = g.get("kind")
    x, y = float(g.get("x") or 0), float(g.get("y") or 0)
    w, h = float(g.get("w") or 0), float(g.get("h") or 0)
    if kind == "circle":
        r = float(g.get("d") or 0) / 2
        return _ellipse(r, r, x, y, outer)
    if kind == "rect":
        return _rounded(w, h, float(g.get("r") or 0), x, y, outer)
    if kind == "slot":
        return _rounded(w, h, min(w, h) / 2, x, y, outer)
    if kind == "oval":
        return _ellipse(w / 2, h / 2, x, y, outer)
    if kind == "poly" and g.get("pts"):
        return [[x + float(p[0]), y + float(p[1])] for p in g["pts"]]
    return []


def _outer_of(p: Position) -> dict:
    shape = p.shape if isinstance(p.shape, dict) else None
    o = shape.get("outer") if shape else None
    return o if isinstance(o, dict) else {"kind": "circle", "d": float(p.od or 0)}


def _holes_for(p: Position) -> list:
    """Die Innenkonturen; der Ring ohne Kontur hat nur seine Bohrung."""
    if isinstance(p.shape, dict) and isinstance(p.shape.get("outer"), dict):
        return [h for h in holes_of(p.shape) if isinstance(h, dict)]
    return [{"kind": "circle", "d": float(p.di)}] if p.di else []


def rings_of(p: Position) -> list:
    """Das Teil als Polygone, Ring 0 außen, so wie es auf der Platte liegt."""
    rings = [_ring_of(_outer_of(p), True)]
    rings += [r for r in (_ring_of(h, False) for h in _holes_for(p)) if len(r) >= 3]
    return rings


def _rotations(outer: dict, allowed: list) -> list:
    """Nur Lagen, die die Standfläche wirklich ändern: ein Ring braucht eine."""
    kind = outer.get("kind")
    if kind == "circle":
        return [0]
    if kind in ("rect", "oval", "slot"):
        same = abs(float(outer.get("w") or 0) - float(outer.get("h") or 0)) < 1e-9
        return [0] if same else [r for r in allowed if r in (0, 90)]
    return allowed


def _allowed(product: Product, policy: dict) -> list:
    orient = _orientation_policy(product, policy)
    if orient["rot90"]:
        return [0, 90, 180, 270]
    # Faser in Achsenrichtung: 180° behalten dieselbe Richtung.
    if (product.grain or "none") == "axis" and policy["allow_rotation"]:
        return [0, 180]
    return [0]


def build_job(positions: list[Position], product: Product, rates: Rates, sheet_idx: int,
              policy: dict, steps: Optional[int] = None) -> tuple[dict, list]:
    """Der Kerf-Auftrag und je Teiletyp die Positionen seiner Exemplare.
    ``steps`` ersetzt das Budget aus der Arbeitsmenge; die übrigen Kerf-Optionen
    kommen aus ``policy`` (``kerf_steps``, ``kerf_cell``, ``kerf_gravity``,
    ``kerf_seed``, ``kerf_refine``, ``kerf_stall``)."""
    W, H = (float(v) for v in product.sheets[sheet_idx])
    gap = float(product.kerf if product.kerf is not None else rates.gap)
    margin = float(product.web if product.web is not None else rates.margin)
    allowed = _allowed(product, policy)
    copies: dict = {}
    for p in positions:
        key = (p.od, p.di or 0, p.bn or 0, p.bd or 0, p.bc or 0,
               json.dumps(p.shape, sort_keys=True, separators=(",", ":")) if p.shape else "")
        copies.setdefault(key, []).extend([p] * max(1, round(p.q or 1)))
    smallest = min(min(footprint(p)) for p in positions)
    parts, owners = [], []
    for i, group in enumerate(copies.values()):
        p = group[0]
        outer = _outer_of(p)
        holes = []
        for h in _holes_for(p):
            ring = _ring_of(h, False)
            if len(ring) < 3:
                continue
            b = kerf.bbox(ring)
            # Passt kein Teil des Korbs hinein, ist das Loch für die Schachtelung Material.
            if min(b["maxx"] - b["minx"], b["maxy"] - b["miny"]) >= smallest + 2 * gap:
                holes.append(ring)
        parts.append({"id": str(i), "quantity": len(group), "outer": _ring_of(outer, True),
                      "holes": holes, "rotations": _rotations(outer, allowed)})
        owners.append(group)
    n = sum(len(g) for g in owners)
    variants = sum(len(q["rotations"]) for q in parts)
    budget = steps or policy.get("kerf_steps") or steps_for(n, variants)
    cell = policy.get("kerf_cell") or cell_for(max(W, H), smallest)
    refine = policy.get("kerf_refine")
    refine = n <= REFINE_MAX_PARTS if refine is None else bool(refine)
    job = {"sheet": {"width": W, "height": H}, "spacing": gap, "margin": margin,
           "gravity": policy.get("kerf_gravity") or "top", "rotations": allowed,
           "seed": policy.get("kerf_seed") or KERF_SEED,
           "maxSteps": budget, "cell": cell, "refine": refine,
           "parts": parts}
    stall = policy.get("kerf_stall")
    if stall:
        job["stallSteps"] = int(stall)
    return job, owners


def map_bytes(job: dict) -> float:
    """Geschätzter Bedarf: je Lage eine Karte der Platte, je Platte eine Lage."""
    W, H = job["sheet"]["width"], job["sheet"]["height"]
    cell = job["cell"] / (2 if job["refine"] else 1)
    area = sum(p["quantity"] * abs(kerf.shape_area({"outer": p["outer"]})) for p in job["parts"])
    sheets = max(1.0, 1.5 * area / (W * H))
    variants = sum(len(p["rotations"]) for p in job["parts"])
    return variants * sheets * (W / cell) * (H / cell)


def _in_ring(x: float, y: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi, xj, yj = ring[i][0], ring[i][1], ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _to_sheets(job: dict, result: dict, owners: list, margin: float, H: float) -> tuple:
    """Kerf-Platzierungen → ``Sheet``. Ein Teil im Loch eines anderen wird wie in
    ``lite`` Restflächenteil dieses Wirts, damit die Schnittfolge stimmt."""
    count = result["stats"]["sheetsUsed"]
    sheets = [Sheet() for _ in range(count)]
    by_sheet: list[list] = [[] for _ in range(count)]
    uid = 0
    for pl in result["placements"]:
        pos = owners[pl["partIndex"]][pl["instance"]]
        fw, fh = footprint(pos)
        if pl["rotation"] % 180 == 90:
            fw, fh = fh, fw
        uid += 1
        part = PlacedPart(pos=pos, od=float(pos.od or 0), di=float(pos.di or 0),
                          seq=pl["instance"], fw=fw, fh=fh,
                          cx=round6(pl["tx"]), cy=round6(pl["ty"]),
                          rot=float(pl["rotation"]), mirror=False, uid=uid)
        by_sheet[pl["sheet"]].append((part, pl))
    for si, placed in enumerate(by_sheet):
        hosts = []
        for part, pl in placed:
            src = job["parts"][pl["partIndex"]]
            if src["holes"]:
                hosts.append((part, kerf.transform_part(src, pl)["holes"]))
        sh = sheets[si]
        for part, pl in placed:
            # Ganz im Loch, jede Ecke: zwei fast gleiche Ringe dürfen sich nicht
            # gegenseitig zum Wirt wählen, sonst fehlt der äußere in ``top``.
            corners = kerf.transform_part(job["parts"][pl["partIndex"]], pl)["outer"]
            host = next((h for h, rings in hosts if h is not part
                         and any(all(_in_ring(x, y, r) for x, y in corners) for r in rings)),
                        None)
            if host is None:
                sh.top.append(part)
            else:
                part.host_id = host.uid
                host.nested.append(part)
                sh.rest.append(part)
            sh.used_h = max(sh.used_h, pl["y"] + pl["height"])
        sh.used_h = min(sh.used_h + margin, H)
    return sheets


def _used_m2(res: dict) -> float:
    return sum((res["W"] / 1000) * (sh.used_h / 1000) for sh in res["sheets"])


def _kerf_or_lite(lite: dict, positions: list[Position], product: Product, rates: Rates,
                  policy: dict) -> dict:
    # Eine Eckschranke kennt Kerf nicht: dann gilt lite, ohne Versuch.
    if policy["corner_max_dist"] is not None:
        return {**lite, "kerf": {"used": False, "reason": "corner_max_dist"}}
    # Über die id: lite kann aus seinem Gedächtnis antworten, mit anderen Objekten.
    over_ids = {p.id for p in lite["over"]}
    fitting = [p for p in positions if p.id not in over_ids]
    if not fitting:
        return {**lite, "kerf": {"used": False, "reason": "nichts zu schachteln"}}
    sheet_idx = lite["sheet_idx"]
    job, owners = build_job(fitting, product, rates, sheet_idx, policy)
    if map_bytes(job) > MAX_MAP_BYTES:
        return {**lite, "kerf": {"used": False, "reason": "Korb zu groß für Kerf"}}
    result = kerf.nest(job)
    stats = result["stats"]
    info = {"used": False, "steps": stats["iterations"], "cell": stats["cell"],
            "unplaced": len(result["unplaced"])}
    check = kerf.verify(job, result)
    if not check["valid"]:
        # Darf nie vorkommen und darf, wenn doch, nie an die Maschine.
        return {**lite, "kerf": {**info, "reason": "Prüfung: " + check["issues"][0]}}
    W, H = lite["W"], lite["H"]
    sheets = _to_sheets(job, result, owners, lite["margin"], H)
    over = list(lite["over"]) + [owners[u["partIndex"]][u["instance"]] for u in result["unplaced"]]
    res = {**lite, "sheets": sheets, "over": over, "v": ENGINE_LABEL}
    metrics = score_layout(res, W, H)
    res["corner_max"] = round6(metrics["corner_max"])
    res["fill"] = metrics["fill"]
    worse = (len(over), _used_m2(res)) >= (len(lite["over"]), _used_m2(lite) - 1e-9)
    if worse:
        return {**lite, "kerf": {**info, "reason": "lite braucht nicht mehr Platte",
                                 "used_m2": round6(_used_m2(res))}}
    res["kerf"] = {**info, "used": True, "lite_m2": round6(_used_m2(lite)),
                   "used_m2": round6(_used_m2(res))}
    return res


def _kerf_signature(policy: dict) -> str:
    """Alles, was einen Kerf-Plan über die gemeinsame Richtlinie hinaus ändert.
    Ohne diese Zeile könnten zwei Läufe mit verschiedenem Raster oder Startwert
    denselben Eintrag im Gedächtnis treffen."""
    keys = ("kerf_steps", "kerf_stall", "kerf_cell", "kerf_gravity", "kerf_seed",
            "kerf_refine")
    return "|".join(str(policy.get(k)) if policy.get(k) is not None else "-" for k in keys)


def _cached(positions: list[Position], product: Product, rates: Rates, lite: dict,
            override: Optional[dict]) -> dict:
    policy = resolve_policy(rates, override)
    key = (nest_key(positions, product, rates, lite["sheet_idx"], policy)
           + f"|{ENGINE_LABEL}|{_kerf_signature(policy)}")
    got = _cache.get(key)
    if got is None:
        got = _kerf_or_lite(lite, positions, product, rates, policy)
        _cache[key] = got
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    else:
        _cache.move_to_end(key)
    return got


def clear_cache() -> None:
    _cache.clear()


def nest_best_kerf(positions: list[Position], product: Product, rates: Rates,
                   policy_override: Optional[dict] = None) -> dict:
    """Wie ``nest_best``. Das Format wählt lite: alle Formate mit Kerf zu rechnen
    kostet das Vielfache, und das Format entscheidet die Fläche, nicht die Lage."""
    lite = nest_best(positions, product, rates, policy_override)
    return _cached(positions, product, rates, lite, policy_override)


def nest_for_kerf(positions: list[Position], product: Product, rates: Rates,
                  plate_idx: Optional[int] = None,
                  policy_override: Optional[dict] = None) -> dict:
    """Wie ``nest_for``: die Plattenwahl des Kunden gilt."""
    lite = nest_for(positions, product, rates, plate_idx, policy_override)
    return _cached(positions, product, rates, lite, policy_override)


__all__ = ["ENGINE_LABEL", "ENGINE_VERSION", "build_job", "cell_for", "clear_cache", "map_bytes",
           "nest_best_kerf", "nest_for_kerf", "steps_for"]
