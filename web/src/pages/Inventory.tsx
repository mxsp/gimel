import { Button, ButtonGroup, Checkbox, FormGroup, HTMLSelect, HTMLTable, InputGroup, Spinner, Tab, Tabs, Tag } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import { materialGroupLabel } from "../constants";
import { RefLink } from "../components/RefLink";
import NonIdealState from "../components/NonIdealState";
import Callout from "../components/Callout";
import { SectionError } from "../components/PageStates";
import NewProductDialog from "../components/NewProductDialog";
import StockTimeline from "../components/StockTimeline";
import { LocationsPanel, OffcutsPanel } from "../components/LagerPanels";
import { LotsPanel, PurchaseOrdersPanel, SmartMrpPanel } from "../components/ScmPanels";
import { LocationChips, StockLocationDialog } from "../components/StockLocations";
import type { StockLocationRow } from "../factory";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDateTime } from "../api";
import { toastError, toastSuccess } from "../toast";
import { plural } from "../plural";
import {
  FilterGroup, FilterPopover, FilterTag, HintDetails, PageFrame, SortControl, Toolbar, ViewMenu,
  sortRows, useHiddenColumns, useSortPref,
} from "../ui";
import type { SortField, ViewColumn } from "../ui";

// Lagerlogistik — Plattenbestand je Werkstoff mit Verlauf. Bestandszeilen
// kommen aus /api/inventory (wenn vorhanden) bzw. /api/integration/stock.
interface StockRow {
  id: string;
  name: string;
  short: string;
  cat: string;
  stock: number;
  lead_days: number;
  sheets: number[][];
  active: boolean;
  last_movement_at?: string | null;
  /** Verfügbare Reststücke (alle Dicken). */
  offcuts?: number;
}

interface Movement {
  id: number;
  product_id: string;
  delta: number;
  balance_after: number;
  reason: string;
  note: string;
  work_order_no: string;
  actor: string;
  created_at: string;
}

const STOCK_COLUMNS: ViewColumn[] = [
  { id: "group", label: "Gruppe" },
  { id: "where", label: "Lagerort" },
  { id: "offcuts", label: "Reste" },
  { id: "lead", label: "Lieferzeit" },
  { id: "last", label: "Letzte Buchung" },
  { id: "sheets", label: "Formate" },
];
const STOCK_SORT_FIELDS: SortField[] = [
  { id: "name", label: "Werkstoff" },
  { id: "cat", label: "Gruppe" },
  { id: "stock", label: "Bestand" },
  { id: "lead_days", label: "Lieferzeit" },
  { id: "last_movement_at", label: "Letzte Buchung" },
];
const MOVEMENT_FILTERS: Array<[string, string]> = [
  ["alle", "alle Buchungen"],
  ["30", "Buchung in 30 Tagen"],
  ["90", "Buchung in 90 Tagen"],
  ["nie", "nie gebucht"],
];
const DAY_MS = 86_400_000;

