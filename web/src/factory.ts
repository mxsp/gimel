import { days } from "./plural";
import type { IconName } from "@blueprintjs/core";

// Gemeinsame Typen und Helfer des Digitalen Grundrisses.
// Koordinaten sind durchweg Meter (Grundriss wie Stationen), Rotation in Grad.
//
// Was hier steht, ist Darstellung und Editierhilfe. Die Zahlen, mit denen
// *entschieden* wird — Wegstrecke, Belegzeit, Zuordnung — kommen aus dem
// Backend (app/domain/routing.py). Diese Datei rechnet sie höchstens für die
// Vorschau nach; zwei Implementierungen einer Entscheidung wären genau der
// Fehler, den CLAUDE.md §2.3 als vertrauenszerstörend beschreibt.

export type StationType = "accounting" | "production" | "shipping" | "warehouse";
export type StationRouting = "pull" | "smart_suggest" | "smart_auto";
export type StationVisibility = "collapse" | "hide";
export type MachineKind = "" | "plotter" | "punch" | "waterjet" | "manual";

/** Was im Editor gerade gezeichnet wird. */
export type FloorLayer = "outline" | "zone" | "obstacle" | "aisle" | "door";

export interface Zone {
  name: string;
  kind: string;
  colour: string;
  points: [number, number][];
}

export interface Obstacle {
  name: string;
  points: [number, number][];
  /** Bauteil-Art aus STRUCTURAL_PRESETS (z. B. "wall", "room", "column") — optional für Altbestände. */
  kind?: string;
  /** Optionale explizite Höhe in Metern für Semi-3D und 3D. */
  height_m?: number;
}

export interface Door {
  name: string;
  x: number;
  y: number;
  width: number;
  kind: "door" | "gate" | "ramp" | "stair" | "lift" | "emergency" | "window" | string;
}

/** Ein Weg von Hand: points[0] ist die Station, das Ende hängt ans Netz.
 *  Liegt im selben JSON wie die Gänge (Floor.aisles.paths), keine neue Spalte. */
export interface ManualPath {
  station: number | null;
  points: [number, number][];
}

export interface Aisles {
  nodes: [number, number][];
  edges: [number, number][];
  paths?: ManualPath[];
}

/** Förderband (gimel/core/conveyor.py): Mittellinie in Förderrichtung, je Punkt [x, y, Höhe?]. */
export interface Conveyor {
  name: string;
  points: number[][];
  width: number;
  from_station_id?: number | null;
  to_station_id?: number | null;
}

export interface Floor {
  id: number;
  name: string;
  outline: [number, number][];
  zones: Zone[];
  obstacles: Obstacle[];
  doors: Door[];
  aisles: Aisles;
  /** Fehlt bei älteren Servern. */
  conveyors?: Conveyor[];
  scale: number;
  grid: number;
  snap: number;
  bg: string;
  updated_at?: string | null;
  updated_by?: string;
  // Vom Server abgeleitet — nicht hier nachrechnen, sonst driften zwei Zahlen.
  area_m2?: number;
  perimeter_m?: number;
  aisle_m?: number;
  issues?: string[];
  // Halle und Ebene (Aufgabe 32). Leer bei alten Servern.
  hall_id?: number | null;
  level?: number;
  level_name?: string;
  elevation_m?: number;
  height_m?: number;
}

/** Tangente der Wand, auf der eine Tür sitzt.

    Eine Tür ist als Punkt auf einer Wand gespeichert, nicht als Rechteck mit
    eigener Drehung. Für jede Ansicht muss die Tür deshalb aus dem nächsten
    Wandstück — Umriss oder Hindernis — ihre Richtung bekommen; sonst steht
    ein Tor an der Nordwand 90° verdreht. */
export function doorDirection(floor: Floor, door: Door): [number, number] {
  const segments: [[number, number], [number, number]][] = [];
  const addLoop = (points: [number, number][] | undefined) => {
    if (!points || points.length < 2) return;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) segments.push([a, b]);
    }
  };
  addLoop(floor.outline ?? []);
  for (const o of floor.obstacles ?? []) addLoop(o.points ?? []);

  let best: [[number, number], [number, number]] | null = null;
  let bestDistance = Infinity;
  for (const [a, b] of segments) {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    const t = Math.max(0, Math.min(1, ((door.x - a[0]) * vx + (door.y - a[1]) * vy) / len2));
    const px = a[0] + vx * t, py = a[1] + vy * t;
    const distance = (door.x - px) ** 2 + (door.y - py) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = [a, b]; }
  }
  if (!best) return [1, 0];
  const dx = best[1][0] - best[0][0], dy = best[1][1] - best[0][1];
  const length = Math.hypot(dx, dy) || 1;
  return [dx / length, dy / length];
}

/** Effektive Art eines Zugangs: erkennt Altbestände wie „Treppe" / „Aufzug"
 *  mit kind="door" konsistent in 2D, Semi-3D, 3D und Seitenleiste. */
export function effectiveDoorKind(d: Pick<Door, "name" | "kind">): Door["kind"] {
  const k = d.kind || "door";
  if (k && k !== "door") return k;
  const name = (d.name || "").toLowerCase();
  if (/aufzug|fahrstuhl|lift|elevator/.test(name)) return "lift";
  if (/treppe|stufen|stair/.test(name)) return "stair";
  if (/notausgang|flucht/.test(name)) return "emergency";
  if (/fenster/.test(name)) return "window";
  if (/rampe/.test(name)) return "ramp";
  if (/hallentor|\btor\b/.test(name)) return "gate";
  return k;
}

/** Rastet einen Zugang auf die nächste Wand (Umriss oder Wand-/Raum-Hindernis) ein.
 *  Wandgebundene Zugänge (Tür, Tor, Rampe, Notausgang, Fensterband) landen immer auf
 *  der nächsten Wand, sobald eine existiert; Treppen & Aufzüge rasten nur nahe an Wänden ein. */
export function snapDoorToWall(
  floor: Floor,
  p: [number, number],
  kind: Door["kind"],
): { point: [number, number]; snapped: boolean } {
  const segments: [[number, number], [number, number]][] = [];
  const addLoop = (points: [number, number][] | undefined) => {
    if (!points || points.length < 2) return;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) segments.push([a, b]);
    }
  };
  addLoop(floor.outline ?? []);
  for (const o of floor.obstacles ?? []) {
    const ok = obstacleKind(o);
    if (ok === "wall" || ok === "partition" || ok === "room") addLoop(o.points ?? []);
  }
  if (!segments.length) return { point: p, snapped: false };

  let bestPt: [number, number] = p;
  let bestDist2 = Infinity;
  for (const [a, b] of segments) {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
    const px = a[0] + vx * t, py = a[1] + vy * t;
    const d2 = (p[0] - px) ** 2 + (p[1] - py) ** 2;
    if (d2 < bestDist2) { bestDist2 = d2; bestPt = [px, py]; }
  }
  const freeStanding = kind === "stair" || kind === "lift";
  const maxDist = freeStanding ? 1.2 : Infinity;
  if (Math.sqrt(bestDist2) <= maxDist) {
    return {
      point: [Math.round(bestPt[0] * 100) / 100, Math.round(bestPt[1] * 100) / 100],
      snapped: true,
    };
  }
  return { point: p, snapped: false };
}

/** Bauteil-Art eines Hindernisses — bevorzugt das gespeicherte `kind`, fällt sonst
 *  für Altbestände sauber auf den Namen zurück. */
export function obstacleKind(o: Pick<Obstacle, "name" | "kind">): string {
  if (o.kind) return o.kind;
  const name = (o.name || "").toLowerCase();
  if (name.includes("rundstütz") || name.includes("rundstutz")) return "round_column";
  if (name.includes("stütz") || name.includes("stutz") || name.includes("pfeiler") || name.includes("säule")) return "column";
  if (name.includes("trenn")) return "partition";
  if (name.includes("wand") || name.includes("mauer")) return "wall";
  if (name.includes("büro") || name.includes("buro") || name.includes("kabine") || name.includes("raum")) return "room";
  if (name.includes("zaun") || name.includes("geländer") || name.includes("gelaender") || name.includes("schutz")) return "fence";
  if (name.includes("regal")) return "rack_block";
  return "obstacle";
}

/** Einheitliche Höhe eines Hindernisses/Bauteils für Semi-3D und 3D (in Metern). */
export function obstacleHeight(o: Pick<Obstacle, "name" | "kind" | "height_m">, ceilingM = 6): number {
  const ceil = Math.max(2.5, Number(ceilingM) || 6);
  if (typeof o.height_m === "number" && Number.isFinite(o.height_m) && o.height_m > 0) {
    return Math.min(o.height_m, ceil);
  }
  switch (obstacleKind(o)) {
    case "wall":
    case "column":
    case "round_column":
      return ceil;
    case "room":
      return Math.min(2.8, ceil);
    case "rack_block":
      return Math.min(2.35, ceil);
    case "partition":
      return Math.min(2.2, ceil);
    case "fence":
      return Math.min(1.25, ceil);
    default:
      return 0.9;
  }
}

export const EMPTY_FLOOR: Floor = {
  id: 0, name: "Halle", outline: [], zones: [], obstacles: [], doors: [],
  aisles: { nodes: [], edges: [] }, scale: 40, grid: 1, snap: 0.25, bg: "#f5f5f0",
};

export interface Station {
  id?: number;
  label: string;
  type: StationType;
  subtype: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  colour: string;
  materials: string[];
  thicknesses: number[];
  assigned_users: number[];
  routing: StationRouting;
  visibility: StationVisibility;
  active: boolean;

  // Maschine. 0 heißt überall „unbekannt", nie „null" — ein fehlender Wert
  // schaltet seinen Faktor in der Zuordnung ab, statt ihn zu verfälschen.
  machine_kind: MachineKind;
  speed_mm_s: number;
  pierce_s: number;
  setup_min: number;
  changeover_min: number;
  handling_min_per_plate: number;
  max_sheet_w: number;
  max_sheet_h: number;
  thk_min: number;
  thk_max: number;
  cost_per_h: number;
  capacity_min_per_day: number;
  is_storage: boolean;

