import {
  Button, Callout, Card, FormGroup, HTMLSelect, HTMLTable, Icon, InputGroup, Spinner, Switch, Tag,
} from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { toastError, toastSuccess } from "../toast";
import { THEME_LABEL, ThemeMode, cycleMode, readMode } from "../theme";
import { THEME_EVENT } from "./ThemeSwitch";

export interface SystemInfoData {
  app_name: string;
  version: string;
  engine_version: string;
  version_label: string;
  mode: "playground" | "production" | string;
  demo: boolean;
  install_kind: "binary" | "docker" | "git" | "package" | string;
  git_commit: string;
  git_branch: string;
  python_version: string;
  platform: string;
  hostname: string;
  docker: {
    installed: boolean;
    version: string;
    running: boolean;
  };
  localnet_only: boolean;
  lan_ips: string[];
  uptime_seconds: number;
  started_at: string;
  license: string;
  repo_url: string;
  releases_url: string;
  website_url: string;
  data_dir: string;
  database_backend: string;
  update: {
    latest_version: string | null;
    latest_tag: string | null;
    update_available: boolean;
    release_url: string;
  };
}

export interface SystemSettingsData {
  instance_name: string;
  update_channel: "stable" | "beta";
  auto_check_updates: boolean;
  default_language: "de" | "en";
  telemetry_enabled: boolean;
  telemetry_notice: string;
}

const INSTALL_KIND_LABEL: Record<string, string> = {
  binary: "Standalone",
  docker: "Docker",
  git: "Git-Checkout",
  package: "Python-Paket",
};

