import * as THREE from "three";
import type { Robot } from "../../factory";
import { box, cyl, group, mat, glow, clear } from "./models/kit";
import { wrappedLoad } from "./models/props";
import { DEVICE_STYLE, paletteOf } from "./deviceModels";
import { mergeStatic } from "./staticMerge";
import { buildArmCell } from "./models/armCell";

/* Transportroboter für die 3D-Halle (task 37: halbrealistisch).

   Zwei Gestalten nach `kind`:
   - AGV: flach (≈ 0,4 m), Hubplatte oben, Sicherheitsscanner vorn und hinten.
   - AMR: höher (≈ 0,95 m), Aufbau mit Rollenmodul, Lidar oben.
   Fahrtrichtung ist +x; vorn zeigt ein schmales Leuchtband in Weiß, hinten in
   Rot. Ein Leuchtband rundum trägt die Statusfarbe (fährt, wartet, lädt,
   blockiert, offline). Räder und Lidar tragen `userData.robotSpin`; die
   3D-Schleife dreht sie nur, solange der Roboter fährt. Die Gruppe
   „robot-payload" zeigt eine Ladung und wird von der Simulation
   (beladen/leer) ein- und ausgeblendet. */

export function robotStatusColour(state: string): string {
  switch ((state || "").toLowerCase()) {
    case "moving": return "#2f9e6e";
    case "charging": return "#ca9c19";
    case "blocked":
    case "error": return "#cd4246";
    case "offline": return "#5f6b7c";
    default: return "#1668ac";
  }
}

export interface RobotLook {
  /** Ladung anfangs sichtbar. */
  loaded?: boolean;
}

