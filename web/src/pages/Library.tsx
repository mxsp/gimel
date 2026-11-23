import { Button, Callout, Dialog, DialogBody, DialogFooter, FileInput, HTMLSelect, HTMLTable, Icon, InputGroup, Menu, MenuItem, NumericInput, Spinner, Tag, TextArea } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import NonIdealState from "../components/NonIdealState";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiDownload, fmtDate, fmtDateTime, getToken } from "../api";
import { navigate } from "../router";
import MaterialSelect from "../components/MaterialSelect";
import { toastError, toastSuccess } from "../toast";
import {
  FilterGroup, FilterPopover, FilterTag, InfoHint, PageFrame, SortControl, Toolbar, sortRows, useSortPref,
} from "../ui";
import type { SortField } from "../ui";

/* Formenbibliothek — das Gegenstück zum Werkstoffkatalog.

   Dort steht, woraus geschnitten wird; hier, was. Drei Herkünfte, eine Liste:
   Normteile aus Zahlen, hochgeladene DXF und frei angelegte Ringe. Die
   hochgeladene Datei bleibt im Original liegen — aus der gelesenen Kontur
   liesse sich zwar jederzeit eine neue schreiben, aber nicht dieselbe. */

interface Shape {
  id: number; key: string; label: string; cat: string;
  norm_ref: string; size_label: string;
  od: number; di: number; bolt_count: number; bolt_circle: number; bolt_d: number;
  cut_len: number; thk_default: number; mat_default: string;
  tags: string[]; note: string;
  dxf_name: string; dxf_size: number; active: boolean; uses: number; created_by: string;
}

/* Wo eine Form steckt — die Gegenrichtung zur Bestellposition. */
interface UsageOrder {
  no: string; kind: string; customer: string; customer_ref: string;
  created_at: string | null; due_date: string | null;
  blocked: boolean; released: boolean;
  n_positions: number; qty: number; status_text: string;
  work_orders: string[];
}
interface UsageWorkOrder {
  no: string; status: string; status_text: string;
  mat: string; mat_name: string; thk: number; machine: string;
  created_at: string | null;
  n_parts: number; n_positions: number; orders: string[];
}
interface Usage {
  shape_id: number; shape_key: string; shape_label: string;
  n_orders: number; n_work_orders: number; n_positions: number; n_pieces: number;
  orders: UsageOrder[]; work_orders: UsageWorkOrder[];
}

const CAT: Record<string, { intent: any; label: string }> = {
  norm: { intent: "primary", label: "Norm" },
  dxf: { intent: "success", label: "DXF" },
  frei: { intent: "none", label: "frei" },
};
const SHAPE_SORT_FIELDS: SortField[] = [
  { id: "label", label: "Bezeichnung" },
  { id: "cat", label: "Art" },
  { id: "od", label: "Ø außen" },
  { id: "di", label: "Ø innen" },
  { id: "cut_len", label: "Schnittlänge" },
  { id: "uses", label: "Verwendet" },
];

