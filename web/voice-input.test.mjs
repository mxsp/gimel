// Spracheingabe: das Tor im Browser (task 43). Reine Rechnung, synthetische Signale.
// node voice-input.test.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * from "../agentlab/web/src/voiceInput/gate.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
  nodePaths: [process.cwd() + "/node_modules"],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const SR = 48000;
const BLOCK = 1024;
const STEP_MS = 50;

// Gesäter Zufall, damit der Test immer gleich rechnet.
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s / Math.sqrt(0.5); };

/** Silben: 180 ms Ton mit Obertönen, 70 ms Pause, `n` Silben; Pegel als RMS in dBFS. */
function speech(db, n = 14) {
  const amp = m.dbToLin(db) * Math.SQRT2;
  const out = [];
  for (let s = 0; s < n; s++) {
    const f = 140 + (s % 4) * 25;
    for (let i = 0; i < SR * 0.18; i++) {
      const t = i / SR;
      const env = Math.sin(Math.PI * i / (SR * 0.18));
      out.push(amp * env * (0.7 * Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * 3 * f * t)) * 1.25);
    }
    for (let i = 0; i < SR * 0.07; i++) out.push(0);
  }
  return out;
}
const silence = (s) => new Array(Math.round(SR * s)).fill(0);
const withNoise = (sig, db) => { const a = m.dbToLin(db); return sig.map((v) => v + a * gauss()); };

/** Signal blockweise wie im Browser (alle 50 ms ein 1024er-Fenster) durch das Tor. */
function run(sig, opts = {}) {
  const gate = new m.SpeechGate(opts);
  const events = [];
  for (let t = 0; ; t += STEP_MS) {
    const i = Math.round(t / 1000 * SR);
    if (i + BLOCK > sig.length) break;
    const block = sig.slice(i, i + BLOCK);
    const ev = gate.push({ rms: m.rmsOf(block), peak: m.peakOf(block), t });
    if (ev !== "none") {
      events.push([ev, t]);
      if (ev !== "speech") break;
    }
  }
  return { gate, events, last: events.at(-1)?.[0] ?? "none" };
}

const ROOM = -63; // gemessenes Raumrauschen am Webcam-Eingang (2026-11-08)

// 1. Ein Eingang ohne Mikrofon liefert exakt 0 → eigener Fall, nach 1,5 s.
{
  const r = run(silence(10));
  assert.equal(r.last, "dead");
  assert.ok(r.events[0][1] >= 1500 && r.events[0][1] <= 1700, `dead nach ${r.events[0][1]} ms`);
  assert.match(m.problemText("dead", "USB Audio Analog Stereo"), /„USB Audio Analog Stereo“ liefert kein Signal/);
}

// 2. Normale und leise Sprache werden gehört — auch −50 dBFS (alte Grenze −38 dBFS verwarf ab ≈ −42).
for (const db of [-20, -30, -40, -45, -50]) {
  const sig = withNoise([...silence(0.6), ...speech(db), ...silence(2.5)], ROOM);
  const r = run(sig);
  assert.equal(r.events[0]?.[0], "speech", `${db} dBFS: ${JSON.stringify(r.events)}`);
  assert.equal(r.last, "end", `${db} dBFS endet nicht: ${JSON.stringify(r.events)}`);
}

// 3. Sehr leise Sprache (−58 dBFS) liegt unter der Schwelle, aber über dem Rauschen:
//    kein stilles Veto, sondern "maybe" → der Server entscheidet.
{
  const sig = withNoise([...silence(0.6), ...speech(-58, 40), ...silence(9)], -75);
  const r = run(sig, { noSpeechMs: 8000 });
  assert.ok(["maybe", "end"].includes(r.last), `−58 dBFS: ${JSON.stringify(r.events)}`);
}

// 4. Nur Raumrauschen → "no-speech" nach noSpeechMs, kein "speech".
{
  const r = run(withNoise(silence(10), ROOM), { noSpeechMs: 6000 });
  assert.equal(r.last, "no-speech", JSON.stringify(r.events));
}