  // Zeiten der nicht schneidenden Stationen. Ein Packtisch hat keinen
  // Vorschub, aber ein Aufsetzen und ein Pro-Stück — ohne beide kann er so
  // wenig eine Fertigstellung versprechen wie ein Plotter ohne Vorschub.
  task_min: number;
  unit_min: number;
  note: string;

  // 3D-Modell: Dateiname, Größe und eigene Drehung. Die URL kommt vom Server.
  model_file: string;
  model_scale: number;
  model_rotation: number;
  /** Eingebautes Modell ohne Datei: leer = passend zu Typ und Art, ``box`` = Quader, sonst ein Eintrag aus ``MODEL_KINDS``. */
  model_kind?: string;
  /** Mitarbeiter am Arbeitsplatz: die 3D-Ansicht zeigt eine Figur (Darstellung, keine Ortung). */
  staffed?: boolean;
  model_url?: string;

  // Vom Server: Warteschlange und Rüstzustand.
  queue_min?: number;
  queue_jobs?: number;
  last_mat?: string;
  last_thk?: number;
  /** Ebene der Station; leer = erste Ebene. */
  floor_id?: number | null;
}

/** Eine mobile Transportressource — kein Arbeitsplatz. Die Position ist
 *  entweder gemeldet (x/y) oder aus Route und Zeit gerechnet (simulated). */
export interface Robot {
  id: number;
  name: string;
  kind: "agv" | "amr" | "arm" | string;
  floor_id: number | null;
  active: boolean;
  state: "idle" | "moving" | "charging" | "blocked" | "error" | "offline" | string;
  simulated: boolean;
  gateway_id: string;
  /** null = unbekannt, nicht 0 %. */
  battery_pct: number | null;
  payload_kg: number;
  capabilities: string[];
  route: [number, number][];
  route_mode: "loop" | "pingpong";
  route_m: number;
  speed_m_s: number;
  progress_m: number;
  /** null = Position unbekannt, nicht der Ursprung. */
  x: number | null;
  y: number | null;
  heading_deg: number | null;
  position_known?: boolean;
  heading_known?: boolean;
  /** Alter der letzten Meldung in Sekunden; Simulation kennt kein Alter. */
  age_s?: number | null;
  /** Fahrplan der Simulation (core/robot_traffic.py): Stützpunkte (t, Strecke) über
   *  einen Zyklus ab `epoch`. Damit kommt kein simulierter Roboter einem anderen zu nah. */
  sim_plan?: { period_s: number; keys: [number, number][]; cycle_m: number; parked: boolean; note: string; epoch: string } | null;
  stale?: boolean;
  updated_at?: string | null;
  /** Der Transport, den dieser Roboter gerade fährt. */
  active_job?: {
    id: number; ref: string; state: string; order_no: string;
    work_order_no: string; from_station_id: number | null; to_station_id: number | null;
  } | null;
}

/** Ein Flotten-Gateway mit lokalen Endpunkten. */
export interface RobotGateway {
  id: number;
  code: string;
  name: string;
  kind: "sim" | "http" | "vda5050" | string;
  base_url: string;
  endpoints: Record<string, string>;
  enabled: boolean;
  note: string;
  token_set: boolean;
  last_seen_at: string | null;
  updated_at: string | null;
  /** Nur einmal bei der Anlage geliefert, nie in Listen. */
  token?: string;
}

/** Eine versionierte Mission, ein Treiber oder eine Konfiguration. */
export interface RobotProgram {
  id: number;
  name: string;
  version: number;
  kind: "mission" | "driver" | "config" | string;
  language: "python" | "vda5050" | "json" | "text" | string;
  body: string;
  checksum: string;
  status: "draft" | "approved" | "deployed" | "retired" | string;
  robot_id: number | null;
  robot_name: string;
  gateway_id: string;
  notes: string;
  created_by: string;
  created_at: string | null;
  approved_by: string;
  approved_at: string | null;
  deployed_at: string | null;
}

export interface RobotDeployment {
  id: number;
  program_id: number | null;
  program_name: string;
  program_version: number | null;
  checksum: string;
  robot_id: number | null;
  robot_name: string;
  gateway_id: string;
  state: "queued" | "accepted" | "rejected" | "failed" | string;
  message: string;
  actor: string;
  rollback_of_id: number | null;
  created_at: string | null;
  finished_at: string | null;
}

export interface RobotJobStation {
  id: number;
  label: string;
}

/** Ein Transportauftrag mit Auftragskontext. */
export interface RobotJob {
  id: number;
  ref: string;
  kind: "pickup" | "delivery" | "transfer" | "return" | string;
  state: "proposed" | "approved" | "assigned" | "running" | "done" | "failed" | "cancelled" | string;
  priority: number;
  order_id: number | null;
  order_no: string;
  work_order_id: number | null;
  work_order_no: string;
  station_task_id: number | null;
  task_kind: string;
  task_ref: string;
  from: RobotJobStation | null;
  to: RobotJobStation | null;
  robot_id: number | null;
  robot_name: string;
  floor_id: number | null;
  route: [number, number][];
  route_m: number;
  route_exact: boolean;
  route_note: string;
  eta_s: number;
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
  note: string;
  created_by: string;
  created_at: string;
  approved_by: string;
  approved_at: string;
  assigned_by: string;
  assigned_at: string;
  started_at: string;
  finished_at: string;
  finished_by: string;
}

export interface RobotChoice {
  robot_id: number;
  name: string;
  distance_m: number;
  score: number;
  reason: string;
  eta_s: number;
}

export interface RobotJobPlan {
  kind: string;
  context: Record<string, unknown>;
  order_id: number | null;
  order_no: string;
  work_order_id: number | null;
  work_order_no: string;
  station_task_id: number | null;
  from: RobotJobStation & { x: number; y: number; floor_id: number | null };
  to: RobotJobStation & { x: number; y: number; floor_id: number | null };
  floor_id: number;
  route: [number, number][];
  route_m: number;
  route_exact: boolean;
  route_note: string;
  payload: Record<string, unknown>;
  candidates: RobotChoice[];
  rejected: { robot_id: number; name: string; reason: string }[];
  recommended: RobotChoice | null;
}

export const BLANK_STATION: Station = {
  label: "Neue Station", type: "production", subtype: "",
  x: 2, y: 2, w: 4, h: 2.5, rotation: 0, colour: "#106ba3",
  materials: [], thicknesses: [], assigned_users: [],
  routing: "pull", visibility: "collapse", active: true,
  machine_kind: "", speed_mm_s: 0, pierce_s: 0, setup_min: 0, changeover_min: 0,
  handling_min_per_plate: 0, max_sheet_w: 0, max_sheet_h: 0,
  thk_min: 0, thk_max: 0, cost_per_h: 0, capacity_min_per_day: 0,
  is_storage: false, task_min: 0, unit_min: 0, note: "",
  model_file: "", model_scale: 1, model_rotation: 0, model_kind: "", staffed: false,
};

/** Die eingebauten Gerätemodelle zur Auswahl (gleiche Liste wie ``MODEL_KINDS`` im Router). */
export const MODEL_KINDS: { value: string; label: string; hint: string }[] = [
  { value: "plotter", label: "Flachbett-Plotter", hint: "Schneidtisch mit Portal" },
  { value: "waterjet", label: "Wasserstrahlanlage", hint: "Becken mit Düsenportal" },
  { value: "punch", label: "Stanze / Presse", hint: "Revolverstanze mit Tisch" },
  { value: "manual", label: "Handarbeitsplatz", hint: "Werkbank mit Schraubstock" },
  { value: "generic", label: "Maschinenkabine", hint: "Gehäuse mit Bedienpult" },
  { value: "storage", label: "Regal / Lager", hint: "Fachbodenregal" },
  { value: "packing", label: "Packplatz", hint: "Tisch mit Rollenbahn" },
  { value: "office", label: "Büroinsel", hint: "Schreibtisch mit Bildschirm" },
];

export interface Product {
  id: string;
  name: string;
  short?: string;
  thicknesses?: number[];
  stock?: number;
  eur_m2?: number;
  lead_days?: number;
}

export interface StationUser {
  id: number;
  email: string;
  name: string;
  role: string;
}

// ---------------------------------------------------------------- Zuordnung
export interface RankFactor {
  key: string;
  label: string;
  points: number;
  max: number;
  share: number;
  reason: string;
}

export interface StationRank {
  station_id: number;
  label: string;
  routing: StationRouting;
  eligible: boolean;
  score: number;
  minutes: number;
  cost_eur: number;
  route_m: number;
  route_exact: boolean;
  changeover: boolean;
  summary: string;
  blockers: string[];
  factors: RankFactor[];
}

export interface HandlerRank {
  user_id: number;
  name: string;
  score: number;
  eligible: boolean;
  summary: string;
  blockers: string[];
  factors: RankFactor[];
}

export interface PlanSuggestion {
  job_no: string;
  station_id: number | null;
  label: string;
  score: number;
  mode: "auto" | "suggest" | "none";
  reason: string;
  ranking: StationRank[];
}

export interface FlowEdge {
  from: number;
  to: number;
  kind: "supply" | "dispatch" | string;
  count: number;
  metres: number;
  exact: boolean;
  materials: string[];
}

// ---------------------------------------------------------------- Lagerorte
/** Wo ein Werkstoff liegt: Lagerstation, Fach, Menge. `thk` 0 = Dicken gemischt. */
export interface StockLocationRow {
  id: number;
  mat: string;
  thk: number;
  station_id: number | null;
  station_label: string;
  hall_name: string;
  floor_name: string;
  bin: string;
  qty: number;
  note: string;
  /** Grundriss-Koordinaten der Lagerstation (Planungseinheiten, keine Meter). */
  x?: number | null;
  y?: number | null;
  updated_by: string;
  updated_at: string | null;
}

