import { StatusGlyph, DASH } from "./StationShape";
import { Certainty, STATUS_WORD, StatusKind } from "./marks";

/* Bleibt immer stehen: wer eine Form nicht kennt, soll nicht raten müssen. */

const KINDS: StatusKind[] = ["laeuft", "wartet", "frei", "voll", "ueber", "unbekannt", "inaktiv"];
const LINES: { id: Certainty; label: string }[] = [
  { id: "firm", label: "fest" }, { id: "estimated", label: "≈ geschätzt" }, { id: "unknown", label: "? unbekannt" },
];

export default function Legend() {
  return (
    <div className="twin-legend-row" role="group" aria-label="Legende">
      <ul className="twin-legend-list">
        {KINDS.map((k) => (
          <li key={k} data-legend={k}>
            <svg width={16} height={16} viewBox="-8 -8 16 16" aria-hidden="true"><StatusGlyph kind={k} /></svg>
            {STATUS_WORD[k]}
          </li>
        ))}
      </ul>
      <ul className="twin-legend-list">
        {LINES.map((l) => (
          <li key={l.id}>
            <svg width={22} height={8} aria-hidden="true">
              <line x1={1} y1={4} x2={21} y2={4} stroke="currentColor" strokeWidth={2} strokeDasharray={DASH[l.id]} />
            </svg>
            {l.id === "estimated" ? <><span aria-hidden="true">≈ </span>geschätzt</>
              : l.id === "unknown" ? <><span aria-hidden="true">? </span>unbekannt</> : l.label}
          </li>
        ))}
        <li>Balken: Last je Tageskapazität</li>
        <li>Kante links: läuft, gebucht</li>
      </ul>
    </div>
  );
}

/** Eine Schätzung im Text: sichtbar ≈, vorgelesen „geschätzt". */
export function Est({ children }: { children: React.ReactNode }) {
  return <span className="twin-est"><span aria-hidden="true">≈</span><span className="sr-only">geschätzt </span>{children}</span>;
}

/** Text mit ≈ für Vorleser umschreiben. */
export function Spoken({ word, spoken }: { word: string; spoken: string }) {
  return <><span aria-hidden="true">{word}</span><span className="sr-only">{spoken}</span></>;
}
