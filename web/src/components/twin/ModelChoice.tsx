import { useRef, useState } from "react";
import { Button, Checkbox, HTMLSelect, Radio, RadioGroup } from "@blueprintjs/core";
import { MODEL_KINDS } from "../../factory";

/* Wie sieht die Station in 3D aus — und arbeitet jemand dort?

   Drei Wege, jederzeit änderbar:
   - Vorhandenes Modell: eines der eingebauten Geräte, oder „passend zum Typ“.
   - Eigenes hochladen: GLB, OBJ oder STL. Bei einer noch nicht gespeicherten
     Station merkt sich der Dialog die Datei und lädt sie beim Anlegen hoch.
   - Nur ein Quader: ein Platzhalter in der Stationsfarbe.
   Dazu der Haken „Mitarbeiter“: die 3D-Ansicht stellt dann eine Figur an die
   Station. Das ist Planung, keine Ortung. */

export type ModelMode = "builtin" | "upload" | "box";

export interface ModelChoiceValue {
  model_kind: string;
  model_file: string;
  staffed: boolean;
}

export default function ModelChoice({
  value, pendingFile, busy = false, idPrefix = "model",
  onKind, onFile, onDropFile, onStaffed,
}: {
  value: ModelChoiceValue;
  /** Eine gewählte, noch nicht hochgeladene Datei (Station ist noch neu). */
  pendingFile: File | null;
  busy?: boolean;
  idPrefix?: string;
  /** Eingebaut oder Quader gewählt: ``""`` = automatisch, ``box`` oder eine Art. */
  onKind: (kind: string) => void;
  onFile: (file: File) => void;
  /** Datei oder Vorgemerktes wieder loslassen (zurück zu eingebaut / Quader). */
  onDropFile: () => void;
  onStaffed: (on: boolean) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const hasFile = !!value.model_file || !!pendingFile;
  const [intentUpload, setIntentUpload] = useState(false);
  const mode: ModelMode = hasFile || intentUpload ? "upload" : value.model_kind === "box" ? "box" : "builtin";
  const builtinKind = value.model_kind === "box" ? "" : value.model_kind;

  const choose = (m: ModelMode) => {
    if (m === mode) return;
    if (m === "upload") {
      setIntentUpload(true);
      input.current?.click();
      return;
    }
    setIntentUpload(false);
    if (hasFile) onDropFile();
    onKind(m === "box" ? "box" : builtinKind);
  };

  return (
    <div className="model-choice">
      <RadioGroup
        selectedValue={mode}
        onChange={(e) => choose((e.currentTarget as HTMLInputElement).value as ModelMode)}
        aria-label="3D-Darstellung">
        <Radio value="builtin" label="Vorhandenes Modell" id={`${idPrefix}-builtin`} />
        {mode === "builtin" && (
          <div className="model-choice-sub">
            <HTMLSelect aria-label="Eingebautes Modell" fill value={builtinKind}
              onChange={(e) => onKind(e.currentTarget.value)}>
              <option value="">Passend zum Typ (automatisch)</option>
              {MODEL_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label} — {k.hint}</option>)}
            </HTMLSelect>
          </div>
        )}
        <Radio value="upload" label="Eigenes Modell hochladen (GLB, OBJ, STL)" id={`${idPrefix}-upload`} />
        {mode === "upload" && (
          <div className="model-choice-sub">
            <Button small icon={hasFile ? "refresh" : "upload"} loading={busy}
              text={hasFile ? "Andere Datei wählen" : "Datei wählen"} onClick={() => input.current?.click()} />
            {pendingFile && (
              <span className="sub mono station-model-name" title={pendingFile.name}>
                {pendingFile.name} — wird beim Anlegen hochgeladen
              </span>
            )}
            {value.model_file && !pendingFile && (
              <span className="sub mono station-model-name" title={value.model_file}>{value.model_file}</span>
            )}
          </div>
        )}
        <Radio value="box" label="Nur ein Quader — vorläufig" id={`${idPrefix}-box`} />
      </RadioGroup>
      {/* Immer da: der Radioknopf „Hochladen“ öffnet die Dateiwahl, noch bevor sein Zweig aufgeht. */}
      <input ref={input} type="file" accept=".glb,.obj,.stl,model/gltf-binary,model/obj,model/stl"
        className="station-model-input" aria-label="Modelldatei"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) onFile(file);
        }} />
      <p className="sub">Das lässt sich später jederzeit ändern.</p>
      <Checkbox checked={value.staffed} label="Mitarbeiter am Arbeitsplatz"
        onChange={(e) => onStaffed((e.target as HTMLInputElement).checked)} />
      <p className="sub">3D zeigt eine Figur an der Station — Planung, keine Ortung.</p>
    </div>
  );
}
