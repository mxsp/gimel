import * as THREE from "three";
import { box, cyl, group, mat, clear, wire, moves, type Palette } from "./kit";

/* Kleinteile, die Regale, Packtische und die Belebung teilen: Palette,
   Kartons, Kleinladungsträger, Gitterbox, Hubwagen, Feuerlöscher, Figur und
   Stapler. Alle Maße in Metern, Ursprung auf dem Boden in der Mitte. */

/** Europalette 1,2 × 0,8 × 0,144 m; `rot` dreht sie um 90°. */
export function pallet(parent: THREE.Object3D, p: Palette, x: number, y: number, z: number, rot = false): THREE.Group {
  const g = group(parent, x, y, z, rot ? Math.PI / 2 : 0);
  const wood = mat(p.wood, "wood");
  const L = 1.2, W = 0.8;
  for (let i = 0; i < 5; i++) box(g, L, 0.022, 0.1, 0, 0.133, -W / 2 + 0.05 + i * ((W - 0.1) / 4), wood);
  for (const zz of [-W / 2 + 0.05, 0, W / 2 - 0.05]) {
    box(g, L, 0.022, 0.1, 0, 0.111, zz, wood);
    for (const xx of [-L / 2 + 0.07, 0, L / 2 - 0.07]) box(g, 0.14, 0.078, 0.1, xx, 0.061, zz, mat(p.wood, "matte"));
    box(g, L, 0.022, 0.1, 0, 0.011, zz, wood);
  }
  return g;
}

/** Ein Kartonstapel auf einer Fläche; `layers` Lagen zu 2 × 2. */
export function cartons(parent: THREE.Object3D, p: Palette, x: number, y: number, z: number,
                        w = 1.1, d = 0.75, layers = 3, seed = 0): THREE.Group {
  const g = group(parent, x, y, z);
  const card = mat(p.carton, "carton", "carton");
  const h = 0.3;
  for (let l = 0; l < layers; l++) {
    const shrink = l === layers - 1 && seed % 2 ? 1 : 0;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2 - shrink * (i % 2); j++) {
      box(g, w / 2 - 0.02, h - 0.01, d / 2 - 0.02,
        -w / 4 + i * (w / 2), h / 2 + l * h, -d / 4 + j * (d / 2), card);
    }
  }
  return g;
}

/** Palette mit eingewickelter Ware (Stretchfolie). */
export function wrappedLoad(parent: THREE.Object3D, p: Palette, x: number, y: number, z: number,
                            height = 0.9, tint?: string, rot = false): THREE.Group {
  const g = group(parent, x, y, z, rot ? Math.PI / 2 : 0);
  pallet(g, p, 0, 0, 0);
  box(g, 1.16, height, 0.78, 0, 0.144 + height / 2, 0, mat(tint ?? p.carton, "carton", "carton"));
  box(g, 1.19, height * 0.92, 0.81, 0, 0.144 + height * 0.48, 0, clear("#e8eef4", 0.22));
  return g;
}

/** Kleinladungsträger (KLT) 0,4 × 0,3 × 0,22 m. */
export function bin(parent: THREE.Object3D, colourValue: string, x: number, y: number, z: number,
                    w = 0.4, d = 0.3, h = 0.22): THREE.Mesh {
  return box(parent, w, h, d, x, y + h / 2, z, mat(colourValue, "plastic"));
}

