import { Button, Dialog, DialogBody, DialogFooter, HTMLSelect, HTMLTable, InputGroup, NumericInput, Spinner, Tag } from "@blueprintjs/core";
import NonIdealState from "./NonIdealState";
import { useCallback, useEffect, useState } from "react";
import { api, getToken } from "../api";
import { toastError, toastSuccess } from "../toast";
import MaterialSelect from "./MaterialSelect";

/* Form aus der Bibliothek in eine Auftragsposition übernehmen.

   Die Formenbibliothek war bisher ein Nachschlagewerk: ansehen, DXF
   herunterladen, und dann in der Auftragserfassung die Maße von Hand
   abtippen. Genau dabei entstehen die Zahlendreher, gegen die die Bibliothek
   angelegt wurde. Hier wird stattdessen die gespeicherte Kontur übernommen —
   dieselbe ``shape``, mit der auch ein frischer DXF-Upload weiterläuft, samt
   gemessener Schnittlänge.

   Der Dialog bleibt nach der Übernahme offen: ein Auftrag besteht selten aus
   einer einzigen Form, und Flanschgrößen einer Anlage liegen in der Liste
   nebeneinander. */

export interface LibShape {
  id: number; key: string; label: string; cat: string;
  norm_ref: string; size_label: string;
  od: number; di: number;
  bolt_count: number; bolt_circle: number; bolt_d: number;
  cut_len: number; thk_default: number; mat_default: string;
  tags: string[]; dxf_name: string;
}

interface LibShapeDetail extends LibShape {
  shape: Record<string, unknown> | null;
}

/** Eine Position, wie die Auftragserfassung sie erwartet — ohne laufende Nummer. */
export interface PickedShape {
  /*: Die Hausform, aus der die Position stammt. ``null`` bei DXF/KI/Hand —
     die Kontur allein sagt nicht, ob sie aus der Bibliothek kam. */
  shape_id: number | null;
  label: string;
  mat: string;
  thk: number;
  q: number;
  od: number;
  di: number;
  bn: number;
  bd: number;
  bc: number;
  cut_len: number;
  shape: Record<string, unknown> | null;
}

const CAT: Record<string, { intent: any; label: string }> = {
  norm: { intent: "primary", label: "Norm" },
  dxf: { intent: "success", label: "DXF" },
  frei: { intent: "none", label: "frei" },
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onTake: (line: PickedShape) => void;
  /** Werkstoff, den die Maske sonst vorschlägt. */
  defaultMat: string;
}

