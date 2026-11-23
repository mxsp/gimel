export interface ChartSpec {
  kind?: "bar" | "line";
  title?: string;
  unit?: string;
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
}

function fmtNum(v: number, unit?: string): string {
  const n = Number.isFinite(v) ? v : 0;
  const s = n >= 1000
    ? n.toLocaleString("de-DE", { maximumFractionDigits: 1 })
    : n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
  return unit ? `${s} ${unit}` : s;
}

/** Kompaktes natives SVG-Diagramm für Analytik-Antworten und ``chart``-Codeblöcke (keine externen Abhängigkeiten). */
export default function ChartBlock({ spec }: { spec: ChartSpec }) {
  const labels = Array.isArray(spec.labels) ? spec.labels : [];
  const first = Array.isArray(spec.series) && spec.series[0] ? spec.series[0] : null;
  const values = first && Array.isArray(first.values) ? first.values.map((v) => Number(v) || 0) : [];
  if (!labels.length || !values.length) return null;

  const maxVal = Math.max(1e-9, ...values);
  const w = 540;
  const h = 190;
  const padL = 14;
  const padR = 14;
  const padT = 18;
  const padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const isLine = spec.kind === "line";

  const exportCsv = () => {
    const rows = [
      ["Kategorie", first?.name || "Wert"],
      ...labels.map((l, i) => [l, String(values[i] ?? 0).replace(".", ",")]),
    ];
    const csv = "\uFEFF" + rows.map((r) => r.map((c) => `"${String(c).replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(spec.title || "diagramm").toLowerCase().replace(/[^a-z0-9]+/gi, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  return (
    <div className="md-chart">
      <div className="md-chart-head">
        <span className="md-chart-title">{spec.title || first?.name || "Diagramm"}</span>
        <button type="button" className="md-code-copy" onClick={exportCsv} aria-label="Diagrammdaten als CSV">
          CSV
        </button>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="md-chart-svg" role="img" aria-label={spec.title || "Diagramm"}>
        <line x1={padL} y1={padT + plotH} x2={w - padR} y2={padT + plotH} className="md-chart-axis" />
        <line x1={padL} y1={padT} x2={w - padR} y2={padT} className="md-chart-grid" />
        <line x1={padL} y1={padT + plotH / 2} x2={w - padR} y2={padT + plotH / 2} className="md-chart-grid" />
        {isLine ? (() => {
          const step = labels.length > 1 ? plotW / (labels.length - 1) : 0;
          const pts = values.map((v, i) => [
            padL + (labels.length > 1 ? i * step : plotW / 2),
            padT + plotH - (v / maxVal) * plotH,
          ] as const);
          const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
          return (
            <>
              <path d={d} className="md-chart-line" />
              {pts.map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r={3.5} className="md-chart-dot">
                  <title>{`${labels[i]}: ${fmtNum(values[i], spec.unit)}`}</title>
                </circle>
              ))}
            </>
          );
        })() : (() => {
          const slot = plotW / labels.length;
          const bw = Math.max(6, Math.min(38, slot * 0.68));
          return values.map((v, i) => {
            const bh = Math.max(2, (v / maxVal) * plotH);
            const x = padL + i * slot + (slot - bw) / 2;
            const y = padT + plotH - bh;
            return (
              <rect key={i} x={x} y={y} width={bw} height={bh} rx={2} className="md-chart-bar">
                <title>{`${labels[i]}: ${fmtNum(v, spec.unit)}`}</title>
              </rect>
            );
          });
        })()}
        {labels.map((lbl, i) => {
          // Bei vielen Balken Labels ausdünnen, damit nichts überlappt
          const stride = Math.max(1, Math.ceil(labels.length / 8));
          if (i % stride !== 0 && i !== labels.length - 1) return null;
          const x = isLine
            ? padL + (labels.length > 1 ? (i * plotW) / (labels.length - 1) : plotW / 2)
            : padL + (i + 0.5) * (plotW / labels.length);
          const short = lbl.length > 12 ? lbl.slice(0, 11) + "…" : lbl;
          return (
            <text key={`l-${i}`} x={x} y={h - 10} textAnchor="middle" className="md-chart-label">
              {short}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
