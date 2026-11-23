import { Button, Icon, Menu, MenuDivider, MenuItem, Tag } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import { useState } from "react";
import { externalMenuNav, menuNav } from "../nav";
import { navigate } from "../router";
import { showFirstStepsAgain } from "./FirstSteps";
import { DENSITY_LABEL, Density, readDensity, setDensity } from "../ui/prefs";

const DENSITIES: Density[] = ["standard", "compact", "comfort"];

/* Das Benutzermenü oben rechts (Aufgabe 35 B): Verwaltung (Benutzer, Compliance,
   Admin) steht hier statt dauerhaft in der Leiste, dazu Zeilenhöhe, Tastenkürzel
   und Abmelden. Routen und Rechte bleiben dieselben. */
export default function UserMenu({ name, role, features, onHelp, onLogout }: {
  name: string;
  role: string;
  features: string[] | null;
  onHelp: () => void;
  onLogout: () => void;
}) {
  const [density, setState] = useState<Density>(readDensity);
  const admin = menuNav(role, features);
  const external = externalMenuNav(role, features);
  const roleLabel = role === "admin" ? "Admin" : role === "worker" ? "Werker" : "Personal";
  return (
    <KeyPopover minimal placement="bottom-end" content={
      <Menu className="user-menu">
        <MenuDivider title={`${name} · ${roleLabel}`} />
        {admin.length > 0 && <>
          {admin.map((i) => (
            <MenuItem key={i.route} icon={i.icon} text={i.label} onClick={() => navigate(i.route)} />
          ))}
          <MenuDivider />
        </>}
        <MenuItem icon="comparison" text="Zeilenhöhe">
          {DENSITIES.map((value) => (
            <MenuItem key={value} text={DENSITY_LABEL[value]} roleStructure="listoption" selected={density === value}
              onClick={() => { setDensity(value); setState(value); }} />
          ))}
        </MenuItem>
        <MenuItem icon="key-command" text="Tastenkürzel" label="?" onClick={onHelp} />
        <MenuItem icon="flag" text="Erste Schritte zeigen" onClick={() => { showFirstStepsAgain(); navigate("heute"); }} />
        {external.length > 0 && <>
          <MenuDivider />
          {external.map((i) => (
            <MenuItem key={i.route} icon={i.icon} text={i.label} href={i.href}
              target={i.newTab ? "_blank" : undefined} rel={i.newTab ? "noreferrer" : undefined}
              labelElement={<Icon icon="share" size={11} aria-hidden="true" />} />
          ))}
        </>}
        <MenuDivider />
        <MenuItem icon="log-out" text="Abmelden" onClick={onLogout} />
      </Menu>}>
      <Button minimal rightIcon="caret-down" className="gimel-user-btn" aria-label={`Benutzermenü: ${name}, ${roleLabel}`}
        title="Benutzermenü: Verwaltung, Zeilenhöhe, Abmelden">
        <Icon icon="user" className="gimel-user-icon" aria-hidden="true" />
        <Tag minimal className="hide-narrow" intent={role === "worker" ? "success" : "primary"}>{roleLabel}</Tag>
        <span className="gimel-bar-name hide-narrow">{name}</span>
      </Button>
    </KeyPopover>
  );
}
