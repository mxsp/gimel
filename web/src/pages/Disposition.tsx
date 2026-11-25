import { Button, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, HTMLTable, Spinner, Switch, Tab, Tabs, Tag } from "@blueprintjs/core";
import NonIdealState from "../components/NonIdealState";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api, asUtc, fmtDateTime, fmtM2, fmtPoints } from "../api";
import PoliciesPanel from "../components/PoliciesPanel";
import PlanOptions from "../components/PlanOptions";
import BatchRunBar from "../components/BatchRunBar";
import BucketPanel, { Bucket, pct } from "../components/BucketPanel";
import { EmptyNote, SectionError, SectionLoading } from "../components/PageStates";
import { startBatchRun, useBatchRun } from "../batchRun";
import { navigate, useHashRoute } from "../router";
import { engineInfo, engineText, runEngineKind, runEngineText } from "../engine";
import { workOrderStatus } from "../status";
import { RefLink } from "../components/RefLink";
import { toastError, toastInfo, toastSuccess } from "../toast";
import { plural } from "../plural";
import {
  Drawer as UiDrawer, FilterGroup, FilterPopover, FilterTag,
  PageFrame, StatusChip, Toolbar,
} from "../ui";
import type { StatusItem } from "../ui";
import { MatName } from "../components/MaterialSelect";
import ProductionFlowGraph from "../components/ProductionFlowGraph";

/* Disposition — der Leitstand des Sammellaufs.

   Die Seite beantwortet drei Fragen, ohne dass man sie verlassen muss: was geht
   als Nächstes heraus, warum liegt der Rest noch, und was kostet es, ihn jetzt
   zu schneiden. Gründe und Zeiten kommen aus derselben Rechnung wie der Lauf
   (/api/production/queue). Eine Regel, deren Entscheidung man nicht nachlesen
   kann, wird beim ersten Zweifel abgeschaltet. */

interface Scheduler {
  running: boolean; last_run_at: string | null; last_run_no: string | null;
  last_error: string | null; next_run_at: string | null; interval_minutes: number;
}
interface PendingCustomer {
  id: number; name: string; n_parts: number; n_orders: number;
}
interface QueueView {
  waiting_positions: number; waiting_parts: number;
  ready: Bucket[]; held: Bucket[];
  customers?: PendingCustomer[];
  policy?: { group_by?: string };
  scheduler: Scheduler;
  engine?: string; engine_version?: string;
}
interface RunRow {
  no: string; started_at: string; finished_at: string | null; trigger: string;
  engine_version: string; note: string;
  n_orders: number; n_positions: number; n_parts: number;
  n_work_orders: number; n_plates: number;
  solo_area_m2: number; batch_area_m2: number; saved_area_m2: number; saved_pct: number;
  n_open: number; n_running: number; n_done: number; n_cancelled: number;
}
interface RunWorkOrder { no: string; mat: string; thk: number; n_plates: number; n_parts: number; utilisation: number; status: string }

const TRIGGER: Record<string, string> = { manual: "von Hand", interval: "Takt", renest: "neu geschachtelt", auswahl: "einzelner Eimer" };
const HORIZON_H = 48;
const CLOCK = { age: "Wartezeit", due: "Zusage" };

const atMs = (iso: string | null | undefined) => (iso ? new Date(asUtc(iso)).getTime() : null);

