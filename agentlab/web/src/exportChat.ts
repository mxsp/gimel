import type { Change, ChatDetail, Message } from "./api";
import { toolLabel } from "./toolLabels";

export interface MessageTokens {
  prompt: number;
  completion: number;
  total: number;
  cost: number;
  list_cost: number;
  has_cost: boolean;
  has_list_cost: boolean;
}

/** Token einer Nachricht, wie der Anbieter sie gemeldet hat — sonst null. */
export function messageTokens(message: Message): MessageTokens | null {
  const usage = message.usage ?? {};
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens);
  const completion = num(usage.completion_tokens ?? usage.output_tokens);
  const total = num(usage.total_tokens) || prompt + completion;
  const opencode = usage.opencode && typeof usage.opencode === "object"
    ? usage.opencode as Record<string, unknown> : {};
  return total > 0 ? {
    prompt, completion, total,
    cost: num(usage.cost),
    list_cost: num(opencode.list_cost),
    has_cost: "cost" in usage,
    has_list_cost: "list_cost" in opencode,
  } : null;
}

export function sumTokens(messages: Message[]): MessageTokens & { counted: number } {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let cost = 0;
  let list_cost = 0;
  let has_cost = false;
  let has_list_cost = false;
  let counted = 0;
  for (const message of messages) {
    const t = messageTokens(message);
    if (!t) continue;
    prompt += t.prompt;
    completion += t.completion;
    total += t.total;
    cost += t.cost;
    list_cost += t.list_cost;
    has_cost = has_cost || t.has_cost;
    has_list_cost = has_list_cost || t.has_list_cost;
    counted += 1;
  }
  return { prompt, completion, total, cost, list_cost, has_cost, has_list_cost, counted };
}

export function tokenText(total: number): string {
  return `${total.toLocaleString("de-DE")} Token`;
}

/** Kosten kommen in USD vom Anbieter; winzige Beträge bleiben sichtbar. */
export function costText(value: number): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency", currency: "USD",
    minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(value || 0);
}

function stamp(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("de-DE");
}

function fence(text: string, lang = ""): string {
  // Ein Zaun ist immer länger als die längste Backtick-Folge im Inhalt.
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function changeLine(change: Change): string {
  const state = change.status === "reverted" ? "zurückgenommen" : "angewendet";
  return `- ${change.summary || `${toolLabel(change.tool)} ${change.entity} ${change.entity_id}`} (${state})`;
}

/** Der Chat als lesbares Markdown: Fragen, Antworten, Werkzeugaufrufe, Änderungen. */
export function chatToMarkdown(detail: ChatDetail): string {
  const { chat, messages, changes } = detail;
  const lines: string[] = [
    `# ${chat.title || "Chat"}`,
    "",
    `Exportiert ${stamp(new Date().toISOString())} · Modell ${chat.model || "—"} · Schreibmodus ${chat.write_mode ? "an" : "aus"}`,
    "",
  ];
  const results = new Map<string, Message>();
  for (const m of messages) if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m);
  const byMessage = new Map<number, Change[]>();
  for (const c of changes) {
    if (c.message_id != null) byMessage.set(c.message_id, [...(byMessage.get(c.message_id) ?? []), c]);
  }
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`## Frage · ${stamp(m.created_at)}`, "", m.content || "", "");
      for (const a of m.attachments ?? []) lines.push(`> Anhang: ${a.filename}`);
      if (m.attachments?.length) lines.push("");
    } else if (m.role === "assistant") {
      const calls = m.tool_calls ?? [];
      if (m.content) lines.push(`## Antwort · ${stamp(m.created_at)}`, "", m.content, "");
      for (const call of calls) {
        const res = results.get(call.id);
        lines.push(`**Werkzeug:** ${toolLabel(call.function.name)} (\`${call.function.name}\`)`, "");
        lines.push(fence(call.function.arguments || "{}", "json"), "");
        if (res?.content) {
          const short = res.content.length > 4000 ? `${res.content.slice(0, 4000)}\n… gekürzt` : res.content;
          lines.push("<details><summary>Ergebnis</summary>", "", fence(short, "json"), "", "</details>", "");
        }
      }
      const own = byMessage.get(m.id) ?? [];
      if (own.length) lines.push("**Änderungen:**", ...own.map(changeLine), "");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function chatToJson(detail: ChatDetail): string {
  return JSON.stringify({ exported_at: new Date().toISOString(), ...detail }, null, 2);
}

export function safeFilename(title: string): string {
  const base = (title || "chat").normalize("NFKD").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-");
  return (base || "chat").slice(0, 60);
}

export function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
