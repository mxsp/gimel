import { Button, Icon, Menu, MenuDivider, MenuItem } from "@blueprintjs/core";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  api, canAdminWork, clearSession, forgetSession, getToken, getUser, resumeSession, SessionUser,
} from "../api";
import { navigate, useHashRoute } from "../router";
import { useVersion } from "../useVersion";
import AppSwitcher from "../components/AppSwitcher";
import BotSmiley from "../components/BotSmiley";
import Login from "../components/Login";
import ThemeSwitch from "../components/ThemeSwitch";
import DetailSwitch from "../ui/DetailSwitch";
import KeyPopover from "../ui/KeyPopover";
import NonIdealState from "../components/NonIdealState";
import { PageLoading } from "../components/PageStates";
import CopilotDock from "../components/agent/CopilotDock";
import { useCopilotDock } from "../components/agent/copilotState";

const FactoryTwin = lazy(() => import("../pages/FactoryTwin"));
const FactoryFloorAdmin = lazy(() => import("../pages/FactoryFloorAdmin"));

function HallAdminOnly() {
  return (
    <>
      <h1 className="page-title">Halle bearbeiten</h1>
      <NonIdealState
        icon="lock"
        title="Nur mit einem Admin-Konto"
        description="Die Halle ändern nur Admin-Konten und das gemeinsame Betriebskonto (PIN). Abmelden und mit der PIN oder mit E-Mail und Passwort eines Admin-Kontos anmelden."
      />
    </>
  );
}

/* Digitaler Grundriss als eigenständige Anwendung — vereinheitlichtes Seitenleisten-Design
   wie Agent Lab (/lab), Twin Studio (/studio) und ERP (/app). */
