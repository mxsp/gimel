import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Button, ButtonGroup, Icon, Menu, MenuDivider, MenuItem } from "@blueprintjs/core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { Floor, FlowEdge, Robot, RobotJob, Station, doorDirection, effectiveDoorKind, isFloorHoleObstacle, obstacleHeight, obstacleKind, routePoints, sceneBounds, stationCorners } from "../../factory";
import { mapAttribution, mapDetailFor, tileMetres, tilesAround, useMapStyle } from "../../sites";
import MapStyleSwitch from "../MapStyleSwitch";
import TwinSky from "./Sky";
import { starDome } from "./skyPoints";
import { StationMark } from "./marks";
import { fitStationModel, loadStationModelFile } from "./stationModel";
import { buildDeviceModel, DeviceStyle, DEVICE_STYLE, deviceStyleFromTokens, paletteOf } from "./deviceModels";
import { extinguisherSpots, operatorSpots, polylineLength as ambientLength, shuttle } from "./ambient";
import { extinguisher, forklift, worker } from "./models/props";
import { box as kitBox, finalize as kitFinalize, mat as kitMat } from "./models/kit";
import { buildConveyor } from "./models/conveyor";
import { along3, length3, points3 as conveyorPoints, widthOf as conveyorWidth } from "./conveyor";
import { layoutLabels, labelPriority, type LabelBox } from "./labelLayout";
import { buildVerticalLink } from "./models/vertical";
import {
  arrivalSpot, INTERACT_M, levelChoices, linkFootprint, linkPrompt, matchingLink, nearestLink, nextLevel, rideMs,
  stairHint, stairSurfaceAt, stairWellHoles, STAIR_TRIGGER_M, verticalLinks,
  type LinkKind, type StairDir, type VerticalLink, type WalkLevel,
} from "./walkLevels";
import { buildRobotModel, robotStatusColour } from "./robotModel";
import { SIM_STATE_WORD, SimSegment, SimState, trackPose } from "./fleetSim";
import { robotMovingAt, robotPoseAt } from "./robots";
import { AISLE_LANE_M, aisleNetworkMetres, aisleWays, hallHeight, lanePolygon, wayArrows } from "./aisleWays";
import { buildTwinWorld, CLEARANCE_M, clearPolyline, clearWays, obstacleHasDoor, obstacleWallPieces, pointInPolygon, robotCollisionReport, ROBOT_RADIUS_M, wallPieces } from "./collision";
import { hallAt, hallWalkWorld, inversePlacement, nearestHallDoor, sharedBoundaryDoors, unplacePoint, unplaceYaw, type HallPlacement } from "./walkHalls";
import { enableHighQuality, FrameWatch, HighQuality, probeDevice, Quality } from "./renderQuality";
import {
  cameraKey, classifyDevice, decideFrame, MOVING_RATIO_FACTOR, pixelRatioFor, SETTLE_FRAMES, SETTLE_MS, SLOW_FRAME_MS,
} from "./frameBudget";
import { mergeStatic } from "./staticMerge";
import { viewerFocus, type GhostLevel, type NeighborHall, type ViewerFocus } from "./twinScope";
import {
  levelConnectorShafts,
  polygonStrictlyInside,
  roofSkylightStrips,
  roofTrussesAndPurlins,
  type LevelOutlineSpan,
} from "./roofGeometry";
import "./walk.css";
import "./twin3d.css";
import {
  EYE_HEIGHT_M, fmtMetres, heatSpots, movedStation, polylineMetres, supplyRiskSpots,
  SupplyStationRisk, TourStop, walkStart, walkStep,
} from "./studioMath";

/** Leere Auswahl als fester Wert: sonst bekäme der Zeichen-Effekt bei jedem
    Render eine neue Liste und würde die Extras grundlos neu aufbauen. */
const NO_IDS: number[] = [];

/* Die Halle als echte Kamera — aber mit der Bildsprache der Semi-3D-Karte.

   Perspektivische Kamera, dieselben Körperfarben, dieselben Statuskanten und
   Wege. Der Unterschied zur SVG-Karte ist nur die Kamera: sie lässt sich
   drehen, zoomt näher heran und zeigt Geräte wirklich im Raum — eingebaute
   Modelle aus deviceModels oder hochgeladene GLB/OBJ/STL. Kein
   react-three-fiber: eine Komponente, ein Renderer, eine Schleife. */

const rad = (deg: number) => (deg * Math.PI) / 180;
const WALL_H = 0.85;
/** Abstand der Sterne: innerhalb der kleinsten Fernebene (2000 m), aber weit
    genug, dass die Halle sie nicht durch ihre eigene Tiefe schneidet. */
const STAR_RADIUS = 1400;

let colourProbe: HTMLSpanElement | null = null;

/** Eine CSS-Farbe auflösen — auch wenn sie aus einem anderen Token besteht. */
function css(name: string, fallback: string): string {
  try {
    if (!colourProbe) {
      colourProbe = document.createElement("span");
      colourProbe.style.cssText = "position:fixed;left:-9999px;top:-9999px;pointer-events:none";
      document.body.appendChild(colourProbe);
    }
    colourProbe.style.color = `var(${name})`;
    const v = getComputedStyle(colourProbe).color;
    return v && v !== "rgba(0, 0, 0, 0)" ? v : fallback;
  } catch { return fallback; }
}

function statusHex(kind: StationMark["kind"]): number {
  const map: Record<StationMark["kind"], string> = {
    laeuft: css("--gimel-accent", "#0b7a67"),
    wartet: css("--g-info", "#1668ac"),
    frei: css("--g-success-2", "#4a9d6e"),
    voll: css("--g-warning", "#ca9c19"),
    ueber: css("--g-danger", "#cd4246"),
    unbekannt: css("--g-muted", "#5f6b7c"),
    inaktiv: css("--g-muted", "#5f6b7c"),
  };
  return new THREE.Color(map[kind] ?? "#5f6b7c").getHex();
}

function heightOf(s: Station): number {
  if (s.is_storage) return 2.35;
  switch (s.type) {
    case "warehouse": return 2.35;
    case "accounting": return 1.55;
    case "shipping": return 1.45;
    case "production": return s.machine_kind === "waterjet" ? 1.95 : s.machine_kind === "manual" ? 1.25 : 1.45;
    default: return 1.3;
  }
}

/** Runder Stern statt eines viereckigen Punktes: ein kleiner weicher Kreis. */
function starSprite(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, "rgba(255, 255, 255, 1)");
    g.addColorStop(0.45, "rgba(255, 255, 255, 0.9)");
    g.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.own = true;
  return tex;
}

function disposeGroup(group: THREE.Object3D | null | undefined, scene?: THREE.Scene | null): void {
  if (!group) return;
  group.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove();
  });
  group.userData?.cleanup?.();
  if (scene) scene.remove(group);
  else group.removeFromParent();
  disposeTree(group);
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const draw = o as THREE.Mesh | THREE.Line;
    // Geteilte Materialien des Gerätebaukastens (models/kit.ts) bleiben stehen:
    // das nächste Gerät derselben Farbe benutzt sie wieder.
    if (draw.geometry && !draw.geometry.userData?.shared) draw.geometry.dispose();
    const materials = Array.isArray(draw.material) ? draw.material : draw.material ? [draw.material] : [];
    for (const material of materials) {
      if (material.userData?.shared) continue;
      // Eigene Texturen (Bildschirm mit Auftragsnummer) gehören zum Material.
      const map = (material as THREE.MeshBasicMaterial).map;
      if (map?.userData?.own) map.dispose();
      material.dispose();
    }
  });
}

/** Bildschirm am Bedienpult einer laufenden Maschine: gebuchte Nummer, kein erfundener Fortschritt. */
function jobScreen(ref: string, accent: string): THREE.MeshBasicMaterial | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 160;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = "#0b1a2b"; ctx.fillRect(0, 0, 256, 160);
  ctx.fillStyle = accent; ctx.fillRect(0, 0, 256, 30);
  ctx.fillStyle = "#ffffff"; ctx.font = "bold 18px system-ui, sans-serif"; ctx.fillText("läuft", 12, 21);
  ctx.font = "bold 34px system-ui, sans-serif"; ctx.fillText(ref.slice(0, 12), 12, 86);
  ctx.fillStyle = "#9fc3e6"; ctx.font = "16px system-ui, sans-serif"; ctx.fillText("gebucht · kein Maschinensignal", 12, 122);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.own = true;
  const m = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  m.userData.glow = true;
  return m;
}

function robotStateWord(state: string): string {
  switch ((state || "").toLowerCase()) {
    case "moving": return "fährt";
    case "charging": return "lädt";
    case "blocked": return "blockiert";
    case "error": return "Störung";
    case "offline": return "offline";
    default: return "wartet";
  }
}

/** Ein gebautes Gerät folgt dem Ausblenden und der Transparenz der Station. */
function setDeviceOpacity(root: THREE.Object3D, opacity: number): void {
  // Volle Deckkraft: nichts anfassen. Die Materialien sind geteilt, und Glas
  // oder Wasser sind absichtlich durchscheinend (bis 2026-11-07 wurde hier
  // auch der Spritzschutz deckend gesetzt).
  if (opacity >= 1) return;
  const clones = new Map<THREE.Material, THREE.Material>();
  const dim = (m: THREE.Material): THREE.Material => {
    let c = clones.get(m);
    if (!c) {
      c = m.clone();
      c.userData = { ...m.userData, shared: false };
      c.transparent = true;
      c.opacity = (m.opacity ?? 1) * opacity;
      c.depthWrite = false;
      clones.set(m, c);
    }
    return c;
  };
  root.traverse((o) => {
    const d = o as THREE.Mesh | THREE.LineSegments;
    if (!d.material) return;
    d.material = Array.isArray(d.material) ? d.material.map(dim) : dim(d.material);
  });
}

/** Form im Grundriss (x, y) → Geometrie mit x/z = Grundriss und y = Höhe. */
function floorShape(points: [number, number][]): THREE.Shape {
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => (i ? shape.lineTo(x, -y) : shape.moveTo(x, -y)));
  return shape;
}

function floorGeometry(points: [number, number][], holes: [number, number][][] = []): THREE.ShapeGeometry {
  const shape = floorShape(points);
  for (const hole of holes) {
    if (hole.length < 3) continue;
    const path = new THREE.Path();
    hole.forEach(([x, y], i) => (i ? path.lineTo(x, -y) : path.moveTo(x, -y)));
    path.closePath();
    shape.holes.push(path);
  }
  const geoms = new THREE.ShapeGeometry(shape);
  geoms.rotateX(-Math.PI / 2);
  return geoms;
}

/** Polygon-geklippte Dachträger, Pfetten, Dachfläche und Lichtbänder.
 *  Nichts ragt bei L-/U-/ausgeschnittenen Hallen in die Luft hinaus; bei
 *  mehreren nicht deckungsgleich gestapelten Geschossen bleiben Lichtbänder
 *  auf den tatsächlich freien Dachflächen und streng innenliegende
 *  Obergeschosse werden aus der Dachfläche darunter ausgespart. */
function addRoofStructure(
  target: THREE.Group,
  outline: [number, number][],
  hallH: number,
  opts: {
    roof: boolean;
    aboveOutlines?: [number, number][][];
    frameMat: THREE.Material;
    glassMat: THREE.Material;
    opacityScale?: number;
  },
): void {
  if (outline.length < 3) return;
  const { trusses, purlins } = roofTrussesAndPurlins(outline);
  for (const { a: [ax, az], b: [bx, bz] } of trusses) {
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 0.2) continue;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.12), opts.frameMat);
    beam.position.set((ax + bx) / 2, hallH, (az + bz) / 2);
    beam.rotation.y = -Math.atan2(dz, dx);
    target.add(beam);
  }
  for (const { a: [ax, az], b: [bx, bz] } of purlins) {
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 0.2) continue;
    const purlin = new THREE.Mesh(new THREE.BoxGeometry(len, 0.09, 0.09), opts.frameMat);
    purlin.position.set((ax + bx) / 2, hallH + 0.02, (az + bz) / 2);
    purlin.rotation.y = -Math.atan2(dz, dx);
    target.add(purlin);
  }
  if (!opts.roof) return;

  const above = (opts.aboveOutlines ?? []).filter((p) => p.length >= 3);
  const roofHoles = above.filter((p) => polygonStrictlyInside(p, outline));
  const scale = opts.opacityScale ?? 1;
  const roofMesh = new THREE.Mesh(
    floorGeometry(outline, roofHoles),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(css("--g-hall-roof", "#cfd9e2")),
      transparent: true,
      opacity: 0.24 * scale,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  roofMesh.position.y = hallH + 0.01;
  roofMesh.renderOrder = -1;
  target.add(roofMesh);

  // Klare Attika-/Dachkante, damit Rücksprünge, Stufen und Terrassen in 3D sofort lesbar sind.
  target.add(new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(outline.map(([x, z]) => new THREE.Vector3(x, hallH + 0.025, z))),
    new THREE.LineBasicMaterial({
      color: new THREE.Color(css("--g-hall-frame", "#8d99a6")),
      transparent: true,
      opacity: 0.78 * scale,
    }),
  ));

  const skylightMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(css("--g-hall-glass", "#d8ecfa")),
    transparent: true,
    opacity: 0.3 * scale,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });
  for (const s of roofSkylightStrips(outline, above)) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(s.wx, 0.018, s.wz), skylightMat);
    strip.position.set(s.cx, hallH + 0.032, s.cz);
    target.add(strip);
  }
}

/** Eine zweite Ebene oder Nachbarhalle in derselben Bildsprache wie die aktive:
    Boden mit Raster, Zonen, Wände mit Öffnungen und Oberkante, Stützen,
    Gänge mit Pfeilen, Tore und Treppen. Nur Geräte und Beschriftungen kommen
    vom Aufrufer — so bleibt „andere Ebene“ eine Halle, kein Gerippe. */
function buildFloorPresentation(
  floor: Floor, stations: Station[],
  opts: {
    full: boolean;
    shell: boolean;
    roof?: boolean;
    aboveOutlines?: [number, number][][];
    extraDoors?: Floor["doors"];
    grid: boolean;
    aisles: boolean;
  },
): THREE.Group {
  const g = new THREE.Group();
  const outline = floor.outline ?? [];
  if (outline.length < 3) return g;
  const hallColor = new THREE.Color(css("--g-floor-hall", "#f6f7f9"));
  const sideColor = new THREE.Color(css("--g-iso-side", "#343d47"));
  const lineColor = new THREE.Color(css("--g-iso-side-line", "#14191f"));
  const accent = new THREE.Color(css("--gimel-accent", "#0b7a67"));
  const hallH = hallHeight(floor);
  const alpha = opts.full ? 0.92 : 0.66;
  const links = verticalLinks(floor, stations);
  const boreHoles = (floor.obstacles ?? []).filter((o) => isFloorHoleObstacle(o) && (o.points?.length ?? 0) >= 3).map((o) => o.points);
  const holes = [...stairWellHoles(links), ...boreHoles];

  const floorMesh = new THREE.Mesh(
    floorGeometry(outline, holes),
    new THREE.MeshBasicMaterial({
      color: hallColor, transparent: true, opacity: alpha,
      side: THREE.DoubleSide, toneMapped: false,
    }),
  );
  floorMesh.renderOrder = 0;
  g.add(floorMesh);
  g.add(new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(outline.map(([x, y]) => new THREE.Vector3(x, 0.024, y))),
    new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.9 }),
  ));

  if (opts.grid) {
    const gridM = floor.grid && floor.grid > 0 ? floor.grid : 1;
    const grid = new THREE.Mesh(
      floorGeometry(outline, holes),
      new THREE.MeshBasicMaterial({
        map: patternTexture("grid", css("--g-floor-grid", "#dce0e5"), gridM),
        transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    grid.position.y = 0.005;
    grid.renderOrder = 1;
    g.add(grid);
  }

  // Zonen: Fläche und gestrichelte Kante — wie in der aktiven Halle.
  for (const z of floor.zones ?? []) {
    if (!z.points || z.points.length < 3) continue;
    const zoneColor = new THREE.Color(z.colour || "#8e5cb8");
    const fill = new THREE.Mesh(floorGeometry(z.points), new THREE.MeshBasicMaterial({
      color: zoneColor, transparent: true, opacity: 0.1, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }));
    fill.position.y = 0.012;
    fill.renderOrder = 2;
    g.add(fill);
    const pts = z.points.map(([x, y]) => new THREE.Vector3(x, 0.018, y));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]),
      new THREE.LineDashedMaterial({ color: zoneColor, transparent: true, opacity: 0.5, dashSize: 0.6, gapSize: 0.35 }),
    );
    line.computeLineDistances();
    g.add(line);
  }

  // Wände mit Türöffnungen (inkl. Türen angrenzender Nachbarhallen) und dunkler Oberkante.
  const allFloorDoors = [...(floor.doors ?? []), ...(opts.extraDoors ?? [])];
  for (const { a: [ax, ay], b: [bx, by] } of wallPieces(outline, allFloorDoors)) {
    const dx = bx - ax, dz = by - ay, len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, 0.14), new THREE.MeshBasicMaterial({
      color: sideColor, transparent: true, opacity: 0.9, toneMapped: false,
    }));
    wall.position.set((ax + bx) / 2, WALL_H / 2, (ay + by) / 2);
    wall.rotation.y = -Math.atan2(dz, dx);
    g.add(wall);
  }
  g.add(new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(outline.map(([x, y]) => new THREE.Vector3(x, WALL_H, y))),
    new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.85 }),
  ));

  // Hallenhülle: durchscheinende Wände, Sprossen, Stützen und Dachträger.
  if (opts.shell) {
    const glassMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(css("--g-hall-glass", "#b9d4e8")), transparent: true,
      opacity: 0.055, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    });
    const frameMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(css("--g-hall-frame", "#8d99a6")), transparent: true,
      opacity: 0.4, toneMapped: false,
    });
    const columnMat = new THREE.MeshBasicMaterial({ color: sideColor, transparent: true, opacity: 0.85, toneMapped: false });
    const upper = Math.max(0.6, hallH - WALL_H);
    for (let i = 0; i < outline.length; i++) {
      const [ax, ay] = outline[i];
      const [bx, by] = outline[(i + 1) % outline.length];
      const dx = bx - ax, dz = by - ay, len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const mx = (ax + bx) / 2, mz = (ay + by) / 2;
      const turn = -Math.atan2(dz, dx);
      const pane = new THREE.Mesh(new THREE.BoxGeometry(len, upper, 0.05), glassMat);
      pane.position.set(mx, WALL_H + upper / 2, mz);
      pane.rotation.y = turn;
      g.add(pane);
      const parts = Math.max(1, Math.round(len / 6));
      for (let k = 1; k < parts; k++) {
        const u = k / parts;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, upper, 0.09), frameMat);
        post.position.set(ax + dx * u, WALL_H + upper / 2, ay + dz * u);
        g.add(post);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(len, 0.16, 0.16), frameMat);
      beam.position.set(mx, hallH, mz);
      beam.rotation.y = turn;
      g.add(beam);
    }
    for (const [x, y] of outline) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.3, hallH, 0.3), columnMat);
      col.position.set(x, hallH / 2, y);
      g.add(col);
    }
    addRoofStructure(g, outline, hallH, {
      roof: !!opts.roof,
      aboveOutlines: opts.aboveOutlines,
      frameMat,
      glassMat,
      opacityScale: opts.full ? 1 : 0.78,
    });
  }

  // Stützen, Wände, Raumboxen und Regale als Körper mit Oberkante und Schraffur.
  for (const o of floor.obstacles ?? []) {
    if (!o.points || o.points.length < 3) continue;
    const h = obstacleHeight(o, hallH);
    const kind = obstacleKind(o);
    const solid = kind === "wall" || kind === "room" || kind === "column" || kind === "round_column";
    const geo = new THREE.ExtrudeGeometry(floorShape(o.points), { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, [
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(css("--g-floor-hatch", "#738091")), transparent: true,
        opacity: solid ? 0.62 : 0.3, side: THREE.DoubleSide, toneMapped: false,
      }),
      new THREE.MeshBasicMaterial({ color: sideColor, transparent: true, opacity: solid ? 0.72 : 0.5, toneMapped: false }),
    ]);
    mesh.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: solid ? 0.75 : 0.5 }),
    ));
    g.add(mesh);
  }

  // Gänge: Fahrspur, Rand, Mittellinie und gerade Pfeile. Dieselbe Geometrie
  // wie in der aktiven Halle, nur als schlanke Linien (keine dicken Striche).
  const aisleColor = new THREE.Color(css("--g-floor-aisle", "#3f7fb8"));
  const laneFill = new THREE.Color(css("--g-floor-aisle-lane", "#dbe9f5"));
  if (opts.aisles) for (const way of aisleWays(floor)) {
    const poly = lanePolygon(way.points, AISLE_LANE_M);
    if (poly.length >= 3) {
      const fill = new THREE.Mesh(floorGeometry(poly), new THREE.MeshBasicMaterial({
        color: laneFill, transparent: true, opacity: way.kind === "path" ? 0.38 : 0.55,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      }));
      fill.position.y = 0.016;
      fill.renderOrder = 1;
      g.add(fill);
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([...poly, poly[0]].map(([x, y]) => new THREE.Vector3(x, 0.022, y))),
        new THREE.LineBasicMaterial({ color: new THREE.Color(css("--g-floor-aisle-edge", "#9dbfdc")), transparent: true, opacity: 0.55 }),
      );
      ring.renderOrder = 2;
      g.add(ring);
    }
    const pts = way.points.map(([x, y]) => new THREE.Vector3(x, 0.032, y));
    if (pts.length >= 2) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        way.kind === "path"
          ? new THREE.LineBasicMaterial({ color: aisleColor, transparent: true, opacity: 0.65 })
          : new THREE.LineDashedMaterial({ color: aisleColor, transparent: true, opacity: 0.45, dashSize: 0.5, gapSize: 0.35 }),
      );
      if (way.kind !== "path") line.computeLineDistances();
      line.renderOrder = 5;
      g.add(line);
    }
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.3);
    arrowShape.lineTo(-0.2, -0.18);
    arrowShape.lineTo(0.2, -0.18);
    arrowShape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);
    const arrowMat = new THREE.MeshBasicMaterial({
      color: aisleColor, transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false,
    });
    for (const arrow of wayArrows(way.points)) {
      const m = new THREE.Mesh(arrowGeo, arrowMat);
      m.rotation.set(-Math.PI / 2, 0, Math.atan2(-arrow.dir[0], -arrow.dir[1]));
      m.position.set(arrow.at[0], 0.038, arrow.at[1]);
      m.renderOrder = 6;
      g.add(m);
    }
  }

  // Tore und Treppen: farbige Markierung, Modell und Schild.
  for (const d of floor.doors ?? []) {
    const w = d.width || 2.5;
    const dk = effectiveDoorKind(d);
    const colour = dk === "gate" ? css("--g-floor-warn", "#c4520a")
      : dk === "ramp" ? css("--g-flow-supply", "#8e5cb8")
      : dk === "stair" ? "#0d9488"
      : dk === "lift" ? "#4f46e5"
      : dk === "emergency" ? "#16a34a"
      : dk === "window" ? "#0284c7"
      : css("--g-flow-ship", "#217e56");
    const [ux, uy] = doorDirection(floor, d);
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.18, 0.22),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colour), transparent: true, opacity: 0.85 }),
    );
    bar.position.set(d.x, 0.45, d.y);
    bar.rotation.y = -Math.atan2(uy, ux);
    g.add(bar);
  }
  if (links.length) {
    const vStyle = {
      body: css("--g-iso-top", "#4f5b69"), bodyDark: css("--g-iso-side", "#343d47"),
      steel: css("--g-floor-hatch", "#738091"), accent: css("--g-lift-pad", "#217e56"),
      signBg: css("--g-lift-sign-bg", "#1f2933"), signFg: css("--g-lift-sign-fg", "#f4f7fa"),
      light: css("--g-surface", "#f4f7fa"),
    };
    for (const l of links) g.add(buildVerticalLink(l, hallH, vStyle));
  }
  return g;
}

/** Weiche Auflagefläche unter einem Körper — das Gegenstück zum SVG-Schatten. */
let shadowTexture: THREE.CanvasTexture | null = null;

function groundShadowTexture(): THREE.CanvasTexture {
  if (shadowTexture) return shadowTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.filter = "blur(9px)";
  ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
  ctx.beginPath();
  ctx.roundRect(24, 24, 80, 80, 16);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  shadowTexture = tex;
  return tex;
}

/** Raster und Schraffur als Textur; die UVs der Grundriss-Geometrie sind Meter. */
function patternTexture(kind: "grid" | "hatch" | "cross", colour: string, spacing: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.strokeStyle = colour;
  ctx.lineWidth = kind === "grid" ? 1 : 2;
  ctx.beginPath();
  if (kind === "grid") {
    ctx.moveTo(0, 0); ctx.lineTo(64, 0);
    ctx.moveTo(0, 0); ctx.lineTo(0, 64);
  } else if (kind === "cross") {
    ctx.moveTo(0, 32); ctx.lineTo(64, 32);
    ctx.moveTo(32, 0); ctx.lineTo(32, 64);
  } else {
    ctx.moveTo(0, 64); ctx.lineTo(64, 0);
  }
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / Math.max(0.05, spacing), 1 / Math.max(0.05, spacing));
  tex.colorSpace = THREE.SRGBColorSpace;
  // Boden in Augenhöhe liegt fast streifend im Blick: volle anisotrope
  // Filterung (THREE klemmt auf das, was die Grafik kann), sonst verwischt das Raster.
  tex.anisotropy = 16;
  return tex;
}

/** Ein bewegtes Teil eines Geräts oder der Belebung (`userData.motion`). */
interface MotionPart {
  obj: THREE.Object3D;
  base: THREE.Vector3;
  baseRot: THREE.Euler;
  kind: string;
  phase: number;
  running: boolean;
  baseOpacity: number;
  /** Deckkraft vor dem Abdunkeln durch eine Auswahl (task 41 C). */
  selBaseOpacity?: number;
  amp?: number;
  speed?: number;
  rest?: number;
}

function collectMotion(root: THREE.Object3D, running: boolean, into: MotionPart[]): void {
  root.traverse((o) => {
    const motion = o.userData?.motion as { kind: string; phase?: number; amp?: number; speed?: number; base?: number } | undefined;
    if (!motion || typeof motion !== "object") return;
    const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
    into.push({
      obj: o, base: o.position.clone(), baseRot: o.rotation.clone(), kind: motion.kind,
      phase: motion.phase ?? 0, running, baseOpacity: mat?.opacity ?? 1,
      amp: motion.amp, speed: motion.speed, rest: motion.base,
    });
  });
}

/** Bewegt ein Teil zur Zeit `t` (s). Zurück in Ruhelage, wenn es nicht läuft. */
/** Station und alles, was mit ihr wandert, für das Ziehen kennzeichnen. */
function tagStationMove(o: THREE.Object3D, s: Station): void {
  if (s.id == null) return;
  o.userData = {
    ...(o.userData ?? {}),
    stationMove: { id: s.id, x: o.position.x, z: o.position.z, yaw: o.rotation.y },
  };
}

/** Senkrechtes Blickfeld beim Begehen (Grad); entspricht etwa 90° waagerecht
    auf einem Breitbild — wie das menschliche Sehen ohne Randbereich. */
const WALK_FOV_DEG = 60;

/** Erste Ansicht: Ecken der Hallenkiste bis hierhin (NDC, 1 = Bildrand). */
const FIT_FILL = 0.84;

const NO_FLOW: FlowEdge[] = [];
const NO_LEVELS: NonNullable<Props["levels"]> = [];
const NO_NEIGHBORS: NonNullable<Props["neighborHalls"]> = [];

/** Liefert das vorige Objekt, solange der Inhalt gleich ist (Wertvergleich
    über JSON; dieselbe Referenz wird gar nicht erst serialisiert). */
function useStable<T>(value: T): T {
  const ref = useRef<{ v: T; k: string } | null>(null);
  if (ref.current && ref.current.v === value) return value;
  const k = JSON.stringify(value) ?? "";
  if (!ref.current || ref.current.k !== k) ref.current = { v: value, k };
  return ref.current.v;
}

const DEBUG_3D = typeof location !== "undefined" && /[?&]debug3d=1\b/.test(location.search + location.hash);

/** Jede Methode des Griffs fordert danach Bilder an (Kamera-Knöpfe,
    Lesezeichen, Messen): die Bildschleife zeichnet sonst nur bei Bedarf. */
function withInvalidate<T extends object>(invalidate: () => void, handle: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(handle)) {
    (out as any)[k] = typeof v === "function"
      ? (...args: unknown[]) => { const r = (v as (...a: unknown[]) => unknown)(...args); invalidate(); return r; }
      : v;
  }
  return out;
}

function animatePart(part: MotionPart, t: number, still: boolean): void {
  if (!part.running || still) {
    part.obj.position.copy(part.base);
    part.obj.rotation.copy(part.baseRot);
    if (part.kind === "beacon" && part.obj instanceof THREE.Mesh) {
      (part.obj.material as THREE.MeshBasicMaterial).opacity = part.baseOpacity;
    }
    return;
  }
  const speed = part.speed ?? 1.5;
  const s = Math.sin(t * speed + part.phase);
  switch (part.kind) {
    case "gantry": part.obj.position.x = part.base.x + s * (part.amp ?? 0.55); break;
    case "head": part.obj.position.z = part.base.z + s * (part.amp ?? 0.4); break;
    case "carriage": part.obj.position.x = part.base.x + s * (part.amp ?? 0.4); break;
    case "ram": {
      // Kurzer, harter Hub: die meiste Zeit oben, dann ein Schlag.
      const hit = Math.pow(0.5 + 0.5 * Math.sin(t * speed + part.phase), 8);
      part.obj.position.y = part.base.y - hit * (part.amp ?? 0.14);
      break;
    }
    case "spin":
    case "roller": part.obj.rotation.y = part.baseRot.y + t * (part.speed ?? 1.6) + part.phase; break;
    case "turret": part.obj.rotation.y = part.baseRot.y + t * speed * 0.35; break;
    case "arm": part.obj.rotation.x = (part.rest ?? 0) + Math.sin(t * (part.speed ?? 2.2) + part.phase) * (part.amp ?? 0.22); break;
    case "leg": part.obj.rotation.x = Math.sin(t * (part.speed ?? 4.2) + part.phase) * (part.amp ?? 0.35); break;
    case "beacon":
      if (part.obj instanceof THREE.Mesh) {
        const m = part.obj.material as THREE.MeshBasicMaterial;
        m.opacity = part.baseOpacity * (0.6 + 0.4 * (0.5 + 0.5 * s));
      }
      break;
  }
}

/** Fahrzeug: Gierwinkel mit begrenzter Drehrate statt Sprung; Räder und Lidar drehen beim Fahren. */
function steerVehicle(group: THREE.Object3D, headingDeg: number | null | undefined, dt: number,
                      moving: boolean, speedMs: number, still: boolean): void {
  if (headingDeg != null) {
    const target = -rad(headingDeg);
    const current = typeof group.userData.yaw === "number" ? group.userData.yaw as number : target;
    const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
    const step = still ? Math.PI * 2 : dt * Math.PI;
    const yaw = current + Math.max(-step, Math.min(step, diff));
    group.userData.yaw = yaw;
    group.rotation.y = yaw;
  }
  if (!moving || still) return;
  let spins = group.userData.spins as THREE.Object3D[] | undefined;
  if (!spins) {
    spins = [];
    group.traverse((o) => { if (o.userData?.robotSpin) spins!.push(o); });
    group.userData.spins = spins;
  }
  for (const o of spins) {
    o.rotation.y += o.userData.robotSpin === "wheel" ? dt * Math.max(0.3, speedMs) / 0.085 : dt * 11;
  }
}

let labelSeq = 0;
const LABEL_URGENCY: Record<string, number> = { ueber: 60, voll: 50, unbekannt: 40, laeuft: 30, wartet: 20, frei: 10, inaktiv: 0 };

/** Beschriftungen entzerren (labelLayout.ts): ganz, nur Name, oder ausgeblendet.
 *  Ausgeblendete bleiben fokussierbar (Deckkraft 0), damit die Tastatur sie erreicht. */
function declutterLabels(layer: HTMLElement, overview = false): void {
  const boxes: LabelBox[] = [];
  const byId = new Map<string, HTMLElement>();
  for (const el of Array.from(layer.children) as HTMLElement[]) {
    if (el.style.display === "none") continue;
    const id = el.dataset.lid || (el.dataset.lid = String(++labelSeq));
    const r = el.getBoundingClientRect();
    if (!el.dataset.crowd) {
      // Natürliche Größe nur messen, solange die Beschriftung ganz zu sehen ist.
      el.dataset.nw = String(r.width);
      el.dataset.nh = String(r.height);
      const head = el.querySelector("b");
      el.dataset.nhh = String(head && el.querySelector("span") ? head.getBoundingClientRect().height : 0);
    }
    const w = Number(el.dataset.nw) || r.width, h = Number(el.dataset.nh) || r.height;
    if (!w || !h) continue;
    byId.set(id, el);
    boxes.push({
      id, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w, h,
      headH: Number(el.dataset.nhh) || 0,
      priority: labelPriority(el.className, Number(el.dataset.urgency) || 0),
      calm: !!el.dataset.stationId && (Number(el.dataset.urgency) || 0) <= 10,
    });
  }
  for (const [id, fit] of layoutLabels(boxes, { overview })) {
    const el = byId.get(id)!;
    const want = fit === "full" ? "" : fit;
    if ((el.dataset.crowd ?? "") !== want) {
      if (want) el.dataset.crowd = want; else delete el.dataset.crowd;
    }
  }
}

