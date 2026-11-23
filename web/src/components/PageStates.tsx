import { Button, Spinner } from "@blueprintjs/core";
import { ReactNode } from "react";
import NonIdealState from "./NonIdealState";

/* Die drei Zustände, die jede Seite gleich zeigt: lädt, Fehler, leer.
   „Lädt" reserviert die Höhe von Titel und Untertitel, damit nichts springt,
   wenn die Seite da ist. */

export function PageLoading({ title = true }: { title?: boolean }) {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      {title && <><div className="skel skel-title" aria-hidden="true" /><div className="skel skel-sub" aria-hidden="true" /></>}
      <div className="page-loading-spin"><Spinner size={30} /></div>
      <span className="sr-only">Wird geladen …</span>
    </div>
  );
}

/** Ein Abschnitt lädt (Tabelle, Liste): gleiche Höhe wie ein kleiner Leerzustand. */
export function SectionLoading() {
  return (
    <div className="section-loading" role="status" aria-live="polite">
      <Spinner size={26} /><span className="sr-only">Wird geladen …</span>
    </div>
  );
}

export function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert">
      <NonIdealState icon="error" title="Konnte nicht geladen werden" description={message}
        action={<Button icon="refresh" text="Erneut versuchen" onClick={onRetry} />} />
    </div>
  );
}

/** Kleiner Leerzustand für Abschnitte unter einer Überschrift. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="empty-note">{children}</p>;
}
