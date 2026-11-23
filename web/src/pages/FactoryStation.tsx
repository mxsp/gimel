import { useCallback, useEffect, useMemo, useState } from "react";
import { RefLink } from "../components/RefLink";
import { Button, ButtonGroup, Callout, Card, Checkbox, Dialog, DialogBody, DialogFooter, HTMLSelect, HTMLTable, InputGroup, Menu, MenuItem, Spinner, Tab, Tabs, Tag, Tooltip } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import NonIdealState from "../components/NonIdealState";
import { api, canAdminWork, apiDownload, apiOpenHtml, fmtDate, fmtDateTime, fmtEur, getToken, getUser, isWorker } from "../api";
import { navigate, useHashQuery } from "../router";
import { toastError, toastSuccess } from "../toast";
import { undoable } from "../undo";
import { More, PageInfo, pageInfo, useDetail } from "../ui";
import OrderProgress, { Progress } from "../components/OrderProgress";
import WorkQueue from "../components/WorkQueue";
import RankBars, { HandlerBars } from "../components/RankBars";
import {
  EMPTY_FLOOR, Floor, HandlerRank, MACHINE_LABEL, ROUTING_LABEL, sceneBounds,
  Station, StationRank, StationRouting, StationVisibility, stationColour,
  stationUrl, stockHealth, TYPE_LABEL, VISIBILITY_LABEL, copyToClipboard,
  fmtM, fmtMin, missingMachineData, StationSchedule, WorkSlot,
} from "../factory";
import { plural, days } from "../plural";
import { workOrderStatus } from "../status";
import StationControlBar from "../components/StationControlBar";
import { MatName } from "../components/MaterialSelect";
import LaufkarteShareControl from "../components/LaufkarteShareControl";
import { publishStations } from "../stationStore";

/* Stations-Cockpit — die Unterseite einer Station im Digitalen Grundriss.

   Eine Station ist kein eigener Datenbestand: sie ist ein Ausschnitt aus den
   Modulen, die das Portal ohnehin führt. Diese Seite stellt den Ausschnitt
   zusammen und benutzt dabei dieselben Knöpfe wie die Modulseite selbst — wer
   hier „Fertig" meldet, eine Rechnung bucht oder einen Versand anlegt, tut
   genau das, was er auch dort täte. Die Seite ist der Arbeitsplatz, nicht eine
   Kopie davon.

   Neu und der eigentliche Punkt dieser Fassung: **die Reiter richten sich nach
   dem Stationstyp.** Eine Fertigungsstation braucht ihre Warteschlange, die
   Laufkarte und die Schnittdateien; ein Lager braucht Bestände und eine
   Rüstliste; der Versand braucht Sendungen. Alles allen zu zeigen ist kein
   Entgegenkommen, sondern eine Zumutung an den, der acht Stunden davor steht.

   Und seit der Betreiber den Unterschied bemerkte: **der Ausschnitt ist
   vollständig.** Jeder Reiter zeigt denselben Datenbestand wie die Modulseite
   in der Seitenleiste — Versandfertige sind nicht auf „relevante Aufträge"
   beschränkt, die Buchhaltung sieht jede Rechnung, das Lager jeden Werkstoff.
   Was zur Station passt, ist markiert, nicht der Rest weggelassen: eine Zahl,
   die nur ein Ausschnitt erklärt, wird als Fehler gelesen, nicht als Filter. */

type TabId =
  | "abarbeitung" | "warteschlange" | "auftraege" | "dateien" | "material"
  | "versand" | "buchhaltung" | "station";

interface Pos {
  id: number; mat: string; thk: number; qty: number; label: string;
  od: number; di: number; production_status: string;
}
interface OrderRow {
  no: string; customer_ref: string; stage: number; relevant: boolean;
  rush: boolean; released: boolean; blocked: boolean;
  due_date: string | null; created_at: string | null;
  handler_user_id: number | null; handler: string; handler_reason: string;
  progress: Progress; positions: Pos[];
}
interface MaterialRow {
  id: string; name: string; stock: number; eur_m2: number;
  thicknesses: number[]; lead_days: number;
}
interface QueueJob {
  no: string; mat: string; mat_name: string; thk: number; status: string;
  n_plates: number; n_parts: number; n_orders: number; utilisation: number;
  planned_min: number; assign_mode: string; assign_reason: string;
  assign_score: number; due_date: string | null; release_reason: string;
  note: string; created_at: string | null; started_at: string | null;
  orders: { order_no: string; customer: string; n_parts: number }[];
}
interface SupplyRow {
  id: number; label: string; metres: number; minutes: number;
  exact: boolean; note: string; materials: string[];
}
interface ViewData {
  station: Station;
  station_type: string;
  all_for_all: boolean;
  can_edit: boolean;
  orders: OrderRow[];
  hidden_count: number;
  materials: MaterialRow[];
  queue: QueueJob[];
  supply: SupplyRow[];
  auto_routing: boolean;
}

interface WorkOrder {
  no: string; mat: string; mat_name: string; thk: number; status: string;
  n_plates: number; n_parts: number; n_orders: number; utilisation: number;
  due_date?: string | null; created_at: string; release_reason: string;
  station_id?: number | null;
}
interface WorkOrderDetail extends WorkOrder {
  plates: Array<{
    id: number; idx: number; fmt: number[]; used_h: number; n_parts: number;
    utilisation: number; status: string;
    items: Array<{ tag: string; order_no: string; customer: string; label: string;
                   position_id: number; from_remnant: boolean }>;
  }>;
  by_order: Array<{ order_no: string; customer: string; n_parts: number; done?: boolean }>;
  by_part: Array<{ position_id: number; label: string; order_no: string;
                   customer: string; qty?: number; tags?: string[] }>;
  cut_plan?: { layered?: boolean; label?: string; reason?: string };
}
interface ReadyOrder {
  order_no: string; customer: string; n_ready: number; n_positions: number;
  due_date: string | null; rush: boolean;
}
interface Shipment {
  no: string; status: string; carrier: string; tracking: string;
  created_at: string | null; shipped_at: string | null; n_items: number;
  items: Array<{ order_no: string; label: string; qty: number; tag: string }>;
}
interface ShipmentOrders {
  orders: Array<{ order_no: string; items: Array<{ tag: string; label: string; mat: string;
    thk: number; qty: number; work_order_no: string; note: string }> }>;
}
interface Invoice {
  order_no: string; invoice_no: string; customer: string; email: string;
  net: number; gross: number; invoiced_at: string | null; due_at: string | null;
  paid: boolean; paid_at: string | null; days_overdue: number;
}

const SHIP_LABEL: Record<string, { intent: any; label: string }> = {
  packing: { intent: "warning", label: "in Vorbereitung" },
  shipped: { intent: "primary", label: "versendet" },
  delivered: { intent: "success", label: "zugestellt" },
  returned: { intent: "danger", label: "Rücksendung" },
};
const shipTag = (s: string) => SHIP_LABEL[s] ?? { intent: "none" as any, label: s };

const woTag = workOrderStatus;

/** Produktionsstand einer Bestellposition — dieselben Werte, die der
    Sammellauf in die Position schreibt, nur lesbar gemacht. */
const POS_STATUS: Record<string, { intent: any; label: string }> = {
  pending: { intent: "none", label: "wartet" },
  batched: { intent: "primary", label: "eingeplant" },
  manual: { intent: "warning", label: "Anfrage" },
  done: { intent: "success", label: "geschnitten" },
};
const posTag = (s: string) => POS_STATUS[s] ?? { intent: "none" as any, label: s || "—" };

/** Welche Reiter dieser Stationstyp führt. Der erste ist der Startreiter.
    „Dateien" ist kein eigener Reiter mehr — Schnittdateien, Laufkarte und
    Plattenzeichnung öffnen aus Aufträgen, Warteschlange und Abarbeitung im
    rechten Seitenrahmen. Ein verbliebener #/station/…?tab=dateien landet auf
    Abarbeitung; der Drawer trägt die Dateien. */
const TABS_BY_TYPE: Record<string, TabId[]> = {
  production: ["abarbeitung", "warteschlange", "auftraege", "material", "station"],
  warehouse: ["abarbeitung", "material", "warteschlange", "auftraege", "station"],
  shipping: ["abarbeitung", "versand", "auftraege", "station"],
  accounting: ["abarbeitung", "buchhaltung", "auftraege", "station"],
};

/** Was der erste Reiter an einer Station heißt. „Abarbeitung" überall, aber
    die Klammer sagt, was abgearbeitet wird — ein Regal kommissioniert, ein
    Plotter schneidet, und niemand nennt das gleich. */
const WORK_NOUN: Record<string, string> = {
  production: "Schnitte",
  warehouse: "Kommissionierungen",
  shipping: "Sendungen",
  accounting: "Vorgänge",
};

