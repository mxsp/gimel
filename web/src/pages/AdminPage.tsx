import { Button, HTMLSelect, HTMLTable, InputGroup, Spinner, Switch, Tab, Tabs, Tag } from "@blueprintjs/core";
import NonIdealState from "../components/NonIdealState";
import Callout from "../components/Callout";
import type { Intent } from "@blueprintjs/core";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDateTime } from "../api";
import { toastError, toastSuccess } from "../toast";
import { FilterGroup, FilterPopover, FilterTag, HintDetails, InfoHint, KpiStrip, PageFrame, Toolbar } from "../ui";
import SammellaufPanel from "./SammellaufPanel";
import { AccountManagerPanel } from "./Users";
import AgentSettings from "@agentlab/AgentSettings";
import { installAgentTransport } from "../components/agent/transport";
import "../components/agent/agent.css";
import SystemSettingsPanel from "../components/SystemSettingsPanel";

/* Admin — Kennzahlen, Betriebsparameter, Protokoll und der Ereignisstrom.

   Vollständig statt verlinkt: bis zur Übernahme zeigte diese Seite nur eine
   Leseansicht und schickte für alles Weitere zurück in die alte Subapp. Die
   vier Reiter decken den Betrieb ab: die Kennzahlen sagen, ob etwas hakt,
   die Parameter steuern den Sammellauf, das Protokoll bleibt als Beleg,
   und der Strom meldet, was gerade geschieht. */

interface AuditRow {
  id: number; at: string; actor: string; action: string;
  entity: string; entity_id: string; detail: Record<string, unknown>;
}
interface SettingRow {
  key: string; value: string; note: string;
  updated_at: string | null; updated_by: string;
}

interface AdminStats {
  users: number; users_active: number; admins: number;
  products: number;
  orders: number; orders_blocked: number; orders_portal: number;
  last_portal_sync_at: string | null;
  positions_pending: number; positions_manual: number;
  work_orders_open: number; work_orders_running: number;
  runs_30d: number; saved_area_m2_30d: number; saved_pct_30d: number;
  unverified_prices: number;
}

export default function AdminPage() {
  const [tab, setTab] = useState("kennzahlen");
  return (
    <PageFrame title="Admin">
      <Tabs id="admin" selectedTabId={tab} onChange={(t) => setTab(String(t))} large renderActiveTabPanelOnly>
        <Tab id="kennzahlen" title="Kennzahlen" panel={<StatsPanel />} />
        <Tab id="konten" title="Konten" panel={<AccountManagerPanel />} />
        <Tab id="sammellauf" title="Sammellauf" panel={<SammellaufPanel />} />
        <Tab id="parameter" title="Betriebsparameter" panel={<SettingsPanel />} />
        <Tab id="agent" title="Assistent & Sandbox" panel={<AgentAdminPanel />} />
        <Tab id="protokoll" title="Protokoll" panel={<AuditPanel />} />
        <Tab id="strom" title="Ereignisse" panel={<EventsPanel />} />
        <Tab id="updates" title="Updates" panel={<UpdatesPanel />} />
        <Tab id="system" title="System & Info" panel={<SystemSettingsPanel isAdmin onNavigateTab={setTab} />} />
      </Tabs>
    </PageFrame>
  );
}

function AgentAdminPanel() {
  installAgentTransport();
  return <AgentSettings />;
}

// --------------------------------------------------------------------------
// Kennzahlen — /api/admin/stats, alle 60 Sekunden frisch
// --------------------------------------------------------------------------

