import { Alert, Button, Drawer, HTMLTable, Spinner, Tab, Tabs, Tag } from "@blueprintjs/core";
import { MatName, useMaterialName } from "./MaterialSelect";
import { useEffect, useState } from "react";
import { api, fmtDate, fmtM2 } from "../api";
import { startBatchRun, useBatchRun } from "../batchRun";
import { navigate } from "../router";
import { runEngineText } from "../engine";
import { plural } from "../plural";
import { toastError, toastInfo, toastSuccess } from "../toast";
import PlateViewer from "./PlateViewer";
import { InfoHint } from "../ui";

/* Ein Eimer im Detail: warum er liegt, was er enthält und was herauskäme, wenn
   er jetzt geschnitten wird. Die Vorschau rechnet dieselbe Regel wie der Lauf,
   aber mit lite; deshalb steht das dabei, solange der Lauf mit Kerf rechnet. */

export interface BucketRule {
  source: "global" | "werkstoff" | "dicke";
  mode: string; min_parts: number; min_utilisation: number;
  max_age_minutes: number; due_lead_hours: number;
}
export interface Bucket {
  mat: string; thk: number; reason: string; rule: BucketRule; rush: boolean;
  fill: number; n_orders: number; first_due: string | null; oldest_at: string | null;
  release_by: "age" | "due" | null;
  customer_id?: number | null; customer?: string;
  /* Nur bereite Eimer */
  n_plates?: number; n_parts?: number; utilisation?: number;
  /* Nur sammelnde Eimer */
  n_pieces?: number; n_positions?: number; releases_at?: string | null;
}
interface Forecast {
  n_plates: number; n_oversize: number; used_area_m2: number; plate_area_m2: number;
  customer_id?: number | null; customer?: string;
  utilisation: number; engine: string;
  plates: { idx: number; fmt: number[]; fill: number; utilisation: number; n_parts: number }[];
  orders: { order_no: string; n_pieces: number; rush: boolean; due_date: string | null }[];
}
interface CutResult { no: string; engine_version: string; n_plates: number; n_work_orders: number; note: string }

