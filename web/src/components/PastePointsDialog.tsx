import { Button, Dialog, DialogBody, DialogFooter, FormGroup, InputGroup, TextArea } from "@blueprintjs/core";
import { useState } from "react";
import { createFromText, ImportResult } from "../drawingsApi";

const EXAMPLE = "0,0 300,0 300,120 180,120 180,260 0,260\n\n40,40 80,40 80,80 40,80";

/* Punkte einfügen: der erste Block ist die Außenkontur, jeder weitere (nach einer Leerzeile) eine Aussparung. */
export default function PastePointsDialog({ isOpen, onClose, onCreated }: {
  isOpen: boolean; onClose: () => void; onCreated: (r: ImportResult) => void;
}) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
            style={{ width: 520, maxWidth: "calc(100vw - 32px)" }}>
      <DialogBody>
        <FormGroup label="Name" labelFor="paste-name">
          <InputGroup id="paste-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="z. B. Konsole links" />
        </FormGroup>
        <FormGroup label="Punkte in Millimetern" labelFor="paste-text"
                   helperText="Ein Punkt je Paar x,y; Punkt als Dezimaltrenner. Der erste Block ist die Außenkontur, jeder weitere (nach einer Leerzeile) eine Aussparung.">
          <TextArea id="paste-text" fill rows={7} spellCheck={false} value={text} placeholder={EXAMPLE}
                    onChange={(e) => setText(e.target.value)} style={{ fontFamily: "monospace" }} />
        </FormGroup>
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
