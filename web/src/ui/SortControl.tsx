import { Button, ButtonGroup, HTMLSelect, Popover } from "@blueprintjs/core";
import KeyPopover from "./KeyPopover";
import { FilterGroup } from "./FilterPopover";
import type { SortField, SortState } from "./sorting";

/* Ein Sortierknopf für Listen: Feld wählen und auf- oder absteigend. Die Wahl
   bleibt im Browser; die Seite entscheidet, welche Felder sinnvoll sind. */
export default function SortControl({ state, fields, onChange, label = "Sortierung" }: {
  state: SortState;
  fields: SortField[];
  onChange: (next: SortState) => void;
  label?: string;
}) {
  const current = fields.find((f) => f.id === state.field) ?? fields[0];
  const direction = state.dir === "asc" ? "aufsteigend" : "absteigend";
  const content = (
    <div className="ui-filter-panel">
      <FilterGroup label="Sortieren nach">
        <HTMLSelect
          value={state.field}
          aria-label="Sortierfeld"
          options={fields.map((f) => ({ value: f.id, label: f.label }))}
          onChange={(e) => onChange({ ...state, field: e.currentTarget.value })}
        />
      </FilterGroup>
      <FilterGroup label="Richtung">
        <ButtonGroup fill>
          <Button
            small
            icon="sort-asc"
            text="A–Z / 0–9"
            active={state.dir === "asc"}
            aria-pressed={state.dir === "asc"}
            onClick={() => onChange({ ...state, dir: "asc" })}
          />
          <Button
            small
            icon="sort-desc"
            text="Z–A / 9–0"
            active={state.dir === "desc"}
            aria-pressed={state.dir === "desc"}
            onClick={() => onChange({ ...state, dir: "desc" })}
          />
        </ButtonGroup>
      </FilterGroup>
    </div>
  );
  return (
    <KeyPopover content={content} placement="bottom-start" minimal>
      <Button
        icon="sort"
        rightIcon="caret-down"
        text={`${label}: ${current?.label ?? ""} · ${direction}`}
        title="Sortierfeld und Richtung wählen"
      />
    </KeyPopover>
  );
}
