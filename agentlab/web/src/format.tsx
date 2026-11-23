import { Fragment, ReactNode, useState } from "react";
import ChartBlock, { ChartSpec } from "./ChartBlock";
import { copyToClipboard } from "./chatUtils";

/* Kleiner, sicherer Markdown-Renderer: keine HTML-Eingabe, kein innerHTML.
   Deckt ab, was Modelle tatsächlich schreiben: Absätze, Listen (auch
   verschachtelt), Aufgaben, Tabellen (mit CSV-Export), Diagramme (```chart),
   klickbare Auftrags-/IA-/VS-Nummern, Callouts, Überschriften, Zitate, Codeblöcke,
   fett, kursiv, durchgestrichen, Inline-Code und Links. */

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]]+\]\([^)]+\)|\b(?:AB|IA|VS)-\d{2}-\d{3,}\b)/g;

function entityHref(code: string): string | null {
  if (code.startsWith("AB-")) return `/app/#/auftraege/${encodeURIComponent(code)}`;
  if (code.startsWith("IA-")) return `/app/#/produktion/${encodeURIComponent(code)}`;
  if (code.startsWith("VS-")) return `/app/#/versand/${encodeURIComponent(code)}`;
  return null;
}

function safeHref(href: string): string | null {
  try {
    const url = new URL(href.trim(), window.location.origin);
    if (["http:", "https:", "mailto:"].includes(url.protocol)) return url.href;
  } catch { /* kein gültiger Link */ }
  return null;
}

