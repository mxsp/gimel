import { Button, HTMLSelect, HTMLTable, NumericInput, Switch, Tag } from "@blueprintjs/core";
import { RefLink } from "../components/RefLink";
import Callout from "../components/Callout";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDateTime, fmtM2, fmtPoints } from "../api";
import BatchRunBar from "../components/BatchRunBar";
import { startBatchRun, useBatchRun } from "../batchRun";
import { runEngineKind, runEngineText } from "../engine";
import { SectionError, SectionLoading } from "../components/PageStates";
import { toastError, toastSuccess } from "../toast";
import PoliciesPanel from "../components/PoliciesPanel";
import { KpiStrip } from "../ui";
import { plural } from "../plural";

/* Sammellauf — das Steuerpult im Admin-Tab.

   Die Disposition zeigt die Warteschlange im Betrieb; hier steht die Regel
   selbst: Taktgeber an/aus und sein Takt, die globalen Betriebsparameter,
   die Warte-Menge mit ihren Freigabegründen, die Freigaberegeln je Werkstoff
   und die letzten Läufe samt der Zahl, die das Sammeln rechtfertigt — der
   gesparten Plattenfläche gegenüber Einzelfertigung.

   Alles lädt aus vier Quellen (Queue, Stats, Läufe, Settings) und erneuert
   sich alle 15 Sekunden von selbst; der Countdown tickt lokal jede Sekunde,
   ohne den Server zu belasten. */

