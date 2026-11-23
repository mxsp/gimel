/* Simulation geplanter Roboter — Typen und Abspielen, ohne THREE und React.

   Der Server rechnet die Schicht einmal (gimel/core/fleet_sim.py) und liefert
   je Roboter eine Zeitleiste aus Abschnitten. Hier wird nur abgespielt: wo
   steht ein Roboter zur Simulationszeit t, wohin schaut er, was tut er. */

export type SimState = "leer" | "beladen" | "laden" | "entladen" | "wartet";

export interface SimSegment {
  t0: number;
  t1: number;
  state: Exclude<SimState, "wartet">;
  points: [number, number][];
  demand: string;
}

export interface SimRobotRow {
  id: string;
  name: string;
  kind: string;
  planned: boolean;
  speed_m_s: number;
  start: [number, number];
  jobs: number;
  busy_s: number;
  utilisation: number;
  loaded_m: number;
  empty_m: number;
}

export interface SimSummary {
  horizon_s: number;
  demands: number;
  served: number;
  unserved: number;
  late: number;
  wait_mean_s: number;
  wait_p90_s: number;
  wait_max_s: number;
  loaded_m: number;
  empty_m: number;
  empty_share: number;
  per_hour: number;
  encounters: number;
  hotspots: { x: number; y: number; count: number }[];
  estimated_ways: number;
  robots: SimRobotRow[];
}

export interface SizingRow {
  planned: number;
  served: number;
  unserved: number;
  wait_p90_s: number;
  wait_mean_s: number;
  utilisation: number;
  ok: boolean;
}

export interface SimResult {
  floor_id: number;
  summary: SimSummary;
  tracks: Record<string, SimSegment[]>;
  demands: { id: string; from: number; to: number; release_s: number; kind: string }[];
  stations: Record<string, string>;
  sizing: { target_p90_s: number; rows: SizingRow[]; recommended: number | null } | null;
  notes: string[];
}

export interface PlannedRobot {
  name: string;
  kind: "agv" | "amr";
  speed_m_s: number;
  count: number;
}

export interface SimParams {
  planned: PlannedRobot[];
  per_shift: number;
  load_factor: number;
  horizon_h: number;
  handling_s: number;
  include_existing: boolean;
  wait_target_min: number;
  seed: number;
  sizing: boolean;
  sizing_upto: number;
}

export const DEFAULT_PARAMS: SimParams = {
  planned: [{ name: "AMR", kind: "amr", speed_m_s: 1.2, count: 2 }],
  per_shift: 60,
  load_factor: 1,
  horizon_h: 8,
  handling_s: 60,
  include_existing: false,
  wait_target_min: 10,
  seed: 1,
  sizing: true,
  sizing_upto: 6,
};

export interface SimPose {
  x: number;
  y: number;
  /** Grad wie bei echten Robotern: 0 = Osten, im Grundriss gegen den Uhrzeigersinn nach Süden. */
  heading_deg: number | null;
  state: SimState;
  demand: string;
}

function polyLength(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

function along(points: [number, number][], u: number): { x: number; y: number; heading: number | null } {
  if (points.length === 1) return { x: points[0][0], y: points[0][1], heading: null };
  const total = polyLength(points);
  if (total <= 1e-9) return { x: points[0][0], y: points[0][1], heading: null };
  const target = Math.max(0, Math.min(1, u)) * total;
  let run = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (run + len >= target - 1e-9) {
      const k = len <= 1e-9 ? 0 : (target - run) / len;
      const heading = len <= 1e-9 ? null : ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 360;
      return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, heading };
    }
    run += len;
  }
  const end = points[points.length - 1];
  return { x: end[0], y: end[1], heading: null };
}

function endHeading(pts: [number, number][]): number | null {
  const n = pts.length;
  if (n < 2) return null;
  const a = pts[n - 2], b = pts[n - 1];
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= 1e-9) return null;
  return ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 360;
}

/** Lage zur Simulationszeit ``t`` (O(log n) Binärsuche über sortierte Abschnitte).
    Zwischen Abschnitten wartet der Roboter am letzten Punkt; vor dem ersten
    steht er am Start. Die Richtung bleibt beim Stehen die letzte Fahrtrichtung. */
export function trackPose(track: SimSegment[], t: number, start: [number, number]): SimPose {
  if (!track.length || t < track[0].t0) {
    return { x: start[0], y: start[1], heading_deg: null, state: "wartet", demand: "" };
  }
  // Binärsuche: größter Index lo mit track[lo].t0 <= t
  let lo = 0;
  let hi = track.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track[mid].t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  const seg = track[lo];
  // Vorherige Position/Richtung vom letzten nicht-leeren Abschnitt <= lo - 1 ermitteln
  const prevState = (idx: number): { x: number; y: number; heading: number | null } => {
    for (let k = idx; k >= 0; k--) {
      const pts = track[k].points;
      if (pts.length) {
        const end = pts[pts.length - 1];
        return { x: end[0], y: end[1], heading: endHeading(pts) };
      }
    }
    return { x: start[0], y: start[1], heading: null };
  };

  if (t <= seg.t1) {
    if (!seg.points.length) {
      const prev = prevState(lo - 1);
      return { x: prev.x, y: prev.y, heading_deg: prev.heading, state: seg.state, demand: seg.demand };
    }
    const span = seg.t1 - seg.t0;
    const p = along(seg.points, span <= 0 ? 1 : (t - seg.t0) / span);
    const heading = p.heading ?? prevState(lo - 1).heading;
    return { x: p.x, y: p.y, heading_deg: heading, state: seg.state, demand: seg.demand };
  }
  const done = prevState(lo);
  return { x: done.x, y: done.y, heading_deg: done.heading, state: "wartet", demand: "" };
}

/** Uhrzeit der Schicht ab 06:00, damit „03:12 h" lesbar wird. */
export function fmtSimClock(t: number, horizon: number): string {
  const s = Math.max(0, Math.min(horizon, t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} h`;
}

export function fmtWait(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0 min";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toLocaleString("de-DE", { maximumFractionDigits: 1 })} h`;
}

export const SIM_STATE_WORD: Record<SimState, string> = {
  leer: "Leerfahrt", beladen: "beladen", laden: "lädt", entladen: "entlädt", wartet: "wartet",
};
