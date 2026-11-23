import {
  Button, ButtonGroup, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, Icon,
  IconName, InputGroup, Spinner, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, Artifact, createStandaloneArtifact, deleteStandaloneArtifact,
  listAllArtifacts, updateStandaloneArtifact,
} from "./api";
import { copyToClipboard, relativeTime } from "./chatUtils";
import RichText from "./format";
import type { PreviewMode, ViewportSize } from "./PreviewPane";

const KIND_FILTERS: Array<{ id: string; label: string }> = [
  { id: "all", label: "Alle" },
  { id: "html", label: "HTML" },
  { id: "svg", label: "SVG" },
  { id: "markdown", label: "Markdown" },
  { id: "csv", label: "CSV" },
  { id: "json", label: "JSON" },
  { id: "code", label: "Code" },
];

const STARTER_CONTENT: Record<string, string> = {
  html: `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Neues Artefakt</title>
<style>
  body { margin: 0; padding: 28px; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fbfaf7; color: #28251f; }
  .box { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e6e2d8; border-radius: 14px; padding: 24px; }
  h1 { margin: 0 0 8px; color: #0b7a67; }
</style>
</head>
<body>
  <div class="box">
    <h1>Neues HTML-Artefakt</h1>
    <p>Bearbeiten Sie den Quelltext live im Modus „Geteilt“ oder „Code“.</p>
  </div>
</body>
</html>`,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 180" width="360" height="180">
  <rect width="360" height="180" rx="16" fill="#0b7a67"/>
  <circle cx="90" cy="90" r="44" fill="#e0f1ed"/>
  <text x="155" y="98" font-family="sans-serif" font-size="24" font-weight="700" fill="#ffffff">Gimel SVG</text>
</svg>`,
  markdown: `# Neues Dokument\n\n- Punkt 1\n- Punkt 2\n\n> [!NOTE]\n> Markdown-Artefakte werden direkt formatiert angezeigt.\n`,
  csv: `Kategorie;Wert;Einheit\nEPDM 70;120;Stk\nNBR 70;85;Stk\nPTFE;42;Stk\n`,
  json: `{\n  "name": "Gimel Artefakt",\n  "status": "aktiv",\n  "werte": [10, 20, 30]\n}\n`,
  code: `// Neues Code-Artefakt\nexport function hallo(name: string): string {\n  return \`Hallo \${name}\`;\n}\n`,
};

function kindIcon(kind: string): IconName {
  if (kind === "html") return "application";
  if (kind === "svg") return "media";
  if (kind === "csv") return "th";
  if (kind === "json") return "code-block";
  if (kind === "markdown") return "document";
  return "code";
}

function parseCsv(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const delim = lines[0].split(";").length > lines[0].split(",").length ? ";" : ",";
  return lines.map((line) => line.split(delim).map((c) => c.trim().replace(/^"|"$/g, "")));
}

