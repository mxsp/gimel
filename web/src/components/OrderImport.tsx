import { useRef, useState } from "react";
import { Button, Callout, Dialog, DialogBody, DialogFooter, HTMLTable } from "@blueprintjs/core";
import { apiUpload, fmtEur } from "../api";
import { toastError, toastSuccess } from "../toast";
import { plural } from "../plural";

/* Aufträge aus einer CSV-Datei: erst die Prüfung, in der nichts entsteht, dann derselbe
   Upload zum Anlegen. Ganz oder gar nicht: der Server legt alles in einem Zug an. */

interface PlanOrder { no: string; customer: string; positions: number; new_customer: boolean; gross: number; }
interface Plan {
  ok: boolean; rows: number; created: string[];
  errors: { row: number; column: string; message: string }[];
  warnings: { row: number; column?: string; message: string }[];
  orders: PlanOrder[];
}

export default function OrderImport({ onDone }: { onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (f: File) => {
    setFile(f);
    setBusy(true);
    try { setPlan(await apiUpload<Plan>("/api/desk/import/orders", f)); }
    catch (e: any) { setFile(null); toastError(e.message); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };

  const commit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await apiUpload<Plan>("/api/desk/import/orders?commit=true", file);
      toastSuccess(`${plural(r.created.length, "Auftrag", "Aufträge")} angelegt.`);
      setPlan(null); setFile(null);
      onDone();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <input ref={input} type="file" accept=".csv,.txt,text/csv" hidden aria-label="CSV-Datei wählen"
             onChange={(e) => { const f = e.target.files?.[0]; if (f) check(f); }} />
      <Button icon="import" text="CSV importieren" loading={busy && !plan} onClick={() => input.current?.click()} />
      <Dialog isOpen={!!plan} title={`Import prüfen: ${file?.name ?? ""}`} onClose={() => { setPlan(null); setFile(null); }}>
        <DialogBody>
          {plan && <>
            <p>{plural(plan.rows, "Zeile", "Zeilen")} gelesen, {plural(plan.orders.length, "Auftrag", "Aufträge")} erkannt. Noch ist nichts angelegt.</p>
            {plan.errors.length > 0 && (
              <Callout intent="danger" title={plural(plan.errors.length, "Fehler", "Fehler")} style={{ marginBottom: 12 }}>
                <ul>{plan.errors.slice(0, 20).map((e, i) => <li key={i}>Zeile {e.row}{e.column ? `, ${e.column}` : ""}: {e.message}</li>)}</ul>
              </Callout>
            )}
            {plan.warnings.length > 0 && (
              <Callout intent="warning" title="Hinweise" style={{ marginBottom: 12 }}>
                <ul>{plan.warnings.slice(0, 20).map((w, i) => <li key={i}>Zeile {w.row}: {w.message}</li>)}</ul>
              </Callout>
            )}
            {plan.orders.length > 0 && (
              <HTMLTable compact style={{ width: "100%" }}>
                <thead><tr><th>Kunde</th><th className="num">Positionen</th><th className="num">Brutto</th></tr></thead>
                <tbody>{plan.orders.slice(0, 50).map((o, i) => (
                  <tr key={i}>
                    <td>{o.customer}{o.new_customer ? " (neu)" : ""}</td>
                    <td className="num">{o.positions}</td><td className="num">{fmtEur(o.gross)}</td>
                  </tr>))}
                </tbody>
              </HTMLTable>
            )}
          </>}
        </DialogBody>
        <DialogFooter actions={<>
          <Button text="Abbrechen" onClick={() => { setPlan(null); setFile(null); }} />
          <Button intent="primary" text="Anlegen" loading={busy} disabled={!plan?.ok || !plan.orders.length} onClick={commit} />
        </>} />
      </Dialog>
    </>
  );
}
