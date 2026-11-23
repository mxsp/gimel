const TOKEN_KEY = "agentlab-token";
const SHARED_TOKEN_KEY = "gimel-token";
const HINT_KEY = "gimel-had-session";

export interface SessionUser {
  email: string;
  name: string;
  role: string;
  adminWork?: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;
  context_length?: number;
}

export interface Provider {
  id: number;
  name: string;
  kind: string;
  protocol?: "openai" | "anthropic" | "gemini" | "ollama" | string;
  requires_key?: boolean;
  context_length?: number | null;
  base_url: string;
  models_url: string;
  default_model: string;
  enabled: boolean;
  is_default: boolean;
  has_key: boolean;
  key_source: "env" | "database" | "none";
  models: ModelInfo[];
  models_fetched_at: string | null;
  headers: Record<string, string>;
  created_at?: string;
  updated_at?: string;
}

export interface Chat {
  id: number;
  title: string;
  provider_id: number | null;
  provider_name: string;
  model: string;
  write_mode: boolean;
  kind?: string;
  chat_type?: string;
  chat_kind?: string;
  mode?: string;
  agent_id?: number | null;
  agent_key?: string;
  agent_name?: string;
  agent_role_title?: string;
  agent_icon?: string;
  agent_color?: string;
  agent_starters?: string[];
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  last_message: string;
}

export interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface Attachment {
  id: number;
  filename: string;
  content_type: string;
  size: number;
  pages: number;
  chars: number;
  created_at: string;
  meta?: Record<string, unknown>;
  truncated?: boolean;
  ocr?: boolean;
}

export interface Message {
  id: number;
  chat_id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: ToolCall[];
  tool_call_id: string;
  name: string;
  model?: string;
  usage: Record<string, unknown>;
  interrupted: boolean;
  created_at: string;
  attachments?: Attachment[];
}

export interface Change {
  id: number;
  chat_id: number | null;
  message_id: number | null;
  tool: string;
  action: string;
  entity: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reversible: boolean;
  status: "applied" | "reverted";
  summary: string;
  created_at: string;
  reverted_at: string | null;
  reverted_by: string;
}

