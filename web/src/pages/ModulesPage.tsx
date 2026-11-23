import { useEffect, useState } from "react";
import {
  Button, Callout, Checkbox, Dialog, DialogBody, DialogFooter, FormGroup,
  HTMLSelect, Icon, IconName, InputGroup, Switch, Tag, TextArea,
} from "@blueprintjs/core";
import NonIdealState from "../components/NonIdealState";
import { navigate } from "../router";
import { toastError, toastSuccess } from "../toast";
import { PageFrame } from "../ui";
import {
  createExternalModule, deleteExternalModule, moduleHref, moduleIsInternalHash,
  ModuleDraft, refreshAppModules, updateExternalModule, useAppModules,
} from "../modules/externalStore";
import type { AppModuleDescriptor } from "../modules/types";

/* Module & Apps (#/module): zentrale Übersicht für Kernmodule, eingebundene
   Python-/SPA-Module und semi-externe Anwendungen. Administratoren können hier
   semi-externe Tools (z. B. CAD-Viewer, Grafana, WMS, eigene Web-Apps) ohne
   Neubau anbinden, einbetten oder in den App-Wechsler legen. */

const ICONS: Array<{ value: IconName; label: string }> = [
  { value: "applications", label: "Anwendung" },
  { value: "cube", label: "3D / Zwilling" },
  { value: "chart", label: "Kennzahlen / BI" },
  { value: "wrench", label: "Werkzeug / MES" },
  { value: "database", label: "Daten / WMS" },
  { value: "document", label: "Dokumente / DMS" },
  { value: "globe", label: "Web-App" },
  { value: "flows", label: "Workflows / Automatisierung" },
  { value: "shield", label: "Qualität / Sicherheit" },
  { value: "chat", label: "Assistenz" },
];

const PLACEMENT_LABEL: Record<string, string> = {
  switcher: "App-Wechsler",
  sidebar: "Seitenleiste",
  menu: "Kontomenü",
  hub: "Nur Übersicht & Strg+K",
};

const KIND_LABEL: Record<string, string> = {
  core: "Kern",
  mounted: "Eingebunden",
  embedded: "Eingebettet",
  external: "Extern",
};

const EMPTY_DRAFT: ModuleDraft = {
  label: "",
  short_label: "",
  icon: "applications",
  description: "",
  kind: "embedded",
  href: "",
  embed_url: "",
  placement: "hub",
  area: "beide",
  group: "Erweiterungen",
  roles: [],
  new_tab: false,
  enabled: true,
  order: 100,
};

