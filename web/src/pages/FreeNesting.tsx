import { Button, Icon, Spinner, Tag } from "@blueprintjs/core";
import { KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, apiDownload } from "../api";
import Callout from "../components/Callout";
import DrawingThumb from "../components/DrawingThumb";
import PastePointsDialog from "../components/PastePointsDialog";
import { importFile, ImportResult, listDrawings } from "../drawingsApi";
import {
  addPart, blockers, DrawingItem, isActive, Layout, LIMITS, loadSettings, pct, placedPath, PRESETS,
  QUALITIES, requestBody, ROTATIONS, RUN_KEY, RunPart, RunView, saveSettings, Settings, settingsKey, STATUS_TEXT, totals,
} from "../freeNesting";
import { num } from "../nesting";
import { plural } from "../plural";
import { navigate } from "../router";
import { toastError } from "../toast";
import { KpiStrip, PageInfo, pageInfo } from "../ui";
import NestingModeBar from "../components/NestingModeBar";
import "../free-nesting.css";

/* Freies Schachteln — Zeichnungen aus der Bibliothek auf Platten legen, ohne Auftrag.

   Nichts davon wird zu einem Fertigungsauftrag: der Lauf liegt im Speicher des Servers, schreibt
   nicht in Aufträge, Platten, Lager oder Plan, und jede Datei sagt, dass sie freies Schachteln ist.
   Das Budget zählt Schritte, nie Zeit: gleiche Einstellungen und Startwert, gleiche Lage. Die Lage
   wird exakt geprüft (kerf.verify); eine ungültige wird nicht zum Export angeboten. */

