import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { footprint as conveyorFootprint, points3 as conveyorPoints, widthOf as conveyorWidth } from "./twin/conveyor";
import { createPortal } from "react-dom";
import { Button, ButtonGroup, Icon } from "@blueprintjs/core";
import {
  Aisles,
  Door,
  Floor,
  FloorLayer,
  FlowEdge,
  Obstacle,
  Station,
  TYPE_LABEL,
  Zone,
  carveWallIndentation,
  circleDimensions,
  doorDirection,
  effectiveDoorKind,
  heatColour,
  isFloorHoleObstacle,
  moveWallSegmentOrthogonal,
  nearestNode,
  obstacleKind,
  openOutlinePath,
  outlinePath,
  outlineWithHolesPath,
  polygonArea,
  polygonCentroid,
  routePoints,
  sceneBounds,
  snapDoorToWall,
  stationColour,
  stationCorners,
  stationOnObstacle,
  stationOutsideOutline,
  stationsOverlap,
  translatePolygon,
} from "../factory";
import { barWidth, heatFromRatio, loadInfo } from "../loadscale";
import StationShape, { StatusDefs } from "./twin/StationShape";
import { StationMark } from "./twin/marks";
import { AISLE_LANE_M, aisleWays, linePath, manualWays, polygonPath, lanePolygon, wayArrows } from "./twin/aisleWays";
import { buildTwinWorld, clearWays } from "./twin/collision";
import MapStyleSwitch from "./MapStyleSwitch";
import { mapAttribution, tilesAround, useMapStyle } from "../sites";

// --------------------------------------------------------------------------
// Der Plan ist eine SVG-Karte in Metern. Zoom und Schwenken laufen über den
// viewBox — damit bleibt getScreenCTM die eine wahre Abbildung Maus↔Meter,
// und alle Strokes tragen non-scaling-stroke, damit sie unter Zoom knackscharf
// bleiben statt mitzuwachsen.
//
// Die Halle hat fünf Ebenen, und sie werden mit *demselben* Werkzeug gebaut:
//
//   Umriss     — die Außenlinie, ein Polygon
//   Zonen      — benannte Flächen (Lager, Fertigung, Versand), Polygone
//   Hindernisse— Stützen und Zwischenwände, Polygone
//   Gänge      — das Transportnetz: Knoten und Kanten, kein Polygon
//   Tore       — Punkte mit Breite
//
// Nur die Gänge gehen in eine Rechnung ein (die Entfernung Lager→Maschine in
// der Zuordnung). Alles andere ist Orientierung — was aber nicht heißt, dass
// es beliebig wäre: eine Halle, die man wiedererkennt, wird gepflegt, und
// eine, die man nicht wiedererkennt, veraltet still.
//
// Der Editor führt ein Gummiband mit Längen- und Winkelmaß, rastet
// rechtwinklig ein (Umschalt), springt auf den Startpunkt zurück (Magnet),
// zeigt beim Ziehen einer Station Ausrichtungslinien zu ihren Nachbarn, und
// misst auf Zuruf zwei Punkte aus.
// --------------------------------------------------------------------------

interface Vb { x: number; y: number; w: number; h: number }

const rad = (deg: number) => (deg * Math.PI) / 180;
const round2 = (v: number) => Math.round(v * 100) / 100;
const fmtNum = (v: number) => v.toLocaleString("de-DE", { maximumFractionDigits: 2 });

// Ecken: SE, SW, NW, NE — als Vorzeichenpaare (sx, sy).
const CORNER_SIGNS: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
const CORNER_CURSOR = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"];

/** Ausrichtungslinie: eine Station steht auf gleicher Achse wie eine andere. */
const ALIGN_TOL_PX = 7;

type Drag =
  | { kind: "move"; id: number; offx: number; offy: number; base: Station }
  | { kind: "resize"; id: number; corner: number; base: Station }
  | { kind: "rotate"; id: number; base: Station }
  | { kind: "draft"; idx: number }
  | { kind: "draft-body"; start: [number, number]; base: [number, number][] }
  | { kind: "draft-indent"; edgeIdx: number; base: [number, number][] }
  | { kind: "draft-edge"; edgeIdx: number; base: [number, number][] }
  | { kind: "node"; idx: number }
  | { kind: "door"; idx: number };

export interface FloorPlanProps {
  floor: Floor;
  stations: Station[];
  /** Auslastung je Station — Grundlage der Wärme. Minuten oder Stückzahl. */
  loads?: Record<number, number>;
  /** Größte Last unter den Stationen ohne Tageskapazität: Maßstab ihres neutralen Balkens. */
  maxUnknownLoad?: number;
  /** Was das Last-Badge zeigt: "min" rendert 45 min / 2,5 h. */
  loadUnit?: "count" | "min";
  selectedId?: number | null;
  hideInactive?: boolean;
  /** Materialfluss als Pfeile zwischen Stationen. */
  flow?: FlowEdge[];
  /** Zustand je Station. Ohne diese Angabe zeichnet der Plan wie bisher, der Editor bleibt, wie er ist. */
  status?: Record<number, StationMark>;
  /** Stationen, auf die ein Befund zeigt. */
  highlightIds?: number[];
  /** Wegstrecken hervorheben, die zu dieser Station führen. */
  highlightRoutesTo?: number | null;
  onStationClick?: (s: Station) => void;
  /** Während des Ziehens/Skalierens/Drehens — die ganze Station, live. */
  onStationMove?: (id: number, s: Station) => void;
  /** Beim Loslassen — hier gehört die Persistenz hin. */
  onStationDragEnd?: (id: number, s: Station) => void;
  movable?: boolean;

  // ---- Zeichnen -----------------------------------------------------------
  /** Welche Ebene bearbeitet wird. Ohne Ebene ist der Plan reine Ansicht. */
  layer?: FloorLayer | null;
  /** Polygon-Entwurf der aktiven Ebene (Umriss, Zone, Hindernis). */
  draft?: [number, number][];
  /** Geschlossener Entwurf (Vorlage, Bauteil, Rechteck oder bestehendes Objekt):
      Klicks auf die freie Fläche hängen keinen neuen Punkt an. */
  draftClosed?: boolean;
  draftColour?: string;
  onDraftPoint?: (p: [number, number]) => void;
  onDraftMove?: (idx: number, p: [number, number]) => void;
  onDraftMoveStart?: (idx: number) => void;
  /** Kompletten Entwurf verschieben/ersetzen (z. B. beim Ziehen der Fläche). */
  onDraftReplace?: (pts: [number, number][]) => void;
  onDraftDelete?: (idx: number) => void;
  /** Punkt auf einer Kante einfügen — Doppelklick auf die Kante. */
  onDraftInsert?: (afterIdx: number, p: [number, number]) => void;
  onDraftFinish?: () => void;
  /** Neu zeichnen starten (leert aktuellen Entwurf und öffnet Punkteingabe). */
  onDraftStartNew?: () => void;
  /** Geschlossenen Entwurf wieder öffnen, um weitere Punkte / Einbuchtungen anzuhängen. */
  onDraftReopen?: () => void;
  /** Rechteck-Modus: Ziehen oder zwei Klicks, vier Punkte kommen zurück. */
  rectMode?: boolean;
  onDraftRect?: (pts: [number, number][]) => void;
  /** Gerade bearbeitetes Hindernis/Zone (im Entwurf sichtbar, nicht doppelt zeichnen). */
  editingObstacleIdx?: number;
  editingZoneIdx?: number;
  /** Klick im Auswahl-Modus auf ein bestehendes Hindernis oder eine Zone. */
  onObstacleClick?: (idx: number) => void;
  onZoneClick?: (idx: number) => void;

  // ---- Gänge --------------------------------------------------------------
  /** Klick im Gang-Modus: neuer Knoten (oder Verbindung zu einem vorhandenen). */
  onAisleClick?: (p: [number, number], hitNode: number | null) => void;
  onAisleNodeMove?: (idx: number, p: [number, number]) => void;
  onAisleNodeMoveStart?: (idx: number) => void;
  onAisleNodeDelete?: (idx: number) => void;
  /** Rechtsklick auf eine Gangkante: löschen oder an dieser Stelle teilen. */
  onAisleEdgeDelete?: (idx: number) => void;
  onAisleEdgeSplit?: (idx: number, p: [number, number]) => void;
  /** Rechtsklick auf die freie Fläche: das Netz aufräumen. */
  onCleanAisles?: () => void;
  /** Der zuletzt gesetzte Knoten — von ihm läuft das Gummiband. */
  aisleAnchor?: number | null;
  /** Anbindung der Stationen ans Gangnetz: von Hand (durchgezogen), automatischer Stich (gestrichelt),
      Luftlinie (gepunktet, rot). */
  links?: { points: [number, number][]; kind: "manual" | "auto" | "air"; ok: boolean; selected?: boolean }[];
  /** Pfad von Hand in Arbeit. */
  pathDraft?: [number, number][] | null;
  /** Neue Gänge, die der Pfadfinder vorschlägt (noch nicht übernommen). */
  proposal?: [[number, number], [number, number]][] | null;

  // ---- Tore ---------------------------------------------------------------
  onDoorClick?: (p: [number, number]) => void;
  onDoorMove?: (idx: number, p: [number, number]) => void;
  onDoorMoveStart?: (idx: number) => void;
  onDoorSelect?: (idx: number) => void;
  selectedDoor?: number | null;
  doorKind?: Door["kind"];

  // ---- Messen -------------------------------------------------------------
  measureMode?: boolean;

  onCanvasDoubleClick?: (p: [number, number]) => void;
  ghost?: Station | null;
  /** Höhe der Bühne in Pixeln; null überlässt sie dem Stylesheet. */
  height?: number | null;
  /** Nur der Editor: Stationen neutral wie im Leitstand, Schrift in Bildschirmpixeln, Karte füllt die Bühne.
      Die gespeicherte Stationsfarbe bleibt in den Daten und wird hier nur nicht gezeichnet. */
  editorLook?: boolean;
  /** Ebenen ein-/ausblenden. ``lanes`` zeichnet das Gangnetz als Fahrspuren,
      ``paths`` die von Hand gezogenen Anschlusswege (im Editor kommen sie über ``links``). */
  show?: Partial<Record<"zones" | "obstacles" | "aisles" | "doors" | "grid" | "flow" | "labels" | "links" | "lanes" | "paths", boolean>>;
  /** Kartenanker der Halle (Aufgabe 32): Kacheln unter dem Grundriss. Leer = keine Karte. */
  map?: { lat: number; lon: number; rotation_deg: number } | null;
  /** Drehung der Halle auf der Karte, für den Nordpfeil; null = Halle ohne Kartenanker. */
  north?: number | null;
}

