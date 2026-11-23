import { Alert, Button, Dialog, DialogBody, DialogFooter, HTMLSelect, HTMLTable, InputGroup, NumericInput, Spinner, Tag } from "@blueprintjs/core";
import NonIdealState from "./NonIdealState";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import MaterialSelect from "./MaterialSelect";
import { toastError, toastSuccess } from "../toast";
import { InfoHint, Toolbar, useDetail } from "../ui";

/* Freigaberegeln des Sammellaufs — eine Tabelle, zwei Orte.

   Die Regel sagt pro Werkstoff (und optional je Dicke), wie er in den
   Sammellauf eingeht: sammeln bis die Platte voll ist, oder sofort schneiden.
   Jedes leere Feld erbt vom globalen Betriebsparameter; eine Zeile mit Dicke
   schlägt die Zeile „alle Dicken". Genau dieser Text steht deshalb auch im
   Dialog — eine Regel, deren Erbfolge man nicht sieht, wird abgeschaltet. */

export interface Policy {
  id: number; mat: string; thk: number | null; mode: string;
  min_parts: number | null; min_utilisation: number | null;
  max_age_minutes: number | null; due_lead_hours: number | null;
  max_orders_per_group: number | null; max_plates_per_group: number | null;
  nest_gap: number | null; nest_margin: number | null;
  nest_trim_w: number | null; nest_trim_h: number | null;
  note: string; updated_at: string | null; updated_by: string;
}

const EMPTY_POLICY: Omit<Policy, "id" | "updated_at" | "updated_by"> = {
  mat: "", thk: null, mode: "sammel",
  min_parts: null, min_utilisation: null, max_age_minutes: null, due_lead_hours: null,
  max_orders_per_group: null, max_plates_per_group: null,
  nest_gap: null, nest_margin: null, nest_trim_w: null, nest_trim_h: null, note: "",
};

/** Die Betriebsparameter, von denen eine leere Zelle erbt. */
interface Defaults {
  mode: string; min_parts: number; min_utilisation: number; max_age_minutes: number;
  due_lead_hours: number; max_orders_per_work_order: number; max_plates_per_work_order: number;
}
interface TrialRow { mat: string; thk: number; before: string; after: string; reason: string }

const pct = (v: unknown) => (typeof v === "number" ? `${Math.round(v * 100)} %` : "—");
const limit = (v: number | undefined) => (v ? String(v) : "aus");