const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`);

export default function Library({ id }: { id?: number }) {
  const [rows, setRows] = useState<Shape[] | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [inactive, setInactive] = useState(false);
  const { sort, setSort } = useSortPref("gimel-library-sort", SHAPE_SORT_FIELDS);
  const [selected, setSelected] = useState<number | null>(null);
  const [svg, setSvg] = useState<string>("");
  const [showUpload, setShowUpload] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [note, setNote] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const deepOpened = useRef(0);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (cat) p.set("cat", cat);
      if (inactive) p.set("include_inactive", "true");
      setRows(await api<Shape[]>(`/api/library?${p}`));
    } catch (e: any) { toastError(e.message); }
  }, [q, cat, inactive]);

  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const current = (rows ?? []).find((r) => r.id === selected) ?? null;
  const shown = sortRows(rows ?? [], sort, (s, field) => (s as unknown as Record<string, unknown>)[field]);

  // Vorschau nachladen, sobald eine andere Form gewählt ist.
  useEffect(() => {
    if (!selected) { setSvg(""); return; }
    let dead = false;
    fetch(`/api/library/${selected}/preview.svg`, {
      headers: { Authorization: `Bearer ${getToken() ?? ""}` },
    })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("Vorschau nicht ladbar"))))
      .then((t) => { if (!dead) setSvg(t); })
      .catch(() => { if (!dead) setSvg(""); });
    return () => { dead = true; };
  }, [selected]);

  useEffect(() => { setNote(current?.note ?? ""); }, [current?.id]);

  /* Tiefensprung aus Auftrag oder Innenauftrag: #/formen/12 wählt die Form.
     Fehlt sie in der gefilterten Liste, wird sie einmal nachgeladen — sonst
     käme man aus der Produktion hier an und sähe „nichts gewählt". */
  useEffect(() => {
    if (!id || !rows || deepOpened.current === id) return;
    deepOpened.current = id;
    if (rows.some((r) => r.id === id)) { setSelected(id); return; }
    api<Shape>(`/api/library/${id}`)
      .then((s) => { setRows((rs) => (rs ? [...rs, s] : rs)); setSelected(id); })
      .catch(() => {});
  }, [id, rows]);

  useEffect(() => {
    if (!selected) { setUsage(null); return; }
    let dead = false;
    setUsageLoading(true);
    api<Usage>(`/api/library/${selected}/usage`)
      .then((u) => { if (!dead) setUsage(u); })
      .catch(() => { if (!dead) setUsage(null); })
      .finally(() => { if (!dead) setUsageLoading(false); });
    return () => { dead = true; };
  }, [selected]);

  const grab = async (s: Shape, original: boolean) => {
    try {
      await apiDownload(`/api/library/${s.id}/file.dxf?original=${original}`,
                        original && s.dxf_name ? s.dxf_name : `${s.key}.dxf`);
      toastSuccess("DXF geladen.");
    } catch (e: any) { toastError(e.message); }
  };

  const saveNote = async () => {
    if (!current) return;
    try {
      await api(`/api/library/${current.id}`, { method: "PATCH", body: JSON.stringify({ note }) });
      toastSuccess("Notiz gespeichert."); load();
    } catch (e: any) { toastError(e.message); }
  };

  const deactivate = async (s: Shape) => {
    try {
      await api(`/api/library/${s.id}`, { method: "DELETE" });
      toastSuccess(`„${s.label}" stillgelegt.`); load();
    } catch (e: any) { toastError(e.message); }
  };

  return (
    <PageFrame title="Formen" sub="Normteile und abgelegte DXF — was geschnitten wird, dauerhaft auffindbar.">
      <div className="split-view">
        <div className="split-main">
          <Toolbar end={<>
            <Button intent="primary" icon="upload" text="DXF ablegen" onClick={() => setShowUpload(true)} />
            <Button icon="add" text="Normteil anlegen" onClick={() => setShowNew(true)} />
          </>}>
            <InputGroup leftIcon="search" placeholder="Bezeichnung, Norm, Dateiname…" value={q}
                        onChange={(e) => setQ(e.target.value)} style={{ width: 260, maxWidth: "100%" }} />
            <FilterPopover active={(cat ? 1 : 0) + (inactive ? 1 : 0)}
                           onClear={() => { setCat(""); setInactive(false); }}>
              <FilterGroup label="Art">
                <HTMLSelect value={cat} aria-label="Art der Form" onChange={(e) => setCat(e.currentTarget.value)}>
                  <option value="">alle Arten</option>
                  <option value="norm">Normteile</option>
                  <option value="dxf">DXF-Uploads</option>
                  <option value="frei">frei angelegt</option>
                </HTMLSelect>
              </FilterGroup>
              <Button minimal active={inactive} icon="eye-off" text="stillgelegte"
                      onClick={() => setInactive((v) => !v)} />
            </FilterPopover>
            {cat && <FilterTag label={cat === "norm" ? "Normteile" : cat === "dxf" ? "DXF-Uploads" : "frei angelegt"}
                               onRemove={() => setCat("")} />}
            {inactive && <FilterTag label="stillgelegte zeigen" onRemove={() => setInactive(false)} />}
            <SortControl state={sort} fields={SHAPE_SORT_FIELDS} onChange={setSort} />
            <InfoHint label="Hinweis zur Herkunft" title="Herkunft" text="Normteile aus Maßen, hochgeladene DXF und frei angelegte Ringe. Die hochgeladene Datei bleibt im Original erhalten." />
          </Toolbar>

          {!rows ? <Spinner size={30} /> : shown.length === 0 ? (
            <NonIdealState icon="folder-open" title="Noch keine Formen"
                           description="Eine DXF ablegen oder ein Normteil aus Maßen anlegen." />
          ) : (
            <div className="table-scroll">
            <HTMLTable className="data-table" striped compact interactive tabIndex={0} aria-label="Formen">
              <thead>
                <tr>
                  <th>Bezeichnung</th><th>Art</th><th>Norm / Größe</th>
                  <th className="num">Ø außen</th><th className="num">Ø innen</th>
                  <th>Bohrungen</th><th className="num">Schnittlänge</th><th className="num">Verwendet</th><th>Datei</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id} onClick={() => setSelected(s.id)}
                      className={[selected === s.id ? "row-active" : "", s.active ? "" : "row-muted"]
                                   .filter(Boolean).join(" ") || undefined}>
                    <td>
                      <b>{s.label}</b>
                      <div className="mono sub">{s.key}</div>
                    </td>
                    <td><Tag minimal intent={CAT[s.cat]?.intent}>{CAT[s.cat]?.label ?? s.cat}</Tag></td>
                    <td>{s.norm_ref || "—"}{s.size_label && <div className="sub">{s.size_label}</div>}</td>
                    <td className="num mono">{s.od.toFixed(1)}</td>
                    <td className="num mono">{s.di > 0 ? s.di.toFixed(1) : "—"}</td>
                    <td className="sub">
                      {s.bolt_count > 0 ? `${s.bolt_count} × Ø${s.bolt_d} auf LK ${s.bolt_circle}` : "—"}
                    </td>
                    <td className="num mono">{(s.cut_len / 1000).toFixed(3)} m</td>
                    <td className="num mono">{s.uses || "—"}</td>
                    <td className="sub">{s.dxf_name ? `${s.dxf_name} · ${kb(s.dxf_size)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </HTMLTable>
            </div>
          )}
        </div>

        <aside className="side-frame">
          {!current ? (
            <div className="side-empty">
              <NonIdealState icon="arrow-left" title="Nichts gewählt"
                             description="Eine Zeile anklicken — Zeichnung, Maße und Datei erscheinen hier." />
            </div>
          ) : (
            <>
              <div className="side-head">
                <div className="side-kicker">
                  {CAT[current.cat]?.label ?? current.cat}
                  {!current.active && " · stillgelegt"}
                </div>
                <h2>{current.label}</h2>
                <div className="mono sub">{current.key}</div>
              </div>
              <div className="side-body">
                {svg
                  ? <div className="part-preview" dangerouslySetInnerHTML={{ __html: svg }} />
                  : <div className="part-preview sub">Keine Vorschau</div>}

                <div className="side-kv" style={{ marginTop: 14 }}>
                  <span>Ø außen</span><b className="mono">{current.od.toFixed(1)} mm</b>
                  <span>Ø innen</span><b className="mono">{current.di > 0 ? `${current.di.toFixed(1)} mm` : "—"}</b>
                  <span>Bohrungen</span>
                  <b className="mono">
                    {current.bolt_count > 0
                      ? `${current.bolt_count} × Ø${current.bolt_d} / LK ${current.bolt_circle}`
                      : "—"}
                  </b>
                  <span>Schnittlänge</span><b className="mono">{(current.cut_len / 1000).toFixed(3)} m</b>
                  <span>Dicke (Vorgabe)</span><b className="mono">{current.thk_default} mm</b>
                  <span>Werkstoff</span><b className="mono">{current.mat_default || "—"}</b>
                  {current.norm_ref && (<><span>Norm</span><b>{current.norm_ref}</b></>)}
                  {current.size_label && (<><span>Größe</span><b>{current.size_label}</b></>)}
                  <span>Angelegt von</span><b className="sub">{current.created_by || "—"}</b>
                </div>

                {current.tags?.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    {current.tags.map((t) => <Tag key={t} minimal style={{ marginRight: 4 }}>{t}</Tag>)}
                  </div>
                )}

                <h3>Datei</h3>
                {current.dxf_name ? (
                  <>
                    <p className="sub">{current.dxf_name} · {kb(current.dxf_size)}</p>
                    <KeyPopover placement="bottom-start" content={
                      <Menu>
                        <MenuItem icon="download" text="Original herunterladen" onClick={() => grab(current, true)} />
                        <MenuItem icon="download" text="Neu geschriebene Fassung" onClick={() => grab(current, false)} />
                      </Menu>
                    }>
                      <Button fill icon="download" intent="primary" text="Herunterladen" />
                    </KeyPopover>
                    <InfoHint label="Hinweis zur DXF-Fassung" title="Original oder neu geschrieben" text="Das Original trägt Layer und Angaben, die der Leser nicht auswertet. Die neu geschriebene Fassung ist die, die an der Maschine ankäme." />
                  </>
                ) : (
                  <>
                    <p className="sub">Kein Upload — aus Maßen angelegt.</p>
                    <Button fill icon="download" intent="primary" text="Als DXF herunterladen"
                            onClick={() => grab(current, false)} />
                  </>
                )}

                <h3 style={{ marginTop: 20 }}>Verwendung</h3>
                {usageLoading ? <Spinner size={18} /> : !usage || (usage.n_orders === 0 && usage.n_work_orders === 0) ? (
                  <p className="sub">Noch in keinem Auftrag verwendet.</p>
                ) : (
                  <>
                    <div className="side-kv" style={{ marginBottom: 12 }}>
                      <span>Aufträge</span><b className="mono">{usage.n_orders}</b>
                      <span>Innenaufträge</span><b className="mono">{usage.n_work_orders}</b>
                      <span>Positionen</span><b className="mono">{usage.n_positions}</b>
                      <span>Stück</span><b className="mono">{usage.n_pieces}</b>
                    </div>

                    {usage.orders.length > 0 && (
                      <>
                        <h4>Aufträge</h4>
                        <div className="xref-list">
                          {usage.orders.map((o) => (
                            <button key={o.no} type="button" className="xref-row"
                                    title={`${o.no} in der Auftragsliste öffnen`}
                                    onClick={() => navigate(`auftraege/${o.no}`)}>
                              <span className="mono">{o.no}</span>
                              <span>{o.customer || (o.kind === "internal" ? "Intern" : "—")}
                                <span className="sub"> · {o.status_text} · {o.qty} Stück · {fmtDate(o.created_at)}</span>
                              </span>
                              <Icon icon="chevron-right" size={12} />
                            </button>
                          ))}
                        </div>
                      </>
                    )}

                    {usage.work_orders.length > 0 && (
                      <>
                        <h4>Innenaufträge</h4>
                        <div className="xref-list">
                          {usage.work_orders.map((w) => (
                            <button key={w.no} type="button" className="xref-row"
                                    title={`${w.no} in der Produktion öffnen`}
                                    onClick={() => navigate(`produktion/${w.no}`)}>
                              <span className="mono">{w.no}</span>
                              <span>{w.status_text}
                                <span className="sub"> · {w.n_parts} Teile · {w.orders.join(", ")}</span>
                              </span>
                              <Icon icon="chevron-right" size={12} />
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}

                <h3 style={{ marginTop: 20 }}>Notiz</h3>
                <TextArea fill rows={3} value={note} aria-label="Notiz" onChange={(e) => setNote(e.target.value)} />
                <Button small style={{ marginTop: 6 }} icon="floppy-disk" text="Notiz speichern"
                        disabled={note === (current.note ?? "")} onClick={saveNote} />

                {current.active && (
                  <Button fill minimal intent="danger" icon="disable" style={{ marginTop: 20 }}
                          text="Stilllegen" onClick={() => deactivate(current)} />
                )}
              </div>
            </>
          )}
        </aside>
      </div>

      <UploadDialog isOpen={showUpload} onClose={() => setShowUpload(false)}
                    onDone={(id) => { setShowUpload(false); load(); setSelected(id); }} />
      <NewShapeDialog isOpen={showNew} onClose={() => setShowNew(false)}
                      onDone={(id) => { setShowNew(false); load(); setSelected(id); }} />
    </PageFrame>
  );
}

// --------------------------------------------------------------------------
function UploadDialog({ isOpen, onClose, onDone }:
                      { isOpen: boolean; onClose: () => void; onDone: (id: number) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [mat, setMat] = useState("");
  const [thk, setThk] = useState(2);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const send = async () => {
    if (!file) { toastError("Bitte eine DXF-Datei wählen."); return; }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const p = new URLSearchParams({ thk_default: String(thk) });
      if (label.trim()) p.set("label", label.trim());
      if (mat) p.set("mat_default", mat);
      const resp = await fetch(`/api/library/upload?${p}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken() ?? ""}` },
        body: form,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.detail ?? `Fehler ${resp.status}`);
      toastSuccess(`„${data.label}" abgelegt — Ø ${data.od} mm.`);
      setFile(null); setLabel("");
      onDone(data.id);
    } catch (e: any) { toastError(String(e.message ?? e)); } finally { setBusy(false); }
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title="DXF dauerhaft ablegen" style={{ width: 520 }}>
      <DialogBody>
        <Callout intent="primary" icon="info-sign" style={{ marginBottom: 14 }}>
          Gelesen werden ASCII-DXF bis 4 MB (CIRCLE, ARC, LINE, LWPOLYLINE, POLYLINE,
          ELLIPSE, SPLINE). Die Datei bleibt im Original erhalten; die Kontur wird
          zusätzlich ausgewertet, damit ohne erneutes Einlesen gerechnet werden kann.
        </Callout>
        <FileInput fill text={file?.name ?? "Datei wählen…"} buttonText="Durchsuchen"
                   inputProps={{ accept: ".dxf,.txt", ref: inputRef as any }}
                   onInputChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
        <div className="form-grid" style={{ marginTop: 14 }}>
          <label>Bezeichnung (leer = Dateiname)
            <InputGroup value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>Dicke (Vorgabe, mm)
            <NumericInput fill value={thk} min={0.1} stepSize={0.5}
                          onValueChange={(v) => Number.isFinite(v) && setThk(v)} />
          </label>
          <label style={{ gridColumn: "1 / -1" }}>Werkstoff (Vorgabe)
            <MaterialSelect fill value={mat} onChange={setMat} placeholder="— keiner —" />
          </label>
        </div>
      </DialogBody>
      <DialogFooter actions={
        <>
          <Button text="Abbrechen" onClick={onClose} />
          <Button intent="primary" icon="upload" text="Ablegen" loading={busy} onClick={send} />
        </>} />
    </Dialog>
  );
}

