import { PickMaterial, WorklistData, WorklistStation, WorkSlot, fmtMin } from "./factory";
import { plural } from "./plural";
import { ORDER_PHASES, orderPhase } from "./status";

/* Heute — was der Meister in fünf Sekunden wissen muss, aus den Abrufen, die es
   schon gibt. Rein rechnend: keine Seite, kein Abruf, die Uhr kommt von aussen.

   Überfällig heißt: die Zusage ist vorbei und die Ware ist noch im Haus. Was im
   Versand oder abgeschlossen ist, hat seine Zusage gehalten oder gebrochen, zu
   tun ist daran nichts mehr. */

export interface TodayOrder {
  no: string;
  customer: string;
  customer_ref: string;
  due_date: string | null;
  blocked: boolean;
  released: boolean;
  rush: boolean;
  status?: string;
  held_at?: string | null;
  cancelled_at?: string | null;
  n_manual?: number;
  work_orders?: Array<{ no: string; status?: string }>;
}

export interface TodayRow {
  key: string;
  /** Route, an der die Zeile erledigt wird. */
  to: string;
  ref: string;
  what: string;
  why: string;
  tag?: string;
  tone?: "danger" | "warning" | "primary" | "none";
  idle?: boolean;
}

export interface Today {
  late: TodayRow[];
  atRisk: TodayRow[];
  blocked: TodayRow[];
  material: TodayRow[];
  next: TodayRow[];
}

function leftTheBuilding(o: TodayOrder): boolean {
  const phase = orderPhase(o);
  return phase === "versand" || phase === "abgeschlossen" || phase === "storniert";
}

export function overdueMs(o: TodayOrder, now: number): number {
  if (!o.due_date || leftTheBuilding(o)) return 0;
  const due = new Date(o.due_date).getTime();
  return Number.isFinite(due) && due < now ? now - due : 0;
}

export function overdueText(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "seit eben überfällig";
  if (hours < 24) return `${plural(hours, "Stunde", "Stunden")} überfällig`;
  return `${plural(Math.floor(hours / 24), "Tag", "Tage")} überfällig`;
}

function orderWhat(o: TodayOrder): string {
  return [o.customer || "Kunde unbekannt", o.customer_ref].filter(Boolean).join(" · ");
}

/** Ein überfälliger Auftrag, der fertig ist, wartet am Packtisch, nicht im Büro. */
function orderRoute(o: TodayOrder): string {
  return orderPhase(o) === "versandbereit" ? "versand" : `auftraege/${encodeURIComponent(o.no)}`;
}

function slotWhat(s: WorkSlot): string {
  if (s.mat_name || s.mat) return [s.mat_name || s.mat, s.thk ? `${s.thk.toLocaleString("de-DE")} mm` : ""].filter(Boolean).join(" · ");
  return s.label;
}

function lateRows(orders: TodayOrder[], now: number): TodayRow[] {
  return orders
    .map((o) => ({ o, ms: overdueMs(o, now) }))
    .filter((x) => x.ms > 0)
    .sort((a, b) => Number(b.o.rush) - Number(a.o.rush) || b.ms - a.ms)
    .map(({ o, ms }) => ({
      key: o.no, to: orderRoute(o), ref: o.no, what: orderWhat(o), why: overdueText(ms),
      tag: o.rush ? "Eil" : ORDER_PHASES[orderPhase(o)].label, tone: o.rush ? "danger" as const : "none" as const,
    }));
}

function riskRows(stations: WorklistStation[], lateNos: Set<string>): TodayRow[] {
  const rows: TodayRow[] = [];
  const seen = new Set<string>();
  for (const st of stations) {
    for (const s of st.schedule.slots) {
      if (!s.late || seen.has(s.ref) || lateNos.has(s.ref)) continue;
      if (s.orders.some((no) => lateNos.has(no))) continue;
      seen.add(s.ref);
      rows.push({
        key: `risk:${s.ref}`, to: `grundriss/station/${st.id}`, ref: s.ref, what: slotWhat(s),
        why: `${st.label}: wird nach der Zusage fertig`,
      });
    }
  }
  return rows;
}

