import { useMemo, useState } from "react";
import { Button, Callout, Icon, IconName, InputGroup, Tag, Tooltip } from "@blueprintjs/core";
import { canAdminWork, getUser, isWorker } from "../../api";
import NonIdealState from "../NonIdealState";
import { FINDING_ICON, PlanSuggestion, Station, TYPE_LABEL, TwinFinding } from "../../factory";
import { plural } from "../../plural";
import { navigate } from "../../router";
import { Spoken } from "./Legend";
import { StatusGlyph } from "./StationShape";
import { StationMark } from "./marks";
import { useDetail } from "../../ui/detail";

/** Die Begründung eines Vorschlags: in „Alles" sichtbar, in „Einfach" auf Klick (Aufgabe 35 E). */
function Reason({ text }: { text: string }) {
  const { simple } = useDetail();
  const [open, setOpen] = useState(false);
  if (!text) return null;
  if (!simple) return <p className="lage-reason">{text}</p>;
  return (
    <>
      <button type="button" className="lage-reason-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon icon={open ? "chevron-down" : "chevron-right"} size={11} aria-hidden /> Begründung
      </button>
      {open && <p className="lage-reason">{text}</p>}
    </>
  );
}

export interface PlanData {
  auto_routing: boolean;
  suggestions: PlanSuggestion[];
  counts: { auto: number; suggest: number; none: number };
}

export interface HandlerSuggestion {
  order_no: string; customer_ref: string; rush: boolean;
  user_id: number | null; name: string; score: number; reason: string;
}

const SEVERITY: Record<string, { word: string; order: number; intent: "danger" | "warning" | "primary" | "success" }> = {
  danger: { word: "Kritisch", order: 0, intent: "danger" },
  warning: { word: "Achtung", order: 1, intent: "warning" },
  info: { word: "Hinweis", order: 2, intent: "primary" },
  success: { word: "In Ordnung", order: 3, intent: "success" },
};

