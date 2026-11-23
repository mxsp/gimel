/* Die Szene der Sortierzelle — Tischband, Körbe, Kamera oben, Licht.

   Ein Meter = eine Three.js-Einheit; die Teile selbst sind in Millimetern
   definiert und werden beim Bau herunterskaliert. Die Kamera oben ist eine
   echte zweite Three.js-Kamera: ihr Bild ist wörtlich „was die Kamera sieht",
   nicht eine nachgezeichnete Skizze.

   Seit 2026-11-09 baut die Szene ihren Korbstreifen aus dem Zellen-Layout
   (`stations.ts`): ein Arm bekommt den einen Streifen wie bisher, zwei Arme je
   einen Streifen hinter ihrer Greifstelle. */

import * as THREE from "three";
import { BIN_COUNT, BIN_LABELS, type FormTemplate, type Pt } from "./forms";
import { ARM_FOOT_Y, BELT, BIN_TOP, BIN_Z, CAM_CENTER, type CellLayout } from "./stations";

export { BELT, BELT_MM_S, BIN_TOP, BIN_Z, CAM_CENTER, PICK_X, SPACING_MM } from "./stations";

export const binTarget = (layout: CellLayout, station: number, bin: number): THREE.Vector3 => {
  const spec = layout.stations[station]?.bins.find((b) => b.bin === bin);
  return new THREE.Vector3(spec?.x ?? 0, BIN_TOP, spec?.z ?? BIN_Z);
};

const mat = (colour: number, metalness = 0.15, roughness = 0.8) =>
  new THREE.MeshStandardMaterial({ color: colour, metalness, roughness });

/** Flaches 3D-Teil aus denselben Ringen wie die Teileerkennung. */
export function makePartMesh(form: FormTemplate): THREE.Mesh {
  const shape = new THREE.Shape();
  const trace = (target: THREE.Path | THREE.Shape, ring: Pt[]) => {
    ring.forEach(([x, y], i) => (i === 0 ? target.moveTo(x, -y) : target.lineTo(x, -y)));
    target.closePath();
  };
  trace(shape, form.rings[0]);
  for (const hole of form.rings.slice(1)) {
    const path = new THREE.Path();
    trace(path, hole);
    shape.holes.push(path);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 6, bevelEnabled: true, bevelSize: 0.6, bevelThickness: 0.5, bevelSegments: 1, curveSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.scale(0.001, 0.001, 0.001);
  const mesh = new THREE.Mesh(geo, mat(form.colour, 0.05, 0.72));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `part-${form.id}`;
  return mesh;
}

/** Laufendes Band: eine Canvas-Textur, deren Versatz die Fahrt zeigt. */
function beltTexture(): { texture: THREE.CanvasTexture; material: THREE.MeshStandardMaterial } {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#252b32";
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = "rgba(255,255,255,0.055)";
  g.lineWidth = 6;
  for (let x = -128; x < 384; x += 32) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 64, 128); g.stroke();
  }
  g.strokeStyle = "rgba(255,255,255,0.10)";
  g.lineWidth = 2;
  for (let y = 0; y < 128; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
  const texture = new THREE.CanvasTexture(c);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(8, 2);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = mat(0xffffff, 0.05, 0.92);
  material.map = texture;
  return { texture, material };
}

export interface CellScene {
  scene: THREE.Scene;
  beltTexture: THREE.CanvasTexture;
  bins: THREE.Group[];
  /** Behälter für die abgelegten Teile je Korb: [Station][lokaler Korb]. */
  binStacks: THREE.Group[][];
  cameraRig: THREE.Group;
  cameraLens: THREE.Mesh;
  /** Körbe leeren (Belebung zurücksetzen). */
  clearBins(): void;
}

