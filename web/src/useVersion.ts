import { useEffect, useState } from "react";
import { AppVersion, loadVersion } from "./version";

/** null, solange die Instanz noch nicht geantwortet hat. */
export function useVersion(): AppVersion | null {
  const [version, setVersion] = useState<AppVersion | null>(null);
  useEffect(() => { loadVersion().then(setVersion); }, []);
  return version;
}
