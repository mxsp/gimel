import {
  Button, ButtonGroup, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, Icon,
  IconName, InputGroup, Spinner, Switch, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, Chat, createRoutine, deleteRoutine, listRoutines, Routine, RoutineRun,
  RoutineTemplate, runRoutine, runRoutineTemplate, updateRoutine,
} from "./api";
import { relativeTime } from "./chatUtils";

type SectionTab = "all" | "custom" | "templates" | "history";

type Draft = {
  id?: number;
  name: string;
  description: string;
  category: string;
  icon: string;
  prompt: string;
  steps: string[];
  schedule: string;
  schedule_time: string;
  write_mode: boolean;
  output_format: string;
  shared: boolean;
  template_key: string;
};

const CATEGORY_LABELS: Record<string, string> = {
  all: "Alle",
  schicht: "Schicht",
  fertigung: "Fertigung",
  lager: "Lager",
  bericht: "Bericht",
  custom: "Eigene",
};

const SCHEDULE_LABELS: Record<string, string> = {
  manual: "Manuell",
  shift: "Pro Schicht",
  daily: "Täglich",
  weekly: "Wöchentlich",
};

const OUTPUT_LABELS: Record<string, string> = {
  html_report: "HTML-Bericht",
  chart_dashboard: "KPI-Dashboard",
  markdown: "Markdown",
  chat: "Nur Chat",
};

const ICON_CHOICES = [
  "repeat", "flame", "diagram-tree", "grouped-bar-chart", "layers",
  "endorsed", "calendar", "box", "application", "wrench", "document", "search",
];

const blankDraft = (): Draft => ({
  name: "",
  description: "",
  category: "custom",
  icon: "repeat",
  prompt: "",
  steps: [""],
  schedule: "manual",
  schedule_time: "07:30",
  write_mode: false,
  output_format: "html_report",
  shared: false,
  template_key: "",
});

const draftFromTemplate = (tpl: RoutineTemplate): Draft => ({
  name: tpl.name,
  description: tpl.description,
  category: tpl.category || "custom",
  icon: tpl.icon || "repeat",
  prompt: tpl.prompt,
  steps: tpl.steps.length ? [...tpl.steps] : [""],
  schedule: tpl.schedule || "manual",
  schedule_time: tpl.schedule_time || "",
  write_mode: tpl.write_mode,
  output_format: tpl.output_format || "html_report",
  shared: false,
  template_key: tpl.key,
});

const draftFromRoutine = (r: Routine): Draft => ({
  id: r.id,
  name: r.name,
  description: r.description,
  category: r.category || "custom",
  icon: r.icon || "repeat",
  prompt: r.prompt,
  steps: r.steps.length ? [...r.steps] : [""],
  schedule: r.schedule || "manual",
  schedule_time: r.schedule_time || "",
  write_mode: r.write_mode,
  output_format: r.output_format || "html_report",
  shared: r.shared,
  template_key: r.template_key || "",
});

