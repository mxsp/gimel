import { Button, Callout, Icon, Tag } from "@blueprintjs/core";
import { SectionLoading } from "../components/PageStates";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isWorker } from "../api";
import { PickMaterial, WorklistData } from "../factory";
import { Today, TodayOrder, TodayRow, buildToday } from "../heute";
import { navigate } from "../router";
import { plural } from "../plural";
import { KpiStrip, PageFrame, useDetail } from "../ui";
import FirstSteps from "../components/FirstSteps";
import OrderPipelineBar from "../components/OrderPipelineBar";
import { ServerOrderSummary, summarizeOrderFlow, summaryFromServer } from "../orderFlow";
import { getUser, canAdminWork } from "../api";

/* Heute — die Startseite. Oben das, was brennt; rechts, was an jeder Station
   als Nächstes dran ist. Jede Zeile ist ein Link an die Stelle, an der man es
   erledigt.

   Ein Abschnitt sagt nur dann „nichts", wenn seine Quelle wirklich geantwortet
   hat. Eine Zeile „Nichts überfällig" neben einem Abruf, der fehlgeschlagen
   ist, wäre schlimmer als gar keine Seite. */

const REFRESH_MS = 30_000;
const SHOWN_ROWS = 5;
const ORDER_WINDOW = 100;

interface Stats {
  orders: number;
  positions_pending: number;
  work_orders_open: number;
  work_orders_running: number;
  saved_pct_30d: number;
}

interface Sources {
  orders: TodayOrder[] | null;
  ordersTotal: number;
  summary: ServerOrderSummary | null;
  work: WorklistData | null;
  materials: PickMaterial[] | null;
  stats: Stats | null;
}

const EMPTY: Sources = { orders: null, ordersTotal: 0, summary: null, work: null, materials: null, stats: null };

