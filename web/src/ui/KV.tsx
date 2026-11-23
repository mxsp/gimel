import { ReactNode } from "react";

export interface KVRow { label: ReactNode; value: ReactNode }

/* Eine Faktenliste: links das Wort, rechts der Wert. Dieselbe Form überall. */
export default function KV({ rows, columns = 1, className }: {
  rows: KVRow[];
  columns?: number;
  className?: string;
}) {
  return (
    <dl className={`ui-kv${className ? ` ${className}` : ""}`} style={columns > 1 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {rows.map((row, index) => (
        <div className="ui-kv-row" key={index}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
