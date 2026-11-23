import * as THREE from "three";
import { box, group, mat, type Palette } from "./kit";
import { bin, cartons, columnGuard, meshBox, monitor, pallet, palletJack, wrappedLoad } from "./props";
import { stackLight, type MachineOptions } from "./machines";

/* Lager in sechs Gestalten (task 37). Welche ein Lagerplatz bekommt, steht im
   Kurzzeichen (`subtype`), sonst im Namen; ohne Treffer ein Fachbodenregal
   bzw. ein Palettenregal für Lagerplätze mit `is_storage`.

   Alle Bauten liegen intern mit der Längsachse auf x; ist die Station tiefer
   als breit, dreht die äußere Gruppe um 90°. */

export type StorageKind =
  | "plattenregal" | "hochregal" | "kommissionierung" | "wareneingang"
  | "leergut" | "archiv" | "kleinteile" | "langzeit" | "regal";

const RULES: [RegExp, StorageKind][] = [
  [/platte/, "plattenregal"],
  [/hochregal|palettenregal/, "hochregal"],
  [/kommission|picking/, "kommissionierung"],
  [/eingang|annahme/, "wareneingang"],
  [/leergut|leerg/, "leergut"],
  [/archiv/, "archiv"],
  [/kleinteil/, "kleinteile"],
  [/langzeit|vorrat/, "langzeit"],
];

export function storageKind(s: { label?: string; subtype?: string; is_storage?: boolean }): StorageKind {
  const sub = (s.subtype || "").toLocaleLowerCase("de-DE");
  for (const [re, kind] of RULES) if (sub && re.test(sub)) return kind;
  const label = (s.label || "").toLocaleLowerCase("de-DE");
  for (const [re, kind] of RULES) if (re.test(label)) return kind;
  return s.is_storage ? "hochregal" : "regal";
}

