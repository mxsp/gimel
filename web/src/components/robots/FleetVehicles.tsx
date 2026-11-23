import { Button, ButtonGroup, Card, Icon, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { Floor, Robot, RobotJob, Station } from "../../factory";
import { navigate } from "../../router";
import { KpiStrip } from "../../ui";
import NonIdealState from "../NonIdealState";
import { robotMovingAt, robotPoseAt } from "../twin/robots";
import FleetMap from "./FleetMap";
import { capLabel, kindLabel, kindShort, liveState, routeColour, type TagIntent } from "./robotMeta";

/* Fahrzeuge: die Lage der fahrenden Flotte auf einen Blick.

   Links die Karte der gewählten Ebene mit den Fahrzeugen in Bewegung, rechts
   die Liste. Ein Klick (Karte oder Liste) wählt ein Fahrzeug und zeigt seine
   Akte: Akku, Tempo, Weg, laufender Transport, Quelle. Stammdaten ändert der
   Dialog der Seite (onEdit) — diese Ansicht schreibt nichts. */

type Filter = "all" | "moving" | "waiting" | "charging" | "fault";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Alle" },
  { id: "moving", label: "Fahren" },
  { id: "waiting", label: "Warten" },
  { id: "charging", label: "Laden" },
  { id: "fault", label: "Störung" },
];

const ACTIVE_JOB = new Set(["assigned", "running", "approved"]);
const JOB_STATE: Record<string, { label: string; intent: TagIntent }> = {
  approved: { label: "freigegeben", intent: "primary" },
  assigned: { label: "zugewiesen", intent: "primary" },
  running: { label: "fährt", intent: "success" },
};
const JOB_KIND: Record<string, string> = { pickup: "Abholung", delivery: "Anlieferung", transfer: "Umsetzung", return: "Rücktransport" };

interface Props {
  vehicles: Robot[];
  sampledAt: string | null;
  floorName: (id: number | null) => string;
  /** Ebenen in der Reihenfolge der Topologie. */
  floorIds: number[];
  defaultFloorId: number | null;
  admin: boolean;
  onEdit: (r: Robot) => void;
  onDelete: (r: Robot) => void;
  onNew: () => void;
  onShowOnPlan: (floorId: number | null) => void;
  /** Wege-Editor für ein gespeichertes Fahrzeug (nur Admins). */
  onEditRoute: (r: Robot) => void;
}

