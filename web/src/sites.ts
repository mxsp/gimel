import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Station } from "./factory";

/* Standorte → Hallen → Ebenen (Aufgabe 32).

   Eine Anfrage liefert den ganzen Baum (/api/factory/topology). Die Wahl der
   Ebene merkt sich der Browser, damit Editor und Leitstand dieselbe zeigen. */

export interface LevelInfo {
  id: number;
  hall_id: number | null;
  level: number;
  level_name: string;
  elevation_m: number;
  height_m: number;
  name: string;
  stations: number;
  default: boolean;
}

export interface HallInfo {
  id: number;
  site_id: number | null;
  name: string;
  code: string;
  sort: number;
  lat: number;
  lon: number;
  rotation_deg: number;
  map_enabled: boolean;
  note: string;
  floors: LevelInfo[];
}

export interface SiteInfo {
  id: number;
  name: string;
  code: string;
  address: string;
  lat: number;
  lon: number;
  note: string;
  halls: HallInfo[];
}

export interface Topology {
  sites: SiteInfo[];
  unsited_halls: HallInfo[];
  unassigned_floors: LevelInfo[];
  default_floor_id: number | null;
  default_site_id: number | null;
}

export interface FloorRef {
  floor: LevelInfo;
  hall: HallInfo | null;
  site: SiteInfo | null;
}

/** Jede Ebene mit ihrer Halle und ihrem Standort — flach, für Auswahllisten. */
export function allFloors(t: Topology | null): FloorRef[] {
  if (!t) return [];
  const out: FloorRef[] = [];
  for (const site of t.sites) for (const hall of site.halls) for (const floor of hall.floors) out.push({ floor, hall, site });
  for (const hall of t.unsited_halls) for (const floor of hall.floors) out.push({ floor, hall, site: null });
  for (const floor of t.unassigned_floors) out.push({ floor, hall: null, site: null });
  return out;
}

export function allHalls(t: Topology | null): { hall: HallInfo; site: SiteInfo | null }[] {
  if (!t) return [];
  return [
    ...t.sites.flatMap((site) => site.halls.map((hall) => ({ hall, site }))),
    ...t.unsited_halls.map((hall) => ({ hall, site: null })),
  ];
}

export function floorLabel(r: FloorRef | undefined, withSite = false): string {
  if (!r) return "Ebene";
  const lvl = r.floor.level_name || `Ebene ${r.floor.level}`;
  const hall = r.hall ? `${r.hall.name} · ${lvl}` : lvl;
  return withSite && r.site ? `${r.site.name} · ${hall}` : hall;
}

/** Die Ebene, auf der eine Station steht (leer = erste Ebene). */
export function stationFloor(s: Pick<Station, "floor_id">, t: Topology | null): number | null {
  return s.floor_id ?? t?.default_floor_id ?? null;
}

const KEY = "gimel-floor";

