import { Icon, IconName } from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { navigate } from "../router";
import { cycleMode } from "../theme";
import { areaOf, WorkArea } from "../nav";
import { moduleHref, moduleIsInternalHash, useAppModules } from "../modules/externalStore";
import { useDetail } from "../ui/detail";
import { ORDER_PHASES, orderPhase } from "../status";
import { matchesMaterial, useMaterials } from "./MaterialSelect";
import { emitGlobalMaterialSearch } from "./GlobalMaterialSearch";
import { THEME_EVENT } from "./ThemeSwitch";
import {
  JUMP_GROUPS, JumpCustomer, JumpEntry, JumpOrder, actionEntries, customerEntries, defaultEntries, directEntry,
  materialEntries, mayJumpCustomers, mayOpenRoute, orderEntries, pageEntries, rankJump,
} from "../jump";

/* „Suchen & springen" (Aufgabe 35 B). Strg+K oder „/" öffnet ein Feld, das Seiten,
   Aufträge, Kunden, Werkstoffe und ein paar Handgriffe findet. Die Regeln (wer was
   sieht, wie gereiht wird) stehen in ../jump.ts.

   Bewusst kein Blueprint-Dialog: das Feld muss im selben Tastendruck den Fokus
   haben und beim Schließen sofort weg sein, damit „g a" danach wieder greift. */

export const JUMP_EVENT = "gimel-jump-open";

