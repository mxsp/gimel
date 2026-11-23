import { useCallback, useEffect, useState } from "react";

/* Seitenleiste auf/zu und Breite — je Browser gemerkt, auf Telefonen nie von selbst offen. */

const OPEN_KEY = "gimel-copilot-open";
const WIDTH_KEY = "gimel-copilot-width";
export const MIN_W = 340;
export const MAX_W = 760;
export const DEFAULT_W = 440;
export const NARROW = "(max-width: 900px)";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* egal */ }
}

export function clampWidth(w: number): number {
  return Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
}

export function useCopilotWidth(): [number, (w: number, persist?: boolean) => void] {
  const [width, setW] = useState(() => clampWidth(Number(read(WIDTH_KEY)) || DEFAULT_W));
  const set = useCallback((w: number, persist = true) => {
    const next = clampWidth(w);
    setW(next);
    if (persist) write(WIDTH_KEY, String(next));
  }, []);
  return [width, set];
}

/** Zustand der Leiste; Strg/Cmd+Shift+A schaltet um. `enabled` false: nie offen, kein Kürzel. */
export function useCopilotDock(enabled: boolean) {
  const [open, setOpenState] = useState(
    () => read(OPEN_KEY) === "1" && !window.matchMedia(NARROW).matches,
  );
  const setOpen = useCallback((value: boolean) => {
    setOpenState(value);
    write(OPEN_KEY, value ? "1" : "0");
  }, []);
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "a") return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, toggle]);

  return { open: enabled && open, setOpen, toggle };
}
