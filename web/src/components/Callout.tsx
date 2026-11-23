import { Callout as BlueprintCallout, CalloutProps } from "@blueprintjs/core";

/* Blueprint macht aus dem Titel ein h5. Mitten in einer Seite ist das ein Sprung
   in der Gliederung; hier bleibt er fetter Text über dem Inhalt. */
export default function Callout({ title, children, ...rest }: CalloutProps) {
  return (
    <BlueprintCallout {...rest}>
      {title && <p className="callout-title">{title}</p>}
      {children}
    </BlueprintCallout>
  );
}
