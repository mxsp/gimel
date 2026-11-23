import { useEffect, useState } from "react";
import { Button, Checkbox, Dialog, FormGroup, InputGroup, Spinner, TextArea } from "@blueprintjs/core";
import { api } from "../api";
import { toastError, toastSuccess } from "../toast";
import { undoable } from "../undo";
import Callout from "./Callout";

/* Anhalten, Stornieren, Ändern eines Auftrags (Aufgabe 45) — ein Dialog für die
   drei Büro-Schritte, damit Auftragsliste und Schublade dieselben Fragen
   stellen. Fortsetzen braucht keine Frage und läuft über `resumeOrder`.

   Der Dialog holt den Stand selbst (`rev`, Termin, Notiz): wer ihn öffnet,
   schreibt gegen den Stand, den er sieht. Hat inzwischen jemand anders
   geändert, lehnt der Server mit 409 ab statt zu überschreiben. */

export type LifecycleMode = "hold" | "cancel" | "change";

interface DeskOrder {
  no: string; rev: number;
  due_date: string | null; rush: boolean; customer_ref: string; office_note: string;
  held_at: string | null; hold_reason: string; cancelled_at: string | null;
}
interface CancelCheck { can_cancel: boolean; blockers: string[]; rev: number }

const post = (path: string, body: unknown) =>
  api(path, { method: "POST", body: JSON.stringify(body) });

/** Fortsetzen ohne Rückfrage; die Meldung bietet „Rückgängig" (hält wieder an). */
export function resumeOrder(no: string, reason: string, after: () => void): Promise<void> {
  return undoable({
    run: () => post(`/api/desk/orders/${no}/resume`, {}),
    undo: () => post(`/api/desk/orders/${no}/hold`, { reason: reason || "Erneut angehalten" }),
    done: `${no} läuft weiter.`,
    undone: `${no} ist wieder angehalten.`,
    after,
  });
}

const TITLES: Record<LifecycleMode, string> = {
  hold: "Auftrag anhalten",
  cancel: "Auftrag stornieren",
  change: "Auftrag ändern",
};

