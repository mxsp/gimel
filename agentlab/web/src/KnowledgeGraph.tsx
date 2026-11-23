import { Button, HTMLSelect, Icon, InputGroup, Spinner, Tag, TextArea } from "@blueprintjs/core";
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  KnowledgeEdge,
  KnowledgeGraphData,
  KnowledgeNode,
  KnowledgePathResult,
  addKnowledgeEdge,
  addKnowledgeInsight,
  deleteKnowledgeEdge,
  deleteKnowledgeNode,
  findKnowledgePath,
  getKnowledgeGraph,
  rebuildKnowledgeGraph,
  updateKnowledgeInsight,
} from "./api";

type LayoutMode = "flow" | "force" | "radial";
type PresetId = "all" | "issues" | "production" | "orders" | "insights";

const KIND_COLOR: Record<string, string> = {
  material: "#d97706",
  work_order: "#0891b2",
  station: "#7c3aed",
  robot: "#db2777",
  hall: "#475569",
  order: "#0b7a67",
  shipment: "#0284c7",
  customer: "#2563eb",
  insight: "#b9583c",
};

const KIND_ORDER = [
  "material", "work_order", "station", "robot", "hall",
  "order", "shipment", "customer", "insight",
];

// Spalten für das strukturierte Fluss-Layout (links -> rechts: Werkstoffe -> Fertigung -> Kunde)
const FLOW_COLUMNS: Array<{ id: string; title: string; kinds: string[] }> = [
  { id: "materials", title: "Werkstoffe", kinds: ["material"] },
  { id: "prod", title: "Innenaufträge", kinds: ["work_order"] },
  { id: "stations", title: "Stationen", kinds: ["station"] },
  { id: "halls_robots", title: "Hallen & Flotte", kinds: ["hall", "robot"] },
  { id: "orders", title: "Aufträge", kinds: ["order"] },
  { id: "delivery", title: "Versand & Kunden", kinds: ["shipment", "customer"] },
  { id: "insights", title: "Erkenntnisse", kinds: ["insight"] },
];

const PRESETS: Array<{ id: PresetId; label: string; icon: string; kinds?: string[]; onlyIssues?: boolean }> = [
  { id: "all", label: "Gesamtnetz", icon: "graph" },
  { id: "issues", label: "Engpässe & Überfällig", icon: "warning-sign", onlyIssues: true },
  { id: "production", label: "Fertigungsfluss", icon: "flows", kinds: ["material", "work_order", "station", "robot", "hall", "order"] },
  { id: "orders", label: "Aufträge & Versand", icon: "inbox", kinds: ["order", "shipment", "customer", "material"] },
  { id: "insights", label: "Erkenntnisse", icon: "lightbulb", kinds: ["insight"] },
];

const WORLD_W = 1520;
const WORLD_H = 880;

type Point = { x: number; y: number };

function separateCollisions(pos: Map<string, Point>, minDist: number, passes = 8): void {
  const keys = [...pos.keys()];
  const n = keys.length;
  if (n < 2) return;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      const a = pos.get(keys[i])!;
      for (let j = i + 1; j < n; j++) {
        const b = pos.get(keys[j])!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.1;
        if (dist < minDist) {
          const push = (minDist - dist) * 0.52;
          const ux = dx / dist;
          const uy = dy / dist;
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
        }
      }
    }
  }
}

function computeFlowLayout(nodes: KnowledgeNode[]): {
  positions: Map<string, Point>;
  headers: Array<{ x: number; y: number; title: string; count: number }>;
} {
  const pos = new Map<string, Point>();
  const buckets = new Map<string, KnowledgeNode[]>();
  for (const col of FLOW_COLUMNS) buckets.set(col.id, []);

  for (const n of nodes) {
    const col = FLOW_COLUMNS.find((c) => c.kinds.includes(n.kind)) ?? FLOW_COLUMNS[FLOW_COLUMNS.length - 1];
    buckets.get(col.id)!.push(n);
  }

  const activeCols = FLOW_COLUMNS.filter((c) => (buckets.get(c.id)?.length ?? 0) > 0);
  const colCount = Math.max(1, activeCols.length);
  const padX = 110;
  const padTop = 86;
  const padBot = 62;
  const usableW = WORLD_W - padX * 2;
  const usableH = WORLD_H - padTop - padBot;
  const headers: Array<{ x: number; y: number; title: string; count: number }> = [];

  activeCols.forEach((col, ci) => {
    const items = buckets.get(col.id) ?? [];
    items.sort((a, b) => {
      const attA = a.attention === "danger" ? 0 : a.attention === "warning" ? 1 : 2;
      const attB = b.attention === "danger" ? 0 : b.attention === "warning" ? 1 : 2;
      if (attA !== attB) return attA - attB;
      return (b.degree ?? 0) - (a.degree ?? 0);
    });
    const baseX = colCount === 1 ? WORLD_W / 2 : padX + (ci / (colCount - 1)) * usableW;
    headers.push({ x: baseX, y: 34, title: col.title, count: items.length });

    // Bei vielen Knoten großzügig in 2–3 versetzte Teilspalten aufteilen, damit keine Labels kollidieren
    const subCols = items.length > 20 ? 3 : items.length > 10 ? 2 : 1;
    const rows = Math.ceil(items.length / subCols);
    const stepY = rows <= 1 ? 0 : Math.max(46, Math.min(72, usableH / Math.max(1, rows - 1)));
    const totalH = (rows - 1) * stepY;
    const startY = padTop + Math.max(0, (usableH - totalH) / 2);
    const subSpread = subCols === 1 ? 0 : subCols === 2 ? 64 : 56;

    items.forEach((n, idx) => {
      const sc = idx % subCols;
      const row = Math.floor(idx / subCols);
      const offsetX = subCols === 1 ? 0 : (sc - (subCols - 1) / 2) * subSpread;
      const staggerY = subCols > 1 && sc % 2 === 1 ? stepY * 0.28 : 0;
      pos.set(n.key, {
        x: baseX + offsetX,
        y: startY + row * stepY + staggerY,
      });
    });
  });

  return { positions: pos, headers };
}

