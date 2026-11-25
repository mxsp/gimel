import {
  Button, Callout, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect,
  Icon, InputGroup, NonIdealState, NumericInput, Spinner, Switch, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtDate, fmtEur, getToken, isWorker } from "../api";
import { navigate } from "../router";
import { toastError, toastSuccess } from "../toast";
import { Drawer, PageFrame } from "../ui";

interface CalendarOrder {
  no: string;
  kind?: string;
  customer?: string;
  customer_ref?: string;
  due_date?: string | null;
  rush?: boolean;
  gross?: number;
  n_positions?: number;
  n_done?: number;
  est_min?: number;
  material_risk?: string;
  status?: string;
  status_label?: string;
  blocked?: boolean;
  cancelled_at?: string | null;
  held_at?: string | null;
}

interface CalendarPO {
  no: string;
  supplier_name: string;
  status: string;
  eta_date: string | null;
  materials: string[];
  qty_open: number;
  total_net: number;
}

interface CalendarWO {
  no: string;
  mat: string;
  mat_name: string;
  thk: number;
  n_plates: number;
  status: string;
  due_date: string | null;
  planned_min: number;
  station_label: string;
}

interface CalendarEventRow {
  id: number;
  title: string;
  kind: "termin" | "wartung" | "lieferung" | "meilenstein" | "schicht";
  start_date: string;
  end_date: string;
  start_time: string;
  end_time: string;
  colour: string;
  station_label: string;
  order_no: string;
  purchase_order_no: string;
  capacity_block_min: number;
  done: boolean;
  note: string;
}

type ViewMode = "month" | "week" | "capacity" | "agenda";
type QuickFilter = "all" | "open" | "rush" | "overdue" | "internal" | "bottleneck";

