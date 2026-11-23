import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from "react";
import type { Floor, Station } from "../../factory";

/* Gemeinsame Kartenteile der Roboter-Seite: Ausschnitt (Rad zoomt um den
   Zeiger, Ziehen verschiebt) und der Hallen-Hintergrund in Metern. Lagekarte
   (FleetMap) und Wege-Editor (RouteEditor) zeichnen die Halle damit gleich. */

export interface Box { x: number; y: number; w: number; h: number }
type P = [number, number];

export function boundsOf(outline: P[] | undefined, extra: P[] = []): Box {
  const pts = (outline && outline.length >= 3 ? outline : extra).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return { x: -2, y: -2, w: 24, h: 16 };
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = Math.max(1, Math.max(maxX - minX, maxY - minY) * 0.04);
  return { x: minX - pad, y: minY - pad, w: Math.max(4, maxX - minX + 2 * pad), h: Math.max(4, maxY - minY + 2 * pad) };
}

/** Bildschirm → Meter für ein SVG mit preserveAspectRatio="xMidYMid meet". */
export function clientToWorld(svg: SVGSVGElement | null, view: Box, clientX: number, clientY: number): P | null {
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const s = Math.max(view.w / r.width, view.h / r.height);
  const ox = view.x + view.w / 2 - (r.width * s) / 2;
  const oy = view.y + view.h / 2 - (r.height * s) / 2;
  return [ox + (clientX - r.left) * s, oy + (clientY - r.top) * s];
}

/** Meter je Bildschirmpixel im jetzigen Ausschnitt. */
export function metresPerPixel(svg: SVGSVGElement | null, view: Box): number {
  const r = svg?.getBoundingClientRect();
  return r && r.width > 0 ? Math.max(view.w / r.width, view.h / r.height) : view.w / 800;
}

export interface MapView {
  view: Box;
  setView: (v: Box) => void;
  reset: () => void;
  toWorld: (clientX: number, clientY: number) => P | null;
  /** Für onPointerDown/Move/Up am SVG: Ziehen auf leerer Fläche verschiebt. Gibt bei Klick (ohne Ziehen) das Ereignis zurück. */
  panHandlers: (onClick?: (e: RPointerEvent<SVGSVGElement>) => void) => {
    onPointerDown: (e: RPointerEvent<SVGSVGElement>) => void;
    onPointerMove: (e: RPointerEvent<SVGSVGElement>) => void;
    onPointerUp: (e: RPointerEvent<SVGSVGElement>) => void;
    onPointerCancel: () => void;
  };
}

export function useMapView(svgRef: RefObject<SVGSVGElement>, home: Box, resetKey: unknown): MapView {
  const [view, setView] = useState<Box>(home);
  const viewRef = useRef(view);
  viewRef.current = view;
  const homeRef = useRef(home);
  homeRef.current = home;
  const drag = useRef<{ x: number; y: number; view: Box; moved: boolean; id: number } | null>(null);

  useEffect(() => { setView(homeRef.current); }, [resetKey]);

  // Rad nur abfangen, wenn die Karte gemeint ist — sonst scrollt die Seite.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current, h = homeRef.current;
      const p = clientToWorld(svg, v, e.clientX, e.clientY);
      if (!p) return;
      const k = Math.exp(Math.sign(e.deltaY) * 0.15);
      const w = Math.min(h.w * 2, Math.max(h.w / 16, v.w * k));
      const f = w / v.w;
      setView({ x: p[0] - (p[0] - v.x) * f, y: p[1] - (p[1] - v.y) * f, w, h: v.h * f });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [svgRef]);

  const toWorld = useCallback((cx: number, cy: number) => clientToWorld(svgRef.current, viewRef.current, cx, cy), [svgRef]);

  const panHandlers: MapView["panHandlers"] = (onClick) => ({
    onPointerDown: (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      drag.current = { x: e.clientX, y: e.clientY, view: viewRef.current, moved: false, id: e.pointerId };
    },
    onPointerMove: (e) => {
      const d = drag.current, svg = svgRef.current;
      if (!d || !svg) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) { try { svg.setPointerCapture(e.pointerId); } catch { /* schon gelöst */ } }
      d.moved = true;
      const s = metresPerPixel(svg, d.view);
      setView({ ...d.view, x: d.view.x - dx * s, y: d.view.y - dy * s });
    },
    onPointerUp: (e) => {
      const d = drag.current;
      drag.current = null;
      if (d?.moved) { try { svgRef.current?.releasePointerCapture(e.pointerId); } catch { /* schon gelöst */ } }
      else if (d && onClick) onClick(e);
    },
    onPointerCancel: () => { drag.current = null; },
  });

  return { view, setView, reset: () => setView(homeRef.current), toWorld, panHandlers };
}

/** Halle, Hindernisse, Gangnetz und Stationen dünn im Hintergrund. */
export function FloorBackdrop({ floor, stations, view, font, showNodes = false }: {
  floor: Floor | null; stations: Station[]; view: Box; font: number; showNodes?: boolean;
}) {
  const pts = (route: P[]) => route.map(([x, y]) => `${x},${y}`).join(" ");
  const aisles = floor?.aisles;
  const live = stations.filter((s) => s.active !== false);
  return (
    <g className="fm-backdrop" pointerEvents="none">
      <rect x={view.x - view.w} y={view.y - view.h} width={view.w * 3} height={view.h * 3} className="fm-outside" />
      {floor?.outline && floor.outline.length > 2 && <polygon points={pts(floor.outline)} className="fm-hall" />}
      {(floor?.obstacles ?? []).map((o, i) => o.points.length > 2 && (
        <g key={`o${i}`}>
          <polygon points={pts(o.points)} className="fm-obstacle" />
        </g>
      ))}
      {aisles && aisles.edges.map(([a, b], i) => {
        const p = aisles.nodes[a], q = aisles.nodes[b];
        if (!p || !q) return null;
        return <line key={`a${i}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} className="fm-aisle" />;
      })}
      {showNodes && aisles && aisles.nodes.map((n, i) => (
        <circle key={`n${i}`} cx={n[0]} cy={n[1]} r={font * 0.22} className="fm-aisle-node" />
      ))}
      {live.map((s) => (
        <g key={`s${s.id}`} transform={`translate(${s.x} ${s.y}) rotate(${s.rotation || 0})`} className="fm-station">
          <rect x={-s.w / 2} y={-s.h / 2} width={s.w} height={s.h} rx={Math.min(s.w, s.h) * 0.08} />
        </g>
      ))}
      {live.map((s) => Math.max(s.w, s.h) > font * 2.6 && (
        <text key={`sl${s.id}`} x={s.x} y={s.y + font * 0.3} className="fm-station-label"
              style={{ fontSize: font * 0.85 }} textAnchor="middle">
          {s.label.length > 18 ? `${s.label.slice(0, 17)}…` : s.label}
        </text>
      ))}
    </g>
  );
}
