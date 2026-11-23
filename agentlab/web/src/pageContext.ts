/* Was der Nutzer gerade sieht — für den Assistenten.
 *
 * Seiten melden mit `usePageContext` einen kleinen, strukturierten Ausschnitt
 * (Ansicht, offene Sache, Auswahl, Stellung der Ansicht, ein paar Kernzahlen).
 * Der Chat schickt ihn mit jeder Nachricht mit; der Server prüft ihn erneut und
 * gibt ihn dem Modell als *Daten*, nie als Anweisung. Es gehen nur Namen und
 * Nummern, die der Nutzer auf dem Bildschirm sieht — keine Tabelleninhalte.
 *
 * Die Datei kennt keine Seite und kein Portal: das Lab (/lab) meldet nichts
 * und bekommt dann auch keine Zeile im Chat. */

import { useEffect, useRef, useSyncExternalStore } from "react";

export type Scalar = string | number | boolean | null;

export interface ContextEntity {
  /** order | customer | station | robot | floor | workorder | material … */
  type: string;
  id?: string | number;
  label?: string;
}

export interface StarterPrompt {
  title: string;
  text: string;
  icon?: string;
}

export interface PagePart {
  /** Kurzer Name der Ansicht, z. B. „Fabrik-Twin · Halle 1 EG“. */
  title?: string;
  /** Die eine Sache, um die es auf der Seite geht (offener Auftrag, gewählte Station). */
  entity?: ContextEntity;
  /** Weitere markierte Dinge (mehrere Stationen, Treffer eines Befunds). */
  selection?: ContextEntity[];
  /** Stellung der Ansicht: Ebene, Darstellung, Zeitschritt, Filter. */
  view?: Record<string, Scalar>;
  /** Ein paar kurze Sätze, die man auf der Seite lesen kann. */
  facts?: string[];
  /** Passende Startfragen für den leeren Chat. */
  suggestions?: StarterPrompt[];
}

export interface PageContext extends PagePart {
  route: string;
  /** Wahr, sobald mindestens eine Seite etwas gemeldet hat. */
  active: boolean;
}

export const LIMITS = { text: 160, facts: 12, selection: 12, view: 24, suggestions: 4 } as const;

const parts = new Map<symbol, PagePart>();
const listeners = new Set<() => void>();
/** Werte, die sich laufend ändern (Kamera, Standpunkt) — erst beim Senden gelesen. */
const probes = new Map<symbol, () => Record<string, Scalar> | null>();
let cached: PageContext | null = null;
let cachedRoute = "";

