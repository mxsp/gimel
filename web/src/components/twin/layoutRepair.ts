import type { Aisles, Floor, Robot, RobotJob, Station } from "../../factory";
import { stationCorners } from "../../factory";
import type { Pt } from "./aisleWays";
import {
  buildTwinWorld, CollisionWorld, layoutCollisions, outsideOutline, ROBOT_RADIUS_M,
} from "./collision";

/* Kollisionsfreie Anordnung für den digitalen Zwilling.

   Nur Darstellung: die Funktion liefert *neue* Koordinaten für Stationen,
   Gangknoten und Routen, verändert aber keine übergebenen Objekte. Wo Gimel
   wirklich entscheidet (Route, Weglänge, Zuordnung), bleibt das Backend
   zuständig; diese Datei ist ein Werkzeug, um einen Grundriss zu bereinigen —
   benutzt für die Demo-Daten und in Tests, nie stillschweigend im Leitstand.

   Reihenfolge ist wichtig: erst die Körper (Stationen) aus Hindernissen und
   voneinander schieben, dann das Gangnetz und die Routen an die freien
   Flächen anpassen. */

export interface RepairInput {
  floor: Floor;
  stations: Station[];
  robots?: Robot[];
  jobs?: RobotJob[];
  /** Breite der Fahrspur, deren Mittellinie frei liegen muss. */
  laneRadius?: number;
}

export interface RepairResult {
  stations: Station[];
  aisles: Aisles;
  robots: Robot[];
  jobs: RobotJob[];
  movedStations: number;
  movedNodes: number;
  movedRoutePoints: number;
}

const DIRECTIONS: Pt[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.71, 0.71], [-0.71, 0.71], [0.71, -0.71], [-0.71, -0.71],
];

function clearPoint(p: Pt, world: CollisionWorld, radius: number, outline: Pt[]): Pt | null {
  const ok = (q: Pt) => !outsideOutline(q, outline, radius)
    && world.query({ kind: "circle", x: q[0], y: q[1], r: radius },
      { groups: ["station", "obstacle"] }).length === 0;
  if (ok(p)) return p;
  // 0,25 m statt 0,5 m: enge Gassen zwischen zwei Regalen (2,5 m) haben nur
  // wenige Dezimeter Spiel; ein grober Schritt springt daran vorbei bis zur Wand.
  for (let step = 0.25; step <= 16; step += 0.25) {
    for (const [dx, dy] of DIRECTIONS) {
      const q: Pt = [p[0] + dx * step, p[1] + dy * step];
      if (ok(q)) return q;
    }
  }
  return null;
}

/** Nächster Ort, an dem ein Kreis frei liegt. Bleibt nichts, bleibt der Punkt
    stehen — die Anzeige meldet ihn dann weiter als Kollision, statt ihn zu
    erfinden. */
export function nearestFreePoint(p: Pt, world: CollisionWorld, radius: number, outline: Pt[]): Pt {
  return clearPoint(p, world, radius, outline) ?? p;
}

function stationShape(s: Station) {
  return { kind: "polygon" as const, points: stationCorners(s) };
}

/** Eine Station so weit verschieben, bis sie weder ein Hindernis noch eine
    andere Station berührt. Gesucht wird in acht Richtungen mit wachsendem
    Abstand; der erste freie Ort gewinnt. */
function freeStation(s: Station, others: Station[], floor: Floor): Station {
  const outline = floor.outline ?? [];
  const world = buildTwinWorld(floor, others);
  const hits = (candidate: Station) => world.query(stationShape(candidate), {
    groups: ["station", "obstacle"], exclude: (c) => c.id === `station:${s.id}`,
  }).length > 0;
  if (!hits(s) && !outsideOutline([s.x, s.y], outline, Math.min(s.w, s.h) / 2)) return s;
  for (let step = 0.5; step <= 16; step += 0.5) {
    for (const [dx, dy] of DIRECTIONS) {
      const candidate: Station = { ...s, x: Math.round((s.x + dx * step) * 100) / 100,
        y: Math.round((s.y + dy * step) * 100) / 100 };
      if (!hits(candidate) && !outsideOutline([candidate.x, candidate.y], outline,
        Math.min(candidate.w, candidate.h) / 2)) return candidate;
    }
  }
  return s;
}