export function useTopology() {
  const [topo, setTopo] = useState<Topology | null>(null);
  const [error, setError] = useState("");
  const [floorId, setFloorIdState] = useState<number | null>(() => {
    try { const v = Number(localStorage.getItem(KEY)); return v > 0 ? v : null; } catch { return null; }
  });
  const reload = useCallback(async () => {
    try {
      const raw = await api<Topology>("/api/factory/topology");
      // Etwas anderes als der Baum (älterer Server, Testattrappe): eine Halle, wie bisher.
      const t = raw && Array.isArray(raw.sites) ? {
        ...raw, unsited_halls: raw.unsited_halls ?? [], unassigned_floors: raw.unassigned_floors ?? [],
      } : null;
      setTopo(t);
      setError("");
      return t;
    } catch (e) {
      // Ein älterer Server ohne Standorte: eine Halle, eine Ebene — wie bisher.
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const floors = useMemo(() => allFloors(topo), [topo]);
  // Gemerkte Ebene gibt es nicht mehr → erste Ebene.
  const current = floors.find((r) => r.floor.id === floorId) ?? floors.find((r) => r.floor.default) ?? floors[0];
  const setFloorId = useCallback((id: number | null) => {
    setFloorIdState(id);
    try { if (id) localStorage.setItem(KEY, String(id)); else localStorage.removeItem(KEY); } catch { /* privater Modus */ }
  }, []);
  return { topo, error, reload, floors, current, floorId: current?.floor.id ?? null, setFloorId };
}

// ---------------------------------------------------------------------------
// Kartenkacheln (OpenStreetMap, Web-Mercator)
// ---------------------------------------------------------------------------
export type MapStyle = "map" | "satellite";

/** Woher die Kacheln kommen. Karte: OpenStreetMap. Satellit: Esri World Imagery
 *  (Luftbild, Nutzungsbedingungen von Esri; vor gewerblichem Dauerbetrieb prüfen). */
const TILE_URL: Record<MapStyle, (z: number, x: number, y: number) => string> = {
  map: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  satellite: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
};

export function mapAttribution(style: MapStyle): string {
  return style === "satellite"
    ? "Luftbild © Esri, Maxar, Earthstar Geographics, GIS User Community"
    : "© OpenStreetMap-Mitwirkende";
}
export const MAP_ATTRIBUTION = mapAttribution("map");

const STYLE_KEY = "gimel-map-style";

/** Karte oder Satellit — je Browser gemerkt, damit Editor und Leitstand gleich aussehen. */
export function useMapStyle(): [MapStyle, (v: MapStyle) => void] {
  const [style, setStyle] = useState<MapStyle>(() => {
    try { return localStorage.getItem(STYLE_KEY) === "satellite" ? "satellite" : "map"; } catch { return "map"; }
  });
  const set = useCallback((v: MapStyle) => {
    setStyle(v);
    try { localStorage.setItem(STYLE_KEY, v); } catch { /* privater Modus */ }
  }, []);
  return [style, set];
}

/** Kantenlänge einer Kachel in Metern an diesem Breitengrad. */
export function tileMetres(lat: number, z: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** Kartenausschnitt der 3D-Halle für eine gewünschte Reichweite in Metern:
    Zoomstufe und Zahl der Kachelringe um den Anker. Weit draußen übernehmen
    gröbere Kacheln, damit die Fläche wächst, ohne dass die Zahl der Anfragen
    an OpenStreetMap mitwächst. Nah an der Halle bleibt die Stufe fein. */
export function mapDetailFor(want: number, lat: number): { z: number; span: number } {
  const reach = Math.min(8000, Math.max(0, want));
  const z = reach > 4800 ? 13 : reach > 2400 ? 14 : reach > 1200 ? 15
    : reach > 600 ? 16 : reach > 280 ? 17 : reach > 140 ? 18 : 19;
  // Zwei Ringe mehr als der Ausschnitt: auch bei naher Kamera bleibt die
  // Umgebung der Halle auf der Karte sichtbar.
  const span = Math.max(4, Math.min(12, Math.ceil(reach / tileMetres(lat, z)) + 2));
  return { z, span };
}

export interface MapTile {
  url: string;
  /** Mitte der Kachel relativ zum Anker, in Metern nach Osten und Norden. */
  east: number;
  north: number;
  size: number;
}

/** Kacheln, die ein Quadrat von ``radius`` Metern um den Anker decken. */
export function tilesAround(
  lat: number, lon: number, radius: number, z = 18, style: MapStyle = "map", maxSpan = 4,
): MapTile[] {
  const n = 2 ** z;
  const tx = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const ty = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  const size = tileMetres(lat, z);
  const span = Math.min(maxSpan, Math.ceil(radius / size));
  const out: MapTile[] = [];
  for (let i = Math.floor(tx) - span; i <= Math.floor(tx) + span; i++) {
    for (let j = Math.floor(ty) - span; j <= Math.floor(ty) + span; j++) {
      if (j < 0 || j >= n) continue;
      const x = ((i % n) + n) % n;
      out.push({
        url: TILE_URL[style](z, x, j),
        east: (i + 0.5 - tx) * size,
        north: -(j + 0.5 - ty) * size,
        size,
      });
    }
  }
  return out;
}

/** Hallenmeter → Meter nach Osten/Norden. Der Plan zählt y nach unten (wie
 *  der Bildschirm), bei 0° ist also x Osten und y Süden; ``rotation_deg``
 *  dreht die x-Achse der Halle gegen den Uhrzeigersinn aus Osten. */
export function hallToWorld(x: number, y: number, rotationDeg: number): [number, number] {
  const t = (rotationDeg * Math.PI) / 180;
  return [x * Math.cos(t) + y * Math.sin(t), x * Math.sin(t) - y * Math.cos(t)];
}

/** Umkehrung: Osten/Norden in Metern → Hallenmeter. Die Abbildung ist ihre eigene Inverse. */
export function worldToHall(east: number, north: number, rotationDeg: number): [number, number] {
  return hallToWorld(east, north, rotationDeg);
}

const M_PER_DEG_LAT = 111_320;

/** Lage einer anderen Halle in den Achsen der Ankerhalle — Meter nach x (Halle)
 *  und y (Plan, nach Süden). ``null``, wenn einer der beiden Anker fehlt. */
export function hallOffset(
  anchor: Pick<HallInfo, "lat" | "lon" | "rotation_deg">,
  other: Pick<HallInfo, "lat" | "lon">,
): { x: number; y: number } | null {
  if ((!anchor.lat && !anchor.lon) || (!other.lat && !other.lon)) return null;
  const east = (other.lon - anchor.lon) * M_PER_DEG_LAT
    * Math.cos((anchor.lat * Math.PI) / 180);
  const north = (other.lat - anchor.lat) * M_PER_DEG_LAT;
  const [x, y] = hallToWorld(east, north, anchor.rotation_deg || 0);
  return { x, y };
}

// ---------------------------------------------------------------------------
// Fertigungsort-Vorgabe
// ---------------------------------------------------------------------------
export interface ScopeView {
  route_scope: string;
  label: string;
  floors: number[] | null;
  site_id?: number | null;
  default_site_id?: number | null;
  released?: boolean;
}

export interface ScopeOption { value: string; label: string; }

/** Gibt es überhaupt etwas zu wählen — mehr als eine Halle oder Ebene? */
export function scopeMatters(t: Topology | null): boolean {
  if (!t) return false;
  return allHalls(t).length > 1 || allHalls(t).some((h) => h.hall.floors.length > 1);
}

/** Auswahl für „Fertigen in": überall, Eingang, je Standort, je Halle, je Ebene. */
export function scopeOptions(t: Topology | null, withReceived = true): ScopeOption[] {
  const out: ScopeOption[] = [{ value: "", label: "Überall" }];
  if (withReceived) out.push({ value: "received", label: "Nur wo eingegangen" });
  if (!t) return out;
  for (const site of t.sites) {
    if (t.sites.length > 1) out.push({ value: `site:${site.id}`, label: `Nur ${site.name}` });
    for (const hall of site.halls) {
      out.push({ value: `hall:${hall.id}`, label: `Nur ${hall.name}${t.sites.length > 1 ? ` (${site.name})` : ""}` });
      if (hall.floors.length > 1) {
        for (const f of hall.floors) out.push({ value: `floor:${f.id}`, label: `Nur ${hall.name} · ${f.level_name}` });
      }
    }
  }
  for (const hall of t.unsited_halls) out.push({ value: `hall:${hall.id}`, label: `Nur ${hall.name}` });
  return out;
}