/** Einfacher, wiederholbarer Zufall je Station (gleiches Bild bei jedem Aufbau). */
function rng(seedText: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  let x = (h >>> 0) || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

const SHEETS = ["#2b2f33", "#3b4148", "#c7a27a", "#b5473a", "#dcd7c9", "#55606b", "#7d5a3c"];
const BIN_COLOURS = ["#2f6fb0", "#2f6fb0", "#2f6fb0", "#c8312f", "#f2c230", "#4a9d6e"];

/** Fachbodenregal: vier Lochpfosten, `levels` Böden. */
function shelfUnit(parent: THREE.Object3D, p: Palette, x: number, z: number, w: number, d: number,
                   h: number, levels: number): number[] {
  const post = mat(p.steel, "metal");
  const shelf = mat(p.paint, "satin");
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(parent, 0.04, h, 0.04, x + sx * (w / 2 - 0.02), h / 2, z + sz * (d / 2 - 0.02), post);
  const ys: number[] = [];
  for (let i = 0; i < levels; i++) {
    const y = 0.12 + (i * (h - 0.2)) / Math.max(1, levels - 1);
    box(parent, w - 0.02, 0.025, d - 0.02, x, y, z, shelf);
    ys.push(y + 0.0125);
  }
  return ys;
}

function sheetRack(p: Palette, L: number, D: number, r: () => number): THREE.Group {
  const g = new THREE.Group();
  const bayW = 2.2;
  const bays = Math.max(1, Math.floor((L - 0.2) / bayW));
  const span = bays * bayW;
  const cd = Math.min(1.75, D * 0.62);
  const upright = mat(p.rack, "paint");
  const front = mat(p.beam, "paint");
  const cassette = mat(p.steel, "metal", "brushed", [2, 1]);
  const levels = 9;
  for (let b = 0; b <= bays; b++) {
    const x = -span / 2 + b * bayW;
    for (const sz of [-1, 1]) box(g, 0.1, 2.85, 0.08, x, 1.425, sz * (cd / 2), upright, 0.01);
    for (let k = 0; k < 4; k++) box(g, 0.05, 0.04, cd, x, 0.4 + k * 0.7, 0, upright);
  }
  for (let b = 0; b < bays; b++) {
    const cx = -span / 2 + b * bayW + bayW / 2;
    for (let l = 0; l < levels; l++) {
      const y = 0.2 + l * 0.29;
      const out = r() < 0.08 ? Math.min(0.9, D / 2 - cd / 2 - 0.05) : 0;
      box(g, bayW - 0.16, 0.035, cd - 0.04, cx, y, out, cassette);
      box(g, bayW - 0.16, 0.06, 0.03, cx, y + 0.02, cd / 2 - 0.02 + out, front);
      const fill = r();
      if (fill > 0.18) {
        const t = 0.02 + fill * 0.12;
        box(g, bayW - 0.34, t, cd - 0.24, cx, y + 0.0175 + t / 2, out, mat(SHEETS[Math.floor(r() * SHEETS.length)], "matte"));
      }
    }
    box(g, bayW, 0.05, cd + 0.1, cx, 2.87, 0, upright);
  }
  for (const sx of [-1, 1]) columnGuard(g, p, sx * (span / 2 + 0.05), cd / 2 + 0.25, 0.2);
  return g;
}

function palletRack(p: Palette, L: number, D: number, r: () => number, height: number, levels: number): THREE.Group {
  const g = new THREE.Group();
  const bayW = 2.7, rowD = 1.1;
  const rows = D >= 2.6 ? 2 : 1;
  const bays = Math.max(1, Math.floor((L - 0.3) / bayW));
  const span = bays * bayW;
  const upright = mat(p.rack, "paint");
  const beam = mat(p.beam, "paint");
  const rowZs = rows === 2 ? [-(rowD / 2 + 0.1), rowD / 2 + 0.1] : [0];
  const beamYs = Array.from({ length: levels }, (_, i) => (i === 0 ? 0 : 0.15 + i * (height - 0.6) / levels));
  for (const rz of rowZs) {
    for (let b = 0; b <= bays; b++) {
      const x = -span / 2 + b * bayW;
      for (const sz of [-1, 1]) box(g, 0.09, height, 0.07, x, height / 2, rz + sz * (rowD / 2), upright, 0.01);
      // Diagonalverband im Rahmen.
      const steps = Math.max(3, Math.round(height / 1.1));
      for (let k = 0; k < steps; k++) {
        const y0 = 0.2 + (k * (height - 0.4)) / steps, y1 = 0.2 + ((k + 1) * (height - 0.4)) / steps;
        const len = Math.hypot(rowD, y1 - y0);
        const brace = box(g, 0.03, len, 0.03, x, (y0 + y1) / 2, rz, upright);
        brace.rotation.x = (k % 2 ? 1 : -1) * Math.atan2(rowD, y1 - y0);
      }
      box(g, 0.2, 0.012, rowD + 0.2, x, 0.006, rz, mat(p.paintDark, "satin"));
    }
    for (let b = 0; b < bays; b++) {
      const cx = -span / 2 + b * bayW + bayW / 2;
      for (const y of beamYs) {
        if (y > 0) for (const sz of [-1, 1]) box(g, bayW - 0.1, 0.12, 0.05, cx, y, rz + sz * (rowD / 2), beam, 0.01);
        for (let k = 0; k < 3; k++) {
          if (r() > 0.78) continue;
          const px = cx - bayW / 2 + 0.45 + k * 0.9;
          const base = y === 0 ? 0 : y + 0.06;
          const roll = r();
          if (roll < 0.55) wrappedLoad(g, p, px, base, rz, 0.55 + r() * 0.65, r() < 0.3 ? "#9fb4c7" : undefined, true);
          else if (roll < 0.85) { pallet(g, p, px, base, rz, true); cartons(g, p, px, base + 0.144, rz, 0.78, 1.1, 1 + Math.floor(r() * 3), Math.floor(r() * 9)); }
          else meshBox(g, p, px, base, rz, r());
        }
      }
    }
    for (const sx of [-1, 1]) columnGuard(g, p, sx * (span / 2), rz, rowD);
  }
  return g;
}

function picking(p: Palette, L: number, D: number, r: () => number, smallParts: boolean): THREE.Group {
  const g = new THREE.Group();
  const unitW = 1.0, unitD = 0.5, h = 2.0;
  const aisle = 1.1;
  const pairD = unitD * 2 + aisle;
  const pairs = Math.max(1, Math.floor((D + 0.2) / (pairD + 0.3)));
  const units = Math.max(1, Math.floor((L - 0.2) / unitW));
  const span = units * unitW;
  for (let q = 0; q < pairs; q++) {
    const z0 = -((pairs - 1) * (pairD + 0.3)) / 2 + q * (pairD + 0.3);
    for (const side of [-1, 1]) {
      const z = z0 + side * (aisle / 2 + unitD / 2);
      for (let u = 0; u < units; u++) {
        const x = -span / 2 + unitW / 2 + u * unitW;
        if (smallParts && u === units - 1 && side === -1) {
          // Schubladenschrank für Normteile.
          box(g, unitW - 0.06, 1.3, unitD - 0.04, x, 0.65, z, mat(p.paintDark, "satin"), 0.02);
          for (let k = 0; k < 8; k++) box(g, unitW - 0.14, 0.11, 0.01, x, 0.12 + k * 0.15, z - side * (unitD / 2 - 0.01), mat(p.paint, "satin"));
          continue;
        }
        const ys = shelfUnit(g, p, x, z, unitW, unitD, h, 5);
        for (const y of ys) {
          for (let k = 0; k < 2; k++) {
            if (r() < 0.12) continue;
            bin(g, BIN_COLOURS[Math.floor(r() * BIN_COLOURS.length)], x - 0.22 + k * 0.44, y, z, 0.38, unitD - 0.1, 0.2);
          }
        }
      }
    }
    // Kommissionierwagen im Gang.
    const cx = -span / 4 + r() * span * 0.3;
    const cart = group(g, cx, 0, z0);
    for (const yy of [0.25, 0.85]) box(cart, 1.0, 0.03, 0.55, 0, yy, 0, mat(p.steel, "metal"));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(cart, 0.03, 0.95, 0.03, sx * 0.48, 0.5, sz * 0.26, mat(p.steel, "metal"));
    box(cart, 0.03, 0.3, 0.55, 0.5, 1.1, 0, mat(p.steel, "metal"));
    for (let k = 0; k < 2; k++) bin(cart, "#2f6fb0", -0.24 + k * 0.48, 0.865, 0, 0.4, 0.3, 0.22);
  }
  // Packplatz mit Scanner am Kopf.
  if (L > 3.2) {
    const dx = span / 2 + 0.05;
    if (dx + 0.4 < L / 2) {
      box(g, 0.7, 0.04, 0.6, dx + 0.35, 0.95, 0, mat(p.wood, "wood"), 0.01);
      box(g, 0.66, 0.93, 0.56, dx + 0.35, 0.465, 0, mat(p.paintDark, "satin"), 0.02);
      monitor(g, p, dx + 0.35, 0.97, -0.15, 0, 0.4);
    }
  }
  return g;
}

function goodsIn(p: Palette, L: number, D: number, r: () => number): THREE.Group {
  const g = new THREE.Group();
  const stripe = mat(p.safety, "paint", "hazard", [L * 2, 1]);
  const stripeZ = mat(p.safety, "paint", "hazard", [D * 2, 1]);
  for (const sz of [-1, 1]) box(g, L - 0.1, 0.006, 0.1, 0, 0.003, sz * (D / 2 - 0.1), stripe);
  for (const sx of [-1, 1]) box(g, 0.1, 0.006, D - 0.1, sx * (L / 2 - 0.1), 0.003, 0, stripeZ);
  const spots = Math.max(2, Math.min(6, Math.floor((L - 0.6) / 1.3) * Math.max(1, Math.floor((D - 0.8) / 1.6))));
  const cols = Math.max(1, Math.floor((L - 0.6) / 1.3));
  for (let i = 0; i < spots; i++) {
    const cx = -L / 2 + 0.95 + (i % cols) * 1.3;
    const cz = -D / 2 + 0.75 + Math.floor(i / cols) * 1.6;
    if (cz > D / 2 - 1.0) break;
    if (r() < 0.6) wrappedLoad(g, p, cx, 0, cz, 0.6 + r() * 0.8, r() < 0.4 ? "#9fb4c7" : undefined, true);
    else { pallet(g, p, cx, 0, cz, true); cartons(g, p, cx, 0.144, cz, 0.78, 1.1, 2, i); }
  }
  // Bodenwaage und Prüfplatz.
  const sx = L / 2 - 0.85, sz = D / 2 - 0.85;
  box(g, 1.2, 0.06, 1.2, sx, 0.03, sz, mat(p.paintDark, "satin"), 0.01);
  box(g, 1.1, 0.008, 1.1, sx, 0.064, sz, mat(p.steel, "metal", "tread", [4, 4]));
  box(g, 0.06, 1.1, 0.06, sx + 0.7, 0.55, sz - 0.4, mat(p.steel, "metal"));
  box(g, 0.3, 0.2, 0.06, sx + 0.7, 1.15, sz - 0.4, mat(p.paintDark, "satin"), 0.01);
  palletJack(g, p, -L / 2 + 1.0, 0, D / 2 - 0.5, 0.2);
  return g;
}

function empties(p: Palette, L: number, D: number, r: () => number): THREE.Group {
  const g = new THREE.Group();
  const cols = Math.max(1, Math.floor((L - 0.3) / 1.45));
  const rowsN = Math.max(1, Math.floor((D - 0.3) / 1.05));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rowsN; j++) {
      const x = -((cols - 1) * 1.45) / 2 + i * 1.45;
      const z = -((rowsN - 1) * 1.05) / 2 + j * 1.05;
      const pick = (i + j) % 3;
      if (pick === 0) {
        const n = 6 + Math.floor(r() * 7);
        for (let k = 0; k < n; k++) pallet(g, p, x, k * 0.144, z);
      } else if (pick === 1) {
        meshBox(g, p, x, 0, z, 0);
        if (r() < 0.7) meshBox(g, p, x, 0.99, z, 0);
      } else {
        const n = 4 + Math.floor(r() * 5);
        for (let k = 0; k < n; k++) for (let m = 0; m < 2; m++) for (let q = 0; q < 2; q++) {
          bin(g, "#55606b", x - 0.21 + m * 0.42, k * 0.22, z - 0.16 + q * 0.32, 0.4, 0.3, 0.22);
        }
      }
    }
  }
  return g;
}

