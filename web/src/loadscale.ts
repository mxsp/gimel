import { fmtMin } from "./factory";
import { plural } from "./plural";

/* Wie voll ist eine Station? Gemessen an ihrer Tageskapazität, nicht an der
   vollsten Nachbarin: sonst steht jede Halle mit gleich vielen Aufträgen je
   Station geschlossen auf „100 %" und rot.

   0 in einem Maschinenwert heißt unbekannt. Fehlt die Kapazität oder die Dauer,
   gibt es keine Prozentzahl und kein Rot, nur die Zahl, die wir haben. */

export type LoadLevel = "free" | "low" | "mid" | "high" | "over" | "unknown";

export interface StationLoad {
  /** Eingeplante Minuten; 0 bei offenen Aufgaben heißt: Dauer unbekannt. */
  queueMin: number;
  /** Minuten je Arbeitstag; 0 heißt unbekannt. */
  capacityMin: number;
  /** Offene Aufgaben. */
  tasks: number;
}

export interface LoadInfo {
  level: LoadLevel;
  /** Warteschlange geteilt durch Tageskapazität, null wenn unbekannt. */
  ratio: number | null;
  text: string;
}

export function loadInfo({ queueMin, capacityMin, tasks }: StationLoad): LoadInfo {
  if (tasks <= 0 && queueMin <= 0) return { level: "free", ratio: 0, text: "frei" };
  if (queueMin <= 0) return { level: "unknown", ratio: null, text: `${plural(tasks, "Aufgabe", "Aufgaben")} · Dauer unbekannt` };
  if (capacityMin <= 0) return { level: "unknown", ratio: null, text: `${fmtMin(queueMin)} · Kapazität unbekannt` };
  const ratio = queueMin / capacityMin;
  const level: LoadLevel = ratio > 1 ? "over" : ratio >= 0.85 ? "high" : ratio >= 0.5 ? "mid" : "low";
  return { level, ratio, text: `${fmtMin(queueMin)} von ${fmtMin(capacityMin)} · ${Math.round(ratio * 100)} %` };
}

/** Balkenbreite 0 bis 1. Ohne Kapazität der Rang unter den anderen ohne Kapazität,
 *  neutral eingefärbt: lang heißt dort „mehr als die anderen", nicht „voll". */
export function barWidth(info: LoadInfo, queueMin: number, maxUnknownMin: number): number {
  if (info.ratio != null) return Math.min(1, info.ratio);
  return maxUnknownMin > 0 ? Math.min(1, queueMin / maxUnknownMin) : 0;
}

/** Rot erst, wenn es eng wird; unter der Hälfte bleibt die Stationsfarbe. */
export function heatFromRatio(ratio: number): number {
  return Math.max(0, Math.min(1, (ratio - 0.5) / 0.5));
}
