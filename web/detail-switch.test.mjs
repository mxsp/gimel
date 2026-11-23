// Detailstufe „Einfach | Alles" (Aufgabe 35 A/D/G): node detail-switch.test.mjs [build-directory]
// Teil 1 ohne Browser: parseDetail, readDetail/setDetail mit und ohne Speicher, kpiText, splitKpis.
// Teil 2 im Browser (gebaute App): Schalter, Vorgabe Einfach, Wahl bleibt, Kennzahlen 4 + „Mehr", Erste Schritte.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const dist = process.argv[2] ?? "../gimel/webapp/dist";

// --- Teil 1: reine Logik -----------------------------------------------------
const store = new Map();
let broken = false;
globalThis.localStorage = {
  getItem: (k) => { if (broken) throw new Error("gesperrt"); return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { if (broken) throw new Error("gesperrt"); store.set(k, String(v)); },
  removeItem: (k) => { if (broken) throw new Error("gesperrt"); store.delete(k); },
};
const out = await build({
  stdin: {
    contents: `export * from "./src/ui/detail.ts"; export { kpiText, splitKpis, SIMPLE_KPIS } from "./src/ui/KpiStrip.tsx";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent", jsx: "automatic",
  nodePaths: [process.cwd() + "/node_modules"],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

assert.equal(m.parseDetail(null), "einfach", "Vorgabe für alle: Einfach");
assert.equal(m.parseDetail("alles"), "alles");
assert.equal(m.parseDetail("keller"), "einfach", "Unsinn im Speicher gilt als Vorgabe");
assert.equal(m.readDetail(), "einfach");
m.setDetail("alles");
assert.equal(store.get(m.DETAIL_KEY), "alles");
assert.equal(m.readDetail(), "alles");
m.setDetail("einfach");
assert.equal(store.has(m.DETAIL_KEY), false, "Einfach ist die Vorgabe und wird nicht gespeichert");
broken = true;
assert.equal(m.readDetail(), "einfach", "ohne Speicher: Einfach");
m.setDetail("alles"); // wirft nicht
assert.equal(m.readFlag("x"), null);
m.writeFlag("x", true); // wirft nicht
broken = false;
m.writeFlag("x", true);
assert.equal(m.readFlag("x"), true);
m.writeFlag("x", false);
assert.equal(m.readFlag("x"), false);
m.writeFlag("x", null);
assert.equal(m.readFlag("x"), null);

// Unbekannt bleibt unbekannt, nie 0.
assert.equal(m.kpiText(null), "unbekannt");
assert.equal(m.kpiText(undefined), "unbekannt");
assert.equal(m.kpiText(Number.NaN), "unbekannt");
assert.equal(m.kpiText(""), "unbekannt");
assert.equal(m.kpiText(0), "0", "eine echte Null bleibt 0");
assert.equal(m.kpiText(1234.5, "m"), "1.234,5 m");
// Höchstens vier in Einfach; als primary markierte gehen vor, die Reihenfolge bleibt.
const items = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, primary: id === "f" }));
const simple = m.splitKpis(items, true);
assert.deepEqual(simple.shown.map((k) => k.id), ["a", "b", "c", "f"]);
assert.deepEqual(simple.rest.map((k) => k.id), ["d", "e"]);
assert.equal(m.splitKpis(items, false).rest.length, 0, "Alles zeigt alle");
assert.equal(m.splitKpis(items.slice(0, 4), true).rest.length, 0);
assert.deepEqual(m.splitKpis(items, true, 3).shown.map((k) => k.id), ["a", "b", "f"], "Station: drei");

// --- Teil 2: im Browser ----------------------------------------------------------
const api = {
  "/api/admin/orders": { total: 0, items: [] },
  "/api/factory/worklist": { kinds: {}, pool: [], stations: [] },
  "/api/factory/picking": { kinds: {}, pool: [], stations: [], materials: [] },
  "/api/admin/stats": { orders: 3, positions_pending: 1, work_orders_open: 2, work_orders_running: 0, saved_pct_30d: 0 },
};
const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await context.addInitScript(() => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
  });
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features: [] } });
    if (path.startsWith("/api/")) return route.fulfill({ json: api[path] ?? [] });
    const file = path === "/app/" ? "index.html" : path.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  await page.goto("http://internal.test/app/#/heute");
  const sw = page.getByRole("group", { name: "Detailstufe" });
  const pressed = (name) => sw.getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
  await sw.waitFor();
  assert.equal(await pressed("Einfach"), "true", "Vorgabe Einfach");
  assert.equal(await pressed("Alles"), "false");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.detail), "einfach");

  // Kennzahlen auf Heute: vier, die fünfte hinter „Mehr Kennzahlen"; Zahlen mit Liste sind Links.
  const kpis = page.locator(".heute-kpis .ui-kpi");
  await kpis.first().waitFor();
  assert.equal(await kpis.count(), 4);
  assert.equal(await page.locator('.heute-kpis a[data-kpi="orders"]').getAttribute("href"), "#/auftraege");
  await page.getByRole("button", { name: /Mehr Kennzahlen \(1\)/ }).click();
  assert.equal(await kpis.count(), 5);

  // Erste Schritte: drei Schritte mit Link; schließen bleibt gemerkt.
  const steps = page.getByRole("region", { name: "Erste Schritte" });
  assert.equal(await steps.locator("li a").count(), 3);
  assert.equal(await steps.locator("li a").first().getAttribute("href"), "/twin/#/admin", "Admin: zuerst die Halle");

  // Umschalten: alle Komponenten folgen, die Wahl überlebt ein Neuladen.
  await sw.getByRole("button", { name: "Alles", exact: true }).click();
  assert.equal(await pressed("Alles"), "true");
  assert.equal(await kpis.count(), 5, "Alles zeigt alle Zahlen");
  assert.equal(await page.getByRole("button", { name: /Mehr Kennzahlen/ }).count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("gimel-detail")), "alles");
  await steps.getByRole("button", { name: "Erste Schritte ausblenden" }).click();
  await steps.waitFor({ state: "detached" });
  await page.reload();
  await sw.waitFor();
  assert.equal(await pressed("Alles"), "true", "Wahl bleibt nach dem Neuladen");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.detail), "alles");
  await page.locator(".heute-kpis .ui-kpi").first().waitFor();
  assert.equal(await page.getByRole("region", { name: "Erste Schritte" }).count(), 0, "geschlossen bleibt geschlossen");

  // Das Benutzermenü holt die Karte zurück.
  await page.getByRole("button", { name: /^Benutzermenü/ }).click();
  await page.getByRole("menuitem", { name: "Erste Schritte zeigen" }).click();
  await page.getByRole("region", { name: "Erste Schritte" }).waitFor();

  // (i) „Wie funktioniert das?" auf der Seite.
  await page.getByRole("button", { name: "Wie funktioniert das?" }).first().click();
  await page.locator(".ui-page-info").getByText("Oben steht, was heute brennt", { exact: false }).waitFor();
  await page.keyboard.press("Escape");

  // Zurück auf Einfach: der Speicher wird geleert.
  await sw.getByRole("button", { name: "Einfach", exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem("gimel-detail")), null);
  assert.equal(await page.locator(".heute-kpis .ui-kpi").count(), 4);

  // Werkzeuge in der Leiste: zu, auf Klick offen, gemerkt; eine Werkzeug-Seite öffnet sie selbst.
  // (Heute im Leitstand: der Grundriss selbst braucht echte Daten, die diese Attrappe nicht liefert.)
  await page.locator(".area-switch").getByRole("link", { name: "Leitstand", exact: true }).click();
  await page.evaluate(() => { location.hash = "/heute"; });
  await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.area === "leitstand");
  const toggle = page.locator(".sidebar-group-toggle");
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator(".app-sidebar").getByRole("link", { name: "Roboter", exact: true }).count(), 0);
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await page.locator(".app-sidebar").getByRole("link", { name: "Roboter", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("gimel-nav-tools")), "1");
  await toggle.click();
  assert.equal(await page.evaluate(() => localStorage.getItem("gimel-nav-tools")), "0");
  await page.evaluate(() => { location.hash = "/zeichnungen"; });
  await page.locator('.app-sidebar [aria-current="page"]', { hasText: "Zeichnungen" }).waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "offene Werkzeug-Seite öffnet die Gruppe");

  // Telefon: kein waagerechtes Scrollen durch Schalter oder Menü.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => { location.hash = "/heute"; });
  await page.locator(".heute-kpis .ui-kpi").first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await sw.waitFor();

  assert.deepEqual(errors, []);
  await context.close();
  console.log("Detail switch passed: parse/store, unknown never 0, 4 + Mehr, switch, reload, first steps, (i), Werkzeuge, phone.");
} finally {
  await browser.close();
}