export default function Heute() {
  const { simple } = useDetail();
  const office = !isWorker();
  const user = getUser();
  const role = !office ? "worker" : canAdminWork(user) ? "admin" : "staff";
  const [src, setSrc] = useState<Sources>(EMPTY);
  const [failed, setFailed] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusTab, setFocusTab] = useState<"ueberfaellig" | "blockiert" | "gefahr" | "material">("ueberfaellig");
  const [userPickedTab, setUserPickedTab] = useState(false);
  const [showIdleStations, setShowIdleStations] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const [recentOrders, overdueOrders, blockedOrders, orderSummary, work, picking, stats] = await Promise.allSettled([
      api<{ items: TodayOrder[]; total: number }>(`/api/admin/orders?limit=${ORDER_WINDOW}`),
      api<{ items: TodayOrder[]; total: number }>("/api/admin/orders?due=overdue&limit=100"),
      api<{ items: TodayOrder[]; total: number }>("/api/admin/orders?status=gesperrt&limit=100"),
      api<ServerOrderSummary>("/api/admin/orders/summary"),
      api<WorklistData>("/api/factory/worklist"),
      api<WorklistData>("/api/factory/picking"),
      office ? api<Stats>("/api/admin/stats") : Promise.resolve(null),
    ]);
    // Gezielte Ausschnitte (überfällig, gesperrt, aktuell) zusammenführen — so
    // bleiben auch alte überfällige Aufträge bei Millionen Datensätzen sichtbar.
    const mergedOrders = (() => {
      if (recentOrders.status !== "fulfilled" && overdueOrders.status !== "fulfilled" && blockedOrders.status !== "fulfilled") {
        return null;
      }
      const byNo = new Map<string, TodayOrder>();
      for (const res of [overdueOrders, blockedOrders, recentOrders]) {
        if (res.status === "fulfilled") {
          for (const item of res.value.items ?? []) {
            if (!byNo.has(item.no)) byNo.set(item.no, item);
          }
        }
      }
      return [...byNo.values()];
    })();
    const validSummary =
      orderSummary.status === "fulfilled" &&
      orderSummary.value &&
      typeof orderSummary.value.total === "number"
        ? orderSummary.value
        : null;
    // Was gerade nicht antwortet, behält seinen letzten Stand und wird oben genannt.
    setSrc((prev) => ({
      orders: mergedOrders ?? prev.orders,
      ordersTotal: validSummary
        ? validSummary.total
        : recentOrders.status === "fulfilled"
          ? recentOrders.value.total ?? 0
          : prev.ordersTotal,
      summary: validSummary ?? prev.summary,
      work: work.status === "fulfilled" ? work.value : prev.work,
      materials: picking.status === "fulfilled" ? picking.value.materials ?? [] : prev.materials,
      stats: stats.status === "fulfilled" ? stats.value : prev.stats,
    }));
    const missing = [
      mergedOrders === null && "Aufträge",
      work.status === "rejected" && "Arbeitsvorrat",
      picking.status === "rejected" && "Kommissionierung",
      stats.status === "rejected" && "Kennzahlen",
    ].filter(Boolean) as string[];
    setFailed(missing);
    if (missing.length < 3) setUpdatedAt(new Date());
    setBusy(false);
    inFlight.current = false;
  }, [office]);

  useEffect(() => {
    load();
    const tick = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const nowMs = (updatedAt ?? new Date()).getTime();
  const today: Today = useMemo(() => buildToday(
    src.orders ?? [], src.work, src.materials ?? [], office ? "lager" : "kommissionierung",
    nowMs,
  ), [src, office, nowMs]);
  const flowSummary = useMemo(
    () => (src.summary
      ? summaryFromServer(src.summary)
      : (src.orders && src.orders.length > 0 ? summarizeOrderFlow(src.orders, nowMs) : null)),
    [src.summary, src.orders, nowMs],
  );

  const loaded = src.orders || src.work || src.materials;
  const dateLine = new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
  const nLate = src.summary ? src.summary.overdue : today.late.length;
  const summary = [
    src.orders ? plural(nLate, "Auftrag überfällig", "Aufträge überfällig") : "",
    src.work ? plural(today.blocked.length, "Vorgang blockiert", "Vorgänge blockiert") : "",
    src.materials ? plural(today.material.length, "Werkstoff fehlt", "Werkstoffe fehlen") : "",
  ].filter(Boolean).join(", ");

  // Automatisch den ersten nicht-leeren Engpass-Reiter vorauswählen, solange der Nutzer keinen gewählt hat.
  useEffect(() => {
    if (userPickedTab || !loaded) return;
    if (nLate > 0) setFocusTab("ueberfaellig");
    else if (today.blocked.length > 0) setFocusTab("blockiert");
    else if (today.atRisk.length > 0) setFocusTab("gefahr");
    else if (today.material.length > 0) setFocusTab("material");
  }, [userPickedTab, loaded, nLate, today.blocked.length, today.atRisk.length, today.material.length]);

  const busyNext = useMemo(() => today.next.filter((r) => !r.idle), [today.next]);
  const shownNext = showIdleStations || busyNext.length === 0 ? today.next : busyNext;
  const hiddenIdleCount = today.next.length - busyNext.length;

  const focusTabs: Array<{
    id: "ueberfaellig" | "blockiert" | "gefahr" | "material";
    label: string;
    count: number;
    tone: "danger" | "warning";
    known: boolean;
    rows: TodayRow[];
    empty: string;
  }> = [
    { id: "ueberfaellig", label: "Überfällig", count: nLate, tone: "danger", known: !!src.orders, rows: today.late, empty: "Nichts überfällig" },
    { id: "blockiert", label: "Blockiert", count: today.blocked.length, tone: "warning", known: !!src.orders && !!src.work, rows: today.blocked, empty: "Nichts blockiert" },
    { id: "gefahr", label: "Zusage in Gefahr", count: today.atRisk.length, tone: "warning", known: !!src.work, rows: today.atRisk, empty: "Keine Zusage in Gefahr" },
    { id: "material", label: "Material fehlt", count: today.material.length, tone: "danger", known: !!src.materials, rows: today.material, empty: "Material für alle offenen Aufgaben da" },
  ];
  const activeFocus = focusTabs.find((t) => t.id === focusTab) ?? focusTabs[0];

  return (
    <PageFrame
      className="heute"
      title="Heute"
      sub={`${dateLine}${updatedAt ? ` · Stand ${updatedAt.toLocaleTimeString("de-DE")}` : ""}`}
      actions={<>
        <Button small icon="refresh" text="Aktualisieren" loading={busy && !!loaded} onClick={load} />
        {office && <Button small intent="primary" icon="plus" text="Neuer Auftrag" onClick={() => navigate("auftragserfassung")} />}
      </>}
    >
      <p className="sr-only" role="status">{summary}</p>

      <FirstSteps role={role} hasData={src.ordersTotal > 0} />

      {failed.length > 0 && (
        <Callout compact intent="warning" icon="warning-sign" className="mb">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span>Nicht aktuell: {failed.join(", ")}. Der Abruf wird alle 30 Sekunden wiederholt.</span>
            <Button small icon="refresh" text="Jetzt erneut laden" onClick={load} />
          </div>
        </Callout>
      )}

      {flowSummary && <OrderPipelineBar summary={flowSummary} linkMode />}

      {!loaded && !failed.length ? <SectionLoading /> : !loaded && failed.length > 0 ? (
        <Callout intent="danger" icon="error" title="Daten konnten nicht geladen werden">
          <p>Die Übersicht konnte den Server nicht erreichen ({failed.join(", ")}). Bitte erneut versuchen oder neu anmelden.</p>
          <Button small intent="primary" icon="refresh" text="Erneut versuchen" onClick={load} />
        </Callout>
      ) : (
        <div className="heute-grid">
          <div className="heute-col">
            <section
              className={`heute-sec heute-focus${activeFocus.count > 0 ? ` heute-sec-${activeFocus.tone}` : ""}`}
              aria-label="Handlungsbedarf"
            >
              <div className="heute-focus-tabs" role="tablist" aria-label="Engpässe">
                {focusTabs.map((t) => {
                  const selected = t.id === activeFocus.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      className={`heute-focus-tab${selected ? " is-active" : ""}${t.count > 0 ? ` is-${t.tone}` : ""}`}
                      onClick={() => { setFocusTab(t.id); setUserPickedTab(true); }}
                    >
                      <span>{t.label}</span>
                      <span className="heute-focus-badge">{t.count.toLocaleString("de-DE")}</span>
                    </button>
                  );
                })}
              </div>
              <SectionBody
                known={activeFocus.known}
                rows={activeFocus.rows}
                empty={activeFocus.empty}
                limit={simple ? SHOWN_ROWS : 12}
              />
            </section>
            {src.ordersTotal > ORDER_WINDOW && (
              <p className="sub">Geprüft sind die neuesten {ORDER_WINDOW.toLocaleString("de-DE")} von {src.ordersTotal.toLocaleString("de-DE")} Aufträgen.</p>
            )}
          </div>
          <div className="heute-col">
            <Section
              id="naechstes"
              title="Als Nächstes je Station"
              count={busyNext.length > 0 ? busyNext.length : today.next.length}
              tone="plain"
              known={!!src.work}
              rows={shownNext}
              empty="Keine Station mit laufender Warteschlange"
              limit={simple ? SHOWN_ROWS : 12}
              footer={hiddenIdleCount > 0 ? (
                <Button
                  small
                  minimal
                  text={showIdleStations ? "Nur aktive Stationen zeigen" : `Alle ${today.next.length} Stationen (${hiddenIdleCount} ohne Auftrag)`}
                  onClick={() => setShowIdleStations((v) => !v)}
                />
              ) : undefined}
            />
          </div>
        </div>
      )}

      {office && src.stats && !simple && (
        <KpiStrip label="Kennzahlen" className="heute-kpis" items={[
          { id: "orders", label: "Aufträge gesamt", value: src.stats.orders, href: "#/auftraege" },
          { id: "pending", label: "Wartende Positionen", value: src.stats.positions_pending, href: "#/disposition" },
          { id: "open", label: "Innenaufträge offen", value: src.stats.work_orders_open, href: "#/produktion" },
          { id: "running", label: "Laufend in Fertigung", value: src.stats.work_orders_running, href: "#/produktion" },
          { id: "saved", label: "Gesparte Fläche (30 Tage)",
            value: src.stats.saved_pct_30d ? `${src.stats.saved_pct_30d.toLocaleString("de-DE")} %` : "—" },
        ]} />
      )}
    </PageFrame>
  );
}

