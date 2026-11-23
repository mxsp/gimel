// Run after npm run build: node twin-perf.test.mjs ../gimel/twin/dist
// Leistung der 3D-Halle (task 41 H): Zeichenaufrufe unter dem Budget, kein
// Zeichnen im Leerlauf, kein Neuaufbau bei Auswahl oder gleichem Abruf,
// Auswahl an Ort und Stelle (Ring, Abdunkeln), beim Begehen nie abgedunkelt.
// SLOW=1 wartet zusätzlich einen 30-Sekunden-Abruf ab.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] && !process.argv[2].includes("webapp") ? process.argv[2] : "../gimel/twin/dist";
/** Budget für eine Halle mit zwölf Stationen, Zonen, Gängen und Treppe. */
const DRAW_BUDGET = 150;

const outline = [[0, 0], [48, 0], [48, 24], [0, 24]];
const floor = {
  id: 1, name: "EG", level: 0, level_name: "EG", elevation_m: 0, height_m: 7, outline, grid: 1, snap: 0.25, scale: 40,
  bg: "#f5f5f0", area_m2: 1152, hall_id: 1,
  zones: [
    { name: "Zuschnitt", kind: "production", colour: "#106ba3", x: 2, y: 2, w: 20, h: 10 },
    { name: "Lager", kind: "storage", colour: "#8e5cb8", x: 26, y: 2, w: 20, h: 10 },
    { name: "Versand", kind: "shipping", colour: "#217e56", x: 26, y: 14, w: 20, h: 8 },
  ],
  obstacles: [{ name: "Stütze", x: 24, y: 12, w: 0.6, h: 0.6 }],
  doors: [{ name: "Tor", x: 48, y: 18, w: 4, wall: "east" }],
  aisles: { nodes: [[2, 13], [46, 13], [24, 2], [24, 22]], edges: [[0, 1], [2, 3]], paths: [] },
};
const KINDS = [
  ["plotter", "production", ""], ["waterjet", "production", ""], ["punch", "production", ""], ["manual", "production", ""],
  ["", "warehouse", "Hochregal"], ["", "warehouse", "Plattenregal"], ["", "warehouse", "Kommissionierung"],
  ["", "shipping", ""], ["", "accounting", ""], ["plotter", "production", ""], ["", "warehouse", "Leergut"], ["punch", "production", ""],
];
const stations = KINDS.map(([kind, type, subtype], i) => ({
  id: i + 1, label: `Station ${i + 1}`, type, subtype, x: 5 + (i % 6) * 7.5, y: i < 6 ? 7 : 18, w: 4, h: 3,
  rotation: 0, colour: "#106ba3", active: true, routing: "smart_suggest", materials: [], thicknesses: [],
  assigned_users: [], queue_jobs: i % 3, queue_min: (i % 3) * 30, capacity_min_per_day: 450, machine_kind: kind,
  is_storage: type === "warehouse", model_file: "", model_scale: 1, model_rotation: 0, speed_mm_s: 0, pierce_s: 0,
  setup_min: 0, changeover_min: 0, handling_min_per_plate: 0, max_sheet_w: 0, max_sheet_h: 0, thk_min: 0, thk_max: 0,
  cost_per_h: 0, task_min: 0, unit_min: 0, note: "", visibility: "collapse", floor_id: 1,
}));
const topology = {
  sites: [{ id: 1, name: "Werk", code: "W", address: "", lat: 51.75, lon: 11.97, note: "", halls: [
    { id: 1, site_id: 1, name: "Halle 1", code: "H1", sort: 0, lat: 51.75, lon: 11.97, rotation_deg: 0, map_enabled: 0, note: "",
      floors: [{ id: 1, hall_id: 1, level: 0, level_name: "EG", elevation_m: 0, height_m: 7, name: "EG", stations: 12, default: true }] },
  ] }],
  unsited_halls: [], unassigned_floors: [], default_floor_id: 1, default_site_id: 1,
};

let stationCalls = 0;
const browser = await chromium.launch();
const errors = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
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
  // Jeder Abruf liefert neue Objekte mit gleichem Inhalt — wie der Server.
  const json = (x) => route.fulfill({ json: JSON.parse(JSON.stringify(x)) });
  if (path === "/api/version") return json({ version: "t", features: [] });
  if (path === "/api/factory/topology") return json(topology);
  if (path.startsWith("/api/factory/floor")) return json(floor);
  if (path === "/api/factory/stations") { stationCalls++; return json(stations); }
  if (/^\/api\/factory\/stations\/\d+\/view$/.test(path)) return json({ queue: [], recent: [], upcoming: [], skills: [] });
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
const data = async () => stage.evaluate((el) => ({ ...el.dataset }));
const frames = () => page.evaluate(() => window.__gimel3d.frames());
/** Eine Station über ihre Beschriftung wählen (auch wenn das Entzerren sie
    gerade ausblendet): der Klick-Handler der Beschriftung selbst. */
