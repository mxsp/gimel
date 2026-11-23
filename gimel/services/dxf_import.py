"""DXF-Import auf dem Server — verhaltensgleiche Portierung von assets/dxf.js.

Das Auftragsbüro lädt die Zeichnung des Kunden hoch, ohne dass ein Browser im
Spiel war. Damit Vorschau, Preis und Schnittdatei dieselbe Kontur sehen, gilt
dieselbe Regelkette wie im Portal:

  1. Entitäten lesen (CIRCLE, ARC, LINE, LWPOLYLINE, POLYLINE, ELLIPSE,
     SPLINE). Gelesen wird mit ezdxf — der fremde Leser, der auch die
     Schnittdateien prüft — statt des eigenen Gruppencode-Lesers, denn echte
     Kundenzeichnungen übertreffen den R12-Kern des Prototyps. Blöcke (INSERT)
     werden hier aufgelöst, was der Browser-Leser bewusst noch nicht kann.
  2. Offene Stücke an ihren Endpunkten zu geschlossenen Zügen verketten.
  3. Der größte Zug ist die Außenkontur, was in ihm liegt, ist eine Aussparung
     — Topologie, keine Layernamen.
  4. Abbildung auf das Konturmodell: runde Züge bleiben Kreis, elliptische
     bleiben Oval, rechteckige werden Rechteck. y wird gespiegelt wie in
     dxf.js, damit Kontur im Portal und Kontur hier gleich aussehen.

Die Kennzahlen (od/di/cut_len) stammen aus domain/geometry.py — derselben
Portierung, die auch der Rechenkern benutzt.
"""

from __future__ import annotations

import io
import math

import ezdxf
from ..core.geometry import _dist_inside, metrics

TAU = math.pi * 2
TOL = 0.05                       # mm — Endpunkte gelten als identisch
# Verkettungstoleranz = TOL (0,05 mm), wie in dxf.js. 1,0 mm schloss undichte
# Konturen still — ein Preisfehler, kein Komfort.
CHAIN_TOL = TOL                   # Verkettungstoleranz wie in dxf.js

#: $INSUNITS → Faktor nach Millimeter (vollständige Tabelle, wie dxf.js).
#: 0 = einheitenlos (als mm gelesen). 8 = Microinch (früher 1000× falsch).
INSUNITS = {0: 1.0, 1: 25.4, 2: 304.8, 3: 1609344.0, 4: 1.0, 5: 10.0,
            6: 1000.0, 7: 1000000.0, 8: 25.4 / 1000000.0, 9: 0.0254,
            10: 914.4, 11: 1e-7, 12: 1e-6, 13: 0.001, 14: 100.0,
            15: 10000.0, 16: 100000.0, 17: 1e9,
            18: 1.495978707e14, 19: 9.4607304725808e15,
            20: 3.08567758149137e16, 21: 1200000 / 3937,
            22: 100000 / 3937, 23: 3600000 / 3937, 24: 6336000000 / 3937}


#: Obergrenzen gegen Bomben (verschachtelte Blöcke, riesige Polylinien). Großzügig für echte Kundenzeichnungen;
#: die Zeichnungsbibliothek übergibt engere Werte.
MAX_ENTITIES = 60_000        # Entitäten samt der aus Blöcken entstandenen
MAX_POINTS = 1_000_000       # erzeugte Punkte (Bögen, Wölbungen, Ellipsen, Splines)
MAX_CHAIN_SEGMENTS = 10_000  # offene Stücke vor dem Verketten; liegen viele Enden aufeinander, wird es quadratisch
MAX_POLY_VERTICES = 20_000   # Eckpunkte einer einzelnen Polylinie vor dem Auflösen der Wölbungen


class DxfLimit(ValueError):
    """Die Datei überschreitet eine Grenze; die Meldung sagt welche."""


def _r2(v: float) -> float:
    return round(v * 100) / 100


