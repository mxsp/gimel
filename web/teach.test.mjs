// Handführung: node teach.test.mjs
// Prüft die Abbildung Handgelenk → Ziel im Greifraum, die Werkzeuglage, den
// Pinch/Sauger und dass die Pose des Geists wirklich auf dem Ziel liegt (IK aus
// arm7.ts). Kamera und MediaPipe sind dafür nicht nötig: `syntheticFrame`
// liefert dieselbe Form von Frame.
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (entry) => {
  const out = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
};
const teach = await bundle("src/components/robots/sortingCell/teach.ts");
const arm7 = await bundle("src/components/twin/arm7.ts");
const stations = await bundle("src/components/robots/sortingCell/stations.ts");
const THREE = await import("three");

const {
  syntheticFrame, teachSolution, pinchOf, gripperOf, DEFAULT_MAPPING, TEACH_VOLUME,
  PINCH_CLOSED, PINCH_OPEN, buildHandSkeleton,
} = teach;
const { buildArm } = arm7;
const { layoutFor, BELT } = stations;

const base = layoutFor(1).stations[0].base;
const rig = buildArm(new THREE.Vector3(base.x, base.y, base.z));
const scene = new THREE.Scene();
scene.add(rig.root);

// 1. Aus dem Trockenlauf kommt für jeden Zeitpunkt ein Ziel im Greifraum.
for (let i = 0; i < 40; i++) {
  const frame = syntheticFrame(i * 137 + 100);
  const sol = teachSolution(frame, DEFAULT_MAPPING, base);
  assert.ok(sol, `Zeitpunkt ${i}: keine Lösung`);
  assert.ok(Number.isFinite(sol.target.x) && Number.isFinite(sol.target.y) && Number.isFinite(sol.target.z));
  assert.ok(sol.target.y >= BELT.top + 0.03, `Ziel unter dem Band: ${sol.target.y}`);
  assert.ok(sol.target.y <= 1.63, `Ziel über dem Arm: ${sol.target.y}`);
  assert.ok(sol.target.z >= -1e-9 && sol.target.z <= 1 + 1e-9, `Ziel außerhalb der Tiefe: ${sol.target.z}`);
  assert.ok(Math.abs(sol.target.x - base.x) <= TEACH_VOLUME.spanX + 1e-9, "Ziel seitlich im Greifraum");
  const radius = Math.hypot(sol.target.x - base.x, sol.target.z - base.z);
  assert.ok(radius <= TEACH_VOLUME.maxRadius + 1e-9, `Ziel zu weit: ${radius.toFixed(3)} m`);
  assert.ok(sol.gripper >= 0 && sol.gripper <= 1);
  assert.ok((sol.side === "rechts" || sol.side === "links"), sol.side);

  // Der Geist fährt wirklich dorthin: IK auf das Ziel, TCP darauf.
  const angles = rig.solve(new THREE.Vector3(sol.target.x, sol.target.y, sol.target.z), sol.yaw, 0.12);
  assert.ok(angles.every(Number.isFinite), "Winkel endlich");
  rig.setPose(angles);
  scene.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  rig.tcp.getWorldPosition(p);
  assert.ok(p.distanceTo(new THREE.Vector3(sol.target.x, sol.target.y, sol.target.z)) < 1e-3,
    `TCP ≠ Handziel (${p.distanceTo(new THREE.Vector3(sol.target.x, sol.target.y, sol.target.z)).toFixed(4)} m)`);
}

// 2. Spiegeln dreht die Seite, alles andere bleibt.
const frame = syntheticFrame(1500);
const left = teachSolution(frame, { ...DEFAULT_MAPPING, mirror: false }, { x: 0, y: base.y, z: base.z });
const right = teachSolution(frame, DEFAULT_MAPPING, { x: 0, y: base.y, z: base.z });
const local = right.local.x;
assert.ok(Math.abs(local) > 1e-4, "Trockenlauf-Hand liegt nicht in der Mitte");
assert.ok(Math.abs((right.target.x - left.target.x) + 2 * local * DEFAULT_MAPPING.gain) < 1e-6,
  "Spiegeln dreht nur die Seite");
assert.ok(Math.abs(right.target.y - left.target.y) < 1e-9);

