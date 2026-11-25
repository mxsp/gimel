import {
  Button, Callout, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect,
  InputGroup, NumericInput, NonIdealState, Spinner, Switch, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { api, fmtDateTime } from "../api";
import { navigate } from "../router";
import { toastError, toastSuccess } from "../toast";
import { Drawer, PageFrame, Toolbar } from "../ui";

// ==========================================================================
// 1. E-Mail-Zentrale (ERP-Portal & Copilot Lab Vorlagen/Freigabe)
// ==========================================================================
interface MailItem {
  id: number;
  direction: string;
  folder: "inbox" | "drafts" | "sent" | "archive";
  status: string;
  from_addr: string;
  from_name: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string;
  body_text: string;
  ai_summary: string;
  ai_drafted: boolean;
  order_no: string;
  work_order_no: string;
  purchase_order_no: string;
  supplier_name: string;
  proposal_id: number | null;
  is_read: boolean;
  starred: boolean;
  delivery_mode: string;
  created_at: string | null;
  sent_at: string | null;
  received_at: string | null;
}

interface MailConfig {
  smtp_host: string;
  smtp_port: number;
  smtp_secure: "starttls" | "tls";
  smtp_user: string;
  smtp_has_password: boolean;
  smtp_from: string;
  smtp_from_name: string;
  silent: boolean;
  smtp_configured: boolean;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_has_password: boolean;
  imap_folder: string;
  imap_configured: boolean;
}

export function MailCenterPage({ admin = false }: { admin?: boolean }) {
  const [folder, setFolder] = useState<"inbox" | "drafts" | "sent" | "archive">("inbox");
  const [items, setItems] = useState<MailItem[]>([]);
  const [counts, setCounts] = useState({ inbox: 0, drafts: 0, sent: 0, archive: 0, unread_inbox: 0 });
  const [selected, setSelected] = useState<MailItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfg, setCfg] = useState<MailConfig | null>(null);
  const [smtpPass, setSmtpPass] = useState("");
  const [imapPass, setImapPass] = useState("");
  const [busy, setBusy] = useState(false);

  const [draftForm, setDraftForm] = useState({
    template: "custom" as "custom" | "po" | "rfq" | "order_status",
    to: "",
    subject: "",
    body_text: "",
    order_no: "",
    purchase_order_no: "",
    product_id: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ folder });
      if (q.trim()) qs.set("q", q.trim());
      const res = await api<{ messages: MailItem[]; counts: typeof counts }>(`/api/mail/messages?${qs.toString()}`);
      setItems(res.messages);
      setCounts(res.counts);
      if (selected) {
        const up = res.messages.find((m) => m.id === selected.id);
        if (up) setSelected(up);
      }
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setLoading(false);
    }
  }, [folder, q]);

  useEffect(() => { void load(); }, [load]);

  const openMail = async (m: MailItem) => {
    setSelected(m);
    if (!m.is_read) {
      try {
        await api(`/api/mail/messages/${m.id}`, { method: "PATCH", body: JSON.stringify({ is_read: true }) });
        setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, is_read: true } : x)));
        setCounts((c) => ({ ...c, unread_inbox: Math.max(0, c.unread_inbox - 1) }));
      } catch { /* ignore */ }
    }
  };

  const createDraft = async (sendNow: boolean) => {
    setBusy(true);
    try {
      const created = await api<MailItem>("/api/mail/drafts", {
        method: "POST",
        body: JSON.stringify({
          template: draftForm.template,
          to_addrs: draftForm.to.split(/[,;\s]+/).filter(Boolean),
          subject: draftForm.subject,
          body_text: draftForm.body_text,
          order_no: draftForm.order_no,
          purchase_order_no: draftForm.purchase_order_no,
          product_id: draftForm.product_id,
          send_immediately: sendNow,
        }),
      });
      toastSuccess(sendNow ? "E-Mail gesendet." : "Entwurf erstellt.");
      setComposeOpen(false);
      setFolder(sendNow ? "sent" : "drafts");
      setSelected(created);
      await load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const sendExisting = async (m: MailItem) => {
    setBusy(true);
    try {
      await api(`/api/mail/messages/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({ to_addrs: m.to_addrs, subject: m.subject, body_text: m.body_text }),
      });
      await api(`/api/mail/messages/${m.id}/send`, { method: "POST" });
      toastSuccess("Nachricht versendet.");
      setFolder("sent");
      await load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const syncImap = async () => {
    setBusy(true);
    try {
      const r = await api<{ imported: number }>("/api/mail/sync-imap", { method: "POST" });
      toastSuccess(`${r.imported} neue E-Mail(s) per IMAP abgerufen.`);
      await load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const openConfig = async () => {
    try {
      setCfg(await api<MailConfig>("/api/mail/config"));
      setSmtpPass("");
      setImapPass("");
      setCfgOpen(true);
    } catch (e: any) { toastError(e.message); }
  };

  const saveConfig = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      await api("/api/mail/config", {
        method: "PUT",
        body: JSON.stringify({
          ...cfg,
          smtp_pass: smtpPass ? smtpPass : null,
          imap_pass: imapPass ? imapPass : null,
        }),
      });
      toastSuccess("Mail-Konfiguration gespeichert.");
      setCfgOpen(false);
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  return (
    <PageFrame
      title="Postfach & Copilot-Mail"
      sub="Lieferanten- und Kundenkommunikation mit Bestell-/RFQ-Vorlagen und nahtloser Anbindung an das Copilot Lab."
      actions={
        <>
          <Button small icon="cloud-download" text="IMAP abrufen" loading={busy} onClick={syncImap} />
          {admin && <Button small icon="cog" text="SMTP / IMAP" onClick={openConfig} />}
          <Button small intent="primary" icon="envelope" text="Neue E-Mail / Vorlage"
                  onClick={() => {
                    setDraftForm({ template: "custom", to: "", subject: "", body_text: "", order_no: "", purchase_order_no: "", product_id: "" });
                    setComposeOpen(true);
                  }} />
        </>
      }
    >
      <Toolbar>
        <div className="ui-filter-chips">
          {([
            ["inbox", `Posteingang (${counts.inbox}${counts.unread_inbox ? ` · ${counts.unread_inbox} neu` : ""})`],
            ["drafts", `Entwürfe (${counts.drafts})`],
            ["sent", `Gesendet (${counts.sent})`],
            ["archive", `Archiv (${counts.archive})`],
          ] as const).map(([id, label]) => (
            <button key={id} type="button"
                    className={"filter-chip" + (folder === id ? " filter-chip-on" : "")}
                    onClick={() => { setFolder(id); setSelected(null); }}>
              {label}
            </button>
          ))}
        </div>
        <InputGroup small leftIcon="search" placeholder="Betreff, Adresse, Auftrag, Bestellung…"
                    value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260, marginLeft: "auto" }} />
      </Toolbar>

      <div className="split-view">
        <div className="split-main">
          {loading && !items.length ? <Spinner size={28} /> : items.length === 0 ? (
            <NonIdealState icon="inbox" title="Keine Nachrichten in diesem Ordner"
                           description="Neue E-Mail erstellen oder im Copilot Lab einen Entwurf generieren lassen." />
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {items.map((m) => (
                <div key={m.id}
                     onClick={() => openMail(m)}
                     style={{
                       padding: "10px 12px",
                       border: "1px solid var(--g-line, #d5d9df)",
                       borderRadius: 6,
                       cursor: "pointer",
                       background: selected?.id === m.id ? "var(--g-surface-2, rgba(45,114,210,0.08))" : undefined,
                       fontWeight: !m.is_read ? 600 : 400,
                     }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span>
                      {!m.is_read && <Tag intent="primary" minimal style={{ marginRight: 6 }}>Neu</Tag>}
                      {m.ai_drafted && <Tag intent="warning" minimal style={{ marginRight: 6 }}>KI-Entwurf</Tag>}
                      <b>{m.subject}</b>
                    </span>
                    <span className="sub mono">{fmtDateTime(m.received_at || m.sent_at || m.created_at)}</span>
                  </div>
                  <div className="sub" style={{ marginTop: 3 }}>
                    {m.direction === "inbound" ? `Von: ${m.from_name || m.from_addr}` : `An: ${(m.to_addrs || []).join(", ") || "—"}`}
                    {m.purchase_order_no && <Tag minimal style={{ marginLeft: 6 }}>{m.purchase_order_no}</Tag>}
                    {m.order_no && <Tag minimal style={{ marginLeft: 6 }}>{m.order_no}</Tag>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <aside className="side-frame" style={{ minWidth: 380 }}>
            <div className="side-head">
              <div className="side-kicker">{selected.folder.toUpperCase()} · #{selected.id}</div>
              <h2>{selected.subject}</h2>
              <div className="sub">
                {selected.direction === "inbound"
                  ? `Von: ${selected.from_name ? `${selected.from_name} <${selected.from_addr}>` : selected.from_addr}`
                  : `An: ${(selected.to_addrs || []).join(", ")}`}
              </div>
            </div>
            <div className="side-body">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {selected.order_no && (
                  <Button small outlined icon="inbox" text={`Auftrag ${selected.order_no}`}
                          onClick={() => navigate(`auftraege/${selected.order_no}`)} />
                )}
                {selected.purchase_order_no && (
                  <Button small outlined icon="shopping-cart" text={`Bestellung ${selected.purchase_order_no}`}
                          onClick={() => navigate("lager")} />
                )}
                <Button small outlined icon="chat" text="Im Copilot Lab öffnen"
                        onClick={() => window.open("/lab", "_blank", "noopener")} />
              </div>

              {selected.folder === "drafts" ? (
                <>
                  <FormGroup label="Empfänger">
                    <InputGroup value={(selected.to_addrs || []).join(", ")}
                                onChange={(e) => setSelected({ ...selected, to_addrs: e.target.value.split(/[,;\s]+/).filter(Boolean) })} />
                  </FormGroup>
                  <FormGroup label="Betreff">
                    <InputGroup value={selected.subject}
                                onChange={(e) => setSelected({ ...selected, subject: e.target.value })} />
                  </FormGroup>
                  <FormGroup label="Nachricht">
                    <TextArea fill rows={10} value={selected.body_text}
                              onChange={(e) => setSelected({ ...selected, body_text: e.target.value })} />
                  </FormGroup>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button intent="primary" icon="send-message" text="Jetzt senden" loading={busy}
                            onClick={() => sendExisting(selected)} />
                    <Button icon="floppy-disk" text="Entwurf speichern" loading={busy}
                            onClick={async () => {
                              await api(`/api/mail/messages/${selected.id}`, {
                                method: "PATCH",
                                body: JSON.stringify({ to_addrs: selected.to_addrs, subject: selected.subject, body_text: selected.body_text }),
                              });
                              toastSuccess("Entwurf aktualisiert.");
                              await load();
                            }} />
                  </div>
                </>
              ) : (
                <>
                  <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 13, lineHeight: 1.55, margin: "8px 0 14px" }}>
                    {selected.body_text}
                  </pre>
                  <div style={{ display: "flex", gap: 8 }}>
                    {selected.direction === "inbound" && (
                      <Button small intent="primary" icon="undo" text="Antwort entwerfen"
                              onClick={() => {
                                setDraftForm({
                                  template: "custom",
                                  to: selected.from_addr,
                                  subject: selected.subject.startsWith("Re:") ? selected.subject : `Re: ${selected.subject}`,
                                  body_text: `\n\n--- Ursprüngliche Nachricht ---\n${selected.body_text}`,
                                  order_no: selected.order_no,
                                  purchase_order_no: selected.purchase_order_no,
                                  product_id: "",
                                });
                                setComposeOpen(true);
                              }} />
                    )}
                    {selected.folder !== "archive" && (
                      <Button small minimal icon="archive" text="Archivieren"
                              onClick={async () => {
                                await api(`/api/mail/messages/${selected.id}`, { method: "PATCH", body: JSON.stringify({ folder: "archive" }) });
                                setSelected(null);
                                await load();
                              }} />
                    )}
                  </div>
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      <Dialog isOpen={composeOpen} onClose={() => setComposeOpen(false)} title="E-Mail verfassen / Vorlage erzeugen" style={{ width: 640 }}>
        <DialogBody>
          <FormGroup label="Vorlage">
            <HTMLSelect fill value={draftForm.template}
                        onChange={(e) => setDraftForm({ ...draftForm, template: e.currentTarget.value as any })}>
              <option value="custom">Freie Nachricht</option>
              <option value="po">Lieferanten-Bestellung (aus Bestell-Nr. BE-…)</option>
              <option value="rfq">Preisanfrage / RFQ an Auto-Lieferant (aus Werkstoff-ID)</option>
              <option value="order_status">Auftragsstatus an Kunden (aus Auftrags-Nr. AB-…)</option>
            </HTMLSelect>
          </FormGroup>
          {draftForm.template === "po" && (
            <FormGroup label="Bestellnummer (z. B. BE-26-0004)">
              <InputGroup value={draftForm.purchase_order_no} onChange={(e) => setDraftForm({ ...draftForm, purchase_order_no: e.target.value })} />
            </FormGroup>
          )}
          {draftForm.template === "rfq" && (
            <FormGroup label="Werkstoff-ID (z. B. epdm-70)">
              <InputGroup value={draftForm.product_id} onChange={(e) => setDraftForm({ ...draftForm, product_id: e.target.value })} />
            </FormGroup>
          )}
          {draftForm.template === "order_status" && (
            <FormGroup label="Auftragsnummer (z. B. AB-26-0001)">
              <InputGroup value={draftForm.order_no} onChange={(e) => setDraftForm({ ...draftForm, order_no: e.target.value })} />
            </FormGroup>
          )}
          <FormGroup label="Empfänger (leer lassen bei Vorlage = automatisch aus Stammdaten)">
            <InputGroup value={draftForm.to} placeholder="einkauf@lieferant.de" onChange={(e) => setDraftForm({ ...draftForm, to: e.target.value })} />
          </FormGroup>
          <FormGroup label="Betreff (optional bei Vorlage)">
            <InputGroup value={draftForm.subject} onChange={(e) => setDraftForm({ ...draftForm, subject: e.target.value })} />
          </FormGroup>
          <FormGroup label="Text (optional bei Vorlage)">
            <TextArea fill rows={6} value={draftForm.body_text} onChange={(e) => setDraftForm({ ...draftForm, body_text: e.target.value })} />
          </FormGroup>
        </DialogBody>
        <DialogFooter actions={<>
          <Button text="Abbrechen" onClick={() => setComposeOpen(false)} />
          <Button icon="floppy-disk" text="Als Entwurf anlegen" loading={busy} onClick={() => createDraft(false)} />
          <Button intent="primary" icon="send-message" text="Direkt senden" loading={busy} onClick={() => createDraft(true)} />
        </>} />
      </Dialog>

      <Dialog isOpen={cfgOpen} onClose={() => setCfgOpen(false)} title="SMTP- & IMAP-Verbindung" style={{ width: 640 }}>
        <DialogBody>
          {cfg && (
            <div className="form-grid">
              <FormGroup label="SMTP-Host"><InputGroup value={cfg.smtp_host} onChange={(e) => setCfg({ ...cfg, smtp_host: e.target.value })} /></FormGroup>
              <FormGroup label="SMTP-Port"><NumericInput fill value={cfg.smtp_port} onValueChange={(v) => Number.isFinite(v) && setCfg({ ...cfg, smtp_port: v })} /></FormGroup>
              <FormGroup label="SMTP-Benutzer"><InputGroup value={cfg.smtp_user} onChange={(e) => setCfg({ ...cfg, smtp_user: e.target.value })} /></FormGroup>
              <FormGroup label={`SMTP-Passwort ${cfg.smtp_has_password ? "(gespeichert)" : ""}`}>
                <InputGroup type="password" value={smtpPass} placeholder="Leer = unverändert" onChange={(e) => setSmtpPass(e.target.value)} />
              </FormGroup>
              <FormGroup label="Absender-Adresse"><InputGroup value={cfg.smtp_from} onChange={(e) => setCfg({ ...cfg, smtp_from: e.target.value })} /></FormGroup>
              <FormGroup label="Absender-Name"><InputGroup value={cfg.smtp_from_name} onChange={(e) => setCfg({ ...cfg, smtp_from_name: e.target.value })} /></FormGroup>
              <Switch checked={cfg.silent} label="Trockenlauf (nur lokal im Postfach speichern, kein externer SMTP-Versand)"
                      onChange={(e) => setCfg({ ...cfg, silent: e.currentTarget.checked })} style={{ gridColumn: "1 / -1" }} />
              <FormGroup label="IMAP-Host (optional)"><InputGroup value={cfg.imap_host} onChange={(e) => setCfg({ ...cfg, imap_host: e.target.value })} /></FormGroup>
              <FormGroup label="IMAP-Port"><NumericInput fill value={cfg.imap_port} onValueChange={(v) => Number.isFinite(v) && setCfg({ ...cfg, imap_port: v })} /></FormGroup>
              <FormGroup label="IMAP-Benutzer"><InputGroup value={cfg.imap_user} onChange={(e) => setCfg({ ...cfg, imap_user: e.target.value })} /></FormGroup>
              <FormGroup label={`IMAP-Passwort ${cfg.imap_has_password ? "(gespeichert)" : ""}`}>
                <InputGroup type="password" value={imapPass} placeholder="Leer = unverändert" onChange={(e) => setImapPass(e.target.value)} />
              </FormGroup>
            </div>
          )}
        </DialogBody>
        <DialogFooter actions={<>
          <Button text="Abbrechen" onClick={() => setCfgOpen(false)} />
          <Button intent="primary" text="Speichern" loading={busy} onClick={saveConfig} />
        </>} />
      </Dialog>
    </PageFrame>
  );
}

// ==========================================================================
// 2. Kollegen-Notizen & Schichtübergabe (Seite + Schnell-Drawer in Kopfzeile)
// ==========================================================================
interface Coworker {
  id: number;
  email: string;
  name: string;
  role: string;
  handle: string;
}

interface NoteItem {
  id: number;
  sender_name: string;
  sender_email: string;
  recipient_name: string;
  recipient_email: string;
  channel: string;
  priority: "normal" | "important" | "urgent";
  subject: string;
  body: string;
  entity_type: string;
  entity_id: string;
  pinned: boolean;
  ack_required: boolean;
  acknowledged_by: string;
  acknowledged_at: string | null;
  unread: boolean;
  created_at: string | null;
}

function jumpToEntity(entityType: string, entityId: string) {
  if (!entityId) return;
  if (entityType === "order") navigate(`auftraege/${entityId}`);
  else if (entityType === "work_order") navigate(`produktion/${entityId}`);
  else if (entityType === "product") navigate("werkstoffe");
  else if (entityType === "purchase_order") navigate("lager");
  else if (entityType === "calendar") navigate("kalender");
}

export function TeamNotesBoard({ compact = false }: { compact?: boolean }) {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [coworkers, setCoworkers] = useState<Coworker[]>([]);
  const [box, setBox] = useState<"all" | "inbox" | "sent" | "pinned">("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [target, setTarget] = useState<string>("channel:alle");
  const [priority, setPriority] = useState<"normal" | "important" | "urgent">("normal");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [ackReq, setAckReq] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nRes, cRes] = await Promise.all([
        api<{ notes: NoteItem[]; unread_count: number }>(`/api/notes?box=${box}`),
        api<Coworker[]>("/api/notes/coworkers"),
      ]);
      setNotes(nRes.notes);
      setCoworkers(cRes);
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setLoading(false);
    }
  }, [box]);

  useEffect(() => { void load(); }, [load]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      const isUser = target.startsWith("user:");
      const payload: Record<string, unknown> = {
        channel: isUser ? "direkt" : target.replace("channel:", ""),
        recipient_id: isUser ? Number(target.slice(5)) : null,
        priority,
        subject: subject.trim(),
        body: body.trim(),
        entity_type: entityType,
        entity_id: entityId.trim(),
        ack_required: ackReq,
      };
      await api("/api/notes", { method: "POST", body: JSON.stringify(payload) });
      toastSuccess("Kollegen-Notiz gesendet.");
      setSubject("");
      setBody("");
      setEntityId("");
      setAckReq(false);
      await load();
    } catch (err: any) { toastError(err.message); } finally { setBusy(false); }
  };

  const ack = async (id: number) => {
    try {
      await api(`/api/notes/${id}/ack`, { method: "POST" });
      await load();
    } catch (e: any) { toastError(e.message); }
  };

  const markRead = async (id: number) => {
    try {
      await api(`/api/notes/${id}/read`, { method: "POST" });
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, unread: false } : n)));
    } catch { /* ignore */ }
  };

  return (
    <div>
      <form onSubmit={send} style={{
        padding: 12, border: "1px solid var(--g-line, #d5d9df)", borderRadius: 6, marginBottom: 14,
      }}>
        <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "1fr 150px 1fr", gap: 8, marginBottom: 8 }}>
          <HTMLSelect fill value={target} onChange={(e) => setTarget(e.currentTarget.value)} aria-label="Empfänger oder Kanal">
            <optgroup label="Team-Kanäle">
              <option value="channel:alle">#alle — Gesamtes Team</option>
              <option value="channel:schicht">#schicht — Schichtübergabe</option>
              <option value="channel:halle">#halle — Werkstatt & Maschinen</option>
              <option value="channel:buero">#buero — Auftragsbüro & Einkauf</option>
            </optgroup>
            <optgroup label="Direkt an Kollegen">
              {coworkers.map((c) => (
                <option key={c.id} value={`user:${c.id}`}>{c.name} ({c.role})</option>
              ))}
            </optgroup>
          </HTMLSelect>
          <HTMLSelect fill value={priority} onChange={(e) => setPriority(e.currentTarget.value as any)} aria-label="Priorität">
            <option value="normal">Normal</option>
            <option value="important">Wichtig</option>
            <option value="urgent">Dringend!</option>
          </HTMLSelect>
          <InputGroup placeholder="Betreff (optional)" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <TextArea fill rows={compact ? 2 : 3} placeholder="Notiz an Kollegen schreiben (@name erwähnt direkt)…"
                  value={body} onChange={(e) => setBody(e.target.value)} style={{ marginBottom: 8 }} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <HTMLSelect value={entityType} onChange={(e) => setEntityType(e.currentTarget.value)} aria-label="Verknüpfungsart">
            <option value="">Ohne Bezug</option>
            <option value="order">Auftrag (AB-…)</option>
            <option value="work_order">Innenauftrag / Laufschein (IA-…)</option>
            <option value="product">Werkstoff</option>
            <option value="purchase_order">Einkauf (BE-…)</option>
          </HTMLSelect>
          {entityType && (
            <InputGroup small placeholder="Kennung (z. B. IA-26-0001)" value={entityId}
                        onChange={(e) => setEntityId(e.target.value)} style={{ width: 170 }} />
          )}
          <Switch checked={ackReq} label="Quittierung anfordern" inline style={{ margin: 0 }}
                  onChange={(e) => setAckReq(e.currentTarget.checked)} />
          <span style={{ flex: 1 }} />
          <Button type="submit" intent="primary" icon="send-message" text="Notiz senden"
                  loading={busy} disabled={!body.trim()} />
        </div>
      </form>

      <div className="ui-filter-chips" style={{ marginBottom: 10 }}>
        {([
          ["all", "Alle"],
          ["inbox", "Für mich"],
          ["sent", "Gesendet"],
          ["pinned", "Angepinnt"],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" className={"filter-chip" + (box === id ? " filter-chip-on" : "")}
                  onClick={() => setBox(id)}>
            {label}
          </button>
        ))}
      </div>

      {loading && !notes.length ? <Spinner size={24} /> : notes.length === 0 ? (
        <p className="sub">Keine Notizen in dieser Ansicht.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {notes.map((n) => (
            <div key={n.id} onClick={() => n.unread && markRead(n.id)}
                 style={{
                   padding: "10px 12px",
                   border: "1px solid var(--g-line, #d5d9df)",
                   borderLeft: n.priority === "urgent" ? "4px solid #c23030" : n.priority === "important" ? "4px solid #d9822b" : undefined,
                   borderRadius: 6,
                 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div>
                  {n.unread && <Tag intent="primary" minimal style={{ marginRight: 6 }}>Neu</Tag>}
                  {n.priority === "urgent" && <Tag intent="danger" minimal style={{ marginRight: 6 }}>Dringend</Tag>}
                  {n.pinned && <Tag intent="warning" minimal icon="pin" style={{ marginRight: 6 }}>Pin</Tag>}
                  <b>{n.subject || `Notiz von ${n.sender_name}`}</b>
                  <span className="sub" style={{ marginLeft: 8 }}>
                    {n.sender_name} → {n.recipient_name ? n.recipient_name : `#${n.channel}`}
                  </span>
                </div>
                <span className="sub mono">{fmtDateTime(n.created_at)}</span>
              </div>
              <div style={{ whiteSpace: "pre-wrap", marginTop: 6, fontSize: 13 }}>{n.body}</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                {n.entity_id && (
                  <Button small outlined icon="share" text={`${n.entity_type}: ${n.entity_id}`}
                          onClick={() => jumpToEntity(n.entity_type, n.entity_id)} />
                )}
                {n.ack_required && !n.acknowledged_at && (
                  <Button small intent="success" icon="tick" text="Gelesen & Quittieren" onClick={() => ack(n.id)} />
                )}
                {n.acknowledged_at && (
                  <Tag minimal intent="success" icon="endorsed">Quittiert von {n.acknowledged_by}</Tag>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TeamNotesPage() {
  return (
    <PageFrame
      title="Kollegen-Notizen & Schichtübergabe"
      sub="Direktnachrichten, @Erwähnungen und objektbezogene Übergaben zwischen Büro, Leitstand, Werkstatt und Copilot Lab."
    >
      <TeamNotesBoard />
    </PageFrame>
  );
}

export function TopBarNotesDrawerButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="hide-narrow" minimal icon="annotation" text="Notizen"
              title="Kollegen-Notizen & Übergaben öffnen"
              onClick={() => setOpen(true)} />
      <Drawer open={open} onClose={() => setOpen(false)}
              title="Kollegen-Notizen & Übergabe"
              sub="Nachrichten an Kollegen im ERP, auf der Laufkarte & im Copilot Lab">
        <TeamNotesBoard compact />
      </Drawer>
    </>
  );
}
