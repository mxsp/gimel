import { Alert, Button, ButtonGroup, HTMLTable, Menu, MenuItem, Tag } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import { RefLink } from "../components/RefLink";
import { More, PageInfo, pageInfo } from "../ui";
import { useMaterialName } from "../components/MaterialSelect";
import { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api, fmtDateTime } from "../api";
import Callout from "../components/Callout";
import NonIdealState from "../components/NonIdealState";
import PlanOptions from "../components/PlanOptions";
import { EmptyNote, SectionError, SectionLoading } from "../components/PageStates";
import { EDITOR_START, Edit, Fault, Layout, LayoutPart, LayoutPlate, clampIndex, editorReducer, faultTags, faults, fillOf, firstFree, layoutBody, num, pathOf, usable } from "../nesting";
import { navigate } from "../router";
import { plural } from "../plural";
import { toastError, toastSuccess } from "../toast";
import NestingModeBar from "../components/NestingModeBar";

/* Schachteln — die Platte zum Anfassen.

   Teile ziehen, drehen, in die Ablage legen und auf eine andere Platte setzen; der
   Rechenkern macht auf Knopfdruck einen Vorschlag, und der lässt sich weiter
   bearbeiten. Was gespeichert wird, schneidet die Maschine. Deshalb zeigt der Editor
   Fehler sofort, und der Server prüft die Lage vor dem Speichern noch einmal genau.
   Spiegeln gibt es hier nicht: ein gespiegeltes Teil ist ein anderes Teil. */

interface OpenOrder { no: string; mat: string; thk: number; n_plates: number; n_parts: number; utilisation: number; status: string }
interface ServerCheck { valid: boolean; issues: string[] }
interface View { x: number; y: number; w: number; h: number }
type Gesture = { kind: "pan"; px: number; py: number; vb: View } | { kind: "pinch"; dist: number; x: number; y: number; vb: View };
type FocusTarget = { part?: string; tray?: string; plate?: boolean };

const pct = (v: number) => `${Math.round(v * 100)} %`;
const SNAP = 5;
const MAX_ZOOM = 8;
const MIN_TAG_PX = 9;
const SELECTED_TAG_PX = 13;

export default function Nesting({ no, role }: { no: string; role: string }) {
  const canEdit = role === "admin";
  return no ? <Editor key={no} no={decodeURIComponent(no)} canEdit={canEdit} /> : <Picker canEdit={canEdit} />;
}

function Picker({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<OpenOrder[] | null>(null);
  const matName = useMaterialName();
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<OpenOrder[]>("/api/production/work-orders?status=open&limit=200")
      .then((r) => { setRows(r); setError(""); }).catch((e) => setError(e.message ?? String(e)));
  }, []);
  useEffect(load, [load]);
  if (error && !rows) return <SectionError message={error} onRetry={load} />;
  if (!rows) return <SectionLoading />;
  return (
    <div>
      <NestingModeBar active="schachteln" />
      <div className="ui-page-title-row"><h1 className="page-title">Schachteln</h1><PageInfo text={pageInfo("schachteln")} /></div>
      <p className="page-sub">Offene Innenaufträge. Wählen Sie einen aus, um seine Platten von Hand zu belegen.</p>
      {/* Erst die Arbeit, dann die Stellschrauben: in „Einfach" stehen die Optionen hinter einem Knopf. */}
      {rows.length === 0 ? <NonIdealState icon="grid-view" title="Kein offener Innenauftrag" description="Der nächste Sammellauf legt neue an." /> : (
        <div className="dispo-table">
          <HTMLTable className="data-table" striped compact interactive aria-label="Offene Innenaufträge">
            <thead><tr><th>Innenauftrag</th><th>Werkstoff</th><th className="num">Dicke</th><th className="num">Platten</th><th className="num">Teile</th><th className="num">Belegung</th></tr></thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.no} onClick={() => navigate(`schachteln/${encodeURIComponent(w.no)}`)}>
                  <td className="mono nw"><button type="button" className="row-toggle" onClick={(e) => { e.stopPropagation(); navigate(`schachteln/${encodeURIComponent(w.no)}`); }}><b>{w.no}</b></button></td>
                  <td title={w.mat}>{matName(w.mat)}</td><td className="num">{num(w.thk)} mm</td><td className="num">{w.n_plates}</td>
                  <td className="num">{w.n_parts}</td><td className="num">{pct(w.utilisation)}</td>
                </tr>
              ))}
            </tbody>
          </HTMLTable>
        </div>
      )}
      <More label="Schachtel-Optionen anzeigen" less="Schachtel-Optionen ausblenden" className="nest-options-more">
        <PlanOptions scope="all" canEdit={canEdit} />
      </More>
    </div>
  );
}

