/* Dach- und Mehrgeschoss-Geometrie (reine Rechnung, kein THREE, kein DOM).
 *
 * Hält Dachträger, Pfetten, Lichtbänder und Geschoss-Verbindungslinien strikt
 * innerhalb beliebiger (auch konkaver / L- oder U-förmiger) Hallenumrisse und
 * berücksichtigt nicht deckungsgleich gestapelte Geschosse (Rücksprünge,
 * Auskragungen, versetzte Obergeschosse). */

import { pointInPolygon } from "../../factory";

export type Pt2 = [number, number];
export type Seg2 = { a: Pt2; b: Pt2 };
export type Interval = [number, number];

export interface SkylightStrip {
  /** Mittelpunkt X in Hallenmetern. */
  cx: number;
  /** Mittelpunkt Z (Grundriss-Y) in Hallenmetern. */
  cz: number;
  /** Breite entlang X. */
  wx: number;
  /** Tiefe entlang Z. */
  wz: number;
}

export interface LevelOutlineSpan {
  id: number;
  offset: number;
  height: number;
  outline: Pt2[];
}

export interface ConnectorShaft {
  x: number;
  z: number;
  y0: number;
  y1: number;
  /** true = Ecke kragt über (kein Geschoss direkt darunter / darüber). */
  overhang: boolean;
}

const EPS = 1e-6;

/** Schneidet eine achsenparallele Linie (``axis === "x"`` → vertikale Linie x = coord,
 *  ``axis === "z"`` → horizontale Linie y = coord) mit einem einfachen Polygon
 *  (auch konkav) und liefert alle innenliegenden Intervalle ``[min, max]``. */
export function clipAxisLineToPolygon(
  outline: Pt2[],
  axis: "x" | "z",
  coord: number,
): Interval[] {
  if (outline.length < 3) return [];
  const hits: number[] = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = outline[i];
    const [x2, y2] = outline[(i + 1) % n];
    const a = axis === "x" ? x1 : y1;
    const b = axis === "x" ? x2 : y2;
    const oa = axis === "x" ? y1 : x1;
    const ob = axis === "x" ? y2 : x2;
    // Halboffene Intervall-Regel [min, max) vermeidet Doppelzählung an Eckpunkten.
    if ((a <= coord && b > coord) || (b <= coord && a > coord)) {
      const t = (coord - a) / (b - a);
      hits.push(oa + t * (ob - oa));
    }
  }
  hits.sort((u, v) => u - v);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) {
    const lo = hits[i];
    const hi = hits[i + 1];
    if (hi - lo > 0.05) out.push([lo, hi]);
  }
  return out;
}

/** Subtrahiert eine Menge von Intervallen ``cuts`` von ``base``. */
export function subtractIntervals(base: Interval[], cuts: Interval[]): Interval[] {
  if (!base.length || !cuts.length) return base;
  let current = base.slice();
  for (const [c0, c1] of cuts) {
    if (c1 - c0 <= EPS) continue;
    const next: Interval[] = [];
    for (const [b0, b1] of current) {
      if (c1 <= b0 + EPS || c0 >= b1 - EPS) {
        next.push([b0, b1]);
      } else {
        if (c0 > b0 + 0.05) next.push([b0, c0]);
        if (b1 > c1 + 0.05) next.push([c1, b1]);
      }
    }
    current = next;
  }
  return current;
}

/** Schneidet zwei Intervalllisten (Schnittmenge). */
function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (hi - lo > 0.05) out.push([lo, hi]);
    }
  }
  return out;
}

/** Dachträger (Hauptbinder) und Pfetten strikt auf den Polygonumriss geklippt.
 *  Nichts ragt bei L-, U- oder ausgeschnittenen Hallen in die Luft hinaus. */
