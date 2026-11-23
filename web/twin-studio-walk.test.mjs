// Run after npm run build: node twin-studio-walk.test.mjs ../gimel/studio/dist
// Twin Studio (task 40): Häkchen je Halle und Ebene, gemerkte Wahl; Begehen mit
// Tastenkürzeln (H, Q, X, Pos1, Bild↑/↓, Strg+Z) und Rechtsklick-Menü.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] && !process.argv[2].includes("webapp") ? process.argv[2] : "../gimel/studio/dist";
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
const station = (id, label, fid, x, y, w = 4, h = 2) => ({
  id, label, type: "production", subtype: "", x, y, w, h,
  rotation: 0, colour: "#106ba3", active: true, routing: "smart_suggest",
  materials: [], thicknesses: [], assigned_users: [], queue_jobs: 0, queue_min: 0,
  capacity_min_per_day: 450, machine_kind: "plotter", is_storage: false,
  model_file: "", model_scale: 1, model_rotation: 0, speed_mm_s: 0, pierce_s: 0,
  setup_min: 0, changeover_min: 0, handling_min_per_plate: 0, max_sheet_w: 0,
  max_sheet_h: 0, thk_min: 0, thk_max: 0, cost_per_h: 0, task_min: 0, unit_min: 0,
  note: "", visibility: "collapse", floor_id: fid,
});
// Vom Start in der Hallenmitte (15, 8) mit Blick nach +y liegt der Plotter genau voraus.
const stations = [
  station(1, "Plotter Vorn", 1, 15, 13), station(2, "Regal OG", 2, 5, 4),
  station(3, "Stanze H2", 3, 6, 12), station(4, "Presse H2 OG", 4, 20, 8),
];
const lvl = (id) => ({ id, hall_id: LEVELS[id][0], level: LEVELS[id][1], level_name: LEVELS[id][2],
  elevation_m: LEVELS[id][1] * 6.8, height_m: 6, name: LEVELS[id][2], stations: 1, default: id === 1 });
const topology = {
  sites: [{ id: 1, name: "Werk", code: "W", address: "", lat: 51.48, lon: 12.0, note: "", halls: [
    { id: 1, site_id: 1, name: "Halle 1", code: "H1", sort: 0, lat: 51.48, lon: 12.0, rotation_deg: 0,
      map_enabled: 0, note: "", floors: [lvl(1), lvl(2)] },
    { id: 2, site_id: 1, name: "Halle 2", code: "H2", sort: 1, lat: 51.48, lon: 12.0006, rotation_deg: 0,
      map_enabled: 0, note: "", floors: [lvl(3), lvl(4)] },
  ] }],
  unsited_halls: [], unassigned_floors: [], default_floor_id: 1, default_site_id: 1,
};

const browser = await chromium.launch();
const errors = [];
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/503|404/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(() => {
  localStorage.setItem("gimel-token", "test-token");
  localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", email: "t@example.test", role: "admin" }));
  localStorage.setItem("gimel-studio-view", "three");
  localStorage.setItem("gimel-floor", "1");
});
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  const json = (x) => route.fulfill({ json: x });
  if (path === "/api/version") return json({ version: "t", features: [], demo: false, agent: false });
  if (path === "/api/factory/topology") return json(topology);
  if (path.startsWith("/api/factory/floor")) return json(floor(Number(url.searchParams.get("floor_id") || 1)));
  if (path === "/api/factory/stations") return json(stations);
  if (path === "/api/factory/flow") return json({ total_transport_m: 0, edges: [] });
  if (path === "/api/factory/worklist") return json({ kinds: {}, pool: [], auto_routing: false, policy: {}, stations: [] });
  if (path.startsWith("/api/factory/robots")) return json({ sampled_at: "2026-11-07T10:00:00+00:00", simulated: false, robots: [] });
  if (path.startsWith("/api/factory/robot-jobs")) return json({ jobs: [] });
  if (path.startsWith("/api/factory/views")) return json([]);
  if (path.startsWith("/api/factory/fleet")) return json([]);
  if (/^\/api\/factory\/stations\/\d+\/view$/.test(path)) {
    const id = Number(path.split("/")[4]);
    return json({ station: stations.find((s) => s.id === id), station_type: "production", all_for_all: false,
      orders: [], hidden_count: 0, auto_routing: false, queue: [] });
  }
  if (path.startsWith("/api/")) return json({});
  const f = path === "/studio/" || path === "/studio" ? "studio.html" : path.replace(/^\/studio\//, "");
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2" };
  try {
    await route.fulfill({ body: await readFile(resolve(dist, f)), contentType: mime[extname(f)] || "application/octet-stream" });
  } catch { await route.fulfill({ status: 404, body: "" }); }
});

const stage = page.locator(".three-stage");
const attr = (name) => stage.getAttribute(name);
/** SHOTS=<Ordner> legt Bilder der Schritte ab (zum Ansehen, nicht geprüft). */
const shot = (name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null);
const halls = async () => ((await attr("data-halls")) ?? "").split(";").filter(Boolean).map((h) => h.split("@")[0]).sort();
const waitAttr = (name, fn) => page.waitForFunction(([n, src]) => {
  const v = document.querySelector(".three-stage")?.getAttribute(n) ?? "";
  return new Function("v", `return (${src})(v)`)(v);
}, [name, fn.toString()]);

