import {
  Button, Callout, Card, Checkbox, Dialog, DialogBody, DialogFooter, FormGroup,
  HTMLSelect, HTMLTable, NumericInput, Spinner, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, canAdminWork, getUser } from "../../api";
import NonIdealState from "../NonIdealState";
import type { Robot, RobotJob, RobotJobPlan, Station, WorklistData } from "../../factory";
import { toastError, toastSuccess } from "../../toast";

/* Transportaufträge: der Auftragskontext, der Weg und die Flotte.
 *
 * Die Seite ist die Brücke zwischen Fertigung und Roboter: ein Innenauftrag
 * oder eine Stationsaufgabe wird zu einem hochstufigen Transport. Der Weg
 * kommt aus dem Gangnetz, nie aus einer Luftlinie ohne Hinweis. Der Roboter
 * wird vorgeschlagen, die Freigabe bleibt bei einem Menschen.
 */

const STATE_STYLE: Record<string, { label: string; intent: "none" | "primary" | "success" | "warning" | "danger" }> = {
  proposed: { label: "Vorschlag", intent: "none" },
  approved: { label: "freigegeben", intent: "primary" },
  assigned: { label: "zugewiesen", intent: "primary" },
  running: { label: "fährt", intent: "success" },
  done: { label: "abgeschlossen", intent: "success" },
  failed: { label: "Störung", intent: "danger" },
  cancelled: { label: "storniert", intent: "none" },
};

const KIND_LABEL: Record<string, string> = {
  pickup: "Abholung",
  delivery: "Anlieferung",
  transfer: "Umsetzung",
  return: "Rücktransport",
};

interface Draft {
  work_order_no: string;
  from_station_id: number | null;
  to_station_id: number | null;
  kind: string;
  priority: string;
  note: string;
  auto_assign: boolean;
}

const emptyDraft = (): Draft => ({
  work_order_no: "",
  from_station_id: null,
  to_station_id: null,
  kind: "transfer",
  priority: "5",
  note: "",
  auto_assign: true,
});

interface ContextRow {
  ref: string;
  label: string;
  station_id: number | null;
  station_label: string;
  orders: string[];
  mat: string;
  thk: number;
}