export interface Artifact {
  id: number;
  chat_id: number;
  chat_title?: string;
  message_id: number | null;
  title: string;
  kind: "html" | "svg" | "markdown" | "csv" | "json" | "code" | "text" | string;
  filename: string;
  language: string;
  content: string;
  version: number;
  chars: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface Routine {
  id: number;
  name: string;
  description: string;
  category: string;
  icon: string;
  prompt: string;
  steps: string[];
  schedule: "manual" | "shift" | "daily" | "weekly" | string;
  schedule_time: string;
  write_mode: boolean;
  output_format: "chat" | "html_report" | "chart_dashboard" | "markdown" | string;
  shared: boolean;
  enabled: boolean;
  template_key: string;
  run_count: number;
  last_run_at: string | null;
  last_chat_id: number | null;
  own: boolean;
  editable: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface RoutineTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  schedule: string;
  schedule_time: string;
  output_format: string;
  write_mode: boolean;
  steps: string[];
  prompt: string;
}

export interface RoutineRun {
  id: number;
  routine_id: number | null;
  template_key: string;
  routine_name: string;
  chat_id: number | null;
  status: string;
  summary: string;
  started_at: string | null;
}

export interface AgentPersona {
  id: number;
  slug: string;
  name: string;
  role_title: string;
  description: string;
  category: string;
  icon: string;
  color: string;
  system_prompt: string;
  tool_categories: string[];
  preferred_model: string;
  temperature: string;
  default_write_mode: boolean;
  has_routines: boolean;
  orchestration: boolean;
  routine_ids: number[];
  template_keys: string[];
  starter_prompts: string[];
  shared: boolean;
  enabled: boolean;
  chat_count: number;
  own: boolean;
  editable: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface BuiltinAgent {
  key: string;
  name: string;
  role_title: string;
  description: string;
  category: string;
  icon: string;
  color: string;
  has_routines: boolean;
  orchestration: boolean;
  template_keys: string[];
  tool_categories: string[];
  default_write_mode: boolean;
  system_prompt: string;
  starter_prompts: string[];
}

export interface AttachmentPreview extends Attachment {
  text: string;
}

export interface WebPreviewResult {
  url: string;
  content_type: string;
  title: string;
  html: string;
  text: string;
  truncated: boolean;
}

export interface ChatDetail {
  chat: Chat;
  messages: Message[];
  attachments: Attachment[];
  changes: Change[];
  artifacts?: Artifact[];
}

export interface TokenTotals {
  rounds: number;
  chats: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  cost: number;
  list_cost: number;
  allowance: number;
  has_cost: boolean;
  has_list_cost: boolean;
  has_allowance: boolean;
}

export interface ModelStat extends TokenTotals {
  model: string;
  provider: string;
}

export interface DayStat extends TokenTotals {
  date: string;
}

export interface ChatStat extends TokenTotals {
  id: number;
  title: string;
  model: string;
  provider: string;
  deleted: boolean;
  last_at: string | null;
}

export interface AgentStats {
  days: number;
  since: string | null;
  until: string;
  currency: string;
  totals: TokenTotals;
  models: ModelStat[];
  series: DayStat[];
  chats: ChatStat[];
}

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  maxItems?: number;
}

export interface ToolInfo {
  name: string;
  description: string;
  category?: string;
  parameters?: JsonSchema;
  write: boolean;
  reversible: boolean;
  admin_only: boolean;
  network: boolean;
  sandbox?: boolean;
  available: boolean;
  roles: string[];
  allowed: boolean;
}

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingField {
  key: string;
  label: string;
  group: "assistant" | "web" | "files" | "voice" | "sandbox";
  kind: "bool" | "int" | "float" | "text" | "secret" | "select";
  default: string;
  help: string;
  min: number | null;
  max: number | null;
  step: number | null;
  options: SettingOption[];
  secret: boolean;
}

export interface AgentSettings {
  values: Record<string, string>;
  fields: SettingField[];
  has_web_key: boolean;
  web_key_source: "env" | "database" | "none";
  admin: boolean;
  web_enabled: boolean;
  sandbox_enabled?: boolean;
}

export interface SandboxFile {
  path: string;
  kind: "file" | "dir";
  size: number;
  updated_at: string | null;
}

export interface SandboxSession {
  active: boolean;
  sandbox_id: string;
  chat_id: number;
  chat_title?: string;
  managed_locally?: boolean;
  profile?: string;
  backend: "docker" | "bwrap" | string;
  image: string;
  container_name: string;
  container_id: string;
  network_enabled: boolean;
  memory_mb: number;
  cpus: number;
  workspace_mb?: number;
  tmpfs_mb?: number;
  pids_limit?: number;
  max_files?: number;
  allow_swap?: boolean;
  allow_exec_tmp?: boolean;
  gpu_enabled?: boolean;
  ttl_minutes: number;
  remaining_seconds: number;
  command_count: number;
  file_count: number;
  workspace_bytes: number;
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  status: string;
  files?: SandboxFile[];
}

export interface ChatSandboxState {
  enabled: boolean;
  active: boolean;
  chat_id: number;
  created?: boolean;
  staged_attachments?: string[];
  sandbox: SandboxSession | null;
}

export interface SandboxProfilePreset {
  label: string;
  summary: string;
  values: Record<string, string>;
}

export interface SandboxRuntimeStatus {
  enabled: boolean;
  profile?: string;
  configured_backend: string;
  effective_backend: string;
  available: boolean;
  default_image: string;
  memory_mb: number;
  cpus: number;
  timeout_s: number;
  ttl_min: number;
  workspace_mb?: number;
  tmpfs_mb?: number;
  pids_limit?: number;
  max_files?: number;
  output_kb?: number;
  max_concurrent: number;
  allow_swap?: boolean;
  allow_exec_tmp?: boolean;
  network_enabled: boolean;
  gpu_enabled?: boolean;
  host?: {
    cpus: number;
    memory_mb: number;
    gpu_available: boolean;
    gpu_name: string;
  };
  profiles?: Record<string, SandboxProfilePreset>;
  backends: {
    docker: { available: boolean; version: string; images: string[]; detail: string };
    bwrap: { available: boolean; version: string; detail: string };
  };
  active_count: number;
  sessions: SandboxSession[];
}

export interface SandboxTestResult {
  ok: boolean;
  backend: string;
  image: string;
  network_enabled: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Der Assistent läuft an zwei Stellen: als eigene Seite (/lab) und als Seitenleiste
 *  im Portal und im Twin Studio. Die Seitenleiste lebt in einer fremden Sitzung
 *  (anderer Token-Schlüssel, eigene Erneuerung); sie meldet sich hier mit ihrem
 *  Zugang an, statt dass der Chat-Code dupliziert wird. */
export interface AgentTransport {
  request<T>(path: string, options: RequestInit): Promise<T>;
  token(): string | null;
  /** Rohe Bytes (Sprachausgabe) mit demselben Zugang wie `request`. */
  blob?(path: string, options?: RequestInit): Promise<Blob>;
}

let transport: AgentTransport | null = null;

export function setAgentTransport(next: AgentTransport | null): void {
  transport = next;
}

function tokenExpMs(token: string | null): number {
  if (!token) return 0;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return 0;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64)) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function getToken(): string | null {
  if (transport) return transport.token();
  const own = localStorage.getItem(TOKEN_KEY);
  const shared = localStorage.getItem(SHARED_TOKEN_KEY);
  if (own && shared && own !== shared) {
    // Immer den frischeren Token zwischen /app und /lab bevorzugen.
    return tokenExpMs(shared) > tokenExpMs(own) ? shared : own;
  }
  return own || shared;
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  try {
    localStorage.setItem(SHARED_TOKEN_KEY, token);
    localStorage.setItem(HINT_KEY, "1");
  } catch { /* egal */ }
}

export function clearToken(clearShared = false): void {
  localStorage.removeItem(TOKEN_KEY);
  if (clearShared) {
    try {
      localStorage.removeItem(SHARED_TOKEN_KEY);
      localStorage.removeItem(HINT_KEY);
    } catch { /* egal */ }
  }
}

let refreshing: Promise<boolean> | null = null;

export async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const r = await fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" });
        if (!r.ok) return false;
        const data = await r.json();
        if (!data.access_token) return false;
        setToken(data.access_token);
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
  }
  return refreshing;
}

