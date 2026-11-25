import {
  Button, Callout, FormGroup, HTMLSelect, InputGroup, Spinner, Switch, Tag, TextArea,
} from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { getToken } from "./api";

async function erpApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const tok = getToken();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.detail) msg = String(data.detail);
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

interface MailRow {
  id: number;
  direction: string;
  folder: "inbox" | "drafts" | "sent" | "archive";
  status: string;
  from_addr: string;
  from_name: string;
  to_addrs: string[];
  subject: string;
  body_text: string;
  ai_drafted: boolean;
  order_no: string;
  purchase_order_no: string;
  proposal_id: number | null;
  is_read: boolean;
  created_at: string | null;
  sent_at: string | null;
  received_at: string | null;
}

export function LabMailView({
  onAskCopilot,
  onOpenProposals,
}: {
  onAskCopilot: (title: string, prompt: string) => void;
  onOpenProposals: () => void;
}) {
  const [folder, setFolder] = useState<"inbox" | "drafts" | "sent" | "archive">("inbox");
  const [mails, setMails] = useState<MailRow[]>([]);
  const [counts, setCounts] = useState({ inbox: 0, drafts: 0, sent: 0, archive: 0, unread_inbox: 0 });
  const [selected, setSelected] = useState<MailRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusMsg, setStatusMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const [compose, setCompose] = useState(false);
  const [template, setTemplate] = useState<"custom" | "po" | "rfq" | "order_status">("custom");
  const [toInput, setToInput] = useState("");
  const [subjInput, setSubjInput] = useState("");
  const [bodyInput, setBodyInput] = useState("");
  const [refInput, setRefInput] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await erpApi<{ messages: MailRow[]; counts: typeof counts }>(`/api/mail/messages?folder=${folder}`);
      setMails(r.messages);
      setCounts(r.counts);
      if (selected) {
        const up = r.messages.find((x) => x.id === selected.id);
        if (up) setSelected(up);
      }
    } catch (e: any) {
      setStatusMsg(e.message);
    } finally {
      setLoading(false);
    }
  }, [folder]);

  useEffect(() => { void load(); }, [load]);

  const openMail = async (m: MailRow) => {
    setSelected(m);
    setCompose(false);
    if (!m.is_read) {
      try {
        await erpApi(`/api/mail/messages/${m.id}`, { method: "PATCH", body: JSON.stringify({ is_read: true }) });
        setMails((prev) => prev.map((x) => (x.id === m.id ? { ...x, is_read: true } : x)));
      } catch { /* ignore */ }
    }
  };

  const submitCompose = async (sendNow: boolean) => {
    setBusy(true);
    setStatusMsg("");
    try {
      const created = await erpApi<MailRow>("/api/mail/drafts", {
        method: "POST",
        body: JSON.stringify({
          template,
          to_addrs: toInput.split(/[,;\s]+/).filter(Boolean),
          subject: subjInput,
          body_text: bodyInput,
          purchase_order_no: template === "po" ? refInput.trim() : "",
          product_id: template === "rfq" ? refInput.trim() : "",
          order_no: template === "order_status" ? refInput.trim() : "",
          send_immediately: sendNow,
        }),
      });
      setCompose(false);
      setFolder(sendNow ? "sent" : "drafts");
      setSelected(created);
      setStatusMsg(sendNow ? "E-Mail wurde gesendet." : "Entwurf im Postfach angelegt.");
      await load();
    } catch (e: any) {
      setStatusMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lab-page" style={{ maxWidth: 1180 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>Copilot E-Mail-Zentrale</h2>
          <div style={{ opacity: 0.72, fontSize: 13 }}>
            Lieferanten-Bestellungen, Preisanfragen (RFQ) und Kunden-E-Mails — mit KI zusammenfassen, beantworten und per Vorschlag freigeben.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button small icon="automatic-updates" text="Posteingang mit Copilot sichten"
                  onClick={() => onAskCopilot(
                    "Posteingang Triage",
                    "Bitte lies die ungelesenen E-Mails im Posteingang (list_emails), fasse dringende Lieferanten- oder Kundenanfragen zusammen und erstelle passende Antwort-Entwürfe per draft_email zur Freigabe.",
                  )} />
          <Button small intent="primary" icon="envelope" text="Verfassen / Vorlage"
                  onClick={() => { setCompose(true); setSelected(null); }} />
          <Button small minimal icon="refresh" onClick={load} />
        </div>
      </div>

      {statusMsg && <Callout intent="primary" style={{ marginBottom: 12 }}>{statusMsg}</Callout>}

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {([
          ["inbox", `Posteingang (${counts.inbox}${counts.unread_inbox ? ` · ${counts.unread_inbox} neu` : ""})`],
          ["drafts", `Entwürfe (${counts.drafts})`],
          ["sent", `Gesendet (${counts.sent})`],
          ["archive", `Archiv (${counts.archive})`],
        ] as const).map(([k, lbl]) => (
          <Button key={k} small active={folder === k} intent={folder === k ? "primary" : "none"}
                  text={lbl} onClick={() => { setFolder(k); setSelected(null); setCompose(false); }} />
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: (selected || compose) ? "minmax(300px, 1fr) minmax(380px, 1.3fr)" : "1fr", gap: 16 }}>
        <div>
          {loading && !mails.length ? <Spinner size={24} /> : mails.length === 0 ? (
            <div className="empty">Keine Nachrichten in diesem Ordner.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {mails.map((m) => (
                <div key={m.id} onClick={() => openMail(m)}
                     style={{
                       padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                       border: selected?.id === m.id ? "1.5px solid var(--lab-accent, #2d72d2)" : "1px solid rgba(128,128,128,0.25)",
                     }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span>
                      {!m.is_read && <Tag intent="primary" minimal style={{ marginRight: 6 }}>Neu</Tag>}
                      {m.ai_drafted && <Tag intent="warning" minimal style={{ marginRight: 6 }}>Copilot</Tag>}
                      <b>{m.subject}</b>
                    </span>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>#{m.id}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                    {m.direction === "inbound" ? `Von: ${m.from_name || m.from_addr}` : `An: ${(m.to_addrs || []).join(", ") || "—"}`}
                    {m.purchase_order_no && <Tag minimal style={{ marginLeft: 6 }}>{m.purchase_order_no}</Tag>}
                    {m.order_no && <Tag minimal style={{ marginLeft: 6 }}>{m.order_no}</Tag>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {compose && (
          <div style={{ padding: 14, border: "1px solid rgba(128,128,128,0.28)", borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>E-Mail / Vorlage erstellen</h3>
            <FormGroup label="Vorlage">
              <HTMLSelect fill value={template} onChange={(e) => setTemplate(e.currentTarget.value as any)}>
                <option value="custom">Freie E-Mail</option>
                <option value="po">Bestellschreiben aus Einkaufsbestellung (BE-…)</option>
                <option value="rfq">Preisanfrage (RFQ) an Auto-Lieferant für Werkstoff</option>
                <option value="order_status">Kunden-Statusmeldung zu Auftrag (AB-…)</option>
              </HTMLSelect>
            </FormGroup>
            {template !== "custom" && (
              <FormGroup label={template === "po" ? "Bestell-Nr. (z. B. BE-26-0004)" : template === "rfq" ? "Werkstoff-ID (z. B. epdm-70)" : "Auftrags-Nr. (z. B. AB-26-0001)"}>
                <InputGroup value={refInput} onChange={(e) => setRefInput(e.target.value)} />
              </FormGroup>
            )}
            <FormGroup label="Empfänger (bei Vorlage optional)">
              <InputGroup value={toInput} placeholder="adresse@beispiel.de" onChange={(e) => setToInput(e.target.value)} />
            </FormGroup>
            <FormGroup label="Betreff">
              <InputGroup value={subjInput} onChange={(e) => setSubjInput(e.target.value)} />
            </FormGroup>
            <FormGroup label="Nachrichtentext">
              <TextArea fill rows={6} value={bodyInput} onChange={(e) => setBodyInput(e.target.value)} />
            </FormGroup>
            <div style={{ display: "flex", gap: 8 }}>
              <Button text="Als Entwurf speichern" loading={busy} onClick={() => submitCompose(false)} />
              <Button intent="primary" icon="send-message" text="Jetzt senden" loading={busy} onClick={() => submitCompose(true)} />
            </div>
          </div>
        )}

        {selected && !compose && (
          <div style={{ padding: 14, border: "1px solid rgba(128,128,128,0.28)", borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>{selected.subject}</h3>
            <div style={{ fontSize: 12, opacity: 0.78, marginBottom: 10 }}>
              {selected.direction === "inbound"
                ? `Von: ${selected.from_name ? `${selected.from_name} <${selected.from_addr}>` : selected.from_addr}`
                : `An: ${(selected.to_addrs || []).join(", ")}`}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <Button small intent="primary" icon="predictive-analysis" text="Mit Copilot prüfen & Antwort entwerfen"
                      onClick={() => onAskCopilot(
                        `Mail #${selected.id}: ${selected.subject}`,
                        `Bitte lies E-Mail #${selected.id} mit read_email, prüfe verknüpfte Bestellungen/Aufträge im ERP und lege mit draft_email einen präzisen Antwort-Entwurf zur Freigabe an.`,
                      )} />
              {selected.proposal_id && (
                <Button small outlined icon="endorsed" text={`Vorschlag #${selected.proposal_id} öffnen`} onClick={onOpenProposals} />
              )}
              {selected.folder === "drafts" && (
                <Button small intent="success" icon="send-message" text="Entwurf jetzt senden" loading={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await erpApi(`/api/mail/messages/${selected.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ to_addrs: selected.to_addrs, subject: selected.subject, body_text: selected.body_text }),
                            });
                            await erpApi(`/api/mail/messages/${selected.id}/send`, { method: "POST" });
                            setStatusMsg("Entwurf gesendet.");
                            setFolder("sent");
                            await load();
                          } catch (e: any) { setStatusMsg(e.message); } finally { setBusy(false); }
                        }} />
              )}
            </div>
            {selected.folder === "drafts" ? (
              <>
                <FormGroup label="Empfänger">
                  <InputGroup value={(selected.to_addrs || []).join(", ")}
                              onChange={(e) => setSelected({ ...selected, to_addrs: e.target.value.split(/[,;\s]+/).filter(Boolean) })} />
                </FormGroup>
                <FormGroup label="Betreff">
                  <InputGroup value={selected.subject} onChange={(e) => setSelected({ ...selected, subject: e.target.value })} />
                </FormGroup>
                <TextArea fill rows={9} value={selected.body_text}
                          onChange={(e) => setSelected({ ...selected, body_text: e.target.value })} />
              </>
            ) : (
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 13, lineHeight: 1.55 }}>
                {selected.body_text}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ==========================================================================
// 2. Kollegen-Notizen im Copilot Lab
// ==========================================================================
interface CoworkerRow { id: number; email: string; name: string; role: string }
interface TeamNoteRow {
  id: number;
  sender_name: string;
  recipient_name: string;
  channel: string;
  priority: "normal" | "important" | "urgent";
  subject: string;
  body: string;
  entity_type: string;
  entity_id: string;
  ack_required: boolean;
  acknowledged_by: string;
  acknowledged_at: string | null;
  unread: boolean;
  created_at: string | null;
}

export function LabNotesView({
  onAskCopilot,
}: {
  onAskCopilot: (title: string, prompt: string) => void;
}) {
  const [notes, setNotes] = useState<TeamNoteRow[]>([]);
  const [coworkers, setCoworkers] = useState<CoworkerRow[]>([]);
  const [target, setTarget] = useState("channel:alle");
  const [priority, setPriority] = useState<"normal" | "important" | "urgent">("normal");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [ackReq, setAckReq] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nr, cr] = await Promise.all([
        erpApi<{ notes: TeamNoteRow[] }>("/api/notes"),
        erpApi<CoworkerRow[]>("/api/notes/coworkers"),
      ]);
      setNotes(nr.notes);
      setCoworkers(cr);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const isUser = target.startsWith("user:");
      await erpApi("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          channel: isUser ? "direkt" : target.replace("channel:", ""),
          recipient_id: isUser ? Number(target.slice(5)) : null,
          priority,
          subject,
          body,
          entity_type: entityType,
          entity_id: entityId,
          ack_required: ackReq,
        }),
      });
      setSubject("");
      setBody("");
      setEntityId("");
      setAckReq(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lab-page" style={{ maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>Kollegen-Notizen &amp; Schichtübergabe</h2>
          <div style={{ opacity: 0.72, fontSize: 13 }}>
            Synchron mit dem ERP-Portal (`/app`) und dem digitalen Laufschein in der Werkstatt.
          </div>
        </div>
        <Button small intent="primary" icon="predictive-analysis" text="KI-Schichtübergabe erstellen"
                onClick={() => onAskCopilot(
                  "Schichtübergabe erstellen",
                  "Prüfe offene Eilaufträge, kritische Lagerbestände (get_smart_stock) und laufende Innenaufträge und formuliere eine prägnante Schichtübergabe-Notiz für das Team.",
                )} />
      </div>

      <div style={{ padding: 14, border: "1px solid rgba(128,128,128,0.28)", borderRadius: 8, marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 1fr", gap: 8, marginBottom: 8 }}>
          <HTMLSelect fill value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
            <optgroup label="Kanäle">
              <option value="channel:alle">#alle — Gesamtes Team</option>
              <option value="channel:schicht">#schicht — Schichtübergabe</option>
              <option value="channel:halle">#halle — Werkstatt</option>
              <option value="channel:buero">#buero — Büro &amp; Einkauf</option>
            </optgroup>
            <optgroup label="Direkt an Kollegen">
              {coworkers.map((c) => <option key={c.id} value={`user:${c.id}`}>{c.name} ({c.role})</option>)}
            </optgroup>
          </HTMLSelect>
          <HTMLSelect fill value={priority} onChange={(e) => setPriority(e.currentTarget.value as any)}>
            <option value="normal">Normal</option>
            <option value="important">Wichtig</option>
            <option value="urgent">Dringend!</option>
          </HTMLSelect>
          <InputGroup placeholder="Betreff" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <TextArea fill rows={3} placeholder="Nachricht an Kollegen (@name erwähnt direkt)…"
                  value={body} onChange={(e) => setBody(e.target.value)} style={{ marginBottom: 8 }} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <HTMLSelect value={entityType} onChange={(e) => setEntityType(e.currentTarget.value)}>
            <option value="">Ohne Bezug</option>
            <option value="order">Auftrag (AB-…)</option>
            <option value="work_order">Innenauftrag / Laufschein (IA-…)</option>
            <option value="product">Werkstoff</option>
            <option value="purchase_order">Bestellung (BE-…)</option>
          </HTMLSelect>
          {entityType && <InputGroup small placeholder="Kennung" value={entityId} onChange={(e) => setEntityId(e.target.value)} style={{ width: 160 }} />}
          <Switch checked={ackReq} label="Quittierung anfordern" inline style={{ margin: 0 }} onChange={(e) => setAckReq(e.currentTarget.checked)} />
          <span style={{ flex: 1 }} />
          <Button intent="primary" icon="send-message" text="Notiz senden" loading={busy} disabled={!body.trim()} onClick={send} />
        </div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {notes.map((n) => (
          <div key={n.id} style={{
            padding: "10px 12px", borderRadius: 8,
            border: "1px solid rgba(128,128,128,0.25)",
            borderLeft: n.priority === "urgent" ? "4px solid #c23030" : n.priority === "important" ? "4px solid #d9822b" : undefined,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>
                {n.priority === "urgent" && <Tag intent="danger" minimal style={{ marginRight: 6 }}>Dringend</Tag>}
                <b>{n.subject || `Notiz von ${n.sender_name}`}</b>
                <span style={{ opacity: 0.7, marginLeft: 8, fontSize: 12 }}>
                  {n.sender_name} → {n.recipient_name || `#${n.channel}`}
                </span>
              </span>
              {n.entity_id && <Tag minimal>{n.entity_type}: {n.entity_id}</Tag>}
            </div>
            <div style={{ whiteSpace: "pre-wrap", marginTop: 6, fontSize: 13 }}>{n.body}</div>
            {n.ack_required && !n.acknowledged_at && (
              <div style={{ marginTop: 6 }}>
                <Button small intent="success" icon="tick" text="Quittieren"
                        onClick={async () => { await erpApi(`/api/notes/${n.id}/ack`, { method: "POST" }); await load(); }} />
              </div>
            )}
            {n.acknowledged_at && (
              <div style={{ marginTop: 4 }}><Tag minimal intent="success">Quittiert von {n.acknowledged_by}</Tag></div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
