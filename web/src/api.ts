// API-Client — eine Stelle, die den Token trägt und 401 in eine Anmeldung
// übersetzt. Alle Seiten rufen hierüber an.

const TOKEN_KEY = "gimel-token";
const AGENTLAB_TOKEN_KEY = "agentlab-token";
const USER_KEY = "gimel-user";
/** Der Refresh-Cookie ist HttpOnly und nicht lesbar. Dieser Merker sagt nur: hier war schon
 *  jemand angemeldet — ohne ihn fragen wir nicht erst, um ein 401 in der Konsole zu ernten. */
const HINT_KEY = "gimel-had-session";

function isAuthEndpoint(path: string): boolean {
  return path.startsWith("/api/auth/login") || path.startsWith("/api/auth/pin")
    || path.startsWith("/api/auth/2fa") || path === "/api/auth/refresh";
}

export interface SessionUser {
  email: string;
  name: string;
  role: string;
  /** Darf Halle, Maschinenwerte, Betriebseinstellungen, Verkäuferdaten und Supportzeiträume pflegen
   *  (Admin oder PIN-Konto). Die Rolle bleibt, was sie ist; Benutzer bleiben beim Admin. */
  adminWork?: boolean;
}

/** Admin-Arbeit: Rolle admin oder das Flag der Sitzung. Das Backend prüft dasselbe (require_admin_work). */
export function canAdminWork(user: Pick<SessionUser, "role" | "adminWork"> | null | undefined): boolean {
  return user?.role === "admin" || user?.adminWork === true;
}

/** Werker arbeiten in der Halle: Aufträge, Fertigung, Versand. Büro-Aktionen
 *  (Geld, Kunden, Planung) blendet die Oberfläche für sie aus — das Backend
 *  verweigert sie ohnehin (require_staff). */
export function isWorker(): boolean {
  return getUser()?.role === "worker";
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: SessionUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  try {
    localStorage.setItem(HINT_KEY, "1");
    if (localStorage.getItem(AGENTLAB_TOKEN_KEY)) localStorage.setItem(AGENTLAB_TOKEN_KEY, token);
  } catch { /* egal */ }
}

/** Abmelden von Hand: der Cookie ist weg, also gibt es nichts mehr aufzufrischen. */
export function forgetSession(): void {
  try {
    localStorage.removeItem(HINT_KEY);
    localStorage.removeItem(AGENTLAB_TOKEN_KEY);
  } catch { /* egal */ }
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* Zugangstoken leben 30 Minuten, die Sitzung (Refresh-Cookie auf /api/auth) 30 Tage.
   Bis 2026-10 warf die erste 401 nach einer halben Stunde jeden aus dem Portal —
   mit allem, was gerade in einem Formular stand. Jetzt wird einmal still erneuert
   und die Anfrage wiederholt; erst wenn auch das scheitert, folgt die Anmeldung.
   Ein gemeinsames Versprechen, weil der Server den Refresh-Token rotiert: zwei
   gleichzeitige Erneuerungen würden sich gegenseitig entwerten. */
let refreshing: Promise<boolean> | null = null;

/** Prüft lokal das JWT-Ablaufdatum, damit abgelaufene Tokens vor dem ersten Request
 *  einmal still erneuert werden statt eine 401-Salve auszulösen. */
function isTokenExpiringSoon(token: string | null): boolean {
  if (!token) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64)) as { exp?: number };
    return typeof payload.exp === "number" && payload.exp * 1000 < Date.now() + 15_000;
  } catch {
    return false;
  }
}

async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const r = await fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" });
        if (!r.ok) return false;
        const data = await r.json();
        const user = getUser();
        if (!data.access_token || !user) return false;
        setSession(data.access_token, user);
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

/** Beim Laden ohne Zugangstoken: gibt es noch eine Sitzung (Refresh-Cookie)?
 *  So landet, wer sich am Gimel-Pförtner persönlich angemeldet hat, direkt im
 *  Portal statt ein zweites Mal vor einer Anmeldemaske. Kunden kommen nicht
 *  hinein — sie bedienen das Bestellportal. */
export async function resumeSession(): Promise<SessionUser | null> {
  try {
    if (localStorage.getItem(HINT_KEY) !== "1") return null;
    const r = await fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" });
    if (!r.ok) { forgetSession(); return null; }
    const data = await r.json();
    if (!data.access_token || !data.role || data.role === "customer") return null;
    const user = { email: data.email, name: data.name, role: data.role, adminWork: data.admin_work === true };
    setSession(data.access_token, user);
    return user;
  } catch {
    return null;
  }
}

