import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonGroup, InputGroup, Menu, MenuItem, Tag } from "@blueprintjs/core";
import MapStyleSwitch from "./MapStyleSwitch";
import { hallToWorld, mapAttribution, MapStyle, useMapStyle } from "../sites";

/* Die Halle auf die Karte legen: Karte ziehen verschiebt die Ansicht, den
   Umriss ziehen verschiebt die Halle, den runden Griff ziehen dreht sie, das
   Rad zoomt. Alles in Web-Mercator-Pixeln; erst beim Loslassen wird daraus
   ein neuer Anker (Breite/Länge) und eine Drehung.

   Die Adresssuche fragt Nominatim (OpenStreetMap) — nur auf Knopfdruck, nie
   beim Tippen, und nur mit dem, was im Feld steht. */

interface Props {
  lat: number;
  lon: number;
  rotation: number;
  outline: [number, number][];
  /** Wo die Ansicht startet, wenn die Halle noch keinen Anker hat (z. B. der Standort). */
  fallback?: { lat: number; lon: number } | null;
  /** Vorschlag für die Suche (Anschrift des Standorts). */
  address?: string;
  onChange: (v: { lat: number; lon: number; rotation: number }) => void;
  /** Andere Hallen desselben Standorts, nur zur Orientierung. */
  others?: { id: number; name: string; lat: number; lon: number; rotation: number; outline: [number, number][] }[];
  saving?: boolean;
  canUndo?: boolean;
  onUndo?: () => void;
}

