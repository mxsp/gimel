import { NAV_GROUPS, NAV_HOME } from "../../nav";
import type { PagePart, StarterPrompt } from "@agentlab/pageContext";

/* Was jede Seite des Portals ohne eigenes Zutun meldet: Name der Ansicht, die offene
   Sache aus der Adresse (#/auftraege/AB-26-0005) und passende Startfragen. Seiten, die
   mehr wissen (der Zwilling mit Auswahl und Ebene), melden zusätzlich ihr eigenes Teil. */

const LABELS: Record<string, string> = Object.fromEntries(
  [NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items)].map((i) => [i.route, i.label]),
);
LABELS.grundriss = "Digitaler Grundriss";
LABELS.bereitstellen = "Kommissionierung";
LABELS.station = "Station";

const ENTITY_BY_ROOT: Record<string, string> = {
  auftraege: "order", produktion: "workorder", schachteln: "workorder", formen: "shape",
};

const STARTERS: Record<string, StarterPrompt[]> = {
  heute: [
    { icon: "flame", title: "Was ist dringend?", text: "Was ist heute dringend, und was blockiert die Fertigung?" },
    { icon: "lock", title: "Blockierte Aufträge", text: "Welche Aufträge sind blockiert, und was fehlt jeweils?" },
  ],
  auftraege: [
    { icon: "search-around", title: "Auftrag verfolgen", text: "Wo steht dieser Auftrag gerade in der Fertigung?" },
    { icon: "calendar", title: "Fällige Aufträge", text: "Welche Aufträge sind in den nächsten Tagen fällig?" },
  ],
  disposition: [
    { icon: "diagram-tree", title: "Was steht an?", text: "Was liegt im nächsten Sammellauf, und warum warten die anderen?" },
  ],
  produktion: [
    { icon: "diagram-tree", title: "Engpass", text: "Welche Station ist gerade der Engpass?" },
  ],
  roboter: [
    { icon: "drive-time", title: "Flotte", text: "Reicht die Roboterflotte für den Materialfluss?" },
  ],
  lager: [
    { icon: "layers", title: "Knapper Bestand", text: "Welche Werkstoffe haben knappen Bestand, und was kommt nach?" },
  ],
  versand: [
    { icon: "truck", title: "Versandbereit", text: "Was ist versandbereit und noch nicht im Versand?" },
  ],
};

function titleFor(route: string): string {
  const root = route.split("/")[0] || "heute";
  return LABELS[root] ?? root;
}

export function routeContext(route: string): PagePart {
  const [root, child] = route.split("/");
  const key = root || "heute";
  const part: PagePart = { title: titleFor(route) };
  const startKey = key === "grundriss" || key === "factory" ? "" : key;
  if (STARTERS[startKey]) part.suggestions = STARTERS[startKey];
  if (key === "grundriss" && child === "station" || key === "station") {
    const id = route.split("/").pop();
    if (id && /^\d+$/.test(id)) part.entity = { type: "station", id: Number(id) };
  } else if (ENTITY_BY_ROOT[key] && child && child !== "neu") {
    part.entity = { type: ENTITY_BY_ROOT[key], id: decodeURIComponent(child), label: decodeURIComponent(child) };
  }
  return part;
}
