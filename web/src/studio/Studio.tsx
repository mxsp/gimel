import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnchorButton, Button, ButtonGroup, Checkbox, Classes, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, Icon, InputGroup,
  Menu, MenuDivider, MenuItem, Spinner, Switch, Tag,
} from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import { api, canAdminWork, clearSession, forgetSession, isWorker, SessionUser } from "../api";
import { toastError, toastInfo, toastSuccess } from "../toast";
import GimelMark from "../components/GimelMark";
import AppSwitcher from "../components/AppSwitcher";
import BotSmiley from "../components/BotSmiley";
import SidebarUpdateButton from "../components/SidebarUpdateButton";
import ThemeSwitch, { THEME_EVENT } from "../components/ThemeSwitch";
import { cycleMode } from "../theme";
import FloorPlan from "../components/FloorPlan";
import HallCreatorDialog from "../components/HallCreatorDialog";
import IsoFloorPlan from "../components/twin/IsoFloorPlan";
import Inspector, { StationViewData } from "../components/twin/Inspector";
import {
  buildMarks, byUrgency, LENSES, Lens, machineWork, openAtStep, schedulesOf, STATUS_WORD, STEPS, suggestionsBy, TimeStep,
} from "../components/twin/marks";
import { carryFloors, defaultShown, hallCheck, sceneScope, toggleHallFloors } from "../components/twin/twinScope";
import { fmtMetres, tourCaption, tourStops } from "../components/twin/studioMath";
import Minimap from "./Minimap";
import { fmtSimClock, SimResult } from "../components/twin/fleetSim";
import SimPanel from "./SimPanel";
import RoutePanel from "./RoutePanel";
import AnalysisPanel from "./AnalysisPanel";
import { probeDevice, type Quality } from "../components/twin/renderQuality";
import { classifyDevice } from "../components/twin/frameBudget";
import type { ThreeHandle } from "../components/twin/ThreeFloorPlan";
import type { WalkLevel } from "../components/twin/walkLevels";
import {
  copyToClipboard, EMPTY_FLOOR, Floor, FlowEdge, Robot, RobotJob, Station, TYPE_LABEL, WorklistData,
} from "../factory";
import { usePageContext, usePageProbe } from "@agentlab/pageContext";
import CopilotDock from "../components/agent/CopilotDock";
import { useCopilotDock } from "../components/agent/copilotState";
import { twinPart, viewerProbe } from "../components/agent/twinContext";
import { allFloors, floorLabel, stationFloor, useTopology } from "../sites";

/* Twin Studio — der Zwilling als eigene Anwendung.

   Links der Aufbau (Halle → Ebene → Station), in der Mitte die Bühne über die
   ganze Höhe, rechts die Station, unten die Zeit. Dieselben Daten und dieselben
   Regeln wie im Leitstand: Gebuchtes ist fest, Geschätztes trägt ≈, eine
   Prognose sperrt alles, was etwas ändert. Das Studio ändert nichts an
   Aufträgen oder Plänen; es speichert nur Kamera-Ansichten.

   ?kiosk=1 blendet alles Bedienbare aus und fährt die Halle im Rundgang ab —
   für einen Bildschirm in der Halle. */

const ThreeFloorPlan = lazy(() => import("../components/twin/ThreeFloorPlan"));
const FloorAdmin = lazy(() => import("../pages/FactoryFloorAdmin"));
const REFRESH_MS = 30_000;
const STALE_MS = 90_000;
const NO_FLOW: FlowEdge[] = [];
const NO_ROBOTS: Robot[] = [];
const NO_JOBS: RobotJob[] = [];
const FLOORS_KEY = "gimel-studio-shown-floors";
type ViewMode = "three" | "iso" | "2d" | "edit";

/** Häkchen je Halle und Ebene: die Ebenen, die außer der aktiven im 3D-Bild
 *  stehen. ``null`` = keine eigene Wahl (Vorgabe: andere Hallen auf derselben
 *  Stufe). Ersetzt seit 2026-11-07 die ausgeblendeten Hallen und den Schalter
 *  „Weitere Ebenen der Halle“. */
function readShownFloors(): number[] | null {
  try {
    const raw = localStorage.getItem(FLOORS_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => Number.isFinite(id)) : null;
  } catch { return null; }
}

interface SavedView {
  id: number;
  floor_id: number | null;
  name: string;
  camera: { position: number[]; target: number[]; mode?: string; view?: ViewMode };
  created_by: string;
}

/** Eine Lageänderung im Begehen — Grundlage für Strg+Z / Strg+Shift+Z. */
interface StationMove {
  id: number;
  floorId: number | null;
  label: string;
  before: { x: number; y: number; rotation: number };
  after: { x: number; y: number; rotation: number };
}

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch { return fallback; }
}
function writePref(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* privater Modus */ }
}
function readFlags<T extends Record<string, boolean>>(key: string, fallback: T): T {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    if (raw && typeof raw === "object") {
      const out = { ...fallback };
      for (const k of Object.keys(fallback)) if (typeof raw[k] === "boolean") (out as Record<string, boolean>)[k] = raw[k];
      return out;
    }
  } catch { /* fällt auf die Vorgabe */ }
  return fallback;
}

/** Höhe der Bühne messen, damit die 3D-Ansicht genau die freie Fläche füllt. */
function useStageHeight(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    if (!el) return;
    const measure = () => setH(Math.max(240, el.clientHeight));
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, [el]);
  return [setEl, h];
}

const NARROW = "(max-width: 900px)";
const COMPACT_BAR = "(max-width: 1280px)";
const clock = (d: Date) => d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