# --------------------------------------------------------------------------
# 1) Entitäten zu Zügen
# --------------------------------------------------------------------------
def _arc_points(cx: float, cy: float, r: float, a0: float, a1: float) -> list:
    if not all(math.isfinite(v) for v in (cx, cy, r, a0, a1)) or r <= 0:
        raise ValueError("Ungültiger Kreisbogen")
    span = (a1 - a0) % TAU or TAU
    # ≤ 2° je Schritt (früher 10°): 0,38 mm Sehnenfehler bei r=100 → 0,015 mm.
    step = min(math.pi / 90, math.sqrt(8 * 0.01 / r))
    n = max(2, math.ceil(span / step))
    if n > 100000:
        raise ValueError("Kurve zu groß oder zu komplex")
    angles = [span * i / n for i in range(n + 1)]
    # Include exact extrema so the footprint cannot miss a bulging arc.
    angles += [d for k in range(4) if 0 < (d := (k * math.pi / 2 - a0) % TAU) < span]
    return [[cx + math.cos(a0 + d) * r, cy + math.sin(a0 + d) * r]
            for d in sorted(set(angles))]


def _bulge_points(p0: list, p1: list, b: float) -> list:
    """Bogen aus Wölbung (bulge = tan(θ/4)) — wie in dxf.js."""
    theta = 4 * math.atan(b)
    d = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    if not d or not theta:
        return []
    r = d / (2 * math.sin(abs(theta) / 2))
    mx, my = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    h = math.sqrt(max(0.0, r * r - d * d / 4)) * (-1 if abs(theta) > math.pi else 1)
    s = 1 if theta > 0 else -1
    cx = mx - s * h * (p1[1] - p0[1]) / d
    cy = my + s * h * (p1[0] - p0[0]) / d
    a0 = math.atan2(p0[1] - cy, p0[0] - cx)
    a1 = math.atan2(p1[1] - cy, p1[0] - cx)
    pts = _arc_points(cx, cy, r, a0, a1) if theta > 0 else \
        list(reversed(_arc_points(cx, cy, r, a1, a0)))
    return pts[1:-1]


def _chain(segments: list[list]) -> list[list]:
    """Offene Stücke an den Enden verketten — dieselbe Reihenfolge wie dxf.js: das nächste Stück ist
    immer das mit dem kleinsten Index, das an einem der beiden Enden hängt.

    Die Suche läuft über ein Raster der Endpunkte (Zellen von CHAIN_TOL) statt über alle Stücke:
    früher wuchs die Zeit mit dem Quadrat der Stückzahl. Das Ergebnis ist dasselbe;
    ``tests/app/test_drawings.py`` vergleicht beide an Zufallsdaten."""
    segs = [s[:] for s in segments if len(s) >= 2]
    cell = CHAIN_TOL

    def key(p):
        return (math.floor(p[0] / cell), math.floor(p[1] / cell))

    grid: dict[tuple, set] = {}
    for i, s in enumerate(segs):
        for p in (s[0], s[-1]):
            grid.setdefault(key(p), set()).add(i)
    alive = [True] * len(segs)

    def drop(i: int) -> None:
        alive[i] = False
        for p in (segs[i][0], segs[i][-1]):
            cellset = grid.get(key(p))
            if cellset is not None:
                cellset.discard(i)

    def near(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1]) <= CHAIN_TOL

    def candidates(p):
        kx, ky = key(p)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                yield from grid.get((kx + dx, ky + dy), ())

    out = []
    first = 0
    while True:
        while first < len(segs) and not alive[first]:
            first += 1
        if first >= len(segs):
            break
        drop(first)
        cur = segs[first]
        grew = True
        while grew:
            if len(cur) > 2 and near(cur[0], cur[-1]):
                break
            grew = False
            a, b = cur[0], cur[-1]
            best = None
            for p in (a, b):
                for i in candidates(p):
                    s = segs[i]
                    if (best is None or i < best) and (
                            near(b, s[0]) or near(b, s[-1]) or near(a, s[-1]) or near(a, s[0])):
                        best = i
            if best is None:
                continue
            s = segs[best]
            if near(b, s[0]):
                cur = cur + s[1:]
            elif near(b, s[-1]):
                cur = cur + list(reversed(s))[1:]
            elif near(a, s[-1]):
                cur = s[:-1] + cur
            else:
                cur = list(reversed(s))[:-1] + cur
            drop(best)
            grew = True
        out.append(cur)
    return out


