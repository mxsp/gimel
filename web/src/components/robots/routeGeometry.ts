/* Rechnungen des Wege-Editors — rein, ohne DOM, damit sie in node prüfbar sind.

   Koordinaten wie im Grundriss: Meter, x nach Osten, y nach Süden. Geprüft
   wird hier, was der Editor sofort zeigen soll (Umriss, Hindernisse,
   Stationen); der Server prüft Umriss und Hindernisse noch einmal
   (/api/factory/robot-ways/check) — beide Antworten stehen im Editor. */

export type Pt = [number, number];

export interface Body {
  name: string;
  points: Pt[];
}

export interface Issue {
  /** Abschnitt i = Punkt i → i+1 (bei Rundkurs auch letzter → erster). */
  segment?: number;
  point?: number;
  level: "error" | "warning";
  text: string;
}

const EPS = 1e-9;

export const round2 = (v: number) => Math.round(v * 100) / 100;
export const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Abschnitte eines Wegs als Punktpaare; ein Rundkurs schließt zum Anfang. */
export function segmentsOf(route: Pt[], loop: boolean): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (let i = 0; i + 1 < route.length; i++) out.push([route[i], route[i + 1]]);
  if (loop && route.length >= 3) out.push([route[route.length - 1], route[0]]);
  return out;
}

export function pathLength(route: Pt[], loop: boolean): number {
  return segmentsOf(route, loop).reduce((s, [a, b]) => s + dist(a, b), 0);
}

