import { useMemo, useState } from "react";
import {
  Button, ButtonGroup, Callout, Checkbox, Dialog, DialogBody, DialogFooter,
  FormGroup, HTMLSelect, Icon, InputGroup, NumericInput, Tag,
} from "@blueprintjs/core";
import { api } from "../api";
import { toastError, toastSuccess } from "../toast";
import {
  Aisles, BLANK_STATION, Door, EMPTY_FLOOR, Floor, MACHINE_PRESET, Obstacle,
  outlinePath, polygonArea, polygonPerimeter, Station, templateL, templateRect,
  templateU, TYPE_COLOUR, TYPE_DEFAULT_SIZE, Zone,
} from "../factory";
import type { HallInfo, SiteInfo, Topology } from "../sites";

export type HallShapeKind = "rect" | "l" | "u" | "t";
export type AislePresetKind = "spine" | "cross" | "loop" | "none";

export interface GeneratedHallPlan {
  name: string;
  height_m: number;
  grid: number;
  snap: number;
  outline: [number, number][];
  zones: Zone[];
  obstacles: Obstacle[];
  doors: Door[];
  aisles: Aisles;
  starterStations: Omit<Station, "id">[];
}

const SIZE_PRESETS: { label: string; sub: string; w: number; h: number; cutW: number; cutH: number }[] = [
  { label: "Kompakt", sub: "24 × 15 m (360 m²)", w: 24, h: 15, cutW: 8, cutH: 6 },
  { label: "Standard", sub: "40 × 24 m (960 m²)", w: 40, h: 24, cutW: 14, cutH: 9 },
  { label: "Großhalle", sub: "60 × 36 m (2.160 m²)", w: 60, h: 36, cutW: 20, cutH: 12 },
  { label: "Industriewerk", sub: "80 × 48 m (3.840 m²)", w: 80, h: 48, cutW: 26, cutH: 16 },
];

function templateT(w: number, h: number, wingW: number, stemDepth: number): [number, number][] {
  const ww = Math.max(2, Math.min(wingW, (w - 4) / 2));
  const sd = Math.max(2, Math.min(stemDepth, h - 4));
  const topH = h - sd;
  return [
    [0, 0],
    [w, 0],
    [w, topH],
    [w - ww, topH],
    [w - ww, h],
    [ww, h],
    [ww, topH],
    [0, topH],
  ];
}

function rotateLOutline(
  pts: [number, number][],
  w: number,
  h: number,
  corner: "se" | "sw" | "nw" | "ne",
): [number, number][] {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (corner === "se") return pts;
  if (corner === "sw") return pts.map(([x, y]) => [r2(w - x), y] as [number, number]).reverse();
  if (corner === "ne") return pts.map(([x, y]) => [x, r2(h - y)] as [number, number]).reverse();
  return pts.map(([x, y]) => [r2(w - x), r2(h - y)] as [number, number]);
}

