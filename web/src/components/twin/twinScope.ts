import type { Floor, Station } from "../../factory";
import { hallOffset, stationFloor, type FloorRef, type HallInfo, type LevelInfo, type Topology } from "../../sites";
import { levelOffsets } from "./levels";

/* Was die 3D-Ansicht außer der aktiven Ebene zeigt (reine Rechnung, kein THREE,
   kein React) — gemeinsam für Leitstand (Digitaler Grundriss) und Twin Studio.

   Bis 2026-11-07 rechneten beide Seiten das je für sich und aus dem *gewählten*
   Topologie-Eintrag, während der Grundriss erst nach einem Abruf folgte: einen
   Abruf lang stand der alte Umriss mit den Stationen, der Höhe und den
   Nachbarhallen der neuen Ebene im Bild, und das Begehen rechnete mit diesem
   Gemisch. Hier geht alles von der Ebene aus, die wirklich gezeigt wird.

   Höhen: jede Halle hat ihr EG auf y = 0 (Hof, Karte); ``levelOffsets`` legt
   die Geschosse darüber und darunter. Nachbarhallen bekommen dieselbe Regel und
   zusätzlich den Höhenunterschied ihres EG, wenn er gemeldet ist. */

export interface GhostLevel {
  id: number;
  label: string;
  /** Höhe über dem EG; das KG liegt negativ. */
  offset: number;
  floor: Floor;
  stations: Station[];
}

export interface NeighborHall {
  id: number;
  label: string;
  /** Ebenenname, z. B. „EG“ — steht an der Halle. */
  level: string;
  floor: Floor;
  stations: Station[];
  /** Lage in den Achsen der aktiven Halle (x, y in Metern), null = unbekannt. */
  x: number | null;
  y: number | null;
  /** Drehung relativ zur aktiven Halle. */
  rotation_deg: number;
  /** Höhe relativ zur aktiven Ebene. */
  elevation_m: number;
}

export interface ScopeArgs {
  /** Die Ebene, die gerade gezeigt wird (nicht die, die gerade gewählt wurde). */
  here: FloorRef | undefined;
  /** Weitere Ebenen dieser Halle: Kennungen oder „alle“. */
  stack: number[] | "all";
  /** Andere Hallen desselben Standorts, die mit im Bild stehen. */
  halls: number[];
  /** Genaue Wahl je Ebene (Twin Studio, Häkchen je Halle und Ebene): dann
      gelten ``stack`` und ``halls`` nicht, gezeigt wird genau diese Liste. */
  only?: number[] | null;
  /** Geladene Grundrisse je Ebene. */
  floors: Record<number, Floor | undefined>;
  stations: Station[];
  topo: Topology | null;
  /** Nur 3D zeigt Stapel und Nachbarhallen. */
  enabled: boolean;
}

export interface SceneScope {
  activeOffset: number;
  ghosts: GhostLevel[];
  neighbors: NeighborHall[];
  /** Ebenen, deren Grundriss die Ansicht braucht (geladen oder nicht). */
  wanted: number[];
  /** Was zu sehen ist, als kurze Namen — für den Assistenten. */
  shownLevels: string[];
  shownHalls: string[];
}

const groundElevation = (floors: LevelInfo[]): number => {
  const eg = floors.find((f) => (f.level || 0) === 0);
  return Number(eg?.elevation_m) || 0;
};

/** Die Ebenen einer Nachbarhalle, die zu den sichtbaren Stufen passen; fehlt
    jede passende, ihr EG (sonst die erste) — wie bisher. */
export function neighborLevels(hall: Pick<HallInfo, "floors">, levels: number[]): LevelInfo[] {
  const match = hall.floors.filter((f) => levels.includes(f.level || 0));
  if (match.length) return match;
  const fallback = hall.floors.find((f) => (f.level || 0) === 0) ?? hall.floors[0];
  return fallback ? [fallback] : [];
}

