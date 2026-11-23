// Run after npm run build: node robots-page.test.mjs ../gimel/webapp/dist
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] ?? "../gimel/webapp/dist";
const floor = { id: 1, hall_id: 1, level: 0, level_name: "EG", elevation_m: 0, height_m: 6, name: "Halle 1", stations: 2, default: true };
const topology = {
  sites: [{ id: 1, name: "Werk", code: "W", address: "", lat: 0, lon: 0, note: "",
    halls: [{ id: 1, site_id: 1, name: "Halle 1", code: "H1", sort: 0, lat: 0, lon: 0,
      rotation_deg: 0, map_enabled: false, note: "", floors: [floor] }] }],
  unsited_halls: [], unassigned_floors: [], default_floor_id: 1, default_site_id: 1,
};
const base = {
  floor_id: 1, active: true, simulated: true, gateway_id: "sim", payload_kg: 200,
  route: [[2, 2], [10, 2], [10, 8]], route_mode: "pingpong", route_m: 16, speed_m_s: 1,
  progress_m: 4, x: 5, y: 2, heading_deg: 0, updated_at: null,
};
let robots = [
  { ...base, id: 1, name: "AGV 1", kind: "agv", state: "moving", battery_pct: 80, capabilities: ["transport"] },
  { ...base, id: 2, name: "Arm 1", kind: "arm", state: "idle", battery_pct: null, capabilities: ["arm"] },
];
const writes = [];
const errors = [];

const browser = await chromium.launch();

async function open(role = "admin") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  // 503: absichtlich nicht gemockte Routen; WebGL: Headless ohne GPU, die Zelle zeigt dann ihren Hinweis.
  page.on("console", (m) => { if (m.type() === "error" && !/503|WebGL/i.test(m.text())) errors.push(m.text()); });
  await page.addInitScript((r) => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: r }));
  }, role);
  await page.route("**/*", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features: [] } });
    if (path === "/api/factory/topology") return route.fulfill({ json: topology });
    if (path === "/api/factory/robots" && req.method() === "GET") return route.fulfill({ json: { robots, sampled_at: new Date().toISOString(), simulated: true } });
    if (path === "/api/factory/robots" && req.method() === "POST") {
      const body = req.postDataJSON();
      writes.push({ method: "POST", path, body });
      const row = { ...base, ...body, id: 99, simulated: body.gateway_id === "sim", route_m: 16, x: 2, y: 2, heading_deg: 0 };
      robots = [...robots, row];
      return route.fulfill({ status: 201, json: row });
    }
    const one = /^\/api\/factory\/robots\/(\d+)$/.exec(path);
    if (one && req.method() === "PUT") {
      const body = req.postDataJSON();
      writes.push({ method: "PUT", path, body });
      const id = Number(one[1]);
      const row = { ...robots.find((r) => r.id === id), ...body, id };
      robots = robots.map((r) => (r.id === id ? row : r));
      return route.fulfill({ json: row });
    }
    if (one && req.method() === "DELETE") {
      writes.push({ method: "DELETE", path });
      const id = Number(one[1]);
      robots = robots.filter((r) => r.id !== id);
      return route.fulfill({ status: 204, body: "" });
    }
    if (path.startsWith("/api/")) return route.fulfill({ status: 503, json: { detail: "Test" } });
    const file = path === "/app/" ? "index.html" : path.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  await page.goto("http://internal.test/app/#/roboter");
  await page.getByRole("heading", { name: "Roboter", exact: true }).waitFor();
  return { page, close: () => context.close() };
}

try {
  {
    const { page, close } = await open();
    // Fahrzeuge: Liste und Lagekarte; der Arm steht nicht bei den Fahrzeugen.
    assert.equal(await page.locator(".fleet-row").count(), 1);
    assert.ok((await page.locator(".fleet-list").innerText()).includes("AGV 1"));
    assert.ok(!(await page.locator(".fleet-list").innerText()).includes("Arm 1"));
    assert.equal(await page.locator(".fleet-map-svg .fm-robot").count(), 1, "AGV 1 auf der Karte");
    await page.locator(".fleet-row", { hasText: "AGV 1" }).click();
    await page.getByLabel("Akte AGV 1").waitFor();
    assert.ok((await page.getByLabel("Akte AGV 1").innerText()).includes("Pendel"));

    await page.getByRole("button", { name: "Neues Fahrzeug" }).click();
    await page.locator("#robot-name").fill("AMR 9");
    await page.locator("#robot-kind").selectOption("amr");
    await page.locator("#robot-route").fill("2, 2\n10, 2\n10, 8");
    await page.getByRole("button", { name: "Anlegen" }).click();
    await page.waitForTimeout(300);
    const created = writes.find((w) => w.method === "POST");
    assert.ok(created, "POST fehlt");
    assert.equal(created.body.name, "AMR 9");
    assert.equal(created.body.kind, "amr");
    assert.deepEqual(created.body.route, [[2, 2], [10, 2], [10, 8]]);
    assert.ok((await page.locator(".fleet-list").innerText()).includes("AMR 9"));

    await page.getByRole("button", { name: "AGV 1 bearbeiten" }).click();
    await page.locator("#robot-speed").fill("1.5");
    await page.getByRole("button", { name: "Speichern" }).click();
    await page.waitForTimeout(300);
    const changed = writes.find((w) => w.method === "PUT");
    assert.ok(changed, "PUT fehlt");
    assert.equal(changed.body.speed_m_s, 1.5);

    // Arme & Zellen: der Arm als Reiter, die Sortierzelle darunter, ohne Wegeingabe für Arme.
    await page.getByRole("link", { name: /Arme & Zellen/ }).click();
    await page.getByRole("tab", { name: /Arm 1/ }).waitFor();
    await page.getByRole("region", { name: /Sortierzelle/ }).waitFor();
    await page.getByRole("button", { name: "Neuer Arm" }).click();
    assert.equal(await page.locator("#robot-kind").inputValue(), "arm");
    assert.equal(await page.locator("#robot-route").count(), 0, "Arme brauchen keinen Weg");
    await page.getByRole("button", { name: "Abbrechen" }).click();
    await close();
  }

  {
    const { page, close } = await open("worker");
    assert.equal(await page.getByRole("button", { name: "Neues Fahrzeug" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /bearbeiten/ }).count(), 0);
    await close();
  }

  assert.deepEqual(errors, []);
  console.log("Robots page checks passed: vehicles map + list + detail, create, edit, arms & cell, worker read-only.");
} finally {
  await browser.close();
}
