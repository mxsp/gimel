import { Button, HTMLSelect, Spinner, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { ApiError, Change, listChanges, revertChange } from "./api";

export default function Changes({ chatId, onChanged }: { chatId: number | null; onChanged: () => void }) {
  const [rows, setRows] = useState<Change[]>([]);
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listChanges(chatId ?? undefined);
      setRows(data.changes);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => { load(); }, [load]);

  const shown = rows.filter((row) => status === "all" || row.status === status);

  const undo = async (row: Change) => {
    if (row.chat_id == null) return;
    setBusy(row.id); setError("");
    try {
      await revertChange(row.chat_id, row.id);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(0);
    }
  };

  return (
    <div className="lab-page">
      <h2>Änderungen</h2>
      <p className="sub">{chatId ? "Änderungen dieses Chats." : "Alle Änderungen, die der Assistent für Sie ausgeführt hat."} Rücknahme ist nur sicher, solange niemand den Wert inzwischen geändert hat.</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <HTMLSelect minimal value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="all">alle</option>
          <option value="applied">offen</option>
          <option value="reverted">zurückgenommen</option>
        </HTMLSelect>
        <Button icon="refresh" text="Aktualisieren" onClick={load} loading={loading} />
        <span style={{ flex: 1 }} />
        <Tag minimal>{shown.length} Zeile(n)</Tag>
      </div>
      {error && <div className="login-card banner-bad" style={{ width: "auto", marginBottom: 12 }}>{error}</div>}
      {loading && rows.length === 0 ? <Spinner size={28} /> : shown.length === 0 ? (
        <div className="empty">Keine Änderungen in dieser Ansicht.</div>
      ) : (
        <table className="change-table">
          <thead>
            <tr><th>Zeit</th><th>Werkzeug</th><th>Objekt</th><th>Zusammenfassung</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.id}>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>
                  {new Date(row.created_at).toLocaleString("de-DE")}
                </td>
                <td className="mono">{row.tool}</td>
                <td>{row.entity} <span className="mono">{row.entity_id}</span></td>
                <td>{row.summary || row.action}</td>
                <td>
                  <Tag minimal intent={row.status === "applied" ? "success" : "none"}>
                    {row.status === "applied" ? "offen" : "zurückgenommen"}
                  </Tag>
                  {!row.reversible && <Tag minimal intent="warning">nicht rückholbar</Tag>}
                </td>
                <td>
                  {row.status === "applied" && row.reversible && row.chat_id != null && (
                    <Button small minimal icon="undo" text="Rückgängig" loading={busy === row.id}
                      onClick={() => undo(row)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
