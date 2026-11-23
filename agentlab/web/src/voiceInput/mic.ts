/* Mikrofon für Gimel: ein Strom je Gespräch, Gerätewahl, Äußerungen (task 43).
 *
 * Gemeinsam für Gimel Voice/Live, den Lab-Chat, das Portal-Dock und Twin Studio.
 *  - Das Mikrofon bleibt offen, solange das Gespräch läuft (Freigabe mit
 *    `close()`): Die automatische Verstärkung muss nicht bei jeder Äußerung
 *    neu anlaufen, und das Grundrauschen bleibt bekannt.
 *  - Das Gerät ist wählbar und wird gemerkt; ohne Wahl nimmt der Browser die
 *    Systemvorgabe — auf diesem Rechner ein Eingang ohne Mikrofon (2026-11-08).
 *  - Jede Äußerung wird ganz aufgenommen und an den Server geschickt, sobald
 *    das Tor (gate.ts) Sprache oder wenigstens Signal über dem Rauschen sah.
 */

import { api, ApiError } from "../api";
import {
  GateEvent, GateOptions, MicProblem, SpeechGate, meterValue, peakOf, problemFromError, rmsOf,
} from "./gate";

const DEVICE_KEY = "gimel-mic-device";
const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];

export class MicError extends Error {
  readonly kind: MicProblem;
  readonly device: string;
  readonly db?: number;
  constructor(kind: MicProblem, device = "", db?: number) {
    super(kind);
    this.kind = kind;
    this.device = device;
    this.db = db;
  }
}

export interface MicDevice { id: string; label: string }

export function micSupported(): boolean {
  return typeof navigator !== "undefined"
    && !!navigator.mediaDevices?.getUserMedia
    && typeof window !== "undefined"
    && typeof window.MediaRecorder !== "undefined";
}

export function savedMicId(): string {
  try { return localStorage.getItem(DEVICE_KEY) || ""; } catch { return ""; }
}

export function saveMicId(id: string): void {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch { /* ohne Speicher */ }
}

