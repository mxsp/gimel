import * as THREE from "three";
import { box, cyl, group, mat } from "./kit";
import { buildArm, type ArmRig } from "../arm7";
import { ARM_PHASES, armSampleAt } from "../armCycle";
import { BELT, BIN_TOP, layoutFor, type CellLayout } from "../../robots/sortingCell/stations";
import { BIN_COUNT } from "../../robots/sortingCell/forms";

/* Arm mit Zelle als 3D-Modell (task 44), gebaut wie das Förderband: ein
   eigenes Modul aus dem Baukasten (`kit`), Koordinaten in Metern wie an der
   Sortierzelle unter Roboter → Arme & Zellen. Die Maße und Farben stammen aus
   dort (`stations.ts`, `cellScene.ts`), damit das Modell dasselbe ist.

   Enthalten: Tischband mit Rahmen, Rollen und Beinen; Podest unter dem Arm;
   Korbstreifen mit den Körben in ihren Farben; Kamera oben am Mast; Schutz-
   pfosten. Der Arm (arm7.ts) fährt den Arbeitszyklus aus armCycle.ts: anfahren,
   senken, greifen, anheben, zum Korb, ablegen, zurück. Die Schleife läuft nur,
   wenn die Halle sie zeigt (`animate(Sekunden)`). */

export interface ArmCellModel {
  root: THREE.Group;
  rig: ArmRig;
  /** Körper, an dem die Halle die Schleife abfragt (immer sichtbar). */
  driver: THREE.Object3D;
  animate(seconds: number): void;
}

const BIN_COLOURS = ["#3b7fc4", "#c08a33", "#4a9e78", "#8b6bc7", "#c05a5a"];
const FRAME = "#39434e";
const SHELF = "#39434e";
const FENCE = "#c9a52c";

/** Schlüsselposen je Korb: Ruhe, über dem Band, am Band (zweimal), über dem Band
 *  (Anheben), über dem Korb, im Korb, Ruhe. Ziele in Zellen-Koordinaten. */
export function armKeyframes(rig: ArmRig, layout: CellLayout = layoutFor(1)): number[][][] {
  const st = layout.stations[0];
  const home = rig.solve(rig.home, 0, 0);
  const hover = rig.solve(new THREE.Vector3(st.x, 1.12, st.z), 0, 0.10);
  const down = rig.solve(new THREE.Vector3(st.x, BELT.top + 0.025, st.z), 0, 0);
  return st.bins.map((spec) => {
    const binHover = rig.solve(new THREE.Vector3(spec.x, 1.12, spec.z), 0, 0.10);
    const binDrop = rig.solve(new THREE.Vector3(spec.x, BIN_TOP + 0.02, spec.z), 0, 0);
    return [home, hover, down, down, hover, binHover, binDrop, home];
  });
}