function addCssLabel(root: THREE.Object3D, el: HTMLElement, x: number, y: number, z: number, className = ""): CSS2DObject {
  if (className) el.className = className;
  const label = new CSS2DObject(el);
  label.position.set(x, y, z);
  root.add(label);
  return label;
}

interface Props {
  floor: Floor;
  stations: Station[];
  status: Record<number, StationMark>;
  selectedId?: number | null;
  highlightIds?: number[];
  flow?: FlowEdge[];
  /** Virtuelle oder gemeldete Transportroboter auf dieser Ebene. */
  robots?: Robot[];
  /** Offene Transportaufträge: ihr geplanter Weg und der Auftragskontext. */
  robotJobs?: RobotJob[];
  /** Serverzeit des letzten Roboterabrufs; die Ansicht rechnet dazwischen weiter. */
  sampledAt?: string | null;
  onStationClick?: (s: Station) => void;
  /** Begehen und bearbeiten: eine Station wurde auf den Boden gezogen und
      abgelegt. Fehlt der Rückruf, gibt es den Verschieben-Knopf nicht. */
  onStationMove?: (s: Station, next: { x: number; y: number; rotation: number }) => void;
  onFilterEdge?: (edge: FlowEdge) => void;
  height?: number | null;
  /** ``shell`` baut Wände, Stützen und Dachträger, ``roof`` legt ein
      durchscheinendes Dach darüber, ``lanes`` zeichnet Fahrspuren und
      ``paths`` die von Hand gezogenen Anschlusswege. */
  show?: Partial<Record<"zones" | "obstacles" | "aisles" | "doors" | "grid" | "flow" | "labels" | "robots" | "shell" | "roof" | "lanes" | "paths" | "collisions", boolean>>;
  /** Ohne WebGL: zurück in eine Ansicht, die der Browser sicher kann. */
  onFallback?: () => void;
  /** Belebung (dargestellt, nicht gemessen): Figuren an laufenden Maschinen,
      Stapler, wandernde Teile, Feuerlöscher. In der Demo an, sonst aus. */
  staged?: boolean;
  /** Meldet einmal, ob dieser Browser 3D kann (Twin Studio sperrt sonst seine 3D-Werkzeuge). */
  onGl?: (ok: boolean) => void;
  /** Weitere Ebenen derselben Halle, als Umriss und Körperkanten; ``offset`` in Metern über dem EG (KG negativ). */
  levels?: GhostLevel[];
  /** Andere Hallen desselben Standorts, an ihrer Kartenlage. */
  neighborHalls?: NeighborHall[];
  /** Andere Ebenen und Hallen nicht andeuten, sondern voll sichtbar zeichnen. */
  fullView?: boolean;
  /** Einzelne zusätzliche Ebenen (Ebenen-IDs), die voll statt angedeutet gezeichnet werden. */
  fullLevelIds?: number[];
  /** Einzelne Nachbarhallen (Hallen-IDs), die voll statt angedeutet gezeichnet werden. */
  fullHallIds?: number[];
  /** Höhe der aktiven Ebene über dem EG (KG negativ): nur das EG liegt auf dem Boden. */
  activeOffset?: number;
  /** Kartenanker der Halle: Ursprung des Grundrisses auf der Erde. Leer = keine Karte. */
  map?: { lat: number; lon: number; rotation_deg: number } | null;
  /** Darstellungsstufe: „schnell" (flach, wie bisher) oder „hoch" (Schatten, Licht, AO). */
  quality?: Quality;
  /** Die Stufe „hoch" war zu langsam und wurde von selbst verlassen. */
  onQualityDrop?: () => void;
  /** Daten in der Halle: Last als Wärmefleck am Boden, Lichtsäule über
      vollen/überbuchten Stationen, Versorgungsrisiko an Regalen und Maschinen. */
  overlays?: { heat?: boolean; beams?: boolean; supply?: boolean; supplyRisk?: Record<string, SupplyStationRisk> };
  /** Begehen: Ich-Perspektive in Augenhöhe, WASD/Pfeile, Maus schaut. */
  walk?: boolean;
  /** Wo man steht, im Begehen oben links: „Halle 2 · 1. OG“ (sonst der Ebenenname). */
  placeLabel?: string;
  /** Strg+Z / Strg+Y beim Begehen (und im Rechtsklick-Menü): letzte Stationslage
      zurücknehmen bzw. wiederholen. Fehlen sie, gibt es beides nicht. */
  onUndo?: () => void;
  onRedo?: () => void;
  /** Abgesetzter Startpunkt (Ziehen und Ablegen der Figur), sonst Tor oder Mitte. */
  walkFrom?: [number, number] | null;
  onWalkChange?: (on: boolean) => void;
  /** Ebenen derselben Halle, für Treppe und Aufzug beim Begehen. */
  walkLevels?: WalkLevel[];
  /** Der Gast hat an Treppe oder Aufzug eine andere Ebene gewählt: Eltern wechseln die Ebene. */
  onWalkLevel?: (floorId: number) => void;
  /** Messen: Klicks auf den Boden setzen Punkte, Länge in Metern. */
  measure?: boolean;
  onMeasure?: (metres: number, points: number) => void;
  /** Rundgang: die Kamera fährt die Haltepunkte nacheinander ab. */
  tour?: TourStop[] | null;
  onTourStop?: (stop: TourStop | null) => void;
  /** Ohne eigene Werkzeugleiste (Twin Studio bringt seine mit). */
  bare?: boolean;
  /** Leichte Wolken im Tageshimmel. Twin Studio zeigt den Tag ohne Wolken. */
  clouds?: boolean;
  /** Simulation geplanter Roboter: Zeitleisten vom Server, Uhr von außen. Die
      Geister fahren neben den echten Robotern und sind als „geplant" markiert. */
  simFleet?: {
    robots: { id: string; name: string; kind: string; planned: boolean; start: [number, number] }[];
    tracks: Record<string, SimSegment[]>;
    hotspots: { x: number; y: number; count: number }[];
    clock: () => number;
  } | null;
}

/** Was Twin Studio von außen an der Kamera tun darf. */
export interface ViewerPose {
  /** Standpunkt in Metern (Grundriss-Koordinaten). */
  x: number;
  y: number;
  /** Die Ebene, deren Achsen x/y meinen (beim Begehen: auf der man steht). */
  floor_id: number;
  /** Nächste Station und die, auf die der Blick fällt (nur Stationen dieser Ebene). */
  focus: ViewerFocus;
  /** Augenhöhe über dem Boden der aktiven Ebene. */
  eye_m: number;
  /** Blickrichtung in Grad (0 = +y, 90 = +x); null in der Draufsicht. */
  heading_deg: number | null;
  mode: "walk" | "orbit";
}

export interface ThreeHandle {
  flyToStation(id: number): void;
  getCamera(): { position: [number, number, number]; target: [number, number, number] } | null;
  /** Wo der Betrachter steht und wohin er schaut — für den Assistenten. */
  getViewer(): ViewerPose | null;
  setCamera(cam: { position: number[]; target: number[] }): void;
  preset(kind: "top" | "front" | "iso"): void;
  rotate(deg: number): void;
  zoom(factor: number): void;
  screenshot(): Promise<Blob | null>;
  /** Bodenpunkt unter einer Bildschirmposition (für das Absetzen der Figur). */
  floorPoint(clientX: number, clientY: number): [number, number] | null;
  clearMeasure(): void;
  /** Vorführung (task 41 E): einen Halt vor oder zurück, sofort hinfahren. */
  tourStep(delta: number): void;
  /** Vorführung anhalten (bleibt am Halt stehen) oder weiterlaufen lassen. */
  tourPause(paused: boolean): void;
}

export type { GhostLevel, NeighborHall } from "./twinScope";

interface NeighborPlacement {
  hall: NeighborHall;
  x: number;
  y: number;
  bounds: { x: number; y: number; w: number; h: number };
}

/** Ohne Kartenanker nebeneinander statt übereinander: rechts neben die aktive
 *  Halle, mit einem Gang dazwischen. */
function placeNeighbors(halls: NeighborHall[], active: { x: number; y: number; w: number; h: number }): NeighborPlacement[] {
  let nextX = active.x + active.w + 24;
  // Mehrere Ebenen derselben Halle stehen übereinander, nicht nebeneinander:
  // ohne Kartenanker bekommt jede Halle genau einen Platz.
  const slots = new Map<number, { x: number; y: number }>();
  return halls.map((hall) => {
    const bounds = sceneBounds(hall.floor, hall.stations);
    let x = hall.x;
    let y = hall.y;
    if (x == null || y == null) {
      const slot = slots.get(hall.id);
      if (slot) ({ x, y } = slot);
      else {
        x = nextX - bounds.x;
        y = active.y + active.h / 2 - (bounds.y + bounds.h / 2);
        nextX += bounds.w + 24;
        slots.set(hall.id, { x, y });
      }
    }
    return { hall, x, y, bounds };
  });
}

interface Frame {
  x: number;
  y: number;
  dir: [number, number];
}

/** Länge eines Linienzugs — um aus mehreren freien Abschnitten den längsten
    zu zeichnen, ohne die gespeicherte Route zu verändern. */
function polylineLength(points: [number, number][]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    sum += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return sum;
}

/** Punkt und Richtung auf dem gefundenen Weg — für die flachen Pfeile. */
function sampleRoute(points: [number, number][], t: number): Frame {
  if (points.length < 2) return { x: points[0]?.[0] ?? 0, y: points[0]?.[1] ?? 0, dir: [1, 0] };
  let total = 0;
  const lens: number[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const d = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    lens.push(d); total += d;
  }
  if (total <= 1e-6) return { x: points[0][0], y: points[0][1], dir: [1, 0] };
  let run = 0;
  const target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < lens.length; i++) {
    if (run + lens[i] >= target || i === lens.length - 1) {
      const u = lens[i] > 0 ? (target - run) / lens[i] : 0;
      const a = points[i], b = points[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      return { x: a[0] + dx * u, y: a[1] + dy * u, dir: [dx / len, dy / len] };
    }
    run += lens[i];
  }
  return { x: points[points.length - 1][0], y: points[points.length - 1][1], dir: [1, 0] };
}

