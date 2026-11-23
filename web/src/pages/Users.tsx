import { Alert, Button, Callout, Dialog, DialogBody, DialogFooter, Drawer, HTMLSelect, HTMLTable, InputGroup, Menu, MenuDivider, MenuItem, NumericInput, Spinner, Switch, Tag } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import NonIdealState from "../components/NonIdealState";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtDateTime } from "../api";
import { toastError, toastSuccess } from "../toast";
import { PAYMENT_TERMS, PRICE_GROUPS, withCurrent, priceGroupLabel } from "../constants";
import { plural } from "../plural";
import { FilterGroup, FilterPopover, FilterTag, HintDetails, PageFrame, Toolbar } from "../ui";

/* Benutzerverwaltung — übernommen aus der alten Admin-Subapp.

   Konten mit Aufträgen werden stillgelegt, nicht gelöscht: an ihnen hängen
   Aufträge und Zeugnisse, die auch in zwei Jahren noch auflösbar sein müssen.
   Konten ohne Aufträge löscht das Backend wirklich; die Meldung sagt, was
   geschehen ist. Gespeichert wird nur, was sich geändert hat — ein bloßer
   Namenswechsel beendet keine Sitzung mehr. */

type Role = "admin" | "staff" | "worker" | "customer";

interface UserRow {
  id: number; email: string; name: string; company: string; role: Role;
  active: boolean; price_group: string; discount_pct: number;
  payment_terms: string; customer_no: string;
  created_at: string; last_login: string | null;
  totp_enabled: boolean; locked_until: string | null; mfa_locked_until: string | null;
  failed_login_count: number;
}

interface AuditRow { id: number; at: string; actor: string; action: string; detail: Record<string, unknown> }

const ROLES: Array<[Role, string]> = [
  ["admin", "Admin — alles"],
  ["staff", "Personal — Werkstatt und Büro"],
  ["worker", "Werker — Aufträge, Fertigung, Versand"],
  ["customer", "Kunde — nur Bestellportal"],
];
const ROLE_LABEL: Record<Role, string> = { admin: "Admin", staff: "Personal", worker: "Werker", customer: "Kunde" };
const ROLE_INTENT: Record<Role, "danger" | "primary" | "success" | "none"> = {
  admin: "danger", staff: "primary", worker: "success", customer: "none",
};
const EDITABLE: Array<keyof UserRow> = ["name", "company", "role", "active", "price_group", "discount_pct", "payment_terms", "customer_no"];

const isLocked = (u: UserRow) => [u.locked_until, u.mfa_locked_until]
  .some((t) => t && new Date(t).getTime() > Date.now());

function generatePassword(): string {
  const words = ["Hobel", "Fraese", "Platte", "Dichtung", "Werkbank", "Zange", "Feder", "Ring", "Schnitt", "Bohrer"];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  const n = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);
  return `${pick()}-${pick()}-${pick()}-${n}`;
}

