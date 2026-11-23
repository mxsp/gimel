import { plural } from "./plural";
import { OrderPhase, orderPhase } from "./status";

/* Der Weg eines Auftrags durch Gimel — eine gemeinsame Logik für Heute,
   Auftragsliste, Auftrags-Schublade und Filter. Rein rechnend (kein React,
   kein DOM), damit Kennzahlen, Überfälligkeit und nächster Schritt überall
   dasselbe sagen. */

export type OrderFlowStageId =
  | "eingang"
  | "freigegeben"
  | "fertigung"
  | "versandbereit"
  | "versand"
  | "abgeschlossen";

export interface OrderFlowStage {
  id: OrderFlowStageId;
  label: string;
  shortLabel: string;
  phases: OrderPhase[];
  filterKey: string;
}

export const ORDER_FLOW_STAGES: OrderFlowStage[] = [
  { id: "eingang", label: "Eingang & Klärung", shortLabel: "Eingang", phases: ["gesperrt", "wartet"], filterKey: "stage:eingang" },
  { id: "freigegeben", label: "Freigegeben", shortLabel: "Freigegeben", phases: ["freigegeben"], filterKey: "freigegeben" },
  { id: "fertigung", label: "In Fertigung", shortLabel: "Fertigung", phases: ["eingeplant", "laufend"], filterKey: "stage:fertigung" },
  { id: "versandbereit", label: "Versandbereit", shortLabel: "Versandbereit", phases: ["versandbereit"], filterKey: "versandbereit" },
  { id: "versand", label: "Im Versand", shortLabel: "Versand", phases: ["versand"], filterKey: "versand" },
  { id: "abgeschlossen", label: "Abgeschlossen", shortLabel: "Fertig", phases: ["abgeschlossen"], filterKey: "abgeschlossen" },
];

export interface FlowOrderLike {
  no?: string;
  kind?: string;
  status?: string;
  blocked?: boolean;
  released?: boolean;
  rush?: boolean;
  due_date?: string | null;
  held_at?: string | null;
  hold_reason?: string;
  cancelled_at?: string | null;
  paid?: boolean;
  invoice_no?: string;
  work_orders?: Array<{ no: string; status?: string }>;
  shipments?: Array<{ no: string; status?: string }>;
}

const DAY_MS = 86_400_000;

/** Ist der Auftrag im Haus schon abgeschlossen oder storniert? */
export function isOrderTerminal(o: FlowOrderLike): boolean {
  const phase = orderPhase(o);
  return phase === "abgeschlossen" || phase === "storniert";
}

/** Hat die Ware das Haus verlassen (oder ist der Auftrag storniert)? */
export function isOrderLeftBuilding(o: FlowOrderLike): boolean {
  const phase = orderPhase(o);
  return phase === "versand" || phase === "abgeschlossen" || phase === "storniert";
}

/** Millisekunden über der Zusage — 0 für versendete, abgeschlossene oder stornierte Aufträge. */
export function orderOverdueMs(o: FlowOrderLike, now = Date.now()): number {
  if (!o.due_date || isOrderLeftBuilding(o)) return 0;
  const due = new Date(o.due_date).getTime();
  return Number.isFinite(due) && due < now ? now - due : 0;
}

export function isOrderOverdue(o: FlowOrderLike, now = Date.now()): boolean {
  return orderOverdueMs(o, now) > 0;
}

export interface DueBadge {
  label: string;
  tone: "danger" | "warning" | "none";
  overdue: boolean;
}

/** Knappes Termin-Kennzeichen für offene Aufträge; null für erledigte oder stornierte. */
export function dueBadge(o: FlowOrderLike, now = Date.now()): DueBadge | null {
  if (!o.due_date || isOrderLeftBuilding(o)) return null;
  const due = new Date(o.due_date).getTime();
  if (!Number.isFinite(due)) return null;
  const diff = due - now;
  if (diff < 0) {
    const days = Math.max(1, Math.ceil(Math.abs(diff) / DAY_MS));
    return { label: `${plural(days, "Tag", "Tage")} überfällig`, tone: "danger", overdue: true };
  }
  const daysLeft = Math.floor(diff / DAY_MS);
  if (daysLeft === 0) return { label: "heute fällig", tone: "warning", overdue: false };
  if (daysLeft === 1) return { label: "morgen fällig", tone: "warning", overdue: false };
  if (daysLeft <= 3) return { label: `in ${daysLeft} Tagen`, tone: "none", overdue: false };
  return null;
}

/** Filtert einen Auftrag gegen Einzelphasen, Pipeline-Stufen oder Zahlungsfilter. */
export function matchesOrderFilter(o: FlowOrderLike, filter: string): boolean {
  if (!filter || filter === "alle") return true;
  const phase = orderPhase(o);
  if (filter === "aktiv") return !isOrderTerminal(o);
  if (filter === "offen") return o.kind !== "internal" && !o.paid && phase !== "storniert";
  if (filter === "bezahlt") return o.kind !== "internal" && !!o.paid;
  if (filter.startsWith("stage:")) {
    const id = filter.slice(6);
    const stage = ORDER_FLOW_STAGES.find((s) => s.id === id);
    return stage ? stage.phases.includes(phase) : true;
  }
  return phase === filter;
}

