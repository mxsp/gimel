import { Button, Icon, InputGroup, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import {
  ChatSubagent,
  SubagentCapability,
  deleteChatSubagent,
  dispatchChatSubagent,
  listChatSubagents,
} from "./api";

const ROLE_PRESETS: Array<{
  id: string;
  label: string;
  roleTitle: string;
  capabilities: string[];
  placeholder: string;
}> = [
  {
    id: "bottleneck",
    label: "Engpass-Analyst",
    roleTitle: "Engpass- & Stations-Analyst",
    capabilities: ["analyse", "halle & stationen", "fertigung", "zwilling"],
    placeholder: "z. B. Prüfe Plotter 1 vs. Plotter 2 und schlage Verlagerungen vor …",
  },
  {
    id: "inventory",
    label: "Lager & Bestand",
    roleTitle: "Lager- & Materialprüfer",
    capabilities: ["analyse", "lager & werkstoffe"],
    placeholder: "z. B. Prüfe knappe EPDM/Graphit-Bestände für offene Aufträge …",
  },
  {
    id: "orders",
    label: "Auftrags-Triage",
    roleTitle: "Auftrags- & Termin-Spezialist",
    capabilities: ["analyse", "aufträge", "kunden", "versand"],
    placeholder: "z. B. Liste alle überfälligen Eilaufträge mit Kundenzusage …",
  },
  {
    id: "twin",
    label: "Twin & Roboter",
    roleTitle: "Digital-Twin- & AGV-Prüfer",
    capabilities: ["zwilling", "roboter", "halle & stationen"],
    placeholder: "z. B. Prüfe AGV-Wegekonflikte und Flottenauslastung in Halle 1 …",
  },
];

const STATUS_META: Record<string, { label: string; cls: string }> = {
  queued: { label: "Wartet", cls: "is-queued" },
  running: { label: "Läuft", cls: "is-running" },
  done: { label: "Fertig", cls: "is-done" },
  error: { label: "Fehler", cls: "is-error" },
};

export default function SubagentPanel({
  chatId,
  streaming,
  onOpenGraph,
  onUseResult,
}: {
  chatId: number;
  streaming: boolean;
  onOpenGraph?: () => void;
  onUseResult?: (sub: ChatSubagent) => void;
}) {
  const [subagents, setSubagents] = useState<ChatSubagent[]>([]);
  const [catalog, setCatalog] = useState<SubagentCapability[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("Engpass-Analyst");
  const [roleTitle, setRoleTitle] = useState("Engpass- & Stations-Analyst");
  const [task, setTask] = useState("");
  const [caps, setCaps] = useState<string[]>(["analyse", "halle & stationen", "fertigung"]);

  const refresh = useCallback(async () => {
    try {
      const data = await listChatSubagents(chatId);
      setSubagents(data.subagents ?? []);
      if (data.capabilities_catalog?.length) setCatalog(data.capabilities_catalog);
    } catch {
      /* leise */
    }
  }, [chatId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActive = subagents.some((s) => s.status === "queued" || s.status === "running");

  useEffect(() => {
    if (!streaming && !hasActive) return;
    const iv = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 1500);
    return () => window.clearInterval(iv);
  }, [streaming, hasActive, refresh]);

  const capLabel = (id: string) => catalog.find((c) => c.id === id)?.label || id;

  const toggleCap = (id: string) => {
    setCaps((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const applyPreset = (preset: typeof ROLE_PRESETS[number]) => {
    setName(preset.label);
    setRoleTitle(preset.roleTitle);
    setCaps([...preset.capabilities]);
  };

  const launch = async () => {
    if (!name.trim() || !task.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await dispatchChatSubagent(chatId, {
        name: name.trim(),
        role_title: roleTitle.trim() || "Temporärer Subagent",
        task: task.trim(),
        capabilities: caps,
      });
      setTask("");
      setComposerOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (subId: number) => {
    try {
      await deleteChatSubagent(chatId, subId);
      setSubagents((prev) => prev.filter((s) => s.subagent_id !== subId));
      if (expandedId === subId) setExpandedId(null);
    } catch {
      /* egal */
    }
  };

  const finishedSubagents = subagents.filter((s) => s.status === "done" || s.status === "error");

  const clearFinished = async () => {
    for (const s of finishedSubagents) {
      try {
        await deleteChatSubagent(chatId, s.subagent_id);
      } catch {
        /* egal */
      }
    }
    setSubagents((prev) => prev.filter((s) => s.status !== "done" && s.status !== "error"));
  };

  return (
    <div className="subagent-panel">
      <div className="subagent-bar">
        <div className="subagent-bar-left">
          <Icon icon="git-branch" size={13} aria-hidden="true" />
          <strong>Subagenten</strong>
          <Tag minimal round intent={hasActive ? "primary" : "none"}>
            {subagents.length === 0
              ? "Bereit"
              : `${subagents.length} aktiv${hasActive ? " · läuft" : ""}`}
          </Tag>
          <span className="subagent-bar-hint">Werden nach Gebrauch automatisch gelöscht</span>
        </div>
        <div className="subagent-bar-actions">
          {finishedSubagents.length > 0 && (
            <Button small minimal icon="clean" text={`Erledigte aufräumen (${finishedSubagents.length})`} onClick={() => void clearFinished()} />
          )}
          {onOpenGraph && (
            <Button small minimal icon="graph" text="Wissensgraph" onClick={onOpenGraph} />
          )}
          <Button
            small
            minimal={!composerOpen}
            intent={composerOpen ? "primary" : "none"}
            icon={composerOpen ? "chevron-up" : "plus"}
            text="Subagent starten"
            onClick={() => setComposerOpen((v) => !v)}
          />
        </div>
      </div>

      {composerOpen && (
        <div className="subagent-composer">
          <div className="subagent-presets" role="group" aria-label="Rollen-Vorlagen">
            <span className="subagent-field-label">Vorlage:</span>
            {ROLE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`subagent-preset${name === p.label ? " is-selected" : ""}`}
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="subagent-inputs">
            <InputGroup
              small
              placeholder="Name (z. B. Lager-Prüfer)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <InputGroup
              small
              placeholder="Rolle / Spezialisierung"
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
            />
          </div>

          <div className="subagent-caps-block">
            <div className="subagent-caps-head">
              <span className="subagent-field-label">
                Fähigkeiten ({caps.length} gewählt — leer = automatische Erkennung aus Aufgabe)
              </span>
              {caps.length > 0 && (
                <button type="button" className="subagent-clear-caps" onClick={() => setCaps([])}>
                  Zurücksetzen
                </button>
              )}
            </div>
            <div className="subagent-cap-grid">
              {catalog.map((c) => {
                const on = caps.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`subagent-cap-chip${on ? " is-on" : ""}`}
                    title={c.hint}
                    onClick={() => toggleCap(c.id)}
                  >
                    {on && <Icon icon="small-tick" size={11} aria-hidden="true" />}
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="subagent-task-row">
            <InputGroup
              small
              fill
              placeholder="Aufgabe für den temporären Subagenten …"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void launch();
                }
              }}
            />
            <Button
              small
              intent="primary"
              icon="play"
              text="Starten"
              loading={busy}
              disabled={!name.trim() || !task.trim()}
              onClick={() => void launch()}
            />
          </div>
          {error && <div className="subagent-error">{error}</div>}
        </div>
      )}

      {subagents.length > 0 && (
        <div className="subagent-cards">
          {subagents.map((s) => {
            const meta = STATUS_META[s.status] ?? { label: s.status, cls: "" };
            const open = expandedId === s.subagent_id;
            return (
              <div key={s.subagent_id} className={`subagent-card ${meta.cls}`}>
                <div className="subagent-card-head">
                  <button
                    type="button"
                    className="subagent-card-toggle"
                    onClick={() => setExpandedId(open ? null : s.subagent_id)}
                  >
                    <span className={`subagent-dot ${meta.cls}`} aria-hidden="true" />
                    <span className="subagent-card-title">
                      <strong>{s.name}</strong>
                      <span className="subagent-card-role">{s.role_title}</span>
                    </span>
                    <Tag minimal className="subagent-status-tag">{meta.label}</Tag>
                    {s.used_calls > 0 && (
                      <span className="subagent-calls mono">{s.used_calls} Tools</span>
                    )}
                    <Icon icon={open ? "chevron-up" : "chevron-down"} size={12} aria-hidden="true" />
                  </button>
                  <Button
                    small
                    minimal
                    icon="trash"
                    title="Subagent sofort löschen"
                    aria-label={`${s.name} löschen`}
                    onClick={() => void remove(s.subagent_id)}
                  />
                </div>

                {s.capabilities.length > 0 && (
                  <div className="subagent-card-caps">
                    {s.capabilities.map((c) => (
                      <span key={c} className="subagent-cap-pill">{capLabel(c)}</span>
                    ))}
                  </div>
                )}

                {open && (
                  <div className="subagent-card-body">
                    <div className="subagent-card-section">
                      <span>Aufgabe</span>
                      <p>{s.task}</p>
                    </div>
                    {s.result && (
                      <div className="subagent-card-section">
                        <div className="subagent-result-head">
                          <span>Ergebnis</span>
                          {onUseResult && s.status === "done" && (
                            <Button small minimal intent="primary" icon="chat" text="In Chat übernehmen"
                              onClick={() => onUseResult(s)} />
                          )}
                        </div>
                        <pre className="subagent-result-pre">{s.result}</pre>
                      </div>
                    )}
                    {s.model && (
                      <div className="subagent-card-foot mono">Modell: {s.model}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