export default function StationView({ id }: { id: string }) {
  const [data, setData] = useState<ViewData | null>(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [tab, setTab] = useState<TabId | null>(null);

  const [floor, setFloor] = useState<Floor | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [wos, setWos] = useState<WorkOrder[] | null>(null);
  const [ready, setReady] = useState<ReadyOrder[] | null>(null);
  const [shipments, setShipments] = useState<Shipment[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);

  // Reiter Aufträge — „alle" ist die Voreinstellung: dieselbe Zahl wie das
  // Auftragsmodul; die Eingrenzung steht als Filter bereit, nicht als Wand.
  const [ordersQ, setOrdersQ] = useState("");
  const [ordersFilter, setOrdersFilter] = useState("alle");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyNo, setBusyNo] = useState<string | null>(null);

  // Zuordnungs-Dialoge
  const [rankFor, setRankFor] = useState<string | null>(null);
  const [ranks, setRanks] = useState<StationRank[] | null>(null);
  const [handlerFor, setHandlerFor] = useState<OrderRow | null>(null);
  const [handlerRanks, setHandlerRanks] = useState<HandlerRank[] | null>(null);

  // Rechter Seitenrahmen — Dateien & digitale Laufkarte aus jedem Reiter
  const [drawerWo, setDrawerWo] = useState<string | null>(null);
  const [drawerDetail, setDrawerDetail] = useState<WorkOrderDetail | null>(null);
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [drawerPlate, setDrawerPlate] = useState(0);

  // Reiter Versand
  const [shipSel, setShipSel] = useState<string[]>([]);
  const [shipOpen, setShipOpen] = useState(false);
  const [shipCarrier, setShipCarrier] = useState("");
  const [shipTracking, setShipTracking] = useState("");
  const [shipNote, setShipNote] = useState("");
  const [shipBusy, setShipBusy] = useState(false);
  const [shipDetail, setShipDetail] = useState<{ no: string; data: ShipmentOrders } | null>(null);

  // Reiter Abarbeitung — die Reihenfolge dieser Station, gerechnet und
  // begründet. Eigener Abruf, weil sie sich häufiger ändert als die Station
  // selbst und nach jeder Handlung frisch sein muss.
  const [sched, setSched] = useState<StationSchedule | null>(null);
  const [schedBusy, setSchedBusy] = useState<string | null>(null);

  // Reiter Material — der volle Werkstoffbestand, wie im Lagermodul
  const [allMats, setAllMats] = useState<MaterialRow[] | null>(null);
  const [matQ, setMatQ] = useState("");
  const [matSort, setMatSort] = useState("name");

  const isAdmin = canAdminWork(getUser());
  // Werker arbeiten die Station ab; zuordnen, Bearbeiter und Rechnungen bleiben im Büro.
  const office = !isWorker();
  const { simple } = useDetail();
  const queryParams = useHashQuery();
  const queryTab = queryParams.get("tab") as TabId | null;

  // Bei Stationswechsel Reiter sauber zurücksetzen (z. B. Plotter → Versand).
  useEffect(() => {
    setTab(queryTab && queryTab !== "dateien" ? queryTab : null);
  }, [id, queryTab]);

  // ---------------------------------------------------------------- Laden
  const loadModules = useCallback(async (stype: string) => {
    // Nur laden, was dieser Stationstyp tatsächlich als Reiter anzeigt — spart
    // unnötige Abrufe alle 30 s (z. B. keine Rechnungen am Schneidplotter).
    const needProduction = stype === "production" || stype === "warehouse";
    const needShipping = stype === "shipping";
    const needAccounting = stype === "accounting";

    if (needProduction) {
      api<WorkOrder[]>("/api/production/work-orders?limit=100").then(setWos).catch(() => setWos([]));
      api<Array<{ id: string; name: string; stock?: number; eur_m2?: number;
                   thicknesses?: number[]; lead_days?: number }>>("/api/products?include_inactive=true")
        .then((ps) => setAllMats(ps.map((p) => ({
          id: p.id, name: p.name, stock: p.stock ?? 0, eur_m2: p.eur_m2 ?? 0,
          thicknesses: p.thicknesses ?? [], lead_days: p.lead_days ?? 0,
        }))))
        .catch(() => setAllMats(null));
    }
    if (needShipping) {
      api<{ orders: ReadyOrder[] }>("/api/shipping/ready").then((r) => setReady(r.orders)).catch(() => setReady([]));
      api<{ shipments: Shipment[] }>("/api/shipping/").then((r) => setShipments(r.shipments)).catch(() => setShipments([]));
    }
    if (needAccounting) {
      if (office) api<Invoice[]>("/api/invoicing/invoices").then(setInvoices).catch(() => setInvoices([]));
      else setInvoices([]);
    }
  }, [office]);

  const loadStation = useCallback(async (silent = false) => {
    if (!silent) { setError(""); setData(null); }
    try {
      const v = await api<ViewData>(`/api/factory/stations/${id}/view`);
      setData(v);
      setTab((t) => {
        const valid = (TABS_BY_TYPE[v.station_type] ?? TABS_BY_TYPE.production).filter((x) => office || x !== "buchhaltung");
        if (t && valid.includes(t)) return t;
        return valid[0] ?? "auftraege";
      });
      setUpdatedAt(new Date());
      setError("");
      loadModules(v.station_type);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (!silent) toastError(msg);
    }
  }, [id, office, loadModules]);

  const loadSched = useCallback(async () => {
    try {
      setSched(await api<StationSchedule>(`/api/factory/stations/${id}/worklist`));
    } catch {
      setSched(null);  // eine leere Liste ist kein Fehler, nur keine Arbeit
    }
  }, [id]);

  const loadMap = useCallback(async () => {
    api<Floor>("/api/factory/floor")
      .then((f) => setFloor({ ...EMPTY_FLOOR, ...f, aisles: f.aisles ?? { nodes: [], edges: [] } }))
      .catch(() => setFloor(null));
    api<Station[]>("/api/factory/stations")
      .then((list) => { setStations(list); publishStations(list); })
      .catch(() => setStations([]));
  }, []);

  useEffect(() => { loadStation(); loadMap(); loadSched(); }, [loadStation, loadMap, loadSched]);
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) { loadStation(true); loadSched(); }
    }, 30_000);
    return () => clearInterval(t);
  }, [loadStation, loadSched]);

  const refreshAll = () => { loadStation(true); loadSched(); };

  // ---------------------------------------------------------------- Aktionen
  const markComplete = async (o: OrderRow) => {
    if (data?.station.id == null) return;
    setBusyNo(o.no);
    try {
      await api(`/api/factory/stations/${data.station.id}/complete/${o.no}`, { method: "POST" });
      toastSuccess(`${o.no} an ${data.station.label} abgeschlossen — Innenaufträge fertig gemeldet.`);
      await loadStation(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
      // Der 409 sagt, wo der Innenauftrag stattdessen läuft. Nach dem
      // Neuladen verschwindet der Knopf, der nicht mehr hierher gehört.
      refreshAll();
    } finally { setBusyNo(null); }
  };

  /* Die drei Handgriffe an der Abarbeitungsliste. Alle drei sind Tatsachen,
     keine Statusspalten: „fertig" bei einer Kommissionierung *ist* die
     gebuchte Bereitstellung am Innenauftrag, „angefangen" beim Schneiden
     *ist* der laufende Innenauftrag. Deshalb wird danach alles neu geladen —
     die Zahl im Nachbarreiter hat sich mitbewegt. */
  const taskState = async (slot: WorkSlot, state: string) => {
    if (slot.task_id == null) return;
    setSchedBusy(`${slot.kind}:${slot.ref}`);
    try {
      await api(`/api/factory/tasks/${slot.task_id}/state`, {
        method: "POST", body: JSON.stringify({ state }),
      });
      toastSuccess(`${slot.ref}: ${state === "done" ? "fertig gemeldet"
        : state === "running" ? "angefangen" : "zurückgenommen"}.`);
      refreshAll();
    } catch (e: unknown) { toastError(e instanceof Error ? e.message : String(e)); }
    finally { setSchedBusy(null); }
  };

  const taskMove = async (slot: WorkSlot, dir: -1 | 1) => {
    if (!sched || data?.station.id == null) return;
    const order = sched.slots.map((x) => `${x.kind}:${x.ref}`);
    const i = order.indexOf(`${slot.kind}:${slot.ref}`);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    setSchedBusy(`${slot.kind}:${slot.ref}`);
    try {
      await api(`/api/factory/stations/${data.station.id}/worklist/order`, {
        method: "POST", body: JSON.stringify({ keys: order }),
      });
      await loadSched();
    } catch (e: unknown) { toastError(e instanceof Error ? e.message : String(e)); }
    finally { setSchedBusy(null); }
  };

  const taskRelease = async (slot: WorkSlot) => {
    if (slot.task_id == null) return;
    setSchedBusy(`${slot.kind}:${slot.ref}`);
    try {
      await api(`/api/factory/tasks/${slot.task_id}/assign`, {
        method: "POST", body: JSON.stringify({ station_id: null }),
      });
      toastSuccess(`${slot.ref} ist wieder frei zur Planung.`);
      refreshAll();
    } catch (e: unknown) { toastError(e instanceof Error ? e.message : String(e)); }
    finally { setSchedBusy(null); }
  };

  const freeOrder = async () => {
    if (data?.station.id == null) return;
    try {
      await api(`/api/factory/stations/${data.station.id}/worklist/order`, { method: "DELETE" });
      toastSuccess("Handreihenfolge gelöst — es gilt wieder die gerechnete Ordnung.");
      await loadSched();
    } catch (e: unknown) { toastError(e instanceof Error ? e.message : String(e)); }
  };

  const copyLink = async () => {
    if (data?.station.id == null) return;
    if (await copyToClipboard(stationUrl(data.station.id))) toastSuccess("Link auf diese Station kopiert.");
    else toastError(stationUrl(data.station.id));
  };

  const openRanking = async (jobNo: string) => {
    setRankFor(jobNo);
    setRanks(null);
    try {
      const r = await api<{ ranking: StationRank[] }>(`/api/factory/work-orders/${jobNo}/ranking`);
      setRanks(r.ranking);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
      setRankFor(null);
    }
  };

  const assignTo = async (jobNo: string, stationId: number | null, note = "") => {
    try {
      await api(`/api/factory/work-orders/${jobNo}/assign`, {
        method: "POST", body: JSON.stringify({ station_id: stationId, note }),
      });
      toastSuccess(stationId == null
        ? `${jobNo} ist wieder frei zur Planung.`
        : `${jobNo} zugeordnet.`);
      setRankFor(null);
      refreshAll();
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  const openHandlers = async (o: OrderRow) => {
    setHandlerFor(o);
    setHandlerRanks(null);
    try {
      const r = await api<{ ranking: HandlerRank[] }>(`/api/factory/orders/${o.no}/handlers`);
      setHandlerRanks(r.ranking);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
      setHandlerFor(null);
    }
  };

  const setHandler = async (orderNo: string, userId: number | null, note = "") => {
    try {
      await api(`/api/factory/orders/${orderNo}/handler`, {
        method: "POST", body: JSON.stringify({ user_id: userId, note }),
      });
      toastSuccess(userId == null ? "Bearbeiter entfernt." : "Bearbeiter gesetzt.");
      setHandlerFor(null);
      await loadStation(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  const setWoStatus = (no: string, from: string, to: string) =>
    undoable({
      run: () => api(`/api/production/work-orders/${no}/status`, { method: "POST", body: JSON.stringify({ status: to }) }),
      undo: () => api(`/api/production/work-orders/${no}/status`, { method: "POST", body: JSON.stringify({ status: from }) }),
      done: `${no}: ${woTag(to).label}.`,
      undone: `${no} steht wieder auf „${woTag(from).label}".`,
      after: () => { refreshAll(); },
    });

  const loadDrawerDetail = useCallback(async (no: string) => {
    setDrawerBusy(true);
    try { setDrawerDetail(await api<WorkOrderDetail>(`/api/production/work-orders/${no}`)); }
    catch (e: any) { toastError(e.message); setDrawerDetail(null); }
    finally { setDrawerBusy(false); }
  }, []);

  useEffect(() => {
    if (drawerWo) { loadDrawerDetail(drawerWo); setDrawerPlate(0); } else setDrawerDetail(null);
  }, [drawerWo, loadDrawerDetail]);

  // ESC schließt den Dateien-Drawer
  useEffect(() => {
    if (!drawerWo) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerWo(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerWo]);

  const openFiles = useCallback((no: string) => setDrawerWo(no), []);
  const closeDrawer = useCallback(() => setDrawerWo(null), []);

  const grab = async (path: string, name: string) => {
    try { await apiDownload(path, name); toastSuccess(`${name} geladen.`); }
    catch (e: any) { toastError(e.message); }
  };

  const openTraveller = async (no: string) => {
    try { await apiOpenHtml(`/api/production/work-orders/${no}/sheet`); }
    catch (e: any) { toastError(e.message); }
  };

  const openSvg = async (path: string) => {
    try {
      const token = getToken();
      const resp = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!resp.ok) throw new Error(`Zeichnung nicht abrufbar (${resp.status}).`);
      const blob = new Blob([await resp.text()], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      if (!win) { URL.revokeObjectURL(url); throw new Error("Das Fenster wurde vom Browser blockiert."); }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) { toastError(e.message ?? String(e)); }
  };

  const setShipmentStatus = (s: Shipment, status: string) =>
    undoable({
      run: () => api(`/api/shipping/${s.no}`, { method: "PATCH", body: JSON.stringify({ status }) }),
      undo: () => api(`/api/shipping/${s.no}`, { method: "PATCH", body: JSON.stringify({ status: s.status }) }),
      done: `Versand ${s.no}: ${shipTag(status).label}.`,
      undone: `Versand ${s.no} steht wieder auf „${shipTag(s.status).label}".`,
      after: () => api<{ shipments: Shipment[] }>("/api/shipping/").then((r) => setShipments(r.shipments)).catch(() => {}),
    });

  const createShipment = async () => {
    if (!shipSel.length) return;
    setShipBusy(true);
    let created = "";
    await undoable({
      run: async () => {
        const r = await api<{ no: string }>("/api/shipping/", {
          method: "POST",
          body: JSON.stringify({ order_nos: shipSel, carrier: shipCarrier.trim(), tracking: shipTracking.trim(), note: shipNote.trim() }),
        });
        created = r.no;
        setShipSel([]); setShipOpen(false);
        setShipCarrier(""); setShipTracking(""); setShipNote("");
      },
      undo: () => api(`/api/shipping/${created}`, { method: "DELETE" }),
      done: () => `Versand ${created} angelegt${shipTracking.trim() ? ` · Tracking ${shipTracking.trim()}` : ""}.`,
      undone: "Versand wieder aufgelöst — die Teile stehen erneut bereit.",
      after: async () => {
        try {
          setShipments((await api<{ shipments: Shipment[] }>("/api/shipping/")).shipments);
          setReady((await api<{ orders: ReadyOrder[] }>("/api/shipping/ready")).orders);
        } catch { /* die nächste Periode holt es */ }
      },
    });
    setShipBusy(false);
  };

  const openShipmentDetail = async (no: string) => {
    try { setShipDetail({ no, data: await api<ShipmentOrders>(`/api/shipping/${no}/orders`) }); }
    catch (e: any) { toastError(e.message); }
  };

  const markPaid = (i: Invoice) =>
    undoable({
      run: () => api(`/api/invoicing/orders/${i.order_no}/invoice/paid`,
                     { method: "POST", body: JSON.stringify({ note: "von Hand gebucht" }) }),
      done: `${i.order_no} als bezahlt gebucht.`,
      after: () => api<Invoice[]>("/api/invoicing/invoices").then(setInvoices).catch(() => {}),
    });

  // ---------------------------------------------------------------- Ableitungen
  const s = data?.station;
  const stype = data?.station_type ?? "production";

  const woFits = useMemo(() => {
    const mats = new Set(s?.materials ?? []);
    const thks = new Set((s?.thicknesses ?? []).map(Number));
    return (w: WorkOrder) => (!mats.size && !thks.size) || mats.has(w.mat) || thks.has(w.thk);
  }, [s]);

  const relevantNos = useMemo(
    () => new Set((data?.orders ?? []).filter((o) => o.relevant).map((o) => o.no)), [data]);
  const relevant = useMemo(() => (data?.orders ?? []).filter((o) => o.relevant), [data]);
  const other = useMemo(() => (data?.orders ?? []).filter((o) => !o.relevant), [data]);

  const queue = data?.queue ?? [];
  const queueOpen = useMemo(
    () => queue.filter((q) => q.status !== "done" && q.status !== "cancelled"), [queue]);
  const queueMin = useMemo(
    () => queueOpen.reduce((a, q) => a + (q.planned_min || 0), 0), [queueOpen]);
  /** Nur Aufträge mit einem offenen Innenauftrag an *dieser* Station dürfen
      hier „Fertig“ melden. „Passt vom Werkstoff“ ist keine Zuordnung. */
  const completableOrders = useMemo(
    () => new Set(queueOpen.flatMap((q) => q.orders.map((o) => o.order_no))),
    [queueOpen]);

  /** Innenaufträge, die zu dieser Station *passen*, aber noch keiner gehören —
      das ist die Liste, an der ein Meister zieht. */
  const unassigned = useMemo(() => {
    const mine = new Set(queue.map((q) => q.no));
    return (wos ?? []).filter((w) =>
      !mine.has(w.no) && w.status !== "done" && w.status !== "cancelled"
      && (w.station_id == null) && woFits(w));
  }, [wos, queue, woFits]);

  /** Alle offenen Innenaufträge außer der eigenen Schlange — der Bestand des
      Produktionsmoduls, damit die Maschine sieht, was es sonst noch gibt. */
  const allOpenWos = useMemo(() => {
    const mine = new Set(queue.map((q) => q.no));
    return (wos ?? []).filter((w) =>
      !mine.has(w.no) && w.status !== "done" && w.status !== "cancelled");
  }, [wos, queue]);

  const stationLabels = useMemo(() => {
    const m: Record<number, string> = {};
    for (const st of stations) if (st.id != null) m[st.id] = st.label;
    return m;
  }, [stations]);

  // Versand und Buchhaltung zeigen denselben Bestand wie die Modulseiten —
  // relevantNos markiert nur noch, was wirklich die Station angeht.
  const readyHere = useMemo(() =>
    (ready ?? []).filter((r) => relevantNos.has(r.order_no)), [ready, relevantNos]);
  const shipHere = useMemo(() =>
    (shipments ?? []).filter((sh) => sh.items.some((i) => relevantNos.has(i.order_no))), [shipments, relevantNos]);

  const invHere = useMemo(() => invoices ?? [], [invoices]);
  const invOpen = useMemo(() => invHere.filter((i) => !i.paid), [invHere]);
  const invOverdue = useMemo(() => invOpen.filter((i) => i.days_overdue > 0), [invOpen]);
  const invSum = useMemo(() => invOpen.reduce((a, r) => a + r.gross, 0), [invOpen]);

  const matAlerts = useMemo(() => {
    const list = allMats ?? data?.materials ?? [];
    return {
      reorder: list.filter((m) => stockHealth(m.stock).intent === "danger").length,
      low: list.filter((m) => stockHealth(m.stock).intent === "warning").length,
    };
  }, [allMats, data]);

  /** Werkstoffbestand: der volle Lagerstand — die Eingrenzung der Station
      steht als Markierung daneben, nicht als Filter davor. */
  const allMaterials = useMemo(() => allMats ?? data?.materials ?? [], [allMats, data]);
  const scopedIds = useMemo(
    () => new Set((data?.materials ?? []).map((m) => m.id)), [data]);

  const orderRows = useMemo(() => {
    const q = ordersQ.trim().toLowerCase();
    let rows = data?.orders ?? [];
    if (ordersFilter === "relevant") rows = rows.filter((o) => o.relevant);
    if (ordersFilter === "weitere") rows = rows.filter((o) => !o.relevant);
    if (ordersFilter === "eil") rows = rows.filter((o) => o.rush);
    if (ordersFilter === "ohne_bearbeiter") rows = rows.filter((o) => !o.handler_user_id);
    if (q) rows = rows.filter((o) =>
      o.no.toLowerCase().includes(q)
      || (o.customer_ref ?? "").toLowerCase().includes(q)
      || (o.handler ?? "").toLowerCase().includes(q)
      || o.positions.some((p) => (p.label ?? "").toLowerCase().includes(q) || (p.mat ?? "").toLowerCase().includes(q)));
    return [...rows].sort((a, b) =>
      Number(b.rush) - Number(a.rush) || Number(b.relevant) - Number(a.relevant) || b.no.localeCompare(a.no));
  }, [data, ordersFilter, ordersQ]);

  const matRows = useMemo(() => {
    const q = matQ.trim().toLowerCase();
    let rows = allMaterials.filter((m) =>
      !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    rows = [...rows].sort((a, b) =>
      matSort === "stock" ? a.stock - b.stock
        : matSort === "price" ? a.eur_m2 - b.eur_m2
        : a.name.localeCompare(b.name));
    return rows;
  }, [allMaterials, matQ, matSort]);

  /** Was das Lager für die eingeplante Arbeit bereitlegen muss. Nach Werkstoff
      und Dicke zusammengefasst, denn genau so wird es aus dem Regal geholt. */
  const pickList = useMemo(() => {
    const byMat = new Map<string, { mat: string; name: string; thk: number; plates: number; jobs: string[] }>();
    for (const q of queueOpen.length ? queueOpen : []) {
      const key = `${q.mat}|${q.thk}`;
      const e = byMat.get(key) ?? { mat: q.mat, name: q.mat_name || q.mat, thk: q.thk, plates: 0, jobs: [] };
      e.plates += q.n_plates;
      e.jobs.push(q.no);
      byMat.set(key, e);
    }
    if (!byMat.size) {
      for (const w of (wos ?? []).filter((w) => w.status === "open" && woFits(w))) {
        const key = `${w.mat}|${w.thk}`;
        const e = byMat.get(key) ?? { mat: w.mat, name: w.mat_name || w.mat, thk: w.thk, plates: 0, jobs: [] };
        e.plates += w.n_plates;
        e.jobs.push(w.no);
        byMat.set(key, e);
      }
    }
    return [...byMat.values()].sort((a, b) => b.plates - a.plates);
  }, [queueOpen, wos, woFits]);

  const gaps = s ? missingMachineData(s) : [];

  // Auftrags-Nr.  →  Innenaufträge, die Teile dieses Auftrags tragen.
  // Aus der Warteschlange dieser Station (queue) — der Werker soll dort sehen,
  // wo die Platte mit seinen Teilen gerade liegt. Für den Drawer reicht der
  // erste Treffer; mehrere werden als Chips angeboten.
  const woByOrder = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const q of queue) {
      for (const o of q.orders ?? []) {
        if (!o.order_no) continue;
        if (!m.has(o.order_no)) m.set(o.order_no, []);
        const list = m.get(o.order_no)!;
        if (!list.includes(q.no)) list.push(q.no);
      }
    }
    // Fallback: globale offene Innenaufträge, falls die Schlange noch leer ist
    if (m.size === 0 && wos?.length) {
      for (const w of wos) {
        // wos hat keine Auftragsaufschlüsselung — hier nur annotieren, nicht raten
      }
    }
    return m;
  }, [queue, wos]);

  // ---------------------------------------------------------------- Render
  if (error && !data) return (
    <div className="twin-center">
      <div className="twin-error">{error}</div>
      <Button icon="chevron-left" text="Zurück zum Grundriss" onClick={() => navigate("grundriss")} />
    </div>
  );
  if (!data || !s) return <div className="twin-center"><Spinner size={36} /></div>;

  const hid = s.visibility === "hide" ? data.hidden_count : 0;
  const constrained = (s.materials.length > 0 || s.thicknesses.length > 0);
  const tabs = (TABS_BY_TYPE[stype] ?? TABS_BY_TYPE.production).filter((t) => office || t !== "buchhaltung");
  const activeTab = (tab && tabs.includes(tab) ? tab : tabs[0]) as TabId;
  const cap = s.capacity_min_per_day || 0;

  const slots = sched?.slots ?? [];
  const openSlots = slots.filter((x) => x.state !== "done" && x.state !== "cancelled");

  const KPI: Partial<Record<TabId, { label: string; value: string; sub: string; danger?: boolean }>> = {
    abarbeitung: {
      label: "Abarbeitung",
      value: String(openSlots.length),
      sub: sched
        ? (sched.times_known
            ? `${fmtMin(sched.total_min)} Arbeit${sched.days != null ? ` · ${days(sched.days)}` : ""}`
            : "keine Zeiten hinterlegt")
          + (sched.changeovers_saved > 0 ? ` · ${sched.changeovers_saved} Rüstwechsel gespart` : "")
        : "wird geladen",
      danger: (sched?.late?.length ?? 0) > 0,
    },
    warteschlange: {
      label: stype === "warehouse" ? "Für die Fertigung" : "In der Schlange",
      value: stype === "warehouse" ? String(pickList.length) : fmtMin(queueMin),
      sub: stype === "warehouse"
        ? `${plural(pickList.reduce((a, p) => a + p.plates, 0), "Platte", "Platten")} bereitzulegen`
        : cap > 0
          ? `${plural(queueOpen.length, "Innenauftrag", "Innenaufträge")} · ${days(queueMin / cap)}`
          : `${plural(queueOpen.length, "Innenauftrag", "Innenaufträge")} · keine Kapazität hinterlegt`,
      danger: cap > 0 && queueMin > cap,
    },
    auftraege: {
      label: "Aufträge", value: String(data.orders.length),
      sub: relevant.length
        ? `${relevant.length} relevant · ${other.length} weitere — Klick auf das Dokument-Symbol öffnet die Dateien rechts`
        : "alle sichtbar — wie im Auftragsmodul",
    },
    material: {
      label: "Werkstoffe (Lager)", value: String(allMaterials.length),
      sub: matAlerts.reorder || matAlerts.low
        ? `${matAlerts.reorder} nachbestellen · ${matAlerts.low} knapp — gesamt`
        : `alle Bestände ok · ${data.materials.length} in der Eingrenzung`,
      danger: matAlerts.reorder > 0,
    },
    versand: {
      label: "Versandfertig", value: ready ? String(ready.length) : "…",
      sub: `${plural(shipments?.length ?? 0, "Versand", "Versände")} insgesamt`
        + (readyHere.length ? ` · ${readyHere.length} von hier` : ""),
      danger: (ready?.length ?? 0) > 0,
    },
    buchhaltung: {
      label: "Offene Rechnungen", value: invoices ? String(invOpen.length) : "…",
      sub: invoices ? `${fmtEur(invSum)}${invOverdue.length ? ` · ${invOverdue.length} überfällig` : ""}` : "wird geladen",
      danger: invOverdue.length > 0,
    },
  };

  return (
    <div>
      <StationControlBar active="station" stationId={String(s.id ?? id)} stationLabel={s.label} />

      {(() => {
        const isRunningNow = openSlots.some((x) => x.state === "running" || x.started)
          || queueOpen.some((q) => q.status === "running");
        const isOverloaded = cap > 0 && queueMin > cap;
        const loadPct = cap > 0 ? Math.min(100, Math.round((queueMin / cap) * 100)) : 0;
        const statusCls = !s.active
          ? "is-inactive"
          : isRunningNow
            ? "is-running"
            : isOverloaded
              ? "is-overload"
              : "";
        const statusText = !s.active
          ? "Inaktiv"
          : isRunningNow
            ? "Läuft"
            : isOverloaded
              ? "Überlastet"
              : openSlots.length > 0
                ? "Bereit"
                : "Frei";
        const badges = <>
          {s.machine_kind && <Tag minimal icon="cog">{MACHINE_LABEL[s.machine_kind]}</Tag>}
          {s.is_storage && <Tag minimal intent="primary" icon="box">Lager</Tag>}
          {s.subtype && <Tag minimal>{s.subtype}</Tag>}
          <Tag minimal icon="route">{ROUTING_LABEL[s.routing as StationRouting]}</Tag>
          <Tag minimal icon={s.visibility === "hide" ? "eye-off" : "eye-open"}>
            {VISIBILITY_LABEL[s.visibility as StationVisibility]}
          </Tag>
        </>;
        return (
          <>
            {/* Hero Machine Cockpit Banner */}
            <header className="st-hero" style={{ borderLeftColor: stationColour(s) }}>
              <div className="st-hero-top">
                <div>
                  <div className="st-hero-title-row">
                    <span className="station-dot station-dot-lg" style={{ background: stationColour(s) }} />
                    <h1 className="st-hero-title">{s.label}</h1>
                    <span className={`st-state-pill ${statusCls}`}>
                      {isRunningNow && <span className="ls-live-pulse" />}
                      {statusText}
                    </span>
                    <PageInfo text={<>
                      <p>{pageInfo("station")}</p>
                      <p>Die Reihenfolge fällt aus Zusage, Eil und Liegezeit, umsortiert, um Rüstwechsel zu sparen, aber nur solange
                        keine Zusage bricht. Neben jeder Aufgabe steht, warum sie an dieser Stelle steht.</p>
                    </>} />
                  </div>
                  <div className="st-hero-sub">
                    <Tag minimal intent="primary">{TYPE_LABEL[s.type]}</Tag>
                    {simple ? (
                      <Tooltip content={<span className="station-badge-tip">{badges}</span>} placement="bottom">
                        <Tag minimal interactive icon="info-sign" tabIndex={0} aria-label="Angaben zur Station">Angaben</Tag>
                      </Tooltip>
                    ) : badges}
                    {data.all_for_all && <Tag intent="warning">All-for-all an</Tag>}
                    {updatedAt && (
                      <span className="sub mono" style={{ marginLeft: 4 }}>
                        · Stand {updatedAt.toLocaleTimeString("de-DE")}
                        {hid > 0 && ` · ${hid} ausgeblendet`}
                      </span>
                    )}
                  </div>
                </div>
                <div className="st-hero-actions">
                  <Button small icon="refresh" text="Aktualisieren" onClick={refreshAll} />
                  {isAdmin && <Button small icon="edit" text="Bearbeiten" onClick={() => navigate("grundriss/admin")} />}
                  <Button small minimal icon="link" title="Dauerlink auf diese Stations-Unterseite" onClick={copyLink} />
                </div>
              </div>
            </header>

            {gaps.length > 0 && (
              <Callout compact intent="warning" icon="warning-sign" className="twin-note">
                Dieser Maschine fehlen <b>{gaps.join(", ")}</b>. Die betroffenen Faktoren der
                Zuordnung bleiben stumm — sie raten nicht.
              </Callout>
            )}

            {/* Telemetry Gauges + Lage im Grundriss */}
            <div className="st-cockpit-grid">
              <div className="st-gauges" role="group" aria-label="Stations-Telemetrie">
                {/* 1. Schichtauslastung / Abarbeitung */}
                <div
                  className={`st-gauge-card is-clickable ${isOverloaded || (sched?.late?.length ?? 0) > 0 ? "is-danger" : "is-accent"}${activeTab === "abarbeitung" ? " is-active" : ""}`}
                  onClick={() => setTab("abarbeitung")}
                  title="Zum Reiter Abarbeitung wechseln"
                >
                  <div className="st-gauge-label">
                    <span>Abarbeitung &amp; Last</span>
                    {cap > 0 && <span className="mono">{Math.round((queueMin / cap) * 100)} %</span>}
                  </div>
                  <div className="st-gauge-val">
                    {openSlots.length} {openSlots.length === 1 ? "Aufgabe" : "Aufgaben"}
                    {sched?.times_known && <span className="sub mono" style={{ fontSize: 13, marginLeft: 8 }}>{fmtMin(sched.total_min)}</span>}
                  </div>
                  {cap > 0 && (
                    <div className="st-gauge-bar" aria-hidden="true">
                      <div className={`st-gauge-bar-fill${isOverloaded ? " is-danger" : loadPct >= 80 ? " is-warn" : ""}`}
                           style={{ width: `${loadPct}%` }} />
                    </div>
                  )}
                  <div className="sub">
                    {cap > 0 ? `Schlange ${fmtMin(queueMin)} / ${fmtMin(cap)} Tageskapazität` : (KPI.abarbeitung?.sub ?? "")}
                  </div>
                </div>

                {/* 2. Rüstzustand & Materialweg */}
                <div
                  className={`st-gauge-card is-info${tabs.includes("material") ? " is-clickable" : ""}${activeTab === "material" ? " is-active" : ""}`}
                  onClick={() => tabs.includes("material") && setTab("material")}
                >
                  <div className="st-gauge-label">
                    <span>Rüstzustand &amp; Weg</span>
                    {data.supply[0] && <span className="mono">{fmtM(data.supply[0].metres)}</span>}
                  </div>
                  <div className="st-gauge-val" style={{ fontSize: 16 }}>
                    {s.last_mat
                      ? <><MatName id={s.last_mat} />{s.last_thk ? ` · ${s.last_thk.toLocaleString("de-DE")} mm` : ""}</>
                      : <span className="sub">Kein Rüstzustand</span>}
                  </div>
                  <div className="sub">
                    {data.supply[0]
                      ? `${data.supply[0].label} · ${Math.round(data.supply[0].minutes)} min Transport${!data.supply[0].exact ? " (Luftlinie)" : ""}`
                      : "Kein Lagerweg hinterlegt"}
                  </div>
                </div>

                {/* 3 & 4. Weitere Modul-KPIs dieser Station (z. B. Warteschlange / Aufträge / Versand / Buchhaltung) */}
                {tabs.filter((t) => t !== "abarbeitung" && KPI[t]).slice(0, 2).map((t) => {
                  const k = KPI[t]!;
                  return (
                    <div
                      key={t}
                      className={`st-gauge-card is-clickable ${k.danger ? "is-danger" : "is-info"}${activeTab === t ? " is-active" : ""}`}
                      onClick={() => setTab(t)}
                      title={`Zum Reiter ${k.label} wechseln`}
                    >
                      <div className="st-gauge-label"><span>{k.label}</span></div>
                      <div className="st-gauge-val">{k.value}</div>
                      <div className="sub">{k.sub}</div>
                    </div>
                  );
                })}
              </div>

              <MiniMap floor={floor} stations={stations} hereId={s.id ?? null} label={s.label}
                supply={data.supply} />
            </div>
          </>
        );
      })()}

      {/* Aktueller Fokus am Arbeitsplatz: Operator Active Job Command Panel */}
      {(() => {
        const slot = openSlots.find((x) => x.state === "running" || x.started) ?? openSlots[0] ?? null;
        const job = !slot ? (queueOpen.find((q) => q.status === "running") ?? queueOpen[0] ?? null) : null;
        const woRef = slot && (slot.kind === "cut" || slot.kind === "pick") ? slot.ref : job?.no ?? null;
        if (!slot && !job) return null;
        const running = slot ? (slot.state === "running" || slot.started) : job?.status === "running";
        const refText = slot ? slot.ref : job!.no;
        const matText = slot
          ? [slot.mat_name || slot.mat, slot.thk ? `${slot.thk.toLocaleString("de-DE")} mm` : ""].filter(Boolean).join(" · ")
          : [job!.mat_name || job!.mat, job!.thk ? `${job!.thk.toLocaleString("de-DE")} mm` : ""].filter(Boolean).join(" · ");
        const metaParts = slot
          ? [
              slot.n_plates ? plural(slot.n_plates, "Platte", "Platten") : "",
              slot.n_parts ? plural(slot.n_parts, "Teil", "Teile") : "",
              slot.finish_min != null && slot.start_min != null && slot.finish_min > slot.start_min
                ? fmtMin(slot.finish_min - slot.start_min) : "",
            ].filter(Boolean)
          : [
              plural(job!.n_plates, "Platte", "Platten"),
              plural(job!.n_parts, "Teil", "Teile"),
              job!.planned_min ? fmtMin(job!.planned_min) : "",
            ].filter(Boolean);
        const busyThis = slot ? schedBusy === `${slot.kind}:${slot.ref}` : false;
        return (
          <section className={"st-focus-hero" + (running ? " is-running" : "")} aria-label="Aktuelle Aufgabe am Arbeitsplatz">
            <div className="station-focus-copy">
              <div className="station-focus-kicker">
                <span className={"station-focus-badge" + (running ? " is-running" : "")}>
                  {running ? "Läuft jetzt" : "Als Nächstes"}
                </span>
                <span className="st-focus-ref">{refText}</span>
                {slot?.rush && <Tag minimal intent="danger" icon="flash">Eil</Tag>}
                {slot?.late && <Tag minimal intent="danger" icon="warning-sign">Zusage reißt</Tag>}
              </div>
              <div className="st-focus-chips">
                {matText && <span className="wq-chip">{matText}</span>}
                {metaParts.map((m, idx) => <span key={idx} className="wq-chip">{m}</span>)}
                {slot?.reason && <span className="sub">{slot.reason}</span>}
              </div>
            </div>
            <div className="st-focus-cta">
              {slot && slot.task_id != null && !running && (
                <Button intent="primary" icon="play" text="Anfangen" loading={busyThis}
                  onClick={() => taskState(slot, "running")} />
              )}
              {slot && slot.task_id != null && running && (
                <Button intent="success" icon="tick" text="Fertig melden" loading={busyThis}
                  onClick={() => taskState(slot, "done")} />
              )}
              {!slot && job && job.status === "open" && (
                <Button intent="primary" icon="play" text="Starten"
                  onClick={() => setWoStatus(job.no, job.status, "running")} />
              )}
              {!slot && job && job.status === "running" && (
                <Button intent="success" icon="tick" text="Fertig melden"
                  onClick={() => setWoStatus(job.no, job.status, "done")} />
              )}
              {woRef && (
                <>
                  <Button icon="print" text="Laufkarte" onClick={() => openTraveller(woRef)} />
                  <LaufkarteShareControl woNo={woRef} />
                  <Button minimal icon="document" text="Dateien" onClick={() => openFiles(woRef)} />
                </>
              )}
            </div>
          </section>
        );
      })()}

      <div className="st-workspace">
      <Tabs id="station-tabs" className="station-tabs" selectedTabId={activeTab}
            onChange={(t) => {
              const next = String(t) as TabId;
              setTab(next);
              // Der gewählte Reiter steht in der Adresse, damit ein Link, ein
              // Neuladen oder Zurück/Vorwärts denselben Reiter öffnet.
              navigate(`station/${id}?tab=${next}`);
            }} renderActiveTabPanelOnly>

        {/* --------------------------------------------------- Abarbeitung */}
        {/* Der erste Reiter jeder Station, gleich für alle vier Typen: was
            hier der Reihe nach dran ist, warum, und wann es fertig wäre.
            Ein Regal sieht dieselbe Liste wie ein Plotter — nur mit anderem
            Inhalt, nicht mit anderer Logik. */}
        {tabs.includes("abarbeitung") && (
          <Tab id="abarbeitung"
            title={`Abarbeitung (${openSlots.length})`}
            panel={
              <div className="station-panel">
                <div className="card-title-row">
                  <h2 className="card-title">
                    {WORK_NOUN[stype] ?? "Aufgaben"} in Reihenfolge
                  </h2>
                  <div className="row-actions">
                    {office && slots.some((x) => x.pinned) && (
                      <Button small minimal icon="pin" text="Handreihenfolge lösen"
                              onClick={freeOrder} />
                    )}
                    <Button small minimal icon="sort-numerical" text="Arbeitsvorrat der Halle"
                            onClick={() => navigate("arbeitsvorrat")} />
                  </div>
                </div>
                <More hide>
                  <p className="sub">
                    Die Reihenfolge fällt aus Zusage, Eil und Liegezeit — umsortiert,
                    um Rüstwechsel zu sparen, aber nur solange keine Zusage bricht.
                    Neben jeder Aufgabe steht, warum sie an dieser Stelle steht.
                  </p>
                </More>
                {sched ? (
                  <WorkQueue
                    schedule={sched}
                    stationType={stype}
                    showKind={false}
                    compact={simple}
                    emptyText={`${s.label} ist frei — nichts zugeordnet.`}
                    actions={{
                      busyRef: schedBusy,
                      onStart: (x) => taskState(x, "running"),
                      onDone: (x) => taskState(x, "done"),
                      onReset: (x) => taskState(x, "ready"),
                      onRelease: office ? taskRelease : undefined,
                      onMove: office ? taskMove : undefined,
                      onFiles: (x) => {
                        // cut- und pick-Aufgaben tragen den Innenauftrag als ref —
                        // dafür gibt es Dateien; pack/process haben keine.
                        if (x.kind === "cut" || x.kind === "pick") openFiles(x.ref);
                      },
                    }}
                  />
                ) : (
                  <NonIdealState icon="sort-numerical" title="Keine Abarbeitungsliste"
                    description="Diese Station hat noch keine Aufgaben — der Arbeitsvorrat der Halle zeigt, was zu verteilen wäre."
                    action={<Button icon="arrow-right" text="Arbeitsvorrat"
                                    onClick={() => navigate("arbeitsvorrat")} />} />
                )}
              </div>
            } />
        )}

        {/* ------------------------------------------------- Warteschlange */}
        {tabs.includes("warteschlange") && (
          <Tab id="warteschlange"
            title={stype === "warehouse" ? `Bereitstellung (${pickList.length})` : `Warteschlange (${queueOpen.length})`}
            panel={
              stype === "warehouse" ? (
                <PickList rows={pickList} materials={data.materials} />
              ) : (
                <QueuePanel
                  queue={queue} unassigned={unassigned} allOpen={allOpenWos}
                  stationLabels={stationLabels} fits={woFits}
                  stationId={s.id ?? 0}
                  stationLabel={s.label} capacity={cap} queueMin={queueMin}
                  autoRouting={data.auto_routing} routing={s.routing}
                  onWhy={office ? openRanking : undefined} onAssign={office ? assignTo : undefined}
                  onStatus={setWoStatus} onFiles={openFiles}
                  onTraveller={openTraveller} compact={simple} />
              )
            } />
        )}

        {/* ------------------------------------------------------ Aufträge */}
        {tabs.includes("auftraege") && (
          <Tab id="auftraege" title={`Aufträge (${orderRows.length})`} panel={
            <div className="station-panel">
              <div className="toolbar">
                <InputGroup leftIcon="search" placeholder="Nummer, Kunde, Bearbeiter, Teil…"
                  value={ordersQ} style={{ width: 280 }}
                  onChange={(e) => setOrdersQ(e.target.value)} />
                <HTMLSelect value={ordersFilter} onChange={(e) => setOrdersFilter(e.currentTarget.value)}>
                  <option value="relevant">relevante ({relevant.length})</option>
                  <option value="weitere">weitere ({other.length})</option>
                  <option value="eil">Eilaufträge ({data.orders.filter((o) => o.rush).length})</option>
                  <option value="ohne_bearbeiter">ohne Bearbeiter ({data.orders.filter((o) => !o.handler_user_id).length})</option>
                  <option value="alle">alle ({data.orders.length})</option>
                </HTMLSelect>
                <span className="sub">
                  {constrained
                    ? "Material/Dicke passen zur Station — hier wird gearbeitet."
                    : "Station ohne Eingrenzung — sie sieht alle Aufträge."}
                </span>
              </div>
              {orderRows.length === 0 ? (
                <NonIdealState icon="inbox" title="Keine Aufträge in dieser Auswahl"
                  description="Filter weiten oder einen anderen Auftrag ansehen." />
              ) : (
                <HTMLTable compact className="data-table order-table" striped interactive>
                  <thead>
                    <tr>
                      <th>Auftrag</th><th>Stand</th><th>Positionen</th>
                      <th>Bearbeiter</th><th>Aktionen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderRows.map((o) => (
                      <OrderRowView key={o.no} o={o} muted={!o.relevant} busy={busyNo === o.no}
                        open={expanded.has(o.no)}
                        files={woByOrder.get(o.no) ?? []}
                        onFiles={openFiles}
                        onTraveller={openTraveller}
                        onToggle={() => setExpanded((cur) => {
                          const n = new Set(cur);
                          if (n.has(o.no)) n.delete(o.no); else n.add(o.no);
                          return n;
                        })}
                        onComplete={() => markComplete(o)}
                        canComplete={completableOrders.has(o.no)}
                        onHandler={office ? () => openHandlers(o) : undefined} />
                    ))}
                  </tbody>
                </HTMLTable>
              )}
            </div>
          } />
        )}

        {/* ------------------------------------------------------ Material */}
        {tabs.includes("material") && (
          <Tab id="material" title={`Material (${allMaterials.length})`} panel={
            <div className="station-panel station-material">
              <div className="station-material-side">
                <Card>
                  <h2 className="card-title">Eingrenzung</h2>
                  <dl className="kv">
                    <dt>Werkstoffe</dt>
                    <dd>{s.materials.length ? s.materials.join(", ") : "alle"}</dd>
                    <dt>Dicken</dt>
                    <dd>{s.thicknesses.length ? `${s.thicknesses.join(", ")} mm` : "alle"}</dd>
                    <dt>Aufträge sichtbar</dt>
                    <dd>{data.orders.length}{hid > 0 ? ` (${hid} ausgeblendet)` : ""}</dd>
                  </dl>
                  <p className="sub" style={{ marginTop: 8 }}>
                    Die Tabelle zeigt den vollen Bestand wie das Lagermodul —
                    markierte Zeilen liegen in der Eingrenzung dieser Station.
                  </p>
                </Card>
                {data.supply.length > 0 && (
                  <Card>
                    <h2 className="card-title">Wege zum Lager</h2>
                    <HTMLTable compact className="data-table">
                      <tbody>
                        {data.supply.map((sup) => (
                          <tr key={sup.id}>
                            <td>{sup.label}</td>
                            <td className="num mono">{fmtM(sup.metres)}</td>
                            <td className="sub">{sup.exact ? "über Gänge" : "Luftlinie"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </HTMLTable>
                  </Card>
                )}
              </div>
              <div className="station-material-main">
                <div className="toolbar">
                  <InputGroup leftIcon="search" placeholder="Werkstoff suchen…" value={matQ}
                    style={{ width: 240 }} onChange={(e) => setMatQ(e.target.value)} />
                  <HTMLSelect value={matSort} onChange={(e) => setMatSort(e.currentTarget.value)}>
                    <option value="name">nach Name</option>
                    <option value="stock">nach Lager (aufsteigend)</option>
                    <option value="price">nach €/m² (aufsteigend)</option>
                  </HTMLSelect>
                  <span className="sub">{matRows.length} von {allMaterials.length}</span>
                </div>
                {matRows.length === 0 ? (
                  <NonIdealState icon="layers" title="Kein Werkstoff passt"
                    description="Suche zurücksetzen oder Stationseingrenzung prüfen." />
                ) : (
                  <HTMLTable compact className="data-table" striped>
                    <thead>
                      <tr><th>Werkstoff</th><th>Dicken</th><th className="num">Lager</th>
                          <th className="num">€/m²</th><th>Bestand</th></tr>
                    </thead>
                    <tbody>
                      {matRows.map((m) => {
                        const h = stockHealth(m.stock);
                        return (
                          <tr key={m.id} className={scopedIds.has(m.id) ? "row-active" : undefined}>
                            <td>{m.name}<div className="sub mono">{m.id}</div></td>
                            <td className="sub">{(m.thicknesses ?? []).join(" · ") || "—"} mm</td>
                            <td className="num">{m.stock}</td>
                            <td className="num">{fmtEur(m.eur_m2)}</td>
                            <td>
                              <Tag minimal intent={h.intent}>{h.label}</Tag>
                              {scopedIds.has(m.id) && (
                                <Tag minimal intent="primary" style={{ marginLeft: 4 }}>Station</Tag>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </HTMLTable>
                )}
              </div>
            </div>
          } />
        )}

        {/* ------------------------------------------------------- Versand */}
        {tabs.includes("versand") && (
          <Tab id="versand" title={`Versand (${ready?.length ?? 0})`} panel={
            <div className="station-panel">
              <h2 className="station-subhead">Versandfertig ({ready?.length ?? 0})
                <span className="sub">Derselbe Bestand wie im Versandmodul — markierte Aufträge gehen über diese Station.</span></h2>
              {!ready ? <Spinner size={26} /> : ready.length === 0 ? (
                <p className="sub">Nichts wartet auf den Versand.</p>
              ) : (
                <>
                  <HTMLTable compact className="data-table" striped>
                    <thead>
                      <tr>
                        <th>
                          <Checkbox
                            aria-label="Alle versandfertigen Aufträge auswählen"
                            checked={ready.length > 0 && ready.every((r) => shipSel.includes(r.order_no))}
                            indeterminate={shipSel.length > 0 && shipSel.length < ready.length}
                            onChange={(e) => setShipSel(e.currentTarget.checked ? ready.map((r) => r.order_no) : [])}
                          />
                        </th>
                        <th>Auftrag</th><th>Kunde</th>
                        <th className="num">Versandfertige Teile</th><th>Fällig</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ready.map((r) => (
                        <tr key={r.order_no} className={relevantNos.has(r.order_no) ? "row-active" : undefined}>
                          <td>
                            <Checkbox checked={shipSel.includes(r.order_no)}
                              onChange={(e) => setShipSel(e.target.checked
                                ? [...shipSel, r.order_no]
                                : shipSel.filter((n) => n !== r.order_no))} />
                          </td>
                          <td className="mono">
                            <RefLink kind="order" no={r.order_no} />
                            {r.rush && <Tag minimal intent="danger" style={{ marginLeft: 4 }}>Eil</Tag>}
                            {relevantNos.has(r.order_no) && (
                              <Tag minimal intent="primary" style={{ marginLeft: 4 }}>Station</Tag>
                            )}
                          </td>
                          <td>{r.customer}</td>
                          <td className="num">{r.n_ready} / {r.n_positions}</td>
                          <td>{fmtDate(r.due_date)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </HTMLTable>
                  <div className="toolbar" style={{ marginTop: 10 }}>
                    <Button intent="primary" icon="box" disabled={!shipSel.length}
                      onClick={() => setShipOpen(true)}>
                      Versand anlegen ({shipSel.length}) — Tracking erfassen
                    </Button>
                  </div>
                </>
              )}

              <h2 className="station-subhead" style={{ marginTop: 22 }}>
                Versände ({shipments?.length ?? 0})
              </h2>
              {!shipments ? <Spinner size={26} /> : shipments.length === 0 ? (
                <p className="sub">Noch keine Versände.</p>
              ) : (
                <HTMLTable compact className="data-table" striped>
                  <thead>
                    <tr><th>Versand</th><th>Status</th><th>Spedition</th><th>Tracking</th>
                        <th className="num">Positionen</th><th>Angelegt</th><th><span className="sr-only">Aktion</span></th></tr>
                  </thead>
                  <tbody>
                    {shipments.map((sh) => {
                      const mine = sh.items.some((i) => relevantNos.has(i.order_no));
                      return (
                        <tr key={sh.no} className={mine ? "row-active" : undefined}>
                          <td className="mono"><RefLink kind="shipment" no={sh.no} />
                            {mine && <Tag minimal intent="primary" style={{ marginLeft: 4 }}>Station</Tag>}
                          </td>
                          <td><Tag minimal intent={shipTag(sh.status).intent}>{shipTag(sh.status).label}</Tag></td>
                          <td>{sh.carrier || "—"}</td>
                          <td className="mono">{sh.tracking || "—"}</td>
                          <td className="num">{sh.n_items}</td>
                          <td className="sub">{fmtDateTime(sh.created_at)}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            {sh.status === "packing" &&
                              <Button small minimal icon="truck" text="Versendet"
                                onClick={() => setShipmentStatus(sh, "shipped")} />}
                            {sh.status === "shipped" &&
                              <Button small minimal icon="tick" text="Zugestellt"
                                onClick={() => setShipmentStatus(sh, "delivered")} />}
                            <Button small minimal icon="list" title="Inhalt nach Auftrag"
                              onClick={() => openShipmentDetail(sh.no)} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </HTMLTable>
              )}
              <div className="toolbar" style={{ marginTop: 12 }}>
                <Button small icon="truck" text="Versandmodul öffnen" onClick={() => navigate("versand")} />
              </div>
            </div>
          } />
        )}

        {/* --------------------------------------------------- Buchhaltung */}
        {tabs.includes("buchhaltung") && (
          <Tab id="buchhaltung" title={`Buchhaltung (${invOpen.length})`} panel={
            <div className="station-panel">
              <div className="toolbar">
                <span className="sub">
                  Alle Rechnungen, wie im Buchhaltungsmodul — offen {fmtEur(invSum)}
                  {invOverdue.length ? `, ${invOverdue.length} überfällig` : ""}.
                </span>
                <span style={{ flex: 1 }} />
                <Button small icon="euro" text="Buchhaltung öffnen" onClick={() => navigate("buchhaltung")} />
              </div>
              {!invoices ? <Spinner size={26} /> : invHere.length === 0 ? (
                <NonIdealState icon="euro" title="Keine Rechnungen"
                  description="Rechnungen werden in der Buchhaltung gestellt." />
              ) : (
                <HTMLTable compact className="data-table" striped>
                  <thead>
                    <tr><th>Auftrag</th><th>Kunde</th><th className="num">Brutto</th>
                        <th>Gestellt</th><th>Fällig</th><th>Zustand</th><th><span className="sr-only">Aktion</span></th></tr>
                  </thead>
                  <tbody>
                    {invHere.map((i) => (
                      <tr key={i.order_no}
                          className={(i.days_overdue > 0 && !i.paid ? "row-dirty" : undefined)
                            + (relevantNos.has(i.order_no) ? " row-active" : "")}>
                        <td className="mono"><RefLink kind="order" no={i.order_no} />
                          {relevantNos.has(i.order_no) && (
                            <Tag minimal intent="primary" style={{ marginLeft: 4 }}>Station</Tag>
                          )}
                        </td>
                        <td>{i.customer || "—"}</td>
                        <td className="num mono">{fmtEur(i.gross)}</td>
                        <td className="sub">{fmtDate(i.invoiced_at)}</td>
                        <td className="sub">{fmtDate(i.due_at)}</td>
                        <td>
                          {i.paid
                            ? <Tag intent="success" minimal>bezahlt {fmtDate(i.paid_at)}</Tag>
                            : i.days_overdue > 0
                              ? <Tag intent="danger" minimal>{plural(i.days_overdue, "Tag", "Tage")} überfällig</Tag>
                              : <Tag minimal>offen</Tag>}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <Button small minimal icon="document" title="Rechnung als PDF"
                            onClick={() => grab(`/api/invoicing/orders/${i.order_no}/invoice.pdf`,
                                                `Rechnung-${i.order_no}.pdf`)} />
                          {!i.paid &&
                            <Button small minimal intent="success" icon="tick" title="Zahlung von Hand buchen"
                              onClick={() => markPaid(i)} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </HTMLTable>
              )}
            </div>
          } />
        )}

        {/* ------------------------------------------------------- Station */}
        <Tab id="station" title="Station" panel={
          <StationInfo station={s} supply={data.supply} queueMin={queueMin}
            queueJobs={queueOpen.length} autoRouting={data.auto_routing} />
        } />
      </Tabs>
      </div>

      {/* --------------------------------------------------- Versanddialog */}
      <Dialog isOpen={shipOpen} onClose={() => setShipOpen(false)} style={{ width: 520 }}
              title={`Versand anlegen — ${shipSel.length} Auftrag/Aufträge`}>
        <DialogBody>
          <p className="sub" style={{ marginBottom: 12 }}>
            Spedition und Sendungsnummer werden dem Kunden gespiegelt (Auftragsverfolgung & Konto).
          </p>
          <div className="form-grid">
            <label>Spedition
              <InputGroup value={shipCarrier} placeholder="z. B. UPS, DHL, DPD"
                onChange={(e) => setShipCarrier(e.target.value)} />
            </label>
            <label>Sendungsnummer / Tracking
              <InputGroup value={shipTracking} placeholder="z. B. 1Z…"
                onChange={(e) => setShipTracking(e.target.value)} autoFocus />
            </label>
          </div>
          <label style={{ display: "block", marginTop: 10 }}>Notiz (optional)
            <InputGroup value={shipNote} placeholder="Hinweis für den Kunden"
              onChange={(e) => setShipNote(e.target.value)} />
          </label>
          <Callout intent="primary" icon="info-sign" style={{ marginTop: 12 }}>
            Ausgewählt: <b className="mono">{shipSel.join(", ") || "—"}</b>
          </Callout>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setShipOpen(false)} />
            <Button intent="primary" icon="box" text="Versand anlegen" loading={shipBusy} onClick={createShipment} />
          </>} />
      </Dialog>

      <Dialog isOpen={!!shipDetail} onClose={() => setShipDetail(null)} style={{ width: 720 }}
              title={`Inhalt von ${shipDetail?.no ?? ""}`}>
        <DialogBody>
          {shipDetail?.data.orders.length === 0 ? <p>Dieser Versand ist leer.</p> :
            shipDetail?.data.orders.map((o) => (
              <div key={o.order_no} style={{ marginBottom: 18 }}>
                <h2 className="mono"><RefLink kind="order" no={o.order_no} /></h2>
                <HTMLTable className="data-table" striped compact>
                  <thead>
                    <tr><th>Marke</th><th>Teil</th><th>Werkstoff</th><th className="num">Dicke</th>
                        <th className="num">Stück</th><th>Innenauftrag</th></tr>
                  </thead>
                  <tbody>
                    {o.items.map((it, i) => (
                      <tr key={`${it.tag}-${i}`}>
                        <td className="mono"><b>{it.tag}</b></td>
                        <td>{it.label}{it.note && <div className="sub">{it.note}</div>}</td>
                        <td>{it.mat}</td>
                        <td className="num">{it.thk} mm</td>
                        <td className="num">{it.qty}</td>
                        <td className="mono sub"><RefLink kind="work_order" no={it.work_order_no} /></td>
                      </tr>
                    ))}
                  </tbody>
                </HTMLTable>
              </div>
            ))}
        </DialogBody>
        <DialogFooter actions={<Button text="Schließen" onClick={() => setShipDetail(null)} />} />
      </Dialog>

      {/* ------------------------------------------------ Maschinenwahl */}
      <Dialog isOpen={rankFor != null} onClose={() => { setRankFor(null); setRanks(null); }}
              icon="route" style={{ width: 760 }}
              title={rankFor ? `Maschinenwahl — ${rankFor}` : ""}>
        <DialogBody>
          {!ranks ? <Spinner size={28} /> : (
            <>
              <p className="sub">
                Jede Station gegen diesen Innenauftrag, Faktor für Faktor. Die Ordnung folgt
                der Effizienzregel — zuerst fertig gewinnt; der Punktwert entscheidet nur bei
                Gleichstand und wenn Zeiten fehlen.
              </p>
              <RankBars ranking={ranks} chosenId={s.id ?? null} />
            </>
          )}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Schließen" onClick={() => { setRankFor(null); setRanks(null); }} />
            {rankFor && s.id != null && (
              <Button intent="primary" icon="tick" text={`Auf ${s.label} legen`}
                onClick={() => assignTo(rankFor, s.id!)} />
            )}
          </>} />
      </Dialog>

      {/* --------------------------------------------- Bearbeiterzuordnung */}
      <Dialog isOpen={handlerFor != null} onClose={() => { setHandlerFor(null); setHandlerRanks(null); }}
              icon="person" style={{ width: 660 }}
              title={handlerFor ? `Bearbeiter — ${handlerFor.no}` : ""}>
        <DialogBody>
          {!handlerRanks ? <Spinner size={28} /> : (
            <>
              <p className="sub">
                Vorgeschlagen wird, wer <b>{handlerFor?.customer_ref || "diesen Kunden"}</b> schon
                betreut hat: wer den Kunden kennt, kennt seine Zeichnungsstände. Bei gleichem
                Stand entscheidet, wer gerade weniger offen hat.
              </p>
              <HandlerBars ranking={handlerRanks} chosenId={handlerFor?.handler_user_id ?? null} />
              <div className="dialog-actions">
                {handlerRanks.filter((h) => h.eligible).slice(0, 3).map((h) => (
                  <Button key={h.user_id} intent="primary" icon="tick" text={`${h.name} zuordnen`}
                    onClick={() => handlerFor && setHandler(handlerFor.no, h.user_id, h.summary)} />
                ))}
                {handlerFor?.handler_user_id != null && (
                  <Button icon="cross" text="Zuordnung lösen"
                    onClick={() => setHandler(handlerFor.no, null)} />
                )}
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter actions={
          <Button text="Schließen" onClick={() => { setHandlerFor(null); setHandlerRanks(null); }} />} />
      </Dialog>

      {/* Rechter Seitenrahmen — Dateien aus Abarbeitung / Warteschlange / Aufträgen */}
      {drawerWo && (
        <div className="station-drawer-backdrop" onClick={closeDrawer}>
          <aside className="station-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="side-head">
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div className="side-kicker">Schnittdateien</div>
                  <h2 className="mono" style={{ margin: "2px 0 2px" }}>{drawerWo}</h2>
                  {drawerDetail && (
                    <div className="sub" style={{ marginTop: 2 }}>
                      {drawerDetail.mat_name || drawerDetail.mat} · {drawerDetail.thk} mm · {plural(drawerDetail.n_plates, "Platte", "Platten")} · {plural(drawerDetail.n_parts, "Teil", "Teile")}
                      {" · "}{Math.round((drawerDetail.utilisation || 0) * 100)} % Ausnutzung
                    </div>
                  )}
                  {!drawerDetail && !drawerBusy && <div className="sub">wird geladen…</div>}
                </div>
                <Button minimal icon="cross" onClick={closeDrawer} title="Schließen (Esc)" />
              </div>
              {drawerDetail && (
                <div className="toolbar" style={{ margin: "12px 0 0" }}>
                  <Button small icon="print" intent="primary" text="Laufkarte"
                          onClick={() => openTraveller(drawerDetail.no)} />
                  <LaufkarteShareControl woNo={drawerDetail.no} small />
                  <Button small icon="download" text="HTML speichern"
                          title="Laufkarte als eigenständige HTML-Datei zum Mitnehmen"
                          onClick={() => grab(`/api/production/work-orders/${drawerDetail.no}/sheet?download=1`,
                                              `${drawerDetail.no}-laufkarte.html`)} />
                  <Button small icon="archive" text="Alle (ZIP)"
                          onClick={() => grab(`/api/production/work-orders/${drawerDetail.no}/cutfiles.zip`,
                                              `${drawerDetail.no}-schnittdateien.zip`)} />
                </div>
              )}
            </div>
            <div className="side-body">
              {drawerBusy && <div style={{ padding: 18, textAlign: "center" }}><Spinner size={28} /></div>}
              {!drawerBusy && !drawerDetail && (
                <Callout intent="warning" icon="warning-sign">Innenauftrag {drawerWo} nicht gefunden.</Callout>
              )}
              {!drawerBusy && drawerDetail && (
                <>
                  {drawerDetail.cut_plan && (
                    <Callout
                      compact
                      intent={drawerDetail.cut_plan.layered ? "primary" : "none"}
                      icon={drawerDetail.cut_plan.layered ? "layers" : "info-sign"}
                      style={{ marginBottom: 12 }}
                    >
                      <b>Schnittfolge: {drawerDetail.cut_plan.label}</b>
                      {drawerDetail.cut_plan.reason ? ` — ${drawerDetail.cut_plan.reason}` : ""}
                    </Callout>
                  )}
                  <h3 className="files-sub">Platten</h3>
                  <PlatePreview wo={drawerDetail.no} idx={drawerPlate}
                                fmt={drawerDetail.plates[drawerPlate]?.fmt ?? []}
                                onPick={setDrawerPlate} nPlates={drawerDetail.plates.length} />
                  <HTMLTable compact className="data-table" striped>
                    <thead>
                      <tr><th>Platte</th><th>Format</th><th className="num">Teile</th>
                          <th className="num">Ausnutzung</th><th>Status</th><th>Dateien</th></tr>
                    </thead>
                    <tbody>
                      {drawerDetail.plates.map((p) => (
                        <tr key={p.idx}>
                          <td><b>{p.idx + 1}</b></td>
                          <td className="mono">{(p.fmt ?? []).map((v) => Math.round(v)).join(" × ")} mm</td>
                          <td className="num">{p.n_parts}</td>
                          <td className="num">{Math.round((p.utilisation || 0) * 100)} %</td>
                          <td><Tag minimal intent={woTag(p.status).intent}>{woTag(p.status).label}</Tag></td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <Button small minimal icon="media" title="Zeichnung (SVG) ansehen"
                                    onClick={() => openSvg(`/api/production/work-orders/${drawerDetail.no}/plate/${p.idx}.svg`)} />
                            <Button small minimal icon="download" title="Zeichnung (SVG) speichern"
                                    onClick={() => grab(`/api/production/work-orders/${drawerDetail.no}/plate/${p.idx}.svg?download=1`,
                                                        `${drawerDetail.no}-platte-${p.idx + 1}-zeichnung.svg`)} />
                            <Button small minimal icon="download" text="DXF"
                                    onClick={() => grab(`/api/production/work-orders/${drawerDetail.no}/plate/${p.idx}.dxf`,
                                                        `${drawerDetail.no}-platte-${p.idx + 1}.dxf`)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </HTMLTable>

                  <h3 className="files-sub">Nach Kundenauftrag</h3>
                  <p className="sub">Eine Datei je Kundenauftrag und Platte — nur was auf dieser Plattenfamilie liegt.</p>
                  <HTMLTable compact className="data-table" striped>
                    <thead><tr><th>Auftrag</th><th>Kunde</th><th className="num">Teile</th><th>Dateien</th></tr></thead>
                    <tbody>
                      {(drawerDetail.by_order ?? []).map((o) => (
                        <tr key={o.order_no}>
                          <td className="mono">
                            <RefLink kind="order" no={o.order_no} />
                            {o.done && <Tag minimal intent="success" style={{ marginLeft: 4 }}>fertig</Tag>}
                          </td>
                          <td>{o.customer || "—"}</td>
                          <td className="num">{o.n_parts}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            {drawerDetail.plates.map((p) => (
                              <Button key={p.idx} small minimal icon="download" text={`Platte ${p.idx + 1}`}
                                      onClick={() => grab(
                                        `/api/production/work-orders/${drawerDetail.no}/plate/${p.idx}/auftrag/${o.order_no}.dxf`,
                                        `${drawerDetail.no}-platte-${p.idx + 1}-${o.order_no}.dxf`)} />
                            ))}
                          </td>
                        </tr>
                      ))}
                      {!drawerDetail.by_order?.length && (
                        <tr><td colSpan={4} className="sub">Keine Aufträge zugeordnet.</td></tr>
                      )}
                    </tbody>
                  </HTMLTable>

                  <h3 className="files-sub">Nach Teil</h3>
                  <p className="sub">Jede Bestellposition einmal — mit Stückzahl, nicht zwölfmal.</p>
                  <HTMLTable compact className="data-table" striped>
                    <thead><tr><th>Teil</th><th>Auftrag</th><th>Kunde</th><th><span className="sr-only">Aktion</span></th></tr></thead>
                    <tbody>
                      {(drawerDetail.by_part ?? []).map((p) => (
                        <tr key={p.position_id}>
                          <td>{p.label || "Sonderfertigung"}</td>
                          <td className="mono"><RefLink kind="order" no={p.order_no} /></td>
                          <td>{p.customer || "—"}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <Button small minimal icon="media" title="Zeichnung ansehen"
                                    onClick={() => openSvg(`/api/production/work-orders/${drawerDetail.no}/part/${p.position_id}.svg`)} />
                            <Button small minimal icon="download" text="DXF"
                                    onClick={() => grab(`/api/production/work-orders/${drawerDetail.no}/part/${p.position_id}.dxf`,
                                                        `${drawerDetail.no}-pos${p.position_id}.dxf`)} />
                          </td>
                        </tr>
                      ))}
                      {!drawerDetail.by_part?.length && (
                        <tr><td colSpan={4} className="sub">Keine Teile.</td></tr>
                      )}
                    </tbody>
                  </HTMLTable>

                  <div style={{ marginTop: 16 }}>
                    <Button icon="cross" text="Schließen" onClick={closeDrawer} />
                  </div>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Warteschlange — was diese Maschine zu tun hat, in der Reihenfolge, in der
   sie es tut, mit der Zeit, die es kostet. Und darunter der volle Bestand des
   Produktionsmoduls: dieselbe Liste wie auf der Produktionsseite, die eigene
   Schlange oben, alles andere mit Station und Passungs-Markierung. Ziehen darf
   nur, was noch keiner Station gehört — fremde Zuordnungen werden gezeigt,
   nicht still umgebucht.
   -------------------------------------------------------------------------- */
function QueuePanel({
  queue, unassigned, allOpen, stationLabels, fits, stationId, stationLabel,
  capacity, queueMin, autoRouting, routing, onWhy, onAssign, onStatus, onFiles,
  onTraveller, compact = false,
}: {
  compact?: boolean;
  queue: QueueJob[]; unassigned: WorkOrder[]; allOpen: WorkOrder[];
  stationLabels: Record<number, string>; fits: (w: WorkOrder) => boolean;
  stationId: number; stationLabel: string;
  capacity: number; queueMin: number; autoRouting: boolean; routing: string;
  onWhy?: (no: string) => void;
  onAssign?: (no: string, sid: number | null, note?: string) => void;
  onStatus: (no: string, from: string, to: string) => void;
  onFiles: (no: string) => void;
  onTraveller: (no: string) => void;
}) {
  const [onlyFitting, setOnlyFitting] = useState(false);
  const open = queue.filter((q) => q.status !== "done" && q.status !== "cancelled");
  const fittingCount = allOpen.filter((w) => fits(w)).length;
  const visiblePool = onlyFitting ? allOpen.filter((w) => fits(w)) : allOpen;
  let cum = 0;

  return (
    <div className="station-panel">
      {capacity > 0 && (
        <div className="capacity-bar">
          <div className="capacity-track">
            <div className={"capacity-fill" + (queueMin > capacity ? " capacity-over" : "")}
              style={{ width: `${Math.min(100, (queueMin / capacity) * 100)}%` }} />
            <span className="capacity-mark" style={{ left: "100%" }} />
          </div>
          <span className="sub">
            {fmtMin(queueMin)} eingeplant von {fmtMin(capacity)} am Tag
            {queueMin > capacity && <b style={{ color: "var(--g-danger-ink)" }}> — über einen Arbeitstag hinaus</b>}
          </span>
        </div>
      )}

      {routing === "pull" && (
        <Callout compact intent="primary" icon="hand-up" style={{ marginBottom: 10 }}>
          Diese Station steht auf <b>Pull</b>: der Planer teilt ihr nichts zu. Was sie
          arbeitet, zieht sie sich unten selbst. Das ist eine Betriebsart, kein Mangel.
        </Callout>
      )}

      {open.length === 0 ? (
        <NonIdealState icon="tick-circle" title="Nichts in der Schlange"
          description="Kein Innenauftrag ist dieser Station zugeordnet." />
      ) : (
        <HTMLTable compact className="data-table" striped>
          <thead>
            <tr>
              <th>Innenauftrag</th><th>Werkstoff</th><th>Kundenaufträge</th>
              <th className="num">Platten</th>
              <th className="num">Teile</th><th className="num">Dauer</th>
              <th className="num">fertig nach</th><th>Fällig</th><th>Warum hier</th>
              <th>Status</th><th><span className="sr-only">Aktion</span></th>
            </tr>
          </thead>
          <tbody>
            {open.map((q) => {
              cum += q.planned_min || 0;
              const overdue = q.due_date && new Date(q.due_date).getTime() < Date.now();
              return (
                <tr key={q.no} className={(overdue ? "row-dirty" : "") + " row-interactive"}
                    onClick={() => onFiles(q.no)}
                    title="Dateien im Seitenrahmen rechts öffnen">
                  <td className="mono"><b>{q.no}</b>
                    <div className="sub">{q.release_reason || "—"}</div>
                    {q.note && <div className="sub" title={q.note}>Notiz: {q.note.slice(0, 60)}{q.note.length > 60 ? "…" : ""}</div>}
                  </td>
                  <td>{q.mat_name || q.mat}<div className="sub">{q.thk.toLocaleString("de-DE")} mm</div></td>
                  <td>
                    {(q.orders ?? []).length === 0 ? <span className="sub">—</span> : (
                      <div className="pos-list">
                        {(q.orders ?? []).slice(0, 3).map((o) => (
                          <span key={o.order_no} className="pos-item" title={`${o.order_no} · ${plural(o.n_parts, "Teil", "Teile")}`}>
                            {o.customer || o.order_no}
                            <b> × {o.n_parts}</b>
                          </span>
                        ))}
                        {(q.orders?.length ?? 0) > 3 && <span className="sub">+{q.orders.length - 3} …</span>}
                      </div>
                    )}
                  </td>
                  <td className="num">{q.n_plates}</td>
                  <td className="num">{q.n_parts}</td>
                  <td className="num mono">{q.planned_min ? fmtMin(q.planned_min) : "—"}</td>
                  <td className="num mono sub">{fmtMin(cum)}</td>
                  <td className={"num" + (overdue ? " sub-danger" : " sub")}>
                    {q.due_date ? fmtDate(q.due_date) : "—"}
                    {overdue && <div><Tag minimal intent="danger">überfällig</Tag></div>}
                  </td>
                  <td className="sub plan-reason">
                    {q.assign_mode && (
                      <Tag minimal intent={q.assign_mode === "manual" ? "primary" : "none"}>
                        {q.assign_mode === "manual" ? "von Hand" : q.assign_mode === "auto" ? "automatisch" : "Vorschlag"}
                      </Tag>
                    )}{" "}
                    {q.assign_reason || "—"}
                  </td>
                  <td><Tag minimal intent={woTag(q.status).intent}>{woTag(q.status).label}</Tag></td>
                  <td style={{ whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                    {compact ? (
                      /* Einfach: eine Hauptaktion je Zeile, der Rest im Menü. */
                      <span className="queue-compact-actions">
                        {q.status === "open" &&
                          <Button small icon="play" text="Starten" onClick={() => onStatus(q.no, q.status, "running")} />}
                        {q.status === "running" &&
                          <Button small intent="success" icon="tick" text="Fertig" title="Fertig melden"
                            onClick={() => onStatus(q.no, q.status, "done")} />}
                        <KeyPopover minimal placement="bottom-end" content={
                          <Menu>
                            <MenuItem icon="document" text="Zeichnungen und Schnittdateien" onClick={() => onFiles(q.no)} />
                            <MenuItem icon="print" text="Laufkarte drucken" onClick={() => onTraveller(q.no)} />
                            {onWhy && <MenuItem icon="chart" text="Warum diese Maschine?" onClick={() => onWhy(q.no)} />}
                            {q.status === "running" && <MenuItem icon="pause" text="Anhalten — zurück in die Schlange"
                              onClick={() => onStatus(q.no, q.status, "open")} />}
                            {q.status === "open" && <MenuItem icon="tick" text="Fertig melden"
                              onClick={() => onStatus(q.no, q.status, "done")} />}
                            {onAssign && <MenuItem icon="cross" text="Zuordnung lösen" title="Der Auftrag geht zurück in die Planung"
                              onClick={() => onAssign(q.no, null)} />}
                          </Menu>}>
                          <Button small minimal icon="more" aria-label={`Weitere Aktionen für ${q.no}`} title="Weitere Aktionen" />
                        </KeyPopover>
                      </span>
                    ) : <>
                    <Tooltip content="Laufkarte drucken">
                      <Button aria-label="Laufkarte drucken" small minimal icon="print" onClick={() => onTraveller(q.no)} />
                    </Tooltip>
                    <Tooltip content="Zeichnungen und Schnittdateien im Seitenrahmen">
                      <Button aria-label="Zeichnungen und Schnittdateien im Seitenrahmen" small minimal icon="document" intent="primary" onClick={() => onFiles(q.no)} />
                    </Tooltip>
                    {onWhy && <Tooltip content="Warum diese Maschine?">
                      <Button aria-label="Warum diese Maschine?" small minimal icon="chart" onClick={() => onWhy(q.no)} />
                    </Tooltip>}
                    {q.status === "open" &&
                      <Button small minimal icon="play" title="Starten"
                        onClick={() => onStatus(q.no, q.status, "running")} />}
                    {q.status === "running" &&
                      <Button small minimal icon="pause" title="Anhalten — zurück in die Schlange"
                        onClick={() => onStatus(q.no, q.status, "open")} />}
                    {q.status !== "done" &&
                      <Button small minimal intent="success" icon="tick" title="Fertig melden"
                        onClick={() => onStatus(q.no, q.status, "done")} />}
                    {onAssign && <Tooltip content="Zuordnung lösen — der Auftrag geht zurück in die Planung">
                      <Button aria-label="Zuordnung lösen — der Auftrag geht zurück in die Planung" small minimal icon="cross" onClick={() => onAssign(q.no, null)} />
                    </Tooltip>}
                    </>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </HTMLTable>
      )}

      <div className="station-subhead-row" style={{ marginTop: 22, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 className="station-subhead" style={{ margin: 0 }}>
          Alle offenen Innenaufträge ({visiblePool.length}{onlyFitting ? ` von ${allOpen.length}` : ""})
          <span className="sub">
            Der Bestand des Produktionsmoduls. „passt" markiert die zur Eingrenzung
            dieser Station — ziehen kann nur, was noch keiner Station gehört.
            {autoRouting ? " Die Automatik nimmt Passendes beim nächsten Lauf."
              : " Die Automatik ist aus; hier wird von Hand gezogen."}
          </span>
        </h2>
        {allOpen.length > 0 && (
          <Checkbox
            checked={onlyFitting}
            onChange={(e) => setOnlyFitting(e.currentTarget.checked)}
            label={`Nur passende (${fittingCount})`}
            style={{ marginBottom: 0, whiteSpace: "nowrap" }}
          />
        )}
      </div>
      {visiblePool.length === 0 ? (
        <p className="sub">
          {onlyFitting
            ? "Kein offener Innenauftrag passt zur Werkstoff-/Dicken-Eingrenzung dieser Station."
            : "Keine weiteren offenen Innenaufträge im Produktionsmodul."}
        </p>
      ) : (
        <HTMLTable compact className="data-table" striped>
          <thead>
            <tr><th>Innenauftrag</th><th>Werkstoff</th><th className="num">Platten</th>
                <th className="num">Teile</th><th>Station</th><th>Freigabe</th><th><span className="sr-only">Aktion</span></th></tr>
          </thead>
          <tbody>
            {visiblePool.slice(0, 30).map((w) => {
              const fitting = fits(w);
              const free = w.station_id == null;
              return (
                <tr key={w.no} className={(fitting ? "row-active " : "") + "row-interactive"}
                    onClick={() => onFiles(w.no)}
                    title="Dateien im Seitenrahmen rechts öffnen">
                  <td className="mono"><b>{w.no}</b></td>
                  <td>{w.mat_name || w.mat} <span className="sub">{w.thk} mm</span></td>
                  <td className="num">{w.n_plates}</td>
                  <td className="num">{w.n_parts}</td>
                  <td>
                    {w.station_id != null && stationLabels[w.station_id]
                      ? stationLabels[w.station_id]
                      : <span className="sub">frei</span>}
                    {fitting && <Tag minimal intent="primary" style={{ marginLeft: 4 }}>passt</Tag>}
                  </td>
                  <td className="sub">{w.release_reason || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                    <Tooltip content="Laufkarte drucken">
                      <Button aria-label="Laufkarte drucken" small minimal icon="print" onClick={() => onTraveller(w.no)} />
                    </Tooltip>
                    <Tooltip content="Dateien im Seitenrahmen">
                      <Button aria-label="Dateien im Seitenrahmen" small minimal icon="document" onClick={() => onFiles(w.no)} />
                    </Tooltip>
                    {onWhy && <Button small minimal icon="chart" title="Wo wäre er besser aufgehoben?"
                      onClick={() => onWhy(w.no)} />}
                    {!onAssign ? null : free
                      ? <Button small intent="primary" icon="add" text="Ziehen"
                          onClick={() => onAssign(w.no, stationId, `von Hand an ${stationLabel} gezogen`)} />
                      : <Button small minimal icon="lock" title="Ist einer anderen Station zugeordnet" disabled />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </HTMLTable>
      )}
      {visiblePool.length > 30 && (
        <p className="sub">… und {visiblePool.length - 30} weitere — vollständige Liste im Produktionsmodul.</p>
      )}
      {unassigned.length === 0 && allOpen.length > 0 && (
        <p className="sub">Nichts davon ist gerade frei und passt zur Eingrenzung dieser Station.</p>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Bereitstellung — die Lagersicht. Nicht „welche Aufträge gibt es", sondern
   „welche Platten hole ich jetzt aus dem Regal", zusammengefasst nach
   Werkstoff und Dicke, denn genau so wird gegriffen.
   -------------------------------------------------------------------------- */
function PickList({ rows, materials }: {
  rows: { mat: string; name: string; thk: number; plates: number; jobs: string[] }[];
  materials: MaterialRow[];
}) {
  const stockOf = (id: string) => materials.find((m) => m.id === id)?.stock;
  if (!rows.length) {
    return (
      <div className="station-panel">
        <NonIdealState icon="box" title="Nichts bereitzustellen"
          description="Sobald der Sammellauf Innenaufträge anlegt, steht hier, was aus dem Regal muss." />
      </div>
    );
  }
  return (
    <div className="station-panel">
      <p className="sub">
        Zusammengefasst nach Werkstoff und Dicke — so, wie im Regal gegriffen wird, nicht
        nach Auftrag. Der Bestand daneben ist der geführte Lagerstand; weicht er ab, ist
        das ein Fund für die Inventur.
      </p>
      <HTMLTable compact className="data-table" striped>
        <thead>
          <tr><th>Werkstoff</th><th className="num">Dicke</th><th className="num">Platten</th>
              <th className="num">Bestand</th><th>Für Innenaufträge</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const stock = stockOf(r.mat);
            const tight = stock != null && stock < r.plates;
            return (
              <tr key={`${r.mat}-${r.thk}`} className={tight ? "row-dirty" : undefined}>
                <td>{r.name}<div className="sub mono">{r.mat}</div></td>
                <td className="num">{r.thk.toLocaleString("de-DE")} mm</td>
                <td className="num"><b>{r.plates}</b></td>
                <td className="num">
                  {stock == null ? <span className="sub">—</span>
                    : <Tag minimal intent={tight ? "danger" : stockHealth(stock).intent}>{stock}</Tag>}
                </td>
                <td className="sub mono">{r.jobs.join(", ")}</td>
              </tr>
            );
          })}
        </tbody>
      </HTMLTable>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Plattenzeichnung direkt am Arbeitsplatz — die SVG holt sich dieses Bauteil
   selbst mit dem Authorization-Kopf und legt sie in die Seite. Kein
   Fensterwechsel, kein zweites Programm: sehen, drehen, verstehen, dann die
   DXF an die Maschine geben. */
function PlatePreview({ wo, idx, fmt, nPlates, onPick }: {
  wo: string; idx: number; fmt: number[]; nPlates: number; onPick: (i: number) => void;
}) {
  const [svg, setSvg] = useState<string>("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr("");
    fetch(`/api/production/work-orders/${wo}/plate/${idx}.svg`, {
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    })
      .then((r) => { if (!r.ok) throw new Error(`Fehler ${r.status}`); return r.text(); })
      .then((text) => { if (alive) { setSvg(text); setLoading(false); } })
      .catch((e) => { if (alive) { setErr(e.message ?? String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [wo, idx]);

  return (
    <div className="plate-preview">
      <div className="plate-preview-bar">
        <span className="sub">
          Platte {idx + 1} von {nPlates}
          {fmt?.length >= 2 && <> · {(fmt ?? []).map((v) => Math.round(v)).join(" × ")} mm</>}
        </span>
        {nPlates > 1 && (
          <ButtonGroup minimal>
            {Array.from({ length: nPlates }, (_, i) => (
              <Button key={i} small active={i === idx} text={`${i + 1}`} onClick={() => onPick(i)} />
            ))}
          </ButtonGroup>
        )}
      </div>
      <div className="plate-preview-stage">
        {loading && <Spinner size={24} />}
        {!loading && err && <span className="sub" style={{ color: "var(--g-danger-ink)" }}>{err}</span>}
        {!loading && !err && svg && (
          <div className="plate-preview-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
function StationInfo({ station, supply, queueMin, queueJobs, autoRouting }: {
  station: Station; supply: SupplyRow[]; queueMin: number; queueJobs: number;
  autoRouting: boolean;
}) {
  const s = station;
  const isProd = s.type === "production";
  return (
    <div className="station-panel station-info">
      <Card>
        <h2 className="card-title">Betrieb</h2>
        <dl className="kv">
          <dt>Routing</dt><dd>{ROUTING_LABEL[s.routing as StationRouting]}</dd>
          <dt>Automatik im Haus</dt><dd>{autoRouting ? "an" : "aus"}</dd>
          <dt>In der Schlange</dt><dd>{plural(queueJobs, "Innenauftrag", "Innenaufträge")} · {fmtMin(queueMin)}</dd>
          <dt>Zuletzt eingeplant</dt>
          <dd>{s.last_mat ? <><MatName id={s.last_mat} />{s.last_thk ? ` · ${s.last_thk.toLocaleString("de-DE")} mm` : ""}</> : "nichts"}</dd>
          <dt>Stellfläche</dt><dd>{s.w} × {s.h} m bei ({s.x} | {s.y}), {s.rotation}°</dd>
        </dl>
        {s.note && <Callout compact icon="comment" style={{ marginTop: 8 }}>{s.note}</Callout>}
      </Card>

      {isProd && (
        <Card>
          <h2 className="card-title">Maschinenwerte</h2>
          <dl className="kv">
            <dt>Art</dt><dd>{MACHINE_LABEL[s.machine_kind]}</dd>
            <dt>Vorschub</dt><dd>{s.speed_mm_s ? `${s.speed_mm_s} mm/s` : <span className="sub">unbekannt</span>}</dd>
            <dt>Anstechen</dt><dd>{s.pierce_s ? `${s.pierce_s} s/Teil` : <span className="sub">—</span>}</dd>
            <dt>Rüsten</dt><dd>{s.setup_min ? `${s.setup_min} min` : <span className="sub">unbekannt</span>}</dd>
            <dt>Umrüsten</dt><dd>{s.changeover_min ? `+${s.changeover_min} min bei Wechsel` : <span className="sub">—</span>}</dd>
            <dt>Tisch</dt>
            <dd>{s.max_sheet_w && s.max_sheet_h ? `${s.max_sheet_w} × ${s.max_sheet_h} mm` : <span className="sub">unbekannt</span>}</dd>
            <dt>Dicken</dt>
            <dd>{s.thk_min || s.thk_max ? `${s.thk_min || 0} – ${s.thk_max || "∞"} mm` : <span className="sub">keine Grenze</span>}</dd>
            <dt>Kapazität</dt>
            <dd>{s.capacity_min_per_day ? fmtMin(s.capacity_min_per_day) + " / Tag" : <span className="sub">unbekannt</span>}</dd>
            <dt>Stundensatz</dt>
            <dd>{s.cost_per_h ? fmtEur(s.cost_per_h) + " / h" : <span className="sub">—</span>}</dd>
          </dl>
          <p className="sub">
            Ein leerer Wert heißt <b>unbekannt</b>, nicht null: der betroffene Faktor der
            Zuordnung bleibt dann stumm, statt mit einer erfundenen Zahl zu rechnen.
          </p>
        </Card>
      )}

      <Card>
        <h2 className="card-title">Wege</h2>
        {supply.length === 0 ? (
          <p className="sub">Kein Lager erfasst — es gibt nichts zu messen.</p>
        ) : (
          <HTMLTable compact className="data-table">
            <thead><tr><th>Von</th><th className="num">Strecke</th><th className="num">Zeit</th><th>Art</th></tr></thead>
            <tbody>
              {supply.map((sup) => (
                <tr key={sup.id}>
                  <td>{sup.label}</td>
                  <td className="num mono">{fmtM(sup.metres)}</td>
                  <td className="num mono">{Math.round(sup.minutes)} min</td>
                  <td><Tag minimal intent={sup.exact ? "success" : "warning"}>{sup.note}</Tag></td>
                </tr>
              ))}
            </tbody>
          </HTMLTable>
        )}
      </Card>
    </div>
  );
}

/* Miniatur des Grundrisses — wo stehe ich? Die eigene Station ist markiert,
   die Lager sind eingefärbt, und der kürzeste Materialweg ist eingezeichnet. */
function MiniMap({ floor, stations, hereId, label, supply }: {
  floor: Floor | null; stations: Station[]; hereId: number | null; label: string;
  supply: SupplyRow[];
}) {
  if (!floor || !floor.outline.length || !stations.length) return null;
  const b = sceneBounds(floor, stations);
  const pad = 6;
  const W = 320, H = 200;
  const k = Math.min((W - 2 * pad) / b.w, (H - 2 * pad) / b.h);
  const ox = pad + ((W - 2 * pad) - b.w * k) / 2;
  const oy = pad + ((H - 2 * pad) - b.h * k) / 2;
  const px = (x: number) => ox + (x - b.x) * k;
  const py = (y: number) => oy + (y - b.y) * k;
  const here = stations.find((s) => s.id === hereId);
  const from = supply.length ? stations.find((s) => s.id === supply[0].id) : null;

  return (
    <div className="minimap-card" title="Lage im Grundriss — Klick auf eine Station wechselt dorthin, Klick auf die Fläche öffnet den Grundriss">
      <h2>Lage im Grundriss</h2>
      <svg className="minimap-svg" viewBox={`0 0 ${W} ${H}`}
           onClick={() => navigate("grundriss")} role="img"
           aria-label={`Grundriss-Miniatur, Station ${label}`}>
        <polygon points={floor.outline.map((p) => `${px(p[0])},${py(p[1])}`).join(" ")}
          fill="var(--g-surface-2)" stroke="var(--g-rule-strong)" strokeWidth={1} />
        {(floor.aisles?.edges ?? []).map(([i, j], n) => {
          const a = floor.aisles.nodes[i], c = floor.aisles.nodes[j];
          if (!a || !c) return null;
          return <line key={n} x1={px(a[0])} y1={py(a[1])} x2={px(c[0])} y2={py(c[1])}
            stroke="var(--g-floor-grid-major)" strokeWidth={2} strokeDasharray="3 2" />;
        })}
        {from && here && (
          <line x1={px(from.x)} y1={py(from.y)} x2={px(here.x)} y2={py(here.y)}
            stroke="#8e5cb8" strokeWidth={1.4} strokeDasharray="4 3" />
        )}
        {stations.map((st) => {
          const isHere = st.id != null && st.id === hereId;
          const col = stationColour(st);
          const clickable = st.id != null && !isHere;
          return (
            <rect key={st.id ?? st.label}
              x={px(st.x - st.w / 2)} y={py(st.y - st.h / 2)}
              width={Math.max(3, st.w * k)} height={Math.max(3, st.h * k)}
              transform={`rotate(${st.rotation} ${px(st.x)} ${py(st.y)})`}
              fill={col} opacity={isHere ? 1 : st.is_storage ? 0.65 : 0.34}
              stroke={isHere ? "var(--g-text-strong)" : st.is_storage ? "#8e5cb8" : "none"}
              strokeWidth={isHere ? 1.6 : st.is_storage ? 1 : 0} rx={1.5}
              style={{ cursor: clickable ? "pointer" : "default" }}
              onClick={clickable ? (e) => { e.stopPropagation(); navigate(`station/${st.id}`); } : undefined}>
              <title>
                {st.label}
                {isHere ? " — Sie sind hier" : st.is_storage ? " (Lager) — Arbeitsplatz öffnen" : " — Arbeitsplatz öffnen"}
              </title>
            </rect>
          );
        })}
        <text x={W - 6} y={H - 6} textAnchor="end" fontSize={9.5} fill="var(--g-muted)">
          Station wählen oder Grundriss →
        </text>
      </svg>
    </div>
  );
}

/* Eine Auftragszeile — auf Klick klappt die vollständige Positionenliste auf.
   Der Stand steht als Leiste daneben, nicht als Zahl: „Stufe 3" beantwortet
   die Frage nicht, die jemand tatsächlich hat. Jetzt mit Dateien-Knopf:
   trägt dieser Auftrag Teile auf einer Platte dieser Station, öffnet der
   Knopf die Schnittdateien im rechten Seitenrahmen — ohne den Reiter zu
   wechseln. */
function OrderRowView({ o, muted, busy, open, files, onFiles, onTraveller, onToggle, onComplete, canComplete, onHandler }: {
  o: OrderRow; muted: boolean; busy: boolean; open: boolean; canComplete: boolean;
  files?: string[]; onFiles?: (woNo: string) => void; onTraveller?: (woNo: string) => void;
  onToggle: () => void; onComplete: () => void; onHandler?: () => void;
}) {
  const shown = open ? o.positions : o.positions.slice(0, 2);
  const rest = o.positions.length - shown.length;
  const overdue = o.due_date && new Date(o.due_date).getTime() < Date.now();
  return (
    <>
      <tr className={muted ? "row-muted" : undefined} onClick={onToggle} style={{ cursor: "pointer" }}>
        <td>
          <span className="mono order-no" onClick={(e) => e.stopPropagation()}>
            <RefLink kind="order" no={o.no} />
          </span>
          <div className="row-tags">
            {o.rush && <Tag minimal intent="danger">Eil</Tag>}
            {o.blocked && <Tag minimal intent="danger">gesperrt</Tag>}
            {!o.released && <Tag minimal intent="warning">nicht freigegeben</Tag>}
            {o.relevant && !muted && <Tag minimal intent="success">passt</Tag>}
          </div>
          {o.customer_ref && <div className="sub">{o.customer_ref}</div>}
        </td>
        <td style={{ minWidth: 170 }}>
          <OrderProgress progress={o.progress} compact />
          {o.due_date && (
            <div className={"sub" + (overdue ? " sub-danger" : "")}>
              fällig {fmtDate(o.due_date)}
            </div>
          )}
        </td>
        <td>
          <div className="pos-list">
            {shown.map((p, i) => (
              <span key={i} className="pos-item">
                {p.label || p.mat || "Sonderfertigung"}
                {p.mat && <span className="sub"> {p.mat}</span>}
                {p.thk > 0 && <span className="sub"> · {p.thk.toLocaleString("de-DE")} mm</span>}
                <b> × {p.qty}</b>
              </span>
            ))}
            {rest > 0 && <span className="sub">+{rest} weitere Positionen …</span>}
          </div>
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          {o.handler
            ? <Tooltip content={o.handler_reason || "von Hand gesetzt"}>
                <Tag minimal interactive={!!onHandler} icon="person" onClick={onHandler}>{o.handler}</Tag>
              </Tooltip>
            : onHandler ? <Button small minimal icon="new-person" text="zuordnen" onClick={onHandler} />
            : <span className="sub">—</span>}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <div className="row-actions">
            {files && files.length > 0 && onTraveller && (
              <Tooltip content={`Laufkarte ${files[0]} öffnen`}>
                <Button small minimal icon="print"
                        aria-label={`Laufkarte ${files[0]} öffnen`}
                        onClick={() => onTraveller(files[0])} />
              </Tooltip>
            )}
            {files && files.length > 0 && (
              <Tooltip content={files.length === 1
                ? `Schnittdateien ${files[0]} im Seitenrahmen öffnen`
                : `${plural(files.length, "Innenauftrag", "Innenaufträge")} mit Teilen dieses Auftrags — ersten öffnen (${files.join(", ")})`}>
                <Button small minimal icon="document"
                        title={files.join(", ")}
                        onClick={() => onFiles?.(files[0])} />
              </Tooltip>
            )}
            {files && files.length > 1 && (
              <Tooltip content={files.slice(1).join(", ")}>
                <Tag minimal>+{files.length - 1}</Tag>
              </Tooltip>
            )}
            <Tooltip content={canComplete
              ? "Fertigung an dieser Station abschließen — Innenaufträge dieses Auftrags gehen auf fertig."
              : "Kein offener Innenauftrag dieses Auftrags an dieser Station. Erst in der Warteschlange zuordnen."}>
              <Button small intent="success" icon="tick" text="Fertig" loading={busy}
                disabled={!canComplete} onClick={onComplete} />
            </Tooltip>
          </div>
        </td>
      </tr>
      {open && (
        <tr className={muted ? "row-muted" : undefined}>
          <td colSpan={5} className="row-detail">
            <OrderProgress progress={o.progress} />
            {files && files.length > 0 && (
              <div style={{ margin: "8px 0 10px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className="sub">Innenaufträge:</span>
                {files.map((wo) => (
                  <span key={wo} style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
                    <Button small minimal icon="document" text={wo}
                            className="mono" onClick={() => onFiles?.(wo)} />
                    {onTraveller && (
                      <Button small minimal icon="print" title={`Laufkarte ${wo}`}
                              onClick={() => onTraveller(wo)} />
                    )}
                  </span>
                ))}
                <span className="sub">Dateien rechts oder Laufkarte öffnen</span>
              </div>
            )}
            <div className="pos-grid">
              {o.positions.map((p, i) => (
                <div key={i} className="pos-card">
                  <b>{p.label || "Sonderfertigung"}</b>
                  <div className="sub">
                    {p.mat || "—"}{p.thk > 0 ? ` · ${p.thk.toLocaleString("de-DE")} mm` : ""} · {p.qty} Stk.
                  </div>
                  {(p.od > 0 || p.di > 0) && (
                    <div className="sub mono">
                      ⌀ {p.od.toLocaleString("de-DE", { maximumFractionDigits: 1 })}
                      {p.di > 0 && ` / ${p.di.toLocaleString("de-DE", { maximumFractionDigits: 1 })}`} mm
                    </div>
                  )}
                  {p.production_status && (
                    <Tag minimal intent={posTag(p.production_status).intent}>
                      {posTag(p.production_status).label}
                    </Tag>
                  )}
                </div>
              ))}
              {!o.positions.length && <span className="sub">Keine Positionen erfasst.</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
