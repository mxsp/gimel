import { useState } from "react";
import { Alert, Button, Icon, IconName } from "@blueprintjs/core";
import { fmtDate } from "../api";
import { navigate } from "../router";

export interface TimelineStep {
  id: string;
  label: string;
  icon: string;
  done: boolean;
  current: boolean;
  at: string | null;
  detail: string;
  can_rollback: boolean;
  blocked?: boolean;
  held?: boolean;
}

/* Visueller Auftragsweg in der Schublade: ersetzt die alte Inline-Zeile.
   Zeigt Status (erledigt, aktuell, gesperrt, angehalten, storniert), Datum,
   direkten Sprung in den passenden Bereich und sauberes Zurückrollen per Dialog. */
export default function OrderPathStepper({
  steps,
  office,
  busy,
  cancelled,
  held,
  workOrderNo,
  shipmentNo,
  orderNo,
  onRollback,
}: {
  steps: TimelineStep[];
  office: boolean;
  busy: boolean;
  cancelled?: boolean;
  held?: boolean;
  workOrderNo?: string;
  shipmentNo?: string;
  orderNo: string;
  onRollback: (stepId: string) => void;
}) {
  const [confirmStep, setConfirmStep] = useState<TimelineStep | null>(null);

  const stepLink = (id: string): { route: string; title: string } | null => {
    if (cancelled) return null;
    if (id === "released" && office) return { route: "disposition", title: "Zur Disposition" };
    if ((id === "planned" || id === "cutting" || id === "done") && workOrderNo) {
      return { route: `produktion/${encodeURIComponent(workOrderNo)}`, title: `Innenauftrag ${workOrderNo} öffnen` };
    }
    if (id === "shipped") {
      return shipmentNo
        ? { route: `versand/${encodeURIComponent(shipmentNo)}`, title: `Versand ${shipmentNo} öffnen` }
        : { route: "versand", title: "Zum Versand" };
    }
    if (id === "paid" && office) {
      return { route: `buchhaltung/${encodeURIComponent(orderNo)}`, title: "In der Buchhaltung öffnen" };
    }
    return null;
  };

  return (
    <>
      <ol className={"order-stepper" + (cancelled ? " is-cancelled" : "")} aria-label="Schritte im Auftragsweg">
        {steps.map((s, idx) => {
          const isPaid = s.id === "paid";
          const next = steps[idx + 1];
          const connectorDone = !cancelled && !!next && next.id !== "paid" && next.done;
          const state = cancelled
            ? (s.done ? "done" : "cancelled")
            : s.blocked
              ? "blocked"
              : s.held || (s.current && held)
                ? "held"
                : s.current
                  ? "current"
                  : s.done
                    ? "done"
                    : "todo";
          const link = stepLink(s.id);
          return (
            <li key={s.id} className={`order-step order-step-${state}${isPaid ? " order-step-side" : ""}`}>
              <div className="order-step-head">
                <span className="order-step-node" aria-hidden="true">
                  <Icon icon={(s.icon || "dot") as IconName} size={14} />
                </span>
                {idx < steps.length - 1 && !isPaid && next?.id !== "paid" && (
                  <span className={"order-step-line" + (connectorDone ? " is-done" : "")} aria-hidden="true" />
                )}
              </div>
              <div className="order-step-body">
                {link ? (
                  <button
                    type="button"
                    className="order-step-title order-step-link"
                    title={link.title}
                    onClick={() => navigate(link.route)}
                  >
                    {s.label}
                  </button>
                ) : (
                  <span className="order-step-title">{s.label}</span>
                )}
                <span className="order-step-date">{s.done && s.at ? fmtDate(s.at) : "—"}</span>
                <span className="order-step-detail" title={s.detail}>{s.detail}</span>
                {s.can_rollback && office && !cancelled && (
                  <Button
                    small
                    minimal
                    intent="danger"
                    icon="undo"
                    text="Zurückrollen"
                    loading={busy}
                    className="order-step-undo"
                    onClick={() => setConfirmStep(s)}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <Alert
        isOpen={confirmStep !== null}
        intent="danger"
        icon="undo"
        cancelButtonText="Abbrechen"
        confirmButtonText="Zurückrollen"
        canEscapeKeyCancel
        canOutsideClickCancel
        loading={busy}
        onCancel={() => setConfirmStep(null)}
        onConfirm={() => {
          if (!confirmStep) return;
          const id = confirmStep.id;
          setConfirmStep(null);
          onRollback(id);
        }}
      >
        <p>
          Schritt <b>„{confirmStep?.label}“</b> für <b className="mono">{orderNo}</b> zurückrollen?
        </p>
        <p className="sub">
          Spätere Fertigungsschritte werden dabei in umgekehrter Reihenfolge mit zurückgesetzt. Der Vorgang wird protokolliert.
        </p>
      </Alert>
    </>
  );
}
