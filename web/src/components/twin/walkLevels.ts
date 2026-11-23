import { doorDirection, sceneBounds } from "../../factory";
import type { Floor, Station } from "../../factory";

/* Treppe und Aufzug beim Begehen (reine Rechnung, kein THREE, kein React).

   Der Plan kennt beides schon: Türen, die „Treppe“ oder „Aufzug“ heißen (oder
   die Art `stair` / `lift` tragen). Daraus wird hier ein Zugang: wo er steht,
   wohin er in die Halle zeigt, wo man davor steht und welchen Fußabdruck sein
   Körper hat. Nichts davon wird gespeichert — der Plan bleibt, wie er ist.

   Die Treppe ist seit 2026-11-07 ein echter Lauf: rechts hinauf, links in
   einen Schacht hinunter. Beide Läufe beginnen an der Hallenseite auf dem
   Boden und enden an der Wand; die Kamera folgt den Stufen (``stairSurface``).
   Der Fußabdruck ist kein Klotz mehr, sondern drei schmale Geländer — so kann
   man vorn hineingehen, aber nicht durch die Seite. Der Aufzug bleibt ein
   Körper und wird weiter mit E oder Klick bedient. */

export type LinkKind = "stair" | "lift";

export interface VerticalLink {
  kind: LinkKind;
  name: string;
  /** Punkt auf der Wand. */
  x: number;
  y: number;
  /** Einheitsvektor in die Halle (senkrecht zur Wand). */
  nx: number;
  ny: number;
  /** Einheitsvektor entlang der Wand. */
  ux: number;
  uy: number;
  /** Breite und Tiefe des Körpers in Metern. */
  width: number;
  depth: number;
}

export const STAIR_RE = /treppe|stufen|stair/i;
export const LIFT_RE = /aufzug|fahrstuhl|lift|elevator/i;

/** Wie nah man an den Zugang heran muss, damit E ihn öffnet. */
export const INTERACT_M = 2.7;

/** Echter Treppenlauf: Tiefe in die Halle, Steighöhe und Stufenzahl. */
export const STAIR_RUN_M = 3.6;
export const STAIR_RISE_M = 2.8;
export const STAIR_STEPS = 14;
/** Ab hier (nahe der Wand) wechselt der Lauf die Ebene. */
export const STAIR_TRIGGER_M = 0.9;

const CORE_DEPTH = 0.9;
const RAIL_HALF_M = 0.09;

export function linkKindOf(d: { name?: string; kind?: string }): LinkKind | null {
  if (d.kind === "stair" || d.kind === "lift") return d.kind;
  const name = d.name ?? "";
  if (LIFT_RE.test(name)) return "lift";
  if (STAIR_RE.test(name)) return "stair";
  return null;
}

/** Alle Treppen und Aufzüge einer Ebene, mit der Richtung in die Halle. */
export function verticalLinks(floor: Floor, stations: Station[] = []): VerticalLink[] {
  const out: VerticalLink[] = [];
  const doors = floor.doors ?? [];
  if (!doors.length) return out;
  const b = sceneBounds(floor, stations);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  for (const d of doors) {
    const kind = linkKindOf(d);
    if (!kind) continue;
    const [ux0, uy0] = doorDirection(floor, d);
    let nx = -uy0, ny = ux0;
    // Die Normale zeigt zur Hallenmitte, nicht aus der Halle hinaus.
    if (nx * (cx - d.x) + ny * (cy - d.y) < 0) { nx = -nx; ny = -ny; }
    // +u ist die rechte Hand beim Blick zur Wand; so liegen „rechts hinauf“,
    // das Trittfeld und das Modell (steigt nach +x) auf derselben Seite.
    const ux = ny, uy = -nx;
    out.push({
      kind, name: d.name || (kind === "lift" ? "Aufzug" : "Treppe"),
      x: d.x, y: d.y, nx, ny, ux, uy,
      width: kind === "lift" ? 2.2 : 3.0,
      depth: kind === "lift" ? CORE_DEPTH : STAIR_RUN_M,
    });
  }
  return out;
}

