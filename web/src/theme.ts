/* Hell oder dunkel: folgt dem System, bis jemand von Hand wählt. Die Wahl gilt je
   Browser. Gemeinsam für Web-App und Grundriss, deshalb ohne React.

   Blueprint will .bp5-dark an einem Vorfahren. Am body, weil Dialoge und Meldungen
   in einem Portal direkt darunter hängen. */

export type ThemeMode = "auto" | "light" | "dark";

const KEY = "gimel-theme";
export const THEME_LABEL: Record<ThemeMode, string> = { auto: "wie System", light: "hell", dark: "dunkel" };
const NEXT: Record<ThemeMode, ThemeMode> = { auto: "light", light: "dark", dark: "auto" };

export function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

function systemDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function apply(mode: ThemeMode): void {
  const dark = mode === "dark" || (mode === "auto" && systemDark());
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.body.classList.toggle("bp5-dark", dark);
}

/** Die nächste Stufe wählen und merken; gibt sie zurück. */
export function cycleMode(): ThemeMode {
  const mode = NEXT[readMode()];
  try {
    if (mode === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch { /* privater Modus: gilt bis zum Neuladen */ }
  apply(mode);
  return mode;
}

/** Vor dem ersten Rendern aufrufen. */
export function initTheme(): void {
  apply(readMode());
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => apply(readMode()));
}