def _read_entities(text: str, *, max_entities: int = MAX_ENTITIES, max_points: int = MAX_POINTS,
                   max_poly: int = MAX_POLY_VERTICES) -> dict:
    """Entitäten des Modellspace (inkl. aufgelöster Blöcke) nach Millimeter."""
    seen = {"entities": 0, "points": 0}

    def count_entity() -> None:
        seen["entities"] += 1
        if seen["entities"] > max_entities:
            raise DxfLimit(f"Die Datei ergibt mehr als {max_entities} Entitäten (Blöcke eingerechnet).")

    def count_points(n: int) -> None:
        seen["points"] += n
        if seen["points"] > max_points:
            raise DxfLimit(f"Die Datei ergibt mehr als {max_points} Punkte (Bögen, Wölbungen, Kurven).")

    skipped: list[str] = []
    circles: list[dict] = []
    ellipses: list[dict] = []
    closed: list[list] = []
    open_seg: list[list] = []

    try:
        doc = ezdxf.read(io.StringIO(text))
    except Exception as exc:                                # noqa: BLE001
        return {"error": f"DXF nicht lesbar: {exc}"}

    unit_code = int(doc.header.get("$INSUNITS", 0) or 0)
    if unit_code not in INSUNITS:
        raise ValueError("Unbekannte DXF-Einheit")
    unit = INSUNITS[unit_code]
    if unit_code == 0:
        skipped.append("Keine DXF-Einheit angegeben; als Millimeter gelesen")
    msp = doc.modelspace()

    def S(v: float) -> float:
        value = v * unit
        if not math.isfinite(value):
            raise ValueError("Nicht endliches DXF-Maß")
        return value

    insert_depth = 0

    def walk(entities):
        nonlocal insert_depth
        for e in entities:
            count_entity()
            t = e.dxftype()
            if e.dxf.hasattr("extrusion") and not e.dxf.extrusion.isclose((0, 0, 1)):
                raise ValueError("Abweichende DXF-Zeichenebene; bitte in XY exportieren")
            if t == "INSERT":
                # Blöcke werden aufgelöst — der Browser-Leser überspringt sie
                # noch, der Server kann es sich leisten (Phase 2.1).
                if insert_depth > 4:
                    skipped.append("Blöcke zu tief verschachtelt — übersprungen")
                    continue
                insert_depth += 1
                try:
                    walk(e.virtual_entities())
                except DxfLimit:
                    raise
                except Exception:                       # noqa: BLE001
                    raise ValueError("Ein Block konnte nicht aufgelöst werden") from None
                insert_depth -= 1
                continue
            if t == "CIRCLE":
                if not math.isfinite(e.dxf.radius) or e.dxf.radius <= 0:
                    raise ValueError("Ungültiger Kreisradius")
                if e.dxf.radius > 0:
                    circles.append({"cx": S(e.dxf.center.x), "cy": S(e.dxf.center.y),
                                    "r": S(e.dxf.radius)})
            elif t == "ARC":
                if e.dxf.radius > 0:
                    a0 = math.radians(e.dxf.start_angle)
                    a1 = math.radians(e.dxf.end_angle)
                    arc = _arc_points(S(e.dxf.center.x), S(e.dxf.center.y), S(e.dxf.radius), a0, a1)
                    count_points(len(arc))
                    open_seg.append(arc)
            elif t == "LINE":
                open_seg.append([[S(e.dxf.start.x), S(e.dxf.start.y)],
                                 [S(e.dxf.end.x), S(e.dxf.end.y)]])
            elif t == "LWPOLYLINE":
                if len(e) > max_poly:
                    raise DxfLimit(f"Eine Polylinie hat {len(e)} Eckpunkte; erlaubt sind {max_poly}.")
                raw = e.get_points("xyb")
                if len(raw) < 2:
                    continue
                count_points(len(raw))
                pts = [[S(p[0]), S(p[1])] for p in raw]
                with_arcs: list[list] = []
                for i, p in enumerate(pts):
                    with_arcs.append(p)
                    bulge = raw[i][2] if len(raw[i]) > 2 else 0.0
                    nxt = pts[i + 1] if i + 1 < len(pts) else (pts[0] if e.closed else None)
                    if bulge and nxt:
                        extra = _bulge_points(p, nxt, bulge)
                        count_points(len(extra))
                        with_arcs.extend(extra)
                (closed if e.closed else open_seg).append(with_arcs)
            elif t == "POLYLINE":
                if not e.is_2d_polyline:
                    raise ValueError("Nur ebene 2D-POLYLINE wird unterstützt")
                if len(e.vertices) > max_poly:
                    raise DxfLimit(f"Eine Polylinie hat {len(e.vertices)} Eckpunkte; erlaubt sind {max_poly}.")
                count_points(len(e.vertices))
                # ezdxf preserves R12 vertex bulges, including the closing edge.
                walk(e.virtual_entities())
            elif t == "ELLIPSE":
                cx, cy = S(e.dxf.center.x), S(e.dxf.center.y)
                mv = e.dxf.major_axis
                ratio = float(e.dxf.ratio)
                a = math.hypot(S(mv.x), S(mv.y))
                b = a * ratio
                rot = math.atan2(mv.y, mv.x)
                t0 = float(e.dxf.start_param)
                t1 = float(e.dxf.end_param)
                if not all(math.isfinite(v) for v in (a, b, rot, t0, t1)) or b <= 0:
                    raise ValueError("Ungültige Ellipse")
                full = abs((t1 - t0) - TAU) < 1e-6
                if not (a > 0):
                    continue
                if full and abs(rot) < 1e-6:
                    ellipses.append({"cx": cx, "cy": cy, "a": a, "b": b})
                    continue
                pts = []
                # Bogenlänge-adaptiv: ≤ 2° je Schritt (feste 72 waren bei
                # 420×320 bis 1 mm daneben).
                span = TAU if full else ((t1 - t0) % TAU)
                step = min(math.pi / 90, math.sqrt(8 * 0.01 / max(a, b)))
                n = max(24, math.ceil(span / step))
                if n > 100000:
                    raise ValueError("Ellipse zu groß oder zu komplex")
                count_points(n)
                angles = [span * i / n for i in range(n + 1)]
                tx = math.atan2(-b * math.sin(rot), a * math.cos(rot))
                ty = math.atan2(b * math.cos(rot), a * math.sin(rot))
                angles += [d for th in (tx, tx + math.pi, ty, ty + math.pi)
                           if 0 < (d := (th - t0) % TAU) < span]
                for angle in sorted(set(angles)):
                    th = t0 + angle
                    px = math.cos(th) * a
                    py = math.sin(th) * b
                    pts.append([cx + px * math.cos(rot) - py * math.sin(rot),
                                cy + px * math.sin(rot) + py * math.cos(rot)])
                (closed if full else open_seg).append(pts)
            elif t == "SPLINE":
                try:
                    pts = []
                    for p in e.flattening(0.01 / unit):     # Punkt für Punkt, damit die Grenze früh greift
                        count_points(1)
                        pts.append([S(p[0]), S(p[1])])
                except DxfLimit:
                    raise
                except Exception:                       # noqa: BLE001
                    raise ValueError("SPLINE konnte nicht ausgewertet werden") from None
                if len(pts) >= 2:
                    (closed if e.closed else open_seg).append(pts)
            elif t in ("HATCH",):
                skipped.append("Schraffuren wurden übergangen")
            elif t in ("TEXT", "MTEXT", "DIMENSION", "LEADER"):
                skipped.append("Text und Bemaßung wurden übergangen")
            else:
                skipped.append(f"{t} wurde übergangen")

    walk(msp)
    return {"circles": circles, "ellipses": ellipses, "closed": closed,
            "open": open_seg, "skipped": skipped,
            "unit_code": unit_code, "unit_scale_mm": unit}


