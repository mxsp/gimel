import {
  Button, Callout, Checkbox, Dialog, DialogBody, DialogFooter, FormGroup,
  HTMLSelect, Icon, InputGroup, NumericInput, Spinner, Switch, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, canAdminWork, getUser } from "../api";
import ArmCells from "../components/robots/ArmCells";
import FleetVehicles from "../components/robots/FleetVehicles";
import RobotGateways from "../components/robots/RobotGateways";
import RobotJobs from "../components/robots/RobotJobs";
import RobotPrograms from "../components/robots/RobotPrograms";
import RouteEditor from "../components/robots/RouteEditor";
import { pathLength as routeLength, routeText, type Pt } from "../components/robots/routeGeometry";
import { CAPABILITIES, isArm, KINDS, STATES } from "../components/robots/robotMeta";
import "../components/robots/robots.css";
import { Robot } from "../factory";
import { navigate } from "../router";
import { allFloors, floorLabel, useTopology } from "../sites";
import { toastError, toastInfo, toastSuccess } from "../toast";
import { PageInfo, pageInfo } from "../ui";

/* Roboter — die fahrende Flotte und die Arme mit ihren Zellen.

   Seit 2026-11-08 zwei Arbeitsbereiche statt einer Stammdatentabelle:
   - Fahrzeuge (AGV, AMR, Stapler): Lagekarte der Ebene mit den Fahrzeugen in
     Bewegung, Liste, Akte des gewählten Fahrzeugs mit laufendem Transport.
   - Arme & Zellen (Arm, Cobot): Leiste der Arme und darunter die Sortierzelle
     als 3D-Simulation (vorher im Twin Studio).
   Dazu wie bisher Transporte, Missionen und Gateways. Die Reiter sind Adressen
   (#/roboter/fahrzeuge, …/zellen, …/transporte, …/missionen, …/gateways).

   Geschrieben wird nur von Admins; die Halle liest dieselben Zeilen über
   ``/api/factory/robots``. Ein Roboter ist kein Arbeitsplatz: hier stehen
   Transportfähigkeit, Tempo, Nutzlast und ein Weg im Gangnetz. */

type Tab = "fahrzeuge" | "zellen" | "transporte" | "missionen" | "gateways";
const TABS: { id: Tab; label: string; icon: "drive-time" | "cube" | "route" | "code" | "cloud" }[] = [
  { id: "fahrzeuge", label: "Fahrzeuge", icon: "drive-time" },
  { id: "zellen", label: "Arme & Zellen", icon: "cube" },
  { id: "transporte", label: "Transporte", icon: "route" },
  { id: "missionen", label: "Missionen", icon: "code" },
  { id: "gateways", label: "Gateways", icon: "cloud" },
];
/** Alte Reiter-Namen (vor 2026-11-08) und Kurzformen. */
const TAB_ALIAS: Record<string, Tab> = { flotte: "fahrzeuge", fleet: "fahrzeuge", arme: "zellen", zelle: "zellen", jobs: "transporte", programs: "missionen" };
const tabOf = (sub: string): Tab => (TABS.some((t) => t.id === sub) ? sub as Tab : TAB_ALIAS[sub] ?? "fahrzeuge");

/** Neue Fahrzeuge fragen alle 5 s nach; simulierte laufen dazwischen nach Fahrplan weiter. */
const POLL_MS = 5_000;

interface Draft {
  id?: number;
  name: string;
  kind: string;
  floor_id: number | null;
  routeText: string;
  route_mode: "loop" | "pingpong";
  speed: string;
  batteryText: string;
  state: string;
  gateway_id: string;
  capabilities: string[];
  payload: string;
  active: boolean;
}

const blank = (floorId: number | null, kind = "agv"): Draft => ({
  name: "",
  kind,
  floor_id: floorId,
  routeText: "",
  route_mode: "pingpong",
  speed: "0.8",
  batteryText: "",
  state: "idle",
  gateway_id: "sim",
  capabilities: kind === "arm" || kind === "cobot" ? ["arm", "pick"] : ["transport"],
  payload: "0",
  active: true,
});

