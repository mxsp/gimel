/* Spracheingabe für ein Eingabefeld (Lab-Chat, Portal-Dock, Twin Studio).
 *
 * Sprechen → nach kurzer Stille erkennt der Server (faster-whisper, auf diesem
 * Rechner) → der Text landet im Eingabefeld, wo er vor dem Senden geprüft und
 * geändert werden kann. Das Mikrofon wird danach wieder freigegeben.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { problemText } from "./gate";
import {
  LevelInfo, MicDevice, MicError, MicSession, Utterance, VoiceServerInfo, emptyResultProblem,
  listMics, micSupported, saveMicId, savedMicId, transcribeUtterance, voiceServerInfo,
} from "./mic";

export type InputPhase = "idle" | "opening" | "listening" | "transcribing";

export interface VoiceProblem { kind: string; text: string }

export interface VoiceInput {
  /** undefined = wird noch geprüft; null = dieser Server erkennt nicht selbst */
  server: VoiceServerInfo | null | undefined;
  available: boolean;
  phase: InputPhase;
  level: LevelInfo;
  heard: boolean;
  seconds: number;
  device: string;
  deviceId: string;
  devices: MicDevice[];
  problem: VoiceProblem | null;
  start: () => void;
  finish: () => void;
  cancel: () => void;
  setDevice: (id: string) => void;
  dismiss: () => void;
  /** Live: Mikrofon zwischen den Äußerungen offen lassen (nur nach einem Klick einschalten). */
  setKeepOpen: (keep: boolean) => void;
  /** Live: auf Hineinsprechen warten (Schwelle + `bias`); liefert eine Stopp-Funktion. */
  watch: (onSpeech: () => void, bias: () => number) => () => void;
}

const ZERO: LevelInfo = { meter: 0, threshold: 0, db: -Infinity };

export function describe(err: unknown): VoiceProblem {
  if (err instanceof MicError) return { kind: err.kind, text: problemText(err.kind, err.device, err.db) };
  if (err instanceof ApiError) {
    if (err.status === 404 || err.status === 503) {
      return { kind: "server-missing", text: problemText("server-missing") };
    }
    return { kind: "server", text: err.message };
  }
  return { kind: "other", text: String(err instanceof Error ? err.message : err) };
}

