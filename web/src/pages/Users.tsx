import {
  Alert,
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogFooter,
  Drawer,
  FormGroup,
  HTMLSelect,
  HTMLTable,
  InputGroup,
  Spinner,
  Switch,
  Tab,
  Tabs,
  Tag,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtDateTime, getUser } from "../api";
import NonIdealState from "../components/NonIdealState";
import { plural } from "../plural";
import { toastError, toastSuccess } from "../toast";
import { KpiStrip, PageFrame, Toolbar } from "../ui";
import { useVersion } from "../useVersion";

/* Proper Gimel Admin Account Management — local username + password accounts,
   role control, active session inspection/revocation, lockout unlock, and
   per-account audit trail. */

type Role = "admin" | "staff" | "worker" | "customer";

interface AccountRow {
  id: number;
  username: string;
  role: Role;
  active: boolean;
  created_at: string;
  last_login: string | null;
  locked: boolean;
  failed_login_count: number;
  active_sessions: number;
}

interface AccountSummary {
  total: number;
  admins: number;
  staff: number;
  workers: number;
  customers: number;
  active: number;
  inactive: number;
  locked: number;
  active_sessions: number;
}

interface SessionRow {
  id: number;
  ip: string;
  user_agent: string;
  created_at: string;
  expires_at: string;
  current: boolean;
}

interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
}

const ROLES: Array<[Exclude<Role, "customer">, string]> = [
  ["admin", "Admin — volle Rechte, Konten & Updates"],
  ["staff", "Personal — Büro & Fertigung"],
  ["worker", "Werker — Fertigung & Versand"],
];

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  staff: "Personal",
  worker: "Werker",
  customer: "Kunde",
};

const ROLE_INTENT: Record<Role, "danger" | "primary" | "success" | "none"> = {
  admin: "danger",
  staff: "primary",
  worker: "success",
  customer: "none",
};

function generatePassword(): string {
  const words = ["Hobel", "Fraese", "Platte", "Ring", "Werkbank", "Zange", "Feder", "Schnitt", "Bohrer", "Laser"];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  const n = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);
  return `${pick()}-${pick()}-${n}`;
}

