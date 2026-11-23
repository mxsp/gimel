import { Button, Callout, Checkbox, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect,
         InputGroup, NumericInput, Switch, TextArea } from "@blueprintjs/core";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { PRODUCT_CATS } from "../constants";
import { toastSuccess } from "../toast";

/* Einen Werkstoff anlegen — der fehlende Gegenpart zum Bearbeiten-Dialog in
   Materials.tsx. Die ID ist der Primärschlüssel und lässt sich später nicht
   mehr ändern; deshalb wird sie aus dem Namen vorgeschlagen und erst nach
   einer bewussten Eingabe nicht mehr mitgeführt.

   Angelegt wird nur, was für den ersten Preis gebraucht wird. Dickensätze und
   Feinheiten kommen danach in den Stammdaten des Werkstoffs. */

interface Props {
  isOpen: boolean;
  onClose: (createdId?: string) => void;
}

interface Draft {
  id: string;
  name: string;
  short: string;
  brand: string;
  cat: string;
  colour: string;
  eur_m2: number;
  lead_days: number;
  thicknesses: string;
  sheets: number[][];
  customSheets: string;
  cnc: string;
  grain: string;
  flip_ok: boolean;
  active: boolean;
  kerf: string;
  web: string;
  min_web: string;
  url: string;
  datasheet_url: string;
  blurb: string;
}

const FALLBACK_SHEETS: number[][] = [
  [1000, 1000], [1000, 2000], [1200, 1200], [1500, 1000], [1500, 1500],
  [1500, 2000], [1500, 3000], [2000, 1000], [2000, 1500],
];

const blank = (): Draft => ({
  id: "", name: "", short: "", brand: "", cat: PRODUCT_CATS[0][0], colour: "#888888",
  eur_m2: 0, lead_days: 0, thicknesses: "", sheets: [], customSheets: "",
  cnc: "check", grain: "none", flip_ok: true, active: true,
  kerf: "", web: "", min_web: "", url: "", datasheet_url: "", blurb: "",
});

const fmtSheet = (s: number[]) => `${s[0]} × ${s[1]}`;
const sameSheet = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];

/** Aus dem Namen eine gültige, dauerhafte ID machen („EPDM 70“ → „epdm-70“). */
function slugFrom(name: string): string {
  return name.trim().toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** „1200x800, 1500×3000“ — jede Angabe einzeln prüfen, keine stillen Nullen. */
function parseSheets(text: string): { sheets: number[][]; invalid: string[] } {
  const sheets: number[][] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean)) {
    const m = token.match(/^(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)$/i);
    const w = m ? Number(m[1].replace(",", ".")) : 0;
    const h = m ? Number(m[2].replace(",", ".")) : 0;
    if (!m || !(w > 0) || !(h > 0)) { invalid.push(token); continue; }
    sheets.push([w, h]);
  }
  return { sheets, invalid };
}

function parseThicknesses(text: string): { values: number[]; invalid: string[] } {
  const values: number[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)) {
    const n = Number(token.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) invalid.push(token);
    else values.push(n);
  }
  return { values, invalid };
}

/** Optionale Zahl aus einem Textfeld: leer = null, Unsinn = Fehler. */
function optionalNumber(text: string): { value: number | null; ok: boolean } {
  const t = text.trim().replace(",", ".");
  if (!t) return { value: null, ok: true };
  const n = Number(t);
  return { value: Number.isFinite(n) && n >= 0 ? n : null, ok: Number.isFinite(n) && n >= 0 };
}

