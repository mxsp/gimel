import { Button, ButtonGroup, Callout, Menu, MenuItem, Tag, Tooltip } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import { FactorList } from "./RankBars";
import {
  clockIn, fmtMin, fmtSlack, KIND_ICON, KIND_LABEL, priorityIntent,
  StationSchedule, TASK_STATE_LABEL, WorkSlot,
} from "../factory";
import { plural, days } from "../plural";
import { StatusChip } from "../ui";
import type { StatusItem } from "../ui";

/* Die Abarbeitungsliste einer Station — der Zettel, der an der Maschine hängt.

   Drei Dinge stehen in jeder Zeile, und sie sind die ganze Begründung dieser
   Ansicht:

   1. **Der Platz.** Eine Nummer, keine Sortierung, die man erraten muss.
   2. **Warum dieser Platz.** Der Satz kommt aus dem Rechenkern, nicht aus der
      Oberfläche — CLAUDE.md §5.5: eine Regel, deren Entscheidung man nicht
      nachlesen kann, wird beim ersten Zweifel abgeschaltet. Deshalb steht
      neben jeder Aufgabe, ob sie wegen ihres Termins vorn ist oder weil sie
      ohne Umrüsten läuft.
   3. **Wann sie fertig ist.** Als Uhrzeit, nicht als Minutenzahl: der Werker
      plant nach der Uhr an der Wand.

   Und was die Reihenfolge gekostet oder gespart hat, steht im Kopf — gemessen
   gegen die reine Terminreihenfolge, nicht behauptet. */

export interface QueueActions {
  onStart?: (s: WorkSlot) => void;
  onDone?: (s: WorkSlot) => void;
  onReset?: (s: WorkSlot) => void;
  onRelease?: (s: WorkSlot) => void;
  onMove?: (s: WorkSlot, dir: -1 | 1) => void;
  onOpen?: (s: WorkSlot) => void;
  onFiles?: (s: WorkSlot) => void;
  busyRef?: string | null;
}

/** Wie eine Station ihren Rüstzustand nennt. Ein Plotter spannt auf, ein
    Regal holt aus einem Gang — dasselbe Wort für beides liest sich falsch,
    und die Wörter sind das, was den Zettel benutzbar macht. */
const SETUP_NOUN: Record<string, { at: string; change: string }> = {
  production: { at: "zuletzt eingeplant", change: "Rüsten" },
  warehouse: { at: "zuletzt geholt", change: "anderer Gang" },
  shipping: { at: "zuletzt gepackt", change: "Wechsel" },
  accounting: { at: "zuletzt bearbeitet", change: "Wechsel" },
};

