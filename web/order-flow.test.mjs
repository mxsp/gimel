// Auftragsweg & Orderflow-Oberfläche: node order-flow.test.mjs [build-directory]
// Teil 1 ohne Browser: orderFlow.ts + heute.ts (Stufen, Überfälligkeit, nächster Schritt, Storno/Angehalten).
// Teil 2 im Browser (gebaute App): Pipeline-Leiste, Filter, Schublade (Nächster Schritt, Stepper, Büronotiz, Rückrollen-Dialog), hell/dunkel.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const dist = process.argv[2] ?? "../gimel/webapp/dist";

// --- Teil 1: reine Logik -----------------------------------------------------
const out = await build({
  stdin: {
    contents: `export * from "./src/orderFlow.ts"; export { buildToday } from "./src/heute.ts";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
  nodePaths: [process.cwd() + "/node_modules"],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const NOW = Date.parse("2026-11-20T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

const sampleOrders = [
  { no: "AB-1", customer: "Nord GmbH", customer_ref: "PO-1", due_date: hoursAgo(48), blocked: false, released: true, rush: true, status: "in_produktion", work_orders: [{ no: "IA-1", status: "running" }] },
  { no: "AB-2", customer: "Süd AG", customer_ref: "", due_date: hoursAgo(-36), blocked: true, released: false, rush: false, status: "gesperrt", work_orders: [] },
  { no: "AB-3", customer: "West KG", customer_ref: "", due_date: hoursAgo(72), blocked: false, released: false, rush: false, status: "storniert", cancelled_at: hoursAgo(10), work_orders: [] },
  { no: "AB-4", customer: "Ost GmbH", customer_ref: "", due_date: hoursAgo(-24), blocked: false, released: true, rush: false, status: "angehalten", held_at: hoursAgo(2), work_orders: [] },
  { no: "AB-5", customer: "Mitte GmbH", customer_ref: "", due_date: hoursAgo(96), blocked: false, released: true, rush: false, status: "abgeschlossen", paid: false, invoice_no: "", work_orders: [] },
  { no: "AB-6", customer: "Berg GmbH", customer_ref: "", due_date: hoursAgo(12), blocked: false, released: true, rush: false, status: "versandbereit", work_orders: [] },
];

// Stornierte und abgeschlossene Aufträge sind nie überfällig.
assert.equal(m.isOrderOverdue(sampleOrders[0], NOW), true, "laufender Auftrag über Termin ist überfällig");
assert.equal(m.isOrderOverdue(sampleOrders[2], NOW), false, "stornierter Auftrag ist nicht überfällig");
assert.equal(m.isOrderOverdue(sampleOrders[4], NOW), false, "abgeschlossener Auftrag ist nicht überfällig");
assert.equal(m.isOrderOverdue(sampleOrders[5], NOW), true, "versandbereiter Auftrag über Termin ist überfällig");

// Verdichtung über den Auftragsweg.
const summary = m.summarizeOrderFlow(sampleOrders, NOW);
assert.equal(summary.total, 6);
assert.equal(summary.active, 4, "abgeschlossen und storniert zählen nicht zu offen");
assert.equal(summary.held, 1);
assert.equal(summary.cancelled, 1);
assert.equal(summary.overdue, 2, "nur AB-1 und AB-6 sind überfällig");
assert.equal(summary.stages.find((s) => s.id === "eingang").count, 1);
assert.equal(summary.stages.find((s) => s.id === "fertigung").count, 1);
assert.equal(summary.stages.find((s) => s.id === "versandbereit").count, 1);
assert.equal(summary.stages.find((s) => s.id === "abgeschlossen").count, 1);

// Filter: offene und Stufenfilter.
assert.equal(m.matchesOrderFilter(sampleOrders[2], "aktiv"), false);
assert.equal(m.matchesOrderFilter(sampleOrders[4], "aktiv"), false);
assert.equal(m.matchesOrderFilter(sampleOrders[0], "stage:fertigung"), true);
assert.equal(m.matchesOrderFilter(sampleOrders[1], "stage:eingang"), true);

// Nächster Schritt: Rolle & Zustand beachten.
assert.equal(m.nextOrderStep(sampleOrders[0], true).route, "produktion/IA-1");
assert.equal(m.nextOrderStep(sampleOrders[1], true).action, "unblock");
assert.equal(m.nextOrderStep(sampleOrders[1], false).action, undefined, "Werker entsperren nicht");
assert.equal(m.nextOrderStep(sampleOrders[3], true).action, "resume");
assert.equal(m.nextOrderStep(sampleOrders[4], true).route, "buchhaltung/AB-5");
assert.equal(m.nextOrderStep(sampleOrders[5], false).route, "versand");

// Heute: stornierte Aufträge fehlen in Überfällig & Blockiert; angehaltene stehen klar als Angehalten.
const today = m.buildToday(sampleOrders, null, [], "lager", NOW);
assert.ok(!today.late.some((r) => r.ref === "AB-3"), "Stornierter Auftrag darf nicht in Überfällig stehen");
assert.ok(!today.blocked.some((r) => r.ref === "AB-3"), "Stornierter Auftrag darf nicht in Blockiert stehen");
const heldRow = today.blocked.find((r) => r.ref === "AB-4");
assert.ok(heldRow && heldRow.tag === "Angehalten", "Angehaltener Auftrag erscheint unter Blockiert mit Tag Angehalten");

// --- Teil 2: im Browser ------------------------------------------------------
const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
  });

  const orderItems = [
    {
      no: "AB-26-0010", kind: "external", customer: "Pumpenbau Nord", customer_ref: "PO-10",
      created_at: hoursAgo(100), due_date: hoursAgo(24), net: 400, gross: 476,
      blocked: false, released: true, release_note: "Freigegeben",
      paid: false, paid_at: null, payment_method: "", invoice_no: "", invoiced_at: null, invoice_due_at: null,
      rush: true, n_positions: 2, n_done: 1, status: "in_produktion", status_label: "In Produktion",
      work_orders: [{ no: "IA-26-0001", status: "running" }], shipments: [],
      held_at: null, hold_reason: "", cancelled_at: null, cancel_reason: "",
    },
    {
      no: "AB-26-0011", kind: "external", customer: "Alte Absage GmbH", customer_ref: "PO-11",
      created_at: hoursAgo(120), due_date: hoursAgo(72), net: 100, gross: 119,
      blocked: false, released: false, release_note: "Storniert",
      paid: false, paid_at: null, payment_method: "", invoice_no: "", invoiced_at: null, invoice_due_at: null,
      rush: false, n_positions: 1, n_done: 0, status: "storniert", status_label: "Storniert",
      work_orders: [], shipments: [],
      held_at: null, hold_reason: "", cancelled_at: hoursAgo(48), cancel_reason: "Kunde hat abgesagt",
    },
  ];
  const detail = {
    no: "AB-26-0010", kind: "external", internal_owner: "",
    customer: "Pumpenbau Nord", customer_ref: "PO-10", cert: "3.1",
    net: 400, vat: 76, gross: 476, engine_version: "lite-1",
    blocked: false, released: true, release_note: "Freigegeben",
    office_note: "Teillieferung mit Herrn Meyer abgestimmt.",
    price_check: {},
    paid: false, paid_at: null, payment_method: "", payment_ref: "",
    held_at: null, hold_reason: "", cancelled_at: null, cancel_reason: "",
    due_date: hoursAgo(24), rush: true,
    ship_address: { company: "Pumpenbau Nord", street: "Kai 1", zip: "20457", city: "Hamburg", country: "DE" },
    bill_address: {}, created_at: hoursAgo(100),
    positions: [{ id: 1, label: "Ring DN100", mat: "epdm-70", thk: 2, qty: 10, od: 140, di: 100, production_status: "batched", status_text: "eingeplant", work_order_no: "IA-26-0001" }],
    work_orders: [{ no: "IA-26-0001", run_no: "SL-26-0001", status: "running", own_parts: 10, own_tags: ["A1"], plates: [1], n_plates: 1, n_done_plates: 0, n_orders: 1 }],
    shipments: [], audit: [],
  };
  const timeline = {
    no: "AB-26-0010", state: "active",
    steps: [
      { id: "created", label: "Bestellt", icon: "shopping-cart", done: true, current: false, at: hoursAgo(100), detail: "2 Position(en)", can_rollback: false },
      { id: "released", label: "Freigegeben", icon: "arrow-right", done: true, current: false, at: hoursAgo(99), detail: "Freigegeben", can_rollback: true },
      { id: "planned", label: "Eingeplant", icon: "cut", done: true, current: false, at: hoursAgo(50), detail: "IA-26-0001", can_rollback: true },
      { id: "cutting", label: "Im Schnitt", icon: "cog", done: true, current: true, at: hoursAgo(4), detail: "Wird geschnitten", can_rollback: true },
      { id: "done", label: "Geschnitten", icon: "tick-circle", done: false, current: false, at: null, detail: "1/2 Positionen geschnitten", can_rollback: false },
      { id: "shipped", label: "Versand", icon: "truck", done: false, current: false, at: null, detail: "noch kein Versand", can_rollback: false },
      { id: "paid", label: "Bezahlt", icon: "euro", done: false, current: false, at: null, detail: "offen", can_rollback: false },
    ],
  };

  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features: [] } });
    if (path === "/api/factory/topology") return route.fulfill({ json: { sites: [], unsited_halls: [], unassigned_floors: [] } });
    if (path === "/api/admin/orders") return route.fulfill({ json: { total: orderItems.length, items: orderItems } });
    if (path === "/api/admin/orders/AB-26-0010") return route.fulfill({ json: detail });
    if (path === "/api/admin/orders/AB-26-0010/timeline") return route.fulfill({ json: timeline });
    if (path.startsWith("/api/")) return route.fulfill({ json: [] });
    const file = path === "/app/" ? "index.html" : path.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
    await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });

  await page.goto("http://internal.test/app/#/auftraege");
  await page.locator(".order-pipeline").waitFor();
  assert.equal(await page.locator(".order-pipe-stage").count(), 6, "sechs Stufen im Auftragsweg");

  // Überfällig-Pill filtert sauber: AB-26-0010 bleibt, der stornierte AB-26-0011 verschwindet.
  await page.locator(".order-pipe-pill.is-danger").click();
  assert.equal(await page.locator("tbody tr").count(), 1);
  assert.match(await page.locator("tbody tr").first().innerText(), /AB-26-0010/);

  // Schublade öffnen: Nächster Schritt, Stepper, Büronotiz, Rückrollen-Dialog statt window.confirm.
  await page.locator("tbody tr").first().click();
  await page.locator(".order-next-bar").waitFor();
  assert.match(await page.locator(".order-next-bar").innerText(), /IA-26-0001/);
  await page.locator(".order-stepper").waitFor();
  assert.match(await page.locator(".order-office-note").innerText(), /Herrn Meyer/);

  // Kein horizontales Überlaufen auf Desktop und Telefon.
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

  assert.deepEqual(errors, []);
  await context.close();
  console.log("Order flow passed: pure logic, cancelled/held accuracy, pipeline filter, drawer next-step, stepper, office note, responsive.");
} finally {
  await browser.close();
}
