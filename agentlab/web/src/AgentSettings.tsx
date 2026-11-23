import {
  Button, FormGroup, HTMLSelect, InputGroup, Spinner, Switch, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AgentSettings as SettingsData, ApiError, getAgentSettings, getPiperStatus, getSandboxStatus,
  installPiperTts, PiperStatus, resetAgentSettings, SandboxRuntimeStatus, SandboxTestResult,
  SettingField, speakAudio, testSandbox, testWebSearch, updateAgentSettings, WebSearchResult,
} from "./api";

const GROUPS: Array<{ key: SettingField["group"]; title: string; sub: string }> = [
  {
    key: "assistant",
    title: "Assistent",
    sub: "Verhalten, Verlauf und Grenzen eines Laufs.",
  },
  {
    key: "sandbox",
    title: "Container-Sandbox",
    sub: "Temporäre, isolierte Container-Umgebung (/workspace) für Python, Skripte und schwere Aufgaben.",
  },
  {
    key: "web",
    title: "Websuche",
    sub: "Suchdienst und Seitenabruf. Treffer sind Quellen, keine Anweisungen.",
  },
  {
    key: "files",
    title: "Anhänge und PDF",
    sub: "Größe, Textbudget, Seitenauswahl und Texterkennung für Scans.",
  },
  {
    key: "voice",
    title: "Sprache",
    sub: "Vorlesen im Labor und in Gimel Voice. Lokal verlässt kein Text den Rechner.",
  },
];