/** Ein Reststück: der ungenutzte Rest einer geschnittenen Platte (mm). */
export interface OffcutRow {
  id: number;
  code: string;
  mat: string;
  thk: number;
  w: number;
  h: number;
  area_m2: number;
  status: "pending" | "available" | "reserved" | "used" | "scrapped";
  station_id: number | null;
  station_label: string;
  hall_name: string;
  bin: string;
  note: string;
  source_work_order_no: string;
  work_order_no: string;
  created_at: string | null;
  available_at: string | null;
  used_at: string | null;
  /** Nur in der Bereitstellung: auf welche Platte des Innenauftrags es kommt. */
  plate_idx?: number;
}

// ---------------------------------------------------------------- Bereitstellen
/** Ein Innenauftrag im Bereitstellen-Schritt — zwischen Zuordnung und
 *  Schnittstart: welche Platten aus dem Regal an welche Maschine müssen,
 *  und ob das schon jemand gemacht hat. */
export interface StagingRow {
  no: string;
  mat: string;
  mat_name: string;
  thk: number;
  status: string;
  formats: Array<[number, number, number]>;
  n_plates: number;
  n_parts: number;
  planned_min: number;
  station_id: number | null;
  station_label: string;
  due_date: string | null;
  rush: boolean;
  staged: boolean;
  staged_at: string | null;
  staged_by: string;
  /** Aus welchem Lagerort geholt wurde; leer = Ort unbekannt. */
  staged_location_id: number | null;
  staged_location: string;
  started: boolean;
  release_reason: string;
  orders: { order_no: string; customer: string; n_parts: number }[];
  /** Wo diese Dicke liegt, größte Menge zuerst; leer = Ort unbekannt. */
  locations: StockLocationRow[];
  /** Summe der Mengen in `locations`. */
  located: number;
  /** Vom Server empfohlener Ort für diesen Auftrag (kann fehlen). */
  recommended_location_id: number | null;
  /** Warum dieser Ort empfohlen wird — im Klartext für den Dialog. */
  location_hint: string;
  /** Platten, die aus einem Reststück kommen — dafür keine volle Platte holen. */
  offcuts?: OffcutRow[];
  /** Volle Platten aus dem Regal (= n_plates − Reststücke). */
  n_full_plates?: number;
  /** Formate nur der vollen Platten. */
  full_formats?: Array<[number, number, number]>;
}

export interface StagingStation {
  id: number;
  label: string;
  machine_kind: MachineKind;
  type: string;
  active: boolean;
  /** Was an der Maschine zuletzt (bzw. jetzt) aufgespannt ist — vom Server
   *  geliefert, nicht hier nachgerechnet. Basis für den Rüstwechsel-Hinweis. */
  last_mat?: string;
  last_thk?: number;
}

/** Bestand eines Werkstoffs gegen den Bedarf der offenen Innenaufträge. */
export interface StagingMaterial {
  stock: number;
  demand: number;
  short: boolean;
}

export interface StagingData {
  rows: StagingRow[];
  stations: StagingStation[];
  counts: { open: number; staged: number; plates: number };
  /** Schlüssel ist der Werkstoff-Code (StagingRow.mat). */
  materials?: Record<string, StagingMaterial>;
}

// ---------------------------------------------------------------- Zwilling-Analyse
export interface TwinMove {
  job_no: string;
  from_id: number;
  from_label: string;
  station_id: number;
  label: string;
  minutes: number;
  score: number;
  reason: string;
}

export interface TwinFinding {
  kind: "capacity" | "changeover" | "transport" | "layout" | "dates" | "data" | string;
  severity: "danger" | "warning" | "info" | "success";
  title: string;
  detail: string;
  metric: string;
  station_ids: number[];
  job_nos: string[];
  moves: TwinMove[];
}

export interface TwinLoad {
  station_id: number;
  label: string;
  routing: StationRouting;
  queue_min: number;
  capacity: number;
  ratio: number | null;
  state: "idle" | "ok" | "warm" | "over" | "unknown";
  jobs: number;
  last_mat: string;
  last_thk: number;
  machine_kind: MachineKind;
}

export interface TwinAnalysis {
  loads: TwinLoad[];
  findings: TwinFinding[];
  unassigned: number;
  summary: {
    danger: number; warning: number; info: number;
    total_queue_min: number; total_capacity_min: number;
  };
}

export const FINDING_ICON: Record<string, string> = {
  capacity: "flame",
  changeover: "layers",
  transport: "route",
  layout: "layout",
  dates: "time",
  data: "issue",
  feed: "fast-forward",
};

export const LOAD_STATE_LABEL: Record<TwinLoad["state"], string> = {
  idle: "frei",
  ok: "im Takt",
  warm: "läuft voll",
  over: "überbucht",
  unknown: "Kapazität unbekannt",
};

// ---------------------------------------------------------------- Beschriftung
export const TYPE_LABEL: Record<StationType, string> = {
  production: "Fertigung",
  accounting: "Buchhaltung",
  shipping: "Versand",
  warehouse: "Lager",
};

export const MACHINE_LABEL: Record<MachineKind, string> = {
  "": "nicht angegeben",
  plotter: "Schneidplotter",
  punch: "Stanze",
  waterjet: "Wasserstrahl",
  manual: "Handarbeitsplatz",
};

export const ROUTING_LABEL: Record<StationRouting, string> = {
  pull: "Pull — Werkstatt zieht selbst",
  smart_suggest: "Smart — vorschlagen, Mensch entscheidet",
  smart_auto: "Smart — automatisch zuteilen",
};

export const ROUTING_SHORT: Record<StationRouting, string> = {
  pull: "Pull",
  smart_suggest: "Vorschlag",
  smart_auto: "Automatik",
};

export const ROUTING_HELP: Record<StationRouting, string> = {
  pull: "Diese Station wird nie von selbst beplant. Der Planer schlägt sie nicht einmal vor.",
  smart_suggest: "Der Planer schlägt sie vor; übernommen wird der Vorschlag erst per Klick.",
  smart_auto: "Der Planer darf hier zuteilen, solange der Hauptschalter an ist.",
};

export const VISIBILITY_LABEL: Record<StationVisibility, string> = {
  collapse: "Eingeblendet (zusammengeklappt)",
  hide: "Ausgeblendet",
};

export const LAYER_LABEL: Record<FloorLayer, string> = {
  outline: "Hallenumriss",
  zone: "Zone",
  obstacle: "Hindernis",
  aisle: "Gang",
  door: "Tor / Tür",
};

export const ZONE_KINDS: { id: string; label: string; colour: string }[] = [
  { id: "storage", label: "Lagerzone", colour: "#8e5cb8" },
  { id: "production", label: "Fertigungszone", colour: "#106ba3" },
  { id: "shipping", label: "Versandzone", colour: "#217e56" },
  { id: "office", label: "Büro", colour: "#ca9c19" },
  { id: "zone", label: "Sonstige Fläche", colour: "#5c7080" },
];

export const DOOR_KINDS: { id: Door["kind"]; label: string; width: number; icon: IconName }[] = [
  { id: "door", label: "Tür", width: 1.2, icon: "log-in" },
  { id: "gate", label: "Hallentor", width: 3.5, icon: "column-layout" },
  { id: "ramp", label: "Laderampe", width: 3.0, icon: "bring-data" },
  { id: "stair", label: "Treppe", width: 3.0, icon: "trending-up" },
  { id: "lift", label: "Aufzug", width: 2.2, icon: "swap-vertical" },
  { id: "emergency", label: "Notausgang", width: 1.4, icon: "direction-right" },
  { id: "window", label: "Fensterband", width: 3.0, icon: "grid-view" },
];

export interface StructuralPreset {
  id: string;
  label: string;
  name: string;
  hint: string;
  icon: IconName;
  w: number;
  d: number;
  shape: "rect" | "circle";
}

/** Vorgefertigte Bauteile für den Hallen-Designer (werden als Hindernis-Polygone
 *  mit sprechendem Namen angelegt — 2D, 3D, Kollision und Pfadfinder verstehen sie sofort). */
export const STRUCTURAL_PRESETS: StructuralPreset[] = [
  { id: "wall", label: "Innenwand", name: "Wand", hint: "Raumhohe Innenwand (6 × 0,25 m)", icon: "minus", w: 6.0, d: 0.25, shape: "rect" },
  { id: "partition", label: "Trennwand", name: "Trennwand", hint: "Halbhohe Trennwand 2,2 m (4 × 0,2 m)", icon: "split-columns", w: 4.0, d: 0.2, shape: "rect" },
  { id: "column", label: "Stütze", name: "Stütze", hint: "Raumhohe Hallenstütze (0,45 × 0,45 m)", icon: "stop", w: 0.45, d: 0.45, shape: "rect" },
  { id: "round_column", label: "Rundstütze", name: "Rundstütze", hint: "Runde Beton-/Stahlstütze (Ø 0,6 m)", icon: "full-circle", w: 0.6, d: 0.6, shape: "circle" },
  { id: "fence", label: "Schutzzaun", name: "Schutzzaun", hint: "Sicherheitszaun / Geländer 1,25 m (4 × 0,15 m)", icon: "shield", w: 4.0, d: 0.15, shape: "rect" },
  { id: "room", label: "Raumbox", name: "Bürokabine", hint: "Eingehauste Kabine / Meisterbüro (4 × 3 m)", icon: "office", w: 4.0, d: 3.0, shape: "rect" },
  { id: "rack_block", label: "Regalblock", name: "Regalblock", hint: "Lager- / Trennregal 2,35 m (4 × 1,2 m)", icon: "layers", w: 4.0, d: 1.2, shape: "rect" },
];

/** Erzeugt ein Polygon um ``[cx, cy]`` für ein Bauteil aus ``STRUCTURAL_PRESETS``. */
export function buildPresetPolygon(preset: StructuralPreset, cx: number, cy: number): [number, number][] {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  if (preset.shape === "circle") {
    const rad = preset.w / 2;
    return Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return [r2(cx + Math.cos(a) * rad), r2(cy + Math.sin(a) * rad)];
    });
  }
  const hw = preset.w / 2;
  const hd = preset.d / 2;
  return [
    [r2(cx - hw), r2(cy - hd)],
    [r2(cx + hw), r2(cy - hd)],
    [r2(cx + hw), r2(cy + hd)],
    [r2(cx - hw), r2(cy + hd)],
  ];
}

