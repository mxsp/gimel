/* Sprachausgabe für Gimel Voice.
 *
 * Die Antwort kommt als Textstrom. Jeder fertige Satz geht sofort an die
 * Stimme des Servers (`/api/agent/speech`: Piper lokal als WAV, oder auf
 * ausdrücklichen Wunsch Microsoft als MP3), höchstens zwei
 * zugleich, und wird der Reihe nach über Web Audio abgespielt — nicht über
 * ein <audio>-Element: die Inhaltsrichtlinie des Servers erlaubt Medien nur
 * von ihm selbst, ein blob: würde blockiert. Fällt die Serverstimme aus,
 * spricht eine lokale Browserstimme denselben Satz (nie eine Netzstimme).
 */

import { synthesizeSpeech } from "../api";
import { cleanForSpeech, maskForSpeech, speechCut } from "../voice";

interface Job {
  text: string;
  audio: Promise<AudioBuffer | null> | null;
}

const PARALLEL = 2;

export class SpeechPlayer {
  private ctx: AudioContext;
  private voice = "";
  private lang = "de-DE";
  private raw = "";
  private fed = 0;
  private pending = "";
  private jobs: Job[] = [];
  private current: AudioBufferSourceNode | null = null;
  private playing = false;
  private generation = 0;
  private finished = false;
  private serverOk = true;
  private gain: GainNode;
  readonly analyser: AnalyserNode;
  onIdle: () => void = () => {};
  onSpeaking: (sentence: string) => void = () => {};

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.gain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  setVoice(voice: string, lang = "de-DE"): void {
    this.voice = voice;
    this.lang = lang;
  }

  get busy(): boolean {
    return this.playing || this.jobs.length > 0 || this.pending.trim().length > 0;
  }

  /** Neuer Antwortabschnitt (z. B. nach einem Werkzeugaufruf): alles bisher
   *  Eingespeiste gilt als erledigt, der neue Text beginnt bei null. */
  section(): void {
    this.flush(true);
    this.raw = "";
    this.fed = 0;
  }

  /** Den bisher empfangenen Text des laufenden Abschnitts einspeisen. */
  feed(text: string): void {
    this.finished = false;
    if (!text.startsWith(this.raw)) { this.raw = ""; this.fed = 0; }
    this.raw = text;
    const masked = maskForSpeech(text);
    const fresh = masked.slice(this.fed);
    this.fed = masked.length;
    if (!fresh) return;
    this.pending += fresh;
    this.flush(false);
  }

  /** Strom zu Ende: den Rest sprechen, danach meldet `onIdle`. */
  finish(): void {
    this.flush(true);
    this.finished = true;
    if (!this.playing && !this.jobs.length) this.onIdle();
  }

  /** Sofort verstummen (Unterbrechen). */
  stop(): void {
    this.generation++;
    this.jobs = [];
    this.pending = "";
    this.raw = "";
    this.fed = 0;
    this.finished = false;
    if (this.current) {
      try { this.current.stop(); } catch { /* schon zu Ende */ }
      this.current = null;
    }
    try { window.speechSynthesis?.cancel(); } catch { /* ohne Browserstimme */ }
    this.playing = false;
  }

  private flush(all: boolean): void {
    for (;;) {
      const cut = speechCut(this.pending, all);
      if (!cut) break;
      const sentence = cleanForSpeech(this.pending.slice(0, cut));
      this.pending = this.pending.slice(cut);
      if (sentence && /[\p{L}\p{N}]/u.test(sentence)) this.jobs.push({ text: sentence, audio: null });
      if (!this.pending) break;
    }
    this.prefetch();
    void this.pump();
  }

  private prefetch(): void {
    let inFlight = 0;
    for (const job of this.jobs) {
      if (inFlight >= PARALLEL) break;
      if (!job.audio) job.audio = this.fetchAudio(job.text);
      inFlight++;
    }
  }

  private async fetchAudio(text: string): Promise<AudioBuffer | null> {
    if (!this.serverOk) return null;
    const gen = this.generation;
    try {
      const blob = await synthesizeSpeech(text, this.voice);
      if (gen !== this.generation) return null;
      return await this.ctx.decodeAudioData(await blob.arrayBuffer());
    } catch {
      // Einmal ausgefallen (503, kein Netz): für diese Sitzung die Browserstimme.
      this.serverOk = false;
      return null;
    }
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    const gen = this.generation;
    while (this.jobs.length && gen === this.generation) {
      const job = this.jobs[0];
      if (!job.audio) job.audio = this.fetchAudio(job.text);
      this.playing = true;
      const buffer = await job.audio;
      if (gen !== this.generation) return;
      this.jobs.shift();
      this.prefetch();
      this.onSpeaking(job.text);
      if (buffer) await this.playBuffer(buffer, gen);
      else await this.browserSpeak(job.text, gen);
    }
    if (gen !== this.generation) return;
    this.playing = false;
    if (this.finished && !this.jobs.length) this.onIdle();
  }

  private playBuffer(buffer: AudioBuffer, gen: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(this.gain);
      node.onended = () => {
        if (this.current === node) this.current = null;
        resolve();
      };
      this.current = node;
      if (gen !== this.generation) { resolve(); return; }
      node.start();
    });
  }

  private browserSpeak(text: string, gen: number): Promise<void> {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || gen !== this.generation) { resolve(); return; }
      // Nur eine Stimme, die im Gerät rechnet. Netzstimmen (Google, Microsoft
      // Online) schicken den Text in die Cloud; ohne lokale bleibt es beim Text.
      const prefix = this.lang.slice(0, 2).toLowerCase();
      const voice = synth.getVoices().find((v) => v.localService
        && v.lang?.replace("_", "-").toLowerCase().startsWith(prefix));
      if (!voice) { resolve(); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang;
      u.voice = voice;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      synth.speak(u);
    });
  }
}
