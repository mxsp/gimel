import * as THREE from "three";
import { box, cyl, group, mat, glow, glowOwn, clear, spinner, tube, moves, type Palette } from "./kit";
import { bin, glowScreen, monitor } from "./props";

/* Fertigungsmaschinen, halbrealistisch (task 37).

   Koordinaten: x entlang der Stationsbreite `w`, z entlang der Tiefe `d`,
   Bedienseite vorn bei +z. Die Modelle füllen die Fläche; die Passung in
   `deviceModels.fitDeviceToFootprint` schrumpft sie nur, falls nötig.
   Bewegte Teile (Portal, Kopf, Stempel, Revolver, Walzen) tragen
   `userData.motion`; die 3D-Schleife bewegt sie nur bei laufender Station. */

/** Dieselben Töne wie die Statuskanten der Karte. */
export const STATUS_LAMP: Record<string, string> = {
  laeuft: "#4a9d6e",
  wartet: "#1668ac",
  frei: "#4a9d6e",
  voll: "#ca9c19",
  ueber: "#cd4246",
  unbekannt: "#5f6b7c",
  inaktiv: "#5f6b7c",
};

/** Welches Segment der Signalsäule leuchtet. Ohne Status leuchtet keins, und
 *  „frei" auch nicht: Grün heißt in der Halle „läuft". */
const SEGMENT: Record<string, number> = { ueber: 0, voll: 1, laeuft: 2, wartet: 3 };
const SEGMENT_COLOURS = ["#cd4246", "#ca9c19", "#4a9d6e", "#1668ac"];

export interface MachineOptions {
  status?: string;
  running?: boolean;
  /** Material für den Bildschirm am Bedienpult (z. B. mit Auftragsnummer). */
  screen?: THREE.Material;
}

/**
 * Signalsäule (Andon) mit vier Segmenten: rot, gelb, grün, blau. Leuchtet das
 * Segment des Stationszustands; das leuchtende Segment trägt einen eigenen
 * Werkstoff und eine Bewegung (ruhiges Pulsieren bei laufender Station).
 */
export function stackLight(parent: THREE.Object3D, p: Palette, x: number, y: number, z: number,
                           status?: string): THREE.Group {
  const g = group(parent, x, y, z);
  g.name = "stack-light";
  cyl(g, 0.05, 0.06, 0.05, 0, 0.025, 0, mat(p.paintDark, "satin"), "y", 12);
  cyl(g, 0.016, 0.016, 0.42, 0, 0.26, 0, mat(p.steel, "metal"), "y", 8);
  const lit = status ? SEGMENT[status] : undefined;
  for (let i = 0; i < 4; i++) {
    const yy = 0.52 + (3 - i) * 0.085;
    if (i === lit) {
      const seg = cyl(g, 0.045, 0.045, 0.08, 0, yy, 0, glowOwn(STATUS_LAMP[status!] ?? SEGMENT_COLOURS[i]), "y", 14);
      seg.userData.motion = { kind: "beacon", phase: 0 };
      seg.userData.farKeep = true;
      seg.scale.set(1.25, 1, 1.25);
    } else {
      const dim = new THREE.Color(SEGMENT_COLOURS[i]).lerp(new THREE.Color(p.paintDark), 0.62);
      cyl(g, 0.045, 0.045, 0.08, 0, yy, 0, mat(`#${dim.getHexString()}`, "plastic"), "y", 14);
    }
  }
  cyl(g, 0.04, 0.045, 0.03, 0, 0.88, 0, mat(p.paintDark, "satin"), "y", 12);
  return g;
}