/** Verschiebt alle Punkte eines Polygons um (dx, dy), auf Zentimeter gerundet. */
export function translatePolygon(pts: [number, number][], dx: number, dy: number): [number, number][] {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return pts.map(([x, y]) => [r2(x + dx), r2(y + dy)]);
}

/** Dreht ein Polygon um seinen Mittelpunkt (deg in Grad, im Uhrzeigersinn in Plan-Koordinaten). */
export function rotatePolygon(pts: [number, number][], deg: number): [number, number][] {
  if (!pts.length) return [];
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return pts.map(([x, y]) => {
    const rx = x - cx, ry = y - cy;
    return [r2(cx + rx * cos - ry * sin), r2(cy + rx * sin + ry * cos)];
  });
}

/** Erkennt ein (auch gedrehtes) 4-Punkt-Rechteck und liefert Länge, Tiefe, Drehwinkel und Mitte. */
export function rectDimensions(
  pts: [number, number][],
): { w: number; d: number; angle: number; cx: number; cy: number } | null {
  if (pts.length !== 4) return null;
  const [p0, p1, p2, p3] = pts;
  const vx = p1[0] - p0[0], vy = p1[1] - p0[1];
  const wx = p3[0] - p0[0], wy = p3[1] - p0[1];
  const w = Math.hypot(vx, vy);
  const d = Math.hypot(wx, wy);
  if (w < 0.05 || d < 0.05) return null;
  const dot = (vx * wx + vy * wy) / (w * d);
  if (Math.abs(dot) > 0.05) return null;
  const oppX = p2[0] - (p1[0] + wx), oppY = p2[1] - (p1[1] + wy);
  if (Math.hypot(oppX, oppY) > 0.08) return null;
  const cx = (p0[0] + p2[0]) / 2;
  const cy = (p0[1] + p2[1]) / 2;
  const angle = Math.atan2(vy, vx);
  return { w: Math.round(w * 100) / 100, d: Math.round(d * 100) / 100, angle, cx, cy };
}

/** Skaliert ein 4-Punkt-Rechteck um seine Mitte bei beibehaltener Drehung auf (newW × newD). */
export function resizeRectPolygon(pts: [number, number][], newW: number, newD: number): [number, number][] {
  const info = rectDimensions(pts);
  if (!info) return pts;
  const w = Math.max(0.1, newW), d = Math.max(0.1, newD);
  const ux = Math.cos(info.angle), uy = Math.sin(info.angle);
  // Orientierung der zweiten Achse (p3 - p0) beibehalten
  const rawWx = pts[3][0] - pts[0][0], rawWy = pts[3][1] - pts[0][1];
  const rawD = Math.hypot(rawWx, rawWy) || 1;
  const nx = rawWx / rawD, ny = rawWy / rawD;
  const hw = w / 2, hd = d / 2;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return [
    [r2(info.cx - ux * hw - nx * hd), r2(info.cy - uy * hw - ny * hd)],
    [r2(info.cx + ux * hw - nx * hd), r2(info.cy + uy * hw - ny * hd)],
    [r2(info.cx + ux * hw + nx * hd), r2(info.cy + uy * hw + ny * hd)],
    [r2(info.cx - ux * hw + nx * hd), r2(info.cy - uy * hw + ny * hd)],
  ];
}

export const ALL_TYPES: StationType[] = ["production", "warehouse", "shipping", "accounting"];

export const TYPE_COLOUR: Record<StationType, string> = {
  production: "#106ba3",
  accounting: "#ca9c19",
  shipping: "#217e56",
  warehouse: "#8e5cb8",
};

const PALETTE = ["#0a5b9c", "#106ba3", "#217e56", "#ca9c19", "#c4520a", "#a8434b", "#8e5cb8", "#5c7080"];

export const COLOUR_PALETTE = PALETTE;

export function stationColour(s: Station): string {
  return s.colour || TYPE_COLOUR[s.type] || "#0a5b9c";
}

/** Sinnvolle Aufstellfläche je Stationstyp — Startwert beim Anlegen. */
export const TYPE_DEFAULT_SIZE: Record<StationType, { w: number; h: number }> = {
  production: { w: 4, h: 2.5 },
  warehouse: { w: 5, h: 4 },
  shipping: { w: 3, h: 4 },
  accounting: { w: 3, h: 3 },
};

/** Startwerte je Maschinenart — als *Vorschlag*, nicht als Wahrheit.
 *
 *  Diese Zahlen sind Größenordnungen aus der Literatur, keine Messung an
 *  des ersten Betriebs. Sie stehen hier, damit ein neuer Arbeitsplatz nicht mit
 *  lauter Nullen anfängt, und sie gehören auf die Prüfliste in CLAUDE.md §7.
 *  Die Oberfläche kennzeichnet sie deshalb als Richtwert. */
export const MACHINE_PRESET: Record<Exclude<MachineKind, "">, Partial<Station>> = {
  plotter:  { speed_mm_s: 50, pierce_s: 1.5, setup_min: 8,  changeover_min: 12, handling_min_per_plate: 2, max_sheet_w: 2000, max_sheet_h: 1500, thk_max: 6,  capacity_min_per_day: 480 },
  punch:    { speed_mm_s: 0,  pierce_s: 0.8, setup_min: 25, changeover_min: 30, handling_min_per_plate: 1, max_sheet_w: 1000, max_sheet_h: 1000, thk_max: 5,  capacity_min_per_day: 480 },
  waterjet: { speed_mm_s: 20, pierce_s: 8,   setup_min: 20, changeover_min: 25, handling_min_per_plate: 4, max_sheet_w: 3000, max_sheet_h: 2000, thk_max: 40, capacity_min_per_day: 480 },
  manual:   { speed_mm_s: 0,  pierce_s: 0,   setup_min: 5,  changeover_min: 5,  handling_min_per_plate: 1, max_sheet_w: 0,    max_sheet_h: 0,    thk_max: 0,  capacity_min_per_day: 480 },
};

/** Welche Maschinenwerte fehlen — die Liste, die die Zuordnung stumm macht. */
export function missingMachineData(s: Station): string[] {
  if (s.type !== "production") return [];
  const gaps: string[] = [];
  if (!s.speed_mm_s) gaps.push("Vorschub");
  if (!s.setup_min) gaps.push("Rüstzeit");
  if (!s.capacity_min_per_day) gaps.push("Tageskapazität");
  if (!s.max_sheet_w || !s.max_sheet_h) gaps.push("Tischgröße");
  return gaps;
}

// ---------------------------------------------------------------- Formate
export const fmtM = (v: number) =>
  `${v.toLocaleString("de-DE", { maximumFractionDigits: 1 })} m`;

export const fmtM2 = (v: number) =>
  `${v.toLocaleString("de-DE", { maximumFractionDigits: 1 })} m²`;

/** Minuten menschlich: 45 min, 2,5 h, 3,1 Tage (à 8 h). */
export function fmtMin(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0 min";
  if (v < 90) return `${Math.round(v)} min`;
  if (v < 8 * 60) return `${(v / 60).toLocaleString("de-DE", { maximumFractionDigits: 1 })} h`;
  return days(v / 480);
}

// ---------------------------------------------------------------- Geometrie
/** Umrisslinie als geschlossenes SVG-Path in Metern. */
export function outlinePath(pts: [number, number][]): string {
  if (!pts.length) return "";
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${p[1]}`).join(" ") + " Z";
}

/** Bounding-Box von Umriss, Zonen und Stationen — Basis für den fit-Zoom. */
export function sceneBounds(floor: Floor, stations: Station[]): { x: number; y: number; w: number; h: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  const eat = (pts: [number, number][]) => {
    for (const p of pts) { xs.push(p[0]); ys.push(p[1]); }
  };
  eat(floor.outline ?? []);
  for (const z of floor.zones ?? []) eat(z.points ?? []);
  for (const o of floor.obstacles ?? []) eat(o.points ?? []);
  eat(floor.aisles?.nodes ?? []);
  for (const d of floor.doors ?? []) { xs.push(d.x); ys.push(d.y); }
  for (const s of stations) {
    xs.push(s.x - s.w / 2, s.x + s.w / 2);
    ys.push(s.y - s.h / 2, s.y + s.h / 2);
  }
  if (!xs.length) return { x: -2, y: -2, w: 44, h: 28 };
  const pad = 1.5;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const w = Math.max(Math.max(...xs) + pad - minX, 8);
  const h = Math.max(Math.max(...ys) + pad - minY, 6);
  return { x: minX, y: minY, w, h };
}

/** Farbmischung Stationsfarbe → warm, je nach Auslastung 0..1. */
export function heatColour(base: string, ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  if (r <= 0.02) return base;
  const toRgb = (hex: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [10, 91, 156];
  };
  const [r1, g1, b1] = toRgb(base);
  // Ziel: kräftiges Signalrot — Temperatur, nicht Deko.
  const t: [number, number, number] = [196, 74, 52];
  const mix = (a: number, b: number) => Math.round(a + (b - a) * r);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(mix(r1, t[0]))}${hex(mix(g1, t[1]))}${hex(mix(b1, t[2]))}`;
}

export function stockHealth(stock: number): { label: string; intent: "success" | "warning" | "danger" } {
  if (stock <= 0) return { label: "nachbestellen", intent: "danger" };
  if (stock < 5) return { label: "knapp", intent: "warning" };
  return { label: "ok", intent: "success" };
}

