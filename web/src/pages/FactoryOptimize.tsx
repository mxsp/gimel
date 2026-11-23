import { useCallback, useEffect, useMemo, useState } from "react";
import { More, PageFrame, Reason } from "../ui";
import {
  Button, Callout, Card, HTMLTable, Spinner, Tag,
} from "@blueprintjs/core";
import { api, fmtDateTime } from "../api";
import { navigate } from "../router";
import { toastError, toastSuccess } from "../toast";
import {
  FINDING_ICON, fmtMin, LOAD_STATE_LABEL, MACHINE_LABEL, MachineKind, StationRouting, TwinAnalysis,
  TwinFinding, TwinLoad,
} from "../factory";
import { useMaterialName } from "../components/MaterialSelect";
import { plural } from "../plural";
import StationControlBar from "../components/StationControlBar";

/* Optimierung — der Zwilling sagt, was die Halle besser macht.

   Der Grundriss zeigt, *wo etwas steht*, und diese Seite fragt, *was an der
   Halle zu ändern lohnt*. Die Befunde kommen aus dem Backend (services/
   twin_analysis.py) — jede Verlagerung ist dort durchgerechnet gegen dieselbe
   Eignungsprüfung wie die Zuordnung, nicht geschätzt.

   Ausführen tut diese Seite nichts. „Anwenden“ hängt einen Innenauftrag um —
   denselben Endpunkt wie von Hand — und der Rest ist Sicht. Eine Optimierung,
   die von selbst eingreift, wäre der Anfang vom Ende des Vertrauens. */

const SEVERITY: Record<string, { intent: any; label: string }> = {
  danger: { intent: "danger", label: "jetzt lösen" },
  warning: { intent: "warning", label: "lohnt sich" },
  info: { intent: "primary", label: "zur Kenntnis" },
  success: { intent: "success", label: "gut" },
};

const ROUTING_SHORT: Record<StationRouting, string> = {
  pull: "Pull",
  smart_suggest: "Vorschlag",
  smart_auto: "Automatik",
};

