/* Was die laufende Instanz über sich sagt: Demo oder echt, welche Bildschirme
   die Anwendung mitbringt. Ein Abruf je Seitenladen, von Web-App und Grundriss
   gemeinsam benutzt, deshalb ohne React.

   Fehlt ein Feld (ältere Instanz), gilt: keine Demo, Funktionen unbekannt. */

import type { AppModuleDescriptor } from "./modules/types";
import { seedModulesFromVersion } from "./modules/externalStore";

export interface AppVersion {
  demo: boolean;
  /** Der Assistent ist in dieser Instanz eingebaut (/api/agent vorhanden). */
  agent: boolean;
  /** Zugriff auf das lokale Netzwerk (Loopback / LAN) beschränkt. */
  localnetOnly: boolean;
  /** null, wenn der Abruf nichts Brauchbares geliefert hat. */
  features: string[] | null;
  /** Registrierte Kern- und semi-externe Module dieser Instanz. */
  modules?: AppModuleDescriptor[];
}

let pending: Promise<AppVersion> | null = null;

export function loadVersion(): Promise<AppVersion> {
  pending ??= fetch("/api/version")
    .then((r) => r.json())
    .then((v) => {
      const modules = Array.isArray(v?.modules) ? (v.modules as AppModuleDescriptor[]) : undefined;
      if (modules) seedModulesFromVersion(modules);
      return {
        demo: v?.demo === true,
        agent: v?.agent === true,
        localnetOnly: v?.localnet_only !== false,
        features: Array.isArray(v?.features) ? [...v.features as string[], ...(v?.vision ? ["vision"] : [])] : null,
        modules,
      };
    })
    .catch(() => ({ demo: false, agent: false, localnetOnly: true, features: null }));
  return pending;
}
