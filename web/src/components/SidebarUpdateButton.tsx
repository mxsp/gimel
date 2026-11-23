import { Button, Callout, Dialog, DialogBody, DialogFooter, Icon, Spinner, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDateTime } from "../api";
import { toastError, toastSuccess } from "../toast";

interface UpdateStatusData {
  repo: string;
  current_version: string;
  latest_version: string | null;
  latest_tag: string | null;
  update_available: boolean;
  install_kind: "binary" | "docker" | "git" | "package";
  release_name: string;
  release_notes: string;
  release_url: string;
  published_at: string;
  matched_asset: { name: string; download_url: string; size: number } | null;
  error: string;
}

interface UpdateApplyData {
  ok: boolean;
  install_kind: string;
  from_version: string;
  to_version: string;
  restart_required: boolean;
  restarting?: boolean;
  detail: string;
  command_hint: string;
}

const KIND_LABEL: Record<string, string> = {
  binary: "Standalone-Programm",
  docker: "Docker-Container",
  git: "Git-Checkout",
  package: "Python-Paket",
};

/** Left-sidebar Update button — automatically hidden when Gimel is up to date. */
export default function SidebarUpdateButton({ isAdmin }: { isAdmin: boolean }) {
  const [info, setInfo] = useState<UpdateStatusData | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [result, setResult] = useState<UpdateApplyData | null>(null);
  const pollRef = useRef<number | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPoll(), [stopPoll]);

  const waitForRestartAndReload = useCallback((targetVersion?: string) => {
    setRestarting(true);
    let sawDown = false;
    let ticks = 0;
    stopPoll();
    pollRef.current = window.setInterval(async () => {
      ticks += 1;
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        if (r.ok) {
          const v = (await r.json()) as { version?: string };
          if ((targetVersion && v.version === targetVersion) || (sawDown && ticks >= 2)) {
            stopPoll();
            window.location.reload();
          }
        }
      } catch {
        sawDown = true;
      }
      if (ticks >= 60) {
        stopPoll();
        setRestarting(false);
      }
    }, 1000);
  }, [stopPoll]);

  const check = useCallback(async (force = false) => {
    setChecking(true);
    try {
      const data = await api<UpdateStatusData>(
        `/api/updates/status${force && isAdmin ? "?force=true" : ""}`,
      );
      setInfo(data);
    } catch (e: any) {
      if (force) toastError(e.message ?? "Update-Prüfung fehlgeschlagen.");
    } finally {
      setChecking(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    check(false);
  }, [check]);

  const apply = async () => {
    if (!info || !isAdmin) return;
    setApplying(true);
    setResult(null);
    try {
      const res = await api<UpdateApplyData>("/api/updates/apply", {
        method: "POST",
        body: JSON.stringify({ tag: info.latest_tag, rebuild_web: true, auto_restart: true }),
      });
      setResult(res);
      if (res.ok && res.restarting) {
        toastSuccess(`Update auf v${res.to_version} installiert — Gimel startet neu…`);
        waitForRestartAndReload(res.to_version);
      } else if (res.ok) {
        toastSuccess(res.detail || "Update installiert.");
        await check(true);
      } else {
        toastError(res.detail || "Update nicht automatisch anwendbar.");
      }
    } catch (e: any) {
      toastError(e.message ?? "Update fehlgeschlagen.");
    } finally {
      setApplying(false);
    }
  };

  const hasUpdate = info?.update_available === true;

  // Automatically remove the sidebar button whenever no new update is available.
  if (!hasUpdate && !open) {
    return null;
  }

  return (
    <>
      {hasUpdate && (
        <button
          type="button"
          className="rail-update-btn is-available"
          onClick={() => setOpen(true)}
          title={`Neues Gimel Release verfügbar: ${info?.latest_tag}`}
        >
          <Icon icon="cloud-download" size={13} aria-hidden="true" />
          <span className="rail-update-label">Update {info?.latest_tag ?? ""}</span>
          <span className="rail-update-dot" aria-label="Update verfügbar" />
        </button>
      )}

      <Dialog
        isOpen={open}
        onClose={() => { if (!restarting) setOpen(false); }}
        title="Gimel Update verfügbar"
        icon="cloud-download"
        style={{ width: 520, maxWidth: "94vw" }}
      >
        <DialogBody>
          {restarting ? (
            <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 4px" }}>
              <Spinner size={28} />
              <div>
                <strong>Gimel startet automatisch neu…</strong>
                <div className="sub" style={{ marginTop: 4 }}>
                  Die neue Version wird geladen. Diese Seite aktualisiert sich in wenigen Sekunden selbst.
                </div>
              </div>
            </div>
          ) : !info ? (
            <p className="sub">Prüfe GitHub Releases…</p>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
                <span className="sub">
                  Quelle: <span className="mono">github.com/{info.repo}</span>
                </span>
                <Tag minimal>{KIND_LABEL[info.install_kind] ?? info.install_kind}</Tag>
              </div>

              {info.error ? (
                <Callout intent="warning" title="Update-Prüfung">
                  {info.error}
                </Callout>
              ) : info.update_available ? (
                <Callout intent="primary" title={`Neues Release: ${info.latest_tag}`}>
                  <p style={{ margin: "4px 0" }}>
                    Installiert: <b className="mono">v{info.current_version}</b> → Neu:{" "}
                    <b className="mono">{info.latest_tag}</b>
                    {info.published_at ? ` (${fmtDateTime(info.published_at)})` : ""}
                  </p>
                  {info.matched_asset && (
                    <p className="sub" style={{ margin: "4px 0 0" }}>
                      Paket: <span className="mono">{info.matched_asset.name}</span>{" "}
                      ({(info.matched_asset.size / (1024 * 1024)).toFixed(1)} MB)
                    </p>
                  )}
                </Callout>
              ) : (
                <Callout intent="success" title={`Gimel v${info.current_version} ist aktuell`}>
                  Es steht kein weiteres Update aus.
                </Callout>
              )}

              {result && (
                <Callout
                  intent={result.ok ? "success" : "warning"}
                  title={result.ok ? "Update angewendet" : "Manueller Schritt erforderlich"}
                  style={{ marginTop: 12 }}
                >
                  <p style={{ margin: "4px 0" }}>{result.detail}</p>
                  {result.command_hint && (
                    <pre className="ui-json" style={{ margin: "8px 0 0" }}>{result.command_hint}</pre>
                  )}
                </Callout>
              )}

              {info.release_notes && (
                <div style={{ marginTop: 12 }}>
                  <div className="sub" style={{ marginBottom: 4, fontWeight: 600 }}>
                    Neuerungen ({info.release_name || info.latest_tag})
                  </div>
                  <pre className="ui-json" style={{ whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto", margin: 0 }}>
                    {info.release_notes}
                  </pre>
                </div>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter
          actions={
            <>
              {info?.release_url && !restarting && (
                <a className="bp5-button bp5-minimal" href={info.release_url} target="_blank" rel="noreferrer">
                  GitHub
                </a>
              )}
              {!restarting && (
                <Button icon="refresh" text="Prüfen" loading={checking} onClick={() => check(true)} />
              )}
              {info?.update_available && isAdmin && !restarting && (
                <Button
                  intent="primary"
                  icon="cloud-download"
                  text={info.install_kind === "docker" ? "Update-Befehl anzeigen" : "Aktualisieren & neu starten"}
                  loading={applying}
                  onClick={apply}
                />
              )}
              {!restarting && <Button text="Schließen" onClick={() => setOpen(false)} />}
            </>
          }
        />
      </Dialog>
    </>
  );
}
