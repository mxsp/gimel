/* Optionen der Planung — eine Quelle für Schachteln und Disposition.

   Die Werte stehen in `settings` und werden über `/api/admin/settings`
   gepflegt. Diese Datei ordnet sie in aufklappbare Gruppen und prüft sie vor
   dem Senden mit denselben Grenzen wie der Server (`routers/admin.py`).
   Nichts hier rechnet; die Beschriftung sagt, was der Wert bewirkt. */

export type OptionScope = "nesting" | "batch" | "all";
export type OptionKind = "number" | "select" | "boolean";

export interface OptionDef {
  key: string;
  label: string;
  kind: OptionKind;
  min?: number;
  max?: number;
  step?: number;
  /** Leer ist ein gültiger Wert und heißt „erbt" bzw. „automatisch". */
  empty?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
}

export interface OptionGroup {
  id: string;
  title: string;
  hint: string;
  scope: Exclude<OptionScope, "all">;
  fields: OptionDef[];
  /** Kurzzeile in der zugeklappten Überschrift. */
  summary: (raw: Record<string, string>) => string;
}

const bool = (raw: Record<string, string>, key: string, fallback = true) =>
  (raw[key] ?? String(fallback)) === "true";

const num = (raw: Record<string, string>, key: string) => {
  const t = (raw[key] ?? "").trim();
  return t === "" ? "" : t.replace(".", ",");
};

const ENGINE_NAMES: Record<string, string> = { kerf: "Kerf", lite: "lite", gre: "GRE" };

