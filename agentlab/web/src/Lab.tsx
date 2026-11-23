import {
  Button, Dialog, DialogBody, DialogFooter, FormGroup, Icon, InputGroup, Menu,
  MenuDivider, MenuItem, Popover, Spinner, Tag, showContextMenu,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ApiError, Artifact, Chat, clearChat, createChat, deleteChat, listAllArtifacts, listChats,
  listProposals, listProviders, logout, Provider, SessionUser, updateChat,
} from "./api";
import { plainPreview } from "./chatUtils";
import AgentSettings from "./AgentSettings";
import Agents from "./Agents";
import Artifacts from "./Artifacts";
import BotSmiley from "./BotSmiley";
import ChatPane from "./ChatPane";
import Changes from "./Changes";
import CommandPalette, { CommandItem } from "./CommandPalette";
import ErrorBoundary from "./ErrorBoundary";
import KnowledgeGraph from "./KnowledgeGraph";
import type { PreviewTab } from "./PreviewPane";
import Proposals from "./Proposals";
import Providers from "./Providers";
import Routines from "./Routines";
import SidebarUpdateButton from "./SidebarUpdateButton";
import Stats from "./Stats";
import Tools from "./Tools";

type View = "chat" | "graph" | "agents" | "routines" | "artifacts" | "proposals" | "changes" | "stats" | "tools" | "settings";

const VIEW_LABEL: Record<View, string> = {
  chat: "Chat", graph: "Wissensgraph", agents: "Agenten", routines: "Routinen", artifacts: "Artefakte",
  proposals: "Vorschläge", changes: "Änderungen", stats: "Statistik",
  tools: "Werkzeuge", settings: "Einstellungen",
};
const VIEW_ICON: Record<View, string> = {
  chat: "chat", graph: "graph", agents: "predictive-analysis", routines: "repeat", artifacts: "application",
  proposals: "endorsed", changes: "changes", stats: "chart",
  tools: "wrench", settings: "cog",
};

const PIN_KEY = "agentlab-pinned-chats";
const SIDEBAR_KEY = "agentlab-sidebar";
const CONTEXT_KEY = "agentlab-context";

function readPinned(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
    return Array.isArray(raw) ? raw.map(Number).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* egal */ }
}

function chatTime(chat: Chat): number {
  const value = new Date(chat.last_message_at || chat.updated_at || chat.created_at).getTime();
  return Number.isNaN(value) ? 0 : value;
}

function groupChats(chats: Chat[]): Array<{ label: string; chats: Chat[] }> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = new Map<string, Chat[]>();
  for (const chat of [...chats].sort((a, b) => chatTime(b) - chatTime(a))) {
    const time = chatTime(chat);
    const label = time >= today ? "Heute"
      : time >= today - 86400000 ? "Gestern"
      : time >= today - 6 * 86400000 ? "Diese Woche"
      : time >= today - 29 * 86400000 ? "Diesen Monat"
      : "Älter";
    groups.set(label, [...(groups.get(label) ?? []), chat]);
  }
  return Array.from(groups, ([label, items]) => ({ label, chats: items }));
}