export default function WorkQueue({
  schedule, actions, showKind = false, stationType = "production",
  emptyText = "Nichts zu tun — die Station ist frei.", compact = false,
}: {
  schedule: StationSchedule;
  /** Einfach: je Zeile eine Hauptaktion, der Rest im „…"-Menü (Aufgabe 35 E). */
  compact?: boolean;
  actions?: QueueActions;
  showKind?: boolean;
  stationType?: string;
  emptyText?: string;
}) {
  const slots = schedule.slots ?? [];
  if (!slots.length) {
    return <Callout compact icon="tick-circle" intent="success">{emptyText}</Callout>;
  }
  return (
    <div className="queue">
      <QueueHead schedule={schedule} stationType={stationType} />
      <ShiftTimeline slots={slots} schedule={schedule} />
      <div className="queue-list">
        {slots.map((s, i) => (
          <QueueRow
            key={`${s.kind}:${s.ref}`}
            slot={s}
            showKind={showKind}
            stationType={stationType}
            first={i === 0}
            last={i === slots.length - 1}
            actions={actions}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
}

/** Visuelle Schicht-Sequenzleiste: zeigt jede geplante Aufgabe proportional
    zur Dauer, farblich nach Zustand (Läuft / Eil / Zusage reißt / Rüstwechsel). */
function ShiftTimeline({ slots, schedule }: { slots: WorkSlot[]; schedule: StationSchedule }) {
  if (!slots.length) return null;
  const durations = slots.map((s) => {
    if (s.finish_min != null && s.start_min != null && s.finish_min > s.start_min) {
      return s.finish_min - s.start_min;
    }
    return 15;
  });
  const total = durations.reduce((a, b) => a + b, 0) || 1;
  const cap = schedule.capacity_min_per_day ?? 0;
  const loadPct = cap > 0 && schedule.times_known ? Math.round((schedule.total_min / cap) * 100) : null;

  return (
    <div className="wq-timeline-wrap" aria-label="Schicht-Sequenz">
      <div className="wq-timeline-head">
        <span>Abarbeitungsfolge ({slots.length} {slots.length === 1 ? "Aufgabe" : "Aufgaben"})</span>
        <span>
          {schedule.times_known
            ? `${fmtMin(schedule.total_min)}${cap > 0 ? ` / ${fmtMin(cap)} Tageskapazität (${loadPct}%)` : ""}`
            : "Dauer geschätzt (keine Stationszeiten)"}
        </span>
      </div>
      <div className="wq-timeline-bar">
        {slots.map((s, idx) => {
          const dur = durations[idx];
          const cls = s.state === "running"
            ? "is-running"
            : s.late
              ? "is-late"
              : s.rush
                ? "is-rush"
                : s.changeover
                  ? "is-changeover"
                  : "";
          const tip = `#${s.seq} ${s.ref}${s.mat_name || s.mat ? ` · ${s.mat_name || s.mat}` : ""}${
            schedule.times_known ? ` · ${fmtMin(dur)}` : ""
          }${s.changeover ? " · Rüstwechsel" : ""}${s.late ? " · Zusage reißt!" : ""}`;
          return (
            <div key={`${s.kind}:${s.ref}`} style={{ flex: `${dur} 1 0%`, minWidth: 16, display: "flex" }}>
              <Tooltip content={tip} fill>
                <div className={`wq-tl-seg ${cls}`} style={{ width: "100%", height: "100%" }}>
                  {dur / total >= 0.1 ? `#${s.seq}` : ""}
                </div>
              </Tooltip>
            </div>
          );
        })}
      </div>
      <div className="wq-tl-legend">
        <span className="wq-tl-key"><span className="wq-tl-swatch" style={{ background: "var(--gimel-accent)" }} /> Läuft</span>
        <span className="wq-tl-key"><span className="wq-tl-swatch" style={{ background: "var(--g-data-bar)" }} /> Geplant</span>
        <span className="wq-tl-key"><span className="wq-tl-swatch" style={{ background: "var(--g-info)", boxShadow: "inset 3px 0 0 var(--g-warning)" }} /> Rüstwechsel</span>
        <span className="wq-tl-key"><span className="wq-tl-swatch" style={{ background: "var(--g-danger)" }} /> Eil / Termin kritisch</span>
      </div>
    </div>
  );
}

/** Der Kopf sagt, was die Reihenfolge wert war. Ohne diese Zahl ist das
    Umsortieren eine Behauptung. */
export function QueueHead({ schedule, stationType = "production" }: {
  schedule: StationSchedule; stationType?: string;
}) {
  const saved = schedule.changeovers_saved ?? 0;
  const noun = SETUP_NOUN[stationType] ?? SETUP_NOUN.production;
  // Über die Tageskapazität hinaus ist „fertig um …" eine Lüge — die Schicht
  // von morgen hat keine Uhrzeit, solange niemand Schichtzeiten hinterlegt
  // hat. Dann spricht die Liste von Tagewerk statt von Uhrzeiten.
  const multiDay = (schedule.days ?? 0) > 1;
  const clockTag = !schedule.times_known ? (
    <Tooltip content="Diese Station hat keine hinterlegten Zeiten — die Reihenfolge steht, die Uhrzeiten nicht.">
      <Tag minimal intent="warning" icon="help">ohne Zeiten</Tag>
    </Tooltip>
  ) : multiDay ? (
    <Tooltip content={`Heute passen ${fmtMin(schedule.capacity_min_per_day ?? 0)} Arbeit hinein — der Rest wandert auf die folgenden Tage.`}>
      <Tag minimal icon="time">
        heute {clockIn(schedule.capacity_min_per_day ?? 0)} · {fmtMin(schedule.total_min)} gesamt
      </Tag>
    </Tooltip>
  ) : (
    <Tag minimal icon="time">{fmtMin(schedule.total_min)} · fertig {clockIn(schedule.total_min)}</Tag>
  );
  return (
    <div className="wq-head">
      <div className="wq-head-tags">
        <Tag minimal icon="sort-numerical">{plural(schedule.slots.length, "Aufgabe", "Aufgaben")}</Tag>
        {clockTag}
        {schedule.days != null && (
          <Tag minimal intent={schedule.days > 1 ? "warning" : "none"}>
            {days(schedule.days)} Last
          </Tag>
        )}
        <Tag minimal icon="exchange" intent={saved > 0 ? "success" : "none"}>
          {schedule.changeovers}× {noun.change}
          {saved > 0 && ` — ${saved} gespart (${fmtMin(schedule.changeover_min_saved)})`}
        </Tag>
        {schedule.setup_mat && (
          <Tag minimal icon="layers">
            {noun.at}: {schedule.setup_name || schedule.setup_mat}
            {schedule.setup_thk ? ` · ${schedule.setup_thk.toLocaleString("de-DE")} mm` : ""}
          </Tag>
        )}
      </div>
      {schedule.late?.length > 0 && (
        <Tag intent="danger" icon="warning-sign">{schedule.late.length}× Zusage reißt</Tag>
      )}
    </div>
  );
}

function QueueRow({ slot, showKind, stationType, first, last, actions, compact = false }: {
  slot: WorkSlot; showKind: boolean; stationType: string;
  first: boolean; last: boolean; actions?: QueueActions; compact?: boolean;
}) {
  const p = slot.priority;
  const noun = SETUP_NOUN[stationType] ?? SETUP_NOUN.production;
  const state = TASK_STATE_LABEL[slot.state ?? "ready"] ?? { label: slot.state ?? "", intent: "none" as const };
  const busy = actions?.busyRef === `${slot.kind}:${slot.ref}`;
  const canOpenFiles = (slot.kind === "cut" || slot.kind === "pick") && !!actions?.onFiles;
  const setupTitle = stationType === "warehouse"
    ? "Anderer Werkstoff als zuletzt — der Weg führt in einen anderen Gang."
    : "Vor dieser Aufgabe muss umgerüstet werden.";

  // Eine Zeile trägt einen Zustand vorne; alles Weitere steht als „+N" daneben.
  const statusItems: StatusItem[] = [];
  if (slot.late) statusItems.push({ label: "Zusage reißt", tone: "danger", icon: "warning-sign" });
  if (p.overdue) statusItems.push({ label: "überfällig", tone: "danger", icon: "time" });
  if (slot.rush) statusItems.push({ label: "Eil", tone: "danger", icon: "flash" });
  if (slot.state && slot.state !== "ready") statusItems.push({ label: state.label, tone: state.intent });
  if (slot.changeover) statusItems.push({ label: noun.change, tone: "warning", icon: "exchange", title: setupTitle });
  if ((slot.day ?? 1) > 1) {
    statusItems.push({
      label: `Tag ${slot.day}`, icon: "calendar",
      title: "Die Tageskapazität dieser Station ist erschöpft — die Aufgabe fällt auf diesen Arbeitstag.",
    });
  }
  if (!slot.changeover && slot.mat) statusItems.push({ label: `kein ${noun.change}`, tone: "success", icon: "tick" });
  const primaryStatus = statusItems[0];
  const extraStatus = statusItems.slice(1);
  return (
    <div className={"queue-row"
      + (slot.late ? " queue-row-late" : "")
      + (slot.state === "running" ? " queue-row-running" : "")
      + (canOpenFiles ? " row-interactive" : "")}
      onClick={canOpenFiles ? () => actions?.onFiles?.(slot) : undefined}
      title={canOpenFiles ? "Dateien im Seitenrahmen rechts öffnen" : undefined}
      style={canOpenFiles ? { cursor: "pointer" } : undefined}>
      <div className="queue-seq">
        <span className="queue-seq-num">{slot.seq}</span>
        {slot.pinned && (
          <Tooltip content="Von Hand auf diesen Platz gesetzt — der nächste Lauf rechnet ihn nicht weg.">
            <span className="bp5-icon-standard bp5-icon-pin queue-pin" />
          </Tooltip>
        )}
      </div>

      <div className="queue-body">
        <div className="queue-title">
          {showKind && (
            <Tag minimal icon={KIND_ICON[slot.kind]}>{KIND_LABEL[slot.kind]}</Tag>
          )}
          <span className="queue-ref">{slot.ref}</span>
          <span className="queue-label">{slot.label}</span>
          <StatusChip primary={primaryStatus} extras={extraStatus} empty={null} />
        </div>

        <div className="queue-meta">
          {slot.mat && (
            <span className="wq-chip">
              {slot.mat_name || slot.mat}{slot.thk ? ` · ${slot.thk.toLocaleString("de-DE")} mm` : ""}
            </span>
          )}
          {slot.units > 0 && (
            <span className="wq-chip">
              {slot.kind === "cut" || slot.kind === "pick"
                ? plural(slot.units, "Platte", "Platten")
                : plural(slot.units, "Position", "Positionen")}
            </span>
          )}
          {slot.n_parts > 0 && <span className="wq-chip">{plural(slot.n_parts, "Teil", "Teile")}</span>}
          {slot.orders?.length > 0 && <span className="wq-chip mono">{slot.orders.join(", ")}</span>}
          {slot.started && slot.finish_min != null ? (
            <Tooltip content={`Angefangen — vom Rest gerechnet. Dauer gesamt war ${fmtMin((slot.finish_min ?? 0) - (slot.start_min ?? 0))}.`}>
              <span className="wq-chip wq-chip-clock">
                läuft · noch {fmtMin((slot.finish_min ?? 0) - (slot.start_min ?? 0))}
                {(slot.day ?? 1) === 1 && ` · fertig ${clockIn(slot.finish_min)}`}
              </span>
            </Tooltip>
          ) : (slot.day ?? 1) > 1 && slot.finish_min != null ? (
            <Tooltip content="Auf einen Folgetag gerechnet — eine Uhrzeit dafür zu nennen, hieße Schichtzeiten zu erfinden, die niemand hinterlegt hat.">
              <span className="wq-chip wq-chip-clock">Tag {slot.day} · {fmtMin(slot.finish_min)} Arbeit</span>
            </Tooltip>
          ) : slot.finish_min != null && (
            <Tooltip content={`Beginn ${clockIn(slot.start_min)} · Dauer ${fmtMin((slot.finish_min ?? 0) - (slot.start_min ?? 0))}`}>
              <span className="wq-chip wq-chip-clock">fertig {clockIn(slot.finish_min)}</span>
            </Tooltip>
          )}
          {slot.slack_min != null && (
            <span className={`wq-chip ${slot.late ? "wq-chip-late" : "wq-chip-slack"}`}>
              {slot.late ? `${fmtSlack(-slot.slack_min)} zu spät` : `${fmtSlack(slot.slack_min)} Luft`}
            </span>
          )}
        </div>

        <div className="queue-why">
          <span className="queue-why-seq">{slot.reason}</span>
        </div>

        <details className="queue-details">
          <summary>Priorität {p.score.toFixed(0)} — woraus</summary>
          {p.summary && <p className="sub" style={{ margin: "0 0 6px" }}>{p.summary}</p>}
          <FactorList factors={p.factors} />
          {slot.assign_reason && (
            <div className="rank-reason">Zuordnung: {slot.assign_reason}</div>
          )}
        </details>
      </div>

      <div className="queue-side" onClick={(e) => e.stopPropagation()}>
        <Tag minimal intent={priorityIntent(p)} className="queue-score">{p.score.toFixed(0)}</Tag>
        {actions && compact && <CompactActions slot={slot} first={first} last={last} actions={actions} busy={busy} />}
        {actions && !compact && (
          <ButtonGroup minimal>
            {actions.onFiles && (slot.kind === "cut" || slot.kind === "pick") && (
              <Button small minimal icon="document" title="Schnittdateien & Laufkarte im Seitenrahmen öffnen"
                      onClick={() => actions.onFiles?.(slot)} />
            )}
            {actions.onMove && (
              <>
                <Button small minimal icon="chevron-up" disabled={first} title="Nach oben"
                        onClick={() => actions.onMove?.(slot, -1)} />
                <Button small minimal icon="chevron-down" disabled={last} title="Nach unten"
                        onClick={() => actions.onMove?.(slot, 1)} />
              </>
            )}
            {actions.onStart && slot.state !== "running" && (
              <Button small minimal icon="play" title="Anfangen" loading={busy}
                      onClick={() => actions.onStart?.(slot)} />
            )}
            {actions.onDone && (
              <Button small minimal intent="success" icon="tick" title="Fertig melden" loading={busy}
                      onClick={() => actions.onDone?.(slot)} />
            )}
            {actions.onReset && slot.state === "running" && (
              <Button small minimal icon="undo" title="Zurücknehmen" loading={busy}
                      onClick={() => actions.onReset?.(slot)} />
            )}
            {actions.onRelease && (
              <Button small minimal icon="eject" title="Von dieser Station lösen" loading={busy}
                      onClick={() => actions.onRelease?.(slot)} />
            )}
            {actions.onOpen && (
              <Button small minimal icon="arrow-right" title="Öffnen"
                      onClick={() => actions.onOpen?.(slot)} />
            )}
          </ButtonGroup>
        )}
      </div>
    </div>
  );
}

/** Eine Hauptaktion (Anfangen, sonst Fertig melden) und der Rest im Menü. Dieselben Aufrufe wie die Knopfreihe. */
function CompactActions({ slot, first, last, actions, busy }: {
  slot: WorkSlot; first: boolean; last: boolean; actions: QueueActions; busy: boolean;
}) {
  const running = slot.state === "running";
  const main = !running && actions.onStart
    ? <Button small icon="play" text="Anfangen" loading={busy} onClick={() => actions.onStart?.(slot)} />
    : actions.onDone
      ? <Button small intent="success" icon="tick" text="Fertig" title="Fertig melden" loading={busy} onClick={() => actions.onDone?.(slot)} />
      : null;
  const files = actions.onFiles && (slot.kind === "cut" || slot.kind === "pick");
  return (
    <span className="queue-compact-actions">
      {main}
      <KeyPopover minimal placement="bottom-end" content={
        <Menu>
          {files && <MenuItem icon="document" text="Schnittdateien & Laufkarte" onClick={() => actions.onFiles?.(slot)} />}
          {actions.onMove && <MenuItem icon="chevron-up" text="Nach oben" disabled={first} onClick={() => actions.onMove?.(slot, -1)} />}
          {actions.onMove && <MenuItem icon="chevron-down" text="Nach unten" disabled={last} onClick={() => actions.onMove?.(slot, 1)} />}
          {running && actions.onDone && <MenuItem icon="tick" intent="success" text="Fertig melden" onClick={() => actions.onDone?.(slot)} />}
          {!running && actions.onDone && actions.onStart && <MenuItem icon="tick" text="Fertig melden" onClick={() => actions.onDone?.(slot)} />}
          {actions.onReset && running && <MenuItem icon="undo" text="Zurücknehmen" onClick={() => actions.onReset?.(slot)} />}
          {actions.onRelease && <MenuItem icon="eject" text="Von dieser Station lösen" onClick={() => actions.onRelease?.(slot)} />}
          {actions.onOpen && <MenuItem icon="arrow-right" text="Öffnen" onClick={() => actions.onOpen?.(slot)} />}
        </Menu>}>
        <Button small minimal icon="more" aria-label={`Weitere Aktionen für ${slot.ref}${slot.label ? ` (${slot.label})` : ""}`} title="Weitere Aktionen" />
      </KeyPopover>
    </span>
  );
}
