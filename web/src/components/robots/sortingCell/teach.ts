/* Handführung: von meiner Hand zur Roboterpose.

   Google MediaPipe (Tasks Vision) liefert je Bild zwei Landmark-Sätze: 33
   Pose-Punkte (Schulter, Ellbogen, Handgelenk) und 21 Hand-Punkte. Diese Datei
   rechnet daraus ein Ziel im Koordinatensystem der Zelle und eine Werkzeuglage
   — mehr nicht: kein DOM, keine Kamera, kein Netz. `handTracking.ts` holt die
   Bilder, `runtime.ts` stellt den halbdurchsichtigen Arm (den „Geist") auf die
   Pose.

   Die Abbildung ist bewusst einfach und kalibrierbar: die Handgelenk-Lage
   relativ zur Schulter (Weltkoordinaten in Metern) wird gespiegelt, skaliert
   und in den Greifraum des Arms gelegt. `mirror` passt die Richtung an (wer
   hinter dem Roboter steht, dreht sie um), `gain`/`lift`/`depth` die
   Empfindlichkeit, `offset` merkt sich die Neutralstellung („Mitte setzen").
   Der Pinch-Abstand Daumen–Zeigefinger steuert den Sauger.

   Aufgezeichnet wird nur im Browser (JSON-Datei). Gimel führt keine Programme
   aus und sendet nichts an eine Steuerung — die Pose ist eine Vorlage. */

import * as THREE from "three";
import { BELT } from "./stations";

export interface Landmark { x: number; y: number; z: number; visibility?: number }

/** Ein Bild der Handführung: normierte Punkte fürs Bild, Weltpunkte in Metern. */
export interface TrackingFrame {
  hand: Landmark[] | null;
  handWorld: Landmark[] | null;
  pose: Landmark[] | null;
  poseWorld: Landmark[] | null;
  at: number;
}

export interface TeachMapping {
  /** Handbewegung nach rechts → Arm nach rechts (Spiegel der Kamera). */
  mirror: boolean;
  /** Seitliche Empfindlichkeit (1 = 1 m Handweg = 1 m Armweg). */
  gain: number;
  /** Höhenempfindlichkeit. */
  lift: number;
  /** Tiefenempfindlichkeit (Hand nach vorn → Arm zum Band). */
  depth: number;
  /** Neutralstellung aus „Mitte setzen" (Meter, relativ zur Schulter). */
  offset: { x: number; y: number; z: number };
}

export const DEFAULT_MAPPING: TeachMapping = {
  mirror: true, gain: 1.35, lift: 1.15, depth: 1.0,
  offset: { x: 0, y: 0, z: 0 },
};

export type TeachSide = "links" | "rechts";

export interface TeachSolution {
  /** Ziel in Zellenkoordinaten (Meter). */
  target: { x: number; y: number; z: number };
  /** Werkzeuglage (rad) um die Senkrechte. */
  yaw: number;
  /** 0 = offen, 1 = geschlossen (Daumen–Zeigefinger). */
  pinch: number;
  /** Sauger: 0 = aus, 1 = voll. */
  gripper: number;
  side: TeachSide;
  /** Handgelenk relativ zur Schulter in Metern, nach Offset/Kalibrierung. */
  local: { x: number; y: number; z: number };
}

/* Pose-Landmark-Indizes (MediaPipe). */
const POSE = {
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
};
/* Hand-Landmark-Indizes (MediaPipe). */
const HAND = { wrist: 0, thumb: 4, indexMcp: 5, indexTip: 8, middleMcp: 9, middleTip: 12, pinkyMcp: 17 };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const sub = (a: Landmark, b: Landmark) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

/** Greifraum, in den die Hand abgebildet wird (Meter, Zellenkoordinaten). */
export const TEACH_VOLUME = {
  /** Höhe der Neutralstellung über dem Tisch. */
  neutralY: 0.96,
  neutralZ: 0.4,
  /** Seitlicher Spielraum um die Neutralstellung. */
  spanX: 0.62,
  /** Größter Abstand des Ziels vom Armfuß (bleibt im Greifraum der IK). */
  maxRadius: 1.22,
};