export function buildCellScene(layout: CellLayout = { arms: 1, stations: [], spawnMm: 0, beltStartMm: 0, beltEndMm: 0 }): CellScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1218);
  scene.fog = new THREE.Fog(0x0d1218, 5, 11);

  // Boden und Raster.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), mat(0x171d24, 0.05, 0.95));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(8, 32, 0x2b3948, 0x202a34);
  grid.position.y = 0.002;
  scene.add(grid);

  // Licht.
  scene.add(new THREE.HemisphereLight(0xbdd3ec, 0x20262e, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.55);
  key.position.set(-2.2, 4.2, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3; key.shadow.camera.right = 3;
  key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 10;
  key.shadow.bias = -0.0008;
  scene.add(key);
  const fillLight = new THREE.DirectionalLight(0x8fb6e0, 0.5);
  fillLight.position.set(3, 2.5, -2.5);
  scene.add(fillLight);

  // Sortiertisch / Förderband.
  const { texture, material: beltMat } = beltTexture();
  const bw = BELT.x1 - BELT.x0, bd = BELT.z1 - BELT.z0;
  const cx = (BELT.x0 + BELT.x1) / 2;
  const belt = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.04, bd), beltMat);
  belt.position.set(cx, BELT.top - 0.02, 0);
  belt.receiveShadow = true;
  scene.add(belt);

  const frameMat = mat(0x39434e, 0.55, 0.5);
  for (const z of [BELT.z0 - 0.045, BELT.z1 + 0.045]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.12, 0.07, 0.05), frameMat);
    rail.position.set(cx, BELT.top - 0.02, z);
    rail.castShadow = true;
    scene.add(rail);
  }
  for (const x of [BELT.x0, BELT.x1]) {
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, bd + 0.02, 18), mat(0x7d8b99, 0.8, 0.3));
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, BELT.top - 0.02, 0);
    scene.add(roller);
  }
  for (const x of [BELT.x0 + 0.16, BELT.x1 - 0.16]) for (const z of [BELT.z0 - 0.02, BELT.z1 + 0.02]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, BELT.top - 0.06, 0.07), frameMat);
    leg.position.set(x, (BELT.top - 0.06) / 2, z);
    leg.castShadow = true;
    scene.add(leg);
  }

  // Podest unter jedem Arm (die Arm-Basis bringt ihr eigenes mit).
  for (const station of layout.stations) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.02, 0.62), mat(0x3a4653, 0.2, 0.8));
    pad.position.set(station.base.x, 0.01, station.base.z);
    pad.receiveShadow = true;
    scene.add(pad);
  }

  // Sortierkörbe: je Station ein eigener Streifen hinter dem Band.
  const bins: THREE.Group[] = [];
  const binStacks: THREE.Group[][] = [];
  const stations = layout.stations.length ? layout.stations : [];
  if (!stations.length) {
    // Ohne Layout (nur zur Sicherheit): der alte, eine Streifen.
    stations.push({
      index: 0, x: -0.42, z: 0, base: { x: 0, y: ARM_FOOT_Y, z: 0.58 },
      bins: Array.from({ length: BIN_COUNT }, (_, i) => ({
        bin: i, local: i, x: -0.6 + i * 0.24, z: BIN_Z, label: BIN_LABELS[i] ?? "?",
      })),
      owns: Array.from({ length: BIN_COUNT }, (_, i) => i),
    });
  }
  for (const station of stations) {
    const row = station.bins;
    const shelfW = row.length * 0.24 + 0.11;
    const centre = row.length ? (row[0].x + row[row.length - 1].x) / 2 : station.base.x;
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(shelfW, 0.05, 0.3), mat(0x39434e, 0.5, 0.55));
    shelf.position.set(centre, 0.6, BIN_Z);
    shelf.castShadow = true;
    scene.add(shelf);
    const stacks: THREE.Group[] = [];
    binStacks.push(stacks);
    for (const spec of row) {
      const group = new THREE.Group();
      group.position.set(spec.x, 0, spec.z);
      const stack = new THREE.Group();
      group.add(stack);
      stacks.push(stack);
      const colour = spec.bin === BIN_COUNT - 1 ? 0x6b7482 : [0x3b7fc4, 0xc08a33, 0x4a9e78, 0x8b6bc7, 0xc05a5a][spec.bin % 5];
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.2), mat(colour, 0.1, 0.85));
      body.position.y = 0.74;
      body.castShadow = true;
      group.add(body);
      const rim = new THREE.Mesh(new THREE.BoxGeometry(0.235, 0.02, 0.215), mat(0xe2e8ee, 0.2, 0.6));
      rim.position.y = 0.87;
      group.add(rim);
      const label = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.055, 0.004), mat(0xf2f5f8, 0.0, 0.9));
      label.position.set(0, 0.755, 0.102);
      group.add(label);
      scene.add(group);
      bins.push(group);
    }
  }

  // Kamera oben: Gehäuse, Objektiv, Ringlicht, Stativ.
  const cameraRig = new THREE.Group();
  cameraRig.position.set(CAM_CENTER.x, 2.05, CAM_CENTER.z);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.16, 0.30), mat(0x2b323b, 0.6, 0.45));
  housing.castShadow = true;
  cameraRig.add(housing);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.10, 20), mat(0x151a20, 0.7, 0.3));
  lens.position.y = -0.13;
  cameraRig.add(lens);
  const glass = new THREE.Mesh(
    new THREE.CircleGeometry(0.048, 20),
    new THREE.MeshStandardMaterial({ color: 0x2a5d8f, emissive: 0x12304d, metalness: 0.9, roughness: 0.1 }),
  );
  glass.rotation.x = -Math.PI / 2;
  glass.position.y = -0.181;
  cameraRig.add(glass);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.135, 0.018, 8, 32),
    new THREE.MeshStandardMaterial({ color: 0xf3f7fb, emissive: 0xd8e8f7, emissiveIntensity: 0.7 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.09;
  cameraRig.add(ring);
  const rec = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xff5b4f, emissive: 0xff3b30, emissiveIntensity: 1 }),
  );
  rec.position.set(0.11, 0.085, 0.10);
  cameraRig.add(rec);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 2.03, 10), mat(0x55606c, 0.7, 0.4));
    post.position.set(sx * 1.05, -1.02, sz * 0.62);
    cameraRig.add(post);
  }
  scene.add(cameraRig);

  // Rückwand mit gelben Schutzpfosten (nur Dekoration).
  const fence = mat(0xc9a52c, 0.25, 0.7);
  for (const x of [-1.85, 1.05]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.3, 12), fence);
    post.position.set(x, 0.65, -1.05);
    post.castShadow = true;
    scene.add(post);
  }

  return {
    scene, beltTexture: texture, bins, binStacks, cameraRig, cameraLens: glass,
    clearBins() {
      for (const stacks of binStacks) {
        for (const stack of stacks) {
          for (const child of [...stack.children]) {
            stack.remove(child);
            const m = child as THREE.Mesh;
            m.geometry?.dispose();
            (m.material as THREE.Material)?.dispose();
          }
        }
      }
    },
  };
}

/** Beschriftung der Körbe für die Anzeige. */
export { BIN_LABELS };
