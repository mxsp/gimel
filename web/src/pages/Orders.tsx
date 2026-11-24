import OrderImport from "../components/OrderImport";
import { Button, Dialog, FormGroup, HTMLSelect, HTMLTable, Icon, InputGroup, Menu, MenuDivider, MenuItem, Spinner, Tab, Tabs, Tag } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import NonIdealState from "../components/NonIdealState";
import { RefLink, RelatedPanel } from "../components/RefLink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiDownload, fmtDate, fmtDateTime, fmtEur, isAbortError, isWorker } from "../api";
import { navigate, useHashQuery, useHashRoute } from "../router";
import { ORDER_PHASES, OrderPhase, orderPhase, workOrderStatus } from "../status";
import OrderLifecycleDialog, { LifecycleMode, resumeOrder } from "../components/OrderLifecycle";
import OrderPipelineBar from "../components/OrderPipelineBar";
import OrderPathStepper, { TimelineStep } from "../components/OrderPathStepper";
import {
  ORDER_FLOW_STAGES, ServerOrderSummary, dueBadge, filterLabel, isOrderLeftBuilding, isOrderOverdue,
  matchesOrderFilter, nextOrderStep, summarizeOrderFlow, summaryFromServer,
} from "../orderFlow";
import Callout from "../components/Callout";
import { toastError, toastSuccess } from "../toast";
import { SectionError, SectionLoading } from "../components/PageStates";
import { paymentWays } from "../constants";
import { undoable } from "../undo";
import OrderScope from "../components/OrderScope";
import { scopeMatters, useTopology } from "../sites";
import { engineText } from "../engine";
import {
  Drawer, FilterGroup, FilterPopover, FilterTag, HintDetails, KV, More, PageFrame, PaginationBar,
  SortControl, StatusChip, Toolbar, ViewMenu, readStore, sortRows, statusFromFlags, useDetail, useHiddenColumns,
  useSortPref, writeStore,
} from "../ui";
import type { KVRow, SortField, ViewColumn } from "../ui";

interface DeskOrder {
  no: string; created_at: string;
  kind?: string; internal_owner?: string;
  customer_id: number | null; customer_name: string; customer_email: string;
  customer_ref: string; cert: string;
  net: number; vat: number; gross: number;
  blocked: boolean; released: boolean; release_note: string;
  paid: boolean; paid_at: string | null; payment_method: string;
  invoice_no: string; invoiced_at: string | null; invoice_due_at: string | null;
  due_date: string | null; rush: boolean; n_positions: number; n_done?: number;
  held_at?: string | null; hold_reason?: string; cancelled_at?: string | null; cancel_reason?: string;
  status?: string; status_label?: string; shipments?: Array<{ no: string; status: string; carrier: string; tracking: string }>; work_orders?: Array<{ no: string; status: string }>;
}
interface Position {
  id: number; label: string; mat: string; thk: number; qty: number;
  od: number; di: number; production_status: string; status_text: string;
  work_order_no: string;
  /*: Herkunft aus der Formenbibliothek — leer bei DXF, KI und Handarbeit. */
  shape_id?: number | null; shape_key?: string; shape_label?: string;
}
interface PriceCheck {
  checked?: boolean;
  agrees?: boolean;
  charged_gross_cents?: number;
  engine_gross_cents?: number;
  delta_gross_cents?: number;
  engine_version?: string;
}
interface AdminOrder {
  no: string; kind?: string; internal_owner?: string;
  customer: string; customer_ref: string; cert: string;
  net: number; vat: number; gross: number; engine_version: string;
  blocked: boolean; released: boolean; release_note: string;
  office_note?: string;
  price_check?: PriceCheck;
  paid: boolean; paid_at: string | null; payment_method: string; payment_ref: string;
  held_at?: string | null; hold_reason?: string; cancelled_at?: string | null; cancel_reason?: string;
  due_date: string | null; rush: boolean;
  ship_address: Record<string, string>;
  bill_address?: Record<string, string>;
  created_at: string;
  positions: Position[];
  work_orders: Array<{ no: string; mat?: string; thk?: number; status?: string; engine_version?: string;
    run_no?: string; own_parts?: number; own_tags?: string[]; plates?: number[]; n_plates?: number; n_done_plates?: number; n_orders?: number }>;
  shipments: Array<{ no: string; status?: string; carrier?: string; tracking?: string; n_items?: number }>;
  audit: Array<{ at: string; actor: string; action: string; detail: Record<string, unknown> }>;
}
interface Links {
  order_no: string; invoice_no: string; number: string; status: string;
  total_cents: number; recipient: string;
  verwendungszweck: string;
  payment_methods: string[];
  hosted_url: string; dashboard_url: string; has_copy: boolean; live: boolean;
}

const SHIPMENT_LABELS: Record<string, { label: string; intent: "warning" | "primary" | "success" | "danger" | "none" }> = {
  packing: { label: "in Vorbereitung", intent: "warning" },
  shipped: { label: "versendet", intent: "primary" },
  delivered: { label: "zugestellt", intent: "success" },
  returned: { label: "Rücksendung", intent: "danger" },
};

const ORDER_COLUMNS_KEY = "gimel-orders-columns";
const ORDER_COLUMNS: ViewColumn[] = [
  { id: "referenz", label: "Referenz" },
  { id: "erstellt", label: "Erstellt" },
  { id: "brutto", label: "Brutto" },
  { id: "rechnung", label: "Rechnung" },
  { id: "zahlung", label: "Zahlung" },
  { id: "zertifikat", label: "Zertifikat" },
];
const ORDER_COLUMNS_HIDDEN = ORDER_COLUMNS.map((column) => column.id);
const ORDER_SORT_FIELDS: SortField[] = [
  { id: "no", label: "Nummer" },
  { id: "customer_name", label: "Kunde" },
  { id: "created_at", label: "Erstellt" },
  { id: "due_date", label: "Fällig" },
  { id: "gross", label: "Brutto" },
  { id: "status", label: "Fertigungsstand" },
];
const DUE_FILTERS: Array<[string, string]> = [
  ["alle", "alle Termine"],
  ["ueberfaellig", "überfällig"],
  ["woche", "fällig in 7 Tagen"],
  ["ohne", "ohne Termin"],
];
const DAY_MS = 86_400_000;
const PHASE_ORDER = Object.keys(ORDER_PHASES);

/* Die optionalen Spalten sind zu Beginn zu; erst das Ansichtsmenü holt sie
   hervor. Ein eigener Merker hält „alle Spalten an" auch dann fest, wenn die
   Auswahl leer ist und der Spalteneintrag deshalb gelöscht wird. */
function useDefaultHidden(key: string, defaults: string[]) {
  const marker = `${key}-init`;
  const { hidden, toggle, reset, setHidden } = useHiddenColumns(key);
  const [ready, setReady] = useState(() => readStore(marker) !== null);
  useEffect(() => {
    if (readStore(marker) === null) {
      writeStore(marker, "1");
      setHidden(defaults);
    }
    setReady(true);
  }, [defaults, marker, setHidden]);
  return { hidden, toggle, reset, ready };
}

const addr = (a: Record<string, string> | undefined) =>
  a && Object.keys(a).length
    ? [a.company, a.contact, a.street, [a.zip, a.city].filter(Boolean).join(" "), a.country].filter(Boolean).join(" · ")
    : "—";

