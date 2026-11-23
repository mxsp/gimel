/* Mikrofon-Aufnahme für Gimel Voice.
 *
 * Eine Aufnahme ist eine Äußerung: Knopf an → sprechen → nach kurzer Stille
 * endet sie von selbst (oder per Knopf). Das Audio geht als eine Datei an
 * `/api/agent/transcribe` und wird dort auf diesem Rechner erkannt.
 * Das Mikrofon wird nach jeder Äußerung wieder freigegeben, damit die
 * Aufnahmeanzeige des Browsers nur leuchtet, solange wirklich zugehört wird.
 */

export interface RecordResult {
  blob: Blob;
  type: string;
  heardSpeech: boolean;
  seconds: number;
}

export interface RecordOptions {
  ctx: AudioContext;
  onLevel?: (level: number) => void;
  /** Stille nach dem Sprechen, nach der die Äußerung endet. */
  silenceMs?: number;
  /** So lange darf es still bleiben, bevor ohne Sprache abgebrochen wird. */
  noSpeechMs?: number;
  maxMs?: number;
}

const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];

export function recordingSupported(): boolean {
  return typeof navigator !== "undefined"
    && !!navigator.mediaDevices?.getUserMedia
    && typeof window.MediaRecorder !== "undefined";
}

function pickType(): string {
  for (const t of TYPES) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* älterer Browser */ }
  }
  return "";
}

export const MIC_ERRORS: Record<string, string> = {
  NotAllowedError: "Der Browser erlaubt keinen Zugriff auf das Mikrofon. Bitte die Berechtigung erteilen.",
  NotFoundError: "Kein Mikrofon gefunden.",
  NotReadableError: "Das Mikrofon wird gerade von einem anderen Programm benutzt.",
  SecurityError: "Das Mikrofon geht nur über https:// oder auf diesem Rechner (127.0.0.1).",
};

/** Eine laufende Aufnahme. `stop()` beendet sie und liefert das Ergebnis über `done`. */
export class Recording {
  readonly done: Promise<RecordResult>;
  private stopFn: (cancel: boolean) => void = () => {};

  constructor(stream: MediaStream, opts: RecordOptions) {
    const { ctx } = opts;
    const silenceMs = opts.silenceMs ?? 1300;
    const noSpeechMs = opts.noSpeechMs ?? 8000;
    const maxMs = opts.maxMs ?? 60000;

    const type = pickType();
    const recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const started = performance.now();
    let noise = 0.004;
    let calibrated = 0;
    let voiced = 0;
    let heardSpeech = false;
    let lastVoice = started;
    let finished = false;
    let cancelled = false;

    this.done = new Promise<RecordResult>((resolve, reject) => {
      const cleanup = () => {
        window.clearInterval(timer);
        try { source.disconnect(); } catch { /* schon getrennt */ }
        stream.getTracks().forEach((t) => t.stop());
        opts.onLevel?.(0);
      };
      recorder.onstop = () => {
        cleanup();
        if (cancelled) { reject(new DOMException("abgebrochen", "AbortError")); return; }
        const blobType = (recorder.mimeType || type || "audio/webm").split(";")[0];
        resolve({
          blob: new Blob(chunks, { type: blobType }),
          type: blobType,
          heardSpeech,
          seconds: (performance.now() - started) / 1000,
        });
      };
      recorder.onerror = () => { cleanup(); reject(new Error("Die Aufnahme ist fehlgeschlagen.")); };

      const finish = (cancel: boolean) => {
        if (finished) return;
        finished = true;
        cancelled = cancel;
        if (recorder.state !== "inactive") recorder.stop();
        else { cleanup(); if (cancel) reject(new DOMException("abgebrochen", "AbortError")); }
      };
      this.stopFn = finish;

      const timer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        // Die ersten 300 ms messen das Grundrauschen des Raums.
        if (now - started < 300) {
          noise = (noise * calibrated + rms) / (calibrated + 1);
          calibrated++;
        }
        const threshold = Math.max(0.012, noise * 2.8);
        opts.onLevel?.(Math.min(1, rms / Math.max(threshold * 4, 0.05)));
        if (rms > threshold) {
          voiced += 50;
          if (voiced >= 150) heardSpeech = true;
          lastVoice = now;
        } else {
          voiced = Math.max(0, voiced - 25);
        }
        if (heardSpeech && now - lastVoice > silenceMs) finish(false);
        else if (!heardSpeech && now - started > noSpeechMs) finish(false);
        else if (now - started > maxMs) finish(false);
      }, 50);

      recorder.start(250);
    });
  }

  stop(): void { this.stopFn(false); }
  cancel(): void { this.stopFn(true); }
}

export async function startRecording(opts: RecordOptions): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  try {
    if (opts.ctx.state === "suspended") await opts.ctx.resume();
    return new Recording(stream, opts);
  } catch (err) {
    // Sonst bliebe das Mikrofon an, ohne dass jemand zuhört.
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }
}
