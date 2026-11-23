// Maßstab der 3D-Halle (task 41 I): node twin-scale.test.mjs
// Owner 2026-11-08: „alles im richtigen Maßstab zum Luftbild; Figuren und
// Stapler zu groß“. Prüft ohne Browser, dass Figuren, Stapler, Paletten und
// Roboter echte Maße in Metern haben, dass die Kartenkacheln am Standort die
// richtige Bodenbreite tragen und dass ein gebautes Gerät seine Stationsfläche
// ausfüllt statt geschrumpft zu werden.
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * as props from "./src/components/twin/models/props.ts";
      export { paletteOf, DEVICE_STYLE, buildDeviceModel } from "./src/components/twin/deviceModels.ts";
      export { buildRobotModel } from "./src/components/twin/robotModel.ts";
      export { tileMetres } from "./src/sites.ts";
      export { EYE_HEIGHT_M } from "./src/components/twin/studioMath.ts";
      export { Box3, Vector3, Group } from "three";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const p = m.paletteOf(m.DEVICE_STYLE);
const mk = (f) => { const g = new m.Group(); f(g); return g; };
/** Maße nur der sichtbaren Teile (die Ladung eines Roboters ist versteckt). */
function size(o) {
  o.updateMatrixWorld(true);
  const box = new m.Box3();
  o.traverse((c) => {
    if (!c.isMesh) return;
    for (let x = c; x; x = x.parent) if (!x.visible) return;
    box.expandByObject(c);
  });
  const s = box.getSize(new m.Vector3());
  return { l: Math.max(s.x, s.z), w: Math.min(s.x, s.z), h: s.y };
}
const within = (v, lo, hi, what) => assert.ok(v >= lo && v <= hi, `${what}: ${v.toFixed(2)} m, erwartet ${lo}…${hi} m`);

// Mensch: 1,75 m, mit Helm bis 1,85 m.
const standing = size(mk((g) => m.props.worker(g, p, 0, 0, 0, "walk")));
within(standing.h, 1.7, 1.85, "Figur stehend Höhe");
within(standing.w, 0.25, 0.65, "Figur Schulterbreite");
const sitting = size(mk((g) => m.props.worker(g, p, 0, 0, 0, "sit")));
within(sitting.h, 1.15, 1.5, "Figur sitzend Höhe");

// Frontstapler 1,5–2,5 t: Länge mit Gabel 2,6–3,4 m, Breite ≤ 1,25 m, Schutzdach 2,0–2,3 m.
const fork = size(mk((g) => m.props.forklift(g, p, 0, 0, 0, false)));
within(fork.l, 2.6, 3.4, "Stapler Länge");
within(fork.w, 0.95, 1.25, "Stapler Breite");
within(fork.h, 2.0, 2.3, "Stapler Höhe");

// Europalette 1,20 × 0,80 × 0,144 m.
const pal = size(mk((g) => m.props.pallet(g, p, 0, 0, 0)));
within(pal.l, 1.18, 1.22, "Palette Länge");
within(pal.w, 0.78, 0.82, "Palette Breite");
within(pal.h, 0.12, 0.16, "Palette Höhe");

// Hubwagen: Gabel 1,15 m + Deichsel, Griff ~1,2 m.
const jack = size(mk((g) => m.props.palletJack(g, p, 0, 0, 0)));
within(jack.l, 1.5, 1.9, "Hubwagen Länge");
within(jack.h, 1.1, 1.35, "Hubwagen Griffhöhe");

// Fahrerlose Fahrzeuge: AGV flach (≤ 0,6 m ohne Ladung), AMR mit Aufbau ≤ 1,0 m.
const agv = size(m.buildRobotModel({ id: 1, name: "a", kind: "agv", state: "idle" }));
within(agv.l, 1.1, 1.6, "AGV Länge");
within(agv.h, 0.3, 0.6, "AGV Höhe");
const amr = size(m.buildRobotModel({ id: 2, name: "b", kind: "amr", state: "idle" }));
within(amr.l, 0.8, 1.2, "AMR Länge");
within(amr.h, 0.5, 1.0, "AMR Höhe");

// Augenhöhe beim Begehen.
within(m.EYE_HEIGHT_M, 1.55, 1.75, "Augenhöhe");

// Kartenkacheln: Bodenbreite einer Kachel an der Breite des Standorts
// (Köthen 51,75° N, Stufe 18) — Web-Mercator, 256 px: 40 075 016,686 m · cos φ / 2^z.
within(m.tileMetres(51.75, 18), 94.4, 94.8, "Kachel z18 bei 51,75° N");
within(m.tileMetres(0, 18), 152.8, 152.9, "Kachel z18 am Äquator");

// Ein Gerät in einer üblichen Fläche wird nicht geschrumpft: es füllt sie.
for (const [kind, w, h] of [["plotter", 5, 3], ["waterjet", 6, 4], ["punch", 4, 3]]) {
  const g = m.buildDeviceModel({ label: kind, type: "production", machine_kind: kind, subtype: "", w, h, rotation: 0,
    colour: "#106ba3", active: true, is_storage: false, model_file: "" }, {}, {});
  let scale = 1;
  g.traverse((o) => { if (o.userData?.device && o.children[0]) scale = Math.min(scale, o.children[0].scale.x); });
  assert.ok(scale >= 0.95, `${kind} ${w}×${h}: auf ${scale.toFixed(2)} geschrumpft`);
}

console.log("Twin scale checks passed: figures, forklift, pallet, pallet jack, AGV/AMR, eye height, map tiles, device fit.");
