// Hallen beim Begehen verbinden: node twin-halls.test.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * from "./src/components/twin/walkHalls.ts";
      export { buildTwinWorld, wallPieces } from "./src/components/twin/collision.ts";
      export { walkStep } from "./src/components/twin/studioMath.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const floor = (id, name, outline, doors = []) => ({
  id, name, outline, doors, zones: [], obstacles: [],
  aisles: { nodes: [], edges: [] }, scale: 40, grid: 1, snap: 0.25, bg: "",
});
const height = ({ a, b }) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** Abstand eines Punktes zu einer Strecke — für „kein Wandstück im Tor“. */
function segmentDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

/* ---------------------------------------------------------------- Wände */
const outline = [[0, 0], [20, 0], [20, 12], [0, 12]];
const gate = { name: "Tor Ost", x: 20, y: 6, width: 2.5, kind: "gate" };
const pieces = m.wallPieces(outline, [gate]);
const total = pieces.reduce((s, seg) => s + height(seg), 0);
assert.ok(Math.abs(total - (2 * (20 + 12) - 2.5)) < 1e-6, "die Wand fehlt genau um die Torbreite");
for (const seg of pieces) {
  assert.ok(segmentDist([20, 6], seg.a, seg.b) > 1.2, "kein Wandstück mitten im Durchgang");
}
// Ein Tor an einer anderen Wand schneidet die Ostwand nicht.
const west = m.wallPieces(outline, [{ name: "Tor West", x: 0, y: 6, width: 2.5, kind: "gate" }]);
assert.ok(Math.abs(west.reduce((s, seg) => s + height(seg), 0) - (2 * (20 + 12) - 2.5)) < 1e-6);
assert.ok(west.some((seg) => Math.abs(seg.a[0] - 20) < 1e-9 && Math.abs(seg.b[0] - 20) < 1e-9
  && segmentDist([20, 6], seg.a, seg.b) < 1e-9), "die Ostwand bleibt geschlossen");

/* ------------------------------------------------------- Achsen und Blick */
const h = { id: 2, label: "B", floor: floor(2, "B", outline), stations: [], x: 10, y: -4, rotation_deg: 30 };
const p = [3.5, -1.2];
const back = m.unplacePoint(m.placePoint(p, h), h);
assert.ok(Math.abs(back[0] - p[0]) < 1e-9 && Math.abs(back[1] - p[1]) < 1e-9, "Punkt hin und zurück");
assert.deepEqual(m.placePoint([1, 0], { x: 5, y: 7, rotation_deg: 90 }), [5, 6],
  "90° dreht +x nach −y im Plan");
assert.ok(Math.abs(m.unplaceYaw(m.placeYaw(0.7, 30), 30) - 0.7) < 1e-9, "Blick hin und zurück");
// Die Umkehrung ist genau das, was ``unplacePoint`` mit einem Punkt tut.
const inv = m.inversePlacement(h);
for (const q of [[0, 0], [4, 9], [-7.5, 2.25]]) {
  const a = m.placePoint(q, inv), b = m.unplacePoint(q, h);
  assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9,
    "Rückweg liegt an derselben Stelle");
}

/* ------------------------------------------------------- Halle erkennen */
const A = { id: 1, label: "A", floor: floor(1, "A", outline), stations: [], x: 0, y: 0, rotation_deg: 0, elevation_m: 0 };
const B = { id: 2, label: "B", floor: floor(2, "B", outline), stations: [], x: 20, y: 0, rotation_deg: 0, elevation_m: 0 };
assert.equal(m.hallAt([A, B], [25, 6])?.id, 2, "Punkt liegt in der Nachbarhalle");
assert.equal(m.hallAt([A, B], [10, 6]), null, "Punkt in der aktiven Halle zählt nicht");
assert.equal(m.hallAt([A, B], [25, 6], 1), null, "die aktive Halle wird übersprungen");
assert.equal(m.hallAt([A, B], [10, 6], 1)?.id, 1, "ohne aktive Halle findet man die andere");

/* -------------------------------------------------- Durch die Tür gehen */
const hallA = { ...A, floor: floor(1, "A", outline, [gate]) };
const hallB = { ...B, floor: floor(2, "B", outline, [{ name: "Tor West", x: 0, y: 6, width: 2.5, kind: "gate" }]) };
const world = m.hallWalkWorld([hallA, hallB]);
const free = (x, y) => !world.blocks({ kind: "circle", x, y, r: 0.35 },
  { groups: ["station", "obstacle", "wall"] });
assert.ok(free(20, 6), "im gemeinsamen Durchgang ist Platz");
assert.ok(free(19.5, 6) && free(20.5, 6), "beide Seiten des Durchgangs sind frei");
assert.ok(!free(20, 2), "neben dem Tor steht die Wand");
assert.ok(!free(20, 10), "auch am anderen Ende der Wand");

/** Geradeaus gehen, bis man drüben ist (oder hängen bleibt). */
function walk(x, y, sx, sy, steps = 50) {
  let pos = [x, y];
  for (let i = 0; i < steps; i++) {
    pos = m.walkStep(pos, Math.atan2(sx, sy), { forward: 1, strafe: 0 }, 0.1, world).pos;
  }
  return pos;
}
const through = walk(18, 6, 1, 0);
assert.ok(through[0] > 21, `durch das Tor in die Nachbarhalle (x=${through[0].toFixed(2)})`);
const blocked = walk(18, 2, 1, 0);
assert.ok(blocked[0] < 19.8, "neben dem Tor kommt man nicht durch die Wand");

console.log("twin-halls ok");
