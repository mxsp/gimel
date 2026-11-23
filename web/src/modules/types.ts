import type { IconName } from "@blueprintjs/core";
import type { ReactNode } from "react";
import type { NavArea } from "../nav";

export type ModuleKind = "core" | "mounted" | "embedded" | "external";
export type ModulePlacement = "switcher" | "sidebar" | "menu" | "hub";
export type ModuleSource = "builtin" | "python" | "config" | "db";

/** Backend-declared module or semi-external application (from /api/modules & /api/version). */
export interface AppModuleDescriptor {
  id: string;
  label: string;
  short_label: string;
  icon: IconName | string;
  description: string;
  kind: ModuleKind;
  href: string;
  embed_url: string;
  placement: ModulePlacement;
  area: NavArea;
  group: string;
  roles: string[];
  new_tab: boolean;
  enabled: boolean;
  order: number;
  source: ModuleSource;
  editable: boolean;
}

export interface FeatureRenderContext {
  route: string;
  role: string;
  admin: boolean;
}

/** Single-file declarative definition for an internal Gimel ERP feature module.
 *  Registering a FeatureModule wires its route, sidebar/menu placement,
 *  Strg+K keywords, keyboard shortcut, and (i) help text from one place. */
export interface FeatureModule {
  id: string;
  label: string;
  icon: IconName;
  area: NavArea;
  group: string;
  leitstandGroup?: string;
  workerGroup?: string;
  placement?: "sidebar" | "subview" | "menu";
  parentSection?: string;
  key?: string;
  keywords?: string;
  /** Two-sentence German explanation shown in the (i) info popover. */
  info?: string;
  adminOnly?: boolean;
  workerAllowed?: boolean;
  feature?: string;
  match?: (route: string) => boolean;
  render: (ctx: FeatureRenderContext) => ReactNode;
}
