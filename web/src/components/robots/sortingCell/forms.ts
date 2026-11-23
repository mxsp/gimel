/* Die Formen der Sortierzelle — Dichtungen und Formteile.

   Ein „Teil" ist hier ein Satz Ringe in Millimetern um den Mittelpunkt: Ring 0
   ist die Außenkontur, alle weiteren sind Löcher (Gerade-Ungerade-Regel, genau
   wie in gimel/core/vision.py). Aus denselben Ringen entstehen das 3D-Teil
   (ExtrudeGeometry), die kleine Formvorschau (SVG) und die Template-Kontur für
   die Teileerkennung. Es gibt nur eine Quelle für die Geometrie. */

export type Pt = [number, number];

export interface Outline { path: string; w: number; h: number }

export interface FormTemplate {
  id: string;
  label: string;
  tag: string;
  colour: number;
  /** Zielkorb 0…n-1; -1 = kein Sortierziel (Nachprüfung). */
  bin: number;
  rings: Pt[][];
  outline: Outline;
  note: string;
}

const circle = (r: number, n = 72, cx = 0, cy = 0): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });

const ellipse = (a: number, b: number, n = 72): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [a * Math.cos(t), b * Math.sin(t)] as Pt;
  });

/** Abgerundetes Rechteck, gegen den Uhrzeigersinn, mit Eckenradien. */
function roundedRect(w: number, h: number, r: number, steps = 6): Pt[] {
  const pts: Pt[] = [];
  const corners = [
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, 90],
    [-w / 2 + r, -h / 2 + r, 180],
    [w / 2 - r, -h / 2 + r, 270],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = ((a0 + (i / steps) * 90) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

/** D-Ring: links gerade Kante, rechts ein Halbkreis. */
function dShape(w: number, h: number, steps = 28): Pt[] {
  const pts: Pt[] = [];
  const cx = w / 2 - h / 2;
  pts.push([-w / 2, -h / 2], [-w / 2, h / 2], [cx, h / 2]);
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI / 2 - (i / steps) * Math.PI;
    pts.push([cx + (h / 2) * Math.cos(a), (h / 2) * Math.sin(a)]);
  }
  pts.push([cx, -h / 2]);
  return pts;
}

/** Kreuz-Formteil mit runden Löchern an den Armen. */
function cross(span: number, arm: number): Pt[] {
  const s = span / 2, a = arm / 2;
  return [
    [a, s], [a, a], [s, a], [s, -a], [a, -a], [a, -s],
    [-a, -s], [-a, -a], [-s, -a], [-s, a], [-a, a], [-a, s],
  ];
}

/** SVG-Pfad für die Formvorschau: Koordinaten 0…w / 0…h, fillRule evenodd. */
function svgOutline(rings: Pt[][]): Outline {
  let mx = 0, my = 0;
  for (const ring of rings) for (const [x, y] of ring) {
    mx = Math.max(mx, Math.abs(x));
    my = Math.max(my, Math.abs(y));
  }
  const w = Math.ceil(mx * 2 + 4);
  const h = Math.ceil(my * 2 + 4);
  const ox = w / 2, oy = h / 2;
  const path = rings.map((ring) =>
    "M" + ring.map(([x, y]) => `${(x + ox).toFixed(1)} ${(y + oy).toFixed(1)}`).join("L") + "Z",
  ).join("");
  return { path, w, h };
}

function form(f: Omit<FormTemplate, "outline">): FormTemplate {
  return { ...f, outline: svgOutline(f.rings) };
}

/** Die fünf Sortierklassen. Reihenfolge = Korbnummer. */
export const FORMS: FormTemplate[] = [
  form({
    id: "rund", label: "Runddichtung", tag: "RD-124", colour: 0x3b7fc4, bin: 0,
    rings: [circle(62), circle(42)],
    note: "Flachdichtung, ein Loch — die einfachste Kontur.",
  }),
  form({
    id: "oval", label: "Ovaldichtung", tag: "OV-176", colour: 0xc08a33, bin: 1,
    rings: [ellipse(88, 48), ellipse(62, 28)],
    note: "Elliptisch, längs liegend.",
  }),
  form({
    id: "rahmen", label: "Rahmendichtung", tag: "RH-140", colour: 0x4a9e78, bin: 2,
    rings: [roundedRect(140, 96, 14), roundedRect(96, 56, 8)],
    note: "Rechteckrahmen mit gerundeten Ecken.",
  }),
  form({
    id: "flansch", label: "Flanschdichtung", tag: "FL-140", colour: 0x8b6bc7, bin: 3,
    rings: [
      circle(70), circle(30),
      ...[45, 135, 225, 315].map((d) => circle(9, 20, 50 * Math.cos((d * Math.PI) / 180), 50 * Math.sin((d * Math.PI) / 180))),
    ],
    note: "Rund mit vier Schraublöchern — die Kontur allein reicht nicht, die Löcher entscheiden.",
  }),
  form({
    id: "formteil", label: "Formteil Kreuz", tag: "FT-130", colour: 0xc05a5a, bin: 4,
    rings: [cross(130, 44), circle(18)],
    note: "Gestanztes Sonderformteil, kein Katalog-Ring.",
  }),
];

/** Ein Teil, das in keinem offenen Innenauftrag steht: muss „unbekannt" werden. */
export const ODD_FORM: FormTemplate = form({
  id: "sonder", label: "Sonderform (fremd)", tag: "—", colour: 0x6b7482, bin: -1,
  rings: [dShape(150, 100), circle(20, 32, -18, 0)],
  note: "Fremdteil ohne Template und mit fremdem Außenmaß — geht in die Nachprüfung.",
});

/** Korb für unsichere oder unbekannte Erkennungen. */
export const REJECT_BIN = FORMS.length;
export const BIN_COUNT = FORMS.length + 1;

export const BIN_LABELS: string[] = [
  ...FORMS.map((f) => f.label),
  "Nachprüfung",
];

export const formById = (id: string): FormTemplate | undefined =>
  [...FORMS, ODD_FORM].find((f) => f.id === id);

/** Ringe in Tisch-Millimetern liegen: Drehung um die Hochachse, Verschiebung. */
export function placeRings(rings: Pt[][], xMm: number, yMm: number, angleDeg: number): Pt[][] {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return rings.map((ring) => ring.map(([x, y]) => [xMm + x * c - y * s, yMm + x * s + y * c] as Pt));
}
