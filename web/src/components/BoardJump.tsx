/* Auf dem Telefon stehen die Spalten eines Boards untereinander. Diese Leiste
   springt zu einer Spalte, damit man nicht durch alle Karten scrollen muss.
   Am Desktop ausgeblendet (dort liegen die Spalten nebeneinander). */
export interface JumpItem { id: string; label: string; count: number }

export default function BoardJump({ items }: { items: JumpItem[] }) {
  if (items.length < 2) return null;
  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
  };
  return (
    <nav className="board-jump" aria-label="Zu einer Spalte springen">
      {items.map((i) => (
        <button key={i.id} type="button" className="board-jump-chip" onClick={() => go(i.id)}>
          <span>{i.label}</span><span className="board-jump-n">{i.count}</span>
        </button>
      ))}
    </nav>
  );
}