/** Eingänge; Namen gibt es erst, wenn das Mikrofon einmal erlaubt wurde. */
export async function listMics(): Promise<MicDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Mikrofon ${i + 1}` }));
}

function pickType(): string {
  for (const t of TYPES) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* älterer Browser */ }
  }
  return "";
}

function audioCtor(): typeof AudioContext {
  return window.AudioContext
    ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
}

export interface LevelInfo {
  /** 0…1 für die Anzeige */
  meter: number;
  /** wo die Schwelle auf derselben Skala liegt */
  threshold: number;
  /** aktueller Pegel in dBFS (gerundet) */
  db: number;
}

export interface UtteranceResult {
  blob: Blob;
  type: string;
  outcome: GateEvent | "stopped";
  heard: boolean;
  loudestDb: number;
  quiet: boolean;
  seconds: number;
}

export interface ListenOptions extends GateOptions {
  onLevel?: (level: LevelInfo) => void;
  /** Sprache hat begonnen (für die Anzeige). */
  onSpeech?: () => void;
}

/** Eine laufende Äußerung. */
export class Utterance {
  readonly done: Promise<UtteranceResult>;
  private finishFn: (how: "stop" | "cancel") => void = () => {};
  stop(): void { this.finishFn("stop"); }
  cancel(): void { this.finishFn("cancel"); }

  constructor(mic: MicSession, opts: ListenOptions) {
    this.done = new Promise<UtteranceResult>((resolve, reject) => {
      const type = pickType();
      let recorder: MediaRecorder;
      try {
        recorder = type ? new MediaRecorder(mic.stream, { mimeType: type }) : new MediaRecorder(mic.stream);
      } catch {
        reject(new MicError("unsupported", mic.label));
        return;
      }
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const gate = new SpeechGate(opts);
      const started = performance.now();
      let outcome: GateEvent | "stopped" = "none";
      let cancelled = false;
      let failure: MicError | null = null;
      let done = false;

      const cleanup = () => {
        window.clearInterval(timer);
        mic.offProblem(onProblem);
        opts.onLevel?.({ meter: 0, threshold: meterValue(gate.state.threshold), db: -Infinity });
      };
      const finish = (how: "stop" | "cancel" | "gate", err?: MicError) => {
        if (done) return;
        done = true;
        cancelled = how === "cancel";
        failure = err ?? null;
        if (how === "stop") outcome = gate.state.heard ? "end" : gate.state.anySignal ? "maybe" : "stopped";
        if (recorder.state !== "inactive") recorder.stop();
        else settle();
      };
      const settle = () => {
        cleanup();
        if (cancelled) { reject(new DOMException("abgebrochen", "AbortError")); return; }
        if (failure) { reject(failure); return; }
        const blobType = (recorder.mimeType || type || "audio/webm").split(";")[0];
        resolve({
          blob: new Blob(chunks, { type: blobType }),
          type: blobType,
          outcome,
          heard: gate.state.heard,
          loudestDb: gate.loudestDb(),
          quiet: gate.quiet(),
          seconds: (performance.now() - started) / 1000,
        });
      };
      recorder.onstop = settle;
      recorder.onerror = () => { failure = new MicError("busy", mic.label); settle(); };
      const onProblem = (kind: MicProblem) => finish("gate", new MicError(kind, mic.label));
      mic.onProblem(onProblem);
      this.finishFn = (how) => finish(how);

      const timer = window.setInterval(() => {
        const { rms, peak } = mic.sample();
        const t = performance.now() - started;
        const ev = gate.push({ rms, peak, t });
        opts.onLevel?.({
          meter: meterValue(rms),
          threshold: meterValue(gate.state.threshold),
          db: Math.round(20 * Math.log10(Math.max(rms, 1e-7))),
        });
        if (ev === "speech") opts.onSpeech?.();
        else if (ev === "dead") finish("gate", new MicError("dead", mic.label));
        else if (ev === "no-speech") finish("gate", new MicError("no-speech", mic.label, gate.loudestDb()));
        else if (ev === "end" || ev === "max" || ev === "maybe") { outcome = ev; finish("gate"); }
      }, 50);

      recorder.start(250);
    });
  }
}

/** Offenes Mikrofon für ein Gespräch. */
export class MicSession {
  readonly stream: MediaStream;
  readonly label: string;
  readonly deviceId: string;
  private readonly ctx: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private problems = new Set<(kind: MicProblem) => void>();
  private closed = false;

  private constructor(stream: MediaStream, ctx: AudioContext, source: MediaStreamAudioSourceNode) {
    this.stream = stream;
    this.ctx = ctx;
    this.source = source;
    const track = stream.getAudioTracks()[0];
    this.label = track?.label || "Mikrofon";
    this.deviceId = track?.getSettings().deviceId || "";
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    if (track) {
      track.onmute = () => this.emit("muted");
      track.onended = () => this.emit("ended");
    }
  }

  /** Mikrofon öffnen. Muss aus einer Nutzergeste kommen (Klick, Taste). */
  static async open(deviceId = savedMicId()): Promise<MicSession> {
    if (!micSupported()) throw new MicError("unsupported");
    const base: MediaTrackConstraints = {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base,
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      // Gemerktes Gerät nicht mehr da → Systemvorgabe, die Wahl wird vergessen.
      if (deviceId && (name === "OverconstrainedError" || name === "NotFoundError")) {
        saveMicId("");
        return MicSession.open("");
      }
      throw new MicError(problemFromError(name));
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new MicError("not-found");
    }
    // Eigener AudioContext für die Messung. Firefox verbindet einen Mikrofonstrom
    // nur mit einem Kontext derselben Abtastrate; dann mit dieser neu versuchen.
    const Ctor = audioCtor();
    let ctx = new Ctor();
    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      void ctx.close();
      const rate = track.getSettings().sampleRate;
      ctx = rate ? new Ctor({ sampleRate: rate }) : new Ctor();
      source = ctx.createMediaStreamSource(stream);
    }
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* läuft trotzdem an */ } }
    const mic = new MicSession(stream, ctx, source);
    if (track.muted) mic.emit("muted");
    return mic;
  }

  get muted(): boolean {
    return this.stream.getAudioTracks()[0]?.muted === true;
  }

  sample(): { rms: number; peak: number } {
    if (this.closed) return { rms: 0, peak: 0 };
    this.analyser.getFloatTimeDomainData(this.buf);
    return { rms: rmsOf(this.buf), peak: peakOf(this.buf) };
  }

  listen(opts: ListenOptions = {}): Utterance {
    if (this.closed) throw new MicError("ended", this.label);
    if (this.muted) throw new MicError("muted", this.label);
    return new Utterance(this, opts);
  }

  /** Auf Sprache warten, ohne aufzunehmen (Hineinsprechen beim Vorlesen).
   *  `bias` hebt die Schwelle um die eigene Ausgabe an. Liefert eine Stopp-Funktion. */
  watch(onSpeech: () => void, bias: () => number, opts: GateOptions = {}): () => void {
    const gate = new SpeechGate({ minVoiceMs: 250, noSpeechMs: 1e9, maxMs: 1e9, ...opts });
    const started = performance.now();
    let active = true;
    const timer = window.setInterval(() => {
      if (!active) return;
      const { rms, peak } = this.sample();
      if (gate.push({ rms, peak, t: performance.now() - started, bias: bias() }) === "speech") {
        active = false;
        window.clearInterval(timer);
        onSpeech();
      }
    }, 50);
    return () => { active = false; window.clearInterval(timer); };
  }

  onProblem(fn: (kind: MicProblem) => void): void { this.problems.add(fn); }
  offProblem(fn: (kind: MicProblem) => void): void { this.problems.delete(fn); }
  private emit(kind: MicProblem): void { this.problems.forEach((fn) => fn(kind)); }

  get isClosed(): boolean { return this.closed; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.problems.clear();
    try { this.source.disconnect(); } catch { /* schon getrennt */ }
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close();
  }
}

export interface TranscribeResult {
  text: string;
  language?: string;
  audio_seconds?: number;
  speech_seconds?: number;
  peak_dbfs?: number | null;
  rms_dbfs?: number | null;
  model?: string;
}

/** Aufnahme auf diesem Rechner erkennen lassen. */
export async function transcribeUtterance(result: UtteranceResult, language = "de"): Promise<TranscribeResult> {
  // Eine Erkennung zugleich je Prozess: 409 heißt "gleich noch einmal".
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<TranscribeResult>(`/api/agent/transcribe?language=${encodeURIComponent(language)}`, {
        method: "POST",
        body: result.blob,
        headers: { "Content-Type": result.type || "audio/webm" },
      });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409 || attempt >= 4) throw err;
      await new Promise((r) => window.setTimeout(r, 1200));
    }
  }
}

/** Leeres Ergebnis → passende Meldung (zu leise oder unverständlich). */
export function emptyResultProblem(result: UtteranceResult, server?: TranscribeResult): MicError {
  const db = typeof server?.peak_dbfs === "number" ? Math.round(server.peak_dbfs) : result.loudestDb;
  if (result.quiet || (typeof server?.peak_dbfs === "number" && server.peak_dbfs < -40)) {
    return new MicError("quiet", "", db);
  }
  return new MicError("not-understood");
}

export interface VoiceServerInfo {
  stt_available: boolean;
  stt_loaded?: boolean;
  stt_model?: string;
  max_seconds?: number;
  tts_backend?: "lokal" | "edge";
}

/** Hat dieser Server eine eigene Spracherkennung? (Portal/Demo: nein, Studio/Labor: ja) */
export async function voiceServerInfo(): Promise<VoiceServerInfo | null> {
  try {
    return await api<VoiceServerInfo>("/api/agent/voice");
  } catch {
    return null;
  }
}
