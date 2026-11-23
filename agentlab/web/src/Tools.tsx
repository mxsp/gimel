import {
  Button, ButtonGroup, Dialog, DialogBody, DialogFooter, FormGroup, Spinner, Tag, TextArea,
} from "@blueprintjs/core";
import { useEffect, useMemo, useState } from "react";
import { ApiError, invokeTool, JsonSchema, listTools, ToolInfo } from "./api";
import { toolLabel } from "./toolLabels";

type Filter = "all" | "read" | "write" | "irreversible";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Alle" },
  { id: "read", label: "Lesen" },
  { id: "write", label: "Schreiben" },
  { id: "irreversible", label: "Nicht rückholbar" },
];

/** Reihenfolge der Bereiche; was hier fehlt, kommt alphabetisch dahinter. */
const CATEGORY_ORDER = [
  "Vorschau & Dateien", "Container & Sandbox", "Analyse", "Aufträge", "Fertigung", "Zwilling",
  "Halle & Stationen", "Lager & Werkstoffe", "Versand",
  "Kunden", "Rechnungen", "Roboter", "Konten", "Compliance", "Einstellungen & Protokoll", "Web",
  "Sonstiges",
];

const OPEN_KEY = "agentlab-tool-groups";

type LastRun = { args: string; result: string; ok: boolean; at: string; durationMs?: number };

function readJson<T>(storage: () => Storage, key: string, fallback: T): T {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage: () => Storage, key: string, value: unknown): void {
  try { storage().setItem(key, JSON.stringify(value)); } catch { /* egal */ }
}

/** Ein Platzhalter je Feldtyp — sichtbar leer, aber typrichtig. */
export function exampleValue(schema: JsonSchema | undefined, name = ""): unknown {
  const type = schema?.type;
  if (type === "integer" || type === "number") {
    if (/limit/.test(name)) return 10;
    if (/days/.test(name)) return 30;
    if (/(^|_)(qty|q|count|robots)$/.test(name)) return 1;
    return type === "integer" ? 1 : 1.0;
  }
  if (type === "boolean") return false;
  if (type === "array") {
    const item = schema?.items;
    if (item?.type === "object") return [exampleObject(item)];
    if (item?.type === "number" || item?.type === "integer") return [];
    return [];
  }
  if (type === "object") return schema?.properties ? exampleObject(schema) : {};
  return "";
}

/** Pflichtfelder zuerst; Arrays von Objekten bekommen ein Musterelement. */
export function exampleObject(schema: JsonSchema | undefined, all = false): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const keys = Object.keys(props).filter((key) => all || required.has(key));
  keys.sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = exampleValue(props[key], key);
  return out;
}

const TYPE_DE: Record<string, string> = {
  string: "Text", integer: "Ganzzahl", number: "Zahl", boolean: "ja/nein",
  object: "Objekt", array: "Liste",
};

function typeText(schema: JsonSchema): string {
  const base = TYPE_DE[schema.type ?? ""] ?? "beliebig";
  if (schema.type === "array" && schema.items?.type) return `${base} (${TYPE_DE[schema.items.type] ?? schema.items.type})`;
  return base;
}

