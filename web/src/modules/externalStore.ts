import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppModuleDescriptor } from "./types";

/* Reaktiver Speicher für Backend-registrierte und semi-externe Module (/api/modules).
   Speist AppSwitcher, JumpPalette (Strg+K), ExternalAppHost (#/ext/<id>) und
   die Verwaltungsseite Module & Apps (#/module) aus einer einzigen Quelle. */

type Listener = () => void;

const FALLBACK_MODULES: AppModuleDescriptor[] = [
  {
    id: "erp",
    label: "ERP Portal",
    short_label: "ERP",
    icon: "applications",
    description: "Aufträge, Planung, Schachteln, Arbeitsvorrat, Fertigung, Lager und Buchhaltung.",
    kind: "core",
    href: "/app/",
    embed_url: "",
    placement: "switcher",
    area: "beide",
    group: "Kernmodule",
    roles: [],
    new_tab: false,
    enabled: true,
    order: 10,
    source: "builtin",
    editable: false,
  },
  {
    id: "twin",
    label: "Twin Studio",
    short_label: "Twin",
    icon: "cube",
    description: "3D- & Semi-3D-Fabrikzwilling, Routenanalyse, Flottensimulation und Zeitstrahl.",
    kind: "mounted",
    href: "/studio/",
    embed_url: "",
    placement: "switcher",
    area: "leitstand",
    group: "Kernmodule",
    roles: [],
    new_tab: false,
    enabled: true,
    order: 20,
    source: "builtin",
    editable: false,
  },
  {
    id: "lab",
    label: "Agent Lab",
    short_label: "Lab",
    icon: "chat",
    description: "KI-Assistent, Spezialisten-Agenten, Routinen, Artefakte und Wissensgraph.",
    kind: "mounted",
    href: "/lab/",
    embed_url: "",
    placement: "switcher",
    area: "beide",
    group: "Kernmodule",
    roles: [],
    new_tab: false,
    enabled: true,
    order: 30,
    source: "builtin",
    editable: false,
  },
];

let modulesCache: AppModuleDescriptor[] = FALLBACK_MODULES;
let loaded = false;
let canManage = false;
let inflight: Promise<AppModuleDescriptor[]> | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function seedModulesFromVersion(items?: AppModuleDescriptor[] | null): void {
  if (!Array.isArray(items) || items.length === 0 || loaded) return;
  modulesCache = items;
  emit();
}

export async function refreshAppModules(includeAll = false): Promise<AppModuleDescriptor[]> {
  const path = includeAll ? "/api/modules?all=true" : "/api/modules";
  const res = await api<{ modules: AppModuleDescriptor[]; can_manage?: boolean }>(path);
  if (Array.isArray(res?.modules)) {
    modulesCache = res.modules;
    loaded = true;
    if (typeof res.can_manage === "boolean") canManage = res.can_manage;
    emit();
  }
  return modulesCache;
}

export function loadAppModulesOnce(): Promise<AppModuleDescriptor[]> {
  if (loaded) return Promise.resolve(modulesCache);
  if (inflight) return inflight;
  inflight = refreshAppModules(false)
    .catch(() => modulesCache)
    .finally(() => { inflight = null; });
  return inflight;
}

export function useAppModules(autoLoad = true): {
  modules: AppModuleDescriptor[];
  loaded: boolean;
  canManage: boolean;
} {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    if (autoLoad && !loaded) void loadAppModulesOnce();
    return () => { listeners.delete(fn); };
  }, [autoLoad]);
  return { modules: modulesCache, loaded, canManage };
}

/** Zieladresse eines Moduls: eingebettete Apps öffnen im Portal (#/ext/<id>). */
export function moduleHref(m: AppModuleDescriptor): string {
  if (m.kind === "embedded") return `#/ext/${encodeURIComponent(m.id)}`;
  return m.href || `#/ext/${encodeURIComponent(m.id)}`;
}

export function moduleIsInternalHash(m: AppModuleDescriptor): boolean {
  return m.kind === "embedded";
}

export interface ModuleDraft {
  id?: string;
  label: string;
  short_label?: string;
  icon?: string;
  description?: string;
  kind: "embedded" | "external" | "mounted";
  href: string;
  embed_url?: string;
  placement: "switcher" | "sidebar" | "menu" | "hub";
  area: "buero" | "leitstand" | "beide";
  group?: string;
  roles?: string[];
  new_tab?: boolean;
  enabled?: boolean;
  order?: number;
}

export async function createExternalModule(draft: ModuleDraft): Promise<AppModuleDescriptor> {
  const created = await api<AppModuleDescriptor>("/api/modules", {
    method: "POST",
    body: JSON.stringify(draft),
  });
  await refreshAppModules(true).catch(() => {});
  return created;
}

export async function updateExternalModule(id: string, patch: Partial<ModuleDraft>): Promise<AppModuleDescriptor> {
  const updated = await api<AppModuleDescriptor>(`/api/modules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  await refreshAppModules(true).catch(() => {});
  return updated;
}

export async function deleteExternalModule(id: string): Promise<void> {
  await api(`/api/modules/${encodeURIComponent(id)}`, { method: "DELETE" });
  await refreshAppModules(true).catch(() => {});
}
