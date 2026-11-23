import type { Door, Floor, Station } from "../../factory";
import {
  buildTwinWorld, CollisionWorld, pointInPolygon,
  type Collider, type Shape,
} from "./collision";
import { stairRailFootprints, verticalLinks } from "./walkLevels";

/* Begehen über Hallengrenzen (reine Rechnung, kein THREE, kein React).

   Andere Hallen eines Standorts stehen in der 3D-Ansicht an ihrer Kartenlage.
   Zum Begehen werden ihre Körper in die Achsen der aktiven Halle gedreht und
   verschoben; Türen sind Öffnungen in der Wand. Der Geher wechselt die aktive
   Halle, sobald er durch eine Tür in eine andere hineingeht — dieselbe Idee wie
   Treppe und Aufzug, nur waagerecht. */

const rad = (deg: number) => (deg * Math.PI) / 180;

export interface HallPlacement {
  /** Hallenkennung, nur zur Unterscheidung der Körper. */
  id: number;
  label: string;
  floor: Floor;
  stations: Station[];
  /** Ursprung der Halle in den Achsen der aktiven Halle. */
  x: number;
  y: number;
  /** Drehung relativ zur aktiven Halle. */
  rotation_deg: number;
  /** Höhe relativ zur aktiven Ebene. */
  elevation_m: number;
}

/** Punkt aus der Halle in die Achsen der aktiven Halle. */
export function placePoint(
  p: [number, number],
  h: Pick<HallPlacement, "x" | "y" | "rotation_deg">,
): [number, number] {
  const a = rad(h.rotation_deg), c = Math.cos(a), s = Math.sin(a);
  return [h.x + p[0] * c + p[1] * s, h.y + p[1] * c - p[0] * s];
}

/** Umkehrung von ``placePoint`` — für den Wechsel der aktiven Halle. */
export function unplacePoint(
  p: [number, number],
  h: Pick<HallPlacement, "x" | "y" | "rotation_deg">,
): [number, number] {
  const a = rad(h.rotation_deg), c = Math.cos(a), s = Math.sin(a);
  const dx = p[0] - h.x, dy = p[1] - h.y;
  return [dx * c - dy * s, dx * s + dy * c];
}

/** Blickrichtung aus der Halle in die Achsen der aktiven Halle. */
export function placeYaw(yaw: number, rotation_deg: number): number {
  return yaw - rad(rotation_deg);
}

/** Blickrichtung aus den Achsen der aktiven Halle in die Zielhalle. */
export function unplaceYaw(yaw: number, rotation_deg: number): number {
  return yaw + rad(rotation_deg);
}

/** Lage der aktiven Halle in den Achsen einer anderen — die Umkehrung von
    ``placePoint`` für den Rückweg durch dieselbe Tür. */
export function inversePlacement(
  h: Pick<HallPlacement, "x" | "y" | "rotation_deg">,
): { x: number; y: number; rotation_deg: number } {
  const a = rad(h.rotation_deg), c = Math.cos(a), s = Math.sin(a);
  return {
    x: -(c * h.x - s * h.y),
    y: -(s * h.x + c * h.y),
    rotation_deg: -h.rotation_deg,
  };
}

function placeShape(shape: Shape, h: HallPlacement): Shape {
  if (shape.kind === "polygon") {
    return { kind: "polygon", points: shape.points.map((p) => placePoint(p, h)) };
  }
  if (shape.kind === "segment") {
    return { kind: "segment", a: placePoint(shape.a, h), b: placePoint(shape.b, h), r: shape.r };
  }
  if (shape.kind === "circle") {
    const [x, y] = placePoint([shape.x, shape.y], h);
    return { kind: "circle", x, y, r: shape.r };
  }
  const [cx, cy] = placePoint([shape.cx, shape.cy], h);
  return { kind: "box", cx, cy, w: shape.w, h: shape.h, rotation: shape.rotation - h.rotation_deg };
}

/** Alle festen Körper der aktiven Halle und der sichtbaren Nachbarhallen in
    einem Weltmodell. Treppen und Aufzüge sind auch dort Körper; Türen sind
    Durchgänge. Hallen auf einer anderen Höhe bleiben draußen — man geht keine
    Wand hinauf. */
export function hallWalkWorld(halls: HallPlacement[]): CollisionWorld {
  const colliders: Collider[] = [];
  halls.forEach((h, i) => {
    const links = verticalLinks(h.floor, h.stations);
    const floor = links.length
      ? {
        ...h.floor,
        obstacles: [
          ...(h.floor.obstacles ?? []),
          // Treppen sind begehbar: nur ihre Geländer sind Körper. Der Aufzug
          // bleibt ein geschlossener Klotz.
          ...links.flatMap((l) => stairRailFootprints(l).map((points) => ({ name: l.name, points }))),
        ],
      }
      : h.floor;
    const world = buildTwinWorld(floor, h.stations, { openDoors: true });
    for (const c of world.colliders) {
      colliders.push({
        ...c,
        id: i === 0 ? c.id : `hall:${h.id}:${c.id}`,
        shape: i === 0 ? c.shape : placeShape(c.shape, h),
      });
    }
  });
  return new CollisionWorld(colliders);
}

/** Die Halle, in deren Umriss der Punkt liegt (die aktive ausgenommen). */
export function hallAt(
  halls: HallPlacement[], pos: [number, number], active = 0,
): HallPlacement | null {
  for (let i = 0; i < halls.length; i++) {
    if (i === active) continue;
    const outline = halls[i].floor.outline ?? [];
    if (outline.length < 3) continue;
    if (pointInPolygon(pos, outline.map((p) => placePoint(p, halls[i])))) return halls[i];
  }
  return null;
}

/** Die nächste Tür einer anderen Halle, die man durchqueren kann. */
export function nearestHallDoor(
  halls: HallPlacement[], pos: [number, number], maxDist = 2.7, active = 0,
): { hall: HallPlacement; door: Door } | null {
  let best: { hall: HallPlacement; door: Door } | null = null;
  let bestD = maxDist;
  for (let i = 0; i < halls.length; i++) {
    if (i === active) continue;
    for (const door of halls[i].floor.doors ?? []) {
      const [x, y] = placePoint([door.x, door.y], halls[i]);
      const d = Math.hypot(pos[0] - x, pos[1] - y);
      if (d <= bestD) { best = { hall: halls[i], door }; bestD = d; }
    }
  }
  return best;
}
