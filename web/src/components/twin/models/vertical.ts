import * as THREE from "three";
import type { VerticalLink } from "../walkLevels";
import { STAIR_RISE_M, STAIR_STEPS } from "../walkLevels";

/* Treppe und Aufzug als Körper an der Hallenwand (Begehen).

   Lokale Achsen: x entlang der Wand, z in die Halle, y nach oben; der Ursprung
   liegt auf der Wand. Der Körper ist 0,9 m tief und bekommt in der Kollision
   denselben Fußabdruck (`linkFootprint`), man geht also nicht hindurch.
   Treppe: ein Treppenblock mit Stufen im Umriss, Handlauf, Schild und einem
   Trittfeld mit zwei Richtungen (rechts hinauf, links hinunter).
   Aufzug: Schacht mit zwei Schiebetüren, Anzeige und Rufknopf; er wird geklickt. */

export interface VerticalStyle {
  body: string;
  bodyDark: string;
  steel: string;
  accent: string;
  /** Schild: Hintergrund und Piktogramm/Schrift. */
  signBg: string;
  signFg: string;
  /** Kanten der Stufen. */
  light: string;
}

const mats = new Map<string, THREE.MeshBasicMaterial>();
function basic(hex: string): THREE.MeshBasicMaterial {
  let m = mats.get(hex);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), toneMapped: false });
    m.userData.shared = true;
    mats.set(hex, m);
  }
  return m;
}

function signTexture(text: string, glyph: "stair" | "lift", style: VerticalStyle): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 256; c.height = 128;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = style.signBg;
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = style.accent;
  g.fillRect(0, 0, 256, 8);
  g.fillRect(0, 120, 256, 8);
  g.strokeStyle = style.signFg; g.fillStyle = style.signFg; g.lineWidth = 7; g.lineJoin = "round";
  if (glyph === "stair") {
    g.beginPath();
    g.moveTo(28, 100); g.lineTo(28, 80); g.lineTo(52, 80); g.lineTo(52, 60);
    g.lineTo(76, 60); g.lineTo(76, 40); g.lineTo(100, 40); g.lineTo(100, 100); g.closePath();
    g.fill();
  } else {
    g.strokeRect(28, 30, 70, 72);
    g.beginPath(); g.moveTo(63, 30); g.lineTo(63, 102); g.stroke();
    g.beginPath(); g.moveTo(44, 56); g.lineTo(52, 42); g.lineTo(60, 56); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(66, 76); g.lineTo(74, 90); g.lineTo(82, 76); g.closePath(); g.fill();
  }
  g.font = "700 31px system-ui, sans-serif";
  g.textBaseline = "middle";
  g.fillText(text, 118, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.userData.own = true;
  return t;
}

/** „AB“ links (hinunter), „AUF“ rechts (hinauf) auf dem Trittfeld. */
function laneTexture(style: VerticalStyle): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 512; c.height = 256;
  const g = c.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, 512, 256);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "700 82px system-ui, sans-serif";
  g.fillStyle = style.light;
  g.fillText("AB", 128, 132);
  g.fillStyle = style.signBg;
  g.fillText("AUF", 384, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  t.userData.own = true;
  return t;
}

/** Ein schlanker Stab zwischen zwei Punkten (Geländer, Holm, Strebe). */
function barBetween(
  a: THREE.Vector3, b: THREE.Vector3, thickness: number, hex: string,
): THREE.Mesh {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(thickness, thickness, Math.max(0.02, len)), basic(hex));
  bar.position.copy(a).add(b).multiplyScalar(0.5);
  bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
  return bar;
}

const STAIR_GAP = 0.12;