function StatsPanel() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [err, setErr] = useState("");
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setStats(await api<AdminStats>("/api/admin/stats"));
      setLoadedAt(new Date());
      setErr("");
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Die Kennzahlen sind ein Fenster, keine Alarmzentrale — 60 Sekunden Takt
  // genügen; was sofort gemeldet werden muss, läuft über den Ereignisstrom.
  useEffect(() => {
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, [load]);

  if (err && !stats) {
    return (
      <NonIdealState icon="error" title="Kennzahlen nicht geladen" description={err}
        action={<Button icon="refresh" onClick={load}>Erneut versuchen</Button>} />
    );
  }
  if (!stats) return <Spinner size={30} />;

  const de1 = (v: number) => v.toLocaleString("de-DE", { maximumFractionDigits: 1 });

  return (
    <div>
      <Toolbar
        meta={`Stand ${loadedAt ? loadedAt.toLocaleTimeString("de-DE") : "—"} · 60-s-Takt`}
        end={<Button icon="refresh" onClick={load} loading={busy} text="Aktualisieren" />}
      />

      <section aria-labelledby="admin-kpi-title">
        <h2 id="admin-kpi-title" className="sr-only">Kennzahlen</h2>
        {/* In „Einfach" die vier Zahlen, die etwas zu tun geben; der Rest hinter „Mehr Kennzahlen". */}
        <KpiStrip label="Betrieb in Zahlen" items={[
          { id: "gesperrt", label: "Gesperrt", value: stats.orders_blocked, primary: true,
            tone: stats.orders_blocked > 0 ? "danger" : "none",
            sub: stats.orders_blocked > 0 ? "im Auftragsfluss klären" : "keine Sperre",
            title: "Übergröße oder Preisabweichung — im Auftragsfluss klären.", href: "#/auftraege" },
          { id: "wartend", label: "Positionen wartend", value: stats.positions_pending, primary: true,
            sub: "auf den Sammellauf", href: "#/disposition" },
          { id: "offen", label: "Innenaufträge offen", value: stats.work_orders_open, primary: true,
            sub: `${stats.work_orders_running} in Fertigung`, href: "#/produktion" },
          { id: "manuell", label: "Positionen auf manuell", value: stats.positions_manual, primary: true,
            tone: stats.positions_manual > 0 ? "warning" : "none",
            sub: stats.positions_manual > 0 ? "Anfrage an die Technik" : "nichts offen",
            title: "Anfrage an die Technik — hier endet die Automatik." },
          { id: "auftraege", label: "Aufträge gesamt", value: stats.orders },
          { id: "portal", label: "Übernahmen aus dem Portal", value: stats.orders_portal,
            sub: stats.last_portal_sync_at ? `zuletzt ${fmtDateTime(stats.last_portal_sync_at)}` : "noch keine" },
          { id: "laeufe", label: "Sammelläufe (30 Tage)", value: stats.runs_30d },
          // Ohne Sammellauf gibt es nichts zu rechnen (unbekannt); mit Läufen ist 0 m² ein echtes Ergebnis.
          { id: "flaeche", label: "Gesparte Fläche (30 Tage)", value: stats.runs_30d > 0 ? de1(stats.saved_area_m2_30d) : null, unit: "m²",
            sub: stats.saved_pct_30d > 0 ? `${stats.saved_pct_30d} % gegen einzeln geschnitten` : "noch keine Ersparnis" },
          { id: "werkstoffe", label: "Aktive Werkstoffe", value: stats.products, href: "#/werkstoffe" },
          { id: "preise", label: "Preise ohne Fundstelle", value: stats.unverified_prices,
            tone: stats.unverified_prices > 0 ? "warning" : "none",
            sub: stats.unverified_prices > 0 ? "sichtbar, aber nicht belegt" : undefined, href: "#/werkstoffe" },
          { id: "benutzer", label: "Benutzer aktiv", value: stats.users_active,
            sub: `von ${stats.users} · ${stats.admins} Admin` },
        ]} />
      </section>
    </div>
  );
}

// --------------------------------------------------------------------------
// Betriebsparameter — nach Zuständigkeit gruppiert, vor dem Senden geprüft
// --------------------------------------------------------------------------

const SETTING_GROUPS: { title: string; hint: string; match: (k: string) => boolean }[] = [
  {
    title: "Sammellauf",
    hint: "Takt, Betriebsart und die Schwellen, nach denen wartende Positionen freigegeben werden.",
    match: (k) => k.startsWith("batch_"),
  },
  {
    title: "Schachtelung (Fertigung)",
    hint: "Abstände, Beschnitt und Suchvorgaben der Werkstatt-Planung. „Leer“ heißt: Wert des "
        + "Werkstoffs bzw. Vorgabe des Rechenkerns — etwas anderes als 0. Kein Wert hier geht in einen Preis ein.",
    match: (k) => k.startsWith("nest_"),
  },
  {
    title: "Maßbeschränkungen (Portal)",
    hint: "Was das Bestellportal als zu groß oder zu dünn zurückweist. Leer = keine Beschränkung.",
    match: (k) => k.startsWith("limit_"),
  },
  {
    title: "Nummernkreise",
    hint: "Präfixe der Auftrags-, Innenauftrags-, Sammellauf- und Kundennummern.",
    match: (k) => k.endsWith("_prefix"),
  },
  {
    title: "Sonstiges",
    hint: "",
    match: () => true,
  },
];

