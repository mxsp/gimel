import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonGroup, Callout, Card, Checkbox, Dialog, DialogBody, DialogFooter, FileInput, FormGroup, HTMLSelect, HTMLTable, InputGroup, Menu, MenuItem, NumericInput, Spinner, Tab, Tabs, Icon, Tag, TextArea, Tooltip } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import { api, apiUpload } from "../api";
import { More, PageInfo, pageInfo } from "../ui";
import { navigate } from "../router";
import { toastError, toastInfo, toastSuccess } from "../toast";
import FloorPlan from "../components/FloorPlan";
import {
  aisleAttach, aisleComponents, aisleStub, Aisles, buildPresetPolygon, cleanAisles, connectStation, effectiveDoorKind, manualAttach, ManualPath, Pathfinder,
  polylineLength, proposeConnection, rectDimensions, resizeRectPolygon, rotatePolygon, simplifyPolyline, ALL_TYPES, BLANK_STATION, COLOUR_PALETTE, copyToClipboard, Door,
  DOOR_KINDS, EMPTY_FLOOR, Floor, FloorLayer, LAYER_LABEL, MACHINE_LABEL,
  MACHINE_PRESET, MachineKind, missingMachineData, Obstacle, obstacleHeight, obstacleKind, polygonArea,
  polygonCentroid, polygonPerimeter, polygonSelfIntersects, Product, ROUTING_HELP, ROUTING_LABEL,
  routeMetres, Station, StationRouting, StationType, StationUser,
  StationVisibility, stationCorners, stationUrl, STRUCTURAL_PRESETS, StructuralPreset, suggestAisles, templateL,
  templateRect, templateU, translatePolygon, TYPE_COLOUR, TYPE_DEFAULT_SIZE, TYPE_LABEL,
  VISIBILITY_LABEL, Zone, ZONE_KINDS, fmtM, fmtMin,
} from "../factory";
import { plural } from "../plural";
import FloorSwitcher from "../components/FloorSwitcher";
import ModelChoice from "../components/twin/ModelChoice";
import SitesDialog from "../components/SitesDialog";
import LevelDialog from "../components/LevelDialog";
import HallCreatorDialog, { GeneratedHallPlan } from "../components/HallCreatorDialog";
import { allFloors, floorLabel, stationFloor, useTopology } from "../sites";
import { usePhone } from "../usePhone";

/* Grundriss bearbeiten — die Halle bauen, nicht nur bemalen.

   Fünf Ebenen mit demselben Werkzeug: Umriss, Zonen, Hindernisse, Gänge, Tore.
   Nur eine davon geht in eine Rechnung ein — das Gangnetz trägt die Entfernung
   Lager → Maschine und damit einen Faktor der Zuordnung. Deshalb steht neben
   dem Gang-Werkzeug immer, was er gerade wert ist, und die Prüfleiste sagt,
   wenn ohne Netz mit Luftlinie gerechnet wird.

   Gespeichert wird nach Ebene: der Umriss über „Halle speichern", die
   Stationen einzeln. Ein einziger großer Speichern-Knopf für alles hätte den
   Nachteil, dass ein Fehler in der einen Ebene die andere mitreißt. */

type Mode = "select" | "draw" | "rect" | "measure";

interface Hist { past: Floor[]; future: Floor[] }

/** Ab diesem Stichweg gilt eine Station als nicht angebunden (wie connect_issues). */
const STUB_MAX_M = 8;

/** Vom Assistenten: eine neue Station zur Platzierung oder eine vorhandene zum Anfassen. */
export interface EditorPlacement { token: number; station: Partial<Station> }
export interface EditorFocus { token: number; id: number }