export function filterLabel(filter: string, phaseLabels: Record<OrderPhase, { label: string }>): string {
  if (filter === "aktiv") return "aktive Aufträge";
  if (filter === "offen") return "unbezahlt";
  if (filter === "bezahlt") return "bezahlt";
  if (filter.startsWith("stage:")) {
    const st = ORDER_FLOW_STAGES.find((s) => s.filterKey === filter);
    if (st) return st.label;
  }
  return phaseLabels[filter as OrderPhase]?.label ?? filter;
}

export interface OrderFlowSummary {
  stages: Array<OrderFlowStage & { count: number; urgent: number }>;
  total: number;
  active: number;
  held: number;
  cancelled: number;
  overdue: number;
  rush: number;
}

export interface ServerOrderSummary {
  total: number;
  open: number;
  overdue: number;
  eingang: number;
  wartet: number;
  freigegeben: number;
  fertigung: number;
  versandbereit: number;
  versand: number;
  fertig: number;
  gesperrt: number;
  angehalten: number;
  storniert: number;
  eilig: number;
}

/** Wandelt die SQL-Gesamtzählung aus ``/api/admin/orders/summary`` in das gemeinsame Pipeline-Format. */
export function summaryFromServer(s: ServerOrderSummary): OrderFlowSummary {
  const counts: Record<OrderFlowStageId, { count: number; urgent: number }> = {
    eingang: { count: (s.wartet ?? 0) + (s.gesperrt ?? 0), urgent: s.gesperrt ?? 0 },
    freigegeben: { count: s.freigegeben ?? 0, urgent: 0 },
    fertigung: { count: s.fertigung ?? 0, urgent: 0 },
    versandbereit: { count: s.versandbereit ?? 0, urgent: 0 },
    versand: { count: s.versand ?? 0, urgent: 0 },
    abgeschlossen: { count: s.fertig ?? 0, urgent: 0 },
  };
  return {
    stages: ORDER_FLOW_STAGES.map((st) => ({
      ...st,
      count: counts[st.id].count,
      urgent: counts[st.id].urgent,
    })),
    total: s.total ?? 0,
    active: s.open ?? 0,
    held: s.angehalten ?? 0,
    cancelled: s.storniert ?? 0,
    overdue: s.overdue ?? 0,
    rush: s.eilig ?? 0,
  };
}

/** Verdichtet eine Auftragsliste auf den sechsstufigen Auftragsweg + Sonderstände. */
export function summarizeOrderFlow(orders: FlowOrderLike[], now = Date.now()): OrderFlowSummary {
  const stages = ORDER_FLOW_STAGES.map((s) => ({ ...s, count: 0, urgent: 0 }));
  let active = 0;
  let held = 0;
  let cancelled = 0;
  let overdue = 0;
  let rush = 0;

  for (const o of orders) {
    const phase = orderPhase(o);
    const late = isOrderOverdue(o, now);
    if (late) overdue += 1;
    if (o.rush && !isOrderTerminal(o)) rush += 1;
    if (phase === "storniert") {
      cancelled += 1;
      continue;
    }
    if (phase === "angehalten") {
      held += 1;
      active += 1;
      continue;
    }
    if (phase !== "abgeschlossen") active += 1;
    const bucket = stages.find((s) => s.phases.includes(phase));
    if (bucket) {
      bucket.count += 1;
      if (late || phase === "gesperrt" || (o.rush && phase !== "abgeschlossen")) {
        bucket.urgent += 1;
      }
    }
  }
  return { stages, total: orders.length, active, held, cancelled, overdue, rush };
}

export interface NextStep {
  headline: string;
  reason: string;
  tone: "danger" | "warning" | "primary" | "success" | "none";
  ctaLabel?: string;
  ctaIcon?: "unlock" | "arrow-right" | "play" | "time" | "cut" | "truck" | "euro";
  action?: "unblock" | "release" | "resume" | "route";
  route?: string;
}