// 3. „Mitte setzen": mit dem Offset der aktuellen Hand ist die Neutralstellung erreicht.
const nord = teachSolution(frame, DEFAULT_MAPPING, base);
const calibrated = { ...DEFAULT_MAPPING, offset: { ...nord.local } };
const neutral = teachSolution(frame, calibrated, base);
assert.ok(Math.abs(neutral.target.x - base.x) < 1e-6, `x neutral: ${neutral.target.x}`);
assert.ok(Math.abs(neutral.target.z - TEACH_VOLUME.neutralZ) < 1e-6, `z neutral: ${neutral.target.z}`);
assert.ok(Math.abs(neutral.target.y - TEACH_VOLUME.neutralY) < 1e-6, `y neutral: ${neutral.target.y}`);
assert.ok(Math.abs(neutral.local.x) < 1e-9 && Math.abs(neutral.local.y) < 1e-9, "lokaler Punkt ist 0");

// 4. Pinch und Sauger: zu → 1, offen → 0, monoton dazwischen.
const hand = (gap) => {
  const h = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  h[0] = { x: 0.5, y: 0.6, z: 0 };     // Handwurzel
  h[9] = { x: 0.5, y: 0.5, z: 0 };     // Mittelfinger-Grundgelenk (Handlänge 0,1)
  h[8] = { x: 0.5, y: 0.4, z: 0 };     // Zeigefingerspitze
  h[4] = { x: 0.5 + gap, y: 0.4, z: 0 }; // Daumenspitze
  return h;
};
const closed = pinchOf(hand(0));
const open = pinchOf(hand(0.12));
assert.ok(closed < PINCH_CLOSED, `geschlossen: ${closed}`);
assert.ok(open > PINCH_OPEN, `offen: ${open}`);
assert.ok(gripperOf(closed) > 0.99, "geschlossene Hand → Sauger an");
assert.ok(gripperOf(open) < 0.01, "offene Hand → Sauger aus");
assert.ok(gripperOf((PINCH_CLOSED + PINCH_OPEN) / 2) > 0.4 && gripperOf((PINCH_CLOSED + PINCH_OPEN) / 2) < 0.6);
assert.ok(gripperOf(0.01) > gripperOf(0.5));

// 5. Ohne Schulter im Bild gibt es keine Pose (kein Raten).
const empty = { hand: null, handWorld: null, pose: [], poseWorld: null, at: 0 };
assert.equal(teachSolution(empty, DEFAULT_MAPPING, base), null);
assert.equal(teachSolution({ ...empty, pose: null }, DEFAULT_MAPPING, base), null);

// 6. Ein weit ausgestreckter Arm wird auf den Greifraum beschnitten — nicht ins Leere gerechnet.
const wild = syntheticFrame(1000);
wild.poseWorld = wild.poseWorld.map((lm, i) => (i === 16 ? { ...lm, x: 3.4, y: -2.2, z: 1.6 } : lm));
const clipped = teachSolution(wild, DEFAULT_MAPPING, base);
assert.ok(Math.hypot(clipped.target.x - base.x, clipped.target.z - base.z) <= TEACH_VOLUME.maxRadius + 1e-9);
const clippedJoints = rig.solve(new THREE.Vector3(clipped.target.x, clipped.target.y, clipped.target.z), clipped.yaw, 0);
assert.ok(clippedJoints.every(Number.isFinite));

// 7. Die Hand im 3D ist ein Skelett mit 21 Punkten; ohne Hand wird sie ausgeblendet.
const hand3d = buildHandSkeleton();
assert.equal(hand3d.group.visible, false);
const lm = syntheticFrame(700).hand;
hand3d.update(lm, 0.9);
assert.equal(hand3d.group.visible, true);
const dots = hand3d.group.children.find((c) => c.isPoints);
const bones = hand3d.group.children.find((c) => c.isLineSegments);
assert.equal(dots.geometry.getAttribute("position").count, 21);
assert.equal(bones.geometry.getAttribute("position").count, 21 * 2);
const pos = dots.geometry.getAttribute("position");
assert.ok(Math.abs(pos.getX(0)) < 1e-6 && Math.abs(pos.getY(0)) < 1e-6, "Handwurzel im Ursprung");
assert.ok(pos.getY(8) > pos.getY(0) + 0.02, "Fingerspitze über der Handwurzel");
hand3d.update(null, 0);
assert.equal(hand3d.group.visible, false);

console.log("teach checks passed: Ziel im Greifraum, IK folgt der Hand, Spiegeln, Mitte setzen, Sauger, 3D-Hand.");