const DOW = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfWeek(d: Date): Date {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - diff);
  return copy;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function isoWeekNumber(d: Date): number {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

function isDoneOrder(o: CalendarOrder): boolean {
  return o.status === "abgeschlossen" || o.status === "versand";
}

function isOverdueOrder(o: CalendarOrder, todayKey: string): boolean {
  if (!o.due_date || o.cancelled_at || isDoneOrder(o)) return false;
  return String(o.due_date).slice(0, 10) < todayKey;
}

function orderToneClass(o: CalendarOrder, todayKey: string): string {
  if (o.cancelled_at) return "is-cancelled";
  if (isOverdueOrder(o, todayKey)) return "is-overdue";
  if (o.rush) return "is-rush";
  if (o.blocked || o.held_at || o.material_risk) return "is-blocked";
  if (isDoneOrder(o)) return "is-done";
  return "";
}

function statusIntent(o: CalendarOrder, todayKey: string): "danger" | "warning" | "success" | "primary" | "none" {
  if (o.cancelled_at) return "none";
  if (isOverdueOrder(o, todayKey) || o.rush) return "danger";
  if (o.blocked || o.held_at || o.material_risk) return "warning";
  if (isDoneOrder(o)) return "success";
  if (o.status === "in_produktion" || o.status === "versandbereit") return "primary";
  return "none";
}

const EVENT_KIND_LABEL: Record<string, string> = {
  termin: "Termin",
  wartung: "Wartung",
  lieferung: "Lieferfenster",
  meilenstein: "Meilenstein",
  schicht: "Schicht",
};

export default function Kalender() {
  const office = !isWorker();
  const todayKey = useMemo(() => isoDate(new Date()), []);
  const [view, setView] = useState<ViewMode>("month");
  const [cursor, setCursor] = useState(() => new Date());

  const [dailyCapMin, setDailyCapMin] = useState(960);
  const [orders, setOrders] = useState<CalendarOrder[]>([]);
  const [pos, setPos] = useState<CalendarPO[]>([]);
  const [wos, setWos] = useState<CalendarWO[]>([]);
  const [events, setEvents] = useState<CalendarEventRow[]>([]);

  const [showPOs, setShowPOs] = useState(true);
  const [showWOs, setShowWOs] = useState(false);
  const [showEvents, setShowEvents] = useState(true);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [showCancelled, setShowCancelled] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showUnscheduled, setShowUnscheduled] = useState(false);

  const [dragItem, setDragItem] = useState<{ type: "order" | "event"; id: string } | null>(null);
  const [eventModal, setEventModal] = useState(false);
  const [evForm, setEvForm] = useState({
    title: "",
    kind: "termin" as CalendarEventRow["kind"],
    start_date: isoDate(new Date()),
    start_time: "",
    capacity_block_min: 0,
    order_no: "",
    note: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      try {
        const ov = await api<{
          daily_capacity_min: number;
          orders: CalendarOrder[];
          purchase_orders: CalendarPO[];
          work_orders: CalendarWO[];
          events: CalendarEventRow[];
        }>("/api/calendar/overview");
        setDailyCapMin(ov.daily_capacity_min || 960);
        setOrders(ov.orders ?? []);
        setPos(ov.purchase_orders ?? []);
        setWos(ov.work_orders ?? []);
        setEvents(ov.events ?? []);
      } catch {
        const r = await api<{ items?: CalendarOrder[] } | CalendarOrder[]>("/api/admin/orders?limit=500");
        setOrders(Array.isArray(r) ? r : (r.items ?? []));
      }
      setError("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const reschedule = async (entityType: "order" | "purchase_order" | "event", entityId: string, targetDate: string) => {
    if (!office) return;
    try {
      await api("/api/calendar/reschedule", {
        method: "POST",
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId, target_date: targetDate }),
      });
      toastSuccess(`${entityId} auf ${fmtDate(targetDate)} terminiert.`);
      await load();
    } catch (e: any) {
      toastError(e.message);
    }
  };

  const saveEvent = async () => {
    try {
      await api("/api/calendar/events", { method: "POST", body: JSON.stringify(evForm) });
      toastSuccess(`Termin „${evForm.title}“ eingetragen.`);
      setEventModal(false);
      setEvForm({ title: "", kind: "termin", start_date: selectedDay || todayKey, start_time: "", capacity_block_min: 0, order_no: "", note: "" });
      await load();
    } catch (e: any) {
      toastError(e.message);
    }
  };

  const downloadIcs = async () => {
    try {
      const tok = getToken();
      const res = await fetch("/api/calendar/export.ics", {
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      });
      if (!res.ok) throw new Error("iCal-Export fehlgeschlagen.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gimel-kalender.ics";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toastError(e.message);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (!showCancelled && o.cancelled_at) return false;
      if (quickFilter === "open" && (o.cancelled_at || isDoneOrder(o))) return false;
      if (quickFilter === "rush" && !o.rush) return false;
      if (quickFilter === "overdue" && !isOverdueOrder(o, todayKey)) return false;
      if (quickFilter === "internal" && o.kind !== "internal") return false;
      if (quickFilter === "bottleneck" && !o.material_risk) return false;
      if (q) {
        const hay = `${o.no} ${o.customer ?? ""} ${o.customer_ref ?? ""} ${o.status_label ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, query, quickFilter, showCancelled, todayKey]);

  const { byDay, unscheduled } = useMemo(() => {
    const m = new Map<string, CalendarOrder[]>();
    const none: CalendarOrder[] = [];
    for (const o of filtered) {
      if (!o.due_date) {
        none.push(o);
        continue;
      }
      const key = String(o.due_date).slice(0, 10);
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(o);
    }
    for (const list of m.values()) {
      list.sort((a, b) => {
        const score = (x: CalendarOrder) =>
          (x.cancelled_at ? 10 : 0) + (isDoneOrder(x) ? 5 : 0) - (x.rush ? 3 : 0) - (isOverdueOrder(x, todayKey) ? 2 : 0);
        return score(a) - score(b) || a.no.localeCompare(b.no);
      });
    }
    return { byDay: m, unscheduled: none };
  }, [filtered, todayKey]);

  const posByDay = useMemo(() => {
    const m = new Map<string, CalendarPO[]>();
    if (!showPOs) return m;
    for (const p of pos) {
      if (!p.eta_date) continue;
      if (!m.has(p.eta_date)) m.set(p.eta_date, []);
      m.get(p.eta_date)!.push(p);
    }
    return m;
  }, [pos, showPOs]);

  const wosByDay = useMemo(() => {
    const m = new Map<string, CalendarWO[]>();
    if (!showWOs) return m;
    for (const w of wos) {
      if (!w.due_date) continue;
      if (!m.has(w.due_date)) m.set(w.due_date, []);
      m.get(w.due_date)!.push(w);
    }
    return m;
  }, [wos, showWOs]);

  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalendarEventRow[]>();
    if (!showEvents) return m;
    for (const ev of events) {
      if (!m.has(ev.start_date)) m.set(ev.start_date, []);
      m.get(ev.start_date)!.push(ev);
    }
    return m;
  }, [events, showEvents]);

  const dayLoadPct = useCallback((dayKey: string) => {
    const dayOrds = byDay.get(dayKey) ?? [];
    const dayEvs = eventsByDay.get(dayKey) ?? [];
    const ordMin = dayOrds.reduce((acc, o) => acc + (isDoneOrder(o) || o.cancelled_at ? 0 : (o.est_min ?? 25)), 0);
    const blockMin = dayEvs.reduce((acc, e) => acc + (e.done ? 0 : (e.capacity_block_min ?? 0)), 0);
    const effCap = Math.max(60, dailyCapMin - blockMin);
    return {
      ordMin: Math.round(ordMin),
      blockMin: Math.round(blockMin),
      effCap: Math.round(effCap),
      pct: Math.min(150, Math.round((ordMin / effCap) * 100)),
    };
  }, [byDay, eventsByDay, dailyCapMin]);

  const monthWeeks = useMemo(() => {
    const first = startOfMonth(cursor);
    const gridStart = startOfWeek(first);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const weeks: Date[][] = [];
    let d = gridStart;
    while (d <= last || weeks.length < 5) {
      const row: Date[] = [];
      for (let i = 0; i < 7; i++) {
        row.push(d);
        d = addDays(d, 1);
      }
      weeks.push(row);
      if (d > last && weeks.length >= 5) break;
    }
    return weeks;
  }, [cursor]);

  const weekDays = useMemo(() => {
    const start = startOfWeek(cursor);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [cursor]);

  const stats = useMemo(() => {
    const visibleKeys = new Set(
      (view === "week" ? weekDays : monthWeeks.flat().filter((d) => d.getMonth() === cursor.getMonth()))
        .map(isoDate),
    );
    let inPeriod = 0;
    let rushCount = 0;
    let overdueCount = 0;
    let bottleneckCount = 0;
    for (const o of filtered) {
      if (o.rush && !o.cancelled_at && !isDoneOrder(o)) rushCount++;
      if (isOverdueOrder(o, todayKey)) overdueCount++;
      if (o.material_risk) bottleneckCount++;
      if (o.due_date && visibleKeys.has(String(o.due_date).slice(0, 10))) inPeriod++;
    }
    return { inPeriod, rushCount, overdueCount, bottleneckCount, unscheduled: unscheduled.length, inboundPos: pos.length };
  }, [filtered, view, weekDays, monthWeeks, cursor, todayKey, unscheduled.length, pos.length]);

  const stepPeriod = (dir: -1 | 1) => {
    if (view === "week" || view === "capacity") {
      setCursor((c) => addDays(c, dir * 7));
    } else {
      setCursor((c) => new Date(c.getFullYear(), c.getMonth() + dir, 1));
    }
  };

  const periodLabel = useMemo(() => {
    if (view === "week" || view === "capacity") {
      const a = weekDays[0];
      const b = weekDays[6];
      return `KW ${isoWeekNumber(a)} · ${a.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })} – ${b.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}`;
    }
    return cursor.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  }, [view, cursor, weekDays]);

  const agendaDays = useMemo(() => {
    const keys = new Set<string>([...byDay.keys(), ...posByDay.keys(), ...eventsByDay.keys()]);
    return Array.from(keys).sort();
  }, [byDay, posByDay, eventsByDay]);

  const selectedDayOrders = selectedDay ? (byDay.get(selectedDay) ?? []) : [];
  const selectedDayPos = selectedDay ? (posByDay.get(selectedDay) ?? []) : [];
  const selectedDayEvents = selectedDay ? (eventsByDay.get(selectedDay) ?? []) : [];

  if (loading && !orders.length && !events.length) {
    return (
      <PageFrame title="Kalender" sub="Zusage-, Liefer-, Fertigungs- und Wartungstermine mit Kapazitätsabgleich.">
        <div className="twin-center"><Spinner size={32} /></div>
      </PageFrame>
    );
  }
  if (error && !orders.length) {
    return (
      <PageFrame title="Kalender">
        <NonIdealState icon="error" title="Kalender konnte nicht geladen werden" description={error}
                       action={<Button icon="refresh" text="Erneut versuchen" onClick={load} />} />
      </PageFrame>
    );
  }

  return (
    <PageFrame
      title="Kalender & Kapazitätsplan"
      sub="Aufträge, Lieferanten-Zulauf (Einkauf), Innenaufträge und Betriebstermine — per Drag & Drop umterminieren."
      actions={
        <>
          <Button small minimal icon="refresh" aria-label="Aktualisieren" title="Aktualisieren"
                  loading={loading} onClick={load} />
          {office && (
            <>
              <Button small icon="export" text="iCal (.ics)" onClick={downloadIcs} />
              <Button small icon="calendar" text="Termin / Wartung"
                      onClick={() => {
                        setEvForm((f) => ({ ...f, start_date: selectedDay || todayKey }));
                        setEventModal(true);
                      }} />
              <Button small intent="primary" icon="plus" text="Neuer Auftrag"
                      onClick={() => navigate("auftragserfassung")} />
            </>
          )}
        </>
      }
    >
      {/* KPI-Leiste */}
      <div className="ui-facts ls-facts" role="group" aria-label="Terminübersicht">
        <div className="ui-fact is-accent">
          <span className="ui-fact-label">{view === "week" || view === "capacity" ? "In dieser Woche" : "In diesem Monat"}</span>
          <span className="ui-fact-value">{stats.inPeriod}</span>
          <span className="sub">{stats.inboundPos} Lieferungen im Zulauf</span>
        </div>
        <div className={`ui-fact ${stats.rushCount > 0 ? "is-warning" : "is-success"}`}>
          <span className="ui-fact-label">Offene Eilaufträge</span>
          <span className="ui-fact-value">{stats.rushCount}</span>
          <span className="sub">{stats.rushCount > 0 ? "bevorzugte Fertigung" : "keine Eilaufträge offen"}</span>
        </div>
        <div className={`ui-fact ${stats.overdueCount > 0 ? "is-danger" : "is-success"}`}>
          <span className="ui-fact-label">Überfällig / Materialrisiko</span>
          <span className="ui-fact-value">{stats.overdueCount + stats.bottleneckCount}</span>
          <span className="sub">
            {stats.bottleneckCount > 0 ? `${stats.bottleneckCount} mit spätem Zulauf` : stats.overdueCount > 0 ? "Termin überschritten" : "alle Termine im Plan"}
          </span>
        </div>
        <div className="ui-fact is-info" style={{ cursor: stats.unscheduled ? "pointer" : undefined }}
             onClick={() => stats.unscheduled > 0 && setShowUnscheduled((v) => !v)}>
          <span className="ui-fact-label">Ohne Zusage-Termin</span>
          <span className="ui-fact-value">{stats.unscheduled}</span>
          <span className="sub">{stats.unscheduled > 0 ? "klicken zum Terminieren" : "alle terminiert"}</span>
        </div>
      </div>

      {/* Steuerleiste */}
      <div className="cal-controls">
        <div className="cal-nav">
          <Button small icon="chevron-left" aria-label="Vorheriger Zeitraum" onClick={() => stepPeriod(-1)} />
          <Button small text="Heute" onClick={() => setCursor(new Date())} />
          <Button small icon="chevron-right" aria-label="Nächster Zeitraum" onClick={() => stepPeriod(1)} />
          <span className="cal-period-label">{periodLabel}</span>
        </div>

        <div className="cal-view-switch" role="tablist" aria-label="Kalenderansicht">
          <button type="button" role="tab" aria-selected={view === "month"}
                  className={`cal-view-btn${view === "month" ? " is-active" : ""}`}
                  onClick={() => setView("month")}>
            <Icon icon="grid-view" size={12} /> Monat
          </button>
          <button type="button" role="tab" aria-selected={view === "week"}
                  className={`cal-view-btn${view === "week" ? " is-active" : ""}`}
                  onClick={() => setView("week")}>
            <Icon icon="column-layout" size={12} /> Woche
          </button>
          <button type="button" role="tab" aria-selected={view === "capacity"}
                  className={`cal-view-btn${view === "capacity" ? " is-active" : ""}`}
                  onClick={() => setView("capacity")}>
            <Icon icon="timeline-bar-chart" size={12} /> Kapazität
          </button>
          <button type="button" role="tab" aria-selected={view === "agenda"}
                  className={`cal-view-btn${view === "agenda" ? " is-active" : ""}`}
                  onClick={() => setView("agenda")}>
            <Icon icon="list" size={12} /> Agenda
          </button>
        </div>
      </div>

      {/* Filter & Ebenen */}
      <div className="cal-filter-row" style={{ flexWrap: "wrap", gap: 8 }}>
        <InputGroup small leftIcon="search" className="cal-search"
                    aria-label="Im Kalender suchen"
                    placeholder="Auftrag, Kunde, Referenz …"
                    value={query} onChange={(e) => setQuery(e.target.value)}
                    rightElement={query ? <Button minimal icon="cross" onClick={() => setQuery("")} /> : undefined} />
        <div className="ui-filter-chips">
          {([
            ["all", "Alle"],
            ["open", "Nur offene"],
            ["rush", "Eil"],
            ["overdue", "Überfällig"],
            ["bottleneck", "Materialrisiko"],
            ["internal", "Intern"],
          ] as Array<[QuickFilter, string]>).map(([k, label]) => (
            <button key={k} type="button"
                    className={"filter-chip" + (quickFilter === k ? " filter-chip-on" : "")}
                    onClick={() => setQuickFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginLeft: "auto", alignItems: "center", flexWrap: "wrap" }}>
          {office && <Switch checked={showPOs} label="Lieferungen" inline style={{ margin: 0 }} onChange={(e) => setShowPOs(e.currentTarget.checked)} />}
          <Switch checked={showWOs} label="Innenaufträge" inline style={{ margin: 0 }} onChange={(e) => setShowWOs(e.currentTarget.checked)} />
          <Switch checked={showEvents} label="Wartung & Termine" inline style={{ margin: 0 }} onChange={(e) => setShowEvents(e.currentTarget.checked)} />
          <Switch checked={showCancelled} label="Stornierte" inline style={{ margin: 0 }} onChange={(e) => setShowCancelled(e.currentTarget.checked)} />
        </div>
      </div>

      {/* MONATSANSICHT */}
      {view === "month" && (
        <div className="cal-month-wrap">
          <div className="cal-month-head">
            <div className="cal-dow-kw">KW</div>
            {DOW.map((d, idx) => (
              <div key={d} className={`cal-dow${idx >= 5 ? " cal-dow-wknd" : ""}`}>{d}</div>
            ))}
          </div>
          {monthWeeks.map((week, wi) => (
            <div key={wi} className="cal-month-row">
              <div className="cal-kw-cell">{isoWeekNumber(week[0])}</div>
              {week.map((d, di) => {
                const key = isoDate(d);
                const dayOrders = byDay.get(key) ?? [];
                const dayPos = posByDay.get(key) ?? [];
                const dayWos = wosByDay.get(key) ?? [];
                const dayEvs = eventsByDay.get(key) ?? [];
                const totalCount = dayOrders.length + dayPos.length + dayWos.length + dayEvs.length;
                const isToday = key === todayKey;
                const otherMonth = d.getMonth() !== cursor.getMonth();
                const hasHot = dayOrders.some((o) => !o.cancelled_at && (o.rush || isOverdueOrder(o, todayKey) || Boolean(o.material_risk)));
                const cap = dayLoadPct(key);
                const visibleOrders = dayOrders.slice(0, 3);
                const rest = totalCount - visibleOrders.length - Math.min(1, dayPos.length) - Math.min(1, dayEvs.length);

                return (
                  <div key={key}
                       className={`cal-day${di >= 5 ? " is-weekend" : ""}${otherMonth ? " is-other-month" : ""}${isToday ? " is-today" : ""}${selectedDay === key ? " is-selected" : ""}`}
                       onDragOver={(e) => { if (office && dragItem) e.preventDefault(); }}
                       onDrop={(e) => {
                         e.preventDefault();
                         if (dragItem) {
                           void reschedule(dragItem.type, dragItem.id, key);
                           setDragItem(null);
                         }
                       }}
                       onClick={() => setSelectedDay(key)}>
                    <div className="cal-day-head">
                      <span className="cal-day-num">{d.getDate()}</span>
                      {totalCount > 0 && (
                        <span className={`cal-day-count${hasHot || cap.pct > 100 ? " is-hot" : ""}`} title={`Auslastung ca. ${cap.pct} %`}>
                          {totalCount}
                        </span>
                      )}
                    </div>
                    {cap.pct > 0 && (
                      <div className="cal-load-bar" aria-hidden="true" title={`Kapazität: ${cap.pct} %`}>
                        <div className={`cal-load-fill${cap.pct > 100 || hasHot ? " is-danger" : cap.pct >= 75 ? " is-warn" : ""}`}
                             style={{ width: `${Math.min(100, cap.pct)}%` }} />
                      </div>
                    )}
                    <div className="cal-pills">
                      {dayEvs.slice(0, 1).map((ev) => (
                        <button key={`ev-${ev.id}`} type="button" className="cal-pill"
                                draggable={office}
                                onDragStart={() => setDragItem({ type: "event", id: String(ev.id) })}
                                style={{ borderLeft: `3px solid ${ev.colour || "#2d72d2"}` }}
                                title={`${EVENT_KIND_LABEL[ev.kind] ?? ev.kind}: ${ev.title}`}
                                onClick={(e) => { e.stopPropagation(); setSelectedDay(key); }}>
                          <Icon icon={ev.kind === "wartung" ? "wrench" : "calendar"} size={10} />
                          <span className="cal-pill-no">{ev.title}</span>
                        </button>
                      ))}
                      {dayPos.slice(0, 1).map((p) => (
                        <button key={`po-${p.no}`} type="button" className="cal-pill"
                                style={{ borderLeft: "3px solid #0d8050" }}
                                title={`Wareneingang ${p.no} · ${p.supplier_name} (${p.qty_open} Pl.)`}
                                onClick={(e) => { e.stopPropagation(); navigate("lager"); }}>
                          <Icon icon="import" size={10} intent="success" />
                          <span className="cal-pill-no">{p.no}</span>
                          <span className="cal-pill-cust">{p.supplier_name}</span>
                        </button>
                      ))}
                      {visibleOrders.map((o) => (
                        <button key={o.no} type="button"
                                draggable={office}
                                onDragStart={() => setDragItem({ type: "order", id: o.no })}
                                className={`cal-pill ${orderToneClass(o, todayKey)}`}
                                title={`${o.no}${o.customer ? ` · ${o.customer}` : ""}${o.material_risk ? ` · ⚠ ${o.material_risk}` : ""}`}
                                onClick={(e) => { e.stopPropagation(); navigate(`auftraege/${o.no}`); }}>
                          {o.rush && <Icon icon="flash" size={10} intent="danger" />}
                          {o.material_risk && <Icon icon="warning-sign" size={10} intent="warning" />}
                          <span className="cal-pill-no">{o.no}</span>
                          {o.customer && <span className="cal-pill-cust">{o.customer}</span>}
                        </button>
                      ))}
                      {rest > 0 && (
                        <button type="button" className="cal-more-btn"
                                onClick={(e) => { e.stopPropagation(); setSelectedDay(key); }}>
                          +{rest} weitere …
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* WOCHENANSICHT */}
      {view === "week" && (
        <div className="cal-week-grid">
          {weekDays.map((d, di) => {
            const key = isoDate(d);
            const dayOrders = byDay.get(key) ?? [];
            const dayPos = posByDay.get(key) ?? [];
            const dayEvs = eventsByDay.get(key) ?? [];
            const isToday = key === todayKey;
            const cap = dayLoadPct(key);
            return (
              <div key={key} className={`cal-week-col${isToday ? " is-today" : ""}`}
                   onDragOver={(e) => { if (office && dragItem) e.preventDefault(); }}
                   onDrop={(e) => {
                     e.preventDefault();
                     if (dragItem) {
                       void reschedule(dragItem.type, dragItem.id, key);
                       setDragItem(null);
                     }
                   }}>
                <div className="cal-week-col-head">
                  <strong>{DOW[di]} {d.getDate()}.{d.getMonth() + 1}.</strong>
                  <Tag minimal round intent={cap.pct > 100 ? "danger" : "none"}>{cap.pct}%</Tag>
                </div>
                <div className="cal-week-cards">
                  {dayOrders.length === 0 && dayPos.length === 0 && dayEvs.length === 0 && <span className="sub">Frei</span>}
                  {dayEvs.map((ev) => (
                    <div key={`ev-${ev.id}`} className="cal-week-card" style={{ borderLeft: `3px solid ${ev.colour}` }}
                         onClick={() => setSelectedDay(key)}>
                      <Tag minimal>{EVENT_KIND_LABEL[ev.kind] ?? ev.kind}</Tag>
                      <div style={{ fontWeight: 600, marginTop: 2 }}>{ev.title}</div>
                      {ev.capacity_block_min > 0 && <div className="sub mono">−{ev.capacity_block_min} Min. Kapazität</div>}
                    </div>
                  ))}
                  {dayPos.map((p) => (
                    <div key={`po-${p.no}`} className="cal-week-card" style={{ borderLeft: "3px solid #0d8050" }}
                         onClick={() => navigate("lager")}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span className="mono"><b>{p.no}</b></span>
                        <Tag minimal intent="success">Zulauf</Tag>
                      </div>
                      <div style={{ fontSize: 12 }}>{p.supplier_name} ({p.qty_open} Pl.)</div>
                    </div>
                  ))}
                  {dayOrders.map((o) => (
                    <div key={o.no} draggable={office}
                         onDragStart={() => setDragItem({ type: "order", id: o.no })}
                         className={`cal-week-card ${orderToneClass(o, todayKey)}`}
                         onClick={() => navigate(`auftraege/${o.no}`)}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                        <span className="mono" style={{ fontWeight: 600 }}>{o.no}</span>
                        {o.rush && <Tag minimal intent="danger" icon="flash">Eil</Tag>}
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {o.customer || (o.kind === "internal" ? "Intern" : "—")}
                      </div>
                      {o.material_risk && <div className="sub" style={{ color: "#c23030" }}>⚠ {o.material_risk}</div>}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                        <Tag minimal intent={statusIntent(o, todayKey)}>{o.status_label || o.status || "Offen"}</Tag>
                        {o.n_positions != null && (
                          <span className="sub mono">{o.n_done ?? 0}/{o.n_positions}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* KAPAZITÄTSANSICHT */}
      {view === "capacity" && (
        <div style={{ display: "grid", gap: 10 }}>
          {weekDays.map((d, di) => {
            const key = isoDate(d);
            const cap = dayLoadPct(key);
            const dayOrds = byDay.get(key) ?? [];
            const dayPos = posByDay.get(key) ?? [];
            return (
              <div key={key} style={{
                padding: "12px 14px", border: "1px solid var(--g-line, #d5d9df)", borderRadius: 6,
                cursor: "pointer",
              }} onClick={() => setSelectedDay(key)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div>
                    <b>{DOW[di]}, {fmtDate(key)}</b>{" "}
                    <span className="sub">· {dayOrds.length} Aufträge · {dayPos.length} Zuläufe</span>
                  </div>
                  <div>
                    <span className="mono sub" style={{ marginRight: 8 }}>
                      {cap.ordMin} / {cap.effCap} Min.{cap.blockMin > 0 ? ` (${cap.blockMin} Min. Wartung)` : ""}
                    </span>
                    <Tag intent={cap.pct > 100 ? "danger" : cap.pct >= 75 ? "warning" : "success"}>{cap.pct} %</Tag>
                  </div>
                </div>
                <div className="cal-load-bar" style={{ height: 8 }}>
                  <div className={`cal-load-fill${cap.pct > 100 ? " is-danger" : cap.pct >= 75 ? " is-warn" : ""}`}
                       style={{ width: `${Math.min(100, cap.pct)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* AGENDA-ANSICHT */}
      {view === "agenda" && (
        agendaDays.length === 0 ? (
          <NonIdealState icon="calendar" title="Keine Termine im Filter"
                         description="Filter anpassen oder einen neuen Auftrag bzw. Termin anlegen." />
        ) : (
          <div className="cal-agenda">
            {agendaDays.map((dayKey) => {
              const list = byDay.get(dayKey) ?? [];
              const pList = posByDay.get(dayKey) ?? [];
              const eList = eventsByDay.get(dayKey) ?? [];
              const isToday = dayKey === todayKey;
              const isPastOpen = dayKey < todayKey && list.some((o) => !o.cancelled_at && !isDoneOrder(o));
              const dt = new Date(`${dayKey}T00:00:00`);
              const label = dt.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
              return (
                <div key={dayKey} className="cal-agenda-group">
                  <div className={`cal-agenda-head${isToday ? " is-today" : isPastOpen ? " is-overdue" : ""}`}>
                    <span>{isToday ? `Heute — ${label}` : label}</span>
                    <Tag minimal intent={isPastOpen ? "danger" : isToday ? "primary" : "none"}>
                      {list.length + pList.length + eList.length} Einträge
                    </Tag>
                  </div>
                  {eList.map((ev) => (
                    <div key={`ev-${ev.id}`} className="cal-agenda-item" onClick={() => setSelectedDay(dayKey)}>
                      <Tag minimal>{EVENT_KIND_LABEL[ev.kind] ?? ev.kind}</Tag>
                      <b>{ev.title}</b>
                      <span className="sub">{ev.station_label || ev.note || "—"}</span>
                      <span className="sub mono">{ev.start_time || "ganztägig"}</span>
                      <span />
                    </div>
                  ))}
                  {pList.map((p) => (
                    <div key={`po-${p.no}`} className="cal-agenda-item" onClick={() => navigate("lager")}>
                      <span className="mono"><b>{p.no}</b></span>
                      <span>Wareneingang <b>{p.supplier_name}</b> ({p.materials.join(", ")})</span>
                      <Tag minimal intent="success">Einkauf</Tag>
                      <span className="sub mono">{p.qty_open} Pl.</span>
                      <span className="mono" style={{ textAlign: "right" }}>{fmtEur(p.total_net)}</span>
                    </div>
                  ))}
                  {list.map((o) => (
                    <div key={o.no} className="cal-agenda-item" onClick={() => navigate(`auftraege/${o.no}`)}>
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {o.rush && <Icon icon="flash" size={12} intent="danger" style={{ marginRight: 4 }} />}
                        {o.no}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <b>{o.customer || "—"}</b>
                        {o.customer_ref && <span className="sub"> · {o.customer_ref}</span>}
                        {o.material_risk && <Tag minimal intent="warning" style={{ marginLeft: 6 }}>{o.material_risk}</Tag>}
                      </span>
                      <Tag minimal intent={statusIntent(o, todayKey)}>{o.status_label || o.status || "Offen"}</Tag>
                      <span className="sub mono">{o.n_positions != null ? `${o.n_done ?? 0}/${o.n_positions} Pos.` : ""}</span>
                      <span className="mono" style={{ textAlign: "right" }}>
                        {office && o.kind !== "internal" && o.gross != null ? fmtEur(o.gross) : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Ohne Termin — direkt auf heute/+3T terminieren */}
      {showUnscheduled && unscheduled.length > 0 && (
        <Callout intent="primary" icon="time" title={`Aufträge ohne Zusage-Termin (${unscheduled.length})`} style={{ marginTop: 14 }}>
          <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
            {unscheduled.map((o) => (
              <div key={o.no} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Button small outlined icon="document"
                        text={`${o.no}${o.customer ? ` · ${o.customer}` : ""}`}
                        onClick={() => navigate(`auftraege/${o.no}`)} />
                {office && (
                  <>
                    <Button small minimal icon="calendar" text="Auf heute setzen"
                            onClick={() => reschedule("order", o.no, todayKey)} />
                    <Button small minimal icon="fast-forward" text="+3 Tage"
                            onClick={() => reschedule("order", o.no, isoDate(addDays(new Date(), 3)))} />
                  </>
                )}
              </div>
            ))}
          </div>
        </Callout>
      )}

      {/* Tages-Detail-Drawer */}
      <Drawer
        open={selectedDay !== null}
        onClose={() => setSelectedDay(null)}
        title={selectedDay ? `Tagesplan am ${fmtDate(selectedDay)}` : ""}
        sub={selectedDay ? `${selectedDayOrders.length} Aufträge · ${selectedDayPos.length} Lieferungen · ${selectedDayEvents.length} Termine · Auslastung ${dayLoadPct(selectedDay).pct} %` : ""}
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {office && selectedDay && (
            <Button small intent="primary" icon="plus" text="Termin an diesem Tag"
                    onClick={() => {
                      setEvForm((f) => ({ ...f, start_date: selectedDay }));
                      setEventModal(true);
                    }} />
          )}
        </div>
        <div className="cal-drawer-list">
          {selectedDayEvents.map((ev) => (
            <div key={`ev-${ev.id}`} className="cal-drawer-card" style={{ borderLeft: `4px solid ${ev.colour}` }}>
              <div className="cal-drawer-card-top">
                <b>{ev.title}</b>
                <Tag minimal>{EVENT_KIND_LABEL[ev.kind] ?? ev.kind}</Tag>
              </div>
              {ev.note && <div className="sub">{ev.note}</div>}
              {office && (
                <div style={{ marginTop: 6 }}>
                  <Button small minimal intent="danger" icon="trash" text="Löschen"
                          onClick={async () => {
                            await api(`/api/calendar/events/${ev.id}`, { method: "DELETE" });
                            await load();
                          }} />
                </div>
              )}
            </div>
          ))}

          {selectedDayPos.map((p) => (
            <div key={`po-${p.no}`} className="cal-drawer-card" style={{ borderLeft: "4px solid #0d8050" }}>
              <div className="cal-drawer-card-top">
                <span className="mono"><b>{p.no}</b></span>
                <Tag minimal intent="success">Wareneingang ({p.qty_open} Pl.)</Tag>
              </div>
              <div><b>{p.supplier_name}</b> · {p.materials.join(", ")}</div>
            </div>
          ))}

          {selectedDayOrders.map((o) => (
            <div key={o.no} className={`cal-drawer-card ${orderToneClass(o, todayKey)}`}>
              <div className="cal-drawer-card-top">
                <span className="mono" style={{ fontWeight: 700, fontSize: 14 }}>{o.no}</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {o.rush && <Tag minimal intent="danger" icon="flash">Eil</Tag>}
                  <Tag minimal intent={statusIntent(o, todayKey)}>{o.status_label || o.status || "Offen"}</Tag>
                </div>
              </div>
              <div style={{ fontSize: 13 }}>
                <b>{o.customer || (o.kind === "internal" ? "Interner Auftrag" : "—")}</b>
                {o.customer_ref && <span className="sub"> · Ref. {o.customer_ref}</span>}
              </div>
              {o.material_risk && <Callout intent="warning" style={{ marginTop: 6, padding: "6px 8px" }}>{o.material_risk}</Callout>}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, gap: 8, flexWrap: "wrap" }}>
                {office && (
                  <InputGroup small type="date" value={String(o.due_date ?? "").slice(0, 10)}
                              aria-label={`Neuer Termin für ${o.no}`}
                              onChange={(e) => e.target.value && reschedule("order", o.no, e.target.value)}
                              style={{ width: 145 }} />
                )}
                <Button small minimal intent="primary" rightIcon="arrow-right" text="Auftrag öffnen"
                        onClick={() => { setSelectedDay(null); navigate(`auftraege/${o.no}`); }} />
              </div>
            </div>
          ))}
        </div>
      </Drawer>

      <Dialog isOpen={eventModal} onClose={() => setEventModal(false)} title="Betriebstermin / Wartung eintragen">
        <DialogBody>
          <div className="form-grid">
            <FormGroup label="Bezeichnung *">
              <InputGroup value={evForm.title} placeholder="z. B. Düsenwartung Wasserstrahl"
                          onChange={(e) => setEvForm({ ...evForm, title: e.target.value })} />
            </FormGroup>
            <FormGroup label="Art">
              <HTMLSelect fill value={evForm.kind} onChange={(e) => setEvForm({ ...evForm, kind: e.currentTarget.value as any })}>
                <option value="termin">Termin</option>
                <option value="wartung">Wartung / Instandhaltung</option>
                <option value="lieferung">Lieferfenster</option>
                <option value="meilenstein">Kunden-Meilenstein</option>
                <option value="schicht">Schichtplanung</option>
              </HTMLSelect>
            </FormGroup>
            <FormGroup label="Datum">
              <InputGroup type="date" value={evForm.start_date} onChange={(e) => setEvForm({ ...evForm, start_date: e.target.value })} />
            </FormGroup>
            <FormGroup label="Uhrzeit (optional)">
              <InputGroup placeholder="08:00" value={evForm.start_time} onChange={(e) => setEvForm({ ...evForm, start_time: e.target.value })} />
            </FormGroup>
            <FormGroup label="Kapazitätsabzug (Minuten, z. B. bei Wartung)">
              <NumericInput fill min={0} max={1440} stepSize={15} value={evForm.capacity_block_min}
                            onValueChange={(v) => Number.isFinite(v) && setEvForm({ ...evForm, capacity_block_min: v })} />
            </FormGroup>
            <FormGroup label="Auftragsbezug (optional)">
              <InputGroup placeholder="AB-..." value={evForm.order_no} onChange={(e) => setEvForm({ ...evForm, order_no: e.target.value })} />
            </FormGroup>
          </div>
          <FormGroup label="Notiz">
            <TextArea fill rows={2} value={evForm.note} onChange={(e) => setEvForm({ ...evForm, note: e.target.value })} />
          </FormGroup>
        </DialogBody>
        <DialogFooter actions={<>
          <Button text="Abbrechen" onClick={() => setEventModal(false)} />
          <Button intent="primary" text="Speichern" disabled={!evForm.title.trim()} onClick={saveEvent} />
        </>} />
      </Dialog>
    </PageFrame>
  );
}
