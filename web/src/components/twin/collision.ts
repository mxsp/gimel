import { effectiveDoorKind, obstacleKind, type Door, type Floor, type Obstacle, type Robot, type RobotJob, type Station } from "../../factory";
import { footprint, points3, widthOf } from "./conveyor";
import { stationCorners } from "../../factory";
import type { Pt } from "./aisleWays";

/* Allgemeine Kollisionslogik für den digitalen Zwilling.

   Der 3D-Raum ist in der Halle ein Grundriss in Metern: die dritte Achse
   (Höhe) trägt für die Anwesenheit von Geräten nichts bei, solange alle
   Beteiligten auf derselben Ebene stehen. Diese Datei rechnet deshalb in der
   (x, y)-Ebene des Plans — dieselben Koordinaten, die floor.outline,
   stationCorners und Robot.route verwenden. Sie ist bewusst frei von THREE
   und React: die Logik ist in Node prüfbar und kann von Plan, Semi-3D und
   echter 3D gleichermaßen benutzt werden.

   Was hier entsteht, ist eine *Anzeige*, keine Entscheidung: es wird nichts
   am Roboterstand, an der Route oder an der Weglänge geändert. Wo Gimel
   entscheidet (Routing, Zuordnung), bleiben Backend und factory.ts zuständig.

   Zwei Ebenen:
     - Formen und ihre Überschneidungen (circle / polygon / box / segment),
       mit einem AABB-Vorfilter als Broadphase.
     - Eine CollisionWorld, die aus Grundriss, Stationen und Hindernissen
       gebaut wird und beliebige Formen gegen ihre Körper abfragt. */

/** Halber Fahrzeugdurchschnitt: das 3D-Modell ist 1,35 × 0,86 m groß. */
export const ROBOT_RADIUS_M = 0.72;
/** Sicherheitsabstand, damit ein Streifen nicht schon als Berührung gilt. */
export const CLEARANCE_M = 0.12;

export type Shape =
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "polygon"; points: Pt[] }
  | { kind: "box"; cx: number; cy: number; w: number; h: number; rotation: number }
  | { kind: "segment"; a: Pt; b: Pt; r: number };

export type ColliderGroup = "station" | "obstacle" | "wall" | "zone";

export interface Collider {
  id: string;
  label: string;
  group: ColliderGroup;
  shape: Shape;
  /** Nur Orientierung, nie eine Kollision (z. B. Zonen). */
  passive?: boolean;
}

export type CollisionGroup = ColliderGroup | "robot" | "route" | "layout";

export interface Collision {
  group: CollisionGroup;
  severity: "warning" | "danger";
  /** null bei Konflikten, die nur den Grundriss betreffen. */
  robotId: number | null;
  robotName: string;
  targetId: string;
  targetLabel: string;
  at: Pt;
  detail: string;
}

export interface CollisionReport {
  collisions: Collision[];
  byRobot: Record<number, Collision[]>;
  /** Geplante Wegstücke, die durch ein Hindernis oder aus der Halle führen. */
  riskySegments: { robotId: number; segments: [Pt, Pt][] }[];
  /** Stationen, die sich mit einer anderen Station oder einem Hindernis überlappen. */
  collidingStationIds: number[];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

export function boxPolygon(cx: number, cy: number, w: number, h: number, rotation: number): Pt[] {
  const c = Math.cos(rad(rotation)), s = Math.sin(rad(rotation));
  const hw = w / 2, hh = h / 2;
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Pt[]).map(([x, y]) =>
    [cx + x * c - y * s, cy + x * s + y * c]);
}

export function shapePolygon(shape: Shape): Pt[] | null {
  if (shape.kind === "polygon") return shape.points;
  if (shape.kind === "box") return boxPolygon(shape.cx, shape.cy, shape.w, shape.h, shape.rotation);
  return null;
}

export function shapeCircle(shape: Shape): { x: number; y: number; r: number } | null {
  return shape.kind === "circle" ? shape : null;
}

