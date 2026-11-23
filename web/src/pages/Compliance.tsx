import { Button, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, HTMLTable, InputGroup, Spinner, Tab, Tabs, Tag, TextArea } from "@blueprintjs/core";
import NonIdealState from "../components/NonIdealState";
import Callout from "../components/Callout";
import { useCallback, useEffect, useState } from "react";
import { api, fmtDateTime } from "../api";
import { toastError, toastSuccess } from "../toast";
import { plural } from "../plural";
import {
  FilterGroup, FilterPopover, FilterTag, HintDetails, InfoHint, PageFrame, SortControl, Toolbar,
  sortRows, useSortPref,
} from "../ui";
import type { SortField } from "../ui";

/* Compliance (EU Cyber Resilience Act) — die Personalseite zu /api/compliance.

   Meldungen kommen über das Formular der Website herein (/scientific/compliance/),
   Hinweise gehen nach dem Veröffentlichen dort hinaus. Eine aktiv ausgenutzte
   Schwachstelle steht oben und rot: für sie läuft die 24-Stunden-Frist der
   Frühwarnung an die ENISA (Art. 14 CRA). */

type Severity = "low" | "medium" | "high" | "critical";
type ReportStatus = "new" | "triaged" | "confirmed" | "fixed" | "rejected" | "duplicate";

interface Report {
  ref: string; product: string; version: string; title: string; description: string;
  impact: string; exploited: boolean; reporter_name: string; reporter_email: string;
  credit: boolean; status: ReportStatus; severity: Severity | null; triage_note: string;
  advisory_ref: string; created_at: string; closed_at: string | null; contact_purged: boolean;
}
interface Advisory {
  ref: string; title: string; product: string; affected: string; fixed_in: string;
  severity: Severity; cve: string[]; summary: string; remediation: string; credit: string;
  published: boolean; published_at: string | null;
}
interface SupportRow {
  product: string; component: string; version: string; kind: "hosted" | "distributed";
  security_support_until: string | null; note_de: string; note_en: string;
}

const PRODUCTS = ["phonos", "phonos-sdk", "phonos-cli", "phonos-worker", "alef", "website", "other"];
const SEVERITIES: Array<[Severity, string]> = [["low", "Niedrig"], ["medium", "Mittel"], ["high", "Hoch"], ["critical", "Kritisch"]];
const STATUS: Array<[ReportStatus, string]> = [
  ["new", "Neu"], ["triaged", "Gesichtet"], ["confirmed", "Bestätigt"],
  ["fixed", "Behoben"], ["rejected", "Abgelehnt"], ["duplicate", "Doppelt"],
];
const SEV_INTENT: Record<Severity, "none" | "primary" | "warning" | "danger"> = {
  low: "none", medium: "primary", high: "warning", critical: "danger",
};
const statusLabel = (s: string) => STATUS.find(([k]) => k === s)?.[1] ?? s;
const sevLabel = (s: string | null) => (s ? SEVERITIES.find(([k]) => k === s)?.[1] ?? s : "—");
const REPORT_SORT_FIELDS: SortField[] = [
  { id: "urgent", label: "Dringend zuerst" },
  { id: "created_at", label: "Eingang" },
  { id: "ref", label: "Nummer" },
  { id: "product", label: "Produkt" },
  { id: "severity", label: "Schwere" },
  { id: "status", label: "Status" },
];
const SEVERITY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };

export default function Compliance({ admin }: { admin: boolean }) {
  const [tab, setTab] = useState<string>("reports");
  return (
    <PageFrame title="Compliance" sub="Schwachstellenmeldungen, Sicherheitshinweise und Supportzeiträume.">
      <HintDetails title="Was hier steht">
        <p>
          Meldungen kommen über das Formular der Website herein, Hinweise gehen nach dem
          Veröffentlichen dorthin hinaus. Öffentlich sichtbar auf fyreflysystems.de/scientific/compliance/.
        </p>
        <p>
          Eine aktiv ausgenutzte Schwachstelle steht oben und rot: für sie läuft die 24-Stunden-Frist
          der Frühwarnung an die ENISA (Art. 14 CRA).
        </p>
      </HintDetails>
      <Tabs id="compliance-tabs" selectedTabId={tab} onChange={(t) => setTab(String(t))} renderActiveTabPanelOnly>
        <Tab id="reports" title="Meldungen" panel={<Reports />} />
        <Tab id="advisories" title="Sicherheitshinweise" panel={<Advisories />} />
        <Tab id="support" title="Supportzeiträume" panel={<Support admin={admin} />} />
      </Tabs>
    </PageFrame>
  );
}