function Findings({ findings, only, activeIdx, onPick }: {
  findings: TwinFinding[]; only: (f: TwinFinding) => boolean; activeIdx: number | null;
  onPick: (idx: number | null, f: TwinFinding | null) => void;
}) {
  return (
    <ul className="lage-list">
      {findings.map((f, i) => {
        if (!only(f)) return null;
        const sev = SEVERITY[f.severity] ?? SEVERITY.info;
        const on = activeIdx === i;
        return (
          <li key={`${f.kind}-${f.title}`} className={"lage-finding" + (on ? " lage-finding-on" : "")}>
            <button type="button" className="lage-row-button" aria-pressed={on} onClick={() => onPick(on ? null : i, on ? null : f)}>
              <Icon icon={(FINDING_ICON[f.kind] ?? "issue") as IconName} size={14} aria-hidden />
              <span>
                <Tag minimal intent={sev.intent}>{sev.word}</Tag> <b>{f.title}</b>
                {f.metric && <span className="lage-meta"> {f.metric}</span>}
              </span>
            </button>
            {on && (
              <div className="lage-detail">
                <p>{f.detail}</p>
                {f.moves.length > 0 && (
                  <ul>{f.moves.map((m) => <li key={m.job_no}><span className="mono">{m.job_no}</span>: {m.from_label} → {m.label}</li>)}</ul>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Assignments({ plan, rows, stations, busy, locked, onWhy, onApply, onApplyAll }: {
  plan: PlanData; rows: PlanSuggestion[]; stations: Station[]; busy: string | null; locked: boolean;
  onWhy: (s: PlanSuggestion) => void; onApply: (s: PlanSuggestion) => void; onApplyAll: () => void;
}) {
  const { counts, auto_routing } = plan;
  const suggestions = rows;
  const smart = stations.filter((s) => s.type === "production" && s.routing !== "pull" && s.active);
  return (
    <>
      <div className="lage-actions">
        <Tag minimal intent={auto_routing ? "success" : "none"} icon={auto_routing ? "automatic-updates" : "disable"}>
          Automatik {auto_routing ? "an" : "aus"}
        </Tag>
        {counts.auto > 0 && auto_routing && (
          <Button small intent="primary" icon="predictive-analysis" disabled={locked}
            text={`${counts.auto} automatisch zuordnen`} onClick={onApplyAll} />
        )}
      </div>
      {!smart.length && (
        <Callout compact intent="primary" icon="info-sign">
          Keine Fertigungsstation steht auf „Smart". Solange alle auf <b>Pull</b> stehen, schlägt der
          Planer nichts vor. Das ist die Voreinstellung, kein Fehler.
        </Callout>
      )}
      {suggestions.length === 0 ? (
        smart.length > 0 && <NonIdealState icon="tick-circle" title="Nichts zu planen"
          description="Jeder offene Innenauftrag hat eine Maschine." />
      ) : (
        <ul className="lage-list">
          {suggestions.slice(0, 25).map((s) => (
            <li key={s.job_no} className="lage-item">
              <div>
                <b className="mono">{s.job_no}</b>{" "}
                {s.station_id != null ? <>→ {s.label}{" "}
                  <Tag minimal intent={s.mode === "auto" ? "success" : "warning"}>{s.mode === "auto" ? "Vorschlag sicher" : "Vorschlag"}</Tag></>
                  : <span className="sub">keine Station</span>}
              </div>
              <Reason text={s.reason} />
              <div className="lage-actions">
                <Tooltip content="Alle Stationen mit allen Faktoren">
                  <Button aria-label="Alle Stationen mit allen Faktoren" small minimal icon="chart" onClick={() => onWhy(s)} />
                </Tooltip>
                {s.station_id != null && (
                  <Button small intent="primary" icon="tick" text="Zuordnen" disabled={locked} data-row-key={s.job_no}
                    loading={busy === s.job_no} onClick={() => onApply(s)} />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {suggestions.length > 25 && <p className="sub">… und {suggestions.length - 25} weitere.</p>}
    </>
  );
}

function Handlers({ handlers, locked, onSet }: { handlers: HandlerSuggestion[]; locked: boolean; onSet: (h: HandlerSuggestion) => void }) {
  return (
    <ul className="lage-list">
      {handlers.slice(0, 12).map((h) => (
        <li key={h.order_no} className="lage-item">
          <div>
            <b className="mono">{h.order_no}</b>{h.rush && <> <Tag minimal intent="danger">Eil</Tag></>}
            {" "}{h.customer_ref || "—"}
          </div>
          <div>{h.name ? <>→ {h.name}</> : <span className="sub">niemand verfügbar</span>}</div>
          <Reason text={h.reason} />
          <div className="lage-actions">
            <Button small intent="primary" icon="tick" text="Übernehmen" disabled={h.user_id == null || locked} data-row-key={h.order_no} onClick={() => onSet(h)} />
          </div>
        </li>
      ))}
      {handlers.length > 12 && <li className="sub">… und {handlers.length - 12} weitere.</li>}
    </ul>
  );
}

/** Füllstand des Balkens aus der Marke, damit Liste und Prognose dasselbe sagen. */
function levelOf(ratio: number): string {
  return ratio > 1 ? "over" : ratio >= 0.85 ? "high" : ratio >= 0.5 ? "mid" : "low";
}

export function StationList({ stations, marks, onPick }: {
  stations: Station[]; marks: Record<number, StationMark>; onPick: (s: Station) => void;
}) {
  if (!stations.length) return <p className="twin-empty">Keine Station für diesen Filter.</p>;
  return (
    <ul className="lage-stations">
      {stations.map((s) => {
        const mark = s.id != null ? marks[s.id] : undefined;
        const ratio = mark?.ratio ?? null;
        return (
          <li key={s.id ?? s.label}>
            <button type="button" className="lage-station" onClick={() => onPick(s)} data-status={mark?.kind} data-station-id={s.id}>
              {mark && <svg width={16} height={16} viewBox="-8 -8 16 16" aria-hidden="true"><StatusGlyph kind={mark.kind} /></svg>}
              <span className="lage-station-text">
                <b>{s.label}</b>
                {mark && <span className="lage-meta"><Spoken word={mark.word} spoken={mark.spoken} /></span>}
              </span>
              {/* Unbekannt hat keinen Balken: die Zelle bleibt, die Worte stehen links. */}
              {ratio != null ? (
                <span className="load-track" aria-hidden="true">
                  <span className={`load-fill load-fill-${levelOf(ratio)}`}
                    style={{ display: "block", width: `${Math.round(Math.min(1, ratio) * 100)}%` }} />
                </span>
              ) : <span aria-hidden="true" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Section({ title, id, count, children, collapsible, startOpen = false }: {
  title: string; id?: string; count?: number; children: React.ReactNode; collapsible?: boolean; startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const head = <>{title}{count != null && <span className="lage-count"> {count}</span>}</>;
  if (collapsible) {
    return (
      <details className="lage-section" data-lage-section={id} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="twin-panel-sub">
          <Icon className="lage-chevron" icon="chevron-right" size={12} aria-hidden />
          {head}
        </summary>
        {children}
      </details>
    );
  }
  return <section className="lage-section" data-lage-section={id}><h3 className="twin-panel-sub" tabIndex={-1}>{head}</h3>{children}</section>;
}

/** Bis zu dieser Zahl liefert `/handlers/plan` Vorschläge; mehr kann die Zeile nicht wissen. */
const HANDLER_LIMIT = 40;

export default function LagePanel({ findings, plan, handlers, stations, sorted, marks, summary, noAisles, partial, activeFinding, busy, locked, phone,
  onPickFinding, onPickStation, onWhy, onApply, onApplyAll, onSetHandler }: {
  findings: TwinFinding[]; plan: PlanData | null; handlers: HandlerSuggestion[]; stations: Station[]; sorted: Station[];
  marks: Record<number, StationMark>; summary: { text: string; spoken: string }; noAisles: boolean; partial: string[];
  activeFinding: number | null; busy: string | null; locked: boolean; phone: boolean;
  onPickFinding: (idx: number | null, f: TwinFinding | null) => void; onPickStation: (s: Station) => void;
  onWhy: (s: PlanSuggestion) => void; onApply: (s: PlanSuggestion) => void; onApplyAll: () => void;
  onSetHandler: (h: HandlerSuggestion) => void;
}) {
  const office = !isWorker();
  const isAdmin = canAdminWork(getUser());
  const isWarning = (f: TwinFinding) => f.severity === "danger" || f.severity === "warning";
  const warnings = findings.filter(isWarning).length;
  // Was eine Warnung verschieben will, steht oben: dort liegt die Entscheidung.
  const rows = useMemo(() => {
    const moved = new Set(findings.filter(isWarning).flatMap((f) => f.moves.map((m) => m.job_no)));
    const list = plan?.suggestions ?? [];
    return [...list.filter((s) => moved.has(s.job_no)), ...list.filter((s) => !moved.has(s.job_no))];
  }, [findings, plan]);
  const assignable = rows.filter((s) => s.station_id != null).length;
  const handlerRows = handlers.filter((h) => h.user_id != null).length;
  const counts = [
    warnings ? plural(warnings, "Warnung", "Warnungen") : "",
    assignable ? plural(assignable, "Zuordnung", "Zuordnungen") : "",
    handlerRows ? (handlers.length >= HANDLER_LIMIT ? `${HANDLER_LIMIT}+ Bearbeiter` : `${handlerRows} Bearbeiter`) : "",
  ].filter(Boolean).join(" · ");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase("de-DE");
  const shownStations = needle
    ? sorted.filter((s) => `${s.label} ${s.subtype} ${TYPE_LABEL[s.type]}`.toLocaleLowerCase("de-DE").includes(needle))
    : sorted;
  const decisions = office && (
    <>
      {phone ? (
        <>
          {warnings > 0 && <Section title="Auffälligkeiten" id="auffaellig" count={warnings} collapsible startOpen>
            <Findings findings={findings} only={isWarning} activeIdx={activeFinding} onPick={onPickFinding} />
          </Section>}
          {findings.length > warnings && <Section title="Hinweise" id="hinweise" count={findings.length - warnings} collapsible>
            <Findings findings={findings} only={(f) => !isWarning(f)} activeIdx={activeFinding} onPick={onPickFinding} />
          </Section>}
        </>
      ) : findings.length > 0 && <Section title="Auffälligkeiten" id="auffaellig" count={findings.length} collapsible startOpen>
        <Findings findings={findings} only={() => true} activeIdx={activeFinding} onPick={onPickFinding} />
      </Section>}
      {plan && <Section title="Offene Zuordnungen" id="zuordnung" count={rows.length} collapsible startOpen={!phone}>
        <Assignments plan={plan} rows={rows} stations={stations} busy={busy} locked={locked} onWhy={onWhy} onApply={onApply} onApplyAll={onApplyAll} />
      </Section>}
      {handlers.length > 0 && <Section title="Auftragsbearbeitung" id="bearbeiter" count={handlers.length} collapsible startOpen={!phone}>
        <p className="lage-reason">Vorgeschlagen wird, wer den Kunden schon betreut hat.</p>
        <Handlers handlers={handlers} locked={locked} onSet={onSetHandler} />
      </Section>}
    </>
  );
  return (
    <div className="lage-panel">
      <h2 className="twin-panel-title">Lage{office && counts && <span className="lage-count"> {counts}</span>}</h2>
      {partial.length > 0 && (
        <Callout compact intent="warning" icon="warning-sign">Nicht geladen: {partial.join(", ")}.</Callout>
      )}
      {noAisles && (
        <Callout compact intent="warning" icon="route">
          Noch kein Gangnetz: Entfernungen sind Luftlinie.
          {isAdmin && <> <button type="button" className="row-toggle" onClick={() => navigate("grundriss/admin")}>Gänge zeichnen →</button></>}
        </Callout>
      )}
      {decisions}
      <p className="sub lage-summary"><Spoken word={summary.text} spoken={summary.spoken} /></p>
      <Section title="Stationen" count={sorted.length} collapsible startOpen>
        <InputGroup
          className="lage-search"
          leftIcon="search"
          placeholder="Station suchen"
          aria-label="Station suchen"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          rightElement={query ? (
            <Button minimal small icon="cross" aria-label="Suche löschen" onClick={() => setQuery("")} />
          ) : undefined}
        />
        {shownStations.length === 0
          ? <p className="twin-empty">Keine Station passt zu „{query}“.</p>
          : <StationList stations={shownStations} marks={marks} onPick={onPickStation} />}
      </Section>
    </div>
  );
}
