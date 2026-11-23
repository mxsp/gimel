import { useEffect } from "react";
import { Dialog, DialogBody } from "@blueprintjs/core";
import { areaShortcuts, shortcutItems } from "../useShortcuts";

/** Die Liste hinter „?": nur, was diese Rolle auch öffnen darf. */
export default function ShortcutHelp({ isOpen, onClose, role, features }: {
  isOpen: boolean; onClose: () => void; role: string; features: string[] | null;
}) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, onClose]);

  return (
    <Dialog isOpen={isOpen} onClose={onClose} canEscapeKeyClose title="Tastenkürzel" icon="key-command" style={{ width: 420, maxWidth: "calc(100vw - 32px)" }}
            onOpened={(el) => el.querySelector("button")?.focus()}>
      <DialogBody>
        <table className="shortcut-table">
          <tbody>
            <tr><td><kbd>Strg</kbd> <kbd>K</kbd> oder <kbd>/</kbd></td><td>Suchen &amp; springen: Seite, Auftrag, Kunde, Werkstoff</td></tr>
            <tr><td><kbd>Strg</kbd> <kbd>Shift</kbd> <kbd>A</kbd></td><td>Assistent</td></tr>
            <tr><td><kbd>?</kbd></td><td>Diese Liste</td></tr>
            {areaShortcuts(role).map((a) => (
              <tr key={a.area}><td><kbd>g</kbd> <kbd>{a.key}</kbd></td><td>Bereich {a.label}</td></tr>
            ))}
            {shortcutItems(role, features).map((i) => (
              <tr key={i.route}><td><kbd>g</kbd> <kbd>{i.key}</kbd></td><td>{i.label}</td></tr>
            ))}
          </tbody>
        </table>
      </DialogBody>
    </Dialog>
  );
}
