import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Callout, Dialog, DialogBody, DialogFooter, Drawer, FormGroup, HTMLSelect, Icon, IconName, Menu, MenuDivider, MenuItem, PortalProvider, Spinner, Tab, Tabs, Tag } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import { api, canAdminWork, getUser, isWorker } from "../api";
import { navigate } from "../router";
import { toastError, toastSuccess } from "../toast";
import FloorPlan from "../components/FloorPlan";
import IsoFloorPlan from "../components/twin/IsoFloorPlan";
import RankBars from "../components/RankBars";
import Inspector, { StationViewData } from "../components/twin/Inspector";
import LagePanel, { HandlerSuggestion, PlanData, StationList } from "../components/twin/LagePanel";
import Legend from "../components/twin/Legend";
import TimeBand from "../components/twin/TimeBand";
import {
  buildMarks, byUrgency, Lens, machineSummary, machineWork, openAtStep, schedulesOf, STEPS, suggestionsBy, TimeStep,
} from "../components/twin/marks";
import {
  ALL_TYPES, copyToClipboard, EMPTY_FLOOR, Floor, FlowEdge, fmtM, PlanSuggestion,
  Robot, RobotJob, Station, StationType, stationUrl, TwinAnalysis, TwinFinding, TYPE_LABEL,
  WorklistData,
} from "../factory";
import { isTyping } from "../useShortcuts";
import FloorSwitcher from "../components/FloorSwitcher";
import LevelDialog from "../components/LevelDialog";
import SitesDialog from "../components/SitesDialog";
import { usePageContext, usePageProbe } from "@agentlab/pageContext";
import { twinPart, viewerProbe } from "../components/agent/twinContext";
import { floorLabel, stationFloor, useTopology } from "../sites";
import type { ThreeHandle } from "../components/twin/ThreeFloorPlan";
import type { WalkLevel } from "../components/twin/walkLevels";
import { carrySelection, sceneScope } from "../components/twin/twinScope";
import { useVersion } from "../useVersion";
import { KpiStrip, PageInfo, pageInfo, readFlag, useDetail, writeFlag } from "../ui";
import type { Kpi } from "../ui";
import { publishStations } from "../stationStore";

/* Leitstand: was jetzt eine Entscheidung braucht, nicht eine bunte Karte.

   Der Plan füllt die Seite, rechts steht die Lage, darunter die Zeit. Gimel hat
   kein Maschinensignal: Gebuchtes steht als feste Linie und Zahl, Geschätztes
   gestrichelt mit ≈, Unbekanntes als ?. Die Prognose ist eine Rechnung aus dem
   Plan und sperrt deshalb alles, was etwas ändert.

   Zuordnen bleibt ein eigener Klick neben der Begründung: ein Planer, dessen
   Vorschläge man nicht liest, bevor sie wirken, wäre ein Risiko. */

const REFRESH_MS = 30_000;
const STALE_MS = 90_000;
const PHONE = "(max-width: 720px)";
/** Ab dieser Breite steht die Lage ohne eigene Wahl offen; darunter gehört der Platz dem Plan (Aufgabe 41 F). */
const WIDE = "(min-width: 1600px)";
/** Ausdrückliche Wahl „Lage offen/zu", je Browser. Ein neuer Schlüssel: der alte wurde bei jedem Laden geschrieben. */
const SIDE_KEY = "gimel-leitstand-lage";
const NO_FLOW: FlowEdge[] = [];
const NO_ROBOTS: Robot[] = [];
const NO_JOBS: RobotJob[] = [];
const ThreeFloorPlan = lazy(() => import("../components/twin/ThreeFloorPlan"));

const clock = (d: Date) => d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const media = window.matchMedia(PHONE);
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return phone;
}

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setOn(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return on;
}

/** Vollbild für einen Bereich der Seite (Fullscreen API); Esc verlässt es wie gewohnt. */
function useFullscreen(): [(el: HTMLDivElement | null) => void, HTMLDivElement | null, boolean, () => void] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(!!el && document.fullscreenElement === el);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [el]);
  const toggle = useCallback(() => {
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { /* schon verlassen */ });
    else el.requestFullscreen?.().catch(() => toastError("Vollbild ist in diesem Browser nicht erlaubt."));
  }, [el]);
  return [setEl, el, on, toggle];
}

/** Höhe, die der Plan wirklich hat. Ein Callback-Ref, denn am Telefon hängt die Fläche am Reiter. */
function usePlanHeight(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      let bar = 0;
      el.querySelectorAll<HTMLElement>(".floor-toolbar").forEach((b) => { bar += b.offsetHeight; });
      setHeight(Math.max(200, el.clientHeight - bar - 2));
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    // Die 3D-Werkzeugleiste wird nachgeladen (lazy). Ohne diesen Beobachter
    // bliebe die gemessene Höhe um die Leiste zu groß: die Bühne ragte unten
    // aus der Karte heraus und Maßstab, Kompass und Hallenrand waren abgeschnitten.
    const swapped = new MutationObserver(measure);
    swapped.observe(el, { childList: true });
    return () => { seen.disconnect(); swapped.disconnect(); };
  }, [el]);
  return [setEl, height];
}