export default function Artifacts({
  currentChatId,
  onOpenChat,
  onOpenInSidePreview,
  onCountChange,
}: {
  currentChatId: number | null;
  onOpenChat: (chatId: number) => void;
  onOpenInSidePreview: (art: Artifact) => void;
  onCountChange?: (count: number) => void;
}) {
  const [items, setItems] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<PreviewMode>("render");
  const [viewport, setViewport] = useState<ViewportSize>("desktop");
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState<{ title: string; kind: string; content: string } | null>(null);
  const [deleting, setDeleting] = useState<Artifact | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listAllArtifacts();
      setItems(data.artifacts);
      onCountChange?.(data.artifacts.length);
      setSelectedId((cur) => {
        if (cur && data.artifacts.some((a) => a.id === cur)) return cur;
        return data.artifacts[0]?.id ?? null;
      });
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => items.filter((art) => {
    if (kindFilter !== "all" && art.kind !== kindFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${art.title} ${art.filename} ${art.kind} ${art.chat_title || ""}`.toLowerCase().includes(q);
  }), [items, kindFilter, search]);

  const selected = useMemo(
    () => items.find((a) => a.id === selectedId) ?? visible[0] ?? null,
    [items, selectedId, visible],
  );

  useEffect(() => {
    if (selected) {
      setDraftContent(selected.content || "");
      setDirty(false);
    }
  }, [selected?.id, selected?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveEdit = async () => {
    if (!selected || saving) return;
    setSaving(true);
    setError("");
    try {
      const updated = await updateStandaloneArtifact(selected.id, { content: draftContent });
      setItems((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const createNew = async () => {
    if (!creating || !creating.title.trim()) return;
    setSaving(true);
    setError("");
    try {
      const created = await createStandaloneArtifact({
        title: creating.title.trim(),
        kind: creating.kind,
        content: creating.content,
        chat_id: currentChatId,
      });
      setItems((prev) => {
        const next = [created, ...prev];
        onCountChange?.(next.length);
        return next;
      });
      setSelectedId(created.id);
      setCreating(null);
      setMode("split");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setSaving(true);
    try {
      await deleteStandaloneArtifact(deleting.id);
      setItems((prev) => {
        const next = prev.filter((a) => a.id !== deleting.id);
        onCountChange?.(next.length);
        return next;
      });
      if (selectedId === deleting.id) setSelectedId(null);
      setDeleting(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const download = (art: Artifact, content: string) => {
    const mime = art.kind === "html" ? "text/html;charset=utf-8"
      : art.kind === "svg" ? "image/svg+xml;charset=utf-8"
      : art.kind === "csv" ? "text/csv;charset=utf-8"
      : art.kind === "json" ? "application/json;charset=utf-8"
      : "text/plain;charset=utf-8";
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = art.filename || `${art.title}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openNewTab = (art: Artifact, content: string) => {
    const mime = art.kind === "html" ? "text/html;charset=utf-8"
      : art.kind === "svg" ? "image/svg+xml;charset=utf-8"
      : "text/plain;charset=utf-8";
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const viewportStyle = viewport === "tablet" ? { maxWidth: 768 }
    : viewport === "mobile" ? { maxWidth: 390 }
    : undefined;

  const renderDisplay = (art: Artifact) => {
    const content = draftContent;
    const visual = () => {
      if (art.kind === "html") {
        return (
          <div className={`preview-frame-shell ${viewport !== "desktop" ? "is-framed-canvas" : ""}`}>
            <div className={`preview-viewport ${viewport !== "desktop" ? "is-framed" : ""}`} style={viewportStyle}>
              <iframe
                key={`${art.id}-${art.version}`}
                srcDoc={content}
                title={art.title}
                className="preview-iframe"
                sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
              />
            </div>
          </div>
        );
      }
      if (art.kind === "svg") {
        const doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:repeating-conic-gradient(#ece9e1 0% 25%,#fbfaf7 0% 50%) 50%/18px 18px}svg{max-width:94%;max-height:94%}</style></head><body>${content}</body></html>`;
        return <iframe srcDoc={doc} title={art.title} className="preview-iframe" sandbox="" />;
      }
      if (art.kind === "markdown") {
        return <div className="preview-md-sheet"><RichText text={content} /></div>;
      }
      if (art.kind === "csv") {
        const rows = parseCsv(content);
        const head = rows[0] ?? [];
        const body = rows.slice(1);
        return (
          <div className="preview-csv-wrap">
            <table className="preview-csv-table">
              <thead><tr>{head.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
              <tbody>{body.slice(0, 300).map((r, ri) => (
                <tr key={ri}>{head.map((_, ci) => <td key={ci}>{r[ci] ?? ""}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
        );
      }
      if (art.kind === "json") {
        let pretty = content;
        try { pretty = JSON.stringify(JSON.parse(content), null, 2); } catch { /* roh */ }
        return <pre className="preview-code-view"><code>{pretty}</code></pre>;
      }
      return <pre className="preview-code-view"><code>{content}</code></pre>;
    };

    const editor = () => (
      <textarea
        className="preview-editor"
        spellCheck={false}
        value={content}
        aria-label="Artefakt-Quelltext bearbeiten"
        onChange={(e) => { setDraftContent(e.target.value); setDirty(true); }}
      />
    );

    if (mode === "source") return editor();
    if (mode === "split") {
      return (
        <div className="preview-split-inner">
          <div className="preview-split-code">{editor()}</div>
          <div className="preview-split-render">{visual()}</div>
        </div>
      );
    }
    return visual();
  };

  return (
    <div className="artifacts-workspace">
      <aside className="artifacts-sidebar">
        <div className="artifacts-side-head">
          <div>
            <h2>Artefakte</h2>
            <span>{items.length} gespeichert</span>
          </div>
          <Button small intent="primary" icon="plus" text="Neu"
            onClick={() => setCreating({ title: "Neues Dashboard", kind: "html", content: STARTER_CONTENT.html })} />
        </div>

        <div className="artifacts-side-filters">
          <InputGroup
            leftIcon="search"
            placeholder="Artefakte durchsuchen …"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="routines-cats">
            {KIND_FILTERS.map((f) => (
              <button key={f.id} type="button"
                className={`routines-cat-pill ${kindFilter === f.id ? "is-active" : ""}`}
                onClick={() => setKindFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="chat-error" style={{ margin: "0 10px 8px" }}>{error}</div>}

        <div className="artifacts-list">
          {loading ? (
            <div className="chat-loading"><Spinner size={24} /></div>
          ) : visible.length === 0 ? (
            <div className="artifacts-empty-list">
              <strong>Noch keine Artefakte</strong>
              <p>Lassen Sie den Assistenten ein HTML-Dashboard, einen Bericht oder eine Grafik erstellen — oder klicken Sie auf „Neu“.</p>
            </div>
          ) : (
            visible.map((art) => (
              <button
                key={art.id}
                type="button"
                className={`artifact-list-item ${selected?.id === art.id ? "is-active" : ""}`}
                onClick={() => setSelectedId(art.id)}
              >
                <span className="artifact-list-icon"><Icon icon={kindIcon(art.kind)} size={15} /></span>
                <span className="artifact-list-main">
                  <strong>{art.title}</strong>
                  <span className="artifact-list-meta">
                    <Tag minimal>{art.kind.toUpperCase()}</Tag>
                    <span>v{art.version}</span>
                    <span>· {relativeTime(art.updated_at || art.created_at)}</span>
                  </span>
                  {art.chat_title && <span className="artifact-list-chat">{art.chat_title}</span>}
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className={`artifacts-stage ${expanded ? "is-expanded" : ""}`}>
        {!selected ? (
          <div className="preview-landing">
            <div className="preview-landing-icon"><Icon icon="application" size={28} /></div>
            <h3>Artefakt-Anzeige</h3>
            <p>Wählen Sie links ein Artefakt aus oder erstellen Sie ein neues HTML-, SVG-, Markdown-, CSV- oder JSON-Artefakt.</p>
            <Button intent="primary" icon="plus" text="Neues HTML-Artefakt erstellen"
              onClick={() => setCreating({ title: "Neues Dashboard", kind: "html", content: STARTER_CONTENT.html })} />
          </div>
        ) : (
          <>
            <div className="artifacts-stage-bar">
              <div className="artifacts-stage-title">
                <Icon icon={kindIcon(selected.kind)} size={15} />
                <strong>{selected.title}</strong>
                <Tag minimal intent="primary">{selected.kind.toUpperCase()}</Tag>
                <Tag minimal>v{selected.version}</Tag>
                {dirty && <Tag minimal intent="warning">ungespeichert</Tag>}
              </div>
              <div className="artifacts-stage-actions">
                <ButtonGroup minimal className="preview-seg">
                  <Button small active={mode === "render"} text="Anzeige" onClick={() => setMode("render")} />
                  <Button small active={mode === "split"} text="Geteilt" onClick={() => setMode("split")} />
                  <Button small active={mode === "source"} text="Code" onClick={() => setMode("source")} />
                </ButtonGroup>
                {selected.kind === "html" && (
                  <ButtonGroup minimal className="preview-seg">
                    <Button small active={viewport === "desktop"} icon="desktop" title="Desktop" onClick={() => setViewport("desktop")} />
                    <Button small active={viewport === "tablet"} icon="applications" title="Tablet" onClick={() => setViewport("tablet")} />
                    <Button small active={viewport === "mobile"} icon="mobile-phone" title="Mobil" onClick={() => setViewport("mobile")} />
                  </ButtonGroup>
                )}
                {dirty && (
                  <Button small intent="primary" icon="floppy-disk" text="Speichern" loading={saving} onClick={saveEdit} />
                )}
                <Button small minimal icon="chat" text="Chat" title="Ursprungs-Chat öffnen"
                  onClick={() => onOpenChat(selected.chat_id)} />
                <Button small minimal icon="drawer-right" text="Im Browser" title="Im Chat-Seitenbrowser öffnen"
                  onClick={() => onOpenInSidePreview(selected)} />
                <Button small minimal icon={copied ? "tick" : "clipboard"} title="Kopieren"
                  onClick={async () => {
                    if (await copyToClipboard(draftContent)) {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }
                  }} />
                <Button small minimal icon="download" title="Herunterladen" onClick={() => download(selected, draftContent)} />
                <Button small minimal icon="share" title="In neuem Tab öffnen" onClick={() => openNewTab(selected, draftContent)} />
                <Button small minimal icon={expanded ? "minimize" : "maximize"} title={expanded ? "Verkleinern" : "Vollbild"}
                  onClick={() => setExpanded((v) => !v)} />
                <Button small minimal icon="trash" intent="danger" title="Artefakt löschen"
                  onClick={() => setDeleting(selected)} />
              </div>
            </div>
            <div className="artifacts-stage-body">
              {renderDisplay(selected)}
            </div>
          </>
        )}
      </section>

      <Dialog isOpen={!!creating} onClose={() => setCreating(null)} title="Neues Artefakt erstellen"
        style={{ width: 640, maxWidth: "calc(100vw - 24px)" }}>
        <DialogBody>
          {creating && (
            <div className="settings-grid">
              <FormGroup label="Titel">
                <InputGroup value={creating.title}
                  onChange={(e) => setCreating({ ...creating, title: e.target.value })} />
              </FormGroup>
              <FormGroup label="Typ">
                <HTMLSelect fill value={creating.kind} onChange={(e) => {
                  const nextKind = e.target.value;
                  setCreating({
                    ...creating,
                    kind: nextKind,
                    content: STARTER_CONTENT[nextKind] ?? creating.content,
                  });
                }}>
                  <option value="html">HTML-Webseite / Dashboard</option>
                  <option value="svg">SVG-Grafik</option>
                  <option value="markdown">Markdown-Dokument</option>
                  <option value="csv">CSV-Tabelle</option>
                  <option value="json">JSON-Daten</option>
                  <option value="code">Code</option>
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Inhalt" className="full">
                <TextArea fill rows={11} className="tool-args" value={creating.content}
                  onChange={(e) => setCreating({ ...creating, content: e.target.value })} />
              </FormGroup>
            </div>
          )}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setCreating(null)} />
            <Button intent="primary" icon="add" text="Erstellen" loading={saving} onClick={createNew} />
          </>
        } />
      </Dialog>

      <Dialog isOpen={!!deleting} onClose={() => setDeleting(null)} title="Artefakt löschen">
        <DialogBody>
          <p>Artefakt „{deleting?.title}“ wirklich löschen?</p>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setDeleting(null)} />
            <Button intent="danger" text="Löschen" loading={saving} onClick={remove} />
          </>
        } />
      </Dialog>
    </div>
  );
}
