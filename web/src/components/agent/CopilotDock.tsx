import { Button, HTMLSelect, Icon, Spinner, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { SessionUser } from "../../api";
import BotSmiley from "../BotSmiley";
import AgentSettings from "@agentlab/AgentSettings";
import ChatPane from "@agentlab/ChatPane";
import PreviewPane, { PreviewTab } from "@agentlab/PreviewPane";
import {
  AgentPersona, ApiError, Artifact, BuiltinAgent, Chat, createChat, createStandaloneArtifact,
  listAgents, listAllArtifacts, listChats, listProviders, listRoutines, Provider, Routine,
  RoutineTemplate, runRoutine, runRoutineTemplate, startBuiltinAgent, startCustomAgent,
} from "@agentlab/api";
import { MAX_W, MIN_W, NARROW, useCopilotWidth } from "./copilotState";
import { installAgentTransport } from "./transport";
import "./agent.css";

const CURRENT_KEY = "gimel-agent-chat";
const SIDEFRAME_W_KEY = "gimel-copilot-sideframe-w";
type DockTab = "chat" | "agents" | "routines" | "artifacts" | "settings";
type AgentFilter = "all" | "with_routines" | "without_routines";
type ArtifactKindFilter = "all" | "html" | "svg" | "markdown" | "csv" | "json" | "code";

function storedChat(): number | null {
  try {
    const raw = localStorage.getItem(CURRENT_KEY);
    return raw ? Number(raw) || null : null;
  } catch {
    return null;
  }
}

function storedSideWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEFRAME_W_KEY));
    return Number.isFinite(raw) && raw >= 380 && raw <= 1200 ? raw : 600;
  } catch {
    return 600;
  }
}

function artifactToTab(art: Artifact): PreviewTab {
  return {
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
  };
}

export interface ExternalCopilotPrompt {
  nonce: number;
  prompt: string;
  agentKey?: string;
  templateKey?: string;
}

/** Der Assistent als Seitenleiste im Musterwerk-Portal:
 *  - Chat, Spezialisten-Agenten (mit & ohne Routinen), Routinen und globale Artefakte
 *  - Eigenständiger, skalierbarer Side-Preview-Frame (PreviewPane) direkt neben dem Dock
 *    für HTML-Webseiten, interaktive Artefakte, Berichte, Diagramme, Dateien & Code. */
