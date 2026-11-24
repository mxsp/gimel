import {
  Button, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, Icon, InputGroup, Menu,
  MenuItem, Popover, Spinner, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, Artifact, Attachment, cancelChat, Chat, ChatDetail, Change, deleteAttachment,
  getChat, loadProviderModels, Message, ModelInfo, Provider, readChatSandboxFile, revertChange,
  rewindChat, SandboxFile, SessionUser, streamMessage, updateChat, uploadAttachment,
} from "./api";
import BotSmiley from "./BotSmiley";
import ChatContext from "./ChatContext";
import {
  attachmentMeta, fileKind, isPdf, LiveTool, messageToolCards, persistedTool, timeText,
} from "./chatUtils";
import CopyButton from "./CopyButton";
import {
  chatToJson, chatToMarkdown, costText, downloadText, safeFilename, sumTokens, tokenText,
} from "./exportChat";
import { contextChip, toWire, usePageContextSnapshot } from "./pageContext";
import PreviewPane, { inferKindFromFilename, PreviewTab } from "./PreviewPane";
import PromptMenu, { PromptMenuHandle, slashQuery, useBuiltinPrompts } from "./PromptMenu";
import RichText, { changeRows } from "./format";
import SubagentPanel from "./SubagentPanel";
import { toolLabel } from "./toolLabels";
import ToolTable from "./ToolTable";
import { useDictation, useReadAloud } from "./voice";
import MicPanel, { LevelMeter } from "./voiceInput/MicPanel";
import { useVoiceInput } from "./voiceInput/useVoiceInput";

/* Das Browser-Diktat (Web Speech) schickt das Audio an den Dienst des Browser-
   Herstellers (Chrome: Google, Edge: Microsoft). Es bleibt
   nur Rückfall, wenn dieser Server nicht selbst erkennt, und nur auf diesem Rechner
   oder im Hausnetz — nie auf einer öffentlich erreichbaren Adresse (task 43). */
function privateHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  if (h === "localhost" || h === "::1" || h === "[::1]" || /\.localhost$/.test(h)) return true;
  // Nur echte IPv4-Adressen, kein Name wie „10.example.com“.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((x) => Number(x) > 255)) return false;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

type LiveTurn = {
  content: string;
  reasoning: string;
  tools: LiveTool[];
  error: string;
  step?: number;
  maxSteps?: number;
  synthesizing?: boolean;
};

const emptyTurn = (): LiveTurn => ({ content: "", reasoning: "", tools: [], error: "" });
const STEP_PRESETS = ["auto", "15", "25", "40", "60", "100"] as const;
const STEP_PREF_PREFIX = "agentlab-step-budget-";

function readStepPref(kind?: string): string {
  const k = kind === "orchestrator" ? "orchestrator" : "classic";
  try {
    const raw = localStorage.getItem(STEP_PREF_PREFIX + k);
    return raw && (STEP_PRESETS as readonly string[]).includes(raw) ? raw : "auto";
  } catch {
    return "auto";
  }
}

function writeStepPref(kind: string | undefined, value: string): void {
  const k = kind === "orchestrator" ? "orchestrator" : "classic";
  try { localStorage.setItem(STEP_PREF_PREFIX + k, value); } catch { /* egal */ }
}

const ACCEPT = ".pdf,.txt,.md,.markdown,.csv,.json,.log,.html,.htm,.svg,.xml,.css,.js,.ts,.tsx,.jsx,.py,.yaml,.yml,.sql";
const PREVIEW_WIDTH_KEY = "agentlab-preview-width";
const cachedProviderModels = new Map<number, ModelInfo[]>();
const attemptedProviderModelFetch = new Set<number>();

/** Eine Antwort ist ein Zug, nicht jeder Werkzeugschritt.
 *
 * Der Lauf speichert für jede Modellrunde eine Assistentenzeile — auch die
 * reinen Werkzeugrunden ohne Text. Ungegruppiert bekäme jeder Schritt eine
 * eigene Sprechblase mit eigener Tabelle, und die Antwort zerfiele optisch in
 * fünf „Assistent“-Blöcke. Hier werden alle Assistentenzeilen zwischen zwei
 * Nutzernachrichten zu einer Antwort zusammengefasst; Werkzeugzeilen trennen
 * die Gruppe nicht. */
type ChatTurn =
  | { role: "user"; message: Message }
  | { role: "assistant"; messages: Message[] };

function groupTurns(messages: Message[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ role: "user", message });
      continue;
    }
    if (message.role !== "assistant") continue;
    const last = turns[turns.length - 1];
    if (last?.role === "assistant") last.messages.push(message);
    else turns.push({ role: "assistant", messages: [message] });
  }
  return turns;
}


function AttachmentChips({ items, onRemove, onPreview }: {
  items: Attachment[];
  onRemove?: (id: number) => void;
  onPreview?: (item: Attachment) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="attachment-row">
      {items.map((item) => (
        <span className={`attachment-chip ${onPreview ? "is-clickable" : ""}`} key={item.id}
          title={`${item.filename} · ${attachmentMeta(item)} · ${item.chars} Zeichen${onPreview ? " — Klicken für Vorschau" : ""}`}
          onClick={onPreview ? () => onPreview(item) : undefined}
          role={onPreview ? "button" : undefined}
          tabIndex={onPreview ? 0 : undefined}
          onKeyDown={onPreview ? (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPreview(item); }
          } : undefined}>
          <span className={`attachment-icon ${isPdf(item) ? "" : "text"}`} aria-hidden="true">
            {fileKind(item)}
          </span>
          <span className="attachment-name">{item.filename}</span>
          <span className="attachment-meta">
            {item.ocr ? "OCR" : item.pages ? `${item.pages} S.` : `${Math.max(1, Math.round(item.chars / 1000))}k Z.`}
          </span>
          {onRemove && (
            <button type="button" className="attachment-remove" aria-label={`${item.filename} entfernen`}
              onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}>×</button>
          )}
        </span>
      ))}
    </div>
  );
}

function ArtifactCard({
  artifact,
  onOpen,
  compact = false,
}: {
  artifact: Artifact;
  onOpen?: (art: Artifact) => void;
  compact?: boolean;
}) {
  const [inlineOpen, setInlineOpen] = useState(false);
  const canInline = ["html", "svg", "markdown", "csv", "json"].includes(artifact.kind);

  const handleCardClick = () => {
    if (onOpen) onOpen(artifact);
    else if (canInline) setInlineOpen((v) => !v);
  };

  const download = (e: React.MouseEvent) => {
    e.stopPropagation();
    const mime = artifact.kind === "html" ? "text/html;charset=utf-8"
      : artifact.kind === "svg" ? "image/svg+xml;charset=utf-8"
      : artifact.kind === "csv" ? "text/csv;charset=utf-8"
      : artifact.kind === "json" ? "application/json;charset=utf-8"
      : "text/plain;charset=utf-8";
    const blob = new Blob([artifact.content || ""], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = artifact.filename || `${artifact.title}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className={`artifact-card-box ${inlineOpen ? "is-open" : ""}`}>
      <div className="artifact-card" role="button" tabIndex={0} onClick={handleCardClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCardClick(); } }}>
        <span className="artifact-card-icon" aria-hidden="true">
          <Icon icon={artifact.kind === "svg" ? "media" : artifact.kind === "csv" ? "th" : "application"} size={16} />
        </span>
        <span className="artifact-card-main">
          <strong>{artifact.title}</strong>
          <span>{artifact.kind.toUpperCase()} · v{artifact.version} · {artifact.chars.toLocaleString("de-DE")} Zeichen</span>
        </span>
        <span className="artifact-card-actions">
          {canInline && (
            <Button small minimal icon={inlineOpen ? "chevron-up" : "chevron-down"}
              text={compact ? undefined : (inlineOpen ? "Ausblenden" : "Inline")}
              title="Direkt im Chat anzeigen"
              onClick={(e) => { e.stopPropagation(); setInlineOpen((v) => !v); }} />
          )}
          <Button small minimal icon="download" title="Herunterladen" onClick={download} />
          {onOpen && (
            <Button small intent="primary" icon="eye-open" text={compact ? undefined : "Vorschau"}
              title="In der Vorschau öffnen"
              onClick={(e) => { e.stopPropagation(); onOpen(artifact); }} />
          )}
        </span>
      </div>
      {inlineOpen && (
        <div className="artifact-inline-stage">
          {artifact.kind === "html" ? (
            <iframe
              srcDoc={artifact.content || ""}
              title={artifact.title}
              className="artifact-inline-iframe"
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
            />
          ) : artifact.kind === "svg" ? (
            <iframe
              srcDoc={`<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:220px;background:#fbfaf7">${artifact.content || ""}</body></html>`}
              title={artifact.title}
              className="artifact-inline-iframe is-svg"
              sandbox=""
            />
          ) : artifact.kind === "markdown" ? (
            <div className="artifact-inline-md"><RichText text={artifact.content || ""} /></div>
          ) : (
            <pre className="artifact-inline-pre"><code>{artifact.content || ""}</code></pre>
          )}
        </div>
      )}
    </div>
  );
}

