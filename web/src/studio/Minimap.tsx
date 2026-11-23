import { useEffect, useMemo, useRef, useState } from "react";
import type { Floor, Robot, Station } from "../factory";
import type { StationMark } from "../components/twin/marks";
import type { ThreeHandle } from "../components/twin/ThreeFloorPlan";

/* Minikarte der Halle (task 41 E, erweitert um Gänge, Förderbänder und Roboter).

   Draufsicht der aktiven Ebene: Umriss, Gänge, Förderbänder, Stationen in ihrer
   Statusfarbe, Roboter, die gewählte Station betont, dazu der Standpunkt.
   Ein Klick fährt die Kamera dorthin (Blickwinkel und Abstand bleiben). */

const STATUS_VAR: Record<string, string> = {
  laeuft: "var(--gimel-accent)", wartet: "var(--g-info)", frei: "var(--g-success-2)",
  voll: "var(--g-warning)", ueber: "var(--g-danger)", unbekannt: "var(--g-muted)", inaktiv: "var(--g-muted)",
};

interface Props {
  floor: Floor;
  stations: Station[];
  marks: Record<number, StationMark | undefined>;
  selectedId: number | null;
  robots?: Robot[];
  three: React.RefObject<ThreeHandle | null>;
  onPick?: (s: Station) => void;
}

export default function Minimap({ floor, stations, marks, selectedId, robots = [], three, onPick }: Props) {
  const outline = floor.outline?.length ? floor.outline : [[0, 0], [30, 0], [30, 20], [0, 20]];
  const box = useMemo(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of outline) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = Math.max(1, Math.max(x1 - x0, y1 - y0) * 0.04);
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }, [outline]);
  const [view, setView] = useState<{ x: number; y: number; heading: number | null; walk: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let last = "";
    const t = window.setInterval(() => {
      if (document.hidden) return;
      const v = three.current?.getViewer();
      const cam = three.current?.getCamera();
      if (!v) return;
      // Im Orbit zählt das Ziel (Plan-x = Welt-x, Plan-y = Welt-z).
      const at = v.mode === "walk" ? { x: v.x, y: v.y } : cam ? { x: cam.target[0], y: cam.target[2] } : { x: v.x, y: v.y };
      const next = { ...at, heading: v.heading_deg, walk: v.mode === "walk" };
      const key = `${next.x.toFixed(1)}|${next.y.toFixed(1)}|${next.heading?.toFixed(0)}|${next.walk}`;
      if (key !== last) { last = key; setView(next); }
    }, 250);
    return () => window.clearInterval(t);
  }, [three]);

  const toPlan = (e: React.MouseEvent<SVGSVGElement>): [number, number] | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = pt.matrixTransform(m.inverse());
    return [p.x, p.y];
  };

  const goTo = (e: React.MouseEvent<SVGSVGElement>) => {
    if (view?.walk) return;
    const p = toPlan(e);
    const cam = three.current?.getCamera();
    if (!p || !cam) return;
    const dx = p[0] - cam.target[0], dz = p[1] - cam.target[2];
    three.current?.setCamera({
      position: [cam.position[0] + dx, cam.position[1], cam.position[2] + dz],
      target: [p[0], cam.target[1], p[1]],
    });
  };

  const size = Math.max(box.w, box.h);
  const dot = Math.max(0.6, size * 0.018);
  const arrow = view && view.heading != null ? (() => {
    const r = (view.heading * Math.PI) / 180;
    const len = size * 0.07;
    // heading: 0° = Plan +y (Welt +z), im Uhrzeigersinn über +x.
    return { x2: view.x + Math.sin(r) * len, y2: view.y + Math.cos(r) * len };
  })() : null;

  return (
    <div className="studio-minimap" aria-label="Minikarte der Ebene">
      <svg ref={svgRef} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet"
        onClick={goTo} role="img" aria-label={view?.walk ? "Minikarte: Standpunkt der Figur" : "Minikarte: Klick fährt die Kamera dorthin"}>
        <polygon className="studio-minimap-hall" points={outline.map(([x, y]) => `${x},${y}`).join(" ")} />
        {(floor.aisles?.edges ?? []).map(([i, j], k) => {
          const a = floor.aisles?.nodes?.[i], b = floor.aisles?.nodes?.[j];
          if (!a || !b) return null;
          return <line key={`aisle-${k}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="studio-minimap-aisle" />;
        })}
        {(floor.conveyors ?? []).map((conv, ci) => {
          const pts = conv.points ?? [];
          if (pts.length < 2) return null;
          return (
            <polyline
              key={`conv-${ci}`}
              points={pts.map((p) => `${p[0]},${p[1]}`).join(" ")}
              className="studio-minimap-conveyor"
            />
          );
        })}
        {stations.filter((s) => s.id != null).map((s) => {
          const mark = marks[s.id as number];
          const sel = s.id === selectedId;
          return (
            <rect key={s.id} x={s.x - s.w / 2} y={s.y - s.h / 2} width={s.w} height={s.h}
              transform={`rotate(${s.rotation || 0} ${s.x} ${s.y})`}
              className={"studio-minimap-station" + (sel ? " is-selected" : "") + (s.active === false ? " is-off" : "")}
              style={{ fill: STATUS_VAR[mark?.kind ?? "unbekannt"] }}
              onClick={(e) => { if (onPick) { e.stopPropagation(); onPick(s); } }}>
              <title>{s.label}{mark ? ` · ${mark.word}` : ""}</title>
            </rect>
          );
        })}
        {robots.map((r) => {
          const rx = r.x;
          const ry = r.y;
          if (typeof rx !== "number" || typeof ry !== "number" || !Number.isFinite(rx) || !Number.isFinite(ry)) return null;
          return (
            <circle key={`rb-${r.id}`} cx={rx} cy={ry} r={dot * 0.72} className="studio-minimap-robot">
              <title>{r.name}</title>
            </circle>
          );
        })}
        {view && (
          <g className={"studio-minimap-me" + (view.walk ? " is-walk" : "")}>
            {arrow && <line x1={view.x} y1={view.y} x2={arrow.x2} y2={arrow.y2} strokeWidth={dot * 0.45} />}
            <circle cx={view.x} cy={view.y} r={dot} />
          </g>
        )}
      </svg>
    </div>
  );
}
