import { Button, Callout, HTMLSelect, Spinner, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { ActionProposal, ApiError, approveProposal, listProposals, rejectProposal } from "./api";

const STATUS_INTENT: Record<string, "warning" | "success" | "danger" | "none"> = {
  pending: "warning",
  approved: "success",
  rejected: "none",
  failed: "danger",
  expired: "none",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Offen",
  approved: "Freigegeben",
  rejected: "Abgelehnt",
  failed: "Fehlgeschlagen",
  expired: "Verfallen",
};

export default function Proposals({
  onChanged,
  onOpenChanges,
}: {
  onChanged?: () => void;
  onOpenChanges?: () => void;
}) {
  const [filter, setFilter] = useState("pending");
  const [rows, setRows] = useState<ActionProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await listProposals(filter);
      setRows(data.proposals);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (row: ActionProposal, action: "approve" | "reject") => {
    setBusyId(row.id);
    setError("");
    setNotice("");
    try {
      if (action === "approve") {
        const res = await approveProposal(row.id);
        setNotice(`Vorschlag #${row.id} ausgeführt: ${res.proposal.result_summary || "OK"}`);
      } else {
        await rejectProposal(row.id);
        setNotice(`Vorschlag #${row.id} abgelehnt.`);
      }
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="lab-page">
      <div className="lab-page-head" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Aktionsvorschläge</h2>
        <HTMLSelect
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          options={[
            { value: "pending", label: "Offen" },
            { value: "approved", label: "Freigegeben" },
            { value: "rejected", label: "Abgelehnt" },
            { value: "all", label: "Alle" },
          ]}
        />
        <Button minimal icon="refresh" onClick={load} loading={loading} text="Aktualisieren" />
        {onOpenChanges && (
          <Button minimal icon="changes" onClick={onOpenChanges} text="Änderungsregister" />
        )}
      </div>

      {error && <Callout intent="danger" style={{ marginBottom: 12 }}>{error}</Callout>}
      {notice && <Callout intent="success" style={{ marginBottom: 12 }}>{notice}</Callout>}

      {loading ? (
        <div className="lab-loading"><Spinner size={24} /></div>
      ) : rows.length === 0 ? (
        <div className="empty">Keine Aktionsvorschläge in dieser Ansicht.</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {rows.map((row) => (
            <div
              key={row.id}
              style={{
                border: "1px solid var(--g-rule-soft, #dce0e5)",
                borderRadius: 4,
                padding: 14,
                background: "var(--g-surface, #fff)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Tag minimal intent={STATUS_INTENT[row.status] ?? "none"}>
                  {STATUS_LABEL[row.status] ?? row.status}
                </Tag>
                <Tag minimal>{row.kind}</Tag>
                <strong>{row.title}</strong>
                <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>
                  #{row.id} · {row.tool_name}
                </span>
              </div>
              {row.rationale && <p style={{ margin: "4px 0 8px" }}>{row.rationale}</p>}
              {Object.keys(row.impact_summary || {}).length > 0 && (
                <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>
                  <strong>Simulierte Wirkung: </strong>
                  {Object.entries(row.impact_summary).map(([k, v]) => (
                    <span key={k} style={{ marginRight: 10 }}>
                      <code>{k}</code>: {Array.isArray(v) ? v.join(", ") : String(v ?? "—")}
                    </span>
                  ))}
                </div>
              )}
              {row.result_summary && (
                <div style={{ fontSize: 12, marginBottom: 8 }}>
                  <strong>Ergebnis:</strong> {row.result_summary}
                  {row.change_id != null && ` (Änderung #${row.change_id})`}
                </div>
              )}
              {row.status === "pending" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <Button
                    small
                    intent="primary"
                    icon="tick"
                    text="Freigeben & ausführen"
                    loading={busyId === row.id}
                    onClick={() => decide(row, "approve")}
                  />
                  <Button
                    small
                    minimal
                    intent="danger"
                    icon="cross"
                    text="Ablehnen"
                    loading={busyId === row.id}
                    onClick={() => decide(row, "reject")}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