export function buildVerticalLink(l: VerticalLink, height: number, style: VerticalStyle): THREE.Group {
  const g = new THREE.Group();
  g.name = `vertical-${l.kind}`;
  g.userData.vertical = { kind: l.kind, name: l.name };
  // lokales +z zeigt in die Halle
  g.position.set(l.x, 0, l.y);
  g.rotation.y = Math.atan2(l.nx, l.ny);
  const h = Math.max(3.2, Math.min(3.6, height - 0.2));
  const w = l.width, d = l.depth;
  const edgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(style.light), transparent: true, opacity: 0.85 });
  const add = (geo: THREE.BufferGeometry, hex: string, x: number, y: number, z: number, edges = false) => {
    const m = new THREE.Mesh(geo, basic(hex));
    m.position.set(x, y, z);
    g.add(m);
    if (edges) {
      // Kanten heller als die Fläche: so bleiben Stufen und Schacht auch im Flachlicht lesbar.
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), edgeMat);
      e.position.copy(m.position);
      g.add(e);
    }
    return m;
  };

  if (l.kind === "stair") {
    // Echter Treppenlauf (seit 2026-11-07): rechts hinauf, links in einen
    // Schacht hinunter. Beide beginnen vorn auf dem Boden und enden an der Wand.
    // Tiefe und Steighöhe kommen aus walkLevels, damit Kamera und Modell
    // dieselben Stufen benutzen.
    const depth = d;
    const rise = STAIR_RISE_M;
    const n = STAIR_STEPS;
    const run = depth / n;
    const laneW = (w - STAIR_GAP) / 2;
    const cxUp = w / 2 - laneW / 2;
    const cxDown = -w / 2 + laneW / 2;

    const flight = (sign: 1 | -1) => {
      // Profil im (t, Höhe)-Raum: vorn (t = depth) auf dem Boden, an der Wand
      // bei ±rise. Die Unterseite fällt als Keil zurück zum Einstieg.
      const shape = new THREE.Shape();
      shape.moveTo(depth, 0);
      let y = 0;
      for (let i = 0; i < n; i++) {
        y += (sign * rise) / n;
        shape.lineTo(depth - run * i, y);
        shape.lineTo(depth - run * (i + 1), y);
      }
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: laneW, bevelEnabled: false, curveSegments: 1 });
      const mesh = new THREE.Mesh(geo, basic(style.body));
      mesh.rotation.y = -Math.PI / 2;
      mesh.position.x = sign > 0 ? w / 2 : -STAIR_GAP / 2;
      g.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat);
      edges.rotation.copy(mesh.rotation);
      edges.position.copy(mesh.position);
      g.add(edges);
      // Trittkanten heller: die Stufen bleiben auch im Flachlicht lesbar.
      const cx = sign > 0 ? cxUp : cxDown;
      for (let i = 0; i < n; i++) {
        const top = sign * (rise * (i + 1)) / n;
        add(new THREE.BoxGeometry(laneW - 0.03, 0.035, 0.1), style.light,
          cx, top + 0.018, depth - run * i - 0.05);
      }
    };
    flight(1);
    flight(-1);

    // Schacht unter dem linken Lauf: Boden, Wangen und dunkle Öffnung.
    add(new THREE.BoxGeometry(laneW + 0.04, 0.06, depth), style.bodyDark, cxDown, -rise - 0.04, depth / 2);
    for (const x of [-w / 2, -STAIR_GAP / 2]) {
      add(new THREE.BoxGeometry(0.08, rise + 0.16, depth), style.bodyDark, x, -(rise + 0.16) / 2, depth / 2);
    }
    add(new THREE.BoxGeometry(laneW, rise + 0.16, 0.08), style.bodyDark, cxDown, -(rise + 0.16) / 2, 0.04);
    // Warnkante rund um die Öffnung, damit sie im Boden sofort auffällt.
    add(new THREE.BoxGeometry(laneW + 0.08, 0.035, 0.09), style.accent, cxDown, 0.02, depth);
    add(new THREE.BoxGeometry(0.09, 0.035, depth), style.accent, -w / 2 - 0.02, 0.02, depth / 2);

    // Geländer: außen und an der Trennlinie, mit Pfosten an Anfang, Mitte, Ende.
    const rail = (x: number, sign: 1 | -1) => {
      const top = (t: number) => sign * rise * (1 - t / depth) + 0.95;
      for (const t of [depth, depth / 2, 0]) {
        const base = sign * rise * (1 - t / depth);
        add(new THREE.BoxGeometry(0.05, 0.95, 0.05), style.steel, x, base + 0.475, t);
      }
      g.add(barBetween(
        new THREE.Vector3(x, top(depth), depth), new THREE.Vector3(x, top(0), 0), 0.05, style.steel));
    };
    rail(w / 2 - 0.06, 1);
    rail(0, 1);
    rail(-STAIR_GAP / 2, -1);
    rail(-w / 2 + 0.06, -1);
  } else {
    // Schacht
    add(new THREE.BoxGeometry(w, h, d), style.body, 0, h / 2, d / 2, true);
    // Schiebetüren, vorn leicht vorstehend
    const dw = (w - 0.7) / 2;
    for (const sx of [-1, 1]) {
      add(new THREE.BoxGeometry(dw - 0.02, 2.2, 0.06), style.steel, sx * (dw / 2 + 0.01), 1.1, d + 0.03);
    }
    add(new THREE.BoxGeometry(0.03, 2.2, 0.08), style.bodyDark, 0, 1.1, d + 0.04);
    // Rahmen
    add(new THREE.BoxGeometry(w - 0.4, 0.12, 0.1), style.bodyDark, 0, 2.28, d + 0.04);
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.1, 2.3, 0.1), style.bodyDark, sx * (w / 2 - 0.2), 1.15, d + 0.04);
    // Anzeige über der Tür und Rufknopf daneben
    add(new THREE.BoxGeometry(0.5, 0.18, 0.04), style.bodyDark, 0, 2.5, d + 0.03);
    add(new THREE.BoxGeometry(0.1, 0.1, 0.05), style.accent, 0, 2.5, d + 0.06);
    add(new THREE.BoxGeometry(0.12, 0.26, 0.05), style.bodyDark, w / 2 - 0.1, 1.1, d + 0.03);
    add(new THREE.BoxGeometry(0.06, 0.06, 0.06), style.accent, w / 2 - 0.1, 1.14, d + 0.05);
  }

  // Schild über dem Körper (beschrieben: Piktogramm und Name)
  const tex = signTexture(l.kind === "lift" ? "AUFZUG" : "TREPPE", l.kind, style);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.75),
    tex ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }) : basic(style.accent),
  );
  // Treppe: über dem oberen Ende an der Wand; Aufzug: über dem Türrahmen.
  if (l.kind === "stair") sign.position.set(0, STAIR_RISE_M + 0.55, 0.06);
  else sign.position.set(0, h - 0.42, d + 0.03);
  g.add(sign);

  // Bodenfeld davor: zeigt, wo man einsteigt. Bei der Treppe zwei Hälften:
  // rechts hinauf, links hinunter, mit geraden Pfeilen in Laufrichtung.
  if (l.kind === "stair") {
    const laneW = (w - STAIR_GAP) / 2;
    const cxUp = w / 2 - laneW / 2;
    const cxDown = -w / 2 + laneW / 2;
    const lane = (x: number, hex: string, opacity: number) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(laneW, 1.5),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity, toneMapped: false, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.04, d + 0.85);
      m.renderOrder = 5;
      g.add(m);
    };
    // Lokales +x ist beim Blick zur Wand die rechte, obere Seite: hinauf.
    lane(cxUp, style.accent, 0.34);
    lane(cxDown, style.bodyDark, 0.26);
    const divider = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.012, 1.5),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(style.light), toneMapped: false }),
    );
    divider.position.set(0, 0.05, d + 0.85);
    g.add(divider);
    const arrow = (x: number, dir: 1 | -1) => {
      const shape = new THREE.Shape();
      shape.moveTo(0, 0.34 * dir);
      shape.lineTo(-0.23, -0.12 * dir);
      shape.lineTo(0.23, -0.12 * dir);
      shape.closePath();
      const m = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(style.light), transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.06, d + 0.7);
      m.renderOrder = 6;
      g.add(m);
    };
    // Beide Pfeile zeigen gerade in die Treppe — kein Abbiegen.
    arrow(cxUp, 1);
    arrow(cxDown, 1);
    const tex = laneTexture(style);
    if (tex) {
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(w + 0.4, 1.2),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: false }),
      );
      label.rotation.x = -Math.PI / 2;
      label.position.set(0, 0.07, d + 0.85);
      label.renderOrder = 7;
      g.add(label);
    }
  } else {
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 0.6, 1.5),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(style.accent), transparent: true, opacity: 0.28, toneMapped: false, depthWrite: false }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, 0.04, d + 0.85);
    pad.renderOrder = 5;
    g.add(pad);
  }
  g.userData.ownMaterials = true;
  return g;
}
