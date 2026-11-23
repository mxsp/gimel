import {
  Button, ButtonGroup, Callout, Dialog, DialogFooter, HTMLSelect, Icon, NumericInput, Spinner, Switch, Tag, TextArea, Tooltip,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { api } from "../../api";
import type { Floor, Robot, Station } from "../../factory";
import { toastError, toastInfo, toastSuccess } from "../../toast";
import { boundsOf, FloorBackdrop, metresPerPixel, useMapView } from "./mapView";
import {
  cycleLength, dist, insertAfter, nearestSegment, parseRouteText, pathLength, round2, routeIssues, routeText,
  segmentsOf, simplify, snapPoint, startAt, stationPolygon, type Issue, type Pt,
} from "./routeGeometry";
import { routeColour } from "./robotMeta";

/* Wege-Editor für Fahrzeuge: der Weg wird auf dem Grundriss gezeichnet.

   - Klick auf die Karte setzt einen Punkt ans Ende, Ziehen eines Punkts
     verschiebt ihn, „+" auf einem Abschnitt fügt einen Punkt ein, Doppelklick
     oder Entf löscht. Ziehen auf freier Fläche verschiebt die Karte, das Rad
     zoomt.
   - Einrasten an Gangknoten (sonst 0,5-m-Raster); Alt hält das Einrasten an.
   - „Gang folgen": jeder neue Abschnitt wird über das Gangnetz gerechnet
     (/api/factory/robot-ways/plan) statt als Luftlinie gesetzt.
   - Prüfung sofort im Browser (Umriss, Hindernisse, Stationen) und zusätzlich
     beim Server (/robot-ways/check); Fehler rot auf der Karte und in der Liste.
   - Rückgängig/Wiederholen, Umkehren, Vereinfachen, Start verlegen, Optimieren
     (/robot-ways/optimize), Punkte als Tabelle oder Text.

   Der Editor schreibt nichts: „Übernehmen" gibt Weg und Wegart zurück, das
   Speichern macht der Aufrufer (Dialog der Seite oder die Fahrzeug-Akte). */

type Mode = "loop" | "pingpong";

interface Props {
  isOpen: boolean;
  robotName: string;
  robotId?: number;
  floorId: number | null;
  floorLabel: string;
  route: Pt[];
  mode: Mode;
  speed: number;
  /** Andere Fahrzeuge derselben Ebene — ihre Wege dünn als Bezug. */
  others: Robot[];
  /** Erste Ebene: Stationen ohne Ebene stehen laut Hausregel dort. */
  defaultFloorId?: number | null;
  saving?: boolean;
  onClose: () => void;
  onApply: (route: Pt[], mode: Mode) => void;
}

const GRID = 0.5;
const HISTORY = 100;

const fmtM = (v: number) => `${v.toLocaleString("de-DE", { maximumFractionDigits: v < 10 ? 1 : 0 })} m`;
const fmtTime = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return "—";
  if (s < 90) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r ? `${m} min ${r} s` : `${m} min`;
};
const pts = (r: Pt[]) => r.map(([x, y]) => `${x},${y}`).join(" ");

export default function RouteEditor(props: Props) {
  // Den Inhalt nur bauen, solange der Dialog offen ist: frischer Zustand je Öffnen.
  return (
    <Dialog isOpen={props.isOpen} onClose={() => !props.saving && props.onClose()} className="route-editor-dialog"
            title={`Weg bearbeiten — ${props.robotName || "Fahrzeug"}`} icon="route" canOutsideClickClose={false}>
      {props.isOpen && <EditorBody {...props} />}
    </Dialog>
  );
}

