import { Button, Icon, Menu, MenuDivider, MenuItem, Popover, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, Artifact, Attachment, Chat, ChatSandboxState, Change, destroyChatSandbox,
  getChatSandbox, getSandboxStatus, Message, SandboxFile, SandboxSession, startChatSandbox,
  stopSandboxContainer,
} from "./api";
import {
  attachmentMeta, chatToMarkdown, copyToClipboard, downloadText, fileKind, formatTokens,
  formatUsage, isPdf, messageToolCards, persistedTool, relativeTime, sizeText, timeText,
  toolIcon, toolTone,
} from "./chatUtils";
import { toolLabel } from "./toolLabels";

type ContextTab = "context" | "activity" | "details";

type ActivityRow = {
  key: string;
  time: string;
  title: string;
  summary: string;
  icon: string;
  status: "ok" | "error" | "running";
  write: boolean;
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9äöüß]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "chat";
}

export default function ChatContext({
  chat, messages, attachments, changes, artifacts = [], onClose, onOpenChanges,
  onPreviewAttachment, onPreviewArtifact, onPreviewSandboxFile,
}: {
  chat: Chat;
  messages: Message[];
  attachments: Attachment[];
  changes: Change[];
  artifacts?: Artifact[];
  onClose: () => void;
  onOpenChanges: () => void;
  onPreviewAttachment?: (att: Attachment) => void;
  onPreviewArtifact?: (art: Artifact) => void;
  onPreviewSandboxFile?: (file: SandboxFile) => void;
}) {
  const [tab, setTab] = useState<ContextTab>("context");
  const [copied, setCopied] = useState(false);
  const [sandboxState, setSandboxState] = useState<ChatSandboxState | null>(null);
  const [runningContainers, setRunningContainers] = useState<SandboxSession[]>([]);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [stoppingContainer, setStoppingContainer] = useState<string | null>(null);
  const [sandboxError, setSandboxError] = useState("");

  const toolResults = useMemo(() => {
    const map = new Map<string, Message>();
    for (const message of messages) {
      if (message.role === "tool" && message.tool_call_id) map.set(message.tool_call_id, message);
    }
    return map;
  }, [messages]);

  const tools = useMemo(() => {
    const rows: ActivityRow[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const tool of messageToolCards(message, toolResults)) {
        const live = persistedTool(tool);
        rows.push({
          key: `t-${message.id}-${live.id}`,
          time: message.created_at,
          title: toolLabel(live.name),
          summary: live.summary,
          icon: toolIcon(live.name),
          status: live.status,
          write: toolTone(live.name) === "write",
        });
      }
    }
    return rows;
  }, [messages, toolResults]);

  const allAttachments = useMemo(() => {
    const seen = new Set<number>();
    const rows: Attachment[] = [];
    for (const item of [...attachments, ...messages.flatMap((message) => message.attachments ?? [])]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rows.push(item);
    }
    return rows;
  }, [attachments, messages]);

  const toolCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of tools) counts.set(row.title, (counts.get(row.title) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [tools]);

  const usage = useMemo(() => formatUsage(messages), [messages]);
  const openChanges = changes.filter((change) => change.status === "applied");
  const userMessages = messages.filter((message) => message.role === "user").length;
  const assistantMessages = messages.filter((message) => message.role === "assistant").length;

  const refreshSandbox = useCallback(async () => {
    try {
      const [chatSbx, runtime] = await Promise.all([
        getChatSandbox(chat.id),
        getSandboxStatus().catch(() => null),
      ]);
      setSandboxState(chatSbx);
      if (runtime) setRunningContainers(runtime.sessions ?? []);
      setSandboxError("");
    } catch { /* optional */ }
  }, [chat.id]);

  useEffect(() => {
    refreshSandbox();
  }, [refreshSandbox, tools.length]);

  useEffect(() => {
    const id = window.setInterval(() => { refreshSandbox(); }, 15_000);
    return () => window.clearInterval(id);
  }, [refreshSandbox]);

  const startSandbox = async (recreate = false) => {
    setSandboxBusy(true); setSandboxError("");
    try {
      setSandboxState(await startChatSandbox(chat.id, {
        stage_attachments: !recreate && allAttachments.length > 0,
        recreate,
      }));
      await refreshSandbox();
    } catch (err) {
      setSandboxError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSandboxBusy(false);
    }
  };

  const stopSandbox = async () => {
    setSandboxBusy(true); setSandboxError("");
    try {
      await destroyChatSandbox(chat.id);
      await refreshSandbox();
    } catch (err) {
      setSandboxError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSandboxBusy(false);
    }
  };

  const stopOneContainer = async (containerName: string) => {
    setStoppingContainer(containerName); setSandboxError("");
    try {
      await stopSandboxContainer(containerName);
      await refreshSandbox();
    } catch (err) {
      setSandboxError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setStoppingContainer(null);
    }
  };

  const sandboxFiles = useMemo(
    () => (sandboxState?.sandbox?.files ?? []).filter((f) => f.kind === "file"),
    [sandboxState],
  );

  const exportChat = () => {
    downloadText(`${slug(chat.title || "chat")}.md`, chatToMarkdown(chat, messages, changes));
  };

  const copyChat = async () => {
    if (await copyToClipboard(chatToMarkdown(chat, messages, changes))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <aside className="context-panel" aria-label="Kontext des Chats">
      <div className="context-head">
        <div className="context-head-title">
          <Icon icon="drawer-right" size={15} aria-hidden="true" />
          <span>Kontext</span>
        </div>
        <div className="context-head-actions">
          <Popover
            minimal
            position="bottom"
            content={
              <Menu>
                <MenuItem icon="export" text="Als Markdown exportieren" onClick={exportChat} />
                <MenuItem icon={copied ? "tick" : "clipboard"} text={copied ? "Kopiert" : "Gespräch kopieren"} onClick={copyChat} />
                <MenuDivider />
                <MenuItem icon="changes" text="Änderungen öffnen" onClick={onOpenChanges} disabled={!changes.length} />
              </Menu>
            }
          >
            <Button minimal small icon="more" aria-label="Kontextmenü" />
          </Popover>
          <Button minimal small icon="cross" aria-label="Kontext schließen" onClick={onClose} />
        </div>
      </div>

      <div className="context-tabs" role="tablist" aria-label="Kontextbereiche">
        {([
          ["context", "Kontext", "drawer-right"],
          ["activity", "Aktivität", "timeline-events"],
          ["details", "Details", "info-sign"],
        ] as Array<[ContextTab, string, string]>).map(([key, label, icon]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
            className={tab === key ? "is-active" : ""} onClick={() => setTab(key)}>
            <Icon icon={icon as any} size={13} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      <div className="context-body">
        {tab === "context" && (
          <>
            <section className="context-section">
              <div className="context-section-head">
                <span>Container-Umgebung</span>
                {sandboxState?.active && sandboxState.sandbox ? (
                  <Tag minimal intent="success" icon="cube">
                    {sandboxState.sandbox.backend}
                  </Tag>
                ) : (
                  <Tag minimal>{sandboxState?.enabled === false ? "aus" : "bereit"}</Tag>
                )}
              </div>
              {sandboxError && <p className="context-empty" style={{ color: "var(--bad, #c44a34)" }}>{sandboxError}</p>}
              {sandboxState?.active && sandboxState.sandbox ? (
                <>
                  <div className="context-tool-list" style={{ marginBottom: 6 }}>
                    <div className="context-tool">
                      <span>Image</span>
                      <span className="mono">{sandboxState.sandbox.image}</span>
                    </div>
                    <div className="context-tool">
                      <span>Profil &amp; Limits</span>
                      <span>
                        {sandboxState.sandbox.profile || "standard"} · {sandboxState.sandbox.memory_mb} MB · {sandboxState.sandbox.cpus} CPU
                        {sandboxState.sandbox.gpu_enabled ? " · GPU" : ""}
                      </span>
                    </div>
                    <div className="context-tool">
                      <span>Workspace / Netz</span>
                      <span>
                        {sizeText(sandboxState.sandbox.workspace_bytes)}
                        {sandboxState.sandbox.workspace_mb ? ` / ${sandboxState.sandbox.workspace_mb} MB` : ""}
                        {" · "}Netz {sandboxState.sandbox.network_enabled ? "an" : "aus"}
                      </span>
                    </div>
                    <div className="context-tool">
                      <span>Auto-Löschung</span>
                      <span>
                        in {Math.max(1, Math.ceil(sandboxState.sandbox.remaining_seconds / 60))} Min.
                      </span>
                    </div>
                  </div>
                  {sandboxFiles.length > 0 ? (
                    <div className="context-docs" style={{ marginBottom: 6 }}>
                      {sandboxFiles.slice(0, 12).map((f) => (
                        <button type="button" className="context-doc is-clickable" key={f.path}
                          title={`/workspace/${f.path} (${sizeText(f.size)}) — Klicken für Vorschau`}
                          onClick={() => onPreviewSandboxFile?.(f)}>
                          <span className="attachment-icon text" aria-hidden="true">
                            {(f.path.split(".").pop() || "FILE").slice(0, 4).toUpperCase()}
                          </span>
                          <span className="context-doc-main">
                            <span className="context-doc-name">{f.path}</span>
                            <span className="context-doc-meta">{sizeText(f.size)}</span>
                          </span>
                          <Icon icon="eye-open" size={12} className="context-doc-open" aria-hidden="true" />
                        </button>
                      ))}
                      {sandboxFiles.length > 12 && (
                        <div className="context-more">+{sandboxFiles.length - 12} weitere Dateien</div>
                      )}
                    </div>
                  ) : (
                    <p className="context-empty">/workspace ist noch leer.</p>
                  )}
                  <div className="context-actions" style={{ display: "flex", gap: 6 }}>
                    <Button minimal small icon="refresh" title="Container-Status aktualisieren"
                      disabled={sandboxBusy} onClick={refreshSandbox} />
                    <Button minimal small icon="repeat" title="Container mit aktuellen Einstellungen neu starten (/workspace bleibt erhalten)"
                      disabled={sandboxBusy} onClick={() => startSandbox(true)} />
                    <Button minimal small fill intent="danger" icon="stop" text="Beenden & löschen"
                      loading={sandboxBusy} onClick={stopSandbox} />
                  </div>
                </>
              ) : (
                <>
                  <p className="context-empty">
                    {sandboxState?.enabled === false
                      ? "Container-Sandbox ist in den Einstellungen deaktiviert."
                      : "Temporärer Container (/workspace) startet automatisch bei Python-/Skript-Aufgaben oder per Klick."}
                  </p>
                  {sandboxState?.enabled !== false && (
                    <Button minimal small fill icon="cube-add" text="Container jetzt starten"
                      loading={sandboxBusy} onClick={() => startSandbox(false)} />
                  )}
                </>
              )}
            </section>

            <section className="context-section">
              <div className="context-section-head">
                <span>Laufende Container</span>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <Tag minimal intent={runningContainers.length > 0 ? "success" : "none"}>
                    {runningContainers.length}
                  </Tag>
                  <Button minimal small icon="refresh" title="Laufende Container aktualisieren"
                    disabled={sandboxBusy} onClick={refreshSandbox} />
                </div>
              </div>
              {runningContainers.length > 0 ? (
                <div className="context-docs">
                  {runningContainers.map((c) => {
                    const isCurrent = c.chat_id === chat.id;
                    const metaParts: string[] = [c.backend, c.image];
                    if (c.memory_mb > 0) metaParts.push(`${c.memory_mb} MB`);
                    if (c.cpus > 0) metaParts.push(`${c.cpus} CPU`);
                    if (c.remaining_seconds > 0) {
                      metaParts.push(`${Math.max(1, Math.ceil(c.remaining_seconds / 60))} Min.`);
                    } else if (c.status && c.status !== "running") {
                      metaParts.push(c.status);
                    }
                    return (
                      <div className="context-doc" key={c.container_name}
                        title={`${c.container_name}${c.container_id ? ` (${c.container_id})` : ""}`}>
                        <span className="attachment-icon text" aria-hidden="true"
                          style={isCurrent ? { background: "var(--lab-ok, #0b7a67)", color: "#fff" } : undefined}>
                          {c.backend === "docker" ? "DOC" : "BWR"}
                        </span>
                        <span className="context-doc-main">
                          <span className="context-doc-name">
                            {isCurrent ? "Dieser Chat" : (c.chat_title || `Chat #${c.chat_id}`)}
                          </span>
                          <span className="context-doc-meta mono" style={{ fontSize: 10.5 }}>
                            {c.container_name}
                          </span>
                          <span className="context-doc-meta">
                            {metaParts.join(" · ")}
                          </span>
                        </span>
                        <Button
                          minimal
                          small
                          intent="danger"
                          icon="stop"
                          title={`Container ${c.container_name} stoppen & entfernen`}
                          loading={stoppingContainer === c.container_name}
                          onClick={() => stopOneContainer(c.container_name)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="context-empty">Aktuell läuft kein Container.</p>
              )}
            </section>

            <section className="context-section">
              <div className="context-section-head">
                <span>Artefakte &amp; Vorschau</span>
                <Tag minimal>{artifacts.length}</Tag>
              </div>
              {artifacts.length ? (
                <div className="context-docs">
                  {artifacts.map((art) => (
                    <button type="button" className="context-doc is-clickable" key={art.id}
                      title={`${art.title} · ${art.kind.toUpperCase()} · v${art.version}`}
                      onClick={() => onPreviewArtifact?.(art)}>
                      <span className="attachment-icon text" aria-hidden="true">
                        {art.kind.slice(0, 4).toUpperCase()}
                      </span>
                      <span className="context-doc-main">
                        <span className="context-doc-name">{art.title}</span>
                        <span className="context-doc-meta">v{art.version} · {art.chars.toLocaleString("de-DE")} Z.</span>
                      </span>
                      <Icon icon="eye-open" size={12} className="context-doc-open" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="context-empty">Noch keine Artefakte. Bitten Sie den Assistenten um ein HTML-Dashboard, Diagramm oder einen Bericht.</p>
              )}
            </section>

            <section className="context-section">
              <div className="context-section-head">
                <span>Dokumente</span>
                <Tag minimal>{allAttachments.length}</Tag>
              </div>
              {allAttachments.length ? (
                <div className="context-docs">
                  {allAttachments.map((item) => (
                    <button type="button" className="context-doc is-clickable" key={item.id}
                      title={`${item.filename} · ${attachmentMeta(item)} — Klicken für Vorschau`}
                      onClick={() => onPreviewAttachment?.(item)}>
                      <span className={`attachment-icon ${isPdf(item) ? "" : "text"}`} aria-hidden="true">
                        {fileKind(item)}
                      </span>
                      <span className="context-doc-main">
                        <span className="context-doc-name">{item.filename}</span>
                        <span className="context-doc-meta">{attachmentMeta(item)}</span>
                      </span>
                      <Icon icon="eye-open" size={12} className="context-doc-open" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="context-empty">Noch keine Dokumente angehängt. PDF, HTML, SVG, MD, CSV, JSON und TXT nimmt der Chat über die Büroklammer an.</p>
              )}
            </section>

            <section className="context-section">
              <div className="context-section-head">
                <span>Werkzeuge</span>
                <Tag minimal>{tools.length}</Tag>
              </div>
              {toolCounts.length ? (
                <div className="context-tool-list">
                  {toolCounts.slice(0, 8).map(([label, count]) => (
                    <div className="context-tool" key={label}>
                      <span>{label}</span>
                      <span className="context-tool-count">{count}×</span>
                    </div>
                  ))}
                  {toolCounts.length > 8 && <div className="context-more">+{toolCounts.length - 8} weitere</div>}
                </div>
              ) : (
                <p className="context-empty">In diesem Chat wurde noch kein Werkzeug benutzt.</p>
              )}
            </section>

            <section className="context-section">
              <div className="context-section-head">
                <span>Änderungen</span>
                <Tag minimal intent={openChanges.length ? "warning" : "none"}>{openChanges.length} offen</Tag>
              </div>
              {changes.length ? (
                <>
                  <div className="context-change-list">
                    {changes.slice(0, 4).map((change) => (
                      <div className="context-change" key={change.id}>
                        <Icon icon={change.status === "reverted" ? "undo" : "tick"} size={12}
                          className={change.status === "reverted" ? "is-muted" : "is-ok"} aria-hidden="true" />
                        <span className="context-change-main">
                          <span>{change.summary || toolLabel(change.tool)}</span>
                          <span className="context-change-meta">{change.entity} {change.entity_id}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                  <Button minimal small fill icon="changes" text="Alle Änderungen ansehen"
                    onClick={onOpenChanges} />
                </>
              ) : (
                <p className="context-empty">Der Assistent hat in diesem Chat noch nichts geändert.</p>
              )}
            </section>
          </>
        )}

        {tab === "activity" && (
          <section className="context-section">
            <div className="context-section-head">
              <span>Verlauf</span>
              <Tag minimal>{tools.length}</Tag>
            </div>
            {tools.length ? (
              <div className="context-activity">
                {tools.map((row) => (
                  <div className={`context-activity-row ${row.write ? "is-write" : ""} ${row.status === "error" ? "is-error" : ""}`} key={row.key}>
                    <span className="context-activity-icon"><Icon icon={row.icon as any} size={13} aria-hidden="true" /></span>
                    <span className="context-activity-main">
                      <span className="context-activity-title">
                        {row.title}
                        {row.write && <span className="context-write-dot" title="schreibender Aufruf" />}
                      </span>
                      {row.summary && <span className="context-activity-summary">{row.summary}</span>}
                      <span className="context-activity-meta">{relativeTime(row.time)} · {timeText(row.time)}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="context-empty">Noch keine Aktivität.</p>
            )}
          </section>
        )}

        {tab === "details" && (
          <>
            <section className="context-section">
              <div className="context-section-head"><span>Chat</span></div>
              <dl className="context-details">
                <dt>Anbieter</dt><dd>{chat.provider_name || "kein Anbieter"}</dd>
                <dt>Modell</dt><dd className="mono">{chat.model || "kein Modell"}</dd>
                <dt>Schreibmodus</dt><dd>{chat.write_mode ? "an" : "aus"}</dd>
                <dt>Angelegt</dt><dd>{new Date(chat.created_at).toLocaleString("de-DE")}</dd>
                <dt>Zuletzt</dt><dd>{new Date(chat.last_message_at || chat.updated_at).toLocaleString("de-DE")}</dd>
              </dl>
            </section>
            <section className="context-section">
              <div className="context-section-head"><span>Umfang</span></div>
              <div className="context-stat-grid">
                <div className="context-stat"><strong>{userMessages}</strong><span>Beiträge</span></div>
                <div className="context-stat"><strong>{assistantMessages}</strong><span>Antworten</span></div>
                <div className="context-stat"><strong>{tools.length}</strong><span>Werkzeuge</span></div>
                <div className="context-stat"><strong>{changes.length}</strong><span>Änderungen</span></div>
              </div>
              <div className="context-tokens">
                <div><span>Eingabe</span><strong>{formatTokens(usage.prompt)}</strong></div>
                <div><span>Ausgabe</span><strong>{formatTokens(usage.completion)}</strong></div>
                <div><span>Gesamt</span><strong>{formatTokens(usage.total)}</strong></div>
              </div>
            </section>
            <section className="context-section">
              <div className="context-section-head"><span>Ablage</span></div>
              <div className="context-actions">
                <Button minimal small fill icon="export" text="Als Markdown exportieren" onClick={exportChat} />
                <Button minimal small fill icon={copied ? "tick" : "clipboard"}
                  text={copied ? "Kopiert" : "Gespräch kopieren"} onClick={copyChat} />
              </div>
              <p className="context-note">
                Der Export enthält Nachrichten, Anhänge und Werkzeugzusammenfassungen — keine Passwörter
                und keine vollständigen Werkzeugergebnisse.
              </p>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
