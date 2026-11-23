/* Ablauf der Sortierzelle.

   Seit 2026-11-09 so viele Arme wie die Halle hergibt (höchstens zwei, siehe
   `stations.ts`). Das Band läuft von links nach rechts; jeder Arm hat seine
   Greifstelle und seinen Korbstreifen. Ein Teil hält an der Station an, die
   seine Klasse bedient — gehört es einem weiter hinten stehenden Arm, fährt es
   an der ersten Station vorbei. Das Band steht, solange ein Teil an einer
   Station wartet oder ein Arm gerade greift; sonst läuft es.

   Je Arm: Ruhe → über das Teil → senken → greifen → anheben → zum Korb →
   ablegen → zurück. Die Teileerkennung ist dieselbe wie bisher
   (`teilerkennung.ts`, eine Übersetzung von gimel/core/vision.py::match), der
   halbdurchsichtige „Geist" daneben ist die Handführung (`teach.ts`).

   Drei Kamerasichten, ein Renderer: die Perspektive zeigt die Zelle, die
   Orthokamera direkt von oben zeigt „was die Kamera sieht". Beide Bilder
   werden mit Scissor/Viewport in dieselbe Leinwand gerendert; die
   Erkennungsrahmen werden aus denselben Tisch-Millimetern projiziert.

   Alles ist Simulation: dargestellt, nicht gemessen; keine Steuerung. */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  BIN_COUNT, FORMS, ODD_FORM, REJECT_BIN, formById, placeRings,
  type FormTemplate, type Pt,
} from "./forms";
import { classify, measureFromFrame, type Classification } from "./teilerkennung";
import { buildArm, JOINT_NAMES, type ArmRig } from "./robotArm";
import {
  BELT, BELT_MM_S, BIN_TOP, CAM_CENTER, SPACING_MM, binTarget, buildCellScene,
  makePartMesh, type CellScene,
} from "./cellScene";
import { stationForBin, type CellLayout, type StationSpec } from "./stations";
import { buildHandSkeleton, type HandSkeleton, type Landmark } from "./teach";

export interface Rect { x: number; y: number; w: number; h: number }

export interface OverlayPart {
  key: string;
  points: string;
  label: string;
  tag: string;
  confidence: number;
  sure: boolean;
  counted: boolean;
  index: number;
  cx: number;
  cy: number;
  unknown: boolean;
}

export interface Overlay {
  rect: Rect;
  parts: OverlayPart[];
  zone: string;
  crossX: number;
  crossY: number;
  w: number;
  h: number;
  stamp: string;
}

export interface LogEntry { at: string; text: string; tone: "ok" | "warn" | "info" }

/** Ein Arm der Flotte, wie ihn die Zelle aufstellt. */
export interface ArmSpec { id: number | null; name: string }

export interface ArmView {
  index: number;
  id: number | null;
  name: string;
  phase: string;
  phaseLabel: string;
  joints: number[];
  stationMm: number;
  carrying: boolean;
  cycles: number;
  bins: { bin: number; local: number; label: string }[];
}

export interface TeachView { active: boolean; gripper: number }

export interface Snapshot {
  phase: string;
  phaseLabel: string;
  playing: boolean;
  speed: number;
  noise: number;
  bigCam: boolean;
  toleranceMm: number;
  joints: number[];
  jointNames: string[];
  hit: Classification | null;
  hitFormId: string | null;
  counts: number[];
  total: number;
  unsure: number;
  cycles: number;
  avgConfidence: number;
  queue: { label: string; tag: string; colour: number }[];
  log: LogEntry[];
  still: boolean;
  calibration: { height_mm: number; hfov_deg: number; tolerance_mm: number; pitch_deg: number; roll_deg: number };
  /** Alle Arme der Zelle, in Bandreihenfolge. */
  arms: ArmView[];
  focus: number;
  layoutLabel: string;
  teach: TeachView | null;
}

export interface RuntimeCallbacks {
  onSnapshot(s: Snapshot): void;
  onOverlay(o: Overlay): void;
  onGlError?(message: string): void;
}

type Phase = "idle" | "approach" | "descend" | "grip" | "lift" | "transit" | "place" | "home";