function SchemaTable({ schema }: { schema?: JsonSchema }) {
  const props = Object.entries(schema?.properties ?? {});
  if (!props.length) return <p className="tool-schema-empty">Keine Argumente.</p>;
  const required = new Set(schema?.required ?? []);
  return (
    <table className="tool-schema">
      <caption className="tool-schema-caption">* Pflichtfeld</caption>
      <thead><tr><th>Feld</th><th>Typ</th><th>Hinweis</th></tr></thead>
      <tbody>
        {props.map(([name, field]) => (
          <tr key={name}>
            <td><code>{name}</code>{required.has(name) && <span className="tool-req" title="Pflichtfeld"> *</span>}</td>
            <td>{typeText(field)}</td>
            <td>
              {field.description ?? ""}
              {field.items?.properties && (
                <span className="tool-schema-sub">
                  {" "}Felder: {Object.keys(field.items.properties).join(", ")}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Tools({
  chatId, writeMode, onChanged,
}: {
  chatId: number | null;
  writeMode: boolean;
  onChanged: () => void;
}) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<ToolInfo | null>(null);
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState("");
  const [running, setRunning] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>(
    () => readJson(() => localStorage, OPEN_KEY, {} as Record<string, boolean>),
  );
  // Nur im Speicher dieser Ansicht: Ergebnisse können Kunden und Preise
  // enthalten und dürfen an einem geteilten Rechner keine Abmeldung überleben.
  const [last, setLast] = useState<Record<string, LastRun>>({});

  useEffect(() => {
    listTools()
      .then((data) => setTools(data.tools))
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const visible = useMemo(() => tools.filter((tool) => {
    if (filter === "read" && tool.write) return false;
    if (filter === "write" && !tool.write) return false;
    if (filter === "irreversible" && !(tool.write && !tool.reversible)) return false;
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return tool.name.toLowerCase().includes(needle)
      || toolLabel(tool.name).toLowerCase().includes(needle)
      || tool.description.toLowerCase().includes(needle)
      || (tool.category ?? "").toLowerCase().includes(needle);
  }), [tools, filter, search]);

  const groups = useMemo(() => {
    const map = new Map<string, ToolInfo[]>();
    for (const tool of visible) {
      const key = tool.category || "Sonstiges";
      map.set(key, [...(map.get(key) ?? []), tool]);
    }
    const rank = (name: string) => {
      const i = CATEGORY_ORDER.indexOf(name);
      return i < 0 ? CATEGORY_ORDER.length : i;
    };
    return Array.from(map, ([name, items]) => ({
      name,
      items: items.sort((a, b) => Number(a.write) - Number(b.write)
        || toolLabel(a.name).localeCompare(toolLabel(b.name), "de")),
    })).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "de"));
  }, [visible]);

  const counts = useMemo(() => ({
    read: tools.filter((t) => !t.write).length,
    write: tools.filter((t) => t.write).length,
  }), [tools]);

  const searching = search.trim().length > 0;
  const isOpen = (name: string) => searching || open[name] !== false;
  const toggleGroup = (name: string) => {
    const next = { ...open, [name]: !isOpen(name) };
    setOpen(next);
    writeJson(() => localStorage, OPEN_KEY, next);
  };
  const setAll = (value: boolean) => {
    const next = Object.fromEntries(groups.map((g) => [g.name, value]));
    setOpen(next);
    writeJson(() => localStorage, OPEN_KEY, next);
  };

  const openDialog = (tool: ToolInfo) => {
    setDraft(tool);
    const previous = last[tool.name];
    setArgs(previous?.args ?? JSON.stringify(exampleObject(tool.parameters), null, 2));
    setResult(previous?.result ?? "");
    setError("");
  };

  const fillExample = (all: boolean) => {
    if (!draft) return;
    setArgs(JSON.stringify(exampleObject(draft.parameters, all), null, 2));
  };

  const run = async () => {
    if (!draft || chatId == null) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Objekt erwartet");
      }
    } catch {
      setError("Argumente müssen ein JSON-Objekt sein, z. B. {\"order_no\": \"AB-26-0001\"}.");
      return;
    }
    setRunning(true);
    setError("");
    setResult("");
    const remember = (text: string, ok: boolean, durationMs: number) => {
      const next = { ...last, [draft.name]: { args, result: text, ok, at: new Date().toISOString(), durationMs } };
      setLast(next);
    };
    const started = performance.now();
    try {
      const data = await invokeTool(chatId, draft.name, parsed);
      const text = JSON.stringify(data, null, 2);
      setResult(text);
      remember(text, true, Math.round(performance.now() - started));
      onChanged();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setError(message);
      remember(message, false, Math.round(performance.now() - started));
    } finally {
      setRunning(false);
    }
  };

  const irreversible = !!draft && draft.write && !draft.reversible;

  const disabledReason = (tool: ToolInfo): string | undefined => {
    if (!tool.allowed) return "Keine Berechtigung für dieses Werkzeug";
    if (!tool.available) return "Websuche in den Einstellungen einschalten";
    if (tool.write && !writeMode) return "Schreibmodus im Chat einschalten";
    if (chatId == null) return "Erst einen Chat anlegen";
    return undefined;
  };

  return (
    <div className="lab-page">
      <h2>Werkzeuge</h2>
      <p className="sub">
        Der Assistent kann nur diese typisierten Aktionen ausführen
        {loading ? "" : `: ${counts.read} lesen, ${counts.write} schreiben`}. Jedes Werkzeug lässt sich hier mit eigenen Argumenten testen;
        schreibende nur mit eingeschaltetem Schreibmodus.
      </p>
      <div className="tool-toolbar">
        <input className="bp5-input" placeholder="Werkzeug, Bereich oder Text suchen" value={search}
          onChange={(e) => setSearch(e.target.value)} aria-label="Werkzeug suchen" />
        <ButtonGroup className="tool-filter" aria-label="Art der Werkzeuge">
          {FILTERS.map((item) => (
            <Button key={item.id} small text={item.label} active={filter === item.id}
              aria-pressed={filter === item.id} onClick={() => setFilter(item.id)} />
          ))}
        </ButtonGroup>
        <Tag minimal>{loading ? "…" : `${visible.length} sichtbar`}</Tag>
        <Tag minimal intent={writeMode ? "warning" : "none"}>
          {writeMode ? "Schreibmodus an" : "nur lesend"}
        </Tag>
        <span style={{ flex: 1 }} />
        {!searching && groups.length > 1 && (
          <>
            <Button small minimal text="Alle auf" onClick={() => setAll(true)} />
            <Button small minimal text="Alle zu" onClick={() => setAll(false)} />
          </>
        )}
        {chatId == null && <Tag minimal intent="danger">Kein Chat für Tests</Tag>}
      </div>
      {error && !draft && <div className="login-card banner-bad" style={{ width: "auto" }}>{error}</div>}
      {loading ? <Spinner size={28} /> : (
        <div className="tool-groups">
          {groups.map((group) => {
            const groupOpen = isOpen(group.name);
            const writes = group.items.filter((t) => t.write).length;
            return (
              <section className="tool-group" key={group.name}>
                <button type="button" className="tool-group-head" aria-expanded={groupOpen}
                  disabled={searching} title={searching ? "Bei aktiver Suche sind alle Bereiche offen" : undefined}
                  onClick={() => toggleGroup(group.name)}>
                  <span className={`tool-group-caret ${groupOpen ? "is-open" : ""}`} aria-hidden="true">▸</span>
                  <span className="tool-group-name">{group.name}</span>
                  <span className="tool-group-count">
                    {group.items.length}{writes ? ` · ${writes} schreibend` : ""}
                  </span>
                </button>
                {groupOpen && (
                  <div className="tool-list">
                    {group.items.map((tool) => {
                      const reason = disabledReason(tool);
                      const showSchema = expanded === tool.name;
                      const previous = last[tool.name];
                      return (
                        <div className="tool-list-row" key={tool.name}>
                          <div className="tool-row-head">
                            <span className="name">{toolLabel(tool.name)}</span>
                            {toolLabel(tool.name) !== tool.name && <code className="tool-raw-name">{tool.name}</code>}
                            {tool.write
                              ? <Tag minimal intent="warning">schreibt</Tag>
                              : <Tag minimal intent="primary">liest</Tag>}
                            {tool.write && <Tag minimal intent={tool.reversible ? "success" : "danger"}>
                              {tool.reversible ? "rückholbar" : "nicht rückholbar"}
                            </Tag>}
                            {tool.admin_only && <Tag minimal>Admin</Tag>}
                            {tool.network && <Tag minimal intent="primary">Web</Tag>}
                            {!tool.available && <Tag minimal intent="warning">Websuche aus</Tag>}
                            {!tool.allowed && <Tag minimal intent="danger">keine Berechtigung</Tag>}
                            {previous && (
                              <Tag minimal intent={previous.ok ? "success" : "danger"}
                                title={`Zuletzt getestet ${new Date(previous.at).toLocaleTimeString("de-DE")}`}>
                                {previous.ok ? "zuletzt ok" : "zuletzt Fehler"}
                              </Tag>
                            )}
                            <span className="tool-row-actions">
                              <Button small minimal icon="properties" text="Argumente"
                                className="tool-toggle" active={showSchema} aria-expanded={showSchema}
                                aria-label={`Argumente: ${toolLabel(tool.name)}`}
                                onClick={() => setExpanded(showSchema ? null : tool.name)} />
                              <Button small minimal icon="play" text="Testen"
                                disabled={!!reason} aria-label={`Testen: ${toolLabel(tool.name)}`}
                                onClick={() => openDialog(tool)} />
                            </span>
                          </div>
                          <div className="desc">{tool.description}</div>
                          {reason && tool.allowed && <div className="tool-blocked">{reason}.</div>}
                          {showSchema && <SchemaTable schema={tool.parameters} />}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
          {visible.length === 0 && <div className="empty">Keine Werkzeuge in dieser Ansicht.</div>}
        </div>
      )}

      <Dialog isOpen={!!draft} onClose={() => setDraft(null)}
        title={draft ? `Testen: ${toolLabel(draft.name)}` : "Werkzeug testen"}
        style={{ width: 680, maxWidth: "calc(100vw - 24px)" }}>
        <DialogBody>
          {draft && (
            <>
              <p style={{ marginTop: 0, color: "var(--lab-muted)" }}>{draft.description}</p>
              <details className="tool-dialog-schema">
                <summary>Argumente und Typen</summary>
                <SchemaTable schema={draft.parameters} />
              </details>
              <FormGroup label="Argumente (JSON)" labelFor="tool-args">
                <TextArea id="tool-args" fill rows={7} value={args} className="tool-args"
                  onChange={(e) => setArgs(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !irreversible) run();
                  }} />
              </FormGroup>
              <div className="tool-dialog-actions">
                <Button small icon="clean" text="Pflichtfelder einsetzen" onClick={() => fillExample(false)} />
                <Button small minimal text="Alle Felder einsetzen" onClick={() => fillExample(true)} />
                <Button small minimal text="Leeren" onClick={() => setArgs("{}")} />
                {!irreversible && <span className="tool-dialog-hint">Strg+Enter führt aus</span>}
              </div>
              {draft.write && draft.reversible && (
                <p><Tag minimal intent="warning">schreibt</Tag> <Tag minimal intent="success">rückholbar</Tag> Die Ausführung landet im Änderungsregister und lässt sich dort zurücknehmen.</p>
              )}
              {irreversible && (
                <p><Tag minimal intent="danger">nicht rückholbar</Tag> Diese Ausführung lässt sich nicht zurücknehmen und wirkt sofort auf die Daten.</p>
              )}
              {error && <div className="login-error" role="alert">{error}</div>}
              {result && (
                <FormGroup label={last[draft.name] && !running
                  ? `Ergebnis (${new Date(last[draft.name].at).toLocaleTimeString("de-DE")}${last[draft.name].durationMs != null ? ` · ${last[draft.name].durationMs} ms` : ""})`
                  : "Ergebnis"}>
                  <pre className="tool-pre" style={{ maxHeight: 320 }}>{result}</pre>
                </FormGroup>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Schließen" onClick={() => setDraft(null)} />
            <Button intent={irreversible ? "danger" : "primary"} icon="play"
              text={irreversible ? "Unwiderruflich ausführen" : "Ausführen"} onClick={run}
              loading={running} disabled={!draft || !!disabledReason(draft)} />
          </>
        } />
      </Dialog>
    </div>
  );
}