/** Pinch-Verhältnis (Daumen–Zeigefinger / Handlänge), unter dem der Sauger greift. */
export const PINCH_CLOSED = 0.35;
export const PINCH_OPEN = 1.0;

/**
 * Handgelenk relativ zur Schulter. Fällt auf die Bildpunkte zurück, wenn
 * MediaPipe keine Weltpunkte geliefert hat (dann geschätzt mit 1,5 m Körper-
 * breite statt Metern).
 */
function wristLocal(frame: TrackingFrame): { p: { x: number; y: number; z: number }; side: TeachSide } | null {
  const w = frame.poseWorld ?? frame.pose;
  if (!w) return null;
  const hasRight = !!w[POSE.rightWrist] && !!w[POSE.rightShoulder];
  const hasLeft = !!w[POSE.leftWrist] && !!w[POSE.leftShoulder];
  if (!hasRight && !hasLeft) return null;
  const vis = (lm?: Landmark) => lm?.visibility ?? 1;
  const right = hasRight ? vis(w[POSE.rightWrist]) : -1;
  const left = hasLeft ? vis(w[POSE.leftWrist]) : -1;
  const pickRight = right >= left;
  const shoulder = w[pickRight ? POSE.rightShoulder : POSE.leftShoulder];
  const wrist = w[pickRight ? POSE.rightWrist : POSE.leftWrist];
  const scale = frame.poseWorld ? 1 : 1.5; // normierte Punkte → grob Meter
  const d = sub(wrist, shoulder);
  return { p: { x: d.x * scale, y: d.y * scale, z: d.z * scale }, side: pickRight ? "rechts" : "links" };
}

/** Seitliche Werkzeuglage aus der Hand im Bild (Daumen–Fingerrichtung). */
function handYaw(frame: TrackingFrame, mirror: boolean): number {
  const hand = frame.hand;
  if (!hand || !hand[HAND.wrist] || !hand[HAND.middleTip]) return 0;
  const d = sub(hand[HAND.middleTip], hand[HAND.wrist]);
  // Bild-y zeigt nach unten; oben (Finger nach oben) ist Lage 0.
  const a = Math.atan2((mirror ? -1 : 1) * d.x, -d.y);
  return clamp(a, -Math.PI, Math.PI);
}

/** Pinch 0…1: Daumen- und Zeigefingerspitze im Verhältnis zur Handfläche. */
export function pinchOf(hand: Landmark[] | null): number {
  if (!hand) return 1;
  const w = hand[HAND.wrist], i = hand[HAND.indexTip], t = hand[HAND.thumb], m = hand[HAND.middleMcp];
  if (!w || !i || !t || !m) return 1;
  const palm = Math.max(1e-4, Math.hypot(m.x - w.x, m.y - w.y));
  const span = Math.hypot(i.x - t.x, i.y - t.y);
  return clamp(span / palm, 0, 3);
}

/** Pinch-Verhältnis → Sauger (0 offen … 1 zu). */
export function gripperOf(pinch: number): number {
  return 1 - clamp((pinch - PINCH_CLOSED) / (PINCH_OPEN - PINCH_CLOSED), 0, 1);
}

/**
 * Meine Hand → Ziel im Greifraum und Werkzeuglage.
 * `base` ist der Armfuß der Zelle (Meter); `null`, wenn keine Schulter im Bild ist.
 */
