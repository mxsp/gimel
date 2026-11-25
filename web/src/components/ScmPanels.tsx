import {
  Button, Callout, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, HTMLTable,
  InputGroup, NumericInput, Spinner, Switch, Tag,
} from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, fmtEur } from "../api";
import { navigate } from "../router";
import { toastError, toastSuccess } from "../toast";
import { Toolbar } from "../ui";

export interface SupplierCandidate {
  supplier_material_id: number;
  supplier_id: number;
  supplier_code: string;
  supplier_name: string;
  supplier_email: string;
  country: string;
  city: string;
  currency: string;
  supplier_sku: string;
  thk: number;
  sheet_w: number;
  sheet_h: number;
  unit_eur_m2: number;
  plate_eur: number;
  moq_sheets: number;
  order_qty: number;
  total_net_eur: number;
  lead_days: number;
  eta_date: string;
  reliability: number;
  preferred_rank: number;
  score: number;
  is_recommended: boolean;
  reason: string;
}

export interface SmartStockItem {
  product_id: string;
  name: string;
  short: string;
  cat: string;
  colour: string;
  sku_unit: string;
  eur_m2: number;
  stock: number;
  offcuts: number;
  offcuts_m2: number;
  available_lots: number;
  open_demand: number;
  incoming_ordered: number;
  incoming_proposed: number;
  net_available: number;
  effective_rop: number;
  effective_target: number;
  auto_reorder: string;
  burn_30d: number;
  burn_90d: number;
  daily_burn: number;
  days_of_cover: number | null;
  lead_days: number;
  abc_class: string;
  health: "critical" | "reorder" | "healthy" | "overstock";
  urgent: boolean;
  suggested_order_qty: number;
  open_po_nos: string[];
  next_eta: string | null;
  supplier_count: number;
  single_source: boolean;
  recommended_supplier: SupplierCandidate | null;
  alternatives: SupplierCandidate[];
}

interface SmartStockResponse {
  items: SmartStockItem[];
  summary: {
    total: number;
    critical: number;
    reorder: number;
    healthy: number;
    overstock: number;
    single_source: number;
    open_pos: number;
  };
}

interface SupplyAlertRow {
  id: number;
  kind: string;
  severity: "danger" | "warning" | "info";
  title: string;
  detail: string;
  metric: string;
  entity_type: string;
  entity_id: string;
  status: string;
}

interface SupplierRow {
  id: number;
  code: string;
  name: string;
  email: string;
  phone: string;
  country: string;
  city: string;
  currency: string;
  payment_terms: string;
  incoterms: string;
  default_lead_days: number;
  reliability: number;
  completed_pos: number;
  on_time_pos: number;
  open_pos: number;
  overdue_pos: number;
  material_count: number;
  active: boolean;
}

interface PurchaseOrderRow {
  id: number;
  no: string;
  supplier_id: number;
  supplier_code: string;
  supplier_name: string;
  supplier_email: string;
  status: string;
  currency: string;
  order_date: string | null;
  requested_eta: string | null;
  confirmed_eta: string | null;
  received_at: string | null;
  overdue: boolean;
  total_net: number;
  note: string;
  lines: Array<{
    id: number;
    product_id: string;
    product_name: string;
    thk: number;
    sheet_w: number;
    sheet_h: number;
    qty_ordered: number;
    qty_received: number;
    qty_open: number;
    unit_price_eur: number;
    line_net: number;
  }>;
}

interface MaterialLotRow {
  id: number;
  code: string;
  product_id: string;
  thk: number;
  sheet_w: number;
  sheet_h: number;
  supplier_name: string;
  purchase_order_no: string;
  supplier_batch: string;
  cert_type: string;
  cert_ref: string;
  qty_initial: number;
  qty_remaining: number;
  station_label: string;
  bin: string;
  status: string;
  received_at: string | null;
}

