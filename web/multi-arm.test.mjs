// Mehrere Arme in einer Zelle: node multi-arm.test.mjs
// Prüft die Aufteilung (stations.ts) und dass jeder Arm seine Greifstelle und
// seine Körbe wirklich erreicht (Kinematik aus arm7.ts, echte Three.js-Kette).
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (entry) => {
  const out = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
};
const stations = await bundle("src/components/robots/sortingCell/stations.ts");
const forms = await bundle("src/components/robots/sortingCell/forms.ts");
const arm7 = await bundle("src/components/twin/arm7.ts");
const THREE = await import("three");

const {
  layoutFor, splitBins, stationForBin, BELT, BIN_TOP, BIN_PITCH, ARM_FOOT_Y, ARM_FOOT_Z,
  MAX_ARMS, SPACING_MM,
} = stations;
const { BIN_COUNT, FORMS, REJECT_BIN } = forms;
const { buildArm, HOME_TARGET } = arm7;

// 1. Die Klassen sind eine Partition: jede Form genau einmal, Nachprüfung überall.
for (const n of [1, 2]) {
  const shares = splitBins(n);
  assert.equal(shares.length, n, `${n}: Zahl der Arme`);
  const all = shares.flat();
  for (let bin = 0; bin < BIN_COUNT - 1; bin++) {
    assert.equal(all.filter((b) => b === bin).length, 1, `Formkorb ${bin} gehört genau einem Arm (${n} Arme)`);
  }
  assert.equal(all.filter((b) => b === REJECT_BIN).length, n, "jeder Arm hat eine Nachprüfung");
  assert.ok(shares.every((s) => s.includes(REJECT_BIN)));
  assert.deepEqual(new Set(all), new Set(Array.from({ length: BIN_COUNT }, (_, i) => i)));
}
assert.deepEqual(splitBins(1), [[0, 1, 2, 3, 4, REJECT_BIN]]);
assert.deepEqual(splitBins(2), [[0, 1, 2, REJECT_BIN], [3, 4, REJECT_BIN]]);

// 2. Ein Arm ergibt exakt die alte Zelle (Greifstelle −0,42 m, Körbe um x = 0).
const one = layoutFor(1);
assert.equal(one.arms, 1);
assert.equal(one.stations.length, 1);
assert.ok(Math.abs(one.stations[0].x + 0.42) < 1e-9, "Greifstelle wie bisher");
assert.deepEqual(one.stations[0].base, { x: 0, y: ARM_FOOT_Y, z: ARM_FOOT_Z });
const legacyBins = [-0.6, -0.36, -0.12, 0.12, 0.36, 0.6];
one.stations[0].bins.forEach((b, i) => {
  assert.ok(Math.abs(b.x - legacyBins[i]) < 1e-9, `Korb ${i} an ${b.x} statt ${legacyBins[i]}`);
  assert.equal(b.bin, i);
});
assert.equal(one.spawnMm, -1380, "Teile legen wie bisher bei −1380 mm an");
assert.equal(one.stations[0].owns.length, BIN_COUNT);

// 3. Zwei Arme: zwei Stationen am Band, getrennte Armfüße, getrennte Körbe.
const two = layoutFor(2);
assert.equal(two.arms, 2);
assert.equal(two.stations.length, 2);
const [a, b] = two.stations;
assert.ok(Math.abs(a.x - b.x) >= 0.8, `Stationen zu dicht: ${a.x} / ${b.x}`);
assert.ok(a.base.x !== b.base.x, "zwei Arme stehen nicht auf demselben Fuß");
assert.ok(two.spawnMm < Math.round(a.x * 1000), "Nachschub kommt vor der ersten Station an");
assert.ok(two.spawnMm >= Math.round(BELT.x0 * 1000) + 40, "Nachschub liegt auf dem Band");
const binsOf = (s) => s.bins.map((x) => x.bin);
assert.deepEqual(binsOf(a), [0, 1, 2, REJECT_BIN]);
assert.deepEqual(binsOf(b), [3, 4, REJECT_BIN]);
// Kein Korb doppelt (außer der Nachprüfung), Korbstreifen überlappen nicht.
const formBins = two.stations.flatMap(binsOf).filter((i) => i !== REJECT_BIN);
assert.equal(new Set(formBins).size, formBins.length);
const rowOf = (s) => [s.bins[0].x, s.bins[s.bins.length - 1].x];
const [aL, aR] = rowOf(a), [bL, bR] = rowOf(b);
assert.ok(aR < bL, `Korbstreifen überlappen: ${aR} ≥ ${bL}`);
assert.ok(Math.abs((a.bins[1].x - a.bins[0].x) - BIN_PITCH) < 1e-9, "Korbabstand wie im Einarmbetrieb");

