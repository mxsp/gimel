"""Teileerkennung: welches Teil liegt da? Mit der Technik des DXF Depth Vision Matcher.

Eine Kamera sieht den Tisch von oben. Aus Kamerahöhe, Blickwinkel und Neigung wird
jede Bildkontur auf die Tischebene zurückgerechnet (``TableScale``), in Millimetern.
Danach wird vorab nach Maßen, Fläche und Füllgrad sortiert; die Form selbst entscheidet
als Überdeckung der normierten Konturen über alle acht Lagen (``shape_distance``):
gedrehte, gewendete und symmetrische Teile gehen damit gleich gut. Die Masken der
erwarteten Teile werden je Auflösung zwischengespeichert, damit ein Tisch voller
Kleinteile nicht für jedes Bild neu rastert.

Zwei Abweichungen vom Vorbild. Verglichen wird die Kontur *samt Löchern*: zwei
Dichtungen mit gleichem Außenmaß und anderer Bohrung sind verschiedene Teile. Und
hier wird kein OpenCV gebraucht; das Bild selbst liest ``services/vision.py``.

Rein: keine Datenbank, keine Uhr, kein Bild. Eingabe sind Punkte.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Optional, Sequence

import numpy as np


#: So viele Teile mit den nächsten Maßen werden je Kontur der Form nach verglichen.
MAX_NEAR = 8

#: Kantenlänge des Formrasters in Pixeln (halbe Kante). 160 löst eine 300-mm-Dichtung
#: auf rund 1 mm auf; feiner bringt bei Konturrauschen nichts und kostet nur Zeit.
GRID_HALF = 160

#: Die acht Lagen eines flachen Teils: gewendet oder nicht, dazu vier Vierteldrehungen.
_POSES = tuple((flip, k) for flip in (1, -1) for k in range(4))


@dataclass
class Calibration:
    """Aufbau am Tisch; gespeichert in der Einstellung ``vision_calibration``."""

    height_mm: float = 600.0
    thickness_mm: float = 0.0
    hfov_deg: float = 70.0
    tolerance_mm: float = 3.0
    pitch_deg: float = 0.0     # Neigung um die Bild-x-Achse, 0 = senkrecht nach unten
    roll_deg: float = 0.0      # Neigung um die Bild-y-Achse
    origin_x_mm: float = 0.0   # wo der Tischursprung im waagerechten Kamerarahmen liegt
    origin_y_mm: float = 0.0
    yaw_deg: float = 0.0       # Drehung der Tisch-X-Achse gegen die Bild-X-Achse
    #: Gemessene Punkte ``{"distance_mm", "mm_per_px"}``; ersetzen das Modell aus dem
    #: Blickwinkel: einer legt die Brennweite fest, ab zwei wird interpoliert.
    points: list = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Optional[dict]) -> "Calibration":
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in (data or {}).items() if k in names})

    def to_dict(self) -> dict:
        return asdict(self)

    def mm_per_px_at(self, z_mm: float, width_px: int) -> float:
        pts = sorted(self.points, key=lambda p: p["distance_mm"])
        if len(pts) >= 2:
            if z_mm <= pts[0]["distance_mm"]:
                a, b = pts[0], pts[1]
            elif z_mm >= pts[-1]["distance_mm"]:
                a, b = pts[-2], pts[-1]
            else:
                a, b = next((pts[i], pts[i + 1]) for i in range(len(pts) - 1)
                            if pts[i]["distance_mm"] <= z_mm <= pts[i + 1]["distance_mm"])
            t = (z_mm - a["distance_mm"]) / (b["distance_mm"] - a["distance_mm"])
            return a["mm_per_px"] + t * (b["mm_per_px"] - a["mm_per_px"])
        if len(pts) == 1:
            return pts[0]["mm_per_px"] * z_mm / pts[0]["distance_mm"]
        return z_mm * 2 * math.tan(math.radians(self.hfov_deg) / 2) / width_px

    def add_point(self, distance_mm: float, known_mm: float, measured_px: float) -> None:
        self.points = [p for p in self.points if p["distance_mm"] != distance_mm]
        self.points.append({"distance_mm": distance_mm, "mm_per_px": known_mm / measured_px})


@dataclass
class CountZone:
    """Ein Zählbereich auf dem Tisch: was darin liegt, ist gezählt.

    ``points`` ist das Rechteck so, wie es im Bild aufgezogen wurde (0..1), für die
    Anzeige. ``points_mm`` ist dasselbe auf der Tischebene; nur damit wird gerechnet,
    denn die Kamera kann schräg stehen und das Bild verzerrt dann das Rechteck.
    """

    points: list = field(default_factory=list)
    points_mm: list = field(default_factory=list)
    enabled: bool = False
    auto_count: bool = True

    @classmethod
    def from_dict(cls, data: Optional[dict]) -> "CountZone":
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in (data or {}).items() if k in names})

    def to_dict(self) -> dict:
        return asdict(self)

    def contains(self, x_mm: float, y_mm: float) -> bool:
        """Punkt-in-Polygon; der Rand zählt mit, damit ein Teil am Rand nicht flattert."""
        pts = self.points_mm
        if len(pts) < 3:
            return False
        inside = False
        for i in range(len(pts)):
            x1, y1 = pts[i][:2]
            x2, y2 = pts[(i + 1) % len(pts)][:2]
            if abs((x2 - x1) * (y_mm - y1) - (x_mm - x1) * (y2 - y1)) < 1e-9 \
                    and min(x1, x2) - 1e-9 <= x_mm <= max(x1, x2) + 1e-9 \
                    and min(y1, y2) - 1e-9 <= y_mm <= max(y1, y2) + 1e-9:
                return True
            if (y1 > y_mm) != (y2 > y_mm):
                at = x1 + (y_mm - y1) * (x2 - x1) / (y2 - y1)
                if x_mm < at:
                    inside = not inside
        return inside


class TableScale:
    """Pixel auf die Tischebene, auch bei geneigter Kamera.

    Rahmen: X nach rechts, Y im Bild nach unten, Z senkrecht zum Tisch. Jeder Pixelstrahl
    wird mit der Ebene ``z_mm`` unter der Kamera geschnitten; gemessen wird also auf
    dem Tisch, nicht im Bild.
    """

    def __init__(self, calib: Calibration, width_px: int, height_px: int) -> None:
        self.calib, self.width_px, self.height_px = calib, width_px, height_px
        self.cx, self.cy = width_px / 2, height_px / 2
        self.fx = (width_px / 2) / math.tan(math.radians(calib.hfov_deg) / 2)
        p, r = math.radians(calib.pitch_deg), math.radians(calib.roll_deg)
        rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
        ry = np.array([[math.cos(r), 0, math.sin(r)], [0, 1, 0], [-math.sin(r), 0, math.cos(r)]])
        self.rot = rx @ ry
        self.origin = (calib.origin_x_mm, calib.origin_y_mm)
        self.yaw = math.radians(calib.yaw_deg)

    @property
    def z_mm(self) -> float:
        return self.calib.height_mm - self.calib.thickness_mm

    def _focal(self, z: float) -> float:
        if self.calib.points:
            return z / self.calib.mm_per_px_at(z, self.width_px)
        return self.fx

    def to_table(self, pixels: np.ndarray, z_mm: Optional[float] = None) -> np.ndarray:
        """Nx2 Pixel → Nx2 Millimeter im Tischrahmen."""
        z = z_mm or self.z_mm
        f = self._focal(z)
        px = np.asarray(pixels, dtype=np.float64).reshape(-1, 2)
        rays = np.column_stack([(px[:, 0] - self.cx) / f, (px[:, 1] - self.cy) / f,
                                np.ones(len(px))]) @ self.rot.T
        if (rays[:, 2] <= 1e-6).any():
            raise ValueError("Die Kamera ist zu stark geneigt: ein Strahl trifft den Tisch nicht.")
        t = z / rays[:, 2]
        dx, dy = t * rays[:, 0] - self.origin[0], t * rays[:, 1] - self.origin[1]
        c, s = math.cos(self.yaw), math.sin(self.yaw)
        return np.column_stack([c * dx + s * dy, -s * dx + c * dy])

    def to_pixels(self, table_mm: np.ndarray, z_mm: Optional[float] = None) -> np.ndarray:
        """Umkehrung von ``to_table``."""
        z = z_mm or self.z_mm
        f = self._focal(z)
        pts = np.asarray(table_mm, dtype=np.float64).reshape(-1, 2)
        c, s = math.cos(self.yaw), math.sin(self.yaw)
        x = c * pts[:, 0] - s * pts[:, 1] + self.origin[0]
        y = s * pts[:, 0] + c * pts[:, 1] + self.origin[1]
        cam = np.column_stack([x, y, np.full(len(pts), z)]) @ self.rot
        return np.column_stack([f * cam[:, 0] / cam[:, 2] + self.cx,
                                f * cam[:, 1] / cam[:, 2] + self.cy])


# ---------------- Kontur ----------------
def _hull(pts: np.ndarray) -> np.ndarray:
    """Konvexe Hülle (monotone Kette)."""
    p = sorted({(float(x), float(y)) for x, y in pts})
    if len(p) < 3:
        return np.array(p)

    def half(points: Sequence) -> list:
        out: list = []
        for q in points:
            while len(out) >= 2 and ((out[-1][0] - out[-2][0]) * (q[1] - out[-2][1])
                                     - (out[-1][1] - out[-2][1]) * (q[0] - out[-2][0])) <= 0:
                out.pop()
            out.append(q)
        return out[:-1]

    return np.array(half(p) + half(p[::-1]))


def oriented_box(pts: np.ndarray) -> dict:
    """Kleinstes umschließendes Rechteck: Mitte, Länge ≥ Breite, Winkel der Längsachse."""
    pts = np.asarray(pts, dtype=np.float64)
    hull = _hull(pts)
    best: Optional[tuple] = None
    if len(hull) < 2:
        angles = [0.0]
    else:
        e = np.roll(hull, -1, axis=0) - hull
        angles = sorted({round(a % (math.pi / 2), 9) for a in np.arctan2(e[:, 1], e[:, 0]).tolist()})
    for a in angles:
        c, s = math.cos(a), math.sin(a)
        u = hull[:, 0] * c + hull[:, 1] * s
        v = -hull[:, 0] * s + hull[:, 1] * c
        w, h = float(u.max() - u.min()), float(v.max() - v.min())
        if best is None or w * h < best[0] - 1e-9:
            mu, mv = (u.max() + u.min()) / 2, (v.max() + v.min()) / 2
            best = (w * h, w, h, a, mu * c - mv * s, mu * s + mv * c)
    _, w, h, a, x, y = best
    if w < h:
        w, h, a = h, w, a + math.pi / 2
    return {"length_mm": w, "width_mm": h, "x_mm": float(x), "y_mm": float(y),
            "angle_deg": math.degrees(a) % 180}


def _centroid(ring: np.ndarray) -> np.ndarray:
    x, y = ring[:, 0], ring[:, 1]
    xn, yn = np.roll(x, -1), np.roll(y, -1)
    cross = x * yn - xn * y
    a = cross.sum() / 2
    if abs(a) < 1e-9:
        return ring.mean(axis=0)
    return np.array([((x + xn) * cross).sum(), ((y + yn) * cross).sum()]) / (6 * a)


def normalize(rings: Sequence) -> list:
    """Mitte auf den Schwerpunkt, Längsachse auf +x, Einheit bleibt mm. Ring 0 ist außen."""
    arrs = [np.asarray(r, dtype=np.float64) for r in rings]
    c = _centroid(arrs[0])
    a = math.radians(-oriented_box(arrs[0])["angle_deg"])
    rot = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    return [(r - c) @ rot.T for r in arrs]


def _mask(rings: Sequence, px: float, half: int) -> np.ndarray:
    """Füllt die Ringe nach der Gerade-Ungerade-Regel: Löcher bleiben frei.

    Alle Schnittpunkte einer Bildzeile werden in einem Zug gerechnet und sortiert.
    Das ist derselbe Scanline-Algorithmus wie zuvor, nur ohne Python-Schleife über
    jede Kante — bei 40 Teilen und acht Lagen der Unterschied zwischen Sekunden und
    Augenblicken. Die Parität der Schnittpunkte links vom Bildpunkt entscheidet.
    """
    a = np.concatenate(rings) / px + half
    b = np.concatenate([np.roll(r, -1, axis=0) for r in rings]) / px + half
    size = 2 * half
    if len(a) < 3:
        return np.zeros((size, size), dtype=bool)
    y = np.arange(size, dtype=np.float64) + 0.5
    ay, by = a[:, 1:2], b[:, 1:2]
    crosses = (ay > y) != (by > y)
    dy = by - ay
    # Waagerechte Kanten kreuzen nie; der Nenner wird dort nie gelesen, aber numpy
    # rechnet vektoriell weiter und würde sonst durch null teilen.
    xs = a[:, 0:1] + (y - ay) * (b[:, 0:1] - a[:, 0:1]) / np.where(crosses, dy, 1.0)
    xs = np.where(crosses, xs, np.inf)
    xs.sort(axis=0)
    count = crosses.sum(axis=0).astype(np.int64)
    probes = np.arange(size, dtype=np.float64) + 0.5
    out = np.zeros((size, size), dtype=bool)
    for j in np.nonzero(count >= 2)[0]:
        inside = np.searchsorted(xs[: count[j], j], probes, side="right") & 1
        out[j] = inside == 1
    return out


def _pose_ring(ring: np.ndarray, flip: int, quarter_turns: int) -> np.ndarray:
    """Spiegeln und um 90° drehen, ohne eine Matrix je Punkt zu bauen."""
    x, y = ring[:, 0] * flip, ring[:, 1]
    for _ in range(quarter_turns):
        x, y = -y, x
    return np.column_stack([x, y])


def _ring_area(ring: np.ndarray) -> float:
    x, y = ring[:, 0], ring[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _radius(rings: Sequence) -> float:
    return max(float(np.linalg.norm(r, axis=1).max()) for r in rings)


def _grid(rings_list: Sequence[Sequence]) -> tuple[float, int, np.ndarray]:
    """Gemeinsames Raster für gemessene und erwartete Kontur."""
    extent = max(_radius(r) for r in rings_list) * 1.06
    px = max(0.35, extent / (GRID_HALF * 1.06))
    half = int(math.ceil(extent / px)) + 3
    return px, half, _mask(rings_list[0], px, half)


def _overlap(ma: np.ndarray, mb: np.ndarray) -> float:
    union = int(np.count_nonzero(ma | mb))
    return float(np.count_nonzero(ma & mb)) / union if union else 0.0


def _best_overlap(ma: np.ndarray, rings: Sequence, px: float, half: int,
                  masks: Optional[Sequence[np.ndarray]] = None) -> float:
    if masks is None:
        masks = [_mask([_pose_ring(r, flip, k) for r in rings], px, half) for flip, k in _POSES]
    return max((_overlap(ma, mb) for mb in masks), default=0.0)


def shape_distance(a_rings: Sequence, b_rings: Sequence) -> float:
    """1 − beste Überdeckung (IoU) zweier normierter Teile über acht Lagen. 0 = gleich."""
    px, half, ma = _grid([a_rings, b_rings])
    return 1.0 - _best_overlap(ma, b_rings, px, half)


@dataclass
class Candidate:
    """Ein erwartetes Teil. ``ref`` gehört dem Aufrufer und kommt unverändert zurück."""

    ref: Any
    length_mm: float
    width_mm: float
    rings: list
    #: Die acht Lagen als Bitmaske, je Auflösung einmal gerechnet. Dieselbe Form steht
    #: oft in mehreren Innenaufträgen; so wird sie nicht für jedes Bild neu gerastert.
    _masks: dict = field(default_factory=dict, init=False, repr=False, compare=False)
    _area: float = field(default=0.0, init=False, repr=False, compare=False)
    _fill: float = field(default=0.0, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        self._area = _ring_area(self.rings[0])
        self._fill = self._area / max(self.length_mm * self.width_mm, 1e-9)

    def masks(self, px: float, half: int) -> list[np.ndarray]:
        key = (round(px, 6), int(half))
        got = self._masks.get(key)
        if got is None:
            got = [_mask([_pose_ring(r, flip, k) for r in self.rings], px, half)
                   for flip, k in _POSES]
            if len(self._masks) >= 8:  # verschiedene Bildgrößen im Tagesbetrieb
                self._masks.pop(next(iter(self._masks)))
            self._masks[key] = got
        return got


def candidate(ref: Any, rings: Sequence) -> Candidate:
    box = oriented_box(np.asarray(rings[0], dtype=np.float64))
    return Candidate(ref, box["length_mm"], box["width_mm"], normalize(rings))


def match(rings_mm: Sequence, candidates: Sequence[Candidate], tolerance_mm: float = 3.0,
          max_distance: float = 0.14) -> Optional[dict]:
    """Das beste Teil zu einer gemessenen Kontur, oder None, wenn keines passt.

    Vor dem Formvergleich wird nicht mehr nur das umschließende Rechteck geprüft,
    sondern auch Fläche und Füllgrad: ein Ring und eine Scheibe mit gleichem Außenmaß
    sind damit schon aussortiert, bevor das Raster läuft. Der Vergleich selbst nimmt
    die beste von acht Lagen und vergleicht die Konturen samt Löchern.

    Rückgabe: ``ref``, ``confidence``, ``distance`` und die gemessene Lage auf dem Tisch.
    ``ambiguous`` nennt die Fälle, in denen ein zweites Teil fast gleich gut passt.
    """
    box = oriented_box(np.asarray(rings_mm[0], dtype=np.float64))
    extent = np.asarray(rings_mm[0], dtype=np.float64)
    meas_area = _ring_area(extent)
    meas_fill = meas_area / max(box["length_mm"] * box["width_mm"], 1e-9)
    # Ein einzelner ausgefranster Punkt an einer schmalen Lippe verschiebt das
    # kleinstmaßgebende Rechteck um Millimeter. Die Form entscheidet gleich danach;
    # hier darf die Toleranz deshalb mit der schmalen Seite wachsen.
    slack = max(tolerance_mm, 0.04 * min(box["length_mm"], box["width_mm"]))
    near = []
    for c in candidates:
        if abs(c.length_mm - box["length_mm"]) > slack:
            continue
        if abs(c.width_mm - box["width_mm"]) > slack:
            continue
        if c._area > 0 and not 0.62 <= meas_area / c._area <= 1.55:
            continue
        if abs(meas_fill - c._fill) > 0.30:
            continue
        near.append(c)
    if not near:
        return None

    def rank(c: Candidate) -> float:
        return (abs(c.length_mm - box["length_mm"]) + abs(c.width_mm - box["width_mm"])) / slack \
            + 2.0 * abs(math.log(max(meas_area, 1e-9) / max(c._area, 1e-9)))

    near.sort(key=rank)
    near = near[:MAX_NEAR]
    seen = normalize(rings_mm)
    px, half, ma = _grid([seen, *[c.rings for c in near]])
    scored = sorted(((1.0 - _best_overlap(ma, c.rings, px, half, c.masks(px, half)), i)
                     for i, c in enumerate(near)))
    d, i = scored[0]
    if d > max_distance:
        return None
    return {"ref": near[i].ref, "confidence": round(1 - d, 3), "distance": d, **box,
            "ambiguous": [near[j].ref for dist, j in scored[1:] if dist - d < 0.02]}
