import { Icon, IconName, Menu, MenuDivider, MenuItem } from "@blueprintjs/core";
import { useLayoutEffect, useRef, useState } from "react";
import { SessionUser } from "./api";
import AppSwitcher from "./components/AppSwitcher";
import BotSmiley from "./components/BotSmiley";
import SidebarUpdateButton from "./components/SidebarUpdateButton";
import { showFirstStepsAgain } from "./components/FirstSteps";
import KeyPopover from "./ui/KeyPopover";
import { DENSITY_LABEL, Density, readDensity, setDensity } from "./ui/prefs";
import {
  AREAS, NAV_HOME, NavGroup, NavItem, WorkArea,
  areaNav, areaTarget, menuNav, navSection, toolsOpen,
} from "./nav";
import { moduleHref, moduleIsInternalHash, useAppModules } from "./modules/externalStore";
import { navigate } from "./router";
import { readFlag, writeFlag } from "./ui/detail";

const TOOLS_KEY = "gimel-nav-tools";
const DENSITIES: Density[] = ["standard", "compact", "comfort"];

export default function SideNavigation({ route, role, features, area, onArea, user, onHelp, onLogout, appVersion, onOpenSystemInfo }: {
  route: string;
  role: string;
  features: string[] | null;
  area: WorkArea;
  onArea: (area: WorkArea) => void;
  user?: SessionUser | null;
  onHelp?: () => void;
  onLogout?: () => void;
  appVersion?: string;
  onOpenSystemInfo?: () => void;
}) {
  const sidebar = useRef<HTMLElement>(null);
  const section = navSection(route, role);
  const groups = areaNav(role, features, area);
  const [toolsChoice, setToolsChoice] = useState<boolean | null>(() => readFlag(TOOLS_KEY));
  const openTools = toolsOpen(toolsChoice, section, groups);

  useLayoutEffect(() => {
    const container = sidebar.current;
    const active = container?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!container || !active) return;
    // Move only this scroll container, and only as far as needed. In particular,
    // visiting a child page must not re-centre an already visible navigation item.
    const reveal = () => {
      const outer = container.getBoundingClientRect();
      const inner = active.getBoundingClientRect();
      if (inner.top < outer.top) container.scrollTop += inner.top - outer.top;
      else if (inner.bottom > outer.bottom) container.scrollTop += inner.bottom - outer.bottom;
      if (inner.left < outer.left) container.scrollLeft += inner.left - outer.left;
      else if (inner.right > outer.right) container.scrollLeft += inner.right - outer.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(container);
    return () => observer.disconnect();
  }, [section, area]);

  const adminMenu = menuNav(role, features);
  const { modules } = useAppModules(true);
  const sidebarModules = modules.filter(
    (m) => m.enabled && m.placement === "sidebar" && (role === "worker" || m.area === "beide" || m.area === area),
  );
  const menuModules = modules.filter((m) => m.enabled && m.placement === "menu");
  const displayName = user?.name || user?.email || "";
  const roleLabel = role === "admin" ? "Admin · Betrieb" : role === "worker" ? "Werker" : "Personal";
  const [density, setDensityState] = useState<Density>(readDensity);

  return <aside className="app-sidebar" ref={sidebar}>
    <button className="sidebar-skip" onClick={() => document.getElementById("page-content")?.focus({ preventScroll: true })}>
      Zum Seiteninhalt
    </button>
    <div className="rail-top">
      <a className="rail-brand" href="#/heute" aria-label="ERP Portal, zu Heute">
        <BotSmiley size={30} variant="brand" trackMouse />
        <span className="rail-brand-text">
          <strong>ERP Portal</strong>
          <span>Gimel</span>
        </span>
      </a>
    </div>
    {role !== "worker" && <div className="area-switch" role="group" aria-label="Arbeitsbereich">
      {AREAS.map((a) => <a key={a.area} className="area-switch-link" href={`#/${areaTarget(a.area, role, features)}`}
        aria-current={a.area === area ? "true" : undefined}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          // Der Bereichswechsel schreibt die Merkstelle sofort neu; das href wäre dann schon ein anderes.
          e.preventDefault();
          onArea(a.area);
        }}>{a.label}</a>)}
    </div>}
    <nav className="sidebar-nav" aria-label="Hauptnavigation">
      <ul className="sidebar-links"><Link item={NAV_HOME} section={section} /></ul>
      {groups.map((group) => group.collapsible
        ? <ToolGroup key={group.label} group={group} section={section} open={openTools}
            onToggle={() => {
              // Die Wahl gilt je Browser. Eine offene Route darin hält die Gruppe trotzdem offen.
              const next = !openTools;
              setToolsChoice(next);
              writeFlag(TOOLS_KEY, next);
            }} />
        : <div className="sidebar-group" key={group.label}>
          <span className="sidebar-group-title" id={`nav-${group.label}`}>{group.label}</span>
          <ul className="sidebar-links" aria-labelledby={`nav-${group.label}`}>
            {group.items.map((item) => <Link key={item.route} item={item} section={section} />)}
          </ul>
        </div>)}
      {sidebarModules.length > 0 && (
        <div className="sidebar-group" key="ext-modules">
          <span className="sidebar-group-title" id="nav-erweiterungen">Erweiterungen</span>
          <ul className="sidebar-links" aria-labelledby="nav-erweiterungen">
            {sidebarModules.map((m) => {
              const internal = moduleIsInternalHash(m);
              const current = internal && route === `ext/${m.id}`;
              return (
                <li key={m.id}>
                  <a
                    className="sidebar-link"
                    href={moduleHref(m)}
                    target={!internal && m.new_tab ? "_blank" : undefined}
                    rel={!internal && m.new_tab ? "noopener noreferrer" : undefined}
                    aria-current={current ? "page" : undefined}
                  >
                    <Icon icon={(m.icon || "applications") as IconName} size={14} aria-hidden="true" />
                    <span className="sidebar-link-label">{m.label}</span>
                    {!internal && m.new_tab && <Icon icon="share" size={11} className="sidebar-external" aria-hidden="true" />}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </nav>
    <div className="rail-foot">
      {user && <SidebarUpdateButton isAdmin={role === "admin"} />}
      {user && onLogout && (
        <KeyPopover
          minimal
          placement="top-start"
          content={
            <Menu className="user-menu">
              <MenuDivider title={`${displayName} · ${roleLabel}`} />
              {adminMenu.map((item) => (
                <MenuItem key={item.route} icon={item.icon} text={item.label} onClick={() => navigate(item.route)} />
              ))}
              {menuModules.map((m) => (
                <MenuItem
                  key={`ext-${m.id}`}
                  icon={(m.icon || "applications") as IconName}
                  text={m.label}
                  labelElement={!moduleIsInternalHash(m) && m.new_tab ? <Icon icon="share" size={11} aria-hidden="true" /> : undefined}
                  onClick={() => {
                    if (moduleIsInternalHash(m)) navigate(`ext/${encodeURIComponent(m.id)}`);
                    else if (m.new_tab) window.open(moduleHref(m), "_blank", "noopener,noreferrer");
                    else window.location.href = moduleHref(m);
                  }}
                />
              ))}
              {(adminMenu.length > 0 || menuModules.length > 0) && <MenuDivider />}
              <MenuItem icon="comparison" text="Zeilenhöhe">
                {DENSITIES.map((value) => (
                  <MenuItem key={value} text={DENSITY_LABEL[value]} roleStructure="listoption" selected={density === value}
                    onClick={() => { setDensity(value); setDensityState(value); }} />
                ))}
              </MenuItem>
              {onHelp && <MenuItem icon="key-command" text="Tastenkürzel" label="?" onClick={onHelp} />}
              <MenuItem icon="flag" text="Erste Schritte zeigen" onClick={() => { showFirstStepsAgain(); navigate("heute"); }} />
              <MenuDivider />
              <MenuItem icon="log-out" text="Abmelden" onClick={onLogout} />
            </Menu>
          }
        >
          <button type="button" className="rail-user-btn" aria-label={`Benutzermenü: ${displayName}, ${roleLabel}`}>
            <span className="rail-user-avatar" aria-hidden="true"><Icon icon="user" size={14} /></span>
            <span className="rail-user-main">
              <strong>{displayName}</strong>
              <span>{roleLabel}</span>
            </span>
            <Icon icon="more" size={14} aria-hidden="true" />
          </button>
        </KeyPopover>
      )}
      <AppSwitcher active="erp" />
      {onOpenSystemInfo && (
        <button
          type="button"
          className="bp5-button bp5-minimal bp5-small"
          style={{ width: "100%", justifyContent: "space-between", fontSize: 11, opacity: 0.78 }}
          onClick={onOpenSystemInfo}
          title="Gimel Einstellungen & System-Info öffnen"
        >
          <span className="mono">{appVersion ? `v${appVersion}` : "Gimel"} · Einstellungen & Info</span>
          <Icon icon="info-sign" size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  </aside>;
}

function Link({ item, section }: { item: NavItem; section: string }) {
  const current = !item.href && section === item.route;
  return <li>
    <a className="sidebar-link" href={item.href ?? `#/${item.route}`}
      target={item.newTab ? "_blank" : undefined}
      rel={item.newTab ? "noreferrer" : undefined}
      aria-current={current ? "page" : undefined}>
      <Icon icon={item.icon} size={14} aria-hidden="true" />
      <span className="sidebar-link-label">{item.label}</span>
      {item.href && <Icon icon="share" size={11} className="sidebar-external" aria-hidden="true" />}
    </a>
  </li>;
}

/** „Werkzeuge": zugeklappt, bis jemand sie öffnet oder eine ihrer Seiten offen ist. */
function ToolGroup({ group, section, open, onToggle }: {
  group: NavGroup; section: string; open: boolean; onToggle: () => void;
}) {
  const active = group.items.some((i) => !i.href && i.route === section);
  return <div className="sidebar-group sidebar-group-tools">
    <button type="button" className="sidebar-group-toggle" aria-expanded={open} aria-controls="nav-werkzeuge"
      // Mit offener Werkzeug-Seite lässt sich die Gruppe nicht zuklappen; der Knopf sagt das.
      aria-disabled={active && open ? true : undefined}
      title={active && open ? "Offen, weil eine Seite daraus gerade offen ist" : open ? "Werkzeuge zuklappen" : "Werkzeuge aufklappen"}
      onClick={() => { if (!(active && open)) onToggle(); }}>
      <Icon icon={open ? "chevron-down" : "chevron-right"} size={12} aria-hidden="true" />
      <span>{group.label}</span>
      {!open && <span className="sidebar-group-count">{group.items.length}</span>}
    </button>
    {open && <ul className="sidebar-links" id="nav-werkzeuge" aria-label={group.label}>
      {group.items.map((item) => <Link key={item.route} item={item} section={section} />)}
    </ul>}
  </div>;
}
