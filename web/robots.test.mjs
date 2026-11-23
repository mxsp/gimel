// Run after npm run build: node robots.test.mjs
// Prüft dieselbe Weggeometrie wie tests/core/test_robot.py, ohne Browser.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "gimel-robots-"));
const out = join(dir, "robots.mjs");
try {
  await build({
    entryPoints: ["src/components/twin/robots.ts"],
    bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  });
  const { pathPose, robotPoseAt, planDistance, planMoving, robotMovingAt } = await import(pathToFileURL(out).href);

  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const loop = pathPose(square, 15, true);
  assert.deepEqual([loop.x, loop.y, loop.heading_deg], [10, 5, 90]);
  const closing = pathPose(square, 35, true);
  assert.deepEqual([closing.x, closing.y, closing.heading_deg], [0, 5, 270]);

  const back = pathPose([[0, 0], [10, 0], [20, 0]], 25, false);
  assert.deepEqual([back.x, back.y, back.heading_deg], [15, 0, 180]);

  const start = pathPose([[0, 0], [10, 0]], 40, false);
  assert.deepEqual([start.x, start.y, start.heading_deg], [0, 0, 0]);

  const negative = pathPose([[0, 0], [10, 0]], -5, false);
  assert.deepEqual([negative.x, negative.y, negative.heading_deg], [5, 0, 180]);

  const twoPointLoop = pathPose([[0, 0], [10, 0]], 15, true);
  assert.deepEqual([twoPointLoop.x, twoPointLoop.y, twoPointLoop.heading_deg], [5, 0, 180]);

  const robot = {
    id: 1, name: "AGV", kind: "agv", floor_id: 1, active: true, state: "moving",
    simulated: true, gateway_id: "sim", battery_pct: 80, payload_kg: 100, capabilities: [],
    route: [[0, 0], [10, 0]], route_mode: "pingpong", route_m: 10, speed_m_s: 1,
    progress_m: 0, x: 0, y: 0, heading_deg: 0,
  };
  const at = robotPoseAt(robot, new Date(Date.now() - 1000).toISOString(), Date.now());
  assert.ok(Math.abs(at.x - 1) < 0.05, JSON.stringify(at));

  const unknown = robotPoseAt({ ...robot, simulated: false, x: null, y: null }, null, Date.now());
  assert.equal(unknown, null);

  const noHeading = robotPoseAt({ ...robot, simulated: false, x: 3, y: 4, heading_deg: null }, null, Date.now());
  assert.equal(noHeading.heading_deg, null);

  // Fahrplan (task 37, core/robot_traffic.py): fahren 0–10 s, warten 10–14 s, fahren bis 20 s.
  const plan = { period_s: 20, keys: [[0, 0], [10, 10], [14, 10], [20, 16]], cycle_m: 16, parked: false, note: "",
    epoch: "2026-01-01T00:00:00+00:00" };
  assert.equal(planDistance(plan, 5), 5);
  assert.equal(planDistance(plan, 12), 10, "wartet an seinem Halt");
  assert.equal(planDistance(plan, 17), 13);
  assert.equal(planDistance(plan, 25), 5, "periodisch");
  assert.equal(planMoving(plan, 5), true);
  assert.equal(planMoving(plan, 12), false, "Warten ist kein Fahren");
  const epoch = Date.parse(plan.epoch);
  const planned = { id: 7, name: "AMR", simulated: true, route: [[0, 0], [8, 0]], route_mode: "loop",
    progress_m: 999, speed_m_s: 1, state: "moving", sim_plan: plan };
  const p12 = robotPoseAt(planned, new Date(epoch + 12_000).toISOString(), epoch + 12_000);
  assert.ok(Math.abs(p12.x - 6) < 1e-9 && Math.abs(p12.y) < 1e-9, "Lage folgt dem Plan (10 m auf dem Rundkurs), nicht progress_m");
  assert.equal(robotMovingAt(planned, new Date(epoch + 12_000).toISOString(), epoch + 12_000), false);
  // Ohne neuen Abruf nicht endlos weiterrechnen: nach zwei Minuten bleibt die Lage stehen.
  const stale = robotPoseAt(planned, new Date(epoch).toISOString(), epoch + 600_000);
  const capped = robotPoseAt(planned, new Date(epoch).toISOString(), epoch + 120_000);
  assert.deepEqual([stale.x, stale.y], [capped.x, capped.y]);
  // Ohne Fahrplan gilt die alte Rechnung (ältere Server).
  const old = robotPoseAt({ ...planned, sim_plan: null, progress_m: 3 }, new Date(epoch).toISOString(), epoch);
  assert.deepEqual([old.x, old.y], [3, 0]);

  console.log("Robot path checks passed: loop, pingpong, extrapolation, unknown position.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
