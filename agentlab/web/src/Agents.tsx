import {
  Button, ButtonGroup, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, Icon,
  IconName, InputGroup, Spinner, Switch, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AgentPersona, ApiError, BuiltinAgent, Chat, createAgent, deleteAgent, listAgents,
  Routine, RoutineTemplate, startBuiltinAgent, startCustomAgent, updateAgent,
} from "./api";

type ModeFilter = "all" | "with_routines" | "without_routines" | "custom";

type Draft = {
  id?: number;
  name: string;
  role_title: string;
  description: string;
  category: string;
  icon: string;
  color: string;
  system_prompt: string;
  tool_categories: string[];
  preferred_model: string;
  temperature: string;
  default_write_mode: boolean;
  has_routines: boolean;
  orchestration: boolean;
  routine_ids: number[];
  template_keys: string[];
  starter_prompts: string;
  shared: boolean;
};

const CAT_LABELS: Record<string, string> = {
  all: "Alle",
  fertigung: "Fertigung",
  planung: "Planung",
  kunden: "Kunden",
  buchhaltung: "Buchhaltung",
  qualitaet: "Qualität",
  studio: "HTML-Studio",
  custom: "Eigene",
};

const COLOR_CHOICES = [
  "#0b7a67", "#1668ac", "#8a5a14", "#b65f45", "#23704a", "#6f42c1", "#c44a34", "#394b59",
];

const ICON_CHOICES = [
  "diagram-tree", "calendar", "euro", "endorsed", "box", "people", "calculator",
  "application", "predictive-analysis", "wrench", "layers", "shield", "flame", "chart",
];

const blankDraft = (withRoutines = false): Draft => ({
  name: "",
  role_title: "",
  description: "",
  category: "custom",
  icon: "predictive-analysis",
  color: "#0b7a67",
  system_prompt: "",
  tool_categories: [],
  preferred_model: "",
  temperature: "",
  default_write_mode: false,
  has_routines: withRoutines,
  orchestration: false,
  routine_ids: [],
  template_keys: [],
  starter_prompts: "",
  shared: false,
});

const draftFromBuiltin = (a: BuiltinAgent): Draft => ({
  name: `${a.name} (Angepasst)`,
  role_title: a.role_title,
  description: a.description,
  category: a.category,
  icon: a.icon,
  color: a.color,
  system_prompt: a.system_prompt,
  tool_categories: [...a.tool_categories],
  preferred_model: "",
  temperature: "",
  default_write_mode: a.default_write_mode,
  has_routines: a.has_routines,
  orchestration: a.orchestration ?? false,
  routine_ids: [],
  template_keys: [...a.template_keys],
  starter_prompts: a.starter_prompts.join("\n"),
  shared: false,
});

const draftFromPersona = (a: AgentPersona): Draft => ({
  id: a.id,
  name: a.name,
  role_title: a.role_title,
  description: a.description,
  category: a.category,
  icon: a.icon,
  color: a.color,
  system_prompt: a.system_prompt,
  tool_categories: [...a.tool_categories],
  preferred_model: a.preferred_model,
  temperature: a.temperature,
  default_write_mode: a.default_write_mode,
  has_routines: a.has_routines,
  orchestration: a.orchestration ?? false,
  routine_ids: [...a.routine_ids],
  template_keys: [...a.template_keys],
  starter_prompts: a.starter_prompts.join("\n"),
  shared: a.shared,
});

