import { useEffect, useState } from "react";
import { Button, HTMLSelect, Tag } from "@blueprintjs/core";
import { api } from "../api";
import { toastError, toastSuccess } from "../toast";
import { scopeOptions, ScopeView, Topology } from "../sites";

/* „Fertigen in" am Auftrag oder Innenauftrag. Der Sammellauf trennt Aufträge
   mit verschiedener Vorgabe auf eigene Platten; die Zuordnung lässt nur
   Stationen der gewählten Hallen oder Ebenen zu — auch von Hand. */

interface Props {
  /** "order" oder "work-order" — entscheidet die Route und ob „wo eingegangen" angeboten wird. */
  kind: "order" | "work-order";
  no: string;
  topo: Topology | null;
  initial?: string;
  readOnly?: boolean;
  onSaved?: (v: ScopeView) => void;
}

export default function OrderScope({ kind, no, topo, initial = "", readOnly, onSaved }: Props) {
  const [view, setView] = useState<ScopeView | null>(null);
  const [value, setValue] = useState(initial);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind !== "order") { setValue(initial); return; }
    let live = true;
    api<ScopeView>(`/api/factory/orders/${encodeURIComponent(no)}/scope`)
      .then((v) => { if (live) { setView(v); setValue(v.route_scope); setSiteId(v.site_id ?? null); } })
      .catch(() => { /* älterer Server */ });
    return () => { live = false; };
  }, [kind, no, initial]);
  const sites = topo?.sites ?? [];
  const many = sites.length > 1 || sites.some((s) => s.halls.length > 1 || s.halls.some((h) => h.floors.length > 1));
  if (!topo || !many) return null;
  const changed = value !== (view?.route_scope ?? initial) || (kind === "order" && siteId !== (view?.site_id ?? null));
  const save = async () => {
    setBusy(true);
    try {
      const v = await api<ScopeView>(`/api/factory/${kind === "order" ? "orders" : "work-orders"}/${encodeURIComponent(no)}/scope`, {
        method: "PUT", body: JSON.stringify({ route_scope: value, ...(kind === "order" ? { site_id: siteId } : {}) }),
      });
      setView(v);
      toastSuccess(v.released ? `Vorgabe gespeichert — ${no} ist wieder ohne Station.` : `Fertigen ${v.label}.`);
      onSaved?.(v);
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="order-scope">
      <HTMLSelect minimal value={value} disabled={readOnly || busy} aria-label="Fertigen in"
        onChange={(e) => setValue(e.currentTarget.value)}
        options={scopeOptions(topo, kind === "order")} />
      {kind === "order" && sites.length > 1 && (
        <HTMLSelect minimal value={siteId ?? ""} disabled={readOnly || busy} aria-label="Eingegangen in"
          onChange={(e) => setSiteId(Number(e.currentTarget.value) || null)}
          options={[{ value: "", label: "Eingang: erster Standort" }, ...sites.map((s) => ({ value: s.id, label: `Eingang: ${s.name}` }))]} />
      )}
      {changed && !readOnly && <Button small intent="primary" text="Übernehmen" loading={busy} onClick={save} />}
      {!changed && view && view.route_scope && <Tag minimal>{view.label}</Tag>}
    </div>
  );
}
