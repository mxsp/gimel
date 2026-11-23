import { Button, ButtonGroup, Dialog, DialogBody, DialogFooter, HTMLSelect, HTMLTable, Icon, IconName, Tab, Tabs, Tag, Tooltip } from "@blueprintjs/core";
import NonIdealState from "../components/NonIdealState";
import Callout from "../components/Callout";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { SectionError, SectionLoading } from "../components/PageStates";
import { api, apiDownload, apiOpenHtml, apiWithCount, fmtDate, fmtDateTime, getToken } from "../api";
import { navigate } from "../router";
import { toastError, toastSuccess } from "../toast";
import { undoable } from "../undo";
import PlateViewer from "../components/PlateViewer";
import { RefLink, RelatedPanel } from "../components/RefLink";
import { plural } from "../plural";
import { engineInfo, engineText } from "../engine";
import { workOrderStatus } from "../status";
import { usePhone } from "../usePhone";
import { isWorker } from "../api";
import OrderScope from "../components/OrderScope";
import { scopeMatters, useTopology } from "../sites";
import { HintDetails, InfoHint, PageFrame, PaginationBar, StatusChip, Toolbar, statusFromFlags } from "../ui";
import LaufkarteShareControl from "../components/LaufkarteShareControl";

/* Werkeransicht — Innenaufträge an der Maschine. Übernommen aus der Subapp
   /produktion, vollständig statt in Auszügen.

   Was der Innenauftrag mitbringt und hier auch gezeigt wird: mit welchen
   Fertigungsmaßen er geplant wurde (nest_options), aus welchem Sammellauf er
   stammt, mit welcher Fassung des Rechenkerns geschachtelt wurde, welche
   Kundenaufträge darauf liegen und welche Teile daraus entstehen. Ohne diese
   Angaben lässt sich eine Platte nicht nachvollziehen, wenn später jemand
   fragt, warum sie so aussieht.

   Die Schnittdateien laufen alle über apiDownload: die Endpunkte verlangen
   einen Token, den ein blanker Link nicht mitschickt. */

interface WorkOrder {
  no: string; mat: string; mat_name: string; thk: number; status: string;
  n_plates: number; n_parts: number; n_orders: number; utilisation: number;
  due_date?: string | null; created_at: string; release_reason: string; route_scope?: string;
  material_staged_at?: string | null; material_staged_by?: string;
}
interface Mark {
  tag: string; order_no: string; customer: string; customer_ref: string;
  label: string; od: number; di: number; from_remnant: boolean; position_id: number | null;
}
interface Plate {
  id: number; idx: number; fmt: number[]; used_h: number;
  n_parts: number; utilisation: number; status: string; items: Mark[];
}
interface ByOrder {
  order_no: string; customer: string; customer_ref: string; plates: number[];
  n_parts: number; n_positions: number; position_ids: number[];
  due_date: string | null; rush: boolean; cert: string;
  complete: boolean; done: boolean; done_at: string | null;
}
interface ByPart {
  position_id: number; label: string; order_no: string; customer: string;
  od: number; di: number; qty: number; n_from_remnant: number; plates: number[];
  thk: number; bolt_count: number; bolt_d: number; bolt_circle: number;
  cut_len: number; has_shape: boolean;
  shape_id?: number | null; shape_key?: string; shape_label?: string;
}
interface NestOptions { gap: number; margin: number; trim_w: number; trim_h: number; usable: number[]; }
/* Der hergeleitete Schnittplan (domain/cutting.py). Kommt fertig vom Server,
   samt Auswahlliste und Begründung — die Oberfläche erfindet hier keine
   zweite Wortliste über dieselbe Regel. */
interface CutPlan {
  layered: boolean; strategy: string; label: string;
  machine_kind: string; grip: string; mandatory: boolean;
  reason: string; warning: string;
  choices: Array<{ value: string; label: string; warning: string }>;
}
interface WorkOrderDetail extends WorkOrder {
  id: number; run_no: string; fmt: number[]; formats: Array<[number, number, number]>;
  engine_version: string; machine: string; policy_mode: string;
  nest_options: NestOptions; order_done: Record<string, string>;
  started_at: string | null; started_by: string;
  done_at: string | null; done_by: string;
  plates: Plate[]; by_order: ByOrder[]; by_part: ByPart[];
  cut_plan: CutPlan;
}

const st = workOrderStatus;
const mm = (v: number) => `${v.toFixed(1)} mm`;
const fmtThk = (v: number) => v.toLocaleString("de-DE", { maximumFractionDigits: 2 });

interface RowAction { key: string; icon: IconName; label: string; text: string; run: () => void }

/* PlotPro — die Schnittfolge steht in den Ebenen.

   Bis 2026-08 stand hier ein Häkchen, das aus war, und dahinter „Außen →
   Innen". Beides war falsch herum: außen nach innen ist genau das, was die
   Umwandlung in die DIE-Datei des Plotters von sich aus tut, und auf glattem
   Werkstoff ist das der Schaden, den PlotPro verhindern soll (runde
   Dichtungen werden oval, weil die Ansaugkraft nicht mehr reicht).

   Jetzt entscheidet der Server aus Maschinenart und Werkstoff, die Liste und
   die Beschriftungen kommen von dort (`detail.cut_plan`), und der Bediener
   kann überstimmen — dann steht die Warnung daneben. */
const AUTO = "auto";