function ChangeCard({ change, onRevert }: { change: Change; onRevert: (id: number) => void }) {
  const reverted = change.status === "reverted";
  const rows = changeRows(change.before, change.after);
  return (
    <div className={`change-card ${reverted ? "is-reverted" : ""}`}>
      <div className="change-main">
        <div className="change-title">
          {change.summary || `${toolLabel(change.tool)} · ${change.entity} ${change.entity_id}`}
        </div>
        {rows.length > 0 && (
          <table className="diff-table">
            <thead><tr><th>Feld</th><th>vorher</th><th>nachher</th></tr></thead>
            <tbody>
              {rows.map(([key, before, after]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td><code>{before}</code></td>
                  <td><code>{after}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!rows.length && <div className="diff">{change.after ? "angelegt" : "geändert"}</div>}
      </div>
      {!reverted && change.reversible && (
        <Button small minimal icon="undo" text="Rückgängig" onClick={() => onRevert(change.id)} />
      )}
      {reverted && <Tag minimal>zurückgenommen</Tag>}
    </div>
  );
}

const CTX_PREF = "gimel-copilot-context";

function readCtxPref(): boolean {
  try { return localStorage.getItem(CTX_PREF) !== "0"; } catch { return true; }
}

function writeCtxPref(on: boolean): void {
  try { localStorage.setItem(CTX_PREF, on ? "1" : "0"); } catch { /* egal */ }
}

export default function ChatPane({
  user, chat, providers, compact = false, contextOpen = true, refreshToken = 0,
  previewOpen, previewRequest, autoPrompt, onAutoPromptConsumed,
  onPreviewOpenChange, onArtifactCountChange, onOpenArtifact, onOpenPreviewTab,
  onChatUpdated, onChatsChanged, onOpenFull, onToggleContext, onOpenChanges, onOpenGraph,
}: {
  user: SessionUser;
  chat: Chat;
  providers: Provider[];
  compact?: boolean;
  contextOpen?: boolean;
  refreshToken?: number;
  previewOpen?: boolean;
  previewRequest?: { nonce: number; tab: PreviewTab } | null;
  autoPrompt?: { nonce: number; chatId: number; text: string } | null;
  onAutoPromptConsumed?: () => void;
  onPreviewOpenChange?: (open: boolean) => void;
  onArtifactCountChange?: (count: number) => void;
  onOpenArtifact?: (art: Artifact) => void;
  onOpenPreviewTab?: (tab: PreviewTab) => void;
  onChatUpdated: (chat: Chat) => void;
  onChatsChanged: () => void;
  onOpenFull?: () => void;
  onToggleContext?: () => void;
  onOpenChanges?: () => void;
  onOpenGraph?: () => void;
}) {
  const pageCtx = usePageContextSnapshot();
  const [ctxOn, setCtxOn] = useState(readCtxPref);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [live, setLive] = useState<LiveTurn>(emptyTurn());
  const [streaming, setStreaming] = useState(false);
  const [localPrompt, setLocalPrompt] = useState("");
  const [localFiles, setLocalFiles] = useState<Attachment[]>([]);
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [lockedFile, setLockedFile] = useState<File | null>(null);
  const [pdfNeedsPassword, setPdfNeedsPassword] = useState(false);
  const [pdfPassword, setPdfPassword] = useState("");
  const [pdfPages, setPdfPages] = useState("");
  const [pdfError, setPdfError] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadSeq = useRef(0);
  const promptRef = useRef<PromptMenuHandle>(null);
  const [menuForced, setMenuForced] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [rewinding, setRewinding] = useState<{ message: Message; mode: "edit" | "regenerate"; openChanges: number } | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [activeOption, setActiveOption] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState("");
  const builtin = useBuiltinPrompts();

  /* Seiten-Vorschau & eingebauter Browser (Side Preview Frame) */
  const [localPreviewOpen, setLocalPreviewOpen] = useState(false);
  const isPreviewOpen = previewOpen ?? localPreviewOpen;
  const setPreviewOpen = useCallback((next: boolean) => {
    setLocalPreviewOpen(next);
    onPreviewOpenChange?.(next);
  }, [onPreviewOpenChange]);
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [previewWidth, setPreviewWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
      return Number.isFinite(saved) && saved >= 340 && saved <= 1100 ? saved : 560;
    } catch { return 560; }
  });
  const [resizingPreview, setResizingPreview] = useState(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [stepBudget, setStepBudget] = useState<string>(() => readStepPref(chat.kind));
  const [budgetNotice, setBudgetNotice] = useState<{ steps: number; maxSteps: number } | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    setStepBudget(readStepPref(chat.kind));
    setBudgetNotice(null);
  }, [chat.id, chat.kind]);

  useEffect(() => {
    if (!streaming) {
      setElapsedSec(0);
      return;
    }
    const started = Date.now();
    const iv = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(iv);
  }, [streaming]);

  const hasSidePreview = !compact || Boolean(onOpenPreviewTab);

  const openOrFocusTab = useCallback((tab: PreviewTab) => {
    if (compact && onOpenPreviewTab) {
      onOpenPreviewTab(tab);
      return;
    }
    setPreviewTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tab.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...tab };
        return next;
      }
      return [...prev, tab];
    });
    setActivePreviewId(tab.id);
    if (!compact) setPreviewOpen(true);
  }, [compact, onOpenPreviewTab, setPreviewOpen]);

  const updatePreviewTab = useCallback((id: string, patch: Partial<PreviewTab>) => {
    setPreviewTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const closePreviewTab = useCallback((id: string) => {
    setPreviewTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActivePreviewId((cur) => (cur === id ? (next[next.length - 1]?.id ?? null) : cur));
      return next;
    });
  }, []);

  const openArtifactPreview = useCallback((art: Artifact) => {
    openOrFocusTab({
      id: `art-${art.id}`,
      source: "artifact",
      artifactId: art.id,
      title: art.title,
      kind: art.kind,
      filename: art.filename,
      language: art.language,
      content: art.content,
      version: art.version,
      dirty: false,
    });
  }, [openOrFocusTab]);

  const openAttachmentPreview = useCallback((att: Attachment) => {
    openOrFocusTab({
      id: `file-${att.id}`,
      source: "file",
      attachmentId: att.id,
      title: att.filename,
      filename: att.filename,
      kind: inferKindFromFilename(att.filename, att.content_type),
    });
  }, [openOrFocusTab]);

  const openSandboxFilePreview = useCallback(async (file: SandboxFile) => {
    try {
      const res = await readChatSandboxFile(chat.id, file.path);
      const name = file.path.split("/").pop() || file.path;
      const kind = inferKindFromFilename(name, "");
      openOrFocusTab({
        id: `sbx-${chat.id}-${file.path}`,
        source: "artifact",
        title: `Container: ${name}`,
        filename: name,
        kind,
        content: res.content,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [chat.id, openOrFocusTab]);

  const openCodePreview = useCallback((code: string, lang: string, customTitle?: string) => {
    const kind = inferKindFromFilename("", "", lang);
    const label = customTitle || `${kind.toUpperCase()}-Vorschau`;
    const key = `code-${kind}-${code.length}-${code.slice(0, 24).replace(/\W+/g, "")}`;
    openOrFocusTab({
      id: key,
      source: "artifact",
      title: label,
      kind,
      language: lang,
      filename: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${kind === "markdown" ? "md" : kind}`,
      content: code,
      dirty: true,
    });
  }, [openOrFocusTab]);

  const openUrlPreview = useCallback((url: string, title?: string) => {
    openOrFocusTab({
      id: `web-${url}`,
      source: "web",
      kind: "web",
      title: title || url.replace(/^https?:\/\//, "").slice(0, 42) || url,
      url,
      history: [url],
      historyIndex: 0,
      webMode: "direct",
    });
  }, [openOrFocusTab]);

  const openPreviewAction = useCallback((action: Record<string, unknown>) => {
    if (action.type !== "open_preview") return;
    const source = String(action.source || "");
    if (source === "artifact") {
      const aid = Number(action.artifact_id);
      openOrFocusTab({
        id: Number.isFinite(aid) ? `art-${aid}` : `art-${Date.now()}`,
        source: "artifact",
        artifactId: Number.isFinite(aid) ? aid : undefined,
        title: String(action.title || "Artefakt"),
        kind: String(action.kind || "html"),
        filename: String(action.filename || ""),
        language: String(action.language || ""),
        content: String(action.content || ""),
        version: Number(action.version || 1),
        dirty: false,
      });
    } else if (source === "attachment") {
      const attId = Number(action.attachment_id);
      const fname = String(action.filename || action.title || "Datei");
      openOrFocusTab({
        id: Number.isFinite(attId) ? `file-${attId}` : `file-${Date.now()}`,
        source: "file",
        attachmentId: Number.isFinite(attId) ? attId : undefined,
        title: String(action.title || fname),
        filename: fname,
        kind: inferKindFromFilename(fname, String(action.content_type || "")),
      });
    } else if (source === "url" && action.url) {
      openUrlPreview(String(action.url), String(action.title || ""));
    }
  }, [openOrFocusTab, openUrlPreview]);

  useEffect(() => {
    if (!previewRequest) return;
    openOrFocusTab(previewRequest.tab);
  }, [previewRequest?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const consumedAutoRef = useRef<number>(0);
  useEffect(() => {
    if (!autoPrompt || autoPrompt.chatId !== chat.id) return;
    if (consumedAutoRef.current === autoPrompt.nonce) return;
    consumedAutoRef.current = autoPrompt.nonce;
    onAutoPromptConsumed?.();
    window.setTimeout(() => {
      sendTextRef.current(autoPrompt.text, []);
    }, 60);
  }, [autoPrompt, chat.id, onAutoPromptConsumed]);

  useEffect(() => {
    onArtifactCountChange?.((detail?.artifacts?.length ?? 0) + previewTabs.filter((t) => !t.artifactId).length);
  }, [detail?.artifacts?.length, previewTabs, onArtifactCountChange]);

  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => { resizeCleanupRef.current?.(); }, []);

  const startResizePreview = (e: React.MouseEvent) => {
    e.preventDefault();
    resizeCleanupRef.current?.();
    setResizingPreview(true);
    const startX = e.clientX;
    const startW = previewWidth;
    const layoutWidth = chatLayoutRef.current?.clientWidth || window.innerWidth;
    const maxW = Math.max(360, Math.min(Math.round(window.innerWidth * 0.72), layoutWidth - 340));
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(360, Math.min(maxW, startW + (startX - ev.clientX)));
      setPreviewWidth(next);
    };
    const cleanup = () => {
      setResizingPreview(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", cleanup);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", cleanup);
  };

  useEffect(() => {
    try { localStorage.setItem(PREVIEW_WIDTH_KEY, String(previewWidth)); } catch { /* egal */ }
  }, [previewWidth]);

  /* Diktat schreibt in das Eingabefeld; Vorlesen liest die Antwort satzweise,
     während sie eintrifft. Beides läuft im Browser, ohne Server. */
  const liveContentRef = useRef("");
  const dictation = useDictation(setInput, setVoiceError);
  const read = useReadAloud();

  /* Spracheingabe auf diesem Rechner (faster-whisper über /api/agent/transcribe),
     wo der Server sie hat: Labor und Twin Studio. Der Text landet im Eingabefeld
     und wird vor dem Senden geprüft. Im Live-Gespräch geht er sofort los, die
     Antwort wird gesprochen, danach hört der Assistent wieder zu. */
  const [talk, setTalk] = useState(false);
  const talkRef = useRef(false);
  talkRef.current = talk;
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const activeChatIdRef = useRef(chat.id);
  activeChatIdRef.current = chat.id;
  const voiceInStartRef = useRef<() => void>(() => undefined);
  const talkMisses = useRef(0);
  const readBeforeTalk = useRef(false);
  const sendTextRef = useRef<(content: string, files: Attachment[]) => void>(() => undefined);
  const voiceIn = useVoiceInput((text) => {
    talkMisses.current = 0;
    if (talkRef.current) { sendTextRef.current(text, []); return; }
    setInput((cur) => (cur.trim() ? `${cur.trimEnd()} ${text}` : text));
    window.setTimeout(() => textRef.current?.focus(), 0);
  });
  voiceInStartRef.current = voiceIn.start;
  const browserDictation = dictation.supported && voiceIn.server === null && privateHost();
  const micOn = voiceIn.phase !== "idle" || dictation.listening;
  const edgeNote = voiceIn.server?.tts_backend === "edge"
    ? " – der Antworttext geht dafür an Microsoft (USA, ohne Vertrag mit FyreFly). Nur mit Testdaten." : "";

  const load = useCallback(async (silent = false) => {
    const ticket = ++loadSeq.current;
    if (!silent) setLoading(true);
    try {
      const next = await getChat(chat.id);
      if (ticket !== loadSeq.current) return;
      setDetail(next);
      setPending(next.attachments ?? []);
      setError("");
    } catch (err) {
      if (ticket !== loadSeq.current) return;
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      if (ticket === loadSeq.current) setLoading(false);
    }
  }, [chat.id]);

  useEffect(() => {
    setDetail(null);
    setLive(emptyTurn());
    setStreaming(false);
    setLocalPrompt("");
    setLocalFiles([]);
    setPending([]);
    setError("");
    setAtBottom(true);
    setEditing(null);
    setPreviewTabs([]);
    setActivePreviewId(null);
    setChatSearch("");
    setChatSearchOpen(false);
    liveContentRef.current = "";
    dictation.stop();
    read.stop();
    if (talkRef.current) endTalk();
    else voiceIn.cancel();
    load();
  }, [chat.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!streamingRef.current) load(true);
  }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Nach einem Tabwechsel kann der Chat veraltet sein. Wenn die Seite wieder
     sichtbar wird, lesen wir leise nach — ohne den laufenden Strom zu stören. */
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible" && !streamingRef.current) load(true);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  useEffect(() => {
    const draftKey = `agentlab-draft-${chat.id}`;
    setInput(localStorage.getItem(draftKey) ?? "");
  }, [chat.id]);

  useEffect(() => {
    if (streaming) return;
    const draftKey = `agentlab-draft-${chat.id}`;
    if (input.trim()) localStorage.setItem(draftKey, input);
    else localStorage.removeItem(draftKey);
  }, [input, chat.id, streaming]);

  // Eine laufende Antwort darf beim Chat- oder Ansichtswechsel NICHT abgebrochen
  // werden: der Streaming-Request bleibt im Hintergrund aktiv und schreibt seine
  // Nachrichten in die Datenbank. Nur „Unterbrechen“ (stop()) bricht ihn ab.
  // Der AbortController wird bewusst nicht beim Unmount ausgelöst.

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (atBottom) scrollToBottom();
  }, [detail, live, localPrompt, atBottom, scrollToBottom]);

  const [fetchedModels, setFetchedModels] = useState<Record<number, ModelInfo[]>>(
    () => Object.fromEntries(cachedProviderModels.entries()),
  );
  const provider = useMemo(
    () => providers.find((p) => p.id === chat.provider_id)
      ?? providers.find((p) => p.is_default)
      ?? providers.find((p) => p.enabled),
    [providers, chat.provider_id],
  );
  useEffect(() => {
    if (!provider) return;
    if (provider.models.length > 0) {
      cachedProviderModels.set(provider.id, provider.models);
      return;
    }
    if (cachedProviderModels.has(provider.id) || attemptedProviderModelFetch.has(provider.id)) return;
    if (!provider.has_key && provider.requires_key !== false) return;
    attemptedProviderModelFetch.add(provider.id);
    loadProviderModels(provider.id, false)
      .then((res) => {
        if (res.models?.length) {
          cachedProviderModels.set(provider.id, res.models);
          setFetchedModels((prev) => ({ ...prev, [provider.id]: res.models }));
        }
      })
      .catch(() => { /* offline oder nicht erreichbar: Standardmodell bleibt wählbar */ });
  }, [provider]);
  const models: ModelInfo[] = useMemo(() => {
    const list = provider?.models?.length ? provider.models : (provider ? (fetchedModels[provider.id] ?? []) : []);
    if (chat.model && !list.some((m) => m.id === chat.model)) {
      return [{ id: chat.model }, ...list];
    }
    return list;
  }, [provider, chat.model, fetchedModels]);

  const patchChat = async (body: Record<string, unknown>) => {
    try {
      const next = await updateChat(chat.id, body);
      onChatUpdated(next);
      onChatsChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const uploadFiles = async (files: FileList | File[], options: { password?: string; pages?: string } = {}) => {
    const list = Array.from(files);
    if (!list.length || uploading) return;
    setUploading(true);
    setError("");
    try {
      for (const file of list) {
        try {
          const attachment = await uploadAttachment(chat.id, file, options);
          setPending((prev) => [...prev, attachment]);
        } catch (err) {
          const message = err instanceof ApiError ? err.message : String(err);
          const pdfFile = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
          if (pdfFile && err instanceof ApiError && err.status === 422 && /passwort/i.test(message)) {
            setPdfNeedsPassword(true);
            setLockedFile(file);
            setPdfError("");
            setPdfPassword("");
            setPdfPages("");
            break;
          }
          throw err;
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const pickPdf = (file: File | null) => {
    if (!file) return;
    setPdfNeedsPassword(false);
    setLockedFile(file);
    setPdfPassword("");
    setPdfPages("");
    setPdfError("");
    if (fileRef.current) fileRef.current.value = "";
  };

  /* One attach button for every file. A single PDF goes through the page and
     password dialog; everything else uploads directly. */
  const pickFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    if (files.length === 1) {
      const file = files[0];
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        pickPdf(file);
        return;
      }
    }
    uploadFiles(files);
  };

  const unlockPdf = async () => {
    if (!lockedFile || uploading) return;
    setPdfError("");
    setUploading(true);
    try {
      const attachment = await uploadAttachment(chat.id, lockedFile, {
        password: pdfPassword, pages: pdfPages,
      });
      setPending((prev) => [...prev, attachment]);
      setLockedFile(null);
    } catch (err) {
      setPdfError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = async (id: number) => {
    try {
      await deleteAttachment(chat.id, id);
      setPending((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  /* Bearbeiten bleibt im Browser, bis gesendet wird: erst dann blendet der
     Server die Frage und alles danach aus. Abbrechen lässt den Chat unberührt. */
  const send = () => {
    if (editing) {
      if (streaming || (!input.trim() && !pending.length)) return;
      const openChanges = openChangesFrom(editing);
      if (openChanges > 0) {
        setRewinding({ message: editing, mode: "edit", openChanges });
        return;
      }
      doRewind(editing, "edit");
      return;
    }
    sendText(input.trim(), pending);
  };

  const sendText = async (content: string, files: Attachment[], overrideSteps?: number) => {
    if ((!content && !files.length) || streamingRef.current) return;
    streamingRef.current = true;
    const streamChatId = chat.id;
    const isActiveChat = () => activeChatIdRef.current === streamChatId;
    if (talkRef.current) talkMisses.current = 0;
    dictation.stop();
    read.stop();
    liveContentRef.current = "";
    const attachmentIds = files.map((a) => a.id);
    setInput("");
    setEditing(null);
    setMenuForced(false);
    setBudgetNotice(null);
    setLocalPrompt(content || "(Anhang gesendet)");
    setLocalFiles(files);
    setPending([]);
    setLive(emptyTurn());
    setStreaming(true);
    setError("");
    setAtBottom(true);
    const abort = new AbortController();
    abortRef.current = abort;
    window.setTimeout(() => scrollToBottom("smooth"), 30);
    const requestedMaxSteps = overrideSteps ?? (stepBudget !== "auto" ? Number(stepBudget) : undefined);
    try {
      const sendCtx = ctxOn && pageCtx.active ? toWire(pageCtx) : undefined;
      await streamMessage(streamChatId, content || "Bitte lies den angehängten Anhang.",
        pageCtx.route, attachmentIds, (event) => {
        if (!isActiveChat()) {
          if (event.type === "start") onChatsChanged();
          return;
        }
        if (event.type === "start") {
          onChatsChanged();
        } else if (event.type === "step") {
          const nextStep = Number(event.step || 1);
          const synth = Boolean(event.synthesizing);
          if (nextStep > 1 && !synth) liveContentRef.current = "";
          setLive((prev) => ({
            ...prev,
            step: nextStep,
            maxSteps: Number(event.max_steps || prev.maxSteps || 20),
            synthesizing: synth,
            content: nextStep > 1 && !synth ? "" : prev.content,
          }));
        } else if (event.type === "delta") {
          liveContentRef.current += String(event.text || "");
          read.feed(liveContentRef.current);
          setLive((prev) => ({ ...prev, content: liveContentRef.current }));
        } else if (event.type === "reasoning") {
          setLive((prev) => ({ ...prev, reasoning: prev.reasoning + String(event.text || "") }));
        } else if (event.type === "tool_call_start") {
          const cid = String(event.id || "");
          const cname = String(event.name || "tool");
          setLive((prev) => {
            if (prev.tools.some((t) => t.id === cid)) return prev;
            return {
              ...prev,
              tools: [...prev.tools, {
                id: cid, name: cname, args: {}, status: "running",
                summary: "Argumente werden vorbereitet …", preview: "", step: prev.step,
              }],
            };
          });
        } else if (event.type === "tool_call") {
          const cid = String(event.id || "");
          const cname = String(event.name || "tool");
          setLive((prev) => {
            const exists = prev.tools.some((t) => t.id === cid);
            if (exists) {
              return {
                ...prev,
                tools: prev.tools.map((t) => (t.id === cid ? {
                  ...t, name: cname, args: event.arguments ?? {}, status: "running",
                  summary: "", step: Number(event.step || prev.step || 0) || undefined,
                } : t)),
              };
            }
            return {
              ...prev,
              tools: [...prev.tools, {
                id: cid, name: cname, args: event.arguments ?? {}, status: "running",
                summary: "", preview: "", step: Number(event.step || prev.step || 0) || undefined,
              }],
            };
          });
        } else if (event.type === "tool_result") {
          const action = event.action as Record<string, unknown> | undefined;
          setLive((prev) => ({
            ...prev,
            tools: prev.tools.map((tool) => tool.id === String(event.id || "") ? {
              ...tool,
              status: event.ok === false ? "error" : "ok",
              summary: String(event.summary || ""),
              preview: String(event.preview || ""),
              durationMs: event.duration_ms != null ? Number(event.duration_ms) : undefined,
              step: event.step != null ? Number(event.step) : tool.step,
              action: action && typeof action === "object" ? action : undefined,
              changeId: event.change_id as number | null | undefined,
              changeReversible: event.change_reversible as boolean | undefined,
              changeSummary: String(event.change_summary || ""),
            } : tool),
          }));
          /* Ein Werkzeug darf die Seite um eine Handlung bitten (Vorschau öffnen,
             Station auswählen, Platzierung vorbereiten). */
          if (action && typeof action === "object" && typeof action.type === "string") {
            if (action.type === "open_preview") {
              openPreviewAction(action);
            } else {
              window.dispatchEvent(new CustomEvent("gimel:copilot-action", { detail: action }));
            }
          }
        } else if (event.type === "assistant") {
          const content = String(event.content || liveContentRef.current);
          liveContentRef.current = content;
          read.feed(content);
          read.finish();
          setLive((prev) => ({ ...prev, content: content || prev.content }));
        } else if (event.type === "done") {
          if (event.budget_reached) {
            setBudgetNotice({
              steps: Number(event.steps || 0),
              maxSteps: Number(event.max_steps || 20),
            });
          }
        } else if (event.type === "error") {
          read.stop();
          setLive((prev) => ({ ...prev, error: String(event.detail || "Fehler") }));
        }
      }, abort.signal, sendCtx, talkRef.current, requestedMaxSteps);
    } catch (err) {
      if (isActiveChat() && !(err instanceof DOMException && err.name === "AbortError")) {
        read.stop();
        setLive((prev) => ({ ...prev, error: err instanceof ApiError ? err.message : String(err) }));
      }
    } finally {
      if (isActiveChat()) {
        read.finish();
        abortRef.current = null;
        try {
          const ticket = ++loadSeq.current;
          const next = await getChat(streamChatId);
          if (isActiveChat() && ticket === loadSeq.current) {
            // Atomarer Übergang: gespeicherte Nachrichten setzen und Live-Puffer
            // im selben Render-Batch leeren, damit keine Nachricht doppelt erscheint.
            setDetail(next);
            setPending(next.attachments ?? []);
            setLocalPrompt("");
            setLocalFiles([]);
            setLive(emptyTurn());
            liveContentRef.current = "";
            setStreaming(false);
            streamingRef.current = false;
          }
        } catch {
          setLocalPrompt("");
          setLocalFiles([]);
          setLive(emptyTurn());
          liveContentRef.current = "";
          setStreaming(false);
          streamingRef.current = false;
        }
      } else {
        streamingRef.current = false;
      }
      onChatsChanged();
      // Live-Gespräch: nach der Antwort wieder zuhören. Der Effekt oben tut es
      // auch, aber dieser Aufruf sichert es ab, falls der Effekt durch einen
      // verspäteten Zustandswechsel nicht ausgelöst wurde (z. B. beim Gehen).
      if (isActiveChat() && talkRef.current) {
        talkMisses.current = 0;
        window.setTimeout(() => { if (talkRef.current) voiceInStartRef.current(); }, 450);
      }
    }
  };

  const stop = async () => {
    try { await cancelChat(chat.id); } catch { /* egal */ }
    abortRef.current?.abort();
    read.stop();
    setStreaming(false);
  };
  sendTextRef.current = (content, files) => { void sendText(content, files); };

  function endTalk(): void {
    setTalk(false);
    talkRef.current = false;
    talkMisses.current = 0;
    voiceIn.setKeepOpen(false);
    voiceIn.cancel();
    read.stop();
    if (!readBeforeTalk.current) read.setEnabled(false);
  }

  const startTalk = () => {
    readBeforeTalk.current = read.enabled;
    read.setEnabled(true);
    talkMisses.current = 0;
    setVoiceError("");
    voiceIn.dismiss();
    voiceIn.setKeepOpen(true);
    setTalk(true);
    talkRef.current = true;
    voiceIn.start(); // aus dem Klick heraus: Mikrofon und Audio dürfen starten
  };

  /* Live: nach der gesprochenen Antwort wieder zuhören. Stille ohne Sprache
     hört still erneut zu; nach drei leeren Runden pausiert das Gespräch. */
  useEffect(() => {
    if (!talk || streaming || read.speaking || voiceIn.phase !== "idle") return;
    if (voiceIn.problem) {
      if (voiceIn.problem.kind !== "no-speech" || ++talkMisses.current >= 5) {
        if (voiceIn.problem.kind === "no-speech") {
          setVoiceError("Live-Gespräch pausiert: eine Weile nichts gehört.");
          endTalk();
        } else {
          // Echter Fehler: Gespräch nicht abbrechen, Problem merken, erneut versuchen.
          voiceIn.dismiss();
          const t = window.setTimeout(() => { if (talkRef.current) voiceInStartRef.current(); }, 1200);
          return () => window.clearTimeout(t);
        }
        return;
      }
      voiceIn.dismiss();
      talkMisses.current = Math.max(0, talkMisses.current); // keep count
    } else {
      talkMisses.current = 0;
    }
    const t = window.setTimeout(() => { if (talkRef.current) voiceInStartRef.current(); }, 350);
    return () => window.clearTimeout(t);
  }, [talk, streaming, read.speaking, voiceIn.phase, voiceIn.problem]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Live: Hineinsprechen unterbricht die Stimme und die laufende Antwort. Die
     eigene Ausgabe hebt die Schwelle an, damit das Echo nicht auslöst. */
  useEffect(() => {
    if (!talk || !read.speaking) return;
    return voiceIn.watch(() => {
      read.stop();
      if (abortRef.current) void stop();
      // Hineinsprechen unterbricht: danach wieder zuhören.
      window.setTimeout(() => { if (talkRef.current) voiceInStartRef.current(); }, 200);
    }, () => read.outputRms() * 1.6);
  }, [talk, read.speaking]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Neu erzeugen und Bearbeiten blenden die Frage und alles danach aus (der
     Server löscht nichts). Bei offenen Änderungen im ausgeblendeten Teil wird
     vorher gefragt: sie bleiben bestehen und im Register rückholbar. */
  const openChangesFrom = (message: Message): number => {
    const later = new Set((detail?.messages ?? []).filter((m) => m.id >= message.id).map((m) => m.id));
    return (detail?.changes ?? []).filter(
      (c) => c.status === "applied" && c.message_id != null && later.has(c.message_id),
    ).length;
  };

  const startEdit = (message: Message) => {
    if (streaming) return;
    setEditing(message);
    setInput(message.content || "");
    window.setTimeout(() => {
      const el = textRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }, 30);
  };

  const cancelEdit = () => {
    setEditing(null);
    setInput("");
    textRef.current?.focus();
  };

  const startRewind = (message: Message, mode: "edit" | "regenerate") => {
    if (streaming) return;
    const openChanges = openChangesFrom(message);
    if (openChanges > 0 || (mode === "regenerate" && chat.write_mode)) {
      setRewinding({ message, mode, openChanges });
      return;
    }
    doRewind(message, mode);
  };

  const doRewind = async (message: Message, mode: "edit" | "regenerate") => {
    setRewinding(null);
    try {
      const text = mode === "edit" ? input.trim() : "";
      const extra = mode === "edit" ? pending : [];
      const result = await rewindChat(chat.id, message.id);
      await load(true);
      const files = [...result.attachments, ...extra.filter((a) => !result.attachment_ids.includes(a.id))];
      await sendText(mode === "edit" ? text : result.content, files);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const insertPrompt = (text: string) => {
    setInput(text);
    setMenuForced(false);
    setMenuDismissed(false);
    window.setTimeout(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      const hole = /\{[^}\n]{1,40}\}/.exec(text);
      if (hole) el.setSelectionRange(hole.index, hole.index + hole[0].length);
      else el.setSelectionRange(text.length, text.length);
    }, 20);
  };

  const exportAs = (kind: "md" | "json") => {
    if (!detail) return;
    const name = `${safeFilename(chat.title)}-${new Date().toISOString().slice(0, 10)}`;
    if (kind === "md") downloadText(`${name}.md`, chatToMarkdown(detail), "text/markdown");
    else downloadText(`${name}.json`, chatToJson(detail), "application/json");
  };

  const undo = async (changeId: number) => {
    try {
      await revertChange(chat.id, changeId);
      await load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const undoChanges = async (changeIds: number[]) => {
    try {
      for (const changeId of changeIds) {
        await revertChange(chat.id, changeId);
      }
      await load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const messages = detail?.messages ?? [];
  const toolResults = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      toolResults.set(message.tool_call_id, message);
    }
  }
  const changesByMessage = new Map<number, Change[]>();
  for (const change of detail?.changes ?? []) {
    if (change.message_id != null) {
      changesByMessage.set(change.message_id, [...(changesByMessage.get(change.message_id) ?? []), change]);
    }
  }
  const artifacts = detail?.artifacts ?? [];
  const artifactsByMessage = new Map<number, Artifact[]>();
  for (const art of artifacts) {
    if (art.message_id != null) {
      artifactsByMessage.set(art.message_id, [...(artifactsByMessage.get(art.message_id) ?? []), art]);
    }
  }
  const allChatAttachments = useMemo(() => {
    const seen = new Set<number>();
    const out: Attachment[] = [];
    for (const item of [...(detail?.attachments ?? []), ...messages.flatMap((m) => m.attachments ?? [])]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }, [detail?.attachments, messages]);

  const showEmpty = !loading && !localPrompt && !live.content && !live.tools.length && messages.length === 0;
  const chatTokens = sumTokens(messages);
  const slash = slashQuery(input);
  const menuOpen = !streaming && (menuForced || (slash !== null && !menuDismissed));
  const lastUserId = [...messages].reverse().find((m) => m.role === "user")?.id ?? null;
  const BUILTIN_ICONS: Record<string, string> = {
    today: "flame", kpi_dashboard: "grouped-bar-chart", daily_report: "document",
    bottleneck: "diagram-tree", kpis: "timeline-line-chart", material: "layers",
    dispatch: "flows", quote: "euro", trace: "search-around", fleet: "drive-time",
  };
  const builtinSuggestions = builtin.slice(0, 4).map((p) => ({
    icon: BUILTIN_ICONS[p.key] ?? "lightbulb", title: p.title, text: p.text,
  }));
  const pageSuggestions = (ctxOn ? pageCtx.suggestions ?? [] : []).map((p) => ({
    icon: p.icon ?? "lightbulb", title: p.title, text: p.text,
  }));
  const baseSuggestions = builtinSuggestions.length ? builtinSuggestions : user.role === "worker"
    ? [
        { icon: "inbox", title: "Offene Innenaufträge", text: "Welche Innenaufträge sind offen?" },
        { icon: "cube", title: "Meine Bereitstellung", text: "Zeige mir meine bereitgestellten Aufträge." },
        { icon: "flow-linear", title: "Nächster Sammellauf", text: "Was liegt auf dem nächsten Sammellauf?" },
      ]
    : [
        { icon: "calendar", title: "Tagesstand", text: "Fasse den heutigen Fertigungsstand zusammen." },
        { icon: "lock", title: "Gesperrte Aufträge", text: "Welche Aufträge sind gesperrt?" },
        { icon: "people", title: "Wartende Kunden", text: "Zeige mir die wartenden Kunden." },
        { icon: "layers", title: "Knapper Bestand", text: "Welche Werkstoffe haben knappen Bestand?" },
      ];
  const orchestratorSuggestions = [
    { icon: "graph", title: "Wissensgraph & Engpässe", text: "Prüfe den Wissensgraphen auf Engpässe, überfällige Aufträge und knappe Werkstoffe und speichere die wichtigsten Erkenntnisse." },
    { icon: "git-branch", title: "Parallele Subagenten-Analyse", text: "Starte parallele Subagenten für Fertigung, Lagerbestand und Auftrags-Triage, sammle die Ergebnisse ein und erstelle einen Maßnahmenplan." },
    { icon: "path-search", title: "Wirkungsketten prüfen", text: "Welche Kundenaufträge sind aktuell durch Materialengpässe oder Stationsstaus gefährdet? Verfolge die Pfade im Wissensgraphen." },
    { icon: "grouped-bar-chart", title: "Komplett-Dashboard bauen", text: "Erstelle ein interaktives HTML-Leitstand-Dashboard zu Tagesstand, Stationsauslastung und offenen Eilaufträgen." },
  ];
  const agentSuggestions = (chat.agent_starters ?? []).map((text, idx) => ({
    icon: chat.agent_icon || "lightbulb",
    title: `Starter ${idx + 1}`,
    text,
  }));
  const suggestions = agentSuggestions.length > 0
    ? agentSuggestions.slice(0, 4)
    : chat.kind === "orchestrator"
      ? orchestratorSuggestions
      : [...pageSuggestions, ...baseSuggestions].slice(0, 4);
  const assistantLabel = chat.agent_name || "Assistent";
  const assistantBg = chat.agent_color || undefined;
  const searchNeedle = chatSearch.trim().toLowerCase();
  const turns = groupTurns(messages);
  const visibleTurns = searchNeedle
    ? turns.filter((t) => {
        if (t.role === "user") return (t.message.content || "").toLowerCase().includes(searchNeedle);
        return t.messages.some((m) => (m.content || "").toLowerCase().includes(searchNeedle));
      })
    : turns;

  return (
    <div className={`chat-wrap ${resizingPreview ? "is-resizing" : ""}`}>
      <div ref={chatLayoutRef} className={`chat-layout ${contextOpen && !compact ? "has-context" : ""} ${isPreviewOpen && !compact ? "has-preview" : ""}`}>
        <div className="chat-main">
          {chatSearchOpen && (
            <div className="chat-findbar">
              <Icon icon="search" size={13} aria-hidden="true" />
              <input
                autoFocus
                className="chat-find-input"
                placeholder="Im Chat suchen …"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setChatSearch(""); setChatSearchOpen(false); } }}
                aria-label="Im Chat suchen"
              />
              {searchNeedle && (
                <Tag minimal>{visibleTurns.length} Treffer</Tag>
              )}
              <Button minimal small icon="cross" aria-label="Suche schließen"
                onClick={() => { setChatSearch(""); setChatSearchOpen(false); }} />
            </div>
          )}
          {chat.kind === "orchestrator" && (
            <>
              <div className="chat-orchestrator-banner" role="note">
                <Icon icon="flow-branch" size={14} aria-hidden="true" />
                <span><strong>Orchestrator-Chat</strong> · ein durchgängiges Gespräch mit 200k Kontext, Subagenten und Wissensgraph.</span>
                <Tag minimal intent="primary">Orchestrator</Tag>
              </div>
              <SubagentPanel
                chatId={chat.id}
                streaming={streaming}
                onOpenGraph={onOpenGraph}
                onUseResult={(sub) => {
                  const snippet = `Übernehme und verwerte das Ergebnis des Subagenten „${sub.name}“ (${sub.role_title}):\n\n${sub.result}`;
                  setInput(snippet);
                  textRef.current?.focus();
                }}
              />
            </>
          )}
          <div className="chat-scroll" ref={scrollRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 90);
            }}>
            <div className={`chat-inner ${compact ? "is-compact" : ""}`}>
              {error && (
                <div className="chat-error" role="alert">
                  <Icon icon="warning-sign" size={14} aria-hidden="true" />
                  <span>{error}</span>
                  <Button minimal small icon="cross" aria-label="Hinweis schließen" onClick={() => setError("")} />
                </div>
              )}
              {loading && !detail && (
                <div className="chat-loading"><Spinner size={26} /><span>Chat wird geladen</span></div>
              )}
              {searchNeedle && visibleTurns.length === 0 && (
                <div className="empty">Keine Nachricht passt zu „{chatSearch}“.</div>
              )}
              {visibleTurns.map((turn) => {
                if (turn.role === "user") {
                  const message = turn.message;
                  return (
                    <div key={`user-${message.id}`}
                      className={`msg msg-user ${editing && message.id >= editing.id ? "is-pending-hide" : ""}`}>
                      <div className="msg-body">
                        <div className="msg-meta">
                          <span className="msg-author">Sie</span>
                          <span className="msg-time">{timeText(message.created_at)}</span>
                        </div>
                        {message.content && (
                          <RichText text={message.content}
                            onPreviewCode={hasSidePreview ? openCodePreview : undefined}
                            onPreviewUrl={hasSidePreview ? openUrlPreview : undefined} />
                        )}
                        <AttachmentChips items={message.attachments ?? []}
                          onPreview={hasSidePreview ? openAttachmentPreview : undefined} />
                        <div className="msg-actions">
                          <CopyButton text={message.content} label="Kopieren" />
                          {!streaming && !editing && (
                            <button type="button" className="msg-action"
                              title="Frage ändern und erneut senden; die Antworten danach werden beim Senden ausgeblendet"
                              onClick={() => startEdit(message)}>
                              <Icon icon="edit" size={12} aria-hidden="true" />
                              Bearbeiten
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="msg-avatar msg-avatar-user" aria-hidden="true">
                        <Icon icon="user" size={13} />
                      </div>
                    </div>
                  );
                }

                const group = turn.messages;
                const contentParts = group
                  .map((message) => message.content)
                  .filter((text): text is string => Boolean(text));
                const toolCards = group.flatMap((message) => messageToolCards(message, toolResults));
                const changes = group.flatMap((message) => changesByMessage.get(message.id) ?? []);
                const turnArtifacts = group.flatMap((message) => artifactsByMessage.get(message.id) ?? []);
                const applied = changes.filter((change) => change.status === "applied");
                const interrupted = group.some((message) => message.interrupted);
                const last = group[group.length - 1];
                const copyText = contentParts.join("\n\n");
                const tokens = sumTokens(group);
                const question = [...messages].reverse().find((m) => m.role === "user" && m.id < group[0].id);
                const isLastTurn = question != null && question.id === lastUserId;
                return (
                  <div key={`assistant-${group[0].id}`}
                    className={`msg msg-assistant ${editing && group[0].id > editing.id ? "is-pending-hide" : ""}`}>
                    {chat.agent_icon ? (
                      <div className="msg-avatar msg-avatar-assistant" style={assistantBg ? { background: assistantBg } : undefined} aria-hidden="true">
                        <Icon icon={chat.agent_icon as any} size={13} />
                      </div>
                    ) : (
                      <BotSmiley size={30} variant="assistant" color={assistantBg} />
                    )}
                    <div className="msg-body">
                      <div className="msg-meta">
                        <span className="msg-author">{assistantLabel}</span>
                        {interrupted && <Tag minimal intent="warning">abgebrochen</Tag>}
                        <span className="msg-time">{timeText(last?.created_at ?? group[0].created_at)}</span>
                        {tokens.total > 0 && (
                          <span className="msg-tokens"
                            title={`Eingabe ${tokens.prompt.toLocaleString("de-DE")} · Ausgabe ${tokens.completion.toLocaleString("de-DE")} · ${tokens.counted} Modellrunde(n)${tokens.has_list_cost ? ` · Listenpreis ${costText(tokens.list_cost)}` : ""}${tokens.has_cost ? ` · abgerechnet ${costText(tokens.cost)}` : ""}`}>
                            {tokenText(tokens.total)}
                          </span>
                        )}
                      </div>
                      {toolCards.length > 0 && (
                        <ToolTable
                          tools={toolCards.map(persistedTool)}
                          onRevert={undo}
                          onPreviewAction={hasSidePreview ? openPreviewAction : undefined}
                          onPreviewJson={hasSidePreview ? (title, json) => openCodePreview(json, "json", title) : undefined}
                        />
                      )}
                      {turnArtifacts.length > 0 && (
                        <div className="artifact-card-list">
                          {turnArtifacts.map((art) => (
                            <ArtifactCard
                              key={art.id}
                              artifact={art}
                              compact={compact}
                              onOpen={compact && onOpenArtifact ? onOpenArtifact : (hasSidePreview ? openArtifactPreview : undefined)}
                            />
                          ))}
                        </div>
                      )}
                      {contentParts.map((text, index) => (
                        <RichText key={`${group[0].id}-text-${index}`} text={text}
                          onPreviewCode={hasSidePreview ? openCodePreview : undefined}
                          onPreviewUrl={hasSidePreview ? openUrlPreview : undefined} />
                      ))}
                      {changes.length > 0 && (
                        <>
                          {changes.map((change) => (
                            <ChangeCard key={change.id} change={change} onRevert={undo} />
                          ))}
                          {applied.length > 1 && (
                            <Button small minimal icon="undo" text="Alle Änderungen dieses Schritts zurücknehmen"
                              onClick={() => undoChanges(applied.map((change) => change.id))} />
                          )}
                        </>
                      )}
                      {(copyText || (isLastTurn && !streaming)) && (
                        <div className="msg-actions">
                          {copyText && <CopyButton text={copyText} label="Antwort kopieren" />}
                          {copyText && read.supported && (
                            <button type="button" className="msg-action"
                              title={read.saying === `m${group[0].id}` ? "Vorlesen beenden" : `Diese Antwort vorlesen${edgeNote}`}
                              onClick={() => {
                                if (read.saying === `m${group[0].id}`) read.stop();
                                else read.say(copyText, `m${group[0].id}`);
                              }}>
                              <Icon icon={read.saying === `m${group[0].id}` ? "stop" : "volume-up"} size={12} aria-hidden="true" />
                              {read.saying === `m${group[0].id}` ? "Stopp" : "Vorlesen"}
                            </button>
                          )}
                          {isLastTurn && !streaming && !editing && question && (
                            <button type="button" className="msg-action"
                              title="Dieselbe Frage noch einmal stellen; diese Antwort wird ausgeblendet"
                              onClick={() => startRewind(question, "regenerate")}>
                              <Icon icon="refresh" size={12} aria-hidden="true" />
                              Neu erzeugen
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {localPrompt && (
                <div className="msg msg-user">
                  <div className="msg-body">
                    <div className="msg-meta"><span className="msg-author">Sie</span><span className="msg-time">gerade</span></div>
                    <RichText text={localPrompt} />
                    <AttachmentChips items={localFiles} onPreview={!compact ? openAttachmentPreview : undefined} />
                  </div>
                  <div className="msg-avatar msg-avatar-user" aria-hidden="true">
                    <Icon icon="user" size={13} />
                  </div>
                </div>
              )}

              {(live.content || live.reasoning || live.tools.length > 0 || streaming) && (
                <div className="msg msg-assistant is-live">
                  {chat.agent_icon ? (
                    <div className="msg-avatar msg-avatar-assistant" style={assistantBg ? { background: assistantBg } : undefined} aria-hidden="true">
                      <Icon icon={chat.agent_icon as any} size={13} />
                    </div>
                  ) : (
                    <BotSmiley size={30} variant="assistant" color={assistantBg} thinking={streaming} />
                  )}
                  <div className="msg-body">
                    <div className="msg-meta">
                      <span className="msg-author">{assistantLabel}</span>
                      {streaming && live.step != null && (
                        <Tag minimal intent={live.synthesizing ? "warning" : "primary"} className="msg-step-tag">
                          {live.synthesizing
                            ? `Zusammenfassung (${live.step}/${live.maxSteps ?? live.step})`
                            : `Schritt ${live.step}${live.maxSteps ? `/${live.maxSteps}` : ""}`}
                        </Tag>
                      )}
                      {streaming && elapsedSec > 0 && (
                        <span className="msg-elapsed mono">{elapsedSec}s</span>
                      )}
                      {streaming && <span className="msg-thinking"><span /><span /><span /></span>}
                    </div>
                    {streaming && live.step != null && live.maxSteps != null && live.maxSteps > 0 && (
                      <div className="step-progress-bar" aria-hidden="true">
                        <div
                          className={`step-progress-fill${live.synthesizing ? " is-synth" : ""}`}
                          style={{ width: `${Math.min(100, Math.round((live.step / live.maxSteps) * 100))}%` }}
                        />
                      </div>
                    )}
                    {live.reasoning && (
                      <details className="reasoning">
                        <summary>Überlegung</summary>
                        <div className="reasoning-text">{live.reasoning}</div>
                      </details>
                    )}
                    {live.tools.length > 0 && (
                      <ToolTable
                        tools={live.tools}
                        onRevert={undo}
                        onPreviewAction={hasSidePreview ? openPreviewAction : undefined}
                        onPreviewJson={hasSidePreview ? (title, json) => openCodePreview(json, "json", title) : undefined}
                      />
                    )}
                    {live.content && (
                      <RichText text={live.content}
                        onPreviewCode={hasSidePreview ? openCodePreview : undefined}
                        onPreviewUrl={hasSidePreview ? openUrlPreview : undefined} />
                    )}
                    {streaming && !live.content && !live.tools.length && (
                      <div className="msg-placeholder">Antwort wird vorbereitet …</div>
                    )}
                    {streaming && <span className="stream-caret" aria-hidden="true" />}
                    {live.error && <div className="chat-error" role="alert">{live.error}</div>}
                  </div>
                </div>
              )}

              {!streaming && budgetNotice && (
                <div className="step-continue-banner" role="status">
                  <Icon icon="step-forward" size={14} aria-hidden="true" />
                  <span>
                    Schrittbudget erreicht ({budgetNotice.steps}/{budgetNotice.maxSteps}). Falls noch offene Punkte bestehen, kannst du direkt weitermachen.
                  </span>
                  <div className="step-continue-actions">
                    <Button
                      small
                      intent="primary"
                      icon="play"
                      text="Weiter ausführen"
                      onClick={() => {
                        const nextCap = Math.min(100, Math.max(budgetNotice.maxSteps + 20, 40));
                        void sendText("Führe die offenen Punkte und nächsten Schritte aus deiner letzten Zusammenfassung vollständig weiter aus.", [], nextCap);
                      }}
                    />
                    <Button small minimal icon="cross" aria-label="Hinweis ausblenden" onClick={() => setBudgetNotice(null)} />
                  </div>
                </div>
              )}

              {showEmpty && (
                <div className="empty-chat">
                  {chat.agent_icon ? (
                    <div className="empty-mark" style={assistantBg ? { background: assistantBg } : undefined} aria-hidden="true">
                      <Icon icon={chat.agent_icon as any} size={22} />
                    </div>
                  ) : (
                    <BotSmiley size={48} variant="hero" color={assistantBg} trackMouse title="Klick mich!" />
                  )}
                  <strong>{chat.agent_name || "Womit kann ich helfen?"}</strong>
                  <p>{chat.agent_role_title
                    ? `${chat.agent_role_title} · Schreibzugriffe sind ${chat.write_mode ? "aktiv" : "zunächst aus"}.`
                    : (pageCtx.active && ctxOn
                      ? `Ich sehe, was Sie gerade anschauen: ${contextChip(pageCtx)}. Schreibzugriffe sind zunächst aus.`
                      : "Ich lese Aufträge, Innenaufträge, Lager und Stammdaten. Schreibzugriffe sind zunächst aus.")}</p>
                  <div className="suggestions">
                    {suggestions.map((item) => (
                      <button key={item.text} type="button" onClick={() => { setInput(item.text); textRef.current?.focus(); }}>
                        <span className="suggestion-icon"><Icon icon={item.icon as any} size={14} /></span>
                        <span>
                          <strong>{item.title}</strong>
                          <span>{item.text}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className={`composer ${dragging ? "is-dragging" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!streaming && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
            }}>
            {!atBottom && (
              <button type="button" className="jump-latest" onClick={() => { setAtBottom(true); scrollToBottom("smooth"); }}>
                <Icon icon="arrow-down" size={13} aria-hidden="true" />
                Zum Neuesten
              </button>
            )}
            {dragging && <div className="composer-drop" aria-hidden="true">Datei zum Anhängen ablegen</div>}
            <div className="composer-inner">
              <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden
                onChange={(e) => pickFiles(e.target.files)} />
              {voiceError && (
                <div className="composer-voice-note" role="alert">
                  <Icon icon="warning-sign" size={12} aria-hidden="true" />
                  <span>{voiceError}</span>
                  <Button minimal small icon="cross" aria-label="Hinweis schließen"
                    onClick={() => setVoiceError("")} />
                </div>
              )}
              <MicPanel phase={talk ? "idle" : voiceIn.phase} level={voiceIn.level} heard={voiceIn.heard}
                seconds={voiceIn.seconds} device={voiceIn.device} deviceId={voiceIn.deviceId}
                devices={voiceIn.devices} problem={talk && voiceIn.problem?.kind === "no-speech" ? null : voiceIn.problem}
                onFinish={voiceIn.finish}
                onCancel={() => { if (talk) endTalk(); else voiceIn.cancel(); }}
                onRetry={() => { voiceIn.dismiss(); if (talk) voiceIn.start(); else voiceIn.start(); }}
                onDismiss={voiceIn.dismiss} onDevice={voiceIn.setDevice} compact={compact} />
              <AttachmentChips items={pending} onRemove={removeAttachment}
                onPreview={!compact ? openAttachmentPreview : undefined} />
              {editing && (
                <div className="composer-editing" role="status">
                  <Icon icon="edit" size={12} aria-hidden="true" />
                  <span>Frage bearbeiten — beim Senden werden die gedimmten Nachrichten ausgeblendet.</span>
                  <button type="button" className="msg-action composer-editing-cancel" onClick={cancelEdit}>
                    Abbrechen
                  </button>
                </div>
              )}
              <PromptMenu ref={promptRef} open={menuOpen} query={menuForced ? "" : (slash ?? "")}
                draft={input} onPick={insertPrompt} onActiveChange={setActiveOption}
                onClose={() => { setMenuForced(false); setMenuDismissed(true); }} />
              {pageCtx.active && (
                <div className={`composer-context ${ctxOn ? "is-on" : ""}`}>
                  <button type="button" className="composer-context-chip" aria-pressed={ctxOn}
                    title={ctxOn
                      ? "Der Assistent sieht diese Ansicht. Klicken, um sie auszublenden."
                      : "Die Ansicht wird nicht mitgeschickt. Klicken, um sie zu teilen."}
                    onClick={() => { setCtxOn(!ctxOn); writeCtxPref(!ctxOn); }}>
                    <Icon icon={ctxOn ? "eye-open" : "eye-off"} size={12} aria-hidden="true" />
                    <span className="composer-context-label">
                      {ctxOn ? `Sie sehen: ${contextChip(pageCtx)}` : "Ansicht nicht geteilt"}
                    </span>
                  </button>
                </div>
              )}
              {/* Zwei Arten, mit demselben Chat zu reden (Owner 2026-11-08: „classic chat and live“).
                  Live gibt es, wo der Server selbst erkennt (Labor, Studio); im Portal nicht. */}
              <div className="vi-mode" role="radiogroup" aria-label="Gesprächsart">
                <button type="button" role="radio" aria-checked={!talk}
                  className={`vi-mode-btn${!talk ? " is-on" : ""}`}
                  onClick={() => { if (talk) endTalk(); }}>
                  <Icon icon="chat" size={12} aria-hidden="true" /> Chat
                </button>
                <button type="button" role="radio" aria-checked={talk}
                  className={`vi-mode-btn${talk ? " is-on" : ""}`}
                  disabled={!talk && (!voiceIn.available || streaming)}
                  title={!voiceIn.available
                    ? (voiceIn.server === undefined ? "Spracherkennung wird geprüft …"
                      : "Live gibt es im Agent Lab und im Twin Studio — dieses Portal erkennt keine Sprache.")
                    : "Live-Gespräch: Das Mikrofon bleibt offen, bis Sie beenden. Alles Gehörte – auch Gespräche in der Nähe – geht ohne Vorschau an den Assistenten und das eingestellte Sprachmodell. Hineinsprechen unterbricht."
                      + (chat.write_mode ? " Mit Schreiben an ändert der Assistent nur zurücknehmbar (kein Löschen, keine Rechnungen, keine Konten); jede Änderung steht im Register." : "")}
                  onClick={() => { if (!talk) startTalk(); }}>
                  <Icon icon="headset" size={12} aria-hidden="true" /> Live
                </button>
              </div>
              <div className="composer-box">
                {talk ? (
                  <div className="vi-livepanel" role="group" aria-label="Live-Gespräch">
                    <button type="button" className="vi-orb"
                      data-state={streaming ? "thinking" : read.speaking ? "speaking" : voiceIn.phase}
                      style={{ boxShadow: voiceIn.phase === "listening"
                        ? `0 0 0 ${Math.round(2 + voiceIn.level.meter * 10)}px var(--lab-accent-soft)` : undefined }}
                      aria-label={voiceIn.phase === "listening" ? "Fertig — jetzt erkennen"
                        : (streaming || read.speaking) ? "Unterbrechen und sprechen" : "Zuhören"}
                      disabled={voiceIn.phase === "transcribing" || voiceIn.phase === "opening"}
                      onClick={() => {
                        if (voiceIn.phase === "listening") { voiceIn.finish(); return; }
                        if (streaming || read.speaking) { read.stop(); if (abortRef.current) void stop(); return; }
                        voiceIn.dismiss();
                        voiceIn.start();
                      }}>
                      <Icon icon={(streaming || read.speaking) ? "stop" : "microphone"} size={compact ? 18 : 22} aria-hidden="true" />
                    </button>
                    <div className="vi-live-body">
                      <div className="vi-live-state" aria-live="polite">
                        {streaming ? "Denkt nach …" : read.speaking ? "Spricht — hineinsprechen unterbricht"
                          : voiceIn.phase === "transcribing" ? "Erkennt …"
                            : voiceIn.phase === "listening" ? (voiceIn.heard ? "Hört — Sprache erkannt" : "Hört zu …")
                              : voiceIn.phase === "opening" ? "Mikrofon wird geöffnet …" : "Bereit"}
                      </div>
                      {voiceIn.phase === "listening" && <LevelMeter level={voiceIn.level} />}
                      <div className="vi-live-hint">
                        Mikrofon offen, Gehörtes geht ohne Vorschau los{voiceIn.device ? ` · ${voiceIn.device}` : ""}
                      </div>
                    </div>
                    <button type="button" className="vi-btn" onClick={endTalk}>Beenden</button>
                  </div>
                ) : (
                <div className="composer-input-row">
                  <Button icon="paperclip" minimal disabled={streaming || uploading}
                    loading={uploading} aria-label="Datei anhängen"
                    title="PDF oder Textdatei anhängen"
                    onClick={() => fileRef.current?.click()} />
                  {(voiceIn.available || browserDictation) && (
                    <Button icon={micOn ? "record" : "microphone"} minimal
                      className={`composer-mic${micOn ? " is-listening" : ""}`}
                      disabled={streaming || uploading || talk || voiceIn.phase === "transcribing" || voiceIn.phase === "opening"}
                      aria-label={micOn ? "Spracheingabe beenden" : "Spracheingabe starten"}
                      title={micOn
                        ? "Fertig — Gesprochenes erkennen"
                        : voiceIn.available
                          ? "Sprechen — wird auf diesem Rechner erkannt und ins Eingabefeld geschrieben"
                          : "Diktat über den Browser – er schickt das Audio an den Dienst seines Herstellers (Chrome: Google, Edge: Microsoft). Nicht für Kunden- oder Personendaten."}
                      onClick={() => {
                        if (voiceIn.available) {
                          if (voiceIn.phase === "listening") { voiceIn.finish(); return; }
                          setVoiceError("");
                          read.stop();
                          voiceIn.start();
                          return;
                        }
                        if (dictation.listening) { dictation.stop(); return; }
                        setVoiceError("");
                        read.stop();
                        dictation.start(input);
                      }} />
                  )}
                  <TextArea
                    inputRef={textRef}
                    className="composer-text"
                    fill
                    autoResize
                    rows={1}
                    value={input}
                    placeholder={streaming ? "Antwort läuft …" : "Nachricht an den Assistenten — / für Vorlagen"}
                    role="combobox"
                    aria-label="Nachricht an den Assistenten"
                    aria-autocomplete="list"
                    aria-expanded={menuOpen}
                    aria-controls={menuOpen ? "prompt-menu-list" : undefined}
                    aria-activedescendant={menuOpen && activeOption ? activeOption : undefined}
                    onChange={(e) => {
                      /* Wer tippt, übernimmt selbst: das Diktat würde den
                         getippten Text sonst wieder überschreiben. */
                      if (dictation.listening) dictation.stop();
                      setInput(e.target.value);
                      if (!e.target.value.startsWith("/")) setMenuDismissed(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && editing && !menuOpen) {
                        e.preventDefault();
                        cancelEdit();
                        return;
                      }
                      if (promptRef.current?.handleKey(e)) {
                        e.preventDefault();
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    disabled={streaming}
                  />
                  {streaming
                    ? <Button className="composer-send is-stop" icon="stop" intent="danger" onClick={stop} aria-label="Antwort stoppen" />
                    : <Button className="composer-send" icon="arrow-up" intent="primary" onClick={send}
                              disabled={(!input.trim() && !pending.length) || !provider}
                              aria-label="Senden" />}
                </div>
                )}
                <div className="composer-toolbar">
                  {(!compact || providers.filter((p) => p.enabled || p.id === provider?.id).length > 1) && (
                    <HTMLSelect
                      minimal
                      className="composer-select"
                      value={provider?.id ?? ""}
                      onChange={(e) => {
                        const id = Number(e.target.value);
                        const next = providers.find((p) => p.id === id);
                        patchChat({ provider_id: id, model: next?.default_model || next?.models?.[0]?.id || "" });
                      }}
                      aria-label="Anbieter"
                      title="Anbieter wählen"
                    >
                      {providers.filter((p) => p.enabled || p.id === provider?.id).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                      {providers.length === 0 && <option value="">Kein Anbieter</option>}
                    </HTMLSelect>
                  )}
                  <HTMLSelect
                    minimal
                    className="composer-select composer-model"
                    value={chat.model}
                    onChange={(e) => patchChat({ model: e.target.value })}
                    aria-label="Modell"
                    title="Modell wählen"
                  >
                    {models.length === 0 && <option value={chat.model}>{chat.model || "kein Modell"}</option>}
                    {models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                  </HTMLSelect>
                  <HTMLSelect
                    minimal
                    className="composer-select composer-steps"
                    value={stepBudget}
                    onChange={(e) => {
                      setStepBudget(e.target.value);
                      writeStepPref(chat.kind, e.target.value);
                    }}
                    aria-label="Schrittbudget"
                    title="Maximale Werkzeugschritte für diesen Lauf (bis 100 Schritte)"
                  >
                    <option value="auto">Schritte: Auto ({chat.kind === "orchestrator" ? "40" : "20"})</option>
                    <option value="15">15 Schritte</option>
                    <option value="25">25 Schritte</option>
                    <option value="40">40 Schritte</option>
                    <option value="60">60 Schritte</option>
                    <option value="100">100 Schritte</option>
                  </HTMLSelect>
                  <button type="button"
                    className={`composer-toggle ${chat.write_mode ? "is-on" : ""}`}
                    aria-pressed={chat.write_mode}
                    title="Schreibende Werkzeuge erlauben"
                    onClick={() => patchChat({ write_mode: !chat.write_mode })}>
                    <Icon icon={chat.write_mode ? "unlock" : "lock"} size={12} aria-hidden="true" />
                    Schreiben {chat.write_mode ? "an" : "aus"}
                  </button>
                  {chat.write_mode && <span className="composer-warn">Änderungen werden protokolliert</span>}
                  <span className="composer-spacer" />
                  {read.supported && (read.enabled || talk) && (!compact || talk) && (
                    <HTMLSelect minimal className="composer-select" aria-label="Sprechtempo"
                      title="Sprechtempo beim Vorlesen"
                      value={String(read.rate)} onChange={(e) => read.setRate(Number(e.target.value))}>
                      <option value="0.9">Tempo 0,9×</option>
                      <option value="1">Tempo 1×</option>
                      <option value="1.15">Tempo 1,15×</option>
                      <option value="1.3">Tempo 1,3×</option>
                    </HTMLSelect>
                  )}
                  {read.supported && (
                    <Button small minimal
                      icon={read.enabled ? "volume-up" : "volume-off"}
                      text={compact ? undefined : "Vorlesen"}
                      className="composer-tool-btn"
                      active={read.enabled}
                      aria-pressed={read.enabled}
                      aria-label="Antworten vorlesen"
                      title={read.enabled ? "Vorlesen ausschalten" : `Antworten vorlesen${edgeNote}`}
                      onClick={() => {
                        const next = !read.enabled;
                        read.setEnabled(next);
                        if (!next) read.stop();
                        else if (streaming && liveContentRef.current) read.feed(liveContentRef.current);
                      }} />
                  )}
                  {messages.length > 0 && (
                    <Button small minimal icon="search"
                      className="composer-tool-btn"
                      active={chatSearchOpen}
                      aria-label="Im Chat suchen"
                      title="Im Chat suchen"
                      onClick={() => {
                        setChatSearchOpen((v) => !v);
                        if (chatSearchOpen) setChatSearch("");
                      }} />
                  )}
                  <Button small minimal icon="bookmark" text={compact ? undefined : "Vorlagen"}
                    className="composer-tool-btn"
                    aria-label="Vorlagen" active={menuOpen} aria-expanded={menuOpen}
                    disabled={streaming}
                    onClick={() => { setMenuForced((v) => !v); setMenuDismissed(false); textRef.current?.focus(); }} />
                  <Popover placement="top-end" minimal disabled={!messages.length} content={
                    <Menu>
                      <MenuItem icon="document" text="Als Markdown (.md)" onClick={() => exportAs("md")} />
                      <MenuItem icon="code" text="Als JSON (.json)" onClick={() => exportAs("json")} />
                    </Menu>
                  }>
                    <Button small minimal icon="export" text={compact ? undefined : "Exportieren"}
                      className="composer-tool-btn"
                      aria-label="Chat exportieren" disabled={!messages.length} />
                  </Popover>
                  {!compact && (
                    <Button small minimal icon="application" text="Vorschau"
                      className="composer-tool-btn"
                      active={isPreviewOpen}
                      aria-label="Seiten-Vorschau ein- oder ausblenden"
                      title="Seiten-Vorschau & Browser (Strg+Shift+P)"
                      onClick={() => setPreviewOpen(!isPreviewOpen)} />
                  )}
                  {onOpenFull && <Button small minimal icon="fullscreen" text="Im Tab öffnen" onClick={onOpenFull} />}
                  {onToggleContext && !compact && (
                    <Button small minimal icon="drawer-right" active={contextOpen}
                      aria-label="Kontext ein- oder ausblenden" onClick={onToggleContext} />
                  )}
                </div>
              </div>
              <div className="composer-hint">
                <span className="composer-hint-keys">Enter sendet, Shift+Enter macht eine neue Zeile · PDF/HTML/SVG/MD/CSV/JSON/Code</span>
                {dictation.listening && <> · <strong>Diktat läuft</strong></>}
                {voiceIn.phase === "listening" && !talk && <> · <strong>Spracheingabe läuft</strong> (Enter = fertig, Esc = abbrechen)</>}
                {talk && <> · <strong>Live an</strong></>}
                {read.enabled && <> · <strong>Vorlesen an</strong></>}
                {provider && <> · {provider.name} · {chat.model || provider.default_model || "kein Modell"}</>}
                {provider?.context_length && <> · {Math.round(provider.context_length / 1024)}k Kontext</>}
                {chatTokens.total > 0 && <> · Chat bisher {tokenText(chatTokens.total)}</>}
                {chatTokens.has_list_cost && chatTokens.list_cost > 0 && <> · Listenpreis {costText(chatTokens.list_cost)}</>}
                {provider && provider.requires_key !== false && !provider.has_key && <> · <strong>API-Schlüssel fehlt</strong></>}
              </div>
            </div>
          </div>
        </div>

        {isPreviewOpen && !compact && (
          <>
            {!previewExpanded && (
              <div
                className="preview-splitter"
                role="separator"
                aria-orientation="vertical"
                aria-label="Breite der Seiten-Vorschau anpassen"
                onMouseDown={startResizePreview}
                onDoubleClick={() => setPreviewWidth(560)}
                title="Ziehen zum Skalieren · Doppelklick für Standardbreite"
              />
            )}
            <div
              className={`preview-dock ${previewExpanded ? "is-expanded" : ""}`}
              style={previewExpanded ? undefined : { width: previewWidth }}
            >
              <PreviewPane
                chatId={chat.id}
                tabs={previewTabs}
                activeTabId={activePreviewId}
                artifacts={artifacts}
                attachments={allChatAttachments}
                expanded={previewExpanded}
                onSelectTab={setActivePreviewId}
                onCloseTab={closePreviewTab}
                onUpdateTab={updatePreviewTab}
                onAddTab={openOrFocusTab}
                onToggleExpand={() => setPreviewExpanded((v) => !v)}
                onClose={() => { setPreviewExpanded(false); setPreviewOpen(false); }}
                onArtifactsChanged={() => load(true)}
              />
            </div>
          </>
        )}

        {contextOpen && !compact && !previewExpanded && (
          <ChatContext
            chat={chat}
            messages={messages}
            attachments={detail?.attachments ?? []}
            changes={detail?.changes ?? []}
            artifacts={artifacts}
            onClose={() => onToggleContext?.()}
            onOpenChanges={() => onOpenChanges?.()}
            onPreviewAttachment={openAttachmentPreview}
            onPreviewArtifact={openArtifactPreview}
            onPreviewSandboxFile={openSandboxFilePreview}
          />
        )}
      </div>

      <Dialog isOpen={!!rewinding} onClose={() => setRewinding(null)}
        title={rewinding?.mode === "regenerate" ? "Antwort neu erzeugen?" : "Geänderte Frage senden?"}
        style={{ width: 460, maxWidth: "calc(100vw - 24px)" }}>
        <DialogBody>
          {!!rewinding?.openChanges && (
            <p style={{ marginTop: 0 }}>
              Ab dieser Frage hat der Assistent {rewinding.openChanges} Änderung(en) gemacht. Sie bleiben
              bestehen und im Register unter „Änderungen“ rückholbar; der Chatverlauf dazu wird ausgeblendet.
            </p>
          )}
          {chat.write_mode && (
            <p style={{ marginTop: rewinding?.openChanges ? undefined : 0 }}>
              <strong>Schreiben ist an:</strong> Die Frage läuft erneut, schreibende Werkzeuge können
              dieselbe Änderung ein zweites Mal ausführen (etwa einen Auftrag noch einmal anlegen).
            </p>
          )}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setRewinding(null)} />
            {onOpenChanges && <Button text="Änderungen ansehen" onClick={() => { setRewinding(null); onOpenChanges(); }} />}
            <Button intent="primary" text={rewinding?.mode === "regenerate" ? "Neu erzeugen" : "Senden"}
              onClick={() => rewinding && doRewind(rewinding.message, rewinding.mode)} />
          </>
        } />
      </Dialog>

      <Dialog isOpen={!!lockedFile} onClose={() => setLockedFile(null)}
        title={pdfNeedsPassword ? "PDF ist passwortgeschützt" : "PDF-Seiten auswählen"}
        style={{ width: 460, maxWidth: "calc(100vw - 24px)" }}>
        <DialogBody>
          <p style={{ marginTop: 0 }}>
            „{lockedFile?.name}“{pdfNeedsPassword
              ? " wird nur zum Lesen entsperrt. Das Passwort wird nicht gespeichert."
              : " kann ganz oder in Auszügen übernommen werden."}
          </p>
          {pdfNeedsPassword && (
            <FormGroup label="Passwort">
              <InputGroup type="password" autoFocus value={pdfPassword}
                onChange={(e) => setPdfPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") unlockPdf(); }} />
            </FormGroup>
          )}
          <FormGroup label="Seiten (optional)"
            helperText="Leer = alle Seiten bis zur eingestellten Grenze. Beispiel: 1-5,8,12-">
            <InputGroup value={pdfPages} placeholder="1-5,8" autoFocus={!pdfNeedsPassword}
              onChange={(e) => setPdfPages(e.target.value)} />
          </FormGroup>
          {pdfError && <div className="login-error" role="alert">{pdfError}</div>}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setLockedFile(null)} />
            <Button intent="primary" icon="document-open"
              text={pdfNeedsPassword ? "Entsperren und anhängen" : "PDF anhängen"}
              onClick={unlockPdf} loading={uploading}
              disabled={pdfNeedsPassword && !pdfPassword} />
          </>
        } />
      </Dialog>
    </div>
  );
}
