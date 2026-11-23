import { Button, Dialog, DialogBody, DialogFooter, FormGroup, InputGroup, TextArea } from "@blueprintjs/core";
import { useState } from "react";
import { createFromText, ImportResult } from "../drawingsApi";

const EXAMPLE = "0,0 300,0 300,120 180,120 180,260 0,260\n\n40,40 80,40 80,80 40,80";

function circlePolygonBlock(cx: number, cy: number, d: number, segments = 24): string {
  const r = d / 2;
  const pts: string[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Number((cx + Math.cos(a) * r).toFixed(2));
    const y = Number((cy + Math.sin(a) * r).toFixed(2));
    pts.push(`${x},${y}`);
  }
  return pts.join(" ");
}

/* Punkte & Bohrungen einfügen: der erste Block ist die Außenkontur, jeder weitere (nach einer Leerzeile) eine Aussparung. */
export default function PastePointsDialog({ isOpen, onClose, onCreated }: {
  isOpen: boolean; onClose: () => void; onCreated: (r: ImportResult) => void;
}) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Einzelne Bohrung (X, Y, Ø in mm)
  const [holeX, setHoleX] = useState(50);
  const [holeY, setHoleY] = useState(50);
  const [holeD, setHoleD] = useState(12);

  // Lochkreis (Anzahl, Ø, LK-Ø, Mittelpunkt X/Y in mm)
  const [lkCount, setLkCount] = useState(4);
  const [lkD, setLkD] = useState(14);
  const [lkBc, setLkBc] = useState(120);
  const [lkCx, setLkCx] = useState(100);
  const [lkCy, setLkCy] = useState(100);

  const appendBlocks = (blocks: string[]) => {
    const valid = blocks.filter(Boolean);
    if (!valid.length) return;
    setText((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed}\n\n${valid.join("\n\n")}` : valid.join("\n\n");
    });
  };

  const addSingleHole = () => {
    if (!(holeD > 0)) return;
    appendBlocks([circlePolygonBlock(holeX, holeY, holeD)]);
  };

  const addBoltCircle = () => {
    if (!(lkCount > 0 && lkD > 0 && lkBc > 0)) return;
    const R = lkBc / 2;
    const blocks: string[] = [];
    for (let i = 0; i < lkCount; i++) {
      const a = (i / lkCount) * Math.PI * 2;
      blocks.push(circlePolygonBlock(lkCx + Math.cos(a) * R, lkCy + Math.sin(a) * R, lkD));
    }
    appendBlocks(blocks);
  };

  const save = async () => {
    setBusy(true); setError("");
    try {
      const r = await createFromText(name, note, text);
      setName(""); setNote(""); setText("");
      onCreated(r); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog isOpen={isOpen} onClose={onClose} title="Punkte einfügen" icon="polygon-filter"
            style={{ width: 580, maxWidth: "calc(100vw - 32px)" }}>
      <DialogBody>
        <FormGroup label="Name" labelFor="paste-name">
          <InputGroup id="paste-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="z. B. Konsole links" />
        </FormGroup>
        <FormGroup label="Punkte in Millimetern" labelFor="paste-text"
                   helperText="Ein Punkt je Paar x,y; Punkt als Dezimaltrenner. Der erste Block ist die Außenkontur, jeder weitere (nach einer Leerzeile) eine Aussparung / Bohrung.">
          <TextArea id="paste-text" fill rows={7} spellCheck={false} value={text} placeholder={EXAMPLE}
                    onChange={(e) => setText(e.target.value)} style={{ fontFamily: "monospace" }} />
        </FormGroup>
        <div className="desk-panel" style={{ marginBottom: 12, padding: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Bohrungen (24-Eck-Kreisblöcke) anfügen</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="sub" style={{ minWidth: 96 }}>Einzelbohrung:</span>
            <label className="sub">X <input className="bp5-input" type="number" step="1" style={{ width: 62 }} value={holeX} title="Bohrung X (mm)" onChange={(e) => setHoleX(Number(e.target.value))} /></label>
            <label className="sub">Y <input className="bp5-input" type="number" step="1" style={{ width: 62 }} value={holeY} title="Bohrung Y (mm)" onChange={(e) => setHoleY(Number(e.target.value))} /></label>
            <label className="sub">Ø <input className="bp5-input" type="number" min="0.5" step="0.5" style={{ width: 62 }} value={holeD} title="Bohrungs-Ø (mm)" onChange={(e) => setHoleD(Number(e.target.value))} /></label>
            <Button small icon="add" text="Bohrung anfügen" onClick={addSingleHole} disabled={!(holeD > 0)} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span className="sub" style={{ minWidth: 96 }}>Lochkreis:</span>
            <label className="sub">Anz. <input className="bp5-input" type="number" min="1" max="200" step="1" style={{ width: 52 }} value={lkCount} title="Anzahl Bohrungen im Lochkreis" onChange={(e) => setLkCount(Math.max(1, Math.round(Number(e.target.value))))} /></label>
            <label className="sub">Ø <input className="bp5-input" type="number" min="0.5" step="0.5" style={{ width: 56 }} value={lkD} title="Bohrungs-Ø im Lochkreis (mm)" onChange={(e) => setLkD(Number(e.target.value))} /></label>
            <label className="sub">LK-Ø <input className="bp5-input" type="number" min="1" step="1" style={{ width: 62 }} value={lkBc} title="Lochkreis-Ø (mm)" onChange={(e) => setLkBc(Number(e.target.value))} /></label>
            <label className="sub">X <input className="bp5-input" type="number" step="1" style={{ width: 58 }} value={lkCx} title="Lochkreis Mittelpunkt X (mm)" onChange={(e) => setLkCx(Number(e.target.value))} /></label>
            <label className="sub">Y <input className="bp5-input" type="number" step="1" style={{ width: 58 }} value={lkCy} title="Lochkreis Mittelpunkt Y (mm)" onChange={(e) => setLkCy(Number(e.target.value))} /></label>
            <Button small icon="add" text="Lochkreis anfügen" onClick={addBoltCircle} disabled={!(lkCount > 0 && lkD > 0 && lkBc > 0)} />
          </div>
        </div>
        <FormGroup label="Notiz (optional)" labelFor="paste-note">
          <InputGroup id="paste-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </FormGroup>
        {error && <p role="alert" className="fn-error">{error}</p>}
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Abbrechen" onClick={onClose} />
        <Button intent="primary" text="Zeichnung anlegen" loading={busy} disabled={!text.trim()} onClick={save} />
      </>} />
    </Dialog>
  );
}
