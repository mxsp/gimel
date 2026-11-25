/* Reines Layout für den Produktionsfluss-Graph im ERP-Leitstand (kein React, kein DOM). */

import type { FlowEdge, StationType } from "../factory";

export interface FlowGraphNode {
  id: number;
  label: string;
  type: StationType | string;
  column: number;
  x: number;
  y: number;
  w: number;
  h: number;
  jobs: number;
  minutes: number;
  inCount: number;
  outCount: number;
  bottleneck: boolean;
}

export interface FlowGraphEdge {
  key: string;
  from: number;
  to: number;
  fromLabel: string;
  toLabel: string;
  kind: string;
  count: number;
  metres: number;
  exact: boolean;
  materials: string[];
  strokeWidth: number;
  path: string;
  midX: number;
  midY: number;
}

export interface FlowGraphLayout {
  width: number;
  height: number;
  columns: { index: number; label: string; x: number }[];
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  totalTransfers: number;
  totalMetres: number;
  bottleneck: FlowGraphNode | null;
}

export const FLOW_NODE_W = 186;
export const FLOW_NODE_H = 68;

const COLUMN_ORDER: { key: string; label: string; types: string[] }[] = [
  { key: "warehouse", label: "Lager & Bereitstellung", types: ["warehouse"] },
  { key: "production", label: "Fertigung", types: ["production"] },
  { key: "shipping", label: "Versand", types: ["shipping"] },
  { key: "accounting", label: "Abschluss", types: ["accounting"] },
];

const COL_GAP = 104;
const ROW_GAP = 22;
const PAD_X = 28;
const PAD_TOP = 46;
const PAD_BOTTOM = 28;

export function columnForType(type: string): number {
  const idx = COLUMN_ORDER.findIndex((c) => c.types.includes(type));
  return idx >= 0 ? idx : 1;
}

/** Berechnet das gerichtete Spalten-Layout (Lager → Fertigung → Versand → Abschluss)
 *  samt kubischer Bézier-Pfade und Engpass-Erkennung. */