function Editor({ no, canEdit }: { no: string; canEdit: boolean }) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [state, dispatch] = useReducer(editorReducer, EDITOR_START);
  const { edit, past, future, dirty } = state;
  const [plateWanted, setPlate] = useState(0);
  const [selected, setSelected] = useState("");
  const [carryingWanted, setCarrying] = useState("");
  const [snap, setSnap] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [server, setServer] = useState<ServerCheck | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);
  const [leaving, setLeaving] = useState("");
  const [focusTo, setFocusTo] = useState<FocusTarget | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const leaveOk = useRef(false);

  // Rückgängig und Vorschlag dürfen Platten und Ablage ändern: was gezeigt wird,
  // leitet sich aus dem Stand ab und kann nie ins Leere zeigen.
  const plate = clampIndex(plateWanted, edit?.plates.length ?? 0);
  const carrying = edit?.tray.some((p) => p.tag === carryingWanted) ? carryingWanted : "";

  const adopt = useCallback((l: Layout) => {
    setLayout(l); dispatch({ type: "adopt", plates: l.plates });
    setServer(null); setPlate(0); setSelected(""); setCarrying("");
  }, []);
  const load = useCallback(() => {
    api<Layout>(`/api/production/work-orders/${encodeURIComponent(no)}/layout`)
      .then((l) => { adopt(l); setError(""); }).catch((e) => setError(e.message ?? String(e)));
  }, [no, adopt]);
  useEffect(load, [load]);

  /** Jede Änderung ist ein Schritt für Rückgängig. */
  const change = useCallback((fn: (e: Edit) => void) => { dispatch({ type: "change", fn }); setServer(null); }, []);
  const undo = useCallback(() => { dispatch({ type: "undo" }); setServer(null); }, []);
  const redo = useCallback(() => { dispatch({ type: "redo" }); setServer(null); }, []);

  const current = edit?.plates[plate];
  const part = current?.placements.find((p) => p.tag === selected);
  const locked = !!layout?.blocked;

  const rotate = useCallback(() => {
    if (!layout || !part || locked) return;
    const list = layout.rotations;
    const at = list.indexOf(part.rot);
    const rot = list[(at + 1) % list.length];
    if (rot === part.rot) return;
    change((e) => { const p = e.plates[plate].placements.find((i) => i.tag === selected); if (p) p.rot = rot; });
  }, [layout, part, locked, change, plate, selected]);

  /* Von der Tastatur geht der Fokus zum nächsten Teil, damit es weitergehen kann.
     Vom Knopf aus nicht: ein zweiter Tipp nähme sonst gleich das nächste Teil mit. */
  const toTray = useCallback((viaKey = false) => {
    if (!part || locked || !current) return;
    const list = current.placements;
    const at = list.findIndex((p) => p.tag === selected);
    const next = list[at + 1] ?? list[at - 1];
    change((e) => {
      const here = e.plates[plate].placements;
      const i = here.findIndex((p) => p.tag === selected);
      if (i >= 0) e.tray.push(...here.splice(i, 1));
    });
    setSelected("");
    setFocusTo(viaKey && next ? { part: next.tag } : { tray: selected });
  }, [part, locked, current, change, plate, selected]);

  const nudge = useCallback((dx: number, dy: number) => {
    if (!part || locked) return;
    change((e) => { const p = e.plates[plate].placements.find((i) => i.tag === selected); if (p) { p.cx += dx; p.cy += dy; } });
  }, [part, locked, change, plate, selected]);

  // Der Fokus folgt erst, wenn das Ziel gezeichnet ist.
  useEffect(() => {
    if (!focusTo) return;
    const at = focusTo.part != null ? `[data-tag="${CSS.escape(focusTo.part)}"]`
      : focusTo.tray != null ? `[data-tray-tag="${CSS.escape(focusTo.tray)}"]` : ".nest-canvas > svg";
    root.current?.querySelector<HTMLElement>(at)?.focus();
    setFocusTo(null);
  }, [focusTo]);

  // Rückgängig gilt im ganzen Editor; die Tasten fürs Teil nur auf der Platte.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement).matches("input, select, textarea") || confirmSave || leaving) return;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, confirmSave, leaving]);

  const onPlateKey = (ev: ReactKeyboardEvent) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tag = (ev.target as Element).closest?.(".nest-part")?.getAttribute("data-tag");
    const step = ev.shiftKey ? 10 : 1;
    if (ev.key === "r" || ev.key === "R") rotate();
    else if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); toTray(true); }
    else if ((ev.key === "Enter" || ev.key === " ") && tag) { ev.preventDefault(); setSelected(tag); }
    else if (ev.key.startsWith("Arrow") && part) {
      ev.preventDefault();
      nudge(ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0,
            ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0);
    }
  };

  /* Esc legt das Getragene zurück und lässt den Fokus am Listeneintrag; auf der
     Platte gibt es das Teil frei, und der Fokus bleibt auf der Platte. */
  const onEscape = (ev: ReactKeyboardEvent) => {
    if (ev.key !== "Escape") return;
    if (carrying) { setCarrying(""); setFocusTo({ tray: carrying }); return; }
    if (!selected) return;
    const onPlate = !!(ev.target as Element).closest?.(".nest-canvas > svg");
    setSelected("");
    if (onPlate) setFocusTo({ plate: true });
  };

  // Wer ungespeicherte Arbeit hat, wird vor dem Schließen gefragt.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /* Dasselbe beim Wechsel innerhalb der App. useHashRoute hängt zuerst an hashchange,
     und am window zählt die Reihenfolge des Anmeldens, nicht die Capture-Phase. Aber
     popstate kommt vor hashchange und useHashRoute liest die Adresse erst dort: wird
     sie hier zurückgestellt, ändert sich die Route gar nicht erst, und die Antwort
     im Dialog entscheidet. */
  useEffect(() => {
    if (!dirty) return;
    const home = window.location.href;
    const guard = () => {
      if (leaveOk.current || window.location.href === home) return;
      const target = window.location.hash || "#/";
      window.history.replaceState(window.history.state, "", home);
      setLeaving(target);
    };
    window.addEventListener("popstate", guard);
    return () => window.removeEventListener("popstate", guard);
  }, [dirty]);

  const leave = () => {
    leaveOk.current = true;
    window.location.hash = leaving;
    setLeaving("");
  };

  const faultsNow = useMemo(() => (layout && edit ? edit.plates.map((p) => faults(layout, p)) : []), [layout, edit]);
  const allFaults: (Fault & { plate: number })[] = faultsNow.flatMap((list, i) => list.map((f) => ({ ...f, plate: i })));

  const put = (tag: string, x: number, y: number) => {
    change((e) => {
      const i = e.tray.findIndex((p) => p.tag === tag);
      if (i < 0) return;
      const [p] = e.tray.splice(i, 1);
      p.cx = x; p.cy = y;
      e.plates[plate].placements.push(p);
    });
    setSelected(tag); setCarrying(""); setFocusTo({ part: tag });
  };
  const place = (x: number, y: number) => {
    if (!carrying) return;
    const round = (v: number) => (snap ? Math.round(v / SNAP) * SNAP : Math.round(v * 10) / 10);
    put(carrying, round(x), round(y));
  };
  /** Enter auf dem gewählten Ablage-Teil: ohne Zeiger auf den ersten freien Platz. */
  const placeFree = (p: LayoutPart) => {
    if (!layout || !current || locked) return;
    const [x, y] = firstFree(layout, current, p);
    put(p.tag, x, y);
  };

  const addPlate = () => {
    const fmt = current?.fmt ?? layout?.formats[0];
    if (!fmt) return;
    change((e) => { e.plates.push({ fmt, turned: false, placements: [] }); });
    setPlate(edit?.plates.length ?? 0);
  };
  const dropPlate = () => {
    change((e) => { e.plates.splice(plate, 1); });
    setPlate(Math.max(0, plate - 1));
  };
  const showPlate = (i: number) => { setPlate(i); setSelected(""); };
  const onTabKey = (ev: ReactKeyboardEvent, i: number) => {
    const n = edit?.plates.length ?? 0;
    const to = ev.key === "ArrowRight" ? (i + 1) % n : ev.key === "ArrowLeft" ? (i - 1 + n) % n
      : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    ev.preventDefault();
    showPlate(to);
    document.getElementById(`nest-tab-${to}`)?.focus();
  };

  const body = () => (edit ? layoutBody(edit.plates.filter((p) => p.placements.length)) : []);
  const url = `/api/production/work-orders/${encodeURIComponent(no)}/layout`;

  const auto = async () => {
    setBusy("auto");
    try {
      const r = await api<{ plates: { fmt: [number, number]; turned: boolean; placements: { tag: string; cx: number; cy: number; rot: number }[] }[] }>(`${url}/auto`, { method: "POST" });
      change((e) => {
        const parts = new Map([...e.plates.flatMap((p) => p.placements), ...e.tray].map((p) => [p.tag, p]));
        e.plates = r.plates.map((p) => ({ fmt: p.fmt, turned: p.turned,
          placements: p.placements.flatMap((i) => { const known = parts.get(i.tag); parts.delete(i.tag); return known ? [{ ...known, ...i }] : []; }) }));
        // Was der Vorschlag nicht unterbringt, geht nicht verloren.
        e.tray = [...parts.values()];
      });
      setPlate(0); setSelected("");
      toastSuccess(`Vorschlag: ${plural(r.plates.length, "Platte", "Platten")}. Noch nicht gespeichert.`);
    } catch (e: any) { toastError(e.message); } finally { setBusy(""); }
  };

  const check = async () => {
    setBusy("check");
    try { setServer(await api<ServerCheck>(`${url}/check`, { method: "POST", body: JSON.stringify({ plates: body() }) })); }
    catch (e: any) { setServer({ valid: false, issues: [e.message] }); } finally { setBusy(""); }
  };

  const save = async () => {
    if (!layout) return;
    const issued = !!layout.files_issued_at;
    setConfirmSave(false);
    setBusy("save");
    try {
      const l = await api<Layout>(url, { method: "PUT", body: JSON.stringify({ version: layout.version, plates: body() }) });
      adopt(l);
      toastSuccess(issued ? "Belegung gespeichert. Die schon ausgegebene Schnittdatei ändert sich dadurch nicht." : "Belegung gespeichert. Zeichnung und Schnittdatei folgen ihr.");
    } catch (e: any) { toastError(e.message); setServer({ valid: false, issues: [e.message] }); } finally { setBusy(""); }
  };

  const reset = async () => {
    if (!layout || !window.confirm("Handarbeit verwerfen und zur Lage des Rechenkerns zurückkehren?")) return;
    setBusy("reset");
    try { adopt(await api<Layout>(`${url}/reset`, { method: "POST", body: JSON.stringify({ version: layout.version }) })); toastSuccess("Automatische Lage wiederhergestellt."); }
    catch (e: any) { toastError(e.message); } finally { setBusy(""); }
  };

  if (error && !layout) return <SectionError message={error} onRetry={load} />;
  if (!layout || !edit) return <SectionLoading />;
  if (!current) {
    return (
      <div className="nest">
        <button type="button" className="row-toggle sub" onClick={() => navigate("schachteln")}>Alle Innenaufträge</button>
        <div className="ui-page-title-row"><h1 className="page-title">{layout.no}</h1><PageInfo text={pageInfo("schachteln")} /></div>
        <NonIdealState icon="grid-view" title="Keine Platte in dieser Belegung"
          description={layout.formats.length ? "Legen Sie eine Platte an oder rechnen Sie einen Vorschlag." : "Für diesen Innenauftrag ist kein Plattenformat bekannt."}
          action={<div className="nest-actions">
            <Button text="Platte anlegen" icon="add" disabled={locked || !layout.formats.length} onClick={addPlate} />
            <Button text="Vorschlag rechnen" icon="predictive-analysis" disabled={locked || !!busy} loading={busy === "auto"} onClick={auto} />
          </div>} />
      </div>
    );
  }

  const canSave = dirty && !locked && !edit.tray.length && !allFaults.length;
  const emptyPlates = edit.plates.filter((p) => !p.placements.length).length;
  const why = locked ? layout.blocked : edit.tray.length ? `${plural(edit.tray.length, "Teil liegt", "Teile liegen")} noch in der Ablage.`
    : allFaults.length ? `${plural(allFaults.length, "Fehler", "Fehler")} auf den Platten.` : "";
  const padStep = snap ? SNAP : 1;
  const noPart = !part || locked;

  return (
    <>
    <div className="nest" ref={root} onKeyDown={onEscape}>
      <div className="nest-head">
        <div>
          <button type="button" className="row-toggle sub" onClick={() => navigate("schachteln")}>Alle Innenaufträge</button>
          <div className="ui-page-title-row"><h1 className="page-title">{layout.no}</h1><PageInfo text={pageInfo("schachteln")} /></div>
          <p className="page-sub">
            {layout.mat_name} · {num(layout.thk)} mm · Abstand {num(layout.gap)} mm · Rand {num(layout.margin)} mm
            {layout.corner_max ? ` · Eckschranke ${num(layout.corner_max)} mm` : ""}
            {layout.edited_at && ` · von Hand geändert ${fmtDateTime(layout.edited_at)}, ${layout.edited_by}`}
          </p>
        </div>
        <div className="nest-actions">
          {layout.has_auto && <Button text="Zur Automatik" icon="history" disabled={locked} loading={busy === "reset"} onClick={reset} />}
          <Button text="Vorschlag rechnen" icon="predictive-analysis" disabled={locked || !!busy} loading={busy === "auto"} onClick={auto} />
          <Button text="Prüfen" icon="tick-circle" disabled={!!edit.tray.length || !!busy} loading={busy === "check"} onClick={check} />
          <Button intent="primary" text="Speichern" icon="floppy-disk" disabled={!canSave || !!busy} loading={busy === "save"}
                  onClick={() => (layout.files_issued_at ? setConfirmSave(true) : save())} />
        </div>
      </div>

      <PlanOptions scope="nesting" canEdit={canEdit} />

      {locked && <Callout intent="warning" icon="lock" className="nest-note">{layout.blocked}</Callout>}
      {layout.files_issued_at && (
        <Callout intent="warning" icon="warning-sign" className="nest-note" title="Schnittdateien sind schon ausgegeben">
          Ausgegeben {fmtDateTime(layout.files_issued_at)}. Eine gespeicherte Änderung erreicht keine Datei, die schon an der Maschine
          liegt, und auch keine schon versendete Fertigungsmeldung. Holen Sie die Datei nach dem Speichern neu.
        </Callout>
      )}
      <div role="status">
        {server?.valid && <Callout intent="success" icon="tick-circle" className="nest-note">Genaue Prüfung bestanden.</Callout>}
        {server && !server.valid && (
          <Callout intent="danger" icon="error" className="nest-note">
            <b>Nicht gültig</b>{server.issues.slice(0, 6).map((t, i) => <div key={i}>{t}</div>)}
          </Callout>
        )}
      </div>

      <div className="nest-tabbar">
        <div className="nest-tabs" role="tablist" aria-label="Platten">
          {edit.plates.map((p, i) => (
            <button key={i} id={`nest-tab-${i}`} type="button" role="tab" aria-selected={i === plate} aria-controls="nest-panel" tabIndex={i === plate ? 0 : -1}
                    className="nest-tab" data-bad={faultsNow[i].length > 0} onClick={() => showPlate(i)} onKeyDown={(ev) => onTabKey(ev, i)}>
              <b>Platte {i + 1}</b>
              <span className="sub">{num(p.fmt[0])} × {num(p.fmt[1])} · {pct(fillOf(layout, p))} · {plural(p.placements.length, "Teil", "Teile")}</span>
              {faultsNow[i].length > 0 && <Tag minimal intent="danger">{plural(faultsNow[i].length, "Fehler", "Fehler")}</Tag>}
            </button>
          ))}
        </div>
        <Button minimal icon="add" text="Platte" disabled={locked} onClick={addPlate} />
      </div>

      <div className="nest-work" id="nest-panel" role="tabpanel" aria-labelledby={`nest-tab-${plate}`}>
        <div className="nest-left">
          <div className="nest-tools" role="toolbar" aria-label="Teil bearbeiten">
            <ButtonGroup>
              <Button icon="undo" text="Rückgängig" aria-label="Rückgängig" disabled={!past.length} onClick={undo} />
              <Button icon="redo" text="Wiederholen" aria-label="Wiederholen" disabled={!future.length} onClick={redo} />
              <Button icon="refresh" text="Drehen" aria-label="Drehen" disabled={noPart || layout.rotations.length < 2} onClick={rotate} />
              <Button icon="inbox" text="Ablage" aria-label="In die Ablage" disabled={noPart} onClick={() => toTray()} />
            </ButtonGroup>
            <KeyPopover placement="bottom-start" content={
              <Menu>
                <MenuItem icon="arrow-left" text={`${padStep} mm nach links`} disabled={noPart} shouldDismissPopover={false} onClick={() => nudge(-padStep, 0)} />
                <MenuItem icon="arrow-up" text={`${padStep} mm nach oben`} disabled={noPart} shouldDismissPopover={false} onClick={() => nudge(0, -padStep)} />
                <MenuItem icon="arrow-down" text={`${padStep} mm nach unten`} disabled={noPart} shouldDismissPopover={false} onClick={() => nudge(0, padStep)} />
                <MenuItem icon="arrow-right" text={`${padStep} mm nach rechts`} disabled={noPart} shouldDismissPopover={false} onClick={() => nudge(padStep, 0)} />
                <MenuItem icon="grid" text={`Am Raster ${SNAP} mm einrasten`} active={snap} shouldDismissPopover={false}
                  onClick={() => setSnap((v) => !v)} />
              </Menu>
            }>
              <Button icon="move" text="Ausrichten" title="Teil in Millimetern verschieben oder am Raster einrasten" />
            </KeyPopover>
          </div>

          <PlateCanvas key={plate} layout={layout} plate={current} selected={selected} bad={faultTags(faultsNow[plate] ?? [])} locked={locked}
                       carrying={carrying} snap={snap} onSelect={setSelected} onPlace={place} onKey={onPlateKey}
                       onMove={(tag, x, y) => change((e) => { const p = e.plates[plate].placements.find((i) => i.tag === tag); if (p) { p.cx = x; p.cy = y; } })} />
        </div>

        <aside className="nest-side" aria-label="Werkzeuge">
          {part ? (
            <dl className="run-facts nest-facts">
              <div><dt>Marke</dt><dd className="mono">{part.tag}</dd></div>
              <div><dt>Auftrag</dt><dd className="mono"><RefLink kind="order" no={part.order_no} /></dd></div>
              <div><dt>Teil</dt><dd>{part.label}</dd></div>
              <div><dt>Lage</dt><dd className="num-inline">{num(part.cx, 1)} / {num(part.cy, 1)} · {part.rot}°</dd></div>
            </dl>
          ) : <p className="sub">Teil anklicken oder antippen zum Bearbeiten.</p>}

          <h2>Ablage <span className="dispo-count">{edit.tray.length}</span></h2>
          {edit.tray.length === 0 ? <EmptyNote>Die Ablage ist leer.</EmptyNote> : (
            <ul className="nest-tray">
              {edit.tray.map((p) => (
                <li key={p.tag}>
                  <button type="button" className="nest-tray-item" aria-pressed={carrying === p.tag} data-tray-tag={p.tag}
                          onClick={() => setCarrying(carrying === p.tag ? "" : p.tag)}
                          onKeyDown={(ev) => { if (ev.key === "Enter" && carrying === p.tag) { ev.preventDefault(); placeFree(p); } }}>
                    <span className="mono">{p.tag}</span> <span className="sub">{p.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div role="status">
            {carrying && <p className="nest-hint">{carrying}: auf die Platte klicken oder tippen. Enter nimmt den ersten freien Platz, Esc bricht ab.</p>}
          </div>

          {!current.placements.length && edit.plates.length > 1 && <Button small icon="trash" text="Leere Platte entfernen" onClick={dropPlate} />}

          <h2>Prüfung</h2>
          <div role="status">
            {why ? <p className="dispo-error">{why}</p> : <p className="sub">{dirty ? "Keine Fehler gefunden. Beim Speichern prüft der Server genau." : "Unverändert."}</p>}
            {emptyPlates > 0 && <p className="sub">{plural(emptyPlates, "leere Platte fällt", "leere Platten fallen")} beim Speichern weg.</p>}
          </div>
          <ul className="nest-faults">
            {allFaults.slice(0, 8).map((f, i) => (
              <li key={i}><button type="button" className="row-toggle" onClick={() => { showPlate(f.plate); setSelected(f.tag); setFocusTo({ part: f.tag }); }}>Platte {f.plate + 1}: {f.text}</button></li>
            ))}
          </ul>
          {allFaults.length > 8 && <p className="sub">… und {allFaults.length - 8} weitere.</p>}
        </aside>
      </div>
    </div>

    <Alert isOpen={confirmSave} intent="warning" icon="warning-sign" cancelButtonText="Abbrechen" confirmButtonText="Trotzdem speichern"
           onCancel={() => setConfirmSave(false)} onConfirm={save}>
      <p>Die Schnittdateien sind schon ausgegeben. Diese Änderung erreicht keine Datei, die schon an der Maschine liegt, und auch keine schon versendete Fertigungsmeldung.</p>
      <p>Trotzdem speichern?</p>
    </Alert>
    <Alert isOpen={!!leaving} intent="danger" icon="warning-sign" cancelButtonText="Weiter bearbeiten" confirmButtonText="Verwerfen und verlassen"
           onCancel={() => setLeaving("")} onConfirm={leave}>
      <p>Die Änderungen an dieser Belegung sind noch nicht gespeichert. Beim Verlassen gehen sie verloren.</p>
    </Alert>
    </>
  );
}

/* Die Platte in Millimetern: Zeichenfläche und Rechnung haben dieselben Koordinaten.
   Der Ausschnitt lässt sich zoomen und schieben, die Rechnung bleibt davon unberührt. */
function PlateCanvas({ layout, plate, selected, bad, locked, carrying, snap, onSelect, onPlace, onMove, onKey }: {
  layout: Layout; plate: LayoutPlate; selected: string; bad: Set<string>; locked: boolean; carrying: string; snap: boolean;
  onSelect: (tag: string) => void; onPlace: (x: number, y: number) => void; onMove: (tag: string, x: number, y: number) => void;
  onKey: (ev: ReactKeyboardEvent) => void;
}) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ tag: string; dx: number; dy: number; x: number; y: number; moved: boolean } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [W, H] = plate.fmt;
  const pad = Math.max(W, H) * 0.02;
  const area = usable(layout, plate.fmt);
  const full = useMemo<View>(() => ({ x: -pad, y: -pad, w: W + 2 * pad, h: H + 2 * pad }), [W, H, pad]);
  const vb = view ?? full;
  // Bildpunkte je Millimeter: viewBox passt ein, also zählt die knappere Achse.
  const scale = box.w && box.h ? Math.min(box.w / vb.w, box.h / vb.h) : 0;

  const fit = useCallback((v: View): View | null => {
    const w = Math.min(full.w, Math.max(full.w / MAX_ZOOM, v.w));
    if (w >= full.w) return null;
    const h = (w * full.h) / full.w;
    return { x: Math.min(Math.max(full.x, v.x), full.x + full.w - w), y: Math.min(Math.max(full.y, v.y), full.y + full.h - h), w, h };
  }, [full]);
  const zoomAt = useCallback((f: number, mx?: number, my?: number) => {
    setView((cur) => {
      const v = cur ?? full;
      const x = mx ?? v.x + v.w / 2, y = my ?? v.y + v.h / 2;
      return fit({ x: x - (x - v.x) * f, y: y - (y - v.y) * f, w: v.w * f, h: v.h * f });
    });
  }, [full, fit]);

  const toMm = (e: { clientX: number; clientY: number }) => {
    const m = ref.current?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const round = (v: number) => (snap ? Math.round(v / SNAP) * SNAP : Math.round(v * 10) / 10);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const seen = new ResizeObserver(() => { const r = svg.getBoundingClientRect(); setBox({ w: r.width, h: r.height }); });
    seen.observe(svg);
    // Das Rad gehört der Seite; zoomen nur mit Strg (so meldet sich auch die Zwei-Finger-Geste am Trackpad).
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const at = toMm(e);
      zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, at.x, at.y);
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => { seen.disconnect(); svg.removeEventListener("wheel", wheel); };
  }, [zoomAt]);

  // Zeiger auf dem Hintergrund: Schieben, zwei Finger zoomen, ein Klick legt ab.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean }>({ x: 0, y: 0, moved: false });

  const spread = () => {
    const [a, b] = [...touches.current.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    press.current = { x: e.clientX, y: e.clientY, moved: false };
    if (e.pointerType === "touch") touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 2) {
      const s = spread();
      const at = toMm({ clientX: s.cx, clientY: s.cy });
      gesture.current = { kind: "pinch", dist: s.dist, x: at.x, y: at.y, vb };
    } else if (view && !carrying) {
      gesture.current = { kind: "pan", px: e.clientX, py: e.clientY, vb };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };
  const move = (e: ReactPointerEvent) => {
    if (Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 6) press.current.moved = true;
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag) {
      const at = toMm(e);
      setDrag({ ...drag, x: round(at.x + drag.dx), y: round(at.y + drag.dy), moved: true });
      return;
    }
    const g = gesture.current;
    if (g?.kind === "pan" && scale) {
      setView(fit({ ...g.vb, x: g.vb.x - (e.clientX - g.px) / scale, y: g.vb.y - (e.clientY - g.py) / scale }));
    } else if (g?.kind === "pinch" && touches.current.size === 2) {
      const f = g.dist / Math.max(1, spread().dist);
      setView(fit({ x: g.x - (g.x - g.vb.x) * f, y: g.y - (g.y - g.vb.y) * f, w: g.vb.w * f, h: g.vb.h * f }));
    }
  };
  const end = (e: ReactPointerEvent) => {
    touches.current.delete(e.pointerId);
    gesture.current = null;
    if (drag?.moved) onMove(drag.tag, drag.x, drag.y);
    setDrag(null);
  };
  // Abgelegt wird beim Klick: ein Wischen über die Platte lässt kein Teil fallen.
  const click = (e: ReactMouseEvent) => {
    if (press.current.moved) return;
    if (carrying) { const at = toMm(e); onPlace(at.x, at.y); } else onSelect("");
  };

  const start = (e: ReactPointerEvent, p: LayoutPart) => {
    e.stopPropagation();
    press.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as SVGGElement).focus({ preventScroll: true });
    onSelect(p.tag);
    if (locked || carrying) return;
    const at = toMm(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ tag: p.tag, dx: p.cx - at.x, dy: p.cy - at.y, x: p.cx, y: p.cy, moved: false });
  };

  return (
    <div className="nest-canvas" data-carrying={!!carrying} data-zoomed={!!view}>
      <div className="nest-zoom">
        <ButtonGroup>
          <Button icon="zoom-out" aria-label="Platte verkleinern" disabled={!view} onClick={() => zoomAt(1.4)} />
          <Button icon="zoom-in" aria-label="Platte vergrößern" disabled={vb.w <= full.w / MAX_ZOOM + 1e-6} onClick={() => zoomAt(1 / 1.4)} />
          <Button icon="zoom-to-fit" aria-label="Ganze Platte zeigen" disabled={!view} onClick={() => setView(null)} />
        </ButtonGroup>
        <span className="sub num-inline">{Math.round((full.w / vb.w) * 100).toLocaleString("de-DE")} %</span>
      </div>
      <svg ref={ref} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} role="group" tabIndex={-1} aria-label={`Platte ${num(W)} mal ${num(H)} Millimeter`}
           onKeyDown={onKey} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onClick={click}>
        <rect className="nest-sheet" x={0} y={0} width={W} height={H} />
        <rect className="nest-area" x={area.minx} y={area.miny} width={area.maxx - area.minx} height={area.maxy - area.miny} />
        {plate.placements.map((p) => {
          const live = drag?.tag === p.tag ? drag : null;
          const cx = live ? live.x : p.cx, cy = live ? live.y : p.cy;
          const size = Math.min(40, Math.max(14, (p.od || 80) / 4.5));
          const on = p.tag === selected;
          // Zu klein zum Lesen: die Marke kommt mit der Auswahl oder beim Hineinzoomen.
          const tag = !scale || on || size * scale >= MIN_TAG_PX;
          const font = on && scale ? Math.max(size, SELECTED_TAG_PX / scale) : size;
          return (
            <g key={p.tag} transform={`translate(${cx} ${cy})`} className="nest-part" tabIndex={0} role="button" aria-pressed={on} data-tag={p.tag}
               aria-label={`Marke ${p.tag}, ${p.label}, ${p.order_no}${bad.has(p.tag) ? ", Fehler" : ""}`}
               data-selected={on} data-bad={bad.has(p.tag)}
               onFocus={() => onSelect(p.tag)} onPointerDown={(e) => start(e, p)} onClick={(e) => e.stopPropagation()}>
              <path className="nest-ring" d={pathOf(p)} transform={`rotate(${p.rot})`} />
              <path className="nest-shape" d={pathOf(p)} fillRule="evenodd" transform={`rotate(${p.rot})`} />
              {tag && <text textAnchor="middle" y={font / 3} fontSize={font} strokeWidth={font / 6}>{p.tag}</text>}
            </g>
          );
        })}
      </svg>
      <p className="sub nest-legend">
        <span className="nest-swatch" /> Nutzfläche · <span className="nest-swatch nest-swatch-bad" /> rot gestrichelt: Teil mit Fehler · Marke erscheint bei Auswahl oder beim Hineinzoomen
      </p>
      <p className="sub nest-keys">
        Tasten auf der Platte: <kbd>R</kbd> drehen · <kbd>Entf</kbd> in die Ablage · Pfeile schieben um 1 mm, mit <kbd>Umschalt</kbd> um 10 mm · <kbd>Esc</kbd> abwählen · <kbd>Strg</kbd>+<kbd>Z</kbd> rückgängig, mit <kbd>Umschalt</kbd> wiederholen · <kbd>Strg</kbd>+Rad zoomt
      </p>
    </div>
  );
}