/** Gitterbox 1,24 × 0,835 × 0,97 m: Stahlrahmen, Drahtwände, Holzboden. */
export function meshBox(parent: THREE.Object3D, p: Palette, x: number, y: number, z: number, filled = 0.5): THREE.Group {
  const g = group(parent, x, y, z);
  const L = 1.24, W = 0.835, H = 0.97;
  const frame = mat(p.steel, "metal");
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.04, H, 0.04, sx * (L / 2 - 0.02), H / 2, sz * (W / 2 - 0.02), frame);
  for (const sy of [0.06, H - 0.02]) {
    for (const sz of [-1, 1]) box(g, L, 0.03, 0.03, 0, sy, sz * (W / 2 - 0.02), frame);
    for (const sx of [-1, 1]) box(g, 0.03, 0.03, W, sx * (L / 2 - 0.02), sy, 0, frame);
  }
  box(g, L - 0.06, 0.03, W - 0.06, 0, 0.08, 0, mat(p.wood, "wood"));
  const net = wire(p.steel, [5, 4]);
  for (const sz of [-1, 1]) box(g, L - 0.05, H - 0.1, 0.004, 0, H / 2 + 0.03, sz * (W / 2 - 0.02), net);
  for (const sx of [-1, 1]) box(g, 0.004, H - 0.1, W - 0.05, sx * (L / 2 - 0.02), H / 2 + 0.03, 0, net);
  if (filled > 0) box(g, L - 0.12, (H - 0.2) * filled, W - 0.12, 0, 0.1 + ((H - 0.2) * filled) / 2, 0, mat(p.paintDark, "matte"));
  return g;
}

/** Handhubwagen mit Deichsel. */
export function palletJack(parent: THREE.Object3D, p: Palette, x: number, y: number, z: number, ry = 0): THREE.Group {
  const g = group(parent, x, y, z, ry);
  const red = mat(p.forklift, "paint");
  for (const sz of [-0.18, 0.18]) box(g, 1.15, 0.07, 0.16, 0.1, 0.06, sz, red, 0.01);
  box(g, 0.24, 0.32, 0.56, -0.58, 0.2, 0, red, 0.03);
  cyl(g, 0.09, 0.09, 0.08, -0.6, 0.09, 0, mat(p.rubber, "rubber"), "z", 12);
  const handle = cyl(g, 0.018, 0.018, 1.1, -0.84, 0.72, 0, mat(p.paintDark, "satin"));
  handle.rotation.z = 0.32;
  box(g, 0.05, 0.05, 0.28, -1.0, 1.24, 0, mat(p.rubber, "rubber"), 0.01);
  return g;
}

/** Feuerlöscher an der Wand oder Stütze, mit Schild. */
export function extinguisher(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0): THREE.Group {
  const g = group(parent, x, y, z, ry);
  cyl(g, 0.085, 0.085, 0.5, 0, 0.62, 0, mat("#c8312f", "satin"), "y", 12);
  cyl(g, 0.03, 0.05, 0.08, 0, 0.91, 0, mat("#1f2328", "satin"), "y", 8);
  box(g, 0.22, 0.22, 0.01, 0, 1.25, -0.09, mat("#c8312f", "matte"));
  return g;
}

/** Anfahrschutz an einer Stütze: gelb-schwarzer Rahmen. */
export function columnGuard(parent: THREE.Object3D, p: Palette, x: number, z: number, size = 0.6): THREE.Group {
  const g = group(parent, x, 0, z);
  const m = mat(p.safety, "paint", "hazard", [2, 1]);
  const s = size + 0.2;
  for (const sz of [-1, 1]) box(g, s, 0.4, 0.06, 0, 0.2, sz * (s / 2), m, 0.01);
  for (const sx of [-1, 1]) box(g, 0.06, 0.4, s, sx * (s / 2), 0.2, 0, m, 0.01);
  return g;
}

/** Bürostuhl mit Fünfsternfuß. */
export function chair(parent: THREE.Object3D, p: Palette, x: number, z: number, ry = 0): THREE.Group {
  const g = group(parent, x, 0, z, ry);
  const dark = mat(p.paintDark, "satin");
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = box(g, 0.3, 0.03, 0.04, Math.cos(a) * 0.15, 0.06, Math.sin(a) * 0.15, dark);
    leg.rotation.y = -a;
  }
  cyl(g, 0.025, 0.025, 0.36, 0, 0.26, 0, mat(p.steel, "metal"), "y", 8);
  box(g, 0.48, 0.08, 0.46, 0, 0.47, 0, mat(p.work, "matte"), 0.03);
  box(g, 0.44, 0.52, 0.07, 0, 0.8, 0.21, mat(p.work, "matte"), 0.03);
  return g;
}