# --------------------------------------------------------------------------
# 2) Flächen, Enthaltensein, Klassifikation
# --------------------------------------------------------------------------
def _area_of(pts: list) -> float:
    if not pts:
        return 0.0
    # Translate before the shoelace sum to avoid cancellation far from origin.
    x0, y0 = pts[0]
    pts = [[x - x0, y - y0] for x, y in pts]
    a = 0.0
    j = len(pts) - 1
    for i in range(len(pts)):
        a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
        j = i
    return abs(a / 2)


def _centroid_of(pts: list) -> list:
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return [(min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2]


def _in_poly(x: float, y: float, pts: list) -> bool:
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i][0], pts[i][1]
        xj, yj = pts[j][0], pts[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _as_rect(pts: list) -> dict | None:
    """Erkennt achsparallele Rechtecke (auch mit abgerundeten Ecken).

    cover ≥ 0,96; Radius immer aus dem Defizit (Schwelle „>0,995 → 0" klaute
    R12 bei 300×200). Wie dxf.js.
    """
    if not (4 <= len(pts) <= 720):
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    w = max(xs) - min(xs)
    h = max(ys) - min(ys)
    if not (w > 0) or not (h > 0):
        return None
    cover = _area_of(pts) / (w * h)
    if cover < 0.96 or cover > 1.001:
        return None
    r = math.sqrt(max(0.0, 1 - cover) * w * h / (4 - math.pi))
    c = _centroid_of(pts)
    rr = min(r, min(w, h) / 2)
    # Area coverage alone also accepts notches and chamfers as rounded corners.
    for x, y in pts:
        qx, qy = abs(x - c[0]) - (w / 2 - rr), abs(y - c[1]) - (h / 2 - rr)
        distance = math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - rr
        if abs(distance) > 0.02:
            return None
    return {"w": _r2(w), "h": _r2(h),
            "r": _r2(min(r, min(w, h) / 2)), "cx": c[0], "cy": c[1]}


def _as_circle(pts: list) -> dict | None:
    """Erkennt Kreise, die als Polylinie gezeichnet wurden (0,5 %, wie dxf.js)."""
    if len(pts) < 8:
        return None
    c = _centroid_of(pts)
    rs = [math.hypot(p[0] - c[0], p[1] - c[1]) for p in pts]
    rmin, rmax = min(rs), max(rs)
    if rmax <= 0 or (rmax - rmin) / rmax > 0.005:
        return None
    return {"cx": c[0], "cy": c[1], "r": (rmin + rmax) / 2}


# --------------------------------------------------------------------------
# 3) Konturmodell
# --------------------------------------------------------------------------
def _detect_bolts(shape: dict) -> None:
    """Gleich große Kreise auf gleichem Radius → Lochkreis (wie dxf.js)."""
    if shape["outer"].get("kind") != "circle":
        return
    circles = [(h, i) for i, h in enumerate(shape["holes"])
               if h.get("kind") == "circle"
               and math.hypot(h.get("x", 0), h.get("y", 0)) > 0.5]
    if len(circles) < 3:
        return
    groups: dict[tuple, list] = {}
    for h, i in circles:
        key = (round(h["d"] * 10), round(math.hypot(h["x"], h["y"]) * 5))
        groups.setdefault(key, []).append((h, i))
    best = max((g for g in groups.values() if len(g) >= 3),
               key=len, default=None)
    if not best:
        return
    first = best[0][0]
    phase = math.atan2(first["y"], first["x"])
    radius = math.hypot(first["x"], first["y"])
    if any(abs(math.hypot(h["x"], h["y"]) - radius) > 0.01
           or abs(h["d"] - first["d"]) > 0.01 for h, _ in best):
        return
    angles = sorted((math.atan2(h["y"], h["x"]) - phase) % TAU for h, _ in best)
    if any(abs(a - TAU * i / len(best)) * radius > TOL for i, a in enumerate(angles)):
        return
    shape["bolts"] = {"n": len(best),
                      "bc": _r2(math.hypot(first["x"], first["y"]) * 2),
                      "d": first["d"],
                      "phase": _r2(math.degrees(math.atan2(first["y"], first["x"])))}
    drop = {i for _, i in best}
    shape["holes"] = [h for i, h in enumerate(shape["holes"]) if i not in drop]


def _to_shape(parsed: dict) -> dict | None:
    items: list[dict] = []
    for c in parsed["circles"]:
        items.append({"kind": "circle", "area": math.pi * c["r"] * c["r"],
                      "c": [c["cx"], c["cy"]], "pts": None,
                      "g": {"kind": "circle", "d": _r2(c["r"] * 2)}})
    for e in parsed["ellipses"]:
        items.append({"kind": "oval", "area": math.pi * e["a"] * e["b"],
                      "c": [e["cx"], e["cy"]], "pts": None,
                      "g": {"kind": "oval", "w": _r2(e["a"] * 2), "h": _r2(e["b"] * 2)}})
    for pts in parsed["loops"]:
        circ = _as_circle(pts)
        if circ:
            items.append({"kind": "circle", "area": math.pi * circ["r"] * circ["r"],
                          "c": [circ["cx"], circ["cy"]], "pts": None,
                          "g": {"kind": "circle", "d": _r2(circ["r"] * 2)}})
            continue
        rect = _as_rect(pts)
        if rect:
            items.append({"kind": "rect", "area": rect["w"] * rect["h"],
                          "c": [rect["cx"], rect["cy"]], "pts": None,
                          "g": {"kind": "rect", "w": rect["w"], "h": rect["h"],
                                "r": rect["r"]}})
            continue
        c = _centroid_of(pts)
        # Zentriert auf die Mitte des Umschließenden, nicht auf den Schwerpunkt:
        # der Schachtelungskern legt die Standfläche (das Umschließende) mittig
        # aufs Teilzentrum. Bei unkonvexen Konturen fallen Schwerpunkt und
        # Kastenmitte auseinander — sonst landet die Kontur neben der Kiste,
        # die für sie reserviert wurde, bis über den Plattenrand hinaus.
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        b = [(min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2]
        # y gespiegelt: DXF zählt nach oben, SVG nach unten — wie in dxf.js.
        items.append({"kind": "poly", "area": _area_of(pts), "c": c, "b": b, "pts": pts,
                      "g": {"kind": "poly",
                            "pts": [[_r2(p[0] - b[0]), _r2(-(p[1] - b[1]))] for p in pts]}})
    if not items:
        return None

    items.sort(key=lambda it: it["area"], reverse=True)
    outer = items[0]
    # Referenz für die Aussparungslagen: dieselbe Kastenmitte, auf die auch
    # die Außenkontur zentriert wurde („b"; Kreise/Rechtecke sind von sich
    # aus mittig — dort gilt der Schwerpunkt „c").
    ox, oy = outer.get("b") or outer["c"]

    def inside(it: dict) -> bool:
        if it is outer:
            return False
        if outer["kind"] == "poly":
            return _in_poly(it["c"][0], it["c"][1], outer["pts"])
        dx, dy = it["c"][0] - ox, it["c"][1] - oy
        if outer["kind"] == "circle":
            return math.hypot(dx, dy) < outer["g"]["d"] / 2
        return abs(dx) < outer["g"]["w"] / 2 and abs(dy) < outer["g"]["h"] / 2

    holes = []
    for it in items:
        if not inside(it):
            continue
        h = dict(it["g"])
        h["x"] = _r2(it["c"][0] - ox)
        h["y"] = _r2(-(it["c"][1] - oy))
        holes.append(h)
    dropped = len(items) - 1 - len(holes)

    shape: dict = {"outer": dict(outer["g"]), "holes": holes, "bolts": None}
    # A centre inside the outline does not imply a contained circular cutout.
    for h in holes:
        if h["kind"] == "circle" and shape["outer"]["kind"] != "oval" and _dist_inside(
                shape["outer"], h["x"], h["y"]) < h["d"] / 2 - 0.01:
            raise ValueError("Aussparung ragt über die Außenkontur")
    for i, h in enumerate(holes):
        for other in holes[:i]:
            if h["kind"] == other["kind"] == "circle" and math.hypot(
                    h["x"] - other["x"], h["y"] - other["y"]) <= (h["d"] + other["d"]) / 2:
                raise ValueError("Überlappende oder verschachtelte Aussparungen")
    _detect_bolts(shape)
    return {"shape": shape, "dropped": dropped, "count": len(items)}


# --------------------------------------------------------------------------
# Öffentlich
# --------------------------------------------------------------------------
def parse_dxf(text: str) -> dict:
    """Keep malformed entity geometry on the upload validation path, not HTTP 500."""
    try:
        return _parse_dxf(text.lstrip("\ufeff"))
    except DxfLimit as exc:
        return {"error": str(exc)}
    except (ValueError, TypeError, ArithmeticError, ezdxf.DXFError):
        return {"error": "Ungültige oder nicht unterstützte DXF-Geometrie oder Einheit."}


def _parse_dxf(text: str) -> dict:
    """DXF-Text → Kontur und Kennzahlen.

    Rückbau wie ``DXF.parse`` im Portal plus ``GEO.metrics``: shape (outer,
    holes, bolts), od/di/cut_len/w/h. Ein Fehler kommt als ``{"error": …}``
    zurück, nie als Ausnahme.
    """
    if text.startswith("AutoCAD Binary DXF"):
        return {"error": "Das ist eine binäre DXF-Datei. Bitte in Ihrem CAD als "
                         "„ASCII-DXF“ (R12 oder neuer) speichern."}
    if text.lstrip()[:5] == "<?xml" or text.lstrip()[:4] == "<svg":
        return {"error": "Das sieht nach einer SVG-Datei aus. Gelesen wird DXF — "
                         "bitte aus dem CAD als DXF exportieren."}

    read = _read_entities(text)
    if read.get("error"):
        return read

    if len(read["open"]) > MAX_CHAIN_SEGMENTS:
        return {"error": f"Die Zeichnung hat {len(read['open'])} offene Linienstücke, erlaubt sind "
                         f"{MAX_CHAIN_SEGMENTS}. Bitte Konturen im CAD als geschlossene Polylinien speichern."}
    chains = _chain(read["open"])
    loops = [c for c in chains
             if len(c) > 2
             and math.hypot(c[0][0] - c[-1][0], c[0][1] - c[-1][1]) <= CHAIN_TOL]
    open_left = len(chains) - len(loops)

    parsed = {"circles": read["circles"], "ellipses": read["ellipses"],
              "loops": read["closed"] + loops}
    built = _to_shape(parsed)
    if not built:
        return {"error": "Keine geschlossene Kontur gefunden. Gelesen werden "
                         "CIRCLE, ARC, LINE, LWPOLYLINE, POLYLINE, ELLIPSE und SPLINE."}

    result = {**built, "skipped": read["skipped"], "open_left": open_left,
              "unit_code": read["unit_code"], "unit_scale_mm": read["unit_scale_mm"]}
    m = metrics(result["shape"])
    if not all(math.isfinite(v) for v in m.values()) or min(
            m["w"], m["h"], m["cut_len"], m["gross"], m["net"]) <= 0:
        return {"error": "Die Kontur hat keine messbare Fläche oder ungültige Maße."}
    result.update(od=m["od"], di=m["di"], cut_len=m["cut_len"], w=m["w"], h=m["h"])
    return result
