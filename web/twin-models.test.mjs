// Gebaute 3D-Geräte (task 37): node twin-models.test.mjs
// Prüft ohne Browser, dass jedes Gerät und jede Lagergestalt in ihre
// Stationsfläche passt, auf dem Boden steht, verschmolzen ist (wenige
// Zeichenaufrufe), eine Fernstufe hat, Bewegung nur an den richtigen Teilen
// trägt und geteilte Materialien nicht vervielfacht.
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * from "./src/components/twin/deviceModels.ts";
      export * as kit from "./src/components/twin/models/kit.ts";
      export * as robot from "./src/components/twin/robotModel.ts";
      export * as belt from "./src/components/twin/models/conveyor.ts";
      export * as cv from "./src/components/twin/conveyor.ts";
      export { buildTwinWorld } from "./src/components/twin/collision.ts";
      export { Box3, LOD, Mesh } from "three";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const station = (over) => ({
  label: "Test", type: "production", machine_kind: "", subtype: "", w: 4, h: 3, rotation: 0,
  colour: "#106ba3", active: true, is_storage: false, model_file: "", ...over,
});

function stats(root) {
  let meshes = 0, verts = 0, motion = 0, lods = 0;
  const kinds = new Set();
  root.traverse((o) => {
    if (o instanceof m.LOD) lods++;
    if (o.userData?.motion) { motion++; kinds.add(o.userData.motion.kind); }
  });
  const lod = root.getObjectByProperty("type", "LOD");
  (lod ? lod.levels[0].object : root).traverse((o) => {
    if (o instanceof m.Mesh) { meshes++; verts += o.geometry.getAttribute("position").count; }
  });
  return { meshes, verts, motion, lods, kinds };
}

function fits(model, w, h, what) {
  const box = new m.Box3().setFromObject(model);
  const sx = box.max.x - box.min.x, sz = box.max.z - box.min.z;
  assert.ok(sx <= w + 1e-6 && sz <= h + 1e-6, `${what} ${w}×${h}: ragt heraus (${sx.toFixed(2)}×${sz.toFixed(2)})`);
  assert.ok(box.min.y >= -1e-6, `${what}: steht auf dem Boden`);
  assert.ok(box.max.y > 0.5 && box.max.y < 7.5, `${what}: plausible Höhe (${box.max.y.toFixed(2)} m)`);
}

const cases = [
  ...["plotter", "waterjet", "punch", "manual", ""].flatMap((k) => [[3, 2], [5, 3], [6, 4], [4, 22]].map(([w, h]) =>
    ({ what: `Fertigung ${k || "unbekannt"}`, s: station({ machine_kind: k, w, h }), w, h, moving: k !== "" && k !== "manual" }))),
  ...[
    ["Plattenregal", "", 4, 22, true], ["Hochregal A", "Hochregal", 6, 4, true], ["Kommissionierung", "", 4, 3, false],
    ["Kommissionierung OG", "", 8, 8, false], ["Warenannahme", "Wareneingang", 4, 4, false], ["Leergut", "", 4, 6, false],
    ["Archiv", "", 4, 6, false], ["Kleinteilelager", "", 5, 4, true], ["Langzeitlager", "", 6, 10, true], ["Lager", "", 3, 2, false],
  ].map(([label, subtype, w, h, st]) => ({ what: `Lager ${label}`, s: station({ label, subtype, type: "warehouse", w, h, is_storage: st }), w, h })),
  { what: "Packtisch", s: station({ type: "shipping", w: 4, h: 2 }), w: 4, h: 2, moving: true },
  { what: "Packtisch Logistik", s: station({ type: "shipping", w: 4, h: 3 }), w: 4, h: 3, moving: true },
  { what: "Büro", s: station({ type: "accounting", w: 5, h: 3 }), w: 5, h: 3 },
  { what: "Büro klein", s: station({ type: "accounting", w: 2, h: 1.5 }), w: 2, h: 1.5 },
];

const kindsSeen = new Set();
for (const c of cases) {
  const running = m.buildDeviceModel(c.s, {}, { status: "laeuft", running: true });
  fits(running, c.w, c.h, c.what);
  const st = stats(running);
  assert.equal(st.lods, 1, `${c.what}: genau eine Fernstufe`);
  // Verschmolzen: Zeichenaufrufe bleiben klein, auch bei großen Lagern.
  assert.ok(st.meshes <= 70, `${c.what}: ${st.meshes} Zeichenaufrufe in der Nahstufe`);
  assert.ok(st.verts < 450_000, `${c.what}: ${st.verts} Ecken`);
  assert.ok(st.kinds.has("beacon"), `${c.what}: Signalsäule leuchtet bei Status`);
  if (c.moving) assert.ok(st.motion >= 2, `${c.what}: bewegte Teile vorhanden (${st.motion})`);
  const low = m.buildDeviceModel(c.s, {}, { detail: "low" });
  fits(low, c.w, c.h, `${c.what} (grob)`);
  const lowStats = stats(low);
  assert.equal(lowStats.lods, 0, `${c.what}: grobe Fassung ohne LOD`);
  assert.ok(lowStats.meshes <= 20, `${c.what}: grobe Fassung ${lowStats.meshes} Teile`);
  if (c.s.type === "warehouse") kindsSeen.add(m.storageKind(c.s));
}
for (const k of ["plattenregal", "hochregal", "kommissionierung", "wareneingang", "leergut", "archiv", "kleinteile", "langzeit", "regal"]) {
  assert.ok(kindsSeen.has(k), `Lagergestalt ${k} geprüft`);
}