function archive(p: Palette, L: number, D: number, r: () => number): THREE.Group {
  const g = new THREE.Group();
  const unitW = 1.0, unitD = 0.42, h = 2.2;
  const rows = Math.max(1, Math.floor((D + 0.4) / (unitD * 2 + 0.9)));
  const units = Math.max(1, Math.floor((L - 0.2) / unitW));
  const span = units * unitW;
  for (let q = 0; q < rows; q++) {
    const z0 = -((rows - 1) * (unitD * 2 + 0.9)) / 2 + q * (unitD * 2 + 0.9);
    for (const side of [-1, 1]) {
      const z = z0 + side * (unitD / 2 + 0.01);
      for (let u = 0; u < units; u++) {
        const x = -span / 2 + unitW / 2 + u * unitW;
        const ys = shelfUnit(g, p, x, z, unitW, unitD, h, 6);
        for (const y of ys.slice(0, 5)) {
          const n = 3 + Math.floor(r() * 4);
          for (let k = 0; k < n; k++) box(g, 0.13, 0.3, 0.36, x - 0.4 + k * 0.14, y + 0.15, z, mat(k % 4 === 3 ? "#dcd7c9" : p.carton, "carton"), 0.006);
        }
      }
    }
  }
  return g;
}

function shelving(p: Palette, L: number, D: number, r: () => number): THREE.Group {
  const g = new THREE.Group();
  const units = Math.max(1, Math.floor((L - 0.2) / 1.0));
  const span = units * 1.0;
  const rowsN = D >= 1.6 ? 2 : 1;
  for (let q = 0; q < rowsN; q++) {
    const z = rowsN === 2 ? (q ? 0.31 : -0.31) : 0;
    for (let u = 0; u < units; u++) {
      const x = -span / 2 + 0.5 + u;
      const ys = shelfUnit(g, p, x, z, 1.0, 0.6, 2.0, 4);
      for (const y of ys) {
        if (r() < 0.25) continue;
        if (r() < 0.5) cartons(g, p, x, y, z, 0.8, 0.5, 1, u);
        else bin(g, BIN_COLOURS[Math.floor(r() * BIN_COLOURS.length)], x, y, z, 0.6, 0.4, 0.24);
      }
    }
  }
  return g;
}

