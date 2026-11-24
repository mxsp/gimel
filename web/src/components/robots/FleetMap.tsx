import { Button } from "@blueprintjs/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Floor, Robot, RobotJob, Station } from "../../factory";
import { robotMovingAt, robotPoseAt } from "../twin/robots";
import { boundsOf, FloorBackdrop, useMapView } from "./mapView";
import { kindShort, routeColour, stateColour } from "./robotMeta";

/* Lagekarte der Fahrzeuge: eine Ebene von oben, live.

   Grundriss in Metern (x nach Osten, y nach Süden) wie im Digitalen Grundriss:
   Hallenumriss, Hindernisse, Gangnetz und Stationen dünn im Hintergrund, darüber
   die Wege der Fahrzeuge und die Fahrzeuge selbst. Simulierte Fahrzeuge laufen
   nach demselben Fahrplan wie in der 3D-Halle (twin/robots.ts); echte stehen
   dort, wo ihr Gateway sie zuletzt gemeldet hat.

   Rad zoomt um den Zeiger, Ziehen verschiebt, „Einpassen" setzt zurück. Ein
   Klick auf ein Fahrzeug wählt es; der Weg des gewählten wird hervorgehoben,
   sein laufender Transport gestrichelt mit Start und Ziel. */

interface Props {
  floor: Floor | null;
  stations: Station[];
  robots: Robot[];
  sampledAt: string | null;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** Laufender oder zugewiesener Transport des gewählten Fahrzeugs. */
  job?: RobotJob | null;
}

const TICK_MS = 120;

const pts = (route: [number, number][]) => route.map(([x, y]) => `${x},${y}`).join(" ");