/** Dauerlink auf die Unterseite einer Station — zum Verteilen am Aushang. */
export function stationUrl(id: number): string {
  return `${window.location.origin}/app/#/station/${id}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Die vier Eckpunkte eines gedrehten Stationsrechtecks, in Meter. */
export function stationCorners(s: Station): [number, number][] {
  const r = (s.rotation * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const lx = (sx * s.w) / 2, ly = (sy * s.h) / 2;
    return [s.x + lx * cos - ly * sin, s.y + lx * sin + ly * cos] as [number, number];
  });
}

export function pointInPolygon(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segsIntersect(a1: [number, number], a2: [number, number], b1: [number, number], b2: [number, number]): boolean {
  const d = (a1: [number, number], a2: [number, number], p: [number, number]) =>
    (a2[0] - a1[0]) * (p[1] - a1[1]) - (a2[1] - a1[1]) * (p[0] - a1[0]);
  const d1 = d(a1, a2, b1), d2 = d(a1, a2, b2), d3 = d(b1, b2, a1), d4 = d(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Flächeninhalt eines einfachen Polygons (Shoelace), in m². */
export function polygonArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Umfang inklusive der schließenden Kante, in m. */
export function polygonPerimeter(pts: [number, number][]): number {
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    len += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return len;
}

/** Schneidet sich der Umriss selbst (dann stimmt weder Fläche noch Schnitt)? */
export function polygonSelfIntersects(pts: [number, number][]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i], a2 = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // benachbarte Kanten teilen einen Punkt
      const b1 = pts[j], b2 = pts[(j + 1) % n];
      if (segsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/** Schwerpunkt eines Polygons — Ankerpunkt für Beschriftungen. */
export function polygonCentroid(pts: [number, number][]): [number, number] {
  if (!pts.length) return [0, 0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) {
    // Entartetes Polygon (Linie): das Mittel der Punkte ist ehrlicher als NaN.
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length,
            pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Liegt eine Station (teilweise) außerhalb der Hallenlinie? */
export function stationOutsideOutline(s: Station, outline: [number, number][]): boolean {
  if (outline.length < 3) return false;
  return stationCorners(s).some((c) => !pointInPolygon(c, outline));
}

/** Überlappen sich zwei gedrehte Stationsrechtecke? (Ecken + Kantenkreuzung) */
export function stationsOverlap(a: Station, b: Station): boolean {
  const ca = stationCorners(a), cb = stationCorners(b);
  if (ca.some((p) => pointInPolygon(p, cb))) return true;
  if (cb.some((p) => pointInPolygon(p, ca))) return true;
  for (let i = 0; i < 4; i++) {
    const a1 = ca[i], a2 = ca[(i + 1) % 4];
    for (let j = 0; j < 4; j++) {
      if (segsIntersect(a1, a2, cb[j], cb[(j + 1) % 4])) return true;
    }
  }
  return false;
}

/** Steht eine Station auf einem Hindernis? Im Editor eine Warnung wert. */
export function stationOnObstacle(s: Station, obstacles: Obstacle[]): boolean {
  const corners = stationCorners(s);
  return obstacles.some((o) =>
    (o.points?.length ?? 0) >= 3 &&
    (corners.some((c) => pointInPolygon(c, o.points))
      || o.points.some((p) => pointInPolygon(p, corners))));
}

// ---------------------------------------------------------------- Gangnetz
/** Nächster Gangknoten zu einem Punkt: Index und Abstand. */
export function nearestNode(aisles: Aisles, p: [number, number]): { idx: number; dist: number } {
  let idx = -1, dist = Infinity;
  (aisles.nodes ?? []).forEach((q, i) => {
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < dist) { idx = i; dist = d; }
  });
  return { idx, dist };
}

/** Kreuzt die Strecke ein Hindernis (Kante oder ganz darin)? */
export function segmentBlocked(a: [number, number], b: [number, number], obstacles: [number, number][][]): boolean {
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (const poly of obstacles) {
    if ((poly?.length ?? 0) < 3) continue;
    if (pointInPolygon(mid, poly)) return true;
    for (let i = 0; i < poly.length; i++) {
      if (segsIntersect(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
    }
  }
  return false;
}

type Pt = [number, number];

/** Verlässt die Strecke den Hallenumriss? Ohne Umriss (< 3 Punkte): nein.
 *  Gleiche Regel wie domain/layout.py::segment_leaves_outline. */
export function segmentLeavesOutline(a: Pt, b: Pt, outline: Pt[]): boolean {
  if ((outline?.length ?? 0) < 3) return false;
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (!pointInPolygon(mid, outline)) return true;
  for (let i = 0; i < outline.length; i++) {
    if (segsIntersect(a, b, outline[i], outline[(i + 1) % outline.length])) return true;
  }
  return false;
}

/** Wo ein Punkt ans Gangnetz anschließt: Knoten (edge = null) oder Punkt auf
 *  einer Kante (edge, t). blocked = kein freier Stichweg. */
export interface AisleAttach {
  found: boolean;
  point: Pt;
  dist: number;
  node: number;
  edge: [number, number] | null;
  t: number;
  blocked: boolean;
  /** Ein Knoten der Komponente, an der der Anschluss hängt (-1 ohne Netz). */
  anchor: number;
  /** "manual" = Weg von Hand gilt, sonst automatischer Stichweg. */
  kind: "manual" | "auto";
  /** Warum ein Weg von Hand nicht gilt (leer, wenn alles passt). */
  warning: string;
  /** Punkte eines gültigen Wegs von Hand, vom Standpunkt bis ans Netz. */
  way?: Pt[];
}

const NO_ATTACH: AisleAttach = { found: false, point: [0, 0], dist: Infinity, node: -1, edge: null, t: 0, blocked: false, anchor: -1, kind: "auto", warning: "" };

function projectOnSegment(p: Pt, a: Pt, b: Pt): { q: Pt; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return { q: a, t: 0 };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return { q: [a[0] + t * dx, a[1] + t * dy], t };
}

/** Der nächste *freie* Anschluss ans Netz — Knoten oder Kantenpunkt, nie durch
 *  ein Hindernis, nie aus der Halle hinaus. Gleiche Regel wie
 *  domain/layout.py::AisleGraph.attach (bei gleichem Abstand gewinnt ein Knoten). */
function autoAttach(p: Pt, aisles: Aisles, obstacles: Obstacle[] = [], outline: Pt[] = []): AisleAttach {
  const nodes = aisles?.nodes ?? [];
  if (!nodes.length) return NO_ATTACH;
  const obs = (obstacles ?? []).filter((o) => (o.points?.length ?? 0) >= 3).map((o) => o.points);
  type C = { d: number; kind: number; q: Pt; node: number; edge: [number, number] | null; t: number };
  const cands: C[] = nodes.map((q, i) => ({ d: Math.hypot(p[0] - q[0], p[1] - q[1]), kind: 0, q, node: i, edge: null, t: 0 }));
  for (const [i, j] of aisles?.edges ?? []) {
    if (!nodes[i] || !nodes[j] || i === j) continue;
    const { q, t } = projectOnSegment(p, nodes[i], nodes[j]);
    if (t > 0 && t < 1) cands.push({ d: Math.hypot(p[0] - q[0], p[1] - q[1]), kind: 1, q, node: -1, edge: [i, j], t });
  }
  cands.sort((u, v) => u.d - v.d || u.kind - v.kind);   // stabil: wie Python
  const mk = (c: C, blocked: boolean): AisleAttach => ({
    found: true, point: c.q, dist: c.d, node: c.node, edge: c.edge, t: c.t, blocked,
    anchor: c.edge ? c.edge[0] : c.node, kind: "auto", warning: "",
  });
  for (const c of cands) {
    if (c.d > 0 && (segmentBlocked(p, c.q, obs) || segmentLeavesOutline(p, c.q, outline))) continue;
    return mk(c, false);
  }
  return mk(cands[0], true);
}

const PATH_EPS = 1e-6;

/** Der Weg von Hand für den Standpunkt p, oder null, wenn es keinen gibt. Einer,
 *  der nicht gilt (Hindernis, aus der Halle, kein Anschluss am Ende), kommt als
 *  kind "auto" mit warning zurück. Gleiche Regel wie AisleGraph.manual_attach. */
export function manualAttach(p: Pt, aisles: Aisles, obstacles: Obstacle[] = [], outline: Pt[] = []): AisleAttach | null {
  const mine = (aisles?.paths ?? []).filter((m) => (m.points?.length ?? 0) >= 2
    && Math.hypot(m.points[0][0] - p[0], m.points[0][1] - p[1]) <= PATH_EPS);
  if (!mine.length) return null;
  const pts = mine[mine.length - 1].points;
  const obs = (obstacles ?? []).filter((o) => (o.points?.length ?? 0) >= 3).map((o) => o.points);
  const bad = (warning: string): AisleAttach => ({ ...NO_ATTACH, kind: "auto", warning });
  for (let i = 0; i + 1 < pts.length; i++) {
    if (segmentBlocked(pts[i], pts[i + 1], obs)) return bad("Pfad von Hand kreuzt ein Hindernis");
    if (segmentLeavesOutline(pts[i], pts[i + 1], outline)) return bad("Pfad von Hand verlässt die Halle");
  }
  const end = autoAttach(pts[pts.length - 1], aisles, obstacles, outline);
  if (!end.found || end.blocked) return bad("Pfad von Hand endet ohne freien Anschluss ans Netz");
  let length = 0;
  for (let i = 0; i + 1 < pts.length; i++) length += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return { ...end, dist: length + end.dist, blocked: false, kind: "manual", warning: "", way: pts };
}

/** Anschluss eines Punktes: Weg von Hand, wenn er gilt, sonst der nächste freie
 *  Stichweg (dann mit Warnung, falls ein Weg von Hand vorlag). */
export function aisleAttach(p: Pt, aisles: Aisles, obstacles: Obstacle[] = [], outline: Pt[] = []): AisleAttach {
  const man = manualAttach(p, aisles, obstacles, outline);
  if (man && man.kind === "manual") return man;
  const auto = autoAttach(p, aisles, obstacles, outline);
  return man && auto.found ? { ...auto, warning: man.warning } : auto;
}

/** Alte Form: Anbindung als Knotenindex. Der Index ist ein Knoten der
 *  Komponente, an der der Anschluss hängt. */
export function aisleStub(p: Pt, aisles: Aisles, obstacles: Obstacle[], outline: Pt[] = []):
    { idx: number; dist: number; blocked: boolean } {
  const at = aisleAttach(p, aisles, obstacles, outline);
  return { idx: at.anchor, dist: at.dist, blocked: at.blocked };
}

/** Verbundkomponente je Gangknoten — Inseln im Netz erkennen. Gleiche
 *  Regel wie domain/layout.py::AisleGraph.component_ids. */
export function aisleComponents(aisles: Aisles): number[] {
  const nodes = aisles?.nodes ?? [];
  const adj: number[][] = nodes.map(() => []);
  for (const [i, j] of aisles?.edges ?? []) {
    if (!nodes[i] || !nodes[j]) continue;
    adj[i].push(j);
    adj[j].push(i);
  }
  const comp = nodes.map(() => -1);
  let label = 0;
  for (let start = 0; start < nodes.length; start++) {
    if (comp[start] !== -1) continue;
    comp[start] = label;
    const stack = [start];
    while (stack.length) {
      const u = stack.pop()!;
      for (const v of adj[u]) {
        if (comp[v] === -1) { comp[v] = label; stack.push(v); }
      }
    }
    label++;
  }
  return comp;
}

/** Der wirkliche Weg über das Gangnetz als Linienzug — vom Standpunkt über
 *  den Stichweg, die Gangknoten und den Zielstich. Dieselbe Anbindung wie
 *  ``routeMetres``; nur die Geometrie wird zusätzlich zurückgegeben. */
export function routePoints(
  aisles: Aisles, a: Pt, b: Pt, obstacles: Obstacle[] = [], outline: Pt[] = [],
): { points: Pt[]; exact: boolean; note: string; kind: "manual" | "auto" | "air"; warning: string } {
  const direct: Pt[] = [a, b];
  const nodes = aisles?.nodes ?? [];
  const edges = aisles?.edges ?? [];
  if (nodes.length < 2 || !edges.length) {
    return { points: direct, exact: false, note: "Luftlinie — kein Gangnetz erfasst", kind: "air", warning: "" };
  }
  const aa = aisleAttach(a, aisles, obstacles, outline);
  const ab = aisleAttach(b, aisles, obstacles, outline);
  const warning = [aa.warning, ab.warning].filter(Boolean).join("; ");
  if (!aa.found || !ab.found || aa.blocked || ab.blocked) {
    return { points: direct, exact: false, note: "Luftlinie — kein freier Anschluss ans Gangnetz", kind: "air", warning };
  }
  const optionList = (at: AisleAttach) => {
    if (at.edge) {
      const [i, j] = at.edge;
      return [
        { node: i, cost: Math.hypot(at.point[0] - nodes[i][0], at.point[1] - nodes[i][1]) },
        { node: j, cost: Math.hypot(at.point[0] - nodes[j][0], at.point[1] - nodes[j][1]) },
      ];
    }
    return at.node >= 0 ? [{ node: at.node, cost: 0 }] : [];
  };
  const starts = optionList(aa), ends = optionList(ab);
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  for (const s of starts) if (s.cost < (dist.get(s.node) ?? Infinity)) dist.set(s.node, s.cost);
  const seen = new Set<number>();
  for (;;) {
    let u = -1, best = Infinity;
    for (const [k, d] of dist) if (!seen.has(k) && d < best) { u = k; best = d; }
    if (u < 0) break;
    seen.add(u);
    for (const [i, j] of edges) {
      let v = -1;
      if (i === u) v = j; else if (j === u) v = i;
      if (v < 0 || !nodes[v] || i === j) continue;
      const nd = best + Math.hypot(nodes[u][0] - nodes[v][0], nodes[u][1] - nodes[v][1]);
      if (nd < (dist.get(v) ?? Infinity) - 1e-12) { dist.set(v, nd); prev.set(v, u); }
    }
  }
  let endNode = -1, endCost = Infinity;
  for (const e of ends) {
    const d = (dist.get(e.node) ?? Infinity) + e.cost;
    if (d < endCost - 1e-12) { endCost = d; endNode = e.node; }
  }
  if (endNode < 0 || !Number.isFinite(endCost)) {
    return { points: direct, exact: false, note: "Luftlinie — Gangnetz nicht durchgängig", kind: "air", warning };
  }
  const nodePath: number[] = [];
  for (let cur = endNode; cur >= 0;) {
    nodePath.push(cur);
    const p = prev.get(cur);
    if (p == null) break;
    cur = p;
  }
  nodePath.reverse();
  const pts: Pt[] = [];
  if (aa.way) pts.push(...aa.way); else pts.push(a, aa.point);
  if (aa.edge) pts.push(nodes[nodePath[0]]);
  for (const n of nodePath) pts.push(nodes[n]);
  if (ab.way) {
    // Der Weg von Hand beginnt am Zielpunkt und endet am Netz.
    pts.push(...[...ab.way].reverse());
  } else {
    if (ab.edge) pts.push(ab.point);
    pts.push(b);
  }
  const points = simplifyPolyline(pts.filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 1e-9));
  return { points, exact: true, note: "über das Gangnetz", kind: aa.kind === "manual" || ab.kind === "manual" ? "manual" : "auto", warning };
}

/** Kürzester Weg über das Gangnetz — die Vorschau zu dem, was das Backend
 *  entscheidet (domain/layout.py::AisleGraph.route, gleiche Regeln und Zahlen):
 *  Anschluss an Knoten oder Kantenpunkt, freier Stichweg, sonst Luftlinie. */
export function routeMetres(aisles: Aisles, a: Pt, b: Pt, obstacles: Obstacle[] = [], outline: Pt[] = []):
    { metres: number; exact: boolean; note: string; kind: "manual" | "auto" | "air"; warning: string } {
  const direct = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let warning = "";
  const out = (metres: number, exact: boolean, note: string, kind: "manual" | "auto" | "air") =>
    ({ metres, exact, note, kind: exact ? kind : "air" as const, warning });
  const nodes = aisles?.nodes ?? [];
  const edges = aisles?.edges ?? [];
  if (nodes.length < 2 || !edges.length) return out(direct, false, "Luftlinie — kein Gangnetz erfasst", "air");
  const aa = aisleAttach(a, aisles, obstacles, outline);
  const ab = aisleAttach(b, aisles, obstacles, outline);
  warning = [aa.warning, ab.warning].filter(Boolean).join("; ");
  const manual = aa.kind === "manual" || ab.kind === "manual" ? "manual" : "auto";
  if (!aa.found || !ab.found) return out(direct, false, "Luftlinie — kein Gangnetz erfasst", "air");
  if (aa.blocked || ab.blocked) {
    return out(direct, false, `Luftlinie — der Stichweg zum ${aa.blocked ? "Start" : "Ziel"} kreuzt ein Hindernis oder verlässt die Halle`, "air");
  }
  if (!aa.edge && !ab.edge && aa.node === ab.node) return out(aa.dist + ab.dist, true, "über einen Gangknoten", manual);
  if (aa.edge && ab.edge && aa.edge[0] === ab.edge[0] && aa.edge[1] === ab.edge[1]) {
    const along = Math.hypot(aa.point[0] - ab.point[0], aa.point[1] - ab.point[1]);
    return out(aa.dist + along + ab.dist, true, "über eine Gangkante", manual);
  }
  const ends = (at: AisleAttach): [number, number][] =>
    at.edge ? at.edge.map((k) => [k, Math.hypot(at.point[0] - nodes[k][0], at.point[1] - nodes[k][1])] as [number, number])
            : [[at.node, 0]];
  const adj: [number, number][][] = nodes.map(() => []);
  for (const [i, j] of edges) {
    if (!nodes[i] || !nodes[j] || i === j) continue;
    const w = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]);
    adj[i].push([j, w]);
    adj[j].push([i, w]);
  }
  const dist = nodes.map(() => Infinity);
  for (const [k, off] of ends(aa)) if (off < dist[k]) dist[k] = off;
  const seen = new Set<number>();
  // Kleine Netze — lineare Suche statt Heap.
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < dist.length; i++) if (!seen.has(i) && dist[i] < best) { u = i; best = dist[i]; }
    if (u < 0) break;
    seen.add(u);
    for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) dist[v] = dist[u] + w;
  }
  let best = Infinity;
  for (const [k, off] of ends(ab)) best = Math.min(best, dist[k] + off);
  if (!Number.isFinite(best)) return out(direct, false, "Luftlinie — Gangnetz nicht durchgängig", "air");
  return out(aa.dist + best + ab.dist, true, "über das Gangnetz", manual);
}

/** Ein Klick: die Station an das Netz hängen. Setzt einen Knoten auf die
 *  Stationsmitte und verbindet ihn mit dem nächsten freien Anschluss; liegt
 *  der auf einer Kante, wird sie dort geteilt. null, wenn jeder Weg
 *  blockiert ist (dann muss von Hand ein Knoten gesetzt werden). */
export function connectStation(p: Pt, aisles: Aisles, obstacles: Obstacle[] = [], outline: Pt[] = []): Aisles | null {
  const at = autoAttach(p, aisles, obstacles, outline);
  if (!at.found || at.blocked) return null;
  const nodes = [...(aisles.nodes ?? [])];
  let edges = [...(aisles.edges ?? [])];
  let target = at.node;
  if (at.edge) {
    const [i, j] = at.edge;
    nodes.push(at.point);
    target = nodes.length - 1;
    edges = edges.filter(([u, v]) => !((u === i && v === j) || (u === j && v === i)));
    edges.push([i, target], [target, j]);
  }
  if (at.dist < 1e-9) return { ...aisles, nodes, edges };   // liegt schon auf dem Netz
  nodes.push(p);
  edges.push([target, nodes.length - 1]);
  return { ...aisles, nodes, edges };
}

// ---------------------------------------------------------------- Pfadfinder
/* Wege um Hindernisse, innerhalb des Umrisses — Sichtbarkeitsgraph + A*.
   Dieselbe Rechnung wie gimel/core/pathfind.py; beide Seiten stimmen über
   tests/core/fixtures/aisle_parity.json überein. Deterministisch; die Grenze ist
   eine Zahl Sichtprüfungen, keine Zeit. Überschritten → null, nie ein halber Weg. */
export const PF_MARGIN = 0.3;
export const PF_MAX_WAYPOINTS = 400;
export const PF_MAX_TESTS = 400_000;
export const PF_MAX_CANDIDATES = 6;

function areaSigned(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function edgeNormal(a: Pt, b: Pt, ccw: boolean): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const ln = Math.hypot(dx, dy) || 1;
  return ccw ? [dy / ln, -dx / ln] : [-dy / ln, dx / ln];
}

function offsetCorners(poly: Pt[], margin: number, outward: boolean): (Pt | null)[] {
  const n = poly.length;
  const ccw = areaSigned(poly) > 0;
  return poly.map((v, i) => {
    const u = poly[(i + n - 1) % n], w = poly[(i + 1) % n];
    const n1 = edgeNormal(u, v, ccw), n2 = edgeNormal(v, w, ccw);
    let bx = n1[0] + n2[0], by = n1[1] + n2[1];
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) return null;
    bx /= bl; by /= bl;
    const k = (margin / Math.max(0.3, bx * n1[0] + by * n1[1])) * (outward ? 1 : -1);
    return [v[0] + bx * k, v[1] + by * k] as Pt;
  });
}

class BudgetExceeded extends Error {}

export class Pathfinder {
  outline: Pt[];
  obstacles: Pt[][];
  waypoints: Pt[] = [];
  tests = 0;
  private vis = new Map<string, boolean>();

  constructor(outline: Pt[] = [], obstacles: Pt[][] = [], private maxTests = PF_MAX_TESTS, margin = PF_MARGIN) {
    this.outline = (outline?.length ?? 0) >= 3 ? outline : [];
    this.obstacles = (obstacles ?? []).filter((o) => (o?.length ?? 0) >= 3);
    const pts: Pt[] = [];
    for (const o of this.obstacles) for (const q of offsetCorners(o, margin, true)) if (q) pts.push(q);
    if (this.outline.length) {
      const ccw = areaSigned(this.outline) > 0;
      const n = this.outline.length;
      const inner = offsetCorners(this.outline, margin, false);
      this.outline.forEach((q, i) => {
        const u = this.outline[(i + n - 1) % n], w = this.outline[(i + 1) % n];
        const cross = (q[0] - u[0]) * (w[1] - q[1]) - (q[1] - u[1]) * (w[0] - q[0]);
        if ((ccw ? cross < 0 : cross > 0) && inner[i]) pts.push(inner[i]!);
      });
    }
    this.waypoints = pts
      .filter((q) => (!this.outline.length || pointInPolygon(q, this.outline))
        && !this.obstacles.some((o) => pointInPolygon(q, o)))
      .slice(0, PF_MAX_WAYPOINTS);
  }

  private visible(a: Pt, b: Pt): boolean {
    const swap = a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
    const [p, q] = swap ? [b, a] : [a, b];
    const key = `${p[0]},${p[1]}|${q[0]},${q[1]}`;
    const hit = this.vis.get(key);
    if (hit !== undefined) return hit;
    if (++this.tests > this.maxTests) throw new BudgetExceeded();
    const ok = !segmentBlocked(a, b, this.obstacles) && !segmentLeavesOutline(a, b, this.outline);
    this.vis.set(key, ok);
    return ok;
  }

  /** Kürzester freier Weg a → b als Linienzug mit beiden Enden, sonst null. */
  path(a: Pt, b: Pt): Pt[] | null {
    try { return this.search(a, b); } catch (e) {
      if (e instanceof BudgetExceeded) return null;
      throw e;
    }
  }

  private search(a: Pt, b: Pt): Pt[] | null {
    if (this.visible(a, b)) return [a, b];
    const pts: Pt[] = [a, b, ...this.waypoints];
    const g = new Map<number, number>([[0, 0]]);
    const prev = new Map<number, number>();
    const done = new Set<number>();
    // Kleine Mengen: Offene Liste linear durchsucht; Gleichstand → kleinerer Index (wie Python: (f, v, v)).
    const open = new Map<number, number>([[0, Math.hypot(b[0] - a[0], b[1] - a[1])]]);
    while (open.size) {
      let u = -1, bf = Infinity;
      for (const [k, f] of open) if (f < bf || (f === bf && k < u)) { u = k; bf = f; }
      open.delete(u);
      if (done.has(u)) continue;
      done.add(u);
      if (u === 1) {
        const out: Pt[] = [];
        for (let c = 1; ; c = prev.get(c)!) { out.push(pts[c]); if (c === 0) break; }
        return out.reverse();
      }
      for (let v = 0; v < pts.length; v++) {
        if (v === u || done.has(v) || (u === 0 && v === 1)) continue;
        if (!this.visible(pts[u], pts[v])) continue;
        const nd = g.get(u)! + Math.hypot(pts[v][0] - pts[u][0], pts[v][1] - pts[u][1]);
        if (nd < (g.get(v) ?? Infinity) - 1e-12) {
          g.set(v, nd);
          prev.set(v, u);
          open.set(v, nd + Math.hypot(b[0] - pts[v][0], b[1] - pts[v][1]));
        }
      }
    }
    return null;
  }
}

/** Länge eines Linienzugs in Metern. */
export function polylineLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return l;
}

/** Punkte ohne Doppel und ohne Zwischenpunkte auf gerader Strecke. Gleiche
    Regel wie ``core/pathfind.py::simplify_polyline``; die Länge bleibt gleich. */
export function simplifyPolyline(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    if (out.length && Math.hypot(out[out.length - 1][0] - p[0], out[out.length - 1][1] - p[1]) < 1e-9) continue;
    while (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      const cross = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0]);
      if (Math.abs(cross) > 1e-9 * Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]))) break;
      out.pop();
    }
    out.push(p);
  }
  return out;
}

/** Das Gangnetz aufräumen: doppelte Knoten, doppelte und Null-Kanten sowie
    überflüssige Zwischenknoten auf geraden Strecken entfernen. Manuelle Pfade
    hängen an Koordinaten, nicht an Indizes, und bleiben deshalb erhalten. */
export function cleanAisles(aisles: Aisles, eps = 1e-6): Aisles {
  const nodes0 = aisles?.nodes ?? [];
  const keep: Pt[] = [];
  const remap = new Map<number, number>();
  const seen = new Map<string, number>();
  nodes0.forEach((p, i) => {
    const key = `${Math.round(p[0] / eps)}:${Math.round(p[1] / eps)}`;
    const hit = seen.get(key);
    if (hit != null) { remap.set(i, hit); return; }
    const at = keep.length;
    seen.set(key, at); remap.set(i, at); keep.push([p[0], p[1]]);
  });
  let edges: [number, number][] = [];
  const edgeSeen = new Set<string>();
  for (const [u0, v0] of aisles?.edges ?? []) {
    const u = remap.get(u0), v = remap.get(v0);
    if (u == null || v == null || u === v) continue;
    const a = keep[u], b = keep[v];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < eps) continue;
    const key = u < v ? `${u}-${v}` : `${v}-${u}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    edges.push([u, v]);
  }
  // Zwischenknoten auf einer geraden Linie zusammenziehen. Das ändert keine
  // Meter, nur die Zahl der Klicks und die Lesbarkeit des Netzes.
  const alive = keep.map(() => true);
  for (let guard = 0; guard < keep.length * 2; guard++) {
    const adj: number[][] = keep.map(() => []);
    for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u); }
    let changed = false;
    for (let i = 0; i < keep.length; i++) {
      if (!alive[i] || adj[i].length !== 2) continue;
      const [a, b] = adj[i];
      if (!alive[a] || !alive[b] || a === b) continue;
      const pa = keep[a], pi = keep[i], pb = keep[b];
      const cross = (pi[0] - pa[0]) * (pb[1] - pi[1]) - (pi[1] - pa[1]) * (pb[0] - pi[0]);
      const scale = Math.max(1, Math.hypot(pa[0] - pi[0], pa[1] - pi[1]) + Math.hypot(pi[0] - pb[0], pi[1] - pb[1]));
      if (Math.abs(cross) > 1e-7 * scale) continue;
      const between = (pi[0] - pa[0]) * (pb[0] - pi[0]) + (pi[1] - pa[1]) * (pb[1] - pi[1]) >= -eps;
      if (!between) continue;
      edges = edges.filter(([u, v]) => !((u === i && v === a) || (v === i && u === a)
        || (u === i && v === b) || (v === i && u === b)));
      const exists = edges.some(([u, v]) => (u === a && v === b) || (u === b && v === a));
      if (!exists) edges.push([a, b]);
      alive[i] = false;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  const used = new Set<number>();
  for (const [u, v] of edges) { used.add(u); used.add(v); }
  const finalRemap = new Map<number, number>();
  const nodes: Pt[] = [];
  keep.forEach((p, i) => {
    if (!alive[i] || !used.has(i)) return;
    finalRemap.set(i, nodes.length);
    nodes.push(p);
  });
  return {
    ...aisles,
    nodes,
    edges: edges.map(([u, v]) => [finalRemap.get(u)!, finalRemap.get(v)!] as [number, number])
      .filter(([u, v]) => u !== v),
  };
}