export function openJump(): void {
  window.dispatchEvent(new Event(JUMP_EVENT));
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

/** Das Feld in der Kopfzeile: sieht aus wie eine Eingabe, öffnet die Palette. */
export function JumpTrigger() {
  return (
    <button type="button" className="gimel-jump" onClick={openJump} aria-haspopup="dialog"
            aria-keyshortcuts={MAC ? "Meta+K /" : "Control+K /"} title="Suchen & springen (Strg+K oder /)">
      <Icon icon="search" size={14} aria-hidden="true" />
      <span className="gimel-jump-text">Suchen<span className="gimel-jump-long"> &amp; springen</span></span>
      <kbd aria-hidden="true">{MAC ? "⌘K" : "Strg K"}</kbd>
    </button>
  );
}

async function searchOrders(q: string): Promise<JumpOrder[]> {
  const query = encodeURIComponent(q);
  try {
    const r = await api<{ items: JumpOrder[] } | JumpOrder[]>(`/api/admin/orders?q=${query}&limit=8`);
    return Array.isArray(r) ? r : r.items ?? [];
  } catch {
    // Werker und ältere Server: die Liste des Auftragsbüros.
    try { return (await api<JumpOrder[]>(`/api/desk/orders?q=${query}`)).slice(0, 8); } catch { return []; }
  }
}

export default function JumpPalette({ role, features, area, assistant, onHelp, onAssistant }: {
  role: string;
  features: string[] | null;
  area: WorkArea;
  assistant: boolean;
  onHelp: () => void;
  onAssistant: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const [orders, setOrders] = useState<JumpOrder[]>([]);
  const [customers, setCustomers] = useState<JumpCustomer[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const backRef = useRef<HTMLElement | null>(null);
  const { simple, setDetail } = useDetail();
  const materials = useMaterials();
  const { modules: appModules } = useAppModules(true);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setOrders([]);
    setCustomers([]);
    const back = backRef.current;
    backRef.current = null;
    // Zurück dorthin, wo man war — aber nicht in ein Element, das es nicht mehr gibt.
    if (back && document.contains(back)) back.focus({ preventScroll: true });
  }, []);

  // Öffnen: Strg/⌘+K überall, „/" über useShortcuts (JUMP_EVENT), Klick auf das Feld.
  useEffect(() => {
    const show = () => {
      if (!backRef.current) backRef.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      // Über einem offenen Dialog bleibt die Palette zu: er hat seine eigene Aufgabe.
      if (document.body.classList.contains("bp5-overlay-open")) return;
      e.preventDefault();
      e.stopPropagation();
      show();
    };
    window.addEventListener(JUMP_EVENT, show);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener(JUMP_EVENT, show);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  // Aufträge und Kunden: erst ab zwei Zeichen und kurz nach dem letzten Tastendruck.
  useEffect(() => {
    const needle = q.trim();
    if (!open || needle.length < 2) { setOrders([]); setCustomers([]); setBusy(false); return; }
    let alive = true;
    setBusy(true);
    const timer = window.setTimeout(async () => {
      const [o, c] = await Promise.all([
        searchOrders(needle),
        mayJumpCustomers(role)
          ? api<JumpCustomer[]>(`/api/customers?q=${encodeURIComponent(needle)}&limit=8`).then((r) => r.slice(0, 8)).catch(() => [])
          : Promise.resolve([] as JumpCustomer[]),
      ]);
      if (!alive) return;
      setOrders(o);
      setCustomers(c);
      setBusy(false);
    }, 180);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [q, open, role]);

  const pages = useMemo(() => {
    const all = pageEntries(role, features);
    const existingRoutes = new Set(all.map((e) => e.route).filter(Boolean));
    const existingHrefs = new Set(all.map((e) => e.href).filter(Boolean));
    const dynamicEntries: JumpEntry[] = appModules
      .filter((m) => m.enabled && m.id !== "erp")
      .filter((m) => !existingHrefs.has(m.href) && !existingRoutes.has(`ext/${m.id}`))
      .map((m) => {
        const internal = moduleIsInternalHash(m);
        return {
          id: `ext:${m.id}`,
          group: "Seiten",
          text: m.label,
          hint: m.kind === "embedded" ? "Eingebettet" : m.group || "Modul",
          icon: (m.icon || "applications") as IconName,
          keywords: `${m.id} ${m.short_label} ${m.description} ${m.group} modul app erweiterung`,
          route: internal ? `ext/${m.id}` : undefined,
          href: internal ? undefined : moduleHref(m),
          newTab: internal ? false : m.new_tab,
        };
      });
    const combined = [...all, ...dynamicEntries];
    // Die Seiten des aktuellen Bereichs zuerst: dort will man meist hin.
    const here = (e: JumpEntry) => {
      if (!e.route) return false;
      const a = areaOf(e.route);
      return a === "beide" || a === area;
    };
    return role === "worker" ? combined : [...combined.filter(here), ...combined.filter((e) => !here(e))];
  }, [role, features, area, appModules]);
  const actions = useMemo(() => actionEntries(role, { simple, assistant }), [role, simple, assistant]);

  const results = useMemo(() => {
    const needle = q.trim();
    if (!needle) return defaultEntries(pages, actions);
    const direct = directEntry(needle, role);
    // Werkstoffe führen auf die Werkstoff-Seite; wer sie nicht öffnen darf, bekommt keine Zeile dafür.
    const mats = mayOpenRoute("werkstoffe", role)
      ? materialEntries(materials.filter((m) => matchesMaterial(needle, m)).slice(0, 6)) : [];
    // Aufträge, Kunden und Werkstoffe hat der Server bzw. der Katalog schon gefiltert; sie werden nur gereiht.
    // Der Stand heißt hier wie in der Auftragsliste (status.ts), nicht wie der Server ihn nennt.
    const labelled = orders.map((o) => ({ ...o, status_label: ORDER_PHASES[orderPhase(o as any)].label }));
    const found = [...orderEntries(labelled), ...customerEntries(customers), ...mats];
    const ranked = rankJump(needle, [...pages, ...actions]);
    const byGroup = (g: string) => [...ranked, ...found].filter((e) => e.group === g);
    // Nie mehr als die Leiste: eine Zeile, deren Seite diese Rolle nicht öffnen darf, fällt weg.
    const out = JUMP_GROUPS.flatMap((g) => byGroup(g)).filter((e) => !e.route || mayOpenRoute(e.route, role));
    const ok = direct && mayOpenRoute(direct.route!, role) ? direct : null;
    return ok && !out.some((e) => e.route === ok.route) ? [ok, ...out] : out;
  }, [q, pages, actions, orders, customers, materials, role]);

  useEffect(() => { setIndex(0); }, [q]);
  useEffect(() => { if (index >= results.length) setIndex(Math.max(0, results.length - 1)); }, [results.length, index]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, results]);

  const run = (entry: JumpEntry | undefined) => {
    if (!entry) return;
    if (entry.route && !mayOpenRoute(entry.route, role)) return;
    if (entry.action === "material" && !mayOpenRoute("werkstoffe", role)) return;
    close();
    if (entry.href) {
      if (entry.newTab) window.open(entry.href, "_blank", "noopener");
      else window.location.assign(entry.href);
    } else if (entry.route) navigate(entry.route);
    else if (entry.action === "detail") setDetail(simple ? "alles" : "einfach");
    else if (entry.action === "theme") { cycleMode(); window.dispatchEvent(new Event(THEME_EVENT)); }
    else if (entry.action === "help") onHelp();
    else if (entry.action === "assistant") onAssistant();
    else if (entry.action === "material" && entry.arg) { emitGlobalMaterialSearch(entry.arg); navigate("werkstoffe"); }
  };

  if (!open) return null;
  const active = results[index];
  let lastGroup = "";
  return createPortal(
    <div className="jump-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      {/* Ein Klick irgendwo in die Palette (Abschnittskopf, Fuß, Rand) nimmt dem Feld nie den Fokus:
          sonst griffen Esc und „g a" nicht mehr, während die Palette offen steht. */}
      <div className="jump-dialog" role="dialog" aria-modal="true" aria-label="Suchen und springen"
           onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault(); }}>
        <div className="jump-input-row">
          <Icon icon="search" size={16} aria-hidden="true" />
          <input ref={inputRef} id="global-search" className="jump-input" autoFocus type="text" value={q}
            placeholder="Seite, Auftrag, Kunde oder Werkstoff …" autoComplete="off" spellCheck={false}
            role="combobox" aria-expanded="true" aria-controls="jump-list" aria-autocomplete="list"
            aria-activedescendant={active ? `jump-${index}` : undefined} aria-label="Suchen und springen"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => (results.length ? (i + 1) % results.length : 0)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0)); }
              else if (e.key === "Home" && results.length) { e.preventDefault(); setIndex(0); }
              else if (e.key === "End" && results.length) { e.preventDefault(); setIndex(results.length - 1); }
              else if (e.key === "Enter") { e.preventDefault(); run(active); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
              // Der Fokus bleibt im Feld: die Liste bedient man mit den Pfeiltasten.
              else if (e.key === "Tab") e.preventDefault();
            }} />
          {busy && <span className="jump-busy" aria-hidden="true">sucht …</span>}
        </div>
        <ul ref={listRef} id="jump-list" className="jump-list" role="listbox" aria-label="Treffer">
          {results.length === 0 && (
            <li className="jump-empty" role="presentation">
              {busy ? "Suche läuft …" : `Nichts gefunden für „${q.trim()}“. Eine Auftragsnummer (AB-26-0001) führt direkt hin.`}
            </li>
          )}
          {results.map((e, i) => {
            const head = e.group !== lastGroup ? e.group : "";
            lastGroup = e.group;
            return (
              <li key={e.id} role="presentation">
                {head && <div className="jump-group" role="presentation">{head}</div>}
                <div id={`jump-${i}`} className="jump-item" role="option" aria-selected={i === index}
                     onMouseMove={() => { if (i !== index) setIndex(i); }}
                     onMouseDown={(ev) => ev.preventDefault()} onClick={() => run(e)}>
                  <Icon icon={e.icon} size={14} aria-hidden="true" />
                  <span className="jump-item-text">
                    {e.code && <span className="mono">{e.code}</span>}{e.text}
                  </span>
                  {e.hint && <span className="jump-item-hint">{e.hint}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="jump-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd>wählen</span>
          <span><kbd>↵</kbd>öffnen</span>
          <span><kbd>Esc</kbd>schließen</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
