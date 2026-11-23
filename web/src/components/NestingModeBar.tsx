import { Icon, IconName } from "@blueprintjs/core";

export type NestingMode = "schachteln" | "freies-schachteln" | "zeichnungen";

const MODES: Array<{ id: NestingMode; label: string; icon: IconName }> = [
  { id: "schachteln", label: "Auftrags-Schachteln", icon: "grid-view" },
  { id: "freies-schachteln", label: "Freies Schachteln", icon: "widget" },
  { id: "zeichnungen", label: "Zeichnungen", icon: "polygon-filter" },
];

/** Verbindet die drei Teile der Schachtel- und Konturlogik unter einer Leiste. */
export default function NestingModeBar({ active }: { active: NestingMode }) {
  return (
    <div className="subnav-bar" role="navigation" aria-label="Schachtel-Ansichten">
      <div className="subnav-tabs">
        {MODES.map((m) => (
          <a
            key={m.id}
            href={`#/${m.id}`}
            className="subnav-tab"
            aria-current={active === m.id ? "page" : undefined}
          >
            <Icon icon={m.icon} size={13} aria-hidden="true" />
            <span>{m.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
