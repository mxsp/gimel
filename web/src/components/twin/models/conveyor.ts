import * as THREE from "three";
import { box, cyl, finalize, group, mat, type Palette } from "./kit";
import { CLEAR_UNDER_M, DEPTH_M, POST_M, type P3 } from "../conveyor";

/* Förderband als 3D-Modell (task 37): Rahmen, Gurt, Seitenführung, Kopf- und
   Umlenktrommel, Antrieb am Kopf, Stützen. Auf Steigungen trägt der Gurt
   Mitnehmer. Über Gängen wird es zur Brücke: Stahlstützen nur an den
   Eckpunkten, Geländer beidseitig, gelb-schwarz markierte Unterkante.

   Der Gurt hat ein eigenes Material mit eigener Textur (`userData.belt`): die
   Belebung verschiebt die Textur, damit das Band läuft. Alles andere wird wie
   bei den Geräten verschmolzen. Koordinaten: Grundriss x/y → 3D x/z, Höhe y. */

export interface ConveyorModel {
  root: THREE.Object3D;
  /** Gurttexturen je Abschnitt (gleiche Streifenteilung); die Belebung verschiebt sie. Leer im Node-Test. */
  beltTextures: THREE.Texture[];
}

function beltTex(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // Querstreifen: auf der Oberseite eines Kastens läuft u entlang der Förderrichtung.
  ctx.fillStyle = "#2a2e33"; ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#3d434a";
  for (let x = 0; x < 64; x += 16) ctx.fillRect(x, 0, 5, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  tex.userData.own = true;
  return tex;
}

export function buildConveyor(points: P3[], width: number, p: Palette): ConveyorModel {
  const body = new THREE.Group();
  body.name = "conveyor";
  const frame = mat(p.steel, "metal", "brushed", [3, 1]);
  const paint = mat(p.accent, "paint");
  const dark = mat(p.paintDark, "satin");
  const safety = mat(p.safety, "paint", "hazard", [6, 1]);
  const base = beltTex();
  const textures: THREE.Texture[] = [];

  for (let i = 1; i < points.length; i++) {
    const [ax, ay, az] = points[i - 1], [bx, by, bz] = points[i];
    const flat = Math.hypot(bx - ax, by - ay);
    if (flat < 1e-3) continue;
    const len = Math.hypot(flat, bz - az);
    const seg = group(body, (ax + bx) / 2, (az + bz) / 2, (ay + by) / 2, Math.atan2(-(by - ay), bx - ax));
    const tilt = group(seg, 0, 0, 0);
    tilt.rotation.z = Math.atan2(bz - az, flat);
    // Rahmen unter dem Gurt, Gurt obenauf, Seitenführungen.
    box(tilt, len, DEPTH_M * 0.7, width, 0, -DEPTH_M * 0.45, 0, frame, 0.01);
    const belt = new THREE.MeshStandardMaterial({ color: new THREE.Color("#ffffff"), roughness: 0.85, metalness: 0 });
    if (base) {
      const t = base.clone();
      t.repeat.set(Math.max(1, len / 0.5), 1);
      t.needsUpdate = true;
      t.userData.own = true;
      belt.map = t;
      textures.push(t);
    }
    belt.userData.belt = true;
    box(tilt, len, 0.02, width * 0.86, 0, 0, 0, belt);
    for (const sz of [-1, 1]) box(tilt, len, 0.09, 0.03, 0, 0.05, sz * (width / 2), paint, 0.005);
    // Mitnehmer auf Steigungen.
    if (Math.abs(bz - az) / flat > 0.12) {
      for (let d = -len / 2 + 0.25; d < len / 2 - 0.1; d += 0.45) box(tilt, 0.03, 0.05, width * 0.8, d, 0.035, 0, dark);
    }
    // Hohe Abschnitte: Geländer und markierte Unterkante; niedrige: Beine alle 2 m.
    const high = Math.min(az, bz) - DEPTH_M >= CLEAR_UNDER_M - 0.05;
    if (high) {
      for (const sz of [-1, 1]) {
        box(tilt, len, 0.04, 0.04, 0, 0.95, sz * (width / 2 + 0.05), paint);
        box(tilt, len, 0.04, 0.04, 0, 0.5, sz * (width / 2 + 0.05), paint);
        for (let d = -len / 2; d <= len / 2 + 1e-6; d += 1.5) box(tilt, 0.04, 1.0, 0.04, d, 0.48, sz * (width / 2 + 0.05), paint);
      }
      box(tilt, len, 0.06, width + 0.02, 0, -DEPTH_M * 0.85, 0, safety);
    } else {
      const n = Math.max(1, Math.floor(flat / 2));
      for (let k = 0; k <= n; k++) {
        const u = k / n;
        const x = ax + (bx - ax) * u, y = ay + (by - ay) * u, z = az + (bz - az) * u;
        if (z - DEPTH_M >= CLEAR_UNDER_M) continue;
        const legH = z - DEPTH_M * 0.8;
        if (legH < 0.1) continue;
        const legs = group(body, x, 0, y, Math.atan2(-(by - ay), bx - ax));
        for (const sz of [-1, 1]) box(legs, 0.06, legH, 0.06, 0, legH / 2, sz * (width / 2 - 0.05), dark);
        box(legs, 0.05, 0.05, width - 0.1, 0, legH * 0.35, 0, dark);
      }
    }
  }
  // Stützen unter hohen Eckpunkten: Stahlstütze mit Fußplatte und Anfahrschutz.
  for (const [x, y, z] of points) {
    if (z - DEPTH_M < CLEAR_UNDER_M) continue;
    const h = z - DEPTH_M * 0.8;
    box(body, POST_M * 0.7, h, POST_M * 0.7, x, h / 2, y, paint, 0.02);
    box(body, POST_M + 0.1, 0.03, POST_M + 0.1, x, 0.015, y, dark);
    box(body, POST_M + 0.06, 0.6, POST_M + 0.06, x, 0.3, y, mat(p.safety, "paint", "hazard", [2, 1]), 0.01);
  }
  // Trommeln an Anfang und Ende, Antrieb am Kopf (Ende in Förderrichtung).
  const ends: [P3, P3, boolean][] = [[points[0], points[1], false], [points[points.length - 1], points[points.length - 2], true]];
  for (const [e, n, head] of ends) {
    const yaw = Math.atan2(-(n[1] - e[1]), n[0] - e[0]);
    const g = group(body, e[0], e[2], e[1], yaw);
    cyl(g, 0.09, 0.09, width * 0.9, 0, -0.04, 0, frame, "z", 16);
    if (head) {
      box(g, 0.32, 0.26, 0.26, 0.05, -0.12, width / 2 + 0.2, dark, 0.03);
      cyl(g, 0.1, 0.1, 0.22, 0.05, -0.12, width / 2 + 0.42, mat(p.accent, "paint"), "z", 14);
    }
  }
  base?.dispose();
  return { root: finalize(body), beltTextures: textures };
}
