import { Button, MenuItem, Spinner } from "@blueprintjs/core";
import { Select } from "@blueprintjs/select";
import type { ItemPredicate, ItemRenderer } from "@blueprintjs/select";
import { useEffect, useState, useMemo } from "react";
import { api } from "../api";

/* Werkstoffauswahl mit Suchfeld — eine Stelle für alle Masken.

   Der Katalog ist auf gut fünfzig Werkstoffe gewachsen. Ein <select> darüber
   heisst: aufklappen, scrollen, lesen, und wer „EPDM" sucht, muss wissen, dass
   der Eintrag „EPDM 65 Shore, schwarz" heisst und unter K wie KLINGER
   einsortiert ist. Hier wird stattdessen getippt — Name, Kürzel, Marke,
   Gruppe und Kennung sind alle durchsuchbar, weil im Kopf des Erfassers je
   nach Kunde ein anderes davon liegt.

   Der Katalog wird einmal je Sitzung geholt und dann geteilt: die Maske der
   Auftragserfassung baut pro Position ein solches Feld, und fünfzig
   Positionen sind sonst fünfzig gleiche Abfragen. */

export interface Material {
  id: string;
  name: string;
  short: string;
  brand: string;
  cat: string;
  eur_m2: number;
  thicknesses: number[];
  stock: number;
  lead_days: number;
}

let cache: Material[] | null = null;
let inflight: Promise<Material[]> | null = null;

function loadMaterials(): Promise<Material[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api<Material[]>("/api/products")
      .then((rows) => { cache = rows; return rows; })
      .catch(() => { inflight = null; return [] as Material[]; });
  }
  return inflight;
}

/** Der Werkstoffkatalog, einmal geholt und über alle Felder geteilt. */
export function useMaterials(): Material[] {
  const [rows, setRows] = useState<Material[]>(cache ?? []);
  useEffect(() => {
    let alive = true;
    loadMaterials().then((m) => { if (alive) setRows(m); });
    return () => { alive = false; };
  }, []);
  return rows;
}

/** Schlüssel → Name aus dem Katalog („ptfe-w" → „PTFE weiß"). Solange der Katalog
 *  lädt oder den Schlüssel nicht kennt, bleibt der Schlüssel stehen — nie ein leeres Feld. */
export function useMaterialName(): (id: string) => string {
  const rows = useMaterials();
  return useMemo(() => {
    const names = new Map(rows.map((m) => [m.id, m.name]));
    return (id: string) => names.get(id) || id;
  }, [rows]);
}

/** Der Name eines Werkstoffs an Stellen, die nur den Schlüssel kennen; der Schlüssel steht im Tooltip. */
export function MatName({ id }: { id: string }) {
  const name = useMaterialName();
  return <span title={id}>{name(id)}</span>;
}

const norm = (s: string) => (s || "").toLowerCase();

/* Jedes Wort der Eingabe muss irgendwo treffen. „klinger 4400" findet damit
   „KLINGERsil C-4400", ohne dass die Wörter in dieser Reihenfolge stehen. */
export const matchesMaterial = (query: string, m: Material): boolean => {
  const hay = norm(`${m.name} ${m.short} ${m.brand} ${m.cat} ${m.id}`);
  return query.trim().toLowerCase().split(/\s+/).every((w) => hay.includes(w));
};

const predicate: ItemPredicate<Material> = (query, m) =>
  !query.trim() || matchesMaterial(query, m);

const eur = (v: number) => `${v.toFixed(2).replace(".", ",")} €/m²`;

const thkHint = (m: Material) => {
  const t = m.thicknesses ?? [];
  if (!t.length) return "";
  return t.length === 1 ? `${t[0]} mm` : `${Math.min(...t)}–${Math.max(...t)} mm`;
};

export function materialLabel(materials: Material[], id: string): string {
  const m = materials.find((x) => x.id === id);
  return m ? (m.name || m.id) : (id || "");
}

interface Props {
  value: string;
  onChange: (id: string) => void;
  /** Eigene Liste statt des geteilten Katalogs — für Masken, die filtern. */
  materials?: Material[];
  fill?: boolean;
  small?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export default function MaterialSelect({ value, onChange, materials, fill,
                                         small, disabled, placeholder }: Props) {
  const shared = useMaterials();
  const items = materials ?? shared;
  const current = items.find((m) => m.id === value) ?? null;

  const render: ItemRenderer<Material> = (m, { handleClick, handleFocus, modifiers }) => {
    if (!modifiers.matchesPredicate) return null;
    return (
      <MenuItem key={m.id} roleStructure="listoption" active={modifiers.active}
                selected={m.id === value} onClick={handleClick} onFocus={handleFocus}
                text={m.name || m.id}
                label={eur(m.eur_m2)}
                labelClassName="mono"
                title={m.short || m.id}>
        <span className="sub">
          {[m.brand, m.cat, thkHint(m)].filter(Boolean).join(" · ")}
        </span>
      </MenuItem>
    );
  };

  return (
    <Select<Material>
      items={items}
      itemPredicate={predicate}
      itemRenderer={render}
      onItemSelect={(m) => onChange(m.id)}
      disabled={disabled || !items.length}
      fill={fill}
      resetOnClose
      popoverProps={{ minimal: true, matchTargetWidth: true }}
      inputProps={{ placeholder: "Name, Marke, Gruppe …" }}
      noResults={items.length
        ? <MenuItem disabled text="Kein Werkstoff passt dazu." roleStructure="listoption" />
        : <MenuItem disabled text={<Spinner size={16} />} roleStructure="listoption" />}
    >
      <Button fill={fill} small={small} disabled={disabled || !items.length}
              rightIcon="double-caret-vertical" alignText="left"
              className="mat-select-target"
              text={current ? (current.name || current.id)
                            : (placeholder ?? "Werkstoff wählen …")} />
    </Select>
  );
}