export default function TwinApp() {
  const [session, setSession] = useState<SessionUser | null>(getUser());
  const [resuming, setResuming] = useState(() => !getUser() || !getToken());
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 860);
  const route = useHashRoute();
  const version = useVersion();
  const demo = version?.demo === true;
  const agentEnabled = version?.agent === true;
  const role = session ? (canAdminWork(session) ? "admin" : session.role) : "";
  const isAdmin = role === "admin";
  const copilot = useCopilotDock(agentEnabled);

  useEffect(() => {
    if (!resuming) return;
    resumeSession().then((u) => { if (u) setSession(u); }).finally(() => setResuming(false));
  }, [resuming]);

  useEffect(() => {
    const onLogout = () => setSession(null);
    window.addEventListener("gimel-logout", onLogout);
    return () => window.removeEventListener("gimel-logout", onLogout);
  }, []);

  useEffect(() => {
    document.title = demo ? "Digitaler Grundriss · Gimel Demo" : "Digitaler Grundriss · Gimel";
  }, [demo]);

  if (resuming) return null;
  if (!session || !getToken()) {
    return (
      <div className="login-page">
        {demo && <div className="demo-banner" role="note">DEMO – Musterwerk GmbH, keine echten Daten</div>}
        <Login subtitle="Digitaler Grundriss — Halle & Leitstand" onLogin={(u) => setSession(u)} />
      </div>
    );
  }

  const isEditor = route === "admin" || route === "grundriss/admin" || route.startsWith("admin/");
  const displayName = session.name || session.email;
  const roleLabel = isAdmin ? "Admin · Betrieb" : role === "worker" ? "Werker" : "Personal";

  const doLogout = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); }
    finally { clearSession(); forgetSession(); setSession(null); }
  };

  return (
    <div className={`twin-rail-shell${sidebarOpen ? "" : " is-collapsed"}`}>
      {sidebarOpen && (
        <aside className="twin-rail-sidebar" aria-label="Grundriss-Navigation">
          <div className="rail-top">
            <a className="rail-brand" href="#/grundriss" aria-label="Digitaler Grundriss">
              <BotSmiley size={30} variant="brand" character="twin" trackMouse />
              <span className="rail-brand-text">
                <strong>Grundriss</strong>
                <span>Gimel</span>
              </span>
            </a>
            <Button minimal small icon="menu" aria-label="Seitenleiste ausblenden"
              onClick={() => setSidebarOpen(false)} />
          </div>

          <nav className="twin-rail-nav" aria-label="Ansichten">
            <div>
              <div className="twin-rail-section-title">Hallenplan</div>
              <button
                type="button"
                className={`twin-rail-btn${!isEditor ? " is-active" : ""}`}
                aria-current={!isEditor ? "page" : undefined}
                onClick={() => navigate("grundriss")}
              >
                <Icon icon="layout" size={14} aria-hidden="true" />
                <span>Halle</span>
              </button>
              {isAdmin && (
                <button
                  type="button"
                  className={`twin-rail-btn${isEditor ? " is-active" : ""}`}
                  aria-current={isEditor ? "page" : undefined}
                  onClick={() => navigate("grundriss/admin")}
                >
                  <Icon icon="edit" size={14} aria-hidden="true" />
                  <span>Halle bearbeiten</span>
                </button>
              )}
            </div>

            <div>
              <div className="twin-rail-section-title">Zwilling</div>
              <a className="twin-rail-btn" href="/studio/">
                <Icon icon="cube" size={14} aria-hidden="true" />
                <span>Twin Studio (3D)</span>
              </a>
              <a className="twin-rail-btn" href="/app/#/arbeitsvorrat">
                <Icon icon="sort-numerical" size={14} aria-hidden="true" />
                <span>Arbeitsvorrat</span>
              </a>
            </div>
          </nav>

          <div className="rail-foot">
            <KeyPopover
              minimal
              placement="top-start"
              content={
                <Menu>
                  <MenuItem icon="cube" text="Twin Studio (3D)" href="/studio/" />
                  <MenuItem icon="applications" text="ERP Portal" href="/app/" />
                  <MenuDivider />
                  <MenuItem icon="log-out" text="Abmelden" onClick={doLogout} />
                </Menu>
              }
            >
              <button type="button" className="rail-user-btn" aria-label="Kontomenü">
                <span className="rail-user-avatar" aria-hidden="true"><Icon icon="user" size={14} /></span>
                <span className="rail-user-main">
                  <strong>{displayName}</strong>
                  <span>{roleLabel}</span>
                </span>
                <Icon icon="more" size={14} aria-hidden="true" />
              </button>
            </KeyPopover>
            <AppSwitcher active="twin" />
          </div>
        </aside>
      )}

      <div className="twin-rail-main-col">
        {demo && <div className="demo-banner" role="note">DEMO – Musterwerk GmbH, keine echten Daten</div>}
        <header className="twin-rail-top">
          {!sidebarOpen && (
            <Button minimal icon="menu" aria-label="Seitenleiste einblenden" onClick={() => setSidebarOpen(true)} />
          )}
          <h1>{isEditor ? "Halle bearbeiten" : "Digitaler Grundriss"}</h1>
          <span className="gimel-bar-spacer" />
          <DetailSwitch />
          {agentEnabled && (
            <Button
              className="hide-narrow"
              minimal
              icon="chat"
              text="Assistent"
              active={copilot.open}
              title="Assistent ein-/ausblenden (Strg+Shift+A)"
              aria-label="Assistent ein- oder ausblenden"
              aria-pressed={copilot.open}
              onClick={copilot.toggle}
            />
          )}
          <ThemeSwitch />
        </header>

        <div className="twin-rail-body">
          <main id="page-content" className="app-main twin-standalone-main" tabIndex={-1}>
            <Suspense fallback={<PageLoading />}>
              {isEditor ? (isAdmin ? <FactoryFloorAdmin /> : <HallAdminOnly />) : <FactoryTwin />}
            </Suspense>
          </main>
          {agentEnabled && (
            <CopilotDock open={copilot.open} onClose={() => copilot.setOpen(false)} user={session} />
          )}
        </div>
      </div>

      {agentEnabled && !copilot.open && (
        <button
          type="button"
          className="copilot-fab"
          aria-label="Assistent öffnen"
          title="Assistent (Strg+Shift+A)"
          onClick={() => copilot.setOpen(true)}
        >
          <Icon icon="chat" size={18} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