export default function Routines({
  onLaunchChat,
  onOpenChat,
}: {
  onLaunchChat: (chat: Chat, prompt: string) => void;
  onOpenChat: (chatId: number) => void;
}) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [templates, setTemplates] = useState<RoutineTemplate[]>([]);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [canShare, setCanShare] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [section, setSection] = useState<SectionTab>("all");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Routine | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listRoutines();
      setRoutines(data.routines);
      setTemplates(data.templates);
      setRuns(data.runs);
      setCanShare(data.can_share);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const needle = search.trim().toLowerCase();

  const visibleRoutines = useMemo(() => routines.filter((r) => {
    if (category !== "all" && r.category !== category) return false;
    if (!needle) return true;
    return `${r.name} ${r.description} ${r.prompt} ${r.category}`.toLowerCase().includes(needle);
  }), [routines, category, needle]);

  const visibleTemplates = useMemo(() => templates.filter((t) => {
    if (category !== "all" && t.category !== category) return false;
    if (!needle) return true;
    return `${t.name} ${t.description} ${t.prompt} ${t.category}`.toLowerCase().includes(needle);
  }), [templates, category, needle]);

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const saveDraft = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      setError("Bitte Name und Anweisung (Prompt) ausfüllen.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        category: draft.category,
        icon: draft.icon,
        prompt: draft.prompt.trim(),
        steps: draft.steps.map((s) => s.trim()).filter(Boolean),
        schedule: draft.schedule,
        schedule_time: draft.schedule === "manual" ? "" : draft.schedule_time.trim(),
        write_mode: draft.write_mode,
        output_format: draft.output_format,
        shared: draft.shared,
        template_key: draft.template_key,
      };
      if (draft.id) await updateRoutine(draft.id, body);
      else await createRoutine(body);
      setDraft(null);
      setNotice(draft.id ? "Routine aktualisiert." : "Routine gespeichert.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeRoutine = async () => {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await deleteRoutine(deleting.id);
      setDeleting(null);
      setNotice("Routine gelöscht.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const executeRoutine = async (r: Routine) => {
    setRunningKey(`r-${r.id}`);
    setError("");
    try {
      const res = await runRoutine(r.id);
      onLaunchChat(res.chat, res.prompt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setRunningKey(null);
    }
  };

  const executeTemplate = async (tpl: RoutineTemplate) => {
    setRunningKey(`t-${tpl.key}`);
    setError("");
    try {
      const res = await runRoutineTemplate(tpl.key);
      onLaunchChat(res.chat, res.prompt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setRunningKey(null);
    }
  };

  const scheduleText = (schedule: string, time: string) => {
    const base = SCHEDULE_LABELS[schedule] || schedule;
    return schedule !== "manual" && time ? `${base} · ${time}` : base;
  };

  return (
    <div className="lab-page routines-page">
      <div className="routines-head">
        <div>
          <h2>Routinen</h2>
          <p className="sub">
            Wiederkehrende Prüf-, Berichts- und Analyseabläufe — direkt aus Vorlagen starten oder eigene mehrstufige Routinen bauen.
          </p>
        </div>
        <Button intent="primary" icon="plus" text="Eigene Routine erstellen"
          onClick={() => { setDraft(blankDraft()); setError(""); }} />
      </div>

      {error && <div className="login-card banner-bad" style={{ width: "auto", marginBottom: 12 }}>{error}</div>}
      {notice && <div className="login-card banner-ok" style={{ width: "auto", marginBottom: 12 }}>{notice}</div>}

      <div className="routines-toolbar">
        <ButtonGroup className="tool-filter">
          <Button small active={section === "all"} text={`Alle (${routines.length + templates.length})`} onClick={() => setSection("all")} />
          <Button small active={section === "custom"} text={`Eigene (${routines.length})`} onClick={() => setSection("custom")} />
          <Button small active={section === "templates"} text={`Vorlagen (${templates.length})`} onClick={() => setSection("templates")} />
          <Button small active={section === "history"} text={`Verlauf (${runs.length})`} onClick={() => setSection("history")} />
        </ButtonGroup>

        <input
          className="bp5-input"
          placeholder="Routinen & Vorlagen durchsuchen …"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Routinen durchsuchen"
        />

        {section !== "history" && (
          <div className="routines-cats">
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`routines-cat-pill ${category === key ? "is-active" : ""}`}
                onClick={() => setCategory(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="chat-loading"><Spinner size={28} /><span>Routinen werden geladen …</span></div>
      ) : (
        <>
          {(section === "all" || section === "custom") && (
            <section className="routines-section">
              <div className="routines-section-head">
                <h3>Eigene &amp; geteilte Routinen</h3>
                <Tag minimal>{visibleRoutines.length}</Tag>
              </div>
              {visibleRoutines.length === 0 ? (
                <div className="empty">
                  Noch keine eigene Routine{search || category !== "all" ? " in diesem Filter" : ""}.
                  Klicken Sie oben auf „Eigene Routine erstellen“ oder passen Sie eine Vorlage unten an.
                </div>
              ) : (
                <div className="routines-grid">
                  {visibleRoutines.map((r) => (
                    <article className="routine-card" key={r.id}>
                      <div className="routine-card-top">
                        <span className="routine-icon" aria-hidden="true">
                          <Icon icon={(r.icon || "repeat") as IconName} size={16} />
                        </span>
                        <div className="routine-title-wrap">
                          <strong>{r.name}</strong>
                          <div className="routine-tags">
                            <Tag minimal>{CATEGORY_LABELS[r.category] || r.category}</Tag>
                            <Tag minimal intent="primary">{OUTPUT_LABELS[r.output_format] || r.output_format}</Tag>
                            <Tag minimal>{scheduleText(r.schedule, r.schedule_time)}</Tag>
                            {r.shared && <Tag minimal intent="success">geteilt</Tag>}
                            {r.write_mode && <Tag minimal intent="warning">Schreibmodus</Tag>}
                          </div>
                        </div>
                      </div>
                      {r.description && <p className="routine-desc">{r.description}</p>}
                      {r.steps.length > 0 && (
                        <ol className="routine-steps">
                          {r.steps.slice(0, 4).map((step, i) => <li key={i}>{step}</li>)}
                          {r.steps.length > 4 && <li className="is-more">+{r.steps.length - 4} weitere Schritte</li>}
                        </ol>
                      )}
                      <div className="routine-meta">
                        <span>{r.run_count}× ausgeführt</span>
                        {r.last_run_at && <span>· zuletzt {relativeTime(r.last_run_at)}</span>}
                        {r.last_chat_id && (
                          <button type="button" className="routine-link" onClick={() => onOpenChat(r.last_chat_id!)}>
                            <span>Letzter Chat</span>
                            <Icon icon="arrow-top-right" size={11} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      <div className="routine-actions">
                        <Button small intent="primary" icon="play" text="Jetzt ausführen"
                          loading={runningKey === `r-${r.id}`} disabled={runningKey != null}
                          onClick={() => executeRoutine(r)} />
                        <Button small minimal icon="duplicate" title="Duplizieren"
                          onClick={() => setDraft({ ...draftFromRoutine(r), id: undefined, name: `${r.name} (Kopie)` })} />
                        {r.editable && (
                          <>
                            <Button small minimal icon="edit" text="Bearbeiten"
                              onClick={() => setDraft(draftFromRoutine(r))} />
                            <Button small minimal icon="trash" intent="danger" aria-label="Löschen"
                              onClick={() => setDeleting(r)} />
                          </>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          {(section === "all" || section === "templates") && (
            <section className="routines-section">
              <div className="routines-section-head">
                <h3>Vorlagen-Bibliothek</h3>
                <Tag minimal>{visibleTemplates.length}</Tag>
              </div>
              <div className="routines-grid">
                {visibleTemplates.map((tpl) => (
                  <article className="routine-card is-template" key={tpl.key}>
                    <div className="routine-card-top">
                      <span className="routine-icon is-template" aria-hidden="true">
                        <Icon icon={(tpl.icon || "repeat") as IconName} size={16} />
                      </span>
                      <div className="routine-title-wrap">
                        <strong>{tpl.name}</strong>
                        <div className="routine-tags">
                          <Tag minimal>{CATEGORY_LABELS[tpl.category] || tpl.category}</Tag>
                          <Tag minimal intent="primary">{OUTPUT_LABELS[tpl.output_format] || tpl.output_format}</Tag>
                          <Tag minimal>{scheduleText(tpl.schedule, tpl.schedule_time)}</Tag>
                        </div>
                      </div>
                    </div>
                    <p className="routine-desc">{tpl.description}</p>
                    {tpl.steps.length > 0 && (
                      <ol className="routine-steps">
                        {tpl.steps.slice(0, 3).map((step, i) => <li key={i}>{step}</li>)}
                        {tpl.steps.length > 3 && <li className="is-more">+{tpl.steps.length - 3} weitere Schritte</li>}
                      </ol>
                    )}
                    <div className="routine-actions">
                      <Button small intent="primary" icon="play" text="Direkt starten"
                        loading={runningKey === `t-${tpl.key}`} disabled={runningKey != null}
                        onClick={() => executeTemplate(tpl)} />
                      <Button small icon="add" text="Anpassen & speichern"
                        onClick={() => { setDraft(draftFromTemplate(tpl)); setError(""); }} />
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {(section === "all" || section === "history") && runs.length > 0 && (
            <section className="routines-section">
              <div className="routines-section-head">
                <h3>Letzte Ausführungen</h3>
                <Tag minimal>{runs.length}</Tag>
              </div>
              <div className="routine-runs-list">
                {runs.map((run) => (
                  <div className="routine-run-row" key={run.id}>
                    <Icon icon="history" size={13} aria-hidden="true" />
                    <strong>{run.routine_name}</strong>
                    <span className="routine-run-time">{relativeTime(run.started_at)}</span>
                    <span className="spacer" />
                    {run.chat_id && (
                      <Button small minimal icon="chat" text="Chat öffnen" onClick={() => onOpenChat(run.chat_id!)} />
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Custom Routine Builder Dialog */}
      <Dialog isOpen={!!draft} onClose={() => setDraft(null)}
        title={draft?.id ? "Routine bearbeiten" : "Neue Routine erstellen"}
        style={{ width: 680, maxWidth: "calc(100vw - 24px)" }}>
        <DialogBody>
          {draft && (
            <div className="settings-grid">
              <FormGroup label="Name" labelFor="rt-name">
                <InputGroup id="rt-name" value={draft.name} placeholder="z. B. Frühschicht-Check"
                  onChange={(e) => patch({ name: e.target.value })} />
              </FormGroup>
              <FormGroup label="Kategorie" labelFor="rt-cat">
                <HTMLSelect id="rt-cat" fill value={draft.category}
                  onChange={(e) => patch({ category: e.target.value })}>
                  {Object.entries(CATEGORY_LABELS).filter(([k]) => k !== "all").map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Kurzbeschreibung" labelFor="rt-desc" className="full">
                <InputGroup id="rt-desc" value={draft.description}
                  placeholder="Was prüft oder erzeugt diese Routine?"
                  onChange={(e) => patch({ description: e.target.value })} />
              </FormGroup>
              <FormGroup label="Rhythmus" labelFor="rt-sched">
                <HTMLSelect id="rt-sched" fill value={draft.schedule}
                  onChange={(e) => patch({ schedule: e.target.value })}>
                  {Object.entries(SCHEDULE_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Uhrzeit (optional)" labelFor="rt-time">
                <InputGroup id="rt-time" value={draft.schedule_time} placeholder="07:30"
                  disabled={draft.schedule === "manual"}
                  onChange={(e) => patch({ schedule_time: e.target.value })} />
              </FormGroup>
              <FormGroup label="Ausgabeformat" labelFor="rt-out">
                <HTMLSelect id="rt-out" fill value={draft.output_format}
                  onChange={(e) => patch({ output_format: e.target.value })}>
                  {Object.entries(OUTPUT_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Symbol" labelFor="rt-icon">
                <HTMLSelect id="rt-icon" fill value={draft.icon}
                  onChange={(e) => patch({ icon: e.target.value })}>
                  {ICON_CHOICES.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Hauptanweisung (Prompt)" labelFor="rt-prompt" className="full">
                <TextArea id="rt-prompt" fill rows={4} value={draft.prompt}
                  placeholder="Beschreiben Sie genau, welche Daten gelesen, verglichen und wie das Ergebnis aufbereitet werden soll …"
                  onChange={(e) => patch({ prompt: e.target.value })} />
              </FormGroup>
              <FormGroup label="Arbeitsschritte (optional, werden nummeriert ausgeführt)" className="full">
                <div className="routine-steps-editor">
                  {draft.steps.map((step, idx) => (
                    <div className="routine-step-input-row" key={idx}>
                      <span className="routine-step-num">{idx + 1}.</span>
                      <InputGroup fill value={step} placeholder={`Schritt ${idx + 1} …`}
                        onChange={(e) => {
                          const next = [...draft.steps];
                          next[idx] = e.target.value;
                          patch({ steps: next });
                        }} />
                      <Button minimal small icon="cross" aria-label="Schritt entfernen"
                        disabled={draft.steps.length <= 1}
                        onClick={() => patch({ steps: draft.steps.filter((_, i) => i !== idx) })} />
                    </div>
                  ))}
                  <Button small minimal icon="plus" text="Schritt hinzufügen"
                    onClick={() => patch({ steps: [...draft.steps, ""] })} />
                </div>
              </FormGroup>
              <FormGroup label="Optionen" className="full">
                <Switch checked={draft.write_mode} label="Mit Schreibmodus starten (Änderungen erlaubt)"
                  onChange={(e) => patch({ write_mode: (e.target as HTMLInputElement).checked })} />
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

      <Dialog isOpen={!!deleting} onClose={() => setDeleting(null)} title="Routine löschen">
        <DialogBody>
          <p>Routine „{deleting?.name}“ wirklich löschen? Bereits ausgeführte Chats bleiben erhalten.</p>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setDeleting(null)} />
            <Button intent="danger" text="Löschen" onClick={removeRoutine} loading={busy} />
          </>
        } />
      </Dialog>
    </div>
  );
}