function inline(
  text: string,
  key: string,
  depth = 0,
  onPreviewUrl?: (url: string, title?: string) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = match[0];
    const inner = (open: number, close: number) => inline(token.slice(open, -close), `${key}-${index}-i`, depth + 1, onPreviewUrl);
    if (depth < 3 && token.startsWith("**")) {
      out.push(<strong key={`${key}-${index}`}>{inner(2, 2)}</strong>);
    } else if (depth < 3 && token.startsWith("__")) {
      out.push(<strong key={`${key}-${index}`}>{inner(2, 2)}</strong>);
    } else if (depth < 3 && token.startsWith("~~")) {
      out.push(<del key={`${key}-${index}`}>{inner(2, 2)}</del>);
    } else if (depth < 3 && token.startsWith("*")) {
      out.push(<em key={`${key}-${index}`}>{inner(1, 1)}</em>);
    } else if (token.startsWith("`")) {
      out.push(<code key={`${key}-${index}`}>{token.slice(1, -1)}</code>);
    } else if (/^(?:AB|IA|VS)-\d{2}-\d{3,}$/.test(token)) {
      const target = entityHref(token);
      out.push(target ? (
        <a key={`${key}-${index}`} className="md-entity-link" href={target} target="_blank" rel="noreferrer">{token}</a>
      ) : token);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]) : null;
      if (link && href) {
        const canPreview = Boolean(onPreviewUrl && (href.startsWith("http://") || href.startsWith("https://")));
        out.push(
          <span key={`${key}-${index}`} className="md-link-wrap">
            <a href={href}
              target={href.startsWith("mailto:") ? undefined : "_blank"}
              rel="noreferrer">{inline(link[1], `${key}-${index}-l`, depth + 1, onPreviewUrl)}</a>
            {canPreview && (
              <button type="button" className="md-link-preview"
                title="Im Seiten-Browser öffnen"
                aria-label={`${link[1]} im Seiten-Browser öffnen`}
                onClick={() => onPreviewUrl?.(href, link[1])}>
                ↗
              </button>
            )}
          </span>,
        );
      } else {
        out.push(token);
      }
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function inlineLines(
  lines: string[],
  key: string,
  onPreviewUrl?: (url: string, title?: string) => void,
): ReactNode[] {
  return lines.flatMap((line, index) => [
    ...(index > 0 ? [<br key={`${key}-br-${index}`} />] : []),
    ...inline(line, `${key}-${index}`, 0, onPreviewUrl),
  ]);
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableAlign(line: string): Array<"left" | "center" | "right"> {
  return splitRow(line).map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function renderTable(
  lines: string[],
  start: number,
  key: string,
  onPreviewUrl?: (url: string, title?: string) => void,
): { node: ReactNode; next: number } {
  const header = splitRow(lines[start]);
  const align = tableAlign(lines[start + 1]);
  let index = start + 2;
  const rows: string[][] = [];
  while (index < lines.length && /^\s*\|/.test(lines[index]) && lines[index].includes("|")) {
    rows.push(splitRow(lines[index]));
    index += 1;
  }
  const cell = (value: string, cellKey: string, column: number) => (
    <td key={cellKey} style={{ textAlign: align[column] ?? "left" }}>
      {inline(value, cellKey, 0, onPreviewUrl)}
    </td>
  );
  const downloadCsv = () => {
    const esc = (v: string) => {
      const clean = v.replace(/[*_`]/g, "").trim();
      const safe = /^[=+@\-\t\r]/.test(clean) ? "'" + clean : clean;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = "\uFEFF" + [header, ...rows].map((r) => header.map((_, c) => esc(r[c] ?? "")).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `tabelle-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  return {
    node: (
      <div className="md-table-wrap" key={key}>
        <div className="md-table-tools">
          <button type="button" className="md-code-copy" onClick={downloadCsv} aria-label="Tabelle als CSV herunterladen">
            CSV
          </button>
        </div>
        <table>
          <thead>
            <tr>{header.map((value, column) => (
              <th key={`${key}-h-${column}`} style={{ textAlign: align[column] ?? "left" }}>
                {inline(value, `${key}-h-${column}`, 0, onPreviewUrl)}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`${key}-r-${rowIndex}`}>
                {header.map((_, column) => cell(row[column] ?? "", `${key}-r-${rowIndex}-${column}`, column))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
    next: index,
  };
}

const LIST_ITEM = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;

function isTask(text: string): boolean {
  return /^\[[ xX]\]\s+/.test(text);
}

function renderTaskText(
  text: string,
  key: string,
  onPreviewUrl?: (url: string, title?: string) => void,
): ReactNode {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!task) return inline(text, key, 0, onPreviewUrl);
  return (
    <span className="md-task">
      <input type="checkbox" checked={task[1].toLowerCase() === "x"} readOnly tabIndex={-1} aria-hidden="true" />
      <span>{inline(task[2], `${key}-task`, 0, onPreviewUrl)}</span>
    </span>
  );
}

function renderList(
  lines: string[],
  start: number,
  key: string,
  onPreviewUrl?: (url: string, title?: string) => void,
): { node: ReactNode; next: number } {
  const first = LIST_ITEM.exec(lines[start])!;
  const ordered = /^\d/.test(first[2]);
  const base = first[1].length;
  const items: ReactNode[] = [];
  let index = start;
  let itemIndex = 0;

  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]);
    if (!match) break;
    const indent = match[1].length;
    const itemOrdered = /^\d/.test(match[2]);
    if (indent < base) break;
    if (indent > base) break;
    if (itemOrdered !== ordered) break;

    const text = match[3];
    const itemKey = `${key}-li-${itemIndex}`;
    index += 1;
    let children: ReactNode = null;
    const nested = index < lines.length ? LIST_ITEM.exec(lines[index]) : null;
    if (nested && nested[1].length > base) {
      const child = renderList(lines, index, itemKey, onPreviewUrl);
      children = child.node;
      index = child.next;
    }
    items.push(
      <li key={itemKey} className={isTask(text) ? "md-task-item" : undefined}>
        {renderTaskText(text, itemKey, onPreviewUrl)}
        {children}
      </li>,
    );
    itemIndex += 1;
  }

  const Tag = ordered ? "ol" : "ul";
  return { node: <Tag key={key}>{items}</Tag>, next: index };
}

const CALLOUT_LABELS: Record<string, { label: string; cls: string }> = {
  NOTE: { label: "Hinweis", cls: "is-note" },
  TIP: { label: "Tipp", cls: "is-tip" },
  IMPORTANT: { label: "Wichtig", cls: "is-important" },
  WARNING: { label: "Warnung", cls: "is-warning" },
  CAUTION: { label: "Achtung", cls: "is-caution" },
};

function prose(
  lines: string[],
  key: string,
  onPreviewUrl?: (url: string, title?: string) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(<p key={`${key}-p-${out.length}`}>{inlineLines(paragraph, `${key}-p-${out.length}`, onPreviewUrl)}</p>);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index].trimEnd();

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      flushParagraph();
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) index += 1;
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length + 2, 6);
      const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
      out.push(<Tag key={`${key}-h-${out.length}`}>{inline(heading[2], `${key}-h-${out.length}`, 0, onPreviewUrl)}</Tag>);
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      out.push(<hr key={`${key}-hr-${out.length}`} />);
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const alertMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(quote[0] || "");
      if (alertMatch) {
        const meta = CALLOUT_LABELS[alertMatch[1].toUpperCase()];
        const rest = [alertMatch[2], ...quote.slice(1)].filter(Boolean);
        out.push(
          <div key={`${key}-q-${out.length}`} className={`md-callout ${meta.cls}`}>
            <strong>{meta.label}</strong>
            {rest.length > 0 && <div>{inlineLines(rest, `${key}-q-${out.length}`, onPreviewUrl)}</div>}
          </div>,
        );
      } else {
        out.push(
          <blockquote key={`${key}-q-${out.length}`}>
            {inlineLines(quote, `${key}-q-${out.length}`, onPreviewUrl)}
          </blockquote>,
        );
      }
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && isSeparatorRow(lines[index + 1])) {
      flushParagraph();
      const table = renderTable(lines, index, `${key}-t-${out.length}`, onPreviewUrl);
      out.push(table.node);
      index = table.next;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flushParagraph();
      const list = renderList(lines, index, `${key}-l-${out.length}`, onPreviewUrl);
      out.push(list.node);
      index = list.next;
      continue;
    }

    paragraph.push(lines[index]);
    index += 1;
  }

  flushParagraph();
  return out;
}

const LANG_LABEL: Record<string, string> = {
  bash: "Bash", sh: "Shell", shell: "Shell", zsh: "Shell", powershell: "PowerShell", ps1: "PowerShell",
  js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX",
  py: "Python", python: "Python", json: "JSON", yaml: "YAML", yml: "YAML", sql: "SQL", html: "HTML", htm: "HTML",
  svg: "SVG", css: "CSS", scss: "SCSS", diff: "Diff", text: "Text", txt: "Text", md: "Markdown", markdown: "Markdown",
  csv: "CSV", rust: "Rust", go: "Go", java: "Java", c: "C", cpp: "C++", cs: "C#", xml: "XML", toml: "TOML",
};

const PREVIEWABLE_LANGS = new Set(["html", "htm", "svg", "markdown", "md", "csv", "json"]);

function CodeBlock({
  code,
  lang,
  onPreview,
}: {
  code: string;
  lang: string;
  onPreview?: (code: string, lang: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const normLang = lang.toLowerCase().trim();
  const label = LANG_LABEL[normLang] || (lang ? lang.toUpperCase() : "Code");
  const lines = code.split("\n").length;
  const looksHtml = !normLang && /^\s*<(?:!doctype|html|svg)\b/i.test(code);
  const previewLang = looksHtml ? (/^\s*<svg\b/i.test(code) ? "svg" : "html") : normLang;
  const canPreview = Boolean(onPreview && (PREVIEWABLE_LANGS.has(previewLang) || looksHtml));

  const copy = async () => {
    if (await copyToClipboard(code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  const download = () => {
    const ext = previewLang === "html" || previewLang === "htm" ? "html"
      : previewLang === "svg" ? "svg"
      : previewLang === "csv" ? "csv"
      : previewLang === "json" ? "json"
      : previewLang === "markdown" || previewLang === "md" ? "md"
      : normLang || "txt";
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snippet.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{label} <span className="md-code-lines">· {lines} Z.</span></span>
        <div className="md-code-actions">
          {canPreview && (
            <button type="button" className="md-code-copy is-preview"
              onClick={() => onPreview?.(code, previewLang || "html")}
              aria-label="In Seiten-Vorschau öffnen">
              ▶ Vorschau
            </button>
          )}
          <button type="button" className="md-code-copy" onClick={download} aria-label="Als Datei herunterladen">
            Laden
          </button>
          <button type="button" className="md-code-copy" onClick={copy} aria-label="Code kopieren">
            {copied ? "✓ Kopiert" : "Kopieren"}
          </button>
        </div>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export default function RichText({
  text,
  onPreviewCode,
  onPreviewUrl,
}: {
  text: string;
  onPreviewCode?: (code: string, lang: string) => void;
  onPreviewUrl?: (url: string, title?: string) => void;
}) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let textStart = 0;

  const pushProse = (from: number, to: number) => {
    if (to <= from) return;
    const content = prose(lines.slice(from, to), `t${from}`, onPreviewUrl);
    if (content.length) blocks.push(<Fragment key={`prose-${from}`}>{content}</Fragment>);
  };

  while (index < lines.length) {
    const fence = /^\s*```(.*)$/.exec(lines[index]);
    if (!fence) {
      index += 1;
      continue;
    }
    pushProse(textStart, index);
    const lang = fence[1].trim();
    const code: string[] = [];
    index += 1;
    while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
      code.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) index += 1;
    const rawCode = code.join("\n");
    if (lang.toLowerCase() === "chart") {
      try {
        const parsed = JSON.parse(rawCode) as ChartSpec;
        if (parsed && Array.isArray(parsed.labels) && Array.isArray(parsed.series)) {
          blocks.push(<ChartBlock key={`chart-${index}`} spec={parsed} />);
          textStart = index;
          continue;
        }
      } catch { /* als Codeblock anzeigen */ }
    }
    blocks.push(
      <CodeBlock key={`code-${index}`} code={rawCode} lang={lang} onPreview={onPreviewCode} />,
    );
    textStart = index;
  }
  pushProse(textStart, lines.length);

  return <div className="msg-text">{blocks.length ? blocks : <p>{inline(text, "empty", 0, onPreviewUrl)}</p>}</div>;
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function changeRows(before: Record<string, unknown> | null,
                           after: Record<string, unknown> | null): Array<[string, string, string]> {
  if (!before || !after) return [];
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter((k) => !k.startsWith("_"));
  return keys.map((key) => [key, formatValue(before[key]), formatValue(after[key])]);
}