/** Bedienpult auf Säule mit geneigtem Bildschirm. */
export function pedestal(parent: THREE.Object3D, p: Palette, x: number, z: number, ry = 0,
                         screen?: THREE.Material, height = 1.15): THREE.Group {
  const g = group(parent, x, 0, z, ry);
  g.name = "pedestal";
  box(g, 0.34, 0.04, 0.34, 0, 0.02, 0, mat(p.paintDark, "satin"), 0.01);
  box(g, 0.1, height - 0.2, 0.1, 0, (height - 0.2) / 2, 0, mat(p.steel, "metal"), 0.02);
  const head = group(g, 0, height - 0.08, 0);
  head.rotation.x = -0.45;
  box(head, 0.5, 0.36, 0.08, 0, 0, 0, mat(p.paintDark, "satin"), 0.025);
  const display = box(head, 0.42, 0.26, 0.006, 0, 0.02, 0.043, screen ?? glow(p.screen, "screen"));
  display.name = "job-screen";
  display.userData.farKeep = false;
  for (let i = 0; i < 3; i++) cyl(head, 0.018, 0.018, 0.02, -0.12 + i * 0.12, -0.15, 0.045, mat(i === 0 ? "#cd4246" : p.steel, "plastic"), "z", 10);
  return g;
}

function feet(parent: THREE.Object3D, p: Palette, xs: number[], zs: number[]): void {
  const m = mat(p.paintDark, "satin");
  for (const x of xs) for (const z of zs) cyl(parent, 0.06, 0.07, 0.06, x, 0.03, z, m, "y", 10);
}

/** Flachbett-Schneidplotter: Tisch mit Vakuum, Portal, Kopf, Energiekette, Rolle. */
export function plotter(p: Palette, w: number, d: number, o: MachineOptions): THREE.Group {
  const g = new THREE.Group();
  const L = w * 0.84, D = d * 0.74;
  const paint = mat(p.paint, "paint");
  const dark = mat(p.paintDark, "satin");
  const steel = mat(p.steel, "metal", "brushed", [2, 1]);
  const accent = mat(p.accent, "paint");
  feet(g, p, [-L / 2 + 0.15, 0, L / 2 - 0.15], [-D / 2 + 0.15, D / 2 - 0.15]);
  box(g, L, 0.7, D * 0.92, 0, 0.41, 0, paint, 0.03);
  box(g, L + 0.002, 0.07, D * 0.92 + 0.002, 0, 0.66, 0, accent, 0.01);
  box(g, L * 0.3, 0.42, 0.01, -L * 0.25, 0.38, D * 0.46 + 0.004, mat(p.paint, "paint", "vents"));
  box(g, L, 0.05, D, 0, 0.785, 0, dark, 0.01);
  box(g, L - 0.12, 0.012, D - 0.12, 0, 0.816, 0, mat("#8c949c", "matte", "vacuum", [L * 2.5, D * 2.5]));
  // Werkstück nur bei laufender Station: eine aufgelegte Platte hieße sonst „in Arbeit".
  if (o.running) {
    box(g, L * 0.52, 0.006, D * 0.66, -L * 0.12, 0.825, 0, mat(p.rubber, "matte"));
    box(g, L * 0.12, 0.007, D * 0.2, -L * 0.2, 0.826, -D * 0.12, mat("#8c949c", "matte", "vacuum", [1, 1]));
  }
  for (const sz of [-1, 1]) box(g, L, 0.05, 0.07, 0, 0.84, sz * (D / 2 - 0.03), steel);
  // Energiekette hinten entlang der Länge.
  box(g, L * 0.62, 0.07, 0.16, -L * 0.18, 0.87, -D / 2 - 0.1, dark, 0.01);
  box(g, L * 0.6, 0.06, 0.11, -L * 0.18, 0.93, -D / 2 - 0.1, mat(p.rubber, "rubber", "tread", [L * 3, 1]), 0.01);

  const gantry = group(g, 0, 0, 0);
  moves(gantry, "gantry", { amp: L * 0.3, speed: 0.55 });
  for (const sz of [-1, 1]) box(gantry, 0.34, 0.34, 0.16, 0, 1.02, sz * (D / 2 - 0.02), paint, 0.03);
  box(gantry, 0.24, 0.26, D + 0.14, 0, 1.25, 0, accent, 0.04);
  box(gantry, 0.26, 0.04, D + 0.1, 0, 1.39, 0, paint, 0.01);
  box(gantry, 0.12, 0.05, D * 0.7, 0.16, 1.42, 0, mat(p.rubber, "rubber"), 0.01);
  const head = group(gantry, 0, 0, 0);
  moves(head, "head", { amp: D * 0.3, speed: 1.3 });
  box(head, 0.3, 0.36, 0.28, -0.2, 1.16, 0, paint, 0.035);
  box(head, 0.302, 0.05, 0.282, -0.2, 1.06, 0, accent, 0.01);
  cyl(head, 0.06, 0.05, 0.18, -0.2, 0.93, 0, dark, "y", 12);
  spinner(head, 0.018, 0.08, -0.2, 0.85, 0, steel, "y", 22);

  // Materialrolle am Kopfende, Halter links und rechts.
  for (const sz of [-1, 1]) box(g, 0.08, 0.6, 0.06, L / 2 + 0.16, 0.3, sz * (D * 0.42), dark, 0.01);
  spinner(g, 0.15, D * 0.8, L / 2 + 0.16, 0.6, 0, mat(p.carton, "carton"), "z", 0.9);
  pedestal(g, p, L / 2 - 0.25, D / 2 + 0.22, -0.4, o.screen);
  stackLight(g, p, -L / 2 + 0.2, 0.82, -D / 2 + 0.2, o.status);
  return g;
}