// Dieselben Grenzen, die der Server anlegt (routers/admin.py: _check_setting) —
// hier nur, damit der falsche Wert gar nicht erst losgeschickt wird. Streit-
// entscheid bleibt der Server.
const RANGE: Record<string, [number, number]> = {
  batch_interval_minutes: [1, 10_080],
  batch_min_parts: [1, 10_000],
  batch_min_utilisation: [0, 1],
  batch_max_age_minutes: [0, 43_200],
  batch_due_lead_hours: [0, 720],
  batch_max_plates_per_run: [0, 500],
  batch_max_orders_per_work_order: [0, 100],
  batch_max_plates_per_work_order: [0, 200],
  nest_trim_w_mm: [0, 500],
  nest_trim_h_mm: [0, 500],
  nest_max_ms: [10, 600_000],
  nest_max_candidates: [1, 5],
  nest_corner_max_mm: [50, 10_000],
  nest_kerf_steps: [4, 5000],
  nest_kerf_stall: [0, 5000],
  nest_kerf_cell: [0.25, 100],
  nest_kerf_seed: [1, 4_294_967_295],
  delivery_days: [0, 60],
};
const EMPTY_OK = new Set([
  "nest_gap_mm", "nest_margin_mm", "nest_max_ms", "nest_max_candidates", "nest_corner_max_mm",
  "nest_kerf_steps", "nest_kerf_cell",
  "limit_max_od", "limit_min_od", "limit_min_web", "limit_min_corner",
  "limit_max_plate_w", "limit_max_plate_h",
]);

function validateSetting(key: string, value: string): string | null {
  const t = value.trim();
  const x = t === "" ? NaN : Number(value);
  if (EMPTY_OK.has(key) && t === "") return null;
  if (key === "batch_mode") {
    const v = t.toLowerCase();
    return v === "sammel" || v === "sofort" ? null : "Betriebsart ist „sammel“ oder „sofort“.";
  }
  if (key.endsWith("_prefix")) {
    return t.length >= 1 && t.length <= 20 ? null : "Präfix zwischen 1 und 20 Zeichen.";
  }
  if (key === "limit_max_od" || key === "limit_min_od"
      || key === "limit_max_plate_w" || key === "limit_max_plate_h") {
    return Number.isFinite(x) && x > 0
      ? null : "Muss größer als 0 sein — oder leer für keine Beschränkung.";
  }
  if (key === "limit_min_web" || key === "limit_min_corner") {
    return Number.isFinite(x) && x >= 0
      ? null : "Darf nicht negativ sein — oder leer für den Wert des Werkstoffs.";
  }
  if (key === "nest_gap_mm" || key === "nest_margin_mm") {
    const max = key === "nest_gap_mm" ? 200 : 300;
    return Number.isFinite(x) && x >= 0 && x <= max
      ? null : `Zwischen 0 und ${max} mm — oder leer für den Wert des Werkstoffs.`;
  }
  const r = RANGE[key];
  if (r) {
    if (!Number.isFinite(x)) return "Muss eine Zahl sein.";
    if (x < r[0] || x > r[1]) {
      return `Zwischen ${r[0].toLocaleString("de-DE")} und ${r[1].toLocaleString("de-DE")}.`;
    }
  }
  return null; // unbekannter Schlüssel — das Urteil hat der Server
}

const BOOLEAN_KEYS = new Set([
  "batch_enabled", "batch_mixed_formats",
  "nest_allow_rotation", "nest_allow_mirror", "nest_kerf_refine",
]);

