import { Button, Checkbox, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, HTMLTable, InputGroup,
         NumericInput, Spinner, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtDateTime } from "../api";
import type { OffcutRow, StockLocationRow } from "../factory";
import { toastError, toastSuccess } from "../toast";
import NonIdealState from "./NonIdealState";
import { OFFCUT_STATUS, StockLocationDialog, offcutPlace, offcutSize } from "./StockLocations";
import { Toolbar } from "../ui";

/* Lager-Tabs „Lagerorte" und „Reststücke".

   Lagerorte: dieselben Zeilen wie in der Kommissionierung (`/api/factory/
   stock-locations`), aber vom Regal aus gelesen — welches Fach hält was. Die
   Reststücke am selben Ort stehen dabei, damit der Blick ins Regal vollständig
   ist. Die Mengen sind Auskunft, kein Buchungssatz. */

interface Storage { id: number; label: string }
interface ProductLite { id: string; name: string; stock: number }

const fmtThk = (t: number) => (t ? `${t.toLocaleString("de-DE")} mm` : "alle Dicken");

export function LocationsPanel({ products }: { products: ProductLite[] }) {
  const [locs, setLocs] = useState<Record<string, StockLocationRow[]> | null>(null);
  const [storages, setStorages] = useState<Storage[]>([]);
  const [offcuts, setOffcuts] = useState<OffcutRow[]>([]);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<ProductLite | null>(null);
  const [offEdit, setOffEdit] = useState<OffcutRow | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ locations: Record<string, StockLocationRow[]>; storages: Storage[] }>(
        "/api/factory/stock-locations");
      setLocs(d.locations);
      setStorages(d.storages);
      const o = await api<{ offcuts: OffcutRow[] }>("/api/inventory/offcuts?status=available,reserved")
        .catch(() => ({ offcuts: [] as OffcutRow[] }));
      setOffcuts(o.offcuts);
    } catch (e) { toastError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const name = useMemo(() => Object.fromEntries(products.map((p) => [p.id, p.name || p.id])), [products]);
  const needle = q.trim().toLowerCase();

  const groups = useMemo(() => {
    const all = Object.values(locs ?? {}).flat();
    const by = new Map<string, { key: string; label: string; hall: string; rows: StockLocationRow[]; offs: OffcutRow[] }>();
    const keyOf = (id: number | null) => (id == null ? "none" : String(id));
    const ensure = (id: number | null, label: string, hall: string) => {
      const k = keyOf(id);
      if (!by.has(k)) by.set(k, { key: k, label: id == null ? "Ohne Lager" : label, hall, rows: [], offs: [] });
      return by.get(k)!;
    };
    for (const s of storages) ensure(s.id, s.label, "");
    for (const r of all) {
      if (needle && !`${r.mat} ${name[r.mat] ?? ""} ${r.bin}`.toLowerCase().includes(needle)) continue;
      const g = ensure(r.station_id, r.station_label, r.hall_name);
      if (!g.hall) g.hall = [r.hall_name, r.floor_name].filter(Boolean).join(" · ");
      g.rows.push(r);
    }
    for (const o of offcuts) {
      if (needle && !`${o.mat} ${name[o.mat] ?? ""} ${o.code} ${o.bin}`.toLowerCase().includes(needle)) continue;
      ensure(o.station_id, o.station_label, o.hall_name).offs.push(o);
    }
    for (const g of by.values()) g.rows.sort((a, b) => a.bin.localeCompare(b.bin, "de") || a.mat.localeCompare(b.mat));
    return [...by.values()].filter((g) => g.rows.length || g.offs.length || !needle);
  }, [locs, storages, offcuts, needle, name]);

  const placed = new Set(Object.keys(locs ?? {}));
  const unplaced = products.filter((p) => !placed.has(p.id) && p.stock > 0);

  return (
    <div>
      <Toolbar meta={locs ? `${groups.length} Lager` : undefined}
               end={<Button minimal icon="refresh" aria-label="Neu lesen" title="Neu lesen" onClick={load} />}>
        <InputGroup leftIcon="search" placeholder="Werkstoff, Fach, Rest…" value={q}
                    aria-label="Lagerorte durchsuchen"
                    onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
      </Toolbar>
      {!locs ? <Spinner size={26} /> : (
        <div className="lager-places">
          {groups.map((g) => {
            const plates = g.rows.reduce((a, r) => a + r.qty, 0);
            return (
              <section key={g.key} className="lager-place">
                <header>
                  <b>{g.label}</b>
                  {g.hall && <span className="sub"> · {g.hall}</span>}
                  <span className="sub lager-place-sum">
                    {plates} Pl.{g.offs.length ? ` · ${g.offs.length} Rest${g.offs.length > 1 ? "e" : ""}` : ""}
                  </span>
                </header>
                {g.rows.length === 0 && g.offs.length === 0 ? (
                  <p className="sub">Leer — hier ist noch nichts verortet.</p>
                ) : (
                  <div className="table-scroll">
                    <HTMLTable compact striped className="data-table">
                      <thead><tr><th>Fach</th><th>Werkstoff</th><th>Dicke</th><th className="num">Menge</th><th><span className="sr-only">Pflegen</span></th></tr></thead>
                      <tbody>
                        {g.rows.map((r) => (
                          <tr key={`l${r.id}`}>
                            <td className="mono">{r.bin || "—"}</td>
                            <td><b>{name[r.mat] ?? r.mat}</b> <span className="sub mono">{r.mat}</span>
                              {r.note && <div className="sub">{r.note}</div>}</td>
                            <td>{fmtThk(r.thk)}</td>
                            <td className="num"><b>{r.qty}</b> Pl.</td>
                            <td>
                              <Button small minimal icon="edit" aria-label={`Lagerorte von ${name[r.mat] ?? r.mat} bearbeiten`}
                                onClick={() => setEdit(products.find((p) => p.id === r.mat) ?? { id: r.mat, name: r.mat, stock: 0 })} />
                            </td>
                          </tr>
                        ))}
                        {g.offs.map((o) => (
                          <tr key={`o${o.id}`}>
                            <td className="mono">{o.bin || "—"}</td>
                            <td><b>{name[o.mat] ?? o.mat}</b>{" "}
                              <span className="stage-loc offcut-chip">Rest <b className="mono">{o.code}</b></span></td>
                            <td>{fmtThk(o.thk)}</td>
                            <td className="num">{offcutSize(o)} mm
                              {o.status === "reserved" && <div className="sub">reserviert · {o.work_order_no}</div>}</td>
                            <td>
                              <Button small minimal icon="edit" aria-label={`Reststück ${o.code} bearbeiten`}
                                onClick={() => setOffEdit(o)} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </HTMLTable>
                  </div>
                )}
              </section>
            );
          })}
          {unplaced.length > 0 && !needle && (
            <section className="lager-place lager-place-missing">
              <header><b>Ohne Ort</b><span className="sub"> · Bestand da, aber keinem Fach zugeordnet</span></header>
              <ul className="lager-missing-list">
                {unplaced.map((p) => (
                  <li key={p.id}>
                    <span><b>{p.name || p.id}</b> · {p.stock} Pl.</span>
                    <Button small minimal icon="map-marker" text="Ort angeben" onClick={() => setEdit(p)} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {edit && <StockLocationDialog mat={edit.id} matName={edit.name || edit.id} stock={edit.stock}
                                    onClose={(changed) => { setEdit(null); if (changed) load(); }} />}
      {offEdit && <OffcutDialog row={offEdit} products={products} storages={storages}
                                onClose={(changed) => { setOffEdit(null); if (changed) load(); }} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const STATUS_INTENT: Record<OffcutRow["status"], "none" | "success" | "primary" | "warning"> = {
  pending: "none", available: "success", reserved: "none", used: "none", scrapped: "warning",
};

export function OffcutsPanel({ products, mat, compact = false, onChange }: {
  products: ProductLite[]; mat?: string; compact?: boolean; onChange?: () => void;
}) {
  const [rows, setRows] = useState<OffcutRow[] | null>(null);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [cfg, setCfg] = useState<{ enabled: boolean; min_side: number; min_area: number } | null>(null);
  const [storages, setStorages] = useState<Storage[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<OffcutRow | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const status = showDone ? "pending,available,reserved,used,scrapped" : "pending,available,reserved";
      const d = await api<{ offcuts: OffcutRow[]; totals: Record<string, number>; config: any }>(
        `/api/inventory/offcuts?status=${status}${mat ? `&mat=${encodeURIComponent(mat)}` : ""}`);
      setRows(d.offcuts); setTotals(d.totals); setCfg(d.config);
    } catch (e) { toastError(e instanceof Error ? e.message : String(e)); setRows([]); }
  }, [mat, showDone]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (compact) return;
    api<{ storages: Storage[] }>("/api/factory/stock-locations").then((d) => setStorages(d.storages)).catch(() => {});
  }, [compact]);

  const name = Object.fromEntries(products.map((p) => [p.id, p.name || p.id]));
  const done = () => { setEditing(null); load(); onChange?.(); };

  if (compact) {
    if (!rows) return <Spinner size={18} />;
    const live = rows.filter((r) => r.status !== "used" && r.status !== "scrapped");
    if (!live.length) return <p className="sub">Keine Reststücke — sie entstehen, wenn eine Platte nicht ganz verbraucht wird.</p>;
    return (
      <ul className="offcut-mini">
        {live.map((o) => (
          <li key={o.id}>
            <span className="offcut-chip stage-loc">Rest <b className="mono">{o.code}</b></span>{" "}
            {offcutSize(o)} mm · {o.thk.toLocaleString("de-DE")} mm
            <div className="sub">{OFFCUT_STATUS[o.status]} · {offcutPlace(o)}
              {o.work_order_no ? ` · für ${o.work_order_no}` : o.source_work_order_no ? ` · aus ${o.source_work_order_no}` : ""}</div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div>
      <Toolbar meta={rows ? `${totals.available ?? 0} verfügbar · ${totals.reserved ?? 0} reserviert · ${totals.pending ?? 0} entstehen` : undefined}
               end={<>
                 <Checkbox checked={showDone} label="verbrauchte zeigen" style={{ margin: 0 }}
                           onChange={(e) => setShowDone(e.currentTarget.checked)} />
                 <Button intent="primary" icon="add" text="Reststück erfassen" onClick={() => setEditing("new")} />
                 <Button minimal icon="refresh" aria-label="Neu lesen" title="Neu lesen" onClick={load} />
               </>} />
      {cfg && (
        <p className="sub" style={{ marginTop: 0 }}>
          {cfg.enabled
            ? `Jede geschnittene Platte meldet ihren Rest ab ${cfg.min_side} mm kürzester Seite und ${cfg.min_area.toLocaleString("de-DE")} m². Der Sammellauf legt eine Platte auf ein verfügbares Reststück, wenn alle Teile mit Rand darauf passen — dann wird keine volle Platte gezogen.`
            : "Reststücke sind ausgeschaltet (Einstellung offcut_enabled)."}
        </p>
      )}
      {!rows ? <Spinner size={26} /> : rows.length === 0 ? (
        <NonIdealState icon="cut" title="Noch keine Reststücke"
          description="Sie entstehen von selbst, sobald ein Innenauftrag fertig ist und auf seiner Platte genug übrig bleibt — oder hier von Hand erfasst." />
      ) : (
        <div className="table-scroll">
          <HTMLTable compact striped interactive className="data-table" aria-label="Reststücke">
            <thead><tr>
              <th>Marke</th><th>Werkstoff</th><th className="num">Maße mm</th><th className="num">m²</th>
              <th>Zustand</th><th>Ort</th><th>Herkunft / Verwendung</th>
            </tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} onClick={() => setEditing(o)}
                    className={o.status === "used" || o.status === "scrapped" ? "row-muted" : undefined}>
                  <td>
                    <Button minimal small className="mono offcut-code-btn" text={o.code}
                            aria-label={`Reststück ${o.code} bearbeiten`}
                            onClick={(e) => { e.stopPropagation(); setEditing(o); }} />
                  </td>
                  <td>{name[o.mat] ?? o.mat} <span className="sub">· {o.thk.toLocaleString("de-DE")} mm</span></td>
                  <td className="num mono">{offcutSize(o)}</td>
                  <td className="num">{o.area_m2.toLocaleString("de-DE", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
                  <td><Tag minimal intent={STATUS_INTENT[o.status]} icon={o.status === "reserved" ? "lock" : undefined}>{OFFCUT_STATUS[o.status]}</Tag></td>
                  <td>{offcutPlace(o)}</td>
                  <td className="sub">
                    {o.source_work_order_no ? `aus ${o.source_work_order_no}` : "von Hand"}
                    {o.work_order_no ? ` → ${o.work_order_no}` : ""}
                    {o.created_at && <div>{fmtDateTime(o.created_at)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </HTMLTable>
        </div>
      )}
      {editing && <OffcutDialog row={editing === "new" ? null : editing} products={products}
                                storages={storages} onClose={(changed) => (changed ? done() : setEditing(null))} />}
    </div>
  );
}

function OffcutDialog({ row, products, storages, onClose }: {
  row: OffcutRow | null; products: ProductLite[]; storages: Storage[]; onClose: (changed: boolean) => void;
}) {
  const [mat, setMat] = useState(row?.mat ?? products[0]?.id ?? "");
  const [thk, setThk] = useState(row?.thk ?? 2);
  const [w, setW] = useState(row?.w ?? 500);
  const [h, setH] = useState(row?.h ?? 300);
  const [station, setStation] = useState<number | null>(row?.station_id ?? null);
  const [bin, setBin] = useState(row?.bin ?? "");
  const [note, setNote] = useState(row?.note ?? "");
  const [busy, setBusy] = useState(false);
  const locked = row != null && (row.status === "reserved" || row.status === "used");

  const send = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      if (row == null) {
        await api("/api/inventory/offcuts", { method: "POST",
          body: JSON.stringify({ mat, thk, w, h, station_id: station, bin, note }) });
        toastSuccess("Reststück erfasst.");
      } else {
        await api(`/api/inventory/offcuts/${row.id}`, { method: "PATCH", body: JSON.stringify({
          bin, note, ...(station == null ? { clear_station: true } : { station_id: station }),
          ...(locked ? {} : { w, h }), ...extra }) });
        toastSuccess(`${row.code} gespeichert.`);
      }
      onClose(true);
    } catch (e) { toastError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog isOpen title={row ? `Reststück ${row.code}` : "Reststück erfassen"} onClose={() => onClose(false)}
            className="stage-loc-dialog">
      <DialogBody>
        {row ? (
          <p className="sub">{products.find((p) => p.id === row.mat)?.name ?? row.mat} · {row.thk.toLocaleString("de-DE")} mm · {OFFCUT_STATUS[row.status]}
            {row.source_work_order_no && ` · aus ${row.source_work_order_no}`}
            {row.work_order_no && ` · für ${row.work_order_no}`}</p>
        ) : (
          <div className="offcut-form-row">
            <FormGroup label="Werkstoff">
              <HTMLSelect value={mat} onChange={(e) => setMat(e.currentTarget.value)} aria-label="Werkstoff">
                {products.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
              </HTMLSelect>
            </FormGroup>
            <FormGroup label="Dicke mm">
              <NumericInput min={0.1} max={500} stepSize={0.5} value={thk} buttonPosition="none" aria-label="Dicke in Millimetern"
                            onValueChange={(v) => setThk(Number.isFinite(v) ? v : 0)} />
            </FormGroup>
          </div>
        )}
        <div className="offcut-form-row">
          <FormGroup label="Breite mm">
            <NumericInput min={1} max={20000} value={w} disabled={locked} buttonPosition="none" aria-label="Breite in Millimetern"
                          onValueChange={(v) => setW(Number.isFinite(v) ? v : 0)} />
          </FormGroup>
          <FormGroup label="Länge mm">
            <NumericInput min={1} max={20000} value={h} disabled={locked} buttonPosition="none" aria-label="Länge in Millimetern"
                          onValueChange={(v) => setH(Number.isFinite(v) ? v : 0)} />
          </FormGroup>
        </div>
        <div className="offcut-form-row">
          <FormGroup label="Lager">
            <HTMLSelect value={station ?? ""} aria-label="Lager"
                        onChange={(e) => setStation(e.currentTarget.value ? Number(e.currentTarget.value) : null)}>
              <option value="">— Ort unbekannt —</option>
              {storages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </HTMLSelect>
          </FormGroup>
          <FormGroup label="Fach">
            <InputGroup value={bin} maxLength={80} placeholder="z. B. Reste · oben" aria-label="Fach"
                        onChange={(e) => setBin(e.target.value)} />
          </FormGroup>
        </div>
        <FormGroup label="Notiz">
          <InputGroup value={note} maxLength={200} aria-label="Notiz" onChange={(e) => setNote(e.target.value)} />
        </FormGroup>
        {locked && <p className="sub">Maße sind verplant — ein reserviertes oder verbrauchtes Reststück behält sie.</p>}
      </DialogBody>
      <DialogFooter actions={<>
        {row && (row.status === "available" || row.status === "pending") && (
          <Button intent="warning" icon="trash" text="Aussondern" loading={busy}
                  title="Nicht mehr verwendbar (beschädigt, verschnitten)" onClick={() => send({ status: "scrapped" })} />
        )}
        {row?.status === "scrapped" && (
          <Button icon="undo" text="Wieder verfügbar" loading={busy} onClick={() => send({ status: "available" })} />
        )}
        <Button text="Abbrechen" onClick={() => onClose(false)} />
        <Button intent="primary" text="Speichern" loading={busy}
                disabled={row?.status === "used" || (!row && !mat) || w <= 0 || h <= 0}
                onClick={() => send()} />
      </>} />
    </Dialog>
  );
}