/** „in 3 h 20 min" — für Fristen, die man ohne Kopfrechnen lesen will. */
function fromNow(ms: number | null, now: number): string {
  if (ms === null) return "—";
  const min = Math.round((ms - now) / 60000);
  if (min <= 0) return "jetzt";
  if (min < 60) return `in ${min} min`;
  if (min < 600) return `in ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
  if (min < 2880) return `in ${Math.round(min / 60)} h`;
  return `in ${Math.round(min / 1440)} Tagen`;
}

export default function Disposition({ role }: { role: string }) {
  const route = useHashRoute();
  const wantedRun = decodeURIComponent(route.split("/")[1] ?? "");
  const [tab, setTab] = useState(() => (wantedRun ? "laeufe" : "takt"));
  const [settings, setSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState("regeln");
  useEffect(() => { if (wantedRun) setTab("laeufe"); }, [wantedRun]);
  return (
    <PageFrame
      title="Disposition"
      sub="Was als Nächstes geschnitten wird, warum der Rest noch sammelt und was es kostet, nicht zu warten."
      actions={<Button icon="cog" text="Optionen" onClick={() => setSettings(true)} />}
    >
      <Tabs id="dispo" selectedTabId={tab} onChange={(t) => setTab(String(t))} large renderActiveTabPanelOnly>
        <Tab id="takt" title="Leitstand" panel={<QueuePanel />} />
        <Tab id="fluss" title="Produktionsfluss" icon="flow-branch" panel={<ProductionFlowGraph />} />
        <Tab id="laeufe" title="Verlauf" icon="history" panel={<RunsPanel wantedRun={wantedRun} />} />
      </Tabs>

      <UiDrawer
        open={settings}
        onClose={() => setSettings(false)}
        title="Optionen"
        sub="Freigaberegeln und Planungsparameter — sie gelten für den nächsten Sammellauf."
        width="min(860px, 100vw)"
      >
        <Tabs id="dispo-settings" selectedTabId={settingsTab}
              onChange={(t) => setSettingsTab(String(t))} renderActiveTabPanelOnly>
          <Tab id="regeln" title="Freigaberegeln" panel={<PoliciesPanel />} />
          <Tab id="optionen" title="Planungsparameter"
               panel={<PlanOptions scope="all" canEdit={role === "admin"} />} />
        </Tabs>
      </UiDrawer>
    </PageFrame>
  );
}

// --------------------------------------------------------------------------
function QueuePanel() {
  const [q, setQ] = useState<QueueView | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Bucket | null>(null);
  const [askNow, setAskNow] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try { setQ(await api<QueueView>("/api/production/queue")); setError(""); setNow(Date.now()); }
    catch (e: any) { setError(e.message ?? String(e)); }
  }, []);

  const run = useBatchRun(load);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 15000);   // der Takt läuft weiter, auch wenn niemand klickt
    return () => clearInterval(t);
  }, [load]);

  if (error && !q) return <SectionError message={error} onRetry={load} />;
  if (!q) return <SectionLoading />;
  const s = q.scheduler;
  const next = atMs(s.next_run_at);
  const nextOut = q.held.map((b) => atMs(b.releases_at)).filter((v): v is number => v !== null).sort((a, b) => a - b)[0] ?? null;
  const idle = !q.ready.length && !q.held.length;

  return (
    <div className="dispo">
      <section className="dispo-clock" data-state={s.last_error ? "error" : s.running ? "run" : "stop"} aria-label="Taktgeber">
        <div className="dispo-clock-main">
          <span className="dispo-clock-state">{s.last_error ? "Taktgeber meldet einen Fehler" : s.running ? `Taktgeber läuft · alle ${s.interval_minutes} min` : "Taktgeber steht"}</span>
          <span className="dispo-clock-next">{s.running ? `Nächster Takt ${fromNow(next, now)}` : "Es wird nur von Hand geschnitten"}</span>
          <span className="sub">
            Letzter Takt {fmtDateTime(s.last_run_at)}{s.last_run_no ? ` · ${s.last_run_no}` : ""}
            {q.engine_version ? ` · Rechenkern ${engineText(q.engine_version)}` : ""}
            {q.policy?.group_by === "customer" ? " · nur je Kunde" : ""}
          </span>
          {s.last_error && <span className="dispo-error">{s.last_error}</span>}
        </div>
        <div className="dispo-clock-actions">
          <Button intent="primary" icon="cut" text="Jetzt schachteln…"
                  disabled={run.running || idle} onClick={() => setAskNow(true)} />
        </div>
      </section>

      <BatchRunBar run={run} />

      <div className="ui-facts" role="group" aria-label="Leitstand in Zahlen">
        <div className="ui-fact">
          <span className="ui-fact-label">Bereit</span>
          <span className="ui-fact-value">{q.ready.length}</span>
          <span className="sub">{plural(q.ready.length, "Eimer", "Eimer")}</span>
        </div>
        <div className="ui-fact">
          <span className="ui-fact-label">Sammelt</span>
          <span className="ui-fact-value">{q.held.length}</span>
          <span className="sub">{plural(q.held.length, "Eimer", "Eimer")}</span>
        </div>
        <div className="ui-fact">
          <span className="ui-fact-label">Wartet</span>
          <span className="ui-fact-value">{q.waiting_parts}</span>
          <span className="sub">Teile in {plural(q.waiting_positions, "Position", "Positionen")}</span>
        </div>
        <div className="ui-fact">
          <span className="ui-fact-label">Nächste Freigabe</span>
          <span className="ui-fact-value">{nextOut === null ? "—" : fromNow(nextOut, now)}</span>
          <span className="sub">spätestens, von selbst</span>
        </div>
      </div>

      {idle ? (
        <NonIdealState icon="tick-circle" title="Nichts wartet"
                       description="Alle freigegebenen Aufträge sind geschnitten oder eingeplant."
                       action={<Button text="Zu den Aufträgen" onClick={() => navigate("auftraege")} />} />
      ) : (
        <>
          {q.held.length > 0 && <Horizon held={q.held} now={now} onOpen={setOpen} />}
          <div className="dispo-board">
            <section aria-labelledby="dispo-ready">
              <h2 id="dispo-ready">Bereit <span className="dispo-count">{q.ready.length}</span></h2>
              <p className="sub">Der nächste Takt schneidet das.</p>
              {q.ready.length === 0
                ? <EmptyNote>Kein Eimer ist bereit. Alles sammelt noch.</EmptyNote>
                : q.ready.map((b, i) => <BucketCard key={`r-${b.mat}-${b.thk}-${i}`} b={b} now={now} onOpen={setOpen} />)}
            </section>
            <section aria-labelledby="dispo-held">
              <h2 id="dispo-held">Sammelt <span className="dispo-count">{q.held.length}</span></h2>
              <p className="sub">Wartet auf eine volle Platte oder eine Frist.</p>
              {q.held.length === 0
                ? <EmptyNote>Nichts sammelt.</EmptyNote>
                : q.held.map((b, i) => <BucketCard key={`h-${b.mat}-${b.thk}-${i}`} b={b} now={now} onOpen={setOpen} />)}
            </section>
          </div>
          <p className="sub dispo-foot">
            Die Grenzen stehen unter „Optionen" → „Freigaberegeln".
          </p>
        </>
      )}

      <BucketPanel bucket={open} runEngine={q.engine_version ?? ""} onClose={() => setOpen(null)} onCut={load} />

      <NestNowDialog q={q} isOpen={askNow} onClose={() => setAskNow(false)} onDone={load} />
    </div>
  );
}

/** Der ausdrückliche Lauf: Umfang, Kunde und Kundentrennung in einem Schritt.

    Die schnellen Knöpfe bleiben daneben für den Alltag; dieser Dialog ist für
    den Fall, dass jemand weiß, *was* jetzt geschnitten werden soll. */
function NestNowDialog({ q, isOpen, onClose, onDone }: {
  q: QueueView; isOpen: boolean; onClose: () => void; onDone: () => void;
}) {
  const [scope, setScope] = useState<"ready" | "all">("ready");
  const [customer, setCustomer] = useState<string>("all");
  const [groupBy, setGroupBy] = useState<"material" | "customer">(
    q.policy?.group_by === "customer" ? "customer" : "material",
  );
  const [busy, setBusy] = useState(false);
  const customers = q.customers ?? [];
  const chosen = customers.find((c) => String(c.id) === customer);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await startBatchRun<RunRow>(scope === "all", undefined, {
        customerIds: customer === "all" ? undefined : [Number(customer)],
        groupBy,
      });
      if (r.n_plates > 0) {
        toastSuccess(`Sammellauf ${r.no} (${runEngineText(r.engine_version, r.n_plates)}): ` +
          `${plural(r.n_work_orders, "Innenauftrag", "Innenaufträge")}, ` +
          `${plural(r.n_plates, "Platte", "Platten")} — ${fmtM2(r.saved_area_m2)} gespart.`);
      } else {
        toastInfo(`Sammellauf ${r.no}: nichts zu schneiden. ${r.note || ""}`.trim());
      }
      onClose();
    } catch (e: any) {
      toastError(e.message ?? String(e));
    } finally {
      setBusy(false);
      onDone();
    }
  };

  return (
    <Dialog isOpen={isOpen} onClose={busy ? undefined : onClose}
      title="Jetzt schachteln" icon="cut" className="dispo-nest-dialog">
      <DialogBody>
        <p className="sub" style={{ marginTop: 0 }}>
          Der Lauf rechnet mit den gespeicherten Parametern. „Bereit“ schneidet nur
          freigegebene Eimer; „alles Wartende“ nimmt auch sammelnde Eimer mit.
        </p>
        <FormGroup label="Umfang">
          <HTMLSelect fill value={scope} onChange={(e) => setScope(e.currentTarget.value as "ready" | "all")}>
            <option value="ready">Bereite Eimer — die Freigaberegel entscheidet</option>
            <option value="all">Alles Wartende — auch sammelnde Eimer schneiden</option>
          </HTMLSelect>
        </FormGroup>
        <FormGroup label="Kunde">
          <HTMLSelect fill value={customer} onChange={(e) => setCustomer(e.currentTarget.value)}>
            <option value="all">Alle Kunden</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {plural(c.n_parts, "Teil", "Teile")} in {plural(c.n_orders, "Auftrag", "Aufträgen")}
              </option>
            ))}
          </HTMLSelect>
        </FormGroup>
        <FormGroup label="Auf die Platte">
          <HTMLSelect fill value={groupBy} onChange={(e) => setGroupBy(e.currentTarget.value as "material" | "customer")}>
            <option value="material">Kunden mischen — beste Plattenausnutzung</option>
            <option value="customer">Nur je Kunde — keine Kunden auf einer Platte</option>
          </HTMLSelect>
        </FormGroup>
        <p className="sub">
          {chosen
            ? `Auswahl: ${chosen.name} · ${plural(chosen.n_parts, "Teil", "Teile")} in ${plural(chosen.n_orders, "Auftrag", "Aufträgen")}.`
            : `Auswahl: alle Kunden · ${plural(q.waiting_parts, "Teil", "Teile")} warten.`}
        </p>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button text="Abbrechen" disabled={busy} onClick={onClose} />
            <Button intent="primary" icon="cut" text="Jetzt schachteln" loading={busy}
              onClick={() => void submit()} />
          </>
        }
      />
    </Dialog>
  );
}

/** Die nächsten 48 Stunden: wann jeder Eimer spätestens von selbst herausgeht. */
function Horizon({ held, now, onOpen }: { held: Bucket[]; now: number; onOpen: (b: Bucket) => void }) {
  const rows = useMemo(() => [...held].sort((a, b) =>
    (atMs(a.releases_at) ?? Infinity) - (atMs(b.releases_at) ?? Infinity)), [held]);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <section className="dispo-horizon" aria-labelledby="dispo-horizon">
      <h2 id="dispo-horizon">Die nächsten {HORIZON_H} Stunden</h2>
      <div className="dispo-axis" aria-hidden="true">
        {[0, 12, 24, 36, 48].map((h) => <span key={h} style={{ left: `${(h / HORIZON_H) * 100}%` }}>{h ? `+${h} h` : "jetzt"}</span>)}
      </div>
      <ul className="dispo-lanes">
        {shown.map((b, i) => {
          const at = atMs(b.releases_at);
          const h = at === null ? null : (at - now) / 3600000;
          const left = h === null ? 100 : Math.min(100, Math.max(0, (h / HORIZON_H) * 100));
          const clock = b.release_by ? CLOCK[b.release_by] : "";
          return (
            <li key={`${b.mat}-${b.thk}-${i}`}>
              <button type="button" className="dispo-lane" onClick={() => onOpen(b)}>
                <span className="dispo-lane-name"><b><MatName id={b.mat} /></b> {b.thk} mm</span>
                <span className="dispo-lane-track">
                  <span className="dispo-lane-span" style={{ width: `${left}%` }} />
                  {at !== null && (h as number) <= HORIZON_H && (
                    <span className={`dispo-lane-mark ${b.release_by ?? ""}`} style={{ left: `${left}%` }} />
                  )}
                </span>
                <span className="dispo-lane-when">
                  {at === null ? "keine Frist" : `${fromNow(at, now)}${clock ? ` · ${clock}` : ""}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {rows.length > 6 && <Button minimal small text={all ? "Weniger zeigen" : `Alle ${rows.length} zeigen`} onClick={() => setAll(!all)} />}
    </section>
  );
}