function moved(a: Pt, b: Pt): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6;
}

export function repairLayout(input: RepairInput): RepairResult {
  const { floor } = input;
  const laneRadius = input.laneRadius ?? 1.1;
  const outline = floor.outline ?? [];

  // 1. Körper: Stationen aus Hindernissen und voneinander schieben.
  const stations = input.stations.map((s) => ({ ...s }));
  let movedStations = 0;
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (let i = 0; i < stations.length; i++) {
      const others = stations.filter((_, j) => j !== i);
      const next = freeStation(stations[i], others, floor);
      if (moved([stations[i].x, stations[i].y], [next.x, next.y])) {
        stations[i] = next;
        changed = true;
        movedStations++;
      }
    }
    if (!changed) break;
  }

  // 2. Gangnetz: jeder Knoten bekommt einen freien Ort. Kanten bleiben
  //    erhalten; die Anzeige kappt sie ohnehin an Körpern (clearPolyline).
  const world = buildTwinWorld(floor, stations);
  const src = floor.aisles ?? { nodes: [], edges: [] };
  const nodes: Pt[] = (src.nodes ?? []).map((p) => [p[0], p[1]] as Pt);
  let movedNodes = 0;
  for (let i = 0; i < nodes.length; i++) {
    const q = nearestFreePoint(nodes[i], world, laneRadius, outline);
    if (moved(nodes[i], q)) { nodes[i] = q; movedNodes++; }
  }
  const aisles: Aisles = {
    ...src, nodes,
    edges: (src.edges ?? []).map(([a, b]) => [a, b] as [number, number]),
    paths: (src.paths ?? []).map((p) => ({ ...p, points: p.points.map((q) => [q[0], q[1]] as Pt) })),
  };
  if (aisles.paths) {
    aisles.paths = aisles.paths.map((p) => ({
      ...p,
      points: p.points.map((q, i) => i === 0 ? q : nearestFreePoint(q, world, 0.35, outline)),
    }));
  }

  // 3. Roboter- und Transportrouten: Stützpunkte aus Körpern holen.
  const robots = (input.robots ?? []).map((r) => ({
    ...r,
    route: r.route.map((p) => nearestFreePoint([p[0], p[1]], world, ROBOT_RADIUS_M, outline)),
  }));
  const jobs = (input.jobs ?? []).map((j) => ({
    ...j,
    route: j.route.map((p) => nearestFreePoint([p[0], p[1]], world, ROBOT_RADIUS_M, outline)),
  }));
  const movedRoutePoints = robots.reduce((n, r, i) => n +
    r.route.filter((p, k) => moved(p, (input.robots?.[i]?.route?.[k] ?? p))).length, 0)
    + jobs.reduce((n, j, i) => n +
      j.route.filter((p, k) => moved(p, (input.jobs?.[i]?.route?.[k] ?? p))).length, 0);

  return { stations, aisles, robots, jobs, movedStations, movedNodes, movedRoutePoints };
}

/** Prüft, ob eine Anordnung noch Körper berührt — für Tests und für die
    Prüfung der Demo-Daten. */
export function layoutIsClear(floor: Floor, stations: Station[], laneRadius = 1.1): boolean {
  const world = buildTwinWorld(floor, stations);
  if (layoutCollisions(world, stations).collisions.length) return false;
  for (const [x, y] of floor.aisles?.nodes ?? []) {
    if (world.query({ kind: "circle", x, y, r: laneRadius },
      { groups: ["station", "obstacle"] }).length) return false;
  }
  return true;
}
