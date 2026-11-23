/* Sprache im Assistenten.
 *
 * Zwei getrennte Wege:
 *  - Diktat: der Browser erkennt Gesprochenes und schreibt es in das
 *    Eingabefeld. Der erkannte Text ist damit zugleich das Transkript.
 *  - Vorlesen: die Antwort wird beim Eintreffen satzweise gesprochen, nicht
 *    erst wenn der ganze Strom fertig ist. Zuerst über die leichte neuronale
 *    Stimme des Servers (edge-tts, `/api/agent/speech`); fehlt sie, spricht
 *    der Browser. Der jeweils nächste Satz wird schon geholt, während der
 *    laufende noch klingt.
 *
 * Beides ist bewusst hier gekapselt: ChatPane bleibt der eine Chat-Code für
 * /lab, Portal und Twin Studio.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { synthesizeSpeech } from "./api";

const SPEAK_KEY = "gimel-voice-speak";
const DEFAULT_LANG = "de-DE";

/* Die DOM-Typen kennen SpeechRecognition nicht (die API ist nicht
   standardisiert). Nur die Felder, die wir wirklich benutzen. */
interface RecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative;
}

interface RecognitionResultList {
  readonly length: number;
  [index: number]: RecognitionResult;
}

interface RecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
}

interface RecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function append(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return /\s$/.test(a) || /^\s/.test(b) ? a + b : `${a} ${b}`;
}

const DICTATION_ERROR: Record<string, string> = {
  "not-allowed": "Der Browser erlaubt keinen Zugriff auf das Mikrofon. Bitte die Berechtigung erteilen.",
  "service-not-allowed": "Die Spracherkennung ist in diesem Browser nicht verfügbar.",
  "audio-capture": "Kein Mikrofon gefunden.",
  network: "Die Spracherkennung braucht eine Internetverbindung.",
};

export interface Dictation {
  supported: boolean;
  listening: boolean;
  start: (base?: string) => void;
  stop: () => void;
  toggle: (base?: string) => void;
}

/** Diktat in das Eingabefeld. `base` ist der bereits getippte Text; er bleibt
 *  stehen und das Gesprochene wird dahinter gesetzt. */
export function useDictation(
  onText: (text: string) => void,
  onError?: (message: string) => void,
): Dictation {
  const [supported] = useState(() => recognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const textRef = useRef(onText);
  const errorRef = useRef(onError);
  textRef.current = onText;
  errorRef.current = onError;

  const recRef = useRef<Recognition | null>(null);
  const activeRef = useRef(false);
  const sessionRef = useRef(0);
  const baseRef = useRef("");
  const finalRef = useRef("");
  const interimRef = useRef("");
  const timerRef = useRef<number | null>(null);

  const emit = useCallback(() => {
    const said = append(finalRef.current, interimRef.current).trim();
    const base = baseRef.current;
    const text = said
      ? (base && !/\s$/.test(base) ? `${base} ${said}` : base + said)
      : base;
    textRef.current(text);
  }, []);

  const start = useCallback((base = "") => {
    if (activeRef.current) return;
    const Ctor = recognitionCtor();
    if (!Ctor) {
      errorRef.current?.("Dieser Browser kann nicht diktieren. Bitte Chrome, Edge oder Safari verwenden.");
      return;
    }
    baseRef.current = base;
    finalRef.current = "";
    interimRef.current = "";
    activeRef.current = true;
    const session = ++sessionRef.current;
    setListening(true);

    const rec = new Ctor();
    rec.lang = DEFAULT_LANG;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      /* Nach einem bewussten Stopp können noch Abschlussergebnisse eintreffen.
         Sie dürfen das bereits geleerte Eingabefeld nicht wieder füllen. */
      if (!activeRef.current || sessionRef.current !== session) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const said = result[0]?.transcript ?? "";
        if (result.isFinal) finalRef.current = append(finalRef.current, said);
        else interim = append(interim, said);
      }
      interimRef.current = interim;
      emit();
    };

    rec.onerror = (event) => {
      if (sessionRef.current !== session) return;
      /* no-speech/aborted sind normal: Chrome beendet nach Stille, onend
         startet dann neu. Alles andere ist ein echter Abbruch. */
      if (event.error === "no-speech" || event.error === "aborted") return;
      activeRef.current = false;
      setListening(false);
      errorRef.current?.(DICTATION_ERROR[event.error]
        ?? `Spracherkennung fehlgeschlagen (${event.error}).`);
      try { rec.abort(); } catch { /* schon beendet */ }
    };

    rec.onend = () => {
      if (sessionRef.current !== session) return;
      recRef.current = null;
      if (!activeRef.current) return;
      /* Chrome beendet die Erkennung nach ein paar Sekunden Stille. Solange
         das Diktat laufen soll, starten wir sie leise neu. */
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!activeRef.current || sessionRef.current !== session) return;
        try {
          rec.start();
          recRef.current = rec;
        } catch {
          activeRef.current = false;
          setListening(false);
          errorRef.current?.("Die Spracherkennung wurde beendet. Bitte erneut starten.");
        }
      }, 250);
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch {
      recRef.current = null;
      activeRef.current = false;
      setListening(false);
      errorRef.current?.("Die Spracherkennung konnte nicht starten.");
    }
  }, [emit]);

  const stop = useCallback(() => {
    activeRef.current = false;
    sessionRef.current++;
    setListening(false);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      try { rec.stop(); } catch { /* schon beendet */ }
    }
  }, []);

  const toggle = useCallback((base = "") => {
    if (activeRef.current) stop();
    else start(base);
  }, [start, stop]);

  useEffect(() => () => {
    activeRef.current = false;
    sessionRef.current++;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    try { recRef.current?.abort(); } catch { /* egal */ }
    recRef.current = null;
  }, []);

  return { supported, listening, start, stop, toggle };
}