export function AccountManagerPanel() {
  const version = useVersion();
  const me = getUser();
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [failed, setFailed] = useState("");
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<"" | Role>("");
  const [showCustomers, setShowCustomers] = useState(false);

  const [createDlg, setCreateDlg] = useState<{ username: string; password: string; role: Exclude<Role, "customer">; show: boolean } | null>(null);
  const [editDlg, setEditDlg] = useState<{ orig: AccountRow; username: string; role: Exclude<Role, "customer">; active: boolean } | null>(null);
  const [pwDlg, setPwDlg] = useState<{ account: AccountRow; password: string; show: boolean } | null>(null);
  const [ownPwDlg, setOwnPwDlg] = useState<{ current: string; next: string; confirm: string; show: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AccountRow | null>(null);
  const [inspect, setInspect] = useState<{
    account: AccountRow;
    tab: "sessions" | "audit";
    sessions: SessionRow[] | null;
    audit: AuditRow[] | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ limit: "500" });
    if (q.trim()) qs.set("q", q.trim());
    if (roleFilter) qs.set("role", roleFilter);
    if (showCustomers) qs.set("include_customers", "true");
    try {
      const [list, sum] = await Promise.all([
        api<AccountRow[]>(`/api/accounts?${qs.toString()}`),
        api<AccountSummary>("/api/accounts/summary"),
      ]);
      setRows(list);
      setSummary(sum);
      setFailed("");
    } catch (e: any) {
      setFailed(e.message);
      toastError(e.message);
    }
  }, [q, roleFilter, showCustomers]);

  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const rank: Record<Role, number> = { admin: 0, staff: 1, worker: 2, customer: 3 };
    return [...rows].sort(
      (a, b) => (rank[a.role] - rank[b.role]) || a.username.localeCompare(b.username, "de"),
    );
  }, [rows]);

  const openInspector = async (account: AccountRow, tab: "sessions" | "audit" = "sessions") => {
    setInspect({ account, tab, sessions: null, audit: null });
    try {
      const [sessions, audit] = await Promise.all([
        api<SessionRow[]>(`/api/accounts/${account.id}/sessions`),
        api<AuditRow[]>(`/api/accounts/${account.id}/audit?limit=60`),
      ]);
      setInspect({ account, tab, sessions, audit });
    } catch (err: any) {
      toastError(err.message);
      setInspect(null);
    }
  };

  const logoutAll = async (account: AccountRow) => {
    setBusy(true);
    try {
      const res = await api<{ revoked: number }>(`/api/accounts/${account.id}/logout-all`, { method: "POST" });
      toastSuccess(`${account.username}: ${plural(res.revoked, "Sitzung", "Sitzungen")} beendet.`);
      await load();
      if (inspect && inspect.account.id === account.id) {
        await openInspector(account, inspect.tab);
      }
    } catch (err: any) {
      toastError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const createAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createDlg) return;
    const username = createDlg.username.trim();
    if (!username || !createDlg.password) {
      toastError("Benutzername und Passwort sind Pflicht.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          username,
          password: createDlg.password,
          role: createDlg.role,
        }),
      });
      toastSuccess(`Konto „${username}“ (${ROLE_LABEL[createDlg.role]}) angelegt.`);
      setCreateDlg(null);
      load();
    } catch (err: any) {
      toastError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editDlg) return;
    const changes: Record<string, unknown> = {};
    const nextUser = editDlg.username.trim().toLowerCase();
    if (nextUser && nextUser !== editDlg.orig.username) changes.username = nextUser;
    if (editDlg.role !== editDlg.orig.role) changes.role = editDlg.role;
    if (editDlg.active !== editDlg.orig.active) changes.active = editDlg.active;
    if (!Object.keys(changes).length) {
      setEditDlg(null);
      return;
    }
    setBusy(true);
    try {
      await api(`/api/accounts/${editDlg.orig.id}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      });
      toastSuccess(`Konto „${nextUser || editDlg.orig.username}“ gespeichert.`);
      setEditDlg(null);
      load();
    } catch (err: any) {
      toastError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwDlg) return;
    setBusy(true);
    try {
      await api(`/api/accounts/${pwDlg.account.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password: pwDlg.password }),
      });
      toastSuccess(`Passwort für „${pwDlg.account.username}“ gesetzt — bestehende Sitzungen beendet.`);
      setPwDlg(null);
      load();
    } catch (err: any) {
      toastError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveOwnPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ownPwDlg) return;
    if (ownPwDlg.next !== ownPwDlg.confirm) {
      toastError("Die neuen Passwörter stimmen nicht überein.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/accounts/me/password", {
        method: "POST",
        body: JSON.stringify({
          current_password: ownPwDlg.current,
          new_password: ownPwDlg.next,
        }),
      });
      toastSuccess("Eigenes Passwort geändert.");
      setOwnPwDlg(null);
    } catch (err: any) {
      toastError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const unlockAccount = async (a: AccountRow) => {
    try {
      await api(`/api/accounts/${a.id}/unlock`, { method: "POST" });
      toastSuccess(`Konto „${a.username}“ entsperrt.`);
      load();
    } catch (err: any) {
      toastError(err.message);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      const r = await api<{ action: string; detail: string }>(`/api/accounts/${target.id}`, { method: "DELETE" });
      toastSuccess(`${target.username}: ${r.detail}`);
      load();
    } catch (err: any) {
      toastError(err.message);
    }
  };

  return (
    <div>
      {summary && (
        <KpiStrip
          label="Kontenübersicht"
          items={[
            { id: "team", label: "Team-Konten", value: summary.total, primary: true, sub: `${summary.active} aktiv` },
            { id: "admins", label: "Admins", value: summary.admins, primary: true, sub: `${summary.staff} Personal · ${summary.workers} Werker` },
            { id: "sessions", label: "Aktive Sitzungen", value: summary.active_sessions, primary: true, sub: version?.localnetOnly !== false ? "Nur Localnet" : "Netzwerk" },
            { id: "locked", label: "Gesperrt", value: summary.locked, primary: true, tone: summary.locked > 0 ? "danger" : "none", sub: summary.inactive > 0 ? `${summary.inactive} stillgelegt` : "alle frei" },
          ]}
        />
      )}

      <Toolbar
        meta={sorted && <span className="sub">{plural(sorted.length, "Konto", "Konten")}</span>}
        end={
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Button
              icon="key"
              text="Eigenes Passwort"
              onClick={() => setOwnPwDlg({ current: "", next: "", confirm: "", show: false })}
            />
            <Button
              intent="primary"
              icon="new-person"
              text="Neues Konto"
              onClick={() => setCreateDlg({ username: "", password: "", role: "staff", show: true })}
            />
          </div>
        }
      >
        <InputGroup
          leftIcon="search"
          placeholder="Benutzername suchen…"
          value={q}
          aria-label="Benutzername suchen"
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 220, maxWidth: "100%" }}
        />
        <HTMLSelect
          value={roleFilter}
          aria-label="Rolle filtern"
          onChange={(e) => setRoleFilter(e.currentTarget.value as "" | Role)}
        >
          <option value="">Alle Team-Rollen</option>
          {ROLES.map(([v]) => <option key={v} value={v}>{ROLE_LABEL[v]}</option>)}
        </HTMLSelect>
        {(summary?.customers ?? 0) > 0 && (
          <Switch
            checked={showCustomers}
            label={`Kunden zeigen (${summary?.customers})`}
            style={{ margin: 0 }}
            onChange={(e) => setShowCustomers(e.currentTarget.checked)}
          />
        )}
      </Toolbar>

      {failed && !rows ? (
        <NonIdealState
          icon="error"
          title="Konten nicht geladen"
          description={failed}
          action={<Button icon="refresh" onClick={load}>Erneut versuchen</Button>}
        />
      ) : !sorted ? (
        <Spinner size={28} />
      ) : sorted.length === 0 ? (
        <NonIdealState
          icon="people"
          title="Keine Konten gefunden"
          description="Legen Sie ein Konto mit Benutzername und Passwort an."
          action={
            <Button
              intent="primary"
              icon="new-person"
              text="Neues Konto"
              onClick={() => setCreateDlg({ username: "", password: "", role: "admin", show: true })}
            />
          }
        />
      ) : (
        <div className="table-scroll">
          <HTMLTable className="data-table" striped compact>
            <thead>
              <tr>
                <th>Benutzername</th>
                <th>Rolle</th>
                <th>Status</th>
                <th>Sitzungen</th>
                <th>Zuletzt angemeldet</th>
                <th style={{ width: 1 }}><span className="sr-only">Aktionen</span></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => {
                const isSelf = me?.email?.toLowerCase() === a.username.toLowerCase();
                return (
                  <tr key={a.id} className={a.active ? undefined : "row-muted"}>
                    <td>
                      <span className="mono" style={{ fontWeight: 600 }}>{a.username}</span>
                      {isSelf && <Tag minimal style={{ marginLeft: 6 }}>Sie</Tag>}
                    </td>
                    <td>
                      <Tag minimal intent={ROLE_INTENT[a.role]}>{ROLE_LABEL[a.role]}</Tag>
                    </td>
                    <td>
                      {a.active
                        ? <Tag minimal intent="success">aktiv</Tag>
                        : <Tag minimal intent="warning">stillgelegt</Tag>}
                      {a.locked && <Tag minimal intent="danger" icon="lock" style={{ marginLeft: 4 }}>gesperrt</Tag>}
                    </td>
                    <td>
                      <Button
                        small
                        minimal
                        icon="desktop"
                        text={a.active_sessions > 0 ? String(a.active_sessions) : "0"}
                        title="Aktive Sitzungen und Verlauf anzeigen"
                        onClick={() => openInspector(a, "sessions")}
                      />
                    </td>
                    <td className="sub">{a.last_login ? fmtDateTime(a.last_login) : "nie"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <div style={{ display: "inline-flex", gap: 4 }}>
                        <Button
                          small
                          minimal
                          icon="key"
                          text="Passwort"
                          onClick={() => setPwDlg({ account: a, password: "", show: true })}
                        />
                        {a.role !== "customer" && (
                          <Button
                            small
                            minimal
                            icon="edit"
                            title="Benutzername, Rolle oder Status ändern"
                            aria-label={`Konto ${a.username} bearbeiten`}
                            onClick={() => setEditDlg({
                              orig: a,
                              username: a.username,
                              role: a.role as Exclude<Role, "customer">,
                              active: a.active,
                            })}
                          />
                        )}
                        <Button
                          small
                          minimal
                          icon="history"
                          title="Sitzungen & Verlauf"
                          aria-label={`Sitzungen und Verlauf für ${a.username}`}
                          onClick={() => openInspector(a, "audit")}
                        />
                        {a.locked && (
                          <Button
                            small
                            minimal
                            intent="warning"
                            icon="unlock"
                            title="Sperre aufheben"
                            aria-label={`Konto ${a.username} entsperren`}
                            onClick={() => unlockAccount(a)}
                          />
                        )}
                        <Button
                          small
                          minimal
                          intent="danger"
                          icon="trash"
                          title="Löschen oder stilllegen"
                          aria-label={`Konto ${a.username} löschen`}
                          onClick={() => setDeleteTarget(a)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </HTMLTable>
        </div>
      )}

      {/* Neues Konto */}
      <Dialog
        isOpen={!!createDlg}
        onClose={() => setCreateDlg(null)}
        title="Neues Konto anlegen"
        style={{ width: 420 }}
      >
        <form onSubmit={createAccount}>
          <DialogBody>
            {createDlg && (
              <>
                <FormGroup label="Benutzername" labelFor="acc-new-user" helperText="Buchstaben, Ziffern, . _ - +">
                  <InputGroup
                    id="acc-new-user"
                    autoFocus
                    placeholder="z. B. admin, max oder schicht1"
                    value={createDlg.username}
                    required
                    onChange={(e) => setCreateDlg({ ...createDlg, username: e.target.value })}
                  />
                </FormGroup>
                <FormGroup label="Passwort" labelFor="acc-new-pw" helperText="Mindestens 8 Zeichen.">
                  <InputGroup
                    id="acc-new-pw"
                    type={createDlg.show ? "text" : "password"}
                    value={createDlg.password}
                    required
                    onChange={(e) => setCreateDlg({ ...createDlg, password: e.target.value })}
                    rightElement={
                      <>
                        <Button
                          minimal
                          icon={createDlg.show ? "eye-off" : "eye-open"}
                          aria-label="Passwort anzeigen"
                          onClick={() => setCreateDlg({ ...createDlg, show: !createDlg.show })}
                        />
                        <Button
                          minimal
                          icon="refresh"
                          title="Passwort vorschlagen"
                          aria-label="Passwort vorschlagen"
                          onClick={() => setCreateDlg({ ...createDlg, password: generatePassword(), show: true })}
                        />
                      </>
                    }
                  />
                </FormGroup>
                <FormGroup label="Rolle" labelFor="acc-new-role">
                  <HTMLSelect
                    id="acc-new-role"
                    fill
                    value={createDlg.role}
                    onChange={(e) => setCreateDlg({ ...createDlg, role: e.currentTarget.value as Exclude<Role, "customer"> })}
                  >
                    {ROLES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </HTMLSelect>
                </FormGroup>
              </>
            )}
          </DialogBody>
          <DialogFooter
            actions={
              <>
                <Button text="Abbrechen" onClick={() => setCreateDlg(null)} />
                <Button intent="primary" type="submit" text="Konto anlegen" loading={busy} />
              </>
            }
          />
        </form>
      </Dialog>

      {/* Konto bearbeiten */}
      <Dialog
        isOpen={!!editDlg}
        onClose={() => setEditDlg(null)}
        title={editDlg ? `Konto „${editDlg.orig.username}“` : ""}
        style={{ width: 420 }}
      >
        <form onSubmit={saveEdit}>
          <DialogBody>
            {editDlg && (
              <>
                <FormGroup label="Benutzername" labelFor="acc-edit-user">
                  <InputGroup
                    id="acc-edit-user"
                    value={editDlg.username}
                    required
                    onChange={(e) => setEditDlg({ ...editDlg, username: e.target.value })}
                  />
                </FormGroup>
                <FormGroup label="Rolle" labelFor="acc-edit-role">
                  <HTMLSelect
                    id="acc-edit-role"
                    fill
                    value={editDlg.role}
                    onChange={(e) => setEditDlg({ ...editDlg, role: e.currentTarget.value as Exclude<Role, "customer"> })}
                  >
                    {ROLES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </HTMLSelect>
                </FormGroup>
                <Switch
                  checked={editDlg.active}
                  label="Konto aktiv (aus = Zugang sofort sperren)"
                  onChange={(e) => setEditDlg({ ...editDlg, active: e.currentTarget.checked })}
                />
              </>
            )}
          </DialogBody>
          <DialogFooter
            actions={
              <>
                <Button text="Abbrechen" onClick={() => setEditDlg(null)} />
                <Button intent="primary" type="submit" text="Speichern" loading={busy} />
              </>
            }
          />
        </form>
      </Dialog>

      {/* Passwort setzen */}
      <Dialog
        isOpen={!!pwDlg}
        onClose={() => setPwDlg(null)}
        title="Passwort setzen"
        style={{ width: 420 }}
      >
        <form onSubmit={savePassword}>
          <DialogBody>
            {pwDlg && (
              <>
                <p style={{ marginTop: 0 }}>
                  Neues Passwort für <b className="mono">{pwDlg.account.username}</b>. Offene Sitzungen werden beendet.
                </p>
                <FormGroup label="Neues Passwort" labelFor="acc-set-pw" helperText="Mindestens 8 Zeichen.">
                  <InputGroup
                    id="acc-set-pw"
                    type={pwDlg.show ? "text" : "password"}
                    autoFocus
                    required
                    value={pwDlg.password}
                    onChange={(e) => setPwDlg({ ...pwDlg, password: e.target.value })}
                    rightElement={
                      <>
                        <Button
                          minimal
                          icon={pwDlg.show ? "eye-off" : "eye-open"}
                          aria-label="Passwort anzeigen"
                          onClick={() => setPwDlg({ ...pwDlg, show: !pwDlg.show })}
                        />
                        <Button
                          minimal
                          icon="refresh"
                          title="Passwort vorschlagen"
                          aria-label="Passwort vorschlagen"
                          onClick={() => setPwDlg({ ...pwDlg, password: generatePassword(), show: true })}
                        />
                      </>
                    }
                  />
                </FormGroup>
              </>
            )}
          </DialogBody>
          <DialogFooter
            actions={
              <>
                <Button text="Abbrechen" onClick={() => setPwDlg(null)} />
                <Button intent="primary" type="submit" text="Passwort setzen" loading={busy} disabled={!pwDlg?.password} />
              </>
            }
          />
        </form>
      </Dialog>

      {/* Eigenes Passwort ändern */}
      <Dialog
        isOpen={!!ownPwDlg}
        onClose={() => setOwnPwDlg(null)}
        title="Eigenes Passwort ändern"
        style={{ width: 420 }}
      >
        <form onSubmit={saveOwnPassword}>
          <DialogBody>
            {ownPwDlg && (
              <>
                <FormGroup label="Aktuelles Passwort" labelFor="own-pw-current">
                  <InputGroup
                    id="own-pw-current"
                    type="password"
                    autoFocus
                    required
                    value={ownPwDlg.current}
                    onChange={(e) => setOwnPwDlg({ ...ownPwDlg, current: e.target.value })}
                  />
                </FormGroup>
                <FormGroup label="Neues Passwort" labelFor="own-pw-next" helperText="Mindestens 8 Zeichen.">
                  <InputGroup
                    id="own-pw-next"
                    type={ownPwDlg.show ? "text" : "password"}
                    required
                    value={ownPwDlg.next}
                    onChange={(e) => setOwnPwDlg({ ...ownPwDlg, next: e.target.value })}
                    rightElement={
                      <Button
                        minimal
                        icon={ownPwDlg.show ? "eye-off" : "eye-open"}
                        aria-label="Passwort anzeigen"
                        onClick={() => setOwnPwDlg({ ...ownPwDlg, show: !ownPwDlg.show })}
                      />
                    }
                  />
                </FormGroup>
                <FormGroup label="Neues Passwort wiederholen" labelFor="own-pw-confirm">
                  <InputGroup
                    id="own-pw-confirm"
                    type={ownPwDlg.show ? "text" : "password"}
                    required
                    value={ownPwDlg.confirm}
                    onChange={(e) => setOwnPwDlg({ ...ownPwDlg, confirm: e.target.value })}
                  />
                </FormGroup>
              </>
            )}
          </DialogBody>
          <DialogFooter
            actions={
              <>
                <Button text="Abbrechen" onClick={() => setOwnPwDlg(null)} />
                <Button intent="primary" type="submit" text="Passwort ändern" loading={busy} />
              </>
            }
          />
        </form>
      </Dialog>

      {/* Sitzungen & Verlauf Drawer */}
      <Drawer
        isOpen={!!inspect}
        onClose={() => setInspect(null)}
        size={560}
        title={inspect ? `Konto „${inspect.account.username}“` : ""}
      >
        {inspect && (
          <div style={{ padding: 16, overflow: "auto", height: "100%" }}>
            <Tabs
              id="account-inspect-tabs"
              selectedTabId={inspect.tab}
              onChange={(t) => setInspect({ ...inspect, tab: t as "sessions" | "audit" })}
            >
              <Tab
                id="sessions"
                title={`Sitzungen (${inspect.sessions?.length ?? "…"})`}
                panel={
                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <span className="sub">Aktive Geräte und Browser-Sitzungen</span>
                      <Button
                        small
                        intent="danger"
                        icon="log-out"
                        text="Alle Sitzungen beenden"
                        loading={busy}
                        disabled={!inspect.sessions?.length}
                        onClick={() => logoutAll(inspect.account)}
                      />
                    </div>
                    {!inspect.sessions ? (
                      <Spinner size={24} />
                    ) : inspect.sessions.length === 0 ? (
                      <Callout icon="info-sign">Keine aktiven Sitzungen.</Callout>
                    ) : (
                      <HTMLTable compact striped style={{ width: "100%" }}>
                        <thead>
                          <tr>
                            <th>IP / Gerät</th>
                            <th>Angemeldet</th>
                            <th>Gültig bis</th>
                          </tr>
                        </thead>
                        <tbody>
                          {inspect.sessions.map((s) => (
                            <tr key={s.id}>
                              <td>
                                <span className="mono">{s.ip || "lokal"}</span>
                                {s.current && <Tag minimal intent="success" style={{ marginLeft: 6 }}>dieses Gerät</Tag>}
                                <div className="sub" style={{ fontSize: 11, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {s.user_agent || "—"}
                                </div>
                              </td>
                              <td className="sub">{fmtDateTime(s.created_at)}</td>
                              <td className="sub">{fmtDateTime(s.expires_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </HTMLTable>
                    )}
                  </div>
                }
              />
              <Tab
                id="audit"
                title={`Verlauf (${inspect.audit?.length ?? "…"})`}
                panel={
                  <div style={{ marginTop: 12 }}>
                    {!inspect.audit ? (
                      <Spinner size={24} />
                    ) : inspect.audit.length === 0 ? (
                      <Callout icon="history">Noch keine Einträge im Sicherheitsprotokoll.</Callout>
                    ) : (
                      <HTMLTable compact striped style={{ width: "100%" }}>
                        <thead>
                          <tr>
                            <th>Zeit</th>
                            <th>Akteur</th>
                            <th>Aktion</th>
                          </tr>
                        </thead>
                        <tbody>
                          {inspect.audit.map((a) => (
                            <tr key={a.id}>
                              <td className="sub">{fmtDateTime(a.at)}</td>
                              <td className="mono">{a.actor}</td>
                              <td><Tag minimal>{a.action}</Tag></td>
                            </tr>
                          ))}
                        </tbody>
                      </HTMLTable>
                    )}
                  </div>
                }
              />
            </Tabs>
          </div>
        )}
      </Drawer>

      {/* Konto löschen / stilllegen */}
      <Alert
        isOpen={!!deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        cancelButtonText="Abbrechen"
        confirmButtonText="Löschen / Stilllegen"
        intent="danger"
        icon="trash"
      >
        {deleteTarget && (
          <p>
            Konto <b className="mono">{deleteTarget.username}</b> entfernen? Falls Aufträge an diesem Konto hängen,
            wird es stattdessen stillgelegt; alle Sitzungen enden sofort.
          </p>
        )}
      </Alert>
    </div>
  );
}

export default function Users() {
  const version = useVersion();
  return (
    <PageFrame
      title="Gimel Konten"
      sub="Admin-Kontenverwaltung — lokale Benutzer, Rollen, aktive Sitzungen und Sicherheitsverlauf."
      actions={
        version?.localnetOnly !== false ? (
          <Tag minimal icon="shield" intent="success">Nur lokales Netzwerk</Tag>
        ) : undefined
      }
    >
      <AccountManagerPanel />
    </PageFrame>
  );
}
