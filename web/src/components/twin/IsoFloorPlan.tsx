import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonGroup, Icon } from "@blueprintjs/core";
import {
  Floor,
  FlowEdge,
  Station,
  TYPE_LABEL,
  doorDirection,
  effectiveDoorKind,
  obstacleHeight,
  obstacleKind,
  routePoints,
  sceneBounds,
  stationCorners,
} from "../../factory";
import { StationMark } from "./marks";
import { DASH, StatusDefs, StatusGlyph } from "./StationShape";
import type { StationModelImage } from "./modelPreview";
import { AISLE_LANE_M, aisleNetworkMetres, aisleWays, hallHeight, lanePolygon, manualWays, polygonPath, wayArrows } from "./aisleWays";
import { buildTwinWorld, clearWays } from "./collision";

/* Die Halle als halb-dreidimensionales Schaubild.

   Warum keine echte 3D-Engine: Gimel soll ohne WebGL, ohne zusätzliche
   Abhängigkeit und ohne GPU-Zwang auf jedem Werker-Rechner laufen. Eine
   isometrische Projektion in SVG liefert genau das, was der Leitstand braucht —
   Höhe, Flächen, Wege und Blickrichtung — und bleibt gleichzeitig scharf,
   druckbar, tastaturbedienbar und mit den vorhandenen Marken testbar.

   Geräte — hochgeladen oder eingebaut — werden einmal mit derselben Isometrie
   in ein transparentes Bild gerendert und als <image> eingelegt. Ohne WebGL
   bleibt der Stationskörper stehen; die Karte selbst funktioniert weiter.

   Die Karte rechnet weiter in Metern. `project()` ist die einzige Abbildung
   Meter → Bildschirm; alle Beschriftungen werden anschließend in Pixeln
   gesetzt, damit sie beim Zoomen nicht mitwachsen. */

const ISO_COS = Math.cos(Math.PI / 6);
const ISO_SIN = Math.sin(Math.PI / 6);
const WALL_H = 0.85;
/** Abstand der Dachträger im Hallenrahmen, in Metern. */
const TRUSS_M = 8;

interface Vb { x: number; y: number; w: number; h: number }
type P2 = [number, number];

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function dist(a: P2, b: P2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function pointsAttr(points: P2[]): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

function pathOf(points: P2[]): string {
  if (!points.length) return "";
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ") + " Z";
}

/** Höhe einer Station in Metern. Sie ist eine Darstellung, keine Messung:
    Maschinen sind niedriger als Regale, Büro und Versand flacher. */
function isoHeight(s: Station): number {
  if (s.is_storage) return 2.35;
  switch (s.type) {
    case "warehouse": return 2.35;
    case "accounting": return 1.55;
    case "shipping": return 1.45;
    case "production": return s.machine_kind === "waterjet" ? 1.95 : s.machine_kind === "manual" ? 1.25 : 1.45;
    default: return 1.3;
  }
}

/** Eine Fäche, die auf dem Boden liegt, als isometrisches Polygon. */
function floorPolygon(points: [number, number][], project: (x: number, y: number, z?: number) => P2): string {
  return pathOf(points.map(([x, y]) => project(x, y, 0)));
}

/** Kubischer Punkt bei t — dieselbe Kurve, die der Weg zeichnet. */
function curvePoint(a: P2, c1: P2, c2: P2, b: P2, t: number): P2 {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
    u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1],
  ];
}

/** Richtung der Kurve an t — für Pfeilspitzen, die wirklich dorthin zeigen. */
function curveTangent(a: P2, c1: P2, c2: P2, b: P2, t: number): P2 {
  const u = 1 - t;
  return [
    3 * u * u * (c1[0] - a[0]) + 6 * u * t * (c2[0] - c1[0]) + 3 * t * t * (b[0] - c2[0]),
    3 * u * u * (c1[1] - a[1]) + 6 * u * t * (c2[1] - c1[1]) + 3 * t * t * (b[1] - c2[1]),
  ];
}

/** Punkt und Richtung auf einem Linienzug, nach zurückgelegter Länge. */
function polylineSample(points: P2[], t: number): { at: P2; angle: number } {
  if (points.length < 2) return { at: points[0] ?? [0, 0], angle: 0 };
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = dist(points[i], points[i + 1]);
    lens.push(d); total += d;
  }
  if (total <= 1e-9) return { at: points[0], angle: 0 };
  const target = Math.max(0, Math.min(1, t)) * total;
  let run = 0;
  for (let i = 0; i < lens.length; i++) {
    if (run + lens[i] >= target || i === lens.length - 1) {
      const u = lens[i] > 0 ? (target - run) / lens[i] : 0;
      const a = points[i], b = points[i + 1];
      return { at: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], angle: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
    }
    run += lens[i];
  }
  return { at: points[points.length - 1], angle: 0 };
}

function polylinePath(points: P2[]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
}

/** Ein sauberer Richtungspfeil auf dem Weg. */
function FlowChevron({ at, angle, fs, colour, strong = false }: {
  at: P2; angle: number; fs: (px: number) => number; colour: string; strong?: boolean;
}) {
  const w = strong ? fs(7) : fs(4.6);
  const h = strong ? fs(4.8) : fs(5.2);
  return (
    <g transform={`translate(${at[0]} ${at[1]}) rotate(${angle})`} pointerEvents="none">
      <path d={`M${-w * 0.55} ${-h} L${w * 0.55} 0 L${-w * 0.55} ${h}`}
        fill="none" stroke={colour} strokeWidth={strong ? 2.6 : 1.8}
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
        opacity={strong ? 0.95 : 0.8} />
    </g>
  );
}

function statusColour(kind: StationMark["kind"]): string {
  switch (kind) {
    case "laeuft": return "var(--gimel-accent)";
    case "wartet": return "var(--g-info)";
    case "frei": return "var(--g-success-2)";
    case "voll": return "var(--g-warning)";
    case "ueber": return "var(--g-danger)";
    case "unbekannt": return "var(--g-muted)";
    case "inaktiv": return "var(--g-muted)";
  }
}

function makeProjection(base: { x: number; y: number; w: number; h: number }, yaw: number) {
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  const c = Math.cos(rad(yaw));
  const s = Math.sin(rad(yaw));
  // Isometrie: erst die Halle um die Kameraachse drehen, dann 30° kippen.
  const a = ISO_COS * (c - s);
  const cc = -ISO_COS * (c + s);
  const b = ISO_SIN * (c + s);
  const d = ISO_SIN * (c - s);
  const e = -(a * cx + cc * cy);
  const f = -(b * cx + d * cy);
  const project = (x: number, y: number, z = 0): P2 => [a * x + cc * y + e, b * x + d * y + f - z];
  const matrix = `matrix(${a} ${b} ${cc} ${d} ${e} ${f})`;
  return { project, matrix };
}

