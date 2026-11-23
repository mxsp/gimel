/* Freies Schachteln: Einstellungen, Anfrage und Geometrie, ohne Oberfläche.

   Der Browser schickt nur Zeichnungsnummern und Zahlen; der Server holt die Konturen
   selbst. Was hier rechnet, ist Darstellung (Drehen, Verschieben, Pfade) und der
   Vergleich „gehört das Ergebnis noch zu diesen Einstellungen?". Gerechnet wird auf
   dem Server, geprüft mit kerf.verify. */

export type Pt = [number, number];

export interface DrawingItem {
  id: number; name: string; note: string; source: "dxf" | "svg" | "points";
  width: number; height: number; area: number; cut_len: number; n_holes: number;
  created_at: string | null; created_by: string;
  preview?: { outer: Pt[]; holes: Pt[][] };
}

export interface PartRow { id: number; qty: number; gap: number | null }

export interface Settings {
  preset: "2000x1000" | "2500x1250" | "3000x1500" | "custom";
  sheetW: number; sheetH: number; spacing: number; margin: number; stock: number;
  rotations: "0" | "180" | "90" | "45" | "15";
  gravity: "left" | "top";
  quality: "draft" | "standard" | "fine" | "mm1" | "manual";
  cell: number; maxSteps: number; stall: number; seed: number; refine: boolean;
  parts: PartRow[];
}

export const PRESETS: { key: Settings["preset"]; label: string; w: number; h: number }[] = [
  { key: "2000x1000", label: "Kleinformat · 2000 × 1000", w: 2000, h: 1000 },
  { key: "2500x1250", label: "Mittelformat · 2500 × 1250", w: 2500, h: 1250 },
  { key: "3000x1500", label: "Großformat · 3000 × 1500", w: 3000, h: 1500 },
  { key: "custom", label: "Eigenes Format", w: 0, h: 0 },
];

export const ROTATIONS: { key: Settings["rotations"]; label: string }[] = [
  { key: "0", label: "Nur 0° (Maserung fest)" },
  { key: "180", label: "0° / 180°" },
  { key: "90", label: "90°-Schritte" },
  { key: "45", label: "45°-Schritte" },
  { key: "15", label: "15°-Schritte" },
];

export const QUALITIES: { key: Settings["quality"]; label: string }[] = [
  { key: "draft", label: "Entwurf" },
  { key: "standard", label: "Standard" },
  { key: "fine", label: "Fein" },
  { key: "mm1", label: "1 mm" },
  { key: "manual", label: "Manuell" },
];

/** Grenzen wie auf dem Server (services/free_nesting.py); der Server prüft sie noch einmal. */
export const LIMITS = { types: 200, instances: 2000, steps: 1000, hardSeconds: 60 };

export const DEFAULT_SETTINGS: Settings = {
  preset: "3000x1500", sheetW: 3000, sheetH: 1500, spacing: 5, margin: 10, stock: 0,
  rotations: "90", gravity: "left", quality: "standard", cell: 5, maxSteps: 150, stall: 0,
  seed: 1, refine: true, parts: [],
};

export const STORAGE_KEY = "gimel-free-nesting";
export const RUN_KEY = "gimel-free-nesting-run";

const finite = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
const whole = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;

