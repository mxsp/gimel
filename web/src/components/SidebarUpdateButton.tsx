import { Button, Callout, Dialog, DialogBody, DialogFooter, Icon, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
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
  detail: string;
  command_hint: string;
}

const KIND_LABEL: Record<string, string> = {
  binary: "Standalone-Programm",
  docker: "Docker-Container",
  git: "Git-Checkout",
  package: "Python-Paket",
};

export default function SidebarUpdateButton({ isAdmin }: { isAdmin: boolean }) {
  const [info, setInfo] = useState<UpdateStatusData | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<UpdateApplyData | null>(null);

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
        body: JSON.stringify({ tag: info.latest_tag, rebuild_web: true }),
      });
      setResult(res);
      if (res.ok) toastSuccess(res.detail || "Update installiert.");
      else toastError(res.detail || "Update nicht automatisch anwendbar.");
    } catch (e: any) {
      toastError(e.message ?? "Update fehlgeschlagen.");
    } finally {
      setApplying(false);
    }
  };

  const hasUpdate = info?.update_available === true;
  const label = hasUpdate
    ? `Update ${info?.latest_tag ?? ""}`
    : `Updates${info?.current_version ? ` · v${info.current_version}` : ""}`;

  return (
    <>
      <button
        type="button"
        className={`rail-update-btn${hasUpdate ? " is-available" : ""}`}
        onClick={() => {
          setOpen(true);
          if (!info) check(true);
        }}
        title={
          hasUpdate
            ? `Neues GitHub Release verfügbar: ${info?.latest_tag}`
            : "Auf neue GitHub Releases (mxsp/gimel) prüfen"
        }
      >
        <Icon icon="cloud-download" size={13} aria-hidden="true" />
        <span className="rail-update-label">{label}</span>
        {hasUpdate && <span className="rail-update-dot" aria-label="Update verfügbar" />}
      </button>

      <Dialog
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Gimel Updates (GitHub Releases)"
        icon="cloud-download"
        style={{ width: 520, maxWidth: "94vw" }}
      >
        <DialogBody>
          {!info ? (
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
                <Callout intent="primary" title={`Neues Release verfügbar: ${info.latest_tag}`}>
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
                  Neuestes Release auf GitHub: <b className="mono">{info.latest_tag ?? `v${info.current_version}`}</b>.
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
                    Release Notes ({info.release_name || info.latest_tag})
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
              {info?.release_url && (
                <a className="bp5-button bp5-minimal" href={info.release_url} target="_blank" rel="noreferrer">
                  GitHub
                </a>
              )}
              <Button icon="refresh" text="Prüfen" loading={checking} onClick={() => check(true)} />
              {info?.update_available && isAdmin && (
                <Button
                  intent="primary"
                  icon="cloud-download"
                  text={`Auf ${info.latest_tag} aktualisieren`}
                  loading={applying}
                  onClick={apply}
                />
              )}
              <Button text="Schließen" onClick={() => setOpen(false)} />
            </>
          }
        />
      </Dialog>
    </>
  );
}
