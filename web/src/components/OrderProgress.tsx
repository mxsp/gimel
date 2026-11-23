import { Tag, Tooltip } from "@blueprintjs/core";
import { fmtDateTime } from "../api";

/* Wo steht der Auftrag — als Leiste, nicht als Zahl.

   „Stufe 3" beantwortet die Frage nicht, die jemand tatsächlich hat: *ist er
   geschnitten, und wann ist er raus?* Deshalb zeigt diese Leiste alle Stufen,
   welche erledigt sind, wann sie es wurden, und welche gerade läuft. Die
   Stufennamen kommen vom Auftrag selbst — sie werden hier nicht erfunden. */

export interface Step {
  idx: number;
  name: string;
  at?: string | null;
  done: boolean;
}

export interface Progress {
  stage: number;
  blocked: boolean;
  held?: boolean;
  cancelled?: boolean;
  steps: Step[];
}

const FALLBACK = ["Eingegangen", "Freigegeben", "In Fertigung", "Versandbereit", "Versendet"];

export default function OrderProgress({ progress, compact = false }: {
  progress?: Progress | null; compact?: boolean;
}) {
  const stage = progress?.stage ?? 0;
  const steps: Step[] = progress?.steps?.length
    ? progress.steps
    : FALLBACK.map((name, idx) => ({ idx, name, done: idx <= stage, at: null }));
  const current = steps.find((s) => s.idx === stage);

  return (
    <div className={"order-progress" + (compact ? " order-progress-compact" : "") + (progress?.cancelled ? " order-progress-cancelled" : "")}>
      <div className="progress-track">
        {steps.map((s) => {
          const state = progress?.cancelled
            ? (s.done ? "done" : "todo")
            : progress?.blocked && s.idx === stage ? "blocked"
            : progress?.held && s.idx === stage ? "held"
            : s.idx < stage ? "done" : s.idx === stage ? "now" : "todo";
          return (
            <Tooltip key={s.idx} compact
              content={`${s.name}${s.at ? ` — ${fmtDateTime(s.at)}` : ""}`}>
              <div className={`progress-step progress-${state}`}>
                <span className="progress-dot" />
                {!compact && <span className="progress-name">{s.name}</span>}
              </div>
            </Tooltip>
          );
        })}
      </div>
      {!compact && (
        <div className="progress-caption">
          {progress?.cancelled
            ? <Tag intent="none" minimal icon="cross-circle">storniert</Tag>
            : progress?.blocked
            ? <Tag intent="danger" minimal icon="ban-circle">gesperrt bei „{current?.name ?? `Stufe ${stage}`}"</Tag>
            : progress?.held
            ? <Tag intent="warning" minimal icon="stop">angehalten bei „{current?.name ?? `Stufe ${stage}`}"</Tag>
            : <span className="sub">
                Stufe {stage + 1} von {steps.length}
                {current ? ` — ${current.name}` : ""}
                {current?.at ? ` seit ${fmtDateTime(current.at)}` : ""}
              </span>}
        </div>
      )}
    </div>
  );
}
