/* Der 7-Achs-Roboter der Sortierzelle (Roboter → Arme & Zellen) und des Grundrisses.

   Sieben Drehgelenke in einer Kette, gebaut wie ein Leichtbauarm mit
   Kugelhandgelenk:
     A1 Grundachse (Hochachse) · A2 Schulter (Nicken) · A3 Ellbogen (Nicken)
     A4 Unterarm-Rollachse (Redundanz) · A5 Hand Nicken · A6 Hand Schwenken
     A7 Flansch-Rollachse (Werkzeuglage)

   Kinematik (seit 2026-11-08):
   - A1–A3 tragen die Handwurzel (Schnittpunkt von A5 und A6) über eine
     analytische 2-Gelenk-IK in der durch A1 gedrehten Ebene.
   - A5 und A6 schneiden sich (Kugelhandgelenk, A6 steht quer zu A5). Damit
     lässt sich das Werkzeug aus *jeder* Unterarmlage senkrecht stellen: die
     Rechnung nimmt die Lage nach A1–A4 und löst A5/A6 geschlossen.
   - A4 ist echte Redundanz: der Unterarm rollt um seine eigene Achse, A5/A6
     gleichen aus, Handwurzel und Werkzeug bleiben stehen (Nullraumbewegung).
     Bis 2026-11-08 lagen A6 und A7 auf derselben Achse; ein Rollen von A4
     kippte dann das Werkzeug mit.
   - A7 dreht das Werkzeug um die Senkrechte in die Teilelage.

   Aussehen: weiße Schalen mit Rundungen, dunkle Fugen an jeder Drehstelle,
   blaue Gelenkdeckel, Kabelkanal am Oberarm, Flansch mit Leuchtring, Vakuum-
   greifer mit Ejektor, Schläuchen und Faltenbalg-Saugern. Die Maße der Kette
   (Glieder, Gelenklagen, TCP) sind die der Rechnung — Schalen sind Hülle. */

import * as THREE from "three";

/** Standort des Armfußes auf dem Podest (Meter). */
export const ARM_BASE = new THREE.Vector3(0, 0.55, 0.58);
/** Höhe des Schultergelenks über dem Fuß. */
const SHOULDER_Y = 0.36;
const J1_Y = 0.10;   // Drehebene der Grundachse über dem Fuß
const L1 = 0.70;     // Oberarm: Schulter → Ellbogen
const L2 = 0.62;     // Unterarm: Ellbogen → Rollachse A4
const WRIST = 0.16;  // Rollachse → Handwurzel (A5/A6)
const FLANGE = 0.07; // Handwurzel → Flansch (A7)
const GRIP = 0.085;  // Flansch → Saugerspitzen (TCP)
const TOOL = FLANGE + GRIP;

export const JOINT_NAMES = [
  "A1 Grundachse", "A2 Schulter", "A3 Ellbogen", "A4 Unterarm roll",
  "A5 Hand nicken", "A6 Hand schwenken", "A7 Flansch roll",
];
const AXIS: ("x" | "y" | "z")[] = ["y", "z", "z", "y", "z", "x", "y"];
const SIGN = [1, -1, -1, 1, 1, 1, 1];

export interface ArmRig {
  root: THREE.Group;
  joints: THREE.Group[];
  tcp: THREE.Object3D;
  /** Leuchtring am Fuß und am Flansch (ein Material): Farbe = Zustand. */
  statusLight: THREE.Mesh;
  /** Standort des Fußes in der Zelle (Meter). */
  base: THREE.Vector3;
  /** Ruhelage über dem Tisch, mitverschoben auf den Fuß. */
  home: THREE.Vector3;
  setPose(angles: number[]): void;
  /** Winkel (rad) für eine TCP-Zielposition, Werkzeuglage und Redundanzachse.
   *  Ziel im Koordinatensystem der Zelle; der Fuß ist nicht gedreht. */
  solve(target: THREE.Vector3, toolYaw: number, redundant: number): number[];
}

export interface ArmOptions {
  /** Halbdurchsichtiger „Geist" für die Handführung: keine Schatten,
   *  additiv wirkende Flächen, Leuchtring bleibt Zustandsanzeige. */
  ghost?: boolean;
}

/* ------------------------------------------------------------ Bausteine */

const V2 = (r: number, y: number) => new THREE.Vector2(Math.max(0, r), y);

