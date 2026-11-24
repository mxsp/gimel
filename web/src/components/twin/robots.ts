import type { Robot } from "../../factory";

/* Wo ein Roboter zwischen zwei Abrufen steht.

   Der Server schickt den Stand zum Zeitpunkt ``sampled_at``. Die Ansicht
   rechnet von dort mit der Geschwindigkeit weiter, damit die Bewegung flüssig
   bleibt und nicht im Takt des 30-Sekunden-Abrufs springt. Dieselbe Rechnung
   steht in ``gimel/core/robot.py``; beide arbeiten im Grundriss-Koordinaten-
   system (x nach Osten, y nach Süden). */

export interface RobotPose {
  x: number;
  y: number;
  /** null = Richtung unbekannt; nicht 0° erfinden. */
  heading_deg: number | null;
}

type Point = [number, number];

function validRoute(route: Point[]): Point[] {
  return (route ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

function segments(route: Point[], loop: boolean): [Point, Point, number][] {
  const out: [Point, Point, number][] = [];
  for (let i = 0; i + 1 < route.length; i++) {
    out.push([route[i], route[i + 1], Math.hypot(route[i + 1][0] - route[i][0], route[i + 1][1] - route[i][1])]);
  }
  if (loop && route.length >= 2) {
    const a = route[route.length - 1], b = route[0];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > 1e-9) out.push([a, b, length]);
  }
  return out;
}

export function pathPose(route: Point[], distance: number, loop: boolean): RobotPose | null {
  const points = validRoute(route);
  if (points.length < 2) return null;
  const parts = segments(points, loop);
  const total = parts.reduce((sum, [, , length]) => sum + length, 0);
  if (total <= 1e-9) return { x: points[0][0], y: points[0][1], heading_deg: 0 };

  let reverse = false;
  let d = distance;
  if (loop) {
    d = ((d % total) + total) % total;
  } else {
    const period = total * 2;
    d = ((d % period) + period) % period;
    if (d > total) { reverse = true; d = period - d; }
  }

  let run = 0;
  for (const [a, b, length] of parts) {
    if (length <= 1e-9) continue;
    if (run + length >= d - 1e-9) {
      const u = Math.max(0, Math.min(1, (d - run) / length));
      const heading = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI + (reverse ? 180 : 0);
      return {
        x: a[0] + (b[0] - a[0]) * u,
        y: a[1] + (b[1] - a[1]) * u,
        heading_deg: ((heading % 360) + 360) % 360,
      };
    }
    run += length;
  }
  const end = points[points.length - 1];
  return { x: end[0], y: end[1], heading_deg: 0 };
}

type SimPlan = NonNullable<Robot["sim_plan"]>;

/** Gefahrene Strecke laut Fahrplan zur Zeit `t` (s seit Epoche) — wie `core.robot_traffic.distance_at`. */
export function planDistance(plan: SimPlan, t: number): number {
  const keys = plan.keys;
  if (!keys.length) return 0;
  if (!(plan.period_s > 0) || keys.length === 1) return keys[0][1];
  const u = ((t % plan.period_s) + plan.period_s) % plan.period_s;
  let lo = 0, hi = keys.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid][0] <= u) lo = mid; else hi = mid;
  }
  const [t0, s0] = keys[lo], [t1, s1] = keys[hi];
  if (t1 <= t0) return s1;
  return s0 + (s1 - s0) * Math.max(0, Math.min(1, (u - t0) / (t1 - t0)));
}

/** Fährt der Roboter laut Fahrplan gerade (oder wartet er auf Vorfahrt)? */
export function planMoving(plan: SimPlan, t: number): boolean {
  if (plan.parked || !(plan.period_s > 0) || plan.keys.length < 2) return false;
  const u = ((t % plan.period_s) + plan.period_s) % plan.period_s;
  for (let i = 1; i < plan.keys.length; i++) {
    const [t0, s0] = plan.keys[i - 1], [t1, s1] = plan.keys[i];
    if (t0 <= u && u <= t1) return s1 - s0 > 1e-6 && t1 > t0;
  }
  return false;
}

/** Zeit für die Simulation: höchstens zwei Minuten über den letzten Abruf hinaus.
 *  Mit ``receivedAtMs`` (lokaler Empfangszeitpunkt) bleibt die Wiedergabe auch bei
 *  abweichender Systemuhr des Clients synchron zur Serverzeit ``sampledAt``. */
function simClock(sampledAt: string | null | undefined, nowMs: number, receivedAtMs?: number): number {
  const stamp = sampledAt ? Date.parse(sampledAt) : NaN;
  if (Number.isFinite(stamp) && receivedAtMs != null && Number.isFinite(receivedAtMs)) {
    const elapsed = Math.max(0, Math.min(120_000, nowMs - receivedAtMs));
    return stamp + elapsed;
  }
  return Number.isFinite(stamp) ? Math.min(nowMs, stamp + 120_000) : nowMs;
}

/** Fährt ein Roboter jetzt? Mit Fahrplan aus dem Plan, sonst nach seinem Zustand. */
export function robotMovingAt(robot: Robot, sampledAt: string | null | undefined, nowMs: number, receivedAtMs?: number): boolean {
  const plan = robot.simulated ? robot.sim_plan : null;
  if (plan) return planMoving(plan, (simClock(sampledAt, nowMs, receivedAtMs) - Date.parse(plan.epoch)) / 1000);
  return robot.state === "moving";
}

export function robotPoseAt(robot: Robot, sampledAt: string | null | undefined, nowMs: number, receivedAtMs?: number): RobotPose | null {
  const plan = robot.simulated ? robot.sim_plan : null;
  if (plan && Array.isArray(robot.route) && robot.route.length >= 2 && Number.isFinite(Date.parse(plan.epoch))) {
    // Derselbe Fahrplan wie auf dem Server: Vorfahrt, Warten an sicheren Halten.
    const t = (simClock(sampledAt, nowMs, receivedAtMs) - Date.parse(plan.epoch)) / 1000;
    return pathPose(robot.route, planDistance(plan, t), robot.route_mode === "loop");
  }
  if (robot.simulated && Array.isArray(robot.route) && robot.route.length >= 2) {
    const stamp = sampledAt ? Date.parse(sampledAt) : NaN;
    const anchor = receivedAtMs != null && Number.isFinite(receivedAtMs) ? receivedAtMs : stamp;
    const elapsed = Number.isFinite(anchor) ? Math.max(0, (nowMs - anchor) / 1000) : 0;
    // Nicht endlos extrapolieren: nach zwei Minuten ohne neue Meldung bleibt
    // der letzte Stand stehen, statt eine Position zu erfinden.
    const safeElapsed = Math.min(120, elapsed);
    return pathPose(robot.route, (robot.progress_m || 0) + safeElapsed * Math.max(0, robot.speed_m_s || 0),
      robot.route_mode === "loop");
  }
  if (robot.x != null && robot.y != null) {
    return { x: robot.x, y: robot.y, heading_deg: robot.heading_deg ?? null };
  }
  return null;
}