function blockedRows(orders: TodayOrder[], work: WorklistData | null): TodayRow[] {
  const rows: TodayRow[] = [];
  for (const o of orders) {
    if (leftTheBuilding(o)) continue;
    const phase = orderPhase(o);
    const to = `auftraege/${encodeURIComponent(o.no)}`;
    if (phase === "angehalten") {
      rows.push({ key: `hold:${o.no}`, to, ref: o.no, what: orderWhat(o), why: "Auftrag ist angehalten — ruht bis zur Fortsetzung", tag: "Angehalten", tone: "warning" });
    } else if (o.blocked) {
      rows.push({ key: `lock:${o.no}`, to, ref: o.no, what: orderWhat(o), why: "Übergröße oder Preisabweichung prüfen", tag: "Gesperrt", tone: "danger" });
    } else if (!o.released) {
      rows.push({ key: `rel:${o.no}`, to, ref: o.no, what: orderWhat(o), why: "Noch nicht für die Fertigung freigegeben", tag: "Wartet auf Freigabe", tone: "warning" });
    }
    if ((o.n_manual ?? 0) > 0 && !o.blocked && phase !== "angehalten") {
      rows.push({
        key: `hand:${o.no}`, to, ref: o.no, what: orderWhat(o),
        why: `${plural(o.n_manual ?? 0, "Position", "Positionen")} von Hand zu klären`, tag: "Wartet", tone: "warning",
      });
    }
  }
  for (const st of work?.stations ?? []) {
    const waiting = st.schedule.slots.length;
    if (!st.active && waiting > 0) {
      rows.push({
        key: `down:${st.id}`, to: `grundriss/station/${st.id}`, ref: st.label, what: "Station ist abgeschaltet",
        why: `${plural(waiting, "Aufgabe wartet", "Aufgaben warten")}`, tag: "Station steht", tone: "danger",
      });
    }
  }
  const pool = work?.pool ?? [];
  for (const r of pool.filter((p) => p.suggest_station_id == null)) {
    rows.push({
      key: `pool:${r.kind}:${r.ref}`, to: "arbeitsvorrat", ref: r.ref, what: r.mat_name || r.label,
      why: r.suggest_reason || "Keine passende Station", tag: "Keine Station", tone: "danger",
    });
  }
  const unassigned = pool.filter((p) => p.suggest_station_id != null).length;
  if (unassigned > 0) {
    rows.push({
      key: "pool", to: "arbeitsvorrat", ref: plural(unassigned, "Aufgabe", "Aufgaben"), what: "ohne Station",
      why: "Im Arbeitsvorrat verteilen", tag: "Wartet", tone: "warning",
    });
  }
  return rows;
}

function materialRows(materials: PickMaterial[], route: string): TodayRow[] {
  return materials
    .filter((m) => m.short)
    .map((m) => ({
      key: `${m.mat}:${m.thk}`, to: route, ref: m.mat_name || m.mat,
      what: m.thk ? `${m.thk.toLocaleString("de-DE")} mm` : "",
      why: `${plural(m.plates, "Platte", "Platten")} nötig, ${m.stock.toLocaleString("de-DE")} am Lager`
        + (m.lead_days > 0 ? `, Nachschub ${plural(m.lead_days, "Tag", "Tage")}` : ""),
      tag: "Fehlt", tone: "danger" as const,
    }));
}

/** Reihenfolge wie der Weg durch das Haus: Büro, Lager, Maschine, Versand. */
const FLOW_ORDER = ["accounting", "warehouse", "production", "shipping"];

function nextRows(stations: WorklistStation[]): TodayRow[] {
  return [...stations]
    .sort((a, b) => FLOW_ORDER.indexOf(a.type) - FLOW_ORDER.indexOf(b.type))
    .map((st) => {
      const slots = st.schedule.slots;
      const first = slots[0];
      const to = `grundriss/station/${st.id}`;
      if (!first) return { key: `st:${st.id}`, to, ref: st.label, what: "Nichts zugeordnet", why: "", tag: st.active ? undefined : "Station steht", tone: "none" as const, idle: true };
      // 0 in einem Maschinenwert heißt unbekannt, nicht „keine Zeit".
      const minutes = st.schedule.total_min ?? 0;
      return {
        key: `st:${st.id}`, to, ref: st.label,
        what: `${first.ref} · ${slotWhat(first)}`,
        why: `${plural(slots.length, "Aufgabe", "Aufgaben")} · ${minutes > 0 ? fmtMin(minutes) : "Dauer unbekannt"}`,
        tag: !st.active ? "Station steht" : first.started ? "Läuft" : undefined,
        tone: !st.active ? "danger" as const : first.started ? "primary" as const : "none" as const,
      };
    });
}

export function buildToday(
  orders: TodayOrder[], work: WorklistData | null, materials: PickMaterial[],
  materialRoute: string, now: number,
): Today {
  const late = lateRows(orders, now);
  const stations = work?.stations ?? [];
  return {
    late,
    atRisk: riskRows(stations, new Set(late.map((r) => r.ref))),
    blocked: blockedRows(orders, work),
    material: materialRows(materials, materialRoute),
    next: nextRows(stations),
  };
}
