import { Button, Dialog, DialogBody, DialogFooter, HTMLSelect, HTMLTable, InputGroup, Menu, MenuDivider, MenuItem, Tab, Tabs, Tag } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import NonIdealState from "../components/NonIdealState";
import { navigate, useHashRoute } from "../router";
import { RefLink } from "../components/RefLink";
import Callout from "../components/Callout";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiOpenHtml, fmtDate, fmtDateTime, fmtEur } from "../api";
import { toastError, toastSuccess } from "../toast";
import { EmptyNote, SectionError, SectionLoading } from "../components/PageStates";
import { undoable } from "../undo";
import { dueBadge } from "../orderFlow";
import {
  FilterGroup, FilterPopover, FilterTag, HintDetails, InfoHint, PageFrame, PaginationBar, SortControl, Toolbar,
  ViewMenu, readStore, sortRows, useHiddenColumns, useSortPref, writeStore,
} from "../ui";
import type { SortField, ViewColumn } from "../ui";

/* Versand — Warenausgang. Übernommen aus der Subapp /versand, ergänzt um
   die beiden Dinge, die dort schon am Backend hingen und hier fehlten:
   den Inhalt eines Versands nach Auftrag aufgeschlüsselt und den
   Tracking-Abgleich mit UPS, der den Status bei Bedarf nachzieht. */

interface ReadyOrder {
  order_no: string;
  customer: string;
  n_ready: number;
  n_positions: number;
  due_date: string | null;
  rush: boolean;
  manual_shipment?: { carrier: string; tracking: string; price: number; note: string } | null;
}

interface Shipment {
  no: string;
  status: string;
  carrier: string;
  tracking: string;
  price: number;
  created_at: string | null;
  shipped_at: string | null;
  n_items: number;
  items: Array<{ order_no: string; label: string; qty: number; tag: string }>;
}

interface ShipmentOrders {
  orders: Array<{ order_no: string; items: Array<{ tag: string; label: string; mat: string;
                                                  thk: number; qty: number; work_order_no: string; note: string }> }>;
}
interface TrackResult {
  shipment: Shipment;
  ups: { ok: boolean; status?: string; error?: string; detail?: string; [k: string]: unknown };
}

const SHIP_COLUMNS: ViewColumn[] = [
  { id: "price", label: "Versandkosten" },
  { id: "created", label: "Angelegt" },
];
const SHIP_COLUMNS_KEY = "gimel-shipping-columns";
const SHIP_COLUMNS_SEEDED = "gimel-shipping-columns-seeded";
const SHIP_COLUMNS_DEFAULT_HIDDEN = ["price", "created"];
const READY_SORT_FIELDS: SortField[] = [
  { id: "order_no", label: "Auftrag" },
  { id: "customer", label: "Kunde" },
  { id: "due_date", label: "Fällig" },
  { id: "n_ready", label: "Versandfertige Teile" },
];
const SHIP_SORT_FIELDS: SortField[] = [
  { id: "no", label: "Versand" },
  { id: "status", label: "Status" },
  { id: "carrier", label: "Spedition" },
  { id: "created_at", label: "Angelegt" },
  { id: "n_items", label: "Positionen" },
];
const READY_DUE_FILTERS: Array<[string, string]> = [
  ["alle", "alle Termine"],
  ["ueberfaellig", "überfällig"],
  ["woche", "fällig in 7 Tagen"],
];
const SHIP_STATUSES: Array<[string, string]> = [
  ["alle", "alle Status"],
  ["packing", "packen"],
  ["shipped", "versendet"],
  ["delivered", "zugestellt"],
];

