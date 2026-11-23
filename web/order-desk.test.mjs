// Run against a built internal app: node order-desk.test.mjs <build-directory>
// Playwright intercepts all requests; no application server or backend is started.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

assert.ok(process.argv[2], "Pass the internal Vite build directory");
const buildDir = resolve(process.argv[2]);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
let submitted;
const shape = { type: "poly", outer: [[0, 0], [80, 0], [80, 40], [0, 40]], holes: [] };
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  localStorage.setItem("gimel-token", "test-token");
  localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
  const fetch = window.fetch.bind(window);
  window.__quotes = [];
  // Deliberately ignore AbortSignal to also exercise the late-response guard.
  window.fetch = (url, options) => String(url) === "/api/quote"
    ? new Promise((resolve) => window.__quotes.push({ input: JSON.parse(options.body), resolve }))
    : fetch(url, options);
});
await page.route("**/*", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.startsWith("/api/")) {
    let json;
    if (path === "/api/customers") json = [];
    else if (path === "/api/products") json = [{ id: "epdm", name: "EPDM", thicknesses: [3], eur_m2: 10 }];
    else if (path === "/api/invoicing/config") json = { configured: true };
    else if (path === "/api/version") json = { name: "gimel", features: ["library"] };
    else if (path === "/api/factory/topology") json = { sites: [], unsited_halls: [], unassigned_floors: [], default_floor_id: null, default_site_id: null };
    else if (path === "/api/desk/dxf") json = { shape, od: 90, di: 0, cut_len: 240, w: 80, h: 40, filename: "part.dxf", skipped: [] };
    else if (path === "/api/desk/orders") {
      submitted = route.request().postDataJSON();
      json = {
        no: "TEST-1", kind: submitted.kind, internal_owner: submitted.internal_owner ?? "",
        gross: 23.8, net: 20, released: true, paid: false, invoice_no: "",
      };
    } else throw new Error(`Unexpected API request: ${path}`);
    await route.fulfill({ json });
    return;
  }
  assert.ok(path.startsWith("/app/"), `Unexpected asset: ${path}`);
  const file = path === "/app/" ? "index.html" : path.slice(5);
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2" };
  await route.fulfill({ body: await readFile(resolve(buildDir, file)), contentType: mime[extname(file)] || "application/octet-stream" });
});

const header = (n) => page.locator(`#desk-step-${n}`);
const panel = (n) => page.locator(`#desk-panel-${n}`);
const button = (name) => page.getByRole("button", { name, exact: true });
const waitQuotes = (n) => page.waitForFunction((n) => window.__quotes.length >= n, n);
const answer = (index, gross = 23.8, status = 200) => page.evaluate(({ index, gross, status }) => {
  window.__quotes[index].resolve(new Response(JSON.stringify(status === 200
    ? { total: gross / 1.19, gross, vat: gross - gross / 1.19, mat_c: 0, cut_c: 0, setup: 0, custom_c: gross / 1.19, cert: 0, freight: 0, per: {} }
    : { detail: "Test: Preis nicht verfuegbar" }), { status, headers: { "Content-Type": "application/json" } }));
}, { index, gross, status });

