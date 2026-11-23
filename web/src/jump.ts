import type { IconName } from "@blueprintjs/core";
import { AREAS, NAV_HOME, NavItem, visibleNav } from "./nav";
import { featureKeywordsFor } from "./modules/featureRegistry";
import { WORKER_ROUTES } from "./constants";

/* „Suchen & springen" (Aufgabe 35 B): ein Feld für alles. Seiten, Aufträge,
   Kunden, Werkstoffe und ein paar Handgriffe — statt sich den Ort in der Leiste
   zu merken. Diese Datei ist rein (kein DOM, kein Abruf) und wird in Node
   geprüft (web/jump.test.mjs); die Oberfläche liegt in components/JumpPalette.tsx.

   Die Palette zeigt nie mehr, als die Rolle über die Leiste auch öffnen darf:
   die Seitenliste kommt aus `visibleNav`, und Kunden gibt es für Werker nicht. */

export type JumpGroup = "Vorschlag" | "Seiten" | "Aufträge" | "Kunden" | "Werkstoffe" | "Aktionen";

/** Reihenfolge der Abschnitte in der Trefferliste. */
export const JUMP_GROUPS: JumpGroup[] = ["Vorschlag", "Seiten", "Aufträge", "Kunden", "Werkstoffe", "Aktionen"];

export type JumpAction = "detail" | "theme" | "help" | "assistant" | "material";

export interface JumpEntry {
  id: string;
  group: JumpGroup;
  /** Was in der Zeile steht. */
  text: string;
  /** Kennung vor dem Text, in Monospace (Auftragsnummer, Kundennummer). */
  code?: string;
  /** Kleine Angabe rechts (Bereich, Tastenkürzel, Kunde). */
  hint?: string;
  icon: IconName;
  /** Weitere Wörter, unter denen man die Zeile sucht; nie angezeigt. */
  keywords?: string;
  /** Hash-Route im Portal. */
  route?: string;
  /** Eigene Anwendung (Agent Lab, Twin Studio). */
  href?: string;
  newTab?: boolean;
  action?: JumpAction;
  /** Zusatz für die Aktion (z. B. der Suchtext für Werkstoffe). */
  arg?: string;
}

