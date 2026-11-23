import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  FormGroup,
  HTMLSelect,
  HTMLTable,
  InputGroup,
  Spinner,
  Switch,
  Tag,
} from "@blueprintjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtDateTime, getUser } from "../api";
import NonIdealState from "../components/NonIdealState";
import { plural } from "../plural";
import { toastError, toastSuccess } from "../toast";
import { PageFrame, Toolbar } from "../ui";
import { useVersion } from "../useVersion";

/* Gimel Account Manager — bewusst reduziert auf lokale Zugänge mit Benutzername
   und Passwort (kein E-Mail-Zwang, keine Kundenkonditionen, kein 2FA-Ballast). */

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
}

const ROLES: Array<[Exclude<Role, "customer">, string]> = [
  ["admin", "Admin — volle Rechte & Konten"],
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

export default function Users() {
  const version = useVersion();
  const me = getUser();
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [failed, setFailed] = useState("");
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<"" | Role>("");

  const [createDlg, setCreateDlg] = useState<{ username: string; password: string; role: Exclude<Role, "customer">; show: boolean } | null>(null);
  const [editDlg, setEditDlg] = useState<{ orig: AccountRow; username: string; role: Exclude<Role, "customer">; active: boolean } | null>(null);
  const [pwDlg, setPwDlg] = useState<{ account: AccountRow; password: string; show: boolean } | null>(null);
  const [ownPwDlg, setOwnPwDlg] = useState<{ current: string; next: string; confirm: string; show: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AccountRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ limit: "500" });
    if (q.trim()) qs.set("q", q.trim());
    if (roleFilter) qs.set("role", roleFilter);
    try {
      setRows(await api<AccountRow[]>(`/api/accounts?${qs.toString()}`));
      setFailed("");
    } catch (e: any) {
      setFailed(e.message);
      toastError(e.message);
    }
  }, [q, roleFilter]);

  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    return [...rows].sort((a, b) => a.username.localeCompare(b.username, "de"));
  }, [rows]);

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
      toastSuccess(`Konto „${username}“ angelegt.`);
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
      toastSuccess(`Passwort für „${pwDlg.account.username}“ geändert — bestehende Sitzungen beendet.`);
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
    <PageFrame
      title="Gimel Konten"
      sub="Lokale Benutzerverwaltung — nur Benutzername und Passwort."
      actions={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {version?.localnetOnly !== false && (
            <Tag minimal icon="shield" intent="success">Nur lokales Netzwerk</Tag>
          )}
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
      <Toolbar meta={sorted && <span className="sub">{plural(sorted.length, "Konto", "Konten")}</span>}>
        <InputGroup
          leftIcon="search"
          placeholder="Benutzername suchen…"
          value={q}
          aria-label="Benutzername suchen"
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 240, maxWidth: "100%" }}
        />
        <HTMLSelect
          value={roleFilter}
          aria-label="Rolle filtern"
          onChange={(e) => setRoleFilter(e.currentTarget.value as "" | Role)}
        >
          <option value="">Alle Rollen</option>
          {ROLES.map(([v]) => <option key={v} value={v}>{ROLE_LABEL[v]}</option>)}
        </HTMLSelect>
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
              onClick={() => setCreateDlg({ username: "", password: "", role: "staff", show: true })}
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
                    placeholder="z. B. max oder schicht1"
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
    </PageFrame>
  );
}