function BucketCard({ b, now, onOpen }: { b: Bucket; now: number; onOpen: (b: Bucket) => void }) {
  const ready = b.n_plates !== undefined;
  const limit = b.rule.min_utilisation;
  const fill = Math.min(1, b.fill);
  const at = atMs(b.releases_at);
  const primaryStatus = ready
    ? { label: "bereit", tone: "success" as const, icon: "tick" as const }
    : b.release_by === "due"
      ? { label: "Freigabe nach Zusage", tone: "warning" as const, icon: "calendar" as const }
      : b.release_by === "age"
        ? { label: "Freigabe nach Wartezeit", icon: "time" as const }
        : { label: "sammelt", icon: "layers" as const };
  return (
    <button type="button" className="dispo-card" onClick={() => onOpen(b)}>
      <span className="dispo-card-head">
        <span>
          <b><MatName id={b.mat} /></b> <span className="dispo-thk">{b.thk} mm</span>
          {b.customer && <span className="sub dispo-card-customer"> · {b.customer}</span>}
        </span>
        <StatusChip
          primary={primaryStatus}
          extras={[
            b.rush && { label: "Eilt", tone: "danger", icon: "flash" },
            b.rule.source !== "global" && { label: "eigene Regel", icon: "filter" },
          ]}
        />
      </span>
      <span className="dispo-gauge-row">
        <span className="sub">Beste Platte</span>
        <span className="num-inline"><b>{pct(b.fill)}</b> <span className="sub">von {pct(limit)}</span></span>
      </span>
      <span className="dispo-gauge" role="img" aria-label={`Beste Platte ${pct(b.fill)} belegt, voll ab ${pct(limit)}`}>
        <span className="dispo-gauge-fill" data-full={b.fill >= limit && limit > 0} style={{ width: `${fill * 100}%` }} />
        {limit > 0 && <span className="dispo-gauge-limit" style={{ left: `${limit * 100}%` }} />}
      </span>
      <span className="sub">
        {ready
          ? `${plural(b.n_orders, "Auftrag", "Aufträge")} · ${b.n_parts} Teile · ${plural(b.n_plates ?? 0, "Platte", "Platten")}`
          : `${plural(b.n_orders, "Auftrag", "Aufträge")} · ${b.n_pieces} Teile`}
      </span>
      {!ready && at !== null && (
        <span className="dispo-card-when">Spätestens {fromNow(at, now)} · {fmtDateTime(b.releases_at)}{b.release_by ? ` · ${CLOCK[b.release_by]}` : ""}</span>
      )}
    </button>
  );
}