/** Ermittelt den konkreten nächsten Arbeitsschritt im Auftragsweg. */
export function nextOrderStep(o: FlowOrderLike, office: boolean): NextStep {
  const phase = orderPhase(o);
  const internal = o.kind === "internal";
  const wos = o.work_orders ?? [];
  const runningWo = wos.find((w) => w.status === "running");
  const openWo = wos.find((w) => w.status === "open") ?? wos[0];
  const ship = o.shipments?.[0];

  if (phase === "storniert") {
    return {
      headline: "Auftrag ist storniert",
      reason: "Keine weiteren Schritte im Auftragsweg. Für denselben Bedarf kann der Auftrag erneut bestellt werden.",
      tone: "none",
    };
  }
  if (phase === "angehalten") {
    return {
      headline: "Auftrag ist angehalten",
      reason: office
        ? "Der Sammellauf lässt diesen Auftrag liegen, bis das Büro ihn fortsetzt."
        : "Vom Büro angehalten — warten auf Freigabe zur Fortsetzung.",
      tone: "warning",
      ctaLabel: office ? "Fortsetzen" : undefined,
      ctaIcon: office ? "play" : undefined,
      action: office ? "resume" : undefined,
    };
  }
  if (phase === "gesperrt") {
    return {
      headline: "Klärung nötig — Auftrag ist gesperrt",
      reason: office
        ? "Preisabweichung oder Übergröße prüfen und bei Freigabe die Sperre ausdrücklich aufheben."
        : "Wartet auf Klärung und Entsperrung durch das Büro.",
      tone: "danger",
      ctaLabel: office ? "Sperre aufheben" : undefined,
      ctaIcon: office ? "unlock" : undefined,
      action: office ? "unblock" : undefined,
    };
  }
  if (phase === "wartet") {
    return {
      headline: "Wartet auf Freigabe für die Fertigung",
      reason: office
        ? "Erst nach der Freigabe nimmt der Sammellauf die Positionen auf eine Platte."
        : "Das Büro muss den Auftrag zuerst für die Fertigung freigeben.",
      tone: "warning",
      ctaLabel: office ? "Freigeben" : undefined,
      ctaIcon: office ? "arrow-right" : undefined,
      action: office ? "release" : undefined,
    };
  }
  if (phase === "freigegeben") {
    return {
      headline: "Bereit für den Sammellauf",
      reason: "Der Auftrag ist freigegeben und wartet auf die Einplanung in der Disposition.",
      tone: "primary",
      ctaLabel: office ? "Zur Disposition" : undefined,
      ctaIcon: office ? "time" : undefined,
      action: office ? "route" : undefined,
      route: office ? "disposition" : undefined,
    };
  }
  if (phase === "eingeplant") {
    return {
      headline: openWo ? `Eingeplant in ${openWo.no}` : "Eingeplant für die Fertigung",
      reason: "Material bereitstellen und den Innenauftrag an der Maschine starten.",
      tone: "primary",
      ctaLabel: openWo ? `${openWo.no} öffnen` : "Zur Produktion",
      ctaIcon: "cut",
      action: "route",
      route: openWo ? `produktion/${encodeURIComponent(openWo.no)}` : "produktion",
    };
  }
  if (phase === "laufend") {
    return {
      headline: runningWo ? `Läuft in ${runningWo.no}` : "Läuft an der Maschine",
      reason: "Platten fertig melden und Teile für den Versand sortieren.",
      tone: "warning",
      ctaLabel: runningWo ? `${runningWo.no} öffnen` : "Zur Produktion",
      ctaIcon: "cut",
      action: "route",
      route: runningWo ? `produktion/${encodeURIComponent(runningWo.no)}` : "produktion",
    };
  }
  if (phase === "versandbereit") {
    return {
      headline: "Geschnitten — bereit für den Versand",
      reason: "Alle fertigbaren Positionen liegen bereit und können zu einer Sendung zusammengefasst werden.",
      tone: "primary",
      ctaLabel: "Zum Versand",
      ctaIcon: "truck",
      action: "route",
      route: "versand",
    };
  }
  if (phase === "versand") {
    return {
      headline: ship ? `Im Versand (${ship.no})` : "Im Versand",
      reason: "Sendung verpacken, versenden und Tracking bis zur Zustellung verfolgen.",
      tone: "primary",
      ctaLabel: ship ? `${ship.no} öffnen` : "Zum Versand",
      ctaIcon: "truck",
      action: "route",
      route: ship ? `versand/${encodeURIComponent(ship.no)}` : "versand",
    };
  }
  // abgeschlossen
  if (office && !internal && !o.invoice_no) {
    return {
      headline: "Abgeschlossen — Rechnung steht noch aus",
      reason: "Die Ware ist ausgeliefert, aber es wurde noch keine Rechnung gestellt.",
      tone: "warning",
      ctaLabel: "Zur Buchhaltung",
      ctaIcon: "euro",
      action: "route",
      route: o.no ? `buchhaltung/${encodeURIComponent(o.no)}` : "buchhaltung",
    };
  }
  if (office && !internal && !o.paid) {
    return {
      headline: "Ausgeliefert — Zahlung noch offen",
      reason: `Rechnung ${o.invoice_no} ist gestellt; Zahlungseingang in der Buchhaltung verfolgen.`,
      tone: "primary",
      ctaLabel: "Buchhaltung öffnen",
      ctaIcon: "euro",
      action: "route",
      route: o.no ? `buchhaltung/${encodeURIComponent(o.no)}` : "buchhaltung",
    };
  }
  return {
    headline: internal ? "Interner Auftrag abgeschlossen" : "Auftrag vollständig abgeschlossen",
    reason: internal ? "Alle Positionen sind gefertigt." : "Geliefert und abgeschlossen — keine offenen Aufgaben.",
    tone: "success",
  };
}
