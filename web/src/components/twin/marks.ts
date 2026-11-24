import { FlowEdge, PoolRow, Station, WorklistData } from "../../factory";
import { plural } from "../../plural";
import { loadInfo } from "../../loadscale";

/* Was der Leitstand über eine Station sagen darf, und wie sicher.

   Gimel hat kein Maschinensignal: „läuft" heißt, jemand hat es gebucht. Alles
   aus Plan und Warteschlange ist eine Schätzung und trägt ≈, im Vorlesen
   „geschätzt". Eine 0 in einem Maschinenwert heißt unbekannt und wird ?, nie 0.
   Einen Störungszustand, OEE oder eine Maschinenauslastung gibt es hier nicht.

   Reine Funktionen ohne React: Seite und Tests rechnen dasselbe. */

export type StatusKind = "laeuft" | "wartet" | "frei" | "voll" | "ueber" | "unbekannt" | "inaktiv";
export type Certainty = "firm" | "estimated" | "unknown";
export type Lens = "last" | "ruesten" | "termine" | "fluss";
/** 0 = Jetzt; 1 bis 3 = so viele volle Tageskapazitäten sind abgearbeitet. */
export type TimeStep = 0 | 1 | 2 | 3;

export const LENSES: { id: Lens; label: string }[] = [
  { id: "last", label: "Last" }, { id: "ruesten", label: "Rüsten" },
  { id: "termine", label: "Termine" }, { id: "fluss", label: "Fluss" },
];

export const STEPS: { id: TimeStep; label: string }[] = [
  { id: 0, label: "Jetzt" }, { id: 1, label: "Nach 1 Arbeitstag" },
  { id: 2, label: "Nach 2 Arbeitstagen" }, { id: 3, label: "Nach 3 Arbeitstagen" },
];

export const STATUS_WORD: Record<StatusKind, string> = {
  laeuft: "läuft", wartet: "wartet", frei: "frei", voll: "wird voll",
  ueber: "überbucht", unbekannt: "unbekannt", inaktiv: "inaktiv",
};

export interface StationMark {
  kind: StatusKind;
  certainty: Certainty;
  /** Gemeldete Nummer. Bleibt die Aktualisierung aus, wird sie zurückgenommen. */
  running: string | null;
  /** Zustand in Worten, wie er zu sehen ist, mit ≈ und ?. */
  word: string;
  /** Dasselbe zum Vorlesen, mit „geschätzt" statt ≈. */
  spoken: string;
  /** Warteschlange zu Tageskapazität, null wenn unbekannt. */
  ratio: number | null;
  /** Zweite Zeile am Plan, abhängig von der Linse. */
  line: string;
  lineSpoken: string;
  rank: number;
}

export type ScheduleById = Record<number, WorklistData["stations"][number]["schedule"]>;

export function schedulesOf(worklist: WorklistData | null): ScheduleById {
  const out: ScheduleById = {};
  for (const w of worklist?.stations ?? []) out[w.id] = w.schedule;
  return out;
}

const URGENCY: Record<StatusKind, number> = { ueber: 60, voll: 50, unbekannt: 40, laeuft: 30, wartet: 20, frei: 10, inaktiv: 0 };

function rankOf(kind: StatusKind, ratio: number | null): number {
  return URGENCY[kind] + Math.min(9, (ratio ?? 0) * 3);
}

/** Stunden und Minuten, nie „Tag": 480 min sind hier 8 h, eine Schichtlänge kennt Gimel nicht. */
export function fmtHours(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0 min";
  if (v < 90) return `${Math.round(v)} min`;
  return `${(v / 60).toLocaleString("de-DE", { maximumFractionDigits: 1 })} h`;
}

/** Die Last in Worten, wie `loadInfo`, aber in Stunden. */
export function loadText(s: Station): string {
  const queue = s.queue_min ?? 0;
  const capacity = s.capacity_min_per_day || 0;
  const info = loadInfo({ queueMin: queue, capacityMin: capacity, tasks: s.queue_jobs ?? 0 });
  if (info.level === "free" || queue <= 0) return info.text;
  if (capacity <= 0) return `${fmtHours(queue)} · Kapazität unbekannt`;
  return `${fmtHours(queue)} von ${fmtHours(capacity)} · ${Math.round((info.ratio ?? 0) * 100)} %`;
}

