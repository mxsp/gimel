// Run after npm run build: node twin-ground.test.mjs ../gimel/twin/dist
// Nur das EG liegt auf dem Boden: mit aktivem KG steht die Halle darunter,
// und jede gewählte Ebene/Halle wird deckend statt angedeutet gezeichnet.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] && !process.argv[2].includes("webapp") ? process.argv[2] : "../gimel/twin/dist";
const outline = [[0, 0], [52, 0], [52, 24], [0, 24]];
const aisles = { nodes: [], edges: [], paths: [] };
const makeFloor = (id, name, level, elevation, height) => ({
  id, name, level, level_name: name, elevation_m: elevation, height_m: height,
  outline, grid: 1, snap: 0.25, scale: 40, bg: "#f5f5f0", area_m2: 1248, hall_id: 1,
  zones: [], obstacles: [], doors: [], aisles,
});
const kg = makeFloor(1, "KG", -1, -4, 4);
const eg = makeFloor(2, "EG", 0, 0, 6);
const eg2 = { ...makeFloor(3, "EG", 0, 0, 6), hall_id: 2, name: "Halle 2 EG" };
const topology = {
  sites: [{ id: 1, name: "Werk", code: "W", address: "", lat: 51.48, lon: 12.0, note: "",
    halls: [{ id: 1, site_id: 1, name: "Halle 1", code: "H1", sort: 0, lat: 51.48, lon: 12.0,
      rotation_deg: 0, map_enabled: 0, note: "", floors: [
        { id: 1, hall_id: 1, level: -1, level_name: "KG", elevation_m: -4, height_m: 4, name: "KG", stations: 0, default: true },
        { id: 2, hall_id: 1, level: 0, level_name: "EG", elevation_m: 0, height_m: 6, name: "EG", stations: 0, default: false },
      ] }, { id: 2, site_id: 1, name: "Halle 2", code: "H2", sort: 1, lat: 51.481, lon: 12.001,
      rotation_deg: 0, map_enabled: 0, note: "", floors: [
        { id: 3, hall_id: 2, level: 0, level_name: "EG", elevation_m: 0, height_m: 6, name: "EG", stations: 0, default: false },
      ] }] }],
  unsited_halls: [], unassigned_floors: [], default_floor_id: 1, default_site_id: 1,
};
const base = { subtype: "", w: 4, h: 3, rotation: 0, colour: "#0a5b9c", active: true,
  routing: "smart_suggest", materials: [], thicknesses: [], assigned_users: [], queue_jobs: 0,
  queue_min: 0, capacity_min_per_day: 450, machine_kind: "plotter", is_storage: false,
  model_file: "", model_scale: 1, model_rotation: 0, speed_mm_s: 0, pierce_s: 0, setup_min: 0,
  changeover_min: 0, handling_min_per_plate: 0, max_sheet_w: 0, max_sheet_h: 0, thk_min: 0,
  thk_max: 0, cost_per_h: 0, task_min: 0, unit_min: 0, note: "", visibility: "collapse" };
const stations = [{ ...base, id: 1, label: "Presse", type: "production", x: 12, y: 10, floor_id: 1 }];

const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (x) => { if (x.type() === "error" && !x.text().includes("503")) errors.push(x.text()); });
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
    if (path.startsWith("/api/factory/floor")) {
      const id = Number(url.searchParams.get("floor_id") || 1);
      return json(id === 2 ? eg : id === 3 ? eg2 : kg);
    }
    if (path === "/api/factory/stations") return json(stations);
    if (path === "/api/factory/flow") return json({ total_transport_m: 0, edges: [] });
    if (path === "/api/factory/worklist") return json({ kinds: {}, pool: [], auto_routing: false, policy: {}, stations: [] });
    if (path.startsWith("/api/factory/robots")) return json({ sampled_at: "2026-11-06T10:00:00+00:00", simulated: false, robots: [] });
    if (path.startsWith("/api/factory/robot-jobs")) return json({ jobs: [] });
    if (path === "/api/factory/twin/analysis") return json({ findings: [], loads: [], unassigned: 0, summary: {} });
    if (path === "/api/factory/plan") return json({ auto_routing: false, counts: {}, suggestions: [] });
    if (path === "/api/factory/handlers/plan") return json({ suggestions: [] });
    if (path.startsWith("/api/")) return json({ detail: "Test" });
    const file = path === "/twin/" || path === "/twin" ? "twin.html" : path.replace(/^\/twin\//, "");
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    try {
      await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
    } catch { await route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("http://internal.test/twin/");
  await page.locator(".three-canvas").waitFor();

  // KG aktiv, EG und Halle 2 einzeln einblenden. Jede gewählte Ebene/Halle
  // wird sofort vollständig gezeichnet, nicht nur angedeutet.
  await page.getByRole("button", { name: "Weitere Ebenen und Hallen auswählen" }).click();
  await page.getByRole("menuitem", { name: "EG · 0 Stationen" }).click();
  await page.getByRole("menuitem", { name: "Halle 2 · EG" }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".three-stage")?.getAttribute("data-levels")?.includes("EG"));
  const stage = page.locator(".three-stage");
  const active = Number(await stage.getAttribute("data-active-offset"));
  assert.ok(active < -2, `KG steht unter dem Boden, ist aber bei ${active} m`);
  const levels = await stage.getAttribute("data-levels");
  assert.match(levels, /EG@0\.0/, `EG liegt auf dem Boden (${levels})`);

  // Volle Sicht je Auswahl: Ebene und Halle stehen deckend in den Datenattributen.
  await page.waitForFunction(() => {
    const el = document.querySelector(".three-stage");
    return el?.getAttribute("data-full-levels") === "2" && el?.getAttribute("data-full-halls") === "2";
  });
  assert.equal(await stage.getAttribute("data-full-levels"), "2", "gewählte Ebene ist voll sichtbar");
  assert.equal(await stage.getAttribute("data-full-halls"), "2", "gewählte Halle ist voll sichtbar");

  // „Alles anzeigen“ wählt alle übrigen Ebenen und Hallen auf einmal.
  await page.getByRole("button", { name: "Weitere Ebenen und Hallen auswählen" }).click();
  assert.equal(await page.getByRole("menuitem", { name: "Alles anzeigen" }).isDisabled(), true,
    "bei bereits voller Auswahl ist alles gewählt");
  await page.getByRole("menuitem", { name: "Auswahl aufheben" }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector(".three-stage");
    return el?.getAttribute("data-full-levels") === "" && el?.getAttribute("data-full-halls") === "";
  });
  await page.getByRole("menuitem", { name: "Alles anzeigen" }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector(".three-stage");
    return el?.getAttribute("data-full-levels") === "2" && el?.getAttribute("data-full-halls") === "2";
  });
  await page.keyboard.press("Escape");

  assert.deepEqual(errors, [], "keine Laufzeitfehler");
  await context.close();
  console.log(`twin-ground ok: KG@${active} m, EG@0 m, Auswahl einzeln und alles voll sichtbar`);
} finally {
  await browser.close();
}