export default function NewProductDialog({ isOpen, onClose }: Props) {
  const [form, setForm] = useState<Draft>(blank);
  const [idTouched, setIdTouched] = useState(false);
  const [standardSheets, setStandardSheets] = useState<number[][]>(FALLBACK_SHEETS);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLDivElement | null>(null);

  /* Der Dialoginhalt scrollt; eine Prüfmeldung am Ende des Formulars darf
     nicht unbemerkt über dem sichtbaren Ausschnitt stehen. */
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [error]);

  useEffect(() => {
    if (!isOpen) return;
    setForm(blank());
    setIdTouched(false);
    setError("");
    setBusy(false);
    // Die Standardformate kommen aus derselben Quelle wie die Matrix. Ohne
    // Verbindung bleibt die eingebaute Liste stehen; sie ist nur eine Auswahl.
    let dead = false;
    api<{ standard_sheets?: number[][] }>("/api/products/matrix/view")
      .then((v) => {
        if (!dead && Array.isArray(v.standard_sheets) && v.standard_sheets.length) {
          setStandardSheets(v.standard_sheets);
        }
      })
      .catch(() => { /* Fallback-Liste genügt */ });
    return () => { dead = true; };
  }, [isOpen]);

  const set = (patch: Partial<Draft>) => setForm((f) => ({ ...f, ...patch }));

  const setName = (name: string) =>
    setForm((f) => ({ ...f, name, id: idTouched ? f.id : slugFrom(name) }));

  const setSheets = (next: number[][]) => set({ sheets: next });

  const toggleSheet = (sheet: number[]) =>
    setSheets(form.sheets.some((s) => sameSheet(s, sheet))
      ? form.sheets.filter((s) => !sameSheet(s, sheet))
      : [...form.sheets, sheet]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const id = form.id.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length < 2) {
      setError("Die Werkstoff-ID braucht mindestens zwei Zeichen: Kleinbuchstaben, Ziffern und Bindestriche.");
      return;
    }
    if (!form.name.trim()) { setError("Ein Name ist Pflicht."); return; }
    if (!(form.eur_m2 > 0)) { setError("Der Bezugspreis muss größer als 0 €/m² sein."); return; }

    const thicknesses = parseThicknesses(form.thicknesses);
    if (thicknesses.invalid.length) {
      setError(`Diese Dicken sind keine positiven Zahlen: ${thicknesses.invalid.join(", ")}.`);
      return;
    }
    if (new Set(thicknesses.values).size !== thicknesses.values.length) {
      setError("Jede Dicke nur einmal angeben.");
      return;
    }

    const custom = parseSheets(form.customSheets);
    if (custom.invalid.length) {
      setError(`Diese Formate verstehen wir nicht: ${custom.invalid.join(", ")}. Bitte als „Breite × Höhe“ in mm angeben.`);
      return;
    }
    const sheets = [...form.sheets];
    for (const s of custom.sheets) if (!sheets.some((x) => sameSheet(x, s))) sheets.push(s);
    if (sheets.length === 0) {
      setError("Mindestens ein Plattenformat ist Pflicht — ohne Format ist der Werkstoff nicht kalkulierbar.");
      return;
    }

    const kerf = optionalNumber(form.kerf);
    const web = optionalNumber(form.web);
    const minWeb = optionalNumber(form.min_web);
    if (!kerf.ok || !web.ok || !minWeb.ok) {
      setError("Schnittspalt, Randabstand und Mindeststeg müssen Zahlen in mm sein (nicht negativ, oder leer).");
      return;
    }

    setBusy(true);
    try {
      const created = await api<{ id: string; name: string }>("/api/products", {
        method: "POST",
        body: JSON.stringify({
          id,
          name: form.name.trim(),
          short: form.short.trim(),
          brand: form.brand.trim(),
          cat: form.cat,
          colour: form.colour,
          eur_m2: form.eur_m2,
          lead_days: form.lead_days,
          thicknesses: thicknesses.values,
          sheets,
          cnc: form.cnc,
          grain: form.grain,
          flip_ok: form.flip_ok,
          active: form.active,
          kerf: kerf.value,
          web: web.value,
          min_web: minWeb.value,
          url: form.url.trim(),
          datasheet_url: form.datasheet_url.trim(),
          blurb: form.blurb.trim(),
        }),
      });
      toastSuccess(`„${created.name}“ angelegt.`);
      onClose(created.id);
    } catch (err: any) {
      setError(err?.message ?? "Der Werkstoff konnte nicht angelegt werden.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onClose={() => onClose()} title="Neuer Werkstoff" style={{ width: 820 }}>
      <form onSubmit={submit}>
        <DialogBody>
          <Callout intent="primary" icon="info-sign" style={{ marginBottom: 14 }}>
            Die ID ist der dauerhafte Schlüssel in Aufträgen, Platten und im Lager. Der Preis ist der
            Bezugspreis (2 mm); Dickensätze und Datenblatt lassen sich nach dem Anlegen im
            Bearbeiten-Dialog ergänzen. Ein Preis ohne Quelle zählt zunächst als Richtwert.
          </Callout>

          {error && (
            <div ref={errorRef}>
              <Callout intent="danger" icon="error" style={{ marginBottom: 14 }}>{error}</Callout>
            </div>
          )}

          <div className="form-grid">
            <label>Name *
              <InputGroup value={form.name} autoFocus placeholder="z. B. EPDM 70 Shore"
                          onChange={(e) => setName(e.target.value)} />
            </label>
            <label>Werkstoff-ID *
              <InputGroup value={form.id} placeholder="z. B. epdm-70"
                          intent={form.id && !/^[a-z0-9][a-z0-9-]{1,59}$/.test(form.id) ? "danger" : "none"}
                          onChange={(e) => { setIdTouched(true); set({ id: e.target.value.toLowerCase() }); }} />
              <span className="sub">Kleinbuchstaben, Ziffern, Bindestriche — später nicht änderbar.</span>
            </label>
            <label>Kurzname
              <InputGroup value={form.short} placeholder="z. B. EPDM"
                          onChange={(e) => set({ short: e.target.value })} />
            </label>
            <label>Hersteller
              <InputGroup value={form.brand} onChange={(e) => set({ brand: e.target.value })} />
            </label>
            <label>Gruppe
              <HTMLSelect fill value={form.cat} onChange={(e) => set({ cat: e.currentTarget.value })}>
                {PRODUCT_CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </HTMLSelect>
            </label>
            <label>Farbe
              <InputGroup type="color" value={form.colour} onChange={(e) => set({ colour: e.target.value })} />
            </label>
            <label>Bezugspreis €/m² *
              <NumericInput value={form.eur_m2} min={0.01} stepSize={1} minorStepSize={0.001}
                            buttonPosition="none" fill
                            onValueChange={(v) => Number.isFinite(v) && set({ eur_m2: v })} />
            </label>
            <label>Lieferzeit (Tage)
              <NumericInput value={form.lead_days} min={0} max={365} stepSize={1}
                            buttonPosition="none" fill
                            onValueChange={(v) => Number.isFinite(v) && set({ lead_days: v })} />
            </label>
            <label>Dicken (mm, kommagetrennt)
              <InputGroup value={form.thicknesses} placeholder="z. B. 1, 1.5, 2"
                          onChange={(e) => set({ thicknesses: e.target.value })} />
            </label>
            <label>Schneidbarkeit Plotter
              <HTMLSelect fill value={form.cnc} onChange={(e) => set({ cnc: e.currentTarget.value })}>
                <option value="confirmed">bestätigt</option>
                <option value="likely">wahrscheinlich</option>
                <option value="check">prüfen</option>
              </HTMLSelect>
            </label>
          </div>

          <FormGroup label="Plattenformate *" style={{ marginTop: 16 }}
                     helperText="Was das eigene Regal führen soll — nicht die ganze Marktliste.">
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
              {standardSheets.map((s) => (
                <Checkbox key={fmtSheet(s)} inline checked={form.sheets.some((x) => sameSheet(x, s))}
                          label={fmtSheet(s)} style={{ margin: 0 }}
                          onChange={() => toggleSheet(s)} />
              ))}
            </div>
          </FormGroup>
          <FormGroup label="Weitere Formate (mm, kommagetrennt)">
            <InputGroup value={form.customSheets} placeholder="z. B. 1250×2500, 2000×3000"
                        onChange={(e) => set({ customSheets: e.target.value })} />
          </FormGroup>

          <div className="form-grid">
            <label>Werkstoffrichtung
              <HTMLSelect fill value={form.grain} onChange={(e) => set({ grain: e.currentTarget.value })}>
                <option value="none">keine — frei drehbar</option>
                <option value="axis">Achse — nur 0°/180°</option>
                <option value="directed">gerichtet — nur 0°, nicht spiegeln</option>
              </HTMLSelect>
            </label>
            <Switch checked={form.flip_ok} label="wendbar (Spiegeln erlaubt)"
                    onChange={(e) => set({ flip_ok: e.currentTarget.checked })} />
            <label>Schnittspalt kerf (mm, leer = Satz)
              <InputGroup value={form.kerf} onChange={(e) => set({ kerf: e.target.value })} />
            </label>
            <label>Randabstand web (mm, leer = Satz)
              <InputGroup value={form.web} onChange={(e) => set({ web: e.target.value })} />
            </label>
            <label>Mindeststeg (mm, leer = 10)
              <InputGroup value={form.min_web} onChange={(e) => set({ min_web: e.target.value })} />
            </label>
            <label>Produktseite
              <InputGroup value={form.url} placeholder="https://…" onChange={(e) => set({ url: e.target.value })} />
            </label>
            <label>Datenblatt-URL
              <InputGroup value={form.datasheet_url} placeholder="https://…"
                          onChange={(e) => set({ datasheet_url: e.target.value })} />
            </label>
          </div>

          <FormGroup label="Beschreibung">
            <TextArea fill rows={2} value={form.blurb} onChange={(e) => set({ blurb: e.target.value })} />
          </FormGroup>
          <Switch checked={form.active} label="Aktiv — im Shop und in der Kalkulation"
                  onChange={(e) => set({ active: e.currentTarget.checked })} />
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => onClose()} />
            <Button type="submit" intent="primary" icon="add" text="Anlegen" loading={busy} />
          </>
        } />
      </form>
    </Dialog>
  );
}
