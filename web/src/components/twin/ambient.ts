import type { CollisionWorld } from "./collision";

/* Belebung (dargestellt) — task 37.

   Rein: kein THREE, kein DOM. Rechnet aus, wo in der Halle Figuren, ein
   Stapler und wandernde Teile stehen und laufen. Nichts davon ist gemessen:
   Gimel hat keine Ortung von Menschen oder Staplern. Die Schicht zeigt, wie
   ein Betrieb mit den gebuchten Zuständen aussieht, und heißt in der
   Oberfläche immer „dargestellt". Sie geht nie in Kennzahlen,
   Kollisionsberichte oder Entscheidungen ein.

   Koordinaten wie der Grundriss: x nach Osten, y nach Süden (3D: z = y).
   Winkel `heading` ist die Drehung um die Hochachse in der 3D-Szene. */

type Pt = [number, number];

export interface AmbientStation {
  id: number;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  running: boolean;
}

export interface Spot {
  stationId: number;
  x: number;
  y: number;
  /** Drehung um y (rad) für eine Figur, die nach −z schaut. */
  heading: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Ein Punkt im Stationskoordinatensystem (lx entlang w, lz entlang h) im Grundriss. */
function local(s: AmbientStation, lx: number, lz: number): Pt {
  // Das Gerät dreht in 3D um −rotation; lokal +z liegt dann bei (sin θ, cos θ).
  const t = -rad(s.rotation);
  return [s.x + lx * Math.cos(t) + lz * Math.sin(t), s.y - lx * Math.sin(t) + lz * Math.cos(t)];
}

/**
 * Bedienplätze: eine Figur je laufender Station, vorn (+z) vor dem Gerät, sonst
 * hinten, rechts oder links — der erste Platz, der frei von Stationen,
 * Hindernissen und Wänden ist. Kein freier Platz: keine Figur.
 */
export function operatorSpots(stations: AmbientStation[], world: CollisionWorld, gap = 0.5): Spot[] {
  const out: Spot[] = [];
  for (const s of stations) {
    if (!s.running) continue;
    const t = -rad(s.rotation);
    const tries: [number, number, number][] = [
      [0, s.h / 2 + gap, t],
      [0, -(s.h / 2 + gap), t + Math.PI],
      [s.w / 2 + gap, 0, t + Math.PI / 2],
      [-(s.w / 2 + gap), 0, t - Math.PI / 2],
    ];
    for (const [lx, lz, heading] of tries) {
      const [x, y] = local(s, lx * 0.98, lz);
      const hit = world.query({ kind: "circle", x, y, r: 0.3 }, { groups: ["station", "obstacle", "wall"] });
      if (hit.length) continue;
      out.push({ stationId: s.id, x, y, heading });
      break;
    }
  }
  return out;
}

export function polylineLength(points: Pt[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return n;
}

export interface PathPoint { x: number; y: number; heading: number }

/** Punkt und Fahrtrichtung bei Strecke `d` (m) entlang des Linienzugs (geklemmt). */
export function along(points: Pt[], d: number): PathPoint {
  if (points.length === 0) return { x: 0, y: 0, heading: 0 };
  if (points.length === 1) return { x: points[0][0], y: points[0][1], heading: 0 };
  let rest = Math.max(0, d);
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    const len = Math.hypot(bx - ax, by - ay);
    if (rest <= len || i === points.length - 1) {
      const u = len > 0 ? Math.min(1, rest / len) : 0;
      // Fahrzeug und Kiste schauen in Fahrtrichtung; 3D-Winkel um y aus (dx, dz).
      return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, heading: Math.atan2(-(by - ay), bx - ax) };
    }
    rest -= len;
  }
  const last = points[points.length - 1];
  return { x: last[0], y: last[1], heading: 0 };
}

/** Wie viele Teile auf einem Materialweg wandern: 1…4 nach Anteil am größten Fluss. */
export function parcelCount(count: number, maxCount: number): number {
  if (!(count > 0)) return 0;
  return Math.max(1, Math.min(4, Math.round(1 + 3 * (count / Math.max(1, maxCount)))));
}

/** Lage eines Teils `index` von `n` zur Zeit `t` (s): gleichmäßig verteilt, gleiche Geschwindigkeit,
 *  am Ende beginnt es von vorn. */
export function parcelAt(points: Pt[], t: number, index: number, n: number, speed = 0.9): PathPoint {
  const len = polylineLength(points);
  if (len <= 0.01) return along(points, 0);
  const d = ((t * speed) + (index / Math.max(1, n)) * len) % len;
  return along(points, d);
}

export interface ShuttlePose extends PathPoint {
  /** Auf dem Hinweg (Quelle → Ziel) trägt der Stapler eine Palette. */
  loaded: boolean;
}

/**
 * Stapler im Pendelverkehr auf einem Weg, mit Abstand `trim` zu beiden Enden
 * (er fährt nicht in eine Maschine), kurzer Pause an jedem Ende.
 */
export function shuttle(points: Pt[], t: number, speed = 1.1, trim = 1.6, pause = 4): ShuttlePose {
  const len = polylineLength(points);
  const run = Math.max(0, len - 2 * trim);
  if (run < 0.5) {
    const p = along(points, len / 2);
    return { ...p, loaded: false };
  }
  const leg = run / speed;
  const cycle = 2 * (leg + pause);
  const u = ((t % cycle) + cycle) % cycle;
  let d: number, back: boolean;
  if (u < leg) { d = trim + u * speed; back = false; }
  else if (u < leg + pause) { d = trim + run; back = false; }
  else if (u < 2 * leg + pause) { d = trim + run - (u - leg - pause) * speed; back = true; }
  else { d = trim; back = true; }
  const p = along(points, d);
  // Rückwärts heißt: die Gabel zeigt wieder zur Quelle.
  return { ...p, heading: back ? p.heading + Math.PI : p.heading, loaded: !back && u < leg + pause };
}

/** Feuerlöscher an jeder zweiten Stütze, außen an der Seite zur Hallenmitte. */
export function extinguisherSpots(columns: Pt[][], centre: Pt): Spot[] {
  const out: Spot[] = [];
  columns.forEach((poly, i) => {
    if (i % 2 || poly.length < 3) return;
    const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
    const cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
    const half = Math.max(...poly.map((p) => Math.abs(p[0] - cx)));
    const dx = centre[0] - cx, dy = centre[1] - cy;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const sx = horizontal ? Math.sign(dx) || 1 : 0, sy = horizontal ? 0 : Math.sign(dy) || 1;
    out.push({ stationId: -1, x: cx + sx * (half + 0.12), y: cy + sy * (half + 0.12), heading: Math.atan2(sx, sy) });  // Schild und Löscher schauen von der Stütze weg (+z des Modells)
  });
  return out;
}