export default function FactoryOptimize() {
  const [data, setData] = useState<TwinAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [moved, setMoved] = useState<string[]>([]);
  const [sevFilter, setSevFilter] = useState<string>("all");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await api<TwinAnalysis>("/api/factory/twin/analysis"));
      setUpdatedAt(new Date());
      setError("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!silent) { setError(msg); toastError(msg); }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const applyMove = async (jobNo: string, stationId: number, label: string) => {
    setBusyJob(jobNo);
    try {
      await api(`/api/factory/work-orders/${jobNo}/assign`, {
        method: "POST",
        body: JSON.stringify({ station_id: stationId, note: "Ausgleich — Empfehlung des digitalen Zwillings" }),
      });
      toastSuccess(`${jobNo} → ${label}.`);
      setMoved((m) => [...m, jobNo]);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setBusyJob(null); }
  };

  const loads = useMemo(() => data?.loads ?? [], [data]);
  const maxRatio = useMemo(() => Math.max(1, ...loads.map((l) => l.ratio ?? 0)), [loads]);
  // Befunde nennen Stationen beim Namen, nicht bei der Nummer.
  const stationName = useCallback((id: number) => loads.find((l) => l.station_id === id)?.label ?? `Station ${id}`, [loads]);

  if (loading && !data) return <div className="twin-center"><Spinner size={36} /></div>;
  if (error && !data) return <div className="twin-center twin-error">{error}</div>;
  if (!data) return null;

  const sum = data.summary;
  const utilPct = sum.total_capacity_min > 0
    ? Math.round((sum.total_queue_min / sum.total_capacity_min) * 100)
    : 0;
  const visibleFindings = sevFilter === "all"
    ? data.findings
    : data.findings.filter((f) => f.severity === sevFilter);

  return (
    <PageFrame
      title="Optimierung"
      sub={
        <>
          Engpässe, Rüstwechsel und Auslastung der Fertigung
          {updatedAt && <> · aktualisiert {fmtDateTime(updatedAt.toISOString())}</>}
        </>
      }
      actions={
        <Button small icon="refresh" text="Neu rechnen" loading={loading} onClick={() => load()} />
      }
    >
      <StationControlBar active="optimierung" />

      <div className="ui-facts ls-facts" role="group" aria-label="Fertigungsauslastung">
        <div className={`ui-fact ${utilPct >= 95 ? "is-danger" : utilPct >= 75 ? "is-warning" : "is-accent"}`}>
          <span className="ui-fact-label">Gesamtauslastung</span>
          <span className="ui-fact-value">{utilPct} %</span>
          <span className="sub">{fmtMin(sum.total_queue_min)} / {fmtMin(sum.total_capacity_min)}</span>
        </div>
        <div className={`ui-fact ${sum.danger > 0 ? "is-danger" : "is-success"}`}>
          <span className="ui-fact-label">Kritische Befunde</span>
          <span className="ui-fact-value">{sum.danger}</span>
          <span className="sub">{sum.danger > 0 ? "sofort prüfen" : "keine Engpässe"}</span>
        </div>
        <div className={`ui-fact ${sum.warning > 0 ? "is-warning" : "is-info"}`}>
          <span className="ui-fact-label">Verbesserungen</span>
          <span className="ui-fact-value">{sum.warning}</span>
          <span className="sub">Rüst- und Lastausgleich</span>
        </div>
        <div className="ui-fact is-info">
          <span className="ui-fact-label">Ohne Maschine</span>
          <span className="ui-fact-value">{data.unassigned}</span>
          <span className="sub">{data.unassigned > 0 ? "noch nicht zugeordnet" : "alles verteilt"}</span>
        </div>
      </div>

      {sum.danger === 0 && sum.warning === 0 && (
        <Callout compact intent="success" icon="tick-circle" className="twin-note">
          Keine offenen Engpässe, keine unbearbeiteten Wechsel, keine gefährdeten
          Termine. Der Zwilling meldet sich wieder, wenn sich die Halle ändert.
        </Callout>
      )}

      {/* ------------------------------------------------ Auslastungstabelle */}
      <Card className="section-gap">
        <div className="card-title-row">
          <h2 className="card-title">Auslastung der Fertigung</h2>
          <span className="sub">Schlange gegen Tageskapazität — dieselben Zahlen, die die Zuordnung rechnet</span>
        </div>
        <div className="table-scroll">
        <HTMLTable compact className="data-table" striped>
          <thead>
            <tr><th>Station</th><th>Routing</th><th className="num">Schlange</th>
              <th className="num">Kapazität</th><th style={{ width: "34%" }}>Last</th>
              <th>Zustand</th><th>Rüstzustand</th></tr>
          </thead>
          <tbody>
            {loads.map((l) => (
              <LoadRow key={l.station_id} l={l} maxRatio={maxRatio}
                onOpen={() => l.station_id != null && navigate(`station/${l.station_id}`)} />
            ))}
            {!loads.length && <tr><td colSpan={7} className="sub">Keine aktive Fertigungsstation.</td></tr>}
          </tbody>
        </HTMLTable>
        </div>
      </Card>

      {/* -------------------------------------------------------- Befunde */}
      <div className="ui-section-head" style={{ marginTop: 14 }}>
        <h2 className="ui-section-title">Befunde ({visibleFindings.length})</h2>
        <div className="ls-opt-chips">
          {([
            ["all", `Alle (${data.findings.length})`],
            ["danger", `Kritisch (${sum.danger})`],
            ["warning", `Lohnt sich (${sum.warning})`],
            ["info", "Zur Kenntnis"],
          ] as Array<[string, string]>).map(([k, lbl]) => (
            <button key={k} type="button"
                    className={"filter-chip" + (sevFilter === k ? " filter-chip-on" : "")}
                    onClick={() => setSevFilter(k)}>
              {lbl}
            </button>
          ))}
        </div>
      </div>
      <div className="findings-grid">
        {visibleFindings.map((f, i) => (
          <FindingCard key={i} f={f} moved={moved} busyJob={busyJob}
            stationName={stationName}
            onMove={applyMove}
            onOpenStation={(id) => navigate(`station/${id}`)}
            onOpenJob={(no) => navigate(`produktion/${no}`)} />
        ))}
      </div>

      <More label="Wie die Befunde entstehen" less="Hinweis ausblenden">
        <p className="sub" style={{ marginTop: 16 }}>
          Alle Befunde sind Vorschläge mit nachlesbarer Rechnung — verlagert wird nur
          per Klick, und jede Verlagerung geht durch dieselbe Eignungsprüfung wie eine
          Zuordnung von Hand. Der Zwilling vergisst nichts, entscheidet aber nichts.
        </p>
      </More>
    </PageFrame>
  );
}

