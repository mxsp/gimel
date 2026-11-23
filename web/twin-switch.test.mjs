// Run after npm run build: node twin-switch.test.mjs ../gimel/twin/dist
// Wechsel zwischen Ebenen und Hallen in 3D (task 40): der Stapel und die
// Nachbarhallen bleiben, die Kamera bleibt in der Welt stehen, das Begehen
// landet nach einem Wechsel nie in einer Maschine.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] && !process.argv[2].includes("webapp") ? process.argv[2] : "../gimel/twin/dist";
const outline = [[0, 0], [30, 0], [30, 16], [0, 16]];
const LEVELS = { 1: [1, 0, "EG"], 2: [1, 1, "1. OG"], 3: [2, 0, "EG"], 4: [2, 1, "1. OG"] };
const floor = (id) => {
  const [hall, level, name] = LEVELS[id];
  return {
    id, name: `H${hall} ${name}`, level, level_name: name, elevation_m: level * 6.8, height_m: 6,
    outline, grid: 1, snap: 0.25, scale: 40, bg: "#f5f5f0", area_m2: 480, hall_id: hall,
    zones: [], obstacles: [], doors: [], aisles: { nodes: [], edges: [], paths: [] },
  };
};
const station = (id, label, fid, x, y, w = 4, h = 3) => ({
  id, label, type: "production", subtype: "", x, y, w, h,
  rotation: 0, colour: "#106ba3", active: true, routing: "smart_suggest",
  materials: [], thicknesses: [], assigned_users: [], queue_jobs: 0, queue_min: 0,
  capacity_min_per_day: 450, machine_kind: "plotter", is_storage: false,
  model_file: "", model_scale: 1, model_rotation: 0, speed_mm_s: 0, pierce_s: 0,
  setup_min: 0, changeover_min: 0, handling_min_per_plate: 0, max_sheet_w: 0,
  max_sheet_h: 0, thk_min: 0, thk_max: 0, cost_per_h: 0, task_min: 0, unit_min: 0,
  note: "", visibility: "collapse", floor_id: fid,
});
// Halle 2 · 1. OG: ein großes Gerät genau in der Hallenmitte — dort, wo man im
// EG darunter steht. Wer nach dem Wechsel dort bliebe, stünde in der Maschine.
const BIG = { x: 15, y: 8, w: 10, h: 8 };
const stations = [
  station(1, "Plotter H1", 1, 6, 4), station(2, "Regal H1 OG", 2, 24, 12),
  station(3, "Stanze H2", 3, 6, 12), station(4, "Presse H2 OG", 4, BIG.x, BIG.y, BIG.w, BIG.h),
];
const lvl = (id) => ({ id, hall_id: LEVELS[id][0], level: LEVELS[id][1], level_name: LEVELS[id][2],
  elevation_m: LEVELS[id][1] * 6.8, height_m: 6, name: LEVELS[id][2], stations: 1, default: id === 1 });
const topology = {
  sites: [{ id: 1, name: "Werk", code: "W", address: "", lat: 51.48, lon: 12.0, note: "", halls: [
    { id: 1, site_id: 1, name: "Halle 1", code: "H1", sort: 0, lat: 51.48, lon: 12.0, rotation_deg: 0,
      map_enabled: 0, note: "", floors: [lvl(1), lvl(2)] },
    // ≈ 42 m östlich
    { id: 2, site_id: 1, name: "Halle 2", code: "H2", sort: 1, lat: 51.48, lon: 12.0006, rotation_deg: 0,
      map_enabled: 0, note: "", floors: [lvl(3), lvl(4)] },
  ] }],
  unsited_halls: [], unassigned_floors: [], default_floor_id: 1, default_site_id: 1,
};