function buildAisleNetwork(
  kind: AislePresetKind,
  w: number,
  h: number,
  shape: HallShapeKind,
  cutH: number,
): Aisles {
  if (kind === "none") return { nodes: [], edges: [] };
  const r2 = (n: number) => Math.round(n * 4) / 4;
  const mainY = shape === "l" || shape === "u" || shape === "t"
    ? r2(Math.max(3, (h - Math.min(cutH, h * 0.5)) / 2))
    : r2(h / 2);
  const xStart = r2(Math.min(3, w * 0.1));
  const xEnd = r2(Math.max(w - 3, w * 0.9));

  if (kind === "spine") {
    const steps = Math.max(3, Math.min(8, Math.round((xEnd - xStart) / 8)));
    const nodes: [number, number][] = [];
    const edges: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const x = r2(xStart + ((xEnd - xStart) * i) / steps);
      nodes.push([x, mainY]);
      if (i > 0) edges.push([i - 1, i]);
    }
    return { nodes, edges };
  }

  if (kind === "cross") {
    const midX = r2(w / 2);
    const yTop = r2(Math.min(3, h * 0.15));
    const yBot = r2(shape === "u" ? mainY : Math.max(h - 3, h * 0.85));
    const xQ1 = r2(xStart + (midX - xStart) * 0.5);
    const xQ3 = r2(midX + (xEnd - midX) * 0.5);
    const nodes: [number, number][] = [
      [xStart, mainY],
      [xQ1, mainY],
      [midX, mainY],
      [xQ3, mainY],
      [xEnd, mainY],
      [midX, yTop],
      [midX, yBot],
    ];
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 4],
      [5, 2], [2, 6],
    ];
    return { nodes, edges };
  }

  // loop
  const padX = r2(Math.max(3.5, Math.min(6, w * 0.14)));
  const padY = r2(Math.max(3, Math.min(5, h * 0.18)));
  const yLow = shape === "rect" ? r2(h - padY) : mainY;
  const xMid = r2(w / 2);
  const nodes: [number, number][] = [
    [padX, padY],
    [xMid, padY],
    [r2(w - padX), padY],
    [r2(w - padX), yLow],
    [xMid, yLow],
    [padX, yLow],
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 4],
  ];
  return { nodes, edges };
}