const FIELD_LABELS: Record<string, string> = {
  email: "E-Mail", password: "Kennwort", name: "Name", company: "Firma", eur_m2: "Preis €/m²",
  eur_m2_thk: "Dickenpreise", sheets: "Plattenformate", thicknesses: "Dicken", discount_pct: "Rabatt",
  value: "Wert", reason: "Grund", title: "Titel", lead_days: "Lieferzeit", kerf: "Schnittspalt",
  web: "Randabstand", min_web: "Mindeststeg", grain: "Werkstoffrichtung", cat: "Gruppe", qty: "Menge",
};

/** Pydantic-Fehler auf Deutsch: „E-Mail: …“ statt „String should have at least 8 characters“. */
function germanValidation(d: any): string {
  const loc = Array.isArray(d?.loc) ? d.loc.filter((x: unknown) => x !== "body") : [];
  const field = loc.length ? String(loc[loc.length - 1]) : "";
  const label = FIELD_LABELS[field] ?? field;
  const ctx = d?.ctx ?? {};
  const msg = (() => {
    switch (d?.type) {
      case "missing": return "fehlt";
      case "string_too_short": return `mindestens ${ctx.min_length} Zeichen`;
      case "string_too_long": return `höchstens ${ctx.max_length} Zeichen`;
      case "too_long": return `höchstens ${ctx.max_length} Einträge`;
      case "greater_than": return `muss größer als ${ctx.gt} sein`;
      case "greater_than_equal": return `muss mindestens ${ctx.ge} sein`;
      case "less_than": return `muss kleiner als ${ctx.lt} sein`;
      case "less_than_equal": return `darf höchstens ${ctx.le} sein`;
      case "float_parsing": case "int_parsing": case "float_type": case "int_type": return "muss eine Zahl sein";
      case "string_pattern_mismatch": return "hat nicht das erwartete Format";
      case "enum": case "literal_error": return `muss einer der Werte ${ctx.expected ?? ""} sein`;
      case "value_error": return String(d.msg ?? "").replace(/^Value error, /, "");
      default: return String(d?.msg ?? "ungültig");
    }
  })();
  return label ? `${label}: ${msg}` : msg;
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (options.body && !(options.body instanceof FormData)
      && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  let token = getToken();
  if (token && path !== "/api/auth/refresh" && isTokenExpiringSoon(token)) {
    if (await refreshSession()) token = getToken();
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(path, { ...options, headers });
  if (resp.status === 401 && !isAuthEndpoint(path)) {
    if (!retried && await refreshSession()) {
      return api<T>(path, options, true);
    }
    clearSession();
    window.dispatchEvent(new Event("gimel-logout"));
    throw new ApiError(401, "Sitzung abgelaufen — bitte neu anmelden.");
  }
  if (!resp.ok) {
    let detail = `Fehler ${resp.status}`;
    try {
      const data = await resp.json();
      detail = data.detail ?? data.error ?? detail;
      if (Array.isArray(detail)) detail = detail.map(germanValidation).join("; ");
    } catch {
      /* Körper ohne JSON — der Statuscode spricht */
    }
    throw new ApiError(resp.status, String(detail));
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

/** Wie ``api()``, liest zusätzlich den Antwortkopf ``X-Total-Count`` für serverseitige Paginierung. */
export async function apiWithCount<T = unknown>(
  path: string,
  options: RequestInit = {},
  retried = false,
): Promise<{ data: T; total: number | null }> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (options.body && !(options.body instanceof FormData)
      && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  let token = getToken();
  if (token && path !== "/api/auth/refresh" && isTokenExpiringSoon(token)) {
    if (await refreshSession()) token = getToken();
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(path, { ...options, headers });
  if (resp.status === 401 && !isAuthEndpoint(path)) {
    if (!retried && await refreshSession()) {
      return apiWithCount<T>(path, options, true);
    }
    clearSession();
    window.dispatchEvent(new Event("gimel-logout"));
    throw new ApiError(401, "Sitzung abgelaufen — bitte neu anmelden.");
  }
  if (!resp.ok) {
    let detail = `Fehler ${resp.status}`;
    try {
      const data = await resp.json();
      detail = data.detail ?? data.error ?? detail;
      if (Array.isArray(detail)) detail = detail.map(germanValidation).join("; ");
    } catch {
      /* Körper ohne JSON */
    }
    throw new ApiError(resp.status, String(detail));
  }
  const rawTotal = resp.headers.get("X-Total-Count");
  const parsed = rawTotal !== null && /^\d+$/.test(rawTotal) ? Number(rawTotal) : null;
  const data = resp.status === 204 ? (undefined as T) : ((await resp.json()) as T);
  return { data, total: parsed };
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Ein Bild (oder sonst ein Blob) mit dem Zugangstoken holen, etwa das Testbild der Teileerkennung. */
export async function apiBlob(
  path: string,
  options: RequestInit = {},
  retried = false,
): Promise<Blob> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  let token = getToken();
  if (token && path !== "/api/auth/refresh" && isTokenExpiringSoon(token)) {
    if (await refreshSession()) token = getToken();
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(path, { ...options, headers });
  if (resp.status === 401 && !isAuthEndpoint(path)) {
    if (!retried && await refreshSession()) {
      return apiBlob(path, options, true);
    }
    clearSession();
    window.dispatchEvent(new Event("gimel-logout"));
    throw new ApiError(401, "Sitzung abgelaufen — bitte neu anmelden.");
  }
  if (!resp.ok) {
    let detail = `Fehler ${resp.status}`;
    try { detail = (await resp.json()).detail ?? detail; } catch { /* kein JSON */ }
    throw new ApiError(resp.status, String(detail));
  }
  return resp.blob();
}

/** Datei vom Backend holen und im Browser speichern.

    Ein blankes <a href="/api/…"> trägt keinen Authorization-Kopf, und alle
    Zeichnungs- und Schnittdatei-Endpunkte verlangen einen: der Link lieferte
    bisher wortlos eine 401 statt einer Datei. Deshalb holen wir sie selbst und
    reichen sie als Blob an einen kurzlebigen Link weiter. */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const token = getToken();
  const resp = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!resp.ok) {
    let detail = `Fehler ${resp.status}`;
    try { detail = (await resp.json()).detail ?? detail; } catch { /* kein JSON */ }
    throw new ApiError(resp.status, String(detail));
  }
  // Wenn der Server einen Namen mitschickt, gilt seiner: er kennt die
  // Rechnungsnummer, der Aufrufer kennt nur die Auftragsnummer. Sonst hiesse
  // dieselbe Datei je nach Knopf anders.
  const disposition = resp.headers.get("content-disposition") || "";
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const url = URL.createObjectURL(await resp.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = named ? decodeURIComponent(named[1]) : filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Erst nach dem Klick freigeben, sonst bricht der Download im Firefox ab.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Eine geschützte HTML-Seite (Laufkarte) in einem neuen Fenster zeigen. */
export async function apiOpenHtml(path: string): Promise<void> {
  const token = getToken();
  const resp = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!resp.ok) throw new ApiError(resp.status, `Seite nicht abrufbar (${resp.status}).`);
  const win = window.open("", "_blank");
  if (!win) throw new ApiError(0, "Das Fenster wurde vom Browser blockiert.");
  win.document.write(await resp.text());
  win.document.close();
}

export async function apiUpload<T = unknown>(
  path: string,
  file: File,
  fields: Record<string, string> = {},
): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return api<T>(path, { method: "POST", body: form });
}

// ---------- Formatierung (deutsch, tabellarisch) --------------------------
export const fmtEur = (v: number | undefined | null) =>
  (v ?? 0).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

/** Der Server liefert Zeitstempel ohne Zeitzone als UTC; ohne „Z" läse der Browser sie als Ortszeit. */
export const asUtc = (iso: string) => (/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(iso) ? iso + "Z" : iso);

export const fmtDate = (iso: string | undefined | null) =>
  iso ? new Date(asUtc(iso)).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

export const fmtDateTime = (iso: string | undefined | null) =>
  iso ? new Date(asUtc(iso)).toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }) : "—";

/** Sammellauf im Hintergrund starten und warten, bis er fertig ist.
    Eine einzelne verlorene Abfrage beendet das Warten nicht: der Lauf geht auf
    dem Server weiter, also fragen wir nach (bis zu fünf Fehlversuche in Folge). */
export async function runBatch<T>(force: boolean, hooks: { onJob?: (id: string) => void } = {},
                                  buckets?: { mat: string; thk: number }[],
                                  options?: { customerIds?: number[]; groupBy?: "material" | "customer" }): Promise<T> {
  type Job = { id: string; status: string; run: T | null; error: string };
  const payload: Record<string, unknown> = {};
  if (buckets?.length) payload.buckets = buckets;
  if (options?.customerIds?.length) payload.customer_ids = options.customerIds;
  if (options?.groupBy) payload.group_by = options.groupBy;
  const body = Object.keys(payload).length ? { body: JSON.stringify(payload) } : {};
  let job = await api<Job>(`/api/production/runs/start?force=${force}`,
                           { method: "POST", ...body });
  hooks.onJob?.(job.id);
  let misses = 0;
  while (job.status === "running") {
    await new Promise((done) => setTimeout(done, 1500));
    try {
      job = await api<Job>(`/api/production/runs/jobs/${job.id}`);
      misses = 0;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 401 || e.status === 403)) throw e;
      if (++misses >= 5) throw e;
    }
  }
  if (job.status !== "done" || job.run === null) throw new Error(job.error || "Sammellauf fehlgeschlagen");
  return job.run;
}

export const fmtM2 = (v: number | undefined | null) =>
  `${(v ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 2 })} m²`;

/** Der Server liefert Ersparnis als Prozentpunkte (21,49), Belegung als Anteil (0,71). */
export const fmtPoints = (v: number | undefined | null) =>
  `${(v ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;
