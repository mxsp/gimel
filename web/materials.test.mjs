// Run after npm run build: node materials.test.mjs <build-directory>
// Playwright intercepts all requests; no application server or backend is started.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

assert.ok(process.argv[2], "Pass the internal Vite build directory");
const buildDir = resolve(process.argv[2]);
const product = {
  id: "epdm-70", name: "EPDM 70 Shore", short: "EPDM", cat: "elastomer", brand: "",
  colour: "#2f3b46", eur_m2: 20, eur_m2_thk: {}, sheets: [[1000, 1000]], thicknesses: [2],
  stock: 5, lead_days: 3, active: true, price_verified: true, plate_prices: [],
};
const matrix = { standard_sheets: [[1000, 1000], [1500, 1500]], rows: [product] };
const posted = [];

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features: [] } });
    if (path === "/api/products/matrix/view") return route.fulfill({ json: matrix });
    if (path === "/api/products" && route.request().method() === "POST") {
      posted.push(JSON.parse(route.request().postData() ?? "{}"));
      return route.fulfill({ status: 201, json: { id: "epdm-70-shore", name: "EPDM 70 Shore neu" } });
    }
    if (path.startsWith("/api/")) return route.fulfill({ json: [] });
    assert.ok(path.startsWith("/app/"), `Unexpected asset: ${path}`);
    const file = path === "/app/" ? "index.html" : path.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2" };
    await route.fulfill({ body: await readFile(resolve(buildDir, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });

  await page.goto("http://internal.test/app/#/werkstoffe");
  await page.getByRole("button", { name: "Neuer Werkstoff" }).click();
  const dialog = page.getByRole("dialog", { name: "Neuer Werkstoff" });
  await dialog.waitFor();

  await dialog.getByRole("textbox", { name: "Name *" }).fill("EPDM 70 Shore neu");
  assert.equal(await dialog.getByRole("textbox", { name: "Werkstoff-ID *" }).inputValue(),
               "epdm-70-shore-neu", "die ID folgt dem Namen, solange niemand sie anfasst");
  await dialog.getByRole("checkbox", { name: "1000 × 1000" }).check({ force: true });
  await dialog.getByRole("spinbutton", { name: "Bezugspreis €/m² *" }).fill("42");
  await dialog.getByRole("textbox", { name: "Dicken (mm, kommagetrennt)" }).fill("2, 3");
  await dialog.getByRole("button", { name: "Anlegen" }).click();

  await page.waitForFunction(() => document.querySelector(".bp5-dialog") === null);
  assert.equal(posted.length, 1, "genau ein Anlegen-Aufruf");
  assert.equal(posted[0].id, "epdm-70-shore-neu");
  assert.equal(posted[0].eur_m2, 42);
  assert.deepEqual(posted[0].sheets, [[1000, 1000]]);
  assert.deepEqual(posted[0].thicknesses, [2, 3]);
  assert.equal(posted[0].cat, "elastomer");
  assert.equal(posted[0].active, true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