const fromRobot = (r: Robot): Draft => ({
  id: r.id,
  name: r.name,
  kind: r.kind || "agv",
  floor_id: r.floor_id,
  routeText: r.route.map(([x, y]) => `${x}, ${y}`).join("\n"),
  route_mode: r.route_mode,
  speed: String(r.speed_m_s ?? 0),
  batteryText: r.battery_pct == null ? "" : String(r.battery_pct),
  state: r.state,
  gateway_id: r.gateway_id || "sim",
  capabilities: [...(r.capabilities ?? [])],
  payload: String(r.payload_kg ?? 0),
  active: r.active,
});

function parseRoute(text: string): { route: [number, number][]; error: string } {
  const route: [number, number][] = [];
  const parts = text.split(/[\n;]+/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const [xs, ys] = part.split(/[, ]+/);
    const x = Number(xs), y = Number(ys);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { route: [], error: `„${part}“ ist kein Punkt. Bitte „x, y“ je Zeile schreiben.` };
    }
    route.push([x, y]);
  }
  if (route.length === 1) return { route: [], error: "Ein Weg braucht mindestens zwei Punkte." };
  return { route, error: "" };
}

function pathLength(route: [number, number][], mode: "loop" | "pingpong"): number {
  if (route.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < route.length; i++) {
    sum += Math.hypot(route[i + 1][0] - route[i][0], route[i + 1][1] - route[i][1]);
  }
  if (mode === "loop" && route.length >= 2) {
    sum += Math.hypot(route[0][0] - route[route.length - 1][0], route[0][1] - route[route.length - 1][1]);
  }
  return sum;
}

function RoutePreview({ route, mode }: { route: [number, number][]; mode: "loop" | "pingpong" }) {
  if (route.length < 2) {
    return <div className="robot-route-empty">Noch kein Weg — zwei Punkte eintragen, dann erscheint die Vorschau.</div>;
  }
  const xs = route.map((p) => p[0]), ys = route.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const pad = 12, w = 220, h = 130;
  const sx = (x: number) => pad + ((x - minX) / spanX) * (w - pad * 2);
  const sy = (y: number) => h - pad - ((y - minY) / spanY) * (h - pad * 2);
  const points = route.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(" ");
  const closed = mode === "loop" ? `${sx(route[0][0]).toFixed(1)},${sy(route[0][1]).toFixed(1)}` : "";
  return (
    <svg className="robot-route-preview" viewBox={`0 0 ${w} ${h}`} role="img"
         aria-label={`Wegvorschau, ${route.length} Punkte, ${Math.round(pathLength(route, mode))} Meter`}>
      <rect x="0" y="0" width={w} height={h} rx="4" className="robot-route-bg" />
      <polyline points={points + (closed ? ` ${closed}` : "")} fill="none"
                className="robot-route-line" />
      {route.map(([x, y], i) => (
        <circle key={i} cx={sx(x)} cy={sy(y)} r={i === 0 ? 4 : 2.6}
                className={i === 0 ? "robot-route-start" : "robot-route-point"} />
      ))}
      <text x={pad} y={h - 4} className="robot-route-caption">
        {route.length} Punkte · {Math.round(pathLength(route, mode))} m
      </text>
    </svg>
  );
}

