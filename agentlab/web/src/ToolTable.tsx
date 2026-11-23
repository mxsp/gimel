import { Icon, Spinner } from "@blueprintjs/core";
import { Fragment, useState } from "react";
import { formatDuration, LiveTool, toolIcon, toolTone } from "./chatUtils";
import ChartBlock, { ChartSpec } from "./ChartBlock";
import CopyButton from "./CopyButton";
import { formatValue } from "./format";
import { toolLabel } from "./toolLabels";

function extractChart(preview?: string): ChartSpec | null {
  if (!preview || !preview.includes('"chart"')) return null;
  try {
    const parsed = JSON.parse(preview);
    const chart = parsed?.data?.chart ?? parsed?.chart;
    if (chart && Array.isArray(chart.labels) && Array.isArray(chart.series) && chart.labels.length > 0) {
      return chart as ChartSpec;
    }
  } catch { /* gekürztes JSON ignorieren */ }
  return null;
}

function prettyPreview(raw: string): string {
  if (!raw) return "Kein Ergebnis gespeichert.";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/* Werkzeugaufrufe als aufklappbare Ausführungsliste mit Kopfzeile, Dauer,
   Schritt-Anzeige und direktem Vorschau-Sprung bei Artefakten / JSON. */
export default function ToolTable({
  tools,
  onRevert,
  onPreviewAction,
  onPreviewJson,
}: {
  tools: LiveTool[];
  onRevert?: (id: number) => void;
  onPreviewAction?: (action: Record<string, unknown>) => void;
  onPreviewJson?: (title: string, jsonText: string) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);
  if (!tools.length) return null;

  const runningCount = tools.filter((t) => t.status === "running").length;
  const errorCount = tools.filter((t) => t.status === "error").length;
  const totalMs = tools.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);

  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="tool-table-wrap">
      <div className="tool-table-bar">
        <button type="button" className="tool-bar-toggle" onClick={() => setCollapsed((v) => !v)}>
          <Icon icon={collapsed ? "chevron-right" : "chevron-down"} size={12} aria-hidden="true" />
          <span className="tool-bar-dots" aria-hidden="true">
            {tools.slice(0, 8).map((t, i) => (
              <span key={i} className={`tool-bar-dot is-${t.status}`} />
            ))}
          </span>
          <strong>
            {runningCount > 0
              ? `${runningCount} Werkzeug${runningCount > 1 ? "e" : ""} aktiv (${tools.length} gesamt)`
              : `${tools.length} Werkzeug${tools.length > 1 ? "e" : ""} ausgeführt`}
          </strong>
          {errorCount > 0 && <span className="tool-badge is-err">{errorCount} Fehler</span>}
          {totalMs > 0 && <span className="tool-bar-dur">{formatDuration(totalMs)}</span>}
        </button>
      </div>

      {!collapsed && (
        <table className="tool-table">
          <thead>
            <tr>
              <th>Werkzeug</th>
              <th>Status</th>
              <th className="tool-col-summary">Ergebnis</th>
              <th className="tool-col-toggle" aria-label="Details" />
            </tr>
          </thead>
          <tbody>
            {tools.map((tool, index) => {
              const key = `${tool.id || tool.name}-${index}`;
              const expanded = !!open[key];
              const write = tool.changeId != null || toolTone(tool.name) === "write";
              const running = tool.status === "running";
              const statusLabel = running ? "läuft" : tool.status === "error" ? "Fehler" : "fertig";
              const dur = formatDuration(tool.durationMs);
              const hasPreviewAction = Boolean(
                onPreviewAction && tool.action && tool.action.type === "open_preview",
              );
              return (
                <Fragment key={key}>
                  <tr
                    className={`tool-row ${write ? "is-write" : ""} ${tool.status === "error" ? "is-error" : ""} ${expanded ? "is-open" : ""}`}
                    tabIndex={0}
                    aria-expanded={expanded}
                    onClick={() => toggle(key)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggle(key);
                      }
                    }}
                    title={expanded ? "Details schließen" : "Argumente und Ergebnis anzeigen"}
                  >
                    <td className="tool-cell-name">
                      <span className={`tool-table-icon ${write ? "is-write" : ""} ${tool.status === "error" ? "is-error" : ""}`} aria-hidden="true">
                        {running ? <Spinner size={12} /> : <Icon icon={toolIcon(tool.name)} size={13} />}
                      </span>
                      <span className="tool-table-nameblock">
                        <span className="tool-table-name">{toolLabel(tool.name)}</span>
                        <code className="tool-table-raw">
                          {tool.name}
                          {tool.step ? ` · S${tool.step}` : ""}
                        </code>
                      </span>
                    </td>
                    <td className="tool-cell-status">
                      <span className={`tool-status is-${tool.status}`}><span className="tool-dot" />{statusLabel}</span>
                      {dur && <span className="tool-dur">{dur}</span>}
                      {write && tool.changeReversible === false && <span className="tool-badge is-warn">nicht rückholbar</span>}
                      {write && tool.changeReversible == null && <span className="tool-badge">schreibt</span>}
                    </td>
                    <td className="tool-cell-summary">
                      {tool.summary || (running ? "Werkzeug wird ausgeführt …" : "Kein Ergebnis gespeichert.")}
                    </td>
                    <td className="tool-cell-toggle">
                      {hasPreviewAction && (
                        <button type="button" className="tool-quick-undo is-preview" title="In Seiten-Vorschau öffnen"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (tool.action) onPreviewAction?.(tool.action);
                          }}>
                          <Icon icon="eye-open" size={12} aria-hidden="true" />
                        </button>
                      )}
                      {tool.changeReversible && tool.changeId != null && onRevert && (
                        <button type="button" className="tool-quick-undo" title="Rückgängig"
                          onClick={(event) => {
                            event.stopPropagation();
                            onRevert(tool.changeId as number);
                          }}>
                          <Icon icon="undo" size={12} aria-hidden="true" />
                        </button>
                      )}
                      <Icon className="tool-chevron" icon={expanded ? "chevron-up" : "chevron-down"} size={12} aria-hidden="true" />
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="tool-detail-row">
                      <td colSpan={4}>
                        <div className="tool-detail-panel">
                          <div className="tool-detail-grid">
                            <section>
                              <div className="tool-detail-label">Argumente</div>
                              <pre className="tool-pre">{formatValue(tool.args)}</pre>
                            </section>
                            <section>
                              <div className="tool-detail-label">Ergebnis</div>
                              <pre className="tool-pre">{prettyPreview(tool.preview)}</pre>
                            </section>
                          </div>
                          <div className="tool-detail-actions">
                            {hasPreviewAction && (
                              <button type="button" className="msg-action" onClick={() => tool.action && onPreviewAction?.(tool.action)}>
                                <Icon icon="eye-open" size={12} aria-hidden="true" />
                                In Vorschau öffnen
                              </button>
                            )}
                            {onPreviewJson && tool.preview && (
                              <button type="button" className="msg-action"
                                onClick={() => onPreviewJson(`${toolLabel(tool.name)} (JSON)`, prettyPreview(tool.preview))}>
                                <Icon icon="code-block" size={12} aria-hidden="true" />
                                JSON im Browser
                              </button>
                            )}
                            {tool.preview && <CopyButton text={prettyPreview(tool.preview)} label="Ergebnis kopieren" />}
                            {tool.changeReversible && tool.changeId != null && onRevert && (
                              <button type="button" className="msg-action" onClick={() => onRevert(tool.changeId as number)}>
                                <Icon icon="undo" size={12} aria-hidden="true" />
                                Rückgängig
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {tools.map((tool, idx) => {
        const chart = extractChart(tool.preview);
        return chart ? <ChartBlock key={`tc-${tool.id || tool.name}-${idx}`} spec={chart} /> : null;
      })}
    </div>
  );
}