/* Maschinenarten im Klartext — dieselben Werte wie models.MachineKind. */
const MACHINE_LABEL: Record<string, string> = {
  plotter: "Schneidplotter",
  waterjet: "Wasserstrahl",
  punch: "Stanze",
  manual: "Handarbeit",
};

export default function Production({ no = "" }: { no?: string }) {
  const sites = useTopology();
  const phone = usePhone();
  /* Die Formenbibliothek ist Büro; der Werker liest die Kennung, springt aber
     nicht in einen Bildschirm, den seine Rolle nicht öffnen darf. */
  const office = !isWorker();
  const [rows, setRows] = useState<WorkOrder[] | null>(null);
  const rowsRef = useRef<WorkOrder[] | null>(null);
  rowsRef.current = rows;
  const [detail, setDetail] = useState<WorkOrderDetail | null>(null);
  const [plateIdx, setPlateIdx] = useState(0);
  const [tag, setTag] = useState<string | undefined>();
  const [filter, setFilter] = useState("offen");
  const [tab, setTab] = useState("platte");
  const [preview, setPreview] = useState<{ part: ByPart; svg: string } | null>(null);
  const [cutWant, setCutWant] = useState(AUTO);

  /* Was tatsächlich herauskommt: bei „Automatisch" der Plan des Servers,
     sonst die Wahl des Bedieners. Nur zum Beschriften der Knöpfe — die
     Entscheidung fällt noch einmal serverseitig, denn eine Datei darf nicht
     davon abhängen, was ein Browser für richtig hält. */
  const plan = detail?.cut_plan;
  const effective = cutWant === AUTO ? (plan?.layered ? plan.strategy : "") : cutWant;
  const layered = effective !== "" && effective !== "klassisch";
  /* Die Warnung des Servers gilt für seinen Plan; sie steht nur dann hier,
     wenn der Bediener auch wirklich abweicht. Bei „Automatisch" gibt es
     nichts zu warnen — dann ist die Wahl die Regel. */
  const cutWarn = cutWant === AUTO
    ? "" : (plan?.choices.find((c) => c.value === cutWant)?.warning ?? "");

  /* Schnittdateien-URLs: die Wahl reist als Query mit. Bei „Automatisch"
     bleibt sie weg — der Server leitet dann selbst her, und ein gespeicherter
     Link folgt der Maschine statt einer eingefrorenen Folge. */
  const ppUrl = (path: string) =>
    cutWant === AUTO ? path
      : `${path}${path.includes("?") ? "&" : "?"}plotpro=${encodeURIComponent(cutWant)}`;
  const ppSuffix = () => (layered ? `-plotpro-${effective}` : "");

  const [loadError, setLoadError] = useState("");
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [loadingPage, setLoadingPage] = useState(false);
  const load = useCallback(async (nextOffset = offset, nextLimit = pageSize, nextFilter = filter) => {
    setLoadingPage(true);
    try {
      const params = new URLSearchParams({ limit: String(nextLimit), offset: String(nextOffset) });
      if (nextFilter === "running" || nextFilter === "done") params.set("status", nextFilter);
      const { data, total: hdrTotal } = await apiWithCount<WorkOrder[]>(`/api/production/work-orders?${params.toString()}`);
      setRows(data);
      setTotal(hdrTotal ?? data.length);
      setLoadError("");
    }
    catch (e: any) { setLoadError(e.message ?? String(e)); if (rowsRef.current) toastError(e.message); }
    finally { setLoadingPage(false); }
  }, [offset, pageSize, filter]);
  useEffect(() => { load(offset, pageSize, filter); }, [offset, pageSize, filter, load]);

  const openDetail = useCallback(async (no: string, keep = false) => {
    try {
      const d = await api<WorkOrderDetail>(`/api/production/work-orders/${no}`);
      setDetail(d);
      /* Ein Tiefensprung kann einen Innenauftrag treffen, der nicht in den
         letzten 100 Zeilen steht. Dann fehlt die Zeile, unter der das Panel
         hängt — also einmal nach oben legen. */
      setRows((prev) => prev && !prev.some((w) => w.no === d.no) ? [d, ...prev] : prev);
      if (!keep) { setPlateIdx(0); setTag(undefined); setTab("platte"); }
    } catch (e: any) { toastError(e.message); }
  }, []);

  /* Deep-Link aus Auftrag oder Form: #/produktion/WO-26-0012 öffnet den
     Innenauftrag unter der Liste. Einmal je Nummer — wer ihn schließt, soll
     ihn beim nächsten Rendern nicht wieder aufgeklappt bekommen. */
  const wanted = decodeURIComponent(no);
  const opened = useRef("");
  useEffect(() => {
    if (!wanted) { opened.current = ""; return; }
    if (!rows || opened.current === wanted) return;
    opened.current = wanted;
    setFilter("alle");
    openDetail(wanted);
  }, [wanted, rows, openDetail]);

  /* Die Einzelheiten stehen direkt unter der Zeile. Ein zweiter Klick schließt sie. */
  const toggle = (no: string) => {
    if (detail?.no === no) {
      setDetail(null);
      if (wanted) navigate("produktion");
    } else {
      openDetail(no);
    }
  };

  const openNo = detail?.no;
  useEffect(() => {
    if (openNo) document.getElementById(`wo-${openNo}`)?.scrollIntoView({ block: "nearest" });
  }, [openNo]);

  const grab = async (path: string, name: string) => {
    try { await apiDownload(path, name); toastSuccess(`${name} geladen.`); }
    catch (e: any) { toastError(e.message); }
  };

  const refresh = (no: string) => { load(); if (detail?.no === no) openDetail(no, true); };

  const setStatus = (no: string, status: string, from: string) =>
    undoable({
      run: () => api(`/api/production/work-orders/${no}/status`,
                     { method: "POST", body: JSON.stringify({ status }) }),
      undo: () => api(`/api/production/work-orders/${no}/status`,
                      { method: "POST", body: JSON.stringify({ status: from }) }),
      done: `${no}: ${st(status).label}.`,
      undone: `${no} steht wieder auf „${st(from).label}".`,
      after: () => refresh(no),
    });

  const setPlateStatus = (no: string, idx: number, status: string, from: string) =>
    undoable({
      run: () => api(`/api/production/work-orders/${no}/plates/${idx}/status`,
                     { method: "PATCH", body: JSON.stringify({ status }) }),
      undo: () => api(`/api/production/work-orders/${no}/plates/${idx}/status`,
                      { method: "PATCH", body: JSON.stringify({ status: from }) }),
      done: `Platte ${idx + 1}: ${st(status).label}.`,
      undone: `Platte ${idx + 1} steht wieder auf „${st(from).label}".`,
      after: () => refresh(no),
    });

  /* „Dieser Auftrag ist hier fertig geschnitten und sortiert" — nicht „der
     Innenauftrag ist durch". Der Werker sortiert die fertigen Aufträge von
     der Platte, während andere noch auf die nächste warten. */
  const setOrderDone = (no: string, orderNo: string, done: boolean) =>
    undoable({
      run: () => api(`/api/production/work-orders/${no}/orders/${orderNo}/done`,
                     { method: "POST", body: JSON.stringify({ done }) }),
      undo: () => api(`/api/production/work-orders/${no}/orders/${orderNo}/done`,
                      { method: "POST", body: JSON.stringify({ done: !done }) }),
      done: `${orderNo} ${done ? "als fertig markiert" : "wieder offen"}.`,
      undone: `${orderNo} ${done ? "wieder offen" : "wieder als fertig markiert"}.`,
      after: () => refresh(no),
    });

  /* Bereitstellen — der Schritt, bevor die Maschine anläuft: die Platten
     liegen am Arbeitsplatz. Gebucht wird die physische Tat, kein Status. */
  const setStaged = (no: string, staged: boolean) =>
    undoable({
      run: () => api(`/api/production/work-orders/${no}/stage`,
                     { method: "POST", body: JSON.stringify({ staged }) }),
      undo: () => api(`/api/production/work-orders/${no}/stage`,
                      { method: "POST", body: JSON.stringify({ staged: !staged }) }),
      done: staged ? `${no}: Material bereitgestellt.` : `${no}: Bereitstellung zurückgenommen.`,
      undone: staged ? `${no} wieder in der Bereitstellungsliste.` : `${no} wieder als bereitgestellt gebucht.`,
      after: () => refresh(no),
    });

  const showPart = async (part: ByPart) => {
    try {
      const r = await fetch(`/api/production/work-orders/${detail!.no}/part/${part.position_id}.svg`,
                            { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
      if (!r.ok) throw new Error(`Teilezeichnung nicht abrufbar (${r.status}).`);
      setPreview({ part, svg: await r.text() });
    } catch (e: any) { toastError(e.message); }
  };

  const visible = (rows ?? []).filter((w) =>
    filter === "alle" ? true
      : filter === "offen" ? w.status !== "done" && w.status !== "cancelled"
      : w.status === filter);

  const plate = detail?.plates.find((p) => p.idx === plateIdx) ?? detail?.plates[0];

  /* Die Zeile zeigt, was als Nächstes dran ist: bereitstellen, starten, fertig
     melden. Alle anderen Schritte bleiben daneben erreichbar, keiner fällt weg. */
  const actionsOf = (w: WorkOrder) => {
    const stage: RowAction = { key: "stage", icon: "cube", label: "Material bereitstellen", text: "Bereitstellen", run: () => setStaged(w.no, true) };
    const unstage: RowAction = { key: "unstage", icon: "undo", label: "Bereitstellung zurücknehmen", text: "Zurücknehmen", run: () => setStaged(w.no, false) };
    const start: RowAction = { key: "start", icon: "play", label: "Starten", text: "Starten", run: () => setStatus(w.no, "running", w.status) };
    const finish: RowAction = { key: "finish", icon: "tick", label: "Ganz fertig", text: "Ganz fertig", run: () => setStatus(w.no, "done", w.status) };
    const all: RowAction[] = [];
    if ((w.status === "open" || w.status === "running") && !w.material_staged_at) all.push(stage);
    if (w.material_staged_at && w.status === "open") all.push(unstage);
    if (w.status === "open") all.push(start);
    if (w.status !== "done") all.push(finish);
    const first = w.status === "open" ? (w.material_staged_at ? start : stage) : w.status === "running" ? finish : null;
    return { primary: first, rest: all.filter((a) => a !== first) };
  };

  const statusTags = (w: WorkOrder) => {
    const flags = statusFromFlags([
      { label: st(w.status).label, tone: st(w.status).intent, on: true },
      { label: "Material bereit", tone: "primary", on: !!w.material_staged_at,
        title: w.material_staged_by || undefined },
    ]);
    return <StatusChip primary={flags.primary} extras={flags.extras} />;
  };

  const material = (w: WorkOrder) => `${w.mat_name || w.mat} · ${fmtThk(w.thk)} mm`;

  const groups = [
    { key: "running", title: "Läuft", rows: visible.filter((w) => w.status === "running") },
    { key: "waiting", title: "Wartet", rows: visible.filter((w) => !["running", "done", "cancelled"].includes(w.status)) },
    { key: "closed", title: "Abgeschlossen", rows: visible.filter((w) => w.status === "done" || w.status === "cancelled") },
  ].filter((g) => g.rows.length > 0);

  /* Formen dieses Innenauftrags — verdichtet aus den Teilen. Der Weg zurück
     in die Bibliothek und zu den Aufträgen, die sie bestellt haben. */
  const formSummary = (() => {
    const map = new Map<number, {
      id: number; key: string; label: string; qty: number; orders: Set<string>;
    }>();
    for (const part of detail?.by_part ?? []) {
      if (!part.shape_id) continue;
      const entry = map.get(part.shape_id) ?? {
        id: part.shape_id, key: part.shape_key || "", label: part.shape_label || "",
        qty: 0, orders: new Set<string>(),
      };
      entry.qty += part.qty;
      entry.orders.add(part.order_no);
      map.set(part.shape_id, entry);
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  })();

  const panel = detail && plate ? (
    <div className="detail-panel">
      <h2>Innenauftrag <span className="mono">{detail.no}</span>{" "}
        <Tag minimal intent={st(detail.status).intent}>{st(detail.status).label}</Tag></h2>

      {/* Die Angaben, mit denen dieser Innenauftrag geplant wurde. */}
      <div className="side-kv wo-facts">
        <span>Werkstoff</span><b>{detail.mat_name || detail.mat} · {detail.thk} mm</b>
        <span>Platten</span><b>{detail.n_plates}</b>
        <span>Teile</span><b>{detail.n_parts}</b>
        <span>Aufträge</span><b>{detail.n_orders}</b>
        <span>Ausnutzung</span><b>{Math.round(detail.utilisation * 100)} %</b>
        <span>Erstellt</span><b>{fmtDateTime(detail.created_at)}</b>
        <span>Aus Sammellauf</span><b className="mono"><RefLink kind="run" no={detail.run_no} /></b>
        <span>Rechenkern</span><b>{engineText(detail.engine_version)}<span className="sub"> — {engineInfo(detail.engine_version).about}</span></b>
        <span>Betriebsart</span><b>{detail.policy_mode}</b>
        <span>Freigabegrund</span><b>{detail.release_reason || "—"}</b>
        <span>Maschine</span><b>{detail.machine || "—"}</b>
        {!isWorker() && scopeMatters(sites.topo) && detail.status === "open" && <><span>Fertigen in</span><b>
          <OrderScope kind="work-order" no={detail.no} topo={sites.topo} initial={detail.route_scope ?? ""} />
        </b></>}
        <span>Plattenformate</span>
        <b className="mono">
          {(detail.formats ?? []).map((f) => `${f[2]}× ${f[0]}×${f[1]}`).join(" · ") ||
           `${detail.fmt?.[0]}×${detail.fmt?.[1]}`}
        </b>
        <span>Teileabstand</span><b className="mono">{mm(detail.nest_options?.gap ?? 0)}</b>
        <span>Randabstand</span><b className="mono">{mm(detail.nest_options?.margin ?? 0)}</b>
        <span>Beschnitt B/H</span>
        <b className="mono">{mm(detail.nest_options?.trim_w ?? 0)} / {mm(detail.nest_options?.trim_h ?? 0)}</b>
        <span>Nutzbares Feld</span>
        <b className="mono">
          {detail.nest_options?.usable
            ? `${detail.nest_options.usable[0]} × ${detail.nest_options.usable[1]} mm`
            : "—"}
        </b>
        <span>Material bereit</span>
        <b>
          {detail.material_staged_at
            ? `${fmtDateTime(detail.material_staged_at)}${detail.material_staged_by ? ` · ${detail.material_staged_by}` : ""}`
            : "—"}
        </b>
        <span>Gestartet</span>
        <b>{fmtDateTime(detail.started_at)}{detail.started_by ? ` · ${detail.started_by}` : ""}</b>
        <span>Fertig</span>
        <b>{fmtDateTime(detail.done_at)}{detail.done_by ? ` · ${detail.done_by}` : ""}</b>
      </div>

      <HintDetails title="Warum diese Fertigungsmaße?">
        Die Fertigungsmaße oben sind die, mit denen <b>diese</b> Platte geplant wurde — sie
        hängen an der Freigaberegel, nicht am Preis. Ein späterer Wechsel der Regel ändert
        nichts an einem bereits geschnittenen Innenauftrag.
      </HintDetails>

      {/* Der Schnittplan steht als Hinweis am Auswahlfeld; nur die Abweichung
          von der Werkstattvorgabe bleibt als Warnung sichtbar. */}
      {plan && cutWarn && (
        <Callout icon="warning-sign" intent="warning" style={{ margin: "12px 0" }}>
          <b>{cutWarn}</b>
        </Callout>
      )}

      <div className="toolbar">
        {detail.status !== "done" && detail.status !== "cancelled" && !detail.material_staged_at && (
          <Button icon="cube" text="Material bereitstellen"
                  onClick={() => setStaged(detail.no, true)} />
        )}
        {detail.material_staged_at && !detail.started_at && (
          <Button icon="undo" text="Bereitstellung zurücknehmen"
                  onClick={() => setStaged(detail.no, false)} />
        )}
        <Button icon="download" intent="primary" text="Alle Schnittdateien (ZIP)"
                onClick={() => grab(ppUrl(`/api/production/work-orders/${detail.no}/cutfiles.zip`),
                                    `${detail.no}-schnittdateien${ppSuffix()}.zip`)} />
        <HTMLSelect value={cutWant} onChange={(e) => setCutWant(e.target.value)}
                    title="Schnittfolge der Vollplatten-DXF. „Automatisch“ folgt Maschine und Werkstoff.">
          {(plan?.choices ?? [{ value: AUTO, label: "Automatisch" }])
            .map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </HTMLSelect>
        {plan && (
          <InfoHint
            label="Schnittfolge erklärt"
            title={`Schnittfolge: ${cutWant === AUTO ? plan.label
              : (plan.choices.find((c) => c.value === cutWant)?.label ?? cutWant)}`}
            text={
              <>
                <p>{plan.reason}</p>
                <p>
                  {plan.machine_kind
                    ? `Maschine ${MACHINE_LABEL[plan.machine_kind] ?? plan.machine_kind}`
                    : "noch keiner Station zugeordnet"}
                  {" · "}Werkstoff {plan.grip}
                  {" · "}{layered
                    ? "jedes Teil auf eigenen Ebenen PLOTPRO_01_1_LOCH, 01_2_KONTUR, 02_… — die Auslage ist nicht ein Teil"
                    : "klassische Datei, zwei Ebenen (ALPHA_KONTUR / ALPHA_LOCH)"}
                </p>
              </>
            }
          />
        )}
        <Button icon="print" text="Laufkarte"
                onClick={() => apiOpenHtml(`/api/production/work-orders/${detail.no}/sheet`)
                                 .catch((e) => toastError(e.message))} />
        <LaufkarteShareControl woNo={detail.no} small={false} />
        <Button icon="download" text="Laufkarte speichern"
                title="Laufkarte als HTML-Datei — mitnehmen und woanders drucken"
                onClick={() => grab(`/api/production/work-orders/${detail.no}/sheet?download=1`,
                                    `${detail.no}-laufkarte.html`)} />
      </div>

      <Tabs id="wo" selectedTabId={tab} onChange={(t) => setTab(String(t))} renderActiveTabPanelOnly>
        <Tab id="platte" title={`Platten (${detail.n_plates})`} panel={
          <>
            <div className="toolbar">
              <ButtonGroup>
                {detail.plates.map((p) => (
                  <Button key={p.idx} active={p.idx === plate.idx}
                          intent={p.status === "done" ? "success" : "none"}
                          onClick={() => { setPlateIdx(p.idx); setTag(undefined); }}
                          text={`Platte ${p.idx + 1}`} />
                ))}
              </ButtonGroup>
              <span style={{ flex: 1 }} />
              <Button small icon="media" text="Zeichnung"
                      title="Plattenzeichnung als SVG speichern"
                      onClick={() => grab(`/api/production/work-orders/${detail.no}/plate/${plate.idx}.svg?download=1`,
                                          `${detail.no}-platte-${plate.idx + 1}-zeichnung.svg`)} />
              <Button small icon="download" text="Platten-DXF"
                      onClick={() => grab(ppUrl(`/api/production/work-orders/${detail.no}/plate/${plate.idx}.dxf`),
                                          `${detail.no}-platte-${plate.idx + 1}${ppSuffix()}.dxf`)} />
              {plate.status === "done"
                ? <Button small minimal icon="undo" text="wieder offen"
                          onClick={() => setPlateStatus(detail.no, plate.idx, "open", plate.status)} />
                : <Button small intent="success" icon="tick" text="Platte fertig"
                          onClick={() => setPlateStatus(detail.no, plate.idx, "done", plate.status)} />}
            </div>

            <div className="ui-facts">
              <div className="ui-fact">
                <span className="ui-fact-value">Platte {plate.idx + 1} / {detail.n_plates}</span>
                <span className="ui-fact-label">Platte</span>
              </div>
              <div className="ui-fact">
                <span className="ui-fact-value mono">{plate.fmt[0]} × {plate.fmt[1]} mm</span>
                <span className="ui-fact-label">Format</span>
              </div>
              <div className="ui-fact">
                <span className="ui-fact-value">{plural(plate.n_parts, "Teil", "Teile")}</span>
                <span className="ui-fact-label">Teile</span>
              </div>
              <div className="ui-fact">
                <span className="ui-fact-value">{Math.round(plate.utilisation * 100)} %</span>
                <span className="ui-fact-label">Ausnutzung</span>
              </div>
              <div className="ui-fact">
                <span className="ui-fact-value mono">{plate.used_h?.toFixed(0)} mm</span>
                <span className="ui-fact-label">Schnitt bis</span>
              </div>
              <div className="ui-fact">
                <span className="ui-fact-value">
                  <Tag minimal intent={st(plate.status).intent}>{st(plate.status).label}</Tag>
                </span>
                <span className="ui-fact-label">Status</span>
              </div>
            </div>

            <PlateViewer src={`/api/production/work-orders/${detail.no}/plate/${plate.idx}.svg`}
                         highlightTag={tag}
                         onPickTag={(t) => setTag((cur) => (cur === t ? undefined : t))} />

            <h3>Marken auf dieser Platte ({plate.items.length})</h3>
            <p className="sub">Zeile anklicken hebt das Teil in der Zeichnung hervor.</p>
            <div className="table-scroll" style={{ maxHeight: 340, overflowY: "auto" }}>
              <HTMLTable className="data-table" striped compact interactive>
                <thead>
                  <tr>
                    <th>Marke</th><th>Auftrag</th><th>Kunde</th><th>Teil</th>
                    <th className="num">Ø außen</th><th className="num">Ø innen</th><th>Herkunft</th><th><span className="sr-only">Aktion</span></th>
                  </tr>
                </thead>
                <tbody>
                  {plate.items.map((m, i) => (
                    <tr key={`${m.tag}-${i}`} className={tag === m.tag ? "row-active" : undefined}
                        onClick={() => setTag(tag === m.tag ? undefined : m.tag)}>
                      <td className="mono"><b>{m.tag}</b></td>
                      <td className="mono"><RefLink kind="order" no={m.order_no} /></td>
                      <td>{m.customer}</td>
                      <td>{m.label}</td>
                      <td className="num mono">{m.od?.toFixed(1)}</td>
                      <td className="num mono">{m.di > 0 ? m.di.toFixed(1) : "—"}</td>
                      <td><Tag minimal intent={m.from_remnant ? "success" : "primary"}>
                        {m.from_remnant ? "Restfläche" : "Platte"}</Tag></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {m.position_id != null && (
                          <Button small minimal icon="download" title="Dieses Teil als DXF"
                                  onClick={() => grab(
                                    `/api/production/work-orders/${detail.no}/part/${m.position_id}.dxf`,
                                    `${detail.no}-${m.tag}.dxf`)} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </HTMLTable>
            </div>
          </>
        } />

        <Tab id="auftraege" title={`Kundenaufträge (${detail.by_order.length})`} panel={
          <>
            <p className="sub ui-inline-actions" style={{ marginBottom: 8 }}>
              Hier vollständig
              <InfoHint text="Das Häkchen heißt „dieser Auftrag ist hier fertig geschnitten und sortiert“ — nicht „der Innenauftrag ist durch“."
                        title="Bedeutung des Häkchens" label="Bedeutung von hier vollständig" />
            </p>
            <div className="table-scroll"><HTMLTable className="data-table" striped compact>
              <thead>
                <tr>
                  <th>Auftrag</th><th>Kunde</th><th>Bestellzeichen</th>
                  <th className="num">Positionen</th><th className="num">Teile</th>
                  <th>Platten</th><th>Zeugnis</th><th>Zusage</th><th>Hier vollständig</th><th><span className="sr-only">Aktion</span></th>
                </tr>
              </thead>
              <tbody>
                {detail.by_order.map((o) => (
                  <tr key={o.order_no}>
                    <td className="mono">
                      <Button minimal small icon="inbox" text={o.order_no}
                              title="Auftrag in der Auftragsliste öffnen"
                              onClick={() => navigate(`auftraege/${o.order_no}`)} />
                      {o.rush && <Tag minimal intent="danger" style={{ marginLeft: 4 }}>Eil</Tag>}
                    </td>
                    <td>{o.customer}</td>
                    <td className="sub">{o.customer_ref || "—"}</td>
                    <td className="num">{o.n_positions}</td>
                    <td className="num">{o.n_parts}</td>
                    <td className="mono sub">{o.plates.join(", ")}</td>
                    <td>{o.cert}</td>
                    <td className="sub">{fmtDate(o.due_date)}</td>
                    <td>
                      <Tag minimal intent={o.complete ? "success" : "warning"}>
                        {o.complete ? "ja" : "Teile auf weiteren Innenaufträgen"}
                      </Tag>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <Button small minimal icon="download" title="Teile dieses Auftrags von dieser Platte"
                              onClick={() => grab(
                                `/api/production/work-orders/${detail.no}/plate/${plate.idx}/auftrag/${o.order_no}.dxf`,
                                `${detail.no}-platte-${plate.idx + 1}-${o.order_no}.dxf`)} />
                      {o.done
                        ? <Button small minimal icon="undo" text="offen"
                                  onClick={() => setOrderDone(detail.no, o.order_no, false)} />
                        : <Button small intent="success" icon="tick" text="fertig"
                                  onClick={() => setOrderDone(detail.no, o.order_no, true)} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </HTMLTable></div>
          </>
        } />

        <Tab id="teile" title={`Teile (${detail.by_part.length})`} panel={
          <div className="table-scroll"><HTMLTable className="data-table" striped compact>
            <thead>
              <tr>
                <th>Teil</th><th>Auftrag</th><th>Form</th><th className="num">Stück</th>
                <th className="num">Ø außen</th><th className="num">Ø innen</th>
                <th>Bohrungen</th><th className="num">Schnittlänge</th>
                <th>Platten</th><th className="num">aus Rest</th><th><span className="sr-only">Aktion</span></th>
              </tr>
            </thead>
            <tbody>
              {detail.by_part.map((p) => (
                <tr key={p.position_id}>
                  <td><b>{p.label}</b><div className="mono sub">Pos. {p.position_id}</div></td>
                  <td className="mono">
                    <Button minimal small icon="inbox" text={p.order_no}
                            title="Auftrag in der Auftragsliste öffnen"
                            onClick={() => navigate(`auftraege/${p.order_no}`)} />
                    <div className="sub">{p.customer}</div>
                  </td>
                  <td>{p.shape_id
                    ? office
                      ? <Button minimal small icon="folder-open" className="mono"
                                text={p.shape_key || p.shape_label || `#${p.shape_id}`}
                                title={`${p.shape_label || p.shape_key || "Form"} in der Bibliothek öffnen`}
                                onClick={() => navigate(`formen/${p.shape_id}`)} />
                      : <span className="mono">{p.shape_key || `#${p.shape_id}`}</span>
                    : <span className="sub">—</span>}</td>
                  <td className="num">{p.qty}</td>
                  <td className="num mono">{p.od?.toFixed(1)}</td>
                  <td className="num mono">{p.di > 0 ? p.di.toFixed(1) : "—"}</td>
                  <td className="sub">
                    {p.bolt_count > 0 ? `${p.bolt_count} × Ø${p.bolt_d} auf LK ${p.bolt_circle}` : "—"}
                  </td>
                  <td className="num mono">{(p.cut_len / 1000).toFixed(2)} m</td>
                  <td className="mono sub">{p.plates.join(", ")}</td>
                  <td className="num">{p.n_from_remnant || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {p.has_shape && <Button small minimal icon="eye-open" title="Zeichnung ansehen"
                                            onClick={() => showPart(p)} />}
                    <Button small minimal icon="download" title="Teil als DXF"
                            onClick={() => grab(
                              `/api/production/work-orders/${detail.no}/part/${p.position_id}.dxf`,
                              `${detail.no}-pos${p.position_id}.dxf`)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </HTMLTable></div>
        } />

        <Tab id="verweise" title="Verweise" panel={<RelatedPanel no={detail.no} />} />

        <Tab id="formen" title={`Formen (${formSummary.length})`} panel={
          formSummary.length === 0 ? (
            <p className="sub">Keine Position aus der Formenbibliothek — DXF-Uploads und Handarbeit haben keine Hausform.</p>
          ) : (
            <div className="table-scroll"><HTMLTable className="data-table" striped compact>
              <thead>
                <tr><th>Form</th><th>Bezeichnung</th><th className="num">Teile</th><th>Aufträge</th></tr>
              </thead>
              <tbody>
                {formSummary.map((f) => (
                  <tr key={f.id}>
                    <td>{office
                      ? <Button minimal small icon="folder-open" className="mono"
                                text={f.key || `#${f.id}`}
                                title="Form in der Bibliothek öffnen"
                                onClick={() => navigate(`formen/${f.id}`)} />
                      : <span className="mono">{f.key || `#${f.id}`}</span>}</td>
                    <td>{f.label || <span className="sub">—</span>}</td>
                    <td className="num">{f.qty}</td>
                    <td>{[...f.orders].sort().map((no) => (
                      <Button key={no} minimal small icon="inbox" className="mono" text={no}
                              title="Auftrag in der Auftragsliste öffnen"
                              onClick={() => navigate(`auftraege/${no}`)} />
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </HTMLTable></div>
          )
        } />
      </Tabs>
    </div>
  ) : null;

  const row = (w: WorkOrder) => {
    const open = detail?.no === w.no;
    const { primary, rest } = actionsOf(w);
    const running = w.status === "running";
    return (
      <Fragment key={w.no}>
        <tr id={`wo-${w.no}`} onClick={() => toggle(w.no)}
            className={(open ? "row-active" : "") + (running ? " prod-running" : "") || undefined}>
          <td className="mono">
            <button type="button" className="prod-no" aria-expanded={open}
                    onClick={(e) => { e.stopPropagation(); toggle(w.no); }}>
              <Icon icon={open ? "chevron-down" : "chevron-right"} size={14} /><b>{w.no}</b>
            </button>
          </td>
          <td className="prod-cut" title={material(w)}>{material(w)}</td>
          <td className="prod-cut prod-reason prod-opt" title={w.release_reason || undefined}>{w.release_reason || "—"}</td>
          <td className="num prod-opt">{w.n_parts}</td>
          <td className="prod-status">{statusTags(w)}</td>
          <td className="prod-actions" onClick={(e) => e.stopPropagation()}>
            {rest.map((a) => (
              <Tooltip key={a.key} content={a.label} compact placement="top">
                <Button small minimal icon={a.icon} aria-label={`${a.label}: ${w.no}`} onClick={a.run} />
              </Tooltip>
            ))}
            {primary && <Button small icon={primary.icon} text={primary.text} intent="primary"
                                className="prod-primary" aria-label={`${primary.label}: ${w.no}`} onClick={primary.run} />}
          </td>
        </tr>
        {open && panel && (
          <tr className="row-detail prod-detail"><td colSpan={6}>{panel}</td></tr>
        )}
      </Fragment>
    );
  };

  const card = (w: WorkOrder) => {
    const open = detail?.no === w.no;
    const { primary, rest } = actionsOf(w);
    const running = w.status === "running";
    return (
      <li key={w.no} id={`wo-${w.no}`} className={"prod-card" + (running ? " prod-card-running" : "")}>
        <button type="button" className="prod-card-open" aria-expanded={open} onClick={() => toggle(w.no)}>
          <b className="mono">{w.no}</b>
          <span className="prod-card-tags">{statusTags(w)}</span>
          <Icon icon={open ? "chevron-up" : "chevron-down"} />
        </button>
        <div className="prod-card-mat">{material(w)}</div>
        <div className="prod-card-reason">
          Freigabegrund: {w.release_reason || "—"} · {plural(w.n_parts, "Teil", "Teile")}
        </div>
        {(primary || rest.length > 0) && (
          <div className="prod-card-actions">
            {primary && <Button icon={primary.icon} text={primary.text} intent="primary"
                                aria-label={`${primary.label}: ${w.no}`} onClick={primary.run} />}
            {rest.map((a) => <Button key={a.key} text={a.text}
                                     aria-label={`${a.label}: ${w.no}`} onClick={a.run} />)}
          </div>
        )}
        {open && panel}
      </li>
    );
  };

  return (
    <PageFrame
      title="Produktion"
      help={[{ title: "Aufbau der Liste", text: "Oben stehen laufende Innenaufträge, darunter wartende. Der Freigabegrund steht in der Zeile; Zeichnung, Marken und Schnittdateien öffnen sich unter der Zeile." }]}
      actions={<Button icon="refresh" text="Aktualisieren" onClick={() => load()} />}
    >
      <Toolbar
        meta={<span className="sub prod-count" role="status">
          {total > pageSize
            ? `${(offset + 1).toLocaleString("de-DE")}–${(offset + visible.length).toLocaleString("de-DE")} von ${total.toLocaleString("de-DE")} Innenaufträgen`
            : plural(visible.length, "Innenauftrag", "Innenaufträge")}
        </span>}
      >
        <HTMLSelect value={filter} aria-label="Fertigungsaufträge filtern" onChange={(e) => { setFilter(e.currentTarget.value); setOffset(0); }}>
          <option value="offen">offene</option>
          <option value="running">laufende</option>
          <option value="done">fertige</option>
          <option value="alle">alle</option>
        </HTMLSelect>
      </Toolbar>

      {!rows ? (loadError ? <SectionError message={loadError} onRetry={() => load()} /> : <SectionLoading />) : visible.length === 0 ? (
        <NonIdealState icon="cut" title="Keine Innenaufträge"
                       description="Der Sammellauf legt Innenaufträge an, sobald Aufträge freigegeben sind." />
      ) : phone ? (
        groups.map((g) => (
          <section key={g.key} className="prod-group-phone" data-group={g.key}>
            <h2 className="prod-group-title">{g.title} <span className="num-inline">({g.rows.length})</span></h2>
            <ul className="prod-cards">{g.rows.map(card)}</ul>
          </section>
        ))
      ) : (
        <div className="table-scroll">
        <HTMLTable className="data-table prod-table" compact interactive>
          <colgroup>
            <col className="prod-col-no" /><col /><col className="prod-col-reason prod-opt" />
            <col className="prod-col-parts prod-opt" /><col className="prod-col-status" /><col className="prod-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>Innenauftrag</th><th>Werkstoff</th><th className="prod-opt">Freigabegrund</th>
              <th className="num prod-opt">Teile</th><th>Status</th><th><span className="sr-only">Aktion</span></th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.key} data-group={g.key}>
              <tr className="prod-group">
                <th colSpan={6} scope="rowgroup">{g.title} <span className="num-inline">({g.rows.length})</span></th>
              </tr>
              {g.rows.map(row)}
            </tbody>
          ))}
        </HTMLTable>
        </div>
      )}

      <PaginationBar
        offset={offset}
        limit={pageSize}
        total={total}
        count={rows?.length ?? 0}
        loading={loadingPage}
        noun="Innenaufträge"
        onChange={(nextOff, nextLim) => {
          setOffset(nextOff);
          if (nextLim !== undefined) setPageSize(nextLim);
        }}
      />

      {detail && plate && !visible.some((w) => w.no === detail.no) && panel}

      <Dialog isOpen={!!preview} onClose={() => setPreview(null)} style={{ width: 620 }}
              title={`Teil ${preview?.part.label ?? ""}`}>
        <DialogBody>
          <div className="part-preview" dangerouslySetInnerHTML={{ __html: preview?.svg ?? "" }} />
          {preview && (
            <div className="side-kv" style={{ marginTop: 12 }}>
              <span>Auftrag</span><b className="mono">{preview.part.order_no}</b>
              <span>Stück</span><b>{preview.part.qty}</b>
              <span>Ø außen / innen</span>
              <b className="mono">{preview.part.od.toFixed(1)} / {preview.part.di.toFixed(1)} mm</b>
              <span>Schnittlänge je Teil</span><b className="mono">{(preview.part.cut_len / 1000).toFixed(3)} m</b>
            </div>
          )}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button icon="download" text="Zeichnung (SVG)"
                    title="Teilezeichnung als SVG speichern"
                    onClick={() => preview && grab(
                      `/api/production/work-orders/${detail?.no}/part/${preview.part.position_id}.svg?download=1`,
                      `${detail?.no}-pos${preview.part.position_id}-zeichnung.svg`)} />
            <Button icon="download" text="DXF"
                    onClick={() => preview && grab(
                      `/api/production/work-orders/${detail?.no}/part/${preview.part.position_id}.dxf`,
                      `${detail?.no}-pos${preview.part.position_id}.dxf`)} />
            <Button text="Schließen" onClick={() => setPreview(null)} />
          </>} />
      </Dialog>
    </PageFrame>
  );
}
