// Run after npm run build: node heute.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const hoursAgo = h => new Date(Date.now() - h * 3_600_000).toISOString();
const order = (no, extra = {}) => ({ no, customer: "Muster AG", customer_ref: "PO-1", due_date: hoursAgo(-48), blocked: false, released: true, rush: false, status: "in_produktion", n_manual: 0, work_orders: [], ...extra });
const station = (id, label, extra = {}, slots = []) => ({ id, label, type: "production", active: true, queue_min: 0, capacity_min_per_day: 450, ...extra, schedule: { slots, total_min: 0, late: [] } });
const slot = { ref: "IA-1", kind: "cut", label: "EPDM", mat: "epdm", mat_name: "EPDM", thk: 2, orders: [], started: true, late: false };
const busy = {
  "/api/admin/orders": { total: 3, items: [order("AB-1", { due_date: hoursAgo(26) }), order("AB-2", { blocked: true }), order("AB-3", { status: "versand", due_date: hoursAgo(99) })] },
  "/api/factory/worklist": { kinds: {}, pool: [], stations: [station(1, "Plotter", {}, [slot]), station(2, "Stanze", { active: false }, [{ ...slot, ref: "IA-2", started: false }])] },
  "/api/factory/picking": { kinds: {}, pool: [], stations: [], materials: [{ mat: "epdm", mat_name: "EPDM", thk: 2, plates: 1, stock: 0, lead_days: 1, short: true }] },
  "/api/admin/stats": { orders: 3, positions_pending: 0, work_orders_open: 2, work_orders_running: 0, saved_pct_30d: 0 },
};
const quiet = {
  "/api/admin/orders": { total: 0, items: [] },
  "/api/factory/worklist": { kinds: {}, pool: [], stations: [] },
  "/api/factory/picking": { kinds: {}, pool: [], stations: [], materials: [] },
  "/api/admin/stats": busy["/api/admin/stats"],
};

const browser = await chromium.launch();
async function open(api, { features = [], scheme = "light", failing = "" } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
  });
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === failing) return route.fulfill({ status: 500, json: { detail: "kaputt" } });
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features } });
    if (path.startsWith("/api/")) return route.fulfill({ json: api[path] ?? [] });
    const file = path === "/app/" ? "index.html" : path.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    await route.fulfill({ body: await readFile(resolve("../gimel/webapp/dist", file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  return { page, errors, context };
}

try {
  // Was brennt, steht da, und jede Zeile führt dorthin, wo es erledigt wird.
  let { page, errors, context } = await open(busy);
  await page.goto("http://internal.test/app/#/heute");
  const late = page.locator("#heute-ueberfaellig").locator("xpath=..");
  await late.getByText("1 Tag überfällig").waitFor();
  assert.equal(await late.locator("a.heute-row").getAttribute("href"), "#/auftraege/AB-1");
  assert.match(await late.innerText(), /Eingeplant/, "A planned order is not reported as running");
  assert.doesNotMatch(await late.innerText(), /AB-3/, "Shipped orders are not late any more");
  const blocked = page.locator("#heute-blockiert").locator("xpath=..");
  assert.match(await blocked.innerText(), /AB-2/);
  assert.equal(await blocked.getByRole("link", { name: /Stanze/ }).getAttribute("href"), "#/grundriss/station/2");
  assert.match(await page.locator("#heute-material").locator("xpath=..").innerText(), /1 Platte nötig, 0 am Lager, Nachschub 1 Tag/);
  const next = await page.locator("#heute-naechstes").locator("xpath=..").innerText();
  assert.match(next, /IA-1/);
  assert.match(next, /läuft/);
  assert.match(next, /Dauer unbekannt/, "0 minutes means unknown, not nothing to do");

  // Tastatur: nicht beim Tippen, sonst ja.
  await page.keyboard.press("/");
  // Seit Aufgabe 35 öffnet „/" die Palette „Suchen & springen"; sie zeichnet einen Takt
  // später. Auf den Fokus warten statt ihn einmal zu lesen (lief sonst gelegentlich rot).
  await page.waitForFunction(() => document.activeElement?.id === "global-search", null, { timeout: 5000 });
  await page.keyboard.type("ga");
  assert.equal(await page.evaluate(() => location.hash), "#/heute");
  await page.locator("#global-search").fill("");
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  await page.waitForFunction(() => location.hash === "#/auftraege");
  await page.goto("http://internal.test/app/#/formen");
  await page.getByText("Nicht verfügbar", { exact: true }).waitFor({ timeout: 1000 });
  assert.deepEqual(errors, []);
  await context.close();

  // Ehrlich leer.
  ({ page, errors, context } = await open(quiet));
  await page.goto("http://internal.test/app/#/heute");
  await page.getByText("Nichts überfällig").waitFor();
  await page.getByText("Nichts blockiert").waitFor();
  assert.deepEqual(errors, []);
  await context.close();

  // Eine Quelle fällt aus: kein „nichts", sondern der Hinweis.
  ({ page, errors, context } = await open(quiet, { failing: "/api/admin/orders" }));
  await page.goto("http://internal.test/app/#/heute");
  await page.getByText("Nicht aktuell: Aufträge", { exact: false }).waitFor();
  assert.equal(await page.getByText("Nichts überfällig").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();

  // Folgt dem System, bis von Hand gewählt wird; die Wahl bleibt.
  ({ page, errors, context } = await open(quiet, { scheme: "dark" }));
  await page.goto("http://internal.test/app/#/heute");
  await page.getByText("Nichts überfällig").waitFor();
  const dark = () => page.evaluate(() => document.body.classList.contains("bp5-dark"));
  assert.equal(await dark(), true);
  await page.getByRole("button", { name: /Darstellung/ }).click();
  assert.equal(await dark(), false, "First click chooses light");
  await page.reload();
  await page.getByText("Nichts überfällig").waitFor();
  assert.equal(await dark(), false, "The choice survives a reload");
  assert.deepEqual(errors, []);
  console.log("Heute passed: late, blocked, material, next, links, empty and failed sources, shortcuts, plugin screen, theme.");
} finally {
  await browser.close();
}
