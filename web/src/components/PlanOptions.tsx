import { Button, HTMLSelect, NumericInput, Spinner, Switch, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { OptionDef, OptionGroup, OptionScope, optionGroups, optionProblem } from "../planOptions";
import { toastError, toastSuccess } from "../toast";

/* Planen → Optionen, aufklappbar.

   Die Seite, auf der die Werte wirken, trägt sie selbst: Schachteln zeigt
   Rechenkern, Kerf und Geometrie, die Disposition zusätzlich den Sammellauf.
   Zugeklappt kostet jede Gruppe eine Zeile; erst der Klick holt die Felder.
   Gespeichert wird je Gruppe, damit ein halb ausgefüllter Block die anderen
   nicht blockiert. Die Grenzen prüft zusätzlich der Server. */

interface SettingRow { key: string; value: string; note?: string }

export default function PlanOptions({ scope = "nesting", canEdit = true }: {
  scope?: OptionScope;
  canEdit?: boolean;
}) {
  const groups = useMemo(() => optionGroups(scope), [scope]);
  const [raw, setRaw] = useState<Record<string, string> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const seeded = useRef(false);

  const load = useCallback(async () => {
    try {
      const rows = await api<SettingRow[]>("/api/admin/settings");
      const map: Record<string, string> = {};
      for (const r of rows) map[r.key] = r.value;
      setRaw(map);
      if (!seeded.current) {
        seeded.current = true;
        setDraft(map);
      }
      setError("");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirtyOf = (g: OptionGroup) =>
    g.fields.filter((f) => (draft[f.key] ?? "") !== (raw?.[f.key] ?? ""));

  const save = async (g: OptionGroup) => {
    const dirty = dirtyOf(g);
    if (!dirty.length) return;
    for (const f of dirty) {
      const problem = optionProblem(f, draft[f.key] ?? "");
      if (problem) { toastError(`${f.label}: ${problem}`); return; }
    }
    setBusy(g.id);
    let failed = 0;
    for (const f of dirty) {
      const value = f.kind === "number"
        ? (draft[f.key] ?? "").trim().replace(",", ".")
        : (draft[f.key] ?? "").trim();
      try {
        await api(`/api/admin/settings/${encodeURIComponent(f.key)}`, {
          method: "PUT", body: JSON.stringify({ value }),
        });
        setRaw((r) => (r ? { ...r, [f.key]: value } : r));
        setDraft((d) => ({ ...d, [f.key]: value }));
      } catch (e: any) {
        failed += 1;
        const msg = e instanceof ApiError && e.status === 403
          ? "Nur Admins dürfen Betriebsparameter ändern."
          : e?.message ?? String(e);
        toastError(`${f.label}: ${msg}`);
        break;
      }
    }
    setBusy("");
    if (!failed) {
      toastSuccess(dirty.length === 1
        ? "Option gespeichert. Sie gilt für den nächsten Lauf."
        : `${dirty.length} Optionen gespeichert. Sie gelten für den nächsten Lauf.`);
    }
  };

  if (error && !raw) {
    return (
      <div className="plan-opt-error" role="alert">
        <b>Optionen nicht geladen.</b> <span className="sub">{error}</span>
        <Button small minimal icon="refresh" text="Erneut" onClick={load} />
      </div>
    );
  }
  if (!raw) return <Spinner size={18} aria-label="Optionen laden" />;

  return (
    <section className="plan-opts" aria-label="Planungsoptionen">
      <p className="plan-opts-lead">
        <b>Optionen</b> — aufklappen, ändern, speichern. Die Werte gelten für den nächsten
        Sammellauf; ein offener Innenauftrag behält seine Lage, bis er neu geschachtelt wird.
        {!canEdit && <> <Tag minimal intent="warning">Nur Admins ändern</Tag></>}
      </p>

      {groups.map((g) => {
        const dirty = dirtyOf(g);
        const current = g.summary(raw);
        return (
          <details key={g.id} className="plan-opt-fold" data-group={g.id}>
            <summary>
              <span className="plan-opt-chev" aria-hidden="true" />
              <span className="plan-opt-title">{g.title}</span>
              <span className="plan-opt-now">{current}</span>
              {dirty.length > 0 && <Tag minimal intent="warning">{dirty.length} geändert</Tag>}
            </summary>
            <div className="plan-opt-body">
              <p className="sub plan-opt-hint">{g.hint}</p>
              <div className="plan-opt-grid">
                {g.fields.map((f) => (
                  <Field key={f.key} def={f} value={draft[f.key] ?? ""} disabled={!canEdit || busy === g.id}
                         onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} />
                ))}
              </div>
              <div className="plan-opt-foot">
                <span className="sub">
                  {dirty.length
                    ? `${dirty.length} ${dirty.length === 1 ? "Änderung" : "Änderungen"} warten.`
                    : "Alles gespeichert."}
                </span>
                {canEdit && (
                  <Button small intent="primary" icon="floppy-disk" text="Gruppe speichern"
                          loading={busy === g.id} disabled={!dirty.length || !!busy}
                          onClick={() => save(g)} />
                )}
              </div>
            </div>
          </details>
        );
      })}
    </section>
  );
}

function Field({ def, value, disabled, onChange }: {
  def: OptionDef; value: string; disabled: boolean; onChange: (v: string) => void;
}) {
  if (def.kind === "boolean") {
    return (
      <div className="plan-opt-field plan-opt-switch">
        <Switch checked={value === "true"} disabled={disabled}
                label={def.label}
                onChange={(e) => onChange((e.target as HTMLInputElement).checked ? "true" : "false")} />
        {def.hint && <span className="plan-opt-help">{def.hint}</span>}
      </div>
    );
  }
  if (def.kind === "select") {
    return (
      <label className="plan-opt-field">
        <span>{def.label}</span>
        <HTMLSelect fill value={value} disabled={disabled}
                    onChange={(e) => onChange(e.currentTarget.value)}>
          {(def.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </HTMLSelect>
        {def.hint && <span className="plan-opt-help">{def.hint}</span>}
      </label>
    );
  }
  return (
    <label className="plan-opt-field">
      <span>{def.label}</span>
      <NumericInput
        fill value={value} min={def.min} max={def.max} stepSize={def.step ?? 1}
        majorStepSize={Math.max(10, def.step ?? 1)}
        buttonPosition="none" disabled={disabled}
        minorStepSize={Math.min(def.step ?? 1, 0.01)}
        placeholder={def.empty ? "automatisch / erbt" : undefined}
        onValueChange={(v) => onChange(Number.isFinite(v) ? String(v) : "")}
      />
      {def.hint && <span className="plan-opt-help">{def.hint}</span>}
    </label>
  );
}
