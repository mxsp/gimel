import { Button, Callout, Icon, InputGroup, NonIdealState, Spinner, Switch, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtDate, fmtEur, isWorker } from "../api";
import { navigate } from "../router";
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
  status?: string;
  status_label?: string;
  blocked?: boolean;
  cancelled_at?: string | null;
  held_at?: string | null;
}

type ViewMode = "month" | "week" | "agenda";
type QuickFilter = "all" | "open" | "rush" | "overdue" | "internal";

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
  const diff = (copy.getDay() + 6) % 7; // Monday=0
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
  if (o.blocked || o.held_at) return "is-blocked";
  if (isDoneOrder(o)) return "is-done";
  return "";
}

function statusIntent(o: CalendarOrder, todayKey: string): "danger" | "warning" | "success" | "primary" | "none" {
  if (o.cancelled_at) return "none";
  if (isOverdueOrder(o, todayKey) || o.rush) return "danger";
  if (o.blocked || o.held_at) return "warning";
  if (isDoneOrder(o)) return "success";
  if (o.status === "in_produktion" || o.status === "versandbereit") return "primary";
  return "none";
}

export default function Kalender() {
  const office = !isWorker();
  const todayKey = useMemo(() => isoDate(new Date()), []);
  const [view, setView] = useState<ViewMode>("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [orders, setOrders] = useState<CalendarOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [showCancelled, setShowCancelled] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showUnscheduled, setShowUnscheduled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items?: CalendarOrder[] } | CalendarOrder[]>("/api/admin/orders?limit=500");
      const items = Array.isArray(r) ? r : (r.items ?? []);
      setOrders(items);
      setError("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (!showCancelled && o.cancelled_at) return false;
      if (quickFilter === "open" && (o.cancelled_at || isDoneOrder(o))) return false;
      if (quickFilter === "rush" && !o.rush) return false;
      if (quickFilter === "overdue" && !isOverdueOrder(o, todayKey)) return false;
      if (quickFilter === "internal" && o.kind !== "internal") return false;
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
    // Innerhalb jedes Tages: Eil und Überfällig nach oben, Storniert nach unten.
    for (const list of m.values()) {
      list.sort((a, b) => {
        const score = (x: CalendarOrder) =>
          (x.cancelled_at ? 10 : 0) + (isDoneOrder(x) ? 5 : 0) - (x.rush ? 3 : 0) - (isOverdueOrder(x, todayKey) ? 2 : 0);
        return score(a) - score(b) || a.no.localeCompare(b.no);
      });
    }
    return { byDay: m, unscheduled: none };
  }, [filtered, todayKey]);

  // Monatsraster: vollständige Montag–Sonntag-Wochen
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

  // KPI-Zahlen für den gesamten gefilterten Bestand
  const stats = useMemo(() => {
    const visibleKeys = new Set(
      (view === "week" ? weekDays : monthWeeks.flat().filter((d) => d.getMonth() === cursor.getMonth()))
        .map(isoDate)
    );
    let inPeriod = 0;
    let rushCount = 0;
    let overdueCount = 0;
    for (const o of filtered) {
      if (o.rush && !o.cancelled_at && !isDoneOrder(o)) rushCount++;
      if (isOverdueOrder(o, todayKey)) overdueCount++;
      if (o.due_date && visibleKeys.has(String(o.due_date).slice(0, 10))) inPeriod++;
    }
    return { inPeriod, rushCount, overdueCount, unscheduled: unscheduled.length };
  }, [filtered, view, weekDays, monthWeeks, cursor, todayKey, unscheduled.length]);

  const stepPeriod = (dir: -1 | 1) => {
    if (view === "week") {
      setCursor((c) => addDays(c, dir * 7));
    } else {
      setCursor((c) => new Date(c.getFullYear(), c.getMonth() + dir, 1));
    }
  };

  const periodLabel = useMemo(() => {
    if (view === "week") {
      const a = weekDays[0];
      const b = weekDays[6];
      return `KW ${isoWeekNumber(a)} · ${a.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })} – ${b.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}`;
    }
    return cursor.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  }, [view, cursor, weekDays]);

  const agendaDays = useMemo(() => {
    return Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [byDay]);

  const selectedDayOrders = selectedDay ? (byDay.get(selectedDay) ?? []) : [];

  if (loading && !orders.length) {
    return (
      <PageFrame title="Kalender" sub="Zusage- und Liefertermine aller Aufträge auf einen Blick.">
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
      title="Kalender"
      sub="Zusage- und Liefertermine nach Monat, Woche oder Agenda — ein Klick öffnet Tag oder Auftrag."
      actions={
        <>
          <Button small minimal icon="refresh" aria-label="Aktualisieren" title="Aktualisieren"
                  loading={loading} onClick={load} />
          {office && (
            <Button small intent="primary" icon="plus" text="Neuer Auftrag"
                    onClick={() => navigate("auftragserfassung")} />
          )}
        </>
      }
    >
      {/* KPI-Leiste */}
      <div className="ui-facts ls-facts" role="group" aria-label="Terminübersicht">
        <div className="ui-fact is-accent">
          <span className="ui-fact-label">{view === "week" ? "In dieser Woche" : "In diesem Monat"}</span>
          <span className="ui-fact-value">{stats.inPeriod}</span>
          <span className="sub">{filtered.length} insgesamt im Filter</span>
        </div>
        <div className={`ui-fact ${stats.rushCount > 0 ? "is-warning" : "is-success"}`}>
          <span className="ui-fact-label">Offene Eilaufträge</span>
          <span className="ui-fact-value">{stats.rushCount}</span>
          <span className="sub">{stats.rushCount > 0 ? "bevorzugte Fertigung" : "keine Eilaufträge offen"}</span>
        </div>
        <div className={`ui-fact ${stats.overdueCount > 0 ? "is-danger" : "is-success"}`}>
          <span className="ui-fact-label">Überfällig</span>
          <span className="ui-fact-value">{stats.overdueCount}</span>
          <span className="sub">{stats.overdueCount > 0 ? "Termin überschritten" : "alle Termine im Plan"}</span>
        </div>
        <div className="ui-fact is-info" style={{ cursor: stats.unscheduled ? "pointer" : undefined }}
             onClick={() => stats.unscheduled > 0 && setShowUnscheduled((v) => !v)}>
          <span className="ui-fact-label">Ohne Zusage-Termin</span>
          <span className="ui-fact-value">{stats.unscheduled}</span>
          <span className="sub">{stats.unscheduled > 0 ? "klicken zum Anzeigen" : "alle terminiert"}</span>
        </div>
      </div>

      {/* Steuerleiste: Navigation + Ansichten */}
      <div className="cal-controls">
        <div className="cal-nav">
          <Button small icon="chevron-left" aria-label="Vorheriger Zeitraum" title="Vorheriger Zeitraum"
                  onClick={() => stepPeriod(-1)} />
          <Button small text="Heute" onClick={() => setCursor(new Date())} />
          <Button small icon="chevron-right" aria-label="Nächster Zeitraum" title="Nächster Zeitraum"
                  onClick={() => stepPeriod(1)} />
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
          <button type="button" role="tab" aria-selected={view === "agenda"}
                  className={`cal-view-btn${view === "agenda" ? " is-active" : ""}`}
                  onClick={() => setView("agenda")}>
            <Icon icon="list" size={12} /> Agenda
          </button>
        </div>
      </div>

      {/* Filter-Leiste */}
      <div className="cal-filter-row">
        <InputGroup small leftIcon="search" className="cal-search"
                    aria-label="Aufträge im Kalender suchen"
                    placeholder="Auftrag, Kunde, Referenz …"
                    value={query} onChange={(e) => setQuery(e.target.value)}
                    rightElement={query ? <Button minimal icon="cross" aria-label="Suche leeren" onClick={() => setQuery("")} /> : undefined} />
        <div className="ui-filter-chips">
          {([
            ["all", "Alle"],
            ["open", "Nur offene"],
            ["rush", "Eil"],
            ["overdue", "Überfällig"],
            ["internal", "Intern"],
          ] as Array<[QuickFilter, string]>).map(([k, label]) => (
            <button key={k} type="button"
                    className={"filter-chip" + (quickFilter === k ? " filter-chip-on" : "")}
                    onClick={() => setQuickFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <Switch checked={showCancelled} label="Stornierte" inline style={{ margin: "0 0 0 auto" }}
                onChange={(e) => setShowCancelled(e.currentTarget.checked)} />
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
                const isToday = key === todayKey;
                const otherMonth = d.getMonth() !== cursor.getMonth();
                const hasHot = dayOrders.some((o) => !o.cancelled_at && (o.rush || isOverdueOrder(o, todayKey)));
                const loadPct = Math.min(100, dayOrders.length * 16);
                const visible = dayOrders.slice(0, 4);
                const rest = dayOrders.length - visible.length;
                return (
                  <div key={key}
                       className={`cal-day${di >= 5 ? " is-weekend" : ""}${otherMonth ? " is-other-month" : ""}${isToday ? " is-today" : ""}${selectedDay === key ? " is-selected" : ""}`}
                       onClick={() => dayOrders.length > 0 && setSelectedDay(key)}>
                    <div className="cal-day-head">
                      <span className="cal-day-num">{d.getDate()}</span>
                      {dayOrders.length > 0 && (
                        <span className={`cal-day-count${hasHot ? " is-hot" : ""}`}>{dayOrders.length}</span>
                      )}
                    </div>
                    {dayOrders.length > 0 && (
                      <div className="cal-load-bar" aria-hidden="true">
                        <div className={`cal-load-fill${hasHot ? " is-danger" : dayOrders.length >= 5 ? " is-warn" : ""}`}
                             style={{ width: `${loadPct}%` }} />
                      </div>
                    )}
                    <div className="cal-pills">
                      {visible.map((o) => (
                        <button key={o.no} type="button"
                                className={`cal-pill ${orderToneClass(o, todayKey)}`}
                                title={`${o.no}${o.customer ? ` · ${o.customer}` : ""} · ${o.status_label ?? ""}`}
                                onClick={(e) => { e.stopPropagation(); navigate(`auftraege/${o.no}`); }}>
                          {o.rush && <Icon icon="flash" size={10} intent="danger" />}
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
            const isToday = key === todayKey;
            return (
              <div key={key} className={`cal-week-col${isToday ? " is-today" : ""}`}>
                <div className="cal-week-col-head">
                  <strong>{DOW[di]} {d.getDate()}.{d.getMonth() + 1}.</strong>
                  <Tag minimal round>{dayOrders.length}</Tag>
                </div>
                <div className="cal-week-cards">
                  {dayOrders.length === 0 && <span className="sub">Keine Termine</span>}
                  {dayOrders.map((o) => (
                    <div key={o.no} className={`cal-week-card ${orderToneClass(o, todayKey)}`}
                         onClick={() => navigate(`auftraege/${o.no}`)}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                        <span className="mono" style={{ fontWeight: 600 }}>{o.no}</span>
                        {o.rush && <Tag minimal intent="danger" icon="flash">Eil</Tag>}
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {o.customer || (o.kind === "internal" ? "Intern" : "—")}
                      </div>
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

      {/* AGENDA-ANSICHT */}
      {view === "agenda" && (
        agendaDays.length === 0 ? (
          <NonIdealState icon="calendar" title="Keine Termine im Filter"
                         description="Filter anpassen oder einen neuen Auftrag anlegen." />
        ) : (
          <div className="cal-agenda">
            {agendaDays.map(([dayKey, list]) => {
              const isToday = dayKey === todayKey;
              const isPastOpen = dayKey < todayKey && list.some((o) => !o.cancelled_at && !isDoneOrder(o));
              const dt = new Date(`${dayKey}T00:00:00`);
              const label = dt.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
              return (
                <div key={dayKey} className="cal-agenda-group">
                  <div className={`cal-agenda-head${isToday ? " is-today" : isPastOpen ? " is-overdue" : ""}`}>
                    <span>{isToday ? `Heute — ${label}` : label}</span>
                    <Tag minimal intent={isPastOpen ? "danger" : isToday ? "primary" : "none"}>
                      {list.length} {list.length === 1 ? "Auftrag" : "Aufträge"}
                    </Tag>
                  </div>
                  {list.map((o) => (
                    <div key={o.no} className="cal-agenda-item" onClick={() => navigate(`auftraege/${o.no}`)}>
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {o.rush && <Icon icon="flash" size={12} intent="danger" style={{ marginRight: 4 }} />}
                        {o.no}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <b>{o.customer || "—"}</b>
                        {o.customer_ref && <span className="sub"> · {o.customer_ref}</span>}
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

      {/* Ohne Termin */}
      {showUnscheduled && unscheduled.length > 0 && (
        <Callout intent="primary" icon="time" title={`Aufträge ohne Zusage-Termin (${unscheduled.length})`} style={{ marginTop: 14 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {unscheduled.map((o) => (
              <Button key={o.no} small outlined icon="document"
                      text={`${o.no}${o.customer ? ` · ${o.customer}` : ""}`}
                      onClick={() => navigate(`auftraege/${o.no}`)} />
            ))}
          </div>
        </Callout>
      )}

      {/* Tages-Detail-Drawer */}
      <Drawer
        open={selectedDay !== null}
        onClose={() => setSelectedDay(null)}
        title={selectedDay ? `Termine am ${fmtDate(selectedDay)}` : ""}
        sub={`${selectedDayOrders.length} ${selectedDayOrders.length === 1 ? "Auftrag" : "Aufträge"} fällig`}
      >
        <div className="cal-drawer-list">
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                <span className="sub mono">
                  {o.n_positions != null ? `${o.n_done ?? 0}/${o.n_positions} Positionen` : ""}
                  {office && o.kind !== "internal" && o.gross != null ? ` · ${fmtEur(o.gross)}` : ""}
                </span>
                <Button small minimal intent="primary" rightIcon="arrow-right" text="Auftrag öffnen"
                        onClick={() => { setSelectedDay(null); navigate(`auftraege/${o.no}`); }} />
              </div>
            </div>
          ))}
        </div>
      </Drawer>
    </PageFrame>
  );
}