export default function Studio({ user, demo, agent = false, onLogout }: { user: SessionUser; demo: boolean; agent?: boolean; onLogout: () => void }) {
  const copilot = useCopilotDock(agent);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [kiosk, setKiosk] = useState(() => params.get("kiosk") === "1");
  const site = useTopology();
  const { topo, floorId, current: here, setFloorId } = site;
  const office = !isWorker();
  const admin = canAdminWork(user);

  // ------------------------------------------------------------- Daten
  /** Zuletzt geladener Grundriss der gewählten Ebene. */
  const [loadedFloor, setLoadedFloor] = useState<Floor | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  /** Aktueller Stand ohne veraltete Closure (Rückgängig schreibt nur die Lage). */
  const stationsRef = useRef<Station[]>([]);
  stationsRef.current = stations;
  const [flow, setFlow] = useState<FlowEdge[]>([]);
  const [worklist, setWorklist] = useState<WorklistData | null>(null);
  const [robots, setRobots] = useState<Robot[]>([]);
  const [robotsAt, setRobotsAt] = useState<string | null>(null);
  const [robotJobs, setRobotJobs] = useState<RobotJob[]>([]);
  const [otherFloors, setOtherFloors] = useState<Record<number, Floor>>({});
  /** Die gezeigte Ebene: aus dem Vorrat sofort, sonst die zuletzt geladene.
      Alles, was die Bühne zeigt, geht von *dieser* Ebene aus (``sceneHere``) —
      nicht von der gerade gewählten, deren Grundriss noch unterwegs sein kann. */
  const floor = (floorId != null ? otherFloors[floorId] : undefined) ?? loadedFloor;
  const sceneHere = useMemo(
    () => site.floors.find((r) => r.floor.id === floor?.id) ?? here,
    [site.floors, floor?.id, here]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(Date.now());
  const loadId = useRef(0);
  const load = useCallback(async (silent = false) => {
    const id = ++loadId.current;
    if (!silent) setLoading(true);
    const q = floorId ? `floor_id=${floorId}` : "";
    const [f, st, fl, wl] = await Promise.allSettled([
      api<Floor>(`/api/factory/floor${q ? `?${q}` : ""}`),
      api<Station[]>("/api/factory/stations"),
      api<{ edges: FlowEdge[] }>("/api/factory/flow"),
      api<WorklistData>("/api/factory/worklist"),
    ]);
    if (id !== loadId.current) return;
    setLoading(false);
    if (f.status === "rejected" || st.status === "rejected") {
      const reason = f.status === "rejected" ? f.reason : (st as PromiseRejectedResult).reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      setError(msg);
      if (!silent) toastError(msg);
      return;
    }
    const plan: Floor = { ...EMPTY_FLOOR, ...f.value, aisles: f.value.aisles ?? { nodes: [], edges: [] } };
    setLoadedFloor(plan);
    // Auch in den Vorrat: ein Wechsel zurück (Treppe, Tür) zeigt sie sofort.
    setOtherFloors((m) => ({ ...m, [plan.id]: plan }));
    setStations(st.value);
    setFlow(fl.status === "fulfilled" ? fl.value.edges : []);
    setWorklist(wl.status === "fulfilled" ? wl.value : null);
    setRobots([]);
    setRobotsAt(null);
    setRobotJobs([]);
    setError("");
    const stamp = new Date();
    setRefreshedAt(stamp);
    setNow(stamp.getTime());
  }, [floorId]);
  // Erst laden, wenn der Standortbaum da ist — sonst käme die erste Ebene doppelt.
  const topoReady = topo !== null || site.error !== "";
  useEffect(() => { if (topoReady) load(); }, [load, topoReady]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(true); }, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => { clearInterval(t); clearInterval(tick); };
  }, [load]);
  const stale = refreshedAt != null && now - refreshedAt.getTime() > STALE_MS;

  // ------------------------------------------------------------- Anzeige
  const [view, setView] = useState<ViewMode>(() => readPref("gimel-studio-view", ["three", "iso", "2d"] as const, "three") as ViewMode);
  const [editDirty, setEditDirty] = useState(false);
  const switchView = useCallback((next: ViewMode) => {
    if (next === view) return;
    if (view === "edit" && editDirty) {
      if (!window.confirm("Die Halle hat ungespeicherte Änderungen. Trotzdem die Ansicht wechseln?")) return;
      setEditDirty(false);
    }
    setView(next);
  }, [view, editDirty]);
  useEffect(() => writePref("gimel-studio-view", view), [view]);
  // Ohne eigene Wahl entscheidet das Gerät (task 41 D): eine eigene
  // Grafikkarte bekommt „Hoch", alles andere „Schnell". Die Wahl im Knopf gilt
  // danach und wird gemerkt.
  const [quality, setQuality] = useState<Quality>(() => readPref("gimel-studio-quality", ["schnell", "hoch"] as const,
    params.get("quality") === "hoch" ? "hoch"
      : params.get("quality") === "schnell" ? "schnell"
        : classifyDevice(probeDevice()) === "stark" ? "hoch" : "schnell"));
  // Erst eine echte Änderung merken, nicht die Vorgabe des Geräts.
  const qualityMounted = useRef(false);
  useEffect(() => {
    if (!qualityMounted.current) { qualityMounted.current = true; return; }
    writePref("gimel-studio-quality", quality);
  }, [quality]);
  const [layers, setLayers] = useState(() => readFlags("gimel-studio-layers", {
    heat: true, beams: true, flow: true, flowSelected: false, labels: true, robots: false,
    shell: true, roof: false, lanes: true, paths: true, collisions: false, full: false,
    minimap: true,
  }));
  const [lens, setLens] = useState<Lens>(() => {
    const qLens = params.get("lens") as Lens | null;
    if (qLens && LENSES.some((l) => l.id === qLens)) return qLens;
    return readPref("gimel-studio-lens", ["last", "ruesten", "termine", "fluss"] as const, "last");
  });
  useEffect(() => writePref("gimel-studio-lens", lens), [lens]);
  const [statusFilter, setStatusFilter] = useState<"all" | "hot" | "laeuft" | "frei">("all");
  useEffect(() => writePref("gimel-studio-layers", JSON.stringify(layers)), [layers]);
  const toggle = (k: keyof typeof layers) => setLayers((v) => ({ ...v, [k]: !v[k] }));
  /** Häkchen je Halle und Ebene (3D). Eine Ebene ist immer sichtbar: die aktive. */
  const [shownPick, setShownPick] = useState<number[] | null>(() => readShownFloors());
  useEffect(() => {
    if (shownPick == null) { try { localStorage.removeItem(FLOORS_KEY); } catch { /* privat */ } }
    else writePref(FLOORS_KEY, JSON.stringify(shownPick));
  }, [shownPick]);
  const shown = useMemo(() => shownPick ?? defaultShown(sceneHere), [shownPick, sceneHere]);
  /** Ändert die Wahl; ohne eigene Wahl beginnt sie bei der Vorgabe. */
  const pickFloors = useCallback((fn: (ids: number[]) => number[]) => {
    setShownPick((cur) => fn(cur ?? defaultShown(sceneHere)));
  }, [sceneHere]);
  /** Treppe, Aufzug oder Tür: die Ebene wechselt; die Wahl geht mit (``carryFloors``). */
  const walkToLevel = useCallback((id: number) => setFloorId(id), [setFloorId]);
  /** Belebung (dargestellt): ohne eigene Wahl in der Demo an, sonst aus. */
  const [stagedPref, setStagedPref] = useState(() => readPref("gimel-studio-staged", ["1", "0", ""] as const, ""));
  useEffect(() => writePref("gimel-studio-staged", stagedPref), [stagedPref]);
  const staged = stagedPref === "" ? demo : stagedPref === "1";
  /** Schmal (Telefon): Aufbau und Station liegen als Schublade über der Bühne. */
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [compactBar, setCompactBar] = useState(() => window.matchMedia(COMPACT_BAR).matches);
  useEffect(() => {
    const media = window.matchMedia(NARROW);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const media = window.matchMedia(COMPACT_BAR);
    const update = () => setCompactBar(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [leftOpen, setLeftOpen] = useState(() => !window.matchMedia(NARROW).matches
    && readPref("gimel-studio-left", ["1", "0"] as const, "1") === "1");
  useEffect(() => { if (!narrow) writePref("gimel-studio-left", leftOpen ? "1" : "0"); }, [leftOpen, narrow]);
  // Wird das Fenster schmal, schließt die Schublade, sonst verdeckt sie alles.
  useEffect(() => { if (narrow) setLeftOpen(false); }, [narrow]);

  // ------------------------------------------------------------- Werkzeuge
  const threeRef = useRef<ThreeHandle | null>(null);
  const [walk, setWalk] = useState(false);
  /** Wo die Figur abgelegt wurde (Ziehen und Ablegen auf den Hallenboden). */
  const [walkFrom, setWalkFrom] = useState<[number, number] | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const [measure, setMeasure] = useState(false);
  const [measured, setMeasured] = useState<{ metres: number; points: number }>({ metres: 0, points: 0 });
  const [touring, setTouring] = useState(() => params.get("kiosk") === "1");
  const [tourAt, setTourAt] = useState<string>("");
  /** Vorführung: aktueller Halt (Kennung) und angehalten? (task 41 E) */
  const [tourStopId, setTourStopId] = useState<number | null>(null);
  const [tourPaused, setTourPaused] = useState(false);
  useEffect(() => { if (!touring) { setTourPaused(false); setTourStopId(null); } }, [touring]);
  const [step, setStep] = useState<TimeStep>(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** Vom Assistenten hervorgehobene Stationen (show_in_view); ein Klick auf die Bühne löscht sie nicht, „clear_highlight“ schon. */
  const [copilotHighlight, setCopilotHighlight] = useState<number[] | undefined>(undefined);
  /** Platzierung aus dem Assistenten: der Editor öffnet mit dieser Station. */
  const [placement, setPlacement] = useState<{ token: number; station: Partial<Station> } | null>(null);
  /** Auswahl aus dem Assistenten: der Editor springt auf diese Station. */
  const [editorFocus, setEditorFocus] = useState<{ token: number; id: number } | null>(null);
  const [inspect, setInspect] = useState<StationViewData | null>(null);
  const [inspectFailed, setInspectFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [views, setViews] = useState<SavedView[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  /** Einbuchstaben-Kürzel lassen sich abschalten (WCAG 2.1.4). */
  const [keysOn, setKeysOn] = useState(() => readPref("gimel-studio-keys", ["1", "0"] as const, "1") === "1");
  useEffect(() => writePref("gimel-studio-keys", keysOn ? "1" : "0"), [keysOn]);
  const [stageRef, stageHeight] = useStageHeight();
  /** null = noch unbekannt; false = dieser Browser kann kein 3D (WebGL). */
  const [gl, setGl] = useState<boolean | null>(null);
  const can3d = view === "three" && gl !== false;
  /** Links: Stationen, Befunde, Simulation oder Wege. */
  const [leftTab, setLeftTab] = useState<"stationen" | "befunde" | "simulation" | "wege">(() =>
    params.get("sim") === "1" && !isWorker() ? "simulation" : "stationen");
  // URL-Deep-Links (?floor=..., ?station=...) einmalig beim Start übernehmen.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !topo || !stations.length) return;
    deepLinked.current = true;
    const qFloor = Number(params.get("floor"));
    if (Number.isFinite(qFloor) && qFloor > 0 && qFloor !== floorId) setFloorId(qFloor);
    const qStation = Number(params.get("station"));
    if (Number.isFinite(qStation) && qStation > 0) {
      const target = stations.find((s) => s.id === qStation);
      if (target) {
        setSelectedId(target.id ?? null);
        const fid = stationFloor(target, topo);
        if (fid != null && fid !== floorId) { flyAfterSwitch.current = qStation; setFloorId(fid); }
        else window.setTimeout(() => threeRef.current?.flyToStation(qStation), 120);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topo, stations.length]);
  const [simResult, setSimResult] = useState<SimResult | null>(null);
  /** Simulationsuhr: läuft in der 3D-Schleife über ``clock()``, ohne React neu zu zeichnen. */
  const simClock = useRef({ t: 0, speed: 120, playing: true, last: performance.now(), horizon: 0 });
  const [simT, setSimT] = useState(0);
  const [simPlaying, setSimPlaying] = useState(true);
  const [simSpeed, setSimSpeed] = useState(120);
  const readSim = useCallback(() => {
    const c = simClock.current;
    const now = performance.now();
    if (c.playing && c.horizon > 0) {
      c.t += ((now - c.last) / 1000) * c.speed;
      if (c.t > c.horizon) c.t = 0; // Schichtende: von vorn.
    }
    c.last = now;
    return c.t;
  }, []);

  // Aus dem Bearbeiten zurück: Halle, Ebenen und Stationen neu laden.
  const wasEdit = useRef(false);
  useEffect(() => {
    if (view === "edit") { wasEdit.current = true; return; }
    if (wasEdit.current) { wasEdit.current = false; site.reload(); load(true); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Werkzeuge schließen einander aus: Begehen, Messen und Rundgang teilen die Maus.
  const startWalk = (on: boolean) => { setWalk(on); if (on) { setMeasure(false); setTouring(false); } };
  const startMeasure = (on: boolean) => { setMeasure(on); if (on) { setWalk(false); setTouring(false); } };
  const startTour = (on: boolean) => { setTouring(on); if (on) { setWalk(false); setMeasure(false); } };
  // Nur 3D kann begehen, messen und den Rundgang fahren.
  useEffect(() => { if (view !== "three") { setWalk(false); setMeasure(false); setTouring(false); } }, [view]);
  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement != null);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  // Simulation: Uhr zurücksetzen, Anzeige der Zeit viermal je Sekunde.
  useEffect(() => {
    const c = simClock.current;
    c.t = 0; c.last = performance.now(); c.horizon = simResult?.summary.horizon_s ?? 0;
    setSimT(0);
    if (simResult) { if (gl !== false) setView("three"); setTouring(false); setWalk(false); setMeasure(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simResult]);
  useEffect(() => { simClock.current.playing = simPlaying; simClock.current.last = performance.now(); }, [simPlaying]);
  useEffect(() => { simClock.current.speed = simSpeed; }, [simSpeed]);
  useEffect(() => {
    if (!simResult) return;
    const t = setInterval(() => setSimT(readSim()), 250);
    return () => clearInterval(t);
  }, [simResult, readSim]);
  // Eine andere Ebene hat einen anderen Fluss: das Ergebnis gilt dort nicht.
  useEffect(() => { setSimResult(null); }, [floorId]);

  // Zeitleiste: Abspielen geht die Prognoseschritte im Kreis durch.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setStep((s) => ((s + 1) % 4) as TimeStep), 2600);
    return () => clearInterval(t);
  }, [playing]);
  useEffect(() => { if (!worklist) { setStep(0); setPlaying(false); } }, [worklist]);

  // ------------------------------------------------------------- Abgeleitet
  /** In der Experimentierhalle hängt die animierte Zelle an der Halle. */
  const experimentalHall = useMemo(() => {
    const h = sceneHere?.hall;
    return h && /experimental/i.test(h.name || "") ? h.name : null;
  }, [sceneHere]);
  const schedules = useMemo(() => schedulesOf(worklist), [worklist]);
  const marks = useMemo(
    () => buildMarks({ stations, schedules, suggestions: suggestionsBy(worklist), step, lens, flow, stale }),
    [stations, schedules, worklist, step, lens, flow, stale]);
  /** Stationen der *gezeigten* Ebene — sonst stünden einen Abruf lang die neuen
      Stationen im alten Grundriss. */
  const shownFloorId = floor?.id ?? floorId;
  const onFloor = useMemo(
    () => (topo ? stations.filter((s) => stationFloor(s, topo) === shownFloorId) : stations),
    [stations, topo, shownFloorId]);
  const open = useMemo(() => STEPS.map((s) => openAtStep(stations, s.id)), [stations]);
  const tour = useMemo(() => (touring ? tourStops(onFloor, marks, 14) : null),
    // Der Rundgang beginnt nicht bei jeder Aktualisierung von vorn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [touring, floorId, onFloor.length]);
  /** Treppe und Aufzug beim Begehen fahren zu den Ebenen dieser Halle. */
  const walkLevels = useMemo<WalkLevel[]>(() => (sceneHere?.hall?.floors ?? []).map((f) => ({
    id: f.id, label: f.level_name || `Ebene ${f.level}`, elevation_m: Number(f.elevation_m) || 0, level: f.level || 0,
  })), [sceneHere]);
  /** Alle Hallen des Standorts für die Häkchen, die aktive zuerst. */
  const pickHalls = useMemo(() => {
    const hall = sceneHere?.hall;
    const all = (sceneHere?.site?.halls ?? (hall ? [hall] : [])).filter((h) => h.floors.length > 0);
    return [...all].sort((a, b) => (a.id === hall?.id ? -1 : b.id === hall?.id ? 1 : 0));
  }, [sceneHere]);
  /* Wechsel der Ebene oder Halle: was zu sehen war, bleibt zu sehen; die
     verlassene Ebene bleibt, wenn außer ihr etwas gezeigt wurde oder man
     hinübergegangen ist. Ohne eigene Wahl folgt die Vorgabe der neuen Ebene. */
  const prevFloorId = useRef(floorId);
  useEffect(() => {
    const prev = prevFloorId.current;
    prevFloorId.current = floorId;
    setShownPick((cur) => (cur == null ? cur : carryFloors(prev, floorId, cur, walk)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorId]);
  /** Stapel und Nachbarhallen genau nach den Häkchen — eine Rechnung für
      Studio und Leitstand (``twinScope.ts``). */
  const scope = useMemo(() => sceneScope({
    here: sceneHere, stack: [], halls: [], only: shown,
    floors: otherFloors, stations, topo, enabled: view === "three",
  }), [sceneHere, shown, otherFloors, stations, topo, view]);
  const { ghosts, neighbors: neighborHalls, activeOffset } = scope;
  const wantedFloorIds = useMemo(() => {
    const ids = new Set(scope.wanted);
    // Beim Begehen die Ebenen dieser Halle vorab holen: Treppe und Aufzug
    // kommen dann ohne Wartezeit an.
    if (walk) for (const l of walkLevels) ids.add(l.id);
    return [...ids];
  }, [scope.wanted, walk, walkLevels]);
  useEffect(() => {
    if (!wantedFloorIds.length) return;
    let live = true;
    for (const id of wantedFloorIds) {
      if (otherFloors[id]) continue;
      api<Floor>(`/api/factory/floor?floor_id=${id}`)
        .then((fl) => { if (live) setOtherFloors((m) => ({ ...m, [id]: { ...EMPTY_FLOOR, ...fl } })); })
        .catch(() => { /* fehlt nur im Bild */ });
    }
    return () => { live = false; };
  }, [wantedFloorIds, otherFloors]);
  /* Der Assistent sieht mit, was hier zu sehen ist (Auswahl, Ebene, Darstellung,
     Stapel, Nachbarhallen, Begehen). Standpunkt und Blick entstehen erst beim Senden. */
  usePageContext(useMemo(() => twinPart({
    where: "studio", floor, floorLabel: sceneHere ? floorLabel(sceneHere, true) : undefined,
    stations: onFloor, selectedId, mode: view, step, robots,
    layers: layers as unknown as Record<string, boolean>,
    shownLevels: scope.shownLevels, shownHalls: scope.shownHalls, walking: walk,
    extra: { messen: measure, rundgang: touring, reiter: leftTab },
  }), [floor, sceneHere, onFloor, selectedId, view, step, robots, layers, scope.shownLevels, scope.shownHalls,
    walk, measure, touring, leftTab]));
  usePageProbe(() => viewerProbe(view, threeRef.current?.getViewer()));
  /** Station auf einer anderen Ebene gewählt: erst wechseln, dann hinfliegen
      (im Begehen: hindrehen und hingehen), sobald die Ebene gezeigt wird. */
  const flyAfterSwitch = useRef<number | null>(null);
  useEffect(() => {
    const id = flyAfterSwitch.current;
    if (id == null || !onFloor.some((s) => s.id === id)) return;
    flyAfterSwitch.current = null;
    // Ein Bild warten: die neue Ebene ist dann gebaut.
    const t = window.setTimeout(() => threeRef.current?.flyToStation(id), 80);
    return () => window.clearTimeout(t);
  }, [onFloor]);
  const hallMap = useMemo(() => {
    const h = sceneHere?.hall;
    return h && h.map_enabled && (h.lat || h.lon) ? { lat: h.lat, lon: h.lon, rotation_deg: h.rotation_deg } : null;
  }, [sceneHere]);
  const loads = useMemo(() => {
    const m: Record<number, number> = {};
    for (const s of stations) if (s.id != null) m[s.id] = s.queue_min ?? 0;
    return m;
  }, [stations]);
  const unknownMax = useMemo(() => Math.max(0, ...stations
    .filter((s) => !s.capacity_min_per_day).map((s) => s.queue_min ?? 0)), [stations]);
  const sorted = useMemo(() => byUrgency(onFloor, marks), [onFloor, marks]);
  const shownStations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sorted.filter((s) => {
      if (q && !`${s.label} ${TYPE_LABEL[s.type] ?? s.type}`.toLowerCase().includes(q)) return false;
      if (statusFilter === "all") return true;
      const k = s.id != null ? marks[s.id]?.kind : "unbekannt";
      if (statusFilter === "hot") return k === "ueber" || k === "voll";
      return k === statusFilter;
    });
  }, [sorted, search, statusFilter, marks]);
  const otherFloorMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !topo) return [];
    return stations
      .filter((s) => stationFloor(s, topo) !== shownFloorId)
      .filter((s) => `${s.label} ${TYPE_LABEL[s.type] ?? s.type}`.toLowerCase().includes(q))
      .slice(0, 12);
  }, [stations, topo, shownFloorId, search]);
  const visibleFlow = useMemo(() => {
    if (!layers.flow) return NO_FLOW;
    if (!layers.flowSelected || selectedId == null) return flow;
    return flow.filter((e) => e.from === selectedId || e.to === selectedId);
  }, [layers.flow, layers.flowSelected, selectedId, flow]);
  const counts = useMemo(() => {
    const c = { ueber: 0, voll: 0, laeuft: 0, unbekannt: 0 };
    for (const s of onFloor) {
      const k = s.id != null ? marks[s.id]?.kind : undefined;
      if (k && k in c) c[k as keyof typeof c] += 1;
    }
    return c;
  }, [onFloor, marks]);
  const selected = stations.find((s) => s.id === selectedId) ?? null;
  const simFleet = useMemo(() => {
    if (!simResult || simResult.floor_id !== floorId) return null;
    return {
      robots: simResult.summary.robots.map((r) => ({ id: r.id, name: r.name, kind: r.kind, planned: r.planned, start: r.start })),
      tracks: simResult.tracks,
      hotspots: simResult.summary.hotspots,
      clock: readSim,
    };
  }, [simResult, floorId, readSim]);

  // Station gewählt → Stationssicht laden, mit jeder Aktualisierung neu.
  useEffect(() => {
    if (selectedId == null) { setInspect(null); return; }
    let live = true;
    api<StationViewData>(`/api/factory/stations/${selectedId}/view`)
      .then((v) => { if (live) { const ok = !!v && Array.isArray(v.queue); setInspect(ok ? v : null); setInspectFailed(!ok); } })
      .catch(() => { if (live) setInspectFailed(true); });
    return () => { live = false; };
  }, [selectedId, refreshedAt]);

  // Gespeicherte Ansichten der Ebene.
  const loadViews = useCallback(async () => {
    if (!floorId) { setViews([]); return; }
    try { setViews(await api<SavedView[]>(`/api/factory/views?floor_id=${floorId}`)); }
    catch { setViews([]); }
  }, [floorId]);
  useEffect(() => { loadViews(); }, [loadViews]);

  const pick = useCallback((s: Station, fly = true) => {
    if (s.id == null) return;
    setSelectedId(s.id);
    if (window.matchMedia(NARROW).matches) setLeftOpen(false);
    const fid = topo ? stationFloor(s, topo) : null;
    if (fid != null && fid !== floorId) {
      if (fly && view === "three") flyAfterSwitch.current = s.id;
      setFloorId(fid);
      return;
    }
    if (fly && view === "three") threeRef.current?.flyToStation(s.id);
  }, [topo, floorId, setFloorId, view]);

  /* Der Assistent darf die Seite bitten, etwas zu zeigen oder vorzubereiten.
     Er schreibt dafür nie direkt in die Oberfläche: die Seite prüft jede
     Aktion selbst (Rolle, bekannte Art) und ignoriert alles andere. */
  useEffect(() => {
    const onAction = (event: Event) => {
      const action = (event as CustomEvent).detail as Record<string, unknown> | null;
      if (!action || typeof action !== "object") return;
      const type = String(action.type || "");
      if (type === "select_station") {
        const id = Number(action.station_id);
        const station = stations.find((s) => s.id === id);
        if (!station) return;
        pick(station, true);
        if (action.edit && admin && station.id != null) {
          setView("edit");
          setEditorFocus({ token: Date.now(), id: station.id });
        }
        return;
      }
      if (type === "focus") {
        const station = stations.find((x) => x.id === Number(action.station_id));
        if (station) pick(station, true);
        return;
      }
      if (type === "set_floor") {
        const fid = Number(action.floor_id);
        if (Number.isFinite(fid) && fid > 0 && fid !== floorId) setFloorId(fid);
        return;
      }
      if (type === "set_view_mode") {
        const m = String(action.mode || "");
        if (m === "three" && gl !== false) setView("three");
        else if (m === "iso") setView("iso");
        else if (m === "plan") setView("2d");
        else if (m === "walk" && gl !== false) { setView("three"); setWalk(true); }
        return;
      }
      if (type === "highlight") {
        const ids = Array.isArray(action.station_ids) ? action.station_ids.map(Number).filter(Number.isFinite) : [];
        setCopilotHighlight(ids.length ? ids : undefined);
        return;
      }
      if (type === "clear_highlight") { setCopilotHighlight(undefined); return; }
      if (type === "prepare_station_placement") {
        if (!admin) return;
        const fid = Number(action.floor_id);
        if (Number.isFinite(fid) && fid > 0 && fid !== floorId) setFloorId(fid);
        const station = action.station;
        if (!station || typeof station !== "object") return;
        setPlacement({ token: Date.now(), station: station as Partial<Station> });
        setView("edit");
      }
    };
    window.addEventListener("gimel:copilot-action", onAction);
    return () => window.removeEventListener("gimel:copilot-action", onAction);
  }, [admin, stations, pick, floorId, setFloorId, gl]);

  /** Schreibt nur die Lage einer Station; ``true``, wenn der Server sie annahm. */
  const writeStationAt = useCallback(async (id: number, next: StationMove["before"]): Promise<boolean> => {
    const s = stationsRef.current.find((v) => v.id === id);
    if (!s) return false;
    setStations((ss) => ss.map((v) => (v.id === id ? { ...v, ...next } : v)));
    try {
      const saved = await api<Station>(`/api/factory/stations/${id}`, {
        method: "PUT", body: JSON.stringify({ ...s, ...next }),
      });
      setStations((ss) => ss.map((v) => (v.id === id ? { ...v, ...saved } : v)));
      return true;
    } catch (e) {
      setStations((ss) => ss.map((v) => (v.id === id ? { ...v, x: s.x, y: s.y, rotation: s.rotation } : v)));
      toastError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  /** Verlauf der Lagen im Begehen: Strg+Z nimmt zurück, Strg+Shift+Z/Strg+Y wiederholt. */
  const undoMoves = useRef<StationMove[]>([]);
  const redoMoves = useRef<StationMove[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const syncUndoState = () => { setUndoCount(undoMoves.current.length); setRedoCount(redoMoves.current.length); };

  /** Im Begehen eine Station auf den Boden legen: sofort anzeigen, dann speichern. */
  const moveStationTo = useCallback(async (
    s: Station, next: { x: number; y: number; rotation: number },
  ) => {
    if (s.id == null || !admin) return;
    const id = s.id;
    const move: StationMove = {
      id, floorId: floorId ?? null, label: s.label, before: { x: s.x, y: s.y, rotation: s.rotation }, after: next,
    };
    undoMoves.current.push(move);
    redoMoves.current = [];
    syncUndoState();
    const ok = await writeStationAt(id, next);
    if (ok) toastSuccess(`${s.label} verschoben — Strg+Z nimmt zurück`);
    else {
      undoMoves.current = undoMoves.current.filter((m) => m !== move);
      syncUndoState();
    }
  }, [admin, floorId, writeStationAt]);

  const undoMove = useCallback(async () => {
    const move = undoMoves.current.pop();
    if (!move) { toastInfo("Nichts rückgängig zu machen."); return; }
    if (move.floorId != null && move.floorId !== floorId) setFloorId(move.floorId);
    if (await writeStationAt(move.id, move.before)) {
      redoMoves.current.push(move);
      syncUndoState();
      toastInfo(`${move.label}: alte Lage zurück · Strg+Shift+Z wiederholt`);
    } else {
      undoMoves.current.push(move);
      syncUndoState();
    }
  }, [floorId, setFloorId, writeStationAt]);

  const redoMove = useCallback(async () => {
    const move = redoMoves.current.pop();
    if (!move) { toastInfo("Nichts zu wiederholen."); return; }
    if (move.floorId != null && move.floorId !== floorId) setFloorId(move.floorId);
    if (await writeStationAt(move.id, move.after)) {
      undoMoves.current.push(move);
      syncUndoState();
      toastInfo(`${move.label}: Lage wiederhergestellt`);
    } else {
      redoMoves.current.push(move);
      syncUndoState();
    }
  }, [floorId, setFloorId, writeStationAt]);

  const pendingCamera = useRef<{ position: number[]; target: number[]; mode?: string } | null>(null);
  useEffect(() => {
    if (view !== "three" || !pendingCamera.current) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const cam = pendingCamera.current;
      if (!cam) { window.clearInterval(timer); return; }
      if (threeRef.current) {
        threeRef.current.setCamera(cam);
        if (cam.mode === "walk") setWalk(true);
        pendingCamera.current = null;
        window.clearInterval(timer);
      } else if (tries > 40) {
        pendingCamera.current = null;
        window.clearInterval(timer);
      }
    }, 60);
    return () => window.clearInterval(timer);
  }, [view, floor]);

  const saveView = async () => {
    const cam = threeRef.current?.getCamera();
    const name = saveName.trim();
    if (!cam || !name || !floorId) return;
    try {
      await api("/api/factory/views", {
        method: "POST",
        body: JSON.stringify({ floor_id: floorId, name, camera: { ...cam, mode: walk ? "walk" : "orbit", view: "three" } }),
      });
      toastSuccess(`Ansicht „${name}" gespeichert`);
      setSaveOpen(false);
      setSaveName("");
      loadViews();
    } catch (e) { toastError(e instanceof Error ? e.message : String(e)); }
  };
  const deleteView = async (v: SavedView) => {
    try {
      await api(`/api/factory/views/${v.id}`, { method: "DELETE" });
      toastInfo(`Ansicht „${v.name}" gelöscht`);
      loadViews();
    } catch (e) { toastError(e instanceof Error ? e.message : String(e)); }
  };
  const goView = (v: SavedView) => {
    startTour(false);
    if (v.camera.mode !== "walk") startWalk(false);
    if (view === "three" && threeRef.current) {
      threeRef.current.setCamera(v.camera);
      if (v.camera.mode === "walk") startWalk(true);
    } else {
      pendingCamera.current = v.camera;
      if (view !== "three") setView("three");
    }
  };
  const copyStudioLink = async () => {
    const u = new URL(window.location.href);
    if (floorId) u.searchParams.set("floor", String(floorId));
    if (selectedId) u.searchParams.set("station", String(selectedId));
    else u.searchParams.delete("station");
    u.searchParams.set("lens", lens);
    const ok = await copyToClipboard(u.toString());
    if (ok) toastSuccess("Studio-Link kopiert");
    else toastError("Kopieren nicht möglich");
  };
  const screenshot = async () => {
    const blob = await threeRef.current?.screenshot();
    if (!blob) { toastError("Bildschirmfoto nicht möglich."); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const name = (here ? floorLabel(here) : "halle").replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase();
    a.href = url;
    a.download = `zwilling-${name}-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toastError("Vollbild nicht möglich."));
  };
  const logout = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* trotzdem abmelden */ }
    finally { clearSession(); forgetSession(); onLogout(); }
  };

  // Tastatur: Ansichten 1/2/3, G begehen, M messen, T Rundgang, P Foto, F Vollbild, Esc.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.defaultPrevented) return;
    // Häkchen und Schalter nehmen keine Buchstaben an: nach einem Klick darauf
    // sollen G, H, M … weiter wirken (bis 2026-11-07 schluckte der Fokus sie).
    const toggleInput = t instanceof HTMLInputElement && /^(checkbox|radio)$/.test(t.type);
    if (t && !toggleInput && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest?.(".copilot-dock"))) return;
    // In einem Dialog oder Menü gehört Esc dem Overlay.
    if (t?.closest?.(".bp5-overlay") || document.querySelector(".bp5-overlay-open .bp5-dialog")) return;
    // Lagen aus dem Begehen zurücknehmen — mehrteilig, also auch bei
    // abgeschalteten Einbuchstaben-Kürzeln (WCAG 2.1.4).
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) void redoMove(); else void undoMove();
        return;
      }
      if (e.code === "KeyY") { e.preventDefault(); void redoMove(); return; }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      if (narrow && leftOpen) setLeftOpen(false);
      else if (kiosk) setKiosk(false);
      else if (touring) setTouring(false);
      else if (selectedId != null && !walk && !measure) setSelectedId(null);
      return;
    }
    if (!keysOn) return;
    if (walk && /^(KeyW|KeyA|KeyS|KeyD)$/.test(e.code)) return;
    if (e.key === "1" && gl !== false) switchView("three");
    else if (e.key === "2") switchView("iso");
    else if (e.key === "3") switchView("2d");
    else if (e.key === "4" && admin) switchView("edit");
    else if (e.key === "g" && can3d) startWalk(!walk);
    else if (e.key === "m" && can3d) startMeasure(!measure);
    else if (e.key === "t" && can3d) startTour(!touring);
    else if (e.key === "p" && can3d) screenshot();
    else if (e.key === "f") toggleFullscreen();
    else if (e.key === "k" && view === "three") toggle("minimap");
    else if (touring && e.key === "ArrowRight") threeRef.current?.tourStep(1);
    else if (touring && e.key === "ArrowLeft") threeRef.current?.tourStep(-1);
    else if (touring && e.key === " ") { e.preventDefault(); const next = !tourPaused; setTourPaused(next); threeRef.current?.tourPause(next); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const forecast = step !== 0;
  const stepLabel = STEPS.find((s) => s.id === step)?.label ?? "Jetzt";

  // ------------------------------------------------------------- Bühne
  const stage = view === "edit" ? (
    <div className="studio-edit">
      <Suspense fallback={<div className="studio-center"><Spinner size={40} /></div>}>
        <FloorAdmin
          embedded
          placement={placement}
          focus={editorFocus}
          onDirtyChange={setEditDirty}
          onSaved={(savedFloor) => {
            setLoadedFloor(savedFloor);
            setOtherFloors((m) => ({ ...m, [savedFloor.id]: savedFloor }));
            void load(true);
          }}
        />
      </Suspense>
    </div>
  ) : !floor ? (
    <div className="studio-center">{loading ? <Spinner size={40} /> : <p>{error || "Keine Halle angelegt."}</p>}</div>
  ) : view === "three" ? (
    <Suspense fallback={<div className="studio-center"><Spinner size={40} /></div>}>
      <ThreeFloorPlan
        ref={threeRef}
        bare
        clouds={false}
        floor={floor}
        stations={onFloor}
        levels={ghosts}
        neighborHalls={neighborHalls}
        map={hallMap}
        status={marks}
        selectedId={selectedId} highlightIds={copilotHighlight}
        flow={visibleFlow}
        robots={layers.robots ? robots : NO_ROBOTS}
        robotJobs={layers.robots ? robotJobs : NO_JOBS}
        sampledAt={robotsAt}
        onStationClick={(s) => pick(s, false)}
        onStationMove={admin ? moveStationTo : undefined}
        onFallback={() => setView("iso")}
        onGl={(ok) => {
          setGl(ok);
          if (!ok) {
            setView("iso");
            toastInfo("Dieser Browser kann kein 3D (WebGL) — Semi-3D geöffnet. Begehen, Messen, Rundgang und Foto brauchen 3D.");
          }
        }}
        height={stageHeight}
        quality={quality}
        onQualityDrop={() => { setQuality("schnell"); toastInfo("Darstellung „Hoch“ war zu langsam — zurück auf „Schnell“."); }}
        overlays={{ heat: layers.heat, beams: layers.beams }}
        walk={walk}
        walkFrom={walkFrom}
        onWalkChange={(on) => { startWalk(on); if (!on) setWalkFrom(null); }}
        walkLevels={walkLevels}
        onWalkLevel={walkToLevel}
        placeLabel={sceneHere ? floorLabel(sceneHere) : ""}
        onUndo={admin ? () => void undoMove() : undefined}
        onRedo={admin ? () => void redoMove() : undefined}
        fullView={layers.full}
        activeOffset={activeOffset}
        measure={measure}
        onMeasure={(metres, points) => setMeasured({ metres, points })}
        tour={tour}
        simFleet={simFleet}
        onTourStop={(s) => { setTourAt(s?.label ?? ""); setTourStopId(s?.id ?? null); if (s && kiosk) setSelectedId(s.id); }}
        show={{ flow: layers.flow, labels: layers.labels, robots: layers.robots, shell: layers.shell,
          roof: layers.roof, lanes: layers.lanes, paths: layers.paths, collisions: layers.collisions }}
        staged={staged}
      />
    </Suspense>
  ) : view === "iso" ? (
    <IsoFloorPlan floor={floor} stations={onFloor} status={marks} selectedId={selectedId}
      flow={layers.flow ? flow : NO_FLOW} highlightRoutesTo={selectedId}
      onStationClick={(s) => pick(s, false)} height={stageHeight}
      show={{ flow: layers.flow, labels: layers.labels, lanes: layers.lanes, paths: layers.paths, frame: layers.shell }} />
  ) : (
    <FloorPlan floor={floor} map={hallMap}
      north={here?.hall && (here.hall.lat || here.hall.lon) ? here.hall.rotation_deg : null}
      stations={onFloor} loads={loads} maxUnknownLoad={unknownMax} loadUnit="min" status={marks}
      selectedId={selectedId} flow={layers.flow ? flow : NO_FLOW} hideInactive={false}
      onStationClick={(s) => pick(s, false)} height={stageHeight}
      show={{ flow: layers.flow, labels: layers.labels, lanes: layers.lanes, paths: layers.paths }} />
  );

  const layerMenu = (
    <Menu className="studio-layer-menu">
      <MenuDivider title="Daten in der Halle" />
      <LayerItem on={layers.heat} label="Last am Boden: wird voll / überbucht" onClick={() => toggle("heat")} />
      <LayerItem on={layers.beams} label="Lichtsäule: voll / überbucht" onClick={() => toggle("beams")} />
      <LayerItem on={layers.flow} label="Materialfluss" onClick={() => toggle("flow")} />
      <LayerItem on={layers.flowSelected} label="Nur Wege der gewählten Station" disabled={!layers.flow} onClick={() => toggle("flowSelected")} />
      {/* Roboter-Ebene vorerst ausgeblendet */}
      <LayerItem on={layers.collisions} label="Kollisionen" onClick={() => toggle("collisions")} />
      <LayerItem on={staged} label="Belebung (dargestellt, nicht gemessen)" onClick={() => setStagedPref(staged ? "0" : "1")} />
      <MenuDivider title="Halle" />
      <LayerItem on={layers.labels} label="Beschriftung" onClick={() => toggle("labels")} />
      <LayerItem on={layers.minimap} label="Minikarte (K)" onClick={() => toggle("minimap")} />
      <LayerItem on={layers.shell} label="Hallenhülle" onClick={() => toggle("shell")} />
      <LayerItem on={layers.roof} label="Dach" onClick={() => toggle("roof")} />
      <LayerItem on={layers.lanes} label="Fahrspuren" onClick={() => toggle("lanes")} />
      <LayerItem on={layers.paths} label="Handwege" onClick={() => toggle("paths")} />
      <LayerItem on={layers.full} label="Andere Ebenen und Hallen voll sichtbar (nicht nur angedeutet)"
        disabled={!shown.length} onClick={() => toggle("full")} />
      {view === "three" && (pickHalls.some((h) => h.floors.length > 1) || pickHalls.length > 1) ? (
        <>
          <MenuDivider title="Hallen und Ebenen im Bild" />
          <li className="studio-pick-actions">
            <Button small minimal text="Alle" onClick={() => setShownPick(pickHalls
              .flatMap((h) => h.floors.map((f) => f.id)).filter((id) => id !== floor?.id))} />
            <Button small minimal text="Nur aktive Ebene" onClick={() => setShownPick([])} />
            <Button small minimal text="Vorgabe" disabled={shownPick == null}
              title="Andere Hallen auf derselben Stufe, keine weiteren Ebenen"
              onClick={() => setShownPick(null)} />
          </li>
          {pickHalls.map((hall) => {
            const state = hallCheck(shown, hall, floor?.id ?? null);
            const active = hall.id === sceneHere?.hall?.id;
            return (
              <li key={hall.id} className="studio-pick-hall">
                <Checkbox checked={state === "on"} indeterminate={state === "some"}
                  label={active ? `${hall.name} (aktiv)` : hall.name}
                  disabled={active && hall.floors.length < 2}
                  onChange={() => pickFloors((ids) => toggleHallFloors(ids, hall, floor?.id ?? null))} />
                <ul>
                  {[...hall.floors].sort((a, b) => b.level - a.level).map((f) => {
                    const isActive = f.id === floor?.id;
                    return (
                      <li key={f.id}>
                        <Checkbox checked={isActive || shown.includes(f.id)} disabled={isActive}
                          label={`${f.level_name || `Ebene ${f.level}`}${isActive ? " · aktiv" : ""}`}
                          onChange={() => pickFloors((ids) => (ids.includes(f.id)
                            ? ids.filter((x) => x !== f.id) : [...ids, f.id]))} />
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </>
      ) : null}
    </Menu>
  );

  const viewsMenu = (
    <Menu>
      <MenuItem icon="floppy-disk" text="Aktuelle Ansicht speichern …" disabled={view !== "three" || isWorker()}
        onClick={() => setSaveOpen(true)} />
      {views.length > 0 && <MenuDivider title="Gespeichert" />}
      {views.map((v) => (
        <MenuItem key={v.id} icon="camera" text={v.name} onClick={() => goView(v)}
          labelElement={(v.created_by === user.email || admin) && !isWorker() ? (
            <Button small minimal icon="trash" aria-label={`Ansicht ${v.name} löschen`}
              onClick={(e) => { e.stopPropagation(); deleteView(v); }} />
          ) : undefined} />
      ))}
      {!views.length && <MenuItem disabled text="Noch keine Ansicht für diese Ebene" />}
    </Menu>
  );

  return (
    <div className={`studio${(leftTab === "simulation" && office) || (leftTab === "wege" && admin) ? " studio-sim-tab" : ""}${view === "edit" ? " studio-editing" : ""}${kiosk ? " studio-kiosk" : ""}${leftOpen ? "" : " studio-left-closed"}${selected ? " studio-has-inspector" : ""}${agent && !kiosk && copilot.open ? " studio-has-copilot" : ""}`}>
      {demo && <div className="demo-banner" role="note">DEMO – Musterwerk GmbH, keine echten Daten</div>}
      {!kiosk && (
        <header className="studio-bar">
          <Button minimal icon={leftOpen ? "menu-closed" : "menu-open"} aria-label={leftOpen ? "Aufbau ausblenden" : "Aufbau einblenden"}
            title="Aufbau ein-/ausblenden" onClick={() => setLeftOpen((v) => !v)} />
          <span className="studio-brand"><GimelMark size={22} /> <b>Twin Studio</b></span>
          <FloorPicker topo={topo} floorId={floorId} onPick={setFloorId} />
          {admin && !compactBar && (
            <Button
              small
              minimal
              icon="office"
              text="Neue Halle"
              title="Hallen-Assistent öffnen: Neue Halle mit Form, Maßen, Gängen, Toren & Zonen anlegen"
              onClick={() => setCreatorOpen(true)}
            />
          )}
          <ButtonGroup className="studio-seg" aria-label="Ansicht">
            <Button text="3D" active={view === "three"} aria-pressed={view === "three"} onClick={() => switchView("three")}
              disabled={gl === false} title={gl === false ? "Dieser Browser kann kein 3D (WebGL)" : "3D (1)"} />
            <Button text="Semi-3D" active={view === "iso"} aria-pressed={view === "iso"} onClick={() => switchView("iso")} title="Semi-3D (2)" />
            <Button text="Plan" active={view === "2d"} aria-pressed={view === "2d"} onClick={() => switchView("2d")} title="Plan (3)" />
            {admin && (
              <Button icon="edit" text="Bearbeiten" active={view === "edit"} aria-pressed={view === "edit"}
                onClick={() => switchView("edit")} title="Halle bearbeiten: Umriss, Zonen, Hindernisse, Gänge, Tore, Stationen (4)" />
            )}
          </ButtonGroup>
          {can3d && !compactBar && (
            <ButtonGroup className="studio-seg studio-quality" aria-label="Darstellung">
              <Button text="Schnell" active={quality === "schnell"} aria-pressed={quality === "schnell"} onClick={() => setQuality("schnell")}
                title="Flach und sparsam — läuft überall" />
              <Button text="Hoch" active={quality === "hoch"} aria-pressed={quality === "hoch"} onClick={() => setQuality("hoch")}
                title="Sonne, Schatten, Umgebungslicht und beleuchtete Materialien" />
            </ButtonGroup>
          )}
          <KeyPopover content={layerMenu} placement="bottom-start">
            <Button className="studio-layer-btn" icon="layers" text="Ebenen & Daten" aria-label="Ebenen und Daten" rightIcon="caret-down" />
          </KeyPopover>
          <span className="studio-bar-gap" />
          {(view === "three" || gl === false) && (
            <ButtonGroup className="studio-tools" aria-label="Werkzeuge">
              <Button disabled={!can3d} icon="walk" aria-keyshortcuts="g" active={walk} aria-pressed={walk} text="Begehen"
                title="Begehen (G) — oder die Figur auf den Hallenboden ziehen und dort ablegen"
                draggable={can3d}
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-gimel-walker", "1");
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => { setWalkFrom(null); startWalk(!walk); }} />
              <Button disabled={!can3d} icon="horizontal-inbetween" aria-keyshortcuts="m" active={measure} aria-pressed={measure} text="Messen" title="Messen (M): Klicks auf den Boden, Rücktaste nimmt zurück, Esc leert"
                onClick={() => startMeasure(!measure)} />
              <Button disabled={!can3d} icon="play" aria-keyshortcuts="t" active={touring} aria-pressed={touring} text="Vorführung" title="Vorführung (T): fährt die dringendsten Stationen ab und erklärt jede; ← → blättern, Leertaste hält an"
                onClick={() => startTour(!touring)} />
              <KeyPopover content={viewsMenu} placement="bottom-end">
                <Button icon="camera" text="Ansichten" aria-label="Ansichten" rightIcon="caret-down" disabled={!can3d}
                  title={can3d ? "Gespeicherte Kamera-Ansichten" : "Nur in 3D"} />
              </KeyPopover>
              {!compactBar && (
                <Button icon="media" disabled={!can3d} aria-keyshortcuts="p" aria-label="Bildschirmfoto" title="Bildschirmfoto als PNG (P)" onClick={screenshot} />
              )}
            </ButtonGroup>
          )}
          {!compactBar && (
            <>
              <Button minimal className="studio-full-btn" icon={fullscreen ? "minimize" : "fullscreen"} aria-label="Vollbild" title="Vollbild (F)" onClick={toggleFullscreen} />
              <Button minimal className="studio-kiosk-btn" icon="desktop" aria-label="Hallenbildschirm" title="Hallenbildschirm: ohne Bedienelemente, Rundgang (Esc beendet)"
                disabled={gl === false}
                onClick={() => { setKiosk(true); setView("three"); startTour(true); }} />
            </>
          )}
          {agent && (
            <Button minimal icon="chat" className="studio-agent-btn" active={copilot.open} aria-pressed={copilot.open}
              aria-label="Assistent ein- oder ausblenden" title="Assistent ein-/ausblenden (Strg+Shift+A)"
              onClick={copilot.toggle} />
          )}
          {!compactBar && <span className="theme-switch"><ThemeSwitch /></span>}
          <KeyPopover placement="bottom-end" content={
            <Menu>
              {compactBar && (
                <>
                  {admin && (
                    <MenuItem icon="office" text="Neue Halle anlegen …" onClick={() => setCreatorOpen(true)} />
                  )}
                  {can3d && (
                    <>
                      <MenuItem icon="media" text="Bildschirmfoto (P)" onClick={screenshot} />
                      <MenuItem icon="cog" text={quality === "hoch" ? "Darstellung: Hoch → Schnell" : "Darstellung: Schnell → Hoch"}
                        onClick={() => setQuality(quality === "hoch" ? "schnell" : "hoch")} />
                    </>
                  )}
                  <MenuItem icon={fullscreen ? "minimize" : "fullscreen"} text={fullscreen ? "Vollbild beenden (F)" : "Vollbild (F)"} onClick={toggleFullscreen} />
                  <MenuItem icon="desktop" text="Hallenbildschirm" disabled={gl === false}
                    onClick={() => { setKiosk(true); setView("three"); startTour(true); }} />
                  <MenuItem icon="contrast" text="Darstellung (Hell / Dunkel)" onClick={() => { cycleMode(); window.dispatchEvent(new Event(THEME_EVENT)); }} />
                  <MenuDivider />
                </>
              )}
              <MenuItem icon="share" text="Zum Portal (Leitstand)" href="/app/#/arbeitsvorrat" target="_blank" rel="noopener" />
              <MenuItem icon="layout" text="Digitaler Grundriss" href="/twin/" target="_blank" rel="noopener" />
              <MenuItem icon="link" text="Studio-Link kopieren" onClick={() => void copyStudioLink()} />
              <MenuItem icon="refresh" text="Jetzt aktualisieren" onClick={() => load()} />
              <MenuItem icon="undo" text={undoCount ? `Rückgängig (${undoCount}) · Strg+Z` : "Rückgängig (Strg+Z)"}
                disabled={!admin || undoCount === 0} onClick={() => void undoMove()} />
              <MenuItem icon="redo" text={redoCount ? `Wiederholen (${redoCount}) · Strg+Shift+Z` : "Wiederholen (Strg+Shift+Z)"}
                disabled={!admin || redoCount === 0} onClick={() => void redoMove()} />
              <MenuItem icon="key-command" text="Tastenkürzel (1/2/3, G, M, T, P, F, R, Strg+Z)" shouldDismissPopover={false}
                labelElement={<Switch checked={keysOn} onChange={() => setKeysOn((v) => !v)} aria-label="Tastenkürzel" style={{ margin: 0 }} />}
                onClick={() => setKeysOn((v) => !v)} />
              <MenuDivider />
              <MenuItem icon="log-out" text="Abmelden" onClick={logout} />
            </Menu>
          }>
            <Button minimal icon="user" rightIcon="caret-down" aria-label={`Konto: ${user.name || user.email}`} text={<span className="studio-who">{user.name || user.email}</span>} />
          </KeyPopover>
        </header>
      )}

      {narrow && leftOpen && !kiosk && (
        <button type="button" className="studio-scrim" aria-label="Aufbau schließen" onClick={() => setLeftOpen(false)} />
      )}
      <aside className="studio-left" aria-label="Aufbau" hidden={kiosk || !leftOpen}>
        <div className="rail-top">
          <a className="rail-brand" href="/studio/" onClick={(e) => e.preventDefault()} aria-label="Twin Studio">
            <BotSmiley size={30} variant="brand" trackMouse />
            <span className="rail-brand-text">
              <strong>Twin Studio</strong>
              <span>Gimel</span>
            </span>
          </a>
        </div>
        {office && (
          <div className="studio-tabs" role="group" aria-label="Linke Spalte">
            <Button minimal icon="list" text="Stationen" aria-pressed={leftTab === "stationen"} active={leftTab === "stationen"}
              onClick={() => setLeftTab("stationen")} />
            <Button minimal icon="diagnosis" text="Befunde" aria-pressed={leftTab === "befunde"} active={leftTab === "befunde"}
              onClick={() => setLeftTab("befunde")} />
            <Button minimal icon="predictive-analysis" text="Simulation" aria-pressed={leftTab === "simulation"} active={leftTab === "simulation"}
              onClick={() => setLeftTab("simulation")} />
            {admin && (
              <Button minimal icon="path-search" text="Wege" aria-pressed={leftTab === "wege"} active={leftTab === "wege"}
                onClick={() => setLeftTab("wege")} />
            )}
          </div>
        )}
        {leftTab === "befunde" && office ? (
          <div className="studio-sim-scroll">
            <AnalysisPanel
              stations={stations}
              onFocusStations={(ids) => {
                setCopilotHighlight(ids);
                const first = stations.find((s) => s.id === ids[0]);
                if (first) pick(first, true);
              }}
            />
          </div>
        ) : leftTab === "simulation" && office ? (
          <div className="studio-sim-scroll">
            <SimPanel floorId={floorId} result={simResult} onResult={setSimResult} />
          </div>
        ) : leftTab === "wege" && admin ? (
          <div className="studio-sim-scroll">
            <RoutePanel floorId={floorId} onApplied={() => load(true)} />
          </div>
        ) : (<>
        <div className="studio-left-head">
          <InputGroup leftIcon="search" placeholder="Station suchen (alle Ebenen)" value={search} type="search"
            onChange={(e) => setSearch(e.target.value)} aria-label="Station suchen" />
          <div className="studio-filter-chips" role="group" aria-label="Stationen filtern">
            {([["all", "Alle"], ["hot", "Engpass"], ["laeuft", "Läuft"], ["frei", "Frei"]] as const).map(([id, label]) => (
              <Button key={id} small minimal active={statusFilter === id} text={label} onClick={() => setStatusFilter(id)} />
            ))}
          </div>
        </div>
        <div className="studio-summary" role="status">
          <span><b>{onFloor.length}</b> Stationen</span>
          {counts.ueber > 0 && <Tag minimal intent="danger">{counts.ueber} überbucht</Tag>}
          {counts.voll > 0 && <Tag minimal intent="warning">{counts.voll} wird voll</Tag>}
          {counts.laeuft > 0 && <Tag minimal intent="success">{counts.laeuft} läuft</Tag>}
          {counts.unbekannt > 0 && <Tag minimal>{counts.unbekannt} unbekannt</Tag>}
        </div>
        <ul className="studio-stations">
          {shownStations.map((s) => {
            const m = s.id != null ? marks[s.id] : undefined;
            return (
              <li key={s.id}>
                <button type="button" className={`studio-station${s.id === selectedId ? " is-selected" : ""}`}
                  data-kind={m?.kind ?? "unbekannt"} onClick={() => pick(s)}
                  aria-current={s.id === selectedId ? "true" : undefined}
                  aria-label={`${s.label}, ${m?.spoken ?? "unbekannt"}`}>
                  <span className="studio-dot" aria-hidden />
                  <span className="studio-station-main">
                    <span className="studio-station-name">{s.label}</span>
                    <span className="studio-station-sub">{TYPE_LABEL[s.type] ?? s.type} · {m?.word ?? STATUS_WORD.unbekannt}</span>
                  </span>
                  {(s.queue_jobs ?? 0) > 0 && <span className="studio-station-q mono">{s.queue_jobs}</span>}
                </button>
              </li>
            );
          })}
          {!shownStations.length && <li className="studio-empty">{search ? "Keine Station auf dieser Ebene passt." : "Keine Station auf dieser Ebene."}</li>}
          {otherFloorMatches.length > 0 && (
            <>
              <li className="studio-other-head">Auf anderen Ebenen ({otherFloorMatches.length})</li>
              {otherFloorMatches.map((s) => {
                const fid = topo ? stationFloor(s, topo) : null;
                const flEntry = site.floors.find((f) => f.floor.id === fid);
                return (
                  <li key={`other-${s.id}`}>
                    <button type="button" className="studio-station is-other-floor" onClick={() => pick(s, true)}>
                      <span className="studio-dot" aria-hidden />
                      <span className="studio-station-main">
                        <span className="studio-station-name">{s.label}</span>
                        <span className="studio-station-sub">{flEntry ? floorLabel(flEntry) : "Andere Ebene"} · {TYPE_LABEL[s.type] ?? s.type}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </>
          )}
        </ul>
        <p className="studio-left-foot">
          Gimel hat kein Maschinensignal: „läuft" ist gebucht, alles aus Plan und Warteschlange ist geschätzt (≈).
        </p>
        </>)}
        <div className="rail-foot">
          <KeyPopover
            minimal
            placement="top-start"
            content={
              <Menu>
                <MenuItem icon="layout" text="Digitaler Grundriss (2D)" href="/twin/" />
                <MenuItem icon="link" text="Studio-Link kopieren" onClick={() => void copyStudioLink()} />
                <MenuItem icon="refresh" text="Jetzt aktualisieren" onClick={() => load()} />
                <MenuDivider />
                <MenuItem icon="log-out" text="Abmelden" onClick={logout} />
              </Menu>
            }
          >
            <button type="button" className="rail-user-btn" aria-label="Kontomenü">
              <span className="rail-user-avatar" aria-hidden="true">
                <Icon icon="user" size={14} />
              </span>
              <span className="rail-user-main">
                <strong>{user.name || user.email}</strong>
                <span>{admin ? "Admin · Betrieb" : user.role}</span>
              </span>
              <Icon icon="more" size={14} aria-hidden="true" />
            </button>
          </KeyPopover>
          <SidebarUpdateButton isAdmin={canAdminWork(user)} />
          <AppSwitcher active="twin" />
        </div>
      </aside>

      <main className={`studio-stage${dropHover ? " is-drop" : ""}`} ref={stageRef}
        onDragOver={(e) => {
          if (!can3d || !e.dataTransfer.types.includes("application/x-gimel-walker")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!dropHover) setDropHover(true);
        }}
        onDragLeave={() => setDropHover(false)}
        onDrop={(e) => {
          setDropHover(false);
          if (!e.dataTransfer.types.includes("application/x-gimel-walker")) return;
          e.preventDefault();
          const p = threeRef.current?.floorPoint(e.clientX, e.clientY);
          if (!p) { toastInfo("Bitte auf den Hallenboden ziehen."); return; }
          setWalkFrom([Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
          startWalk(true);
        }}>
        {stage}
        {admin && view !== "edit" && !loading && ((floor?.outline?.length ?? 0) < 3) && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              background: "rgba(11, 15, 20, 0.72)",
              backdropFilter: "blur(4px)",
              zIndex: 15,
              padding: 20,
            }}
          >
            <div
              style={{
                maxWidth: 520,
                width: "100%",
                background: "var(--g-surface, #161b22)",
                border: "1px solid var(--g-line, #2a333f)",
                borderRadius: 14,
                padding: "24px 26px",
                boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
                display: "grid",
                gap: 14,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Icon icon="office" size={22} />
                <div>
                  <h2 style={{ margin: 0, fontSize: 18 }}>Erste Fabrikhalle einrichten</h2>
                  <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 2 }}>
                    Noch kein Hallenumriss hinterlegt — erstellen Sie Ihre Halle in wenigen Sekunden.
                  </div>
                </div>
              </div>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, opacity: 0.9 }}>
                Mit dem <b>Hallen-Assistenten</b> wählen Sie Grundform (Rechteck, L-, U- oder T-Halle), exakte Maße, Transportgänge, Tore, Funktionszonen und optionale Start-Maschinen mit Live-Vorschau.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                <Button
                  intent="primary"
                  icon="office"
                  text="Hallen-Assistent starten"
                  onClick={() => setCreatorOpen(true)}
                />
                <Button
                  icon="edit"
                  text="Im 2D-Editor frei zeichnen"
                  onClick={() => switchView("edit")}
                />
              </div>
            </div>
          </div>
        )}
        {view === "three" && gl !== false && !walk && !kiosk && (
          <div className="studio-cam" role="group" aria-label="Kamera">
            <Button small icon="undo" aria-label="Kamera nach links drehen" title="Nach links drehen" onClick={() => threeRef.current?.rotate(-45)} />
            <Button small icon="redo" aria-label="Kamera nach rechts drehen" title="Nach rechts drehen" onClick={() => threeRef.current?.rotate(45)} />
            <Button small icon="arrow-up" aria-label="Draufsicht" title="Draufsicht" onClick={() => threeRef.current?.preset("top")} />
            <Button small icon="media" aria-label="Frontansicht" title="Frontansicht: flach über den Boden" onClick={() => threeRef.current?.preset("front")} />
            <Button small icon="zoom-in" aria-label="Hineinzoomen" title="Hineinzoomen" onClick={() => threeRef.current?.zoom(1.25)} />
            <Button small icon="zoom-out" aria-label="Herauszoomen" title="Herauszoomen" onClick={() => threeRef.current?.zoom(1 / 1.25)} />
            <Button small icon="locate" aria-label="Einpassen" title="Auf die Halle einpassen" onClick={() => threeRef.current?.preset("iso")} />
          </div>
        )}
        {simFleet && (
          <div className="studio-sim-banner" role="status">
            <Icon icon="predictive-analysis" /> <b>Simulation</b>
            <span>{simResult!.summary.robots.filter((r) => r.planned).length} geplante Roboter · Schichtzeit {fmtSimClock(simT, simResult!.summary.horizon_s)}</span>
          </div>
        )}
        {walk && <div className="studio-hint" role="status"><Icon icon="walk" /><span>Begehen · Klick = Maus übernehmen · WASD/Pfeile gehen · Shift läuft · Rechtsklick = Menü · Q öffnet, X geht zur Station im Blick · Bild↑/↓ Ebene · Pos1 Start · H alle Tasten{admin ? " · rechts ziehen auf eine Station = verschieben, Strg+Z/Y" : ""} · Esc gibt die Maus frei, dann beendet</span></div>}
        {measure && <div className="studio-hint" role="status"><Icon icon="horizontal-inbetween" /><span>Messen · {measured.points < 2
          ? "Punkte auf den Boden klicken" : <>Strecke <b>{fmtMetres(measured.metres)}</b> über {measured.points} Punkte</>} · Rücktaste nimmt zurück · Esc leert</span></div>}
        {touring && (() => {
          const stops = tour ?? [];
          const i = Math.max(0, stops.findIndex((t) => t.id === tourStopId));
          const stop = stops[i];
          if (!stop) return <div className="studio-hint" role="status"><Icon icon="play" /><span>Vorführung{tourAt ? ` · ${tourAt}` : ""}</span></div>;
          const cap = tourCaption(stop, marks[stop.id], i, stops.length);
          return (
            <section className="studio-caption" aria-live="polite" aria-label="Vorführung">
              <div className="studio-caption-text">
                <span className="studio-caption-step">Vorführung · {cap.step}</span>
                <b>{cap.title}</b>
                <span>{cap.state}</span>
                {cap.why && <p>{cap.why}</p>}
              </div>
              {!kiosk && (
                <div className="studio-caption-actions">
                  <Button small minimal icon="chevron-left" aria-label="Voriger Halt (←)" title="Voriger Halt (←)"
                    onClick={() => threeRef.current?.tourStep(-1)} />
                  <Button small minimal icon={tourPaused ? "play" : "pause"} aria-pressed={tourPaused}
                    aria-label={tourPaused ? "Weiter (Leertaste)" : "Anhalten (Leertaste)"} title={tourPaused ? "Weiter (Leertaste)" : "Anhalten (Leertaste)"}
                    onClick={() => { const next = !tourPaused; setTourPaused(next); threeRef.current?.tourPause(next); }} />
                  <Button small minimal icon="chevron-right" aria-label="Nächster Halt (→)" title="Nächster Halt (→)"
                    onClick={() => threeRef.current?.tourStep(1)} />
                  <Button small minimal icon="cross" aria-label="Vorführung beenden (Esc)" title="Beenden (Esc)"
                    onClick={() => setTouring(false)} />
                </div>
              )}
            </section>
          );
        })()}
        {view === "three" && layers.minimap && floor && !kiosk && !narrow && gl !== false && (
          <Minimap floor={floor} stations={onFloor} marks={marks} selectedId={selectedId}
            robots={layers.robots ? robots : NO_ROBOTS} three={threeRef}
            onPick={(s) => pick(s, false)} />
        )}
        {kiosk && (
          <div className="studio-kiosk-head">
            <GimelMark size={20} /> <b>{here ? floorLabel(here, true) : "Halle"}</b>
            <span>Stand {refreshedAt ? clock(refreshedAt) : "—"}{stale ? " · veraltet" : ""}</span>
            {counts.ueber > 0 && <Tag intent="danger">{counts.ueber} überbucht</Tag>}
            {counts.voll > 0 && <Tag intent="warning">{counts.voll} wird voll</Tag>}
            <Button small minimal icon="cross" aria-label="Hallenbildschirm beenden" onClick={() => { setKiosk(false); setTouring(false); }} />
          </div>
        )}
      </main>

      {selected && !kiosk && (
        <aside className="studio-right" aria-label={`Station ${selected.label}`}>
          <Inspector station={selected} mark={selected.id != null ? marks[selected.id] : undefined} view={inspect}
            failed={inspectFailed} flow={flow} stations={stations}
            onPickStation={(s) => pick(s)} onClose={() => setSelectedId(null)} closeLabel="Schließen"
            onCopyLink={async (s) => {
              const ok = await copyToClipboard(`${window.location.origin}/app/#/station/${s.id}`);
              if (ok) toastSuccess("Link kopiert"); else toastError("Kopieren nicht möglich");
            }} />
          {forecast && <p className="studio-forecast-note"><Icon icon="time" size={12} /> Prognose ({stepLabel}): ≈ geschätzt, Zuordnen gesperrt.</p>}
        </aside>
      )}

      {agent && !kiosk && (
        <div className="studio-copilot">
          <CopilotDock open={copilot.open} onClose={() => copilot.setOpen(false)} user={user}
            reserve={leftOpen ? 320 : 0} minMain={420} />
        </div>
      )}

      {kiosk && selected && (
        <div className="studio-kiosk-card" aria-live="polite">
          <b>{selected.label}</b>
          <span>{selected.id != null ? marks[selected.id]?.word : ""}</span>
          <span className="mono">{(selected.queue_jobs ?? 0).toLocaleString("de-DE")} wartend</span>
        </div>
      )}

      {!kiosk && simFleet && (
        <footer className="studio-time studio-sim-time" aria-label="Simulationszeit">
          <Button icon={simPlaying ? "pause" : "play"} minimal aria-label={simPlaying ? "Simulation anhalten" : "Simulation abspielen"}
            onClick={() => setSimPlaying((p) => !p)} />
          <HTMLSelect aria-label="Abspielgeschwindigkeit" value={String(simSpeed)} onChange={(e) => setSimSpeed(Number(e.target.value))}
            options={[[30, "×30"], [60, "×60"], [120, "×120"], [300, "×300"], [600, "×600"]].map(([v, l]) => ({ value: String(v), label: String(l) }))} />
          <input type="range" className="studio-sim-range" min={0} max={Math.round(simResult!.summary.horizon_s)} step={10}
            value={Math.round(simT)} aria-label="Schichtzeit"
            aria-valuetext={fmtSimClock(simT, simResult!.summary.horizon_s)}
            onChange={(e) => { const v = Number(e.target.value); simClock.current.t = v; simClock.current.last = performance.now(); setSimT(v); }} />
          <span className="studio-stand mono">{fmtSimClock(simT, simResult!.summary.horizon_s)} / {fmtSimClock(simResult!.summary.horizon_s, simResult!.summary.horizon_s)}</span>
          <Button minimal icon="cross" text="Simulation beenden" onClick={() => setSimResult(null)} />
        </footer>
      )}
      {!kiosk && !simFleet && view !== "edit" && (
        <footer className="studio-time" aria-label="Zeit">
          <Button icon={playing ? "pause" : "play"} minimal aria-label={playing ? "Anhalten" : "Prognose abspielen"}
            disabled={!worklist} onClick={() => setPlaying((p) => !p)} />
          <div className="studio-steps" role="group" aria-label="Zeitpunkt">
            {STEPS.map((s, i) => (
              <button key={s.id} type="button" aria-pressed={step === s.id}
                className={`studio-step${step === s.id ? " is-on" : ""}`} disabled={!worklist && s.id !== 0}
                onClick={() => { setPlaying(false); setStep(s.id); }}>
                <span className="studio-step-label">{s.id === 0 ? "Jetzt" : `+${s.id} Tag${s.id > 1 ? "e" : ""}`}</span>
                <span className="studio-step-val mono" title={open[i].unknown > 0 ? `${open[i].unknown} Stationen ohne Zeitangabe` : undefined}>
                  {open[i].minutes > 0 ? `${s.id ? "≈ " : ""}${Math.round(open[i].minutes / 60).toLocaleString("de-DE")} h offen` : "frei"}
                  {open[i].unknown > 0 ? ` · ${open[i].unknown} ohne Angabe` : ""}
                </span>
              </button>
            ))}
          </div>
          <ButtonGroup className="studio-lenses" aria-label="Analyselinse">
            {LENSES.map((l) => (
              <Button key={l.id} small minimal active={lens === l.id} aria-pressed={lens === l.id}
                text={l.label} onClick={() => setLens(l.id)} />
            ))}
          </ButtonGroup>
          <span className="studio-time-note">
            {forecast ? <><Icon icon="warning-sign" size={12} /> Prognose · ≈ geschätzt</> : `${machineWork(worklist).length} Aufgaben im Vorrat`}
          </span>
          <span className="studio-stand mono" title="Letzter Abruf">
            {refreshedAt ? `Stand ${clock(refreshedAt)}` : "—"}{stale ? " · veraltet" : ""}
          </span>
        </footer>
      )}

      <HallCreatorDialog
        isOpen={creatorOpen}
        onClose={() => setCreatorOpen(false)}
        topo={topo}
        currentFloor={floor}
        onApplied={async (savedFloor) => {
          setLoadedFloor(savedFloor);
          setOtherFloors((m) => ({ ...m, [savedFloor.id]: savedFloor }));
          await site.reload();
          if (savedFloor.id) setFloorId(savedFloor.id);
          await load(true);
        }}
      />
      <Dialog isOpen={saveOpen} onClose={() => setSaveOpen(false)} title="Ansicht speichern" icon="camera">
        <form onSubmit={(e) => { e.preventDefault(); saveView(); }}>
          <DialogBody>
            <FormGroup label="Name" labelFor="studio-view-name"
              helperText={`Für ${here ? floorLabel(here, true) : "diese Ebene"}. Alle im Team sehen gespeicherte Ansichten.`}>
              <InputGroup id="studio-view-name" value={saveName} maxLength={80} autoFocus required
                onChange={(e) => setSaveName(e.target.value)} placeholder="z. B. Blick auf die Laser" />
            </FormGroup>
          </DialogBody>
          <DialogFooter actions={<>
            <Button onClick={() => setSaveOpen(false)} text="Abbrechen" />
            <Button type="submit" intent="primary" text="Speichern" disabled={!saveName.trim()} />
          </>} />
        </form>
      </Dialog>

    </div>
  );
}

function LayerItem({ on, label, onClick, disabled }: { on: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <li className="studio-layer">
      <Switch checked={on} label={label} disabled={disabled} onChange={onClick} className={Classes.FILL} />
    </li>
  );
}

/** Halle und Ebene in einer Auswahl — der Studio-Kopf hat keinen Platz für drei. */
function FloorPicker({ topo, floorId, onPick }: {
  topo: ReturnType<typeof useTopology>["topo"]; floorId: number | null; onPick: (id: number) => void;
}) {
  const withSite = (topo?.sites?.length ?? 0) > 1;
  const options = useMemo(
    () => allFloors(topo).map((r) => ({ value: r.floor.id, label: floorLabel(r, withSite) })),
    [topo, withSite],
  );
  if (options.length <= 1) return null;
  return (
    <HTMLSelect className="studio-floor" aria-label="Halle und Ebene" value={floorId ?? ""} options={options}
      onChange={(e) => onPick(Number(e.target.value))} />
  );
}