export function buildArmCell(layout: CellLayout = layoutFor(1)): ArmCellModel {
  const root = new THREE.Group();
  root.name = "arm-cell";
  const frame = mat(FRAME, "metal");
  const belt = mat("#252b32", "rubber");
  const rim = mat("#e2e8ee", "plastic");
  const dark = mat("#2b323b", "satin");
  const steel = mat("#7d8b99", "metal");

  // Tischband: Gurt, zwei Rahmenschienen, Rollen an beiden Enden, vier Beine.
  const bw = BELT.x1 - BELT.x0, bd = BELT.z1 - BELT.z0;
  const cx = (BELT.x0 + BELT.x1) / 2;
  box(root, bw, 0.04, bd, cx, BELT.top - 0.02, 0, belt);
  for (const z of [BELT.z0 - 0.045, BELT.z1 + 0.045]) {
    box(root, bw + 0.12, 0.07, 0.05, cx, BELT.top - 0.02, z, frame);
  }
  for (const x of [BELT.x0, BELT.x1]) {
    const roller = cyl(root, 0.05, 0.05, bd + 0.02, x, BELT.top - 0.02, 0, steel, "z", 18);
    roller.rotation.x = Math.PI / 2;
  }
  for (const x of [BELT.x0 + 0.16, BELT.x1 - 0.16]) {
    for (const z of [BELT.z0 - 0.02, BELT.z1 + 0.02]) {
      box(root, 0.07, BELT.top - 0.06, 0.07, x, (BELT.top - 0.06) / 2, z, frame);
    }
  }

  // Podest unter dem Arm.
  for (const st of layout.stations) {
    box(root, 0.62, 0.02, 0.62, st.base.x, 0.01, st.base.z, mat(FRAME, "satin"));
  }

  // Korbstreifen: Regalbrett, dann je Korb ein Behälter mit Rand und Etikett.
  for (const st of layout.stations) {
    const row = st.bins;
    if (!row.length) continue;
    const centre = (row[0].x + row[row.length - 1].x) / 2;
    const shelfW = row.length * 0.24 + 0.11;
    box(root, shelfW, 0.05, 0.3, centre, 0.6, row[0].z, mat(SHELF, "metal"));
    for (const spec of row) {
      const g = group(root, spec.x, 0, spec.z);
      const colour = spec.bin === BIN_COUNT - 1 ? "#6b7482" : BIN_COLOURS[spec.bin % BIN_COLOURS.length];
      box(g, 0.22, 0.24, 0.2, 0, 0.74, 0, mat(colour, "plastic"), 0.03);
      box(g, 0.235, 0.02, 0.215, 0, 0.87, 0, rim);
      box(g, 0.16, 0.055, 0.004, 0, 0.755, 0.102, mat("#f2f5f8", "matte"));
    }
  }

  // Kamera oben am Mast, über dem Band.
  const cam = group(root, -0.4, 2.05, 0);
  box(cam, 0.30, 0.16, 0.30, 0, 0, 0, dark, 0.02);
  cyl(cam, 0.055, 0.075, 0.10, 0, -0.13, 0, mat("#151a20", "satin"), "y", 20);
  cyl(cam, 0.048, 0.048, 0.004, 0, -0.181, 0, mat("#2a5d8f", "satin"), "y", 20);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    cyl(root, 0.016, 0.016, 2.03, -0.4 + sx * 1.05, 2.05 - 1.02, sz * 0.62, mat("#55606c", "metal"), "y", 10);
  }

  // Schutzpfosten an der Rückwand.
  for (const x of [-1.85, 1.05]) {
    cyl(root, 0.04, 0.04, 1.3, x, 0.65, -1.05, mat(FENCE, "paint"), "y", 12);
  }

  // Arm: Fuß an der Greifstelle-Station, Modell aus arm7.ts.
  const st = layout.stations[0];
  const rig = buildArm(new THREE.Vector3(st.base.x, st.base.y, st.base.z));
  root.add(rig.root);

  // Das Teil im Sauger: nur beim Transport sichtbar.
  const part = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xc08a33, roughness: 0.8 }),
  );
  part.position.set(0, -0.03, 0);
  part.visible = false;
  rig.tcp.add(part);

  const cycles = armKeyframes(rig, layout);
  const animate = (seconds: number) => {
    const { phase, t, cycle } = armSampleAt(seconds, cycles.length);
    const keys = cycles[cycle % cycles.length];
    const from = keys[(phase + ARM_PHASES.length - 1) % ARM_PHASES.length];
    const to = keys[phase];
    const pose = from.map((v, i) => v + (to[i] - v) * t);
    // A4 schwenkt im Nullraum weiter, ohne den TCP zu bewegen (wie im Lauf).
    pose[3] = 0.14 * Math.sin(seconds * 1.05);
    rig.setPose(pose);
    part.visible = phase === 3 || phase === 4 || phase === 5 || (phase === 6 && t < 0.8);
  };

  let driver: THREE.Object3D | null = null;
  rig.root.traverse((o) => { if (!driver && o instanceof THREE.Mesh) driver = o; });
  animate(0);
  return { root, rig, driver: driver ?? root, animate };
}
