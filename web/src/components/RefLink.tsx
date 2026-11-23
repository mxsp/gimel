import { useEffect, useState } from "react";
import { Button, Spinner, Tag } from "@blueprintjs/core";
import { api } from "../api";
import { navigate } from "../router";

/* Querverweise: jede Belegnummer ist ein Sprung.
   `RefLink` macht aus einer Nummer einen Knopf; `RelatedPanel` zeigt zu einer Nummer
   alle Nachbarn (GET /api/links/{no}) — Auftrag, Innenauftrag, Sammellauf, Versand,
   Rechnung, Reststück, Roboterauftrag. Eine Wahrheit: der Server liest die vorhandenen
   Spuren, die Oberfläche merkt sich nichts. */

export type RefKind = "order" | "work_order" | "run" | "shipment" | "offcut" | "invoice" | "robot_job";

const ICON: Record<RefKind, "document" | "cut" | "layers" | "send-to" | "widget" | "dollar" | "automatic-updates"> = {
  order: "document", work_order: "cut", run: "layers", shipment: "send-to",
  offcut: "widget", invoice: "dollar", robot_job: "automatic-updates",
};

const ROUTE: Record<RefKind, (no: string) => string> = {
  order: (no) => `auftraege/${encodeURIComponent(no)}`,
  work_order: (no) => `produktion/${encodeURIComponent(no)}`,
  run: (no) => `disposition/${encodeURIComponent(no)}`,
  shipment: (no) => `versand/${encodeURIComponent(no)}`,
  offcut: () => "lager",
  invoice: (no) => `auftraege/${encodeURIComponent(no)}`,
  robot_job: () => "roboter",
};

const NAME: Record<RefKind, string> = {
  order: "Auftrag", work_order: "Innenauftrag", run: "Sammellauf", shipment: "Versand",
  offcut: "Reststück", invoice: "Rechnung", robot_job: "Roboterauftrag",
};

/** Eine Belegnummer als Sprung. `disabled` (z. B. Werker ohne Zugriff) lässt die Nummer Text bleiben. */
export function RefLink({ kind, no, label, disabled }: {
  kind: RefKind; no: string; label?: string; disabled?: boolean;
}) {
  if (!no) return <span className="sub">—</span>;
  const text = label ?? no;
  if (disabled) return <span className="mono">{text}</span>;
  return (
    <Button minimal small icon={ICON[kind]} className="mono nw"
            text={text} title={`${NAME[kind]} ${no} öffnen`}
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); navigate(ROUTE[kind](no)); }} />
  );
}

interface RelatedItem { kind: RefKind; no: string; label: string; sub: string; route: string }
interface RelatedGroup { kind: RefKind; title: string; items: RelatedItem[] }
interface Related { no: string; kind: RefKind; label: string; sub: string; groups: RelatedGroup[] }

/** Alle Nachbarn einer Nummer. Lädt selbst; ein Fehler heißt „keine Verweise", nie ein Absturz. */
export function RelatedPanel({ no }: { no: string }) {
  const [data, setData] = useState<Related | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "none">("loading");

  useEffect(() => {
    let live = true;
    setState("loading"); setData(null);
    api<Related>(`/api/links/${encodeURIComponent(no)}`)
      .then((d) => { if (live) { setData(d); setState("ok"); } })
      .catch(() => { if (live) setState("none"); });
    return () => { live = false; };
  }, [no]);

  if (state === "loading") return <Spinner size={16} />;
  if (state === "none" || !data) return <p className="sub">Keine Verweise gefunden.</p>;
  if (data.groups.length === 0) return <p className="sub">{data.label} {data.no} hängt noch an nichts — weder Innenauftrag noch Versand.</p>;

  return (
    <div className="xref-panel">
      {data.groups.map((g, gi) => (
        <section key={`${g.kind}-${gi}`} className="xref-group">
          <h4 className="xref-title">{g.title} <Tag minimal round>{g.items.length}</Tag></h4>
          <div className="xref-list">
            {g.items.map((it) => (
              <button key={`${it.kind}-${it.no}`} type="button" className="xref-row"
                      title={`${it.label} ${it.no} öffnen`}
                      onClick={() => navigate(it.route)}>
                <span className="mono">{it.no}</span>
                <span className="sub">{it.sub}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