export default function Shipping() {
  const route = useHashRoute();
  const wantedShip = decodeURIComponent(route.split("/")[1] ?? "");
  const [ready, setReady] = useState<ReadyOrder[] | null>(null);
  const [shipments, setShipments] = useState<Shipment[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createCarrier, setCreateCarrier] = useState("");
  const [createTracking, setCreateTracking] = useState("");
  const [createNote, setCreateNote] = useState("");
  const [createPrice, setCreatePrice] = useState(0);
  const [createPrefill, setCreatePrefill] = useState<string[]>([]);
  const [detail, setDetail] = useState<{ no: string; data: ShipmentOrders } | null>(null);
  const [trackEdit, setTrackEdit] = useState<{ no: string; carrier: string; tracking: string; price: number } | null>(null);
  const [tracking, setTracking] = useState<{ no: string; res: TrackResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(() => (wantedShip ? "unterwegs" : "bereit"));
  const [readyDue, setReadyDue] = useState("alle");
  const [shipStatus, setShipStatus] = useState("alle");
  const readySort = useSortPref("gimel-shipping-ready-sort", READY_SORT_FIELDS);
  const shipSort = useSortPref("gimel-shipping-sort", SHIP_SORT_FIELDS);
  const { hidden, toggle: toggleColumn, setHidden } = useHiddenColumns(SHIP_COLUMNS_KEY);

  useEffect(() => {
    if (readStore(SHIP_COLUMNS_SEEDED) !== null) return;
    writeStore(SHIP_COLUMNS_SEEDED, "1");
    if (readStore(SHIP_COLUMNS_KEY) === null) setHidden(SHIP_COLUMNS_DEFAULT_HIDDEN);
  }, [setHidden]);

  const showColumn = (id: string) => !hidden.includes(id);

  const [loadError, setLoadError] = useState("");
  const [shipTotal, setShipTotal] = useState(0);
  const [shipOffset, setShipOffset] = useState(0);
  const [shipLimit, setShipLimit] = useState(100);
  const [shipLoading, setShipLoading] = useState(false);
  const load = useCallback(async (nextOffset = shipOffset, nextLimit = shipLimit) => {
    setShipLoading(true);
    try {
      const r = await api<{ orders: ReadyOrder[] }>("/api/shipping/ready");
      setReady(r.orders);
      const s = await api<{ shipments: Shipment[]; total?: number }>(
        `/api/shipping/?limit=${nextLimit}&offset=${nextOffset}`,
      );
      setShipments(s.shipments);
      setShipTotal(s.total ?? s.shipments.length);
      setLoadError("");
    } catch (e: any) {
      setLoadError(e.message ?? String(e));
    } finally {
      setShipLoading(false);
    }
  }, [shipOffset, shipLimit]);

  useEffect(() => { load(shipOffset, shipLimit); }, [shipOffset, shipLimit, load]);

  const openDetail = useCallback(async (no: string) => {
    try { setDetail({ no, data: await api<ShipmentOrders>(`/api/shipping/${no}/orders`) }); }
    catch (e: any) { toastError(e.message); }
  }, []);

  const openedShip = useRef("");
  useEffect(() => {
    if (!wantedShip) { openedShip.current = ""; return; }
    setTab("unterwegs");
    if (openedShip.current === wantedShip) return;
    openedShip.current = wantedShip;
    openDetail(wantedShip);
  }, [wantedShip, openDetail]);

  /* Dialog öffnen — mit Vorgabe aus dem manuellen Versand des Auftragsbüros.
     Der erste gewählte Auftrag mit handerfassten Versandangaben liefert
     Spedition, Tracking, Notiz und Preis; alles bleibt editierbar. Mehrere
     Aufträge mit Vorgabe werden genannt, damit die Übernahme sichtbar ist. */
  const openCreate = () => {
    const all = ready ?? [];
    const withMs = selected.filter((no) =>
      all.find((r) => r.order_no === no)?.manual_shipment);
    const ms = withMs.length
      ? all.find((r) => r.order_no === withMs[0])?.manual_shipment
      : null;
    setCreatePrefill(withMs);
    setCreateCarrier(ms?.carrier ?? "");
    setCreateTracking(ms?.tracking ?? "");
    setCreateNote(ms?.note ?? "");
    setCreatePrice(ms?.price ?? 0);
    setCreateOpen(true);
  };

  const createShipment = async () => {
    if (!selected.length) return;
    let created = "";
    await undoable({
      run: async () => {
        const r = await api<{ no: string }>("/api/shipping/", {
          method: "POST",
          body: JSON.stringify({ order_nos: selected, carrier: createCarrier.trim(), tracking: createTracking.trim(), note: createNote.trim(), price: createPrice }),
        });
        created = r.no;
        setSelected([]);
        setCreateOpen(false);
        setCreateCarrier(""); setCreateTracking(""); setCreateNote(""); setCreatePrice(0);
      },
      undo: () => api(`/api/shipping/${created}`, { method: "DELETE" }),
      done: () => `Versand ${created} angelegt${createTracking.trim() ? ` · Tracking ${createTracking.trim()}` : ""}.`,
      undone: "Versand wieder aufgelöst — die Teile stehen erneut bereit.",
      after: load,
    });
  };

  /* Der Versandknopf sitzt neben dem Löschknopf. Statt eines Dialogs, den man
     nach dem zwanzigsten Mal wegklickt, ohne ihn zu lesen: der Weg zurück. */
  const setShipmentStatus = async (no: string, status: string, from: string) => {
    await undoable({
      run: () => api(`/api/shipping/${no}`, { method: "PATCH", body: JSON.stringify({ status }) }),
      undo: () => api(`/api/shipping/${no}`, { method: "PATCH", body: JSON.stringify({ status: from }) }),
      done: `Versand ${no}: ${LABEL[status] ?? status}.`,
      undone: `Versand ${no} steht wieder auf „${LABEL[from] ?? from}".`,
      after: load,
    });
  };

  /* Der Tracking-Aufruf ist ein Abgleich, kein blosses Nachschlagen: meldet UPS
     „zugestellt" oder „Rücksendung", springt der Versandstatus mit. Ist UPS nicht
     eingerichtet, kommt ups.ok = false zurück und der Versand bleibt unberührt. */
  const syncTracking = async (no: string) => {
    setBusy(true);
    try {
      const res = await api<TrackResult>(`/api/shipping/${no}/tracking`);
      setTracking({ no, res });
      if (res.ups?.ok) toastSuccess(`UPS meldet: ${res.ups.status ?? "unbekannt"}.`);
      load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const saveTracking = async () => {
    if (!trackEdit) return;
    setBusy(true);
    try {
      await api(`/api/shipping/${trackEdit.no}`, {
        method: "PATCH",
        body: JSON.stringify({ carrier: trackEdit.carrier, tracking: trackEdit.tracking, price: trackEdit.price }),
      });
      toastSuccess("Spedition und Tracking gespeichert.");
      setTrackEdit(null); load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const nowMs = Date.now();
  const readyShown = sortRows((ready ?? []).filter((r) => {
    if (readyDue === "alle") return true;
    const days = r.due_date ? Math.floor((new Date(r.due_date).getTime() - nowMs) / 86_400_000) : null;
    return readyDue === "ueberfaellig" ? days !== null && days < 0 : days !== null && days >= 0 && days <= 7;
  }), readySort.sort, (r, field) => (r as unknown as Record<string, unknown>)[field]);
  const allShownSelected = readyShown.length > 0 && readyShown.every((r) => selected.includes(r.order_no));
  const toggleAllReady = (checked: boolean) => {
    if (checked) {
      const merged = new Set([...selected, ...readyShown.map((r) => r.order_no)]);
      setSelected([...merged]);
    } else {
      const shownNos = new Set(readyShown.map((r) => r.order_no));
      setSelected(selected.filter((n) => !shownNos.has(n)));
    }
  };
  const shipShown = sortRows((shipments ?? []).filter((s) => shipStatus === "alle" || s.status === shipStatus),
    shipSort.sort, (s, field) => (s as unknown as Record<string, unknown>)[field]);
  const readyDueLabel = READY_DUE_FILTERS.find(([value]) => value === readyDue)?.[1] ?? readyDue;
  const shipStatusLabel = SHIP_STATUSES.find(([value]) => value === shipStatus)?.[1] ?? shipStatus;

  return (
    <PageFrame
      title="Versand"
      sub="Geschnittene Teile verpacken, Spedition und Tracking hinterlegen, Versandmarke drucken."
      actions={<Button icon="refresh" text="Aktualisieren" onClick={() => load()} />}
    >
      {loadError && <SectionError message={loadError} onRetry={() => load()} />}

      <Tabs id="versand" selectedTabId={tab} onChange={(t) => setTab(String(t))} large
            renderActiveTabPanelOnly>
        <Tab id="bereit" title={`Zu versenden${ready ? ` (${ready.length})` : ""}`} panel={
          <>
            <Toolbar
              meta={ready ? `${readyShown.length} von ${ready.length} Aufträgen bereit` : undefined}
              end={
                <>
                  <FilterPopover active={readyDue !== "alle" ? 1 : 0} onClear={() => setReadyDue("alle")}>
                    <FilterGroup label="Termin">
                      <HTMLSelect value={readyDue} aria-label="Bereite Aufträge nach Termin filtern"
                                  onChange={(e) => setReadyDue(e.currentTarget.value)}>
                        {READY_DUE_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </HTMLSelect>
                    </FilterGroup>
                  </FilterPopover>
                  <SortControl state={readySort.sort} fields={READY_SORT_FIELDS} onChange={readySort.setSort} />
                  {readyDue !== "alle" && <FilterTag label={readyDueLabel} onRemove={() => setReadyDue("alle")} />}
                  <InfoHint label="Hinweis zum Versand" title="Spedition und Sendungsnummer"
                            text="Der Dialog fragt beides ab — auch wenn noch keine Nummer vorliegt. Die Angaben werden dem Kunden gespiegelt (Auftragsverfolgung & Konto)." />
                  <Button intent="primary" icon="box" disabled={!selected.length} onClick={openCreate}
                          title={selected.length ? "Spedition und Sendungsnummer erfassen" : "Erst Aufträge in der Liste anhaken"}>
                    {selected.length
                      ? `Versand anlegen (${selected.length} ${selected.length === 1 ? "Auftrag" : "Aufträge"})`
                      : "Versand anlegen"}
                  </Button>
                </>
              }
            />
            {!ready ? (loadError ? null : <SectionLoading />) : readyShown.length === 0 ? (
              <NonIdealState icon="tick-circle" title="Nichts zu versenden"
                description="Keine fertigen Positionen ohne Versand. Was in der Fertigung fertig gemeldet wird, erscheint hier."
                action={<Button icon="cut" text="Zur Produktion" onClick={() => navigate("produktion")} />} />
            ) : (
              <div className="table-scroll">
                <HTMLTable className="data-table" striped compact>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          checked={allShownSelected}
                          aria-label="Alle angezeigten Aufträge auswählen"
                          onChange={(e) => toggleAllReady(e.target.checked)}
                        />
                      </th>
                      <th>Auftrag</th><th>Kunde</th>
                      <th className="num">Versandfertige Teile</th><th>Fällig</th>
                    </tr>
                  </thead>
                  <tbody>
                    {readyShown.map((r) => {
                      const urgency = dueBadge({ due_date: r.due_date, status: "versandbereit" }, nowMs);
                      return (
                        <tr key={r.order_no} className={selected.includes(r.order_no) ? "row-active" : undefined}>
                          <td>
                            <input type="checkbox" checked={selected.includes(r.order_no)}
                                   aria-label={`Auftrag ${r.order_no} für den Versand auswählen`}
                                   onChange={(e) => setSelected(e.target.checked
                                     ? [...selected, r.order_no]
                                     : selected.filter((n) => n !== r.order_no))} />
                          </td>
                          <td className="mono"><RefLink kind="order" no={r.order_no} />{r.rush && <Tag minimal intent="danger" style={{ marginLeft: 4 }}>Eil</Tag>}
                            {r.manual_shipment && <Tag minimal intent="primary" style={{ marginLeft: 4 }} title="Manueller Versand — Angaben aus dem Auftragsbüro">Manuell</Tag>}</td>
                          <td>{r.customer}</td>
                          <td className="num">{r.n_ready} / {r.n_positions}</td>
                          <td className="nw">
                            <span className={urgency?.overdue ? "due-date-late" : "sub"}>{fmtDate(r.due_date)}</span>
                            {urgency && <span className={`due-pill due-pill-${urgency.tone}`}>{urgency.label}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </HTMLTable>
              </div>
            )}
          </>
        } />

        <Tab id="unterwegs" title={`Unterwegs${shipments ? ` (${shipTotal.toLocaleString("de-DE")})` : ""}`} panel={
          <>
            <Toolbar
              meta={shipments ? `${shipShown.length} von ${shipments.length} Versänden` : undefined}
              end={<>
                <FilterPopover active={shipStatus !== "alle" ? 1 : 0} onClear={() => setShipStatus("alle")}>
                  <FilterGroup label="Status">
                    <HTMLSelect value={shipStatus} aria-label="Versände nach Status filtern"
                                onChange={(e) => setShipStatus(e.currentTarget.value)}>
                      {SHIP_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </HTMLSelect>
                  </FilterGroup>
                </FilterPopover>
                <SortControl state={shipSort.sort} fields={SHIP_SORT_FIELDS} onChange={shipSort.setSort} />
                {shipStatus !== "alle" && <FilterTag label={shipStatusLabel} onRemove={() => setShipStatus("alle")} />}
                <ViewMenu columns={SHIP_COLUMNS} hidden={hidden} onToggle={toggleColumn}
                          onReset={() => setHidden(SHIP_COLUMNS_DEFAULT_HIDDEN)} />
              </>}
            />
            {!shipments ? (loadError ? null : <SectionLoading />) : shipShown.length === 0 ? (
              <EmptyNote>Noch keine Versände.</EmptyNote>
            ) : (
              <div className="table-scroll">
                <HTMLTable className="data-table" striped compact>
                  <thead>
                    <tr>
                      <th>Versand</th><th>Status</th><th>Spedition</th><th>Tracking</th>
                      {showColumn("price") && <th className="num">Versandkosten</th>}
                      <th className="num">Positionen</th>
                      {showColumn("created") && <th>Angelegt</th>}
                      <th><span className="sr-only">Aktion</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipShown.map((s) => (
                      <tr key={s.no} className={detail?.no === s.no ? "row-active" : undefined}>
                        <td className="mono">
                          <button type="button" className="row-toggle" onClick={() => openDetail(s.no)}>
                            <b>{s.no}</b>
                          </button>
                        </td>
                        <td><ShipmentStatusTag status={s.status} /></td>
                        <td>{s.carrier || "—"}</td>
                        <td className="mono">{s.tracking || "—"}</td>
                        {showColumn("price") && <td className="num">{s.price ? fmtEur(s.price) : "—"}</td>}
                        <td className="num">{s.n_items}</td>
                        {showColumn("created") && <td>{fmtDateTime(s.created_at)}</td>}
                        <td style={{ whiteSpace: "nowrap" }}>
                          <div className="ui-inline-actions" style={{ justifyContent: "flex-end" }}>
                            {s.status === "packing" && (
                              <Button small intent="primary" icon="truck" text="Versendet"
                                      onClick={() => setShipmentStatus(s.no, "shipped", s.status)} />
                            )}
                            {s.status === "shipped" && (
                              <Button small intent="success" icon="tick" text="Zugestellt"
                                      onClick={() => setShipmentStatus(s.no, "delivered", s.status)} />
                            )}
                            <KeyPopover placement="bottom-end" content={
                              <Menu>
                                {s.status === "packing" && <MenuItem icon="truck" text="Versendet melden"
                                  onClick={() => setShipmentStatus(s.no, "shipped", s.status)} />}
                                {s.status === "shipped" && <MenuItem icon="tick" text="Zugestellt melden"
                                  onClick={() => setShipmentStatus(s.no, "delivered", s.status)} />}
                                <MenuItem icon="list" text="Inhalt nach Auftrag" onClick={() => openDetail(s.no)} />
                                <MenuItem icon="edit" text="Spedition und Tracking"
                                  onClick={() => setTrackEdit({ no: s.no, carrier: s.carrier, tracking: s.tracking, price: s.price })} />
                                {s.tracking && <MenuItem icon="geosearch" text="Bei UPS nachfragen"
                                  disabled={busy} onClick={() => syncTracking(s.no)} />}
                                <MenuItem icon="print" text="Versandmarke drucken"
                                  onClick={() => apiOpenHtml(`/api/shipping/${s.no}/label`).catch((e) => toastError(e.message))} />
                                {s.status === "packing" && <>
                                  <MenuDivider />
                                  <MenuItem icon="trash" intent="danger" text="Versand auflösen"
                                    onClick={() => void undoable({
                                      run: () => api(`/api/shipping/${s.no}`, { method: "DELETE" }),
                                      done: `Versand ${s.no} aufgelöst.`,
                                      after: load,
                                    })} />
                                </>}
                              </Menu>
                            }>
                              <Button small minimal icon="more" aria-label={`Aktionen für ${s.no}`} title="Aktionen" />
                            </KeyPopover>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </HTMLTable>
              </div>
            )}
            <PaginationBar
              offset={shipOffset}
              limit={shipLimit}
              total={shipTotal}
              count={shipments?.length ?? 0}
              loading={shipLoading}
              noun="Sendungen"
              onChange={(nextOff, nextLim) => {
                setShipOffset(nextOff);
                if (nextLim !== undefined) setShipLimit(nextLim);
              }}
            />
          </>
        } />
      </Tabs>

      <Dialog isOpen={createOpen} onClose={() => setCreateOpen(false)} style={{ width: 520 }}
              title={`Versand anlegen — ${selected.length} Auftrag/Aufträge`}>
        <DialogBody>
          <HintDetails title="Wozu Spedition und Sendungsnummer?">
            Spedition und Sendungsnummer werden dem Kunden gespiegelt (Auftragsverfolgung &amp; Konto).
            Immer abfragen — auch wenn noch keine Nummer vorhanden ist.
          </HintDetails>
          {createPrefill.length > 0 && (
            <Callout intent="primary" icon="clipboard" style={{ marginBottom: 12 }}
                     title="Vorgabe aus dem Auftragsbüro">
              Auftrag <b className="mono">{createPrefill.join(", ")}</b> wurde mit manuellem
              Versand erfasst — die Angaben sind vorausgefüllt und editierbar.
            </Callout>
          )}
          <div className="form-grid">
            <label>Spedition
              <InputGroup value={createCarrier} placeholder="z. B. UPS, DHL, DPD"
                          onChange={(e) => setCreateCarrier(e.target.value)} />
            </label>
            <label>Sendungsnummer / Tracking
              <InputGroup value={createTracking} placeholder="z. B. 1Z…"
                          onChange={(e) => setCreateTracking(e.target.value)} />
            </label>
            <label>Versandkosten €
              <input className="bp5-input" type="number" min="0" step="0.01"
                     value={String(createPrice)} style={{ width: "100%" }}
                     onChange={(e) => setCreatePrice(Number(e.target.value))} />
            </label>
          </div>
          <label style={{ display: "block", marginTop: 10 }}>Notiz (optional)
            <InputGroup value={createNote} placeholder="Hinweis für den Kunden"
                        onChange={(e) => setCreateNote(e.target.value)} />
          </label>
          {!createCarrier.trim() && !createTracking.trim() && (
            <p className="sub" style={{ marginTop: 10 }}>
              Hinweis: Spedition und Sendungsnummer sind noch leer — sie lassen sich jederzeit nach dem Anlegen ergänzen.
            </p>
          )}
          <p className="sub" style={{ marginTop: 12 }}>
            Ausgewählt: <b className="mono">{selected.join(", ") || "—"}</b>
          </p>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setCreateOpen(false)} />
            <Button intent="primary" icon="box" text="Versand anlegen" loading={busy} onClick={createShipment} />
          </>} />
      </Dialog>

      <Dialog isOpen={!!detail} onClose={() => setDetail(null)} style={{ width: 720 }}
              title={`Inhalt von ${detail?.no ?? ""}`}>
        <DialogBody>
          {detail?.data.orders.length === 0 ? <p>Dieser Versand ist leer.</p> :
            detail?.data.orders.map((o) => (
              <div key={o.order_no} style={{ marginBottom: 18 }}>
                <h3 className="mono"><RefLink kind="order" no={o.order_no} /></h3>
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
        <DialogFooter actions={<Button text="Schließen" onClick={() => setDetail(null)} />} />
      </Dialog>

      <Dialog isOpen={!!trackEdit} onClose={() => setTrackEdit(null)} style={{ width: 460 }}
              title={`Spedition und Tracking — ${trackEdit?.no ?? ""}`}>
        <DialogBody>
          <div className="form-grid">
            <label>Spedition
              <InputGroup value={trackEdit?.carrier ?? ""}
                          onChange={(e) => setTrackEdit(trackEdit ? { ...trackEdit, carrier: e.target.value } : null)} />
            </label>
            <label>Sendungsnummer
              <InputGroup value={trackEdit?.tracking ?? ""} placeholder="z. B. 1Z…"
                          onChange={(e) => setTrackEdit(trackEdit ? { ...trackEdit, tracking: e.target.value } : null)} />
            </label>
            <label>Versandkosten €
              <input className="bp5-input" type="number" min="0" step="0.01"
                     value={String(trackEdit?.price ?? 0)} style={{ width: "100%" }}
                     onChange={(e) => setTrackEdit(trackEdit ? { ...trackEdit, price: Number(e.target.value) } : null)} />
            </label>
          </div>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setTrackEdit(null)} />
            <Button intent="primary" text="Speichern" loading={busy} onClick={saveTracking} />
          </>} />
      </Dialog>

      <Dialog isOpen={!!tracking} onClose={() => setTracking(null)} style={{ width: 520 }}
              title={`Sendungsverfolgung ${tracking?.no ?? ""}`}>
        <DialogBody>
          {tracking?.res.ups?.ok ? (
            <Callout intent="success" icon="tick-circle" title={`UPS: ${tracking.res.ups.status ?? "—"}`}>
              Der Versandstatus wurde bei Abweichung nachgezogen.
            </Callout>
          ) : (
            <Callout intent="warning" icon="offline"
                     title="UPS antwortet nicht oder ist nicht eingerichtet">
              {String(tracking?.res.ups?.error ?? tracking?.res.ups?.detail ??
                      "Ohne UPS-Zugang bleibt der Versand unverändert — der Status wird von Hand gepflegt.")}
            </Callout>
          )}
          <HintDetails title="UPS-Rohantwort">
            <pre className="ui-json">{JSON.stringify(tracking?.res.ups ?? {}, null, 2)}</pre>
          </HintDetails>
        </DialogBody>
        <DialogFooter actions={<Button text="Schließen" onClick={() => setTracking(null)} />} />
      </Dialog>
    </PageFrame>
  );
}

const LABEL: Record<string, string> = {
  packing: "in Vorbereitung", shipped: "versendet",
  delivered: "zugestellt", returned: "Rücksendung",
};

function ShipmentStatusTag({ status }: { status: string }) {
  const map: Record<string, { intent: any; label: string }> = {
    packing: { intent: "warning", label: "in Vorbereitung" },
    shipped: { intent: "primary", label: "versendet" },
    delivered: { intent: "success", label: "zugestellt" },
    returned: { intent: "danger", label: "Rücksendung" },
  };
  const s = map[status] ?? { intent: "none" as any, label: status };
  return <Tag intent={s.intent} minimal>{s.label}</Tag>;
}