export default function TwinView() {
  const site = useTopology();
  const { topo, floorId, current: here } = site;
  /** 3D: zusätzlich gewählte Ebenen der Halle, die aktive bleibt voll. */
  const [extraFloors, setExtraFloors] = useState<number[]>([]);
  /** 3D: je Halle ein Häkchen — welche anderen Hallen desselben Standorts
      sichtbar und beim Begehen durchquerbar sind. */
  const [shownHalls, setShownHalls] = useState<number[]>([]);
  const [otherFloors, setOtherFloors] = useState<Record<number, Floor>>({});
  /** Zuletzt geladener Grundriss der gewählten Ebene; gezeigt wird ``floor`` (unten, mit Vorrat). */
  const [loadedFloor, setLoadedFloor] = useState<Floor | null>(null);
  /** Die gezeigte Ebene: aus dem Vorrat sofort, sonst die zuletzt geladene. Alles
      auf der Bühne geht von ihr aus (``sceneHere``), nicht von der gerade gewählten. */
  const floor = (floorId != null ? otherFloors[floorId] : undefined) ?? loadedFloor;
  const sceneHere = useMemo(
    () => site.floors.find((r) => r.floor.id === floor?.id) ?? here,
    [site.floors, floor?.id, here]);
  const [stations, setStations] = useState<Station[]>([]);
  const [flow, setFlow] = useState<FlowEdge[]>([]);
  const [flowTotal, setFlowTotal] = useState(0);
  const [worklist, setWorklist] = useState<WorklistData | null>(null);
  const [robots, setRobots] = useState<Robot[]>([]);
  const [robotsAt, setRobotsAt] = useState<string | null>(null);
  const [robotJobs, setRobotJobs] = useState<RobotJob[]>([]);
  const [showRobots, setShowRobots] = useState(true);
  const [levelOpen, setLevelOpen] = useState(false);
  const [sitesOpen, setSitesOpen] = useState(false);
  const [analysis, setAnalysis] = useState<TwinAnalysis | null>(null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [handlers, setHandlers] = useState<HandlerSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshFailed, setRefreshFailed] = useState("");
  const [partial, setPartial] = useState<string[]>([]);
  const filters = useMemo(() => new Set<StationType>(ALL_TYPES), []);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [auto, setAuto] = useState(true);
  const [why, setWhy] = useState<PlanSuggestion | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const lens: Lens = "last";
  const [step, setStep] = useState<TimeStep>(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<StationViewData | null>(null);
  const [viewFailed, setViewFailed] = useState(false);
  /** Semi-3D ist der Blick des Leitstands; der flache Plan bleibt als Vergleich. */
  const [planView, setPlanView] = useState<"three" | "iso" | "2d">(() => {
    try {
      const saved = localStorage.getItem("gimel-plan-view");
      if (saved === "2d" || saved === "three" || saved === "iso") return saved;
      if (saved === "3d") return "iso"; // bisherige Semi-3D-Ansicht
      // Am Telefon ist der flache Plan die ruhigere erste Ansicht; 3D bleibt einen Klick entfernt.
      return window.matchMedia(PHONE).matches ? "2d" : "iso";
    } catch { return "iso"; }
  });
  const [showFlow, setShowFlow] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  /** Begehen in Augenhöhe — auch hier, durch Türen bis in die Nachbarhalle. */
  const [walk, setWalk] = useState(false);
  const threeRef = useRef<ThreeHandle | null>(null);
  /** Halle und Wege: Fahrspuren, Handwege, Hallenrahmen/-hülle und Dach
      lassen sich je Ansicht zuschalten, ohne die Karte zu überladen. */
  const [extras, setExtras] = useState({ shell: true, roof: false, lanes: true, paths: true, frame: true, collisions: true });
  // Belebung (dargestellt): ohne eigene Wahl nur in der Demo an.
  const demo = useVersion()?.demo === true;
  const [stagedChoice, setStagedChoice] = useState<boolean | null>(null);
  const staged = stagedChoice ?? demo;
  const toggleExtra = (key: keyof typeof extras) => setExtras((v) => ({ ...v, [key]: !v[key] }));
  /** Welche Verbindungen der Plan zeigt: alle, eine Richtung oder eine Art. */
  const [flowFilter, setFlowFilter] = useState<{
    from: number | "all"; to: number | "all"; kind: "all" | "supply" | "dispatch";
  }>({ from: "all", to: "all", kind: "all" });
  const [filterOpen, setFilterOpen] = useState(false);
  /** Breite der Lage-Spalte, per Griff ziehbar und je Browser gemerkt. */
  const [sideWidth, setSideWidth] = useState(() => {
    try {
      const n = Number(localStorage.getItem("gimel-leitstand-side"));
      return Number.isFinite(n) && n >= 280 && n <= 620 ? n : 340;
    } catch { return 340; }
  });
  const [resizing, setResizing] = useState(false);
  /** Die ganze Lage-Spalte: eine eigene Wahl gilt je Browser; ohne sie offen ab 1600 px, darunter zu. */
  const wide = useMedia(WIDE);
  const [sideChoice, setSideChoice] = useState<boolean | null>(() => readFlag(SIDE_KEY));
  const sideOpen = sideChoice ?? wide;
  const setSideOpen = (open: boolean) => { setSideChoice(open); writeFlag(SIDE_KEY, open); };
  useEffect(() => {
    try { localStorage.setItem("gimel-leitstand-side", String(sideWidth)); } catch { /* privater Modus */ }
  }, [sideWidth]);
  const [mainBox, mainEl, fullscreen, toggleFullscreen] = useFullscreen();
  const { simple } = useDetail();
  const startResize = (e: React.PointerEvent) => {
    if (phone) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = sideWidth;
    setResizing(true);
    const move = (ev: PointerEvent) => {
      setSideWidth(Math.max(280, Math.min(620, startW - (ev.clientX - startX))));
    };
    const stop = () => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  const resizeKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); setSideWidth((w) => Math.min(620, w + 20)); }
    if (e.key === "ArrowRight") { e.preventDefault(); setSideWidth((w) => Math.max(280, w - 20)); }
  };
  useEffect(() => {
    try { localStorage.setItem("gimel-plan-view", planView); } catch { /* privater Modus */ }
  }, [planView]);
  const [finding, setFinding] = useState<{ idx: number; ids: number[] } | null>(null);
  const [tab, setTab] = useState("lage");
  const phone = usePhone();
  const [planBox, planHeight] = usePlanHeight();
  /** Woher die Auswahl kam: die Lage hängt beim Inspektor aus, darum zählt die Nummer, nicht das Element. */
  const pickedFrom = useRef<"plan" | "list">("plan");
  const focusStation = useRef<number | null>(null);
  /** Nach Zuordnen oder Übernehmen: nächster Knopf der Liste, sonst die Überschrift. */
  const focusNext = useRef<{ section: string; index: number } | null>(null);

  const office = !isWorker();
  const isAdmin = canAdminWork(getUser());
  const forecast = step !== 0;

  // Eine Ladung je Aktualisierung; eine langsame ältere Antwort überschreibt keine neuere.
  const loadId = useRef(0);
  const load = useCallback(async (silent = false) => {
    const id = ++loadId.current;
    if (!silent) setLoading(true);
    const results = await Promise.allSettled([
      api<Floor>(floorId ? `/api/factory/floor?floor_id=${floorId}` : "/api/factory/floor"),
      api<Station[]>("/api/factory/stations"),
      api<{ edges: FlowEdge[]; total_transport_m: number }>("/api/factory/flow"),
      api<WorklistData>("/api/factory/worklist"),
      // Befunde und Planung sind Büroarbeit, wie die Seite Optimierung; Werker sehen die Halle.
      office ? api<TwinAnalysis>("/api/factory/twin/analysis") : Promise.resolve(null),
      office ? api<PlanData>("/api/factory/plan") : Promise.resolve(null),
      office ? api<{ suggestions: HandlerSuggestion[] }>("/api/factory/handlers/plan") : Promise.resolve(null),
      api<{ robots: Robot[]; sampled_at: string; simulated: boolean }>(
        floorId ? `/api/factory/robots?floor_id=${floorId}` : "/api/factory/robots"),
      api<{ jobs: RobotJob[] }>(
        `/api/factory/robot-jobs?active=true${floorId ? `&floor_id=${floorId}` : ""}`),
    ]);
    if (id !== loadId.current) return;
    const [f, st, fl, wl, an, pl, hd, rb, rj] = results;
    setLoading(false);
    if (f.status === "rejected" || st.status === "rejected") {
      const reason = f.status === "rejected" ? f.reason : (st as PromiseRejectedResult).reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      setRefreshFailed(msg);
      if (!silent) { setError(msg); toastError(msg); }
      return;
    }
    const plan: Floor = { ...EMPTY_FLOOR, ...f.value, aisles: f.value.aisles ?? { nodes: [], edges: [] } };
    setLoadedFloor(plan);
    setOtherFloors((m) => ({ ...m, [plan.id]: plan }));
    setStations(st.value);
    publishStations(st.value);
    const missing: string[] = [];
    if (fl.status === "fulfilled") { setFlow(fl.value.edges); setFlowTotal(fl.value.total_transport_m); } else missing.push("Materialfluss");
    // Ohne Arbeitsvorrat gibt es keine Prognose, die Seite fällt auf Jetzt zurück.
    if (wl.status === "fulfilled") setWorklist(wl.value); else { setWorklist(null); setStep(0); missing.push("Arbeitsvorrat"); }
    if (an.status === "fulfilled") setAnalysis(an.value); else missing.push("Auffälligkeiten");
    if (pl.status === "fulfilled") setPlan(pl.value); else missing.push("Maschinenplanung");
    if (hd.status === "fulfilled") setHandlers(hd.value?.suggestions ?? []); else missing.push("Auftragsbearbeitung");
    if (rb.status === "fulfilled") { setRobots(rb.value.robots ?? []); setRobotsAt(rb.value.sampled_at ?? null); }
    else { setRobots([]); setRobotsAt(null); missing.push("Roboter"); }
    if (rj.status === "fulfilled") setRobotJobs(rj.value.jobs ?? []);
    else { setRobotJobs([]); missing.push("Transporte"); }
    setPartial(missing);
    const stamp = new Date();
    setRefreshedAt(stamp);
    setNow(stamp.getTime());
    setRefreshFailed("");
    setError("");
  }, [office, floorId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => { if (!document.hidden) load(true); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [auto, load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    const wake = () => { if (!document.hidden && auto) load(true); };
    document.addEventListener("visibilitychange", wake);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", wake); };
  }, [auto, load]);

  const stale = refreshedAt != null && now - refreshedAt.getTime() > STALE_MS;

  // Die Stationssicht kommt erst bei der Auswahl, dann mit jeder Aktualisierung.
  const shownFor = useRef<number | null>(null);
  useEffect(() => {
    if (selectedId == null) { shownFor.current = null; return; }
    let current = true;
    if (shownFor.current !== selectedId) { setView(null); setViewFailed(false); shownFor.current = selectedId; }
    api<StationViewData>(`/api/factory/stations/${selectedId}/view`)
      // Eine Antwort ohne Warteschlange (alter Server, Fehlerkörper) gilt als
      // nicht geladen — vorher riss sie die ganze Seite weiß (task 41 H).
      .then((v) => { if (current) { const ok = !!v && Array.isArray(v.queue); setView(ok ? v : null); setViewFailed(!ok); } })
      .catch(() => { if (current) setViewFailed(true); });
    return () => { current = false; };
  }, [selectedId, refreshedAt]);

  const schedules = useMemo(() => schedulesOf(worklist), [worklist]);
  const marks = useMemo(
    () => buildMarks({ stations, schedules, suggestions: suggestionsBy(worklist), step, lens, flow, stale }),
    [stations, schedules, worklist, step, lens, flow, stale]);
  const open = useMemo(() => {
    const o = (s: TimeStep) => openAtStep(stations, s);
    return { 0: o(0), 1: o(1), 2: o(2), 3: o(3) };
  }, [stations]);
  const unknownMax = useMemo(() => Math.max(0, ...stations
    .filter((s) => !s.capacity_min_per_day).map((s) => s.queue_min ?? 0)), [stations]);
  const filteredFlow = useMemo(() => flow.filter((e) =>
    (flowFilter.from === "all" || e.from === flowFilter.from)
    && (flowFilter.to === "all" || e.to === flowFilter.to)
    && (flowFilter.kind === "all" || e.kind === flowFilter.kind)
  ), [flow, flowFilter]);
  const visible = useMemo(() => stations.filter((s) => filters.has(s.type)), [stations, filters]);
  /** Was der Plan zeigt: nur die gewählte Ebene. Lage und Kennzahlen bleiben beim ganzen Betrieb. */
  const shownFloorId = floor?.id ?? floorId;
  const onFloor = useMemo(
    () => (topo ? visible.filter((s) => stationFloor(s, topo) === shownFloorId) : visible),
    [visible, topo, shownFloorId]);
  /** Ebenen dieser Halle für Treppe und Aufzug beim Begehen. */
  const walkLevels = useMemo<WalkLevel[]>(() => (sceneHere?.hall?.floors ?? []).map((f) => ({
    id: f.id, label: f.level_name || `Ebene ${f.level}`,
    elevation_m: Number(f.elevation_m) || 0, level: f.level || 0,
  })), [sceneHere]);
  /* Ein Wechsel der Ebene oder Halle nimmt die Auswahl mit: der Stapel bleibt
     (die verlassene Ebene darin), dieselben Stufen in der neuen Halle, die
     verlassene Halle bleibt sichtbar, wenn schon Hallen gezeigt wurden oder man
     hinübergegangen ist. Bis 2026-11-07 fiel beides beim Wechsel weg. */
  const prevHere = useRef(here);
  useEffect(() => {
    const prev = prevHere.current;
    prevHere.current = here;
    if (!prev || !here || prev.floor.id === here.floor.id) return;
    const next = carrySelection(prev, here, { extra: extraFloors, halls: shownHalls }, walk);
    setExtraFloors(next.extra);
    setShownHalls(next.halls);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here?.floor.id]);
  // Begehen gibt es nur in 3D.
  useEffect(() => { if (planView !== "three") setWalk(false); }, [planView]);
  /** Stapel, Nachbarhallen (mit denselben Stufen) und Höhe — dieselbe Rechnung
      wie im Twin Studio (``twinScope.ts``), immer von der gezeigten Ebene aus. */
  const scope = useMemo(() => sceneScope({
    here: sceneHere, stack: extraFloors, halls: shownHalls,
    floors: otherFloors, stations: visible, topo, enabled: planView === "three",
  }), [sceneHere, extraFloors, shownHalls, otherFloors, visible, topo, planView]);
  const { ghosts, neighbors: neighborHalls, activeOffset } = scope;
  const wantedFloorIds = useMemo(() => {
    const ids = new Set(scope.wanted);
    // Beim Begehen die Ebenen dieser Halle vorab holen: Treppe und Aufzug ohne Wartezeit.
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
        .catch(() => { /* eine fehlende Ebene fehlt nur im Bild */ });
    }
    return () => { live = false; };
  }, [wantedFloorIds, otherFloors]);
  /* Der Assistent sieht mit, was hier zu sehen ist (Auswahl, Ebene, Darstellung,
     Stapel, Nachbarhallen, Begehen); Standpunkt und Blick erst beim Senden. */
  usePageContext(useMemo(() => twinPart({
    where: "portal", floor, floorLabel: sceneHere ? floorLabel(sceneHere, true) : undefined,
    stations: onFloor, selectedId, mode: planView, step, analysis, robots,
    layers: { fluss: showFlow, beschriftung: showLabels, roboter: showRobots, kollisionen: extras.collisions },
    shownLevels: scope.shownLevels, shownHalls: scope.shownHalls, walking: walk,
  }), [floor, sceneHere, onFloor, selectedId, planView, step, analysis, robots, showFlow, showLabels, showRobots,
    extras.collisions, scope.shownLevels, scope.shownHalls, walk]));
  usePageProbe(() => viewerProbe(planView, threeRef.current?.getViewer()));
  const hallMap = useMemo(() => {
    const h = sceneHere?.hall;
    return h && h.map_enabled && (h.lat || h.lon) ? { lat: h.lat, lon: h.lon, rotation_deg: h.rotation_deg } : null;
  }, [sceneHere]);
  const sorted = useMemo(() => byUrgency(visible, marks), [visible, marks]);
  const loads = useMemo(() => {
    const m: Record<number, number> = {};
    for (const s of stations) if (s.id != null) m[s.id] = s.queue_min ?? 0;
    return m;
  }, [stations]);
  const findings = useMemo(() => {
    const order: Record<string, number> = { danger: 0, warning: 1, info: 2, success: 3 };
    return [...(analysis?.findings ?? [])].sort((a, b) => (order[a.severity] ?? 2) - (order[b.severity] ?? 2));
  }, [analysis]);

  const closeStation = useCallback(() => {
    focusStation.current = selectedId;
    setSelectedId(null);
  }, [selectedId]);
  const { setFloorId } = site;
  /** Treppe, Aufzug oder Tür: die Ebene wechselt; ``carrySelection`` hält die
      verlassene Halle sichtbar, damit derselbe Weg zurückführt. */
  const walkToLevel = useCallback((id: number) => setFloorId(id), [setFloorId]);
  const pickStation = useCallback((s: Station) => {
    pickedFrom.current = document.activeElement?.closest(".lage-station") ? "list" : "plan";
    setSelectedId((id) => (id === s.id ? null : s.id ?? null));
    // Aus der Lage gewählt, aber auf einer anderen Ebene: dorthin wechseln.
    const fid = topo ? stationFloor(s, topo) : null;
    if (fid != null && fid !== floorId) setFloorId(fid);
  }, [topo, floorId, setFloorId]);

  /* Der Assistent darf eine Station zeigen: hier wird sie ausgewählt und die
     Kamera fährt hin. Alles andere (Bearbeiten, Platzieren) gehört ins Studio. */
  useEffect(() => {
    const onAction = (event: Event) => {
      const action = (event as CustomEvent).detail as Record<string, unknown> | null;
      if (!action) return;
      const kind = String(action.type || "");
      if (kind === "navigate") {
        const route = String(action.route || "");
        if (route.startsWith("/app")) navigate(route.replace(/^\/app\/?/, "") || "");
        return;
      }
      if (kind === "set_floor") {
        const fid = Number(action.floor_id);
        if (Number.isFinite(fid) && fid > 0 && fid !== floorId) setFloorId(fid);
        return;
      }
      if (kind === "set_view_mode") {
        const m = String(action.mode || "");
        if (m === "three" || m === "iso") setPlanView(m);
        else if (m === "plan") setPlanView("2d");
        return;
      }
      if (kind === "highlight") {
        const ids = Array.isArray(action.station_ids) ? action.station_ids.map(Number).filter(Number.isFinite) : [];
        setFinding(ids.length ? { idx: -1, ids } : null);
        return;
      }
      if (kind === "clear_highlight") { setFinding(null); return; }
      if (kind === "focus" && action.station_id == null) return;
      if (kind !== "select_station" && kind !== "focus") return;
      const id = Number(action.station_id);
      const station = stations.find((s) => s.id === id);
      if (!station || station.id == null) return;
      pickedFrom.current = "plan";
      setSelectedId(station.id);
      const fid = topo ? stationFloor(station, topo) : null;
      if (fid != null && fid !== floorId) { setFloorId(fid); return; }
      if (planView === "three") threeRef.current?.flyToStation(station.id);
    };
    window.addEventListener("gimel:copilot-action", onAction);
    return () => window.removeEventListener("gimel:copilot-action", onAction);
  }, [stations, topo, floorId, setFloorId, planView]);

  // Erst nach dem Zeichnen: die Liste hängt gerade wieder ein, ein Blatt muss zu sein.
  useEffect(() => {
    if (selectedId != null || focusStation.current == null) return;
    const id = focusStation.current;
    focusStation.current = null;
    const list = document.querySelector<HTMLElement>(`.lage-station[data-station-id="${id}"]`);
    const plan = document.querySelector(`.twin-body[data-station-id="${id}"]`)?.closest<SVGElement>(".twin-station");
    (pickedFrom.current === "list" ? list ?? plan : plan ?? list)?.focus();
  }, [selectedId]);

  useEffect(() => {
    const next = focusNext.current;
    if (!next || applying) return;
    focusNext.current = null;
    const box = document.querySelector<HTMLElement>(`[data-lage-section="${next.section}"]`);
    // Eine zugeklappte Gruppe öffnet sich, damit der nächste Knopf wirklich sichtbar ist.
    if (box instanceof HTMLDetailsElement && !box.open) box.open = true;
    const rows = box?.querySelectorAll<HTMLElement>("[data-row-key]:not([disabled])");
    (rows?.[next.index] ?? box?.querySelector<HTMLElement>(".twin-panel-sub"))?.focus();
  }, [plan, handlers, applying]);

  const rememberRow = (section: string, key: string) => {
    const rows = [...document.querySelectorAll<HTMLElement>(`[data-lage-section="${section}"] [data-row-key]`)];
    focusNext.current = { section, index: Math.max(0, rows.findIndex((b) => b.dataset.rowKey === key)) };
  };

  // Esc zuerst zurück auf Jetzt, dann zurück zur Lage. Nie über einem Dialog und nie beim Tippen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isTyping(e.target) || document.body.classList.contains("bp5-overlay-open")) return;
      if (step !== 0) setStep(0);
      else if (selectedId != null) closeStation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, selectedId, closeStation]);

  const applyOne = async (s: PlanSuggestion) => {
    if (s.station_id == null || forecast) return;
    setApplying(s.job_no);
    try {
      await api(`/api/factory/work-orders/${s.job_no}/assign`, {
        method: "POST",
        body: JSON.stringify({ station_id: s.station_id, note: s.reason }),
      });
      toastSuccess(`${s.job_no} → ${s.label}.`);
      setWhy(null);
      rememberRow("zuordnung", s.job_no);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setApplying(null); }
  };

  const applyAllAuto = async () => {
    if (forecast) return;
    try {
      const r = await api<{ count: number }>("/api/factory/plan/apply", {
        method: "POST", body: JSON.stringify({}),
      });
      toastSuccess(`${r.count === 1 ? "1 Innenauftrag" : `${r.count} Innenaufträge`} zugeordnet.`);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  const setHandler = async (h: HandlerSuggestion) => {
    if (h.user_id == null || forecast) return;
    try {
      await api(`/api/factory/orders/${h.order_no}/handler`, {
        method: "POST", body: JSON.stringify({ user_id: h.user_id, note: h.reason }),
      });
      toastSuccess(`${h.order_no} → ${h.name}.`);
      rememberRow("bearbeiter", h.order_no);
      setHandlers((hs) => hs.filter((x) => x.order_no !== h.order_no));
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyStationLink = async (s: Station) => {
    if (s.id == null) return;
    if (await copyToClipboard(stationUrl(s.id))) toastSuccess(`Link auf ${s.label} kopiert.`);
    else toastError(stationUrl(s.id));
  };

  const pickFinding = (idx: number | null, f: TwinFinding | null) =>
    setFinding(idx == null || !f ? null : { idx, ids: f.station_ids });

  if (loading && !floor) return <div className="twin-center"><Spinner size={36} /></div>;
  if (error && !floor) return <div className="twin-center twin-error">{error}</div>;
  if (!floor) return null;

  const selected = stations.find((s) => s.id === selectedId) ?? null;
  /** Eine gewählte Station zeigt sich im Panel, auch wenn die Lage eingeklappt ist. */
  const sideShown = sideOpen || selected != null;
  const noAisles = !(floor.aisles?.edges?.length);
  const active = `${stations.filter((s) => s.active).length} von ${stations.length} Stationen aktiv`;
  const machines = machineSummary(stations);
  const summary = { text: `${active} · ${machines.text}`, spoken: `${active}, ${machines.spoken}` };
  const running = stations.filter((s) => s.id != null && marks[s.id]?.kind === "laeuft").length;
  const waiting = stations.filter((s) => {
    const k = s.id != null ? marks[s.id]?.kind : undefined;
    return k === "wartet" || k === "voll" || k === "ueber";
  }).length;
  const tight = stations.filter((s) => {
    const k = s.id != null ? marks[s.id]?.kind : undefined;
    return k === "voll" || k === "ueber";
  }).length;
  const filterActive = flowFilter.from !== "all" || flowFilter.to !== "all" || flowFilter.kind !== "all";
  const flowCount = filteredFlow.length;
  const transport = Math.round(filterActive
    ? filteredFlow.reduce((sum, e) => sum + e.metres, 0)
    : flowTotal).toLocaleString("de-DE");
  const stationName = (id: number | "all") => id === "all" ? "" : stations.find((s) => s.id === id)?.label ?? `#${id}`;
  const filterText = [
    flowFilter.from !== "all" ? `von ${stationName(flowFilter.from)}` : "",
    flowFilter.to !== "all" ? `nach ${stationName(flowFilter.to)}` : "",
    flowFilter.kind !== "all" ? (flowFilter.kind === "supply" ? "Material" : "Versand") : "",
  ].filter(Boolean).join(" · ");
  const filterEdge = (edge: FlowEdge) => {
    setFlowFilter({ from: edge.from, to: edge.to, kind: edge.kind === "supply" ? "supply" : "dispatch" });
    setShowFlow(true);
    setFilterOpen(false);
    toastSuccess(`Wege gefiltert: ${stationName(edge.from)} → ${stationName(edge.to)}.`);
  };
  const clearFlowFilter = () => setFlowFilter({ from: "all", to: "all", kind: "all" });

  /* Seltene Wege und Pflege stehen im Menü „Mehr" (Aufgabe 41 F): kein Knopf
     verschwindet, er zieht nur um. Aktualisieren und Pause stehen an der Uhr. */
  const actions: { icon: IconName; text: string; title?: string; onClick: () => void; show: boolean; group: "go" | "edit" }[] = [
    { icon: "grid-view", text: "Schachteln", title: "Plattenbelegung sehen und von Hand ändern", onClick: () => navigate("schachteln"), show: office, group: "go" },
    { icon: "cube", text: "Bereitstellen", title: "Welche Platten an welche Maschine müssen, der Schritt vor dem Schnitt", onClick: () => navigate("grundriss/bereitstellen"), show: true, group: "go" },
    { icon: "exchange", text: "Roboter", title: "Roboterflotte pflegen: Typen, Wege, Fähigkeiten", onClick: () => navigate("roboter"), show: false, group: "go" },
    { icon: "flame", text: "Optimierung", title: "Was sich an der Halle verbessern ließe", onClick: () => navigate("grundriss/optimierung"), show: office, group: "go" },
    { icon: "edit", text: "Halle bearbeiten", title: isAdmin ? undefined : "Speichern kann nur ein Admin-Konto", onClick: () => navigate("grundriss/admin"), show: office, group: "edit" },
    { icon: "office", text: "Standorte & Ebenen", title: "Standort, Halle oder Ebene anlegen und pflegen", onClick: () => setSitesOpen(true), show: isAdmin, group: "edit" },
    { icon: "layers", text: "Ebenen verwalten", title: "Ebenen anlegen und löschen", onClick: () => setLevelOpen(true), show: isAdmin && !!here?.hall, group: "edit" },
  ];
  const shownActions = actions.filter((a) => a.show);
  const moreMenu = (
    <KeyPopover placement="bottom-end" className="leitstand-more" content={
      <Menu>
        {shownActions.filter((a) => a.group === "go").map((a) => (
          <MenuItem key={a.text} icon={a.icon} text={a.text} title={a.title} onClick={a.onClick} />
        ))}
        {shownActions.some((a) => a.group === "edit") && <MenuDivider />}
        {shownActions.filter((a) => a.group === "edit").map((a) => (
          <MenuItem key={a.text} icon={a.icon} text={a.text} title={a.title} onClick={a.onClick} />
        ))}
      </Menu>}>
      <Button small={!phone} icon="more" rightIcon={phone ? undefined : "caret-down"} text={phone ? undefined : "Mehr"}
        aria-label="Mehr"
        title="Weitere Seiten zur Halle: Schachteln, Bereitstellen, Roboter, Optimierung, Halle bearbeiten" />
    </KeyPopover>
  );

  const warnCount = findings.filter((f) => f.severity === "danger" || f.severity === "warning").length;
  const kpis: Kpi[] = [
    { id: "laeuft", label: "In Arbeit", value: running, dot: "laeuft" },
    { id: "wartet", label: "Wartend", value: waiting, dot: "wartet" },
    { id: "engpass", label: "Engpass", value: tight, dot: "engpass", tone: tight > 0 ? "warning" : "none" },
    { id: "weg", label: "Materialweg", value: flowCount ? `${transport} m` : null, dot: "weg",
      sub: flowCount ? `${flowCount} ${flowCount === 1 ? "Weg" : "Wege"}${filterActive ? " · gefiltert" : ""}`
        : filterActive ? "kein Treffer" : "keine Wege",
      title: flowCount ? undefined : "Kein Materialweg bekannt: unbekannt, nicht 0 m" },
  ];

  const statusLine = (
    <header className="leitstand-status">
      <h1 className="page-title">{floor.name || "Digitaler Grundriss"}</h1>
      {pageInfo("grundriss") && <PageInfo text={pageInfo("grundriss")} />}
      <span className="leitstand-stand">
        <span role="status" className={stale ? "leitstand-stale" : undefined}>
          {stale && <><Icon icon="warning-sign" size={13} aria-hidden /> Daten veraltet ·</>}
        </span>
        {stale ? " " : ""}
        {refreshedAt ? `Stand ${clock(refreshedAt)}` : ""}
      </span>
      <span className="leitstand-live">
        <Button small minimal icon={auto ? "pause" : "play"} loading={false}
          aria-label={auto ? "Aktualisierung pausieren" : "Aktualisierung fortsetzen"}
          title={auto ? "Aktualisierung pausieren (alle 30 Sekunden)" : "Aktualisierung fortsetzen (alle 30 Sekunden)"}
          onClick={() => setAuto(!auto)} />
        <Button small minimal icon="refresh" loading={loading} aria-label="Aktualisieren" title="Jetzt aktualisieren"
          onClick={() => load()} />
      </span>
      <span className={"leitstand-mode" + (forecast ? " leitstand-mode-forecast" : "")}>
        {forecast ? "Prognose" : "Jetzt"}
      </span>
      {refreshFailed && <span role="alert" className="leitstand-failed">Aktualisierung fehlgeschlagen</span>}
      {!phone && <KpiStrip items={kpis} inline label="Hallenkennzahlen" className="leitstand-kpis" />}
      <span className="leitstand-head-end">
        {!phone && office && warnCount > 0 && !sideOpen && (
          <Button small intent="warning" icon="warning-sign" className="leitstand-findings"
            text={`${warnCount} ${warnCount === 1 ? "Auffälligkeit" : "Auffälligkeiten"}`}
            title="Lage mit Auffälligkeiten und Zuordnungen einblenden" onClick={() => setSideOpen(true)} />
        )}
        {moreMenu}
      </span>
    </header>
  );

  const banner = (
    <div role="status">
      {forecast && (
        <Callout compact intent="warning" icon="time" className="leitstand-banner">
          <span>Prognose: aus dem Plan gerechnet, ohne neue Aufträge, volle Tageskapazität ab jetzt. Aktionen gesperrt.</span>
          <Button small text="Zurück zu Jetzt" onClick={() => setStep(0)} />
        </Callout>
      )}
    </div>
  );

  const layerItems = (
    <>
      <MenuItem icon={showFlow ? "eye-open" : "eye-off"} active={showFlow} text="Materialwege" shouldDismissPopover={false}
        onClick={() => setShowFlow((v) => !v)} />
      <MenuItem icon="tag" active={showLabels} text="Beschriftungen" shouldDismissPopover={false}
        onClick={() => setShowLabels((v) => !v)} />
      <MenuItem icon={extras.lanes ? "eye-open" : "eye-off"} active={extras.lanes} text="Fahrspuren"
        shouldDismissPopover={false} onClick={() => toggleExtra("lanes")} />
      <MenuItem icon={extras.paths ? "eye-open" : "eye-off"} active={extras.paths} text="Handwege"
        shouldDismissPopover={false} onClick={() => toggleExtra("paths")} />
      {planView === "three" ? (
        <>
          <MenuItem icon={extras.shell ? "eye-open" : "eye-off"} active={extras.shell} text="Hallenhülle"
            shouldDismissPopover={false} onClick={() => toggleExtra("shell")} />
          <MenuItem icon={extras.roof ? "eye-open" : "eye-off"} active={extras.roof} text="Dach"
            shouldDismissPopover={false} onClick={() => toggleExtra("roof")} />
          <MenuItem icon={extras.collisions ? "eye-open" : "eye-off"} active={extras.collisions} text="Kollisionen"
            shouldDismissPopover={false} onClick={() => toggleExtra("collisions")} />
          <MenuItem icon={staged ? "eye-open" : "eye-off"} active={staged} text="Belebung (dargestellt, nicht gemessen)"
            shouldDismissPopover={false} onClick={() => setStagedChoice(!staged)} />
        </>
      ) : (
        <MenuItem icon={extras.frame ? "eye-open" : "eye-off"} active={extras.frame} text="Hallenrahmen"
          shouldDismissPopover={false} onClick={() => toggleExtra("frame")} />
      )}
      {planView === "three" && robots.some((r) => r.active
        && (r.simulated ? r.route.length >= 2 : r.x != null && r.y != null)) && (
        <MenuItem icon="exchange" active={showRobots} text="Roboter" shouldDismissPopover={false}
          onClick={() => setShowRobots((v) => !v)} />
      )}
    </>
  );

  const flowFilterPanel = (
    <div className="flow-filter-panel" role="group" aria-label="Wege filtern">
      <h4 className="flow-filter-title">Verbindungen filtern</h4>
      <p className="sub">Zeigt nur die Wege, die zu dieser Frage gehören.</p>
      <FormGroup label="Von Station" labelFor="flow-from">
        <HTMLSelect id="flow-from" fill value={String(flowFilter.from)}
          onChange={(e) => setFlowFilter((f) => ({ ...f, from: e.currentTarget.value === "all" ? "all" : Number(e.currentTarget.value) }))}>
          <option value="all">Alle Stationen</option>
          {[...stations].sort((a, b) => a.label.localeCompare(b.label, "de")).map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </HTMLSelect>
      </FormGroup>
      <FormGroup label="Nach Station" labelFor="flow-to">
        <HTMLSelect id="flow-to" fill value={String(flowFilter.to)}
          onChange={(e) => setFlowFilter((f) => ({ ...f, to: e.currentTarget.value === "all" ? "all" : Number(e.currentTarget.value) }))}>
          <option value="all">Alle Stationen</option>
          {[...stations].sort((a, b) => a.label.localeCompare(b.label, "de")).map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </HTMLSelect>
      </FormGroup>
      <FormGroup label="Art" labelFor="flow-kind">
        <HTMLSelect id="flow-kind" fill value={flowFilter.kind}
          onChange={(e) => setFlowFilter((f) => ({ ...f, kind: e.currentTarget.value as "all" | "supply" | "dispatch" }))}>
          <option value="all">Material und Versand</option>
          <option value="supply">Material (Lager → Maschine)</option>
          <option value="dispatch">Versand (Maschine → Versand)</option>
        </HTMLSelect>
      </FormGroup>
      <div className="flow-filter-summary">
        <Tag minimal intent={filterActive ? "primary" : "none"}>{filteredFlow.length} Wege</Tag>
        {filterActive && <Button small minimal icon="filter-remove" text="Zurücksetzen" onClick={clearFlowFilter} />}
      </div>
    </div>
  );

  /* Eine Leiste über der Bühne: Ort, Ansicht (Plan · Semi-3D · 3D), Begehen,
     „Ansicht ▾" mit Ebenen und Wegefilter, Legende, Vollbild. */
  const views: { id: "2d" | "iso" | "three"; text: string; icon: IconName; title: string }[] = [
    { id: "2d", text: "Plan", icon: "layout", title: "Flacher Grundriss, wie im Editor" },
    { id: "iso", text: "Semi-3D", icon: "layers", title: "Isometrische Karte mit Status und Wegen" },
    { id: "three", text: "3D", icon: "cube", title: "Interaktive 3D-Halle: drehen, zoomen, Modelle" },
  ];
  const planHead = (
    <div className="leitstand-planhead">
      {phone && <KpiStrip items={kpis} inline label="Hallenkennzahlen" className="leitstand-kpis" />}
      <div className="leitstand-viewbar" role="group" aria-label="Ansicht und Ebenen">
        <FloorSwitcher topo={topo} current={here} onPick={site.setFloorId}
          multi={planView === "three"} extra={extraFloors}
          onToggleExtra={(id) => setExtraFloors((ids) => ids.includes(id)
            ? ids.filter((x) => x !== id) : [...ids, id])}
          onExtras={setExtraFloors}
          halls={shownHalls}
          onToggleHall={(id) => setShownHalls((ids) => ids.includes(id)
            ? ids.filter((x) => x !== id) : [...ids, id])}
          onHalls={setShownHalls} />
        <div className="leitstand-switch" role="group" aria-label="Darstellung">
          {views.map((v) => (
            <Button key={v.id} small active={planView === v.id} icon={v.icon} text={v.text} title={v.title}
              aria-pressed={planView === v.id} onClick={() => setPlanView(v.id)} />
          ))}
        </div>
        {planView === "three" && (
          <Button small icon="walk" active={walk} aria-pressed={walk} text="Begehen"
            title="Begehen: WASD/Pfeile gehen, Maus schaut, Türen führen in die Nachbarhalle"
            onClick={() => setWalk((v) => !v)} />
        )}
        <KeyPopover placement="bottom-start"
          content={
            <div className="leitstand-view-panel">
              <Menu>
                <MenuDivider title="Anzeige" />
                {layerItems}
              </Menu>
              {flowFilterPanel}
            </div>
          }>
          <Button small minimal icon="eye-open" rightIcon="caret-down"
            text={filterActive ? `Ansicht · ${filteredFlow.length} Wege` : "Ansicht"}
            aria-label={filterActive ? `Ansicht – Anzeige und Wege filtern, ${filteredFlow.length} Wege gefiltert` : "Ansicht – Anzeige und Wege filtern"}
            title="Materialwege, Beschriftungen, Hallen, Roboter ein- oder ausblenden und Wege filtern" />
        </KeyPopover>
        <KeyPopover placement="bottom-start" content={<div className="leitstand-legend-pop"><Legend /></div>}>
          <Button small minimal icon="properties" text="Legende" title="Was Formen, Zeichen und Linien bedeuten" />
        </KeyPopover>
        {filterActive && (
          <span className="leitstand-flow-filter" role="status">
            <Icon icon="filter-list" size={12} aria-hidden />
            <span>{filterText}</span>
            <Button small minimal icon="cross" text="Alle Wege" onClick={clearFlowFilter} />
          </span>
        )}
        {!phone && (
          <Button small minimal className="leitstand-fullscreen" icon={fullscreen ? "minimize" : "fullscreen"}
            text={fullscreen ? "Vollbild beenden" : "Vollbild"}
            aria-pressed={fullscreen}
            title={fullscreen ? "Vollbild beenden (Esc)" : "Plan im Vollbild zeigen (Esc beendet)"}
            onClick={toggleFullscreen} />
        )}
      </div>
    </div>
  );

  const planArea = (
    <section className="leitstand-plan" aria-label={here ? `Hallenplan ${floorLabel(here, true)}` : "Hallenplan"}>
      {planHead}
      <div className="leitstand-stage" ref={planBox}>
        {planView === "three" ? (
          <Suspense fallback={<div className="twin-center"><Spinner size={36} /></div>}>
            <ThreeFloorPlan
              ref={threeRef}
              floor={floor}
              stations={onFloor}
              levels={ghosts}
              neighborHalls={neighborHalls}
              map={hallMap}
              status={marks}
              highlightIds={finding?.ids}
              selectedId={selectedId}
              flow={showFlow ? filteredFlow : NO_FLOW}
              robots={showRobots ? robots : NO_ROBOTS}
              robotJobs={showRobots ? robotJobs : NO_JOBS}
              sampledAt={robotsAt}
              onStationClick={pickStation}
              onFilterEdge={filterEdge}
              onFallback={() => setPlanView("iso")}
              height={planHeight || 320}
              show={{ flow: showFlow, labels: showLabels, robots: showRobots,
                shell: extras.shell, roof: extras.roof, lanes: extras.lanes,
                paths: extras.paths, collisions: extras.collisions }}
              walk={walk}
              onWalkChange={setWalk}
              walkLevels={walkLevels}
              onWalkLevel={walkToLevel}
              placeLabel={sceneHere ? floorLabel(sceneHere) : ""}
              fullLevelIds={extraFloors}
              fullHallIds={shownHalls}
              activeOffset={activeOffset}
              staged={staged}
            />
          </Suspense>
        ) : planView === "iso" ? (
          <IsoFloorPlan
            floor={floor}
            stations={onFloor}
            status={marks}
            highlightIds={finding?.ids}
            selectedId={selectedId}
            flow={showFlow ? filteredFlow : NO_FLOW}
            highlightRoutesTo={selectedId}
            onStationClick={pickStation}
            onFilterEdge={filterEdge}
            height={planHeight || 320}
            show={{ flow: showFlow, labels: showLabels,
              lanes: extras.lanes, paths: extras.paths, frame: extras.frame }}
          />
        ) : (
          <FloorPlan
            floor={floor}
            map={hallMap}
            north={here?.hall && (here.hall.lat || here.hall.lon) ? here.hall.rotation_deg : null}
            stations={onFloor}
            loads={loads}
            maxUnknownLoad={unknownMax}
            loadUnit="min"
            status={marks}
            highlightIds={finding?.ids}
            selectedId={selectedId}
            flow={showFlow ? filteredFlow : NO_FLOW}
            hideInactive={false}
            onStationClick={pickStation}
            height={planHeight || 320}
            show={{ flow: showFlow, labels: showLabels, lanes: extras.lanes, paths: extras.paths }}
          />
        )}
      </div>
      <LevelDialog isOpen={levelOpen} hall={here?.hall ?? null}
        floors={here?.hall?.floors ?? []}
        onClose={() => setLevelOpen(false)}
        onCreated={async (id) => { setLevelOpen(false); await site.reload(); setFloorId(id); }}
        onDeleted={async (id) => { if (id === floorId) setFloorId(null); await site.reload(); }} />
      <SitesDialog isOpen={sitesOpen} onClose={() => setSitesOpen(false)} topo={topo}
        current={here} floor={floor ?? EMPTY_FLOOR}
        onChanged={async (fid) => { await site.reload(); if (fid) setFloorId(fid); }} />
    </section>
  );

  const lage = (
    <LagePanel findings={findings} plan={plan} handlers={handlers} stations={stations} sorted={sorted} marks={marks}
      summary={summary} noAisles={noAisles} partial={partial} activeFinding={finding?.idx ?? null}
      busy={applying} locked={forecast} phone={phone} onPickFinding={pickFinding} onPickStation={pickStation}
      onWhy={setWhy} onApply={applyOne} onApplyAll={applyAllAuto} onSetHandler={setHandler} />
  );

  const inspector = selected && (
    <Inspector station={selected} mark={selected.id != null ? marks[selected.id] : undefined} view={view}
      failed={viewFailed} onClose={closeStation} onCopyLink={copyStationLink}
      flow={flow} stations={stations} onPickStation={(s) => setSelectedId(s.id ?? null)}
      closeLabel={phone ? "Schließen" : "Zurück zur Lage"} />
  );

  const band = <TimeBand step={step} onStep={setStep} open={open} pool={machineWork(worklist).length} disabled={!worklist}
    compact={!phone} />;

  return (
    <div className={"leitstand" + (phone ? " leitstand-phone" : "") + (resizing ? " leitstand-resizing" : "")}>
      {statusLine}
      {banner}
      {phone ? (
        <>
          <Tabs id="leitstand-tabs" className="leitstand-tabs" selectedTabId={tab} onChange={(t) => setTab(String(t))} renderActiveTabPanelOnly>
            <Tab id="lage" title="Lage" panelClassName="leitstand-panel" panel={lage} />
            <Tab id="plan" title="Plan" panelClassName="leitstand-panel leitstand-panel-plan" panel={planArea} />
            <Tab id="zeit" title="Zeit" panelClassName="leitstand-panel" panel={
              <div className="lage-panel">
                {band}
                <StationList stations={sorted} marks={marks} onPick={pickStation} />
              </div>} />
          </Tabs>
          <Drawer isOpen={!!selected} onClose={closeStation} size="100%" position="bottom"
            className="leitstand-sheet" canEscapeKeyClose shouldReturnFocusOnClose={false}>
            <div className="leitstand-sheet-body">{inspector}</div>
          </Drawer>
        </>
      ) : (
        <>
          <div className="leitstand-body"
            style={{ gridTemplateColumns: sideShown ? `minmax(0, 1fr) ${sideWidth}px` : "minmax(0, 1fr) auto" }}>
            <div className={"leitstand-main" + (fullscreen ? " leitstand-main-full" : "")} ref={mainBox}>
              <PortalProvider portalContainer={fullscreen && mainEl ? mainEl : undefined}>
                {planArea}
                {band}
              </PortalProvider>
            </div>
            {sideShown ? (
              <aside className="leitstand-side" aria-label="Lage">
                <div className="leitstand-side-bar">
                  <Button className="leitstand-side-collapse" minimal small icon="double-chevron-right"
                    aria-label="Lage einklappen" title="Lage einklappen"
                    onClick={() => { setSideOpen(false); if (selected) closeStation(); }} />
                </div>
                <div className={"leitstand-resizer" + (resizing ? " leitstand-resizer-on" : "")}
                  role="separator" aria-orientation="vertical" aria-label="Breite der Lage ziehen"
                  tabIndex={0} onPointerDown={startResize} onKeyDown={resizeKey}
                  onDoubleClick={() => setSideWidth(340)}
                  title="Ziehen: Breite der Lage · Doppelklick: 340 px" />
                {inspector ?? lage}
              </aside>
            ) : (
              <button type="button" className="leitstand-side-tab" aria-label={`Lage einblenden${office && warnCount ? `, ${warnCount} ${warnCount === 1 ? "Auffälligkeit" : "Auffälligkeiten"}` : ""}`}
                title="Lage einblenden: Auffälligkeiten, Zuordnungen, Stationen" onClick={() => setSideOpen(true)}>
                <Icon icon="double-chevron-left" size={12} aria-hidden />
                <span className="leitstand-side-tab-text">Lage</span>
                {office && warnCount > 0 && <span className="leitstand-side-tab-count" aria-hidden>{warnCount}</span>}
              </button>
            )}
          </div>
        </>
      )}

      <Dialog isOpen={why != null} onClose={() => setWhy(null)} icon="route"
              style={{ width: "min(720px, 100%)" }}
              title={why ? `Maschinenwahl: ${why.job_no}` : ""}>
        <DialogBody>
          {why && (
            <>
              <p className="sub">
                Jede Station gegen diesen Innenauftrag, mit allen Faktoren. Ungeeignete stehen
                unten mit ihrem Grund.
              </p>
              <RankBars ranking={why.ranking} chosenId={why.station_id} />
            </>
          )}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Schließen" onClick={() => setWhy(null)} />
            {why?.station_id != null && (
              <Button intent="primary" icon="tick" loading={applying === why.job_no} disabled={forecast}
                text={`Auf ${why.label} legen`} onClick={() => applyOne(why)} />
            )}
          </>} />
      </Dialog>
    </div>
  );
}
