import { useRef } from "react";
import { Spoken } from "./Legend";

/* Genau eine Wahl aus wenigen: Linsen und Zeitschritte. Pfeiltasten wandern,
   Tab verlässt die Gruppe (Roving Tabindex wie bei einem Radio). */

export interface RadioOption<T> { id: T; label: string; sub?: string; subSpoken?: string }

export default function RadioRow<T extends string | number>({ label, options, value, onChange, className }: {
  label: string; options: RadioOption<T>[]; value: T; onChange: (id: T) => void; className?: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const go = (index: number) => {
    const next = options[(index + options.length) % options.length];
    onChange(next.id);
    box.current?.querySelectorAll<HTMLElement>("[role=radio]")[(index + options.length) % options.length]?.focus();
  };
  return (
    <div ref={box} role="radiogroup" aria-label={label} className={"twin-radios " + (className ?? "")}>
      {options.map((o, i) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value}
          tabIndex={o.id === value ? 0 : -1} className="twin-radio"
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(i + 1); }
            else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(i - 1); }
            else if (e.key === "Home") { e.preventDefault(); go(0); }
            else if (e.key === "End") { e.preventDefault(); go(options.length - 1); }
          }}>
          <span className="twin-radio-label">{o.label}</span>
          {o.sub && <span className="twin-radio-sub">{o.subSpoken ? <Spoken word={o.sub} spoken={o.subSpoken} /> : o.sub}</span>}
        </button>
      ))}
    </div>
  );
}
