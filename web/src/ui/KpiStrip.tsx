import { Button } from "@blueprintjs/core";
import { ReactNode, useState } from "react";
import { useDetail } from "./detail";

/* Eine Zahlenleiste für alle Bildschirme (Aufgabe 35 D). Sie ersetzt stat,
   stat-card, fn-stat, flow-kpi, leitstand-kpi, context-stat und ui-facts.

   - In „Einfach" höchstens vier Zahlen, der Rest hinter „Mehr Kennzahlen".
   - Eine Zahl, hinter der eine Liste steht, führt dorthin (href oder onClick).
   - Unbekannt bleibt „unbekannt", nie 0: null/undefined/NaN werden nie zur Null. */

export type KpiTone = "none" | "success" | "warning" | "danger" | "primary";

export interface Kpi {
  /** Stabiler Schlüssel (für React und Tests). */
  id: string;
  label: ReactNode;
  /** Zahl, fertiger Text, oder null = unbekannt. */
  value: number | string | null | undefined;
  unit?: string;
  sub?: ReactNode;
  tone?: KpiTone;
  /** Kleiner Punkt vor dem Wort, als Bezug zur Legende (Klasse ui-kpi-dot-<dot>). */
  dot?: string;
  href?: string;
  onClick?: () => void;
  /** Gewählt (z. B. der passende Reiter ist offen). */
  active?: boolean;
  title?: string;
  /** Zählt in Einfach zu den ersten vier; sonst gilt die Reihenfolge. */
  primary?: boolean;
  /** Lebender Wert (z. B. ein Countdown) statt des Texts; `value` bleibt für „unbekannt". */
  display?: ReactNode;
  /** Prüfkennung am Wert (data-testid). */
  testId?: string;
  /** Größer gesetzt (die eine Zahl, auf die es ankommt). */
  hero?: boolean;
}

export const SIMPLE_KPIS = 4;

/** Anzeigetext einer Zahl: deutsch formatiert, Unbekanntes als „unbekannt". */
export function kpiText(value: Kpi["value"], unit?: string): string {
  if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) return "unbekannt";
  const text = typeof value === "number" ? value.toLocaleString("de-DE") : value;
  if (text === "") return "unbekannt";
  return unit ? `${text} ${unit}` : text;
}

/** Welche Zahlen in welcher Stufe sofort stehen: erst die als primary markierten, dann der Reihe nach. */
export function splitKpis<T extends { primary?: boolean }>(items: T[], simple: boolean, max = SIMPLE_KPIS): { shown: T[]; rest: T[] } {
  if (!simple || items.length <= max) return { shown: items, rest: [] };
  const first = items.filter((k) => k.primary);
  const others = items.filter((k) => !k.primary);
  const shown = [...first, ...others].slice(0, max);
  return { shown: items.filter((k) => shown.includes(k)), rest: items.filter((k) => !shown.includes(k)) };
}

export default function KpiStrip({ items, label = "Kennzahlen", className, inline = false, max = SIMPLE_KPIS }: {
  items: Kpi[];
  label?: string;
  className?: string;
  /** Kompakt in einer Kopfzeile (Grundriss). */
  inline?: boolean;
  max?: number;
}) {
  const { simple } = useDetail();
  const [more, setMore] = useState(false);
  const { shown, rest } = splitKpis(items, simple, max);
  const list = more ? [...shown, ...rest] : shown;
  return (
    <div className={"ui-kpis" + (inline ? " ui-kpis-inline" : "") + (className ? ` ${className}` : "")}
         role="group" aria-label={label}>
      {list.map((k) => <KpiCell key={k.id} kpi={k} />)}
      {rest.length > 0 && (
        <Button small minimal className="ui-kpi-more" icon={more ? "chevron-left" : "chevron-right"}
          text={more ? "Weniger" : `Mehr Kennzahlen (${rest.length})`} aria-expanded={more}
          onClick={() => setMore((v) => !v)} />
      )}
    </div>
  );
}

function KpiCell({ kpi: k }: { kpi: Kpi }) {
  const text = kpiText(k.value, k.unit);
  const unknown = text === "unbekannt" && k.display == null;
  const cls = "ui-kpi" + (k.tone && k.tone !== "none" ? ` ui-kpi-${k.tone}` : "")
    + (k.active ? " ui-kpi-active" : "") + (unknown ? " ui-kpi-unknown" : "")
    + (k.href || k.onClick ? " ui-kpi-link" : "") + (k.hero ? " ui-kpi-hero" : "");
  const body = <>
    <span className="ui-kpi-label">
      {k.dot && <span className={`ui-kpi-dot ui-kpi-dot-${k.dot}`} aria-hidden="true" />}
      {k.label}
    </span>
    <span className="ui-kpi-value" data-testid={k.testId}>{k.display ?? text}</span>
    {k.sub != null && k.sub !== "" && <span className="ui-kpi-sub">{k.sub}</span>}
  </>;
  if (k.href) return <a className={cls} href={k.href} title={k.title} data-kpi={k.id}>{body}</a>;
  if (k.onClick) {
    return <button type="button" className={cls} onClick={k.onClick} title={k.title} data-kpi={k.id}
      aria-pressed={k.active === undefined ? undefined : k.active}>{body}</button>;
  }
  return <div className={cls} title={k.title} data-kpi={k.id}>{body}</div>;
}