function SectionBody({ known, rows, empty, limit = SHOWN_ROWS, footer }: {
  known: boolean; rows: TodayRow[]; empty: string; limit?: number; footer?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, limit);
  if (!known) return <p className="heute-empty">Noch kein Stand.</p>;
  if (!rows.length) return <p className="heute-empty"><Icon icon="tick-circle" aria-hidden="true" /> {empty}</p>;
  return (
    <ul className="heute-rows">
      {shown.map((r) => <Row key={r.key} row={r} />)}
      {(rows.length > limit || footer) && (
        <li className="heute-rows-foot">
          {rows.length > limit && (
            <Button small minimal
                    text={expanded ? "Weniger anzeigen" : `Alle ${rows.length} anzeigen`}
                    onClick={() => setExpanded((v) => !v)} />
          )}
          {footer}
        </li>
      )}
    </ul>
  );
}

function Section({ id, title, count, tone, known, rows, empty, limit = SHOWN_ROWS, footer }: {
  id: string; title: string; count?: number; tone: "danger" | "warning" | "plain"; known: boolean;
  rows: TodayRow[]; empty: string; limit?: number; footer?: React.ReactNode;
}) {
  const hot = (count ?? 0) > 0 && tone !== "plain";
  return (
    <section className={"heute-sec" + (hot ? ` heute-sec-${tone}` : "")} aria-labelledby={`heute-${id}`}>
      <h2 id={`heute-${id}`} className="heute-sec-head">
        {count !== undefined && <span className="heute-count">{count.toLocaleString("de-DE")}</span>}
        {title}
      </h2>
      <SectionBody known={known} rows={rows} empty={empty} limit={limit} footer={footer} />
    </section>
  );
}

function Row({ row }: { row: TodayRow }) {
  return (
    <li>
      <a className="heute-row" href={`#/${row.to}`}>
        <span className="heute-row-main">
          <span className="heute-ref">{row.ref}</span>
          {row.what && <span className="heute-what">{row.what}</span>}
          {row.why && <span className="heute-why">{row.why}</span>}
        </span>
        {row.tag && <Tag minimal intent={row.tone === "none" ? undefined : row.tone}>{row.tag}</Tag>}
        <Icon icon="chevron-right" aria-hidden="true" className="heute-go" />
      </a>
    </li>
  );
}