async function send<T>(path: string, options: RequestInit, retried = false): Promise<T> {
  if (transport) return transport.request<T>(path, options);
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(path, { ...options, headers });
  if (resp.status === 401 && !retried && path !== "/api/auth/refresh") {
    if (await refreshSession()) return send<T>(path, options, true);
    clearToken();
    window.dispatchEvent(new Event("agentlab-logout"));
  }
  if (!resp.ok) {
    let detail = `Fehler ${resp.status}`;
    try {
      const data = await resp.json();
      detail = data.detail ?? data.error ?? detail;
      if (Array.isArray(detail)) detail = detail.map((d) => d.msg ?? String(d)).join("; ");
    } catch { /* kein JSON */ }
    throw new ApiError(resp.status, String(detail));
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  return send<T>(path, options);
}

/** Rohe Bytes holen — etwa die MP3-Antwort der Sprachausgabe. */
async function sendBlob(path: string, options: RequestInit, retried = false): Promise<Blob> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(path, { ...options, headers });
  if (resp.status === 401 && !retried && path !== "/api/auth/refresh") {
    if (await refreshSession()) return sendBlob(path, options, true);
    clearToken();
    window.dispatchEvent(new Event("agentlab-logout"));
  }
  if (!resp.ok) {
    let detail = `Fehler ${resp.status}`;
    try {
      const data = await resp.json();
      detail = data.detail ?? data.error ?? detail;
    } catch { /* kein JSON */ }
    throw new ApiError(resp.status, String(detail));
  }
  return resp.blob();
}

export async function apiBlob(path: string, options: RequestInit = {}): Promise<Blob> {
  if (transport?.blob) return transport.blob(path, options);
  return sendBlob(path, options);
}

/** Neuronale Sprachausgabe des Servers (edge-tts). Fällt sie aus, spricht
 *  voice.ts mit der Stimme des Browsers weiter. */
export function synthesizeSpeech(text: string, voice = "", rate = 1): Promise<Blob> {
  return apiBlob("/api/agent/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rate === 1 ? { text, voice } : { text, voice, rate }),
  });
}

export async function login(email: string, password: string): Promise<{ user?: SessionUser; mfaToken?: string }> {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: email.trim(), password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.detail ?? "Anmeldung fehlgeschlagen.");
  if (data.mfa_required) return { mfaToken: data.mfa_token || "" };
  setToken(data.access_token);
  return {
    user: { email: data.email, name: data.name, role: data.role, adminWork: data.admin_work === true },
  };
}

