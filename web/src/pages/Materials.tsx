import { Button, Callout, Checkbox, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect,
         HTMLTable, InputGroup, NumericInput, Spinner, Switch, Tab, Tabs, Tag, TextArea } from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtDateTime, fmtEur } from "../api";
import { toastError, toastSuccess } from "../toast";
import { GLOBAL_MATERIAL_SEARCH_EVENT, consumeGlobalMaterialSearch } from "../components/GlobalMaterialSearch";
import NewProductDialog from "../components/NewProductDialog";
import { SectionError } from "../components/PageStates";
import { PRODUCT_CATS, productCatLabel } from "../constants";
import { plural } from "../plural";
import {
  FilterGroup, FilterPopover, FilterTag, InfoHint, PageFrame, SortControl, Toolbar, ViewMenu,
  sortRows, useHiddenColumns, useSortPref,
} from "../ui";
import type { SortField } from "../ui";

/* Werkstoffe — Matrix, Preisrunde und Sätze. Übernommen aus der alten
   Verwaltungs-Subapp (/admin, /disposition).

   Die Matrix ist die Ansicht, in der Stammdatenpflege tatsächlich stattfindet:
   Preise nebeneinander, Plattenformate als Häkchen. Einzelformulare verdecken
   genau den Vergleich, um den es geht. Preisänderungen tragen immer einen
   Grund — ohne Grund fällt das Prüf-Häkchen, wie im Backend festgelegt. */

interface MatrixRow {
  id: string; name: string; short: string; cat: string; brand: string; colour: string;
  eur_m2: number; eur_m2_thk: Record<string, number>; sheets: number[][]; thicknesses: number[];
  stock: number; lead_days: number; active: boolean; price_verified: boolean;
  plate_prices: Array<{ fmt: number[]; eur: number }>;
}
interface MatrixView { standard_sheets: number[][]; rows: MatrixRow[]; }
interface RateRow {
  key: string; value: number; unit: string; note: string;
  verified: boolean; updated_at: string | null; updated_by: string;
}
interface PriceHistoryRow {
  id: number; product_id: string; thk: number | null; old_eur_m2: number; new_eur_m2: number;
  reason: string; changed_by: string; changed_at: string;
}
interface BulkRow { id: string; name: string; old_eur_m2: number; new_eur_m2: number; }
interface BulkResult { dry_run: boolean; changed: number; rows: BulkRow[]; }

const fmtSheet = (s: number[]) => `${s[0]} × ${s[1]}`;

/* Der Kern rechnet mit dem Dickensatz der bestellten Dicke; eur_m2 ist der
   Bezugspreis (2 mm), und die Dickensätze ziehen mit ihm im selben Verhältnis
   mit. Der Ab-Preis einer Platte ist der günstigste Satz — wie im Backend. */
function abPrice(r: MatrixRow, eurM2: number): number {
  const thk = Object.values(r.eur_m2_thk ?? {}).filter((v) => v > 0);
  if (!thk.length || !(r.eur_m2 > 0)) return eurM2;
  return Math.min(eurM2, ...thk.map((v) => (v * eurM2) / r.eur_m2));
}
const sameSheet = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
const sheetColId = (s: number[]) => `sheet-${s[0]}x${s[1]}`;
const BASE_COLUMNS = [
  { id: "werkstoff", label: "Werkstoff" },
  { id: "gruppe", label: "Gruppe" },
  { id: "preis", label: "€/m² (Bezug)" },
  { id: "dicken", label: "Dickensätze" },
  { id: "bestand", label: "Bestand" },
];
const MATRIX_SORT_FIELDS: SortField[] = [
  { id: "name", label: "Werkstoff" },
  { id: "cat", label: "Gruppe" },
  { id: "eur_m2", label: "Preis €/m²" },
  { id: "stock", label: "Bestand" },
  { id: "lead_days", label: "Lieferzeit" },
];

export default function Materials() {
  const [tab, setTab] = useState<string>("matrix");
  return (
    <PageFrame title="Werkstoffe" sub="Preise, Plattenformate und Sätze — die Stammdaten hinter jedem Preis.">
      <Tabs id="mat" selectedTabId={tab} onChange={(t) => setTab(String(t))} large renderActiveTabPanelOnly>
        <Tab id="matrix" title="Matrix" panel={<MatrixPanel />} />
        <Tab id="preisrunde" title="Preisrunde" panel={<BulkPanel />} />
        <Tab id="saetze" title="Sätze" panel={<RatesPanel />} />
      </Tabs>
    </PageFrame>
  );
}

