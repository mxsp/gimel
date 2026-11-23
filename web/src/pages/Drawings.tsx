import { Alert, Button, ButtonGroup, Dialog, DialogBody, DialogFooter, FormGroup, HTMLTable, InputGroup, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDateTime } from "../api";
import Callout from "../components/Callout";
import DrawingThumb from "../components/DrawingThumb";
import NonIdealState from "../components/NonIdealState";
import PastePointsDialog from "../components/PastePointsDialog";
import { SectionError, SectionLoading } from "../components/PageStates";
import { importFile, ImportResult, listDrawings } from "../drawingsApi";
import { DrawingItem, SOURCE_LABEL } from "../freeNesting";
import { num } from "../nesting";
import { plural } from "../plural";
import { navigate } from "../router";
import { toastError, toastSuccess } from "../toast";
import { InfoHint, PageFrame, SortControl, Toolbar, sortRows, useSortPref } from "../ui";
import type { SortField } from "../ui";
import NestingModeBar from "../components/NestingModeBar";
import "../free-nesting.css";

/* Zeichnungen — die Bibliothek für das freie Schachteln.

   Nur die Kontur in Millimetern; die hochgeladene Datei wird nicht aufbewahrt. Einheiten
   werden als Millimeter gelesen. Eine Datei mit mehreren Teilen legt mehrere Zeichnungen an
   und sagt, was sie übergangen hat. */

const VIEW_KEY = "gimel-drawings-view";
type View = "table" | "grid";

function loadView(): View {
  try { return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "table"; } catch { return "table"; }
}

const cm2 = (mm2: number) => `${num(mm2 / 100, 1)} cm²`;
const meters = (mm: number) => `${num(mm / 1000, 2)} m`;
const DRAWING_SORT_FIELDS: SortField[] = [
  { id: "name", label: "Name" },
  { id: "created_at", label: "Angelegt" },
  { id: "area", label: "Fläche" },
  { id: "cut_len", label: "Schnittlänge" },
  { id: "n_holes", label: "Löcher" },
];

interface Report { id: number; created: number; skipped: string[]; notes: string[]; errors: string[] }