function LoadRow({ l, maxRatio, onOpen }: { l: TwinLoad; maxRatio: number; onOpen: () => void }) {
  const matName = useMaterialName();
  const width = ((l.ratio ?? 0) / maxRatio) * 100;
  const state = l.state;
  return (
    <tr onClick={onOpen} style={{ cursor: "pointer" }}>
      <td><b>{l.label}</b>
        <div className="sub">{l.machine_kind ? (MACHINE_LABEL[l.machine_kind as MachineKind] ?? l.machine_kind) : "—"}</div></td>
      <td><Tag minimal>{ROUTING_SHORT[l.routing as StationRouting] ?? l.routing}</Tag></td>
      <td className="num mono">{fmtMin(l.queue_min)}</td>
      <td className="num mono">{l.capacity > 0 ? fmtMin(l.capacity) : <span className="sub">—</span>}</td>
      <td>
        <div className="load-track">
          <div className={"load-fill" + (state === "over" ? " load-fill-over" : "")}
            style={{ width: `${Math.round(width)}%` }} />
        </div>
      </td>
      <td><Tag minimal intent={state === "over" ? "danger" : state === "warm" ? "warning" : state === "idle" ? "none" : "success"}>
        {LOAD_STATE_LABEL[state]}</Tag>
        <span className="sub" style={{ marginLeft: 6 }}>{plural(l.jobs, "Auftrag", "Aufträge")}</span></td>
      <td className="sub" title={l.last_mat || undefined}>{l.last_mat ? `${matName(l.last_mat)} ${l.last_thk ? `· ${String(l.last_thk).replace(".", ",")} mm` : ""}` : "kalt"}</td>
    </tr>
  );
}

function FindingCard({ f, moved, busyJob, stationName, onMove, onOpenStation, onOpenJob }: {
  f: TwinFinding; moved: string[]; busyJob: string | null;
  stationName: (id: number) => string;
  onMove: (jobNo: string, stationId: number, label: string) => void;
  onOpenStation: (id: number) => void;
  onOpenJob: (no: string) => void;
}) {
  const sev = SEVERITY[f.severity] ?? SEVERITY.info;
  return (
    <Card className={"finding-card finding-" + f.severity}>
      <div className="card-title-row">
        <h2 className="card-title">
          <span className={"bp5-icon-standard bp5-icon-" + (FINDING_ICON[f.kind] ?? "info-sign")} />
          {" "}{f.title}
        </h2>
        <Tag minimal intent={sev.intent}>{sev.label}</Tag>
      </div>
      <Reason className="sub finding-detail">{f.detail}</Reason>
      {f.metric && <div className="finding-metric mono">{f.metric}</div>}

      {f.moves.length > 0 && (
        <div className="finding-moves">
          <h3 className="files-sub">Verlagerungen, durchgerechnet</h3>
          <ul className="finding-moves-list">
            {f.moves.map((m) => (
              <li key={m.job_no} className={"finding-move" + (moved.includes(m.job_no) ? " is-done" : "")}>
                <div className="finding-move-head">
                  <b className="mono">{m.job_no}</b>
                  <span className="finding-move-route">{m.from_label} → <b>{m.label}</b></span>
                  <span className="mono finding-move-time">{fmtMin(m.minutes)}</span>
                  {moved.includes(m.job_no)
                    ? <Tag minimal intent="success">erledigt</Tag>
                    : <Button small intent="primary" icon="tick" text="Umhängen"
                        loading={busyJob === m.job_no}
                        onClick={() => onMove(m.job_no, m.station_id, m.label)} />}
                </div>
                <Reason className="finding-move-reason" lines={1} more="Rechnung anzeigen">{m.reason}</Reason>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(f.station_ids.length > 0 || f.job_nos.length > 0) && (
        <div className="finding-links">
          {f.station_ids.map((id) => (
            <Button key={id} small minimal icon="panel-stats" text={`${stationName(id)} öffnen`}
              onClick={() => onOpenStation(id)} />
          ))}
          {f.job_nos.length > 0 && (
            <Button small minimal icon="cut" text="Innenauftrag öffnen"
              onClick={() => onOpenJob(f.job_nos[0])} />
          )}
        </div>
      )}
    </Card>
  );
}