const MIN_SPEAK = 18;
const MAX_SPEAK = 220;

/** Codeblöcke, Adressen und HTML werden durch Leerzeichen ersetzt, ohne die
 *  Länge zu verändern: So bleiben die Positionen im wachsenden Strom gültig. */
export function maskForSpeech(text: string): string {
  const chars = text.split("");
  let fence: string | null = null;
  let lineStart = 0;
  for (let i = 0; i <= chars.length; i++) {
    if (i < chars.length && chars[i] !== "\n") continue;
    const line = chars.slice(lineStart, i).join("");
    const trimmed = line.trim();
    const marker = trimmed.startsWith("```") ? "```" : trimmed.startsWith("~~~") ? "~~~" : "";
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      for (let j = lineStart; j < i; j++) chars[j] = " ";
    } else if (fence !== null) {
      for (let j = lineStart; j < i; j++) chars[j] = " ";
    }
    lineStart = i + 1;
  }
  return chars.join("")
    .replace(/https?:\/\/[^\s)\]]+/gi, (match) => " ".repeat(match.length))
    .replace(/<[^>\n]{1,200}>/g, (match) => " ".repeat(match.length));
}

/** Markdown-Gerümpel aus einem Satz entfernen, damit nicht "Stern Stern" oder
 *  "Raute" vorgelesen wird. */