/** Wasserstrahlanlage: Becken mit Rost, Portal mit Schneidkopf, Pumpe, Sandtrichter. */
export function waterjet(p: Palette, w: number, d: number, o: MachineOptions): THREE.Group {
  const g = new THREE.Group();
  const pumpW = Math.min(1.3, w * 0.24);
  const L = Math.max(w * 0.56, w * 0.94 - pumpW - 0.15), D = d * 0.74;
  const tx = -w * 0.47 + L / 2;
  const paint = mat(p.paint, "paint");
  const dark = mat(p.paintDark, "satin");
  const steel = mat(p.steel, "metal", "brushed", [2, 1]);
  const accent = mat(p.accent, "paint");
  // Becken: Wanne, Rand, Wasser und Gitterrost.
  box(g, L, 0.72, D, tx, 0.36, 0, dark, 0.02);
  for (const sz of [-1, 1]) box(g, L + 0.04, 0.06, 0.08, tx, 0.74, sz * (D / 2), steel);
  for (const sx of [-1, 1]) box(g, 0.08, 0.06, D, tx + sx * (L / 2), 0.74, 0, steel);
  box(g, L - 0.12, 0.012, D - 0.12, tx, 0.69, 0, clear(p.water, 0.62));
  box(g, L - 0.14, 0.02, D - 0.14, tx, 0.72, 0, mat("#6d7882", "metal", "grate", [L * 2.2, 1]));
  box(g, L * 0.4, 0.008, D * 0.55, tx - L * 0.12, 0.735, 0, mat("#9aa4ad", "metal"));
  for (const sz of [-1, 1]) box(g, L, 0.12, 0.16, tx, 0.83, sz * (D / 2 - 0.04), steel);
  // Energiekette außen hinten.
  box(g, L * 0.7, 0.08, 0.16, tx - L * 0.12, 0.84, -D / 2 - 0.13, dark, 0.01);

  const gantry = group(g, tx, 0, 0);
  moves(gantry, "gantry", { amp: L * 0.3, speed: 0.35 });
  for (const sz of [-1, 1]) box(gantry, 0.5, 0.46, 0.24, 0, 1.1, sz * (D / 2 - 0.04), paint, 0.04);
  box(gantry, 0.32, 0.34, D + 0.16, 0, 1.52, 0, accent, 0.05);
  box(gantry, 0.34, 0.05, D + 0.12, 0, 1.71, 0, paint, 0.01);
  cyl(gantry, 0.16, 0.05, 0.32, 0.08, 1.92, D / 2 - 0.1, paint, "y", 14); // Sandtrichter
  const head = group(gantry, 0, 0, 0);
  moves(head, "head", { amp: D * 0.3, speed: 0.9 });
  box(head, 0.3, 0.62, 0.3, -0.26, 1.42, 0, paint, 0.04);
  box(head, 0.302, 0.06, 0.302, -0.26, 1.2, 0, accent, 0.01);
  cyl(head, 0.045, 0.02, 0.36, -0.26, 0.98, 0, steel, "y", 10);
  tube(head, [[-0.26, 1.74, 0], [-0.1, 1.95, 0], [0.08, 1.82, 0]], 0.025, mat(p.rubber, "rubber"));

  // Hochdruckpumpe am Kopfende: Schrank, Motor, Speicher, Leitung.
  const px = w * 0.47 - pumpW / 2;
  box(g, pumpW, 1.25, D * 0.62, px, 0.66, -D * 0.12, paint, 0.04);
  box(g, pumpW * 0.8, 0.5, 0.01, px, 0.6, D * 0.19 + 0.006, mat(p.paint, "paint", "vents"));
  box(g, pumpW + 0.004, 0.08, D * 0.62 + 0.004, px, 1.2, -D * 0.12, accent, 0.01);
  cyl(g, 0.2, 0.2, pumpW * 0.7, px, 1.5, -D * 0.12, dark, "x", 16);
  cyl(g, 0.09, 0.09, 0.6, px - pumpW * 0.3, 1.58, D * 0.1, steel, "y", 12);
  tube(g, [[px - pumpW * 0.3, 1.86, D * 0.1], [px - pumpW * 0.6, 1.4, -D * 0.3], [tx + L * 0.25, 0.95, -D / 2 - 0.13]], 0.022, mat(p.rubber, "rubber"));
  feet(g, p, [px - pumpW / 2 + 0.1, px + pumpW / 2 - 0.1], [-D * 0.4, D * 0.15]);
  // Spritzschutz vorn.
  box(g, L * 0.96, 0.42, 0.012, tx, 1.0, D / 2 + 0.03, clear(p.glass, 0.24));
  pedestal(g, p, tx + L * 0.32, D / 2 + 0.28, -0.3, o.screen);
  stackLight(g, p, px + pumpW / 2 - 0.12, 1.28, D * 0.12, o.status);
  return g;
}