export function teachSolution(
  frame: TrackingFrame,
  mapping: TeachMapping,
  base: { x: number; y: number; z: number },
): TeachSolution | null {
  const w = wristLocal(frame);
  if (!w) return null;
  const p = {
    x: w.p.x - mapping.offset.x,
    y: w.p.y - mapping.offset.y,
    z: w.p.z - mapping.offset.z,
  };
  const sign = mapping.mirror ? -1 : 1;
  let x = base.x + sign * p.x * mapping.gain;
  let y = TEACH_VOLUME.neutralY + -p.y * mapping.lift;
  let z = TEACH_VOLUME.neutralZ + p.z * mapping.depth;

  x = clamp(x, base.x - TEACH_VOLUME.spanX, base.x + TEACH_VOLUME.spanX);
  y = clamp(y, BELT.top + 0.04, 1.62);
  z = clamp(z, 0.0, 1.0);

  // Nicht über den Greifraum hinauslaufen: die IK würde sonst nur abschneiden.
  const dx = x - base.x, dz = z - base.z;
  const r = Math.hypot(dx, dz);
  if (r > TEACH_VOLUME.maxRadius) {
    const k = TEACH_VOLUME.maxRadius / r;
    x = base.x + dx * k;
    z = base.z + dz * k;
  }

  const pinch = pinchOf(frame.hand);
  return {
    target: { x, y, z },
    yaw: handYaw(frame, mapping.mirror),
    pinch,
    gripper: gripperOf(pinch),
    side: w.side,
    local: p,
  };
}

/* --------------------------------------------------------- Hand im 3D */

/** Die 21 Punkte der Hand als Skelett am Werkzeug (Three.js). */
export interface HandSkeleton {
  group: THREE.Group;
  update(hand: Landmark[] | null, gripper: number): void;
  dispose(): void;
}

const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/** Skelett, das unter dem Flansch hängt: Handfläche nach unten, Finger nach vorn. */
export function buildHandSkeleton(): HandSkeleton {
  const group = new THREE.Group();
  group.name = "teach-hand";
  group.position.set(0, -0.085, 0);
  group.visible = false;

  const count = 21;
  const lineGeo = new THREE.BufferGeometry();
  const linePos = new Float32Array(HAND_BONES.length * 2 * 3);
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x9fdcff, transparent: true, opacity: 0.95, depthWrite: false,
  });
  const bones = new THREE.LineSegments(lineGeo, lineMat);
  bones.frustumCulled = false;
  bones.renderOrder = 14;
  group.add(bones);

  const dotGeo = new THREE.BufferGeometry();
  const dotPos = new Float32Array(count * 3);
  dotGeo.setAttribute("position", new THREE.BufferAttribute(dotPos, 3));
  const dotMat = new THREE.PointsMaterial({
    color: 0xd8f1ff, size: 0.018, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false,
  });
  const dots = new THREE.Points(dotGeo, dotMat);
  dots.frustumCulled = false;
  dots.renderOrder = 15;
  group.add(dots);

  const update = (hand: Landmark[] | null, gripper: number) => {
    group.visible = !!hand;
    if (!hand) return;
    const w = hand[0];
    if (!w) { group.visible = false; return; }
    // Egal ob normierte Bildpunkte oder Weltpunkte in Metern: die Handwurzel
    // liegt im Ursprung, die Hand wird auf eine Palmhöhe von 8,5 cm skaliert.
    // Bild-x wird gespiegelt, damit die Bewegung vor der Kamera mit der Zelle läuft.
    const palm = Math.max(1e-6, Math.hypot((hand[HAND.middleMcp]?.x ?? w.x) - w.x, (hand[HAND.middleMcp]?.y ?? w.y) - w.y));
    const k = 0.085 / palm;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const lm = hand[i];
      if (!lm) { pts.push(new THREE.Vector3()); continue; }
      pts.push(new THREE.Vector3(-(lm.x - w.x) * k, (w.y - lm.y) * k * 0.55, (lm.y - w.y) * k));
    }
    for (let i = 0; i < count; i++) {
      dotPos[i * 3] = pts[i].x; dotPos[i * 3 + 1] = pts[i].y; dotPos[i * 3 + 2] = pts[i].z;
    }
    HAND_BONES.forEach(([a, b], i) => {
      const o = i * 6;
      linePos[o] = pts[a].x; linePos[o + 1] = pts[a].y; linePos[o + 2] = pts[a].z;
      linePos[o + 3] = pts[b].x; linePos[o + 4] = pts[b].y; linePos[o + 5] = pts[b].z;
    });
    (bones.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (dots.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    dotMat.color.setHex(gripper > 0.55 ? 0x33d6a6 : 0xd8f1ff);
    lineMat.color.setHex(gripper > 0.55 ? 0x33d6a6 : 0x9fdcff);
  };

  return {
    group,
    update,
    dispose() {
      lineGeo.dispose(); lineMat.dispose();
      dotGeo.dispose(); dotMat.dispose();
    },
  };
}

