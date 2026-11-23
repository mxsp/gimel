import { Button, ButtonGroup } from "@blueprintjs/core";
import type { MapStyle } from "../sites";

/** Karte oder Luftbild. Eigene Datei, damit der Plan nicht three.js mitlädt. */
export default function MapStyleSwitch({ value, onChange, className }: { value: MapStyle; onChange: (v: MapStyle) => void; className?: string }) {
  return (
    <ButtonGroup className={className}>
      <Button small text="Karte" active={value === "map"} aria-pressed={value === "map"} onClick={() => onChange("map")} />
      <Button small text="Satellit" active={value === "satellite"} aria-pressed={value === "satellite"} onClick={() => onChange("satellite")} />
    </ButtonGroup>
  );
}