/** Ein Lagerplatz als Bau. `w`/`d` sind die Stationsmaße in Metern. */
export function storage(s: { label?: string; subtype?: string; is_storage?: boolean },
                        p: Palette, w: number, d: number, o: MachineOptions): THREE.Group {
  const kind = storageKind(s);
  const alongZ = d > w * 1.15;
  const L = alongZ ? d : w, D = alongZ ? w : d;
  const r = rng(`${s.label ?? ""}|${kind}|${w.toFixed(1)}x${d.toFixed(1)}`);
  let inner: THREE.Group;
  switch (kind) {
    case "plattenregal": inner = sheetRack(p, L, D, r); break;
    case "hochregal": inner = palletRack(p, L, D, r, 5.4, 4); break;
    case "langzeit": inner = palletRack(p, L, D, r, 4.2, 3); break;
    case "kommissionierung": inner = picking(p, L, D, r, false); break;
    case "kleinteile": inner = picking(p, L, D, r, true); break;
    case "wareneingang": inner = goodsIn(p, L, D, r); break;
    case "leergut": inner = empties(p, L, D, r); break;
    case "archiv": inner = archive(p, L, D, r); break;
    default: inner = shelving(p, L, D, r); break;
  }
  // Statussäule am Kopfende: auch ein Lager meldet „voll" und „überbucht".
  stackLight(inner, p, L / 2 - 0.12, 0, D / 2 - 0.12, o.status);
  const g = new THREE.Group();
  if (alongZ) inner.rotation.y = Math.PI / 2;
  g.add(inner);
  g.userData.storageKind = kind;
  return g;
}
