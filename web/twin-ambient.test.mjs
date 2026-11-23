// Belebung und Beschriftungs-Entzerrung (task 37): node twin-ambient.test.mjs
// Reine Module ohne Browser: Bedienplätze nur an laufenden Stationen und frei
// von Körpern, Teile und Stapler auf ihren Wegen, Feuerlöscher an Stützen,
// Beschriftungen nach Priorität ganz / kompakt / aus.
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * from "./src/components/twin/ambient.ts";
      export * from "./src/components/twin/labelLayout.ts";
      export { buildTwinWorld } from "./src/components/twin/collision.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const floor = {
  id: 1, name: "Halle", outline: [[0, 0], [40, 0], [40, 20], [0, 20]], zones: [], doors: [],
  obstacles: [{ name: "Stütze", points: [[9.7, 9.7], [10.3, 9.7], [10.3, 10.3], [9.7, 10.3]] },
    { name: "Stütze", points: [[29.7, 9.7], [30.3, 9.7], [30.3, 10.3], [29.7, 10.3]] }],
  aisles: { nodes: [], edges: [] }, scale: 40, grid: 1, snap: 0.25, bg: "",
};
const st = (id, x, y, w, h, rotation = 0, extra = {}) => ({
  id, label: `S${id}`, type: "production", subtype: "", x, y, w, h, rotation, colour: "#106ba3",
  active: true, is_storage: false, model_file: "", machine_kind: "plotter", ...extra,
});
const stations = [st(1, 6, 5, 5, 3), st(2, 20, 5, 4, 3, 90), st(3, 33, 15, 4, 3), st(4, 20, 16, 3, 2)];
const world = m.buildTwinWorld(floor, stations);
const amb = stations.map((s) => ({ ...s, running: s.id !== 4 }));

// --- Bedienplätze ---------------------------------------------------------
const spots = m.operatorSpots(amb, world);
assert.equal(spots.length, 3, "eine Figur je laufender Station");
assert.ok(!spots.some((p) => p.stationId === 4), "keine Figur an einer Station, die nicht läuft");
for (const p of spots) {
  assert.equal(world.query({ kind: "circle", x: p.x, y: p.y, r: 0.3 }, { groups: ["station", "obstacle", "wall"] }).length, 0,
    `Figur an S${p.stationId} steht frei`);
}
const front = spots.find((p) => p.stationId === 1);
assert.ok(Math.abs(front.x - 6) < 1e-6 && front.y > 6.5 && front.y < 7.5, "ungedreht: Figur vorn (+y)");
const turned = spots.find((p) => p.stationId === 2);
assert.ok(Math.hypot(turned.x - 20, turned.y - 5) > 1.5, "gedrehte Station: Figur neben dem Körper");
assert.deepEqual(m.operatorSpots(amb, world), spots, "wiederholbar");
// Zugestellte Station: kein freier Platz, keine Figur.
const boxed = [st(10, 5, 5, 2, 2), st(11, 5, 7.6, 4, 2), st(12, 5, 2.4, 4, 2), st(13, 7.6, 5, 2, 4), st(14, 2.4, 5, 2, 4)];
const boxedWorld = m.buildTwinWorld(floor, boxed);
assert.equal(m.operatorSpots([{ ...boxed[0], running: true }], boxedWorld).length, 0, "zugestellt: keine Figur");

// --- Wege -------------------------------------------------------------------
const route = [[0, 0], [10, 0], [10, 10]];
assert.equal(m.polylineLength(route), 20);
const mid = m.along(route, 15);
assert.ok(Math.abs(mid.x - 10) < 1e-9 && Math.abs(mid.y - 5) < 1e-9, "along: Punkt auf dem zweiten Stück");
assert.ok(Math.abs(mid.heading - -Math.PI / 2) < 1e-9, "along: Richtung nach +y ist −90° um die Hochachse");
assert.equal(m.parcelCount(0, 10), 0);
assert.equal(m.parcelCount(10, 10), 4);
assert.equal(m.parcelCount(1, 10), 1);
const a = m.parcelAt(route, 3, 0, 2), b = m.parcelAt(route, 3, 1, 2);
assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 5, "Teile verteilt");
for (let t = 0; t < 120; t += 0.7) {
  const p = m.shuttle(route, t);
  const d = Math.min(...[[0, 0], [10, 10]].map(([x, y]) => Math.hypot(p.x - x, p.y - y)));
  assert.ok(d >= 1.6 - 1e-6, `Stapler hält Abstand zu den Enden (t=${t.toFixed(1)})`);
}
const out1 = m.shuttle(route, 1), back = m.shuttle(route, 20);
assert.equal(out1.loaded, true, "Hinweg beladen");
assert.equal(back.loaded, false, "Rückweg leer");

// --- Feuerlöscher -----------------------------------------------------------
const ext = m.extinguisherSpots(floor.obstacles.map((o) => o.points), [20, 10]);
assert.equal(ext.length, 1, "an jeder zweiten Stütze");
assert.ok(ext[0].x > 10.3, "auf der Seite zur Hallenmitte");

// --- Beschriftungen ---------------------------------------------------------
const L = (id, cx, cy, priority, headH = 13) => ({ id, cx, cy, w: 120, h: 28, headH, priority });
const fit = m.layoutLabels([L("a", 100, 100, 60), L("b", 110, 104, 50), L("c", 400, 100, 20), L("d", 105, 100, 100)]);
assert.equal(fit.get("d"), "full", "Auswahl immer ganz");
assert.equal(fit.get("c"), "full", "freie Beschriftung ganz");
assert.notEqual(fit.get("b"), "full", "überdeckte weniger wichtige nicht ganz");
const stack = m.layoutLabels([L("top", 100, 100, 60), L("below", 100, 128, 50)]);
assert.equal(stack.get("below"), "compact", "knapp darunter: nur der Name");
assert.ok(m.labelPriority("three-station-label", 60) > m.labelPriority("three-station-label", 0), "dringend vor ruhig");
assert.ok(m.labelPriority("three-station-label") > m.labelPriority("three-door-label"), "Station vor Tor");
assert.ok(m.labelPriority("three-station-label three-station-label-selected") >= m.ALWAYS_SHOW, "Auswahl nie aus");

console.log("Twin ambient checks passed: operator spots, parcels, forklift shuttle, extinguishers, label layout.");
