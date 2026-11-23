import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageInfo, pageInfo } from "../ui";
import {
  Button, Callout, Card, Collapse, FormGroup, HTMLSelect, Icon, InputGroup, NumericInput, ProgressBar,
  SegmentedControl, Spinner, Switch, Tag,
} from "@blueprintjs/core";
import { api, apiBlob, isWorker } from "../api";
import { isTyping } from "../useShortcuts";
import { toastError, toastSuccess } from "../toast";
import { plural } from "../plural";
import "../vision.css";

/* Teileerkennung — welches Teil liegt da auf dem Sortiertisch?

   Die Kamera hängt am Browser: das Portal schickt ein Standbild, der Server misst
   es auf der Tischebene und vergleicht es mit den offenen Teilen. Das Bild wird
   nicht gespeichert. Der Browser gibt die Kamera nur in einem sicheren Kontext
   frei, also über localhost oder HTTPS.

   Ohne Kamera geht es trotzdem: ein Foto vom Rechner laden, oder ein Testbild, das
   der Server aus offenen Teilen durch die eingemessene Kamera rechnet. Was auf dem
   Testbild nicht erkannt wird, wird es auf dem Tisch auch nicht — so prüft das Büro
   die Einmessung, bevor die Halle daran arbeitet.

   Was erkannt wurde, gilt für das Standbild, nicht für das laufende Bild: deshalb
   bleibt das gemessene Bild stehen, bis jemand wieder auf „Live" geht. */

interface Calibration {
  height_mm: number; thickness_mm: number; hfov_deg: number; tolerance_mm: number;
  pitch_deg: number; roll_deg: number; origin_x_mm: number; origin_y_mm: number; yaw_deg: number;
}
interface Zone { enabled: boolean; auto_count: boolean; points: number[][]; points_mm?: number[][]; }
interface Status { available: boolean; calibration: Calibration; zone: Zone; }
interface Outline { path: string; w: number; h: number; }
interface Expected {
  work_order: string; position_id: number; order_no: string; label: string; tag: string;
  customer?: string; qty: number; confirmed: number; remaining: number; outline?: Outline;
}
interface Alternative { work_order: string; position_id: number; label: string; tag: string; order_no: string; remaining: number; }
interface Hit extends Expected {
  confidence: number; ambiguous: number; alternatives?: Alternative[]; box: number[][];
  length_mm: number; width_mm: number; x_mm: number; y_mm: number; angle_deg: number;
  counted?: boolean; confirmation_id?: number;
}
interface Unknown { length_mm: number; width_mm: number; box: number[][]; }
interface AutoCounted { id: number; hit: number; label: string; work_order: string; position_id: number; remaining: number; }
interface Result {
  parts: Hit[]; unknown: Unknown[]; expected: number; width_px: number; height_px: number;
  auto_counted?: AutoCounted[]; zone?: Zone;
}
interface Counted { id: number; label: string; work_order: string; position_id: number; at: Date; hit?: number; }

type Source = "camera" | "file" | "sample";

/** Ab hier zählt „Alle sicheren" ein Teil ohne Rückfrage. */
const SURE = 0.9;
const MAX_UPLOAD = 8 * 1024 * 1024;

const points = (box: number[][]) => box.map(([x, y]) => `${x},${y}`).join(" ");
const centre = (box: number[][]) => [box.reduce((s, p) => s + p[0], 0) / box.length, box.reduce((s, p) => s + p[1], 0) / box.length];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const rectangle = (a: number[], b: number[]) => {
  const x1 = Math.min(a[0], b[0]), x2 = Math.max(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]), y2 = Math.max(a[1], b[1]);
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
};
const sure = (h: Hit) => h.confidence >= SURE && h.ambiguous === 0;
const name = (r: { label: string; tag: string }) => r.label || r.tag || "Teil";
const pct = (v: number) => `${Math.round(v * 100)} %`;
/** Für CSS: ohne das Leerzeichen der deutschen Schreibweise. */
const width = (v: number) => `${Math.round(Math.max(0, Math.min(v, 1)) * 1000) / 10}%`;
const deg = (v: number) => `${v.toLocaleString("de-DE", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}°`;
const mm = (v: number) => v.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const time = (d: Date) => d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Shape({ outline, size = 34 }: { outline?: Outline; size?: number }) {
  if (!outline?.path) return <span className="vision-shape" style={{ width: size, height: size }} aria-hidden="true" />;
  const pad = Math.max(outline.w, outline.h) * 0.06;
  return (
    <svg className="vision-shape" width={size} height={size} aria-hidden="true"
         viewBox={`${-pad} ${-pad} ${outline.w + 2 * pad} ${outline.h + 2 * pad}`}>
      <path d={outline.path} fillRule="evenodd" />
    </svg>
  );
}

