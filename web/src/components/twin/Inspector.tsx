import { useEffect, useRef } from "react";
import { Button, Icon } from "@blueprintjs/core";
import { isWorker } from "../../api";
import { FlowEdge, ROUTING_SHORT, Station, TYPE_LABEL } from "../../factory";
import { navigate } from "../../router";
import { Est, Spoken } from "./Legend";
import { fmtHours, loadText, StationMark } from "./marks";

export interface StationViewData {
  station: Station;
  orders: { no: string; relevant: boolean; stage: number; rush: boolean }[];
  queue: { no: string; planned_min: number; status: string }[];
}

/** Die Station im Panel: was sie gerade tut und was auf sie wartet. Der Plan bleibt daneben stehen. */
export default function Inspector({ station: s, mark, view, failed, flow = [], stations = [], onClose, onCopyLink, onPickStation, closeLabel = "Zurück zur Lage" }: {
  station: Station; mark?: StationMark; view: StationViewData | null; failed: boolean;
  flow?: FlowEdge[]; stations?: Station[]; onPickStation?: (s: Station) => void;
  onClose: () => void; onCopyLink: (s: Station) => void; closeLabel?: string;
}) {
  const office = !isWorker();
  // Der Fokus geht auf die Überschrift: läge er auf einem Knopf, löste das Enter, das
  // die Station gewählt hat, dort gleich den Klick aus und schlösse das Panel wieder.
  const title = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { title.current?.focus(); }, [s.id]);
  // Die Sicht liefert auch Erledigtes, in Listenreihenfolge; die Schlange ist nur das Offene.
  const waiting = view?.queue?.filter((q) => q.status === "open" || q.status === "running") ?? [];
  const planned = loadText(s);
  const hasTime = (s.queue_min ?? 0) > 0;
  // Die Wege dieser Station: dieselben Kanten, die im Plan als Bögen stehen.
  const byId = new Map(stations.map((x) => [x.id, x]));
  const links = s.id == null ? [] : flow
    .filter((e) => e.from === s.id || e.to === s.id)
    .map((e) => {
      const outgoing = e.from === s.id;
      const other = byId.get(outgoing ? e.to : e.from);
      return other ? { edge: e, other, outgoing } : null;
    })
    .filter(Boolean) as { edge: FlowEdge; other: Station; outgoing: boolean }[];
  return (
    <section className="twin-inspector" aria-label={`Station ${s.label}`}>
      <Button minimal small icon="arrow-left" text={closeLabel} onClick={onClose} className="twin-back" />
      <h2 ref={title} tabIndex={-1} className="twin-panel-title">{s.label}</h2>
      <p className="sub">{TYPE_LABEL[s.type]}{s.subtype ? ` · ${s.subtype}` : ""}</p>
      {mark && <p className="twin-inspector-word" data-status={mark.kind}><Spoken word={mark.word} spoken={mark.spoken} /></p>}
      <dl className="run-facts">
        <div><dt>Eingeplant</dt><dd>{hasTime ? <Est>{planned}</Est> : planned}</dd></div>
        <div><dt>Betrieb</dt><dd>{ROUTING_SHORT[s.routing]}</dd></div>
        {s.last_mat && <div><dt>Zuletzt eingeplant</dt><dd>{s.last_mat}</dd></div>}
        {links.length > 0 && <div><dt>Wege</dt><dd>{links.length}</dd></div>}
      </dl>
      {links.length > 0 && (
        <>
          <h3 className="twin-panel-sub">Verbindungen</h3>
          <ul className="twin-links">
            {links.slice(0, 8).map(({ edge, other, outgoing }) => (
              <li key={`${edge.from}-${edge.to}-${other.id}`}>
                <Icon icon={outgoing ? "arrow-right" : "arrow-left"} size={12} aria-hidden />
                <span className="twin-link-who">
                  <b>{other.label}</b>
                  <span className="sub">{outgoing ? "abgehend" : "ankommend"} · {edge.count}× · {edge.metres.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m</span>
                </span>
                {onPickStation && (
                  <Button small minimal icon="locate" aria-label={`${other.label} im Plan zeigen`}
                    title={`${other.label} im Plan zeigen`} onClick={() => onPickStation(other)} />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="twin-panel-sub">Warteschlange</h3>
      {failed ? <p className="sub">Keine Angaben zu dieser Station.</p>
        : !view ? <p className="sub">Wird geladen …</p>
        : waiting.length === 0 ? (hasTime
          ? <p className="sub">Warteschlange nicht einsehbar. Die eingeplante Zeit kommt aus der Stationsliste.</p>
          : <p className="sub">Hier wartet nichts.</p>) : (
          <ul className="twin-queue">
            {waiting.map((q) => (
              <li key={q.no}>
                <span className="mono">{q.no}</span>
                <span className="sub"> {q.status === "running" ? "läuft" : "wartet"} · {q.planned_min > 0 ? <Est>{fmtHours(q.planned_min)}</Est> : "? Dauer unbekannt"}</span>
                {office && (
                  <Button small minimal icon="grid-view" text="Belegung"
                    onClick={() => navigate(`schachteln/${encodeURIComponent(q.no)}`)} />
                )}
              </li>
            ))}
          </ul>
        )}
      <div className="twin-inspector-foot">
        <Button intent="primary" icon="share" text="Station öffnen" onClick={() => navigate(`station/${s.id}`)} />
        <Button minimal icon="link" text="Link kopieren" onClick={() => onCopyLink(s)} />
      </div>
    </section>
  );
}
