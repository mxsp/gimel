import { Button, Callout, Dialog, DialogBody, DialogFooter, HTMLSelect, HTMLTable, InputGroup,
         NumericInput } from "@blueprintjs/core";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { OffcutRow, StockLocationRow } from "../factory";
import { toastError, toastSuccess } from "../toast";

/* Wo das Material liegt — Anzeige und Pflege.

   `ProductStock.stock` ist die Summe, die Lagerorte sind ihre Verteilung. Die
   Anzeige sagt dem Werker, in welches Regal und Fach er greift; fehlt der Ort,
   sagt sie das ausdrücklich, statt einen zu erfinden. Die Menge je Fach ist
   eine Auskunft, kein Buchungssatz: gebucht wird im Lager. */

const fmtThk = (t: number) => (t ? `${t.toLocaleString("de-DE")} mm` : "alle Dicken");

/** Ein Ort als Chip: „Plattenregal · Fach B2 · 12 Pl.". Halle und Ebene stehen im Tooltip. */
export function LocationChips({ locations, compact = false }: {
  locations: StockLocationRow[] | undefined; compact?: boolean;
}) {
  if (!locations || locations.length === 0) {
    return <span className="stage-noloc" title="Für diesen Werkstoff ist kein Lagerort hinterlegt.">Ort unbekannt</span>;
  }
  const shown = compact ? locations.slice(0, 2) : locations;
  return (
    <span className="stage-locs">
      {shown.map((l) => {
        const where = [l.hall_name, l.floor_name].filter(Boolean).join(" · ");
        const name = [l.station_label || "ohne Lager", l.bin].filter(Boolean).join(" · ");
        return (
          <span key={l.id} className="stage-loc"
                title={`${name}${where ? ` — ${where}` : ""} · ${l.qty} Pl. · ${fmtThk(l.thk)}${l.note ? ` · ${l.note}` : ""}`}>
            {name} · <b>{l.qty} Pl.</b>
          </span>
        );
      })}
      {compact && locations.length > shown.length && (
        <span className="stage-loc stage-loc-more"
              title={locations.slice(shown.length).map((l) => `${l.station_label} ${l.bin} ${l.qty}`).join(" · ")}>
          +{locations.length - shown.length}
        </span>
      )}
    </span>
  );
}

export const OFFCUT_STATUS: Record<OffcutRow["status"], string> = {
  pending: "entsteht beim Schnitt",
  available: "verfügbar",
  reserved: "reserviert",
  used: "verbraucht",
  scrapped: "ausgesondert",
};

export const offcutSize = (o: Pick<OffcutRow, "w" | "h">) =>
  `${Math.round(o.w)}×${Math.round(o.h)}`;

export const offcutPlace = (o: Pick<OffcutRow, "station_label" | "bin">) =>
  [o.station_label, o.bin].filter(Boolean).join(" · ") || "Ort unbekannt";

/** Reststücke als Chips: „Rest R-0042 · 400×300 · Restregal". Grün, damit
 *  der Griff zum Reststück nicht mit einer vollen Platte verwechselt wird. */
export function OffcutChips({ offcuts }: { offcuts: OffcutRow[] | undefined }) {
  if (!offcuts || offcuts.length === 0) return null;
  return (
    <span className="stage-locs">
      {offcuts.map((o) => (
        <span key={o.id} className="stage-loc offcut-chip"
              title={`Reststück ${o.code} · ${offcutSize(o)} mm · ${offcutPlace(o)}${o.source_work_order_no ? ` · aus ${o.source_work_order_no}` : ""} — keine volle Platte holen`}>
          Rest <b className="mono">{o.code}</b> · {offcutSize(o)} · {offcutPlace(o)}
        </span>
      ))}
    </span>
  );
}

interface Draft {
  id: number | null;
  thk: number;
  station_id: number | null;
  bin: string;
  qty: number;
  note: string;
  dirty: boolean;
}

interface Storage { id: number; label: string }

