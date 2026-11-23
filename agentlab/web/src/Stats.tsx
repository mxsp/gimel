import { Button, HTMLSelect, Spinner, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentStats, ApiError, DayStat, ModelStat, getStats } from "./api";
import { relativeTime } from "./chatUtils";

const RANGES = [
  { value: 7, label: "7 Tage" },
  { value: 30, label: "30 Tage" },
  { value: 90, label: "90 Tage" },
  { value: 365, label: "1 Jahr" },
  { value: 0, label: "Alles" },
];

const NUMBER = new Intl.NumberFormat("de-DE");

function count(value: number): string {
  return NUMBER.format(Math.round(value || 0));
}

/** Große Tokenzahlen bleiben lesbar, die genaue Zahl steht im Tooltip. */
function compact(value: number): string {
  const n = Math.max(0, value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("de-DE", { maximumFractionDigits: 2 })} Mio.`;
  if (n >= 10_000) return `${(n / 1_000).toLocaleString("de-DE", { maximumFractionDigits: 0 })} Tsd.`;
  return count(n);
}

function money(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value || 0);
}

function percent(part: number, total: number): string {
  if (!total) return "0 %";
  return `${((part / total) * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;
}

function costOf(row: { cost: number; list_cost: number; has_list_cost: boolean }): number {
  return row.has_list_cost ? row.list_cost : row.cost;
}

function hasCost(row: { cost: number; list_cost: number; has_cost: boolean; has_list_cost: boolean }): boolean {
  return row.has_cost || row.has_list_cost;
}

export default function Stats({ onOpenChat }: { onOpenChat?: (id: number) => void }) {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [data, setData] = useState<AgentStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getStats(days));
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const totals = data?.totals;
  const inputUncached = totals ? Math.max(0, totals.prompt_tokens - totals.cached_tokens) : 0;
  const segments = totals ? [
    { key: "input", label: "Eingabe", value: inputUncached, color: "var(--lab-accent)" },
    { key: "cache", label: "Cache", value: totals.cached_tokens, color: "var(--g-info)" },
    { key: "output", label: "Ausgabe", value: totals.completion_tokens, color: "var(--lab-clay)" },
  ] : [];
  const segmentSum = segments.reduce((sum, part) => sum + part.value, 0);

  const maxDay = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.series.map((day) => metric === "tokens" ? day.total_tokens : costOf(day)));
  }, [data, metric]);

  const modelTotal = totals?.total_tokens || 0;

  return (
    <div className="lab-page stats-page">
      <h2>Statistik</h2>
      <p className="sub">
        Modelle, Token und die vom Anbieter gemeldeten Kosten. Fehlt eine Meldung,
        bleibt der Wert leer — geschätzt wird nichts. Ausgeblendete und gelöschte
        Chats zählen mit, weil ihre Aufrufe bezahlt wurden.
      </p>

      <div className="stats-toolbar">
        <HTMLSelect minimal value={days} aria-label="Zeitraum"
          onChange={(event) => setDays(Number(event.target.value))}>
          {RANGES.map((range) => (
            <option key={range.value} value={range.value}>{range.label}</option>
          ))}
        </HTMLSelect>
        <Button icon="refresh" text="Aktualisieren" onClick={load} loading={loading} />
        <span className="spacer" />
        {data && (
          <>
            <Tag minimal>{count(totals?.rounds ?? 0)} Modellrunden</Tag>
            <Tag minimal>{count(data.models.length)} Modell(e)</Tag>
            <Tag minimal>{count(totals?.chats ?? 0)} Chat(s)</Tag>
          </>
        )}
      </div>

      {error && <div className="login-card banner-bad stats-banner">{error}</div>}
      {loading && !data ? <div className="lab-loading"><Spinner size={28} /><span>Statistik wird geladen</span></div> : null}
      {!loading && data && totals && totals.rounds === 0 ? (
        <div className="empty">
          Noch keine gemessenen Modellrunden in diesem Zeitraum.
          Sobald der Assistent antwortet, erscheinen hier Token und Kosten.
        </div>
      ) : null}

      {data && totals && totals.rounds > 0 && (
        <>
          <div className="stats-cards">
            <div className="stats-card">
              <div className="label">Token gesamt</div>
              <div className="value" title={count(totals.total_tokens)}>{compact(totals.total_tokens)}</div>
              <div className="hint">Eingabe {compact(totals.prompt_tokens)} · Ausgabe {compact(totals.completion_tokens)}</div>
            </div>
            <div className="stats-card">
              <div className="label">{totals.has_list_cost ? "Listenpreis" : "Kosten"}</div>
              <div className="value" title={money(costOf(totals), data.currency)}>
                {hasCost(totals) ? money(costOf(totals), data.currency) : "–"}
              </div>
              <div className="hint">
                {totals.has_list_cost && totals.has_cost
                  ? `abgerechnet ${money(totals.cost, data.currency)}`
                  : totals.has_list_cost ? "vom Anbieter gemeldet" : "vom Anbieter gemeldet"}
              </div>
            </div>
            {totals.has_allowance && (
              <div className="stats-card">
                <div className="label">Kontingent</div>
                <div className="value" title={money(totals.allowance, data.currency)}>
                  {money(totals.allowance, data.currency)}
                </div>
                <div className="hint">Verbrauch aus dem Go-Kontingent</div>
              </div>
            )}
            <div className="stats-card">
              <div className="label">Cache</div>
              <div className="value">{percent(totals.cached_tokens, totals.prompt_tokens)}</div>
              <div className="hint">{compact(totals.cached_tokens)} von {compact(totals.prompt_tokens)} Eingabetoken</div>
            </div>
            <div className="stats-card">
              <div className="label">Denken</div>
              <div className="value">{compact(totals.reasoning_tokens)}</div>
              <div className="hint">in der Ausgabe enthalten</div>
            </div>
            <div className="stats-card">
              <div className="label">Modellrunden</div>
              <div className="value">{count(totals.rounds)}</div>
              <div className="hint">in {count(totals.chats)} Chat(s) · {count(data.models.length)} Modell(e)</div>
            </div>
          </div>

          <section className="stats-section">
            <h3>Token-Verteilung</h3>
            <p className="sub2">Eingabe ohne Cache, Cache-Treffer und Ausgabe; Denken ist Teil der Ausgabe.</p>
            <div className="stats-split" role="img" aria-label="Verteilung der Token">
              {segments.map((part) => part.value > 0 && (
                <span key={part.key} style={{
                  width: `${segmentSum ? (part.value / segmentSum) * 100 : 0}%`,
                  background: part.color,
                }} title={`${part.label}: ${count(part.value)} Token`} />
              ))}
            </div>
            <div className="stats-legend">
              {segments.map((part) => (
                <span key={part.key}>
                  <i style={{ background: part.color }} />
                  {part.label} {compact(part.value)} ({percent(part.value, segmentSum)})
                </span>
              ))}
            </div>
          </section>

          <section className="stats-section">
            <h3>Je Modell</h3>
            <p className="sub2">Was jedes Modell wirklich gerechnet hat. Der Chat kann das Modell wechseln; gezählt wird die Runde.</p>
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Modell</th>
                  <th>Anbieter</th>
                  <th>Runden</th>
                  <th>Eingabe</th>
                  <th className="stats-col-optional">Cache</th>
                  <th>Ausgabe</th>
                  <th>Gesamt</th>
                  <th>Anteil</th>
                  <th>Listenpreis</th>
                  <th className="stats-col-optional">Abgerechnet</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((row) => (
                  <ModelRow key={`${row.model}|${row.provider}`} row={row} total={modelTotal} currency={data.currency} />
                ))}
              </tbody>
            </table>
          </section>

          <section className="stats-section">
            <h3>Verlauf</h3>
            <div className="stats-chart-head">
              <p className="sub2">Je Tag im gewählten Zeitraum.</p>
              <HTMLSelect minimal value={metric} aria-label="Diagrammwert"
                onChange={(event) => setMetric(event.target.value as "tokens" | "cost")}>
                <option value="tokens">Token</option>
                <option value="cost">Kosten</option>
              </HTMLSelect>
            </div>
            {data.series.length === 0 ? <div className="empty">Keine Tage im Zeitraum.</div> : (
              <>
                <div className="stats-chart" role="img" aria-label="Verlauf je Tag">
                  {data.series.map((day) => (
                    <ChartBar key={day.date} day={day} max={maxDay} metric={metric} currency={data.currency} />
                  ))}
                </div>
                <div className="stats-chart-axis">
                  <span>{new Date(`${data.series[0].date}T00:00:00`).toLocaleDateString("de-DE")}</span>
                  <span>{new Date(`${data.series[data.series.length - 1].date}T00:00:00`).toLocaleDateString("de-DE")}</span>
                </div>
              </>
            )}
          </section>

          {data.chats.length > 0 && (
            <section className="stats-section">
              <h3>Stärkste Chats</h3>
              <p className="sub2">Die zwölf Chats mit den meisten Token in diesem Zeitraum.</p>
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>Chat</th>
                    <th>Modell</th>
                    <th>Runden</th>
                    <th>Gesamt</th>
                    <th>Listenpreis</th>
                    <th className="stats-col-optional">Zuletzt</th>
                  </tr>
                </thead>
                <tbody>
                  {data.chats.map((chat) => (
                    <tr key={chat.id}>
                      <td>
                        {chat.deleted ? (
                          <span>{chat.title} <Tag minimal>gelöscht</Tag></span>
                        ) : onOpenChat ? (
                          <button type="button" className="stats-chat-link" onClick={() => onOpenChat(chat.id)}>
                            {chat.title}
                          </button>
                        ) : chat.title}
                      </td>
                      <td className="mono">{chat.model || "–"}</td>
                      <td>{count(chat.rounds)}</td>
                      <td title={count(chat.total_tokens)}>{compact(chat.total_tokens)}</td>
                      <td>{hasCost(chat) ? money(costOf(chat), data.currency) : "–"}</td>
                      <td className="stats-col-optional">{chat.last_at ? relativeTime(chat.last_at) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ModelRow({ row, total, currency }: { row: ModelStat; total: number; currency: string }) {
  const share = total ? (row.total_tokens / total) * 100 : 0;
  return (
    <tr>
      <td className="mono stats-model" title={row.model}>{row.model}</td>
      <td>{row.provider}</td>
      <td>{count(row.rounds)}</td>
      <td title={count(row.prompt_tokens)}>{compact(row.prompt_tokens)}</td>
      <td className="stats-col-optional" title={count(row.cached_tokens)}>{compact(row.cached_tokens)}</td>
      <td title={count(row.completion_tokens)}>{compact(row.completion_tokens)}</td>
      <td title={count(row.total_tokens)}>{compact(row.total_tokens)}</td>
      <td className="stats-share">
        <div className="stats-share-track">
          <div className="stats-share-fill" style={{ width: `${share}%` }} />
        </div>
        <span className="stats-share-text">{percent(row.total_tokens, total)}</span>
      </td>
      <td>{row.has_list_cost ? money(row.list_cost, currency) : "–"}</td>
      <td className="stats-col-optional">{row.has_cost ? money(row.cost, currency) : "–"}</td>
    </tr>
  );
}

function ChartBar({ day, max, metric, currency }: {
  day: DayStat; max: number; metric: "tokens" | "cost"; currency: string;
}) {
  const value = metric === "tokens" ? day.total_tokens : costOf(day);
  const height = value > 0 ? Math.max(3, (value / max) * 100) : 1.5;
  const label = new Date(`${day.date}T00:00:00`).toLocaleDateString("de-DE");
  const detail = metric === "tokens"
    ? `${count(day.total_tokens)} Token`
    : hasCost(day) ? money(costOf(day), currency) : "keine Kostenmeldung";
  return (
    <span className={`bar ${value > 0 ? "" : "is-empty"}`} style={{ height: `${height}%` }}
      title={`${label}: ${detail} · ${count(day.rounds)} Runde(n)`} />
  );
}
