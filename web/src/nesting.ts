/* Schachtel-Editor: die Rechnung ohne Oberfläche, damit sie sich prüfen lässt.

   Die Prüfung hier ist die schnelle beim Ziehen: Polygone gegen Polygone, mit
   Umrisskasten vorweg. Gültig ist eine Lage erst, wenn der Server sie mit exakter
   Geometrie durchlässt; hier geht es darum, den Fehler zu sehen, bevor man speichert. */

export type Pt = [number, number];
export interface LayoutPart {
  tag: string; label: string; order_no: string; od: number; di: number;
  cx: number; cy: number; rot: number; rings: Pt[][];
}
export interface LayoutPlate { fmt: [number, number]; turned: boolean; placements: LayoutPart[] }
export interface Layout {
  no: string; mat: string; mat_name: string; thk: number; status: string; version: string; blocked: string;
  gap: number; margin: number; trim_w: number; trim_h: number;
  formats: [number, number][]; rotations: number[];
  has_auto: boolean; edited_at: string | null; edited_by: string;
  /** Eckschranke in mm; null oder 0 heißt: keine bekannt. */
  corner_max: number | null;
  /** Wann die Schnittdateien ausgegeben wurden; null heißt: noch nicht. */
  files_issued_at: string | null;
  plates: LayoutPlate[];
}
export interface Box { minx: number; miny: number; maxx: number; maxy: number }
export interface Fault { tag: string; other?: string; text: string }
export type Rules = Pick<Layout, "gap" | "margin" | "trim_w" | "trim_h"> & { corner_max?: number | null };

/* Toleranz wie core/plate_check.py: gekrümmte Kanten sind Sehnenzüge. */
const CHORD = 0.2;
/* Wie EPS in core/nesting.py: die Schranke wird quadriert verglichen. */
const EPS = 1e-7;

/** Zahl im deutschen Format, für Maße in mm: höchstens eine Nachkommastelle. */
export const num = (v: number, digits = 0) =>
  v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 1) });

export function placed(p: Pick<LayoutPart, "cx" | "cy" | "rot">, ring: Pt[]): Pt[] {
  const a = (p.rot * Math.PI) / 180;
  const c = Math.round(Math.cos(a) * 1e9) / 1e9, s = Math.round(Math.sin(a) * 1e9) / 1e9;
  return ring.map(([x, y]) => [p.cx + x * c - y * s, p.cy + x * s + y * c]);
}

export function boxOf(pts: Pt[]): Box {
  const box = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  for (const [x, y] of pts) {
    if (x < box.minx) box.minx = x;
    if (x > box.maxx) box.maxx = x;
    if (y < box.miny) box.miny = y;
    if (y > box.maxy) box.maxy = y;
  }
  return box;
}

export function inRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointSeg2(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len)) : 0;
  const ex = px - a[0] - t * dx, ey = py - a[1] - t * dy;
  return ex * ex + ey * ey;
}

function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Kleinster Abstand zweier Ringe; 0, wenn sie sich schneiden. */
export function ringGap(a: Pt[], b: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j], b2 = b[(j + 1) % b.length];
      if (crosses(a1, a2, b1, b2)) return 0;
      best = Math.min(best, pointSeg2(a1[0], a1[1], b1, b2), pointSeg2(b1[0], b1[1], a1, a2));
    }
  }
  return Math.sqrt(best);
}

interface Solid { part: LayoutPart; outer: Pt[]; holes: Pt[][]; box: Box }
const solid = (part: LayoutPart): Solid => {
  const outer = placed(part, part.rings[0]);
  return { part, outer, holes: part.rings.slice(1).map((r) => placed(part, r)), box: boxOf(outer) };
};
const hit = (s: Solid, x: number, y: number) => inRing(x, y, s.outer) && !s.holes.some((h) => inRing(x, y, h));

/** Die Nutzfläche einer Platte: Beschnitt mittig, Rand rundum. */
export function usable(l: Pick<Layout, "margin" | "trim_w" | "trim_h">, fmt: [number, number]): Box {
  const m = Math.max(0, l.margin - CHORD);
  return { minx: l.trim_w / 2 + m, miny: l.trim_h / 2 + m, maxx: fmt[0] - l.trim_w / 2 - m, maxy: fmt[1] - l.trim_h / 2 - m };
}

/** Quadrierter Abstand der äußeren Teilecke von der Nullecke, wie corner_sq in
    core/nesting.py. Der Rechenkern zählt ab dem Beschnitt, die Lage hier ab der
    Plattenkante; deshalb geht der halbe Beschnitt ab. */
export function cornerSq(l: Pick<Layout, "trim_w" | "trim_h">, box: Box): number {
  const x = box.maxx - l.trim_w / 2, y = box.maxy - l.trim_h / 2;
  return x * x + y * y;
}

/** Null in einem Maschinenwert heißt unbekannt, also keine Schranke. */
const cornerOver = (l: Rules, box: Box) => !!l.corner_max && l.corner_max > 0 && cornerSq(l, box) > l.corner_max * l.corner_max + EPS;

