/* Beschriftungen in der 3D-Halle entzerren (task 37).

   Rein: kein DOM, kein THREE. Die Szene misst die Beschriftungen auf dem
   Bildschirm und fragt hier, welche ganz, welche nur mit Namen (ohne zweite
   Zeile) und welche gar nicht gezeigt werden. Wichtigere zuerst: ausgewählte
   Station, Kollisionen und Messungen, dann Stationen nach Dringlichkeit,
   Ebenen, Roboter, Aufträge, Flüsse, Tore und Zonen. Eine verdeckte
   Beschriftung bleibt im DOM (Fokus, Vorlesen) und kommt zurück, sobald Platz
   ist. */

export interface LabelBox {
  id: string;
  /** Mittelpunkt auf dem Bildschirm in px. */
  cx: number;
  cy: number;
  /** Natürliche Größe (ganz, mit zweiter Zeile). */
  w: number;
  h: number;
  /** Höhe der ersten Zeile allein; 0 = keine kompakte Form. */
  headH: number;
  priority: number;
  /** Ruhige Station (frei, inaktiv): in der Übersicht nur der Name (task 41 E). */
  calm?: boolean;
}

export interface LayoutOptions {
  /** Kamera weit draußen: ruhige Stationen zeigen nur ihren Namen. */
  overview?: boolean;
}

export type LabelFit = "full" | "compact" | "hidden";

/** Ab dieser Priorität wird nie ausgeblendet (Auswahl, Messung). */
export const ALWAYS_SHOW = 90;

interface Rect { x0: number; y0: number; x1: number; y1: number }

const PAD = 3;

function rect(cx: number, cy: number, w: number, h: number): Rect {
  return { x0: cx - w / 2 - PAD, y0: cy - h / 2 - PAD, x1: cx + w / 2 + PAD, y1: cy + h / 2 + PAD };
}

function hits(a: Rect, list: Rect[]): boolean {
  for (const b of list) if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0) return true;
  return false;
}

/** Gierig nach Priorität: ganz, sonst kompakt (Kopfzeile bleibt am Ort), sonst aus. */
export function layoutLabels(boxes: LabelBox[], opts: LayoutOptions = {}): Map<string, LabelFit> {
  const order = [...boxes].sort((a, b) => b.priority - a.priority || a.cy - b.cy || a.id.localeCompare(b.id));
  const placed: Rect[] = [];
  const out = new Map<string, LabelFit>();
  for (const b of order) {
    const full = rect(b.cx, b.cy, b.w, b.h);
    const quiet = !!opts.overview && !!b.calm && b.priority < ALWAYS_SHOW && b.headH > 0 && b.headH < b.h;
    if (!quiet && (b.priority >= ALWAYS_SHOW || !hits(full, placed))) {
      out.set(b.id, "full");
      placed.push(full);
      continue;
    }
    if (b.headH > 0 && b.headH < b.h) {
      // Die Kopfzeile sitzt oben im Kasten; ohne zweite Zeile schrumpft er
      // um seine Mitte (translate −50 %), die Kopfzeile wandert also mit.
      const compact = rect(b.cx, b.cy, b.w, b.headH);
      if (!hits(compact, placed)) {
        out.set(b.id, "compact");
        placed.push(compact);
        continue;
      }
    }
    out.set(b.id, "hidden");
  }
  return out;
}

/** Priorität nach Art der Beschriftung (CSS-Klasse) und Dringlichkeit 0…60. */
export function labelPriority(className: string, urgency = 0): number {
  if (className.includes("three-station-label-selected")) return 100;
  if (className.includes("three-measure")) return 95;
  if (className.includes("three-collision")) return 80;
  if (className.includes("three-station-label")) return 50 + Math.max(0, Math.min(60, urgency)) / 4;
  if (className.includes("three-level-label")) return 48;
  if (className.includes("three-job-label")) return 32;
  if (className.includes("three-robot-label")) return 44;
  if (className.includes("three-sim")) return 36;
  if (className.includes("three-flow-label")) return 26;
  if (className.includes("three-door-label")) return 22;
  if (className.includes("three-zone-label")) return 14;
  return 20;
}