export default function ShapePicker({ isOpen, onClose, onTake, defaultMat }: Props) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [rows, setRows] = useState<LibShape[] | null>(null);
  const [sel, setSel] = useState<LibShapeDetail | null>(null);
  const [svg, setSvg] = useState("");
  const [mat, setMat] = useState(defaultMat);
  const [thk, setThk] = useState(2);
  const [qty, setQty] = useState(1);
  const [taken, setTaken] = useState(0);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (cat) p.set("cat", cat);
      setRows(await api<LibShape[]>(`/api/library?${p}`));
    } catch (e: any) { toastError(e.message); setRows([]); }
  }, [q, cat]);

  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [isOpen, load]);

  // Beim Öffnen zurück auf Anfang — ein Dialog, der die Auswahl des letzten
  // Auftrags noch zeigt, übernimmt beim schnellen Klicken die falsche Form.
  useEffect(() => {
    if (isOpen) { setSel(null); setSvg(""); setTaken(0); setMat(defaultMat); }
  }, [isOpen, defaultMat]);

  const choose = async (row: LibShape): Promise<LibShapeDetail | null> => {
    try {
      const detail = await api<LibShapeDetail>(`/api/library/${row.id}`);
      setSel(detail);
      setThk(detail.thk_default || 2);
      if (detail.mat_default) setMat(detail.mat_default);
      return detail;
    } catch (e: any) { toastError(e.message); return null; }
  };

  // Vorschau: der Zeichner sitzt im Backend, damit Liste und Laufkarte
  // dieselbe Kontur zeigen (Library.tsx macht es genauso).
  useEffect(() => {
    if (!sel) { setSvg(""); return; }
    let dead = false;
    fetch(`/api/library/${sel.id}/preview.svg?width=300`, {
      headers: { Authorization: `Bearer ${getToken() ?? ""}` },
    })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("Vorschau nicht ladbar"))))
      .then((t) => { if (!dead) setSvg(t); })
      .catch(() => { if (!dead) setSvg(""); });
    return () => { dead = true; };
  }, [sel?.id]);

  /* Die Form wird ausdrücklich mitgegeben statt aus dem Zustand gelesen: der
     Doppelklick wählt und übernimmt in einem Zug, und ``sel`` trägt in
     diesem Moment noch die vorige Zeile. */
  const add = (s: LibShapeDetail, m: string, t: number, n: number) => {
    onTake({
      shape_id: s.id,
      label: s.label, mat: m, thk: t, q: Math.max(1, n),
      od: s.od, di: s.di, bn: s.bolt_count, bd: s.bolt_d, bc: s.bolt_circle,
      cut_len: s.cut_len, shape: s.shape ?? null,
    });
    setTaken((k) => k + 1);
    toastSuccess(`„${s.label}" als Position übernommen.`);
  };

  const take = () => { if (sel) add(sel, mat, thk, qty); };

  const chooseAndTake = async (row: LibShape) => {
    const detail = await choose(row);
    if (detail) add(detail, detail.mat_default || mat, detail.thk_default || 2, 1);
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title="Form aus der Bibliothek"
            icon="folder-open" style={{ width: 900 }}>
      <DialogBody useOverflowScrollContainer={false}>
        <div className="toolbar">
          <InputGroup leftIcon="search" autoFocus style={{ width: 280 }}
                      placeholder="Bezeichnung, Norm, Größe, Dateiname …"
                      value={q} onChange={(e) => setQ(e.target.value)} />
          <HTMLSelect value={cat} onChange={(e) => setCat(e.currentTarget.value)}>
            <option value="">alle Arten</option>
            <option value="norm">Normteile</option>
            <option value="dxf">DXF-Uploads</option>
            <option value="frei">frei angelegt</option>
          </HTMLSelect>
          <span style={{ flex: 1 }} />
          {taken > 0 && <Tag intent="success" icon="tick">{taken} übernommen</Tag>}
        </div>

        <div className="picker-split">
          <div className="picker-list">
            {!rows ? <Spinner size={30} /> : rows.length === 0 ? (
              <NonIdealState icon="search" title="Keine Form gefunden"
                             description="Andere Schreibweise versuchen — oder die Form unter „Formen“ anlegen." />
            ) : (
              <HTMLTable className="data-table" striped compact interactive>
                <thead>
                  <tr>
                    <th>Bezeichnung</th><th>Art</th><th>Norm / Größe</th>
                    <th className="num">Ø außen</th><th className="num">Ø innen</th>
                    <th>Bohrungen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} onClick={() => choose(s)}
                        onDoubleClick={() => chooseAndTake(s)}
                        className={sel?.id === s.id ? "row-active" : undefined}>
                      <td><b>{s.label}</b><div className="mono sub">{s.key}</div></td>
                      <td><Tag minimal intent={CAT[s.cat]?.intent}>{CAT[s.cat]?.label ?? s.cat}</Tag></td>
                      <td>{s.norm_ref || "—"}{s.size_label && <div className="sub">{s.size_label}</div>}</td>
                      <td className="num mono">{s.od.toFixed(1)}</td>
                      <td className="num mono">{s.di > 0 ? s.di.toFixed(1) : "—"}</td>
                      <td className="sub">
                        {s.bolt_count > 0 ? `${s.bolt_count} × Ø${s.bolt_d}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </HTMLTable>
            )}
          </div>

          <aside className="picker-side">
            {!sel ? (
              <NonIdealState icon="arrow-left" title="Nichts gewählt"
                             description="Eine Zeile anklicken — Zeichnung und Maße erscheinen hier." />
            ) : (
              <>
                {svg
                  ? <div className="part-preview" dangerouslySetInnerHTML={{ __html: svg }} />
                  : <div className="part-preview sub">Keine Vorschau</div>}
                <div className="side-kv" style={{ marginTop: 12 }}>
                  <span>Ø außen</span><b className="mono">{sel.od.toFixed(1)} mm</b>
                  <span>Ø innen</span>
                  <b className="mono">{sel.di > 0 ? `${sel.di.toFixed(1)} mm` : "—"}</b>
                  <span>Bohrungen</span>
                  <b className="mono">
                    {sel.bolt_count > 0
                      ? `${sel.bolt_count} × Ø${sel.bolt_d} / LK ${sel.bolt_circle}`
                      : "—"}
                  </b>
                  <span>Schnittlänge</span>
                  <b className="mono">{(sel.cut_len / 1000).toFixed(3)} m</b>
                </div>

                <label className="picker-field">Werkstoff
                  <MaterialSelect fill value={mat} onChange={setMat} />
                </label>
                <div style={{ display: "flex", gap: 10 }}>
                  <label className="picker-field" style={{ flex: 1 }}>Dicke mm
                    <NumericInput fill value={thk} min={0.2} stepSize={0.5} minorStepSize={0.1}
                                  onValueChange={(v) => setThk(Number.isFinite(v) ? v : 2)} />
                  </label>
                  <label className="picker-field" style={{ flex: 1 }}>Stück
                    <NumericInput fill value={qty} min={1} max={999}
                                  onValueChange={(v) => setQty(Number.isFinite(v) ? Math.round(v) : 1)} />
                  </label>
                </div>
                <Button intent="primary" icon="add" fill onClick={take} disabled={!mat}
                        text="Als Position übernehmen" />
              </>
            )}
          </aside>
        </div>
      </DialogBody>
      <DialogFooter actions={<Button intent="none" onClick={onClose} text="Fertig" />}>
        <span className="sub">Doppelklick auf eine Zeile übernimmt sie sofort.</span>
      </DialogFooter>
    </Dialog>
  );
}
