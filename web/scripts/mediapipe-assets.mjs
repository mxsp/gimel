#!/usr/bin/env node
/* MediaPipe für die Handführung bereitstellen.

   Zwei Dinge müssen im Portal-Verzeichnis liegen, damit die Kamera-Auswertung
   ohne Internet läuft:

   * `public/mediapipe/wasm/`  — die WASM-Laufzeit aus `@mediapipe/tasks-vision`
                                  (wird bei jedem Build/jeder Entwicklungsrunde neu
                                  kopiert, ist klein und gehört zum Paket),
   * `public/mediapipe/models/` — die beiden Modelldateien (~14 MB). Die werden
                                  **einmal** von storage.googleapis.com geladen
                                  (`npm run mediapipe:models`) und sind wie das
                                  Verzeichnis selbst nicht im Git.

   Aufruf:
     node scripts/mediapipe-assets.mjs            nur WASM kopieren
     node scripts/mediapipe-assets.mjs --models    WASM kopieren und Modelle laden

   `npm install` bringt das Paket; `prebuild`/`predev` rufen das Skript ohne
   `--models` auf, damit ein Build nie ungefragt ins Netz greift. */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const src = join(web, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const out = join(web, "public", "mediapipe");
const dir = join(out, "wasm");

const MODELS = [
  {
    name: "hand_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    bytes: 7_819_105,
  },
  {
    name: "pose_landmarker_lite.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    bytes: 5_777_746,
  },
];

const exists = async (path, minBytes = 1) => {
  try {
    const s = await stat(path);
    return s.size >= minBytes;
  } catch {
    return false;
  }
};

async function copyWasm() {
  let entries;
  try {
    entries = await readdir(src);
  } catch {
    console.error(`Kein MediaPipe-Paket gefunden (${src}). Zuerst: npm install`);
    process.exit(1);
  }
  await mkdir(dir, { recursive: true });
  for (const name of entries) {
    if (!/\.(js|wasm)$/.test(name)) continue;
    if (await exists(join(dir, name))) continue;
    await copyFile(join(src, name), join(dir, name));
  }
  console.log(`MediaPipe-WASM: ${dir}`);
}

async function fetchModels() {
  const models = join(out, "models");
  await mkdir(models, { recursive: true });
  for (const model of MODELS) {
    const target = join(models, model.name);
    if (await exists(target, model.bytes * 0.9)) {
      console.log(`vorhanden: ${model.name}`);
      continue;
    }
    process.stdout.write(`${model.name} laden … `);
    const res = await fetch(model.url);
    if (!res.ok || !res.body) {
      console.error(`fehlgeschlagen (HTTP ${res.status})`);
      process.exit(1);
    }
    await pipeline(res.body, createWriteStream(target));
    const s = await stat(target);
    if (s.size < model.bytes * 0.9) {
      console.error(`zu klein (${s.size} B) — bitte erneut versuchen`);
      process.exit(1);
    }
    console.log(`${(s.size / 1e6).toFixed(1)} MB`);
  }
}

await copyWasm();
if (process.argv.includes("--models")) await fetchModels();
else console.log("Modelle: noch nicht geladen — `npm run mediapipe:models` (einmal, ~14 MB).");