function Battery({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="fleet-batt is-unknown" title="Akku unbekannt">—</span>;
  const tone = pct <= 20 ? "is-low" : pct <= 40 ? "is-mid" : "";
  return (
    <span className={`fleet-batt ${tone}`} title={`Akku ${pct} %`}>
      <span className="fleet-batt-cell"><span style={{ width: `${Math.max(4, Math.min(100, pct))}%` }} /></span>
      <span className="mono">{pct} %</span>
    </span>
  );
}

const fmtAge = (s: number | null | undefined) => {
  if (s == null) return "unbekannt";
  if (s < 60) return `vor ${Math.round(s)} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  return `vor ${Math.round(s / 3600)} h`;
};

export default function FleetVehicles({
  vehicles, sampledAt, floorName, floorIds, defaultFloorId, admin, onEdit, onDelete, onNew, onShowOnPlan, onEditRoute,
}: Props) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [floorId, setFloorId] = useState<number | null>(null);
  const [floors, setFloors] = useState<Record<number, Floor>>({});
  const [stations, setStations] = useState<Station[]>([]);
  const [jobs, setJobs] = useState<RobotJob[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Ebenen mit Fahrzeugen zuerst; ohne Auswahl die mit den meisten Fahrzeugen.
  const floorsWithVehicles = useMemo(() => {
    const count = new Map<number, number>();
    for (const v of vehicles) if (v.floor_id != null) count.set(v.floor_id, (count.get(v.floor_id) ?? 0) + 1);
    const order = floorIds.filter((id) => count.has(id));
    for (const id of count.keys()) if (!order.includes(id)) order.push(id);
    return order.map((id) => ({ id, n: count.get(id) ?? 0 }));
  }, [vehicles, floorIds]);

  useEffect(() => {
    if (floorId != null && floorsWithVehicles.some((f) => f.id === floorId)) return;
    const best = [...floorsWithVehicles].sort((a, b) => b.n - a.n)[0]?.id;
    setFloorId(best ?? defaultFloorId ?? null);
  }, [floorsWithVehicles, floorId, defaultFloorId]);

  useEffect(() => {
    let off = false;
    api<Station[]>("/api/factory/stations").then((s) => { if (!off) setStations(s ?? []); }).catch(() => { /* Karte ohne Stationen */ });
    return () => { off = true; };
  }, []);

  useEffect(() => {
    if (floorId == null || floors[floorId]) return;
    let off = false;
    api<Floor>(`/api/factory/floor?floor_id=${floorId}`)
      .then((f) => { if (!off && f) setFloors((m) => ({ ...m, [floorId]: f })); })
      .catch(() => { /* Karte ohne Hallenumriss */ });
    return () => { off = true; };
  }, [floorId, floors]);

  const loadJobs = useCallback(async () => {
    try {
      const r = await api<{ jobs: RobotJob[] }>("/api/factory/robot-jobs?active=true");
      setJobs(r?.jobs ?? []);
    } catch { /* Transporte sind ein Zusatz — die Flotte steht auch ohne sie */ }
  }, []);
  useEffect(() => {
    void loadJobs();
    const id = window.setInterval(() => { if (!document.hidden) void loadJobs(); }, 15_000);
    return () => window.clearInterval(id);
  }, [loadJobs]);

  const jobOf = useMemo(() => {
    const m = new Map<number, RobotJob>();
    for (const j of jobs) {
      if (j.robot_id == null || !ACTIVE_JOB.has(j.state)) continue;
      const prev = m.get(j.robot_id);
      if (!prev || (j.state === "running" && prev.state !== "running")) m.set(j.robot_id, j);
    }
    return m;
  }, [jobs]);

  const live = useMemo(() => vehicles.map((r) => {
    const moving = r.active && robotMovingAt(r, sampledAt, now);
    const fault = r.active && (r.state === "error" || r.state === "blocked");
    const charging = r.active && r.state === "charging";
    const status: Filter = !r.active || r.state === "offline" ? "all" : fault ? "fault" : charging ? "charging" : moving ? "moving" : "waiting";
    return { r, moving, status };
  }), [vehicles, sampledAt, now]);

  const counts = useMemo(() => ({
    total: vehicles.length,
    moving: live.filter((x) => x.status === "moving").length,
    waiting: live.filter((x) => x.status === "waiting").length,
    charging: live.filter((x) => x.status === "charging").length,
    fault: live.filter((x) => x.status === "fault").length,
    low: vehicles.filter((r) => r.battery_pct != null && r.battery_pct <= 20).length,
    jobs: jobOf.size,
  }), [live, vehicles, jobOf]);

  const shown = live.filter((x) => filter === "all" || x.status === filter);
  const selected = vehicles.find((r) => r.id === selectedId) ?? null;
  const selectedJob = selected ? jobOf.get(selected.id) ?? null : null;
  const onMap = vehicles.filter((r) => r.floor_id === floorId);
  const floor = floorId != null ? floors[floorId] ?? null : null;
  const stationsHere = stations.filter((s) => (s.floor_id ?? floorIds[0]) === floorId);

  const select = (id: number | null) => {
    setSelectedId(id);
    const r = vehicles.find((x) => x.id === id);
    if (r && r.floor_id != null && r.floor_id !== floorId) setFloorId(r.floor_id);
  };

  if (!vehicles.length) {
    return (
      <Card>
        <NonIdealState icon="drive-time" title="Noch keine Fahrzeuge"
          description={admin
            ? "Lege das erste Transportfahrzeug an — AGV, AMR oder Stapler. Weg, Typ und Fähigkeiten lassen sich jederzeit ändern."
            : "Ein Admin kann hier die fahrende Flotte anlegen."}
          action={admin ? <Button intent="primary" icon="add" text="Neues Fahrzeug" onClick={onNew} /> : undefined} />
      </Card>
    );
  }

  const pose = selected ? robotPoseAt(selected, sampledAt, now) : null;
  const selLive = live.find((x) => x.r.id === selectedId);

  return (
    <>
      <KpiStrip label="Fahrende Flotte" items={[
        { id: "total", label: "Fahrzeuge", value: counts.total, primary: true,
          active: filter === "all", onClick: () => setFilter("all") },
        { id: "moving", label: "Fahren jetzt", value: counts.moving, tone: counts.moving ? "success" : "none", primary: true,
          active: filter === "moving", onClick: () => setFilter("moving") },
        { id: "jobs", label: "Transporte aktiv", value: counts.jobs, primary: true,
          onClick: () => navigate("roboter/transporte") },
        { id: "low", label: "Akku ≤ 20 %", value: counts.low, tone: counts.low ? "warning" : "none", primary: true },
        { id: "fault", label: "Störung", value: counts.fault, tone: counts.fault ? "danger" : "none",
          active: filter === "fault", onClick: () => setFilter("fault") },
        { id: "charging", label: "Laden", value: counts.charging,
          active: filter === "charging", onClick: () => setFilter("charging") },
      ]} />

      <div className="fleet-grid">
        <Card className="fleet-map-card">
          <div className="fleet-map-head">
            <div className="fleet-floors" role="tablist" aria-label="Ebene">
              {floorsWithVehicles.map((f) => (
                <button key={f.id} type="button" role="tab" aria-selected={f.id === floorId}
                        className={`fleet-floor${f.id === floorId ? " is-active" : ""}`}
                        onClick={() => { setFloorId(f.id); setSelectedId(null); }}>
                  {floorName(f.id)} <span className="mono">{f.n}</span>
                </button>
              ))}
              {vehicles.some((v) => v.floor_id == null) && (
                <span className="fleet-floor-note">{vehicles.filter((v) => v.floor_id == null).length} ohne Ebene</span>
              )}
            </div>
            <Button small minimal icon="map" text="Im Grundriss" onClick={() => onShowOnPlan(floorId)} />
          </div>
          <FleetMap floor={floor} stations={stationsHere} robots={onMap} sampledAt={sampledAt}
                    selectedId={selectedId} onSelect={select} job={selectedJob} />
        </Card>

        <aside className="fleet-side" aria-label="Fahrzeuge">
          {selected && selLive ? (
            <Card className="fleet-detail" aria-label={`Akte ${selected.name}`}>
              <div className="fleet-detail-head">
                <span className="fleet-swatch" style={{ background: routeColour(selected.id) }} />
                <div className="fleet-detail-title">
                  <h2>{selected.name}</h2>
                  <span className="sub">{kindLabel(selected.kind)}</span>
                </div>
                <Button small minimal icon="cross" aria-label="Auswahl aufheben" onClick={() => setSelectedId(null)} />
              </div>
              <div className="fleet-detail-tags">
                <Tag minimal intent={liveState(selected, selLive.moving).intent}>{liveState(selected, selLive.moving).label}</Tag>
                {selected.simulated ? <Tag minimal intent="primary">Simulation</Tag> : <Tag minimal icon="cloud">{selected.gateway_id}</Tag>}
                {selected.stale && <Tag minimal intent="warning">Meldung veraltet</Tag>}
              </div>
              <dl className="fleet-facts">
                <dt>Akku</dt><dd><Battery pct={selected.battery_pct} /></dd>
                <dt>Tempo</dt><dd className="mono">{selected.speed_m_s > 0 ? `${selected.speed_m_s.toLocaleString("de-DE")} m/s` : "—"}</dd>
                <dt>Nutzlast</dt><dd className="mono">{selected.payload_kg > 0 ? `${selected.payload_kg.toLocaleString("de-DE")} kg` : "—"}</dd>
                <dt>Weg</dt>
                <dd>{selected.route.length >= 2
                  ? <><span className="mono">{Math.round(selected.route_m)} m</span> · {selected.route_mode === "loop" ? "Rundkurs" : "Pendel"} · {selected.route.length} Punkte</>
                  : <span className="sub">kein Weg</span>}</dd>
                <dt>Ebene</dt><dd>{floorName(selected.floor_id)}</dd>
                <dt>Lage</dt><dd className="mono">{pose ? `x ${pose.x.toFixed(1)} · y ${pose.y.toFixed(1)} m` : "unbekannt"}</dd>
                <dt>Meldung</dt><dd>{selected.simulated ? "laufend (Fahrplan)" : fmtAge(selected.age_s)}</dd>
              </dl>
              {selected.sim_plan?.note && <p className="fleet-note"><Icon icon="info-sign" size={12} /> {selected.sim_plan.note}</p>}

              <div className="fleet-job">
                <span className="fleet-label">Transport</span>
                {selectedJob ? (
                  <div className="fleet-job-body">
                    <div><b>{JOB_KIND[selectedJob.kind] ?? selectedJob.kind}</b> <span className="mono sub">{selectedJob.ref}</span>
                      {" "}<Tag minimal intent={JOB_STATE[selectedJob.state]?.intent ?? "none"}>{JOB_STATE[selectedJob.state]?.label ?? selectedJob.state}</Tag></div>
                    <div className="fleet-job-way">
                      <span>{selectedJob.from?.label ?? "?"}</span><Icon icon="arrow-right" size={12} /><span>{selectedJob.to?.label ?? "?"}</span>
                    </div>
                    <div className="sub mono">
                      {Math.round(selectedJob.route_m)} m{selectedJob.eta_s > 0 ? ` · ca. ${Math.max(1, Math.round(selectedJob.eta_s / 60))} min` : ""}
                      {selectedJob.work_order_no ? ` · ${selectedJob.work_order_no}` : ""}
                    </div>
                  </div>
                ) : <span className="sub">kein laufender Transport</span>}
              </div>

              {selected.capabilities.length > 0 && (
                <div className="fleet-caps">
                  {selected.capabilities.map((c) => <Tag key={c} minimal>{capLabel(c)}</Tag>)}
                </div>
              )}
              <div className="fleet-actions">
                {admin && <Button small intent="primary" icon="route" text="Weg bearbeiten" onClick={() => onEditRoute(selected)}
                  disabled={selected.floor_id == null} title={selected.floor_id == null ? "Das Fahrzeug hat keine Ebene" : "Weg auf dem Grundriss zeichnen"} />}
                {admin && <Button small icon="edit" text="Bearbeiten" onClick={() => onEdit(selected)} />}
                <Button small icon="map" text="Im Grundriss" onClick={() => onShowOnPlan(selected.floor_id)} />
                <Button small icon="route" text="Transporte" onClick={() => navigate("roboter/transporte")} />
                {admin && <Button small minimal intent="danger" icon="trash" aria-label={`${selected.name} löschen`} onClick={() => onDelete(selected)} />}
              </div>
            </Card>
          ) : (
            <p className="fleet-pick-hint"><Icon icon="hand-up" size={12} /> Fahrzeug auf der Karte oder in der Liste wählen.</p>
          )}

          <div className="fleet-list-head">
            <ButtonGroup minimal className="fleet-filter" aria-label="Filter">
              {FILTERS.map((f) => (
                <Button key={f.id} small text={f.label} active={filter === f.id} aria-pressed={filter === f.id}
                        onClick={() => setFilter(f.id)} />
              ))}
            </ButtonGroup>
          </div>
          <ul className="fleet-list">
            {shown.map(({ r, moving }) => {
              const st = liveState(r, moving);
              const job = jobOf.get(r.id);
              return (
                <li key={r.id}>
                  <button type="button" className={`fleet-row${r.id === selectedId ? " is-selected" : ""}${r.active ? "" : " is-off"}`}
                          aria-pressed={r.id === selectedId} onClick={() => select(r.id === selectedId ? null : r.id)}>
                    <span className="fleet-swatch" style={{ background: routeColour(r.id) }} />
                    <span className="fleet-row-main">
                      <b>{r.name}</b>
                      <span className="sub">{kindShort(r.kind)} · {floorName(r.floor_id)}{job ? ` · ${job.to?.label ?? "Transport"}` : ""}</span>
                    </span>
                    <Tag minimal intent={st.intent}>{st.label}</Tag>
                    <Battery pct={r.battery_pct} />
                  </button>
                  {admin && (
                    <Button small minimal icon="edit" className="fleet-row-edit" aria-label={`${r.name} bearbeiten`} onClick={() => onEdit(r)} />
                  )}
                </li>
              );
            })}
            {!shown.length && <li className="sub fleet-empty">Kein Fahrzeug in diesem Filter.</li>}
          </ul>
        </aside>
      </div>
    </>
  );
}