function aabb(shape: Shape): [number, number, number, number] {
  const pad = shape.kind === "segment" ? shape.r : shape.kind === "circle" ? shape.r : 0;
  if (shape.kind === "segment") {
    return [Math.min(shape.a[0], shape.b[0]) - pad, Math.min(shape.a[1], shape.b[1]) - pad,
      Math.max(shape.a[0], shape.b[0]) + pad, Math.max(shape.a[1], shape.b[1]) + pad];
  }
  if (shape.kind === "circle") return [shape.x - pad, shape.y - pad, shape.x + pad, shape.y + pad];
  const poly = shapePolygon(shape)!;
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function aabbHit(a: Shape, b: Shape, clearance: number): boolean {
  const [ax, ay, ax2, ay2] = aabb(a), [bx, by, bx2, by2] = aabb(b);
  return ax - clearance <= bx2 && bx - clearance <= ax2
    && ay - clearance <= by2 && by - clearance <= ay2;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return [a[0], a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return [a[0] + dx * t, a[1] + dy * t];
}

export function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const q = closestOnSegment(p, a, b);
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

/** Kleinster Abstand zu einer Kante — auch für Punkte *innerhalb* des
    Polygons. `distanceToPolygon` ist dagegen ein Abstand zur Fläche (0 innen). */
export function distanceToEdges(p: Pt, poly: Pt[]): number {
  if (poly.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    best = Math.min(best, distanceToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return best;
}

export function distanceToPolygon(p: Pt, poly: Pt[]): number {
  if (!poly.length) return Infinity;
  if (pointInPolygon(p, poly)) return 0;
  return distanceToEdges(p, poly);
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function segmentHitsPolygon(a: Pt, b: Pt, poly: Pt[], radius = 0): boolean {
  if (poly.length < 3) return false;
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    if (segmentsCross(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  if (radius > 0) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / Math.max(0.25, radius)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (distanceToPolygon([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], poly) <= radius) return true;
    }
  }
  return false;
}

function circleHitsPolygon(c: { x: number; y: number; r: number }, poly: Pt[]): boolean {
  return distanceToPolygon([c.x, c.y], poly) <= c.r;
}

function polygonHitsPolygon(a: Pt[], b: Pt[]): boolean {
  if (a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/** Überschneiden sich zwei Formen? ``clearance`` vergrößert beide Seiten. */
export function shapesOverlap(a: Shape, b: Shape, clearance = 0): boolean {
  if (!aabbHit(a, b, clearance)) return false;
  const ca = shapeCircle(a), cb = shapeCircle(b);
  if (ca && cb) return Math.hypot(ca.x - cb.x, ca.y - cb.y) <= ca.r + cb.r + clearance;
  const pa = shapePolygon(a), pb = shapePolygon(b);
  if (ca && pb) return circleHitsPolygon({ ...ca, r: ca.r + clearance }, pb);
  if (cb && pa) return circleHitsPolygon({ ...cb, r: cb.r + clearance }, pa);
  if (pa && pb) return clearance > 0
    ? polygonHitsPolygon(pa, growPolygon(pb, clearance)) || polygonHitsPolygon(growPolygon(pa, clearance), pb)
    : polygonHitsPolygon(pa, pb);
  if (a.kind === "segment") return segmentShapeHits(a, b, clearance);
  if (b.kind === "segment") return segmentShapeHits(b, a, clearance);
  return false;
}

/** Polygon um ``d`` aufweiten — ausreichend für den Sicherheitsabstand. */
function growPolygon(poly: Pt[], d: number): Pt[] {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const len = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / len) * d, y + ((y - cy) / len) * d];
  });
}

function segmentShapeHits(seg: Extract<Shape, { kind: "segment" }>, other: Shape, clearance: number): boolean {
  const radius = seg.r + clearance;
  const c = shapeCircle(other);
  if (c) return distanceToSegment([c.x, c.y], seg.a, seg.b) <= c.r + radius;
  const poly = shapePolygon(other);
  if (poly) return segmentHitsPolygon(seg.a, seg.b, poly, radius);
  if (other.kind === "segment") return segmentsCross(seg.a, seg.b, other.a, other.b);
  return false;
}

/** Liegt ein Punkt (mit Radius) außerhalb des Hallenumrisses? */
export function outsideOutline(p: Pt, outline: Pt[], radius = 0): boolean {
  if (outline.length < 3) return false;
  return !pointInPolygon(p, outline) || distanceToEdges(p, outline) <= radius;
}

export class CollisionWorld {
  constructor(readonly colliders: Collider[]) {}

  /** Wie ``query``, aber ohne Liste: der erste Treffer genügt und die Suche
      endet sofort. Das Gehen fragt bis zu dreimal je Bild nur „frei oder
      nicht“ ab — eine Materialliste wäre dort nur Müll. */
  blocks(shape: Shape, opts: {
    groups?: ColliderGroup[];
    clearance?: number;
    exclude?: (c: Collider) => boolean;
  } = {}): boolean {
    const clearance = opts.clearance ?? 0;
    for (const c of this.colliders) {
      if (c.passive) continue;
      if (opts.groups && !opts.groups.includes(c.group)) continue;
      if (opts.exclude && opts.exclude(c)) continue;
      if (shapesOverlap(shape, c.shape, clearance)) return true;
    }
    return false;
  }

  /** Alle festen Körper, die die Form berührt. Der AABB-Vorfilter hält das
      auch bei vielen Stationen und Gängen billig. */
  query(shape: Shape, opts: {
    groups?: ColliderGroup[];
    clearance?: number;
    exclude?: (c: Collider) => boolean;
  } = {}): Collider[] {
    const clearance = opts.clearance ?? 0;
    return this.colliders.filter((c) => !c.passive
      && (!opts.groups || opts.groups.includes(c.group))
      && (!opts.exclude || !opts.exclude(c))
      && shapesOverlap(shape, c.shape, clearance));
  }
}

export interface ClearOptions {
  /** Radius des Fahrzeugs bzw. der Fahrspur um die Mittellinie. */
  radius?: number;
  clearance?: number;
  groups?: ColliderGroup[];
  /** Abstand der Stützpunkte beim Prüfen, in Metern. */
  step?: number;
  ignore?: (c: Collider) => boolean;
}

/** Einen Linienzug in kollisionsfreie Abschnitte zerlegen. Die Strecke wird
    fein abgetastet; jeder Stützpunkt, der einen Körper berührt, beendet den
    laufenden Abschnitt. So entsteht aus einem Weg, der quer durch ein Regal
    läuft, ein Weg, der an der Regalkante endet und dahinter weitergeht.
    Das ist reine Darstellung: die gespeicherte Route bleibt unangetastet. */
export function clearPolyline(points: Pt[], world: CollisionWorld, opts: ClearOptions = {}): Pt[][] {
  const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) return [];
  const step = Math.max(0.1, opts.step ?? 0.4);
  const radius = opts.radius ?? 0;
  const clearance = opts.clearance ?? 0;
  const dense: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  dense.push(pts[pts.length - 1]);
  const free = (p: Pt) => world.query(
    { kind: "circle", x: p[0], y: p[1], r: radius },
    { groups: opts.groups, clearance, exclude: opts.ignore },
  ).length === 0;
  const runs: Pt[][] = [];
  let current: Pt[] = [];
  for (const p of dense) {
    if (free(p)) current.push(p);
    else if (current.length) { if (current.length >= 2) runs.push(simplifyRun(current)); current = []; }
  }
  if (current.length >= 2) runs.push(simplifyRun(current));
  return runs.filter((r) => r.length >= 2);
}

/** Kollineare Stützpunkte streichen: die Ansicht braucht keine 200 Punkte für
    eine gerade Spur. */
function simplifyRun(run: Pt[]): Pt[] {
  if (run.length <= 2) return run;
  const out: Pt[] = [run[0]];
  for (let i = 1; i < run.length - 1; i++) {
    const a = out[out.length - 1], b = run[i], c = run[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > 1e-4) out.push(b);
  }
  out.push(run[run.length - 1]);
  return out;
}

/** Dieselbe Zerlegung für eine ganze Liste von Wegen (Gänge, Handwege,
    Materialflüsse). Die übrigen Felder jedes Weges bleiben erhalten. */
export function clearWays<T extends { points: Pt[] }>(ways: T[], world: CollisionWorld, opts: ClearOptions = {}): T[] {
  return ways.flatMap((w) => clearPolyline(w.points, world, opts).map((points) => ({ ...w, points })));
}

export interface TwinWorldOptions {
  /** Türen als Durchgang: Außenwände, Innenwände und Raumboxen werden an jeder Tür geteilt,
      damit man hindurchgehen kann. Nur das Begehen braucht das; Anzeige und Roboterprüfung
      bleiben bei der geschlossenen Wand. */
  openDoors?: boolean;
  /** Zusätzliche Türen (z. B. von einer direkt angrenzenden Nachbarhalle in lokale Koordinaten projiziert). */
  extraDoors?: (Pick<Door, "x" | "y" | "width"> & Partial<Pick<Door, "kind" | "name">>)[];
}

/** Nur begehbare Wandöffnungen schneiden den Wandsockel auf; Fenster (Brüstung 1 m),
 *  Treppen und Aufzüge lassen die Außenwand geschlossen. */
export function isPassableWallOpening(d: Pick<Door, "kind" | "name"> | { kind?: string; name?: string }): boolean {
  const k = effectiveDoorKind({ kind: d.kind ?? "door", name: d.name ?? "" });
  return k !== "window" && k !== "stair" && k !== "lift";
}

/** Wandstücke eines Umrisses (oder Innenraums / einer Innenwand), an begehbaren
    Türen/Toren geteilt. ``perpTol`` erlaubt bei dünnen Innenwänden (0,2–0,3 m)
    den Durchbruch durch beide gegenüberliegenden Wandseiten. */
export function wallPieces(
  outline: Pt[],
  doors: (Pick<Door, "x" | "y" | "width"> & Partial<Pick<Door, "kind" | "name">>)[] = [],
  perpTol = 0.38,
): { a: Pt; b: Pt }[] {
  const out: { a: Pt; b: Pt }[] = [];
  const at = (a: Pt, ux: number, uy: number, t: number): Pt => [a[0] + ux * t, a[1] + uy * t];
  const openings = doors.filter((d) => isPassableWallOpening(d));
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const cuts: [number, number][] = [];
    for (const d of openings) {
      const dx = d.x - a[0], dy = d.y - a[1];
      // Nur Türen direkt auf dieser Wand (Abstand <= perpTol und Mitte innerhalb des Segments).
      if (Math.abs(dx * uy - dy * ux) > perpTol) continue;
      const along = dx * ux + dy * uy;
      if (along < -0.05 || along > len + 0.05) continue;
      const half = Math.max(0.25, (Number(d.width) || 1.2) / 2);
      const lo = Math.max(0, along - half), hi = Math.min(len, along + half);
      if (hi > lo + 1e-3) cuts.push([lo, hi]);
    }
    if (!cuts.length) { out.push({ a, b }); continue; }
    cuts.sort((p, q) => p[0] - q[0]);
    let cursor = 0;
    for (const [lo, hi] of cuts) {
      if (lo > cursor + 1e-3) out.push({ a: at(a, ux, uy, cursor), b: at(a, ux, uy, lo) });
      cursor = Math.max(cursor, hi);
    }
    if (cursor < len - 1e-3) out.push({ a: at(a, ux, uy, cursor), b });
  }
  return out;
}

/** Prüft, ob ein Hindernis (Innenwand, Trennwand oder Raumbox) eine Tür trägt. */
export function obstacleHasDoor(
  o: Pick<Obstacle, "points" | "kind" | "name">,
  doors: (Pick<Door, "x" | "y" | "width"> & Partial<Pick<Door, "kind" | "name">>)[] = [],
): boolean {
  if (!o.points || o.points.length < 3 || !doors.length) return false;
  const k = obstacleKind(o);
  if (k !== "wall" && k !== "partition" && k !== "room") return false;
  const openings = doors.filter((d) => isPassableWallOpening(d));
  if (!openings.length) return false;
  const tol = k === "room" ? 0.42 : 0.5;
  for (let i = 0; i < o.points.length; i++) {
    const a = o.points[i], b = o.points[(i + 1) % o.points.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.4) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    for (const d of openings) {
      const dx = d.x - a[0], dy = d.y - a[1];
      if (Math.abs(dx * uy - dy * ux) > tol) continue;
      const along = dx * ux + dy * uy;
      if (along >= -0.05 && along <= len + 0.05) return true;
    }
  }
  return false;
}

/** Wandstücke einer Raumbox oder Innenwand mit Türöffnungen. */
export function obstacleWallPieces(
  o: Pick<Obstacle, "points" | "kind" | "name">,
  doors: (Pick<Door, "x" | "y" | "width"> & Partial<Pick<Door, "kind" | "name">>)[] = [],
): { a: Pt; b: Pt }[] {
  const k = obstacleKind(o);
  const tol = k === "room" ? 0.42 : 0.5;
  return wallPieces(o.points ?? [], doors, tol);
}

/** Die festen Körper einer Ebene. Wände sind Wandstücke mit kleiner Dicke;
    Zonen sind passiv, damit sie nie als Hindernis gelten. */
export function buildTwinWorld(floor: Floor, stations: Station[], opts: TwinWorldOptions = {}): CollisionWorld {
  const colliders: Collider[] = [];
  const allDoors = [...(floor.doors ?? []), ...(opts.extraDoors ?? [])];
  for (const s of stations) {
    if (s.id == null) continue;
    colliders.push({
      id: `station:${s.id}`, label: s.label || `Station ${s.id}`, group: "station",
      shape: { kind: "polygon", points: stationCorners(s) },
    });
  }
  (floor.obstacles ?? []).forEach((o, i) => {
    if (!(o.points?.length >= 3)) return;
    if (opts.openDoors && obstacleHasDoor(o, allDoors)) {
      const pieces = obstacleWallPieces(o, allDoors);
      pieces.forEach(({ a, b }, k) => {
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return;
        colliders.push({
          id: `obstacle:${i}:wall:${k}`,
          label: o.name || `Hindernis ${i + 1}`,
          group: "obstacle",
          shape: { kind: "segment", a, b, r: 0.08 },
        });
      });
      return;
    }
    colliders.push({
      id: `obstacle:${i}`, label: o.name || `Hindernis ${i + 1}`, group: "obstacle",
      shape: { kind: "polygon", points: o.points },
    });
  });
  // Förderbänder: niedrige Abschnitte und Stützen, nicht die Brücke darüber.
  (floor.conveyors ?? []).forEach((c, i) => {
    footprint(points3(c), widthOf(c)).forEach((poly, k) => colliders.push({
      id: `conveyor:${i}:${k}`, label: c.name || "Förderband", group: "obstacle",
      shape: { kind: "polygon", points: poly },
    }));
  });
  const outline = floor.outline ?? [];
  const walls = opts.openDoors ? wallPieces(outline, allDoors) : wallPieces(outline);
  walls.forEach(({ a, b }, i) => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return;
    colliders.push({
      id: `wall:${i}`, label: "Hallenwand", group: "wall",
      shape: { kind: "segment", a, b, r: 0.08 },
    });
  });
  (floor.zones ?? []).forEach((z, i) => {
    if (z.points?.length >= 3) colliders.push({
      id: `zone:${i}`, label: z.name || `Zone ${i + 1}`, group: "zone",
      shape: { kind: "polygon", points: z.points }, passive: true,
    });
  });
  return new CollisionWorld(colliders);
}