function EditorBody({ robotId, floorId, floorLabel, route: initial, mode: initialMode, speed, others, defaultFloorId, saving, onClose, onApply }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [floor, setFloor] = useState<Floor | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [loadError, setLoadError] = useState("");
  const [route, setRouteRaw] = useState<Pt[]>(initial);
  const [mode, setModeRaw] = useState<Mode>(initialMode);
  const [past, setPast] = useState<{ route: Pt[]; mode: Mode }[]>([]);
  const [future, setFuture] = useState<{ route: Pt[]; mode: Mode }[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [draw, setDraw] = useState(initial.length < 2);
  const [snap, setSnap] = useState(true);
  const [follow, setFollow] = useState(false);
  const [routing, setRouting] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [hover, setHover] = useState<{ p: Pt; kind: string } | null>(null);
  const [altHeld, setAltHeld] = useState(false);
  const [serverIssues, setServerIssues] = useState<string[] | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const [text, setText] = useState(routeText(initial));
  const [textError, setTextError] = useState("");
  const [optNote, setOptNote] = useState<string[]>([]);
  /** before = null: der Schritt steht schon im Verlauf (Einfügen und gleich ziehen). */
  const dragPoint = useRef<{ index: number; before: Pt[] | null; moved: boolean } | null>(null);

  useEffect(() => {
    if (floorId == null) return;
    let off = false;
    Promise.all([
      api<Floor>(`/api/factory/floor?floor_id=${floorId}`),
      api<Station[]>("/api/factory/stations").catch(() => [] as Station[]),
    ]).then(([f, st]) => {
      if (off) return;
      setFloor(f);
      setStations((st ?? []).filter((s) => (s.floor_id ?? defaultFloorId ?? null) === floorId));
    }).catch((e: unknown) => { if (!off) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { off = true; };
  }, [floorId, defaultFloorId]);

  const loop = mode === "loop";
  const home = useMemo(() => boundsOf(floor?.outline, [...initial, ...stations.map((s) => [s.x, s.y] as Pt)]), [floor, initial, stations]);
  const { view, setView, reset, toWorld, panHandlers } = useMapView(svgRef, home, floor?.id ?? -1);
  const mpp = metresPerPixel(svgRef.current, view);
  const font = Math.max(0.35, mpp * 12);
  const handle = mpp * 7;

  /* ------------------------------------------------------------ Verlauf */
  const commit = useCallback((next: Pt[], nextMode: Mode = mode, from: Pt[] = route) => {
    setPast((p) => [...p.slice(-HISTORY + 1), { route: from, mode }]);
    setFuture([]);
    setRouteRaw(next);
    setModeRaw(nextMode);
    setText(routeText(next));
  }, [mode, route]);
  const undo = useCallback(() => {
    if (!past.length) return;
    const last = past[past.length - 1];
    setPast(past.slice(0, -1));
    setFuture([{ route, mode }, ...future]);
    setRouteRaw(last.route); setModeRaw(last.mode); setText(routeText(last.route));
    setSelected(null);
  }, [past, future, route, mode]);
  const redo = useCallback(() => {
    if (!future.length) return;
    const [next, ...rest] = future;
    setFuture(rest);
    setPast([...past, { route, mode }]);
    setRouteRaw(next.route); setModeRaw(next.mode); setText(routeText(next.route));
  }, [past, future, route, mode]);

  /* ------------------------------------------------------------ Prüfung */
  const env = useMemo(() => ({
    outline: (floor?.outline ?? []) as Pt[],
    obstacles: (floor?.obstacles ?? []).map((o) => ({ name: o.name, points: o.points as Pt[] })),
    // Etwas eingerückt: an einer Station andocken ist erlaubt, hindurchfahren nicht.
    stations: stations.filter((s) => s.active !== false).map((s) => ({ name: s.label, points: stationPolygon(s, 0.15) })),
  }), [floor, stations]);
  const issues = useMemo(() => routeIssues(route, loop, env), [route, loop, env]);
  const badSegments = useMemo(() => new Map(issues.filter((i) => i.segment != null).map((i) => [i.segment!, i.level])), [issues]);
  const badPoints = useMemo(() => new Map(issues.filter((i) => i.point != null).map((i) => [i.point!, i.level])), [issues]);

  // Zweite Meinung vom Server, kurz nach der letzten Änderung.
  useEffect(() => {
    if (floorId == null || route.length < 2) { setServerIssues(null); return; }
    setServerIssues(null);
    const id = window.setTimeout(() => {
      api<{ ok: boolean; problems: string[] }>("/api/factory/robot-ways/check", {
        method: "POST", body: JSON.stringify({ floor_id: floorId, points: loop && route.length >= 3 ? [...route, route[0]] : route }),
      }).then((r) => setServerIssues(r.problems ?? [])).catch(() => setServerIssues(null));
    }, 600);
    return () => window.clearTimeout(id);
  }, [route, loop, floorId]);

  /* ------------------------------------------------------------ Fangen */
  const nodes = useMemo(() => (floor?.aisles?.nodes ?? []) as Pt[], [floor]);
  const snapAt = useCallback((p: Pt, exceptIndex: number | null, free: boolean) => {
    if (!snap || free) return { p: [round2(p[0]), round2(p[1])] as Pt, kind: "free" as const };
    const extra = route.filter((_, i) => i !== exceptIndex && (i === 0 || i === route.length - 1));
    return snapPoint(p, { nodes, grid: GRID, radius: Math.max(0.5, mpp * 14), extra });
  }, [snap, route, nodes, mpp]);

  /* ------------------------------------------------------------ Bearbeiten */
  const addPoint = async (p: Pt) => {
    if (route.length && dist(route[route.length - 1], p) < 0.05) return;
    // Rundkurs schließen: Klick auf den Startpunkt.
    if (route.length >= 3 && dist(route[0], p) < 0.05) {
      if (!loop) { commit(route, "loop"); toastInfo("Rundkurs geschlossen."); }
      setDraw(false);
      return;
    }
    if (follow && route.length && floorId != null) {
      setRouting(true);
      try {
        const r = await api<{ route: Pt[]; route_note: string; route_exact: boolean }>("/api/factory/robot-ways/plan", {
          method: "POST", body: JSON.stringify({ floor_id: floorId, start: route[route.length - 1], end: p }),
        });
        const leg = (r.route ?? []).slice(1).map(([x, y]) => [round2(x), round2(y)] as Pt);
        commit(simplify([...route, ...(leg.length ? leg : [p])], 0.02));
        if (!r.route_exact) toastInfo(r.route_note || "Kein Gang dort — als Luftlinie gesetzt.");
      } catch (e: unknown) {
        commit([...route, p]);
        toastError(`Gang folgen ging nicht: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setRouting(false);
      }
    } else {
      commit([...route, p]);
    }
    setSelected(route.length);
  };

  const removePoint = (i: number) => {
    commit(route.filter((_, k) => k !== i));
    setSelected(null);
  };
  const movePoint = (i: number, p: Pt) => setRouteRaw((r) => r.map((q, k) => (k === i ? p : q)));

  const onMapClick = (e: RPointerEvent<SVGSVGElement>) => {
    const t = e.target as Element;
    if (t.closest?.("[data-handle]") || t.closest?.("[data-insert]")) return;
    const w = toWorld(e.clientX, e.clientY);
    if (!w) return;
    if (e.shiftKey && route.length >= 2) {
      const near = nearestSegment(route, w, loop);
      if (near) { const p = snapAt(w, null, e.altKey).p; commit(insertAfter(route, near.index, p)); setSelected(near.index + 1); }
      return;
    }
    if (!draw) { setSelected(null); return; }
    void addPoint(snapAt(w, null, e.altKey).p);
  };

  const map = panHandlers(onMapClick);
  const onPointerMove = (e: RPointerEvent<SVGSVGElement>) => {
    setAltHeld(e.altKey);
    const d = dragPoint.current;
    if (d) {
      const w = toWorld(e.clientX, e.clientY);
      if (!w) return;
      d.moved = true;
      movePoint(d.index, snapAt(w, d.index, e.altKey).p);
      return;
    }
    map.onPointerMove(e);
    if (draw) {
      const w = toWorld(e.clientX, e.clientY);
      setHover(w ? snapAt(w, null, e.altKey) : null);
    }
  };
  const onPointerUp = (e: RPointerEvent<SVGSVGElement>) => {
    const d = dragPoint.current;
    if (d) {
      dragPoint.current = null;
      try { svgRef.current?.releasePointerCapture(e.pointerId); } catch { /* gelöst */ }
      if (d.moved && d.before) {
        setPast((p) => [...p.slice(-HISTORY + 1), { route: d.before!, mode }]);
        setFuture([]);
      }
      setText(routeText(route));
      return;
    }
    map.onPointerUp(e);
  };
  const startDrag = (i: number) => (e: RPointerEvent<SVGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected(i);
    dragPoint.current = { index: i, before: route, moved: false };
    try { svgRef.current?.setPointerCapture(e.pointerId); } catch { /* egal */ }
  };

  /* ------------------------------------------------------------ Tasten */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && selected != null) { e.preventDefault(); removePoint(selected); return; }
      if (e.key === "Escape" && (selected != null || draw)) { e.preventDefault(); e.stopPropagation(); setSelected(null); setDraw(false); setHover(null); return; }
      if (selected != null && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 0.1;
        const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] ?? [0, 0];
        const p = route[selected];
        if (p) commit(route.map((q, k) => (k === selected ? [round2(p[0] + dx), round2(p[1] + dy)] : q)));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  /* ------------------------------------------------------------ Werkzeuge */
  const optimize = async () => {
    if (floorId == null || route.length < 2) return;
    setOptimizing(true);
    try {
      const r = await api<{ route: Pt[]; changed: boolean; metres_before: number; metres_after: number; notes: string[] }>(
        "/api/factory/robot-ways/optimize", { method: "POST", body: JSON.stringify({ floor_id: floorId, points: route, loop }) });
      setOptNote(r.notes ?? []);
      if (!r.changed) { toastInfo("Der Weg ist schon optimal."); return; }
      commit(r.route.map(([x, y]) => [round2(x), round2(y)] as Pt));
      toastSuccess(`Weg optimiert: ${Math.round(r.metres_before)} m → ${Math.round(r.metres_after)} m. Strg+Z nimmt zurück.`);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setOptimizing(false);
    }
  };
  const applyText = () => {
    const r = parseRouteText(text);
    if (r.error && r.route.length !== 1) { setTextError(r.error); return; }
    setTextError("");
    commit(r.route.map(([x, y]) => [round2(x), round2(y)] as Pt));
  };
  const focusIssue = (i: Issue) => {
    const idx = i.point ?? i.segment;
    if (idx == null) return;
    const segs = segmentsOf(route, loop);
    const ps = i.point != null ? [route[i.point]] : segs[i.segment!] ?? [];
    if (!ps.length) return;
    if (i.point != null) setSelected(i.point);
    const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const w = Math.max(8, (Math.max(...xs) - Math.min(...xs)) * 1.6), h = w * (view.h / view.w);
    setView({ x: cx - w / 2, y: cy - h / 2, w, h });
  };

  const len = pathLength(route, loop);
  const cycle = cycleLength(route, loop);
  const errors = issues.filter((i) => i.level === "error");
  const colour = routeColour(robotId ?? 0);
  const segs = segmentsOf(route, loop);
  const last = route[route.length - 1];

  if (floorId == null) {
    return <div className="route-editor-empty"><Callout intent="warning" icon="warning-sign">
      Für den Weg braucht das Fahrzeug eine Ebene — bitte im Dialog zuerst die Ebene wählen.
    </Callout></div>;
  }

  return (
    <>
      <div className="route-editor">
        <div className="route-editor-map">
          <div className="route-toolbar" role="toolbar" aria-label="Werkzeuge">
            <ButtonGroup>
              <Button icon="draw" text="Punkte setzen" active={draw} aria-pressed={draw} intent={draw ? "primary" : "none"}
                onClick={() => { setDraw((v) => !v); setHover(null); }} title="Klick auf die Karte setzt den nächsten Punkt ans Ende (Esc beendet)" />
              <Button icon="undo" aria-label="Rückgängig" title="Rückgängig (Strg+Z)" disabled={!past.length} onClick={undo} />
              <Button icon="redo" aria-label="Wiederholen" title="Wiederholen (Strg+Umschalt+Z)" disabled={!future.length} onClick={redo} />
            </ButtonGroup>
            <Switch checked={snap} label={altHeld ? "Einrasten (Alt: aus)" : "Einrasten"} className="route-switch"
              onChange={() => setSnap((v) => !v)} />
            <Tooltip content="Neue Abschnitte über das Gangnetz rechnen statt Luftlinie" placement="bottom">
              <Switch checked={follow} label="Gang folgen" className="route-switch" onChange={() => setFollow((v) => !v)} />
            </Tooltip>
            {routing && <Spinner size={14} />}
            <span className="route-toolbar-gap" />
            <Button minimal icon="zoom-to-fit" aria-label="Einpassen" title="Halle einpassen" onClick={reset} />
          </div>
          {loadError && <Callout intent="warning" icon="warning-sign" className="route-load-error">Grundriss nicht geladen: {loadError}</Callout>}
          <svg ref={svgRef} className={`route-svg${draw ? " is-drawing" : ""}`} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
               preserveAspectRatio="xMidYMid meet" role="application" aria-label={`Wege-Editor ${floorLabel}`}
               onPointerDown={map.onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
               onPointerCancel={() => { dragPoint.current = null; map.onPointerCancel(); }}
               onPointerLeave={() => setHover(null)}>
            <FloorBackdrop floor={floor} stations={stations} view={view} font={font} showNodes={snap} />
            {/* Bezug: Wege der anderen Fahrzeuge. */}
            {others.filter((o) => o.id !== robotId && o.floor_id === floorId && o.route.length >= 2).map((o) => (
              <g key={`o${o.id}`} className="route-other">
                <polyline points={pts(o.route_mode === "loop" ? [...o.route, o.route[0]] : o.route)} style={{ stroke: routeColour(o.id) }} />
                <text x={o.route[0][0]} y={o.route[0][1] - font * 0.6} style={{ fontSize: font * 0.8 }}>{o.name}</text>
              </g>
            ))}

            {segs.map(([a, b], i) => {
              const bad = badSegments.get(i);
              const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
              const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
              const L = dist(a, b);
              const closing = loop && i === route.length - 1;
              return (
                <g key={`g${i}`} className={`route-seg${bad ? ` is-${bad}` : ""}${closing ? " is-closing" : ""}`}>
                  <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="route-seg-under" />
                  <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="route-seg-line" style={bad ? undefined : { stroke: colour }} />
                  {L > handle * 6 && (
                    <path d={`M ${-handle * 0.7} ${-handle * 0.6} L ${handle * 0.5} 0 L ${-handle * 0.7} ${handle * 0.6}`}
                          transform={`translate(${a[0] + (b[0] - a[0]) * 0.3} ${a[1] + (b[1] - a[1]) * 0.3}) rotate(${ang})`} className="route-arrow" />
                  )}
                  {L > handle * 4 && (
                    <g data-insert={i} className="route-insert" transform={`translate(${mx} ${my})`}
                       onPointerDown={(e) => {
                         if (e.button !== 0) return;
                         e.stopPropagation();
                         const next = insertAfter(route, i, [round2(mx), round2(my)]);
                         commit(next);
                         setSelected(i + 1);
                         dragPoint.current = { index: i + 1, before: null, moved: false };
                         try { svgRef.current?.setPointerCapture(e.pointerId); } catch { /* egal */ }
                       }}>
                      <circle r={handle * 0.75} />
                      <path d={`M ${-handle * 0.4} 0 H ${handle * 0.4} M 0 ${-handle * 0.4} V ${handle * 0.4}`} />
                      <title>Punkt einfügen (ziehen zum Verschieben)</title>
                    </g>
                  )}
                  <text x={mx} y={my - handle * 1.4} textAnchor="middle" className="route-seg-label" style={{ fontSize: font * 0.85, strokeWidth: font * 0.25 }}>
                    {fmtM(L)}
                  </text>
                </g>
              );
            })}

            {/* Vorschau des nächsten Abschnitts. */}
            {draw && hover && (
              <g className="route-ghost" pointerEvents="none">
                {last && <line x1={last[0]} y1={last[1]} x2={hover.p[0]} y2={hover.p[1]} />}
                <circle cx={hover.p[0]} cy={hover.p[1]} r={handle * (hover.kind === "node" || hover.kind === "point" ? 1.1 : 0.7)}
                        className={`route-ghost-dot is-${hover.kind}`} />
                {last && (
                  <text x={hover.p[0] + handle * 1.5} y={hover.p[1] - handle} style={{ fontSize: font * 0.9, strokeWidth: font * 0.25 }}>
                    {fmtM(dist(last, hover.p))}{follow ? " · über Gang" : ""}
                  </text>
                )}
              </g>
            )}

            {route.map((p, i) => {
              const bad = badPoints.get(i);
              const end = !loop && i === route.length - 1 && route.length > 1;
              return (
                <g key={`p${i}`} data-handle={i} transform={`translate(${p[0]} ${p[1]})`}
                   className={`route-pt${selected === i ? " is-selected" : ""}${bad ? ` is-${bad}` : ""}${i === 0 ? " is-start" : ""}${end ? " is-end" : ""}`}
                   onPointerDown={startDrag(i)}
                   onDoubleClick={(e) => { e.stopPropagation(); removePoint(i); }}>
                  <circle r={handle * (i === 0 || end ? 1.25 : 0.95)} />
                  <text y={font * 0.32} textAnchor="middle" style={{ fontSize: font * (i === 0 || end ? 0.85 : 0.7) }}>
                    {i === 0 ? "S" : end ? "Z" : i + 1}
                  </text>
                  <title>{`Punkt ${i + 1}: ${p[0]}, ${p[1]} — ziehen verschiebt, Doppelklick löscht`}</title>
                </g>
              );
            })}
          </svg>
          <div className="route-hint">
            {draw
              ? (route.length ? "Klick setzt den nächsten Punkt · Klick auf S schließt den Rundkurs · Esc beendet" : "Klick auf die Karte setzt den Start")
              : "Punkte ziehen · „+“ fügt ein · Doppelklick oder Entf löscht · Umschalt+Klick fügt am nächsten Abschnitt ein"}
            {" · Rad zoomt · Ziehen verschiebt"}
          </div>
        </div>

        <aside className="route-side">
          <section className="route-card">
            <div className="route-stats">
              <div><span>Länge</span><b className="mono">{fmtM(len)}</b></div>
              <div><span>Punkte</span><b className="mono">{route.length}</b></div>
              <div><span>{loop ? "Runde" : "Hin + zurück"}</span><b className="mono">{fmtTime(speed > 0 ? cycle / speed : NaN)}</b></div>
            </div>
            <label className="route-field">
              <span>Wegart</span>
              <HTMLSelect fill value={mode} onChange={(e) => commit(route, e.currentTarget.value as Mode)}>
                <option value="pingpong">Pendel — hin und zurück</option>
                <option value="loop">Rundkurs — letzter Punkt schließt zum ersten</option>
              </HTMLSelect>
            </label>
            <div className="route-tools">
              <Button small icon="clean" text="Optimieren" loading={optimizing} disabled={route.length < 2}
                title="Über das Gangnetz, um Hindernisse und Stationen herum; Anfang und Ende bleiben" onClick={() => void optimize()} />
              <Button small icon="swap-horizontal" text="Umkehren" disabled={route.length < 2} onClick={() => commit([...route].reverse())} />
              <Button small icon="layout-linear" text="Vereinfachen" disabled={route.length < 3}
                title="Doppelte und gerade durchfahrene Zwischenpunkte entfernen"
                onClick={() => { const s = simplify(route); if (s.length === route.length) toastInfo("Nichts zu vereinfachen."); else commit(s); }} />
              {loop && selected != null && selected > 0 && (
                <Button small icon="flag" text="Hier starten" onClick={() => { commit(startAt(route, selected)); setSelected(0); }} />
              )}
              <Button small minimal intent="danger" icon="trash" text="Leeren" disabled={!route.length}
                onClick={() => { commit([]); setSelected(null); setDraw(true); }} />
            </div>
            {optNote.length > 0 && <ul className="route-notes">{optNote.slice(0, 4).map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </section>

          <section className="route-card" aria-label="Prüfung">
            <div className="route-card-head">
              <h3>Prüfung</h3>
              {route.length < 2 ? <Tag minimal>noch kein Weg</Tag>
                : errors.length ? <Tag minimal intent="danger">{errors.length} Fehler</Tag>
                  : issues.length ? <Tag minimal intent="warning">{issues.length} Hinweis{issues.length === 1 ? "" : "e"}</Tag>
                    : <Tag minimal intent="success" icon="tick">Weg frei</Tag>}
            </div>
            {issues.length > 0 && (
              <ul className="route-issues">
                {issues.slice(0, 8).map((i, k) => (
                  <li key={k} className={`is-${i.level}`}>
                    <button type="button" onClick={() => focusIssue(i)}>
                      <Icon icon={i.level === "error" ? "error" : "warning-sign"} size={12} /> {i.text}
                    </button>
                  </li>
                ))}
                {issues.length > 8 && <li className="sub">… und {issues.length - 8} weitere</li>}
              </ul>
            )}
            <div className="route-server sub">
              {route.length < 2 ? null
                : serverIssues == null ? <><Spinner size={10} /> Server prüft …</>
                  : serverIssues.length ? <span className="is-error">Server: {serverIssues.join(" ")}</span>
                    : <span><Icon icon="tick" size={11} /> Server: Umriss und Hindernisse in Ordnung</span>}
            </div>
          </section>

          <section className="route-card route-points-card">
            <div className="route-card-head">
              <h3>Punkte</h3>
              <Button small minimal icon={textOpen ? "th" : "align-left"} text={textOpen ? "Tabelle" : "Als Text"}
                onClick={() => { setTextOpen((v) => !v); setText(routeText(route)); setTextError(""); }} />
            </div>
            {textOpen ? (
              <div className="route-text">
                <TextArea fill rows={8} value={text} onChange={(e) => setText(e.currentTarget.value)}
                  aria-label="Punkte als Text, x, y je Zeile" placeholder={"6, 16\n14, 16\n22, 16"} />
                {textError && <Callout compact intent="danger">{textError}</Callout>}
                <Button small icon="import" text="Übernehmen" onClick={applyText} />
              </div>
            ) : route.length ? (
              <ol className="route-points">
                {route.map((p, i) => (
                  <li key={i} className={`${selected === i ? "is-selected" : ""}${badPoints.get(i) ? ` is-${badPoints.get(i)}` : ""}`}
                      onClick={() => setSelected(i)}>
                    <span className="route-pt-no mono">{i === 0 ? "S" : !loop && i === route.length - 1 ? "Z" : i + 1}</span>
                    <NumericInput small buttonPosition="none" value={p[0]} stepSize={0.1} majorStepSize={1} aria-label={`Punkt ${i + 1} x`}
                      onValueChange={(v) => Number.isFinite(v) && commit(route.map((q, k) => (k === i ? [round2(v), q[1]] : q)))} />
                    <NumericInput small buttonPosition="none" value={p[1]} stepSize={0.1} majorStepSize={1} aria-label={`Punkt ${i + 1} y`}
                      onValueChange={(v) => Number.isFinite(v) && commit(route.map((q, k) => (k === i ? [q[0], round2(v)] : q)))} />
                    <span className="sub mono route-pt-len">{i + 1 < route.length ? fmtM(dist(p, route[i + 1])) : loop && route.length > 2 ? fmtM(dist(p, route[0])) : ""}</span>
                    <Button small minimal icon="cross" aria-label={`Punkt ${i + 1} löschen`} onClick={(e) => { e.stopPropagation(); removePoint(i); }} />
                  </li>
                ))}
              </ol>
            ) : <p className="sub">Noch keine Punkte — auf der Karte klicken.</p>}
          </section>
        </aside>
      </div>
      <DialogFooter
        minimal={false}
        actions={<>
          {errors.length > 0 && <span className="route-footer-note"><Icon icon="error" size={12} /> Der Weg hat {errors.length} Fehler — übernehmen geht trotzdem.</span>}
          <Button text="Abbrechen" disabled={saving} onClick={onClose} />
          <Button intent="primary" icon="tick" text="Übernehmen" loading={saving}
            disabled={route.length === 1} title={route.length === 1 ? "Ein Weg braucht mindestens zwei Punkte" : undefined}
            onClick={() => onApply(route, mode)} />
        </>} />
    </>
  );
}