export function roofTrussesAndPurlins(outline: Pt2[]): {
  trusses: Seg2[];
  purlins: Seg2[];
  alongX: boolean;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
} {
  if (outline.length < 3) {
    return { trusses: [], purlins: [], alongX: true, bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 } };
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of outline) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const alongX = spanX >= spanZ;
  const majorSpan = alongX ? spanX : spanZ;
  const count = Math.min(7, Math.max(1, Math.floor(majorSpan / 8)));

  const trusses: Seg2[] = [];
  for (let k = 1; k <= count; k++) {
    const u = k / (count + 1);
    if (alongX) {
      const x = minX + spanX * u;
      for (const [z0, z1] of clipAxisLineToPolygon(outline, "x", x)) {
        if (z1 - z0 >= 0.4) trusses.push({ a: [x, z0], b: [x, z1] });
      }
    } else {
      const z = minZ + spanZ * u;
      for (const [x0, x1] of clipAxisLineToPolygon(outline, "z", z)) {
        if (x1 - x0 >= 0.4) trusses.push({ a: [x0, z], b: [x1, z] });
      }
    }
  }

  const purlins: Seg2[] = [];
  for (const u of [0.33, 0.67]) {
    if (alongX) {
      const z = minZ + spanZ * u;
      for (const [x0, x1] of clipAxisLineToPolygon(outline, "z", z)) {
        if (x1 - x0 >= 0.4) purlins.push({ a: [x0, z], b: [x1, z] });
      }
    } else {
      const x = minX + spanX * u;
      for (const [z0, z1] of clipAxisLineToPolygon(outline, "x", x)) {
        if (z1 - z0 >= 0.4) purlins.push({ a: [x, z0], b: [x, z1] });
      }
    }
  }

  return { trusses, purlins, alongX, bounds: { minX, maxX, minZ, maxZ } };
}

/** Lichtbänder auf dem Dach: strikt innerhalb des eigenen Umrisses (inkl. Streifenbreite)
 *  und ausgespart überall dort, wo ein darüberliegendes Geschoss das Dach überdeckt. */
export function roofSkylightStrips(
  outline: Pt2[],
  aboveOutlines: Pt2[][] = [],
): SkylightStrip[] {
  if (outline.length < 3) return [];
  const { alongX, bounds } = roofTrussesAndPurlins(outline);
  const { minX, maxX, minZ, maxZ } = bounds;
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const stripWidth = Math.max(0.6, Math.min(2.2, (alongX ? spanZ : spanX) * 0.09));
  const halfW = stripWidth / 2;
  const margin = 0.6;
  const strips: SkylightStrip[] = [];

  for (const u of [0.25, 0.5, 0.75]) {
    const coord = alongX ? minZ + spanZ * u : minX + spanX * u;
    const axis: "x" | "z" = alongX ? "z" : "x";
    // Beide Kanten des Lichtbands müssen im Polygon liegen (nicht über Ecken hinausragen).
    let segs = intersectIntervals(
      clipAxisLineToPolygon(outline, axis, coord - halfW),
      clipAxisLineToPolygon(outline, axis, coord + halfW),
    );
    // Von jedem darüberliegenden Geschoss überdeckte Abschnitte abziehen.
    for (const above of aboveOutlines) {
      if (above.length < 3) continue;
      const cuts = [
        ...clipAxisLineToPolygon(above, axis, coord),
        ...clipAxisLineToPolygon(above, axis, coord - halfW),
        ...clipAxisLineToPolygon(above, axis, coord + halfW),
      ];
      segs = subtractIntervals(segs, cuts);
    }
    for (const [s0, s1] of segs) {
      const lo = s0 + margin;
      const hi = s1 - margin;
      if (hi - lo < 1.0) continue;
      if (alongX) {
        strips.push({ cx: (lo + hi) / 2, cz: coord, wx: hi - lo, wz: stripWidth });
      } else {
        strips.push({ cx: coord, cz: (lo + hi) / 2, wx: stripWidth, wz: hi - lo });
      }
    }
  }
  return strips;
}

/** Prüft, ob ein Punkt im Polygon oder sehr nah an dessen Rand liegt (<= tol m). */
export function pointInOrNearPolygon(pt: Pt2, poly: Pt2[], tol = 0.35): boolean {
  if (poly.length < 3) return false;
  if (pointInPolygon(pt, poly)) return true;
  const tol2 = tol * tol;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > EPS ? Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / len2)) : 0;
    const px = ax + dx * t - pt[0];
    const py = ay + dy * t - pt[1];
    if (px * px + py * py <= tol2) return true;
  }
  return false;
}

/** Prüft, ob ``inner`` vollständig innerhalb von ``outer`` liegt (für Dachaussparungen,
 *  wenn ein schmaleres Obergeschoss komplett auf einem größeren Untergeschoss steht). */
