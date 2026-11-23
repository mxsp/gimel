import {
  Button, Callout, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, InputGroup, NumericInput,
} from "@blueprintjs/core";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { plural } from "../plural";
import { toastError, toastSuccess } from "../toast";
import type { HallInfo, LevelInfo } from "../sites";

/* Eine Ebene anlegen — mit Name, Höhe und optional kopiertem Umriss.

   Der schnelle Weg (OG/UG) bleibt daneben; dieses Fenster ist für den Fall,
   dass ein Geschoss einen eigenen Namen, eine andere lichte Höhe oder einen
   Umriss von einer anderen Ebene bekommen soll. */

interface Props {
  isOpen: boolean;
  hall: HallInfo | null;
  floors: LevelInfo[];
  onClose: () => void;
  onCreated: (floorId: number) => void;
  /** Nach dem Löschen: die Eltern laden den Baum neu und wählen eine gültige Ebene. */
  onDeleted?: (floorId: number) => void;
}

const levelName = (n: number) => n === 0 ? "EG" : n > 0 ? `${n}. OG` : `${-n}. UG`;

export default function LevelDialog({ isOpen, hall, floors, onClose, onCreated, onDeleted }: Props) {
  const [name, setName] = useState("");
  const [level, setLevel] = useState(1);
  const [elevation, setElevation] = useState(6);
  const [height, setHeight] = useState(6);
  const [copyFrom, setCopyFrom] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const top = useMemo(
    () => [...floors].sort((a, b) => b.level - a.level)[0],
    [floors],
  );
  const ground = useMemo(
    () => floors.find((f) => f.level === 0) ?? floors[0],
    [floors],
  );

  useEffect(() => {
    if (!isOpen) return;
    const next = Math.max(-1, ...floors.map((f) => f.level)) + 1;
    setLevel(next);
    setHeight(ground?.height_m || 6);
    setElevation(top ? (top.elevation_m || 0) + (top.height_m || 6) : next * 6);
    setCopyFrom(ground?.id ?? "");
    setName("");
    setError("");
  }, [isOpen, floors, ground, top]);

  const submit = async () => {
    if (!hall) return;
    if (floors.some((f) => f.level === level)) {
      setError(`Die Ebene ${level} gibt es in ${hall.name} schon.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await api<{ id: number }>("/api/factory/floors", {
        method: "POST",
        body: JSON.stringify({
          hall_id: hall.id,
          level,
          level_name: name.trim(),
          elevation_m: elevation,
          height_m: height,
          copy_outline_from: copyFrom === "" ? null : Number(copyFrom),
        }),
      });
      toastSuccess(`${name.trim() || levelName(level)} in ${hall.name} angelegt.`);
      onCreated(created.id);
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toastError(msg);
    } finally {
      setBusy(false);
    }
  };

  const drop = async (f: LevelInfo) => {
    if (!hall || f.default || f.stations > 0) return;
    const name = f.level_name || levelName(f.level);
    if (!window.confirm(`Ebene ${name} in ${hall.name} löschen? Grundriss, Zonen und Gänge dieser Ebene gehen verloren.`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/factory/floors/${f.id}`, { method: "DELETE" });
      toastSuccess(`${name} in ${hall.name} gelöscht.`);
      onDeleted?.(f.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toastError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onClose={() => !busy && onClose()}
            title="Ebenen" icon="layers" style={{ width: 520, maxWidth: "calc(100vw - 32px)" }}>
      <DialogBody>
        <Callout compact intent="primary" icon="info-sign" className="mb">
          Ein neues Geschoss bekommt seinen eigenen Grundriss. Der Umriss lässt sich vom EG
          übernehmen; Stationen und Wege bleiben in ihrer bisherigen Ebene.
        </Callout>
        <div className="level-form-grid">
          <FormGroup label="Name" labelFor="level-name" helperText={`Leer = ${levelName(level)}`}>
            <InputGroup id="level-name" value={name} placeholder={levelName(level)}
              onChange={(e) => setName(e.currentTarget.value)} />
          </FormGroup>
          <FormGroup label="Ebene" labelFor="level-number" helperText="0 = EG, 1 = 1. OG, -1 = UG">
            <NumericInput id="level-number" fill value={level} min={-5} max={50} stepSize={1}
              onValueChange={(v) => setLevel(Math.round(v ?? 0))} />
          </FormGroup>
          <FormGroup label="Fußbodenhöhe (m)" labelFor="level-elevation"
                     helperText="Über dem EG; nur für Darstellung und 3D.">
            <NumericInput id="level-elevation" fill value={elevation} stepSize={0.5} minorStepSize={0.1}
              onValueChange={(v) => setElevation(v ?? 0)} />
          </FormGroup>
          <FormGroup label="Lichte Höhe (m)" labelFor="level-height">
            <NumericInput id="level-height" fill value={height} min={1} max={60} stepSize={0.5}
              onValueChange={(v) => setHeight(v ?? 6)} />
          </FormGroup>
        </div>
        <FormGroup label="Umriss übernehmen von" labelFor="level-copy"
                   helperText="Nur der Umriss, keine Stationen, Zonen oder Gänge.">
          <HTMLSelect id="level-copy" fill value={copyFrom === "" ? "" : String(copyFrom)}
            onChange={(e) => setCopyFrom(e.currentTarget.value === "" ? "" : Number(e.currentTarget.value))}>
            <option value="">keinen — leer zeichnen</option>
            {floors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.level_name || levelName(f.level)} · {plural(f.stations, "Station", "Stationen")}
              </option>
            ))}
          </HTMLSelect>
        </FormGroup>
        <div className="level-manage">
          <h4>Vorhandene Ebenen</h4>
          {[...floors].sort((a, b) => b.level - a.level).map((f) => (
            <div key={f.id} className="level-row">
              <div className="level-row-info">
                <b>{f.level_name || levelName(f.level)}</b>
                <span>
                  {f.name ? `${f.name} · ` : ""}
                  {plural(f.stations, "Station", "Stationen")}
                  {f.elevation_m ? ` · ${f.elevation_m.toLocaleString("de-DE")} m` : ""}
                </span>
              </div>
              <Button small minimal icon="trash" intent="danger"
                aria-label={`Ebene ${f.level_name || levelName(f.level)} löschen`}
                disabled={busy || f.default || f.stations > 0}
                title={f.default
                  ? "Die erste Ebene bleibt — dort stehen alle Stationen ohne Ebene."
                  : f.stations > 0
                    ? "Auf der Ebene stehen noch Stationen."
                    : "Ebene löschen"}
                onClick={() => void drop(f)} />
            </div>
          ))}
        </div>
        {error && <Callout compact intent="danger" icon="error">{error}</Callout>}
      </DialogBody>
      <DialogFooter actions={
        <>
          <Button text="Abbrechen" disabled={busy} onClick={onClose} />
          <Button intent="primary" icon="add" text="Ebene anlegen" loading={busy} onClick={submit} />
        </>
      } />
    </Dialog>
  );
}