// --------------------------------------------------------------------------
// Meldungen
// --------------------------------------------------------------------------
function Reports() {
  const [rows, setRows] = useState<Report[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<"" | ReportStatus>("");
  const [severity, setSeverity] = useState<"" | Severity>("");
  const { sort, setSort } = useSortPref("gimel-compliance-sort", REPORT_SORT_FIELDS,
    { field: "urgent", dir: "desc" });
  const [edit, setEdit] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const q = filter ? `?status=${filter}` : "";
      setRows((await api<{ reports: Report[] }>(`/api/compliance/admin/reports${q}`)).reports);
    } catch (e: any) { setFailed(true); toastError(e.message); }
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await api(`/api/compliance/admin/reports/${edit.ref}`, {
        method: "PATCH",
        body: JSON.stringify({ status: edit.status, severity: edit.severity, triage_note: edit.triage_note,
                               advisory_ref: edit.advisory_ref }),
      });
      toastSuccess(`Meldung ${edit.ref} gespeichert.`);
      setEdit(null);
      load();
    } catch (e: any) { toastError(e.message); }
    finally { setBusy(false); }
  };

  if (failed) return <NonIdealState icon="error" title="Meldungen nicht geladen"
                                    action={<Button icon="refresh" onClick={load}>Erneut laden</Button>} />;
  if (!rows) return <Spinner />;
  const urgent = rows.filter((r) => r.exploited && !r.closed_at);
  const visible = severity ? rows.filter((r) => r.severity === severity) : rows;
  const sorted = sortRows(visible, sort, (r, field) =>
    field === "urgent" ? Number(r.exploited && !r.closed_at)
      : field === "severity" ? SEVERITY_RANK[r.severity ?? ""] ?? -1
      : (r as unknown as Record<string, unknown>)[field]);

  return (
    <>
      {urgent.length > 0 && (
        <Callout intent="danger" icon="warning-sign" title={`${plural(urgent.length, "offene Meldung", "offene Meldungen")} mit aktiver Ausnutzung`}>
          Frühwarnung binnen 24 Stunden, Meldung binnen 72 Stunden über die ENISA Single Reporting Platform (Art. 14 CRA),
          sobald die Ausnutzung bestätigt ist.
        </Callout>
      )}
      <Toolbar meta={<span className="bp5-text-muted">{plural(sorted.length, "Meldung", "Meldungen")}</span>}
               end={<Button icon="refresh" onClick={load}>Aktualisieren</Button>}>
        <FilterPopover active={(filter ? 1 : 0) + (severity ? 1 : 0)} onClear={() => { setFilter(""); setSeverity(""); }}>
          <FilterGroup label="Status">
            <HTMLSelect value={filter} onChange={(e) => setFilter(e.target.value as ReportStatus | "")} aria-label="Status filtern">
              <option value="">Alle Status</option>
              {STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </HTMLSelect>
          </FilterGroup>
          <FilterGroup label="Schwere">
            <HTMLSelect value={severity} onChange={(e) => setSeverity(e.target.value as Severity | "")} aria-label="Schwere filtern">
              <option value="">Alle Schweregrade</option>
              {SEVERITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </HTMLSelect>
          </FilterGroup>
        </FilterPopover>
        <SortControl state={sort} fields={REPORT_SORT_FIELDS} onChange={setSort} />
        {filter && <FilterTag label={statusLabel(filter)} onRemove={() => setFilter("")} />}
        {severity && <FilterTag label={sevLabel(severity)} onRemove={() => setSeverity("")} />}
      </Toolbar>
      {rows.length === 0 ? <NonIdealState icon="shield" title="Keine Meldungen" /> : (
        <div className="table-scroll">
        <HTMLTable striped interactive style={{ width: "100%" }}>
          <thead><tr><th>Nr.</th><th>Eingang</th><th>Produkt</th><th>Titel</th><th>Schwere</th><th>Status</th><th>Melder</th></tr></thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.ref} onClick={() => setEdit({ ...r })} style={{ cursor: "pointer" }}>
                <td><strong>{r.ref}</strong> {r.exploited && !r.closed_at && <Tag intent="danger" minimal>ausgenutzt</Tag>}</td>
                <td>{fmtDateTime(r.created_at)}</td>
                <td>{r.product}{r.version ? ` ${r.version}` : ""}</td>
                <td>{r.title}</td>
                <td>{r.severity ? <Tag intent={SEV_INTENT[r.severity]}>{sevLabel(r.severity)}</Tag> : "—"}</td>
                <td>{statusLabel(r.status)}</td>
                <td>{r.contact_purged ? <span className="bp5-text-muted">gelöscht (Frist)</span> : (r.reporter_name || r.reporter_email)}</td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
        </div>
      )}
      <Dialog isOpen={!!edit} onClose={() => setEdit(null)} title={edit ? `Meldung ${edit.ref}` : ""} style={{ width: 720 }}>
        {edit && <>
          <DialogBody>
            {edit.exploited && <Callout intent="danger" icon="warning-sign">Der Melder gibt an, dass die Schwachstelle aktiv ausgenutzt wird.</Callout>}
            <p><strong>{edit.title}</strong> · {edit.product} {edit.version}</p>
            <p style={{ whiteSpace: "pre-wrap" }}>{edit.description}</p>
            {edit.impact && <p style={{ whiteSpace: "pre-wrap" }}><em>Auswirkung:</em> {edit.impact}</p>}
            <p className="bp5-text-muted">
              Melder: {edit.contact_purged ? "Kontaktdaten nach Frist gelöscht" : `${edit.reporter_name || "—"} <${edit.reporter_email}>`}
              {edit.credit ? " · möchte genannt werden" : ""}
            </p>
            <div style={{ display: "flex", gap: 12 }}>
              <FormGroup label="Status" labelFor="vr-status">
                <HTMLSelect id="vr-status" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value as ReportStatus })}>
                  {STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Schwere" labelFor="vr-sev">
                <HTMLSelect id="vr-sev" value={edit.severity ?? ""} onChange={(e) => setEdit({ ...edit, severity: (e.target.value || null) as Severity | null })}>
                  <option value="">— nicht bewertet —</option>
                  {SEVERITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Sicherheitshinweis" labelFor="vr-adv">
                <InputGroup id="vr-adv" value={edit.advisory_ref} placeholder="FSA-26-0001"
                            onChange={(e) => setEdit({ ...edit, advisory_ref: e.target.value })} />
              </FormGroup>
            </div>
            <FormGroup label="Bearbeitungsnotiz (intern)" labelFor="vr-note">
              <TextArea id="vr-note" fill rows={4} value={edit.triage_note}
                        onChange={(e) => setEdit({ ...edit, triage_note: e.target.value })} />
            </FormGroup>
          </DialogBody>
          <DialogFooter actions={<>
            <Button onClick={() => setEdit(null)}>Abbrechen</Button>
            <Button intent="primary" loading={busy} onClick={save}>Speichern</Button>
          </>} />
        </>}
      </Dialog>
    </>
  );
}