/** Vorschlag: das Gangnetz samt einem Weg von p ans Netz, um Hindernisse herum.
 *  Wie gimel/core/pathfind.py::connect_station. Nichts wird gespeichert. */
export function proposeConnection(aisles: Aisles, p: Pt, finder: Pathfinder, candidates = PF_MAX_CANDIDATES): Aisles | null {
  const nodes0 = aisles?.nodes ?? [];
  if (!nodes0.length) return null;
  type C = { d: number; kind: number; q: Pt; node: number; edge: [number, number] | null };
  const cands: C[] = nodes0.map((q, i) => ({ d: Math.hypot(p[0] - q[0], p[1] - q[1]), kind: 0, q, node: i, edge: null }));
  for (const [i, j] of aisles.edges ?? []) {
    if (!nodes0[i] || !nodes0[j] || i === j) continue;
    const { q, t } = projectOnSegment(p, nodes0[i], nodes0[j]);
    if (t > 0 && t < 1) cands.push({ d: Math.hypot(p[0] - q[0], p[1] - q[1]), kind: 1, q, node: -1, edge: [i, j] });
  }
  cands.sort((u, v) => u.d - v.d || u.kind - v.kind);
  if (cands[0].d < 1e-9) return { ...aisles, nodes: [...nodes0], edges: [...aisles.edges] };
  let best: { len: number; way: Pt[]; node: number; edge: [number, number] | null } | null = null;
  for (const c of cands.slice(0, candidates)) {
    const way = finder.path(p, c.q);
    if (!way) continue;
    const len = polylineLength(way);
    if (!best || len < best.len - 1e-12) best = { len, way, node: c.node, edge: c.edge };
  }
  if (!best) return null;
  const way = simplifyPolyline(best.way);
  const nodes = [...nodes0];
  let edges = [...aisles.edges];
  let target = best.node;
  if (best.edge) {
    const [i, j] = best.edge;
    nodes.push(way[way.length - 1]);
    target = nodes.length - 1;
    edges = edges.filter(([u, v]) => !((u === i && v === j) || (u === j && v === i)));
    edges.push([i, target], [target, j]);
  }
  let prevIdx = target;
  for (const q of way.slice(0, -1).reverse()) {
    nodes.push(q);
    edges.push([prevIdx, nodes.length - 1]);
    prevIdx = nodes.length - 1;
  }
  return { ...aisles, nodes, edges };
}

