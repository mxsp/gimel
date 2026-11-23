import {
  Button, Callout, Card, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect,
  HTMLTable, InputGroup, Spinner, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { api, canAdminWork, getUser } from "../../api";
import NonIdealState from "../NonIdealState";
import type { Robot, RobotDeployment, RobotGateway, RobotProgram } from "../../factory";
import { toastError, toastSuccess } from "../../toast";

/* Missionen und Auslieferungen.
 *
 * Ein Programm ist Text mit Version und Prüfsumme. Gimel wertet ihn nicht
 * aus — es liefert ihn an ein Gateway. Deshalb steht hier die Herkunft
 * (Roboter, Gateway) und jeder Versuch, auch der gescheiterte.
 */

const STATUS: Record<string, { label: string; intent: "none" | "primary" | "success" | "warning" | "danger" }> = {
  draft: { label: "Entwurf", intent: "none" },
  approved: { label: "freigegeben", intent: "primary" },
  deployed: { label: "ausgeliefert", intent: "success" },
  retired: { label: "zurückgezogen", intent: "none" },
};

const DEPLOY_STATE: Record<string, { label: string; intent: "none" | "primary" | "success" | "warning" | "danger" }> = {
  queued: { label: "wartet", intent: "none" },
  accepted: { label: "angenommen", intent: "success" },
  rejected: { label: "abgelehnt", intent: "warning" },
  failed: { label: "fehlgeschlagen", intent: "danger" },
};

interface Draft {
  name: string;
  kind: string;
  language: string;
  robot_id: number | null;
  gateway_id: string;
  body: string;
  notes: string;
}

const emptyDraft = (): Draft => ({
  name: "",
  kind: "mission",
  language: "json",
  robot_id: null,
  gateway_id: "sim",
  body: "",
  notes: "",
});

export default function RobotPrograms({ robots }: { robots: Robot[] }) {
  const admin = canAdminWork(getUser());
  const [programs, setPrograms] = useState<RobotProgram[]>([]);
  const [deployments, setDeployments] = useState<RobotDeployment[]>([]);
  const [gateways, setGateways] = useState<RobotGateway[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deploying, setDeploying] = useState<RobotProgram | null>(null);
  const [deployRobot, setDeployRobot] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(0);
  const [formError, setFormError] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [p, d, g] = await Promise.all([
        api<{ programs: RobotProgram[] }>("/api/factory/robot-programs"),
        api<{ deployments: RobotDeployment[] }>("/api/factory/robot-deployments"),
        api<{ gateways: RobotGateway[] }>("/api/factory/robot-gateways"),
      ]);
      setPrograms(p.programs ?? []);
      setDeployments(d.deployments ?? []);
      setGateways(g.gateways ?? []);
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

  const openNew = () => {
    setFormError("");
    setDraft(emptyDraft());
  };

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const create = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { setFormError("Die Mission braucht einen Namen."); return; }
    setSaving(true);
    setFormError("");
    try {
      await api("/api/factory/robot-programs", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          kind: draft.kind,
          language: draft.language,
          robot_id: draft.robot_id,
          gateway_id: draft.gateway_id.trim(),
          body: draft.body,
          notes: draft.notes,
        }),
      });
      toastSuccess("Neue Programmversion angelegt.");
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

  const approve = async (program: RobotProgram) => {
    setBusy(program.id);
    try {
      await api(`/api/factory/robot-programs/${program.id}/approve`, { method: "POST" });
      toastSuccess(`${program.name} ${program.version} freigegeben.`);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(0);
    }
  };

  const deploy = async () => {
    if (!deploying || deployRobot == null) return;
    setSaving(true);
    try {
      const result = await api<RobotDeployment>(
        `/api/factory/robot-programs/${deploying.id}/deploy`,
        { method: "POST", body: JSON.stringify({ robot_id: deployRobot }) },
      );
      if (result.state === "accepted") toastSuccess(`${deploying.name} ausgeliefert.`);
      else toastError(`Nicht angenommen: ${result.message}`);
      setDeploying(null);
      setDeployRobot(null);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const rollback = async (deployment: RobotDeployment) => {
    setBusy(deployment.id);
    try {
      await api(`/api/factory/robot-deployments/${deployment.id}/rollback`, { method: "POST" });
      toastSuccess("Vorheriger Stand ausgeliefert.");
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(0);
    }
  };

  if (loading && !programs.length) return <div className="twin-center"><Spinner size={36} /></div>;

  return (
    <div>
      <div className="twin-head">
        <div>
          <h2 className="page-title">Missionen</h2>
          <p className="page-sub">
            Versionen werden nie überschrieben; jede Auslieferung bleibt sichtbar, auch die abgelehnte.
            Ausgeführt wird der Text vom Flotten-Gateway, nicht von Gimel.
          </p>
        </div>
        <div className="twin-head-actions">
          <Button icon="refresh" text="Aktualisieren" onClick={() => load()} />
          {admin && <Button intent="primary" icon="add" text="Neue Mission" onClick={openNew} />}
        </div>
      </div>

      {error && <Callout intent="warning" icon="warning-sign" className="mb">Missionen ließen sich nicht laden: {error}</Callout>}

      {!programs.length ? (
        <Card>
          <NonIdealState icon="code" title="Noch keine Missionen"
            description={admin
              ? "Lege eine erste Mission an. Freigeben und Ausliefern sind zwei getrennte Schritte."
              : "Ein Admin kann Missionen anlegen und freigeben."}
            action={admin ? <Button intent="primary" icon="add" text="Neue Mission" onClick={openNew} /> : undefined} />
        </Card>
      ) : (
        <div className="table-scroll">
          <HTMLTable className="data-table" striped compact>
            <thead>
              <tr>
                <th>Mission</th><th>Version</th><th>Art</th><th>Sprache</th>
                <th>Zustand</th><th>Roboter</th><th>Prüfsumme</th>
                <th><span className="sr-only">Aktion</span></th>
              </tr>
            </thead>
            <tbody>
              {programs.map((program) => {
                const style = STATUS[program.status] ?? STATUS.draft;
                return (
                  <tr key={program.id}>
                    <td><b>{program.name}</b>
                      <div className="sub">{program.notes || "—"}</div>
                    </td>
                    <td className="num">v{program.version}</td>
                    <td>{program.kind}</td>
                    <td>{program.language}</td>
                    <td><Tag minimal intent={style.intent}>{style.label}</Tag></td>
                    <td>{program.robot_name || <span className="sub">frei</span>}</td>
                    <td className="mono sub" title={program.checksum}>
                      {program.checksum ? program.checksum.slice(0, 10) : "—"}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {admin && program.status === "draft" && (
                        <Button small minimal icon="endorsed" text="Freigeben"
                                loading={busy === program.id} onClick={() => approve(program)} />
                      )}
                      {admin && (program.status === "approved" || program.status === "deployed") && (
                        <Button small minimal intent="primary" icon="upload" text="Ausliefern"
                                onClick={() => { setDeploying(program); setDeployRobot(program.robot_id ?? robots[0]?.id ?? null); }} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </HTMLTable>
        </div>
      )}

      <h3 className="robot-section-title">Auslieferungen</h3>
      {!deployments.length ? (
        <p className="sub">Noch nichts ausgeliefert.</p>
      ) : (
        <div className="table-scroll">
          <HTMLTable className="data-table" striped compact>
            <thead>
              <tr><th>Zeit</th><th>Mission</th><th>Roboter</th><th>Gateway</th>
                <th>Zustand</th><th>Antwort</th><th>Von</th>
                <th><span className="sr-only">Aktion</span></th></tr>
            </thead>
            <tbody>
              {deployments.map((row) => {
                const style = DEPLOY_STATE[row.state] ?? DEPLOY_STATE.queued;
                return (
                  <tr key={row.id}>
                    <td className="mono">{row.created_at ? new Date(row.created_at).toLocaleString("de-DE") : "—"}</td>
                    <td>{row.program_name || "—"} {row.program_version != null ? `v${row.program_version}` : ""}</td>
                    <td>{row.robot_name || "—"}</td>
                    <td>{row.gateway_id}</td>
                    <td><Tag minimal intent={style.intent}>{style.label}</Tag>
                      {row.rollback_of_id != null && <div className="sub">Rücknahme von #{row.rollback_of_id}</div>}
                    </td>
                    <td className="sub">{row.message || "—"}</td>
                    <td className="sub">{row.actor}</td>
                    <td>
                      {admin && row.state === "accepted" && row.robot_id != null && (
                        <Button small minimal icon="undo" text="Zurücknehmen"
                                loading={busy === row.id} onClick={() => rollback(row)} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </HTMLTable>
        </div>
      )}

      <Dialog isOpen={draft != null} onClose={() => !saving && setDraft(null)}
              title="Neue Mission" className="robot-dialog">
        {draft && (
          <>
            <DialogBody>
              <Callout compact intent="primary" icon="code" className="mb">
                Der Text wird gespeichert, geprüft und ausgeliefert — nie in Gimel ausgeführt.
              </Callout>
              <div className="robot-form-grid">
                <FormGroup label="Name" labelFor="program-name" labelInfo="Pflicht">
                  <InputGroup id="program-name" autoFocus value={draft.name}
                              onChange={(e) => patch({ name: e.currentTarget.value })}
                              placeholder="z. B. Palette zum Packtisch" />
                </FormGroup>
                <FormGroup label="Version" helperText="Wird beim Anlegen automatisch hochgezählt.">
                  <InputGroup value="neu" disabled />
                </FormGroup>
                <FormGroup label="Art" labelFor="program-kind">
                  <HTMLSelect id="program-kind" fill value={draft.kind}
                              onChange={(e) => patch({ kind: e.currentTarget.value })}>
                    <option value="mission">Mission</option>
                    <option value="driver">Treiber</option>
                    <option value="config">Konfiguration</option>
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="Sprache" labelFor="program-language">
                  <HTMLSelect id="program-language" fill value={draft.language}
                              onChange={(e) => patch({ language: e.currentTarget.value })}>
                    <option value="json">JSON</option>
                    <option value="python">Python</option>
                    <option value="vda5050">VDA 5050</option>
                    <option value="text">Text</option>
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="Roboter" labelFor="program-robot">
                  <HTMLSelect id="program-robot" fill value={draft.robot_id ?? ""}
                              onChange={(e) => {
                                const id = e.currentTarget.value ? Number(e.currentTarget.value) : null;
                                const robot = robots.find((r) => r.id === id);
                                patch({ robot_id: id, gateway_id: robot?.gateway_id || draft.gateway_id });
                              }}>
                    <option value="">frei / später binden</option>
                    {robots.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.gateway_id}</option>)}
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="Gateway" labelFor="program-gateway">
                  <HTMLSelect id="program-gateway" fill value={draft.gateway_id}
                              onChange={(e) => patch({ gateway_id: e.currentTarget.value })}>
                    {gateways.map((g) => <option key={g.code} value={g.code}>{g.code} · {g.name}</option>)}
                    {!gateways.some((g) => g.code === "sim") && <option value="sim">sim · Simulation</option>}
                  </HTMLSelect>
                </FormGroup>
              </div>
              <FormGroup label="Programmtext" labelFor="program-body"
                         helperText="Höchstens 256 KiB. Keine Ausführung in Gimel.">
                <TextArea id="program-body" rows={10} fill value={draft.body}
                          onChange={(e) => patch({ body: e.currentTarget.value })}
                          placeholder={'{"steps": ["pick", "drive", "drop"]}'} />
              </FormGroup>
              <FormGroup label="Notiz" labelFor="program-notes">
                <InputGroup id="program-notes" value={draft.notes}
                            onChange={(e) => patch({ notes: e.currentTarget.value })} />
              </FormGroup>
              {formError && <Callout compact intent="danger" icon="error" className="mb">{formError}</Callout>}
            </DialogBody>
            <DialogFooter actions={
              <>
                <Button text="Abbrechen" disabled={saving} onClick={() => setDraft(null)} />
                <Button intent="primary" icon="add" text="Anlegen" loading={saving} onClick={create} />
              </>
            } />
          </>
        )}
      </Dialog>

      <Dialog isOpen={deploying != null} onClose={() => !saving && setDeploying(null)}
              title={`${deploying?.name ?? ""} ausliefern`} className="robot-dialog-small">
        <DialogBody>
          <p>Welcher Roboter soll diese Version bekommen? Die Auslieferung wird protokolliert.</p>
          <FormGroup label="Roboter" labelFor="deploy-robot">
            <HTMLSelect id="deploy-robot" fill value={deployRobot ?? ""}
                        onChange={(e) => setDeployRobot(e.currentTarget.value ? Number(e.currentTarget.value) : null)}>
              <option value="">— wählen —</option>
              {robots.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.gateway_id}</option>)}
            </HTMLSelect>
          </FormGroup>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" disabled={saving} onClick={() => setDeploying(null)} />
            <Button intent="primary" icon="upload" text="Ausliefern" loading={saving}
                    disabled={deployRobot == null} onClick={deploy} />
          </>
        } />
      </Dialog>
    </div>
  );
}
