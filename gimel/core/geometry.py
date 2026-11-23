"""Konturkennzahlen — verhaltensgleiche Portierung der Kennzahlen aus
assets/geometry.js (metrics, outerRadius, perimeterOf, boreDiameter).

Der Rechenkern braucht od/di/cut_len, um eine freie Kontur zu bepreisen
(CLAUDE.md §5.2). Diese Werte entstehen im Portal im Browser; hier, auf dem
Server, werden sie gebraucht, wenn eine Kontur nie einen Browser gesehen hat —
DXF-Import im Auftragsbüro, KI-Angebot aus einer PDF-Zeichnung. Vorschau und
Rechnung dürfen nie auseinanderlaufen, also stammt die Portierung aus derselben
Datei und mit denselben Rundungen (r1 = eine Nachkommastelle).

Pure functions — keine I/O, kein ORM (CLAUDE.md §3).
"""

from __future__ import annotations

import math
from typing import Any

TAU = math.pi * 2


def _r1(v: float) -> float:
    return round(v * 10) / 10


def _r2(v: float) -> float:
    return round(v * 100) / 100


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def outer_radius(o: dict) -> float:
    kind = o.get("kind")
    if kind == "circle":
        return float(o.get("d", 0)) / 2
    if kind == "rect":
        return math.hypot(float(o.get("w", 0)), float(o.get("h", 0))) / 2
    if kind == "oval":
        return max(float(o.get("w", 0)), float(o.get("h", 0))) / 2
    if kind == "poly":
        return max((math.hypot(p[0], p[1]) for p in (o.get("pts") or [])), default=0.0)
    return 0.0


def extent(o: dict) -> tuple[float, float]:
    kind = o.get("kind")
    if kind == "circle":
        d = float(o.get("d", 0))
        return d, d
    if kind in ("rect", "oval", "slot"):
        return float(o.get("w", 0)), float(o.get("h", 0))
    if kind == "poly":
        pts = o.get("pts") or []
        if not pts:
            return 0.0, 0.0
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return max(xs) - min(xs), max(ys) - min(ys)
    return 0.0, 0.0


def ellipse_perimeter(w: float, h: float) -> float:
    """Exakt via Simpson (720 Schritte) — dieselbe Rechnung wie geometry.js.

    P = ∫₀²π √(a²·sin²t + b²·cos²t) dt. Ramanujan II (Fehler ~1e-5, bei
    420×320 ≈ 0,1 mm Schnittlänge) reicht nicht für technisch exakte Maße.
    N=720, gleiche Schrittfolge wie in JS — Parität bis auf Libm-Rauschen.
    """
    a, b = w / 2, h / 2
    if not (a > 0) or not (b > 0):
        return 0.0
    if a == b:
        return 2 * math.pi * a
    n = 720
    dt = TAU / n

    def f(t: float) -> float:
        return math.sqrt(a * a * math.sin(t) ** 2 + b * b * math.cos(t) ** 2)

    s = f(0.0) + f(TAU)
    for i in range(1, n):
        s += (4 if i % 2 else 2) * f(i * dt)
    return s * dt / 3


def rounded_rect_perimeter(w: float, h: float, r: float) -> float:
    rr = _clamp(r or 0, 0, min(w, h) / 2)
    return 2 * (w - 2 * rr) + 2 * (h - 2 * rr) + TAU * rr


def poly_perimeter(pts: list) -> float:
    if not pts or len(pts) < 2:
        return 0.0
    length = 0.0
    for i in range(len(pts)):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % len(pts)]
        length += math.hypot(bx - ax, by - ay)
    return length


def perimeter_of(g: dict) -> float:
    kind = g.get("kind")
    if kind == "circle":
        return math.pi * float(g.get("d", 0))
    if kind == "rect":
        return rounded_rect_perimeter(float(g.get("w", 0)), float(g.get("h", 0)),
                                      float(g.get("r", 0) or 0))
    if kind == "oval":
        return ellipse_perimeter(float(g.get("w", 0)), float(g.get("h", 0)))
    if kind == "slot":
        w, h = float(g.get("w", 0)), float(g.get("h", 0))
        return rounded_rect_perimeter(w, h, min(w, h) / 2)
    if kind == "poly":
        return poly_perimeter(g.get("pts") or [])
    return 0.0


