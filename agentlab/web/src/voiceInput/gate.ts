/* Sprach-Erkennung im Browser: reine Rechnung, ohne DOM (task 43).
 *
 * Der Browser entscheidet nur, wann eine Äußerung anfängt und endet und ob das
 * Mikrofon überhaupt ein Signal liefert. Ob darin Sprache steckt, entscheidet
 * der Server (faster-whisper mit eigener Silero-VAD). Darum gilt:
 *  - Die Schwelle folgt dem Grundrauschen des Raums (laufendes Minimum statt
 *    300-ms-Messung beim Start) und liegt nie über −55 dBFS + Abstand. Die alte
 *    feste Untergrenze von −38 dBFS verwarf leise Sprache, die Whisper noch bei
 *    −50 dBFS fast wortgenau erkennt.
 *  - Kein stilles Veto: Kam irgendetwas über das Rauschen, geht die Aufnahme
 *    an den Server ("maybe").
 *  - Digitale Stille (exakt 0, z. B. ein Eingang ohne angeschlossenes
 *    Mikrofon) ist ein eigener Fall mit eigener Meldung.
 */

export const FLOOR_DB = -55;      // tiefste Schwelle
export const SNR_DB = 8;          // Abstand über dem Grundrauschen
export const ZERO_PEAK = 1e-6;    // darunter gilt ein Block als digital still
export const QUIET_DB = -45;      // lauteste Stelle darunter: "sehr leise"

export interface GateOptions {
  /** Stille nach dem Sprechen, nach der die Äußerung endet. */
  silenceMs?: number;
  /** So lange darf es ohne Sprache bleiben, bevor die Aufnahme endet. */
  noSpeechMs?: number;
  maxMs?: number;
  /** So lange exakt 0, dann meldet das Tor "dead". */
  zeroMs?: number;
  /** Mindestdauer über der Schwelle, bis es als Sprache zählt. */
  minVoiceMs?: number;
  floorDb?: number;
  snrDb?: number;
}

export type GateEvent =
  | "none"
  | "speech"      // Sprache hat begonnen (einmal)
  | "end"         // Sprache gehört, danach Stille: Äußerung fertig
  | "maybe"       // keine klare Sprache, aber Signal über dem Rauschen: trotzdem senden
  | "no-speech"   // nur Rauschen
  | "dead"        // digitale Stille: das Gerät liefert nichts
  | "max";        // Höchstdauer erreicht (mit Sprache)

export interface GateFrame {
  rms: number;
  peak: number;
  /** Zeit seit Beginn in ms. */
  t: number;
  /** Zusätzliche Schwelle (z. B. eigene Stimme beim Vorlesen), linear. */
  bias?: number;
}

export interface GateState {
  noise: number;
  threshold: number;
  heard: boolean;
  /** lauteste Stelle (RMS je Block) seit Beginn */
  maxRms: number;
  /** lauteste Stelle während Sprache */
  speechRms: number;
  voicedMs: number;
  lastVoiceT: number;
  zeroSince: number | null;
  anySignal: boolean;
}

export const dbToLin = (db: number): number => 10 ** (db / 20);
export const linToDb = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -Infinity);

export function rmsOf(buf: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return buf.length ? Math.sqrt(sum / buf.length) : 0;
}

export function peakOf(buf: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > p) p = v;
  }
  return p;
}

/** Anzeige 0…1 für einen Pegelmesser: −70 dBFS … −10 dBFS. */
export function meterValue(rms: number): number {
  const db = linToDb(rms);
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 70) / 60));
}

export class SpeechGate {
  readonly state: GateState;
  private readonly o: Required<GateOptions>;
  private lastT = 0;
  private started = false;

  constructor(opts: GateOptions = {}) {
    this.o = {
      silenceMs: opts.silenceMs ?? 1200,
      noSpeechMs: opts.noSpeechMs ?? 8000,
      maxMs: opts.maxMs ?? 60000,
      zeroMs: opts.zeroMs ?? 1500,
      minVoiceMs: opts.minVoiceMs ?? 120,
      floorDb: opts.floorDb ?? FLOOR_DB,
      snrDb: opts.snrDb ?? SNR_DB,
    };
    this.state = {
      noise: 0, threshold: dbToLin(this.o.floorDb), heard: false, maxRms: 0, speechRms: 0,
      voicedMs: 0, lastVoiceT: 0, zeroSince: null, anySignal: false,
    };
  }

