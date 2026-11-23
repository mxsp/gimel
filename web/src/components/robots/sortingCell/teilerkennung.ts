/* Teileerkennung der Sortierzelle — dieselbe Rechnung wie auf dem Server.

   Eine treue, reine Übersetzung von gimel/core/vision.py::match:
     1. kleinstes umschreibendes Rechteck (rotating calipers über die Hülle),
     2. Vorfilter über Länge, Breite, Fläche und Füllgrad,
     3. Konturvergleich als IoU eines Rasters über viele Lagen,
        Löcher nach Gerade-Ungerade-Regel,
     4. confidence = 1 − bester Abstand, ambiguous = fast gleich gute Formen.

   Der Server prüft acht Lagen (spiegeln × 90°-Schritte), weil er die Kontur
   vorher über die Längsachse ausrichtet. Bei runden Teilen mit asymmetrischen
   Löchern ist diese Achse willkürlich — ein Flansch würde bei beliebiger
   Teilelage falsch erkannt. Die Zelle dreht ihre Teile beliebig, daher richtet
   sie nur den Schwerpunkt aus und prüft stattdessen 36 Drehlagen × 2
   Spiegelungen. Es bleibt dieselbe IoU-Rechnung, nur ohne die willkürliche
   Achse. Die Raster werden je Maßstab einmal gerechnet und wiederverwendet.

   Der Unterschied zum Portal: nicht /api/vision/identify liefert die Kontur,
   sondern die simulierte Kamera oben (``measureFromFrame``). Das Ergebnis hat
   dieselben Felder wie ein Hit aus PartVision.tsx, damit die Anzeige beider
   Seiten dieselbe Sprache spricht. Wie jede Belebung im Zwilling gilt auch
   diese Erkennung als dargestellt, nicht gemessen. */

import { FORMS, type FormTemplate, type Pt } from "./forms";

/** Ab hier gilt ein Teil ohne Rückfrage als sicher (wie PartVision.SURE). */
export const SURE = 0.9;
const MAX_NEAR = 8;
const MAX_DISTANCE = 0.14;
const GRID = 48;
const ROTATION_STEPS = 36; // 10°-Schritte über den Vollkreis

export interface Box {
  length_mm: number;
  width_mm: number;
  x_mm: number;
  y_mm: number;
  angle_deg: number;
  corners: Pt[];
}

export interface Alternative {
  form: FormTemplate;
  confidence: number;
  /** Dasselbe Teil in einem anderen Innenauftrag ist keine Verwechslung. */
  sameShape: boolean;
  work_order: string;
}

export interface Classification {
  form: FormTemplate | null;
  confidence: number;
  distance: number;
  ambiguous: number;
  alternatives: Alternative[];
  box: Box;
  sure: boolean;
}

/* ------------------------------------------------------------------ Geometrie */

function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** Kleinstes umschreibendes Rechteck; Winkel der langen Achse in Grad. */
export function orientedBox(points: Pt[]): Box {
  const hull = convexHull(points);
  let best = { area: Infinity, u: [1, 0] as Pt, v: [0, 1] as Pt, minU: 0, maxU: 0, minV: 0, maxV: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const u: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const v: Pt = [-u[1], u[0]];
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const q of hull) {
      const du = q[0] * u[0] + q[1] * u[1];
      const dv = q[0] * v[0] + q[1] * v[1];
      minU = Math.min(minU, du); maxU = Math.max(maxU, du);
      minV = Math.min(minV, dv); maxV = Math.max(maxV, dv);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) best = { area, u, v, minU, maxU, minV, maxV };
  }
  let { u, v, minU, maxU, minV, maxV } = best;
  let length = maxU - minU, width = maxV - minV;
  if (width > length) {
    [u, v] = [v, u];
    [minU, maxU, minV, maxV] = [minV, maxV, minU, maxU];
    [length, width] = [width, length];
  }
  const angle = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  const at = (du: number, dv: number): Pt => [du * u[0] + dv * v[0], du * u[1] + dv * v[1]];
  const corners: Pt[] = [
    at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV),
  ];
  return {
    length_mm: length, width_mm: width,
    x_mm: cu * u[0] + cv * v[0], y_mm: cu * u[1] + cv * v[1],
    angle_deg: angle, corners,
  };
}

function ringArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function radiusOf(rings: Pt[][]): number {
  let r = 0;
  for (const ring of rings) for (const [x, y] of ring) r = Math.max(r, Math.hypot(x, y));
  return r;
}

/** Mitte auf den Schwerpunkt. Die Drehlage bleibt, damit die Lagen unten sie
    prüfen können — bei einem Kreis wäre jede „Längsachse" willkürlich. */
function normalize(rings: Pt[][]): Pt[][] {
  const outer = rings[0];
  let cx = 0, cy = 0;
  for (const [x, y] of outer) { cx += x; cy += y; }
  cx /= outer.length; cy /= outer.length;
  return rings.map((ring) => ring.map(([x, y]) => [x - cx, y - cy] as Pt));
}

/* ------------------------------------------------- Raster und acht Lagen */

function poseAt(rings: Pt[][], flip: number, angle: number): Pt[][] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return rings.map((ring) => ring.map(([x0, y0]) => {
    const x = x0 * flip, y = y0;
    return [x * c - y * s, x * s + y * c] as Pt;
  }));
}

/** Scanline-Füllung nach Gerade-Ungerade-Regel über alle Ringe (auch Löcher). */
function rasterize(rings: Pt[][], px: number, size = GRID): Uint8Array {
  const out = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    const y = (j + 0.5 - size / 2) * px;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length];
        if ((a[1] > y) !== (b[1] > y)) {
          xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] / px + size / 2 - 0.5));
      const i1 = Math.min(size - 1, Math.floor(xs[k + 1] / px + size / 2 - 0.5));
      for (let i = i0; i <= i1; i++) out[j * size + i] = 1;
    }
  }
  return out;
}

function overlap(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) union++;
  }
  return union ? inter / union : 0;
}

interface Candidate {
  form: FormTemplate;
  rings: Pt[][];
  length_mm: number;
  width_mm: number;
  area: number;
  fill: number;
  /** Je Rastermaßstab einmal gerechnet — wie Candidate._masks im Server. */
  masks: Map<number, Uint8Array[]>;
}

function masksAt(c: Candidate, px: number): Uint8Array[] {
  const key = Math.round(px * 1e6) / 1e6;
  const cached = c.masks.get(key);
  if (cached) return cached;
  const out: Uint8Array[] = [];
  for (const flip of [1, -1]) {
    for (let k = 0; k < ROTATION_STEPS; k++) {
      out.push(rasterize(poseAt(c.rings, flip, (k * Math.PI * 2) / ROTATION_STEPS), px));
    }
  }
  if (c.masks.size >= 8) c.masks.delete(c.masks.keys().next().value as number);
  c.masks.set(key, out);
  return out;
}

function buildCandidates(): Candidate[] {
  return FORMS.map((form) => {
    const box = orientedBox(form.rings[0]);
    const area = ringArea(form.rings[0]);
    return {
      form, rings: normalize(form.rings),
      length_mm: box.length_mm, width_mm: box.width_mm,
      area, fill: area / Math.max(box.length_mm * box.width_mm, 1e-9),
      masks: new Map<number, Uint8Array[]>(),
    };
  });
}

const CANDIDATES = buildCandidates();

/* --------------------------------------------------------------- Messbild */

/** Was die Kamera oben „misst": die wahre Kontur plus Rauschen, Eckverlust und
    eine leichte Scherung. level 0 = sauber, 1 = streifendes Licht / Bewegung. */
