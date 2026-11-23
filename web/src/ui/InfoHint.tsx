import { Button } from "@blueprintjs/core";
import KeyPopover from "./KeyPopover";
import { ReactNode } from "react";

/* Regeltext am Bedienelement statt als Callout auf der Seite. Ein Klick zeigt
   ihn, die Seite bleibt ruhig. */
export default function InfoHint({ text, title, label = "Hinweis" }: {
  text: ReactNode;
  title?: ReactNode;
  label?: string;
}) {
  return (
    <KeyPopover
      minimal
      placement="bottom-start"
      content={<div className="ui-hint">{title && <p className="ui-hint-title">{title}</p>}<div className="ui-hint-body">{text}</div></div>}
    >
      <Button small minimal icon="info-sign" aria-label={label} title={label} className="ui-hint-btn" />
    </KeyPopover>
  );
}

/** Ein Hinweisblock, der erst auf Klick aufgeht; für längere Regeln. */
export function HintDetails({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <details className="ui-reveal">
      <summary>{title}</summary>
      <div className="ui-reveal-body">{children}</div>
    </details>
  );
}
