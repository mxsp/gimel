import * as THREE from "three";
import { box, cyl, mat, glow, spinner, type Palette } from "./kit";
import { cartons, chair, monitor, pallet } from "./props";
import { stackLight, pedestal, type MachineOptions } from "./machines";

/* Versand und Büro (task 37): Packplatz mit angetriebener Rollenbahn,
   Papierabroller, Waage, Etikettendrucker und Palettenplatz; Büro als
   Schreibtischinsel mit Stühlen, Bildschirmen, Trennwand und Schrank. */

/** Packplatz: Tisch, Rollenbahn (Rollen drehen um ihre eigene Achse), Kartons, Folie. */
export function packing(p: Palette, w: number, d: number, o: MachineOptions): THREE.Group {
  const g = new THREE.Group();
  const dark = mat(p.paintDark, "satin");
  const steel = mat(p.steel, "metal");
  const tableW = Math.min(2.0, w * 0.48), tableD = Math.min(0.9, d * 0.42);
  const tx = -w / 2 + tableW / 2 + 0.1, tz = -d / 2 + tableD / 2 + 0.12;
  box(g, tableW, 0.04, tableD, tx, 0.9, tz, mat(p.wood, "wood"), 0.01);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.05, 0.88, 0.05, tx + sx * (tableW / 2 - 0.05), 0.44, tz + sz * (tableD / 2 - 0.05), dark);
  box(g, tableW - 0.1, 0.03, tableD - 0.1, tx, 0.25, tz, dark);
  // Aufbau mit Papierrolle und Bildschirm.
  for (const sx of [-1, 1]) box(g, 0.04, 0.8, 0.04, tx + sx * (tableW / 2 - 0.06), 1.3, tz - tableD / 2 + 0.06, steel);
  box(g, tableW - 0.08, 0.03, 0.3, tx, 1.68, tz - tableD / 2 + 0.16, steel);
  spinner(g, 0.11, tableW * 0.8, tx, 1.45, tz - tableD / 2 + 0.14, mat("#b08a5c", "carton"), "x", 0.6);
  monitor(g, p, tx + tableW * 0.28, 0.92, tz - tableD * 0.12, 0, 0.42);
  box(g, 0.32, 0.18, 0.28, tx - tableW * 0.3, 1.01, tz - tableD * 0.1, mat(p.paint, "plastic"), 0.02); // Etikettendrucker
  box(g, 0.4, 0.04, 0.32, tx + tableW * 0.02, 0.94, tz + tableD * 0.16, mat(p.steel, "metal"), 0.01);  // Waage
  cartons(g, p, tx - tableW * 0.12, 0.92, tz + tableD * 0.05, 0.5, 0.36, 1, 1);
  // Rollenbahn vom Tisch zum Versand: Rahmen, Rollen, ein Karton unterwegs.
  const cw = Math.max(0.6, w - tableW - 0.5), cx = tx + tableW / 2 + cw / 2 + 0.05;
  const cz = tz;
  for (const sz of [-1, 1]) box(g, cw, 0.1, 0.05, cx, 0.82, cz + sz * 0.3, mat(p.steel, "metal", "brushed", [3, 1]));
  for (let i = 0; i < Math.floor(cw / 0.6) + 1; i++) {
    for (const sz of [-1, 1]) box(g, 0.05, 0.78, 0.05, cx - cw / 2 + 0.05 + i * ((cw - 0.1) / Math.max(1, Math.floor(cw / 0.6))), 0.39, cz + sz * 0.3, dark);
  }
  const rollers = Math.max(4, Math.floor(cw / 0.12));
  for (let i = 0; i < rollers; i++) {
    spinner(g, 0.03, 0.56, cx - cw / 2 + 0.06 + i * ((cw - 0.12) / (rollers - 1)), 0.86, cz, steel, "z", 6, i * 0.3, 10);
  }
  cartons(g, p, cx - cw * 0.15, 0.89, cz, 0.42, 0.34, 1, 2);
  box(g, 0.25, 0.3, 0.25, cx + cw / 2 - 0.15, 1.25, cz - 0.35, dark, 0.02); // Lichtschranke/Scanner
  box(g, 0.2, 0.02, 0.02, cx + cw / 2 - 0.15, 1.12, cz - 0.22, glow("#cd4246"));
  // Palettenplatz und Stretchfolienständer vorn.
  if (d > 1.6) {
    const px = tx + 0.2, pz = d / 2 - 0.5;
    pallet(g, p, px, 0, Math.min(pz, d / 2 - 0.45));
    cartons(g, p, px, 0.144, Math.min(pz, d / 2 - 0.45), 1.1, 0.75, 2, 3);
    cyl(g, 0.03, 0.03, 1.5, px + 0.95, 0.75, Math.min(pz, d / 2 - 0.45), steel, "y", 8);
    cyl(g, 0.07, 0.07, 0.5, px + 0.95, 1.0, Math.min(pz, d / 2 - 0.45) - 0.08, mat("#dfe6ec", "plastic"), "y", 12);
  }
  if (o.screen) pedestal(g, p, cx + cw / 2 - 0.2, cz + 0.6, -0.3, o.screen);
  stackLight(g, p, cx + cw / 2 - 0.05, 0.92, cz + 0.3, o.status);
  return g;
}