export function buildRobotModel(robot: Pick<Robot, "id" | "name" | "kind" | "state"> & Partial<Robot>, look: RobotLook = {}): THREE.Group {
  const p = paletteOf(DEVICE_STYLE);
  const g = new THREE.Group();
  g.name = `robot-${robot.id}`;

  /* Ein echter 7-Achs-Arm statt des Transportfahrzeugs — als ganze Zelle,
     damit er in einer 32 × 20 m großen Halle überhaupt lesbar ist: Plattform,
     Band, drei Sortierkörbe und Kameramast. Dasselbe Armmodell wie in der
     Sortierzelle unter Roboter → Arme & Zellen (arm7.ts) und fährt denselben Arbeitszyklus (armCycle.ts). A1…A7 sind
     echte Gelenke; die Statusleuchte trägt den Zustand des Roboters. Der Arm
     fährt nicht (route leer), er steht an seiner gemeldeten Position.

     Wichtig: alle Körper hängen an ``g`` (der Gruppe, deren Lage der Zwilling
     setzt). Ein eigener Root mit Positions-Offset würde überschrieben. */
  const kind = (robot.kind || "").toLowerCase();
  if (kind === "arm" || kind === "cobot") {
    /* Arm mit Zelle wie an der Sortierzelle, gebaut wie das Förderband
       (models/armCell.ts). Die Halle ruft animate() mit der Laufzeit auf. */
    const cell = buildArmCell();
    g.add(cell.root);
    g.userData.armCycle = true;
    g.userData.armCell = cell;
    return g;
  }

  const shell = mat("#e4e8ec", "plastic");
  const dark = mat("#2e353d", "satin");
  const rubber = mat("#1b1f24", "rubber");
  const steel = mat("#9aa6b2", "metal");
  const status = glow(robotStatusColour(robot.state));
  const amr = (robot.kind || "").toLowerCase() === "amr";

  const L = amr ? 0.95 : 1.3, W = amr ? 0.66 : 0.86;
  const baseH = amr ? 0.32 : 0.3;
  // Fahrgestell, Stoßleisten, Leuchtbänder.
  box(g, L, baseH, W, 0, 0.06 + baseH / 2, 0, amr ? shell : dark, 0.06);
  box(g, L + 0.02, 0.05, W + 0.02, 0, 0.1, 0, rubber, 0.02);
  box(g, L + 0.006, 0.03, W + 0.006, 0, 0.06 + baseH * 0.62, 0, status);
  box(g, 0.012, 0.04, W * 0.6, L / 2 + 0.004, 0.06 + baseH * 0.4, 0, glow("#f4f7fb"));
  box(g, 0.012, 0.04, W * 0.6, -L / 2 - 0.004, 0.06 + baseH * 0.4, 0, glow("#cd4246"));
  // Räder (meist verdeckt, sichtbar an den Seiten) — drehen beim Fahren.
  for (const x of [-L * 0.32, L * 0.32]) {
    for (const z of [-W / 2 + 0.02, W / 2 - 0.02]) {
      const holder = group(g, x, 0.085, z);
      holder.rotation.x = Math.PI / 2;
      const wheel = cyl(holder, 0.085, 0.085, 0.06, 0, 0, 0, rubber, "y", 14);
      wheel.userData.robotSpin = "wheel";
    }
  }
  // Sicherheitsscanner vorn (beide) und hinten (AGV).
  const scanner = (x: number) => {
    box(g, 0.08, 0.1, 0.18, x, 0.06 + baseH * 0.35, 0, dark, 0.02);
    box(g, 0.004, 0.05, 0.14, x + Math.sign(x) * 0.041, 0.06 + baseH * 0.35, 0, clear("#1b1f24", 0.8));
  };
  scanner(L / 2 + 0.02);
  if (!amr) scanner(-L / 2 - 0.02);

  let topY: number;
  if (amr) {
    // Aufbau mit Rollenmodul und Lidar-Turm.
    const towerH = 0.45;
    box(g, L * 0.92, towerH, W * 0.92, 0, 0.06 + baseH + towerH / 2, 0, shell, 0.05);
    box(g, L * 0.93, 0.03, W * 0.93, 0, 0.06 + baseH + towerH * 0.7, 0, dark);
    topY = 0.06 + baseH + towerH;
    for (const sz of [-1, 1]) box(g, L * 0.9, 0.06, 0.05, 0, topY + 0.03, sz * (W * 0.42), steel, 0.01);
    for (let i = 0; i < 6; i++) cyl(g, 0.025, 0.025, W * 0.8, -L * 0.38 + i * (L * 0.76 / 5), topY + 0.04, 0, steel, "z", 8);
    const lidar = cyl(g, 0.07, 0.08, 0.07, L * 0.36, topY + 0.1, -W * 0.3, dark, "y", 14);
    lidar.userData.robotSpin = "lidar";
    box(g, 0.03, 0.03, 0.06, L * 0.36 + 0.06, topY + 0.1, -W * 0.3, glow("#4c90f0"));
  } else {
    // Hubplatte mit Gummiauflage, Lidar vorn in der Ecke.
    topY = 0.06 + baseH;
    box(g, L * 0.86, 0.05, W * 0.84, 0, topY + 0.03, 0, steel, 0.02);
    box(g, L * 0.8, 0.012, W * 0.78, 0, topY + 0.06, 0, rubber);
    topY += 0.066;
    const lidar = cyl(g, 0.06, 0.07, 0.06, L / 2 - 0.12, topY + 0.03, W / 2 - 0.12, dark, "y", 14);
    lidar.userData.robotSpin = "lidar";
  }
  // Ladung: Palette mit Ware (AGV) oder Kiste auf dem Rollenmodul (AMR).
  const payload = group(g, 0, topY, 0);
  payload.name = "robot-payload";
  if (amr) box(payload, L * 0.7, 0.32, W * 0.62, 0, 0.2, 0, mat(p.carton, "carton", "carton"), 0.01);
  else wrappedLoad(payload, p, 0, 0, 0, 0.55, undefined, false);
  payload.visible = !!look.loaded;
  // Kleines Statuslicht oben: aus der Vogelperspektive lesbar.
  cyl(g, 0.05, 0.05, 0.04, -L * 0.36, topY + 0.02, 0, status, "y", 12);
  // Unbewegte Teile verschmelzen (task 41 B): 17 → 6 Zeichenaufrufe je
  // Roboter. Räder und Lidar (``robotSpin``) und die Ladung bleiben einzeln.
  mergeStatic(g);
  return g;
}