try {
  await page.goto("http://internal.test/studio/");
  await page.locator(".three-canvas").waitFor();
  // Vorgabe: andere Halle auf derselben Stufe.
  await waitAttr("data-halls", (v) => v.includes("2/3@"));
  assert.deepEqual(await halls(), ["2/3"], "Vorgabe: Halle 2 · EG");

  // --- Häkchen: Halle 2 ganz, dazu 1. OG der aktiven Halle.
  await page.getByRole("button", { name: "Ebenen und Daten" }).click();
  const hall2 = page.locator(".studio-pick-hall").filter({ hasText: "Halle 2" });
  const hall1 = page.locator(".studio-pick-hall").filter({ hasText: "Halle 1 (aktiv)" });
  await hall2.locator("label").first().click();
  await waitAttr("data-halls", (v) => v.split(";").length === 2);
  assert.deepEqual(await halls(), ["2/3", "2/4"], "Hallen-Häkchen: alle Ebenen von Halle 2");
  await hall1.locator("li label", { hasText: "1. OG" }).click();
  await waitAttr("data-levels", (v) => v.startsWith("1. OG@"));
  assert.ok(await hall1.locator("li", { hasText: "EG · aktiv" }).locator("input").isDisabled(), "aktive Ebene nicht abwählbar");
  // Einzelne Ebene von Halle 2 abwählen → Hallen-Häkchen teilweise.
  await hall2.locator("li label", { hasText: "EG" }).click();
  await waitAttr("data-halls", (v) => v.split(";").filter(Boolean).length === 1);
  assert.deepEqual(await halls(), ["2/4"], "nur 1. OG von Halle 2");
  assert.equal(await hall2.locator("> label input, > .bp5-control input").first().evaluate((i) => i.indeterminate), true,
    "Hallen-Häkchen zeigt „teilweise“");
  await shot("studio-1-haekchen");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("gimel-studio-shown-floors") ?? "null"));
  assert.deepEqual([...saved].sort(), [2, 4], "Wahl wird gemerkt");
  await page.getByRole("button", { name: "Nur aktive Ebene" }).click();
  await waitAttr("data-halls", (v) => v === "");
  assert.equal(await attr("data-levels"), "", "nur die aktive Ebene");
  // Menü schließen wie ein Nutzer: Klick daneben (auf die Bühne).
  await page.locator(".three-canvas").click({ position: { x: 20, y: 20 } });
  await page.locator(".bp5-popover").waitFor({ state: "detached" });

  // --- Begehen: Tastenkürzel.
  await page.keyboard.press("g");
  await waitAttr("data-camera", (v) => v.startsWith("walk"));
  await page.keyboard.press("h");
  await page.getByRole("dialog", { name: "Tastenkürzel beim Begehen" }).waitFor();
  await shot("studio-2-tastenkuerzel");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Tastenkürzel beim Begehen" }).waitFor({ state: "detached" });
  assert.ok((await attr("data-camera")).startsWith("walk"), "Esc schließt nur die Übersicht");
  await page.keyboard.press("Home");
  await page.waitForTimeout(400);
  const [hx, hy] = (await attr("data-camera")).slice(5).split("@")[0].split(",").map(Number);
  assert.ok(Math.abs(hx - 15) < 1.5 && Math.abs(hy - 8) < 1.5, `Pos1: Start in der Mitte (${hx}, ${hy})`);
  // Q öffnet die Station im Blick, X geht hin.
  await page.keyboard.press("q");
  await page.getByText("Plotter Vorn").first().waitFor();
  await page.keyboard.press("x");
  await page.waitForTimeout(1500);
  const [gx, gy] = (await attr("data-camera")).slice(5).split("@")[0].split(",").map(Number);
  assert.ok(gy > hy + 1, `X: zur Station gegangen (${hy} → ${gy})`);
  assert.ok(gy < 13 - 1, "… und davor stehen geblieben");
  // Strg+Z ohne Verlauf: nichts passiert, das Begehen bleibt.
  await page.keyboard.press("Control+z");
  assert.ok((await attr("data-camera")).startsWith("walk"), "Strg+Z beendet das Begehen nicht");

  // --- Rechtsklick ohne Ziehen: Menü; „Ebene hinauf“ wechselt an derselben Stelle.
  const box = await page.locator(".three-canvas").boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.85);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  const menu = page.getByRole("dialog", { name: "Begehen: Menü" });
  await menu.waitFor();
  await shot("studio-3-rechtsklick");
  for (const item of ["Ebene hinauf", "Zurück zum Start", "Tastenkürzel", "Begehen beenden", "Rückgängig"]) {
    assert.ok(await menu.getByText(item, { exact: true }).isVisible(), `Menü: ${item}`);
  }
  assert.ok(await menu.locator(".bp5-menu-item", { hasText: "Ebene hinunter" }).evaluate((e) => e.classList.contains("bp5-disabled")),
    "unter dem EG gibt es keine Ebene");
  await menu.getByText("Ebene hinauf", { exact: true }).click();
  await waitAttr("data-camera", (v) => v.endsWith("@2"));
  await menu.waitFor({ state: "detached" });
  // Rechts ziehen schaut weiter um und öffnet kein Menü.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole("dialog", { name: "Begehen: Menü" }).count(), 0, "Ziehen öffnet kein Menü");
  // Bild↓ zurück ins EG.
  await page.keyboard.press("PageDown");
  await waitAttr("data-camera", (v) => v.endsWith("@1"));

  assert.deepEqual(errors, [], "keine Laufzeitfehler");
  console.log("twin-studio-walk ok: Häkchen je Halle und Ebene, Tastenkürzel, Rechtsklick-Menü");
} finally {
  await browser.close();
}