/** Monitor mit Fuß; der Bildschirm leuchtet. */
export function monitor(parent: THREE.Object3D, p: Palette, x: number, y: number, z: number, ry = 0, w = 0.62): THREE.Group {
  const g = group(parent, x, y, z, ry);
  box(g, 0.24, 0.02, 0.18, 0, 0.01, 0, mat(p.paintDark, "satin"));
  box(g, 0.05, 0.3, 0.04, 0, 0.16, 0.02, mat(p.paintDark, "satin"));
  box(g, w, w * 0.6, 0.04, 0, 0.36, -0.01, mat(p.rubber, "satin"), 0.01);
  box(g, w * 0.93, w * 0.53, 0.004, 0, 0.36, -0.032, glowScreen(p));
  return g;
}

export function glowScreen(p: Palette): THREE.Material {
  // Bildschirme leuchten in jeder Qualitätsstufe gleich.
  const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(p.screen).lerp(new THREE.Color("#ffffff"), 0.55), toneMapped: false });
  m.userData.glow = true;
  return sharedScreen(p.screen, m);
}

const screens = new Map<string, THREE.Material>();
function sharedScreen(key: string, fresh: THREE.Material): THREE.Material {
  const hit = screens.get(key);
  if (hit) { fresh.dispose(); return hit; }
  fresh.userData.shared = true;
  screens.set(key, fresh);
  return fresh;
}

export type WorkerPose = "stand" | "work" | "walk" | "sit";

/**
 * Eine Figur in Arbeitskleidung mit Warnweste und Helm (1,75 m). Bewusst
 * schlicht und ohne Gesicht: sie zeigt Maßstab und Tätigkeit, keine Person.
 * Arme (und beim Gehen die Beine) tragen Bewegungs-Einträge.
 */
export function worker(parent: THREE.Object3D, p: Palette, x: number, z: number, ry = 0,
                       pose: WorkerPose = "work", phase = 0): THREE.Group {
  const g = group(parent, x, 0, z, ry);
  g.name = "staged-worker";
  const cloth = mat(p.work, "matte");
  const vest = mat(p.vest, "satin");
  const stripe = mat("#e9edf2", "satin");
  const head = mat(p.head, "matte");
  const shoe = mat(p.rubber, "rubber");
  const sit = pose === "sit";
  // Stehend 1,80 m mit Helm (1,75 m Mensch), sitzend passend (task 41 I).
  const hip = sit ? 0.5 : 0.86;
  for (const sx of [-1, 1]) {
    const leg = group(g, sx * 0.1, hip, 0);
    if (sit) {
      box(leg, 0.13, 0.13, 0.44, 0, 0, -0.2, cloth, 0.04);
      box(leg, 0.12, 0.44, 0.13, 0, -0.24, -0.4, cloth, 0.04);
      box(leg, 0.12, 0.07, 0.24, 0, -0.47, -0.46, shoe, 0.02);
    } else {
      box(leg, 0.13, 0.8, 0.15, 0, -0.4, 0, cloth, 0.05);
      box(leg, 0.12, 0.07, 0.25, 0, -0.825, -0.04, shoe, 0.02);
      if (pose === "walk") moves(leg, "leg", { phase: phase + (sx > 0 ? Math.PI : 0) });
    }
  }
  box(g, 0.38, 0.56, 0.22, 0, hip + 0.3, 0, cloth, 0.07);
  box(g, 0.4, 0.42, 0.24, 0, hip + 0.34, 0, vest, 0.07);
  for (const yy of [hip + 0.24, hip + 0.42]) box(g, 0.405, 0.035, 0.245, 0, yy, 0, stripe, 0.01);
  cyl(g, 0.11, 0.1, 0.22, 0, hip + 0.73, 0, head, "y", 12);
  // Helm: Kuppel und Schirm.
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat("#f4f6f8", "plastic"));
  helmet.position.set(0, hip + 0.82, 0);
  g.add(helmet);
  box(g, 0.24, 0.02, 0.1, 0, hip + 0.82, -0.14, mat("#f4f6f8", "plastic"), 0.008);
  for (const sx of [-1, 1]) {
    const arm = group(g, sx * 0.24, hip + 0.54, 0);
    // Die Figur schaut nach −z; ein positiver Winkel um x hebt den Arm nach vorn.
    const reach = pose === "work" ? 0.9 : pose === "sit" ? 0.6 : 0;
    arm.rotation.x = reach;
    box(arm, 0.1, 0.6, 0.11, 0, -0.3, 0, cloth, 0.04);
    box(arm, 0.09, 0.1, 0.1, 0, -0.63, 0, mat(p.rubber, "rubber"), 0.03);
    if (pose === "work") moves(arm, "arm", { phase: phase + (sx > 0 ? 1.3 : 0), base: reach });
    else if (pose === "walk") moves(arm, "arm", { phase: phase + (sx > 0 ? 0 : Math.PI), base: 0, amp: 0.35 });
  }
  return g;
}

