/* Eine Zelle, mehrere Arme — wer steht wo, wer sortiert welche Klasse.

   Bis 2026-11-08 hatte die Zelle genau einen Arm an einer Greifstelle
   (`PICK_X`) und einen Korbstreifen dahinter. Stehen in derselben Halle zwei
   Arme, wird aus der Zelle eine Linie: das Band läuft von links nach rechts,
   jeder Arm hat seine eigene Greifstelle am Band und seinen eigenen
   Korbstreifen dahinter, und die Sortierklassen sind unter den Armen
   aufgeteilt. Ein Teil, das einem stromabwärts stehenden Arm gehört, fährt an
   der ersten Station vorbei und bleibt erst dort stehen — deshalb ist die
   Aufteilung eine Partition: jede Form gehört genau einem Arm, die
   Nachprüfung (REJECT_BIN) gehört allen.

   Diese Datei rechnet nur (kein DOM, kein Three.js): Maße in Metern, Klassen
   als Korb-Indizes. `cellScene.ts` baut daraus die Körbe, `runtime.ts` die
   Abläufe. Ein Arm (der Normalfall) ergibt exakt die alte Geometrie:
   Greifstelle −0,42 m, Korbstreifen um x = 0, sechs Körbe im Abstand 0,24 m.

   Grenze: zwei Arme je Zelle. Die Kamera hängt mittig über dem Band; ein
   dritter Arm stünde am Kameramast und am Bandende. Weitere Arme derselben
   Halle bleiben in der Flottenliste, ohne Station. */

import { BIN_COUNT, BIN_LABELS, REJECT_BIN } from "./forms";

/** Förderband (Meter). Ein Meter = eine Three.js-Einheit. */
export const BELT = { x0: -1.5, x1: 0.7, z0: -0.42, z1: 0.42, top: 0.82 };
/** Greifstelle des einen Arms (unverändert seit dem ersten Aufbau). */
export const PICK_X = -0.42;
/** Korbstreifen hinter dem Band. */
export const BIN_Z = -0.6;
/** Oberkante der Körbe — dort legt der Arm ab. */
export const BIN_TOP = 0.9;
/** Abstand zweier Körbe im Streifen (Meter). */
export const BIN_PITCH = 0.24;
/** Fuß des Arms und Mitte des Kameramasts. */
export const ARM_FOOT_Y = 0.55;
export const ARM_FOOT_Z = 0.58;
export const CAM_CENTER = { x: -0.4, z: 0 };
/** Mehr Arme baut diese Zelle nicht auf (siehe Kopf). */
export const MAX_ARMS = 2;
/** Abstand zweier Teile auf dem Band (Millimeter). */
export const SPACING_MM = 320;
/** Bandgeschwindigkeit (Millimeter je Sekunde bei ×1). */
export const BELT_MM_S = 105;

export interface StationBinSpec {
  /** Globaler Korb-Index (0…BIN_COUNT-1); die Anzeige zählt danach. */
  bin: number;
  /** Lage im Streifen dieses Arms (0 = links). */
  local: number;
  /** Meter, Zellenkoordinaten. */
  x: number;
  z: number;
  label: string;
}

export interface StationSpec {
  /** 0 = erster Arm am Bandanfang (stromaufwärts). */
  index: number;
  /** Greifstelle am Band (Meter). */
  x: number;
  z: number;
  /** Armfuß (Meter). */
  base: { x: number; y: number; z: number };
  /** Körbe dieses Arms, von links nach rechts. */
  bins: StationBinSpec[];
  /** Korb-Indizes, die dieser Arm bedient (Formen + Nachprüfung). */
  owns: number[];
}

export interface CellLayout {
  /** Zahl der Arme mit Station (1 oder 2). */
  arms: number;
  stations: StationSpec[];
  /** Wo neue Teile aufs Band gelegt werden (Millimeter). */
  spawnMm: number;
  beltStartMm: number;
  beltEndMm: number;
}

const clampInt = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Math.round(v)));

/** Die Formkörbe als zusammenhängende Stücke auf die Arme verteilen. */
export function splitBins(arms: number): number[][] {
  const n = clampInt(arms, 1, MAX_ARMS);
  const forms = BIN_COUNT - 1; // REJECT_BIN ist immer der letzte Korb
  const share = Math.floor(forms / n);
  const extra = forms % n;
  const out: number[][] = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    const count = share + (i < extra ? 1 : 0);
    const bins: number[] = [];
    for (let k = 0; k < count; k++) bins.push(next++);
    bins.push(REJECT_BIN); // Nachprüfung gibt es an jeder Station
    out.push(bins);
  }
  return out;
}

/** Lage der Greifstellen und Armfüße für 1 oder 2 Arme. */
export function layoutFor(armCount: number): CellLayout {
  const n = clampInt(armCount, 1, MAX_ARMS);
  const shares = splitBins(n);
  const stationX = n === 1 ? [PICK_X] : [-1.0, -0.1];
  // Ein Arm steht mittig hinter dem Band; zwei Arme stehen hinter ihren
  // Greifstellen, damit jeder seinen Korbstreifen ohne weiten Weg erreicht.
  const baseX = n === 1 ? [0] : stationX;
  const stations: StationSpec[] = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    const bins = shares[i];
    const centre = baseX[i];
    const bins_: StationBinSpec[] = bins.map((bin, local) => ({
      bin, local,
      x: centre + (local - (bins.length - 1) / 2) * BIN_PITCH,
      z: BIN_Z,
      label: BIN_LABELS[bin] ?? "?",
    }));
    stations.push({
      index: i,
      x: stationX[i],
      z: 0,
      base: { x: baseX[i], y: ARM_FOOT_Y, z: ARM_FOOT_Z },
      bins: bins_,
      owns: [...bins],
    });
    next += bins.length;
  }
  const beltStartMm = Math.round(BELT.x0 * 1000);
  const beltEndMm = Math.round(BELT.x1 * 1000);
  const firstStationMm = Math.round(stations[0].x * 1000);
  return {
    arms: n,
    stations,
    spawnMm: Math.max(beltStartMm + 50, firstStationMm - 3 * SPACING_MM),
    beltStartMm,
    beltEndMm,
  };
}

/** Welcher Arm ein Teil dieser Klasse nimmt (der erste, der sie bedient). */
export function stationForBin(layout: CellLayout, bin: number): number {
  for (const s of layout.stations) if (s.owns.includes(bin)) return s.index;
  return layout.stations.length - 1;
}

/** Der Korb eines Arms für einen globalen Korb-Index (null, wenn er ihn nicht bedient). */
export function binAt(layout: CellLayout, station: number, bin: number): StationBinSpec | null {
  return layout.stations[station]?.bins.find((b) => b.bin === bin) ?? null;
}

/** Kurztext für die Anzeige: „1 Arm · 6 Körbe" oder „2 Arme · 2 Stationen". */
export function layoutLabel(layout: CellLayout): string {
  return layout.arms === 1
    ? "1 Arm · 1 Station"
    : `${layout.arms} Arme · ${layout.stations.length} Stationen`;
}