// 4. Grenzen: mehr als zwei Arme baut die Zelle nicht, null ergibt einen.
assert.equal(layoutFor(3).arms, MAX_ARMS, "mehr als zwei Arme: nur zwei Stationen");
assert.equal(layoutFor(0).arms, 1);
assert.equal(layoutFor(1.4).arms, 1);

// 5. Jeder Arm erreicht seine Greifstelle, alle seine Körbe und seine Ruhelage.
const near = (p, q, tol, what) => {
  const err = p.distanceTo(q);
  assert.ok(err < tol, `${what}: ${p.toArray().map((v) => v.toFixed(3))} ≠ ${q.toArray()} (${err.toFixed(4)} m)`);
};
const tcpOf = (rig, scene, angles) => {
  rig.setPose(angles);
  scene.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  rig.tcp.getWorldPosition(p);
  rig.tcp.getWorldQuaternion(q);
  return { p, tool: new THREE.Vector3(0, -1, 0).applyQuaternion(q) };
};

for (const layout of [one, two]) {
  const scene = new THREE.Scene();
  for (const st of layout.stations) {
    const rig = buildArm(new THREE.Vector3(st.base.x, st.base.y, st.base.z));
    scene.add(rig.root);
    assert.ok(Math.abs(rig.home.x - (st.base.x + HOME_TARGET.x)) < 1e-9, "Ruhelage folgt dem Fuß");
    const targets = [
      [new THREE.Vector3(st.x, BELT.top + 0.025, 0), 0.4, "Greifstelle"],
      [new THREE.Vector3(st.x, 1.12, 0.11), -1.1, "Schwebe"],
    ];
    for (const spec of st.bins) {
      const target = new THREE.Vector3(spec.x, BIN_TOP + 0.02, spec.z);
      targets.push([target, 0, `Korb ${spec.label}`]);
    }
    for (const [target, yaw, what] of targets) {
      const angles = rig.solve(target, yaw, 0.1);
      assert.ok(angles.every(Number.isFinite), `${what}: Winkel endlich`);
      const { p, tool } = tcpOf(rig, scene, angles);
      near(p, target, 1e-3, `${what} (Arm ${st.index + 1})`);
      assert.ok(tool.y < -0.9999, `${what}: Werkzeug nicht senkrecht`);
    }
    // Ruhelage ist erreichbar.
    const rest = rig.solve(rig.home, 0, 0);
    assert.ok(rest.every(Number.isFinite));
  }
}

// 6. Die Klasse bestimmt die Station: erst der Arm, der sie bedient.
assert.equal(stationForBin(two, 0), 0);
assert.equal(stationForBin(two, 4), 1);
assert.equal(stationForBin(two, REJECT_BIN), 0, "Nachprüfung nimmt die erste Station");
assert.equal(stationForBin(one, REJECT_BIN), 0);
for (const model of FORMS) {
  assert.equal(stationForBin(two, model.bin), model.bin >= 3 ? 1 : 0, `${model.label}`);
}

// 7. Ein Teil, das einem hinteren Arm gehört, hält nicht an der ersten Station.
const ownerFor = (bin) => stationForBin(two, bin);
assert.ok(ownerFor(FORMS[4].bin) === 1 && ownerFor(FORMS[0].bin) === 0, "Klassen getrennt");
assert.ok(two.stations[1].x > two.stations[0].x, "stromabwärts = größeres x");
assert.ok(two.spawnMm - two.stations[0].x * 1000 < -SPACING_MM, "Platz für Nachschub");

console.log(`multi-arm checks passed: 1/2 Arme, ${BIN_COUNT} Körbe je Zelle, ${two.stations.length} Stationen, alle Ziele in Reichweite.`);