  /** Einen Block auswerten. Liefert höchstens ein Ereignis. */
  push(f: GateFrame): GateEvent {
    const s = this.state;
    const dt = this.started ? Math.max(0, f.t - this.lastT) : 0;
    this.lastT = f.t;

    // Digitale Stille: das Gerät liefert exakt 0.
    if (f.peak < ZERO_PEAK) {
      if (s.zeroSince === null) s.zeroSince = f.t;
      if (!s.anySignal && f.t - s.zeroSince >= this.o.zeroMs) return "dead";
    } else {
      s.zeroSince = null;
    }

    // Grundrauschen: fällt schnell, steigt langsam und nur, solange niemand spricht.
    if (!this.started) {
      s.noise = f.rms;
      this.started = true;
    } else if (f.rms < s.noise) {
      s.noise += (f.rms - s.noise) * 0.3;
    } else if (f.rms < s.threshold) {
      s.noise += (f.rms - s.noise) * 0.02;
    }
    const floor = dbToLin(this.o.floorDb);
    s.threshold = Math.max(floor, s.noise * dbToLin(this.o.snrDb)) + (f.bias ?? 0);
    s.maxRms = Math.max(s.maxRms, f.rms);
    if (f.rms > Math.max(s.noise * 2, floor * 0.5)) s.anySignal = true;

    let event: GateEvent = "none";
    if (f.rms > s.threshold) {
      s.voicedMs += dt || 50;
      s.lastVoiceT = f.t;
      if (s.heard) s.speechRms = Math.max(s.speechRms, f.rms);
      if (!s.heard && s.voicedMs >= this.o.minVoiceMs) {
        s.heard = true;
        s.speechRms = Math.max(s.speechRms, f.rms);
        event = "speech";
      }
    } else {
      // Silbenpausen: langsam abbauen statt zurücksetzen.
      s.voicedMs = Math.max(0, s.voicedMs - (dt || 50) / 2);
    }
    if (event !== "none") return event;

    if (s.heard && f.t - s.lastVoiceT > this.o.silenceMs) return "end";
    if (f.t >= this.o.maxMs) return s.heard ? "max" : s.anySignal ? "maybe" : "no-speech";
    if (!s.heard && f.t >= this.o.noSpeechMs) return s.anySignal ? "maybe" : "no-speech";
    return "none";
  }

  /** Lauteste Stelle der Sprache in dBFS (oder des ganzen Signals ohne Sprache). */
  loudestDb(): number {
    return Math.round(linToDb(this.state.heard ? this.state.speechRms : this.state.maxRms));
  }

  quiet(): boolean {
    return this.loudestDb() < QUIET_DB;
  }
}

export type MicProblem =
  | "dead" | "muted" | "ended" | "no-speech" | "quiet" | "not-understood"
  | "denied" | "not-found" | "busy" | "insecure" | "unsupported" | "server-missing";

/** Eine klare Meldung je Fall; das Gerät wird beim Namen genannt. */
export function problemText(kind: MicProblem, device = "", db?: number): string {
  const dev = device ? `„${device}“` : "Das Mikrofon";
  const level = db !== undefined && Number.isFinite(db) ? ` (${db} dB)` : "";
  switch (kind) {
    case "dead":
      return `${dev} liefert kein Signal, nur digitale Stille. Wahrscheinlich ist dort nichts angeschlossen — bitte ein anderes Mikrofon wählen.`;
    case "muted":
      return `${dev} ist stummgeschaltet (Systemeinstellung oder Taste am Gerät).`;
    case "ended":
      return `${dev} wurde getrennt. Bitte erneut verbinden oder ein anderes wählen.`;
    case "no-speech":
      return `Kein Ton über dem Raumrauschen${level}. Ist ${device ? dev : "das richtige Mikrofon"} gewählt?`;
    case "quiet":
      return `Sehr leise${level} und nichts verstanden. Bitte näher ans Mikrofon oder den Eingangspegel erhöhen.`;
    case "not-understood":
      return "Etwas gehört, aber nichts verstanden. Bitte noch einmal deutlich sprechen.";
    case "denied":
      return "Der Browser blockiert das Mikrofon. Erlauben über das Mikrofon-Symbol links in der Adressleiste (Firefox: Schloss → Berechtigungen; Chrome: Website-Einstellungen), dann erneut versuchen.";
    case "not-found":
      return "Kein Mikrofon gefunden. Bitte eines anschließen.";
    case "busy":
      return `${dev} wird gerade von einem anderen Programm benutzt.`;
    case "insecure":
      return "Das Mikrofon geht nur über https:// oder auf diesem Rechner (127.0.0.1).";
    case "unsupported":
      return "Dieser Browser kann nicht aufnehmen. Bitte Firefox, Chrome oder Edge benutzen.";
    case "server-missing":
      return "Die Spracherkennung ist auf diesem Server nicht eingerichtet.";
  }
}

/** DOMException-Name von getUserMedia → Fall. */
export function problemFromError(name: string): MicProblem {
  switch (name) {
    case "NotAllowedError": return "denied";
    case "NotFoundError":
    case "OverconstrainedError": return "not-found";
    case "NotReadableError":
    case "AbortError": return "busy";
    case "SecurityError": return "insecure";
    default: return "unsupported";
  }
}