/**
 * Trockenlauf ohne Kamera: dieselbe Form von Frame wie MediaPipe, nur gerechnet.
 * Damit lässt sich die ganze Kette (Abbildung → IK → Geist → Aufzeichnung) ohne
 * Webcam prüfen — und im Test.
 */
export function syntheticFrame(tMs: number): TrackingFrame {
  const t = tMs / 1000;
  const shoulder = { x: 0.16, y: -0.18, z: 0 };
  const wrist = {
    x: shoulder.x + 0.28 + 0.16 * Math.sin(t * 0.9),
    y: shoulder.y + 0.16 + 0.12 * Math.cos(t * 1.25),
    z: 0.18 + 0.22 * Math.sin(t * 0.55 + 0.6),
  };
  const pose: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  pose[POSE.rightShoulder] = { x: 0.42, y: 0.38, z: 0, visibility: 1 };
  pose[POSE.rightElbow] = { x: 0.3, y: 0.48, z: 0, visibility: 1 };
  pose[POSE.rightWrist] = { x: 0.22, y: 0.55, z: 0, visibility: 1 };
  pose[POSE.leftShoulder] = { x: 0.58, y: 0.38, z: 0, visibility: 0.6 };
  pose[POSE.leftWrist] = { x: 0.7, y: 0.55, z: 0, visibility: 0.2 };
  const poseWorld: Landmark[] = pose.map((lm) => ({ ...lm }));
  poseWorld[POSE.rightShoulder] = shoulder;
  poseWorld[POSE.rightWrist] = wrist;
  poseWorld[POSE.rightElbow] = { x: (shoulder.x + wrist.x) / 2, y: (shoulder.y + wrist.y) / 2 + 0.04, z: (shoulder.z + wrist.z) / 2 };

  // Hand: Handfläche nach unten, Finger nach oben im Bild.
  const cx = 0.5 + 0.05 * Math.sin(t * 0.9);
  const cy = 0.55 + 0.03 * Math.cos(t * 1.25);
  const open = 0.55 + 0.35 * Math.sin(t * 1.7);
  const hand: Landmark[] = [];
  const mcp: [number, number][] = [[0.46, 0.48], [0.49, 0.47], [0.52, 0.48], [0.55, 0.5]];
  const tipY = 0.36;
  hand[0] = { x: cx, y: cy, z: 0 };
  for (let f = 0; f < 4; f++) {
    const [mx, my] = mcp[f];
    const base = 5 + f * 4;
    hand[base] = { x: mx, y: my, z: 0 };
    hand[base + 1] = { x: mx + (mx - cx) * 0.1, y: (my + tipY) / 2, z: 0 };
    hand[base + 2] = { x: mx + (mx - cx) * 0.2, y: tipY + 0.02, z: 0 };
    hand[base + 3] = { x: mx + (mx - cx) * 0.3, y: tipY, z: 0 };
  }
  // Daumen — schließt und öffnet sich mit `open`.
  hand[8] = { x: 0.5 + 0.01 * open, y: tipY, z: 0 };
  hand[1] = { x: cx - 0.045, y: cy - 0.03, z: 0 };
  hand[2] = { x: cx - 0.08, y: cy - 0.06, z: 0 };
  hand[3] = { x: cx - 0.045 - 0.055 * open, y: cy - 0.08 - 0.012 * open, z: 0 };
  hand[4] = { x: hand[8].x + 0.015 - 0.085 * open, y: hand[8].y + 0.005 + 0.105 * open, z: 0 };
  const handWorld = hand.map((lm) => ({ x: lm.x * 0.3, y: lm.y * 0.3, z: 0 }));

  return { hand, handWorld, pose, poseWorld, at: tMs };
}
