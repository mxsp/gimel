import { Button } from "@blueprintjs/core";
import { ReactNode, useId, useState } from "react";
import { useDetail } from "./detail";

/* Ein Stück Bildschirm, das in „Einfach" erst auf Klick erscheint. In „Alles"
   steht es wie bisher da. Nichts verschwindet: der Knopf sagt, was dahinter liegt.

   `hide` statt Knopf: in Einfach gar nicht zeigen — nur für Dinge, die anderswo
   auf derselben Seite erreichbar sind (z. B. eine Erklärung, die auch im (i) steht). */
export default function More({ children, label = "Mehr anzeigen", less = "Weniger anzeigen", hide = false, className, inline = false }: {
  children: ReactNode;
  label?: string;
  less?: string;
  hide?: boolean;
  className?: string;
  inline?: boolean;
}) {
  const { simple } = useDetail();
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!simple) return <>{children}</>;
  if (hide) return null;
  const Tag = inline ? "span" : "div";
  return (
    <Tag className={"ui-more" + (inline ? " ui-more-inline" : "") + (className ? ` ${className}` : "")}>
      <Button small minimal className="ui-more-toggle" icon={open ? "chevron-up" : "chevron-down"}
        text={open ? less : label} aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((v) => !v)} />
      {open && <Tag id={id} className="ui-more-body">{children}</Tag>}
    </Tag>
  );
}

/** Zeigt `simple` in Einfach und `full` in Alles — für Stellen, die in Einfach knapper sind. */
export function ByDetail({ simple, full }: { simple: ReactNode; full: ReactNode }) {
  const { simple: isSimple } = useDetail();
  return <>{isSimple ? simple : full}</>;
}