export default function Users() {
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [failed, setFailed] = useState("");
  const [q, setQ] = useState("");
  const [role, setRole] = useState<"" | Role>("");
  const [state, setState] = useState<"" | "true" | "false">("");
  const [sort, setSort] = useState<"email" | "name" | "last_login" | "created_at">("email");
  const [edit, setEdit] = useState<Partial<UserRow> & { password?: string } | null>(null);
  const [original, setOriginal] = useState<UserRow | null>(null);
  const [pw, setPw] = useState<{ user: UserRow; value: string; show: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "delete" | "mfa"; user: UserRow } | null>(null);
  const [history, setHistory] = useState<{ user: UserRow; rows: AuditRow[] | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ q, limit: "1000" });
    if (role) qs.set("role", role);
    if (state) qs.set("active", state);
    try {
      setRows(await api<UserRow[]>(`/api/users?${qs.toString()}`));
      setFailed("");
    } catch (e: any) { setFailed(e.message); toastError(e.message); }
  }, [q, role, state]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const val = (u: UserRow) => (sort === "name" ? (u.name || u.email) : (u[sort] ?? "")) as string;
    const desc = sort === "last_login" || sort === "created_at";
    return [...rows].sort((a, b) => (desc ? -1 : 1) * val(a).localeCompare(val(b), "de"));
  }, [rows, sort]);

  // Domain-Regeln erzwingt das Backend je nach Konfiguration (plugin.internal_email_domain).
  const domainProblem = (_email: string, _r: Role | undefined) => "";

  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      if (edit.id && original) {
        // Nur Geändertes schicken: sonst hält das Backend Rolle und Aktiv-Schalter
        // für eine Änderung, und das Protokoll füllt sich mit Gleichem.
        const changes: Record<string, unknown> = {};
        for (const k of EDITABLE) if (edit[k] !== undefined && edit[k] !== original[k]) changes[k] = edit[k];
        if (!Object.keys(changes).length) { toastSuccess("Keine Änderung."); setEdit(null); return; }
        const problem = domainProblem(original.email, changes.role as Role | undefined);
        if (problem) { toastError(problem); return; }
        if (changes.active === false && !window.confirm(`${original.email} stilllegen? Alle Sitzungen enden sofort.`)) return;
        await api(`/api/users/${edit.id}`, { method: "PATCH", body: JSON.stringify(changes) });
        toastSuccess(changes.role || changes.active === false
          ? "Konto geändert — die Sitzungen des Kontos wurden beendet." : "Konto geändert.");
      } else {
        const email = (edit.email ?? "").trim();
        if (!email || !edit.password) { toastError("E-Mail und Kennwort sind Pflicht."); return; }
        const problem = domainProblem(email, edit.role);
        if (problem) { toastError(problem); return; }
        await api("/api/users", { method: "POST", body: JSON.stringify({ ...edit, email }) });
        toastSuccess("Konto angelegt.");
      }
      setEdit(null); setOriginal(null); load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const setPassword = async () => {
    if (!pw) return;
    setBusy(true);
    try {
      await api(`/api/users/${pw.user.id}/password`, {
        method: "POST", body: JSON.stringify({ password: pw.value }),
      });
      toastSuccess(`Kennwort für ${pw.user.email} gesetzt — Sperren aufgehoben, Sitzungen beendet.`);
      setPw(null); load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const unlock = async (u: UserRow) => {
    try {
      await api(`/api/users/${u.id}/unlock`, { method: "POST" });
      toastSuccess(`${u.email} entsperrt.`); load();
    } catch (e: any) { toastError(e.message); }
  };

  const reactivate = async (u: UserRow) => {
    try {
      await api(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ active: true }) });
      toastSuccess(`${u.email} wieder aktiv.`); load();
    } catch (e: any) { toastError(e.message); }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const { kind, user } = confirm;
    setConfirm(null);
    try {
      if (kind === "mfa") {
        await api(`/api/users/${user.id}/mfa/reset`, { method: "POST" });
        toastSuccess(`Zweiter Faktor von ${user.email} zurückgesetzt — Anmeldung wieder nur mit Kennwort.`);
      } else {
        const r = await api<{ action: string; detail: string }>(`/api/users/${user.id}`, { method: "DELETE" });
        toastSuccess(`${user.email}: ${r.detail}`);
      }
      load();
    } catch (e: any) { toastError(e.message); }
  };

  const openHistory = async (u: UserRow) => {
    setHistory({ user: u, rows: null });
    try {
      const data = await api<AuditRow[]>(`/api/admin/audit?entity=user&entity_id=${u.id}&limit=200`);
      setHistory({ user: u, rows: data });
    } catch (e: any) { toastError(e.message); setHistory(null); }
  };

  const copyDetail = async (row: AuditRow) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(row.detail, null, 2));
      toastSuccess("Details kopiert.");
    } catch { toastError("Kopieren nicht möglich."); }
  };

  const newAccount = () => {
    setOriginal(null);
    setEdit({ role: "staff", price_group: PRICE_GROUPS[0][0], discount_pct: 0,
              payment_terms: PAYMENT_TERMS[2][0], active: true });
  };

  return (
    <PageFrame title="Benutzer" sub="Konten für Personal, Werker und Kunden — Rolle, Konditionen und Sicherheit."
               help={[{ title: "Konten und Rollen", text: <>
                   Konten mit Aufträgen werden <b>stillgelegt, nicht gelöscht</b>: an ihnen hängen Aufträge und Zeugnisse.
                   Konten ohne Aufträge werden gelöscht.
                   Werker sehen nur Aufträge, Fertigung, Versand und den Grundriss — keine Preise, Kunden oder Rechnungen;
                   ein Kundenkonto wird nie zum Werker.
                 </> }]}>
      <Toolbar meta={sorted && <span className="sub">{plural(sorted.length, "Konto", "Konten")}</span>}
               end={<Button intent="primary" icon="new-person" text="Konto anlegen" onClick={newAccount} />}>
        <InputGroup leftIcon="search" placeholder="Name, E-Mail, Firma, Kd-Nr.…" value={q} aria-label="Suchen"
                    onChange={(e) => setQ(e.target.value)} style={{ width: 260, maxWidth: "100%" }} />
        <HTMLSelect value={sort} onChange={(e) => setSort(e.currentTarget.value as typeof sort)} aria-label="Sortierung">
          <option value="email">nach E-Mail</option>
          <option value="name">nach Name</option>
          <option value="last_login">zuletzt angemeldet</option>
          <option value="created_at">zuletzt angelegt</option>
        </HTMLSelect>
        <FilterPopover active={(role ? 1 : 0) + (state ? 1 : 0)}
                       onClear={() => { setRole(""); setState(""); }}>
          <FilterGroup label="Rolle">
            <HTMLSelect value={role} onChange={(e) => setRole(e.currentTarget.value as "" | Role)} aria-label="Rolle">
              <option value="">Alle Rollen</option>
              {ROLES.map(([v]) => <option key={v} value={v}>{ROLE_LABEL[v]}</option>)}
            </HTMLSelect>
          </FilterGroup>
          <FilterGroup label="Status">
            <HTMLSelect value={state} onChange={(e) => setState(e.currentTarget.value as "" | "true" | "false")} aria-label="Status">
              <option value="">Aktive und stillgelegte</option>
              <option value="true">Nur aktive</option>
              <option value="false">Nur stillgelegte</option>
            </HTMLSelect>
          </FilterGroup>
        </FilterPopover>
        {role && <FilterTag label={ROLE_LABEL[role]} onRemove={() => setRole("")} />}
        {state && <FilterTag label={state === "true" ? "nur aktive" : "nur stillgelegte"} onRemove={() => setState("")} />}
      </Toolbar>

      {failed && !rows ? (
        <NonIdealState icon="error" title="Benutzer nicht geladen" description={failed}
                       action={<Button icon="refresh" onClick={load}>Erneut versuchen</Button>} />
      ) : !sorted ? <Spinner size={30} /> : sorted.length === 0 ? (
        <NonIdealState icon="search" title="Keine Konten" description="Kein Konto passt zu Suche und Filtern." />
      ) : (
        <div className="table-scroll">
        <HTMLTable className="data-table" striped compact>
          <thead>
            <tr>
              <th>Konto</th><th>Rolle</th><th>Firma</th><th>Preisgruppe</th>
              <th className="num">Rabatt</th><th>Zahlungsziel</th><th>Zuletzt angemeldet</th><th>Sicherheit</th><th><span className="sr-only">Aktion</span></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((u) => (
              <tr key={u.id} className={u.active ? undefined : "row-muted"}>
                <td>
                  <b>{u.name || "—"}</b>
                  <div className="mono sub">{u.email}</div>
                  {!u.active && <Tag minimal intent="warning">stillgelegt</Tag>}
                </td>
                <td><Tag minimal intent={ROLE_INTENT[u.role]}>{ROLE_LABEL[u.role]}</Tag></td>
                <td>{u.company || "—"}{u.customer_no && <div className="mono sub">Kd-Nr. {u.customer_no}</div>}</td>
                <td>{priceGroupLabel(u.price_group)}</td>
                <td className="num">{u.discount_pct ? `${u.discount_pct} %` : "—"}</td>
                <td className="sub">{u.payment_terms}</td>
                <td className="sub">{u.last_login ? fmtDateTime(u.last_login) : "nie"}</td>
                <td>
                  {u.totp_enabled ? <Tag minimal intent="success" icon="shield">2FA</Tag> : <Tag minimal>ohne 2FA</Tag>}
                  {isLocked(u) && <Tag minimal intent="danger" icon="lock" style={{ marginLeft: 4 }}>gesperrt</Tag>}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <KeyPopover placement="bottom-end" content={
                    <Menu>
                      <MenuItem icon="edit" text="Konto ändern"
                        onClick={() => { setOriginal(u); setEdit({ ...u }); }} />
                      <MenuItem icon="key" text="Kennwort setzen"
                        onClick={() => setPw({ user: u, value: "", show: false })} />
                      <MenuItem icon="history" text="Verlauf" onClick={() => openHistory(u)} />
                      {isLocked(u) && <MenuItem icon="unlock" text="Entsperren" onClick={() => unlock(u)} />}
                      {u.totp_enabled && <MenuItem icon="mobile-phone" text="Zweiten Faktor zurücksetzen"
                        onClick={() => setConfirm({ kind: "mfa", user: u })} />}
                      <MenuDivider />
                      {u.active
                        ? <MenuItem icon="disable" intent="danger" text="Stilllegen oder löschen"
                            onClick={() => setConfirm({ kind: "delete", user: u })} />
                        : <MenuItem icon="undo" text="Wieder aktivieren" onClick={() => reactivate(u)} />}
                    </Menu>
                  }>
                    <Button small minimal icon="more" aria-label={`Aktionen für ${u.email}`} title="Aktionen" />
                  </KeyPopover>
                </td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
        </div>
      )}

      <Dialog isOpen={!!edit} onClose={() => setEdit(null)} style={{ width: 540 }}
              title={edit?.id ? `Konto ${edit.email}` : "Neues Konto"}>
        <form onSubmit={(e) => { e.preventDefault(); save(); }}>
          <DialogBody>
            {edit && (
              <div className="form-grid">
                {!edit.id && (
                  <>
                    <label>E-Mail
                      <InputGroup type="email" value={edit.email ?? ""} autoFocus
                                  intent={domainProblem(edit.email ?? "", edit.role) ? "danger" : "none"}
                                  onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
                    </label>
                    <label>Kennwort
                      <InputGroup type="text" value={edit.password ?? ""} placeholder="mind. 8 Zeichen, nicht aus Name/E-Mail"
                                  rightElement={<Button minimal icon="refresh" title="Vorschlag erzeugen" aria-label="Kennwort vorschlagen"
                                                        onClick={() => setEdit({ ...edit, password: generatePassword() })} />}
                                  onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
                    </label>
                  </>
                )}
                {domainProblem(edit.email ?? original?.email ?? "", edit.role) && (
                  <Callout intent="danger" style={{ gridColumn: "1 / -1" }}>
                    {domainProblem(edit.email ?? original?.email ?? "", edit.role)}
                  </Callout>
                )}
                <label>Name
                  <InputGroup value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                </label>
                <label>Firma
                  <InputGroup value={edit.company ?? ""} onChange={(e) => setEdit({ ...edit, company: e.target.value })} />
                </label>
                <label>Rolle
                  <HTMLSelect fill value={edit.role ?? "staff"}
                              onChange={(e) => setEdit({ ...edit, role: e.currentTarget.value as Role })}>
                    {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </HTMLSelect>
                </label>
                <label>Kundennummer
                  <InputGroup value={edit.customer_no ?? ""} placeholder="leer = wird bei Kunden vergeben"
                              onChange={(e) => setEdit({ ...edit, customer_no: e.target.value })} />
                </label>
                <label>Preisgruppe
                  <HTMLSelect fill value={edit.price_group ?? "standard"}
                              onChange={(e) => setEdit({ ...edit, price_group: e.currentTarget.value })}>
                    {withCurrent(PRICE_GROUPS, edit.price_group).map(([v, l]) =>
                      <option key={v} value={v}>{l}</option>)}
                  </HTMLSelect>
                </label>
                <label>Rabatt (%)
                  <NumericInput fill clampValueOnBlur min={0} max={100} stepSize={0.5} value={edit.discount_pct ?? 0}
                                onValueChange={(v) => setEdit({ ...edit, discount_pct: Number.isFinite(v) ? v : 0 })} />
                </label>
                <label style={{ gridColumn: "1 / -1" }}>Zahlungsziel
                  <HTMLSelect fill value={edit.payment_terms ?? "30 Tage netto"}
                              onChange={(e) => setEdit({ ...edit, payment_terms: e.currentTarget.value })}>
                    {withCurrent(PAYMENT_TERMS, edit.payment_terms).map(([v, l]) =>
                      <option key={v} value={v}>{l}</option>)}
                  </HTMLSelect>
                </label>
                {edit.id != null && (
                  <Switch checked={edit.active !== false} label="Konto aktiv (aus = stilllegen, alle Sitzungen enden)"
                          style={{ gridColumn: "1 / -1" }}
                          onChange={(e) => setEdit({ ...edit, active: e.currentTarget.checked })} />
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter actions={
            <>
              <Button text="Abbrechen" onClick={() => setEdit(null)} />
              <Button intent="primary" type="submit" text="Speichern" loading={busy} />
            </>} />
        </form>
      </Dialog>

      <Dialog isOpen={!!pw} onClose={() => setPw(null)} title="Kennwort setzen" style={{ width: 460 }}>
        <form onSubmit={(e) => { e.preventDefault(); setPassword(); }}>
          <DialogBody>
            <p>Neues Kennwort für <b>{pw?.user.email}</b>. Sperren werden aufgehoben, offene Sitzungen beendet;
               der Benutzer wird nicht benachrichtigt — geben Sie es auf sicherem Weg weiter.</p>
            <InputGroup type={pw?.show ? "text" : "password"} placeholder="mind. 8 Zeichen, nicht aus Name/E-Mail"
                        value={pw?.value ?? ""} autoFocus aria-label="Neues Kennwort"
                        onChange={(e) => setPw(pw ? { ...pw, value: e.target.value } : null)}
                        rightElement={<>
                          <Button minimal icon={pw?.show ? "eye-off" : "eye-open"} aria-label="Kennwort zeigen"
                                  onClick={() => pw && setPw({ ...pw, show: !pw.show })} />
                          <Button minimal icon="refresh" aria-label="Kennwort vorschlagen"
                                  onClick={() => pw && setPw({ ...pw, value: generatePassword(), show: true })} />
                        </>} />
          </DialogBody>
          <DialogFooter actions={
            <>
              <Button text="Abbrechen" onClick={() => setPw(null)} />
              <Button intent="primary" type="submit" text="Setzen" loading={busy} disabled={!pw?.value} />
            </>} />
        </form>
      </Dialog>

      <Alert isOpen={!!confirm} onCancel={() => setConfirm(null)} onConfirm={runConfirm}
             cancelButtonText="Abbrechen" intent="danger" icon={confirm?.kind === "mfa" ? "mobile-phone" : "disable"}
             confirmButtonText={confirm?.kind === "mfa" ? "Zweiten Faktor zurücksetzen" : "Stilllegen bzw. löschen"}>
        {confirm?.kind === "mfa" ? (
          <p>Zweiten Faktor von <b>{confirm.user.email}</b> zurücksetzen? Geheimnis und Wiederherstellungscodes
             verschwinden, alle Sitzungen enden. Nur tun, wenn die Person sich zweifelsfrei ausgewiesen hat.</p>
        ) : confirm ? (
          <p><b>{confirm.user.email}</b>: Hat das Konto Aufträge, wird es stillgelegt; sonst wird es gelöscht.
             Alle Sitzungen enden.</p>
        ) : null}
      </Alert>

      <Drawer isOpen={!!history} onClose={() => setHistory(null)} size={520}
              title={history ? `Verlauf ${history.user.email}` : ""}>
        <div style={{ padding: 16, overflow: "auto" }}>
          {!history?.rows ? <Spinner size={24} /> : history.rows.length === 0 ? (
            <NonIdealState icon="history" title="Keine Einträge" />
          ) : (
            <HTMLTable compact striped style={{ width: "100%" }}>
              <thead><tr><th>Zeit</th><th>Wer</th><th>Aktion</th></tr></thead>
              <tbody>
                {history.rows.map((a) => (
                  <Fragment key={a.id}>
                    <tr><td className="sub">{fmtDateTime(a.at)}</td><td>{a.actor}</td><td><Tag minimal>{a.action}</Tag></td></tr>
                    {a.detail && Object.keys(a.detail).length > 0 && (
                      <tr><td colSpan={3}>
                        <HintDetails title="Details">
                          <pre className="ui-json" style={{ margin: 0 }}>{JSON.stringify(a.detail, null, 2)}</pre>
                          <Button small minimal icon="duplicate" text="Kopieren"
                                  aria-label={`Details zu ${a.action} kopieren`} onClick={() => copyDetail(a)} />
                        </HintDetails>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </HTMLTable>
          )}
        </div>
      </Drawer>
    </PageFrame>
  );
}
