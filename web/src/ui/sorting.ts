import { useCallback, useState } from "react";
import { readStore, writeStore } from "./prefs";

/* Sortieren je Seite: Feld und Richtung, gemerkt im Browser. Die Reihenfolge
   ist eine Ansicht, keine gespeicherte Entscheidung — sie gilt nur hier. */

export type SortDir = "asc" | "desc";

export interface SortState {
  field: string;
  dir: SortDir;
}

export interface SortField {
  id: string;
  label: string;
}

const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

export function defaultSort(fields: SortField[], dir: SortDir = "asc"): SortState {
  return { field: fields[0]?.id ?? "", dir };
}

/** Zeilen nach einem Feld ordnen. Leere Werte stehen immer unten, egal in
    welche Richtung sortiert wird — sonst führt „absteigend" mit leeren Zellen. */
export function sortRows<T>(
  rows: T[],
  state: SortState,
  value: (row: T, field: string) => unknown,
): T[] {
  const factor = state.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = value(a, state.field);
    const vb = value(b, state.field);
    const emptyA = va === null || va === undefined || va === "";
    const emptyB = vb === null || vb === undefined || vb === "";
    if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
    const result = typeof va === "number" && typeof vb === "number"
      ? va - vb
      : collator.compare(String(va), String(vb));
    return result * factor;
  });
}

/** Feld und Richtung je Seite merken; ein unbekanntes Feld fällt auf die Vorgabe zurück. */
export function useSortPref(key: string, fields: SortField[], initial?: SortState) {
  const fallback = initial ?? defaultSort(fields);
  const [state, setState] = useState<SortState>(() => {
    try {
      const raw = readStore(key);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SortState>;
        if (typeof parsed.field === "string"
            && fields.some((f) => f.id === parsed.field)
            && (parsed.dir === "asc" || parsed.dir === "desc")) {
          return { field: parsed.field, dir: parsed.dir };
        }
      }
    } catch { /* ein kaputter Merker gilt als keiner */ }
    return fallback;
  });
  const change = useCallback((next: SortState) => {
    setState(next);
    writeStore(key, JSON.stringify(next));
  }, [key]);
  return { sort: state, setSort: change };
}
