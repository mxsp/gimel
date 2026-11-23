import { IconName } from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { WORKER_ROUTES } from "./constants";
import { registeredFeatures } from "./modules/featureRegistry";
import { navigate } from "./router";

/* Die Navigation folgt dem Weg eines Auftrags durch das Haus: rein, sammeln,
   planen, herausholen, fertigen, versenden, abrechnen. Kommissionierung steht
   deshalb vor der Arbeit und die Buchhaltung hinter dem Versand. */

/** Zwei Arbeitsbereiche, eine Anwendung: der Bereich folgt aus der Route.
 *  „beide": die Route gehört in beide Bereiche und lässt den aktuellen stehen. */
export type WorkArea = "buero" | "leitstand";
export type NavArea = WorkArea | "beide";

export interface NavItem {
  route: string;
  label: string;
  icon: IconName;
  area: NavArea;
  /** Gruppenname im Leitstand, wenn die Route in beiden Bereichen steht und dort anders gruppiert ist. */
  leitstandGroup?: string;
  /** Gruppenname in der Werker-Leiste, falls sie dort in einer anderen Gruppe steht. */
  workerGroup?: string;
  /** Zweite Taste nach „g". */
  key?: string;
  adminOnly?: boolean;
  /** Steht nicht in der Werker-Leiste, auch wenn die Route für Werker offen ist. */
  hideFromWorkers?: boolean;
  /** Bildschirm, den nur eine Anwendung mitbringt (/api/version → features). */
  feature?: string;
  /** Echter Link statt Hash-Route — für eine eigene Anwendung wie das Agent Lab. */
  href?: string;
  /** In einem neuen Tab öffnen, damit das Portal stehen bleibt. */
  newTab?: boolean;
  /** Seltener gebrauchtes Werkzeug: steht in der zugeklappten Gruppe „Werkzeuge" (Aufgabe 35 B). */
  tool?: boolean;
  /** Verwaltung oder externe Assistenz: steht im Benutzermenü oben rechts statt in der Leiste. Route und Taste bleiben. */
  menu?: boolean;
  /** Unteransicht einer Hauptseite (z. B. Reiter in Schachteln/Arbeitsvorrat) oder bereits im AppSwitcher:
   *  bleibt über Suche (Strg+K), Tastenkürzel und Deep Link erreichbar, ohne die Seitenleiste zu doppeln. */
  subview?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  /** Zugeklappte Gruppe; geht von selbst auf, wenn eine ihrer Routen offen ist. */
  collapsible?: boolean;
}

export const TOOLS_LABEL = "Werkzeuge";

export const NAV_HOME: NavItem = { route: "heute", label: "Heute", icon: "calendar", area: "beide", key: "h" };