// --------------------------------------------------------------------------
// Sicherheitshinweise
// --------------------------------------------------------------------------
const EMPTY_ADV: Omit<Advisory, "ref" | "published" | "published_at"> = {
  title: "", product: "phonos", affected: "", fixed_in: "", severity: "medium", cve: [],
  summary: "", remediation: "", credit: "",
};

function Advisories() {
  const [rows, setRows] = useState<Advisory[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [edit, setEdit] = useState<(Partial<Advisory> & { cveText?: string }) | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try { setRows((await api<{ advisories: Advisory[] }>("/api/compliance/admin/advisories")).advisories); }
    catch (e: any) { setFailed(true); toastError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!edit) return;
    const cve = (edit.cveText ?? "").split(/[\s,;]+/).filter(Boolean);
    const body = { title: edit.title, product: edit.product, affected: edit.affected, fixed_in: edit.fixed_in,
                   severity: edit.severity, cve, summary: edit.summary, remediation: edit.remediation, credit: edit.credit };
    setBusy(true);
    try {
      if (edit.ref) await api(`/api/compliance/admin/advisories/${edit.ref}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/api/compliance/admin/advisories", { method: "POST", body: JSON.stringify(body) });
      toastSuccess(edit.ref ? `Hinweis ${edit.ref} gespeichert.` : "Entwurf angelegt.");
      setEdit(null);
      load();
    } catch (e: any) { toastError(e.message); }
    finally { setBusy(false); }
  };

  const setPublished = async (a: Advisory, published: boolean) => {
    if (published && !window.confirm(`${a.ref} „${a.title}“ auf der Website veröffentlichen?`)) return;
    try {
      await api(`/api/compliance/admin/advisories/${a.ref}`, { method: "PATCH", body: JSON.stringify({ published }) });
      toastSuccess(published ? `${a.ref} veröffentlicht.` : `${a.ref} zurückgezogen.`);
      load();
    } catch (e: any) { toastError(e.message); }
  };

  if (failed) return <NonIdealState icon="error" title="Hinweise nicht geladen"
                                    action={<Button icon="refresh" onClick={load}>Erneut laden</Button>} />;
  if (!rows) return <Spinner />;
  return (
    <>
      <Toolbar end={<>
        <Button icon="add" intent="primary" onClick={() => setEdit({ ...EMPTY_ADV, cveText: "" })}>Neuer Hinweis</Button>
        <Button icon="refresh" onClick={load}>Aktualisieren</Button>
      </>} />
      {rows.length === 0 ? <NonIdealState icon="document" title="Noch keine Sicherheitshinweise" /> : (
        <div className="table-scroll">
        <HTMLTable striped style={{ width: "100%" }}>
          <thead><tr><th>Nr.</th><th>Titel</th><th>Produkt</th><th>Schwere</th><th>Behoben in</th><th>Status</th><th><span className="sr-only">Aktion</span></th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.ref}>
                <td><strong>{a.ref}</strong></td>
                <td>{a.title}{a.cve.length > 0 && <div className="bp5-text-muted">{a.cve.join(", ")}</div>}</td>
                <td>{a.product}</td>
                <td><Tag intent={SEV_INTENT[a.severity]}>{sevLabel(a.severity)}</Tag></td>
                <td>{a.fixed_in || "—"}</td>
                <td>{a.published ? <Tag intent="success">veröffentlicht {a.published_at ? fmtDateTime(a.published_at) : ""}</Tag> : <Tag minimal>Entwurf</Tag>}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <Button small minimal icon="edit" aria-label={`${a.ref} bearbeiten`} title="Bearbeiten"
                          onClick={() => setEdit({ ...a, cveText: a.cve.join(", ") })} />
                  {a.published
                    ? <Button small minimal icon="eye-off" onClick={() => setPublished(a, false)}>Zurückziehen</Button>
                    : <Button small intent="primary" icon="globe" onClick={() => setPublished(a, true)}>Veröffentlichen</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
        </div>
      )}
      <Dialog isOpen={!!edit} onClose={() => setEdit(null)} title={edit?.ref ? `Hinweis ${edit.ref}` : "Neuer Sicherheitshinweis"} style={{ width: 720 }}>
        {edit && <>
          <DialogBody>
            <FormGroup label="Titel" labelFor="adv-title"><InputGroup id="adv-title" value={edit.title ?? ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></FormGroup>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <FormGroup label="Produkt" labelFor="adv-prod">
                <HTMLSelect id="adv-prod" value={edit.product} onChange={(e) => setEdit({ ...edit, product: e.target.value })}>
                  {PRODUCTS.map((p) => <option key={p} value={p}>{p}</option>)}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Schwere" labelFor="adv-sev">
                <HTMLSelect id="adv-sev" value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value as Severity })}>
                  {SEVERITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Betroffen" labelFor="adv-aff"><InputGroup id="adv-aff" value={edit.affected ?? ""} placeholder="web < 2026-10-20" onChange={(e) => setEdit({ ...edit, affected: e.target.value })} /></FormGroup>
              <FormGroup label="Behoben in" labelFor="adv-fix"><InputGroup id="adv-fix" value={edit.fixed_in ?? ""} onChange={(e) => setEdit({ ...edit, fixed_in: e.target.value })} /></FormGroup>
            </div>
            <FormGroup label="CVE-Kennungen" helperText="Kommagetrennt, z. B. CVE-2026-12345" labelFor="adv-cve">
              <InputGroup id="adv-cve" value={edit.cveText ?? ""} onChange={(e) => setEdit({ ...edit, cveText: e.target.value })} />
            </FormGroup>
            <FormGroup label="Beschreibung (öffentlich)" labelFor="adv-sum"><TextArea id="adv-sum" fill rows={4} value={edit.summary ?? ""} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} /></FormGroup>
            <FormGroup label="Abhilfe (öffentlich)" labelFor="adv-rem"><TextArea id="adv-rem" fill rows={3} value={edit.remediation ?? ""} onChange={(e) => setEdit({ ...edit, remediation: e.target.value })} /></FormGroup>
            <FormGroup label="Nennung des Melders" helperText="Nur mit dessen Einwilligung" labelFor="adv-credit"><InputGroup id="adv-credit" value={edit.credit ?? ""} onChange={(e) => setEdit({ ...edit, credit: e.target.value })} /></FormGroup>
          </DialogBody>
          <DialogFooter actions={<>
            <Button onClick={() => setEdit(null)}>Abbrechen</Button>
            <Button intent="primary" loading={busy} onClick={save}>{edit.ref ? "Speichern" : "Als Entwurf anlegen"}</Button>
          </>} />
        </>}
      </Dialog>
    </>
  );
}

// --------------------------------------------------------------------------
// Supportzeiträume
// --------------------------------------------------------------------------
function Support({ admin }: { admin: boolean }) {
  const [rows, setRows] = useState<SupportRow[] | null>(null);
  const [draft, setDraft] = useState<SupportRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows((await api<{ support_periods: SupportRow[] }>("/api/compliance/support-periods")).support_periods); }
    catch (e: any) { toastError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const body = draft.map((r) => ({ ...r, security_support_until: r.security_support_until || null }));
      await api("/api/compliance/admin/support-periods", { method: "PUT", body: JSON.stringify(body) });
      toastSuccess("Supportzeiträume gespeichert — sie stehen sofort auf der Website.");
      setDraft(null);
      load();
    } catch (e: any) { toastError(e.message); }
    finally { setBusy(false); }
  };

  if (!rows) return <Spinner />;
  const shown = draft ?? rows;
  const set = (i: number, patch: Partial<SupportRow>) => setDraft(shown.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      <Toolbar end={admin && !draft
        ? <Button icon="edit" onClick={() => setDraft(rows.map((r) => ({ ...r })))}>Bearbeiten</Button>
        : undefined}>
        <InfoHint label="Hinweis zu Supportzeiträumen" title="Supportzeiträume" text="Supportzeiträume sind eine öffentliche Zusage und werden von Administratoren gepflegt." />
      </Toolbar>
      <div className="table-scroll">
      <HTMLTable striped style={{ width: "100%" }}>
        <thead><tr><th>Produkt</th><th>Komponente</th><th>Version</th><th>Art</th><th>Sicherheitsupdates bis</th><th>Hinweis DE</th><th>Hinweis EN</th>{draft && <th><span className="sr-only">Aktion</span></th>}</tr></thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              {draft ? <>
                <td><HTMLSelect value={r.product} onChange={(e) => set(i, { product: e.target.value })}>{PRODUCTS.map((p) => <option key={p}>{p}</option>)}</HTMLSelect></td>
                <td><InputGroup value={r.component} onChange={(e) => set(i, { component: e.target.value })} /></td>
                <td><InputGroup value={r.version} onChange={(e) => set(i, { version: e.target.value })} /></td>
                <td><HTMLSelect value={r.kind} onChange={(e) => set(i, { kind: e.target.value as SupportRow["kind"] })}><option value="hosted">gehostet</option><option value="distributed">verteilt</option></HTMLSelect></td>
                <td><InputGroup type="date" value={(r.security_support_until ?? "").slice(0, 10)} onChange={(e) => set(i, { security_support_until: e.target.value ? `${e.target.value}T00:00:00Z` : null })} /></td>
                <td><InputGroup value={r.note_de} onChange={(e) => set(i, { note_de: e.target.value })} /></td>
                <td><InputGroup value={r.note_en} onChange={(e) => set(i, { note_en: e.target.value })} /></td>
                <td><Button minimal icon="trash" aria-label="Zeile entfernen" onClick={() => setDraft(shown.filter((_, j) => j !== i))} /></td>
              </> : <>
                <td>{r.product}</td><td>{r.component}</td><td>{r.version || "—"}</td>
                <td>{r.kind === "hosted" ? "gehostet" : "verteilt"}</td>
                <td>{r.security_support_until ? r.security_support_until.slice(0, 10) : "laufend / je Version"}</td>
                <td>{r.note_de}</td><td>{r.note_en}</td>
              </>}
            </tr>
          ))}
        </tbody>
      </HTMLTable>
      </div>
      {draft && <Toolbar end={<>
        <Button icon="add" onClick={() => setDraft([...shown, { product: "phonos", component: "", version: "", kind: "distributed", security_support_until: null, note_de: "", note_en: "" }])}>Zeile</Button>
        <Button onClick={() => setDraft(null)}>Verwerfen</Button>
        <Button intent="primary" loading={busy} onClick={save}>Speichern und veröffentlichen</Button>
      </>} />}
    </>
  );
}
