import { ButtonGroup, Button, Spinner } from "@blueprintjs/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";

/* Bestandsverlauf eines Werkstoffs — wie viele Platten an jedem Tag im Regal lagen.

   Zwei Diagramme, nicht eines mit zwei Achsen: oben der Tagesstand (eine
   Reihe, Linie mit Fläche), darunter Zu- und Abgang je Tag als Balken um
   eine Nulllinie. Richtung zeigt die Lage (oben = Zugang, unten = Abgang),
   die Farbe wiederholt es nur. Ein Fadenkreuz zeigt beim Überfahren den Tag
   mit allen drei Zahlen. Die Tabelle darunter ist die Textfassung. */

interface Point { day: string; balance: number; in: number; out: number }
export interface Timeline {
  mat: string;
  days: number;
  stock: number;
  opening: number;
  points: Point[];
  received: number;
  consumed: number;
  avg_per_day: number;
  reach_days: number | null;
  lead_days: number;
  offcuts: { pending: number; available: number; reserved: number };
}

const W = 340;
const H1 = 110;
const H2 = 46;
const PAD_L = 30;
const PAD_R = 6;
const RANGES: Array<[number, string]> = [[30, "30 T"], [90, "90 T"], [365, "1 J"]];

const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });

export default function StockTimeline({ mat, refreshKey = 0 }: { mat: string; refreshKey?: number }) {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Timeline | null>(null);
  const [err, setErr] = useState("");
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let live = true;
    setData(null); setErr("");
    api<Timeline>(`/api/inventory/${encodeURIComponent(mat)}/timeline?days=${days}`)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [mat, days, refreshKey]);

  const geo = useMemo(() => {
    if (!data || !data.points.length) return null;
    const pts = data.points;
    const n = pts.length;
    const maxB = Math.max(1, ...pts.map((p) => p.balance));
    const minB = Math.min(0, ...pts.map((p) => p.balance));
    const maxM = Math.max(1, ...pts.map((p) => Math.max(p.in, p.out)));
    const x = (i: number) => PAD_L + (n === 1 ? 0 : (i / (n - 1)) * (W - PAD_L - PAD_R));
    const y = (v: number) => 6 + (1 - (v - minB) / (maxB - minB || 1)) * (H1 - 18);
    // Treppenlinie: der Stand gilt den ganzen Tag, bis die nächste Buchung kommt.
    let line = `M${x(0)},${y(pts[0].balance)}`;
    for (let i = 1; i < n; i++) line += ` H${x(i)} V${y(pts[i].balance)}`;
    const area = `${line} V${y(minB)} H${x(0)} Z`;
    const mid = H2 / 2;
    const bh = (v: number) => (v / maxM) * (mid - 3);
    const bw = Math.max(1.5, Math.min(6, (W - PAD_L - PAD_R) / n - 1));
    return { pts, n, maxB, minB, maxM, x, y, line, area, mid, bh, bw };
  }, [data]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geo || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((vx - PAD_L) / (W - PAD_L - PAD_R)) * (geo.n - 1));
    setHover(Math.max(0, Math.min(geo.n - 1, i)));
  };

  const reachLow = data?.reach_days != null && data.lead_days > 0 && data.reach_days < data.lead_days;
  const hp = geo && hover != null ? geo.pts[hover] : null;

  return (
    <div className="stock-timeline">
      <div className="stock-timeline-head">
        <h3>Bestandsverlauf</h3>
        <ButtonGroup minimal>
          {RANGES.map(([d, label]) => (
            <Button key={d} small active={days === d} onClick={() => setDays(d)}
                    aria-pressed={days === d} aria-label={`Zeitraum ${label}`}>{label}</Button>
          ))}
        </ButtonGroup>
      </div>
      {err ? <p className="sub">{err}</p> : !data || !geo ? <Spinner size={20} /> : (
        <>
          <div className="stock-timeline-tip">
            {hp ? (
              <><b>{fmtDay(hp.day)}</b> · {hp.balance} Pl.
                {hp.in > 0 && <span className="tl-in"> · +{hp.in} Zugang</span>}
                {hp.out > 0 && <span className="tl-out"> · −{hp.out} Abgang</span>}</>
            ) : (
              <span className="sub">Zeigen oder tippen: Tageswert · heute {data.stock} Pl.</span>
            )}
          </div>
          <svg ref={svgRef} className="stock-timeline-svg" viewBox={`0 0 ${W} ${H1 + H2 + 14}`}
               role="img" aria-label={`Bestand der letzten ${data.days} Tage, von ${data.opening} auf ${data.stock} Platten`}
               onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
            {/* Raster: nur Null und Höchststand */}
            <line className="tl-grid" x1={PAD_L} x2={W - PAD_R} y1={geo.y(geo.maxB)} y2={geo.y(geo.maxB)} />
            <line className="tl-axis" x1={PAD_L} x2={W - PAD_R} y1={geo.y(geo.minB)} y2={geo.y(geo.minB)} />
            <text className="tl-label" x={PAD_L - 4} y={geo.y(geo.maxB) + 3} textAnchor="end">{geo.maxB}</text>
            <text className="tl-label" x={PAD_L - 4} y={geo.y(geo.minB) + 3} textAnchor="end">{geo.minB}</text>
            <path className="tl-area" d={geo.area} />
            <path className="tl-line" d={geo.line} />

            <g transform={`translate(0 ${H1})`}>
              <line className="tl-axis" x1={PAD_L} x2={W - PAD_R} y1={geo.mid} y2={geo.mid} />
              <text className="tl-label" x={PAD_L - 4} y={geo.mid - 6} textAnchor="end">+</text>
              <text className="tl-label" x={PAD_L - 4} y={geo.mid + 12} textAnchor="end">−</text>
              {geo.pts.map((p, i) => (
                <g key={p.day}>
                  {p.in > 0 && <rect className="tl-bar-in" x={geo.x(i) - geo.bw / 2} width={geo.bw}
                                     y={geo.mid - 1 - geo.bh(p.in)} height={geo.bh(p.in)} rx={1} />}
                  {p.out > 0 && <rect className="tl-bar-out" x={geo.x(i) - geo.bw / 2} width={geo.bw}
                                      y={geo.mid + 1} height={geo.bh(p.out)} rx={1} />}
                </g>
              ))}
            </g>

            {hover != null && (
              <g pointerEvents="none">
                <line className="tl-cross" x1={geo.x(hover)} x2={geo.x(hover)} y1={4} y2={H1 + H2} />
                <circle className="tl-dot" cx={geo.x(hover)} cy={geo.y(geo.pts[hover].balance)} r={4} />
              </g>
            )}
            <text className="tl-label" x={PAD_L} y={H1 + H2 + 12}>{fmtDay(geo.pts[0].day)}</text>
            <text className="tl-label" x={W - PAD_R} y={H1 + H2 + 12} textAnchor="end">heute</text>
          </svg>
          <div className="stock-timeline-legend sub">
            <span><i className="tl-key tl-key-line" /> Bestand</span>
            <span><i className="tl-key tl-key-in" /> Zugang</span>
            <span><i className="tl-key tl-key-out" /> Abgang</span>
          </div>

          <div className="side-kv">
            <span>Zugang</span><b>+{data.received} Pl.</b>
            <span>Verbrauch</span><b>{data.consumed} Pl. · Ø {data.avg_per_day.toLocaleString("de-DE", { maximumFractionDigits: 2 })}/Tag</b>
            <span>Reichweite</span>
            <b className={reachLow ? "tl-warn" : undefined}>
              {data.reach_days == null ? "—" : `≈ ${Math.round(data.reach_days)} Tage`}
              {reachLow && ` · unter Lieferzeit (${data.lead_days} T)`}
            </b>
            <span>Reststücke</span>
            <b>{data.offcuts.available} verfügbar
              {data.offcuts.reserved > 0 && ` · ${data.offcuts.reserved} reserviert`}
              {data.offcuts.pending > 0 && ` · ${data.offcuts.pending} entstehen`}</b>
          </div>
          <p className="sub tl-note">Reichweite: Bestand geteilt durch den mittleren Verbrauch im Zeitraum — eine Schätzung.</p>

          <Button small minimal icon="th" text={table ? "Tabelle ausblenden" : "Als Tabelle"} aria-expanded={table}
                  onClick={() => setTable(!table)} />
          {table && (
            <div className="table-scroll tl-table">
              <table className="data-table bp5-html-table bp5-compact">
                <thead><tr><th>Tag</th><th className="num">Zugang</th><th className="num">Abgang</th><th className="num">Stand</th></tr></thead>
                <tbody>
                  {[...data.points].reverse().filter((p) => p.in || p.out).map((p) => (
                    <tr key={p.day}><td>{fmtDay(p.day)}</td><td className="num">{p.in || ""}</td>
                      <td className="num">{p.out || ""}</td><td className="num">{p.balance}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
