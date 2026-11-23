import { Icon } from "@blueprintjs/core";
import { OrderFlowSummary } from "../orderFlow";

/* Auftragsweg als interaktive Stufenleiste: zeigt auf einen Blick, wie viele
   Aufträge in welcher Stufe stehen, und filtert oder springt mit einem Klick. */

export default function OrderPipelineBar({
  summary,
  activeFilter,
  activeDue,
  onSelectFilter,
  onSelectOverdue,
  linkMode = false,
}: {
  summary: OrderFlowSummary;
  activeFilter?: string;
  activeDue?: string;
  onSelectFilter?: (filterKey: string) => void;
  onSelectOverdue?: () => void;
  /** Auf Heute navigiert jeder Schritt direkt in die gefilterte Auftragsliste. */
  linkMode?: boolean;
}) {
  const isAll = !activeFilter || activeFilter === "alle";
  return (
    <section className="order-pipeline" aria-label="Auftragsweg">
      <div className="order-pipeline-track" role="group" aria-label="Stufen im Auftragsweg">
        {summary.stages.map((st, idx) => {
          const active = !linkMode && activeFilter === st.filterKey && activeDue !== "ueberfaellig";
          const empty = st.count === 0;
          const cls =
            "order-pipe-stage"
            + (active ? " is-active" : "")
            + (empty ? " is-empty" : "")
            + (st.urgent > 0 ? " has-urgent" : "");
          const inner = (
            <>
              <span className="order-pipe-step-no" aria-hidden="true">{idx + 1}</span>
              <span className="order-pipe-copy">
                <span className="order-pipe-label">{st.shortLabel}</span>
                <span className="order-pipe-count">
                  {st.count.toLocaleString("de-DE")}
                  {st.urgent > 0 && (
                    <span className="order-pipe-urgent" title={`${st.urgent} dringend oder gesperrt`} />
                  )}
                </span>
              </span>
            </>
          );
          if (linkMode) {
            return (
              <a
                key={st.id}
                className={cls}
                href={`#/auftraege?status=${encodeURIComponent(st.filterKey)}`}
                title={`${st.label}: ${st.count.toLocaleString("de-DE")}`}
              >
                {inner}
              </a>
            );
          }
          return (
            <button
              key={st.id}
              type="button"
              className={cls}
              aria-pressed={active}
              title={`${st.label}: ${st.count.toLocaleString("de-DE")} — klicken zum Filtern`}
              onClick={() => onSelectFilter?.(active ? "alle" : st.filterKey)}
            >
              {inner}
            </button>
          );
        })}
      </div>

      <div className="order-pipeline-meta">
        {!linkMode && onSelectFilter && (
          <button
            type="button"
            className={"order-pipe-pill" + (activeFilter === "aktiv" && activeDue !== "ueberfaellig" ? " is-active" : "")}
            aria-pressed={activeFilter === "aktiv" && activeDue !== "ueberfaellig"}
            onClick={() => onSelectFilter(activeFilter === "aktiv" ? "alle" : "aktiv")}
          >
            Offen <b>{summary.active.toLocaleString("de-DE")}</b>
          </button>
        )}
        {!linkMode && onSelectFilter && !isAll && (
          <button
            type="button"
            className="order-pipe-pill"
            onClick={() => onSelectFilter("alle")}
          >
            Alle <b>{summary.total.toLocaleString("de-DE")}</b>
          </button>
        )}
        {summary.overdue > 0 && (
          linkMode ? (
            <a className="order-pipe-pill is-danger" href="#/auftraege?due=ueberfaellig">
              <Icon icon="warning-sign" size={11} aria-hidden="true" />
              Überfällig <b>{summary.overdue.toLocaleString("de-DE")}</b>
            </a>
          ) : (
            <button
              type="button"
              className={"order-pipe-pill is-danger" + (activeDue === "ueberfaellig" ? " is-active" : "")}
              aria-pressed={activeDue === "ueberfaellig"}
              onClick={() => onSelectOverdue?.()}
            >
              <Icon icon="warning-sign" size={11} aria-hidden="true" />
              Überfällig <b>{summary.overdue.toLocaleString("de-DE")}</b>
            </button>
          )
        )}
        {summary.held > 0 && (
          linkMode ? (
            <a className="order-pipe-pill is-warning" href="#/auftraege?status=angehalten">
              <Icon icon="stop" size={11} aria-hidden="true" />
              Angehalten <b>{summary.held.toLocaleString("de-DE")}</b>
            </a>
          ) : (
            <button
              type="button"
              className={"order-pipe-pill is-warning" + (activeFilter === "angehalten" ? " is-active" : "")}
              aria-pressed={activeFilter === "angehalten"}
              onClick={() => onSelectFilter?.(activeFilter === "angehalten" ? "alle" : "angehalten")}
            >
              <Icon icon="stop" size={11} aria-hidden="true" />
              Angehalten <b>{summary.held.toLocaleString("de-DE")}</b>
            </button>
          )
        )}
        {summary.cancelled > 0 && !linkMode && onSelectFilter && (
          <button
            type="button"
            className={"order-pipe-pill" + (activeFilter === "storniert" ? " is-active" : "")}
            aria-pressed={activeFilter === "storniert"}
            onClick={() => onSelectFilter(activeFilter === "storniert" ? "alle" : "storniert")}
          >
            Storniert <b>{summary.cancelled.toLocaleString("de-DE")}</b>
          </button>
        )}
      </div>
    </section>
  );
}