/** Ein gespeicherter Stand kann alt, halb oder fremd sein: jede Zahl wird geprüft, der Rest fällt auf den Standard. */
export function cleanSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const parts: PartRow[] = [];
  if (Array.isArray(r.parts)) {
    for (const p of r.parts.slice(0, LIMITS.types)) {
      const row = p as Record<string, unknown>;
      if (!row || !Number.isInteger(row.id) || parts.some((x) => x.id === row.id)) continue;
      parts.push({
        id: row.id as number, qty: whole(row.qty, 0, LIMITS.instances, 1),
        gap: row.gap === null || row.gap === undefined ? null : finite(row.gap, 0, 200, 0),
      });
    }
  }
  const preset = oneOf(r.preset, PRESETS.map((p) => p.key), d.preset);
  const named = PRESETS.find((p) => p.key === preset && p.w > 0);
  return {
    preset,
    sheetW: named ? named.w : finite(r.sheetW, 50, 10000, d.sheetW),
    sheetH: named ? named.h : finite(r.sheetH, 50, 10000, d.sheetH),
    spacing: finite(r.spacing, 0, 200, d.spacing), margin: finite(r.margin, 0, 500, d.margin),
    stock: whole(r.stock, 0, 1000, d.stock),
    rotations: oneOf(r.rotations, ROTATIONS.map((x) => x.key), d.rotations),
    gravity: oneOf(r.gravity, ["left", "top"] as const, d.gravity),
    quality: oneOf(r.quality, QUALITIES.map((x) => x.key), d.quality),
    cell: finite(r.cell, 0.25, 100, d.cell), maxSteps: whole(r.maxSteps, 1, LIMITS.steps, d.maxSteps),
    stall: whole(r.stall, 0, LIMITS.steps, d.stall), seed: whole(r.seed, 1, 2 ** 32 - 1, d.seed),
    refine: typeof r.refine === "boolean" ? r.refine : d.refine, parts,
  };
}

/** Pro Browser; fehlt der Speicher oder wirft er, gelten die Standardwerte. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return cleanSettings(raw ? JSON.parse(raw) : null);
  } catch { return cleanSettings(null); }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ohne Speicher gilt der Standard */ }
}

/** Der Fingerabdruck dessen, was einen Lauf bestimmt. Gleicher Fingerabdruck, gleiches Ergebnis. */
export function settingsKey(s: Settings): string {
  const parts = s.parts.filter((p) => p.qty > 0).map((p) => [p.id, p.qty, p.gap]);
  const manual = s.quality === "manual" ? s.cell : null;
  return JSON.stringify([s.sheetW, s.sheetH, s.spacing, s.margin, s.stock, s.rotations, s.gravity, s.quality, manual,
    s.maxSteps, s.stall, s.seed, s.refine, parts]);
}

export function totals(s: Settings): { types: number; instances: number } {
  const used = s.parts.filter((p) => p.qty > 0);
  return { types: used.length, instances: used.reduce((a, p) => a + p.qty, 0) };
}

/** Was gegen einen Start spricht, in Worten; leer heißt: los. */
export function blockers(s: Settings): string[] {
  const out: string[] = [];
  const t = totals(s);
  if (t.types === 0) out.push("Es ist kein Teil mit Menge gewählt.");
  if (t.types > LIMITS.types) out.push(`Höchstens ${LIMITS.types} Teilearten.`);
  if (t.instances > LIMITS.instances) out.push(`Höchstens ${LIMITS.instances} Teile je Lauf (jetzt ${t.instances}).`);
  if (!(s.sheetW >= 50 && s.sheetH >= 50)) out.push("Die Platte ist mindestens 50 mm lang und breit.");
  if (2 * s.margin >= Math.min(s.sheetW, s.sheetH)) out.push("Der Randabstand lässt von der Platte nichts übrig.");
  return out;
}

export function requestBody(s: Settings) {
  return {
    sheet_w: s.sheetW, sheet_h: s.sheetH, spacing: s.spacing, margin: s.margin, stock: s.stock,
    rotations: s.rotations, gravity: s.gravity, quality: s.quality,
    cell: s.quality === "manual" ? s.cell : null, max_steps: s.maxSteps, stall: s.stall, seed: s.seed,
    refine: s.refine,
    parts: s.parts.filter((p) => p.qty > 0).map((p) => ({ drawing_id: p.id, qty: p.qty, gap: p.gap })),
  };
}

