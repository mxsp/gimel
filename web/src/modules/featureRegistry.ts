import type { FeatureModule } from "./types";

/* Zentrale Feature-Registry für interne Portal-Module.
   Neue interne Module werden an einer einzigen Stelle registriert (statt
   App.tsx, nav.ts, pageInfo.ts, jump.ts und constants.ts einzeln zu pflegen). */

const registry = new Map<string, FeatureModule>();

export function registerFeature(mod: FeatureModule): void {
  registry.set(mod.id, mod);
}

export function unregisterFeature(id: string): void {
  registry.delete(id);
}

export function registeredFeatures(): FeatureModule[] {
  return [...registry.values()];
}

export function matchRegisteredFeature(route: string): FeatureModule | null {
  const root = route.split("/")[0];
  for (const mod of registry.values()) {
    if (mod.match ? mod.match(route) : root === mod.id) return mod;
  }
  return null;
}

export function featureInfoFor(root: string): string | undefined {
  return registry.get(root)?.info;
}

export function featureKeywordsFor(root: string): string | undefined {
  return registry.get(root)?.keywords;
}
