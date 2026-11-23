import { useCallback, useState } from "react";

/* Ansicht je Bildschirm: Spalten und Dichte bleiben im Browser, nicht in der
   Datenbank. Ein neues Konto erbt so nichts, was ein anderes Gerät gewählt hat. */

export type Density = "standard" | "compact" | "comfort";

const DENSITY_KEY = "gimel-density";

export const DENSITY_LABEL: Record<Density, string> = {
  standard: "Standard",
  compact: "Kompakt",
  comfort: "Komfort",
};

export function readDensity(): Density {
  try {
    const value = localStorage.getItem(DENSITY_KEY);
    return value === "compact" || value === "comfort" ? value : "standard";
  } catch {
    return "standard";
  }
}

function applyDensity(value: Density): void {
  if (value === "standard") delete document.documentElement.dataset.density;
  else document.documentElement.dataset.density = value;
}

export function setDensity(value: Density): void {
  try {
    if (value === "standard") localStorage.removeItem(DENSITY_KEY);
    else localStorage.setItem(DENSITY_KEY, value);
  } catch {
    /* privater Modus: gilt bis zum Neuladen */
  }
  applyDensity(value);
}

export function initDensity(): void {
  applyDensity(readDensity());
}

export function readStore(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* privater Modus */
  }
}

export function readHidden(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Ausgeblendete Spalten einer Tabelle, gemerkt unter einem festen Schlüssel. */
export function useHiddenColumns(key: string) {
  const [hidden, setHiddenState] = useState<string[]>(() => readHidden(key));
  const setHidden = useCallback((next: string[]) => {
    setHiddenState(next);
    writeStore(key, next.length ? JSON.stringify(next) : null);
  }, [key]);
  const toggle = useCallback((id: string) => {
    setHiddenState((current) => {
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      writeStore(key, next.length ? JSON.stringify(next) : null);
      return next;
    });
  }, [key]);
  const reset = useCallback(() => setHidden([]), [setHidden]);
  return { hidden, toggle, reset, setHidden };
}