function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export default function SystemSettingsPanel({
  isAdmin = true,
  onNavigateTab,
  onCloseDialog,
}: {
  isAdmin?: boolean;
  onNavigateTab?: (tabId: string) => void;
  onCloseDialog?: () => void;
}) {
  const [info, setInfo] = useState<SystemInfoData | null>(null);
  const [settings, setSettings] = useState<SystemSettingsData | null>(null);
  const [instanceName, setInstanceName] = useState("Gimel");
  const [updateChannel, setUpdateChannel] = useState<"stable" | "beta">("stable");
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
  const [defaultLanguage, setDefaultLanguage] = useState<"de" | "en">("de");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [themeMode, setThemeMode] = useState<ThemeMode>(readMode);

  useEffect(() => {
    const onTheme = () => setThemeMode(readMode());
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [sysInfo, sysSettings] = await Promise.all([
        api<SystemInfoData>("/api/system/info"),
        api<SystemSettingsData>("/api/system/settings"),
      ]);
      setInfo(sysInfo);
      setSettings(sysSettings);
      setInstanceName(sysSettings.instance_name);
      setUpdateChannel(sysSettings.update_channel);
      setAutoCheckUpdates(sysSettings.auto_check_updates);
      setDefaultLanguage(sysSettings.default_language);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    if (!isAdmin) return;
    setSaving(true);
    try {
      const updated = await api<SystemSettingsData>("/api/system/settings", {
        method: "PATCH",
        body: JSON.stringify({
          instance_name: instanceName.trim() || "Gimel",
          update_channel: updateChannel,
          auto_check_updates: autoCheckUpdates,
          default_language: defaultLanguage,
        }),
      });
      setSettings(updated);
      setInstanceName(updated.instance_name);
      setUpdateChannel(updated.update_channel);
      setAutoCheckUpdates(updated.auto_check_updates);
      setDefaultLanguage(updated.default_language);
      toastSuccess("Systemeinstellungen gespeichert.");
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  };

  const copyDiagnostics = async () => {
    if (!info) return;
    const dockerStr = info.docker.installed
      ? `${info.docker.running ? "aktiv" : "gestoppt"}${info.docker.version ? ` (${info.docker.version})` : ""}`
      : "nicht gefunden";
    const lines = [
      `## ${info.app_name} Systemdiagnose`,
      `- **Version:** v${info.version} (Engine ${info.engine_version})`,
      `- **Modus:** ${info.mode}${info.demo ? " (Demo)" : ""}`,
      `- **Installation:** ${INSTALL_KIND_LABEL[info.install_kind] ?? info.install_kind}`,
      ...(info.git_commit ? [`- **Git:** ${info.git_branch || "HEAD"} @ \`${info.git_commit}\``] : []),
      `- **Python:** ${info.python_version}`,
      `- **Docker:** ${dockerStr}`,
      `- **Plattform:** ${info.platform}`,
      `- **Datenbank:** ${info.database_backend}`,
      `- **Localnet:** ${info.localnet_only ? "aktiv" : "aus"} (${info.lan_ips.join(", ") || "localhost"})`,
      `- **Laufzeit:** ${formatUptime(info.uptime_seconds)}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toastSuccess("System-Info in Zwischenablage kopiert.");
    } catch {
      toastError("Zwischenablage nicht verfügbar.");
    }
  };

  const handleCycleTheme = () => {
    const next = cycleMode();
    setThemeMode(next);
    window.dispatchEvent(new Event(THEME_EVENT));
  };

  const jumpToAdminRoute = (hashRoute: string, tabId?: string) => {
    if (onNavigateTab && tabId) {
      onNavigateTab(tabId);
      return;
    }
    onCloseDialog?.();
    window.location.hash = `#/${hashRoute}`;
  };

  if (loading && !info) {
    return (
      <div style={{ padding: 24, display: "flex", alignItems: "center", gap: 10 }}>
        <Spinner size={20} />
        <span>Systeminformationen werden geladen…</span>
      </div>
    );
  }

  if (error && !info) {
    return (
      <Callout intent="danger" title="Systeminformationen konnten nicht geladen werden">
        {error}
        <div style={{ marginTop: 8 }}>
          <Button small icon="refresh" text="Erneut versuchen" onClick={() => void load()} />
        </div>
      </Callout>
    );
  }

  if (!info) return null;

  const dockerTag = info.docker.installed
    ? info.docker.running
      ? { intent: "success" as const, text: `Installiert & aktiv${info.docker.version ? ` (${info.docker.version})` : ""}` }
      : { intent: "warning" as const, text: `Installiert (gestoppt)${info.docker.version ? ` · ${info.docker.version}` : ""}` }
    : { intent: "none" as const, text: "Nicht gefunden" };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Version & Build */}
      <Card elevation={0} style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Icon icon="cube" size={16} />
            <strong style={{ fontSize: 15 }}>{info.app_name} v{info.version}</strong>
            <Tag minimal className="mono">Engine {info.engine_version}</Tag>
            <Tag intent={info.mode === "production" ? "primary" : "warning"} minimal>
              {info.mode === "production" ? "Production" : "Playground"}
            </Tag>
            <Tag minimal>{INSTALL_KIND_LABEL[info.install_kind] ?? info.install_kind}</Tag>
            {info.update?.update_available && (
              <Tag intent="warning" icon="cloud-download">
                Update verfügbar: {info.update.latest_tag || `v${info.update.latest_version}`}
              </Tag>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button small icon="clipboard" text="System-Info kopieren" onClick={() => void copyDiagnostics()} />
            <Button small icon="refresh" title="Aktualisieren" loading={loading} onClick={() => void load()} />
          </div>
        </div>

        <HTMLTable compact striped style={{ width: "100%" }}>
          <tbody>
            <tr>
              <td style={{ width: 190, opacity: 0.75 }}>Version-Label</td>
              <td className="mono">{info.version_label}</td>
            </tr>
            {info.git_commit && (
              <tr>
                <td style={{ opacity: 0.75 }}>Git-Stand</td>
                <td className="mono">{info.git_branch || "HEAD"} @ {info.git_commit}</td>
              </tr>
            )}
            <tr>
              <td style={{ opacity: 0.75 }}>Laufzeit (Uptime)</td>
              <td className="mono">{formatUptime(info.uptime_seconds)} · Start {new Date(info.started_at).toLocaleString("de-DE")}</td>
            </tr>
          </tbody>
        </HTMLTable>
      </Card>

      {/* Runtime & Environment */}
      <Card elevation={0} style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon icon="server" size={16} />
          <strong style={{ fontSize: 15 }}>Laufzeit & Umgebung</strong>
        </div>
        <HTMLTable compact striped style={{ width: "100%" }}>
          <tbody>
            <tr>
              <td style={{ width: 190, opacity: 0.75 }}>Python-Version</td>
              <td className="mono">{info.python_version}</td>
            </tr>
            <tr>
              <td style={{ opacity: 0.75 }}>Docker-Status</td>
              <td>
                <Tag minimal intent={dockerTag.intent}>{dockerTag.text}</Tag>
              </td>
            </tr>
            <tr>
              <td style={{ opacity: 0.75 }}>Plattform / Host</td>
              <td className="mono">{info.platform} · {info.hostname}</td>
            </tr>
            <tr>
              <td style={{ opacity: 0.75 }}>Datenbank-Backend</td>
              <td className="mono">{info.database_backend}</td>
            </tr>
            {info.data_dir && (
              <tr>
                <td style={{ opacity: 0.75 }}>Datenverzeichnis</td>
                <td className="mono">{info.data_dir}</td>
              </tr>
            )}
            <tr>
              <td style={{ opacity: 0.75 }}>Netzwerkschutz</td>
              <td>
                <Tag minimal intent={info.localnet_only ? "success" : "warning"}>
                  {info.localnet_only ? "Nur lokales Netzwerk (LocalnetGuard aktiv)" : "Offen"}
                </Tag>
                {info.lan_ips.length > 0 && (
                  <span className="mono" style={{ marginLeft: 8, fontSize: 12, opacity: 0.8 }}>
                    LAN: {info.lan_ips.join(", ")}
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </HTMLTable>
      </Card>

      {/* Allgemeine Einstellungen */}
      <Card elevation={0} style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon icon="cog" size={16} />
            <strong style={{ fontSize: 15 }}>Allgemeine Einstellungen</strong>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button
              small
              icon={themeMode === "dark" ? "moon" : themeMode === "light" ? "flash" : "contrast"}
              text={`Design: ${THEME_LABEL[themeMode]}`}
              onClick={handleCycleTheme}
            />
            {isAdmin && (
              <>
                <Button small icon="cloud-download" text="Updates" onClick={() => jumpToAdminRoute("admin", "updates")} />
                <Button small icon="people" text="Konten" onClick={() => jumpToAdminRoute("admin", "konten")} />
              </>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <FormGroup label="Instanzname" style={{ marginBottom: 0 }}>
            <InputGroup
              value={instanceName}
              disabled={!isAdmin || saving}
              onChange={(e) => setInstanceName(e.currentTarget.value)}
            />
          </FormGroup>

          <FormGroup label="Sprache" style={{ marginBottom: 0 }}>
            <HTMLSelect
              fill
              value={defaultLanguage}
              disabled={!isAdmin || saving}
              onChange={(e) => setDefaultLanguage(e.currentTarget.value as "de" | "en")}
            >
              <option value="de">Deutsch (de)</option>
              <option value="en">English (en)</option>
            </HTMLSelect>
          </FormGroup>

          <FormGroup label="Update-Kanal" style={{ marginBottom: 0 }}>
            <HTMLSelect
              fill
              value={updateChannel}
              disabled={!isAdmin || saving}
              onChange={(e) => setUpdateChannel(e.currentTarget.value as "stable" | "beta")}
            >
              <option value="stable">Stable</option>
              <option value="beta">Beta</option>
            </HTMLSelect>
          </FormGroup>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <Switch
            checked={autoCheckUpdates}
            disabled={!isAdmin || saving}
            label="Automatische Update-Prüfung"
            style={{ margin: 0 }}
            onChange={(e) => setAutoCheckUpdates(e.currentTarget.checked)}
          />
          {isAdmin ? (
            <Button
              intent="primary"
              icon="floppy-disk"
              text="Einstellungen speichern"
              loading={saving}
              onClick={() => void handleSave()}
            />
          ) : (
            <Tag minimal>Nur Administratoren können Instanz-Einstellungen ändern</Tag>
          )}
        </div>
      </Card>

      {/* Lizenz & Links */}
      <Card elevation={0} style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon icon="shield" size={16} />
            <strong style={{ fontSize: 15 }}>Lizenz & Links</strong>
          </div>
          <Tag intent="success" minimal icon="lock">
            {settings?.telemetry_notice ?? "Keine Telemetrie — 100% lokal"}
          </Tag>
        </div>
        <div style={{ fontSize: 13, opacity: 0.85 }}>{info.license}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="bp5-button bp5-small bp5-minimal" href={info.repo_url} target="_blank" rel="noopener noreferrer">
            <Icon icon="git-repo" size={14} style={{ marginRight: 6 }} />
            GitHub
          </a>
          <a className="bp5-button bp5-small bp5-minimal" href={info.releases_url} target="_blank" rel="noopener noreferrer">
            <Icon icon="tag" size={14} style={{ marginRight: 6 }} />
            Releases
          </a>
          <a className="bp5-button bp5-small bp5-minimal" href={info.website_url} target="_blank" rel="noopener noreferrer">
            <Icon icon="globe" size={14} style={{ marginRight: 6 }} />
            FyreFly Systems
          </a>
        </div>
      </Card>
    </div>
  );
}
