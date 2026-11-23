// Himmel der 3D-Halle (Tag/Nacht) und Kartenausschnitt:
// node twin-sky.test.mjs ../gimel/twin/dist
// Prüft ohne Anwendung: feste Sternrichtungen und Wolken, keine Milchstraße,
// keinen Mond und keine Sonne, einen größeren OpenStreetMap-Ausschnitt in 3D;
// im Quelltext: Sterne in der Szene (drehen mit der Kamera, verdecken durch
// den Boden); im Browser: data-theme schaltet Nacht und Tag wirklich um.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const dist = process.argv[2] && !process.argv[2].includes("webapp") ? process.argv[2] : "../gimel/twin/dist";

// --- Reine Module: wiederholbare Punkte und Kartengröße --------------------
const out = await build({
  stdin: {
    contents: `export * from "./src/components/twin/skyPoints.ts";
      export { mapDetailFor, tileMetres } from "./src/sites.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const a = m.skyRandom(7), b = m.skyRandom(7);
for (let i = 0; i < 5; i++) {
  const v = a();
  assert.equal(v, b(), "gleicher Startwert, gleiche Folge");
  assert.ok(v >= 0 && v < 1, "Zufall in [0, 1)");
}
assert.notEqual(m.skyRandom(8)(), m.skyRandom(7)(), "anderer Startwert, anderes Bild");

const stars = m.starDome();
assert.ok(stars.length >= 400, "dichtes Sternenfeld");
assert.deepEqual(stars, m.starDome(), "Sterne wiederholbar");
assert.notDeepEqual(stars, m.starDome(8), "anderer Startwert verändert das Feld");
for (const s of stars) {
  // Nur die obere Halbkugel: unter dem Boden darf kein Stern hervorschauen.
  assert.ok(s.y > 0, "Stern über dem Horizont");
  assert.ok(Math.abs(Math.hypot(s.x, s.y, s.z) - 1) < 0.03, "Stern liegt auf der Einheitskugel");
  assert.ok(s.alpha > 0.2 && s.alpha <= 1, "Helligkeit");
}
assert.equal(m.starField, undefined, "keine Sterne mehr am Bildschirm");

const clouds = m.cloudField();
assert.equal(clouds.length, 4);
for (const c of clouds) {
  assert.ok(c.x >= 0 && c.x <= 100 && c.y >= 0 && c.y <= 78, "Wolke auf der Bühne");
  assert.ok(c.delay <= 0 && c.duration >= 70 && c.scale >= 0.7 && c.scale <= 1.5, "langsam und verteilt");
}

// Milchstraße, Mond und Sonne entfernt: keine Reste im Modul.
for (const gone of ["milkyWay", "bandPuffs", "starField", "moon", "sun"]) {
  assert.equal(m[gone], undefined, `kein Rest von ${gone} im Himmel-Modul`);
}

// Mehr OpenStreetMap in 3D: nah fein, in der Ferne deutlich mehr Fläche —
// aber nie so viele Kacheln, dass der Kartendienst über Gebühr belastet wird.
const near = m.mapDetailFor(200, 51.75);
const far = m.mapDetailFor(8000, 51.75);
const area = (d) => (2 * d.span + 1) * m.tileMetres(51.75, d.z);
assert.ok(near.z >= 18, `nah bleibt die Karte fein (z=${near.z})`);
assert.ok(near.span >= 4, "auch nah sind mindestens vier Ringe zu sehen");
assert.ok(far.z <= 13, `weit draußen gröbere Kacheln (z=${far.z})`);
assert.ok(area(far) > area(near) * 10, "in der Ferne deutlich mehr Kartenfläche");
assert.ok(area(far) > 15000, "die Karte reicht über 15 km weit");
for (const want of [120, 300, 700, 1500, 3000, 6000, 12000]) {
  const d = m.mapDetailFor(want, 51.75);
  assert.ok((2 * d.span + 1) ** 2 <= 441, `Kacheln bei ${want} m im Rahmen (${d.span} Ringe)`);
  assert.ok(d.span >= 4 && d.span <= 12, "Ringe innerhalb der Grenzen");
}
assert.deepEqual(m.mapDetailFor(8000, 51.75), m.mapDetailFor(100000, 51.75), "nach oben gekappt");

// --- Quelltext: Sterne in der Szene, Böden deckend ------------------------
const src = await readFile("src/components/twin/ThreeFloorPlan.tsx", "utf8");
const stage = src.indexOf('className="floor-stage iso-stage three-stage"');
const skyTag = src.indexOf("<TwinSky", stage);
const hud = src.indexOf('className="iso-hud three-hud"', stage);
assert.ok(stage >= 0 && skyTag > stage && skyTag < hud, "Himmel als erstes Kind der Bühne");
// Twin Studio zeigt den Tageshimmel ohne Wolken (Portal behält sie).
const studioSrc = await readFile("src/studio/Studio.tsx", "utf8");
assert.match(studioSrc, /<ThreeFloorPlan[\s\S]{0,200}clouds=\{false\}/, "Twin Studio ohne Wolken");
assert.ok(src.includes("mapDetailFor(want, map.lat)"), "3D nutzt den größeren Kartenausschnitt");
// Die Sterne sind echte Punkte in der Szene, keine CSS-Fläche: nur so drehen
// sie mit der Kamera und verschwinden hinter Boden und Halle.
assert.ok(src.includes("starDome()"), "Szene baut den Sternenhimmel");
assert.ok(src.includes("starSky.position.copy(camera.position)"), "Sterne folgen dem Kamerastandpunkt");
assert.ok(/renderOrder = -1000/.test(src), "Sterne liegen hinter allen durchsichtigen Flächen");
assert.ok(/name = "hall-stars"/.test(src), "Sternenhimmel ist auffindbar");
assert.ok(/depthTest: true/.test(src), "Sterne werden von Geometrie verdeckt");
// Der Boden (Hof und Karte) schreibt Tiefe und ist deckend: sonst schiene der
// Nachthimmel durch die Karte.
assert.ok(/--g-floor-apron[\s\S]{0,220}depthWrite: true/.test(src), "Hof deckend");
assert.ok(/--g-map-tint[\s\S]{0,220}depthWrite: true/.test(src), "Karte deckend");
assert.ok(!src.includes("opacity: 0.6,") && !src.includes("opacity: 0.92"), "keine halbdurchsichtigen Böden mehr");

// --- Gebaute Anwendung: CSS, JSX und Einhängepunkt -------------------------
const assets = join(dist, "assets");
const files = await readdir(assets);
const read = (ends) => Promise.all(files.filter((f) => f.endsWith(ends))
  .map((f) => readFile(join(assets, f), "utf8")));
const css = (await read(".css")).join("\n");
const js = (await read(".js")).join("\n");

for (const name of ["twin-sky-night", "twin-sky-day", "twin-sky-cloud"]) {
  assert.ok(css.includes(`.${name}`), `CSS-Regel .${name}`);
  assert.ok(js.includes(name), `Komponente rendert ${name}`);
}
for (const gone of [
  "twin-sky-sun", "twin-sky-moon", "twin-sky-dot", "twin-sky-milkyway",
  "twin-sky-puff", "twin-sky-dot-band",
]) {
  assert.ok(!css.includes(gone) && !js.includes(gone), `Himmelskörper entfernt: ${gone}`);
}
assert.match(css, /\[data-theme=["']?dark["']?\][^{]*\.twin-sky-night/, "Nacht bei dark");
assert.match(css, /\[data-theme=["']?dark["']?\][^{]*\.twin-sky-day/, "Tag aus bei dark");
assert.match(css, /\[data-theme=["']?light["']?\][^{]*\.twin-sky-night/, "Nacht aus bei light");
assert.ok(css.includes("#3f86cf") && css.includes("#04060e"), "blauer Tag und dunkle Nacht");
assert.ok(css.includes("prefers-reduced-motion"), "Bewegung abschaltbar");
assert.ok(css.includes('[data-tier="schwach"]') || css.includes("[data-tier=schwach]"),
  "schwache Geräte ohne Animation");
assert.ok(js.includes("hall-stars"), "gebaute Szene enthält den Sternenhimmel");

// --- Browser: schaltet data-theme wirklich um? ----------------------------
// Das echte Sky.tsx wird gebündelt und mit der gebauten CSS in eine leere
// Seite gehängt; so stehen dieselbe Komponente und dieselben Regeln wie im
// Portal im Test. Reduzierte Bewegung nimmt die Übergangszeit heraus.
const bundle = await build({
  stdin: {
    contents: `import React from "react";
      import { createRoot } from "react-dom/client";
      import Sky from "./src/components/twin/Sky.tsx";
      createRoot(document.getElementById("root")).render(React.createElement(Sky));`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".css": "empty" }, write: false, logLevel: "silent",
});
// Ohne outdir schreibt esbuild nach <stdout>; das CSS ist durch den leeren
// Loader ohnehin nicht im Ergebnis, also ist die erste Datei das Skript.
const skyJs = bundle.outputFiles[0].text;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 600 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
  await page.addStyleTag({ content: css });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.addScriptTag({ content: skyJs });
  await page.waitForSelector(".twin-sky-cloud");

  const probe = () => page.evaluate(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      day: +cs(".twin-sky-day").opacity,
      night: +cs(".twin-sky-night").opacity,
      clouds: document.querySelectorAll(".twin-sky-cloud").length,
      stars: document.querySelectorAll(".twin-sky-dot, .twin-sky-moon, .twin-sky-sun").length,
      body: document.querySelectorAll(".twin-sky-night > *, .twin-sky-day > .twin-sky-sun").length,
      pointer: cs(".twin-sky").pointerEvents,
      z: cs(".twin-sky").zIndex,
    };
  });

  const light = await probe();
  assert.equal(light.day, 1, "hell: blauer Tag sichtbar");
  assert.equal(light.night, 0, "hell: Nacht verborgen");
  assert.equal(light.clouds, 4, "vier leichte Wolken");
  assert.equal(light.stars, 0, "keine Sterne, kein Mond, keine Sonne im DOM");
  assert.equal(light.body, 0, "die Nachtfläche bleibt leer");
  assert.equal(light.pointer, "none", "Himmel fängt keine Zeigerereignisse");
  assert.equal(light.z, "0", "Himmel hinter dem Canvas");

  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  const dark = await probe();
  assert.equal(dark.day, 0, "dunkel: Tag verborgen");
  assert.equal(dark.night, 1, "dunkel: Sternenhimmel sichtbar");
  assert.deepEqual(errors, [], "keine Fehler beim Umschalten");
  await context.close();
} finally {
  await browser.close();
}

console.log("Twin sky checks passed: no sun/moon/milky way, stars in the scene (camera-following, occluded by ground), wider OSM map, dark night and light day.");