const POLL_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readRunMemo(): { id: string; key: string } | null {
  try {
    const raw = sessionStorage.getItem(RUN_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.id === "string" && typeof v.key === "string" ? v : null;
  } catch { return null; }
}
function writeRunMemo(v: { id: string; key: string } | null): void {
  try { if (v) sessionStorage.setItem(RUN_KEY, JSON.stringify(v)); else sessionStorage.removeItem(RUN_KEY); } catch { /* egal */ }
}

/** Zeichnung aus „?add=7" im Hash; danach entfernt, damit ein Neuladen sie nicht noch einmal zufügt. */
function takeAddParam(): number | null {
  const [path, query] = window.location.hash.split("?");
  if (!query) return null;
  const id = Number(new URLSearchParams(query).get("add"));
  window.history.replaceState(null, "", window.location.pathname + window.location.search + path);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function FreeNesting() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [lib, setLib] = useState<Map<number, DrawingItem>>(new Map());
  const [libTotal, setLibTotal] = useState(0);
  const [libReady, setLibReady] = useState(false);
  const [run, setRun] = useState<RunView | null>(null);
  const [runKey, setRunKey] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [report, setReport] = useState<ImportResult | null>(null);
  const [paste, setPaste] = useState(false);
  const [pick, setPick] = useState("");
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const polling = useRef(0);
  const addDone = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const patch = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), []);
  useEffect(() => { saveSettings(settings); }, [settings]);

  // ---- Bibliothek laden; fehlende Zeichnungen einzeln holen, gelöschte aus der Liste nehmen
  const loadLibrary = useCallback(async () => {
    try {
      const r = await listDrawings("");
      const map = new Map(r.items.map((d) => [d.id, d]));
      setLibTotal(r.total);
      const missing = settingsRef.current.parts.map((p) => p.id).filter((id) => !map.has(id));
      const gone = new Set<number>();
      await Promise.all(missing.slice(0, 40).map(async (id) => {
        try {
          const d = await api<DrawingItem & { outer: [number, number][]; holes: [number, number][][] }>(`/api/drawings/${id}`);
          map.set(id, { ...d, preview: { outer: d.outer, holes: d.holes } });
        } catch (e) { if (e instanceof ApiError && e.status === 404) gone.add(id); }
      }));
      setLib(map);
      if (gone.size) setSettings((s) => ({ ...s, parts: s.parts.filter((p) => !gone.has(p.id)) }));
      setLibReady(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setLibReady(true); }
  }, []);

  // ---- Lauf abfragen, bis er endet. Aus dem Klick gestartet, nicht aus einem Effekt: nichts rennt gegen React.
  const poll = useCallback(async (id: string, token: number) => {
    let rev = 0, misses = 0;
    for (;;) {
      if (polling.current !== token) return;
      try {
        const v = await api<RunView>(`/api/free-nesting/runs/${id}?rev=${rev}`);
        if (polling.current !== token) return;
        misses = 0; rev = v.rev;
        setRun((prev) => (prev && prev.id === v.id ? { ...v, layout: v.layout ?? prev.layout, parts: v.parts ?? prev.parts } : v));
        if (!isActive(v.status)) return;
      } catch (e) {
        if (polling.current !== token) return;
        if (e instanceof ApiError && e.status === 404) {
          setError("Der Lauf ist nicht mehr da (der Server wurde neu gestartet). Bitte neu starten.");
          setRun(null); writeRunMemo(null); return;
        }
        if (++misses >= 5) { setError("Der Stand des Laufs ist nicht abrufbar."); return; }
      }
      await sleep(POLL_MS);
    }
  }, []);

  useEffect(() => {
    loadLibrary();
    if (!addDone.current) {
      addDone.current = true;
      const id = takeAddParam();
      if (id) setSettings((s) => (s.parts.some((p) => p.id === id) ? s : addPart(s, id)));
    }
    const memo = readRunMemo();
    if (memo) {
      const token = ++polling.current;
      api<RunView>(`/api/free-nesting/runs/${memo.id}`).then((v) => {
        if (polling.current !== token) return;
        setRun(v); setRunKey(memo.key);
        if (isActive(v.status)) poll(v.id, token);
      }).catch(() => writeRunMemo(null));
    }
    return () => { polling.current = -1; };
  }, [loadLibrary, poll]);

  const start = async () => {
    setError(""); setStarting(true);
    try {
      const v = await api<RunView>("/api/free-nesting/runs", { method: "POST", body: JSON.stringify(requestBody(settings)) });
      const token = ++polling.current;
      const key = settingsKey(settings);
      setRun(v); setRunKey(key); writeRunMemo({ id: v.id, key });
      poll(v.id, token);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setStarting(false); }
  };

  const stop = async () => {
    if (!run) return;
    try {
      const v = await api<RunView>(`/api/free-nesting/runs/${run.id}/stop`, { method: "POST" });
      setRun((prev) => (prev ? { ...prev, status: v.status } : v));
    } catch (e) { toastError(e instanceof Error ? e.message : String(e)); }
  };

  const active = isActive(run?.status);
  const stale = !!run && runKey !== settingsKey(settings);
  const problems = blockers(settings);
  const t = totals(settings);

  const adopt = (r: ImportResult) => {
    setReport(r);
    setSettings((s) => r.created.reduce((acc, d) => addPart(acc, d.id), s));
    loadLibrary();
  };
  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const all: ImportResult = { created: [], skipped: [], notes: [] };
    for (const f of Array.from(files)) {
      try {
        const r = await importFile(f);
        all.created.push(...r.created); all.skipped.push(...r.skipped.map((s) => `${f.name}: ${s}`));
        all.notes.push(...r.notes.filter((n) => !all.notes.includes(n)));
      } catch (e) { all.skipped.push(e instanceof Error ? e.message : String(e)); }
    }
    if (fileInput.current) fileInput.current.value = "";
    adopt(all);
  };

  const setPart = (id: number, p: Partial<{ qty: number; gap: number | null }>) =>
    patch({ parts: settings.parts.map((x) => (x.id === id ? { ...x, ...p } : x)) });
  const free = [...lib.values()].filter((d) => !settings.parts.some((p) => p.id === d.id));

  return (
    <div>
      <NestingModeBar active="freies-schachteln" />
      <div className="ui-page-title-row"><h1 className="page-title">Freies Schachteln</h1><PageInfo text={pageInfo("freies-schachteln")} /></div>
      <p className="page-sub">Zeichnungen aus der Bibliothek auf Platten legen, ohne Auftrag. Das Ergebnis ist kein Fertigungsauftrag und ändert weder Aufträge noch Plan.</p>
      <div className="fn-page">
        <aside className="fn-rail" aria-label="Einstellungen">
          <section className="fn-sec" aria-labelledby="fn-h-sheet">
            <h2 id="fn-h-sheet">Platte</h2>
            <label className="fn-field">Format
              <select value={settings.preset} onChange={(e) => {
                const p = PRESETS.find((x) => x.key === e.target.value)!;
                patch(p.w ? { preset: p.key, sheetW: p.w, sheetH: p.h } : { preset: "custom" });
              }}>
                {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select></label>
            <div className="fn-row2">
              <Num label="Länge (mm)" value={settings.sheetW} min={50} max={10000} step={10} onChange={(v) => patch({ sheetW: v, preset: "custom" })} />
              <Num label="Breite (mm)" value={settings.sheetH} min={50} max={10000} step={10} onChange={(v) => patch({ sheetH: v, preset: "custom" })} />
              <Num label="Teileabstand (mm)" value={settings.spacing} min={0} max={200} step={0.5} onChange={(v) => patch({ spacing: v })} />
              <Num label="Randabstand (mm)" value={settings.margin} min={0} max={500} step={1} onChange={(v) => patch({ margin: v })} />
              <Num label="Platten im Lager" value={settings.stock} min={0} max={1000} step={1} whole onChange={(v) => patch({ stock: v })} />
            </div>
            <p className="fn-hint">0 Platten im Lager heißt unbegrenzt: es werden so viele Platten geöffnet, wie die Teile brauchen.</p>
          </section>

          <section className="fn-sec" aria-labelledby="fn-h-strategy">
            <h2 id="fn-h-strategy">Strategie</h2>
            <label className="fn-field">Erlaubte Drehungen
              <select value={settings.rotations} onChange={(e) => patch({ rotations: e.target.value as Settings["rotations"] })}>
                {ROTATIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select></label>
            <fieldset className="fn-field" style={{ border: 0, padding: 0 }}>
              <legend style={{ padding: 0 }}>Füllen von</legend>
              <div className="fn-seg">
                {(["left", "top"] as const).map((g) => (
                  <label key={g} className="bp5-control bp5-radio" style={{ margin: 0 }}>
                    <input type="radio" name="fn-gravity" checked={settings.gravity === g} onChange={() => patch({ gravity: g })} />
                    <span className="bp5-control-indicator" />{g === "left" ? "linker Kante" : "oberer Kante"}
                  </label>
                ))}
              </div>
            </fieldset>
            <details className="fn-advanced">
              <summary>Rechenkern und Suche</summary>
              <div className="fn-row2">
                <label className="fn-field">Rasterauflösung
                  <select value={settings.quality} onChange={(e) => patch({ quality: e.target.value as Settings["quality"] })}>
                    {QUALITIES.map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}
                  </select></label>
                <Num label="Rasterweite (mm)" value={settings.cell} min={0.25} max={100} step={0.25}
                     disabled={settings.quality !== "manual"} onChange={(v) => patch({ cell: v })} />
                <Num label="Max. Schritte" value={settings.maxSteps} min={1} max={LIMITS.steps} step={10} whole onChange={(v) => patch({ maxSteps: v })} />
                <Num label="Stopp ohne Gewinn nach (Schritten, 0 = aus)" value={settings.stall} min={0} max={LIMITS.steps} step={25} whole onChange={(v) => patch({ stall: v })} />
                <Num label="Startwert" value={settings.seed} min={1} max={4294967295} step={1} whole onChange={(v) => patch({ seed: v })} />
              </div>
              <label className="bp5-control bp5-checkbox">
                <input type="checkbox" checked={settings.refine} onChange={(e) => patch({ refine: e.target.checked })} />
                <span className="bp5-control-indicator" />Verfeinern auf halbem Raster (letzte 30 % des Budgets)
              </label>
              <p className="fn-hint">Das Budget zählt Schritte, nie Zeit: gleiche Angaben und gleicher Startwert geben dieselbe Lage. Nach {LIMITS.hardSeconds} s endet ein Lauf von selbst mit dem besten Stand.</p>
            </details>
          </section>

          <section className="fn-sec" aria-labelledby="fn-h-parts">
            <h2 id="fn-h-parts">Teile <span style={{ textTransform: "none", letterSpacing: 0 }} data-testid="part-sum">
              {plural(t.instances, "Teil", "Teile")} · {plural(t.types, "Art", "Arten")}</span></h2>
            {settings.parts.length === 0 ? <p className="fn-hint">Noch keine Teile. Aus der Bibliothek wählen, Punkte einfügen oder eine Datei importieren.</p> : (
              <>
                <div className="fn-part-head" aria-hidden="true"><span /><span>Teil</span><span>Abstand</span><span>Menge</span><span /></div>
                <ul className="fn-parts" aria-label="Gewählte Teile">
                  {settings.parts.map((p) => {
                    const d = lib.get(p.id);
                    return (
                      <li key={p.id} className="fn-part" data-testid="part-row">
                        {d ? <DrawingThumb preview={d.preview} width={d.width} height={d.height} size={40} /> : <span />}
                        <span className="fn-name" title={d ? `${num(d.width, 1)} × ${num(d.height, 1)} mm` : ""}>{d ? d.name : `Zeichnung ${p.id}`}</span>
                        <input type="number" className="bp5-input" min={0} max={200} step={0.5} placeholder={String(settings.spacing)}
                               aria-label={`Eigener Abstand für ${d?.name ?? p.id} in Millimetern`} value={p.gap ?? ""}
                               onChange={(e) => setPart(p.id, { gap: e.target.value === "" ? null : Number(e.target.value) })} />
                        <input type="number" className="bp5-input" min={0} max={LIMITS.instances} step={1} aria-label={`Menge von ${d?.name ?? p.id}`}
                               value={p.qty} onChange={(e) => setPart(p.id, { qty: Math.max(0, Math.min(LIMITS.instances, Math.floor(Number(e.target.value) || 0))) })} />
                        <Button minimal icon="cross" aria-label={`${d?.name ?? p.id} entfernen`} onClick={() => patch({ parts: settings.parts.filter((x) => x.id !== p.id) })} />
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <div className="fn-adders">
              <select value={pick} aria-label="Zeichnung aus der Bibliothek" onChange={(e) => setPick(e.target.value)} disabled={!libReady || free.length === 0}>
                <option value="">{free.length ? "Aus der Bibliothek …" : libReady ? (lib.size === 0 ? "Bibliothek noch leer" : "Alle gewählt") : "Lädt …"}</option>
                {free.map((d) => <option key={d.id} value={d.id}>{d.name} · {num(d.width)} × {num(d.height)}</option>)}
              </select>
              <Button text="Hinzufügen" disabled={!pick} onClick={() => { patch(addPart(settings, Number(pick))); setPick(""); }} />
              <Button text="Punkte einfügen" icon="polygon-filter" onClick={() => setPaste(true)} />
              <Button text="Importieren" icon="upload" onClick={() => fileInput.current?.click()} />
              <input ref={fileInput} className="fn-file" type="file" multiple accept=".dxf,.svg,image/svg+xml"
                     aria-label="DXF- oder SVG-Dateien importieren" data-testid="import-file" onChange={(e) => onFiles(e.target.files)} />
            </div>
            {libTotal > lib.size && <p className="fn-hint">Die Liste zeigt die zuletzt geänderten {lib.size} von {libTotal} Zeichnungen. <a href="#/zeichnungen">Zur Bibliothek</a></p>}
            {report && (
              <div role="status" className="fn-hint" data-testid="import-report">
                {plural(report.created.length, "Zeichnung", "Zeichnungen")} übernommen.
                {[...report.notes, ...report.skipped].map((s, i) => <div key={i}>{s}</div>)}
              </div>
            )}
          </section>

          <div className="fn-run">
            {stale && (
              <div className="fn-stale" role="status" data-testid="stale">
                <Icon icon="warning-sign" aria-hidden="true" />
                <span>Veraltet: Die Einstellungen wurden nach dem letzten Lauf geändert. Das Ergebnis rechts gehört zu den alten Angaben.</span>
              </div>
            )}
            {problems.length > 0 && <ul className="fn-hint" style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            {error && <p role="alert" className="fn-error" style={{ margin: 0 }}>{error}</p>}
            {active ? (
              <Button intent="danger" icon="stop" text="Anhalten" onClick={stop} data-testid="stop" />
            ) : (
              <Button intent="primary" icon="play" text={run ? "Neu schachteln" : "Schachteln starten"} loading={starting}
                      disabled={problems.length > 0} onClick={start} data-testid="start" />
            )}
          </div>
        </aside>

        <section className="fn-stage" aria-label="Ergebnis" aria-busy={active}>
          <div className="fn-label">
            <Tag intent="warning" icon="info-sign" large>Freies Schachteln – kein Fertigungsauftrag</Tag>
            {run && <span data-testid="run-status" data-status={run.status}>{STATUS_TEXT[run.status]}{stale ? " · veraltet" : ""}</span>}
            {active && <Spinner size={16} />}
          </div>
          {!run ? (
            <Callout icon="grid-view" title="Noch kein Lauf">
              Teile wählen, Einstellungen prüfen und „Schachteln starten“ drücken. <a href="#/zeichnungen" onClick={(e) => { e.preventDefault(); navigate("zeichnungen"); }}>Zur Zeichnungsbibliothek</a>
            </Callout>
          ) : <Result run={run} stale={stale} />}
        </section>
      </div>
      <PastePointsDialog isOpen={paste} onClose={() => setPaste(false)} onCreated={adopt} />
    </div>
  );
}

function Num({ label, value, min, max, step, whole, disabled, onChange }: {
  label: string; value: number; min: number; max: number; step: number; whole?: boolean; disabled?: boolean; onChange: (v: number) => void;
}) {
  return (
    <label className="fn-field">{label}
      <input className="bp5-input" type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ""} disabled={disabled}
             onChange={(e) => {
               const v = Number(e.target.value);
               if (e.target.value === "" || !Number.isFinite(v)) return;
               onChange(Math.min(max, Math.max(min, whole ? Math.round(v) : v)));
             }} />
    </label>
  );
}

function Result({ run, stale }: { run: RunView; stale: boolean }) {
  const layout = run.layout;
  const [sheetPick, setSheetPick] = useState(1);
  const [downloadError, setDownloadError] = useState("");
  const dl = async (format: "dxf" | "svg" | "json") => {
    setDownloadError("");
    try {
      const name = `freies-schachteln.${format}`;
      await apiDownload(`/api/free-nesting/runs/${run.id}/export?format=${format}&sheet=${sheetPick}`, name);
    } catch (e) { setDownloadError(e instanceof Error ? e.message : String(e)); }
  };
  const n = layout ? Math.max(1, layout.stats.sheetsUsed) : 1;
  const v = run.verify;
  const pill = run.status === "failed" ? { cls: "bad", icon: "error", text: `Fehlgeschlagen: ${run.error}` }
    : run.status === "checking" ? { cls: "wait", icon: "time", text: "Lage wird exakt geprüft …" }
    : v ? (v.valid ? { cls: "ok", icon: "tick-circle", text: `Geprüft: alle Abstände eingehalten${v.minGap !== null ? ` (kleinster ${num(v.minGap, 1)} mm)` : ""}` }
        : { cls: "bad", icon: "error", text: `${plural(v.issues.length, "Prüffehler", "Prüffehler")}: nicht zum Export freigegeben` })
    : { cls: "wait", icon: "time", text: layout ? "Beste Lage bisher, noch ungeprüft" : "Warte auf die erste Lage" };
  return (
    <>
      {layout && <Stats layout={layout} run={run} stale={stale} />}
      <div className="fn-status">
        <span className={`fn-pill fn-pill-${pill.cls}`} role="status" data-testid="verify" data-valid={v ? String(v.valid) : ""}>
          <Icon icon={pill.icon as "tick-circle"} aria-hidden="true" />{pill.text}</span>
        {!run.reproducible && !isActive(run.status) && run.status !== "failed" && (
          <span className="fn-sub">Vorzeitig beendet: dieser Stand lässt sich nicht genauso wiederholen.</span>)}
        <span style={{ flex: 1 }} />
        <div className="fn-export" role="group" aria-label="Ausgabe">
          <label className="fn-sub" htmlFor="fn-sheet-pick">Platte</label>
          <select id="fn-sheet-pick" value={sheetPick} onChange={(e) => setSheetPick(Number(e.target.value))} disabled={!run.exportable}>
            {Array.from({ length: n }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </select>
          <Button small icon="download" text="DXF" disabled={!run.exportable} onClick={() => dl("dxf")} data-testid="export-dxf" />
          <Button small icon="download" text="SVG" disabled={!run.exportable} onClick={() => dl("svg")} />
          <Button small icon="download" text="JSON" disabled={!run.exportable} onClick={() => dl("json")} />
        </div>
      </div>
      {!run.exportable && v && !v.valid && (
        <Callout intent="danger" icon="error" title="Diese Lage wird nicht ausgegeben">
          <ul className="fn-issues">{v.issues.slice(0, 8).map((s, i) => <li key={i}>{s}</li>)}</ul>
        </Callout>)}
      {downloadError && <p role="alert" className="fn-error">{downloadError}</p>}
      {layout && layout.unplaced.length > 0 && (
        <Callout intent="warning" icon="warning-sign" title={`${plural(layout.unplaced.length, "Teil", "Teile")} nicht untergebracht`}>
          {layout.stats.stockLimited ? "Das Lager an Platten reicht nicht." : "Diese Teile sind größer als die nutzbare Platte."}
        </Callout>)}
      {layout && run.parts && <Sheets layout={layout} parts={run.parts} job={run.job} />}
    </>
  );
}

function Stats({ layout, run, stale }: { layout: Layout; run: RunView; stale: boolean }) {
  const s = layout.stats;
  const w = run.job.sheet.width, h = run.job.sheet.height;
  const along = run.job.gravity === "left" ? w : h, other = run.job.gravity === "left" ? h : w;
  const frac = run.status === "done" || run.status === "stopped" || run.status === "timeout" ? 1 : s.maxSteps ? Math.min(1, s.iterations / s.maxSteps) : 0;
  const why: Record<string, string> = { steps: "Schrittgrenze erreicht", stall: "kein weiterer Gewinn", done: "fertig", single: "ein einzelnes Teil" };
  return (
    <div className="fn-band" data-stale={stale ? "true" : "false"}>
      <KpiStrip label="Kennzahlen" className="fn-kpis" items={[
        { id: "util", label: "Auslastung", value: pct(s.utilizationUsed), testId: "util", hero: true, primary: true,
          sub: s.sheetsUsed > 1 ? `der benutzten Länge · ${pct(s.utilizationSheets)} aller Platten` : "der benutzten Plattenlänge" },
        { id: "sheets", label: "Platten", value: s.maxSheets ? `${s.sheetsUsed} / ${s.maxSheets}` : s.sheetsUsed, testId: "sheets", primary: true,
          sub: `${num(w)} × ${num(h)} mm${s.stockLimited ? " · Lager aufgebraucht" : ""}` },
        { id: "placed", label: "Teile platziert", value: `${s.placed} / ${s.total}`, testId: "placed", primary: true,
          sub: `${(s.placedArea / 1e6).toLocaleString("de-DE", { maximumFractionDigits: 2 })} m² Teilefläche` },
        { id: "rest", label: "Restplatte", value: `${num(s.remnantLength)} mm`,
          sub: `× ${num(other)} mm (Länge ${num(along)} mm)` },
        { id: "steps", label: "Schritte", value: s.maxSteps ? `${num(s.iterations)} / ${num(s.maxSteps)}` : num(s.iterations), testId: "steps", primary: true,
          sub: <>
            <span className="fn-meter" aria-hidden="true"><i style={{ width: `${(frac * 100).toFixed(0)}%` }} /></span>
            {s.stopReason ? (why[s.stopReason] ?? s.stopReason) : s.phase === "refine" ? "verfeinert" : "grobes Raster"} · {(s.elapsedMs / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} s
          </> },
      ]} />
    </div>
  );
}

function Sheets({ layout, parts, job }: { layout: Layout; parts: RunPart[]; job: RunView["job"] }) {
  const W = job.sheet.width, H = job.sheet.height;
  const n = Math.max(1, layout.stats.sheetsUsed);
  const bySheet = useMemo(() => {
    const out: number[][] = Array.from({ length: n }, () => []);
    layout.placements.forEach((p, i) => { out[p.sheet]?.push(i); });
    return out;
  }, [layout, n]);
  const paths = useMemo(() => layout.placements.map((pl) => placedPath(parts[pl.partIndex], pl)), [layout, parts]);
  const [hot, setHot] = useState<number | null>(null);
  const hotP = hot !== null ? layout.placements[hot] : null;
  const readout = hotP ? `${parts[hotP.partIndex].name} · Nr. ${hotP.instance + 1} · Platte ${hotP.sheet + 1} · Drehung ${num(hotP.rotation)}° · ${num(hotP.width, 1)} × ${num(hotP.height, 1)} mm · Ecke ${num(hotP.x, 1)} / ${num(hotP.y, 1)} mm` : "";
  const along = job.gravity === "left" ? W : H;
  const key = (e: ReactKeyboardEvent, sheet: number) => {
    const list = bySheet[sheet];
    if (!list.length) return;
    const at = hot !== null ? list.indexOf(hot) : -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setHot(list[(at + 1) % list.length]); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setHot(list[(at <= 0 ? list.length : at) - 1]); }
    else if (e.key === "Escape") setHot(null);
  };
  return (
    <div>
      <div className="fn-readout" aria-live="polite" data-testid="readout">{readout || "Mit der Maus über ein Teil fahren oder in der Zeichnung mit den Pfeiltasten wählen."}</div>
      <div className="fn-sheets">
        {bySheet.map((list, si) => {
          const info = layout.sheets[si];
          const last = si === n - 1;
          return (
            <figure key={si} style={{ margin: 0 }}>
              <figcaption className="fn-sheet-head"><b>Platte {si + 1} / {n}</b>
                <span>{num(W)} × {num(H)} mm · {plural(info?.parts ?? list.length, "Teil", "Teile")} · {pct(info?.utilization ?? 0)} der Platte</span></figcaption>
              <svg className="fn-svg" viewBox={`-10 -10 ${W + 20} ${H + 20}`} role="group" tabIndex={0} data-testid={`sheet-${si}`}
                   aria-label={`Platte ${si + 1} von ${n}, ${list.length} Teile. Pfeiltasten wählen ein Teil.`}
                   onKeyDown={(e) => key(e, si)} onPointerLeave={() => setHot(null)}>
                <rect className="sheet" x={0} y={0} width={W} height={H} />
                {job.margin > 0 && <rect className="margin" x={job.margin} y={job.margin} width={W - 2 * job.margin} height={H - 2 * job.margin} />}
                {last && info && info.usedLength < along - 1 && (
                  job.gravity === "left"
                    ? <><line className="remnant" x1={info.usedLength} x2={info.usedLength} y1={0} y2={H} />
                        {W - info.usedLength > 220 && <text className="remnant-label" x={info.usedLength + (W - info.usedLength) / 2} y={H / 2} textAnchor="middle" fontSize={Math.max(14, W / 60)}>Rest {num(W - info.usedLength)} mm</text>}</>
                    : <><line className="remnant" x1={0} x2={W} y1={info.usedLength} y2={info.usedLength} />
                        {H - info.usedLength > 120 && <text className="remnant-label" x={W / 2} y={info.usedLength + (H - info.usedLength) / 2} textAnchor="middle" fontSize={Math.max(14, W / 60)}>Rest {num(H - info.usedLength)} mm</text>}</>
                )}
                {list.map((i) => (
                  <path key={i} className={`p${hot === i ? " hot" : ""}`} d={paths[i]}
                        style={{ ["--tint" as string]: `${12 + (layout.placements[i].partIndex % 5) * 9}%` }}
                        onPointerEnter={() => setHot(i)} />
                ))}
              </svg>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
