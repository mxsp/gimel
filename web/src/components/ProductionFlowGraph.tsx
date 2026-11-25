/* Produktionsfluss-Graph für den ERP-Leitstand (reine SVG-Darstellung + Layout).
 *
 * Zeigt den realen Material- und Auftragsfluss zwischen Lager, Fertigung,
 * Versand und Buchhaltung als gerichteten Flussgraphen (links → rechts) mit
 * proportionaler Kantenstärke, Engpass-Erkennung und Klick-Inspektor. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ButtonGroup, Icon, Spinner, Switch, Tag } from "@blueprintjs/core";
import { api } from "../api";
import { FlowEdge, StationType, TYPE_LABEL, WorklistData, fmtM, fmtMin } from "../factory";
import { navigate } from "../router";
import { plural } from "../plural";
import { FLOW_NODE_W, layoutProductionFlow } from "./productionFlowLayout";

interface FlowResponse {
  edges: FlowEdge[];
  total_metres: number;
}

export default function ProductionFlowGraph({
  worklist: externalWorklist,
  onSelectStation,
}: {
  /** Optional bereits geladener Arbeitsvorrat (z. B. aus Worklist.tsx), spart einen Request. */
  worklist?: WorklistData | null;
  onSelectStation?: (stationId: number) => void;
}) {
  const [worklist, setWorklist] = useState<WorklistData | null>(externalWorklist ?? null);
  const [flow, setFlow] = useState<FlowResponse | null>(null);
  const [loading, setLoading] = useState(!externalWorklist);
  const [error, setError] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "supply" | "dispatch">("all");
  const [onlyActive, setOnlyActive] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);

  useEffect(() => {
    if (externalWorklist) setWorklist(externalWorklist);
  }, [externalWorklist]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [flowRes, wlRes] = await Promise.all([
        api<FlowResponse>("/api/factory/flow"),
        externalWorklist ? Promise.resolve(externalWorklist) : api<WorklistData>("/api/factory/worklist"),
      ]);
      setFlow(flowRes);
      if (!externalWorklist) setWorklist(wlRes);
      setError("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Produktionsfluss konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, [externalWorklist]);

  useEffect(() => {
    void load(false);
    const t = window.setInterval(() => void load(true), 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  const stationInputs = useMemo(() => {
    return (worklist?.stations ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      type: s.type,
      jobs: s.schedule?.slots?.length ?? 0,
      minutes: s.schedule?.total_min ?? 0,
    }));
  }, [worklist]);

  const layout = useMemo(
    () => layoutProductionFlow(stationInputs, flow?.edges ?? [], { kindFilter, onlyActive }),
    [stationInputs, flow, kindFilter, onlyActive],
  );

  const selectedNode = useMemo(
    () => layout.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [layout.nodes, selectedNodeId],
  );
  const selectedEdge = useMemo(
    () => layout.edges.find((e) => e.key === selectedEdgeKey) ?? null,
    [layout.edges, selectedEdgeKey],
  );

  const relatedEdgeKeys = useMemo(() => {
    if (selectedEdgeKey) return new Set([selectedEdgeKey]);
    if (selectedNodeId == null) return null;
    return new Set(
      layout.edges
        .filter((e) => e.from === selectedNodeId || e.to === selectedNodeId)
        .map((e) => e.key),
    );
  }, [layout.edges, selectedNodeId, selectedEdgeKey]);

  if (loading && !flow) {
    return (
      <div className="pfg-card pfg-empty">
        <Spinner size={24} />
        <span>Produktionsfluss wird geladen …</span>
      </div>
    );
  }

  return (
    <div className="pfg-card">
      <div className="pfg-head">
        <div className="pfg-title-wrap">
          <Icon icon="flow-branch" size={16} />
          <h3>Produktionsfluss</h3>
          <Tag minimal>{plural(layout.nodes.length, "Station", "Stationen")}</Tag>
          <Tag minimal intent={layout.edges.length > 0 ? "primary" : "none"}>
            {plural(layout.totalTransfers, "Übergabe", "Übergaben")}
          </Tag>
          {layout.totalMetres > 0 && (
            <Tag minimal>{fmtM(layout.totalMetres)} Weg</Tag>
          )}
          {layout.bottleneck && (
            <Tag minimal intent="warning" icon="flame">
              Engpass: {layout.bottleneck.label} ({fmtMin(layout.bottleneck.minutes)})
            </Tag>
          )}
        </div>
        <div className="pfg-controls">
          <ButtonGroup>
            <Button small active={kindFilter === "all"} text="Alle" onClick={() => setKindFilter("all")} />
            <Button small active={kindFilter === "supply"} text="Material" onClick={() => setKindFilter("supply")} />
            <Button small active={kindFilter === "dispatch"} text="Versand" onClick={() => setKindFilter("dispatch")} />
          </ButtonGroup>
          <Switch
            checked={onlyActive}
            label="Nur aktiv"
            style={{ marginBottom: 0 }}
            onChange={(e) => setOnlyActive(e.currentTarget.checked)}
          />
          <Button small minimal icon="refresh" aria-label="Fluss aktualisieren" onClick={() => void load(false)} />
        </div>
      </div>

      {error && <div className="pfg-error">{error}</div>}

      {layout.nodes.length === 0 ? (
        <div className="pfg-empty">
          <Icon icon="diagram-tree" size={24} />
          <span>Keine Stationen für die aktuelle Filterung vorhanden.</span>
        </div>
      ) : (
        <div className="pfg-stage">
          <svg
            className="pfg-svg"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label="Produktionsfluss zwischen Lager, Fertigung und Versand"
            onClick={() => { setSelectedNodeId(null); setSelectedEdgeKey(null); }}
          >
            <defs>
              <marker id="pfg-arrow-supply" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 1.2 L 9 5 L 0 8.8 z" fill="var(--g-flow-supply, #8e5cb8)" />
              </marker>
              <marker id="pfg-arrow-ship" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 1.2 L 9 5 L 0 8.8 z" fill="var(--g-flow-ship, #217e56)" />
              </marker>
            </defs>

            {/* Spaltenköpfe */}
            {layout.columns.map((col) => (
              <g key={col.index}>
                <rect
                  x={col.x - 10}
                  y={10}
                  width={FLOW_NODE_W + 20}
                  height={layout.height - 20}
                  rx={10}
                  className="pfg-col-bg"
                />
                <text x={col.x + FLOW_NODE_W / 2} y={29} textAnchor="middle" className="pfg-col-label">
                  {col.label}
                </text>
              </g>
            ))}

            {/* Flusskanten (Materialzufuhr & Versand) */}
            {layout.edges.map((e) => {
              const isSupply = e.kind === "supply";
              const dimmed = relatedEdgeKeys != null && !relatedEdgeKeys.has(e.key);
              const active = selectedEdgeKey === e.key;
              return (
                <g
                  key={e.key}
                  className={`pfg-edge${isSupply ? " is-supply" : " is-ship"}${dimmed ? " is-dim" : ""}${active ? " is-active" : ""}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setSelectedNodeId(null);
                    setSelectedEdgeKey(active ? null : e.key);
                  }}
                >
                  <path d={e.path} className="pfg-edge-hit" />
                  <path
                    d={e.path}
                    className="pfg-edge-line"
                    strokeWidth={e.strokeWidth}
                    markerEnd={isSupply ? "url(#pfg-arrow-supply)" : "url(#pfg-arrow-ship)"}
                  />
                  <g transform={`translate(${e.midX} ${e.midY})`}>
                    <rect x={-30} y={-10} width={60} height={20} rx={10} className="pfg-edge-pill" />
                    <text x={0} y={3.5} textAnchor="middle" className="pfg-edge-text">
                      {e.count}× · {Math.round(e.metres)}m
                    </text>
                  </g>
                </g>
              );
            })}

            {/* Stationsknoten */}
            {layout.nodes.map((n) => {
              const selected = selectedNodeId === n.id;
              const dimmed =
                (selectedNodeId != null && selectedNodeId !== n.id && !layout.edges.some((e) =>
                  (e.from === selectedNodeId && e.to === n.id) || (e.to === selectedNodeId && e.from === n.id),
                ))
                || (selectedEdge != null && selectedEdge.from !== n.id && selectedEdge.to !== n.id);
              const loadPct = Math.min(100, Math.round((n.minutes / 480) * 100));
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x} ${n.y})`}
                  className={`pfg-node pfg-node--${n.type}${selected ? " is-selected" : ""}${n.bottleneck ? " is-bottleneck" : ""}${dimmed ? " is-dim" : ""}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setSelectedEdgeKey(null);
                    setSelectedNodeId(selected ? null : n.id);
                  }}
                >
                  <rect width={n.w} height={n.h} rx={9} className="pfg-node-box" />
                  <rect x={0} y={0} width={5} height={n.h} rx={2} className="pfg-node-stripe" />
                  <text x={14} y={22} className="pfg-node-title">
                    {n.label.length > 21 ? `${n.label.slice(0, 20)}…` : n.label}
                  </text>
                  <text x={14} y={39} className="pfg-node-meta">
                    {TYPE_LABEL[n.type as StationType] ?? n.type} · {plural(n.jobs, "Aufgabe", "Aufgaben")}
                    {n.minutes > 0 ? ` · ${fmtMin(n.minutes)}` : ""}
                  </text>
                  {/* Auslastungsbalken */}
                  <rect x={14} y={50} width={n.w - 28} height={6} rx={3} className="pfg-node-bar-bg" />
                  {loadPct > 0 && (
                    <rect
                      x={14}
                      y={50}
                      width={Math.max(6, ((n.w - 28) * loadPct) / 100)}
                      height={6}
                      rx={3}
                      className="pfg-node-bar-fill"
                    />
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Detail-Inspektor bei Klick auf Station oder Kante */}
      {(selectedNode || selectedEdge) && (
        <div className="pfg-detail">
          {selectedNode && (
            <>
              <div>
                <strong>{selectedNode.label}</strong>{" "}
                <span className="sub">
                  ({TYPE_LABEL[selectedNode.type as StationType] ?? selectedNode.type}) ·{" "}
                  {plural(selectedNode.jobs, "Aufgabe", "Aufgaben")} · {fmtMin(selectedNode.minutes)} ·{" "}
                  Eingang: {selectedNode.inCount}× · Ausgang: {selectedNode.outCount}×
                </span>
              </div>
              <div className="pfg-detail-actions">
                {onSelectStation && (
                  <Button small minimal icon="filter" text="Im Arbeitsvorrat zeigen"
                    onClick={() => onSelectStation(selectedNode.id)} />
                )}
                <Button small intent="primary" icon="arrow-right" text="Station öffnen"
                  onClick={() => navigate(`station/${selectedNode.id}`)} />
              </div>
            </>
          )}
          {selectedEdge && (
            <>
              <div>
                <strong>{selectedEdge.fromLabel} → {selectedEdge.toLabel}</strong>{" "}
                <span className="sub">
                  {selectedEdge.kind === "supply" ? "Materialzufuhr" : "Versandweg"} ·{" "}
                  {plural(selectedEdge.count, "Übergabe", "Übergaben")} · {fmtM(selectedEdge.metres)}
                  {selectedEdge.exact ? " (Gangnetz)" : " (Luftlinie)"}
                  {selectedEdge.materials.length > 0 && ` · Werkstoffe: ${selectedEdge.materials.join(", ")}`}
                </span>
              </div>
              <Button small minimal icon="cross" onClick={() => setSelectedEdgeKey(null)} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