export default function FloorPlan({
  map = null,
  north = null,
  floor,
  stations,
  loads,
  maxUnknownLoad = 0,
  loadUnit = "count",
  selectedId = null,
  hideInactive = false,
  flow,
  status,
  highlightIds,
  highlightRoutesTo = null,
  onStationClick,
  onStationMove,
  onStationDragEnd,
  movable = false,
  layer = null,
  draft,
  draftClosed = false,
  draftColour = "var(--g-floor-error)",
  onDraftPoint,
  onDraftMove,
  onDraftMoveStart,
  onDraftReplace,
  onDraftDelete,
  onDraftInsert,
  onDraftFinish,
  onDraftStartNew,
  onDraftReopen,
  rectMode = false,
  onDraftRect,
  editingObstacleIdx = -1,
  editingZoneIdx = -1,
  onObstacleClick,
  onZoneClick,
  onAisleClick,
  onAisleNodeMove,
  onAisleNodeMoveStart,
  onAisleNodeDelete,
  onAisleEdgeDelete,
  onAisleEdgeSplit,
  onCleanAisles,
  aisleAnchor = null,
  links = [],
  pathDraft = null,
  proposal = null,
  onDoorClick,
  onDoorMove,
  onDoorMoveStart,
  onDoorSelect,
  selectedDoor = null,
  doorKind = "door",
  measureMode = false,
  onCanvasDoubleClick,
  ghost = null,
  height = 480,
  editorLook = false,
  show = {},
}: FloorPlanProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const vis = {
    zones: true, obstacles: true, aisles: true, doors: true,
    grid: true, flow: true, labels: true,
    // Im Editor kommen Handwege über ``links`` (mit Art und Warnung) daher;
    // die gespeicherten Pfade würden sie dort doppelt zeichnen.
    lanes: true, paths: !movable && !editorLook, ...show,
  };

  const snapM = floor.snap && floor.snap > 0 ? floor.snap : 0.25;
  const gridM = floor.grid && floor.grid > 0 ? floor.grid : 1;
  const snap = useCallback((v: number) => Math.round(v / snapM) * snapM, [snapM]);

  const polygonMode = layer === "outline" || layer === "zone" || layer === "obstacle";
  const aisleMode = layer === "aisle";
  const doorMode = layer === "door";
  const drawing = (polygonMode && !rectMode) || aisleMode || doorMode || measureMode || rectMode;

  const quietMap = !!status || editorLook;

  const fit = useMemo<Vb>(() => sceneBounds(floor, stations), [floor, stations.length]);
  const [vb, setVb] = useState<Vb>(fit);
  const [userMoved, setUserMoved] = useState(false);

  useEffect(() => {
    if (!userMoved) setVb(fit);
  }, [fit, userMoved]);

  const resetZoom = useCallback(() => { setVb(fit); setUserMoved(false); }, [fit]);

  const zoomBy = useCallback((factor: number) => {
    setVb((v) => {
      const w = v.w * factor;
      const h = v.h * factor;
      const cx = v.x + v.w / 2;
      const cy = v.y + v.h / 2;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    });
    setUserMoved(true);
  }, []);

  const toMeter = useCallback((clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const ctm = svg.getScreenCTM();
    if (!ctm) return [0, 0];
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return [pt.x, pt.y];
  }, []);

  /** Meter je Bildschirmpixel — Toleranzen in px übersetzen. */
  const statusMode = !!status;
  // Beschriftung in Pixeln braucht die echte Größe: einmal nach dem Einhängen und bei jeder Änderung.
  const [measured, setMeasured] = useState(0);
  /** Der sichtbare Ausschnitt. Im Editor auf das Seitenverhältnis der Bühne erweitert, damit Boden
      und Raster bis an den Rand reichen. Sonst ist er `vb`. */
  const view = useMemo<Vb>(() => {
    const box = editorLook ? svgRef.current?.getBoundingClientRect() : null;
    if (!box || !(box.width > 0) || !(box.height > 0)) return vb;
    const aspect = box.width / box.height;
    if (aspect > vb.w / vb.h) {
      const w = vb.h * aspect;
      return { x: vb.x - (w - vb.w) / 2, y: vb.y, w, h: vb.h };
    }
    const h = vb.w / aspect;
    return { x: vb.x, y: vb.y - (h - vb.h) / 2, w: vb.w, h };
  }, [vb, editorLook, measured]);
  const metersPerPx = useCallback((): number => {
    const svg = svgRef.current;
    if (!svg) return 0.05;
    const rect = svg.getBoundingClientRect();
    if (!(rect.width > 0)) return 0.05;
    // Im Leitstand ist der Plan oft hochkant: dann bestimmt die Höhe den Maßstab.
    return statusMode ? Math.max(vb.w / rect.width, vb.h / (rect.height || rect.width)) : view.w / rect.width;
  }, [vb, view, statusMode]);

  useEffect(() => {
    const svg = svgRef.current;
    if ((!statusMode && !editorLook) || !svg) return;
    const seen = new ResizeObserver(() => setMeasured((n) => n + 1));
    seen.observe(svg);
    return () => seen.disconnect();
  }, [statusMode, editorLook]);

  /** Overlay-Schrift in Bildschirmgröße: gewünschte Pixelhöhe → Nutzereinheiten.
      Der Plan rechnet in Metern; ein fester Wert in Metern wächst mit dem Zoom
      zu einem Schild, das die Halle verdeckt. */
  const fs = useCallback((px: number) => Math.max(px * metersPerPx(), 0.02), [metersPerPx]);
  const ppm = 1 / metersPerPx();
  /** Schriftgröße einer Ebene: im Leitstand in Pixeln und unter `minPpm` ausgeblendet (null). */
  const labelSize = (metres: number, px: number, minPpm: number): number | null =>
    editorLook ? (ppm >= minPpm / 2 ? fs(px) : null) : !statusMode ? metres : ppm >= minPpm ? fs(px) : null;

  /** Mausposition ins lokale, entdrehte Koordinatensystem der Station. */
  const toLocal = (mx: number, my: number, s: Station): [number, number] => {
    const dx = mx - s.x, dy = my - s.y, a = rad(-s.rotation);
    return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
  };

  /** Station unter einem Punkt — die kleinste gewinnt, bei Überlappungen
      zählt die präzise, nicht die größte Fläche. */
  const stationAt = useCallback((p: [number, number]): Station | null => {
    let hit: Station | null = null;
    let area = Infinity;
    for (const s of stations) {
      if (hideInactive && !s.active) continue;
      const [lx, ly] = toLocal(p[0], p[1], s);
      if (Math.abs(lx) <= s.w / 2 && Math.abs(ly) <= s.h / 2 && s.w * s.h < area) {
        hit = s; area = s.w * s.h;
      }
    }
    return hit;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, hideInactive]);
  const globalDelta = (lx: number, ly: number, rotation: number): [number, number] => {
    const r = rad(rotation);
    return [lx * Math.cos(r) - ly * Math.sin(r), lx * Math.sin(r) + ly * Math.cos(r)];
  };

  // Im Editor zoomt das Mausrad direkt um den Zeiger (wie in jedem CAD-Plan);
  // in eingebetteten Übersichtskarten nur mit Strg, damit die Seite scrollbar bleibt.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!editorLook && !drawing && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const [mx, my] = toMeter(e.clientX, e.clientY);
      const factor = e.deltaY > 0 ? 1.14 : 1 / 1.14;
      setVb((v) => {
        const w = Math.min(Math.max(v.w * factor, 4), Math.max(fit.w * 8, 400));
        const h = w * (v.h / v.w);
        return { x: mx - (mx - v.x) * (w / v.w), y: my - (my - v.y) * (h / v.h), w, h };
      });
      setUserMoved(true);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toMeter, fit, editorLook, drawing]);

  const [orthoLock, setOrthoLock] = useState(true);
  const spaceDownRef = useRef(false);
  useEffect(() => {
    if (!editorLook && !drawing) return;
    const onKd = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (e.code === "Space") spaceDownRef.current = true;
    };
    const onKu = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDownRef.current = false;
    };
    window.addEventListener("keydown", onKd);
    window.addEventListener("keyup", onKu);
    return () => {
      window.removeEventListener("keydown", onKd);
      window.removeEventListener("keyup", onKu);
    };
  }, [editorLook, drawing]);

  // Ein aktiver Griff nach dem anderen.
  const dragRef = useRef<(Drag & { latest?: Station }) | null>(null);
  const panRef = useRef<{ px: number; py: number; vb: Vb } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Rechtsklick-Menü: Kante, Knoten oder freie Fläche. */
  const [menu, setMenu] = useState<{
    x: number; y: number; kind: "edge" | "node" | "canvas"; idx: number; at: [number, number];
  } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** Achsen, auf denen die gezogene Station mit einer anderen fluchtet. */
  const [guides, setGuides] = useState<{ vx: number[]; hy: number[] }>({ vx: [], hy: [] });

  const beginDrag = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    dragRef.current = d;
    setDragging(true);
    // Bei Entwurfs-Operationen (Ecke, Fläche, Einbuchtung, Wand) können Punkte im
    // Array eingefügt werden -> immer am SVG selbst festhalten, damit kein Re-Render
    // das Pointer-Capture verliert!
    if (d.kind.startsWith("draft")) {
      svgRef.current?.setPointerCapture?.(e.pointerId);
    } else {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    }
  };

  /** Ausrichten an Nachbarn: liegt die gezogene Station fast auf einer Achse
      einer anderen, rastet sie ein und die Achse wird gezeigt. */
  const alignTo = (id: number, x: number, y: number): [number, number, number[], number[]] => {
    const tol = ALIGN_TOL_PX * metersPerPx();
    const vx: number[] = [], hy: number[] = [];
    let ax = x, ay = y;
    for (const o of stations) {
      if (o.id === id) continue;
      if (Math.abs(o.x - x) < tol) { ax = o.x; vx.push(o.x); }
      if (Math.abs(o.y - y) < tol) { ay = o.y; hy.push(o.y); }
    }
    return [ax, ay, vx, hy];
  };

  const applyDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const [mx, my] = toMeter(e.clientX, e.clientY);
    if (d.kind === "draft") {
      let x = snap(mx);
      let y = snap(my);
      if (draft && draft.length >= 2 && !e.shiftKey) {
        const alignTol = 8 * metersPerPx();
        for (let k = 0; k < draft.length; k++) {
          if (k === d.idx) continue;
          if (Math.abs(x - draft[k][0]) < alignTol) x = draft[k][0];
          if (Math.abs(y - draft[k][1]) < alignTol) y = draft[k][1];
        }
      }
      const p: [number, number] = [x, y];
      onDraftMove?.(d.idx, p);
      setTip({ x: p[0], y: p[1] - 0.45, text: `${fmtNum(p[0])} · ${fmtNum(p[1])} m` });
      return;
    }
    if (d.kind === "draft-indent") {
      const carved = carveWallIndentation(d.base, d.edgeIdx, [mx, my], snapM);
      if (carved) {
        onDraftReplace?.(carved.points);
        setTip({
          x: snap(mx),
          y: snap(my) - 0.5,
          text: `Einbuchtung: ${fmtNum(carved.width)} × ${fmtNum(carved.depth)} m`,
        });
      }
      return;
    }
    if (d.kind === "draft-edge") {
      const moved = moveWallSegmentOrthogonal(d.base, d.edgeIdx, [mx, my], snapM);
      onDraftReplace?.(moved);
      setTip({
        x: snap(mx),
        y: snap(my) - 0.5,
        text: `Wand verschieben (${fmtNum(snap(mx))} · ${fmtNum(snap(my))} m)`,
      });
      return;
    }
    if (d.kind === "draft-body") {
      const dx = snap(mx - d.start[0]);
      const dy = snap(my - d.start[1]);
      const nextPts = translatePolygon(d.base, dx, dy);
      onDraftReplace?.(nextPts);
      const c = polygonCentroid(nextPts);
      setTip({ x: c[0], y: c[1] - 0.45, text: `${fmtNum(c[0])} · ${fmtNum(c[1])} m` });
      return;
    }
    if (d.kind === "node") {
      const p: [number, number] = [snap(mx), snap(my)];
      onAisleNodeMove?.(d.idx, p);
      setTip({ x: p[0], y: p[1] - 0.45, text: `${fmtNum(p[0])} · ${fmtNum(p[1])} m` });
      return;
    }
    if (d.kind === "door") {
      const raw: [number, number] = [snap(mx), snap(my)];
      const cur = floor.doors?.[d.idx];
      const dk = cur ? effectiveDoorKind(cur) : doorKind;
      const p = e.altKey ? raw : snapDoorToWall(floor, raw, dk).point;
      onDoorMove?.(d.idx, p);
      setTip({ x: p[0], y: p[1] - 0.6, text: `${fmtNum(p[0])} · ${fmtNum(p[1])} m` });
      return;
    }
    if (!onStationMove) return;
    let next: Station;
    let tipText: string;
    if (d.kind === "move") {
      let x = snap(mx + d.offx);
      let y = snap(my + d.offy);
      const [ax, ay, vx, hy] = alignTo(d.id, x, y);
      x = ax; y = ay;
      setGuides({ vx, hy });
      next = { ...d.base, x, y };
      tipText = `${fmtNum(x)} · ${fmtNum(y)} m`;
    } else if (d.kind === "resize") {
      const [sx, sy] = CORNER_SIGNS[d.corner];
      const [lx, ly] = toLocal(mx, my, d.base);
      // Der gegenüberliegende Eckpunkt bleibt stehen; Mitte und Position wandern mit.
      const w = Math.max(0.5, snap(lx * sx + d.base.w / 2));
      const h = Math.max(0.5, snap(ly * sy + d.base.h / 2));
      const [dgx, dgy] = globalDelta((sx * (w - d.base.w)) / 2, (sy * (h - d.base.h)) / 2, d.base.rotation);
      next = { ...d.base, w, h, x: round2(d.base.x + dgx), y: round2(d.base.y + dgy) };
      tipText = `${fmtNum(w)} × ${fmtNum(h)} m`;
    } else {
      const [lx, ly] = toLocal(mx, my, d.base);
      let deg = (Math.atan2(ly, lx) * 180) / Math.PI + 90;
      deg = ((deg % 360) + 360) % 360;
      const step = e.altKey ? 1 : 15; // Alt: frei drehen, sonst Raster.
      const snapped = Math.round(deg / step) * step;
      const rotation = snapped > 180 ? snapped - 360 : snapped;
      next = { ...d.base, rotation };
      tipText = `${rotation}°${e.altKey ? "" : " (Raster 15°)"}`;
    }
    d.latest = next;
    onStationMove(d.id, next);
    setTip({ x: next.x, y: next.y - next.h / 2 - 0.55, text: tipText });
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    setTip(null);
    setGuides({ vx: [], hy: [] });
    if (d && (d.kind === "move" || d.kind === "resize" || d.kind === "rotate")
        && d.latest && onStationDragEnd) {
      onStationDragEnd(d.id, d.latest);
    }
  };

  // Rechteck-Modus: Ziehen (PointerDown -> PointerUp) ODER zwei Klicks.
  const [rectStart, setRectStart] = useState<[number, number] | null>(null);
  const rectDragRef = useRef(false);
  useEffect(() => { if (!rectMode) { setRectStart(null); rectDragRef.current = false; } }, [rectMode]);

  // Schwenken: Hintergrund ziehen — im Zeichen-Modus mit Leertaste, Mittel- oder Rechtsklick.
  const onBgPointerDown = (e: React.PointerEvent) => {
    if (dragRef.current) return;
    if (rectMode && e.button === 0 && !spaceDownRef.current) {
      const [mx, my] = toMeter(e.clientX, e.clientY);
      const pt: [number, number] = [snap(mx), snap(my)];
      if (!rectStart) {
        setRectStart(pt);
        rectDragRef.current = true;
      }
      return;
    }
    if (drawing && !(polygonMode && draftClosed) && e.button === 0 && !spaceDownRef.current) return; // Klick gehört der Zeichnung.
    if ((e.target as Element).closest?.(".floor-aisles, .floor-draft-body, .floor-draft-hit")) return; // Kante/Knoten/Entwurf behalten den Klick.
    if (!drawing && (e.target as Element).closest?.(".floor-station, .floor-obstacle, .floor-door")) return;
    panRef.current = { px: e.clientX, py: e.clientY, vb };
    if (e.button !== 0 || spaceDownRef.current) e.preventDefault();
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  // Zeigerposition für Gummiband und Rechteckvorschau.
  const [cursorState, setCursorState] = useState<{ x: number; y: number; shift: boolean } | null>(null);

  // Einbuchtungs-Werkzeug auf geschlossenen Umrissen: Klick oder Ziehen auf einer Wand
  // stanzt sofort eine rechtwinklige 4-Punkt-Einbuchtung in die Wand.
  const [indentMode, setIndentMode] = useState(false);
  useEffect(() => {
    if (!polygonMode || !draftClosed) setIndentMode(false);
  }, [polygonMode, draftClosed]);

  /** Zeigerposition mit allen Rastern: Fangweite, 90°-Winkelrast + Fluchtlinien auf
      vorhandene Eckpunkte, Magnet auf den Startpunkt (schließt das Polygon). */
  const displayCursor = useCallback((): [number, number] | null => {
    if (!cursorState) return null;
    let x = snap(cursorState.x);
    let y = snap(cursorState.y);
    const anchorPts = polygonMode ? draft : null;
    const useOrtho = orthoLock ? !cursorState.shift : cursorState.shift;
    if (anchorPts?.length) {
      const p0 = anchorPts[0];
      if (anchorPts.length >= 3 && Math.hypot(x - p0[0], y - p0[1]) < 15 * metersPerPx()) return p0;
      const last = anchorPts[anchorPts.length - 1];
      const alignTol = 9 * metersPerPx();
      if (useOrtho) {
        const horiz = Math.abs(x - last[0]) >= Math.abs(y - last[1]);
        if (horiz) {
          y = last[1];
          // Nur X auf bestehende Ecken einrasten (niemals auf last[0] selbst, sonst Länge 0!).
          for (const pt of anchorPts) {
            if (Math.abs(pt[0] - last[0]) >= snapM && Math.abs(x - pt[0]) < alignTol) {
              x = pt[0];
              break;
            }
          }
        } else {
          x = last[0];
          // Nur Y auf bestehende Ecken einrasten (niemals auf last[1] selbst!).
          for (const pt of anchorPts) {
            if (Math.abs(pt[1] - last[1]) >= snapM && Math.abs(y - pt[1]) < alignTol) {
              y = pt[1];
              break;
            }
          }
        }
      } else {
        for (const pt of anchorPts) {
          if (Math.abs(x - pt[0]) < alignTol && Math.abs(pt[0] - last[0]) >= snapM) x = pt[0];
          if (Math.abs(y - pt[1]) < alignTol && Math.abs(pt[1] - last[1]) >= snapM) y = pt[1];
        }
      }
    }
    if (aisleMode && useOrtho && aisleAnchor != null) {
      const a = floor.aisles?.nodes?.[aisleAnchor];
      if (a) {
        if (Math.abs(x - a[0]) >= Math.abs(y - a[1])) y = a[1];
        else x = a[0];
      }
    }
    return [x, y];
  }, [cursorState, snap, snapM, polygonMode, draft, metersPerPx, aisleMode, aisleAnchor, floor.aisles, orthoLock]);

  const onBgPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current) { applyDrag(e); return; }
    if (panRef.current) {
      const p = panRef.current;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const dx = ((e.clientX - p.px) * p.vb.w * (view.w / vb.w)) / rect.width;
      const dy = ((e.clientY - p.py) * p.vb.h * (view.h / vb.h)) / rect.height;
      setVb({ x: p.vb.x - dx, y: p.vb.y - dy, w: p.vb.w, h: p.vb.h });
      setUserMoved(true);
      return;
    }
    if (drawing) {
      const [mx, my] = toMeter(e.clientX, e.clientY);
      setCursorState({ x: mx, y: my, shift: e.shiftKey });
    }
  };

  const onBgPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) { endDrag(); return; }
    if (rectMode && rectStart && rectDragRef.current) {
      rectDragRef.current = false;
      const [mx, my] = toMeter(e.clientX, e.clientY);
      const [x1, y1] = [snap(mx), snap(my)];
      const [x0, y0] = rectStart;
      if (Math.abs(x1 - x0) >= 0.5 && Math.abs(y1 - y0) >= 0.5) {
        setRectStart(null);
        onDraftRect?.([
          [Math.min(x0, x1), Math.min(y0, y1)],
          [Math.max(x0, x1), Math.min(y0, y1)],
          [Math.max(x0, x1), Math.max(y0, y1)],
          [Math.min(x0, x1), Math.max(y0, y1)],
        ]);
        return;
      }
    }
    panRef.current = null;
  };

  const onBgPointerCancel = () => {
    // Übernimmt der Browser die Geste (Seite scrollen), endet das Schwenken hier.
    panRef.current = null;
  };

  const onBgPointerLeave = () => {
    if (dragRef.current) { endDrag(); return; }
    panRef.current = null;
    setCursorState(null);
  };

  // Messen: zwei Punkte, dann steht das Maß bis zum nächsten Klick.
  const [measure, setMeasure] = useState<{ a: [number, number]; b: [number, number] | null } | null>(null);
  useEffect(() => { if (!measureMode) setMeasure(null); }, [measureMode]);

  useEffect(() => {
    if (!menu) return;
    const box = menuRef.current;
    box?.querySelector<HTMLElement>("button")?.focus();
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    const away = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const blur = () => setMenu(null);
    window.addEventListener("keydown", close);
    window.addEventListener("pointerdown", away);
    window.addEventListener("resize", blur);
    window.addEventListener("scroll", blur, true);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("resize", blur);
      window.removeEventListener("scroll", blur, true);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent, kind: "edge" | "node" | "canvas", idx: number, at: [number, number]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 220),
      y: Math.min(e.clientY, window.innerHeight - 170),
      kind, idx, at,
    });
  };

  const onPlanClick = (e: React.MouseEvent) => {
    if (!drawing || spaceDownRef.current) return;
    const [mx, my] = toMeter(e.clientX, e.clientY);
    const shown = displayCursor() ?? [snap(mx), snap(my)] as [number, number];

    if (measureMode) {
      setMeasure((m) => (!m || m.b ? { a: shown, b: null } : { a: m.a, b: shown }));
      return;
    }
    if (rectMode) {
      if (!rectStart) { setRectStart(shown); return; }
      const [x0, y0] = rectStart;
      const [x1, y1] = shown;
      if (Math.abs(x1 - x0) < 0.25 || Math.abs(y1 - y0) < 0.25) return;
      setRectStart(null);
      onDraftRect?.([
        [Math.min(x0, x1), Math.min(y0, y1)],
        [Math.max(x0, x1), Math.min(y0, y1)],
        [Math.max(x0, x1), Math.max(y0, y1)],
        [Math.min(x0, x1), Math.max(y0, y1)],
      ]);
      return;
    }
    if (aisleMode) {
      let at: [number, number] = shown;
      /* Ein Gang soll ans Objekt anschließen, nicht daneben enden: liegt der
         Klick auf einer Station (oder knapp an ihr), landet der Knoten auf
         ihrem Mittelpunkt — genau dort, wo die Wegerechnung den Stichweg
         ansetzt. Eine Platte von vier Metern Länge war vorher kein Ziel, weil
         nur ein schmaler Ring um die Mitte griff. */
      const onStation = stationAt(shown);
      if (onStation) {
        at = [onStation.x, onStation.y];
      } else {
        let bestD = 14 * metersPerPx();
        for (const s of stations) {
          if (hideInactive && !s.active) continue;
          const d = Math.hypot(shown[0] - s.x, shown[1] - s.y);
          if (d < bestD) { bestD = d; at = [s.x, s.y]; }
        }
      }
      const hit = nearestNode(floor.aisles ?? { nodes: [], edges: [] }, at);
      const near = hit.idx >= 0 && hit.dist < 14 * metersPerPx() ? hit.idx : null;
      onAisleClick?.(at, near);
      return;
    }
    if (doorMode) {
      const snapped = e.altKey ? shown : snapDoorToWall(floor, shown, doorKind).point;
      onDoorClick?.(snapped);
      return;
    }
    if (!onDraftPoint || draftClosed) return;
    // Magnet: nah am Startpunkt → Polygon gilt als geschlossen.
    if (draft && draft.length >= 3) {
      const p0 = draft[0];
      if (Math.hypot(mx - p0[0], my - p0[1]) < 15 * metersPerPx()) { onDraftFinish?.(); return; }
    }
    // Keinen doppelten Punkt exakt auf den letzten Punkt setzen.
    if (draft && draft.length >= 1) {
      const prev = draft[draft.length - 1];
      if (Math.hypot(shown[0] - prev[0], shown[1] - prev[1]) < 0.05) return;
    }
    onDraftPoint(shown);
  };

  const onPlanDoubleClick = (e: React.MouseEvent) => {
    if (drawing || !movable || !onCanvasDoubleClick) return;
    const [mx, my] = toMeter(e.clientX, e.clientY);
    onCanvasDoubleClick([snap(mx), snap(my)]);
  };

  const onPlanContextMenu = (e: React.MouseEvent) => {
    if (drawing) { e.preventDefault(); return; } // Rechtsklick zieht dort die Karte.
    // Kante/Knoten öffnen ihr eigenes Menü; das SVG darf es nicht überschreiben.
    if ((e.target as Element).closest(".floor-aisles")) { e.preventDefault(); return; }
    if (onCleanAisles) {
      const [mx, my] = toMeter(e.clientX, e.clientY);
      openMenu(e, "canvas", -1, [snap(mx), snap(my)]);
    }
  };

  // Warnungen: außerhalb der Halle, Überlappung, auf einem Hindernis — nur im
  // Editor; im Ansichtsmodus wäre es nur Lärm.
  const warn = useMemo(() => {
    const out = new Set<number>();
    const over = new Set<number>();
    const block = new Set<number>();
    if (!movable) return { out, over, block };
    const ids = stations.filter((s) => s.id != null) as (Station & { id: number })[];
    for (const s of ids) {
      if (stationOutsideOutline(s, floor.outline ?? [])) out.add(s.id);
      if (stationOnObstacle(s, floor.obstacles ?? [])) block.add(s.id);
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (stationsOverlap(ids[i], ids[j])) { over.add(ids[i].id); over.add(ids[j].id); }
      }
    }
    return { out, over, block };
  }, [stations, floor, movable]);

  // Raster in Metern über den sichtbaren Bereich. Bei starkem Auszoomen wird
  // die Schrittweite verdoppelt, sonst wird die Karte zu einer grauen Fläche.
  const gridLines = useMemo(() => {
    if (!vis.grid) return [];
    let step = gridM;
    const px = metersPerPx();
    while (step / px < 6) step *= 2;
    const lines: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    const x0 = Math.floor(view.x / step) * step, x1 = Math.ceil((view.x + view.w) / step) * step;
    const y0 = Math.floor(view.y / step) * step, y1 = Math.ceil((view.y + view.h) / step) * step;
    if ((x1 - x0) / step > 400 || (y1 - y0) / step > 400) return [];
    for (let gx = x0; gx <= x1; gx += step) {
      lines.push({ x1: gx, y1: y0, x2: gx, y2: y1, major: Math.abs(gx % (step * 5)) < 1e-6 });
    }
    for (let gy = y0; gy <= y1; gy += step) {
      lines.push({ x1: x0, y1: gy, x2: x1, y2: gy, major: Math.abs(gy % (step * 5)) < 1e-6 });
    }
    return lines;
  }, [view, gridM, vis.grid, metersPerPx]);

  const shown = stations.filter((s) => (hideInactive ? s.active : true));
  const outline = floor.outline?.length ? floor.outline : [];
  const floorHolePolys = useMemo(
    () => (floor.obstacles ?? [])
      .filter((o, idx) => idx !== editingObstacleIdx && isFloorHoleObstacle(o) && (o.points?.length ?? 0) >= 3)
      .map((o) => o.points),
    [floor.obstacles, editingObstacleIdx],
  );
  const [mapStyle, setMapStyle] = useMapStyle();
  // Nur so viele Kacheln, wie die Bühne zeigt; gerundet, damit Ziehen nicht jede Kachel neu setzt.
  const mapReach = map ? Math.ceil((Math.hypot(view.x + view.w / 2, view.y + view.h / 2) + Math.hypot(view.w, view.h) / 2 + 20) / 50) * 50 : 0;
  // Feinste Stufe, die beide Anbieter überall haben: 19. Eine kleine Halle füllt die Bühne, also so fein wie möglich.
  const mapZoom = mapReach > 900 ? 16 : mapReach > 450 ? 17 : mapReach > 220 ? 18 : 19;
  const mapTiles = useMemo(
    () => (map && (map.lat || map.lon) ? tilesAround(map.lat, map.lon, mapReach, mapZoom, mapStyle) : []),
    [map, mapReach, mapZoom, mapStyle]);
  // Kacheln, die nicht kamen (offline, Anbieter blockt): sagen statt leerer Fläche.
  const [tileFails, setTileFails] = useState(0);
  useEffect(() => setTileFails(0), [map, mapStyle]);
  // Der Vorgabewert folgt dem Erscheinungsbild; eine eigene Hallenfarbe bleibt, wie sie ist.
  const bg = !floor.bg || floor.bg === "#f5f5f0" ? "var(--g-floor-hall)" : floor.bg;
  const aisles: Aisles = floor.aisles ?? { nodes: [], edges: [] };
  /** Fahrspuren und Handwege: in allen drei Ansichten dieselbe Geometrie.
      Die Spuren werden an den Körpern der Halle gekappt, damit kein Weg
      sichtbar durch eine Maschine oder Stütze läuft. */
  const ways = useMemo(() => aisleWays(floor), [floor]);
  const storedPaths = useMemo(() => manualWays(floor), [floor]);
  const world = useMemo(() => buildTwinWorld(floor, stations), [floor, stations]);
  const displayWays = useMemo(() => clearWays(ways, world, {
    radius: AISLE_LANE_M / 2, groups: ["station", "obstacle"], step: 0.4,
  }), [ways, world]);
  const byId = useMemo(() => {
    const m: Record<number, Station> = {};
    for (const s of stations) if (s.id != null) m[s.id] = s;
    return m;
  }, [stations]);

  // Gummiband-Ziel: Zeiger mit allen Rastern.
  const cursor = drawing ? displayCursor() : null;
  const lastDraft = polygonMode && draft?.length ? draft[draft.length - 1] : null;
  const anchorNode = aisleMode && aisleAnchor != null ? aisles.nodes?.[aisleAnchor] : null;
  const magnet =
    polygonMode && draft && draft.length >= 3 && cursor &&
    cursor[0] === draft[0][0] && cursor[1] === draft[0][1];

  const hint =
    measureMode ? "Messen: zwei Klicks setzen Anfang und Ende. Das Maß bleibt stehen, bis du neu misst."
    : rectMode ? "Rechteck: aufziehen (Klicken & Ziehen) oder zwei Ecken anklicken · Mausrad zoomt · Leertaste+Ziehen verschiebt."
    : aisleMode ? "Gang: Klick auf oder nahe einer Maschine setzt den Knoten auf ihre Mitte · Klick auf Knoten hängt an · 90°-Rast aktiv · Rechtsklick teilt/löscht."
    : doorMode ? "Zugang: Klick rastet an der nächsten Wand ein (Alt = frei) · Ziehen verschiebt ihn."
    : polygonMode && draftClosed && indentMode ? "Einbuchtung aktiv: Klick oder Ziehen auf einer Wand stanzt sofort eine 90°-Einbuchtung · Wandkante ziehen passt Tiefe an."
    : polygonMode && draftClosed ? "Ecken ziehen · Wandkante ziehen verschiebt Wand · [⊔]-Griff auf Wand zieht 90°-Einbuchtung · (+)-Griff teilt Wand · Enter übernimmt."
    : polygonMode ? "Offener Linienzug: Klick setzt nächste Wand-Ecke (90°-Rast aktiv, Umschalt = frei) · Einbuchtungen frei nach innen zeichnen · Klick auf Startpunkt (grün) oder Enter schließt."
    : movable ? "Klick wählt Station, Wand, Zone oder Tür · Ziehen verschiebt · Eckpunkte skalieren · Kreis dreht · Mausrad zoomt."
    : "Mausrad zoomt · Ziehen schiebt · Klick oder Enter auf Station öffnet sie.";

  const maxFlow = useMemo(
    () => Math.max(1, ...(flow ?? []).map((e) => e.count)), [flow]);

  // Im Gang-Modus die Maschine markieren, die der Klick treffen würde —
  // sonst bleibt das Anschließen unsichtbar, bis man es schon getan hat.
  const aisleTarget = aisleMode && cursor ? stationAt(cursor) : null;

  return (
    <div className="floor-card">
      <div className="floor-toolbar">
        <span className="floor-hint">{hint}</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {(polygonMode || aisleMode) && (
            <Button
              small
              minimal={!orthoLock}
              intent={orthoLock ? "primary" : "none"}
              icon="layout"
              text="90°-Rast"
              title="Rechtwinkliges Zeichnen & Fluchtlinien (Umschalt kehrt temporär um)"
              onClick={() => setOrthoLock((v) => !v)}
            />
          )}
          {polygonMode && draftClosed && (draft?.length ?? 0) >= 3 && onDraftReplace && (
            <Button
              small
              minimal={!indentMode}
              intent={indentMode ? "warning" : "none"}
              icon="insert"
              text="Einbuchtung (⊔)"
              title="Auf eine Wand klicken oder ziehen, um eine rechtwinklige 90°-Einbuchtung / Ausbuchtung einzufügen"
              onClick={() => setIndentMode((v) => !v)}
            />
          )}
          {polygonMode && draftClosed && (draft?.length ?? 0) >= 3 && onDraftReopen && (
            <Button
              small
              icon="edit"
              text="Weiterzeichnen"
              title="Geschlossenen Umriss wieder öffnen, um weitere Punkte & Einbuchtungen frei anzuhängen"
              onClick={() => { setIndentMode(false); onDraftReopen(); }}
            />
          )}
          {polygonMode && draftClosed && onDraftStartNew && (
            <Button
              small
              icon="polygon-filter"
              text="Neu zeichnen"
              title="Aktuellen Entwurf leeren und Punkt für Punkt als offenen Linienzug neu zeichnen"
              onClick={() => { setIndentMode(false); onDraftStartNew(); }}
            />
          )}
          {polygonMode && !draftClosed && (draft?.length ?? 0) > 0 && onDraftDelete && (
            <Button
              small
              icon="undo"
              text="Punkt zurück"
              title="Letzten gesetzten Punkt entfernen (Rücktaste)"
              onClick={() => onDraftDelete((draft?.length ?? 1) - 1)}
            />
          )}
          {polygonMode && (draft?.length ?? 0) >= 3 && onDraftFinish && (
            <Button
              small
              intent="primary"
              icon="tick"
              text={draftClosed ? "Übernehmen (Enter)" : "Schließen & Übernehmen (Enter)"}
              title="Gezeichneten Umriss schließen und übernehmen"
              onClick={onDraftFinish}
            />
          )}
          <ButtonGroup minimal>
            <Button icon="zoom-out" onClick={() => zoomBy(1.25)} title="Herauszoomen (Mausrad)" />
            <Button icon="zoom-in" onClick={() => zoomBy(1 / 1.25)} title="Hineinzoomen (Mausrad)" />
            <Button icon="locate" onClick={resetZoom} title="Auf Grundriss einpassen" />
          </ButtonGroup>
        </div>
      </div>
      <div className="floor-stage" style={height == null ? undefined : { height }}>
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          className={"floor-svg" + (drawing ? " floor-draw" : "") + (dragging ? " floor-dragging" : "") + (userMoved ? " floor-zoomed" : "")}
          onPointerDown={onBgPointerDown}
          onPointerMove={onBgPointerMove}
          onPointerUp={onBgPointerUp}
          onPointerLeave={onBgPointerLeave}
          onPointerCancel={onBgPointerCancel}
          onClick={onPlanClick}
          onDoubleClick={onPlanDoubleClick}
          onContextMenu={onPlanContextMenu}
        >
          {statusMode && <StatusDefs fs={fs} />}
          <defs>
            <pattern id="floor-hatch" width="0.6" height="0.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="0.6" stroke="var(--g-floor-hatch)" strokeWidth="0.06" opacity="0.5" />
            </pattern>
            <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
            </marker>
          </defs>

          {/* Außenfläche und Halle. */}
          <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="var(--g-floor-outside)" />
          {mapTiles.length > 0 && (
            // Kacheln in Ost/Süd-Metern; rotate(θ) legt sie auf die Hallenachsen (sites.hallToWorld).
            <g transform={`rotate(${map?.rotation_deg ?? 0})`} opacity={0.9} pointerEvents="none">
              {mapTiles.map((t) => (
                <image key={t.url} href={t.url} x={t.east - t.size / 2} y={-t.north - t.size / 2}
                  width={t.size} height={t.size} preserveAspectRatio="none" onError={() => setTileFails((n) => n + 1)} />
              ))}
            </g>
          )}
          {outline.length > 0 && (
            <path
              d={outlineWithHolesPath(outline, floorHolePolys)}
              fillRule="evenodd"
              fill={bg}
              fillOpacity={mapTiles.length ? 0.55 : 1}
            />
          )}

          {/* Meter-Raster. */}
          <g>
            {gridLines.map((l, i) => (
              <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                stroke={l.major ? "var(--g-floor-grid-major)" : "var(--g-floor-grid)"} strokeWidth={l.major ? 0.03 : 0.018}
                vectorEffect="non-scaling-stroke" />
            ))}
          </g>

          {/* Zonen — unter allem, sie sind Hintergrund. */}
          {vis.zones && (floor.zones ?? []).map((z, i) => (
            i === editingZoneIdx ? null : (
              <ZoneShape key={`z${i}`} zone={z} labels={vis.labels} quiet={quietMap}
                nameSize={labelSize(0.5, 12, 6)} subSize={labelSize(0.32, 11, 14)} halo={quietMap ? fs(3) : undefined}
                onPick={movable && !drawing && onZoneClick ? () => onZoneClick(i) : undefined} />
            )
          ))}

          {/* Hindernisse — schraffiert oder je Bauteil-Art (Wand, Raumbox, Stütze, Zaun). */}
          {vis.obstacles && (floor.obstacles ?? []).map((o, i) => (
            i === editingObstacleIdx ? null : (
              <ObstacleShape key={`o${i}`} obstacle={o} labels={vis.labels} size={labelSize(0.34, 10.5, 12)}
                onPick={movable && !drawing && onObstacleClick ? () => onObstacleClick(i) : undefined} />
            )
          ))}

          {/* Förderbänder (task 37): Band in Bandbreite, Brückenabschnitte gestrichelt,
              Stützen und niedrige Teile als Körper (dieselbe Regel wie Wege und Kollisionen). */}
          {(floor.conveyors ?? []).map((c, i) => {
            const pts = conveyorPoints(c);
            if (pts.length < 2) return null;
            const w = conveyorWidth(c);
            const mid = pts[Math.floor(pts.length / 2)];
            return (
              <g key={`cv${i}`} className="floor-conveyor" pointerEvents="none">
                {conveyorFootprint(pts, w).map((poly, k) => (
                  <path key={k} d={polygonPath(poly)} fill="var(--g-dev-paint-dark)" fillOpacity={0.55} />
                ))}
                <polyline points={pts.map((p) => `${p[0]},${p[1]}`).join(" ")} fill="none"
                  stroke="var(--g-dev-steel)" strokeWidth={w} strokeLinejoin="round" strokeOpacity={0.9} />
                <polyline points={pts.map((p) => `${p[0]},${p[1]}`).join(" ")} fill="none"
                  stroke="var(--g-dev-paint-dark)" strokeWidth={w * 0.45} strokeDasharray={`${w * 0.5} ${w * 0.35}`} />
                {/* Gate task 41: null heißt „zu klein, ausblenden“ — vorher fiel die
                    Schrift auf 14 Planeinheiten zurück, also 14 m hohe Buchstaben. */}
                {vis.labels && labelSize(0.34, 10.5, 12) != null && (
                  <text x={mid[0]} y={mid[1] - w} textAnchor="middle" fontSize={labelSize(0.34, 10.5, 12)!}
                    fill="var(--g-text-2)">{c.name || "Förderband"}</text>
                )}
              </g>
            );
          })}

          {/* Gänge. Das Netz, mit dem gerechnet wird — deshalb sichtbar und
              nicht dezent: wer es nicht sieht, pflegt es nicht. */}
          {/* Fahrspuren: der Weg ist eine Fläche, nicht nur ein Strich. Die
              gestrichelte Mittellinie und die Knoten bleiben darüber liegen. */}
          {vis.aisles && vis.lanes && displayWays.length > 0 && (
            <g className="floor-aisle-lanes" pointerEvents="none">
              {displayWays.map((w, i) => (
                <path key={`lane-${i}`} className={"floor-aisle-lane " + (w.kind === "path" ? "floor-aisle-lane-path" : "")}
                  d={polygonPath(lanePolygon(w.points, AISLE_LANE_M))}
                  fill="var(--g-floor-aisle-lane)" fillOpacity={w.kind === "path" ? 0.5 : 0.78}
                  stroke="var(--g-floor-aisle-edge)" strokeWidth={1.2} strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          )}
          {/* Handwege: nur in der Ansicht. Im Editor kommen sie als ``links``
              mit Unterscheidung zwischen manuell, automatisch und Luftlinie. */}
          {vis.paths && storedPaths.length > 0 && (
            <g className="floor-aisle-paths" pointerEvents="none">
              {storedPaths.map((w, i) => (
                <path key={`path-${i}`} className="floor-aisle-path"
                  d={linePath(w.points)} fill="none" stroke="var(--g-floor-aisle)"
                  strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke" opacity={0.8} />
              ))}
            </g>
          )}
          {vis.aisles && vis.lanes && vis.labels && !movable && displayWays.length > 0 && (
            <g className="floor-aisle-arrows" pointerEvents="none">
              {displayWays.flatMap((w, i) => wayArrows(w.points).map((a, j) => (
                <g key={`arr-${i}-${j}`}
                  transform={`translate(${a.at[0]} ${a.at[1]}) rotate(${Math.atan2(a.dir[1], a.dir[0]) * 180 / Math.PI}) scale(${fs(1)})`}>
                  <path d="M-5 -4 L0 0 L-5 4" fill="none" stroke="var(--g-floor-aisle)"
                    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" opacity={0.6} />
                </g>
              )))}
            </g>
          )}

          {vis.aisles && aisles.nodes?.length > 0 && (
            <g className="floor-aisles">
              {(aisles.edges ?? []).map(([i, j], k) => {
                const a = aisles.nodes[i], b = aisles.nodes[j];
                if (!a || !b) return null;
                return (
                  <line key={`e${k}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                    stroke="var(--g-floor-aisle)" strokeWidth={aisleMode ? 3 : 2} strokeLinecap="round"
                    strokeDasharray="0.9 0.5" opacity={aisleMode ? 0.95 : 0.5}
                    vectorEffect="non-scaling-stroke" />
                );
              })}
              {(onAisleEdgeDelete || onAisleEdgeSplit) && (aisles.edges ?? []).map(([i, j], k) => {
                const a = aisles.nodes[i], b = aisles.nodes[j];
                if (!a || !b) return null;
                return (
                  <line key={`eh${k}`} className="floor-aisle-hit" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                    stroke="transparent" strokeWidth={16} strokeLinecap="round" vectorEffect="non-scaling-stroke"
                    style={{ cursor: "context-menu" }}
                    onContextMenu={(e) => {
                      const [mx, my] = toMeter(e.clientX, e.clientY);
                      openMenu(e, "edge", k, [snap(mx), snap(my)]);
                    }}
                    onDoubleClick={(e) => {
                      if (!onAisleEdgeSplit) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const [mx, my] = toMeter(e.clientX, e.clientY);
                      onAisleEdgeSplit(k, [snap(mx), snap(my)]);
                    }} />
                );
              })}
              {aisles.nodes.map((p, i) => (
                <g key={`n${i}`}>
                  {aisleMode && (
                    <circle className="floor-node-hit" cx={p[0]} cy={p[1]} r={0.45} fill="transparent"
                      style={{ cursor: "move" }}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || dragRef.current) return;
                        beginDrag(e, { kind: "node", idx: i });
                        onAisleNodeMoveStart?.(i);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (e.altKey) onAisleNodeDelete?.(i);
                        else onAisleClick?.([p[0], p[1]], i);
                      }}
                      onContextMenu={(e) => {
                        if (e.altKey) { e.preventDefault(); e.stopPropagation(); onAisleNodeDelete?.(i); return; }
                        openMenu(e, "node", i, [p[0], p[1]]);
                      }} />
                  )}
                  <circle cx={p[0]} cy={p[1]} r={aisleMode ? 0.2 : 0.13}
                    fill={i === aisleAnchor ? "var(--g-floor-warn)" : "var(--g-floor-aisle)"}
                    stroke="var(--g-surface)" strokeWidth={0.04} pointerEvents="none" />
                </g>
              ))}
            </g>
          )}

          {vis.links && links.length > 0 && (
            <g className="floor-links" pointerEvents="none">
              {links.map((l, k) => (
                <polyline key={k} className={`floor-link floor-link-${l.kind}`}
                  points={l.points.map((q) => `${q[0]},${q[1]}`).join(" ")} fill="none"
                  stroke={l.kind === "air" || !l.ok ? "var(--g-floor-error)" : "var(--g-floor-aisle)"}
                  strokeWidth={l.selected ? 3.5 : 2.5} strokeLinecap="round" strokeLinejoin="round"
                  strokeDasharray={l.kind === "manual" ? undefined : l.kind === "auto" ? "0.5 0.3" : "0.05 0.28"}
                  opacity={l.selected ? 1 : 0.75} vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          )}
          {pathDraft && pathDraft.length > 0 && (
            <g pointerEvents="none">
              <polyline points={pathDraft.map((q) => `${q[0]},${q[1]}`).join(" ")} fill="none" stroke="var(--g-floor-warn)"
                strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              {pathDraft.map((q, k) => <circle key={k} cx={q[0]} cy={q[1]} r={0.18} fill="var(--g-floor-warn)" stroke="var(--g-surface)" strokeWidth={0.04} />)}
            </g>
          )}
          {proposal && proposal.length > 0 && (
            <g className="floor-proposal" pointerEvents="none">
              {proposal.map(([p, q], k) => (
                <line key={k} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="var(--gimel-accent)" strokeWidth={3.5}
                  strokeDasharray="0.6 0.3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          )}

          {/* Materialfluss — was zwischen den Stationen wirklich läuft. */}
          {vis.flow && (flow ?? []).map((e, i) => {
            const a = byId[e.from], b = byId[e.to];
            if (!a || !b) return null;
            const routed = routePoints(aisles, [a.x, a.y], [b.x, b.y], floor.obstacles ?? [], floor.outline ?? []);
            return <FlowArrow key={`f${i}`} a={a} b={b} edge={e} maxCount={maxFlow}
                              route={routed.exact ? routed.points : undefined}
                              dim={highlightRoutesTo != null && e.to !== highlightRoutesTo
                                   && e.from !== highlightRoutesTo}
                              size={labelSize(0.34, 10.5, 9)} quiet={statusMode} halo={statusMode ? fs(3) : undefined} />;
          })}

          {/* Umriss über den Flächen. */}
          {outline.length > 0 && (
            <path d={outlinePath(outline)} fill="none" stroke="var(--gimel-accent)" strokeWidth={2}
              vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          )}

          {/* Tore auf der Wand. */}
          {vis.doors && (floor.doors ?? []).map((d, i) => (
            <DoorMark key={`d${i}`} door={d} idx={i} direction={doorDirection(floor, d)}
              editable={doorMode || (movable && !drawing && !!onDoorSelect)}
              selected={selectedDoor === i} labels={vis.labels} size={labelSize(0.32, 10.5, 9)} quiet={quietMap} halo={quietMap ? fs(3) : undefined}
              onDown={(e) => {
                if (e.button !== 0 || dragRef.current) return;
                onDoorMoveStart?.(i);
                beginDrag(e, { kind: "door", idx: i });
              }}
              onPick={() => onDoorSelect?.(i)} />
          ))}
          {/* Vorschau für neuen Zugang — rastet live auf der nächsten Wand ein. */}
          {doorMode && cursor && (() => {
            const snapped = snapDoorToWall(floor, cursor, doorKind);
            const ghostDoor: Door = { name: "", x: snapped.point[0], y: snapped.point[1], width: 2.0, kind: doorKind };
            return (
              <g opacity={0.65} pointerEvents="none">
                <DoorMark door={ghostDoor} idx={-1} direction={doorDirection(floor, ghostDoor)}
                  editable={false} selected labels={false} size={null} quiet={quietMap}
                  onDown={() => {}} onPick={() => {}} />
              </g>
            );
          })()}

          {/* Ausrichtungslinien beim Ziehen. */}
          {guides.vx.map((x, i) => (
            <line key={`gv${i}`} x1={x} y1={view.y} x2={x} y2={view.y + view.h}
              stroke="var(--g-floor-warn)" strokeWidth={1} strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke" pointerEvents="none" />
          ))}
          {guides.hy.map((y, i) => (
            <line key={`gh${i}`} x1={view.x} y1={y} x2={view.x + view.w} y2={y}
              stroke="var(--g-floor-warn)" strokeWidth={1} strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke" pointerEvents="none" />
          ))}

          {/* Gang-Ziel: die Maschine, mit der der nächste Klick den Gang
              verbindet. Sichtbare Kopplung statt Raten. */}
          {aisleTarget && (
            <g pointerEvents="none">
              <rect x={-aisleTarget.w / 2} y={-aisleTarget.h / 2}
                width={aisleTarget.w} height={aisleTarget.h}
                transform={`translate(${aisleTarget.x} ${aisleTarget.y}) rotate(${aisleTarget.rotation})`}
                fill="none" stroke="var(--g-floor-warn)" strokeWidth={2.5} strokeDasharray="5 3"
                vectorEffect="non-scaling-stroke" rx={0.16} />
              <circle cx={aisleTarget.x} cy={aisleTarget.y} r={fs(5)}
                fill="var(--g-floor-warn)" stroke="var(--g-surface)" strokeWidth={fs(1.5)} />
            </g>
          )}

          {/* Rechteck-Vorschau. */}
          {rectMode && rectStart && cursor && (
            <g pointerEvents="none">
              <rect
                x={Math.min(rectStart[0], cursor[0])} y={Math.min(rectStart[1], cursor[1])}
                width={Math.abs(cursor[0] - rectStart[0])} height={Math.abs(cursor[1] - rectStart[1])}
                fill="rgb(var(--g-info-rgb) / 0.08)" stroke={draftColour} strokeWidth={1.5} strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke" />
              <text className="floor-measure" textAnchor="middle"
                x={(rectStart[0] + cursor[0]) / 2}
                y={Math.min(rectStart[1], cursor[1]) - 0.25}
                fontSize={fs(12)} style={{ strokeWidth: fs(2.2) }}>
                {`${fmtNum(Math.abs(cursor[0] - rectStart[0]))} × ${fmtNum(Math.abs(cursor[1] - rectStart[1]))} m`
                 + ` = ${fmtNum(Math.abs(cursor[0] - rectStart[0]) * Math.abs(cursor[1] - rectStart[1]))} m²`}
              </text>
            </g>
          )}

          {/* Polygon-Entwurf:
              - Solange !draftClosed (offenes Zeichnen): OFFENER Linienzug (openOutlinePath) ohne Schlusslinie
                vom letzten zum ersten Punkt und ohne Body-PointerEvents, damit Klicks für Einbuchtungen
                ins Innere niemals blockiert werden!
              - Sobald draftClosed: Geschlossenes Polygon mit Wand-Schieben, [⊔]-Einbuchtungs-Griffen,
                (+)-Wandteilern und Eckgriffen. */}
          {polygonMode && draft && draft.length > 0 && (() => {
            const hitHalf = Math.max(0.18, fs(13));
            const visHalf = Math.max(0.11, fs(5.5));
            const midR = Math.max(0.09, fs(4.8));
            // Nur geschlossene Zonen/Hindernisse lassen sich über die Innenfläche verschieben —
            // beim Hallenumriss oder während des offenen Zeichnens (!draftClosed) bleibt das Innere frei für Klicks!
            const canDragBody = draftClosed && draft.length >= 3 && !!onDraftReplace && layer !== "outline" && !indentMode;
            const alignLines = !draftClosed && cursor
              ? draft.filter((pt) => Math.abs(pt[0] - cursor[0]) < 1e-6 || Math.abs(pt[1] - cursor[1]) < 1e-6)
              : [];
            return (
            <>
              {draftClosed ? (
                <path d={outlinePath(draft)} fill={draftColour} fillOpacity={0.14} stroke={draftColour}
                  strokeWidth={2.2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  className={canDragBody ? "floor-draft-body" : undefined}
                  pointerEvents={canDragBody ? "all" : "none"}
                  style={canDragBody ? { cursor: "move" } : undefined}
                  onPointerDown={canDragBody ? (e) => {
                    if (e.button !== 0 || dragRef.current || spaceDownRef.current) return;
                    const [mx, my] = toMeter(e.clientX, e.clientY);
                    beginDrag(e, { kind: "draft-body", start: [mx, my], base: draft.map((q) => [q[0], q[1]] as [number, number]) });
                  } : undefined}
                  onClick={canDragBody ? (e) => { e.stopPropagation(); } : undefined} />
              ) : (
                <>
                  {/* Vorschau-Füllung nur zeigen, wenn der Zeiger magnetisch auf dem Startpunkt (1) zum Schließen einrastet */}
                  {magnet && draft.length >= 3 && (
                    <path d={outlinePath(draft)} fill="var(--g-floor-snap)" fillOpacity={0.12} stroke="none" pointerEvents="none" />
                  )}
                  <path d={openOutlinePath(draft)} fill="none" stroke={draftColour}
                    strokeWidth={2.5} vectorEffect="non-scaling-stroke"
                    strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
                </>
              )}
              {/* Flucht-Hilfslinien beim offenen Zeichnen */}
              {!draftClosed && cursor && alignLines.map((pt, idx) => (
                <line key={`al-${idx}`} x1={pt[0]} y1={pt[1]} x2={cursor[0]} y2={cursor[1]}
                  stroke="#38bdf8" strokeWidth={1.2} strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke" pointerEvents="none" />
              ))}
              {/* Kantenmaße — beim offenen Zeichnen (!draftClosed) NIEMALS eine Kante vom letzten zum ersten Punkt bemaßen! */}
              {vis.labels && draft.map((p, i) => {
                if (!draftClosed && i === draft.length - 1) return null;
                const q = draft[(i + 1) % draft.length];
                const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
                if (len < 0.2) return null;
                return (
                  <text key={`m${i}`} className="floor-measure" textAnchor="middle"
                    x={(p[0] + q[0]) / 2} y={(p[1] + q[1]) / 2 - fs(8)}
                    fontSize={fs(11.5)} style={{ strokeWidth: fs(2.4) }}
                    pointerEvents="none">{fmtNum(len)} m</text>
                );
              })}
              {/* Wandkanten:
                  - Im Einbuchtungs-Modus (oder mit Umschalt+Ziehen) stanzt Ziehen/Klicken auf jede Wand eine 90°-Einbuchtung.
                  - Normal zieht man eine geschlossene Wandkante parallel (Orthogonal-Wandverschiebung),
                  - [⊔]-Griff stanzt eine 90°-Einbuchtung, (+)-Griff teilt die Wand mit einer neuen Ecke. */}
              {(onDraftInsert || onDraftReplace) && draft.length >= 2 && draft.map((p, i) => {
                if (!draftClosed && i === draft.length - 1) return null;
                const q = draft[(i + 1) % draft.length];
                const vx = q[0] - p[0];
                const vy = q[1] - p[1];
                const len = Math.hypot(vx, vy);
                if (len < 0.1) return null;
                const tx = vx / len;
                const ty = vy / len;
                const mx = (p[0] + q[0]) / 2;
                const my = (p[1] + q[1]) / 2;
                const offset = Math.min(len * 0.18, Math.max(0.45, fs(15)));
                const plusX = mx - tx * offset;
                const plusY = my - ty * offset;
                const indentX = mx + tx * offset;
                const indentY = my + ty * offset;
                return (
                  <g key={`edge-${i}`}>
                    <line
                      className="floor-draft-hit"
                      x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]}
                      stroke="transparent" strokeWidth={14} vectorEffect="non-scaling-stroke"
                      style={{ cursor: indentMode ? "crosshair" : draftClosed ? "grab" : "copy" }}
                      onPointerDown={(e) => {
                        if (!draftClosed || !onDraftReplace || e.button !== 0 || dragRef.current || spaceDownRef.current) return;
                        e.stopPropagation();
                        const base = draft.map((pt) => [pt[0], pt[1]] as [number, number]);
                        if (indentMode || e.shiftKey) {
                          const [cx, cy] = toMeter(e.clientX, e.clientY);
                          const carved = carveWallIndentation(base, i, [cx, cy], snapM);
                          if (carved) onDraftReplace(carved.points);
                          beginDrag(e, { kind: "draft-indent", edgeIdx: i, base });
                        } else {
                          beginDrag(e, { kind: "draft-edge", edgeIdx: i, base });
                        }
                      }}
                      onClick={(e) => { e.stopPropagation(); }}
                      onDoubleClick={(e) => {
                        if (!onDraftInsert) return;
                        e.stopPropagation();
                        const [cx, cy] = toMeter(e.clientX, e.clientY);
                        onDraftInsert(i, [snap(cx), snap(cy)]);
                      }} />
                    {draftClosed && len >= 1.5 && onDraftInsert && (
                      <g className="floor-draft-hit"
                         style={{ cursor: "copy" }}
                         onPointerDown={(e) => {
                           if (e.button !== 0 || dragRef.current) return;
                           e.stopPropagation();
                           const pt: [number, number] = [snap(plusX), snap(plusY)];
                           onDraftInsert(i, pt);
                           beginDrag(e, { kind: "draft", idx: i + 1 });
                           onDraftMoveStart?.(i + 1);
                         }}
                         onClick={(e) => { e.stopPropagation(); }}>
                        <title>Ecke auf dieser Wand einfügen &amp; ziehen (+)</title>
                        <circle cx={plusX} cy={plusY} r={hitHalf * 0.72} fill="transparent" />
                        <circle cx={plusX} cy={plusY} r={midR} fill="var(--g-surface)" stroke={draftColour} strokeWidth={midR * 0.32} pointerEvents="none" />
                        <line x1={plusX - midR * 0.5} y1={plusY} x2={plusX + midR * 0.5} y2={plusY} stroke={draftColour} strokeWidth={midR * 0.28} pointerEvents="none" />
                        <line x1={plusX} y1={plusY - midR * 0.5} x2={plusX} y2={plusY + midR * 0.5} stroke={draftColour} strokeWidth={midR * 0.28} pointerEvents="none" />
                      </g>
                    )}
                    {draftClosed && len >= 2.0 && onDraftReplace && (
                      <g className="floor-draft-hit"
                         style={{ cursor: "pointer" }}
                         onPointerDown={(e) => {
                           if (e.button !== 0 || dragRef.current) return;
                           e.stopPropagation();
                           const base = draft.map((pt) => [pt[0], pt[1]] as [number, number]);
                           const [cx, cy] = toMeter(e.clientX, e.clientY);
                           const carved = carveWallIndentation(base, i, [cx, cy], snapM);
                           if (carved) onDraftReplace(carved.points);
                           beginDrag(e, { kind: "draft-indent", edgeIdx: i, base });
                         }}
                         onClick={(e) => { e.stopPropagation(); }}>
                        <title>90°-Einbuchtung / Ausbuchtung in diese Wand ziehen (⊔)</title>
                        <circle cx={indentX} cy={indentY} r={hitHalf * 0.78} fill="transparent" />
                        <rect x={indentX - midR * 1.05} y={indentY - midR * 1.05} width={midR * 2.1} height={midR * 2.1} rx={midR * 0.35}
                          fill={indentMode ? "#f59e0b" : "var(--g-surface)"} stroke="#f59e0b" strokeWidth={midR * 0.34} pointerEvents="none" />
                        <path
                          d={`M ${indentX - midR * 0.55} ${indentY - midR * 0.45} L ${indentX - midR * 0.55} ${indentY + midR * 0.45} L ${indentX + midR * 0.55} ${indentY + midR * 0.45} L ${indentX + midR * 0.55} ${indentY - midR * 0.45}`}
                          fill="none"
                          stroke={indentMode ? "#0f1216" : "#f59e0b"}
                          strokeWidth={midR * 0.3}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          pointerEvents="none"
                        />
                      </g>
                    )}
                  </g>
                );
              })}
              {!draftClosed && cursor && lastDraft && (
                <g pointerEvents="none">
                  <line x1={lastDraft[0]} y1={lastDraft[1]} x2={cursor[0]} y2={cursor[1]}
                    stroke={magnet ? "var(--g-floor-snap)" : draftColour} strokeWidth={2.2} strokeDasharray="5 3"
                    vectorEffect="non-scaling-stroke" />
                  <text className="floor-measure" textAnchor="middle"
                    x={(lastDraft[0] + cursor[0]) / 2} y={(lastDraft[1] + cursor[1]) / 2 - fs(10)}
                    fontSize={fs(12)} style={{ strokeWidth: fs(2.5) }}>
                    {magnet ? "● Klick auf Startpunkt (1) schließt Umriss"
                      : `${fmtNum(Math.hypot(cursor[0] - lastDraft[0], cursor[1] - lastDraft[1]))} m · `
                        + `${Math.round(((Math.atan2(cursor[1] - lastDraft[1], cursor[0] - lastDraft[0]) * 180) / Math.PI + 360) % 360)}°`}
                  </text>
                </g>
              )}
              {!draftClosed && magnet && (
                <circle cx={draft[0][0]} cy={draft[0][1]} r={fs(14)} fill="none"
                  stroke="var(--g-floor-snap)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
              )}
              {draft.length >= 3 && vis.labels && (() => {
                const c = polygonCentroid(draft);
                return (
                  <text className="floor-area" x={c[0]} y={c[1]} textAnchor="middle"
                        fontSize={editorLook ? fs(13.5) : 0.5} pointerEvents="none">
                    {fmtNum(polygonArea(draft))} m²
                  </text>
                );
              })()}
              {draft.map((p, i) => (
                <g key={i}>
                  <rect className="floor-draft-hit"
                    x={p[0] - hitHalf} y={p[1] - hitHalf} width={hitHalf * 2} height={hitHalf * 2} fill="transparent"
                    style={{ cursor: "move" }}
                    onPointerDown={(e) => {
                      if (e.button !== 0 || dragRef.current) return;
                      // Bei Klick auf den Startpunkt während des offenen Zeichnens: Polygon schließen!
                      if (!draftClosed && i === 0 && draft.length >= 3) {
                        e.stopPropagation();
                        onDraftFinish?.();
                        return;
                      }
                      const [mx, my] = toMeter(e.clientX, e.clientY);
                      let bestIdx = i;
                      let bestD2 = (draft[i][0] - mx) ** 2 + (draft[i][1] - my) ** 2;
                      for (let k = 0; k < draft.length; k++) {
                        const d2 = (draft[k][0] - mx) ** 2 + (draft[k][1] - my) ** 2;
                        if (d2 < bestD2) { bestD2 = d2; bestIdx = k; }
                      }
                      beginDrag(e, { kind: "draft", idx: bestIdx });
                      onDraftMoveStart?.(bestIdx);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!draftClosed && i === 0 && draft.length >= 3) {
                        onDraftFinish?.();
                        return;
                      }
                      if (e.altKey) onDraftDelete?.(i);
                    }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onDraftDelete?.(i); }} />
                  <rect x={p[0] - visHalf} y={p[1] - visHalf} width={visHalf * 2} height={visHalf * 2}
                    rx={visHalf * 0.25}
                    fill={i === 0 ? "var(--g-floor-snap)" : draftColour} stroke="var(--g-surface)" strokeWidth={visHalf * 0.32}
                    pointerEvents="none" />
                </g>
              ))}
            </>
            );
          })()}

          {/* Gang-Gummiband. */}
          {aisleMode && anchorNode && cursor && (
            <g pointerEvents="none">
              <line x1={anchorNode[0]} y1={anchorNode[1]} x2={cursor[0]} y2={cursor[1]}
                stroke="var(--g-floor-warn)" strokeWidth={2} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
              <text className="floor-measure" textAnchor="middle"
                x={(anchorNode[0] + cursor[0]) / 2} y={(anchorNode[1] + cursor[1]) / 2 - 0.25}
                fontSize={fs(12)} style={{ strokeWidth: fs(2.2) }}>
                {fmtNum(Math.hypot(cursor[0] - anchorNode[0], cursor[1] - anchorNode[1]))} m
              </text>
            </g>
          )}

          {/* Messband. */}
          {measureMode && measure && (
            <MeasureLine a={measure.a} b={measure.b ?? cursor ?? measure.a} fs={fs} />
          )}

          {/* Geister-Station: Vorschau des Formulars im Editor. */}
          {ghost && (
            <g transform={`translate(${ghost.x} ${ghost.y}) rotate(${ghost.rotation})`} className="floor-ghost">
              <rect x={-ghost.w / 2} y={-ghost.h / 2} width={ghost.w} height={ghost.h} rx={0.15}
                fill={editorLook ? "var(--g-floor-station)" : stationColour(ghost)} opacity={0.35} stroke="var(--g-floor-error)" strokeWidth={1.5}
                strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
              <text x={-ghost.w / 2 + (editorLook ? fs(4) : 0.15)} y={-ghost.h / 2 + (editorLook ? fs(14) : 0.5)} fontSize={editorLook ? fs(12) : 0.4} fill="var(--g-floor-error)">
                {ghost.label} (Vorschau)
              </text>
            </g>
          )}

          {/* Stationen. */}
          {shown.map((s) => {
            const mark = s.id != null ? status?.[s.id] : undefined;
            if (mark) {
              const line = mark.lineSpoken !== mark.spoken ? `, ${mark.lineSpoken}` : "";
              return (
                <g key={s.id} transform={`translate(${s.x} ${s.y}) rotate(${s.rotation})`}
                   className={"floor-station twin-station twin-" + mark.kind + (s.id === selectedId ? " floor-station-sel" : "")}
                   data-status={mark.kind} data-certainty={mark.certainty}
                   role="button" tabIndex={0} aria-label={`${s.label}, ${mark.spoken}${line}`}
                   aria-pressed={s.id === selectedId}
                   onKeyDown={(e) => {
                     if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onStationClick?.(s); }
                   }}
                   onClick={(e) => { e.stopPropagation(); onStationClick?.(s); }}>
                  <title>{s.label}: {mark.word}</title>
                  <StationShape s={s} mark={mark} fs={fs} ppm={ppm} selected={s.id === selectedId}
                    labels={vis.labels} highlighted={s.id != null && !!highlightIds?.includes(s.id)} />
                </g>
              );
            }
            const load = (loads && s.id != null && loads[s.id]) || 0;
            // Wärme und Leiste messen an der Tageskapazität. Ohne Minuten (Stückzahl,
            // Editor) oder ohne Kapazität bleibt die Station neutral.
            const info = loads && loadUnit === "min" && s.id != null
              ? loadInfo({ queueMin: load, capacityMin: s.capacity_min_per_day || 0, tasks: s.queue_jobs ?? 0 })
              : null;
            const colour = editorLook ? "var(--g-floor-station)"
              : heatColour(stationColour(s), info?.ratio != null ? heatFromRatio(info.ratio) : 0);
            const loadText = info ? `, ${info.text}` : "";
            // Offene Arbeit ohne Dauer ist nicht dasselbe wie eine freie Station.
            const unknownLoad = info?.level === "unknown" && load === 0;
            const selected = s.id != null && s.id === selectedId;
            const isOut = s.id != null && warn.out.has(s.id);
            const isBlock = s.id != null && !isOut && warn.block.has(s.id);
            const isOver = s.id != null && !isOut && !isBlock && warn.over.has(s.id);
            const glyph = Math.min(s.w, s.h) > 1.2;
            const stroke = isOut ? "var(--g-floor-error)" : isBlock ? "var(--g-floor-warn)" : isOver ? "var(--g-warning)"
              : selected ? "var(--g-text-strong)" : editorLook ? "var(--g-floor-station-line)" : "var(--g-floor-edge)";
            const strokeW = isOut || isOver || isBlock || selected ? 0.07 : 0.03;
            const showHandles = selected && movable && !drawing && s.id != null;
            const warnTitle = isOut ? " — außerhalb der Halle!"
              : isBlock ? " — steht auf einem Hindernis"
              : isOver ? " — überlappt eine andere Station" : "";
            const badge = unknownLoad ? "?" : loadUnit === "min"
              ? (load >= 60 ? `${Math.round(load / 60)}h` : `${Math.round(load)}min`)
              : String(load);
            return (
              <g key={s.id ?? s.label}
                 transform={`translate(${s.x} ${s.y}) rotate(${s.rotation})`}
                 className={"floor-station" + (editorLook ? " floor-station-neutral" : "") + (selected ? " floor-station-sel" : "") + (s.active ? "" : " floor-station-off")}
                 {...(onStationClick && !drawing ? {
                   role: "button", tabIndex: 0, "aria-label": `${s.label}${warnTitle}${loadText}`,
                   onKeyDown: (e: React.KeyboardEvent) => {
                     if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onStationClick(s); }
                   },
                 } : {})}
                 onPointerDown={(e) => {
                   if (drawing || !movable || s.id == null) return;
                   const [mx, my] = toMeter(e.clientX, e.clientY);
                   beginDrag(e, { kind: "move", id: s.id, offx: s.x - mx, offy: s.y - my, base: s });
                 }}
                 onClick={(e) => { if (!drawing && onStationClick) { e.stopPropagation(); onStationClick(s); } }}>
                <title>{s.label}{warnTitle}{loadText}</title>
                <rect x={-s.w / 2} y={-s.h / 2} width={s.w} height={s.h} rx={0.16}
                  fill={colour} stroke={stroke} strokeWidth={strokeW}
                  vectorEffect="non-scaling-stroke" />
                {/* Lager: Umrandung, die man auf zwei Meter Abstand erkennt —
                    von hier wird jede Entfernung gemessen. */}
                {s.is_storage && (
                  <rect x={-s.w / 2 + 0.12} y={-s.h / 2 + 0.12} width={s.w - 0.24} height={s.h - 0.24}
                    rx={0.1} fill="none" stroke="var(--g-on-data-soft)" strokeWidth={0.05}
                    strokeDasharray="0.35 0.25" />
                )}
                {editorLook && <EditorStationText s={s} fs={fs} ppm={ppm} />}
                {!editorLook && glyph && (
                  <g transform={`translate(${-s.w / 2 + 0.5} ${-s.h / 2 + 0.5})`}>
                    <circle r={0.34} fill="var(--g-on-data-faint)" />
                    <TypeGlyph type={s.type} />
                  </g>
                )}
                {!editorLook && (
                  <text className="floor-station-label"
                    x={glyph ? -s.w / 2 + 1.0 : 0} y={-s.h / 2 + 0.62}
                    fontSize={0.42} textAnchor={glyph ? "start" : "middle"}>
                    {s.label}
                  </text>
                )}
                {!editorLook && glyph && (
                  <text className="floor-station-sub" x={-s.w / 2 + 1.0} y={-s.h / 2 + 1.06} fontSize={0.3}>
                    {TYPE_LABEL[s.type]}{s.subtype ? ` · ${s.subtype}` : ""}
                  </text>
                )}
                {/* Auslastung als Leiste am Blockfuß. */}
                {glyph && info && (
                  <rect className="floor-station-load" x={-s.w / 2 + 0.12} y={s.h / 2 - 0.24}
                    width={(s.w - 0.24) * barWidth(info, load, maxUnknownLoad)}
                    height={0.13} rx={0.06} fill="var(--g-on-data-soft)" />
                )}
                {/* Rüstzustand, abgeleitet aus der letzten Zuordnung: eine Vermutung,
                    keine Meldung von der Maschine. */}
                {!editorLook && glyph && s.last_mat && s.h > 1.8 && (
                  <text className="floor-station-sub" x={-s.w / 2 + 0.2} y={s.h / 2 - 0.42} fontSize={0.27}>
                    zuletzt eingeplant: {s.last_mat}{s.last_thk ? ` ${fmtNum(s.last_thk)} mm` : ""}
                  </text>
                )}
                {s.id != null && loads && (
                  <g className={unknownLoad ? "floor-station-badge-unknown" : undefined}
                     transform={`translate(${s.w / 2 - 0.42} ${-s.h / 2 + 0.42})`}>
                    <circle r={0.4} fill={load > 0 || unknownLoad ? "var(--g-floor-badge)" : "var(--g-on-data-strong)"}
                      stroke="var(--g-on-data-strong)" strokeWidth={0.04}
                      strokeDasharray={unknownLoad ? "0.14 0.1" : undefined} />
                    <text y={0.15} textAnchor="middle" fontSize={badge.length > 4 ? 0.24 : badge.length > 2 ? 0.3 : 0.42}
                      fontWeight={600} fill={load > 0 || unknownLoad ? "var(--g-on-data)" : "var(--g-floor-on-chip)"}>{badge}</text>
                  </g>
                )}
                {!editorLook && !s.active && (
                  <text x={0} y={s.h / 2 - 0.45} textAnchor="middle" fontSize={0.32}
                    fill="var(--g-on-data-soft)">inaktiv</text>
                )}

                {/* Griffe: vier Ecken zum Skalieren, Kreis oben zum Drehen. */}
                {showHandles && CORNER_SIGNS.map(([sx, sy], i) => (
                  <g key={i}>
                    <rect className="floor-handle-hit"
                      x={sx * s.w / 2 - 0.35} y={sy * s.h / 2 - 0.35} width={0.7} height={0.7} fill="transparent"
                      style={{ cursor: CORNER_CURSOR[i] }}
                      onPointerDown={(e) => s.id != null && beginDrag(e, { kind: "resize", id: s.id, corner: i, base: s })} />
                    <rect className="floor-handle"
                      x={sx * s.w / 2 - 0.14} y={sy * s.h / 2 - 0.14} width={0.28} height={0.28}
                      style={{ pointerEvents: "none" }} />
                  </g>
                ))}
                {showHandles && (
                  <g>
                    <line className="floor-rotstem" x1={0} y1={-s.h / 2} x2={0} y2={-s.h / 2 - 0.7} />
                    <circle className="floor-handle-hit" cx={0} cy={-s.h / 2 - 0.95} r={0.5} fill="transparent"
                      style={{ cursor: "grab" }}
                      onPointerDown={(e) => s.id != null && beginDrag(e, { kind: "rotate", id: s.id, base: s })} />
                    <circle className="floor-handle" cx={0} cy={-s.h / 2 - 0.95} r={0.26} style={{ pointerEvents: "none" }} />
                  </g>
                )}
              </g>
            );
          })}

          {/* Zieh-Hinweis: Position, Maß oder Winkel live an der Station.
              Schrift und Kontur in Bildschirmgröße — der Hinweis ist ein
              Overlay, kein Gegenstand auf der Halle. */}
          {tip && (
            <g transform={`translate(${tip.x} ${tip.y})`} className="floor-dragtip" pointerEvents="none">
              <text textAnchor="middle" fontSize={fs(12)} style={{ strokeWidth: fs(2.5) }}>{tip.text}</text>
            </g>
          )}
        </svg>
        {mapTiles.length > 0 && (<>
          <MapStyleSwitch value={mapStyle} onChange={setMapStyle} className="three-map-style" />
          <span className="three-map-attribution">{mapAttribution(mapStyle)}</span>
          {tileFails > 0 && tileFails >= mapTiles.length / 2 && (
            <span className="map-fail" role="status">Karte nicht erreichbar — Netz oder Anbieter.</span>
          )}
        </>)}
        {north != null && (
          // Plan-y zählt nach Süden; bei 0° zeigt Norden nach oben, die Drehung der Halle dreht ihn mit.
          <span className="plan-north" title={`Norden · Halle um ${north.toFixed(1)}° gedreht`} aria-label="Norden">
            <svg viewBox="-12 -12 24 24" style={{ transform: `rotate(${north}deg)` }} aria-hidden="true">
              <path d="M0,-10 L5,6 L0,3 L-5,6 Z" />
            </svg>
            <b>N</b>
          </span>
        )}
      </div>
      {movable && (warn.out.size > 0 || warn.over.size > 0 || warn.block.size > 0) && (
        <div className="floor-warnline">
          {warn.out.size > 0 && <span><b style={{ color: "var(--g-floor-error)" }}>{warn.out.size}</b> außerhalb der Halle</span>}
          {warn.block.size > 0 && <span><b style={{ color: "var(--g-floor-warn)" }}>{warn.block.size}</b> auf einem Hindernis</span>}
          {warn.over.size > 0 && <span><b style={{ color: "var(--g-warning-ink)" }}>{warn.over.size}</b> überlappen sich</span>}
        </div>
      )}

      {menu && createPortal(
        <div className="floor-context-layer">
          <div className="floor-context-menu" ref={menuRef} role="menu"
            style={{ left: menu.x, top: menu.y }} aria-label="Gang-Menü">
            {menu.kind === "edge" && (
              <>
                <div className="floor-context-head">Gangkante</div>
                {onAisleEdgeSplit && (
                  <button type="button" role="menuitem"
                    onClick={() => { onAisleEdgeSplit(menu.idx, menu.at); setMenu(null); }}>
                    <Icon icon="new-link" size={13} aria-hidden /> Kante hier teilen
                  </button>
                )}
                {onAisleEdgeDelete && (
                  <button type="button" role="menuitem" className="floor-context-danger"
                    onClick={() => { onAisleEdgeDelete(menu.idx); setMenu(null); }}>
                    <Icon icon="trash" size={13} aria-hidden /> Gang löschen
                  </button>
                )}
              </>
            )}
            {menu.kind === "node" && (
              <>
                <div className="floor-context-head">Gangknoten</div>
                {onAisleNodeDelete && (
                  <button type="button" role="menuitem" className="floor-context-danger"
                    onClick={() => { onAisleNodeDelete(menu.idx); setMenu(null); }}>
                    <Icon icon="trash" size={13} aria-hidden /> Knoten und Kanten löschen
                  </button>
                )}
              </>
            )}
            {menu.kind === "canvas" && (
              <>
                <div className="floor-context-head">Gangnetz</div>
                {onCleanAisles && (
                  <button type="button" role="menuitem"
                    onClick={() => { onCleanAisles(); setMenu(null); }}>
                    <Icon icon="clean" size={13} aria-hidden /> Netz aufräumen
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => { resetZoom(); setMenu(null); }}>
                  <Icon icon="zoom-to-fit" size={13} aria-hidden /> Auf den Plan einpassen
                </button>
              </>
            )}
            <button type="button" role="menuitem" className="floor-context-cancel"
              onClick={() => setMenu(null)}>Schließen</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** Beschriftung einer Station im Editor: gerade stehend und in Bildschirmpixeln. Passt sie nicht
    in den Block, hängt der Name darunter auf dem Hallenboden. Wie `StationShape` im Leitstand. */
function EditorStationText({ s, fs, ppm }: { s: Station; fs: (px: number) => number; ppm: number }) {
  const turn = rad(s.rotation);
  const halfW = Math.abs((s.w / 2) * Math.cos(turn)) + Math.abs((s.h / 2) * Math.sin(turn));
  const halfH = Math.abs((s.w / 2) * Math.sin(turn)) + Math.abs((s.h / 2) * Math.cos(turn));
  const sub = `${TYPE_LABEL[s.type]}${s.subtype ? ` · ${s.subtype}` : ""}`;
  const extra = s.active ? (s.last_mat ? `zuletzt eingeplant: ${s.last_mat}${s.last_thk ? ` ${fmtNum(s.last_thk)} mm` : ""}` : "") : "inaktiv";
  const glyphPx = 18;
  const left = 6 + glyphPx + 5;
  const widthPx = halfW * 2 * ppm;
  const heightPx = halfH * 2 * ppm;
  const inside = widthPx >= s.label.length * 6.8 + left + 6 && heightPx >= 26;
  const showSub = inside && heightPx >= 40 && widthPx >= sub.length * 5.8 + left + 6;
  const showExtra = inside && extra !== "" && heightPx >= 56 && widthPx >= extra.length * 5.4 + 12;
  const cls = inside ? "twin-text-on" : "twin-text-off";
  const x = inside ? -halfW + fs(left) : 0;
  const y = inside ? -halfH + fs(17) : halfH + fs(14);
  const halo = { strokeWidth: fs(3) };
  return (
    <g transform={`rotate(${-s.rotation})`} pointerEvents="none">
      {inside && (
        <g transform={`translate(${-halfW + fs(6 + glyphPx / 2)} ${-halfH + fs(13)}) scale(${fs(glyphPx)})`}>
          <TypeGlyph type={s.type} />
        </g>
      )}
      <text className={`floor-station-label twin-name ${cls}`} x={x} y={y} fontSize={fs(12)}
        textAnchor={inside ? "start" : "middle"} style={halo}>{s.label}</text>
      {showSub && <text className={`floor-station-sub ${cls}`} x={x} y={y + fs(14)} fontSize={fs(11)} style={halo}>{sub}</text>}
      {showExtra && <text className={`floor-station-sub ${cls}`} x={-halfW + fs(6)} y={halfH - fs(6)} fontSize={fs(10.5)} style={halo}>{extra}</text>}
    </g>
  );
}

function ZoneShape({ zone, labels, nameSize, subSize, quiet, halo, onPick }: {
  zone: Zone; labels: boolean; nameSize: number | null; subSize: number | null; quiet: boolean; halo?: number;
  onPick?: () => void;
}) {
  if ((zone.points?.length ?? 0) < 3) return null;
  const centre = polygonCentroid(zone.points);
  // Im Leitstand steht der Name am oberen Zonenrand: in der Mitte läge er auf den Stationen.
  const c: [number, number] = quiet && nameSize != null
    ? [centre[0], Math.min(...zone.points.map((p) => p[1])) + nameSize * 1.5] : centre;
  const colour = zone.colour || "var(--g-flow-supply)";
  return (
    <g className={"floor-zone" + (onPick ? " floor-pickable" : "")}
      pointerEvents={onPick ? "auto" : "none"}
      style={onPick ? { cursor: "pointer" } : undefined}
      onClick={onPick ? (e) => { e.stopPropagation(); onPick(); } : undefined}>
      {onPick && <title>{zone.name || "Zone"} — Klick zum Bearbeiten</title>}
      <path d={outlinePath(zone.points)} fill={colour} fillOpacity={0.1}
        stroke={colour} strokeOpacity={0.55} strokeWidth={1.2}
        strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />
      {labels && nameSize != null && (
        <text className={"floor-zone-label" + (quiet ? " twin-map-text" : "")} x={c[0]} y={c[1]} textAnchor="middle" fontSize={nameSize}
          fill={quiet ? undefined : colour} style={halo ? { strokeWidth: halo } : undefined} pointerEvents="none">{zone.name || "Zone"}</text>
      )}
      {labels && nameSize != null && subSize != null && (
        <text className={"floor-zone-sub" + (quiet ? " twin-map-text" : "")} x={c[0]} y={c[1] + (quiet ? nameSize * 1.25 : 0.5)} textAnchor="middle" fontSize={subSize}
          fill={quiet ? undefined : colour} style={halo ? { strokeWidth: halo } : undefined} pointerEvents="none">
          {polygonArea(zone.points).toLocaleString("de-DE", { maximumFractionDigits: 0 })} m²
        </text>
      )}
    </g>
  );
}

function ObstacleShape({ obstacle, labels, size, onPick }: {
  obstacle: Obstacle; labels: boolean; size: number | null; onPick?: () => void;
}) {
  if ((obstacle.points?.length ?? 0) < 3) return null;
  const c = polygonCentroid(obstacle.points);
  const kind = obstacleKind(obstacle);
  const isHole = kind === "bore" || kind === "cutout";
  const circleInfo = kind === "bore" ? circleDimensions(obstacle.points) : null;
  const fill =
    isHole ? "var(--g-floor-outside)"
    : kind === "wall" || kind === "column" || kind === "round_column" ? "var(--g-text-2)"
    : kind === "room" ? "var(--g-surface-2)"
    : kind === "partition" ? "var(--g-muted)"
    : kind === "rack_block" ? "var(--g-floor-aisle-lane)"
    : kind === "fence" ? "none"
    : "url(#floor-hatch)";
  const fillOpacity =
    isHole ? 0.92
    : kind === "wall" || kind === "column" || kind === "round_column" ? 0.72
    : kind === "room" ? 0.78
    : kind === "partition" ? 0.52
    : kind === "rack_block" ? 0.7
    : 1;
  const stroke =
    isHole ? "var(--gimel-accent)"
    : kind === "fence" ? "var(--g-floor-warn)"
    : kind === "room" ? "var(--g-text-strong)"
    : kind === "wall" || kind === "column" || kind === "round_column" ? "var(--g-text-strong)"
    : "var(--g-muted)";
  const strokeWidth = isHole ? 2.2 : kind === "wall" || kind === "room" ? 2 : 1.4;
  const chR = circleInfo ? Math.max(0.2, circleInfo.diameter * 0.25) : 0.35;
  const labelText = circleInfo
    ? `${obstacle.name || "Bohrung"} (Ø ${fmtNum(circleInfo.diameter)} m)`
    : obstacle.name;
  return (
    <g className={"floor-obstacle" + (onPick ? " floor-pickable" : "")} data-kind={kind}
      pointerEvents={onPick ? "auto" : "none"}
      style={onPick ? { cursor: "pointer" } : undefined}
      onClick={onPick ? (e) => { e.stopPropagation(); onPick(); } : undefined}>
      {onPick && <title>{labelText || "Hindernis"} — Klick zum Bearbeiten</title>}
      <path d={outlinePath(obstacle.points)} fill={fill} fillOpacity={fillOpacity}
        stroke={stroke} strokeWidth={strokeWidth}
        strokeDasharray={kind === "fence" ? "5 3" : isHole ? "6 3" : undefined}
        vectorEffect="non-scaling-stroke" />
      {isHole && (
        <g pointerEvents="none" opacity={0.65}>
          <line x1={c[0] - chR} y1={c[1]} x2={c[0] + chR} y2={c[1]}
            stroke="var(--gimel-accent)" strokeWidth={1.2} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
          <line x1={c[0]} y1={c[1] - chR} x2={c[0]} y2={c[1] + chR}
            stroke="var(--gimel-accent)" strokeWidth={1.2} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
        </g>
      )}
      {labels && labelText && size != null && (
        <text x={c[0]} y={c[1]} textAnchor="middle" dominantBaseline="central" fontSize={size}
          fill={isHole ? "var(--gimel-accent)" : kind === "room" ? "var(--g-text-strong)" : "var(--g-muted)"}
          className="twin-map-text" pointerEvents="none">
          {labelText}
        </text>
      )}
    </g>
  );
}

function DoorMark({ door, direction, editable, selected, labels, size, quiet, halo, onDown, onPick }: {
  door: Door; idx: number; direction: [number, number]; editable: boolean; selected: boolean; labels: boolean;
  size: number | null; quiet: boolean; halo?: number;
  onDown: (e: React.PointerEvent) => void; onPick: () => void;
}) {
  const w = door.width || 2.5;
  const [ux, uy] = direction;
  const ax = door.x - ux * w / 2, ay = door.y - uy * w / 2;
  const bx = door.x + ux * w / 2, by = door.y + uy * w / 2;
  const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
  const kind = effectiveDoorKind(door);
  const colour =
    kind === "gate" ? "var(--g-floor-warn)"
    : kind === "ramp" ? "var(--g-flow-supply)"
    : kind === "stair" ? "#0d9488"
    : kind === "lift" ? "#4f46e5"
    : kind === "emergency" ? "#16a34a"
    : kind === "window" ? "#0284c7"
    : "var(--g-flow-ship)";
  return (
    <g className="floor-door" data-kind={kind}>
      {kind === "stair" ? (
        <g transform={`translate(${door.x} ${door.y}) rotate(${angle})`}>
          <rect x={-w / 2} y={-0.38} width={w} height={0.76} rx={0.08}
            fill="var(--g-surface)" stroke={colour} strokeWidth={selected ? 2.5 : 1.5}
            vectorEffect="non-scaling-stroke" />
          {Array.from({ length: 5 }, (_, k) => {
            const x = -w / 2 + ((k + 1) / 6) * w;
            return (
              <line key={k} x1={x} y1={-0.36} x2={x} y2={0.36}
                stroke={colour} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
            );
          })}
        </g>
      ) : kind === "lift" ? (
        <g transform={`translate(${door.x} ${door.y}) rotate(${angle})`}>
          <rect x={-w / 2} y={-0.45} width={w} height={0.9} rx={0.1}
            fill="var(--g-surface)" stroke={colour} strokeWidth={selected ? 2.5 : 1.6}
            vectorEffect="non-scaling-stroke" />
          <line x1={-w / 2} y1={-0.45} x2={w / 2} y2={0.45}
            stroke={colour} strokeWidth={1.1} opacity={0.65} vectorEffect="non-scaling-stroke" />
          <line x1={w / 2} y1={-0.45} x2={-w / 2} y2={0.45}
            stroke={colour} strokeWidth={1.1} opacity={0.65} vectorEffect="non-scaling-stroke" />
        </g>
      ) : (
        <>
          <line x1={ax} y1={ay} x2={bx} y2={by}
            stroke={colour} strokeWidth={selected ? 6 : 4} strokeLinecap="round"
            vectorEffect="non-scaling-stroke" />
          <line x1={ax} y1={ay} x2={bx} y2={by}
            stroke={kind === "window" ? "#e0f2fe" : "var(--g-surface)"}
            strokeWidth={selected ? 2 : kind === "window" ? 1.8 : 1.2} strokeLinecap="round"
            vectorEffect="non-scaling-stroke" />
        </>
      )}
      {labels && door.name && size != null && (
        <text className={quiet ? "twin-map-text" : undefined} x={door.x} y={door.y - (quiet ? size : 0.55)} textAnchor="middle" fontSize={size}
          fill={quiet ? undefined : colour} style={halo ? { strokeWidth: halo } : undefined}>
          {door.name}
        </text>
      )}
      {editable && (
        <rect x={door.x - w / 2 - 0.25} y={door.y - 0.5} width={w + 0.5} height={1.0}
          transform={`rotate(${angle} ${door.x} ${door.y})`}
          fill="transparent" style={{ cursor: "move" }}
          onPointerDown={onDown}
          onClick={(e) => { e.stopPropagation(); onPick(); }} />
      )}
    </g>
  );
}

/** Punkt und Richtung einer quadratischen Kurve. */
function quadPoint(a: [number, number], m: [number, number], b: [number, number], t: number): [number, number] {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * m[0] + t * t * b[0], u * u * a[1] + 2 * u * t * m[1] + t * t * b[1]];
}

function quadAngle(a: [number, number], m: [number, number], b: [number, number], t: number): number {
  const dx = 2 * (1 - t) * (m[0] - a[0]) + 2 * t * (b[0] - m[0]);
  const dy = 2 * (1 - t) * (m[1] - a[1]) + 2 * t * (b[1] - m[1]);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Punkt und Richtung auf einem Linienzug, nach zurückgelegter Länge. */
function polylineSample(points: [number, number][], t: number): { at: [number, number]; angle: number } {
  if (points.length < 2) return { at: points[0] ?? [0, 0], angle: 0 };
  let total = 0;
  const lens: number[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const d = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    lens.push(d); total += d;
  }
  if (total <= 1e-9) return { at: points[0], angle: 0 };
  let target = Math.max(0, Math.min(1, t)) * total, run = 0;
  for (let i = 0; i < lens.length; i++) {
    if (run + lens[i] >= target || i === lens.length - 1) {
      const u = lens[i] > 0 ? (target - run) / lens[i] : 0;
      const a = points[i], b = points[i + 1];
      return { at: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u],
        angle: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
    }
    run += lens[i];
  }
  return { at: points[points.length - 1], angle: 0 };
}

/** Pfeil zwischen zwei Stationen — Dicke = wie oft, Beschriftung = wie weit.
    Die Richtung steht als Chevron am Weg und als Spitze am Ziel; das trägt
    auch dann, wenn die Station die Pfeilspitze halb verdeckt. */
function FlowArrow({ a, b, edge, maxCount, dim, size, quiet, halo, route }: {
  a: Station; b: Station; edge: FlowEdge; maxCount: number; dim: boolean;
  size: number | null; quiet: boolean; halo?: number; route?: [number, number][];
}) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // An den Rändern der Blöcke ansetzen, nicht in den Mittelpunkten — sonst
  // verschwindet der Pfeil unter der Station.
  const off = (s: Station) => Math.min(s.w, s.h) / 2 + 0.2;
  const ax = a.x + (dx / len) * off(a), ay = a.y + (dy / len) * off(a);
  const bx = b.x - (dx / len) * off(b), by = b.y - (dy / len) * off(b);
  // Leicht gebogen, damit Hin- und Rückweg sich nicht überdecken.
  const mx = (ax + bx) / 2 - dy / len * 0.9;
  const my = (ay + by) / 2 + dx / len * 0.9;
  const colour = edge.kind === "supply" ? "var(--g-flow-supply)" : "var(--g-flow-ship)";
  const width = 0.06 + 0.22 * (edge.count / maxCount);
  const label = `${edge.count}× · ${edge.metres.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m`
    + (!edge.exact ? " · Luftlinie" : "");
  const labelSize = size ?? 0;
  const labelW = Math.max(1.2, label.length * labelSize * 0.53 + labelSize * 0.7);
  const labelH = Math.max(0.72, labelSize * 1.55);
  const p = [ax, ay] as [number, number];
  const q = [bx, by] as [number, number];
  const control = [mx, my] as [number, number];
  const onFootpath = !!route && route.length > 2;
  const sample = (t: number) => onFootpath
    ? polylineSample(route!, t)
    : { at: quadPoint(p, control, q, t), angle: quadAngle(p, control, q, t) };
  const pathD = onFootpath
    ? route!.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ")
    : `M${ax} ${ay} Q${mx} ${my} ${bx} ${by}`;
  const labelAt = sample(0.5).at;
  const chevron = (t: number, strong = false) => {
    const s = sample(t);
    const sizePx = Math.max(0.18, labelSize * (strong ? 0.9 : 0.62));
    return (
      <path key={t} d={`M${-sizePx * 0.55} ${-sizePx} L${sizePx * 0.55} 0 L${-sizePx * 0.55} ${sizePx}`}
        transform={`translate(${s.at[0]} ${s.at[1]}) rotate(${s.angle})`}
        fill="none" stroke={colour} strokeWidth={strong ? 2.4 : 1.6}
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
        opacity={strong ? 0.95 : 0.75} />
    );
  };
  return (
    <g className="floor-flow" style={{ color: colour }} opacity={dim ? 0.18 : 0.82} pointerEvents="none">
      <path d={pathD} fill="none" stroke={colour}
        strokeWidth={width + 0.2} opacity={0.12} strokeLinecap="round" strokeLinejoin="round" />
      <path d={pathD} fill="none" stroke={colour}
        strokeWidth={width} markerEnd="url(#flow-arrow)" strokeLinecap="round" strokeLinejoin="round" />
      {labelSize > 0 && <>{chevron(0.34)}{chevron(0.64)}{chevron(0.88, true)}</>}
      {size != null && (
        <g>
          <rect x={labelAt[0] - labelW / 2} y={labelAt[1] - labelH / 2 - 0.12} width={labelW} height={labelH}
            rx={Math.min(0.2, labelH / 3)} fill="var(--g-surface)" opacity={0.94} stroke={colour}
            strokeOpacity={0.38} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <text className={quiet ? "twin-map-text" : undefined} x={labelAt[0]} y={labelAt[1] + labelSize * 0.34} textAnchor="middle" fontSize={size}
            fill={colour} style={halo ? { strokeWidth: halo } : undefined}>
            <tspan fontWeight={700} fill={colour}>{edge.count}×</tspan>
            <tspan dx={labelSize * 0.28} fill="var(--g-text-2)" fontWeight={500}>
              {edge.metres.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m
            </tspan>
            {!edge.exact && <tspan dx={labelSize * 0.28} fill="var(--g-muted)" fontWeight={500}>Luftlinie</tspan>}
          </text>
        </g>
      )}
    </g>
  );
}

function MeasureLine({ a, b, fs }: { a: [number, number]; b: [number, number]; fs: (px: number) => number }) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const deg = Math.round(((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 360);
  return (
    <g className="floor-measureline" pointerEvents="none">
      <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="var(--g-floor-warn)" strokeWidth={2}
        vectorEffect="non-scaling-stroke" />
      {[a, b].map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={0.16} fill="var(--g-floor-warn)" stroke="var(--g-surface)" strokeWidth={0.05} />
      ))}
      <text className="floor-measure" textAnchor="middle"
        x={(a[0] + b[0]) / 2} y={(a[1] + b[1]) / 2 - 0.35}
        fontSize={fs(13)} style={{ strokeWidth: fs(2.2) }}>
        {fmtNum(len)} m · {deg}°
      </text>
    </g>
  );
}

/** Kleine Vektor-Glyphen je Stationstyp, weiß, im 1×1-Meter-Kreis. */
export function TypeGlyph({ type }: { type: Station["type"] }) {
  const stroke = { stroke: "var(--g-on-data)", strokeWidth: 0.09, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (type) {
    case "production":
      // Schneidplotter: Rahmen, Schlitten und Messerkopf — bewusst einfach.
      return (
        <g {...stroke} transform="scale(0.62)">
          <rect x={-0.62} y={-0.5} width={1.24} height={1.0} rx={0.1} />
          <line x1={-0.4} y1={0.18} x2={0.4} y2={0.18} />
          <line x1={0} y1={-0.5} x2={0} y2={0.18} />
          <circle cx={0} cy={0.18} r={0.09} fill="var(--g-on-data)" stroke="none" />
        </g>
      );
    case "accounting":
      return <text y={0.22} textAnchor="middle" fontSize={0.78} fontWeight={700} fill="var(--g-on-data)">€</text>;
    case "shipping":
      // LKW von der Seite.
      return (
        <g {...stroke} transform="scale(0.62)">
          <path d="M-0.66,-0.28 h0.86 v0.62 h-0.86 z" />
          <path d="M0.2,-0.06 h0.34 l0.22,0.24 v0.16 h-0.56 z" />
          <circle cx={-0.32} cy={0.42} r={0.11} />
          <circle cx={0.4} cy={0.42} r={0.11} />
        </g>
      );
    case "warehouse":
      // Regal — nicht das Paket von früher: ein Lager ist ein Regal.
      return (
        <g {...stroke} transform="scale(0.62)">
          <rect x={-0.55} y={-0.45} width={1.1} height={0.95} rx={0.05} />
          <line x1={-0.55} y1={-0.13} x2={0.55} y2={-0.13} />
          <line x1={-0.55} y1={0.19} x2={0.55} y2={0.19} />
          <line x1={0} y1={-0.45} x2={0} y2={0.5} />
        </g>
      );
  }
}
