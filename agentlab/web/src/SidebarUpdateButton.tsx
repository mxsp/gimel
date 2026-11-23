import { Button, Callout, Dialog, DialogBody, DialogFooter, Icon, Tag } from "@blueprintjs/core";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

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
  const [errMsg, setErrMsg] = useState("");

  const check = useCallback(async (force = false) => {
    setChecking(true);
    setErrMsg("");
    try {
      const data = await api<UpdateStatusData>(
        `/api/updates/status${force && isAdmin ? "?force=true" : ""}`,
      );
      setInfo(data);
    } catch (e: any) {
      if (force) setErrMsg(e?.message ?? "Update-Prüfung fehlgeschlagen.");
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
    setErrMsg("");
    try {
      const res = await api<UpdateApplyData>("/api/updates/apply", {
        method: "POST",
        body: JSON.stringify({ tag: info.latest_tag, rebuild_web: true }),
      });
      setResult(res);
    } catch (e: any) {
      setErrMsg(e?.message ?? "Update fehlgeschlagen.");
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
        className={`lab-update-btn${hasUpdate ? " is-available" : ""}`}
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
        <span className="lab-update-label">{label}</span>
        {hasUpdate && <span className="lab-update-dot" aria-label="Update verfügbar" />}
      </button>

      <Dialog
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Gimel Updates (GitHub Releases)"
        icon="cloud-download"
        style={{ width: 520, maxWidth: "94vw" }}
      >
        <DialogBody>
          {errMsg && (
            <Callout intent="danger" style={{ marginBottom: 10 }}>
              {errMsg}
            </Callout>
          )}
          {!info ? (
            <p>Prüfe GitHub Releases…</p>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
                <span style={{ opacity: 0.8 }}>
                  Quelle: <code>github.com/{info.repo}</code>
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
                    Installiert: <code>v{info.current_version}</code> → Neu:{" "}
                    <code>{info.latest_tag}</code>
                  </p>
                  {info.matched_asset && (
                    <p style={{ margin: "4px 0 0", opacity: 0.85 }}>
                      Paket: <code>{info.matched_asset.name}</code>{" "}
                      ({(info.matched_asset.size / (1024 * 1024)).toFixed(1)} MB)
                    </p>
                  )}
                </Callout>
              ) : (
                <Callout intent="success" title={`Gimel v${info.current_version} ist aktuell`}>
                  Neuestes Release auf GitHub: <code>{info.latest_tag ?? `v${info.current_version}`}</code>.
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
                    <pre style={{ margin: "8px 0 0", padding: 8, borderRadius: 6, overflow: "auto" }}>
                      {result.command_hint}
                    </pre>
                  )}
                </Callout>
              )}

              {info.release_notes && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ marginBottom: 4, fontWeight: 600, fontSize: 12 }}>
                    Release Notes ({info.release_name || info.latest_tag})
                  </div>
                  <pre style={{ whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto", margin: 0, fontSize: 12 }}>
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