/** Revolverstanze: C-Gestell, Ober- und Unterrevolver, Stempel, Bürstentisch, Lichtvorhang. */
export function punch(p: Palette, w: number, d: number, o: MachineOptions): THREE.Group {
  const g = new THREE.Group();
  const paint = mat(p.paint, "paint");
  const dark = mat(p.paintDark, "satin");
  const steel = mat(p.steel, "metal", "brushed", [2, 1]);
  const accent = mat(p.accent, "paint");
  const fw = Math.min(1.5, w * 0.4);
  const zBack = -d * 0.4, zArm = -d * 0.14, armD = d * 0.5;
  box(g, fw + 0.1, 0.22, armD + 0.5, 0, 0.11, zArm - 0.1, dark, 0.02);
  box(g, fw, 0.6, armD, 0, 0.52, zArm, paint, 0.05);
  box(g, fw, 1.52, 0.5, 0, 1.0, zBack, paint, 0.05);
  box(g, fw, 0.5, armD, 0, 1.82, zArm, paint, 0.05);
  for (const sx of [-1, 1]) {
    box(g, 0.012, 0.14, armD * 0.9, sx * (fw / 2 + 0.004), 1.82, zArm, accent);
    box(g, 0.012, 0.14, armD * 0.9, sx * (fw / 2 + 0.004), 0.52, zArm, accent);
  }
  const tz = zArm + armD * 0.28;
  const turret = group(g, 0, 0, tz);
  moves(turret, "turret", { speed: 0.6 });
  for (const yy of [0.88, 1.5]) {
    cyl(turret, 0.44, 0.44, 0.1, 0, yy, 0, steel, "y", 24);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      cyl(turret, 0.05, 0.05, 0.12, Math.cos(a) * 0.33, yy, Math.sin(a) * 0.33, dark, "y", 8);
    }
  }
  cyl(g, 0.17, 0.17, 0.4, 0, 2.27, tz + 0.3, dark, "y", 16);
  const ram = cyl(g, 0.07, 0.07, 0.36, 0, 1.3, tz + 0.3, steel, "y", 12);
  moves(ram, "ram", { amp: 0.09, speed: 5 });
  // Bürstentisch vorn, Querschlitten mit Pratzen und Blech.
  const tableZ = d * 0.22, tableD = d * 0.46;
  box(g, w * 0.9, 0.06, tableD, 0, 0.84, tableZ, mat("#4a4f55", "matte", "brush", [w * 4, tableD * 4]), 0.01);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.07, 0.8, 0.07, sx * (w * 0.43), 0.41, tableZ + sz * (tableD / 2 - 0.06), dark);
  const carriage = group(g, 0, 0, 0);
  moves(carriage, "carriage", { amp: w * 0.12, speed: 0.9 });
  box(carriage, w * 0.62, 0.1, 0.14, 0, 0.92, tableZ + tableD / 2 - 0.1, accent, 0.02);
  for (const sx of [-0.18, 0.18]) box(carriage, 0.12, 0.08, 0.16, sx * w, 0.9, tableZ + tableD / 2 - 0.22, dark, 0.01);
  if (o.running) box(carriage, w * 0.5, 0.005, tableD * 0.8 + armD * 0.2, 0, 0.885, tableZ - armD * 0.08, mat(p.rubber, "matte"));
  // Lichtvorhang an den Ecken vorn.
  for (const sx of [-1, 1]) box(g, 0.05, 1.25, 0.05, sx * (w * 0.46), 0.63, d * 0.47, mat(p.safety, "paint"), 0.01);
  // Schrottbehälter unter dem Gestell.
  box(g, 0.6, 0.4, 0.5, fw / 2 + 0.45, 0.2, zBack + 0.1, mat(p.paintDark, "matte"), 0.02);
  pedestal(g, p, -w * 0.4, d * 0.02, 0.5, o.screen);
  stackLight(g, p, fw / 2 - 0.12, 2.07, zBack, o.status);
  return g;
}