/** Lagerorte eines Werkstoffs pflegen. Meldet über `onClose(true)`, ob etwas geändert wurde. */
export function StockLocationDialog({ mat, matName, stock, onClose }: {
  mat: string; matName: string; stock: number; onClose: (changed: boolean) => void;
}) {
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [storages, setStorages] = useState<Storage[]>([]);
  const [removed, setRemoved] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  // onClose ist meist eine Inline-Funktion; sie darf das Laden nicht neu auslösen.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let live = true;
    api<{ locations: Record<string, StockLocationRow[]>; storages: Storage[] }>(
      `/api/factory/stock-locations?mat=${encodeURIComponent(mat)}`)
      .then((d) => {
        if (!live) return;
        setStorages(d.storages);
        setRows((d.locations[mat] ?? []).map((l) => ({
          id: l.id, thk: l.thk, station_id: l.station_id, bin: l.bin, qty: l.qty, note: l.note, dirty: false,
        })));
      })
      .catch((e) => { toastError(e instanceof Error ? e.message : String(e)); closeRef.current(false); });
    return () => { live = false; };
  }, [mat]);

  const patch = (i: number, p: Partial<Draft>) =>
    setRows((rs) => rs && rs.map((r, k) => (k === i ? { ...r, ...p, dirty: true } : r)));
  const add = () => setRows((rs) => [...(rs ?? []), {
    id: null, thk: 0, station_id: storages[0]?.id ?? null, bin: "", qty: 0, note: "", dirty: true,
  }]);
  const drop = (i: number) => {
    const r = rows?.[i];
    if (r?.id != null) setRemoved((x) => [...x, r.id as number]);
    setRows((rs) => rs && rs.filter((_, k) => k !== i));
  };

  const save = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      for (const id of removed) {
        await api(`/api/factory/stock-locations/${id}`, { method: "DELETE" });
      }
      for (const r of rows.filter((x) => x.dirty)) {
        const body = JSON.stringify({ mat, thk: r.thk, station_id: r.station_id, bin: r.bin, qty: r.qty, note: r.note });
        if (r.id == null) await api("/api/factory/stock-locations", { method: "POST", body });
        else await api(`/api/factory/stock-locations/${r.id}`, { method: "PUT", body });
      }
      toastSuccess("Lagerorte gespeichert.");
      setChanged(true);
      onClose(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const total = (rows ?? []).reduce((a, r) => a + (r.qty || 0), 0);
  const diff = total - stock;
  return (
    <Dialog isOpen title={`Lagerorte · ${matName}`} onClose={() => onClose(changed)} className="stage-loc-dialog">
      <DialogBody>
        {rows == null ? <p className="sub">Lade…</p> : (
          <>
            <p className="sub">
              Wo liegt das Material? Die Mengen sind eine Auskunft für die Kommissionierung —
              der Bestand ({stock} Pl.) wird im Lager gebucht.
            </p>
            {rows.length > 0 && (
              <div className="table-scroll">
              <HTMLTable compact className="data-table stage-loc-table">
                <thead>
                  <tr><th>Lager</th><th>Fach</th><th className="num">Dicke mm</th><th className="num">Platten</th><th><span className="sr-only">Entfernen</span></th></tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id ?? `new-${i}`}>
                      <td>
                        <HTMLSelect value={r.station_id ?? ""} aria-label="Lager"
                          onChange={(e) => patch(i, { station_id: e.currentTarget.value ? Number(e.currentTarget.value) : null })}>
                          <option value="">— kein Lager —</option>
                          {storages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                        </HTMLSelect>
                      </td>
                      <td><InputGroup small value={r.bin} maxLength={80} placeholder="z. B. Fach B2 · unten"
                            aria-label="Fach" onChange={(e) => patch(i, { bin: e.target.value })} /></td>
                      <td className="num"><NumericInput small min={0} max={500} stepSize={0.5} minorStepSize={0.1}
                            value={r.thk} aria-label="Dicke in Millimetern, 0 für gemischt" buttonPosition="none"
                            onValueChange={(v) => patch(i, { thk: Number.isFinite(v) ? v : 0 })} /></td>
                      <td className="num"><NumericInput small min={0} max={1000000} value={r.qty}
                            aria-label="Platten" buttonPosition="none"
                            onValueChange={(v) => patch(i, { qty: Number.isFinite(v) ? Math.round(v) : 0 })} /></td>
                      <td><Button small minimal icon="trash" aria-label="Ort entfernen" onClick={() => drop(i)} /></td>
                    </tr>
                  ))}
                </tbody>
              </HTMLTable>
              </div>
            )}
            <Button small icon="plus" text="Ort hinzufügen" onClick={add} className="stage-loc-add" />
            {rows.length > 0 && diff !== 0 && (
              <Callout intent="warning" className="stage-loc-diff">
                {diff > 0
                  ? `${diff} Pl. mehr verortet, als der Bestand ausweist (${stock}).`
                  : `${-diff} Pl. des Bestands (${stock}) sind noch keinem Ort zugeordnet.`}
              </Callout>
            )}
            <p className="sub">Dicke 0 = in diesem Fach liegen mehrere Dicken gemischt.</p>
          </>
        )}
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Abbrechen" onClick={() => onClose(changed)} />
        <Button intent="primary" text="Speichern" loading={busy} disabled={rows == null} onClick={save} />
      </>} />
    </Dialog>
  );
}