// 5. Wer schon beim Drücken spricht, verschiebt die Schwelle nicht dauerhaft:
//    das Rauschen fällt in den Silbenpausen schnell auf den Raum zurück.
{
  const sig = withNoise([...speech(-30), ...silence(2.5)], ROOM);
  const r = run(sig);
  assert.equal(r.events[0]?.[0], "speech", JSON.stringify(r.events));
  assert.equal(r.last, "end");
  assert.ok(m.linToDb(r.gate.state.noise) < -50, `Rauschen ${m.linToDb(r.gate.state.noise).toFixed(1)} dB`);
}

// 6. Silbenpausen beenden die Äußerung nicht vorzeitig: Ende frühestens nach der letzten Silbe + Stille.
{
  const sig = withNoise([...silence(0.5), ...speech(-35, 20), ...silence(3)], ROOM);
  const r = run(sig, { silenceMs: 1200 });
  const endT = r.events.find(([e]) => e === "end")?.[1] ?? 0;
  const speechEnd = (0.5 + 20 * 0.25) * 1000;
  assert.ok(endT >= speechEnd + 1000, `Ende ${endT} ms vor Sprachende ${speechEnd} ms`);
}

// 7. Eigene Stimme beim Vorlesen hebt die Schwelle (bias): leises Echo löst nichts aus,
//    lautes Hineinsprechen schon.
{
  const echo = withNoise([...silence(0.4), ...speech(-42), ...silence(1)], ROOM);
  const gate = new m.SpeechGate({ noSpeechMs: 60000 });
  let heard = false;
  for (let t = 0; ; t += STEP_MS) {
    const i = Math.round(t / 1000 * SR);
    if (i + BLOCK > echo.length) break;
    const b = echo.slice(i, i + BLOCK);
    if (gate.push({ rms: m.rmsOf(b), peak: m.peakOf(b), t, bias: m.dbToLin(-36) }) === "speech") heard = true;
  }
  assert.equal(heard, false, "Echo unter dem Vorlese-Zuschlag darf nicht unterbrechen");
  const loud = withNoise([...silence(0.4), ...speech(-24)], ROOM);
  const g2 = new m.SpeechGate({ noSpeechMs: 60000 });
  let heard2 = false;
  for (let t = 0; ; t += STEP_MS) {
    const i = Math.round(t / 1000 * SR);
    if (i + BLOCK > loud.length) break;
    const b = loud.slice(i, i + BLOCK);
    if (g2.push({ rms: m.rmsOf(b), peak: m.peakOf(b), t, bias: m.dbToLin(-36) }) === "speech") heard2 = true;
  }
  assert.equal(heard2, true, "lautes Hineinsprechen muss unterbrechen");
}

// 8. Pegelanzeige, Leise-Erkennung, Fehlerzuordnung.
assert.equal(m.meterValue(0), 0);
assert.ok(m.meterValue(m.dbToLin(-40)) > 0.4 && m.meterValue(m.dbToLin(-40)) < 0.6);
assert.equal(m.meterValue(1), 1);
{
  const r = run(withNoise([...silence(0.5), ...speech(-50), ...silence(2)], -75));
  assert.ok(r.gate.quiet(), `−50 dBFS sollte als leise gelten (${r.gate.loudestDb()} dB)`);
  const r2 = run(withNoise([...silence(0.5), ...speech(-25), ...silence(2)], ROOM));
  assert.ok(!r2.gate.quiet());
}
assert.equal(m.problemFromError("NotAllowedError"), "denied");
assert.equal(m.problemFromError("NotReadableError"), "busy");
assert.equal(m.problemFromError("OverconstrainedError"), "not-found");
for (const k of ["dead", "muted", "ended", "no-speech", "quiet", "not-understood", "denied", "not-found",
  "busy", "insecure", "unsupported", "server-missing"]) {
  assert.ok(m.problemText(k, "Webcam", -52).length > 20, k);
}

console.log("voice-input: ok");
