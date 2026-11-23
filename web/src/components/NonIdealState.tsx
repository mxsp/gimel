import { Icon, IconName } from "@blueprintjs/core";
import { ReactNode } from "react";

/* Blueprints NonIdealState setzt den Titel fest als h4 und reißt damit die
   Gliederung jeder Seite auf. Gleiche Optik mit denselben Klassen, der Titel ist
   hier aber Text: ein leerer Zustand ist kein Abschnitt. */
export default function NonIdealState({ icon, title, description, action }: {
  icon?: IconName; title?: ReactNode; description?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="bp5-non-ideal-state">
      {icon && <div className="bp5-non-ideal-state-visual"><Icon icon={icon} size={48} aria-hidden="true" /></div>}
      <div className="bp5-non-ideal-state-text">
        {title && <p className="empty-title">{title}</p>}
        {description && <div>{description}</div>}
      </div>
      {action}
    </div>
  );
}
