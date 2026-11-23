import { Button, Classes, Dialog, DialogBody, FormGroup, Icon, InputGroup, Navbar, Toaster } from "@blueprintjs/core";
import { PageLoading } from "./components/PageStates";
import NonIdealState from "./components/NonIdealState";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { clearSession, forgetSession, canAdminWork, getToken, getUser, setSession, api, resumeSession, SessionUser } from "./api";
import { navigate, useHashRoute } from "./router";
import Heute from "./pages/Heute";
import SideNavigation from "./SideNavigation";
import { useVersion } from "./useVersion";
import { AppVersion } from "./version";
import { NAV_GROUPS, missingFeature, useWorkArea } from "./nav";
import { useShortcuts } from "./useShortcuts";
import ShortcutHelp from "./components/ShortcutHelp";
import SystemSettingsPanel from "./components/SystemSettingsPanel";
import GimelMark from "./components/GimelMark";
import Login from "./components/Login";
import ThemeSwitch from "./components/ThemeSwitch";
import DetailSwitch from "./ui/DetailSwitch";
import { initDetail } from "./ui/detail";
import { registerCoreFeatures } from "./modules/features";
import { matchRegisteredFeature } from "./modules/featureRegistry";
import UserMenu from "./components/UserMenu";
import { WORKER_ROUTES } from "./constants";
import JumpPalette, { JumpTrigger } from "./components/JumpPalette";
import CopilotDock from "./components/agent/CopilotDock";
import { useCopilotDock } from "./components/agent/copilotState";
import { routeContext } from "./components/agent/routeContext";
import { usePageContext } from "@agentlab/pageContext";

