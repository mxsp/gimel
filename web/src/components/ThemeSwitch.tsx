import { Button, IconName } from "@blueprintjs/core";
import { useEffect, useState } from "react";
import { THEME_LABEL, ThemeMode, cycleMode, readMode } from "../theme";

const ICON: Record<ThemeMode, IconName> = { auto: "contrast", light: "flash", dark: "moon" };

/** Wer die Darstellung von anderswo wechselt (Suchen & springen), meldet es hierüber. */
export const THEME_EVENT = "gimel-theme";

export default function ThemeSwitch() {
  const [mode, setMode] = useState<ThemeMode>(readMode);
  useEffect(() => {
    const onChange = () => setMode(readMode());
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);
  const resolved = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dunkel" : "hell";
  const label = mode === "auto"
    ? `Darstellung: wie System (${resolved})`
    : `Darstellung: ${THEME_LABEL[mode]}`;
  return <Button minimal icon={ICON[mode]} title={label} aria-label={label} onClick={() => setMode(cycleMode())} />;
}
