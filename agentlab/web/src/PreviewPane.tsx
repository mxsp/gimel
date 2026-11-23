import {
  Button, ButtonGroup, Icon, IconName, Menu, MenuDivider, MenuItem, Popover, Spinner, Tag,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, Artifact, Attachment, createArtifact, fetchWebPreview, getAttachmentContent,
  updateArtifact, WebPreviewResult,
} from "./api";
import { copyToClipboard } from "./chatUtils";
import RichText from "./format";

export type PreviewMode = "render" | "split" | "source";
export type WebMode = "direct" | "proxy" | "reader";
export type ViewportSize = "desktop" | "tablet" | "mobile";

export type PreviewTab = {
  id: string;
  source: "artifact" | "file" | "web" | "local";
  title: string;
  kind: string; // html | svg | markdown | csv | json | code | text | pdf | web
  filename?: string;
  language?: string;
  content?: string;
  artifactId?: number;
  attachmentId?: number;
  version?: number;
  url?: string;
  history?: string[];
  historyIndex?: number;
  webMode?: WebMode;
  dirty?: boolean;
};

type ConsoleEntry = {
  id: number;
  level: "log" | "info" | "warn" | "error";
  text: string;
  at: string;
};

const SAMPLE_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>HTML-Vorschau</title>
<style>
  body { margin: 0; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fbfaf7; color: #28251f; padding: 32px; }
  .card { max-width: 680px; margin: 0 auto; background: #fff; border: 1px solid #e6e2d8; border-radius: 16px; padding: 26px; box-shadow: 0 10px 30px rgb(40 33 20 / 0.08); }
  h1 { margin: 0 0 8px; font-size: 22px; color: #0b7a67; }
  p { margin: 0 0 14px; color: #514c43; }
  button { background: #0b7a67; color: #fff; border: 0; border-radius: 9px; padding: 9px 15px; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: #0a6b5a; }
  #out { margin-top: 12px; font-weight: 600; color: #b65f45; }
</style>
</head>
<body>
  <div class="card">
    <h1>Gimel HTML-Spielwiese</h1>
    <p>Bearbeiten Sie den Code im Modus „Geteilt“ oder „Code“ — Änderungen erscheinen sofort live hier rechts.</p>
    <button id="btn">Klick-Test</button>
    <div id="out"></div>
  </div>
  <script>
    let n = 0;
    document.getElementById("btn").addEventListener("click", () => {
      n += 1;
      document.getElementById("out").textContent = "Interaktiv aktiv · Klick #" + n;
      console.log("Button geklickt:", n);
    });
  </script>
</body>
</html>`;

export function inferKindFromFilename(filename = "", contentType = "", lang = ""): string {
  const l = (lang || "").toLowerCase().trim();
  if (l === "html" || l === "htm") return "html";
  if (l === "svg") return "svg";
  if (l === "md" || l === "markdown") return "markdown";
  if (l === "csv") return "csv";
  if (l === "json") return "json";
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (ext === "html" || ext === "htm" || contentType === "text/html") return "html";
  if (ext === "svg" || contentType === "image/svg+xml") return "svg";
  if (ext === "md" || ext === "markdown" || contentType === "text/markdown") return "markdown";
  if (ext === "csv" || contentType === "text/csv") return "csv";
  if (ext === "json" || contentType === "application/json") return "json";
  if (ext === "pdf" || contentType === "application/pdf") return "pdf";
  if (["js", "ts", "tsx", "jsx", "css", "py", "sql", "yaml", "yml", "xml", "sh", "bash"].includes(ext) || l) {
    return "code";
  }
  return "text";
}

function tabIcon(tab: PreviewTab): IconName {
  if (tab.source === "web" || tab.kind === "web") return "globe-network";
  if (tab.kind === "html") return "application";
  if (tab.kind === "svg") return "media";
  if (tab.kind === "csv") return "th";
  if (tab.kind === "json") return "code-block";
  if (tab.kind === "markdown") return "document";
  if (tab.kind === "pdf") return "document-open";
  if (tab.kind === "code") return "code";
  return "document";
}

function injectConsoleBridge(html: string, channelId: string): string {
  const bridge = `<script>(function(){var cid=${JSON.stringify(channelId)};function send(lvl,args){try{var txt=[].slice.call(args).map(function(a){if(typeof a==='string')return a;try{return JSON.stringify(a);}catch(e){return String(a);}}).join(' ');parent.postMessage({__gimelPreview:cid,level:lvl,text:txt},'*');}catch(e){}}['log','info','warn','error'].forEach(function(m){var orig=console[m];console[m]=function(){send(m,arguments);if(orig)return orig.apply(console,arguments);};});window.addEventListener('error',function(e){send('error',[e.message+(e.lineno?' (Zeile '+e.lineno+')':'')]);});window.addEventListener('unhandledrejection',function(e){send('error',['Promise: '+String(e.reason)]);});})();</script>`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/(<head\b[^>]*>)/i, `$1${bridge}`);
  }
  return bridge + html;
}

function parseCsvRows(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const sample = lines.slice(0, 5).join("\n");
  const delim = (sample.split(";").length > sample.split(",").length) ? ";" : ",";
  return lines.map((line) => {
    const row: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i += 1; }
        else inQuotes = !inQuotes;
      } else if (ch === delim && !inQuotes) {
        row.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    row.push(cur.trim());
    return row;
  });
}

function CsvViewer({ text }: { text: string }) {
  const [filter, setFilter] = useState("");
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const parsed = useMemo(() => parseCsvRows(text), [text]);
  const header = parsed[0] ?? [];
  const body = parsed.slice(1);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let rows = q ? body.filter((r) => r.some((cell) => cell.toLowerCase().includes(q))) : body;
    if (sortCol != null) {
      rows = [...rows].sort((a, b) => {
        const av = a[sortCol] ?? "";
        const bv = b[sortCol] ?? "";
        const an = Number(av.replace(",", "."));
        const bn = Number(bv.replace(",", "."));
        const cmp = (Number.isFinite(an) && Number.isFinite(bn) && av !== "" && bv !== "")
          ? an - bn
          : av.localeCompare(bv, "de");
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    return rows;
  }, [body, filter, sortCol, sortDir]);

  if (!header.length) return <div className="preview-empty-inner">Keine CSV-Daten erkannt.</div>;

  const toggleSort = (col: number) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  return (
    <div className="preview-data-sheet">
      <div className="preview-data-bar">
        <input className="bp5-input bp5-small" placeholder="Tabelle filtern …" value={filter}
          onChange={(e) => setFilter(e.target.value)} aria-label="CSV filtern" />
        <Tag minimal>{filtered.length} / {body.length} Zeilen</Tag>
        <Tag minimal>{header.length} Spalten</Tag>
      </div>
      <div className="preview-csv-wrap">
        <table className="preview-csv-table">
          <thead>
            <tr>
              {header.map((h, i) => (
                <th key={i} onClick={() => toggleSort(i)} className="is-sortable" title="Klicken zum Sortieren">
                  {h || `Spalte ${i + 1}`}
                  {sortCol === i && <span className="preview-sort-ind">{sortDir === "asc" ? " ▲" : " ▼"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 500).map((row, rIdx) => (
              <tr key={rIdx}>
                {header.map((_, cIdx) => <td key={cIdx}>{row[cIdx] ?? ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 500 && (
          <div className="preview-data-note">Anzeige auf 500 Zeilen begrenzt (Gesamt: {filtered.length}).</div>
        )}
      </div>
    </div>
  );
}

function JsonViewer({ text }: { text: string }) {
  const [query, setQuery] = useState("");
  const pretty = useMemo(() => {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }, [text]);
  const lines = useMemo(() => pretty.split("\n"), [pretty]);
  const q = query.trim().toLowerCase();
  const visible = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  return (
    <div className="preview-data-sheet">
      <div className="preview-data-bar">
        <input className="bp5-input bp5-small" placeholder="JSON durchsuchen …" value={query}
          onChange={(e) => setQuery(e.target.value)} aria-label="JSON durchsuchen" />
        <Tag minimal>{visible.length} Zeilen</Tag>
      </div>
      <pre className="preview-code-view"><code>{visible.join("\n")}</code></pre>
    </div>
  );
}

function DocumentViewer({ text, isPdf }: { text: string; isPdf: boolean }) {
  const [query, setQuery] = useState("");
  const [pageFilter, setPageFilter] = useState<number | null>(null);
  const pages = useMemo(() => {
    if (!isPdf) return [];
    const matches = Array.from(text.matchAll(/\[Seite (\d+)\]/g));
    return matches.map((m) => Number(m[1]));
  }, [text, isPdf]);

  const shown = useMemo(() => {
    let chunk = text;
    if (pageFilter != null) {
      const marker = `[Seite ${pageFilter}]`;
      const start = text.indexOf(marker);
      if (start !== -1) {
        const next = text.indexOf("[Seite ", start + marker.length);
        chunk = next !== -1 ? text.slice(start, next) : text.slice(start);
      }
    }
    const q = query.trim().toLowerCase();
    if (!q) return chunk;
    return chunk.split("\n").filter((l) => l.toLowerCase().includes(q)).join("\n")
      || `Keine Treffer für „${query}“.`;
  }, [text, pageFilter, query]);

  return (
    <div className="preview-data-sheet">
      <div className="preview-data-bar">
        <input className="bp5-input bp5-small" placeholder="Im Dokument suchen …" value={query}
          onChange={(e) => setQuery(e.target.value)} aria-label="Im Dokument suchen" />
        <Tag minimal>{text.length.toLocaleString("de-DE")} Zeichen</Tag>
      </div>
      {pages.length > 1 && (
        <div className="preview-page-pills">
          <button type="button" className={pageFilter == null ? "is-active" : ""} onClick={() => setPageFilter(null)}>Alle</button>
          {pages.slice(0, 30).map((p) => (
            <button key={p} type="button" className={pageFilter === p ? "is-active" : ""}
              onClick={() => setPageFilter(p)}>S. {p}</button>
          ))}
        </div>
      )}
      <pre className="preview-doc-view">{shown}</pre>
    </div>
  );
}

export default function PreviewPane({
  chatId,
  tabs,
  activeTabId,
  artifacts,
  attachments,
  expanded,
  onSelectTab,
  onCloseTab,
  onUpdateTab,
  onAddTab,
  onToggleExpand,
  onClose,
  onArtifactsChanged,
}: {
  chatId: number | null;
  tabs: PreviewTab[];
  activeTabId: string | null;
  artifacts: Artifact[];
  attachments: Attachment[];
  expanded: boolean;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onUpdateTab: (id: string, patch: Partial<PreviewTab>) => void;
  onAddTab: (tab: PreviewTab) => void;
  onToggleExpand: () => void;
  onClose: () => void;
  onArtifactsChanged?: () => void;
}) {
  const active = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? tabs[tabs.length - 1] ?? null,
    [tabs, activeTabId],
  );
  const [viewMode, setViewMode] = useState<PreviewMode>("render");
  const [viewport, setViewport] = useState<ViewportSize>("desktop");
  const [svgZoom, setSvgZoom] = useState(100);
  const [address, setAddress] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [webSnap, setWebSnap] = useState<Record<string, WebPreviewResult>>({});
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draggingFile, setDraggingFile] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([]);
  const localFileRef = useRef<HTMLInputElement>(null);
  const consoleSeq = useRef(0);
  const channelId = useMemo(() => `gp-${active?.id ?? "none"}-${reloadNonce}`, [active?.id, reloadNonce]);

  useEffect(() => {
    if (!active) { setAddress(""); return; }
    if (active.source === "web") setAddress(active.url || "");
    else if (active.source === "file") setAddress(`datei://${active.filename || active.title}`);
    else if (active.source === "local") setAddress(`lokal://${active.filename || active.title}`);
    else setAddress(`artefakt://${active.filename || active.title}`);
    setLoadError("");
    setConsoleLogs([]);
  }, [active?.id, active?.url, active?.filename, active?.title, active?.source]);

  // Konsole aus sandboxed HTML-iframes einsammeln
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.__gimelPreview !== channelId) return;
      const level = (["log", "info", "warn", "error"].includes(String(data.level))
        ? String(data.level) : "log") as ConsoleEntry["level"];
      setConsoleLogs((prev) => [
        ...prev.slice(-79),
        {
          id: ++consoleSeq.current,
          level,
          text: String(data.text || ""),
          at: new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        },
      ]);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [channelId]);

  // Anhang-Inhalt nachladen, falls noch nicht vorhanden
  useEffect(() => {
    if (!active || active.source !== "file" || active.attachmentId == null || active.content != null) return;
    if (chatId == null) return;
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    getAttachmentContent(chatId, active.attachmentId)
      .then((data) => {
        if (cancelled) return;
        onUpdateTab(active.id, {
          content: data.text,
          filename: data.filename,
          title: active.title || data.filename,
          kind: inferKindFromFilename(data.filename, data.content_type),
        });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active?.id, active?.source, active?.attachmentId, active?.content, chatId, onUpdateTab]);

  // Proxy / Lesemodus für externe URLs laden
  const activeUrl = active?.source === "web" ? (active.url || "") : "";
  const activeWebMode: WebMode = active?.webMode ?? (activeUrl.startsWith("/") ? "direct" : "direct");
  useEffect(() => {
    if (!active || active.source !== "web" || !activeUrl || activeUrl.startsWith("/")) return;
    if (activeWebMode === "direct") return;
    const cacheKey = `${activeUrl}::${reloadNonce}`;
    if (webSnap[cacheKey]) return;
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    fetchWebPreview(activeUrl)
      .then((res) => {
        if (cancelled) return;
        setWebSnap((prev) => ({ ...prev, [cacheKey]: res }));
        if (res.title && res.title !== active.title) {
          onUpdateTab(active.id, { title: res.title.slice(0, 60) });
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active?.id, active?.source, activeUrl, activeWebMode, reloadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateUrl = useCallback((rawInput: string) => {
    let target = rawInput.trim();
    if (!target) return;
    if (!target.startsWith("/") && !/^https?:\/\//i.test(target)) {
      if (target.includes(".") && !target.includes(" ")) target = `https://${target}`;
      else target = `https://duckduckgo.com/?q=${encodeURIComponent(target)}`;
    }
    const isLocal = target.startsWith("/");
    if (active && active.source === "web") {
      const hist = (active.history ?? [active.url || ""]).slice(0, (active.historyIndex ?? 0) + 1);
      hist.push(target);
      onUpdateTab(active.id, {
        url: target,
        title: target.replace(/^https?:\/\//, "").slice(0, 42) || target,
        history: hist,
        historyIndex: hist.length - 1,
        webMode: isLocal ? "direct" : (active.webMode ?? "direct"),
      });
    } else {
      onAddTab({
        id: `web-${Date.now()}`,
        source: "web",
        kind: "web",
        title: target.replace(/^https?:\/\//, "").slice(0, 42) || target,
        url: target,
        history: [target],
        historyIndex: 0,
        webMode: "direct",
      });
    }
  }, [active, onUpdateTab, onAddTab]);

  const goHistory = (delta: number) => {
    if (!active || active.source !== "web" || !active.history?.length) return;
    const nextIdx = (active.historyIndex ?? 0) + delta;
    if (nextIdx < 0 || nextIdx >= active.history.length) return;
    const nextUrl = active.history[nextIdx];
    onUpdateTab(active.id, {
      url: nextUrl,
      historyIndex: nextIdx,
      title: nextUrl.replace(/^https?:\/\//, "").slice(0, 42) || nextUrl,
    });
  };

  const openHtmlSandbox = () => {
    onAddTab({
      id: `sandbox-${Date.now()}`,
      source: "artifact",
      kind: "html",
      title: "HTML-Spielwiese",
      filename: "spielwiese.html",
      language: "html",
      content: SAMPLE_HTML,
      dirty: true,
    });
    setViewMode("split");
  };

  const openNewBrowser = (url = "/app", title = "Gimel Portal") => {
    onAddTab({
      id: `web-${Date.now()}`,
      source: "web",
      kind: "web",
      title,
      url,
      history: [url],
      historyIndex: 0,
      webMode: "direct",
    });
  };

  const openLocalFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === "string" ? reader.result : "";
        onAddTab({
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          source: "local",
          kind: inferKindFromFilename(file.name, file.type),
          title: file.name,
          filename: file.name,
          content: text,
        });
      };
      reader.readAsText(file);
    });
    if (localFileRef.current) localFileRef.current.value = "";
  };

  const saveActiveArtifact = async () => {
    if (!active || active.content == null || saving) return;
    if (chatId == null) {
      setLoadError("Bitte zuerst einen Chat öffnen, dann lässt sich das Artefakt speichern.");
      return;
    }
    setSaving(true);
    setLoadError("");
    try {
      if (active.artifactId != null) {
        const updated = await updateArtifact(chatId, active.artifactId, {
          content: active.content,
          title: active.title,
        });
        onUpdateTab(active.id, { version: updated.version, dirty: false });
      } else {
        const created = await createArtifact(chatId, {
          title: active.title || "Vorschau",
          kind: ["html", "svg", "markdown", "csv", "json", "code", "text"].includes(active.kind)
            ? active.kind : "text",
          content: active.content,
          filename: active.filename,
          language: active.language,
        });
        onUpdateTab(active.id, {
          source: "artifact",
          artifactId: created.id,
          version: created.version,
          filename: created.filename,
          dirty: false,
        });
      }
      onArtifactsChanged?.();
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const downloadActive = () => {
    if (!active || active.content == null) return;
    const mime = active.kind === "html" ? "text/html;charset=utf-8"
      : active.kind === "svg" ? "image/svg+xml;charset=utf-8"
      : active.kind === "csv" ? "text/csv;charset=utf-8"
      : active.kind === "json" ? "application/json;charset=utf-8"
      : "text/plain;charset=utf-8";
    const blob = new Blob([active.content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = active.filename || `${active.title || "vorschau"}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openExternal = () => {
    if (!active) return;
    if (active.source === "web" && active.url) {
      window.open(active.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (active.content != null) {
      const mime = active.kind === "html" ? "text/html;charset=utf-8"
        : active.kind === "svg" ? "image/svg+xml;charset=utf-8"
        : "text/plain;charset=utf-8";
      const url = URL.createObjectURL(new Blob([active.content], { type: mime }));
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  };

  const copyActive = async () => {
    const text = active?.source === "web" ? (active.url || "") : (active?.content || "");
    if (text && await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const canBack = Boolean(active?.source === "web" && (active.historyIndex ?? 0) > 0);
  const canForward = Boolean(
    active?.source === "web" && active.history && (active.historyIndex ?? 0) < active.history.length - 1,
  );
  const isEditable = Boolean(active && active.source !== "web" && active.kind !== "pdf");
  const isHtmlLike = Boolean(active && (active.kind === "html" || active.kind === "svg"));
  const snap = active?.source === "web" ? webSnap[`${activeUrl}::${reloadNonce}`] : undefined;
  const errorLogCount = consoleLogs.filter((c) => c.level === "error").length;

  const viewportStyle = viewport === "tablet" ? { maxWidth: 768 }
    : viewport === "mobile" ? { maxWidth: 390 }
    : undefined;

  const renderContentPane = () => {
    if (!active) {
      return (
        <div className="preview-landing">
          <div className="preview-landing-icon"><Icon icon="globe-network" size={28} /></div>
          <h3>Seiten-Vorschau &amp; Browser</h3>
          <p>
            Zeigen Sie vom Assistenten erzeugte HTML-Webseiten, Dashboards, Diagramme, SVG-Grafiken,
            CSV/JSON/PDF-Dateien oder Live-Webseiten direkt neben dem Chat an.
          </p>
          <div className="preview-landing-actions">
            <Button intent="primary" icon="code" text="HTML-Spielwiese" onClick={openHtmlSandbox} />
            <Button icon="globe-network" text="Gimel Portal (/app)" onClick={() => openNewBrowser("/app", "Gimel Portal")} />
            <Button icon="cube" text="3D Twin (/twin)" onClick={() => openNewBrowser("/twin", "3D Twin")} />
            <Button icon="folder-open" text="Lokale Datei öffnen" onClick={() => localFileRef.current?.click()} />
          </div>
          {(artifacts.length > 0 || attachments.length > 0) && (
            <div className="preview-landing-list">
              {artifacts.length > 0 && (
                <div>
                  <div className="preview-landing-sub">Artefakte in diesem Chat</div>
                  {artifacts.slice(0, 6).map((a) => (
                    <button key={a.id} type="button" className="preview-quick-item"
                      onClick={() => onAddTab({
                        id: `art-${a.id}`, source: "artifact", artifactId: a.id,
                        title: a.title, kind: a.kind, filename: a.filename,
                        language: a.language, content: a.content, version: a.version,
                      })}>
                      <Icon icon="application" size={13} />
                      <span>{a.title}</span>
                      <Tag minimal>{a.kind.toUpperCase()}</Tag>
                    </button>
                  ))}
                </div>
              )}
              {attachments.length > 0 && (
                <div>
                  <div className="preview-landing-sub">Dateien in diesem Chat</div>
                  {attachments.slice(0, 6).map((att) => (
                    <button key={att.id} type="button" className="preview-quick-item"
                      onClick={() => onAddTab({
                        id: `file-${att.id}`, source: "file", attachmentId: att.id,
                        title: att.filename, filename: att.filename,
                        kind: inferKindFromFilename(att.filename, att.content_type),
                      })}>
                      <Icon icon="document" size={13} />
                      <span>{att.filename}</span>
                      <Tag minimal>{inferKindFromFilename(att.filename, att.content_type).toUpperCase()}</Tag>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    if (loading) {
      return <div className="preview-loading"><Spinner size={26} /><span>Wird geladen …</span></div>;
    }

    if (active.source === "web") {
      if (activeWebMode === "direct") {
        const isExternal = /^https?:\/\//i.test(activeUrl);
        return (
          <div className={`preview-frame-shell ${viewport !== "desktop" ? "is-framed-canvas" : ""}`}>
            {isExternal && (
              <div className="preview-web-hint">
                <span>Bleibt eine externe Seite leer (X-Frame-Options)?</span>
                <button type="button" onClick={() => onUpdateTab(active.id, { webMode: "proxy" })}>
                  Proxy-Vorschau laden
                </button>
                <button type="button" onClick={() => onUpdateTab(active.id, { webMode: "reader" })}>
                  Lesemodus
                </button>
              </div>
            )}
            <div className={`preview-viewport ${viewport !== "desktop" ? "is-framed" : ""}`} style={viewportStyle}>
              <iframe
                key={`${active.id}-${activeUrl}-${reloadNonce}`}
                src={activeUrl}
                title={active.title}
                className="preview-iframe"
                sandbox={isExternal
                  ? "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
                  : undefined}
                referrerPolicy="no-referrer"
              />
            </div>
          </div>
        );
      }
      if (activeWebMode === "proxy") {
        if (!snap?.html) {
          return (
            <div className="preview-empty-inner">
              {loadError || "Kein HTML-Inhalt verfügbar. Wechseln Sie in den Lesemodus."}
            </div>
          );
        }
        return (
          <div className={`preview-frame-shell ${viewport !== "desktop" ? "is-framed-canvas" : ""}`}>
            <div className={`preview-viewport ${viewport !== "desktop" ? "is-framed" : ""}`} style={viewportStyle}>
              <iframe
                key={`proxy-${active.id}-${activeUrl}-${reloadNonce}`}
                srcDoc={snap.html}
                title={snap.title || active.title}
                className="preview-iframe"
                sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox"
              />
            </div>
          </div>
        );
      }
      return (
        <div className="preview-reader">
          <div className="preview-reader-head">
            <h2>{snap?.title || active.title}</h2>
            <a href={activeUrl} target="_blank" rel="noreferrer">{activeUrl}</a>
          </div>
          <pre className="preview-doc-view">{snap?.text || loadError || "Kein Text extrahiert."}</pre>
        </div>
      );
    }

    const content = active.content ?? "";
    const renderVisual = () => {
      if (active.kind === "html") {
        return (
          <div className={`preview-frame-shell ${viewport !== "desktop" ? "is-framed-canvas" : ""}`}>
            <div className={`preview-viewport ${viewport !== "desktop" ? "is-framed" : ""}`} style={viewportStyle}>
              <iframe
                key={`${channelId}-${active.version ?? 0}`}
                srcDoc={injectConsoleBridge(content, channelId)}
                title={active.title}
                className="preview-iframe"
                sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
              />
            </div>
          </div>
        );
      }
      if (active.kind === "svg") {
        const svgDoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:repeating-conic-gradient(#ece9e1 0% 25%,#fbfaf7 0% 50%) 50%/18px 18px;overflow:auto}svg{max-width:none;transform:scale(${svgZoom / 100});transform-origin:center;transition:transform .12s}</style></head><body>${content}</body></html>`;
        return (
          <div className="preview-frame-shell">
            <div className="preview-svg-bar">
              <span>SVG-Zoom: {svgZoom}%</span>
              <ButtonGroup minimal>
                {[50, 100, 150, 200].map((z) => (
                  <Button key={z} small active={svgZoom === z} text={`${z}%`} onClick={() => setSvgZoom(z)} />
                ))}
              </ButtonGroup>
            </div>
            <iframe
              key={`svg-${active.id}-${svgZoom}-${reloadNonce}`}
              srcDoc={svgDoc}
              title={active.title}
              className="preview-iframe"
              sandbox=""
            />
          </div>
        );
      }
      if (active.kind === "markdown") {
        return (
          <div className="preview-md-sheet">
            <RichText text={content} />
          </div>
        );
      }
      if (active.kind === "csv") return <CsvViewer text={content} />;
      if (active.kind === "json") return <JsonViewer text={content} />;
      if (active.kind === "pdf" || active.kind === "text") {
        return <DocumentViewer text={content} isPdf={active.kind === "pdf"} />;
      }
      return <pre className="preview-code-view"><code>{content}</code></pre>;
    };

    const renderEditor = () => (
      <textarea
        className="preview-editor"
        spellCheck={false}
        value={content}
        aria-label="Quelltext bearbeiten"
        onChange={(e) => onUpdateTab(active.id, { content: e.target.value, dirty: true })}
      />
    );

    if (viewMode === "source" && isEditable) return renderEditor();
    if (viewMode === "split" && isEditable) {
      return (
        <div className="preview-split-inner">
          <div className="preview-split-code">{renderEditor()}</div>
          <div className="preview-split-render">{renderVisual()}</div>
        </div>
      );
    }
    return renderVisual();
  };

  return (
    <section
      className={`preview-pane ${expanded ? "is-expanded" : ""} ${draggingFile ? "is-dragging" : ""}`}
      aria-label="Seiten-Vorschau und Browser"
      onDragOver={(e) => { e.preventDefault(); setDraggingFile(true); }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDraggingFile(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDraggingFile(false);
        if (e.dataTransfer.files.length) openLocalFiles(e.dataTransfer.files);
      }}
    >
      <input ref={localFileRef} type="file" hidden multiple
        accept=".html,.htm,.svg,.md,.markdown,.csv,.json,.txt,.log,.js,.ts,.css,.py,.xml,.yaml,.yml,.sql"
        onChange={(e) => openLocalFiles(e.target.files)} />

      {draggingFile && (
        <div className="preview-drop-overlay">Datei zum direkten Anzeigen hier ablegen (HTML, SVG, CSV, JSON, MD …)</div>
      )}

      {/* Tab-Leiste */}
      <div className="preview-tabbar">
        <div className="preview-tabs" role="tablist">
          {tabs.map((tab) => (
            <div key={tab.id} className={`preview-tab ${active?.id === tab.id ? "is-active" : ""}`}>
              <button type="button" role="tab" aria-selected={active?.id === tab.id}
                className="preview-tab-main" onClick={() => onSelectTab(tab.id)} title={tab.title}>
                <Icon icon={tabIcon(tab)} size={12} aria-hidden="true" />
                <span className="preview-tab-title">{tab.title}</span>
                {tab.dirty && <span className="preview-dirty-dot" title="Ungespeicherte Änderungen" />}
              </button>
              <button type="button" className="preview-tab-close" aria-label={`${tab.title} schließen`}
                onClick={() => onCloseTab(tab.id)}>×</button>
            </div>
          ))}
        </div>

        <div className="preview-tabbar-actions">
          <Popover minimal placement="bottom-end" content={
            <Menu>
              <MenuItem icon="code" text="Neue HTML-Spielwiese" onClick={openHtmlSandbox} />
              <MenuItem icon="globe-network" text="Gimel Portal (/app)" onClick={() => openNewBrowser("/app", "Gimel Portal")} />
              <MenuItem icon="cube" text="3D Twin (/twin)" onClick={() => openNewBrowser("/twin", "3D Twin")} />
              <MenuItem icon="folder-open" text="Lokale Datei öffnen …" onClick={() => localFileRef.current?.click()} />
              {artifacts.length > 0 && (
                <>
                  <MenuDivider title="Chat-Artefakte" />
                  {artifacts.map((a) => (
                    <MenuItem key={a.id} icon="application" text={`${a.title} (v${a.version})`}
                      label={a.kind.toUpperCase()}
                      onClick={() => onAddTab({
                        id: `art-${a.id}`, source: "artifact", artifactId: a.id,
                        title: a.title, kind: a.kind, filename: a.filename,
                        language: a.language, content: a.content, version: a.version,
                      })} />
                  ))}
                </>
              )}
              {attachments.length > 0 && (
                <>
                  <MenuDivider title="Chat-Dateien" />
                  {attachments.map((att) => (
                    <MenuItem key={att.id} icon="document" text={att.filename}
                      onClick={() => onAddTab({
                        id: `file-${att.id}`, source: "file", attachmentId: att.id,
                        title: att.filename, filename: att.filename,
                        kind: inferKindFromFilename(att.filename, att.content_type),
                      })} />
                  ))}
                </>
              )}
            </Menu>
          }>
            <Button minimal small icon="plus" aria-label="Neuer Vorschau-Tab" title="Neuer Tab / Datei / Artefakt" />
          </Popover>
          <Button minimal small icon={expanded ? "minimize" : "maximize"}
            aria-label={expanded ? "Verkleinern" : "Vollbild"} title={expanded ? "Verkleinern" : "Vollbild"}
            onClick={onToggleExpand} />
          <Button minimal small icon="cross" aria-label="Vorschau schließen" title="Schließen" onClick={onClose} />
        </div>
      </div>

      {/* Browser-Adress- und Werkzeugleiste */}
      <div className="preview-navbar">
        <div className="preview-nav-btns">
          <Button minimal small icon="arrow-left" disabled={!canBack} aria-label="Zurück" onClick={() => goHistory(-1)} />
          <Button minimal small icon="arrow-right" disabled={!canForward} aria-label="Vorwärts" onClick={() => goHistory(1)} />
          <Button minimal small icon="refresh" aria-label="Neu laden" title="Neu laden"
            onClick={() => setReloadNonce((n) => n + 1)} />
        </div>

        <form className="preview-address-form" onSubmit={(e) => { e.preventDefault(); navigateUrl(address); }}>
          <Icon icon={active?.source === "web" ? "globe-network" : "document"} size={12} className="preview-address-icon" />
          <input
            className="preview-address-input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="URL eingeben (https://…, /app, /twin) oder Datei ablegen …"
            aria-label="Adresse im Vorschau-Browser"
          />
          <button type="submit" className="preview-address-go" title="Öffnen">↵</button>
        </form>

        <div className="preview-controls">
          {active?.source === "web" && !activeUrl.startsWith("/") && (
            <ButtonGroup minimal className="preview-seg">
              <Button small active={activeWebMode === "direct"} text="Direkt"
                onClick={() => onUpdateTab(active.id, { webMode: "direct" })} />
              <Button small active={activeWebMode === "proxy"} text="Proxy"
                onClick={() => onUpdateTab(active.id, { webMode: "proxy" })} />
              <Button small active={activeWebMode === "reader"} text="Lesen"
                onClick={() => onUpdateTab(active.id, { webMode: "reader" })} />
            </ButtonGroup>
          )}

          {isEditable && (
            <ButtonGroup minimal className="preview-seg">
              <Button small active={viewMode === "render"} text="Vorschau" onClick={() => setViewMode("render")} />
              <Button small active={viewMode === "split"} text="Geteilt" onClick={() => setViewMode("split")} />
              <Button small active={viewMode === "source"} text="Code" onClick={() => setViewMode("source")} />
            </ButtonGroup>
          )}

          {(active?.source === "web" || isHtmlLike) && (
            <ButtonGroup minimal className="preview-seg">
              <Button small active={viewport === "desktop"} icon="desktop" aria-label="Desktop" title="Desktop (100%)"
                onClick={() => setViewport("desktop")} />
              <Button small active={viewport === "tablet"} icon="applications" aria-label="Tablet" title="Tablet (768px)"
                onClick={() => setViewport("tablet")} />
              <Button small active={viewport === "mobile"} icon="mobile-phone" aria-label="Mobil" title="Mobil (390px)"
                onClick={() => setViewport("mobile")} />
            </ButtonGroup>
          )}

          {isEditable && active?.dirty && (
            <Button small intent="primary" icon="floppy-disk" text="Speichern" loading={saving}
              onClick={saveActiveArtifact} />
          )}
          {active && (
            <>
              <Button minimal small icon={copied ? "tick" : "clipboard"} title="Inhalt / URL kopieren" onClick={copyActive} />
              {active.content != null && (
                <Button minimal small icon="download" title="Als Datei herunterladen" onClick={downloadActive} />
              )}
              <Button minimal small icon="share" title="In neuem Browser-Tab öffnen" onClick={openExternal} />
            </>
          )}
        </div>
      </div>

      {loadError && (
        <div className="preview-error-bar" role="alert">
          <Icon icon="warning-sign" size={12} />
          <span>{loadError}</span>
          <Button minimal small icon="cross" onClick={() => setLoadError("")} />
        </div>
      )}

      {/* Hauptfläche */}
      <div className="preview-body">
        {renderContentPane()}
      </div>

      {/* Live-Konsole für HTML-Vorschau */}
      {active?.kind === "html" && (
        <div className={`preview-console ${consoleOpen ? "is-open" : ""}`}>
          <button type="button" className="preview-console-bar" onClick={() => setConsoleOpen((v) => !v)}>
            <Icon icon="console" size={12} />
            <span>Konsole</span>
            <Tag minimal intent={errorLogCount ? "danger" : "none"}>{consoleLogs.length}</Tag>
            {errorLogCount > 0 && <Tag minimal intent="danger">{errorLogCount} Fehler</Tag>}
            <span className="spacer" />
            {consoleLogs.length > 0 && (
              <span className="preview-console-clear" role="button" tabIndex={0}
                onClick={(e) => { e.stopPropagation(); setConsoleLogs([]); }}>Leeren</span>
            )}
            <Icon icon={consoleOpen ? "chevron-down" : "chevron-up"} size={12} />
          </button>
          {consoleOpen && (
            <div className="preview-console-list">
              {consoleLogs.length === 0 ? (
                <div className="preview-console-empty">Keine Konsolenausgaben.</div>
              ) : (
                consoleLogs.map((entry) => (
                  <div key={entry.id} className={`preview-console-row is-${entry.level}`}>
                    <span className="preview-console-time">{entry.at}</span>
                    <span className="preview-console-lvl">{entry.level}</span>
                    <span className="preview-console-text">{entry.text}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
