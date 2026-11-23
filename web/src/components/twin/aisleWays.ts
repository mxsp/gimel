import type { Floor } from "../../factory";

/* Gänge und Handwege als Fahrspuren.

   Das Gangnetz ist bisher nur eine dünne gestrichelte Linie. Für den digitalen
   Zwilling ist ein Weg aber eine Fläche: breit genug für ein AGV, mit Kanten,
   Richtung und Anschlüssen. Diese Datei rechnet die Geometrie einmal — 2D,
   Semi-3D und echte 3D zeichnen daraus dieselben Spuren. Wo entschieden wird
   (Wegstrecke, Anschluss), bleibt factory.ts::routePoints zuständig; hier geht
   es nur ums Bild. */

export type Pt = [number, number];

/** Breite einer Fahrspur in Metern. Ein schmaler Gang bleibt lesbar, ein breiter
 *  wird nicht künstlich aufgebläht: die Spur ist Darstellung, kein Maß. */
export const AISLE_LANE_M = 2.2;

/** Abstand der Richtungspfeile auf einer Spur, in Metern. */
export const WAY_ARROW_M = 11;

export interface Way {
  points: Pt[];
  /** Kante des gerechneten Netzes oder ein von Hand gezogener Anschlussweg. */
  kind: "edge" | "path";
  /** Station, von der ein Handweg ausgeht; null, wenn sie nicht feststeht. */
  station: number | null;
}

export interface WayArrow {
  at: Pt;
  /** Einheitsvektor in Wegrichtung. */
  dir: Pt;
}

function norm(v: Pt): Pt {
  const len = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / len, v[1] / len];
}

function dedupe(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-6) continue;
    out.push([p[0], p[1]]);
  }
  return out;
}

/** Höhe der Halle in Metern. Alte Datensätze haben kein height_m; 6 m ist dann
 *  die lesbare Annahme für Wände, Stützen und Dach — nie ein Messwert. */
export function hallHeight(floor: Floor): number {
  return Math.max(3.2, Math.min(12, Number(floor.height_m) || 6));
}

/** Alle sichtbaren Wege einer Ebene: Netz-Kanten und Handwege. */
export function aisleWays(floor: Floor): Way[] {
  const aisles = floor.aisles ?? { nodes: [], edges: [] };
  const nodes = aisles.nodes ?? [];
  const out: Way[] = [];
  for (const [i, j] of aisles.edges ?? []) {
    const a = nodes[i], b = nodes[j];
    if (!a || !b || Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05) continue;
    out.push({ points: [[a[0], a[1]], [b[0], b[1]]], kind: "edge", station: null });
  }
  for (const p of aisles.paths ?? []) {
    const pts = dedupe((p.points ?? []).map((q) => [q[0], q[1]] as Pt));
    if (pts.length < 2) continue;
    out.push({ points: pts, kind: "path", station: p.station ?? null });
  }
  return out;
}

/** Nur die von Hand gezogenen Anschlusswege. */
export function manualWays(floor: Floor): Way[] {
  return aisleWays(floor).filter((w) => w.kind === "path");
}

/** Länge eines Linienzugs in Metern. */
export function wayLength(points: Pt[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return sum;
}

/** Gesamtlänge des erfassten Netzes, für die Anzeige. */
export function aisleNetworkMetres(floor: Floor): number {
  return aisleWays(floor).reduce((sum, w) => sum + wayLength(w.points), 0);
}

/** Ein geschlossenes Polygon um einen offenen Linienzug: die Fahrspur.
 *  An Ecken wird die Außenseite mit einer Gehrung verlängert, damit an
 *  Abzweigen keine Lücke klafft; extrem spitze Winkel werden gekappt. */
export function lanePolygon(points: Pt[], width = AISLE_LANE_M): Pt[] {
  const pts = dedupe(points);
  if (pts.length < 2) return [];
  const half = width / 2;
  const left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const cur = pts[i];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const d0 = norm([cur[0] - prev[0], cur[1] - prev[1]]);
    const d1 = norm([next[0] - cur[0], next[1] - cur[1]]);
    // Am Anfang/Ende fehlt eine der beiden Richtungen: die andere gilt.
    const inDir = i === 0 ? d1 : d0;
    const outDir = i === pts.length - 1 ? d0 : d1;
    const n0: Pt = [-inDir[1], inDir[0]];
    const n1: Pt = [-outDir[1], outDir[0]];
    let nx = n0[0] + n1[0], ny = n0[1] + n1[1];
    const len = Math.hypot(nx, ny);
    if (len < 1e-6) { nx = n1[0]; ny = n1[1]; }
    else { nx /= len; ny /= len; }
    const dot = Math.max(0.4, nx * n1[0] + ny * n1[1]);
    const scale = half * Math.min(2, 1 / dot);
    left.push([cur[0] + nx * scale, cur[1] + ny * scale]);
    right.push([cur[0] - nx * scale, cur[1] - ny * scale]);
  }
  return [...left, ...right.reverse()];
}

/** Richtungspfeile entlang eines Linienzugs, nach je ``spacing`` Metern. */
export function wayArrows(points: Pt[], spacing = WAY_ARROW_M): WayArrow[] {
  const pts = dedupe(points);
  if (pts.length < 2) return [];
  const total = wayLength(pts);
  if (total < spacing * 0.6) return [];
  const out: WayArrow[] = [];
  let run = 0;
  let next = spacing * 0.5;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg < 1e-6) continue;
    const dir: Pt = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
    while (next <= run + seg && next < total - spacing * 0.25) {
      const u = (next - run) / seg;
      out.push({ at: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], dir });
      next += spacing;
    }
    run += seg;
  }
  return out;
}

/** SVG-Pfad für ein Polygon. */
export function polygonPath(points: Pt[], close = true): string {
  if (!points.length) return "";
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ") + (close ? " Z" : "");
}

/** SVG-Pfad für einen offenen Linienzug. */
export function linePath(points: Pt[]): string {
  return polygonPath(points, false);
}