export function sceneScope(a: ScopeArgs): SceneScope {
  const here = a.here;
  const empty: SceneScope = { activeOffset: 0, ghosts: [], neighbors: [], wanted: [], shownLevels: [], shownHalls: [] };
  if (!here) return empty;
  const hall = here.hall;
  const hallFloors = hall?.floors?.length ? hall.floors : [here.floor];
  const offsets = levelOffsets(hallFloors);
  const activeOffset = offsets.get(here.floor.id) ?? 0;
  const own = here.floor.level_name || `Ebene ${here.floor.level}`;
  if (!a.enabled) return { ...empty, activeOffset, shownLevels: [own] };

  const onFloor = (id: number) => a.stations.filter((s) => stationFloor(s, a.topo) === id);
  const only = a.only ?? null;
  const siblings = hallFloors.filter((f) => f.id !== here.floor.id
    && (only ? only.includes(f.id) : a.stack === "all" || a.stack.includes(f.id)));
  const wanted = new Set<number>(siblings.map((f) => f.id));
  const ghosts: GhostLevel[] = siblings.flatMap((f) => {
    const plan = a.floors[f.id];
    return plan ? [{
      id: f.id, label: f.level_name || `Ebene ${f.level}`, offset: offsets.get(f.id) ?? 0,
      floor: plan, stations: onFloor(f.id),
    }] : [];
  });

  // Nachbarhallen zeigen dieselben Stufen wie der Stapel hier — wer EG und
  // 1. OG sieht, sieht beides auch nebenan.
  const levels = [here.floor.level || 0, ...siblings.map((f) => f.level || 0)];
  const neighbors: NeighborHall[] = [];
  const shownHalls: string[] = [];
  const others = (here.site?.halls ?? []).filter((h) => h.id !== hall?.id && h.floors.length > 0
    && (only ? h.floors.some((f) => only.includes(f.id)) : a.halls.includes(h.id)));
  const ownGround = groundElevation(hallFloors);
  for (const other of others) {
    const refs = only ? other.floors.filter((f) => only.includes(f.id)) : neighborLevels(other, levels);
    const otherOffsets = levelOffsets(other.floors);
    const ground = groundElevation(other.floors) - ownGround;
    const place = hall ? hallOffset(hall, other) : null;
    const rotation = (other.rotation_deg || 0) - (hall?.rotation_deg || 0);
    shownHalls.push(other.name);
    for (const ref of refs) {
      wanted.add(ref.id);
      const plan = a.floors[ref.id];
      if (!plan) continue;
      neighbors.push({
        id: other.id, label: other.name, level: ref.level_name || `Ebene ${ref.level}`, floor: plan,
        stations: onFloor(ref.id),
        x: place?.x ?? null, y: place?.y ?? null, rotation_deg: rotation,
        elevation_m: ground + (otherOffsets.get(ref.id) ?? 0) - activeOffset,
      });
    }
  }
  return {
    activeOffset, ghosts, neighbors, wanted: [...wanted],
    shownLevels: [own, ...siblings.map((f) => f.level_name || `Ebene ${f.level}`)],
    shownHalls,
  };
}

/* ------------------------------------------------------- Auswahl mitnehmen */

export interface Selection {
  /** Zusätzliche Ebenen der aktiven Halle (Leitstand: „Ebenen +n“). */
  extra: number[];
  /** Weitere Hallen im Bild. */
  halls: number[];
}

/** Die Auswahl, wenn die aktive Ebene wechselt — damit ein Wechsel nur den
    Blickpunkt verschiebt und nicht die Hälfte des Bildes ausblendet.

    - Gleiche Halle: wer einen Stapel sah, sieht ihn weiter; die verlassene
      Ebene bleibt darin, die neue ist nicht mehr „zusätzlich“.
    - Andere Halle desselben Standorts: dieselben Stufen bleiben gestapelt, die
      verlassene Halle bleibt sichtbar, wenn schon Hallen gezeigt wurden oder
      man hinübergegangen ist (``keepHall``).
    - Anderer Standort: neu beginnen. */
export function carrySelection(
  prev: FloorRef | undefined, next: FloorRef | undefined, sel: Selection, keepHall = false,
): Selection {
  if (!prev || !next || prev.floor.id === next.floor.id) return sel;
  const nextId = next.floor.id;
  const sameHall = prev.hall && next.hall ? prev.hall.id === next.hall.id : !prev.hall && !next.hall;
  if (sameHall) {
    const extra = sel.extra.length
      ? [...new Set([...sel.extra, prev.floor.id])].filter((id) => id !== nextId)
      : [];
    return { extra, halls: sel.halls.filter((id) => id !== next.hall?.id) };
  }
  const sameSite = !!prev.site && !!next.site && prev.site.id === next.site.id;
  if (!sameSite) return { extra: [], halls: [] };
  const prevFloors = prev.hall?.floors ?? [];
  const levels = new Set([prev.floor.level || 0,
    ...sel.extra.map((id) => prevFloors.find((f) => f.id === id)?.level ?? NaN)]);
  const extra = sel.extra.length
    ? (next.hall?.floors ?? []).filter((f) => f.id !== nextId && levels.has(f.level || 0)).map((f) => f.id)
    : [];
  const halls = sel.halls.filter((id) => id !== next.hall?.id);
  if (prev.hall && (keepHall || sel.halls.length > 0) && !halls.includes(prev.hall.id)) halls.push(prev.hall.id);
  return { extra, halls };
}

/* ------------------------------------------- Häkchen je Halle und Ebene */

/** Vorgabe ohne eigene Wahl: jede andere Halle des Standorts auf derselben
    Stufe (sonst ihr EG), kein Stapel — wie Twin Studio es bisher zeigte. */
export function defaultShown(here: FloorRef | undefined): number[] {
  if (!here?.site) return [];
  return here.site.halls
    .filter((h) => h.id !== here.hall?.id && h.floors.length > 0)
    .flatMap((h) => neighborLevels(h, [here.floor.level || 0]).map((f) => f.id));
}