function pairFault(l: Rules, a: Solid, b: Solid): Fault | null {
  const need = Math.max(0, l.gap - CHORD);
  if (a.box.minx > b.box.maxx + need || b.box.minx > a.box.maxx + need
      || a.box.miny > b.box.maxy + need || b.box.miny > a.box.maxy + need) return null;
  let gap = ringGap(a.outer, b.outer);
  // Ein Teil im Loch des anderen: dort zählt der Abstand zur Lochkante.
  const home = (x: Solid, y: Solid) => x.holes.find((h) => y.outer.every(([px, py]) => inRing(px, py, h)));
  const hole = home(a, b) ?? home(b, a);
  if (hole) {
    gap = ringGap(hole, (home(a, b) ? b : a).outer);
  } else if (hit(a, b.outer[0][0], b.outer[0][1]) || hit(b, a.outer[0][0], a.outer[0][1])) {
    gap = 0;
  }
  if (gap <= 0) return { tag: a.part.tag, other: b.part.tag, text: `${a.part.tag} überlappt ${b.part.tag}` };
  if (gap < need) return { tag: a.part.tag, other: b.part.tag, text: `${a.part.tag} und ${b.part.tag}: nur ${num(gap, 1)} mm Abstand, nötig ${num(l.gap)} mm` };
  return null;
}

export function faults(l: Rules, plate: LayoutPlate): Fault[] {
  const out: Fault[] = [];
  const area = usable(l, plate.fmt);
  const all = plate.placements.map(solid);
  for (const s of all) {
    const b = s.box;
    if (b.minx < area.minx || b.miny < area.miny || b.maxx > area.maxx || b.maxy > area.maxy) {
      out.push({ tag: s.part.tag, text: `${s.part.tag} liegt außerhalb der Nutzfläche` });
    }
    if (cornerOver(l, b)) {
      out.push({ tag: s.part.tag, text: `${s.part.tag} liegt ${num(Math.sqrt(cornerSq(l, b)), 1)} mm von der Nullecke, erlaubt ${num(l.corner_max as number)} mm` });
    }
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const f = pairFault(l, all[i], all[j]);
      if (f) out.push(f);
    }
  }
  return out;
}

/** Erster fehlerfreier Platz für ein Teil, von der Nullecke aus zeilenweise; gibt
    es keinen, die Mitte der Nutzfläche, und die Prüfung zeigt den Fehler. */
export function firstFree(l: Rules, plate: LayoutPlate, part: LayoutPart, step = 10): Pt {
  const area = usable(l, plate.fmt);
  const others = plate.placements.filter((p) => p.tag !== part.tag).map(solid);
  const home = boxOf(placed({ ...part, cx: 0, cy: 0 }, part.rings[0]));
  const from = (edge: number, low: number) => Math.ceil((edge - low) / step) * step;
  for (let y = from(area.miny, home.miny); y + home.maxy <= area.maxy; y += step) {
    for (let x = from(area.minx, home.minx); x + home.maxx <= area.maxx; x += step) {
      const me = solid({ ...part, cx: x, cy: y });
      if (cornerOver(l, me.box)) break; // Weiter rechts wird es nur schlimmer.
      if (!others.some((o) => pairFault(l, me, o))) return [x, y];
    }
  }
  return [Math.round((area.minx + area.maxx) / 10) * 5, Math.round((area.miny + area.maxy) / 10) * 5];
}

export const faultTags = (list: Fault[]) => new Set(list.flatMap((f) => (f.other ? [f.tag, f.other] : [f.tag])));

/** Angeschnittener Anteil der Platte, wie im Sammellauf bis zum letzten Teil plus Rand. */
export function fillOf(l: Pick<Layout, "margin">, plate: LayoutPlate): number {
  const axis = plate.turned ? 0 : 1;
  const len = plate.fmt[axis];
  let reach = 0;
  for (const p of plate.placements) for (const pt of placed(p, p.rings[0])) reach = Math.max(reach, pt[axis]);
  return plate.placements.length && len ? Math.min(1, (reach + l.margin) / len) : 0;
}

/** Fläche als SVG-Pfad; Löcher schneidet fill-rule evenodd aus. */
export function pathOf(part: LayoutPart): string {
  return part.rings.map((ring) => `M${ring.map(([x, y]) => `${x} ${y}`).join("L")}Z`).join("");
}

export function layoutBody(plates: LayoutPlate[]) {
  return plates.map((p) => ({
    fmt: p.fmt, turned: p.turned,
    placements: p.placements.map(({ tag, cx, cy, rot }) => ({ tag, cx, cy, rot })),
  }));
}

/* Der Zustand des Editors. Rein, damit StrictMode ihn zweimal rechnen darf: kein
   setState in einem Updater, und jede Änderung läuft auf einer eigenen Kopie. */
export interface Edit { plates: LayoutPlate[]; tray: LayoutPart[] }
export interface EditorState { edit: Edit | null; past: Edit[]; future: Edit[]; dirty: boolean }
export type EditorAction =
  | { type: "adopt"; plates: LayoutPlate[] }
  | { type: "change"; fn: (e: Edit) => void }
  | { type: "undo" }
  | { type: "redo" };

export const EDITOR_START: EditorState = { edit: null, past: [], future: [], dirty: false };

export const cloneEdit = (e: Edit): Edit => ({
  plates: e.plates.map((p) => ({ ...p, placements: p.placements.map((i) => ({ ...i })) })),
  tray: e.tray.map((i) => ({ ...i })),
});

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  if (a.type === "adopt") return { edit: { plates: a.plates, tray: [] }, past: [], future: [], dirty: false };
  if (!s.edit) return s;
  if (a.type === "change") {
    const next = cloneEdit(s.edit);
    a.fn(next);
    return { edit: next, past: [...s.past.slice(-99), s.edit], future: [], dirty: true };
  }
  if (a.type === "undo") {
    if (!s.past.length) return s;
    return { edit: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [s.edit, ...s.future], dirty: true };
  }
  if (!s.future.length) return s;
  return { edit: s.future[0], past: [...s.past, s.edit], future: s.future.slice(1), dirty: true };
}

/** Rückgängig und Vorschlag können die gezeigte Platte wegnehmen. */
export const clampIndex = (i: number, n: number) => (n > 0 ? Math.min(Math.max(0, i), n - 1) : 0);
