import { useEffect } from "react";
import { navigate } from "./router";
import { AREAS, NAV_HOME, NavItem, WorkArea, visibleNav } from "./nav";

/* Tastatur: „/" öffnet „Suchen & springen", „g" und ein Buchstabe auf einen Bildschirm,
   „g 1" und „g 2" in einen Arbeitsbereich, „?" zeigt die Liste. Nie beim Tippen und nie über einem offenen Dialog.

   Die Abfrage läuft in der Capture-Phase: der Grundriss-Editor belegt „d" und
   „r" am Fenster, und das „d" aus „g d" darf dort keine Station verdoppeln. */

const CHORD_MS = 1500;

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return false;
  // Die Assistenten-Leiste ist ein eigener Arbeitsplatz: ihre Tasten gehören ihr, nicht der Seite daneben.
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='combobox'], .copilot-dock");
}

export function shortcutItems(role: string, features: string[] | null): NavItem[] {
  return [NAV_HOME, ...visibleNav(role, features).flatMap((g) => g.items)].filter((i) => i.key);
}

/** Die Bereichstasten; Werker haben keinen Bereich. */
export function areaShortcuts(role: string) {
  return role && role !== "worker" ? AREAS : [];
}

export function useShortcuts(role: string, features: string[] | null, onHelp: () => void, onArea: (area: WorkArea) => void): void {
  useEffect(() => {
    let chordUntil = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (isTyping(e.target) || document.body.classList.contains("bp5-overlay-open")) return;
      if (e.key === "/") {
        e.preventDefault();
        // „Suchen & springen" (components/JumpPalette); das Ereignis hält diese Datei frei von der Oberfläche.
        window.dispatchEvent(new Event("gimel-jump-open"));
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        onHelp();
        return;
      }
      if (Date.now() < chordUntil) {
        chordUntil = 0;
        const target = areaShortcuts(role).find((a) => a.key === e.key);
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          onArea(target.area);
          return;
        }
        const item = shortcutItems(role, features).find((i) => i.key === e.key);
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        if (item.href) {
          if (item.newTab) window.open(item.href, "_blank", "noopener");
          else window.location.href = item.href;
          return;
        }
        navigate(item.route);
        return;
      }
      if (e.key === "g") chordUntil = Date.now() + CHORD_MS;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [role, features, onHelp, onArea]);
}
