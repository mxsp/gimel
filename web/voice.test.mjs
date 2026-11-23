// Sprache im Assistenten: reine Textteile ohne Browser (task: Diktat/Vorlesen).
// node voice.test.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export { maskForSpeech, cleanForSpeech, speechCut } from "../agentlab/web/src/voice.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
  nodePaths: [process.cwd() + "/node_modules"],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

// Codeblöcke werden stillgelegt, ohne die Länge zu verschieben.
const withCode = "Vorher\n```js\nconst x = 1;\n```\nNachher";
const masked = m.maskForSpeech(withCode);
assert.equal(masked.length, withCode.length);
assert.ok(masked.includes("Vorher"));
assert.ok(masked.includes("Nachher"));
assert.ok(!masked.includes("const x"));
assert.ok(!masked.includes("```"));

// Adressen werden nicht Buchstabe für Buchstabe vorgelesen.
const withUrl = "Siehe https://example.com/sehr/langer/pfad und mehr";
const urlMasked = m.maskForSpeech(withUrl);
assert.equal(urlMasked.length, withUrl.length);
assert.ok(!urlMasked.includes("example.com"));
assert.ok(urlMasked.includes("und mehr"));

// Markdown-Gerümpel fällt weg, der Inhalt bleibt.
assert.equal(m.cleanForSpeech("**Fett** und _kursiv_ mit `code`"), "Fett und kursiv mit code");
assert.equal(m.cleanForSpeech("[Link](https://example.com) danach"), "Link danach");
assert.equal(m.cleanForSpeech("# Überschrift\n- Punkt eins\n1. Punkt zwei"), "Überschrift Punkt eins Punkt zwei");
assert.equal(m.cleanForSpeech("| a | b |\n| --- | --- |"), "a , b");

// Kurze Sätze bleiben im Puffer, bis genug Text da ist.
assert.equal(m.speechCut("Hallo."), 0);
assert.equal(m.speechCut("Das ist ein ausreichend langer Satz. Noch mehr"), 36);
assert.equal(m.speechCut("Erste Zeile\nZweite Zeile"), 0);
assert.equal(m.speechCut("Kein Punkt aber genug Text, der weiterläuft"), 0);
assert.ok(m.speechCut("wort ".repeat(80)) <= 220);
assert.equal(m.speechCut("Am Ende ohne Punkt", true), 18);

console.log("voice: ok");