/** Bürofläche: Schreibtische (Insel ab 3,5 m Breite), Stühle, Bildschirme, Trennwand, Schrank. */
export function office(p: Palette, w: number, d: number, o: MachineOptions): THREE.Group {
  const g = new THREE.Group();
  const top = mat(p.wood, "wood");
  const frame = mat(p.paintDark, "satin");
  const deskW = 1.6, deskD = 0.8;
  const cols = Math.max(1, Math.min(3, Math.floor((w - 0.8) / deskW)));
  const facing = d >= 2.4 ? 2 : 1;
  const span = cols * deskW;
  for (let side = 0; side < facing; side++) {
    const sz = facing === 2 ? (side ? 1 : -1) : 0;
    const z = sz * (deskD / 2 + 0.02);
    for (let c = 0; c < cols; c++) {
      const x = -span / 2 + deskW / 2 + c * deskW - (w > span + 1.2 ? 0.4 : 0);
      box(g, deskW - 0.04, 0.03, deskD, x, 0.74, z, top, 0.01);
      for (const sx of [-1, 1]) box(g, 0.05, 0.72, deskD - 0.1, x + sx * (deskW / 2 - 0.06), 0.36, z, frame);
      // Wer sitzt, sitzt außen und schaut zur Mitte; der Bildschirm schaut zurück.
      const out = sz < 0 ? -1 : 1;
      monitor(g, p, x, 0.755, z - out * 0.15, out > 0 ? Math.PI : 0, 0.56);
      box(g, 0.44, 0.02, 0.14, x, 0.76, z + out * 0.12, mat(p.paintDark, "plastic"));
      chair(g, p, x + 0.1, z + out * (deskD / 2 + 0.38), out > 0 ? 0 : Math.PI);
    }
  }
  if (facing === 2) box(g, span - 0.1, 0.45, 0.04, -(w > span + 1.2 ? 0.4 : 0), 0.98, 0, mat(p.work, "matte"), 0.02);
  // Aktenschrank und Pflanze am Rand.
  const ex = w / 2 - 0.35;
  if (ex > span / 2 - (w > span + 1.2 ? 0.4 : 0) + 0.3) {
    box(g, 0.5, 1.2, 0.45, ex, 0.6, -d / 2 + 0.3, mat(p.steel, "satin"), 0.02);
    for (let i = 0; i < 3; i++) box(g, 0.44, 0.01, 0.005, ex, 0.3 + i * 0.36, -d / 2 + 0.525, frame);
    cyl(g, 0.17, 0.14, 0.4, ex, 0.2, d / 2 - 0.3, mat("#ece7dd", "matte"), "y", 12);
    const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 0), mat("#4f7d4a", "matte"));
    leaves.position.set(ex, 0.75, d / 2 - 0.3);
    g.add(leaves);
  }
  stackLight(g, p, -w / 2 + 0.15, 0, -d / 2 + 0.15, o.status);
  return g;
}
