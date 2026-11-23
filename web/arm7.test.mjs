// 7-Achs-Arm, Kinematik: node arm7.test.mjs
// Vorwärtsrechnung über die echten Three.js-Gelenke: der TCP liegt auf dem Ziel,
// das Werkzeug zeigt senkrecht nach unten, A7 trifft die Teilelage, und A4
// (Redundanz) bewegt den TCP nicht.
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/components/twin/arm7.ts"], bundle: true, platform: "node", format: "esm",
  write: false, logLevel: "silent",
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const THREE = await import("three");
const { buildArm, HOME_TARGET, JOINT_NAMES } = mod;

const rig = buildArm();
const scene = new THREE.Scene();
scene.add(rig.root);
assert.equal(rig.joints.length, 7);
assert.equal(JOINT_NAMES.length, 7);

const tcpAt = (angles) => {
  rig.setPose(angles);
  scene.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  rig.tcp.getWorldPosition(p);
  const q = new THREE.Quaternion();
  rig.tcp.getWorldQuaternion(q);
  const tool = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
  const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  return { p, tool, yaw: Math.atan2(-x.z, x.x) };
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Ziele wie in der Sortierzelle: Greifstelle, Schwebe, Körbe, Ruhelage.
const targets = [
  [new THREE.Vector3(-0.42, 0.845, 0.0), 0.6],
  [new THREE.Vector3(-0.42, 0.845, 0.11), -1.1],
  [new THREE.Vector3(-0.42, 1.12, -0.1), 0.2],
  [new THREE.Vector3(-0.6, 0.92, -0.6), 0],
  [new THREE.Vector3(0.6, 0.92, -0.6), 0],
  [new THREE.Vector3(0.0, 1.12, -0.6), 2.4],
  [HOME_TARGET.clone(), 0],
];

for (const [target, yaw] of targets) {
  for (const redundant of [0, 0.1, -0.14, 0.3]) {
    const angles = rig.solve(target, yaw, redundant);
    assert.equal(angles.length, 7);
    assert.ok(angles.every(Number.isFinite), `Winkel endlich: ${angles}`);
    const { p, tool, yaw: got } = tcpAt(angles);
    const err = p.distanceTo(target);
    assert.ok(err < 1e-3, `TCP ${p.toArray().map((v) => v.toFixed(3))} ≠ Ziel ${target.toArray()} (A4 ${redundant}): ${err.toFixed(4)} m`);
    assert.ok(tool.y < -0.9999, `Werkzeug nicht senkrecht (A4 ${redundant}): ${tool.toArray()}`);
    assert.ok(Math.abs(wrap(got - yaw)) < 1e-3, `Werkzeuglage ${got.toFixed(3)} ≠ ${yaw} (A4 ${redundant})`);
  }
}

// Nullraum: nur A4 ändern (A5–A7 nachgeführt) lässt den TCP stehen.
const a = rig.solve(targets[0][0], 0.3, 0), b = rig.solve(targets[0][0], 0.3, 0.25);
assert.deepEqual(a.slice(0, 3), b.slice(0, 3));
assert.ok(Math.abs(a[3] - b[3]) > 0.2);
assert.ok(tcpAt(a).p.distanceTo(tcpAt(b).p) < 1e-3);

// Alles, was Schatten wirft, hat Geometrie; der Leuchtring ist ein Mesh mit Standardmaterial.
let meshes = 0;
rig.root.traverse((o) => { if (o.isMesh) { meshes++; assert.ok(o.geometry.attributes.position.count > 0); } });
assert.ok(meshes > 40, `nur ${meshes} Körper`);
assert.ok(rig.statusLight.material.emissive, "Leuchtring braucht emissive");

console.log(`arm7 checks passed: ${targets.length * 4} IK-Ziele, Nullraum A4, ${meshes} Körper.`);