export default function OrderLifecycleDialog({ no, mode, onClose, onDone, portalContainer }: {
  no: string | null;
  mode: LifecycleMode | null;
  onClose: () => void;
  onDone: () => void;
  portalContainer?: HTMLElement;
}) {
  const [order, setOrder] = useState<DeskOrder | null>(null);
  const [check, setCheck] = useState<CancelCheck | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [due, setDue] = useState("");
  const [rush, setRush] = useState(false);
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!no || !mode) return;
    let stale = false;
    setOrder(null); setCheck(null); setError(""); setReason(""); setBusy(false);
    (async () => {
      try {
        const o = await api<DeskOrder>(`/api/desk/orders/${no}`);
        const c = mode === "cancel" ? await api<CancelCheck>(`/api/desk/orders/${no}/cancel-check`) : null;
        if (stale) return;
        setOrder(o); setCheck(c);
        setDue((o.due_date ?? "").slice(0, 10)); setRush(o.rush);
        setRef(o.customer_ref ?? ""); setNote(o.office_note ?? "");
      } catch (e: any) {
        if (!stale) setError(e.message ?? String(e));
      }
    })();
    return () => { stale = true; };
  }, [no, mode]);

  const reasonOk = reason.trim().length >= 3;
  const blocked = mode === "cancel" && check !== null && !check.can_cancel;
  const canSubmit = !!order && !busy && !blocked && (mode === "change" || reasonOk);

  const submit = async () => {
    if (!order || !mode || !canSubmit) return;
    setBusy(true);
    try {
      if (mode === "hold") {
        await post(`/api/desk/orders/${order.no}/hold`, { reason: reason.trim(), rev: order.rev });
        toastSuccess(`${order.no} ist angehalten.`);
      } else if (mode === "cancel") {
        await post(`/api/desk/orders/${order.no}/cancel`, { reason: reason.trim(), rev: order.rev });
        toastSuccess(`${order.no} ist storniert.`);
      } else {
        // Nur was wirklich angefasst wurde: ein unberührter Termin behält seine
        // Uhrzeit, und das Protokoll nennt keine Änderung, die keine war.
        const body: Record<string, unknown> = { rev: order.rev };
        if (due !== (order.due_date ?? "").slice(0, 10)) body.due_date = due ? `${due}T00:00:00Z` : null;
        if (rush !== order.rush) body.rush = rush;
        if (ref.trim() !== (order.customer_ref ?? "")) body.customer_ref = ref;
        if (note.trim() !== (order.office_note ?? "")) body.office_note = note;
        if (Object.keys(body).length === 1) { onClose(); return; }
        await api(`/api/desk/orders/${order.no}`, { method: "PATCH", body: JSON.stringify(body) });
        toastSuccess(`${order.no} geändert.`);
      }
      onDone();
      onClose();
    } catch (e: any) {
      toastError(e.message ?? String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen={!!no && !!mode} onClose={onClose} portalContainer={portalContainer}
            shouldReturnFocusOnClose={false}
            title={mode ? TITLES[mode] : ""}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="bp5-dialog-body">
          {error ? <Callout intent="danger" icon="error">{error}</Callout>
            : !order ? <Spinner size={24} aria-label="Auftrag wird geladen" />
            : mode === "hold" ? (
              <>
                <p>
                  <b className="mono">{order.no}</b> wird angehalten: der Sammellauf lässt ihn liegen, bis er
                  fortgesetzt wird. Freigabe und Zahlung bleiben, wie sie sind. Was schon eingeplant ist, bleibt eingeplant.
                </p>
                <FormGroup label="Grund" labelFor="lifecycle-reason" labelInfo="(Pflicht)"
                           helperText={reason.length > 0 && !reasonOk ? "Mindestens drei Zeichen." : "Steht in der Auftragsansicht und im Protokoll. Sachlich formulieren; der Kunde kann Auskunft darüber verlangen."}>
                  <InputGroup id="lifecycle-reason" value={reason} maxLength={200} autoFocus
                              onChange={(e) => setReason(e.target.value)}
                              placeholder="z. B. Kunde klärt Maße" />
                </FormGroup>
              </>
            ) : mode === "cancel" ? (
              blocked ? (
                <Callout intent="warning" icon="warning-sign" title="Dieser Auftrag kann so nicht storniert werden">
                  <ul className="lifecycle-blockers">
                    {check!.blockers.map((b) => <li key={b}>{b}</li>)}
                  </ul>
                </Callout>
              ) : (
                <>
                  <p>
                    <b className="mono">{order.no}</b> wird storniert. Er bleibt mit allen Angaben lesbar, geht aber
                    nicht mehr in die Fertigung und kann nicht wieder freigegeben werden. Es wird keine Mail verschickt:
                    Bitte den Kunden noch heute schriftlich informieren und die Nachricht ablegen.
                  </p>
                  <Callout intent="danger" icon="warning-sign">
                    Das lässt sich nicht zurücknehmen. Für denselben Bedarf später „Erneut bestellen" nutzen.
                  </Callout>
                  <FormGroup label="Grund" labelFor="lifecycle-reason" labelInfo="(Pflicht)"
                             helperText={reason.length > 0 && !reasonOk ? "Mindestens drei Zeichen." : "Steht in der Auftragsansicht und im Protokoll. Sachlich formulieren; der Kunde kann Auskunft darüber verlangen."}>
                    <InputGroup id="lifecycle-reason" value={reason} maxLength={200} autoFocus
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="z. B. Kunde hat abgesagt" />
                  </FormGroup>
                </>
              )
            ) : (
              <>
                <FormGroup label="Zusage (Liefertermin)" labelFor="lifecycle-due"
                           helperText="Leer lassen heißt: kein Termin.">
                  <InputGroup id="lifecycle-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
                </FormGroup>
                <Checkbox checked={rush} label="Eilauftrag — geht am Sammeln vorbei"
                          onChange={(e) => setRush(e.currentTarget.checked)} />
                <FormGroup label="Bestellzeichen des Kunden" labelFor="lifecycle-ref">
                  <InputGroup id="lifecycle-ref" value={ref} maxLength={80} onChange={(e) => setRef(e.target.value)} />
                </FormGroup>
                <FormGroup label="Büronotiz" labelFor="lifecycle-note"
                           helperText="Nur intern: steht auf keinem Beleg und nicht im Kundenkonto. Sachlich bleiben: keine Angaben zu Gesundheit oder Privatem, keine Wertungen. Der Kunde kann Auskunft über diese Notiz verlangen (Art. 15 DSGVO). Absprachen zu Preis oder Termin gehören in den Auftrag.">
                  <TextArea id="lifecycle-note" fill rows={4} value={note} maxLength={2000}
                            onChange={(e) => setNote(e.target.value)} />
                </FormGroup>
                <p className="sub">Mengen, Maße und Preise stehen mit der Bestellung fest und ändern sich nur über einen neuen Auftrag.</p>
              </>
            )}
        </div>
        <div className="bp5-dialog-footer"><div className="bp5-dialog-footer-actions">
          <Button onClick={onClose}>{blocked ? "Schließen" : "Abbrechen"}</Button>
          {!blocked && (
            <Button type="submit" loading={busy} disabled={!canSubmit}
                    intent={mode === "cancel" ? "danger" : "primary"}
                    icon={mode === "hold" ? "stop" : mode === "cancel" ? "cross-circle" : "tick"}>
              {mode === "hold" ? "Anhalten" : mode === "cancel" ? "Stornieren" : "Speichern"}
            </Button>
          )}
        </div></div>
      </form>
    </Dialog>
  );
}