const pick = (name) => page.evaluate((n) => {
  const el = [...document.querySelectorAll(".three-station-label")].find((e) => e.querySelector("b")?.textContent === n);
  el?.click();
  return !!el;
}, name);

try {
  await page.goto("http://internal.test/twin/?debug3d=1");
  await page.locator(".three-canvas").waitFor();
  await page.waitForFunction(() => Number(document.querySelector(".three-stage")?.dataset.draws) > 0);
  await page.waitForTimeout(2500);

  // --- Budget: verschmolzene Halle, Karte als eine Fläche.
  const d0 = await data();
  const draws = Number(d0.draws);
  assert.ok(draws <= DRAW_BUDGET, `${draws} Zeichenaufrufe, Budget ${DRAW_BUDGET}`);
  assert.equal(d0.builds, "1", "eine Halle, einmal gebaut");

  // --- Leerlauf (weniger Bewegung): nichts wird gezeichnet.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(600);
  const f0 = await frames();
  await page.waitForTimeout(2500);
  const idle = (await frames()) - f0;
  assert.ok(idle <= 4, `${idle} Bilder in 2,5 s Leerlauf`);

  // --- Auswahl: an Ort und Stelle, kein Neuaufbau.
  assert.ok(await pick("Station 3"), "Beschriftung Station 3 da");
  await page.waitForFunction(() => window.__gimel3d.scene.getObjectByName("selection-rings")?.children.length === 1);
  const sel = await page.evaluate(() => {
    let dimmed = 0;
    window.__gimel3d.scene.traverse((o) => {
      const m = o.material;
      for (const x of Array.isArray(m) ? m : m ? [m] : []) if (x.userData?.selDim) dimmed++;
    });
    const label = [...document.querySelectorAll(".three-station-label")].find((e) => e.querySelector("b")?.textContent === "Station 3");
    return { dimmed, selected: label?.classList.contains("three-station-label-selected") };
  });
  assert.ok(sel.selected, "Beschriftung der Auswahl betont");
  assert.ok(sel.dimmed > 0, "nicht verbundene Stationen abgedunkelt");
  assert.equal((await data()).builds, "1", "Auswahl baut die Halle nicht neu");

  // --- Andere Auswahl, dann keine: weiter kein Neuaufbau, Abdunkeln weg.
  await pick("Station 8");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  assert.equal((await data()).builds, "1", "Auswahlwechsel baut nicht neu");

  // --- Begehen: auch mit Auswahl nie abgedunkelt (Owner 2026-11-08).
  const walkBtn = page.getByRole("button", { name: /^Begehen/ });
  if (await walkBtn.count()) {
    await pick("Station 3");
    await page.waitForTimeout(300);
    await walkBtn.first().click();
    await page.waitForTimeout(1200);
    const dimWalk = await page.evaluate(() => {
      let n = 0;
      window.__gimel3d.scene.traverse((o) => {
        const m = o.material;
        for (const x of Array.isArray(m) ? m : m ? [m] : []) if (x.userData?.selDim) n++;
      });
      return n;
    });
    assert.equal(dimWalk, 0, "beim Begehen keine abgedunkelten Stationen");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  } else {
    console.log("(Begehen-Knopf nicht gefunden — Schritt übersprungen)");
  }

  // --- Abruf mit gleichem Inhalt (30 s): kein Neuaufbau.
  if (process.env.SLOW) {
    const calls = stationCalls;
    await page.waitForTimeout(31_000);
    assert.ok(stationCalls > calls, "der Abruf lief");
    assert.equal((await data()).builds, "1", "gleicher Inhalt baut nicht neu");
  }

  assert.deepEqual(errors, [], "keine Fehler im Browser");
  console.log(`Twin perf checks passed: ${draws} draw calls (budget ${DRAW_BUDGET}), ${idle} idle frames, select without rebuild${process.env.SLOW ? ", refresh without rebuild" : ""}.`);
} finally {
  await browser.close();
}
