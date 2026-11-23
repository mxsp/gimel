// Run after npm run build: node twin-levels.test.mjs ../gimel/twin/dist
// Mehrere Ebenen müssen als Stapel erscheinen, auch wenn alte Datensätze
// elevation_m = 0 für alle Geschosse melden. Prüft den Versatz, die Platte,
// die Kamera-Einpassung und den HUD-Zähler.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] && !process.argv[2].includes("webapp") ? process.argv[2] : "../gimel/twin/dist";
const outline = [[0, 0], [52, 0], [52, 24], [0, 24]];
const aisles = { nodes: [[6, 16], [20, 16], [34, 16], [48, 16]], edges: [[0, 1], [1, 2], [2, 3]], paths: [] };
const floor = (id, elevation, level, name) => ({
  id, name, level, level_name: name, elevation_m: elevation, height_m: 6,
  outline, grid: 1, snap: 0.25, scale: 40, bg: "#f5f5f0", area_m2: 1248, hall_id: 1,
  zones: [], obstacles: [], doors: [], aisles,
});
const station = (id, label, fid) => ({
  id, label, type: "production", subtype: "", x: 20 + id * 4, y: 8, w: 4, h: 3,
  rotation: 0, colour: "#106ba3", active: true, routing: "smart_suggest",
  materials: [], thicknesses: [], assigned_users: [], queue_jobs: 0, queue_min: 0,
  capacity_min_per_day: 450, machine_kind: "plotter", is_storage: false,
  model_file: "", model_scale: 1, model_rotation: 0, speed_mm_s: 0, pierce_s: 0,
  setup_min: 0, changeover_min: 0, handling_min_per_plate: 0, max_sheet_w: 0,
  max_sheet_h: 0, thk_min: 0, thk_max: 0, cost_per_h: 0, task_min: 0, unit_min: 0,
  note: "", visibility: "collapse", floor_id: fid,
});
const stations = [station(1, "Unten", 1), station(2, "Oben", 2)];

const topology = (upperElevation) => ({
  sites: [{ id: 1, name: "Werk", code: "W", address: "", lat: 51.48, lon: 12.0, note: "",
    halls: [{ id: 1, site_id: 1, name: "Halle 1", code: "H1", sort: 0, lat: 51.48, lon: 12.0,
      rotation_deg: 0, map_enabled: 0, note: "", floors: [
        { id: 1, hall_id: 1, level: 0, level_name: "EG", elevation_m: 0, height_m: 6, name: "EG", stations: 1, default: true },
        { id: 2, hall_id: 1, level: 1, level_name: "1. OG", elevation_m: upperElevation,
          height_m: 6, name: "1. OG", stations: 1, default: false },
      ] }] }],
  unsited_halls: [], unassigned_floors: [], default_floor_id: 1, default_site_id: 1,
});

const browser = await chromium.launch();
const errors = [];

async function check(upperElevation, label) {
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
  const topo = topology(upperElevation);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (x) => route.fulfill({ json: x });
    if (path === "/api/version") return json({ version: "t", features: [] });
    if (path === "/api/factory/topology") return json(topo);
    if (path.startsWith("/api/factory/floor")) {
      const id = Number(url.searchParams.get("floor_id") || 1);
      return json(floor(id, id === 2 ? upperElevation : 0, id === 2 ? 1 : 0, id === 2 ? "1. OG" : "EG"));
    }
    if (path === "/api/factory/stations") return json(stations);
    if (path === "/api/factory/flow") return json({ total_transport_m: 0, edges: [] });
    if (path === "/api/factory/worklist") return json({ kinds: {}, pool: [], auto_routing: false, policy: {}, stations: [] });
    if (path.startsWith("/api/factory/robots")) return json({ sampled_at: "2026-11-06T10:00:00+00:00", simulated: false, robots: [] });
    if (path.startsWith("/api/factory/robot-jobs")) return json({ jobs: [] });
    if (path === "/api/factory/twin/analysis") return json({ findings: [], loads: [], unassigned: 0, summary: {} });
    if (path === "/api/factory/plan") return json({ auto_routing: false, counts: {}, suggestions: [] });
    if (path === "/api/factory/handlers/plan") return json({ suggestions: [] });
    if (/^\/api\/factory\/stations\/\d+\/view$/.test(path)) return json({ station: stations[0], station_type: "production", all_for_all: false, orders: [], hidden_count: 0, auto_routing: false, queue: [] });
    if (path.startsWith("/api/")) return json({ detail: "Test" });
    const f = path === "/twin/" || path === "/twin" ? "twin.html" : path.replace(/^\/twin\//, "");
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    try {
      await route.fulfill({ body: await readFile(resolve(dist, f)), contentType: mime[extname(f)] || "application/octet-stream" });
    } catch { await route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("http://internal.test/twin/");
  await page.locator(".three-canvas").waitFor();
  await page.getByRole("button", { name: "Weitere Ebenen und Hallen auswählen" }).click();
  await page.getByRole("menuitem", { name: "1. OG · 1 Station" }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".three-stage")?.getAttribute("data-levels")?.includes("1. OG"));
  const data = await page.locator(".three-stage").getAttribute("data-levels");
  const offset = Number(/@(-?[\d.]+)$/.exec(data)?.[1]);
  assert.ok(Math.abs(offset) >= 3, `${label}: Ebene muss sichtbar versetzt sein, ist aber ${offset} m`);
  assert.equal(await page.locator(".three-level-label").count(), 1, `${label}: Ebenen-Schild`);
  assert.ok((await page.locator(".iso-hud").innerText()).includes("2 Ebenen"), `${label}: HUD zählt den Stapel`);
  // Der Stapel darf nicht im aktiven Geschoss liegen: die obere Platte hat
  // eine echte Ausdehnung nach oben, sichtbar am Kamerazoom (Maßstab).
  const scale = await page.locator(".three-scale-text").innerText();
  assert.match(scale, /\d+ m/, `${label}: Maßstab folgt dem Stapel`);
  console.log(`${label}: data-levels="${data}" scale=${scale}`);
  await context.close();
}

try {
  await check(6, "mit gemeldeter Höhe");
  await check(0, "ohne elevation_m (alte Daten)");
  assert.deepEqual(errors, [], "keine Laufzeitfehler");
  console.log("Level stacking checks passed: real elevations and legacy zero elevations stack cleanly.");
} finally {
  await browser.close();
}
