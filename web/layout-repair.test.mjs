// Kollisionsfreie Demo-Anordnung: node layout-repair.test.mjs
// Prüft das reine Reparaturwerkzeug aus layoutRepair.ts ohne Browser:
// Stationen weichen Hindernissen aus, Gangknoten und Routen liegen frei,
// und die übergebenen Daten bleiben unverändert.
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * from "./src/components/twin/layoutRepair.ts";
      export * from "./src/components/twin/collision.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const m = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
);

const outline = [[0, 0], [40, 0], [40, 30], [0, 30]];
const floor = {
  id: 1, name: "Testhalle", outline, zones: [], doors: [], height_m: 6,
  obstacles: [{ name: "Stütze", points: [[19.7, 14.7], [20.3, 14.7], [20.3, 15.3], [19.7, 15.3]] }],
  aisles: { nodes: [[6, 16], [20, 16], [20, 15], [32, 16]], edges: [[0, 1], [1, 2], [2, 3]], paths: [] },
};
const station = (id, label, x, y, w, h) => ({
  id, label, x, y, w, h, rotation: 0, type: "production", active: true,
});
const stations = [
  station(1, "Plattenregal", 6, 16, 4, 22), // Gangknoten 0 liegt im Regal
  station(2, "Stanze", 20, 14, 4, 3),       // steht auf der Stütze
  station(3, "Packtisch", 20, 18, 4, 3),    // überlappt die Stanze
];
const robots = [{ id: 1, name: "AGV 1", route: [[20, 15], [32, 16]] }];
const jobs = [{ id: 1, route: [[20, 15], [6, 16]] }];

const before = m.layoutIsClear(floor, stations);
assert.equal(before, false, "Testanordnung ist absichtlich nicht frei");

const snapshot = JSON.stringify({ floor, stations, robots, jobs });
const repaired = m.repairLayout({ floor, stations, robots, jobs, laneRadius: 1.1 });
assert.equal(JSON.stringify({ floor, stations, robots, jobs }), snapshot,
  "Eingaben werden nicht verändert");

const world = m.buildTwinWorld({ ...floor, aisles: repaired.aisles }, repaired.stations);
const nodes = repaired.aisles.nodes;
for (const [x, y] of nodes) {
  assert.equal(world.query({ kind: "circle", x, y, r: 1.1 },
    { groups: ["station", "obstacle"] }).length, 0, `Gangknoten ${x}/${y} liegt frei`);
}
for (const r of repaired.robots) {
  for (const [x, y] of r.route) {
    assert.equal(world.query({ kind: "circle", x, y, r: m.ROBOT_RADIUS_M },
      { groups: ["station", "obstacle"] }).length, 0, `Route ${r.name} liegt frei`);
  }
}
assert.equal(m.layoutCollisions(world, repaired.stations).collisions.length, 0,
  "Stationen stehen frei");
assert.equal(m.layoutIsClear({ ...floor, aisles: repaired.aisles }, repaired.stations), true,
  "Anordnung ist vollständig frei");
assert.ok(repaired.movedStations >= 1, "mindestens eine Station wurde verschoben");
assert.ok(repaired.movedNodes >= 1, "mindestens ein Gangknoten wurde verschoben");
assert.ok(repaired.movedRoutePoints >= 1, "mindestens ein Routenpunkt wurde verschoben");

// Ein bereits freier Punkt bleibt, wo er ist.
const free = m.nearestFreePoint([30, 25], world, 0.8, outline);
assert.deepEqual(free, [30, 25], "freier Punkt bleibt stehen");

console.log("Layout repair checks passed: bodies, aisles and routes end up collision-free.");