export const NAV_GROUPS: NavGroup[] = [
  { label: "Auftragsweg", items: [
    { route: "auftragserfassung", label: "Auftragserfassung", icon: "new-drawing", area: "buero", key: "e" },
    { route: "auftraege", label: "Aufträge", icon: "inbox", area: "beide", leitstandGroup: "Planung & Logik", workerGroup: "Fertigung", key: "a" },
    { route: "versand", label: "Versand", icon: "truck", area: "beide", leitstandGroup: "Fertigung", workerGroup: "Fertigung", key: "v" },
    { route: "buchhaltung", label: "Buchhaltung", icon: "euro", area: "buero", key: "r" },
    { route: "kalender", label: "Kalender", icon: "calendar", area: "buero", key: "y" },
  ] },
  { label: "Planung & Logik", items: [
    { route: "disposition", label: "Disposition", icon: "time", area: "leitstand", key: "d" },
    { route: "schachteln", label: "Schachteln", icon: "grid-view", area: "leitstand", key: "s" },
    { route: "freies-schachteln", label: "Freies Schachteln", icon: "widget", area: "leitstand", key: "j", hideFromWorkers: true, subview: true },
    { route: "zeichnungen", label: "Zeichnungen", icon: "polygon-filter", area: "leitstand", key: "z", hideFromWorkers: true, subview: true },
  ] },
  { label: "Stationen", items: [
    { route: "arbeitsvorrat", label: "Arbeitsvorrat", icon: "sort-numerical", area: "leitstand", key: "o" },
    { route: "arbeitsplaetze", label: "Arbeitsplätze", icon: "desktop", area: "leitstand", key: "b", subview: true },
    { route: "optimierung", label: "Optimierung", icon: "flame", area: "leitstand", key: "i", hideFromWorkers: true, subview: true },
    { route: "grundriss", label: "Grundriss", icon: "layout", area: "leitstand", workerGroup: "Stationen", href: "/twin/", newTab: true, subview: true },
    { route: "studio", label: "Twin Studio", icon: "cube", area: "leitstand", workerGroup: "Halle", href: "/studio/", newTab: true, subview: true },
  ] },
  { label: "Fertigung", items: [
    // Kommissionieren und Bereitstellen sind ein Vorgang: Material aus dem
    // Regal an die Maschine. Deshalb ein Eintrag; „bereitstellen" bleibt als
    // alter Pfad erreichbar und zeigt auf denselben Eintrag.
    { route: "kommissionierung", label: "Kommissionierung", icon: "hand-up", area: "leitstand", key: "k" },
    { route: "produktion", label: "Produktion", icon: "cut", area: "leitstand", key: "p" },
  ] },
  { label: "Stammdaten", items: [
    { route: "kunden", label: "Kunden", icon: "people", area: "buero", key: "u" },
    { route: "lager", label: "Lager", icon: "box", area: "buero", key: "l" },
    { route: "werkstoffe", label: "Werkstoffe", icon: "layers", area: "buero", key: "w" },
    { route: "formen", label: "Formen", icon: "folder-open", area: "buero", feature: "library" },
  ] },
  { label: "Admin", items: [
    { route: "benutzer", label: "Benutzer", icon: "people", area: "buero", adminOnly: true, menu: true },
    { route: "compliance", label: "Compliance", icon: "shield", area: "buero", menu: true },
    { route: "admin", label: "Admin", icon: "cog", area: "buero", menu: true },
  ] },
  { label: "Assistenz", items: [
    { route: "lab", label: "Agent Lab", icon: "chat", area: "beide", workerGroup: "Assistenz", href: "/lab", newTab: true, subview: true },
  ] },
];

function allowed(item: NavItem, role: string, features: string[] | null): boolean {
  if (features && item.feature && !features.includes(item.feature)) return false;
  if (item.adminOnly && role !== "admin") return false;
  if (item.hideFromWorkers && role === "worker") return false;
  // Ein echter Link auf eine eigene Anwendung ist keine Hash-Route und
  // deshalb auch für Werker kein Grund, die Büro-Seiten zu prüfen.
  if (item.href) return true;
  return role !== "worker" || WORKER_ROUTES.includes(item.route);
}

/** Was diese Rolle sieht; leere Gruppen fallen weg. Solange `features` null ist
 *  (noch nicht geladen), bleibt alles stehen, damit die Liste nicht springt. */
export function visibleNav(role: string, features: string[] | null): NavGroup[] {
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: [...g.items] }));
  const existingRoutes = new Set(groups.flatMap((g) => g.items.map((i) => i.route)));
  for (const mod of registeredFeatures()) {
    if (existingRoutes.has(mod.id)) continue;
    const item: NavItem = {
      route: mod.id,
      label: mod.label,
      icon: mod.icon,
      area: mod.area,
      leitstandGroup: mod.leitstandGroup,
      workerGroup: mod.workerGroup,
      key: mod.key,
      adminOnly: mod.adminOnly,
      hideFromWorkers: mod.workerAllowed ? false : true,
      feature: mod.feature,
      subview: mod.placement === "subview",
      menu: mod.placement === "menu",
    };
    let target = groups.find((g) => g.label === mod.group);
    if (!target) {
      target = { label: mod.group, items: [] };
      groups.push(target);
    }
    target.items.push(item);
  }
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => allowed(i, role, features) || (role === "worker" && registeredFeatures().some((m) => m.id === i.route && m.workerAllowed))) }))
    .filter((g) => g.items.length > 0);
}

/** Bildschirm, den die laufende Anwendung nicht mitbringt, oder null. */
export function missingFeature(route: string, features: string[] | null): NavItem | null {
  if (!features) return null;
  const root = route.split("/")[0];
  for (const g of NAV_GROUPS) {
    for (const i of g.items) {
      if (i.route === root && i.feature && !features.includes(i.feature)) return i;
    }
  }
  return null;
}