function projectedBounds(
  floor: Floor,
  stations: Station[],
  project: (x: number, y: number, z?: number) => P2,
): Vb {
  const pts: P2[] = [];
  const add = (p: P2) => { pts.push(p); };
  const ceiling = hallHeight(floor);
  for (const [x, y] of floor.outline ?? []) {
    add(project(x, y, 0));
    add(project(x, y, WALL_H));
    // Der Hallenrahmen ragt bis unter das Dach; das Bild muss ihn mit einpassen.
    add(project(x, y, ceiling));
  }
  for (const z of floor.zones ?? []) for (const [x, y] of z.points ?? []) add(project(x, y, 0));
  for (const o of floor.obstacles ?? []) {
    const oh = obstacleHeight(o, ceiling);
    for (const [x, y] of o.points ?? []) add(project(x, y, oh));
  }
  for (const [x, y] of floor.aisles?.nodes ?? []) add(project(x, y, 0));
  for (const door of floor.doors ?? []) add(project(door.x, door.y, WALL_H));
  for (const s of stations) {
    const h = isoHeight(s);
    for (const [x, y] of stationCorners(s)) {
      add(project(x, y, 0));
      add(project(x, y, h));
    }
  }
  if (!pts.length) return { x: -12, y: -8, w: 24, h: 16 };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const padX = Math.max(1.4, (maxX - minX) * 0.09);
  const padY = Math.max(1.1, (maxY - minY) * 0.11);
  return {
    x: minX - padX,
    y: minY - padY,
    w: Math.max(maxX - minX + padX * 2, 8),
    h: Math.max(maxY - minY + padY * 2, 6),
  };
}

export interface IsoFloorPlanProps {
  floor: Floor;
  stations: Station[];
  selectedId?: number | null;
  highlightIds?: number[];
  status?: Record<number, StationMark>;
  flow?: FlowEdge[];
  highlightRoutesTo?: number | null;
  onStationClick?: (s: Station) => void;
  /** Nur diesen Weg zeigen — der Filter bleibt in der Seite. */
  onFilterEdge?: (edge: FlowEdge) => void;
  height?: number | null;
  /** ``lanes`` zeichnet Fahrspuren, ``paths`` Handwege, ``frame`` Stützen und
      Dachträger der Halle — alles ergänzend zur bestehenden Karte. */
  show?: Partial<Record<"zones" | "obstacles" | "aisles" | "doors" | "grid" | "flow" | "labels" | "lanes" | "paths" | "frame", boolean>>;
}

