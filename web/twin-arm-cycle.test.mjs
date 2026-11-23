// Arm mit Zelle im Zwilling (task 44): node twin-arm-cycle.test.mjs
// Ohne Browser: Phasen und Zeiten gleich der Sortierzelle; Zeitfenster und
// Körbe des Zyklus; jede Schlüsselpose legt den Greifer dorthin, wo die Zelle
// ihn hat (Greifstelle am Band, Korbmitte, Ablage); das Modell baut sich und
// lässt sich abspielen.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * as cell from "./src/components/twin/models/armCell.ts";
      export * as cycle from "./src/components/twin/armCycle.ts";
      export * as stations from "./src/components/robots/sortingCell/stations.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const THREE = await import("three");
const { cell, cycle, stations } = m;

// 1) Phasen und Zeiten wie in der Sortierzelle (runtime.ts, PHASES).
const runtimeSrc = readFileSync("src/components/robots/sortingCell/runtime.ts", "utf-8");
const cellDurs = [...runtimeSrc.matchAll(/id: "(\w+)", label: "[^"]*", dur: ([\d.]+)/g)].map((x) => [x[1], Number(x[2])]);
assert.equal(cellDurs.length, 8, "Zelle hat acht Phasen");
assert.deepEqual(cycle.ARM_PHASES.map((p) => [p.id, p.dur]), cellDurs, "Phasen und Zeiten gleich der Zelle");

// 2) Zeitfenster und Körbe.
assert.equal(cycle.armSampleAt(0).phase, 0);
assert.equal(cycle.armSampleAt(0.31).phase, 1);
assert.equal(cycle.armSampleAt(cycle.ARM_CYCLE_S + 0.01, 6).cycle, 1);
const wrap = cycle.armSampleAt(cycle.ARM_CYCLE_S * 6 + 0.01, 6);
assert.equal(wrap.cycle, 0, "nach dem letzten Korb beginnt es wieder bei Korb 0");
for (let s = 0; s < cycle.ARM_CYCLE_S * 6; s += 0.05) {
  const v = cycle.armSampleAt(s, 6);
  assert.ok(v.t >= 0 && v.t <= 1 && v.phase >= 0 && v.phase < 8, `Abtastung ${s}`);
}

// 3) Schlüsselposen an den echten Zielen der Zelle.
const layout = stations.layoutFor(1);
const model = cell.buildArmCell(layout);
assert.equal(model.rig.root.parent, model.root, "Arm hängt am Modell");
const keys = cell.armKeyframes(model.rig, layout);
const st = layout.stations[0];
assert.equal(keys.length, st.bins.length, "ein Schlüsselsatz je Korb der Station");
const tcpAt = (angles) => {
  model.rig.setPose(angles);
  model.root.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  model.rig.tcp.getWorldPosition(p);
  return p;
};
let worst = 0;
st.bins.forEach((spec, k) => {
  const [home, hover, down, , , binHover, binDrop] = keys[k];
  const targets = [
    ["Greifen", down, new THREE.Vector3(st.x, stations.BELT.top + 0.025, st.z)],
    ["Anfahrt", hover, new THREE.Vector3(st.x, 1.12, st.z)],
    [`Korb ${k + 1} oben`, binHover, new THREE.Vector3(spec.x, 1.12, spec.z)],
    [`Korb ${k + 1} Ablage`, binDrop, new THREE.Vector3(spec.x, stations.BIN_TOP + 0.02, spec.z)],
  ];
  for (const [name, angles, target] of targets) {
    const err = tcpAt(angles).distanceTo(target);
    worst = Math.max(worst, err);
    assert.ok(err < 0.03, `${name} Korb ${k}: TCP ${err.toFixed(3)} m vom Ziel`);
  }
  assert.ok(tcpAt(home).distanceTo(model.rig.home) < 0.03, "Ruhelage trifft die Ruhestelle");
});

// 4) Abspielen: Pose wird gesetzt, Teil erscheint nur beim Transport.
model.animate(0.0);
assert.equal(model.driver.isObject3D, true);
model.animate(cycle.ARM_CYCLE_S * 0.45);   // Phase 4: Anheben, Teil im Sauger
const carrying = model.rig.tcp.children.some((c) => c.visible);
model.animate(0.1);                         // Phase 0: Ruhe
assert.equal(model.rig.tcp.children.some((c) => c.visible), false, "kein Teil in Ruhe");
assert.ok(carrying, "Teil im Sauger während des Greifens");

console.log(`arm cell checks passed: ${st.bins.length} Körbe, größte Abweichung ${worst.toFixed(4)} m, Zyklus ${cycle.ARM_CYCLE_S.toFixed(2)} s.`);