/**
 * Frontstapler (ca. 2,3 × 1,1 m) mit Hubmast, Gabeln, Schutzdach und Fahrer.
 * Die Gabel trägt auf Wunsch eine Palette (`loaded`); sie hängt in der Gruppe
 * „forks" und fährt mit ihr hoch und runter.
 */
export function forklift(parent: THREE.Object3D, p: Palette, x: number, z: number, ry = 0, loaded = false): THREE.Group {
  const g = group(parent, x, 0, z, ry);
  g.name = "staged-forklift";
  const body = mat(p.forklift, "paint");
  const dark = mat(p.paintDark, "satin");
  const rubber = mat(p.rubber, "rubber");
  const steel = mat(p.steel, "metal");
  // Fahrgestell: Front zeigt nach −x (zur Gabel).
  box(g, 1.45, 0.55, 1.02, 0.15, 0.48, 0, body, 0.08);
  box(g, 0.5, 0.75, 1.0, 0.7, 0.62, 0, dark, 0.1);       // Gegengewicht
  box(g, 0.6, 0.12, 0.9, 0.05, 0.82, 0, dark, 0.03);     // Bodenplatte
  for (const [wx, wr] of [[-0.42, 0.27], [0.62, 0.22]] as const) {
    for (const sz of [-1, 1]) {
      const wheel = cyl(g, wr, wr, 0.2, wx, wr, sz * 0.5, rubber, "z", 16);
      wheel.userData.farKeep = true;
    }
  }
  // Sitz, Lenkrad, Fahrer.
  box(g, 0.45, 0.12, 0.45, 0.32, 0.98, 0, dark, 0.04);
  box(g, 0.45, 0.45, 0.1, 0.52, 1.2, 0, dark, 0.04);
  const wheel = cyl(g, 0.16, 0.16, 0.03, -0.12, 1.22, 0, dark, "y", 16);
  wheel.rotation.z = 0.7;
  const driver = worker(g, p, 0.3, 0, Math.PI / 2, "sit");
  driver.position.y = 0.52;
  // Schutzdach.
  for (const [px, pz] of [[-0.32, -0.46], [-0.32, 0.46], [0.66, -0.46], [0.66, 0.46]]) {
    box(g, 0.06, 1.35, 0.06, px, 1.45, pz, dark);
  }
  box(g, 1.06, 0.05, 1.0, 0.17, 2.14, 0, dark, 0.01);
  for (let i = 0; i < 4; i++) box(g, 0.04, 0.04, 0.96, -0.24 + i * 0.27, 2.17, 0, steel);
  // Hubmast und Gabel.
  for (const sz of [-0.32, 0.32]) box(g, 0.1, 2.2, 0.08, -0.72, 1.12, sz, steel);
  box(g, 0.08, 0.08, 0.72, -0.72, 2.2, 0, steel);
  const forks = group(g, -0.8, 0.08, 0);
  forks.name = "forks";
  box(forks, 0.06, 0.62, 0.86, 0, 0.32, 0, dark);
  for (const sz of [-0.22, 0.22]) box(forks, 1.15, 0.045, 0.12, -0.6, 0.02, sz, steel);
  if (loaded) wrappedLoad(forks, p, -0.62, 0.05, 0, 0.7, undefined, false);
  // Warnleuchte auf dem Dach.
  cyl(g, 0.06, 0.06, 0.08, 0.6, 2.22, 0, mat("#f29a1c", "plastic"), "y", 10);
  return g;
}