function routeOf(): string {
  if (typeof window === "undefined") return "";
  if (window.location.pathname.startsWith("/studio")) return "studio";
  if (window.location.pathname.startsWith("/twin")) return "grundriss";
  if (window.location.pathname.startsWith("/lab")) return "lab";
  return window.location.hash.replace(/^#\/?/, "").split("?")[0];
}

function clip(value: unknown, limit: number = LIMITS.text): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function build(route: string): PageContext {
  const out: PageContext = { route, active: parts.size > 0 };
  for (const part of parts.values()) {
    if (part.title) out.title = part.title;
    if (part.entity) out.entity = part.entity;
    if (part.selection?.length) out.selection = [...(out.selection ?? []), ...part.selection];
    if (part.view) out.view = { ...(out.view ?? {}), ...part.view };
    if (part.facts?.length) out.facts = [...(out.facts ?? []), ...part.facts];
    if (part.suggestions?.length) out.suggestions = part.suggestions;
  }
  return out;
}

function snapshot(): PageContext {
  const route = routeOf();
  if (!cached || cachedRoute !== route) {
    cached = build(route);
    cachedRoute = route;
  }
  return cached;
}

function changed(): void {
  cached = null;
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  window.addEventListener("hashchange", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("hashchange", fn);
  };
}

/** Die Seite meldet, was sie zeigt. `null` meldet nichts. Ändert sich der Inhalt, wird neu gemeldet. */
export function usePageContext(part: PagePart | null): void {
  const id = useRef<symbol>(Symbol("page-context"));
  const key = part ? JSON.stringify(part) : "";
  useEffect(() => {
    if (!key) return;
    parts.set(id.current, JSON.parse(key) as PagePart);
    changed();
    return () => {
      parts.delete(id.current);
      changed();
    };
  }, [key]);
}

/** Eine Sonde für Werte, die sich in jedem Bild ändern können (Standpunkt, Blick).
 *
 *  Sie wird nicht bei jeder Bewegung in React geschrieben, sondern erst beim
 *  Senden gelesen. So kostet eine laufende Kamera keinen Neuaufbau der Seite,
 *  und der Assistent bekommt trotzdem den Stand von genau jetzt. */
export function usePageProbe(probe: () => Record<string, Scalar> | null): void {
  const id = useRef<symbol>(Symbol("page-probe"));
  const current = useRef(probe);
  current.current = probe;
  useEffect(() => {
    probes.set(id.current, () => current.current());
    return () => { probes.delete(id.current); };
  }, []);
}

function probeValues(): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const probe of probes.values()) {
    try {
      const value = probe();
      if (!value) continue;
      for (const [key, raw] of Object.entries(value)) {
        const name = clip(key, 40);
        if (!name) continue;
        if (typeof raw === "string") out[name] = clip(raw, 80);
        else if (typeof raw === "boolean") out[name] = raw;
        else if (typeof raw === "number" && Number.isFinite(raw)) out[name] = raw;
      }
    } catch { /* eine kranke Sonde darf den Chat nicht aufhalten */ }
  }
  return out;
}

/** Der aktuelle Stand — der Chat liest ihn beim Senden und zeigt ihn über dem Eingabefeld. */
export function usePageContextSnapshot(): PageContext {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function currentPageContext(): PageContext {
  const base = snapshot();
  const live = probeValues();
  if (!Object.keys(live).length) return base;
  return { ...base, view: { ...(base.view ?? {}), ...live } };
}

function entityWire(e: ContextEntity): ContextEntity | null {
  const type = clip(e?.type, 32);
  if (!type) return null;
  const out: ContextEntity = { type };
  if (e.id !== undefined && e.id !== null && e.id !== "") out.id = typeof e.id === "number" ? e.id : clip(e.id, 64);
  if (e.label) out.label = clip(e.label, 80);
  return out;
}

/** Die Form, die der Server annimmt: begrenzt und ohne Leeres. */
export function toWire(ctx: PageContext): Record<string, unknown> {
  const wire: Record<string, unknown> = { route: clip(ctx.route, 120) };
  if (ctx.title) wire.title = clip(ctx.title, 120);
  const entity = ctx.entity ? entityWire(ctx.entity) : null;
  if (entity) wire.entity = entity;
  const selection = (ctx.selection ?? []).slice(0, LIMITS.selection)
    .map(entityWire).filter((e): e is ContextEntity => e !== null);
  if (selection.length) wire.selection = selection;
  const view: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(ctx.view ?? {}).slice(0, LIMITS.view)) {
    view[clip(key, 40)] = typeof value === "string" ? clip(value, 80) : value;
  }
  // Live-Werte (Standpunkt, Blick) zuletzt: sie gelten für genau diesen Moment.
  for (const [key, value] of Object.entries(probeValues())) {
    if (Object.keys(view).length >= LIMITS.view && !(key in view)) break;
    view[key] = value;
  }
  if (Object.keys(view).length) wire.view = view;
  const facts = (ctx.facts ?? []).slice(0, LIMITS.facts).map((f) => clip(f)).filter(Boolean);
  if (facts.length) wire.facts = facts;
  return wire;
}

/** Eine Zeile für die Anzeige: „Fabrik-Twin · Station Laser 2“. */
export function contextChip(ctx: PageContext): string {
  const bits = [ctx.title || ctx.route];
  if (ctx.entity?.label) bits.push(ctx.entity.label);
  else if (ctx.selection?.length) bits.push(`${ctx.selection.length} markiert`);
  return bits.filter(Boolean).join(" · ");
}