export async function loginMfa(ticket: string, code: string): Promise<SessionUser> {
  const r = await fetch("/api/auth/2fa", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mfa_token: ticket, code }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.detail ?? "Code ungültig.");
  setToken(data.access_token);
  return { email: data.email, name: data.name, role: data.role, adminWork: data.admin_work === true };
}

export async function loginPin(pin: string): Promise<SessionUser> {
  const r = await fetch("/api/auth/pin", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.detail ?? "PIN falsch.");
  setToken(data.access_token);
  return { email: data.email, name: data.name, role: data.role, adminWork: data.admin_work === true };
}

export async function loginOptions(): Promise<{ test: boolean; gimel: boolean }> {
  const data = await api<{ test_pin_enabled?: boolean; gimel_pin_enabled?: boolean }>("/api/auth/login-options");
  return { test: data.test_pin_enabled === true, gimel: data.gimel_pin_enabled === true };
}

export async function logout(): Promise<void> {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* egal */ }
  clearToken(true);
}

// --------------------------------------------------------------------------
// Agent
// --------------------------------------------------------------------------
export const listProviders = () =>
  api<{ providers: Provider[]; presets: Record<string, Record<string, string>> }>("/api/agent/providers");

export const createProvider = (body: Record<string, unknown>) =>
  api<Provider>("/api/agent/providers", { method: "POST", body: JSON.stringify(body) });

export const updateProvider = (id: number, body: Record<string, unknown>) =>
  api<Provider>(`/api/agent/providers/${id}`, { method: "PUT", body: JSON.stringify(body) });

export const deleteProvider = (id: number) =>
  api(`/api/agent/providers/${id}`, { method: "DELETE" });

export const setDefaultProvider = (id: number) =>
  api(`/api/agent/providers/${id}/default`, { method: "POST" });

export const testProvider = (id: number) =>
  api<{ ok: boolean; models: number; sample: string[]; warning: string }>(
    `/api/agent/providers/${id}/test`, { method: "POST" },
  );

export const loadProviderModels = (id: number, refresh = false) =>
  api<{ models: ModelInfo[]; warning: string; default_model: string }>(
    `/api/agent/providers/${id}/models${refresh ? "/refresh" : ""}`,
    refresh ? { method: "POST" } : {},
  );

export const deleteProviderKey = (id: number) =>
  api(`/api/agent/providers/${id}/key`, { method: "DELETE" });

export const listChats = () => api<{ chats: Chat[] }>("/api/agent/chats");

export const getStats = (days = 30) =>
  api<AgentStats>(`/api/agent/stats?days=${encodeURIComponent(String(days))}`);

export const createChat = (body: Record<string, unknown> = {}) =>
  api<Chat>("/api/agent/chats", { method: "POST", body: JSON.stringify(body) });

export const getChat = (id: number) => api<ChatDetail>(`/api/agent/chats/${id}`);

export interface SubagentCapability {
  id: string;
  label: string;
  hint: string;
}

export interface ChatSubagent {
  subagent_id: number;
  persona_id: number | null;
  name: string;
  role_title: string;
  model: string;
  task: string;
  capabilities: string[];
  used_calls: number;
  status: string;
  result: string;
  disposed: boolean;
  created_at: string | null;
  last_used_at: string | null;
  disposed_at: string | null;
}

export interface KnowledgeNode {
  key: string;
  kind: string;
  kind_label: string;
  label: string;
  subtitle: string;
  status: string;
  attention?: "danger" | "warning" | "" | string;
  degree?: number;
  in_degree?: number;
  out_degree?: number;
  source: string;
  meta: Record<string, unknown>;
  updated_at: string | null;
}

export interface KnowledgeEdge {
  id: number;
  source: string;
  target: string;
  relation: string;
  weight: number;
  source_kind: string;
}

export interface KnowledgeHotspotIssue {
  key: string;
  kind: string;
  kind_label: string;
  label: string;
  subtitle: string;
  status: string;
  attention: string;
  degree: number;
}

export interface KnowledgeHotspotHub {
  key: string;
  kind: string;
  kind_label: string;
  label: string;
  degree: number;
}

