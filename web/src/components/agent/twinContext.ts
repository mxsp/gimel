import type { Robot, Station, TwinAnalysis, Floor } from "../../factory";
import { STEPS } from "../twin/marks";
import type { PagePart, StarterPrompt } from "@agentlab/pageContext";
import type { ViewerPose } from "../twin/ThreeFloorPlan";

/* Was der Zwilling zeigt — gemeinsam für das Portal (Digitaler Grundriss) und Twin Studio.
   Nur Namen und Zahlen, die auf dem Bildschirm stehen. Die Befunde nennen wir in Kurzform;
   den Satz dazu holt sich der Assistent selbst mit `analyse_twin`. */

export interface TwinViewState {
  where: "portal" | "studio";
  floor: Floor | null;
  floorLabel?: string;
  stations: Station[];
  selectedId: number | null;
  /** three | iso | 2d */
  mode: string;
  step: number;
  analysis?: TwinAnalysis | null;
  robots?: Robot[];
  layers?: Record<string, boolean>;
  /** Zusatzangaben der Seite (z. B. Studio: Begehen, Messen, Reiter). */
  extra?: Record<string, string | number | boolean | null>;
  /** Was außer der aktiven Ebene im Bild steht (3D): Ebenen dieser Halle,
      die aktive zuerst, und andere Hallen. */
  shownLevels?: string[];
  shownHalls?: string[];
  /** Begehen: man steht in Augenhöhe in der Halle. */
  walking?: boolean;
}

const MODE_WORD: Record<string, string> = { three: "3D", iso: "Semi-3D", "2d": "Plan (2D)" };

export function twinPart(s: TwinViewState): PagePart {
  const selected = s.selectedId != null ? s.stations.find((st) => st.id === s.selectedId) ?? null : null;
  const stepLabel = STEPS.find((x) => x.id === s.step)?.label ?? "Jetzt";
  const where = s.where === "studio" ? "Twin Studio" : "Digitaler Grundriss";
  const floorName = s.floorLabel || s.floor?.name || "";
  const part: PagePart = { title: floorName ? `${where} · ${floorName}` : where };
  if (selected && selected.id != null) {
    part.entity = { type: "station", id: selected.id, label: selected.label };
  }
  const view: Record<string, string | number | boolean | null> = {
    mode: MODE_WORD[s.mode] ?? s.mode,
    zeitschritt: stepLabel,
  };
  if (s.floor?.id) view.floor_id = s.floor.id;
  if (s.layers) {
    // „anzeige_an“, nicht „ebenen_an“: Ebenen heißen hier die Geschosse.
    const on = Object.entries(s.layers).filter(([, v]) => v).map(([k]) => k);
    view.anzeige_an = on.join(",");
  }
  const levels = s.shownLevels ?? [];
  const halls = s.shownHalls ?? [];
  if (levels.length > 1) view.ebenen_sichtbar = levels.join(", ");
  if (halls.length) view.hallen_sichtbar = halls.join(", ");
  if (s.walking) view.begehen = true;
  Object.assign(view, s.extra ?? {});
  part.view = view;

  const facts: string[] = [`${s.stations.length} Stationen auf dieser Ebene`];
  if (levels.length > 1 || halls.length) {
    const bits: string[] = [];
    if (levels.length > 1) bits.push(`Ebenen ${levels.join(", ")} übereinander (aktiv: ${levels[0]})`);
    if (halls.length) bits.push(`daneben ${halls.join(", ")}`);
    facts.push(`Im 3D-Bild: ${bits.join("; ")}. Auswahl und Zahlen gelten für die aktive Ebene`);
  }
  if (s.walking) facts.push("Begehen: der Nutzer steht in Augenhöhe in der Halle (Standpunkt und Blick in der Einstellung)");
  const sum = s.analysis?.summary;
  if (sum) facts.push(`Befunde: ${sum.danger} kritisch, ${sum.warning} Warnungen, ${sum.info} Hinweise`);
  const over = (s.analysis?.loads ?? []).filter((l) => l.state === "over").map((l) => l.label);
  if (over.length) facts.push(`Überbucht: ${over.slice(0, 5).join(", ")}`);
  if (s.robots) facts.push(`${s.robots.length} Roboter auf dieser Ebene`);
  if (s.step !== 0) facts.push(`Prognose (${stepLabel}) — Zahlen sind geschätzt`);
  part.facts = facts;

  const starters: StarterPrompt[] = [];
  if (s.walking) {
    starters.push({
      icon: "eye-open", title: "Was steht vor mir?",
      text: "Welche Station steht vor mir, wie ausgelastet ist sie und was wartet dort?",
    });
  }
  if (selected) {
    starters.push({
      icon: "cube", title: `${selected.label} prüfen`,
      text: `Wie ausgelastet ist „${selected.label}“, was liegt in der Warteschlange, und was fällt dort auf?`,
    });
  }
  if (levels.length > 1) {
    starters.push({
      icon: "layers", title: "Ebenen vergleichen",
      text: `Vergleiche die Ebenen ${levels.join(", ")}: Auslastung, Engpässe und Wege zwischen den Ebenen.`,
    });
  } else if (halls.length) {
    starters.push({
      icon: "office", title: "Hallen vergleichen",
      text: `Vergleiche diese Halle mit ${halls.join(", ")}: Auslastung, Engpässe, Wege dazwischen.`,
    });
  }
  starters.push(
    { icon: "diagram-tree", title: "Was fällt auf?", text: "Was fällt auf dieser Ebene auf? Nenne die drei wichtigsten Befunde und was sie kosten." },
    { icon: "drive-time", title: "Roboterflotte", text: "Reicht die Roboterflotte für den Materialfluss auf dieser Ebene?" },
    { icon: "help", title: "Was sehe ich hier?", text: "Erkläre mir kurz, was ich in dieser Ansicht sehe und worauf ich achten sollte." },
  );
  part.suggestions = starters.slice(0, 4);
  return part;
}

/** Standpunkt, Blick und was davor steht — gelesen erst beim Senden (``usePageProbe``).
    Portal und Studio melden dasselbe; die Werkzeuge lesen ``standpunkt_x/y`` und
    ``blick_richtung`` (``placement="in_front"``), ``vor_mir_id`` nennt die Station
    im Blick, ``naechste_station_id`` die nächste in Reichweite. */
export function viewerProbe(
  view: string, pose: ViewerPose | null | undefined,
): Record<string, string | number | boolean> {
  if (view !== "three" || !pose) return { ansicht: MODE_WORD[view] ?? view };
  const out: Record<string, string | number | boolean> = {
    ansicht: pose.mode === "walk" ? "begehen" : "kamera",
    standpunkt_x: pose.x,
    standpunkt_y: pose.y,
    standpunkt_ebene: pose.floor_id,
    blick_hoehe_m: pose.eye_m,
  };
  if (pose.heading_deg != null) out.blick_richtung = pose.heading_deg;
  const ahead = pose.focus?.ahead;
  if (ahead) {
    out.vor_mir = ahead.label;
    out.vor_mir_id = ahead.id;
    out.vor_mir_abstand_m = ahead.distance_m;
  }
  const near = pose.focus?.nearest;
  if (near) {
    // Im Orbit ist „nächste“ die Station, auf die die Kamera zielt.
    out.naechste_station = near.label;
    out.naechste_station_id = near.id;
    out.naechste_abstand_m = near.distance_m;
  }
  return out;
}
