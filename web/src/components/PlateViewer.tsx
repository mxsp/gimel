import { Button, Checkbox, Spinner } from "@blueprintjs/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../api";

/* Platten-Viewer — die Zeichnung aus /api/production/…/plate/N.svg, aber
   beweglich: Ziehen zum Verschieben, Rad und Tasten zum Zoomen, Ebenen
   einzeln schaltbar, Farbe je Auftrag, Maßstabsbalken und Minimap.

   Reine ViewBox-Arithmetik wie in der alten Subapp — kein Zeichen-Framework.
   Die Ebenen greifen an den data-layer-Marken, die render/plate.py setzt;
   die Farbmodus-Umschaltung an .alpha-kontur innerhalb einer .plate-part.  */

const LAYERS = [
  ["kontur", "Kontur"],
  ["loch", "Bohrung"],
  ["marke", "Marke"],
  ["platte", "Platte"],
  ["info", "Info"],
] as const;

type LayerKey = (typeof LAYERS)[number][0];
type LayerState = Record<LayerKey, boolean>;

const LAYER_KEY = "gimel.viewer.layers";
const COLOR_KEY = "gimel.viewer.colormode";

const ALL_ON: LayerState = { kontur: true, loch: true, marke: true, platte: true, info: true };

function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStore(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Privatmodus */ }
}

/** Stabile Farbe je Auftragsnummer — gleiche Nummer, gleiche Farbe, immer. */
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

interface ViewBox { x: number; y: number; w: number; h: number; }

export interface PlateViewerProps {
  /** Pfad zur SVG-Zeichnung, z. B. /api/production/work-orders/IA-26-1/plate/0.svg */
  src: string;
  /** Marke, die hervorgehoben werden soll (Klick in der Markentabelle). */
  highlightTag?: string;
  /** Meldet die angeklickte Marke nach oben. */
  onPickTag?: (tag: string, orderNo: string) => void;
  height?: number;
}