// --------------------------------------------------------------------------
function RunsPanel({ wantedRun = "" }: { wantedRun?: string }) {
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(() => wantedRun || null);
  const [trig, setTrig] = useState("");
  const [engine, setEngine] = useState("");
  const [empty, setEmpty] = useState(false);
  useEffect(() => { if (wantedRun) setOpen(wantedRun); }, [wantedRun]);
  const load = useCallback(() => {
    // Der Takt legt auch leere Läufe an; mit 80 Zeilen sähe man oft nur diese.
    api<RunRow[]>("/api/production/runs?limit=400").then((r) => { setRows(r); setError(""); })
      .catch((e) => setError(e.message ?? String(e)));
  }, []);
  useEffect(load, [load]);
  if (error && !rows) return <SectionError message={error} onRetry={load} />;
  if (!rows) return <SectionLoading />;
  if (!rows.length) return <NonIdealState icon="history" title="Noch kein Sammellauf" />;

  const shown = rows.filter((r) => (empty || r.n_plates > 0 || r.no === wantedRun)
    && (!trig || r.trigger === trig)
    && (!engine || runEngineKind(r.engine_version, r.n_plates) === engine));
  const triggers = [...new Set(rows.map((r) => r.trigger))];
  const engines = [...new Set(rows.filter((r) => r.n_plates > 0).map((r) => runEngineKind(r.engine_version, r.n_plates)))];
  const saved = shown.reduce((sum, r) => sum + r.saved_area_m2, 0);
  const activeFilters = (trig ? 1 : 0) + (engine ? 1 : 0) + (empty ? 1 : 0);
  const clearFilters = () => { setTrig(""); setEngine(""); setEmpty(false); };

  return (
    <div>
      <Toolbar meta={plural(shown.length, "Lauf", "Läufe")}>
        <FilterPopover active={activeFilters} onClear={clearFilters} label="Filter">
          <FilterGroup label="Auslöser">
            <HTMLSelect value={trig} onChange={(e) => setTrig(e.currentTarget.value)}>
              <option value="">alle</option>
              {triggers.map((t) => <option key={t} value={t}>{TRIGGER[t] ?? t}</option>)}
            </HTMLSelect>
          </FilterGroup>
          <FilterGroup label="Rechenkern">
            <HTMLSelect value={engine} onChange={(e) => setEngine(e.currentTarget.value)}>
              <option value="">alle</option>
              {engines.map((t) => <option key={t} value={t}>{t === "kerf" ? "Kerf" : t}</option>)}
            </HTMLSelect>
          </FilterGroup>
          <FilterGroup label="Läufe">
            <Switch checked={empty} label="Leere Läufe zeigen" onChange={(e) => setEmpty(e.currentTarget.checked)} />
          </FilterGroup>
        </FilterPopover>
        {trig && <FilterTag label={TRIGGER[trig] ?? trig} onRemove={() => setTrig("")} />}
        {engine && <FilterTag label={engine === "kerf" ? "Kerf" : engine} onRemove={() => setEngine("")} />}
        {empty && <FilterTag label="Leere Läufe" onRemove={() => setEmpty(false)} />}
      </Toolbar>

      {shown.length === 0 ? <EmptyNote>Kein Lauf passt zu diesem Filter.</EmptyNote> : (
        <>
          <SavingsChart rows={shown} total={saved} onPick={setOpen} />
          <div className="dispo-table">
            <HTMLTable className="data-table" striped compact aria-label="Sammelläufe">
              <thead>
                <tr>
                  <th>Lauf</th><th>Gestartet</th><th>Auslöser</th><th>Rechenkern</th>
                  <th className="num">Innenaufträge</th><th className="num">Platten</th><th className="num">Teile</th>
                  <th className="num">Material gespart</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const eng = engineInfo(r.engine_version);
                  const isOpen = open === r.no;
                  const statusItems: StatusItem[] = [];
                  if (r.n_running > 0) statusItems.push({ label: `läuft ${r.n_running}`, tone: "primary", icon: "play" });
                  if (r.n_open > 0) statusItems.push({ label: `offen ${r.n_open}`, icon: "folder-open" });
                  if (r.n_done > 0) statusItems.push({ label: `fertig ${r.n_done}`, tone: "success", icon: "tick" });
                  if (r.n_cancelled > 0) statusItems.push({ label: `storniert ${r.n_cancelled}`, tone: "danger", icon: "cross" });
                  return (
                    <Fragment key={r.no}>
                      <tr className={isOpen ? "row-active" : undefined}>
                        <td className="mono nw">
                          <button type="button" className="row-toggle" aria-expanded={isOpen}
                                  aria-controls={`run-${r.no}`} onClick={() => setOpen(isOpen ? null : r.no)}>
                            <b>{r.no}</b>
                          </button>
                        </td>
                        <td className="nw">{fmtDateTime(r.started_at)}</td>
                        <td><Tag minimal intent={r.trigger === "manual" || r.trigger === "auswahl" ? "primary" : "none"}>{TRIGGER[r.trigger] ?? r.trigger}</Tag></td>
                        <td><Tag minimal intent={runEngineKind(r.engine_version, r.n_plates) === "kerf" ? "success" : "none"} title={r.n_plates > 0 ? eng.about || undefined : undefined}>{runEngineText(r.engine_version, r.n_plates)}</Tag></td>
                        <td className="num">{r.n_work_orders}</td>
                        <td className="num">{r.n_plates}</td>
                        <td className="num">{r.n_parts}</td>
                        <td className="num">
                          {fmtM2(r.saved_area_m2)}
                          {r.saved_pct > 0 && <span className="sub"> ({fmtPoints(r.saved_pct)})</span>}
                        </td>
                        <td>
                          <StatusChip primary={statusItems[0]} extras={statusItems.slice(1)} empty="—" />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr id={`run-${r.no}`} className="row-detail">
                          <td colSpan={9}><RunDetail r={r} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </HTMLTable>
          </div>
        </>
      )}
    </div>
  );
}

function RunDetail({ r }: { r: RunRow }) {
  const eng = engineInfo(r.engine_version);
  const [orders, setOrders] = useState<RunWorkOrder[] | null>(null);
  useEffect(() => {
    if (!r.n_work_orders) { setOrders([]); return; }
    let live = true;
    api<RunWorkOrder[]>(`/api/production/work-orders?run=${encodeURIComponent(r.no)}`)
      .then((o) => { if (live) setOrders(o); })
      .catch((e) => { if (live) { setOrders([]); toastError(e.message); } });
    return () => { live = false; };
  }, [r.no, r.n_work_orders]);
  return (
    <>
      <dl className="run-facts">
        <div><dt>Rechenkern</dt><dd>{runEngineText(r.engine_version, r.n_plates)}{r.n_plates > 0 && eng.about && <span className="sub"> — {eng.about}</span>}</dd></div>
        <div><dt>Plattenfläche einzeln</dt><dd className="num-inline">{fmtM2(r.solo_area_m2)}</dd></div>
        <div><dt>Plattenfläche im Sammellauf</dt><dd className="num-inline">{fmtM2(r.batch_area_m2)}</dd></div>
        <div><dt>Gespart</dt><dd className="num-inline">{fmtM2(r.saved_area_m2)}{r.saved_pct > 0 && ` (${fmtPoints(r.saved_pct)})`}</dd></div>
        <div><dt>Aufträge / Positionen</dt><dd className="num-inline">{r.n_orders} / {r.n_positions}</dd></div>
        <div><dt>Dauer</dt><dd className="num-inline">{r.finished_at
          ? `${Math.max(1, Math.round((new Date(asUtc(r.finished_at)).getTime() - new Date(asUtc(r.started_at)).getTime()) / 1000))} s` : "läuft"}</dd></div>
        {r.note && <div className="run-note"><dt>Notiz</dt><dd>{r.note}</dd></div>}
      </dl>
      {orders === null && <Spinner size={20} aria-label="Innenaufträge laden" />}
      {orders && orders.length > 0 && (
        <ul className="dispo-wos">
          {orders.map((w) => {
            const st = workOrderStatus(w.status);
            return (
              <li key={w.no} className="dispo-wo-row">
                <RefLink kind="work_order" no={w.no} />
                <span><MatName id={w.mat} /> · {w.thk} mm · {plural(w.n_plates, "Platte", "Platten")} · {w.n_parts} Teile · {pct(w.utilisation)}</span>
                <Tag minimal intent={st.intent}>{st.label}</Tag>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Eine Reihe: gesparte Fläche je Lauf, älteste links. Die Tabelle darunter trägt dieselben Zahlen. */
function SavingsChart({ rows, total, onPick }: { rows: RunRow[]; total: number; onPick: (no: string) => void }) {
  const bars = rows.filter((r) => r.n_plates > 0).slice(0, 40).reverse();
  const [hover, setHover] = useState<number | null>(null);
  if (!bars.length) return null;
  const top = Math.max(0.01, ...bars.map((r) => r.saved_area_m2));
  const h = hover === null ? null : bars[hover];
  return (
    <figure className="dispo-chart">
      <figcaption>
        <span className="dispo-chart-total">{fmtM2(total)}</span>
        <span className="sub"> Material gespart in {plural(rows.filter((r) => r.n_plates > 0).length, "Lauf", "Läufen")}</span>
      </figcaption>
      <div className="dispo-bars" role="img" aria-label={`Gesparte Fläche je Lauf, ${bars.length} Läufe, höchstens ${fmtM2(top)}`}
           onMouseLeave={() => setHover(null)}>
        {bars.map((r, i) => (
          <button key={r.no} type="button" className="dispo-bar" tabIndex={-1} aria-hidden="true"
                  onMouseEnter={() => setHover(i)} onClick={() => onPick(r.no)}>
            <span style={{ height: `${Math.max(2, (Math.max(0, r.saved_area_m2) / top) * 100)}%` }} />
          </button>
        ))}
      </div>
      <p className="dispo-chart-tip sub">
        {h ? `${h.no} · ${fmtDateTime(h.started_at)} · ${fmtM2(h.saved_area_m2)}${h.saved_pct > 0 ? ` (${fmtPoints(h.saved_pct)})` : ""}` : "Balken antippen öffnet den Lauf in der Tabelle."}
      </p>
    </figure>
  );
}