export default function PoliciesPanel() {
  const { simple } = useDetail();
  const [rows, setRows] = useState<Policy[] | null>(null);
  const [draft, setDraft] = useState<typeof EMPTY_POLICY | null>(null);
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState<Defaults | null>(null);
  const [gone, setGone] = useState<Policy | null>(null);
  const [trial, setTrial] = useState<TrialRow[] | null>(null);

  const load = useCallback(async () => {
    try { setRows(await api<Policy[]>("/api/production/policies")); }
    catch (e: any) { toastError(e.message); }
  }, []);
  useEffect(() => {
    load();
    api<{ policy: Defaults }>("/api/production/queue").then((q) => setBase(q.policy)).catch(() => setBase(null));
  }, [load]);

  // Wirkung der Regel, solange sie entsteht. Der Server speichert dabei nichts.
  useEffect(() => {
    setTrial(null);
    if (!draft?.mat) return;
    let live = true;
    const t = setTimeout(() => {
      api<TrialRow[]>("/api/production/policies/preview", { method: "POST", body: JSON.stringify(draft) })
        .then((rows) => { if (live) setTrial(rows); })
        .catch(() => { if (live) setTrial(null); });
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [draft]);

  const save = async () => {
    if (!draft?.mat) { toastError("Bitte einen Werkstoff wählen."); return; }
    setBusy(true);
    try {
      await api("/api/production/policies", { method: "PUT", body: JSON.stringify(draft) });
      toastSuccess("Regel gespeichert.");
      setDraft(null); load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const remove = async (p: Policy) => {
    setGone(null);
    try {
      await api(`/api/production/policies/${p.id}`, { method: "DELETE" });
      toastSuccess("Regel entfernt."); load();
    } catch (e: any) { toastError(e.message); }
  };

  if (!rows) return <Spinner size={30} />;

  return (
    <div>
      <Toolbar end={
        <InfoHint
          label="Erbfolge erklären"
          title="Erbfolge"
          text="Leere Felder erben vom Betriebsparameter; eine Zeile mit Dicke schlägt die Zeile „alle Dicken“."
        />
      }>
        <Button intent="primary" icon="add" text="Regel anlegen" onClick={() => setDraft({ ...EMPTY_POLICY })} />
      </Toolbar>

      {base && (
        <dl className="dispo-defaults" aria-label="Betriebsparameter">
          <div><dt>Betriebsart</dt><dd>{base.mode}</dd></div>
          <div><dt>Platte voll ab</dt><dd>{pct(base.min_utilisation)}</dd></div>
          <div><dt>min. Teile</dt><dd>{base.min_parts}</dd></div>
          <div><dt>max. Wartezeit</dt><dd>{base.max_age_minutes} min</dd></div>
          <div><dt>Vorlauf</dt><dd>{base.due_lead_hours} h</dd></div>
          <div><dt>Aufträge je IA</dt><dd>{limit(base.max_orders_per_work_order)}</dd></div>
          <div><dt>Platten je IA</dt><dd>{limit(base.max_plates_per_work_order)}</dd></div>
        </dl>
      )}

      {rows.length === 0 ? (
        <NonIdealState icon="filter" title="Keine Ausnahmen"
                       description="Alle Werkstoffe folgen dem globalen Betriebsparameter." />
      ) : (
        <div className="dispo-table">
        <HTMLTable className="data-table" striped compact aria-label="Freigaberegeln">
          <thead>
            <tr>
              <th>Werkstoff</th><th className="num">Dicke</th><th>Betriebsart</th>
              <th className="num">min. Teile</th><th className="num">Platte voll ab</th>
              <th className="num">max. Wartezeit</th><th className="num">Vorlauf</th>
              <th className="num">Aufträge je IA</th><th className="num">Platten je IA</th>
              <th>Fertigungsmaße</th><th>Notiz</th><th><span className="sr-only">Aktion</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td><b>{p.mat}</b></td>
                <td className="num">{p.thk != null ? `${p.thk} mm` : <span className="sub">alle</span>}</td>
                <td><Tag minimal intent={p.mode === "sofort" ? "danger" : "none"}>{p.mode}</Tag></td>
                <td className="num">{p.min_parts ?? <Erbt v={base?.min_parts} />}</td>
                <td className="num">{p.min_utilisation != null ? pct(p.min_utilisation) : <Erbt v={base && pct(base.min_utilisation)} />}</td>
                <td className="num">{p.max_age_minutes != null ? `${p.max_age_minutes} min` : <Erbt v={base && `${base.max_age_minutes} min`} />}</td>
                <td className="num">{p.due_lead_hours != null ? `${p.due_lead_hours} h` : <Erbt v={base && `${base.due_lead_hours} h`} />}</td>
                <td className="num">{p.max_orders_per_group != null ? limit(p.max_orders_per_group) : <Erbt v={base && limit(base.max_orders_per_work_order)} />}</td>
                <td className="num">{p.max_plates_per_group != null ? limit(p.max_plates_per_group) : <Erbt v={base && limit(base.max_plates_per_work_order)} />}</td>
                <td className="sub mono">
                  {[p.nest_gap != null ? `gap ${p.nest_gap}` : "", p.nest_margin != null ? `rand ${p.nest_margin}` : "",
                    p.nest_trim_w || p.nest_trim_h ? `trim ${p.nest_trim_w ?? 0}/${p.nest_trim_h ?? 0}` : ""]
                    .filter(Boolean).join(" · ") || "erbt"}
                </td>
                <td className="sub">{p.note}</td>
                <td>
                  <Button aria-label="Regel bearbeiten" small minimal icon="edit" onClick={() => setDraft({ ...p })} />
                  <Button aria-label="Regel löschen" small minimal icon="trash" intent="danger" onClick={() => setGone(p)} />
                </td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
        </div>
      )}

      <Alert isOpen={!!gone} intent="danger" icon="trash" cancelButtonText="Abbrechen" confirmButtonText="Regel löschen"
             canEscapeKeyCancel canOutsideClickCancel onCancel={() => setGone(null)} onConfirm={() => gone && remove(gone)}>
        <p>Regel für <b>{gone?.mat}</b> {gone?.thk != null ? `${gone.thk} mm` : "alle Dicken"} löschen? Der Werkstoff folgt danach dem Betriebsparameter.</p>
      </Alert>

      <Dialog isOpen={!!draft} onClose={() => setDraft(null)} title="Freigaberegel" style={{ width: 560 }}>
        <DialogBody>
          {draft && (
            <div className="form-grid">
              <label>Werkstoff
                <MaterialSelect fill value={draft.mat} placeholder="— wählen —"
                                onChange={(id) => setDraft({ ...draft, mat: id })} />
              </label>
              <label>Dicke (leer = alle)
                <NumericInput fill value={draft.thk ?? ""} min={0} stepSize={0.5} buttonPosition="none"
                              onValueChange={(v) => setDraft({ ...draft, thk: Number.isFinite(v) ? v : null })} />
              </label>
              <label>Betriebsart
                <HTMLSelect fill value={draft.mode}
                            onChange={(e) => setDraft({ ...draft, mode: e.currentTarget.value })}>
                  <option value="sammel">sammel — wartet auf eine volle Platte</option>
                  <option value="sofort">sofort — schneidet je Auftrag</option>
                </HTMLSelect>
              </label>
              <PolicyNum label="min. Teile" value={draft.min_parts} inherited={base?.min_parts}
                         onChange={(v) => setDraft({ ...draft, min_parts: v })} />
              <PolicyNum label="Platte voll ab (%)" step={5} inherited={base && pct(base.min_utilisation)}
                         value={draft.min_utilisation != null ? Math.round(draft.min_utilisation * 100) : null}
                         onChange={(v) => setDraft({ ...draft, min_utilisation: v != null ? v / 100 : null })} />
              <PolicyNum label="max. Wartezeit (min)" value={draft.max_age_minutes} inherited={base?.max_age_minutes}
                         onChange={(v) => setDraft({ ...draft, max_age_minutes: v })} />
              <PolicyNum label="Vorlauf vor Zusage (h)" value={draft.due_lead_hours} inherited={base?.due_lead_hours}
                         onChange={(v) => setDraft({ ...draft, due_lead_hours: v })} />
              {/* Selten gebraucht: in „Einfach" zugeklappt, offen sobald ein Wert gesetzt ist (Aufgabe 35 E). */}
              <details className="plan-opt-fold policy-advanced" style={{ gridColumn: "1 / -1" }}
                       open={!simple || [draft.max_orders_per_group, draft.max_plates_per_group, draft.nest_gap,
                         draft.nest_margin, draft.nest_trim_w, draft.nest_trim_h].some((v) => v != null)}>
                <summary>Erweitert: Grenzen je Innenauftrag und Fertigungsmaße</summary>
                <div className="form-grid">
                  <PolicyNum label="Aufträge je Innenauftrag (0 = aus)" value={draft.max_orders_per_group}
                             inherited={base && limit(base.max_orders_per_work_order)}
                             onChange={(v) => setDraft({ ...draft, max_orders_per_group: v })} />
                  <PolicyNum label="Platten je Innenauftrag (0 = aus)" value={draft.max_plates_per_group}
                             inherited={base && limit(base.max_plates_per_work_order)}
                             onChange={(v) => setDraft({ ...draft, max_plates_per_group: v })} />
                  <PolicyNum label="Teileabstand (mm)" value={draft.nest_gap} step={0.5}
                             onChange={(v) => setDraft({ ...draft, nest_gap: v })} />
                  <PolicyNum label="Randabstand (mm)" value={draft.nest_margin} step={0.5}
                             onChange={(v) => setDraft({ ...draft, nest_margin: v })} />
                  <PolicyNum label="Beschnitt Breite (mm)" value={draft.nest_trim_w} step={1}
                             onChange={(v) => setDraft({ ...draft, nest_trim_w: v })} />
                  <PolicyNum label="Beschnitt Höhe (mm)" value={draft.nest_trim_h} step={1}
                             onChange={(v) => setDraft({ ...draft, nest_trim_h: v })} />
                </div>
              </details>
              <label style={{ gridColumn: "1 / -1" }}>Notiz
                <InputGroup value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
              </label>
              {draft.mat && (
                <div className="dispo-trial" role="status" style={{ gridColumn: "1 / -1" }}>
                  <b>Wirkung auf die Warteschlange</b>
                  {trial === null && <p className="sub">Wird gerechnet …</p>}
                  {trial?.length === 0 && <p className="sub">Für diesen Werkstoff wartet gerade nichts.</p>}
                  {trial?.map((c) => (
                    <p key={c.thk}>
                      {c.thk} mm: {c.before === c.after ? `bleibt ${c.after}` : <b>{c.before} → {c.after}</b>}
                      <span className="sub"> — {c.reason}</span>
                    </p>
                  ))}
                  {!!trial?.length && <p className="sub">Vorschau mit lite, gespeichert ist noch nichts.</p>}
                </div>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setDraft(null)} />
            <Button intent="primary" text="Speichern" loading={busy} onClick={save} />
          </>} />
      </Dialog>
    </div>
  );
}

function Erbt({ v }: { v?: string | number | null }) {
  return <span className="sub">{v == null ? "erbt" : `erbt ${v}`}</span>;
}

function PolicyNum({ label, value, onChange, step = 1, inherited }:
                   { label: string; value: number | null; onChange: (v: number | null) => void; step?: number;
                     inherited?: string | number | null }) {
  return (
    <label>{label}
      <NumericInput fill value={value ?? ""} min={0} stepSize={step} buttonPosition="none"
                    placeholder={inherited == null ? "erbt" : `erbt ${inherited}`}
                    onValueChange={(v) => onChange(Number.isFinite(v) ? v : null)} />
    </label>
  );
}