export const PLAN_OPTION_GROUPS: OptionGroup[] = [
  {
    id: "engine",
    title: "Rechenkern",
    scope: "nesting",
    hint: "Kerf ist die Vorgabe: echte Kontur, Löcher und freie Lagen. Er rechnet Sekunden "
      + "statt Millisekunden; lite bleibt Preis- und Vorschaukern und die Untergrenze jeder "
      + "Kerf-Lage. GRE braucht die Anwendung und wird nur im Sammellauf benutzt.",
    summary: (raw) => `${ENGINE_NAMES[(raw.nesting_engine ?? "kerf").toLowerCase()] ?? raw.nesting_engine} · jede Lage geprüft`,
    fields: [{
      key: "nesting_engine", label: "Schachtel-Motor der Fertigung", kind: "select",
      hint: "Gilt für den nächsten Lauf. Offene Innenaufträge behalten ihren Plan, bis sie neu geschachtelt werden.",
      options: [
        { value: "kerf", label: "Kerf — echte Kontur (Vorgabe)" },
        { value: "lite", label: "lite — schnell und gröber" },
        { value: "gre", label: "GRE 5.3.0 — nur mit Anwendung" },
      ],
    }],
  },
  {
    id: "kerf",
    title: "Kerf-Feinschliff",
    scope: "nesting",
    hint: "Budget in Schritten, nie in Sekunden: gleicher Korb, gleiche Einstellungen und "
      + "gleicher Startwert ergeben dieselbe Lage. Leere Felder wählt der Kern aus der "
      + "Arbeitsmenge.",
    summary: (raw) => {
      const steps = num(raw, "nest_kerf_steps");
      const cell = num(raw, "nest_kerf_cell");
      return [
        steps ? `${steps} Schritte` : "Budget automatisch",
        cell ? `Raster ${cell} mm` : "Raster automatisch",
        raw.nest_kerf_gravity === "left" ? "von links" : "von oben",
      ].join(" · ");
    },
    fields: [
      { key: "nest_kerf_steps", label: "Schritte", kind: "number", min: 4, max: 5000, step: 10,
        empty: true, hint: "Leer = aus Teilezahl und Lagen geschätzt." },
      { key: "nest_kerf_stall", label: "Stopp ohne Gewinn nach (Schritten, 0 = aus)", kind: "number",
        min: 0, max: 5000, step: 25, hint: "0 rechnet das Budget zu Ende." },
      { key: "nest_kerf_cell", label: "Rasterweite (mm)", kind: "number", min: 0.25, max: 100,
        step: 0.25, empty: true, hint: "Leer = aus Plattengröße und kleinstem Teil." },
      { key: "nest_kerf_gravity", label: "Füllen von", kind: "select", options: [
        { value: "top", label: "oberer Kante — Vorgabe" },
        { value: "left", label: "linker Kante" },
      ] },
      { key: "nest_kerf_seed", label: "Startwert", kind: "number", min: 1, max: 4_294_967_295,
        step: 1, hint: "Ein anderer Wert ist ein anderer Versuch, keine bessere Lage." },
      { key: "nest_kerf_refine", label: "Letztes Drittel auf halbem Raster verfeinern", kind: "boolean" },
    ],
  },
  {
    id: "geometry",
    title: "Abstände und Plattenrand",
    scope: "nesting",
    hint: "Nur Fertigungsmaße — kein Preis hängt daran. Leer heißt: Kerf bzw. Steg des "
      + "Werkstoffs, sonst der Kalkulationssatz.",
    summary: (raw) => {
      const gap = num(raw, "nest_gap_mm");
      const margin = num(raw, "nest_margin_mm");
      const tw = raw.nest_trim_w_mm ?? "0";
      const th = raw.nest_trim_h_mm ?? "0";
      return [
        gap ? `Abstand ${gap} mm` : "Abstand Werkstoff",
        margin ? `Rand ${margin} mm` : "Rand Werkstoff",
        (tw !== "0" || th !== "0") ? `Beschnitt ${tw}/${th} mm` : "ohne Beschnitt",
      ].join(" · ");
    },
    fields: [
      { key: "nest_gap_mm", label: "Teileabstand (mm)", kind: "number", min: 0, max: 200, step: 0.5,
        empty: true, hint: "Muss die Schnittfuge tragen. Leer = Kerf des Werkstoffs." },
      { key: "nest_margin_mm", label: "Randabstand (mm)", kind: "number", min: 0, max: 300, step: 0.5,
        empty: true, hint: "Leer = Steg des Werkstoffs." },
      { key: "nest_trim_w_mm", label: "Beschnitt Breite (mm)", kind: "number", min: 0, max: 500, step: 1,
        hint: "Für Spannkante oder beschädigten Rand." },
      { key: "nest_trim_h_mm", label: "Beschnitt Höhe (mm)", kind: "number", min: 0, max: 500, step: 1 },
      { key: "nest_corner_max_mm", label: "Eckschranke (mm)", kind: "number", min: 50, max: 10_000,
        step: 50, empty: true, hint: "Leer = keine Schranke. Kerf fällt dann auf lite zurück." },
    ],
  },
  {
    id: "search",
    title: "Suche und Drehung",
    scope: "nesting",
    hint: "Gilt für lite und GRE. Kerf dreht nach derselben Vorgabe, spiegelt aber nicht; "
      + "die Werkstoffrichtung bleibt in jedem Fall Schranke.",
    summary: (raw) => [
      bool(raw, "nest_allow_rotation") ? "Drehung an" : "Drehung aus",
      bool(raw, "nest_allow_mirror") ? "Spiegelung an" : "Spiegelung aus",
      (raw.nest_max_candidates ?? "") !== "" ? `${raw.nest_max_candidates} Saaten` : "Saaten automatisch",
    ].join(" · "),
    fields: [
      { key: "nest_max_candidates", label: "Saatordnungen (1–5)", kind: "number", min: 1, max: 5,
        step: 1, empty: true, hint: "Leer = Vorgabe des Kerns." },
      { key: "nest_max_ms", label: "Rechenzeit-Notbremse (ms)", kind: "number", min: 10, max: 600_000,
        step: 1000, empty: true, hint: "Leer = ohne. Gilt nur für lite/GRE, nicht für Kerf." },
      { key: "nest_allow_rotation", label: "Teile dürfen gedreht werden", kind: "boolean" },
      { key: "nest_allow_mirror", label: "Teile dürfen gespiegelt werden", kind: "boolean" },
    ],
  },
  {
    id: "batch",
    title: "Sammellauf",
    scope: "batch",
    hint: "Takt, Betriebsart und die Schwellen, nach denen wartende Positionen freigegeben "
      + "werden. Änderungen gelten ab dem nächsten Takt; offene Innenaufträge behalten "
      + "ihren Plan, bis sie neu geschachtelt werden.",
    summary: (raw) => [
      bool(raw, "batch_enabled") ? "aktiv" : "steht",
      `alle ${raw.batch_interval_minutes ?? "10"} min`,
      raw.batch_mode === "sofort" ? "sofort" : "sammeln",
      `voll ab ${Math.round(Number(raw.batch_min_utilisation ?? 0.7) * 100)} %`,
    ].join(" · "),
    fields: [
      { key: "batch_enabled", label: "Sammellauf aktiv", kind: "boolean" },
      { key: "batch_interval_minutes", label: "Takt (Minuten)", kind: "number", min: 1, max: 10_080, step: 5 },
      { key: "batch_mode", label: "Betriebsart", kind: "select", options: [
        { value: "sammel", label: "sammel — wartet auf eine volle Platte" },
        { value: "sofort", label: "sofort — schneidet je Auftrag" },
      ] },
      { key: "batch_group_by", label: "Auf die Platte", kind: "select", options: [
        { value: "material", label: "Kunden mischen — beste Ausnutzung" },
        { value: "customer", label: "Nur je Kunde — keine Kundenmischung" },
      ], hint: "Gilt für den nächsten Lauf. Einzelne Läufe können es im Leitstand überschreiben." },
      { key: "batch_min_parts", label: "min. Teile je Platte", kind: "number", min: 1, max: 10_000, step: 1 },
      { key: "batch_min_utilisation", label: "Platte voll ab (0–1)", kind: "number", min: 0, max: 1,
        step: 0.05, hint: "0,70 = ab 70 % der Plattenhöhe schneiden." },
      { key: "batch_max_age_minutes", label: "max. Wartezeit (min)", kind: "number", min: 0, max: 43_200, step: 60 },
      { key: "batch_due_lead_hours", label: "Vorlauf vor Zusage (h)", kind: "number", min: 0, max: 720, step: 1 },
      { key: "batch_max_plates_per_run", label: "Platten je Lauf (0 = aus)", kind: "number", min: 0, max: 500, step: 1 },
      { key: "batch_max_orders_per_work_order", label: "Aufträge je Innenauftrag (0 = aus)", kind: "number", min: 0, max: 100, step: 1 },
      { key: "batch_max_plates_per_work_order", label: "Platten je Innenauftrag (0 = aus)", kind: "number", min: 0, max: 200, step: 1 },
      { key: "batch_mixed_formats", label: "Gemischte Plattenformate je Innenauftrag", kind: "boolean" },
    ],
  },
];

export function optionGroups(scope: OptionScope): OptionGroup[] {
  return PLAN_OPTION_GROUPS.filter((g) => scope === "all" || g.scope === scope);
}

/** Leer heißt bei diesen Feldern „erbt“ und ist etwas anderes als 0. */
export function optionProblem(def: OptionDef, value: string): string | null {
  const t = value.trim();
  if (def.kind === "boolean") {
    return t === "true" || t === "false" ? null : "Schalter ist true oder false.";
  }
  if (def.kind === "select") {
    return (def.options ?? []).some((o) => o.value === t) ? null : "Ungültige Auswahl.";
  }
  if (t === "") return def.empty ? null : "Wert fehlt.";
  const x = Number(t.replace(",", "."));
  if (!Number.isFinite(x)) return "Muss eine Zahl sein.";
  const de = (v: number) => v.toLocaleString("de-DE");
  if (def.min != null && x < def.min) return `Mindestens ${de(def.min)}.`;
  if (def.max != null && x > def.max) return `Höchstens ${de(def.max)}.`;
  return null;
}
