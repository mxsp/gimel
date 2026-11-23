import { Button } from "@blueprintjs/core";
import { useEffect, useState } from "react";
import { readFlag, writeFlag } from "../ui/detail";

/* „Erste Schritte" auf Heute (Aufgabe 35 G): je Rolle drei Schritte mit Link.
   Wer die Karte schließt, sieht sie in diesem Browser nicht wieder; das
   Benutzermenü holt sie zurück. */

export const FIRST_STEPS_KEY = "gimel-first-steps-hidden";
export const FIRST_STEPS_EVENT = "gimel-first-steps";

export interface Step { href: string; title: string; text: string }

export const FIRST_STEPS: Record<"admin" | "staff" | "worker", Step[]> = {
  admin: [
    { href: "/twin/#/admin", title: "Halle einrichten", text: "Umriss, Stationen, Gänge und Tore zeichnen." },
    { href: "#/benutzer", title: "Konten anlegen", text: "Personal und Werker mit ihrer Rolle." },
    { href: "#/auftragserfassung", title: "Ersten Auftrag erfassen", text: "Kunde, Positionen, Termin." },
  ],
  staff: [
    { href: "#/auftragserfassung", title: "Auftrag erfassen", text: "Kunde, Positionen, Termin, Schritt für Schritt." },
    { href: "#/disposition", title: "Disposition ansehen", text: "Was als Nächstes geschnitten wird und warum." },
    { href: "/twin/", title: "Halle im Blick", text: "Zustand jeder Station und was zu entscheiden ist." },
  ],
  worker: [
    { href: "#/kommissionierung", title: "Material bereitstellen", text: "Welche Platten an welche Maschine müssen." },
    { href: "#/produktion", title: "Fertigen", text: "Innenauftrag starten und fertig melden." },
    { href: "/twin/", title: "Station finden", text: "Im Grundriss die eigene Station öffnen." },
  ],
};

export function showFirstStepsAgain(): void {
  writeFlag(FIRST_STEPS_KEY, false);
  try { window.dispatchEvent(new Event(FIRST_STEPS_EVENT)); } catch { /* ohne Fenster */ }
}

export default function FirstSteps({ role, hasData = false }: { role: "admin" | "staff" | "worker"; hasData?: boolean }) {
  const [choice, setChoice] = useState<boolean | null>(() => readFlag(FIRST_STEPS_KEY));
  useEffect(() => {
    const back = () => setChoice(readFlag(FIRST_STEPS_KEY));
    window.addEventListener(FIRST_STEPS_EVENT, back);
    return () => window.removeEventListener(FIRST_STEPS_EVENT, back);
  }, []);
  // Sobald echte Aufträge existieren, blenden wir die Einstiegskarte automatisch aus —
  // außer sie wurde ausdrücklich über das Benutzermenü wieder eingeblendet (choice === false).
  const hidden = choice === true || (choice === null && hasData);
  if (hidden) return null;
  const steps = FIRST_STEPS[role];
  return (
    <section className="ui-first-steps" aria-labelledby="first-steps-title">
      <h2 id="first-steps-title">Erste Schritte</h2>
      <Button small minimal icon="cross" className="ui-first-steps-close" aria-label="Erste Schritte ausblenden"
        title="Ausblenden (über das Benutzermenü wieder zu zeigen)"
        onClick={() => { writeFlag(FIRST_STEPS_KEY, true); setChoice(true); }} />
      <ol>
        {steps.map((s) => (
          <li key={s.href}>
            <a href={s.href} target={s.href.startsWith("/") ? "_blank" : undefined} rel={s.href.startsWith("/") ? "noopener" : undefined}>{s.title}</a>
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
