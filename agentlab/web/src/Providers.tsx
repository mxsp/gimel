import {
  Button, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, Icon, InputGroup,
  Switch, Tag, TextArea,
} from "@blueprintjs/core";
import { useMemo, useState } from "react";
import {
  ApiError, createProvider, deleteProvider, deleteProviderKey, loadProviderModels,
  Provider, SessionUser, setDefaultProvider, testProvider, updateProvider,
} from "./api";

type Draft = {
  id?: number;
  presetKey?: string;
  name: string;
  kind: string;
  base_url: string;
  models_url: string;
  api_key: string;
  default_model: string;
  enabled: boolean;
  is_default: boolean;
  headers: string;
};

const PROTOCOL_LABEL: Record<string, string> = {
  openai: "OpenAI-API",
  anthropic: "Anthropic nativ",
  gemini: "Gemini nativ",
};

const ENV_VAR_HINT: Record<string, string> = {
  "google-gemini": "GEMINI_API_KEY",
  "google-gemini-native": "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "opencode-go": "GIMEL_AGENT_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  together: "TOGETHER_API_KEY",
  "azure-openai": "AZURE_OPENAI_API_KEY",
};

const CATEGORY_META: Array<{ key: string; label: string }> = [
  { key: "cloud", label: "Cloud-Anbieter" },
  { key: "aggregator", label: "Router & Kontingente" },
  { key: "local", label: "Lokal (ohne Schlüssel)" },
];

const blank = (presetKey = "google-gemini", presets?: Record<string, Record<string, string>>): Draft => {
  const preset = presets?.[presetKey];
  if (preset) {
    return {
      presetKey,
      name: preset.name || "Anbieter",
      kind: preset.kind || presetKey,
      base_url: preset.base_url || "",
      models_url: preset.models_url || "",
      api_key: "",
      default_model: preset.default_model || "",
      enabled: true,
      is_default: false,
      headers: "{}",
    };
  }
  return {
    presetKey: "custom",
    name: "Benutzerdefinierter Anbieter",
    kind: "custom",
    base_url: "https://",
    models_url: "",
    api_key: "",
    default_model: "",
    enabled: true,
    is_default: false,
    headers: "{}",
  };
};

const fromProvider = (p: Provider): Draft => ({
  id: p.id, presetKey: p.kind, name: p.name, kind: p.kind, base_url: p.base_url,
  models_url: p.models_url, api_key: "", default_model: p.default_model,
  enabled: p.enabled, is_default: p.is_default,
  headers: JSON.stringify(p.headers || {}, null, 2),
});

