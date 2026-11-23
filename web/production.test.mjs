// Run after npm run build: node production.test.mjs ../gimel/webapp/dist
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] ?? "../gimel/webapp/dist";
const wo = (no, extra = {}) => ({ no, mat: "EPDM", mat_name: "EPDM 70 Shore", thk: 2, status: "open", n_plates: 2, n_parts: 12, n_orders: 3, utilisation: 0.47,
  created_at: "2026-10-31T10:00:00Z", release_reason: "Von Hand ausgelöst", material_staged_at: null, material_staged_by: "", ...extra });
const list = [
  wo("IA-1", { mat_name: "Sehr langer Werkstoffname mit Einlage aus Graphit und noch mehr Text", thk: 1.5 }),
  wo("IA-2", { material_staged_at: "2026-10-31T11:00:00Z", material_staged_by: "Muster" }),
  wo("IA-3", { status: "running" }),
  wo("IA-4", { status: "running", material_staged_at: "2026-10-31T11:00:00Z" }),
  wo("IA-5", { status: "done" }),
];
const detailOf = w => ({ ...w, id: 1, run_no: "SL-1", fmt: [2000, 1000], formats: [[2000, 1000, 2]], engine_version: "lite", machine: "", policy_mode: "normal",
  nest_options: { gap: 3, margin: 5, trim_w: 0, trim_h: 0, usable: [1990, 990] }, order_done: {}, started_at: null, started_by: "", done_at: null, done_by: "",
  plates: [{ id: 1, idx: 0, fmt: [2000, 1000], used_h: 500, n_parts: 2, utilisation: 0.5, status: "open", items: [
    { tag: "A1", order_no: "AB-1", customer: "Muster AG", customer_ref: "", label: "Ring", od: 100, di: 50, from_remnant: false, position_id: 1 }] }],
  by_order: [{ order_no: "AB-1", customer: "Muster AG", customer_ref: "PO", plates: [1], n_parts: 2, n_positions: 1, position_ids: [1], due_date: null, rush: false, cert: "", complete: true, done: false, done_at: null }],
  by_part: [{ position_id: 1, label: "Ring", order_no: "AB-1", customer: "Muster AG", od: 100, di: 50, qty: 2, n_from_remnant: 0, plates: [1], thk: 2, bolt_count: 0, bolt_d: 0, bolt_circle: 0, cut_len: 1000, has_shape: false }],
  cut_plan: { layered: false, strategy: "", label: "Automatisch", machine_kind: "", grip: "griffig", mandatory: false, reason: "Regel", warning: "", choices: [{ value: "auto", label: "Automatisch", warning: "" }] } });

const browser = await chromium.launch();
const errors = [];

async function open({ width = 1280, height = 800, touch = false, scheme = "light" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, colorScheme: scheme });
  const page = await context.newPage();
  const posts = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("503")) errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
  });
  await page.route("**/*", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "POST") { posts.push(`${path} ${req.postData()}`); return route.fulfill({ json: {} }); }
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features: [] } });
    if (path === "/api/production/work-orders") return route.fulfill({ json: list });
    const one = /^\/api\/production\/work-orders\/([^/]+)$/.exec(path);
    if (one) return route.fulfill({ json: detailOf(list.find(w => w.no === one[1])) });
    if (path.endsWith(".svg")) return route.fulfill({ body: "<svg xmlns='http://www.w3.org/2000/svg'/>", contentType: "image/svg+xml" });
    if (path.startsWith("/api/")) return route.fulfill({ status: 503, json: { detail: "Test" } });
    const file = path === "/app/" ? "index.html" : path.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  await page.goto("http://internal.test/app/#/produktion");
  return { page, posts, close: () => context.close() };
}

