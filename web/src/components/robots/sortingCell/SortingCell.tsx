import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button, ButtonGroup, Callout, Card, HTMLSelect, Icon, ProgressBar, Switch, Tag, Tooltip,
} from "@blueprintjs/core";
import GimelMark from "../../GimelMark";
import { BIN_LABELS, FORMS, ODD_FORM, REJECT_BIN, type Outline } from "./forms";
import { pct, SURE } from "./teilerkennung";
import { SortingCellRuntime, type ArmSpec, type Overlay, type Snapshot } from "./runtime";
import { layoutFor, type CellLayout } from "./stations";
import { DEFAULT_MAPPING, teachSolution, syntheticFrame, type TeachMapping, type TrackingFrame } from "./teach";
import { startHandTracking, type TrackingStats } from "./handTracking";
import "./sortingCell.css";

/* Sortierzelle — Roboter → Arme & Zellen im Portal.

   Seit 2026-11-08 wohnt die Zelle bei den Robotern, nicht mehr im Twin Studio:
   sie ist die Arbeitsansicht eines Arms, keine Hallenansicht. Eingebettet
   (`inline`) füllt sie eine Karte der Seite; „Vollbild" legt sie über alles.

   Seit 2026-11-09 nimmt sie die Arme der Halle: einer bekommt die bekannte
   Zelle, zwei bekommen je eine Station am Band und einen halben Korbstreifen
   (`stations.ts`). Dazu die Handführung: Google MediaPipe verfolgt Hand und
   Arm vor der Kamera, `teach.ts` legt das auf die Pose des gezeigten Arms, und
   der halbdurchsichtige Geist zeigt, wohin der Roboter fahren würde. Posen
   lassen sich aufzeichnen und als JSON mitnehmen — für die spätere
   Programmierung, nicht als Steuerung: Gimel führt nichts aus. */

interface ArmChoice { id: number; name: string }

interface Props {
  /** Als Überlagerung: „Schließen" und Esc schließen. */
  onClose?: () => void;
  /** In eine Seite eingebettet (Roboter → Arme & Zellen), mit Vollbild-Schalter. */
  inline?: boolean;
  /** Die Arme der Halle, in Flottenreihenfolge (Station 1, Station 2 …). */
  arms?: ArmChoice[];
  /** Welcher Arm gezeigt wird. */
  focusId?: number | null;
  /** Klick auf einen Arm in der Zellenliste. */
  onFocusArm?: (id: number) => void;
}

function Shape({ outline, size = 38 }: { outline?: Outline; size?: number }) {
  if (!outline?.path) return <span className="sc-shape" style={{ width: size, height: size }} aria-hidden="true" />;
  const pad = Math.max(outline.w, outline.h) * 0.06;
  return (
    <svg className="sc-shape" width={size} height={size} aria-hidden="true"
         viewBox={`${-pad} ${-pad} ${outline.w + 2 * pad} ${outline.h + 2 * pad}`}>
      <path d={outline.path} fillRule="evenodd" />
    </svg>
  );
}

const fmtMm = (v: number) => v.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDeg = (v: number) => `${v.toFixed(1)}°`;
const colourHex = (v: number) => `#${v.toString(16).padStart(6, "0")}`;

const SPEEDS = [0.5, 1, 1.5, 2, 3];
const MEDIAPIPE_BASE = `${import.meta.env.BASE_URL}mediapipe`;
const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const POSE_BONES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
];

interface RecordedPose { n: number; joints: number[]; gripper: number; at: string }

