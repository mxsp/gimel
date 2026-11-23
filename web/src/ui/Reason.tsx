import { ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useDetail } from "./detail";

/* Eine Begründung (Aufgabe 35 E): in „Einfach" stehen höchstens `lines` Zeilen,
   der Rest geht auf Klick auf; in „Alles" steht der ganze Text. Nichts fällt weg,
   und der Knopf erscheint nur, wenn wirklich Text abgeschnitten ist. */
export default function Reason({ children, className, lines = 2, more = "Begründung anzeigen", less = "Weniger" }: {
  children: ReactNode;
  className?: string;
  lines?: number;
  more?: string;
  less?: string;
}) {
  const { simple } = useDetail();
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const clamp = simple && !open;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !clamp) return;
    // Abgeschnitten heißt: der Inhalt ist höher als der sichtbare Kasten.
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [clamp, children]);

  return (
    <div className={"ui-reason" + (className ? ` ${className}` : "")}>
      <p ref={ref} className={"ui-reason-text" + (clamp ? " is-clamped" : "")}
         style={clamp ? { WebkitLineClamp: lines } : undefined}>{children}</p>
      {simple && (cut || open) && (
        <button type="button" className="ui-reason-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? less : more}
        </button>
      )}
    </div>
  );
}