export function measureFromFrame(ringsMm: Pt[][], level: number, rand: () => number): Pt[][] {
  const l = Math.max(0, Math.min(1, level));
  const jitter = 0.2 + l * 4.0;
  const sx = 1 + (rand() * 2 - 1) * l * 0.02;
  const sy = 1 + (rand() * 2 - 1) * l * 0.02;
  const shear = (rand() * 2 - 1) * l * 0.03;
  const drop = l > 0.55 ? 2 : 1;
  return ringsMm.map((ring) => {
    const out: Pt[] = [];
    for (let i = 0; i < ring.length; i += drop) {
      const [x, y] = ring[i];
      const px = (x * sx + y * shear) + (rand() * 2 - 1) * jitter;
      const py = (y * sy) + (rand() * 2 - 1) * jitter;
      out.push([px, py]);
    }
    return out.length >= 3 ? out : ring;
  });
}

/* --------------------------------------------------------------- Erkennung */

export interface MatchOptions {
  tolerance_mm?: number;
  /** Für die Anzeige: Kennung des simulierten Innenauftrags. */
  work_order?: string;
}

/** Das beste offene Teil zu einer gemessenen Kontur — oder form = null. */
export function classify(ringsMm: Pt[][], opts: MatchOptions = {}): Classification {
  const tolerance = opts.tolerance_mm ?? 3;
  const outer = ringsMm[0];
  const box = orientedBox(outer);
  const area = ringArea(outer);
  const fill = area / Math.max(box.length_mm * box.width_mm, 1e-9);
  const slack = Math.max(tolerance, 0.04 * Math.min(box.length_mm, box.width_mm));

  const unknown = (confidence = 0, distance = 1, ambiguous = 0): Classification => ({
    form: null, confidence, distance, ambiguous, alternatives: [], box, sure: false,
  });

  const near = CANDIDATES.filter((c) => {
    if (Math.abs(c.length_mm - box.length_mm) > slack) return false;
    if (Math.abs(c.width_mm - box.width_mm) > slack) return false;
    if (c.area > 0 && (area / c.area < 0.62 || area / c.area > 1.55)) return false;
    if (Math.abs(fill - c.fill) > 0.3) return false;
    return true;
  });
  if (!near.length) return unknown();

  const rank = (c: Candidate) =>
    (Math.abs(c.length_mm - box.length_mm) + Math.abs(c.width_mm - box.width_mm)) / slack
    + 2 * Math.abs(Math.log(Math.max(area, 1e-9) / Math.max(c.area, 1e-9)));
  near.sort((a, b) => rank(a) - rank(b));
  const shortlist = near.slice(0, MAX_NEAR);

  const seen = normalize(ringsMm);
  const extent = Math.max(radiusOf(seen), ...shortlist.map((c) => radiusOf(c.rings))) * 1.06;
  const px = Math.max(0.35, extent / (GRID / 2 - 3));
  const ma = rasterize(seen, px);

  const scored = shortlist.map((c, i) => {
    let best = 0;
    for (const mb of masksAt(c, px)) best = Math.max(best, overlap(ma, mb));
    return { distance: 1 - best, i };
  }).sort((a, b) => a.distance - b.distance);

  const { distance: d, i } = scored[0];
  if (d > MAX_DISTANCE) return unknown(Math.max(0, 1 - d), d);

  const confidence = Math.round((1 - d) * 1000) / 1000;
  const ambiguous = scored.slice(1).filter((s) => s.distance - d < 0.02).length;
  const alternatives: Alternative[] = scored.slice(1, 6).map((s) => ({
    form: shortlist[s.i].form,
    confidence: Math.round((1 - s.distance) * 1000) / 1000,
    sameShape: false,
    work_order: `IA-${2400 + s.i}`,
  }));
  // Dieselbe Form steht oft in mehreren Innenaufträgen — das ist keine
  // Verwechslung (siehe CLAUDE.md „Teileerkennung am Tisch").
  alternatives.push({
    form: shortlist[i].form,
    confidence: Math.max(0, confidence - 0.01),
    sameShape: true,
    work_order: opts.work_order ?? "IA-2401",
  });

  return {
    form: shortlist[i].form, confidence, distance: d, ambiguous, alternatives, box,
    sure: confidence >= SURE && ambiguous === 0,
  };
}

/** Formale Übereinstimmung in Prozent, wie die Anzeige im Portal. */
export const pct = (v: number) => `${Math.round(v * 100)} %`;