function computeRadialLayout(nodes: KnowledgeNode[]): {
  positions: Map<string, Point>;
  headers: Array<{ x: number; y: number; title: string; count: number }>;
} {
  const groups = new Map<string, KnowledgeNode[]>();
  for (const n of nodes) {
    const arr = groups.get(n.kind) ?? [];
    arr.push(n);
    groups.set(n.kind, arr);
  }
  const activeKinds = KIND_ORDER.filter((k) => groups.has(k));
  const extraKinds = [...groups.keys()].filter((k) => !KIND_ORDER.includes(k));
  const allKinds = [...activeKinds, ...extraKinds];

  const cx = WORLD_W / 2;
  const cy = WORLD_H / 2 + 12;
  const ringRx = allKinds.length <= 1 ? 0 : 510;
  const ringRy = allKinds.length <= 1 ? 0 : 300;
  const pos = new Map<string, Point>();
  const headers: Array<{ x: number; y: number; title: string; count: number }> = [];

  allKinds.forEach((k, gi) => {
    const items = (groups.get(k) ?? []).sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
    const angle = (gi / Math.max(1, allKinds.length)) * Math.PI * 2 - Math.PI / 2;
    const gx = cx + Math.cos(angle) * ringRx;
    const gy = cy + Math.sin(angle) * ringRy;
    const maxClusterR = items.length <= 1 ? 24 : Math.min(155, 38 + Math.sqrt(items.length) * 28);
    headers.push({
      x: gx,
      y: gy - maxClusterR - 18,
      title: items[0]?.kind_label || k,
      count: items.length,
    });

    items.forEach((n, ni) => {
      if (items.length === 1) {
        pos.set(n.key, { x: gx, y: gy });
        return;
      }
      const r = 28 + Math.sqrt(ni + 0.5) * 28;
      const theta = ni * 2.3999632297;
      pos.set(n.key, {
        x: gx + Math.cos(theta) * Math.min(r, maxClusterR),
        y: gy + Math.sin(theta) * Math.min(r * 0.88, maxClusterR * 0.88),
      });
    });
  });

  separateCollisions(pos, 42, 6);
  return { positions: pos, headers };
}

function computeForceLayout(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): {
  positions: Map<string, Point>;
  headers: Array<{ x: number; y: number; title: string; count: number }>;
} {
  const seed = computeRadialLayout(nodes).positions;
  const n = nodes.length;
  if (n === 0) return { positions: new Map(), headers: [] };

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const idxByKey = new Map<string, number>();

  nodes.forEach((node, i) => {
    idxByKey.set(node.key, i);
    const p = seed.get(node.key) ?? { x: WORLD_W / 2, y: WORLD_H / 2 };
    xs[i] = p.x;
    ys[i] = p.y;
  });

  const edgeIdx: Array<[number, number]> = [];
  for (const e of edges) {
    const a = idxByKey.get(e.source);
    const b = idxByKey.get(e.target);
    if (a !== undefined && b !== undefined && a !== b) edgeIdx.push([a, b]);
  }

  const iters = n > 180 ? 60 : 110;
  const cx = WORLD_W / 2;
  const cy = WORLD_H / 2;
  const repel = n > 140 ? 6500 : 10500;
  const idealDist = n > 140 ? 105 : 140;

  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / (iters + 12);
    for (let i = 0; i < n; i++) {
      let fx = (cx - xs[i]) * 0.004;
      let fy = (cy - ys[i]) * 0.0055;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = xs[i] - xs[j];
        const dy = ys[i] - ys[j];
        const d2 = dx * dx + dy * dy + 64;
        if (d2 > 220000) continue;
        const f = repel / d2;
        const d = Math.sqrt(d2);
        fx += (dx / d) * f;
        fy += (dy / d) * f;
      }
      vx[i] = (vx[i] + fx * cool) * 0.72;
      vy[i] = (vy[i] + fy * cool) * 0.72;
    }

    for (const [a, b] of edgeIdx) {
      const dx = xs[b] - xs[a];
      const dy = ys[b] - ys[a];
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const diff = (d - idealDist) * 0.028 * cool;
      const fx = (dx / d) * diff;
      const fy = (dy / d) * diff;
      vx[a] += fx;
      vy[a] += fy;
      vx[b] -= fx;
      vy[b] -= fy;
    }

    for (let i = 0; i < n; i++) {
      xs[i] = Math.max(54, Math.min(WORLD_W - 54, xs[i] + Math.max(-34, Math.min(34, vx[i]))));
      ys[i] = Math.max(54, Math.min(WORLD_H - 54, ys[i] + Math.max(-34, Math.min(34, vy[i]))));
    }
  }

  const pos = new Map<string, Point>();
  nodes.forEach((node, i) => pos.set(node.key, { x: xs[i], y: ys[i] }));
  separateCollisions(pos, 50, 10);
  return { positions: pos, headers: [] };
}

function nodeRadius(n: KnowledgeNode, isSelected: boolean, isInPath: boolean): number {
  const deg = n.degree ?? 0;
  const base = n.kind === "hall" ? 12
    : n.kind === "station" || n.kind === "insight" ? 10
    : n.kind === "alert" ? 10
    : 7.5;
  const boost = Math.min(6, Math.sqrt(deg) * 1.35);
  return base + boost + (isSelected ? 3 : isInPath ? 1.5 : 0);
}

function edgePath(a: Point, b: Point, curved: boolean): { d: string; mid: Point } {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (!curved) return { d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, mid: { x: mx, y: my } };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const bend = Math.min(28, dist * 0.11);
  const cx = mx - (dy / dist) * bend;
  const cy = my + (dx / dist) * bend;
  return {
    d: `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`,
    mid: { x: 0.25 * a.x + 0.5 * cx + 0.25 * b.x, y: 0.25 * a.y + 0.5 * cy + 0.25 * b.y },
  };
}

function formatMetaValue(v: unknown, key = ""): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Ja" : "Nein";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "number") {
    if (key === "gross" || key === "total_net" || key === "eur_m2") {
      return v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return Number.isInteger(v) ? v.toLocaleString("de-DE") : v.toLocaleString("de-DE", { maximumFractionDigits: 2 });
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const dt = new Date(v);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    }
  }
  return String(v);
}

const META_LABELS: Record<string, string> = {
  no: "Nummer",
  stock: "Bestand",
  eur_m2: "Preis (€/m²)",
  cat: "Kategorie",
  customer: "Kunde",
  gross: "Brutto (€)",
  due_date: "Fälligkeit",
  rush: "Eilauftrag",
  blocked: "Gesperrt",
  overdue: "Überfällig",
  n_parts: "Teile",
  thk: "Dicke (mm)",
  mat: "Werkstoff",
  type: "Typ",
  machine_kind: "Maschine",
  floor: "Ebene",
  staffed: "Besetzt",
  capacity_min_per_day: "Kapazität (Min/Tag)",
  battery_pct: "Akku (%)",
  speed_m_s: "Tempo (m/s)",
  state: "Zustand",
  carrier: "Spediteur",
  tracking: "Sendungsnr.",
  total_net: "Netto (€)",
  eta: "ETA",
  author: "Autor",
  metric: "Kennzahl",
  severity: "Schweregrad",
};