/** Zylinder mit gerundeten Kanten (Drehkörper um y, Mitte im Ursprung). */
function roundedCylinder(r: number, h: number, fillet: number, segments = 40): THREE.LatheGeometry {
  const f = Math.min(fillet, r * 0.9, h / 2);
  const pts: THREE.Vector2[] = [V2(0, -h / 2)];
  const arc = (cx: number, cy: number, from: number, to: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = from + ((to - from) * i) / 6;
      pts.push(V2(cx + f * Math.cos(a), cy + f * Math.sin(a)));
    }
  };
  arc(r - f, -h / 2 + f, -Math.PI / 2, 0);
  arc(r - f, h / 2 - f, 0, Math.PI / 2);
  pts.push(V2(0, h / 2));
  return new THREE.LatheGeometry(pts, segments);
}

/** Glied als Drehkörper entlang y: Profil [Radius, Höhe] von unten nach oben, geschlossen. */
function link(profile: [number, number][], segments = 36): THREE.LatheGeometry {
  // Von unten nach oben, sonst zeigen die Flächen nach innen.
  if (profile[0][1] > profile[profile.length - 1][1]) profile = [...profile].reverse();
  const pts = [V2(0, profile[0][1]), ...profile.map(([r, y]) => V2(r, y)), V2(0, profile[profile.length - 1][1])];
  // Glatte Hülle: Zwischenpunkte über eine Catmull-Rom-Kurve.
  const curve = new THREE.SplineCurve(profile.map(([r, y]) => new THREE.Vector2(r, y)));
  const smooth = curve.getPoints(Math.max(12, profile.length * 6)).map((p) => V2(p.x, p.y));
  return new THREE.LatheGeometry([pts[0], ...smooth, pts[pts.length - 1]], segments);
}

/** Faltenbalg-Sauger: drei Falten, Lippe unten bei y = 0. */
function bellows(r: number, h: number): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [V2(0, h)];
  const folds = 3;
  for (let i = 0; i <= folds * 2; i++) {
    const y = h - (h * 0.82 * i) / (folds * 2);
    pts.push(V2(i % 2 === 0 ? r * 0.62 : r * 0.92, y));
  }
  pts.push(V2(r * 1.08, h * 0.08), V2(r * 1.12, 0), V2(r * 0.7, 0), V2(0, 0.002));
  return new THREE.LatheGeometry(pts.reverse(), 24); // von unten nach oben
}

function tube(parent: THREE.Object3D, points: THREE.Vector3[], radius: number, m: THREE.Material): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.4);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, radius, 10, false), m);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/* ---------------------------------------------------------------- Bau */