// Kurzzeichen schlägt Namen; Namen ohne Kurzzeichen werden erkannt.
assert.equal(m.storageKind({ label: "Halle B", subtype: "Hochregal" }), "hochregal");
assert.equal(m.storageKind({ label: "Warenannahme", subtype: "" }), "wareneingang");
assert.equal(m.storageKind({ label: "Irgendwas", subtype: "", is_storage: true }), "hochregal");
assert.equal(m.storageKind({ label: "Irgendwas", subtype: "" }), "regal");

// Ohne Status leuchtet nichts, und nichts blinkt.
const quiet = m.buildDeviceModel(station({ machine_kind: "plotter", w: 5, h: 3 }));
const quietStats = stats(quiet);
assert.ok(!quietStats.kinds.has("beacon"), "ohne Status kein leuchtendes Segment");

// Walzen drehen um ihre eigene Achse: die Bewegung sitzt am inneren Teil,
// die Achse an der Haltergruppe (bis 2026-11-07 schwenkten sie um die Hochachse).
const pack = m.buildDeviceModel(station({ type: "shipping", w: 4, h: 2 }), {}, { running: true, status: "laeuft" });
let spins = 0;
pack.traverse((o) => {
  if (o.userData?.motion?.kind !== "spin") return;
  spins++;
  assert.equal(o.rotation.x, 0, "Walze selbst ungedreht");
  assert.equal(o.rotation.z, 0, "Walze selbst ungedreht");
  assert.ok(o.parent && (o.parent.rotation.x !== 0 || o.parent.rotation.z !== 0 || o.parent.rotation.y === 0), "Achse am Halter");
});
assert.ok(spins >= 4, `Rollenbahn dreht (${spins} Walzen)`);

// Geteilte Materialien: zwei gleiche Geräte teilen sich ihre Lackmaterialien.
const matsOf = (root) => { const s = new Set(); root.traverse((o) => { if (o instanceof m.Mesh && o.material.userData?.shared) s.add(o.material); }); return s; };
const a = matsOf(m.buildDeviceModel(station({ machine_kind: "punch" }), {}, { status: "frei" }));
const b = matsOf(m.buildDeviceModel(station({ machine_kind: "punch" }), {}, { status: "frei" }));
const common = [...a].filter((x) => b.has(x));
assert.ok(common.length >= 4, `geteilte Materialien (${common.length})`);
// Die leuchtende Signalsäule ist je Gerät eigen (sie blinkt einzeln).
const lit = (root) => { let mat = null; root.traverse((o) => { if (o.userData?.motion?.kind === "beacon") mat = o.material; }); return mat; };
const l1 = lit(m.buildDeviceModel(station({ machine_kind: "punch" }), {}, { status: "laeuft", running: true }));
const l2 = lit(m.buildDeviceModel(station({ machine_kind: "punch" }), {}, { status: "laeuft", running: true }));
assert.ok(l1 && l2 && l1 !== l2, "Signalsäule je Gerät eigenes Material");

// Roboter: AGV und AMR sehen verschieden aus, Räder und Lidar drehen.
const agv = m.robot.buildRobotModel({ id: 1, name: "AGV", kind: "agv", state: "moving" });
const amr = m.robot.buildRobotModel({ id: 2, name: "AMR", kind: "amr", state: "moving" });
// Höhe ohne Ladung (Box3 zählt auch ausgeblendete Teile).
const bare = (r) => { const pl = r.getObjectByName("robot-payload"); const parent = pl.parent; pl.removeFromParent();
  const h = new m.Box3().setFromObject(r).max.y; parent.add(pl); return h; };
const hAgv = bare(agv), hAmr = bare(amr);
assert.ok(hAmr > hAgv + 0.15, `AMR höher als AGV (${hAmr.toFixed(2)} / ${hAgv.toFixed(2)})`);
for (const r of [agv, amr]) {
  const names = new Set(); r.traverse((o) => { if (o.userData?.robotSpin) names.add(o.userData.robotSpin); });
  assert.ok(names.has("wheel") && names.has("lidar"), "Räder und Lidar drehbar");
  assert.ok(r.getObjectByName("robot-payload"), "Ladung vorhanden (ein-/ausblendbar)");
}

// Förderband: Brücke über einem Gang; dieselbe Grundfläche wie im Backend (core/conveyor.py).
const beltPts = m.cv.points3({ points: [[0, 0, 0.9], [4, 0, 2.85], [16, 0, 2.85], [20, 0, 0.9]] });
const beltFoot = m.cv.footprint(beltPts, 0.8);
assert.equal(beltFoot.length, 4, "zwei Rampenstücke und zwei Stützen");
const built = m.belt.buildConveyor(beltPts, 0.8, m.paletteOf(m.DEVICE_STYLE));
const bb = new m.Box3().setFromObject(built.root);
assert.ok(bb.min.x > -0.6 && bb.max.x < 20.6 && bb.max.y > 3 && bb.max.y < 4.5, "Band liegt auf seiner Linie, Geländer über der Brücke");
assert.ok(stats(built.root).lods === 1, "Band mit Fernstufe");
const world = m.buildTwinWorld({ outline: [[-5, -5], [25, -5], [25, 5], [-5, 5]], obstacles: [], zones: [], doors: [],
  aisles: { nodes: [], edges: [] }, conveyors: [{ name: "Band", points: beltPts, width: 0.8 }] }, []);
assert.equal(world.query({ kind: "circle", x: 10, y: 0, r: 0.5 }, { groups: ["obstacle"] }).length, 0, "unter der Brücke frei");
assert.equal(world.query({ kind: "circle", x: 1, y: 0, r: 0.5 }, { groups: ["obstacle"] }).length, 1, "Rampe ist ein Körper");

console.log(`Twin model checks passed: ${cases.length} devices fit, merged, LOD, motion, shared materials, storage kinds, robots.`);
