import { InputGroup, Menu, MenuItem, Spinner } from "@blueprintjs/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { matchesMaterial, useMaterials } from "./MaterialSelect";
import { navigate } from "../router";

/* Globale Suche — nur Werkstoffe.
   Sitzt in der Kopfzeile und sucht ausschliesslich im Werkstoffkatalog
   (Name, Kürzel, Marke, Gruppe, Kennung — gleiche Logik wie MaterialSelect).
   Auswahl springt auf die Werkstoff-Matrix und setzt dort den Filter,
   damit man vom Treffer direkt im Stammdatum landet. */

export const GLOBAL_MATERIAL_SEARCH_EVENT = "gimel:global-material-search";

export function emitGlobalMaterialSearch(query: string): void {
  try {
    sessionStorage.setItem("gimel-material-query", query);
  } catch { /* privater Modus — Event trägt die Suche allein */ }
  window.dispatchEvent(new CustomEvent<string>(GLOBAL_MATERIAL_SEARCH_EVENT, { detail: query }));
}

export function consumeGlobalMaterialSearch(): string {
  try {
    const q = sessionStorage.getItem("gimel-material-query") ?? "";
    sessionStorage.removeItem("gimel-material-query");
    return q;
  } catch {
    return "";
  }
}

export default function GlobalMaterialSearch() {
  const materials = useMaterials();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => {
    const needle = q.trim();
    if (!needle) return [];
    return materials.filter((m) => matchesMaterial(needle, m)).slice(0, 8);
  }, [q, materials]);

  useEffect(() => { setHighlight(0); }, [q]);

  // Klick ausserhalb schliesst die Trefferliste.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open ]);

  const go = (query: string) => {
    const needle = query.trim();
    if (!needle) return;
    setOpen(false);
    setQ(needle);
    emitGlobalMaterialSearch(needle);
    navigate("werkstoffe");
    // Falls man bereits auf Werkstoffe steht, löst navigate keinen
    // Hash-Wechsel aus — das Event oben trägt den Filter trotzdem hin.
  };

  return (
    <div ref={boxRef} className="global-search" role="search" aria-label="Werkstoffsuche">
      <InputGroup
        id="global-search"
        leftIcon="search"
        placeholder="Werkstoff suchen"
        aria-label="Werkstoff suchen"
        aria-keyshortcuts="/"
        rightElement={<kbd className="global-search-key" aria-hidden="true">/</kbd>}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && hits.length > 0) {
            e.preventDefault();
            setHighlight((h) => (h + 1) % hits.length);
          } else if (e.key === "ArrowUp" && hits.length > 0) {
            e.preventDefault();
            setHighlight((h) => (h - 1 + hits.length) % hits.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (open && hits[highlight]) go(hits[highlight].name || hits[highlight].id);
            else go(q);
          } else if (e.key === "Escape") {
            if (open && q.trim()) setOpen(false);
            else e.currentTarget.blur();
          }
        }}
        className="global-search-input"
      />
      {open && q.trim() && (
        <div className="global-search-pop">
          {materials.length === 0 ? (
            <div className="global-search-loading"><Spinner size={16} /> Katalog wird geladen …</div>
          ) : hits.length === 0 ? (
            <Menu>
              <MenuItem disabled text="Kein Werkstoff passt dazu." />
              <MenuItem
                icon="arrow-right"
                text={`Trotzdem in Werkstoffe übernehmen: „${q.trim()}“`}
                onClick={() => go(q)}
              />
            </Menu>
          ) : (
            <Menu>
              {hits.map((m, i) => (
                <MenuItem
                  key={m.id}
                  active={i === highlight}
                  text={m.name || m.id}
                  label={`${m.eur_m2.toFixed(2).replace(".", ",")} €/m²`}
                  title={m.short || m.id}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => go(m.name || m.id)}
                >
                  <span className="sub">
                    {[m.brand, m.cat].filter(Boolean).join(" · ")}
                    <span className="mono"> · {m.id}</span>
                  </span>
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
      )}
    </div>
  );
}