export default function CopilotDock({ open, onClose, user, reserve = 230, minMain = 820, alwaysFloat = false, externalPrompt = null }: {
  open: boolean;
  onClose: () => void;
  user: SessionUser;
  /** Breite fester Spalten neben der Seite (Seitenleiste des Portals), für die Platzrechnung. */
  reserve?: number;
  /** Ab dieser Restbreite schiebt die Leiste die Seite beiseite; darunter schwebt sie darüber. */
  minMain?: number;
  /** Immer schweben (Twin Studio: die 3D-Bühne darf sich nicht verkleinern). */
  alwaysFloat?: boolean;
  /** Externer 1-Klick-Auslöser (z. B. aus dem Supply Chain Control Tower). */
  externalPrompt?: ExternalCopilotPrompt | null;
}) {
  installAgentTransport();
  const [tab, setTab] = useState<DockTab>("chat");
  const [chats, setChats] = useState<Chat[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(storedChat);
  const [autoPrompt, setAutoPrompt] = useState<{ nonce: number; chatId: number; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [width, setWidth] = useCopilotWidth();
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [dragging, setDragging] = useState(false);
  const [vw, setVw] = useState(() => window.innerWidth);
  const panel = useRef<HTMLElement>(null);

  /* Dedizierter, skalierbarer Side Frame (PreviewPane) für Artefakte, Webseiten & Dateien */
  const [sideOpen, setSideOpen] = useState(false);
  const [sideExpanded, setSideExpanded] = useState(false);
  const [sideWidth, setSideWidth] = useState<number>(storedSideWidth);
  const [sideDragging, setSideDragging] = useState(false);
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);

  /* Agenten, Routinen & Artefakte */
  const [builtinAgents, setBuiltinAgents] = useState<BuiltinAgent[]>([]);
  const [customAgents, setCustomAgents] = useState<AgentPersona[]>([]);
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [templates, setTemplates] = useState<RoutineTemplate[]>([]);
  const [routinesLoaded, setRoutinesLoaded] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactsLoaded, setArtifactsLoaded] = useState(false);
  const [artifactSearch, setArtifactSearch] = useState("");
  const [artifactKind, setArtifactKind] = useState<ArtifactKindFilter>("all");
  const [launching, setLaunching] = useState<string | null>(null);
  const lastExtNonce = useRef<number>(0);

  const current = chats.find((chat) => chat.id === currentId) ?? null;

  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    const onSize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onSize);
    return () => { mq.removeEventListener("change", on); window.removeEventListener("resize", onSize); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SIDEFRAME_W_KEY, String(sideWidth)); } catch { /* egal */ }
  }, [sideWidth]);

  const loadChats = useCallback(async () => {
    const data = await listChats();
    setChats(data.chats);
    setCurrentId((id) => {
      if (id && data.chats.some((chat) => chat.id === id)) return id;
      return data.chats[0]?.id ?? null;
    });
  }, []);

  const loadArtifactsData = useCallback(async () => {
    try {
      const data = await listAllArtifacts();
      setArtifacts(data.artifacts);
      setArtifactsLoaded(true);
    } catch { /* optional */ }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [chatData, providerData] = await Promise.all([listChats(), listProviders()]);
      setChats(chatData.chats);
      setProviders(providerData.providers);
      setCurrentId((id) => {
        if (id && chatData.chats.some((chat) => chat.id === id)) return id;
        return chatData.chats[0]?.id ?? null;
      });
      void loadArtifactsData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [loadArtifactsData]);

  const loadAgentsData = useCallback(async () => {
    try {
      const data = await listAgents();
      setBuiltinAgents(data.builtin);
      setCustomAgents(data.agents);
      setRoutines(data.routines);
      setTemplates(data.templates);
      setAgentsLoaded(true);
      setRoutinesLoaded(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  const loadRoutinesData = useCallback(async () => {
    try {
      const data = await listRoutines();
      setRoutines(data.routines);
      setTemplates(data.templates);
      setRoutinesLoaded(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  const refreshChatList = useCallback(() => {
    loadChats().catch(() => { /* still */ });
    loadArtifactsData().catch(() => { /* still */ });
  }, [loadChats, loadArtifactsData]);

  useEffect(() => {
    if (open && !loaded) refresh();
  }, [open, loaded, refresh]);

  useEffect(() => {
    if (!open) return;
    if (tab === "agents" && !agentsLoaded) void loadAgentsData();
    if (tab === "routines" && !routinesLoaded) void loadRoutinesData();
    if ((tab === "artifacts" || sideOpen) && !artifactsLoaded) void loadArtifactsData();
  }, [open, tab, sideOpen, agentsLoaded, routinesLoaded, artifactsLoaded, loadAgentsData, loadRoutinesData, loadArtifactsData]);

  useEffect(() => {
    if (!open || !externalPrompt || externalPrompt.nonce === lastExtNonce.current) return;
    lastExtNonce.current = externalPrompt.nonce;
    let alive = true;
    (async () => {
      setBusy(true);
      setError("");
      try {
        let chat: Chat;
        let promptText = externalPrompt.prompt;
        if (externalPrompt.agentKey) {
          const res = await startBuiltinAgent(
            externalPrompt.agentKey,
            externalPrompt.templateKey ? { template_key: externalPrompt.templateKey } : {},
          );
          chat = res.chat;
          if (!promptText && res.prompt) promptText = res.prompt;
        } else {
          chat = await createChat({});
        }
        if (!alive) return;
        setChats((prev) => [chat, ...prev.filter((c) => c.id !== chat.id)]);
        setCurrentId(chat.id);
        setTab("chat");
        if (promptText && promptText.trim()) {
          setAutoPrompt({ nonce: Date.now() + Math.random(), chatId: chat.id, text: promptText });
        }
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [open, externalPrompt]);

  useEffect(() => {
    try {
      if (currentId) localStorage.setItem(CURRENT_KEY, String(currentId));
      else localStorage.removeItem(CURRENT_KEY);
    } catch { /* egal */ }
  }, [currentId]);

  /* Side-Frame Tab-Steuerung */
  const openOrFocusSideTab = useCallback((nextTab: PreviewTab) => {
    setPreviewTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === nextTab.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...nextTab };
        return next;
      }
      return [...prev, nextTab];
    });
    setActivePreviewId(nextTab.id);
    setSideOpen(true);
  }, []);

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

  const openArtifactInSideFrame = useCallback((art: Artifact) => {
    openOrFocusSideTab(artifactToTab(art));
  }, [openOrFocusSideTab]);

  const templateMap = useMemo(() => new Map(templates.map((t) => [t.key, t])), [templates]);
  const routineMap = useMemo(() => new Map(routines.map((r) => [r.id, r])), [routines]);

  const visibleCustomAgents = useMemo(() => customAgents.filter((a) => {
    if (agentFilter === "with_routines") return a.has_routines;
    if (agentFilter === "without_routines") return !a.has_routines;
    return true;
  }), [customAgents, agentFilter]);

  const visibleBuiltinAgents = useMemo(() => builtinAgents.filter((a) => {
    if (agentFilter === "with_routines") return a.has_routines;
    if (agentFilter === "without_routines") return !a.has_routines;
    return true;
  }), [builtinAgents, agentFilter]);

  const filteredArtifacts = useMemo(() => {
    const q = artifactSearch.trim().toLowerCase();
    return artifacts.filter((a) => {
      if (artifactKind !== "all" && a.kind !== artifactKind) return false;
      if (!q) return true;
      return `${a.title} ${a.filename} ${a.kind} ${a.chat_title || ""}`.toLowerCase().includes(q);
    });
  }, [artifacts, artifactKind, artifactSearch]);

  if (!open) return null;

  const updateOne = (chat: Chat) => {
    setChats((prev) => prev.map((row) => row.id === chat.id ? chat : row));
  };

  const launchIntoChat = (chat: Chat, prompt?: string) => {
    setChats((prev) => [chat, ...prev.filter((c) => c.id !== chat.id)]);
    setCurrentId(chat.id);
    setTab("chat");
    if (prompt && prompt.trim()) {
      setAutoPrompt({ nonce: Date.now() + Math.random(), chatId: chat.id, text: prompt });
    }
  };

  const newChat = async () => {
    setBusy(true);
    setError("");
    try {
      const chat = await createChat({});
      launchIntoChat(chat);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createQuickHtmlArtifact = async () => {
    setLaunching("new-art");
    setError("");
    try {
      const created = await createStandaloneArtifact({
        title: `Entwurf ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`,
        kind: "html",
        chat_id: currentId ?? undefined,
        content: [
          "<!doctype html>",
          '<html lang="de"><head><meta charset="utf-8"><style>',
          "body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f7f5f0;color:#1d1b18}",
          ".card{background:#fff;border:1px solid #e2ddd2;border-radius:12px;padding:20px;max-width:680px}",
          "h1{margin:0 0 8px;font-size:20px;color:#0b7a67}",
          "</style></head><body><div class='card'>",
          "<h1>Musterwerk Artefakt</h1>",
          "<p>Bearbeite diesen Quelltext direkt im Split-Modus oder lass den Assistenten ein Live-Dashboard erzeugen.</p>",
          "</div></body></html>",
        ].join("\n"),
      });
      await loadArtifactsData();
      openArtifactInSideFrame(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLaunching(null);
    }
  };

  const handleStartBuiltinAgent = async (key: string, opts: { template_key?: string } = {}) => {
    const tag = `ba-${key}-${opts.template_key || ""}`;
    setLaunching(tag);
    setError("");
    try {
      const res = await startBuiltinAgent(key, opts);
      launchIntoChat(res.chat, res.prompt || undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLaunching(null);
    }
  };

  const handleStartCustomAgent = async (id: number, opts: { routine_id?: number; template_key?: string } = {}) => {
    const tag = `ca-${id}-${opts.routine_id || opts.template_key || ""}`;
    setLaunching(tag);
    setError("");
    try {
      const res = await startCustomAgent(id, opts);
      launchIntoChat(res.chat, res.prompt || undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLaunching(null);
    }
  };

  const handleRunRoutine = async (id: number) => {
    setLaunching(`r-${id}`);
    setError("");
    try {
      const res = await runRoutine(id);
      launchIntoChat(res.chat, res.prompt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLaunching(null);
    }
  };

  const handleRunTemplate = async (key: string) => {
    setLaunching(`t-${key}`);
    setError("");
    try {
      const res = await runRoutineTemplate(key);
      launchIntoChat(res.chat, res.prompt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLaunching(null);
    }
  };

  /* Esc schließt erst den Side Frame, dann die Leiste */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (document.querySelector(".bp5-dialog, .bp5-overlay-open")) return;
    event.preventDefault();
    if (sideExpanded) { setSideExpanded(false); return; }
    if (sideOpen) { setSideOpen(false); return; }
    onClose();
  };

  /* Breite des Copilot-Docks ziehen */
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (narrow) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setDragging(true);
    const right = panel.current?.getBoundingClientRect().right ?? window.innerWidth;
    const move = (e: PointerEvent) => setWidth(right - e.clientX, false);
    const up = (e: PointerEvent) => {
      target.releasePointerCapture(e.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDragging(false);
      setWidth(right - e.clientX, true);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  const keyResize = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); setWidth(width + 24); }
    else if (event.key === "ArrowRight") { event.preventDefault(); setWidth(width - 24); }
  };

  /* Breite des Side Preview Frames ziehen */
  const startSideDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (narrow || sideExpanded) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setSideDragging(true);
    const startX = event.clientX;
    const startW = sideWidth;
    const maxAllowed = Math.max(420, vw - width - 36);
    const move = (e: PointerEvent) => {
      const next = Math.max(380, Math.min(maxAllowed, startW + (startX - e.clientX)));
      setSideWidth(next);
    };
    const up = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setSideDragging(false);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const floating = !narrow && (alwaysFloat || vw - reserve - width < minMain);
  const clampedSideWidth = Math.min(sideWidth, Math.max(380, vw - width - 24));

  const noProvider = loaded && !error && providers.length > 0
    && !providers.some((p) => p.enabled && (p.has_key || p.requires_key === false));
  const noProviderAtAll = loaded && !error && providers.length === 0;
  const setupNeeded = noProvider || noProviderAtAll;

  const badgeCount = previewTabs.length || artifacts.length;

  return (
    <>
      {narrow && <button type="button" className="copilot-scrim" aria-label="Assistent schließen" onClick={onClose} />}

      {/* Dedizierter Side Preview Frame für Artefakte, HTML-Webseiten, Berichte & Dateien */}
      {sideOpen && (
        <section
          className={`copilot-sideframe agent-popup${sideExpanded ? " is-expanded" : ""}${sideDragging ? " is-resizing" : ""}`}
          style={narrow || sideExpanded ? undefined : { width: clampedSideWidth, right: width }}
          aria-label="Seiten-Vorschau für Artefakte, Webseiten und Dateien"
          onKeyDown={onKeyDown}
        >
          {!narrow && !sideExpanded && (
            <div
              className="copilot-sideframe-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="Breite des Seiten-Vorschaufensters anpassen"
              onPointerDown={startSideDrag}
              onDoubleClick={() => setSideWidth(600)}
              title="Ziehen zum Skalieren · Doppelklick für Standardbreite"
            />
          )}
          <PreviewPane
            chatId={currentId}
            tabs={previewTabs}
            activeTabId={activePreviewId}
            artifacts={artifacts}
            attachments={[]}
            expanded={sideExpanded}
            onSelectTab={setActivePreviewId}
            onCloseTab={closePreviewTab}
            onUpdateTab={updatePreviewTab}
            onAddTab={openOrFocusSideTab}
            onToggleExpand={() => setSideExpanded((v) => !v)}
            onClose={() => { setSideExpanded(false); setSideOpen(false); }}
            onArtifactsChanged={() => { void loadArtifactsData(); }}
          />
        </section>
      )}

      <aside ref={panel} className={`copilot-dock agent-popup${dragging ? " is-dragging" : ""}${floating ? " is-float" : ""}`}
        style={narrow ? undefined : { width }} aria-label="Assistent" onKeyDown={onKeyDown}>
        {!narrow && (
          <div className="copilot-resize" role="separator" aria-orientation="vertical"
            aria-label="Breite der Seitenleiste" aria-valuemin={MIN_W} aria-valuemax={MAX_W}
            aria-valuenow={width} tabIndex={0} onPointerDown={startDrag} onKeyDown={keyResize} />
        )}
        <div className="copilot-head agent-popup-head">
          <span className="agent-popup-brand">
            <BotSmiley size={24} variant="brand" trackMouse />
            <span className="agent-popup-title">
              <strong>{current?.agent_name || "Assistent"}</strong>
              <span>{current?.agent_name ? "Spezialist · Gimel" : "Gimel Copilot"}</span>
            </span>
          </span>
          <HTMLSelect
            className="agent-popup-select"
            aria-label="Chat wählen"
            value={currentId ?? ""}
            onChange={(event) => { setCurrentId(Number(event.target.value) || null); setTab("chat"); }}
          >
            {chats.length === 0 && <option value="">Kein Chat</option>}
            {chats.map((chat) => (
              <option key={chat.id} value={chat.id}>
                {chat.agent_name ? `[${chat.agent_name}] ` : ""}{chat.title || "Neuer Chat"}
              </option>
            ))}
          </HTMLSelect>
          <Button minimal small icon="application" active={sideOpen}
            className={`copilot-side-btn${sideOpen ? " is-active" : ""}`}
            aria-label="Seiten-Vorschau für Artefakte & Browser öffnen"
            title={sideOpen ? "Seiten-Vorschau schließen" : "Seiten-Vorschau & Browser öffnen (Artefakte, HTML, Dateien)"}
            text={badgeCount > 0 ? String(badgeCount) : undefined}
            onClick={() => setSideOpen((v) => !v)} />
          <Button minimal small icon="plus" aria-label="Neuer Chat" title="Neuer Chat"
            loading={busy} onClick={newChat} />
          <a className="bp5-button bp5-minimal bp5-small" href="/lab/" aria-label="Im Agent Lab öffnen" title="Vollansicht im Agent Lab öffnen">
            <Icon icon="share" size={13} aria-hidden="true" />
          </a>
          <Button minimal small icon="cross" aria-label="Schließen" title="Schließen (Strg+Shift+A)"
            onClick={onClose} />
        </div>

        <nav className="copilot-subtabs" role="tablist" aria-label="Assistent-Bereiche">
          <button type="button" role="tab" aria-selected={tab === "chat"}
            className={tab === "chat" ? "is-active" : ""} onClick={() => setTab("chat")}>
            <Icon icon="chat" size={12} aria-hidden="true" /> Chat
          </button>
          <button type="button" role="tab" aria-selected={tab === "agents"}
            className={tab === "agents" ? "is-active" : ""} onClick={() => setTab("agents")}>
            <Icon icon="predictive-analysis" size={12} aria-hidden="true" /> Agenten
          </button>
          <button type="button" role="tab" aria-selected={tab === "routines"}
            className={tab === "routines" ? "is-active" : ""} onClick={() => setTab("routines")}>
            <Icon icon="repeat" size={12} aria-hidden="true" /> Routinen
          </button>
          <button type="button" role="tab" aria-selected={tab === "artifacts"}
            className={tab === "artifacts" ? "is-active" : ""} onClick={() => setTab("artifacts")}>
            <Icon icon="application" size={12} aria-hidden="true" /> Artefakte
            {artifacts.length > 0 && <span className="copilot-tab-count">{artifacts.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "settings"}
            className={tab === "settings" ? "is-active" : ""} onClick={() => setTab("settings")}
            title="Assistent- & Container-Sandbox-Einstellungen">
            <Icon icon="cog" size={12} aria-hidden="true" /> Einstellungen
          </button>
        </nav>

        <div className="agent-popup-body">
          {tab === "chat" && (
            <>
              {loading && !current && (
                <div className="agent-popup-state"><Spinner size={26} /><span>Assistent wird geladen</span></div>
              )}
              {!loading && error && (
                <div className="agent-popup-state is-error">
                  <Icon icon="warning-sign" size={18} aria-hidden="true" />
                  <strong>Assistent nicht erreichbar</strong>
                  <p>{error}</p>
                  <Button small icon="refresh" text="Erneut versuchen" onClick={refresh} />
                </div>
              )}
              {!loading && !error && setupNeeded && !current && (
                <div className="agent-popup-state">
                  <Icon icon="key" size={22} aria-hidden="true" />
                  <strong>Assistent noch nicht eingerichtet</strong>
                  <p>Ein Administrator kann unter Agent Lab → Einstellungen einen Cloud-Anbieter (Google Gemini, Anthropic, OpenAI …) oder lokale Ollama-Modelle aktivieren.</p>
                  <Button small icon="share" text="Agent Lab öffnen" onClick={() => window.open("/lab", "_blank", "noopener")} />
                </div>
              )}
              {!loading && !error && !setupNeeded && !current && (
                <div className="agent-popup-state">
                  <Icon icon="chat" size={22} aria-hidden="true" />
                  <strong>Noch kein Gespräch</strong>
                  <p>Starten Sie einen Chat, öffnen Sie den Seiten-Vorschau-Frame oder wählen Sie einen Spezialisten-Agenten.</p>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                    <Button intent="primary" icon="plus" text="Neuen Chat" loading={busy} onClick={newChat} />
                    <Button icon="predictive-analysis" text="Agenten" onClick={() => setTab("agents")} />
                    <Button icon="application" text="Side-Vorschau" onClick={() => setSideOpen(true)} />
                  </div>
                </div>
              )}
              {!error && current && (
                <ChatPane
                  key={current.id}
                  compact
                  user={user}
                  chat={current}
                  providers={providers}
                  contextOpen={false}
                  autoPrompt={autoPrompt}
                  onAutoPromptConsumed={() => setAutoPrompt(null)}
                  onOpenArtifact={openArtifactInSideFrame}
                  onOpenPreviewTab={openOrFocusSideTab}
                  onChatUpdated={updateOne}
                  onChatsChanged={refreshChatList}
                />
              )}
            </>
          )}

          {tab === "agents" && (
            <div className="copilot-panel">
              <div className="copilot-panel-head">
                <div className="copilot-filter-pills">
                  <button type="button" className={agentFilter === "all" ? "is-active" : ""}
                    onClick={() => setAgentFilter("all")}>Alle</button>
                  <button type="button" className={agentFilter === "with_routines" ? "is-active" : ""}
                    onClick={() => setAgentFilter("with_routines")}>Mit Routinen</button>
                  <button type="button" className={agentFilter === "without_routines" ? "is-active" : ""}
                    onClick={() => setAgentFilter("without_routines")}>Ohne Routinen</button>
                </div>
                <a className="copilot-lab-link" href="/lab/" target="_blank" rel="noopener noreferrer">
                  Verwalten ↗
                </a>
              </div>

              {!agentsLoaded ? (
                <div className="agent-popup-state"><Spinner size={22} /><span>Agenten werden geladen …</span></div>
              ) : (
                <div className="copilot-card-list">
                  {visibleCustomAgents.map((agent) => (
                    <div className="copilot-card" key={`c-${agent.id}`}>
                      <div className="copilot-card-top">
                        <span className="copilot-card-avatar" style={{ background: agent.color || "var(--lab-accent)" }}>
                          <Icon icon={(agent.icon || "predictive-analysis") as any} size={14} />
                        </span>
                        <div className="copilot-card-info">
                          <strong>{agent.name}</strong>
                          <span>{agent.role_title || "Eigener Agent"}</span>
                        </div>
                        <Tag minimal intent={agent.has_routines ? "primary" : "none"}>
                          {agent.has_routines ? "Routinen" : "Direkt"}
                        </Tag>
                      </div>
                      {agent.description && <p className="copilot-card-desc">{agent.description}</p>}
                      {agent.has_routines && (agent.routine_ids.length > 0 || agent.template_keys.length > 0) && (
                        <div className="copilot-chip-row">
                          {agent.routine_ids.map((rid) => {
                            const r = routineMap.get(rid);
                            if (!r) return null;
                            return (
                              <button key={`rid-${rid}`} type="button" className="copilot-run-chip"
                                disabled={launching !== null}
                                onClick={() => handleStartCustomAgent(agent.id, { routine_id: rid })}>
                                <Icon icon="play" size={10} /> {r.name}
                              </button>
                            );
                          })}
                          {agent.template_keys.map((tk) => {
                            const t = templateMap.get(tk);
                            if (!t) return null;
                            return (
                              <button key={`tk-${tk}`} type="button" className="copilot-run-chip"
                                disabled={launching !== null}
                                onClick={() => handleStartCustomAgent(agent.id, { template_key: tk })}>
                                <Icon icon="play" size={10} /> {t.name}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <div className="copilot-card-actions">
                        <Button small intent="primary" icon="chat" text="Chat starten"
                          loading={launching === `ca-${agent.id}-`}
                          onClick={() => handleStartCustomAgent(agent.id)} />
                      </div>
                    </div>
                  ))}

                  {visibleBuiltinAgents.map((agent) => (
                    <div className="copilot-card" key={`b-${agent.key}`}>
                      <div className="copilot-card-top">
                        <span className="copilot-card-avatar" style={{ background: agent.color }}>
                          <Icon icon={agent.icon as any} size={14} />
                        </span>
                        <div className="copilot-card-info">
                          <strong>{agent.name}</strong>
                          <span>{agent.role_title}</span>
                        </div>
                        <Tag minimal intent={agent.has_routines ? "primary" : "none"}>
                          {agent.has_routines ? "Routinen" : "Direkt"}
                        </Tag>
                      </div>
                      <p className="copilot-card-desc">{agent.description}</p>
                      {agent.has_routines && agent.template_keys.length > 0 && (
                        <div className="copilot-chip-row">
                          {agent.template_keys.map((tk) => {
                            const t = templateMap.get(tk);
                            if (!t) return null;
                            return (
                              <button key={tk} type="button" className="copilot-run-chip"
                                disabled={launching !== null}
                                onClick={() => handleStartBuiltinAgent(agent.key, { template_key: tk })}>
                                <Icon icon="play" size={10} /> {t.name}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <div className="copilot-card-actions">
                        <Button small intent="primary" icon="chat"
                          text={agent.has_routines ? "Freier Chat" : "Starten"}
                          loading={launching === `ba-${agent.key}-`}
                          onClick={() => handleStartBuiltinAgent(agent.key)} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "routines" && (
            <div className="copilot-panel">
              <div className="copilot-panel-head">
                <strong className="copilot-panel-title">Routinen &amp; Vorlagen</strong>
                <a className="copilot-lab-link" href="/lab/" target="_blank" rel="noopener noreferrer">
                  Neue Routine ↗
                </a>
              </div>
              {!routinesLoaded ? (
                <div className="agent-popup-state"><Spinner size={22} /><span>Routinen werden geladen …</span></div>
              ) : (
                <div className="copilot-card-list">
                  {routines.map((r) => (
                    <div className="copilot-card" key={`r-${r.id}`}>
                      <div className="copilot-card-top">
                        <span className="copilot-card-avatar is-soft">
                          <Icon icon={(r.icon || "repeat") as any} size={14} />
                        </span>
                        <div className="copilot-card-info">
                          <strong>{r.name}</strong>
                          <span>{r.category} · {r.steps.length} Schritte</span>
                        </div>
                        <Button small intent="primary" icon="play" text="Start"
                          loading={launching === `r-${r.id}`}
                          onClick={() => handleRunRoutine(r.id)} />
                      </div>
                      {r.description && <p className="copilot-card-desc">{r.description}</p>}
                    </div>
                  ))}
                  {templates.map((t) => (
                    <div className="copilot-card" key={`t-${t.key}`}>
                      <div className="copilot-card-top">
                        <span className="copilot-card-avatar is-clay">
                          <Icon icon={t.icon as any} size={14} />
                        </span>
                        <div className="copilot-card-info">
                          <strong>{t.name}</strong>
                          <span>Vorlage · {t.category}</span>
                        </div>
                        <Button small intent="primary" icon="play" text="Start"
                          loading={launching === `t-${t.key}`}
                          onClick={() => handleRunTemplate(t.key)} />
                      </div>
                      <p className="copilot-card-desc">{t.description}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "artifacts" && (
            <div className="copilot-panel">
              <div className="copilot-panel-head">
                <strong className="copilot-panel-title">Artefakte ({filteredArtifacts.length})</strong>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <Button small intent="primary" icon="plus" text="Neu"
                    loading={launching === "new-art"}
                    onClick={createQuickHtmlArtifact} />
                  <Button small minimal icon="application" title="Side Frame öffnen"
                    active={sideOpen}
                    onClick={() => setSideOpen((v) => !v)} />
                  <Button small minimal icon="refresh" title="Aktualisieren"
                    onClick={() => void loadArtifactsData()} />
                </div>
              </div>

              <input
                className="bp5-input copilot-art-search"
                placeholder="Artefakte durchsuchen …"
                value={artifactSearch}
                onChange={(e) => setArtifactSearch(e.target.value)}
                aria-label="Artefakte durchsuchen"
              />

              <div className="copilot-filter-pills">
                {(["all", "html", "svg", "markdown", "csv", "json", "code"] as ArtifactKindFilter[]).map((k) => (
                  <button key={k} type="button" className={artifactKind === k ? "is-active" : ""}
                    onClick={() => setArtifactKind(k)}>
                    {k === "all" ? "Alle" : k.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="copilot-side-shortcuts">
                <button type="button" className="copilot-run-chip"
                  onClick={() => openOrFocusSideTab({
                    id: "web-/twin", source: "web", kind: "web", title: "3D Twin",
                    url: "/twin", history: ["/twin"], historyIndex: 0, webMode: "direct",
                  })}>
                  <Icon icon="cube" size={11} /> 3D Twin im Side Frame
                </button>
                <button type="button" className="copilot-run-chip"
                  onClick={() => openOrFocusSideTab({
                    id: "web-/lab", source: "web", kind: "web", title: "Agent Lab",
                    url: "/lab", history: ["/lab"], historyIndex: 0, webMode: "direct",
                  })}>
                  <Icon icon="globe-network" size={11} /> Browser öffnen
                </button>
              </div>

              {!artifactsLoaded ? (
                <div className="agent-popup-state"><Spinner size={22} /><span>Artefakte werden geladen …</span></div>
              ) : filteredArtifacts.length === 0 ? (
                <div className="agent-popup-state">
                  <Icon icon="application" size={22} aria-hidden="true" />
                  <strong>Noch keine Artefakte</strong>
                  <p>Klicke auf „Neu“ oder lass den Assistenten ein HTML-Dashboard, Diagramm, Bericht oder CSV erzeugen — es öffnet sich direkt im Side Frame.</p>
                </div>
              ) : (
                <div className="copilot-card-list">
                  {filteredArtifacts.map((art) => {
                    const isActive = sideOpen && activePreviewId === `art-${art.id}`;
                    return (
                      <button type="button"
                        className={`copilot-artifact-row${isActive ? " is-active" : ""}`}
                        key={art.id}
                        onClick={() => openArtifactInSideFrame(art)}>
                        <span className="copilot-card-avatar is-soft">
                          <Icon icon={art.kind === "svg" ? "media" : art.kind === "csv" ? "th" : "application"} size={14} />
                        </span>
                        <span className="copilot-card-info">
                          <strong>{art.title}</strong>
                          <span>{art.kind.toUpperCase()} · v{art.version} · {art.chat_title || `Chat #${art.chat_id}`}</span>
                        </span>
                        <Icon icon="eye-open" size={13} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === "settings" && (
            <div className="copilot-panel" style={{ overflowY: "auto" }}>
              <AgentSettings compact onChanged={refresh} />
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