// Rechnungsanschrift — leer oder identisch mit der Lieferanschrift ist der
// Normalfall und wird als solcher gesagt, nicht noch einmal aufgeschrieben.
const billAddr = (bill: Record<string, string> | undefined, ship: Record<string, string>) =>
  !bill || !Object.keys(bill).length || JSON.stringify(bill) === JSON.stringify(ship)
    ? "wie Lieferanschrift"
    : addr(bill);

/* Ein Zustand je Zeile: die Fertigungsphase führt, Eil, Intern, Rechnung,
   Zahlung und Versand stehen als Zusätze dahinter statt als fünf Etiketten. */
function orderStatus(o: DeskOrder, office: boolean) {
  const phase = ORDER_PHASES[orderPhase(o)];
  const internal = o.kind === "internal";
  const shipment = o.shipments?.[0];
  const status = statusFromFlags([
    { label: phase.label, tone: phase.intent, on: true, title: "Fertigungsstand" },
    { label: "Intern", tone: "primary", on: internal },
    {
      label: o.invoice_no ? "Rechnung gestellt" : "ohne Rechnung",
      tone: o.invoice_no ? "success" : "none",
      on: office && !internal,
      title: o.invoiced_at ? fmtDateTime(o.invoiced_at) : undefined,
    },
    {
      label: o.paid ? "bezahlt" : o.invoice_no ? "Zahlung offen" : "ohne Zahlung",
      tone: o.paid ? "success" : o.invoice_no ? "warning" : "none",
      on: office && !internal,
    },
    {
      label: shipment ? `Versand${shipment.carrier ? ` ${shipment.carrier}` : ""}` : "Versand",
      tone: "primary",
      on: !!shipment,
      title: shipment?.tracking ? `${shipment.carrier ? `${shipment.carrier} ` : ""}${shipment.tracking}`.trim() : undefined,
    },
  ]);
  return {
    primary: status.primary ? { ...status.primary, icon: phase.icon } : undefined,
    extras: status.extras,
  };
}