/** Die Ecken des Körpers, den man nicht durchschreiten darf (für die Kollision). */
export function linkFootprint(l: VerticalLink): [number, number][] {
  const hw = l.width / 2;
  const c = (s: number, t: number): [number, number] => [
    l.x + l.ux * s + l.nx * t, l.y + l.uy * s + l.ny * t,
  ];
  // Ein Stück in die Wand hinein, damit zwischen Körper und Wand keine Lücke bleibt.
  return [c(-hw, -0.1), c(hw, -0.1), c(hw, l.depth), c(-hw, l.depth)];
}

/** Der nächste Zugang in Reichweite — der Abstand gilt zur Vorderkante. */
export function nearestLink(
  links: VerticalLink[], pos: [number, number], maxDist = INTERACT_M,
): VerticalLink | null {
  let best: VerticalLink | null = null;
  let bestD = maxDist;
  for (const l of links) {
    // Vorderkante: Mittelpunkt der Front.
    const fx = l.x + l.nx * l.depth, fy = l.y + l.ny * l.depth;
    const d = Math.hypot(pos[0] - fx, pos[1] - fy);
    if (d <= bestD) { best = l; bestD = d; }
  }
  return best;
}

/** Wo man steht, wenn man aus dem Zugang kommt: davor, mit dem Blick in die Halle.
    Nach einer Treppe steht man auf der Seite, die zurückführt (``side``). */
export function arrivalSpot(l: VerticalLink, side?: StairDir): { pos: [number, number]; yaw: number } {
  // Weit genug vor dem Trittfeld, sonst löst die Treppe sofort wieder aus.
  const k = l.depth + 1.5;
  const off = side === "up" ? l.width / 4 : side === "down" ? -l.width / 4 : 0;
  return {
    pos: [l.x + l.nx * k + l.ux * off, l.y + l.ny * k + l.uy * off],
    yaw: Math.atan2(l.nx, l.ny),
  };
}

/* -------------------------------------------------------------- Treppe */

export type StairDir = "up" | "down";

/** Die nächste Ebene über oder unter ``fromId``; null am Ende des Stapels. */
export function nextLevel(levels: WalkLevel[], fromId: number, dir: StairDir): WalkLevel | null {
  const choices = levelChoices(levels);
  const i = choices.findIndex((l) => l.id === fromId);
  if (i < 0) return null;
  return choices[dir === "up" ? i - 1 : i + 1] ?? null;
}

/** Auf welcher Hälfte der Treppe man steht. Wer davor steht und zur Wand
    schaut, sieht die Steigrichtung (+u) rechts: rechts hinauf, links hinunter. */
export function stairLane(l: VerticalLink, pos: [number, number]): StairDir {
  const s = (pos[0] - l.x) * l.ux + (pos[1] - l.y) * l.uy;
  return s >= 0 ? "up" : "down";
}

/** Ein Punkt auf dem Treppenlauf, mit Steighöhe über dem Hallenboden.
    ``t`` läuft von 0 (Wand, oben/unten) bis ``depth`` (Hallenseite, Boden). */
export interface StairSurface {
  link: VerticalLink;
  dir: StairDir;
  /** Lage entlang der Wand; 0 ist die Trennlinie der beiden Läufe. */
  s: number;
  /** Lage in die Halle; ``depth`` ist der Einstieg vorn. */
  t: number;
  /** Höhe der Trittfläche über dem Hallenboden (rechts positiv, links negativ). */
  height: number;
  /** Erreichte Stufe, 0 vorn bis ``STAIR_STEPS`` an der Wand. */
  step: number;
}

/** Steht man auf der Treppe? Liefert Lauf, Stufe und Höhe; sonst null. */
export function stairSurface(l: VerticalLink, pos: [number, number]): StairSurface | null {
  if (l.kind !== "stair") return null;
  const dx = pos[0] - l.x, dy = pos[1] - l.y;
  const s = dx * l.ux + dy * l.uy;
  const t = dx * l.nx + dy * l.ny;
  if (Math.abs(s) > l.width / 2 + 0.02) return null;
  if (t < -0.02 || t > l.depth + 0.02) return null;
  const dir = s >= 0 ? "up" : "down";
  const run = l.depth / STAIR_STEPS;
  const step = Math.max(0, Math.min(STAIR_STEPS, Math.ceil((l.depth - t) / run - 1e-6)));
  const height = (dir === "up" ? 1 : -1) * STAIR_RISE_M * (step / STAIR_STEPS);
  return { link: l, dir, s, t, height, step };
}