const browser = await chromium.launch();
const errors = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("503")) errors.push(m.text()); });
await page.addInitScript(() => {
  localStorage.setItem("gimel-token", "test-token");
  localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
  localStorage.setItem("gimel-plan-view", "three");
  localStorage.setItem("gimel-floor", "1");
});
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  const json = (x) => route.fulfill({ json: x });
  if (path === "/api/version") return json({ version: "t", features: [] });
  if (path === "/api/factory/topology") return json(topology);
  if (path.startsWith("/api/factory/floor")) return json(floor(Number(url.searchParams.get("floor_id") || 1)));
  if (path === "/api/factory/stations") return json(stations);
  if (path === "/api/factory/flow") return json({ total_transport_m: 0, edges: [] });
  if (path === "/api/factory/worklist") return json({ kinds: {}, pool: [], auto_routing: false, policy: {}, stations: [] });
  if (path.startsWith("/api/factory/robots")) return json({ sampled_at: "2026-11-07T10:00:00+00:00", simulated: false, robots: [] });
  if (path.startsWith("/api/factory/robot-jobs")) return json({ jobs: [] });
  if (path === "/api/factory/twin/analysis") return json({ findings: [], loads: [], unassigned: 0, summary: {} });
  if (path === "/api/factory/plan") return json({ auto_routing: false, counts: {}, suggestions: [] });
  if (path === "/api/factory/handlers/plan") return json({ suggestions: [] });
  if (path.startsWith("/api/")) return json({ detail: "Test" });
  const f = path === "/twin/" || path === "/twin" ? "twin.html" : path.replace(/^\/twin\//, "");
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  try {
    await route.fulfill({ body: await readFile(resolve(dist, f)), contentType: mime[extname(f)] || "application/octet-stream" });
  } catch { await route.fulfill({ status: 404, body: "" }); }
});

const stage = page.locator(".three-stage");
const attr = (name) => stage.getAttribute(name);
/** Kamera nach dem Ende jeder Fahrt: zweimal gleich gelesen. */
async function settledCamera() {
  let last = "";
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(300);
    const now = await attr("data-camera");
    if (now && now === last) return now;
    last = now;
  }
  throw new Error(`Kamera kommt nicht zur Ruhe: ${last}`);
}
const nums = (cam) => cam.split(/[,>]/).map(Number);
const close = (a, b, eps, what) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps,
  `${what}: ${a.map((x) => x.toFixed(2))} vs ${b.map((x) => x.toFixed(2))}`));
/** SHOTS=<Ordner> legt Bilder der Schritte ab (zum Ansehen, nicht geprüft). */
const shot = (name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null);
const halls = async () => (await attr("data-halls")).split(";").filter(Boolean);