function contextsFromWorklist(data: WorklistData | null): ContextRow[] {
  if (!data) return [];
  const out = new Map<string, ContextRow>();
  for (const station of data.stations ?? []) {
    for (const slot of station.schedule?.slots ?? []) {
      if (!slot.ref || out.has(slot.ref)) continue;
      out.set(slot.ref, {
        ref: slot.ref,
        label: slot.label || slot.ref,
        station_id: station.id,
        station_label: station.label,
        orders: slot.orders ?? [],
        mat: slot.mat_name || slot.mat || "",
        thk: slot.thk ?? 0,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.ref.localeCompare(b.ref, "de"));
}

function WayPreview({ route }: { route: [number, number][] }) {
  if (route.length < 2) return null;
  const xs = route.map((p) => p[0]), ys = route.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 12, w = 280, h = 140;
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const sx = (x: number) => pad + ((x - minX) / spanX) * (w - pad * 2);
  const sy = (y: number) => h - pad - ((y - minY) / spanY) * (h - pad * 2);
  const points = route.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(" ");
  return (
    <svg className="robot-route-preview robot-way-preview" viewBox={`0 0 ${w} ${h}`}
         role="img" aria-label={`Transportweg, ${route.length} Punkte`}>
      <rect x="0" y="0" width={w} height={h} rx="4" className="robot-route-bg" />
      <polyline points={points} fill="none" className="robot-route-line" />
      <circle cx={sx(route[0][0])} cy={sy(route[0][1])} r="4" className="robot-route-start" />
      <circle cx={sx(route[route.length - 1][0])} cy={sy(route[route.length - 1][1])} r="4"
              className="robot-route-target" />
    </svg>
  );
}

export default function RobotJobs({ robots, onChanged }: { robots: Robot[]; onChanged: () => void }) {
  const staff = (() => {
    const user = getUser();
    return user?.role === "staff" || canAdminWork(user);
  })();
  const [jobs, setJobs] = useState<RobotJob[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [contexts, setContexts] = useState<ContextRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [plan, setPlan] = useState<RobotJobPlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(0);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [j, s, w] = await Promise.all([
        api<{ jobs: RobotJob[] }>(`/api/factory/robot-jobs${activeOnly ? "?active=true" : ""}`),
        api<Station[]>("/api/factory/stations"),
        api<WorklistData>("/api/factory/worklist"),
      ]);
      setJobs(j.jobs ?? []);
      setStations(s ?? []);
      setContexts(contextsFromWorklist(w));
      setError("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (!silent) toastError(msg);
    } finally {
      setLoading(false);
    }
  }, [activeOnly]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(true); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const counts = useMemo(() => ({
    proposed: jobs.filter((j) => j.state === "proposed").length,
    assigned: jobs.filter((j) => j.state === "assigned").length,
    running: jobs.filter((j) => j.state === "running").length,
    done: jobs.filter((j) => j.state === "done").length,
  }), [jobs]);

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const openNew = () => {
    setPlan(null);
    setPlanError("");
    setDraft(emptyDraft());
  };

  const chooseContext = (ref: string) => {
    const ctx = contexts.find((c) => c.ref === ref);
    const targetFloorId = ctx?.station_id
      ? stations.find((s) => s.id === ctx.station_id)?.floor_id ?? null
      : null;
    const storage = stations.find((s) =>
      s.is_storage && s.active && (targetFloorId == null || s.floor_id === targetFloorId));
    patch({
      work_order_no: ref,
      to_station_id: ctx?.station_id ?? null,
      from_station_id: storage?.id ?? null,
    });
    setPlan(null);
  };

  const runPlan = async () => {
    if (!draft) return;
    if (!draft.from_station_id || !draft.to_station_id) {
      setPlanError("Bitte Start und Ziel wählen.");
      return;
    }
    setPlanning(true);
    setPlanError("");
    try {
      const result = await api<RobotJobPlan>("/api/factory/robot-jobs/plan", {
        method: "POST",
        body: JSON.stringify({
          kind: draft.kind,
          from_station_id: draft.from_station_id,
          to_station_id: draft.to_station_id,
          work_order_no: draft.work_order_no || undefined,
          priority: Number(draft.priority),
        }),
      });
      setPlan(result);
    } catch (e: unknown) {
      setPlan(null);
      setPlanError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  };

  const createJob = async () => {
    if (!draft) return;
    if (!draft.from_station_id || !draft.to_station_id) {
      setPlanError("Bitte Start und Ziel wählen.");
      return;
    }
    setSaving(true);
    setPlanError("");
    try {
      await api("/api/factory/robot-jobs", {
        method: "POST",
        body: JSON.stringify({
          kind: draft.kind,
          from_station_id: draft.from_station_id,
          to_station_id: draft.to_station_id,
          work_order_no: draft.work_order_no || undefined,
          priority: Number(draft.priority),
          note: draft.note,
          auto_assign: draft.auto_assign,
          approve: true,
        }),
      });
      toastSuccess("Transport angelegt.");
      setDraft(null);
      setPlan(null);
      await load(true);
      onChanged();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPlanError(msg);
      toastError(msg);
    } finally {
      setSaving(false);
    }
  };

  const act = async (job: RobotJob, action: string, body: Record<string, unknown> = {}) => {
    setBusy(job.id);
    try {
      await api(`/api/factory/robot-jobs/${job.id}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      toastSuccess(`${job.ref}: ${action === "approve" ? "freigegeben" :
        action === "assign" ? "zugewiesen" : action === "start" ? "gestartet" :
        action === "done" ? "abgeschlossen" : action === "cancel" ? "storniert" : "gemeldet"}.`);
      await load(true);
      onChanged();
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(0);
    }
  };

  const stationLabel = (id: number | null | undefined) =>
    stations.find((s) => s.id === id)?.label ?? (id == null ? "—" : `Station #${id}`);

  const floorStations = useMemo(() => {
    if (!draft) return stations;
    const from = stations.find((s) => s.id === draft.from_station_id);
    if (!from) return stations;
    const same = stations.filter((s) => s.floor_id === from.floor_id);
    return same.length >= 2 ? same : stations;
  }, [draft, stations]);

  if (loading && !jobs.length) return <div className="twin-center"><Spinner size={36} /></div>;

  return (
    <div>
      <div className="twin-head">
        <div>
          <h2 className="page-title">Transporte</h2>
          <p className="page-sub">
            Auftragskontext, Weg und Roboter in einer Zeile. Der Vorschlag ist keine Freigabe —
            gestartet wird von einem Menschen. {robots.filter((r) => r.active).length} aktive Roboter.
          </p>
        </div>
        <div className="twin-head-actions">
          <Checkbox inline checked={activeOnly} label="nur offene"
                    onChange={(e) => setActiveOnly(e.currentTarget.checked)} />
          <Button icon="refresh" text="Aktualisieren" onClick={() => load()} />
          {staff && <Button intent="primary" icon="add" text="Neuer Transport" onClick={openNew} />}
        </div>
      </div>

      <div className="stat-row">
        <div className="stat-card"><span className="stat-label">Vorschläge</span><b className="stat-value">{counts.proposed}</b></div>
        <div className="stat-card"><span className="stat-label">zugewiesen</span><b className="stat-value">{counts.assigned}</b></div>
        <div className="stat-card"><span className="stat-label">fahren</span><b className="stat-value">{counts.running}</b></div>
        <div className="stat-card"><span className="stat-label">abgeschlossen</span><b className="stat-value">{counts.done}</b></div>
      </div>

      {error && <Callout intent="warning" icon="warning-sign" className="mb">Transporte ließen sich nicht laden: {error}</Callout>}

      {!jobs.length ? (
        <Card>
          <NonIdealState icon="route" title="Keine Transporte"
            description={staff
              ? "Lege einen Transport aus einem Innenauftrag an. Start und Ziel liegen auf derselben Ebene."
              : "Ein Planer kann hier Transporte anlegen."}
            action={staff ? <Button intent="primary" icon="add" text="Neuer Transport" onClick={openNew} /> : undefined} />
        </Card>
      ) : (
        <div className="table-scroll">
          <HTMLTable className="data-table" striped compact>
            <thead>
              <tr>
                <th>Referenz</th><th>Kontext</th><th>Von → Nach</th><th>Roboter</th>
                <th>Zustand</th><th className="num">Weg</th><th className="num">ETA</th>
                <th><span className="sr-only">Aktion</span></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const style = STATE_STYLE[job.state] ?? STATE_STYLE.proposed;
                const endless = job.eta_s > 0 ? `${Math.max(1, Math.round(job.eta_s / 60))} min` : "?";
                const orderNums = Array.isArray(job.context.order_nos)
                  ? (job.context.order_nos as string[]).join(", ") : job.order_no;
                return (
                  <tr key={job.id}>
                    <td className="mono">{job.ref}</td>
                    <td>
                      {job.work_order_no
                        ? <><b>{job.work_order_no}</b><div className="sub">{orderNums || "Innenauftrag"}</div></>
                        : <span className="sub">{orderNums || "ohne Auftrag"}</span>}
                      {job.task_kind && <div className="sub">{job.task_kind} {job.task_ref}</div>}
                    </td>
                    <td>
                      {job.from?.label ?? stationLabel(job.from?.id)} → {job.to?.label ?? stationLabel(job.to?.id)}
                      <div className="sub">{KIND_LABEL[job.kind] ?? job.kind}</div>
                    </td>
                    <td>{job.robot_name || <span className="sub">—</span>}</td>
                    <td><Tag minimal intent={style.intent}>{style.label}</Tag></td>
                    <td className="num">
                      {job.route_m > 0 ? `${Math.round(job.route_m)} m` : "—"}
                      {!job.route_exact && <div className="sub" title={job.route_note}>geschätzt</div>}
                    </td>
                    <td className="num">{endless}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {staff && job.state === "proposed" && (
                        <Button small minimal icon="endorsed" text="Freigeben"
                                loading={busy === job.id} onClick={() => act(job, "approve")} />
                      )}
                      {staff && (job.state === "proposed" || job.state === "approved") && (
                        <Button small minimal icon="exchange" text="Zuweisen"
                                loading={busy === job.id} onClick={() => act(job, "assign")} />
                      )}
                      {job.state === "assigned" && (
                        <Button small minimal intent="primary" icon="play" text="Start"
                                loading={busy === job.id} onClick={() => act(job, "start")} />
                      )}
                      {job.state === "running" && (
                        <>
                          <Button small minimal intent="success" icon="tick" text="Fertig"
                                  loading={busy === job.id} onClick={() => act(job, "done", { note: "" })} />
                          <Button small minimal intent="danger" icon="warning-sign" text="Störung"
                                  loading={busy === job.id} onClick={() => act(job, "fail", { note: "Störung an der Halle" })} />
                        </>
                      )}
                      {staff && !["done", "failed", "cancelled"].includes(job.state) && (
                        <Button small minimal icon="cross" aria-label={`${job.ref} stornieren`}
                                loading={busy === job.id} onClick={() => act(job, "cancel", { note: "storniert" })} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </HTMLTable>
        </div>
      )}

      <Dialog isOpen={draft != null} onClose={() => !saving && setDraft(null)}
              title="Neuer Transport" className="robot-dialog">
        {draft && (
          <>
            <DialogBody>
              <Callout compact intent="primary" icon="route" className="mb">
                Der Weg wird aus dem Gangnetz gerechnet. Ein Wechsel zwischen Ebenen braucht einen
                Aufzug — den kennt Gimel nicht und lehnt ihn deshalb ab.
              </Callout>
              <div className="robot-form-grid">
                <FormGroup label="Auftragskontext" labelFor="job-context"
                           helperText="Aus dem Arbeitsvorrat; leer = freier Transport.">
                  <HTMLSelect id="job-context" fill value={draft.work_order_no}
                              onChange={(e) => chooseContext(e.currentTarget.value)}>
                    <option value="">ohne Innenauftrag</option>
                    {contexts.map((c) => (
                      <option key={c.ref} value={c.ref}>
                        {c.ref} · {c.station_label} · {c.mat || "Werkstoff ?"} {c.thk ? `${c.thk} mm` : ""}
                      </option>
                    ))}
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="Art" labelFor="job-kind">
                  <HTMLSelect id="job-kind" fill value={draft.kind}
                              onChange={(e) => patch({ kind: e.currentTarget.value })}>
                    {Object.entries(KIND_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="Von Station" labelFor="job-from">
                  <HTMLSelect id="job-from" fill value={draft.from_station_id ?? ""}
                              onChange={(e) => { patch({ from_station_id: e.currentTarget.value ? Number(e.currentTarget.value) : null }); setPlan(null); }}>
                    <option value="">— wählen —</option>
                    {floorStations.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="Nach Station" labelFor="job-to">
                  <HTMLSelect id="job-to" fill value={draft.to_station_id ?? ""}
                              onChange={(e) => { patch({ to_station_id: e.currentTarget.value ? Number(e.currentTarget.value) : null }); setPlan(null); }}>
                    <option value="">— wählen —</option>
                    {floorStations.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="Priorität" labelFor="job-priority" helperText="1 = eilig, 9 = darf warten.">
                  <NumericInput id="job-priority" fill min={1} max={9} value={draft.priority}
                                onValueChange={(v) => patch({ priority: String(v ?? 5) })} />
                </FormGroup>
                <FormGroup label="Zuweisung">
                  <Checkbox checked={draft.auto_assign} label="Roboter automatisch vorschlagen und zuweisen"
                            onChange={(e) => patch({ auto_assign: e.currentTarget.checked })} />
                </FormGroup>
              </div>
              <FormGroup label="Notiz" labelFor="job-note">
                <TextArea id="job-note" rows={2} fill value={draft.note}
                          onChange={(e) => patch({ note: e.currentTarget.value })}
                          placeholder="z. B. Platten gestapelt, nicht stapeln" />
              </FormGroup>

              <div className="robot-plan-row">
                <Button icon="route" text="Weg und Roboter planen" loading={planning} onClick={runPlan} />
                {plan && (
                  <span className="sub">
                    {Math.round(plan.route_m)} m · {plan.route_exact ? "über Gänge" : "geschätzt"} ·{" "}
                    {plan.recommended ? `Vorschlag ${plan.recommended.name}` : "kein Roboter frei"}
                  </span>
                )}
              </div>
              {plan && (
                <div className="robot-plan-result">
                  <WayPreview route={plan.route} />
                  <div>
                    <p className="sub">{plan.route_exact ? plan.route_note : `Kein Gangweg: ${plan.route_note}`}</p>
                    {plan.candidates.length ? (
                      <ul className="robot-candidate-list">
                        {plan.candidates.slice(0, 4).map((c) => (
                          <li key={c.robot_id}>
                            <b>{c.name}</b> · {c.reason}
                            {c.eta_s > 0 && <> · {Math.max(1, Math.round(c.eta_s / 60))} min</>}
                          </li>
                        ))}
                      </ul>
                    ) : <p className="sub">Kein Roboter auf dieser Ebene erfüllt die Bedingungen.</p>}
                    {plan.rejected.length > 0 && (
                      <p className="sub">Abgelehnt: {plan.rejected.map((r) => `${r.name} (${r.reason})`).join(", ")}</p>
                    )}
                  </div>
                </div>
              )}
              {planError && <Callout compact intent="danger" icon="error" className="mb">{planError}</Callout>}
            </DialogBody>
            <DialogFooter actions={
              <>
                <Button text="Abbrechen" disabled={saving} onClick={() => setDraft(null)} />
                <Button intent="primary" icon="add" text="Transport anlegen"
                        loading={saving} disabled={!draft.from_station_id || !draft.to_station_id}
                        onClick={createJob} />
              </>
            } />
          </>
        )}
      </Dialog>
    </div>
  );
}