/** Klein, ohne Akzente, ß als ss: „Auftrage" findet „Aufträge", „strasse" findet „Straße". */
export function fold(text: string): string {
  return (text || "").toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const WORD = /[\s\-·/.,;:()]+/;

/** Wie gut ein Suchwort eine Zeile trifft; 0 = gar nicht. Jedes Wort der Eingabe muss treffen. */
export function jumpScore(query: string, entry: Pick<JumpEntry, "text" | "code" | "keywords">): number {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const text = fold(entry.text);
  const code = fold(entry.code ?? "");
  const keys = fold(entry.keywords ?? "");
  const words = text.split(WORD).filter(Boolean);
  const bare = (s: string) => s.replace(/[^a-z0-9]/g, "");
  let total = 0;
  for (const t of tokens) {
    let best = 0;
    if (text === t) best = 120;
    else if (text.startsWith(t)) best = 100;
    else if (words.some((w) => w.startsWith(t))) best = 70;
    else if (text.includes(t)) best = 35;
    // Kennungen: mit oder ohne Bindestrich getippt („ab260005" findet „AB-26-0005").
    if (code) {
      const tb = bare(t), cb = bare(code);
      if (code === t || (tb && cb === tb)) best = Math.max(best, 130);
      else if (code.startsWith(t) || (tb && cb.startsWith(tb))) best = Math.max(best, 95);
      else if (code.includes(t) || (tb.length >= 2 && cb.includes(tb))) best = Math.max(best, 50);
    }
    if (!best && keys && keys.split(WORD).some((w) => w.startsWith(t))) best = 20;
    if (!best) return 0;
    total += best;
  }
  return total / tokens.length;
}

/** Sortiert und kappt: beste zuerst, je Abschnitt höchstens `perGroup`, zusammen `limit`.
 *  Die Abschnitte bleiben in fester Reihenfolge, damit die Liste beim Tippen nicht springt. */
export function rankJump(query: string, entries: JumpEntry[], perGroup = 6, limit = 24): JumpEntry[] {
  const scored = entries
    .map((entry, index) => ({ entry, index, score: jumpScore(query, entry) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const out: JumpEntry[] = [];
  for (const group of JUMP_GROUPS) {
    out.push(...scored.filter((r) => r.entry.group === group).slice(0, perGroup).map((r) => r.entry));
  }
  return out.slice(0, limit);
}

/* Unter welchen Wörtern man einen Bildschirm noch sucht. Wer „Rechnung" tippt,
   meint die Buchhaltung; wer „Halle" tippt, den Grundriss. */
const PAGE_KEYWORDS: Record<string, string> = {
  heute: "start übersicht dashboard aufgaben überfällig blockiert",
  auftragserfassung: "neuer auftrag anlegen erfassen bestellung angebot",
  auftraege: "bestellungen liste status freigabe",
  disposition: "planung takt sammellauf eimer leitstand",
  arbeitsvorrat: "warteschlange reihenfolge zuordnen aufgaben stationen",
  arbeitsplaetze: "arbeitsplätze stationen maschinen plotter wasserstrahl stanze regal cockpit",
  schachteln: "nesting platten belegung lage",
  "freies-schachteln": "nesting ohne auftrag probe",
  zeichnungen: "dxf svg bibliothek konturen",
  kommissionierung: "bereitstellen material holen regal picking",
  produktion: "fertigung innenauftrag schneiden laufkarte",
  grundriss: "digitaler grundriss halle plan zwilling twin karte 3d stationen maschinen",
  roboter: "agv amr flotte fahrzeuge transporte",
  optimierung: "auslastung engpass befunde verbesserung",
  studio: "3d zwilling begehen",
  versand: "lieferung paket sendung lieferschein",
  buchhaltung: "rechnung zahlung offene posten storno",
  kunden: "kundenstamm konditionen adressen sperre",
  lager: "bestand lagerort reststücke buchung",
  werkstoffe: "material preise katalog dicken",
  formen: "hausformen bibliothek",
  benutzer: "konten rollen passwort werker",
  compliance: "datenschutz protokoll löschen auskunft",
  admin: "einstellungen kennzahlen betriebsparameter protokoll",
  lab: "assistent chat ki",
};

function pageHint(item: NavItem, role: string): string {
  const parts: string[] = [];
  if (role !== "worker" && item.area !== "beide") parts.push(AREAS.find((a) => a.area === item.area)?.label ?? "");
  if (item.newTab) parts.push("neuer Tab");
  if (item.key) parts.push(`g ${item.key}`);
  return parts.filter(Boolean).join(" · ");
}

/** Alle Bildschirme, die diese Rolle öffnen darf — auch die aus „Werkzeuge" und dem Benutzermenü. */
export function pageEntries(role: string, features: string[] | null): JumpEntry[] {
  const items = [NAV_HOME, ...visibleNav(role, features).flatMap((g) => g.items)];
  return items.map((i) => ({
    id: `page:${i.route}`, group: "Seiten" as const, text: i.label, icon: i.icon,
    hint: pageHint(i, role), keywords: PAGE_KEYWORDS[i.route] ?? featureKeywordsFor(i.route),
    ...(i.href ? { href: i.href, newTab: i.newTab } : { route: i.route }),
  }));
}

/** Handgriffe, die keine Seite sind. */
export function actionEntries(role: string, opts: { simple: boolean; assistant: boolean }): JumpEntry[] {
  const out: JumpEntry[] = [];
  if (role !== "worker") {
    out.push({ id: "act:new-order", group: "Aktionen", text: "Neuen Auftrag erfassen", icon: "add",
      keywords: "anlegen bestellung neu", route: "auftragserfassung" });
  }
  out.push({ id: "act:detail", group: "Aktionen", icon: opts.simple ? "eye-open" : "eye-off",
    text: opts.simple ? "Alles anzeigen (Detailstufe „Alles“)" : "Weniger anzeigen (Detailstufe „Einfach“)",
    keywords: "einfach alles detail ansicht mehr weniger", action: "detail" });
  out.push({ id: "act:theme", group: "Aktionen", text: "Hell / Dunkel wechseln", icon: "contrast",
    keywords: "darstellung theme dunkelmodus farbe", action: "theme" });
  if (opts.assistant) {
    out.push({ id: "act:assistant", group: "Aktionen", text: "Assistent ein- oder ausblenden", icon: "chat",
      keywords: "copilot chat frage hilfe", action: "assistant" });
  }
  out.push({ id: "act:help", group: "Aktionen", text: "Tastenkürzel anzeigen", icon: "key-command",
    keywords: "hilfe shortcuts tasten", action: "help" });
  return out;
}

/* Eine getippte Nummer führt direkt hin, auch wenn die Liste sie (noch) nicht kennt:
   AB-… ist ein Auftrag, IA-… ein Innenauftrag. Geprüft wird erst die Seite selbst. */
const DIRECT: { re: RegExp; make: (no: string, role: string) => JumpEntry | null }[] = [
  { re: /^AB-\d{2}-\d{3,}$/i, make: (no) => ({ id: `direct:${no}`, group: "Vorschlag", text: "Auftrag öffnen", code: no, icon: "inbox", route: `auftraege/${no}` }) },
  { re: /^IA-\d{2}-\d{3,}$/i, make: (no) => ({ id: `direct:${no}`, group: "Vorschlag", text: "Innenauftrag öffnen", code: no, icon: "cut", route: `produktion/${no}` }) },
];

export function directEntry(query: string, role: string): JumpEntry | null {
  const no = query.trim().toUpperCase();
  for (const d of DIRECT) if (d.re.test(no)) return d.make(no, role);
  return null;
}

/** Ohne Eingabe: die Seiten des aktuellen Bereichs zuerst, dann die Handgriffe. */
export function defaultEntries(pages: JumpEntry[], actions: JumpEntry[], max = 9): JumpEntry[] {
  return [...pages.slice(0, max), ...actions];
}

/** Darf diese Rolle Kunden suchen? Werker sehen keine Kundendaten. */
export function mayJumpCustomers(role: string): boolean {
  return role !== "worker" && role !== "";
}

/** Darf diese Rolle die Route überhaupt öffnen? Schutz gegen eine Zeile, die die Leiste nicht zeigen würde. */
export function mayOpenRoute(route: string, role: string): boolean {
  if (role !== "worker") return true;
  return WORKER_ROUTES.includes(route.split("/")[0]);
}

/** Zeile aus /api/admin/orders (`customer`) oder /api/desk/orders (`customer_name`). */
export interface JumpOrder {
  no: string; customer?: string; customer_name?: string; internal_owner?: string; kind?: string;
  status?: string; status_label?: string; customer_ref?: string;
}
export interface JumpCustomer { id: number; name?: string; company?: string; customer_no?: string; email?: string; }
export interface JumpMaterial { id: string; name: string; short?: string; brand?: string; cat?: string; }

export function orderEntries(rows: JumpOrder[]): JumpEntry[] {
  return rows.map((o) => ({
    id: `order:${o.no}`, group: "Aufträge" as const, code: o.no,
    text: o.customer || o.customer_name || (o.internal_owner ? `intern · ${o.internal_owner}` : "ohne Kunde"),
    hint: o.status_label || "", keywords: o.customer_ref, icon: "inbox" as IconName, route: `auftraege/${o.no}`,
  }));
}

export function customerEntries(rows: JumpCustomer[]): JumpEntry[] {
  return rows.map((c) => ({
    id: `customer:${c.id}`, group: "Kunden" as const, text: c.company || c.name || c.email || `Kunde ${c.id}`,
    code: c.customer_no || undefined, hint: c.company && c.name ? c.name : "", keywords: c.email,
    icon: "people" as IconName, route: `kunden/${c.id}`,
  }));
}

export function materialEntries(rows: JumpMaterial[]): JumpEntry[] {
  return rows.map((m) => ({
    id: `material:${m.id}`, group: "Werkstoffe" as const, text: m.name || m.id, code: m.id,
    hint: [m.brand, m.cat].filter(Boolean).join(" · "), keywords: m.short,
    icon: "layers" as IconName, action: "material" as const, arg: m.name || m.id,
  }));
}