export default function ModulesPage({ admin }: { admin: boolean }) {
  const { modules } = useAppModules(false);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModuleDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      await refreshAppModules(admin);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [admin]); // eslint-disable-line react-hooks/exhaustive-deps

  const builtin = modules.filter((m) => m.source === "builtin" || m.source === "python");
  const custom = modules.filter((m) => m.source === "db" || m.source === "config");

  const openCreate = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setDialogOpen(true);
  };

  const openEdit = (m: AppModuleDescriptor) => {
    setEditingId(m.id);
    setDraft({
      id: m.id,
      label: m.label,
      short_label: m.short_label,
      icon: String(m.icon || "applications"),
      description: m.description,
      kind: m.kind === "core" ? "external" : m.kind,
      href: m.href,
      embed_url: m.embed_url,
      placement: m.placement,
      area: m.area,
      group: m.group,
      roles: m.roles,
      new_tab: m.new_tab,
      enabled: m.enabled,
      order: m.order,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!draft.label.trim() || !draft.href.trim()) {
      toastError("Bitte Name und URL angeben.");
      return;
    }
    setSaving(true);
    try {
      const payload: ModuleDraft = {
        ...draft,
        embed_url: draft.kind === "embedded" ? (draft.embed_url || draft.href) : "",
        new_tab: draft.kind === "external" ? true : draft.kind === "embedded" ? false : draft.new_tab,
      };
      if (editingId) {
        await updateExternalModule(editingId, payload);
        toastSuccess(`Modul „${draft.label}“ aktualisiert.`);
      } else {
        await createExternalModule(payload);
        toastSuccess(`Modul „${draft.label}“ angebunden.`);
      }
      setDialogOpen(false);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (m: AppModuleDescriptor) => {
    setBusyId(m.id);
    try {
      await updateExternalModule(m.id, { enabled: !m.enabled });
      toastSuccess(`${m.label} ${!m.enabled ? "aktiviert" : "deaktiviert"}.`);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (m: AppModuleDescriptor) => {
    setBusyId(m.id);
    try {
      await deleteExternalModule(m.id);
      toastSuccess(`Modul „${m.label}“ entfernt.`);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const openModule = (m: AppModuleDescriptor) => {
    if (moduleIsInternalHash(m)) {
      navigate(`ext/${encodeURIComponent(m.id)}`);
      return;
    }
    const href = moduleHref(m);
    if (m.new_tab) window.open(href, "_blank", "noopener,noreferrer");
    else window.location.href = href;
  };

  const toggleRole = (r: string) => {
    const cur = draft.roles ?? [];
    const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r];
    setDraft({ ...draft, roles: next });
  };

  return (
    <PageFrame
      title="Module & Apps"
      sub="Kernmodule und angebundene semi-externe Software zentral verwalten und öffnen."
      actions={<>
        <Button small minimal icon="refresh" text="Aktualisieren" loading={loading} onClick={reload} />
        {admin && (
          <Button small intent="primary" icon="plus" text="Anwendung anbinden" onClick={openCreate} />
        )}
      </>}
    >
      <section className="wp-section">
        <div className="wp-section-head">
          <div>
            <h2 className="wp-section-title">
              <Icon icon="applications" size={15} aria-hidden="true" />
              <span>Kern- &amp; Server-Module</span>
              <span className="wp-section-count">{builtin.length}</span>
            </h2>
            <p className="sub wp-section-desc">
              Fest eingebaute Oberflächen und per Python/Plugin registrierte Module dieser Installation.
            </p>
          </div>
        </div>
        <div className="wp-grid">
          {builtin.map((m) => (
            <div key={m.id} className="wp-card mod-card">
              <div className="wp-card-top">
                <div className="wp-card-title">
                  <span className="wp-card-name">
                    <Icon icon={(m.icon || "applications") as IconName} size={14} aria-hidden="true" />
                    <strong>{m.label}</strong>
                  </span>
                  <span className="sub mono">{m.href}</span>
                </div>
                <Tag minimal intent="primary">{KIND_LABEL[m.kind] ?? m.kind}</Tag>
              </div>
              <p className="sub mod-card-desc">{m.description || "Integriertes Modul."}</p>
              <div className="wp-card-foot">
                <span className="sub">{PLACEMENT_LABEL[m.placement] ?? m.placement}</span>
                <Button small minimal intent="primary" rightIcon={m.new_tab ? "share" : "chevron-right"}
                        text="Öffnen" onClick={() => openModule(m)} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="wp-section" style={{ marginTop: 24 }}>
        <div className="wp-section-head">
          <div>
            <h2 className="wp-section-title">
              <Icon icon="cube-add" size={15} aria-hidden="true" />
              <span>Semi-externe Software &amp; Erweiterungen</span>
              <span className="wp-section-count">{custom.length}</span>
            </h2>
            <p className="sub wp-section-desc">
              Zusätzliche Werkzeuge (z. B. CAD-Viewer, BI-Dashboards, WMS, Workflows) — eingebettet im Portal oder als eigener Tab.
            </p>
          </div>
        </div>

        {custom.length === 0 ? (
          <NonIdealState
            icon="cube-add"
            title="Noch keine semi-externe Anwendung angebunden"
            description="Verbinden Sie eigene Web-Tools, Dashboards oder Neben-Services per URL — wahlweise direkt im Portal eingebettet, im App-Wechsler oder über Strg+K."
            action={admin ? (
              <Button intent="primary" icon="plus" text="Erste Anwendung anbinden" onClick={openCreate} />
            ) : undefined}
          />
        ) : (
          <div className="wp-grid">
            {custom.map((m) => (
              <div key={m.id} className={`wp-card mod-card${!m.enabled ? " is-inactive" : ""}`}>
                <div className="wp-card-top">
                  <div className="wp-card-title">
                    <span className="wp-card-name">
                      <Icon icon={(m.icon || "applications") as IconName} size={14} aria-hidden="true" />
                      <strong>{m.label}</strong>
                    </span>
                    <span className="sub mono" title={m.href}>{m.href}</span>
                  </div>
                  <Tag minimal intent={m.enabled ? "success" : "none"}>
                    {m.enabled ? (KIND_LABEL[m.kind] ?? m.kind) : "Aus"}
                  </Tag>
                </div>
                <p className="sub mod-card-desc">{m.description || "Externe Erweiterung."}</p>
                <div className="wp-card-foot">
                  <span className="sub">{PLACEMENT_LABEL[m.placement] ?? m.placement}</span>
                  <div className="row-actions">
                    {admin && m.editable && (
                      <>
                        <Button small minimal icon={m.enabled ? "pause" : "play"}
                                title={m.enabled ? "Deaktivieren" : "Aktivieren"}
                                loading={busyId === m.id} onClick={() => toggleEnabled(m)} />
                        <Button small minimal icon="edit" title="Bearbeiten" onClick={() => openEdit(m)} />
                        <Button small minimal intent="danger" icon="trash" title="Entfernen"
                                loading={busyId === m.id} onClick={() => remove(m)} />
                      </>
                    )}
                    <Button small minimal intent="primary"
                            rightIcon={m.kind === "external" || m.new_tab ? "share" : "chevron-right"}
                            text="Öffnen" disabled={!m.enabled} onClick={() => openModule(m)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Callout compact icon="code" style={{ marginTop: 22 }}>
        <strong>Für Entwickler:</strong> Eigenständige Python-/Vite-Module lassen sich zusätzlich über{" "}
        <code>gimel.modules.register_module(...)</code>, <code>GIMEL_MODULE_IMPORTS</code> oder eine JSON-Datei via{" "}
        <code>GIMEL_MODULES_FILE</code> einbinden — inklusive eigener FastAPI-Routen und statischer SPA-Bundles.
      </Callout>

      <Dialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        icon="cube-add"
        title={editingId ? `Anwendung bearbeiten (${editingId})` : "Semi-externe Anwendung anbinden"}
        style={{ width: 540, maxWidth: "94vw" }}
      >
        <DialogBody>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 10 }}>
            <FormGroup label="Name *">
              <InputGroup
                placeholder="z. B. CAD-Viewer, Grafana, WMS"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </FormGroup>
            <FormGroup label="Kurzname" helperText="Für App-Wechsler">
              <InputGroup
                placeholder="z. B. CAD"
                maxLength={20}
                value={draft.short_label ?? ""}
                onChange={(e) => setDraft({ ...draft, short_label: e.target.value })}
              />
            </FormGroup>
          </div>

          <FormGroup label="Ziel-URL oder lokaler Pfad *" helperText="Relativer Pfad (/mein-tool/) oder http(s)://…">
            <InputGroup
              placeholder="http://127.0.0.1:3000 oder /custom-app/"
              value={draft.href}
              onChange={(e) => setDraft({ ...draft, href: e.target.value })}
            />
          </FormGroup>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <FormGroup label="Einbindung">
              <HTMLSelect
                fill
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as ModuleDraft["kind"] })}
              >
                <option value="embedded">Eingebettet im Portal (#/ext/…)</option>
                <option value="external">Extern (neuer Tab)</option>
                <option value="mounted">Eingebundene SPA (gleicher Tab)</option>
              </HTMLSelect>
            </FormGroup>
            <FormGroup label="Platzierung">
              <HTMLSelect
                fill
                value={draft.placement}
                onChange={(e) => setDraft({ ...draft, placement: e.target.value as ModuleDraft["placement"] })}
              >
                <option value="hub">Nur Module &amp; Strg+K (ruhig)</option>
                <option value="switcher">App-Wechsler unten</option>
                <option value="sidebar">Seitenleiste</option>
                <option value="menu">Kontomenü</option>
              </HTMLSelect>
            </FormGroup>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <FormGroup label="Symbol">
              <HTMLSelect
                fill
                value={draft.icon || "applications"}
                onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
              >
                {ICONS.map((ic) => <option key={ic.value} value={ic.value}>{ic.label}</option>)}
              </HTMLSelect>
            </FormGroup>
            <FormGroup label="Arbeitsbereich">
              <HTMLSelect
                fill
                value={draft.area}
                onChange={(e) => setDraft({ ...draft, area: e.target.value as ModuleDraft["area"] })}
              >
                <option value="beide">Büro &amp; Leitstand</option>
                <option value="leitstand">Nur Leitstand</option>
                <option value="buero">Nur Büro</option>
              </HTMLSelect>
            </FormGroup>
          </div>

          <FormGroup label="Beschreibung">
            <TextArea
              fill
              rows={2}
              placeholder="Kurzer Hinweis, wofür diese Anwendung gedacht ist."
              value={draft.description ?? ""}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </FormGroup>

          <FormGroup label="Sichtbar für Rollen" helperText="Ohne Auswahl für alle angemeldeten Rollen sichtbar.">
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {([["admin", "Admin"], ["staff", "Büro / Personal"], ["worker", "Werker"]] as const).map(([r, lbl]) => (
                <Checkbox
                  key={r}
                  inline
                  label={lbl}
                  checked={(draft.roles ?? []).includes(r)}
                  onChange={() => toggleRole(r)}
                />
              ))}
            </div>
          </FormGroup>

          <Switch
            label="Aktiviert"
            checked={draft.enabled !== false}
            onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })}
          />
        </DialogBody>
        <DialogFooter
          actions={<>
            <Button text="Abbrechen" onClick={() => setDialogOpen(false)} />
            <Button intent="primary" icon="tick" text={editingId ? "Speichern" : "Anbinden"} loading={saving} onClick={save} />
          </>}
        />
      </Dialog>
    </PageFrame>
  );
}