/** Handarbeitsplatz: Werkbank, Schraubstock, Lochwand, Leuchte, Kisten, Werkzeugwagen, Matte. */
export function workbench(p: Palette, w: number, d: number, o: MachineOptions): THREE.Group {
  const g = new THREE.Group();
  const steel = mat(p.steel, "metal");
  const dark = mat(p.paintDark, "satin");
  const benchW = w * 0.72, benchD = Math.min(0.85, d * 0.4), bz = -d * 0.2;
  box(g, benchW, 0.05, benchD, -w * 0.08, 0.9, bz, mat(p.wood, "wood"), 0.01);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.06, 0.88, 0.06, -w * 0.08 + sx * (benchW / 2 - 0.06), 0.44, bz + sz * (benchD / 2 - 0.06), dark);
  box(g, benchW - 0.1, 0.03, benchD - 0.1, -w * 0.08, 0.22, bz, dark);
  box(g, benchW, 0.95, 0.03, -w * 0.08, 1.42, bz - benchD / 2 + 0.02, mat(p.paint, "matte", "perforated", [benchW * 4, 4]));
  const tools = [p.accent, p.paintDark, "#c8312f", p.steel];
  tools.forEach((c, i) => box(g, 0.05, 0.26 + (i % 2) * 0.1, 0.03, -w * 0.08 - benchW * 0.3 + i * benchW * 0.18, 1.5, bz - benchD / 2 + 0.05, mat(c, "satin"), 0.01));
  // Schraubstock.
  box(g, 0.2, 0.08, 0.26, -w * 0.08 - benchW * 0.36, 0.965, bz + benchD * 0.18, dark, 0.01);
  box(g, 0.2, 0.12, 0.05, -w * 0.08 - benchW * 0.36, 1.03, bz + benchD * 0.3, steel);
  box(g, 0.2, 0.12, 0.05, -w * 0.08 - benchW * 0.36, 1.03, bz + benchD * 0.08, steel);
  // Kisten hinten auf der Bank.
  ["#2f6fb0", "#c8312f", "#f2c230", "#2f6fb0"].forEach((c, i) => bin(g, c, -w * 0.08 + benchW * 0.05 + i * 0.32, 0.925, bz - benchD * 0.22, 0.28, 0.2, 0.14));
  // Arbeitsleuchte am Gelenkarm.
  cyl(g, 0.015, 0.015, 0.6, -w * 0.08 + benchW * 0.4, 1.22, bz - benchD * 0.35, steel, "y", 8);
  const lamp = cyl(g, 0.06, 0.13, 0.12, -w * 0.08 + benchW * 0.3, 1.5, bz - benchD * 0.1, dark, "y", 14);
  lamp.rotation.z = 0.3;
  box(g, 0.16, 0.005, 0.16, -w * 0.08 + benchW * 0.29, 1.435, bz - benchD * 0.1, glow("#fff4d6"));
  // Bildschirm mit der Zeichnung, Werkzeugwagen, Matte.
  monitor(g, p, -w * 0.08 + benchW * 0.18, 0.925, bz - benchD * 0.05, 0, 0.42);
  box(g, 0.6, 0.85, 0.45, w * 0.38, 0.5, bz + 0.1, mat("#c8312f", "paint"), 0.02);
  for (let i = 0; i < 4; i++) box(g, 0.56, 0.012, 0.005, w * 0.38, 0.3 + i * 0.17, bz + 0.33, dark);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(g, 0.04, 0.04, 0.03, w * 0.38 + sx * 0.24, 0.04, bz + 0.1 + sz * 0.17, mat(p.rubber, "rubber"), "z", 10);
  box(g, benchW * 0.9, 0.014, Math.min(0.8, d * 0.3), -w * 0.08, 0.007, bz + benchD / 2 + Math.min(0.4, d * 0.15), mat(p.rubber, "rubber", "tread", [benchW * 3, 2]));
  stackLight(g, p, -w * 0.08 + benchW / 2 - 0.06, 0.925, bz - benchD / 2 + 0.08, o.status);
  if (o.screen) pedestal(g, p, -w * 0.08 - benchW / 2 - 0.2, bz + benchD / 2 + 0.2, 0.4, o.screen);
  return g;
}