export function sectionFor(route: string) {
  const [root, child] = route.split("/");
  // Der alte Pfad „bereitstellen" gehört zum gemeinsamen Bildschirm.
  if (root === "bereitstellen") return "kommissionierung";
  if (root === "grundriss" && ["arbeitsvorrat", "bereitstellen", "kommissionierung"].includes(child)) {
    return child === "bereitstellen" ? "kommissionierung" : child;
  }
  if (root === "grundriss" && (child === "optimierung" || child === "arbeitsplaetze")) return "arbeitsvorrat";
  if (["station", "factory", "optimierung", "arbeitsplaetze"].includes(root)) return "arbeitsvorrat";
  if (root === "freies-schachteln" || root === "zeichnungen") return "schachteln";
  return !root || root === "uebersicht" ? "heute" : root;
}

/** Stations-ID aus #/station/{id} oder #/grundriss/station/{id}, sonst null. */
export function activeStationId(route: string): string | null {
  const parts = route.split("/").filter(Boolean);
  if (parts[0] === "station" && parts[1]) return parts[1];
  if (parts[0] === "grundriss" && parts[1] === "station" && parts[2]) return parts[2];
  return null;
}

/** Der Leisteneintrag dieser Route. Optimierung ist als Reiter im Arbeitsvorrat integriert. */
export function navSection(route: string, _role: string): string {
  return sectionFor(route);
}

/** Der Bereich einer Route; was keinen Eintrag hat, landet auf Heute. */
export function areaOf(route: string): NavArea {
  const section = sectionFor(route);
  const reg = registeredFeatures().find((m) => m.id === section || (m.match && m.match(route)));
  if (reg) return reg.area;
  const item = [NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items)].find((i) => i.route === section);
  return item?.area ?? "beide";
}