const W = 720, H = 440, TILE = 256;
const ZMIN = 5, ZMAX = 19;

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
const xToLon = (x: number, z: number) => (x / (TILE * 2 ** z)) * 360 - 180;
const yToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};
const tileUrl = (style: MapStyle, z: number, x: number, y: number) => style === "satellite"
  ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
  : `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

interface Hit { display_name: string; lat: string; lon: string }

/** „51.7518, 11.9702" oder „51,7518 11,9702" aus einer Karten-App. */
export function parseCoords(text: string): { lat: number; lon: number } | null {
  const m = text.trim().match(/^(-?\d{1,2}(?:[.,]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.,]\d+)?)$/)
    ?? text.trim().match(/^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/);
  if (!m) return null;
  const lat = Number(m[1].replace(",", ".")), lon = Number(m[2].replace(",", "."));
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export default function MapPlacer({ lat, lon, rotation, outline, fallback, address = "", onChange, others = [], saving, canUndo, onUndo }: Props) {
  const placed = !!(lat || lon);
  const start = placed ? { lat, lon } : fallback && (fallback.lat || fallback.lon) ? fallback : { lat: 51.16, lon: 10.45 };
  const [center, setCenter] = useState(start);
  const [z, setZ] = useState(placed ? 18 : fallback && (fallback.lat || fallback.lon) ? 17 : 6);
  const [style, setStyle] = useMapStyle();
  const [query, setQuery] = useState(address);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const svgRef = useRef<SVGSVGElement | null>(null);
  /** Laufende Geste: was gezogen wird und wo sie begann (Bildschirmpixel der Ansicht). */
  const drag = useRef<null | { kind: "pan" | "move" | "rotate"; x: number; y: number; center: { lat: number; lon: number }; anchor: { lat: number; lon: number }; rot: number }>(null);
  const [live, setLive] = useState<{ lat: number; lon: number; rotation: number } | null>(null);

  // Neuer Anker von außen (Zahlenfeld, Suche): Ansicht folgt nur, wenn die Halle sonst aus dem Bild wäre.
  useEffect(() => { if (placed && !drag.current) setCenter((c) => (Math.abs(c.lat - lat) > 0.01 || Math.abs(c.lon - lon) > 0.01 ? { lat, lon } : c)); }, [lat, lon, placed]);

  const cur = live ?? { lat, lon, rotation };
  const cx = lonToX(center.lon, z), cy = latToY(center.lat, z);
  const toScreen = (la: number, lo: number): [number, number] => [lonToX(lo, z) - cx + W / 2, latToY(la, z) - cy + H / 2];
  const fromScreen = (sx: number, sy: number) => ({ lat: yToLat(sy - H / 2 + cy, z), lon: xToLon(sx - W / 2 + cx, z) });
  const mPerPx = (40075016.686 * Math.cos((center.lat * Math.PI) / 180)) / (TILE * 2 ** z);

  const tiles = useMemo(() => {
    const out: { key: string; url: string; x: number; y: number }[] = [];
    const n = 2 ** z;
    const x0 = Math.floor((cx - W / 2) / TILE), x1 = Math.floor((cx + W / 2) / TILE);
    const y0 = Math.floor((cy - H / 2) / TILE), y1 = Math.floor((cy + H / 2) / TILE);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) {
      if (j < 0 || j >= n) continue;
      const xi = ((i % n) + n) % n;
      out.push({ key: `${z}/${i}/${j}/${style}`, url: tileUrl(style, z, xi, j), x: i * TILE - cx + W / 2, y: j * TILE - cy + H / 2 });
    }
    return out;
  }, [cx, cy, z, style]);

  const [ax, ay] = toScreen(cur.lat, cur.lon);
  const hallPx = (x: number, y: number): [number, number] => {
    const [e, n] = hallToWorld(x, y, cur.rotation);
    return [ax + e / mPerPx, ay - n / mPerPx];
  };
  const poly = outline.map(([x, y]) => hallPx(x, y).join(",")).join(" ");
  const neighbours = others.map((o) => {
    const [ox, oy] = toScreen(o.lat, o.lon);
    const pts = o.outline.map(([x, y]) => {
      const [e, n] = hallToWorld(x, y, o.rotation);
      return [ox + e / mPerPx, oy - n / mPerPx].join(",");
    }).join(" ");
    return { ...o, ox, oy, pts };
  });
  const reach = Math.max(12, ...outline.map(([x, y]) => Math.hypot(x, y)));
  const [hx, hy] = hallPx(reach + 4 * mPerPx * 6, 0);

  const point = (ev: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H] as [number, number];
  };
  const down = (kind: "pan" | "move" | "rotate") => (ev: React.PointerEvent) => {
    ev.stopPropagation();
    (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    const [x, y] = point(ev);
    drag.current = { kind, x, y, center, anchor: { lat: cur.lat, lon: cur.lon }, rot: cur.rotation };
  };
  const move = (ev: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [x, y] = point(ev);
    if (d.kind === "pan") {
      const px = lonToX(d.center.lon, z) - (x - d.x), py = latToY(d.center.lat, z) - (y - d.y);
      setCenter({ lat: yToLat(py, z), lon: xToLon(px, z) });
    } else if (d.kind === "move") {
      const [sx, sy] = toScreen(d.anchor.lat, d.anchor.lon);
      const p = fromScreen(sx + (x - d.x), sy + (y - d.y));
      setLive({ lat: p.lat, lon: p.lon, rotation: d.rot });
    } else {
      // Winkel der x-Achse: vom Anker zum Griff, gegen den Uhrzeigersinn aus Osten.
      const deg = (Math.atan2(-(y - ay), x - ax) * 180) / Math.PI;
      const snapped = ev.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg * 10) / 10;
      setLive({ lat: cur.lat, lon: cur.lon, rotation: snapped });
    }
  };
  const up = () => {
    drag.current = null;
    if (live) { onChange({ lat: round6(live.lat), lon: round6(live.lon), rotation: live.rotation }); setLive(null); }
  };
  const wheel = (ev: React.WheelEvent) => {
    ev.preventDefault();
    setZ((v) => Math.max(ZMIN, Math.min(ZMAX, v + (ev.deltaY < 0 ? 1 : -1))));
  };
  // React meldet wheel passiv; preventDefault braucht einen eigenen Hörer.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    // Koordinaten brauchen keinen fremden Dienst.
    const c = parseCoords(q);
    if (c) { goTo({ display_name: q, lat: String(c.lat), lon: String(c.lon) }); return; }
    setSearching(true); setSearchError(""); setHits(null);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=de&q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error(`Suche nicht erreichbar (${r.status})`);
      const list = (await r.json()) as Hit[];
      setHits(list);
      if (!list.length) setSearchError("Nichts gefunden.");
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally { setSearching(false); }
  };
  const goTo = (h: Hit) => {
    const p = { lat: Number(h.lat), lon: Number(h.lon) };
    setCenter(p); setZ(18); setHits(null);
    if (!placed) onChange({ lat: round6(p.lat), lon: round6(p.lon), rotation });
  };
  const bringHere = () => onChange({ lat: round6(center.lat), lon: round6(center.lon), rotation: cur.rotation });

  const scaleM = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 50000, 100000].find((m) => m / mPerPx >= 70) ?? 100000;

  return (
    <div className="map-placer">
      <div className="map-placer-bar">
        <InputGroup small leftIcon="search" placeholder="Adresse oder Koordinaten (51.7518, 11.9702)" value={query}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }}
          rightElement={<Button small minimal text="Suchen" loading={searching} onClick={search} />} />
        <ButtonGroup>
          <Button small icon="zoom-out" aria-label="Herauszoomen" onClick={() => setZ((v) => Math.max(ZMIN, v - 1))} />
          <Button small icon="zoom-in" aria-label="Hineinzoomen" onClick={() => setZ((v) => Math.min(ZMAX, v + 1))} />
          <Button small icon="locate" text="Zur Halle" disabled={!placed} onClick={() => { setCenter({ lat, lon }); setZ(18); }} />
          <Button small icon="map-marker" text="Halle hierher" title="Den Anker der Halle in die Mitte der Ansicht legen" onClick={bringHere} />
        </ButtonGroup>
        <MapStyleSwitch value={style} onChange={setStyle} />
      </div>
      {hits && hits.length > 0 && (
        <Menu className="map-placer-hits">
          {hits.map((h, i) => <MenuItem key={i} icon="map-marker" text={h.display_name} onClick={() => goTo(h)} />)}
        </Menu>
      )}
      {searchError && <p className="site-map-note">{searchError}</p>}
      <div className="map-placer-stage">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="application" aria-label="Halle auf der Karte platzieren"
          onPointerDown={down("pan")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}>
          {tiles.map((t) => <image key={t.key} href={t.url} x={t.x} y={t.y} width={TILE} height={TILE} />)}
          {neighbours.map((o) => (
            <g key={o.id} className="map-placer-other" pointerEvents="none">
              {o.pts && <polygon points={o.pts} />}
              <text x={o.ox + 6} y={o.oy - 6}>{o.name}</text>
            </g>
          ))}
          {placed || live ? (<>
            {poly && <polygon className="map-placer-hall" points={poly} onPointerDown={down("move")} />}
            <line x1={ax} y1={ay} x2={hx} y2={hy} className="map-placer-axis" />
            <circle cx={ax} cy={ay} r={5} className="map-placer-anchor" onPointerDown={down("move")} />
            <circle cx={hx} cy={hy} r={9} className="map-placer-rotate" onPointerDown={down("rotate")}>
              <title>Ziehen dreht die Halle (Umschalt: 15°-Schritte)</title>
            </circle>
          </>) : null}
        </svg>
        <div className="map-placer-scale"><span style={{ width: scaleM / mPerPx }} />{scaleM >= 1000 ? `${scaleM / 1000} km` : `${scaleM} m`}</div>
        <span className="three-map-attribution">{mapAttribution(style)}</span>
      </div>
      <div className="map-placer-foot">
        {placed || live
          ? <><Tag minimal>{cur.lat.toFixed(6)}, {cur.lon.toFixed(6)}</Tag><Tag minimal>{cur.rotation.toFixed(1)}°</Tag>
            <Tag minimal intent={saving ? "warning" : "success"} icon={saving ? "refresh" : "tick"}>{saving ? "speichert …" : "gespeichert"}</Tag>
            {canUndo && <Button small minimal icon="undo" text="Rückgängig" onClick={onUndo} />}
            <span className="site-map-note">Umriss ziehen verschiebt · grüner Griff dreht · Karte ziehen und Rad bewegen die Ansicht.</span></>
          : <span className="site-map-note">Noch kein Anker: Adresse suchen oder die Karte zur Halle ziehen, dann „Halle hierher“.</span>}
      </div>
    </div>
  );
}