/** ``embedded``: im Twin Studio — ohne Rücksprung ins Portal, die Ebene kommt von dort. */
export default function FloorAdmin({
  embedded = false, placement = null, focus = null, onDirtyChange, onSaved,
}: {
  embedded?: boolean;
  placement?: EditorPlacement | null;
  focus?: EditorFocus | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: (floor: Floor) => void;
} = {}) {
  const phone = usePhone();
  const site = useTopology();
  const [sitesOpen, setSitesOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);
  const [saved, setSaved] = useState<Floor | null>(null);
  const [floor, setFloor] = useState<Floor>(EMPTY_FLOOR);
  const [stations, setStations] = useState<Station[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [users, setUsers] = useState<StationUser[]>([]);
  const [editing, setEditing] = useState<Station>({ ...BLANK_STATION });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  /** Eine gewählte Modelldatei für eine noch neue Station: sie geht beim Anlegen hoch. */
  const [pendingModel, setPendingModel] = useState<File | null>(null);
  useEffect(() => { setPendingModel(null); }, [editing.id]);
  /** Neue Station: erst Dialog (Modell, Mitarbeiter), dann anlegen. */
  const [newType, setNewType] = useState<StationType | null>(null);
  /** Vom Assistenten vorbereitete Platzierung bzw. Auswahl — einmal je Auftrag. */
  const appliedPlacement = useRef(0);
  const appliedFocus = useRef(0);
  const [loading, setLoading] = useState(true);
  const [allForAll, setAllForAll] = useState(false);
  const [autoRouting, setAutoRouting] = useState(false);
  const [feedEmpty, setFeedEmpty] = useState(true);

  const [mode, setMode] = useState<Mode>("select");
  const [layer, setLayer] = useState<FloorLayer>("outline");
  /** Welche Zone / welches Hindernis gerade bearbeitet wird (-1 = neu). */
  const [zoneIdx, setZoneIdx] = useState(-1);
  const [obstacleIdx, setObstacleIdx] = useState(-1);
  const [doorIdx, setDoorIdx] = useState<number | null>(null);
  const [doorKind, setDoorKind] = useState<Door["kind"]>("door");
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [draftClosed, setDraftClosed] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftKind, setDraftKind] = useState("storage");
  const [draftObstacleKind, setDraftObstacleKind] = useState("");
  const [draftHeightM, setDraftHeightM] = useState<number | null>(null);
  const [aisleAnchor, setAisleAnchor] = useState<number | null>(null);
  /** Pfad von Hand in Arbeit: erster Punkt ist die Station. */
  const [pathDraft, setPathDraft] = useState<[number, number][] | null>(null);
  /** Vorschlag des Pfadfinders — erst übernommen, wenn der Admin es sagt. */
  const [proposal, setProposal] = useState<{ aisles: Aisles; lines: [[number, number], [number, number]][]; done: string[]; failed: string[] } | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [ioOpen, setIoOpen] = useState(false);
  const [ioText, setIoText] = useState("");
  const [dxfOpen, setDxfOpen] = useState(false);
  const [tab, setTab] = useState("halle");
  const [show, setShow] = useState({ links: true, zones: true, obstacles: true, aisles: true, doors: true, grid: true, labels: true });

  const stationsRef = useRef<Station[]>([]);
  stationsRef.current = stations;
  const commitTimer = useRef<number | null>(null);
  const floorRef = useRef<Floor>(floor);
  floorRef.current = floor;

  // ---------------------------------------------------------------- Laden
  const load = async () => {
    setLoading(true);
    try {
      const fid = site.floorId;
      const f = await api<Floor>(fid ? `/api/factory/floor?floor_id=${fid}` : "/api/factory/floor");
      const merged: Floor = { ...EMPTY_FLOOR, ...f, aisles: f.aisles ?? { nodes: [], edges: [] } };
      setSaved(merged);
      setFloor(merged);
      setHist({ past: [], future: [] });
      // Bearbeitet wird die gewählte Ebene; die Stationen der anderen bleiben, wo sie sind.
      const all = await api<Station[]>("/api/factory/stations");
      setStations(site.topo ? all.filter((st) => stationFloor(st, site.topo) === (fid ?? f.id)) : all);
      try {
        const a = await api<{ key: string; value: string }>("/api/factory/settings/all_for_all");
        setAllForAll(a.value === "1");
      } catch { /* Einstellung fehlt — Default gilt. */ }
      try {
        const a = await api<{ key: string; value: string }>("/api/factory/settings/auto_routing");
        setAutoRouting(a.value === "1");
      } catch { /* dito */ }
      try {
        const a = await api<{ key: string; value: string }>("/api/factory/settings/feed_empty");
        setFeedEmpty(a.value !== "0");   // Voreinstellung an — der Betrieb hat die Regel bestellt
      } catch { /* dito */ }
      try {
        const u = await api<StationUser[] | { items: StationUser[] }>("/api/users");
        setUsers(Array.isArray(u) ? u : u.items);
      } catch { /* Nutzerliste optional. */ }
      try {
        const pr = await api<Product[] | { items: Product[] }>("/api/products");
        setProducts(Array.isArray(pr) ? pr : pr.items);
      } catch { /* Werkstoffliste optional. */ }
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [site.floorId, site.topo]);
  const hallMap = useMemo(() => {
    const h = site.current?.hall;
    return h && h.map_enabled && (h.lat || h.lon) ? { lat: h.lat, lon: h.lon, rotation_deg: h.rotation_deg } : null;
  }, [site.current]);
  const pickFloor = (id: number) => {
    if (id === site.floorId) return;
    if (dirty && !window.confirm("Die Ebene hat ungespeicherte Änderungen. Trotzdem wechseln?")) return;
    setSelectedId(null);
    setEditing({ ...BLANK_STATION });
    site.setFloorId(id);
  };
  // ------------------------------------------------- Geschichte des Grundrisses
  const [hist, setHist] = useState<Hist>({ past: [], future: [] });

  /** Jede Änderung an der Halle geht hierdurch — damit Strg+Z alles kann,
      nicht nur den Umriss wie in der ersten Fassung. */
  const mutate = useCallback((next: Partial<Floor>) => {
    setHist((h) => ({ past: [...h.past.slice(-59), floorRef.current], future: [] }));
    setFloor((f) => ({ ...f, ...next }));
  }, []);

  const undo = useCallback(() => {
    setHist((h) => {
      const prev = h.past[h.past.length - 1];
      if (!prev) return h;
      setFloor(prev);
      return { past: h.past.slice(0, -1), future: [floorRef.current, ...h.future] };
    });
  }, []);

  const redo = useCallback(() => {
    setHist((h) => {
      const next = h.future[0];
      if (!next) return h;
      setFloor(next);
      return { past: [...h.past, floorRef.current], future: h.future.slice(1) };
    });
  }, []);

  // ---------------------------------------------------------------- Entwürfe
  /** Entwurf in die Halle zurückschreiben — je nach Ebene an die richtige Stelle. */
  const commitDraft = (): boolean => {
    if (draft.length < 3) { toastError("Mindestens drei Punkte."); return false; }
    if (polygonSelfIntersects(draft)) {
      toastError("Das Polygon schneidet sich selbst — bitte Punkte korrigieren.");
      return false;
    }
    if (layer === "outline") {
      mutate({ outline: draft });
      setDraft([]);
      setDraftClosed(false);
      toastSuccess(`Umriss übernommen — ${plural(draft.length, "Punkt", "Punkte")}, ${polygonArea(draft).toFixed(0)} m².`);
      return true;
    }
    if (layer === "zone") {
      const kindMeta = ZONE_KINDS.find((k) => k.id === draftKind);
      const z: Zone = {
        name: draftName.trim() || kindMeta?.label || "Zone", kind: draftKind,
        colour: kindMeta?.colour ?? "#8e5cb8",
        points: draft,
      };
      const zones = [...(floor.zones ?? [])];
      if (zoneIdx >= 0) zones[zoneIdx] = z; else zones.push(z);
      mutate({ zones });
      setZoneIdx(-1); setDraft([]); setDraftClosed(false); setDraftName("");
      toastSuccess(`Zone „${z.name}" übernommen.`);
      return true;
    }
    if (layer === "obstacle") {
      const presetMeta = STRUCTURAL_PRESETS.find((p) => p.id === draftObstacleKind);
      const o: Obstacle = {
        name: draftName.trim() || presetMeta?.name || "Hindernis",
        points: draft,
        ...(draftObstacleKind && draftObstacleKind !== "obstacle" ? { kind: draftObstacleKind } : {}),
        ...(draftHeightM != null && Number.isFinite(draftHeightM) && draftHeightM > 0
          ? { height_m: Math.round(draftHeightM * 100) / 100 } : {}),
      };
      const obstacles = [...(floor.obstacles ?? [])];
      if (obstacleIdx >= 0) obstacles[obstacleIdx] = o; else obstacles.push(o);
      mutate({ obstacles });
      setObstacleIdx(-1); setDraft([]); setDraftClosed(false); setDraftName("");
      setDraftObstacleKind(""); setDraftHeightM(null);
      toastSuccess(`Bauteil „${o.name}" übernommen.`);
      return true;
    }
    return false;
  };

  const startLayer = (l: FloorLayer) => {
    const isPoly = l === "outline" || l === "zone" || l === "obstacle";
    setLayer(l);
    setMode(mode === "rect" && isPoly ? "rect" : "draw");
    setAisleAnchor(null);
    const outlinePts = l === "outline" ? [...(floor.outline ?? [])] : [];
    setDraft(outlinePts);
    setDraftClosed(l === "outline" && outlinePts.length >= 3);
    setZoneIdx(-1); setObstacleIdx(-1); setDraftName("");
    setDraftObstacleKind(""); setDraftHeightM(null);
  };

  const editZone = (i: number) => {
    const z = floor.zones?.[i];
    if (!z) return;
    setLayer("zone"); setMode("draw"); setZoneIdx(i); setObstacleIdx(-1);
    setDraft([...z.points]); setDraftClosed(true); setDraftName(z.name); setDraftKind(z.kind || "zone");
  };

  const editObstacle = (i: number) => {
    const o = floor.obstacles?.[i];
    if (!o) return;
    const k = obstacleKind(o);
    setLayer("obstacle"); setMode("draw"); setObstacleIdx(i); setZoneIdx(-1);
    setDraft([...o.points]); setDraftClosed(true); setDraftName(o.name);
    setDraftObstacleKind(k);
    setDraftHeightM(o.height_m ?? obstacleHeight(o, floor.height_m || 6));
  };

  // ---------------------------------------------------------------- Gänge
  const onAisleClick = (p: [number, number], hit: number | null) => {
    const a: Aisles = {
      nodes: [...(floor.aisles?.nodes ?? [])],
      edges: [...(floor.aisles?.edges ?? [])],
      paths: floor.aisles?.paths,
    };
    if (pathDraft) {
      // Pfad von Hand: ein Klick auf einen Knoten übernimmt dessen Lage, sonst die Klickstelle.
      setPathDraft([...pathDraft, hit != null ? floor.aisles.nodes[hit] : p]);
      return;
    }
    let idx: number;
    if (hit != null) {
      idx = hit;
    } else {
      a.nodes.push(p);
      idx = a.nodes.length - 1;
    }
    if (aisleAnchor != null && aisleAnchor !== idx) {
      const exists = a.edges.some(([i, j]) =>
        (i === aisleAnchor && j === idx) || (i === idx && j === aisleAnchor));
      if (!exists) a.edges.push([aisleAnchor, idx]);
    }
    mutate({ aisles: a });
    setAisleAnchor(idx);
  };

  const deleteNode = (idx: number) => {
    const a = floor.aisles ?? { nodes: [], edges: [] };
    const nodes = a.nodes.filter((_, i) => i !== idx);
    // Kanten umnummerieren — ein Netz mit Verweisen ins Leere rechnet falsch,
    // statt zu krachen, und das ist die schlimmere Sorte Fehler.
    const edges = a.edges
      .filter(([i, j]) => i !== idx && j !== idx)
      .map(([i, j]) => [i > idx ? i - 1 : i, j > idx ? j - 1 : j] as [number, number]);
    mutate({ aisles: { nodes, edges, paths: a.paths } });
    setAisleAnchor(null);
  };

  const deleteEdge = (idx: number) => {
    const a = floor.aisles ?? { nodes: [], edges: [] };
    const edges = a.edges.filter((_, k) => k !== idx);
    mutate({ aisles: { ...a, edges } });
    setAisleAnchor(null);
    toastSuccess("Gang gelöscht — „Halle speichern“ macht es endgültig, Strg+Z holt ihn zurück.");
  };

  const splitEdge = (idx: number, at: [number, number]) => {
    const a = floor.aisles ?? { nodes: [], edges: [] };
    const pair = a.edges[idx];
    if (!pair) return;
    const [i, j] = pair;
    const nodes = [...a.nodes, at];
    const mid = nodes.length - 1;
    const edges = a.edges.filter((_, k) => k !== idx);
    edges.push([i, mid], [mid, j]);
    mutate({ aisles: { ...a, nodes, edges } });
    setAisleAnchor(mid);
    toastSuccess("Gang geteilt — der neue Knoten lässt sich verschieben.");
  };

  const cleanNetwork = () => {
    const a = floor.aisles ?? { nodes: [], edges: [] };
    const before = a.nodes.length + a.edges.length;
    const next = cleanAisles(a);
    const after = next.nodes.length + next.edges.length;
    if (after === before) { toastSuccess("Gangnetz ist schon aufgeräumt."); return; }
    mutate({ aisles: next });
    setAisleAnchor(null);
    toastSuccess(`Gangnetz aufgeräumt — ${before - after} Knoten/Kanten weniger.`);
  };

  const suggestNetwork = () => {
    if ((floor.outline?.length ?? 0) < 3) { toastError("Erst den Umriss zeichnen."); return; }
    mutate({ aisles: { ...suggestAisles(floor.outline), paths: floor.aisles?.paths } });
    setAisleAnchor(null);
    toastSuccess("Mittelgang vorgeschlagen — bitte an die echte Halle anpassen.");
  };

  // ------------------------------------------------- Umriss löschen / Neu anfangen
  /** Den Umriss entfernen — der Weg, der bisher fehlte: einmal gezeichnet,
      ließ sich die Halle nur überschreiben, nie leer machen. */
  const deleteOutline = () => {
    if (!(floor.outline?.length ?? 0)) { toastError("Es gibt keinen Umriss zum Löschen."); return; }
    mutate({ outline: [] });
    setDraft([]);
    toastSuccess("Umriss gelöscht — „Halle speichern“ macht es endgültig, Strg+Z holt ihn zurück.");
  };

  /** Alles zurücksetzen — der Neuanfang. Stationen bleiben bewusst stehen:
      sie hängen an Innenaufträgen und Warteschlangen, die Halle nicht. */
  const resetHall = () => {
    if (!window.confirm(
      "Wirklich alles zurücksetzen? Umriss, Zonen, Hindernisse, Gänge und Tore "
      + "werden geleert. Die Stationen bleiben stehen. Strg+Z macht es rückgängig, "
      + "„Halle speichern“ macht es endgültig.")) return;
    mutate({
      outline: [], zones: [], obstacles: [], doors: [],
      aisles: { nodes: [], edges: [] },
    });
    setDraft([]); setAisleAnchor(null); setDoorIdx(null);
    toastSuccess("Halle geleert — Stationen blieben erhalten. Speichern nicht vergessen.");
  };

  /** Umriss aus den Stationen ableiten — ein Rahmen, der alles umschließt,
      als Entwurf zum Weiterziehen und Übernehmen. */
  const outlineFromStations = () => {
    const withId = stations.filter((s) => s.id != null);
    if (!withId.length) { toastError("Es gibt keine Stationen, um die herum man schließen könnte."); return; }
    const xs: number[] = [], ys: number[] = [];
    for (const s of withId) {
      for (const [cx, cy] of stationCorners(s)) { xs.push(cx); ys.push(cy); }
    }
    const m = 2;
    const x0 = Math.floor(Math.min(...xs) - m), x1 = Math.ceil(Math.max(...xs) + m);
    const y0 = Math.floor(Math.min(...ys) - m), y1 = Math.ceil(Math.max(...ys) + m);
    const pts: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    setLayer("outline"); setMode("draw"); setDraft(pts); setDraftClosed(true);
    toastSuccess(`Rahmen über ${plural(withId.length, "Station", "Stationen")} als Entwurf erstellt — Ecken ziehen und „Umriss übernehmen“ klicken.`);
  };

  // ------------------------------------------------- Umriss aus DXF importieren
  const importDxf = async (file: File, unit: number, targetW: number) => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ unit: String(unit), target_w_m: String(targetW) });
      const r = await apiUpload<{ points: [number, number][]; bbox: { w: number; h: number };
                                  area_m2: number; loops: number; note: string }>(
        `/api/factory/floor/outline/from-dxf?${q}`, file);
      if (!r.points?.length) { toastError("In der Datei war keine Kontur zu finden."); return; }
      setLayer("outline"); setMode("draw"); setDraft(r.points); setDraftClosed(true);
      setDxfOpen(false);
      toastSuccess(`Umriss als Entwurf geladen: ${plural(r.points.length, "Punkt", "Punkte")}, ${r.area_m2.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m² — prüfen und „Umriss übernehmen“ klicken.`);
      if (r.note.includes("Achtung")) toastError(r.note);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  /** Rechtwinklig glätten: jeder freie Punkt wird zur Manhattan-Stufe. Ein
      Helfer, kein Wahrheitsanspruch — rückgängig kann man ihn immer. */
  const orthogonalize = () => {
    if (draft.length < 3) { toastError("Dafür braucht es mindestens drei Punkte."); return; }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const out: [number, number][] = [[...draft[0]]];
    for (let i = 1; i < draft.length - 1; i++) {
      const prev = out[out.length - 1], cur = draft[i];
      const dx = cur[0] - prev[0], dy = cur[1] - prev[1];
      if (Math.abs(dx) > 1e-9 && Math.abs(dy) > 1e-9) {
        out.push([r2(prev[0] + dx), r2(prev[1])]);   // erst längs, dann quer
        out.push([r2(prev[0] + dx), r2(cur[1])]);
      } else {
        out.push([r2(cur[0]), r2(cur[1])]);
      }
    }
    const last = out[out.length - 1], first = out[0];
    if (Math.abs(last[0] - first[0]) > 1e-9 && Math.abs(last[1] - first[1]) > 1e-9) {
      const orig = draft[draft.length - 1];
      const c1: [number, number] = [first[0], last[1]];
      const c2: [number, number] = [last[0], first[1]];
      const d1 = Math.hypot(orig[0] - c1[0], orig[1] - c1[1]);
      const d2 = Math.hypot(orig[0] - c2[0], orig[1] - c2[1]);
      out.push(d1 <= d2 ? c1 : c2);
    }
    setDraft(out);
    toastSuccess("Rechtwinklig geglättet — Strg+Z macht es rückgängig.");
  };

  // ---------------------------------------------------------------- Tore, Treppen & Aufzüge
  const addDoor = (p: [number, number]) => {
    const meta = DOOR_KINDS.find((k) => k.id === doorKind) ?? DOOR_KINDS[0];
    const sameCount = (floor.doors ?? []).filter((d) => (d.kind || "door") === meta.id).length;
    const d: Door = {
      name: `${meta.label} ${sameCount + 1}`,
      x: p[0],
      y: p[1],
      width: meta.width,
      kind: meta.id,
    };
    mutate({ doors: [...(floor.doors ?? []), d] });
    setDoorIdx((floor.doors?.length ?? 0));
  };

  const startDoorKind = (kind: Door["kind"]) => {
    setDoorKind(kind);
    setLayer("door");
    setMode("draw");
    setAisleAnchor(null);
    setDraft([]);
    setZoneIdx(-1);
    setObstacleIdx(-1);
  };

  const addStructuralPreset = (preset: StructuralPreset) => {
    // Laufenden gültigen Bauteil-/Zonen-Entwurf zuerst sichern, statt still zu verwerfen.
    if ((layer === "obstacle" || layer === "zone") && draft.length >= 3 && !polygonSelfIntersects(draft)) {
      commitDraft();
    }
    const curObstacles = floorRef.current.obstacles ?? [];
    const pts = floorRef.current.outline?.length >= 3 ? floorRef.current.outline : [[0, 0], [20, 0], [20, 14], [0, 14]] as [number, number][];
    let cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    let cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    // Mehrere Bauteile hintereinander nicht deckungsgleich stapeln.
    for (let step = 0; step < 8; step++) {
      const crowded = curObstacles.some((o) => {
        if ((o.points?.length ?? 0) < 3) return false;
        const c = polygonCentroid(o.points);
        return Math.hypot(c[0] - cx, c[1] - cy) < 0.8;
      });
      if (!crowded) break;
      cx += 1.5;
      cy += 1.0;
    }
    const poly = buildPresetPolygon(preset, cx, cy);
    const sameCount = curObstacles.filter((o) => obstacleKind(o) === preset.id || o.name.startsWith(preset.name)).length;
    const labelName = sameCount > 0 ? `${preset.name} ${sameCount + 1}` : preset.name;
    setLayer("obstacle");
    setObstacleIdx(-1);
    setZoneIdx(-1);
    setDraftName(labelName);
    setDraftObstacleKind(preset.id);
    setDraftHeightM(obstacleHeight({ name: preset.name, kind: preset.id }, floorRef.current.height_m || 6));
    setDraft(poly);
    setDraftClosed(true);
    setMode("draw");
    toastInfo(`${preset.label} als Entwurf angelegt — Fläche ziehen, drehen (R) oder „Anlegen“ klicken.`);
  };

  const editDoor = (i: number) => {
    const d = floor.doors?.[i];
    if (!d) return;
    setLayer("door");
    setMode("draw");
    setDoorIdx(i);
    setDoorKind(effectiveDoorKind(d));
  };

  const patchDoor = (i: number, patch: Partial<Door>) =>
    mutate({ doors: (floor.doors ?? []).map((d, k) => (k === i ? { ...d, ...patch } : d)) });

  // ---------------------------------------------------------------- Speichern
  const dirty = useMemo(
    () => JSON.stringify(saved) !== JSON.stringify({ ...saved, ...floor }), [saved, floor]);

  const hasValidDraft = (layer === "outline" || layer === "zone" || layer === "obstacle")
    && draft.length >= 3 && !polygonSelfIntersects(draft);
  const hasUnsavedDraft = (layer === "outline" || layer === "zone" || layer === "obstacle") && draft.length > 0;
  const hasUnsaved = dirty || hasUnsavedDraft;
  useEffect(() => {
    onDirtyChange?.(hasUnsaved);
    return () => { onDirtyChange?.(false); };
  }, [hasUnsaved, onDirtyChange]);

  const saveFloor = async () => {
    setBusy(true);
    try {
      let nextOutline = floor.outline;
      let nextZones = floor.zones;
      let nextObstacles = floor.obstacles;

      // Automatisch offenen gültigen Entwurf beim Klick auf „Halle speichern“ mit übernehmen,
      // damit niemand durch das Zweistufen-Übernehmen seine Zeichnung verliert!
      if (hasValidDraft) {
        if (layer === "outline") {
          nextOutline = draft;
        } else if (layer === "zone") {
          const kindMeta = ZONE_KINDS.find((k) => k.id === draftKind);
          const z: Zone = {
            name: draftName.trim() || kindMeta?.label || "Zone",
            kind: draftKind,
            colour: kindMeta?.colour ?? "#8e5cb8",
            points: draft,
          };
          nextZones = [...(floor.zones ?? [])];
          if (zoneIdx >= 0) nextZones[zoneIdx] = z; else nextZones.push(z);
        } else if (layer === "obstacle") {
          const presetMeta = STRUCTURAL_PRESETS.find((p) => p.id === draftObstacleKind);
          const o: Obstacle = {
            name: draftName.trim() || presetMeta?.name || "Hindernis",
            points: draft,
            ...(draftObstacleKind && draftObstacleKind !== "obstacle" ? { kind: draftObstacleKind } : {}),
            ...(draftHeightM != null && Number.isFinite(draftHeightM) && draftHeightM > 0
              ? { height_m: Math.round(draftHeightM * 100) / 100 } : {}),
          };
          nextObstacles = [...(floor.obstacles ?? [])];
          if (obstacleIdx >= 0) nextObstacles[obstacleIdx] = o; else nextObstacles.push(o);
        }
        setDraft([]);
        setDraftClosed(false);
        setZoneIdx(-1);
        setObstacleIdx(-1);
        setMode("select");
      }

      // Falls in Production noch kein Standort / keine Halle existiert, automatisch anlegen.
      let hallId = floor.hall_id ?? null;
      let floorIdToSave = floor.id && floor.id > 0 ? floor.id : null;
      const hasAnyHall = (site.topo?.sites?.some((s) => s.halls.length > 0) || (site.topo?.unsited_halls?.length ?? 0) > 0) ?? false;
      if (!hallId && !hasAnyHall) {
        try {
          let siteId = site.topo?.default_site_id ?? site.topo?.sites?.[0]?.id ?? null;
          if (!siteId) {
            const createdSite = await api<{ id: number }>("/api/factory/sites", {
              method: "POST",
              body: JSON.stringify({ name: "Hauptwerk" }),
            });
            siteId = createdSite.id;
          }
          const createdHall = await api<{ id: number; floors?: { id: number; level: number }[] }>("/api/factory/halls", {
            method: "POST",
            body: JSON.stringify({ site_id: siteId, name: floor.name || "Halle 1" }),
          });
          hallId = createdHall.id;
          const ground = createdHall.floors?.find((f) => f.level === 0) ?? createdHall.floors?.[0];
          if (ground?.id) floorIdToSave = ground.id;
        } catch {
          /* Fallback auf Standard-Floor-Endpunkt */
        }
      }

      const body = {
        name: floor.name || "Halle 1", outline: nextOutline, zones: nextZones,
        obstacles: nextObstacles, doors: floor.doors, aisles: floor.aisles,
        scale: floor.scale, grid: floor.grid, snap: floor.snap, bg: floor.bg,
        hall_id: hallId, level: floor.level ?? 0, level_name: floor.level_name || "EG",
        elevation_m: floor.elevation_m ?? 0, height_m: floor.height_m ?? 6,
      };
      const q = floorIdToSave ? `?floor_id=${floorIdToSave}` : "";
      const s = await api<Floor>(`/api/factory/floor${q}`, { method: "PUT", body: JSON.stringify(body) });
      const merged: Floor = { ...EMPTY_FLOOR, ...s, aisles: s.aisles ?? { nodes: [], edges: [] } };
      setSaved(merged);
      setFloor(merged);
      setHist({ past: [], future: [] });
      await site.reload();
      if (merged.id && merged.id !== site.floorId) site.setFloorId(merged.id);
      onSaved?.(merged);
      toastSuccess("Halle gespeichert.");
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  // ---------------------------------------------------------------- Stationen
  const moveStation = (id: number, s: Station) => {
    const patch = { x: s.x, y: s.y, w: s.w, h: s.h, rotation: s.rotation };
    setStations((ss) => ss.map((v) => (v.id === id ? { ...v, ...patch } : v)));
    setEditing((ed) => (ed.id === id ? { ...ed, ...patch } : ed));
  };

  const commitStation = async (id: number) => {
    const s = stationsRef.current.find((v) => v.id === id);
    if (!s) return;
    try {
      const savedSt = await api<Station>(`/api/factory/stations/${id}`, { method: "PUT", body: JSON.stringify(s) });
      setStations((ss) => ss.map((v) => (v.id === id ? savedSt : v)));
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
      load();
    }
  };

  const commitSoon = (id: number) => {
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => { commitTimer.current = null; commitStation(id); }, 500);
  };

  useEffect(() => () => { if (commitTimer.current) window.clearTimeout(commitTimer.current); }, []);

  const createStation = async (st: Station, modelFile: File | null = null): Promise<Station | null> => {
    setBusy(true);
    try {
      const body = { ...st, floor_id: st.floor_id ?? (floor.id || null) };
      let s = await api<Station>("/api/factory/stations", { method: "POST", body: JSON.stringify(body) });
      toastSuccess(`${s.label} angelegt.`);
      if (modelFile && s.id != null) {
        // Die Station steht schon; scheitert der Upload, bleibt sie ohne Datei und es lässt sich später wiederholen.
        try {
          s = await apiUpload<Station>(`/api/factory/stations/${s.id}/model`, modelFile);
          toastSuccess(`3D-Modell für ${s.label} hinterlegt.`);
        } catch (e: unknown) {
          toastError(`Das Modell ließ sich nicht hochladen: ${e instanceof Error ? e.message : String(e)} — die Station ist angelegt, die Datei lässt sich nachladen.`);
        }
      }
      const made = s;
      setStations((ss) => [...ss, made]);
      setSelectedId(made.id ?? null);
      setEditing({ ...made });
      return made;
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
      return null;
    } finally { setBusy(false); }
  };

  /** Die Vorgabe einer neuen Station dieses Typs an einem freien Platz. */
  const blankOf = (type: StationType): Station => {
    const size = TYPE_DEFAULT_SIZE[type];
    const st: Station = {
      ...BLANK_STATION, type, colour: TYPE_COLOUR[type],
      label: `${TYPE_LABEL[type]} ${stations.filter((s) => s.type === type).length + 1}`,
      w: size.w, h: size.h, is_storage: type === "warehouse",
      ...(type === "production" ? MACHINE_PRESET.plotter : {}),
      machine_kind: type === "production" ? "plotter" : "",
    };
    for (let i = 0; i < 24; i++) {
      const x = 3 + i * 1.5;
      const hits = stations.some((o) => Math.abs(o.x - x) < (o.w + st.w) / 2 && Math.abs(o.y - 3) < (o.h + st.h) / 2);
      st.x = x;
      if (!hits) break;
    }
    st.y = 3;
    return st;
  };

  const addStation = (type: StationType) => setNewType(type);

  const duplicateStation = () => {
    if (!editing.id) return;
    void createStation({
      ...editing, id: undefined,
      label: `${editing.label} (Kopie)`,
      subtype: editing.subtype ? `${editing.subtype}_2` : "",
      x: editing.x + 0.5, y: editing.y + 0.5,
    });
  };

  const rotateEditing = (delta: number) => {
    if (!editing.id) return;
    const rotation = ((((editing.rotation + delta) % 360) + 540) % 360) - 180;
    moveStation(editing.id, { ...editing, rotation });
    commitSoon(editing.id);
  };

  const nudgeEditing = (dx: number, dy: number) => {
    if (!editing.id) return;
    const s = stationsRef.current.find((v) => v.id === editing.id);
    if (!s || s.id == null) return;
    moveStation(s.id, { ...s, x: Math.round((s.x + dx) * 4) / 4, y: Math.round((s.y + dy) * 4) / 4 });
    commitSoon(s.id);
  };

  const saveStation = async () => {
    if (!editing.label.trim()) { toastError("Die Station braucht einen Namen."); return; }
    setBusy(true);
    try {
      if (editing.id) {
        const s = await api<Station>(`/api/factory/stations/${editing.id}`, { method: "PUT", body: JSON.stringify(editing) });
        const moved = site.topo && stationFloor(s, site.topo) !== floor.id;
        setStations((ss) => (moved ? ss.filter((v) => v.id !== s.id) : ss.map((v) => (v.id === s.id ? s : v))));
        if (moved) {
          setSelectedId(null);
          setEditing({ ...BLANK_STATION });
          site.reload();
          toastSuccess(`${s.label} steht jetzt auf ${floorLabel(allFloors(site.topo).find((r) => r.floor.id === stationFloor(s, site.topo)))}.`);
        } else toastSuccess(`${s.label} aktualisiert.`);
      } else {
        await createStation(editing, pendingModel);
      }
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const uploadModel = async (file: File) => {
    if (!editing.id) {
      // Noch neu: die Datei geht beim Anlegen hoch.
      setPendingModel(file);
      toastSuccess(`${file.name} vorgemerkt — wird beim Anlegen hochgeladen.`);
      return;
    }
    setModelBusy(true);
    try {
      const s = await apiUpload<Station>(`/api/factory/stations/${editing.id}/model`, file);
      setStations((ss) => ss.map((v) => (v.id === s.id ? s : v)));
      setEditing({ ...s });
      toastSuccess(`3D-Modell für ${s.label} hinterlegt.`);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setModelBusy(false); }
  };

  const removeModel = async () => {
    if (!editing.id || !editing.model_file) return;
    if (!window.confirm("Das 3D-Modell dieser Station entfernen?")) return;
    setModelBusy(true);
    try {
      const s = await api<Station>(`/api/factory/stations/${editing.id}/model`, { method: "DELETE" });
      setStations((ss) => ss.map((v) => (v.id === s.id ? s : v)));
      setEditing({ ...s });
      toastSuccess("3D-Modell entfernt.");
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setModelBusy(false); }
  };

  const deleteStation = async () => {
    if (!editing.id) return;
    if (!window.confirm(`${editing.label} wirklich löschen? Zugeordnete Innenaufträge werden wieder freigegeben.`)) return;
    setBusy(true);
    try {
      await api(`/api/factory/stations/${editing.id}`, { method: "DELETE" });
      setStations((ss) => ss.filter((v) => v.id !== editing.id));
      setEditing({ ...BLANK_STATION });
      setSelectedId(null);
      toastSuccess("Station gelöscht.");
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const selectStation = (s: Station) => {
    setSelectedId(s.id ?? null);
    setEditing({
      ...BLANK_STATION, ...s,
      materials: [...s.materials], thicknesses: [...s.thicknesses],
      assigned_users: [...s.assigned_users],
    });
    setMode("select");
    setTab("stationen");
  };

  /* Der Assistent hat eine Station vorbereitet oder eine vorhandene gewählt.
     Beides gilt einmal je Auftrag: die Kennung verhindert, dass ein späteres
     Neuladen der Stationen die Auswahl erneut setzt. */
  useEffect(() => {
    if (!focus || !focus.id || appliedFocus.current === focus.token) return;
    const station = stations.find((s) => s.id === focus.id);
    if (!station) return;
    appliedFocus.current = focus.token;
    selectStation(station);
  }, [focus, stations]);

  useEffect(() => {
    if (!placement || !placement.token || appliedPlacement.current === placement.token) return;
    if (!stations.length && loading) return;
    appliedPlacement.current = placement.token;
    setEditing({ ...BLANK_STATION, ...placement.station });
    setSelectedId(null);
    setMode("select");
    setTab("stationen");
    toastInfo("Platzierung vorbereitet — Position prüfen und speichern.");
  }, [placement, stations.length, loading]);

  const applyPreset = (kind: MachineKind) => {
    if (!kind) { setEditing({ ...editing, machine_kind: "" }); return; }
    setEditing({ ...editing, machine_kind: kind, ...MACHINE_PRESET[kind] });
    toastSuccess(`Richtwerte für ${MACHINE_LABEL[kind]} eingesetzt — bitte an die echte Maschine anpassen.`);
  };

  /** Esc und Rechtsklick beenden das Zeichnen: ab drei Punkten wird das Objekt übernommen,
   *  sonst nur verworfen. Gespeichert wird wie immer erst mit „Speichern“. */
  const finishDrawing = () => {
    if (pathDraft) {   // ein Pfad von Hand: ab einem Punkt nach der Station übernehmen
      if (pathDraft.length >= 2) finishPath(); else setPathDraft(null);
      return;
    }
    if (polygonLayer && draft.length >= 3) {
      if (!commitDraft()) return;
    } else if (polygonLayer && draft.length > 0) {
      setDraft([]); setDraftClosed(false); toastError("Weniger als drei Punkte, verworfen.");
    }
    setMode("select"); setAisleAnchor(null); setDraftClosed(false);
  };

  // ---------------------------------------------------------------- Tastatur
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phone) return;   // Am Telefon wird nur angesehen.
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"
                 || (el as HTMLElement).isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && e.key.toLowerCase() === "z") || e.key.toLowerCase() === "y")) {
        e.preventDefault(); redo(); return;
      }
      if (e.key === "Escape") { finishDrawing(); return; }
      if (e.key === "Enter" && mode !== "select" && mode !== "measure" && polygonLayer && draft.length >= 3) {
        e.preventDefault();
        finishDrawing();
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && mode !== "select" && mode !== "measure" && polygonLayer && !draftClosed && draft.length > 0) {
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
        return;
      }
      // Aktiven Polygon-Entwurf (z. B. Innenwand, Raumbox) per Tastatur verschieben/drehen.
      if (mode !== "select" && mode !== "measure" && polygonLayer && draft.length >= 3) {
        const step = e.shiftKey ? 1 : 0.25;
        switch (e.key) {
          case "ArrowLeft": e.preventDefault(); setDraft((d) => translatePolygon(d, -step, 0)); return;
          case "ArrowRight": e.preventDefault(); setDraft((d) => translatePolygon(d, step, 0)); return;
          case "ArrowUp": e.preventDefault(); setDraft((d) => translatePolygon(d, 0, -step)); return;
          case "ArrowDown": e.preventDefault(); setDraft((d) => translatePolygon(d, 0, step)); return;
          case "r": e.preventDefault(); setDraft((d) => rotatePolygon(d, 15)); return;
          case "R": e.preventDefault(); setDraft((d) => rotatePolygon(d, -15)); return;
          default: break;
        }
      }
      if (mode !== "select" || !editing.id) return;
      const step = e.shiftKey ? 1 : 0.25;
      switch (e.key) {
        case "ArrowLeft": e.preventDefault(); nudgeEditing(-step, 0); break;
        case "ArrowRight": e.preventDefault(); nudgeEditing(step, 0); break;
        case "ArrowUp": e.preventDefault(); nudgeEditing(0, -step); break;
        case "ArrowDown": e.preventDefault(); nudgeEditing(0, step); break;
        case "r": rotateEditing(15); break;
        case "R": rotateEditing(-15); break;
        case "d": duplicateStation(); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------- Schalter
  const toggleSetting = async (key: string, value: boolean, set: (v: boolean) => void) => {
    try {
      await api(`/api/factory/settings/${key}`, { method: "PUT", body: JSON.stringify({ value: value ? "1" : "0" }) });
      set(value);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyLink = async (id: number) => {
    if (await copyToClipboard(stationUrl(id))) toastSuccess("Link auf die Station kopiert.");
    else toastError(stationUrl(id));
  };

  const thicknessChoices = useMemo(() => {
    if (!editing.materials.length) return [];
    const set = new Set<number>();
    for (const p of products) {
      if (editing.materials.includes(p.id)) for (const t of p.thicknesses ?? []) set.add(t);
    }
    return [...set].sort((a, b) => a - b);
  }, [editing.materials, products]);

  /** Weg vom nächsten Lager zur ausgewählten Station — Vorschau derselben
      Rechnung, die im Backend die Zuordnung trägt. */
  const supplyPreview = useMemo(() => {
    if (!editing.id) return null;
    const stores = stations.filter((s) => s.is_storage && s.active && s.id !== editing.id);
    if (!stores.length) return null;
    let best: { label: string; metres: number; exact: boolean } | null = null;
    for (const st of stores) {
      const r = routeMetres(floor.aisles, [st.x, st.y], [editing.x, editing.y], floor.obstacles ?? [], floor.outline ?? []);
      if (!best || r.metres < best.metres) best = { label: st.label, ...r };
    }
    return best;
  }, [editing.id, editing.x, editing.y, stations, floor.aisles, floor.obstacles, floor.outline]);

  /** Anbindung der bearbeiteten Station ans Gangnetz — Länge und Zustand. */
  const stationLink = useMemo(() => {
    if (!editing.id || !floor.aisles?.edges?.length) return null;
    const at = aisleAttach([editing.x, editing.y], floor.aisles, floor.obstacles ?? [], floor.outline ?? []);
    if (!at.found) return null;
    return {
      connected: !at.blocked && at.dist <= STUB_MAX_M,
      blocked: at.blocked,
      metres: at.dist,
      onEdge: at.edge != null,
      line: { a: [editing.x, editing.y] as [number, number], b: at.point, ok: !at.blocked && at.dist <= STUB_MAX_M },
    };
  }, [editing.id, editing.x, editing.y, floor.aisles, floor.obstacles, floor.outline]);

  /** Ein Klick: die Station ans Netz hängen (Knoten auf der Stationsmitte,
      Kante geteilt, wo der nächste freie Anschluss mitten auf einer liegt). */
  const connectEditing = () => {
    const next = connectStation([editing.x, editing.y], floor.aisles ?? { nodes: [], edges: [] },
      floor.obstacles ?? [], floor.outline ?? []);
    if (!next) {
      toastError("Kein freier Weg zum Gangnetz — ein Hindernis oder die Hallenwand liegt davor. Knoten von Hand setzen.");
      return;
    }
    mutate({ aisles: next });
    toastSuccess("Station ans Gangnetz angebunden — Änderung noch übernehmen.");
  };

  // ------------------------------------------------- Pfade von Hand und Pfadfinder
  const outlinePts = useMemo(() => floor.outline ?? [], [floor.outline]);
  const obstacles = useMemo(() => floor.obstacles ?? [], [floor.obstacles]);

  /** Anbindung jeder aktiven Station, wie sie gerechnet wird: von Hand, automatisch oder Luftlinie. */
  const links = useMemo(() => {
    if (!floor.aisles?.edges?.length) return [];
    return stations.filter((s) => s.active).map((s) => {
      const p: [number, number] = [s.x, s.y];
      const at = aisleAttach(p, floor.aisles, obstacles, outlinePts);
      if (!at.found) return null;
      const air = at.blocked;
      const manual = at.kind === "manual";
      const man = manualAttach(p, floor.aisles, obstacles, outlinePts);
      const pts: [number, number][] = manual
        ? [...(floor.aisles.paths ?? []).filter((m) => Math.hypot(m.points[0][0] - p[0], m.points[0][1] - p[1]) < 1e-6).slice(-1)[0].points, at.point]
        : [p, at.point];
      return {
        id: s.id, label: s.label, points: pts,
        kind: (air ? "air" : manual ? "manual" : "auto") as "manual" | "auto" | "air",
        metres: at.dist, far: !air && at.dist > STUB_MAX_M, warning: man && man.kind === "auto" ? man.warning : "",
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  }, [stations, floor.aisles, obstacles, outlinePts]);

  const pathOf = (id: number | null | undefined): ManualPath | undefined =>
    id == null ? undefined : (floor.aisles?.paths ?? []).find((m) => m.station === id);

  const setPaths = (paths: ManualPath[]) =>
    mutate({ aisles: { ...(floor.aisles ?? { nodes: [], edges: [] }), paths } });

  const startPath = () => {
    if (!editing.id) { toastError("Erst die Station speichern."); return; }
    setPathDraft([[editing.x, editing.y]]);
    setProposal(null);
    setMode("draw"); setLayer("aisle"); setAisleAnchor(null);
    toastSuccess("Pfad: Klicks setzen die Punkte, das letzte Ende liegt am Gang. Dann „Pfad übernehmen“.");
  };
  const finishPath = () => {
    if (!pathDraft || pathDraft.length < 2 || !editing.id) { toastError("Ein Pfad braucht mindestens einen Punkt nach der Station."); return; }
    const rest = (floor.aisles?.paths ?? []).filter((m) => m.station !== editing.id);
    setPaths([...rest, { station: editing.id, points: pathDraft }]);
    setPathDraft(null);
    toastSuccess("Pfad von Hand gesetzt — er gilt vor dem automatischen Stichweg.");
  };
  const deletePath = (id: number) => setPaths((floor.aisles?.paths ?? []).filter((m) => m.station !== id));
  /** Einen Pfad von Hand um Hindernisse neu rechnen und auf das Nötige kürzen. */
  const optimizePath = (id: number) => {
    const p = pathOf(id);
    if (!p || p.points.length < 2) { toastError("Kein Pfad zum Optimieren."); return; }
    const finder = new Pathfinder(outlinePts, obstacles.map((o) => o.points));
    const way = finder.path(p.points[0], p.points[p.points.length - 1]);
    if (!way) { toastError("Kein freier Weg — Hindernis oder Hallenwand davor."); return; }
    const points = simplifyPolyline(way);
    setPaths((floor.aisles?.paths ?? []).map((m) => m.station === id ? { ...m, points } : m));
    toastSuccess(`Pfad optimiert: ${points.length - 1} ${points.length === 2 ? "Stück" : "Stücke"}, ${fmtM(polylineLength(points))}.`);
  };
  const popPathPoint = (id: number) => {
    const all = floor.aisles?.paths ?? [];
    setPaths(all.flatMap((m) => m.station !== id ? [m]
      : m.points.length > 2 ? [{ ...m, points: m.points.slice(0, -1) }] : []));
  };
  const pinPath = (id: number) => setPaths((floor.aisles?.paths ?? []).map((m) =>
    m.station === id ? { ...m, points: [[editing.x, editing.y] as [number, number], ...m.points.slice(1)] } : m));

  /** Pfadfinder für eine oder alle Stationen: rechnet, zeigt, speichert nichts. */
  const runPathfinder = (only?: Station) => {
    if (!floor.aisles?.nodes?.length) { toastError("Erst ein Gangnetz zeichnen oder vorschlagen."); return; }
    const finder = new Pathfinder(outlinePts, obstacles.map((o) => o.points));
    const targets = only ? [only] : stations.filter((s) => s.active);
    let acc: Aisles = { ...floor.aisles, nodes: [...floor.aisles.nodes], edges: [...floor.aisles.edges] };
    const done: string[] = [], failed: string[] = [];
    for (const s of targets) {
      const l = links.find((x) => x.id === s.id);
      if (l && l.kind !== "air" && !l.far) continue;           // schon angebunden
      const next = proposeConnection(acc, [s.x, s.y], finder);
      if (next) { acc = next; done.push(s.label); } else failed.push(s.label);
    }
    const key = (a: [number, number], b: [number, number]) => `${a}|${b}`;
    const old = new Set(floor.aisles.edges.flatMap(([i, j]) => [key(floor.aisles.nodes[i], floor.aisles.nodes[j]), key(floor.aisles.nodes[j], floor.aisles.nodes[i])]));
    const lines = acc.edges.map(([i, j]) => [acc.nodes[i], acc.nodes[j]] as [[number, number], [number, number]])
      .filter(([a, b]) => !old.has(key(a, b)));
    if (!done.length && !failed.length) { toastSuccess("Alle Stationen sind schon angebunden."); setProposal(null); return; }
    setProposal({ aisles: acc, lines, done, failed });
  };
  const acceptProposal = () => {
    if (!proposal) return;
    mutate({ aisles: proposal.aisles });
    setProposal(null);
    toastSuccess("Gänge übernommen — noch speichern.");
  };

  const gaps = missingMachineData(editing);

  if (loading && !saved) return <div className="twin-center"><Spinner size={36} /></div>;

  const drawLayer: FloorLayer | null = phone || mode === "select" ? null : layer;
  // Die Vorschau gehört zum Formular: sie steht nur im Plan, solange das Formular offen ist.
  const ghost: Station | null = phone || editing.id || tab !== "stationen" ? null : { ...editing };
  const draftColour = layer === "zone"
    ? (ZONE_KINDS.find((k) => k.id === draftKind)?.colour ?? "#8e5cb8")
    : layer === "obstacle" ? "#5c7080" : "var(--g-floor-error)";
  const polygonLayer = layer === "outline" || layer === "zone" || layer === "obstacle";

  return (
    <div className={"hall-editor" + (phone ? " hall-viewer" : "")}>
      <div className="hall-head">
        {!embedded && <Button small minimal icon="chevron-left" text="Grundriss" onClick={() => navigate("grundriss")} />}
        <h1 className="page-title">Halle bearbeiten <Tag intent="danger">nur Admin</Tag></h1>
        <PageInfo text={pageInfo("grundriss/admin")} />
        <FloorSwitcher topo={site.topo} current={site.current} onPick={pickFloor} always
          onAddLevel={() => setLevelOpen(true)} />
        {!phone && <Button small minimal icon="office" text="Standorte & Ebenen" onClick={() => setSitesOpen(true)} />}
        <p className="page-sub sr-only">
          Umriss, Zonen, Hindernisse, Gänge und Tore — und die Maschinenwerte, aus denen
          die Zuordnung ihre Vorschläge rechnet.
        </p>
        {!phone && <div className="hall-head-actions">
          <ButtonGroup minimal>
            <Button small icon="undo" disabled={!hist.past.length} title="Rückgängig (Strg+Z)" onClick={undo} />
            <Button small icon="redo" disabled={!hist.future.length} title="Wiederholen (Strg+Umschalt+Z)" onClick={redo} />
          </ButtonGroup>
          <Button small icon="import" text="Import / Export" onClick={() => {
            setIoText(JSON.stringify({
              name: floor.name, outline: floor.outline, zones: floor.zones,
              obstacles: floor.obstacles, doors: floor.doors, aisles: floor.aisles,
              scale: floor.scale, grid: floor.grid, snap: floor.snap, bg: floor.bg,
            }, null, 2));
            setIoOpen(true);
          }} />
          <Button small intent={dirty || hasValidDraft ? "primary" : "none"} icon="floppy-disk" loading={busy}
            disabled={!dirty && !hasValidDraft} text={dirty || hasValidDraft ? "Halle speichern" : "gespeichert"}
            aria-label={dirty || hasValidDraft ? "Halle speichern" : "gespeichert"} onClick={saveFloor} />
        </div>}
      </div>

      {phone && (
        <Callout compact intent="primary" icon="desktop" className="hall-phone-note">
          Bearbeiten braucht einen größeren Bildschirm. Hier lässt sich die Halle nur ansehen.
        </Callout>
      )}

      {/* --------------------------------------------------- Werkzeugleiste */}
      {!phone && <div className="editor-tools-wrap">
        <div className="editor-tools">
          <ButtonGroup>
            <Button small icon="hand" active={mode === "select"} text="Auswählen"
              onClick={() => { setMode("select"); setDraft([]); setDraftClosed(false); setZoneIdx(-1); setObstacleIdx(-1); setAisleAnchor(null); }} />
            <Button small icon="polygon-filter" active={mode === "draw"} text="Zeichnen"
              onClick={() => startLayer(layer)} />
            <Button small icon="widget" active={mode === "rect"} text="Rechteck"
              onClick={() => { setMode("rect"); setDraft([]); setDraftClosed(false); if (layer === "aisle" || layer === "door") setLayer("outline"); }} />
            <Button small icon="path-search" active={mode === "measure"} text="Messen"
              onClick={() => setMode("measure")} />
          </ButtonGroup>
          <span className="sep" />
          <span className="sub">Ebene:</span>
          <ButtonGroup>
            {(["outline", "zone", "obstacle", "aisle", "door"] as FloorLayer[]).map((l) => (
              <Button key={l} small active={layer === l && mode !== "select" && mode !== "measure"}
                text={LAYER_LABEL[l]}
                onClick={() => startLayer(l)} />
            ))}
          </ButtonGroup>
          <span className="sep" />
          <Button small intent="primary" icon="office" text="Hallen-Assistent" onClick={() => setCreatorOpen(true)}
            title="Komplette Halle mit Form, Maßen, Gängen, Toren, Zonen & Stationen erstellen" />
          <Button small icon="layout-grid" text="Hallenvorlage" onClick={() => setTemplateOpen(true)} />
          <Button small icon="import" text="DXF" onClick={() => setDxfOpen(true)}
            title="Umriss aus einer CAD-Zeichnung (ASCII-DXF) übernehmen" />
        </div>

        {/* Architektur- & Bauteile-Leiste: Wände, Stützen, Zäune, Türen, Tore, Treppen, Aufzüge */}
        <div className="editor-framework-bar" role="toolbar" aria-label="Bauteile und Zugänge">
          <div className="editor-fw-group">
            <span className="editor-fw-label">Struktur:</span>
            {STRUCTURAL_PRESETS.map((preset) => (
              <Tooltip key={preset.id} content={preset.hint} placement="top">
                <Button small minimal icon={preset.icon} text={preset.label}
                  onClick={() => addStructuralPreset(preset)} />
              </Tooltip>
            ))}
          </div>
          <span className="sep" />
          <div className="editor-fw-group">
            <span className="editor-fw-label">Zugänge:</span>
            {DOOR_KINDS.map((k) => (
              <Button key={k.id} small minimal icon={k.icon} text={k.label}
                active={mode === "draw" && layer === "door" && doorKind === k.id}
                title={`${k.label} (${k.width} m) — anklicken und auf eine Wand im Plan setzen`}
                onClick={() => startDoorKind(k.id)} />
            ))}
          </div>
        </div>
      </div>}

      <div className="editor-split">
        <div className="editor-main"
             onContextMenu={(e) => { if (mode !== "select" || draft.length || pathDraft) { e.preventDefault(); finishDrawing(); } }}>
          {/* Prüfleiste: was an dieser Halle noch nicht stimmt. Sichtbar und nicht
              im Log, weil ein unsichtbarer Mangel gepflegt wird wie keiner. */}
          {/* Schnellstart-Leiste, wenn noch kein Hallenumriss gezeichnet ist */}
          {(floor.outline?.length ?? 0) < 3 && draft.length < 3 && (
            <Callout intent="primary" icon="office" style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <strong>Neue Halle einrichten</strong> — Starten Sie mit dem Hallen-Assistenten (Form, Maße, Gangnetz, Tore &amp; Zonen in einem Schritt) oder zeichnen Sie direkt auf dem Plan.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button small intent="primary" icon="office" text="Hallen-Assistent öffnen" onClick={() => setCreatorOpen(true)} />
                  <Button small icon="widget" text="Rechteck 40 × 24 m setzen" onClick={() => {
                    const pts = templateRect(40, 24);
                    mutate({ outline: pts, aisles: suggestAisles(pts) });
                    setDraft(pts); setDraftClosed(true); setLayer("outline"); setMode("draw");
                  }} />
                  <Button small icon="polygon-filter" text="Frei zeichnen" onClick={() => {
                    setLayer("outline"); setMode("draw"); setDraft([]); setDraftClosed(false);
                  }} />
                  <Button small icon="import" text="DXF importieren" onClick={() => setDxfOpen(true)} />
                </div>
              </div>
            </Callout>
          )}
          <FloorIssues floor={floor} saved={saved} stations={stations} />

          <FloorPlan
            floor={floor}
            map={hallMap}
            north={site.current?.hall && (site.current.hall.lat || site.current.hall.lon) ? site.current.hall.rotation_deg : null}
            stations={stations}
            selectedId={selectedId}
            movable={!phone && mode === "select"}
            layer={drawLayer}
            draft={polygonLayer ? draft : undefined}
            draftClosed={polygonLayer && draftClosed}
            draftColour={draftColour}
            onDraftPoint={(p) => setDraft((d) => [...d, p])}
            onDraftMoveStart={() => { /* Punktzug ist lokal — Geschichte erst beim Übernehmen */ }}
            onDraftMove={(idx, p) => setDraft((d) => d.map((q, i) => (i === idx ? p : q)))}
            onDraftReplace={(pts) => setDraft(pts)}
            onDraftDelete={(idx) => setDraft((d) => {
              const next = d.filter((_, i) => i !== idx);
              if (next.length < 3) setDraftClosed(false);
              return next;
            })}
            onDraftInsert={(after, p) => setDraft((d) => [...d.slice(0, after + 1), p, ...d.slice(after + 1)])}
            onDraftFinish={finishDrawing}
            onDraftStartNew={() => { setDraft([]); setDraftClosed(false); setMode("draw"); }}
            rectMode={!phone && mode === "rect"}
            onDraftRect={(pts) => {
              if (layer === "outline") {
                mutate({ outline: pts });
                setDraft(pts);
                setDraftClosed(true);
                setMode("draw");
                toastSuccess(`Rechteck-Umriss (${polygonArea(pts).toFixed(0)} m²) gesetzt — Ecken ziehen oder direkt „Halle speichern“.`);
              } else {
                setDraft(pts);
                setDraftClosed(true);
                setMode("draw");
              }
            }}
            editingObstacleIdx={layer === "obstacle" && mode !== "select" ? obstacleIdx : -1}
            editingZoneIdx={layer === "zone" && mode !== "select" ? zoneIdx : -1}
            onObstacleClick={editObstacle}
            onZoneClick={editZone}
            measureMode={!phone && mode === "measure"}
            onAisleClick={onAisleClick}
            onAisleNodeMove={(idx, p) => setFloor((f) => ({
              ...f, aisles: { ...f.aisles, nodes: f.aisles.nodes.map((q, i) => (i === idx ? p : q)) },
            }))}
            onAisleNodeMoveStart={() => setHist((h) => ({ past: [...h.past.slice(-59), floorRef.current], future: [] }))}
            onAisleNodeDelete={deleteNode}
            onAisleEdgeDelete={deleteEdge}
            onAisleEdgeSplit={splitEdge}
            onCleanAisles={cleanNetwork}
            aisleAnchor={aisleAnchor}
            links={show.links ? links.map((l) => ({ points: l.points, kind: l.kind, ok: l.kind !== "air" && !l.far, selected: l.id === editing.id })) : []}
            pathDraft={pathDraft}
            proposal={proposal?.lines ?? null}
            onDoorClick={addDoor}
            onDoorMoveStart={() => setHist((h) => ({ past: [...h.past.slice(-59), floorRef.current], future: [] }))}
            onDoorMove={(idx, p) => setFloor((f) => ({
              ...f, doors: f.doors.map((d, i) => (i === idx ? { ...d, x: p[0], y: p[1] } : d)),
            }))}
            onDoorSelect={editDoor}
            selectedDoor={doorIdx}
            doorKind={doorKind}
            onStationClick={selectStation}
            onStationMove={moveStation}
            onStationDragEnd={(id) => commitStation(id)}
            onCanvasDoubleClick={(p) => { setEditing({ ...BLANK_STATION, x: p[0], y: p[1] }); setSelectedId(null); setTab("stationen"); }}
            ghost={ghost}
            height={null}
            editorLook
            show={show}
          />

          <div className="floor-legend">
            <KeyPopover placement="top-start" content={
              <Menu>
                {(["links", "zones", "obstacles", "aisles", "doors", "grid", "labels"] as const).map((k) => (
                  <MenuItem key={k} active={show[k]} icon={show[k] ? "eye-open" : "eye-off"} shouldDismissPopover={false}
                    text={{ links: "Anbindungen", zones: "Zonen", obstacles: "Hindernisse", aisles: "Gänge", doors: "Tore", grid: "Raster", labels: "Beschriftung" }[k]}
                    onClick={() => setShow({ ...show, [k]: !show[k] })} />
                ))}
              </Menu>
            }>
              <Button small minimal icon="eye-open" text="Anzeige" title="Ebenen und Hilfen ein- oder ausblenden" />
            </KeyPopover>
            {show.links && (
              <span className="link-legend sub" aria-label="Legende der Anbindungen">
                {([["manual", "von Hand", ""], ["auto", "automatisch", "6 3.5"], ["air", "Luftlinie", "1.5 3.5"]] as const).map(([k, t, d]) => (
                  <span key={k} className="link-legend-item">
                    <svg width="28" height="8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" stroke={k === "air" ? "var(--g-floor-error)" : "currentColor"}
                      strokeWidth="2.2" strokeLinecap="round" strokeDasharray={d || undefined} /></svg> {t}
                  </span>
                ))}
              </span>
            )}
            {!phone && <span className="editor-keys sub">Strg+Z rückgängig · Esc oder Rechtsklick: Zeichnen beenden und übernehmen</span>}
          </div>
          {proposal && (
            <Callout compact intent={proposal.failed.length ? "warning" : "primary"} icon="route" className="path-proposal" data-testid="path-proposal">
              <b>Vorschlag des Pfadfinders:</b>{" "}
              {proposal.done.length ? `${plural(proposal.done.length, "Station", "Stationen")} angebunden (${proposal.done.slice(0, 4).join(", ")}${proposal.done.length > 4 ? " …" : ""}), +${fmtM(proposal.lines.reduce((a, [p, q]) => a + Math.hypot(p[0] - q[0], p[1] - q[1]), 0))} Gang. ` : "Keine Station ließ sich anbinden. "}
              {proposal.failed.length > 0 && <>Kein Weg gefunden für {proposal.failed.slice(0, 4).join(", ")} — Hindernis rundum oder Station außerhalb. </>}
              Gestrichelt in der Vorschau; erst „Übernehmen“ ändert den Plan.
              <div style={{ marginTop: 6 }}>
                <Button small intent="primary" icon="tick" text="Übernehmen" onClick={acceptProposal} disabled={!proposal.done.length} />{" "}
                <Button small minimal icon="cross" text="Verwerfen" onClick={() => setProposal(null)} />
              </div>
            </Callout>
          )}
        </div>

        {/* ------------------------------------------------- Rechte Leiste */}
        {phone ? (
          <HallSummary floor={floor} stations={stations} selectedId={selectedId} onPick={selectStation} />
        ) : <div className="editor-rail">
            {mode !== "select" && mode !== "measure" && (() => {
              const selfInt = polygonLayer && draft.length >= 4 && polygonSelfIntersects(draft);
              const rectInfo = polygonLayer ? rectDimensions(draft) : null;
              return (
              <Card className="draw-card">
                <div className="card-title-row">
                  <h2 className="card-title">
                    {LAYER_LABEL[layer]}
                    {polygonLayer && ` — ${plural(draft.length, "Punkt", "Punkte")}`}
                    {layer === "aisle" && ` — ${floor.aisles?.nodes?.length ?? 0} Knoten, ${floor.aisles?.edges?.length ?? 0} Kanten`}
                    {layer === "door" && ` — ${floor.doors?.length ?? 0} Zugänge`}
                  </h2>
                  <span className="sub">
                    {polygonLayer && draft.length >= 3 && (
                      <>Fläche ≈ <b>{polygonArea(draft).toLocaleString("de-DE", { maximumFractionDigits: 1 })} m²</b>
                        {" "}· Umfang ≈ {polygonPerimeter(draft).toLocaleString("de-DE", { maximumFractionDigits: 1 })} m
                        {selfInt && <b style={{ color: "var(--g-danger-ink)" }}> · schneidet sich selbst!</b>}
                      </>
                    )}
                    {layer === "aisle" && <>Gesamtlänge ≈ <b>{fmtM(aisleLength(floor.aisles))}</b> — die Strecke, mit der die Zuordnung rechnet.</>}
                  </span>
                </div>

                <div className="draw-actions">
                  {polygonLayer && (
                    <>
                      {(layer === "zone" || layer === "obstacle") && (
                        <>
                          <InputGroup className="draw-name" value={draftName}
                            aria-label={layer === "zone" ? "Name der Zone" : "Name des Hindernisses"}
                            placeholder={layer === "zone" ? "Name der Zone" : "Name des Bauteils"}
                            onChange={(e) => setDraftName(e.target.value)} />
                          {layer === "zone" && (
                            <HTMLSelect aria-label="Art der Zone" value={draftKind} onChange={(e) => setDraftKind(e.currentTarget.value)}>
                              {ZONE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                            </HTMLSelect>
                          )}
                          {layer === "obstacle" && (
                            <>
                              <HTMLSelect aria-label="Art des Bauteils" value={draftObstacleKind || "obstacle"}
                                onChange={(e) => {
                                  const nextKind = e.currentTarget.value;
                                  setDraftObstacleKind(nextKind);
                                  setDraftHeightM(obstacleHeight({ name: draftName, kind: nextKind }, floor.height_m || 6));
                                }}>
                                {STRUCTURAL_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                                <option value="obstacle">Sonstiges Hindernis</option>
                              </HTMLSelect>
                              <NumericInput className="draw-num" aria-label="Höhe (m)" title="Höhe in Metern (Semi-3D / 3D)"
                                value={draftHeightM ?? obstacleHeight({ name: draftName, kind: draftObstacleKind || undefined }, floor.height_m || 6)}
                                min={0.2} max={Math.max(6, floor.height_m || 6)} stepSize={0.25} minorStepSize={0.1}
                                onValueChange={(v) => { if (Number.isFinite(v)) setDraftHeightM(Math.max(0.2, Math.min(Math.max(6, floor.height_m || 6), v))); }} />
                            </>
                          )}
                        </>
                      )}
                      {draft.length >= 3 && (
                        <div className="draw-transform-row">
                          <ButtonGroup minimal>
                            <Button small icon="undo" text="-90°" title="90° gegen den Uhrzeigersinn drehen"
                              onClick={() => setDraft((d) => rotatePolygon(d, -90))} />
                            <Button small text="-15°" title="15° gegen den Uhrzeigersinn (Umschalt+R)"
                              onClick={() => setDraft((d) => rotatePolygon(d, -15))} />
                            <Button small text="+15°" title="15° im Uhrzeigersinn (R)"
                              onClick={() => setDraft((d) => rotatePolygon(d, 15))} />
                            <Button small icon="redo" text="+90°" title="90° im Uhrzeigersinn drehen"
                              onClick={() => setDraft((d) => rotatePolygon(d, 90))} />
                          </ButtonGroup>
                          {rectInfo && (
                            <div className="draw-rect-dims">
                              <label className="sub">L (m)
                                <NumericInput small className="draw-dim-num" aria-label="Länge (m)" buttonPosition="none"
                                  value={rectInfo.w} min={0.1} stepSize={0.25}
                                  onValueChange={(v) => { if (Number.isFinite(v) && v >= 0.1) setDraft((d) => resizeRectPolygon(d, v, rectInfo.d)); }} />
                              </label>
                              <label className="sub">B (m)
                                <NumericInput small className="draw-dim-num" aria-label="Breite (m)" buttonPosition="none"
                                  value={rectInfo.d} min={0.1} stepSize={0.05}
                                  onValueChange={(v) => { if (Number.isFinite(v) && v >= 0.1) setDraft((d) => resizeRectPolygon(d, rectInfo.w, v)); }} />
                              </label>
                            </div>
                          )}
                        </div>
                      )}
                      {!draftClosed && (
                        <Button small icon="small-minus" disabled={!draft.length} text="Letzten Punkt"
                          onClick={() => setDraft(draft.slice(0, -1))} />
                      )}
                      <Button small icon="disable" disabled={!draft.length} text="Leeren"
                        onClick={() => { setDraft([]); setDraftClosed(false); }} />
                      {layer === "outline" && (
                        <>
                          <Button small icon="swap-horizontal" disabled={draft.length < 3} text="Rechtwinklig"
                            title="Jeden freien Punkt zur Rechtwinkel-Stufe glätten — für Hallen ohne Schrägwand"
                            onClick={orthogonalize} />
                          <Button small intent="danger" icon="trash" text="Umriss löschen"
                            disabled={!(floor.outline?.length ?? 0)}
                            title="Den vorhandenen Hallenumriss entfernen — Speichern macht es endgültig"
                            onClick={deleteOutline} />
                        </>
                      )}
                      {!draftClosed && <ExactPoint onAdd={(p) => setDraft([...draft, p])} />}
                      {(zoneIdx >= 0 || obstacleIdx >= 0) && (
                        <>
                          <Button small minimal icon="cross" text="Abbrechen"
                            onClick={() => { setDraft([]); setDraftClosed(false); setZoneIdx(-1); setObstacleIdx(-1); setMode("select"); }} />
                          <Button small intent="danger" icon="trash" text="Löschen"
                            onClick={() => {
                              if (layer === "zone" && zoneIdx >= 0) {
                                mutate({ zones: floor.zones.filter((_, k) => k !== zoneIdx) });
                                setZoneIdx(-1);
                              } else if (layer === "obstacle" && obstacleIdx >= 0) {
                                mutate({ obstacles: floor.obstacles.filter((_, k) => k !== obstacleIdx) });
                                setObstacleIdx(-1);
                              }
                              setDraft([]); setDraftClosed(false); setMode("select");
                            }} />
                        </>
                      )}
                      <Button small intent="primary" icon="tick" disabled={draft.length < 3 || selfInt}
                        title={selfInt ? "Selbstschneidendes Polygon kann nicht übernommen werden." : undefined}
                        text={layer === "outline" ? "Umriss übernehmen"
                          : zoneIdx >= 0 || obstacleIdx >= 0 ? "Änderung übernehmen" : "Anlegen"}
                        onClick={() => { commitDraft(); }} />
                    </>
                  )}
                  {layer === "aisle" && (
                    <>
                      <Button small icon="new-link" text="Neue Linie beginnen" disabled={aisleAnchor == null}
                        onClick={() => setAisleAnchor(null)}
                        title="Der nächste Klick fängt einen neuen Gangzug an, statt am letzten Knoten weiterzugehen." />
                      <Button small icon="predictive-analysis" text="Mittelgang vorschlagen" onClick={suggestNetwork} />
                      <Button small icon="route" text="Pfadfinder: alle Stationen anbinden" onClick={() => runPathfinder()}
                        title="Rechnet Wege um Hindernisse innerhalb der Halle und schlägt neue Gänge vor — nichts wird ohne „Übernehmen“ geändert." />
                      <Button small icon="clean" text="Netz aufräumen" onClick={cleanNetwork}
                        title="Doppelte Knoten und Kanten sowie unnötige Zwischenknoten entfernen — Wege bleiben gleich lang." />
                      {pathDraft && (
                        <>
                          <Button small intent="primary" icon="tick" text={`Pfad übernehmen (${pathDraft.length - 1})`} onClick={finishPath} disabled={pathDraft.length < 2} />
                          <Button small icon="undo" text="Letzter Punkt" disabled={pathDraft.length < 2} onClick={() => setPathDraft(pathDraft.slice(0, -1))} />
                          <Button small minimal icon="cross" text="Pfad abbrechen" onClick={() => setPathDraft(null)} />
                        </>
                      )}
                      <Button small icon="disable" text="Gänge leeren" disabled={!floor.aisles?.nodes?.length}
                        onClick={() => { mutate({ aisles: { nodes: [], edges: [], paths: floor.aisles?.paths } }); setAisleAnchor(null); }} />
                      <span className="sub">
                        Ohne Gangnetz rechnet die Zuordnung mit Luftlinie — und sagt es überall dazu.
                      </span>
                    </>
                  )}
                  {layer === "door" && (
                    <>
                      <span className="sub">Neu setzen als:</span>
                      <HTMLSelect value={doorKind} onChange={(e) => setDoorKind(e.currentTarget.value)} aria-label="Art für neuen Zugang">
                        {DOOR_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label} ({k.width} m)</option>)}
                      </HTMLSelect>
                      <span className="sub">Klick auf eine Wand im Plan setzt den Zugang.</span>
                      {doorIdx != null && floor.doors?.[doorIdx] && (
                        <div className="draw-door-edit">
                          <InputGroup className="draw-name" aria-label="Name des Zugangs" value={floor.doors[doorIdx].name}
                            onChange={(e) => patchDoor(doorIdx, { name: e.target.value })} placeholder="Name" />
                          <HTMLSelect aria-label="Art des Zugangs" value={effectiveDoorKind(floor.doors[doorIdx])}
                            onChange={(e) => patchDoor(doorIdx, { kind: e.currentTarget.value })}>
                            {DOOR_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                          </HTMLSelect>
                          <NumericInput className="draw-num" aria-label="Breite (m)" value={floor.doors[doorIdx].width} min={0.5} stepSize={0.25}
                            onValueChange={(v) => { if (Number.isFinite(v)) patchDoor(doorIdx, { width: Math.max(0.5, v) }); }} />
                          <Button small intent="danger" icon="trash" text="Löschen"
                            onClick={() => { mutate({ doors: floor.doors.filter((_, i) => i !== doorIdx) }); setDoorIdx(null); }} />
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Punkteliste — dieselben Punkte wie im Plan, nur als Zahl. Wer nach
                    Schema-Maßen baut, tippt hier, statt zu ziehen; wer zieht, liest
                    hier nach, was daraus wurde. */}
                {polygonLayer && draft.length > 0 && (
                  <DraftPoints
                    points={draft}
                    onChange={(pts) => setDraft(pts)}
                  />
                )}
              </Card>
              );
            })()}
          <Tabs id="floor-rail" selectedTabId={tab} onChange={(t) => setTab(String(t))}>
            <Tab id="halle" title="Halle" panel={
              <div className="rail-panel">
                <RailSection title="Grundeinstellungen" defaultOpen>
                  <div className="form-grid">
                    <FormGroup label="Name der Halle">
                      <InputGroup aria-label="Name der Halle" value={floor.name} onChange={(e) => mutate({ name: e.target.value })} />
                    </FormGroup>
                    <FormGroup label="Fangweite (m)" helperText="Raster, auf das Punkte einrasten">
                      <NumericInput aria-label="Fangweite (m)" fill value={floor.snap} min={0.05} max={2} stepSize={0.05} minorStepSize={0.01}
                        clampValueOnBlur
                        onValueChange={(v) => { if (Number.isFinite(v)) mutate({ snap: Math.max(0.05, Math.min(2, v)) }); }} />
                    </FormGroup>
                    <FormGroup label="Rasterweite (m)">
                      <NumericInput aria-label="Rasterweite (m)" fill value={floor.grid} min={0.25} max={10} stepSize={0.25}
                        clampValueOnBlur
                        onValueChange={(v) => { if (Number.isFinite(v)) mutate({ grid: Math.max(0.25, Math.min(10, v)) }); }} />
                    </FormGroup>
                  </div>
                  <dl className="kv">
                    <dt>Fläche</dt><dd>{polygonArea(floor.outline ?? []).toLocaleString("de-DE", { maximumFractionDigits: 1 })} m²</dd>
                    <dt>Umfang</dt><dd>{polygonPerimeter(floor.outline ?? []).toLocaleString("de-DE", { maximumFractionDigits: 1 })} m</dd>
                    <dt>Gänge</dt><dd>{fmtM(aisleLength(floor.aisles))}</dd>
                    <dt>Zonen / Hindernisse</dt><dd>{floor.zones?.length ?? 0} / {floor.obstacles?.length ?? 0}</dd>
                  </dl>
                </RailSection>

                <RailSection title={`Zonen (${floor.zones?.length ?? 0})`}>
                  <HTMLTable compact interactive className="data-table">
                    <tbody>
                      {(floor.zones ?? []).map((z, i) => (
                        <tr key={i} className={layer === "zone" && zoneIdx === i ? "row-active" : undefined} onClick={() => editZone(i)}>
                          <td><span className="station-dot" style={{ background: z.colour }} /> {z.name || "Zone"}</td>
                          <td className="num">{polygonArea(z.points).toLocaleString("de-DE", { maximumFractionDigits: 0 })} m²</td>
                          <td><Button aria-label="Zone löschen" small minimal icon="trash" onClick={(e) => {
                            e.stopPropagation();
                            mutate({ zones: floor.zones.filter((_, k) => k !== i) });
                            if (zoneIdx === i) { setZoneIdx(-1); setDraft([]); setDraftClosed(false); }
                            else if (zoneIdx > i) setZoneIdx(zoneIdx - 1);
                          }} /></td>
                        </tr>
                      ))}
                      {!(floor.zones ?? []).length && <tr><td className="sub">Noch keine Zone — Ebene „Zone" wählen und zeichnen.</td></tr>}
                    </tbody>
                  </HTMLTable>
                </RailSection>

                <RailSection title={`Hindernisse & Wände (${floor.obstacles?.length ?? 0})`}>
                  <HTMLTable compact interactive className="data-table">
                    <tbody>
                      {(floor.obstacles ?? []).map((o, i) => {
                        const kindMeta = STRUCTURAL_PRESETS.find((p) => p.id === obstacleKind(o));
                        return (
                          <tr key={i} className={layer === "obstacle" && obstacleIdx === i ? "row-active" : undefined} onClick={() => editObstacle(i)}>
                            <td>
                              {o.name || "Hindernis"}{" "}
                              {kindMeta && <Tag minimal>{kindMeta.label}</Tag>}
                            </td>
                            <td className="num">{polygonArea(o.points).toLocaleString("de-DE", { maximumFractionDigits: 1 })} m²</td>
                            <td><Button aria-label="Hindernis löschen" small minimal icon="trash" onClick={(e) => {
                              e.stopPropagation();
                              mutate({ obstacles: floor.obstacles.filter((_, k) => k !== i) });
                              if (obstacleIdx === i) { setObstacleIdx(-1); setDraft([]); setDraftClosed(false); }
                              else if (obstacleIdx > i) setObstacleIdx(obstacleIdx - 1);
                            }} /></td>
                          </tr>
                        );
                      })}
                      {!(floor.obstacles ?? []).length && <tr><td className="sub">Keine Wände oder Hindernisse erfasst.</td></tr>}
                    </tbody>
                  </HTMLTable>
                </RailSection>

                <RailSection title={`Türen, Treppen & Aufzüge (${floor.doors?.length ?? 0})`}>
                  <HTMLTable compact interactive className="data-table">
                    <tbody>
                      {(floor.doors ?? []).map((d, i) => {
                        const effKind = effectiveDoorKind(d);
                        const kindMeta = DOOR_KINDS.find((k) => k.id === effKind);
                        return (
                          <tr key={i} className={doorIdx === i ? "row-active" : undefined} onClick={() => editDoor(i)}>
                            <td>
                              {d.name || kindMeta?.label || "Zugang"}{" "}
                              <Tag minimal>{kindMeta?.label ?? effKind}</Tag>
                            </td>
                            <td className="num mono">{(d.width || 2.5).toLocaleString("de-DE", { maximumFractionDigits: 1 })} m</td>
                            <td><Button aria-label="Zugang löschen" small minimal icon="trash" onClick={(e) => {
                              e.stopPropagation();
                              mutate({ doors: floor.doors.filter((_, k) => k !== i) });
                              if (doorIdx === i) setDoorIdx(null);
                              else if (doorIdx != null && doorIdx > i) setDoorIdx(doorIdx - 1);
                            }} /></td>
                          </tr>
                        );
                      })}
                      {!(floor.doors ?? []).length && <tr><td className="sub">Noch keine Türen, Tore, Treppen oder Aufzüge.</td></tr>}
                    </tbody>
                  </HTMLTable>
                </RailSection>

                <RailSection title="Betriebsschalter">
                  <Checkbox checked={allForAll}
                    onChange={() => toggleSetting("all_for_all", !allForAll, setAllForAll)}
                    label="All-for-all — jede Station sieht jeden Auftrag" />
                  <Checkbox checked={autoRouting}
                    onChange={() => toggleSetting("auto_routing", !autoRouting, setAutoRouting)}
                    label="Automatische Maschinenzuordnung" />
                  <Checkbox checked={feedEmpty}
                    disabled={!autoRouting}
                    onChange={() => toggleSetting("feed_empty", !feedEmpty, setFeedEmpty)}
                    label="Nachschub — leere Maschinen füllen, solange Arbeit wartet" />
                  <p className="sub">
                    Der Hauptschalter wirkt nur auf Stationen, die auf „Smart — automatisch"
                    stehen. Alles andere bleibt Vorschlag, und „Pull" bleibt unberührt.
                    Voreinstellung ist <b>aus</b>: eine Halle, deren Maschinenwerte noch
                    niemand eingetragen hat, soll nicht anfangen zu planen.
                  </p>
                  <p className="sub">
                    Der Nachschub ist die Regel des Betriebs: eine Maschine, die
                    fertig ist, bekommt den am besten passenden offenen Innenauftrag,
                    solange einer da ist, der sie vertragen kann — ein Stück pro
                    Takt, nie die ganze Planung auf einmal. Stationen auf „Pull"
                    werden nie von selbst gefüllt.
                  </p>
                </RailSection>

                <RailSection title="Umriss aufbauen">
                  <p className="sub">
                    Zeichnen, Vorlage, DXF aus dem CAD — oder ein Rahmen um die Stationen,
                    der dann an die echte Halle angepasst wird.
                  </p>
                  <div className="editor-actions" style={{ marginBottom: 8 }}>
                    <Button small icon="import" text="DXF importieren" onClick={() => setDxfOpen(true)}
                      title="Die größte geschlossene Kontur aus einer ASCII-DXF-Zeichnung übernehmen" />
                    <Button small icon="widget" text="Aus Stationen ableiten"
                      disabled={!stations.length} onClick={outlineFromStations} />
                  </div>
                  <p className="sub">
                    Nach dem Import liegen die Punkte als Entwurf vor: ziehen, prüfen,
                    übernehmen — und erst „Halle speichern" macht es endgültig.
                  </p>
                </RailSection>

                <RailSection title="Zurücksetzen">
                  <div className="editor-actions">
                    <Button small icon="trash" text="Nur Umriss löschen" disabled={!(floor.outline?.length ?? 0)}
                      onClick={deleteOutline}
                      title="Den Hallenumriss entfernen — Zonen, Gänge, Tore und Stationen bleiben" />
                    <Button small intent="danger" icon="warning-sign" text="Neu anfangen"
                      onClick={resetHall}
                      title="Umriss, Zonen, Hindernisse, Gänge und Tore leeren — Stationen bleiben" />
                  </div>
                  <p className="sub">
                    Beides geht erst beim Speichern verloren, und Strg+Z holt es zurück.
                    Die Stationen werden von „Neu anfangen" nie berührt — sie hängen an
                    Innenaufträgen und ihren Warteschlangen.
                  </p>
                </RailSection>
              </div>
            } />

            <Tab id="stationen" title={`Stationen (${stations.length})`} panel={
              <div className="rail-panel">
                <RailSection title="Stationen" defaultOpen>
                  <div className="editor-palette">
                    <Button small icon="add" text="Neu"
                      onClick={() => { setEditing({ ...BLANK_STATION }); setSelectedId(null); }} />
                    {ALL_TYPES.map((t) => (
                      <Button key={t} small icon="add" text={TYPE_LABEL[t]} onClick={() => addStation(t)}
                        title={`${TYPE_LABEL[t]} (${TYPE_DEFAULT_SIZE[t].w} × ${TYPE_DEFAULT_SIZE[t].h} m) anlegen`} />
                    ))}
                  </div>
                  <div className="hall-station-list"><HTMLTable compact interactive className="data-table">
                    <thead><tr><th>Station</th><th className="num">Schlange</th><th><span className="sr-only">Aktion</span></th></tr></thead>
                    <tbody>
                      {stations.map((s) => (
                        <tr key={s.id} className={s.id === selectedId ? "row-active" : undefined}
                            onClick={() => selectStation(s)}>
                          <td>
                            <span className="station-dot" style={{ background: s.colour }} /> {s.label}
                            {s.is_storage && <Tag minimal>Lager</Tag>}
                            {!s.active && <Tag minimal>inaktiv</Tag>}
                          </td>
                          <td className="num mono">{s.queue_min ? fmtMin(s.queue_min) : "—"}</td>
                          <td>
                            <Button small minimal icon="link" title="Link kopieren"
                              onClick={(e) => { e.stopPropagation(); s.id != null && copyLink(s.id); }} />
                          </td>
                        </tr>
                      ))}
                      {!stations.length && <tr><td colSpan={3} className="sub">Noch keine Stationen.</td></tr>}
                    </tbody>
                  </HTMLTable></div>
                </RailSection>

                <StationForm
                  floorChoices={allFloors(site.topo).map((r) => ({ value: r.floor.id, label: floorLabel(r, (site.topo?.sites.length ?? 0) > 1) }))}
                  currentFloor={floor.id}
                  editing={editing} setEditing={setEditing} products={products} users={users}
                  thicknessChoices={thicknessChoices} gaps={gaps} supply={supplyPreview}
                  link={stationLink} onConnect={connectEditing}
                  path={pathOf(editing.id)} pathWarning={links.find((l) => l.id === editing.id)?.warning ?? ""}
                  onPathDraw={startPath} onPathDelete={() => editing.id && deletePath(editing.id)}
                  onPathPop={() => editing.id && popPathPoint(editing.id)} onPathPin={() => editing.id && pinPath(editing.id)}
                  onPathOptimize={() => editing.id && optimizePath(editing.id)}
                  onPathfind={() => runPathfinder(editing)}
                  onUploadModel={uploadModel} onRemoveModel={removeModel} modelBusy={modelBusy}
                  pendingModel={pendingModel} onClearPending={() => setPendingModel(null)}
                  busy={busy} onSave={saveStation} onDelete={deleteStation}
                  onDuplicate={duplicateStation} onRotate={rotateEditing}
                  onPreset={applyPreset}
                  onNew={() => { setEditing({ ...BLANK_STATION }); setSelectedId(null); }}
                  onCopyLink={() => editing.id != null && copyLink(editing.id)} />
              </div>
            } />
          </Tabs>
        </div>}
      </div>

      {/* --------------------------------------------------- Hallenvorlagen */}
      {newType && (
        <NewStationDialog key={newType} type={newType} blank={blankOf(newType)} busy={busy}
          onClose={() => setNewType(null)}
          onCreate={async (st, file) => { const made = await createStation(st, file); if (made) setNewType(null); }} />
      )}

      <HallCreatorDialog
        isOpen={creatorOpen}
        onClose={() => setCreatorOpen(false)}
        topo={site.topo}
        currentFloor={floor}
        onApplied={async (savedFloor) => {
          setSaved(savedFloor);
          setFloor(savedFloor);
          setDraft([]);
          setDraftClosed(false);
          setHist({ past: [], future: [] });
          await site.reload();
          if (savedFloor.id) site.setFloorId(savedFloor.id);
          await load();
          onSaved?.(savedFloor);
        }}
        onOpenDraftInEditor={(plan: GeneratedHallPlan) => {
          mutate({
            name: plan.name,
            height_m: plan.height_m,
            grid: plan.grid,
            snap: plan.snap,
            outline: plan.outline,
            zones: plan.zones,
            obstacles: plan.obstacles,
            doors: plan.doors,
            aisles: plan.aisles,
          });
          setLayer("outline");
          setMode("draw");
          setDraft(plan.outline);
          setDraftClosed(true);
          toastSuccess("Hallenentwurf geladen — Ecken anpassen und „Halle speichern“ klicken.");
        }}
      />
      <SitesDialog isOpen={sitesOpen} onClose={() => setSitesOpen(false)} topo={site.topo} current={site.current}
        floor={floor} onChanged={async (fid) => { await site.reload(); if (fid) site.setFloorId(fid); }} />
      <LevelDialog isOpen={levelOpen} hall={site.current?.hall ?? null}
        floors={site.current?.hall?.floors ?? []}
        onClose={() => setLevelOpen(false)}
        onCreated={async (id) => { setLevelOpen(false); await site.reload(); site.setFloorId(id); }}
        onDeleted={async (id) => {
          if (id === site.floorId) site.setFloorId(null);
          await site.reload();
        }} />
      <Dialog isOpen={templateOpen} onClose={() => setTemplateOpen(false)} title="Hallenvorlage" icon="layout-grid"
              style={{ width: 520 }}>
        <TemplateDialog onPick={(pts) => {
          mutate({ outline: pts });
          setDraft(pts); setDraftClosed(true); setLayer("outline"); setMode("draw"); setTemplateOpen(false);
          toastSuccess("Vorlage eingesetzt — Punkte lassen sich jetzt ziehen.");
        }} />
      </Dialog>

      {/* --------------------------------------------------- DXF-Import */}
      <Dialog isOpen={dxfOpen} onClose={() => setDxfOpen(false)} title="Umriss aus DXF" icon="import"
              style={{ width: 520 }}>
        <DxfImportDialog busy={busy} onImport={importDxf} onClose={() => setDxfOpen(false)} />
      </Dialog>

      {/* --------------------------------------------------- Import / Export */}
      <Dialog isOpen={ioOpen} onClose={() => setIoOpen(false)} style={{ width: 640 }}
              title="Halle als JSON" icon="import">
        <DialogBody>
          <p className="sub">
            Der ganze Grundriss als Text — zum Sichern, Weitergeben oder Zurückspielen.
            Stationen sind <b>nicht</b> enthalten: sie hängen an Aufträgen und Warteschlangen
            und würden beim Zurückspielen doppelt entstehen.
          </p>
          <TextArea fill rows={16} value={ioText} onChange={(e) => setIoText(e.target.value)}
            style={{ fontFamily: "var(--mono, monospace)", fontSize: 12 }} />
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Schließen" onClick={() => setIoOpen(false)} />
            <Button icon="clipboard" text="Kopieren" onClick={async () => {
              if (await copyToClipboard(ioText)) toastSuccess("In die Zwischenablage kopiert.");
            }} />
            <Button intent="primary" icon="import" text="Einspielen" onClick={() => {
              try {
                const parsed = JSON.parse(ioText);
                if (!Array.isArray(parsed.outline)) throw new Error("Kein Umriss im JSON.");
                mutate({
                  name: parsed.name ?? floor.name,
                  outline: parsed.outline, zones: parsed.zones ?? [],
                  obstacles: parsed.obstacles ?? [], doors: parsed.doors ?? [],
                  aisles: parsed.aisles ?? { nodes: [], edges: [] },
                  scale: parsed.scale ?? floor.scale, grid: parsed.grid ?? floor.grid,
                  snap: parsed.snap ?? floor.snap, bg: parsed.bg ?? floor.bg,
                });
                setIoOpen(false);
                toastSuccess("Eingespielt — noch nicht gespeichert.");
              } catch (e: any) {
                toastError(`JSON nicht lesbar: ${e.message}`);
              }
            }} />
          </>} />
      </Dialog>
    </div>
  );
}

/** Aufklappbarer Abschnitt der rechten Leiste. */
function RailSection({ title, defaultOpen = false, note, children }: {
  title: string; defaultOpen?: boolean; note?: string; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rail-section">
      <h2 className="rail-section-title">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon icon={open ? "chevron-down" : "chevron-right"} size={14} />
          <span>{title}</span>
          {note && <span className="rail-section-note">{note}</span>}
        </button>
      </h2>
      {open && <div className="rail-section-body">{children}</div>}
    </section>
  );
}

/** Die Halle am Telefon: Kennzahlen und Stationen zum Ansehen, nichts zum Ändern. */
function HallSummary({ floor, stations, selectedId, onPick }: {
  floor: Floor; stations: Station[]; selectedId: number | null; onPick: (s: Station) => void;
}) {
  const picked = stations.find((s) => s.id === selectedId);
  return (
    <div className="hall-summary">
      <dl className="kv">
        <dt>Fläche</dt><dd>{polygonArea(floor.outline ?? []).toLocaleString("de-DE", { maximumFractionDigits: 1 })} m²</dd>
        <dt>Umfang</dt><dd>{polygonPerimeter(floor.outline ?? []).toLocaleString("de-DE", { maximumFractionDigits: 1 })} m</dd>
        <dt>Gänge</dt><dd>{fmtM(aisleLength(floor.aisles))}</dd>
        <dt>Zonen / Hindernisse</dt><dd>{floor.zones?.length ?? 0} / {floor.obstacles?.length ?? 0}</dd>
      </dl>
      {picked && (
        <p className="hall-summary-picked" role="status">
          <b>{picked.label}</b> · {TYPE_LABEL[picked.type]}{picked.active ? "" : " · inaktiv"}
          {picked.queue_min ? ` · Schlange ${fmtMin(picked.queue_min)}` : ""}
        </p>
      )}
      <ul className="hall-summary-list" aria-label="Stationen">
        {stations.map((s) => (
          <li key={s.id}>
            <button type="button" aria-pressed={s.id === selectedId} onClick={() => onPick(s)}>
              <span className="station-dot" style={{ background: s.colour }} /> {s.label}
              <span className="sub">{s.queue_min ? fmtMin(s.queue_min) : "—"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function aisleLength(a: Aisles | undefined): number {
  if (!a?.nodes?.length) return 0;
  return (a.edges ?? []).reduce((sum, [i, j]) => {
    const p = a.nodes[i], q = a.nodes[j];
    return p && q ? sum + Math.hypot(q[0] - p[0], q[1] - p[1]) : sum;
  }, 0);
}

/* -------------------------------------------------------------------------- */

function FloorIssues({ floor, saved, stations }: {
  floor: Floor; saved: Floor | null; stations: Station[];
}) {
  const issues: { text: string; intent: "warning" | "danger" | "primary" }[] = [];
  if ((floor.outline?.length ?? 0) < 3) {
    issues.push({ text: "Kein Hallenumriss — ohne ihn gibt es kein Bezugsmaß für „weit weg“.", intent: "danger" });
  } else if (polygonSelfIntersects(floor.outline)) {
    issues.push({ text: "Der Umriss schneidet sich selbst — Fläche und Wege stimmen dann nicht.", intent: "danger" });
  }
  if (!(floor.aisles?.edges?.length)) {
    issues.push({
      text: "Kein Gangnetz — die Zuordnung rechnet Entfernungen als Luftlinie und weist das überall aus.",
      intent: "warning",
    });
  } else {
    /* Gänge ↔ Objekte: eine Station, die das Netz nicht erreicht — weit weg
       oder nur durch ein Hindernis — rechnet mit Luftlinie, obwohl „über
       Gänge“ versprochen wird. Das gehört in die Prüfleiste, solange
       gezeichnet wird, nicht erst in der Zuordnung. */
    const far: string[] = [], blockedSt: string[] = [];
    const comps = aisleComponents(floor.aisles);
    const islands = new Map<number, string[]>();
    for (const s of stations) {
      if (!s.active) continue;
      const stub = aisleStub([s.x, s.y], floor.aisles, floor.obstacles ?? [], floor.outline ?? []);
      if (stub.blocked) blockedSt.push(`„${s.label}“`);
      else if (stub.dist > STUB_MAX_M) far.push(`„${s.label}“ (${fmtM(stub.dist)})`);
      else if (stub.idx >= 0) {
        const c = comps[stub.idx] ?? -1;
        islands.set(c, [...(islands.get(c) ?? []), s.label]);
      }
    }
    /* Inseln: zwei Stationen am Netz, aber nicht am selben — zwischen ihnen
       rechnet nichts über die Gänge, und das fällt sonst erst auf, wenn ein
       „über Gänge“ behaupteter Weg Luftlinie wird. */
    if (islands.size > 1) {
      const groups = [...islands.values()].sort((a, b) => b.length - a.length);
      issues.push({
        text: `Das Gangnetz zerfällt in Inseln — zwischen „${groups[0][0]}“ und `
          + `„${groups[1][0]}“ rechnet nichts über die Gänge. Die Knoten verbinden.`,
        intent: "warning",
      });
    }
    if (blockedSt.length) {
      issues.push({
        text: `Kein freier Stichweg ans Gangnetz: ${blockedSt.join(", ")} — `
          + "der Gang endet hinter einem Hindernis oder außerhalb der Halle. Knoten vor die Station setzen.",
        intent: "warning",
      });
    }
    if (far.length) {
      issues.push({
        text: `Das Gangnetz erreicht ${far.join(", ")} nicht — ein Klick mit dem `
          + "Gang-Werkzeug nahe der Station setzt den Knoten auf sie.",
        intent: "warning",
      });
    }
  }
  if (!stations.some((s) => s.is_storage && s.active)) {
    issues.push({ text: "Kein Lager markiert — der Weg-zum-Lager-Faktor kann nichts messen.", intent: "warning" });
  }
  const noData = stations.filter((s) => s.type === "production" && s.active && missingMachineData(s).length);
  if (noData.length) {
    issues.push({
      text: `${plural(noData.length, "Fertigungsstation", "Fertigungsstationen")} ohne vollständige Maschinenwerte `
        + `(${noData.slice(0, 3).map((s) => s.label).join(", ")}${noData.length > 3 ? " …" : ""}) — `
        + "die betroffenen Faktoren bleiben stumm, statt zu raten.",
      intent: "warning",
    });
  }
  if (saved && JSON.stringify(saved.outline) !== JSON.stringify(floor.outline)) {
    issues.push({ text: "Der Umriss ist geändert und noch nicht gespeichert.", intent: "primary" });
  }
  if (!issues.length) return null;
  return (
    <div className="floor-issues" role="region" aria-label="Prüfhinweise" tabIndex={0}>
      {issues.map((i, k) => (
        <Callout key={k} intent={i.intent} compact
          icon={i.intent === "danger" ? "error" : i.intent === "warning" ? "warning-sign" : "info-sign"}>
          {i.text}
        </Callout>
      ))}
    </div>
  );
}

function ExactPoint({ onAdd }: { onAdd: (p: [number, number]) => void }) {
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  const go = () => {
    const px = Number(x.trim().replace(",", "."));
    const py = Number(y.trim().replace(",", "."));
    if (!Number.isFinite(px) || !Number.isFinite(py)) { toastError("x und y als Zahl angeben."); return; }
    onAdd([px, py]);
    setX(""); setY("");
  };
  return (
    <>
      <InputGroup className="draw-num" value={x} onChange={(e) => setX(e.target.value)}
        placeholder="x (m)" inputMode="decimal"
        onKeyDown={(e) => e.key === "Enter" && go()} />
      <InputGroup className="draw-num" value={y} onChange={(e) => setY(e.target.value)}
        placeholder="y (m)" inputMode="decimal"
        onKeyDown={(e) => e.key === "Enter" && go()} />
      <Button small icon="add" text="Punkt" disabled={!x.trim() || !y.trim()} onClick={go}
        title="Punkt mit exakten Koordinaten anfügen — für Hallen mit Schema-Maßen" />
    </>
  );
}

function TemplateDialog({ onPick }: { onPick: (pts: [number, number][]) => void }) {
  const [w, setW] = useState(30);
  const [h, setH] = useState(18);
  const [a, setA] = useState(10);
  const [b, setB] = useState(6);
  return (
    <DialogBody>
      <p className="sub">
        Der schnellste Weg von „nichts" zu „etwas". Die Punkte lassen sich danach
        einzeln ziehen — die Vorlage ist ein Anfang, kein Ergebnis.
      </p>
      <div className="form-grid form-grid-2">
        <FormGroup label="Breite (m)"><NumericInput aria-label="Breite (m)" fill value={w} min={2} onValueChange={(v) => Number.isFinite(v) && setW(Math.max(2, v))} /></FormGroup>
        <FormGroup label="Tiefe (m)"><NumericInput aria-label="Tiefe (m)" fill value={h} min={2} onValueChange={(v) => Number.isFinite(v) && setH(Math.max(2, v))} /></FormGroup>
        <FormGroup label="Ausschnitt Breite (m)"><NumericInput aria-label="Ausschnitt Breite" fill value={a} min={1} onValueChange={(v) => Number.isFinite(v) && setA(Math.max(1, v))} /></FormGroup>
        <FormGroup label="Ausschnitt Tiefe (m)"><NumericInput aria-label="Ausschnitt Tiefe" fill value={b} min={1} onValueChange={(v) => Number.isFinite(v) && setB(Math.max(1, v))} /></FormGroup>
      </div>
      <div className="template-row">
        <Button icon="widget" text={`Rechteck ${w} × ${h} m`} onClick={() => onPick(templateRect(w, h))} />
        <Button icon="key-tab" text="L-Form" onClick={() => onPick(templateL(w, h, a, b))} />
        <Button icon="widget-header" text="U-Form" onClick={() => onPick(templateU(w, h, a, b))} />
      </div>
      <p className="sub" style={{ marginTop: 10 }}>
        Fläche Rechteck: <b>{(w * h).toLocaleString("de-DE")} m²</b>
      </p>
    </DialogBody>
  );
}

/* --------------------------------------------------------------------------
   DXF-Import für den Umriss — die Halle aus dem CAD, nicht neu erfunden.
   Der Server liest dieselbe Dateiklasse wie beim Teile-Import und gewinnt die
   größte geschlossene Kontur; hier wird nur die Einheit geklärt, denn über
   die Einheit kann die Datei selbst nicht urteilen.
   -------------------------------------------------------------------------- */
function DxfImportDialog({ busy, onImport, onClose }: {
  busy: boolean;
  onImport: (file: File, unit: number, targetW: number) => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [unit, setUnit] = useState("1000");
  const [autoUnit, setAutoUnit] = useState(true);
  const [targetW, setTargetW] = useState(0);
  return (
    <>
      <DialogBody>
        <p className="sub">
          Gelesen wird <b>ASCII-DXF</b> (CIRCLE, ARC, LINE, LWPOLYLINE, POLYLINE, ELLIPSE,
          SPLINE). Gewonnen wird die größte geschlossene Kontur — bei einem Grundriss ist
          das die Außenlinie. Y wird gespiegelt, denn CAD zählt nach oben und der Plan
          nach unten.
        </p>
        <div className="form-grid">
          <FormGroup label="DXF-Datei">
            <FileInput fill disabled={busy}
              text={file ? file.name : "DXF-Datei wählen …"}
              buttonText="Durchsuchen"
              inputProps={{ accept: ".dxf", "aria-label": "DXF-Datei wählen" }}
              onInputChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
          </FormGroup>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Checkbox checked={autoUnit} label="Einheit automatisch raten"
              onChange={(e) => setAutoUnit((e.target as HTMLInputElement).checked)} />
          </div>
          {!autoUnit && (
            <FormGroup label="Einheit">
              <HTMLSelect aria-label="Einheit" fill value={unit} onChange={(e) => setUnit(e.currentTarget.value)}>
                <option value="1000">Millimeter (1000 je m)</option>
                <option value="100">Zentimeter (100 je m)</option>
                <option value="1">Meter (1 je m)</option>
                <option value="39.37">Zoll (39,37 je m)</option>
              </HTMLSelect>
            </FormGroup>
          )}
          {autoUnit && (
            <FormGroup label="Kalibrieren: echte Breite (m)" helperText="0 = nur raten. Wer weiß, dass die Halle 36 m lang ist, sagt es hier — der Rest stimmt dann.">
              <NumericInput aria-label="Kalibrieren: echte Breite (m)" fill value={targetW} min={0} stepSize={1}
                onValueChange={(v) => setTargetW(Number.isFinite(v) ? Math.max(0, v) : 0)} />
            </FormGroup>
          )}
        </div>
      </DialogBody>
      <DialogFooter actions={
        <>
          <Button text="Abbrechen" disabled={busy} onClick={() => { setFile(null); onClose(); }} />
          <Button intent="primary" icon="import" text="Umriss übernehmen"
            disabled={!file || busy} loading={busy}
            onClick={() => file && onImport(file, autoUnit ? 0 : Number(unit), targetW)} />
        </>} />
    </>
  );
}

/* --------------------------------------------------------------------------
   Punkteliste des Entwurfs — dieselben Punkte wie im Plan, als Zahl. Der
   Größte Gewinn beim Bauen nach Schema-Maßen: tippen statt ziehen, nachlesen
   statt schätzen. Eine Zeile je Punkt, löschen und einfügen per Knopf.
   -------------------------------------------------------------------------- */
function DraftPoints({ points, onChange }: {
  points: [number, number][];
  onChange: (pts: [number, number][]) => void;
}) {
  const [open, setOpen] = useState(false);
  const patch = (idx: number, axis: 0 | 1, v: number) => {
    const next = points.map((p, i) => (i === idx ? ([p[0], p[1]] as [number, number]) : p));
    next[idx][axis] = Math.round(v * 100) / 100;
    onChange(next);
  };
  return (
    <div className="draft-points">
      <div className="card-title-row" style={{ marginTop: 8 }}>
        <h3 className="card-title">Punkte ({points.length})</h3>
        <Button small minimal icon={open ? "chevron-up" : "chevron-down"}
          text={open ? "zuklappen" : "Maße als Tabelle"} onClick={() => setOpen(!open)} />
      </div>
      {open && (
        <div className="draft-points-table">
          <HTMLTable compact className="data-table">
            <thead><tr><th>#</th><th>x (m)</th><th>y (m)</th><th>Kante</th><th><span className="sr-only">Aktion</span></th></tr></thead>
            <tbody>
              {points.map((p, i) => {
                const q = points[(i + 1) % points.length];
                const len = points.length > 2 || i < points.length - 1
                  ? Math.hypot(q[0] - p[0], q[1] - p[1]) : 0;
                return (
                  <tr key={i}>
                    <td className="sub">{i + 1}</td>
                    <td><NumericInput small value={p[0]} stepSize={0.25} minorStepSize={0.05}
                      buttonPosition="none" style={{ width: 58 }}
                      onValueChange={(v) => Number.isFinite(v) && patch(i, 0, v)} /></td>
                    <td><NumericInput small value={p[1]} stepSize={0.25} minorStepSize={0.05}
                      buttonPosition="none" style={{ width: 58 }}
                      onValueChange={(v) => Number.isFinite(v) && patch(i, 1, v)} /></td>
                    <td className="num mono sub">{len.toFixed(2)} m</td>
                    <td>
                      <Button small minimal icon="small-plus" title="Punkt danach einfügen"
                        onClick={() => {
                          const a = p, b = q;
                          onChange([...points.slice(0, i + 1),
                            [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number],
                            ...points.slice(i + 1)]);
                        }} />
                      <Button small minimal icon="cross" title="Punkt löschen"
                        disabled={points.length <= 3}
                        onClick={() => onChange(points.filter((_, k) => k !== i))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </HTMLTable>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Das Stationsformular. Die Maschinenwerte stehen bewusst nicht neben Farbe
   und Größe: sie sind keine Darstellung, sie sind die Eingabe einer
   Entscheidung. Was fehlt, wird oben als Lücke benannt, statt als Null in eine
   Rechnung zu gehen.
   -------------------------------------------------------------------------- */
function StationForm({
  floorChoices, currentFloor,
  editing, setEditing, products, users, thicknessChoices, gaps, supply, link, onConnect, path, pathWarning, onPathDraw, onPathDelete, onPathPop, onPathPin, onPathOptimize, onPathfind,
  onUploadModel, onRemoveModel, modelBusy, pendingModel, onClearPending,
  busy, onSave, onDelete, onDuplicate, onRotate, onPreset, onNew, onCopyLink,
}: {
  floorChoices: { value: number; label: string }[]; currentFloor: number;
  editing: Station; setEditing: (s: Station) => void;
  products: Product[]; users: StationUser[]; thicknessChoices: number[];
  gaps: string[]; supply: { label: string; metres: number; exact: boolean } | null;
  link: { connected: boolean; blocked: boolean; metres: number; onEdge: boolean } | null;
  onConnect: () => void;
  path: ManualPath | undefined; pathWarning: string;
  onPathDraw: () => void; onPathDelete: () => void; onPathPop: () => void; onPathPin: () => void;
  onPathOptimize: () => void; onPathfind: () => void;
  onUploadModel: (file: File) => void; onRemoveModel: () => void; modelBusy: boolean;
  pendingModel: File | null; onClearPending: () => void;
  busy: boolean; onSave: () => void; onDelete: () => void; onDuplicate: () => void;
  onRotate: (d: number) => void; onPreset: (k: MachineKind) => void;
  onNew: () => void; onCopyLink: () => void;
}) {
  const set = (patch: Partial<Station>) => setEditing({ ...editing, ...patch });
  const isProduction = editing.type === "production";

  return (
    <div className="editor-form">
      <div className="card-title-row hall-form-title">
        <h2 className="card-title">{editing.id ? `Bearbeiten — ${editing.label}` : "Neue Station"}</h2>
        {editing.id != null && <Button small minimal icon="link" text="Link" onClick={onCopyLink} />}
      </div>

      <RailSection title="Grunddaten und Lage" defaultOpen>
      <div className="form-grid form-grid-2">
        <FormGroup label="Name">
          <InputGroup aria-label="Name" value={editing.label} onChange={(e) => set({ label: e.target.value })} placeholder="z. B. Plotter 1" />
        </FormGroup>
        <FormGroup label="Kurzzeichen">
          <InputGroup aria-label="Kurzzeichen" value={editing.subtype} onChange={(e) => set({ subtype: e.target.value })} placeholder="z. B. plotter_1" />
        </FormGroup>
        {floorChoices.length > 1 && (
          <FormGroup label="Halle und Ebene" helperText={editing.id ? "Speichern versetzt die Station dorthin." : undefined}>
            <HTMLSelect aria-label="Halle und Ebene" fill value={editing.floor_id ?? currentFloor}
              onChange={(e) => set({ floor_id: Number(e.target.value) || null })}
              options={floorChoices} />
          </FormGroup>
        )}
        <FormGroup label="Typ">
          <HTMLSelect aria-label="Typ" fill value={editing.type} onChange={(e) => {
            const t = e.target.value as StationType;
            set({ type: t, colour: TYPE_COLOUR[t], is_storage: t === "warehouse" ? true : editing.is_storage });
          }}>
            {ALL_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </HTMLSelect>
        </FormGroup>
        <FormGroup label="Routing" helperText={ROUTING_HELP[editing.routing]}>
          <HTMLSelect aria-label="Routing" fill value={editing.routing}
            onChange={(e) => set({ routing: e.target.value as StationRouting })}>
            {(Object.keys(ROUTING_LABEL) as StationRouting[]).map((r) =>
              <option key={r} value={r}>{ROUTING_LABEL[r]}</option>)}
          </HTMLSelect>
        </FormGroup>
        <FormGroup label="Sichtbarkeit fremder Aufträge">
          <HTMLSelect aria-label="Sichtbarkeit fremder Aufträge" fill value={editing.visibility}
            onChange={(e) => set({ visibility: e.target.value as StationVisibility })}>
            {(Object.keys(VISIBILITY_LABEL) as StationVisibility[]).map((v) =>
              <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
          </HTMLSelect>
        </FormGroup>
        <FormGroup label="Farbe">
          <div className="colour-row">
            {COLOUR_PALETTE.map((c) => (
              <button key={c} type="button"
                className={"swatch-btn" + (editing.colour === c ? " swatch-btn-on" : "")}
                aria-label={`Farbe ${c}`} aria-pressed={editing.colour === c}
                style={{ background: c }} onClick={() => set({ colour: c })} />
            ))}
          </div>
        </FormGroup>
      </div>

      <div className="form-grid form-grid-6">
        <FormGroup label="x (m)"><NumericInput aria-label="x (m)" fill value={editing.x} onValueChange={(v) => set({ x: v })} stepSize={0.25} /></FormGroup>
        <FormGroup label="y (m)"><NumericInput aria-label="y (m)" fill value={editing.y} onValueChange={(v) => set({ y: v })} stepSize={0.25} /></FormGroup>
        <FormGroup label="Breite"><NumericInput aria-label="Breite" fill value={editing.w} min={0.5} onValueChange={(v) => set({ w: v })} stepSize={0.25} /></FormGroup>
        <FormGroup label="Tiefe"><NumericInput aria-label="Tiefe" fill value={editing.h} min={0.5} onValueChange={(v) => set({ h: v })} stepSize={0.25} /></FormGroup>
        <FormGroup label="Drehung (°)"><NumericInput aria-label="Drehung (°)" fill value={editing.rotation} min={-180} max={180} stepSize={15} majorStepSize={45} onValueChange={(v) => set({ rotation: v })} /></FormGroup>
        <div className="settings-check">
          <Checkbox checked={editing.active} label="Aktiv"
            onChange={(e) => set({ active: (e.target as HTMLInputElement).checked })} />
          <Checkbox checked={editing.is_storage} label="Lager"
            onChange={(e) => set({ is_storage: (e.target as HTMLInputElement).checked })} />
        </div>
      </div>

      {editing.id != null && (
        <div className="draw-actions" style={{ marginBottom: 10 }}>
          <Button small icon="duplicate" text="Duplizieren" onClick={onDuplicate} title="D" />
          <Button small icon="undo" onClick={() => onRotate(-15)} title="15° gegen den Uhrzeigersinn (R)" />
          <Button small icon="redo" onClick={() => onRotate(15)} title="15° im Uhrzeigersinn (Umschalt+R)" />
        </div>
      )}

      {editing.is_storage && supply === null && (
        <Callout compact intent="primary" icon="info-sign" style={{ marginBottom: 10 }}>
          Von dieser Station wird die Entfernung zu jeder Maschine gemessen.
        </Callout>
      )}
      {link && (
        <Callout compact intent={link.connected ? "success" : "warning"} icon={link.connected ? "tick-circle" : "warning-sign"}
          style={{ marginBottom: 10 }} data-testid="station-link">
          {link.connected
            ? <>Am Gangnetz: Stichweg <b>{fmtM(link.metres)}</b> {link.onEdge ? "zur Gangmitte" : "zum Knoten"}.</>
            : <><b>Nicht angebunden</b> — {link.blocked
                ? "jeder Weg zum Gang kreuzt ein Hindernis oder verlässt die Halle."
                : `der nächste Gang ist ${fmtM(link.metres)} entfernt.`} Wege von hier zählen als Luftlinie.</>}
          {!link.connected && (
            <div style={{ marginTop: 6 }}>
              <Button small icon="new-link" text="Ans Gangnetz anbinden" onClick={onConnect} disabled={link.blocked}
                title="Setzt einen Knoten auf die Stationsmitte und verbindet ihn mit dem nächsten freien Gang." />
            </div>
          )}
        </Callout>
      )}
      {editing.id != null && (
        <Callout compact intent={pathWarning ? "warning" : "none"} icon="path" style={{ marginBottom: 10 }} data-testid="station-path">
          <b>Pfad von Hand</b>{" "}
          {!path && "— keiner. Der automatische Stichweg gilt."}
          {path && (Math.hypot(path.points[0][0] - editing.x, path.points[0][1] - editing.y) > 1e-6
            ? <>— beginnt nicht mehr an der Station (sie wurde verschoben); er gilt deshalb nicht.{" "}
                <Button small minimal text="An die Station heften" onClick={onPathPin} /></>
            : <>— {path.points.length - 1} {path.points.length === 2 ? "Teilstück" : "Teilstücke"}, {fmtM(polylineLength(path.points))}; er gilt vor dem automatischen Stichweg.</>)}
          {pathWarning && <div><b>Gilt nicht:</b> {pathWarning} — es rechnet der automatische Stichweg.</div>}
          <div style={{ marginTop: 6 }}>
            <Button small icon="edit" text={path ? "Pfad neu setzen" : "Pfad anlegen"} onClick={onPathDraw} />{" "}
            {path && <Button small icon="clean" text="Pfad optimieren" onClick={onPathOptimize}
              title="Rechnet den Pfad um Hindernisse neu und entfernt unnötige Zwischenpunkte." />}{" "}
            {path && <Button small icon="undo" text="Letzter Punkt" onClick={onPathPop} />}{" "}
            {path && <Button small icon="trash" text="Löschen" onClick={onPathDelete} />}{" "}
            <Button small icon="route" text="Pfadfinder" onClick={onPathfind}
              title="Schlägt einen Weg um Hindernisse zum Gangnetz vor; erst „Übernehmen“ ändert den Plan." />
          </div>
        </Callout>
      )}
      {supply && !editing.is_storage && (
        <Callout compact intent={supply.exact ? "success" : "warning"} icon="route" style={{ marginBottom: 10 }}>
          Weg vom nächsten Lager ({supply.label}): <b>{fmtM(supply.metres)}</b>
          {supply.exact ? " über das Gangnetz." : " als Luftlinie — es gibt noch kein Gangnetz."}
        </Callout>
      )}

      {/* Selten gebraucht: in „Einfach" hinter einem Knopf (Aufgabe 35 E). */}
      <More label={`3D-Darstellung${editing.model_file ? " (Modell hinterlegt)" : ""}`} less="3D-Darstellung zuklappen">
      <div className="station-model-block">
        <div className="card-title-row">
          <h3 className="card-title">3D-Darstellung</h3>
          {editing.model_file && <Tag minimal icon="cube">hinterlegt</Tag>}
        </div>
        <p className="sub">
          Eingebautes Gerät, eigenes Modell (GLB, OBJ oder STL, max. 25 MB, wird auf die
          Stationsfläche skaliert) oder erst einmal nur ein Quader. Ein hochgeladenes Modell
          geht vor; Änderungen an Modellart und Mitarbeiter gelten nach „Speichern“.
        </p>
        <ModelChoice
          idPrefix="station-model"
          value={{ model_kind: editing.model_kind ?? "", model_file: editing.model_file, staffed: !!editing.staffed }}
          pendingFile={pendingModel} busy={modelBusy}
          onKind={(kind) => set({ model_kind: kind })}
          onFile={onUploadModel}
          onDropFile={() => { if (editing.model_file) onRemoveModel(); else onClearPending(); }}
          onStaffed={(on) => set({ staffed: on })} />
        {editing.model_file && (
          <>
            <div className="draw-actions">
              <Button small icon="trash" text="Modell entfernen" disabled={modelBusy} onClick={onRemoveModel} />
            </div>
            <div className="form-grid form-grid-2">
              <FormGroup label="Modellgröße" helperText="1 = passt in die Stationsfläche">
                <NumericInput aria-label="Modellgröße" fill value={editing.model_scale}
                  min={0.2} max={3} stepSize={0.1} minorStepSize={0.05}
                  onValueChange={(v) => set({ model_scale: v })} />
              </FormGroup>
              <FormGroup label="Modell-Drehung (°)" helperText="zusätzlich zur Stationsdrehung">
                <NumericInput aria-label="Modell-Drehung (°)" fill value={editing.model_rotation}
                  min={-180} max={180} stepSize={15} majorStepSize={45}
                  onValueChange={(v) => set({ model_rotation: v })} />
              </FormGroup>
            </div>
          </>
        )}
      </div>

      </More>

      </RailSection>

      {/* ---- Maschine ---- */}
      {isProduction && (
        <RailSection title="Maschine" note={gaps.length ? `${gaps.length} fehlen` : undefined}>
          <div className="card-title-row">
            <HTMLSelect aria-label="Maschinenart" value={editing.machine_kind}
              onChange={(e) => onPreset(e.currentTarget.value as MachineKind)}>
              {(Object.keys(MACHINE_LABEL) as MachineKind[]).map((k) =>
                <option key={k} value={k}>{MACHINE_LABEL[k]}</option>)}
            </HTMLSelect>
          </div>
          {gaps.length > 0 && (
            <Callout compact intent="warning" icon="warning-sign" style={{ marginBottom: 8 }}>
              Fehlt noch: <b>{gaps.join(", ")}</b>. Ein fehlender Wert schaltet seinen Faktor
              ab — die Zuordnung rät nicht.
            </Callout>
          )}
          <div className="form-grid form-grid-3">
            <FormGroup label="Vorschub (mm/s)" helperText="0 = unbekannt">
              <NumericInput aria-label="Vorschub (mm/s)" fill value={editing.speed_mm_s} min={0} stepSize={5}
                onValueChange={(v) => set({ speed_mm_s: v })} />
            </FormGroup>
            <FormGroup label="Anstechen (s/Teil)">
              <NumericInput aria-label="Anstechen (s/Teil)" fill value={editing.pierce_s} min={0} stepSize={0.5}
                onValueChange={(v) => set({ pierce_s: v })} />
            </FormGroup>
            <FormGroup label="Platte auflegen (min)">
              <NumericInput aria-label="Platte auflegen (min)" fill value={editing.handling_min_per_plate} min={0} stepSize={0.5}
                onValueChange={(v) => set({ handling_min_per_plate: v })} />
            </FormGroup>
            <FormGroup label="Rüsten (min)">
              <NumericInput aria-label="Rüsten (min)" fill value={editing.setup_min} min={0} stepSize={1}
                onValueChange={(v) => set({ setup_min: v })} />
            </FormGroup>
            <FormGroup label="Umrüsten (min)" helperText="Aufschlag bei Werkstoff-/Dickenwechsel">
              <NumericInput aria-label="Umrüsten (min)" fill value={editing.changeover_min} min={0} stepSize={1}
                onValueChange={(v) => set({ changeover_min: v })} />
            </FormGroup>
            <FormGroup label="Kapazität (min/Tag)">
              <NumericInput aria-label="Kapazität (min/Tag)" fill value={editing.capacity_min_per_day} min={0} stepSize={30} majorStepSize={120}
                onValueChange={(v) => set({ capacity_min_per_day: v })} />
            </FormGroup>
            <FormGroup label="Tisch max. Breite (mm)">
              <NumericInput aria-label="Tisch max. Breite (mm)" fill value={editing.max_sheet_w} min={0} stepSize={100} majorStepSize={500}
                onValueChange={(v) => set({ max_sheet_w: v })} />
            </FormGroup>
            <FormGroup label="Tisch max. Höhe (mm)">
              <NumericInput aria-label="Tisch max. Höhe (mm)" fill value={editing.max_sheet_h} min={0} stepSize={100} majorStepSize={500}
                onValueChange={(v) => set({ max_sheet_h: v })} />
            </FormGroup>
            <FormGroup label="Stundensatz (€/h)" helperText="nur Vergleich, nie ein Kundenpreis">
              <NumericInput aria-label="Stundensatz (€/h)" fill value={editing.cost_per_h} min={0} stepSize={5}
                onValueChange={(v) => set({ cost_per_h: v })} />
            </FormGroup>
            <FormGroup label="Dicke min. (mm)">
              <NumericInput aria-label="Dicke min. (mm)" fill value={editing.thk_min} min={0} stepSize={0.5}
                onValueChange={(v) => set({ thk_min: v })} />
            </FormGroup>
            <FormGroup label="Dicke max. (mm)">
              <NumericInput aria-label="Dicke max. (mm)" fill value={editing.thk_max} min={0} stepSize={0.5}
                onValueChange={(v) => set({ thk_max: v })} />
            </FormGroup>
          </div>
          <p className="sub">
            Die eingesetzten Richtwerte stammen aus der Literatur, nicht von Ihren Maschinen.
            Prüfen Sie sie, bevor jemand seine Fertigungsplanung darauf stützt.
          </p>
        </RailSection>
      )}

      {/* ---- Arbeitszeiten der nicht schneidenden Stationen ----

           Ein Regal, ein Packtisch und ein Schreibtisch haben keinen Vorschub
           in mm/s, aber sie haben ein Aufsetzen und ein Pro-Stück. Ohne die
           beiden Zahlen kann so eine Station so wenig eine Fertigstellung
           versprechen wie ein Plotter ohne Vorschub — die Abarbeitungsliste
           steht dann trotzdem, nur ohne Uhrzeiten. 0 heißt „unbekannt",
           nicht „null". */}
      {!isProduction && (
        <RailSection title="Arbeitszeiten">
          {editing.task_min <= 0 && editing.unit_min <= 0 && (
            <Callout compact intent="warning" icon="warning-sign" style={{ marginBottom: 8 }}>
              Ohne Zeiten bekommt diese Station eine Reihenfolge, aber keine
              Uhrzeiten und kein Fertigstellungsversprechen — sie rät nicht.
            </Callout>
          )}
          <div className="form-grid form-grid-3">
            <FormGroup label="Grundzeit (min/Vorgang)"
                       helperText="Aufsetzen: Sendung anlegen, Auftrag aufrufen, Wagen holen">
              <NumericInput aria-label="Grundzeit (min/Vorgang)" fill value={editing.task_min} min={0} stepSize={1}
                onValueChange={(v) => set({ task_min: v })} />
            </FormGroup>
            <FormGroup label="Je Einheit (min)"
                       helperText={editing.type === "warehouse" ? "je Platte aus dem Regal"
                         : editing.type === "shipping" ? "je Position im Paket" : "je Position im Vorgang"}>
              <NumericInput aria-label="Je Einheit (min)" fill value={editing.unit_min} min={0} stepSize={0.5}
                onValueChange={(v) => set({ unit_min: v })} />
            </FormGroup>
            <FormGroup label="Kapazität (min/Tag)">
              <NumericInput aria-label="Kapazität (min/Tag)" fill value={editing.capacity_min_per_day} min={0} stepSize={30} majorStepSize={120}
                onValueChange={(v) => set({ capacity_min_per_day: v })} />
            </FormGroup>
            <FormGroup label="Umrüsten (min)"
                       helperText="Aufschlag bei Werkstoffwechsel — im Lager der Weg zum anderen Regal">
              <NumericInput aria-label="Umrüsten (min)" fill value={editing.changeover_min} min={0} stepSize={1}
                onValueChange={(v) => set({ changeover_min: v })} />
            </FormGroup>
          </div>
        </RailSection>
      )}

      {/* ---- Eingrenzung ---- */}
      <RailSection title="Eingrenzung">
      <div className="chip-block">
        <h3 className="card-title">Werkstoffe <span className="sub">leer = alle</span></h3>
        <div className="chip-row">
          {products.slice(0, 60).map((p) => {
            const on = editing.materials.includes(p.id);
            return (
              <button key={p.id} className={"chip" + (on ? " chip-on" : "")}
                onClick={() => set({ materials: on ? editing.materials.filter((x) => x !== p.id) : [...editing.materials, p.id] })}>
                {p.short || p.name}
              </button>
            );
          })}
          {!products.length && <span className="sub">Werkstoffliste nicht verfügbar.</span>}
        </div>
      </div>

      <div className="chip-block">
        <h3 className="card-title">Dicken <span className="sub">aus den gewählten Werkstoffen, leer = alle</span></h3>
        <div className="chip-row">
          {(thicknessChoices.length ? thicknessChoices : [1, 1.5, 2, 3, 4, 5]).map((t) => {
            const on = editing.thicknesses.includes(t);
            return (
              <button key={t} className={"chip" + (on ? " chip-on" : "")}
                onClick={() => set({ thicknesses: on ? editing.thicknesses.filter((x) => x !== t) : [...editing.thicknesses, t] })}>
                {t.toLocaleString("de-DE")} mm
              </button>
            );
          })}
        </div>
      </div>

      <div className="chip-block">
        <h3 className="card-title">Zugewiesene Nutzer</h3>
        <div className="chip-row">
          {users.map((u) => {
            const on = editing.assigned_users.includes(u.id);
            return (
              <button key={u.id} className={"chip" + (on ? " chip-on" : "")}
                onClick={() => set({ assigned_users: on ? editing.assigned_users.filter((x) => x !== u.id) : [...editing.assigned_users, u.id] })}>
                {u.name || u.email} {u.role !== "customer" && <span className="chip-tag">{u.role}</span>}
              </button>
            );
          })}
          {!users.length && <span className="sub">Nutzerliste nicht verfügbar.</span>}
        </div>
      </div>

      <FormGroup label="Notiz">
        <TextArea aria-label="Notiz" fill rows={2} value={editing.note} onChange={(e) => set({ note: e.target.value })}
          placeholder="Was an dieser Station zu beachten ist" />
      </FormGroup>
      </RailSection>

      <div className="editor-actions">
        <Button intent="primary" icon="floppy-disk" loading={busy} onClick={onSave}
          text={editing.id ? "Änderungen speichern" : "Station anlegen"} />
        <Button icon="add" text="Neu" onClick={onNew} />
        {editing.id && <Button intent="danger" icon="trash" text="Löschen" onClick={onDelete} />}
      </div>
    </div>
  );
}


/* Neue Station: Name, 3D-Darstellung (vorhandenes Modell, Upload oder nur ein
   Quader) und der Haken „Mitarbeiter“, bevor sie angelegt wird. Alles davon
   lässt sich später in der Stationsmaske ändern. */
function NewStationDialog({ type, blank, busy, onClose, onCreate }: {
  type: StationType; blank: Station; busy: boolean;
  onClose: () => void; onCreate: (st: Station, file: File | null) => void;
}) {
  const [draft, setDraft] = useState<Station>(blank);
  const [file, setFile] = useState<File | null>(null);
  return (
    <Dialog isOpen onClose={onClose} title={`Neue Station: ${TYPE_LABEL[type]}`} className="new-station-dialog">
      <DialogBody>
        <FormGroup label="Name">
          <InputGroup aria-label="Name der neuen Station" value={draft.label} autoFocus
            onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        </FormGroup>
        <ModelChoice
          idPrefix="new-station-model"
          value={{ model_kind: draft.model_kind ?? "", model_file: "", staffed: !!draft.staffed }}
          pendingFile={file}
          onKind={(kind) => setDraft({ ...draft, model_kind: kind })}
          onFile={setFile}
          onDropFile={() => setFile(null)}
          onStaffed={(on) => setDraft({ ...draft, staffed: on })} />
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Abbrechen" onClick={onClose} />
        <Button intent="primary" icon="add" text="Anlegen" loading={busy} disabled={!draft.label.trim()}
          onClick={() => onCreate(draft, file)} />
      </>} />
    </Dialog>
  );
}