const SOURCE = { global: "Betriebsparameter", werkstoff: "Regel für den Werkstoff", dicke: "Regel für diese Dicke" };
export const pct = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v * 100)} %` : "—");
export const hours = (min: number) => (min % 60 ? `${min} min` : `${min / 60} h`);

export default function BucketPanel({ bucket, runEngine, onClose, onCut }: {
  bucket: Bucket | null; runEngine: string; onClose: () => void; onCut: () => void;
}) {
  const matName = useMaterialName();
  const [data, setData] = useState<Forecast | null>(null);
  const [error, setError] = useState("");
  const [plate, setPlate] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const run = useBatchRun();
  const query = bucket
    ? `mat=${encodeURIComponent(bucket.mat)}&thk=${bucket.thk}`
      + (bucket.customer_id != null ? `&customer_id=${bucket.customer_id}` : "")
    : "";

  useEffect(() => {
    setData(null); setError(""); setPlate(0); setConfirm(false);
    if (!query) return;
    let live = true;
    api<Forecast>(`/api/production/queue/bucket?${query}`)
      .then((f) => { if (live) setData(f); })
      .catch((e) => { if (live) setError(e.message ?? String(e)); });
    return () => { live = false; };
  }, [query]);

  const cut = async () => {
    if (!bucket) return;
    setConfirm(false);
    try {
      const r = await startBatchRun<CutResult>(true, [{ mat: bucket.mat, thk: bucket.thk }],
        bucket.customer_id != null ? { customerIds: [bucket.customer_id] } : undefined);
      if (r.n_plates > 0) {
        toastSuccess(`Sammellauf ${r.no} (${runEngineText(r.engine_version, r.n_plates)}): ${bucket.mat} ${bucket.thk} mm — ${plural(r.n_plates, "Platte", "Platten")}.`);
      } else {
        toastInfo(`Sammellauf ${r.no} hat nichts geschnitten. ${r.note}`);
      }
      onClose();
    } catch (e: any) { toastError(e.message); }
    onCut();
  };

  const b = bucket;
  const waste = data ? Math.max(0, data.plate_area_m2 - data.used_area_m2) : 0;
  const under = !!b && !!data && data.plates.some((p) => p.fill < b.rule.min_utilisation);
  const preview = runEngine.toLowerCase().startsWith("kerf");

  return (
    <Drawer isOpen={!!b} onClose={onClose} size="min(640px, 100vw)"
      title={b ? `${matName(b.mat)} · ${b.thk} mm${b.customer ? ` · ${b.customer}` : ""}` : ""}>
      {b && (
        <div className="dispo-panel">
          <p className="dispo-why">{b.reason || "Kein Grund gemeldet."}</p>

          <h3>
            Wenn jetzt geschnitten wird
            {preview && (
              <InfoHint
                label="Vorschau-Hinweis"
                title="Vorschau mit lite"
                text="Der Lauf rechnet mit Kerf; Platten und Belegung können sich dabei ändern."
              />
            )}
          </h3>
          {error && <p className="dispo-error">{error}</p>}
          {!data && !error && <Spinner size={24} aria-label="Vorschau wird gerechnet" />}
          {data && (
            <>
              <dl className="run-facts">
                <div><dt>Platten</dt><dd className="num-inline">{data.n_plates}</dd></div>
                <div><dt>Belegung</dt><dd className="num-inline">{pct(data.utilisation)}</dd></div>
                <div><dt>Verschnitt</dt><dd className="num-inline">{fmtM2(waste)}</dd></div>
                {data.n_oversize > 0 && <div><dt>Übergrößen</dt><dd className="num-inline">{data.n_oversize}, gehen an die Technik</dd></div>}
              </dl>
              {data.plates.length > 1 && (
                <Tabs id="dispo-plates" selectedTabId={plate} onChange={(t) => setPlate(Number(t))}>
                  {data.plates.map((p) => (
                    <Tab key={p.idx} id={p.idx} title={`Platte ${p.idx + 1} · ${pct(p.fill)}`} />
                  ))}
                </Tabs>
              )}
              {data.plates.length > 0 && (
                <PlateViewer key={`${query}-${plate}`} height={300}
                             src={`/api/production/queue/bucket/plate/${plate}.svg?${query}`} />
              )}

              <h3>Aufträge</h3>
              <HTMLTable className="data-table" striped compact aria-label="Aufträge im Eimer">
                <thead><tr><th>Auftrag</th><th className="num">Teile</th><th>Zusage</th></tr></thead>
                <tbody>
                  {data.orders.map((o) => (
                    <tr key={o.order_no}>
                      <td className="mono nw">
                        <button type="button" className="row-toggle"
                                onClick={() => navigate(`auftraege/${encodeURIComponent(o.order_no)}`)}>{o.order_no}</button>
                        {o.rush && <Tag minimal intent="danger" className="dispo-tag">Eilt</Tag>}
                      </td>
                      <td className="num">{o.n_pieces}</td>
                      <td className="nw">{fmtDate(o.due_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </HTMLTable>
            </>
          )}

          <h3>
            Regel
            <InfoHint
              label="Regel erklären"
              title="Woher die Regel kommt"
              text={<>Quelle: {SOURCE[b.rule.source]}. Leere Felder erben vom Betriebsparameter; eine Zeile mit Dicke schlägt „alle Dicken“.</>}
            />
          </h3>
          <dl className="run-facts">
            <div><dt>Betriebsart</dt><dd>{b.rule.mode}</dd></div>
            <div><dt>Platte gilt als voll ab</dt><dd className="num-inline">{pct(b.rule.min_utilisation)}</dd></div>
            <div><dt>Mindestens Teile</dt><dd className="num-inline">{b.rule.min_parts}</dd></div>
            <div><dt>Längste Wartezeit</dt><dd className="num-inline">{hours(b.rule.max_age_minutes)}</dd></div>
            <div><dt>Vorlauf vor Zusage</dt><dd className="num-inline">{b.rule.due_lead_hours} h</dd></div>
          </dl>

          <div className="dispo-panel-foot">
            <Button intent="primary" icon="cut" text="Diesen Eimer jetzt schneiden"
                    disabled={!data || data.n_plates === 0 || run.running} loading={run.running && run.selected}
                    onClick={() => setConfirm(true)} />
            {run.running && !run.selected && <span className="sub">Ein Sammellauf läuft gerade.</span>}
          </div>

          <Alert isOpen={confirm} intent="primary" icon="cut" cancelButtonText="Abbrechen"
                 confirmButtonText="Jetzt schneiden" canEscapeKeyCancel canOutsideClickCancel
                 onCancel={() => setConfirm(false)} onConfirm={cut}>
            <p><b><MatName id={b.mat} /> · {b.thk} mm</b> jetzt schneiden?</p>
            {data && <p>{plural(data.n_plates, "Platte", "Platten")}, Belegung {pct(data.utilisation)}, Verschnitt {fmtM2(waste)}.</p>}
            {under && <p>Mindestens eine Platte bleibt unter {pct(b.rule.min_utilisation)}. Teile, die noch gesammelt hätten, gehen mit.</p>}
          </Alert>
        </div>
      )}
    </Drawer>
  );
}