export interface KnowledgeGraphData {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  stats: {
    total_nodes: number;
    total_edges: number;
    issue_count?: number;
    by_kind: Record<string, number>;
    by_relation?: Record<string, number>;
    kinds: Record<string, string>;
    hotspots?: {
      issues: KnowledgeHotspotIssue[];
      hubs: KnowledgeHotspotHub[];
    };
  };
  focus?: string | null;
  depth?: number | null;
  last_rebuilt_at: string;
  auto_sync_interval_s: number;
  auto_sync_running?: boolean;
}

export interface KnowledgePathResult {
  ok: boolean;
  found: boolean;
  hops: number | null;
  node_keys: string[];
  edge_ids: number[];
  edges?: Array<{ id: number; from: string; to: string; direction: string; relation: string }>;
  steps: Array<{ key: string; kind: string; kind_label?: string; label: string; status?: string }>;
}

export const listChatSubagents = (id: number) =>
  api<{ chat_id: number; subagents: ChatSubagent[]; capabilities_catalog: SubagentCapability[] }>(`/api/agent/chats/${id}/subagents`);

export const dispatchChatSubagent = (
  id: number,
  body: { name: string; task: string; role_title?: string; capabilities?: string[]; model?: string },
) => api<{ ok: boolean; subagent_id: number }>(`/api/agent/chats/${id}/subagents`, {
  method: "POST",
  body: JSON.stringify(body),
});

export const deleteChatSubagent = (chatId: number, subagentId: number) =>
  api<{ ok: boolean; subagent_id: number; deleted: boolean }>(`/api/agent/chats/${chatId}/subagents/${subagentId}`, {
    method: "DELETE",
  });