// Jede Seite lädt erst, wenn sie gebraucht wird; die Startseite Heute ist sofort da.
const Customers = lazy(() => import("./pages/Customers"));
const OrderDesk = lazy(() => import("./pages/OrderDesk"));
const Orders = lazy(() => import("./pages/Orders"));
const Accounting = lazy(() => import("./pages/Accounting"));
const Production = lazy(() => import("./pages/Production"));
const Shipping = lazy(() => import("./pages/Shipping"));
const Inventory = lazy(() => import("./pages/Inventory"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const Materials = lazy(() => import("./pages/Materials"));
const Disposition = lazy(() => import("./pages/Disposition"));
const Nesting = lazy(() => import("./pages/Nesting"));
const FreeNesting = lazy(() => import("./pages/FreeNesting"));
const Drawings = lazy(() => import("./pages/Drawings"));
const Users = lazy(() => import("./pages/Users"));
const Library = lazy(() => import("./pages/Library"));
const FactoryStation = lazy(() => import("./pages/FactoryStation"));
const FactoryOptimize = lazy(() => import("./pages/FactoryOptimize"));
const FactoryStage = lazy(() => import("./pages/FactoryStage"));
const Worklist = lazy(() => import("./pages/Worklist"));
const StationsDirectory = lazy(() => import("./pages/StationsDirectory"));
const Compliance = lazy(() => import("./pages/Compliance"));
const Kalender = lazy(() => import("./pages/Kalender"));

// Detailstufe vor dem ersten Zeichnen setzen (CSS-Regeln unter :root[data-detail]).
initDetail();
// Interne Feature-Module zentral registrieren (Module & Apps, ExternalAppHost, …).
registerCoreFeatures();

// Melde-Zentrale — eine Instanz, an die sich Seiten per AppContext hängen.
export let toaster: Toaster | null = null;

export default function App() {
  const [session, setSessionState] = useState<SessionUser | null>(getUser());
  const [resuming, setResuming] = useState(() => !getUser() || !getToken());
  const route = useHashRoute();
  const version = useVersion();
  const [help, setHelp] = useState(false);
  const [systemInfoOpen, setSystemInfoOpen] = useState(false);
  // Das PIN-Konto bleibt in der Datenbank staff, arbeitet aber als Admin (Beschluss 2026-11-02).
  const role = session ? (canAdminWork(session) ? "admin" : session.role) : "";
  const showHelp = useCallback(() => setHelp(true), []);
  const { area, goToArea } = useWorkArea(route, role, version?.features ?? null);
  useShortcuts(role, version?.features ?? null, showHelp, goToArea);
  const agentEnabled = version?.agent === true;

  const copilot = useCopilotDock(agentEnabled);
  usePageContext(agentEnabled && session ? routeContext(route) : null);

  useEffect(() => {
    if (!resuming) return;
    resumeSession().then((u) => { if (u) setSessionState(u); }).finally(() => setResuming(false));
  }, [resuming]);

  const demo = version?.demo === true;
  useEffect(() => { document.title = demo ? "Gimel Demo" : "Gimel"; }, [demo]);

  useEffect(() => {
    const onLogout = () => setSessionState(null);
    window.addEventListener("gimel-logout", onLogout);
    return () => window.removeEventListener("gimel-logout", onLogout);
  }, []);

  // Globale Assistenten-Navigation (show_in_view action="navigate"): funktioniert auf jeder Portalseite.
  useEffect(() => {
    const onAction = (e: Event) => {
      const detail = (e as CustomEvent).detail as { action?: string; route?: string } | null;
      if (!detail || detail.action !== "navigate" || !detail.route) return;
      const r = String(detail.route).trim();
      if (r.startsWith("/twin") || r.startsWith("/studio") || r.startsWith("/lab")) {
        window.open(r, "_blank", "noopener");
        return;
      }
      const cleaned = r.replace(/^\/app\/?#?\/?/, "").replace(/^#?\/?/, "");
      if (cleaned) navigate(cleaned);
    };
    window.addEventListener("gimel:copilot-action", onAction);
    return () => window.removeEventListener("gimel:copilot-action", onAction);
  }, []);

  if (resuming) return null;
  if (!session || !getToken()) {
    return <div className="login-page">
      {demo && <DemoBanner />}
      <Login onLogin={(user) => setSessionState(user)} />
    </div>;
  }

  const page = gatedPage(route, role, version);
  return (
    <div className="app-shell" data-area={role === "worker" ? undefined : area}>
      {demo && <DemoBanner />}
      <Navbar className="gimel-bar">
        <a className="gimel-brand show-mobile-only" href="#/heute" aria-label="Gimel, zu Heute">
          <GimelMark size={26} /> <span className="gimel-brand-name">Gimel</span>
        </a>
        <JumpTrigger />
        <span className="gimel-bar-spacer" />
        <DetailSwitch />
        {agentEnabled && (
          <Button className="hide-narrow" minimal icon="chat" text="Assistent" active={copilot.open}
                  title="Assistent ein-/ausblenden (Strg+Shift+A)" aria-label="Assistent ein- oder ausblenden"
                  aria-pressed={copilot.open} onClick={copilot.toggle} />
        )}
        <ThemeSwitch />
        <span className="show-mobile-only">
          <UserMenu name={session.name || session.email} role={role} features={version?.features ?? null}
                    onHelp={showHelp}
                    onLogout={async () => {
                      try { await api("/api/auth/logout", { method: "POST" }); }
                      finally { clearSession(); forgetSession(); setSessionState(null); }
                    }} />
        </span>
      </Navbar>
      <div className="app-body">
        <SideNavigation
          route={route}
          role={role}
          features={version?.features ?? null}
          area={area}
          onArea={goToArea}
          user={session}
          onHelp={showHelp}
          appVersion={version?.version}
          onOpenSystemInfo={() => setSystemInfoOpen(true)}
          onLogout={async () => {
            try { await api("/api/auth/logout", { method: "POST" }); }
            finally { clearSession(); forgetSession(); setSessionState(null); }
          }}
        />
        <main id="page-content" className="app-main" tabIndex={-1}><Suspense fallback={<PageLoading />}>{page}</Suspense></main>
        {agentEnabled && (
          <CopilotDock open={copilot.open} onClose={() => copilot.setOpen(false)} user={session} reserve={268} minMain={860} />
        )}
      </div>
      <ShortcutHelp isOpen={help} onClose={() => setHelp(false)} role={role} features={version?.features ?? null} />
      <Dialog
        isOpen={systemInfoOpen}
        onClose={() => setSystemInfoOpen(false)}
        title="Gimel Einstellungen & System-Info"
        icon="info-sign"
        style={{ width: "min(760px, 94vw)" }}
      >
        <DialogBody>
          <SystemSettingsPanel
            isAdmin={canAdminWork(session)}
            onCloseDialog={() => setSystemInfoOpen(false)}
          />
        </DialogBody>
      </Dialog>
      <JumpPalette role={role} features={version?.features ?? null} area={area} assistant={agentEnabled}
                   onHelp={showHelp} onAssistant={copilot.toggle} />
      {agentEnabled && !copilot.open && (
        <button type="button" className="copilot-fab" aria-label="Assistent öffnen" title="Assistent (Strg+Shift+A)"
                onClick={() => copilot.setOpen(true)}>
          <Icon icon="chat" size={18} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function DemoBanner() {
  return <div className="demo-banner" role="note">PLAYGROUND – Musterwerk GmbH (Sandkasten, keine echten Daten)</div>;
}

function AdminOnly() {
  return <><h1 className="page-title">Kein Zugriff</h1>
    <NonIdealState icon="lock" title="Nur für Administratoren"
      description="Benutzerverwaltung und Grundeinstellungen sind Administratoren vorbehalten." /></>;
}

function StandaloneTwinHandoff({ admin = false }: { admin?: boolean }) {
  const target = admin ? "/twin/#/admin" : "/twin/";
  useEffect(() => {
    window.location.replace(target);
  }, [target]);
  return (
    <>
      <h1 className="page-title">Digitaler Grundriss</h1>
      <NonIdealState
        icon="layout"
        title="Eigenständige Anwendung"
        description="Der Digitale Grundriss läuft wie das Agent Lab und Twin Studio als eigene Anwendung unter /twin/."
        action={
          <a className="bp5-button bp5-intent-primary" href={target}>
            Digitalen Grundriss öffnen
          </a>
        }
      />
    </>
  );
}

function OfficeOnly() {
  return <><h1 className="page-title">Kein Zugriff</h1>
    <NonIdealState icon="lock" title="Nur für das Büro"
      description="Werker-Konten sehen Aufträge, Fertigung, Versand und den Arbeitsvorrat. Preise, Kunden, Rechnungen und Planung pflegt das Büro." /></>;
}

/* Plugin-Bildschirme: ohne die Anwendung dahinter antwortet jede Abfrage mit 404.
   Deshalb sofort sagen, was los ist, statt eine leere Seite stehen zu lassen. */
function gatedPage(route: string, role: string, version: AppVersion | null) {
  const needsPlugin = NAV_GROUPS.some((g) => g.items.some((i) => i.feature && i.route === route.split("/")[0]));
  if (needsPlugin && !version) return <PageLoading />;
  const missing = missingFeature(route, version?.features ?? null);
  if (missing) {
    return <><h1 className="page-title">{missing.label}</h1>
      <NonIdealState icon="disable" title="Nicht verfügbar"
        description="Dieser Bildschirm gehört zu einer Anwendung, die in dieser Installation nicht läuft."
        action={<Button icon="calendar" text="Zu Heute" onClick={() => navigate("heute")} />} /></>;
  }
  return renderPage(route, role);
}

function renderPage(route: string, role: string) {
  const admin = role === "admin";
  // 1. Zentrale Feature-Registry: neue interne Module laufen ohne Änderungen an App.tsx.
  const registered = matchRegisteredFeature(route);
  if (registered) {
    if (registered.adminOnly && !admin) return <AdminOnly />;
    if (role === "worker" && !registered.workerAllowed) return <OfficeOnly />;
    return registered.render({ route, role, admin });
  }
  if (role === "worker") {
    const root = route.split("/")[0];
    if (!root || root === "uebersicht") return <Heute />;
    if (!WORKER_ROUTES.includes(root) || route.startsWith("grundriss/admin")
        || route.startsWith("grundriss/optimierung") || root === "optimierung") return <OfficeOnly />;
  }
  if (route === "freies-schachteln") return <FreeNesting />;
  if (route === "zeichnungen") return <Drawings />;
  if (route === "schachteln" || route.startsWith("schachteln/")) return <Nesting no={route.split("/")[1] ?? ""} role={role} />;
  if (route.startsWith("grundriss/admin")) return <StandaloneTwinHandoff admin />;
  if (route.startsWith("grundriss/station/") || route.startsWith("station/")) return <FactoryStation id={route.split("/").pop() || "1"} />;
  // Kommissionieren und Bereitstellen sind ein Bildschirm; die alten Pfade
  // bleiben gültig, damit Lesezeichen und Verweise aus dem Grundriss weiter
  // ankommen.
  if (route.startsWith("grundriss/bereitstellen") || route.startsWith("bereitstellen")
      || route.startsWith("grundriss/kommissionierung") || route.startsWith("kommissionierung")) return <FactoryStage />;
  if (route.startsWith("grundriss/arbeitsplaetze") || route.startsWith("arbeitsplaetze")) return <StationsDirectory />;
  if (route.startsWith("grundriss/arbeitsvorrat") || route.startsWith("arbeitsvorrat")) return <Worklist />;
  if (route.startsWith("grundriss/optimierung") || route.startsWith("optimierung")) return <FactoryOptimize />;
  if (route.startsWith("grundriss") || route.startsWith("factory")) return <StandaloneTwinHandoff />;
  if (route.startsWith("kunden")) return <Customers />;
  if (route.startsWith("auftragserfassung")) return <OrderDesk />;
  if (route.startsWith("auftraege")) return <Orders />;
  if (route.startsWith("disposition")) return <Disposition role={role} />;
  if (route.startsWith("produktion")) return <Production no={route.split("/")[1] ?? ""} />;
  if (route.startsWith("versand")) return <Shipping />;
  if (route.startsWith("lager")) return <Inventory />;
  if (route.startsWith("werkstoffe")) return <Materials />;
  if (route.startsWith("formen")) {
    const id = Number(route.split("/")[1]);
    return <Library id={Number.isFinite(id) && id > 0 ? id : undefined} />;
  }
  if (route.startsWith("benutzer")) return admin ? <Users /> : <AdminOnly />;
  if (route.startsWith("compliance")) return <Compliance admin={admin} />;
  if (route.startsWith("kalender")) return <Kalender />;
  if (route.startsWith("buchhaltung")) return <Accounting />;
  if (route.startsWith("admin")) return <AdminPage />;
  // "uebersicht" war die Startseite bis 2026-10; alte Lesezeichen landen auf Heute.
  return <Heute />;
}

// --------------------------------------------------------------------------
// Anmeldung
// --------------------------------------------------------------------------