function ThreeFloorPlan({
  floor: floorIn,
  stations: stationsIn,
  status,
  selectedId = null,
  highlightIds: highlightIn,
  flow: flowIn = NO_FLOW,
  robots = [],
  robotJobs = [],
  sampledAt = null,
  onStationClick,
  onStationMove,
  onFilterEdge,
  height,
  show = {},
  staged = false,
  levels: levelsIn = NO_LEVELS,
  neighborHalls: neighborsIn = NO_NEIGHBORS,
  fullView = false,
  fullLevelIds = NO_IDS,
  fullHallIds = NO_IDS,
  activeOffset = 0,
  map: mapIn = null,
  onFallback,
  onGl,
  quality = "schnell",
  onQualityDrop,
  overlays,
  walk = false,
  placeLabel = "",
  onUndo,
  onRedo,
  walkFrom = null,
  onWalkChange,
  walkLevels = [],
  onWalkLevel,
  measure = false,
  onMeasure,
  tour = null,
  onTourStop,
  bare = false,
  clouds = true,
  simFleet = null,
}: Props, handleRef: React.ForwardedRef<ThreeHandle>) {
  // Gleicher Inhalt = dasselbe Objekt (task 41 C): der 30-Sekunden-Abruf und
  // jede Darstellung der Elternseite liefern neue Felder mit altem Inhalt.
  // Ohne diese Klammer baute die Halle bei jedem Abruf neu (200–370 ms).
  const floor = useStable(floorIn);
  const stations = useStable(stationsIn);
  const flow = useStable(flowIn);
  const highlightIds = useStable(highlightIn);
  const levels = useStable(levelsIn);
  const neighborHalls = useStable(neighborsIn);
  const map = useStable(mapIn);
  const extrasRef = useRef<THREE.Group | null>(null);
  const tileCache = useRef(new Map<string, HTMLImageElement>());
  const mapGroupRef = useRef<THREE.Group | null>(null);
  const mapDetailRef = useRef<{ z: number; span: number } | null>(null);
  const mapComputeRef = useRef<(() => void) | null>(null);
  const [mapDetail, setMapDetail] = useState<{ z: number; span: number } | null>(null);
  const [mapStyle, setMapStyle] = useMapStyle();
  /** Kein WebGL (Treiber, Sandbox, Fernsitzung): Hinweis statt weißer Seite. */
  const [noGl, setNoGl] = useState(false);
  const glRef = useRef(onGl);
  glRef.current = onGl;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  /** Volle Pixeldichte dieses Geräts (ohne vorübergehende Absenkung beim Drehen). */
  const baseRatioRef = useRef(1);
  const labelRendererRef = useRef<CSS2DRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  /** Mitte der zuletzt eingepassten Halle — für das Verschieben ohne Drehverlust. */
  const cameraCenterRef = useRef<{ x: number; z: number } | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  /** Sterne als Kugel um die Kamera; folgt ihr in der Zeichenschleife. */
  const starSkyRef = useRef<THREE.Points | null>(null);
  const rootGroupRef = useRef<THREE.Group | null>(null);
  const stationActionsRef = useRef<((id: number) => void) | null>(null);
  const flowActionsRef = useRef<((edge: FlowEdge) => void) | null>(null);
  const frameRef = useRef<number | null>(null);
  /** Zeichnen bei Bedarf (task 41 A): ausstehende Bilder, Bühne im Bild. */
  const pendingFramesRef = useRef(SETTLE_FRAMES);
  const stageVisibleRef = useRef(true);
  const labelsDirtyRef = useRef(true);
  const sceneDirtyRef = useRef(true);
  const invalidate = (frames = SETTLE_FRAMES, labels = true) => {
    if (pendingFramesRef.current < frames) pendingFramesRef.current = frames;
    if (labels) { labelsDirtyRef.current = true; sceneDirtyRef.current = true; }
  };
  const lineMaterialsRef = useRef<LineMaterial[]>([]);
  const dashMaterialsRef = useRef<LineMaterial[]>([]);
  const robotObjectsRef = useRef<Map<number, THREE.Group>>(new Map());
  const robotDataRef = useRef<Map<number, Robot>>(new Map());
  const robotSampleRef = useRef<string | null>(null);
  const robotLayerRef = useRef<THREE.Group | null>(null);
  const reduceMotionRef = useRef(false);
  const fitDistanceRef = useRef(40);
  const resizeRef = useRef<(() => void) | null>(null);
  const yawElRef = useRef<HTMLSpanElement | null>(null);
  const hoverRef = useRef("");
  /** Bewegliche Teile der eingebauten Geräte; die Schleife bewegt nur laufende
      Stationen und lässt alle anderen in Ruhe. */
  const motionRef = useRef<MotionPart[]>([]);
  /** Materialwege des letzten Neuaufbaus (für die Belebung). */
  const flowRoutesRef = useRef<{ route: [number, number][]; kind: string; count: number }[]>([]);
  /** Förderbänder des letzten Neuaufbaus: Mittellinie mit Höhe und Gurttexturen (für die Belebung). */
  const conveyorsRef = useRef<{ points: [number, number, number][]; textures: THREE.Texture[] }[]>([]);
  const stagedRef = useRef<{ layer: THREE.Group | null; parts: MotionPart[]; movers: ((t: number) => void)[] }>(
    { layer: null, parts: [], movers: [] });
  /** Maße der Bühne für den Maßstab, ohne bei jedem Frame nachzufragen. */
  const stageSizeRef = useRef({ w: 0, h: 0 });
  const scaleBarRef = useRef<HTMLSpanElement | null>(null);
  const scaleTextRef = useRef<HTMLSpanElement | null>(null);
  const compassRef = useRef<HTMLSpanElement | null>(null);
  /** Weiche Kamerafahrt zu einer vorgegebenen Ansicht. */
  const flyRef = useRef<{ start: number; fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; ms?: number } | null>(null);
  /** Kollisionslage: eigene Gruppe, damit ein neuer Stand nicht die ganze
      Halle neu baut. Die Ringe an den Robotern folgen ihnen in der Schleife. */
  const collisionLayerRef = useRef<THREE.Group | null>(null);
  const collisionRobotsRef = useRef<Set<number>>(new Set());
  const collisionHudRef = useRef<HTMLSpanElement | null>(null);
  const collisionSrRef = useRef<HTMLSpanElement | null>(null);
  const [collisionTick, setCollisionTick] = useState(0);
  /** Stufe „hoch": Nachbearbeitung, Sonne, Umgebung. */
  const hqRef = useRef<HighQuality | null>(null);
  const hqRootRef = useRef<{ root: THREE.Object3D | null; frame: number }>({ root: null, frame: 0 });
  const frameWatchRef = useRef<FrameWatch | null>(null);
  const qualityDropRef = useRef(onQualityDrop);
  qualityDropRef.current = onQualityDrop;
  /** Datenebene (Wärme, Säulen): eigene Gruppe, eigener Neuaufbau. */
  const overlayLayerRef = useRef<THREE.Group | null>(null);
  /** Begehen: Lage in der Ebene, Blick, gedrückte Tasten. */
  const walkRef = useRef<{
    on: boolean; pos: [number, number]; yaw: number; pitch: number; keys: Set<string>;
    /** Ziehen mit links: Steuerknüppel — Ausschlag nach oben geht, seitlich dreht. */
    joy: { dx: number; dy: number } | null;
    /** Klick auf den Boden: dorthin gehen. */
    goal: [number, number] | null;
    stuck: number;
    /** Geglättete Eingabe (Anlauf und Auslauf wie im Spiel) und Schrittphase fürs Wippen. */
    vf: number; vs: number; bob: number;
    /** Bodenhöhe unter der Figur: 0 im Hallenboden, sonst die Treppenstufe. */
    ground: number; groundSmooth: number;
  }>({
    on: false, pos: [0, 0], yaw: 0, pitch: 0, keys: new Set(), joy: null, goal: null, stuck: 0,
    vf: 0, vs: 0, bob: 0, ground: 0, groundSmooth: 0,
  });
  /** Treppen und Aufzüge dieser Ebene, ihre Auswahl und die Fahrt zwischen zwei Ebenen. */
  const [walkPrompt, setWalkPrompt] = useState("");
  const [walkPromptKind, setWalkPromptKind] = useState<LinkKind | null>(null);
  const [walkLocked, setWalkLocked] = useState(false);
  const [liftMenu, setLiftMenu] = useState<{ link: VerticalLink; idx: number } | null>(null);
  /** Rechtsklick ohne Ziehen: Menü an der Stelle (Station oder Boden). */
  const [ctxMenu, setCtxMenu] = useState<{
    x: number; y: number; station: Station | null; point: [number, number] | null;
  } | null>(null);
  const ctxMenuRef = useRef<typeof ctxMenu>(null);
  ctxMenuRef.current = ctxMenu;
  /** Tastenkürzel-Übersicht im Begehen (H). */
  const [walkHelp, setWalkHelp] = useState(false);
  const walkHelpRef = useRef(walkHelp);
  walkHelpRef.current = walkHelp;
  const undoRef = useRef(onUndo);
  undoRef.current = onUndo;
  const redoRef = useRef(onRedo);
  redoRef.current = onRedo;
  /** Was Menü und Tasten im Begehen tun; die Walk-Wirkung füllt es (sie kennt Tragen und Zeiger). */
  const walkActionsRef = useRef<{
    carry: (s: Station, cx: number, cy: number) => void;
  }>({ carry: () => {} });
  const [ride, setRide] = useState<{ text: string; phase: "out" | "in" } | null>(null);
  const liftMenuRef = useRef<typeof liftMenu>(null);
  liftMenuRef.current = liftMenu;
  const rideRef = useRef<{ kind: LinkKind; name: string; toId: number; dir?: StairDir; until: number; arrived: boolean } | null>(null);
  const walkLevelCbRef = useRef(onWalkLevel);
  walkLevelCbRef.current = onWalkLevel;
  const promptKeyRef = useRef("");
  const walkLevelsRef = useRef<WalkLevel[]>([]);
  walkLevelsRef.current = walkLevels;
  /** Wechsel in eine Nachbarhalle: Position und Blick schon in deren Achsen. */
  const pendingHallRef = useRef<{ floorId: number; pos: [number, number]; yaw: number } | null>(null);
  /** Die Ebene, auf der die Figur zuletzt aufgesetzt wurde (Treppe, Tür, Start oder Landung). */
  const walkFloorRef = useRef<number>(-1);
  /** Lage der verlassenen Halle in den Achsen der neuen — hält die Tür auf dem
      Rückweg an derselben Stelle, auch ohne Kartenanker. */
  const [walkBack, setWalkBack] = useState<{
    hallId: number; toHallId: number;
    x: number; y: number; rotation_deg: number;
  } | null>(null);
  const joyElRef = useRef<HTMLDivElement | null>(null);
  const joyKnobRef = useRef<HTMLSpanElement | null>(null);
  const worldRef = useRef<ReturnType<typeof buildTwinWorld> | null>(null);
  const walkChangeRef = useRef(onWalkChange);
  walkChangeRef.current = onWalkChange;
  /** Begehen und bearbeiten: Stationen greifen und auf den Boden legen. */
  const [walkEdit, setWalkEdit] = useState(false);
  const walkEditRef = useRef(walkEdit);
  walkEditRef.current = walkEdit;
  /** Name der gerade gegriffenen Station (Hinweis im Bild). */
  const [carryName, setCarryName] = useState("");
  const moveCbRef = useRef(onStationMove);
  moveCbRef.current = onStationMove;
  /** Bricht ein laufendes Tragen ab (Werkzeug aus, Begehen aus, Esc). */
  const cancelCarryRef = useRef<(() => void) | null>(null);
  /** Ein Klick, den das Ziehen schon benutzt hat: nicht zusätzlich auswählen. */
  const suppressClickRef = useRef(false);
  /** V schaltet das Verschieben im Begehen um — auch bei gesperrter Maus. */
  const walkEditToggleRef = useRef<() => void>(() => {});
  /** Messen: Punkte auf dem Boden und die Gruppe, die sie zeigt. */
  const measureRef = useRef<{ points: [number, number][]; group: THREE.Group | null }>({ points: [], group: null });
  const measureCbRef = useRef(onMeasure);
  measureCbRef.current = onMeasure;
  const measureOnRef = useRef(measure);
  measureOnRef.current = measure;
  /** Rundgang: aktueller Halt und Zeitpunkt der Ankunft. */
  const tourRef = useRef<{ stops: TourStop[]; index: number; since: number; paused?: boolean } | null>(null);
  const tourStopRef = useRef(onTourStop);
  tourStopRef.current = onTourStop;
  /** Geplante Roboter der Simulation: Modell, Beschriftung, Zeitleiste. */
  const simRef = useRef<{
    clock: () => number;
    ghosts: { group: THREE.Group; label: HTMLElement; track: SimSegment[]; start: [number, number]; name: string; last: SimState | "" }[];
    layer: THREE.Group | null;
  }>({ clock: () => 0, ghosts: [], layer: null });
  const [ready, setReady] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  /** Zählt Hallenneubauten; die Belebung hängt sich danach neu an. */
  const [rootRev, setRootRev] = useState(0);
  const [hoverName, setHoverName] = useState("");
  const [cameraReset, setCameraReset] = useState(0);
  const clickRef = useRef<((s: Station) => void) | undefined>(onStationClick);
  const filterRef = useRef<((edge: FlowEdge) => void) | undefined>(onFilterEdge);
  clickRef.current = onStationClick;
  filterRef.current = onFilterEdge;

  const vis = useMemo(() => ({
    zones: show.zones ?? true, obstacles: show.obstacles ?? true, aisles: show.aisles ?? true,
    doors: show.doors ?? true, grid: show.grid ?? true, flow: show.flow ?? true,
    labels: show.labels ?? true, robots: show.robots ?? true,
    shell: show.shell ?? true, roof: show.roof ?? false,
    lanes: show.lanes ?? true, paths: show.paths ?? true,
    collisions: show.collisions ?? true,
  }), [show.zones, show.obstacles, show.aisles, show.doors, show.grid, show.flow, show.labels, show.robots,
    show.shell, show.roof, show.lanes, show.paths, show.collisions]);

  const maxFlow = useMemo(() => Math.max(1, ...flow.map((e) => e.count)), [flow]);
  /** Der 30-Sekunden-Abruf liefert ein neues ``status``-Objekt, auch wenn sich
      nichts geändert hat. Ohne diese Signatur baut die Szene sonst bei jedem
      Abruf neu — Modelle flackern und die Kamera verliert kurz ihr Ziel. */
  const statusKey = useMemo(() => stations.map((s) => {
    const m = s.id != null ? status[s.id] : undefined;
    return `${s.id}:${m?.kind ?? "-"}:${m?.running ?? "-"}:${m?.ratio ?? "-"}:${m?.certainty ?? "-"}:${m?.line ?? ""}:${m?.word ?? ""}`;
  }).join("|"), [stations, status]);
  const hallH = useMemo(() => hallHeight(floor), [floor]);
  const ways = useMemo(() => aisleWays(floor), [floor]);
  const netMetres = useMemo(() => aisleNetworkMetres(floor), [floor]);
  /** Alle festen Körper dieser Ebene: Grundlage für Spuren, Wege und die
      Kollisionsanzeige. Ein einziges Weltmodell für alle drei Aufgaben. */
  const world = useMemo(() => buildTwinWorld(floor, stations), [floor, stations]);
  const links = useMemo(() => verticalLinks(floor, stations), [floor, stations]);
  const linksRef = useRef<VerticalLink[]>([]);
  linksRef.current = links;
  /** Die Schleife läuft seit dem Einhängen weiter; sie liest die Ebene über die Ref. */
  const floorRef = useRef(floor);
  floorRef.current = floor;
  const stationsRef = useRef(stations);
  stationsRef.current = stations;
  /** Höhe der aktiven Ebene über dem EG — auch für die Augenhöhe beim Gehen. */
  const activeOffsetRef = useRef(activeOffset);
  activeOffsetRef.current = activeOffset;
  /** Sichtbare Nachbarhallen an ihrer Kartenlage — dieselbe Rechnung wie im Bild. */
  const neighborPlaces = useMemo(() => {
    const placed = placeNeighbors(neighborHalls, sceneBounds(floor, stations));
    // Gilt für jede Ebene der verlassenen Halle und solange man in der neuen
    // Halle bleibt — auch nach einer Treppe dort.
    if (!walkBack || walkBack.toHallId !== (floor.hall_id ?? -1)) return placed;
    return placed.map((p) => (p.hall.id === walkBack.hallId)
      ? {
        ...p, x: walkBack.x, y: walkBack.y,
        hall: { ...p.hall, rotation_deg: walkBack.rotation_deg },
      }
      : p);
  }, [neighborHalls, floor, stations, walkBack]);
  const neighborPlacesRef = useRef(neighborPlaces);
  neighborPlacesRef.current = neighborPlaces;
  /** Zum Gehen zählen Treppe und Aufzug als Körper; Türen sind Durchgänge, und
      die sichtbaren Nachbarhallen sind mit im selben Weltmodell. Anzeige und
      Berichte bleiben bei ``world``. */
  const walkHalls = useMemo<HallPlacement[]>(() => [
    {
      id: floor.hall_id ?? 0, label: floor.name || "Halle", floor, stations,
      x: 0, y: 0, rotation_deg: 0, elevation_m: 0,
    },
    ...neighborPlaces
      // Eine Halle auf einer anderen Höhe erreicht man nicht zu Fuß.
      .filter((p) => Math.abs(p.hall.elevation_m) < 0.6)
      .map((p) => ({
        id: p.hall.id, label: p.hall.label, floor: p.hall.floor, stations: p.hall.stations,
        x: p.x, y: p.y, rotation_deg: p.hall.rotation_deg, elevation_m: p.hall.elevation_m,
      })),
  ], [floor, stations, neighborPlaces]);
  const walkWorld = useMemo(() => hallWalkWorld(walkHalls), [walkHalls]);
  const walkHallsRef = useRef<HallPlacement[]>(walkHalls);
  walkHallsRef.current = walkHalls;
  const displayWays = useMemo(() => clearWays(ways, world, {
    radius: AISLE_LANE_M / 2, groups: ["station", "obstacle"], step: 0.4,
  }), [ways, world]);
  const floorRobots = useMemo(
    () => robots.filter((r) => r.active && r.floor_id === floor.id),
    [robots, floor.id],
  );
  const floorJobs = useMemo(
    () => robotJobs.filter((j) => j.floor_id === floor.id && Array.isArray(j.route) && j.route.length >= 2),
    [robotJobs, floor.id],
  );
  const robotReceivedRef = useRef<{ at: string | null | undefined; ms: number }>({ at: undefined, ms: Date.now() });
  if (robotReceivedRef.current.at !== sampledAt) {
    robotReceivedRef.current = { at: sampledAt, ms: Date.now() };
  }
  const drawableRobots = useMemo(
    () => floorRobots.filter((r) => robotPoseAt(r, sampledAt, Date.now(), robotReceivedRef.current.ms) !== null),
    [floorRobots, sampledAt],
  );
  useEffect(() => {
    robotDataRef.current = new Map(floorRobots.map((r) => [r.id, r]));
    robotSampleRef.current = sampledAt;
  }, [floorRobots, sampledAt]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { reduceMotionRef.current = media.matches; };
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  // Theme-Wechsel: die Körperfarben kommen aus den Tokens, also neu bauen.
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick((n) => n + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // Renderer, Kamera und Steuerung einmal anlegen.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1600);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (e) {
      console.warn("Gimel 3D: kein WebGL", e);
      setNoGl(true);
      glRef.current?.(false);
      return;
    }
    // Pixeldichte nach Gerät (task 41 D): Software-Rendering und schwache
    // Geräte zeichnen mit 1, Tablets mit höchstens 1,5, starke mit 2.
    const tier = classifyDevice(probeDevice());
    const baseRatio = pixelRatioFor(tier, window.devicePixelRatio || 1);
    renderer.setPixelRatio(baseRatio);
    baseRatioRef.current = baseRatio;
    mount.dataset.tier = tier;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = false;
    renderer.domElement.className = "three-canvas";
    renderer.domElement.setAttribute("aria-label", "Interaktive 3D-Halle");
    mount.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.className = "three-label-layer";
    mount.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.screenSpacePanning = true;
    // Zwischen etwa 70° und 30° über dem Horizont: schräg genug für
    // Körper und Schatten, steil genug gegen die kippende Kantenansicht.
    // Bis fast senkrecht von oben: die Draufsicht ist ein eigener
    // Kamerapreset, kein Bruch der Steuerung.
    controls.minPolarAngle = 0.06;
    // Bis waagerecht (0° über dem Horizont): auf Wunsch des Betriebs, um eine
    // Halle wie vom Gang aus anzusehen. Ein Hauch Rest hält die Kamera über dem Boden.
    controls.maxPolarAngle = Math.PI / 2 - 0.005;
    controls.minZoom = 0.22;
    controls.maxZoom = 9;
    controls.minDistance = 2;
    // Weit genug für Nachbarhallen und die Karte, aber nie ins Nichts.
    controls.maxDistance = 2500;
    controls.zoomToCursor = true;
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 1;
    controls.panSpeed = 0.8;
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controlsRef.current = controls;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    labelRendererRef.current = labelRenderer;
    sceneRef.current = scene;

    // Licht nur für hochgeladene Modelle; die Halle selbst ist flach wie die Karte.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4450, 0.95));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(28, 45, 22);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4e6, 0.28);
    fill.position.set(-24, 18, -26);
    scene.add(fill);

    const resize = () => {
      const r = mount.getBoundingClientRect();
      if (!r.width || !r.height) return;
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
      stageSizeRef.current = { w: r.width, h: r.height };
      renderer.setSize(r.width, r.height, false);
      labelRenderer.setSize(r.width, r.height);
      for (const m of lineMaterialsRef.current) m.resolution.set(r.width, r.height);
      for (const m of dashMaterialsRef.current) m.resolution.set(r.width, r.height);
      invalidate();
    };
    resizeRef.current = resize;
    resize();
    const seen = new ResizeObserver(resize);
    seen.observe(mount);
    // Aus dem Bild gescrollt oder eingeklappt: nichts zeichnen.
    const inView = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
        const vis = entries.some((e) => e.isIntersecting);
        stageVisibleRef.current = vis;
        if (vis) invalidate();
      })
      : null;
    inView?.observe(mount);
    // Jede Eingabe auf der Bühne zeichnet (Hover, Ziehen, Rad); die Dämpfung
    // der Kamera hält das Zeichnen danach selbst am Laufen.
    const poke = () => invalidate(SETTLE_FRAMES, false);
    const inputs = ["pointerdown", "pointermove", "pointerup", "wheel", "keydown", "focusin"] as const;
    for (const ev of inputs) mount.addEventListener(ev, poke, { passive: true });
    controls.addEventListener("change", poke);

    const clock = new THREE.Clock();
    let lastYaw = -999;
    let lastLabelPass = 0;
    let lastCameraMark = 0;
    let walkDt = 0;
    // Begehen: Beschriftungen und HUD nicht in jedem Bild neu schreiben.
    let labelFrame = 0;
    let lastScaleWidth = -1;
    let lastScaleText = "";
    let lastCompassDeg = Number.NaN;
    // Blick und Auge wiederverwenden statt je Bild drei Vektoren zu werfen.
    const walkEye = new THREE.Vector3();
    const walkLook = new THREE.Vector3();
    let lastRenderAt = 0;
    let renderedFrames = 0;
    let lastMoveAt = 0;
    let lowRes = false;
    let lastDeclutterKey = "";
    const loop = () => {
      frameRef.current = requestAnimationFrame(loop);
      // Zeichnen nur bei Bedarf (task 41 A, frameBudget.ts): die Dämpfung der
      // Kamera läuft in jedem Takt weiter, gezeichnet wird nur, wenn sich etwas
      // bewegt, eine Eingabe kam oder ein Effekt Bilder angefordert hat.
      const tick = performance.now();
      const ctlDt = clock.getDelta();
      const camMoved = !walkRef.current.on && controls.update(ctlDt);
      // Zähe Kamerafahrt: vorübergehend gröber zeichnen, nach dem Halt wieder
      // voll (nicht beim Begehen — das regelt seine eigene Dichte).
      if (camMoved) lastMoveAt = tick;
      if (lowRes && !walkRef.current.on && tick - lastMoveAt > SETTLE_MS) {
        lowRes = false;
        renderer.setPixelRatio(baseRatio);
        invalidate(SETTLE_FRAMES, false);
      }
      // Begehen setzt seine Dichte selbst aus der vollen Dichte; eine eben
      // noch gesenkte Auflösung vom Drehen gilt dann nicht mehr. Bis
      // 2026-11-08 blieb sie das ganze Begehen über bei ×0,66 (unscharf).
      if (lowRes && walkRef.current.on) lowRes = false;
      const still = reduceMotionRef.current;
      const tourOn = !!tourRef.current && tourRef.current.stops.length > 0 && !tourRef.current.paused;
      const active = camMoved || !!flyRef.current || walkRef.current.on || tourOn;
      let ambient = false;
      if (!active && !still) {
        ambient = dashMaterialsRef.current.length > 0 || simRef.current.ghosts.length > 0
          || stagedRef.current.movers.length > 0
          || stagedRef.current.parts.some((p) => p.running) || motionRef.current.some((p) => p.running);
        if (!ambient && robotObjectsRef.current.size) {
          const nowR = Date.now();
          for (const [id, obj] of robotObjectsRef.current) {
            // Der Arm fährt seinen Zyklus immer, auch im Stand (armCycle.ts).
            if (obj.userData?.armCycle) { ambient = true; break; }
            const robot = robotDataRef.current.get(id);
            if (robot && robotMovingAt(robot, robotSampleRef.current, nowR, robotReceivedRef.current.ms)) { ambient = true; break; }
          }
        }
      }
      const kind = decideFrame({
        now: tick, lastRender: lastRenderAt, pending: pendingFramesRef.current, active, ambient,
        focused: document.hasFocus(), visible: stageVisibleRef.current,
      });
      if (kind === "skip") {
        frameWatchRef.current?.pause();
        return;
      }
      if (pendingFramesRef.current > 0) pendingFramesRef.current--;
      if (camMoved && kind === "active" && !lowRes && !walkRef.current.on && lastRenderAt
          && tick - lastRenderAt > SLOW_FRAME_MS && tick - lastRenderAt < 250) {
        lowRes = true;
        renderer.setPixelRatio(baseRatio * MOVING_RATIO_FACTOR);
      }
      walkDt = lastRenderAt ? Math.min(0.25, (tick - lastRenderAt) / 1000) : ctlDt;
      lastRenderAt = tick;
      const fullRate = kind === "active";
      // Eine laufende Kamerafahrt setzt sich über das Dämpfen hinweg, bis sie
      // am Ziel ist; danach gehört die Kamera wieder ganz der Maus.
      const fly = flyRef.current;
      if (fly) {
        const u = reduceMotionRef.current ? 1 : Math.min(1, (performance.now() - fly.start) / (fly.ms ?? 480));
        const e = u * u * (3 - 2 * u);
        camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
        controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e);
        camera.lookAt(controls.target);
        if (u >= 1) flyRef.current = null;
      }
      // Weit herauszoomen darf die Halle nicht abschneiden: die Fernebene
      // wächst mit dem Abstand, statt bei der eingepassten Größe zu enden.
      const distance = camera.position.distanceTo(controls.target);
      const far = Math.max(2000, distance * 10);
      if (far > camera.far * 1.2 || far < camera.far * 0.7) {
        camera.far = far;
        camera.updateProjectionMatrix();
      }
      // Kartengrund nur außerhalb des Begehens nachführen: beim Gehen ändert
      // sich der Abstand zum Drehpunkt in jedem Bild, und ein Nachmessen der
      // Bühne (getBoundingClientRect) würde die eben geschriebenen Maße neu
      // berechnen lassen. Die Karte ist in Augenhöhe ohnehin nicht zu sehen.
      if (!walkRef.current.on) mapComputeRef.current?.();
      for (const m of dashMaterialsRef.current) {
        m.dashOffset = -((performance.now() * 0.0018) % 100);
      }
      // Roboter zwischen zwei Abrufen weiterrechnen: der Server liefert den
      // Stand, die Schleife bewegt ihn flüssig bis zur nächsten Antwort.
      // Wer Bewegung reduziert haben will, sieht den letzten Serverstand.
      const stamp = robotSampleRef.current ? Date.parse(robotSampleRef.current) : NaN;
      const nowMs = Date.now();
      const recMs = reduceMotionRef.current && Number.isFinite(stamp) ? nowMs : robotReceivedRef.current.ms;
      for (const [id, group] of robotObjectsRef.current) {
        // Arm mit Zelle: Arbeitszyklus aus der Wanduhr (models/armCell.ts).
        const cell = group.userData.armCell as { animate(seconds: number): void } | undefined;
        if (cell) cell.animate(reduceMotionRef.current ? 0 : performance.now() / 1000);
        const robot = robotDataRef.current.get(id);
        if (!robot) continue;
        const pose = robotPoseAt(robot, robotSampleRef.current, nowMs, recMs);
        if (!pose) continue;
        group.position.set(pose.x, 0.03, pose.y);
        steerVehicle(group, pose.heading_deg, Math.min(0.1, walkDt), robotMovingAt(robot, robotSampleRef.current, nowMs, recMs),
          Number(robot.speed_m_s) || 1, reduceMotionRef.current);
        const halo = group.getObjectByName("collision-halo");
        if (halo) halo.visible = collisionRobotsRef.current.has(id);
      }
      const az = ((controls.getAzimuthalAngle() - Math.PI / 4) * 180) / Math.PI;
      const rounded = ((Math.round(az) % 360) + 360) % 360;
      if (rounded !== lastYaw) {
        lastYaw = rounded;
        if (yawElRef.current) yawElRef.current.textContent = `${String(rounded).padStart(2, "0")}°`;
      }
      // Eingebaute Geräte: nur laufende Stationen bewegen Kopf, Stempel,
      // Rollen oder ihre Signalleuchte. Reduzierte Bewegung friert sie ein.
      const t = performance.now() * 0.001;
      for (const part of motionRef.current) animatePart(part, t, reduceMotionRef.current);
      const stagedNow = stagedRef.current;
      for (const part of stagedNow.parts) animatePart(part, t, reduceMotionRef.current);
      if (!reduceMotionRef.current) for (const move of stagedNow.movers) move(t);
      // Maßstab und Kompass folgen der Kamera, statt eine feste Zahl zu
      // behaupten, die beim Zoomen falsch würde.
      const stage = stageSizeRef.current;
      if (stage.h > 0) {
        const d = camera.position.distanceTo(controls.target);
        const perPx = (2 * d * Math.tan(rad(camera.fov / 2))) / (stage.h * Math.max(0.01, camera.zoom));
        const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((v) => v >= perPx * 92) ?? 2000;
        const width = Math.round(Math.max(18, Math.min(160, nice / perPx)));
        if (width !== lastScaleWidth && scaleBarRef.current) {
          lastScaleWidth = width;
          scaleBarRef.current.style.width = `${width}px`;
        }
        const label = `${nice.toLocaleString("de-DE")} m`;
        if (label !== lastScaleText && scaleTextRef.current) {
          lastScaleText = label;
          scaleTextRef.current.textContent = label;
        }
      }
      const azDeg = Math.round((controls.getAzimuthalAngle() * 180) / Math.PI * 10) / 10;
      if (azDeg !== lastCompassDeg) {
        lastCompassDeg = azDeg;
        if (compassRef.current) compassRef.current.style.transform = `rotate(${-azDeg}deg)`;
      }
      // Begehen: die Kamera gehört den Tasten, nicht der Orbit-Steuerung.
      const w = walkRef.current;
      if (w.on) {
        const k = w.keys;
        let forward = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
        // Pfeile gehen wie WASD: links/rechts sind Seitenschritte, keine Drehung.
        // Gedreht wird mit der Maus (oder dem rechten Steuerknüppel).
        let strafe = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
        let turn = 0;
        let run = k.has("ShiftLeft") || k.has("ShiftRight");
        if (w.joy) {
          // Steuerknüppel: 90 px Ausschlag = volle Fahrt bzw. volle Drehung,
          // eine kleine Totzone hält das Ziehen ruhig.
          const dz = (v: number) => (Math.abs(v) < 8 ? 0 : Math.max(-1, Math.min(1, (v - Math.sign(v) * 8) / 90)));
          forward = -dz(w.joy.dy);
          turn = -dz(w.joy.dx);
          run = run || Math.abs(w.joy.dy) > 130;
          w.goal = null;
        }
        if (forward || strafe || turn) w.goal = w.goal && !k.size ? w.goal : null;
        if (w.goal && !w.joy) {
          const gx = w.goal[0] - w.pos[0], gy = w.goal[1] - w.pos[1];
          const dist = Math.hypot(gx, gy);
          if (dist < 0.35) { w.goal = null; }
          else {
            // Zum Ziel drehen, dann gehen; bleibt man hängen, gibt das Ziel auf.
            const want = Math.atan2(gx, gy);
            let diff = ((want - w.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            const turnStep = Math.min(Math.abs(diff), 3.2 * Math.min(0.1, walkDt));
            w.yaw += Math.sign(diff) * turnStep;
            diff = ((want - w.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            forward = Math.abs(diff) < 0.6 ? Math.min(1, dist / 1.2) : 0;
          }
        }
        w.yaw += turn * 1.8 * Math.min(0.1, walkDt);
        // Fahrt oder Ebenenwahl: die Figur steht.
        if (rideRef.current || liftMenuRef.current || ctxMenuRef.current) { forward = 0; strafe = 0; }
        // Anlauf und Auslauf wie im Spiel: die Eingabe wird geglättet.
        const ease = Math.min(1, Math.min(0.1, walkDt) * 11);
        w.vf += (forward - w.vf) * ease;
        w.vs += (strafe - w.vs) * ease;
        if (Math.abs(w.vf) < 0.02 && forward === 0) w.vf = 0;
        if (Math.abs(w.vs) < 0.02 && strafe === 0) w.vs = 0;
        const before = w.pos;
        const next = walkStep(w.pos, w.yaw, { forward: w.vf, strafe: w.vs, run }, walkDt, worldRef.current);
        w.pos = next.pos;
        // Treppe: die Höhe folgt der Stufe. Wer in einen Lauf ohne Zielebene
        // geht, bleibt vorn stehen (kein Schritt ins Leere).
        if (!rideRef.current && !liftMenuRef.current) {
          const surface = stairSurfaceAt(linksRef.current, w.pos);
          const to = surface ? nextLevel(walkLevelsRef.current, floorRef.current.id, surface.dir) : null;
          if (surface && !to) {
            w.pos = before;
            w.ground = 0;
          } else if (surface) {
            w.ground = surface.height;
            if (surface.t <= STAIR_TRIGGER_M) walkApiRef.current.stair(surface.link, surface.dir);
          } else {
            w.ground = 0;
          }
        } else {
          w.ground = 0;
        }
        // Durch die Tür in eine Nachbarhalle: die aktive Halle wechselt, die
        // Figur bleibt an derselben Stelle stehen und schaut weiter geradeaus.
        if (!rideRef.current && !liftMenuRef.current && !pendingHallRef.current && walkLevelCbRef.current) {
          const outline = floorRef.current.outline ?? [];
          const outside = outline.length >= 3 && !pointInPolygon(w.pos, outline);
          const other = outside ? hallAt(walkHallsRef.current, w.pos) : null;
          if (other && other.floor.id !== floorRef.current.id) {
            pendingHallRef.current = {
              floorId: other.floor.id,
              pos: unplacePoint(w.pos, other),
              yaw: unplaceYaw(w.yaw, other.rotation_deg),
            };
            // Die verlassene Halle bleibt an ihrer Stelle: das erledigt der
            // Wechsel-Effekt (``walkBack``) für jeden Hallenwechsel.
            walkLevelCbRef.current(other.floor.id);
          }
        }
        if (w.goal && forward > 0 && Math.hypot(next.pos[0] - before[0], next.pos[1] - before[1]) < 1e-4) {
          w.stuck += walkDt;
          if (w.stuck > 0.6) { w.goal = null; w.stuck = 0; }
        } else w.stuck = 0;
        // Leichtes Wippen beim Gehen (nicht bei „weniger Bewegung“).
        const moved = Math.hypot(next.pos[0] - before[0], next.pos[1] - before[1]);
        if (!reduceMotionRef.current && moved > 1e-4) w.bob += moved * 5.2;
        const bobY = reduceMotionRef.current ? 0 : Math.sin(w.bob) * 0.022 * Math.min(1, Math.hypot(w.vf, w.vs));
        // Der Höhenunterschied wird weich nachgezogen, damit die Stufen nicht
        // wie ein Sprung wirken.
        w.groundSmooth += (w.ground - w.groundSmooth) * Math.min(1, Math.min(0.1, walkDt) * 14);
        if (Math.abs(w.ground - w.groundSmooth) < 0.002) w.groundSmooth = w.ground;
        const eye = walkEye.set(
          w.pos[0], activeOffsetRef.current + w.groundSmooth + EYE_HEIGHT_M + bobY, w.pos[1]);
        camera.position.copy(eye);
        walkLook.set(
          Math.sin(w.yaw) * Math.cos(w.pitch), Math.sin(w.pitch), Math.cos(w.yaw) * Math.cos(w.pitch));
        camera.lookAt(walkLook.add(eye));
        // Hinweis an Treppe und Aufzug (nur bei Änderung in React schreiben).
        const near = rideRef.current || liftMenuRef.current ? null : nearestLink(linksRef.current, w.pos);
        const nearId = floorRef.current.id;
        const hallDoor = !near && !rideRef.current && !liftMenuRef.current
          ? nearestHallDoor(walkHallsRef.current, w.pos) : null;
        const text = near
          ? near.kind === "lift"
            ? linkPrompt(near, Math.max(0, walkLevelsRef.current.length - 1))
            : stairHint(near, nextLevel(walkLevelsRef.current, nearId, "up"), nextLevel(walkLevelsRef.current, nearId, "down"))
          : hallDoor
            ? `${hallDoor.door.name || "Durchgang"} · ${hallDoor.hall.label}`
            : "";
        const key = near ? `${near.kind}:${near.name}:${text}`
          : hallDoor ? `hall:${hallDoor.hall.id}:${hallDoor.door.name}` : "";
        if (key !== promptKeyRef.current) {
          promptKeyRef.current = key;
          setWalkPrompt(text);
          setWalkPromptKind(near?.kind ?? null);
        }
      }
      // Rundgang: an jedem Halt einige Sekunden, dann weich weiter.
      const tr = tourRef.current;
      if (tr && !w.on && tr.stops.length && !tr.paused) {
        const nowT = performance.now();
        if (!flyRef.current && nowT - tr.since > (reduceMotionRef.current ? 9000 : 6500)) {
          tr.index = (tr.index + 1) % tr.stops.length;
          tr.since = nowT;
          flyToStopRef.current?.(tr.stops[tr.index], 2200);
          tourStopRef.current?.(tr.stops[tr.index]);
        } else if (!flyRef.current && !reduceMotionRef.current) {
          // Zwischen den Fahrten langsam um den Halt kreisen.
          const off = camera.position.clone().sub(controls.target);
          off.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.0016);
          camera.position.copy(controls.target).add(off);
          camera.lookAt(controls.target);
        }
      }
      const sim = simRef.current;
      if (sim.ghosts.length) {
        const st = sim.clock();
        for (const g of sim.ghosts) {
          const pose = trackPose(g.track, st, g.start);
          g.group.position.set(pose.x, 0.03, pose.y);
          steerVehicle(g.group, pose.heading_deg, Math.min(0.1, walkDt),
            pose.state === "leer" || pose.state === "beladen", 1.2, reduceMotionRef.current);
          if (pose.state !== g.last) {
            g.last = pose.state;
            const load = g.group.getObjectByName("robot-payload");
            if (load) load.visible = pose.state === "beladen" || pose.state === "entladen";
            g.label.textContent = `${g.name} · ${SIM_STATE_WORD[pose.state]}`;
            g.label.dataset.state = pose.state;
          }
        }
      }
      const hq = hqRef.current;
      if (hq) {
        const mark = hqRootRef.current;
        mark.frame++;
        if (mark.root !== rootGroupRef.current || mark.frame % 90 === 0) {
          const rebuilt = mark.root !== rootGroupRef.current;
          mark.root = rootGroupRef.current;
          if (rebuilt) hq.prune();
          // Die ganze Szene, nicht nur die Halle: Ebenen, Nachbarhallen und die
          // Datenebene hängen in eigenen Gruppen.
          hq.applyShadows(scene);
        }
        // Nur durchgehendes Zeichnen messen: gedrosselte Belebungsbilder und
        // Pausen sähen sonst wie ein langsames Gerät aus.
        if (fullRate) frameWatchRef.current?.tick(performance.now());
        else frameWatchRef.current?.pause();
      }
      // Schatten nur bei Szenenänderung oder Bewegung neu (task 41 D).
      // Nur setzen, nie löschen: das Einschalten von „Hoch" fordert selbst an,
      // und three.js setzt die Anforderung nach dem Zeichnen zurück.
      if (hq && (sceneDirtyRef.current || kind === "ambient")) renderer.shadowMap.needsUpdate = true;
      sceneDirtyRef.current = false;
      // Sterne um den aktuellen Standpunkt legen: sie bleiben unendlich weit
      // weg, statt beim Zoomen näher zu kommen oder an der Fernebene zu enden.
      const starSky = starSkyRef.current;
      if (starSky) starSky.position.copy(camera.position);
      renderer.render(scene, camera);
      renderedFrames++;
      if (DEBUG_3D && mountRef.current) {
        mountRef.current.dataset.draws = String(renderer.info.render.calls);
        mountRef.current.dataset.tris = String(renderer.info.render.triangles);
      }
      // Beim Begehen reicht jede zweite Aktualisierung der DOM-Beschriftungen:
      // die Kamera bewegt sich ohnehin in jedem Bild, aber jede Station
      // kostet einen Stil-Schreibvorgang. Das Entzerren (mit getBoundingClientRect
      // je Beschriftung) pausiert dabei ganz — es würde die Layout-Berechnung
      // nur mitten in der Bewegung erzwingen.
      const walking = walkRef.current.on;
      if (!walking || (labelFrame++ & 1) === 0) labelRenderer.render(scene, camera);
      const tNow = performance.now();
      // Entzerren kostet ein getBoundingClientRect je Beschriftung: nur, wenn
      // sich der Blick bewegt hat oder Beschriftungen neu sind.
      if (!walking && tNow - lastLabelPass > 250) {
        const ck = cameraKey(camera.position, controls.target, camera.zoom);
        if (ck !== lastDeclutterKey || labelsDirtyRef.current) {
          lastLabelPass = tNow;
          lastDeclutterKey = ck;
          labelsDirtyRef.current = false;
          // Übersicht: weiter draußen als drei Viertel der eingepassten Entfernung.
          const far = camera.position.distanceTo(controls.target) > fitDistanceRef.current * 0.75;
          declutterLabels(labelRenderer.domElement, far);
        }
      }
      // Kamera als Attribut (viermal je Sekunde): Prüfstand und Fehlersuche
      // sehen, ob ein Wechsel den Blick stehen lässt. Begehen: der Standpunkt.
      if (tNow - lastCameraMark > 250 && mountRef.current) {
        lastCameraMark = tNow;
        const f = (v: number) => v.toFixed(2);
        const wk = walkRef.current;
        mountRef.current.dataset.camera = wk.on
          ? `walk ${f(wk.pos[0])},${f(wk.pos[1])}@${floorRef.current.id}`
          : `${f(camera.position.x)},${f(camera.position.y)},${f(camera.position.z)}>${f(controls.target.x)},${f(controls.target.y)},${f(controls.target.z)}`;
      }
    };
    // Prüfstand (task 41 H): mit ``?debug3d=1`` liegen Szene und Zähler offen.
    if (DEBUG_3D) (window as any).__gimel3d = { scene, renderer, camera, controls, invalidate, frames: () => renderedFrames };
    loop();
    setReady(true);
    glRef.current?.(true);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      clearSelectionRef.current?.();
      hqRef.current?.dispose();
      hqRef.current = null;
      disposeGroup(rootGroupRef.current, scene);
      rootGroupRef.current = null;
      disposeGroup(extrasRef.current, scene);
      extrasRef.current = null;
      disposeGroup(mapGroupRef.current, scene);
      mapGroupRef.current = null;
      disposeGroup(overlayLayerRef.current, scene);
      overlayLayerRef.current = null;
      disposeGroup(staffedLayerRef.current, scene);
      staffedLayerRef.current = null;
      disposeGroup(collisionLayerRef.current, scene);
      collisionLayerRef.current = null;
      disposeGroup(robotLayerRef.current, scene);
      robotLayerRef.current = null;
      disposeGroup(simRef.current.layer, scene);
      simRef.current.layer = null;
      disposeGroup(measureRef.current.group, scene);
      measureRef.current.group = null;
      if (DEBUG_3D) delete (window as any).__gimel3d;
      robotObjectsRef.current.clear();
      robotDataRef.current.clear();
      seen.disconnect();
      inView?.disconnect();
      for (const ev of inputs) mount.removeEventListener(ev, poke);
      controls.removeEventListener("change", poke);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
      resizeRef.current = null;
      sceneRef.current = null;
      rendererRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      labelRendererRef.current = null;
    };
  }, []);

  // Sterne als eigener Himmel: Punkte auf einer Kugel um die Kamera, nicht am
  // Bildschirm. Beim Drehen wandert der Blick über das feste Sternbild, wie
  // bei einem echten Himmel; die Kugel folgt nur dem Standpunkt. Mit
  // depthTest verdecken Boden, Karte und Halle die Sterne, statt sie
  // durchscheinen zu lassen. Nur nachts eingehängt — tagsüber bleibt die Szene
  // unverändert.
  useEffect(() => {
    if (!ready) return;
    const scene = sceneRef.current;
    if (!scene) return;
    if (document.documentElement.dataset.theme !== "dark") return;
    const stars = starDome();
    const position = new Float32Array(stars.length * 3);
    const colour = new Float32Array(stars.length * 3);
    const base = new THREE.Color("#eef3ff");
    stars.forEach((s, i) => {
      position[i * 3] = s.x * STAR_RADIUS;
      position[i * 3 + 1] = s.y * STAR_RADIUS;
      position[i * 3 + 2] = s.z * STAR_RADIUS;
      const bright = 0.3 + s.alpha * 0.7;
      colour[i * 3] = base.r * bright;
      colour[i * 3 + 1] = base.g * bright;
      colour[i * 3 + 2] = base.b * bright;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colour, 3));
    const material = new THREE.PointsMaterial({
      // Größe in Bildpunkten, an die Pixeldichte angepasst: sonst werden die
      // Sterne auf einem hochauflösenden Bildschirm zu feinen Stäubchen.
      size: 2.6 * (rendererRef.current?.getPixelRatio() ?? 1),
      sizeAttenuation: false,
      map: starSprite(),
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      alphaTest: 0.02,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    const points = new THREE.Points(geo, material);
    points.name = "hall-stars";
    // Vor allen durchsichtigen Flächen (Karte, Wege, Zonen): die Sterne sind
    // die Ferne, alles andere liegt davor.
    points.renderOrder = -1000;
    points.frustumCulled = false;
    const camera = cameraRef.current;
    if (camera) points.position.copy(camera.position);
    starSkyRef.current = points;
    scene.add(points);
    invalidate();
    return () => {
      starSkyRef.current = null;
      scene.remove(points);
      geo.dispose();
      material.map?.dispose();
      material.dispose();
      // Ohne neues Bild bliebe der letzte Sternenhimmel im Puffer stehen.
      invalidate();
    };
  }, [ready, themeTick]);

  // Die Kamera auf die Halle einpassen. Nur beim ersten Mal und auf
  // ausdrücklichen Wunsch: eine gedrehte Ansicht bleibt sonst stehen, auch
  // wenn die Ebene oder eine Auswahl wechselt.
  useEffect(() => {
    if (!ready) return;
    const camera = cameraRef.current, controls = controlsRef.current;
    const mount = mountRef.current;
    if (!camera || !controls || !mount) return;
    const b = sceneBounds(floor, stations);
    const r = mount.getBoundingClientRect();
    const aspect = r.width > 0 && r.height > 0 ? r.width / r.height : 1.6;
    // Andere Ebenen ragen nach oben *und* nach unten (Keller): die Kamera
    // braucht Platz für den ganzen Stapel und schaut auf seine Mitte.
    let { top: levelTop, bottom: levelBottom } = stackExtent(levels, hallH, activeOffset);

    // Andere Ebenen derselben Halle und Nachbarhallen gehören ins Bild.
    const placements = neighborPlacesRef.current;
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    for (const lv of levels) {
      const lb = sceneBounds(lv.floor, lv.stations);
      x0 = Math.min(x0, lb.x);
      y0 = Math.min(y0, lb.y);
      x1 = Math.max(x1, lb.x + lb.w);
      y1 = Math.max(y1, lb.y + lb.h);
    }
    for (const p of placements) {
      x0 = Math.min(x0, p.x + p.bounds.x);
      y0 = Math.min(y0, p.y + p.bounds.y);
      x1 = Math.max(x1, p.x + p.bounds.x + p.bounds.w);
      y1 = Math.max(y1, p.y + p.bounds.y + p.bounds.h);
      // Nachbarhöhen sind relativ zur aktiven Ebene angegeben.
      levelTop = Math.max(levelTop, activeOffset + p.hall.elevation_m + Math.max(0, Number(p.hall.floor.height_m) || 6));
      levelBottom = Math.min(levelBottom, activeOffset + p.hall.elevation_m);
    }
    const stackH = levelTop - levelBottom;

    // Drehpunkt ist die Mitte der Halle, nicht die Mitte einer Projektion.
    // Ein versetzter Drehpunkt ließ die Halle beim Drehen um einen fremden
    // Punkt schwenken — der unruhige POV-Effekt.
    const cx = (x0 + x1) / 2;
    const cz = (y0 + y1) / 2;
    // Eine Ebene: knapp über dem Boden wie bisher. Mehrere: die Mitte des
    // Stapels — bis 2026-11-07 klemmte hier 4,5 m, und ein Stapel mit Keller
    // stand deutlich unter der Bildmitte.
    const target = new THREE.Vector3(cx,
      levels.length ? (levelTop + levelBottom) / 2
        : activeOffset + Math.min(4.5, Math.max(1.5, (levelTop - activeOffset) / 2)), cz);

    // Perspektive statt Axonometrie: die Halle bekommt Tiefe, ohne dass die
    // Maße auf dem Plan verzerrt werden. Der Abstand folgt der Hüllkugel.
    const span = Math.max(x1 - x0, y1 - y0, 10);
    const radius = Math.hypot(span, span * 0.5, Math.max(6, stackH)) / 2;
    // Querformat etwas enger; Hochformat genau wie vor task 37, sonst schnitte es seitlich ab.
    const wide = aspect >= 1.2;
    let distance = wide
      ? Math.max(radius / Math.sin(rad(camera.fov / 2)) * 0.8, 30) + (levels.length ? stackH / 2 : (levelTop - activeOffset) * 0.8)
      : Math.max(radius / Math.sin(rad(camera.fov / 2)) * 0.86, 32) + (levels.length ? stackH / 2 : levelTop - activeOffset);
    const dir = new THREE.Vector3(1, 0.62, 1).normalize();
    camera.aspect = aspect;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    // Eng einpassen (task 41 E): die Ecken der Hallenkiste (mit Nachbarhallen
    // und Stapel) sollen etwa 80 % der Bühne füllen. Die Hüllkugel oben ließ
    // die Halle bei der ersten Ansicht oft bei einem Viertel der Fläche stehen;
    // sie bleibt die Obergrenze, falls die Suche nichts findet.
    const corners: THREE.Vector3[] = [];
    for (const x of [x0, x1]) for (const z of [y0, y1]) for (const y of [levelBottom, levelTop]) corners.push(new THREE.Vector3(x, y, z));
    const fits = (d: number) => {
      camera.position.copy(target).addScaledVector(dir, d);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      for (const c of corners) {
        v.copy(c).project(camera);
        if (v.z >= 1 || Math.abs(v.x) > FIT_FILL || Math.abs(v.y) > FIT_FILL) return false;
      }
      return true;
    };
    let lo = 4, hi = Math.max(distance * 1.6, 60);
    if (fits(hi)) {
      for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
      distance = Math.min(distance, hi);
    }
    camera.position.copy(target).addScaledVector(dir, distance);
    camera.zoom = 1;
    camera.near = 0.25;
    camera.far = Math.max(2000, distance * 10);
    camera.updateProjectionMatrix();
    fitDistanceRef.current = distance;
    controls.maxDistance = Math.max(600, distance * 5);
    controls.target.copy(target);
    controls.update();
    resizeRef.current?.();
    cameraCenterRef.current = { x: cx, z: cz };
  // ``activeOffset`` gehört nicht hierher: ein Ebenenwechsel passt nicht neu ein,
  // er verschiebt nur (Wechsel-Effekt unten).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, cameraReset]);

  // Die Bühnenhöhe steht erst fest, wenn die nachgeladene 3D-Werkzeugleiste
  // eingehängt ist. Ein einmaliges Nacheinpassen (nach einer kurzen Ruhe)
  // verhindert, dass die Halle danach zu klein oder angeschnitten im Bild steht.
  const heightFixRef = useRef(false);
  useEffect(() => {
    if (!ready || height == null || heightFixRef.current) return;
    const t = window.setTimeout(() => {
      heightFixRef.current = true;
      setCameraReset((n) => n + 1);
    }, 140);
    return () => window.clearTimeout(t);
  }, [ready, height]);

  // Sobald weitere Ebenen eingeblendet werden, einmal weit genug aufziehen:
  // der Stapel ragt nach oben und darf nicht hinter dem Bildrand verschwinden.
  const levelFitRef = useRef(0);
  useEffect(() => {
    if (levels.length > 0 && levelFitRef.current === 0) setCameraReset((n) => n + 1);
    levelFitRef.current = levels.length;
  }, [levels.length]);
  // Kommt später eine Ebene dazu oder fällt weg: den Blick nur senkrecht auf die
  // Stapelmitte schieben und, wenn nötig, etwas aufziehen — nie zurückdrehen.
  const levelSig = levels.map((l) => `${l.id}@${l.offset.toFixed(2)}`).join(",");
  const levelSigRef = useRef(levelSig);
  // Der Boden (Hof, Kartenkacheln) liegt auf Höhe des EG. Nur das EG passt
  // dadurch auf die Karte; ein KG liegt darunter, obere Ebenen darüber.
  const groundY = 0;
  useEffect(() => {
    const prev = levelSigRef.current;
    levelSigRef.current = levelSig;
    if (!ready || prev === levelSig || levelFitRef.current === 0) return;
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls || walkRef.current.on) return;
    const { top, bottom } = stackExtent(levels, hallH, activeOffset);
    const toTarget = controls.target.clone();
    toTarget.y = levels.length ? (top + bottom) / 2
      : activeOffset + Math.min(4.5, Math.max(1.5, (top - activeOffset) / 2));
    const dir = camera.position.clone().sub(controls.target);
    const dist = dir.length();
    const need = (Math.max(6, top - bottom) / 2) / Math.tan(rad(camera.fov / 2)) * 1.25;
    const toPos = toTarget.clone().addScaledVector(dir.normalize(), Math.max(dist, need));
    flyRef.current = { start: performance.now(), fromPos: camera.position.clone(), toPos,
      fromTarget: controls.target.clone(), toTarget, ms: 600 };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, levelSig]);

  // Sobald die erste Nachbarhalle da ist, einmal weit genug aufziehen, damit
  // das Häkchen nicht nur eine unsichtbare Halle hinter dem Rand einschaltet.
  const neighborFitRef = useRef(0);
  useEffect(() => {
    if (neighborHalls.length > 0 && neighborFitRef.current === 0) setCameraReset((n) => n + 1);
    neighborFitRef.current = neighborHalls.length;
  }, [neighborHalls.length]);

  /* Wechsel der aktiven Ebene oder Halle: die Welt bleibt stehen, nur die
     Achsen wechseln (2026-11-07). Bis dahin passte jede neue Ebene die Kamera
     neu ein (Drehung und Zoom weg), und eine andere Halle verschob den Blick
     um den Unterschied der Hallenmitten — die Nachbarhallen sprangen.
     - gleiche Halle: dieselben Achsen; ohne Stapel gleitet der Blick um den
       Höhenunterschied, mit Stapel bleibt er (der Stapel ist derselbe);
     - Nachbarhalle, die schon im Bild stand: Kamera und Ziel werden in deren
       Achsen umgerechnet — kein Sprung; die verlassene Halle bleibt an der
       Stelle, an der man sie eben sah (``walkBack``, auch ohne Kartenanker);
     - sonst: wie bisher auf die neue Hallenmitte schieben. */
  const prevPlacesRef = useRef<NeighborPlacement[]>([]);
  const prevSceneRef = useRef<{ floorId: number; hallId: number; offset: number } | null>(null);
  useEffect(() => {
    if (!ready) return;
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls) return;
    const hallId = floor.hall_id ?? -1;
    const prev = prevSceneRef.current;
    prevSceneRef.current = { floorId: floor.id, hallId, offset: activeOffset };
    const b = sceneBounds(floor, stations);
    const center = { x: b.x + b.w / 2, z: b.y + b.h / 2 };
    const previousCenter = cameraCenterRef.current;
    cameraCenterRef.current = center;
    if (!prev) return;
    const walking = walkRef.current.on;
    if (prev.hallId === hallId) {
      // Dieselben Achsen. Mit Stapel kümmert sich ``levelSig`` um die Mitte.
      const dy = activeOffset - prev.offset;
      if (walking || levels.length || Math.abs(dy) < 1e-6) return;
      const toPos = camera.position.clone(); toPos.y += dy;
      const toTarget = controls.target.clone(); toTarget.y += dy;
      flyRef.current = { start: performance.now(), fromPos: camera.position.clone(), toPos,
        fromTarget: controls.target.clone(), toTarget, ms: reduceMotionRef.current ? 1 : 650 };
      return;
    }
    const place = prevPlacesRef.current.find((p) => p.hall.id === hallId);
    if (place) {
      const h = { x: place.x, y: place.y, rotation_deg: place.hall.rotation_deg };
      // Die verlassene Halle steht in den neuen Achsen genau dort, wo man sie sah.
      if (prev.hallId >= 0) setWalkBack({ hallId: prev.hallId, toHallId: hallId, ...inversePlacement(h) });
      if (walking) return;
      // Wo stand diese Ebene eben im Bild? Ihr Boden liegt jetzt auf ``activeOffset``.
      const was = prevPlacesRef.current.find((p) => p.hall.id === hallId && p.hall.floor.id === floor.id);
      const dy = was ? activeOffset - (prev.offset + was.hall.elevation_m) : 0;
      const move = (v: THREE.Vector3) => {
        const [x, z] = unplacePoint([v.x, v.z], h);
        v.set(x, v.y + dy, z);
      };
      flyRef.current = null;
      move(camera.position);
      move(controls.target);
      camera.lookAt(controls.target);
      controls.update();
      return;
    }
    if (walking || !previousCenter) return;
    const dx = center.x - previousCenter.x;
    const dz = center.z - previousCenter.z;
    const dy = activeOffset - prev.offset;
    controls.target.x += dx;
    controls.target.z += dz;
    controls.target.y += dy;
    camera.position.x += dx;
    camera.position.z += dz;
    camera.position.y += dy;
    controls.update();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, floor.id, activeOffset]);
  // Erst nach dem Wechsel-Effekt: er braucht die Lage *vor* dem Wechsel.
  useEffect(() => { prevPlacesRef.current = neighborPlaces; }, [neighborPlaces]);

  // Die Szene aus den Metern bauen.
  useEffect(() => {
    if (!ready) return;
    const scene = sceneRef.current;
    if (!scene) return;
    const buildStart = performance.now();
    // Ein laufendes Ziehen endet mit dem alten Bild: die gemerkten Objekte
    // werden gleich freigegeben (Statusabruf, Ebenenwechsel, Auswahl).
    cancelCarryRef.current?.();
    if (rootGroupRef.current) {
      rootGroupRef.current.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
      scene.remove(rootGroupRef.current);
      // Bis 2026-11-07 blieb die alte Halle im Grafikspeicher (nur entfernt,
      // nie freigegeben). Geteilte Gerätematerialien überspringt disposeTree.
      disposeTree(rootGroupRef.current);
    }
    lineMaterialsRef.current = [];
    dashMaterialsRef.current = [];
    motionRef.current = [];
    flowRoutesRef.current = [];
    conveyorsRef.current = [];

    const root = new THREE.Group();
    root.name = "hall-root";
    // Die aktive Ebene kann unter dem EG liegen (KG): dann steht die ganze
    // Halle unter dem Boden. Obere Ebenen stehen entsprechend darüber.
    root.position.y = activeOffset;
    rootGroupRef.current = root;
    scene.add(root);
    /** Alles, was eine Station im Bild ausmacht, merkt sich seine Ausgangslage.
        So folgt sie beim Ziehen im Begehen der Maus, ohne die Szene neu zu bauen;
        erst das Ablegen schreibt die neue Lage. */
    const hallColor = new THREE.Color(css("--g-floor-hall", "#f6f7f9"));
    const sideColor = new THREE.Color(css("--g-iso-side", "#343d47"));
    const sideColor2 = sideColor.clone().multiplyScalar(0.86);
    const topColor = new THREE.Color(css("--g-iso-top", "#4f5b69"));
    const lineColor = new THREE.Color(css("--g-iso-side-line", "#14191f"));

    // Eine ruhige Außenfläche unter der Halle: ohne Karte steht das Gebäude
    // nicht im Nichts, mit Karte bildet sie den Hof um die Kartenkacheln.
    // Deckend, damit der Nachthimmel nicht durch den Boden scheint.
    const bounds = sceneBounds(floor, stations);
    const apronSize = Math.max(220, Math.max(bounds.w, bounds.h) * 4);
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(apronSize, apronSize),
      new THREE.MeshBasicMaterial({
        color: css("--g-floor-apron", "#e9e4d7"),
        depthWrite: true, toneMapped: false,
      }),
    );
    apron.rotation.x = -Math.PI / 2;
    // Der Hof bleibt auf Bodenhöhe (EG), auch wenn die aktive Ebene tiefer liegt.
    apron.position.set(bounds.x + bounds.w / 2, -activeOffset + groundY - 0.12, bounds.y + bounds.h / 2);
    apron.renderOrder = -2;
    root.add(apron);

    const boreHoles = (floor.obstacles ?? []).filter((o) => isFloorHoleObstacle(o) && (o.points?.length ?? 0) >= 3).map((o) => o.points);
    const stairHoles = [...stairWellHoles(links), ...boreHoles];
    const floorGeo = floorGeometry(floor.outline ?? [], stairHoles);
    const floorMesh = new THREE.Mesh(floorGeo, new THREE.MeshBasicMaterial({
      color: hallColor, side: THREE.DoubleSide,
    }));
    floorMesh.position.y = 0;
    root.add(floorMesh);

    // Raster wie auf der Karte; die Textur liegt direkt auf dem Hallenboden.
    if (vis.grid) {
      const gridM = floor.grid && floor.grid > 0 ? floor.grid : 1;
      const tex = patternTexture("grid", css("--g-floor-grid", "#dce0e5"), gridM);
      const grid = new THREE.Mesh(floorGeometry(floor.outline ?? [], stairHoles), new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
      }));
      grid.position.y = 0.005;
      grid.renderOrder = 1;
      root.add(grid);
    }

    // Zonen: Fläche und gestrichelte Kante.
    if (vis.zones) {
      for (const z of floor.zones ?? []) {
        if (!z.points || z.points.length < 3) continue;
        const zoneColor = new THREE.Color(z.colour || "#8e5cb8");
        const fill = new THREE.Mesh(floorGeometry(z.points), new THREE.MeshBasicMaterial({
          color: zoneColor, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide,
        }));
        fill.position.y = 0.012;
        fill.renderOrder = 2;
        root.add(fill);
        const pts = z.points.map(([x, y]) => new THREE.Vector3(x, 0.018, y));
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]),
          new THREE.LineDashedMaterial({ color: zoneColor, transparent: true, opacity: 0.55, dashSize: 0.6, gapSize: 0.35 }),
        );
        line.computeLineDistances();
        root.add(line);
        if (vis.labels && z.name) {
          const zx = z.points.reduce((a, p) => a + p[0], 0) / z.points.length;
          const zy = z.points.reduce((a, p) => a + p[1], 0) / z.points.length;
          const el = document.createElement("div");
          el.textContent = z.name;
          addCssLabel(root, el, zx, 0.2, zy, "three-zone-label");
        }
      }
    }

    // Wände als schmale Körper; die Oberkante bekommt eine dunkle Linie.
    // Türen sind Öffnungen: die Wand läuft nicht durch ein Tor hindurch.
    const outline = floor.outline ?? [];
    const sameElevNeighbors = neighborPlaces
      .filter((p) => Math.abs(p.hall.elevation_m) < 0.8)
      .map((p) => ({ id: p.hall.id, x: p.x, y: p.y, rotation_deg: p.hall.rotation_deg, floor: p.hall.floor }));
    const activePlacement = { id: floor.id ?? -1, x: 0, y: 0, rotation_deg: 0, floor };
    const sharedNeighborDoors = sameElevNeighbors.length
      ? sharedBoundaryDoors(activePlacement, [activePlacement, ...sameElevNeighbors])
      : [];
    const allActiveDoors = [...(floor.doors ?? []), ...sharedNeighborDoors];
    if (outline.length >= 3) {
      const wallMat = new THREE.MeshBasicMaterial({ color: sideColor });
      const topPoints: THREE.Vector3[] = [];
      const wallSegs = vis.doors ? wallPieces(outline, allActiveDoors) : wallPieces(outline);
      for (const { a: [ax, ay], b: [bx, by] } of wallSegs) {
        const dx = bx - ax, dz = by - ay;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, 0.14), wallMat);
        wall.position.set((ax + bx) / 2, WALL_H / 2, (ay + by) / 2);
        wall.rotation.y = -Math.atan2(dz, dx);
        root.add(wall);
      }
      for (const [x, y] of outline) topPoints.push(new THREE.Vector3(x, WALL_H, y));
      if (topPoints.length) {
        const rim = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(topPoints),
          new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.9 }),
        );
        root.add(rim);
      }
    }

    // Hallenhülle: über dem niedrigen Sockel stehen durchscheinende Wände,
    // Stützen an den Ecken und ein Dachgerüst. Das Gebäude wird lesbar, ohne
    // den Blick in die Halle zu verstellen — deshalb kein deckendes Dach,
    // solange es nicht ausdrücklich eingeschaltet ist.
    if (vis.shell && outline.length >= 3) {
      const shell = new THREE.Group();
      shell.name = "hall-shell";
      root.add(shell);
      const glassMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(css("--g-hall-glass", "#b9d4e8")), transparent: true,
        opacity: 0.075, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
      });
      const frameMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(css("--g-hall-frame", "#8d99a6")), transparent: true,
        opacity: 0.55, toneMapped: false,
      });
      const columnMat = new THREE.MeshBasicMaterial({ color: sideColor, toneMapped: false });
      const upper = Math.max(0.6, hallH - WALL_H);
      for (let i = 0; i < outline.length; i++) {
        const [ax, ay] = outline[i];
        const [bx, by] = outline[(i + 1) % outline.length];
        const dx = bx - ax, dz = by - ay;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        const mx = (ax + bx) / 2, mz = (ay + by) / 2;
        const turn = -Math.atan2(dz, dx);
        const pane = new THREE.Mesh(new THREE.BoxGeometry(len, upper, 0.05), glassMat);
        pane.position.set(mx, WALL_H + upper / 2, mz);
        pane.rotation.y = turn;
        shell.add(pane);
        // Senkrechte Sprossen alle ~6 m.
        const parts = Math.max(1, Math.round(len / 6));
        for (let k = 1; k < parts; k++) {
          const u = k / parts;
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, upper, 0.09), frameMat);
          post.position.set(ax + dx * u, WALL_H + upper / 2, ay + dz * u);
          shell.add(post);
        }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(len, 0.16, 0.16), frameMat);
        beam.position.set(mx, hallH, mz);
        beam.rotation.y = turn;
        shell.add(beam);
      }
      // Eckstützen mit Fußplatte.
      for (const [x, y] of outline) {
        const col = new THREE.Mesh(new THREE.BoxGeometry(0.3, hallH, 0.3), columnMat);
        col.position.set(x, hallH / 2, y);
        shell.add(col);
        const foot = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.07, 0.48), columnMat);
        foot.position.set(x, 0.035, y);
        shell.add(foot);
      }
      // Dachträger, Pfetten, Dachfläche und Lichtbänder — strikt auf den
      // Hallenumriss geklippt und mit Rücksicht auf darüberliegende Geschosse.
      const aboveActive = levels
        .filter((lv) => lv.offset > activeOffset + 1e-3 && (lv.floor.outline?.length ?? 0) >= 3)
        .map((lv) => lv.floor.outline);
      addRoofStructure(shell, outline, hallH, {
        roof: vis.roof,
        aboveOutlines: aboveActive,
        frameMat,
        glassMat,
      });
    }

    // Hindernisse: Stützen, Wände, Raumboxen und Regale in ihrer echten Höhe.
    if (vis.obstacles) {
      const ceiling = Math.max(3, Number(floor.height_m) || 6);
      for (const o of floor.obstacles ?? []) {
        if (!o.points || o.points.length < 3) continue;
        if (isFloorHoleObstacle(o)) {
          // Bodenbohrung / Aussparung: nur eine flache Sicherheitskante um das Loch zeichnen.
          const rimPts = o.points.map(([x, y]) => new THREE.Vector3(x, 0.03, y));
          root.add(new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(rimPts),
            new THREE.LineBasicMaterial({ color: new THREE.Color(css("--gimel-accent", "#0b7a67")), transparent: true, opacity: 0.9 }),
          ));
          continue;
        }
        const h = obstacleHeight(o, ceiling);
        const kind = obstacleKind(o);
        const solid = kind === "wall" || kind === "room" || kind === "column" || kind === "round_column";
        const isFence = kind === "fence";
        // Innenraum (Raumbox) oder Innen-/Trennwand mit Tür: offene Wandstücke statt massivem Block,
        // damit die Türöffnung in 3D sichtbar und begehbar bleibt.
        if (vis.doors && obstacleHasDoor(o, allActiveDoors)) {
          const wallMat = new THREE.MeshBasicMaterial({
            color: sideColor, transparent: true, opacity: 0.88, toneMapped: false,
          });
          const edgeMat = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.8 });
          for (const { a: [ax, az], b: [bx, bz] } of obstacleWallPieces(o, allActiveDoors)) {
            const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
            if (len < 1e-4) continue;
            const segGeo = new THREE.BoxGeometry(len, h, 0.14);
            const segMesh = new THREE.Mesh(segGeo, wallMat);
            segMesh.position.set((ax + bx) / 2, h / 2, (az + bz) / 2);
            segMesh.rotation.y = -Math.atan2(dz, dx);
            segMesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(segGeo), edgeMat));
            root.add(segMesh);
          }
          if (kind === "room") {
            const lid = new THREE.Mesh(
              floorGeometry(o.points),
              new THREE.MeshBasicMaterial({
                color: css("--g-surface-2", "#8a96a3"),
                transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
              }),
            );
            lid.position.y = h + 0.005;
            root.add(lid);
          }
          continue;
        }
        const geo = new THREE.ExtrudeGeometry(floorShape(o.points), { depth: h, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const topMat = new THREE.MeshBasicMaterial({
          color: kind === "room" ? css("--g-surface-2", "#8a96a3") : css("--g-floor-hatch", "#738091"),
          transparent: true, opacity: solid ? 0.78 : isFence ? 0.16 : 0.38, side: THREE.DoubleSide,
        });
        const sideMat = new THREE.MeshBasicMaterial({
          color: isFence ? css("--g-floor-warn", "#c4520a") : sideColor,
          transparent: true, opacity: solid ? 0.84 : isFence ? 0.32 : 0.55,
        });
        const mesh = new THREE.Mesh(geo, [topMat, sideMat]);
        mesh.add(new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: isFence ? css("--g-floor-warn", "#c4520a") : lineColor, transparent: true, opacity: solid ? 0.8 : 0.55 }),
        ));
        const hatch = new THREE.Mesh(
          floorGeometry(o.points),
          new THREE.MeshBasicMaterial({
            map: patternTexture("hatch", css("--g-floor-hatch", "#738091"), 0.34),
            transparent: true, opacity: solid ? 0.25 : 0.45, depthWrite: false, side: THREE.DoubleSide,
          }),
        );
        hatch.position.y = h + 0.008;
        root.add(mesh, hatch);
      }
    }

    // Förderbänder (task 37): Hallenausstattung, keine Station. Über Gängen als Brücke.
    {
      const p = paletteOf({ ...DEVICE_STYLE, ...deviceStyleFromTokens(css), accent: css("--g-dev-safety", "#f2c230") });
      for (const c of floor.conveyors ?? []) {
        const pts = conveyorPoints(c);
        if (pts.length < 2) continue;
        const model = buildConveyor(pts, conveyorWidth(c), p);
        model.root.position.y = 0.01;
        root.add(model.root);
        conveyorsRef.current.push({ points: pts, textures: model.beltTextures });
        if (vis.labels) {
          const top = pts.reduce((a, q) => (q[2] > a[2] ? q : a), pts[0]);
          const el = document.createElement("div");
          el.textContent = c.name || "Förderband";
          addCssLabel(root, el, top[0], top[2] + 1.3, top[1], "three-zone-label");
        }
      }
    }

    // Gänge als Fahrspuren: Fläche, Rand, gestrichelte Mittellinie,
    // Richtungspfeile und Knoten. Dieselbe Geometrie wie Plan und Semi-3D.
    if (vis.aisles) {
      const aisleColor = new THREE.Color(css("--g-floor-aisle", "#3f7fb8"));
      const laneFill = new THREE.Color(css("--g-floor-aisle-lane", "#dbe9f5"));
      const laneEdge = new THREE.Color(css("--g-floor-aisle-edge", "#9dbfdc"));
      const laneWays = displayWays.filter((w) => vis.paths || w.kind === "edge");
      if (vis.lanes) {
        for (const way of laneWays) {
          const poly = lanePolygon(way.points, AISLE_LANE_M);
          if (poly.length < 3) continue;
          const fill = new THREE.Mesh(floorGeometry(poly), new THREE.MeshBasicMaterial({
            color: laneFill, transparent: true, opacity: way.kind === "path" ? 0.62 : 0.88,
            depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
          }));
          fill.position.y = 0.016;
          fill.renderOrder = 1;
          root.add(fill);
          // Der Rand als breite Linie: eine WebGL-Linie mit 1 px wäre aus der
          // Entfernung verschwunden, die Spur soll aber als Fläche lesbar sein.
          const ringMat = new LineMaterial({
            color: laneEdge, linewidth: 1.5, transparent: true, opacity: 0.75,
            depthWrite: false, worldUnits: false,
          });
          ringMat.resolution.set(1, 1);
          lineMaterialsRef.current.push(ringMat);
          const ring = new Line2(
            new LineGeometry().setPositions([...poly, poly[0]].flatMap(([x, y]) => [x, 0.022, y])),
            ringMat,
          );
          ring.renderOrder = 2;
          root.add(ring);
        }
      }
      for (const way of laneWays) {
        const positions: number[] = [];
        for (const [x, y] of way.points) positions.push(x, 0.032, y);
        if (positions.length < 6) continue;
        const mat = new LineMaterial({
          color: aisleColor, linewidth: way.kind === "path" ? 1.8 : 1.3,
          transparent: true, opacity: way.kind === "path" ? 0.8 : 0.5,
          dashed: way.kind !== "path", dashSize: 0.5, gapSize: 0.35, depthWrite: false,
        });
        mat.resolution.set(1, 1);
        lineMaterialsRef.current.push(mat);
        const line = new Line2(new LineGeometry().setPositions(positions), mat);
        line.computeLineDistances();
        line.renderOrder = 5;
        root.add(line);
        if (vis.labels) {
          const chevMat = new LineMaterial({
            color: aisleColor, linewidth: 1.6, transparent: true, opacity: 0.5,
            depthWrite: false, worldUnits: false,
          });
          chevMat.resolution.set(1, 1);
          lineMaterialsRef.current.push(chevMat);
          for (const arrow of wayArrows(way.points)) {
            const [dx, dy] = arrow.dir;
            const px = -dy, py = dx;
            const [ax, ay] = arrow.at;
            const cGeo = new LineGeometry().setPositions([
              ax - dx * 0.3 + px * 0.2, 0.038, ay - dy * 0.3 + py * 0.2,
              ax + dx * 0.22, 0.038, ay + dy * 0.22,
              ax - dx * 0.3 - px * 0.2, 0.038, ay - dy * 0.3 - py * 0.2,
            ]);
            const chev = new Line2(cGeo, chevMat);
            chev.renderOrder = 6;
            root.add(chev);
          }
        }
      }
      for (const [x, y] of floor.aisles?.nodes ?? []) {
        const dot = new THREE.Mesh(
          new THREE.CircleGeometry(0.12, 14),
          new THREE.MeshBasicMaterial({ color: aisleColor, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }),
        );
        dot.rotation.x = -Math.PI / 2;
        dot.position.set(x, 0.034, y);
        dot.renderOrder = 6;
        root.add(dot);
      }
    }

    // Türen, Hallentore, Laderampen, Notausgänge & Fensterbänder in 3D.
    // Treppen & Aufzüge werden darunter durch buildVerticalLink als eigene 3D-Körper gebaut.
    if (vis.doors) {
      for (const d of floor.doors ?? []) {
        const dk = effectiveDoorKind(d);
        if (dk === "stair" || dk === "lift") continue;
        const w = Math.max(0.5, Number(d.width) || (dk === "gate" ? 4.0 : dk === "ramp" ? 3.2 : dk === "window" ? 3.0 : 1.2));
        const colour = dk === "gate" ? css("--g-floor-warn", "#c4520a")
          : dk === "ramp" ? css("--g-flow-supply", "#8e5cb8")
          : dk === "emergency" ? "#16a34a"
          : dk === "window" ? "#0284c7"
          : css("--g-flow-ship", "#217e56");
        const [ux, uy] = doorDirection(floor, d);
        const turn = -Math.atan2(uy, ux);
        const doorGroup = new THREE.Group();
        doorGroup.position.set(d.x, 0, d.y);
        doorGroup.rotation.y = turn;

        const accentMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colour), toneMapped: false });
        const darkMat = new THREE.MeshBasicMaterial({ color: sideColor, toneMapped: false });

        if (dk === "window") {
          const sillH = 1.0;
          const topH = Math.min(2.6, Math.max(1.8, hallH - 0.4));
          const paneH = Math.max(0.5, topH - sillH);
          // Brüstung + Sturz + Pfosten
          const sill = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.1, 0.18), accentMat);
          sill.position.set(0, sillH, 0);
          const lintel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.1, 0.18), accentMat);
          lintel.position.set(0, topH, 0);
          doorGroup.add(sill, lintel);
          for (const sign of [-1, 1]) {
            const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.1, paneH, 0.16), accentMat);
            jamb.position.set(sign * (w / 2), sillH + paneH / 2, 0);
            doorGroup.add(jamb);
          }
          const pane = new THREE.Mesh(
            new THREE.BoxGeometry(Math.max(0.2, w - 0.1), paneH, 0.06),
            new THREE.MeshBasicMaterial({
              color: 0x38bdf8, transparent: true, opacity: 0.34, side: THREE.DoubleSide, toneMapped: false,
            }),
          );
          pane.position.set(0, sillH + paneH / 2, 0);
          doorGroup.add(pane);
          // Senkrechte Sprossen alle ~1,5 m
          const mullions = Math.max(0, Math.floor(w / 1.5) - 1);
          for (let m = 1; m <= mullions; m++) {
            const mx = -w / 2 + (w * m) / (mullions + 1);
            const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, paneH, 0.09), accentMat);
            bar.position.set(mx, sillH + paneH / 2, 0);
            doorGroup.add(bar);
          }
        } else {
          // Boden-Schwelle (flach, blockiert keinen Durchgang)
          const threshold = new THREE.Mesh(
            new THREE.BoxGeometry(w, 0.03, 0.24),
            new THREE.MeshBasicMaterial({ color: new THREE.Color(colour), transparent: true, opacity: 0.72, toneMapped: false }),
          );
          threshold.position.set(0, 0.015, 0);
          doorGroup.add(threshold);

          const frameH = dk === "gate"
            ? Math.min(4.2, hallH - 0.45)
            : dk === "ramp"
              ? Math.min(3.6, hallH - 0.45)
              : Math.min(2.25, hallH - 0.3);

          if (vis.shell) {
            for (const sign of [-1, 1]) {
              const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, frameH, 0.18), accentMat);
              post.position.set(sign * (w / 2), frameH / 2, 0);
              doorGroup.add(post);
            }
            const lintel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.14, 0.14, 0.18), accentMat);
            lintel.position.set(0, frameH, 0);
            doorGroup.add(lintel);

            if (dk === "gate") {
              // Sektionaltor-Kasten oben am Sturz
              const shutter = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.3, w - 0.12), 0.42, 0.2), darkMat);
              shutter.position.set(0, frameH - 0.24, 0);
              doorGroup.add(shutter);
            } else if (dk === "ramp") {
              // Gummipuffer links & rechts an der Laderampe
              for (const sign of [-1, 1]) {
                const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.75, 0.28), darkMat);
                bumper.position.set(sign * (w / 2 + 0.04), 0.95, 0.12);
                doorGroup.add(bumper);
              }
            } else if (dk === "emergency") {
              // Grünes Fluchtweg-Leuchtschild über dem Sturz
              const signBox = new THREE.Mesh(
                new THREE.BoxGeometry(Math.min(0.9, w * 0.7), 0.22, 0.08),
                new THREE.MeshBasicMaterial({ color: 0x22c55e, toneMapped: false }),
              );
              signBox.position.set(0, frameH + 0.2, 0);
              doorGroup.add(signBox);
            } else {
              // Leicht geöffnetes Türblatt (35°), sofort als Tür erkennbar
              const leafW = Math.min(w - 0.12, 1.15);
              if (leafW > 0.35) {
                const pivot = new THREE.Group();
                pivot.position.set(-w / 2 + 0.06, 0, 0);
                pivot.rotation.y = 0.6;
                const leaf = new THREE.Mesh(
                  new THREE.BoxGeometry(leafW, frameH - 0.1, 0.05),
                  new THREE.MeshBasicMaterial({
                    color: new THREE.Color(colour), transparent: true, opacity: 0.28, side: THREE.DoubleSide, toneMapped: false,
                  }),
                );
                leaf.position.set(leafW / 2, (frameH - 0.1) / 2, 0);
                pivot.add(leaf);
                doorGroup.add(pivot);
              }
            }
          }
        }
        root.add(doorGroup);

        if (vis.labels && d.name) {
          const el = document.createElement("div");
          el.textContent = d.name;
          const labelY = dk === "window" ? 2.75 : dk === "gate" ? Math.min(4.45, hallH - 0.2) : WALL_H + 0.3;
          addCssLabel(root, el, d.x, labelY, d.y, "three-door-label");
        }
      }
    }

    // Treppen und Aufzüge: Körper an der Wand, Schild, Bodenfeld davor. Beim
    // Begehen geht man die Treppe hinein; am Aufzug öffnet E die Ebenenwahl.
    if (vis.doors && links.length) {
      const vStyle = {
        body: css("--g-iso-top", "#4f5b69"), bodyDark: css("--g-iso-side", "#343d47"),
        steel: css("--g-floor-hatch", "#738091"), accent: css("--g-lift-pad", "#217e56"),
        signBg: css("--g-lift-sign-bg", "#1f2933"), signFg: css("--g-lift-sign-fg", "#f4f7fa"),
        light: css("--g-surface", "#f4f7fa"),
      };
      for (const l of links) root.add(buildVerticalLink(l, hallH, vStyle));
    }

    // Statusfarben und Auswahl einmal je Aufbau.
    const markById = new Map<number, StationMark>();
    for (const s of stations) if (s.id != null) markById.set(s.id, status[s.id]);
    // Auswahl und Suchtreffer wirken nicht mehr im Aufbau, sondern danach an
    // Ort und Stelle (Effekt „Auswahl", task 41 C): ein Klick baut nichts neu.
    const connected = (_s: Station) => true;

    const sectionStations = new THREE.Group();
    sectionStations.name = "stations";
    root.add(sectionStations);

    // Dieselben Tokens wie Wände und Böden; das Gerät bleibt damit Teil der
    // Halle und nicht ein Fremdkörper aus einer anderen Farbwelt.
    const deviceStyle: Partial<DeviceStyle> = {
      ...deviceStyleFromTokens(css),
      body: css("--g-iso-top", "#4f5b69"),
      bodyDark: css("--g-iso-side", "#343d47"),
      metal: css("--g-floor-hatch", "#738091"),
      line: css("--g-iso-side-line", "#14191f"),
    };

    const shadowTex = groundShadowTexture();

    // Ein Gerät aus der eingebauten Bibliothek. Es ersetzt den Kasten, lässt
    // aber dessen Statuskanten, Lastbalken und Klickziel stehen.
    const installBuiltIn = (
      s: Station, box: THREE.Mesh, edges: THREE.LineSegments,
      label: CSS2DObject | null, h: number, opacity: number, mark: StationMark | undefined,
    ) => {
      const device = buildDeviceModel(s, deviceStyle, {
        status: mark?.kind, running: !!mark?.running || mark?.kind === "laeuft",
        screen: mark?.running ? jobScreen(mark.running, s.colour || "#1668ac") : undefined,
      });
      device.position.set(s.x, 0.018, s.y);
      device.rotation.y = -rad(s.rotation);
      tagStationMove(device, s);
      device.traverse((o) => {
        if (o instanceof THREE.Mesh) o.userData = { ...(o.userData ?? {}), station: s };
      });
      setDeviceOpacity(device, opacity);
      // Erst nach dem Abdunkeln: die Signalleuchte behält die Deckkraft der
      // Station, sonst leuchtete eine ausgeblendete Maschine wieder auf.
      collectMotion(device, !!mark?.running || mark?.kind === "laeuft", motionRef.current);
      sectionStations.add(device);
      applySelectionRef.current?.();
      box.visible = false;
      edges.visible = false;
      if (label) {
        const top = new THREE.Box3().setFromObject(device).max.y;
        label.position.y = Math.max(h, top) + 0.42;
      }
    };

    for (const s of stations) {
      if (s.id == null) continue;
      const mark = markById.get(s.id);
      if (!mark) continue;
      const h = heightOf(s);
      const hollow = mark.kind === "frei" || mark.kind === "unbekannt" || mark.kind === "inaktiv";
      const dim = !s.active || !connected(s);
      const opacity = dim ? 0.42 : 1;
      const selected = false;
      const highlighted = false;

      // Weicher Schatten unter dem Körper.
      const shadowRig = new THREE.Group();
      shadowRig.position.set(s.x, 0, s.y);
      shadowRig.rotation.y = -rad(s.rotation);
      tagStationMove(shadowRig, s);
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(s.w + 1.15, s.h + 1.15),
        new THREE.MeshBasicMaterial({
          map: shadowTex, color: 0x000000, transparent: true, opacity: dim ? 0.12 : 0.24,
          depthWrite: false,
        }),
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.012;
      shadow.renderOrder = 4;
      shadowRig.add(shadow);
      root.add(shadowRig);

      const group = new THREE.Group();
      group.position.set(s.x, h / 2, s.y);
      group.rotation.y = -rad(s.rotation);
      tagStationMove(group, s);
      root.add(group);

      const topMat = new THREE.MeshBasicMaterial({
        color: hollow ? hallColor : topColor, transparent: opacity < 1, opacity,
      });
      const sideMat = new THREE.MeshBasicMaterial({ color: sideColor, transparent: opacity < 1, opacity });
      const sideMat2 = new THREE.MeshBasicMaterial({ color: sideColor2, transparent: opacity < 1, opacity });
      const boxGeo = new THREE.BoxGeometry(s.w, h, s.h);
      const box = new THREE.Mesh(boxGeo, [sideMat, sideMat2, topMat, sideMat2, sideMat, sideMat2]);
      box.userData = { station: s };
      group.add(box);

      const edgeMat = new THREE.LineBasicMaterial({
        color: selected ? new THREE.Color(css("--gimel-accent", "#0b7a67")) : lineColor,
        transparent: true, opacity: selected ? 1 : (dim ? 0.7 : 0.75),
      });
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), edgeMat);
      edges.userData.selEdge = { colour: edgeMat.color.getHex(), opacity: edgeMat.opacity };
      group.add(edges);

      // Zustand auch als Fläche: Schraffur bei Überlast, Kreuz bei Stillstand.
      if (mark.kind === "ueber" || mark.kind === "inaktiv") {
        const tex = patternTexture(mark.kind === "ueber" ? "hatch" : "cross",
          mark.kind === "ueber" ? css("--g-iso-on", "#ffffff") : css("--g-floor-off-line", "#5f6b7c"), 0.4);
        tex.repeat.set(Math.max(1, s.w / 0.4), Math.max(1, s.h / 0.4));
        const pattern = new THREE.Mesh(
          new THREE.PlaneGeometry(Math.max(0.05, s.w - 0.06), Math.max(0.05, s.h - 0.06)),
          new THREE.MeshBasicMaterial({
            map: tex, transparent: true, opacity: dim ? 0.25 : 0.5, depthWrite: false,
          }),
        );
        pattern.rotation.x = -Math.PI / 2;
        pattern.position.y = h / 2 + 0.006;
        group.add(pattern);
      }

      // Statuskante auf dem Dach — dieselbe Sprache wie in der SVG-Karte.
      const statusMat = new THREE.MeshBasicMaterial({
        color: statusHex(mark.kind), transparent: opacity < 1, opacity: dim ? 0.6 : 0.95,
      });
      const statusEdge = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(0.12, s.w - 0.2), selected ? 0.055 : 0.036, selected ? 0.075 : 0.055),
        statusMat,
      );
      statusEdge.position.set(0, h / 2 + 0.012, s.h / 2 - 0.035);
      statusEdge.userData.selStatus = true;
      group.add(statusEdge);

      // Laufende Station: die helle Kante links auf dem Dach.
      if (mark.running) {
        const runEdge = new THREE.Mesh(
          new THREE.BoxGeometry(0.18, 0.02, Math.max(0.15, s.h - 0.2)),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: dim ? 0.3 : 0.9 }),
        );
        runEdge.position.set(-s.w / 2 + 0.11, h / 2 + 0.008, 0);
        group.add(runEdge);
      }

      // Lastbalken hinten auf dem Dach.
      if (mark.ratio != null && mark.ratio > 0) {
        const track = new THREE.Mesh(
          new THREE.BoxGeometry(Math.max(0.15, s.w - 0.2), 0.012, 0.2),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: dim ? 0.12 : 0.24 }),
        );
        track.position.set(0, h / 2 + 0.006, -s.h / 2 + 0.16);
        group.add(track);
        const fill = new THREE.Mesh(
          new THREE.BoxGeometry(Math.max(0.05, (s.w - 0.2) * Math.min(1, mark.ratio)), 0.016, 0.2),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: dim ? 0.35 : 0.9 }),
        );
        fill.position.set(-((s.w - 0.2) * (1 - Math.min(1, mark.ratio))) / 2, h / 2 + 0.012, -s.h / 2 + 0.16);
        group.add(fill);
      }

      // Auswahl- und Suchring liegen auf dem Boden.
      const ring = (color: string, grow: number) => {
        const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.95, depthWrite: false });
        const bars = new THREE.Group();
        const w = s.w + grow, d = s.h + grow;
        const bar = (bw: number, bd: number, x: number, z: number) => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.025, bd), mat);
          m.position.set(x, 0.03, z);
          bars.add(m);
        };
        bar(w, 0.055, 0, d / 2);
        bar(w, 0.055, 0, -d / 2);
        bar(0.055, d, w / 2, 0);
        bar(0.055, d, -w / 2, 0);
        bars.rotation.y = -rad(s.rotation);
        bars.position.set(s.x, 0, s.y);
        tagStationMove(bars, s);
        bars.renderOrder = 8;
        root.add(bars);
      };
      if (highlighted) ring(css("--gimel-accent", "#0b7a67"), 0.4);
      if (selected) ring(css("--gimel-accent", "#0b7a67"), 0.24);

      // Beschriftung über dem Körper (oder über dem Modell, sobald es da ist).
      let labelY = h + 0.42;
      let label: CSS2DObject | null = null;
      if (vis.labels) {
        const labelEl = document.createElement("div");
        labelEl.className = "three-station-label" + (hollow ? " three-station-label-hollow" : "")
          + (selected ? " three-station-label-selected" : "")
          + (dim || !s.active ? " three-station-label-off" : "");
        labelEl.style.setProperty("--three-status", `#${statusHex(mark.kind).toString(16).padStart(6, "0")}`);
        labelEl.dataset.urgency = String(LABEL_URGENCY[mark.kind] ?? 0);
        labelEl.dataset.stationId = String(s.id);
        labelEl.innerHTML = `<b>${escapeHtml(s.label)}</b><span>${escapeHtml(mark.line)}</span>`;
        labelEl.style.pointerEvents = "auto";
        labelEl.style.cursor = "pointer";
        labelEl.setAttribute("role", "button");
        labelEl.setAttribute("aria-label", `${s.label}: ${mark.word}`);
        labelEl.tabIndex = 0;
        labelEl.addEventListener("click", (ev) => {
          ev.stopPropagation();
          clickRef.current?.(s);
        });
        labelEl.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            clickRef.current?.(s);
          }
        });
        label = addCssLabel(root, labelEl, s.x, labelY, s.y);
        if (label) tagStationMove(label, s);
      }

      if (s.model_file) {
        void loadStationModelFile(s).then((source) => {
          if (rootGroupRef.current !== root) return;
          invalidate();
          if (!source) { installBuiltIn(s, box, edges, label, h, opacity, mark); return; }
          const model = fitStationModel(s, source);
          const box3 = new THREE.Box3().setFromObject(model);
          const top = Math.max(h, box3.max.y);
          model.position.set(s.x, 0.018, s.y);
          model.rotation.y = -rad(s.rotation + (s.model_rotation || 0));
          tagStationMove(model, s);
          model.traverse((o) => {
            if (o instanceof THREE.Mesh) o.userData = { ...(o.userData ?? {}), station: s };
          });
          sectionStations.add(model);

          // Der Körper weicht dem Modell; ein flacher Sockel hält den Status.
          group.visible = false;
          const plinth = new THREE.Group();
          plinth.position.set(s.x, 0, s.y);
          plinth.rotation.y = -rad(s.rotation);
          tagStationMove(plinth, s);
          const base = new THREE.Mesh(
            new THREE.BoxGeometry(s.w + 0.06, 0.055, s.h + 0.06),
            new THREE.MeshBasicMaterial({ color: sideColor, transparent: opacity < 1, opacity }),
          );
          base.position.y = 0.0275;
          plinth.add(base);
          const baseStatus = new THREE.Mesh(
            new THREE.BoxGeometry(Math.max(0.12, s.w - 0.2), 0.03, 0.055),
            new THREE.MeshBasicMaterial({ color: statusHex(mark.kind), transparent: opacity < 1, opacity: 0.95 }),
          );
          baseStatus.position.set(0, 0.055, s.h / 2 - 0.03);
          plinth.add(baseStatus);
          root.add(plinth);
          if (label) label.position.y = top + 0.42;
          applySelectionRef.current?.();
        }).catch((e) => {
          console.warn("Gimel 3D: Modell konnte nicht geladen werden", s.model_file, e);
          // Kein CAD, kein leerer Kasten: die Gerätebibliothek springt ein.
          installBuiltIn(s, box, edges, label, h, opacity, mark);
        });
      } else {
        installBuiltIn(s, box, edges, label, h, opacity, mark);
      }
    }

    // Wege: flache, breite Linien mit Pfeilspitzen und laufender Markierung.
    if (vis.flow) {
      const byId = new Map<number, Station>();
      for (const s of stations) if (s.id != null) byId.set(s.id, s);
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

      for (const e of flow) {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) continue;
        const routed = routePoints(floor.aisles ?? { nodes: [], edges: [] },
          [a.x, a.y], [b.x, b.y], floor.obstacles ?? [], floor.outline ?? []);
        const fullRoute = routed.points.length ? routed.points : [[a.x, a.y] as [number, number], [b.x, b.y] as [number, number]];
        // Der Weg endet an der Kante der Maschine, nicht in ihrem Körper.
        // Gespeichert und entschieden bleibt ``fullRoute`` unangetastet.
        const freeRuns = clearPolyline(fullRoute, world, {
          radius: 0.35, groups: ["station", "obstacle"], step: 0.4,
        });
        const route = freeRuns.reduce<[number, number][] | null>(
          (best, r) => (!best || polylineLength(r) > polylineLength(best) ? r : best), null,
        ) ?? fullRoute;
        flowRoutesRef.current.push({ route, kind: e.kind, count: e.count });
        const colour = e.kind === "supply" ? css("--g-flow-supply", "#8e5cb8") : css("--g-flow-ship", "#217e56");
        // Ganggenau ist eine durchgehende Bahn, die Luftlinie gestrichelt:
        // niemand hält eine Schätzung für einen erfassten Weg.
        const exact = e.exact;
        const width = 1.8 + 2.6 * (e.count / maxFlow);
        const positions: number[] = [];
        for (const [x, y] of route) positions.push(x, 0.05, y);
        const geo = new LineGeometry().setPositions(positions);

        const shadowMat = new LineMaterial({
          color: 0x000000, linewidth: width + 5, transparent: true, opacity: 0.18,
          depthWrite: false, worldUnits: false,
        });
        shadowMat.resolution.set(1, 1);
        lineMaterialsRef.current.push(shadowMat);
        const shadow = new Line2(geo, shadowMat);
        shadow.position.y = -0.028;
        shadow.renderOrder = 9;
        root.add(shadow);

        const mainMat = new LineMaterial({
          color: new THREE.Color(colour), linewidth: width, transparent: true, opacity: exact ? 0.92 : 0.8,
          depthWrite: false, worldUnits: false,
          dashed: !exact, dashSize: 1.1, gapSize: 0.65,
        });
        mainMat.resolution.set(1, 1);
        lineMaterialsRef.current.push(mainMat);
        const line = new Line2(geo, mainMat);
        line.computeLineDistances();
        line.renderOrder = 10;
        root.add(line);

        // Anfang und Ende des Weges liegen als Ringe auf dem Boden.
        const ringMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(colour), transparent: true, opacity: 0.85,
          side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
        });
        for (const [rx, ry] of [[a.x, a.y], [b.x, b.y]]) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.26, 18), ringMat);
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(rx, 0.072, ry);
          ring.renderOrder = 12;
          root.add(ring);
        }

        // Die laufende helle Strichlinie: dieselbe Bewegung wie im SVG.
        if (!reduced) {
          const runnerMat = new LineMaterial({
            color: 0xffffff, linewidth: Math.max(1.1, width * 0.4), transparent: true, opacity: 0.85,
            depthWrite: false, worldUnits: false, dashed: true, dashSize: 0.4, gapSize: 2.1,
          });
          runnerMat.resolution.set(1, 1);
          dashMaterialsRef.current.push(runnerMat);
          const runner = new Line2(geo, runnerMat);
          runner.position.y = 0.012;
          runner.computeLineDistances();
          runner.renderOrder = 11;
          root.add(runner);
        }

        // Richtungspfeile: flache Winkel auf dem Weg, keine Kegel im Raum.
        const chevMat = new LineMaterial({
          color: new THREE.Color(colour), linewidth: 2.2, transparent: true, opacity: 0.95,
          depthWrite: false, worldUnits: false,
        });
        chevMat.resolution.set(1, 1);
        lineMaterialsRef.current.push(chevMat);
        const chevTs = route.length > 3 ? [0.26, 0.52, 0.78] : [0.4, 0.68];
        for (const t of chevTs) {
          const p = sampleRoute(route, t);
          const [dx, dy] = p.dir;
          const px = -dy, py = dx;
          const backX = p.x - dx * 0.24, backY = p.y - dy * 0.24;
          const tipX = p.x + dx * 0.16, tipY = p.y + dy * 0.16;
          const leftX = backX + px * 0.16, leftY = backY + py * 0.16;
          const rightX = backX - px * 0.16, rightY = backY - py * 0.16;
          const cGeo = new LineGeometry().setPositions([
            leftX, 0.072, leftY, tipX, 0.072, tipY, rightX, 0.072, rightY,
          ]);
          const chev = new Line2(cGeo, chevMat);
          chev.renderOrder = 12;
          root.add(chev);
        }

        // Unsichtbarer, breiter Körper für den Klick auf den Weg.
        const points = route.map(([x, y]) => new THREE.Vector3(x, 0.05, y));
        if (points.length >= 2) {
          const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0);
          const pick = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 48, 0.32, 4, false),
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
          );
          pick.userData = { edge: e };
          root.add(pick);
        }

        if (vis.labels) {
          const mid = sampleRoute(route, 0.5);
          const el = document.createElement("div");
          el.className = "three-flow-label";
          el.style.color = colour;
          el.innerHTML = `<b>${e.count}×</b><span>${e.metres.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m</span>`
            + (exact ? "" : `<span class="three-flow-note">Luftlinie</span>`);
          el.title = `${a.label} → ${b.label}${exact ? " · ganggenau" : " · Luftlinie"}`;
          el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            filterRef.current?.(e);
          });
          addCssLabel(root, el, mid.x, 0.65, mid.y);
        }
      }
    }

    stationActionsRef.current = (id: number) => {
      const s = stations.find((x) => x.id === id);
      if (s) clickRef.current?.(s);
    };
    flowActionsRef.current = (edge: FlowEdge) => filterRef.current?.(edge);

    // Die flachen Hallenfarben sollen exakt die Tokens der Semi-3D-Karte sein;
    // nur hochgeladene Modelle dürfen durch die Tone-Map weicher werden.
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.Line) && !(o instanceof THREE.LineSegments)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) (m as THREE.Material).toneMapped = false;
    });
    // Unbewegte, unbenannte Teile ohne Kennzeichen je Aussehen verschmelzen
    // (task 41 B, staticMerge.ts): Wände, Stufen, Pfetten, Gangpfeile.
    mergeStatic(root);
    // Innerhalb jeder Station (Dachkanten, Lastbalken): die Gruppe trägt
    // ``stationMove`` und wandert beim Ziehen als Ganzes, ihre schlichten
    // Kinder dürfen zu einem Körper werden. Kasten, Kanten und Statuskante
    // tragen Kennzeichen und bleiben einzeln.
    for (const c of [...root.children, ...sectionStations.children]) {
      if (c.userData?.stationMove && (c as THREE.Group).isGroup) mergeStatic(c);
    }

    // Neu gebaute Linien kennen die Bühnengröße noch nicht: ohne diesen Aufruf
    // blieben ihre Auflösungen nach einem späteren Neuaufbau bei 1 × 1.
    resizeRef.current?.();
    if (hqRef.current) {
      hqRef.current.prune();
      hqRef.current.applyShadows(scene);
      hqRootRef.current = { root, frame: 0 };
    }
    setRootRev((n) => n + 1);
    if (DEBUG_3D && mountRef.current) {
      const d = mountRef.current.dataset;
      d.builds = String(Number(d.builds || 0) + 1);
      d.buildMs = (performance.now() - buildStart).toFixed(1);
    }
    return () => {
      // Die nächste Schleife räumt die Gruppe ab; asynchrone Modelle prüfen
      // vor dem Einhängen, ob ihre Station noch in der Szene steht.
    };
  }, [ready, themeTick, floor, stations, statusKey, flow, maxFlow, vis, links, groundY, activeOffset, levels, neighborPlaces]);

  // Auswahl an Ort und Stelle (task 41 C): abdunkeln, was nicht mit der
  // Auswahl verbunden ist, Kante und Statuskante der gewählten Station
  // betonen, Ringe für Auswahl und Suchtreffer, Klassen der Beschriftungen.
  // Abdunkeln tauscht Materialien gegen Klone und merkt sich das Original am
  // Körper (``userData.selBase``); Aufheben setzt es zurück. Kein Neuaufbau.
  const applySelectionRef = useRef<(() => void) | null>(null);
  const clearSelectionRef = useRef<(() => void) | null>(null);
  const activeDimMatsRef = useRef<Set<THREE.Material>>(new Set());
  useEffect(() => {
    const root = rootGroupRef.current;
    if (!ready || !root) return;
    const accent = new THREE.Color(css("--gimel-accent", "#0b7a67"));
    const highlight = new Set(highlightIds ?? []);
    const linked = new Set<number>();
    if (selectedId != null) {
      // Wie bisher: hell bleiben die Auswahl und jede Station mit Materialfluss.
      linked.add(selectedId);
      for (const e of flow) { linked.add(e.from); linked.add(e.to); }
    }
    const byId = new Map<number, Station>();
    for (const st of stations) if (st.id != null) byId.set(st.id, st);
    const clones = new Map<THREE.Material, THREE.Material>();
    const dimMat = (m: THREE.Material): THREE.Material => {
      let c = clones.get(m);
      if (!c) {
        c = m.clone();
        c.userData = { ...m.userData, shared: false, selDim: true };
        c.transparent = true;
        c.opacity = (m.opacity ?? 1) * 0.42;
        c.depthWrite = false;
        clones.set(m, c);
        activeDimMatsRef.current.add(c);
      }
      return c;
    };
    const parts = new Map<THREE.Object3D, MotionPart>();
    for (const part of motionRef.current) parts.set(part.obj, part);
    const pruneUnusedDimMats = (r: THREE.Object3D) => {
      const used = new Set<THREE.Material>();
      r.traverse((x) => {
        const d = x as THREE.Mesh | THREE.LineSegments;
        if (!d.material) return;
        for (const m of Array.isArray(d.material) ? d.material : [d.material]) {
          if (m.userData?.selDim) used.add(m);
        }
      });
      for (const m of [...activeDimMatsRef.current]) {
        if (!used.has(m)) { m.dispose(); activeDimMatsRef.current.delete(m); }
      }
    };
    const clearSelection = () => {
      const r = rootGroupRef.current;
      if (!r) return;
      r.traverse((x) => {
        const d = x as THREE.Mesh | THREE.LineSegments;
        const base = d.userData?.selBase as THREE.Material | THREE.Material[] | undefined;
        if (!base) return;
        d.material = base;
        delete d.userData.selBase;
        const part = parts.get(d);
        if (part && part.selBaseOpacity != null) { part.baseOpacity = part.selBaseOpacity; part.selBaseOpacity = undefined; }
      });
      pruneUnusedDimMats(r);
    };
    clearSelectionRef.current = clearSelection;
    const apply = () => {
      const r = rootGroupRef.current;
      if (r !== root) return;
      const old = root.getObjectByName("selection-rings");
      if (old) { disposeTree(old); old.removeFromParent(); }
      const rings = new THREE.Group();
      rings.name = "selection-rings";
      root.add(rings);
      const ring = (st: Station, grow: number) => {
        const mat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.95, depthWrite: false });
        const bars = new THREE.Group();
        const w = st.w + grow, d = st.h + grow;
        const bar = (bw: number, bd: number, x: number, z: number) => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.025, bd), mat);
          m.position.set(x, 0.03, z);
          bars.add(m);
        };
        bar(w, 0.055, 0, d / 2);
        bar(w, 0.055, 0, -d / 2);
        bar(0.055, d, w / 2, 0);
        bar(0.055, d, -w / 2, 0);
        bars.rotation.y = -rad(st.rotation);
        bars.position.set(st.x, 0, st.y);
        tagStationMove(bars, st);
        bars.renderOrder = 8;
        rings.add(bars);
      };
      for (const id of highlight) { const st = byId.get(id); if (st) ring(st, 0.4); }
      if (selectedId != null) { const st = byId.get(selectedId); if (st) ring(st, 0.24); }
      // Teile je Station einsammeln (alle tragen ``stationMove``).
      const visit = (o: THREE.Object3D) => {
        for (const c of o.children) {
          if (c === rings) continue;
          const tag = c.userData?.stationMove as { id: number } | undefined;
          if (!tag) { if (c.name === "stations") visit(c); continue; }
          const st = byId.get(tag.id);
          if (!st) continue;
          // Beim Begehen nie abdunkeln (Owner 2026-11-08: „Maschinen durchsichtig,
          // bis ich sie anklicke“): wer durch die Halle geht, braucht feste
          // Körper; eine Auswahl aus Q, X oder einem Klick ließ alle anderen
          // Stationen bei 42 % Deckkraft stehen.
          const dim = !walk && selectedId != null && st.active && !linked.has(tag.id);
          const selected = tag.id === selectedId;
          c.traverse((x) => {
            if ((x as any).isCSS2DObject) {
              const el = (x as CSS2DObject).element;
              if (el.dataset.stationId) {
                el.classList.toggle("three-station-label-selected", selected);
                // Inaktive Stationen tragen „-off" schon aus dem Aufbau.
                if (st.active) el.classList.toggle("three-station-label-off", dim);
              }
              return;
            }
            const d = x as THREE.Mesh | THREE.LineSegments;
            if (!d.material) return;
            if (d.userData.selEdge) {
              const em = d.material as THREE.LineBasicMaterial;
              em.color.set(selected ? accent : new THREE.Color(d.userData.selEdge.colour));
              em.opacity = selected ? 1 : d.userData.selEdge.opacity;
            }
            if (d.userData.selStatus) d.scale.set(1, selected ? 0.055 / 0.036 : 1, selected ? 0.075 / 0.055 : 1);
            const base = d.userData.selBase as THREE.Material | THREE.Material[] | undefined;
            const part = parts.get(d);
            if (dim && !base) {
              d.userData.selBase = d.material;
              d.material = Array.isArray(d.material) ? d.material.map(dimMat) : dimMat(d.material);
              if (part) { part.selBaseOpacity = part.baseOpacity; part.baseOpacity *= 0.42; }
            } else if (!dim && base) {
              d.material = base;
              delete d.userData.selBase;
              if (part && part.selBaseOpacity != null) { part.baseOpacity = part.selBaseOpacity; part.selBaseOpacity = undefined; }
            }
          });
        }
      };
      visit(root);
      pruneUnusedDimMats(root);
      labelsDirtyRef.current = true;
      invalidate();
    };
    applySelectionRef.current = apply;
    apply();
    return () => {
      applySelectionRef.current = null;
      clearSelectionRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rootRev, selectedId, highlightIds, flow, stations, themeTick, walk]);

  // Roboter und Transportaufträge: eine eigene Schicht in der Szene. Ein Abruf
  // der Roboter (alle 30 s) baut nur sie neu und nur, wenn sich Name, Zustand,
  // Akku oder Weg geändert haben. Bis 2026-11-07 hing der ganze Hallenneubau an
  // `sampledAt` — jede Antwort baute die Halle samt Geräten neu.
  const robotKey = useMemo(() => floorRobots.map((r) => JSON.stringify([
    r.id, r.name, r.kind, r.state, r.battery_pct, r.simulated, r.route_mode, r.route,
  ])).join(";"), [floorRobots]);
  const jobKey = useMemo(() => floorJobs.map((j) => JSON.stringify(j)).join(";"), [floorJobs]);
  useEffect(() => {
    if (!ready) return;
    const scene = sceneRef.current;
    if (!scene) return;
    if (robotLayerRef.current) {
      // Die Beschriftungen hängen als CSS2D im DOM, nicht in der Szene. Ohne
      // dieses Abräumen bliebe eine eingefrorene Kopie („AGV 1") stehen.
      robotLayerRef.current.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
      disposeTree(robotLayerRef.current);
      robotLayerRef.current.removeFromParent();
      robotLayerRef.current = null;
    }
    const robotLayer = new THREE.Group();
    robotLayer.name = "robot-layer";
    // Alle Bühnen-Layer folgen der aktiven Ebene (KG unter dem EG).
    robotLayer.position.y = activeOffsetRef.current;
    scene.add(robotLayer);
    robotLayerRef.current = robotLayer;

    // Roboter: Körper, Weg und eine kleine Beschriftung. Die Render-Schleife
    // bewegt sie zwischen zwei Abrufen weiter; der nächste Abruf setzt den
    // Stand zurück, ohne dass ein Client die Position selbst erfindet.
    robotObjectsRef.current.clear();
    if (vis.robots) {
      // Transportaufträge zuerst: ihr Weg ist die Absicht, der Roboter die
      // Ausführung. Gestrichelt, damit niemand ihn für einen gefahrenen Weg hält.
      for (const job of floorJobs) {
        const colour = job.state === "running" ? "#2f9e6e"
          : job.state === "assigned" ? "#1668ac" : "#7c5cbf";
        const jobMat = new THREE.LineDashedMaterial({
          color: new THREE.Color(colour), dashSize: 0.9, gapSize: 0.55,
          transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false,
        });
        const jobRuns = clearPolyline(job.route, world, {
          radius: 0.35, groups: ["station", "obstacle"], step: 0.5,
        });
        for (const run of jobRuns.length ? jobRuns : [job.route]) {
          const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(run.map(([x, y]) => new THREE.Vector3(x, 0.055, y))),
            jobMat,
          );
          line.computeLineDistances();
          line.renderOrder = 4;
          robotLayer.add(line);
        }
        if (vis.labels) {
          const target = job.route[job.route.length - 1];
          const el = document.createElement("div");
          el.className = "three-robot-label three-job-label";
          el.style.setProperty("--three-status", colour);
          const context = job.order_no || job.work_order_no || "Transport";
          el.innerHTML = `<b>${escapeHtml(job.ref)}</b><span>${escapeHtml(context)} → ${escapeHtml(job.to?.label || "Ziel")}</span>`;
          addCssLabel(robotLayer, el, target[0], 0.78, target[1]);
        }
      }
      for (const r of floorRobots) {
        const pose = robotPoseAt(r, sampledAt, Date.now(), robotReceivedRef.current.ms);
        if (!pose) continue;

        if (r.route.length >= 2) {
          const routeMat = new THREE.LineBasicMaterial({
            color: new THREE.Color(robotStatusColour(r.state)),
            transparent: true, opacity: r.state === "offline" ? 0.18 : 0.42,
            depthWrite: false, toneMapped: false,
          });
          const runs = clearPolyline(r.route, world, {
            radius: 0.35, groups: ["station", "obstacle"], step: 0.5,
          });
          for (const run of runs.length ? runs : [r.route]) {
            const points = run.map(([x, y]) => new THREE.Vector3(x, 0.046, y));
            if (r.route_mode === "loop" && run === r.route
                && Math.hypot(points[0].x - points[points.length - 1].x,
                  points[0].z - points[points.length - 1].z) > 1e-6) {
              points.push(points[0].clone());
            }
            const route = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), routeMat);
            route.renderOrder = 3;
            robotLayer.add(route);
          }
        }

        const group = buildRobotModel(r);
        group.position.set(pose.x, 0.03, pose.y);
        if (pose.heading_deg != null) group.rotation.y = -rad(pose.heading_deg);
        if (vis.labels) {
          const el = document.createElement("div");
          el.className = "three-robot-label" + (r.state === "offline" ? " three-robot-label-off" : "");
          el.style.setProperty("--three-status", robotStatusColour(r.state));
          const battery = r.battery_pct == null ? "Akku ?" : `${r.battery_pct} %`;
          // „sim" in der Kopfzeile: sie bleibt auch kompakt und auf dem Telefon stehen.
          const source = r.simulated ? " · sim" : "";
          el.innerHTML = `<b>${escapeHtml(r.name)}${source}</b><span>${escapeHtml(robotStateWord(r.state))} · ${escapeHtml(battery)}</span>`;
          addCssLabel(group, el, 0, 1.18, 0);
        }
        // Kollisionsring: immer dabei, aber nur sichtbar, wenn die Logik den
        // Roboter gerade als betroffen meldet. Er hängt am Fahrzeug und fährt
        // deshalb mit, ohne dass die Szene neu gebaut werden müsste.
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(ROBOT_RADIUS_M + 0.08, ROBOT_RADIUS_M + 0.26, 24),
          new THREE.MeshBasicMaterial({ color: 0xcd4246, transparent: true, opacity: 0.9,
            side: THREE.DoubleSide, depthWrite: false, toneMapped: false }),
        );
        halo.name = "collision-halo";
        halo.rotation.x = -Math.PI / 2;
        halo.position.y = 0.02;
        halo.visible = false;
        halo.renderOrder = 14;
        group.add(halo);
        robotLayer.add(group);
        robotObjectsRef.current.set(r.id, group);
      }
    }

    robotLayer.traverse((o) => {
      if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.Line) && !(o instanceof THREE.LineSegments)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && !m.userData?.shared) (m as THREE.Material).toneMapped = false;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, themeTick, robotKey, jobKey, vis.robots, vis.labels, world, activeOffset]);

  // Belebung (dargestellt): eigene Schicht, nie im Klickziel, nie in Kollisionen
  // oder Kennzahlen. Figuren stehen nur an Stationen, die laut Buchung laufen.
  useEffect(() => {
    const scene = sceneRef.current;
    const st = stagedRef.current;
    if (st.layer) {
      disposeTree(st.layer);
      st.layer.removeFromParent();
      st.layer = null;
    }
    st.parts = [];
    st.movers = [];
    if (!ready || !scene || !staged) return;
    const p = paletteOf({ ...DEVICE_STYLE, ...deviceStyleFromTokens(css) });
    const layer = new THREE.Group();
    layer.name = "staged-layer";
    layer.position.y = activeOffsetRef.current;
    scene.add(layer);
    st.layer = layer;

    const amb = stations.filter((s) => s.id != null && s.active).map((s) => {
      const m = status[s.id!];
      return { id: s.id!, label: s.label, x: s.x, y: s.y, w: s.w, h: s.h, rotation: s.rotation,
        running: !!m?.running || m?.kind === "laeuft" };
    });
    // Jedes Stück wird am Ursprung gebaut, verschmolzen (models/kit.finalize) und erst dann gesetzt.
    const place = (make: (parent: THREE.Group) => THREE.Group, x: number, z: number, ry: number): THREE.Object3D => {
      const tmp = new THREE.Group();
      const body = make(tmp);
      body.removeFromParent();
      body.position.set(0, 0, 0);
      body.rotation.set(0, 0, 0);
      const done = kitFinalize(body);
      done.position.set(x, 0, z);
      done.rotation.y = ry;
      layer.add(done);
      return done;
    };
    operatorSpots(amb, world).forEach((spot, i) => {
      const fig = place((g) => worker(g, p, 0, 0, 0, "work", i * 1.7), spot.x, spot.y, spot.heading);
      collectMotion(fig, true, st.parts);
    });

    const columns = (floor.obstacles ?? []).filter((o) => /stütze|säule|column|pfeiler/i.test(o.name)).map((o) => o.points);
    const b = sceneBounds(floor, stations);
    for (const e of extinguisherSpots(columns, [b.x + b.w / 2, b.y + b.h / 2])) place((g) => extinguisher(g, 0, 0, 0), e.x, e.y, e.heading);

    // Materialwege der Ebene: nur noch für den Stapler. Gleitende Teile auf dem
    // Boden gibt es nicht mehr (Owner 2026-11-07: „remove the sliding pakets").
    const routes = flowRoutesRef.current.filter((f) => f.route.length >= 2 && ambientLength(f.route) > 3);
    // Förderbänder laufen, Kartons fahren darauf von der Quelle zum Ziel.
    for (const belt of conveyorsRef.current) {
      const len = length3(belt.points);
      if (len < 1) continue;
      st.movers.push((t) => { for (const tex of belt.textures) tex.offset.x = -((t * 0.4) / 0.5) % 1; });
      const n = Math.max(2, Math.min(8, Math.round(len / 3)));
      for (let i = 0; i < n; i++) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.32), kitMat(p.carton, "carton", "carton"));
        box.rotation.order = "YZX";
        layer.add(box);
        st.movers.push((t) => {
          const q = along3(belt.points, ((t * 0.4) + (i / n) * len) % len);
          box.position.set(q.x, q.z + 0.16, q.y);
          box.rotation.y = q.heading;
          box.rotation.z = q.pitch;
        });
      }
    }
    // Ein Stapler pendelt auf dem stärksten Materialweg; ohne Materialweg steht er am Tor.
    const supply = routes.filter((f) => f.kind === "supply").sort((a, c) => c.count - a.count)[0];
    if (supply && ambientLength(supply.route) > 7) {
      const truck = place((g) => {
        const f = forklift(g, p, 0, 0, 0, true);
        const forks = f.getObjectByName("forks");
        if (forks) forks.userData.keep = true;  // Ladung ein-/ausblenden: nicht verschmelzen
        return f;
      }, 0, 0, 0);
      const load = truck.getObjectByName("forks")?.children.find((c) => c instanceof THREE.Group) ?? null;
      st.movers.push((t) => {
        const q = shuttle(supply.route, t);
        truck.position.set(q.x, 0, q.y);
        truck.rotation.y = q.heading + Math.PI;  // Gabel voran
        if (load) load.visible = q.loaded;
      });
    } else {
      const doors = floor.doors ?? [];
      const door = doors.find((d) => /anliefer|wareneingang|annahme/i.test(d.name)) ?? doors.find((d) => /tor|eingang/i.test(d.name));
      if (door) {
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        const len = Math.hypot(cx - door.x, cy - door.y) || 1;
        const x = door.x + ((cx - door.x) / len) * 3, y = door.y + ((cy - door.y) / len) * 3;
        if (!world.query({ kind: "circle", x, y, r: 1.3 }, { groups: ["station", "obstacle", "wall"] }).length) {
          place((g) => forklift(g, p, 0, 0, 0, false), x, y, Math.atan2(-(cy - door.y), cx - door.x) + Math.PI);
        }
      }
    }
    layer.traverse((o) => { o.userData = { ...(o.userData ?? {}), staged: true }; });
    const t0 = performance.now() * 0.001;
    for (const move of st.movers) move(t0);
    return () => {
      if (st.layer) {
        disposeTree(st.layer);
        st.layer.removeFromParent();
        st.layer = null;
      }
      st.parts = [];
      st.movers = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, staged, statusKey, rootRev, themeTick, world, activeOffset]);

  // Mitarbeiter am Arbeitsplatz (Haken an der Station): eine Figur, auch ohne Belebung.
  // Das ist die Planung, nicht eine Ortung: der Haken sagt, dass dort jemand arbeitet.
  // Mit Belebung zeigt die Belebung schon eine Figur an laufenden Stationen; dort keine zweite.
  const staffedLayerRef = useRef<THREE.Group | null>(null);
  const staffedKey = stations.filter((s) => s.staffed && s.active)
    .map((s) => `${s.id}:${s.x}:${s.y}:${s.w}:${s.h}:${s.rotation}`).join("|");
  useEffect(() => {
    const scene = sceneRef.current;
    if (staffedLayerRef.current) {
      disposeTree(staffedLayerRef.current);
      staffedLayerRef.current.removeFromParent();
      staffedLayerRef.current = null;
    }
    if (!ready || !scene || !staffedKey) return;
    const p = paletteOf({ ...DEVICE_STYLE, ...deviceStyleFromTokens(css) });
    const layer = new THREE.Group();
    layer.name = "staffed-layer";
    layer.position.y = activeOffsetRef.current;
    scene.add(layer);
    staffedLayerRef.current = layer;
    const amb = stations
      .filter((s) => s.id != null && s.active && s.staffed)
      .filter((s) => {
        if (!staged) return true;
        const m = status[s.id!];
        return !(m?.running || m?.kind === "laeuft");
      })
      .map((s) => ({ id: s.id!, label: s.label, x: s.x, y: s.y, w: s.w, h: s.h, rotation: s.rotation, running: true }));
    operatorSpots(amb, world).forEach((spot, i) => {
      const tmp = new THREE.Group();
      const body = worker(tmp, p, 0, 0, 0, "work", i * 1.7);
      body.removeFromParent();
      body.position.set(0, 0, 0);
      body.rotation.set(0, 0, 0);
      const done = kitFinalize(body);
      done.position.set(spot.x, 0, spot.y);
      done.rotation.y = spot.heading;
      layer.add(done);
    });
  // stations/status wirken über staffedKey, statusKey und world.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, staffedKey, staged, statusKey, themeTick, world, activeOffset]);

  // Kollisionslage: alle 600 ms nachrechnen. Roboter fahren zwischen zwei
  // Serverabrufen weiter, also muss auch die Anzeige mitgehen; ein Neubau der
  // ganzen Halle wäre dafür viel zu teuer.
  useEffect(() => {
    if (!ready || !vis.collisions || (floorRobots.length === 0 && floorJobs.length === 0)) return;
    const t = window.setInterval(() => setCollisionTick((n) => n + 1), 600);
    return () => window.clearInterval(t);
  }, [ready, vis.collisions, floorRobots.length, floorJobs.length]);

  const collisionSigRef = useRef("");
  /** Stecker je Bündel (Ort + Text): bleibt dasselbe DOM-Element über
      Neuaufbauten hinweg, damit Fokus und Hover-Text nicht verloren gehen. */
  const pinElsRef = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const teardown = (keep: Set<HTMLElement> = new Set()) => {
      if (collisionLayerRef.current) {
        collisionLayerRef.current.traverse((o) => {
          if (o instanceof CSS2DObject && !keep.has(o.element)) o.element.remove();
        });
        disposeTree(collisionLayerRef.current);
        collisionLayerRef.current.removeFromParent();
        collisionLayerRef.current = null;
      }
      collisionSigRef.current = "";
      if (collisionHudRef.current) {
        collisionHudRef.current.textContent = "";
        collisionHudRef.current.dataset.collisions = "0";
      }
      if (collisionSrRef.current) collisionSrRef.current.textContent = "";
    };
    if (!ready || !vis.collisions) { collisionRobotsRef.current = new Set(); pinElsRef.current.clear(); teardown(); return; }

    const report = robotCollisionReport({
      world, floor, robots: floorRobots, jobs: floorJobs, stations,
      poseOf: (r) => robotPoseAt(r, sampledAt, Date.now(), robotReceivedRef.current.ms),
      radius: ROBOT_RADIUS_M, clearance: CLEARANCE_M,
    });
    // Der Ring am Fahrzeug folgt in der Bildschleife; die Menge gilt sofort.
    collisionRobotsRef.current = new Set(
      Object.entries(report.byRobot)
        .filter(([, hits]) => hits.some((h) => h.severity === "danger"))
        .map(([id]) => Number(id)),
    );
    // Gate task 41: die Lage wird alle 600 ms nachgerechnet, die Schicht aber
    // nur neu gebaut, wenn sich das Bild ändert. Vorher verschwanden die
    // Stecker zweimal je Sekunde — Fokus und Hover-Text gingen verloren, und
    // die Statuszeile für Vorleser wurde ständig neu geschrieben.
    const sig = JSON.stringify([
      themeTick, vis.labels, activeOffset, report.collisions.length,
      report.collisions.filter((c) => !(c.group === "robot" && c.robotId != null))
        .map((c) => [Math.round(c.at[0] * 2), Math.round(c.at[1] * 2), c.severity, c.detail]),
      report.riskySegments.map((r) => r.segments.map(([a, b]) => [a, b].map((p) => p.map((v) => Math.round(v * 10))))),
      report.collidingStationIds,
    ]);
    if (sig === collisionSigRef.current && collisionLayerRef.current) return;
    const clusters = new Map<string, typeof report.collisions>();
    for (const c of report.collisions) {
      if (c.group === "robot" && c.robotId != null) continue; // am Fahrzeug schon sichtbar
      const key = `${Math.round(c.at[0] * 2)}:${Math.round(c.at[1] * 2)}`;
      const bucket = clusters.get(key);
      if (bucket) bucket.push(c);
      else clusters.set(key, [c]);
    }
    const pinKey = (hits: typeof report.collisions) => `${hits[0].at.map((v) => Math.round(v * 2)).join(":")}|${hits.map((h) => h.severity + h.detail).join("|")}`;
    const shown = [...clusters.values()].slice(0, 10);
    const keepEls = new Set<HTMLElement>();
    const nextPins = new Map<string, HTMLElement>();
    if (vis.labels) for (const hits of shown) {
      const el = pinElsRef.current.get(pinKey(hits));
      if (el) { keepEls.add(el); nextPins.set(pinKey(hits), el); }
    }
    teardown(keepEls);
    collisionSigRef.current = sig;
    const layer = new THREE.Group();
    layer.name = "collision-layer";
    layer.position.y = activeOffsetRef.current;
    collisionLayerRef.current = layer;
    scene.add(layer);
    const danger = new THREE.Color(css("--g-danger", "#cd4246"));
    const warn = new THREE.Color(css("--g-warning", "#ca9c19"));
    const markMat = (colour: THREE.Color) => new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      depthWrite: false, toneMapped: false,
    });
    const ringMat = markMat(danger), dotMat = markMat(warn);

    // Ein roter Ring am Ort des Zusammenstoßes; die Beschriftung nennt den
    // Grund. Roboter selbst tragen ihren Ring am Fahrzeug (siehe Schleife).
    // Mehrere Treffer an derselben Stelle werden zu *einem* Hinweis gebündelt,
    // sonst stapeln sich bei zwei Robotern auf einer Stütze fünf Schilder.
    let clusterIndex = 0;
    for (const hits of shown) {
      const c = hits[0];
      const at = c.at;
      const hard = hits.some((h) => h.severity === "danger");
      const mat = hard ? ringMat : dotMat;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.48, 18), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(at[0], 0.1, at[1]);
      ring.renderOrder = 13;
      layer.add(ring);
      if (vis.labels) {
        // Klein am Ort, der Text erst beim Zeigen oder mit der Tastatur
        // (task 41 E): ausgeschrieben lag er quer über der Halle.
        const key = pinKey(hits);
        const kept = nextPins.get(key);
        if (kept) {
          addCssLabel(layer, kept, at[0], 0.95 + (clusterIndex % 3) * 0.34, at[1]);
          clusterIndex++;
          continue;
        }
        const el = document.createElement("div");
        nextPins.set(key, el);
        el.className = "three-collision-label three-collision-pin" + (hard ? " three-collision-danger" : "");
        const all = hits.map((h) => h.detail).join(" · ");
        const mark = document.createElement("b");
        mark.textContent = hits.length > 1 ? `! ${hits.length}` : "!";
        mark.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.textContent = hits.length > 1 ? `${hits.length} Kollisionen · ${c.detail}` : c.detail;
        el.append(mark, text);
        el.title = all;
        el.tabIndex = 0;
        el.setAttribute("role", "note");
        el.setAttribute("aria-label", `${hard ? "Kollision" : "Berührung"}: ${all}`);
        el.style.pointerEvents = "auto";
        addCssLabel(layer, el, at[0], 0.95 + (clusterIndex % 3) * 0.34, at[1]);
      }
      clusterIndex++;
    }
    // Gefährliche Wegstücke des geplanten Transports: rot gestrichelt über
    // der ohnehin gezeichneten Route.
    for (const risk of report.riskySegments) {
      for (const [a, b] of risk.segments) {
        const mat = new LineMaterial({
          color: danger, linewidth: 3, transparent: true, opacity: 0.9,
          depthWrite: false, dashed: true, dashSize: 0.7, gapSize: 0.45,
        });
        mat.resolution.set(1, 1);
        lineMaterialsRef.current.push(mat);
        const line = new Line2(new LineGeometry().setPositions([a[0], 0.09, a[1], b[0], 0.09, b[1]]), mat);
        line.computeLineDistances();
        line.renderOrder = 13;
        layer.add(line);
      }
    }
    // Ringe um Stationen, die im Grundriss überlappen — die Logik gilt für
    // alle Körper, nicht nur für Roboter.
    for (const id of report.collidingStationIds) {
      const s = stations.find((x) => x.id === id);
      if (!s) continue;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.16, 4), dotMat);
      ring.rotation.x = -Math.PI / 2;
      ring.rotation.z = Math.PI / 4;
      ring.position.set(s.x, 0.11, s.y);
      ring.renderOrder = 13;
      layer.add(ring);
    }
    if (collisionHudRef.current) {
      const n = report.collisions.length;
      collisionHudRef.current.dataset.collisions = String(n);
      collisionHudRef.current.textContent = n
        ? `${n} ${n === 1 ? "Kollision" : "Kollisionen"}`
        : "keine Kollisionen";
      collisionHudRef.current.className = n
        ? "three-collision-hud" : "three-collision-hud three-collision-ok";
    }
    if (collisionSrRef.current) {
      const n = report.collisions.length;
      collisionSrRef.current.textContent = n
        ? `${n} Kollisionen im digitalen Zwilling erkannt.`
        : "Keine Kollisionen erkannt.";
    }
    pinElsRef.current = nextPins;
    resizeRef.current?.();
  }, [ready, collisionTick, vis.collisions, vis.labels, themeTick, world, floor, stations, floorRobots, floorJobs, sampledAt, activeOffset]);

  // Andere Ebenen und Kartengrund: eigene Gruppe, nicht anklickbar, eigener Lebenslauf.
  useEffect(() => {
    if (!ready) return;
    const scene = sceneRef.current;
    if (!scene) return;
    if (extrasRef.current) {
      disposeGroup(extrasRef.current, scene);
      extrasRef.current = null;
    }
    const extras = new THREE.Group();
    extras.name = "hall-extras";
    extrasRef.current = extras;
    scene.add(extras);
    const accent = new THREE.Color(css("--gimel-accent", "#0b7a67"));
    const ghostStyle: Partial<DeviceStyle> = deviceStyleFromTokens(css);

    const allHallSpans: LevelOutlineSpan[] = [
      { id: floor.id ?? -1, offset: activeOffset, height: hallHeight(floor), outline: floor.outline ?? [] },
      ...levels.map((l) => ({
        id: l.id, offset: l.offset, height: hallHeight(l.floor), outline: l.floor.outline ?? [],
      })),
    ];

    for (const lv of (walk ? [] : levels)) {
      const solid = fullView || fullLevelIds.includes(lv.id);
      const aboveOutlines = allHallSpans
        .filter((s) => s.id !== lv.id && s.offset > lv.offset + 1e-3 && s.outline.length >= 3)
        .map((s) => s.outline);
      // Dieselbe Bildsprache wie die aktive Ebene: Boden, Raster, Zonen,
      // Wände mit Oberkante, Hallenhülle, Dach, Stützen, Gänge und Treppen. Bei
      // „voll sichtbar“ deckend, sonst durchscheinend — aber nie ein Gerippe.
      const g = buildFloorPresentation(lv.floor, lv.stations, {
        full: solid, shell: vis.shell, roof: vis.roof, aboveOutlines, grid: vis.grid, aisles: vis.aisles,
      });
      // Sichtbare Geschossdeckenkante für oberirdische / auskragende Ebenen.
      if (lv.offset > 0.05 && (lv.floor.outline?.length ?? 0) >= 3) {
        const slabMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(css("--g-iso-side", "#343d47")),
          transparent: true,
          opacity: solid ? 0.85 : 0.55,
          toneMapped: false,
        });
        const slabH = 0.22;
        const pts = lv.floor.outline;
        for (let i = 0; i < pts.length; i++) {
          const [ax, az] = pts[i];
          const [bx, bz] = pts[(i + 1) % pts.length];
          const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
          if (len < 1e-6) continue;
          const rim = new THREE.Mesh(new THREE.BoxGeometry(len, slabH, 0.16), slabMat);
          rim.position.set((ax + bx) / 2, -slabH / 2, (az + bz) / 2);
          rim.rotation.y = -Math.atan2(dz, dx);
          g.add(rim);
        }
      }
      g.position.y = lv.offset;
      // Senkrechte Verbindungen an den Ecken:
      // - gestapelt über einem Geschoss: nur die Deckenfuge verbinden
      // - auskragend (nicht deckungsgleich): dezente Lot-Linie auf y = 0
      const lvSpan: LevelOutlineSpan = {
        id: lv.id, offset: lv.offset, height: hallHeight(lv.floor), outline: lv.floor.outline ?? [],
      };
      const connectors = levelConnectorShafts(lvSpan, allHallSpans);
      const stackedPts: number[] = [];
      const overhangPts: number[] = [];
      for (const c of connectors) {
        (c.overhang ? overhangPts : stackedPts).push(c.x, c.y0, c.z, c.x, c.y1, c.z);
      }
      if (stackedPts.length) {
        const lines = new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(stackedPts, 3)),
          new THREE.LineDashedMaterial({ color: accent, transparent: true, opacity: 0.42, dashSize: 0.35, gapSize: 0.25 }),
        );
        lines.computeLineDistances();
        extras.add(lines);
      }
      if (overhangPts.length) {
        const lines = new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(overhangPts, 3)),
          new THREE.LineDashedMaterial({
            color: new THREE.Color(css("--g-hall-frame", "#8d99a6")),
            transparent: true, opacity: 0.26, dashSize: 0.45, gapSize: 0.45,
          }),
        );
        lines.computeLineDistances();
        extras.add(lines);
      }
      for (const st of lv.stations) {
        // Auch die anderen Ebenen zeigen ihre Geräte, gedämpft oder — auf
        // Wunsch — in voller Sicht.
        const device = buildDeviceModel(st, ghostStyle, { detail: "low" });
        device.position.set(st.x, 0.012, st.y);
        device.rotation.y = -rad(st.rotation);
        if (!solid) setDeviceOpacity(device, 0.62);
        g.add(device);
      }
      const b = sceneBounds(lv.floor, lv.stations);
      const el = document.createElement("div");
      el.className = "three-level-label";
      el.textContent = lv.label;
      const tag = new CSS2DObject(el);
      tag.position.set(b.x, 0.3, b.y);
      g.add(tag);
      mergeStatic(g, { loose: true });
      extras.add(g);
    }

    // Andere Hallen desselben Standorts: an ihrer Kartenlage, gedämpft wie
    // die anderen Ebenen. Sie sind Anschauung, kein Klickziel.
    const placements = neighborPlaces;
    const allHallPlacements = [
      { id: floor.id ?? -1, x: 0, y: 0, rotation_deg: 0, elevation_m: 0, floor },
      ...placements.map((p) => ({
        id: p.hall.id, x: p.x, y: p.y, rotation_deg: p.hall.rotation_deg, elevation_m: p.hall.elevation_m, floor: p.hall.floor,
      })),
    ];
    for (const p of placements) {
      const nh = p.hall;
      const solid = fullView || fullHallIds.includes(nh.id);
      const nhAbove = placements
        .filter((o) => o.hall.id === nh.id && o.hall.elevation_m > nh.elevation_m + 1e-3
          && (o.hall.floor.outline?.length ?? 0) >= 3)
        .map((o) => o.hall.floor.outline);
      const nhTarget = { id: nh.id, x: p.x, y: p.y, rotation_deg: nh.rotation_deg };
      const nhSameElev = allHallPlacements.filter((h) => Math.abs(h.elevation_m - nh.elevation_m) < 0.8);
      const nhExtraDoors = sharedBoundaryDoors(nhTarget, nhSameElev);
      const g = buildFloorPresentation(nh.floor, nh.stations, {
        full: solid, shell: vis.shell, roof: vis.roof, aboveOutlines: nhAbove, extraDoors: nhExtraDoors, grid: vis.grid, aisles: vis.aisles,
      });
      g.position.set(p.x, activeOffset + nh.elevation_m, p.y);
      g.rotation.y = rad(nh.rotation_deg);
      for (const st of nh.stations) {
        const device = buildDeviceModel(st, ghostStyle, { detail: "low" });
        device.position.set(st.x, 0.012, st.y);
        device.rotation.y = -rad(st.rotation);
        if (!solid) setDeviceOpacity(device, 0.55);
        g.add(device);
      }
      const el = document.createElement("div");
      el.className = "three-level-label";
      el.textContent = `${nh.label} · ${nh.level}`;
      const tag = new CSS2DObject(el);
      tag.position.set(p.bounds.x, 0.3, p.bounds.y);
      g.add(tag);
      mergeStatic(g, { loose: true });
      extras.add(g);
    }
  }, [ready, themeTick, levels, neighborPlaces, fullView, fullLevelIds, fullHallIds, activeOffset, floor, stations, walk,
    vis.shell, vis.roof, vis.grid, vis.aisles]);

  // Kartengrund: Kachelstufe und Ausdehnung folgen dem sichtbaren Ausschnitt.
  // Sonst endet die Karte beim Herauszoomen mitten im Bild oder wird beim
  // Hineinzoomen unnötig grob.
  const mapKeyRef = useRef("");
  useEffect(() => {
    const key = map && (map.lat || map.lon) ? `${map.lat}|${map.lon}` : "";
    if (mapKeyRef.current !== key) {
      mapKeyRef.current = key;
      mapDetailRef.current = null;
      setMapDetail(null);
    }
    if (!ready || !key) return;
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls) return;
    const bounds = sceneBounds(floor, stations);
    const placements = neighborPlaces;
    let reach = Math.max(
      Math.hypot(bounds.x, bounds.y),
      Math.hypot(bounds.x + bounds.w, bounds.y),
      Math.hypot(bounds.x, bounds.y + bounds.h),
      Math.hypot(bounds.x + bounds.w, bounds.y + bounds.h),
    );
    for (const p of placements) {
      reach = Math.max(reach,
        Math.hypot(p.x + p.bounds.x, p.y + p.bounds.y),
        Math.hypot(p.x + p.bounds.x + p.bounds.w, p.y + p.bounds.y),
        Math.hypot(p.x + p.bounds.x, p.y + p.bounds.y + p.bounds.h),
        Math.hypot(p.x + p.bounds.x + p.bounds.w, p.y + p.bounds.y + p.bounds.h));
    }
    const compute = () => {
      if (!map) return;
      // Bühnenmaße aus dem ResizeObserver-Cache statt aus
      // getBoundingClientRect: die Abfrage in jedem Bild würde das Layout nach
      // den eben geschriebenen Maßen (Maßstab, Kompass) neu berechnen.
      const r = stageSizeRef.current;
      const aspect = r.w > 0 && r.h > 0 ? r.w / r.h : 1.6;
      const distance = camera.position.distanceTo(controls.target);
      const offset = Math.hypot(controls.target.x, controls.target.z);
      const half = distance * Math.tan(rad(camera.fov / 2)) / Math.max(0.05, camera.zoom);
      // Beim Herauszoomen sieht man den Boden bis fast zum Horizont: die
      // Karte muss weiter reichen als der Ausschnitt um den Drehpunkt. Sie
      // reicht jetzt deutlich über die Halle hinaus, damit mehr vom
      // OpenStreetMap-Umfeld zu sehen ist; in der Ferne übernehmen gröbere
      // Kacheln, damit die Zahl der Anfragen an OSM nicht mitwächst.
      const extra = Math.max(0, distance - fitDistanceRef.current) * 5;
      const want = Math.max(reach + 120,
        (half * Math.hypot(aspect, 1) + offset + reach * 0.25 + 60 + extra) * 1.25);
      const { z, span } = mapDetailFor(want, map.lat);
      const prev = mapDetailRef.current;
      if (prev && prev.z === z && prev.span === span) return;
      mapDetailRef.current = { z, span };
      setMapDetail({ z, span });
    };
    mapComputeRef.current = compute;
    compute();
    return () => {
      mapComputeRef.current = null;
    };
  }, [ready, map?.lat, map?.lon, floor, stations, neighborPlaces]);

  // Die Kacheln als eigene Gruppe: ein anderer Ausschnitt baut nicht die
  // ganze Halle neu, und die Texturen bleiben im Zwischenspeicher.
  useEffect(() => {
    if (!ready) return;
    const scene = sceneRef.current;
    if (!scene) return;
    if (mapGroupRef.current) {
      mapGroupRef.current.userData.cleanup?.();
      disposeTree(mapGroupRef.current);
      scene.remove(mapGroupRef.current);
      mapGroupRef.current = null;
    }
    if (!map || (!map.lat && !map.lon) || !mapDetail) return;
    const t = rad(map.rotation_deg || 0);
    const cos = Math.cos(t), sin = Math.sin(t);
    const group = new THREE.Group();
    group.name = "hall-map";
    const radius = tileMetres(map.lat, mapDetail.z) * mapDetail.span;
    const tiles = tilesAround(map.lat, map.lon, radius, mapDetail.z, mapStyle, mapDetail.span);
    if (!tiles.length) return;
    // Alle Kacheln in **einer** Textur auf **einer** Fläche (task 41 B): bis
    // dahin war jede der bis zu 441 Kacheln ein eigener Zeichenaufruf (Demo: 81).
    // Die Kacheln liegen auf einem regelmäßigen Raster gleicher Größe.
    const size = tiles[0].size;
    const easts = tiles.map((tl) => tl.east), norths = tiles.map((tl) => tl.north);
    const minE = Math.min(...easts), maxE = Math.max(...easts);
    const minN = Math.min(...norths), maxN = Math.max(...norths);
    const cols = Math.round((maxE - minE) / size) + 1, rows = Math.round((maxN - minN) / size) + 1;
    // Höchstens 2048 px je Seite: weit draußen ist eine Kachel ohnehin nur
    // wenige Bildpunkte groß, und 2048² sind 16 MB statt 64 MB Grafikspeicher.
    const cell = Math.max(64, Math.min(256, Math.floor(2048 / Math.max(cols, rows))));
    const canvas = document.createElement("canvas");
    canvas.width = cols * cell;
    canvas.height = rows * cell;
    const ctx = canvas.getContext("2d");
    // Grundfläche vorab deckend füllen: fehlt eine Kachel (Netz, Sperre),
    // zeigt die Karte die gedämpfte Fläche statt eines Lochs in den Himmel.
    // Weiß, weil die Kartenfarbe (--g-map-tint) die Textur ohnehin multipliziert.
    if (ctx) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(16, rendererRef.current?.capabilities.getMaxAnisotropy() ?? 1);
    tex.userData.own = true;
    let alive = true;
    let pendingUpload = 0;
    const upload = () => {
      if (pendingUpload) return;
      // Kacheln kommen in Schüben: eine Übertragung je Schub statt je Kachel.
      pendingUpload = window.setTimeout(() => {
        pendingUpload = 0;
        if (!alive) return;
        tex.needsUpdate = true;
        invalidate();
      }, 80);
    };
    for (const tile of tiles) {
      const cx = Math.round((tile.east - minE) / size);
      const cy = Math.round((maxN - tile.north) / size);
      const draw = (img: HTMLImageElement) => {
        if (!alive || !ctx) return;
        ctx.drawImage(img, cx * cell, cy * cell, cell, cell);
        upload();
      };
      const cached = tileCache.current.get(tile.url);
      if (cached) {
        if (cached.complete && cached.naturalWidth) draw(cached);
        else cached.addEventListener("load", () => draw(cached), { once: true });
        continue;
      }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.addEventListener("load", () => draw(img), { once: true });
      img.addEventListener("error", () => console.warn("Gimel 3D: Kartenkachel nicht geladen", tile.url), { once: true });
      img.src = tile.url;
      tileCache.current.set(tile.url, img);
    }
    // Zwischenspeicher begrenzen: nur die Kacheln der letzten Ausschnitte.
    if (tileCache.current.size > 900) {
      const keep = new Set(tiles.map((tl) => tl.url));
      for (const k of [...tileCache.current.keys()]) {
        if (tileCache.current.size <= 600) break;
        if (!keep.has(k)) tileCache.current.delete(k);
      }
    }
    const geo = new THREE.PlaneGeometry(cols * size, rows * size);
    geo.rotateX(-Math.PI / 2);
    // Im Dunkeln gedämpft (--g-map-tint): helle Kacheln blendeten unter der dunklen Halle.
    // Deckend, damit Boden und Sternenhimmel nicht durch die Karte scheinen.
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: tex, color: new THREE.Color(css("--g-map-tint", "#ffffff")),
      depthWrite: true, toneMapped: false,
    }));
    const ce = (minE + maxE) / 2, cn = (minN + maxN) / 2;
    mesh.position.set(ce * cos + cn * sin, groundY - 0.04, ce * sin - cn * cos);
    mesh.rotation.y = -t;
    mesh.renderOrder = -1;
    group.add(mesh);
    const cleanup = () => { alive = false; if (pendingUpload) window.clearTimeout(pendingUpload); };
    group.userData.cleanup = cleanup;
    mapGroupRef.current = group;
    scene.add(group);
  }, [ready, map, mapDetail, mapStyle, themeTick, groundY]);

  // Picking: erst Stationen, dann Wege.
  useEffect(() => {
    const renderer = rendererRef.current, camera = cameraRef.current;
    if (!renderer || !camera || !ready) return;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number; button: number } | null = null;
    const stationHits = () => {
      const root = rootGroupRef.current;
      if (!root) return [] as THREE.Intersection[];
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(root.children, true)
        .filter((h) => h.object.userData?.station || h.object.userData?.edge);
    };
    const setPointer = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    };
    const move = (ev: PointerEvent) => {
      setPointer(ev);
      const hit = stationHits()[0];
      const s = hit?.object.userData?.station as Station | undefined;
      renderer.domElement.style.cursor = hit ? "pointer" : "grab";
      const name = s?.label ?? (hit?.object.userData?.edge ? "Verbindung" : "");
      if (name !== hoverRef.current) {
        hoverRef.current = name;
        setHoverName(name);
      }
    };
    const leave = () => {
      if (hoverRef.current) { hoverRef.current = ""; setHoverName(""); }
      renderer.domElement.style.cursor = "grab";
    };
    const press = (ev: PointerEvent) => { down = { x: ev.clientX, y: ev.clientY, button: ev.button }; };
    const click = (ev: PointerEvent) => {
      if (measureOnRef.current) return;
      // Nur die linke Taste wählt; rechts gehört im Begehen dem Verschieben.
      if (down?.button !== 0) return;
      // Beim Ziehen einer Station im Begehen gehört der Klick dem Ablegen.
      if (suppressClickRef.current) return;
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return;
      setPointer(ev);
      const hit = stationHits()[0];
      if (!hit) return;
      const s = hit.object.userData?.station as Station | undefined;
      if (s?.id != null) { stationActionsRef.current?.(s.id); return; }
      const edge = hit.object.userData?.edge as FlowEdge | undefined;
      if (edge) flowActionsRef.current?.(edge);
    };
    const dbl = (ev: MouseEvent) => {
      setPointer(ev as unknown as PointerEvent);
      const hit = stationHits()[0];
      const s = hit?.object.userData?.station as Station | undefined;
      if (!s) return;
      const c = controlsRef.current, cam = cameraRef.current;
      if (!c || !cam) return;
      const direction = cam.position.clone().sub(c.target);
      const distance = Math.max(c.minDistance,
        Math.min(c.maxDistance, Math.max(18, Math.max(s.w, s.h) * 4)));
      c.target.set(s.x, heightOf(s) / 2, s.y);
      cam.zoom = 1;
      cam.updateProjectionMatrix();
      // Fokussieren heißt nicht „Kamera neu erfinden“: dieselbe Blickrichtung
      // behalten, nur näher an die Station rücken.
      cam.position.copy(c.target).addScaledVector(direction.normalize(), distance);
      c.update();
    };
    const el = renderer.domElement;
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", press);
    el.addEventListener("pointerup", click);
    el.addEventListener("dblclick", dbl);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", press);
      el.removeEventListener("pointerup", click);
      el.removeEventListener("dblclick", dbl);
    };
  }, [ready]);

  worldRef.current = walkWorld;

  /** Eine weiche Fahrt zu einer Station; Rundgang und Studio benutzen sie. */
  const flyToStopRef = useRef<((stop: TourStop, ms?: number) => void) | null>(null);
  flyToStopRef.current = (stop: TourStop, ms = 900) => {
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls || walkRef.current.on) return;
    const st = stations.find((s) => s.id === stop.id);
    const h = st ? heightOf(st) : 1.5;
    const target = new THREE.Vector3(stop.x, activeOffsetRef.current + h / 2, stop.y);
    const az = rad(stop.azimuth), polar = rad(56);
    const d = Math.max(controls.minDistance, Math.min(controls.maxDistance, stop.distance));
    const toPos = new THREE.Vector3(
      target.x + d * Math.sin(polar) * Math.sin(az),
      target.y + d * Math.cos(polar),
      target.z + d * Math.sin(polar) * Math.cos(az),
    );
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    flyRef.current = {
      start: performance.now(), fromPos: camera.position.clone(), toPos,
      fromTarget: controls.target.clone(), toTarget: target, ms,
    };
  };

  // Darstellungsstufe „hoch": einmal aufbauen, beim Verlassen ganz abbauen.
  useEffect(() => {
    const renderer = rendererRef.current, scene = sceneRef.current;
    if (!ready || !renderer || !scene || quality !== "hoch") return;
    clearSelectionRef.current?.();
    const hq = enableHighQuality(renderer, scene);
    hq.fit(sceneBounds(floor, stations), hallH);
    hqRef.current = hq;
    hq.applyShadows(scene);
    hqRootRef.current = { root: rootGroupRef.current, frame: 0 };
    applySelectionRef.current?.();
    frameWatchRef.current = new FrameWatch(48, () => qualityDropRef.current?.());
    return () => {
      clearSelectionRef.current?.();
      hq.dispose();
      if (hqRef.current === hq) hqRef.current = null;
      frameWatchRef.current = null;
      hqRootRef.current = { root: null, frame: 0 };
      applySelectionRef.current?.();
    };
  // Die Halle selbst passt der nächste Effekt ein; hier nur Stufe und Thema.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, quality, themeTick]);
  useEffect(() => {
    hqRef.current?.fit(sceneBounds(floor, stations), hallH);
  }, [quality, floor, stations, hallH]);

  // Datenebene: Last als Wärme am Boden, Lichtsäulen.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!ready || !scene) return;
    const clear = () => {
      const old = overlayLayerRef.current;
      if (!old) return;
      old.traverse((o) => { if (o instanceof CSS2DObject) o.element.remove(); });
      disposeTree(old);
      old.removeFromParent();
      overlayLayerRef.current = null;
    };
    clear();
    if (!overlays?.heat && !overlays?.beams && !overlays?.supply) return;
    const layer = new THREE.Group();
    layer.name = "data-layer";
    layer.position.y = activeOffsetRef.current;
    scene.add(layer);
    overlayLayerRef.current = layer;
    if (overlays.heat) {
      const tex = heatTexture();
      for (const spot of heatSpots(stations, status)) {
        const mat = new THREE.MeshBasicMaterial({
          map: tex, color: new THREE.Color(spot.colour), transparent: true,
          opacity: spot.level == null ? 0.32 : 0.62, depthWrite: false,
        });
        const disc = new THREE.Mesh(new THREE.CircleGeometry(spot.radius, 48), mat);
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(spot.x, 0.03, spot.y);
        disc.renderOrder = 2;
        disc.userData = { noShadow: true, keepBasic: true, heat: spot };
        layer.add(disc);
      }
    }
    if (overlays.beams) {
      for (const s of stations) {
        const m = s.id != null ? status[s.id] : undefined;
        if (!m || (m.kind !== "ueber" && m.kind !== "voll")) continue;
        const h = Math.max(4, hallH * 0.92);
        const colour = m.kind === "ueber" ? 0xe0463f : 0xe2a12b;
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.28, Math.max(0.6, Math.min(s.w, s.h) * 0.42), h, 24, 1, true),
          new THREE.MeshBasicMaterial({
            color: colour, transparent: true, opacity: m.kind === "ueber" ? 0.26 : 0.18,
            side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
          }),
        );
        beam.position.set(s.x, h / 2, s.y);
        beam.userData = { noShadow: true, keepBasic: true, motion: "beam" };
        beam.renderOrder = 3;
        layer.add(beam);
      }
    }
    if (overlays.supply && overlays.supplyRisk) {
      const dangerHex = css("--g-supply-danger", "#d63c3c");
      const warnHex = css("--g-supply-warn", "#d9822b");
      for (const spot of supplyRiskSpots(stations, overlays.supplyRisk)) {
        const col = new THREE.Color(spot.severity === "danger" ? dangerHex : warnHex);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(0.4, spot.radius - 0.24), spot.radius, 40),
          new THREE.MeshBasicMaterial({
            color: col, transparent: true, opacity: spot.severity === "danger" ? 0.85 : 0.68,
            side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(spot.x, 0.05, spot.y);
        ring.renderOrder = 4;
        ring.userData = { noShadow: true, keepBasic: true, supplyRisk: spot };
        layer.add(ring);

        const h = Math.max(3.2, hallH * 0.72);
        const beacon = new THREE.Mesh(
          new THREE.CylinderGeometry(0.14, 0.22, h, 16, 1, true),
          new THREE.MeshBasicMaterial({
            color: col, transparent: true, opacity: spot.severity === "danger" ? 0.30 : 0.20,
            side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
          }),
        );
        beacon.position.set(spot.x, h / 2, spot.y);
        beacon.renderOrder = 4;
        beacon.userData = { noShadow: true, keepBasic: true, motion: "beam", supplyRisk: spot };
        layer.add(beacon);
      }
    }
    return clear;
  // status kommt über statusKey: ein neues Objekt mit denselben Werten baut nicht neu.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, overlays?.heat, overlays?.beams, overlays?.supply, overlays?.supplyRisk, statusKey, stations, themeTick, hallH, activeOffset]);

  // Aufzug: Ebenenwahl öffnen, wählen, schließen. Treppe: Hineingehen fährt
  // eine Ebene weiter, ohne Klick. Die Funktionen lesen den neuesten Stand;
  // die Tastatur-, Maus- und Bildschleifen-Behandlung des Begehens ruft sie.
  const walkApiRef = useRef<{
    open: (l: VerticalLink) => void; close: () => void; move: (d: number) => void; choose: (i: number) => void;
    stair: (l: VerticalLink, dir: StairDir) => void;
  }>({ open: () => {}, close: () => {}, move: () => {}, choose: () => {}, stair: () => {} });
  const relockWalk = () => {
    const el = rendererRef.current?.domElement;
    if (!el || walkEditRef.current || !window.matchMedia("(pointer: fine)").matches) return;
    try {
      const r = el.requestPointerLock?.() as unknown as Promise<void> | undefined;
      r?.catch?.(() => { /* ohne Maussperre bleibt das Ziehen */ });
    } catch { /* dito */ }
  };
  const rideTo = (link: VerticalLink, c: WalkLevel) => {
    if (rideRef.current || c.id === floor.id) return;
    const from = walkLevelsRef.current.find((l) => l.id === floor.id);
    const fromLevel = from?.level ?? 0;
    const dir: StairDir | undefined = c.level > fromLevel ? "up" : c.level < fromLevel ? "down" : undefined;
    const ms = rideMs(link.kind, fromLevel, c.level);
    rideRef.current = { kind: link.kind, name: link.name, toId: c.id, dir, until: performance.now() + ms + 450, arrived: false };
    setLiftMenu(null);
    setRide({ text: `${link.kind === "lift" ? "Aufzug" : "Treppe"} · ${from?.label ?? "hier"} → ${c.label}`, phase: "out" });
    window.setTimeout(() => walkLevelCbRef.current?.(c.id), 450);
    // Kommt die Ebene nicht (Netz weg), nicht im Dunkeln hängen bleiben.
    window.setTimeout(() => {
      if (rideRef.current && rideRef.current.toId === c.id && !rideRef.current.arrived) { rideRef.current = null; setRide(null); }
    }, 7000);
    relockWalk();
  };
  /** Befehle des Begehens für Tasten und Rechtsklick-Menü (lesen den neuesten Stand über Refs). */
  const walkCmdRef = useRef({
    /** Die Station im Blick (Kegel ±22°, ≤ 30 m). */
    ahead: (): Station | null => {
      const w = walkRef.current;
      const heading = ((((w.yaw * 180) / Math.PI) % 360) + 360) % 360;
      const id = viewerFocus(stationsRef.current, w.pos, heading).ahead?.id;
      return stationsRef.current.find((st) => st.id === id) ?? null;
    },
    open: (st: Station) => clickRef.current?.(st),
    goTo: (p: [number, number]) => { walkRef.current.goal = p; },
    /** Vor die Station gehen (Ziel-Logik des Bodenklicks), sonst hindrehen. */
    goToStation: (st: Station) => {
      const w = walkRef.current;
      const gap = Math.max(st.w, st.h) / 2 + 1.4;
      const dx = st.x - w.pos[0], dy = st.y - w.pos[1];
      const d = Math.hypot(dx, dy) || 1;
      w.goal = d > gap + 0.4 ? [st.x - (dx / d) * gap, st.y - (dy / d) * gap] : null;
      if (!w.goal) w.yaw = Math.atan2(dx, dy);
    },
    /** Die Figur hierher setzen (freier Punkt in der Nähe). */
    place: (p: [number, number]) => {
      const w = walkRef.current;
      const free = walkStart({ x: p[0] - 1.5, y: p[1] - 1.5, w: 3, h: 3 }, [], worldRef.current);
      if (!free) return;
      w.pos = free; w.goal = null; w.vf = 0; w.vs = 0;
    },
    /** Eine Ebene hinauf/hinunter, an derselben Stelle (sonst nächster freier Punkt). */
    level: (dir: StairDir): boolean => {
      if (rideRef.current) return false;
      const to = nextLevel(walkLevelsRef.current, floorRef.current.id, dir);
      if (!to) return false;
      walkLevelCbRef.current?.(to.id);
      return true;
    },
    canLevel: (dir: StairDir) => nextLevel(walkLevelsRef.current, floorRef.current.id, dir) !== null,
    /** Zurück zum Startpunkt am Tor. */
    home: () => {
      const w = walkRef.current, fl = floorRef.current;
      const b = sceneBounds(fl, stationsRef.current);
      const p = walkStart(b, (fl.doors ?? []) as { x: number; y: number }[], worldRef.current)
        ?? [b.x + b.w / 2, b.y + b.h / 2] as [number, number];
      w.pos = p; w.goal = null; w.vf = 0; w.vs = 0; w.pitch = -0.06;
      w.yaw = Math.atan2(b.x + b.w / 2 - p[0], b.y + b.h / 2 - p[1]);
    },
    /** 15° drehen, Lage bleibt (nur mit Bearbeiten-Recht). */
    rotate: (st: Station, deg: number) => {
      const r = ((((st.rotation + deg) % 360) + 540) % 360) - 180;
      moveCbRef.current?.(st, { x: st.x, y: st.y, rotation: r });
    },
  });
  /** Verschieben im Begehen: Zeiger frei, Stationen ziehen, danach wieder greifen. */
  const toggleWalkEdit = () => {
    const next = !walkEditRef.current;
    walkEditRef.current = next;
    setWalkEdit(next);
    if (next) {
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      cancelCarryRef.current?.();
      window.setTimeout(relockWalk, 0);
    }
  };
  walkEditToggleRef.current = toggleWalkEdit;
  // Werkzeug nur im Begehen und nur, wenn der Aufrufer das Speichern anbietet.
  useEffect(() => {
    if (walk && moveCbRef.current) return;
    walkEditRef.current = false;
    setWalkEdit(false);
    cancelCarryRef.current?.();
  }, [walk, onStationMove]);
  // Der Zeiger bleibt beim Verschieben sichtbar; beim Gehen ist er ein Fadenkreuz.
  useEffect(() => {
    const el = rendererRef.current?.domElement;
    if (!el || !ready) return;
    if (walk) el.style.cursor = walkEdit ? "default" : "crosshair";
  }, [walk, walkEdit, ready]);
  walkApiRef.current = {
    open: (link) => {
      // Nur der Aufzug öffnet die Ebenenwahl; die Treppe geht man.
      if (rideRef.current || link.kind !== "lift") return;
      if (document.pointerLockElement) document.exitPointerLock();
      const w = walkRef.current;
      w.keys.clear(); w.joy = null; w.goal = null;
      const choices = levelChoices(walkLevelsRef.current);
      setLiftMenu({ link, idx: Math.max(0, choices.findIndex((c) => c.id === floor.id)) });
    },
    close: () => { setLiftMenu(null); relockWalk(); },
    move: (d) => setLiftMenu((m) => {
      if (!m) return m;
      const n = levelChoices(walkLevelsRef.current).length || 1;
      return { ...m, idx: (m.idx + d + n) % n };
    }),
    choose: (i) => {
      const m = liftMenuRef.current;
      const c = levelChoices(walkLevelsRef.current)[i];
      if (!m || !c) return;
      if (c.id === floor.id) { setLiftMenu(null); relockWalk(); return; }
      rideTo(m.link, c);
    },
    stair: (link, dir) => {
      const to = nextLevel(walkLevelsRef.current, floor.id, dir);
      if (to) rideTo(link, to);
    },
  };

  // Nach der Fahrt: auf der neuen Ebene vor der gleichen Treppe / dem gleichen Aufzug stehen.
  useEffect(() => {
    const r = rideRef.current, w = walkRef.current;
    if (!r || r.arrived || !w.on || floor.id !== r.toId) return;
    r.arrived = true;
    const target = matchingLink(linksRef.current, r.kind, r.name);
    const b = sceneBounds(floor, stations);
    let pos: [number, number], yaw: number;
    // Nach einer Treppe auf die Gegenseite: von dort geht es zurück.
    const back: StairDir | undefined = r.dir === "up" ? "down" : r.dir === "down" ? "up" : undefined;
    if (target) { const a = arrivalSpot(target, back); pos = a.pos; yaw = a.yaw; }
    else {
      pos = walkStart(b, (floor.doors ?? []) as { x: number; y: number }[], worldRef.current) ?? [b.x + b.w / 2, b.y + b.h / 2];
      yaw = Math.atan2(b.x + b.w / 2 - pos[0], b.y + b.h / 2 - pos[1]);
    }
    // Steht dort etwas, ein freier Punkt in der Nähe.
    pos = walkStart({ x: pos[0] - 1.5, y: pos[1] - 1.5, w: 3, h: 3 }, [], worldRef.current) ?? pos;
    w.pos = pos; w.yaw = yaw; w.pitch = 0; w.vf = 0; w.vs = 0; w.goal = null; w.keys.clear();
    w.ground = 0; w.groundSmooth = 0;
    walkFloorRef.current = floor.id;
    const left = Math.max(250, r.until - performance.now());
    window.setTimeout(() => setRide((x) => (x ? { ...x, phase: "in" } : x)), left);
    window.setTimeout(() => { rideRef.current = null; setRide(null); }, left + 500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor.id]);

  // Durch eine Hallentür: die aktive Halle ist gewechselt, die Figur steht schon
  // in deren Achsen. Ein zweiter Blick auf die neue Ebene setzt niemanden zurück.
  useEffect(() => {
    const p = pendingHallRef.current, w = walkRef.current;
    if (!p || p.floorId !== floor.id) return;
    pendingHallRef.current = null;
    if (!w.on) return;
    walkFloorRef.current = floor.id;
    w.pos = p.pos;
    w.yaw = p.yaw;
    w.pitch = 0;
    w.vf = 0; w.vs = 0;
    w.goal = null;
    w.keys.clear();
    w.ground = 0; w.groundSmooth = 0;
  }, [floor.id]);

  // Ebene gewechselt, ohne Treppe, Aufzug oder Tür (Auswahlfeld, Liste,
  // Assistent): an derselben Stelle weitergehen, wenn dort Boden und Platz ist,
  // sonst am nächsten freien Punkt; außerhalb der neuen Ebene vor einer Treppe
  // oder am Tor. Bis 2026-11-07 stand man danach womöglich in einer Maschine.
  useEffect(() => {
    const w = walkRef.current;
    if (!w.on || walkFloorRef.current === floor.id) return;
    walkFloorRef.current = floor.id;
    if (rideRef.current) return;
    const outline = floor.outline ?? [];
    const inside = outline.length < 3 || pointInPolygon(w.pos, outline);
    const b = sceneBounds(floor, stations);
    let pos: [number, number] | null = inside
      ? walkStart({ x: w.pos[0] - 1.5, y: w.pos[1] - 1.5, w: 3, h: 3 }, [], worldRef.current)
        ?? walkStart({ x: w.pos[0] - 5, y: w.pos[1] - 5, w: 10, h: 10 }, [], worldRef.current)
      : null;
    if (!pos) {
      const link = verticalLinks(floor, stations)[0];
      pos = link ? arrivalSpot(link).pos
        : walkStart(b, (floor.doors ?? []) as { x: number; y: number }[], worldRef.current)
          ?? [b.x + b.w / 2, b.y + b.h / 2];
      w.yaw = Math.atan2(b.x + b.w / 2 - pos[0], b.y + b.h / 2 - pos[1]);
    }
    w.pos = pos;
    w.vf = 0; w.vs = 0; w.goal = null;
    w.ground = 0; w.groundSmooth = 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor.id]);

  // Begehen wie im Spiel: Maus anklicken sperrt den Zeiger, dann schaut die Maus um;
  // WASD und Pfeile gehen (links/rechts seitwärts), Shift läuft, E öffnet am
  // Aufzug die Ebenenwahl, die Treppe steigt man Stufe für Stufe hinauf oder
  // hinunter, Esc gibt die Maus frei (ein zweites Esc beendet). Ohne Maussperre (Touch, gesperrt): links ziehen = Steuerknüppel,
  // rechts ziehen = umsehen, Klick auf den Boden = dorthin, Rad = Schritt.
  useEffect(() => {
    const renderer = rendererRef.current, controls = controlsRef.current, camera = cameraRef.current;
    if (!ready || !renderer || !controls || !camera || !walk) return;
    const w = walkRef.current;
    // Beim Gehen zählt die Bildrate mehr als die letzte Schärfe: der Renderer
    // zeichnet mit etwas weniger Pixeln, die Kantenglättung bleibt. Beim
    // Verlassen stellt die Aufräumfunktion die vorherige Auflösung wieder her.
    // Aus der vollen Dichte des Geräts, nie aus der gerade aktuellen: die ist
    // nach einer zähen Drehung vorübergehend ×0,66 und blieb sonst beim Gehen.
    renderer.setPixelRatio(Math.min(baseRatioRef.current, 1.5));
    // Augenhöhe braucht ein natürliches Blickfeld (task 41 I, Owner 2026-11-08
    // „Figuren und Stapler zu groß“): die 38° der Hallenansicht wirkten in
    // 1,7 m Höhe wie ein Teleobjektiv — alles in wenigen Metern Abstand
    // füllte das Bild und sah übergroß aus. Beim Verlassen zurück.
    const previousFov = camera.fov;
    camera.fov = WALK_FOV_DEG;
    camera.updateProjectionMatrix();
    resizeRef.current?.();
    const b = sceneBounds(floor, stations);
    const spawn = walkFrom && Number.isFinite(walkFrom[0]) && Number.isFinite(walkFrom[1])
      ? (walkStart({ x: walkFrom[0] - 2, y: walkFrom[1] - 2, w: 4, h: 4 }, [], worldRef.current) ?? null)
      : null;
    let start = spawn
      ?? walkStart(b, (floor.doors ?? []) as { x: number; y: number }[], worldRef.current)
      ?? [b.x + b.w / 2, b.y + b.h / 2] as [number, number];
    // Nicht im Treppenkörper starten: seit die Treppe begehbar ist, sind nur
    // ihre Geländer Körper. Liegt der abgesetzte Punkt im Lauf, beginnt man
    // stattdessen davor — sonst steht die Kamera unter der Treppe.
    const linkAtStart = verticalLinks(floor, stations).find((l) => pointInPolygon(start, linkFootprint(l)));
    if (linkAtStart) start = arrivalSpot(linkAtStart).pos;
    w.pos = start;
    if (spawn) {
      // Abgesetzt: in die Richtung schauen, in die die Kamera schon schaute.
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      w.yaw = Math.atan2(dir.x, dir.z);
    } else {
      w.yaw = Math.atan2(b.x + b.w / 2 - start[0], b.y + b.h / 2 - start[1]);
    }
    w.pitch = -0.06;
    w.keys.clear();
    w.joy = null;
    w.goal = null;
    w.ground = 0; w.groundSmooth = 0;
    w.on = true;
    walkFloorRef.current = floor.id;
    const startFloor = floor.id;
    flyRef.current = null;
    controls.enabled = false;
    const saved = { pos: camera.position.clone(), target: controls.target.clone() };
    const el = renderer.domElement;
    const MOVE = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
    const typing = (t: EventTarget | null) => t instanceof HTMLElement
      && !(t instanceof HTMLInputElement && /^(checkbox|radio)$/.test(t.type))
      && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    let legacy = false;
    const locked = () => document.pointerLockElement === el;
    const interact = () => {
      // Nur der Aufzug: die Treppe löst beim Hineingehen aus.
      const near = nearestLink(linksRef.current, w.pos);
      if (near?.kind === "lift" && walkLevelsRef.current.length > 1) walkApiRef.current.open(near);
    };
    /** Eine gegriffene Station: ihre Bildobjekte folgen der Maus bis zum Ablegen. */
    let carry: {
      s: Station; rotation: number; moved: boolean; button: number;
      cx: number; cy: number; ox: number; oy: number;
      /** Versatz von der gegriffenen Bodenstelle zur Stationsmitte — ein Griff
          an der Ecke verschiebt die Maschine nicht sprunghaft. */
      grab: [number, number];
      last: { x: number; y: number; rotation: number } | null;
      tags: { o: THREE.Object3D; x: number; z: number; yaw: number }[];
    } | null = null;
    /** Blickbewegung mit gegriffener Station (gesperrte Maus): erst ab ein paar
        Pixeln zählt das Tragen als Ziehen — ein ruhiger Rechtsklick öffnet das Menü. */
    let carryLook = 0;
    /** Rechts gedrückt bei gesperrter Maus, ohne Station im Fadenkreuz. */
    let rightLocked = false;
    /** Bildmitte: bei gesperrter Maus liegt der Zeiger immer dort. */
    const centerClient = (): [number, number] => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
    const keydown = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const handled = () => { e.preventDefault(); e.stopPropagation(); };
      // Rückgängig/Wiederholen auch mitten im Gehen; eine gegriffene Station
      // legt Strg+Z erst zurück. Capture-Phase: die Seite sieht die Taste nicht doppelt.
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && (e.code === "KeyZ" || e.code === "KeyY")) {
        handled();
        if (carry) { cancelCarry(); return; }
        if (e.code === "KeyY" || e.shiftKey) redoRef.current?.(); else undoRef.current?.();
        return;
      }
      if (ctxMenuRef.current) {
        if (e.code === "Escape" || e.code === "ContextMenu") { setCtxMenu(null); handled(); return; }
        // Losgehen schließt das Menü.
        if (MOVE.has(e.code)) setCtxMenu(null);
        else return;
      }
      if (walkHelpRef.current && (e.code === "Escape" || e.code === "KeyH" || e.code === "F1")) {
        setWalkHelp(false); handled(); return;
      }
      if (liftMenuRef.current) {
        // Ebenenwahl offen: Pfeile wählen, Enter fährt, Ziffern springen, Esc oder E schließt.
        if (e.code === "Escape" || e.code === "KeyE") walkApiRef.current.close();
        else if (e.code === "ArrowUp" || e.code === "KeyW") walkApiRef.current.move(-1);
        else if (e.code === "ArrowDown" || e.code === "KeyS") walkApiRef.current.move(1);
        else if (e.code === "Enter") walkApiRef.current.choose(liftMenuRef.current.idx);
        else if (/^(Digit|Numpad)[1-9]$/.test(e.code)) walkApiRef.current.choose(Number(e.code.slice(-1)) - 1);
        else return;
        // Capture-Phase: weder ein fokussierter Knopf (Enter) noch die Studio-Kürzel (1–4) sehen die Taste.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.code === "Escape") {
        // Ein gegriffenes Teil zuerst zurücklegen; dann gibt Esc die Maus frei.
        if (carry) { cancelCarry(); e.preventDefault(); return; }
        // Mit Maussperre gibt das erste Esc nur die Maus frei; das zweite beendet.
        if (locked()) document.exitPointerLock(); else walkChangeRef.current?.(false);
        return;
      }
      if (e.code === "KeyV" && !e.repeat && moveCbRef.current) {
        walkEditToggleRef.current();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (carry && e.code === "KeyR") {
        // Drehen wie im Hallen-Editor, in 15°-Schritten; Shift dreht zurück.
        carry.rotation = (((carry.rotation + (e.shiftKey ? -15 : 15)) % 360) + 540) % 360 - 180;
        applyCarry(carry.cx, carry.cy);
        e.preventDefault();
        return;
      }
      if (e.code === "KeyE" && !e.repeat) { interact(); e.preventDefault(); e.stopPropagation(); return; }
      // Mit Strg/Alt ist nichts davon gemeint (Strg+W, Alt+Tab …).
      if (mod || e.altKey) return;
      if (!e.repeat) {
        if (e.code === "KeyH" || e.code === "F1") { setWalkHelp((v) => !v); handled(); return; }
        if (e.code === "ContextMenu" || (e.shiftKey && e.code === "F10")) {
          const [cx, cy] = centerClient();
          openCtx(stationAt(cx, cy), cx, cy); handled(); return;
        }
        if (e.code === "KeyQ" || e.code === "KeyX") {
          const s = walkCmdRef.current.ahead();
          if (s) { if (e.code === "KeyQ") walkCmdRef.current.open(s); else walkCmdRef.current.goToStation(s); }
          handled(); return;
        }
        if (e.code === "PageUp" || e.code === "PageDown") {
          walkCmdRef.current.level(e.code === "PageUp" ? "up" : "down"); handled(); return;
        }
        if (e.code === "Home") { walkCmdRef.current.home(); handled(); return; }
      }
      if (MOVE.has(e.code)) { w.keys.add(e.code); w.goal = null; e.preventDefault(); }
    };
    const keyup = (e: KeyboardEvent) => { w.keys.delete(e.code); };
    const blur = () => { w.keys.clear(); w.joy = null; };
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const floorAt = (cx: number, cy: number): [number, number] | null => {
      plane.constant = -activeOffsetRef.current;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      const hit = new THREE.Vector3();
      return ray.ray.intersectPlane(plane, hit) ? [hit.x, hit.z] : null;
    };
    /** Die Station unter der Maus — nur im Begehen mit freiem Zeiger. */
    const stationAt = (cx: number, cy: number): Station | null => {
      const root = rootGroupRef.current;
      if (!root) return null;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(root.children, true).find((h) => h.object.userData?.station);
      return (hit?.object.userData?.station as Station | undefined) ?? null;
    };
    /** Die gegriffene Station an die Mausstelle schieben (Raster, Hallenrand,
        höchstens sieben Meter vor dem Gehenden). */
    const applyCarry = (cx: number, cy: number) => {
      if (!carry) return;
      if (locked()) [cx, cy] = centerClient();
      carry.cx = cx;
      carry.cy = cy;
      const p = floorAt(cx, cy);
      if (!p) return;
      const active = walkHallsRef.current[0];
      const box = sceneBounds(floorRef.current, active?.stations ?? []);
      let x = Math.min(box.x + box.w, Math.max(box.x, p[0] + carry.grab[0]));
      let y = Math.min(box.y + box.h, Math.max(box.y, p[1] + carry.grab[1]));
      const dx = x - w.pos[0], dy = y - w.pos[1], d = Math.hypot(dx, dy);
      if (d > 7) { x = w.pos[0] + (dx / d) * 7; y = w.pos[1] + (dy / d) * 7; }
      const next = movedStation(x, y, carry.rotation, Number(floorRef.current.snap) || 0);
      carry.last = next;
      if (Math.hypot(next.x - carry.s.x, next.y - carry.s.y) > 0.01 || next.rotation !== carry.s.rotation) {
        carry.moved = true;
      }
      const dyaw = -rad(next.rotation - carry.s.rotation);
      for (const t of carry.tags) {
        t.o.position.x = t.x + (next.x - carry.s.x);
        t.o.position.z = t.z + (next.y - carry.s.y);
        t.o.rotation.y = t.yaw + dyaw;
      }
    };
    /** Alles wieder an seinen Platz — Abbruch ohne Speichern. */
    const cancelCarry = () => {
      if (!carry) return;
      for (const t of carry.tags) {
        t.o.position.x = t.x;
        t.o.position.z = t.z;
        t.o.rotation.y = t.yaw;
      }
      carry = null;
      suppressClickRef.current = false;
      setCarryName("");
      el.style.cursor = "default";
    };
    cancelCarryRef.current = cancelCarry;
    const beginCarry = (s: Station, e: PointerEvent) => {
      const cx = locked() ? centerClient()[0] : e.clientX;
      const cy = locked() ? centerClient()[1] : e.clientY;
      const tags: { o: THREE.Object3D; x: number; z: number; yaw: number }[] = [];
      rootGroupRef.current?.traverse((o) => {
        const t = o.userData?.stationMove as { id: number; x: number; z: number; yaw: number } | undefined;
        if (t && t.id === s.id) tags.push({ o, x: t.x, z: t.z, yaw: t.yaw });
      });
      const p = floorAt(cx, cy);
      carry = {
        s, rotation: s.rotation, moved: false, button: e.button,
        cx, cy, ox: cx, oy: cy, grab: p ? [s.x - p[0], s.y - p[1]] : [0, 0],
        last: null, tags,
      };
      carryLook = 0;
      // Der Auswahl-Klick des 3D-Picking gehört jetzt dem Ziehen.
      suppressClickRef.current = true;
      setCarryName(s.label);
      el.style.cursor = "grabbing";
    };
    const finishCarry = () => {
      if (!carry) return;
      const c = carry;
      carry = null;
      setCarryName("");
      el.style.cursor = "default";
      if (c.moved && c.last) moveCbRef.current?.(c.s, c.last);
      // Ein Klick ohne Ziehen wählt die Station — wie ein Klick auf den Grundriss.
      else if (!c.moved) clickRef.current?.(c.s);
      // Der Auswahl-Klick des 3D-Picking sieht diesen Zeiger nicht mehr.
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    /** Rechtsklick-Menü an einer Bildschirmstelle; gibt die Maus frei, damit man wählen kann. */
    const openCtx = (station: Station | null, cx: number, cy: number) => {
      if (locked()) document.exitPointerLock();
      w.keys.clear(); w.joy = null; w.goal = null; hideJoy();
      const r = el.getBoundingClientRect();
      setCtxMenu({ x: cx - r.left, y: cy - r.top, station, point: floorAt(cx, cy) });
    };
    walkActionsRef.current = {
      // Aus dem Menü „Verschieben“: die Station hängt am Zeiger, ein Klick legt ab.
      carry: (s, cx, cy) => {
        const r = el.getBoundingClientRect();
        beginCarry(s, { clientX: r.left + cx, clientY: r.top + cy, button: 0 } as PointerEvent);
      },
    };
    const showJoy = (x: number, y: number, dx: number, dy: number) => {
      const box = joyElRef.current, knob = joyKnobRef.current;
      if (!box || !knob) return;
      const r = el.getBoundingClientRect();
      box.style.display = "block";
      box.style.left = `${x - r.left}px`;
      box.style.top = `${y - r.top}px`;
      const len = Math.hypot(dx, dy), max = 46;
      const k = len > max ? max / len : 1;
      knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    };
    const hideJoy = () => { if (joyElRef.current) joyElRef.current.style.display = "none"; };
    let drag: { x: number; y: number; lastX: number; lastY: number; button: number; moved: boolean } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      // Während eine Station in der Hand liegt, tut ein zweiter Knopf nichts.
      if (carry) return;
      if (walkEditRef.current) {
        // Verschieben: der Zeiger ist frei. Rechts greift eine Station oder
        // schaut um; links greift ebenfalls, ein Klick auf den Boden sperrt nicht.
        if (locked()) {
          if (e.button === 2) {
            const s = stationAt(...centerClient());
            if (s?.id != null) { beginCarry(s, e); return; }
          }
          document.exitPointerLock();
          return;
        }
        if (e.button === 2) {
          const s = stationAt(e.clientX, e.clientY);
          if (s?.id != null) { beginCarry(s, e); el.setPointerCapture?.(e.pointerId); return; }
          drag = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, button: 2, moved: false };
          el.setPointerCapture?.(e.pointerId);
          return;
        }
        suppressClickRef.current = false;
        const s = stationAt(e.clientX, e.clientY);
        if (s?.id != null) {
          suppressClickRef.current = true;
          beginCarry(s, e);
          el.setPointerCapture?.(e.pointerId);
        }
        return;
      }
      if (e.pointerType === "mouse" && !legacy && matchMedia("(pointer: fine)").matches) {
        if (liftMenuRef.current || rideRef.current) return;
        if (!locked()) {
          // Ohne Maussperre: Rechts greift eine Station (sonst umsehen),
          // Links übernimmt die Maus wie bisher.
          if (e.button === 2) {
            const s = stationAt(e.clientX, e.clientY);
            if (s?.id != null) { beginCarry(s, e); el.setPointerCapture?.(e.pointerId); return; }
            drag = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, button: 2, moved: false };
            el.setPointerCapture?.(e.pointerId);
            return;
          }
          try {
            const r = el.requestPointerLock?.() as unknown as Promise<void> | undefined;
            if (!el.requestPointerLock) legacy = true;
            r?.catch?.(() => { legacy = true; });
          } catch { legacy = true; }
          return;
        }
        // Gesperrt: links benutzt, was vor einem liegt; rechts greift die
        // Station im Fadenkreuz und zieht sie mit dem Blick mit.
        if (e.button === 0) interact();
        else if (e.button === 2) {
          const s = stationAt(...centerClient());
          if (s?.id != null) beginCarry(s, e);
          else rightLocked = true;
        }
        return;
      }
      drag = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, button: e.shiftKey ? 2 : e.button, moved: false };
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (carry) {
        carry.moved = carry.moved || Math.hypot(e.clientX - carry.ox, e.clientY - carry.oy) > 4;
        applyCarry(e.clientX, e.clientY);
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true;
      if (!drag.moved) return;
      if (drag.button === 2) {
        // Umsehen: das Bild folgt der Maus wie ein gegriffenes Foto.
        w.yaw += (e.clientX - drag.lastX) * 0.0045;
        w.pitch = Math.max(-1.2, Math.min(1.2, w.pitch + (e.clientY - drag.lastY) * 0.0045));
      } else {
        w.joy = { dx, dy };
        showJoy(drag.x, drag.y, dx, dy);
      }
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (carry) {
        if (e.type !== "pointercancel" && e.button !== carry.button) return;
        // Rechtsklick ohne Ziehen auf eine Station: Menü statt Tragen.
        if (carry.button === 2 && !carry.moved && e.type !== "pointercancel") {
          const s = carry.s;
          const [cx, cy] = locked() ? centerClient() : [e.clientX, e.clientY];
          cancelCarry();
          drag = null;
          openCtx(s, cx, cy);
          return;
        }
        finishCarry();
        drag = null;
        return;
      }
      if (rightLocked && e.button === 2) {
        rightLocked = false;
        const [cx, cy] = centerClient();
        if (e.type !== "pointercancel") openCtx(stationAt(cx, cy), cx, cy);
        return;
      }
      if (drag && !drag.moved && drag.button === 2 && e.type !== "pointercancel") {
        drag = null;
        openCtx(stationAt(e.clientX, e.clientY), e.clientX, e.clientY);
        return;
      }
      if (drag && !drag.moved && drag.button === 0) {
        const p = floorAt(e.clientX, e.clientY);
        if (p) w.goal = p;
      }
      drag = null;
      w.joy = null;
      hideJoy();
    };
    // Maussperre: jede Bewegung dreht den Blick (rechts = nach rechts, hoch = nach oben).
    const look = (e: MouseEvent) => {
      if (!locked()) return;
      const dx = Math.max(-250, Math.min(250, e.movementX || 0));
      const dy = Math.max(-250, Math.min(250, e.movementY || 0));
      w.yaw -= dx * 0.0022;
      w.pitch = Math.max(-1.35, Math.min(1.35, w.pitch - dy * 0.0022));
      if (carry) {
        carryLook += Math.abs(dx) + Math.abs(dy);
        if (carryLook > 8) carry.moved = true;
        applyCarry(0, 0);
      }
    };
    const lockChange = () => { setWalkLocked(locked()); if (locked()) { drag = null; w.joy = null; hideJoy(); } };
    const lockError = () => { legacy = true; setWalkLocked(false); };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (liftMenuRef.current) return;
      const steps = Math.max(-3, Math.min(3, -e.deltaY / 100));
      // Ein Rad-Schritt ≈ ein Meter, mit derselben Kollision wie das Gehen.
      for (let i = 0; i < 10; i++) {
        w.pos = walkStep(w.pos, w.yaw, { forward: Math.sign(steps), strafe: 0 }, Math.abs(steps) / (10 * 1.6), worldRef.current).pos;
      }
    };
    const noMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    document.addEventListener("mousemove", look);
    document.addEventListener("pointerlockchange", lockChange);
    document.addEventListener("pointerlockerror", lockError);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("contextmenu", noMenu);
    el.style.cursor = "crosshair";
    // Ein fokussierter Werkzeugknopf (Begehen) würde Enter als Klick nehmen.
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
      document.removeEventListener("mousemove", look);
      document.removeEventListener("pointerlockchange", lockChange);
      document.removeEventListener("pointerlockerror", lockError);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("contextmenu", noMenu);
      cancelCarry();
      cancelCarryRef.current = null;
      suppressClickRef.current = false;
      if (locked()) document.exitPointerLock();
      setWalkLocked(false);
      setLiftMenu(null);
      setCtxMenu(null);
      setWalkHelp(false);
      setWalkPrompt("");
      setWalkPromptKind(null);
      promptKeyRef.current = "";
      rideRef.current = null;
      setRide(null);
      hideJoy();
      w.on = false;
      w.keys.clear();
      w.joy = null;
      w.goal = null;
      w.vf = 0; w.vs = 0;
      controls.enabled = true;
      renderer.setPixelRatio(baseRatioRef.current);
      camera.fov = previousFov;
      camera.updateProjectionMatrix();
      resizeRef.current?.();
      if (floorRef.current.id === startFloor) {
        camera.position.copy(saved.pos);
        controls.target.copy(saved.target);
      } else {
        // Auf einer anderen Ebene oder in einer anderen Halle ausgestiegen: die
        // alte Kamera gehört zu anderen Achsen. Von schräg hinten über den
        // Standpunkt schauen, in die Richtung, in die man zuletzt ging.
        const ty = activeOffsetRef.current + 1.2;
        controls.target.set(w.pos[0], ty, w.pos[1]);
        camera.position.set(w.pos[0] - Math.sin(w.yaw) * 20, ty + 14, w.pos[1] - Math.cos(w.yaw) * 20);
      }
      camera.lookAt(controls.target);
      controls.update();
      el.style.cursor = "grab";
    };
  // Startpunkt nur beim Einschalten: eine Aktualisierung setzt niemanden zurück.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, walk, walkFrom]);

  // Messen: Klicks auf den Boden (y = 0) setzen Punkte; Esc leert, Rücktaste nimmt den letzten.
  const redrawMeasure = () => {
    const scene = sceneRef.current;
    const m = measureRef.current;
    if (m.group) {
      m.group.traverse((o) => { if (o instanceof CSS2DObject) o.element.remove(); });
      disposeTree(m.group);
      m.group.removeFromParent();
      m.group = null;
    }
    const total = polylineMetres(m.points);
    measureCbRef.current?.(total, m.points.length);
    if (!scene || !m.points.length) return;
    const g = new THREE.Group();
    g.name = "measure";
    scene.add(g);
    m.group = g;
    const accent = new THREE.Color(css("--g-info", "#2d72d2"));
    const dotGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.08, 20);
    const dotMat = new THREE.MeshBasicMaterial({ color: accent });
    for (const [x, y] of m.points) {
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(x, activeOffset + 0.06, y);
      dot.userData = { noShadow: true, keepBasic: true };
      g.add(dot);
    }
    if (m.points.length >= 2) {
      const geo = new LineGeometry();
      geo.setPositions(m.points.flatMap(([x, y]) => [x, activeOffset + 0.08, y]));
      const mat = new LineMaterial({ color: accent.getHex(), linewidth: 3, worldUnits: false });
      const st = stageSizeRef.current;
      mat.resolution.set(st.w || 800, st.h || 600);
      g.add(new Line2(geo, mat));
      for (let i = 1; i < m.points.length; i++) {
        const a = m.points[i - 1], b = m.points[i];
        const seg = document.createElement("span");
        seg.className = "three-measure-seg";
        seg.textContent = fmtMetres(Math.hypot(b[0] - a[0], b[1] - a[1]));
        addCssLabel(g, seg, (a[0] + b[0]) / 2, activeOffset + 0.3, (a[1] + b[1]) / 2);
      }
    }
    const last = m.points[m.points.length - 1];
    const tag = document.createElement("span");
    tag.className = "three-measure-total";
    tag.textContent = m.points.length >= 2 ? `Σ ${fmtMetres(total)}` : "Startpunkt";
    addCssLabel(g, tag, last[0], activeOffset + 0.9, last[1]);
  };
  const redrawMeasureRef = useRef(redrawMeasure);
  redrawMeasureRef.current = redrawMeasure;
  useEffect(() => {
    const renderer = rendererRef.current, camera = cameraRef.current;
    if (!ready || !renderer || !camera) return;
    const m = measureRef.current;
    if (!measure) {
      if (m.points.length || m.group) { m.points = []; redrawMeasureRef.current(); }
      return;
    }
    // Nach einem Ebenenwechsel liegen die Punkte sonst auf der alten Höhe.
    if (m.points.length) redrawMeasureRef.current();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    const el = renderer.domElement;
    let down: { x: number; y: number } | null = null;
    const press = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const release = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const rect = el.getBoundingClientRect();
      ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ptr, camera);
      const hit = new THREE.Vector3();
      plane.constant = -activeOffsetRef.current;
      if (!ray.ray.intersectPlane(plane, hit)) return;
      m.points.push([Math.round(hit.x * 100) / 100, Math.round(hit.z * 100) / 100]);
      if (m.points.length > 24) m.points.shift();
      redrawMeasureRef.current();
    };
    const key = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.code === "Escape") { m.points = []; redrawMeasureRef.current(); }
      if (e.code === "Backspace" && m.points.length) { e.preventDefault(); m.points.pop(); redrawMeasureRef.current(); }
    };
    el.addEventListener("pointerdown", press);
    el.addEventListener("pointerup", release);
    window.addEventListener("keydown", key);
    el.style.cursor = "crosshair";
    return () => {
      el.removeEventListener("pointerdown", press);
      el.removeEventListener("pointerup", release);
      window.removeEventListener("keydown", key);
      el.style.cursor = "grab";
    };
  }, [ready, measure, activeOffset]);

  // Rundgang: Haltepunkte kommen von außen (Studio), die Schleife fährt sie ab.
  useEffect(() => {
    if (!ready) return;
    if (!tour || !tour.length || walk) {
      if (tourRef.current) { tourRef.current = null; tourStopRef.current?.(null); }
      return;
    }
    tourRef.current = { stops: tour, index: 0, since: performance.now() };
    flyToStopRef.current?.(tour[0], 1600);
    tourStopRef.current?.(tour[0]);
    return () => { tourRef.current = null; };
  }, [ready, tour, walk]);

  // Simulation: Geister-Roboter und Engstellen als eigene Ebene.
  useEffect(() => {
    const scene = sceneRef.current;
    const sim = simRef.current;
    const clear = () => {
      if (sim.layer) {
        sim.layer.traverse((o) => { if (o instanceof CSS2DObject) o.element.remove(); });
        disposeTree(sim.layer);
        sim.layer.removeFromParent();
      }
      sim.layer = null;
      sim.ghosts = [];
    };
    clear();
    if (!ready || !scene || !simFleet) return;
    sim.clock = simFleet.clock;
    const layer = new THREE.Group();
    layer.name = "sim-layer";
    layer.position.y = activeOffsetRef.current;
    scene.add(layer);
    sim.layer = layer;
    simFleet.robots.forEach((r, i) => {
      const group = buildRobotModel({
        id: -(i + 1), name: r.name, kind: r.kind, floor_id: floor.id, active: true, state: "moving",
        simulated: true, gateway_id: "sim", battery_pct: null, payload_kg: 0, capabilities: [], route: [],
        route_mode: "pingpong", route_m: 0, speed_m_s: 0, progress_m: 0, x: null, y: null, heading_deg: null,
      } as Robot);
      if (r.planned) {
        // Geplant heißt: durchscheinend, mit gestricheltem Ring — nie mit einem
        // echten Roboter zu verwechseln.
        setDeviceOpacity(group, 0.62);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.95, 1.12, 40),
          new THREE.MeshBasicMaterial({ color: 0x7c4dff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.02;
        ring.userData = { noShadow: true, keepBasic: true };
        group.add(ring);
      }
      group.traverse((o) => { o.userData = { ...(o.userData ?? {}), simRobot: r.id }; });
      const label = document.createElement("span");
      label.className = `three-sim-label${r.planned ? " is-planned" : ""}`;
      label.textContent = r.name;
      addCssLabel(group, label, 0, 1.6, 0);
      layer.add(group);
      sim.ghosts.push({ group, label, track: simFleet.tracks[r.id] ?? [], start: r.start, name: r.name, last: "" });
    });
    for (const h of simFleet.hotspots) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.6, 2.1, 40),
        new THREE.MeshBasicMaterial({ color: 0xe0463f, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(h.x, 0.04, h.y);
      ring.userData = { noShadow: true, keepBasic: true };
      layer.add(ring);
      // Eine einzelne Begegnung bleibt ein Ring; erst wiederholte bekommen eine Zahl.
      if (h.count >= 2) {
        const tag = document.createElement("span");
        tag.className = "three-sim-hotspot";
        tag.textContent = `${h.count}× eng`;
        addCssLabel(layer, tag, h.x, 0.6, h.y);
      }
    }
    return clear;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, simFleet, themeTick, activeOffset]);

  const rotateCamera = (delta: number) => {
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls) return;
    const offset = camera.position.clone().sub(controls.target);
    const radius = offset.length();
    const polar = controls.getPolarAngle();
    const az = controls.getAzimuthalAngle() + rad(delta);
    camera.position.set(
      controls.target.x + radius * Math.sin(polar) * Math.sin(az),
      controls.target.y + radius * Math.cos(polar),
      controls.target.z + radius * Math.sin(polar) * Math.cos(az),
    );
    camera.lookAt(controls.target);
    controls.update();
  };

  const zoomCamera = (factor: number) => {
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls) return;
    // Näher heran heißt: die Kamera rückt heran, nicht das Objektiv wird
    // weiter. Ein geändertes Sichtfeld verzerrte beim Herauszoomen den Grund.
    const offset = camera.position.clone().sub(controls.target);
    const distance = Math.max(controls.minDistance,
      Math.min(controls.maxDistance, offset.length() / factor));
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    camera.position.copy(controls.target).addScaledVector(offset.normalize(), distance);
    controls.update();
  };

  /** Drei feste Blicke auf dieselbe Halle. Die Fahrt ist weich, aber kurz;
      wer Bewegung reduziert hat, springt direkt ans Ziel. */
  const flyToPreset = (kind: "top" | "front" | "iso") => {
    if (kind === "iso") { setCameraReset((n) => n + 1); return; }
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls) return;
    const b = sceneBounds(floor, stations);
    const centre = new THREE.Vector3(b.x + b.w / 2, 0, b.y + b.h / 2);
    const distance = fitDistanceRef.current || 40;
    const target = centre.clone().setY(activeOffset + (kind === "top" ? 0 : 1.1));
    const dir = kind === "top"
      ? new THREE.Vector3(0.02, 1, 0.02).normalize()
      : new THREE.Vector3(0.12, 0.62, 1).normalize();
    const toPos = target.clone().addScaledVector(dir, distance * (kind === "top" ? 0.9 : 0.8));
    flyRef.current = {
      start: performance.now(), fromPos: camera.position.clone(), toPos,
      fromTarget: controls.target.clone(), toTarget: target,
    };
  };

  // Jede Darstellung mit neuen Eigenschaften kann die Szene geändert haben:
  // zwei Bilder anfordern (billig, weil ohne Änderung nichts weiter folgt).
  useEffect(() => { invalidate(); });

  useImperativeHandle(handleRef, () => withInvalidate(invalidate, {
    flyToStation(id: number) {
      const s = stations.find((x) => x.id === id);
      const controls = controlsRef.current;
      if (!s) return;
      // Im Begehen fliegt niemand: zur Station hindrehen und davor gehen
      // (Klick-auf-den-Boden-Logik, bleibt an Körpern hängen und gibt auf).
      if (walkRef.current.on) { walkCmdRef.current.goToStation(s); return; }
      const az = controls ? (controls.getAzimuthalAngle() * 180) / Math.PI : 45;
      flyToStopRef.current?.({
        id, label: s.label, x: s.x, y: s.y,
        distance: Math.max(12, Math.max(s.w, s.h) * 4), azimuth: az,
      }, 700);
    },
    getCamera() {
      const camera = cameraRef.current, controls = controlsRef.current;
      if (!camera || !controls) return null;
      const r = (v: number) => Math.round(v * 1000) / 1000;
      return {
        position: [r(camera.position.x), r(camera.position.y), r(camera.position.z)],
        target: [r(controls.target.x), r(controls.target.y), r(controls.target.z)],
      };
    },
    getViewer() {
      const r = (v: number) => Math.round(v * 100) / 100;
      const w = walkRef.current;
      if (w.on) {
        const heading = r(((w.yaw * 180 / Math.PI) % 360 + 360) % 360);
        return {
          x: r(w.pos[0]), y: r(w.pos[1]), floor_id: floorRef.current.id,
          focus: viewerFocus(stationsRef.current, w.pos, heading),
          eye_m: r(activeOffsetRef.current + w.groundSmooth + EYE_HEIGHT_M),
          heading_deg: heading,
          mode: "walk" as const,
        };
      }
      const camera = cameraRef.current, controls = controlsRef.current;
      if (!camera || !controls) return null;
      const dx = controls.target.x - camera.position.x;
      const dz = controls.target.z - camera.position.z;
      const flat = Math.hypot(dx, dz);
      // Senkrecht von oben gibt es keine sinnvolle Blickrichtung.
      const heading = flat < 0.5 ? null : r(((Math.atan2(dx, dz) * 180 / Math.PI) % 360 + 360) % 360);
      return {
        x: r(camera.position.x), y: r(camera.position.z), floor_id: floorRef.current.id,
        // Im Orbit zählt, worauf die Kamera zielt, nicht wo sie schwebt.
        focus: viewerFocus(stationsRef.current, [controls.target.x, controls.target.z], null, { near: 8 }),
        eye_m: r(camera.position.y),
        heading_deg: heading,
        mode: "orbit" as const,
      };
    },
    setCamera(cam: { position: number[]; target: number[] }) {
      const camera = cameraRef.current, controls = controlsRef.current;
      const ok = (a: number[]) => Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v));
      if (!camera || !controls || !ok(cam.position) || !ok(cam.target)) return;
      flyRef.current = {
        start: performance.now(), fromPos: camera.position.clone(),
        toPos: new THREE.Vector3(cam.position[0], cam.position[1], cam.position[2]),
        fromTarget: controls.target.clone(),
        toTarget: new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]), ms: 800,
      };
    },
    preset: (kind: "top" | "front" | "iso") => flyToPreset(kind),
    rotate: (deg: number) => rotateCamera(deg),
    zoom: (factor: number) => zoomCamera(factor),
    screenshot() {
      const renderer = rendererRef.current, scene = sceneRef.current, camera = cameraRef.current;
      if (!renderer || !scene || !camera) return Promise.resolve(null);
      // Unmittelbar vor dem Auslesen zeichnen: ohne preserveDrawingBuffer ist
      // der Puffer sonst schon geleert. Hintergrund + WebGL + Zeitstempel
      // auf eine Hilfsleinwand legen, damit kein transparentes PNG entsteht.
      renderer.render(scene, camera);
      const src = renderer.domElement;
      try {
        const out = document.createElement("canvas");
        out.width = src.width;
        out.height = src.height;
        const ctx = out.getContext("2d");
        if (ctx) {
          const dark = document.documentElement.dataset.theme === "dark";
          const grad = ctx.createLinearGradient(0, 0, 0, out.height);
          grad.addColorStop(0, dark ? "#18202a" : "#dbe7f3");
          grad.addColorStop(0.55, dark ? "#222b36" : "#eef3f8");
          grad.addColorStop(1, dark ? "#1c2127" : "#e5e8eb");
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, out.width, out.height);
          ctx.drawImage(src, 0, 0);
          const label = `Gimel Twin Studio · ${new Date().toLocaleString("de-DE")}`;
          const pad = Math.max(12, Math.round(out.width * 0.01));
          const fontSize = Math.max(12, Math.round(out.height * 0.018));
          ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = dark ? "rgba(28,33,39,0.82)" : "rgba(255,255,255,0.86)";
          ctx.fillRect(pad, out.height - fontSize - pad * 1.6, tw + pad * 1.4, fontSize + pad * 0.9);
          ctx.fillStyle = dark ? "#f6f7f9" : "#1c2127";
          ctx.fillText(label, pad * 1.7, out.height - pad * 1.0);
          return new Promise<Blob | null>((resolve) => out.toBlob((b) => resolve(b), "image/png"));
        }
      } catch {
        /* Rückfall auf direkte WebGL-Leinwand */
      }
      return new Promise<Blob | null>((resolve) => src.toBlob((b) => resolve(b), "image/png"));
    },
    floorPoint(clientX: number, clientY: number) {
      const renderer = rendererRef.current, camera = cameraRef.current;
      if (!renderer || !camera) return null;
      const r = renderer.domElement.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = new THREE.Vector3();
      return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -activeOffsetRef.current), hit)
        ? [hit.x, hit.z] as [number, number] : null;
    },
    clearMeasure() {
      measureRef.current.points = [];
      redrawMeasureRef.current();
    },
    tourStep(delta: number) {
      const tr = tourRef.current;
      if (!tr || !tr.stops.length) return;
      tr.index = ((tr.index + delta) % tr.stops.length + tr.stops.length) % tr.stops.length;
      tr.since = performance.now();
      flyToStopRef.current?.(tr.stops[tr.index], 1400);
      tourStopRef.current?.(tr.stops[tr.index]);
    },
    tourPause(paused: boolean) {
      const tr = tourRef.current;
      if (!tr) return;
      tr.paused = paused;
      // Weiter heißt: am aktuellen Halt die volle Zeit stehen, dann weiter.
      if (!paused) tr.since = performance.now();
    },
  } as ThreeHandle));

  const active = stations.filter((s) => s.active).length;

  if (noGl) {
    return (
      <div className="floor-card three-card">
        <div className="three-floor-nogl" style={height == null ? undefined : { height }} role="status">
          <p><Icon icon="cube" /> Dieser Browser kann kein 3D (WebGL) zeigen. Semi-3D und Plan funktionieren weiter.</p>
          {onFallback && <Button small icon="layers" text="Semi-3D öffnen" onClick={onFallback} />}
        </div>
      </div>
    );
  }

  return (
    <div className={`floor-card three-card${bare ? " three-bare" : ""}`}>
      {!bare && <div className="floor-toolbar iso-toolbar three-toolbar">
        <span className="floor-hint iso-hint">
          <span className="iso-badge"><Icon icon="cube" size={12} aria-hidden /> 3D</span>
          Ziehen dreht · Rad zoomt · Rechtsklick verschiebt · Doppelklick fokussiert
        </span>
        <div className="iso-tools">
          <ButtonGroup minimal className="iso-camera">
            <Button icon="undo" aria-label="Kamera nach links drehen" title="Kamera nach links drehen"
              onClick={() => rotateCamera(-45)} />
            <Button icon="redo" aria-label="Kamera nach rechts drehen" title="Kamera nach rechts drehen"
              onClick={() => rotateCamera(45)} />
            <Button icon="compass" aria-label="Kamera zurücksetzen" title="Kamera zurücksetzen"
              onClick={() => setCameraReset((n) => n + 1)} />
          </ButtonGroup>
          <span className="iso-yaw mono" ref={yawElRef} aria-hidden="true">00°</span>
          <ButtonGroup minimal className="three-presets">
            <Button icon="arrow-up" aria-label="Draufsicht" title="Draufsicht: senkrecht von oben"
              onClick={() => flyToPreset("top")} />
            <Button icon="media" aria-label="Frontansicht" title="Frontansicht: flach über den Boden"
              onClick={() => flyToPreset("front")} />
            <Button icon="cube" aria-label="Isometrische Ansicht" title="Isometrische Ansicht"
              onClick={() => flyToPreset("iso")} />
          </ButtonGroup>
          <ButtonGroup minimal>
            <Button icon="zoom-out" aria-label="Herauszoomen" title="Herauszoomen" onClick={() => zoomCamera(1 / 1.25)} />
            <Button icon="zoom-in" aria-label="Hineinzoomen" title="Hineinzoomen" onClick={() => zoomCamera(1.25)} />
            <Button icon="locate" aria-label="Auf Grundriss einpassen" title="Auf Grundriss einpassen"
              onClick={() => setCameraReset((n) => n + 1)} />
          </ButtonGroup>
        </div>
      </div>}
      <div className="floor-stage iso-stage three-stage" ref={mountRef}
        data-levels={levels.map((l) => `${l.label}@${l.offset.toFixed(1)}`).join(",")}
        data-active-offset={activeOffset.toFixed(1)}
        data-floor={floor.id}
        data-halls={neighborPlaces.map((p) => `${p.hall.id}/${p.hall.floor.id}@${p.x.toFixed(1)},${p.y.toFixed(1)},${p.hall.rotation_deg.toFixed(0)},${(activeOffset + p.hall.elevation_m).toFixed(1)}`).join(";")}
        data-full-view={fullView ? "1" : "0"}
        data-full-levels={fullLevelIds.join(",")}
        data-full-halls={fullHallIds.join(",")}
        style={height == null ? undefined : { height }}>
        {/* Himmel hinter dem durchsichtigen Canvas: Nacht oder Tag nach Theme. */}
        <TwinSky clouds={clouds} />
        <div className="iso-hud three-hud" aria-hidden="true">
          <span className="iso-hud-main"><Icon icon="layout" size={12} /> {floor.name || "Halle"}</span>
          <span>{(floor.area_m2 ?? 0).toLocaleString("de-DE")} m²</span>
          <span>{hallH.toLocaleString("de-DE", { maximumFractionDigits: 1 })} m hoch</span>
          <span>{active}/{stations.length} aktiv</span>
          {levels.length > 0 && <span>{levels.length + 1} Ebenen</span>}
          {netMetres > 0 && <span>{Math.round(netMetres).toLocaleString("de-DE")} m Gänge</span>}
          {flow.length > 0 && (
            <span className="iso-hud-flow">
              <span className="iso-swatch iso-swatch-supply" /> Material
              <span className="iso-swatch iso-swatch-ship" /> Versand
              <span className="iso-hud-count">{flow.length} Wege</span>
            </span>
          )}
          {vis.robots && drawableRobots.length > 0 && (
            <span className="iso-hud-flow">
              <span className="iso-swatch iso-swatch-robot" /> {drawableRobots.length} Roboter
              {drawableRobots.every((r) => r.simulated)
                ? <span className="iso-hud-count">Simulation</span>
                : drawableRobots.some((r) => r.simulated)
                  ? <span className="iso-hud-count">teils simuliert</span>
                  : null}
              {floorJobs.length > 0 && <span className="iso-hud-count">{floorJobs.length} Transporte</span>}
            </span>
          )}
          {hoverName && <span className="three-hover">{hoverName}</span>}
          {vis.collisions && (
            <span className="three-collision-hud" ref={collisionHudRef} data-collisions="0" />
          )}
        </div>
        <span className="sr-only" role="status" ref={collisionSrRef} />
        <div className="three-joy" ref={joyElRef} aria-hidden="true"><span ref={joyKnobRef} /></div>
        {walk && (
          <div className="three-walk" data-locked={walkLocked ? "1" : "0"}>
            {walkLocked && !liftMenu && <span className="three-cross" aria-hidden="true" />}
            {!walkLocked && !walkEdit && !liftMenu && !ride && (
              <div className="three-walk-lock" aria-hidden="true">Klicken: Maus übernehmen · Rechtsklick: Menü · H: alle Tasten</div>
            )}
            <div className="three-walk-level" aria-hidden="true">
              <Icon icon="layers" size={12} /> {placeLabel || floor.level_name || "Ebene"}
            </div>
            {onStationMove && !liftMenu && !ride && (
              <button type="button" className="three-walk-edit" data-on={walkEdit ? "1" : "0"}
                aria-pressed={walkEdit} aria-keyshortcuts="v" title="Stationen im Begehen verschieben (V)"
                onClick={toggleWalkEdit}>
                <Icon icon="move" size={12} /> Stationen verschieben <kbd>V</kbd>
              </button>
            )}
            {!liftMenu && !ride && (carryName ? (
              <div className="three-walk-edit-hint" role="status">
                „{carryName}“ greifen · loslassen legt ab · <kbd>R</kbd> dreht · <kbd>Esc</kbd> zurück
              </div>
            ) : walkEdit ? (
              <div className="three-walk-edit-hint" role="status">
                Station greifen und auf den Boden ziehen · <kbd>R</kbd> dreht · <kbd>Esc</kbd> legt zurück
                · rechts ziehen schaut um · <kbd>V</kbd> beendet
              </div>
            ) : null)}
            {walkPrompt && !liftMenu && !ride && (
              walkPromptKind === "lift" ? (
                <button type="button" className="three-walk-prompt" onClick={() => {
                  const near = nearestLink(linksRef.current, walkRef.current.pos);
                  if (near?.kind === "lift" && walkLevels.length > 1) walkApiRef.current.open(near);
                }}>{walkPrompt}</button>
              ) : (
                <span className="three-walk-prompt" role="note">{walkPrompt}</span>
              )
            )}
            {ctxMenu && !ride && (() => {
              const st = ctxMenu.station;
              const cmd = walkCmdRef.current;
              const run = (fn: () => void) => () => { setCtxMenu(null); fn(); };
              const pt = ctxMenu.point;
              // Im Bild halten: nach dem Zeichnen messen und, wenn nötig, nach
              // links/oben schieben (das Menü ist je nach Ziel verschieden hoch).
              const fit = (node: HTMLDivElement | null) => {
                const stageBox = mountRef.current?.getBoundingClientRect();
                if (!node || !stageBox) return;
                const w = node.offsetWidth, h = node.offsetHeight;
                node.style.left = `${Math.max(8, Math.min(ctxMenu.x, stageBox.width - w - 8))}px`;
                node.style.top = `${Math.max(8, Math.min(ctxMenu.y, stageBox.height - h - 8))}px`;
              };
              return (
                <div className="three-ctx" role="dialog" aria-label="Begehen: Menü" ref={fit}
                  style={{ left: ctxMenu.x, top: ctxMenu.y }}
                  onContextMenu={(e) => e.preventDefault()}>
                  <Menu>
                    {st && (
                      <>
                        <MenuDivider title={st.label} />
                        <MenuItem icon="eye-open" text="Öffnen" label="Q" onClick={run(() => cmd.open(st))} />
                        <MenuItem icon="walk" text="Hingehen" label="X" onClick={run(() => cmd.goToStation(st))} />
                        {onStationMove && (
                          <>
                            <MenuItem icon="move" text="Verschieben (Klick legt ab)"
                              onClick={run(() => walkActionsRef.current.carry(st, ctxMenu.x, ctxMenu.y))} />
                            <MenuItem icon="rotate-page" text="Drehen 15°" onClick={run(() => cmd.rotate(st, 15))} />
                            <MenuItem icon="rotate-document" text="Drehen −15°" onClick={run(() => cmd.rotate(st, -15))} />
                          </>
                        )}
                      </>
                    )}
                    {pt && !st && (
                      <>
                        <MenuItem icon="locate" text="Hierhin gehen" onClick={run(() => cmd.goTo(pt))} />
                        <MenuItem icon="person" text="Figur hierher setzen" onClick={run(() => cmd.place(pt))} />
                      </>
                    )}
                    <MenuDivider />
                    {onUndo && <MenuItem icon="undo" text="Rückgängig" label="Strg+Z" onClick={run(() => onUndo())} />}
                    {onRedo && <MenuItem icon="redo" text="Wiederholen" label="Strg+Y" onClick={run(() => onRedo())} />}
                    <MenuItem icon="arrow-up" text="Ebene hinauf" label="Bild↑" disabled={!cmd.canLevel("up")}
                      onClick={run(() => cmd.level("up"))} />
                    <MenuItem icon="arrow-down" text="Ebene hinunter" label="Bild↓" disabled={!cmd.canLevel("down")}
                      onClick={run(() => cmd.level("down"))} />
                    <MenuItem icon="home" text="Zurück zum Start" label="Pos1" onClick={run(() => cmd.home())} />
                    {onStationMove && (
                      <MenuItem icon="hand" text={walkEdit ? "Verschieben beenden" : "Stationen verschieben"} label="V"
                        onClick={run(() => toggleWalkEdit())} />
                    )}
                    <MenuItem icon="key-command" text="Tastenkürzel" label="H" onClick={run(() => setWalkHelp(true))} />
                    <MenuItem icon="log-out" text="Begehen beenden" label="Esc" onClick={run(() => walkChangeRef.current?.(false))} />
                  </Menu>
                </div>
              );
            })()}
            {walkHelp && (
              <div className="three-walk-help" role="dialog" aria-label="Tastenkürzel beim Begehen">
                <h3>Tastenkürzel beim Begehen</h3>
                <dl>
                  <dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / Pfeile</dt><dd>gehen, seitwärts</dd>
                  <dt><kbd>Shift</kbd></dt><dd>laufen</dd>
                  <dt>Maus / rechts ziehen</dt><dd>umsehen</dd>
                  <dt>Klick auf den Boden</dt><dd>dorthin gehen</dd>
                  <dt>Rechtsklick</dt><dd>Menü (Station oder Boden)</dd>
                  <dt><kbd>Q</kbd></dt><dd>Station im Blick öffnen</dd>
                  <dt><kbd>X</kbd></dt><dd>zur Station im Blick gehen</dd>
                  <dt><kbd>E</kbd></dt><dd>Aufzug: Ebene wählen</dd>
                  <dt><kbd>Bild↑</kbd> <kbd>Bild↓</kbd></dt><dd>eine Ebene hinauf / hinunter, an derselben Stelle</dd>
                  <dt><kbd>Pos1</kbd></dt><dd>zurück zum Start</dd>
                  {onStationMove && <><dt><kbd>V</kbd></dt><dd>Stationen verschieben</dd></>}
                  {onStationMove && <><dt>rechts ziehen auf Station</dt><dd>greifen, <kbd>R</kbd> dreht, loslassen legt ab</dd></>}
                  {onUndo && <><dt><kbd>Strg</kbd>+<kbd>Z</kbd> / <kbd>Strg</kbd>+<kbd>Y</kbd></dt><dd>rückgängig / wiederholen</dd></>}
                  <dt><kbd>Esc</kbd></dt><dd>Maus freigeben, zweimal: beenden</dd>
                  <dt><kbd>H</kbd></dt><dd>diese Übersicht</dd>
                </dl>
                <Button small text="Schließen" onClick={() => setWalkHelp(false)} />
              </div>
            )}
            {liftMenu && (() => {
              const choices = levelChoices(walkLevels);
              const here = walkLevels.find((l) => l.id === floor.id);
              return (
                <div className="three-lift" role="dialog" aria-label={`${liftMenu.link.kind === "lift" ? "Aufzug" : "Treppe"}: Ebene wählen`}>
                  <h3><Icon icon={liftMenu.link.kind === "lift" ? "double-chevron-up" : "chevron-up"} size={14} /> {liftMenu.link.name}</h3>
                  <ol>
                    {choices.map((c, i) => (
                      <li key={c.id}>
                        <button type="button" tabIndex={-1} data-active={i === liftMenu.idx ? "1" : "0"}
                          aria-current={c.id === floor.id ? "true" : undefined}
                          onClick={() => walkApiRef.current.choose(i)}>
                          <kbd>{i + 1}</kbd>
                          <span>{c.label}</span>
                          <small>{c.id === floor.id ? "hier" : `${c.elevation_m - (here?.elevation_m ?? 0) > 0 ? "+" : "−"}${Math.abs(c.elevation_m - (here?.elevation_m ?? 0)).toLocaleString("de-DE", { maximumFractionDigits: 1 })} m`}</small>
                        </button>
                      </li>
                    ))}
                  </ol>
                  <p>↑ ↓ wählen · Enter fährt · Ziffer springt · Esc schließt</p>
                </div>
              );
            })()}
            {ride && <div className="three-ride" data-phase={ride.phase} role="status"><b>{ride.text}</b></div>}
          </div>
        )}
        {/* Maßstab und Kompass gehören zur Kamera, nicht zur Halle: sie ändern
            sich beim Zoomen und Drehen mit. */}
        <div className="three-scale" aria-hidden="true">
          <span className="three-scale-bar" ref={scaleBarRef} />
          <span className="three-scale-text" ref={scaleTextRef}>10 m</span>
        </div>
        <div className="three-compass" aria-hidden="true">
          <span className="three-compass-ring">
            <span className="three-compass-needle" ref={compassRef} />
          </span>
          <b>N</b>
        </div>
        {(staged || (vis.robots && drawableRobots.some((r) => r.simulated))) && (
          // In jeder Breite sichtbar (die HUD-Leiste fehlt unter 720 px): was hier
          // dargestellt oder simuliert ist, steht immer im Bild.
          <span className="three-staged-chip" role="note">
            {[staged ? "Belebung dargestellt" : "", vis.robots && drawableRobots.some((r) => r.simulated) ? "Roboter simuliert" : ""]
              .filter(Boolean).join(" · ")}
          </span>
        )}
        {staged && (
          <span className="sr-only" role="status">
            Belebung eingeschaltet: Figuren, Stapler und wandernde Teile sind dargestellt, nicht gemessen.
          </span>
        )}
        {vis.robots && (drawableRobots.length > 0 || floorJobs.length > 0) && (
          <span className="sr-only" role="status">
            {drawableRobots.length} Roboter in der Halle, davon
            {" "}{drawableRobots.filter((r) => r.simulated).length} simuliert.
            {floorJobs.length > 0 && ` ${floorJobs.length} offene Transporte.`}
          </span>
        )}
        {map && (map.lat || map.lon) ? (<>
          <MapStyleSwitch value={mapStyle} onChange={setMapStyle} className="three-map-style" />
          <span className="three-map-attribution">{mapAttribution(mapStyle)}</span>
        </>) : null}
      </div>
    </div>
  );
}

/** Ober- und Unterkante des sichtbaren Ebenenstapels in Metern über dem Boden (EG). */
function stackExtent(levels: GhostLevel[], activeHeight: number, activeOffset = 0): { top: number; bottom: number } {
  // Eine einzelne Ebene behält die bisherige Einpassung (Oberkante 0 = Boden).
  let top = activeOffset + (levels.length ? Math.max(0, activeHeight) : 0);
  let bottom = activeOffset;
  for (const lv of levels) {
    top = Math.max(top, lv.offset + Math.max(0, Number(lv.floor.height_m) || 6));
    bottom = Math.min(bottom, lv.offset);
  }
  return { top, bottom };
}

let heatTex: THREE.CanvasTexture | null = null;
/** Weicher, runder Fleck: innen voll, nach außen durchsichtig. Einmal je Seite. */
function heatTexture(): THREE.CanvasTexture {
  if (heatTex) return heatTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  heatTex = new THREE.CanvasTexture(c);
  heatTex.colorSpace = THREE.SRGBColorSpace;
  return heatTex;
}

export default forwardRef<ThreeHandle, Props>(ThreeFloorPlan);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
