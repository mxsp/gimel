import { useCallback, useEffect, useState } from "react";
import {
  Button, Callout, FormGroup, HTMLSelect, InputGroup, Menu, MenuItem, NumericInput, Switch, Tag,
} from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import { api, canAdminWork, getUser } from "../api";
import { toastError, toastInfo, toastSuccess } from "../toast";
import {
  DEFAULT_PARAMS, fmtWait, PlannedRobot, SimParams, SimResult,
} from "../components/twin/fleetSim";

/* Simulation geplanter Roboter: Flotte zusammenstellen, Schicht rechnen,
   Ergebnis lesen, im 3D abspielen. Die geplanten Roboter gibt es nur hier und
   in gespeicherten Szenarien — sie bekommen nie einen echten Transport. */

interface Defaults {
  floor_id: number;
  per_shift: number;
  basis: string;
  edges: number;
  start: [number, number];
  existing: { id: number; name: string; kind: string; speed_m_s: number; simulated: boolean }[];
  limits: { robots: number; per_shift: number; horizon_h: number; sizing: number };
}

interface Scenario {
  id: number;
  floor_id: number | null;
  name: string;
  params: SimParams;
  created_by: string;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

export default function SimPanel({ floorId, result, onResult }: {
  floorId: number | null;
  result: SimResult | null;
  onResult: (r: SimResult | null) => void;
}) {
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [params, setParams] = useState<SimParams>(DEFAULT_PARAMS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [saveName, setSaveName] = useState("");
  const [baseline, setBaseline] = useState<{ label: string; summary: SimResult["summary"] } | null>(null);
  const user = getUser();

  const exportCsv = () => {
    if (!result) return;
    const sum = result.summary;
    const lines = [
      ["Kennzahl", "Wert"],
      ["Erledigt", String(sum.served)],
      ["Bedarf", String(sum.demands)],
      ["Offen", String(sum.unserved)],
      ["Warten Mittel (s)", String(Math.round(sum.wait_mean_s))],
      ["Warten P90 (s)", String(Math.round(sum.wait_p90_s))],
      ["Transporte/h", String(sum.per_hour)],
      ["Leerfahrtanteil (%)", String(Math.round(sum.empty_share * 100))],
      ["Begegnungen", String(sum.encounters)],
      ["Zu spät", String(sum.late)],
      [],
      ["Roboter", "Typ", "Geplant", "Auslastung (%)", "Aufträge"],
      ...sum.robots.map((r) => [r.name, r.kind, r.planned ? "ja" : "nein", String(Math.round(r.utilisation * 100)), String(r.jobs)]),
    ];
    const csv = "\uFEFF" + lines.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `flottensimulation-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    toastSuccess("Simulation als CSV exportiert.");
  };

  const deltaText = (cur: number, base: number, unit: string, lowerIsBetter = true): { text: string; tone: "good" | "bad" | "neutral" } | null => {
    const diff = cur - base;
    if (Math.abs(diff) < 0.01) return null;
    const sign = diff > 0 ? "+" : "";
    const good = lowerIsBetter ? diff < 0 : diff > 0;
    return { text: `${sign}${Math.round(diff)}${unit}`, tone: good ? "good" : "bad" };
  };

  useEffect(() => {
    if (!floorId) return;
    let live = true;
    setError("");
    api<Defaults>(`/api/factory/fleet-sim/defaults?floor_id=${floorId}`)
      .then((d) => {
        if (!live) return;
        setDefaults(d);
        setParams((p) => ({ ...p, per_shift: d.per_shift > 0 ? d.per_shift : p.per_shift }));
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [floorId]);

  const loadScenarios = useCallback(async () => {
    if (!floorId) return;
    try { setScenarios(await api<Scenario[]>(`/api/factory/fleet-sim/scenarios?floor_id=${floorId}`)); }
    catch { setScenarios([]); }
  }, [floorId]);
  useEffect(() => { loadScenarios(); }, [loadScenarios]);

  const set = <K extends keyof SimParams>(k: K, v: SimParams[K]) => setParams((p) => ({ ...p, [k]: v }));
  const setRobot = (i: number, patch: Partial<PlannedRobot>) =>
    setParams((p) => ({ ...p, planned: p.planned.map((r, k) => (k === i ? { ...r, ...patch } : r)) }));
  const total = params.planned.reduce((n, r) => n + r.count, 0);

  const run = async (override?: SimParams) => {
    const body = override ?? params;
    if (!floorId) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<SimResult>("/api/factory/fleet-sim/run", {
        method: "POST", body: JSON.stringify({ floor_id: floorId, params: body }),
      });
      onResult(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onResult(null);
    } finally { setBusy(false); }
  };

  const save = async () => {
    const name = saveName.trim();
    if (!name || !floorId) return;
    try {
      await api("/api/factory/fleet-sim/scenarios", {
        method: "POST", body: JSON.stringify({ floor_id: floorId, name, params }),
      });
      toastSuccess(`Szenario „${name}" gespeichert`);
      setSaveName("");
      loadScenarios();
    } catch (e) { toastError(e instanceof Error ? e.message : String(e)); }
  };
  const remove = async (sc: Scenario) => {
    try {
      await api(`/api/factory/fleet-sim/scenarios/${sc.id}`, { method: "DELETE" });
      toastInfo(`Szenario „${sc.name}" gelöscht`);
      loadScenarios();
    } catch (e) { toastError(e instanceof Error ? e.message : String(e)); }
  };
  const open = (sc: Scenario) => {
    const p = { ...DEFAULT_PARAMS, ...sc.params };
    setParams(p);
    run(p);
  };

  const s = result?.summary;
  const sizing = result?.sizing;

  return (
    <div className="sim-panel">
      <Callout intent="primary" icon="predictive-analysis" className="sim-note">
        Was wäre, wenn diese Roboter heute führen? Gerechnet mit dem echten Materialfluss dieser Ebene — die geplanten
        Roboter bekommen nie einen echten Auftrag.
      </Callout>

      <section className="sim-section" aria-labelledby="sim-fleet">
        <h3 id="sim-fleet">Geplante Flotte <Tag minimal round>{total}</Tag></h3>
        {params.planned.map((r, i) => (
          <div className="sim-robot" key={i}>
            <InputGroup aria-label={`Name Gruppe ${i + 1}`} value={r.name} maxLength={60}
              onChange={(e) => setRobot(i, { name: e.target.value })} />
            <HTMLSelect aria-label={`Typ Gruppe ${i + 1}`} value={r.kind}
              onChange={(e) => setRobot(i, { kind: e.target.value as PlannedRobot["kind"] })}
              options={[{ value: "amr", label: "AMR" }, { value: "agv", label: "AGV" }]} />
            <NumericInput aria-label={`Anzahl Gruppe ${i + 1}`} min={1} max={8} value={r.count} buttonPosition="none"
              onValueChange={(v) => setRobot(i, { count: Math.max(1, Math.min(8, Math.round(v) || 1)) })} />
            <NumericInput aria-label={`Geschwindigkeit Gruppe ${i + 1} in Meter je Sekunde`} min={0.2} max={3}
              stepSize={0.1} minorStepSize={0.05} value={r.speed_m_s} buttonPosition="none" rightElement={<span className="sim-unit">m/s</span>}
              onValueChange={(v) => setRobot(i, { speed_m_s: Number.isFinite(v) ? Math.max(0.2, Math.min(3, v)) : 1 })} />
            <Button minimal icon="trash" aria-label={`Gruppe ${r.name} entfernen`} disabled={params.planned.length <= 1}
              onClick={() => set("planned", params.planned.filter((_, k) => k !== i))} />
          </div>
        ))}
        <Button small icon="add" text="Robotergruppe" disabled={params.planned.length >= 6 || total >= 12}
          onClick={() => set("planned", [...params.planned, { name: "AGV", kind: "agv", speed_m_s: 0.9, count: 1 }])} />
        {defaults && defaults.existing.length > 0 && (
          <Switch className="sim-switch" checked={params.include_existing}
            label={`Vorhandene Roboter mitrechnen (${defaults.existing.length})`}
            onChange={() => set("include_existing", !params.include_existing)} />
        )}
      </section>

      <section className="sim-section" aria-labelledby="sim-demand">
        <h3 id="sim-demand">Bedarf und Schicht</h3>
        <div className="sim-grid">
          <FormGroup label="Transporte je Schicht" labelFor="sim-per-shift" helperText={defaults ? `≈ ${defaults.per_shift} aus ${defaults.basis}` : undefined}>
            <NumericInput id="sim-per-shift" fill min={1} max={600} value={params.per_shift} buttonPosition="none"
              onValueChange={(v) => set("per_shift", Math.max(1, Math.min(600, Math.round(v) || 1)))} />
          </FormGroup>
          <FormGroup label="Mehr Aufträge" labelFor="sim-load">
            <HTMLSelect id="sim-load" fill value={String(params.load_factor)}
              onChange={(e) => set("load_factor", Number(e.target.value))}
              options={[["0.5", "halb so viel"], ["1", "wie heute"], ["1.5", "+50 %"], ["2", "doppelt"], ["3", "dreifach"], ["5", "fünffach"], ["10", "zehnfach"]]
                .map(([value, label]) => ({ value, label }))} />
          </FormGroup>
          <FormGroup label="Schicht" labelFor="sim-horizon">
            <NumericInput id="sim-horizon" fill min={0.5} max={12} stepSize={0.5} value={params.horizon_h} buttonPosition="none"
              rightElement={<span className="sim-unit">h</span>}
              onValueChange={(v) => set("horizon_h", Number.isFinite(v) ? Math.max(0.5, Math.min(12, v)) : 8)} />
          </FormGroup>
          <FormGroup label="Laden + Entladen" labelFor="sim-handling">
            <NumericInput id="sim-handling" fill min={0} max={900} stepSize={10} value={params.handling_s} buttonPosition="none"
              rightElement={<span className="sim-unit">s</span>}
              onValueChange={(v) => set("handling_s", Number.isFinite(v) ? Math.max(0, Math.min(900, v)) : 60)} />
          </FormGroup>
          <FormGroup label="Ziel: 90 % warten höchstens" labelFor="sim-target">
            <NumericInput id="sim-target" fill min={1} max={240} value={params.wait_target_min} buttonPosition="none"
              rightElement={<span className="sim-unit">min</span>}
              onValueChange={(v) => set("wait_target_min", Number.isFinite(v) ? Math.max(1, Math.min(240, v)) : 10)} />
          </FormGroup>
          <FormGroup label="Startwert" labelFor="sim-seed" helperText="Gleicher Wert, gleiche Schicht.">
            <NumericInput id="sim-seed" fill min={0} max={99999} value={params.seed} buttonPosition="none"
              onValueChange={(v) => set("seed", Math.max(0, Math.min(99999, Math.round(v) || 0)))} />
          </FormGroup>
        </div>
        <div className="sim-actions">
          <Button intent="primary" icon="play" text={result ? "Neu rechnen" : "Simulieren"} loading={busy}
            disabled={!floorId || !defaults || defaults.edges === 0} onClick={() => run()} />
          <Button icon="random" text="Andere Schicht" disabled={busy || !result}
            onClick={() => { const p = { ...params, seed: (params.seed + 1) % 100000 }; setParams(p); run(p); }} />
          {result && <Button minimal icon="cross" text="Beenden" onClick={() => onResult(null)} />}
        </div>
        {defaults && defaults.edges === 0 && (
          <p className="sim-muted">Auf dieser Ebene gibt es keinen Materialfluss — es gibt nichts zu transportieren.</p>
        )}
        {error && <Callout intent="danger" className="sim-note">{error}</Callout>}
      </section>

      {s && (
        <section className="sim-section" aria-labelledby="sim-result" aria-live="polite">
          <div className="sim-result-head">
            <h3 id="sim-result">Ergebnis der Schicht</h3>
            <div className="sim-result-tools">
              <Button small minimal icon="comparison"
                text={baseline ? "Vergleich erneuern" : "Als Vergleich merken"}
                onClick={() => {
                  setBaseline({ label: `${total} Roboter · Seed ${params.seed}`, summary: s });
                  toastInfo("Aktueller Lauf als Vergleichsbasis gemerkt.");
                }} />
              {baseline && (
                <Button small minimal icon="cross" aria-label="Vergleich entfernen" title="Vergleich entfernen"
                  onClick={() => setBaseline(null)} />
              )}
              <Button small minimal icon="export" text="CSV" title="Ergebnis als CSV herunterladen" onClick={exportCsv} />
            </div>
          </div>
          {baseline && (
            <p className="sim-baseline-note">
              Vergleich gegen <b>{baseline.label}</b>:
              {(() => {
                const dP90 = deltaText(s.wait_p90_s / 60, baseline.summary.wait_p90_s / 60, " min P90", true);
                const dEmp = deltaText(s.empty_share * 100, baseline.summary.empty_share * 100, " % Leerfahrt", true);
                const dEnc = deltaText(s.encounters, baseline.summary.encounters, " Begegn.", true);
                const parts = [dP90, dEmp, dEnc].filter(Boolean);
                if (!parts.length) return <span> identische Kennzahlen</span>;
                return parts.map((d, i) => (
                  <Tag key={i} minimal intent={d!.tone === "good" ? "success" : "danger"} className="sim-tag">{d!.text}</Tag>
                ));
              })()}
            </p>
          )}
          <dl className="sim-kpis">
            <div><dt>Erledigt</dt><dd>{s.served} / {s.demands}</dd></div>
            <div className={s.unserved ? "is-bad" : ""}><dt>Offen am Schichtende</dt><dd>{s.unserved}</dd></div>
            <div><dt>Warten Ø</dt><dd>≈ {fmtWait(s.wait_mean_s)}</dd></div>
            <div className={s.wait_p90_s > params.wait_target_min * 60 ? "is-bad" : "is-good"}>
              <dt>Warten 90 %</dt><dd>≈ {fmtWait(s.wait_p90_s)}</dd></div>
            <div><dt>Je Stunde</dt><dd>{s.per_hour.toLocaleString("de-DE")}</dd></div>
            <div><dt>Leerfahrt</dt><dd>{pct(s.empty_share)}</dd></div>
            <div className={s.encounters ? "is-warn" : ""}><dt>Begegnungen</dt><dd>{s.encounters}</dd></div>
            <div><dt>Zu spät</dt><dd>{s.late}</dd></div>
          </dl>
          <ul className="sim-robots">
            {s.robots.map((r) => (
              <li key={r.id}>
                <span className="sim-robot-name">{r.name}{!r.planned && <Tag minimal className="sim-tag">vorhanden</Tag>}</span>
                <span className="sim-bar" role="img" aria-label={`Auslastung ${pct(r.utilisation)}`}>
                  <span style={{ width: pct(r.utilisation) }} data-hot={r.utilisation > 0.85 ? "1" : undefined} />
                </span>
                <span className="mono sim-robot-num">{pct(r.utilisation)} · {r.jobs}×</span>
              </li>
            ))}
          </ul>
          {sizing && sizing.rows.length > 0 && (
            <div className="sim-sizing">
              <h4>Wie viele {params.planned[0]?.name || "Roboter"}?</h4>
              <table className="sim-table">
                <thead><tr><th scope="col">Anzahl</th><th scope="col">90 % warten</th><th scope="col">Offen</th><th scope="col">Auslastung</th></tr></thead>
                <tbody>
                  {sizing.rows.map((row) => (
                    <tr key={row.planned} className={row.planned === sizing.recommended ? "is-pick" : row.ok ? "is-ok" : ""}>
                      <td>{row.planned}{row.planned === sizing.recommended && <Tag minimal intent="success" className="sim-tag">Empfehlung</Tag>}</td>
                      <td>≈ {fmtWait(row.wait_p90_s)}</td>
                      <td>{row.unserved}</td>
                      <td>{pct(row.utilisation)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sizing.recommended == null && (
                <p className="sim-muted">Auch {sizing.rows.length} Roboter schaffen das Ziel nicht — Ziel, Wege oder Umschlagzeit prüfen.</p>
              )}
            </div>
          )}
          {s.hotspots.length > 0 && <p className="sim-muted">Rote Ringe in der Halle: Stellen, an denen sich Roboter nahe kommen.</p>}
          <ul className="sim-notes">{result!.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
      )}

      <section className="sim-section" aria-labelledby="sim-scen">
        <h3 id="sim-scen">Szenarien</h3>
        <form className="sim-save" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <InputGroup aria-label="Name des Szenarios" placeholder="z. B. Zwei AMR, doppelte Menge" value={saveName}
            maxLength={80} onChange={(e) => setSaveName(e.target.value)} />
          <Button type="submit" icon="floppy-disk" text="Speichern" disabled={!saveName.trim()} />
        </form>
        {scenarios.length === 0 ? <p className="sim-muted">Noch keine Szenarien für diese Ebene.</p> : (
          <Menu className="sim-scenarios">
            {scenarios.map((sc) => (
              <MenuItem key={sc.id} icon="predictive-analysis" text={sc.name} onClick={() => open(sc)}
                label={`${sc.params.planned?.reduce((n, r) => n + r.count, 0) ?? 0} Roboter`}
                labelElement={(sc.created_by === user?.email || canAdminWork(user)) ? (
                  <KeyPopover content={<Menu><MenuItem icon="trash" intent="danger" text="Löschen" onClick={() => remove(sc)} /></Menu>}>
                    <Button small minimal icon="more" aria-label={`Szenario ${sc.name}: weitere Aktionen`} onClick={(e) => e.stopPropagation()} />
                  </KeyPopover>
                ) : undefined} />
            ))}
          </Menu>
        )}
      </section>
    </div>
  );
}