function SettingsPanel() {
  const [rows, setRows] = useState<SettingRow[] | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try { setRows(await api<SettingRow[]>("/api/admin/settings")); }
    catch (e: any) { toastError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (r: SettingRow) => {
    const value = edit[r.key];
    if (value === undefined || value === r.value) return;
    setBusy(r.key);
    try {
      await api(`/api/admin/settings/${encodeURIComponent(r.key)}`, {
        method: "PUT", body: JSON.stringify({ value }),
      });
      toastSuccess(`${r.key} auf „${value}“ gesetzt.`);
      setEdit((e) => { const n = { ...e }; delete n[r.key]; return n; });
      load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(""); }
  };

  const revert = (key: string) => {
    setEdit((e) => { const n = { ...e }; delete n[key]; return n; });
  };

  if (!rows) return <Spinner size={30} />;
  if (!rows.length) return <p className="sub">Keine Parameter hinterlegt.</p>;

  // Jeder Schlüssel in genau eine Gruppe: „Sonstiges“ fängt nur, was keine
  // frühere Gruppe genommen hat.
  const taken = new Set<string>();
  const sections = SETTING_GROUPS
    .map((g) => {
      const inGroup = rows.filter((r) => !taken.has(r.key) && g.match(r.key));
      inGroup.forEach((r) => taken.add(r.key));
      return { g, inGroup };
    })
    .filter((s) => s.inGroup.length > 0);

  return (
    <div>
      <Toolbar end={<InfoHint
        label="Hinweis zu Betriebsparametern"
        text="Diese Werte steuern den laufenden Betrieb — der Takt des Sammellaufs hängt daran. Jede Änderung wird im Protokoll vermerkt."
      />} />
      {sections.map(({ g, inGroup }) => (
        <div key={g.title} style={{ marginBottom: 28 }}>
          <h2 style={{ marginBottom: 10 }}>
            {g.title}
            {g.hint && <InfoHint text={g.hint} label={`Hinweis zu ${g.title}`} title={g.title} />}
          </h2>
          <SettingsTable rows={inGroup} edit={edit} setEdit={setEdit}
                         busy={busy} onSave={save} onRevert={revert} />
        </div>
      ))}
    </div>
  );
}

function SettingsTable({ rows, edit, setEdit, busy, onSave, onRevert }: {
  rows: SettingRow[];
  edit: Record<string, string>;
  setEdit: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  busy: string;
  onSave: (r: SettingRow) => void;
  onRevert: (key: string) => void;
}) {
  return (
    <div className="table-scroll">
    <HTMLTable className="data-table" striped compact>
      <thead>
        <tr><th>Schlüssel</th><th>Wert</th><th>Bedeutung</th><th>Zuletzt</th><th><span className="sr-only">Aktion</span></th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const value = edit[r.key] ?? r.value;
          const dirty = value !== r.value;
          const invalid = validateSetting(r.key, value);
          return (
            <tr key={r.key} className={dirty ? "row-dirty" : undefined}>
              <td className="mono"><b>{r.key}</b></td>
              <td>
                {r.key === "batch_mode" ? (
                  <HTMLSelect value={value} style={{ width: 220 }}
                              onChange={(e) => {
                                const v = e.target.value;
                                setEdit((cur) => ({ ...cur, [r.key]: v }));
                              }}>
                    <option value="sammel">sammel — je Werkstoff und Dicke</option>
                    <option value="sofort">sofort — je Auftrag</option>
                  </HTMLSelect>
                ) : BOOLEAN_KEYS.has(r.key) ? (
                  <Switch checked={value.trim().toLowerCase() === "true"}
                          onChange={(e) => {
                            const v = (e.target as HTMLInputElement).checked ? "true" : "false";
                            setEdit((cur) => ({ ...cur, [r.key]: v }));
                          }} />
                ) : (
                  <div>
                    <InputGroup value={value} style={{ width: 180 }}
                                intent={dirty && invalid ? "danger" : undefined}
                                onChange={(e) => {
                                  // Wert vor dem Aktualisierer festhalten — React
                                  // gibt das Ereignis frei, bevor er läuft.
                                  const v = e.target.value;
                                  setEdit((cur) => ({ ...cur, [r.key]: v }));
                                }} />
                    {dirty && invalid && <div className="admin-set-error">{invalid}</div>}
                  </div>
                )}
              </td>
              <td className="sub">{r.note}</td>
              <td className="sub">{fmtDateTime(r.updated_at)}{r.updated_by ? ` · ${r.updated_by}` : ""}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {dirty && (
                  <>
                    <Button small minimal icon="undo" title="Verwerfen"
                            onClick={() => onRevert(r.key)} />
                    <Button small icon="floppy-disk" text="Setzen"
                            disabled={!!invalid} loading={busy === r.key}
                            onClick={() => onSave(r)} />
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </HTMLTable>
    </div>
  );
}

// --------------------------------------------------------------------------
// Protokoll — Aktionen als Filter, volle Einzelheiten auf Klick, Nachladen
// --------------------------------------------------------------------------

const AUDIT_PAGE = 300;

function AuditPanel() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [err, setErr] = useState("");
  const [actions, setActions] = useState<Array<{ action: string; count: number }>>([]);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [entityId, setEntityId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [more, setMore] = useState(true);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);

  // Filter laufen auf dem Server: die Suche erreicht damit auch Einträge,
  // die älter sind als die geladene Seite, und „Ältere laden“ blättert
  // beliebig weit zurück (before_id), statt bei 1.000 Zeilen zu enden.
  const query = useCallback((beforeId?: number) => {
    const qs = new URLSearchParams({ limit: String(AUDIT_PAGE) });
    if (action) qs.set("action", action);
    if (actor.trim()) qs.set("actor", actor.trim());
    if (entityId.trim()) qs.set("entity_id", entityId.trim());
    if (since) qs.set("since", `${since}T00:00:00`);
    if (until) qs.set("until", `${until}T23:59:59`);
    if (beforeId) qs.set("before_id", String(beforeId));
    return `/api/admin/audit?${qs.toString()}`;
  }, [action, actor, entityId, since, until]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const data = await api<AuditRow[]>(query());
      setRows(data);
      setMore(data.length === AUDIT_PAGE);
      setErr("");
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }, [query]);

  const loadOlder = async () => {
    if (!rows?.length) return;
    setBusy(true);
    try {
      const data = await api<AuditRow[]>(query(rows[rows.length - 1].id));
      setRows([...rows, ...data]);
      setMore(data.length === AUDIT_PAGE);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => {
    // Alle vorkommenden Aktionen, häufigste zuerst — auch die seltenen und alten.
    api<Array<{ action: string; count: number }>>("/api/admin/audit/actions")
      .then((a) => setActions([...a].sort((x, y) => y.count - x.count)))
      .catch(() => { /* Chips sind Komfort */ });
  }, []);

  if (err && !rows) {
    return (
      <NonIdealState icon="error" title="Protokoll nicht geladen" description={err}
        action={<Button icon="refresh" onClick={load}>Erneut versuchen</Button>} />
    );
  }
  if (!rows) return <Spinner size={30} />;

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter((a) =>
        `${a.actor} ${a.action} ${a.entity} ${a.entity_id} ${JSON.stringify(a.detail ?? {})}`
          .toLowerCase().includes(needle))
    : rows;

  const toggle = (id: number) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const pick = (a: string) => { setAction(action === a ? "" : a); setOpen({}); };
  const activeFilters = [action, actor.trim(), entityId.trim(), since, until, q.trim()]
    .filter(Boolean).length;
  const clearAll = () => {
    setAction(""); setActor(""); setEntityId(""); setSince(""); setUntil(""); setQ(""); setOpen({});
  };

  return (
    <div>
      <Toolbar
        meta={`${shown.length} von ${rows.length} geladen`}
        end={<InfoHint
          label="Hinweis zum Protokoll"
          text="Die Filter gelten auf dem Server — die Suche erreicht auch Einträge älter als die geladene Seite. Eine Zeile anklicken zeigt die vollen Einzelheiten."
        />}
      >
        <FilterPopover active={activeFilters} onClear={clearAll}>
          <FilterGroup label="Wer (E-Mail)">
            <InputGroup leftIcon="person" placeholder="Wer (E-Mail)" value={actor}
                        aria-label="Nach Person filtern" onChange={(e) => setActor(e.target.value)} />
          </FilterGroup>
          <FilterGroup label="Betreff-Nr.">
            <InputGroup leftIcon="tag" placeholder="z. B. Benutzer-ID, Auftrag" value={entityId}
                        aria-label="Nach Betreff filtern" onChange={(e) => setEntityId(e.target.value)} />
          </FilterGroup>
          <FilterGroup label="Von">
            <InputGroup type="date" value={since} aria-label="Von" onChange={(e) => setSince(e.target.value)} />
          </FilterGroup>
          <FilterGroup label="Bis">
            <InputGroup type="date" value={until} aria-label="Bis" onChange={(e) => setUntil(e.target.value)} />
          </FilterGroup>
          <FilterGroup label="In den geladenen Zeilen">
            <InputGroup leftIcon="search" placeholder="Suchen…" value={q}
                        aria-label="In den geladenen Zeilen suchen" onChange={(e) => setQ(e.target.value)} />
          </FilterGroup>
          <div className="ui-filter-group">
            <label>Aktion</label>
            <div className="ui-filter-chips">
              <Tag minimal interactive active={action === ""} onClick={() => pick("")}>Alle</Tag>
              {actions.map((a) => (
                <Tag key={a.action} minimal interactive active={action === a.action} onClick={() => pick(a.action)}>
                  {a.action} <span className="sub">{a.count}</span>
                </Tag>
              ))}
            </div>
          </div>
        </FilterPopover>
        {activeFilters > 0 && (
          <div className="ui-filter-chips">
            {action && <FilterTag label={`Aktion: ${action}`} onRemove={() => pick("")} />}
            {actor.trim() && <FilterTag label={`Wer: ${actor.trim()}`} onRemove={() => setActor("")} />}
            {entityId.trim() && <FilterTag label={`Betreff: ${entityId.trim()}`} onRemove={() => setEntityId("")} />}
            {since && <FilterTag label={`Von ${since}`} onRemove={() => setSince("")} />}
            {until && <FilterTag label={`Bis ${until}`} onRemove={() => setUntil("")} />}
            {q.trim() && <FilterTag label={`Suche: ${q.trim()}`} onRemove={() => setQ("")} />}
          </div>
        )}
      </Toolbar>

      <div className="table-scroll">
      <HTMLTable className="data-table" striped compact>
        <thead><tr><th>Zeit</th><th>Wer</th><th>Aktion</th><th>Betreff</th><th>Einzelheiten</th></tr></thead>
        <tbody>
          {shown.map((a) => {
            const detail = a.detail && Object.keys(a.detail).length ? a.detail : null;
            const raw = detail ? JSON.stringify(detail, null, 2) : "";
            return (
              <Fragment key={a.id}>
                <tr onClick={() => toggle(a.id)}>
                  <td className="sub">{fmtDateTime(a.at)}</td>
                  <td>{a.actor || "—"}</td>
                  <td><Tag minimal>{a.action}</Tag></td>
                  <td className="mono">{a.entity} {a.entity_id}</td>
                  <td className="sub detail-cell">
                    {detail ? `${Object.keys(detail).length} Felder` : "—"}
                  </td>
                </tr>
                {open[a.id] && (
                  <tr>
                    <td colSpan={5} style={{ padding: "0 12px 8px" }}>
                      {detail ? (
                        <HintDetails title="Rohdaten (JSON)">
                          <CopyButton text={raw} />
                          <pre className="ui-json">{raw}</pre>
                        </HintDetails>
                      ) : <p className="sub" style={{ margin: "8px 0 0" }}>Keine Einzelheiten.</p>}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </HTMLTable>
      </div>

      <Toolbar
        meta={more ? `je ${AUDIT_PAGE} Einträge` : "Das ist der älteste passende Eintrag."}
        end={<Button icon="chevron-down" loading={busy} disabled={!more} onClick={loadOlder} text="Ältere laden" />}
      />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!navigator.clipboard) { toastError("Kopieren nicht möglich."); return; }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { toastError("Kopieren nicht möglich."); }
  };
  return <Button small minimal icon={copied ? "tick" : "duplicate"}
                 text={copied ? "Kopiert" : "Kopieren"} onClick={copy} />;
}

// --------------------------------------------------------------------------
// Ereignisstrom — Server-Sent Events. Er sagt, dass im Betrieb gerade etwas
// passiert, ohne dass jemand eine Liste neu lädt: ein Sammellauf startet, eine
// Platte wird fertig gemeldet, ein Auftrag geht ein.
// --------------------------------------------------------------------------

interface Ev {
  id: number; type: string; ts: string | null;
  data: Record<string, unknown> | null; raw: string;
}

const EVENT_LABELS: Record<string, string> = {
  order_created: "Auftrag angelegt",
  order_release: "Auftrag freigegeben",
  order_done_toggle: "Auftrag fertig gemeldet",
  work_order_status: "Innenauftrag-Status",
  plate_status: "Platte gemeldet",
  batch_run: "Sammellauf",
  setting_update: "Parameter geändert",
};

const EVENT_INTENT: Record<string, Intent> = {
  order_created: "primary",
  order_release: "primary",
  order_done_toggle: "success",
  plate_status: "success",
  setting_update: "warning",
};

const fmtVal = (v: unknown) =>
  typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);

function EventsPanel() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [conn, setConn] = useState(0); // Neuaufbau der Verbindung erzwingen
  const nextId = useRef(1);

  useEffect(() => {
    // EventSource schickt keine Kopfzeilen: der Strom öffnet sich mit einem
    // Einmal-Ticket (eine Minute gültig), das der angemeldete Client holt.
    // Bricht die Verbindung ab, gibt es nach drei Sekunden ein neues Ticket —
    // EventSource selbst würde mit dem abgelaufenen ins Leere wiederholen.
    setState("connecting");
    let es: EventSource | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    api<{ ticket: string }>("/api/admin/events/ticket", { method: "POST" })
      .then(({ ticket }) => {
        if (stopped) return;
        es = new EventSource("/api/admin/events?ticket=" + encodeURIComponent(ticket));
        es.onopen = () => setState("open");
        es.onerror = () => {
          es?.close();
          setState("closed");
          if (!stopped) retry = setTimeout(() => setConn((c) => c + 1), 3000);
        };
        es!.onmessage = (e) => {
          if (pausedRef.current) return; // Pause: weiterhören, nichts anzeigen
          let type = "";
          let data: Record<string, unknown> | null = null;
          let ts: string | null = null;
          try {
            const p = JSON.parse(e.data) as { event?: string; data?: Record<string, unknown>; ts?: string };
            type = p.event ?? "";
            data = p.data ?? {};
            ts = p.ts ?? null;
          } catch { /* Fremdformat — roh zeigen */ }
          const id = nextId.current++;
          setEvents((cur) => [{ id, type, ts, data, raw: e.data }, ...cur].slice(0, 200));
        };
      })
      .catch(() => setState("closed"));
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [conn]);

  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  };

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? events.filter((ev) => `${EVENT_LABELS[ev.type] ?? ev.type} ${ev.raw}`.toLowerCase().includes(needle))
    : events;

  return (
    <div>
      <Callout compact icon={state === "closed" ? "offline" : "feed"}
               intent={state === "open" ? "success" : state === "connecting" ? "primary" : "warning"}
               title={state === "open" ? "Verbunden — Ereignisse laufen ein"
                       : state === "connecting" ? "Verbinde…" : "Getrennt"}
               className="mb">
        {paused && "Angehalten: während der Pause wird nichts angezeigt."}
      </Callout>

      <Toolbar
        meta={`${shown.length} von ${events.length}`}
        end={<InfoHint
          label="Hinweis zum Ereignisstrom"
          text="Der Strom meldet, was im Betrieb gerade geschieht. Er ersetzt kein Protokoll — was bleiben muss, steht im Reiter „Protokoll“."
        />}
      >
        <FilterPopover active={q.trim() ? 1 : 0} onClear={() => setQ("")}>
          <FilterGroup label="In den Ereignissen suchen">
            <InputGroup leftIcon="search" placeholder="Filtern…" value={q}
                        aria-label="Ereignisse filtern" onChange={(e) => setQ(e.target.value)} />
          </FilterGroup>
          <FilterGroup label="Steuerung">
            <div className="ui-inline-actions">
              <Button small icon={paused ? "play" : "pause"} onClick={togglePause}>
                {paused ? "Fortsetzen" : "Anhalten"}
              </Button>
              <Button small icon="delete" text="Leeren" disabled={!events.length}
                      onClick={() => { setEvents([]); setOpen({}); }} />
              {state === "closed" && (
                <Button small intent="primary" icon="refresh" onClick={() => setConn((c) => c + 1)}>
                  Neu verbinden
                </Button>
              )}
            </div>
          </FilterGroup>
        </FilterPopover>
        {q.trim() && <FilterTag label={`Suche: ${q.trim()}`} onRemove={() => setQ("")} />}
      </Toolbar>

      {shown.length === 0 ? <p className="sub">Noch nichts gemeldet.</p> : (
        <div className="table-scroll">
        <HTMLTable className="data-table" striped compact>
          <thead>
            <tr><th style={{ width: 150 }}>Zeit</th><th style={{ width: 200 }}>Ereignis</th><th>Daten</th></tr>
          </thead>
          <tbody>
            {shown.map((ev) => (
              <Fragment key={ev.id}>
                <tr onClick={() => setOpen((o) => ({ ...o, [ev.id]: !o[ev.id] }))}>
                  <td className="mono sub">{fmtDateTime(ev.ts)}</td>
                  <td>
                    <Tag minimal intent={EVENT_INTENT[ev.type] ?? "none"}>
                      {EVENT_LABELS[ev.type] ?? (ev.type || "unbekannt")}
                    </Tag>
                  </td>
                  <td className="mono detail-cell">
                    {ev.data && Object.keys(ev.data).length
                      ? Object.entries(ev.data).map(([k, v]) => `${k}=${fmtVal(v)}`).join(" · ")
                      : "—"}
                  </td>
                </tr>
                {open[ev.id] && (
                  <tr>
                    <td colSpan={3} style={{ padding: "0 12px 8px" }}>
                      <HintDetails title="Rohdaten (JSON)">
                        <CopyButton text={ev.raw} />
                        <pre className="ui-json">{ev.raw}</pre>
                      </HintDetails>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </HTMLTable>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// GitHub Release Updates — /api/updates/status & /api/updates/apply
// --------------------------------------------------------------------------

interface UpdateStatusData {
  repo: string;
  current_version: string;
  latest_version: string | null;
  latest_tag: string | null;
  update_available: boolean;
  install_kind: "binary" | "docker" | "git" | "package";
  checked_at: number;
  release_name: string;
  release_notes: string;
  release_url: string;
  published_at: string;
  matched_asset: { name: string; download_url: string; size: number } | null;
  error: string;
}

interface UpdateApplyData {
  ok: boolean;
  install_kind: string;
  from_version: string;
  to_version: string;
  restart_required: boolean;
  restarting?: boolean;
  detail: string;
  command_hint: string;
}

const INSTALL_KIND_LABEL: Record<string, string> = {
  binary: "Standalone-Programm",
  docker: "Docker-Container",
  git: "Git-Checkout",
  package: "Python-Paket",
};

function UpdatesPanel() {
  const [info, setInfo] = useState<UpdateStatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [result, setResult] = useState<UpdateApplyData | null>(null);
  const pollRef = useRef<number | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPoll(), [stopPoll]);

  const waitForRestart = useCallback((targetVersion?: string) => {
    setRestarting(true);
    let sawDown = false;
    let ticks = 0;
    stopPoll();
    pollRef.current = window.setInterval(async () => {
      ticks += 1;
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        if (r.ok) {
          const v = (await r.json()) as { version?: string };
          if ((targetVersion && v.version === targetVersion) || (sawDown && ticks >= 2)) {
            stopPoll();
            window.location.reload();
          }
        }
      } catch {
        sawDown = true;
      }
      if (ticks >= 60) {
        stopPoll();
        setRestarting(false);
      }
    }, 1000);
  }, [stopPoll]);

  const check = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const data = await api<UpdateStatusData>(`/api/updates/status${force ? "?force=true" : ""}`);
      setInfo(data);
    } catch (e: any) {
      toastError(e.message ?? "Update-Prüfung fehlgeschlagen.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { check(false); }, [check]);

  const apply = async () => {
    if (!info) return;
    setApplying(true);
    setResult(null);
    try {
      const res = await api<UpdateApplyData>("/api/updates/apply", {
        method: "POST",
        body: JSON.stringify({ tag: info.latest_tag, rebuild_web: true, auto_restart: true }),
      });
      setResult(res);
      if (res.ok && res.restarting) {
        toastSuccess(`Update auf v${res.to_version} abgeschlossen — Gimel startet automatisch neu…`);
        waitForRestart(res.to_version);
      } else if (res.ok) {
        toastSuccess(res.detail || "Update abgeschlossen.");
        check(true);
      } else {
        toastError(res.detail || "Update nicht automatisch anwendbar.");
      }
    } catch (e: any) {
      toastError(e.message ?? "Update fehlgeschlagen.");
    } finally {
      setApplying(false);
    }
  };

  if (restarting) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 20 }}>
        <Spinner size={30} />
        <div>
          <strong>Gimel startet automatisch neu…</strong>
          <div className="sub" style={{ marginTop: 4 }}>
            Die neue Version wird geladen. Diese Seite lädt in wenigen Sekunden von selbst neu.
          </div>
        </div>
      </div>
    );
  }

  if (!info && loading) return <Spinner size={28} />;
  if (!info) {
    return (
      <NonIdealState
        icon="cloud-download"
        title="Update-Status nicht geladen"
        action={<Button icon="refresh" text="Erneut prüfen" onClick={() => check(true)} />}
      />
    );
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <Toolbar
        meta={
          <span className="sub">
            Quelle: <span className="mono">github.com/{info.repo}</span> ·{" "}
            {INSTALL_KIND_LABEL[info.install_kind] ?? info.install_kind}
          </span>
        }
        end={
          <div style={{ display: "flex", gap: 8 }}>
            <Button icon="refresh" text="Auf Updates prüfen" loading={loading} onClick={() => check(true)} />
            {info.release_url && (
              <a className="bp5-button" href={info.release_url} target="_blank" rel="noreferrer">
                GitHub Releases
              </a>
            )}
          </div>
        }
      />

      {info.error ? (
        <Callout intent="warning" title="Hinweis zur Update-Prüfung">
          {info.error}
        </Callout>
      ) : info.update_available ? (
        <Callout intent="primary" title={`Neues Release verfügbar: ${info.latest_tag}`}>
          <p style={{ marginTop: 4 }}>
            Installiert: <b className="mono">v{info.current_version}</b> → Neu:{" "}
            <b className="mono">{info.latest_tag}</b>
            {info.published_at ? ` (${fmtDateTime(info.published_at)})` : ""}
          </p>
          {info.install_kind === "binary" && info.matched_asset ? (
            <p className="sub" style={{ marginTop: 4 }}>
              Paket: <span className="mono">{info.matched_asset.name}</span>{" "}
              ({(info.matched_asset.size / (1024 * 1024)).toFixed(1)} MB)
            </p>
          ) : info.install_kind === "git" && info.latest_tag ? (
            <p className="sub" style={{ marginTop: 4 }}>
              Aktualisierung per Git-Tag <span className="mono">{info.latest_tag}</span> (Checkout, Abhängigkeiten &amp; Build)
            </p>
          ) : null}
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              intent="primary"
              icon="cloud-download"
              text={info.install_kind === "docker" ? "Update-Befehl anzeigen" : `Auf ${info.latest_tag} aktualisieren & neu starten`}
              loading={applying}
              onClick={apply}
            />
          </div>
        </Callout>
      ) : (
        <Callout intent="success" title={`Gimel v${info.current_version} ist aktuell`}>
          Neuestes GitHub Release: <b className="mono">{info.latest_tag ?? `v${info.current_version}`}</b>.
        </Callout>
      )}

      {result && (
        <Callout
          intent={result.ok ? "success" : "warning"}
          title={result.ok ? "Update angewendet" : "Manueller Schritt erforderlich"}
          style={{ marginTop: 12 }}
        >
          <p style={{ marginTop: 4 }}>{result.detail}</p>
          {result.command_hint && (
            <pre className="ui-json" style={{ marginTop: 8 }}>{result.command_hint}</pre>
          )}
        </Callout>
      )}

      {info.release_notes && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 6 }}>Release Notes ({info.release_name || info.latest_tag})</h3>
          <pre className="ui-json" style={{ whiteSpace: "pre-wrap" }}>{info.release_notes}</pre>
        </div>
      )}
    </div>
  );
}
