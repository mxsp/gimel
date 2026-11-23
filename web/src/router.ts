import { useEffect, useState } from "react";

// Hash-Routing wie im Bestellportal — keine externe Router-Abhängigkeit,
// Deep-Links (#/kunden, #/auftragserfassung/…) funktionieren trotzdem.
export function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route.replace(/^#\/?/, "").split("?")[0];
}

export function useHashQuery(): URLSearchParams {
  const [hash, setHash] = useState(() => window.location.hash || "");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const idx = hash.indexOf("?");
  return new URLSearchParams(idx >= 0 ? hash.slice(idx + 1) : "");
}

export function navigate(to: string): void {
  const clean = to.replace(/^\/+/, "");
  const route = "#/" + clean;
  const path = window.location.pathname;
  // Digitaler Grundriss (/twin): eigene Ansichten (Halle / Editor) bleiben lokal,
  // alle Portal-Routen öffnen das Hauptportal in einem neuen Tab.
  if (path.startsWith("/twin")) {
    if (clean === "" || clean === "grundriss") {
      window.location.hash = "#/";
      return;
    }
    if (clean === "admin" || clean === "grundriss/admin") {
      window.location.hash = "#/admin";
      return;
    }
    window.open(`/app/${route}`, "_blank", "noopener");
    return;
  }
  // Twin Studio hat keine Seiten des Portals: ein Sprung dorthin öffnet das
  // Portal in einem neuen Tab, statt still die Adresse des Studios zu ändern.
  if (path.startsWith("/studio")) {
    window.open(`/app/${route}`, "_blank", "noopener");
    return;
  }
  // Im Hauptportal führen Grundriss-Sprünge in die eigenständige Grundriss-App.
  if (clean === "grundriss" || clean === "factory") {
    window.open("/twin/", "_blank", "noopener");
    return;
  }
  if (clean === "grundriss/admin") {
    window.open("/twin/#/admin", "_blank", "noopener");
    return;
  }
  window.location.hash = route;
}
