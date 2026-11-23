import { ProgressBar } from "@blueprintjs/core";
import { useEffect, useState } from "react";
import { BatchState } from "../batchRun";

/* Zeigt, dass ein Sammellauf rechnet — sichtbar auf jeder Seite mit einem
   Auslöser. Ohne Prozentzahl, weil der Server keine meldet; dafür die Zeit. */
export default function BatchRunBar({ run }: { run: BatchState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!run.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run.running]);
  if (!run.running) return null;
  const s = Math.max(0, Math.floor((now - (run.startedAt ?? now)) / 1000));
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return (
    <div className="batch-bar" role="status">
      <div className="batch-bar-text">
        <b>{run.selected ? "Eimer wird geschnitten" : run.force ? "Alles schneiden läuft" : "Sammellauf läuft"}</b>
        <span className="mono"> seit {clock} min</span>
        <span className="sub"> — größere Werke brauchen bis zu einer Minute. Die Seite kann offen bleiben; ein zweiter Lauf startet nicht.</span>
      </div>
      <ProgressBar intent="primary" stripes animate value={undefined} aria-label="Sammellauf läuft" />
    </div>
  );
}