export default function Lab({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [view, setView] = useState<View>("chat");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [presets, setPresets] = useState<Record<string, Record<string, string>>>({});
  const [chats, setChats] = useState<Chat[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(() => {
    const raw = localStorage.getItem("agentlab-current-chat");
    return raw ? Number(raw) || null : null;
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [deleting, setDeleting] = useState<Chat | null>(null);
  const [renaming, setRenaming] = useState<Chat | null>(null);
  const [renameText, setRenameText] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [pinned, setPinned] = useState<number[]>(readPinned);
  const [sidebarOpen, setSidebarOpen] = useState(() => (
    window.innerWidth > 860 ? readFlag(SIDEBAR_KEY, true) : false
  ));
  const [newChatKind, setNewChatKind] = useState<"classic" | "orchestrator">(
    () => (localStorage.getItem("agentlab-new-chat-kind") === "orchestrator" ? "orchestrator" : "classic")
  );
  const [contextOpen, setContextOpen] = useState(() => readFlag(CONTEXT_KEY, window.innerWidth > 1280));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRequest, setPreviewRequest] = useState<{ nonce: number; tab: PreviewTab } | null>(null);
  const [autoPrompt, setAutoPrompt] = useState<{ nonce: number; chatId: number; text: string } | null>(null);
  const [artifactCount, setArtifactCount] = useState(0);
  const [totalArtifacts, setTotalArtifacts] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingProposals, setPendingProposals] = useState(0);
  const [gimelVersion, setGimelVersion] = useState<string>("");

  useEffect(() => {
    fetch("/api/version")
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (v && typeof v.version === "string") setGimelVersion(v.version);
      })
      .catch(() => { /* ignore */ });
  }, []);
  const [darkTheme, setDarkTheme] = useState(() => document.documentElement.dataset.theme === "dark");
  const [refreshToken, setRefreshToken] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const current = useMemo(
    () => chats.find((c) => c.id === currentId) ?? null,
    [chats, currentId],
  );
  const admin = user.role === "admin" || user.adminWork === true;
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);

  const chatKindOf = (chat: Chat) => chat.kind === "orchestrator" ? "orchestrator" : "classic";
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return chats.filter((chat) => {
      if (chatKindOf(chat) !== newChatKind) return false;
      return !needle || `${chat.title} ${chat.last_message}`.toLowerCase().includes(needle);
    });
  }, [chats, search, newChatKind]);

  const pinnedChats = useMemo(
    () => filtered.filter((chat) => pinnedSet.has(chat.id)).sort((a, b) => chatTime(b) - chatTime(a)),
    [filtered, pinnedSet],
  );
  const groups = useMemo(
    () => groupChats(filtered.filter((chat) => !pinnedSet.has(chat.id))),
    [filtered, pinnedSet],
  );

  const refreshChats = useCallback(async () => {
    try {
      const data = await listChats();
      setChats(data.chats);
      const visible = data.chats.filter(
        (c) => (c.kind === "orchestrator" ? "orchestrator" : "classic") === newChatKind
      );
      setCurrentId((id) => {
        if (id && visible.some((c) => c.id === id)) return id;
        return visible[0]?.id ?? null;
      });
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [newChatKind]);

  const refreshProviders = useCallback(async () => {
    try {
      const data = await listProviders();
      setProviders(data.providers);
      setPresets(data.presets);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  const refreshProposalsBadge = useCallback(async () => {
    if (user.role === "worker") return;
    try {
      const data = await listProposals("pending");
      setPendingProposals(data.pending_count ?? 0);
    } catch { /* optional */ }
  }, [user.role]);

  const refreshArtifactBadge = useCallback(async () => {
    try {
      const data = await listAllArtifacts();
      setTotalArtifacts(data.total ?? data.artifacts.length);
    } catch { /* optional */ }
  }, []);

  useEffect(() => {
    Promise.allSettled([refreshChats(), refreshProviders(), refreshProposalsBadge(), refreshArtifactBadge()])
      .finally(() => setLoading(false));
  }, [refreshChats, refreshProviders, refreshProposalsBadge, refreshArtifactBadge]);

  useEffect(() => {
    if (currentId) localStorage.setItem("agentlab-current-chat", String(currentId));
    else localStorage.removeItem("agentlab-current-chat");
  }, [currentId]);

  useEffect(() => {
    try { localStorage.setItem(PIN_KEY, JSON.stringify(pinned)); } catch { /* egal */ }
  }, [pinned]);

  useEffect(() => {
    if (window.innerWidth > 860) writeFlag(SIDEBAR_KEY, sidebarOpen);
  }, [sidebarOpen]);
  useEffect(() => {
    try { localStorage.setItem("agentlab-new-chat-kind", newChatKind); } catch { /* egal */ }
    setCurrentId((id) => {
      const visible = chats.filter((c) => (c.kind === "orchestrator" ? "orchestrator" : "classic") === newChatKind);
      if (id && visible.some((c) => c.id === id)) return id;
      return visible[0]?.id ?? null;
    });
  }, [newChatKind, chats]);
  useEffect(() => { writeFlag(CONTEXT_KEY, contextOpen); }, [contextOpen]);

  /* Ein Tabwechsel kann die Sitzung und die Chatliste veralten lassen. Beim
     Zurückkehren still nachlesen, statt die Seite neu laden zu müssen. */
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      refreshChats();
      if (view === "chat") setRefreshToken((value) => value + 1);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshChats, view]);

  const closeSidebarOnMobile = useCallback(() => {
    if (window.innerWidth <= 860) setSidebarOpen(false);
  }, []);

  const selectChat = useCallback((id: number, chatObj?: Chat) => {
    const target = chatObj ?? chats.find((c) => c.id === id);
    if (target) {
      const targetKind = target.kind === "orchestrator" ? "orchestrator" : "classic";
      setNewChatKind(targetKind);
    }
    setCurrentId(id);
    setView("chat");
    closeSidebarOnMobile();
  }, [chats, closeSidebarOnMobile]);

  const newChat = useCallback(async (openDrawer = false, kind: string = "classic") => {
    setBusy(true);
    setError("");
    try {
      const chat = await createChat({ kind });
      setChats((prev) => [chat, ...prev]);
      setCurrentId(chat.id);
      setView("chat");
      closeSidebarOnMobile();
      if (openDrawer) setDrawer(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [closeSidebarOnMobile]);

  const openView = (next: View) => {
    setView(next);
    if (next === "chat") setRefreshToken((value) => value + 1);
  };

  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), []);
  const toggleContext = useCallback(() => {
    setContextOpen((value) => {
      const next = !value;
      if (next && window.innerWidth < 1520) setPreviewOpen(false);
      return next;
    });
  }, []);
  const handlePreviewOpenChange = useCallback((next: boolean) => {
    setPreviewOpen(next);
    if (next && window.innerWidth < 1520) setContextOpen(false);
  }, []);
  const togglePreview = useCallback(() => {
    setPreviewOpen((value) => {
      const next = !value;
      if (next && window.innerWidth < 1520) setContextOpen(false);
      return next;
    });
  }, []);

  const openPreviewTabFromLab = useCallback((tab: PreviewTab) => {
    setView("chat");
    setPreviewOpen(true);
    if (window.innerWidth < 1520) setContextOpen(false);
    setPreviewRequest({ nonce: Date.now() + Math.random(), tab });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "k") {
        event.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && event.shiftKey && key === "p") {
        event.preventDefault();
        setView("chat");
        togglePreview();
      } else if (mod && event.shiftKey && key === "o") {
        event.preventDefault();
        void newChat(false, newChatKind);
      } else if (mod && key === "b") {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      } else if (mod && key === "j") {
        event.preventDefault();
        toggleContext();
      } else if (event.key === "Escape" && drawer) {
        setDrawer(false);
      } else if (event.key === "Escape" && sidebarOpen && window.innerWidth <= 860) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, newChat, newChatKind, sidebarOpen, toggleContext, togglePreview]);

  const openDrawer = async () => {
    if (!currentId || !current) await newChat(true);
    else setDrawer(true);
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await deleteChat(deleting.id);
      setPinned((prev) => prev.filter((id) => id !== deleting.id));
      if (currentId === deleting.id) setCurrentId(null);
      setDeleting(null);
      await refreshChats();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (chat: Chat) => {
    setBusy(true);
    setError("");
    try {
      await clearChat(chat.id);
      if (currentId === chat.id) setRefreshToken((value) => value + 1);
      await refreshChats();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const switchKind = async (chat: Chat) => {
    const next = chat.kind === "orchestrator" ? "classic" : "orchestrator";
    setBusy(true);
    setError("");
    try {
      const updated = await updateChat(chat.id, { kind: next });
      updateOne(updated);
      setNewChatKind(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!renaming) return;
    setBusy(true);
    setError("");
    try {
      const next = await updateChat(renaming.id, { title: renameText });
      setChats((prev) => prev.map((c) => c.id === next.id ? next : c));
      setRenaming(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const togglePin = (chat: Chat) => {
    setPinned((prev) => prev.includes(chat.id)
      ? prev.filter((id) => id !== chat.id)
      : [...prev, chat.id]);
  };

  const updateOne = (chat: Chat) => {
    setChats((prev) => prev.map((c) => c.id === chat.id ? chat : c));
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.allSettled([refreshChats(), refreshProviders(), refreshProposalsBadge(), refreshArtifactBadge()]);
    setRefreshToken((value) => value + 1);
    setRefreshing(false);
  };

  const toggleTheme = useCallback(() => {
    const dark = document.documentElement.dataset.theme === "dark";
    const next = dark ? "light" : "dark";
    localStorage.setItem("gimel-theme", next);
    document.documentElement.dataset.theme = next;
    document.body.classList.toggle("bp5-dark", next === "dark");
    setDarkTheme(next === "dark");
  }, []);

  const launchRoutineChat = useCallback((chat: Chat, prompt: string) => {
    setChats((prev) => [chat, ...prev.filter((c) => c.id !== chat.id)]);
    selectChat(chat.id, chat);
    setAutoPrompt({ nonce: Date.now() + Math.random(), chatId: chat.id, text: prompt });
  }, [selectChat]);

  const launchAgentChat = useCallback((chat: Chat, prompt?: string) => {
    setChats((prev) => [chat, ...prev.filter((c) => c.id !== chat.id)]);
    selectChat(chat.id, chat);
    if (prompt && prompt.trim()) {
      setAutoPrompt({ nonce: Date.now() + Math.random(), chatId: chat.id, text: prompt });
    }
  }, [selectChat]);

  const openArtifactInSidePreview = useCallback((art: Artifact) => {
    setCurrentId(art.chat_id);
    openPreviewTabFromLab({
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
  }, [openPreviewTabFromLab]);

  const analyzeGraphNodeInChat = useCallback(async (_node: { label: string }, prompt: string) => {
    setBusy(true);
    setError("");
    try {
      const existingOrch = chats.find((c) => c.kind === "orchestrator");
      if (existingOrch) {
        setNewChatKind("orchestrator");
        setCurrentId(existingOrch.id);
        setView("chat");
        setAutoPrompt({ nonce: Date.now() + Math.random(), chatId: existingOrch.id, text: prompt });
      } else {
        const created = await createChat({ kind: "orchestrator", title: `Analyse: ${_node.label}`.slice(0, 80) });
        setChats((prev) => [created, ...prev]);
        setNewChatKind("orchestrator");
        setCurrentId(created.id);
        setView("chat");
        setAutoPrompt({ nonce: Date.now() + Math.random(), chatId: created.id, text: prompt });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [chats]);

  const paletteCommands = useMemo<CommandItem[]>(() => [
    { id: "new-chat-orch", group: "Chat", title: "Neuer Chat (Orchestrator)", subtitle: "200k Kontext, Subagenten & Wissensgraph", icon: "flow-branch", shortcut: "Strg+Shift+O", run: () => { setNewChatKind("orchestrator"); void newChat(false, "orchestrator"); } },
    { id: "new-chat-classic", group: "Chat", title: "Neuer Chat (klassisch)", icon: "plus", run: () => { setNewChatKind("classic"); void newChat(false, "classic"); } },
    { id: "v-graph", group: "Bereiche", title: "Plattform-Wissensgraph öffnen", subtitle: "Fluss, Risiken, Wirkungsketten & Erkenntnisse", icon: "graph", run: () => openView("graph") },
    { id: "v-agents", group: "Bereiche", title: "Spezialisten-Agenten (mit & ohne Routinen)", icon: "predictive-analysis", run: () => openView("agents") },
    { id: "v-routines", group: "Bereiche", title: "Routinen & Vorlagen öffnen", icon: "repeat", run: () => openView("routines") },
    { id: "v-artifacts", group: "Bereiche", title: "Artefakt-Bibliothek & Anzeige", icon: "application", run: () => openView("artifacts") },
    { id: "toggle-preview", group: "Vorschau", title: previewOpen ? "Seiten-Vorschau ausblenden" : "Seiten-Vorschau & Browser öffnen", icon: "application", shortcut: "Strg+Shift+P", run: () => { setView("chat"); togglePreview(); } },
    {
      id: "preview-portal", group: "Vorschau", title: "Gimel Portal im Seiten-Browser öffnen", subtitle: "/app",
      icon: "globe-network",
      run: () => openPreviewTabFromLab({
        id: "web-/app", source: "web", kind: "web", title: "Gimel Portal", url: "/app", history: ["/app"], historyIndex: 0, webMode: "direct",
      }),
    },
    {
      id: "preview-twin", group: "Vorschau", title: "3D Twin im Seiten-Browser öffnen", subtitle: "/twin",
      icon: "cube",
      run: () => openPreviewTabFromLab({
        id: "web-/twin", source: "web", kind: "web", title: "3D Twin", url: "/twin", history: ["/twin"], historyIndex: 0, webMode: "direct",
      }),
    },
    { id: "toggle-theme", group: "Ansicht", title: darkTheme ? "Helles Design aktivieren" : "Dunkles Design aktivieren", icon: darkTheme ? "flash" : "moon", run: toggleTheme },
    { id: "toggle-sidebar", group: "Ansicht", title: sidebarOpen ? "Seitenleiste ausblenden" : "Seitenleiste einblenden", icon: "menu", shortcut: "Strg+B", run: toggleSidebar },
    { id: "toggle-context", group: "Ansicht", title: contextOpen ? "Kontext ausblenden" : "Kontext einblenden", icon: "drawer-right", shortcut: "Strg+J", run: toggleContext },
    { id: "v-chat", group: "Bereiche", title: "Bereich: Chat", icon: "chat", run: () => openView("chat") },
    { id: "v-proposals", group: "Bereiche", title: "Bereich: Vorschläge", icon: "endorsed", run: () => openView("proposals") },
    { id: "v-changes", group: "Bereiche", title: "Bereich: Änderungen", icon: "changes", run: () => openView("changes") },
    { id: "v-stats", group: "Bereiche", title: "Bereich: Statistik", icon: "chart", run: () => openView("stats") },
    { id: "v-tools", group: "Bereiche", title: "Bereich: Werkzeuge", icon: "wrench", run: () => openView("tools") },
    { id: "v-settings", group: "Bereiche", title: "Bereich: Einstellungen", icon: "cog", run: () => openView("settings") },
  ], [newChat, newChatKind, previewOpen, togglePreview, openPreviewTabFromLab, darkTheme, toggleTheme, sidebarOpen, toggleSidebar, contextOpen, toggleContext]);

  const doLogout = async () => {
    await logout();
    onLogout();
  };

  const chatMenu = (chat: Chat) => (
    <Menu>
      <MenuItem icon="edit" text="Umbenennen" onClick={() => { setRenaming(chat); setRenameText(chat.title); }} />
      <MenuItem icon={pinnedSet.has(chat.id) ? "unpin" : "pin"}
        text={pinnedSet.has(chat.id) ? "Nicht mehr anheften" : "Anheften"}
        onClick={() => togglePin(chat)} />
      <MenuItem icon="eraser" text="Chat leeren (Verlauf behalten)" onClick={() => { void clear(chat); }} />
      <MenuItem
        icon={chat.kind === "orchestrator" ? "chat" : "flow-branch"}
        text={chat.kind === "orchestrator" ? "Zu Chat Classic wechseln" : "Zu Chat Orchestrator wechseln"}
        onClick={() => { void switchKind(chat); }}
      />
      <MenuDivider />
      <MenuItem icon="trash" intent="danger" text="Löschen" onClick={() => setDeleting(chat)} />
    </Menu>
  );

  const openChatMenu = (event: ReactMouseEvent, chat: Chat) => {
    event.preventDefault();
    showContextMenu({
      content: chatMenu(chat),
      targetOffset: { left: event.clientX, top: event.clientY },
    });
  };

  const chatRow = (chat: Chat) => (
    <div className={`lab-chat-row ${chat.id === currentId ? "is-current" : ""} ${chat.kind === "orchestrator" ? "is-orchestrator" : ""}`} key={chat.id}>
      <button type="button" className="lab-chat-main"
        onClick={() => selectChat(chat.id, chat)}
        onContextMenu={(event) => openChatMenu(event, chat)}>
        <span className="lab-chat-title">
          {pinnedSet.has(chat.id) && <Icon icon="pin" size={10} className="lab-chat-pin" aria-hidden="true" />}
          {chat.kind === "orchestrator" && (
            <span className="lab-chat-kind" title="Orchestrator-Chat (durchgängig, 200k Kontext, Subagenten)">
              <Icon icon="flow-branch" size={11} aria-hidden="true" /> Orchestrator
            </span>
          )}
          {chat.agent_name && (
            <span className="lab-chat-agent-dot" style={{ background: chat.agent_color || "var(--lab-accent)" }}
              title={`Agent: ${chat.agent_name}`} aria-hidden="true" />
          )}
          {chat.title || "Neuer Chat"}
        </span>
        <span className="lab-chat-preview">
          {chat.agent_name ? `${chat.agent_name} · ` : ""}
          {plainPreview(chat.last_message) || "noch keine Nachricht"}
        </span>
      </button>
      <Popover minimal position="bottom" content={chatMenu(chat)}>
        <Button className="lab-chat-more" minimal small icon="more"
          aria-label={`Menü für ${chat.title || "Chat"}`} />
      </Popover>
    </div>
  );

  const content = (() => {
    if (view === "chat" && current) {
      return (
        <ChatPane key={current.id} user={user} chat={current} providers={providers}
          contextOpen={contextOpen} refreshToken={refreshToken}
          previewOpen={previewOpen} previewRequest={previewRequest}
          autoPrompt={autoPrompt}
          onAutoPromptConsumed={() => setAutoPrompt(null)}
          onPreviewOpenChange={handlePreviewOpenChange}
          onArtifactCountChange={setArtifactCount}
          onChatUpdated={updateOne}
          onChatsChanged={() => { refreshChats(); refreshProposalsBadge(); refreshArtifactBadge(); }}
          onToggleContext={toggleContext}
          onOpenChanges={() => setView("changes")}
          onOpenGraph={() => setView("graph")} />
      );
    }
    if (view === "graph") {
      return <KnowledgeGraph onAnalyzeNode={analyzeGraphNodeInChat} />;
    }
    if (view === "agents") {
      return <Agents onLaunchChat={launchAgentChat} />;
    }
    if (view === "routines") {
      return (
        <Routines
          onLaunchChat={launchRoutineChat}
          onOpenChat={(id) => selectChat(id)}
        />
      );
    }
    if (view === "artifacts") {
      return (
        <Artifacts
          currentChatId={currentId}
          onOpenChat={(id) => selectChat(id)}
          onOpenInSidePreview={openArtifactInSidePreview}
          onCountChange={setTotalArtifacts}
        />
      );
    }
    if (view === "chat") {
      return (
        <div className="lab-page">
          <div className="empty-chat standalone">
            <BotSmiley size={48} variant="hero" trackMouse title="Klick mich!" />
            <strong>Noch kein Chat</strong>
            <p>Legen Sie einen Chat an und fragen Sie nach Aufträgen, Fertigung, Lager oder Stammdaten.</p>
            <Button intent="primary" icon="add" text="Neuen Chat anlegen" onClick={() => newChat(false, newChatKind)} loading={busy} />
          </div>
        </div>
      );
    }
    if (view === "proposals") {
      return <Proposals onChanged={refreshChats} onOpenChanges={() => setView("changes")} />;
    }
    if (view === "changes") return <Changes chatId={currentId} onChanged={refreshChats} />;
    if (view === "stats") {
      return <Stats onOpenChat={(id) => selectChat(id)} />;
    }
    if (view === "tools") {
      return <Tools chatId={currentId} writeMode={current?.write_mode ?? false} onChanged={refreshChats} />;
    }
    return (
      <>
        <AgentSettings onChanged={refreshProviders} />
        <Providers user={user} providers={providers} presets={presets} onRefresh={refreshProviders} />
        {!admin && providers.length === 0 && (
          <div className="lab-page"><div className="empty">Ein Admin muss einen Anbieter einrichten.</div></div>
        )}
      </>
    );
  })();

  return (
    <div className={`lab-shell ${sidebarOpen ? "" : "is-sidebar-collapsed"}`}>
      {sidebarOpen && (
        <div className="lab-side-backdrop" onClick={toggleSidebar} aria-hidden="true" />
      )}
      {sidebarOpen && (
        <aside className="lab-sidebar">
          <div className="lab-side-top">
            <a className="lab-brand" href="#chat" onClick={(e) => { e.preventDefault(); setView("chat"); }}>
              <BotSmiley size={31} variant="brand" trackMouse />
              <span className="lab-brand-text">
                <strong>Agent Lab</strong>
                <span>Gimel</span>
              </span>
            </a>
            <Button className="lab-icon-button" minimal icon="menu" aria-label="Seitenleiste ausblenden"
              onClick={toggleSidebar} />
          </div>

          <div className="lab-chat-kind-toggle" role="group" aria-label="Chat-Art wählen">
            <button type="button" className={newChatKind === "classic" ? "is-active" : ""}
              aria-pressed={newChatKind === "classic"}
              onClick={() => setNewChatKind("classic")}>Chat Classic</button>
            <button type="button" className={`orchestrator ${newChatKind === "orchestrator" ? "is-active" : ""}`}
              aria-pressed={newChatKind === "orchestrator"}
              onClick={() => setNewChatKind("orchestrator")}>Chat Orchestrator</button>
          </div>
          <Button className={`lab-new-chat ${newChatKind === "orchestrator" ? "is-orchestrator-button" : ""}`}
            fill intent="primary" icon={newChatKind === "orchestrator" ? "flow-branch" : "plus"}
            text={newChatKind === "orchestrator" ? "Neuer Chat (Orchestrator)" : "Neuer Chat (klassisch)"}
            onClick={() => newChat(false, newChatKind)} loading={busy} />

          <div className="lab-search">
            <InputGroup
              inputRef={searchRef}
              leftIcon="search"
              rightElement={search ? (
                <Button minimal small icon="cross" aria-label="Suche leeren" onClick={() => setSearch("")} />
              ) : undefined}
              placeholder="Chats durchsuchen"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Chats durchsuchen"
            />
            {!search && <kbd className="lab-search-hint" aria-hidden="true">Strg K</kbd>}
          </div>

          <div className="lab-chat-scroll">
            {pinnedChats.length > 0 && (
              <section className="lab-chat-section">
                <div className="lab-section-title"><span>Angeheftet</span><Tag minimal>{pinnedChats.length}</Tag></div>
                {pinnedChats.map(chatRow)}
              </section>
            )}
            {groups.map((group) => (
              <section className="lab-chat-section" key={group.label}>
                <div className="lab-section-title"><span>{group.label}</span><Tag minimal>{group.chats.length}</Tag></div>
                {group.chats.map(chatRow)}
              </section>
            ))}
            {!loading && filtered.length === 0 && (
              <div className="lab-chat-empty">
                {search ? "Kein Chat passt zur Suche." : "Noch kein Chat. „Neuer Chat“ legt den ersten an."}
              </div>
            )}
          </div>

          <div className="lab-side-foot">
            <SidebarUpdateButton isAdmin={user.role === "admin" || user.adminWork === true} />
            <Popover
              minimal
              position="top"
              content={
                <Menu>
                  {(user.role === "admin" || user.adminWork) && (
                    <MenuItem icon="people" text="Konten verwalten" href="/app/#/benutzer" />
                  )}
                  <MenuItem icon="tint" text="Design wechseln" onClick={toggleTheme} />
                  <MenuItem icon="chat" text="Assistent-Popup" onClick={openDrawer} />
                  <MenuItem icon="cog" text="Einstellungen" onClick={() => setView("settings")} />
                  <MenuDivider />
                  <MenuItem icon="log-out" text="Abmelden" onClick={doLogout} />
                </Menu>
              }
            >
              <button type="button" className="lab-user-button" aria-label="Kontomenü">
                <span className="lab-user-avatar" aria-hidden="true"><Icon icon="user" size={14} /></span>
                <span className="lab-user-main">
                  <strong>{user.name || user.email}</strong>
                  <span>{user.role}{user.adminWork ? " · Betrieb" : ""}</span>
                </span>
                <Icon icon="more" size={14} aria-hidden="true" />
              </button>
            </Popover>
            <nav className="lab-app-switcher" aria-label="Anwendungsbereich">
              <a className="lab-app-link" href="/app/">
                <Icon icon="applications" size={12} aria-hidden="true" /> ERP
              </a>
              <a className="lab-app-link" href="/studio/">
                <Icon icon="cube" size={12} aria-hidden="true" /> Twin
              </a>
              <a className="lab-app-link is-active" href="/lab/" aria-current="page" onClick={(e) => e.preventDefault()}>
                <Icon icon="chat" size={12} aria-hidden="true" /> Lab
              </a>
            </nav>
            <button
              type="button"
              className="bp5-button bp5-minimal bp5-small"
              style={{ width: "100%", justifyContent: "space-between", fontSize: 11, opacity: 0.78, marginTop: 4 }}
              onClick={() => openView("settings")}
              title="Gimel Einstellungen & System-Info öffnen"
            >
              <span className="mono">{gimelVersion ? `v${gimelVersion}` : "Gimel"} · Einstellungen & Info</span>
              <Icon icon="info-sign" size={12} aria-hidden="true" />
            </button>
          </div>
        </aside>
      )}

      <main className="lab-main">
        <div className="lab-top">
          {!sidebarOpen && (
            <Button minimal icon="menu" className="lab-icon-button" aria-label="Seitenleiste einblenden"
              onClick={toggleSidebar} />
          )}
          <div className="lab-top-title">
            <h1>{view === "chat" ? (current?.title || "Chat") : VIEW_LABEL[view]}</h1>
            {view === "chat" && current && (
              <div className="lab-top-sub">
                {current.kind === "orchestrator" && (
                  <>
                    <Tag minimal intent="primary" icon="flow-branch">Orchestrator</Tag>
                    <span className="lab-dot" />
                  </>
                )}
                {current.agent_name && (
                  <>
                    <span
                      className="lab-agent-pill"
                      style={current.agent_color ? ({ ["--agent-color" as string]: current.agent_color }) : undefined}
                    >
                      <span className="lab-chat-agent-dot" style={{ background: current.agent_color || "var(--lab-accent)" }} />
                      {current.agent_name}
                    </span>
                    <span className="lab-dot" />
                  </>
                )}
                <span>{current.provider_name || "kein Anbieter"}</span>
                <span className="lab-dot" />
                <span>{current.model || "kein Modell"}</span>
                {current.write_mode && <Tag minimal intent="warning">Schreibmodus</Tag>}
              </div>
            )}
          </div>
          <span className="spacer" />
          <button type="button" className="lab-cmd-trigger" onClick={() => setPaletteOpen(true)}
            aria-label="Suchen & Befehle"
            title="Befehlspalette öffnen (Strg+K)">
            <Icon icon="search" size={12} aria-hidden="true" />
            <span>Suchen &amp; Befehle</span>
            <kbd>Strg K</kbd>
          </button>
          {view === "chat" && current && (
            <>
              <Button minimal icon="application" active={previewOpen}
                className="lab-preview-btn"
                text={artifactCount > 0 ? `Vorschau (${artifactCount})` : "Vorschau"}
                aria-label="Seiten-Vorschau ein- oder ausblenden"
                title="Seiten-Vorschau & Browser (Strg+Shift+P)"
                onClick={togglePreview} />
              <Button minimal icon="refresh" loading={refreshing} aria-label="Chat und Liste aktualisieren"
                title="Aktualisieren" onClick={refreshAll} />
              <Button minimal icon="drawer-right" active={contextOpen}
                aria-label="Kontext ein- oder ausblenden" title="Kontext (Strg+J)"
                onClick={toggleContext} />
              <Popover minimal position="bottom" content={chatMenu(current)}>
                <Button minimal icon="more" aria-label="Chat-Menü" />
              </Popover>
            </>
          )}
          <Button minimal icon={darkTheme ? "flash" : "moon"}
            aria-label={darkTheme ? "Helles Design" : "Dunkles Design"}
            title={darkTheme ? "Helles Design" : "Dunkles Design"}
            onClick={toggleTheme} />
          <Button minimal icon="chat" text="Popup" className="lab-popup-button" onClick={openDrawer} />
        </div>

        <div className="lab-tabs" role="tablist" aria-label="Bereiche">
          {(["chat", "graph", "agents", "routines", "artifacts", "proposals", "changes", "stats", "tools", "settings"] as View[]).map((key) => (
            <button key={key} type="button" role="tab" aria-selected={view === key}
              className={view === key ? "is-active" : ""} onClick={() => openView(key)}>
              <Icon icon={VIEW_ICON[key] as any} size={14} aria-hidden="true" />
              {VIEW_LABEL[key]}
              {key === "artifacts" && totalArtifacts > 0 && (
                <span className="lab-tab-badge is-accent">{totalArtifacts}</span>
              )}
              {key === "proposals" && pendingProposals > 0 && (
                <span className="lab-tab-badge">{pendingProposals}</span>
              )}
            </button>
          ))}
          <span className="lab-tabs-spacer" />
          {error && (
            <span className="lab-tabs-error" role="alert" title={error}>
              <Icon icon="warning-sign" size={12} aria-hidden="true" />
              {error}
            </span>
          )}
        </div>

        <div className="lab-content">
          {loading ? (
            <div className="lab-loading"><Spinner size={30} /><span>Agent Lab wird geladen</span></div>
          ) : (
            <ErrorBoundary key={`${view}-${currentId ?? "none"}`} label={VIEW_LABEL[view]}>
              {content}
            </ErrorBoundary>
          )}
        </div>
      </main>

      {drawer && (
        <>
          <div className="drawer-backdrop" onClick={() => setDrawer(false)} />
          <aside className="drawer" role="dialog" aria-label="Assistent">
            <div className="drawer-head">
              <span className="drawer-head-title"><BotSmiley size={22} variant="brand" /> Assistent</span>
              <select aria-label="Chat wählen" value={currentId ?? ""}
                onChange={(e) => setCurrentId(Number(e.target.value) || null)}>
                {chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}
              </select>
              <Button small minimal icon="add" aria-label="Neuer Chat" onClick={() => newChat(true)} />
              <Button small minimal icon="cross" aria-label="Schließen" onClick={() => setDrawer(false)} />
            </div>
            {current ? (
              <ChatPane compact user={user} chat={current} providers={providers}
                contextOpen={false}
                onChatUpdated={updateOne} onChatsChanged={refreshChats}
                onOpenFull={() => { setDrawer(false); setView("chat"); }}
                onOpenChanges={() => { setDrawer(false); setView("changes"); }} />
            ) : (
              <div className="lab-page"><div className="empty">Kein Chat ausgewählt.</div></div>
            )}
          </aside>
        </>
      )}

      <CommandPalette
        open={paletteOpen}
        chats={chats}
        commands={paletteCommands}
        onSelectChat={(id) => selectChat(id)}
        onClose={() => setPaletteOpen(false)}
      />

      <Dialog isOpen={!!deleting} onClose={() => setDeleting(null)} title="Chat löschen">
        <DialogBody>
          <p>„{deleting?.title}“ wird aus der Liste entfernt. Bereits ausgeführte Änderungen bleiben bestehen und im Protokoll auffindbar.</p>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setDeleting(null)} />
            <Button intent="danger" text="Löschen" onClick={remove} loading={busy} />
          </>
        } />
      </Dialog>

      <Dialog isOpen={!!renaming} onClose={() => setRenaming(null)} title="Chat umbenennen">
        <DialogBody>
          <FormGroup label="Titel">
            <InputGroup autoFocus value={renameText} onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") rename(); }} />
          </FormGroup>
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setRenaming(null)} />
            <Button intent="primary" text="Speichern" onClick={rename} loading={busy} />
          </>
        } />
      </Dialog>
    </div>
  );
}