// --------------------------------------------------------------------------
function NewShapeDialog({ isOpen, onClose, onDone }:
                        { isOpen: boolean; onClose: () => void; onDone: (id: number) => void }) {
  const empty = {
    label: "", cat: "norm", norm_ref: "", size_label: "",
    od: 162, di: 115, bolt_count: 0, bolt_circle: 0, bolt_d: 0,
    thk_default: 2, mat_default: "", note: "",
  };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof empty, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  const send = async () => {
    if (!form.label.trim()) { toastError("Eine Bezeichnung ist Pflicht."); return; }
    if (form.di >= form.od) { toastError("Der Innendurchmesser muss kleiner sein als der äußere."); return; }
    setBusy(true);
    try {
      const r = await api<Shape>("/api/library", { method: "POST", body: JSON.stringify(form) });
      toastSuccess(`„${r.label}" angelegt — Schnittlänge ${(r.cut_len / 1000).toFixed(3)} m.`);
      setForm(empty);
      onDone(r.id);
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title="Form aus Maßen anlegen" style={{ width: 560 }}>
      <DialogBody>
        <div className="form-grid">
          <label style={{ gridColumn: "1 / -1" }}>Bezeichnung
            <InputGroup value={form.label} onChange={(e) => set("label", e.target.value)}
                        placeholder="z. B. Flachdichtung EN 1514-1 IBC" />
          </label>
          <label>Art
            <HTMLSelect fill value={form.cat} onChange={(e) => set("cat", e.currentTarget.value)}>
              <option value="norm">Normteil</option>
              <option value="frei">frei angelegt</option>
            </HTMLSelect>
          </label>
          <label>Norm
            <InputGroup value={form.norm_ref} onChange={(e) => set("norm_ref", e.target.value)}
                        placeholder="EN 1514-1 Form IBC" />
          </label>
          <label>Größe
            <InputGroup value={form.size_label} onChange={(e) => set("size_label", e.target.value)}
                        placeholder="DN 100 PN 16" />
          </label>
          <label>Dicke (Vorgabe, mm)
            <NumericInput fill value={form.thk_default} min={0.1} stepSize={0.5}
                          onValueChange={(v) => Number.isFinite(v) && set("thk_default", v)} />
          </label>
          <label>Ø außen (mm)
            <NumericInput fill value={form.od} min={1} stepSize={1}
                          onValueChange={(v) => Number.isFinite(v) && set("od", v)} />
          </label>
          <label>Ø innen (mm)
            <NumericInput fill value={form.di} min={0} stepSize={1}
                          onValueChange={(v) => Number.isFinite(v) && set("di", v)} />
          </label>
          <label>Schraubenlöcher (Anzahl)
            <NumericInput fill value={form.bolt_count} min={0} max={200} stepSize={1}
                          onValueChange={(v) => Number.isFinite(v) && set("bolt_count", v)} />
          </label>
          <label>Lochkreis Ø (mm)
            <NumericInput fill value={form.bolt_circle} min={0} stepSize={1}
                          onValueChange={(v) => Number.isFinite(v) && set("bolt_circle", v)} />
          </label>
          <label>Loch Ø (mm)
            <NumericInput fill value={form.bolt_d} min={0} stepSize={0.5}
                          onValueChange={(v) => Number.isFinite(v) && set("bolt_d", v)} />
          </label>
        </div>
      </DialogBody>
      <DialogFooter actions={
        <>
          <Button text="Abbrechen" onClick={onClose} />
          <Button intent="primary" icon="add" text="Anlegen" loading={busy} onClick={send} />
        </>} />
    </Dialog>
  );
}
