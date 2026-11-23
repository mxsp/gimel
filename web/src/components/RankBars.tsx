import { Callout, Tag } from "@blueprintjs/core";
import { StationRank, HandlerRank, RankFactor, fmtM, fmtMin } from "../factory";

/* Warum diese Station, warum dieser Bearbeiter.

   Der ganze Wert dieser Komponente steckt in einer Zeile Anspruch aus
   CLAUDE.md §5.5: *eine Regel, deren Entscheidung man nicht nachlesen kann,
   wird beim ersten Zweifel abgeschaltet.* Also wird hier nicht der Punktwert
   gezeigt, sondern seine Zerlegung — Faktor für Faktor, jeder mit dem Satz,
   den der Rechenkern selbst dazu formuliert hat, und ungeeignete Stationen
   mit ihrem Ausschlussgrund statt als Leerstelle. */

export default function RankBars({ ranking, chosenId }: {
  ranking: StationRank[];
  chosenId?: number | null;
}) {
  const best = Math.max(1, ...ranking.filter((r) => r.eligible).map((r) => r.score));
  const eligible = ranking.filter((r) => r.eligible);
  const blocked = ranking.filter((r) => !r.eligible);

  return (
    <div className="rank-list">
      {eligible.map((r, i) => (
        <div key={r.station_id}
             className={"rank-row" + (r.station_id === chosenId ? " rank-row-here" : "")}>
          <span className="rank-pos">{i + 1}</span>
          <div className="rank-body">
            <div className="rank-head">
              <b>{r.label}</b>
              {r.station_id === chosenId && <Tag minimal intent="primary">gewählt</Tag>}
              <Tag minimal>{r.routing === "pull" ? "Pull"
                : r.routing === "smart_auto" ? "Automatik" : "Vorschlag"}</Tag>
              {!r.changeover && <Tag minimal intent="success">kein Rüsten</Tag>}
              {r.minutes > 0 && <Tag minimal icon="time">{fmtMin(r.minutes)}</Tag>}
              {r.route_m > 0 && (
                <Tag minimal icon="route" intent={r.route_exact ? "none" : "warning"}>
                  {fmtM(r.route_m)}{r.route_exact ? "" : " Luftlinie"}
                </Tag>
              )}
              {r.cost_eur > 0 && <Tag minimal>{r.cost_eur.toLocaleString("de-DE",
                { style: "currency", currency: "EUR", maximumFractionDigits: 0 })}</Tag>}
            </div>
            <div className="rank-track">
              <div className="rank-fill" style={{ width: `${Math.round((r.score / best) * 100)}%` }} />
            </div>
            <FactorList factors={r.factors} />
          </div>
          <span className="rank-score">{r.score.toFixed(0)}</span>
        </div>
      ))}

      {blocked.length > 0 && (
        <>
          <h2 className="rank-sep">Nicht geeignet ({blocked.length})</h2>
          {blocked.map((r) => (
            <div key={r.station_id} className="rank-row rank-row-blocked">
              <span className="rank-pos">—</span>
              <div className="rank-body">
                <div className="rank-head"><b>{r.label}</b></div>
                <div className="rank-reason">{r.blockers.join(" · ")}</div>
              </div>
            </div>
          ))}
        </>
      )}

      {!ranking.length && (
        <Callout compact icon="info-sign">Keine Station zu bewerten.</Callout>
      )}
    </div>
  );
}

/** Die Faktoren als kleine Balken — Anteil am Maximum, nicht am Gesamtwert:
    ein Faktor, der 8 von 8 möglichen Punkten holt, ist voll, auch wenn er
    gegen die 26 des Rüstwechsels klein aussieht. */
export function FactorList({ factors }: { factors: RankFactor[] }) {
  if (!factors?.length) return null;
  return (
    <div className="factor-list">
      {factors.map((f) => (
        <div key={f.key} className="factor-row">
          <span className="factor-label">{f.label}</span>
          <span className="factor-track">
            <span className="factor-fill"
              style={{ width: `${Math.round(Math.max(0, Math.min(1, f.share)) * 100)}%` }} />
          </span>
          <span className="factor-reason">{f.reason}</span>
          <span className="factor-pts">{f.points.toFixed(0)}<span className="sub">/{f.max.toFixed(0)}</span></span>
        </div>
      ))}
    </div>
  );
}

/** Dieselbe Darstellung für Bearbeiter — andere Kopfzeile, gleiche Zerlegung. */
export function HandlerBars({ ranking, chosenId }: {
  ranking: HandlerRank[]; chosenId?: number | null;
}) {
  const best = Math.max(1, ...ranking.filter((r) => r.eligible).map((r) => r.score));
  return (
    <div className="rank-list">
      {ranking.map((r, i) => (
        <div key={r.user_id}
             className={"rank-row" + (r.user_id === chosenId ? " rank-row-here" : "")
               + (r.eligible ? "" : " rank-row-blocked")}>
          <span className="rank-pos">{r.eligible ? i + 1 : "—"}</span>
          <div className="rank-body">
            <div className="rank-head">
              <b>{r.name}</b>
              {r.user_id === chosenId && <Tag minimal intent="primary">zugeordnet</Tag>}
            </div>
            {r.eligible ? (
              <>
                <div className="rank-track">
                  <div className="rank-fill" style={{ width: `${Math.round((r.score / best) * 100)}%` }} />
                </div>
                <FactorList factors={r.factors} />
              </>
            ) : (
              <div className="rank-reason">{r.blockers.join(" · ")}</div>
            )}
          </div>
          {r.eligible && <span className="rank-score">{r.score.toFixed(0)}</span>}
        </div>
      ))}
    </div>
  );
}