/** Strecke eines Umlaufs: Rundkurs einmal herum, Pendel hin und zurück. */
export function cycleLength(route: Pt[], loop: boolean): number {
  return loop ? pathLength(route, true) : 2 * pathLength(route, false);
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi + EPS) + xi) inside = !inside;
  }
  return inside;
}

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Echte Kreuzung zweier Strecken (Berühren an Enden zählt nicht). */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** Führt die Strecke durch das Innere des Polygons? */
export function segmentHitsPolygon(a: Pt, b: Pt, poly: Pt[]): boolean {
  if (poly.length < 3) return false;
  for (let i = 0; i < poly.length; i++) {
    if (segmentsCross(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  // Ganz innen: Mittelpunkt prüfen (Endpunkte dürfen am Rand liegen).
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return pointInPolygon(mid, poly);
}

/** Leitet die Strecke aus dem Umriss hinaus? */
export function segmentLeavesOutline(a: Pt, b: Pt, outline: Pt[]): boolean {
  if (outline.length < 3) return false;
  for (let i = 0; i < outline.length; i++) {
    if (segmentsCross(a, b, outline[i], outline[(i + 1) % outline.length])) return true;
  }
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return !pointInPolygon(mid, outline);
}

/** Gedrehtes Rechteck einer Station (Mitte x/y, Breite w, Tiefe h, Drehung in Grad). */
export function stationPolygon(s: { x: number; y: number; w: number; h: number; rotation?: number }, shrink = 0): Pt[] {
  const a = ((s.rotation || 0) * Math.PI) / 180, c = Math.cos(a), si = Math.sin(a);
  const hw = Math.max(0, s.w / 2 - shrink), hh = Math.max(0, s.h / 2 - shrink);
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Pt[]).map(([x, y]) => [s.x + x * c - y * si, s.y + x * si + y * c]);
}

export interface IssueInput {
  outline: Pt[];
  obstacles: Body[];
  stations: Body[];
}

/** Was am Weg nicht stimmt — sofort, für jede Änderung. */
export function routeIssues(route: Pt[], loop: boolean, env: IssueInput): Issue[] {
  const issues: Issue[] = [];
  if (route.length === 1) issues.push({ point: 0, level: "error", text: "Ein Weg braucht mindestens zwei Punkte." });
  if (loop && route.length === 2) issues.push({ level: "warning", text: "Ein Rundkurs aus zwei Punkten ist ein Pendel — dritten Punkt setzen." });
  const outline = env.outline.length >= 3 ? env.outline : [];
  route.forEach((p, i) => {
    if (outline.length && !pointInPolygon(p, outline)) issues.push({ point: i, level: "error", text: `Punkt ${i + 1} liegt außerhalb der Halle.` });
    for (const o of env.obstacles) {
      if (o.points.length >= 3 && pointInPolygon(p, o.points)) issues.push({ point: i, level: "error", text: `Punkt ${i + 1} liegt in ${o.name || "einem Hindernis"}.` });
    }
    for (const s of env.stations) {
      if (pointInPolygon(p, s.points)) issues.push({ point: i, level: "warning", text: `Punkt ${i + 1} liegt in der Station ${s.name}.` });
    }
    if (i > 0 && dist(route[i - 1], p) < 0.05) issues.push({ point: i, level: "warning", text: `Punkt ${i + 1} liegt auf Punkt ${i}.` });
  });
  segmentsOf(route, loop).forEach(([a, b], i) => {
    const label = `Abschnitt ${i + 1}`;
    if (outline.length && segmentLeavesOutline(a, b, outline)) issues.push({ segment: i, level: "error", text: `${label} verlässt die Halle.` });
    for (const o of env.obstacles) {
      if (segmentHitsPolygon(a, b, o.points)) { issues.push({ segment: i, level: "error", text: `${label} kreuzt ${o.name || "ein Hindernis"}.` }); break; }
    }
    for (const s of env.stations) {
      if (segmentHitsPolygon(a, b, s.points)) { issues.push({ segment: i, level: "warning", text: `${label} fährt durch ${s.name}.` }); break; }
    }
  });
  return issues;
}

export interface SnapTargets {
  nodes: Pt[];
  /** Rasterweite in Metern; 0 = kein Raster. */
  grid: number;
  /** Fangradius für Knoten in Metern. */
  radius: number;
  /** Weitere Fangpunkte (z. B. der Startpunkt, um einen Rundkurs zu schließen). */
  extra?: Pt[];
}

export function snapPoint(p: Pt, t: SnapTargets): { p: Pt; kind: "node" | "point" | "grid" | "free" } {
  let best: Pt | null = null, bestD = t.radius, kind: "node" | "point" = "node";
  for (const n of t.nodes) { const d = dist(n, p); if (d <= bestD) { best = n; bestD = d; kind = "node"; } }
  for (const n of t.extra ?? []) { const d = dist(n, p); if (d <= bestD) { best = n; bestD = d; kind = "point"; } }
  if (best) return { p: [round2(best[0]), round2(best[1])], kind };
  if (t.grid > 0) return { p: [round2(Math.round(p[0] / t.grid) * t.grid), round2(Math.round(p[1] / t.grid) * t.grid)], kind: "grid" };
  return { p: [round2(p[0]), round2(p[1])], kind: "free" };
}

/** Nächster Abschnitt zu einem Punkt: Index, Lage auf dem Abschnitt (0…1) und Abstand. */
export function nearestSegment(route: Pt[], p: Pt, loop: boolean): { index: number; t: number; d: number } | null {
  let best: { index: number; t: number; d: number } | null = null;
  segmentsOf(route, loop).forEach(([a, b], i) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 < EPS ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    const d = dist(p, [a[0] + dx * t, a[1] + dy * t]);
    if (!best || d < best.d) best = { index: i, t, d };
  });
  return best;
}

/** Punkt nach Abschnitt `segment` einfügen (bei Rundkurs-Schluss ans Ende). */
export function insertAfter(route: Pt[], segment: number, p: Pt): Pt[] {
  const out = [...route];
  out.splice(Math.min(segment + 1, route.length), 0, p);
  return out;
}

/** Doppelte und gerade durchlaufene Zwischenpunkte entfernen (Toleranz in Metern). */
export function simplify(route: Pt[], tol = 0.05): Pt[] {
  if (route.length < 3) return route.filter((p, i) => i === 0 || dist(route[i - 1], p) > tol);
  const dedup = route.filter((p, i) => i === 0 || dist(route[i - 1], p) > tol);
  const out: Pt[] = [dedup[0]];
  for (let i = 1; i < dedup.length - 1; i++) {
    const a = out[out.length - 1], b = dedup[i], c = dedup[i + 1];
    const L = dist(a, c);
    const off = L < EPS ? 0 : Math.abs(cross(a, c, b)) / L;
    const between = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) >= 0;
    if (off > tol || !between) out.push(b);
  }
  out.push(dedup[dedup.length - 1]);
  return out;
}

/** Rundkurs an einem anderen Punkt beginnen lassen. */
export function startAt(route: Pt[], index: number): Pt[] {
  return [...route.slice(index), ...route.slice(0, index)];
}

/** Text „x, y" je Zeile (oder durch ; getrennt) → Punkte. */
export function parseRouteText(text: string): { route: Pt[]; error: string } {
  const route: Pt[] = [];
  const parts = text.split(/[\n;]+/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const nums = part.replace(/[()[\]]/g, " ").split(/[\s,]+/).filter(Boolean).map((v) => Number(v.replace(/(\d),(\d)/, "$1.$2")));
    if (nums.length < 2 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1])) {
      return { route: [], error: `„${part}“ ist kein Punkt. Bitte „x, y“ je Zeile schreiben.` };
    }
    route.push([nums[0], nums[1]]);
  }
  if (route.length === 1) return { route, error: "Ein Weg braucht mindestens zwei Punkte." };
  return { route, error: "" };
}

export const routeText = (route: Pt[]) => route.map(([x, y]) => `${round2(x)}, ${round2(y)}`).join("\n");