/** Allgemeine Grundrisskonflikte: Station gegen Station und gegen Hindernis. */
export function layoutCollisions(world: CollisionWorld, stations: Station[]): {
  collisions: Collision[]; collidingStationIds: number[];
} {
  const collisions: Collision[] = [];
  const ids = new Set<number>();
  const seen = new Set<string>();
  for (const s of stations) {
    if (s.id == null) continue;
    const shape: Shape = { kind: "polygon", points: stationCorners(s) };
    for (const hit of world.query(shape, {
      groups: ["station", "obstacle"], exclude: (c) => c.id === `station:${s.id}`,
    })) {
      const key = [s.id, hit.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      ids.add(s.id);
      if (hit.group === "station") ids.add(Number(hit.id.split(":")[1]));
      collisions.push({
        group: "layout", severity: "warning", robotId: null, robotName: "",
        targetId: hit.id, targetLabel: hit.label, at: [s.x, s.y],
        detail: `${s.label} überlappt ${hit.label}`,
      });
    }
  }
  return { collisions, collidingStationIds: [...ids] };
}

export interface RobotPose { x: number; y: number; heading_deg?: number | null }

/** Alles, was auf dieser Ebene gerade zusammenstößt oder zusammenzustoßen
    droht. ``poseOf`` kommt vom Aufrufer (Serverstand oder Extrapolation),
    damit diese Datei keine Uhr und keinen Roboterzustand erfindet. */
export function robotCollisionReport(args: {
  world: CollisionWorld;
  floor: Floor;
  robots: Robot[];
  jobs?: RobotJob[];
  poseOf: (r: Robot) => RobotPose | null;
  radius?: number;
  clearance?: number;
  stations?: Station[];
}): CollisionReport {
  const { world, floor, robots, jobs = [], poseOf, stations = [] } = args;
  const radius = args.radius ?? ROBOT_RADIUS_M;
  const clearance = args.clearance ?? CLEARANCE_M;
  const outline = floor.outline ?? [];
  const collisions: Collision[] = [];
  const byRobot: Record<number, Collision[]> = {};
  const riskySegments: { robotId: number; segments: [Pt, Pt][] }[] = [];
  const add = (c: Collision) => {
    collisions.push(c);
    if (c.robotId != null) (byRobot[c.robotId] ??= []).push(c);
  };

  const layout = layoutCollisions(world, stations);
  collisions.push(...layout.collisions);

  const poses = new Map<number, RobotPose>();
  for (const r of robots) {
    const pose = poseOf(r);
    if (pose) poses.set(r.id, pose);
  }

  // Aktueller Stand: Fahrzeug gegen Station, Hindernis, Wand und Hallengrenze.
  for (const r of robots) {
    const pose = poses.get(r.id);
    if (!pose) continue;
    const body: Shape = { kind: "circle", x: pose.x, y: pose.y, r: radius };
    for (const hit of world.query(body, { groups: ["station", "obstacle", "wall"], clearance })) {
      add({
        group: hit.group, severity: hit.group === "station" ? "warning" : "danger",
        robotId: r.id, robotName: r.name, targetId: hit.id, targetLabel: hit.label,
        at: [pose.x, pose.y],
        detail: `${r.name} berührt ${hit.label}`,
      });
    }
    if (outline.length >= 3 && outsideOutline([pose.x, pose.y], outline, radius * 0.5)) {
      add({
        group: "wall", severity: "danger", robotId: r.id, robotName: r.name,
        targetId: "outline", targetLabel: "Hallengrenze", at: [pose.x, pose.y],
        detail: `${r.name} steht außerhalb der Halle`,
      });
    }
  }

  // Fahrzeug gegen Fahrzeug.
  const list = [...poses.entries()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [ida, a] = list[i], [idb, b] = list[j];
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - 2 * radius;
      if (gap > clearance) continue;
      const ra = robots.find((r) => r.id === ida)?.name ?? `Roboter ${ida}`;
      const rb = robots.find((r) => r.id === idb)?.name ?? `Roboter ${idb}`;
      const at: Pt = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      add({ group: "robot", severity: "danger", robotId: ida, robotName: ra,
        targetId: `robot:${idb}`, targetLabel: rb, at, detail: `${ra} und ${rb} zu nah beieinander` });
      add({ group: "robot", severity: "danger", robotId: idb, robotName: rb,
        targetId: `robot:${ida}`, targetLabel: ra, at, detail: `${rb} und ${ra} zu nah beieinander` });
    }
  }

  // Geplante Wege: nur Hindernisse und Wände prüfen. Eine Route beginnt und
  // endet oft an einer Station — die als Hindernis zu melden wäre nur Lärm.
  for (const job of jobs) {
    if (job.robot_id == null || job.route.length < 2) continue;
    const segments: [Pt, Pt][] = [];
    for (let i = 0; i + 1 < job.route.length; i++) {
      const a = job.route[i], b = job.route[i + 1];
      const shape: Shape = { kind: "segment", a, b, r: radius };
      const hits = world.query(shape, { groups: ["obstacle", "wall"], clearance });
      const outside = outline.length >= 3 && (outsideOutline(a, outline) || outsideOutline(b, outline));
      if (!hits.length && !outside) continue;
      segments.push([a, b]);
      const at: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      for (const hit of hits) {
        add({ group: "route", severity: "danger", robotId: job.robot_id,
          robotName: job.robot_name || `Roboter ${job.robot_id}`, targetId: hit.id,
          targetLabel: hit.label, at, detail: `${job.ref}: Weg durch ${hit.label}` });
      }
      if (outside) {
        add({ group: "route", severity: "danger", robotId: job.robot_id,
          robotName: job.robot_name || `Roboter ${job.robot_id}`, targetId: "outline",
          targetLabel: "Hallengrenze", at, detail: `${job.ref}: Weg verlässt die Halle` });
      }
    }
    if (segments.length) riskySegments.push({ robotId: job.robot_id, segments });
  }

  return { collisions, byRobot, riskySegments, collidingStationIds: layout.collidingStationIds };
}