/** Eine unbekannte Maschine: Kabine mit Sichtfenster, Tür, Pult und Signalsäule. */
export function genericMachine(p: Palette, w: number, d: number, o: MachineOptions): THREE.Group {
  const g = new THREE.Group();
  const paint = mat(p.paint, "paint");
  const dark = mat(p.paintDark, "satin");
  const L = w * 0.82, D = d * 0.72;
  box(g, L + 0.06, 0.12, D + 0.06, 0, 0.06, 0, dark, 0.01);
  box(g, L, 1.6, D, 0, 0.92, 0, paint, 0.06);
  box(g, L + 0.004, 0.1, D + 0.004, 0, 1.6, 0, mat(p.accent, "paint"), 0.01);
  box(g, L * 0.46, 0.6, 0.012, -L * 0.12, 1.05, D / 2 + 0.007, clear(p.glass, 0.45));
  box(g, L * 0.48, 0.64, 0.01, -L * 0.12, 1.05, D / 2 + 0.003, dark);
  box(g, 0.03, 0.22, 0.04, L * 0.14, 1.0, D / 2 + 0.03, mat(p.steel, "metal"));
  box(g, L * 0.2, 0.4, 0.01, L * 0.3, 0.5, D / 2 + 0.006, mat(p.paint, "paint", "vents"));
  pedestal(g, p, L / 2 + 0.05, D / 2 + 0.15, -0.5, o.screen);
  stackLight(g, p, -L / 2 + 0.15, 1.72, -D / 2 + 0.15, o.status);
  return g;
}

export { glowScreen };