interface ReadyBucket {
  mat: string; thk: number; mode: string; reason: string;
  customer?: string; customer_id?: number | null;
  n_plates: number; n_parts: number; n_orders: number;
  utilisation: number; fill: number; held_positions: number; hold_reason: string;
}
interface HeldBucket {
  mat: string; thk: number; reason: string; n_pieces: number;
  customer?: string; customer_id?: number | null;
  n_positions: number; n_orders: number; fill: number; releases_at: string | null;
}
interface SchedulerState {
  running: boolean; last_run_at: string | null; last_run_no: string | null;
  last_error: string | null; next_run_at: string | null; interval_minutes: number | null;
}
interface QueuePolicy {
  mode: string; group_by: string; min_parts: number | null; min_utilisation: number | null;
  max_age_minutes: number | null; due_lead_hours: number | null;
  max_plates_per_run: number; max_orders_per_work_order: number | null;
  max_plates_per_work_order: number | null; mixed_formats: boolean;
  interval_minutes: number; enabled: boolean;
}
interface QueueView {
  waiting_positions: number; waiting_parts: number;
  ready: ReadyBucket[]; held: HeldBucket[];
  policy: QueuePolicy;
  nest: { gap: number | null; margin: number | null; trim_w: number | null; trim_h: number | null };
  scheduler: SchedulerState;
}
interface RunRow {
  no: string; trigger: string; engine_version: string; started_at: string; finished_at: string | null;
  n_orders: number; n_positions: number; n_parts: number; n_plates: number;
  n_work_orders: number; saved_area_m2: number; saved_pct: number;
  n_open: number; n_running: number; n_done: number; n_cancelled: number;
}
interface Stats {
  runs_30d: number; saved_area_m2_30d: number; saved_pct_30d: number;
  positions_pending: number; positions_manual: number;
  work_orders_open: number; work_orders_running: number;
}
interface SettingRow { key: string; value: string; note: string; updated_at: string | null; updated_by: string }
interface OpenWorkOrder {
  no: string; mat: string; mat_name: string; thk: number;
  n_plates: number; n_parts: number; n_orders: number;
  utilisation: number; created_at: string;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;
const m2 = fmtM2;

// Die globalen Betriebsparameter — alles, was _check_setting serverseitig
// kennt. „effective“ ist der Wert, der gerade greift (aus der Queue-Rechnung),
// das Eingabefeld zeigt dagegen, was wirklich gesetzt ist.
interface SettingDef {
  key: string; label: string; kind: "number" | "select";
  effective?: (q: QueueView) => string;
  min?: number; max?: number; step?: number; hint?: string;
  options?: { value: string; label: string }[];
}

const SETTING_DEFS: SettingDef[] = [
  { key: "batch_mode", label: "Betriebsart", kind: "select",
    effective: (q) => q.policy.mode, hint: "sammel oder sofort",
    options: [
      { value: "sammel", label: "sammel — wartet auf volle Platte" },
      { value: "sofort", label: "sofort — schneidet je Auftrag" },
    ] },
  { key: "batch_group_by", label: "Schachtelgruppe", kind: "select",
    effective: (q) => q.policy.group_by, hint: "Kunden mischen oder je Kunde trennen",
    options: [
      { value: "material", label: "Material — Kunden mischen" },
      { value: "customer", label: "Kunde — nur je Kunde schachteln" },
    ] },
  { key: "batch_min_parts", label: "min. Teile je Platte", kind: "number",
    effective: (q) => String(q.policy.min_parts ?? ""), min: 1, max: 10000 },
  { key: "batch_min_utilisation", label: "min. Belegung (0–1)", kind: "number",
    effective: (q) => String(q.policy.min_utilisation ?? ""), min: 0, max: 1, step: 0.05 },
  { key: "batch_max_age_minutes", label: "max. Wartezeit (min)", kind: "number",
    effective: (q) => String(q.policy.max_age_minutes ?? ""), min: 0, max: 43200 },
  { key: "batch_due_lead_hours", label: "Vorlauf vor Zusage (h)", kind: "number",
    effective: (q) => String(q.policy.due_lead_hours ?? ""), min: 0, max: 720 },
  { key: "batch_max_plates_per_run", label: "Platten je Lauf (0 = aus)", kind: "number",
    effective: (q) => String(q.policy.max_plates_per_run ?? ""), min: 0, max: 500 },
  { key: "batch_max_orders_per_work_order", label: "Aufträge je Innenauftrag (0 = aus)", kind: "number",
    effective: (q) => String(q.policy.max_orders_per_work_order ?? ""), min: 0, max: 100 },
  { key: "batch_max_plates_per_work_order", label: "Platten je Innenauftrag (0 = aus)", kind: "number",
    effective: (q) => String(q.policy.max_plates_per_work_order ?? ""), min: 0, max: 200 },
  { key: "nest_gap_mm", label: "Teileabstand (mm)", kind: "number",
    effective: (q) => (q.nest.gap != null ? String(q.nest.gap) : "erbt"), min: 0, step: 0.5,
    hint: "leer = erbt (Kerf/Steg des Werkstoffs)" },
  { key: "nest_margin_mm", label: "Randabstand (mm)", kind: "number",
    effective: (q) => (q.nest.margin != null ? String(q.nest.margin) : "erbt"), min: 0, step: 0.5,
    hint: "leer = erbt" },
];

export default function SammellaufPanel() {
  const [q, setQ] = useState<QueueView | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [openWos, setOpenWos] = useState<OpenWorkOrder[] | null>(null);
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [qq, st, rr, ss, ow] = await Promise.all([
        api<QueueView>("/api/production/queue"),
        api<Stats>("/api/admin/stats"),
        api<RunRow[]>("/api/production/runs?limit=10"),
        api<SettingRow[]>("/api/admin/settings"),
        api<OpenWorkOrder[]>("/api/production/work-orders?status=open&limit=200"),
      ]);
      setQ(qq); setStats(st); setRuns(rr); setOpenWos(ow);
      const map: Record<string, string> = {};
      for (const r of ss) map[r.key] = r.value;
      setRaw(map);
      setError("");
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !q) return <SectionError message={error} onRetry={load} />;
  if (!q || !stats || !runs || !openWos) return <SectionLoading />;

