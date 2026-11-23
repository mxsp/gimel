import {
  Button, Callout, Card, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect,
  HTMLTable, InputGroup, Spinner, Switch, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { api, canAdminWork, getUser } from "../../api";
import NonIdealState from "../NonIdealState";
import type { RobotGateway } from "../../factory";
import { toastError, toastSuccess } from "../../toast";

/* Gateways sind die Naht zur Halle. Jedes trägt seine eigenen lokalen
 * Endpunkte; Gimel lehnt öffentliche Adressen ab. Das Token wird einmal bei
 * der Anlage gezeigt und nie wieder in einer Liste. */

interface Draft {
  id?: number;
  code: string;
  name: string;
  kind: string;
  base_url: string;
  health: string;
  deploy: string;
  command: string;
  cancel: string;
  token: string;
  enabled: boolean;
  note: string;
}

const ENDPOINT_DEFAULTS = {
  health: "/health",
  deploy: "/robots/deploy",
  command: "/robots/orders",
  cancel: "/robots/orders/cancel",
};

const emptyDraft = (): Draft => ({
  code: "",
  name: "",
  kind: "http",
  base_url: "",
  health: ENDPOINT_DEFAULTS.health,
  deploy: ENDPOINT_DEFAULTS.deploy,
  command: ENDPOINT_DEFAULTS.command,
  cancel: ENDPOINT_DEFAULTS.cancel,
  token: "",
  enabled: true,
  note: "",
});

const fromGateway = (g: RobotGateway): Draft => ({
  id: g.id,
  code: g.code,
  name: g.name,
  kind: g.kind,
  base_url: g.base_url,
  health: g.endpoints?.health ?? "",
  deploy: g.endpoints?.deploy ?? "",
  command: g.endpoints?.command ?? "",
  cancel: g.endpoints?.cancel ?? "",
  token: "",
  enabled: g.enabled,
  note: g.note,
});

export default function RobotGateways() {
  const admin = canAdminWork(getUser());
  const [gateways, setGateways] = useState<RobotGateway[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RobotGateway | null>(null);
  const [busy, setBusy] = useState(0);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api<{ gateways: RobotGateway[] }>("/api/factory/robot-gateways");
      setGateways(r.gateways ?? []);
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

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const buildBody = (d: Draft) => {
    const endpoints: Record<string, string> = {};
    if (d.health.trim()) endpoints.health = d.health.trim();
    if (d.deploy.trim()) endpoints.deploy = d.deploy.trim();
    if (d.command.trim()) endpoints.command = d.command.trim();
    if (d.cancel.trim()) endpoints.cancel = d.cancel.trim();
    const body: Record<string, unknown> = {
      code: d.code.trim().toLowerCase(),
      name: d.name.trim() || "Gateway",
      kind: d.kind,
      base_url: d.base_url.trim(),
      endpoints,
      enabled: d.enabled,
      note: d.note,
    };
    if (d.token.trim()) body.token = d.token.trim();
    return body;
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.code.trim()) { setFormError("Das Gateway braucht einen Code."); return; }
    if (draft.kind !== "sim" && !draft.base_url.trim()) {
      setFormError("Ein HTTP-Gateway braucht eine lokale Adresse.");
      return;
    }
    setSaving(true);
    setFormError("");
    setNewToken(null);
    try {
      if (draft.id != null) {
        await api(`/api/factory/robot-gateways/${draft.id}`, {
          method: "PUT", body: JSON.stringify(buildBody(draft)),
        });
        toastSuccess("Gateway gespeichert.");
      } else {
        const created = await api<RobotGateway>("/api/factory/robot-gateways", {
          method: "POST", body: JSON.stringify(buildBody(draft)),
        });
        if (created.token) setNewToken(created.token);
        toastSuccess("Gateway angelegt.");
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

  const test = async (gateway: RobotGateway) => {
    setBusy(gateway.id);
    try {
      const result = await api<{ ok: boolean; message: string }>(
        `/api/factory/robot-gateways/${gateway.id}/test`, { method: "POST" },
      );
      if (result.ok) toastSuccess(`Erreichbar: ${result.message}`);
      else toastError(`Nicht erreichbar: ${result.message}`);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(0);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setSaving(true);
    try {
      await api(`/api/factory/robot-gateways/${deleting.id}`, { method: "DELETE" });
      toastSuccess("Gateway gelöscht.");
      setDeleting(null);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !gateways.length) return <div className="twin-center"><Spinner size={36} /></div>;

  return (
    <div>
      <div className="twin-head">
        <div>
          <h2 className="page-title">Gateways</h2>
          <p className="page-sub">
            Lokale Adressen, eigene Pfade, ein Token je Gateway. Öffentliche Ziele lehnt Gimel ab —
            die Halle bleibt im LAN.
          </p>
        </div>
        <div className="twin-head-actions">
          <Button icon="refresh" text="Aktualisieren" onClick={() => load()} />
          {admin && <Button intent="primary" icon="add" text="Neues Gateway"
                            onClick={() => { setNewToken(null); setFormError(""); setDraft(emptyDraft()); }} />}
        </div>
      </div>

      {error && <Callout intent="warning" icon="warning-sign" className="mb">Gateways ließen sich nicht laden: {error}</Callout>}
      {newToken && (
        <Callout intent="success" icon="key" className="mb" title="Token nur jetzt sichtbar">
          <code className="robot-token">{newToken}</code>
          <div className="sub">In die Robotersteuerung eintragen. Gimel zeigt ihn nie wieder an.</div>
        </Callout>
      )}

      {!gateways.length ? (
        <Card>
          <NonIdealState icon="cloud" title="Keine Gateways"
            description={admin
              ? "Lege das erste lokale Gateway an. Die Simulation existiert ohne Adresse."
              : "Ein Admin kann Gateways anlegen."}
            action={admin ? <Button intent="primary" icon="add" text="Neues Gateway"
                                    onClick={() => { setNewToken(null); setFormError(""); setDraft(emptyDraft()); }} /> : undefined} />
        </Card>
      ) : (
        <div className="table-scroll">
          <HTMLTable className="data-table" striped compact>
            <thead>
              <tr><th>Code</th><th>Name</th><th>Art</th><th>Adresse</th>
                <th>Endpunkte</th><th>Token</th><th>Zuletzt</th><th>Status</th>
                <th><span className="sr-only">Aktion</span></th></tr>
            </thead>
            <tbody>
              {gateways.map((gateway) => (
                <tr key={gateway.id} className={gateway.enabled ? undefined : "row-muted"}>
                  <td className="mono">{gateway.code}</td>
                  <td><b>{gateway.name}</b>{gateway.note && <div className="sub">{gateway.note}</div>}</td>
                  <td><Tag minimal>{gateway.kind}</Tag></td>
                  <td className="mono sub">{gateway.base_url || "—"}</td>
                  <td className="sub">
                    {Object.keys(gateway.endpoints ?? {}).length
                      ? Object.entries(gateway.endpoints).map(([k, v]) => `${k}: ${v}`).join(" · ")
                      : "—"}
                  </td>
                  <td>{gateway.token_set ? <Tag minimal intent="primary">gesetzt</Tag> : <span className="sub">keins</span>}</td>
                  <td className="mono sub">{gateway.last_seen_at ? new Date(gateway.last_seen_at).toLocaleString("de-DE") : "—"}</td>
                  <td><Tag minimal intent={gateway.enabled ? "success" : "none"}>{gateway.enabled ? "an" : "aus"}</Tag></td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {admin && <>
                      <Button small minimal icon="play" aria-label={`${gateway.code} prüfen`}
                              loading={busy === gateway.id} onClick={() => test(gateway)} />
                      <Button small minimal icon="edit" aria-label={`${gateway.code} bearbeiten`}
                              onClick={() => { setNewToken(null); setFormError(""); setDraft(fromGateway(gateway)); }} />
                      <Button small minimal icon="trash" aria-label={`${gateway.code} löschen`}
                              onClick={() => setDeleting(gateway)} />
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </HTMLTable>
        </div>
      )}

      <Dialog isOpen={draft != null} onClose={() => !saving && setDraft(null)}
              title={draft?.id != null ? "Gateway bearbeiten" : "Neues Gateway"} className="robot-dialog">
        {draft && (
          <>
            <DialogBody>
              <Callout compact intent="primary" icon="shield" className="mb">
                Nur lokale Adressen: localhost, privates Netz oder ein einzelner Rechnername.
                Gimel sendet hochstufige Aufträge, keine Motorwerte.
              </Callout>
              <div className="robot-form-grid">
                <FormGroup label="Code" labelFor="gateway-code" labelInfo="Pflicht">
                  <InputGroup id="gateway-code" value={draft.code} autoFocus
                              onChange={(e) => patch({ code: e.currentTarget.value })}
                              placeholder="z. B. halle-1" />
                </FormGroup>
                <FormGroup label="Name" labelFor="gateway-name">
                  <InputGroup id="gateway-name" value={draft.name}
                              onChange={(e) => patch({ name: e.currentTarget.value })} />
                </FormGroup>
                <FormGroup label="Art" labelFor="gateway-kind">
                  <HTMLSelect id="gateway-kind" fill value={draft.kind}
                              onChange={(e) => patch({ kind: e.currentTarget.value })}>
                    <option value="http">HTTP (lokales Gateway)</option>
                    <option value="sim">Simulation</option>
                    <option value="vda5050">VDA 5050 (noch nicht verdrahtet)</option>
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="Basisadresse" labelFor="gateway-url"
                           helperText="Nur bei HTTP; z. B. http://agv-gw.local:8080">
                  <InputGroup id="gateway-url" value={draft.base_url} disabled={draft.kind === "sim"}
                              onChange={(e) => patch({ base_url: e.currentTarget.value })} />
                </FormGroup>
              </div>
              {draft.kind === "http" && (
                <div className="robot-form-grid">
                  <FormGroup label="Statuspfad" labelFor="gateway-health">
                    <InputGroup id="gateway-health" value={draft.health}
                                onChange={(e) => patch({ health: e.currentTarget.value })} />
                  </FormGroup>
                  <FormGroup label="Auslieferung" labelFor="gateway-deploy">
                    <InputGroup id="gateway-deploy" value={draft.deploy}
                                onChange={(e) => patch({ deploy: e.currentTarget.value })} />
                  </FormGroup>
                  <FormGroup label="Auftrag" labelFor="gateway-command">
                    <InputGroup id="gateway-command" value={draft.command}
                                onChange={(e) => patch({ command: e.currentTarget.value })} />
                  </FormGroup>
                  <FormGroup label="Storno" labelFor="gateway-cancel">
                    <InputGroup id="gateway-cancel" value={draft.cancel}
                                onChange={(e) => patch({ cancel: e.currentTarget.value })} />
                  </FormGroup>
                </div>
              )}
              <FormGroup label="Token" labelFor="gateway-token"
                         helperText="Leer lassen = unverändert. Ein neuer Wert ersetzt das alte Token.">
                <InputGroup id="gateway-token" type="password" value={draft.token}
                            onChange={(e) => patch({ token: e.currentTarget.value })} />
              </FormGroup>
              <FormGroup label="Notiz" labelFor="gateway-note">
                <TextArea id="gateway-note" rows={2} fill value={draft.note}
                          onChange={(e) => patch({ note: e.currentTarget.value })} />
              </FormGroup>
              <Switch checked={draft.enabled} label="Gateway aktiv"
                      onChange={(e) => patch({ enabled: e.currentTarget.checked })} />
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

      <Dialog isOpen={deleting != null} onClose={() => !saving && setDeleting(null)}
              title="Gateway löschen" className="robot-dialog-small">
        <DialogBody>
          <p>Soll <b>{deleting?.code}</b> gelöscht werden? Roboter, die daran hängen, müssen zuerst umziehen.</p>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" disabled={saving} onClick={() => setDeleting(null)} />
            <Button intent="danger" icon="trash" text="Löschen" loading={saving} onClick={remove} />
          </>
        } />
      </Dialog>
    </div>
  );
}