export function generateHallPlan(opts: {
  name: string;
  heightM: number;
  shape: HallShapeKind;
  w: number;
  h: number;
  cutW: number;
  cutH: number;
  lCorner: "se" | "sw" | "nw" | "ne";
  aisleKind: AislePresetKind;
  withDoors: boolean;
  withZones: boolean;
  withColumns: boolean;
  withStarterStations: boolean;
}): GeneratedHallPlan {
  const w = Math.max(8, Math.round(opts.w * 2) / 2);
  const h = Math.max(6, Math.round(opts.h * 2) / 2);
  const cw = Math.max(2, Math.min(Math.round(opts.cutW * 2) / 2, w - 4));
  const ch = Math.max(2, Math.min(Math.round(opts.cutH * 2) / 2, h - 3));
  const r2 = (n: number) => Math.round(n * 4) / 4;

  let outline: [number, number][];
  if (opts.shape === "l") {
    outline = rotateLOutline(templateL(w, h, cw, ch), w, h, opts.lCorner);
  } else if (opts.shape === "u") {
    outline = templateU(w, h, cw, ch);
  } else if (opts.shape === "t") {
    outline = templateT(w, h, cw, ch);
  } else {
    outline = templateRect(w, h);
  }

  const aisles = buildAisleNetwork(opts.aisleKind, w, h, opts.shape, ch);
  const mainY = opts.shape === "rect" ? r2(h / 2) : r2(Math.max(3, (h - ch) / 2));

  const doors: Door[] = [];
  if (opts.withDoors) {
    doors.push(
      { name: "Wareneingang", x: 0, y: mainY, width: 4.0, kind: "gate" },
      { name: "Versandtor", x: w, y: mainY, width: 4.0, kind: "gate" },
      { name: "Personentür", x: r2(w * 0.25), y: 0, width: 1.25, kind: "door" },
    );
  }

  const zones: Zone[] = [];
  const topBandH = r2(Math.max(3, mainY - 2));
  const botBandY = r2(mainY + 2);
  const botBandH = r2(Math.max(2.5, (opts.shape === "rect" ? h : h - ch) - botBandY - 0.75));
  if (opts.withZones && topBandH >= 2.5) {
    const x1 = r2(w * 0.26);
    const x2 = r2(w * 0.72);
    zones.push(
      {
        name: "Rohplattenlager",
        kind: "storage",
        colour: "#2b7a78",
        points: [[0.75, 0.75], [x1 - 0.5, 0.75], [x1 - 0.5, topBandH], [0.75, topBandH]],
      },
      {
        name: "Zuschnitt & Fertigung",
        kind: "production",
        colour: "#3b6ea5",
        points: [[x1 + 0.5, 0.75], [x2 - 0.5, 0.75], [x2 - 0.5, topBandH], [x1 + 0.5, topBandH]],
      },
      {
        name: "Versand & Bereitstellung",
        kind: "shipping",
        colour: "#7b5ea7",
        points: [[x2 + 0.5, 0.75], [w - 0.75, 0.75], [w - 0.75, topBandH], [x2 + 0.5, topBandH]],
      },
    );
    if (botBandH >= 2.5) {
      zones.push({
        name: "Kommissionierung & Nacharbeit",
        kind: "quality",
        colour: "#b07d3b",
        points: [[x1 + 0.5, botBandY], [x2 - 0.5, botBandY], [x2 - 0.5, botBandY + botBandH], [x1 + 0.5, botBandY + botBandH]],
      });
    }
  }

  const obstacles: Obstacle[] = [];
  if (opts.withColumns && w >= 24 && h >= 14) {
    const spanX = w >= 50 ? 12 : 10;
    const colY = r2(mainY - 2.2);
    let idx = 1;
    for (let cx = spanX; cx <= w - spanX + 0.1; cx += spanX) {
      const s = 0.25;
      obstacles.push({
        name: `Stütze ${idx++}`,
        kind: "column",
        height_m: opts.heightM,
        points: [
          [r2(cx - s), r2(colY - s)],
          [r2(cx + s), r2(colY - s)],
          [r2(cx + s), r2(colY + s)],
          [r2(cx - s), r2(colY + s)],
        ],
      });
    }
  }

  const starterStations: Omit<Station, "id">[] = [];
  if (opts.withStarterStations) {
    const rowTopY = r2(Math.max(2.5, topBandH / 2 + 0.4));
    const rowBotY = r2(Math.min(h - 2.5, mainY + Math.max(3.2, botBandH / 2 + 1.5)));
    const mk = (
      type: Station["type"],
      label: string,
      subtype: string,
      x: number,
      y: number,
      extra?: Partial<Station>,
    ): Omit<Station, "id"> => {
      const sz = TYPE_DEFAULT_SIZE[type];
      return {
        ...BLANK_STATION,
        type,
        label,
        subtype,
        colour: TYPE_COLOUR[type],
        x: r2(x),
        y: r2(y),
        w: sz.w,
        h: sz.h,
        is_storage: type === "warehouse",
        ...(type === "production" ? { ...MACHINE_PRESET.plotter, machine_kind: "plotter" } : { task_min: 3, unit_min: 1.5, capacity_min_per_day: 480 }),
        ...extra,
      };
    };
    starterStations.push(
      mk("warehouse", "Plattenlager 1", "lager_1", Math.max(3.5, w * 0.13), rowTopY),
      mk("production", "Plotter 1", "plotter_1", w * 0.38, rowTopY),
      mk("production", "Wasserstrahl 1", "waterjet_1", w * 0.58, rowTopY, {
        ...MACHINE_PRESET.waterjet,
        machine_kind: "waterjet",
      }),
      mk("shipping", "Versand 1", "versand_1", Math.min(w - 3.5, w * 0.85), rowTopY),
    );
    if (opts.shape === "rect" || rowBotY + 2 <= h - ch) {
      starterStations.push(
        mk("accounting", "Auftragsbüro", "buero_1", Math.max(3.5, w * 0.15), rowBotY),
      );
    }
  }

  return {
    name: opts.name.trim() || "Halle 1",
    height_m: opts.heightM,
    grid: w >= 60 ? 2 : 1,
    snap: 0.25,
    outline,
    zones,
    obstacles,
    doors,
    aisles,
    starterStations,
  };
}