export function layoutProductionFlow(
  stations: { id: number; label: string; type: string; jobs: number; minutes: number }[],
  rawEdges: FlowEdge[],
  opts: { kindFilter?: "all" | "supply" | "dispatch"; onlyActive?: boolean } = {},
): FlowGraphLayout {
  const kindFilter = opts.kindFilter ?? "all";
  const onlyActive = opts.onlyActive ?? false;

  const filteredEdges = rawEdges.filter((e) => {
    if (kindFilter === "supply") return e.kind === "supply";
    if (kindFilter === "dispatch") return e.kind !== "supply";
    return true;
  });

  const inCount = new Map<number, number>();
  const outCount = new Map<number, number>();
  for (const e of filteredEdges) {
    outCount.set(e.from, (outCount.get(e.from) ?? 0) + e.count);
    inCount.set(e.to, (inCount.get(e.to) ?? 0) + e.count);
  }

  const keptStations = stations.filter((s) => {
    if (!onlyActive) return true;
    return s.jobs > 0 || (inCount.get(s.id) ?? 0) > 0 || (outCount.get(s.id) ?? 0) > 0;
  });

  const byRawCol = new Map<number, typeof keptStations>();
  for (const s of keptStations) {
    const col = columnForType(s.type);
    const list = byRawCol.get(col) ?? [];
    list.push(s);
    byRawCol.set(col, list);
  }

  const activeRawCols = COLUMN_ORDER
    .map((_, idx) => idx)
    .filter((idx) => (byRawCol.get(idx)?.length ?? 0) > 0 || idx < 3);

  const maxRows = Math.max(1, ...activeRawCols.map((idx) => byRawCol.get(idx)?.length ?? 0));
  const width = PAD_X * 2 + activeRawCols.length * FLOW_NODE_W + Math.max(0, activeRawCols.length - 1) * COL_GAP;
  const height = PAD_TOP + maxRows * FLOW_NODE_H + Math.max(0, maxRows - 1) * ROW_GAP + PAD_BOTTOM;

  const maxMinutes = Math.max(0, ...keptStations.map((s) => s.minutes));
  const maxJobs = Math.max(0, ...keptStations.map((s) => s.jobs));

  const columns: { index: number; label: string; x: number }[] = [];
  const nodes: FlowGraphNode[] = [];
  const nodeById = new Map<number, FlowGraphNode>();

  activeRawCols.forEach((rawCol, visualIdx) => {
    const x = PAD_X + visualIdx * (FLOW_NODE_W + COL_GAP);
    columns.push({ index: visualIdx, label: COLUMN_ORDER[rawCol].label, x });
    const list = (byRawCol.get(rawCol) ?? []).slice().sort((a, b) =>
      (b.minutes - a.minutes) || (b.jobs - a.jobs) || a.label.localeCompare(b.label, "de"),
    );
    const colHeight = list.length * FLOW_NODE_H + Math.max(0, list.length - 1) * ROW_GAP;
    const startY = PAD_TOP + Math.max(0, (height - PAD_TOP - PAD_BOTTOM - colHeight) / 2);
    list.forEach((s, rowIdx) => {
      const y = startY + rowIdx * (FLOW_NODE_H + ROW_GAP);
      const isBottleneck =
        s.type === "production"
        && ((maxMinutes >= 30 && s.minutes === maxMinutes) || (maxMinutes < 30 && maxJobs >= 2 && s.jobs === maxJobs));
      const node: FlowGraphNode = {
        id: s.id,
        label: s.label,
        type: s.type,
        column: visualIdx,
        x,
        y,
        w: FLOW_NODE_W,
        h: FLOW_NODE_H,
        jobs: s.jobs,
        minutes: s.minutes,
        inCount: inCount.get(s.id) ?? 0,
        outCount: outCount.get(s.id) ?? 0,
        bottleneck: isBottleneck,
      };
      nodes.push(node);
      nodeById.set(s.id, node);
    });
  });

  const maxCount = Math.max(1, ...filteredEdges.map((e) => e.count));
  const edges: FlowGraphEdge[] = [];
  filteredEdges.forEach((e, idx) => {
    const src = nodeById.get(e.from);
    const dst = nodeById.get(e.to);
    if (!src || !dst || src.id === dst.id) return;
    const sameCol = src.column === dst.column;
    const forward = dst.column >= src.column;
    const x1 = sameCol ? src.x + src.w : forward ? src.x + src.w : src.x;
    const y1 = src.y + src.h / 2;
    const x2 = sameCol ? dst.x + dst.w : forward ? dst.x : dst.x + dst.w;
    const y2 = dst.y + dst.h / 2;
    let path: string;
    let midX: number;
    let midY: number;
    if (sameCol) {
      const bulge = 46;
      path = `M ${x1} ${y1} C ${x1 + bulge} ${y1}, ${x2 + bulge} ${y2}, ${x2} ${y2}`;
      midX = x1 + bulge * 0.72;
      midY = (y1 + y2) / 2;
    } else {
      const dx = Math.max(44, Math.abs(x2 - x1) * 0.48);
      const c1x = forward ? x1 + dx : x1 - dx;
      const c2x = forward ? x2 - dx : x2 + dx;
      path = `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
      midX = (x1 + x2) / 2;
      midY = (y1 + y2) / 2;
    }
    const strokeWidth = 1.8 + (e.count / maxCount) * 5.2;
    edges.push({
      key: `${e.from}-${e.to}-${e.kind}-${idx}`,
      from: e.from,
      to: e.to,
      fromLabel: src.label,
      toLabel: dst.label,
      kind: e.kind,
      count: e.count,
      metres: e.metres,
      exact: e.exact,
      materials: e.materials ?? [],
      strokeWidth,
      path,
      midX,
      midY,
    });
  });

  const totalTransfers = edges.reduce((acc, e) => acc + e.count, 0);
  const totalMetres = edges.reduce((acc, e) => acc + e.metres * e.count, 0);
  const bottleneck = nodes.find((n) => n.bottleneck) ?? null;

  return { width, height, columns, nodes, edges, totalTransfers, totalMetres, bottleneck };
}