export default function Drawings() {
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>(loadView);
  const { sort, setSort } = useSortPref("gimel-drawings-sort", DRAWING_SORT_FIELDS);
  const [items, setItems] = useState<DrawingItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [paste, setPaste] = useState(false);
  const [renaming, setRenaming] = useState<DrawingItem | null>(null);
  const [deleting, setDeleting] = useState<DrawingItem | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const load = useCallback((query: string) => {
    const mine = ++seq.current;
    listDrawings(query).then((r) => {
      if (mine !== seq.current) return;           // eine spätere Anfrage gilt
      setItems(r.items); setTotal(r.total); setError("");
    }).catch((e) => { if (mine === seq.current) setError(e.message ?? String(e)); });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  const shown = sortRows(items ?? [], sort, (d, field) => (d as unknown as Record<string, unknown>)[field]);

  const chooseView = (v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* ohne Speicher gilt die Tabelle */ }
  };

  const showResult = (r: ImportResult, errors: string[] = []) => {
    setReport({ id: Date.now(), created: r.created.length, skipped: r.skipped, notes: r.notes, errors });
    load(q);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true);
    const all: ImportResult = { created: [], skipped: [], notes: [] };
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const r = await importFile(file);
        all.created.push(...r.created);
        all.skipped.push(...r.skipped.map((s) => `${file.name}: ${s}`));
        all.notes.push(...r.notes.filter((n) => !all.notes.includes(n)));
      } catch (e) { errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (fileInput.current) fileInput.current.value = "";
    setBusy(false);
    showResult(all, errors);
  };

  const remove = async (d: DrawingItem) => {
    try {
      await api(`/api/drawings/${d.id}`, { method: "DELETE" });
      toastSuccess(`„${d.name}“ gelöscht.`);
      setDeleting(null); load(q);
    } catch (e) { toastError(e instanceof Error ? e.message : String(e)); setDeleting(null); }
  };

  const toNesting = (d: DrawingItem) => navigate(`freies-schachteln?add=${d.id}`);

  const actions = (d: DrawingItem) => (
    <>
      <Button small intent="primary" icon="grid-view" text="Zum Schachteln" onClick={() => toNesting(d)} />
      <Button small icon="edit" text="Umbenennen" aria-label={`${d.name} umbenennen`} onClick={() => setRenaming(d)} />
      <Button small icon="trash" text="Löschen" aria-label={`${d.name} löschen`} onClick={() => setDeleting(d)} />
    </>
  );

  return (
    <PageFrame title="Zeichnungen"
               sub="Konturen für das freie Schachteln — gespeichert wird nur die Geometrie in Millimetern.">
      <NestingModeBar active="zeichnungen" />
      <Toolbar
        meta={<span className="fn-count" role="status">{items ? plural(total, "Zeichnung", "Zeichnungen") : ""}</span>}
        end={<>
          <InfoHint label="Hinweis zum Import" title="Import" text="DXF und SVG werden als Millimeter gelesen. Eine Datei mit mehreren Teilen legt mehrere Zeichnungen an; Text und Bemaßung werden übergangen." />
          <Button icon="upload" text="DXF oder SVG importieren" loading={busy} onClick={() => fileInput.current?.click()} />
          <input ref={fileInput} className="fn-file" type="file" multiple accept=".dxf,.svg,image/svg+xml"
                 aria-label="DXF- oder SVG-Dateien wählen" data-testid="import-file" onChange={(e) => onFiles(e.target.files)} />
          <Button icon="polygon-filter" text="Punkte einfügen" onClick={() => setPaste(true)} />
          <ButtonGroup>
            <Button icon="th" text="Tabelle" active={view === "table"} aria-pressed={view === "table"} onClick={() => chooseView("table")} />
            <Button icon="grid-view" text="Kacheln" active={view === "grid"} aria-pressed={view === "grid"} onClick={() => chooseView("grid")} />
          </ButtonGroup>
        </>}
      >
        <InputGroup className="fn-search" type="search" leftIcon="search" value={q} placeholder="Name oder Notiz suchen"
                    aria-label="Zeichnungen suchen" style={{ width: 260, maxWidth: "100%" }}
                    onChange={(e) => setQ(e.target.value)} />
        <SortControl state={sort} fields={DRAWING_SORT_FIELDS} onChange={setSort} />
      </Toolbar>

      {report && (
        <Callout className="fn-report" intent={report.errors.length || !report.created ? "warning" : "success"}
                 icon={report.errors.length || !report.created ? "warning-sign" : "tick-circle"}
                 title={`${plural(report.created, "Zeichnung", "Zeichnungen")} angelegt`}>
          <div role="status" data-testid="import-report">
            {report.notes.length > 0 && <ul>{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
            {report.skipped.length > 0 && <><b>Übersprungen:</b><ul>{report.skipped.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
            {report.errors.length > 0 && <><b>Nicht gelesen:</b><ul>{report.errors.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
          </div>
          <Button small minimal text="Schließen" onClick={() => setReport(null)} />
        </Callout>
      )}

      {error && !items ? <SectionError message={error} onRetry={() => load(q)} /> : !items ? <SectionLoading /> :
        items.length === 0 ? (
          <NonIdealState icon="polygon-filter" title={q ? "Keine Zeichnung gefunden" : "Noch keine Zeichnungen"}
            description={q ? "Anderen Suchbegriff versuchen." : "Importieren Sie eine DXF- oder SVG-Datei oder fügen Sie Punkte ein."} />
        ) : view === "grid" ? (
          <ul className="fn-grid" aria-label="Zeichnungen">
            {shown.map((d) => (
              <li key={d.id} className="fn-card">
                <DrawingThumb preview={d.preview} width={d.width} height={d.height} />
                <div><div className="fn-name">{d.name}</div>
                  <div className="fn-sub">{num(d.width, 1)} × {num(d.height, 1)} mm · {cm2(d.area)}</div></div>
                <div className="fn-card-foot">{actions(d)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="table-scroll">
            <HTMLTable className="data-table fn-table" striped compact aria-label="Zeichnungen">
              <thead><tr><th><span className="sr-only">Vorschau</span></th><th>Name</th><th>Quelle</th>
                <th className="num">Maße</th><th className="num">Fläche</th><th className="num">Schnittlänge</th>
                <th className="num">Löcher</th><th>Angelegt</th><th><span className="sr-only">Aktionen</span></th></tr></thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.id}>
                    <td><DrawingThumb preview={d.preview} width={d.width} height={d.height} size={40} /></td>
                    <td><div className="fn-name">{d.name}</div>{d.note && <div className="fn-sub">{d.note}</div>}</td>
                    <td><Tag minimal>{SOURCE_LABEL[d.source]}</Tag></td>
                    <td className="num">{num(d.width, 1)} × {num(d.height, 1)} mm</td>
                    <td className="num">{cm2(d.area)}</td><td className="num">{meters(d.cut_len)}</td>
                    <td className="num">{d.n_holes}</td>
                    <td className="nw">{fmtDateTime(d.created_at)}</td>
                    <td><div className="fn-actions">{actions(d)}</div></td>
                  </tr>
                ))}
              </tbody>
            </HTMLTable>
          </div>
        )}
      {items && total > items.length && <p className="fn-sub">Die ersten {items.length} von {total}; die Suche findet auch die übrigen.</p>}

      <PastePointsDialog isOpen={paste} onClose={() => setPaste(false)} onCreated={(r) => showResult(r)} />
      <RenameDialog item={renaming} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); load(q); }} />
      <Alert isOpen={!!deleting} intent="danger" icon="trash" cancelButtonText="Abbrechen" confirmButtonText="Löschen"
             onCancel={() => setDeleting(null)} onConfirm={() => deleting && remove(deleting)}>
        <p>„{deleting?.name}“ aus der Bibliothek löschen? Läufe, die sie schon benutzt haben, bleiben unverändert.</p>
      </Alert>
    </PageFrame>
  );
}

function RenameDialog({ item, onClose, onDone }: { item: DrawingItem | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (item) { setName(item.name); setNote(item.note); setError(""); } }, [item]);
  const save = async () => {
    if (!item) return;
    try {
      await api(`/api/drawings/${item.id}`, { method: "PATCH", body: JSON.stringify({ name, note }) });
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <Dialog isOpen={!!item} onClose={onClose} title="Zeichnung umbenennen" icon="edit"
            style={{ width: 440, maxWidth: "calc(100vw - 32px)" }}>
      <DialogBody>
        <FormGroup label="Name" labelFor="rename-name">
          <InputGroup id="rename-name" value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) save(); }} />
        </FormGroup>
        <FormGroup label="Notiz" labelFor="rename-note">
          <InputGroup id="rename-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </FormGroup>
        {error && <p role="alert" className="fn-error">{error}</p>}
      </DialogBody>
      <DialogFooter actions={<><Button text="Abbrechen" onClick={onClose} />
        <Button intent="primary" text="Speichern" disabled={!name.trim()} onClick={save} /></>} />
    </Dialog>
  );
}