/** Kamera-Bild mit erkannten Punkten: gespiegelt wie ein Spiegel vorm Roboter. */
function drawTracking(canvas: HTMLCanvasElement | null, video: HTMLVideoElement | null, frame: TrackingFrame | null) {
  if (!canvas) return;
  const box = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(box.width * dpr));
  const h = Math.max(1, Math.round(box.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (video && video.readyState >= 2 && video.videoWidth) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
  } else {
    ctx.fillStyle = "#0d1218";
    ctx.fillRect(0, 0, w, h);
  }
  const X = (x: number) => (1 - x) * w;
  const Y = (y: number) => y * h;
  const line = (a: { x: number; y: number }, b: { x: number; y: number }, colour: string, width: number) => {
    ctx.strokeStyle = colour; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.y)); ctx.lineTo(X(b.x), Y(b.y)); ctx.stroke();
  };
  if (frame?.pose) {
    for (const [a, b] of POSE_BONES) {
      if (frame.pose[a] && frame.pose[b]) line(frame.pose[a], frame.pose[b], "rgba(124,196,255,0.45)", 1.5 * dpr);
    }
    for (const i of [11, 12, 13, 14, 15, 16]) {
      const lm = frame.pose[i];
      if (!lm) continue;
      ctx.fillStyle = "rgba(124,196,255,0.8)";
      ctx.beginPath(); ctx.arc(X(lm.x), Y(lm.y), 2.4 * dpr, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (frame?.hand) {
    for (const [a, b] of HAND_BONES) {
      if (frame.hand[a] && frame.hand[b]) line(frame.hand[a], frame.hand[b], "#9fdcff", 2 * dpr);
    }
    for (const lm of frame.hand) {
      ctx.fillStyle = "#d8f1ff";
      ctx.beginPath(); ctx.arc(X(lm.x), Y(lm.y), 1.7 * dpr, 0, Math.PI * 2); ctx.fill();
    }
  }
}

export default function SortingCell({ onClose, inline = false, arms, focusId, onFocusArm }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const threePaneRef = useRef<HTMLDivElement>(null);
  const camPaneRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SortingCellRuntime | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [glError, setGlError] = useState("");
  const [full, setFull] = useState(false);

  const armChoices = useMemo<ArmChoice[]>(() => (
    arms?.length ? arms : [{ id: -1, name: "7-Achs-Roboter (Simulation)" }]
  ), [arms]);
  const layout = useMemo<CellLayout>(() => layoutFor(armChoices.length), [armChoices.length]);
  const focusIndex = Math.max(0, armChoices.findIndex((a) => a.id === focusId));
  const focusRef = useRef(focusIndex);
  useEffect(() => { focusRef.current = focusIndex; }, [focusIndex]);
  const stationKey = armChoices.map((a) => `${a.id}:${a.name}`).join("|");

  /* -------------------------------------------------------------- 3D */

  useEffect(() => {
    const stage = stageRef.current, canvas = canvasRef.current;
    const three = threePaneRef.current, cam = camPaneRef.current;
    if (!stage || !canvas || !three || !cam) return;
    let rt: SortingCellRuntime | null = null;
    const specs: ArmSpec[] = armChoices.slice(0, layout.arms).map((a) => ({ id: a.id, name: a.name }));
    try {
      rt = new SortingCellRuntime(canvas, stage, three, cam, layout, specs, {
        onSnapshot: setSnap,
        onOverlay: setOverlay,
        onGlError: setGlError,
      }, focusIndex);
    } catch { return; }
    runtimeRef.current = rt;
    const ro = new ResizeObserver(() => rt?.resize());
    ro.observe(stage);
    ro.observe(three);
    ro.observe(cam);
    const onResize = () => rt?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      rt?.dispose();
      runtimeRef.current = null;
    };
    // Neu aufbauen, wenn sich die Arme der Zelle ändern (Stationen, Namen).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, stationKey]);

  useEffect(() => { runtimeRef.current?.setFocus(focusIndex); }, [focusIndex]);

  useEffect(() => {
    const close = full ? () => setFull(false) : onClose;
    if (!close) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, full]);

  // Vollbild ändert die Größe der Bühne: der Renderer misst nach.
  useEffect(() => { requestAnimationFrame(() => runtimeRef.current?.resize()); }, [full]);

  /* --------------------------------------------------- Handführung */

  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const stopTrackRef = useRef<(() => void) | null>(null);
  const lastFrameRef = useRef<TrackingFrame | null>(null);
  const lastLocalRef = useRef<{ x: number; y: number; z: number } | null>(null);

  const [tracking, setTracking] = useState<"off" | "kamera" | "trocken">("off");
  const [trackError, setTrackError] = useState("");
  const [stats, setStats] = useState<TrackingStats | null>(null);
  const [mapping, setMapping] = useState<TeachMapping>({ ...DEFAULT_MAPPING });
  const mappingRef = useRef(mapping);
  useEffect(() => { mappingRef.current = mapping; }, [mapping]);
  const [ghost, setGhost] = useState(true);
  const ghostRef = useRef(ghost);
  useEffect(() => { ghostRef.current = ghost; }, [ghost]);
  const [readout, setReadout] = useState<{ pinch: number; gripper: number; side: string } | null>(null);
  const lastUiRef = useRef(0);
  const [poses, setPoses] = useState<RecordedPose[]>([]);
  const [copyNote, setCopyNote] = useState("");

  const onFrame = useCallback((frame: TrackingFrame) => {
    lastFrameRef.current = frame;
    drawTracking(previewRef.current, videoRef.current, frame);
    const rt = runtimeRef.current;
    if (!rt) return;
    if (!ghostRef.current) { rt.setTeach(null); return; }
    const sol = teachSolution(frame, mappingRef.current, rt.focusBase());
    if (!sol) { rt.setTeach(null); return; }
    lastLocalRef.current = sol.local;
    const joints = rt.solveForFocus(sol.target, sol.yaw);
    rt.setTeach(joints, sol.gripper, frame.handWorld ?? frame.hand);
    const now = performance.now();
    if (now - lastUiRef.current > 130) {
      lastUiRef.current = now;
      setReadout({ pinch: sol.pinch, gripper: sol.gripper, side: sol.side });
    }
  }, []);

  const stopTracking = useCallback(() => {
    stopTrackRef.current?.();
    stopTrackRef.current = null;
    setTracking("off");
    setStats(null);
    setReadout(null);
    lastFrameRef.current = null;
    drawTracking(previewRef.current, null, null);
    runtimeRef.current?.setTeach(null);
  }, []);

  useEffect(() => () => { stopTrackRef.current?.(); }, []);
  useEffect(() => {
    if (ghost) return;
    runtimeRef.current?.setTeach(null);
  }, [ghost]);

  const startCamera = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    setTrackError("");
    setTracking("kamera");
    setStats({ hands: 0, pose: false, fps: 0 });
    try {
      const stop = await startHandTracking(video, {
        wasmDir: `${MEDIAPIPE_BASE}/wasm`,
        handModel: `${MEDIAPIPE_BASE}/models/hand_landmarker.task`,
        poseModel: `${MEDIAPIPE_BASE}/models/pose_landmarker_lite.task`,
        maxFps: 30,
      }, onFrame, setStats);
      stopTrackRef.current = stop;
    } catch (e) {
      stopTrackRef.current = null;
      setTracking("off");
      setTrackError(e instanceof Error ? e.message : String(e));
    }
  }, [onFrame]);

  const startDryRun = useCallback(() => {
    stopTracking();
    setTrackError("");
    setTracking("trocken");
    setStats({ hands: 1, pose: true, fps: 30 });
    const t0 = performance.now();
    let raf = 0;
    const loop = () => {
      onFrame(syntheticFrame(performance.now() - t0 + 4000));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    stopTrackRef.current = () => cancelAnimationFrame(raf);
  }, [onFrame, stopTracking]);

  const recordPose = useCallback(() => {
    const p = runtimeRef.current?.teachPose();
    if (!p) return;
    setPoses((prev) => [...prev, {
      n: prev.length + 1,
      joints: p.joints.map((v) => Math.round(v * 10) / 10),
      gripper: Math.round(p.gripper * 100) / 100,
      at: new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    }].slice(-40));
  }, []);

  const programJson = useCallback(() => JSON.stringify({
    name: "Handführung",
    axes: ["A1", "A2", "A3", "A4", "A5", "A6", "A7"],
    source: "MediaPipe-Handführung (Browser, lokal)",
    poses_deg: poses.map((p) => ({ name: `P${p.n}`, at: p.at, deg: p.joints, gripper: p.gripper })),
    note: "Aufgezeichnete Vorlage. Gimel führt Programme nicht aus; kein Senden an eine Steuerung.",
  }, null, 2), [poses]);

  const downloadPoses = useCallback(() => {
    const blob = new Blob([programJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handfuehrung-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, [programJson]);

  const copyPoses = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(programJson());
      setCopyNote("In der Zwischenablage");
    } catch {
      setCopyNote("Kopieren nicht erlaubt — bitte als Datei laden");
    }
    setTimeout(() => setCopyNote(""), 2500);
  }, [programJson]);

  const setNeutral = useCallback(() => {
    const local = lastLocalRef.current;
    if (!local) return;
    setMapping((m) => ({
      ...m,
      offset: {
        x: m.offset.x + local.x,
        y: m.offset.y + local.y,
        z: m.offset.z + local.z,
      },
    }));
  }, []);

  /* ------------------------------------------------------------- Rest */

  const rt = useCallback((fn: (r: SortingCellRuntime) => void) => { if (runtimeRef.current) fn(runtimeRef.current); }, []);
  const s = snap;
  const bigCam = s?.bigCam ?? false;

  const bins = useMemo(() => BIN_LABELS.map((label, i) => ({
    label, i, n: s?.counts[i] ?? 0,
    colour: i === REJECT_BIN ? "#6b7482" : colourHex(FORMS[i].colour),
  })), [s?.counts]);
  const maxBin = Math.max(1, ...bins.map((b) => b.n));

  const hit = s?.hit ?? null;
  const form = hit?.form ?? null;
  const sure = !!hit?.sure;
  const decision = sure && form ? `Korb ${form.bin + 1} · ${form.label}` : "Nachprüfung";
  const focusName = armChoices[focusIndex]?.name ?? "7-Achs-Roboter";
  const layoutLabel = layout.arms === 1 ? "1 Arm · 1 Station" : `${layout.arms} Arme · ${layout.stations.length} Stationen`;
  const extraArms = Math.max(0, armChoices.length - layout.arms);

  return (
    <div className={`sort-cell${onClose ? " is-embedded" : ""}${inline && !full ? " is-inline" : ""}`}
         role={onClose || full ? "dialog" : "region"}
         aria-modal={onClose || full ? true : undefined}
         aria-label={`Sortierzelle — ${focusName} mit Teileerkennung`}>
      <header className="sc-bar">
        {inline && !full
          ? <span className="sc-brand"><Icon icon="cube" size={14} /> <b>Sortierzelle</b></span>
          : <span className="sc-brand"><GimelMark size={22} /> <b>Sortierzelle</b></span>}
        <span className="sc-bar-sub">{focusName} · Teileerkennung</span>
        <Tag minimal intent={layout.arms > 1 ? "primary" : "none"} icon={layout.arms > 1 ? "grid-view" : "cube"}>
          {layoutLabel}
        </Tag>
        <Tag minimal intent="warning" icon="info-sign" title="Simulation: dargestellt, nicht gemessen">
          {inline && !full ? "Simulation" : "Simulation · dargestellt, nicht gemessen"}
        </Tag>
        <span className="sc-bar-gap" />
        <span className="sc-phase" role="status" aria-live="polite">
          <Icon icon={s?.playing ? "play" : "pause"} size={12} /> {s?.phaseLabel ?? "Start …"}
        </span>
        <ButtonGroup minimal>
          <Button icon={s?.playing ? "pause" : "play"} text={s?.playing ? "Pause" : "Weiter"}
            aria-label={s?.playing ? "Animation anhalten" : "Animation abspielen"}
            onClick={() => rt((r) => r.setPlaying(!(s?.playing ?? true)))} />
          <Button icon="refresh" text={inline && !full ? undefined : "Neu messen"} title="Neu messen: Standbild neu erkennen"
            aria-label="Neu messen" onClick={() => rt((r) => r.publicRecapture())} />
          <Button icon="reset" text={inline && !full ? undefined : "Zurücksetzen"} title="Zurücksetzen"
            aria-label="Zurücksetzen" onClick={() => rt((r) => r.reset())} />
        </ButtonGroup>
        <HTMLSelect aria-label="Geschwindigkeit" value={String(s?.speed ?? 1)}
          options={SPEEDS.map((v) => ({ value: String(v), label: `×${v}` }))}
          onChange={(e) => rt((r) => r.setSpeed(Number(e.currentTarget.value)))} />
        <Switch checked={bigCam} label="Kamera groß" className="sc-switch"
          onChange={() => rt((r) => r.setBigCam(!bigCam))} />
        {inline && <Button minimal icon={full ? "minimize" : "fullscreen"} text={full ? "Verkleinern" : "Vollbild"}
          aria-pressed={full} title={full ? "Zurück in die Seite (Esc)" : "Zelle über den ganzen Bildschirm"}
          onClick={() => setFull((v) => !v)} />}
        {onClose && <Button minimal icon="cross" text="Schließen" onClick={onClose} title="Esc" />}
      </header>

      {glError && <Callout intent="danger" icon="error" className="sc-gl-error">
        Kein 3D (WebGL): {glError}
      </Callout>}

      <div className="sc-body">
        <div className={`sc-stage${bigCam ? " is-bigcam" : ""}`} ref={stageRef}>
          <canvas ref={canvasRef} className="sc-canvas" aria-label="3D-Ansicht der Sortierzelle" />

          <div className="sc-pane sc-pane-3d" ref={threePaneRef}>
            <span className="sc-pane-title"><Icon icon="cube" size={12} /> Zelle · 3D</span>
            {tracking !== "off" && ghost && (
              <span className="sc-chip sc-chip-teach"><Icon icon="hand" size={11} /> Handführung · Geist über {focusName}</span>
            )}
            <div className="sc-joints" aria-label="Gelenkwinkel">
              {(s?.joints ?? []).map((a, i) => (
                <div key={i} className="sc-joint">
                  <span className="sc-joint-name">{s?.jointNames[i] ?? `A${i + 1}`}</span>
                  <span className="sc-joint-track"><span style={{ left: `${Math.max(2, Math.min(98, 50 + (a / 3.6) * 50))}%` }} /></span>
                  <span className="sc-joint-val mono">{fmtDeg(a)}</span>
                </div>
              ))}
            </div>
            <span className="sc-pane-hint">Ziehen dreht · Rad zoomt · alle sieben Achsen live</span>
          </div>

          <div className="sc-pane sc-pane-cam" ref={camPaneRef}>
            <span className="sc-pane-title"><Icon icon="camera" size={12} /> Was die Kamera von oben sieht</span>
            <span className={`sc-chip${s?.still ? "" : " is-live"}`}>
              {s?.still ? `Standbild · ${overlay?.stamp ?? "—"}` : "Live"}
            </span>
            {overlay && overlay.w > 2 && (
              <svg className="sc-overlay" viewBox={`0 0 ${overlay.w} ${overlay.h}`}
                   preserveAspectRatio="none" aria-hidden="true">
                <polygon points={overlay.zone} className="sc-zone" />
                <line x1={overlay.crossX} y1={0} x2={overlay.crossX} y2={overlay.h} className="sc-cross" />
                <line x1={0} y1={overlay.crossY} x2={overlay.w} y2={overlay.crossY} className="sc-cross" />
                <circle cx={overlay.crossX} cy={overlay.crossY} r={9} className="sc-cross-ring" />
                {overlay.parts.map((p) => (
                  <g key={p.key}>
                    <polygon points={p.points}
                      className={`sc-hit${p.sure ? "" : " is-unsure"}${p.unknown ? " is-unknown" : ""}${p.counted ? " is-counted" : ""}`} />
                    <circle cx={p.cx} cy={p.cy} r={11}
                      className={`sc-badge${p.sure ? "" : " is-unsure"}${p.unknown ? " is-unknown" : ""}${p.counted ? " is-counted" : ""}`} />
                    <text x={p.cx} y={p.cy + 4} textAnchor="middle" className="sc-badge-text">{p.counted ? "✓" : p.index}</text>
                    <text x={Math.min(overlay.w - 120, Math.max(4, p.cx + 14))} y={Math.max(14, p.cy - 14)}
                          className="sc-hit-label">{p.unknown ? "? · kein Treffer" : `${p.tag} · ${pct(p.confidence)}`}</text>
                  </g>
                ))}
              </svg>
            )}
            <span className="sc-cam-foot mono">
              {s ? `${s.calibration.height_mm} mm über Tisch · ${s.calibration.hfov_deg}° · ± ${s.calibration.tolerance_mm} mm · Neigung ${s.calibration.pitch_deg}°/${s.calibration.roll_deg}°` : ""}
            </span>
          </div>
        </div>

        <aside className="sc-side" aria-label="Teileerkennung und Steuerung">
          <Card className="sc-card sc-stations">
            <div className="sc-card-head">
              <h2 className="section-title">Arme in der Zelle</h2>
              <span className="mono muted">{layoutLabel}</span>
            </div>
            <ul className="sc-station-list">
              {(s?.arms ?? layout.stations.map((st, i) => ({
                index: i, id: armChoices[i]?.id ?? null, name: armChoices[i]?.name ?? `Arm ${i + 1}`,
                phase: "idle", phaseLabel: "—", joints: [], stationMm: Math.round(st.x * 1000),
                carrying: false, cycles: 0,
                bins: st.bins.map((b) => ({ bin: b.bin, local: b.local, label: b.label })),
              }))).map((a) => {
                const station = layout.stations[a.index];
                const active = a.index === focusIndex;
                return (
                  <li key={a.index} className={`sc-station${active ? " is-active" : ""}`}>
                    <button type="button" className="sc-station-btn" aria-pressed={active}
                      onClick={() => { runtimeRef.current?.setFocus(a.index); onFocusArm?.(armChoices[a.index]?.id ?? -1); }}>
                      <span className="sc-station-name">
                        <Icon icon="cube" size={11} /> {a.name}
                      </span>
                      <span className="sub mono">Station {Math.round((station?.x ?? 0) * 1000)} mm · {a.cycles} Ablagen</span>
                    </button>
                    <span className="sc-station-bins">
                      {(station?.bins ?? []).map((b) => (
                        <Tag key={`${b.local}`} minimal intent={b.bin === REJECT_BIN ? "warning" : "none"} title={`Korb ${b.local + 1}`}>
                          {b.label}
                        </Tag>
                      ))}
                    </span>
                    {a.index < layout.stations.length && (
                      <span className="sc-station-phase mono">{("phaseLabel" in a ? a.phaseLabel : "—")}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="muted sc-meta">
              {layout.arms > 1
                ? "Jeder Arm hat seine Greifstelle am Band und einen halben Korbstreifen; ein Teil fährt bis zu dem Arm, der seine Klasse sortiert."
                : "Ein Arm: die Zelle ist die gewohnte Sortierzelle mit allen sechs Körben."}
              {extraArms > 0 && ` ${extraArms} weitere${extraArms === 1 ? "r Arm" : " Arme"} dieser Halle hat keine Station — die Zelle baut höchstens ${layout.arms} Arme auf.`}
            </p>
          </Card>

          <Card className="sc-card sc-vision">
            <div className="sc-card-head">
              <h2 className="section-title">Teileerkennung</h2>
              <Tag minimal intent={sure ? "success" : "warning"}>{sure ? "Sicher" : "Prüfen"}</Tag>
            </div>
            {!hit ? (
              <p className="muted">Warte auf das nächste Standbild der Kamera …</p>
            ) : (
              <>
                <div className="sc-hit-row">
                  <Shape outline={form?.outline} size={46} />
                  <div className="sc-hit-body">
                    <div className="sc-hit-title"><strong>{form?.label ?? "Unbekanntes Teil"}</strong>
                      {form && <Tag minimal>{form.tag}</Tag>}
                      {hit.ambiguous > 0 && <Tag minimal intent="warning">{hit.ambiguous + 1} Formen möglich</Tag>}
                    </div>
                    <div className="muted sc-meta">
                      <span className="mono">{fmtMm(hit.box.length_mm)} × {fmtMm(hit.box.width_mm)} mm</span>
                      <span className="mono">{fmtDeg(hit.box.angle_deg)}</span>
                      <span className="mono">x {fmtMm(hit.box.x_mm)} / y {fmtMm(hit.box.y_mm)}</span>
                    </div>
                    <div className="sc-meter" role="meter" aria-label="Formübereinstimmung"
                         aria-valuemin={0} aria-valuemax={1} aria-valuenow={hit.confidence} aria-valuetext={pct(hit.confidence)}>
                      <span style={{ width: `${Math.round(Math.max(0, Math.min(1, hit.confidence)) * 100)}%` }}
                            className={sure ? "" : "is-unsure"} />
                      <em className="mono">{pct(hit.confidence)}</em>
                    </div>
                  </div>
                </div>
                <div className="sc-decision">
                  <Icon icon={sure ? "tick-circle" : "warning-sign"} size={13} />
                  {sure ? `Sicher ab ${Math.round(SURE * 100)} %` : "Unter der Schwelle / unbekannt"} · <b>{decision}</b>
                </div>
                {!!hit.alternatives.length && (
                  <div className="sc-alts">
                    <span className="muted">Weitere Kandidaten</span>
                    <ul>
                      {hit.alternatives.slice(0, 4).map((a, i) => (
                        <li key={i}>
                          <span>{a.sameShape ? "Dasselbe Teil" : "Andere Form"} · {a.form.label}</span>
                          <span className="mono muted">{a.work_order} · {pct(a.confidence)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </Card>

          <Card className="sc-card sc-teach">
            <div className="sc-card-head">
              <h2 className="section-title">Handführung</h2>
              <Tag minimal intent={tracking === "off" ? "none" : tracking === "kamera" ? "success" : "primary"}
                   icon={tracking === "off" ? "disable" : "video"}>
                {tracking === "off" ? "Kamera aus" : tracking === "kamera" ? "MediaPipe · live" : "Trockenlauf"}
              </Tag>
            </div>
            <p className="muted sc-note">
              MediaPipe (Google) verfolgt Hand und Arm vor der Kamera und legt sie als halbdurchsichtigen
              Geist über den Roboter. Alles rechnet im Browser; kein Bild verlässt diesen Rechner.
              Aufgezeichnete Posen sind eine Vorlage — Gimel sendet sie an keine Steuerung.
            </p>
            <div className="sc-teach-preview">
              <video ref={videoRef} className="sc-cam-video" playsInline muted aria-hidden="true" />
              <canvas ref={previewRef} className="sc-cam-canvas" aria-label="Kamerabild mit erkannten Händen und Armen" />
              {tracking === "off" && !trackError && (
                <span className="sc-cam-empty">Kamera aus — „Kamera starten" oder „Trockenlauf"</span>
              )}
            </div>
            {trackError && <Callout intent="warning" icon="warning-sign" className="sc-track-error">{trackError}</Callout>}
            <div className="sc-teach-actions">
              {tracking === "off" ? (
                <>
                  <Button small intent="primary" icon="video" text="Kamera starten" onClick={() => void startCamera()} />
                  <Button small minimal icon="play" text="Trockenlauf" title="Ohne Kamera: gerechnete Hand, gleiche Kette"
                          onClick={startDryRun} />
                </>
              ) : (
                <Button small icon="stop" text="Stoppen" onClick={stopTracking} />
              )}
              <Switch checked={ghost} label="Geist zeigen" className="sc-switch" disabled={tracking === "off"}
                      onChange={() => setGhost((v) => !v)} />
              <Button small minimal icon="target" text="Mitte setzen" disabled={!readout}
                      title="Aktuelle Hand ist die Neutralstellung" onClick={setNeutral} />
            </div>
            <div className="sc-teach-readout mono" role="status" aria-live="polite">
              <span>{stats ? `${stats.fps} fps` : tracking === "off" ? "— fps" : "lädt …"}</span>
              <span>{stats ? (stats.hands ? `${stats.hands} Hand` : "keine Hand") : "keine Hand"}</span>
              <span>{stats?.pose ? "Körper erkannt" : "kein Körper"}</span>
              {readout && <span>{readout.side} · Sauger {Math.round(readout.gripper * 100)} %</span>}
            </div>
            <div className="sc-teach-tune">
              <label className="sc-field">
                <span>Seite <b className="mono">{mapping.gain.toFixed(2)}×</b></span>
                <input type="range" min={0.4} max={2.6} step={0.05} value={mapping.gain} aria-label="Seitliche Empfindlichkeit"
                       onChange={(e) => setMapping((m) => ({ ...m, gain: Number(e.currentTarget.value) }))} />
              </label>
              <label className="sc-field">
                <span>Höhe <b className="mono">{mapping.lift.toFixed(2)}×</b></span>
                <input type="range" min={0.4} max={2.4} step={0.05} value={mapping.lift} aria-label="Höhenempfindlichkeit"
                       onChange={(e) => setMapping((m) => ({ ...m, lift: Number(e.currentTarget.value) }))} />
              </label>
              <Switch checked={mapping.mirror} label="Spiegeln (Kamera)" className="sc-switch"
                      onChange={() => setMapping((m) => ({ ...m, mirror: !m.mirror }))} />
            </div>
            <div className="sc-teach-record">
              <Button small icon="record" text="Pose aufnehmen" disabled={!readout}
                      title="Die aktuelle Geist-Pose als Wegpunkt merken" onClick={recordPose} />
              <span className="mono muted">{poses.length} Posen</span>
              <span className="sc-bar-gap" />
              <Button small minimal icon="trash" text="Leeren" disabled={!poses.length}
                      onClick={() => setPoses([])} />
              <Button small minimal icon="clipboard" text="Kopieren" disabled={!poses.length} onClick={() => void copyPoses()} />
              <Button small minimal icon="download" text="JSON" disabled={!poses.length}
                      title="Programm-Vorlage als Datei (Missionen → einfügen)" onClick={downloadPoses} />
            </div>
            {poses.length > 0 && (
              <ul className="sc-pose-list">
                {poses.slice(-3).reverse().map((p) => (
                  <li key={p.n}>
                    <span className="mono">P{p.n}</span>
                    <span className="mono muted">{p.joints.map((v) => v.toFixed(0)).join(" · ")}°</span>
                    <span className="mono">Sauger {Math.round(p.gripper * 100)} %</span>
                  </li>
                ))}
              </ul>
            )}
            {copyNote && <p className="muted sc-meta">{copyNote}</p>}
            <p className="muted sc-meta">
              Modelle: <span className="mono">web/public/mediapipe/</span> · fehlen sie, einmal
              <span className="mono"> cd web &amp;&amp; npm run mediapipe:models</span>.
            </p>
          </Card>

          <Card className="sc-card">
            <div className="sc-card-head"><h2 className="section-title">Kamera & Erkennung</h2>
              <span className="mono muted">/api/vision/identify</span></div>
            <label className="sc-field">
              <span>Kamerarauschen <b className="mono">{Math.round((s?.noise ?? 0) * 100)} %</b></span>
              <input type="range" min={0} max={1} step={0.01} value={s?.noise ?? 0}
                aria-label="Kamerarauschen"
                onChange={(e) => rt((r) => r.setNoise(Number(e.currentTarget.value)))} />
              <span className="muted">Sauber · Bewegung, streifendes Licht, verdeckte Kontur → Nachprüfung</span>
            </label>
            <label className="sc-field">
              <span>Maßtoleranz</span>
              <HTMLSelect fill value={String(s?.toleranceMm ?? 3)}
                options={[1, 2, 3, 5, 8, 12].map((v) => ({ value: String(v), label: `± ${v} mm` }))}
                onChange={(e) => rt((r) => r.setTolerance(Number(e.currentTarget.value)))} />
            </label>
            <div className="sc-spawn">
              <span className="muted">Teil vorziehen</span>
              <div className="sc-spawn-buttons">
                {FORMS.map((f) => (
                  <button key={f.id} type="button" className="sc-spawn-btn" title={f.label}
                    onClick={() => rt((r) => r.spawn(f.id))}>
                    <span style={{ background: colourHex(f.colour) }} /> {f.tag}
                  </button>
                ))}
                <button type="button" className="sc-spawn-btn" title="Fremdteil (unbekannt)"
                  onClick={() => rt((r) => r.spawn(ODD_FORM.id))}>
                  <span style={{ background: "#6b7482" }} /> Fremd
                </button>
              </div>
            </div>
          </Card>

          <Card className="sc-card">
            <div className="sc-card-head"><h2 className="section-title">Sortierkörbe</h2>
              <span className="mono muted">{s?.total ?? 0} Teile</span></div>
            <ul className="sc-bins">
              {bins.map((b) => (
                <li key={b.i}>
                  <span className="sc-bin-dot" style={{ background: b.colour }} />
                  <span className="sc-bin-name">{b.label}</span>
                  <ProgressBar value={b.n / maxBin} intent={b.i === REJECT_BIN && b.n > 0 ? "warning" : "success"}
                    stripes={false} animate={false} className="sc-bin-bar" />
                  <span className="mono sc-bin-num">{b.n}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="sc-card">
            <div className="sc-card-head"><h2 className="section-title">Nächste Teile</h2>
              <span className="mono muted">Band</span></div>
            <div className="sc-queue">
              {(s?.queue ?? []).map((q, i) => (
                <span key={i} className="sc-queue-item">
                  <span style={{ background: colourHex(q.colour) }} /> {q.tag}
                </span>
              ))}
              {!s?.queue.length && <span className="muted">—</span>}
            </div>
          </Card>

          <Card className="sc-card">
            <div className="sc-card-head"><h2 className="section-title">Protokoll</h2>
              <span className="mono muted">{s?.cycles ?? 0} Zyklen</span></div>
            <ul className="sc-log">
              {(s?.log ?? []).map((l, i) => (
                <li key={i} className={`is-${l.tone}`}>
                  <span className="mono muted">{l.at}</span><span>{l.text}</span>
                </li>
              ))}
              {!s?.log.length && <li className="muted">Noch kein Durchlauf.</li>}
            </ul>
          </Card>
        </aside>
      </div>

      <footer className="sc-foot" aria-label="Kennzahlen der Zelle">
        <span><b className="mono">{s?.cycles ?? 0}</b> Zyklen</span>
        <span><b className="mono">{s?.total ?? 0}</b> sortiert</span>
        <span><b className="mono">{pct(s?.avgConfidence ?? 0)}</b> Ø Treffer</span>
        <span><b className="mono">{s?.unsure ?? 0}</b> Nachprüfung</span>
        <Tooltip content="Kamera und Handführung rechnen lokal im Browser; Gimel führt keine Programme aus.">
          <span className="sc-foot-note">Erkennung wie gimel/core/vision.py::match · nur simuliertes Kamerabild</span>
        </Tooltip>
      </footer>
    </div>
  );
}
