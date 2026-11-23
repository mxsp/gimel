import { Button, Checkbox, HTMLSelect } from "@blueprintjs/core";
import KeyPopover from "./KeyPopover";
import { ReactNode, useState } from "react";
import { DENSITY_LABEL, Density, readDensity, setDensity } from "./prefs";

export interface ViewColumn { id: string; label: string }

/* „Ansicht" je Seite: Spalten ein- und ausblenden, Dichte wählen. Die Wahl
   bleibt im Browser und gilt nur für diesen Bildschirm. */
export default function ViewMenu({ columns, hidden, onToggle, onReset, extra }: {
  columns: ViewColumn[];
  hidden: string[];
  onToggle: (id: string) => void;
  onReset?: () => void;
  extra?: ReactNode;
}) {
  const [density, setDensityState] = useState<Density>(() => readDensity());
  const content = (
    <div className="ui-view-panel">
      <div className="ui-view-block">
        <span className="ui-view-title">Spalten</span>
        {columns.map((column) => (
          <Checkbox
            key={column.id}
            checked={!hidden.includes(column.id)}
            label={column.label}
            onChange={() => onToggle(column.id)}
          />
        ))}
      </div>
      <div className="ui-view-block">
        <span className="ui-view-title">Zeilenhöhe</span>
        <HTMLSelect
          value={density}
          onChange={(e) => {
            const next = e.target.value as Density;
            setDensity(next);
            setDensityState(next);
          }}
          options={(["standard", "compact", "comfort"] as Density[]).map((value) => ({
            value, label: DENSITY_LABEL[value],
          }))}
        />
      </div>
      {extra && <div className="ui-view-block">{extra}</div>}
      {onReset && (
        <div className="ui-filter-actions">
          <Button small minimal icon="reset" text="Spalten zurücksetzen" onClick={onReset} />
        </div>
      )}
    </div>
  );
  return (
    <KeyPopover content={content} placement="bottom-end" minimal>
      <Button icon="eye-open" rightIcon="caret-down" text="Ansicht" />
    </KeyPopover>
  );
}