/** Häkchen an einer Halle: alle ihre Ebenen an oder aus (die aktive bleibt immer). */
export function toggleHallFloors(shown: number[], hall: Pick<HallInfo, "floors">, activeId: number | null): number[] {
  const ids = hall.floors.map((f) => f.id).filter((id) => id !== activeId);
  const all = ids.length > 0 && ids.every((id) => shown.includes(id));
  return all ? shown.filter((id) => !ids.includes(id)) : [...new Set([...shown, ...ids])];
}

/** Zustand des Hallen-Häkchens: an, aus oder teilweise. Die aktive Halle ist
    nie „aus“ — ihre aktive Ebene steht immer im Bild. */
export function hallCheck(shown: number[], hall: Pick<HallInfo, "floors">, activeId: number | null): "on" | "off" | "some" {
  const active = activeId != null && hall.floors.some((f) => f.id === activeId);
  const ids = hall.floors.map((f) => f.id).filter((id) => id !== activeId);
  const n = ids.filter((id) => shown.includes(id)).length;
  if (n === ids.length) return active || ids.length > 0 ? "on" : "off";
  return n === 0 && !active ? "off" : "some";
}

/** Die genaue Wahl bei einem Wechsel der aktiven Ebene (Studio): was zu sehen
    war, bleibt zu sehen; die neue aktive Ebene ist kein Häkchen mehr; die
    verlassene bleibt, wenn außer ihr etwas gezeigt wurde oder man gegangen ist. */
export function carryFloors(prevId: number | null, nextId: number | null, shown: number[], keep = false): number[] {
  if (prevId == null || nextId == null || prevId === nextId) return shown;
  const out = shown.filter((id) => id !== nextId);
  if ((shown.length > 0 || keep) && !out.includes(prevId)) out.push(prevId);
  return out;
}

/* ------------------------------------------------------------- Blickpunkt */

export interface FocusStation {
  id: number;
  label: string;
  /** Abstand zur Gerätekante (Meter, ≥ 0). */
  distance_m: number;
}

export interface ViewerFocus {
  /** Die nächste Station in Reichweite (≤ ``near``). */
  nearest: FocusStation | null;
  /** Die Station, auf die der Blick fällt (Kegel ± ``cone`` Grad, ≤ ``range``). */
  ahead: FocusStation | null;
}

function edgeDistance(s: Pick<Station, "x" | "y" | "w" | "h" | "rotation">, p: [number, number]): number {
  // In die Achsen der Station drehen, dann Abstand zum Rechteck.
  const r = (-(s.rotation || 0) * Math.PI) / 180;
  const dx = p[0] - s.x, dy = p[1] - s.y;
  const lx = dx * Math.cos(r) - dy * Math.sin(r);
  const ly = dx * Math.sin(r) + dy * Math.cos(r);
  const ox = Math.max(0, Math.abs(lx) - (s.w || 0) / 2);
  const oy = Math.max(0, Math.abs(ly) - (s.h || 0) / 2);
  return Math.hypot(ox, oy);
}

/** Welche Station vor einem steht und welche am nächsten ist. Blickrichtung in
    Grad wie ``ViewerPose`` (0 = +y, 90 = +x); null = von oben, dann nur die nächste. */
export function viewerFocus(
  stations: Pick<Station, "id" | "label" | "x" | "y" | "w" | "h" | "rotation">[],
  pos: [number, number], headingDeg: number | null,
  opts: { near?: number; range?: number; cone?: number } = {},
): ViewerFocus {
  const near = opts.near ?? 4, range = opts.range ?? 30, cone = opts.cone ?? 22;
  let nearest: FocusStation | null = null;
  let ahead: FocusStation | null = null;
  let aheadScore = Infinity;
  const h = headingDeg == null ? null : (headingDeg * Math.PI) / 180;
  for (const s of stations) {
    if (s.id == null) continue;
    const d = Math.round(edgeDistance(s, pos) * 10) / 10;
    if (d <= near && (!nearest || d < nearest.distance_m)) nearest = { id: s.id, label: s.label, distance_m: d };
    if (h == null || d > range) continue;
    const dx = s.x - pos[0], dy = s.y - pos[1];
    const centre = Math.hypot(dx, dy);
    if (centre < 1e-6) continue;
    // Winkel zur Blickrichtung; die halbe Gerätebreite zählt als Spielraum.
    const off = Math.abs(Math.atan2(dx * Math.cos(h) - dy * Math.sin(h), dx * Math.sin(h) + dy * Math.cos(h)));
    const slack = Math.atan2(Math.max(s.w || 0, s.h || 0) / 2, centre);
    const miss = Math.max(0, off - slack);
    if (miss > (cone * Math.PI) / 180) continue;
    // Nahe und mittig gewinnt; ein Gerät knapp am Rand zählt weniger.
    const score = d + miss * 20;
    if (score < aheadScore) { aheadScore = score; ahead = { id: s.id, label: s.label, distance_m: d }; }
  }
  return { nearest, ahead };
}