/** Offene Arbeit, deren Umfang niemand nennen kann: keine Kapazität oder keine Dauer. */
function workUnknown(s: Station): boolean {
  const queue = s.queue_min ?? 0;
  const tasks = s.queue_jobs ?? 0;
  const hasWork = queue > 0 || tasks > 0;
  return hasWork && (!(s.capacity_min_per_day > 0) || (tasks > 0 && queue <= 0));
}

/** Was bleibt, wenn `step` volle Tageskapazitäten ab jetzt abgearbeitet sind. */
function restAfter(s: Station, step: TimeStep): number {
  return Math.max(0, (s.queue_min ?? 0) - step * (s.capacity_min_per_day || 0));
}

function baseMark(partial: Pick<StationMark, "kind" | "certainty" | "running" | "word" | "spoken" | "ratio">): StationMark {
  return { ...partial, line: partial.word, lineSpoken: partial.spoken, rank: rankOf(partial.kind, partial.ratio) };
}

/** Der Stand jetzt. `stale`: die gebuchte Nummer ist nicht mehr belegt und wird zurückgenommen. */
export function markNow(s: Station, schedule: ScheduleById[number] | undefined, stale: boolean): StationMark {
  if (!s.active) return baseMark({ kind: "inaktiv", certainty: "firm", running: null, word: "inaktiv", spoken: "inaktiv", ratio: null });
  const queue = s.queue_min ?? 0;
  const tasks = s.queue_jobs ?? 0;
  const capacity = s.capacity_min_per_day || 0;
  const info = loadInfo({ queueMin: queue, capacityMin: capacity, tasks });
  const text = loadText(s);
  const running = stale ? null : schedule?.slots.find((x) => x.started)?.ref ?? null;
  const also = running ? { word: ` · läuft ${running}`, spoken: `, läuft ${running}, gebucht` } : { word: "", spoken: "" };

  if (info.level === "unknown") {
    const word = queue <= 0 ? "Dauer unbekannt" : "Kapazität unbekannt";
    return baseMark({ kind: "unbekannt", certainty: "unknown", running, ratio: null,
      word: word + also.word, spoken: `${queue > 0 ? "geschätzt " : ""}${text}${also.spoken}` });
  }
  if (info.level === "over" || info.level === "high") {
    const kind = info.level === "over" ? "ueber" : "voll";
    const pct = `${Math.round((info.ratio ?? 0) * 100)} %`;
    return baseMark({ kind, certainty: "estimated", running, ratio: info.ratio,
      word: `${STATUS_WORD[kind]} · ≈${pct}${also.word}`,
      spoken: `${STATUS_WORD[kind]}, geschätzt ${text}${also.spoken}` });
  }
  if (running) {
    return baseMark({ kind: "laeuft", certainty: "firm", running, ratio: info.ratio,
      word: `läuft ${running}`, spoken: `läuft ${running}, gebucht, geschätzt ${text}` });
  }
  if (info.level === "free") return baseMark({ kind: "frei", certainty: "firm", running: null, word: "frei", spoken: "frei", ratio: 0 });
  return baseMark({ kind: "wartet", certainty: "estimated", running: null, ratio: info.ratio,
    word: `wartet · ≈${fmtHours(queue)}`, spoken: `wartet, geschätzt ${text}` });
}

/** Eine einfache Rechnung: volle Tageskapazität ab jetzt, keine neuen Aufträge, niemand
    hat etwas gemeldet. Eine Schichtlänge und Arbeitstage kommen erst mit Schritt C.
    Offene Arbeit ohne Kapazität oder Dauer bleibt auf jedem Schritt unbekannt. */
export function markForecast(s: Station, step: TimeStep): StationMark {
  if (!s.active) return markNow(s, undefined, true);
  if (workUnknown(s)) {
    const word = (s.queue_min ?? 0) <= 0 ? "Dauer unbekannt" : "Kapazität unbekannt";
    return baseMark({ kind: "unbekannt", certainty: "unknown", running: null, ratio: null, word, spoken: word });
  }
  const rest = restAfter(s, step);
  if (rest <= 0) return baseMark({ kind: "frei", certainty: "estimated", running: null, ratio: 0, word: "≈frei", spoken: "geschätzt frei" });
  const ratio = rest / s.capacity_min_per_day;
  const kind: StatusKind = ratio > 1 ? "ueber" : ratio >= 0.85 ? "voll" : "wartet";
  return baseMark({ kind, certainty: "estimated", running: null, ratio,
    word: `${STATUS_WORD[kind]} · ≈${fmtHours(rest)}`, spoken: `${STATUS_WORD[kind]}, geschätzt ${fmtHours(rest)}` });
}