try {
  await page.goto("http://internal.test/app/#/auftragserfassung");
  await panel(1).waitFor({ state: "visible" });
  assert.equal(await panel(2).isVisible(), false);
  await header(1).focus();
  await page.keyboard.press("Space");
  assert.equal(await header(1).getAttribute("aria-expanded"), "false");
  await page.keyboard.press("Enter");
  assert.equal(await header(1).getAttribute("aria-expanded"), "true");
  await page.getByText("Neuen Kunden anlegen", { exact: true }).click();
  await page.locator("#desk-customer-email").fill("invalid");
  assert.equal(await button("Weiter zu Positionen").isEnabled(), false);
  await page.locator("#desk-customer-email").fill("desk@example.test");
  await button("Weiter zu Positionen").click();
  assert.equal(await header(2).evaluate((el) => el === document.activeElement), true);
  await button("Freie Position").click();
  await waitQuotes(1);
  assert.match(await header(2).innerText(), /Offen/);
  await panel(2).locator('input[title="Bruttopreis je St\u00fcck"]').fill("20");
  await waitQuotes(2);
  await answer(1);
  await panel(2).getByText("Brutto 23,80", { exact: false }).waitFor();
  await answer(0, 999);
  await page.waitForTimeout(50);
  assert.doesNotMatch(await header(2).innerText(), /999/);
  await button("Zur\u00fcck zu Kunde").click();
  assert.equal(await header(1).evaluate((el) => el === document.activeElement), true);
  assert.equal(await page.locator("#desk-customer-email").inputValue(), "desk@example.test");
  await page.locator("#desk-customer-email").fill("");
  assert.match(await header(1).innerText(), /Offen/);
  await page.locator("#desk-customer-email").fill("desk@example.test");
  await header(2).click();

  // A full imported contour survives folding and the final POST unchanged.
  await panel(2).locator('input[type="file"][accept=".dxf,.txt"]').setInputFiles({ name: "part.dxf", mimeType: "application/dxf", buffer: Buffer.from("fixture") });
  await waitQuotes(3);
  await answer(2);
  await button("Weiter zu Lieferanschrift & Rechnung").click();
  await page.locator("#desk-ship-street").fill("Testweg 1");
  await page.locator("#desk-ship-city").fill("Leipzig");
  await button("Weiter zur Pr\u00fcfung").click();
  await button("Auftrag anlegen").waitFor();
  assert.equal(await button("Auftrag anlegen").isEnabled(), true);
  assert.match(await panel(4).innerText(), /desk@example.test/);
  await header(3).click();
  await panel(3).locator("select").selectOption("3.1");
  await header(4).click();
  assert.equal(await button("Auftrag anlegen").isEnabled(), false);
  await waitQuotes(4);
  await answer(3, 0, 503);
  await page.getByText("Preisberechnung fehlgeschlagen", { exact: true }).waitFor();
  await button("Erneut berechnen").click();
  await waitQuotes(5);
  await answer(4);
  await page.waitForFunction(() => !document.querySelector('#desk-panel-4 button.bp5-intent-primary').disabled);

  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await header(2).click();
    const contained = await page.evaluate(() => {
      const main = document.querySelector(".app-main");
      const table = document.querySelector(".desk-line-table");
      return main.scrollWidth <= main.clientWidth + 1
        && document.documentElement.scrollWidth <= window.innerWidth + 1
        && table.getBoundingClientRect().right <= main.getBoundingClientRect().right;
    });
    assert.ok(contained, `Horizontal overflow at ${width}px`);
    await header(4).click();
  }
  await button("Auftrag anlegen").click();
  await page.getByRole("dialog", { name: "Auftrag angelegt" }).waitFor();
  assert.equal(submitted.new_customer.email, "desk@example.test");
  assert.equal(submitted.cert, "3.1");
  assert.deepEqual(submitted.lines[1].shape, shape);
  assert.equal(submitted.lines[1].cut_len, 240);
  await button("Schlie\u00dfen").click();
  await panel(1).waitFor({ state: "visible" });
  assert.match(await header(2).innerText(), /Noch keine Positionen/);

  await header(2).click();
  await button("Freie Position").click();
  await panel(2).locator('input[title="Bruttopreis je St\u00fcck"]').fill("20");
  assert.match(await header(2).innerText(), /Vollst\u00e4ndig/);
  await panel(2).locator('input[type="number"]').first().fill("0");
  assert.match(await header(2).innerText(), /Offen/);
  await page.waitForFunction(() => window.__quotes.at(-1)?.input.lines[0].q === 0);
  const latest = await page.evaluate(() => window.__quotes.length - 1);
  await button("Position Sonderfertigung entfernen").click();
  await answer(latest, 999);
  await page.waitForTimeout(50);
  assert.match(await header(2).innerText(), /Noch keine Positionen/);
  assert.equal(await page.getByText("Preis wird neu berechnet.", { exact: false }).isVisible(), false);
  await header(4).click();
  assert.equal(await button("Auftrag anlegen").isEnabled(), false);
  assert.doesNotMatch(await panel(4).innerText(), /999/);

  // Interner Auftrag: kein Kunde, keine Zahlung — dafür ein Verantwortlicher.
  await page.getByText("Intern — ohne Kunde und Zahlung, mit verantwortlichem Mitarbeiter", { exact: true }).click();
  await panel(1).waitFor({ state: "visible" });
  await page.locator("#desk-internal-owner").fill("Meister Meier");
  await button("Weiter zu Positionen").click();
  const quoteBefore = await page.evaluate(() => window.__quotes.length);
  await button("Freie Position").click();
  await page.waitForFunction((n) => window.__quotes.length > n, quoteBefore);
  await answer(quoteBefore);
  await panel(2).locator('input[title="Bruttopreis je St\u00fcck"]').fill("20");
  await page.waitForFunction((n) => window.__quotes.length > n, quoteBefore + 1);
  await answer(quoteBefore + 1);
  await button("Weiter zu Fertigung").click();
  await panel(3).getByText("Interner Auftrag", { exact: true }).waitFor();
  assert.equal(await panel(3).locator("#desk-ship-street").count(), 0);
  assert.equal(await panel(3).getByText("Zahlungsweg", { exact: true }).count(), 0);
  await button("Weiter zur Pr\u00fcfung").click();
  assert.match(await panel(4).innerText(), /Verantwortlich/);
  assert.doesNotMatch(await panel(4).innerText(), /Lieferanschrift/);
  await button("Auftrag anlegen").click();
  await page.getByRole("dialog", { name: "Auftrag angelegt" }).waitFor();
  assert.equal(submitted.kind, "internal");
  assert.equal(submitted.internal_owner, "Meister Meier");
  assert.equal(submitted.customer_id, undefined);
  assert.equal(submitted.new_customer, undefined);
  assert.equal(submitted.ship_address, undefined);
  assert.equal(submitted.payment_mode, undefined);
  await page.getByRole("dialog", { name: "Auftrag angelegt" })
    .getByText("Interner Auftrag", { exact: true }).waitFor();
  await button("Schlie\u00dfen").click();
  await panel(1).waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  console.log("OrderDesk passed: keyboard folding, navigation, draft-derived completion, stale quote guard, retry, review, geometry payload, reset and responsive containment.");
} finally {
  await browser.close();
}
