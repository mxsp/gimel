import { Popover, PopoverProps } from "@blueprintjs/core";
import { useCallback, useEffect, useRef, useState } from "react";

/* Popover, der sich mit der Tastatur bedienen lässt (Aufgabe 35, Design-Gate 2026-11-13).

   Blueprints Popover schließt auf Esc nur, wenn der Fokus schon im Inhalt liegt.
   Öffnet man ihn mit Enter, bleibt der Fokus aber auf dem Auslöser: Esc tat dann
   nichts, und wer hineintabbte und Esc drückte, landete mit dem Fokus auf <body>.

   Hier gilt: Esc schließt immer und gibt den Fokus an den Auslöser zurück; ein Menü
   bekommt beim Öffnen den Fokus auf den ersten Eintrag, damit die Pfeiltasten greifen.
   Sonst verhält er sich wie Blueprints Popover (gleiche Props). */
export default function KeyPopover({ isOpen, onInteraction, onOpened, onClosed, ...rest }: PopoverProps) {
  const controlled = isOpen !== undefined;
  const [own, setOwn] = useState(false);
  const open = controlled ? !!isOpen : own;
  const trigger = useRef<HTMLElement | null>(null);
  const triggerLabel = useRef<string>("");
  const content = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(false);

  /* Der Auslöser, auch wenn die Seite ihn inzwischen neu gezeichnet hat (Arbeitsvorrat
     lädt alle paar Sekunden nach): dann über sein aria-label wiedergefunden. */
  const findTrigger = (): HTMLElement | null => {
    const el = trigger.current;
    if (el && document.contains(el)) return el;
    const label = triggerLabel.current;
    if (!label) return null;
    return Array.from(document.querySelectorAll<HTMLElement>("[aria-label]")).find((x) => x.getAttribute("aria-label") === label) ?? null;
  };

  const setOpen = useCallback((next: boolean, e?: React.SyntheticEvent<HTMLElement>) => {
    if (next) {
      const el = (e?.currentTarget as HTMLElement | undefined)?.querySelector?.<HTMLElement>("button, [role=button], a") ?? (document.activeElement as HTMLElement | null);
      trigger.current = el;
      triggerLabel.current = el?.getAttribute("aria-label") ?? "";
    }
    if (!controlled) setOwn(next);
    onInteraction?.(next, e);
  }, [controlled, onInteraction]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture-Phase: vor einem Drawer darunter, der sonst mit derselben Taste zuginge.
        e.preventDefault();
        e.stopPropagation();
        returnFocus.current = true;
        setOpen(false);
        findTrigger()?.focus({ preventScroll: true });
        return;
      }
      // Pfeiltasten im Menü: Blueprints Menu bringt keine eigene Tastenführung mit.
      const box = content.current;
      if (!box || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'));
      if (!items.length) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
        : e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      e.preventDefault();
      items[next].focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // Keine Fokusfalle: sie zog den Fokus beim Schließen in den verschwindenden Inhalt zurück.
    <Popover enforceFocus={false} {...rest} isOpen={open} onInteraction={setOpen}
      onOpened={(node) => {
        content.current = node;
        // Ein Menü bekommt den Fokus auf den ersten freien Eintrag; ein Hinweistext nicht.
        const first = node.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
        first?.focus({ preventScroll: true });
        onOpened?.(node);
      }}
      onClosed={(node) => {
        // Hat ein Klick ins Menü den Fokus mitgenommen, geht er zurück an den Auslöser.
        content.current = null;
        // Nach Esc immer zurück an den Auslöser; nach einem Klick nur, wenn der Fokus sonst verloren wäre.
        const lost = !document.activeElement || document.activeElement === document.body || node.contains(document.activeElement);
        if (returnFocus.current || lost) findTrigger()?.focus({ preventScroll: true });
        returnFocus.current = false;
        onClosed?.(node);
      }} />
  );
}