export const getKnowledgeGraph = (params: {
  kind?: string;
  kinds?: string[];
  q?: string;
  relation?: string;
  focus?: string;
  depth?: number;
  only_issues?: boolean;
  limit?: number;
} = {}) => {
  const qs = new URLSearchParams();
  if (params.kind) qs.set("kind", params.kind);
  if (params.kinds && params.kinds.length > 0) qs.set("kinds", params.kinds.join(","));
  if (params.q) qs.set("q", params.q);
  if (params.relation) qs.set("relation", params.relation);
  if (params.focus) qs.set("focus", params.focus);
  if (params.depth && params.focus) qs.set("depth", String(params.depth));
  if (params.only_issues) qs.set("only_issues", "true");
  if (params.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return api<KnowledgeGraphData>(`/api/agent/graph${suffix}`);
};

export const findKnowledgePath = (source: string, target: string, maxDepth = 6) => {
  const qs = new URLSearchParams({ source, target, max_depth: String(maxDepth) });
  return api<KnowledgePathResult>(`/api/agent/graph/path?${qs.toString()}`);
};

export const rebuildKnowledgeGraph = () =>
  api<{ summary: Record<string, unknown>; graph: KnowledgeGraphData }>("/api/agent/graph/rebuild", {
    method: "POST",
  });

export const addKnowledgeInsight = (body: {
  title: string;
  detail?: string;
  linked_keys?: string[];
  severity?: string;
}) => api<{ ok: boolean; key: string; label: string; linked: string[] }>("/api/agent/graph/insights", {
  method: "POST",
  body: JSON.stringify(body),
});

export const updateKnowledgeInsight = (
  nodeKey: string,
  body: { title?: string; detail?: string; linked_keys?: string[]; severity?: string },
) => api<{ ok: boolean; key: string; label: string; linked: string[] }>(
  `/api/agent/graph/insights/${encodeURIComponent(nodeKey)}`,
  { method: "PUT", body: JSON.stringify(body) },
);

export const addKnowledgeEdge = (body: {
  source_key: string;
  target_key: string;
  relation: string;
}) => api<{ ok: boolean; id: number; source: string; target: string; relation: string; created: boolean }>(
  "/api/agent/graph/edges",
  { method: "POST", body: JSON.stringify(body) },
);

export const deleteKnowledgeEdge = (edgeId: number) =>
  api<{ ok: boolean; deleted: boolean }>(`/api/agent/graph/edges/${edgeId}`, {
    method: "DELETE",
  });

export const deleteKnowledgeNode = (nodeKey: string) =>
  api<{ ok: boolean; deleted: boolean }>(`/api/agent/graph/nodes/${encodeURIComponent(nodeKey)}`, {
    method: "DELETE",
  });

export interface AgentConfig {
  configured: boolean;
  admin: boolean;
  web_enabled: boolean;
  max_steps: number;
  orchestrator_max_steps: number;
  subagent_max_steps: number;
}

export const getAgentConfig = () => api<AgentConfig>("/api/agent/config");

export const updateChat = (id: number, body: Record<string, unknown>) =>
  api<Chat>(`/api/agent/chats/${id}`, { method: "PATCH", body: JSON.stringify(body) });

export const deleteChat = (id: number) =>
  api(`/api/agent/chats/${id}`, { method: "DELETE" });

export const clearChat = (id: number) =>
  api<{ id: number; cleared: number; subagents_disposed: number }>(`/api/agent/chats/${id}/clear`, { method: "POST" });

export const cancelChat = (id: number) =>
  api<{ cancelled: boolean }>(`/api/agent/chats/${id}/cancel`, { method: "POST" });

export async function uploadAttachment(
  chatId: number, file: File, options: { password?: string; pages?: string } = {},
): Promise<Attachment> {
  const form = new FormData();
  form.append("file", file);
  if (options.password) form.append("password", options.password);
  if (options.pages) form.append("pages", options.pages);
  return api<Attachment>(`/api/agent/chats/${chatId}/attachments`, {
    method: "POST", body: form,
  });
}

export const deleteAttachment = (chatId: number, attachmentId: number) =>
  api(`/api/agent/chats/${chatId}/attachments/${attachmentId}`, { method: "DELETE" });

export const getAttachmentContent = (chatId: number, attachmentId: number) =>
  api<AttachmentPreview>(`/api/agent/chats/${chatId}/attachments/${attachmentId}/content`);

export const listArtifacts = (chatId: number) =>
  api<{ artifacts: Artifact[] }>(`/api/agent/chats/${chatId}/artifacts`);

export const createArtifact = (
  chatId: number,
  body: { title: string; kind: string; content: string; filename?: string; language?: string },
) => api<Artifact>(`/api/agent/chats/${chatId}/artifacts`, { method: "POST", body: JSON.stringify(body) });

export const updateArtifact = (
  chatId: number,
  artifactId: number,
  body: { title?: string; kind?: string; content?: string; filename?: string; language?: string },
) => api<Artifact>(`/api/agent/chats/${chatId}/artifacts/${artifactId}`, { method: "PUT", body: JSON.stringify(body) });

export const deleteArtifact = (chatId: number, artifactId: number) =>
  api<{ id: number; deleted: boolean }>(`/api/agent/chats/${chatId}/artifacts/${artifactId}`, { method: "DELETE" });

export const fetchWebPreview = (url: string) =>
  api<WebPreviewResult>(`/api/agent/preview/web?url=${encodeURIComponent(url)}`);

export const listAllArtifacts = (params: { kind?: string; q?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.kind && params.kind !== "all") qs.set("kind", params.kind);
  if (params.q) qs.set("q", params.q);
  const tail = qs.toString() ? `?${qs.toString()}` : "";
  return api<{ artifacts: Artifact[]; total: number }>(`/api/agent/artifacts${tail}`);
};

export const createStandaloneArtifact = (
  body: { title: string; kind: string; content: string; filename?: string; language?: string; chat_id?: number | null },
) => api<Artifact>("/api/agent/artifacts", { method: "POST", body: JSON.stringify(body) });

export const updateStandaloneArtifact = (
  artifactId: number,
  body: { title?: string; kind?: string; content?: string; filename?: string; language?: string },
) => api<Artifact>(`/api/agent/artifacts/${artifactId}`, { method: "PUT", body: JSON.stringify(body) });

export const deleteStandaloneArtifact = (artifactId: number) =>
  api<{ id: number; deleted: boolean }>(`/api/agent/artifacts/${artifactId}`, { method: "DELETE" });

export const listRoutines = () =>
  api<{ routines: Routine[]; templates: RoutineTemplate[]; runs: RoutineRun[]; can_share: boolean }>("/api/agent/routines");

export const createRoutine = (body: Record<string, unknown>) =>
  api<Routine>("/api/agent/routines", { method: "POST", body: JSON.stringify(body) });

export const updateRoutine = (id: number, body: Record<string, unknown>) =>
  api<Routine>(`/api/agent/routines/${id}`, { method: "PUT", body: JSON.stringify(body) });

export const deleteRoutine = (id: number) =>
  api<{ id: number; deleted: boolean }>(`/api/agent/routines/${id}`, { method: "DELETE" });

export const runRoutine = (id: number) =>
  api<{ chat: Chat; prompt: string; run: RoutineRun; routine: Routine }>(`/api/agent/routines/${id}/run`, {
    method: "POST",
  });

export const runRoutineTemplate = (key: string) =>
  api<{ chat: Chat; prompt: string; run: RoutineRun }>(
    `/api/agent/routines/templates/${encodeURIComponent(key)}/run`,
    { method: "POST" },
  );

export const listAgents = () =>
  api<{
    agents: AgentPersona[];
    builtin: BuiltinAgent[];
    tool_categories: string[];
    routines: Routine[];
    templates: RoutineTemplate[];
    can_share: boolean;
  }>("/api/agent/agents");

export const createAgent = (body: Record<string, unknown>) =>
  api<AgentPersona>("/api/agent/agents", { method: "POST", body: JSON.stringify(body) });

export const updateAgent = (id: number, body: Record<string, unknown>) =>
  api<AgentPersona>(`/api/agent/agents/${id}`, { method: "PUT", body: JSON.stringify(body) });

export const deleteAgent = (id: number) =>
  api<{ id: number; deleted: boolean }>(`/api/agent/agents/${id}`, { method: "DELETE" });

export const startCustomAgent = (
  id: number,
  body: { routine_id?: number; template_key?: string; initial_prompt?: string } = {},
) => api<{ chat: Chat; prompt: string }>(`/api/agent/agents/${id}/start`, {
  method: "POST", body: JSON.stringify(body),
});

export const startBuiltinAgent = (
  key: string,
  body: { routine_id?: number; template_key?: string; initial_prompt?: string } = {},
) => api<{ chat: Chat; prompt: string }>(`/api/agent/agents/builtin/${encodeURIComponent(key)}/start`, {
  method: "POST", body: JSON.stringify(body),
});

export const listChanges = (chatId?: number) =>
  api<{ changes: Change[] }>(`/api/agent/changes${chatId ? `?chat_id=${chatId}` : ""}`);

export const revertChange = (chatId: number, changeId: number) =>
  api<Change>(`/api/agent/chats/${chatId}/changes/${changeId}/revert`, { method: "POST" });

export const revertMessage = (chatId: number, messageId: number) =>
  api<{ reverted: number; changes: Change[] }>(
    `/api/agent/chats/${chatId}/messages/${messageId}/revert`, { method: "POST" },
  );

export const getAgentSettings = () => api<AgentSettings>("/api/agent/settings");

export const updateAgentSettings = (values: Record<string, string>) =>
  api<AgentSettings>("/api/agent/settings", {
    method: "PUT", body: JSON.stringify({ values }),
  });

export const resetAgentSettings = (keys: string[] = []) =>
  api<AgentSettings>("/api/agent/settings/reset", {
    method: "POST", body: JSON.stringify({ keys }),
  });

export const testWebSearch = (query: string) =>
  api<{ provider: string; query: string; results: WebSearchResult[] }>(
    "/api/agent/settings/websearch/test", {
      method: "POST", body: JSON.stringify({ query }),
    },
  );

export interface RewindResult {
  content: string;
  hidden: number;
  attachment_ids: number[];
  attachments: Attachment[];
  open_changes: number;
}

export const rewindChat = (chatId: number, messageId: number) =>
  api<RewindResult>(`/api/agent/chats/${chatId}/rewind`, {
    method: "POST", body: JSON.stringify({ message_id: messageId }),
  });

export interface SavedPrompt {
  id: number;
  title: string;
  text: string;
  shared: boolean;
  own: boolean;
  editable: boolean;
  updated_at: string;
}

export interface BuiltinPrompt {
  key: string;
  title: string;
  text: string;
}

export const listPrompts = () =>
  api<{ prompts: SavedPrompt[]; builtin: BuiltinPrompt[]; can_share: boolean }>("/api/agent/prompts");

export const createPrompt = (body: { title: string; text: string; shared?: boolean }) =>
  api<SavedPrompt>("/api/agent/prompts", { method: "POST", body: JSON.stringify(body) });

export const updatePrompt = (id: number, body: { title?: string; text?: string; shared?: boolean }) =>
  api<SavedPrompt>(`/api/agent/prompts/${id}`, { method: "PUT", body: JSON.stringify(body) });

export const deletePrompt = (id: number) =>
  api(`/api/agent/prompts/${id}`, { method: "DELETE" });

export const listTools = () =>
  api<{ tools: ToolInfo[]; web_enabled: boolean; sandbox_enabled?: boolean }>("/api/agent/tools");

export const getSandboxStatus = () =>
  api<SandboxRuntimeStatus>("/api/agent/sandbox/status");

export const testSandbox = () =>
  api<SandboxTestResult>("/api/agent/sandbox/test", { method: "POST" });

export const getChatSandbox = (chatId: number) =>
  api<ChatSandboxState>(`/api/agent/chats/${chatId}/sandbox`);

export const startChatSandbox = (
  chatId: number,
  body: { image?: string; stage_attachments?: boolean; recreate?: boolean } = {},
) =>
  api<ChatSandboxState>(`/api/agent/chats/${chatId}/sandbox`, {
    method: "POST", body: JSON.stringify(body),
  });

export const destroyChatSandbox = (chatId: number) =>
  api<{ destroyed: boolean; chat_id: number }>(`/api/agent/chats/${chatId}/sandbox`, {
    method: "DELETE",
  });

export const stopSandboxContainer = (containerName: string) =>
  api<{ destroyed: boolean; container_name?: string }>(
    `/api/agent/sandbox/containers/${encodeURIComponent(containerName)}`,
    { method: "DELETE" },
  );

export const readChatSandboxFile = (chatId: number, filePath: string) =>
  api<{ path: string; bytes: number; chars: number; truncated: boolean; content: string }>(
    `/api/agent/chats/${chatId}/sandbox/files/${encodeURI(filePath)}`,
  );

export const invokeTool = (chatId: number, name: string, args: Record<string, unknown>) =>
  api<Record<string, unknown>>(`/api/agent/chats/${chatId}/tools/${name}`, {
    method: "POST", body: JSON.stringify({ arguments: args }),
  });

export interface ActionProposal {
  id: number;
  chat_id: number | null;
  message_id: number | null;
  alert_id: number | null;
  kind: string;
  title: string;
  rationale: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  impact_summary: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "failed" | "expired";
  decided_by: string;
  decided_at: string | null;
  decision_note: string;
  change_id: number | null;
  result_summary: string;
  created_at: string | null;
}

export const listProposals = (status = "pending") =>
  api<{ proposals: ActionProposal[]; pending_count: number }>(
    `/api/agent/proposals?status=${encodeURIComponent(status)}`,
  );

export const approveProposal = (id: number, note = "") =>
  api<{ proposal: ActionProposal; result: Record<string, unknown> }>(
    `/api/agent/proposals/${id}/approve`,
    { method: "POST", body: JSON.stringify({ note }) },
  );

export const rejectProposal = (id: number, note = "") =>
  api<{ proposal: ActionProposal }>(
    `/api/agent/proposals/${id}/reject`,
    { method: "POST", body: JSON.stringify({ note }) },
  );

export type StreamEvent = {
  type: string;
  [key: string]: unknown;
};

export async function streamMessage(
  chatId: number,
  content: string,
  route: string,
  attachmentIds: number[],
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
  context?: unknown,
  handsFree = false,
  maxSteps?: number,
): Promise<void> {
  const token = getToken();
  const resp = await fetch(`/api/agent/chats/${chatId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      content, route, attachment_ids: attachmentIds,
      ...(context ? { context } : {}),
      ...(handsFree ? { hands_free: true } : {}),
      ...(maxSteps != null && maxSteps > 0 ? { max_steps: maxSteps } : {}),
    }),
    signal,
  });
  if (!resp.ok) {
    let detail = `Fehler ${resp.status}`;
    try { detail = (await resp.json()).detail ?? detail; } catch { /* kein JSON */ }
    throw new ApiError(resp.status, String(detail));
  }
  if (!resp.body) throw new ApiError(0, "Der Browser kann den Strom nicht lesen.");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      try {
        onEvent({ ...(JSON.parse(dataLines.join("\n")) as object), type: eventName });
      } catch {
        onEvent({ type: "error", detail: "Unlesbare Serverantwort." });
      }
    }
  }
}