export default function FleetMap({ floor, stations, robots, sampledAt, selectedId, onSelect, job }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const home = useMemo(() => {
    const extra: [number, number][] = [
      ...stations.flatMap((st) => [[st.x - st.w / 2, st.y - st.h / 2], [st.x + st.w / 2, st.y + st.h / 2]] as [number, number][]),
      ...robots.flatMap((r) => r.route ?? []),
    ];
    return boundsOf(floor?.outline, extra);
  }, [floor, robots, stations]);
  const { view, setView, panHandlers } = useMapView(svgRef, home, floor?.id ?? -1);
  const [now, setNow] = useState(() => Date.now());
  const receivedRef = useRef<{ at: string | null | undefined; ms: number }>({ at: undefined, ms: Date.now() });
  if (receivedRef.current.at !== sampledAt) {
    receivedRef.current = { at: sampledAt, ms: Date.now() };
  }

  // Lebende Lage: zehnmal je Sekunde neu rechnen, nur wenn die Seite sichtbar ist.
  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const span = Math.max(home.w, home.h);
  /** Mindestgröße der Fahrzeuge, damit sie in großen Hallen lesbar bleiben. */
  const unit = Math.max(1, span / 30) * Math.min(1, Math.max(0.45, view.w / home.w));
  const font = unit * 0.62;

  const focusSelected = () => {
    const r = robots.find((x) => x.id === selectedId);
    const pose = r ? robotPoseAt(r, sampledAt, Date.now(), receivedRef.current.ms) : null;
    const route = r?.route ?? [];
    if (!r || (!pose && route.length < 2)) { setView(home); return; }
    const xs = [...route.map((p) => p[0]), ...(pose ? [pose.x] : [])];
    const ys = [...route.map((p) => p[1]), ...(pose ? [pose.y] : [])];
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = Math.max(2, span * 0.05);
    setView({ x: minX - pad, y: minY - pad, w: Math.max(6, maxX - minX + 2 * pad), h: Math.max(4, maxY - minY + 2 * pad) });
  };

  const selected = robots.find((r) => r.id === selectedId) ?? null;

  if (!floor && !robots.length) {
    return <div className="fleet-map fleet-map-empty">Keine Ebene gewählt.</div>;
  }

  // Gewähltes zuletzt zeichnen, damit es oben liegt.
  const order = [...robots].sort((a, b) => (a.id === selectedId ? 1 : 0) - (b.id === selectedId ? 1 : 0));

  return (
    <div className="fleet-map">
      <svg ref={svgRef} className="fleet-map-svg" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
           preserveAspectRatio="xMidYMid meet" role="img"
           aria-label={`Lagekarte ${floor?.name ?? ""}: ${robots.length} Fahrzeuge`}
           {...panHandlers((e) => { if ((e.target as Element).closest?.("[data-robot]") == null) onSelect(null); })}>
        <FloorBackdrop floor={floor} stations={stations} view={view} font={font} />

        {/* Wege: gewählt kräftig, andere zurückgenommen. */}
        {order.map((r) => r.route.length >= 2 && (
          <polyline key={`r${r.id}`} points={pts(r.route_mode === "loop" ? [...r.route, r.route[0]] : r.route)}
            className={`fm-route${r.id === selectedId ? " is-selected" : selectedId != null ? " is-dim" : ""}`}
            style={{ stroke: routeColour(r.id) }} />
        ))}

        {/* Laufender Transport des gewählten Fahrzeugs. */}
        {job && job.route.length >= 2 && (
          <g className="fm-job">
            <polyline points={pts(job.route)} />
            <circle cx={job.route[0][0]} cy={job.route[0][1]} r={unit * 0.38} className="fm-job-from" />
            <circle cx={job.route[job.route.length - 1][0]} cy={job.route[job.route.length - 1][1]} r={unit * 0.38} className="fm-job-to" />
            <text x={job.route[job.route.length - 1][0]} y={job.route[job.route.length - 1][1] - unit * 0.7}
                  textAnchor="middle" className="fm-job-label" style={{ fontSize: font, strokeWidth: font * 0.3 }}>
              {job.to?.label ?? "Ziel"}
            </text>
          </g>
        )}

        {order.map((r) => {
          const pose = robotPoseAt(r, sampledAt, now, receivedRef.current.ms);
          if (!pose) return null;
          const moving = r.active && robotMovingAt(r, sampledAt, now, receivedRef.current.ms);
          const sel = r.id === selectedId;
          const L = unit * (r.kind === "amr" ? 0.95 : 1.25), W = unit * (r.kind === "amr" ? 0.72 : 0.86);
          const colour = stateColour(moving ? "moving" : r.state === "moving" ? "idle" : r.state, r.active);
          return (
            <g key={`m${r.id}`} data-robot={r.id} className={`fm-robot${sel ? " is-selected" : ""}${r.active ? "" : " is-off"}`}
               transform={`translate(${pose.x} ${pose.y})`}
               onClick={(e) => { e.stopPropagation(); onSelect(sel ? null : r.id); }}
               role="button" aria-label={`${r.name} wählen`} tabIndex={-1}>
              {sel && <circle r={unit * 1.25} className="fm-robot-halo" />}
              {moving && <circle r={unit * 0.9} className="fm-robot-pulse" style={{ stroke: colour }} />}
              <g transform={`rotate(${pose.heading_deg ?? 0})`}>
                <rect x={-L / 2} y={-W / 2} width={L} height={W} rx={W * 0.22} className="fm-robot-body"
                      style={{ stroke: routeColour(r.id) }} />
                {pose.heading_deg != null && (
                  <path d={`M ${L / 2 - W * 0.1} 0 L ${L / 2 - W * 0.5} ${-W * 0.3} L ${L / 2 - W * 0.5} ${W * 0.3} Z`}
                        className="fm-robot-nose" />
                )}
              </g>
              <circle r={W * 0.2} style={{ fill: colour }} className="fm-robot-dot" />
              <text y={-W / 2 - unit * 0.32} textAnchor="middle" className="fm-robot-label" style={{ fontSize: font, strokeWidth: font * 0.28 }}>
                {r.name}
              </text>
              {sel && (
                <text y={W / 2 + unit * 0.78} textAnchor="middle" className="fm-robot-sub" style={{ fontSize: font * 0.85, strokeWidth: font * 0.24 }}>
                  {kindShort(r.kind)} · {moving ? `${r.speed_m_s.toLocaleString("de-DE")} m/s` : (r.state === "charging" ? "lädt" : "steht")}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="fleet-map-tools">
        <Button small icon="zoom-to-fit" aria-label="Karte einpassen" title="Einpassen" onClick={() => setView(home)} />
        <Button small icon="locate" aria-label="Auf gewähltes Fahrzeug" title="Auf das gewählte Fahrzeug und seinen Weg"
                disabled={!selected} onClick={focusSelected} />
      </div>
      <div className="fleet-map-legend" aria-hidden="true">
        <span><i style={{ background: stateColour("moving") }} /> fährt</span>
        <span><i style={{ background: stateColour("idle") }} /> wartet</span>
        <span><i style={{ background: stateColour("charging") }} /> lädt</span>
        <span><i style={{ background: stateColour("error") }} /> Störung</span>
        <span className="fleet-map-hint">Rad zoomt · Ziehen verschiebt</span>
      </div>
    </div>
  );
}