function groupInOrder(order: string[], entries: Array<{ group: string; item: NavItem }>): NavGroup[] {
  const buckets = new Map<string, NavItem[]>();
  for (const label of order) buckets.set(label, []);
  for (const { group, item } of entries) {
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group)!.push(item);
  }
  return [...buckets.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

/** Die Leiste eines Bereichs. Tastenkürzel gehen über `visibleNav`, also weiter überall.
 *  Werker haben keinen Bereich und behalten ihre ganze Liste. */
export function areaNav(role: string, features: string[] | null, area: WorkArea): NavGroup[] {
  const nav = visibleNav(role, features);
  // Werker behalten eine flache Liste ohne Bereichsschalter und ohne zugeklappte Werkzeuge.
  if (role === "worker") {
    const flat = nav.flatMap((g) =>
      g.items.filter((i) => !i.menu && !i.subview).map((item) => ({ group: item.workerGroup ?? g.label, item })),
    );
    const groups = groupInOrder(["Stationen", "Fertigung", "Halle"], flat);
    const prod = groups.find((g) => g.label === "Fertigung");
    if (prod) {
      const idx = prod.items.findIndex((i) => i.route === "versand");
      if (idx >= 0 && idx < prod.items.length - 1) {
        const [ship] = prod.items.splice(idx, 1);
        prod.items.push(ship);
      }
    }
    return groups;
  }
  const inArea = (i: NavItem) => (i.area === area || i.area === "beide") && !i.menu && !i.subview;
  if (area === "buero") {
    return nav
      .map((g) => ({ ...g, items: g.items.filter((i) => inArea(i) && !i.tool) }))
      .filter((g) => g.items.length > 0);
  }
  // Leitstand: Logik & Planung klar von Stationen und Fertigung getrennt.
  const mainEntries: Array<{ group: string; item: NavItem }> = [];
  const tools: NavItem[] = [];
  for (const g of nav) {
    for (const item of g.items) {
      if (!inArea(item)) continue;
      if (item.tool) tools.push(item);
      else mainEntries.push({ group: item.leitstandGroup ?? g.label, item });
    }
  }
  // Versand steht im Leitstand am Ende von Fertigung, Aufträge am Anfang von Planung & Logik.
  const groups = groupInOrder(["Planung & Logik", "Stationen", "Fertigung", "Assistenz"], mainEntries);
  const plan = groups.find((g) => g.label === "Planung & Logik");
  if (plan) {
    const idx = plan.items.findIndex((i) => i.route === "auftraege");
    if (idx > 0) {
      const [ord] = plan.items.splice(idx, 1);
      plan.items.unshift(ord);
    }
  }
  const prod = groups.find((g) => g.label === "Fertigung");
  if (prod) {
    const idx = prod.items.findIndex((i) => i.route === "versand");
    if (idx >= 0 && idx < prod.items.length - 1) {
      const [ship] = prod.items.splice(idx, 1);
      prod.items.push(ship);
    }
  }
  if (!tools.length) return groups;
  // Die Werkzeuge stehen vor der Assistenz, die als letzte Zeile bleibt.
  const tail = groups.length && groups[groups.length - 1].label === "Assistenz" ? 1 : 0;
  return [...groups.slice(0, groups.length - tail), { label: TOOLS_LABEL, items: tools, collapsible: true },
    ...groups.slice(groups.length - tail)];
}

/** Verwaltung im Benutzermenü: was diese Rolle öffnen darf, unabhängig vom Bereich. */
export function menuNav(role: string, features: string[] | null): NavItem[] {
  return visibleNav(role, features).flatMap((g) => g.items.filter((i) => i.menu && !i.href));
}

/** Externe Anwendungen im Benutzermenü (z. B. Agent Lab), getrennt von der Verwaltung. */
export function externalMenuNav(role: string, features: string[] | null): NavItem[] {
  return visibleNav(role, features).flatMap((g) => g.items.filter((i) => i.menu && !!i.href));
}

/** Ist die Werkzeuge-Gruppe offen? Gemerkt je Browser; eine offene Route darin öffnet sie immer. */
export function toolsOpen(remembered: boolean | null, section: string, groups: NavGroup[]): boolean {
  const tools = groups.find((g) => g.collapsible);
  if (!tools) return false;
  return remembered === true || tools.items.some((i) => !i.href && i.route === section);
}

export const AREAS: { area: WorkArea; label: string; key: string; home: string }[] = [
  { area: "buero", label: "Büro", key: "1", home: "auftraege" },
  { area: "leitstand", label: "Leitstand", key: "2", home: "arbeitsvorrat" },
];

/* Gespeichert wird nur die Wurzel der Route, nie eine Auftragsnummer. Der Speicher
   kann fehlen oder werfen; dann gilt die Startseite des Bereichs. */
const areaStore = (area: WorkArea) => `gimel-area-${area}`;
const CURRENT_AREA = "gimel-area-current";

function rememberRoot(area: WorkArea, root: string): void {
  try { localStorage.setItem(areaStore(area), root); } catch { /* ohne Speicher gilt die Startseite */ }
}

function recallRoot(area: WorkArea): string | null {
  try { return localStorage.getItem(areaStore(area)); } catch { return null; }
}

function rememberArea(area: WorkArea): void {
  try { localStorage.setItem(CURRENT_AREA, area); } catch { /* dann beginnt die gemeinsame Route im Büro */ }
}

function recallArea(): WorkArea {
  try {
    const area = localStorage.getItem(CURRENT_AREA);
    return AREAS.find((a) => a.area === area)?.area ?? "buero";
  } catch { return "buero"; }
}

/** Wohin der Schalter führt: die letzte Wurzel des Bereichs, wenn diese Rolle sie noch öffnen darf. */
export function areaTarget(area: WorkArea, role: string, features: string[] | null): string {
  const root = recallRoot(area);
  const open = [NAV_HOME, ...areaNav(role, features, area).flatMap((g) => g.items),
    ...menuNav(role, features).filter((i) => i.area === area || i.area === "beide")];
  const subviews = visibleNav(role, features).flatMap((g) => g.items)
    .filter((i) => i.subview && !i.href && (i.area === area || i.area === "beide"));
  if (root && [...open, ...subviews].some((i) => !i.href && i.route === root)) return root;
  return AREAS.find((a) => a.area === area)!.home;
}

/** Der aktuelle Bereich. Eine eigene Route bestimmt ihn; eine gemeinsame lässt den
 *  letzten stehen, auch über ein Neuladen, und beginnt ohne einen letzten im Büro. */
export function useWorkArea(route: string, role: string, features: string[] | null) {
  const own = areaOf(route);
  const [chosen, setChosen] = useState<WorkArea>(() => (own === "beide" ? recallArea() : own));
  const area = own === "beide" ? chosen : own;

  // Nur am Routenwechsel: der Schalter setzt den Bereich, bevor die Route folgt.
  useEffect(() => { if (own !== "beide") setChosen(own); }, [route]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!role || role === "worker") return;
    rememberRoot(area, navSection(route, role));
    rememberArea(area);
  }, [area, route, role]);

  const goToArea = useCallback((next: WorkArea) => {
    const target = areaTarget(next, role, features);
    setChosen(next);
    navigate(target);
  }, [role, features]);

  return { area, goToArea };
}