// ---------------------------------------------------------------- Vorlagen
/** Fertige Hallenformen — der schnellste Weg von „nichts" zu „etwas". */
export function templateRect(w: number, h: number): [number, number][] {
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

export function templateL(w: number, h: number, cutW: number, cutH: number): [number, number][] {
  const cw = Math.min(cutW, w - 1);
  const ch = Math.min(cutH, h - 1);
  return [[0, 0], [w, 0], [w, h - ch], [w - cw, h - ch], [w - cw, h], [0, h]];
}

export function templateU(w: number, h: number, notchW: number, notchH: number): [number, number][] {
  const nw = Math.min(notchW, w - 2);
  const nh = Math.min(notchH, h - 1);
  const x0 = (w - nw) / 2;
  return [[0, 0], [w, 0], [w, h], [x0 + nw, h], [x0 + nw, h - nh], [x0, h - nh], [x0, h], [0, h]];
}

/** Ein Gangnetz aus dem Umriss ableiten — Mittelachse längs, Stichgänge quer.
 *
 *  Ein Vorschlag, kein Ersatz für das Zeichnen: er trifft die Hauptachse einer
 *  rechteckigen Halle gut und eine verwinkelte gar nicht. Deshalb kommt er als
 *  Entwurf in den Editor und nicht direkt in die Datenbank. */
export function suggestAisles(outline: [number, number][], spacing = 10): Aisles {
  if (outline.length < 3) return { nodes: [], edges: [] };
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const midY = (y0 + y1) / 2;
  const nodes: [number, number][] = [];
  const edges: [number, number][] = [];
  const steps = Math.max(1, Math.round((x1 - x0) / spacing));
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    nodes.push([Math.round(x * 4) / 4, Math.round(midY * 4) / 4]);
    if (i > 0) edges.push([i - 1, i]);
  }
  return { nodes, edges };
}