export function useVoiceInput(onText: (text: string) => void, language = "de"): VoiceInput {
  const [server, setServer] = useState<VoiceServerInfo | null | undefined>(undefined);
  const [phase, setPhase] = useState<InputPhase>("idle");
  const [level, setLevel] = useState<LevelInfo>(ZERO);
  const [heard, setHeard] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [device, setDeviceLabel] = useState("");
  const [deviceId, setDeviceId] = useState(savedMicId);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [problem, setProblem] = useState<VoiceProblem | null>(null);
  const textRef = useRef(onText);
  textRef.current = onText;
  const micRef = useRef<MicSession | null>(null);
  const uttRef = useRef<Utterance | null>(null);
  const runRef = useRef(0);
  const clockRef = useRef<number | null>(null);
  const keepRef = useRef(false);

  useEffect(() => {
    let alive = true;
    voiceServerInfo().then((info) => { if (alive) setServer(info && info.stt_available ? info : null); });
    return () => { alive = false; };
  }, []);

  const stopClock = () => {
    if (clockRef.current !== null) window.clearInterval(clockRef.current);
    clockRef.current = null;
  };

  const release = useCallback(() => {
    stopClock();
    micRef.current?.close();
    micRef.current = null;
    setLevel(ZERO);
  }, []);

  const start = useCallback(async () => {
    if (phase !== "idle") return;
    if (!micSupported()) { setProblem(describe(new MicError("unsupported"))); return; }
    const run = ++runRef.current;
    setProblem(null);
    setHeard(false);
    setSeconds(0);
    setPhase("opening");
    let mic: MicSession;
    if (micRef.current && !micRef.current.isClosed) {
      mic = micRef.current;
    } else {
      if (micRef.current) { micRef.current.close(); micRef.current = null; }
      try {
        mic = await MicSession.open(deviceId);
      } catch (err) {
        if (run === runRef.current) { setPhase("idle"); setProblem(describe(err)); }
        return;
      }
      if (run !== runRef.current) { mic.close(); return; }
    }
    micRef.current = mic;
    setDeviceLabel(mic.label);
    if (mic.deviceId && mic.deviceId !== deviceId) setDeviceId(mic.deviceId);
    listMics().then(setDevices).catch(() => setDevices([]));
    setPhase("listening");
    const began = performance.now();
    clockRef.current = window.setInterval(() => setSeconds((performance.now() - began) / 1000), 250);
    try {
      const utt = mic.listen({
        onLevel: setLevel,
        onSpeech: () => setHeard(true),
        maxMs: (server?.max_seconds ?? 60) * 1000,
      });
      uttRef.current = utt;
      const result = await utt.done;
      uttRef.current = null;
      if (keepRef.current) { stopClock(); setLevel(ZERO); } else release();
      if (run !== runRef.current) return;
      if (result.outcome === "stopped" && !result.heard) {
        setPhase("idle");
        setProblem(describe(new MicError("no-speech", mic.label, result.loudestDb)));
        return;
      }
      setPhase("transcribing");
      const out = await transcribeUtterance(result, language);
      if (run !== runRef.current) return;
      const text = out.text.trim();
      setPhase("idle");
      if (!text) {
        if (keepRef.current) { setProblem(null); return; }
        setProblem(describe(emptyResultProblem(result, out)));
        return;
      }
      textRef.current(text);
    } catch (err) {
      uttRef.current = null;
      const fatal = err instanceof MicError && ["dead", "muted", "ended", "busy"].includes(err.kind);
      if (keepRef.current && !fatal) { stopClock(); setLevel(ZERO); } else release();
      if (run !== runRef.current) return;
      setPhase("idle");
      if (err instanceof DOMException && err.name === "AbortError") return;
      setProblem(describe(err));
    }
  }, [deviceId, language, phase, release, server]);

  const finish = useCallback(() => { uttRef.current?.stop(); }, []);

  const cancel = useCallback(() => {
    runRef.current++;
    uttRef.current?.cancel();
    uttRef.current = null;
    release();
    setPhase("idle");
  }, [release]);

  const setDevice = useCallback((id: string) => {
    saveMicId(id);
    setDeviceId(id);
    setProblem(null);
    // Läuft gerade eine Aufnahme, mit dem neuen Gerät neu beginnen; ein offenes
    // Mikrofon wird geschlossen, damit die nächste Äußerung das neue nimmt.
    if (uttRef.current) {
      runRef.current++;
      uttRef.current.cancel();
      uttRef.current = null;
      setPhase("idle");
    }
    release();
  }, [release]);

  // Geräteliste füllen, sobald das Mikrofon schon einmal erlaubt wurde.
  useEffect(() => {
    listMics().then((list) => { if (list.some((d) => d.label && !/^Mikrofon \d+$/.test(d.label))) setDevices(list); })
      .catch(() => undefined);
    const onChange = () => { listMics().then(setDevices).catch(() => undefined); };
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
  }, []);

  useEffect(() => () => {
    runRef.current++;
    uttRef.current?.cancel();
    stopClock();
    micRef.current?.close();
  }, []);

  return {
    server,
    available: !!server && micSupported(),
    phase, level, heard, seconds, device, deviceId, devices, problem,
    start: () => { void start(); },
    finish, cancel, setDevice,
    dismiss: () => setProblem(null),
    setKeepOpen: (keep: boolean) => {
      keepRef.current = keep;
      if (!keep && !uttRef.current) release();
    },
    watch: (onSpeech: () => void, bias: () => number) => {
      const mic = micRef.current;
      return mic ? mic.watch(onSpeech, bias) : () => undefined;
    },
  };
}