  return (
    <div>
      <KpiRow q={q} stats={stats} />

      <SchedulerCard q={q} reload={load} />

      <div className="sl-grid">
        <GlobalRulesCard q={q} raw={raw} reload={load} />
        <QueueCard q={q} />
      </div>

      <RenestCard wos={openWos} reload={load} />

      <div className="sl-section">
        <h2>Freigaberegeln je Werkstoff</h2>
        <p className="sub">
          Ausnahmen von den globalen Regeln — volle Verwaltung in der Disposition, hier ebenso.
        </p>
        <PoliciesPanel />
      </div>

      <RunsCard runs={runs} />

      {/* Verlorene Läufe auffrischen, wenn das Fenster lange offen bleibt. */}
      <RefreshTicker onLoad={load} />
    </div>
  );
}

// --------------------------------------------------------------------------
function KpiRow({ q, stats }: { q: QueueView; stats: Stats }) {
  const s = q.scheduler;
  const saved = stats.saved_area_m2_30d;
  return (
    <KpiStrip label="Sammellauf" items={[
      { id: "takt", label: <>Taktgeber{q.policy.enabled && s.interval_minutes ? ` · ${s.interval_minutes} min` : ""}</>, primary: true,
        value: s.last_error ? "Fehler" : q.policy.enabled ? "an" : "aus",
        tone: s.last_error ? "danger" : q.policy.enabled ? "success" : "warning" },
      { id: "next", label: "Bis zum nächsten Lauf", primary: true,
        value: q.policy.enabled ? "läuft" : "—",
        display: q.policy.enabled ? <span className="sl-kpi-countdown"><Countdown next={s.next_run_at} /></span> : undefined,
        sub: q.policy.enabled ? undefined : "Taktgeber aus" },
      { id: "wait", label: "Teile wartend", value: q.waiting_parts, primary: true,
        sub: plural(q.waiting_positions, "Position", "Positionen") },
      { id: "buckets", label: "Eimer bereit / sammeln", value: `${q.ready.length} / ${q.held.length}`, primary: true,
        tone: q.ready.length ? "success" : "none" },
      { id: "wo", label: "Innenaufträge offen / läuft", value: stats.work_orders_open + stats.work_orders_running,
        sub: `${stats.work_orders_open} / ${stats.work_orders_running}` },
      { id: "saved", label: "Gespart (30 Tage)", value: m2(saved), tone: "success",
        sub: `${stats.runs_30d} Läufe · ${fmtPoints(stats.saved_pct_30d)} Flächenersparnis` },
    ]} />
  );
}