// --------------------------------------------------------------------------
// Matrix: Preis und Plattenformate aller Werkstoffe auf einem Blatt
// --------------------------------------------------------------------------
function MatrixPanel() {
  const [view, setView] = useState<MatrixView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Record<string, { eur_m2: number; sheets: number[][] }>>({});
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [inactive, setInactive] = useState(false);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<{ id: string; rows: PriceHistoryRow[] } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { sort, setSort } = useSortPref("gimel-materials-sort", MATRIX_SORT_FIELDS);
  const { hidden, toggle, reset } = useHiddenColumns("gimel-materials-columns");

  // Globale Werkstoffsuche aus der Kopfzeile übernehmen — auch wenn man
  // bereits auf dieser Seite steht (dann ohne Routenwechsel).
  useEffect(() => {
    setFilter(consumeGlobalMaterialSearch());
    const onGlobal = (e: Event) => setFilter((e as CustomEvent<string>).detail ?? "");
    window.addEventListener(GLOBAL_MATERIAL_SEARCH_EVENT, onGlobal);
    return () => window.removeEventListener(GLOBAL_MATERIAL_SEARCH_EVENT, onGlobal);
  }, []);

  const load = useCallback(async () => {
    setView(null); setDraft({}); setLoadError("");
    try {
      setView(await api<MatrixView>(`/api/products/matrix/view?include_inactive=${inactive}`));
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setLoadError(msg);
      toastError(msg);
    }
  }, [inactive]);
  useEffect(() => { load(); }, [load]);

  const rowOf = (r: MatrixRow) => draft[r.id] ?? { eur_m2: r.eur_m2, sheets: r.sheets };
  const touch = (r: MatrixRow, patch: Partial<{ eur_m2: number; sheets: number[][] }>) =>
    setDraft((d) => ({ ...d, [r.id]: { ...rowOf(r), ...patch } }));

  const changed = useMemo(() => {
    if (!view) return [] as MatrixRow[];
    return view.rows.filter((r) => {
      const d = draft[r.id];
      if (!d) return false;
      return Math.abs(d.eur_m2 - r.eur_m2) > 1e-9 ||
             JSON.stringify(d.sheets) !== JSON.stringify(r.sheets);
    });
  }, [view, draft]);

  const priceChanged = changed.some((r) => Math.abs(rowOf(r).eur_m2 - r.eur_m2) > 1e-9);

  const save = async () => {
    if (priceChanged && reason.trim().length < 3) {
      toastError("Preisänderungen brauchen einen Grund (mindestens 3 Zeichen).");
      return;
    }
    setSaving(true);
    try {
      const res = await api<{ updated: number; price_changes: number; sheet_changes: number }>(
        "/api/products/matrix/save", {
          method: "POST",
          body: JSON.stringify({
            rows: changed.map((r) => ({ id: r.id, eur_m2: rowOf(r).eur_m2, sheets: rowOf(r).sheets })),
            reason: reason.trim(),
          }),
        });
      toastSuccess(`${plural(res.updated, "Werkstoff", "Werkstoffe")} gespeichert — ${res.price_changes} Preise, ${res.sheet_changes} Formate.`);
      setReason("");
      load();
    } catch (e: any) { toastError(e.message); } finally { setSaving(false); }
  };

  const openHistory = async (id: string) => {
    try {
      setHistory({ id, rows: await api<PriceHistoryRow[]>(`/api/products/${id}/price-history`) });
    } catch (e: any) { toastError(e.message); }
  };

  if (loadError && !view) return <SectionError message={loadError} onRetry={load} />;
  if (!view) return <Spinner size={30} />;

  const needle = filter.trim().toLowerCase();
  const rows = sortRows(needle
    ? view.rows.filter((r) => `${r.id} ${r.name} ${r.brand} ${r.cat}`.toLowerCase().includes(needle))
    : view.rows, sort, (r, field) => (r as unknown as Record<string, unknown>)[field]);
  const show = (id: string) => !hidden.includes(id);
  const viewColumns = [
    ...BASE_COLUMNS,
    ...view.standard_sheets.map((s) => ({ id: sheetColId(s), label: `Format ${fmtSheet(s)}` })),
  ];

  return (
    <div>
      <Toolbar
        meta={needle ? `${rows.length} von ${view.rows.length}` : `${view.rows.length} Werkstoffe`}
        end={<>
          {changed.length > 0 && (
            <div className="ui-inline-actions">
              <InputGroup placeholder={priceChanged ? "Grund der Preisänderung (Pflicht)" : "Grund (optional)"}
                          value={reason} onChange={(e) => setReason(e.target.value)}
                          intent={priceChanged && reason.trim().length < 3 ? "warning" : "none"}
                          style={{ width: 280 }} />
              <Button icon="floppy-disk" loading={saving}
                      text={`${changed.length} speichern`} onClick={save} />
              <Button minimal icon="undo" text="Verwerfen" onClick={() => { setDraft({}); setReason(""); }} />
            </div>
          )}
          <ViewMenu columns={viewColumns} hidden={hidden} onToggle={toggle} onReset={reset} />
          <Button intent="primary" icon="add" text="Neuer Werkstoff"
                  onClick={() => setCreating(true)} />
        </>}
      >
        <InputGroup leftIcon="search" placeholder="Werkstoff suchen…" value={filter}
                    aria-label="Werkstoff suchen" onChange={(e) => setFilter(e.target.value)} style={{ width: 240 }} />
        <FilterPopover active={inactive ? 1 : 0} onClear={() => setInactive(false)} label="Filter">
          <FilterGroup label="Bestand">
            <Checkbox checked={inactive} label="stillgelegte zeigen"
                      onChange={(e) => setInactive(e.currentTarget.checked)} style={{ margin: 0 }} />
          </FilterGroup>
        </FilterPopover>
        {inactive && <FilterTag label="stillgelegte zeigen" onRemove={() => setInactive(false)} />}
        <SortControl state={sort} fields={MATRIX_SORT_FIELDS} onChange={setSort} />
        <InfoHint
          label="Hinweis zu Preisen und Plattenformaten"
          text={<>
            <p>Ein Preis ohne Grund gilt wieder als Richtwert — das Prüf-Häkchen fällt dann automatisch.</p>
            <p>Plattenformate stammen aus der recherchierten Familie handelsüblicher Größen; sie sagt,
              was es im Markt gibt, nicht was das eigene Regal führt.</p>
          </>}
        />
      </Toolbar>

      <div className="table-scroll">
        <HTMLTable className="data-table" striped compact>
          <thead>
            <tr>
              {show("werkstoff") && <th>Werkstoff</th>}
              {show("gruppe") && <th>Gruppe</th>}
              {show("preis") && (
                <th className="num">
                  €/m² (Bezug)
                  <InfoHint label="Hinweis zum Bezugspreis"
                            text="Bezugspreis 2 mm — die Dickensätze ziehen im selben Verhältnis mit." />
                </th>
              )}
              {show("dicken") && <th>Dickensätze €/m²</th>}
              {show("bestand") && <th className="num">Bestand</th>}
              {view.standard_sheets.filter((s) => show(sheetColId(s))).map((s) => (
                <th key={fmtSheet(s)} className="num sheet-col">{fmtSheet(s)}</th>
              ))}
              <th><span className="sr-only">Aktion</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = rowOf(r);
              const dirty = changed.includes(r);
              return (
                <tr key={r.id} className={dirty ? "row-dirty" : undefined}>
                  {show("werkstoff") && (
                    <td>
                      <span className="swatch" style={{ background: r.colour }} />
                      <b>{r.name}</b>
                      <div className="mono sub">{r.id}{r.brand ? ` · ${r.brand}` : ""}</div>
                    </td>
                  )}
                  {show("gruppe") && (
                    <td><Tag minimal>{productCatLabel(r.cat)}</Tag>{!r.active && <Tag minimal intent="warning">stillgelegt</Tag>}</td>
                  )}
                  {show("preis") && (
                    <td className="num">
                      {/* Hauslistenpreise haben teils drei Stellen (67,035 €/m²) — mit 0,01
                          zeigte das Feld 67,04 und damit einen Preis, der nicht gilt. */}
                      <NumericInput value={d.eur_m2} min={0.01} stepSize={1} minorStepSize={0.001}
                                    aria-label={`Preis je m² ${r.name}`}
                                    buttonPosition="none" style={{ width: 82 }}
                                    onValueChange={(v) => Number.isFinite(v) && touch(r, { eur_m2: v })} />
                      {!r.price_verified && <div><Tag minimal intent="warning">Richtwert</Tag></div>}
                    </td>
                  )}
                  {show("dicken") && (
                    <td className="sub mono">
                      {Object.keys(r.eur_m2_thk ?? {}).length
                        ? Object.entries(r.eur_m2_thk).sort((a, b) => Number(a[0]) - Number(b[0]))
                            .map(([t, v]) => `${t} mm: ${fmtEur((v * d.eur_m2) / r.eur_m2)}`).join(" · ")
                        : "—"}
                      {d.sheets.some((x) => !view.standard_sheets.some((st) => sameSheet(st, x))) && (
                        <div title="Formate außerhalb der Standardfamilie bleiben beim Speichern erhalten">
                          weitere Formate: {d.sheets.filter((x) => !view.standard_sheets.some((st) => sameSheet(st, x))).map(fmtSheet).join(", ")}
                        </div>
                      )}
                    </td>
                  )}
                  {show("bestand") && <td className="num">{r.stock}</td>}
                  {view.standard_sheets.filter((s) => show(sheetColId(s))).map((s) => {
                    const on = d.sheets.some((x) => sameSheet(x, s));
                    const price = on ? (s[0] / 1000) * (s[1] / 1000) * abPrice(r, d.eur_m2) : 0;
                    return (
                      <td key={fmtSheet(s)} className="num sheet-col">
                        <Checkbox checked={on} style={{ margin: 0, justifyContent: "center" }}
                                  aria-label={`${r.name}: Format ${fmtSheet(s)} führen`}
                                  onChange={(e) => touch(r, {
                                    sheets: e.currentTarget.checked
                                      ? [...d.sheets, s]
                                      : d.sheets.filter((x) => !sameSheet(x, s)),
                                  })} />
                        {on && <div className="sub mono">{fmtEur(price)}</div>}
                      </td>
                    );
                  })}
                  <td>
                    <Button small minimal icon="edit" title="Stammdaten bearbeiten" aria-label={`${r.name} bearbeiten`}
                            onClick={() => setEditId(r.id)} />
                    <Button small minimal icon="history" title="Preisverlauf" aria-label={`Preisverlauf ${r.name}`}
                            onClick={() => openHistory(r.id)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </HTMLTable>
      </div>

      <Dialog isOpen={!!history} onClose={() => setHistory(null)} title={`Preisverlauf ${history?.id ?? ""}`}
              style={{ width: 640 }}>
        <DialogBody>
          {history?.rows.length === 0 ? <p>Noch keine Preisänderung verzeichnet.</p> : (
            <HTMLTable className="data-table" striped compact>
              <thead><tr><th>Wann</th><th>Satz</th><th className="num">von</th><th className="num">auf</th><th>Grund</th><th>Wer</th></tr></thead>
              <tbody>
                {history?.rows.map((h) => (
                  <tr key={h.id}>
                    <td>{fmtDateTime(h.changed_at)}</td>
                    <td>{h.thk == null ? "Bezug" : `${h.thk} mm`}</td>
                    <td className="num mono">{fmtEur(h.old_eur_m2)}</td>
                    <td className="num mono"><b>{fmtEur(h.new_eur_m2)}</b></td>
                    <td>{h.reason || "—"}</td>
                    <td className="sub">{h.changed_by}</td>
                  </tr>
                ))}
              </tbody>
            </HTMLTable>
          )}
        </DialogBody>
        <DialogFooter actions={<Button text="Schließen" onClick={() => setHistory(null)} />} />
      </Dialog>
      {editId && <ProductDialog id={editId} onClose={(saved) => { setEditId(null); if (saved) load(); }} />}
      {creating && <NewProductDialog isOpen onClose={(createdId) => {
        setCreating(false);
        if (createdId) load();
      }} />}
    </div>
  );
}

// --------------------------------------------------------------------------
// Stammdaten eines Werkstoffs — alle vorhandenen Felder, nur Geändertes wird gesendet
// --------------------------------------------------------------------------
interface Product {
  id: string; sku: string; name: string; short: string; brand: string; cat: string; colour: string;
  blurb: string; eur_m2: number; eur_m2_thk: Record<string, number> | null; thicknesses: number[];
  sheets: number[][]; kerf: number | null; web: number | null; min_web: number | null; grain: string;
  flip_ok: boolean; lead_days: number; url: string; datasheet_url: string; active: boolean; cnc: string;
  verified: Record<string, boolean>;
}
const FIELDS: Array<keyof Product> = ["name", "short", "brand", "cat", "colour", "blurb", "kerf", "web", "min_web",
  "grain", "flip_ok", "lead_days", "url", "datasheet_url", "active", "cnc"];

function ProductDialog({ id, onClose }: { id: string; onClose: (saved: boolean) => void }) {
  const [orig, setOrig] = useState<Product | null>(null);
  const [p, setP] = useState<Product | null>(null);
  const [thkText, setThkText] = useState("");
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Product>(`/api/products/${id}`).then((row) => {
      setOrig(row); setP({ ...row });
      setThkText((row.thicknesses ?? []).join(", "));
      setPrices({ ...(row.eur_m2_thk ?? {}) });
    }).catch((e: any) => { toastError(e.message); onClose(false); });
  }, [id, onClose]);

  if (!p || !orig) return <Dialog isOpen title="Werkstoff" onClose={() => onClose(false)}><DialogBody><Spinner size={24} /></DialogBody></Dialog>;

  const thicknesses = thkText.split(/[\s,;]+/).map((x) => Number(x.replace(",", "."))).filter((x) => x > 0);
  const priceKeys = thicknesses.map((t) => `${t}`);
  const save = async () => {
    const body: Record<string, unknown> = {};
    for (const k of FIELDS) if (p[k] !== orig[k]) body[k] = p[k];
    if (JSON.stringify(thicknesses) !== JSON.stringify(orig.thicknesses ?? [])) body.thicknesses = thicknesses;
    const newPrices = Object.fromEntries(priceKeys.filter((k) => prices[k] > 0).map((k) => [k, prices[k]]));
    const oldPrices = orig.eur_m2_thk ?? {};
    const pricesChanged = JSON.stringify(Object.entries(newPrices).sort()) !== JSON.stringify(Object.entries(oldPrices).sort());
    if (pricesChanged) body.eur_m2_thk = newPrices;
    if (!Object.keys(body).length) { toastSuccess("Keine Änderung."); onClose(false); return; }
    if (pricesChanged && reason.trim().length < 3) { toastError("Preisänderungen brauchen einen Grund (mindestens 3 Zeichen)."); return; }
    if (reason.trim()) body.price_reason = reason.trim();
    if (body.active === false && !window.confirm(`${orig.name} stilllegen? Er verschwindet aus Shop und Kalkulation; alte Aufträge bleiben auflösbar.`)) return;
    setBusy(true);
    try {
      await api(`/api/products/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      toastSuccess(`${p.name} gespeichert.`);
      onClose(true);
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };
  const set = (patch: Partial<Product>) => setP({ ...p, ...patch });
  const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));

  return (
    <Dialog isOpen onClose={() => onClose(false)} title={`Werkstoff ${orig.name}`} style={{ width: 760 }}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <DialogBody>
          {!p.active && <Callout intent="warning" icon="disable" style={{ marginBottom: 12 }}>Stillgelegt — „Aktiv“ einschalten, um ihn wieder anzubieten.</Callout>}
          <div className="form-grid">
            <label>Name<InputGroup value={p.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <label>Kurzname<InputGroup value={p.short} onChange={(e) => set({ short: e.target.value })} /></label>
            <label>Hersteller<InputGroup value={p.brand} onChange={(e) => set({ brand: e.target.value })} /></label>
            <label>Gruppe
              <HTMLSelect fill value={p.cat} onChange={(e) => set({ cat: e.currentTarget.value })}>
                {PRODUCT_CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </HTMLSelect>
            </label>
            <label>Farbe<InputGroup type="color" value={p.colour} onChange={(e) => set({ colour: e.target.value })} /></label>
            <label>Lieferzeit (Tage)<NumericInput fill min={0} max={365} value={p.lead_days} onValueChange={(v) => Number.isFinite(v) && set({ lead_days: v })} /></label>
            <label>Schnittspalt kerf (mm, leer = Satz)<InputGroup value={p.kerf == null ? "" : String(p.kerf)} onChange={(e) => set({ kerf: num(e.target.value) })} /></label>
            <label>Randabstand web (mm, leer = Satz)<InputGroup value={p.web == null ? "" : String(p.web)} onChange={(e) => set({ web: num(e.target.value) })} /></label>
            <label>Mindeststeg (mm, leer = 10)<InputGroup value={p.min_web == null ? "" : String(p.min_web)} onChange={(e) => set({ min_web: num(e.target.value) })} /></label>
            <label>Werkstoffrichtung
              <HTMLSelect fill value={p.grain} onChange={(e) => set({ grain: e.currentTarget.value })}>
                <option value="none">keine — frei drehbar</option>
                <option value="axis">Achse — nur 0°/180°</option>
                <option value="directed">gerichtet — nur 0°, nicht spiegeln</option>
              </HTMLSelect>
            </label>
            <label>Schneidbarkeit Plotter
              <HTMLSelect fill value={p.cnc} onChange={(e) => set({ cnc: e.currentTarget.value })}>
                <option value="confirmed">bestätigt</option><option value="likely">wahrscheinlich</option><option value="check">prüfen</option>
              </HTMLSelect>
            </label>
            <Switch checked={p.flip_ok} label="wendbar (Spiegeln erlaubt)" onChange={(e) => set({ flip_ok: e.currentTarget.checked })} />
            <label style={{ gridColumn: "1 / -1" }}>Datenblatt-URL<InputGroup value={p.datasheet_url} onChange={(e) => set({ datasheet_url: e.target.value })} /></label>
            <label style={{ gridColumn: "1 / -1" }}>Produktseite<InputGroup value={p.url} onChange={(e) => set({ url: e.target.value })} /></label>
            <label style={{ gridColumn: "1 / -1" }}>Beschreibung<TextArea fill rows={2} value={p.blurb} onChange={(e) => set({ blurb: e.target.value })} /></label>
          </div>

          <FormGroup label="Dicken (mm, kommagetrennt)" style={{ marginTop: 12 }}>
            <InputGroup aria-label="Dicken (mm, kommagetrennt)" value={thkText} onChange={(e) => setThkText(e.target.value)} />
          </FormGroup>
          <HTMLTable compact striped>
            <thead><tr><th>Dicke</th><th className="num">VK €/m²</th></tr></thead>
            <tbody>
              {priceKeys.map((k) => (
                <tr key={k}>
                  <td>{k} mm</td>
                  <td className="num"><NumericInput min={0} stepSize={1} minorStepSize={0.001} buttonPosition="none" style={{ width: 100 }}
                    value={prices[k] ?? ""} placeholder={`Bezug ${orig.eur_m2}`}
                    onValueChange={(v) => setPrices((cur) => ({ ...cur, [k]: Number.isFinite(v) ? v : 0 }))} /></td>
                </tr>
              ))}
            </tbody>
          </HTMLTable>
          <p className="sub">Ohne Dickensatz rechnet der Kern mit dem Bezugspreis ({fmtEur(orig.eur_m2)}/m²).</p>
          <FormGroup label="Grund einer Preisänderung (Pflicht, wenn Preise geändert werden)">
            <InputGroup aria-label="Grund einer Preisänderung (Pflicht, wenn Preise geändert werden)" value={reason} placeholder="z. B. Einkaufsliste 10/2026" onChange={(e) => setReason(e.target.value)} />
          </FormGroup>
          <Switch checked={p.active} label="Aktiv — im Shop und in der Kalkulation" onChange={(e) => set({ active: e.currentTarget.checked })} />
        </DialogBody>
        <DialogFooter actions={<>
          <Button text="Abbrechen" onClick={() => onClose(false)} />
          <Button type="submit" intent="primary" text="Speichern" loading={busy} />
        </>} />
      </form>
    </Dialog>
  );
}

// --------------------------------------------------------------------------
// Preisrunde — der übliche Fall, wenn der Lieferant die Liste anhebt
// --------------------------------------------------------------------------
function BulkPanel() {
  const [mode, setMode] = useState<"pct" | "fix">("pct");
  const [pct, setPct] = useState(5);
  const [fix, setFix] = useState(50);
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkResult | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<MatrixView>("/api/products/matrix/view")
      .then((v) => setCats([...new Set(v.rows.map((r) => r.cat))].sort()))
      .catch(() => setCats([]));
  }, []);

  const body = (dry: boolean) => JSON.stringify({
    category: category || null,
    pct: mode === "pct" ? pct : null,
    set_eur_m2: mode === "fix" ? fix : null,
    reason: reason.trim(),
    dry_run: dry,
  });

  const run = async (dry: boolean) => {
    if (reason.trim().length < 3) { toastError("Bitte einen Grund angeben (mindestens 3 Zeichen)."); return; }
    setBusy(true);
    try {
      const res = await api<BulkResult>("/api/products/prices/bulk", { method: "POST", body: body(dry) });
      setPreview(res);
      if (!dry) toastSuccess(`${res.changed} Preise geändert.`);
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <Toolbar
        end={<InfoHint
          label="Hinweis zur Preisrunde"
          text="Erst rechnen, dann schreiben. Die Runde ändert den Bezugspreis; vorhandene Dickensätze ziehen im selben Verhältnis mit (je Dicke im Preisverlauf)."
        />}
      >
        <HTMLSelect value={mode} onChange={(e) => setMode(e.currentTarget.value as any)}>
          <option value="pct">Um Prozent ändern</option>
          <option value="fix">Auf Fixpreis setzen</option>
        </HTMLSelect>
        {mode === "pct"
          ? <NumericInput value={pct} min={-90} max={200} stepSize={0.5} rightElement={<Tag minimal>%</Tag>}
                          onValueChange={(v) => Number.isFinite(v) && setPct(v)} style={{ width: 110 }} />
          : <NumericInput value={fix} min={0.01} stepSize={1} rightElement={<Tag minimal>€/m²</Tag>}
                          onValueChange={(v) => Number.isFinite(v) && setFix(v)} style={{ width: 130 }} />}
        <HTMLSelect value={category} onChange={(e) => setCategory(e.currentTarget.value)}>
          <option value="">alle Gruppen</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </HTMLSelect>
        <InputGroup placeholder="Grund (Pflicht) — z. B. Lieferantenpreisliste 09/2026"
                    aria-label="Grund der Preisrunde"
                    value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 340 }} />
        <Button icon="calculator" text="Vorschau" loading={busy} onClick={() => run(true)} />
      </Toolbar>

      {preview && (
        <>
          <h2>
            {preview.dry_run ? "Vorschau" : "Ausgeführt"} — {plural(preview.changed, "Werkstoff", "Werkstoffe")}
            {preview.dry_run && preview.changed > 0 && (
              <Button intent="danger" icon="tick" style={{ marginLeft: 12 }} loading={busy}
                      text="Jetzt wirklich ändern" onClick={() => run(false)} />
            )}
          </h2>
          {preview.changed === 0 ? <p>Diese Runde ändert nichts.</p> : (
            <HTMLTable className="data-table" striped compact>
              <thead><tr><th>Werkstoff</th><th className="num">alt</th><th className="num">neu</th><th className="num">Δ</th></tr></thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name} <span className="mono sub">{r.id}</span></td>
                    <td className="num mono">{fmtEur(r.old_eur_m2)}</td>
                    <td className="num mono"><b>{fmtEur(r.new_eur_m2)}</b></td>
                    <td className="num mono">
                      {(((r.new_eur_m2 / r.old_eur_m2) - 1) * 100).toFixed(1)} %
                    </td>
                  </tr>
                ))}
              </tbody>
            </HTMLTable>
          )}
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Sätze — Schnittsatz, Rüsten, Zeugnis, Versand, Verschnittklammer
// --------------------------------------------------------------------------
interface RateHistoryRow { at: string; actor: string; old: number; new: number; reason: string }

function RatesPanel() {
  const [rows, setRows] = useState<RateRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [edit, setEdit] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [history, setHistory] = useState<{ key: string; rows: RateHistoryRow[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api<RateRow[]>("/api/rates"));
      setLoadError("");
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setLoadError(msg);
      toastError(msg);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (r: RateRow) => {
    const value = edit[r.key];
    if (value === undefined || Math.abs(value - r.value) < 1e-12) return;
    const why = (reason[r.key] ?? "").trim();
    if (!why && !window.confirm(`${r.key} ohne Grund von ${r.value} auf ${value} setzen? Der Satz gilt dann wieder als Richtwert.`)) return;
    setBusy(r.key);
    try {
      await api(`/api/rates/${r.key}`, { method: "PATCH", body: JSON.stringify({ value, reason: why || null }) });
      toastSuccess(`${r.key}: ${r.value} → ${value}${why ? ` (${why})` : " — Richtwert"}.`);
      setEdit((e) => { const n = { ...e }; delete n[r.key]; return n; });
      setReason((e) => { const n = { ...e }; delete n[r.key]; return n; });
      load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(""); }
  };

  const openHistory = async (key: string) => {
    try { setHistory({ key, rows: await api<RateHistoryRow[]>(`/api/rates/${key}/history`) }); }
    catch (e: any) { toastError(e.message); }
  };

  if (loadError && !rows) return <SectionError message={loadError} onRetry={load} />;
  if (!rows) return <Spinner size={30} />;

  return (
    <div style={{ maxWidth: 1100 }}>
      <Toolbar end={<InfoHint
        label="Hinweis zu den Sätzen"
        text={<>
          <p>Diese Zahlen gehen in jeden Preis ein. <b>gap</b> und <b>margin</b> wirken zugleich auf den
            Verschnittfaktor — eine Werkstattentscheidung darf einen bestätigten Preis nicht verschieben;
            rein fertigungsseitige Abstände gehören in die Freigaberegeln der Disposition.</p>
          <p>Ein neuer Wert ohne Grund gilt wieder als Richtwert.</p>
        </>}
      />} />
      <div className="table-scroll">
      <HTMLTable className="data-table" striped compact>
        <thead>
          <tr><th>Satz</th><th className="num">Wert</th><th>Einheit</th><th>Bedeutung</th><th>Zuletzt</th><th><span className="sr-only">Aktion</span></th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const value = edit[r.key] ?? r.value;
            const dirty = Math.abs(value - r.value) > 1e-12;
            return (
              <tr key={r.key} className={dirty ? "row-dirty" : undefined}>
                <td className="mono"><b>{r.key}</b>
                  {!r.verified && <div><Tag minimal intent="warning">Richtwert</Tag></div>}</td>
                <td className="num">
                  {/* Abgeleitete Sätze (z. B. 1,3 / 3,6) haben unendlich viele Stellen: angezeigt
                      auf 6 gerundet, gespeichert wird nur, was jemand ändert. */}
                  <NumericInput value={edit[r.key] ?? +r.value.toFixed(6)} stepSize={0.01} minorStepSize={0.000001} buttonPosition="none"
                                style={{ width: 100 }} aria-label={`Wert ${r.key}`}
                                onValueChange={(v) => Number.isFinite(v) && setEdit((e) => ({ ...e, [r.key]: v }))} />
                  {dirty && <div className="sub mono">vorher {r.value}</div>}
                </td>
                <td>{r.unit}</td>
                <td className="sub">{r.note}</td>
                <td className="sub">{fmtDateTime(r.updated_at)}{r.updated_by ? ` · ${r.updated_by}` : ""}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {dirty && <>
                    <InputGroup small placeholder="Grund" value={reason[r.key] ?? ""} style={{ width: 160 }}
                                aria-label={`Grund für ${r.key}`}
                                onChange={(e) => setReason((x) => ({ ...x, [r.key]: e.target.value }))} />
                    <Button small icon="floppy-disk" text="Setzen"
                            loading={busy === r.key} onClick={() => save(r)} />
                  </>}
                  <Button small minimal icon="history" title="Verlauf" aria-label={`Verlauf ${r.key}`}
                          onClick={() => openHistory(r.key)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </HTMLTable>
      </div>
      <Dialog isOpen={!!history} onClose={() => setHistory(null)} title={`Verlauf ${history?.key ?? ""}`} style={{ width: 620 }}>
        <DialogBody>
          {history?.rows.length === 0 ? <p>Noch keine Änderung verzeichnet.</p> : (
            <HTMLTable className="data-table" striped compact>
              <thead><tr><th>Wann</th><th className="num">von</th><th className="num">auf</th><th>Grund</th><th>Wer</th></tr></thead>
              <tbody>
                {history?.rows.map((h, i) => (
                  <tr key={i}>
                    <td>{fmtDateTime(h.at)}</td><td className="num mono">{h.old}</td>
                    <td className="num mono"><b>{h.new}</b></td><td>{h.reason || "—"}</td><td className="sub">{h.actor}</td>
                  </tr>
                ))}
              </tbody>
            </HTMLTable>
          )}
        </DialogBody>
        <DialogFooter actions={<Button text="Schließen" onClick={() => setHistory(null)} />} />
      </Dialog>
    </div>
  );
}
