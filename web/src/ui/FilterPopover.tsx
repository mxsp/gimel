import { Button, Popover } from "@blueprintjs/core";
import KeyPopover from "./KeyPopover";
import { ReactNode } from "react";

/* Filter stehen nicht dauerhaft auf der Seite. Der Knopf nennt ihre Zahl, das
   Panel zeigt die Felder, und „zurücksetzen" räumt alle auf einmal ab. */
export default function FilterPopover({ active = 0, onClear, children, label = "Filter" }: {
  active?: number;
  onClear?: () => void;
  children: ReactNode;
  label?: string;
}) {
  const content = (
    <div className="ui-filter-panel">
      {children}
      {onClear && active > 0 && (
        <div className="ui-filter-actions">
          <Button small minimal icon="reset" text="Filter löschen" onClick={onClear} />
        </div>
      )}
    </div>
  );
  return (
    <KeyPopover content={content} placement="bottom-start" minimal>
      <Button
        icon="filter-list"
        rightIcon="caret-down"
        text={active > 0 ? `${label} (${active})` : label}
        intent={active > 0 ? "primary" : "none"}
      />
    </KeyPopover>
  );
}

export function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-filter-group">
      <label>{label}</label>
      {children}
    </div>
  );
}

/** Ein gesetzter Filter als entfernbarer Streifen neben dem Filterknopf. */
export function FilterTag({ label, onRemove }: { label: ReactNode; onRemove?: () => void }) {
  return (
    <span className="ui-filter-chip">
      {label}
      {onRemove && <Button small minimal icon="cross" aria-label="Filter entfernen" onClick={onRemove} />}
    </span>
  );
}