export default function Agents({
  onLaunchChat,
}: {
  onLaunchChat: (chat: Chat, prompt?: string) => void;
}) {
  const [customAgents, setCustomAgents] = useState<AgentPersona[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinAgent[]>([]);
  const [toolCategories, setToolCategories] = useState<string[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [templates, setTemplates] = useState<RoutineTemplate[]>([]);
  const [canShare, setCanShare] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<AgentPersona | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listAgents();
      setCustomAgents(data.agents);
      setBuiltin(data.builtin);
      setToolCategories(data.tool_categories);
      setRoutines(data.routines);
      setTemplates(data.templates);
      setCanShare(data.can_share);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const templateMap = useMemo(() => new Map(templates.map((t) => [t.key, t])), [templates]);
  const routineMap = useMemo(() => new Map(routines.map((r) => [r.id, r])), [routines]);
  const needle = search.trim().toLowerCase();

  const matches = useCallback((item: {
    name: string; role_title: string; description: string; category: string; has_routines: boolean;
  }, isCustom: boolean) => {
    if (modeFilter === "custom" && !isCustom) return false;
    if (modeFilter === "with_routines" && !item.has_routines) return false;
    if (modeFilter === "without_routines" && item.has_routines) return false;
    if (category !== "all" && item.category !== category) return false;
    if (!needle) return true;
    return `${item.name} ${item.role_title} ${item.description} ${item.category}`.toLowerCase().includes(needle);
  }, [modeFilter, category, needle]);

  const visibleCustom = useMemo(() => customAgents.filter((a) => matches(a, true)), [customAgents, matches]);
  const visibleBuiltin = useMemo(() => builtin.filter((a) => matches(a, false)), [builtin, matches]);

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const toggleArr = <T,>(arr: T[], val: T): T[] =>
    arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];

  const saveDraft = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.system_prompt.trim()) {
      setError("Bitte Name und System-Prompt / Rolle ausfüllen.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const body = {
        name: draft.name.trim(),
        role_title: draft.role_title.trim(),
        description: draft.description.trim(),
        category: draft.category,
        icon: draft.icon,
        color: draft.color,
        system_prompt: draft.system_prompt.trim(),
        tool_categories: draft.tool_categories,
        preferred_model: draft.preferred_model.trim(),
        temperature: draft.temperature.trim(),
        default_write_mode: draft.default_write_mode,
        has_routines: draft.has_routines,
        orchestration: draft.orchestration,
        routine_ids: draft.has_routines ? draft.routine_ids : [],
        template_keys: draft.has_routines ? draft.template_keys : [],
        starter_prompts: draft.starter_prompts.split("\n").map((s) => s.trim()).filter(Boolean),
        shared: draft.shared,
      };
      if (draft.id) await updateAgent(draft.id, body);
      else await createAgent(body);
      setDraft(null);
      setNotice(draft.id ? "Agent aktualisiert." : "Agent erstellt.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true); setError("");
    try {
      await deleteAgent(deleting.id);
      setDeleting(null);
      setNotice("Agent gelöscht.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const launchBuiltin = async (
    key: string,
    opts: { template_key?: string; routine_id?: number } = {},
  ) => {
    setStartingKey(`b-${key}-${opts.template_key || ""}`);
    setError("");
    try {
      const res = await startBuiltinAgent(key, opts);
      onLaunchChat(res.chat, res.prompt || undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setStartingKey(null);
    }
  };

  const launchCustom = async (
    id: number,
    opts: { template_key?: string; routine_id?: number } = {},
  ) => {
    setStartingKey(`c-${id}-${opts.routine_id || opts.template_key || ""}`);
    setError("");
    try {
      const res = await startCustomAgent(id, opts);
      onLaunchChat(res.chat, res.prompt || undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setStartingKey(null);
    }
  };

  return (
    <div className="lab-page routines-page">
      <div className="routines-head">
        <div>
          <h2>Spezialisierte Agenten</h2>
          <p className="sub">
            Rollen-Agenten für Fertigungs-Optimierung, Produktionsplanung, Kundenservice, Buchhaltung, Lager &amp;
            HTML-Studio — mit festen Routinen oder als reine Direkt-Chat-Spezialisten.
          </p>
        </div>
        <div className="agents-head-actions">
          <Button icon="chat" text="Direkt-Agent (ohne Routinen)"
            onClick={() => { setDraft(blankDraft(false)); setError(""); }} />
          <Button intent="primary" icon="plus" text="Agent mit Routinen"
            onClick={() => { setDraft(blankDraft(true)); setError(""); }} />
        </div>
      </div>

      {error && <div className="login-card banner-bad" style={{ width: "auto", marginBottom: 12 }}>{error}</div>}
      {notice && <div className="login-card banner-ok" style={{ width: "auto", marginBottom: 12 }}>{notice}</div>}

      <div className="routines-toolbar">
        <ButtonGroup className="tool-filter">
          <Button small active={modeFilter === "all"} text={`Alle (${builtin.length + customAgents.length})`} onClick={() => setModeFilter("all")} />
          <Button small active={modeFilter === "with_routines"} text="Mit Routinen" onClick={() => setModeFilter("with_routines")} />
          <Button small active={modeFilter === "without_routines"} text="Ohne Routinen" onClick={() => setModeFilter("without_routines")} />
          <Button small active={modeFilter === "custom"} text={`Eigene (${customAgents.length})`} onClick={() => setModeFilter("custom")} />
        </ButtonGroup>

        <input
          className="bp5-input"
          placeholder="Agent, Rolle oder Bereich suchen …"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Agenten durchsuchen"
        />

        <div className="routines-cats">
          {Object.entries(CAT_LABELS).map(([k, label]) => (
            <button key={k} type="button"
              className={`routines-cat-pill ${category === k ? "is-active" : ""}`}
              onClick={() => setCategory(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="chat-loading"><Spinner size={28} /><span>Agenten werden geladen …</span></div>
      ) : (
        <>
          {visibleCustom.length > 0 && (
            <section className="routines-section">
              <div className="routines-section-head">
                <h3>Eigene &amp; geteilte Agenten</h3>
                <Tag minimal>{visibleCustom.length}</Tag>
              </div>
              <div className="routines-grid">
                {visibleCustom.map((agent) => (
                  <article
                    className="agent-card"
                    key={agent.id}
                    style={{ ["--agent-color" as string]: agent.color || "#0b7a67" }}
                  >
                    <div className="routine-card-top">
                      <span className="agent-avatar" style={{ background: agent.color || "#0b7a67" }} aria-hidden="true">
                        <Icon icon={(agent.icon || "predictive-analysis") as IconName} size={18} />
                      </span>
                      <div className="routine-title-wrap">
                        <strong>{agent.name}</strong>
                        {agent.role_title && <div className="agent-role">{agent.role_title}</div>}
                        <div className="routine-tags">
                          <Tag minimal intent={agent.has_routines ? "primary" : "none"}>
                            {agent.has_routines ? "Mit Routinen" : "Direkt-Agent"}
                          </Tag>
                          <Tag minimal>{CAT_LABELS[agent.category] || agent.category}</Tag>
                          {agent.shared && <Tag minimal intent="success">geteilt</Tag>}
                          {agent.default_write_mode && <Tag minimal intent="warning">Schreibmodus</Tag>}
                        </div>
                      </div>
                    </div>

                    {agent.description && <p className="routine-desc">{agent.description}</p>}

                    {agent.tool_categories.length > 0 && (
                      <div className="agent-cats">
                        {agent.tool_categories.slice(0, 5).map((cat) => (
                          <span className="agent-cat-chip" key={cat}>{cat}</span>
                        ))}
                      </div>
                    )}

                    {agent.has_routines && (agent.routine_ids.length > 0 || agent.template_keys.length > 0) && (
                      <div className="agent-routine-links">
                        <span className="agent-routine-label">Verknüpfte Routinen:</span>
                        <div className="agent-routine-chips">
                          {agent.routine_ids.map((rid) => {
                            const rt = routineMap.get(rid);
                            if (!rt) return null;
                            return (
                              <button key={`r-${rid}`} type="button" className="agent-routine-run"
                                disabled={startingKey != null}
                                onClick={() => launchCustom(agent.id, { routine_id: rid })}>
                                <Icon icon="play" size={10} aria-hidden="true" />
                                <span>{rt.name}</span>
                              </button>
                            );
                          })}
                          {agent.template_keys.map((tk) => {
                            const tpl = templateMap.get(tk);
                            if (!tpl) return null;
                            return (
                              <button key={`t-${tk}`} type="button" className="agent-routine-run"
                                disabled={startingKey != null}
                                onClick={() => launchCustom(agent.id, { template_key: tk })}>
                                <Icon icon="play" size={10} aria-hidden="true" />
                                <span>{tpl.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="routine-actions">
                      <Button small intent="primary" icon="chat" text="Chat starten"
                        loading={startingKey === `c-${agent.id}-`} disabled={startingKey != null}
                        onClick={() => launchCustom(agent.id)} />
                      {agent.editable && (
                        <>
                          <Button small minimal icon="edit" text="Bearbeiten" onClick={() => setDraft(draftFromPersona(agent))} />
                          <Button small minimal icon="trash" intent="danger" aria-label="Löschen"
                            onClick={() => setDeleting(agent)} />
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          <section className="routines-section">
            <div className="routines-section-head">
              <h3>Spezialisten-Katalog (Gimel)</h3>
              <Tag minimal>{visibleBuiltin.length}</Tag>
            </div>
            {visibleBuiltin.length === 0 ? (
              <div className="empty">Kein Agent in diesem Filter.</div>
            ) : (
              <div className="routines-grid">
                {visibleBuiltin.map((agent) => (
                  <article
                    className="agent-card is-builtin"
                    key={agent.key}
                    style={{ ["--agent-color" as string]: agent.color || "#0b7a67" }}
                  >
                    <div className="routine-card-top">
                      <span className="agent-avatar" style={{ background: agent.color }} aria-hidden="true">
                        <Icon icon={(agent.icon || "predictive-analysis") as IconName} size={18} />
                      </span>
                      <div className="routine-title-wrap">
                        <strong>{agent.name}</strong>
                        <div className="agent-role">{agent.role_title}</div>
                        <div className="routine-tags">
                          <Tag minimal intent={agent.has_routines ? "primary" : "none"}>
                            {agent.has_routines ? `Mit Routinen (${agent.template_keys.length})` : "Ohne Routinen · Direkt"}
                          </Tag>
                          <Tag minimal>{CAT_LABELS[agent.category] || agent.category}</Tag>
                        </div>
                      </div>
                    </div>

                    <p className="routine-desc">{agent.description}</p>

                    <div className="agent-cats">
                      {agent.tool_categories.slice(0, 5).map((cat) => (
                        <span className="agent-cat-chip" key={cat}>{cat}</span>
                      ))}
                    </div>

                    {agent.has_routines && agent.template_keys.length > 0 && (
                      <div className="agent-routine-links">
                        <span className="agent-routine-label">Routinen direkt mit diesem Agenten starten:</span>
                        <div className="agent-routine-chips">
                          {agent.template_keys.map((tk) => {
                            const tpl = templateMap.get(tk);
                            if (!tpl) return null;
                            return (
                              <button key={tk} type="button" className="agent-routine-run"
                                disabled={startingKey != null}
                                onClick={() => launchBuiltin(agent.key, { template_key: tk })}>
                                <Icon icon="play" size={10} aria-hidden="true" />
                                <span>{tpl.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="routine-actions">
                      <Button small intent="primary" icon="chat" text="Chat starten"
                        loading={startingKey === `b-${agent.key}-`} disabled={startingKey != null}
                        onClick={() => launchBuiltin(agent.key)} />
                      <Button small icon="duplicate" text="Anpassen"
                        onClick={() => { setDraft(draftFromBuiltin(agent)); setError(""); }} />
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {/* Agent Builder Dialog */}
      <Dialog isOpen={!!draft} onClose={() => setDraft(null)}
        title={draft?.id ? "Agent bearbeiten" : "Eigenen Agenten erstellen"}
        style={{ width: 720, maxWidth: "calc(100vw - 24px)" }}>
        <DialogBody>
          {draft && (
            <div className="settings-grid">
              <FormGroup label="Name" labelFor="ag-name">
                <InputGroup id="ag-name" value={draft.name} placeholder="z. B. Qualitäts-Prüfer"
                  onChange={(e) => patch({ name: e.target.value })} />
              </FormGroup>
              <FormGroup label="Rolle / Untertitel" labelFor="ag-role">
                <InputGroup id="ag-role" value={draft.role_title} placeholder="z. B. Ausschuss, OEE & Prüfzeugnisse"
                  onChange={(e) => patch({ role_title: e.target.value })} />
              </FormGroup>
              <FormGroup label="Kurzbeschreibung" labelFor="ag-desc" className="full">
                <InputGroup id="ag-desc" value={draft.description}
                  placeholder="Wofür ist dieser Agent zuständig?"
                  onChange={(e) => patch({ description: e.target.value })} />
              </FormGroup>
              <FormGroup label="Bereich">
                <HTMLSelect fill value={draft.category} onChange={(e) => patch({ category: e.target.value })}>
                  {Object.entries(CAT_LABELS).filter(([k]) => k !== "all").map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Symbol">
                <HTMLSelect fill value={draft.icon} onChange={(e) => patch({ icon: e.target.value })}>
                  {ICON_CHOICES.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Farbe" className="full">
                <div className="agent-color-row">
                  {COLOR_CHOICES.map((c) => (
                    <button key={c} type="button"
                      className={`agent-color-dot ${draft.color === c ? "is-active" : ""}`}
                      style={{ background: c }}
                      aria-label={`Farbe ${c}`}
                      onClick={() => patch({ color: c })} />
                  ))}
                </div>
              </FormGroup>
              <FormGroup label="System-Anweisung (Rolle, Fachregeln, Stil)" labelFor="ag-sys" className="full">
                <TextArea id="ag-sys" fill rows={5} value={draft.system_prompt}
                  placeholder="Du bist der Gimel ... Nutze bevorzugt die Werkzeuge ... Antworte strukturiert ..."
                  onChange={(e) => patch({ system_prompt: e.target.value })} />
              </FormGroup>
              <FormGroup label="Werkzeug-Fokus (optional — leer = alle erlaubten Werkzeuge)" className="full">
                <div className="routines-cats">
                  {toolCategories.map((cat) => (
                    <button key={cat} type="button"
                      className={`routines-cat-pill ${draft.tool_categories.includes(cat) ? "is-active" : ""}`}
                      onClick={() => patch({ tool_categories: toggleArr(draft.tool_categories, cat) })}>
                      {cat}
                    </button>
                  ))}
                </div>
              </FormGroup>
              <FormGroup label="Routinen-Modus" className="full">
                <Switch
                  checked={draft.has_routines}
                  label={draft.has_routines
                    ? "Mit Routinen verknüpft (1-Klick-Abläufe direkt auf der Agenten-Karte)"
                    : "Ohne Routinen (reiner interaktiver Direkt-Chat-Agent)"}
                  onChange={(e) => patch({ has_routines: (e.target as HTMLInputElement).checked })}
                />
                {draft.has_routines && (
                  <div className="agent-routine-picker">
                    <div className="provider-gallery-label">Vorlagen verknüpfen</div>
                    <div className="routines-cats">
                      {templates.map((tpl) => (
                        <button key={tpl.key} type="button"
                          className={`routines-cat-pill ${draft.template_keys.includes(tpl.key) ? "is-active" : ""}`}
                          onClick={() => patch({ template_keys: toggleArr(draft.template_keys, tpl.key) })}>
                          {tpl.name}
                        </button>
                      ))}
                    </div>
                    {routines.length > 0 && (
                      <>
                        <div className="provider-gallery-label" style={{ marginTop: 8 }}>Eigene Routinen verknüpfen</div>
                        <div className="routines-cats">
                          {routines.map((rt) => (
                            <button key={rt.id} type="button"
                              className={`routines-cat-pill ${draft.routine_ids.includes(rt.id) ? "is-active" : ""}`}
                              onClick={() => patch({ routine_ids: toggleArr(draft.routine_ids, rt.id) })}>
                              {rt.name}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </FormGroup>
              <FormGroup label="Orchestrierung" className="full">
                <Switch
                  checked={draft.orchestration}
                  label={draft.orchestration
                    ? "Orchestriert alle verknüpften Routinen in einem Lauf"
                    : "Keine automatische Orchestrierung"}
                  onChange={(e) => patch({ orchestration: (e.target as HTMLInputElement).checked })}
                />
              </FormGroup>
              <FormGroup label="Bevorzugtes Modell (optional)">
                <InputGroup value={draft.preferred_model} placeholder="z. B. gemini-2.5-pro"
                  onChange={(e) => patch({ preferred_model: e.target.value })} />
              </FormGroup>
              <FormGroup label="Temperatur-Überschreibung (optional)">
                <InputGroup value={draft.temperature} placeholder="z. B. 0.1"
                  onChange={(e) => patch({ temperature: e.target.value })} />
              </FormGroup>
              <FormGroup label="Starter-Fragen (eine pro Zeile, optional)" className="full">
                <TextArea fill rows={3} value={draft.starter_prompts}
                  placeholder="Welche Aufträge sind heute kritisch?&#10;Erstelle einen HTML-Wochenbericht."
                  onChange={(e) => patch({ starter_prompts: e.target.value })} />
              </FormGroup>
              <FormGroup label="Optionen" className="full">
                <Switch checked={draft.default_write_mode} label="Standardmäßig mit Schreibmodus starten"
                  onChange={(e) => patch({ default_write_mode: (e.target as HTMLInputElement).checked })} />
                {canShare && (
                  <Switch checked={draft.shared} label="Für das gesamte Team teilen"
                    onChange={(e) => patch({ shared: (e.target as HTMLInputElement).checked })} />
                )}
              </FormGroup>
            </div>
          )}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setDraft(null)} disabled={busy} />
            <Button intent="primary" icon="floppy-disk" text="Speichern" onClick={saveDraft} loading={busy} />
          </>
        } />
      </Dialog>

      <Dialog isOpen={!!deleting} onClose={() => setDeleting(null)} title="Agent löschen">
        <DialogBody>
          <p>Agent „{deleting?.name}“ wirklich löschen? Bestehende Chats bleiben erhalten.</p>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setDeleting(null)} />
            <Button intent="danger" text="Löschen" onClick={remove} loading={busy} />
          </>
        } />
      </Dialog>
    </div>
  );
}