// ---------------------------------------------------------------- Lauf
export interface Placement {
  partId: string; partIndex: number; instance: number; sheet: number; rotation: number;
  x: number; y: number; width: number; height: number; tx: number; ty: number;
}
export interface RunPart { id: string; name: string; outer: Pt[]; holes: Pt[][]; quantity: number }
export interface Layout {
  placements: Placement[];
  sheets: { index: number; parts: number; usedLength: number; utilization: number }[];
  unplaced: { partId: string; partIndex: number; instance: number }[];
  stats: {
    sheetsUsed: number; placed: number; total: number; placedArea: number;
    utilizationSheets: number; utilizationUsed: number; remnantLength: number; iterations: number;
    maxSheets: number | null; stockLimited: boolean; maxSteps: number | null; elapsedMs: number;
    cell: number; stopReason?: string; phase?: string;
  };
}
export interface Verify { valid: boolean; issues: string[]; minGap: number | null; minSlack: number | null; pairsChecked: number }
export type RunStatus = "running" | "checking" | "done" | "stopped" | "timeout" | "failed";
export interface RunView {
  id: string; status: RunStatus; rev: number; phase: string; elapsed_ms: number; max_steps: number;
  step: number; error: string; verify: Verify | null; exportable: boolean; notice: string;
  reproducible: boolean; job: { sheet: { width: number; height: number }; margin: number; gravity: string };
  layout?: Layout; parts?: RunPart[];
}

export const isActive = (s: RunStatus | undefined): boolean => s === "running" || s === "checking";

export const STATUS_TEXT: Record<RunStatus, string> = {
  running: "Läuft", checking: "Lage wird geprüft", done: "Fertig", stopped: "Angehalten",
  timeout: "Nach 60 s beendet", failed: "Fehlgeschlagen",
};

/* Drehen wie kerf.rot_ring (Vielfache von 90 exakt), dann um (tx, ty) verschieben. */
export function trig(deg: number): [number, number] {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return [1, 0];
  if (d === 90) return [0, 1];
  if (d === 180) return [-1, 0];
  if (d === 270) return [0, -1];
  const t = (d * Math.PI) / 180;
  return [Math.cos(t), Math.sin(t)];
}

export function placedRing(ring: Pt[], pl: Pick<Placement, "rotation" | "tx" | "ty">): Pt[] {
  const [c, s] = trig(pl.rotation);
  return ring.map(([x, y]) => [x * c - y * s + pl.tx, x * s + y * c + pl.ty] as Pt);
}

const f3 = (v: number) => String(Math.round(v * 1000) / 1000);

/** Ein Pfad im SVG. Läufe rechnen wie der Bildschirm (y nach unten, Ursprung oben links), die
 *  Konturen der Bibliothek zählen wie DXF nach oben: dafür ``flip`` (die Höhe der Zeichnung). */
export function ringPath(ring: Pt[], flip?: number): string {
  return ring.map(([x, y], i) => `${i ? "L" : "M"}${f3(x)} ${f3(flip === undefined ? y : flip - y)}`).join("") + "Z";
}

export function placedPath(part: Pick<RunPart, "outer" | "holes">, pl: Placement): string {
  return [part.outer, ...part.holes].map((r) => ringPath(placedRing(r, pl))).join("");
}

/** Vorschau in der Liste (y nach oben gespeichert). */
export function thumbPath(prev: { outer: Pt[]; holes: Pt[][] }, h: number): string {
  return [prev.outer, ...prev.holes].map((r) => ringPath(r, h)).join("");
}

export const pct = (v: number): string => `${(v * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;

export const SOURCE_LABEL: Record<DrawingItem["source"], string> = { dxf: "DXF", svg: "SVG", points: "Punkte" };

/** Dateiname ohne Endung, Name für die Zeichnung. */
export const baseName = (file: string): string => file.replace(/\.[^.]*$/, "").slice(0, 120);

export function importKind(file: string): "dxf" | "svg" | null {
  const ext = /\.([^.]+)$/.exec(file.toLowerCase())?.[1];
  return ext === "dxf" ? "dxf" : ext === "svg" ? "svg" : null;
}

export function addPart(s: Settings, id: number, qty = 1): Settings {
  if (s.parts.some((p) => p.id === id)) {
    return { ...s, parts: s.parts.map((p) => (p.id === id ? { ...p, qty: p.qty + qty } : p)) };
  }
  return { ...s, parts: [...s.parts, { id, qty, gap: null }] };
}