export default function KnowledgeGraph({
  onAnalyzeNode,
}: {
  onAnalyzeNode?: (node: KnowledgeNode, prompt: string) => void;
}) {
  const [data, setData] = useState<KnowledgeGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);

  // Filter & Ansichtsmodus
  const [activePreset, setActivePreset] = useState<PresetId>("all");
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [relationFilter, setRelationFilter] = useState("");
  const [query, setQuery] = useState("");
  const [focusKey, setFocusKey] = useState<string>("");
  const [focusDepth, setFocusDepth] = useState<number>(1);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("flow");
  const [showAllLabels, setShowAllLabels] = useState(false);

  // Auswahl, Hover, Pfadsuche
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [pathTargetSearch, setPathTargetSearch] = useState("");
  const [pathPickerOpen, setPathPickerOpen] = useState(false);
  const [activePath, setActivePath] = useState<KnowledgePathResult | null>(null);
  const [findingPath, setFindingPath] = useState(false);

  // Viewport (Pan/Zoom) + manuell gezogene Knotenpositionen
  const [viewBox, setViewBox] = useState<{ x: number; y: number; scale: number }>({ x: 0, y: 0, scale: 1 });
  const [dragOverrides, setDragOverrides] = useState<Record<string, Point>>({});
  const panState = useRef<{ active: boolean; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const dragNodeState = useRef<{ key: string; startX: number; startY: number; orig: Point; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Fehler / Hinweise
  const [error, setError] = useState("");

  // Erkenntnis anlegen / bearbeiten
  const [insightTitle, setInsightTitle] = useState("");
  const [insightDetail, setInsightDetail] = useState("");
  const [insightSeverity, setInsightSeverity] = useState("info");
  const [insightLinks, setInsightLinks] = useState<string[]>([]);
  const [linkSearch, setLinkSearch] = useState("");
  const [savingInsight, setSavingInsight] = useState(false);
  const [editingInsightKey, setEditingInsightKey] = useState<string | null>(null);

  // Manuelle Kante anlegen
  const [edgeFormOpen, setEdgeFormOpen] = useState(false);
  const [edgeTargetKey, setEdgeTargetKey] = useState("");
  const [edgeRelation, setEdgeRelation] = useState("verknüpft_mit");
  const [savingEdge, setSavingEdge] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await getKnowledgeGraph({
        kinds: selectedKinds.length ? selectedKinds : undefined,
        q: query.trim() || undefined,
        relation: relationFilter || undefined,
        focus: focusKey || undefined,
        depth: focusKey ? focusDepth : undefined,
        only_issues: onlyIssues || undefined,
        limit: 300,
      });
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedKinds, query, relationFilter, focusKey, focusDepth, onlyIssues]);

  useEffect(() => {
    const t = window.setTimeout(() => { void load(); }, 160);
    return () => window.clearTimeout(t);
  }, [load]);

  const applyPreset = (preset: typeof PRESETS[number]) => {
    setActivePreset(preset.id);
    setFocusKey("");
    setActivePath(null);
    setRelationFilter("");
    setSelectedKinds(preset.kinds ? [...preset.kinds] : []);
    setOnlyIssues(Boolean(preset.onlyIssues));
    setDragOverrides({});
    setViewBox({ x: 0, y: 0, scale: 1 });
  };

  const toggleKind = (k: string) => {
    setActivePreset("all");
    setOnlyIssues(false);
    setFocusKey("");
    setSelectedKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  };

  const onRebuild = async () => {
    setRebuilding(true);
    setError("");
    try {
      await rebuildKnowledgeGraph();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebuilding(false);
    }
  };

  const baseLayout = useMemo(() => {
    const nodes = data?.nodes ?? [];
    const edges = data?.edges ?? [];
    if (layoutMode === "force") return computeForceLayout(nodes, edges);
    if (layoutMode === "radial") return computeRadialLayout(nodes);
    return computeFlowLayout(nodes);
  }, [data?.nodes, data?.edges, layoutMode]);

  const positions = useMemo(() => {
    const merged = new Map<string, Point>(baseLayout.positions);
    for (const [k, pt] of Object.entries(dragOverrides)) {
      if (merged.has(k)) merged.set(k, pt);
    }
    return merged;
  }, [baseLayout.positions, dragOverrides]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, KnowledgeNode>();
    for (const n of data?.nodes ?? []) m.set(n.key, n);
    return m;
  }, [data?.nodes]);

  const selected = selectedKey ? nodeMap.get(selectedKey) ?? null : null;
  const hovered = hoveredKey ? nodeMap.get(hoveredKey) ?? null : null;
  const activeAnchor = hovered ?? selected;

  const connectedEdges = useMemo(() => {
    if (!selected || !data) return [];
    return data.edges.filter((e) => e.source === selected.key || e.target === selected.key);
  }, [selected, data]);

  const activeNeighborKeys = useMemo(() => {
    const s = new Set<string>();
    if (!activeAnchor || !data) return s;
    s.add(activeAnchor.key);
    for (const e of data.edges) {
      if (e.source === activeAnchor.key || e.target === activeAnchor.key) {
        s.add(e.source);
        s.add(e.target);
      }
    }
    return s;
  }, [activeAnchor, data]);

  const pathNodeSet = useMemo(() => new Set(activePath?.node_keys ?? []), [activePath]);
  const pathEdgeSet = useMemo(() => new Set(activePath?.edge_ids ?? []), [activePath]);

  // Synchronisiere Standard-Verknüpfung beim Auswahlwechsel (solange nicht im Edit-Modus)
  useEffect(() => {
    if (!editingInsightKey && selected && selected.source !== "insight") {
      setInsightLinks((prev) => (prev.length === 0 ? [selected.key] : prev));
    }
  }, [selected, editingInsightKey]);

  const fitPoints = useCallback((pts: Point[], maxScale = 1.45) => {
    if (!pts.length) {
      setViewBox({ x: 0, y: 0, scale: 1 });
      return;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = 95;
    const spanX = Math.max(280, maxX - minX + pad * 2);
    const spanY = Math.max(220, maxY - minY + pad * 2);
    const scale = Math.min(maxScale, Math.max(0.45, Math.min(WORLD_W / spanX, WORLD_H / spanY)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setViewBox({
      scale,
      x: WORLD_W / 2 - cx * scale,
      y: WORLD_H / 2 - cy * scale,
    });
  }, []);

  const fitView = useCallback(() => {
    fitPoints([...positions.values()], 1.35);
  }, [fitPoints, positions]);

  // Automatisch einpassen bei Layout-Wechsel, Ego-Netz oder neuem Datensatz
  useEffect(() => {
    if (!data?.nodes.length) return;
    fitPoints([...baseLayout.positions.values()], 1.25);
  }, [layoutMode, focusKey, focusDepth, data?.nodes.length, baseLayout.positions, fitPoints]);

  // Automatisch auf aktive Wirkungskette einpassen
  useEffect(() => {
    if (!activePath?.found || !activePath.node_keys.length) return;
    const pts = activePath.node_keys
      .map((k) => positions.get(k))
      .filter((p): p is Point => Boolean(p));
    if (pts.length) fitPoints(pts, 1.35);
  }, [activePath, positions, fitPoints]);

  const focusNodeInView = useCallback((key: string) => {
    setSelectedKey(key);
    const pts: Point[] = [];
    const center = positions.get(key);
    if (!center) return;
    pts.push(center);
    for (const e of data?.edges ?? []) {
      if (e.source === key || e.target === key) {
        const nb = positions.get(e.source === key ? e.target : e.source);
        if (nb) pts.push(nb);
      }
    }
    if (pts.length > 1) fitPoints(pts, 1.25);
    else {
      const scale = Math.max(1.1, Math.min(1.3, viewBox.scale));
      setViewBox({ scale, x: WORLD_W / 2 - center.x * scale, y: WORLD_H / 2 - center.y * scale });
    }
  }, [data?.edges, fitPoints, positions, viewBox.scale]);

  const clientToWorld = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const sx = ((clientX - rect.left) / Math.max(1, rect.width)) * WORLD_W;
    const sy = ((clientY - rect.top) / Math.max(1, rect.height)) * WORLD_H;
    return {
      x: (sx - viewBox.x) / viewBox.scale,
      y: (sy - viewBox.y) / viewBox.scale,
    };
  };

  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * WORLD_W;
    const sy = ((e.clientY - rect.top) / Math.max(1, rect.height)) * WORLD_H;
    const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
    setViewBox((prev) => {
      const nextScale = Math.max(0.35, Math.min(3.5, prev.scale * factor));
      const ratio = nextScale / prev.scale;
      return {
        scale: nextScale,
        x: sx - (sx - prev.x) * ratio,
        y: sy - (sy - prev.y) * ratio,
      };
    });
  };

  const onCanvasMouseDown = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".kg-node")) return;
    panState.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: viewBox.x,
      origY: viewBox.y,
    };
  };

  const onNodeMouseDown = (e: ReactMouseEvent, key: string) => {
    e.stopPropagation();
    const orig = positions.get(key);
    if (!orig) return;
    dragNodeState.current = {
      key,
      startX: e.clientX,
      startY: e.clientY,
      orig,
      moved: false,
    };
  };

  const onCanvasMouseMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (dragNodeState.current) {
      const d = dragNodeState.current;
      const dx = Math.abs(e.clientX - d.startX);
      const dy = Math.abs(e.clientY - d.startY);
      if (dx > 3 || dy > 3) {
        d.moved = true;
        const pt = clientToWorld(e.clientX, e.clientY);
        setDragOverrides((prev) => ({ ...prev, [d.key]: pt }));
      }
      return;
    }
    if (!panState.current?.active || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = WORLD_W / Math.max(1, rect.width);
    const scaleY = WORLD_H / Math.max(1, rect.height);
    const dx = (e.clientX - panState.current.startX) * scaleX;
    const dy = (e.clientY - panState.current.startY) * scaleY;
    setViewBox((prev) => ({
      ...prev,
      x: panState.current!.origX + dx,
      y: panState.current!.origY + dy,
    }));
  };

  const onCanvasMouseUp = () => {
    if (dragNodeState.current) {
      const { key, moved } = dragNodeState.current;
      dragNodeState.current = null;
      if (!moved) {
        setSelectedKey((cur) => (cur === key ? null : key));
      }
    }
    panState.current = null;
  };

  const runPathFinder = async (targetKey: string) => {
    if (!selected || !targetKey || findingPath) return;
    setFindingPath(true);
    setError("");
    try {
      const res = await findKnowledgePath(selected.key, targetKey, 6);
      setActivePath(res);
      setPathPickerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFindingPath(false);
    }
  };

  const submitInsight = async () => {
    if (!insightTitle.trim() || savingInsight) return;
    setSavingInsight(true);
    setError("");
    try {
      const targets = insightLinks.length
        ? insightLinks
        : (selected && selected.source !== "insight" ? [selected.key] : []);
      if (editingInsightKey) {
        await updateKnowledgeInsight(editingInsightKey, {
          title: insightTitle.trim(),
          detail: insightDetail.trim(),
          linked_keys: targets,
          severity: insightSeverity,
        });
        const keptKey = editingInsightKey;
        setEditingInsightKey(null);
        setInsightTitle("");
        setInsightDetail("");
        setInsightLinks([]);
        await load();
        setSelectedKey(keptKey);
      } else {
        const created = await addKnowledgeInsight({
          title: insightTitle.trim(),
          detail: insightDetail.trim(),
          linked_keys: targets,
          severity: insightSeverity,
        });
        setInsightTitle("");
        setInsightDetail("");
        setInsightLinks([]);
        await load();
        setSelectedKey(created.key);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingInsight(false);
    }
  };

  const startEditInsight = (node: KnowledgeNode) => {
    setEditingInsightKey(node.key);
    setInsightTitle(node.label);
    setInsightDetail(String(node.meta?.detail || node.subtitle || ""));
    setInsightSeverity(node.status || "info");
    const linked = (data?.edges ?? [])
      .filter((e) => e.source === node.key && e.source_kind === "insight")
      .map((e) => e.target);
    setInsightLinks(linked);
  };

  const removeInsight = async (key: string) => {
    try {
      await deleteKnowledgeNode(key);
      if (selectedKey === key) setSelectedKey(null);
      if (editingInsightKey === key) setEditingInsightKey(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submitCustomEdge = async () => {
    if (!selected || !edgeTargetKey || savingEdge) return;
    setSavingEdge(true);
    setError("");
    try {
      await addKnowledgeEdge({
        source_key: selected.key,
        target_key: edgeTargetKey,
        relation: edgeRelation.trim() || "verknüpft_mit",
      });
      setEdgeTargetKey("");
      setEdgeFormOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdge(false);
    }
  };

  const removeCustomEdge = async (edgeId: number) => {
    try {
      await deleteKnowledgeEdge(edgeId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const exportJson = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gimel-wissensgraph-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportSvg = () => {
    if (!svgRef.current) return;
    const serializer = new XMLSerializer();
    const raw = serializer.serializeToString(svgRef.current);
    const blob = new Blob([raw], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gimel-wissensgraph-${new Date().toISOString().slice(0, 10)}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const kinds = data?.stats.kinds ?? {};
  const byKind = data?.stats.by_kind ?? {};
  const byRelation = data?.stats.by_relation ?? {};
  const hotspots = data?.stats.hotspots;
  const lastSync = data?.last_rebuilt_at
    ? new Date(data.last_rebuilt_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  const candidateLinkNodes = useMemo(() => {
    const q = linkSearch.trim().toLowerCase();
    return (data?.nodes ?? [])
      .filter((n) => !insightLinks.includes(n.key) && n.key !== editingInsightKey)
      .filter((n) => !q || `${n.label} ${n.kind_label} ${n.key}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [data?.nodes, linkSearch, insightLinks, editingInsightKey]);

  const pathCandidates = useMemo(() => {
    const q = pathTargetSearch.trim().toLowerCase();
    return (data?.nodes ?? [])
      .filter((n) => n.key !== selected?.key)
      .filter((n) => !q || `${n.label} ${n.kind_label} ${n.key}`.toLowerCase().includes(q))
      .slice(0, 10);
  }, [data?.nodes, pathTargetSearch, selected?.key]);

  const metaEntries = useMemo(() => {
    if (!selected?.meta) return [];
    return Object.entries(selected.meta).filter(
      ([k, v]) => k !== "detail" && k !== "id" && k !== "materials" && v !== "" && v !== null && v !== undefined && v !== 0 && v !== false,
    );
  }, [selected]);

  const highlightActive = Boolean(activeAnchor || (activePath && activePath.found));

  return (
    <div className="kg-page">
      <div className="kg-head">
        <div className="kg-head-title">
          <h2>Plattform-Wissensgraph</h2>
          <span className="kg-sync-pill" title="Hintergrund-Routine synchronisiert alle Gimel-Module automatisch">
            <span className="kg-sync-dot" />
            Auto-Sync (alle {Math.round((data?.auto_sync_interval_s ?? 300) / 60)} Min.) · Stand {lastSync}
          </span>
          {(data?.stats.issue_count ?? 0) > 0 && (
            <button
              type="button"
              className={`kg-issue-pill${onlyIssues ? " is-active" : ""}`}
              onClick={() => applyPreset(PRESETS[1])}
              title="Alle Risiken, Engpässe, gesperrte/überfällige Aufträge & knappe Werkstoffe anzeigen"
            >
              <Icon icon="warning-sign" size={11} aria-hidden="true" />
              {data?.stats.issue_count} Auffälligkeiten
            </button>
          )}
        </div>
        <div className="kg-head-actions">
          <InputGroup
            small
            className="kg-search-input"
            leftIcon="search"
            rightElement={query ? (
              <Button minimal small icon="cross" aria-label="Suche leeren" onClick={() => setQuery("")} />
            ) : undefined}
            placeholder="Knoten suchen (Plotter, EPDM …)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <HTMLSelect
            minimal
            className="kg-rel-select"
            aria-label="Nach Relation filtern"
            value={relationFilter}
            onChange={(e) => setRelationFilter(e.target.value)}
          >
            <option value="">Alle Relationen</option>
            {Object.entries(byRelation)
              .sort((a, b) => b[1] - a[1])
              .map(([rel, cnt]) => (
                <option key={rel} value={rel}>{rel} ({cnt})</option>
              ))}
          </HTMLSelect>
          <div className="kg-layout-switch" role="group" aria-label="Layout wählen">
            {([
              ["flow", "Fluss", "flows"],
              ["force", "Netz", "graph"],
              ["radial", "Cluster", "ring"],
            ] as Array<[LayoutMode, string, string]>).map(([mode, label, icon]) => (
              <button
                key={mode}
                type="button"
                className={layoutMode === mode ? "is-active" : ""}
                onClick={() => { setLayoutMode(mode); setDragOverrides({}); setViewBox({ x: 0, y: 0, scale: 1 }); }}
                title={`${label}-Layout`}
              >
                <Icon icon={icon as any} size={11} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <Button
            small
            minimal
            icon="export"
            title="Als JSON exportieren"
            onClick={exportJson}
            disabled={!data}
          />
          <Button
            small
            intent="primary"
            icon="refresh"
            text="Synchronisieren"
            loading={rebuilding}
            onClick={() => void onRebuild()}
          />
        </div>
      </div>

      {/* Schnell-Ansichten & Knotentyp-Filter */}
      <div className="kg-filter-bar">
        <div className="kg-presets" role="group" aria-label="Ansichten">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`kg-preset-btn${activePreset === p.id && !focusKey ? " is-active" : ""}`}
              onClick={() => applyPreset(p)}
            >
              <Icon icon={p.icon as any} size={11} aria-hidden="true" />
              {p.label}
            </button>
          ))}
        </div>
        <div className="kg-filters" role="group" aria-label="Knotentypen filtern">
          <button
            type="button"
            className={`kg-filter-chip${selectedKinds.length === 0 && !onlyIssues ? " is-active" : ""}`}
            onClick={() => { setSelectedKinds([]); setOnlyIssues(false); setActivePreset("all"); }}
          >
            Alle ({data?.stats.total_nodes ?? 0})
          </button>
          {KIND_ORDER.filter((k) => k in kinds).map((k) => {
            const count = byKind[k] ?? 0;
            const on = selectedKinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                className={`kg-filter-chip${on ? " is-active" : ""}`}
                onClick={() => toggleKind(k)}
              >
                <span className="kg-kind-dot" style={{ background: KIND_COLOR[k] || "var(--lab-accent)" }} />
                {kinds[k]} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Aktiver Ego-Fokus oder Pfad-Banner */}
      {(focusKey || activePath) && (
        <div className="kg-context-strip">
          {focusKey && (
            <div className="kg-strip-item">
              <Icon icon="locate" size={12} aria-hidden="true" />
              <span>Ego-Netz: <strong>{nodeMap.get(focusKey)?.label || focusKey}</strong> ({focusDepth}-Hop)</span>
              <Button small minimal text={focusDepth === 1 ? "Auf 2-Hop erweitern" : "Auf 1-Hop begrenzen"}
                onClick={() => setFocusDepth((d) => (d === 1 ? 2 : 1))} />
              <Button small minimal icon="cross" text="Fokus aufheben" onClick={() => setFocusKey("")} />
            </div>
          )}
          {activePath && (
            <div className="kg-strip-item is-path">
              <Icon icon="path-search" size={12} aria-hidden="true" />
              {activePath.found ? (
                <span>
                  Wirkungskette ({activePath.hops} Schritte):{" "}
                  <strong>{activePath.steps.map((s) => s.label).join(" → ")}</strong>
                </span>
              ) : (
                <span>Keine Verbindungskette zwischen den beiden Knoten gefunden.</span>
              )}
              <Button small minimal icon="cross" onClick={() => setActivePath(null)} aria-label="Pfad schließen" />
            </div>
          )}
        </div>
      )}

      {error && <div className="kg-error">{error}</div>}

      <div className="kg-body">
        <div className="kg-canvas-wrap">
          <div className="kg-canvas-controls">
            <Button small minimal icon="zoom-in" title="Vergrößern"
              onClick={() => setViewBox((v) => ({ ...v, scale: Math.min(3.5, v.scale * 1.2) }))} />
            <Button small minimal icon="zoom-out" title="Verkleinern"
              onClick={() => setViewBox((v) => ({ ...v, scale: Math.max(0.35, v.scale / 1.2) }))} />
            <Button small minimal icon="zoom-to-fit" title="Alles einpassen" onClick={fitView} />
            <span className="kg-zoom-pct mono">{Math.round(viewBox.scale * 100)}%</span>
            <Button small minimal active={showAllLabels} icon="tag" text="Alle Labels"
              title="Alle Knotenbeschriftungen ein- oder ausblenden"
              onClick={() => setShowAllLabels((v) => !v)} />
            {Object.keys(dragOverrides).length > 0 && (
              <Button small minimal icon="reset" text="Positionen"
                title="Manuell verschobene Knoten zurücksetzen"
                onClick={() => setDragOverrides({})} />
            )}
            <Button small minimal icon="media" title="Als SVG speichern" onClick={exportSvg} disabled={!data} />
          </div>

          {loading && !data ? (
            <div className="kg-center"><Spinner size={28} /><span>Wissensgraph wird aufgebaut …</span></div>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${WORLD_W} ${WORLD_H}`}
              className="kg-svg"
              role="img"
              aria-label="Plattform-Wissensgraph"
              onWheel={onWheel}
              onMouseDown={onCanvasMouseDown}
              onMouseMove={onCanvasMouseMove}
              onMouseUp={onCanvasMouseUp}
              onMouseLeave={onCanvasMouseUp}
            >
              <defs>
                <marker id="kg-arrow" viewBox="0 0 8 8" refX="11" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--lab-line-strong)" opacity="0.7" />
                </marker>
                <marker id="kg-arrow-hi" viewBox="0 0 8 8" refX="11" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--lab-accent)" />
                </marker>
                <marker id="kg-arrow-path" viewBox="0 0 8 8" refX="11" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1 L 7 4 L 0 7 z" fill="#d97706" />
                </marker>
              </defs>

              <g transform={`translate(${viewBox.x}, ${viewBox.y}) scale(${viewBox.scale})`}>
                {/* Spalten-/Cluster-Überschriften */}
                {baseLayout.headers.map((h) => (
                  <g key={`${h.title}-${h.x}`} className="kg-group-header" transform={`translate(${h.x}, ${h.y})`}>
                    <text textAnchor="middle" className="kg-group-title">{h.title}</text>
                    <text y={13} textAnchor="middle" className="kg-group-count">{h.count}</text>
                  </g>
                ))}

                {/* Kanten */}
                {(data?.edges ?? []).map((e) => {
                  const a = positions.get(e.source);
                  const b = positions.get(e.target);
                  if (!a || !b) return null;
                  const onPath = pathEdgeSet.has(e.id);
                  const hi = onPath || (activeAnchor ? (e.source === activeAnchor.key || e.target === activeAnchor.key) : false);
                  const dim = highlightActive && !hi;
                  const { d, mid } = edgePath(a, b, layoutMode !== "flow" || Math.abs(a.x - b.x) < 60);
                  const strokeW = onPath ? 2.8 : hi ? 2.1 : Math.min(2.2, 0.9 + Math.log2(e.weight || 1) * 0.4);
                  return (
                    <g key={e.id}>
                      <path
                        d={d}
                        fill="none"
                        strokeWidth={strokeW}
                        markerEnd={onPath ? "url(#kg-arrow-path)" : hi ? "url(#kg-arrow-hi)" : "url(#kg-arrow)"}
                        className={`kg-edge${onPath ? " is-path" : hi ? " is-hi" : ""}${dim ? " is-dim" : ""}${e.source_kind === "insight" ? " is-insight" : ""}`}
                      />
                      {hi && (
                        <g transform={`translate(${mid.x}, ${mid.y})`} className="kg-edge-pill">
                          <rect x={-(e.relation.length * 3.2 + 6)} y={-8} width={e.relation.length * 6.4 + 12} height={15} rx={4} />
                          <text y={3} textAnchor="middle">{e.relation}</text>
                        </g>
                      )}
                    </g>
                  );
                })}

                {/* Knoten */}
                {(data?.nodes ?? []).map((n) => {
                  const p = positions.get(n.key);
                  if (!p) return null;
                  const isSel = selected?.key === n.key;
                  const isHov = hovered?.key === n.key;
                  const isPath = pathNodeSet.has(n.key);
                  const isNeighbor = activeNeighborKeys.has(n.key);
                  const dim = highlightActive && !isNeighbor && !isPath;
                  const color = KIND_COLOR[n.kind] || "var(--lab-accent)";
                  const r = nodeRadius(n, isSel, isPath);
                  const showLabel =
                    showAllLabels ||
                    isSel ||
                    isHov ||
                    isPath ||
                    (activeAnchor != null && isNeighbor) ||
                    viewBox.scale >= 1.35 ||
                    n.kind === "hall" ||
                    n.kind === "alert" ||
                    n.kind === "insight" ||
                    (n.degree ?? 0) >= 6 ||
                    (data?.nodes.length ?? 0) <= 28;

                  return (
                    <g
                      key={n.key}
                      className={`kg-node${isSel ? " is-sel" : ""}${isPath ? " is-path" : ""}${dim ? " is-dim" : ""}${n.attention ? ` is-att-${n.attention}` : ""}`}
                      transform={`translate(${p.x}, ${p.y})`}
                      onMouseDown={(ev) => onNodeMouseDown(ev, n.key)}
                      onMouseEnter={() => setHoveredKey(n.key)}
                      onMouseLeave={() => setHoveredKey((cur) => (cur === n.key ? null : cur))}
                    >
                      {n.attention === "danger" && <circle r={r + 5} className="kg-halo is-danger" />}
                      {n.attention === "warning" && <circle r={r + 4} className="kg-halo is-warning" />}
                      {isPath && <circle r={r + 5} className="kg-halo is-path" />}
                      {n.kind === "insight" ? (
                        <rect
                          x={-r} y={-r} width={r * 2} height={r * 2} rx={3}
                          transform="rotate(45)"
                          fill={color}
                          className="kg-node-shape"
                        />
                      ) : n.kind === "hall" || n.kind === "station" ? (
                        <rect
                          x={-r} y={-r} width={r * 2} height={r * 2} rx={4}
                          fill={color}
                          className="kg-node-shape"
                        />
                      ) : (
                        <circle r={r} fill={color} className="kg-node-shape" />
                      )}
                      {showLabel && (
                        <text y={r + 12} textAnchor="middle" className={`kg-node-label${isSel || isHov || isPath ? " is-strong" : ""}`}>
                          {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          )}

          {/* Hover-Karte unten links im Canvas */}
          {hovered && (
            <div className="kg-hover-card" role="status">
              <span className="kg-kind-dot" style={{ background: KIND_COLOR[hovered.kind] || "var(--lab-accent)" }} />
              <div className="kg-hover-main">
                <strong>{hovered.label}</strong>
                <span>{hovered.kind_label}{hovered.subtitle ? ` · ${hovered.subtitle}` : ""}</span>
              </div>
              <Tag minimal>{hovered.degree ?? 0} Verb.</Tag>
            </div>
          )}

          <div className="kg-canvas-foot">
            <span>
              {data?.nodes.length ?? 0} von {data?.stats.total_nodes ?? 0} Knoten · {data?.edges.length ?? 0} Kanten
            </span>
            <span>Ziehen zum Verschieben · Mausrad zum Zoomen · Knoten anklicken für Details</span>
          </div>
        </div>

        <aside className="kg-inspector">
          {selected ? (
            <div className="kg-inspect-card">
              <div className="kg-inspect-head">
                <div className="kg-inspect-tags">
                  <Tag minimal style={{ borderLeft: `3px solid ${KIND_COLOR[selected.kind] || "var(--lab-accent)"}` }}>
                    {selected.kind_label}
                  </Tag>
                  {selected.status && (
                    <Tag
                      minimal
                      intent={
                        selected.attention === "danger" ? "danger"
                          : selected.attention === "warning" ? "warning"
                          : "none"
                      }
                    >
                      {selected.status}
                    </Tag>
                  )}
                </div>
                <div className="kg-inspect-head-btns">
                  {selected.source === "insight" && (
                    <>
                      <Button small minimal icon="edit" title="Erkenntnis bearbeiten"
                        onClick={() => startEditInsight(selected)} />
                      <Button small minimal intent="danger" icon="trash" title="Erkenntnis löschen"
                        onClick={() => void removeInsight(selected.key)} />
                    </>
                  )}
                  <Button small minimal icon="cross" title="Auswahl aufheben" onClick={() => setSelectedKey(null)} />
                </div>
              </div>

              <h3>{selected.label}</h3>
              {selected.subtitle && !(selected.source === "insight" && typeof selected.meta?.detail === "string" && selected.meta.detail) && (
                <p className="kg-inspect-sub">{selected.subtitle}</p>
              )}
              {typeof selected.meta?.detail === "string" && selected.meta.detail && (
                <div className="kg-inspect-detail">{selected.meta.detail}</div>
              )}
              <div className="kg-inspect-key mono">
                {selected.key} · {selected.in_degree ?? 0} eingehend · {selected.out_degree ?? 0} ausgehend
              </div>

              {/* Aktionsleiste für den Knoten */}
              <div className="kg-inspect-actions">
                {onAnalyzeNode && (
                  <Button
                    small
                    intent="primary"
                    icon="chat"
                    text="Im Chat analysieren"
                    onClick={() => {
                      const prompt = `Analysiere den Wissensgraph-Knoten „${selected.label}“ (${selected.key}, Typ: ${selected.kind_label}, Status: ${selected.status || "—"}). Prüfe seine direkten und indirekten Verbindungen mit query_knowledge_graph, identifiziere Engpässe oder Risiken und schlage konkrete Maßnahmen vor.`;
                      onAnalyzeNode(selected, prompt);
                    }}
                  />
                )}
                <Button
                  small
                  minimal
                  active={focusKey === selected.key}
                  icon="locate"
                  text={focusKey === selected.key ? "Ego-Netz aus" : "Ego-Netz"}
                  title="Nur direkte Nachbarschaft dieses Knotens anzeigen"
                  onClick={() => {
                    if (focusKey === selected.key) setFocusKey("");
                    else { setFocusKey(selected.key); setFocusDepth(1); }
                  }}
                />
                <Button
                  small
                  minimal
                  active={pathPickerOpen}
                  icon="path-search"
                  text="Pfad"
                  title="Kürzeste Wirkungskette zu einem anderen Knoten finden"
                  onClick={() => { setPathPickerOpen((v) => !v); setEdgeFormOpen(false); }}
                />
                <Button
                  small
                  minimal
                  active={edgeFormOpen}
                  icon="link"
                  text="Verknüpfen"
                  title="Manuelle Verbindung zu anderem Knoten anlegen"
                  onClick={() => { setEdgeFormOpen((v) => !v); setPathPickerOpen(false); }}
                />
              </div>

              {/* Pfad-Auswahl */}
              {pathPickerOpen && (
                <div className="kg-subform">
                  <span className="kg-subform-title">Wirkungskette suchen bis …</span>
                  <InputGroup
                    small
                    leftIcon="search"
                    placeholder="Zielknoten suchen …"
                    value={pathTargetSearch}
                    onChange={(e) => setPathTargetSearch(e.target.value)}
                  />
                  <div className="kg-picker-list">
                    {pathCandidates.map((c) => (
                      <button key={c.key} type="button" disabled={findingPath} onClick={() => void runPathFinder(c.key)}>
                        <span className="kg-kind-dot" style={{ background: KIND_COLOR[c.kind] || "var(--lab-accent)" }} />
                        <span>{c.label}</span>
                        <span className="kg-picker-kind">{c.kind_label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Manuelle Kante */}
              {edgeFormOpen && (
                <div className="kg-subform">
                  <span className="kg-subform-title">Verbindung von „{selected.label}“ anlegen</span>
                  <InputGroup
                    small
                    placeholder="Relation (z. B. blockiert, ersetzt, priorisiert)"
                    value={edgeRelation}
                    onChange={(e) => setEdgeRelation(e.target.value)}
                  />
                  <HTMLSelect
                    fill
                    value={edgeTargetKey}
                    onChange={(e) => setEdgeTargetKey(e.target.value)}
                  >
                    <option value="">Zielknoten wählen …</option>
                    {(data?.nodes ?? [])
                      .filter((n) => n.key !== selected.key)
                      .slice(0, 120)
                      .map((n) => (
                        <option key={n.key} value={n.key}>
                          [{n.kind_label}] {n.label}
                        </option>
                      ))}
                  </HTMLSelect>
                  <Button
                    small
                    intent="primary"
                    icon="link"
                    text="Verbindung speichern"
                    loading={savingEdge}
                    disabled={!edgeTargetKey}
                    onClick={() => void submitCustomEdge()}
                  />
                </div>
              )}

              {/* Metadaten */}
              {metaEntries.length > 0 && (
                <div className="kg-inspect-section">
                  <strong>Eigenschaften</strong>
                  <dl className="kg-meta-grid">
                    {metaEntries.slice(0, 8).map(([k, v]) => (
                      <div key={k} className="kg-meta-row">
                        <dt>{META_LABELS[k] || k}</dt>
                        <dd>{formatMetaValue(v, k)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {/* Verbindungen */}
              <div className="kg-inspect-section">
                <strong>Verbindungen ({connectedEdges.length})</strong>
                {connectedEdges.length === 0 ? (
                  <p className="kg-muted">Keine direkten Kanten im aktuellen Filter.</p>
                ) : (
                  <ul className="kg-rel-list">
                    {connectedEdges.map((e) => {
                      const otherKey = e.source === selected.key ? e.target : e.source;
                      const other = nodeMap.get(otherKey);
                      const dir = e.source === selected.key ? "→" : "←";
                      return (
                        <li key={e.id} className="kg-rel-item">
                          <button type="button" className="kg-rel-jump" onClick={() => focusNodeInView(otherKey)}>
                            <span className="kg-kind-dot" style={{ background: KIND_COLOR[other?.kind || ""] || "var(--lab-accent)" }} />
                            <span className="kg-rel-name">{dir} {e.relation}</span>
                            <span className="kg-rel-target">{other?.label || otherKey}</span>
                          </button>
                          {e.source_kind === "insight" && (
                            <Button small minimal icon="trash" title="Manuelle Kante entfernen"
                              onClick={() => void removeCustomEdge(e.id)} />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="kg-overview-card">
              <div className="kg-overview-head">
                <Icon icon="graph" size={16} aria-hidden="true" />
                <strong>Überblick &amp; Hotspots</strong>
              </div>
              <p className="kg-muted">
                Klicke auf einen Knoten im Graphen oder springe direkt zu kritischen Punkten und Knotenpunkten:
              </p>

              {(hotspots?.issues.length ?? 0) > 0 && (
                <div className="kg-inspect-section">
                  <div className="kg-section-head">
                    <strong>
                      Auffälligkeiten (
                      {(data?.stats.issue_count ?? hotspots!.issues.length) > hotspots!.issues.length
                        ? `${hotspots!.issues.length} von ${data?.stats.issue_count}`
                        : hotspots!.issues.length}
                      )
                    </strong>
                    <Button small minimal text="Alle filtern" onClick={() => applyPreset(PRESETS[1])} />
                  </div>
                  <ul className="kg-rel-list">
                    {hotspots!.issues.map((item) => (
                      <li key={item.key} className="kg-rel-item">
                        <button type="button" className="kg-rel-jump" onClick={() => focusNodeInView(item.key)}>
                          <span className="kg-kind-dot" style={{ background: item.attention === "danger" ? "#dc2626" : "#d97706" }} />
                          <span className="kg-rel-target">{item.label}</span>
                          <Tag minimal intent={item.attention === "danger" ? "danger" : "warning"}>{item.status}</Tag>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(hotspots?.hubs.length ?? 0) > 0 && (
                <div className="kg-inspect-section">
                  <strong>Zentrale Knotenpunkte</strong>
                  <ul className="kg-rel-list">
                    {hotspots!.hubs.slice(0, 6).map((hub) => (
                      <li key={hub.key} className="kg-rel-item">
                        <button type="button" className="kg-rel-jump" onClick={() => focusNodeInView(hub.key)}>
                          <span className="kg-kind-dot" style={{ background: KIND_COLOR[hub.kind] || "var(--lab-accent)" }} />
                          <span className="kg-rel-target">{hub.label}</span>
                          <span className="kg-rel-name">{hub.degree} Verb.</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Erkenntnis-Formular (Neu & Bearbeiten, Mehrfach-Verknüpfung) */}
          <div className="kg-insight-form">
            <div className="kg-insight-form-head">
              <h4>
                <Icon icon="lightbulb" size={13} aria-hidden="true" />
                {editingInsightKey
                  ? "Erkenntnis bearbeiten"
                  : selected && selected.source !== "insight"
                    ? `Erkenntnis zu „${selected.label}“`
                    : "Neue Erkenntnis im Graphen"}
              </h4>
              {editingInsightKey && (
                <Button small minimal text="Abbrechen" onClick={() => {
                  setEditingInsightKey(null);
                  setInsightTitle("");
                  setInsightDetail("");
                  setInsightLinks([]);
                }} />
              )}
            </div>
            <InputGroup
              small
              placeholder="Titel der Erkenntnis …"
              value={insightTitle}
              onChange={(e) => setInsightTitle(e.target.value)}
            />
            <TextArea
              small
              fill
              rows={2}
              placeholder="Begründung, Analyse oder Entscheidung (optional)"
              value={insightDetail}
              onChange={(e) => setInsightDetail(e.target.value)}
            />
            {insightLinks.length > 0 && (
              <div className="kg-link-chips">
                {insightLinks.map((k) => (
                  <Tag
                    key={k}
                    minimal
                    onRemove={() => setInsightLinks((prev) => prev.filter((x) => x !== k))}
                  >
                    {nodeMap.get(k)?.label || k}
                  </Tag>
                ))}
              </div>
            )}
            <InputGroup
              small
              leftIcon="link"
              placeholder="Weitere Knoten verknüpfen (suchen) …"
              value={linkSearch}
              onChange={(e) => setLinkSearch(e.target.value)}
            />
            {linkSearch.trim() && candidateLinkNodes.length > 0 && (
              <div className="kg-picker-list is-compact">
                {candidateLinkNodes.map((n) => (
                  <button
                    key={n.key}
                    type="button"
                    onClick={() => {
                      setInsightLinks((prev) => (prev.includes(n.key) ? prev : [...prev, n.key]));
                      setLinkSearch("");
                    }}
                  >
                    <span className="kg-kind-dot" style={{ background: KIND_COLOR[n.kind] || "var(--lab-accent)" }} />
                    <span>{n.label}</span>
                    <span className="kg-picker-kind">{n.kind_label}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="kg-insight-row">
              <HTMLSelect
                value={insightSeverity}
                onChange={(e) => setInsightSeverity(e.target.value)}
                options={[
                  { value: "info", label: "Hinweis" },
                  { value: "warning", label: "Warnung" },
                  { value: "danger", label: "Kritisch" },
                ]}
              />
              <Button
                small
                intent="primary"
                icon={editingInsightKey ? "floppy-disk" : "plus"}
                text={editingInsightKey ? "Aktualisieren" : "Speichern"}
                loading={savingInsight}
                disabled={!insightTitle.trim()}
                onClick={() => void submitInsight()}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
