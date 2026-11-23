import { Button, HTMLSelect } from "@blueprintjs/core";

export interface PaginationBarProps {
  offset: number;
  limit: number;
  total: number;
  count: number;
  loading?: boolean;
  pageSizes?: number[];
  noun?: string;
  onChange: (nextOffset: number, nextLimit?: number) => void;
}

/** Kompakte serverseitige Seitenleiste für Tabellen mit bis zu Millionen Zeilen. */
export default function PaginationBar({
  offset,
  limit,
  total,
  count,
  loading = false,
  pageSizes = [50, 100, 200],
  noun = "Einträge",
  onChange,
}: PaginationBarProps) {
  const safeTotal = Math.max(total, offset + count);
  const pages = Math.max(1, Math.ceil(safeTotal / Math.max(1, limit)));
  const page = Math.min(pages, Math.floor(offset / Math.max(1, limit)) + 1);
  const from = count > 0 ? offset + 1 : 0;
  const to = offset + count;

  if (safeTotal <= Math.min(...pageSizes) && offset === 0) return null;

  return (
    <nav className="ui-pagination" aria-label={`Seitennavigation ${noun}`}>
      <span className="ui-pagination-info">
        {count > 0
          ? `${from.toLocaleString("de-DE")}–${to.toLocaleString("de-DE")} von ${safeTotal.toLocaleString("de-DE")} ${noun}`
          : `0 von ${safeTotal.toLocaleString("de-DE")} ${noun}`}
      </span>
      <div className="ui-pagination-controls">
        <label className="ui-pagination-size">
          <span className="sub">Je Seite</span>
          <HTMLSelect
            minimal
            aria-label="Zeilen je Seite"
            value={limit}
            disabled={loading}
            onChange={(e) => onChange(0, Number(e.currentTarget.value))}
          >
            {pageSizes.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </HTMLSelect>
        </label>
        <Button
          small
          minimal
          icon="double-chevron-left"
          aria-label="Erste Seite"
          disabled={loading || page <= 1}
          onClick={() => onChange(0)}
        />
        <Button
          small
          minimal
          icon="chevron-left"
          text="Zurück"
          disabled={loading || page <= 1}
          onClick={() => onChange(Math.max(0, offset - limit))}
        />
        <span className="ui-pagination-page">
          Seite {page.toLocaleString("de-DE")} / {pages.toLocaleString("de-DE")}
        </span>
        <Button
          small
          minimal
          rightIcon="chevron-right"
          text="Weiter"
          disabled={loading || page >= pages}
          onClick={() => onChange(offset + limit)}
        />
        <Button
          small
          minimal
          icon="double-chevron-right"
          aria-label="Letzte Seite"
          disabled={loading || page >= pages}
          onClick={() => onChange((pages - 1) * limit)}
        />
      </div>
    </nav>
  );
}