def bolt_holes(shape: dict | None) -> list[dict]:
    b = (shape or {}).get("bolts")
    if not isinstance(b, dict):
        return []
    n = int(round(b.get("n") or 0))
    if not (n > 0) or not (b.get("d", 0) > 0) or not (b.get("bc", 0) > 0):
        return []
    ph = (b.get("phase") or 0) * math.pi / 180
    out = []
    for k in range(n):
        a = ph + TAU * k / n
        out.append({"kind": "circle", "d": b["d"],
                    "x": round(math.cos(a) * b["bc"] / 2, 6),
                    "y": round(math.sin(a) * b["bc"] / 2, 6),
                    "bolt": True})
    return out


def holes_of(shape: dict | None) -> list[dict]:
    holes = (shape or {}).get("holes") or []
    return list(holes) + bolt_holes(shape)


def _seg_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy
    t = _clamp(((px - ax) * vx + (py - ay) * vy) / l2, 0, 1) if l2 else 0.0
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def _point_in_poly(x: float, y: float, pts: list) -> bool:
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i][0], pts[i][1]
        xj, yj = pts[j][0], pts[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _dist_inside(g: dict, x: float, y: float) -> float:
    """Abstand zum Rand — positiv innerhalb. Näherung wie in geometry.js."""
    dx = x - (g.get("x") or 0)
    dy = y - (g.get("y") or 0)
    kind = g.get("kind")
    if kind == "circle":
        return float(g.get("d", 0)) / 2 - math.hypot(dx, dy)
    if kind == "rect":
        w, h = float(g.get("w", 0)), float(g.get("h", 0))
        r = _clamp(float(g.get("r", 0) or 0), 0, min(w, h) / 2)
        qx, qy = abs(dx) - (w / 2 - r), abs(dy) - (h / 2 - r)
        return r - math.hypot(max(qx, 0), max(qy, 0)) - min(max(qx, qy), 0)
    if kind == "slot":
        w, h = float(g.get("w", 0)), float(g.get("h", 0))
        if h > w:
            w, h, dx, dy = h, w, dy, dx
        half = max(0.0, (w - h) / 2)
        px = max(0.0, abs(dx) - half)
        return h / 2 - math.hypot(px, dy)
    if kind == "oval":
        a, b = float(g.get("w", 0)) / 2, float(g.get("h", 0)) / 2
        if not (a > 0) or not (b > 0):
            return -1.0
        t = math.hypot(dx / a, dy / b)
        return (1 - t) * min(a, b)
    if kind == "poly":
        pts = g.get("pts") or []
        if len(pts) < 3:
            return -1.0
        best = min(_seg_dist(dx, dy, pts[i][0], pts[i][1],
                             pts[(i + 1) % len(pts)][0], pts[(i + 1) % len(pts)][1])
                   for i in range(len(pts)))
        return best if _point_in_poly(dx, dy, pts) else -best
    return -1.0


def bore_diameter(shape: dict | None) -> float:
    """Größter konzentrischer Bohrungs-Ø — die Restfläche, in die die Engine
    kleinere Teile legen darf (CLAUDE.md §5.1)."""
    best = 0.0
    for h in holes_of(shape):
        best = max(best, 2 * max(0.0, _dist_inside(h, 0, 0)))
    return best


def poly_area(pts: list) -> float:
    if not pts or len(pts) < 3:
        return 0.0
    a = 0.0
    for i in range(len(pts)):
        p, q = pts[i], pts[(i + 1) % len(pts)]
        a += p[0] * q[1] - q[0] * p[1]
    return abs(a) / 2


def area_of(g: dict) -> float:
    kind = g.get("kind")
    if kind == "circle":
        d = float(g.get("d", 0))
        return math.pi * d * d / 4
    if kind == "rect":
        rr = _clamp(float(g.get("r", 0) or 0), 0, min(float(g.get("w", 0)), float(g.get("h", 0))) / 2)
        return float(g.get("w", 0)) * float(g.get("h", 0)) - (4 - math.pi) * rr * rr
    if kind == "oval":
        return math.pi * float(g.get("w", 0)) * float(g.get("h", 0)) / 4
    if kind == "slot":
        # Stadion: Gesamtlänge × Höhe. (L−D)×D + Kreis Ø D, D = min(w,h).
        # JS gab früher w×h zurück (+8 % bei 46×18); hier fehlte der Zweig
        # ganz (Fläche 0 → Netto zu groß). Beide jetzt exakt gleich.
        w, h = float(g.get("w", 0)), float(g.get("h", 0))
        d = min(w, h)
        L = max(w, h)
        return (L - d) * d + math.pi * d * d / 4
    if kind == "poly":
        return poly_area(g.get("pts") or [])
    return 0.0


def gross_area(shape: dict | None) -> float:
    if not shape or not shape.get("outer"):
        return 0.0
    return area_of(shape["outer"])


def net_area(shape: dict | None) -> float:
    if not shape or not shape.get("outer"):
        return 0.0
    a = area_of(shape["outer"])
    for h in holes_of(shape):
        a -= area_of(h)
    return max(0.0, a)


def metrics(shape: dict | None) -> dict[str, Any]:
    """Die Kennzahlen, die eine Position bepreisen: Umkreis, Bohrung,
    Schnittlänge — plus Hüllmaß für Zeichnung und Versand."""
    if not shape or not shape.get("outer"):
        return {"od": 0, "di": 0, "cut_len": 0, "w": 0, "h": 0, "n_holes": 0,
                "gross": 0, "net": 0}
    holes = holes_of(shape)
    cut = perimeter_of(shape["outer"]) + sum(perimeter_of(h) for h in holes)
    w, h = extent(shape["outer"])
    return {
        "od": _r1(2 * outer_radius(shape["outer"])),
        "di": _r1(bore_diameter(shape)),
        "cut_len": _r1(cut),
        "w": _r1(w), "h": _r1(h),
        "n_holes": len(holes),
        "gross": _r1(gross_area(shape)),
        "net": _r1(net_area(shape)),
    }


def ring_from_params(od: float, di: float = 0.0, bn: int = 0, bc: float = 0.0,
                     bd: float = 0.0, phase: float = 0.0) -> dict:
    """Ring aus Parametern — die Normalform, ohne shape gerechnet wie in
    geometry.js shapeFromPosition."""
    shape: dict = {"outer": {"kind": "circle", "d": float(od)}, "holes": [], "bolts": None}
    if di and di > 0:
        shape["holes"].append({"kind": "circle", "d": float(di), "x": 0, "y": 0})
    if bn and bn > 0 and bc and bc > 0 and bd and bd > 0:
        shape["bolts"] = {"n": int(bn), "bc": float(bc), "d": float(bd), "phase": phase}
    return shape


def rect_from_params(w: float, h: float, r: float = 0.0, di: float = 0.0,
                     di_w: float = 0.0, di_h: float = 0.0) -> dict:
    """Rechteck mit optionalem rechteckigem/ovalem Ausschnitt."""
    shape: dict = {"outer": {"kind": "rect", "w": float(w), "h": float(h), "r": float(r)},
                   "holes": [], "bolts": None}
    if di_w and di_h and di_w > 0 and di_h > 0:
        shape["holes"].append({"kind": "rect", "w": float(di_w), "h": float(di_h),
                               "r": float(r), "x": 0, "y": 0})
    elif di and di > 0:
        shape["holes"].append({"kind": "circle", "d": float(di), "x": 0, "y": 0})
    return shape
