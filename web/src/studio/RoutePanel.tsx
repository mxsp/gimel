import { useCallback, useEffect, useState } from "react";
import { Button, Callout, Spinner, Tag } from "@blueprintjs/core";
import { api } from "../api";
import { toastError, toastSuccess } from "../toast";
import { fmtMetres } from "../components/twin/studioMath";

/* Wege prüfen: jeder Roboterweg gegen Gangnetz, Hindernisse und Stationen.
   Der Vorschlag kommt vom Server (core/route_improve.py) und wird erst mit
   „Übernehmen" gespeichert — protokolliert, nur für Admins. */

interface RobotCheck {
  id: number;
  name: string;
  floor_id: number;
  route_mode: string;
  changed: boolean;
  metres_before: number;
  metres_after: number;
  rerouted: number;
  detours: number;
  air_legs: number;
  blocked: number;
  snapped: number;
  problems_before: string[];
  problems_after: string[];
  notes: string[];
}

interface Finding { edge: [number, number]; from: [number, number]; to: [number, number]; hits: string }

export default function RoutePanel({ floorId, onApplied }: { floorId: number | null; onApplied: () => void }) {
  const [data, setData] = useState<{ robots: RobotCheck[]; network: { floor_id: number; findings: Finding[] }[] } | null>(null);
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await api(`/api/factory/robots/route-check${floorId ? `?floor_id=${floorId}` : ""}`));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [floorId]);
  useEffect(() => { load(); }, [load]);

  const apply = async (ids: number[]) => {
    setBusy(ids.length > 1 ? "all" : ids[0]);
    let done = 0;
    try {
      for (const id of ids) {
        const r = await api<{ applied: boolean }>(`/api/factory/robots/${id}/improve-route`, {
          method: "POST", body: JSON.stringify({ apply: true }),
        });
        if (r.applied) done += 1;
      }
      toastSuccess(done ? `${done} Weg${done > 1 ? "e" : ""} verbessert` : "Nichts zu ändern");
      onApplied();
      await load();
    } catch (e) { toastError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  if (error) return <Callout intent="danger" className="sim-note">{error}</Callout>;
  if (!data) return <div className="studio-center"><Spinner size={24} /></div>;
  const open = data.robots.filter((r) => r.changed);
  const findings = data.network.flatMap((n) => n.findings);

  return (
    <div className="sim-panel route-panel">
      <Callout icon="path-search" className="sim-note">
        Jeder Roboterweg über die Gänge, nie durch ein Hindernis oder eine Station. Der Vorschlag wird erst mit
        „Übernehmen" gespeichert; Anfang und Ende bleiben, wo sie sind.
      </Callout>
      {open.length > 1 && (
        <Button intent="primary" icon="tick" text={`Alle ${open.length} übernehmen`} loading={busy === "all"}
          onClick={() => apply(open.map((r) => r.id))} />
      )}
      {data.robots.length === 0 && <p className="sim-muted">Kein Roboter mit Weg auf dieser Ebene.</p>}
      <ul className="route-list">
        {data.robots.map((r) => (
          <li key={r.id} className={r.changed ? "is-open" : "is-ok"}>
            <div className="route-head">
              <b>{r.name}</b>
              <Tag minimal>{r.route_mode === "loop" ? "Rundkurs" : "hin und zurück"}</Tag>
              {!r.changed && <Tag minimal intent="success" icon="tick">in Ordnung</Tag>}
            </div>
            {r.changed && (
              <p className="route-metres mono">
                {fmtMetres(r.metres_before)} → {fmtMetres(r.metres_after)}
                {r.metres_after > r.metres_before ? " (länger, aber auf den Gängen)" : ""}
              </p>
            )}
            {r.problems_before.length > 0 && (
              <p className="route-problem">Jetzt: {r.problems_before.join(" ")}</p>
            )}
            {r.problems_after.length > 0 && (
              <p className="route-problem">Danach noch: {r.problems_after.join(" ")}</p>
            )}
            {r.changed && r.notes.length > 0 && <ul className="sim-notes">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
            {r.changed && (
              <Button small icon="tick" text="Übernehmen" loading={busy === r.id} disabled={busy != null}
                onClick={() => apply([r.id])} />
            )}
          </li>
        ))}
      </ul>
      {findings.length > 0 && (
        <section className="sim-section">
          <h3>Gangnetz: {findings.length} Kante{findings.length > 1 ? "n" : ""} durch einen Körper</h3>
          <ul className="sim-notes">
            {findings.map((f) => (
              <li key={`${f.edge[0]}-${f.edge[1]}`}>
                Gang ({f.from.map((v) => v.toLocaleString("de-DE")).join(" | ")}) → ({f.to.map((v) => v.toLocaleString("de-DE")).join(" | ")}) kreuzt {f.hits}
              </li>
            ))}
          </ul>
          <p className="sim-muted">Im Modus „Bearbeiten" → Gänge verschieben; Roboterwege fahren bis dahin außen herum.</p>
        </section>
      )}
    </div>
  );
}
