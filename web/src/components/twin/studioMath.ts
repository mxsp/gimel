/* Reine Rechnungen für Twin Studio und die 3D-Ansicht — ohne THREE und React,
   damit Node sie prüfen kann (web/twin-studio.test.mjs).

   - Last auf dem Boden (Wärmebild): aus dem Verhältnis Warteschlange zu
     Tageskapazität. Unbekannte Kapazität bleibt grau und heißt „?", nie 0.
   - Begehen: ein Schritt mit Gleiten an Maschinen, Hindernissen und Wänden.
   - Bearbeiten im Begehen: eine abgelegte Station rastet und dreht sauber.
   - Rundgang: Haltepunkte über die Stationen, dringendste zuerst.
   - Messen: Länge eines Linienzugs in Metern. */

import type { CollisionWorld } from "./collision";
import type { Pt } from "./aisleWays";
import type { StationMark } from "./marks";

export interface HeatStation {
  id?: number | null;
  x: number;
  y: number;
  w: number;
  h: number;
  active?: boolean;
  queue_jobs?: number;
}

export interface HeatSpot {
  id: number;
  x: number;
  y: number;
  /** Radius des Flecks in Metern. */
  radius: number;
  /** 0 … 1.5 (überbucht bleibt sichtbar größer als voll); null = unbekannt. */
  level: number | null;
  /** Farbe als #rrggbb: Grün → Gelb → Rot, Grau bei unbekannt. */
  colour: string;
  /** Geschätzt (≈) oder gebucht. */
  estimated: boolean;
}

