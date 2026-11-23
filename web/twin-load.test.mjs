// Run after npm run build: node twin-load.test.mjs ../gimel/twin/dist
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] && !process.argv[2].includes("webapp") ? process.argv[2] : "../gimel/twin/dist";
const base = { type: "production", subtype: "", y: 5, w: 4, h: 3, rotation: 0, colour: "#0a5b9c", active: true, routing: "push",
  materials: [], thicknesses: [], assigned_users: [], queue_jobs: 0 };
const stations = [
  { ...base, id: 1, label: "Halb", x: 5, queue_min: 225, capacity_min_per_day: 450, queue_jobs: 2 },
  { ...base, id: 2, label: "Voll", x: 12, queue_min: 900, capacity_min_per_day: 450, queue_jobs: 4, last_mat: "EPDM" },
  { ...base, id: 3, label: "Packtisch", type: "shipping", x: 19, queue_min: 2000, capacity_min_per_day: 0, queue_jobs: 3 },
  { ...base, id: 4, label: "Regal", type: "warehouse", x: 26, queue_min: 40, capacity_min_per_day: 450, queue_jobs: 1 },
  { ...base, id: 5, label: "Stumm", x: 33, queue_min: 0, capacity_min_per_day: 450, queue_jobs: 2 },
  { ...base, id: 6, label: "Frei", x: 40, queue_min: 0, capacity_min_per_day: 450 },
];
const floor = { name: "Halle", outline: [[0, 0], [50, 0], [50, 12], [0, 12]], zones: [], obstacles: [], doors: [], aisles: { nodes: [], edges: [] } };

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
    // Unter 1600 px ist die Lage ohne eigene Wahl zu (Aufgabe 41 F); dieser Test liest sie.
    localStorage.setItem("gimel-leitstand-lage", "1");
  });
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/factory/floor") return route.fulfill({ json: floor });
    if (path === "/api/factory/stations") return route.fulfill({ json: stations });
    if (path === "/api/factory/robots") return route.fulfill({ json: { sampled_at: "2026-11-04T10:00:00+00:00", simulated: false, robots: [] } });
    if (path === "/api/factory/robot-jobs") return route.fulfill({ json: { jobs: [] } });
    const view = /^\/api\/factory\/stations\/(\d+)\/view$/.exec(path);
    if (view) return route.fulfill({ json: { station: stations[+view[1] - 1], station_type: "production", all_for_all: false,
      orders: [], hidden_count: 0, auto_routing: false, queue: [
        { no: "IA-9", planned_min: 30, status: "running" }, { no: "IA-1", planned_min: 20, status: "open" },
        { no: "IA-0", planned_min: 10, status: "done" }, { no: "IA-5", planned_min: 10, status: "cancelled" }] } });
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features: [] } });
    if (path.startsWith("/api/")) return route.fulfill({ status: 503, json: { detail: "Test" } });
    const file = path === "/twin/" || path === "/twin" ? "twin.html" : path.replace(/^\/twin\//, "");
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  await page.goto("http://internal.test/twin/");
  await page.locator(".floor-station").first().waitFor();

  const facts = await page.locator(".floor-station").evaluateAll(nodes => Object.fromEntries(nodes.map(g => {
    const label = g.getAttribute("aria-label");
    return [label.split(",")[0], { label, status: g.dataset.status, certainty: g.dataset.certainty,
      bar: g.querySelector(".twin-load-fill") ? +g.querySelector(".twin-load-fill").getAttribute("width") : null,
      hatch: !!g.querySelector(".twin-hatch"), text: g.textContent }];
  })));

  // Die Hälfte ist nicht überbucht, auch wenn die Nachbarin doppelt so voll ist.
  assert.equal(facts.Halb.status, "wartet", "Last misst an der Kapazität, nicht an der vollsten Station");
  assert.ok(Math.abs(facts.Halb.bar - 2) < 0.01, `Halb: ${facts.Halb.bar}`);
  assert.equal(facts.Voll.status, "ueber", "Über der Tageskapazität ist überbucht");
  assert.equal(facts.Voll.hatch, true);
  assert.ok(Math.abs(facts.Voll.bar - 4) < 0.01);

  // Unbekannte Kapazität: keine Prozentzahl, nicht überbucht, obwohl die Last die größte ist.
  assert.equal(facts.Packtisch.status, "unbekannt", "Ohne Kapazität kein Überbucht");
  assert.ok(!facts.Packtisch.label.includes("%"), facts.Packtisch.label);
  assert.ok(facts.Packtisch.label.includes("Kapazität unbekannt"), facts.Packtisch.label);

  // Die Last steht im Namen der Station, geschätzt, und die Minuten kommen vom Packtisch und Regal.
  assert.ok(facts.Halb.label.includes("geschätzt") && facts.Halb.label.includes("von") && facts.Halb.label.includes("50 %"), facts.Halb.label);
  assert.ok(facts.Regal.label.includes("9 %"), facts.Regal.label);
  assert.ok(facts.Stumm.label.includes("Dauer unbekannt"), `0 Minuten bei offenen Aufgaben: ${facts.Stumm.label}`);
  assert.ok(facts.Frei.label.includes("frei"), facts.Frei.label);

  // Offene Arbeit ohne Dauer ist ein Fragezeichen, nie „0 min", und sieht nicht frei aus.
  assert.equal(facts.Stumm.status, "unbekannt");
  assert.equal(facts.Stumm.certainty, "unknown");
  assert.ok(facts.Stumm.text.includes("?"), facts.Stumm.text);
  assert.ok(!facts.Stumm.text.includes("0 min"), facts.Stumm.text);
  assert.equal(facts.Frei.status, "frei");
  assert.ok(!facts.Frei.text.includes("?"), facts.Frei.text);

  // Vermutung, nicht Meldung.
  assert.ok(!(await page.locator("body").innerText()).includes("aufgespannt"));

  await page.locator(".lage-station", { hasText: "Voll" }).click();
  await page.locator(".twin-inspector dt", { hasText: "Zuletzt eingeplant" }).waitFor();
  // Die Schlange zeigt nur Offenes, in der Reihenfolge der Antwort.
  await page.locator(".twin-queue .mono").first().waitFor();
  assert.deepEqual(await page.locator(".twin-queue .mono").allInnerTexts(), ["IA-9", "IA-1"]);
  assert.ok(!(await page.locator(".twin-inspector").innerText()).includes("ufgespannt"));
  await page.getByRole("button", { name: "Zurück zur Lage" }).click();
  await page.locator(".twin-inspector").waitFor({ state: "detached" });
  await page.locator(".lage-station", { hasText: "Stumm" }).click();
  const planned = await page.locator(".twin-inspector dt", { hasText: "Eingeplant" }).locator("xpath=../dd").innerText();
  assert.ok(planned.includes("Dauer unbekannt"), planned);
  assert.ok(!/^0\s*min/.test(planned), planned);
  assert.deepEqual(errors, []);
  console.log("Map load checks passed: capacity heat, unknown capacity, aria text, badge unit, wording.");
} finally {
  await browser.close();
}
