import { Button, Menu, MenuItem } from "@blueprintjs/core";
import KeyPopover from "./KeyPopover";
import { useState } from "react";
import { DENSITY_LABEL, Density, readDensity, setDensity } from "./prefs";

const OPTIONS: Density[] = ["standard", "compact", "comfort"];

/* Zeilenhöhe für alle Bildschirme; die Wahl gilt je Browser. */
export default function DensitySwitch() {
  const [density, setState] = useState<Density>(readDensity);
  return (
    <KeyPopover
      minimal
      placement="bottom-end"
      content={
        <Menu>
          {OPTIONS.map((value) => (
            <MenuItem
              key={value}
              text={DENSITY_LABEL[value]}
              active={density === value}
              onClick={() => { setDensity(value); setState(value); }}
            />
          ))}
        </Menu>
      }
    >
      <Button minimal icon="comparison" title="Zeilenhöhe" aria-label="Zeilenhöhe" />
    </KeyPopover>
  );
}