export default function IsoFloorPlan({
  floor,
  stations,
  selectedId = null,
  highlightIds,
  status,
  flow = [],
  highlightRoutesTo = null,
  onStationClick,
  onFilterEdge,
  height = 480,
  show = {},
}: IsoFloorPlanProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [yaw, setYaw] = useState(0);
  const [vb, setVb] = useState<Vb>({ x: -20, y: -20, w: 40, h: 40 });
  const [userMoved, setUserMoved] = useState(false);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [edgeInfo, setEdgeInfo] = useState<FlowEdge | null>(null);
  /** Bilder der hochgeladenen Modelle, gerendert mit derselben Isometrie. */
  const [modelImages, setModelImages] = useState<{ yaw: number; byId: Record<number, StationModelImage> }>({ yaw: 0, byId: {} });

  const vis = {
    zones: true, obstacles: true, aisles: true, doors: true,
    grid: true, flow: true, labels: true,
    lanes: true, paths: true, frame: true, ...show,
  };
  const hallH = hallHeight(floor);
  const ways = useMemo(() => aisleWays(floor), [floor]);
  const storedPaths = useMemo(() => manualWays(floor), [floor]);
  const netMetres = useMemo(() => aisleNetworkMetres(floor), [floor]);
  const world = useMemo(() => buildTwinWorld(floor, stations), [floor, stations]);
  /** Fahrspuren enden an der Kante eines Körpers, statt hindurchzulaufen. */
  const displayWays = useMemo(() => clearWays(ways, world, {
    radius: AISLE_LANE_M / 2, groups: ["station", "obstacle"], step: 0.4,
  }), [ways, world]);

  // Gerätebilder: hochgeladene Modelle und die eingebauten Geräte werden
  // einmal je Blickwinkel mit derselben Isometrie gerendert. Ohne WebGL
  // bleibt der Stationskörper stehen.
  const modelKey = stations
    .filter((s) => s.id != null)
    .map((s) => [s.id, s.model_file, s.model_kind ?? "", s.type, s.machine_kind, s.is_storage ? 1 : 0,
      s.colour, s.label, s.model_scale, s.model_rotation, s.rotation, s.w, s.h].join(":"))
    .join("|");
  useEffect(() => {
    if (!modelKey) {
      setModelImages({ yaw, byId: {} });
      return;
    }
    let alive = true;
    setModelImages((prev) => (prev.yaw === yaw ? prev : { yaw, byId: {} }));
    void import("./modelPreview").then(async (mod) => {
      const list = stations.filter((s) => s.id != null);
      const rows = await Promise.all(list.map(async (s) => [s.id!, await mod.stationModelImage(s, yaw)] as const));
      if (!alive) return;
      const byId: Record<number, StationModelImage> = {};
      for (const [id, image] of rows) if (image) byId[id] = image;
      setModelImages({ yaw, byId });
    }).catch(() => { /* Vorschau ist eine Zugabe, nie Voraussetzung. */ });
    return () => { alive = false; };
  }, [modelKey, yaw]);

  const base = useMemo(() => sceneBounds(floor, stations), [floor, stations]);
  const { project, matrix } = useMemo(() => makeProjection(base, yaw), [base, yaw]);
  const fit = useMemo(() => projectedBounds(floor, stations, project), [floor, stations, project]);

  useEffect(() => {
    if (!userMoved) setVb(fit);
  }, [fit, userMoved]);

  // Die Bühne messen: nur so können Schrift und Klickziele in Pixeln stehen.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      // Das SVG sitzt innerhalb des Stage-Paddings; für Schrift und Klickziele
      // zählt die echte Zeichenfläche, nicht der Rahmen.
      const box = svgRef.current?.getBoundingClientRect();
      setStage({
        w: box && box.width > 0 ? box.width : el.clientWidth,
        h: box && box.height > 0 ? box.height : el.clientHeight,
      });
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  const view = useMemo<Vb>(() => {
    if (!stage.w || !stage.h) return vb;
    const aspect = stage.w / stage.h;
    if (aspect > vb.w / vb.h) {
      const w = vb.h * aspect;
      return { x: vb.x - (w - vb.w) / 2, y: vb.y, w, h: vb.h };
    }
    const h = vb.w / aspect;
    return { x: vb.x, y: vb.y - (h - vb.h) / 2, w: vb.w, h };
  }, [vb, stage.w, stage.h]);

  /** Bildschirmpixel → Projektionseinheiten. */
  const ppm = stage.w > 0 ? stage.w / view.w : 40;
  const fs = useCallback((px: number) => px / ppm, [ppm]);
  /** Auf dem Telefon bleibt der Name; Zustand und Typ stehen im Inspektor. */
  const compact = stage.w > 0 && stage.w < 620;

  const resetZoom = useCallback(() => {
    setVb(fit);
    setUserMoved(false);
    setYaw(0);
  }, [fit]);

  const zoomBy = useCallback((factor: number) => {
    setVb((v) => {
      const w = Math.min(Math.max(v.w * factor, fit.w / 20), fit.w * 4);
      const h = w * (v.h / v.w);
      return { x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h };
    });
    setUserMoved(true);
  }, [fit]);

  const rotate = (delta: number) => {
    setYaw((y) => (y + delta + 360) % 360);
    setUserMoved(false);
  };

  const toProjected = useCallback((clientX: number, clientY: number): P2 => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const ctm = svg.getScreenCTM();
    if (!ctm) return [0, 0];
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return [pt.x, pt.y];
  }, []);

  // Nur mit Strg/Meta zoomen; das Rad allein gehört der Seite.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const [mx, my] = toProjected(e.clientX, e.clientY);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      setVb((v) => {
        const w = Math.min(Math.max(v.w * factor, fit.w / 20), fit.w * 4);
        const h = w * (v.h / v.w);
        return { x: mx - (mx - v.x) * (w / v.w), y: my - (my - v.y) * (h / v.h), w, h };
      });
      setUserMoved(true);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toProjected, fit]);

  const panRef = useRef<{ px: number; py: number; vb: Vb; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest(".floor-station")) return;
    panRef.current = { px: e.clientX, py: e.clientY, vb, moved: false };
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = panRef.current;
    if (!p) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = ((e.clientX - p.px) * p.vb.w * (view.w / vb.w)) / (rect.width || 1);
    const dy = ((e.clientY - p.py) * p.vb.h * (view.h / vb.h)) / (rect.height || 1);
    if (Math.abs(e.clientX - p.px) + Math.abs(e.clientY - p.py) > 3) p.moved = true;
    setVb({ ...p.vb, x: p.vb.x - dx, y: p.vb.y - dy });
    setUserMoved(true);
  };

  const onPointerUp = () => { panRef.current = null; };
  const onPointerLeave = () => { panRef.current = null; };

  const byId = useMemo(() => {
    const m: Record<number, Station> = {};
    for (const s of stations) if (s.id != null) m[s.id] = s;
    return m;
  }, [stations]);

  // Von hinten nach vorn zeichnen — sonst überdeckt eine ferne Station eine nahe.
  const ordered = useMemo(() => {
    return [...stations].sort((a, b) => {
      const pa = project(a.x, a.y, 0);
      const pb = project(b.x, b.y, 0);
      return pa[1] - pb[1];
    });
  }, [stations, project]);

  const outline = floor.outline?.length ? floor.outline : [];
  const hallPath = outline.length ? floorPolygon(outline, project) : "";
  const wallBottom = outline.map(([x, y]) => project(x, y, 0));
  const wallTop = outline.map(([x, y]) => project(x, y, WALL_H));
  const wallBand = wallBottom.length
    ? pathOf(wallBottom) + " " + pathOf([...wallTop].reverse())
    : "";
  const bg = !floor.bg || floor.bg === "#f5f5f0" ? "var(--g-floor-hall)" : floor.bg;

  const gridM = floor.grid && floor.grid > 0 ? floor.grid : 1;

  /** Der Hallenrahmen: Stützen an den Ecken, Dachkante und Querträger. Er ist
      nur ein Drahtgerüst — die Stationen bleiben frei sichtbar. */
  const frame = useMemo(() => {
    if (outline.length < 3) return { rim: [] as P2[], columns: [] as [P2, P2][], trusses: [] as [P2, P2][] };
    const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = maxX - minX, spanY = maxY - minY;
    const alongX = spanX >= spanY;
    const count = Math.min(6, Math.max(1, Math.floor(Math.max(spanX, spanY) / TRUSS_M)));
    const trusses: [P2, P2][] = [];
    for (let i = 0; i < count; i++) {
      const v = (i + 1) / (count + 1);
      if (alongX) {
        const x = minX + spanX * v;
        trusses.push([project(x, minY, hallH), project(x, maxY, hallH)]);
      } else {
        const y = minY + spanY * v;
        trusses.push([project(minX, y, hallH), project(maxX, y, hallH)]);
      }
    }
    return {
      rim: outline.map(([x, y]) => project(x, y, hallH)),
      columns: outline.map(([x, y]) => [project(x, y, 0), project(x, y, hallH)] as [P2, P2]),
      trusses,
    };
  }, [outline, project, hallH]);

  const maxFlow = useMemo(() => Math.max(1, ...flow.map((e) => e.count)), [flow]);

  const links = useMemo(() => {
    const aisles = floor.aisles ?? { nodes: [], edges: [] };
    return flow.map((edge, idx) => {
      const a = byId[edge.from];
      const b = byId[edge.to];
      if (!a || !b) return null;
      const routed = routePoints(aisles, [a.x, a.y], [b.x, b.y], floor.obstacles ?? [], floor.outline ?? []);
      // Der Weg liegt auf dem Boden. In der isometrischen Ansicht heben wir
      // ihn nur wenige Zentimeter an, damit er nicht im Hallenboden verschwindet.
      let route = routed.points.map(([x, y]) => project(x, y, 0.13));
      if (route.length < 2) route = [project(a.x, a.y, 0.13), project(b.x, b.y, 0.13)];
      const mid = polylineSample(route, 0.5).at;
      const active = highlightRoutesTo == null || edge.from === highlightRoutesTo || edge.to === highlightRoutesTo;
      return { edge, idx, a, b, route, mid, active };
    }).filter(Boolean) as {
      edge: FlowEdge; idx: number; a: Station; b: Station;
      route: P2[]; mid: P2; active: boolean;
    }[];
  }, [flow, byId, project, highlightRoutesTo, floor]);

  const activeEdge = edgeInfo
    ? links.find((l) => l.edge.from === edgeInfo.from && l.edge.to === edgeInfo.to) ?? null
    : null;

  /** Alle Stationsdaten einmal rechnen. Körper und Beschriftung werden getrennt
      gezeichnet: die Wege laufen dazwischen, also über dem 3D-Objekt und unter
      dem Namen. */
  const stationViews = useMemo(() => ordered.map((s) => {
    const mark = s.id != null ? status?.[s.id] : undefined;
    if (!mark) return null;
    const h = isoHeight(s);
    const corners = stationCorners(s);
    const bottom = corners.map(([x, y]) => project(x, y, 0));
    const top = corners.map(([x, y]) => project(x, y, h));
    const [cx, cy] = project(s.x, s.y, h);
    const ground = project(s.x, s.y, 0);
    const model = s.id != null && modelImages.yaw === yaw ? modelImages.byId[s.id] : undefined;
    const topW = Math.max(...top.map((p, i) => dist(p, top[(i + 1) % top.length])));
    const topH = Math.min(...top.map((p, i) => dist(p, top[(i + 1) % top.length])));
    const inside = topW * ppm > Math.max(70, s.label.length * 6.2 + 36) && topH * ppm > 28;
    const selected = s.id != null && s.id === selectedId;
    const highlighted = s.id != null && !!highlightIds?.includes(s.id);
    const hollow = mark.kind === "frei" || mark.kind === "unbekannt" || mark.kind === "inaktiv";
    const ratio = mark.ratio;
    const dimmed = !s.active || (highlightRoutesTo != null && s.id !== highlightRoutesTo
      && !links.some((l) => l.active && (l.edge.from === s.id || l.edge.to === s.id)));
    const cls = "floor-station twin-station iso-station twin-" + mark.kind
      + (selected ? " floor-station-sel" : "")
      + (s.active ? "" : " floor-station-off")
      + (dimmed ? " iso-dim" : "");
    const line = mark.lineSpoken !== mark.spoken ? `, ${mark.lineSpoken}` : "";
    const aria = `${s.label}, ${mark.spoken}${line}`;
    const textCls = inside ? "twin-text-on" : "twin-text-off";
    const nameY = inside ? cy - fs(2) : cy - fs(25);
    const wordY = nameY + fs(14);
    const glyphX = inside ? cx - fs(Math.min(topW * ppm * 0.5 - 12, 80)) : cx - fs(10);
    const glyphY = inside ? cy - fs(11) : cy - fs(39);
    const hitW = Math.max(fs(44), topW + fs(18));
    return { s, mark, h, bottom, top, cx, cy, ground, model, topW, topH, inside, selected, highlighted, hollow, ratio, dimmed, cls, aria, textCls, nameY, wordY, glyphX, glyphY, hitW };
  }).filter(Boolean) as {
    s: Station; mark: StationMark; h: number; bottom: P2[]; top: P2[];
    cx: number; cy: number; ground: P2; model?: StationModelImage;
    topW: number; topH: number; inside: boolean;
    selected: boolean; highlighted: boolean; hollow: boolean; ratio: number | null;
    dimmed: boolean; cls: string; aria: string; textCls: string;
    nameY: number; wordY: number; glyphX: number; glyphY: number; hitW: number;
  }[], [ordered, status, project, ppm, compact, selectedId, highlightIds, highlightRoutesTo, links, fs, modelImages, yaw]);

  return (
    <div className="floor-card iso-card">
      <div className="floor-toolbar iso-toolbar">
        <span className="floor-hint iso-hint">
          <span className="iso-badge"><Icon icon="cube" size={12} aria-hidden /> Semi-3D</span>
          Ziehen schwenkt · Strg+Rad zoomt · Klick auf eine Station öffnet sie · Klick auf einen Weg zeigt die Verbindung.
        </span>
        <div className="iso-tools">
          <ButtonGroup minimal className="iso-camera">
            <Button icon="undo" aria-label="Kamera nach links drehen" title="Kamera nach links drehen" onClick={() => rotate(-45)} />
            <Button icon="redo" aria-label="Kamera nach rechts drehen" title="Kamera nach rechts drehen" onClick={() => rotate(45)} />
            <Button icon="compass" aria-label="Kamera zurücksetzen" title="Kamera zurücksetzen" onClick={resetZoom} />
          </ButtonGroup>
          <span className="iso-yaw mono" aria-hidden="true">{String(yaw).padStart(2, "0")}°</span>
          <ButtonGroup minimal>
            <Button icon="zoom-out" aria-label="Herauszoomen" title="Herauszoomen" onClick={() => zoomBy(1.25)} />
            <Button icon="zoom-in" aria-label="Hineinzoomen" title="Hineinzoomen" onClick={() => zoomBy(1 / 1.25)} />
            <Button icon="locate" aria-label="Auf Grundriss einpassen" title="Auf Grundriss einpassen" onClick={() => { setVb(fit); setUserMoved(false); }} />
          </ButtonGroup>
        </div>
      </div>
      <div className="floor-stage iso-stage" ref={stageRef} style={height == null ? undefined : { height }}>
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          className={"floor-svg iso-svg" + (userMoved ? " floor-zoomed" : "")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onPointerCancel={onPointerUp}
          role="img"
          aria-label={`${floor.name || "Halle"} in Semi-3D`}
        >
          <StatusDefs fs={fs} />
          <defs>
            <pattern id="iso-grid" width={gridM} height={gridM} patternUnits="userSpaceOnUse" patternTransform={matrix}>
              <path d={`M ${gridM} 0 L 0 0 0 ${gridM}`} fill="none"
                stroke="var(--g-floor-grid)" strokeWidth={0.028} opacity={0.85} />
            </pattern>
            <pattern id="iso-hatch" width={0.34} height={0.34} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={0.34} stroke="var(--g-floor-on-station)" strokeWidth={0.055} opacity={0.7} />
            </pattern>
            <pattern id="iso-cross" width={0.4} height={0.4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <path d="M0 0 V0.4 M0 0 H0.4" stroke="var(--g-floor-off-line)" strokeWidth={0.035} fill="none" opacity={0.8} />
            </pattern>
            <marker id="iso-arrow-supply" viewBox="0 0 10 10" refX="8.6" refY="5"
              markerUnits="userSpaceOnUse" markerWidth={fs(10)} markerHeight={fs(10)} orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--g-flow-supply)" />
            </marker>
            <marker id="iso-arrow-ship" viewBox="0 0 10 10" refX="8.6" refY="5"
              markerUnits="userSpaceOnUse" markerWidth={fs(10)} markerHeight={fs(10)} orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--g-flow-ship)" />
            </marker>
            <filter id="iso-shadow-blur" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation={fs(2.2)} />
            </filter>
          </defs>

          <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="var(--g-floor-outside)"
            onClick={() => setEdgeInfo(null)} />

          {/* Hallenboden, Raster und Wände. */}
          {hallPath && <path d={hallPath} fill={bg} onClick={() => setEdgeInfo(null)} />}
          {hallPath && vis.grid && <path d={hallPath} fill="url(#iso-grid)" opacity={0.9} />}
          {vis.zones && (floor.zones ?? []).map((z, i) => {
            const zx = z.points?.length ? z.points.reduce((a, p) => a + p[0], 0) / z.points.length : 0;
            const zy = z.points?.length ? z.points.reduce((a, p) => a + p[1], 0) / z.points.length : 0;
            const c = project(zx, zy, 0);
            return (
              <g key={`zone-${i}`} className="iso-zone" pointerEvents="none">
                {z.points?.length >= 3 && (
                  <path d={floorPolygon(z.points, project)} fill={z.colour} fillOpacity={0.1}
                    stroke={z.colour} strokeOpacity={0.45} strokeWidth={1.2}
                    strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />
                )}
                {vis.labels && z.name && (
                  <text x={c[0]} y={c[1] + fs(4)} textAnchor="middle" fontSize={fs(11)}
                    className="iso-zone-label" style={{ strokeWidth: fs(3) }}>{z.name}</text>
                )}
              </g>
            );
          })}
          {hallPath && wallBand && (
            <g className="iso-walls" pointerEvents="none">
              <path d={wallBand} fill="var(--g-floor-wall)" fillRule="evenodd" opacity={0.72} />
              <polyline points={pointsAttr(wallTop)} fill="none" stroke="var(--g-floor-wall-top)"
                strokeWidth={2.2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </g>
          )}

          {/* Hallenrahmen: das Gebäude als Gerüst, nicht als verdeckendes Dach. */}
          {vis.frame && hallPath && (
            <g className="iso-hall-frame" pointerEvents="none">
              <polyline points={pointsAttr(frame.rim)} fill="none"
                stroke="var(--g-hall-frame)" strokeWidth={1.6} strokeLinejoin="round"
                vectorEffect="non-scaling-stroke" opacity={0.6} />
              {frame.trusses.map(([a, b], i) => (
                <line key={`t-${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                  stroke="var(--g-hall-frame)" strokeWidth={1.1} strokeDasharray="5 4"
                  vectorEffect="non-scaling-stroke" opacity={0.38} />
              ))}
              {frame.columns.map(([a, b], i) => (
                <g key={`c-${i}`}>
                  <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                    stroke="var(--g-iso-side)" strokeWidth={2.4} strokeLinecap="round"
                    vectorEffect="non-scaling-stroke" opacity={0.72} />
                  <circle cx={a[0]} cy={a[1]} r={fs(2.6)}
                    fill="var(--g-iso-side)" opacity={0.8} />
                </g>
              ))}
            </g>
          )}

          {/* Hindernisse & Bauteile: Wände, Raumboxen, Stützen, Zäune und Regale bekommen echte Höhe. */}
          {vis.obstacles && (floor.obstacles ?? []).map((o, i) => {
            if (!o.points?.length) return null;
            const kind = obstacleKind(o);
            const h = obstacleHeight(o, hallH);
            const bottom = o.points.map(([x, y]) => project(x, y, 0));
            const top = o.points.map(([x, y]) => project(x, y, h));
            const sideOpacity = kind === "wall" || kind === "room" || kind === "column" || kind === "round_column" ? 0.74 : kind === "fence" ? 0.28 : 0.52;
            const topFill = kind === "room" ? "var(--g-surface-2)" : kind === "wall" || kind === "column" || kind === "round_column" ? "var(--g-iso-top)" : "var(--g-floor-hatch)";
            const topOpacity = kind === "room" || kind === "wall" || kind === "column" || kind === "round_column" ? 0.82 : kind === "fence" ? 0.15 : 0.42;
            const stroke = kind === "fence" ? "var(--g-floor-warn)" : kind === "room" || kind === "wall" ? "var(--g-iso-side-line)" : "var(--g-muted)";
            return (
              <g key={`ob-${i}`} className="iso-obstacle" data-kind={kind} pointerEvents="none">
                {bottom.map((p, j) => {
                  const q = bottom[(j + 1) % bottom.length];
                  const tq = top[(j + 1) % top.length];
                  const tp = top[j];
                  return <polygon key={j} points={pointsAttr([p, q, tq, tp])} className="iso-side"
                    fillOpacity={sideOpacity}
                    stroke={kind === "fence" ? "var(--g-floor-warn)" : undefined}
                    strokeDasharray={kind === "fence" ? "4 3" : undefined}
                    vectorEffect="non-scaling-stroke" />;
                })}
                <polygon points={pointsAttr(top)} fill={topFill} fillOpacity={topOpacity}
                  stroke={stroke} strokeWidth={kind === "wall" || kind === "room" ? 1.4 : 1}
                  strokeDasharray={kind === "fence" ? "4 3" : undefined}
                  vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}

          {/* Fahrspuren: dieselben Polygone wie im Plan und in 3D, nur isometrisch
              projiziert. Handwege liegen als durchgezogene Linie darüber. */}
          {vis.aisles && vis.lanes && displayWays.length > 0 && (
            <g className="iso-aisle-lanes" pointerEvents="none">
              {displayWays.map((w, i) => (
                <path key={`lane-${i}`} className={"iso-aisle-lane " + (w.kind === "path" ? "iso-aisle-lane-path" : "")}
                  d={polygonPath(lanePolygon(w.points, AISLE_LANE_M).map(([x, y]) => project(x, y, 0.014)))}
                  fill="var(--g-floor-aisle-lane)" fillOpacity={w.kind === "path" ? 0.5 : 0.8}
                  stroke="var(--g-floor-aisle-edge)" strokeWidth={1.3} strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          )}
          {vis.paths && storedPaths.length > 0 && (
            <g className="iso-aisle-paths" pointerEvents="none">
              {storedPaths.map((w, i) => (
                <path key={`path-${i}`} className="iso-aisle-path"
                  d={polylinePath(w.points.map(([x, y]) => project(x, y, 0.03)))}
                  fill="none" stroke="var(--g-floor-aisle)" strokeWidth={2.1}
                  strokeLinecap="round" strokeLinejoin="round" opacity={0.8}
                  vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          )}
          {vis.aisles && vis.lanes && vis.labels && displayWays.length > 0 && (
            <g className="iso-aisle-arrows" pointerEvents="none" opacity={0.45}>
              {displayWays.flatMap((w, i) => wayArrows(w.points).map((a, j) => {
                const p = project(a.at[0], a.at[1], 0.035);
                const q = project(a.at[0] + a.dir[0] * 0.2, a.at[1] + a.dir[1] * 0.2, 0.035);
                return <FlowChevron key={`arr-${i}-${j}`} at={p}
                  angle={Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI}
                  fs={fs} colour="var(--g-floor-aisle)" />;
              }))}
            </g>
          )}

          {/* Gänge: das gerechnete Netz, dezent auf dem Boden. */}
          {vis.aisles && floor.aisles?.nodes?.length > 0 && (
            <g className="iso-aisles" pointerEvents="none">
              {(floor.aisles.edges ?? []).map(([i, j], k) => {
                const a = floor.aisles.nodes[i], b = floor.aisles.nodes[j];
                if (!a || !b) return null;
                const p = project(a[0], a[1], 0.02);
                const q = project(b[0], b[1], 0.02);
                return <line key={k} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]}
                  stroke="var(--g-floor-aisle)" strokeWidth={1.4} strokeDasharray="0.5 0.35"
                  opacity={0.4} vectorEffect="non-scaling-stroke" />;
              })}
              {(floor.aisles.nodes ?? []).map((p, i) => {
                const q = project(p[0], p[1], 0.03);
                return <circle key={`n-${i}`} cx={q[0]} cy={q[1]} r={0.1}
                  fill="var(--g-floor-aisle)" opacity={0.5} />;
              })}
            </g>
          )}

          {/* Förderbänder in Semi-3D (mit Bandhöhe z und Stützen). */}
          {(floor.conveyors ?? []).length > 0 && (
            <g className="iso-conveyors" pointerEvents="none">
              {(floor.conveyors ?? []).map((conv, ci) => {
                const pts = (conv.points ?? []).map((p) => [p[0], p[1], p[2] ?? 0.9] as [number, number, number]);
                if (pts.length < 2) return null;
                const projected = pts.map(([x, y, z]) => project(x, y, z));
                const wPx = Math.max(3, (conv.width || 0.7) * 8);
                return (
                  <g key={`conv-${ci}`}>
                    {pts.map(([x, y, z], pi) => {
                      const base = project(x, y, 0);
                      const top = projected[pi];
                      return (
                        <line key={`leg-${pi}`} x1={base[0]} y1={base[1]} x2={top[0]} y2={top[1]}
                          stroke="var(--g-muted)" strokeWidth={1.6} opacity={0.75} vectorEffect="non-scaling-stroke" />
                      );
                    })}
                    <path d={polylinePath(projected)} fill="none" stroke="var(--g-text-2)"
                      strokeWidth={wPx + 2} strokeLinecap="round" strokeLinejoin="round" opacity={0.8}
                      vectorEffect="non-scaling-stroke" />
                    <path d={polylinePath(projected)} fill="none" stroke="var(--g-info)"
                      strokeWidth={wPx} strokeLinecap="round" strokeLinejoin="round" opacity={0.85}
                      vectorEffect="non-scaling-stroke" />
                    {vis.labels && conv.name && (() => {
                      const mid = projected[Math.floor(projected.length / 2)];
                      return (
                        <text x={mid[0]} y={mid[1] - fs(8)} textAnchor="middle" fontSize={fs(9.5)}
                          className="iso-door-label" style={{ strokeWidth: fs(2.5) }}>
                          {conv.name}
                        </text>
                      );
                    })()}
                  </g>
                );
              })}
            </g>
          )}

          {/* Tore: auf der Wand, mit Namen. */}
          {vis.doors && (floor.doors ?? []).map((d, i) => {
            const [ux, uy] = doorDirection(floor, d);
            const half = (d.width || 2.5) / 2;
            const a = project(d.x - ux * half, d.y - uy * half, WALL_H * 0.45);
            const b = project(d.x + ux * half, d.y + uy * half, WALL_H * 0.45);
            const mid = project(d.x, d.y, WALL_H * 0.45);
            const kind = effectiveDoorKind(d);
            const colour =
              kind === "gate" ? "var(--g-floor-warn)"
              : kind === "ramp" ? "var(--g-flow-supply)"
              : kind === "stair" ? "#0d9488"
              : kind === "lift" ? "#4f46e5"
              : kind === "emergency" ? "#16a34a"
              : kind === "window" ? "#0284c7"
              : "var(--g-flow-ship)";
            return (
              <g key={`door-${i}`} className="floor-door" pointerEvents="none">
                <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={colour}
                  strokeWidth={5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="var(--g-surface)"
                  strokeWidth={1.6} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                {vis.labels && d.name && (
                  <text x={mid[0]} y={mid[1] - fs(7)} textAnchor="middle" fontSize={fs(10.5)}
                    className="iso-door-label" style={{ strokeWidth: fs(3) }}>{d.name}</text>
                )}
              </g>
            );
          })}

          {/* Breite Klickflächen für die Wege — unter den Körpern, damit ein
              Klick auf eine Maschine immer die Maschine trifft. */}
          {vis.flow && (
            <g className="iso-link-hits">
              {links.map((l) => {
                const d = polylinePath(l.route);
                return <path key={`hit-${l.idx}`} d={d} fill="none" stroke="transparent"
                  strokeWidth={14} strokeLinecap="round" vectorEffect="non-scaling-stroke"
                  pointerEvents="stroke" style={{ cursor: "pointer" }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); setEdgeInfo(l.edge); }} />;
              })}
            </g>
          )}

          {/* Stationen: nur der Körper. Die Beschriftung kommt nach den Wegen,
              damit ein erhöhter Weg nie über einem Namen liegt. */}
          {stationViews.map((v) => {
            const { s, mark, h, bottom, top, cx, cy, ground, model, selected, highlighted, hollow, ratio, cls, aria, hitW,
              textCls, nameY, wordY, glyphX, glyphY, inside } = v;
            return (
              <g key={s.id ?? s.label} className={cls} data-status={mark.kind}
                data-certainty={mark.certainty} role="button" tabIndex={0} aria-label={aria}
                aria-pressed={selected}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseEnter={() => setHoverId(s.id ?? null)}
                onMouseLeave={() => setHoverId(null)}
                onFocus={() => setHoverId(s.id ?? null)}
                onBlur={() => setHoverId(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onStationClick?.(s); }
                }}
                onClick={(e) => { e.stopPropagation(); setEdgeInfo(null); onStationClick?.(s); }}>
                <title>{`${s.label}: ${mark.word}`}</title>

                <rect className="twin-hit" x={cx - hitW / 2} y={cy - fs(32)} width={hitW} height={fs(64)}
                  fill="transparent" />

                <polygon points={pointsAttr(bottom)} fill="rgb(var(--g-shadow-rgb) / 0.16)"
                  filter="url(#iso-shadow-blur)" pointerEvents="none"
                  transform={`translate(0 ${fs(3)})`} />
                {bottom.map((p, i) => {
                  const q = bottom[(i + 1) % bottom.length];
                  const tp = top[i], tq = top[(i + 1) % top.length];
                  return <polygon key={`side-${i}`} className="iso-side" points={pointsAttr([p, q, tq, tp])}
                    fillOpacity={i % 2 ? 0.9 : 0.76} pointerEvents="none" />;
                })}

                <g transform={`translate(0 ${-h})`}>
                  <g transform={matrix}>
                    <g transform={`translate(${s.x} ${s.y}) rotate(${s.rotation})`}>
                      <rect className={"twin-body iso-top" + (hollow ? " twin-body-hollow" : "")}
                        x={-s.w / 2} y={-s.h / 2} width={s.w} height={s.h} rx={0.14}
                        data-station-id={s.id}
                        strokeDasharray={DASH[mark.certainty]} vectorEffect="non-scaling-stroke" />
                      {mark.kind === "ueber" && (
                        <rect className="twin-hatch" x={-s.w / 2} y={-s.h / 2} width={s.w} height={s.h}
                          rx={0.14} fill="url(#iso-hatch)" pointerEvents="none" />
                      )}
                      {mark.kind === "inaktiv" && (
                        <rect className="twin-cross" x={-s.w / 2} y={-s.h / 2} width={s.w} height={s.h}
                          rx={0.14} fill="url(#iso-cross)" pointerEvents="none" />
                      )}
                      {mark.running && (
                        <rect className="twin-edge" x={-s.w / 2} y={-s.h / 2} width={0.22} height={s.h}
                          pointerEvents="none" />
                      )}
                      {ratio != null && ratio > 0 && (
                        <g className="twin-load" pointerEvents="none">
                          <rect className="twin-load-track" x={-s.w / 2} y={s.h / 2 - 0.26}
                            width={s.w} height={0.26} />
                          <rect className="twin-load-fill" x={-s.w / 2} y={s.h / 2 - 0.26}
                            width={s.w * Math.min(1, ratio)} height={0.26} />
                        </g>
                      )}
                    </g>
                  </g>
                </g>

                {/* Das hochgeladene Modell liegt über dem Körper und unter den
                    Statuskanten: es zeigt die Maschine, verdeckt aber nie die
                    Auswahl. */}
                {model && (
                  <image className="iso-model" href={model.url}
                    x={ground[0] + model.x} y={ground[1] + model.y}
                    width={model.w} height={model.h} preserveAspectRatio="none"
                    pointerEvents="none" aria-hidden="true" />
                )}

                <g transform={`translate(0 ${-h})`}>
                  <g transform={matrix}>
                    <g transform={`translate(${s.x} ${s.y}) rotate(${s.rotation})`}>
                      <line className="iso-status-edge" x1={-s.w / 2 + 0.12} y1={s.h / 2 - 0.04}
                        x2={s.w / 2 - 0.12} y2={s.h / 2 - 0.04}
                        stroke={statusColour(mark.kind)} strokeWidth={selected ? 0.16 : 0.1}
                        strokeDasharray={mark.kind === "unbekannt" ? "0.3 0.2" : undefined}
                        strokeLinecap="round" pointerEvents="none" />
                      {highlighted && (
                        <rect className="twin-ring twin-ring-find" x={-s.w / 2 - 0.18} y={-s.h / 2 - 0.18}
                          width={s.w + 0.36} height={s.h + 0.36} rx={0.2} vectorEffect="non-scaling-stroke" />
                      )}
                      {selected && (
                        <rect className="twin-ring" x={-s.w / 2 - 0.12} y={-s.h / 2 - 0.12}
                          width={s.w + 0.24} height={s.h + 0.24} rx={0.18} vectorEffect="non-scaling-stroke" />
                      )}
                    </g>
                  </g>
                </g>

                {/* Unsichtbarer Spiegel für die bestehenden DOM-Verträge der
                    Leitstand-Tests; sichtbar ist die Ebene über den Wegen. */}
                <g className="twin-mirror" aria-hidden="true" opacity={0}>
                  <g className={"twin-glyph " + (hollow ? "twin-glyph-off" : "twin-glyph-on")}>
                    <StatusGlyph kind={mark.kind} />
                  </g>
                  <text className={`twin-name ${textCls}`} x={cx} y={nameY} fontSize={fs(12)}>{s.label}</text>
                  <text className={`twin-word ${textCls}`} x={cx} y={wordY} fontSize={fs(11)}>{mark.line}</text>
                </g>
              </g>
            );
          })}

          {/* Wege über den Körpern: der Bogen ist erhöht, nicht hinter der Maschine. */}
          {vis.flow && links.map((l) => {
            const colour = l.edge.kind === "supply" ? "var(--g-flow-supply)" : "var(--g-flow-ship)";
            const width = 1.8 + 2.6 * (l.edge.count / maxFlow);
            const active = l.active;
            const chosen = edgeInfo?.from === l.edge.from && edgeInfo?.to === l.edge.to;
            const hover = hoverId != null && (hoverId === l.edge.from || hoverId === l.edge.to);
            const d = polylinePath(l.route);
            return (
              <g key={`link-${l.idx}`} className={"twin-link" + (active ? "" : " twin-link-dim") + (chosen ? " twin-link-chosen" : "") + (hover ? " twin-link-hover" : "")}
                style={{ color: colour }} pointerEvents="none">
                <path d={d} fill="none" stroke="rgb(var(--g-shadow-rgb) / 0.24)" strokeWidth={width + 5}
                  strokeLinecap="round" transform={`translate(0 ${fs(3)})`} vectorEffect="non-scaling-stroke" opacity={0.6} />
                <path d={d} fill="none" stroke={colour} strokeWidth={width + 9} strokeLinecap="round"
                  opacity={active ? 0.11 : 0.03} vectorEffect="non-scaling-stroke" />
                <path d={d} fill="none" stroke={colour} strokeWidth={width} strokeLinecap="round"
                  opacity={active ? 0.9 : 0.25} vectorEffect="non-scaling-stroke" />
                <path d={d} fill="none" stroke="rgb(255 255 255 / 0.28)" strokeWidth={Math.max(0.8, width * 0.26)}
                  strokeLinecap="round" opacity={active ? 0.85 : 0.15}
                  vectorEffect="non-scaling-stroke" pointerEvents="none" />
                <path className="iso-flow-run" d={d} fill="none" stroke="var(--g-surface)" strokeWidth={Math.max(1.1, width * 0.42)}
                  pathLength={100} strokeDasharray="0.8 11" strokeLinecap="round" opacity={active ? 0.9 : 0.25}
                  vectorEffect="non-scaling-stroke" pointerEvents="none" />
              </g>
            );
          })}

          {/* Namen und Zustand zuletzt: sie bleiben lesbar, auch wenn ein Weg
              über die Maschine führt. */}
          {vis.labels && (
            <g className="iso-labels" pointerEvents="none">
              {stationViews.map((v) => {
                const { s, mark, cx, cy, inside, hollow, glyphX, glyphY, nameY, wordY, textCls } = v;
                return (
                  <g key={`label-${s.id ?? s.label}`} className={"iso-label " + (hollow ? "iso-label-hollow" : "iso-label-solid")}>
                    <g className={"twin-glyph " + (hollow ? "twin-glyph-off" : "twin-glyph-on")}
                      transform={`translate(${glyphX} ${glyphY}) scale(${fs(1)})`}>
                      {(mark.kind === "ueber" || !inside) && <circle r={10} className="twin-glyph-disc" />}
                      <StatusGlyph kind={mark.kind} />
                    </g>
                    <text className={`twin-name ${textCls}`} x={cx} y={nameY} textAnchor="middle"
                      fontSize={fs(12)} style={{ strokeWidth: fs(3) }}>{s.label}</text>
                    {!compact && (
                      <text className={`twin-word ${textCls}`} x={cx} y={wordY} textAnchor="middle"
                        fontSize={fs(11)} style={{ strokeWidth: fs(3) }}>{mark.line}</text>
                    )}
                    {!compact && inside && (
                      <text className={`iso-type ${textCls}`} x={cx} y={wordY + fs(13)} textAnchor="middle"
                        fontSize={fs(9.5)} opacity={0.8} style={{ strokeWidth: fs(2.6) }}>
                        {TYPE_LABEL[s.type]}{s.subtype ? ` · ${s.subtype}` : ""}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          )}

          {/* Richtungspfeile über den Maschinen: der Weg ist erhöht, also darf
              die Spitze sichtbar über dem Dach liegen. */}
          {vis.flow && links.map((l) => {
            const colour = l.edge.kind === "supply" ? "var(--g-flow-supply)" : "var(--g-flow-ship)";
            const len = l.route.reduce((sum, p, i) => i ? sum + dist(l.route[i - 1], p) : sum, 0);
            const ts = len > 12 ? [0.24, 0.48, 0.71] : [0.34, 0.62];
            return (
              <g key={`chev-${l.idx}`} className={"iso-chevrons" + (l.active ? "" : " twin-link-dim")}
                opacity={l.active ? 1 : 0.35} pointerEvents="none">
                {ts.map((t) => {
                  const s = polylineSample(l.route, t);
                  return <FlowChevron key={t} at={s.at} angle={s.angle} fs={fs} colour={colour} />;
                })}
                {(() => { const s = polylineSample(l.route, 0.88); return <FlowChevron at={s.at} angle={s.angle} fs={fs} colour={colour} strong />; })()}
              </g>
            );
          })}

          {/* Wege-Etiketten liegen über allem: erst so bleiben Zahl und Maß lesbar. */}
          {vis.flow && vis.labels && links.map((l) => {
            const colour = l.edge.kind === "supply" ? "var(--g-flow-supply)" : "var(--g-flow-ship)";
            const active = l.active;
            const chosen = edgeInfo?.from === l.edge.from && edgeInfo?.to === l.edge.to;
            const hover = hoverId != null && (hoverId === l.edge.from || hoverId === l.edge.to);
            const nearby = selectedId != null && (selectedId === l.edge.from || selectedId === l.edge.to);
            const full = chosen || hover || nearby;
            const metres = l.edge.metres.toLocaleString("de-DE", { maximumFractionDigits: 0 });
            const w = full ? fs(72) : fs(38);
            return (
              <g key={`tag-${l.idx}`} className={"iso-flow-tag" + (full ? " iso-flow-tag-full" : "")}
                role="button" tabIndex={0}
                aria-label={`Weg ${l.a.label} nach ${l.b.label}, ${l.edge.count} mal, ${l.edge.metres.toLocaleString("de-DE", { maximumFractionDigits: 0 })} Meter`}
                style={{ color: colour, cursor: "pointer" }} opacity={active ? 1 : 0.35}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEdgeInfo(l.edge); }
                }}
                onClick={(e) => { e.stopPropagation(); setEdgeInfo(l.edge); }}>
                <title>{`${l.a.label} → ${l.b.label}: ${l.edge.count}×, ${l.edge.metres.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m`}</title>
                <rect x={l.mid[0] - w / 2} y={l.mid[1] - fs(17)} width={w} height={fs(16)}
                  rx={fs(3)} fill="var(--g-surface)" opacity={0.97} stroke={colour} strokeOpacity={0.5}
                  strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <rect x={l.mid[0] - w / 2 + fs(2)} y={l.mid[1] - fs(13)} width={fs(2.4)} height={fs(8)}
                  rx={fs(1)} fill={colour} opacity={0.85} />
                <text className="iso-flow-label" x={l.mid[0] + fs(2)} y={l.mid[1] - fs(5)} textAnchor="middle"
                  fontSize={fs(full ? 10.5 : 10.5)} fill={colour}>
                  <tspan fontWeight={700}>{l.edge.count}×</tspan>
                  {full && <tspan dx={fs(2.5)} fill="var(--g-text-2)" fontWeight={500}>{metres} m</tspan>}
                </text>
              </g>
            );
          })}

        </svg>

        <div className="iso-hud" aria-hidden="true">
          <span className="iso-hud-main"><Icon icon="layout" size={12} /> {floor.name || "Halle"}</span>
          <span>{(floor.area_m2 ?? 0).toLocaleString("de-DE")} m²</span>
          <span>{hallH.toLocaleString("de-DE", { maximumFractionDigits: 1 })} m hoch</span>
          <span>{stations.filter((s) => s.active).length}/{stations.length} aktiv</span>
          {netMetres > 0 && <span>{Math.round(netMetres).toLocaleString("de-DE")} m Gänge</span>}
          {flow.length > 0 && (
            <span className="iso-hud-flow">
              <span className="iso-swatch iso-swatch-supply" /> Material
              <span className="iso-swatch iso-swatch-ship" /> Versand
              <span className="iso-hud-count">{flow.length} Wege</span>
            </span>
          )}
        </div>

        {activeEdge && (
          <div className="iso-edge-card" role="group" aria-label={`Materialweg ${activeEdge.a.label} nach ${activeEdge.b.label}`}
            onClick={(e) => e.stopPropagation()}>
            <div className="iso-edge-head">
              <span className={"iso-edge-dot " + (activeEdge.edge.kind === "supply" ? "supply" : "ship")} />
              <b>{activeEdge.a.label} <span aria-hidden="true">→</span> {activeEdge.b.label}</b>
              <button type="button" className="iso-edge-close" aria-label="Weg schließen"
                onClick={() => setEdgeInfo(null)}><Icon icon="cross" size={12} /></button>
            </div>
            <div className="iso-edge-facts">
              <span><b>{activeEdge.edge.count}×</b> Weg</span>
              <span><b>{activeEdge.edge.metres.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m</b> je Weg</span>
              <span className="mono">{activeEdge.edge.exact ? "ganggenau" : "Luftlinie"}</span>
            </div>
            {activeEdge.edge.materials.length > 0 && (
              <div className="iso-edge-mats">{activeEdge.edge.materials.slice(0, 6).join(" · ")}</div>
            )}
            <div className="iso-edge-actions">
              <Button small minimal icon="arrow-left" text={activeEdge.a.label}
                onClick={() => onStationClick?.(activeEdge.a)} />
              <Button small minimal icon="arrow-right" text={activeEdge.b.label}
                onClick={() => onStationClick?.(activeEdge.b)} />
              {onFilterEdge && (
                <Button small minimal icon="filter-list" text="Nur diesen Weg"
                  onClick={() => onFilterEdge(activeEdge.edge)} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
