import type { Robot } from "../../factory";

/* Gemeinsame Begriffe der Roboter-Seite: Typen, Zustände, Fähigkeiten.

   Seit 2026-11-08 teilt die Seite die Flotte in zwei Arbeitsbereiche:
   „Fahrzeuge" (AGV, AMR, Flurförderzeug — sie fahren Wege im Gangnetz) und
   „Arme & Zellen" (Roboterarm, Cobot — sie stehen und greifen). */

export type TagIntent = "none" | "primary" | "success" | "warning" | "danger";

export const KINDS = [
  { value: "agv", label: "AGV — fahrerloser Transport", short: "AGV", hint: "Platten und Paletten auf festen Wegen" },
  { value: "amr", label: "AMR — mobiler Roboter", short: "AMR", hint: "Autonom mit eigener Umfelderkennung" },
  { value: "forklift", label: "Flurförderzeug", short: "Stapler", hint: "Paletten und schwere Lasten" },
  { value: "arm", label: "Roboterarm", short: "Arm", hint: "Stationär, greift und legt ab" },
  { value: "cobot", label: "Cobot", short: "Cobot", hint: "Arbeitet zusammen mit Menschen" },
];

export const CAPABILITIES = [
  { value: "transport", label: "Transport" },
  { value: "pallet", label: "Palette" },
  { value: "lift", label: "Hub" },
  { value: "arm", label: "Arm / Greifer" },
  { value: "pick", label: "Kommissionieren" },
  { value: "feed", label: "Material zuführen" },
  { value: "sort", label: "Sortieren" },
];

export const STATES = [
  { value: "idle", label: "wartet" },
  { value: "moving", label: "fährt" },
  { value: "charging", label: "lädt" },
  { value: "blocked", label: "blockiert" },
  { value: "error", label: "Störung" },
  { value: "offline", label: "offline" },
];

export const STATE_STYLE: Record<string, { label: string; intent: TagIntent }> = {
  idle: { label: "wartet", intent: "none" },
  moving: { label: "fährt", intent: "success" },
  charging: { label: "lädt", intent: "warning" },
  blocked: { label: "blockiert", intent: "warning" },
  error: { label: "Störung", intent: "danger" },
  offline: { label: "offline", intent: "none" },
};

/** Arme arbeiten stationär; im Fahrzeug-Bereich stehen sie nicht. */
export const isArm = (r: Pick<Robot, "kind">): boolean => /^(arm|cobot)$/i.test(r.kind || "");

export const kindShort = (kind: string): string => KINDS.find((k) => k.value === kind)?.short ?? kind;
export const kindLabel = (kind: string): string => KINDS.find((k) => k.value === kind)?.label ?? kind;
export const capLabel = (c: string): string => CAPABILITIES.find((x) => x.value === c)?.label ?? c;
export const stateOf = (r: Pick<Robot, "state" | "active">) =>
  !r.active ? { label: "inaktiv", intent: "none" as TagIntent } : (STATE_STYLE[r.state] ?? STATE_STYLE.idle);

/** Feste Linienfarben je Fahrzeug — in hell und dunkel lesbar, nicht die Statusfarben. */
const ROUTE_COLOURS = ["#4c90f0", "#d1980b", "#7961db", "#29a634", "#d13913", "#00a396", "#c22762", "#8eb125"];
export const routeColour = (id: number): string => ROUTE_COLOURS[Math.abs(id) % ROUTE_COLOURS.length];

/** Statusfarbe für Markierungen (Karte); dieselbe Folge wie im 3D-Grundriss. */
export function stateColour(state: string, active = true): string {
  if (!active) return "#738091";
  switch ((state || "").toLowerCase()) {
    case "moving": return "#2f9e6e";
    case "charging": return "#ca9c19";
    case "blocked":
    case "error": return "#cd4246";
    case "offline": return "#738091";
    default: return "#4c90f0";
  }
}

/** Zustand im Moment: der Fahrplan weiß, ob ein simuliertes Fahrzeug gerade
 *  fährt oder an einem Halt wartet; gemeldete Störungen und Laden gehen vor. */
export function liveState(r: Pick<Robot, "state" | "active">, moving: boolean): { label: string; intent: TagIntent } {
  if (!r.active) return { label: "inaktiv", intent: "none" };
  if (["charging", "blocked", "error", "offline"].includes(r.state)) return STATE_STYLE[r.state];
  if (moving) return STATE_STYLE.moving;
  return r.state === "moving" ? { label: "wartet auf Vorfahrt", intent: "none" } : STATE_STYLE.idle;
}
