// Ebenen über dem Erdgeschoss: node twin-elevation.test.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * from "./src/components/twin/levels.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

/* Nur das EG liegt auf dem Boden: KG negativ, obere Geschosse positiv —
   unabhängig davon, welche Ebene gerade aktiv ist. */
const floors = [
  { id: 10, level: -1, elevation_m: -4, height_m: 4 },
  { id: 11, level: 0, elevation_m: 0, height_m: 6 },
  { id: 12, level: 1, elevation_m: 7, height_m: 6 },
];
const o = m.levelOffsets(floors);
assert.ok(o.get(10) < 0, "KG liegt unter dem Boden");
assert.equal(o.get(11), 0, "EG passt auf die Grundfläche");
assert.ok(o.get(12) > 0, "1. OG liegt darüber");
assert.ok(Math.abs(o.get(10)) >= 4, "gemeldete KG-Höhe wird benutzt");

/* Alte Daten ohne Höhen: der Stapel aus Geschosshöhen hält die Reihenfolge. */
const legacy = m.levelOffsets([
  { id: 1, level: -1, elevation_m: 0, height_m: 6 },
  { id: 2, level: 0, elevation_m: 0, height_m: 6 },
  { id: 3, level: 1, elevation_m: 0, height_m: 6 },
]);
assert.equal(legacy.get(2), 0, "auch ohne elevation_m ist das EG der Bezug");
assert.ok(legacy.get(1) < 0 && legacy.get(3) > 0, "KG unten, OG oben");
assert.ok(Math.abs(legacy.get(1) + 6.8) < 0.01, "eine Geschosshöhe plus Spalt");

/* Ohne EG: die erdnächste Ebene ist der Bezug. */
const upper = m.levelOffsets([
  { id: 4, level: 1, elevation_m: 7, height_m: 6 },
  { id: 5, level: 2, elevation_m: 14, height_m: 6 },
]);
assert.equal(upper.get(4), 0, "die erdnächste Ebene liegt auf dem Boden");
assert.ok(upper.get(5) > 0, "darüber liegende Ebenen bleiben positiv");

console.log("twin-elevation ok");
