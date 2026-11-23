import { ReactNode } from "react";

/* Eine Werkzeugleiste: Suche links, Zählung daneben, alles Weitere rechts.
   Neue Bedienelemente kommen in den Filter oder ins Ansichtsmenü, nicht in
   eine zweite Leiste. */
export default function Toolbar({ children, end, meta }: {
  children?: ReactNode;
  end?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="ui-toolbar">
      {children}
      {meta && <span className="ui-toolbar-meta">{meta}</span>}
      {end && <div className="ui-toolbar-end">{end}</div>}
    </div>
  );
}
