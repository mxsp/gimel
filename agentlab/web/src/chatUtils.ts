import { IconName } from "@blueprintjs/core";
import { Attachment, Chat, Change, Message } from "./api";
import { toolLabel } from "./toolLabels";

export type LiveTool = {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  summary: string;
  preview: string;
  durationMs?: number;
  step?: number;
  action?: Record<string, unknown>;
  changeId?: number | null;
  changeReversible?: boolean;
  changeSummary?: string;
};

export function formatDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

/** Dateigröße kurz und deutsch. */
export function sizeText(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

export function fileKind(attachment: Attachment): string {
  const ext = attachment.filename.split(".").pop()?.toUpperCase().slice(0, 4) || "DATEI";
  return attachment.content_type === "application/pdf" || ext === "PDF" ? "PDF" : ext;
}

export function isPdf(attachment: Pick<Attachment, "filename" | "content_type">): boolean {
  return attachment.content_type === "application/pdf"
    || attachment.filename.toLowerCase().endsWith(".pdf");
}

export function attachmentMeta(attachment: Attachment): string {
  const parts: string[] = [sizeText(attachment.size)];
  if (attachment.pages) parts.push(`${attachment.pages} Seiten`);
  if (attachment.ocr) parts.push("OCR");
  if (attachment.truncated) parts.push("gekürzt");
  return parts.join(" · ");
}

export function messageToolCards(message: Message, toolResults: Map<string, Message>): Array<{ call: any; result?: Message }> {
  return (message.tool_calls || []).map((call: any) => ({
    call,
    result: toolResults.get(call.id),
  }));
}

export function persistedTool(tool: { call: any; result?: Message }): LiveTool {
  let args: unknown = {};
  try { args = JSON.parse(tool.call?.function?.arguments || "{}"); } catch { /* leer */ }
  let summary = "";
  let preview = "";
  let status: "running" | "ok" | "error" = tool.result ? "ok" : "running";
  let action: Record<string, unknown> | undefined;
  let changeId: number | null = null;
  let changeReversible: boolean | undefined;
  let changeSummary = "";
  if (tool.result) {
    try {
      const parsed = JSON.parse(tool.result.content || "{}");
      summary = parsed.summary || parsed.error || "";
      preview = tool.result.content;
      if (parsed.ok === false || (parsed.error && !parsed.summary)) status = "error";
      if (parsed.client_action && typeof parsed.client_action === "object") {
        action = parsed.client_action as Record<string, unknown>;
      }
      changeId = parsed.change_id ?? null;
      changeReversible = parsed.change_reversible;
      changeSummary = parsed.change_summary || "";
    } catch {
      preview = tool.result.content || "";
    }
  }
  return {
    id: tool.call?.id || String(tool.result?.id || ""),
    name: tool.call?.function?.name || tool.result?.name || "tool",
    args,
    status,
    summary: changeSummary || summary,
    preview,
    action,
    changeId,
    changeReversible,
  };
}

/** Ein Symbol je Werkzeugfamilie; der Name bleibt daneben stehen. */
export function toolIcon(name: string): IconName {
  if (/^(sandbox_exec|sandbox_run_python)$/.test(name)) return "console";
  if (/^(sandbox_create|sandbox_list_files)$/.test(name)) return "cube";
  if (/^(sandbox_write_file|sandbox_read_file)$/.test(name)) return "document-open";
  if (/^sandbox_export_artifact$/.test(name)) return "export";
  if (/^sandbox_destroy$/.test(name)) return "stop";
  if (/^(web_search|fetch_url)$/.test(name)) return "globe-network";
  if (/^(create_artifact|update_artifact|generate_report_html)$/.test(name)) return "application";
  if (/^(generate_chart_artifact)$/.test(name)) return "grouped-bar-chart";
  if (/^(open_preview)$/.test(name)) return "eye-open";
  if (/^(list_artifacts|get_artifact|read_attachment|search_attachments)$/.test(name)) return "document";
  if (/^(parse_structured_data|compare_orders|get_daily_briefing|get_kpis)$/.test(name)) return "th-derived";
  if (/^(calculate|convert_units)$/.test(name)) return "calculator";
  if (/^(discover_tools|search_|global_search|list_|get_)/.test(name)) return "search";
  if (/^(propose_)/.test(name)) return "endorsed";
  if (/^(create_|add_)/.test(name)) return "add";
  if (/^(delete_|remove_)/.test(name)) return "trash";
  if (/^(update_|set_|assign_|mark_|toggle_|adjust_|stage_|pin_|unpin_|block_|clone_|reorder_|upsert_)/.test(name)) return "edit";
  if (/^start_/.test(name)) return "play";
  return "wrench";
}

export function toolTone(name: string): "read" | "write" {
  if (/^(create_artifact|update_artifact|generate_|open_preview|propose_)/.test(name)) return "read";
  return /^(create_|delete_|update_|set_|assign_|mark_|toggle_|adjust_|stage_|pin_|unpin_|block_|clone_|reorder_|upsert_|start_|move_|rotate_|save_)/.test(name)
    ? "write" : "read";
}

export function formatUsage(messages: Message[]): { prompt: number; completion: number; total: number } {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  for (const message of messages) {
    const usage = (message.usage || {}) as Record<string, unknown>;
    const p = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    const c = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
    const t = Number(usage.total_tokens ?? 0) || p + c;
    prompt += p;
    completion += c;
    total += t;
  }
  return { prompt, completion, total };
}

export function formatTokens(value: number): string {
  if (!value) return "–";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days === 1) return "gestern";
  if (days < 7) return `vor ${days} Tagen`;
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "short" });
}