function Countdown({ next }: { next: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!next) return <span className="sub">—</span>;
  const diff = new Date(next).getTime() - now;
  if (diff <= 0) return <span className="sl-due">jetzt fällig</span>;
  const total = Math.floor(diff / 1000);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const text = hh > 0
    ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${mm}:${String(ss).padStart(2, "0")}`;
  return <span className="mono">{text}</span>;
}

// --------------------------------------------------------------------------
function SchedulerCard({ q, reload }: { q: QueueView; reload: () => void }) {
  const s = q.scheduler;
  const [busy, setBusy] = useState("");
  const run = useBatchRun(reload);
  const [interval, setIntervalMin] = useState<number>(q.policy.interval_minutes);

  const putSetting = async (key: string, value: string) => {
    setBusy(key);
    try {
      await api(`/api/admin/settings/${encodeURIComponent(key)}`, {
        method: "PUT", body: JSON.stringify({ value }),
      });
      toastSuccess(`${key} auf „${value}" gesetzt.`);
      reload();
    } catch (e: any) { toastError(e.message); } finally { setBusy(""); }
  };

  const trigger = async (force: boolean) => {
    if (force && !window.confirm("Auch Gruppen schneiden, die noch sammeln? Das kann Einzelaufträge klein auf eigene Platten legen.")) return;
    try {
      const r = await startBatchRun<RunRow>(force);
      toastSuccess(`Sammellauf ${r.no} (${runEngineText(r.engine_version, r.n_plates)}): ${plural(r.n_work_orders, "Innenauftrag", "Innenaufträge")}, ${plural(r.n_plates, "Platte", "Platten")}, ${plural(r.n_parts, "Teil", "Teile")} — ${m2(r.saved_area_m2)} gespart.`);
    } catch (e: any) { toastError(e.message); }
    reload();
  };

  return (
    <Callout
      intent={s.last_error ? "danger" : q.policy.enabled ? "success" : "warning"}
      icon={s.last_error ? "error" : s.running ? "time" : "pause"}
      style={{ margin: "0 0 16px" }}
      title={s.last_error ? "Sammellauf meldet einen Fehler"
           : q.policy.enabled ? `Taktgeber läuft — alle ${q.policy.interval_minutes} Minuten`
           : "Taktgeber steht — es wird nur von Hand gesammelt"}
    >
      <div className="sl-scheduler">
        <div className="sl-scheduler-status">
          <Switch
            checked={q.policy.enabled}
            disabled={busy === "batch_enabled"}
            onChange={(e) => putSetting("batch_enabled", (e.target as HTMLInputElement).checked ? "true" : "false")}
            labelElement={<b>Sammellauf aktiv</b>}
          />
          <div className="sl-interval">
            <NumericInput
              value={interval} min={1} max={10080} stepSize={5} buttonPosition="none"
              disabled={busy === "batch_interval_minutes"}
              onValueChange={(v) => setIntervalMin(Math.round(v))}
            />
            <span className="sub">Minuten</span>
            <Button
              small icon="tick" text="Takt setzen" loading={busy === "batch_interval_minutes"}
              disabled={interval === q.policy.interval_minutes}
              onClick={() => putSetting("batch_interval_minutes", String(interval))}
            />
          </div>
          <div className="sl-trigger">
            <Button intent="primary" icon="play" text="Jetzt sammeln" loading={run.running && !run.force}
                    disabled={run.running} onClick={() => trigger(false)} />
            <Button intent="danger" minimal icon="fast-forward" text="Alles schneiden (auch sammelnde)"
                    loading={run.running && run.force} disabled={run.running} onClick={() => trigger(true)} />
          </div>
          <BatchRunBar run={run} />
        </div>
        <div className="sl-scheduler-meta sub">
          Zuletzt: {fmtDateTime(s.last_run_at)}{s.last_run_no ? ` · ${s.last_run_no}` : ""}
          {" · "}Nächster Takt: {q.policy.enabled ? fmtDateTime(s.next_run_at) : "— (aus)"}
          {s.last_error && <div className="sl-error-inline"><b>Fehler:</b> {s.last_error}</div>}
        </div>
      </div>
    </Callout>
  );
}

