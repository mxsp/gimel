import { Button } from "@blueprintjs/core";
import { useState } from "react";
import { Spoken } from "./Legend";
import RadioRow from "./RadioRow";
import { bandText, STEPS, TimeStep } from "./marks";

/* Schritte, kein Schieber: Es gibt nur diese vier Antworten, und jede ist eine Schätzung.
   Keine Wiedergabe und keine Vergangenheit, davon wissen wir nichts.

   `compact` (Grundriss am Schreibtisch, Aufgabe 41 F): eine Zeile — die vier Schritte
   als schmale Knöpfe und daneben die Zahl des gewählten. „Alle Zahlen" klappt die
   vier Spalten mit je ihrer Zahl auf. Tastatur und Rollen bleiben dieselben. */

export default function TimeBand({ step, onStep, open, pool, disabled, compact = false }: {
  step: TimeStep; onStep: (s: TimeStep) => void;
  open: Record<TimeStep, { minutes: number; unknown: number }>; pool: number; disabled: boolean;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (disabled) {
    return <div className={"twin-band" + (compact ? " twin-band-compact" : "")}><p className="sub">Keine Prognose: Die Planung konnte nicht geladen werden.</p></div>;
  }
  const line = !compact || expanded;
  const current = bandText(open[step], pool);
  return (
    <div className={"twin-band" + (compact ? " twin-band-compact" : "") + (compact && expanded ? " twin-band-open" : "")}>
      {compact && <span className="twin-band-label" aria-hidden="true">Zeit</span>}
      <RadioRow label="Zeitpunkt" value={step} onChange={onStep}
        options={STEPS.map((s) => {
          if (!line) return { id: s.id, label: s.label };
          const t = bandText(open[s.id], pool);
          return { id: s.id, label: s.label, sub: t.text, subSpoken: t.spoken };
        })} />
      {compact && !expanded && (
        <span className="twin-band-now" aria-live="polite">
          <Spoken word={current.text} spoken={current.spoken} />
        </span>
      )}
      {compact && (
        <Button small minimal className="twin-band-toggle" icon={expanded ? "chevron-down" : "chevron-up"}
          text={expanded ? "Eine Zeile" : "Alle Zahlen"} aria-expanded={expanded}
          title={expanded ? "Zeitleiste auf eine Zeile zuklappen" : "Die Zahl jedes Zeitpunkts zeigen"}
          onClick={() => setExpanded((v) => !v)} />
      )}
    </div>
  );
}