export default function PartVision() {
  const office = !isWorker();
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  /** Was gerade gezählt wird: eine gehaltene Taste oder ein Doppelklick zählt nur einmal. */
  const pending = useRef(new Set<number>());
  const countingRef = useRef(false);
  const tableHead = useRef<HTMLHeadingElement>(null);
  const logHead = useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [rows, setRows] = useState<Expected[]>([]);
  const [order, setOrder] = useState("");
  const [source, setSource] = useState<Source>("camera");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [live, setLive] = useState(false);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [countingAll, setCountingAll] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [still, setStill] = useState<{ url: string; w: number; h: number; at: Date; origin: Source } | null>(null);
  const [counted, setCounted] = useState<Counted[]>([]);
  const [focus, setFocus] = useState<number | null>(null);
  const [sampleCount, setSampleCount] = useState(3);
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const [corners, setCorners] = useState<number[][] | null>(null);
  const [sides, setSides] = useState({ a: 420, b: 297 });
  const [zoneDraw, setZoneDraw] = useState(false);
  const [draft, setDraft] = useState<{ a: number[]; b: number[] } | null>(null);
  const [zoneBusy, setZoneBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const q = order ? `?work_order=${encodeURIComponent(order)}` : "";
      setRows(await api<Expected[]>(`/api/vision/expected${q}`));
    } catch (e: any) { toastError(e.message); }
  }, [order]);

  useEffect(() => {
    api<Status>("/api/vision/status").then(setStatus).catch((e) => toastError(e.message));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  /* Kamera: nur solange die Quelle „Kamera" ist. Die Liste der Geräte gibt der
     Browser erst nach der Freigabe mit Namen heraus. */
  useEffect(() => {
    if (source !== "camera") { setLive(false); return; }
    let stream: MediaStream | null = null;
    let gone = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Dieser Browser gibt hier keine Kamera frei. Sie geht nur über localhost oder HTTPS.");
      return;
    }
    const video_ = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    navigator.mediaDevices.getUserMedia({ video: video_, audio: false })
      .then(async (s) => {
        if (gone) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        setCameraError("");
        if (video.current) { video.current.srcObject = s; setLive(true); }
        try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput")); } catch { /* egal */ }
      })
      .catch((e) => {
        setLive(false);
        // Die Meldung des Browsers ist englisch und technisch; der Name des Fehlers sagt, was los ist.
        setCameraError(e?.name === "NotAllowedError" ? "Die Kamera wurde nicht freigegeben."
          : e?.name === "NotFoundError" || e?.name === "OverconstrainedError" ? "Keine Kamera gefunden."
          : e?.name === "NotReadableError" ? "Die Kamera wird gerade von einem anderen Programm benutzt."
          : `Keine Kamera: ${e.message}`);
      });
    return () => { gone = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [source, deviceId]);

  useEffect(() => () => { if (still) URL.revokeObjectURL(still.url); }, [still]);

  const grab = useCallback(async (): Promise<Blob | null> => {
    const v = video.current;
    if (!v || !v.videoWidth) return null;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    return new Promise((done) => c.toBlob(done, "image/jpeg", 0.92));
  }, []);

  /** Ein Bild messen und stehen lassen, damit Rahmen und Bild zusammenpassen. */
  const analyse = useCallback(async (blob: Blob, origin: Source) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const query = new URLSearchParams();
      if (order) query.set("work_order", order);
      if (origin === "sample") query.set("preview", "true");
      const q = query.size ? `?${query}` : "";
      const r = await api<Result>(`/api/vision/identify${q}`, {
        method: "POST", body: blob, headers: { "Content-Type": blob.type || "image/jpeg" },
      });
      setResult(r);
      setFocus(null);
      setStill({ url: URL.createObjectURL(blob), w: r.width_px, h: r.height_px, at: new Date(), origin });
      const automatic = r.auto_counted ?? [];
      if (automatic.length) {
        setCounted((c) => [...automatic.map((a) => ({ ...a, label: a.label || "Teil", at: new Date() })), ...c].slice(0, 30));
        toastSuccess(`${plural(automatic.length, "Teil", "Teile")} im Zählbereich automatisch gezählt.`);
        reload();
      }
    } catch (e: any) { setAuto(false); toastError(e.message); } finally { busyRef.current = false; setBusy(false); }
  }, [order, reload]);

  const identify = useCallback(async () => {
    if (source === "camera") {
      const blob = await grab();
      if (blob) await analyse(blob, "camera");
    } else if (source === "sample") {
      if (busyRef.current) return;
      try {
        const q = new URLSearchParams({ count: String(sampleCount) });
        if (order) q.set("work_order", order);
        await analyse(await apiBlob(`/api/vision/sample?${q}`), "sample");
      } catch (e: any) { toastError(e.message); }
    } else {
      fileInput.current?.click();
    }
  }, [source, grab, analyse, sampleCount, order]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!/^image\/(jpeg|png)$/.test(f.type)) { toastError("Erwartet wird ein JPEG- oder PNG-Bild."); return; }
    if (f.size > MAX_UPLOAD) { toastError("Das Bild ist größer als 8 MB."); return; }
    await analyse(f, "file");
  };

  useEffect(() => {
    if (!auto || source !== "camera") return;
    const t = setInterval(() => { if (!document.hidden && !busyRef.current) identify(); }, 2000);
    return () => clearInterval(t);
  }, [auto, source, identify]);

  const backToLive = () => { setStill(null); setResult(null); setFocus(null); };

  /** Die Karten auf dem Tisch zeigen den Stand nach dem Zählen, nicht den beim Messen. */
  const adjust = (t: { work_order: string; position_id: number }, remaining: number) =>
    setResult((r) => r && {
      ...r,
      parts: r.parts.map((p) => ({
        ...p,
        ...(p.work_order === t.work_order && p.position_id === t.position_id ? { remaining } : {}),
        alternatives: p.alternatives?.map((a) => a.work_order === t.work_order && a.position_id === t.position_id ? { ...a, remaining } : a),
      })),
    });

  const confirm = useCallback(async (h: Hit, index: number, pick?: Alternative): Promise<boolean> => {
    const target = pick ?? h;
    if (pending.current.has(index)) return false;
    pending.current.add(index);
    try {
      const r = await api<{ id: number; remaining: number }>("/api/vision/confirm", {
        method: "POST",
        body: JSON.stringify({ work_order: target.work_order, position_id: target.position_id,
                               confidence: pick ? 0 : h.confidence, x_mm: h.x_mm, y_mm: h.y_mm, angle_deg: h.angle_deg }),
      });
      setCounted((c) => [{ id: r.id, label: name(target), work_order: target.work_order, position_id: target.position_id,
                           at: new Date(), hit: index }, ...c].slice(0, 30));
      adjust(target, r.remaining);
      return true;
    } catch (e: any) { toastError(e.message); return false; } finally { pending.current.delete(index); }
  }, []);

  /* Nach dem Zählen verschwindet der Knopf: der Fokus geht zum nächsten offenen Teil,
     sonst landet er auf der Seite, und das nächste Enter zählt alles Sichere. */
  const refocus = (ref: React.RefObject<HTMLElement>, selector: string) => setTimeout(() => {
    const next = ref.current?.closest(".vision-card")?.querySelector<HTMLElement>(selector);
    (next ?? ref.current)?.focus();
  }, 0);

  const countOne = async (h: Hit, index: number, pick?: Alternative) => {
    if (await confirm(h, index, pick)) {
      toastSuccess(`${name(pick ?? h)} gezählt.`);
      refocus(tableHead, ".vision-count");
      reload();
    }
  };

  const countedHits = useMemo(() => new Set([
    ...counted.filter((c) => still && c.at >= still.at).map((c) => c.hit),
    ...(result?.parts ?? []).flatMap((h, i) => h.counted ? [i] : []),
  ]), [counted, still, result]);
  const sureHits = useMemo(() => (result?.parts ?? []).map((h, i) => [h, i] as const)
    .filter(([h, i]) => sure(h) && !countedHits.has(i)), [result, countedHits]);

  const countSure = useCallback(async () => {
    if (!sureHits.length || countingRef.current) return;
    countingRef.current = true;
    setCountingAll(true);
    let n = 0;
    try {
      for (const [h, i] of sureHits) if (await confirm(h, i)) n++;
    } finally { countingRef.current = false; setCountingAll(false); }
    if (n) toastSuccess(`${plural(n, "Teil", "Teile")} gezählt.`);
    refocus(tableHead, ".vision-count");
    reload();
  }, [sureHits, confirm, reload]);

  const undo = async (c: Counted) => {
    try {
      const r = await api<{ remaining: number }>(`/api/vision/confirm/${c.id}`, { method: "DELETE" });
      adjust(c, r.remaining);
      setResult((res) => res && { ...res, parts: res.parts.map((p, i) =>
        c.hit === i ? { ...p, counted: false, confirmation_id: undefined } : p) });
      setCounted((all) => all.filter((x) => x.id !== c.id));
      toastSuccess(`${c.label}: Zählung zurückgenommen.`);
      refocus(logHead, ".vision-log .bp5-button");
      reload();
    } catch (e: any) { toastError(e.message); }
  };

  /* Tastatur am Tisch: Leertaste misst, Enter zählt alle sicheren, 1–9 zählt das
     Teil mit dieser Nummer, Esc geht zurück ins laufende Bild. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.body.classList.contains("bp5-overlay-open")) return;
      if ((e.target as HTMLElement)?.closest?.("button, a, [role='button']") && (e.key === " " || e.key === "Enter")) return;
      if (e.key === " ") { e.preventDefault(); if (status?.available) identify(); return; }
      if (e.key === "Enter") { e.preventDefault(); countSure(); return; }
      if (e.key === "Escape") {
        if (zoneDraw || draft) { setZoneDraw(false); setDraft(null); }
        else if (corners) setCorners(null);
        else if (source === "camera" && still) backToLive();
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && result?.parts[n - 1] && !countedHits.has(n - 1)) {
        e.preventDefault();
        countOne(result.parts[n - 1], n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    if (zoneDraw || !corners || corners.length >= 4) return;
    const b = e.currentTarget.getBoundingClientRect();
    setCorners([...corners, [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height]]);
  };

  const frameSize = () => {
    if (still) return { w: still.w, h: still.h };
    const v = video.current;
    return v?.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null;
  };

  const atPointer = (e: React.PointerEvent<SVGSVGElement>): number[] => {
    const b = e.currentTarget.getBoundingClientRect();
    return [clamp01((e.clientX - b.left) / b.width), clamp01((e.clientY - b.top) / b.height)];
  };

  const zoneDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!zoneDraw) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = atPointer(e);
    setDraft({ a: p, b: p });
  };

  const zoneMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!zoneDraw || !draft) return;
    setDraft({ ...draft, b: atPointer(e) });
  };

  const saveZone = async (a: number[], b: number[]) => {
    const size = frameSize();
    const pts = rectangle(a, b);
    if (!size) { toastError("Erst ein Kamerabild oder Foto laden."); return; }
    if ((pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) < 0.002) {
      toastError("Der Zählbereich ist zu klein; bitte ein größeres Rechteck aufziehen.");
      setDraft(null);
      setZoneDraw(false);
      return;
    }
    setZoneBusy(true);
    try {
      const zone = await api<Zone>("/api/vision/zone", {
        method: "PUT",
        body: JSON.stringify({ points: pts, width_px: size.w, height_px: size.h,
                               enabled: true, auto_count: true }),
      });
      setStatus((s) => s && { ...s, zone });
      setResult((r) => r && { ...r, zone: { ...zone, points: pts } });
      setZoneDraw(false);
      setDraft(null);
      toastSuccess("Zählbereich gespeichert: Was darin liegt, zählt automatisch.");
    } catch (e: any) { toastError(e.message); } finally { setZoneBusy(false); }
  };

  const zoneUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!zoneDraw || !draft) return;
    const b = atPointer(e);
    setDraft({ ...draft, b });
    void saveZone(draft.a, b);
  };

  const patchZone = async (patch: Partial<Pick<Zone, "enabled" | "auto_count">>) => {
    if (!status) return;
    if (!status.zone.points?.length) { setZoneDraw(true); return; }
    const size = frameSize();
    if (!size) { toastError("Erst ein Kamerabild oder Foto laden."); return; }
    setZoneBusy(true);
    try {
      const zone = await api<Zone>("/api/vision/zone", {
        method: "PUT",
        body: JSON.stringify({ points: status.zone.points, width_px: size.w, height_px: size.h,
                               enabled: patch.enabled ?? status.zone.enabled,
                               auto_count: patch.auto_count ?? status.zone.auto_count }),
      });
      setStatus((s) => s && { ...s, zone });
      setResult((r) => r && { ...r, zone: r.zone ? { ...zone, points: r.zone.points } : undefined });
    } catch (e: any) { toastError(e.message); } finally { setZoneBusy(false); }
  };

  const clearZone = async () => {
    setZoneBusy(true);
    try {
      const zone = await api<Zone>("/api/vision/zone", { method: "DELETE" });
      setStatus((s) => s && { ...s, zone });
      setResult((r) => r && { ...r, zone: { ...zone, points: [] } });
      setZoneDraw(false);
      setDraft(null);
      toastSuccess("Zählbereich entfernt.");
    } catch (e: any) { toastError(e.message); } finally { setZoneBusy(false); }
  };

  const applyRectangle = async () => {
    const size = frameSize();
    if (!size || !corners || corners.length !== 4) return;
    try {
      const r = await api<{ height_mm: number; pitch_deg: number; roll_deg: number; reproj_px: number }>(
        "/api/vision/calibration/rectangle", {
          method: "POST",
          body: JSON.stringify({ corners, side1_mm: sides.a, side2_mm: sides.b, width_px: size.w,
                                 height_px: size.h, apply: true }),
        });
      toastSuccess(`Kamera ${r.height_mm.toFixed(0)} mm über dem Tisch, Neigung ${deg(r.pitch_deg)} / ${deg(r.roll_deg)}.`);
      setCorners(null);
      setStatus(await api<Status>("/api/vision/status"));
    } catch (e: any) { toastError(e.message); }
  };

  const saveCalibration = async (patch: Partial<Calibration>) => {
    if (!status) return;
    try {
      const calibration = await api<Calibration>("/api/vision/calibration", {
        method: "PUT", body: JSON.stringify({ ...status.calibration, ...patch }),
      });
      setStatus({ ...status, calibration });
    } catch (e: any) { toastError(e.message); }
  };

  const orders = useMemo(() => [...new Set(rows.map((r) => r.work_order))], [rows]);
  const totals = useMemo(() => rows.reduce((t, r) => ({ qty: t.qty + r.qty, done: t.done + Math.min(r.confirmed, r.qty) }), { qty: 0, done: 0 }), [rows]);
  const onTable = useMemo(() => new Set((result?.parts ?? []).map((h) => `${h.work_order}-${h.position_id}`)), [result]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = new Map<string, Expected[]>();
    for (const r of rows) {
      if (!showDone && r.remaining === 0) continue;
      if (q && ![r.label, r.tag, r.work_order, r.order_no, r.customer ?? ""].some((s) => s.toLowerCase().includes(q))) continue;
      out.set(r.work_order, [...(out.get(r.work_order) ?? []), r]);
    }
    return [...out.entries()].map(([no, list]) => {
      const all = rows.filter((r) => r.work_order === no);
      return { no, list, qty: all.reduce((s, r) => s + r.qty, 0), done: all.reduce((s, r) => s + Math.min(r.confirmed, r.qty), 0) };
    });
  }, [rows, query, showDone]);

  if (!status) return <Spinner size={30} />;

  const cal = status.calibration;
  const size = frameSize();
  const ready = status.available && (source !== "camera" || live);
  const canPick = !!size && (live || !!still);
  const view = still ? "still" : source === "camera" && live ? "live" : "empty";
  const zonePoints = draft ? rectangle(draft.a, draft.b)
    : result?.zone?.points?.length ? result.zone.points : status.zone.points;
  const zoneOn = result?.zone?.enabled ?? status.zone.enabled;
  const zoneCorner = zonePoints.length >= 3 ? {
    left: `${Math.min(...zonePoints.map((p) => p[0])) * 100}%`,
    top: `${Math.min(...zonePoints.map((p) => p[1])) * 100}%`,
  } : undefined;

  return (
    <div className="vision-page">
      <div className="vision-head">
        <div>
          <div className="ui-page-title-row"><h1 className="page-title">Teileerkennung</h1><PageInfo text={pageInfo("teileerkennung")} /></div>
          <p className="muted vision-sub">
            {totals.qty
              ? <>{plural(totals.done, "Teil", "Teile")} von {totals.qty.toLocaleString("de-DE")} gezählt{order ? ` in ${order}` : ""}</>
              : "Kein offener Innenauftrag."}
          </p>
        </div>
        {totals.qty > 0 && (
          <div className="vision-progress" role="group" aria-label={`Fortschritt ${pct(totals.done / totals.qty)}`}>
            <ProgressBar value={totals.done / totals.qty} intent="success" stripes={false} animate={false} />
            <span className="num">{pct(totals.done / totals.qty)}</span>
          </div>
        )}
      </div>

      {!status.available && (
        <Callout intent="warning" icon="warning-sign" title="Die Bilderkennung ist nicht installiert." className="vision-callout">
          Auf dem Server fehlt OpenCV: <code>pip install opencv-python-headless</code>.
        </Callout>
      )}

      <div className="vision-grid">
        <Card className="vision-view">
          <div className="vision-bar">
            <SegmentedControl small value={source} onValueChange={(v) => { setSource(v as Source); setAuto(false); backToLive(); }}
                              options={[{ value: "camera", label: "Kamera", icon: "camera" },
                                        { value: "file", label: "Foto laden", icon: "media" },
                                        { value: "sample", label: "Testbild", icon: "lab-test" }]} />
            <HTMLSelect aria-label="Innenauftrag" value={order} onChange={(e) => setOrder(e.target.value)}>
              <option value="">Alle offenen Innenaufträge</option>
              {orders.map((no) => <option key={no} value={no}>{no}</option>)}
            </HTMLSelect>
          </div>

          <div className={`vision-frame is-${view}`} style={size ? { aspectRatio: `${size.w} / ${size.h}` } : undefined}>
            <video ref={video} autoPlay playsInline muted aria-label="Kamerabild vom Sortiertisch"
                   hidden={source !== "camera" || !!still} onLoadedMetadata={() => setLive(true)} />
            {still && <img src={still.url} alt="Gemessenes Standbild" />}
            {view === "empty" && (
              <div className="vision-empty">
                {source === "camera" && cameraError ? (
                  <>
                    <Icon icon="camera" size={28} />
                    <strong>{cameraError}</strong>
                    <span>Ohne Kamera: ein Foto vom Tisch laden oder mit einem Testbild ausprobieren.</span>
                    <div className="vision-empty-actions">
                      <Button icon="media" text="Foto laden" onClick={() => { setSource("file"); setTimeout(() => fileInput.current?.click(), 0); }} />
                      <Button icon="lab-test" text="Testbild" onClick={() => setSource("sample")} />
                    </div>
                  </>
                ) : source === "camera" ? (
                  <><Spinner size={24} /><span>Kamera wird geöffnet …</span></>
                ) : source === "file" ? (
                  <>
                    <Icon icon="media" size={28} />
                    <strong>Foto vom Sortiertisch</strong>
                    <span>JPEG oder PNG bis 8 MB, von oben aufgenommen. Das Bild wird nur gemessen, nicht gespeichert.</span>
                    <div className="vision-empty-actions"><Button intent="primary" icon="folder-open" text="Foto wählen" onClick={() => fileInput.current?.click()} /></div>
                  </>
                ) : (
                  <>
                    <Icon icon="lab-test" size={28} />
                    <strong>Testbild aus offenen Teilen</strong>
                    <span>Der Server legt offene Teile zufällig auf einen Tisch und rechnet sie durch die eingemessene Kamera. So lässt sich die Erkennung ohne Kamera prüfen.</span>
                    <div className="vision-empty-actions"><Button intent="primary" icon="lab-test" text="Testbild erzeugen" loading={busy} disabled={!status.available} onClick={identify} /></div>
                  </>
                )}
              </div>
            )}
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" onClick={click}
                 className={corners || zoneDraw ? "vision-overlay is-picking" : "vision-overlay"} aria-hidden="true"
                 onPointerDown={zoneDown} onPointerMove={zoneMove} onPointerUp={zoneUp}
                 onPointerCancel={() => { setDraft(null); setZoneDraw(false); }}>
              {view !== "empty" && zonePoints.length >= 3 && (
                <polygon points={points(zonePoints)}
                         className={`vision-zone${zoneOn ? "" : " is-off"}${zoneDraw ? " is-drawing" : ""}`} />
              )}
              {result?.parts.map((h, i) => (
                <polygon key={`p${i}`} points={points(h.box)}
                         className={`vision-hit${sure(h) ? "" : " is-unsure"}${countedHits.has(i) ? " is-counted" : ""}${focus === i ? " is-focus" : ""}`} />
              ))}
              {result?.unknown.map((u, i) => <polygon key={`u${i}`} points={points(u.box)} className="vision-unknown" />)}
              {corners && corners.length > 1 && <polyline points={points(corners)} className="vision-corners" />}
              {corners && corners.length === 4 && <polygon points={points(corners)} className="vision-corners" />}
            </svg>
            {result?.parts.map((h, i) => {
              const [x, y] = centre(h.box);
              return (
                <span key={`b${i}`} aria-hidden="true" className={`vision-badge${sure(h) ? "" : " is-unsure"}${countedHits.has(i) ? " is-counted" : ""}`}
                      style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
                      onMouseEnter={() => setFocus(i)} onMouseLeave={() => setFocus(null)}>
                  {countedHits.has(i) ? <Icon icon="tick" size={12} /> : i + 1}
                </span>
              );
            })}
            {result?.unknown.map((u, i) => {
              const [x, y] = centre(u.box);
              return <span key={`ub${i}`} aria-hidden="true" className="vision-badge is-unknown" style={{ left: `${x * 100}%`, top: `${y * 100}%` }}>?</span>;
            })}
            {corners?.map(([x, y], i) => (
              <span key={`c${i}`} className="vision-corner" style={{ left: `${x * 100}%`, top: `${y * 100}%` }}>{i + 1}</span>
            ))}
            {view !== "empty" && zoneCorner && (
              <span className={`vision-zone-label${zoneOn ? "" : " is-off"}`} style={zoneCorner}>
                {zoneDraw ? "Bereich aufziehen" : zoneOn ? "Zählbereich" : "Zählbereich aus"}
              </span>
            )}
            {view !== "empty" && (
              <span className={`vision-chip${still ? "" : " is-live"}`}>
                {still ? `${still.origin === "sample" ? "Testbild" : still.origin === "file" ? "Foto" : "Standbild"} · ${time(still.at)}` : auto ? "Live · laufend" : "Live"}
              </span>
            )}
          </div>

          <div className="vision-tools">
            <Button intent="primary" icon={source === "file" ? "folder-open" : source === "sample" ? "lab-test" : "camera"} loading={busy}
                    text={source === "file" ? "Foto wählen" : source === "sample" ? "Neues Testbild" : "Erkennen"}
                    disabled={!ready} onClick={identify} title="Leertaste" aria-keyshortcuts="Space" />
            {source === "camera" && (
              <Switch checked={auto} disabled={!ready} label="Laufend messen" onChange={() => { setAuto(!auto); setStill(null); }} className="vision-switch" />
            )}
            {source === "sample" && (
              <HTMLSelect aria-label="Teile auf dem Testbild" value={sampleCount} onChange={(e) => setSampleCount(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{plural(n, "Teil", "Teile")}</option>)}
              </HTMLSelect>
            )}
            {source === "camera" && devices.length > 1 && (
              <HTMLSelect aria-label="Kamera" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                <option value="">Kamera wählen</option>
                {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Kamera ${i + 1}`}</option>)}
              </HTMLSelect>
            )}
            {still && source === "camera" && !auto && <Button minimal icon="video" text="Zurück zum Live-Bild" onClick={backToLive} title="Esc" />}
            <span className="vision-keys muted">
              <kbd>Leertaste</kbd> erkennen · <kbd>Enter</kbd> alle sicheren zählen · <kbd>1</kbd>–<kbd>9</kbd> einzeln
            </span>
          </div>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png" hidden onChange={onFile} />
        </Card>

        <div className="vision-side">
          <Card className="vision-card">
            <div className="vision-card-head">
              <h2 className="section-title" ref={tableHead} tabIndex={-1}>Auf dem Tisch</h2>
              {result && result.parts.length > 0 && (
                <Button intent="success" icon="tick" disabled={!sureHits.length} loading={countingAll} onClick={countSure} aria-keyshortcuts="Enter"
                        text={sureHits.length ? `${plural(sureHits.length, "sicheres", "sichere")} zählen`
                              : result.parts.every((_, i) => countedHits.has(i)) ? "Alle gezählt" : "Rest von Hand prüfen"} />
              )}
            </div>
            <p className="sr-only" aria-live="polite">
              {result ? `${plural(result.parts.length, "Teil", "Teile")} erkannt, davon ${sureHits.length} sicher offen${result.unknown.length ? `, ${result.unknown.length} unbekannt` : ""}.` : ""}
            </p>
            {!result && <p className="muted">Teil flach auf den Tisch legen, mit Abstand zu anderen Teilen, und erkennen.</p>}
            {result && !result.parts.length && !result.unknown.length && (
              <p className="muted">Kein Teil im Bild. Hebt es sich deutlich vom Tisch ab, und liegt es ganz im Bild?</p>
            )}
            <ol className="vision-results">
              {result?.parts.map((h, i) => {
                const done = countedHits.has(i);
                return (
                  <li key={i} className={`vision-result${focus === i ? " is-focus" : ""}${done ? " is-counted" : ""}`}
                      onMouseEnter={() => setFocus(i)} onMouseLeave={() => setFocus(null)}>
                    <span className={`vision-no${sure(h) ? "" : " is-unsure"}`}>{done ? <Icon icon="tick" size={12} /> : i + 1}</span>
                    <Shape outline={h.outline} />
                    <div className="vision-result-body">
                      <div className="vision-result-title">
                        <strong>{name(h)}</strong>
                        <Tag minimal>{h.work_order}</Tag>
                        {h.ambiguous > 0 && <Tag minimal intent="warning">{plural(h.ambiguous + 1, "Teil", "Teile")} möglich</Tag>}
                      </div>
                      <div className="muted vision-meta">
                        <span className="num">{mm(h.length_mm)} × {mm(h.width_mm)} mm</span>
                        <span>noch {h.remaining} offen</span>
                        {office && h.customer && <span>{h.customer}</span>}
                      </div>
                      <div className="vision-meter" title={`Formübereinstimmung ${pct(h.confidence)}`} role="meter" aria-label="Formübereinstimmung"
                           aria-valuemin={0} aria-valuemax={1} aria-valuenow={h.confidence} aria-valuetext={pct(h.confidence)}>
                        <span style={{ width: width(h.confidence) }} className={sure(h) ? "" : "is-unsure"} />
                        <em className="num">{pct(h.confidence)}</em>
                      </div>
                      {!done && !!h.alternatives?.length && (
                        <HTMLSelect minimal className="vision-alt" aria-label="Stattdessen zählen" value=""
                                    onChange={(e) => { const alt = h.alternatives![Number(e.target.value)]; if (alt) countOne(h, i, alt); }}>
                          <option value="">{h.ambiguous ? "Doch ein anderes Teil …" : "In anderem Innenauftrag zählen …"}</option>
                          {([[0, h.ambiguous, "Andere Form, fast gleich"], [h.ambiguous, h.alternatives.length, "Dasselbe Teil, anderer Innenauftrag"]] as const)
                            .filter(([a, b]) => b > a)
                            .map(([a, b, label]) => (
                              <optgroup key={label} label={label}>
                                {h.alternatives!.slice(a, b).map((alt, j) => (
                                  <option key={a + j} value={a + j} disabled={alt.remaining === 0}>
                                    {name(alt)} · {alt.work_order}{alt.remaining === 0 ? " (fertig)" : ` (${alt.remaining} offen)`}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                        </HTMLSelect>
                      )}
                    </div>
                    {done
                      ? <Tag minimal intent="success" icon="tick">Gezählt</Tag>
                      : <Button className="vision-count" text="Zählen" icon="tick" intent={sure(h) ? "success" : "none"} aria-label={`${name(h)} zählen`}
                                disabled={h.remaining === 0} onClick={() => countOne(h, i)} />}
                  </li>
                );
              })}
              {result?.unknown.map((u, i) => (
                <li key={`u${i}`} className="vision-result is-unknown">
                  <span className="vision-no is-unknown">?</span>
                  <span className="vision-shape" aria-hidden="true" />
                  <div className="vision-result-body">
                    <strong>Unbekanntes Teil</strong>
                    <div className="muted"><span className="num">{mm(u.length_mm)} × {mm(u.width_mm)} mm</span>, passt zu keiner offenen Position{order ? ` in ${order}` : ""}.</div>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          {counted.length > 0 && (
            <Card className="vision-card">
              <div className="vision-card-head">
                <h2 className="section-title" ref={logHead} tabIndex={-1}>Zuletzt gezählt</h2>
                <span className="muted">{plural(counted.length, "Teil", "Teile")} in dieser Sitzung</span>
              </div>
              <ul className="vision-log">
                {counted.slice(0, 8).map((c) => (
                  <li key={c.id}>
                    <span className="num muted">{time(c.at)}</span>
                    <span className="vision-log-name" title={c.label}>{c.label}</span>
                    <span className="muted">{c.work_order}</span>
                    <Button minimal icon="undo" text="Zurück" aria-label={`${c.label} zurücknehmen`} onClick={() => undo(c)} />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="vision-card">
            <div className="vision-card-head">
              <h2 className="section-title">Offene Teile</h2>
              <Switch checked={showDone} label="Gezählte zeigen" onChange={() => setShowDone(!showDone)} className="vision-switch" />
            </div>
            <InputGroup leftIcon="search" placeholder="Teil, Auftrag oder Innenauftrag" value={query} aria-label="Offene Teile filtern"
                        onChange={(e) => setQuery(e.target.value)} className="vision-search" />
            {!groups.length ? <p className="muted">{rows.length ? "Nichts passt zu diesem Filter." : "Kein offener Innenauftrag."}</p> : (
              <div className="vision-open">
                {groups.map((g) => (
                  <section key={g.no}>
                    <header>
                      <button type="button" className="vision-order" onClick={() => setOrder(order === g.no ? "" : g.no)}
                              aria-pressed={order === g.no} title={order === g.no ? "Wieder alle Innenaufträge" : "Nur diesen Innenauftrag erkennen"}>
                        <Icon icon={order === g.no ? "filter-remove" : "filter"} size={12} /> {g.no}
                      </button>
                      <span className="num muted">{g.done} / {g.qty}</span>
                      <ProgressBar value={g.qty ? g.done / g.qty : 0} intent="success" stripes={false} animate={false} />
                    </header>
                    <ul>
                      {g.list.map((r) => (
                        <li key={`${r.work_order}-${r.position_id}`}
                            className={`${onTable.has(`${r.work_order}-${r.position_id}`) ? "is-on-table" : ""}${r.remaining === 0 ? " is-done" : ""}`}>
                          <Shape outline={r.outline} size={26} />
                          <span className="vision-open-name" title={name(r)}>{name(r)}{r.order_no && <span className="muted"> · {r.order_no}</span>}</span>
                          <span className="num">{r.confirmed} / {r.qty}</span>
                          <span className="vision-open-bar"><span style={{ width: width(r.qty ? r.confirmed / r.qty : 0) }} /></span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </Card>

          <Card className="vision-card">
            <div className="vision-card-head">
              <h2 className="section-title">Zählbereich</h2>
              <Tag minimal intent={status.zone.enabled ? "success" : "none"}>
                {status.zone.points.length ? status.zone.enabled ? "aktiv" : "aus" : "nicht eingerichtet"}
              </Tag>
            </div>
            <p className="muted">
              Ein Rechteck im Kamerabild aufziehen: Jedes sicher erkannte Teil darin zählt einmal und wird
              vom offenen Rest abgezogen. Erst wenn es den Bereich verlassen hat, zählt dort ein neues Teil.
              Testbilder zählen nie, sie prüfen nur die Einmessung.
            </p>
            <div className="vision-tools">
              {office && (
                <Button icon="selection" active={zoneDraw} loading={zoneBusy}
                        text={zoneDraw ? "Aufziehen … (Esc)" : status.zone.points.length ? "Neu aufziehen" : "Bereich aufziehen"}
                        onClick={() => { if (!zoneDraw) setAuto(false); setZoneDraw(!zoneDraw); setDraft(null); setCorners(null); }} />
              )}
              {office && status.zone.points.length > 0 && (
                <HTMLSelect aria-label="Zählbereich" disabled={zoneBusy}
                  value={!status.zone.enabled ? "off" : status.zone.auto_count ? "auto" : "on"}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    patchZone({ enabled: v !== "off", auto_count: v === "auto" });
                  }}>
                  <option value="off">Bereich aus</option>
                  <option value="on">Nur anzeigen</option>
                  <option value="auto">Automatisch zählen</option>
                </HTMLSelect>
              )}
              {office && status.zone.points.length > 0 && (
                <Button minimal intent="danger" icon="trash" text="Entfernen" disabled={zoneBusy} onClick={clearZone} />
              )}
            </div>
            {!office && status.zone.points.length > 0 && (
              <p className="muted">{status.zone.enabled && status.zone.auto_count
                ? "Teile in diesem Bereich werden automatisch gezählt."
                : "Der Zählbereich ist sichtbar, zählt aber nicht automatisch."}</p>
            )}
          </Card>

          {office && (
            <Card className="vision-card">
              <button type="button" className="vision-collapse" aria-expanded={calOpen} onClick={() => setCalOpen(!calOpen)}>
                <Icon icon={calOpen ? "chevron-down" : "chevron-right"} />
                <h2 className="section-title">Kamera einmessen</h2>
                <span className="muted num">{cal.height_mm.toFixed(0)} mm · {deg(cal.pitch_deg)} / {deg(cal.roll_deg)} · ± {cal.tolerance_mm} mm</span>
              </button>
              <Collapse isOpen={calOpen} keepChildrenMounted>
                <div className="vision-fields">
                  {([["height_mm", "Höhe über Tisch (mm)"], ["thickness_mm", "Teiledicke (mm)"], ["hfov_deg", "Blickwinkel (°)"],
                     ["tolerance_mm", "Maßtoleranz (mm)"]] as const).map(([key, label]) => (
                    <FormGroup key={key} label={label} labelFor={key}>
                      <NumericInput key={`${key}-${cal[key]}`} id={key} fill buttonPosition="none" defaultValue={cal[key]}
                                    onBlur={(e) => { const v = Number(e.target.value); if (v !== cal[key]) saveCalibration({ [key]: v }); }} />
                    </FormGroup>
                  ))}
                </div>
                <p className="muted">
                  Genauer: ein Rechteck bekannter Größe auf den Tisch legen (ein A3-Blatt: 420 × 297 mm) und seine vier Ecken der Reihe nach
                  im Bild anklicken, Seite 1 von Ecke 1 nach 2. Das misst Höhe und Neigung selbst. Danach mit einem Testbild prüfen.
                </p>
                <div className="vision-fields">
                  <FormGroup label="Seite 1 (mm)" labelFor="side-a"><NumericInput id="side-a" fill buttonPosition="none" value={sides.a} onValueChange={(a) => setSides({ ...sides, a })} /></FormGroup>
                  <FormGroup label="Seite 2 (mm)" labelFor="side-b"><NumericInput id="side-b" fill buttonPosition="none" value={sides.b} onValueChange={(b) => setSides({ ...sides, b })} /></FormGroup>
                </div>
                {corners === null
                  ? <Button icon="widget" text="Ecken im Bild anklicken" disabled={!canPick} onClick={() => setCorners([])} />
                  : <div className="vision-tools">
                      <Button intent="primary" text={`Einmessen (${corners.length} von 4)`} disabled={corners.length !== 4} onClick={applyRectangle} />
                      <Button minimal text="Letzte Ecke weg" disabled={!corners.length} onClick={() => setCorners(corners.slice(0, -1))} />
                      <Button minimal text="Abbrechen" onClick={() => setCorners(null)} />
                    </div>}
              </Collapse>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