export default function HallCreatorDialog({
  isOpen,
  onClose,
  topo,
  currentFloor,
  onApplied,
  onOpenDraftInEditor,
}: {
  isOpen: boolean;
  onClose: () => void;
  topo: Topology | null;
  currentFloor: Floor | null;
  /** Called after saving the created/updated hall to the backend. */
  onApplied: (savedFloor: Floor, createdNewHall: boolean) => void;
  /** Optional: load the generated plan directly into the 2D editor as an unsaved draft. */
  onOpenDraftInEditor?: (plan: GeneratedHallPlan) => void;
}) {
  const hasExistingHall = (topo?.sites?.some((s) => s.halls.length > 0) || (topo?.unsited_halls?.length ?? 0) > 0) ?? false;
  const [createMode, setCreateMode] = useState<"current" | "new_hall">(hasExistingHall ? "current" : "new_hall");
  const [siteName, setSiteName] = useState("Hauptwerk");
  const [hallName, setHallName] = useState(currentFloor?.name && currentFloor.name !== "Halle" ? currentFloor.name : "Halle 1");
  const [heightM, setHeightM] = useState(currentFloor?.height_m || 6);
  const [shape, setShape] = useState<HallShapeKind>("rect");
  const [w, setW] = useState(40);
  const [h, setH] = useState(24);
  const [cutW, setCutW] = useState(14);
  const [cutH, setCutH] = useState(9);
  const [lCorner, setLCorner] = useState<"se" | "sw" | "nw" | "ne">("se");
  const [aisleKind, setAisleKind] = useState<AislePresetKind>("spine");
  const [withDoors, setWithDoors] = useState(true);
  const [withZones, setWithZones] = useState(true);
  const [withColumns, setWithColumns] = useState(false);
  const [withStarterStations, setWithStarterStations] = useState(false);
  const [busy, setBusy] = useState(false);

  const plan = useMemo(
    () =>
      generateHallPlan({
        name: hallName,
        heightM,
        shape,
        w,
        h,
        cutW,
        cutH,
        lCorner,
        aisleKind,
        withDoors,
        withZones,
        withColumns,
        withStarterStations,
      }),
    [hallName, heightM, shape, w, h, cutW, cutH, lCorner, aisleKind, withDoors, withZones, withColumns, withStarterStations],
  );

  const area = useMemo(() => polygonArea(plan.outline), [plan.outline]);
  const perim = useMemo(() => polygonPerimeter(plan.outline), [plan.outline]);

  const applyPresetSize = (p: (typeof SIZE_PRESETS)[number]) => {
    setW(p.w);
    setH(p.h);
    setCutW(p.cutW);
    setCutH(p.cutH);
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      let targetFloorId = currentFloor?.id && currentFloor.id > 0 ? currentFloor.id : null;
      let targetHallId = currentFloor?.hall_id ?? null;
      let createdNew = false;

      if (createMode === "new_hall" || !hasExistingHall || !targetFloorId) {
        createdNew = true;
        let siteId = topo?.default_site_id ?? topo?.sites?.[0]?.id ?? null;
        if (!siteId) {
          const createdSite = await api<SiteInfo>("/api/factory/sites", {
            method: "POST",
            body: JSON.stringify({ name: siteName.trim() || "Hauptwerk" }),
          });
          siteId = createdSite.id;
        }
        const createdHall = await api<HallInfo>("/api/factory/halls", {
          method: "POST",
          body: JSON.stringify({
            site_id: siteId,
            name: plan.name,
          }),
        });
        targetHallId = createdHall.id;
        const ground = createdHall.floors?.find((f) => f.level === 0) ?? createdHall.floors?.[0];
        if (ground?.id) {
          targetFloorId = ground.id;
        }
      }

      const q = targetFloorId ? `?floor_id=${targetFloorId}` : "";
      const body = {
        name: plan.name,
        outline: plan.outline,
        zones: plan.zones,
        obstacles: plan.obstacles,
        doors: plan.doors,
        aisles: plan.aisles,
        scale: 40,
        grid: plan.grid,
        snap: plan.snap,
        bg: "#f5f5f0",
        hall_id: targetHallId,
        level: currentFloor?.level ?? 0,
        level_name: currentFloor?.level_name || "EG",
        elevation_m: currentFloor?.elevation_m ?? 0,
        height_m: plan.height_m,
      };
      const saved = await api<Floor>(`/api/factory/floor${q}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });

      if (plan.starterStations.length > 0) {
        for (const st of plan.starterStations) {
          await api<Station>("/api/factory/stations", {
            method: "POST",
            body: JSON.stringify({ ...st, floor_id: saved.id || targetFloorId }),
          });
        }
      }

      const merged: Floor = { ...EMPTY_FLOOR, ...saved, aisles: saved.aisles ?? { nodes: [], edges: [] } };
      toastSuccess(
        `${plan.name} angelegt (${Math.round(area).toLocaleString("de-DE")} m²${plan.starterStations.length ? `, ${plan.starterStations.length} Stationen` : ""}).`,
      );
      onApplied(merged, createdNew);
      onClose();
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pad = Math.max(3, Math.max(w, h) * 0.08);
  const vb = `${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={() => !busy && onClose()}
      title="Hallen-Assistent — Halle & Grundriss erstellen"
      icon="office"
      style={{ width: 920, maxWidth: "calc(100vw - 24px)" }}
    >
      <DialogBody>
        <div style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 18, alignItems: "start" }}>
          {/* LEFT: CONFIGURATION */}
          <div style={{ display: "grid", gap: 12 }}>
            {hasExistingHall && (
              <FormGroup label="Ziel">
                <ButtonGroup fill>
                  <Button
                    active={createMode === "current"}
                    icon="edit"
                    text={`Aktuelle Ebene (${currentFloor?.name || "EG"}) einrichten`}
                    onClick={() => setCreateMode("current")}
                  />
                  <Button
                    active={createMode === "new_hall"}
                    icon="add"
                    text="Als neue Halle anlegen"
                    onClick={() => setCreateMode("new_hall")}
                  />
                </ButtonGroup>
              </FormGroup>
            )}

            <div style={{ display: "grid", gridTemplateColumns: (!hasExistingHall || createMode === "new_hall") && !topo?.sites?.length ? "1fr 1fr 110px" : "1fr 110px", gap: 10 }}>
              {(!hasExistingHall || createMode === "new_hall") && !topo?.sites?.length && (
                <FormGroup label="Standort / Werk">
                  <InputGroup value={siteName} onChange={(e) => setSiteName(e.currentTarget.value)} placeholder="z. B. Hauptwerk" />
                </FormGroup>
              )}
              <FormGroup label="Name der Halle">
                <InputGroup value={hallName} onChange={(e) => setHallName(e.currentTarget.value)} placeholder="z. B. Halle 1 — Zuschnitt" />
              </FormGroup>
              <FormGroup label="Höhe (m)">
                <NumericInput fill value={heightM} min={2.5} max={40} stepSize={0.5} onValueChange={(v) => Number.isFinite(v) && setHeightM(Math.max(2.5, v))} />
              </FormGroup>
            </div>

            <FormGroup label="1. Grundform & Schnellgrößen">
              <ButtonGroup fill style={{ marginBottom: 8 }}>
                <Button active={shape === "rect"} icon="widget" text="Rechteck" onClick={() => setShape("rect")} />
                <Button active={shape === "l"} icon="key-tab" text="L-Halle" onClick={() => setShape("l")} />
                <Button active={shape === "u"} icon="widget-header" text="U-Halle" onClick={() => setShape("u")} />
                <Button active={shape === "t"} icon="align-center" text="T-Halle" onClick={() => setShape("t")} />
              </ButtonGroup>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {SIZE_PRESETS.map((p) => (
                  <Button
                    key={p.label}
                    small
                    minimal={!(w === p.w && h === p.h)}
                    intent={w === p.w && h === p.h ? "primary" : "none"}
                    text={`${p.label} (${p.w}×${p.h} m)`}
                    title={p.sub}
                    onClick={() => applyPresetSize(p)}
                  />
                ))}
              </div>
            </FormGroup>

            <div style={{ display: "grid", gridTemplateColumns: shape === "rect" ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 8 }}>
              <FormGroup label="Länge / Breite X (m)">
                <NumericInput fill value={w} min={8} max={400} stepSize={2} onValueChange={(v) => Number.isFinite(v) && setW(Math.max(8, v))} />
              </FormGroup>
              <FormGroup label="Tiefe Y (m)">
                <NumericInput fill value={h} min={6} max={400} stepSize={2} onValueChange={(v) => Number.isFinite(v) && setH(Math.max(6, v))} />
              </FormGroup>
              {shape !== "rect" && (
                <>
                  <FormGroup label="Ausschnitt X (m)">
                    <NumericInput fill value={cutW} min={2} max={w - 4} stepSize={1} onValueChange={(v) => Number.isFinite(v) && setCutW(Math.max(2, v))} />
                  </FormGroup>
                  <FormGroup label="Ausschnitt Y (m)">
                    <NumericInput fill value={cutH} min={2} max={h - 3} stepSize={1} onValueChange={(v) => Number.isFinite(v) && setCutH(Math.max(2, v))} />
                  </FormGroup>
                </>
              )}
            </div>

            {shape === "l" && (
              <FormGroup label="Lage des L-Ausschnitts">
                <ButtonGroup>
                  {([
                    ["se", "Südost (rechts unten)"],
                    ["sw", "Südwest (links unten)"],
                    ["ne", "Nordost (rechts oben)"],
                    ["nw", "Nordwest (links oben)"],
                  ] as const).map(([id, label]) => (
                    <Button key={id} small active={lCorner === id} text={label} onClick={() => setLCorner(id)} />
                  ))}
                </ButtonGroup>
              </FormGroup>
            )}

            <FormGroup label="2. Transport- & Gangnetz (für Wegberechnung & FTS)">
              <HTMLSelect fill value={aisleKind} onChange={(e) => setAisleKind(e.currentTarget.value as AislePresetKind)}>
                <option value="spine">Hauptgang (Längsachse durch die Halle — empfohlen)</option>
                <option value="cross">Kreuzgang (Hauptgang + Quergang)</option>
                <option value="loop">Ringgang (Umlaufender Hallenrundgang)</option>
                <option value="none">Kein Gangnetz (später von Hand zeichnen)</option>
              </HTMLSelect>
            </FormGroup>

            <FormGroup label="3. Hallenausstattung automatisch einfügen">
              <div style={{ display: "grid", gap: 6 }}>
                <Checkbox
                  checked={withDoors}
                  onChange={(e) => setWithDoors((e.target as HTMLInputElement).checked)}
                  label="Rolltore & Zugänge (Wareneingang West, Versandtor Ost, Personentür)"
                />
                <Checkbox
                  checked={withZones}
                  onChange={(e) => setWithZones((e.target as HTMLInputElement).checked)}
                  label="Funktionszonen (Rohplattenlager, Zuschnitt & Fertigung, Kommissionierung, Versand)"
                />
                <Checkbox
                  checked={withColumns}
                  onChange={(e) => setWithColumns((e.target as HTMLInputElement).checked)}
                  label="Stützenraster entlang des Hauptgangs"
                />
                <Checkbox
                  checked={withStarterStations}
                  onChange={(e) => setWithStarterStations((e.target as HTMLInputElement).checked)}
                  label="Start-Stationen anlegen (Plattenlager, Plotter, Wasserstrahl, Versand, Büro)"
                />
              </div>
            </FormGroup>
          </div>

          {/* RIGHT: LIVE SVG BLUEPRINT PREVIEW */}
          <div style={{ display: "grid", gap: 10 }}>
            <div
              style={{
                background: "var(--g-floor-outside, #11161d)",
                border: "1px solid var(--g-line, #2a333f)",
                borderRadius: 12,
                padding: 12,
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>Live-Vorschau · {plan.name}</strong>
                <div style={{ display: "flex", gap: 6 }}>
                  <Tag minimal intent="primary">{Math.round(area).toLocaleString("de-DE")} m²</Tag>
                  <Tag minimal>{Math.round(perim).toLocaleString("de-DE")} m Umfang</Tag>
                  <Tag minimal>{plan.height_m} m Höhe</Tag>
                </div>
              </div>

              <svg
                viewBox={vb}
                style={{ width: "100%", height: 290, borderRadius: 8, background: "rgba(0,0,0,0.22)" }}
                aria-label="Hallenvorschau"
              >
                {/* Outline */}
                <path
                  d={outlinePath(plan.outline)}
                  fill="var(--g-floor-hall, #1b222c)"
                  stroke="var(--gimel-accent, #2dd4b4)"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />

                {/* Zones */}
                {plan.zones.map((z, i) => (
                  <g key={`z-${i}`}>
                    <path
                      d={outlinePath(z.points)}
                      fill={z.colour}
                      fillOpacity={0.22}
                      stroke={z.colour}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                ))}

                {/* Aisles */}
                {plan.aisles.edges.map(([i, j], k) => {
                  const a = plan.aisles.nodes[i], b = plan.aisles.nodes[j];
                  if (!a || !b) return null;
                  return (
                    <line
                      key={`e-${k}`}
                      x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                      stroke="#f59e0b"
                      strokeWidth={2.5}
                      strokeDasharray="4 3"
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}

                {/* Obstacles / Columns */}
                {plan.obstacles.map((o, i) => (
                  <path
                    key={`o-${i}`}
                    d={outlinePath(o.points)}
                    fill="#94a3b8"
                    stroke="#cbd5e1"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}

                {/* Starter stations */}
                {plan.starterStations.map((s, i) => (
                  <g key={`s-${i}`} transform={`translate(${s.x} ${s.y})`}>
                    <rect
                      x={-s.w / 2} y={-s.h / 2} width={s.w} height={s.h}
                      rx={0.25}
                      fill={s.colour}
                      fillOpacity={0.85}
                      stroke="#fff"
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                ))}

                {/* Doors */}
                {plan.doors.map((d, i) => (
                  <circle
                    key={`d-${i}`}
                    cx={d.x} cy={d.y}
                    r={Math.max(0.7, Math.max(w, h) * 0.018)}
                    fill="#22c55e"
                    stroke="#0f172a"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}

                {/* Dimension labels */}
                <text
                  x={w / 2}
                  y={-pad * 0.32}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize={Math.max(1.2, Math.max(w, h) * 0.038)}
                >
                  {w} m
                </text>
                <text
                  x={-pad * 0.35}
                  y={h / 2}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize={Math.max(1.2, Math.max(w, h) * 0.038)}
                  transform={`rotate(-90 ${-pad * 0.35} ${h / 2})`}
                >
                  {h} m
                </text>
              </svg>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11.5, color: "var(--g-text-2, #94a3b8)" }}>
                <span><Icon icon="polygon-filter" size={11} /> {plan.outline.length} Eckpunkte</span>
                <span><Icon icon="layout-grid" size={11} /> {plan.zones.length} Zonen</span>
                <span><Icon icon="route" size={11} /> {plan.aisles.edges.length} Gangabschnitte</span>
                <span><Icon icon="log-in" size={11} /> {plan.doors.length} Tore/Türen</span>
                {plan.starterStations.length > 0 && <span><Icon icon="cube" size={11} /> {plan.starterStations.length} Stationen</span>}
              </div>
            </div>

            <Callout compact intent="primary" icon="info-sign">
              Nach dem Anlegen können Sie alle Eckpunkte, Wände, Zonen, Gänge und Stationen jederzeit im 2D-Grundriss-Editor frei verschieben oder per CAD-DXF ergänzen.
            </Callout>
          </div>
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button text="Abbrechen" disabled={busy} onClick={onClose} />
            {onOpenDraftInEditor && (
              <Button
                icon="edit"
                text="Als Entwurf im 2D-Editor öffnen"
                disabled={busy}
                onClick={() => {
                  onOpenDraftInEditor(plan);
                  onClose();
                }}
              />
            )}
            <Button
              intent="primary"
              icon="tick-circle"
              text="Halle jetzt erstellen & speichern"
              loading={busy}
              onClick={handleSave}
            />
          </>
        }
      />
    </Dialog>
  );
}
