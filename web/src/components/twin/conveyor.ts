import type { Conveyor } from "../../factory";

/* Förderbänder: dieselbe Regel wie `gimel/core/conveyor.py` (rein, ohne THREE).

   `points` ist die Mittellinie in Förderrichtung, je Punkt optional die
   Bandhöhe z (m). Was unter der Durchfahrtshöhe liegt, ist ein Körper; eine
   Brücke darüber ist frei, nur ihre Stützen an den Eckpunkten stehen im Weg. */

export const DEFAULT_Z_M = 0.9;
export const CLEAR_UNDER_M = 2.3;
export const DEPTH_M = 0.25;
export const POST_M = 0.35;

export type P3 = [number, number, number];
type Pt = [number, number];

export function points3(c: Pick<Conveyor, "points">): P3[] {
  const out: P3[] = [];
  for (const p of (c.points ?? []).slice(0, 32)) {
    const x = Number(p[0]), y = Number(p[1]);
    const z = p.length > 2 && p[2] != null ? Number(p[2]) : DEFAULT_Z_M;
    if ([x, y, z].every(Number.isFinite)) out.push([x, y, Math.max(0.1, Math.min(8, z))]);
  }
  return out;
}

export function widthOf(c: Pick<Conveyor, "width">): number {
  const w = Number(c.width);
  return Number.isFinite(w) ? Math.max(0.3, Math.min(2, w)) : 0.8;
}

function rect(a: Pt, b: Pt, half: number): Pt[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * half, ny = (dx / L) * half;
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
}

/** Was am Boden im Weg steht: niedrige Abschnitte und Stützen unter hohen Eckpunkten. */
export function footprint(points: P3[], width: number): Pt[][] {
  const half = width / 2;
  const out: Pt[][] = [];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay, az] = points[i - 1], [bx, by, bz] = points[i];
    if (Math.hypot(bx - ax, by - ay) < 1e-6) continue;
    const loA = az - DEPTH_M, loB = bz - DEPTH_M;
    if (loA >= CLEAR_UNDER_M && loB >= CLEAR_UNDER_M) continue;
    let u0 = 0, u1 = 1;
    if (!(loA < CLEAR_UNDER_M && loB < CLEAR_UNDER_M)) {
      const u = (CLEAR_UNDER_M - loA) / (loB - loA);
      if (loA < CLEAR_UNDER_M) u1 = u; else u0 = u;
    }
    const a: Pt = [ax + (bx - ax) * u0, ay + (by - ay) * u0];
    const b: Pt = [ax + (bx - ax) * u1, ay + (by - ay) * u1];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-3) out.push(rect(a, b, half));
  }
  const s = POST_M / 2;
  for (const [x, y, z] of points) {
    if (z - DEPTH_M >= CLEAR_UNDER_M) out.push([[x - s, y - s], [x + s, y - s], [x + s, y + s], [x - s, y + s]]);
  }
  return out;
}

export function length3(points: P3[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay, az] = points[i - 1], [bx, by, bz] = points[i];
    n += Math.hypot(bx - ax, by - ay, bz - az);
  }
  return n;
}

/** Punkt bei Strecke d entlang des Bandes (mit Höhe) und Richtung um die Hochachse. */
export function along3(points: P3[], d: number): { x: number; y: number; z: number; heading: number; pitch: number } {
  if (points.length < 2) {
    const p = points[0] ?? [0, 0, DEFAULT_Z_M];
    return { x: p[0], y: p[1], z: p[2], heading: 0, pitch: 0 };
  }
  let rest = Math.max(0, d);
  for (let i = 1; i < points.length; i++) {
    const [ax, ay, az] = points[i - 1], [bx, by, bz] = points[i];
    const flat = Math.hypot(bx - ax, by - ay);
    const len = Math.hypot(flat, bz - az);
    if (rest <= len || i === points.length - 1) {
      const u = len > 0 ? Math.min(1, rest / len) : 0;
      return {
        x: ax + (bx - ax) * u, y: ay + (by - ay) * u, z: az + (bz - az) * u,
        heading: Math.atan2(-(by - ay), bx - ax), pitch: Math.atan2(bz - az, flat),
      };
    }
    rest -= len;
  }
  const p = points[points.length - 1];
  return { x: p[0], y: p[1], z: p[2], heading: 0, pitch: 0 };
}