function StockPanel() {
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [adjust, setAdjust] = useState("0");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const view = useHiddenColumns("gimel-inventory-columns");
  /* Was sich zuletzt geändert hat — damit der Seitenrahmen die Buchung nicht
     nur einarbeitet, sondern auch zeigt: von welchem Bestand auf welchen. */
  const [lastChange, setLastChange] = useState<{ id: string; from: number; to: number } | null>(null);
  const [q, setQ] = useState("");
  const [inactive, setInactive] = useState(false);
  const [movement, setMovement] = useState("alle");
  const { sort, setSort } = useSortPref("gimel-inventory-sort", STOCK_SORT_FIELDS);
  const [creating, setCreating] = useState(false);
  const [locs, setLocs] = useState<Record<string, StockLocationRow[]>>({});
  const [locEdit, setLocEdit] = useState(false);
  const [tick, setTick] = useState(0);

  /* Der Lagerbestand kommt aus /api/inventory: dieselbe Zeile wie im Katalog,
     aber mit dem Datum der letzten Buchung. Der alte Umweg über
     /api/integration/stock lieferte SAP-Abweichungen statt Lagerzeilen und
     fiel deshalb immer auf /api/products zurück. */
  const fetchRows = useCallback(async (): Promise<StockRow[]> => {
    try {
      return await api<StockRow[]>(`/api/inventory?include_inactive=${inactive}`);
    } catch {
      return await api<StockRow[]>(`/api/products?include_inactive=${inactive}`);
    }
  }, [inactive]);

  const loadLocs = useCallback(async () => {
    try {
      const d = await api<{ locations: Record<string, StockLocationRow[]> }>("/api/factory/stock-locations");
      setLocs(d.locations);
    } catch { /* ohne Orte bleibt die Spalte leer */ }
  }, []);

  const load = useCallback(async () => {
    try {
      setRows(await fetchRows());
      setLoadError("");
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setLoadError(msg);
      toastError(msg);
    }
    void loadLocs();
  }, [fetchRows, loadLocs]);

  useEffect(() => { load(); }, [load]);

  const loadMovements = useCallback(async () => {
    if (!selected) return;
    const id = selected;
    try {
      const rows = await api<Movement[]>(`/api/inventory/${id}/movements`);
      if (selectedRef.current === id) setMovements(rows);
    } catch {
      if (selectedRef.current === id) setMovements([]);
    }
  }, [selected]);

  const select = (id: string) => {
    setSelected(id);
    setAdjust("0");
    setNote("");
    setMovements(null);
    setBookOpen(false);
  };

  /* Buchen. Der Seitenrahmen wird danach aus derselben Antwort gespeist, die
     das Backend zurückgibt — nicht aus einer Schätzung im Browser: sonst zeigt
     die Karte einen Bestand, den das Lager nie hatte. */
  const book = async (delta: number, reason: string) => {
    if (!selected || !delta) return;
    const before = current?.stock ?? 0;
    setBusy(true);
    try {
      await api(`/api/inventory/${selected}/adjust`, {
        method: "POST",
        // Wareneingang bucht als „einkauf“, alles andere als Korrektur — sonst stand
        // jeder Zugang im Bewegungsprotokoll als Korrektur.
        body: JSON.stringify({ delta, reason: delta > 0 && /wareneingang|einkauf/i.test(reason) ? "einkauf" : "korrektur", note: reason }),
      });
      const fresh = await fetchRows();
      setRows(fresh);
      if (movements !== null) {
        const moves = await api<Movement[]>(`/api/inventory/${selected}/movements`).catch(() => [] as Movement[]);
        setMovements(moves);
      }
      const after = (fresh as any[]).find((r) => r.id === selected)?.stock ?? before + delta;
      setLastChange({ id: selected, from: before, to: after });
      setTick((t) => t + 1);
      setAdjust("0");
      setNote("");
      toastSuccess(`${selected}: ${before} → ${plural(after, "Platte", "Platten")}.`);
    } catch (e: any) {
      toastError(e.message);
    } finally { setBusy(false); }
  };

  const all = rows ?? [];
  const needle = q.trim().toLowerCase();
  const shown = sortRows(all.filter((r) => {
    if (needle && !`${r.id} ${r.name} ${r.short} ${r.cat}`.toLowerCase().includes(needle)) return false;
    if (movement === "alle") return true;
    if (movement === "nie") return !r.last_movement_at;
    const at = r.last_movement_at ? new Date(r.last_movement_at).getTime() : NaN;
    return Number.isFinite(at) && Date.now() - at <= Number(movement) * DAY_MS;
  }), sort, (r, field) => (r as unknown as Record<string, unknown>)[field]);
  const movementLabel = MOVEMENT_FILTERS.find(([value]) => value === movement)?.[1] ?? movement;
  const current = all.find((r) => r.id === selected);
  const change = lastChange && lastChange.id === selected ? lastChange : null;
  const show = (id: string) => !view.hidden.includes(id);

  return (
    <div className="split-view">
      <div className="split-main">
        <Toolbar
          meta={`${shown.length} von ${all.length}`}
          end={
            <>
              <FilterPopover active={(inactive ? 1 : 0) + (movement !== "alle" ? 1 : 0)}
                             onClear={() => { setInactive(false); setMovement("alle"); }}>
                <FilterGroup label="Bestand">
                  <Checkbox checked={inactive} label="stillgelegte zeigen" style={{ margin: 0 }}
                            onChange={(e) => setInactive(e.currentTarget.checked)} />
                </FilterGroup>
                <FilterGroup label="Letzte Buchung">
                  <HTMLSelect value={movement} aria-label="Nach letzter Buchung filtern"
                              onChange={(e) => setMovement(e.currentTarget.value)}>
                    {MOVEMENT_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </HTMLSelect>
                </FilterGroup>
              </FilterPopover>
              <SortControl state={sort} fields={STOCK_SORT_FIELDS} onChange={setSort} />
              <ViewMenu columns={STOCK_COLUMNS} hidden={view.hidden}
                        onToggle={view.toggle} onReset={view.reset} />
              <Button intent="primary" icon="add" text="Neuer Werkstoff"
                      onClick={() => setCreating(true)} />
              <Button minimal icon="refresh" title="Neu lesen" aria-label="Neu lesen" onClick={load} />
            </>
          }
        >
          <InputGroup leftIcon="search" placeholder="Werkstoff suchen…" value={q}
                      onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
          {movement !== "alle" && <FilterTag label={movementLabel} onRemove={() => setMovement("alle")} />}
          {inactive && <FilterTag label="stillgelegte zeigen" onRemove={() => setInactive(false)} />}
        </Toolbar>

        {loadError && !rows ? <SectionError message={loadError} onRetry={load} /> : !rows ? <Spinner size={30} /> : shown.length === 0 ? (
          all.length === 0
            ? <NonIdealState icon="box" title="Noch keine Werkstoffe"
                             description="Ein Werkstoff ist die Lagerposition: Platten, Formate und Preis werden daran geführt."
                             action={<Button intent="primary" icon="add" text="Ersten Werkstoff anlegen"
                                              onClick={() => setCreating(true)} />} />
            : <NonIdealState icon="search" title="Kein Treffer"
                             description="Suche oder Filter ändern — oder einen neuen Werkstoff anlegen." />
        ) : (
          <HTMLTable className="data-table" striped compact interactive tabIndex={0} aria-label="Lagerbestand">
            <thead>
              <tr>
                <th>Werkstoff</th>
                {show("group") && <th>Gruppe</th>}
                <th className="num">Bestand (Platten)</th>
                {show("where") && <th>Lagerort</th>}
                {show("offcuts") && <th className="num">Reste</th>}
                {show("lead") && <th className="num">Lieferzeit</th>}
                {show("last") && <th>Letzte Buchung</th>}
                {show("sheets") && <th>Formate</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onClick={() => select(r.id)}
                    className={[selected === r.id ? "row-active" : "", r.active ? "" : "row-muted"]
                      .filter(Boolean).join(" ") || undefined}>
                  <td>
                    <b>{r.name || r.id}</b> <span className="sub">{r.short}</span>
                    {!r.active && <Tag minimal intent="warning" style={{ marginLeft: 6 }}>stillgelegt</Tag>}
                  </td>
                  {show("group") && <td>{r.cat ? <Tag minimal title={r.cat}>{materialGroupLabel(r.cat)}</Tag> : null}</td>}
                  <td className="num">
                    <b style={{ color: (r.stock ?? 0) > 0 ? undefined : "var(--g-danger-ink)" }}>{r.stock ?? 0}</b>
                    {lastChange && lastChange.id === r.id && (
                      <Tag minimal intent={lastChange.to >= lastChange.from ? "success" : "danger"}
                           style={{ marginLeft: 6 }}>
                        {lastChange.to - lastChange.from > 0 ? "+" : ""}{lastChange.to - lastChange.from}
                      </Tag>
                    )}
                  </td>
                  {show("where") && <td><LocationChips locations={locs[r.id]} compact /></td>}
                  {show("offcuts") && (
                    <td className="num">
                      {r.offcuts ? <span className="offcut-ink" title="verfügbare Reststücke">{r.offcuts}</span> : <span className="sub">—</span>}
                    </td>
                  )}
                  {show("lead") && <td className="num">{plural(r.lead_days, "Tag", "Tage")}</td>}
                  {show("last") && <td className="sub">{r.last_movement_at ? fmtDateTime(r.last_movement_at) : "—"}</td>}
                  {show("sheets") && (
                    <td className="mono">
                      {(r.sheets ?? []).map((sh: number[]) => `${sh[0]}×${sh[1]}`).join(", ") || "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </HTMLTable>
        )}
        {!current && shown.length > 0 && (
          <p className="sub" style={{ marginTop: 8 }}>
            Eine Zeile anklicken — Bestand, Buchung und Verlauf erscheinen rechts.
          </p>
        )}
      </div>

      {/* Seitenrahmen — die gewählte Position bleibt beim Blättern stehen, und
          jede Buchung schlägt sich hier sofort nieder. */}
      {current && (
        <aside className="side-frame">
          <div className="side-head">
            <div className="side-kicker">Lagerposition</div>
            <h2>{current.name || current.id}</h2>
            <div className="mono sub">{current.id}</div>
          </div>

          <div className="side-body">
            <div className={`stock-figure${change ? " stock-figure-changed" : ""}`}>
              <div className="stock-value">{current.stock ?? 0}</div>
              <div className="stock-unit">Platten am Lager</div>
              {change && (
                <div className="stock-delta">
                  {change.from} → <b>{change.to}</b>{" "}
                  <Tag minimal intent={change.to >= change.from ? "success" : "danger"}>
                    {change.to - change.from > 0 ? "+" : ""}{change.to - change.from}
                  </Tag>
                </div>
              )}
            </div>

            <div className="side-kv">
              <span>Gruppe</span><b>{materialGroupLabel(current.cat)}</b>
              <span>Status</span><b>{current.active ? "aktiv" : "stillgelegt"}</b>
              <span>Lieferzeit</span><b>{plural(current.lead_days, "Tag", "Tage")}</b>
              <span>Letzte Buchung</span>
              <b className="sub">{current.last_movement_at ? fmtDateTime(current.last_movement_at) : "—"}</b>
              <span>Formate</span>
              <b className="mono">
                {(current.sheets ?? []).map((sh: number[]) => `${sh[0]}×${sh[1]}`).join(", ") || "—"}
              </b>
            </div>

            <div className="side-section">
              <div className="side-section-head">
                <h3>Wo es liegt</h3>
                <Button small minimal icon="edit" text="Orte pflegen" onClick={() => setLocEdit(true)} />
              </div>
              <LocationChips locations={locs[current.id]} />
              {(() => {
                const placed = (locs[current.id] ?? []).reduce((a, l) => a + l.qty, 0);
                const diff = (current.stock ?? 0) - placed;
                return (locs[current.id]?.length ?? 0) > 0 && diff !== 0 ? (
                  <p className="sub" style={{ margin: "4px 0 0" }}>
                    {diff > 0 ? `${diff} Pl. keinem Fach zugeordnet` : `${-diff} Pl. mehr verortet als gebucht`}
                  </p>
                ) : null;
              })()}
            </div>

            <StockTimeline mat={current.id} refreshKey={tick} />

            <div className="side-section">
              <h3>Reststücke</h3>
              <OffcutsPanel compact mat={current.id} products={all} key={`${current.id}-${tick}`} />
            </div>

            <h3>Bestand buchen</h3>
            <KeyPopover
              placement="bottom-start"
              isOpen={bookOpen}
              onInteraction={(next) => setBookOpen(next)}
              content={
                <div className="ui-filter-panel" style={{ minWidth: 270 }}>
                  <FilterGroup label="Schnellbuchen">
                    <ButtonGroup fill>
                      {[-10, -1, +1, +10].map((d) => (
                        <Button key={d} small disabled={busy}
                                aria-label={d > 0 ? `${d} Platten Wareneingang buchen` : `${-d} Platten Korrektur buchen`}
                                title={d > 0 ? `+${d} Wareneingang` : `${d} Korrektur`}
                                onClick={() => book(d, d > 0 ? "Wareneingang" : "Korrektur")}>
                          {d > 0 ? `+${d}` : d}
                        </Button>
                      ))}
                    </ButtonGroup>
                  </FilterGroup>
                  <FormGroup label="Änderung (+ Wareneingang / − Korrektur)">
                    <InputGroup aria-label="Änderung (+ Wareneingang / − Korrektur)" type="number" value={adjust}
                                onChange={(e) => setAdjust(e.target.value)} />
                  </FormGroup>
                  <FormGroup label="Grund">
                    <InputGroup aria-label="Grund" value={note} placeholder="z. B. Lieferung 4711"
                                onChange={(e) => setNote(e.target.value)} />
                  </FormGroup>
                  <div className="ui-filter-actions">
                    <Button intent="primary" icon="tick" loading={busy}
                            disabled={!Number(adjust)}
                            onClick={() => book(Number(adjust), note)}>Buchen</Button>
                  </div>
                </div>
              }
            >
              <Button intent="primary" icon="add" text="Buchen" rightIcon="caret-down" />
            </KeyPopover>

            <div key={selected} onClick={(e) => {
              if ((e.target as HTMLElement).closest("summary") && movements === null) void loadMovements();
            }}>
              <HintDetails title={`Buchungen${movements?.length ? ` (${movements.length})` : ""}`}>
                {!movements ? <Spinner size={20} /> : movements.length === 0 ? (
                  <p className="sub">Keine Bewegungen aufgezeichnet.</p>
                ) : (
                  <ul className="move-list">
                    {movements.map((m) => (
                      <li key={m.id}>
                        <span className={`move-delta ${m.delta > 0 ? "up" : "down"}`}>
                          {m.delta > 0 ? `+${m.delta}` : m.delta}
                        </span>
                        <span className="move-body">
                          <b>{m.balance_after}</b> danach · <Tag minimal>{m.reason}</Tag>
                          <div className="sub">
                            {fmtDateTime(m.created_at)}
                            {m.actor ? ` · ${m.actor}` : ""}
                            {m.work_order_no && <> · <RefLink kind="work_order" no={m.work_order_no} /></>}
                          </div>
                          {m.note && <div className="sub">{m.note}</div>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </HintDetails>
            </div>
          </div>
        </aside>
      )}

      {locEdit && current && (
        <StockLocationDialog mat={current.id} matName={current.name || current.id} stock={current.stock ?? 0}
                             onClose={(changed) => { setLocEdit(false); if (changed) void loadLocs(); }} />
      )}
      {creating && <NewProductDialog isOpen onClose={async (createdId) => {
        setCreating(false);
        if (!createdId) return;
        await load();
        select(createdId);
      }} />}
    </div>
  );
}

/* ERP-Abgleich — aus der alten Verwaltungs-Subapp übernommen.

   Der Adapter ist im Prototyp ein Mock; die Naht ist es nicht. „Abgleich" holt
   die Bestände aus dem führenden System und schreibt sie auf die Werkstoffe —
   deshalb steht die Abweichung vorher als Liste da und nicht erst hinterher im
   Lagerprotokoll. */
interface ErpHealth { mode: string; configured?: boolean; reachable: boolean; latency_ms?: number; note?: string; }
interface ErpStock { items: Array<{ mat: string; erp: number; alpha: number; delta: number; source: string }>; }
interface ErpPlates { items: Array<{ mat: string; sheets: number[][]; lead_days: number }>; }

function ErpPanel() {
  const [health, setHealth] = useState<ErpHealth | null>(null);
  const [stock, setStock] = useState<ErpStock | null>(null);
  const [plates, setPlates] = useState<ErpPlates | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setHealth(await api<ErpHealth>("/api/integration/health"));
      setStock(await api<ErpStock>("/api/integration/stock"));
      setPlates(await api<ErpPlates>("/api/integration/plates"));
    } catch (e: any) { toastError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const sync = async () => {
    setBusy(true);
    try {
      const r = await api<Record<string, unknown>>("/api/integration/sync", {
        method: "POST", body: JSON.stringify({ actor: "erp-sync" }),
      });
      toastSuccess(`Abgleich fertig: ${JSON.stringify(r)}`);
      load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const diverging = (stock?.items ?? []).filter((i) => i.delta !== 0);

  return (
    <div>
      {health?.configured === false ? (
        <Callout icon="offline" title="Keine ERP-Anbindung eingerichtet." style={{ marginBottom: 14 }}>
          {health.note}
        </Callout>
      ) : (
        <Callout intent={health?.reachable ? "success" : "danger"}
                 icon={health?.reachable ? "link" : "offline"}
                 title={health ? `Adapter „${health.mode}" — ${health.reachable ? "erreichbar" : "nicht erreichbar"}` : "Prüfe…"}
                 style={{ marginBottom: 14 }}>
          {health?.note}
          {typeof health?.latency_ms === "number" && ` · Antwortzeit ${health.latency_ms} ms`}
          <div style={{ marginTop: 10 }}>
            <Button intent="primary" icon="refresh" text="Bestände abgleichen" loading={busy} onClick={sync} />
            <Button minimal icon="repeat" text="Neu lesen" style={{ marginLeft: 8 }} onClick={load} />
          </div>
        </Callout>
      )}

      <h2>Bestandsabweichung {diverging.length > 0 && <Tag intent="warning">{diverging.length}</Tag>}</h2>
      {!stock ? <Spinner size={26} /> : stock.items.length === 0 ? (
        <p className="sub">Das führende System meldet keine Bestände.</p>
      ) : (
        <HTMLTable className="data-table" striped compact>
          <thead>
            <tr><th>Werkstoff</th><th className="num">im ERP</th><th className="num">bei uns</th>
                <th className="num">Δ</th><th>Quelle</th></tr>
          </thead>
          <tbody>
            {stock.items.map((i) => (
              <tr key={i.mat} className={i.delta !== 0 ? "row-dirty" : undefined}>
                <td className="mono">{i.mat}</td>
                <td className="num">{i.erp}</td>
                <td className="num">{i.alpha}</td>
                <td className="num">
                  <b style={{ color: i.delta === 0 ? "var(--g-muted)" : i.delta > 0 ? "var(--g-success-ink)" : "var(--g-danger-ink)" }}>
                    {i.delta > 0 ? `+${i.delta}` : i.delta}
                  </b>
                </td>
                <td className="sub">{i.source}</td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
      )}

      <h2 style={{ marginTop: 24 }}>Plattenformate laut ERP</h2>
      {!plates ? <Spinner size={26} /> : plates.items.length === 0 ? (
        <p className="sub">Keine Formate gemeldet.</p>
      ) : (
        <HTMLTable className="data-table" striped compact>
          <thead><tr><th>Werkstoff</th><th>Formate (mm)</th><th className="num">Lieferzeit</th></tr></thead>
          <tbody>
            {plates.items.map((i) => (
              <tr key={i.mat}>
                <td className="mono">{i.mat}</td>
                <td>{i.sheets.map((sh) => `${sh[0]} × ${sh[1]}`).join(" · ") || "—"}</td>
                <td className="num">{plural(i.lead_days, "Tag", "Tage")}</td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
      )}
    </div>
  );
}

/** Werkstoffliste für die Tabs Lagerorte und Reststücke. */
function useProducts() {
  const [products, setProducts] = useState<{ id: string; name: string; stock: number }[]>([]);
  useEffect(() => {
    api<StockRow[]>("/api/inventory").then((r) => setProducts(r.map((p) => ({ id: p.id, name: p.name, stock: p.stock ?? 0 }))))
      .catch(() => {});
  }, []);
  return products;
}

function LocationsTab() { return <LocationsPanel products={useProducts()} />; }
function OffcutsTab() { return <OffcutsPanel products={useProducts()} />; }

export default function Inventory() {
  const [tab, setTab] = useState("bestand");
  return (
    <PageFrame
      title="Lager & Disposition"
      sub="Plattenbestand, Smart-Disposition (MRP & Auto-Lieferant), Einkauf & Wareneingang, Chargen (EN 10204) und Reststücke."
    >
      <Tabs id="lager" selectedTabId={tab} onChange={(t) => setTab(String(t))} large
            renderActiveTabPanelOnly>
        <Tab id="bestand" title="Bestand" panel={<StockPanel />} />
        <Tab id="mrp" title="Smart-Disposition (MRP)" panel={<SmartMrpPanel onOpenPoTab={() => setTab("einkauf")} />} />
        <Tab id="einkauf" title="Einkauf & Wareneingang" panel={<PurchaseOrdersPanel />} />
        <Tab id="chargen" title="Chargen & Zeugnisse" panel={<LotsPanel />} />
        <Tab id="orte" title="Lagerorte" panel={<LocationsTab />} />
        <Tab id="reste" title="Reststücke" panel={<OffcutsTab />} />
        <Tab id="erp" title="ERP-Abgleich (SAP)" panel={<ErpPanel />} />
      </Tabs>
    </PageFrame>
  );
}