export function buildArm(base: THREE.Vector3 = ARM_BASE, opts: ArmOptions = {}): ArmRig {
  const shell = new THREE.MeshPhysicalMaterial({ color: 0xeef1f4, metalness: 0.05, roughness: 0.38, clearcoat: 0.55, clearcoatRoughness: 0.32 });
  const graphite = new THREE.MeshStandardMaterial({ color: 0x262c33, metalness: 0.35, roughness: 0.55 });
  const seam = new THREE.MeshStandardMaterial({ color: 0x14181d, metalness: 0.2, roughness: 0.7 });
  const accent = new THREE.MeshPhysicalMaterial({ color: 0x2a78d6, metalness: 0.2, roughness: 0.35, clearcoat: 0.6 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xaab4be, metalness: 0.85, roughness: 0.28 });
  const alu = new THREE.MeshStandardMaterial({ color: 0xc9d0d6, metalness: 0.7, roughness: 0.4 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1b1f24, metalness: 0.0, roughness: 0.92 });
  const hose = new THREE.MeshStandardMaterial({ color: 0x3f77b8, metalness: 0.05, roughness: 0.55 });
  const statusMat = new THREE.MeshStandardMaterial({ color: 0x33d6a6, emissive: 0x33d6a6, emissiveIntensity: 0.85, roughness: 0.3 });

  const root = new THREE.Group();
  root.position.copy(base);
  root.name = opts.ghost ? "arm-7axis-ghost" : "arm-7axis";

  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material,
               pos: [number, number, number] = [0, 0, 0], rot: [number, number, number] = [0, 0, 0]): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  /** Drehkörper quer: Achse z (Nickgelenke) oder x (Schwenkgelenk). */
  const across = (axis: "z" | "x"): [number, number, number] => (axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, Math.PI / 2]);

  /** Gelenkgehäuse quer zur Kette: Schale, zwei Fugen und blaue Deckel an den Stirnseiten. */
  const housing = (parent: THREE.Object3D, axis: "z" | "x", r: number, len: number) => {
    const rot = across(axis);
    add(parent, roundedCylinder(r, len, r * 0.32), shell, [0, 0, 0], rot);
    const off = (d: number): [number, number, number] => (axis === "z" ? [0, 0, d] : [d, 0, 0]);
    for (const s of [-1, 1]) {
      add(parent, new THREE.CylinderGeometry(r * 1.012, r * 1.012, 0.007, 48), seam, off(s * len * 0.3), rot);
      add(parent, roundedCylinder(r * 0.62, 0.016, 0.006, 32), accent, off(s * (len / 2 + 0.004)), rot);
      add(parent, new THREE.CylinderGeometry(r * 0.2, r * 0.2, 0.006, 20), steel, off(s * (len / 2 + 0.013)), rot);
    }
  };
  /** Fuge quer zur Kettenachse (Rollstelle): dunkler Ring. */
  const rollSeam = (parent: THREE.Object3D, r: number, y: number) =>
    add(parent, new THREE.CylinderGeometry(r, r, 0.01, 40), seam, [0, y, 0]);

  // --- Podest und Fuß (unbewegt) --------------------------------------
  add(root, roundedCylinder(0.25, 0.035, 0.008, 48), graphite, [0, -0.533, 0]);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    add(root, new THREE.CylinderGeometry(0.014, 0.014, 0.02, 6), steel, [Math.cos(a) * 0.215, -0.508, Math.sin(a) * 0.215]);
  }
  add(root, link([[0.17, -0.515], [0.165, -0.35], [0.155, -0.12], [0.16, -0.03]]), graphite);
  add(root, roundedCylinder(0.19, 0.028, 0.008, 48), alu, [0, -0.016, 0]);
  // Anschlusskasten mit Kabelbogen hinten am Podest.
  add(root, new THREE.BoxGeometry(0.09, 0.12, 0.07), graphite, [-0.16, -0.36, 0]);
  add(root, new THREE.CylinderGeometry(0.022, 0.022, 0.03, 16), steel, [-0.21, -0.34, 0], [0, 0, Math.PI / 2]);
  tube(root, [new THREE.Vector3(-0.22, -0.34, 0), new THREE.Vector3(-0.3, -0.38, 0.02), new THREE.Vector3(-0.33, -0.52, 0.05)], 0.016, rubber);
  // Stator der Grundachse mit Leuchtring.
  add(root, roundedCylinder(0.155, J1_Y, 0.02, 48), shell, [0, J1_Y / 2, 0]);
  const statusLight = add(root, new THREE.TorusGeometry(0.157, 0.006, 8, 64), statusMat, [0, 0.03, 0], [Math.PI / 2, 0, 0]);
  statusLight.castShadow = false;

  const joints: THREE.Group[] = [];
  const jointAt = (parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.name = `A${joints.length + 1}`;
    parent.add(g);
    joints.push(g);
    return g;
  };

  // --- A1: Drehturm bis zur Schulter ---------------------------------
  const j1 = jointAt(root, 0, J1_Y, 0);
  rollSeam(j1, 0.152, 0.003);
  add(j1, link([[0.148, 0.006], [0.145, 0.06], [0.125, 0.14], [0.118, 0.2]]), shell);
  add(j1, new THREE.CylinderGeometry(0.152, 0.152, 0.018, 48), accent, [0, 0.035, 0]);

  // --- A2: Schulter, Oberarm --------------------------------------------
  const j2 = jointAt(j1, 0, SHOULDER_Y - J1_Y, 0);
  housing(j2, "z", 0.132, 0.27); // rund um die eigene Achse: dreht unsichtbar mit
  add(j2, link([[0.104, 0.05], [0.094, 0.16], [0.082, 0.36], [0.084, 0.52], [0.098, L1 - 0.06]]), shell);
  add(j2, new THREE.CylinderGeometry(0.098, 0.098, 0.024, 48), accent, [0, 0.17, 0]);
  // Kabelkanal an der Rückseite des Oberarms.
  tube(j2, [
    new THREE.Vector3(-0.11, 0.06, 0), new THREE.Vector3(-0.108, 0.25, 0),
    new THREE.Vector3(-0.1, 0.45, 0), new THREE.Vector3(-0.11, L1 - 0.1, 0),
  ], 0.017, graphite);
  for (const y of [0.12, 0.34, 0.56]) add(j2, new THREE.BoxGeometry(0.03, 0.02, 0.05), graphite, [-0.098, y, 0]);

  // --- A3: Ellbogen, Unterarm -------------------------------------------
  const j3 = jointAt(j2, 0, L1, 0);
  housing(j3, "z", 0.108, 0.23);
  add(j3, link([[0.09, 0.05], [0.079, 0.16], [0.07, 0.34], [0.068, 0.5], [0.075, L2 - 0.03], [0.076, L2]]), shell);
  add(j3, new THREE.CylinderGeometry(0.087, 0.087, 0.02, 48), accent, [0, 0.13, 0]);

  // --- A4: Rollachse im Unterarm ----------------------------------------
  const j4 = jointAt(j3, 0, L2, 0);
  rollSeam(j4, 0.077, 0);
  add(j4, link([[0.075, 0.004], [0.072, 0.05], [0.064, 0.1], [0.062, WRIST - 0.05]]), shell);
  add(j4, new THREE.CylinderGeometry(0.078, 0.078, 0.016, 40), accent, [0, 0.03, 0]);

  // --- A5/A6: Kugelhandgelenk -------------------------------------------
  const j5 = jointAt(j4, 0, WRIST, 0);
  housing(j5, "z", 0.072, 0.17);
  const j6 = jointAt(j5, 0, 0, 0);
  // A6 steht quer zu A5: Lagerdeckel auf den Flanken, Hals nach unten zum Flansch.
  for (const s of [-1, 1]) {
    add(j6, roundedCylinder(0.034, 0.014, 0.005, 28), graphite, [s * 0.071, 0, 0], across("x"));
    add(j6, new THREE.CylinderGeometry(0.012, 0.012, 0.004, 16), accent, [s * 0.079, 0, 0], across("x"));
  }
  add(j6, link([[0.05, -FLANGE + 0.006], [0.053, -0.05], [0.058, -0.03]]), shell);
  rollSeam(j6, 0.054, -0.052);

  // --- A7: Flansch und Vakuumgreifer ------------------------------------
  const j7 = jointAt(j6, 0, -FLANGE, 0);
  rollSeam(j7, 0.051, 0.004);
  add(j7, new THREE.CylinderGeometry(0.05, 0.05, 0.012, 40), steel, [0, -0.004, 0]);
  const flangeRing = add(j7, new THREE.TorusGeometry(0.051, 0.004, 8, 48), statusMat, [0, -0.002, 0], [Math.PI / 2, 0, 0]);
  flangeRing.castShadow = false;
  add(j7, new THREE.CylinderGeometry(0.036, 0.042, 0.018, 28), alu, [0, -0.019, 0]); // Werkzeugwechsler
  add(j7, new THREE.BoxGeometry(0.07, 0.022, 0.05), graphite, [0, -0.038, 0]);       // Ejektor
  add(j7, new THREE.BoxGeometry(0.02, 0.014, 0.03), steel, [0.045, -0.036, 0]);       // Schalldämpfer
  // Greiferplatte mit vier Faltenbalg-Saugern; die Lippen liegen auf dem TCP.
  const plateY = -0.056;
  const plateShape = new THREE.Shape();
  const pw = 0.095, pr = 0.016;
  plateShape.moveTo(-pw + pr, -pw);
  plateShape.lineTo(pw - pr, -pw); plateShape.quadraticCurveTo(pw, -pw, pw, -pw + pr);
  plateShape.lineTo(pw, pw - pr); plateShape.quadraticCurveTo(pw, pw, pw - pr, pw);
  plateShape.lineTo(-pw + pr, pw); plateShape.quadraticCurveTo(-pw, pw, -pw, pw - pr);
  plateShape.lineTo(-pw, -pw + pr); plateShape.quadraticCurveTo(-pw, -pw, -pw + pr, -pw);
  const plateGeo = new THREE.ExtrudeGeometry(plateShape, { depth: 0.01, bevelEnabled: true, bevelSize: 0.002, bevelThickness: 0.002, bevelSegments: 2 });
  plateGeo.rotateX(Math.PI / 2);
  add(j7, plateGeo, alu, [0, plateY + 0.006, 0]);
  const cupTop = plateY - 0.006;
  const cupH = GRIP + cupTop; // bis y = −GRIP
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * 0.062, z = sz * 0.062;
    add(j7, new THREE.CylinderGeometry(0.007, 0.007, 0.012, 12), steel, [x, cupTop - 0.002, z]);
    add(j7, new THREE.CylinderGeometry(0.008, 0.009, 0.008, 12), steel, [x, plateY + 0.011, z]);
    add(j7, bellows(0.019, Math.max(0.012, cupH - 0.008)), rubber, [x, -GRIP, z]);
    tube(j7, [
      new THREE.Vector3(sx * 0.02, -0.03, sz * 0.012),
      new THREE.Vector3(sx * 0.05, -0.022, sz * 0.045),
      new THREE.Vector3(x, plateY + 0.02, z),
      new THREE.Vector3(x, plateY + 0.008, z),
    ], 0.0045, hose);
  }
  const tcp = new THREE.Object3D();
  tcp.name = "tcp";
  tcp.position.set(0, -GRIP, 0);
  j7.add(tcp);

  /* -------------------------------------------------------- Bewegung */

  const setPose = (angles: number[]) => {
    for (let i = 0; i < joints.length; i++) {
      joints[i].rotation[AXIS[i]] = SIGN[i] * (angles[i] ?? 0);
    }
  };

  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
  const axisV = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const down = new THREE.Vector3(0, -1, 0), d = new THREE.Vector3(), xAxis = new THREE.Vector3();

  const solve = (target: THREE.Vector3, toolYaw: number, redundant: number): number[] => {
    const dx = target.x - base.x;
    const dz = target.z - base.z;
    const r = Math.hypot(dx, dz);
    const a1 = Math.atan2(-dz, dx);

    // Handwurzel = TCP + TOOL·ŷ (Werkzeug senkrecht); Schulter → Handwurzel über L1 und L2+WRIST.
    const h = target.y - (base.y + SHOULDER_Y) + TOOL;
    const M = L2 + WRIST;
    const maxReach = L1 + M - 0.015;
    const dist = Math.min(Math.hypot(r, h), maxReach);
    const cos3 = Math.max(-1, Math.min(1, (dist * dist - L1 * L1 - M * M) / (2 * L1 * M)));
    const a3 = Math.acos(cos3);
    const a2 = Math.atan2(r, h) - Math.atan2(M * Math.sin(a3), L1 + M * Math.cos(a3));
    const a4 = redundant;

    // Lage der Handwurzel vor A5 aus A1–A4, dann A5/A6 so, dass −y senkrecht nach unten zeigt:
    // Rz(φ)·Rx(ψ)·(0,−1,0) = (cosψ·sinφ, −cosψ·cosφ, −sinψ).
    qA.setFromAxisAngle(axisV.y, SIGN[0] * a1)
      .multiply(qB.setFromAxisAngle(axisV.z, SIGN[1] * a2))
      .multiply(qB.setFromAxisAngle(axisV.z, SIGN[2] * a3))
      .multiply(qB.setFromAxisAngle(axisV.y, SIGN[3] * a4));
    d.copy(down).applyQuaternion(qB.copy(qA).invert());
    const psi = Math.asin(Math.max(-1, Math.min(1, -d.z)));
    const phi = Math.atan2(d.x, -d.y);
    const a5 = phi / SIGN[4];
    const a6 = psi / SIGN[5];

    // A7: das Werkzeug steht senkrecht, also dreht A7 um die Senkrechte.
    qA.multiply(qB.setFromAxisAngle(axisV.z, phi)).multiply(qB.setFromAxisAngle(axisV.x, psi));
    xAxis.set(1, 0, 0).applyQuaternion(qA);
    const yaw0 = Math.atan2(-xAxis.z, xAxis.x);
    let a7 = toolYaw - yaw0;
    a7 = Math.atan2(Math.sin(a7), Math.cos(a7));
    return [a1, a2, a3, a4, a5, a6, a7 / SIGN[6]];
  };

  const home = HOME_TARGET.clone().add(new THREE.Vector3().subVectors(base, ARM_BASE));

  if (opts.ghost) {
    // Der Geist legt sich über den echten Arm: Flächen halb durchsichtig, kein
    // Tiefenschreiben (sonst schneidet er den Roboter an), keine Schatten.
    const ghostMat = new THREE.MeshStandardMaterial({
      color: 0x7cc4ff, emissive: 0x2f7fd0, emissiveIntensity: 0.55,
      metalness: 0.1, roughness: 0.45,
      transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide,
    });
    const glow = new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.9, depthWrite: false });
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = false;
      m.receiveShadow = false;
      m.renderOrder = 12;
      if (m === statusLight || m === flangeRing) m.material = glow;
      else m.material = ghostMat;
    });
    root.userData.ghost = true;
  }

  return { root, joints, tcp, statusLight, base: base.clone(), home, setPose, solve };
}

/** Ruhelage über dem Tisch. */
export const HOME_TARGET = new THREE.Vector3(0.05, 1.28, 0.18);