export default function Robots({ sub = "" }: { sub?: string }) {
  const tab = tabOf(sub);
  const site = useTopology();
  const floors = useMemo(() => allFloors(site.topo), [site.topo]);
  const admin = canAdminWork(getUser());
  const [robots, setRobots] = useState<Robot[]>([]);
  const [sampledAt, setSampledAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [deleting, setDeleting] = useState<Robot | null>(null);
  const [busy, setBusy] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  /** Wege-Editor: für den Dialog (Entwurf) oder direkt für ein gespeichertes Fahrzeug. */
  const [routeEdit, setRouteEdit] = useState<{ robot?: Robot } | null>(null);
  const [routeSaving, setRouteSaving] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api<{ robots: Robot[]; sampled_at?: string }>("/api/factory/robots");
      setRobots(r.robots ?? []);
      setSampledAt(r.sampled_at ?? new Date().toISOString());
      setError("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (!silent) toastError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Lebende Flotte: leise nachfragen, solange die Seite sichtbar und kein Dialog offen ist.
  useEffect(() => {
    if (tab !== "fahrzeuge" && tab !== "zellen") return;
    const id = window.setInterval(() => { if (!document.hidden && !draft && !routeEdit) void load(true); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [load, tab, draft, routeEdit]);

  const floorName = useCallback((id: number | null) => {
    if (id == null) return "ohne Ebene";
    const ref = floors.find((f) => f.floor.id === id);
    return ref ? floorLabel(ref, true) : `Ebene #${id}`;
  }, [floors]);
  const floorIds = useMemo(() => floors.map((f) => f.floor.id), [floors]);

  const vehicles = useMemo(() => robots.filter((r) => !isArm(r)), [robots]);
  const arms = useMemo(() => robots.filter(isArm), [robots]);
  const simulated = robots.filter((r) => r.simulated).length;

  const openNew = (kind = tab === "zellen" ? "arm" : "agv") => {
    setFormError("");
    setDraft(blank(site.floorId ?? floors[0]?.floor.id ?? null, kind));
  };
  const openEdit = (r: Robot) => {
    setFormError("");
    setDraft(fromRobot(r));
  };
  const showOnPlan = (floorId: number | null) => {
    if (floorId != null) site.setFloorId(floorId);
    navigate("grundriss");
  };

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  /* Weg aus dem Editor übernehmen: in den Entwurf des Dialogs, oder — aus der
     Fahrzeug-Akte geöffnet — sofort speichern (PUT braucht die ganze Zeile). */
  const applyRoute = async (route: Pt[], mode: "loop" | "pingpong") => {
    const target = routeEdit?.robot;
    if (!target) {
      patch({ routeText: routeText(route), route_mode: mode });
      setRouteEdit(null);
      return;
    }
    setRouteSaving(true);
    try {
      await api(`/api/factory/robots/${target.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: target.name, kind: target.kind, floor_id: target.floor_id, route, route_mode: mode,
          speed_m_s: target.speed_m_s, battery_pct: target.battery_pct, state: target.state,
          gateway_id: target.gateway_id || "sim", capabilities: target.capabilities,
          payload_kg: target.payload_kg, active: target.active,
        }),
      });
      toastSuccess(`Weg von ${target.name} gespeichert: ${Math.round(routeLength(route, mode === "loop"))} m.`);
      setRouteEdit(null);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setRouteSaving(false);
    }
  };

  /* Den Weg im Dialog verbessern, bevor er gespeichert wird: über das Gangnetz,
     nie durch ein Hindernis oder eine Station. Der Vorschlag ersetzt nur den
     Text im Formular — geschrieben wird erst mit „Speichern". */
  const optimizeRoute = async () => {
    if (!draft) return;
    const { route, error: routeError } = parseRoute(draft.routeText);
    if (routeError) { setFormError(routeError); return; }
    if (route.length < 2) { setFormError("Ein Weg braucht mindestens zwei Punkte."); return; }
    if (draft.floor_id == null) {
      setFormError("Weg optimieren braucht eine Ebene — der Gang liegt in einer Halle.");
      return;
    }
    setOptimizing(true);
    setFormError("");
    try {
      const r = await api<{
        route: [number, number][]; changed: boolean;
        metres_before: number; metres_after: number; notes: string[];
      }>("/api/factory/robot-ways/optimize", {
        method: "POST",
        body: JSON.stringify({
          floor_id: draft.floor_id, points: route, loop: draft.route_mode === "loop",
        }),
      });
      patch({ routeText: r.route.map(([x, y]) => `${x}, ${y}`).join("\n") });
      if (!r.changed) toastInfo("Der Weg ist schon optimal.");
      else toastSuccess(`Weg optimiert: ${Math.round(r.metres_before)} m → ${Math.round(r.metres_after)} m.`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setFormError(msg);
      toastError(msg);
    } finally {
      setOptimizing(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { setFormError("Der Roboter braucht einen Namen."); return; }
    const { route, error: routeError } = parseRoute(draft.routeText);
    if (routeError) { setFormError(routeError); return; }
    const speed = Number(draft.speed);
    const payload = Number(draft.payload);
    if (!Number.isFinite(speed) || speed < 0) { setFormError("Die Geschwindigkeit muss eine Zahl ≥ 0 sein."); return; }
    if (!Number.isFinite(payload) || payload < 0) { setFormError("Die Nutzlast muss eine Zahl ≥ 0 sein."); return; }
    const batteryText = draft.batteryText.trim();
    const battery = batteryText === "" ? null : Number(batteryText);
    if (battery != null && (!Number.isFinite(battery) || battery < 0 || battery > 100)) {
      setFormError("Der Akku liegt zwischen 0 und 100 % — leer heißt unbekannt.");
      return;
    }
    const body = {
      name,
      kind: draft.kind,
      floor_id: draft.floor_id,
      route,
      route_mode: draft.route_mode,
      speed_m_s: speed,
      battery_pct: battery,
      state: draft.state,
      gateway_id: draft.gateway_id.trim() || "sim",
      capabilities: draft.capabilities,
      payload_kg: payload,
      active: draft.active,
    };
    setSaving(true);
    setFormError("");
    try {
      if (draft.id != null) {
        await api(`/api/factory/robots/${draft.id}`, { method: "PUT", body: JSON.stringify(body) });
        toastSuccess(`${name} gespeichert.`);
      } else {
        await api("/api/factory/robots", { method: "POST", body: JSON.stringify(body) });
        toastSuccess(`${name} angelegt.`);
      }
      setDraft(null);
      await load(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setFormError(msg);
      toastError(msg);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/api/factory/robots/${deleting.id}`, { method: "DELETE" });
      toastSuccess(`${deleting.name} gelöscht.`);
      setDeleting(null);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !robots.length) return <div className="twin-center"><Spinner size={36} /></div>;

  const draftIsArm = draft ? /^(arm|cobot)$/.test(draft.kind) : false;
  const count: Partial<Record<Tab, number>> = { fahrzeuge: vehicles.length, zellen: arms.length };

  return (
    <div className="robots-page">
      <div className="twin-head">
        <div>
          <div className="ui-page-title-row"><h1 className="page-title">Roboter</h1><PageInfo text={pageInfo("roboter")} /></div>
          <p className="page-sub">
            {tab === "zellen"
              ? "Stationäre Arme der Halle."
              : "Die fahrende Flotte live auf der Ebene — dieselben Fahrzeuge wie im Digitalen Grundriss."}
            {simulated > 0 && " Virtuelle Roboter sind als Simulation markiert."}
          </p>
        </div>
        <div className="twin-head-actions">
          <Button icon="refresh" text="Aktualisieren" onClick={() => load()} />
          {admin && (tab === "fahrzeuge" || tab === "zellen") && (
            <Button intent="primary" icon="add" text={tab === "zellen" ? "Neuer Arm" : "Neues Fahrzeug"} onClick={() => openNew()} />
          )}
        </div>
      </div>

      <nav className="robot-tabs" aria-label="Roboterbereich">
        {TABS.map((t) => (
          <a key={t.id} href={`#/roboter/${t.id}`} className={`robot-tab${tab === t.id ? " is-active" : ""}`}
             aria-current={tab === t.id ? "page" : undefined}>
            <Icon icon={t.icon} size={14} />
            {t.label}
            {count[t.id] != null && <span className="robot-tab-count mono">{count[t.id]}</span>}
          </a>
        ))}
      </nav>

      {error && (tab === "fahrzeuge" || tab === "zellen") && (
        <Callout intent="warning" icon="warning-sign" className="mb">
          Die Flotte ließ sich nicht laden: {error}
        </Callout>
      )}

      {tab === "fahrzeuge" && (
        <FleetVehicles vehicles={vehicles} sampledAt={sampledAt} floorName={floorName} floorIds={floorIds}
          defaultFloorId={site.floorId ?? floorIds[0] ?? null} admin={admin}
          onEdit={openEdit} onDelete={setDeleting} onNew={() => openNew("agv")} onShowOnPlan={showOnPlan}
          onEditRoute={(r) => setRouteEdit({ robot: r })} />
      )}
      {tab === "zellen" && (
        <ArmCells arms={arms} floorName={floorName} admin={admin}
          onEdit={openEdit} onNew={() => openNew("arm")} onShowOnPlan={showOnPlan} />
      )}
      {tab === "transporte" && <RobotJobs robots={robots} onChanged={() => load(true)} />}
      {tab === "missionen" && <RobotPrograms robots={robots} />}
      {tab === "gateways" && <RobotGateways />}

      <Dialog isOpen={draft != null} onClose={() => !saving && setDraft(null)}
              title={draft?.id != null ? `${draft.name || "Roboter"} bearbeiten` : draftIsArm ? "Neuer Arm" : "Neues Fahrzeug"} className="robot-dialog">
        {draft && (
          <>
            <DialogBody>
              <Callout compact intent="primary" icon="info-sign" className="mb">
                {draftIsArm
                  ? "Ein Arm steht fest an seiner Zelle. Typ und Fähigkeiten beschreiben, was er greifen kann; einen Weg braucht er nicht."
                  : "Ein Fahrzeug ist kein Arbeitsplatz. Typ und Fähigkeiten beschreiben, was es transportieren kann; der Weg liegt auf dem Gangnetz der Halle."}
              </Callout>
              <div className="robot-form-grid">
                <FormGroup label="Name" labelFor="robot-name" labelInfo="Pflicht">
                  <InputGroup id="robot-name" value={draft.name} autoFocus
                    onChange={(e) => patch({ name: e.currentTarget.value })} placeholder={draftIsArm ? "z. B. Arm Sortierung" : "z. B. AGV 3"} />
                </FormGroup>
                <FormGroup label="Typ" labelFor="robot-kind">
                  <HTMLSelect id="robot-kind" fill value={draft.kind}
                    onChange={(e) => patch({ kind: e.currentTarget.value })}>
                    {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </HTMLSelect>
                  <span className="sub">{KINDS.find((k) => k.value === draft.kind)?.hint}</span>
                </FormGroup>
                <FormGroup label="Ebene" labelFor="robot-floor">
                  <HTMLSelect id="robot-floor" fill value={draft.floor_id == null ? "" : String(draft.floor_id)}
                    onChange={(e) => patch({ floor_id: e.currentTarget.value === "" ? null : Number(e.currentTarget.value) })}>
                    <option value="">ohne Ebene</option>
                    {floors.map((f) => <option key={f.floor.id} value={f.floor.id}>{floorLabel(f, true)}</option>)}
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="Status" labelFor="robot-state">
                  <HTMLSelect id="robot-state" fill value={draft.state}
                    onChange={(e) => patch({ state: e.currentTarget.value })}>
                    {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="Tempo (m/s)" labelFor="robot-speed">
                  <NumericInput id="robot-speed" fill min={0} stepSize={0.1} minorStepSize={0.1}
                    value={draft.speed} onValueChange={(v) => patch({ speed: String(v ?? 0) })} />
                </FormGroup>
                <FormGroup label="Akku (%)" labelFor="robot-battery" helperText="Leer = unbekannt, nicht 0 %.">
                  <InputGroup id="robot-battery" value={draft.batteryText} placeholder="unbekannt"
                    onChange={(e) => patch({ batteryText: e.currentTarget.value })} />
                </FormGroup>
                <FormGroup label="Nutzlast (kg)" labelFor="robot-payload">
                  <NumericInput id="robot-payload" fill min={0} stepSize={10}
                    value={draft.payload} onValueChange={(v) => patch({ payload: String(v ?? 0) })} />
                </FormGroup>
                <FormGroup label="Gateway" labelFor="robot-gateway"
                           helperText="sim = virtuelle Fahrt; ein echter Name kommt vom Flotten-Gateway.">
                  <InputGroup id="robot-gateway" value={draft.gateway_id}
                    onChange={(e) => patch({ gateway_id: e.currentTarget.value })} placeholder="sim" />
                </FormGroup>
                <FormGroup label="Betrieb">
                  <Switch checked={draft.active} label="aktiv"
                    onChange={(e) => patch({ active: e.currentTarget.checked })} />
                </FormGroup>
                <FormGroup label="Wegart" labelFor="robot-mode">
                  <HTMLSelect id="robot-mode" fill value={draft.route_mode}
                    onChange={(e) => patch({ route_mode: e.currentTarget.value as "loop" | "pingpong" })}>
                    <option value="pingpong">Pendel — hin und zurück</option>
                    <option value="loop">Rundkurs — letzter Punkt schließt zum ersten</option>
                  </HTMLSelect>
                </FormGroup>
              </div>

              <FormGroup label="Fähigkeiten" labelFor="robot-caps"
                         helperText="Was der Roboter kann — nicht, wo er steht.">
                <div id="robot-caps" className="robot-caps">
                  {CAPABILITIES.map((c) => (
                    <Checkbox key={c.value} label={c.label}
                      checked={draft.capabilities.includes(c.value)}
                      onChange={(e) => patch({
                        capabilities: e.currentTarget.checked
                          ? [...draft.capabilities, c.value]
                          : draft.capabilities.filter((x) => x !== c.value),
                      })} />
                  ))}
                </div>
              </FormGroup>

              {!draftIsArm && <div className="robot-route-editor">
                <div className="robot-route-main">
                  <span className="robot-route-label">Weg</span>
                  <button type="button" className="robot-route-open" onClick={() => setRouteEdit({})}
                          disabled={draft.floor_id == null} aria-label="Weg auf dem Grundriss bearbeiten">
                    <RoutePreview route={parseRoute(draft.routeText).route} mode={draft.route_mode} />
                  </button>
                  <div className="robot-route-actions">
                    <Button intent="primary" icon="route" text="Weg bearbeiten" disabled={draft.floor_id == null}
                      title={draft.floor_id == null ? "Erst eine Ebene wählen" : "Auf dem Grundriss zeichnen: Punkte setzen, ziehen, einfügen, Gang folgen"}
                      onClick={() => setRouteEdit({})} />
                    <Button small icon="clean" text="Optimieren" loading={optimizing}
                      onClick={() => void optimizeRoute()}
                      title="Rechnet den Weg über das Gangnetz, um Hindernisse und Stationen herum — noch nichts gespeichert." />
                  </div>
                </div>
                <FormGroup label="Punkte als Text" labelFor="robot-route"
                           helperText="Ein Punkt je Zeile als „x, y“ in Metern — oder oben im Editor zeichnen.">
                  <TextArea id="robot-route" rows={6} fill value={draft.routeText}
                    onChange={(e) => patch({ routeText: e.currentTarget.value })}
                    placeholder={"6, 16\n14, 16\n22, 16"} />
                </FormGroup>
              </div>}
              {formError && <Callout compact intent="danger" icon="error" className="mb">{formError}</Callout>}
            </DialogBody>
            <DialogFooter actions={
              <>
                <Button text="Abbrechen" disabled={saving} onClick={() => setDraft(null)} />
                <Button intent="primary" icon="floppy-disk" text={draft.id != null ? "Speichern" : "Anlegen"}
                  loading={saving} onClick={save} />
              </>
            } />
          </>
        )}
      </Dialog>

      <Dialog isOpen={deleting != null} onClose={() => !busy && setDeleting(null)}
              title="Roboter löschen" className="robot-dialog-small">
        <DialogBody>
          <p>Soll <b>{deleting?.name}</b> wirklich gelöscht werden? Der Roboter verschwindet aus der Halle;
             ein laufender Transport wird nicht gestoppt.</p>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" disabled={busy} onClick={() => setDeleting(null)} />
            <Button intent="danger" icon="trash" text="Löschen" loading={busy} onClick={remove} />
          </>
        } />
      </Dialog>
      <RouteEditor isOpen={routeEdit != null}
        robotName={routeEdit?.robot?.name ?? draft?.name ?? ""}
        robotId={routeEdit?.robot?.id ?? draft?.id}
        floorId={routeEdit?.robot ? routeEdit.robot.floor_id : draft?.floor_id ?? null}
        floorLabel={floorName(routeEdit?.robot ? routeEdit.robot.floor_id : draft?.floor_id ?? null)}
        route={(routeEdit?.robot ? routeEdit.robot.route : parseRoute(draft?.routeText ?? "").route) as Pt[]}
        mode={routeEdit?.robot ? routeEdit.robot.route_mode : draft?.route_mode ?? "pingpong"}
        speed={routeEdit?.robot ? routeEdit.robot.speed_m_s : Number(draft?.speed) || 0}
        others={vehicles} defaultFloorId={floorIds[0] ?? null} saving={routeSaving}
        onClose={() => setRouteEdit(null)} onApply={(r, m) => void applyRoute(r, m)} />
    </div>
  );
}
