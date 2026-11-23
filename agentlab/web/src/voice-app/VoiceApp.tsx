/* Gimel Voice: mit dem Assistenten sprechen.
 *
 * Ein großer Mikrofonknopf. Antippen → sprechen → nach kurzer Stille wird
 * die Aufnahme auf diesem Rechner erkannt (`/api/agent/transcribe`), als
 * Nachricht in einen Agent-Lab-Chat geschickt (dasselbe Modell, dieselben
 * Werkzeuge und Rechte wie im Labor) und die Antwort satzweise vorgelesen,
 * während sie noch geschrieben wird. Antippen während des Sprechens
 * unterbricht. „Live-Gespräch“ hört nach jeder Antwort von selbst wieder zu.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, ApiError, cancelChat, clearToken, createChat, getChat, getToken, logout,
  SessionUser, streamMessage,
} from "../api";
import BotSmiley from "../BotSmiley";
import Login from "../Login";
import { toolLabel } from "../toolLabels";
import { SpeechPlayer } from "./player";
import { SpeechGate, meterValue } from "../voiceInput/gate";
import { DeviceSelect, LevelMeter } from "../voiceInput/MicPanel";
import {
  LevelInfo, MicDevice, MicError, MicSession, Utterance, emptyResultProblem, listMics, micSupported,
  saveMicId, savedMicId, transcribeUtterance,
} from "../voiceInput/mic";
import { VoiceProblem, describe } from "../voiceInput/useVoiceInput";

type Phase = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: string[];
  error?: string;
  live?: boolean;
}

interface VoiceInfo {
  tts_backend: "lokal" | "edge";
  llm_provider: string;
  stt_available: boolean;
  stt_loaded: boolean;
  stt_model: string;
  max_seconds: number;
  tts_available: boolean;
  default_voice: string;
  voices: { id: string; name: string }[];
}

const CHAT_KEY = "gimel-voice-chat";
const PREF_KEY = "gimel-voice-prefs";
const ROUTE = "/voice";

const PHASE_TEXT: Record<Phase, string> = {
  idle: "Bereit. Zum Sprechen antippen oder Leertaste.",
  listening: "Ich höre zu …",
  transcribing: "Erkenne Sprache …",
  thinking: "Denke nach …",
  speaking: "Spreche. Antippen unterbricht.",
};

const PHASE_CHIP: Record<Phase, string> = {
  idle: "bereit",
  listening: "hört zu",
  transcribing: "erkennt",
  thinking: "denkt",
  speaking: "spricht",
};

interface Prefs { voice: string; language: string; handsFree: boolean }

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    return {
      voice: typeof raw.voice === "string" ? raw.voice : "",
      language: raw.language === "en" || raw.language === "auto" ? raw.language : "de",
      handsFree: raw.handsFree === true,
    };
  } catch {
    return { voice: "", language: "de", handsFree: false };
  }
}

function savePrefs(p: Prefs): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* ohne Speicher */ }
}