/** Farbe zur Last: 0 grün, 0,8 gelb, ≥1 rot. Unbekannt grau. Gezeichnet wird ab ``HEAT_FROM``. */
export function heatColour(level: number | null): string {
  if (level == null || !Number.isFinite(level)) return "#8a939e";
  const t = Math.max(0, Math.min(1.25, level)) / 1.25;
  // Drei Stützfarben, linear dazwischen.
  const stops: [number, [number, number, number]][] = [
    [0, [46, 160, 103]], [0.64, [226, 178, 41]], [1, [214, 64, 60]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const u = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * u));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Ab dieser Last bekommt eine Station einen Fleck. Darunter bleibt der Boden
    ruhig: ein grüner Schein um jede freie Station lenkte nur ab (Owner, 2026-11-07). */
export const HEAT_FROM = 0.8;

export function heatSpots(stations: HeatStation[], status: Record<number, StationMark | undefined>,
  from = HEAT_FROM): HeatSpot[] {
  const out: HeatSpot[] = [];
  for (const s of stations) {
    if (s.id == null || s.active === false) continue;
    const m = status[s.id];
    const ratio = m?.ratio ?? null;
    const level = ratio == null || !Number.isFinite(ratio) ? null : Math.max(0, Math.min(1.5, ratio));
    // Unbekannte Last und freie Stationen: kein Fleck.
    if (level == null || level < from) continue;
    const base = Math.max(1.2, Math.hypot(s.w || 0, s.h || 0) / 2);
    out.push({
      id: s.id, x: s.x, y: s.y,
      radius: base * (1.35 + 0.45 * Math.min(1, level ?? 0)),
      level,
      colour: heatColour(level),
      estimated: m?.certainty !== "firm",
    });
  }
  return out;
}

export interface SupplyStationRisk {
  station_id: number;
  severity: "danger" | "warning";
  role: "storage" | "production";
  reasons: string[];
  materials: string[];
  metric: string;
}

export interface SupplyRiskSpot {
  id: number;
  x: number;
  y: number;
  radius: number;
  severity: "danger" | "warning";
  role: "storage" | "production";
  metric: string;
  reasons: string[];
}

/** Versorgungsrisiko-Ringe auf dem Hallenboden (Lagerregale mit knapper Reichweite
    oder Maschinen mit blockierten / unterdeckten Aufträgen). Rein, ohne THREE. */
export function supplyRiskSpots(
  stations: HeatStation[],
  riskByStation: Record<string, SupplyStationRisk | undefined> | null | undefined,
): SupplyRiskSpot[] {
  if (!riskByStation) return [];
  const out: SupplyRiskSpot[] = [];
  for (const s of stations) {
    if (s.id == null || s.active === false) continue;
    const risk = riskByStation[String(s.id)];
    if (!risk) continue;
    const base = Math.max(1.1, Math.hypot(s.w || 0, s.h || 0) / 2);
    out.push({
      id: s.id,
      x: s.x,
      y: s.y,
      radius: base + (risk.severity === "danger" ? 0.65 : 0.45),
      severity: risk.severity,
      role: risk.role,
      metric: risk.metric,
      reasons: risk.reasons,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- Begehen */

export const EYE_HEIGHT_M = 1.7;
export const WALKER_RADIUS_M = 0.35;
export const WALK_SPEED_MS = 1.6;
export const RUN_SPEED_MS = 4.2;

export interface WalkInput {
  forward: number; // −1 … 1
  strafe: number; // −1 … 1 (rechts positiv)
  run?: boolean;
}

/** Ein Schritt in der Ebene. ``yaw`` 0 blickt nach +y des Plans (Süden), in
    Bogenmaß gegen den Uhrzeigersinn von oben. Stößt der Schritt an einen Körper,
    wird je Achse versucht — so gleitet man an einer Maschine entlang statt
    stehen zu bleiben. Gibt den neuen Punkt und ob etwas im Weg war zurück. */
export function walkStep(
  pos: Pt, yaw: number, input: WalkInput, dt: number, world: CollisionWorld | null,
): { pos: Pt; blocked: boolean } {
  const speed = input.run ? RUN_SPEED_MS : WALK_SPEED_MS;
  const len = Math.hypot(input.forward, input.strafe);
  if (len < 1e-6 || dt <= 0) return { pos, blocked: false };
  const f = input.forward / Math.max(1, len), s = input.strafe / Math.max(1, len);
  const step = speed * Math.min(dt, 0.1);
  // Vorwärts entlang des Blicks, seitlich rechtwinklig dazu.
  const fx = Math.sin(yaw), fy = Math.cos(yaw);
  const rx = -fy, ry = fx;
  const dx = (fx * f + rx * s) * step, dy = (fy * f + ry * s) * step;
  const free = (p: Pt) => !world || !world.blocks(
    { kind: "circle", x: p[0], y: p[1], r: WALKER_RADIUS_M },
    { groups: ["station", "obstacle", "wall"] },
  );
  const full: Pt = [pos[0] + dx, pos[1] + dy];
  if (free(full)) return { pos: full, blocked: false };
  const onlyX: Pt = [pos[0] + dx, pos[1]];
  if (Math.abs(dx) > 1e-9 && free(onlyX)) return { pos: onlyX, blocked: true };
  const onlyY: Pt = [pos[0], pos[1] + dy];
  if (Math.abs(dy) > 1e-9 && free(onlyY)) return { pos: onlyY, blocked: true };
  return { pos, blocked: true };
}

/** Ein freier Startpunkt fürs Begehen: erst ein Tor, sonst die Mitte, sonst
    ein Raster über die Halle. ``null``, wenn wirklich alles belegt ist. */
export function walkStart(
  bounds: { x: number; y: number; w: number; h: number },
  doors: { x: number; y: number }[],
  world: CollisionWorld | null,
): Pt | null {
  const free = (p: Pt) => !world || !world.blocks(
    { kind: "circle", x: p[0], y: p[1], r: WALKER_RADIUS_M + 0.15 },
    { groups: ["station", "obstacle", "wall"] },
  );
  const cx = bounds.x + bounds.w / 2, cy = bounds.y + bounds.h / 2;
  for (const d of doors) {
    // Einen Schritt nach innen vom Tor.
    const vx = cx - d.x, vy = cy - d.y, l = Math.hypot(vx, vy) || 1;
    for (const k of [2, 3.5, 5]) {
      const p: Pt = [d.x + (vx / l) * k, d.y + (vy / l) * k];
      if (free(p)) return p;
    }
  }
  if (free([cx, cy])) return [cx, cy];
  const n = 12;
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < n; j++) {
      const p: Pt = [bounds.x + (bounds.w * i) / n, bounds.y + (bounds.h * j) / n];
      if (free(p)) return p;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- Bearbeiten */

/** Beim Ablegen einer Station im Begehen: Lage auf das Raster der Halle runden
    (Vorgabe 0,25 m wie im Editor) und die Drehung auf −180° … 180° bringen.
    ``snap`` 0 lässt die Lage frei. */
export function movedStation(x: number, y: number, rotation: number, snap = 0.25):
  { x: number; y: number; rotation: number } {
  const g = Number.isFinite(snap) && snap > 0 ? snap : 0;
  const round = (v: number) => {
    const n = g > 0 ? Math.round(v / g) * g : v;
    const out = Math.round(n * 1000) / 1000;
    return out === 0 ? 0 : out;
  };
  return {
    x: round(Number.isFinite(x) ? x : 0),
    y: round(Number.isFinite(y) ? y : 0),
    rotation: Number.isFinite(rotation) ? ((((rotation % 360) + 540) % 360) - 180) : 0,
  };
}

/* ---------------------------------------------------------------- Rundgang */

export interface TourStop {
  id: number;
  label: string;
  x: number;
  y: number;
  /** Abstand der Kamera zur Station in Metern. */
  distance: number;
  /** Blickrichtung von oben, Grad. */
  azimuth: number;
}

/** Haltepunkte: dringendste Stationen zuerst (Rang aus den Marken), höchstens
    ``limit``. Der Blickwinkel wandert, damit der Rundgang nicht starr wirkt. */
export function tourStops(
  stations: (HeatStation & { label?: string })[],
  status: Record<number, StationMark | undefined>,
  limit = 12,
): TourStop[] {
  const list = stations
    .filter((s) => s.id != null && s.active !== false)
    .map((s) => ({ s, rank: status[s.id as number]?.rank ?? 0 }))
    .sort((a, b) => b.rank - a.rank || (a.s.id as number) - (b.s.id as number))
    .slice(0, Math.max(1, limit));
  return list.map(({ s }, i) => ({
    id: s.id as number,
    label: s.label || `Station ${s.id}`,
    x: s.x, y: s.y,
    distance: Math.max(9, Math.max(s.w || 0, s.h || 0) * 3.2),
    azimuth: (i * 67) % 360,
  }));
}

/** Bildtext der Vorführung (task 41 E): wer, wie es steht, warum der Halt.
    Ehrlich wie überall: „läuft" ist gebucht, kein Maschinensignal; was
    geschätzt ist, bleibt ≈; Unbekanntes bleibt unbekannt. */
export interface TourCaption { title: string; state: string; why: string }

const TOUR_WHY: Record<string, string> = {
  ueber: "Überbucht: bis Schichtende ist mehr eingeplant, als die Station schafft.",
  voll: "Wird voll: die Tageskapazität ist fast ausgeschöpft.",
  laeuft: "Läuft laut Buchung — Gimel hat kein Maschinensignal.",
  wartet: "Wartet: Aufträge stehen an, gerade läuft keiner.",
  frei: "Frei: hier ist Platz für weitere Aufträge.",
  unbekannt: "Kapazität unbekannt: es fehlen Angaben, die Last ist nicht zu beurteilen.",
  inaktiv: "Außer Betrieb.",
};

export function tourCaption(stop: { label: string }, mark: StationMark | undefined, index: number, total: number): TourCaption & { step: string } {
  // Wort und zweite Zeile sind oft gleich („wartet · ≈80 min“): nur einmal.
  const parts = mark ? [mark.word, mark.line].filter(Boolean) : [];
  const state = !mark ? "Stand unbekannt"
    : parts.length === 2 && (parts[1].includes(parts[0]) || parts[0].includes(parts[1]))
      ? (parts[1].length >= parts[0].length ? parts[1] : parts[0]) : parts.join(" · ");
  const why = mark ? (TOUR_WHY[mark.kind] ?? "") : "Für diese Station liegt kein Stand vor.";
  return { title: stop.label, state, why, step: `${index + 1} / ${total}` };
}

/* ---------------------------------------------------------------- Messen */

export function polylineMetres(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

export function fmtMetres(m: number): string {
  if (!Number.isFinite(m)) return "?";
  if (m < 10) return `${m.toLocaleString("de-DE", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} m`;
  return `${m.toLocaleString("de-DE", { maximumFractionDigits: 1 })} m`;
}
