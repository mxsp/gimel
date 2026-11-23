/* Zeichnen nur bei Bedarf (task 41 A).

   Bis 2026-11-07 zeichnete die 3D-Halle 60-mal je Sekunde, auch wenn sich
   nichts bewegte — 476 bis 731 Zeichenaufrufe je Bild, 10–15 % Hauptthread im
   Leerlauf. Jetzt entscheidet die Bildschleife je Takt, ob gezeichnet wird:

   - **aktiv** (Eingabe, gedämpfte Kamera, Kamerafahrt, Begehen, Rundgang,
     ausstehende Bilder nach einer Datenänderung): jedes Bild;
   - **nur Belebung** (laufende Geräte, fahrende Roboter, wandernde Striche,
     Simulation): gedrosselt auf ``AMBIENT_FPS``, ohne Fokus auf ``BLUR_FPS``;
   - **sonst**: gar nicht. Unsichtbare Bühne (aus dem Bild gescrollt): gar nicht.

   Rein, ohne THREE und DOM, damit `web/twin-perf.test.mjs` es in Node prüft. */

export const AMBIENT_FPS = 30;
export const BLUR_FPS = 12;
/** Bilder nach einer Änderung aus einem Effekt oder einer Eingabe. Zwei
    reichen: eins für die Szene, eins für die nachgezogenen Beschriftungen. */
export const SETTLE_FRAMES = 2;

export interface FrameInput {
  now: number;
  /** Zeitpunkt des letzten gezeichneten Bilds (ms). */
  lastRender: number;
  /** Noch ausstehende Bilder (``invalidate``). */
  pending: number;
  /** Kamera, Eingabe oder Bewegung, die jedes Bild braucht. */
  active: boolean;
  /** Nur Belebung bewegt sich. */
  ambient: boolean;
  /** Das Fenster hat den Fokus. */
  focused: boolean;
  /** Die Bühne ist im Bild. */
  visible: boolean;
}

export type FrameKind = "skip" | "active" | "ambient";

export function decideFrame(f: FrameInput): FrameKind {
  if (!f.visible) return "skip";
  if (f.active || f.pending > 0) return "active";
  if (!f.ambient) return "skip";
  const fps = f.focused ? AMBIENT_FPS : BLUR_FPS;
  // Eine halbe Millisekunde Spielraum: rAF liegt nicht genau auf dem Raster.
  return f.now - f.lastRender >= 1000 / fps - 0.5 ? "ambient" : "skip";
}

/** Kamera-Signatur für „hat sich der Blick bewegt?" (Beschriftungen entzerren). */
export function cameraKey(p: { x: number; y: number; z: number }, t: { x: number; y: number; z: number }, zoom: number): string {
  const r = (v: number) => Math.round(v * 200) / 200;
  return `${r(p.x)},${r(p.y)},${r(p.z)}|${r(t.x)},${r(t.y)},${r(t.z)}|${r(zoom)}`;
}

/* Gerätestufe (task 41 D). Bestimmt Pixeldichte und die erste Darstellungs-
   stufe, solange niemand selbst gewählt hat. Software-Rendering (SwiftShader,
   llvmpipe — VMs, Fernzugriff, Grafiktreiber fehlt) ist immer „schwach". */
export type DeviceTier = "schwach" | "mittel" | "stark";

export interface DeviceInfo {
  /** UNMASKED_RENDERER_WEBGL oder leer. */
  renderer: string;
  /** navigator.deviceMemory (GB), wenn bekannt. */
  memory?: number;
  /** navigator.hardwareConcurrency, wenn bekannt. */
  cores?: number;
  /** Touch-Gerät mit schmalem Bildschirm (Tablet/Telefon in der Halle). */
  mobile?: boolean;
}

export function classifyDevice(d: DeviceInfo): DeviceTier {
  if (/swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i.test(d.renderer)) return "schwach";
  const mem = d.memory ?? 8, cores = d.cores ?? 8;
  if (mem <= 2 || cores <= 2) return "schwach";
  if (d.mobile || mem <= 4 || cores <= 4) return "mittel";
  // Eigene Grafikkarte oder Apple-Chip: Schatten und Umgebungslicht tragen.
  if (/nvidia|geforce|quadro|rtx|radeon(?!.*vega 3)|apple m\d|apple gpu|arc\(tm\)|intel.*arc/i.test(d.renderer)) return "stark";
  return "mittel";
}

/** Höchste Pixeldichte je Stufe; die Bildschirmdichte bleibt die Obergrenze. */
export function pixelRatioFor(tier: DeviceTier, dpr: number): number {
  const cap = tier === "schwach" ? 1 : tier === "mittel" ? 1.5 : 2;
  return Math.max(0.75, Math.min(dpr || 1, cap));
}

/** Pixeldichte während einer zähen Kamerabewegung. */
export const MOVING_RATIO_FACTOR = 0.66;
/** Ab dieser Bildzeit (ms) beim Bewegen wird die Auflösung gesenkt. */
export const SLOW_FRAME_MS = 28;
/** So lange nach der letzten Bewegung kehrt die volle Auflösung zurück (ms). */
export const SETTLE_MS = 260;