function storedChat(): number | null {
  try {
    const n = Number(localStorage.getItem(CHAT_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

let turnSeq = 0;
const nextId = () => `t${++turnSeq}`;

export default function VoiceApp() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(() => !!getToken());
  const [loginError, setLoginError] = useState("");

  useEffect(() => {
    if (!getToken()) { setChecking(false); return; }
    api<{ email: string; name: string; role: string }>("/api/auth/me")
      .then((me) => {
        if (me.role === "customer") {
          clearToken();
          setLoginError("Gimel Voice ist für das Team.");
          return;
        }
        setUser({ email: me.email, name: me.name, role: me.role });
      })
      .catch(() => { clearToken(); setUser(null); })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const onLogout = () => setUser(null);
    window.addEventListener("agentlab-logout", onLogout);
    return () => window.removeEventListener("agentlab-logout", onLogout);
  }, []);

  if (checking) {
    return <div className="login-stage"><div className="login-card">Anmeldung wird geprüft …</div></div>;
  }
  if (!user) {
    return (
      <>
        {loginError && <div className="voice-error voice-login-error" role="alert">{loginError}</div>}
        <Login title="Gimel Voice"
          subtitle="Mit dem Gimel-Assistenten sprechen. Anmeldung mit Ihrem Gimel-Konto."
          onLogin={(next) => {
          if (next.role === "customer") { clearToken(); setLoginError("Gimel Voice ist für das Team."); return; }
          setLoginError("");
          setUser(next);
        }} />
      </>
    );
  }
  return <VoiceStage user={user} onLogout={async () => { await logout(); setUser(null); }} />;
}

function VoiceStage({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [typed, setTyped] = useState("");
  const [chatId, setChatId] = useState<number | null>(storedChat);
  const [chatTitle, setChatTitle] = useState("");
  // Mit Schreibzugriff (im Labor einschaltbar) hört Gimel Voice nie von selbst
  // wieder zu: sonst könnte Gesprochenes aus der Halle Änderungen auslösen.
  const [writeMode, setWriteMode] = useState(false);
  const startingRef = useRef(false);
  // Mikrofon (task 43): gewähltes Gerät, Pegel mit Schwelle, klare Fehler, Vorschau.
  const [inLevel, setInLevel] = useState<LevelInfo>({ meter: 0, threshold: 0, db: -Infinity });
  const [heard, setHeard] = useState(false);
  const [problem, setProblem] = useState<VoiceProblem | null>(null);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [deviceId, setDeviceId] = useState(savedMicId);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<{ text: string; left: number; paused?: boolean } | null>(null);
  const micRef = useRef<MicSession | null>(null);
  const uttRef = useRef<Utterance | null>(null);
  const deviceRef = useRef(deviceId);
  deviceRef.current = deviceId;
  const missesRef = useRef(0);
  const bargeRef = useRef<(() => void) | null>(null);
  const testRef = useRef<number | null>(null);
  const previewRef = useRef<number | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const playerRef = useRef<SpeechPlayer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const prefsRef = useRef(prefs);
  const chatRef = useRef<number | null>(chatId);
  const listRef = useRef<HTMLDivElement | null>(null);
  const meterRaf = useRef<number | null>(null);
  const writeModeRef = useRef(false);
  prefsRef.current = prefs;
  chatRef.current = chatId;
  writeModeRef.current = writeMode;

  const setPhaseBoth = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  useEffect(() => {
    api<VoiceInfo>("/api/agent/voice").then(setInfo).catch((e) => {
      setError(e instanceof ApiError ? e.message : String(e));
    });
  }, []);

  // Vorhandenes Gespräch laden (nur Text von Nutzer und Assistent).
  useEffect(() => {
    if (!chatId) return;
    getChat(chatId).then((detail) => {
      setChatTitle(detail.chat.title);
      setWriteMode(detail.chat.write_mode === true);
      setTurns(detail.messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
        .slice(-20)
        .map((m) => ({ id: `m${m.id}`, role: m.role as "user" | "assistant", text: m.content, tools: [] })));
    }).catch(() => {
      try { localStorage.removeItem(CHAT_KEY); } catch { /* egal */ }
      setChatId(null);
    });
    // nur beim Öffnen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  useEffect(() => { savePrefs(prefs); }, [prefs]);

  const audio = useCallback((): { ctx: AudioContext; player: SpeechPlayer } => {
    if (!ctxRef.current) {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    if (!playerRef.current) playerRef.current = new SpeechPlayer(ctxRef.current);
    if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
    return { ctx: ctxRef.current, player: playerRef.current };
  }, []);

  // Pegel der Stimme beim Sprechen, damit der Knopf auch dann „lebt“.
  const watchOutput = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const buf = new Uint8Array(player.analyser.fftSize);
    const tick = () => {
      if (phaseRef.current !== "speaking") { setLevel(0); meterRaf.current = null; return; }
      player.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
      meterRaf.current = requestAnimationFrame(tick);
    };
    if (meterRaf.current == null) meterRaf.current = requestAnimationFrame(tick);
  }, []);

  const ensureChat = useCallback(async (): Promise<number> => {
    if (chatRef.current) return chatRef.current;
    const chat = await createChat({ title: "Gimel Voice" });
    chatRef.current = chat.id;
    setChatId(chat.id);
    setChatTitle(chat.title);
    try { localStorage.setItem(CHAT_KEY, String(chat.id)); } catch { /* egal */ }
    return chat.id;
  }, []);

  const listenRef = useRef<() => void>(() => {});

  const ask = useCallback(async (text: string) => {
    const { player } = audio();
    player.stop();
    player.setVoice(prefsRef.current.voice || info?.default_voice || "",
      prefsRef.current.language === "en" ? "en-US" : "de-DE");
    const userTurn: Turn = { id: nextId(), role: "user", text, tools: [] };
    const answer: Turn = { id: nextId(), role: "assistant", text: "", tools: [], live: true };
    setTurns((t) => [...t, userTurn, answer]);
    setPhaseBoth("thinking");
    setError("");

    let live = "";
    let spoke = false;
    let failed = false;
    const update = (patch: Partial<Turn>) =>
      setTurns((t) => t.map((x) => (x.id === answer.id ? { ...x, ...patch } : x)));

    player.onSpeaking = () => {
      if (phaseRef.current !== "speaking" && phaseRef.current !== "listening") {
        setPhaseBoth("speaking");
        watchOutput();
        armBarge();
      }
      spoke = true;
    };
    player.onIdle = () => {
      disarmBarge();
      if (phaseRef.current !== "speaking" && phaseRef.current !== "thinking") return;
      setPhaseBoth("idle");
      if (prefsRef.current.handsFree && !writeModeRef.current && !failed) {
        window.setTimeout(() => listenRef.current(), 250);
      }
    };

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const id = await ensureChat();
      await streamMessage(id, text, ROUTE, [], (event) => {
        if (event.type === "delta") {
          live += String(event.text || "");
          update({ text: live });
          player.feed(live);
        } else if (event.type === "tool_call") {
          const name = toolLabel(String(event.name || "Werkzeug"));
          setTurns((t) => t.map((x) => (x.id === answer.id ? { ...x, tools: [...x.tools, name] } : x)));
        } else if (event.type === "error") {
          failed = true;
          update({ error: String(event.detail || "Fehler") });
        }
      }, abort.signal, { route: ROUTE, title: "Gimel Voice (Sprachgespräch)" }, liveOn());
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        failed = true;
        // Live mit Schreibzugriff lehnt der Server ab; dann gilt der Chat als schreibend.
        if (err instanceof ApiError && err.status === 409 && /Schreibzugriff/.test(err.message)) {
          setWriteMode(true);
          writeModeRef.current = true;
          closeMic();
        }
        update({ error: err instanceof ApiError ? err.message : String(err) });
      }
    } finally {
      abortRef.current = null;
      update({ live: false });
      if (phaseRef.current === "thinking" || phaseRef.current === "speaking") {
        if (failed && !spoke) { player.stop(); setPhaseBoth("idle"); }
        else player.finish();
      }
    }
  }, [audio, ensureChat, info, watchOutput]);

  /** Laufende Antwort und Stimme sofort stoppen. */
  const interrupt = useCallback(async () => {
    bargeRef.current?.();
    bargeRef.current = null;
    playerRef.current?.stop();
    abortRef.current?.abort();
    abortRef.current = null;
    if (chatRef.current) { try { await cancelChat(chatRef.current); } catch { /* lief nicht */ } }
    setTurns((t) => t.map((x) => (x.live ? { ...x, live: false } : x)));
  }, []);

  /** Live: Gimel hört nach jeder Antwort wieder zu, Mikrofon bleibt offen. */
  const liveOn = () => prefsRef.current.handsFree && !writeModeRef.current;

  const closeMic = useCallback(() => {
    bargeRef.current?.();
    bargeRef.current = null;
    micRef.current?.close();
    micRef.current = null;
    setInLevel({ meter: 0, threshold: 0, db: -Infinity });
  }, []);

  const openMic = useCallback(async (): Promise<MicSession> => {
    if (micRef.current) return micRef.current;
    const mic = await MicSession.open(deviceRef.current);
    micRef.current = mic;
    setDeviceLabel(mic.label);
    if (mic.deviceId && mic.deviceId !== deviceRef.current) setDeviceId(mic.deviceId);
    listMics().then(setDevices).catch(() => undefined);
    return mic;
  }, []);

  /* Hineinsprechen, während Gimel spricht (nur Live): die eigene Stimme hebt die
     Schwelle, damit das Echo aus dem Lautsprecher nicht unterbricht. */
  function playerRms(): number {
    const player = playerRef.current;
    if (!player) return 0;
    const buf = new Uint8Array(player.analyser.fftSize);
    player.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / buf.length);
  }
  function armBarge(): void {
    if (!liveOn() || !micRef.current || bargeRef.current) return;
    bargeRef.current = micRef.current.watch(() => {
      bargeRef.current = null;
      void (async () => {
        await interruptRef.current();
        setPhaseBoth("idle");
        void listenRef.current();
      })();
    }, () => playerRms() * 1.6);
  }
  function disarmBarge(): void {
    bargeRef.current?.();
    bargeRef.current = null;
  }

  const stopPreview = () => {
    if (previewRef.current !== null) window.clearInterval(previewRef.current);
    previewRef.current = null;
    setPreview(null);
  };

  /** Wer die Vorschau anfasst oder hinfokussiert, hält den Countdown an (WCAG 2.2.1). */
  const pausePreview = () => {
    if (previewRef.current === null) return;
    window.clearInterval(previewRef.current);
    previewRef.current = null;
    setPreview((p) => (p ? { ...p, paused: true } : p));
  };

  /** Erkannter Text steht kurz zur Prüfung da und geht dann von selbst los. */
  const startPreview = (text: string) => {
    stopPreview();
    const began = performance.now();
    const total = 2200;
    setPreview({ text, left: total });
    previewRef.current = window.setInterval(() => {
      const left = total - (performance.now() - began);
      if (left <= 0) {
        stopPreview();
        void askRef.current(text);
      } else {
        setPreview({ text, left });
      }
    }, 100);
  };

  const listen = useCallback(async () => {
    stopPreview();
    if (!micSupported()) { setProblem(describe(new MicError("unsupported"))); return; }
    if (info && !info.stt_available) { setProblem(describe(new MicError("server-missing"))); return; }
    if (startingRef.current || uttRef.current) return;
    startingRef.current = true;
    audio(); // aus der Nutzergeste heraus: Wiedergabe darf später starten
    setError("");
    setProblem(null);
    setHeard(false);
    let mic: MicSession;
    try {
      mic = await openMic();
    } catch (err) {
      setProblem(describe(err));
      setPhaseBoth("idle");
      return;
    } finally {
      startingRef.current = false;
    }
    let utt: Utterance;
    try {
      utt = mic.listen({
        onLevel: setInLevel,
        onSpeech: () => setHeard(true),
        maxMs: (info?.max_seconds ?? 60) * 1000,
        noSpeechMs: liveOn() ? 12000 : 8000,
      });
    } catch (err) {
      closeMic();
      setProblem(describe(err));
      setPhaseBoth("idle");
      return;
    }
    uttRef.current = utt;
    setPhaseBoth("listening");
    let result;
    try {
      result = await utt.done;
    } catch (err) {
      uttRef.current = null;
      if (phaseRef.current === "listening") setPhaseBoth("idle");
      if (err instanceof DOMException && err.name === "AbortError") {
        if (!liveOn()) closeMic();
        return;
      }
      const fatal = err instanceof MicError && ["dead", "muted", "ended", "busy"].includes(err.kind);
      if (fatal || !liveOn()) closeMic();
      // Live: eine stille Runde hört still erneut zu, erst nach drei Runden kommt der Hinweis.
      if (!fatal && liveOn() && err instanceof MicError && err.kind === "no-speech" && ++missesRef.current < 3) {
        window.setTimeout(() => { if (liveOn() && phaseRef.current === "idle") void listenRef.current(); }, 200);
        return;
      }
      missesRef.current = 0;
      setProblem(describe(err));
      return;
    }
    uttRef.current = null;
    if (!liveOn()) closeMic();
    if (result.outcome === "stopped" && !result.heard) {
      setPhaseBoth("idle");
      setProblem(describe(new MicError("no-speech", mic.label, result.loudestDb)));
      return;
    }
    setPhaseBoth("transcribing");
    try {
      const out = await transcribeUtterance(result, prefsRef.current.language);
      const text = out.text.trim();
      if (!text) {
        setPhaseBoth("idle");
        if (liveOn() && ++missesRef.current < 3) { void listenRef.current(); return; }
        setProblem(describe(emptyResultProblem(result, out)));
        return;
      }
      missesRef.current = 0;
      if (liveOn()) await ask(text);
      else { setPhaseBoth("idle"); startPreview(text); }
    } catch (err) {
      setPhaseBoth("idle");
      setProblem(describe(err));
    }
  }, [ask, audio, closeMic, info, openMic]);
  listenRef.current = listen;
  const askRef = useRef(ask);
  askRef.current = ask;
  const interruptRef = useRef(interrupt);
  interruptRef.current = interrupt;

  /** Mikrofon prüfen, ohne aufzunehmen: Pegel und Schwelle fünf Sekunden lang. */
  const testMic = async () => {
    if (testing || phaseRef.current !== "idle") return;
    setProblem(null);
    let mic: MicSession;
    try { mic = await openMic(); } catch (err) { setProblem(describe(err)); return; }
    setTesting(true);
    const gate = new SpeechGate({ noSpeechMs: 1e9, maxMs: 1e9 });
    const began = performance.now();
    let sawVoice = false;
    testRef.current = window.setInterval(() => {
      const t = performance.now() - began;
      const { rms, peak } = mic.sample();
      const ev = gate.push({ rms, peak, t });
      if (ev === "speech") sawVoice = true;
      setInLevel({ meter: meterValue(rms), threshold: meterValue(gate.state.threshold),
        db: Math.round(20 * Math.log10(Math.max(rms, 1e-7))) });
      if (ev === "dead" || t > 5000) {
        if (testRef.current !== null) window.clearInterval(testRef.current);
        testRef.current = null;
        setTesting(false);
        if (!liveOn()) closeMic();
        if (ev === "dead") setProblem(describe(new MicError("dead", mic.label)));
        else if (!sawVoice) setProblem(describe(new MicError("no-speech", mic.label, gate.loudestDb())));
        else setProblem({ kind: "ok", text: `„${mic.label}“ funktioniert (lauteste Stelle ${gate.loudestDb()} dB).` });
      }
    }, 50);
  };

  const chooseDevice = (id: string) => {
    saveMicId(id);
    setDeviceId(id);
    deviceRef.current = id;
    setProblem(null);
    uttRef.current?.cancel();
    uttRef.current = null;
    closeMic();
    if (phaseRef.current === "listening") setPhaseBoth("idle");
  };

  // Geräteliste füllen, sobald das Mikrofon schon erlaubt ist; auf Ein- und Ausstecken hören.
  useEffect(() => {
    listMics().then((list) => { if (list.some((d) => !/^Mikrofon \d+$/.test(d.label))) setDevices(list); })
      .catch(() => undefined);
    const onChange = () => { listMics().then(setDevices).catch(() => undefined); };
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
  }, []);

  // Live aus → Mikrofon frei, sobald nicht mehr zugehört wird.
  useEffect(() => {
    if (!(prefs.handsFree && !writeMode) && phaseRef.current !== "listening") closeMic();
  }, [prefs.handsFree, writeMode, closeMic]);

  /** Der eine Knopf: je nach Zustand zuhören, fertig sein oder unterbrechen. */
  const press = useCallback(async () => {
    const p = phaseRef.current;
    if (p === "listening") { uttRef.current?.stop(); return; }
    if (p === "transcribing") return;
    if (preview) { const text = preview.text; stopPreview(); void ask(text); return; }
    if (p === "thinking" || p === "speaking") {
      await interrupt();
      setPhaseBoth("idle");
      void listen();
      return;
    }
    void listen();
  }, [ask, interrupt, listen, preview]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc bricht Zuhören oder Vorschau ab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (phaseRef.current === "listening") { uttRef.current?.cancel(); e.preventDefault(); }
      else if (previewRef.current !== null) { stopPreview(); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leertaste = Knopf, solange kein Eingabefeld den Fokus hat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName))) return;
      e.preventDefault();
      void press();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  useEffect(() => () => {
    uttRef.current?.cancel();
    if (testRef.current !== null) window.clearInterval(testRef.current);
    if (previewRef.current !== null) window.clearInterval(previewRef.current);
    bargeRef.current?.();
    micRef.current?.close();
    playerRef.current?.stop();
    abortRef.current?.abort();
    void ctxRef.current?.close();
  }, []);

  const newConversation = async () => {
    await interrupt();
    uttRef.current?.cancel();
    stopPreview();
    setProblem(null);
    try { localStorage.removeItem(CHAT_KEY); } catch { /* egal */ }
    chatRef.current = null;
    setChatId(null);
    setChatTitle("");
    setWriteMode(false);
    setTurns([]);
    setError("");
    setPhaseBoth("idle");
  };

  const sendTyped = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = typed.trim();
    if (!text || phase === "listening" || phase === "transcribing") return;
    setTyped("");
    await interrupt();
    await ask(text);
  };

  const busy = phase !== "idle";
  const ring = 1 + (phase === "listening" ? inLevel.meter : level) * 0.35;
  const pickOther = !!problem && ["dead", "muted", "ended", "no-speech", "quiet", "not-found", "busy"].includes(problem.kind);
  const sttNote = info && !info.stt_available
    ? "Spracherkennung fehlt auf dem Server."
    : info && !info.stt_loaded ? `Spracherkennung (${info.stt_model}) lädt beim ersten Sprechen.` : "";

  return (
    <div className="voice-shell" data-phase={phase}>
      <header className="voice-head">
        <h1 className="voice-brand">
          <BotSmiley size={31} variant="brand" trackMouse thinking={phase === "thinking"} />
          <span>Gimel Voice</span>
        </h1>
        <div className="voice-head-actions">
          <a className="voice-link" href="/lab" target="_blank" rel="noopener">Agent Lab</a>
          <button type="button" className="voice-ghost" onClick={newConversation}>Neues Gespräch</button>
          <button type="button" className="voice-ghost" onClick={onLogout}>Abmelden<span className="voice-sr"> ({user.email})</span></button>
        </div>
      </header>

      <main className="voice-main">
        <div className="voice-log" ref={listRef} role="region" aria-label="Gesprächsverlauf" tabIndex={0}>
          {turns.length === 0 ? (
            <div className="voice-empty">
              <p>Fragen Sie den Gimel-Assistenten, zum Beispiel:</p>
              <ul>
                <li>„Wie viele Aufträge sind heute offen?“</li>
                <li>„Welche Station ist gerade frei?“</li>
                <li>„Was ist mit Auftrag … los?“</li>
              </ul>
              <p className="voice-small">Ihre Aufnahme wird auf diesem Rechner in Text
                umgewandelt und danach verworfen. Gespeichert wird nur der erkannte Text, als Chat im Agent Lab.
                Ihre Mikrofonwahl merkt sich dieser Browser.
                Frage und Antwort verarbeitet das eingestellte Sprachmodell
                {info?.llm_provider ? ` (${info.llm_provider})` : ""}.{" "}
                {info?.tts_backend === "edge"
                  ? "Zum Vorlesen geht der Antworttext an Microsoft (USA, ohne Vertrag mit FyreFly). Nur mit Testdaten verwenden."
                  : "Vorgelesen wird ohne Internetdienst."}</p>
            </div>
          ) : turns.map((t) => (
            <div key={t.id} className={`voice-turn voice-${t.role}`}>
              <div className="voice-who">{t.role === "user" ? "Sie" : "Gimel"}</div>
              <div className="voice-text" lang={prefs.language === "en" ? "en" : undefined}>
                {t.text || (t.live ? <span className="voice-dots"><span aria-hidden="true">…</span><span className="voice-sr">schreibt</span></span> : "")}
                {t.tools.length > 0 && (
                  <div className="voice-tools" aria-label="Benutzte Werkzeuge">{t.tools.map((n, i) => <span key={i}>{n}</span>)}</div>
                )}
                {t.error && <div className="voice-error-inline">{t.error}</div>}
              </div>
            </div>
          ))}
        </div>

        <div className="voice-controls">
          <div className="voice-status" role="status">
            <span className="voice-chip" aria-hidden="true">{PHASE_CHIP[phase]}</span>
            <span>{PHASE_TEXT[phase]}</span>
          </div>

          <button
            type="button"
            className="voice-mic"
            onClick={() => void press()}
            aria-disabled={phase === "transcribing"}
            aria-label={phase === "listening" ? "Aufnahme beenden"
              : phase === "speaking" || phase === "thinking" ? "Unterbrechen und sprechen" : "Sprechen"}
          >
            <span className="voice-mic-ring" style={{ transform: `scale(${ring.toFixed(3)})` }} aria-hidden="true" />
            <svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true">
              {phase === "speaking" || phase === "thinking" ? (
                <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
              ) : (
                <path fill="currentColor" d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15Zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.59a6 6 0 0 0 5-5.91Z" />
              )}
            </svg>
          </button>

          {(phase === "listening" || testing) && (
            <div className="voice-meter-row">
              <LevelMeter level={inLevel} label={testing ? "Mikrofontest" : "Eingangspegel"} />
              <div className="voice-small voice-center">
                {testing ? "Mikrofontest: bitte etwas sagen …"
                  : heard ? "Sprache erkannt — nach kurzer Pause geht es los (Knopf = sofort, Esc = abbrechen)"
                    : `Hört über „${deviceLabel || "Mikrofon"}“ zu. Der Strich zeigt, ab wann es als Sprache zählt.`}
              </div>
              {phase === "listening" && (
                <button type="button" className="voice-ghost" onClick={() => uttRef.current?.cancel()}>Abbrechen</button>
              )}
            </div>
          )}

          <div role="status" aria-live="polite" className="voice-preview-live">
          {preview && (
            <div className="voice-preview" onFocusCapture={pausePreview} onPointerDownCapture={pausePreview}>
              <div className="voice-preview-text">„{preview.text}“</div>
              {preview.paused
                ? <div className="voice-preview-paused">angehalten — senden, bearbeiten oder verwerfen</div>
                : (
                  <div className="voice-preview-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(0, Math.min(100, (preview.left / 2200) * 100))}%` }} />
                  </div>
                )}
              <div className="voice-preview-actions">
                <button type="button" className="voice-ghost is-primary"
                  onClick={() => { const t = preview.text; stopPreview(); void ask(t); }}>Jetzt senden</button>
                <button type="button" className="voice-ghost"
                  onClick={() => { setTyped(preview.text); stopPreview();
                    window.setTimeout(() => document.getElementById("voice-typed")?.focus(), 0); }}>Bearbeiten</button>
                <button type="button" className="voice-ghost" onClick={stopPreview}>Verwerfen</button>
              </div>
            </div>
          )}
          </div>

          {problem && (
            <div className={problem.kind === "ok" ? "voice-ok" : "voice-error"} role={problem.kind === "ok" ? "status" : "alert"}>
              <span>{problem.text}</span>
              <div className="voice-problem-actions">
                {pickOther && <DeviceSelect devices={devices} deviceId={deviceId} onChange={chooseDevice} compact />}
                {problem.kind !== "ok" && problem.kind !== "server-missing" && problem.kind !== "unsupported" && (
                  <button type="button" className="voice-ghost" onClick={() => void listen()}>Erneut versuchen</button>
                )}
                <button type="button" className="voice-ghost" onClick={() => setProblem(null)}>Schließen</button>
              </div>
            </div>
          )}
          {error && <div className="voice-error" role="alert">{error}</div>}
          {writeMode && <div className="voice-small voice-center">Dieses Gespräch darf ändern (Schreibzugriff im Agent Lab).
            Live ist deshalb aus.</div>}
          {sttNote && !error && <div className="voice-small voice-center">{sttNote}</div>}

          <form className="voice-type" onSubmit={sendTyped}>
            <label className="voice-sr" htmlFor="voice-typed">Frage tippen</label>
            <input id="voice-typed" value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder="… oder tippen und vorlesen lassen" autoComplete="off" />
            <button type="submit" className="voice-ghost" disabled={!typed.trim() || phase === "listening"}>Senden</button>
          </form>

          <div className="voice-prefs">
            <label title={writeMode ? "Aus, solange dieses Gespräch Schreibzugriff hat." : undefined}>
              <input type="checkbox" checked={prefs.handsFree && !writeMode} disabled={writeMode}
                onChange={(e) => setPrefs({ ...prefs, handsFree: e.target.checked })} />
              Live-Gespräch (Mikrofon bleibt offen; alles Gehörte, auch Gespräche in der Nähe, geht ohne Vorschau als Frage los; hineinsprechen unterbricht)
            </label>
            <div className="voice-device-row">
              {devices.length > 0
                ? <DeviceSelect devices={devices} deviceId={deviceId} onChange={chooseDevice} />
                : <span className="voice-small">Mikrofon: Systemvorgabe (Auswahl nach der ersten Freigabe)</span>}
              <button type="button" className="voice-ghost" onClick={() => void testMic()}
                disabled={testing || phase !== "idle"}>Mikrofon testen</button>
            </div>
            <label>
              Stimme
              <select value={prefs.voice || info?.default_voice || ""}
                onChange={(e) => setPrefs({ ...prefs, voice: e.target.value })}
                disabled={!info?.tts_available}>
                {(info?.voices ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                {!info?.tts_available && <option value="">lokale Browserstimme</option>}
              </select>
            </label>
            <label>
              Sprache
              <select value={prefs.language} onChange={(e) => setPrefs({ ...prefs, language: e.target.value })}>
                <option value="de">Deutsch</option>
                <option value="en">Englisch</option>
                <option value="auto">automatisch</option>
              </select>
            </label>
          </div>
          <div className="voice-small voice-center">
            {chatTitle ? <>Gespräch: {chatTitle}{chatId ? ` · im Agent Lab als Chat #${chatId}` : ""}</> : "Neues Gespräch"}
            {busy ? "" : " · Leertaste = Mikrofon"}
          </div>
        </div>
      </main>
    </div>
  );
}