// ---------------------------------------------------------------- Arbeitsvorrat
/* Die Abarbeitungsliste — dieselbe Sache für Regal, Maschine, Packtisch und
   Schreibtisch. Vier Arbeitsarten, jede an ihrem Stationstyp; die Reihenfolge
   trägt ihre Begründung mit, weil eine Regel, deren Entscheidung man nicht
   nachlesen kann, beim ersten Zweifel abgeschaltet wird. */
export type TaskKind = "pick" | "cut" | "pack" | "process";

export const KIND_LABEL: Record<TaskKind, string> = {
  pick: "Kommissionieren",
  cut: "Schneiden",
  pack: "Packen",
  process: "Auftragsbearbeitung",
};

export const KIND_STATION_TYPE: Record<TaskKind, StationType> = {
  pick: "warehouse",
  cut: "production",
  pack: "shipping",
  process: "accounting",
};

export const KIND_ICON: Record<TaskKind, IconName> = {
  pick: "box",
  cut: "cut",
  pack: "truck",
  process: "form",
};

export const ALL_KINDS: TaskKind[] = ["process", "pick", "cut", "pack"];

export const TASK_STATE_LABEL: Record<string, { label: string; intent: "none" | "primary" | "success" | "warning" | "danger" }> = {
  waiting: { label: "wartet", intent: "none" },
  ready: { label: "bereit", intent: "none" },
  running: { label: "läuft", intent: "primary" },
  done: { label: "fertig", intent: "success" },
  cancelled: { label: "entfallen", intent: "danger" },
};

export interface PriorityFactor {
  key: string;
  label: string;
  points: number;
  max: number;
  share: number;
  reason: string;
}

export interface TaskPriority {
  score: number;
  overdue: boolean;
  summary: string;
  factors: PriorityFactor[];
}

export interface WorkSlot {
  seq: number;
  kind: TaskKind;
  ref: string;
  label: string;
  mat: string;
  mat_name: string;
  thk: number;
  units: number;
  n_parts: number;
  n_plates: number;
  rush: boolean;
  started: boolean;
  orders: string[];
  customers: string[];
  start_min: number | null;
  finish_min: number | null;
  changeover: boolean;
  slack_min: number | null;
  late: boolean;
  /** Arbeitstag, in den diese Aufgabe fällt — aus der Tageskapazität. 1 = heute. */
  day?: number;
  reason: string;
  priority: TaskPriority;
  // Nur in /stations/{id}/worklist — dort hängt die Zeile an einer Aufgabe.
  task_id?: number;
  state?: string;
  pinned?: boolean;
  assign_mode?: string;
  assign_reason?: string;
  to_station_id?: number | null;
  note?: string;
}

export interface StationSchedule {
  station_id: number | null;
  label: string;
  times_known: boolean;
  changeovers: number;
  changeovers_edd: number;
  changeovers_saved: number;
  changeover_min_saved: number;
  total_min: number;
  late: string[];
  /** Was jetzt aufgespannt ist. */
  setup_mat: string;
  setup_name: string;
  setup_thk: number;
  /** Was nach dieser Liste aufgespannt sein wird — nicht dasselbe. */
  setup_end_mat: string;
  setup_end_name: string;
  setup_end_thk: number;
  slots: WorkSlot[];
  capacity_min_per_day?: number;
  days?: number | null;
}

export interface WorklistStation {
  id: number;
  label: string;
  type: StationType;
  subtype: string;
  machine_kind: MachineKind;
  colour: string;
  active: boolean;
  routing: StationRouting;
  is_storage: boolean;
  materials: string[];
  thicknesses: number[];
  capacity_min_per_day: number;
  task_min: number;
  unit_min: number;
  queue_min: number;
  last_mat: string;
  last_thk: number;
  schedule: StationSchedule;
}

export interface StationOption {
  station_id: number;
  label: string;
  routing: StationRouting;
  eligible: boolean;
  blockers: string[];
  minutes: number | null;
  transport_min: number;
  queue_min: number;
  finish_min: number | null;
  changeover: boolean;
  route_m: number;
  route_exact: boolean;
  reason: string;
}

export interface PoolRow {
  /** Die Zeile im Arbeitsvorrat — der Griff für Zuordnen und Fertigmelden. */
  task_id: number | null;
  kind: TaskKind;
  ref: string;
  label: string;
  mat: string;
  mat_name: string;
  thk: number;
  units: number;
  rush: boolean;
  due_in_h: number | null;
  waiting_h: number;
  orders: string[];
  customers: string[];
  note: string;
  priority: TaskPriority;
  suggest_station_id: number | null;
  suggest_label: string;
  suggest_reason: string;
  options: StationOption[];
}

export interface KindCount {
  label: string;
  station_type: StationType;
  open: number;
  unassigned: number;
  running: number;
  plates_open?: number;
  plates_staged?: number;
  materials_short?: number;
}

export interface PickMaterial {
  mat: string;
  mat_name: string;
  thk: number;
  /** Platten, die noch aus dem Regal geholt werden müssen. */
  plates: number;
  /** Bereits bereitgestellte Platten — Innenauftrag steht an der Maschine. */
  plates_staged?: number;
  jobs: string[];
  staged_jobs?: string[];
  stations: string[];
  stock: number;
  lead_days: number;
  short: boolean;
  locations?: StockLocationRow[];
  located?: number;
}

/** Frisch bereitgestellte Kommissionierung — bleibt zehn Minuten sichtbar. */
export interface PickRecentRow {
  task_id: number;
  ref: string;
  label: string;
  mat: string;
  mat_name: string;
  thk: number;
  units: number;
  station_id: number | null;
  station_label: string;
  done_at: string;
  done_by: string;
  minutes_left: number;
}

export interface WorklistData {
  kinds: Record<string, KindCount>;
  stations: WorklistStation[];
  pool: PoolRow[];
  auto_routing: boolean;
  policy: {
    window_h: number;
    safety_min: number;
    weights: Record<string, number>;
  };
  /** Nur bei /api/factory/picking. */
  materials?: PickMaterial[];
  /** Nur bei /api/factory/picking: in den letzten 10 Minuten bereitgestellt. */
  recent?: PickRecentRow[];
}

export interface Placement {
  kind: TaskKind;
  ref: string;
  label: string;
  mat: string;
  mat_name: string;
  thk: number;
  units: number;
  rush: boolean;
  orders: string[];
  station_id: number | null;
  station_label: string;
  mode: "auto" | "suggest" | "none";
  reason: string;
  priority: TaskPriority;
  options: StationOption[];
}

/** Minuten ab jetzt als Uhrzeit — „fertig um 14:20", nicht „in 137 min".
 *  Der Werker plant nach der Uhr an der Wand, nicht nach einer Stoppuhr. */
export function clockIn(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  const d = new Date(Date.now() + minutes * 60_000);
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/** Wie dringend eine Aufgabe aussieht — dieselbe Farbe überall. */
export function priorityIntent(p: TaskPriority): "danger" | "warning" | "primary" | "none" {
  if (p.overdue) return "danger";
  if (p.score >= 60) return "warning";
  if (p.score >= 30) return "primary";
  return "none";
}

export function fmtSlack(min: number | null | undefined): string {
  if (min == null) return "—";
  const h = min / 60;
  if (Math.abs(h) >= 24) return days(h / 24);
  if (Math.abs(h) >= 1) return `${h.toLocaleString("de-DE", { maximumFractionDigits: 1 })} h`;
  return `${Math.round(min)} min`;
}
