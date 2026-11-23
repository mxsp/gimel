import { Icon } from "@blueprintjs/core";

export type GimelAppId = "erp" | "twin" | "lab";

/** Vereinheitlichter 3-Wege-Umschalter am Fuß der Seitenleiste (identisch in ERP, Twin & Agent Lab). */
export default function AppSwitcher({ active }: { active: GimelAppId }) {
  return (
    <nav className="rail-app-switcher" aria-label="Anwendungsbereich">
      <a
        className={`rail-app-link${active === "erp" ? " is-active" : ""}`}
        href="/app/"
        aria-current={active === "erp" ? "page" : undefined}
        onClick={active === "erp" ? (e) => e.preventDefault() : undefined}
      >
        <Icon icon="applications" size={12} aria-hidden="true" /> ERP
      </a>
      <a
        className={`rail-app-link${active === "twin" ? " is-active" : ""}`}
        href="/studio/"
        aria-current={active === "twin" ? "page" : undefined}
        onClick={active === "twin" ? (e) => e.preventDefault() : undefined}
      >
        <Icon icon="cube" size={12} aria-hidden="true" /> Twin
      </a>
      <a
        className={`rail-app-link${active === "lab" ? " is-active" : ""}`}
        href="/lab/"
        aria-current={active === "lab" ? "page" : undefined}
        onClick={active === "lab" ? (e) => e.preventDefault() : undefined}
      >
        <Icon icon="chat" size={12} aria-hidden="true" /> Lab
      </a>
    </nav>
  );
}