export default function Providers({
  user, providers, presets, onRefresh,
}: {
  user: SessionUser;
  providers: Provider[];
  presets: Record<string, Record<string, string>>;
  onRefresh: () => Promise<void>;
}) {
  const admin = user.role === "admin" || user.adminWork === true;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<number, string>>({});
  const [keyBusy, setKeyBusy] = useState<number | null>(null);

  const ordered = useMemo(
    () => [...providers].sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.id - b.id),
    [providers],
  );
  const configuredKinds = useMemo(
    () => new Set(providers.filter((p) => p.enabled).map((p) => p.kind)),
    [providers],
  );

  const groupedPresets = useMemo(() => {
    const entries = Object.entries(presets);
    return CATEGORY_META.map((cat) => ({
      ...cat,
      items: entries.filter(([, p]) => (p.category || "cloud") === cat.key),
    })).filter((g) => g.items.length > 0);
  }, [presets]);

  const patch = (p: Partial<Draft>) => setDraft((d) => d ? { ...d, ...p } : d);

  const applyPreset = (key: string) => {
    if (key === "custom") {
      patch({ presetKey: "custom", kind: "custom" });
      return;
    }
    const preset = presets[key];
    if (!preset) return;
    patch({
      presetKey: key,
      kind: preset.kind || key,
      name: preset.name || "Anbieter",
      base_url: preset.base_url || "",
      models_url: preset.models_url || "",
      default_model: preset.default_model || "",
    });
  };

  const save = async () => {
    if (!draft) return;
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(draft.headers || "{}");
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("Objekt erwartet");
    } catch {
      setError("Zusatz-Header müssen ein JSON-Objekt sein, z. B. {\"X-Header\": \"Wert\"}.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const body: Record<string, unknown> = {
        name: draft.name, kind: draft.kind, base_url: draft.base_url,
        models_url: draft.models_url, default_model: draft.default_model,
        enabled: draft.enabled, is_default: draft.is_default, headers,
      };
      if (draft.api_key.trim() || !draft.id) body.api_key = draft.api_key;
      if (draft.id) await updateProvider(draft.id, body);
      else await createProvider(body);
      setDraft(null);
      await onRefresh();
      setNotice("Anbieter gespeichert.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadModels = async (p: Provider) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await loadProviderModels(p.id, true);
      setNotice(result.warning || `${result.models.length} Modelle geladen.`);
      await onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async (p: Provider) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await testProvider(p.id);
      setNotice(result.warning
        ? `Verbindung steht, aber: ${result.warning}`
        : `Verbindung steht. ${result.models} Modelle, z. B. ${result.sample.slice(0, 3).join(", ")}.`);
      await onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (p: Provider) => {
    setBusy(true); setError("");
    try { await setDefaultProvider(p.id); await onRefresh(); }
    catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const pickDefaultModel = async (p: Provider, modelId: string) => {
    if (!admin || busy || p.default_model === modelId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await updateProvider(p.id, { default_model: modelId });
      await onRefresh();
      setNotice(`Standardmodell für „${p.name}“: ${modelId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const setKeyDraft = (id: number, value: string) =>
    setKeyDrafts((drafts) => ({ ...drafts, [id]: value }));

  const saveKey = async (p: Provider, raw?: string) => {
    const value = (raw ?? keyDrafts[p.id] ?? "").trim();
    if (!value) return;
    setKeyBusy(p.id); setError(""); setNotice("");
    try {
      await updateProvider(p.id, { api_key: value });
      setKeyDraft(p.id, "");
      await onRefresh();
      setNotice(`Schlüssel für „${p.name}“ gespeichert.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setKeyBusy(null);
    }
  };

  const clearKey = async (p: Provider) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await deleteProviderKey(p.id);
      setKeyDraft(p.id, "");
      await onRefresh();
      setNotice("Schlüssel entfernt.");
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true); setError("");
    try {
      await deleteProvider(deleting.id);
      setDeleting(null);
      await onRefresh();
      setNotice("Anbieter deaktiviert.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const activePreset = draft ? presets[draft.presetKey || draft.kind] : undefined;

  return (
    <div className="lab-page">
      <h2>Anbieter und Modelle</h2>
      <p className="sub">
        Google Gemini, Anthropic Claude, OpenAI, OpenRouter, DeepSeek, Mistral, Groq, xAI, Perplexity, Azure
        sowie lokale Server (Ollama, LM Studio, vLLM). Schlüssel werden versiegelt gespeichert und nie zurückgegeben.
        {!admin && " Nur Administratoren können Endpunkte und Schlüssel ändern."}
      </p>
      {error && <div className="login-card banner-bad" style={{ width: "auto", marginBottom: 12 }}>{error}</div>}
      {notice && <div className="login-card banner-ok" style={{ width: "auto", marginBottom: 12 }}>{notice}</div>}

      {admin && groupedPresets.length > 0 && (
        <section className="provider-gallery">
          <div className="provider-gallery-head">
            <strong>Schnell hinzufügen</strong>
            <span>1-Klick-Vorlage wählen — Endpunkt, Protokoll und Standardmodell werden vorbelegt.</span>
          </div>
          {groupedPresets.map((group) => (
            <div className="provider-gallery-group" key={group.key}>
              <div className="provider-gallery-label">{group.label}</div>
              <div className="provider-preset-row">
                {group.items.map(([key, preset]) => (
                  <button
                    key={key}
                    type="button"
                    className={`provider-preset-chip ${configuredKinds.has(preset.kind || key) ? "is-added" : ""}`}
                    title={preset.hint || preset.base_url}
                    onClick={() => { setDraft(blank(key, presets)); setError(""); }}
                  >
                    <Icon icon={group.key === "local" ? "desktop" : "cloud"} size={12} aria-hidden="true" />
                    <span>{preset.name || key}</span>
                    {preset.protocol && preset.protocol !== "openai" && (
                      <em className="provider-preset-proto">{preset.protocol}</em>
                    )}
                    {configuredKinds.has(preset.kind || key) && (
                      <Icon icon="tick" size={11} className="provider-preset-check" aria-hidden="true" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      <div style={{ marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {admin && (
          <Button intent="primary" icon="add" text="Benutzerdefinierten Anbieter hinzufügen"
            onClick={() => { setDraft(blank("custom", presets)); setError(""); }} />
        )}
        <Button icon="refresh" text="Liste aktualisieren" onClick={() => onRefresh()} loading={busy} />
      </div>

      <div className="lab-grid">
        {ordered.map((p) => {
          const needsKey = p.requires_key !== false;
          const protoText = PROTOCOL_LABEL[p.protocol || "openai"] || p.protocol || "OpenAI-API";
          const presetHint = ENV_VAR_HINT[p.kind];
          return (
            <div className="provider-card" key={p.id}>
              <div className="provider-head">
                <h3>{p.name}</h3>
                {p.is_default && <Tag minimal intent="success">Standard</Tag>}
                {!p.enabled && <Tag minimal>deaktiviert</Tag>}
                <Tag minimal intent="primary">{protoText}</Tag>
                {needsKey ? (
                  <Tag minimal intent={p.has_key ? "success" : "danger"}>
                    {p.has_key ? `Schlüssel ${p.key_source === "env" ? "aus Umgebung" : "gesetzt"}` : "kein Schlüssel"}
                  </Tag>
                ) : (
                  <Tag minimal intent="success">lokal · kein Schlüssel nötig</Tag>
                )}
                <Tag minimal>{p.models.length} Modelle</Tag>
              </div>
              <div className="provider-url">{p.base_url}</div>
              <div className="provider-url">Modelle: {p.models_url || `${p.base_url}/models`}</div>
              <div style={{ fontSize: 12 }}>
                Standardmodell: <code>{p.default_model || "—"}</code>
              </div>
              {p.models.length > 0 && (
                <div className="provider-model-chips">
                  {p.models.slice(0, 12).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`provider-model-chip ${p.default_model === m.id ? "is-active" : ""}`}
                      disabled={!admin || busy}
                      title={admin ? `${m.id} als Standardmodell setzen` : m.id}
                      onClick={() => pickDefaultModel(p, m.id)}
                    >
                      {m.id}
                    </button>
                  ))}
                  {p.models.length > 12 && (
                    <span className="provider-model-more">+{p.models.length - 12} weitere</span>
                  )}
                </div>
              )}
              {admin && (
                <div className="provider-key">
                  <InputGroup
                    type="password"
                    autoComplete="new-password"
                    leftIcon="key"
                    fill
                    value={keyDrafts[p.id] ?? ""}
                    placeholder={
                      !needsKey
                        ? "Optionaler Schlüssel (für lokale Server normalerweise leer)"
                        : p.has_key
                          ? "•••••••• gespeichert — neu eingeben zum Ersetzen"
                          : presetHint
                            ? `API-Schlüssel eingeben (oder ${presetHint} setzen)`
                            : "API-Schlüssel eingeben"
                    }
                    onChange={(e) => setKeyDraft(p.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); saveKey(p); }
                    }}
                    disabled={keyBusy === p.id || busy}
                    aria-label={`API-Schlüssel für ${p.name}`}
                  />
                  <Button
                    small
                    icon="tick"
                    text="Speichern"
                    intent={keyDrafts[p.id]?.trim() ? "primary" : undefined}
                    disabled={!keyDrafts[p.id]?.trim() || keyBusy === p.id || busy}
                    loading={keyBusy === p.id}
                    onClick={() => saveKey(p)}
                  />
                  {p.has_key && p.key_source === "database" && (
                    <Button small minimal icon="trash" text="Entfernen"
                      onClick={() => clearKey(p)} disabled={busy || keyBusy === p.id} />
                  )}
                  <span className="provider-key-hint">
                    {p.key_source === "env"
                      ? `Schlüssel kommt aus der Umgebung${presetHint ? ` (${presetHint})` : ""}.`
                      : !needsKey
                        ? "Lokaler Endpunkt läuft auch ohne Schlüssel."
                        : "Enter speichert sofort; der Schlüssel bleibt versiegelt in der Datenbank."}
                  </span>
                </div>
              )}
              <div className="provider-actions">
                <Button small icon="tint" text="Verbindung testen" onClick={() => test(p)} disabled={busy} />
                <Button small icon="refresh" text="Modelle laden" onClick={() => loadModels(p)} disabled={busy} />
                {admin && !p.is_default && p.enabled && <Button small icon="star" text="Als Standard" onClick={() => makeDefault(p)} disabled={busy} />}
                {admin && <Button small icon="edit" text="Bearbeiten" onClick={() => { setDraft(fromProvider(p)); setError(""); }} />}
                {admin && p.enabled && <Button small minimal icon="disable" text="Deaktivieren" onClick={() => setDeleting(p)} disabled={busy} />}
              </div>
            </div>
          );
        })}
        {ordered.length === 0 && <div className="empty">Noch kein Anbieter. Ein Admin legt den ersten Endpunkt an.</div>}
      </div>

      <Dialog isOpen={!!draft} onClose={() => setDraft(null)} title={draft?.id ? "Anbieter bearbeiten" : "Anbieter hinzufügen"}
        style={{ width: 660, maxWidth: "calc(100vw - 24px)" }}>
        <DialogBody>
          {draft && (
            <div className="settings-grid">
              <FormGroup label="Vorlage" className="full">
                <HTMLSelect fill value={draft.presetKey || (presets[draft.kind] ? draft.kind : "custom")}
                  onChange={(e) => applyPreset(e.target.value)}>
                  {Object.entries(presets).map(([key, preset]) => (
                    <option key={key} value={key}>{preset.name || key}</option>
                  ))}
                  <option value="custom">Benutzerdefiniert (OpenAI-kompatibel)</option>
                </HTMLSelect>
                {activePreset?.hint && (
                  <div className="provider-preset-hint">
                    {activePreset.hint}
                    {ENV_VAR_HINT[draft.kind] && <> · Umgebungsvariable: <code>{ENV_VAR_HINT[draft.kind]}</code></>}
                  </div>
                )}
              </FormGroup>
              <FormGroup label="Name" labelFor="provider-name">
                <InputGroup id="provider-name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
              </FormGroup>
              <FormGroup label="Art / Protokoll-Schlüssel" labelFor="provider-kind">
                <InputGroup id="provider-kind" value={draft.kind} onChange={(e) => patch({ kind: e.target.value })} />
              </FormGroup>
              <FormGroup label="Basis-URL" labelFor="provider-base" className="full">
                <InputGroup id="provider-base" value={draft.base_url}
                  placeholder="https://generativelanguage.googleapis.com/v1beta/openai"
                  onChange={(e) => patch({ base_url: e.target.value })} />
              </FormGroup>
              <FormGroup label="Modelle-Endpunkt (optional)" labelFor="provider-models" className="full"
                helperText="Leer = Basis-URL + /models. Für Azure oder Perplexity leer lassen.">
                <InputGroup id="provider-models" value={draft.models_url}
                  onChange={(e) => patch({ models_url: e.target.value })} />
              </FormGroup>
              <FormGroup label="API-Schlüssel" labelFor="provider-key" className="full"
                helperText={
                  activePreset?.requires_key === "false"
                    ? "Für lokale Server (Ollama, LM Studio, vLLM) optional."
                    : draft.id
                      ? "Leer lassen behält den gespeicherten Schlüssel."
                      : `Wird versiegelt gespeichert.${ENV_VAR_HINT[draft.kind] ? ` Alternativ ${ENV_VAR_HINT[draft.kind]} in der Umgebung setzen.` : ""}`
                }>
                <InputGroup id="provider-key" type="password" value={draft.api_key}
                  autoComplete="new-password" onChange={(e) => patch({ api_key: e.target.value })} />
              </FormGroup>
              <FormGroup label="Standardmodell" labelFor="provider-model">
                <InputGroup id="provider-model" value={draft.default_model}
                  placeholder="z. B. gemini-2.5-flash"
                  onChange={(e) => patch({ default_model: e.target.value })} />
              </FormGroup>
              <FormGroup label="Zusatz-Header (JSON)" labelFor="provider-headers" className="full">
                <TextArea id="provider-headers" fill rows={3} value={draft.headers}
                  onChange={(e) => patch({ headers: e.target.value })} />
              </FormGroup>
              <FormGroup label="Status" className="full">
                <Switch checked={draft.enabled} label="aktiv"
                  onChange={(e) => patch({ enabled: (e.target as HTMLInputElement).checked })} />
                <Switch checked={draft.is_default} label="als Standard"
                  onChange={(e) => patch({ is_default: (e.target as HTMLInputElement).checked })} />
              </FormGroup>
            </div>
          )}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setDraft(null)} disabled={busy} />
            <Button intent="primary" text="Speichern" onClick={save} loading={busy} />
          </>
        } />
      </Dialog>

      <Dialog isOpen={!!deleting} onClose={() => setDeleting(null)} title="Anbieter deaktivieren">
        <DialogBody>
          <p>„{deleting?.name}“ wird für neue Chats ausgeblendet. Bestehende Chats behalten ihre Zuordnung.</p>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setDeleting(null)} />
            <Button intent="danger" text="Deaktivieren" onClick={remove} loading={busy} />
          </>
        } />
      </Dialog>
    </div>
  );
}