const noOverflow = page => page.evaluate(() => {
  const main = document.querySelector(".app-main");
  return document.documentElement.scrollWidth <= document.documentElement.clientWidth && main.scrollWidth <= main.clientWidth;
});
const posted = async (posts, line) => { for (let i = 0; i < 100 && !posts.some(p => p.startsWith(line)); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(posts.some(p => p.startsWith(line)), line); };

try {
  // Laufendes zuerst und abgesetzt, dann Wartendes; je Zeile eine Hauptaktion.
  {
    const { page, posts, close } = await open();
    const running = page.locator('tbody[data-group="running"]');
    await running.waitFor();
    assert.deepEqual(await page.locator("tbody[data-group]").evaluateAll(b => b.map(x => x.dataset.group)), ["running", "waiting"]);
    assert.match(await running.locator(".prod-group").innerText(), /Läuft \(2\)/);
    assert.equal(await running.locator("tr.prod-running").count(), 2);
    assert.equal(await page.locator(".prod-table thead th").count(), 6);

    // Eine Zeile hoch, auch mit langem Werkstoff; der ganze Name steht im title.
    const long = page.locator("#wo-IA-1");
    assert.ok((await long.boundingBox()).height <= 44, "einzeilig");
    const cell = long.locator("td").nth(1);
    assert.match(await cell.getAttribute("title"), /Sehr langer .* · 1,5 mm$/);
    assert.equal(await cell.evaluate(c => getComputedStyle(c).textOverflow), "ellipsis");
    const reason = await long.locator("td.prod-reason").evaluate(c => parseFloat(getComputedStyle(c).fontSize));
    assert.ok(reason >= 13, "Freigabegrund lesbar");

    // Hauptaktion je Zustand, die anderen Schritte bleiben mit Namen da.
    const primary = no => page.locator(`#wo-${no} .prod-primary`).getAttribute("aria-label");
    assert.equal(await primary("IA-1"), "Material bereitstellen: IA-1");
    assert.equal(await primary("IA-2"), "Starten: IA-2");
    assert.equal(await primary("IA-3"), "Ganz fertig: IA-3");
    for (const name of ["Starten: IA-1", "Ganz fertig: IA-1", "Bereitstellung zurücknehmen: IA-2", "Ganz fertig: IA-2", "Material bereitstellen: IA-3"]) {
      await page.getByRole("button", { name, exact: true }).waitFor();
    }
    await page.getByRole("button", { name: "Starten: IA-1", exact: true }).hover();
    await page.locator(".bp5-tooltip", { hasText: "Starten" }).waitFor();

    await page.getByRole("button", { name: "Material bereitstellen: IA-1", exact: true }).click();
    await posted(posts, '/api/production/work-orders/IA-1/stage {"staged":true}');
    await page.getByRole("button", { name: "Starten: IA-1", exact: true }).click();
    await posted(posts, '/api/production/work-orders/IA-1/status {"status":"running"}');
    await page.getByRole("button", { name: "Ganz fertig: IA-3", exact: true }).click();
    await posted(posts, '/api/production/work-orders/IA-3/status {"status":"done"}');
    await close();
  }

  // Tastatur: die Nummer öffnet die Einzelheiten direkt unter der Zeile, dort steht der Rest.
  {
    const { page, close } = await open();
    const toggle = page.locator("#wo-IA-2 .prod-no");
    await toggle.focus();
    await page.keyboard.press("Enter");
    const detail = page.locator("#wo-IA-2 + tr.prod-detail");
    await detail.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    const facts = await detail.locator(".wo-facts").innerText();
    for (const word of ["Platten", "Aufträge", "Ausnutzung", "47 %", "Erstellt", "Freigabegrund"]) assert.ok(facts.includes(word), word);
    await detail.getByRole("button", { name: "Alle Schnittdateien (ZIP)" }).waitFor();
    assert.ok(await noOverflow(page));
    await page.keyboard.press("Enter");
    await detail.waitFor({ state: "detached" });
    await close();
  }

  // Ein Innenauftrag, den der Filter ausblendet, behält seine Einzelheiten unter der Liste.
  {
    const { page, close } = await open();
    await page.locator("#wo-IA-2 .prod-no").click();
    await page.locator("#wo-IA-2 + tr.prod-detail").waitFor();
    await page.getByLabel("Fertigungsaufträge filtern").selectOption("done");
    await page.locator('tbody[data-group="closed"]').waitFor();
    await page.locator(".detail-panel").waitFor();
    assert.equal(await page.locator(".prod-detail").count(), 0);
    await close();
  }

  // Telefon: Karten, keine Tabelle, 44 Pixel, kein waagerechtes Scrollen, auch mit offenen Einzelheiten.
  for (const scheme of ["light", "dark"]) {
    const { page, posts, close } = await open({ width: 375, height: 812, touch: true, scheme });
    await page.locator(".prod-card").first().waitFor();
    assert.equal(await page.locator(".prod-table").count(), 0);
    assert.deepEqual(await page.locator(".prod-group-phone").evaluateAll(s => s.map(x => x.dataset.group)), ["running", "waiting"]);
    const small = await page.locator(".prod-card button").evaluateAll(b => b.filter(x => x.getBoundingClientRect().height < 44).length);
    assert.equal(small, 0, "44 Pixel");
    assert.ok(await noOverflow(page));
    await page.getByRole("button", { name: "Starten: IA-2", exact: true }).click();
    await posted(posts, '/api/production/work-orders/IA-2/status {"status":"running"}');
    await page.locator("#wo-IA-1 .prod-card-open").click();
    await page.locator("#wo-IA-1 .detail-panel").waitFor();
    assert.ok(await noOverflow(page));
    await close();
  }

  assert.deepEqual(errors, []);
  console.log("Production checks passed: groups, one-line rows, primary actions, keyboard, detail, phone cards.");
} finally {
  await browser.close();
}