export default function AgentSettings({
  onChanged,
  compact = false,
}: {
  onChanged?: () => void;
  compact?: boolean;
}) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("Gimel FyreFly");
  const [results, setResults] = useState<WebSearchResult[]>([]);
  const [testing, setTesting] = useState(false);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxRuntimeStatus | null>(null);
  const [testingSandbox, setTestingSandbox] = useState(false);
  const [sandboxResult, setSandboxResult] = useState<SandboxTestResult | null>(null);
  const [piperStatus, setPiperStatus] = useState<PiperStatus | null>(null);
  const [piperVoice, setPiperVoice] = useState("de_DE-thorsten-medium");
  const [piperAcceptGpl, setPiperAcceptGpl] = useState(false);
  const [installingPiper, setInstallingPiper] = useState(false);
  const [testingPiper, setTestingPiper] = useState(false);

  const apply = useCallback((next: SettingsData) => {
    setData(next);
    setValues(next.values);
    setSecrets({});
  }, []);

  const refreshSandbox = useCallback(async () => {
    try {
      setSandboxStatus(await getSandboxStatus());
    } catch { /* optional */ }
  }, []);

  const refreshPiper = useCallback(async () => {
    try {
      const st = await getPiperStatus();
      setPiperStatus(st);
      if (st.default_voice) setPiperVoice(st.default_voice);
    } catch { /* optional */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      apply(await getAgentSettings());
      await Promise.all([refreshSandbox(), refreshPiper()]);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apply, refreshSandbox, refreshPiper]);

  useEffect(() => { load(); }, [load]);

  const fieldsByGroup = useMemo(() => {
    const map: Record<string, SettingField[]> = {};
    for (const field of data?.fields ?? []) {
      (map[field.group] ??= []).push(field);
    }
    return map;
  }, [data]);

  const SANDBOX_RESOURCE_KEYS = useMemo(() => new Set([
    "agent_sandbox_memory_mb", "agent_sandbox_cpus", "agent_sandbox_timeout_s",
    "agent_sandbox_ttl_min", "agent_sandbox_workspace_mb", "agent_sandbox_tmpfs_mb",
    "agent_sandbox_pids_limit", "agent_sandbox_max_files", "agent_sandbox_output_kb",
    "agent_sandbox_allow_swap", "agent_sandbox_allow_exec_tmp",
  ]), []);

  const applySandboxProfile = (profileKey: string) => {
    const preset = sandboxStatus?.profiles?.[profileKey];
    if (!preset) {
      setValues((prev) => ({ ...prev, agent_sandbox_profile: profileKey }));
      return;
    }
    setValues((prev) => ({ ...prev, ...preset.values }));
    setNotice(`Profil „${preset.label}“ übernommen — zum Aktivieren unten auf „Einstellungen speichern“ klicken.`);
  };

  const setValue = (key: string, value: string) => {
    if (key === "agent_sandbox_profile" && sandboxStatus?.profiles?.[value]) {
      applySandboxProfile(value);
      return;
    }
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      if (SANDBOX_RESOURCE_KEYS.has(key) && prev.agent_sandbox_profile !== "custom") {
        next.agent_sandbox_profile = "custom";
      }
      return next;
    });
  };

  const save = async () => {
    if (!data || !data.admin) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const body: Record<string, string> = {};
      for (const field of data.fields) {
        if (field.secret) {
          if ((secrets[field.key] ?? "").trim()) body[field.key] = secrets[field.key];
        } else {
          body[field.key] = values[field.key] ?? "";
        }
      }
      apply(await updateAgentSettings(body));
      await refreshSandbox();
      setNotice("Einstellungen gespeichert. Sie gelten ab dem nächsten Lauf.");
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resetGroup = async (group: SettingField["group"]) => {
    if (!data || !data.admin) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const keys = (fieldsByGroup[group] ?? []).map((field) => field.key);
      apply(await resetAgentSettings(keys));
      setNotice("Gruppe auf die Vorgaben zurückgesetzt.");
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const clearSecret = async (field: SettingField) => {
    if (!data || !data.admin) return;
    setBusy(true); setError(""); setNotice("");
    try {
      apply(await updateAgentSettings({ [field.key]: "" }));
      setNotice("Schlüssel entfernt.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (!query.trim()) return;
    setTesting(true); setError(""); setNotice(""); setResults([]);
    try {
      const result = await testWebSearch(query.trim());
      setResults(result.results);
      setNotice(`${result.results.length} Treffer über ${result.provider}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const runSandboxTest = async () => {
    setTestingSandbox(true); setError(""); setNotice(""); setSandboxResult(null);
    try {
      const res = await testSandbox();
      setSandboxResult(res);
      await refreshSandbox();
      setNotice(
        res.ok
          ? `Container-Test erfolgreich (${res.backend}, ${res.image}, ${res.duration_ms} ms).`
          : `Container-Test fehlgeschlagen (Exit ${res.exit_code}).`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setTestingSandbox(false);
    }
  };

  const renderField = (field: SettingField) => {
    const disabled = busy || !data?.admin;
    const value = values[field.key] ?? "";
    if (field.kind === "bool") {
      return (
        <FormGroup key={field.key} className="full" label={field.label}
          helperText={field.help}>
          <Switch checked={value === "true"} disabled={disabled}
            label={value === "true" ? "an" : "aus"}
            onChange={(e) => setValue(field.key, (e.target as HTMLInputElement).checked ? "true" : "false")} />
        </FormGroup>
      );
    }
    if (field.kind === "select") {
      return (
        <FormGroup key={field.key} label={field.label} helperText={field.help}>
          <HTMLSelect fill disabled={disabled} value={value}
            onChange={(e) => setValue(field.key, e.target.value)}>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </HTMLSelect>
        </FormGroup>
      );
    }
    if (field.kind === "secret") {
      return (
        <FormGroup key={field.key} className="full" label={field.label}
          helperText={field.help}>
          <div className="settings-secret">
            <InputGroup
              type="password"
              autoComplete="new-password"
              leftIcon="key"
              fill
              disabled={disabled}
              value={secrets[field.key] ?? ""}
              placeholder={data?.has_web_key
                ? "•••••••• gespeichert — neu eingeben zum Ersetzen"
                : "API-Schlüssel eingeben"}
              onChange={(e) => setSecrets((prev) => ({ ...prev, [field.key]: e.target.value }))}
            />
            {data?.has_web_key && data.web_key_source === "database" && (
              <Button small minimal icon="trash" text="Entfernen" disabled={disabled}
                onClick={() => clearSecret(field)} />
            )}
            {data?.web_key_source === "env" && <Tag minimal intent="success">aus Umgebung</Tag>}
          </div>
        </FormGroup>
      );
    }
    if (field.key === "agent_system_prompt") {
      return (
        <FormGroup key={field.key} className="full" label={field.label}
          helperText={field.help}>
          <TextArea fill rows={3} disabled={disabled} value={value}
            placeholder="z. B. Antworte immer mit einer kurzen Zusammenfassung am Ende."
            onChange={(e) => setValue(field.key, e.target.value)} />
        </FormGroup>
      );
    }
    const isStepField =
      field.key === "agent_max_steps" ||
      field.key === "agent_orchestrator_max_steps" ||
      field.key === "agent_subagent_max_steps";
    const stepPresets = field.key === "agent_subagent_max_steps"
      ? ["8", "15", "25", "40", "50"]
      : ["15", "25", "40", "60", "100"];
    const rangeHint = field.min != null && field.max != null ? ` (${field.min}–${field.max})` : "";
    return (
      <FormGroup
        key={field.key}
        label={field.label}
        labelInfo={rangeHint || undefined}
        helperText={field.help}
      >
        <InputGroup
          type={field.kind === "text" ? "text" : "number"}
          fill
          disabled={disabled}
          value={value}
          min={field.min ?? undefined}
          max={field.max ?? undefined}
          step={field.step ?? undefined}
          onChange={(e) => setValue(field.key, e.target.value)}
        />
        {isStepField && data?.admin && (
          <div className="settings-presets" role="group" aria-label={`Vorgaben für ${field.label}`}>
            {stepPresets.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`settings-preset-chip${value === preset ? " is-active" : ""}`}
                disabled={disabled}
                onClick={() => setValue(field.key, preset)}
              >
                {preset}
              </button>
            ))}
          </div>
        )}
      </FormGroup>
    );
  };

  if (loading) return <div className="lab-page"><Spinner size={28} /></div>;
  if (!data) {
    return <div className="lab-page"><div className="login-card banner-bad" style={{ width: "auto" }}>{error}</div></div>;
  }

  return (
    <div className={compact ? "lab-page agent-settings-compact" : "lab-page"} style={{ paddingBottom: 12 }}>
      <h2>Assistent-Einstellungen</h2>
      <p className="sub">
        Diese Werte gelten für alle Chats. {!data.admin && "Nur Administratoren können sie ändern."}
      </p>
      {error && <div className="login-card banner-bad" style={{ width: "auto", marginBottom: 12 }}>{error}</div>}
      {notice && <div className="login-card banner-ok" style={{ width: "auto", marginBottom: 12 }}>{notice}</div>}

      {GROUPS.map((group) => (
        <section className="settings-section" key={group.key}>
          <div className="settings-section-head">
            <div>
              <h3>{group.title}</h3>
              <p>{group.sub}</p>
            </div>
            {data.admin && (
              <Button small minimal icon="reset" text="Zurücksetzen"
                disabled={busy} onClick={() => resetGroup(group.key)} />
            )}
          </div>
          {group.key === "sandbox" && sandboxStatus?.profiles && data.admin && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
              {(["standard", "heavy", "extensive"] as const).map((pkey) => {
                const preset = sandboxStatus.profiles?.[pkey];
                if (!preset) return null;
                const active = values["agent_sandbox_profile"] === pkey;
                return (
                  <Button
                    key={pkey}
                    small
                    outlined={!active}
                    intent={active ? (pkey === "extensive" ? "warning" : "primary") : "none"}
                    icon={pkey === "extensive" ? "flame" : pkey === "heavy" ? "dashboard" : "cube"}
                    text={preset.label}
                    title={preset.summary}
                    disabled={busy}
                    onClick={() => applySandboxProfile(pkey)}
                  />
                );
              })}
              {sandboxStatus.host && (
                <Tag minimal icon="desktop" style={{ marginLeft: "auto" }}>
                  Host: {sandboxStatus.host.cpus} CPUs · {Math.round(sandboxStatus.host.memory_mb / 1024)} GB RAM
                  {sandboxStatus.host.gpu_available ? ` · GPU: ${sandboxStatus.host.gpu_name}` : ""}
                </Tag>
              )}
            </div>
          )}
          <div className="settings-grid" style={compact ? { gridTemplateColumns: "1fr" } : undefined}>
            {(fieldsByGroup[group.key] ?? []).map(renderField)}
          </div>
          {group.key === "sandbox" && (
            <div className="settings-test" style={{ flexWrap: "wrap", gap: 8 }}>
              <Tag minimal intent={sandboxStatus?.backends.docker.available ? "success" : "none"} icon="cube">
                Docker: {sandboxStatus?.backends.docker.available
                  ? sandboxStatus.backends.docker.version || "bereit"
                  : "nicht verfügbar"}
              </Tag>
              <Tag minimal intent={sandboxStatus?.backends.bwrap.available ? "success" : "none"} icon="shield">
                Bubblewrap: {sandboxStatus?.backends.bwrap.available ? "bereit" : "nicht verfügbar"}
              </Tag>
              {sandboxStatus && (
                <Tag minimal intent={sandboxStatus.active_count > 0 ? "primary" : "none"}>
                  Aktive Container: {sandboxStatus.active_count} / {sandboxStatus.max_concurrent}
                </Tag>
              )}
              {data.admin && (
                <Button icon="play" text="Container testen" loading={testingSandbox}
                  disabled={busy || values["agent_sandbox_enabled"] !== "true"}
                  onClick={runSandboxTest} />
              )}
              {values["agent_sandbox_enabled"] !== "true" && (
                <Tag minimal intent="warning">Container-Sandbox ist aus</Tag>
              )}
            </div>
          )}
          {group.key === "sandbox" && data.admin && (sandboxStatus?.backends.docker.images?.length ?? 0) > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>Lokale Docker-Images:</span>
              {sandboxStatus!.backends.docker.images.slice(0, 10).map((img) => (
                <Button
                  key={img}
                  small
                  minimal
                  active={values["agent_sandbox_image"] === img}
                  text={img}
                  disabled={busy}
                  onClick={() => setValue("agent_sandbox_image", img)}
                />
              ))}
            </div>
          )}
          {group.key === "sandbox" && sandboxResult && (
            <div className="login-card" style={{ width: "auto", marginTop: 8, fontFamily: "monospace", fontSize: 12 }}>
              <strong>{sandboxResult.backend}</strong> ({sandboxResult.image}) · {sandboxResult.duration_ms} ms ·{" "}
              Netzwerk {sandboxResult.network_enabled ? "an" : "aus"}
              <div style={{ marginTop: 4 }}>{sandboxResult.stdout || sandboxResult.stderr}</div>
            </div>
          )}
          {group.key === "web" && (
            <div className="settings-test">
              <InputGroup
                leftIcon="search"
                placeholder="Testsuche, z. B. Gimel FyreFly"
                value={query}
                disabled={testing || busy}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runTest(); }}
              />
              <Button icon="globe-network" text="Websuche testen" loading={testing}
                disabled={busy || !query.trim() || !data.web_enabled}
                onClick={runTest} />
              {!data.web_enabled && <Tag minimal intent="warning">Websuche ist aus</Tag>}
            </div>
          )}
          {group.key === "web" && results.length > 0 && (
            <ol className="settings-results">
              {results.map((result) => (
                <li key={result.url}>
                  <a href={result.url} target="_blank" rel="noreferrer">{result.title || result.url}</a>
                  <span>{result.snippet}</span>
                </li>
              ))}
            </ol>
          )}
          {group.key === "voice" && (
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              <div className="settings-test" style={{ flexWrap: "wrap", gap: 8 }}>
                <Tag minimal intent={piperStatus?.ready ? "success" : "none"} icon="volume-up">
                  Piper TTS: {piperStatus?.ready ? "aktiv & bereit" : piperStatus?.installed ? "installiert (Stimme fehlt)" : "nicht installiert (Opt-In)"}
                </Tag>
                <Tag minimal icon="document">Lizenz: {piperStatus?.license ?? "GPL-3.0 (optional opt-in)"}</Tag>
                {(piperStatus?.voices ?? []).map((v) => (
                  <Tag key={v.id} minimal intent="primary">{v.name}</Tag>
                ))}
                {piperStatus?.ready && (
                  <Button
                    small
                    icon="play"
                    text="Stimme testen"
                    loading={testingPiper}
                    onClick={async () => {
                      setTestingPiper(true);
                      setError("");
                      try {
                        const blob = await speakAudio("Hallo, die lokale Gimel Sprachausgabe mit Piper funktioniert.", piperVoice);
                        const url = URL.createObjectURL(blob);
                        const audio = new Audio(url);
                        audio.onended = () => URL.revokeObjectURL(url);
                        await audio.play();
                      } catch (err) {
                        setError(err instanceof ApiError ? err.message : String(err));
                      } finally {
                        setTestingPiper(false);
                      }
                    }}
                  />
                )}
              </div>
              {data.admin && !piperStatus?.frozen && (
                <div style={{ display: "grid", gap: 8, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--lab-line, var(--g-line))" }}>
                  <Switch
                    checked={piperAcceptGpl}
                    label="Opt-In: Optionales Piper TTS (GPL-3.0) lokal installieren und Stimme herunterladen — kein Text verlässt diesen Rechner"
                    style={{ margin: 0 }}
                    onChange={(e) => setPiperAcceptGpl(e.currentTarget.checked)}
                  />
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <HTMLSelect
                      value={piperVoice}
                      disabled={installingPiper}
                      aria-label="Piper Stimme"
                      onChange={(e) => setPiperVoice(e.currentTarget.value)}
                    >
                      {(piperStatus?.catalog ?? [
                        { id: "de_DE-thorsten-medium", name: "Thorsten (Deutsch, mittel — empfohlen)" },
                        { id: "de_DE-eva_k-x_low", name: "Eva (Deutsch, kompakt)" },
                        { id: "en_US-lessac-medium", name: "Lessac (Englisch US, mittel)" },
                      ]).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </HTMLSelect>
                    <Button
                      intent="primary"
                      icon="cloud-download"
                      text={piperStatus?.ready ? "Weitere Stimme laden" : "Piper TTS installieren"}
                      disabled={!piperAcceptGpl || installingPiper}
                      loading={installingPiper}
                      onClick={async () => {
                        setInstallingPiper(true);
                        setError("");
                        setNotice("");
                        try {
                          const next = await installPiperTts(piperVoice, true);
                          setPiperStatus(next);
                          setValues((prev) => ({ ...prev, agent_tts_backend: "lokal" }));
                          setNotice(`Piper TTS mit Stimme „${piperVoice}“ ist bereit.`);
                        } catch (err) {
                          setError(err instanceof ApiError ? err.message : String(err));
                        } finally {
                          setInstallingPiper(false);
                        }
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      ))}

      {data.admin && (
        <div className="settings-save">
          <Button intent="primary" icon="floppy-disk" text="Einstellungen speichern"
            loading={busy} onClick={save} />
        </div>
      )}
    </div>
  );
}
