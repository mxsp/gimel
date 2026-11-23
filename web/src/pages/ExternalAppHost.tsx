import { useEffect, useRef, useState } from "react";
import { Button, Callout, Icon, IconName, Spinner, Tag } from "@blueprintjs/core";
import NonIdealState from "../components/NonIdealState";
import { navigate } from "../router";
import { useAppModules } from "../modules/externalStore";

/* Host für eingebettete semi-externe Software (#/ext/<id>).
   Zeigt eine kompakte Kopfleiste (Zurück, Neu laden, Vollbild, Neuer Tab)
   und reicht der eingebetteten Anwendung über postMessage Thema & Kontext weiter. */

export default function ExternalAppHost({ id }: { id: string }) {
  const { modules, loaded } = useAppModules(true);
  const mod = modules.find((m) => m.id === id);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);

  const src = mod?.embed_url || mod?.href || "";

  useEffect(() => {
    setFrameLoaded(false);
  }, [id, src, reloadNonce]);

  const postContext = () => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !src) return;
    let targetOrigin = "*";
    try {
      targetOrigin = src.startsWith("/") ? window.location.origin : new URL(src).origin;
    } catch {
      targetOrigin = "*";
    }
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    try {
      win.postMessage({ type: "gimel:context", source: "gimel-portal", moduleId: id, theme }, targetOrigin);
    } catch { /* egal */ }
  };

  useEffect(() => {
    const onTheme = () => postContext();
    window.addEventListener("gimel-theme", onTheme);
    return () => window.removeEventListener("gimel-theme", onTheme);
  });

  if (!loaded && !mod) {
    return <div className="twin-center"><Spinner size={34} /></div>;
  }

  if (!mod) {
    return (
      <NonIdealState
        icon="applications"
        title="Anwendung nicht gefunden"
        description={`Kein Modul mit der Kennung „${id}“ registriert oder für diese Rolle freigeschaltet.`}
        action={<Button intent="primary" icon="applications" text="Zu Module & Apps" onClick={() => navigate("module")} />}
      />
    );
  }

  if (!src) {
    return (
      <NonIdealState
        icon="warning-sign"
        title={`${mod.label}: keine URL hinterlegt`}
        description="Bitte in Module & Apps eine Ziel-URL eintragen."
        action={<Button intent="primary" icon="cog" text="Module & Apps öffnen" onClick={() => navigate("module")} />}
      />
    );
  }

  return (
    <div className={`ext-host${fullscreen ? " is-fullscreen" : ""}`}>
      <header className="ext-host-bar">
        <div className="ext-host-left">
          <Button small minimal icon="arrow-left" text="Module" onClick={() => navigate("module")} />
          <span className="subnav-sep" aria-hidden="true">/</span>
          <Icon icon={(mod.icon || "applications") as IconName} size={14} aria-hidden="true" />
          <strong className="ext-host-title">{mod.label}</strong>
          <Tag minimal>{mod.kind === "embedded" ? "Eingebettet" : mod.kind}</Tag>
        </div>
        <div className="ext-host-actions">
          <Button
            small
            minimal
            icon="refresh"
            title="Ansicht neu laden"
            aria-label="Ansicht neu laden"
            onClick={() => setReloadNonce((n) => n + 1)}
          />
          <Button
            small
            minimal
            icon={fullscreen ? "minimize" : "fullscreen"}
            title={fullscreen ? "Vollbild beenden" : "Vollbild"}
            aria-label={fullscreen ? "Vollbild beenden" : "Vollbild"}
            onClick={() => setFullscreen((v) => !v)}
          />
          <a
            className="bp5-button bp5-small bp5-minimal"
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            title="Direkt in neuem Tab öffnen"
          >
            <Icon icon="share" size={13} aria-hidden="true" />
            <span className="bp5-button-text">Neuer Tab</span>
          </a>
        </div>
      </header>

      <div className="ext-host-frame-wrap">
        {!frameLoaded && (
          <div className="ext-host-loading">
            <Spinner size={24} />
            <span className="sub">Lade {mod.label} …</span>
          </div>
        )}
        <iframe
          key={`${id}-${reloadNonce}`}
          ref={iframeRef}
          className="ext-host-frame"
          title={mod.label}
          src={src}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          onLoad={() => { setFrameLoaded(true); postContext(); }}
        />
      </div>

      {!frameLoaded && (
        <Callout compact icon="info-sign" className="ext-host-hint">
          Falls der Zielserver das Einbetten blockiert (<code>X-Frame-Options</code>), öffnen Sie die Anwendung direkt über{" "}
          <a href={src} target="_blank" rel="noopener noreferrer">Neuer Tab</a>.
        </Callout>
      )}
    </div>
  );
}
