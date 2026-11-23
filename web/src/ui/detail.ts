import { useCallback, useEffect, useState } from "react";

/* Detailstufe „Einfach | Alles" (Aufgabe 35 A). Einfach zeigt je Bildschirm, was
   für den nächsten Schritt zählt; der Rest steht hinter „Mehr anzeigen". Alles ist
   der volle Bildschirm. Die Wahl gilt je Browser, nie in der Datenbank, und ohne
   Speicher (privater Modus) gilt Einfach bis zum Neuladen. */

export type Detail = "einfach" | "alles";

export const DETAIL_KEY = "gimel-detail";
export const DETAIL_EVENT = "gimel-detail";
export const DETAIL_LABEL: Record<Detail, string> = { einfach: "Einfach", alles: "Alles" };

/** Gespeicherter Wert → Stufe. Alles Unbekannte ist Einfach (die Vorgabe für alle). */
export function parseDetail(value: string | null | undefined): Detail {
  return value === "alles" ? "alles" : "einfach";
}

export function readDetail(): Detail {
  try { return parseDetail(localStorage.getItem(DETAIL_KEY)); } catch { return "einfach"; }
}

export function setDetail(value: Detail): void {
  try {
    if (value === "einfach") localStorage.removeItem(DETAIL_KEY);
    else localStorage.setItem(DETAIL_KEY, value);
  } catch { /* privater Modus: gilt bis zum Neuladen */ }
  try { document.documentElement.dataset.detail = value; } catch { /* ohne DOM (Node-Test) */ }
  try { window.dispatchEvent(new CustomEvent(DETAIL_EVENT, { detail: value })); } catch { /* ohne Fenster */ }
}

export function initDetail(): void {
  try { document.documentElement.dataset.detail = readDetail(); } catch { /* ohne DOM */ }
}

/** Die Stufe für eine Komponente; alle Komponenten folgen demselben Schalter. */
export function useDetail() {
  const [detail, setState] = useState<Detail>(readDetail);
  useEffect(() => {
    const onChange = (e: Event) => setState(parseDetail((e as CustomEvent<string>).detail));
    // Ein zweiter Tab mit derselben Anwendung schaltet mit.
    const onStorage = (e: StorageEvent) => { if (e.key === DETAIL_KEY) setState(parseDetail(e.newValue)); };
    window.addEventListener(DETAIL_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DETAIL_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const change = useCallback((next: Detail) => { setDetail(next); setState(next); }, []);
  return { detail, simple: detail === "einfach", setDetail: change };
}

/** Ein gemerkter Ja/Nein-Wert je Browser (aufgeklappt, ausgeblendet …). Ohne Speicher gilt `fallback`. */
export function readFlag(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    return v === "1" ? true : v === "0" ? false : null;
  } catch { return null; }
}

export function writeFlag(key: string, value: boolean | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value ? "1" : "0");
  } catch { /* privater Modus */ }
}
