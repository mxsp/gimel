// Run after npm run build: node twin-ways.test.mjs ../gimel/twin/dist
// Prüft, dass alle drei Zwilling-Ansichten dieselben Fahrspuren und Handwege
// zeigen, dass die Hallenhülle schaltbar ist und dass die 3D-Kamera ohne
// Fehler läuft. Bestehende DOM-Verträge der Leitstand-Tests bleiben unberührt.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] && !process.argv[2].includes("webapp") ? process.argv[2] : "../gimel/twin/dist";
const base = { subtype: "", w: 4, h: 3, rotation: 0, colour: "#0a5b9c", active: true,
  routing: "smart_suggest", materials: [], thicknesses: [], assigned_users: [], queue_jobs: 1,
  queue_min: 100, capacity_min_per_day: 450, machine_kind: "plotter", is_storage: false,
  model_file: "", model_scale: 1, model_rotation: 0, speed_mm_s: 0, pierce_s: 0, setup_min: 0,
  changeover_min: 0, handling_min_per_plate: 0, max_sheet_w: 0, max_sheet_h: 0, thk_min: 0,
  thk_max: 0, cost_per_h: 0, task_min: 0, unit_min: 0, note: "", visibility: "collapse" };
const stations = [
  { ...base, id: 1, label: "Plotter", type: "production", x: 8, y: 6 },
  { ...base, id: 2, label: "Regal", type: "warehouse", x: 26, y: 14, is_storage: true, colour: "#4a9d6e" },
  { ...base, id: 3, label: "Packtisch", type: "shipping", x: 42, y: 18, colour: "#c4520a" },
];
const floor = {
  id: 1, name: "Halle 1 · EG", level: 0, level_name: "EG", elevation_m: 0, height_m: 6,
  outline: [[0, 0], [52, 0], [52, 24], [0, 24]], grid: 1, snap: 0.25, scale: 40, bg: "#f5f5f0",
  area_m2: 1248, perimeter_m: 152, aisle_m: 96,
  zones: [],
  obstacles: [{ name: "Stütze A", points: [[20, 10], [21, 10], [21, 11], [20, 11]] }],
  doors: [{ name: "Anlieferung", x: 0, y: 12, width: 3, kind: "gate" }],
  aisles: {
    nodes: [[2, 12], [14, 12], [28, 12], [42, 12], [50, 12]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
    paths: [
      { station: 1, points: [[8, 6], [8, 12]] },
      { station: 3, points: [[42, 18], [42, 12]] },
    ],
  },
};
const worklist = { kinds: {}, pool: [], auto_routing: false, policy: {}, stations: [] };
const flow = { total_transport_m: 90, edges: [
  { from: 2, to: 1, kind: "supply", count: 4, metres: 26, exact: true, materials: [] },
  { from: 1, to: 3, kind: "dispatch", count: 2, metres: 40, exact: false, materials: [] },
] };

const browser = await chromium.launch();
const errors = [];

async function open(view) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("503")) errors.push(m.text()); });
  await page.addInitScript((v) => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
    localStorage.setItem("gimel-plan-view", v);
  }, view);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (x) => route.fulfill({ json: x });
    if (path === "/api/version") return json({ version: "t", features: [] });
    if (path.startsWith("/api/factory/floor")) return json(floor);
    if (path === "/api/factory/stations") return json(stations);
    if (path === "/api/factory/flow") return json(flow);
    if (path === "/api/factory/worklist") return json(worklist);
    if (path.startsWith("/api/factory/robots")) return json({ sampled_at: "2026-11-06T10:00:00+00:00", simulated: false,
      robots: [
        { id: 1, name: "AGV 1", kind: "agv", floor_id: 1, active: true, state: "moving", simulated: false,
          route: [[18, 8], [24, 8]], route_mode: "loop", route_m: 6, speed_m_s: 0, progress_m: 0,
          x: 20.5, y: 10.5, heading_deg: 0, battery_pct: 80, payload_kg: 0, capabilities: [], gateway_id: "sim" },
        { id: 2, name: "AGV 2", kind: "agv", floor_id: 1, active: true, state: "moving", simulated: false,
          route: [[25, 8], [28, 8]], route_mode: "loop", route_m: 3, speed_m_s: 0, progress_m: 0,
          x: 21.2, y: 10.5, heading_deg: 0, battery_pct: 70, payload_kg: 0, capabilities: [], gateway_id: "sim" },
      ] });
    if (path.startsWith("/api/factory/robot-jobs")) return json({ jobs: [
      { id: 9, ref: "T-9", kind: "transfer", state: "running", robot_id: 1, robot_name: "AGV 1", floor_id: 1,
        route: [[18, 10.5], [23, 10.5]], route_m: 5, route_exact: true, route_note: "", eta_s: 0, priority: 0 },
    ] });
    if (path === "/api/factory/twin/analysis") return json({ findings: [], loads: [], unassigned: 0, summary: {} });
    if (path === "/api/factory/plan") return json({ auto_routing: false, counts: {}, suggestions: [] });
    if (path === "/api/factory/handlers/plan") return json({ suggestions: [] });
    const viewOf = /^\/api\/factory\/stations\/(\d+)\/view$/.exec(path);
    if (viewOf) return json({ station: stations[+viewOf[1] - 1], station_type: "production", all_for_all: false,
      orders: [], hidden_count: 0, auto_routing: false, queue: [] });
    if (path.startsWith("/api/")) return json({ detail: "Test" });
    const file = path === "/twin/" || path === "/twin" ? "twin.html" : path.replace(/^\/twin\//, "");
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    try {
      await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
    } catch { await route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("http://internal.test/twin/");
  await page.locator(".floor-stage").first().waitFor();
  return { page, close: () => context.close() };
}

async function toggle(page, name) {
  // Ein offenes Menü schließen: sonst kippt der zweite Klick auf „Anzeige"
  // das Popover zu, statt es zu öffnen.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Anzeige" }).click();
  await page.getByRole("menuitem", { name }).click();
}

try {
  // 2D: Fahrspuren, Handwege und Richtungspfeile.
  {
    const { page, close } = await open("2d");
    await page.locator(".floor-station").first().waitFor();
    // 4 Kanten + 2 Handwege; Spuren, die eine Maschine schneiden, werden
    // an deren Kante geteilt — daraus können mehr Abschnitte werden.
    assert.ok(await page.locator(".floor-aisle-lanes path").count() >= 6, "Fahrspuren je Weg");
    assert.equal(await page.locator(".floor-aisle-paths path").count(), 2, "zwei Handwege");
    assert.ok(await page.locator(".floor-aisle-arrows path").count() > 0, "Richtungspfeile auf den Spuren");
    assert.equal(await page.locator(".floor-station").count(), stations.length, "Stationen bleiben sichtbar");
    await toggle(page, "Fahrspuren");
    assert.equal(await page.locator(".floor-aisle-lanes path").count(), 0, "Fahrspuren lassen sich ausblenden");
    assert.equal(await page.locator(".floor-aisle-paths path").count(), 2, "Handwege bleiben");
    await close();
  }

  // Semi-3D: projizierte Spuren, Handwege und Hallenrahmen.
  {
    const { page, close } = await open("iso");
    await page.locator(".twin-station").first().waitFor();
    assert.ok(await page.locator(".iso-aisle-lanes path").count() >= 6, "dieselben Wege isometrisch, an Körpern gekappt");
    assert.equal(await page.locator(".iso-aisle-paths path").count(), 2);
    assert.equal(await page.locator(".iso-hall-frame").count(), 1, "Hallenrahmen");
    assert.ok((await page.locator(".iso-hud").innerText()).includes("m hoch"), "Höhe im HUD");
    assert.ok((await page.locator(".iso-hud").innerText()).includes("m Gänge"), "Ganglänge im HUD");
    await toggle(page, "Hallenrahmen");
    assert.equal(await page.locator(".iso-hall-frame").count(), 0, "Rahmen ausschaltbar");
    await toggle(page, "Handwege");
    assert.equal(await page.locator(".iso-aisle-paths path").count(), 0, "Handwege ausschaltbar");
    await close();
  }

  // 3D: nur prüfen, wenn der Browser WebGL kann. Kein weißer Bildschirm,
  // Maßstab und Kompass da, Kamerapresets und Hüllen-Schalter ohne Fehler.
  {
    const { page, close } = await open("three");
    const hasGl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
    if (hasGl) {
      await page.locator(".three-canvas").waitFor();
      assert.equal(await page.locator(".three-floor-nogl").count(), 0, "kein WebGL-Hinweis");
      assert.equal(await page.locator(".three-scale").count(), 1, "Maßstab");
      assert.equal(await page.locator(".three-compass").count(), 1, "Kompass");
      assert.equal(await page.locator(".three-presets button").count(), 3, "drei Kamerapresets");
      // Kollisionslogik: zwei Roboter auf der Stütze, zu nah beieinander und
      // ein Transport quer hindurch müssen im Bild und im HUD erscheinen.
      await page.waitForFunction(() => {
        const el = document.querySelector(".three-collision-hud");
        return el && Number(el.dataset.collisions || 0) > 0;
      });
      assert.ok(Number(await page.locator(".three-collision-hud").getAttribute("data-collisions")) >= 3,
        "Kollisionen gezählt");
      assert.ok(await page.locator(".three-collision-label").count() > 0, "Kollisionshinweise im Bild");
      await page.getByRole("button", { name: "Draufsicht" }).click();
      await toggle(page, "Hallenhülle");
      await toggle(page, "Dach");
      await toggle(page, "Kollisionen");
      assert.equal(await page.locator(".three-collision-label").count(), 0, "Kollisionen ausschaltbar");
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".three-canvas").count(), 1, "3D bleibt nach den Schaltern");
    }
    await close();
  }

  assert.deepEqual(errors, [], "keine Laufzeitfehler");
  console.log("Twin ways checks passed: lanes, manual paths, hall frame, HUD, camera presets, toggles.");
} finally {
  await browser.close();
}
