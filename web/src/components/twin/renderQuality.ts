import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/* Darstellungsstufe „Hoch" der 3D-Halle.

   „Schnell" ist die bisherige, flache Halle ohne Schatten. „Hoch" schaltet
   dazu: eine Sonne mit weichen Schatten, deren Schattenkamera genau die Halle
   umfasst, beleuchtete Materialien und eine Umgebungsbeleuchtung
   (RoomEnvironment) für Metall und Glas. Keine Nachbearbeitung: eine
   EffectComposer-Kette (GTAO, SMAA) verlor am 2026-11-07 alle
   durchscheinenden Schichten — Raster, Spuren, Zonen, Wärme. Gezeichnet wird
   direkt, mit der Kantenglättung des Renderers. Alles hängt an einem
   Objekt, das sich vollständig wieder abbauen lässt — der Wechsel zurück auf
   „Schnell" hinterlässt keine Lichter und keine Render-Ziele. */

export type Quality = "schnell" | "hoch";

/** Gerät einmal ansehen (task 41 D): Name der Grafik aus einem kurzlebigen
    WebGL-Kontext, dazu Speicher und Kerne. Ohne WebGL: leerer Name. */
let probed: import("./frameBudget").DeviceInfo | null = null;
export function probeDevice(): import("./frameBudget").DeviceInfo {
  if (probed) return probed;
  let renderer = "";
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || "";
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch { /* kein WebGL */ }
  const nav = navigator as Navigator & { deviceMemory?: number };
  probed = {
    renderer,
    memory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    mobile: matchMedia?.("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 900,
  };
  return probed;
}

export interface HighQuality {
  /** Schatten an alle Körper der Halle hängen (nach jedem Neuaufbau). */
  applyShadows(root: THREE.Object3D): void;
  /** Nicht mehr benutzte übersetzte Materialien freigeben. */
  prune(): void;
  /** Sonne und Schattenkamera auf die Halle einpassen. */
  fit(bounds: { x: number; y: number; w: number; h: number }, height: number): void;
  dispose(): void;
}

export function enableHighQuality(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): HighQuality {
  const prevExposure = renderer.toneMappingExposure;
  renderer.toneMappingExposure = 0.82;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.needsUpdate = true;
  // Die Sonne steht zur Halle fest: eine Kamerafahrt ändert keinen Schatten.
  // Neu gezeichnet wird er nur bei einer Szenenänderung oder Bewegung
  // (ThreeFloorPlan setzt ``needsUpdate``, task 41 D).
  renderer.shadowMap.autoUpdate = false;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  const prevEnv = scene.environment;
  scene.environment = env;
  scene.environmentIntensity = 0.55;
  // Die Nachbearbeitung zeichnet in ein eigenes Ziel; ein durchsichtiger
  // Hintergrund würde dort schwarz. Darum die Bühnenfarbe als echter Grund.

  const sun = new THREE.DirectionalLight(0xfff4e6, 1.35);
  sun.name = "hq-sun";
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  scene.add(sun.target);

  /** Die Halle ist mit unbeleuchteten Materialien gebaut (flach wie die Karte).
      Für Schatten braucht ein Körper ein beleuchtetes Material: undurchsichtige
      MeshBasicMaterials werden je Stufe einmal in MeshStandardMaterials
      übersetzt; das Original merken wir uns und setzen es beim Abbau zurück. */
  const originals = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const lit = new Map<string, THREE.MeshStandardMaterial>();
  const toLit = (m: THREE.Material): THREE.Material => {
    if (!(m instanceof THREE.MeshBasicMaterial)) return m;
    if (m.transparent && m.opacity < 0.95) return m;
    let out = lit.get(m.uuid);
    if (!out) {
      out = new THREE.MeshStandardMaterial({
        color: m.color.clone(), map: m.map, side: m.side, transparent: m.transparent,
        opacity: m.opacity, roughness: 0.78, metalness: 0.08, vertexColors: m.vertexColors,
        polygonOffset: m.polygonOffset, polygonOffsetFactor: m.polygonOffsetFactor,
        polygonOffsetUnits: m.polygonOffsetUnits, depthWrite: m.depthWrite,
      });
      out.name = `hq:${m.name}`;
      lit.set(m.uuid, out);
    }
    return out;
  };
  return {
    applyShadows(root) {
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || o.userData?.hqDone) return;
        const mat = o.material as THREE.Material | THREE.Material[];
        const first = Array.isArray(mat) ? mat[0] : mat;
        // Flache, durchscheinende Flächen (Zonen, Glas, Markierungen) werfen
        // keinen Schatten, nehmen ihn aber auf; Körper tun beides.
        const thin = o.userData?.noShadow || (first && first.transparent && first.opacity < 0.6);
        o.castShadow = !thin;
        o.receiveShadow = !o.userData?.noShadow;
        if (!o.userData?.keepBasic) {
          originals.set(o, mat);
          o.material = Array.isArray(mat) ? mat.map(toLit) : toLit(mat);
        }
        o.userData = { ...(o.userData ?? {}), hqDone: true };
      });
    },
    prune() {
      // Nach einem Neuaufbau der Halle: übersetzte Materialien, die kein Körper
      // mehr trägt, freigeben, damit der Zwischenspeicher nicht wächst.
      const used = new Set<string>();
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) used.add(m.uuid);
      });
      for (const [key, m] of lit) {
        if (!used.has(m.uuid)) { m.dispose(); lit.delete(key); }
      }
    },
    fit(b, height) {
      const cx = b.x + b.w / 2, cz = b.y + b.h / 2;
      const span = Math.max(b.w, b.h, 10);
      sun.position.set(cx + span * 0.45, Math.max(height * 3, span * 0.9), cz + span * 0.3);
      sun.target.position.set(cx, 0, cz);
      const cam = sun.shadow.camera;
      const half = span * 0.75;
      cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
      cam.near = 0.5; cam.far = span * 4 + height * 6;
      cam.updateProjectionMatrix();
      sun.shadow.needsUpdate = true;
    },
    dispose() {
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || !o.userData?.hqDone) return;
        const mat = originals.get(o);
        if (mat) o.material = mat;
        o.castShadow = false;
        o.receiveShadow = false;
        delete o.userData.hqDone;
      });
      for (const m of lit.values()) m.dispose();
      lit.clear();
      scene.remove(sun);
      scene.remove(sun.target);
      sun.dispose();
      scene.environment = prevEnv;
      env.dispose();
      pmrem.dispose();
      renderer.shadowMap.enabled = false;
      renderer.shadowMap.autoUpdate = true;
      renderer.toneMappingExposure = prevExposure;
    },
  };
}

/** Bildrate beobachten. Ruft ``onSlow`` einmal, wenn drei Fenster von je
    zwei Sekunden im Mittel langsamer als ``limitMs`` je Bild waren. */
export class FrameWatch {
  private start = 0;
  private frames = 0;
  private slow = 0;
  private fired = false;
  constructor(private readonly limitMs: number, private readonly onSlow: () => void) {}
  reset(): void { this.start = 0; this.frames = 0; this.slow = 0; this.fired = false; }
  /** Zeichnen ruht oder ist gedrosselt (task 41 A): das laufende Fenster
      verwerfen, damit eine Pause nie als langsames Bild zählt. */
  pause(): void { this.start = 0; this.frames = 0; }
  tick(now: number): void {
    if (this.fired) return;
    if (!this.start) { this.start = now; this.frames = 0; return; }
    this.frames++;
    const span = now - this.start;
    if (span < 2000) return;
    const perFrame = span / Math.max(1, this.frames);
    this.slow = perFrame > this.limitMs ? this.slow + 1 : 0;
    this.start = now; this.frames = 0;
    if (this.slow >= 3) { this.fired = true; this.onSlow(); }
  }
}