export function timeText(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/** Kurze Vorschau für die Chatliste: Markdown wird zu lesbarem Fließtext. */
export function plainPreview(text: string, max = 120): string {
  const lines = (text || "").replace(/\r\n?/g, "\n").split("\n").map((line) => {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").join(" ");
    }
    return line;
  });
  const plain = lines.join(" ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\|?\s*:?-{3,}:?\s*\|/g, " ")
    .replace(/\|/g, " ")
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max).trimEnd()}…` : plain;
}

export function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return Promise.resolve(ok);
  } catch {
    return Promise.resolve(false);
  }
}

function attachmentLine(attachment: Attachment): string {
  return `- ${attachment.filename} (${attachmentMeta(attachment)})`;
}

/** Ganzes Gespräch als Markdown — für Ablage, E-Mail oder Prüfung. */
export function chatToMarkdown(chat: Chat, messages: Message[], changes: Change[]): string {
  const lines: string[] = [
    `# ${chat.title || "Chat"}`,
    "",
    `Export aus dem Gimel Agent Lab · ${new Date().toLocaleString("de-DE")}`,
    "",
  ];
  const toolResults = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) toolResults.set(message.tool_call_id, message);
  }
  for (const message of messages) {
    if (message.role === "tool") continue;
    lines.push(message.role === "user" ? "## Sie" : "## Assistent");
    if (message.content) lines.push("", message.content);
    const attachments = message.attachments ?? [];
    if (attachments.length) {
      lines.push("", "**Anhänge**", "", ...attachments.map(attachmentLine));
    }
    if (message.role === "assistant") {
      for (const tool of messageToolCards(message, toolResults)) {
        const live = persistedTool(tool);
        lines.push("", `> Werkzeug: ${toolLabel(live.name)} (\`${live.name}\`)`);
        if (live.summary) lines.push(`> ${live.summary}`);
      }
    }
    lines.push("");
  }
  if (changes.length) {
    lines.push("## Änderungen", "");
    for (const change of changes) {
      lines.push(`- ${change.summary || change.tool} · ${change.entity} ${change.entity_id} · ${change.status === "reverted" ? "zurückgenommen" : "offen"}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
