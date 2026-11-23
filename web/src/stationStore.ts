import { useEffect, useState } from "react";
import { api } from "./api";
import type { StationType } from "./factory";

/* Gemeinsamer Stations-Speicher für Seitenleiste und Stations-Leiste.

   Grundriss, Arbeitsvorrat und Stations-Cockpit holen ihre Stationen
   ohnehin vom Server und melden sie hier nebenbei an (publishStations). So
   entstehen keine doppelten Abrufe. Nur wenn jemand die Stationsliste explizit
   aufklappt und noch keine Daten da sind, lädt loadStationsOnce genau einmal. */

export interface StationQuick {
  id: number;
  label: string;
  type: StationType;
  active: boolean;
  queue_jobs: number;
  queue_min: number;
}

type Listener = () => void;

let cached: StationQuick[] = [];
let loaded = false;
let inflight: Promise<StationQuick[]> | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const fn of listeners) fn();
}

function normalize(list: Array<{
  id?: number | null;
  label?: string;
  type?: string;
  active?: boolean;
  queue_jobs?: number;
  queue_min?: number;
}>): StationQuick[] {
  const out: StationQuick[] = [];
  for (const s of list) {
    if (s.id == null || !s.label) continue;
    out.push({
      id: s.id,
      label: s.label,
      type: (s.type as StationType) || "production",
      active: s.active !== false,
      queue_jobs: s.queue_jobs ?? 0,
      queue_min: s.queue_min ?? 0,
    });
  }
  const typeOrder: Record<string, number> = { production: 0, warehouse: 1, shipping: 2, accounting: 3 };
  out.sort((a, b) =>
    Number(b.active) - Number(a.active)
    || (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9)
    || a.label.localeCompare(b.label, "de"));
  return out;
}

/** Übernimmt bereits geladene Stationen aus einer laufenden Ansicht ohne neuen Abruf. */
export function publishStations(list: Array<{
  id?: number | null;
  label?: string;
  type?: string;
  active?: boolean;
  queue_jobs?: number;
  queue_min?: number;
}>): void {
  const next = normalize(list);
  loaded = true;
  if (
    next.length === cached.length
    && next.every((s, i) =>
      s.id === cached[i].id
      && s.label === cached[i].label
      && s.active === cached[i].active
      && s.queue_jobs === cached[i].queue_jobs)
  ) {
    return;
  }
  cached = next;
  emit();
}

export function hasLoadedStations(): boolean {
  return loaded;
}

/** Lädt Stationen bei Bedarf genau einmal (in-flight dedupliziert). */
export function loadStationsOnce(): Promise<StationQuick[]> {
  if (loaded) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = api<Array<{
    id?: number | null;
    label?: string;
    type?: string;
    active?: boolean;
    queue_jobs?: number;
    queue_min?: number;
  }>>("/api/factory/stations")
    .then((rows) => {
      publishStations(Array.isArray(rows) ? rows : []);
      return cached;
    })
    .catch(() => cached)
    .finally(() => { inflight = null; });
  return inflight;
}

export function useKnownStations(): { stations: StationQuick[]; loaded: boolean } {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return { stations: cached, loaded };
}