// --------------------------------------------------------------------------
function GlobalRulesCard({ q, raw, reload }: { q: QueueView; raw: Record<string, string>; reload: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const loadedOnce = useRef(false);

  // Entwürfe nur beim ersten Laden seeden — sonst überschreibt jede
  // Aktualisierung die halb getippte Eingabe des Bedieners.
  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    const seed: Record<string, string> = {};
    for (const def of SETTING_DEFS) {
      if (def.key === "nest_gap_mm" || def.key === "nest_margin_mm") {
        seed[def.key] = raw[def.key] ?? ""; // leer heißt hier bewusst „erbt"
      } else {
        seed[def.key] = raw[def.key] ?? "";
      }
    }
    setDraft(seed);
  }, [raw]);

  const dirty = SETTING_DEFS.filter((d) => {
    const cur = draft[d.key];
    return cur !== undefined && cur !== (raw[d.key] ?? "");
  });

  const save = async () => {
    setBusy(true);
    let failed = 0;
    for (const d of dirty) {
      try {
        await api(`/api/admin/settings/${encodeURIComponent(d.key)}`, {
          method: "PUT", body: JSON.stringify({ value: draft[d.key] }),
        });
      } catch (e: any) {
        failed += 1;
        toastError(`${d.key}: ${e.message}`);
      }
    }
    setBusy(false);
    if (!failed) toastSuccess(dirty.length === 1 ? "Einstellung gespeichert." : `${dirty.length} Einstellungen gespeichert.`);
    reload();
  };

  const setMixed = async (on: boolean) => {
    try {
      await api("/api/admin/settings/batch_mixed_formats", {
        method: "PUT", body: JSON.stringify({ value: on ? "true" : "false" }),
      });
      toastSuccess(`Gemischte Formate ${on ? "an" : "aus"}.`);
      reload();
    } catch (e: any) { toastError(e.message); }
  };

  return (
    <details className="sl-card">
      <summary className="sl-card-head">
        <h2>Globale Betriebsparameter</h2>
        <span className="sub">Aufklappen, um die Vorgaben für alle Läufe zu ändern</span>
      </summary>
      <div className="sl-card-head" style={{ marginTop: 10 }}>
        <Switch
          checked={q.policy.mixed_formats}
          onChange={(e) => setMixed((e.target as HTMLInputElement).checked)}
          label="Gemischte Formate je Innenauftrag"
        />
      </div>
      <div className="sl-settings-grid">
        {SETTING_DEFS.map((def) => {
          const placeholder = def.effective ? def.effective(q) : "";
          if (def.kind === "select") {
            return (
              <label key={def.key} className="sl-field">
                <span>{def.label}</span>
                <HTMLSelect
                  value={draft[def.key] ?? def.options?.[0]?.value ?? ""}
                  onChange={(e) => setDraft({ ...draft, [def.key]: e.currentTarget.value })}
                >
                  {(def.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </HTMLSelect>
                {placeholder && <span className="sl-effective">greift: {placeholder}</span>}
              </label>
            );
          }
          return (
            <label key={def.key} className="sl-field">
              <span>{def.label}</span>
              <NumericInput
                fill value={draft[def.key] ?? ""} min={def.min} max={def.max}
                stepSize={def.step ?? 1} buttonPosition="none"
                // Gespeicherte Werte sind genauer als der Pfeilschritt (z. B. 0,7777).
                minorStepSize={Math.min(def.step ?? 1, 0.0001)}
                placeholder={placeholder}
                onValueChange={(v) => setDraft({ ...draft, [def.key]: Number.isFinite(v) ? String(v) : "" })}
              />
              {def.hint && <span className="sl-effective">{def.hint}</span>}
            </label>
          );
        })}
      </div>
      <div className="sl-card-foot">
        <span className="sub">
          Leere Zahlenfelder gelten als „nicht gesetzt" — es greift der eingebautere Default.
          Serverseitig geprüft: ungültige Werte weist die API ab.
        </span>
        <Button
          intent="primary" icon="floppy-disk" loading={busy}
          disabled={!dirty.length}
          text={dirty.length === 1 ? "1 Änderung speichern" : `${dirty.length} Änderungen speichern`}
          onClick={save}
        />
      </div>
    </details>
  );
}

// --------------------------------------------------------------------------
function QueueCard({ q }: { q: QueueView }) {
  return (
    <div className="sl-card">
      <div className="sl-card-head">
        <h2>Warteschlange</h2>
        <span className="sub">der nächste Takt schneidet „bereit"</span>
      </div>

      <h3 className="sl-subhead">Bereit ({q.ready.length})</h3>
      {q.ready.length === 0 ? (
        <p className="sub">Kein Eimer ist bereit — alles sammelt noch.</p>
      ) : (
        <div className="table-scroll">
        <HTMLTable className="data-table sl-bucket" compact>
          <thead>
            <tr><th>Werkstoff</th><th className="num">Dicke</th><th>Kunde</th><th className="num">Teile</th>
                <th className="num">Platten</th><th className="num">Belegung</th><th>Grund</th></tr>
          </thead>
          <tbody>
            {q.ready.map((b, i) => (
              <tr key={`r-${b.mat}-${b.thk}-${i}`} className="sl-row-ready">
                <td><b>{b.mat}</b></td>
                <td className="num">{b.thk} mm</td>
                <td>{b.customer || "—"}</td>
                <td className="num">{b.n_parts}</td>
                <td className="num">{b.n_plates}</td>
                <td className="num">{pct(b.utilisation)}</td>
                <td><Tag minimal intent="success">{b.reason}</Tag></td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
        </div>
      )}

      <h3 className="sl-subhead">Hält noch ({q.held.length})</h3>
      {q.held.length === 0 ? (
        <p className="sub">Nichts wartet.</p>
      ) : (
        <div className="table-scroll">
        <HTMLTable className="data-table sl-bucket" compact>
          <thead>
            <tr><th>Werkstoff</th><th className="num">Dicke</th><th>Kunde</th><th className="num">Teile</th>
                <th className="num">Pos.</th><th className="num">Aufträge</th><th>Geht von selbst</th></tr>
          </thead>
          <tbody>
            {q.held.map((b, i) => (
              <tr key={`h-${b.mat}-${b.thk}-${i}`}>
                <td><b>{b.mat}</b></td>
                <td className="num">{b.thk} mm</td>
                <td>{b.customer || "—"}</td>
                <td className="num">{b.n_pieces}</td>
                <td className="num">{b.n_positions}</td>
                <td className="num">{b.n_orders}</td>
                <td className="sub">
                  {fmtDateTime(b.releases_at)}
                  {b.reason && <div>{b.reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Neu schachteln — der Knopf für den Moment, in dem ein Parameter sich ändert.
// Offene Innenaufträge wurden mit den Werten von gestern geplant; nur wer
// nichts geschnitten hat, darf neu geplant werden. Läuft oder fertig ist
// eingefroren — die Zeichnung an der Maschine bleibt die Wahrheit.
// --------------------------------------------------------------------------
function RenestCard({ wos, reload }: { wos: OpenWorkOrder[]; reload: () => void }) {
  const [busy, setBusy] = useState("");

  const renest = async (nos: string[] | null, what: string) => {
    setBusy(nos ? nos.join(",") : "all");
    try {
      const r = await api<RunRow>("/api/production/renest", {
        method: "POST",
        body: JSON.stringify({ work_order_nos: nos }),
      });
      toastSuccess(
        `Neu geschachtelt (${what}): Lauf ${r.no} — ${plural(r.n_work_orders, "Innenauftrag", "Innenaufträge")}, ` +
        `${plural(r.n_plates, "Platte", "Platten")}, ${plural(r.n_parts, "Teil", "Teile")}.`,
      );
      reload();
    } catch (e: any) { toastError(e.message); } finally { setBusy(""); }
  };

  const renestOne = (wo: OpenWorkOrder) => {
    if (!window.confirm(
      `Innenauftrag ${wo.no} (${wo.mat_name || wo.mat} · ${wo.thk} mm, ` +
      `${plural(wo.n_plates, "Platte", "Platten")}, ${plural(wo.n_parts, "Teil", "Teile")}) zurück in die Warteschlange ` +
      `und mit den aktuellen Parametern neu schachteln?`,
    )) return;
    renest([wo.no], wo.no);
  };

  const renestAll = () => {
    if (!window.confirm(
      `Alle ${wos.length} offenen Innenaufträge zurückstellen und mit den ` +
      `aktuellen Parametern neu schachteln? Läufende und fertige bleiben unberührt.`,
    )) return;
    renest(null, "alle offenen");
  };

  return (
    <div className="sl-card" style={{ marginTop: 16 }}>
      <div className="sl-card-head">
        <h2>Neu schachteln</h2>
        <span className="sub">
          nach einer Parameteränderung — offene Innenaufträge mit den aktuellen Werten neu planen
        </span>
      </div>
      {wos.length === 0 ? (
        <p className="sub">Keine offenen Innenaufträge — nichts zu neu schachteln.</p>
      ) : (
        <>
          <p className="sub">
            Abstand, Rand, Beschnitt und Freigaberegel werden beim Neuplanen neu gelesen.
            Materialbuchung geht zurück; laufende und fertige Innenaufträge bleiben eingefroren.
          </p>
          <div className="table-scroll">
          <HTMLTable className="data-table" striped compact>
            <thead>
              <tr>
                <th>Innenauftrag</th><th>Werkstoff</th><th className="num">Dicke</th>
                <th className="num">Platten</th><th className="num">Teile</th>
                <th className="num">Aufträge</th><th className="num">Belegung</th>
                <th className="num">Angelegt</th><th><span className="sr-only">Aktion</span></th>
              </tr>
            </thead>
            <tbody>
              {wos.map((wo) => (
                <tr key={wo.no}>
                  <td className="mono"><b><RefLink kind="work_order" no={wo.no} /></b></td>
                  <td>{wo.mat_name || wo.mat}</td>
                  <td className="num">{wo.thk} mm</td>
                  <td className="num">{wo.n_plates}</td>
                  <td className="num">{wo.n_parts}</td>
                  <td className="num">{wo.n_orders}</td>
                  <td className="num">{pct(wo.utilisation)}</td>
                  <td className="num">{fmtDateTime(wo.created_at)}</td>
                  <td>
                    <Button small icon="refresh" text="Neu schachteln"
                            loading={busy === wo.no || busy === "all"}
                            disabled={!!busy}
                            onClick={() => renestOne(wo)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </HTMLTable>
          </div>
          <div className="sl-card-foot">
            <span className="sub">Wirkt nur auf „offen“ — nichts Geschnittenes wird angerührt.</span>
            <Button intent="warning" icon="refresh" text={`Alle offenen neu schachteln (${wos.length})`}
                    loading={busy === "all"} disabled={!!busy}
                    onClick={renestAll} />
          </div>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
function RunsCard({ runs }: { runs: RunRow[] }) {
  return (
    <div className="sl-section">
      <div className="sl-card-head">
        <h2>Letzte Läufe ({runs.length})</h2>
        <span className="sub">„gespart" = Plattenfläche gegenüber Einzelfertigung je Auftrag</span>
      </div>
      {runs.length === 0 ? (
        <p className="sub">Noch kein Sammellauf gelaufen.</p>
      ) : (
        <div className="table-scroll">
        <HTMLTable className="data-table" striped compact>
          <thead>
            <tr>
              <th>Lauf</th><th>Gestartet</th><th>Auslöser</th><th>Rechenkern</th>
              <th className="num">Innenaufträge</th><th className="num">Platten</th><th className="num">Teile</th>
              <th className="num">Material gespart</th><th>Bestand</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.no}>
                <td className="mono"><b>{r.no}</b></td>
                <td>{fmtDateTime(r.started_at)}</td>
                <td><Tag minimal intent={r.trigger === "manual" ? "primary" : r.trigger === "renest" ? "warning" : "none"}>{r.trigger}</Tag></td>
                <td><Tag minimal intent={runEngineKind(r.engine_version, r.n_plates) === "kerf" ? "success" : "none"}>{runEngineText(r.engine_version, r.n_plates)}</Tag></td>
                <td className="num">{r.n_work_orders}</td>
                <td className="num">{r.n_plates}</td>
                <td className="num">{r.n_parts}</td>
                <td className="num sl-saved-num">{m2(r.saved_area_m2)} <span className="sub">({fmtPoints(r.saved_pct)})</span></td>
                <td>
                  {r.n_open > 0 && <Tag minimal>offen {r.n_open}</Tag>}
                  {r.n_running > 0 && <Tag minimal intent="primary">läuft {r.n_running}</Tag>}
                  {r.n_done > 0 && <Tag minimal intent="success">fertig {r.n_done}</Tag>}
                  {r.n_cancelled > 0 && <Tag minimal intent="danger">storniert {r.n_cancelled}</Tag>}
                </td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
        </div>
      )}
    </div>
  );
}

/** Einmal pro Minute die Läufe-Liste nachziehen — der 15-Sekunden-Takt des
    Panels deckt Queue und Stats ab; hier geht es nur ums Gedächtnis. */
function RefreshTicker({ onLoad }: { onLoad: () => void }) {
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) onLoad(); }, 60_000);
    return () => clearInterval(t);
  }, [onLoad]);
  return null;
}