try {
  await page.goto("http://internal.test/twin/");
  await page.locator(".three-canvas").waitFor();
  // EG + 1. OG, dazu Halle 2 — nebenan mit denselben Stufen.
  await page.getByRole("button", { name: "Weitere Ebenen und Hallen auswählen" }).click();
  await page.getByRole("menuitem", { name: "1. OG · 1 Station" }).click();
  await page.getByRole("menuitem", { name: "Halle 2 · EG, 1. OG" }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => (document.querySelector(".three-stage")?.getAttribute("data-halls") ?? "").split(";").length === 2);
  const before = await halls();
  assert.deepEqual(before.map((h) => h.split("@")[0]).sort(), ["2/3", "2/4"], "Halle 2 mit EG und 1. OG");
  const [h2x, h2y] = before[0].split("@")[1].split(",").map(Number);
  assert.ok(h2x > 35 && h2x < 50 && Math.abs(h2y) < 2, `Halle 2 liegt östlich (${h2x}, ${h2y})`);
  assert.ok((await attr("data-levels")).startsWith("1. OG@"), "Stapel EG + 1. OG");
  const cam0 = nums(await settledCamera());
  await shot("1-halle1-eg-stapel");

  // --- Ebene wechseln: der Stapel bleibt, die Kamera bleibt stehen.
  await page.locator(".floor-switcher").getByRole("button", { name: "1. OG", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".three-stage")?.getAttribute("data-floor") === "2");
  assert.ok((await attr("data-levels")).startsWith("EG@"), "die verlassene Ebene bleibt im Stapel");
  assert.equal((await halls()).length, 2, "Halle 2 bleibt mit beiden Ebenen");
  const cam1 = nums(await settledCamera());
  await shot("2-halle1-og-gleicher-blick");
  close(cam1, cam0, 0.05, "Ebenenwechsel lässt die Kamera stehen");

  // --- Halle wechseln: dieselbe Welt, andere Achsen. Halle 1 steht jetzt westlich.
  await page.locator(".floor-switcher").getByLabel("Halle", { exact: true }).selectOption("2");
  await page.waitForFunction(() => ["3", "4"].includes(document.querySelector(".three-stage")?.getAttribute("data-floor") ?? ""));
  await page.waitForFunction(() => (document.querySelector(".three-stage")?.getAttribute("data-halls") ?? "").split(";").length === 2);
  const after = await halls();
  assert.deepEqual(after.map((h) => h.split("@")[0]).sort(), ["1/1", "1/2"], "Halle 1 bleibt sichtbar, beide Ebenen");
  const [h1x] = after[0].split("@")[1].split(",").map(Number);
  assert.ok(Math.abs(h1x + h2x) < 0.5, `Halle 1 steht spiegelbildlich (${h1x} vs ${h2x})`);
  assert.ok((await attr("data-levels")).length > 0, "der Stapel geht in die neue Halle mit");
  const cam2 = nums(await settledCamera());
  await shot("3-halle2-gleicher-blick");
  // Weltpunkt bleibt: in den neuen Achsen um die Hallenlage verschoben, Höhe gleich.
  const shifted = [cam1[0] - h2x, cam1[1], cam1[2] - h2y, cam1[3] - h2x, cam1[4], cam1[5] - h2y];
  close(cam2, shifted, 0.3, "Hallenwechsel ohne Sprung");

  // --- Begehen im EG, dann 1. OG über die Auswahl: nie in der Presse landen.
  await page.locator(".floor-switcher").getByRole("button", { name: "EG", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".three-stage")?.getAttribute("data-floor") === "3");
  await page.getByRole("button", { name: "Begehen", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector(".three-stage")?.getAttribute("data-camera") ?? "").startsWith("walk"));
  await page.locator(".floor-switcher").getByRole("button", { name: "1. OG", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector(".three-stage")?.getAttribute("data-camera") ?? "").endsWith("@4"));
  await page.waitForTimeout(400);
  const walkCam = await attr("data-camera");
  await shot("4-begehen-halle2-og");
  const [wx, wy] = walkCam.slice(5).split("@")[0].split(",").map(Number);
  const inBig = Math.abs(wx - BIG.x) < BIG.w / 2 && Math.abs(wy - BIG.y) < BIG.h / 2;
  assert.ok(!inBig, `nach dem Wechsel nicht in der Presse (${wx}, ${wy})`);
  assert.ok(wx > 0 && wx < 30 && wy > 0 && wy < 16, `auf dem Boden der Ebene (${wx}, ${wy})`);
  assert.match(await page.locator(".three-walk-level").innerText(), /Halle 2 · 1\. OG/, "Ort im Begehen");

  // --- Begehen beenden: der Blick schaut auf den Standpunkt, nicht in die alten Achsen.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !(document.querySelector(".three-stage")?.getAttribute("data-camera") ?? "walk").startsWith("walk"));
  const cam3 = nums(await settledCamera());
  assert.ok(Math.hypot(cam3[3] - wx, cam3[5] - wy) < 1, "Ziel liegt auf dem letzten Standpunkt");

  assert.deepEqual(errors, [], "keine Laufzeitfehler");
  console.log("twin-switch ok: Stapel und Hallen bleiben, Kamera ohne Sprung, Landung frei");
} finally {
  await browser.close();
}