export default function Orders() {
  const sites = useTopology();
  const queryParams = useHashQuery();
  const qStatus = queryParams.get("status");
  const qDue = queryParams.get("due");
  const [rows, setRows] = useState<DeskOrder[] | null>(null);
  const [total, setTotal] = useState(0);
  const [serverSummary, setServerSummary] = useState<ServerOrderSummary | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState(() => qStatus || "alle");
  const [due, setDue] = useState(() => qDue || "alle");
  const { sort, setSort } = useSortPref("gimel-orders-sort", ORDER_SORT_FIELDS);
  const abortRef = useRef<AbortController | null>(null);
  const [openNo, setOpenNo] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminOrder | null>(null);
  const [detailError, setDetailError] = useState("");
  const [links, setLinks] = useState<Links | null>(null);
  const [busy, setBusy] = useState(false);
  const [timeline, setTimeline] = useState<TimelineStep[] | null>(null);
  const [tab, setTab] = useState("uebersicht");
  const [cloneBusy, setCloneBusy] = useState<string | null>(null);
  const [paidBusy, setPaidBusy] = useState<string | null>(null);
  const [payDialog, setPayDialog] = useState<{ no: string; paid: boolean } | null>(null);
  const [payMethod, setPayMethod] = useState("extern");
  const [payRef, setPayRef] = useState("");
  const [life, setLife] = useState<{ no: string; mode: LifecycleMode } | null>(null);
  const { hidden, toggle, reset, ready } = useDefaultHidden(ORDER_COLUMNS_KEY, ORDER_COLUMNS_HIDDEN);
  // Werker sehen den Fertigungsstand, nicht Geld und Freigaben.
  const office = !isWorker();
  const { simple } = useDetail();
  const showColumn = (id: string) => office && ready && !hidden.includes(id);
  const showRef = office ? showColumn("referenz") : true;
  const showCreated = office ? showColumn("erstellt") : true;

  // Deep-Link-Filter von Heute (#/auftraege?status=... oder ?due=ueberfaellig) übernehmen.
  useEffect(() => {
    if (qStatus) { setFilter(qStatus); setDue(qDue || "alle"); setOffset(0); }
    else if (qDue) { setDue(qDue); setFilter("alle"); setOffset(0); }
  }, [qStatus, qDue]);

  const toServerStatus = (f: string): string => {
    const map: Record<string, string> = {
      alle: "all",
      aktiv: "offen",
      offen: "unbezahlt",
      bezahlt: "bezahlt",
      "stage:eingang": "eingang",
      "stage:fertigung": "in_produktion",
      eingeplant: "in_produktion",
      laufend: "in_produktion",
      wartet: "wartet",
      freigegeben: "freigegeben",
      versandbereit: "versandbereit",
      versand: "versand",
      abgeschlossen: "abgeschlossen",
      gesperrt: "gesperrt",
      angehalten: "angehalten",
      storniert: "storniert",
    };
    return map[f] ?? "all";
  };

  const toServerDue = (d: string): string => {
    if (d === "ueberfaellig") return "overdue";
    if (d === "woche") return "week";
    if (d === "ohne") return "none";
    return "all";
  };

  const toServerSort = (field: string): string => {
    if (field === "no") return "no";
    if (field === "due_date") return "due";
    if (field === "gross") return "gross";
    if (field === "customer_name") return "customer";
    return "created";
  };

  const load = useCallback(async (
    query = q,
    nextOffset = offset,
    nextLimit = pageSize,
    nextFilter = filter,
    nextDue = due,
    nextSort = sort,
  ) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoadingPage(true);
    try {
      const params = new URLSearchParams({
        q: query,
        status: toServerStatus(nextFilter),
        due: toServerDue(nextDue),
        sort: toServerSort(nextSort.field),
        sort_dir: nextSort.dir,
        limit: String(nextLimit),
        offset: String(nextOffset),
      });
      const [r, sumRes] = await Promise.all([
        api<{ items: any[]; total: number } | DeskOrder[]>(`/api/admin/orders?${params.toString()}`, { signal: ctrl.signal }),
        api<ServerOrderSummary>(`/api/admin/orders/summary?q=${encodeURIComponent(query)}`, { signal: ctrl.signal }).catch(() => null),
      ]);
      if (sumRes && typeof sumRes.total === "number") setServerSummary(sumRes);
      if (Array.isArray(r)) {
        setRows(r as DeskOrder[]);
        setTotal(r.length);
      } else {
        const items = (r as any).items.map((x: any) => ({
          no: x.no, kind: x.kind, internal_owner: x.internal_owner,
          created_at: x.created_at, due_date: x.due_date, net: x.net, gross: x.gross,
          blocked: x.blocked, released: x.released, release_note: x.release_note ?? "",
          paid: x.paid, paid_at: x.paid_at, payment_method: x.payment_method,
          customer_name: x.customer, customer_email: "", customer_ref: x.customer_ref, cert: x.cert ?? "2.2",
          invoice_no: x.invoice_no ?? "", invoiced_at: x.invoiced_at ?? null, invoice_due_at: x.invoice_due_at ?? null,
          rush: x.rush, n_positions: x.n_positions, n_done: x.n_done ?? 0,
          held_at: x.held_at ?? null, hold_reason: x.hold_reason ?? "",
          cancelled_at: x.cancelled_at ?? null, cancel_reason: x.cancel_reason ?? "",
          status: x.status, status_label: x.status_label, shipments: x.shipments ?? [], work_orders: x.work_orders ?? [],
        }));
        setRows(items);
        setTotal(Number((r as any).total ?? items.length));
      }
      setLoadError("");
    } catch (err: any) {
      if (isAbortError(err)) return;
      try {
        const fallback = await api<DeskOrder[]>(`/api/desk/orders?q=${encodeURIComponent(query)}&limit=${nextLimit}&offset=${nextOffset}`);
        setRows(fallback);
        setTotal(fallback.length);
        setLoadError("");
      } catch (e: any) {
        if (!isAbortError(e)) setLoadError(e.message ?? String(e));
      }
    } finally {
      if (abortRef.current === ctrl) setLoadingPage(false);
    }
  }, [q, offset, pageSize, filter, due, sort]);

  // Sofortiges Laden beim Öffnen, danach verzögerte Live-Suche beim Tippen & serverseitige Filter/Sort/Seitenwechsel.
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; load(q, offset, pageSize, filter, due, sort); return; }
    const timer = setTimeout(() => { load(q, offset, pageSize, filter, due, sort); }, q.trim() ? 220 : 0);
    return () => clearTimeout(timer);
  }, [q, offset, pageSize, filter, due, sort, load]);

  const detailSeq = useRef(0);

  const loadTimeline = useCallback(async (no: string, seq = ++detailSeq.current) => {
    try {
      const r = await api<{ steps: TimelineStep[] }>(`/api/admin/orders/${no}/timeline`);
      if (detailSeq.current === seq) setTimeline(r.steps);
    } catch { if (detailSeq.current === seq) setTimeline(null); }
  }, []);

  const loadDetail = useCallback(async (no: string, seq = ++detailSeq.current) => {
    setDetailError("");
    try {
      const res = await api<AdminOrder>(`/api/admin/orders/${no}`);
      if (detailSeq.current === seq) setDetail(res);
    } catch (e: any) {
      if (detailSeq.current !== seq) return;
      const message = e.message ?? String(e);
      setDetailError(message);
      toastError(message);
    }
  }, []);

  const closeDrawer = useCallback(() => {
    ++detailSeq.current;
    setOpenNo(null); setDetail(null); setLinks(null); setTimeline(null); setDetailError("");
    setTab("uebersicht");
  }, []);

  const open = useCallback((o: DeskOrder) => {
    if (openNo === o.no) { closeDrawer(); return; }
    const seq = ++detailSeq.current;
    setOpenNo(o.no); setDetail(null); setDetailError(""); setLinks(null); setTimeline(null);
    setTab("uebersicht");
    loadDetail(o.no, seq);
    loadTimeline(o.no, seq);
    if (o.invoice_no && office) {
      api<Links>(`/api/invoicing/orders/${o.no}/invoice/links`)
        .then((l) => { if (detailSeq.current === seq) setLinks(l); })
        .catch(() => { if (detailSeq.current === seq) setLinks(null); });
    }
  }, [openNo, office, loadDetail, loadTimeline, closeDrawer]);

  // Deep-Link von „Heute": #/auftraege/AB-26-0012 öffnet den Auftrag in der
  // Schublade. Einmal je Nummer; wer sie schließt, soll sie beim nächsten
  // Laden nicht wieder aufgeklappt bekommen.
  const route = useHashRoute();
  const wanted = decodeURIComponent(route.split("/")[1] ?? "");
  const opened = useRef("");
  useEffect(() => {
    if (!wanted) { opened.current = ""; return; }
    if (!rows || opened.current === wanted) return;
    opened.current = wanted;
    if (openNo !== wanted) open(rows.find((o) => o.no === wanted) ?? ({ no: wanted } as DeskOrder));
  }, [wanted, rows, openNo, open]);

  const refresh = () => { load(q); if (openNo) { const seq = ++detailSeq.current; loadDetail(openNo, seq); loadTimeline(openNo, seq); } };

  const release = (no: string) =>
    undoable({
      run: () => api(`/api/desk/orders/${no}/release`, { method: "POST", body: JSON.stringify({ note: "" }) }),
      done: `${no} für die Fertigung freigegeben.`,
      after: refresh,
    });

  const unblock = (no: string) =>
    undoable({
      run: () => api(`/api/desk/orders/${no}/release`, { method: "POST", body: JSON.stringify({ unblock: true, note: "Sperre von Hand aufgehoben" }) }),
      done: `${no} entsperrt und freigegeben.`,
      after: refresh,
    });

  const clone = async (no: string) => {
    setCloneBusy(no);
    try {
      const r = await api<{ no: string; source: string }>(`/api/admin/orders/${no}/clone`, { method: "POST" });
      toastSuccess(`Neuer Auftrag ${r.no} aus ${r.source} angelegt — erneut bestellt.`);
      load(q);
    } catch (e: any) { toastError(e.message); } finally { setCloneBusy(null); }
  };

  const rollback = async (no: string, step: string) => {
    setBusy(true);
    try {
      const r = await api<{ rolled_back: string }>(`/api/admin/orders/${no}/rollback`, { method: "POST", body: JSON.stringify({ step }) });
      toastSuccess(`Zurückgerollt: ${r.rolled_back}`);
      refresh();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const markPaidExternal = async () => {
    if (!payDialog) return;
    setPaidBusy(payDialog.no);
    try {
      if (payDialog.paid) {
        await api(`/api/admin/orders/${payDialog.no}/paid`, { method: "POST", body: JSON.stringify({ paid: false, note: "" }) });
        toastSuccess(`${payDialog.no}: Zahlung zurückgenommen.`);
      } else {
        await api(`/api/admin/orders/${payDialog.no}/paid`, { method: "POST", body: JSON.stringify({ paid: true, method: payMethod || "extern", ref: payRef }) });
        toastSuccess(`${payDialog.no}: als extern bezahlt markiert.`);
      }
      setPayDialog(null); setPayRef(""); refresh();
    } catch (e: any) { toastError(e.message); } finally { setPaidBusy(null); }
  };

  const copyZweck = async (zweck: string) => {
    try { await navigator.clipboard.writeText(zweck); toastSuccess(`Verwendungszweck „${zweck}" kopiert.`); }
    catch { toastError(`Kopieren ging nicht — der Zweck lautet: ${zweck}`); }
  };

  const syncInvoice = async (no: string) => {
    setBusy(true);
    try {
      const r = await api<{ booked?: boolean; status: string }>(`/api/invoicing/orders/${no}/invoice/sync`, { method: "POST" });
      toastSuccess(r.booked ? "Zahlung gebucht — Rechnung bezahlt." : `Abgeglichen — Stripe führt sie als „${r.status}".`);
      refresh();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const pdf = async (o: { no: string }, number?: string) => {
    try { await apiDownload(`/api/invoicing/orders/${o.no}/invoice.pdf`, `Rechnung-${number || o.no}.pdf`); toastSuccess("PDF geladen."); }
    catch (e: any) { toastError(e.message); }
  };

  const nowMs = Date.now();
  const flowSummary = useMemo(
    () => (serverSummary ? summaryFromServer(serverSummary) : (rows ? summarizeOrderFlow(rows, nowMs) : null)),
    [serverSummary, rows, nowMs],
  );

  const dueDays = (o: DeskOrder) =>
    o.due_date ? Math.floor((new Date(o.due_date).getTime() - nowMs) / DAY_MS) : null;
  const shown = sortRows((rows ?? []).filter((o) => {
    const byStatus = matchesOrderFilter(o, filter);
    const days = dueDays(o);
    const left = isOrderLeftBuilding(o);
    const byDue = due === "alle" ? true
      : due === "ohne" ? days === null && !left
      : due === "ueberfaellig" ? isOrderOverdue(o, nowMs)
      : !left && days !== null && days >= 0 && days <= 7;
    return byStatus && byDue;
  }), sort, (o, field) => field === "status"
    ? PHASE_ORDER.indexOf(orderPhase(o))
    : (o as unknown as Record<string, unknown>)[field]);
  const dueLabel = DUE_FILTERS.find(([value]) => value === due)?.[1] ?? due;
  const filtersActive = (filter !== "alle" ? 1 : 0) + (due !== "alle" ? 1 : 0);

  const rowInvoice = detail ? rows?.find((r) => r.no === detail.no)?.invoice_no ?? "" : "";
  const hasInvoice = !!(links || rowInvoice);
  /* Formen dieses Auftrags — verdichtet aus den Positionen. Die Positionstabelle
     zeigt jede Zeile; hier steht, welche Hausformen insgesamt darin stecken. */
  const formSummary = (() => {
    const map = new Map<number, {
      id: number; key: string; label: string; positions: number; qty: number;
      workOrders: Set<string>;
    }>();
    for (const pos of detail?.positions ?? []) {
      if (!pos.shape_id) continue;
      const entry = map.get(pos.shape_id) ?? {
        id: pos.shape_id, key: pos.shape_key || "", label: pos.shape_label || "",
        positions: 0, qty: 0, workOrders: new Set<string>(),
      };
      entry.positions += 1;
      entry.qty += pos.qty;
      if (pos.work_order_no) entry.workOrders.add(pos.work_order_no);
      map.set(pos.shape_id, entry);
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  })();
  /* Büro-Schritte am Auftrag (Aufgabe 45), gleich in Zeilenmenü und Schublade. */
  const lifecycleItems = (o: { no: string; held_at?: string | null; hold_reason?: string; cancelled_at?: string | null }) =>
    o.cancelled_at ? null : (
      <>
        <MenuDivider />
        <MenuItem icon="edit" text="Termin, Eil, Notiz ändern …" onClick={() => setLife({ no: o.no, mode: "change" })} />
        {o.held_at
          ? <MenuItem icon="play" text="Fortsetzen" onClick={() => resumeOrder(o.no, o.hold_reason ?? "", refresh)} />
          : <MenuItem icon="stop" text="Anhalten …" onClick={() => setLife({ no: o.no, mode: "hold" })} />}
        <MenuItem icon="cross-circle" intent="danger" text="Stornieren …" onClick={() => setLife({ no: o.no, mode: "cancel" })} />
      </>
    );
  const primaryAction = detail && office
    ? detail.cancelled_at
      ? <Button small intent="primary" icon="duplicate" text="Erneut bestellen"
                loading={cloneBusy === detail.no} onClick={() => clone(detail.no)} />
      : detail.held_at
      ? <Button small intent="primary" icon="play" text="Fortsetzen"
                onClick={() => resumeOrder(detail.no, detail.hold_reason ?? "", refresh)} />
      : detail.blocked
      ? <Button small intent="warning" icon="unlock" text="Sperre aufheben" onClick={() => unblock(detail.no)} />
      : !detail.released
        ? <Button small intent="primary" icon="arrow-right" text="Freigeben" onClick={() => release(detail.no)} />
        : <Button small intent="primary" icon="duplicate" text="Erneut bestellen"
                  loading={cloneBusy === detail.no} onClick={() => clone(detail.no)} />
    : null;
  const payDialogContainer = (payDialog || life) && typeof document !== "undefined"
    ? document.querySelector<HTMLElement>(".ui-drawer") ?? undefined
    : undefined;

  return (
    <PageFrame
      title="Aufträge"
      sub={office ? "Auftragsweg, Fertigungs- und Rechnungsstand" : "Auftragsweg und Fertigungsstand"}
      actions={office ? (
        <Button small intent="primary" icon="new-object" text="Neuer Auftrag" onClick={() => navigate("auftragserfassung")} />
      ) : undefined}
      help={office ? [{
        title: "Im Auftrag",
        text: <p>„Erneut bestellen" legt aus den bestehenden Positionen und Adressen einen neuen Auftrag an. „Extern bezahlt" bucht ohne Stripe — für Barzahlung, Überweisung oder Sammelrechnung.</p>,
      }] : undefined}
    >
      {flowSummary && (flowSummary.total > 0 || (rows && rows.length > 0)) && (
        <OrderPipelineBar
          summary={flowSummary}
          activeFilter={filter}
          activeDue={due}
          onSelectFilter={(next) => { setFilter(next); setOffset(0); if (due === "ueberfaellig") setDue("alle"); }}
          onSelectOverdue={() => {
            setOffset(0);
            if (due === "ueberfaellig") setDue("alle");
            else { setDue("ueberfaellig"); setFilter("alle"); }
          }}
        />
      )}

      <Toolbar
        meta={total > pageSize
          ? `${(offset + 1).toLocaleString("de-DE")}–${(offset + shown.length).toLocaleString("de-DE")} von ${total.toLocaleString("de-DE")}`
          : `${shown.length.toLocaleString("de-DE")} von ${Math.max(total, rows?.length ?? 0).toLocaleString("de-DE")}`}
        end={<>
          {office && <OrderImport onDone={() => load()} />}
          {office && <ViewMenu columns={ORDER_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} />}
          <Button icon="refresh" text="Aktualisieren" loading={loadingPage} onClick={() => load(q)} />
        </>}
      >
        <InputGroup leftIcon="search" placeholder="Nummer, Kunde, Referenz…" value={q} style={{ width: 280 }}
                    rightElement={q ? <Button minimal small icon="cross" aria-label="Suche leeren" onClick={() => { setQ(""); setOffset(0); }} /> : undefined}
                    onChange={(e) => { setQ(e.target.value); setOffset(0); }} onKeyUp={(e) => { if (e.key === "Enter") load(q, 0); }} />
        <FilterPopover active={filtersActive} onClear={() => { setFilter("alle"); setDue("alle"); setOffset(0); }}>
          <FilterGroup label="Zustand">
            <HTMLSelect value={filter} aria-label="Aufträge filtern" onChange={(e) => { setFilter(e.currentTarget.value); setOffset(0); }}>
              <option value="alle">alle</option>
              <option value="aktiv">alle offenen</option>
              {ORDER_FLOW_STAGES.map((st) => <option key={st.filterKey} value={st.filterKey}>{st.label}</option>)}
              {(Object.keys(ORDER_PHASES) as OrderPhase[]).map((k) => <option key={k} value={k}>{ORDER_PHASES[k].label}</option>)}
              {office && <option value="offen">unbezahlt</option>}
              {office && <option value="bezahlt">bezahlt</option>}
            </HTMLSelect>
          </FilterGroup>
          <FilterGroup label="Termin">
            <HTMLSelect value={due} aria-label="Aufträge nach Termin filtern" onChange={(e) => { setDue(e.currentTarget.value); setOffset(0); }}>
              {DUE_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </HTMLSelect>
          </FilterGroup>
        </FilterPopover>
        <SortControl state={sort} fields={ORDER_SORT_FIELDS} onChange={(next) => { setSort(next); setOffset(0); }} />
        {filter !== "alle" && (
          <FilterTag
            label={filterLabel(filter, ORDER_PHASES)}
            onRemove={() => { setFilter("alle"); setOffset(0); }}
          />
        )}
        {due !== "alle" && <FilterTag label={dueLabel} onRemove={() => { setDue("alle"); setOffset(0); }} />}
      </Toolbar>

      {!rows ? (loadError ? <SectionError message={loadError} onRetry={() => load(q)} /> : <SectionLoading />) : shown.length === 0 ? (
        <NonIdealState
          icon="inbox"
          title={filtersActive > 0 || q.trim() ? "Keine passenden Aufträge" : "Keine Aufträge"}
          description={filtersActive > 0 || q.trim() ? "Filter oder Suche zurücksetzen, um wieder alle Aufträge zu sehen." : undefined}
          action={filtersActive > 0 || q.trim() ? <Button text="Filter zurücksetzen" onClick={() => { setFilter("alle"); setDue("alle"); setQ(""); }} /> : undefined}
        />
      ) : (
        <div className="table-scroll">
          <HTMLTable className="data-table" striped compact interactive tabIndex={0} aria-label="Aufträge">
            <thead>
              <tr>
                <th>Nr.</th><th>Kunde</th>
                {showRef && <th>Referenz</th>}
                {showCreated && <th>Erstellt</th>}
                <th>Fällig</th>
                {office && <th className="num">Netto</th>}
                {showColumn("brutto") && <th className="num">Brutto</th>}
                <th>{office ? "Auftragsweg & Status" : "Fertigung"}</th>
                {showColumn("rechnung") && <th>Rechnung</th>}
                {showColumn("zahlung") && <th>Zahlung</th>}
                {showColumn("zertifikat") && <th>Zertifikat</th>}
                {office && <th><span className="sr-only">Aktion</span></th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => {
                const internal = o.kind === "internal";
                const phase = orderPhase(o);
                const status = orderStatus(o, office);
                const urgency = dueBadge(o, nowMs);
                const showPosProgress = (o.n_positions ?? 0) > 0 && (phase === "eingeplant" || phase === "laufend" || phase === "versandbereit");
                const rowCls = [
                  openNo === o.no ? "row-active" : "",
                  phase === "storniert" ? "order-row-cancelled" : "",
                ].filter(Boolean).join(" ") || undefined;
                return (
                  <tr key={o.no} onClick={() => open(o)} className={rowCls}>
                    <td className="mono">
                      <span className="order-no-cell">
                        <b>{o.no}</b>
                        {o.rush && phase !== "storniert" && phase !== "abgeschlossen" && (
                          <Tag minimal intent="danger" className="order-rush-tag">Eil</Tag>
                        )}
                      </span>
                    </td>
                    <td>
                      <b>{o.customer_name || "—"}</b>
                      {internal
                        ? <div className="sub">Intern</div>
                        : o.customer_email ? <div className="sub">{o.customer_email}</div> : null}
                    </td>
                    {showRef && <td className="sub nw">{o.customer_ref || "—"}</td>}
                    {showCreated && <td className="sub nw">{fmtDate(o.created_at)}</td>}
                    <td className="nw">
                      <span className={urgency?.overdue ? "due-date-late" : "sub"}>{fmtDate(o.due_date)}</span>
                      {urgency && (
                        <span className={`due-pill due-pill-${urgency.tone}`}>{urgency.label}</span>
                      )}
                    </td>
                    {office && <td className="num mono">{fmtEur(o.net)}</td>}
                    {showColumn("brutto") && <td className="num mono"><b>{fmtEur(o.gross)}</b></td>}
                    <td>
                      <div className="order-status-cell">
                        <StatusChip primary={status.primary} extras={status.extras} />
                        {showPosProgress && (
                          <span className="order-pos-progress" title={`${o.n_done ?? 0} von ${o.n_positions} Positionen geschnitten`}>
                            <span className="order-pos-bar" aria-hidden="true">
                              <span style={{ width: `${Math.min(100, Math.round(((o.n_done ?? 0) / Math.max(1, o.n_positions)) * 100))}%` }} />
                            </span>
                            <span className="sub">{o.n_done ?? 0}/{o.n_positions}</span>
                          </span>
                        )}
                      </div>
                    </td>
                    {showColumn("rechnung") && (
                      <td>{internal ? "—" : o.invoice_no
                        ? <span className="mono" title={fmtDateTime(o.invoiced_at)}>{o.invoice_no}</span>
                        : <span className="sub">keine</span>}</td>
                    )}
                    {showColumn("zahlung") && (
                      <td>{internal ? "—" : o.paid
                        ? <span>bezahlt{o.paid_at ? ` ${fmtDate(o.paid_at)}` : ""}</span>
                        : o.invoice_no ? <span className="sub">offen</span> : "—"}</td>
                    )}
                    {showColumn("zertifikat") && <td className="mono">{o.cert || "—"}</td>}
                    {office && (
                      <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                        <KeyPopover placement="bottom-end" content={
                          <Menu>
                            <MenuItem icon="duplicate" text="Erneut bestellen"
                                      disabled={cloneBusy === o.no} onClick={() => clone(o.no)} />
                            {!internal && !o.paid && <MenuItem icon="euro" text="Extern bezahlt markieren"
                                      disabled={paidBusy === o.no}
                                      onClick={() => { setPayMethod("extern"); setPayRef(""); setPayDialog({ no: o.no, paid: false }); }} />}
                            {!internal && o.paid && <MenuItem icon="undo" text="Zahlung zurücknehmen"
                                      disabled={paidBusy === o.no} onClick={() => setPayDialog({ no: o.no, paid: true })} />}
                            {!internal && o.invoice_no && <MenuItem icon="document" text="Rechnung als PDF" onClick={() => pdf(o)} />}
                            {!o.cancelled_at && !o.released && !o.blocked && <MenuItem icon="arrow-right" text="Für die Fertigung freigeben" onClick={() => release(o.no)} />}
                            {!o.cancelled_at && o.blocked && <MenuItem icon="unlock" text="Sperre aufheben und freigeben" onClick={() => unblock(o.no)} />}
                            {!internal && o.invoice_no && !o.paid && <MenuItem icon="refresh" text="Zahlung bei Stripe prüfen"
                                      disabled={busy} onClick={() => syncInvoice(o.no)} />}
                            {lifecycleItems(o)}
                          </Menu>
                        }>
                          <Button small minimal icon="more" aria-label={`Aktionen für ${o.no}`} title="Aktionen" />
                        </KeyPopover>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </HTMLTable>
        </div>
      )}

      <PaginationBar
        offset={offset}
        limit={pageSize}
        total={total}
        count={rows?.length ?? 0}
        loading={loadingPage}
        noun="Aufträge"
        onChange={(nextOff, nextLim) => {
          setOffset(nextOff);
          if (nextLim !== undefined) setPageSize(nextLim);
        }}
      />

      <Drawer
        open={openNo !== null}
        onClose={closeDrawer}
        width="min(960px, 100vw)"
        title={<span className="mono">{detail?.no ?? openNo ?? "Auftrag"}</span>}
        sub={detail
          ? `${detail.kind === "internal" ? (detail.internal_owner || "Interner Auftrag") : (detail.customer || "—")}${detail.rush ? " · Eil" : ""}`
          : "Details werden geladen …"}
        actions={detail && office
          ? <div className="ui-inline-actions">
              {primaryAction}
              <KeyPopover placement="bottom-end" usePortal={false} content={
                <Menu>
                  {(detail.blocked || !detail.released || detail.held_at) && !detail.cancelled_at && (
                    <MenuItem icon="duplicate" text="Erneut bestellen"
                              disabled={cloneBusy === detail.no} onClick={() => clone(detail.no)} />
                  )}
                  {detail.kind !== "internal" && !detail.paid && (
                    <MenuItem icon="euro" text="Extern bezahlt markieren" disabled={paidBusy === detail.no}
                              onClick={() => { setPayMethod("extern"); setPayRef(""); setPayDialog({ no: detail.no, paid: false }); }} />
                  )}
                  {detail.kind !== "internal" && detail.paid && (
                    <MenuItem icon="undo" text="Zahlung zurücknehmen" disabled={paidBusy === detail.no}
                              onClick={() => setPayDialog({ no: detail.no, paid: true })} />
                  )}
                  {detail.kind !== "internal" && hasInvoice && (
                    <MenuItem icon="document" text="Rechnung als PDF" onClick={() => pdf(detail, links?.number)} />
                  )}
                  {detail.kind !== "internal" && hasInvoice && !detail.paid && (
                    <MenuItem icon="refresh" text="Zahlung bei Stripe prüfen" disabled={busy}
                              onClick={() => syncInvoice(detail.no)} />
                  )}
                  {lifecycleItems(detail)}
                </Menu>
              }>
                <Button small minimal icon="more" aria-label={`Weitere Aktionen für ${detail.no}`} title="Weitere Aktionen" />
              </KeyPopover>
            </div>
          : undefined}
      >
        {detailError ? (
          <SectionError message={detailError} onRetry={() => { if (openNo) loadDetail(openNo); }} />
        ) : !detail ? (
          <Spinner size={24} />
        ) : (
          <Tabs id="order-detail" selectedTabId={tab} onChange={(next) => setTab(String(next))} renderActiveTabPanelOnly>
            <Tab id="uebersicht" title="Übersicht" panel={(() => {
              /* Einfach: sechs Kernangaben und der Fortschritt; alles Weitere unter
                 „Alle Angaben" (Aufgabe 35 E). Alles: die volle Liste wie bisher. */
              const kvRows: KVRow[] = [
                  { label: "Auftragsart", value: detail.kind === "internal" ? "Intern — ohne Zahlung und Rechnung" : "Extern — Kunde und Rechnung" },
                  { label: detail.kind === "internal" ? "Verantwortlich" : "Kunde", value: detail.customer || "—" },
                  { label: "Bestellzeichen", value: detail.customer_ref || "—" },
                  { label: "Zeugnis", value: detail.cert ? detail.cert : "Kein Zeugnis (—)" },
                  ...(office ? [{ label: "Netto / Brutto", value: <span className="num-inline">{fmtEur(detail.net)} / {fmtEur(detail.gross)}</span> }] : []),
                  { label: "Preis-Rechenkern", value: <span className="mono" title="Preise rechnet immer lite — unabhängig vom Schachtel-Motor der Fertigung.">{engineText(detail.engine_version)}</span> },
                  { label: "Zusage", value: fmtDate(detail.due_date) },
                  ...(office && detail.kind !== "internal" ? [
                    { label: "Zahlweg", value: detail.payment_method === "invoice" ? "Rechnung" : (detail.payment_method || "—") },
                    { label: "Bezahlt", value: detail.paid ? fmtDateTime(detail.paid_at) : "nein" },
                  ] : []),
                  { label: "Freigabe", value: detail.cancelled_at ? "storniert" : detail.blocked ? `gesperrt — ${detail.release_note}` : detail.released ? (detail.release_note || "freigegeben") : "wartet" },
                  ...(office && sites.topo && scopeMatters(sites.topo) ? [
                    { label: "Fertigen in", value: <OrderScope kind="order" no={detail.no} topo={sites.topo} readOnly={!!detail.cancelled_at} /> },
                  ] : []),
                  ...(detail.kind !== "internal" ? [
                    // Anschriften sieht das Büro; die Halle findet sie im Versand (services/floor_view.py).
                    ...(office ? [{ label: "Lieferanschrift", value: addr(detail.ship_address) }] : []),
                    ...(office ? [{ label: "Rechnungsanschrift", value: billAddr(detail.bill_address, detail.ship_address) }] : []),
                  ] : []),
                ];
              const KEY = new Set<unknown>([
                detail.kind === "internal" ? "Verantwortlich" : "Kunde", "Bestellzeichen", "Zusage", "Freigabe",
                office ? "Netto / Brutto" : "Zeugnis", office && detail.kind !== "internal" ? "Bezahlt" : "Auftragsart",
              ]);
              const keyRows = kvRows.filter((r) => KEY.has(r.label));
              const restRows = kvRows.filter((r) => !KEY.has(r.label));
              const rowMatch = rows?.find((r) => r.no === detail.no);
              const nextStep = nextOrderStep({
                ...detail,
                status: rowMatch?.status,
                invoice_no: links?.invoice_no || rowMatch?.invoice_no || "",
              }, office);
              const pc = detail.price_check;
              const priceMismatch = office && detail.blocked && pc?.checked && pc.agrees === false;
              const primaryWo = detail.work_orders.find((w) => w.status === "running")?.no ?? detail.work_orders[0]?.no;
              const primaryShip = detail.shipments[0]?.no;
              const runNextAction = () => {
                if (nextStep.action === "unblock") unblock(detail.no);
                else if (nextStep.action === "release") release(detail.no);
                else if (nextStep.action === "resume") resumeOrder(detail.no, detail.hold_reason ?? "", refresh);
                else if (nextStep.action === "route" && nextStep.route) navigate(nextStep.route);
              };

              const progress = (
                <div className="ui-section">
                  <div className="ui-section-head">
                    <h2 className="ui-section-title">Auftragsweg</h2>
                    <span className="ui-section-count">{detail.cancelled_at ? "Storniert" : detail.held_at ? "Angehalten" : detail.blocked ? "In Klärung" : timeline?.find((s) => s.current)?.label || "Bestellt"}</span>
                  </div>
                  {timeline ? (
                    <OrderPathStepper
                      steps={timeline}
                      office={office}
                      busy={busy}
                      cancelled={!!detail.cancelled_at}
                      held={!!detail.held_at}
                      workOrderNo={primaryWo}
                      shipmentNo={primaryShip}
                      orderNo={detail.no}
                      onRollback={(stepId) => rollback(detail.no, stepId)}
                    />
                  ) : <p className="sub">Bearbeitung wird geladen …</p>}
                  <HintDetails title="Regeln zum Bearbeiten">
                    <p>Versand gilt erst als abgeschlossen, wenn alle Positionen vollständig versendet sind. Zahlung wird unabhängig von der Fertigung geführt.</p>
                    {office && <p>Jeder Schritt kann einzeln zurückgerollt werden — immer der letzte erledigte Schritt zuerst. So bleibt die Reihenfolge erhalten.</p>}
                  </HintDetails>
                </div>
              );
              return <>
                <div className={`order-next-bar order-next-${nextStep.tone}`} role="region" aria-label="Nächster Schritt">
                  <div className="order-next-copy">
                    <span className="order-next-kicker">Nächster Schritt</span>
                    <strong className="order-next-headline">{nextStep.headline}</strong>
                    <span className="order-next-reason">{nextStep.reason}</span>
                  </div>
                  {nextStep.ctaLabel && (
                    <Button
                      small
                      intent={nextStep.tone === "danger" ? "warning" : "primary"}
                      icon={nextStep.ctaIcon}
                      text={nextStep.ctaLabel}
                      onClick={runNextAction}
                    />
                  )}
                </div>

                {detail.cancelled_at ? (
                  <Callout icon="cross-circle" title={`Storniert am ${fmtDate(detail.cancelled_at)}`}>
                    {office && <b>Grund: {detail.cancel_reason || "nicht angegeben"}. </b>}Der Auftrag geht nicht mehr in die Fertigung.
                  </Callout>
                ) : detail.held_at ? (
                  <Callout intent="warning" icon="stop" title={`Angehalten seit ${fmtDate(detail.held_at)}`}>
                    {office && <b>Grund: {detail.hold_reason || "nicht angegeben"}. </b>}Der Sammellauf lässt den Auftrag liegen, bis er fortgesetzt wird.
                  </Callout>
                ) : null}

                {priceMismatch && (
                  <Callout intent="danger" icon="warning-sign" title="Preisabweichung bei Übernahme">
                    Kassiert <b className="num-inline">{fmtEur((pc?.charged_gross_cents ?? 0) / 100)}</b> ·{" "}
                    gerechnet <b className="num-inline">{fmtEur((pc?.engine_gross_cents ?? 0) / 100)}</b> ·{" "}
                    Abweichung <b className="num-inline">{((pc?.delta_gross_cents ?? 0) >= 0 ? "+" : "")}{fmtEur((pc?.delta_gross_cents ?? 0) / 100)}</b>
                    {pc?.engine_version ? ` (${pc.engine_version})` : ""}.
                  </Callout>
                )}

                {simple ? <>
                  <KV rows={keyRows} />
                  {progress}
                  <More label={`Alle Angaben (${restRows.length})`} less="Weniger Angaben">
                    <KV rows={restRows} />
                  </More>
                </> : <>
                  <KV rows={kvRows} />
                  {progress}
                </>}

                {office && detail.office_note && (
                  <div className="ui-section">
                    <div className="ui-section-head">
                      <h2 className="ui-section-title">Büronotiz</h2>
                      {!detail.cancelled_at && (
                        <Button small minimal icon="edit" text="Bearbeiten"
                                onClick={() => setLife({ no: detail.no, mode: "change" })} />
                      )}
                    </div>
                    <p className="order-office-note">{detail.office_note}</p>
                  </div>
                )}

                {office && detail.kind !== "internal" && (
                  <div className="ui-section">
                    <div className="ui-section-head">
                      <h2 className="ui-section-title">Rechnung</h2>
                      {links && <span className="ui-section-count">{links.status}</span>}
                    </div>
                    {!links ? (
                      <div className="ui-inline-actions">
                        <p className="sub" style={{ margin: 0 }}>{hasInvoice ? "Rechnungsverweise werden geholt…" : "Für diesen Auftrag gibt es noch keine Rechnung — sie entsteht in der Buchhaltung."}</p>
                        {!hasInvoice && !detail.cancelled_at && (
                          <Button small minimal icon="euro" text="In Buchhaltung öffnen"
                                  onClick={() => navigate(`buchhaltung/${encodeURIComponent(detail.no)}`)} />
                        )}
                      </div>
                    ) : (
                      <HintDetails title={`${links.number || links.invoice_no} · ${fmtEur(links.total_cents / 100)}${detail.paid ? " · bezahlt" : ""}`}>
                        <p>
                          Empfänger {links.recipient || "—"} · {links.has_copy ? "Haus-Exemplar liegt vor — der Abruf braucht Stripe nicht" : "noch kein Haus-Exemplar; der erste Abruf legt eines an"}{!links.live && " · Stripe im Testmodus"}
                        </p>
                        <p>
                          Verwendungszweck <b className="mono">{links.verwendungszweck || detail.no}</b>{" "}
                          <Button minimal small icon="duplicate" title="Verwendungszweck kopieren" onClick={() => copyZweck(links.verwendungszweck || detail.no)} />
                          {(links.payment_methods ?? []).length > 0 && ` · zahlbar per ${paymentWays(links.payment_methods)}`}
                        </p>
                        <div className="ui-inline-actions">
                          <Button icon="document" text="PDF herunterladen" onClick={() => pdf(detail, links.number)} />
                          {links.hosted_url && <Button icon="credit-card" text="Zahlseite (für den Kunden)" onClick={() => window.open(links.hosted_url, "_blank", "noreferrer")} />}
                          <Button icon="share" text="In Stripe öffnen" onClick={() => window.open(links.dashboard_url, "_blank", "noreferrer")} />
                          {!detail.paid && <Button icon="refresh" text="Zahlung prüfen" loading={busy} onClick={() => syncInvoice(detail.no)} />}
                        </div>
                      </HintDetails>
                    )}
                  </div>
                )}
              </>;
            })()} />

            <Tab id="positionen" title={`Positionen (${detail.positions.length})`} panel={
              detail.positions.length === 0 ? <p className="sub">Keine Positionen.</p> : (
                <div className="table-scroll">
                  <HTMLTable className="data-table" striped compact>
                    <thead><tr><th>Teil</th><th>Werkstoff</th><th className="num">Dicke</th><th className="num">Stück</th><th className="num">Ø außen</th><th className="num">Ø innen</th><th>Form</th><th>Fertigung</th><th>Innenauftrag</th></tr></thead>
                    <tbody>
                      {detail.positions.map((pos) => (
                        <tr key={pos.id}>
                          <td><b>{pos.label}</b></td><td>{pos.mat}</td><td className="num">{pos.thk} mm</td><td className="num">{pos.qty}</td>
                          <td className="num mono">{pos.od?.toFixed(1)}</td><td className="num mono">{pos.di > 0 ? pos.di.toFixed(1) : "—"}</td>
                          <td>{pos.shape_id
                            ? office
                              ? <Button minimal small icon="folder-open" className="mono"
                                        text={pos.shape_key || pos.shape_label || `#${pos.shape_id}`}
                                        title={`${pos.shape_label || pos.shape_key || "Form"} in der Bibliothek öffnen`}
                                        onClick={() => navigate(`formen/${pos.shape_id}`)} />
                              : <span className="mono">{pos.shape_key || `#${pos.shape_id}`}</span>
                            : <span className="sub">—</span>}</td>
                          <td><Tag minimal intent={pos.production_status === "done" ? "success" : "none"}>{pos.status_text || pos.production_status}</Tag></td>
                          <td>{pos.work_order_no
                            ? <Button minimal small icon="cut" className="mono" text={pos.work_order_no}
                                      title="Innenauftrag in der Produktion öffnen"
                                      onClick={() => navigate(`produktion/${pos.work_order_no}`)} />
                            : <span className="sub">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </HTMLTable>
                </div>
              )
            } />

            <Tab id="formen" title={`Formen (${formSummary.length})`} panel={
              formSummary.length === 0 ? (
                <p className="sub">Keine Position aus der Formenbibliothek — DXF-Uploads, KI-Auswertung und Handarbeit haben keine Hausform.</p>
              ) : (
                <div className="table-scroll">
                  <HTMLTable className="data-table" striped compact>
                    <thead><tr><th>Form</th><th>Bezeichnung</th><th className="num">Positionen</th><th className="num">Stück</th><th>Innenaufträge</th></tr></thead>
                    <tbody>
                      {formSummary.map((f) => (
                        <tr key={f.id}>
                          <td>
                            {office
                              ? <Button minimal small icon="folder-open" className="mono"
                                        text={f.key || `#${f.id}`}
                                        title="Form in der Bibliothek öffnen"
                                        onClick={() => navigate(`formen/${f.id}`)} />
                              : <span className="mono">{f.key || `#${f.id}`}</span>}
                          </td>
                          <td>{f.label || <span className="sub">—</span>}</td>
                          <td className="num">{f.positions}</td>
                          <td className="num">{f.qty}</td>
                          <td>
                            {f.workOrders.size === 0 ? <span className="sub">noch nicht eingeplant</span> : [...f.workOrders].sort().map((no) => (
                              <Button key={no} minimal small icon="cut" className="mono" text={no}
                                      title="Innenauftrag in der Produktion öffnen"
                                      onClick={() => navigate(`produktion/${no}`)} />
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </HTMLTable>
                </div>
              )
            } />

            <Tab id="fertigung" title={`Fertigung (${detail.work_orders.length})`} panel={
              detail.work_orders.length === 0 ? <p className="sub">Keine Innenaufträge — die Fertigung beginnt mit der Freigabe.</p> : (
                <div className="table-scroll">
                  <HTMLTable className="data-table" striped compact>
                    <thead><tr><th>Innenauftrag</th><th>Sammellauf</th><th>Status</th><th>Meine Teile</th><th>Marken</th><th>Platten</th><th>Geschnitten</th><th>Mit anderen Aufträgen</th><th>Schachtel-Rechenkern</th></tr></thead>
                    <tbody>
                      {detail.work_orders.map((w) => {
                        const status = workOrderStatus(w.status ?? "");
                        return (
                          <tr key={w.no}>
                            <td>
                              <Button minimal small icon="cut" className="mono" text={w.no}
                                      title="Innenauftrag in der Produktion öffnen"
                                      onClick={() => navigate(`produktion/${w.no}`)} />
                            </td>
                            <td><RefLink kind="run" no={w.run_no ?? ""} /></td>
                            <td><Tag minimal intent={status.intent}>{status.label}</Tag></td>
                            <td className="num">{w.own_parts ?? "—"}</td>
                            <td className="mono sub">{(w.own_tags ?? []).join(", ") || "—"}</td>
                            <td className="mono sub">{(w.plates ?? []).join(", ") || "—"}</td>
                            <td className="num">{w.n_plates != null ? `${w.n_done_plates ?? 0} / ${w.n_plates} Platten` : "—"}</td>
                            <td className="num">{w.n_orders != null && w.n_orders > 1 ? `${w.n_orders - 1} weitere` : "nur dieser"}</td>
                            <td className="sub">{w.engine_version ? engineText(w.engine_version) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </HTMLTable>
                </div>
              )
            } />

            <Tab id="verweise" title="Verweise" panel={<RelatedPanel no={detail.no} />} />

            <Tab id="versand" title={`Versand (${detail.shipments.length})`} panel={
              detail.shipments.length === 0 ? (
                <div className="ui-inline-actions">
                  <p className="sub" style={{ margin: 0 }}>Noch kein Versand.</p>
                  {!detail.cancelled_at && detail.kind !== "internal" && (
                    <Button small minimal icon="truck" text="Zum Versand" onClick={() => navigate("versand")} />
                  )}
                </div>
              ) : (
                <div className="table-scroll">
                  <HTMLTable className="data-table" striped compact>
                    <thead><tr><th>Versand</th><th>Status</th><th>Spedition</th><th>Sendungsnummer</th><th className="num">Positionen</th></tr></thead>
                    <tbody>
                      {detail.shipments.map((sh) => {
                        const stInfo = SHIPMENT_LABELS[sh.status ?? ""] ?? { label: sh.status || "—", intent: "none" as const };
                        return (
                          <tr key={sh.no}>
                            <td><RefLink kind="shipment" no={sh.no} /></td>
                            <td><Tag minimal intent={stInfo.intent}>{stInfo.label}</Tag></td>
                            <td>{sh.carrier || "—"}</td>
                            <td className="mono">{sh.tracking || "—"}</td>
                            <td className="num">{sh.n_items ?? "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </HTMLTable>
                </div>
              )
            } />

            <Tab id="verlauf" title={`Verlauf (${detail.audit.length})`} panel={
              detail.audit.length === 0 ? <p className="sub">Keine Protokolleinträge.</p> : (
                <div className="table-scroll">
                  <HTMLTable className="data-table" striped compact>
                    <thead><tr><th>Zeit</th><th>Wer</th><th>Was</th><th>Einzelheiten</th></tr></thead>
                    <tbody>
                      {detail.audit.map((a, i) => (
                        <tr key={i}>
                          <td className="sub nw">{fmtDateTime(a.at)}</td>
                          <td className="sub">{a.actor}</td>
                          <td><Tag minimal>{a.action}</Tag></td>
                          <td>
                            {a.detail && Object.keys(a.detail).length ? (
                              <HintDetails title="JSON anzeigen">
                                <pre className="ui-json">{JSON.stringify(a.detail, null, 2)}</pre>
                              </HintDetails>
                            ) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </HTMLTable>
                </div>
              )
            } />
          </Tabs>
        )}
      </Drawer>

      <Dialog
        isOpen={!!payDialog}
        onClose={() => setPayDialog(null)}
        portalContainer={payDialogContainer}
        title={payDialog?.paid ? "Zahlung zurücknehmen" : "Extern bezahlt markieren"}
      >
        <div className="bp5-dialog-body">
          {payDialog && !payDialog.paid ? (
            <>
              <p>Auftrag <b className="mono">{payDialog.no}</b> wird als extern bezahlt markiert — ohne Stripe. Der Auftrag wird zugleich freigegeben.</p>
              <FormGroup label="Zahlweg"><HTMLSelect aria-label="Zahlweg" value={payMethod} onChange={(e) => setPayMethod(e.currentTarget.value)}><option value="extern">extern</option><option value="bar">bar</option><option value="ueberweisung">Überweisung</option><option value="rechnung">Rechnung</option></HTMLSelect></FormGroup>
              <FormGroup label="Referenz / Beleg-Nr. (optional)"><InputGroup aria-label="Referenz / Beleg-Nr. (optional)" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="z. B. ÜB-2026-001" /></FormGroup>
            </>
          ) : payDialog ? (
            <p>Zahlung für <b className="mono">{payDialog.no}</b> zurücknehmen? Der Auftrag gilt danach wieder als unbezahlt.</p>
          ) : null}
        </div>
        <div className="bp5-dialog-footer"><div className="bp5-dialog-footer-actions">
          <Button onClick={() => setPayDialog(null)}>Abbrechen</Button>
          <Button intent={payDialog?.paid ? "danger" : "primary"} icon={payDialog?.paid ? "undo" : "tick"} loading={paidBusy !== null} onClick={markPaidExternal}>{payDialog?.paid ? "Zurücknehmen" : "Als bezahlt markieren"}</Button>
        </div></div>
      </Dialog>
      <OrderLifecycleDialog no={life?.no ?? null} mode={life?.mode ?? null}
                            onClose={() => {
                              // Der Menüpunkt, der den Dialog öffnete, gibt es nicht mehr:
                              // der Fokus geht zurück auf den „⋯"-Knopf (Schublade vor Zeile).
                              const no = life?.no;
                              setLife(null);
                              if (no) requestAnimationFrame(() => {
                                const sel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
                                (sel(`Weitere Aktionen für ${no}`) ?? sel(`Aktionen für ${no}`))?.focus();
                              });
                            }} onDone={refresh}
                            portalContainer={openNo ? payDialogContainer : undefined} />
    </PageFrame>
  );
}
