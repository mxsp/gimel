import { Tag, TagProps } from "@blueprintjs/core";
import { ReactNode } from "react";

export type ChipTone = "none" | "primary" | "success" | "warning" | "danger";

export interface StatusItem {
  label: ReactNode;
  tone?: ChipTone;
  title?: string;
  icon?: TagProps["icon"];
}

/* Eine Zeile trägt einen Hauptzustand. Alles Weitere steckt hinter „+N" und
   erscheint als Aufzählung, nicht als fünf gleich laute Etiketten. */
export default function StatusChip({ primary, extras = [], empty = "—" }: {
  primary?: StatusItem | null;
  extras?: Array<StatusItem | null | false | undefined>;
  empty?: ReactNode;
}) {
  const rest = extras.filter((x): x is StatusItem => !!x);
  if (!primary && rest.length === 0) return <span className="ui-status-empty">{empty}</span>;
  return (
    <span className="ui-status">
      {primary && <Tag minimal intent={primary.tone ?? "none"} title={primary.title} icon={primary.icon}>{primary.label}</Tag>}
      {rest.length > 0 && (
        <span className="ui-status-more" title={rest.map((r) => typeof r.label === "string" ? r.label : "").filter(Boolean).join(" · ")}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/** Hauptzustand und Zusätze aus einfachen Kennzeichen bauen. */
export function statusFromFlags(flags: Array<{ label: string; tone?: ChipTone; on: boolean; title?: string }>): {
  primary?: StatusItem;
  extras: StatusItem[];
} {
  const on = flags.filter((f) => f.on).map(({ on: _on, ...rest }) => rest);
  return { primary: on[0], extras: on.slice(1) };
}