// ==========================================================================
// 1. Smart-Disposition (MRP, ABC, Reichweite & 1-Klick Auto-Nachschub)
// ==========================================================================
export function SmartMrpPanel({ onOpenPoTab }: { onOpenPoTab?: () => void }) {
  const [data, setData] = useState<SmartStockResponse | null>(null);
  const [alerts, setAlerts] = useState<SupplyAlertRow[]>([]);
  const [filterHealth, setFilterHealth] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        api<SmartStockResponse>("/api/scm/smart-stock"),
        api<SupplyAlertRow[]>("/api/scm/alerts").catch(() => []),
      ]);
      setData(s);
      setAlerts(a);
    } catch (e: any) {
      toastError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runReplenish = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const res = await api<{
        dry_run: boolean;
        candidates: Array<{ product_id: string; name: string; qty: number; supplier?: SupplierCandidate }>;
        created_pos: Array<{ no: string; supplier_name: string; status: string }>;
      }>("/api/scm/replenish/run", {
        method: "POST",
        body: JSON.stringify({ dry_run: dryRun }),
      });
      if (dryRun) {
        if (!res.candidates.length) toastSuccess("Alle Bestände im grünen Bereich — kein Nachschub nötig.");
        else toastSuccess(`Vorschau: ${res.candidates.length} Werkstoffe unter Meldebestand bereit zur Bündelung.`);
      } else {
        if (!res.created_pos.length) toastSuccess("Keine neuen Bestellungen erforderlich.");
        else {
          toastSuccess(`${res.created_pos.length} Bestellung(en) erzeugt: ${res.created_pos.map((p) => p.no).join(", ")}`);
          await load();
          onOpenPoTab?.();
        }
      }
    } catch (e: any) {
      toastError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const quickOrder = async (item: SmartStockItem, mode: "propose" | "order") => {
    setBusy(true);
    try {
      const res = await api<{ purchase_order: { no: string }; mail_draft_id?: number }>(
        `/api/scm/auto-supplier/${item.product_id}/order`,
        {
          method: "POST",
          body: JSON.stringify({
            qty: Math.max(1, item.suggested_order_qty || 2),
            urgent: item.urgent,
            mode,
            create_mail_draft: true,
          }),
        },
      );
      toastSuccess(
        `${mode === "order" ? "Bestellung" : "Bestellvorschlag"} ${res.purchase_order.no} angelegt` +
        (res.mail_draft_id ? " (inkl. E-Mail-Entwurf im Postfach)." : "."),
      );
      await load();
    } catch (e: any) {
      toastError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const resolveAlert = async (id: number) => {
    try {
      await api(`/api/scm/alerts/${id}/status`, { method: "POST", body: JSON.stringify({ status: "resolved" }) });
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch (e: any) {
      toastError(e?.message ?? String(e));
    }
  };

  if (!data) return <Spinner size={28} />;

  const needle = search.trim().toLowerCase();
  const rows = data.items.filter((r) => {
    if (filterHealth !== "all" && r.health !== filterHealth) return false;
    if (needle && !`${r.name} ${r.product_id} ${r.cat} ${r.recommended_supplier?.supplier_name ?? ""}`.toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });

  return (
    <div>
      <div className="ui-facts ls-facts" style={{ marginBottom: 12 }}>
        <div className={`ui-fact ${data.summary.critical > 0 ? "is-danger" : "is-success"}`}
             style={{ cursor: "pointer" }} onClick={() => setFilterHealth(filterHealth === "critical" ? "all" : "critical")}>
          <span className="ui-fact-label">Kritische Unterdeckung</span>
          <span className="ui-fact-value">{data.summary.critical}</span>
          <span className="sub">Netto &lt; 0 oder Leerbestand</span>
        </div>
        <div className={`ui-fact ${data.summary.reorder > 0 ? "is-warning" : "is-success"}`}
             style={{ cursor: "pointer" }} onClick={() => setFilterHealth(filterHealth === "reorder" ? "all" : "reorder")}>
          <span className="ui-fact-label">Unter Meldebestand (ROP)</span>
          <span className="ui-fact-value">{data.summary.reorder}</span>
          <span className="sub">Nachschub empfohlen</span>
        </div>
        <div className="ui-fact is-accent" style={{ cursor: onOpenPoTab ? "pointer" : undefined }} onClick={onOpenPoTab}>
          <span className="ui-fact-label">Offene Bestellungen</span>
          <span className="ui-fact-value">{data.summary.open_pos}</span>
          <span className="sub">im Zulauf / vorgeschlagen</span>
        </div>
        <div className={`ui-fact ${data.summary.single_source > 0 ? "is-info" : "is-success"}`}>
          <span className="ui-fact-label">Einzelquellen (Single Source)</span>
          <span className="ui-fact-value">{data.summary.single_source}</span>
          <span className="sub">nur 1 Lieferant aktiv</span>
        </div>
      </div>

      {alerts.length > 0 && (
        <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
          {alerts.slice(0, 4).map((a) => (
            <Callout key={a.id} intent={a.severity === "danger" ? "danger" : a.severity === "warning" ? "warning" : "primary"}
                     icon={a.severity === "danger" ? "error" : "warning-sign"}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div>
                  <b>{a.title}</b> <Tag minimal>{a.metric}</Tag>
                  <div className="sub">{a.detail}</div>
                </div>
                <Button small minimal icon="tick" text="Quittieren" onClick={() => resolveAlert(a.id)} />
              </div>
            </Callout>
          ))}
        </div>
      )}

      <Toolbar
        meta={`${rows.length} von ${data.items.length} Werkstoffen`}
        end={
          <>
            <Button small icon="search-around" text="Nachschub prüfen" loading={busy} onClick={() => runReplenish(true)} />
            <Button small intent="primary" icon="automatic-updates" text="Auto-Bestellvorschläge bündeln"
                    loading={busy} onClick={() => runReplenish(false)} />
            <Button small minimal icon="refresh" onClick={load} />
          </>
        }
      >
        <InputGroup small leftIcon="search" placeholder="Werkstoff oder Lieferant…" value={search}
                    onChange={(e) => setSearch(e.target.value)} style={{ width: 230 }} />
        <HTMLSelect value={filterHealth} onChange={(e) => setFilterHealth(e.currentTarget.value)}>
          <option value="all">Alle Zustände</option>
          <option value="critical">Nur Kritisch</option>
          <option value="reorder">Unter Meldebestand</option>
          <option value="healthy">Im Plan</option>
          <option value="overstock">Überbestand</option>
        </HTMLSelect>
      </Toolbar>

      <div className="table-scroll">
        <HTMLTable className="data-table" striped compact>
          <thead>
            <tr>
              <th>Werkstoff</th>
              <th>ABC</th>
              <th className="num">Lager</th>
              <th className="num">Bedarf</th>
              <th className="num">Zulauf</th>
              <th className="num">Netto / ROP</th>
              <th className="num">Reichweite</th>
              <th>Auto-Modus</th>
              <th>Empfohlener Auto-Lieferant</th>
              <th>Aktion</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sup = r.recommended_supplier;
              const intent = r.health === "critical" ? "danger" : r.health === "reorder" ? "warning" : r.health === "overstock" ? "primary" : "success";
              return (
                <tr key={r.product_id}>
                  <td>
                    <span className="swatch" style={{ background: r.colour }} />
                    <b>{r.name}</b>
                    <div className="mono sub">
                      {r.product_id}
                      {r.offcuts > 0 ? ` · ${r.offcuts} Reste (${r.offcuts_m2} m²)` : ""}
                      {r.available_lots > 0 ? ` · ${r.available_lots} Chargen` : ""}
                    </div>
                  </td>
                  <td><Tag minimal intent={r.abc_class === "A" ? "primary" : "none"}>{r.abc_class}</Tag></td>
                  <td className="num mono"><b>{r.stock}</b> {r.sku_unit}</td>
                  <td className="num mono">{r.open_demand || "—"}</td>
                  <td className="num mono">
                    {r.incoming_ordered > 0 ? <Tag minimal intent="success">+{r.incoming_ordered}</Tag> : "—"}
                    {r.incoming_proposed > 0 && <div className="sub">+{r.incoming_proposed} Entw.</div>}
                    {r.next_eta && <div className="sub">ETA {fmtDate(r.next_eta)}</div>}
                  </td>
                  <td className="num mono">
                    <Tag intent={intent} minimal>{r.net_available}</Tag> / {r.effective_rop}
                  </td>
                  <td className="num mono">
                    {r.days_of_cover != null ? `${r.days_of_cover} Tg.` : "—"}
                    {r.burn_30d > 0 && <div className="sub">{r.burn_30d} / 30T</div>}
                  </td>
                  <td>
                    <Tag minimal intent={r.auto_reorder === "auto" ? "primary" : r.auto_reorder === "propose" ? "success" : "none"}>
                      {r.auto_reorder === "auto" ? "Auto-PO" : r.auto_reorder === "propose" ? "Vorschlag" : "Manuell"}
                    </Tag>
                  </td>
                  <td>
                    {sup ? (
                      <div>
                        <b>{sup.supplier_name}</b> <Tag minimal intent="success">{sup.score} Pkt.</Tag>
                        {r.single_source && <Tag minimal intent="warning" style={{ marginLeft: 4 }}>1 Quelle</Tag>}
                        <div className="sub">{sup.reason}</div>
                      </div>
                    ) : (
                      <span className="sub">Kein Lieferant verknüpft</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {sup && (
                      <>
                        <Button small intent={r.health === "critical" || r.health === "reorder" ? "primary" : "none"}
                                icon="shopping-cart"
                                text={r.suggested_order_qty > 0 ? `${r.suggested_order_qty} vorschlagen` : "Bestellen"}
                                disabled={busy}
                                onClick={() => quickOrder(r, r.auto_reorder === "auto" ? "order" : "propose")} />
                        <Button small minimal icon="envelope" title="Preisanfrage (RFQ) im Postfach öffnen"
                                onClick={async () => {
                                  try {
                                    await api("/api/mail/drafts", {
                                      method: "POST",
                                      body: JSON.stringify({ template: "rfq", product_id: r.product_id, qty: Math.max(5, r.suggested_order_qty || 5) }),
                                    });
                                    toastSuccess("RFQ-Entwurf im Postfach angelegt.");
                                    navigate("postfach");
                                  } catch (e: any) { toastError(e.message); }
                                }} />
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </HTMLTable>
      </div>
    </div>
  );
}

// ==========================================================================
// 2. Auto-Lieferanten & Bezugsquellen (für Werkstoffe-Seite)
// ==========================================================================
export function AutoSupplierPanel() {
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [smart, setSmart] = useState<SmartStockItem[]>([]);
  const [selectedProd, setSelectedProd] = useState<string>("");
  const [ranking, setRanking] = useState<SupplierCandidate[]>([]);
  const [urgentSim, setUrgentSim] = useState(false);
  const [qtySim, setQtySim] = useState(5);
  const [supDialog, setSupDialog] = useState(false);
  const [linkDialog, setLinkDialog] = useState(false);
  const [newSup, setNewSup] = useState({ code: "", name: "", email: "", country: "DE", city: "", default_lead_days: 7 });
  const [newLink, setNewLink] = useState({ supplier_id: 0, product_id: "", unit_eur_m2: 20, moq_sheets: 2, quoted_lead_days: 7, sheet_w: 2000, sheet_h: 1000, preferred_rank: 1 });

  const loadAll = useCallback(async () => {
    try {
      const [sList, smResp] = await Promise.all([
        api<SupplierRow[]>("/api/scm/suppliers?include_inactive=true"),
        api<SmartStockResponse>("/api/scm/smart-stock?include_inactive=true"),
      ]);
      setSuppliers(sList);
      setSmart(smResp.items);
      if (!selectedProd && smResp.items.length > 0) {
        setSelectedProd(smResp.items[0].product_id);
      }
    } catch (e: any) {
      toastError(e?.message ?? String(e));
    }
  }, [selectedProd]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const loadRanking = useCallback(async () => {
    if (!selectedProd) return;
    try {
      const r = await api<{ candidates: SupplierCandidate[] }>(
        `/api/scm/auto-supplier/${selectedProd}?qty=${qtySim}&urgent=${urgentSim}`,
      );
      setRanking(r.candidates);
    } catch (e: any) {
      toastError(e?.message ?? String(e));
    }
  }, [selectedProd, qtySim, urgentSim]);

  useEffect(() => { void loadRanking(); }, [loadRanking]);

  const saveSupplier = async () => {
    try {
      await api("/api/scm/suppliers", { method: "POST", body: JSON.stringify(newSup) });
      toastSuccess(`Lieferant ${newSup.name} angelegt.`);
      setSupDialog(false);
      setNewSup({ code: "", name: "", email: "", country: "DE", city: "", default_lead_days: 7 });
      await loadAll();
    } catch (e: any) { toastError(e.message); }
  };

  const saveLink = async () => {
    try {
      await api("/api/scm/supplier-materials", {
        method: "POST",
        body: JSON.stringify({ ...newLink, product_id: newLink.product_id || selectedProd }),
      });
      toastSuccess("Bezugsquelle gespeichert.");
      setLinkDialog(false);
      await loadAll();
      await loadRanking();
    } catch (e: any) { toastError(e.message); }
  };

  return (
    <div>
      <Toolbar
        meta={`${suppliers.length} Lieferanten im Stamm`}
        end={
          <>
            <Button small icon="link" text="Bezugsquelle zuordnen"
                    onClick={() => {
                      setNewLink((l) => ({ ...l, supplier_id: suppliers[0]?.id ?? 0, product_id: selectedProd }));
                      setLinkDialog(true);
                    }} />
            <Button small intent="primary" icon="add" text="Neuer Lieferant" onClick={() => setSupDialog(true)} />
          </>
        }
      >
        <HTMLSelect value={selectedProd} onChange={(e) => setSelectedProd(e.currentTarget.value)}>
          {smart.map((p) => (
            <option key={p.product_id} value={p.product_id}>
              {p.name} ({p.product_id}) — {p.supplier_count} Lieferant(en)
            </option>
          ))}
        </HTMLSelect>
        <NumericInput value={qtySim} min={1} max={500} style={{ width: 80 }}
                      onValueChange={(v) => Number.isFinite(v) && setQtySim(v)} />
        <span className="sub">Platten Bedarf</span>
        <Switch checked={urgentSim} label="Eilbedarf (Lieferzeit höher gewichten)" inline style={{ margin: 0 }}
                onChange={(e) => setUrgentSim(e.currentTarget.checked)} />
      </Toolbar>

      <h3>Auto-Lieferanten-Ranking für {smart.find((x) => x.product_id === selectedProd)?.name ?? selectedProd}</h3>
      {ranking.length === 0 ? (
        <Callout intent="warning" icon="info-sign" style={{ marginBottom: 18 }}>
          Noch kein Lieferant für diesen Werkstoff hinterlegt. Über „Bezugsquelle zuordnen“ EK-Preis, MOQ und Lieferzeit eintragen.
        </Callout>
      ) : (
        <HTMLTable className="data-table" striped compact style={{ marginBottom: 22 }}>
          <thead>
            <tr>
              <th>Rang / Score</th>
              <th>Lieferant</th>
              <th className="num">EK €/m²</th>
              <th className="num">Format (mm)</th>
              <th className="num">MOQ / Menge</th>
              <th className="num">Summe netto</th>
              <th className="num">Lieferzeit / ETA</th>
              <th className="num">Liefertreue</th>
              <th>Begründung</th>
              <th>Aktion</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((c, idx) => (
              <tr key={c.supplier_material_id}>
                <td>
                  <Tag intent={idx === 0 ? "success" : "none"} minimal={idx > 0}>
                    #{idx + 1} · {c.score} Pkt.
                  </Tag>
                </td>
                <td>
                  <b>{c.supplier_name}</b> <span className="mono sub">({c.supplier_code} · {c.country})</span>
                  {c.supplier_sku && <div className="mono sub">Art.-Nr. {c.supplier_sku}</div>}
                </td>
                <td className="num mono">{fmtEur(c.unit_eur_m2)}</td>
                <td className="num mono">{c.sheet_w}×{c.sheet_h}</td>
                <td className="num mono">{c.moq_sheets} / <b>{c.order_qty}</b></td>
                <td className="num mono"><b>{fmtEur(c.total_net_eur)}</b></td>
                <td className="num mono">{c.lead_days} Tg. · {fmtDate(c.eta_date)}</td>
                <td className="num mono">{Math.round(c.reliability * 100)} %</td>
                <td className="sub">{c.reason}</td>
                <td>
                  <Button small intent={idx === 0 ? "primary" : "none"} icon="shopping-cart" text="Bestellen"
                          onClick={async () => {
                            try {
                              const r = await api<{ purchase_order: { no: string } }>(
                                `/api/scm/auto-supplier/${selectedProd}/order`,
                                {
                                  method: "POST",
                                  body: JSON.stringify({ supplier_id: c.supplier_id, qty: c.order_qty, urgent: urgentSim, mode: "order" }),
                                },
                              );
                              toastSuccess(`Bestellung ${r.purchase_order.no} bei ${c.supplier_name} angelegt.`);
                            } catch (e: any) { toastError(e.message); }
                          }} />
                </td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
      )}

      <h3>Lieferantenverzeichnis</h3>
      <HTMLTable className="data-table" striped compact>
        <thead>
          <tr>
            <th>Code</th><th>Lieferant</th><th>Ort / Land</th><th>E-Mail</th>
            <th className="num">Std.-Lieferzeit</th><th className="num">Liefertreue</th>
            <th className="num">Werkstoffe</th><th className="num">Offene POs</th>
          </tr>
        </thead>
        <tbody>
          {suppliers.map((s) => (
            <tr key={s.id}>
              <td className="mono"><b>{s.code}</b></td>
              <td><b>{s.name}</b>{!s.active && <Tag minimal intent="warning" style={{ marginLeft: 6 }}>inaktiv</Tag>}</td>
              <td>{s.city ? `${s.city}, ` : ""}{s.country}</td>
              <td className="mono sub">{s.email || "—"}</td>
              <td className="num mono">{s.default_lead_days} Tg.</td>
              <td className="num mono">
                <Tag minimal intent={s.reliability >= 0.9 ? "success" : s.reliability >= 0.75 ? "warning" : "danger"}>
                  {Math.round(s.reliability * 100)} %
                </Tag>
              </td>
              <td className="num mono">{s.material_count}</td>
              <td className="num mono">
                {s.open_pos}
                {s.overdue_pos > 0 && <Tag minimal intent="danger" style={{ marginLeft: 4 }}>{s.overdue_pos} überfällig</Tag>}
              </td>
            </tr>
          ))}
        </tbody>
      </HTMLTable>

      <Dialog isOpen={supDialog} onClose={() => setSupDialog(false)} title="Neuen Lieferanten anlegen">
        <DialogBody>
          <div className="form-grid">
            <FormGroup label="Kurzcode *"><InputGroup value={newSup.code} placeholder="z. B. ALU-NORD" onChange={(e) => setNewSup({ ...newSup, code: e.target.value })} /></FormGroup>
            <FormGroup label="Firmenname *"><InputGroup value={newSup.name} placeholder="Alu Nordhandel GmbH" onChange={(e) => setNewSup({ ...newSup, name: e.target.value })} /></FormGroup>
            <FormGroup label="E-Mail (für Bestellungen)"><InputGroup value={newSup.email} placeholder="bestellung@beispiel.de" onChange={(e) => setNewSup({ ...newSup, email: e.target.value })} /></FormGroup>
            <FormGroup label="Stadt"><InputGroup value={newSup.city} onChange={(e) => setNewSup({ ...newSup, city: e.target.value })} /></FormGroup>
            <FormGroup label="Land"><InputGroup value={newSup.country} onChange={(e) => setNewSup({ ...newSup, country: e.target.value })} /></FormGroup>
            <FormGroup label="Standard-Lieferzeit (Tage)"><NumericInput fill min={1} max={180} value={newSup.default_lead_days} onValueChange={(v) => Number.isFinite(v) && setNewSup({ ...newSup, default_lead_days: v })} /></FormGroup>
          </div>
        </DialogBody>
        <DialogFooter actions={<>
          <Button text="Abbrechen" onClick={() => setSupDialog(false)} />
          <Button intent="primary" text="Anlegen" disabled={!newSup.code.trim() || !newSup.name.trim()} onClick={saveSupplier} />
        </>} />
      </Dialog>

      <Dialog isOpen={linkDialog} onClose={() => setLinkDialog(false)} title="Bezugsquelle (Lieferant ↔ Werkstoff) zuordnen">
        <DialogBody>
          <div className="form-grid">
            <FormGroup label="Lieferant">
              <HTMLSelect fill value={newLink.supplier_id} onChange={(e) => setNewLink({ ...newLink, supplier_id: Number(e.currentTarget.value) })}>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
              </HTMLSelect>
            </FormGroup>
            <FormGroup label="Werkstoff">
              <HTMLSelect fill value={newLink.product_id || selectedProd} onChange={(e) => setNewLink({ ...newLink, product_id: e.currentTarget.value })}>
                {smart.map((p) => <option key={p.product_id} value={p.product_id}>{p.name} ({p.product_id})</option>)}
              </HTMLSelect>
            </FormGroup>
            <FormGroup label="Einkaufspreis €/m²"><NumericInput fill min={0.1} stepSize={0.5} value={newLink.unit_eur_m2} onValueChange={(v) => Number.isFinite(v) && setNewLink({ ...newLink, unit_eur_m2: v })} /></FormGroup>
            <FormGroup label="MOQ (Mindestabnahme Platten)"><NumericInput fill min={1} value={newLink.moq_sheets} onValueChange={(v) => Number.isFinite(v) && setNewLink({ ...newLink, moq_sheets: v })} /></FormGroup>
            <FormGroup label="Lieferzeit (Tage)"><NumericInput fill min={1} value={newLink.quoted_lead_days} onValueChange={(v) => Number.isFinite(v) && setNewLink({ ...newLink, quoted_lead_days: v })} /></FormGroup>
            <FormGroup label="Vorzugsrang (1 = Hauptlieferant)"><NumericInput fill min={1} max={10} value={newLink.preferred_rank} onValueChange={(v) => Number.isFinite(v) && setNewLink({ ...newLink, preferred_rank: v })} /></FormGroup>
            <FormGroup label="Plattenbreite (mm)"><NumericInput fill min={100} stepSize={100} value={newLink.sheet_w} onValueChange={(v) => Number.isFinite(v) && setNewLink({ ...newLink, sheet_w: v })} /></FormGroup>
            <FormGroup label="Plattenhöhe (mm)"><NumericInput fill min={100} stepSize={100} value={newLink.sheet_h} onValueChange={(v) => Number.isFinite(v) && setNewLink({ ...newLink, sheet_h: v })} /></FormGroup>
          </div>
        </DialogBody>
        <DialogFooter actions={<>
          <Button text="Abbrechen" onClick={() => setLinkDialog(false)} />
          <Button intent="primary" text="Speichern" disabled={!newLink.supplier_id} onClick={saveLink} />
        </>} />
      </Dialog>
    </div>
  );
}

// ==========================================================================
// 3. Einkaufsbestellungen & Wareneingang (inkl. Chargenbuchung)
// ==========================================================================
export function PurchaseOrdersPanel() {
  const [pos, setPos] = useState<PurchaseOrderRow[] | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [receivePo, setReceivePo] = useState<PurchaseOrderRow | null>(null);
  const [grForm, setGrForm] = useState({ delivery_note_no: "", cert_type: "3.1", cert_ref: "", supplier_batch: "", bin: "Wareneingang", note: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
      setPos(await api<PurchaseOrderRow[]>(`/api/scm/purchase-orders${q}`));
    } catch (e: any) { toastError(e.message); }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  const sendPoMail = async (no: string) => {
    setBusy(true);
    try {
      const r = await api<{ mode: string }>(`/api/scm/purchase-orders/${no}/send-mail`, { method: "POST" });
      toastSuccess(`Bestellschreiben ${no} übermittelt (${r.mode === "smtp" ? "SMTP" : "Postausgang protokolliert"}).`);
      await load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const bookReceipt = async () => {
    if (!receivePo) return;
    setBusy(true);
    try {
      const r = await api<{ goods_receipt_no: string; qty_received: number; lots: string[] }>(
        `/api/scm/purchase-orders/${receivePo.no}/receive`,
        { method: "POST", body: JSON.stringify(grForm) },
      );
      toastSuccess(`Wareneingang ${r.goods_receipt_no}: +${r.qty_received} Platten gebucht · Charge(n) ${r.lots.join(", ")}`);
      setReceivePo(null);
      await load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  if (!pos) return <Spinner size={28} />;

  return (
    <div>
      <Toolbar meta={`${pos.length} Bestellungen`} end={<Button small minimal icon="refresh" onClick={load} />}>
        <HTMLSelect value={statusFilter} onChange={(e) => setStatusFilter(e.currentTarget.value)}>
          <option value="">Alle Status</option>
          <option value="proposed">Vorgeschlagen (Freigabe offen)</option>
          <option value="ordered,confirmed,partial">Offen im Zulauf</option>
          <option value="received">Vereinnahmt</option>
        </HTMLSelect>
      </Toolbar>

      <div className="table-scroll">
        <HTMLTable className="data-table" striped compact>
          <thead>
            <tr>
              <th>Bestell-Nr.</th><th>Lieferant</th><th>Status</th><th>Positionen</th>
              <th className="num">Netto</th><th>Liefertermin (ETA)</th><th>Aktion</th>
            </tr>
          </thead>
          <tbody>
            {pos.map((po) => (
              <tr key={po.id}>
                <td className="mono"><b>{po.no}</b></td>
                <td><b>{po.supplier_name}</b> <span className="sub">{po.supplier_code}</span></td>
                <td>
                  <Tag minimal intent={
                    po.overdue ? "danger" : po.status === "received" ? "success" : po.status === "proposed" ? "warning" : "primary"
                  }>
                    {po.overdue ? `${po.status} · überfällig` : po.status}
                  </Tag>
                </td>
                <td>
                  {po.lines.map((l) => (
                    <div key={l.id} className="sub">
                      <b>{l.product_name}</b> ({l.thk} mm) · {l.qty_received}/{l.qty_ordered} Pl.
                    </div>
                  ))}
                </td>
                <td className="num mono"><b>{fmtEur(po.total_net)}</b></td>
                <td className="mono sub">{fmtDate(po.confirmed_eta || po.requested_eta)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {po.status === "proposed" && (
                    <Button small intent="primary" icon="endorsed" text="Freigeben & Mail"
                            loading={busy} onClick={() => sendPoMail(po.no)} style={{ marginRight: 4 }} />
                  )}
                  {po.status !== "received" && po.status !== "cancelled" && (
                    <Button small intent="success" icon="import" text="Wareneingang"
                            onClick={() => {
                              setGrForm({ delivery_note_no: "", cert_type: "3.1", cert_ref: "", supplier_batch: "", bin: "Wareneingang", note: "" });
                              setReceivePo(po);
                            }} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
      </div>

      <Dialog isOpen={!!receivePo} onClose={() => setReceivePo(null)} title={`Wareneingang buchen — ${receivePo?.no ?? ""}`}>
        <DialogBody>
          <p className="sub" style={{ marginBottom: 12 }}>
            Bucht die gelieferten Platten in den Lagerbestand, legt automatisch eine rückverfolgbare Charge (`CH-…`) an und verknüpft das Werkszeugnis.
          </p>
          <div className="form-grid">
            <FormGroup label="Lieferschein-Nr."><InputGroup value={grForm.delivery_note_no} placeholder="LS-2026-..." onChange={(e) => setGrForm({ ...grForm, delivery_note_no: e.target.value })} /></FormGroup>
            <FormGroup label="Zeugnisart (EN 10204)">
              <HTMLSelect fill value={grForm.cert_type} onChange={(e) => setGrForm({ ...grForm, cert_type: e.currentTarget.value })}>
                <option value="3.1">EN 10204 — 3.1 Abnahmeprüfzeugnis</option>
                <option value="2.2">EN 10204 — 2.2 Werkszeugnis</option>
                <option value="">Ohne Zeugnis</option>
              </HTMLSelect>
            </FormGroup>
            <FormGroup label="Zeugnis-Referenz"><InputGroup value={grForm.cert_ref} placeholder="WZ-..." onChange={(e) => setGrForm({ ...grForm, cert_ref: e.target.value })} /></FormGroup>
            <FormGroup label="Lieferanten-Charge"><InputGroup value={grForm.supplier_batch} placeholder="Batch / Schmelze" onChange={(e) => setGrForm({ ...grForm, supplier_batch: e.target.value })} /></FormGroup>
            <FormGroup label="Zielfach im Lager"><InputGroup value={grForm.bin} onChange={(e) => setGrForm({ ...grForm, bin: e.target.value })} /></FormGroup>
            <FormGroup label="Bemerkung"><InputGroup value={grForm.note} onChange={(e) => setGrForm({ ...grForm, note: e.target.value })} /></FormGroup>
          </div>
        </DialogBody>
        <DialogFooter actions={<>
          <Button text="Abbrechen" onClick={() => setReceivePo(null)} />
          <Button intent="success" icon="tick" text="Wareneingang & Charge buchen" loading={busy} onClick={bookReceipt} />
        </>} />
      </Dialog>
    </div>
  );
}

// ==========================================================================
// 4. Chargen & Zeugnisse (EN 10204 Rückverfolgung)
// ==========================================================================
export function LotsPanel() {
  const [lots, setLots] = useState<MaterialLotRow[] | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      setLots(await api<MaterialLotRow[]>("/api/scm/lots"));
    } catch (e: any) { toastError(e.message); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!lots) return <Spinner size={28} />;
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? lots.filter((l) => `${l.code} ${l.product_id} ${l.supplier_name} ${l.cert_ref} ${l.supplier_batch}`.toLowerCase().includes(needle))
    : lots;

  return (
    <div>
      <Toolbar meta={`${shown.length} Chargen`} end={<Button small minimal icon="refresh" onClick={load} />}>
        <InputGroup small leftIcon="search" placeholder="Charge, Werkstoff, Zeugnis…" value={q}
                    onChange={(e) => setQ(e.target.value)} style={{ width: 250 }} />
      </Toolbar>
      <div className="table-scroll">
        <HTMLTable className="data-table" striped compact>
          <thead>
            <tr>
              <th>Charge</th><th>Werkstoff</th><th className="num">Maß / Dicke</th>
              <th>Lieferant / Bestellung</th><th>Zeugnis</th><th className="num">Rest / Start</th>
              <th>Lagerort</th><th>Eingang</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id}>
                <td className="mono"><b>{l.code}</b></td>
                <td className="mono">{l.product_id}</td>
                <td className="num mono">{l.sheet_w}×{l.sheet_h} · {l.thk} mm</td>
                <td>
                  {l.supplier_name || "—"}
                  {l.purchase_order_no && <span className="mono sub"> · {l.purchase_order_no}</span>}
                </td>
                <td>
                  {l.cert_type ? <Tag minimal intent="primary">EN {l.cert_type}</Tag> : "—"}{" "}
                  <span className="mono sub">{l.cert_ref || l.supplier_batch}</span>
                </td>
                <td className="num mono"><b>{l.qty_remaining}</b> / {l.qty_initial}</td>
                <td>{l.station_label ? `${l.station_label} · ` : ""}{l.bin || "—"}</td>
                <td className="sub">{fmtDate(l.received_at)}</td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
      </div>
    </div>
  );
}
