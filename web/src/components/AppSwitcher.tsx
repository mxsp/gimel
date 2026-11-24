import { Icon } from "@blueprintjs/core";

export type GimelAppId = "erp" | "twin" | "lab";

/** Vereinheitlichter 3-Wege-Umschalter am Fuß der Seitenleiste (identisch in ERP, Twin & Agent Lab). */
export default function AppSwitcher({ active }: { active: GimelAppId }) {
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  const atErp = active === "erp" && (path === "/" || path.startsWith("/app"));
  const atStudio = active === "twin" && path.startsWith("/studio");
  const atLab = active === "lab" && path.startsWith("/lab");
  return (
    <nav className="rail-app-switcher" aria-label="Anwendungsbereich">
      <a
        className={`rail-app-link${active === "erp" ? " is-active" : ""}`}
        href="/app/"
        aria-current={active === "erp" ? "page" : undefined}
        onClick={atErp ? (e) => e.preventDefault() : undefined}
      >
        <Icon icon="applications" size={12} aria-hidden="true" /> ERP
      </a>
      <a
        className={`rail-app-link${active === "twin" ? " is-active" : ""}`}
        href="/studio/"
        aria-current={active === "twin" ? "page" : undefined}
        onClick={atStudio ? (e) => e.preventDefault() : undefined}
      >
        <Icon icon="cube" size={12} aria-hidden="true" /> Twin
      </a>
      <a
        className={`rail-app-link${active === "lab" ? " is-active" : ""}`}
        href="/lab/"
        aria-current={active === "lab" ? "page" : undefined}
        onClick={atLab ? (e) => e.preventDefault() : undefined}
      >
        <Icon icon="chat" size={12} aria-hidden="true" /> Lab
      </a>
    </nav>
  );
}