/** Offene Vorschläge an einer Station: geschätzt, denn zugeordnet ist noch nichts. */
function withSuggestions(mark: StationMark, n: number): StationMark {
  if (!n || mark.kind === "inaktiv") return mark;
  const text = plural(n, "Vorschlag", "Vorschläge");
  const word = `${mark.word} · ${text}`;
  const spoken = `${mark.spoken}, geschätzt ${text}`;
  return { ...mark, word, spoken, line: word, lineSpoken: spoken,
    certainty: mark.certainty === "firm" && mark.kind === "frei" ? "estimated" : mark.certainty };
}

/** Vorschläge je Station aus dem freien Vorrat. */
export function suggestionsBy(worklist: WorklistData | null): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of machineWork(worklist)) {
    if (r.suggest_station_id != null) out[r.suggest_station_id] = (out[r.suggest_station_id] ?? 0) + 1;
  }
  return out;
}

function fmtThk(v: number | undefined): string {
  return v ? ` ${v.toLocaleString("de-DE", { maximumFractionDigits: 2 })} mm` : "";
}

/** Die Zeile am Plan: eine Linse wählt, welche Frage die Station beantwortet. */
function withLens(mark: StationMark, lens: Lens, s: Station, schedule: ScheduleById[number] | undefined,
  flow: FlowEdge[], step: TimeStep): StationMark {
  if (lens === "last" || mark.kind === "inaktiv") return mark;
  const allSlots = schedule?.slots ?? [];
  const timesUnknown = schedule?.times_known === false;
  // Bei unbekannter Kapazität/Dauer stehen alle Aufgaben auf Tag 1; ab +1 Tag
  // behalten wir sie, statt fälschlich „keine Termine“ zu melden.
  const slots = timesUnknown ? allSlots : allSlots.filter((x) => (x.day ?? 1) > step);
  if (lens === "ruesten") {
    const changes = slots.filter((x) => x.changeover).length;
    const change = changes ? { line: ` · ≈${changes} Wechsel`, spoken: `, geschätzt ${plural(changes, "Wechsel", "Wechsel")}` } : { line: "", spoken: "" };
    if (!s.last_mat) return { ...mark, line: `Rüststand ?${change.line}`, lineSpoken: `Rüststand unbekannt${change.spoken}` };
    const mat = `${s.last_mat}${fmtThk(s.last_thk)}`;
    return { ...mark, line: `zuletzt ${mat}${change.line}`, lineSpoken: `zuletzt eingeplant ${mat}${change.spoken}` };
  }
  if (lens === "termine") {
    if (timesUnknown && allSlots.length) return { ...mark, line: "Terminlage ?", lineSpoken: "Terminlage unbekannt" };
    const earlierLate = allSlots.filter((x) => (x.day ?? 1) <= step && x.late).length;
    if (!slots.length) {
      return earlierLate
        ? { ...mark, line: `≈${earlierLate} bereits spät`, lineSpoken: `geschätzt ${earlierLate} bereits spät` }
        : { ...mark, line: "keine Termine", lineSpoken: "keine Termine" };
    }
    const late = slots.filter((x) => x.late).length + earlierLate;
    return late
      ? { ...mark, line: `≈${late} spät`, lineSpoken: `geschätzt ${late} spät` }
      : { ...mark, line: "≈im Termin", lineSpoken: "geschätzt im Termin" };
  }
  const edges = flow.filter((e) => e.from === s.id || e.to === s.id);
  if (!edges.length) return { ...mark, line: "kein Weg", lineSpoken: "kein Weg" };
  const count = edges.reduce((a, e) => a + e.count, 0);
  return { ...mark, line: `≈${count}× Weg`, lineSpoken: `geschätzt ${count} Wege` };
}

