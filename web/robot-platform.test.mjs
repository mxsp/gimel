// Run after npm run build: node robot-platform.test.mjs ../gimel/webapp/dist
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
const robot = {
  id: 1, name: "AGV 1", kind: "agv", floor_id: 1, active: true, state: "idle",
  simulated: true, gateway_id: "sim", battery_pct: 80, payload_kg: 200,
  capabilities: ["transport"], route: [], route_mode: "pingpong", route_m: 0,
  speed_m_s: 1, progress_m: 0, x: 2, y: 2, heading_deg: 0, updated_at: null,
  position_known: true, stale: false, active_job: null,
};
const stations = [
  { id: 1, label: "Regal", type: "warehouse", is_storage: true, x: 2, y: 2,
    w: 4, h: 3, rotation: 0, colour: "#8e5cb8", active: true, routing: "pull",
    materials: [], thicknesses: [], assigned_users: [], floor_id: 1 },
  { id: 2, label: "Plotter", type: "production", is_storage: false, x: 12, y: 2,
    w: 4, h: 3, rotation: 0, colour: "#0a5b9c", active: true, routing: "pull",
    materials: [], thicknesses: [], assigned_users: [], floor_id: 1 },
];
const worklist = {
  kinds: {}, auto_routing: false, policy: { window_h: 8, safety_min: 0, weights: {} },
  pool: [],
  stations: [{
    ...stations[1], schedule: { slots: [{ seq: 1, kind: "cut", ref: "IA-1", label: "Schnitt",
      mat: "epdm", mat_name: "EPDM", thk: 2, units: 1, n_parts: 1, n_plates: 1, rush: false,
      started: false, orders: ["AB-1"], customers: [], start_min: 0, finish_min: 10,
      changeover: false, slack_min: 0, late: false, reason: "", priority: {} }] },
  }],
};
const plan = {
  kind: "transfer", context: { work_order_no: "IA-1" }, order_id: null, order_no: "",
  work_order_id: null, work_order_no: "IA-1", station_task_id: null,
  from: { id: 1, label: "Regal", x: 2, y: 2, floor_id: 1 },
  to: { id: 2, label: "Plotter", x: 12, y: 2, floor_id: 1 },
  floor_id: 1, route: [[2, 2], [12, 2]], route_m: 10, route_exact: true,
  route_note: "Gangnetz", payload: {},
  candidates: [{ robot_id: 1, name: "AGV 1", distance_m: 0, score: 0.4,
    reason: "0 m zum Start, Akku 80 Prozent, Nutzlast 200 kg", eta_s: 10 }],
  rejected: [],
  recommended: { robot_id: 1, name: "AGV 1", distance_m: 0, score: 0.4,
    reason: "0 m zum Start, Akku 80 Prozent, Nutzlast 200 kg", eta_s: 10 },
};
const jobs = [];
const writes = [];
const errors = [];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("503")) errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features: [] } });
    if (path === "/api/factory/topology") return route.fulfill({ json: topology });
    if (path === "/api/factory/robots") return route.fulfill({ json: { robots: [robot], sampled_at: new Date().toISOString(), simulated: true } });
    if (path === "/api/factory/stations") return route.fulfill({ json: stations });
    if (path === "/api/factory/worklist") return route.fulfill({ json: worklist });
    if (path === "/api/factory/robot-gateways") return route.fulfill({ json: { gateways: [{
      id: 1, code: "halle-1", name: "Halle 1", kind: "http", base_url: "http://gw.local",
      endpoints: { command: "/orders" }, enabled: true, note: "", token_set: true,
      last_seen_at: null, updated_at: null }] } });
    if (path === "/api/factory/robot-programs") return route.fulfill({ json: { programs: [{
      id: 1, name: "Test-Mission", version: 1, kind: "mission", language: "json", body: "{}",
      checksum: "abc123", status: "approved", robot_id: 1, robot_name: "AGV 1",
      gateway_id: "halle-1", notes: "", created_by: "t", created_at: null,
      approved_by: "t", approved_at: null, deployed_at: null }] } });
    if (path === "/api/factory/robot-deployments") return route.fulfill({ json: { deployments: [] } });
    if (path === "/api/factory/robot-jobs" && req.method() === "GET") {
      return route.fulfill({ json: { jobs } });
    }
    if (path === "/api/factory/robot-jobs/plan" && req.method() === "POST") {
      writes.push({ method: "POST", path, body: req.postDataJSON() });
      return route.fulfill({ json: plan });
    }
    if (path === "/api/factory/robot-jobs" && req.method() === "POST") {
      const body = req.postDataJSON();
      writes.push({ method: "POST", path, body });
      const row = { id: 7, ref: "RT-00007", state: "assigned", priority: body.priority,
        order_id: null, order_no: "", work_order_id: null, work_order_no: body.work_order_no ?? "",
        station_task_id: null, task_kind: "", task_ref: "", from: plan.from, to: plan.to,
        robot_id: 1, robot_name: "AGV 1", floor_id: 1, route: plan.route, route_m: 10,
        route_exact: true, route_note: "Gangnetz", eta_s: 10, payload: {},
        context: { work_order_no: "IA-1" }, note: "", created_by: "t", created_at: "",
        approved_by: "", approved_at: "", assigned_by: "", assigned_at: "", started_at: "",
        finished_at: "", finished_by: "" };
      jobs.unshift(row);
      return route.fulfill({ status: 201, json: row });
    }
    if (path.startsWith("/api/")) return route.fulfill({ status: 503, json: { detail: "Test" } });
    const file = path === "/app/" ? "index.html" : path.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });

  await page.goto("http://internal.test/app/#/roboter");
  await page.getByRole("heading", { name: "Roboter" }).waitFor();

  await page.locator(".robot-tabs").getByRole("link", { name: "Transporte", exact: true }).click();
  await page.getByRole("heading", { name: "Transporte" }).waitFor();
  assert.ok((await page.locator("body").innerText()).includes("Neuer Transport"));

  await page.getByRole("button", { name: "Neuer Transport" }).first().click();
  await page.locator("#job-context").selectOption("IA-1");
  await page.locator("#job-from").selectOption("1");
  await page.locator("#job-to").selectOption("2");
  await page.getByRole("button", { name: "Weg und Roboter planen" }).click();
  await page.getByText("Vorschlag AGV 1").waitFor();
  assert.equal(writes.at(-1).body.from_station_id, 1);
  assert.equal(writes.at(-1).body.to_station_id, 2);

  await page.getByRole("button", { name: "Transport anlegen" }).click();
  await page.waitForTimeout(250);
  const created = writes.filter((w) => w.method === "POST" && w.path === "/api/factory/robot-jobs");
  assert.ok(created.length, "Transport wurde nicht angelegt");
  assert.equal(created[0].body.work_order_no, "IA-1");
  assert.equal(created[0].body.auto_assign, true);
  assert.ok((await page.locator("body").innerText()).includes("RT-00007"));

  await page.locator(".robot-tabs").getByRole("link", { name: "Missionen", exact: true }).click();
  await page.getByRole("heading", { name: "Missionen" }).waitFor();
  assert.ok((await page.locator("body").innerText()).includes("Test-Mission"));
  assert.ok((await page.locator("body").innerText()).includes("Auslieferungen"));

  await page.locator(".robot-tabs").getByRole("link", { name: "Gateways", exact: true }).click();
  await page.getByRole("heading", { name: "Gateways" }).waitFor();
  assert.ok((await page.locator("body").innerText()).includes("halle-1"));
  assert.ok((await page.locator("body").innerText()).includes("gesetzt"));

  assert.deepEqual(errors, []);
  console.log("Robot platform checks passed: transports, plan, mission, gateway.");
} finally {
  await browser.close();
}
