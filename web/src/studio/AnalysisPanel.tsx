import { useCallback, useEffect, useState } from "react";
import { Button, Callout, Icon, Spinner, Tag } from "@blueprintjs/core";
import { api } from "../api";
import type { Station } from "../factory";

export interface TwinFinding {
  kind?: string;
  severity?: "danger" | "warning" | "info" | string;
  title?: string;
  summary?: string;
  detail?: string;
  station_id?: number | null;
  station_ids?: number[];
  metric?: string;
}

export interface TwinAnalysis {
  findings?: TwinFinding[];
  summary?: Record<string, unknown>;
}

const SEV_ORDER: Record<string, number> = { danger: 0, high: 0, critical: 0, warning: 1, medium: 1, info: 2, low: 2 };

function sevIntent(sev?: string): "danger" | "warning" | "primary" | "none" {
  const s = (sev || "").toLowerCase();
  if (s === "danger" || s === "high" || s === "critical") return "danger";
  if (s === "warning" || s === "medium") return "warning";
  if (s === "info") return "primary";
  return "none";
}

function sevLabel(sev?: string): string {
  const s = (sev || "").toLowerCase();
  if (s === "danger" || s === "high" || s === "critical") return "Kritisch";
  if (s === "warning" || s === "medium") return "Hinweis";
  return "Info";
}

/** Befunde-Reiter in Twin Studio: zeigt Engpässe, Rüstverluste, lange Wege und Layout-Konflikte
 *  aus ``/api/factory/twin/analysis`` und fliegt per Klick direkt zur betroffenen Station. */
export default function AnalysisPanel({
  stations,
  onFocusStations,
  onLoaded,
}: {
  stations: Station[];
  onFocusStations: (ids: number[]) => void;
  onLoaded?: (data: TwinAnalysis | null) => void;
}) {
  const [data, setData] = useState<TwinAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sevFilter, setSevFilter] = useState<"all" | "danger" | "warning">("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api<TwinAnalysis>("/api/factory/twin/analysis");
      setData(res);
      onLoaded?.(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onLoaded?.(null);
    } finally {
      setLoading(false);
    }
  }, [onLoaded]);

  useEffect(() => { void load(); }, [load]);

  const rawFindings = Array.isArray(data?.findings) ? data!.findings : [];
  const findings = [...rawFindings]
    .sort((a, b) => (SEV_ORDER[(a.severity || "info").toLowerCase()] ?? 2) - (SEV_ORDER[(b.severity || "info").toLowerCase()] ?? 2))
    .filter((f) => {
      if (sevFilter === "all") return true;
      const intent = sevIntent(f.severity);
      return sevFilter === "danger" ? intent === "danger" : intent === "warning" || intent === "danger";
    });

  const idsOf = (f: TwinFinding): number[] => {
    const out: number[] = [];
    if (typeof f.station_id === "number") out.push(f.station_id);
    if (Array.isArray(f.station_ids)) {
      for (const id of f.station_ids) if (typeof id === "number" && !out.includes(id)) out.push(id);
    }
    return out;
  };

  const stationNames = (ids: number[]): string =>
    ids.map((id) => stations.find((s) => s.id === id)?.label || `#${id}`).join(", ");

  return (
    <div className="analysis-panel">
      <div className="analysis-head">
        <div className="analysis-filters" role="group" aria-label="Befunde filtern">
          <Button small minimal active={sevFilter === "all"} text={`Alle (${rawFindings.length})`} onClick={() => setSevFilter("all")} />
          <Button small minimal active={sevFilter === "danger"} text="Kritisch" onClick={() => setSevFilter("danger")} />
          <Button small minimal active={sevFilter === "warning"} text="Warnungen" onClick={() => setSevFilter("warning")} />
        </div>
        <Button small minimal icon="refresh" loading={loading} aria-label="Analyse aktualisieren" onClick={() => void load()} />
      </div>

      {error && <Callout intent="danger" className="sim-note">{error}</Callout>}
      {loading && !data ? (
        <div className="analysis-empty"><Spinner size={24} /></div>
      ) : findings.length === 0 ? (
        <Callout intent="success" icon="tick-circle" className="sim-note">
          Keine offenen Auffälligkeiten im gewählten Filter.
        </Callout>
      ) : (
        <ul className="analysis-list">
          {findings.map((f, idx) => {
            const ids = idsOf(f);
            const intent = sevIntent(f.severity);
            return (
              <li key={`${f.kind || "f"}-${idx}`} className={`analysis-card is-${intent}`}>
                <div className="analysis-card-head">
                  <Tag minimal intent={intent}>{sevLabel(f.severity)}</Tag>
                  <b>{f.title || f.kind || "Befund"}</b>
                </div>
                {(f.summary || f.detail) && <p>{f.summary || f.detail}</p>}
                {f.metric && <span className="mono analysis-metric">{f.metric}</span>}
                {ids.length > 0 && (
                  <div className="analysis-card-foot">
                    <span className="sub">{stationNames(ids)}</span>
                    <Button
                      small
                      minimal
                      icon="locate"
                      text="Zeigen"
                      onClick={() => onFocusStations(ids)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="studio-left-foot">
        <Icon icon="info-sign" size={12} /> Reine Lesediagnose aus Warteschlangen, Rüstwechseln, Terminen und Wegen — nichts wird automatisch geändert.
      </p>
    </div>
  );
}