export function polygonStrictlyInside(inner: Pt2[], outer: Pt2[]): boolean {
  if (inner.length < 3 || outer.length < 3) return false;
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % inner.length];
    if (!pointInPolygon(a, outer)) return false;
    // Auch Kantenmitte prüfen, damit keine konkave Ecke geschnitten wird.
    if (!pointInPolygon([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], outer)) return false;
  }
  return true;
}

/** Senkrechte Verbindungslinien für ein Geschoss im Stapel:
 *  - Liegt unter einer Ecke ein anderes Geschoss, verbindet die Linie nur die
 *    Deckenfuge (von Oberkante des direkt darunterliegenden Geschosses bis zur
 *    Unterkante dieses Geschosses) — kein Durchstoßen von Zwischengeschossen.
 *  - Kragt eine Ecke frei aus (nicht deckungsgleich gestapelt), führt eine
 *    Lot-Linie (``overhang: true``) als Höhenreferenz hinunter auf y = 0. */
export function levelConnectorShafts(
  level: LevelOutlineSpan,
  allLevels: LevelOutlineSpan[],
): ConnectorShaft[] {
  if (level.outline.length < 3 || Math.abs(level.offset) < EPS) return [];
  const shafts: ConnectorShaft[] = [];

  if (level.offset > 0) {
    const lowers = allLevels
      .filter((other) => other.id !== level.id && other.offset < level.offset - EPS && other.outline.length >= 3)
      .sort((a, b) => b.offset - a.offset);
    for (const [x, z] of level.outline) {
      const support = lowers.find((l) => pointInOrNearPolygon([x, z], l.outline));
      if (support) {
        const topOfSupport = Math.min(level.offset, support.offset + support.height);
        if (level.offset - topOfSupport > 0.05) {
          shafts.push({ x, z, y0: topOfSupport, y1: level.offset, overhang: false });
        }
      } else {
        shafts.push({ x, z, y0: 0, y1: level.offset, overhang: true });
      }
    }
  } else {
    // Untergeschoss (offset < 0): nach oben zum nächsten Geschoss (oder y = 0).
    const uppers = allLevels
      .filter((other) => other.id !== level.id && other.offset > level.offset + EPS && other.outline.length >= 3)
      .sort((a, b) => a.offset - b.offset);
    const myTop = level.offset + level.height;
    for (const [x, z] of level.outline) {
      const above = uppers.find((u) => pointInOrNearPolygon([x, z], u.outline));
      if (above) {
        if (above.offset - myTop > 0.05) {
          shafts.push({ x, z, y0: myTop, y1: above.offset, overhang: false });
        }
      } else if (myTop < -0.05) {
        shafts.push({ x, z, y0: myTop, y1: 0, overhang: true });
      }
    }
  }
  return shafts;
}

/** Magnet-Fangpunkt an Ecken (und optional Kanten) von Nachbarebenen beim Zeichnen
 *  im 2D-Editor — erleichtert versetzte oder teilüberlappende Geschosse enorm. */
export function snapToReferenceLevels(
  raw: Pt2,
  references: { outline: Pt2[] }[],
  vertexTolM: number,
  edgeTolM = vertexTolM * 0.65,
): { point: Pt2; kind: "vertex" | "edge" } | null {
  let bestVertex: { point: Pt2; dist: number } | null = null;
  for (const ref of references) {
    for (const pt of ref.outline) {
      const d = Math.hypot(raw[0] - pt[0], raw[1] - pt[1]);
      if (d <= vertexTolM && (!bestVertex || d < bestVertex.dist)) {
        bestVertex = { point: [pt[0], pt[1]], dist: d };
      }
    }
  }
  if (bestVertex) return { point: bestVertex.point, kind: "vertex" };

  let bestEdge: { point: Pt2; dist: number } | null = null;
  for (const ref of references) {
    const poly = ref.outline;
    if (poly.length < 2) continue;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 < EPS) continue;
      const t = Math.max(0, Math.min(1, ((raw[0] - ax) * dx + (raw[1] - ay) * dy) / len2));
      const px = ax + dx * t;
      const py = ay + dy * t;
      const d = Math.hypot(raw[0] - px, raw[1] - py);
      if (d <= edgeTolM && (!bestEdge || d < bestEdge.dist)) {
        bestEdge = { point: [Math.round(px * 100) / 100, Math.round(py * 100) / 100], dist: d };
      }
    }
  }
  if (bestEdge) return { point: bestEdge.point, kind: "edge" };
  return null;
}
