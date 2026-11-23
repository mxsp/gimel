import { Button, HTMLSelect, InputGroup, Spinner, Switch, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, isWorker } from "../api";
import { copyToClipboard } from "../factory";
import { toastError, toastSuccess } from "../toast";
import KeyPopover from "../ui/KeyPopover";

export interface LaufkarteShareState {
  enabled: boolean;
  expired: boolean;
  mode: "floor" | "office";
  url: string;
  token: string;
  created_at: string;
  created_by: string;
  expires_at: string | null;
  qr_svg: string;
}

/** Opt-in Steuerung für die über das Netz erreichbare digitale Laufkarte.
 *  Standardmäßig aus; erst nach Freigabe entsteht ein scannbarer QR-Link. */
export default function LaufkarteShareControl({
  woNo,
  small = true,
}: {
  woNo: string;
  small?: boolean;
}) {
  const office = !isWorker();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<LaufkarteShareState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expiresDays, setExpiresDays] = useState<number>(14);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<LaufkarteShareState>(`/api/production/work-orders/${encodeURIComponent(woNo)}/share`);
      setData(r);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [woNo]);

  useEffect(() => {
    setData(null);
  }, [woNo]);

  useEffect(() => {
    if (open && !data && !loading) load();
  }, [open, data, loading, load]);

  const update = async (patch: { enabled?: boolean; mode?: "floor" | "office"; expires_days?: number; rotate?: boolean }) => {
    setBusy(true);
    try {
      const next = await api<LaufkarteShareState>(
        `/api/production/work-orders/${encodeURIComponent(woNo)}/share`,
        {
          method: "POST",
          body: JSON.stringify({
            enabled: patch.enabled ?? data?.enabled ?? true,
            mode: patch.mode ?? data?.mode ?? "floor",
            expires_days: patch.expires_days ?? expiresDays,
            rotate: Boolean(patch.rotate),
          }),
        },
      );
      setData(next);
      if (patch.rotate) toastSuccess("Neuer Netz-Link erzeugt — der alte Link ist ungültig.");
      else if (patch.enabled === true) toastSuccess(`Digitale Laufkarte ${woNo} über das Netz freigegeben.`);
      else if (patch.enabled === false) toastSuccess(`Netz-Freigabe für ${woNo} pausiert.`);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      const next = await api<LaufkarteShareState>(
        `/api/production/work-orders/${encodeURIComponent(woNo)}/share`,
        { method: "DELETE" },
      );
      setData(next);
      toastSuccess(`Netz-Freigabe für ${woNo} widerrufen.`);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    if (!data?.url) return;
    if (await copyToClipboard(data.url)) toastSuccess("Link zur digitalen Laufkarte kopiert.");
    else toastError(data.url);
  };

  const active = Boolean(data?.enabled);

  return (
    <KeyPopover
      isOpen={open}
      onInteraction={(next) => setOpen(next)}
      placement="bottom-end"
      content={
        <div className="lk-share-pop" onClick={(e) => e.stopPropagation()}>
          <div className="lk-share-head">
            <div>
              <div className="lk-share-title">Digitale Laufkarte (Netz)</div>
              <div className="sub mono">{woNo}</div>
            </div>
            <Tag minimal intent={active ? "success" : "none"}>
              {active ? "aktiv" : "aus"}
            </Tag>
          </div>

          {loading && !data ? (
            <div style={{ padding: 16, textAlign: "center" }}><Spinner size={22} /></div>
          ) : (
            <>
              {office ? (
                <div className="lk-share-controls">
                  <Switch
                    checked={active}
                    disabled={busy}
                    label="Über Netz freigeben (QR & Link)"
                    onChange={(e) => update({ enabled: e.currentTarget.checked })}
                  />
                  <div className="lk-share-grid">
                    <label>
                      <span>Sichtumfang</span>
                      <HTMLSelect
                        fill
                        disabled={busy}
                        value={data?.mode ?? "floor"}
                        onChange={(e) => {
                          const mode = e.currentTarget.value as "floor" | "office";
                          if (active) update({ enabled: true, mode });
                          else setData((d) => (d ? { ...d, mode } : null));
                        }}
                      >
                        <option value="floor">Werkstatt (anonym)</option>
                        <option value="office">Vollständig (Büro)</option>
                      </HTMLSelect>
                    </label>
                    <label>
                      <span>Gültigkeit</span>
                      <HTMLSelect
                        fill
                        disabled={busy}
                        value={String(expiresDays)}
                        onChange={(e) => {
                          const days = Number(e.currentTarget.value);
                          setExpiresDays(days);
                          if (active) update({ enabled: true, expires_days: days });
                        }}
                      >
                        <option value="7">7 Tage</option>
                        <option value="14">14 Tage</option>
                        <option value="30">30 Tage</option>
                        <option value="0">Unbefristet</option>
                      </HTMLSelect>
                    </label>
                  </div>
                </div>
              ) : (
                !active && (
                  <p className="sub" style={{ margin: "6px 0 0" }}>
                    Für diesen Innenauftrag ist keine Netz-Freigabe aktiv. Das Büro kann sie bei Bedarf einschalten.
                  </p>
                )
              )}

              {active && data?.url && (
                <div className="lk-share-body">
                  {data.qr_svg && (
                    <div
                      className="lk-share-qr"
                      title="Mit Tablet oder Smartphone scannen"
                      dangerouslySetInnerHTML={{ __html: data.qr_svg }}
                    />
                  )}
                  <InputGroup
                    small
                    readOnly
                    value={data.url}
                    aria-label="Netz-Link der digitalen Laufkarte"
                    rightElement={
                      <Button small minimal icon="duplicate" title="Link kopieren" onClick={copyUrl} />
                    }
                  />
                  <div className="lk-share-meta sub">
                    {data.mode === "floor" ? "Anonymisiert (Werkstatt)" : "Vollständig (Büro)"}
                    {data.expires_at ? ` · gültig bis ${fmtDate(data.expires_at)}` : " · unbefristet"}
                  </div>
                  <div className="lk-share-actions">
                    <Button small intent="primary" icon="share" text="Öffnen"
                      onClick={() => window.open(data.url, "_blank", "noopener,noreferrer")} />
                    <Button small icon="duplicate" text="Link kopieren" onClick={copyUrl} />
                    {office && (
                      <>
                        <Button small minimal icon="refresh" title="Neues Token erzeugen (alter Link wird ungültig)"
                          loading={busy} onClick={() => update({ enabled: true, rotate: true })} />
                        <Button small minimal intent="danger" icon="trash" title="Freigabe widerrufen"
                          loading={busy} onClick={revoke} />
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      }
    >
      <Button
        small={small}
        icon="globe-network"
        intent={active ? "success" : "none"}
        text={active ? "Netz-Laufkarte aktiv" : "Netz-Laufkarte"}
        title="Digitale Laufkarte bei Bedarf über das Netz freigeben (Link & QR-Code)"
      />
    </KeyPopover>
  );
}