export function cleanForSpeech(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]{4,}\|?\s*$/gm, " ")
    .replace(/^\s*\|/gm, "")
    .replace(/\|\s*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/`+/g, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ende des nächsten Satzes im Puffer; 0 heißt: noch warten. */
export function speechCut(text: string, flushAll = false): number {
  if (flushAll) return text.length;
  for (let i = MIN_SPEAK; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") return i + 1;
    if ((ch === "." || ch === "!" || ch === "?" || ch === "…")
      && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      return i + 1;
    }
  }
  if (text.length >= MAX_SPEAK) {
    const space = text.lastIndexOf(" ", MAX_SPEAK);
    return space >= MIN_SPEAK ? space + 1 : MAX_SPEAK;
  }
  return 0;
}

/** Warteschlange für das Vorlesen. Sie kennt den bereits gesprochenen Teil
 *  des Stroms und spricht nur den neuen Rest. */
class SpeechQueue {
  private enabled = false;
  private lang: string;
  private served = "";   // der zuletzt eingespeiste Rohtext
  private fed = 0;       // davon bereits in Sätze zerlegt
  private pending = "";
  private jobs: string[] = [];
  private playing = false;
  private prefetch: { text: string; blob: Promise<Blob | null> } | null = null;
  private generation = 0;
  private server = true;
  private rate = 1;
  /** Meldet, ob gerade gesprochen wird (für Live: danach wieder zuhören). */
  onBusy: ((busy: boolean) => void) | null = null;

  private setPlaying(next: boolean): void {
    if (next === this.playing) return;
    this.playing = next;
    this.onBusy?.(next);
  }

  setRate(rate: number): void {
    this.rate = Math.min(1.4, Math.max(0.8, rate || 1));
  }

  get busy(): boolean {
    return this.playing;
  }

  /** Lautstärke der eigenen Ausgabe (RMS), damit Hineinsprechen sie übertönen muss. */
  outputRms(): number {
    const a = this.analyser;
    if (!a || !this.playing) return 0;
    if (!this.outBuf) this.outBuf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.outBuf);
    let sum = 0;
    for (let i = 0; i < this.outBuf.length; i++) sum += this.outBuf[i] * this.outBuf[i];
    return Math.sqrt(sum / this.outBuf.length);
  }

  constructor(lang: string, enabled: boolean) {
    this.lang = lang;
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.cancel();
  }

  feed(text: string): void {
    if (!this.enabled || !text) return;
    if (this.served && !text.startsWith(this.served)) {
      /* Eine andere Antwort hat den Text ersetzt (z. B. Nachricht neu
         erzeugt): das Alte abbrechen und von vorn lesen. */
      this.cancel();
    }
    this.served = text;
    const masked = maskForSpeech(text);
    if (masked.length < this.fed) this.fed = masked.length;
    const fresh = masked.slice(this.fed);
    this.fed = masked.length;
    if (!fresh) return;
    this.pending += fresh;
    this.flush(false);
  }

  finish(): void {
    if (!this.enabled) return;
    this.flush(true);
  }

  stop(): void {
    this.cancel();
  }

  private cancel(): void {
    this.generation++;
    this.served = "";
    this.fed = 0;
    this.pending = "";
    this.jobs = [];
    this.prefetch = null;
    this.setPlaying(false);
    const source = this.source;
    this.source = null;
    if (source) {
      try { source.stop(); } catch { /* schon zu Ende */ }
    }
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  }

  private flush(all: boolean): void {
    for (;;) {
      const cut = speechCut(this.pending, all);
      if (cut <= 0) break;
      const chunk = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut);
      this.enqueue(chunk);
    }
    if (all) {
      const rest = this.pending;
      this.pending = "";
      this.enqueue(rest);
    }
  }

  private enqueue(raw: string): void {
    const text = cleanForSpeech(raw);
    if (!text) return;
    this.jobs.push(text);
    this.prefetchNext();
    this.pump();
  }

  private pump(): void {
    if (this.playing || !this.jobs.length) return;
    this.setPlaying(true);
    void this.run();
  }

  private async run(): Promise<void> {
    const gen = this.generation;
    while (this.jobs.length) {
      if (gen !== this.generation) return;
      const text = this.jobs.shift() as string;
      let blob: Blob | null = null;
      if (this.prefetch?.text === text) {
        blob = await this.prefetch.blob;
        this.prefetch = null;
      } else if (this.server) {
        blob = await this.fetchSpeech(text);
      }
      if (gen !== this.generation) return;

      /* Den nächsten Satz holen, während dieser noch klingt. */
      this.prefetchNext();

      if (blob) {
        const played = await this.play(blob);
        if (gen !== this.generation) return;
        if (!played) await this.browserSpeak(text);
      } else {
        await this.browserSpeak(text);
      }
      if (gen !== this.generation) return;
    }
    if (gen === this.generation) this.setPlaying(false);
  }

  private prefetchNext(): void {
    if (!this.server || !this.playing || !this.jobs.length) return;
    const text = this.jobs[0];
    if (this.prefetch?.text === text) return;
    this.prefetch = { text, blob: this.fetchSpeech(text) };
  }

  private async fetchSpeech(text: string): Promise<Blob | null> {
    try {
      return await synthesizeSpeech(text, "", this.rate);
    } catch {
      /* Kein Server-TTS (Paket fehlt, offline, Sitzung): für den Rest des
         Gesprächs die Stimme des Browsers nehmen. */
      this.server = false;
      this.prefetch = null;
      return null;
    }
  }

  /* Über Web Audio, nicht über <audio src="blob:…">: die Inhaltsrichtlinie
     des Servers erlaubt Medien nur von ihm selbst und blockiert blob:. */
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private outBuf: Float32Array<ArrayBuffer> | null = null;

  private async play(blob: Blob): Promise<boolean> {
    if (typeof window === "undefined") return false;
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    try {
      if (!this.ctx) {
        this.ctx = new Ctor();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.connect(this.ctx.destination);
      }
      if (this.ctx.state === "suspended") await this.ctx.resume();
      const buffer = await this.ctx.decodeAudioData(await blob.arrayBuffer());
      const ctx = this.ctx;
      return await new Promise<boolean>((resolve) => {
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(this.analyser ?? ctx.destination);
        node.onended = () => {
          if (this.source === node) this.source = null;
          resolve(true);
        };
        this.source = node;
        node.start();
      });
    } catch {
      return false;
    }
  }

  private browserSpeak(text: string): Promise<void> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const synth = window.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.lang;
      utterance.rate = 1.03 * this.rate;
      utterance.pitch = 1;
      /* Nur eine Stimme, die im Gerät rechnet: Netzstimmen (Google, Microsoft
         Online) schicken den Text in die Cloud. Ohne lokale Stimme bleibt es
         beim angezeigten Text. */
      const voice = this.voiceFor(synth);
      if (!voice) { resolve(); return; }
      utterance.voice = voice;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      try {
        /* Nach einem cancel() bleibt die Ausgabe in manchen Chromium-Versionen
           pausiert; resume() holt sie zurück, bevor der nächste Satz kommt. */
        if (synth.paused) synth.resume();
        synth.speak(utterance);
      } catch {
        finish();
      }
    });
  }

  private voiceFor(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    const prefix = this.lang.slice(0, 2).toLowerCase();
    const voices = synth.getVoices();
    return voices.find((voice) => voice.lang.replace("_", "-").toLowerCase().startsWith(prefix)
        && voice.localService) ?? null;
  }
}

export interface ReadAloud {
  supported: boolean;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
  feed: (text: string) => void;
  finish: () => void;
  stop: () => void;
  /** Spricht gerade (laufende Antwort oder „Vorlesen“ einer einzelnen Nachricht). */
  speaking: boolean;
  /** Eine fertige Nachricht einmal vorlesen, unabhängig vom Schalter. */
  say: (text: string, key?: string) => void;
  /** Schlüssel der Nachricht, die `say` gerade liest. */
  saying: string | null;
  rate: number;
  setRate: (rate: number) => void;
  /** Pegel der eigenen Ausgabe (RMS) für das Hineinsprechen im Live-Modus. */
  outputRms: () => number;
}

const RATE_KEY = "gimel-voice-rate";

function storedSpeak(): boolean {
  try { return localStorage.getItem(SPEAK_KEY) === "1"; } catch { return false; }
}

function storedRate(): number {
  try {
    const n = Number(localStorage.getItem(RATE_KEY));
    return n >= 0.8 && n <= 1.4 ? n : 1;
  } catch { return 1; }
}

/** Antworten satzweise vorlesen, während sie eintreffen. */
export function useReadAloud(lang = DEFAULT_LANG): ReadAloud {
  /* Der Server spricht (Piper lokal, auf Wunsch edge-tts); der Browser ist nur der Rückfall. */
  const [supported] = useState(() => typeof window !== "undefined");
  const [enabled, setEnabledState] = useState(storedSpeak);
  const [rate, setRateState] = useState(storedRate);
  const [busyMain, setBusyMain] = useState(false);
  const [busyOnce, setBusyOnce] = useState(false);
  const [saying, setSaying] = useState<string | null>(null);
  const queueRef = useRef<SpeechQueue | null>(null);
  const onceRef = useRef<SpeechQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new SpeechQueue(lang, storedSpeak());
    queueRef.current.setRate(storedRate());
    queueRef.current.onBusy = setBusyMain;
  }
  if (!onceRef.current) {
    onceRef.current = new SpeechQueue(lang, true);
    onceRef.current.setRate(storedRate());
    onceRef.current.onBusy = (busy) => { setBusyOnce(busy); if (!busy) setSaying(null); };
  }

  const setEnabled = useCallback((next: boolean) => {
    queueRef.current?.setEnabled(next);
    setEnabledState(next);
    try {
      if (next) localStorage.setItem(SPEAK_KEY, "1");
      else localStorage.removeItem(SPEAK_KEY);
    } catch { /* egal */ }
  }, []);

  const setRate = useCallback((next: number) => {
    const r = Math.min(1.4, Math.max(0.8, next));
    queueRef.current?.setRate(r);
    onceRef.current?.setRate(r);
    setRateState(r);
    try { localStorage.setItem(RATE_KEY, String(r)); } catch { /* egal */ }
  }, []);

  const toggle = useCallback(() => setEnabled(!enabled), [enabled, setEnabled]);
  const feed = useCallback((text: string) => { onceRef.current?.stop(); queueRef.current?.feed(text); }, []);
  const finish = useCallback(() => queueRef.current?.finish(), []);
  const stop = useCallback(() => { queueRef.current?.stop(); onceRef.current?.stop(); setSaying(null); }, []);
  const say = useCallback((text: string, key = "") => {
    queueRef.current?.stop();
    const once = onceRef.current;
    if (!once) return;
    once.stop();
    setSaying(key || "x");
    once.feed(text);
    once.finish();
    if (!once.busy) setSaying(null);
  }, []);
  const outputRms = useCallback(
    () => Math.max(queueRef.current?.outputRms() ?? 0, onceRef.current?.outputRms() ?? 0), []);

  useEffect(() => () => { queueRef.current?.stop(); onceRef.current?.stop(); }, []);

  return {
    supported, enabled, setEnabled, toggle, feed, finish, stop,
    speaking: busyMain || busyOnce, say, saying, rate, setRate, outputRms,
  };
}
