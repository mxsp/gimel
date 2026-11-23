// Pure Kollisionslogik: node collision.test.mjs
// Lädt das TS-Modul einmal mit esbuild (schon als Vite-Abhängigkeit da) und
// prüft Formen, Broadphase, Grundrisskonflikte und Roboter-Lage ohne Browser.
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/components/twin/collision.ts"],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const code = Buffer.from(out.outputFiles[0].text).toString("base64");
const m = await import(`data:text/javascript;base64,${code}`);
const {
  pointInPolygon, shapesOverlap, segmentHitsPolygon, outsideOutline,
  buildTwinWorld, layoutCollisions, robotCollisionReport, CollisionWorld,
  clearPolyline, clearWays, boxPolygon, ROBOT_RADIUS_M,
} = m;

// Die Geräte passen nach dem Neuaufbau in ihre Stationsfläche. Ein gemeinsamer
// Bundle hält deviceModels und THREE in derselben Instanz.
const devices = await build({
  stdin: {
    contents: `export * from "./src/components/twin/deviceModels.ts"; export { Box3 } from "three";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const dm = await import(`data:text/javascript;base64,${Buffer.from(devices.outputFiles[0].text).toString("base64")}`);

const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
const circle = (x, y, r = 0.7) => ({ kind: "circle", x, y, r });
const polygon = (points) => ({ kind: "polygon", points });
const segment = (a, b, r = 0) => ({ kind: "segment", a, b, r });

// --- Formen -----------------------------------------------------------------
assert.equal(pointInPolygon([5, 5], square), true, "Punkt im Polygon");
assert.equal(pointInPolygon([11, 5], square), false, "Punkt daneben");
assert.equal(shapesOverlap(circle(5, 5), polygon(square)), true, "Kreis im Polygon");
assert.equal(shapesOverlap(circle(12, 5), polygon(square)), false, "Kreis weit weg");
assert.equal(shapesOverlap(circle(10.4, 5), polygon(square)), true, "Kreis berührt Kante");
assert.equal(shapesOverlap(circle(5, 5, 1), circle(6.2, 5, 1)), true, "zwei Kreise");
assert.equal(shapesOverlap(circle(5, 5, 1), circle(9, 5, 1)), false, "zwei Kreise getrennt");
assert.equal(shapesOverlap(polygon([[0, 0], [2, 0], [2, 2], [0, 2]]), polygon([[1, 1], [3, 1], [3, 3], [1, 3]])), true, "überlappende Flächen");
assert.equal(shapesOverlap(polygon([[0, 0], [2, 0], [2, 2], [0, 2]]), polygon([[5, 5], [6, 5], [6, 6], [5, 6]])), false, "getrennte Flächen");
assert.equal(segmentHitsPolygon([-1, 5], [11, 5], square), true, "Strecke durch Polygon");
assert.equal(segmentHitsPolygon([-5, 15], [-4, 15], square), false, "Strecke daneben");
assert.equal(segmentHitsPolygon([-1, 10.5], [11, 10.5], square, 0.7), true, "Strecke mit Radius an der Kante");
assert.equal(shapesOverlap(segment([-1, 5], [11, 5], 0.1), polygon(square)), true, "Strecke gegen Körper");
assert.equal(outsideOutline([5, 5], square), false, "innen");
assert.equal(outsideOutline([12, 5], square), true, "außen");
assert.equal(boxPolygon(0, 0, 2, 2, 90).length, 4, "gedrehte Box bleibt ein Viereck");

// --- Welt und Grundriss -----------------------------------------------------
const station = (id, x, y, w = 2, h = 2, label = `S${id}`) => ({
  id, label, type: "production", x, y, w, h, rotation: 0, colour: "#123", active: true,
});
const floor = {
  outline: [[0, 0], [30, 0], [30, 20], [0, 20]],
  obstacles: [{ name: "Stütze", points: [[14, 9], [15, 9], [15, 10], [14, 10]] }],
  zones: [{ name: "Fertigung", colour: "#abc", points: [[0, 0], [30, 0], [30, 20], [0, 20]] }],
  doors: [], aisles: { nodes: [], edges: [] },
};
const world = buildTwinWorld(floor, [station(1, 2, 2), station(2, 2.5, 2), station(3, 14.5, 9.5)]);
assert.ok(world.colliders.some((c) => c.group === "zone" && c.passive), "Zonen sind passiv");
assert.equal(world.query(circle(2, 2), { groups: ["zone"] }).length, 0, "passive Körper kollidieren nie");
const layout = layoutCollisions(world, [station(1, 2, 2), station(2, 2.5, 2), station(3, 14.5, 9.5)]);
assert.ok(layout.collidingStationIds.includes(1) && layout.collidingStationIds.includes(2), "Station 1/2 überlappen");
assert.ok(layout.collidingStationIds.includes(3), "Station 3 steht auf dem Hindernis");

// --- Roboter, Routen, Hallengrenze -----------------------------------------
const robot = (id, x, y, extra = {}) => ({
  id, name: `AGV ${id}`, kind: "agv", floor_id: 1, active: true, state: "moving",
  simulated: true, route: [[x, y]], route_mode: "loop", route_m: 0, speed_m_s: 1,
  progress_m: 0, x, y, heading_deg: 0, battery_pct: 80, payload_kg: 0,
  capabilities: [], gateway_id: "sim", ...extra,
});
const job = (id, robotId, route) => ({
  id, ref: `T-${id}`, kind: "transfer", state: "running", robot_id: robotId,
  robot_name: `AGV ${robotId}`, floor_id: 1, route, route_m: 0, route_exact: true,
  route_note: "", eta_s: 0, priority: 0,
});
const poseOf = (r) => (r.x == null ? null : { x: r.x, y: r.y, heading_deg: r.heading_deg });

const clean = robotCollisionReport({
  world: buildTwinWorld(floor, [station(1, 2, 2)]), floor,
  robots: [robot(1, 8, 8)], jobs: [], poseOf, stations: [station(1, 2, 2)],
});
assert.equal(clean.collisions.length, 0, "freie Fahrt ohne Kollision");

const messy = robotCollisionReport({
  world: buildTwinWorld(floor, [station(1, 2, 2)]), floor,
  robots: [robot(1, 14.5, 9.5), robot(2, 15, 9.5), robot(3, 35, 10), robot(4, 2, 2)],
  jobs: [job(9, 1, [[8, 8], [18, 8]]), job(10, 3, [[28, 10], [35, 10]])],
  poseOf, stations: [station(1, 2, 2)],
});
const groups = new Set(messy.collisions.map((c) => c.group));
assert.ok(groups.has("obstacle"), "Roboter auf der Stütze");
assert.ok(groups.has("robot"), "zwei Roboter zu nah");
assert.ok(groups.has("wall"), "Roboter außerhalb der Halle");
assert.ok(groups.has("station"), "Roboter an der Station (Warnung)");
assert.ok(groups.has("route"), "Route durch die Stütze");
assert.ok(messy.riskySegments.length >= 1, "gefährliche Wegstücke gemeldet");
assert.ok(messy.collisions.filter((c) => c.group === "station").every((c) => c.severity === "warning"),
  "Stationsberührung ist eine Warnung, kein Alarm");
assert.ok(messy.collisions.filter((c) => c.group === "obstacle").every((c) => c.severity === "danger"),
  "Hindernis ist ein Alarm");
assert.ok(messy.byRobot[1].length > 0 && messy.byRobot[3].length > 0, "Zuordnung je Roboter");
assert.ok(ROBOT_RADIUS_M > 0.5 && ROBOT_RADIUS_M < 1, "Fahrzeugradius im Maßstab des Modells");

// Ausschluss und Gruppenfilter der allgemeinen Abfrage.
const onlyWalls = new CollisionWorld(world.colliders).query(circle(0.3, 5, 0.6), { groups: ["wall"] });
assert.ok(onlyWalls.length > 0 && onlyWalls.every((c) => c.group === "wall"), "Gruppenfilter");

// --- Wegfreiräume: ein Weg darf nicht durch einen Körper laufen --------------
const barrier = [[10, 0], [12, 0], [12, 20], [10, 20]];
const barrierWorld = new CollisionWorld([{ id: "o:1", label: "Regal", group: "obstacle",
  shape: { kind: "polygon", points: barrier } }]);
const across = [[8, 10], [14, 10]];
const runs = clearPolyline(across, barrierWorld, { radius: 0.35, step: 0.25 });
assert.ok(runs.length >= 2, "Weg wird an der Regalkante getrennt");
for (const run of runs) {
  assert.ok(!segmentHitsPolygon(run[0], run[run.length - 1], barrier),
    "kein freier Abschnitt läuft durch das Regal");
}
const freeWay = clearPolyline([[0, 5], [8, 5]], barrierWorld, { radius: 0.35, step: 0.25 });
assert.equal(freeWay.length, 1, "freier Weg bleibt am Stück");
const kept = clearWays([{ points: across, kind: "edge" }, { points: [[0, 5], [8, 5]], kind: "path" }],
  barrierWorld, { radius: 0.35, step: 0.25 });
assert.ok(kept.length >= 3 && kept.every((w) => w.kind), "clearWays behält die Wegart");

// --- Geräte bleiben in ihrer Stationsfläche ---------------------------------
for (const kind of ["plotter", "waterjet", "punch", "manual"]) {
  for (const [w, h] of [[3, 2], [6, 4], [4, 22]]) {
    const model = dm.buildDeviceModel({
      label: "Test", type: "production", machine_kind: kind, w, h, rotation: 0,
      colour: "#106ba3", active: true, is_storage: false, model_file: "",
    });
    const box = new dm.Box3().setFromObject(model);
    const spanX = box.max.x - box.min.x, spanZ = box.max.z - box.min.z;
    assert.ok(spanX <= w + 1e-6 && spanZ <= h + 1e-6,
      `${kind} ${w}×${h}: Modell ragt heraus (${spanX.toFixed(2)}×${spanZ.toFixed(2)})`);
    assert.ok(box.min.y >= -1e-6, `${kind} steht auf dem Boden`);
  }
}
assert.ok(dm.FOOTPRINT_MARGIN_M > 0, "Passung hat einen Rand");

console.log("Collision checks passed: shapes, broadphase, layout, robots, routes, walls, cleared ways, fitted models.");
