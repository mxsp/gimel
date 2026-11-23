/** Das ג als Marke. Bewusst gezeichnet statt gesetzt: die Schrift auf dem
 *  Rechner soll nicht entscheiden, wie die Marke aussieht. */
export default function GimelMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="gimel-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="var(--gimel-accent)" />
      <path d="M10.5 7.5h6.5a3.5 3.5 0 0 1 3.5 3.5v14M20.5 19 11 24.5" fill="none" stroke="var(--gimel-on-accent)"
            strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