const PHASES: { id: Phase; label: string; dur: number }[] = [
  { id: "idle", label: "Bereit", dur: 0.30 },
  { id: "approach", label: "Arm fährt über das Teil", dur: 0.95 },
  { id: "descend", label: "Greifer senkt", dur: 0.55 },
  { id: "grip", label: "Sauger greift", dur: 0.32 },
  { id: "lift", label: "Anheben", dur: 0.55 },
  { id: "transit", label: "Fahrt zum Korb", dur: 1.10 },
  { id: "place", label: "Ablegen", dur: 0.52 },
  { id: "home", label: "Rückfahrt", dur: 0.85 },
];
const PHASE_INDEX = Object.fromEntries(PHASES.map((p, i) => [p.id, i])) as Record<Phase, number>;

const ease = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const timeStamp = () => new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const deg = (r: number) => (r * 180) / Math.PI;

interface BeltPart {
  id: number;
  mesh: THREE.Mesh;
  form: FormTemplate;
  xMm: number;
  yMm: number;
  angleDeg: number;
  hit: Classification | null;
  /** Korb und Station, die dieses Teil bedienen (aus der Klassifikation). */
  ownerBin: number;
  ownerStation: number;
  /** Gesetzt, sobald das Teil an seiner Station steht — dann hält das Band. */
  holdStation: number | null;
}

/** Zustand eines Arms in der Zelle. */
interface ArmUnit {
  spec: ArmSpec;
  station: StationSpec;
  rig: ArmRig;
  phase: Phase;
  elapsed: number;
  poseFrom: number[];
  poseTo: number[];
  joints: number[];
  pick: THREE.Vector3;
  pickYaw: number;
  hit: Classification | null;
  targetBin: number;
  targetLocal: number;
  carried: THREE.Mesh | null;
  carriedForm: FormTemplate | null;
  dropFrom: THREE.Vector3 | null;
  cycles: number;
}