/** Die Treppe, auf der man gerade steht (erste passende). */
export function stairSurfaceAt(links: VerticalLink[], pos: [number, number]): StairSurface | null {
  for (const l of links) {
    const surface = stairSurface(l, pos);
    if (surface) return surface;
  }
  return null;
}

/** Alter Name für „auf der Treppe“: liefert nur die Richtung. */
export function atStair(l: VerticalLink, pos: [number, number]): StairDir | null {
  return stairSurface(l, pos)?.dir ?? null;
}

/** Die Treppe, auf der man steht. */
export function stairStep(
  links: VerticalLink[], pos: [number, number],
): { link: VerticalLink; dir: StairDir } | null {
  const surface = stairSurfaceAt(links, pos);
  return surface ? { link: surface.link, dir: surface.dir } : null;
}

function stairQuad(
  l: VerticalLink, s0: number, s1: number, t0: number, t1: number,
): [number, number][] {
  const at = (s: number, t: number): [number, number] => [
    l.x + l.ux * s + l.nx * t, l.y + l.uy * s + l.ny * t,
  ];
  return [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)];
}

/** Drei schmale Körper statt eines Klotzes: die beiden Außenkanten und die
    Trennlinie. Zwischen ihnen läuft man hinein, durch die Seite nicht. */
export function stairRailFootprints(l: VerticalLink): [number, number][][] {
  if (l.kind !== "stair") return [linkFootprint(l)];
  const hw = l.width / 2;
  return [-hw, 0, hw].map((s) => stairQuad(
    l, s - RAIL_HALF_M, s + RAIL_HALF_M, -0.06, l.depth + 0.02,
  ));
}

/** Die Öffnung im Hallenboden über dem hinunterführenden Lauf. */
export function stairWellHole(l: VerticalLink): [number, number][] | null {
  if (l.kind !== "stair") return null;
  const hw = l.width / 2;
  return stairQuad(l, -hw - 0.02, 0.02, -0.02, l.depth + 0.02);
}

export function stairWellHoles(links: VerticalLink[]): [number, number][][] {
  return links.flatMap((l) => {
    const hole = stairWellHole(l);
    return hole ? [hole] : [];
  });
}

/** Die Zeile im Hinweis an der Treppe: welcher Lauf wohin führt. */
export function stairHint(l: VerticalLink, above: WalkLevel | null, below: WalkLevel | null): string {
  if (above && below) return `${l.name} · rechts hinauf, links hinunter`;
  if (above) return `${l.name} · hinauf nach ${above.label}`;
  if (below) return `${l.name} · hinunter nach ${below.label}`;
  return `${l.name} · keine weitere Ebene in dieser Halle`;
}

/** Der Zugang der gleichen Art, sonst irgendeiner, sonst nichts. */
export function matchingLink(links: VerticalLink[], kind: LinkKind, name = ""): VerticalLink | null {
  return links.find((l) => l.kind === kind && l.name === name)
    ?? links.find((l) => l.kind === kind) ?? links[0] ?? null;
}

export interface WalkLevel {
  id: number;
  label: string;
  /** Höhe über Normal-Null der Anlage (Meter), nur zur Anzeige. */
  elevation_m: number;
  level: number;
}

/** Ebenen wie auf einem Aufzugsfeld: oben zuerst. */
export function levelChoices(levels: WalkLevel[]): WalkLevel[] {
  return [...levels].sort((a, b) => b.level - a.level || b.elevation_m - a.elevation_m || a.id - b.id);
}

/** Wie lange die Fahrt dauert (ms): Aufzug zügig, Treppe länger; mehr Stockwerke mehr Zeit. */
export function rideMs(kind: LinkKind, fromLevel: number, toLevel: number): number {
  const n = Math.max(1, Math.abs(toLevel - fromLevel));
  return Math.min(2400, (kind === "lift" ? 700 : 1000) + n * (kind === "lift" ? 260 : 420));
}

/** Die Zeile im Hinweis: „E · Aufzug: Ebene wählen“. Treppen brauchen kein E. */
export function linkPrompt(l: VerticalLink, others: number): string {
  if (others < 1) return `${l.name} · keine weitere Ebene in dieser Halle`;
  return `E · ${l.name}: Ebene wählen`;
}