export function buildMarks({ stations, schedules, suggestions, step, lens, flow, stale }: {
  stations: Station[]; schedules: ScheduleById; suggestions: Record<number, number>;
  step: TimeStep; lens: Lens; flow: FlowEdge[]; stale: boolean;
}): Record<number, StationMark> {
  const out: Record<number, StationMark> = {};
  for (const s of stations) {
    if (s.id == null) continue;
    const schedule = schedules[s.id];
    const mark = step === 0 ? markNow(s, schedule, stale) : markForecast(s, step);
    out[s.id] = withLens(withSuggestions(mark, suggestions[s.id] ?? 0), lens, s, schedule, flow, step);
  }
  return out;
}

/** Offene Maschinenminuten je Schritt; Stationen ohne Angabe zählen für sich und gehen nie als 0 ein. */
export function openAtStep(stations: Station[], step: TimeStep): { minutes: number; unknown: number } {
  let minutes = 0;
  let unknown = 0;
  for (const s of stations) {
    if (!s.active || s.id == null) continue;
    if (workUnknown(s)) unknown += 1; else minutes += restAfter(s, step);
  }
  return { minutes, unknown };
}

/** Die Zeile im Zeitband, sichtbar und zum Vorlesen. */
/** Was noch auf eine Maschine wartet. Packen und Kommissionieren liegen auch im Vorrat, brauchen aber keine. */
export function machineWork(worklist: WorklistData | null): PoolRow[] {
  return (worklist?.pool ?? []).filter((r) => r.kind === "cut");
}

export function bandText({ minutes, unknown }: { minutes: number; unknown: number }, pool: number): { text: string; spoken: string } {
  const noMachine = pool ? `${pool.toLocaleString("de-DE")} ohne Maschine` : "";
  const noData = plural(unknown, "Station", "Stationen");
  if (minutes > 0) {
    const tail = [noMachine, unknown ? `${noData} ohne Angabe` : ""].filter(Boolean);
    return { text: [`≈${fmtHours(minutes)} Maschinenzeit`, ...tail].join(" · "),
      spoken: [`geschätzt ${fmtHours(minutes)} Maschinenzeit`, ...tail].join(", ") };
  }
  if (unknown) {
    const parts = ["Umfang unbekannt", noData, noMachine].filter(Boolean);
    return { text: parts.join(" · "), spoken: parts.join(", ") };
  }
  if (pool) return { text: noMachine, spoken: noMachine };
  return { text: "voraussichtlich nichts offen", spoken: "voraussichtlich nichts offen" };
}

/** Der Satz über die Maschinen: wie viel, auf wie vielen, und die vollste. */
export function machineSummary(stations: Station[]): { text: string; spoken: string } {
  const machines = stations.filter((s) => s.type === "production" && s.active);
  const queued = machines.reduce((a, s) => a + (s.queue_min || 0), 0);
  const busy = machines.filter((s) => (s.queue_min || 0) > 0).length;
  const silent = machines.some((s) => (s.queue_jobs ?? 0) > 0 && (s.queue_min || 0) <= 0);
  const known = machines.filter((s) => s.capacity_min_per_day > 0);
  const fullest = known.length ? Math.max(...known.map((s) => (s.queue_min || 0) / s.capacity_min_per_day)) : null;
  if (queued <= 0) {
    const word = silent ? "Dauer unbekannt" : "nichts eingeplant";
    return { text: word, spoken: word };
  }
  const span = `${fmtHours(queued)} auf ${busy} von ${machines.length} Maschinen`;
  const pct = fullest != null ? `${Math.round(fullest * 100)} % der Tageskapazität` : null;
  const also = silent ? " · Dauer teils unbekannt" : "";
  return { text: `≈${span}${pct ? ` · vollste ≈${pct}` : ""}${also}`,
    spoken: `geschätzt ${span}${pct ? `, vollste geschätzt ${pct}` : ""}${also ? ", Dauer teils unbekannt" : ""}` };
}

export function byUrgency(stations: Station[], marks: Record<number, StationMark>): Station[] {
  const rank = (s: Station) => (s.id != null ? marks[s.id]?.rank ?? -1 : -1);
  return [...stations].sort((a, b) => rank(b) - rank(a) || a.label.localeCompare(b.label, "de"));
}