/** Gesäter Zufall: die Vorführung läuft bei jedem Neuladen gleich. */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export class SortingCellRuntime {
  private renderer: THREE.WebGLRenderer;
  private scene3d: CellScene;
  private layout: CellLayout;
  private arms: ArmUnit[] = [];
  private ghost: ArmRig | null = null;
  private hand: HandSkeleton | null = null;
  private teachActive = false;
  private teachGripper = 0;
  private teachJoints: number[] | null = null;
  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private stage: HTMLElement;
  private threePane: HTMLElement;
  private camPane: HTMLElement;
  private cb: RuntimeCallbacks;

  private rectThree: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private rectCam: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private W = 1;
  private H = 1;

  private rand = seeded(0x51a7c3);
  private planned: FormTemplate[] = [];
  private belt: BeltPart[] = [];
  private nextPartId = 1;
  private overlayParts: OverlayPart[] = [];
  private lastStamp = "—";

  private focus = 0;
  private counts = new Array<number>(BIN_COUNT).fill(0);
  private unsure = 0;
  private cycles = 0;
  private confSum = 0;
  private confN = 0;
  private log: LogEntry[] = [];

  private playing = true;
  private speed = 1;
  private noise = 0.12;
  private bigCam = false;
  private toleranceMm = 3;

  private raf = 0;
  private lastFrame = 0;
  private lastSnapshot = 0;
  private clock = 0;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    stage: HTMLElement,
    threePane: HTMLElement,
    camPane: HTMLElement,
    layout: CellLayout,
    arms: ArmSpec[],
    cb: RuntimeCallbacks,
    focus = 0,
  ) {
    this.stage = stage;
    this.threePane = threePane;
    this.camPane = camPane;
    this.layout = layout;
    this.cb = cb;
    this.focus = clamp(focus, 0, Math.max(0, layout.arms - 1));

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false });
    } catch (e) {
      this.cb.onGlError?.(e instanceof Error ? e.message : String(e));
      throw e;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene3d = buildCellScene(layout);
    for (const station of layout.stations) {
      const spec = arms[station.index] ?? { id: null, name: `Arm ${station.index + 1}` };
      const rig = buildArm(new THREE.Vector3(station.base.x, station.base.y, station.base.z));
      // Ebene 1: Armkörper. Die Perspektive sieht beide Ebenen, die Kamera von
      // oben nur Ebene 0 — sonst steht der Arm genau vor „was die Kamera sieht".
      rig.root.traverse((o) => o.layers.set(1));
      this.scene3d.scene.add(rig.root);
      const home = rig.solve(rig.home, 0, 0);
      this.arms.push({
        spec, station, rig,
        phase: "idle", elapsed: 0,
        poseFrom: [...home], poseTo: [...home], joints: [...home],
        pick: new THREE.Vector3(station.x, BELT.top, 0),
        pickYaw: 0,
        hit: null,
        targetBin: REJECT_BIN, targetLocal: Math.max(0, station.bins.length - 1),
        carried: null, carriedForm: null, dropFrom: null,
        cycles: 0,
      });
    }

    // Nur der gewählte Arm steht im Bild: mehrere Arme in einer Zelle sind
    // eine Listen-/Stationsangelegenheit, nicht eine zweite (dritte) Silhouette.
    for (let i = 0; i < this.arms.length; i++) this.arms[i].rig.root.visible = i === this.focus;

    // Handführung: derselbe Arm, halbdurchsichtige, über dem gewählten Arm.
    const focusStation = layout.stations[this.focus] ?? layout.stations[0];
    if (focusStation) {
      this.ghost = buildArm(new THREE.Vector3(focusStation.base.x, focusStation.base.y, focusStation.base.z), { ghost: true });
      this.ghost.root.visible = false;
      this.hand = buildHandSkeleton();
      this.ghost.tcp.add(this.hand.group);
      this.ghost.root.traverse((o) => o.layers.set(1));
      this.scene3d.scene.add(this.ghost.root);
    }

    this.persp = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
    if (layout.arms > 1) {
      const midX = (layout.stations[0].x + layout.stations[layout.stations.length - 1].x) / 2;
      this.persp.position.set(midX - 2.45, 2.45, 3.4);
      this.controls = new OrbitControls(this.persp, this.renderer.domElement);
      this.controls.target.set(midX, 0.86, -0.02);
    } else {
      this.persp.position.set(-2.45, 2.2, 3.0);
      this.controls = new OrbitControls(this.persp, this.renderer.domElement);
      this.controls.target.set(-0.2, 0.82, 0.08); // Band und Arm beide im Bild
    }
    this.persp.layers.enable(1);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 7;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.update();

    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
    this.ortho.position.set(CAM_CENTER.x, 3.1, CAM_CENTER.z);
    this.ortho.up.set(0, 0, -1);
    this.ortho.lookAt(CAM_CENTER.x, BELT.top, CAM_CENTER.z);
    this.ortho.layers.set(0);

    for (let i = 0; i < 8; i++) this.planned.push(this.drawForm());
    this.seedBelt();
    this.measureBelt();

    for (const arm of this.arms) {
      arm.poseTo = this.poseFor(arm, "idle");
      arm.joints = [...arm.poseTo];
      arm.rig.setPose(arm.joints);
    }
    this.resize();
    this.publish();
    this.emitOverlay();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ------------------------------------------------------------- Teile */

  private drawForm(): FormTemplate {
    const r = this.rand();
    if (r < 0.12) return ODD_FORM; // Fremdteil → „unbekannt"
    return FORMS[Math.floor(this.rand() * FORMS.length)];
  }

  private pullForm(): FormTemplate {
    const f = this.planned.shift() ?? FORMS[0];
    this.planned.push(this.drawForm());
    return f;
  }

  private spawnAt(form: FormTemplate, xMm: number): BeltPart {
    const mesh = makePartMesh(form);
    const yMm = (this.rand() * 2 - 1) * 110;
    const angleDeg = (this.rand() * 2 - 1) * 70;
    mesh.position.set(xMm / 1000, BELT.top + 0.004, yMm / 1000);
    mesh.rotation.y = (angleDeg * Math.PI) / 180;
    this.scene3d.scene.add(mesh);
    const hit = classify(this.measureRings(form, xMm, yMm, angleDeg), {
      tolerance_mm: this.toleranceMm, work_order: `IA-${2400 + (this.cycles % 7)}`,
    });
    const ownerBin = hit.form?.bin ?? REJECT_BIN;
    const ownerStation = stationForBin(this.layout, ownerBin);
    const part: BeltPart = {
      id: this.nextPartId++, mesh, form, xMm, yMm, angleDeg, hit,
      ownerBin, ownerStation,
      holdStation: null,
    };
    // Ein Teil, das an der ersten Station liegt und dort auch hingehört, wartet.
    if (Math.abs(xMm - this.layout.stations[0].x * 1000) < 1 && ownerStation === 0) part.holdStation = 0;
    this.belt.push(part);
    this.belt.sort((a, b) => b.xMm - a.xMm);
    return part;
  }

  /** Erste Füllung: ein Teil an der ersten Station, die nächsten dahinter. */
  private seedBelt() {
    const first = this.layout.stations[0];
    if (!first) return;
    const start = Math.round(first.x * 1000);
    for (let i = 2; i >= 0; i--) {
      const x = start - i * SPACING_MM;
      if (x < this.layout.beltStartMm + 30) continue;
      this.spawnAt(this.pullForm(), x);
    }
  }

  private removeBelt(part: BeltPart) {
    const i = this.belt.indexOf(part);
    if (i >= 0) this.belt.splice(i, 1);
    this.scene3d.scene.remove(part.mesh);
  }

  private disposeMesh(mesh: THREE.Mesh) {
    mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m.dispose();
  }

  /* --------------------------------------------------- Teileerkennung */

  /** Ringe eines Teils so, wie die Kamera oben sie misst (Tisch-Millimeter). */
  private measureRings(form: FormTemplate, xMm: number, yMm: number, angleDeg: number): Pt[][] {
    return measureFromFrame(placeRings(form.rings, xMm, yMm, -angleDeg), this.noise, this.rand);
  }

  /** Alle Teile auf dem Band neu messen und die Rahmen fürs Kamerabild bauen. */
  private measureBelt() {
    for (const part of this.belt) {
      part.hit = classify(this.measureRings(part.form, part.xMm, part.yMm, part.angleDeg), {
        tolerance_mm: this.toleranceMm, work_order: `IA-${2400 + (this.cycles % 7)}`,
      });
      part.ownerBin = part.hit.form?.bin ?? REJECT_BIN;
    }
    this.belt.sort((a, b) => b.xMm - a.xMm);
    this.overlayParts = [];
    for (const part of this.belt) {
      const h = part.hit;
      if (!h) continue;
      const box = h.box;
      const pts = box.corners.map((c) => this.mmToPx(c)).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
      const centre = this.mmToPx([box.x_mm, box.y_mm]);
      this.overlayParts.push({
        key: `p${part.id}`,
        points: pts,
        label: h.form?.label ?? "Unbekanntes Teil",
        tag: h.form?.tag ?? "kein Treffer",
        confidence: h.form ? h.confidence : 0,
        sure: h.sure,
        counted: false,
        index: this.overlayParts.length + 1,
        cx: centre[0], cy: centre[1],
        unknown: h.form == null,
      });
    }
    this.emitOverlay();
  }

  private partFor(arm: ArmUnit): BeltPart | null {
    return this.belt.find((p) => p.holdStation === arm.station.index) ?? null;
  }

  /** Standbild der Kamera und Entscheidung für den Arm, der gerade anfährt. */
  private captureFor(arm: ArmUnit) {
    this.lastStamp = timeStamp();
    this.measureBelt();
    const part = this.partFor(arm);
    arm.hit = part?.hit ?? null;
    if (part) arm.pick.set(part.xMm / 1000, BELT.top, part.yMm / 1000);
    else arm.pick.set(arm.station.x, BELT.top, 0);
    arm.pickYaw = part ? (part.angleDeg * Math.PI) / 180 : 0;

    const label = this.armLabel(arm);
    if (arm.hit?.sure && arm.hit.form) {
      arm.targetBin = arm.hit.form.bin;
      this.confSum += arm.hit.confidence; this.confN++;
      this.addLog(`${label} · ${arm.hit.form.label} · ${Math.round(arm.hit.confidence * 100)} % → ${this.binName(arm, arm.targetBin)}`, "ok");
    } else if (arm.hit?.form) {
      arm.targetBin = REJECT_BIN;
      this.unsure++;
      this.addLog(`${label} · ${arm.hit.form.label} nur ${Math.round(arm.hit.confidence * 100)} % → Nachprüfung`, "warn");
    } else {
      arm.targetBin = REJECT_BIN;
      this.unsure++;
      this.addLog(`${label} · keine offene Form passt → Nachprüfung`, "warn");
    }
    const bin = arm.station.bins.find((b) => b.bin === arm.targetBin);
    arm.targetLocal = bin?.local ?? Math.max(0, arm.station.bins.length - 1);
    if (!bin) arm.targetBin = arm.station.bins[arm.targetLocal]?.bin ?? REJECT_BIN;
    this.publish();
  }

  private binName(arm: ArmUnit, bin: number): string {
    const spec = arm.station.bins.find((b) => b.bin === bin);
    return spec ? `Korb ${spec.local + 1} · ${spec.label}` : "Nachprüfung";
  }

  private armLabel(arm: ArmUnit): string {
    return arm.spec.name;
  }

  /* ------------------------------------------------------- Kinematik */

  private poseFor(arm: ArmUnit, phase: Phase): number[] {
    const px = arm.pick.x;
    const pz = arm.pick.z;
    const yaw = arm.pickYaw;
    const hover = new THREE.Vector3(px, 1.12, pz);
    const down = new THREE.Vector3(px, BELT.top + 0.025, pz);
    const bin = binTarget(this.layout, arm.station.index, arm.targetBin);
    const redundant = 0.10 * Math.sin(this.clock * 1.6 + arm.station.index * 2.1);
    switch (phase) {
      case "approach": return arm.rig.solve(hover, yaw, redundant);
      case "descend":
      case "grip": return arm.rig.solve(down, yaw, 0);
      case "lift": return arm.rig.solve(hover, yaw, redundant);
      case "transit": return arm.rig.solve(new THREE.Vector3(bin.x, 1.12, bin.z), 0, redundant);
      case "place": return arm.rig.solve(new THREE.Vector3(bin.x, BIN_TOP + 0.02, bin.z), 0, 0);
      default: return arm.rig.solve(arm.rig.home, 0, 0);
    }
  }

  private enterArm(arm: ArmUnit, phase: Phase) {
    arm.phase = phase;
    arm.elapsed = 0;

    if (phase === "approach") this.captureFor(arm);

    if (phase === "grip") {
      const part = this.partFor(arm);
      if (part) {
        arm.carried = part.mesh;
        arm.carriedForm = part.form;
        arm.rig.tcp.attach(part.mesh);
        this.removeBelt(part);
        const entry = this.overlayParts.find((p) => p.key === `p${part.id}`);
        if (entry) { entry.counted = true; this.emitOverlay(); }
      }
    }
    if (phase === "place" && arm.carried) {
      this.scene3d.scene.attach(arm.carried);
      arm.dropFrom = arm.carried.position.clone();
    }

    arm.poseFrom = [...arm.joints];
    arm.poseTo = this.poseFor(arm, phase);
    this.publish();
  }

  private finishArm(arm: ArmUnit) {
    if (arm.phase === "place" && arm.carried && arm.carriedForm) {
      const stack = this.scene3d.binStacks[arm.station.index]?.[arm.targetLocal];
      if (stack) stack.attach(arm.carried);
      const n = this.counts[arm.targetBin] ?? 0;
      const slot = n % 6;
      arm.carried.position.set((this.rand() * 2 - 1) * 0.045, 0.79 + slot * 0.009, (this.rand() * 2 - 1) * 0.04);
      arm.carried.rotation.set(0, this.rand() * Math.PI, 0);
      arm.carried.scale.setScalar(0.72);
      this.counts[arm.targetBin] = n + 1;
      this.cycles++;
      arm.cycles++;
      this.addLog(`${this.armLabel(arm)} · ${arm.carriedForm.label} abgelegt → ${this.binName(arm, arm.targetBin)}`, "info");
      arm.carried = null;
      arm.carriedForm = null;
      arm.dropFrom = null;
    }
    if (arm.phase === "home") {
      arm.hit = null;
    }
  }

  private nextPhase(arm: ArmUnit) {
    const index = (PHASE_INDEX[arm.phase] + 1) % PHASES.length;
    // „idle" startet den nächsten Zyklus, sobald ein Teil an der Station steht.
    this.enterArm(arm, PHASES[index].id);
  }

  /* ---------------------------------------------------------- Schleife */

  private loop = (now: number) => {
    if (this.disposed) return;
    const dt = clamp((now - this.lastFrame) / 1000, 0, 0.06);
    this.lastFrame = now;
    this.tick(dt);
    this.controls.update();
    this.render();
    if (now - this.lastSnapshot > 110) { this.lastSnapshot = now; this.publish(); }
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Das Band läuft, solange kein Teil an einer Station wartet und kein Arm greift. */
  private beltFree(): boolean {
    if (!this.playing) return false;
    if (this.belt.some((p) => p.holdStation != null)) return false;
    return !this.arms.some((a) => a.phase === "approach" || a.phase === "descend" || a.phase === "grip");
  }

  private feed(dt: number) {
    if (!this.beltFree()) return;
    const stepMm = dt * this.speed * BELT_MM_S;
    for (const part of this.belt) {
      if (part.holdStation != null) continue;
      const station = this.layout.stations[part.ownerStation];
      const stopMm = station ? Math.round(station.x * 1000) : Infinity;
      const next = part.xMm + stepMm;
      if (part.xMm <= stopMm && next >= stopMm) {
        part.xMm = stopMm;
        part.holdStation = station.index;
      } else {
        part.xMm = Math.min(next, this.layout.beltEndMm + 40);
      }
      part.mesh.position.x = part.xMm / 1000;
    }
    // Teile, die niemand mehr nimmt, verlassen die Zelle am Bandende.
    for (const part of [...this.belt]) {
      if (part.xMm > this.layout.beltEndMm + 20) {
        this.removeBelt(part);
        this.disposeMesh(part.mesh);
        this.addLog(`${part.form.label} vom Band gelaufen (keine Station frei)`, "warn");
      }
    }
    this.belt.sort((a, b) => b.xMm - a.xMm);
    // Nachschub: nur wenn hinten Platz ist.
    const last = this.belt[this.belt.length - 1];
    if (this.belt.length < 5 && (!last || last.xMm - this.layout.spawnMm >= SPACING_MM)) {
      this.spawnAt(this.pullForm(), this.layout.spawnMm);
    }
  }

  private tick(dt: number) {
    const step = dt * this.speed;
    this.feed(dt);
    if (this.playing) this.clock += step;

    for (const arm of this.arms) {
      const phase = PHASES[PHASE_INDEX[arm.phase]];
      if (this.playing) arm.elapsed += step;

      if (arm.phase === "idle" && this.playing && this.partFor(arm)) {
        this.enterArm(arm, "approach");
      }

      // Weiches An- und Auslaufen der Pose; A4 ist die redundante Achse: sie
      // schwenkt im Nullraum weiter, ohne den TCP zu bewegen — das trennt den
      // 7-Achs-Arm vom 6-Achs-Arm.
      const t = ease(clamp(arm.elapsed / phase.dur, 0, 1));
      for (let i = 0; i < arm.joints.length; i++) arm.joints[i] = lerp(arm.poseFrom[i], arm.poseTo[i], t);
      if (this.playing) arm.joints[3] = 0.14 * Math.sin(this.clock * 1.05 + arm.station.index * 1.7);
      arm.rig.setPose(arm.joints);

      // Leuchtring an Fuß und Flansch: Farbe und Leuchten folgen der Phase.
      const led = arm.rig.statusLight.material as THREE.MeshStandardMaterial;
      const ledHex = !this.playing ? 0xca9c19
        : arm.phase === "approach" ? 0x4c90f0
          : arm.phase === "grip" || arm.phase === "transit" ? 0x33d6a6 : 0x2a78d6;
      led.color.setHex(ledHex);
      led.emissive.setHex(ledHex);

      // Das gegriffene Teil sinkt während „Ablegen" in den Korb.
      if (arm.phase === "place" && arm.carried && arm.dropFrom) {
        const bin = binTarget(this.layout, arm.station.index, arm.targetBin);
        const p = clamp(arm.elapsed / phase.dur, 0, 1);
        const e = ease(p);
        arm.carried.position.set(
          lerp(arm.dropFrom.x, bin.x, e),
          lerp(arm.dropFrom.y, BIN_TOP - 0.02, e),
          lerp(arm.dropFrom.z, bin.z, e),
        );
      }

      if (this.playing && arm.elapsed >= phase.dur) {
        this.finishArm(arm);
        this.nextPhase(arm);
      }
    }
  }

  /* ------------------------------------------------------- Darstellung */

  private mmToPx([xMm, yMm]: Pt): [number, number] {
    const v = new THREE.Vector3(xMm / 1000, BELT.top + 0.012, yMm / 1000).project(this.ortho);
    return [((v.x + 1) / 2) * this.rectCam.w, ((1 - v.y) / 2) * this.rectCam.h];
  }

  private zonePolygon(): string {
    const corners: Pt[] = [[-1450, -360], [620, -360], [620, 360], [-1450, 360]];
    return corners.map((c) => this.mmToPx(c).map((v) => v.toFixed(1)).join(",")).join(" ");
  }

  private emitOverlay() {
    const [cx, cy] = this.mmToPx([CAM_CENTER.x * 1000, CAM_CENTER.z * 1000]);
    this.cb.onOverlay({
      rect: { ...this.rectCam },
      parts: this.overlayParts.map((p) => ({ ...p })),
      zone: this.zonePolygon(),
      crossX: cx, crossY: cy,
      w: this.rectCam.w, h: this.rectCam.h,
      stamp: this.lastStamp,
    });
  }

  private render() {
    const W = this.W, H = this.H;
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(0, 0, W, H);
    this.renderer.setScissor(0, 0, W, H);
    this.renderer.setClearColor(0x0d1218, 1);
    this.renderer.clear();
    const draw = (r: Rect, cam: THREE.Camera) => {
      if (r.w < 2 || r.h < 2) return;
      const y = H - (r.y + r.h);
      this.renderer.setViewport(r.x, y, r.w, r.h);
      this.renderer.setScissor(r.x, y, r.w, r.h);
      this.renderer.render(this.scene3d.scene, cam);
    };
    draw(this.rectThree, this.persp);
    draw(this.rectCam, this.ortho);
    this.renderer.setScissorTest(false);
  }

  private publish() {
    const focus = this.arms[this.focus] ?? this.arms[0];
    const still = this.arms.some((a) => a.phase === "approach" || a.phase === "descend" || a.phase === "grip");
    const phase = focus?.phase ?? "idle";
    const allIdle = this.arms.every((a) => a.phase === "idle");
    let phaseLabel = PHASES[PHASE_INDEX[phase]].label;
    if (allIdle) phaseLabel = this.playing ? "Band läuft" : "Angehalten";
    const total = this.counts.reduce((a, b) => a + b, 0);
    this.cb.onSnapshot({
      phase,
      phaseLabel,
      playing: this.playing,
      speed: this.speed,
      noise: this.noise,
      bigCam: this.bigCam,
      toleranceMm: this.toleranceMm,
      joints: (focus?.joints ?? []).map(deg),
      jointNames: JOINT_NAMES,
      hit: focus?.hit ?? null,
      hitFormId: focus?.hit?.form?.id ?? null,
      counts: [...this.counts],
      total,
      unsure: this.unsure,
      cycles: this.cycles,
      avgConfidence: this.confN ? this.confSum / this.confN : 0,
      queue: this.planned.slice(0, 4).map((f) => ({ label: f.label, tag: f.tag, colour: f.colour })),
      log: this.log.slice(0, 7),
      still,
      calibration: { height_mm: 1230, hfov_deg: 62, tolerance_mm: this.toleranceMm, pitch_deg: 0, roll_deg: 0 },
      arms: this.arms.map((a, i) => ({
        index: i,
        id: a.spec.id,
        name: a.spec.name,
        phase: a.phase,
        phaseLabel: PHASES[PHASE_INDEX[a.phase]].label,
        joints: a.joints.map(deg),
        stationMm: Math.round(a.station.x * 1000),
        carrying: !!a.carried,
        cycles: a.cycles,
        bins: a.station.bins.map((b) => ({ bin: b.bin, local: b.local, label: b.label })),
      })),
      focus: this.focus,
      layoutLabel: this.layout.arms === 1 ? "1 Arm · 1 Station" : `${this.layout.arms} Arme · ${this.layout.stations.length} Stationen`,
      teach: this.ghost ? { active: this.teachActive, gripper: this.teachGripper } : null,
    });
  }

  private addLog(text: string, tone: LogEntry["tone"]) {
    this.log.unshift({ at: timeStamp(), text, tone });
    this.log = this.log.slice(0, 40);
  }

  /* ------------------------------------------------------------ Steuerung */

  resize() {
    if (this.disposed) return;
    const base = this.stage.getBoundingClientRect();
    const rel = (el: HTMLElement): Rect => {
      const r = el.getBoundingClientRect();
      return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
    };
    this.W = Math.max(1, Math.round(base.width));
    this.H = Math.max(1, Math.round(base.height));
    this.rectThree = rel(this.threePane);
    this.rectCam = rel(this.camPane);
    this.renderer.setSize(this.W, this.H, false);
    const aspect = this.rectThree.w / Math.max(1, this.rectThree.h);
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    // 2,1 m Höhe im Kamerabild; die Breite folgt dem Seitenverhältnis des Paneels.
    const halfH = 1.05;
    const camAspect = this.rectCam.w / Math.max(1, this.rectCam.h);
    this.ortho.left = -halfH * camAspect;
    this.ortho.right = halfH * camAspect;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
    this.emitOverlay();
  }

  setPlaying(v: boolean) { this.playing = v; this.publish(); }
  setSpeed(v: number) { this.speed = clamp(v, 0.25, 3); this.publish(); }
  setNoise(v: number) { this.noise = clamp(v, 0, 1); this.recapture(); this.publish(); }
  setTolerance(v: number) { this.toleranceMm = clamp(v, 1, 12); this.recapture(); this.publish(); }
  setBigCam(v: boolean) { this.bigCam = v; requestAnimationFrame(() => this.resize()); this.publish(); }

  publicRecapture() { this.recapture(); }

  private recapture() {
    if (!this.belt.length) return;
    this.lastStamp = timeStamp();
    this.measureBelt();
    this.publish();
  }

  /** Ein Teil einer bestimmten Klasse vorziehen (für die Vorführung). */
  spawn(formId?: string) {
    const form = formId ? (formById(formId) ?? FORMS[0]) : this.pullForm();
    this.spawnAt(form, this.layout.spawnMm);
    this.belt.sort((a, b) => b.xMm - a.xMm);
    this.measureBelt();
    this.publish();
  }

  reset() {
    for (const part of this.belt) {
      this.removeBelt(part);
      this.disposeMesh(part.mesh);
    }
    this.belt = [];
    for (let i = 0; i < this.arms.length; i++) this.arms[i].rig.root.visible = i === this.focus;
    if (this.ghost) this.ghost.root.visible = false;
    this.teachActive = false;
    this.teachJoints = null;
    for (const arm of this.arms) {
      if (arm.carried) {
        this.scene3d.scene.remove(arm.carried);
        this.disposeMesh(arm.carried);
        arm.carried = null;
        arm.carriedForm = null;
        arm.dropFrom = null;
      }
      arm.hit = null;
      arm.cycles = 0;
      arm.phase = "idle";
      arm.elapsed = 0;
      arm.joints = this.poseFor(arm, "idle");
      arm.rig.setPose(arm.joints);
      arm.poseFrom = [...arm.joints];
      arm.poseTo = [...arm.joints];
    }
    this.scene3d.clearBins();
    this.counts = new Array<number>(BIN_COUNT).fill(0);
    this.unsure = 0;
    this.cycles = 0;
    this.confSum = 0;
    this.confN = 0;
    this.log = [];
    this.overlayParts = [];
    this.rand = seeded(0x51a7c3);
    this.planned = [];
    for (let i = 0; i < 8; i++) this.planned.push(this.drawForm());
    this.seedBelt();
    this.measureBelt();
    this.addLog("Zelle zurückgesetzt", "info");
    this.publish();
  }

  /* --------------------------------------------------- Handführung */

  /** Welcher Arm die Zelle gerade zeigt (und der Geist nachfährt). */
  setFocus(index: number) {
    const next = clamp(index, 0, Math.max(0, this.arms.length - 1));
    if (next === this.focus) return;
    this.focus = next;
    for (let i = 0; i < this.arms.length; i++) this.arms[i].rig.root.visible = i === this.focus;
    const station = this.layout.stations[next];
    if (this.ghost && station) {
      this.ghost.root.position.set(station.base.x, station.base.y, station.base.z);
      this.ghost.root.updateMatrixWorld(true);
    }
    this.publish();
  }

  focusBase(): { x: number; y: number; z: number } {
    const station = this.layout.stations[this.focus] ?? this.layout.stations[0];
    return station ? { ...station.base } : { x: 0, y: 0.55, z: 0.58 };
  }

  /** Winkel für ein Handziel, im Koordinatensystem des gezeigten Arms. */
  solveForFocus(target: { x: number; y: number; z: number }, yaw: number, redundant = 0.12): number[] | null {
    const arm = this.arms[this.focus];
    if (!arm) return null;
    return arm.rig.solve(new THREE.Vector3(target.x, target.y, target.z), yaw, redundant);
  }

  /** Geist zeigen und auf eine Pose stellen (null = ausblenden). */
  setTeach(joints: number[] | null, gripper = 0, hand: Landmark[] | null = null) {
    if (!this.ghost) return;
    this.teachGripper = clamp(gripper, 0, 1);
    const focusArm = this.arms[this.focus];
    if (!joints) {
      this.teachActive = false;
      this.teachJoints = null;
      this.ghost.root.visible = false;
      if (focusArm) focusArm.rig.root.visible = true;
      this.hand?.update(null, 0);
      this.publish();
      return;
    }
    this.teachActive = true;
    this.teachJoints = [...joints];
    this.ghost.root.visible = true;
    if (focusArm) focusArm.rig.root.visible = false;
    this.ghost.setPose(joints);
    this.hand?.update(hand, this.teachGripper);
    this.publish();
  }

  /** Die zuletzt gezeigte Pose in Grad (für die Aufzeichnung). */
  teachPose(): { joints: number[]; gripper: number } | null {
    if (!this.teachActive || !this.teachJoints) return null;
    return { joints: this.teachJoints.map(deg), gripper: this.teachGripper };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.scene3d.clearBins();
    this.hand?.dispose();
    this.scene3d.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const x of mats) x.dispose();
      }
    });
    this.scene3d.beltTexture.dispose();
    this.renderer.dispose();
  }
}
