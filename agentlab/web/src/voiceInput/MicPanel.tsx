/* Anzeige der Spracheingabe: Zustand, Pegel mit Schwelle, Gerät, Abbrechen/Fertig,
 * Fehlermeldung mit Ausweg. Eine Komponente für Voice/Live, Lab-Chat, Dock und Studio. */

import { useEffect, useId, useRef } from "react";
import type { LevelInfo, MicDevice } from "./mic";
import "./voiceInput.css";

export type PanelPhase = "idle" | "opening" | "listening" | "transcribing" | "thinking" | "speaking";

const PHASE_LABEL: Record<PanelPhase, string> = {
  idle: "Bereit",
  opening: "Mikrofon wird geöffnet …",
  listening: "Hört zu",
  transcribing: "Erkennt Sprache …",
  thinking: "Denkt nach …",
  speaking: "Spricht",
};

export function LevelMeter({ level, label = "Eingangspegel" }: { level: LevelInfo; label?: string }) {
  const pct = Math.round(level.meter * 100);
  const thr = Math.round(level.threshold * 100);
  const db = Number.isFinite(level.db) && level.db > -100 ? `${String(level.db).replace("-", "−")} dB` : "still";
  return (
    <div className="vi-meter-row">
      <div className="vi-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={pct} aria-valuetext={db}>
        <div className={`vi-meter-fill${level.meter > level.threshold ? " is-voice" : ""}`} style={{ width: `${pct}%` }} />
        {thr > 0 && <div className="vi-meter-thr" style={{ left: `${thr}%` }} title="Schwelle für Sprache" />}
      </div>
      <span className="vi-meter-db" aria-hidden="true">{db}</span>
    </div>
  );
}

export function DeviceSelect({ devices, deviceId, onChange, compact }: {
  devices: MicDevice[]; deviceId: string; onChange: (id: string) => void; compact?: boolean;
}) {
  const id = useId();
  if (devices.length === 0) return null;
  return (
    <label className={`vi-device${compact ? " is-compact" : ""}`} htmlFor={id}>
      <span>Mikrofon</span>
      <select id={id} value={devices.some((d) => d.id === deviceId) ? deviceId : ""}
        onChange={(e) => onChange(e.target.value)}>
        {!devices.some((d) => d.id === deviceId) && <option value="">Systemvorgabe</option>}
        {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
    </label>
  );
}

export interface MicPanelProps {
  phase: PanelPhase;
  level: LevelInfo;
  heard: boolean;
  seconds: number;
  device: string;
  deviceId: string;
  devices: MicDevice[];
  problem: { kind: string; text: string } | null;
  onFinish?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
  onDevice: (id: string) => void;
  onDismiss?: () => void;
  compact?: boolean;
}

/** Leiste über dem Eingabefeld, solange zugehört/erkannt wird oder ein Fehler steht. */
export default function MicPanel(p: MicPanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const active = p.phase === "listening" || p.phase === "opening" || p.phase === "transcribing";

  // Esc bricht ab, Enter beendet — nur solange der Fokus nicht in einem Feld liegt.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); p.onCancel?.(); return; }
      const el = e.target as HTMLElement | null;
      // Enter auf einem Knopf (z. B. „Abbrechen“) gehört dem Knopf, nie dem Senden.
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName))) return;
      if (e.key === "Enter" && p.phase === "listening") { e.preventDefault(); p.onFinish?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, p]);

  const said = active
    ? (p.phase === "listening" && p.heard ? "Sprache erkannt" : PHASE_LABEL[p.phase])
    : "";
  // Immer vorhanden, damit Zustandswechsel auch angesagt werden (aria-live erst beim Einhängen schweigt).
  const announcer = <span className="vi-sr" aria-live="polite">{said}</span>;
  if (!active && !p.problem) return announcer;
  const pickOther = p.problem && ["dead", "muted", "ended", "no-speech", "quiet", "not-found", "busy"].includes(p.problem.kind);

  return (
    <>
    {announcer}
    <div ref={ref} className={`vi-panel${p.compact ? " is-compact" : ""}`} data-phase={p.phase}>
      {active && (
        <>
          <div className="vi-row">
            <span className={`vi-dot${p.heard ? " is-heard" : ""}`} aria-hidden />
            <span className="vi-state">
              {p.phase === "listening" && p.heard ? "Sprache erkannt — weiter sprechen oder Fertig" : PHASE_LABEL[p.phase]}
            </span>
            {p.phase === "listening" && <span className="vi-time">{p.seconds.toFixed(0)} s</span>}
          </div>
          {p.phase === "listening" && <LevelMeter level={p.level} />}
          <div className="vi-row vi-actions">
            <span className="vi-dev-name" title={p.device}>{p.device}</span>
            <DeviceSelect devices={p.devices} deviceId={p.deviceId} onChange={p.onDevice} compact />
            <button type="button" className="vi-btn" onClick={p.onCancel}>Abbrechen</button>
            {p.phase === "listening" && (
              <button type="button" className="vi-btn is-primary" onClick={p.onFinish}>Fertig</button>
            )}
          </div>
        </>
      )}
      {!active && p.problem && (
        <div className="vi-problem" role="alert">
          <span>{p.problem.text}</span>
          <div className="vi-row vi-actions">
            {pickOther && <DeviceSelect devices={p.devices} deviceId={p.deviceId} onChange={p.onDevice} compact />}
            {p.onRetry && p.problem.kind !== "server-missing" && p.problem.kind !== "unsupported" && (
              <button type="button" className="vi-btn is-primary" onClick={p.onRetry}>Erneut versuchen</button>
            )}
            {p.onDismiss && <button type="button" className="vi-btn" onClick={p.onDismiss}>Schließen</button>}
          </div>
        </div>
      )}
    </div>
    </>
  );
}