export default function PlateViewer({ src, highlightTag, onPickTag, height = 460 }: PlateViewerProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const miniRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const homeRef = useRef<ViewBox | null>(null);
  const vbRef = useRef<ViewBox | null>(null);

  const [markup, setMarkup] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [layers, setLayers] = useState<LayerState>(() => readStore(LAYER_KEY, ALL_ON));
  const [colorMode, setColorMode] = useState<boolean>(() => readStore(COLOR_KEY, false));
  const [zoomLabel, setZoomLabel] = useState("—");
  const [scaleText, setScaleText] = useState("");
  const [scaleWidth, setScaleWidth] = useState(0);

  // --- Zeichnung holen. Der Endpunkt verlangt den Token, deshalb fetch
  //     statt <img src>: ein img trägt keinen Authorization-Kopf.
  useEffect(() => {
    let dead = false;
    setMarkup(null); setError("");
    fetch(src, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Zeichnung nicht ladbar (${r.status})`))))
      .then((t) => { if (!dead) setMarkup(t); })
      .catch((e) => { if (!dead) setError(e.message); });
    return () => { dead = true; };
  }, [src]);

  const applyViewBox = useCallback((vb: ViewBox) => {
    const svg = svgRef.current, home = homeRef.current;
    if (!svg || !home) return;
    vbRef.current = vb;
    svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    const factor = home.w / vb.w;
    setZoomLabel(`${Math.round(factor * 100)} %`);
    // Maßstabsbalken: eine runde Millimeterzahl, die auf ~120 px passt.
    const box = boxRef.current;
    if (box) {
      const pxPerMm = box.clientWidth / vb.w;
      const rough = 120 / pxPerMm;
      const pow = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
      const nice = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= rough) ?? pow * 10;
      setScaleWidth(nice * pxPerMm);
      setScaleText(nice >= 1000 ? `${nice / 1000} m` : `${nice} mm`);
    }
    // Minimap-Rahmen nachziehen
    const frame = miniRef.current?.querySelector<SVGRectElement>("[data-frame]");
    if (frame) {
      frame.setAttribute("x", String(vb.x)); frame.setAttribute("y", String(vb.y));
      frame.setAttribute("width", String(vb.w)); frame.setAttribute("height", String(vb.h));
    }
  }, []);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const vb = vbRef.current, home = homeRef.current;
    if (!vb || !home) return;
    // 20 % bis 4000 % — darunter verliert man die Platte, darüber das Teil.
    const next = Math.min(Math.max(home.w / (vb.w / factor), 0.2), 40);
    const w = home.w / next, h = home.h / next;
    const ax = cx ?? vb.x + vb.w / 2, ay = cy ?? vb.y + vb.h / 2;
    applyViewBox({
      x: ax - (ax - vb.x) * (w / vb.w),
      y: ay - (ay - vb.y) * (h / vb.h),
      w, h,
    });
  }, [applyViewBox]);

  const fit = useCallback(() => { if (homeRef.current) applyViewBox({ ...homeRef.current }); }, [applyViewBox]);

  // --- SVG einhängen, Ausgangs-ViewBox merken, Minimap bauen
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !markup) return;
    box.innerHTML = markup;
    const svg = box.querySelector("svg");
    if (!svg) return;
    svgRef.current = svg as SVGSVGElement;
    svg.removeAttribute("width"); svg.removeAttribute("height");
    svg.setAttribute("style", "width:100%;height:100%;display:block;cursor:grab;touch-action:none");
    const raw = (svg.getAttribute("viewBox") || "0 0 1000 1000").split(/[\s,]+/).map(Number);
    const home: ViewBox = { x: raw[0], y: raw[1], w: raw[2], h: raw[3] };
    homeRef.current = home;

    // Minimap: dieselbe Zeichnung klein, plus ein Rahmen fürs Sichtfeld.
    const mini = miniRef.current;
    if (mini) {
      mini.innerHTML = "";
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.removeAttribute("style");
      clone.setAttribute("viewBox", `${home.x} ${home.y} ${home.w} ${home.h}`);
      clone.setAttribute("style", "width:100%;height:100%;display:block");
      const frame = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      frame.setAttribute("data-frame", "1");
      frame.setAttribute("fill", "rgba(205,66,70,0.10)");
      frame.setAttribute("stroke", "#cd4246");
      frame.setAttribute("stroke-width", String(home.w / 220));
      clone.appendChild(frame);
      mini.appendChild(clone);
    }
    applyViewBox({ ...home });
  }, [markup, applyViewBox]);

  // --- Ebenen schalten
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.querySelectorAll<SVGElement>("[data-layer]").forEach((el) => {
      const key = el.getAttribute("data-layer") as LayerKey;
      el.style.display = layers[key] === false ? "none" : "";
    });
    writeStore(LAYER_KEY, layers);
  }, [layers, markup]);

  // --- Farbe je Auftrag
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.querySelectorAll<SVGGElement>(".plate-part").forEach((g) => {
      const order = g.getAttribute("data-order") || "";
      const hue = hashHue(order);
      const stroke = order ? `hsl(${hue} 70% 38%)` : "";
      const tint = order ? `hsl(${hue} 70% 96%)` : "";
      g.querySelectorAll<SVGElement>(".alpha-kontur, .alpha-loch").forEach((el) => {
        if (!el.dataset.origStroke) el.dataset.origStroke = el.getAttribute("stroke") || "";
        if (!el.dataset.origFill) el.dataset.origFill = el.getAttribute("fill") || "";
        if (colorMode && order) {
          el.setAttribute("stroke", stroke);
          const f = el.dataset.origFill;
          if (f && f !== "none" && f !== "#ffffff") el.setAttribute("fill", tint);
        } else {
          if (el.dataset.origStroke) el.setAttribute("stroke", el.dataset.origStroke);
          if (el.dataset.origFill) el.setAttribute("fill", el.dataset.origFill);
        }
      });
      const tag = g.querySelector<SVGTextElement>(".plate-part-tag");
      if (tag) {
        if (!tag.dataset.origFill) tag.dataset.origFill = tag.getAttribute("fill") || "";
        tag.setAttribute("fill", colorMode && order ? stroke : (tag.dataset.origFill || ""));
      }
    });
    writeStore(COLOR_KEY, colorMode);
  }, [colorMode, markup]);

  // --- Markierung aus der Markentabelle
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.querySelectorAll<SVGGElement>(".plate-part").forEach((g) => {
      const on = !!highlightTag && g.getAttribute("data-tag") === highlightTag;
      g.style.opacity = highlightTag && !on ? "0.25" : "1";
      g.style.filter = on ? "drop-shadow(0 0 6px #cd4246)" : "";
    });
  }, [highlightTag, markup]);

  // --- Ziehen, Rad, Klick, Tastatur
  useEffect(() => {
    const svg = svgRef.current, box = boxRef.current;
    if (!svg || !box) return;

    let panning = false, sx = 0, sy = 0, start: ViewBox | null = null;

    const toUser = (clientX: number, clientY: number) => {
      const vb = vbRef.current!, r = box.getBoundingClientRect();
      return {
        x: vb.x + ((clientX - r.left) / r.width) * vb.w,
        y: vb.y + ((clientY - r.top) / r.height) * vb.h,
      };
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      panning = true; sx = e.clientX; sy = e.clientY; start = { ...vbRef.current! };
      svg.style.cursor = "grabbing"; e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
      if (!panning || !start) return;
      const r = box.getBoundingClientRect();
      applyViewBox({
        ...start,
        x: start.x - ((e.clientX - sx) / r.width) * start.w,
        y: start.y - ((e.clientY - sy) / r.height) * start.h,
      });
    };
    const onUp = () => { panning = false; svg.style.cursor = "grab"; };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toUser(e.clientX, e.clientY);
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    };
    const onClick = (e: MouseEvent) => {
      const g = (e.target as Element).closest?.(".plate-part");
      if (g && onPickTag) onPickTag(g.getAttribute("data-tag") || "", g.getAttribute("data-order") || "");
    };
    const onKey = (e: KeyboardEvent) => {
      const vb = vbRef.current;
      if (!vb) return;
      const step = vb.w / 12;
      const moves: Record<string, () => void> = {
        "+": () => zoomAt(1.2), "=": () => zoomAt(1.2),
        "-": () => zoomAt(1 / 1.2), "_": () => zoomAt(1 / 1.2),
        f: fit, F: fit,
        "0": () => { const h = homeRef.current!; applyViewBox({ ...vb, w: h.w, h: h.h }); },
        ArrowLeft: () => applyViewBox({ ...vb, x: vb.x - step }),
        ArrowRight: () => applyViewBox({ ...vb, x: vb.x + step }),
        ArrowUp: () => applyViewBox({ ...vb, y: vb.y - step }),
        ArrowDown: () => applyViewBox({ ...vb, y: vb.y + step }),
      };
      const fn = moves[e.key];
      if (fn) { e.preventDefault(); fn(); }
    };

    svg.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("click", onClick);
    box.addEventListener("keydown", onKey);
    return () => {
      svg.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("click", onClick);
      box.removeEventListener("keydown", onKey);
    };
  }, [markup, applyViewBox, zoomAt, fit, onPickTag]);

  if (error) return <div className="viewer-error">{error}</div>;
  if (!markup) return <div style={{ padding: 30 }}><Spinner size={26} /></div>;

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <Button small icon="zoom-out" title="Verkleinern (−)" onClick={() => zoomAt(1 / 1.2)} />
        <Button small icon="zoom-in" title="Vergrößern (+), auch Mausrad" onClick={() => zoomAt(1.2)} />
        <Button small icon="zoom-to-fit" text="Fit" title="Einpassen (F)" onClick={fit} />
        <span className="mono viewer-zoom-label">{zoomLabel}</span>
        <span className="viewer-sep" />
        {LAYERS.map(([key, label]) => (
          <Checkbox key={key} inline className="viewer-chip" checked={layers[key] !== false} label={label}
                    onChange={(e) => {
                      // Den Wert vor dem Aktualisierer auslesen: React gibt das
                      // Ereignis danach frei, currentTarget ist dann null.
                      const on = e.currentTarget.checked;
                      setLayers((cur) => ({ ...cur, [key]: on }));
                    }} />
        ))}
        <span className="viewer-sep" />
        <Checkbox inline className="viewer-chip" checked={colorMode} label="Farbe je Auftrag"
                  onChange={(e) => setColorMode(e.currentTarget.checked)} />
        <span className="viewer-scale" title="Maßstab">
          <span className="viewer-scale-bar" style={{ width: Math.round(scaleWidth) }} />
          <span className="mono">{scaleText}</span>
        </span>
      </div>
      <div className="viewer-stage" style={{ height }}>
        <div ref={boxRef} className="viewer-box" tabIndex={0}
             aria-label="Plattenzeichnung — ziehen zum Verschieben, Mausrad zum Zoomen" />
        <div ref={miniRef} className="viewer-minimap" title="Übersicht — roter Rahmen zeigt das Sichtfeld" />
      </div>
      <p className="viewer-hint">
        Ziehen verschiebt · Mausrad zoomt · Tasten <span className="mono">+ − F 0</span> und Pfeiltasten ·
        Klick auf ein Teil wählt die Marke
      </p>
    </div>
  );
}
