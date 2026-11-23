// Run after npm run build: node free-nesting.test.mjs ../gimel/webapp/dist
// Library and free nesting in a real browser against a scripted API. Every wait is on something the page
// shows (a status, a row, a hash), never on a timer, so nothing here races a React effect.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "free-nesting-"));
execFileSync("node_modules/.bin/esbuild", ["src/freeNesting.ts", "--format=esm", `--outfile=${join(tmp, "fn.js")}`], { stdio: "ignore" });
writeFileSync(join(tmp, "package.json"), '{"type":"module"}');
const { cleanSettings, settingsKey, blockers, placedRing, ringPath, DEFAULT_SETTINGS } = await import(join(tmp, "fn.js"));

const dist = process.argv[2] ?? "../gimel/webapp/dist";
const RUNS = 5;
const browser = await chromium.launch();
const errors = [];

const sq = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const drawing = (id, name, w, h) => ({
  id, name, note: id === 1 ? "für Müller" : "", source: id === 1 ? "dxf" : "points", width: w, height: h,
  area: w * h, cut_len: 2 * (w + h), n_holes: 0, created_at: "2026-11-01T10:00:00", created_by: "a@b.test",
  preview: { outer: sq(w, h), holes: [] },
});

function server({ validRun = true } = {}) {
  const st = {
    drawings: [drawing(1, "Konsole", 300, 200), drawing(2, "Deckel", 100, 100)],
    polls: 0, started: null, deleted: [], renamed: [], created: [], imported: [], exports: [], run: false,
  };
  const layout = {
    placements: [
      { partId: "1", partIndex: 0, instance: 0, sheet: 0, rotation: 0, x: 10, y: 10, width: 300, height: 200, tx: 10, ty: 10 },
      { partId: "1", partIndex: 0, instance: 1, sheet: 0, rotation: 90, x: 320, y: 10, width: 200, height: 300, tx: 520, ty: 10 },
      { partId: "2", partIndex: 1, instance: 0, sheet: 0, rotation: 0, x: 10, y: 220, width: 100, height: 100, tx: 10, ty: 220 },
    ],
    sheets: [{ index: 0, parts: 3, usedLength: 530, utilization: 0.31 }], unplaced: [],
    stats: { sheetsUsed: 1, placed: 3, total: 3, placedArea: 160000, utilizationSheets: 0.31, utilizationUsed: 0.59,
      remnantLength: 470, iterations: 12, maxSheets: null, stockLimited: false, maxSteps: 12, elapsedMs: 800, cell: 10 },
  };
  const parts = [{ id: "1", name: "Konsole", outer: sq(300, 200), holes: [], quantity: 2 }, { id: "2", name: "Deckel", outer: sq(100, 100), holes: [], quantity: 1 }];
  const base = { id: "r1", rev: 1, phase: "coarse", elapsed_ms: 100, max_steps: 12, error: "", notice: "Freies Schachteln – kein Fertigungsauftrag",
    reproducible: true, job: { sheet: { width: 1000, height: 500 }, margin: 10, gravity: "left" } };
  const handle = async (route, url, req) => {
    const path = url.pathname, method = req.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/version") return json({ version: "t", features: [] });
    if (path === "/api/drawings" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const items = st.drawings.filter((d) => !q || d.name.toLowerCase().includes(q));
      return json({ total: items.length, items });
    }
    if (path === "/api/drawings" && method === "POST") {
      const body = JSON.parse(req.postData());
      const d = drawing(10 + st.drawings.length, body.name || "Zeichnung", 60, 40);
      st.drawings.push(d); st.created.push(body);
      return json({ created: [d], skipped: [], notes: ["Punkte werden als Millimeter gelesen."] });
    }
    if (path === "/api/drawings/import/dxf") {
      st.imported.push(req.headers()["x-name"]);
      const d = drawing(20 + st.drawings.length, decodeURIComponent(req.headers()["x-name"]), 80, 80);
      st.drawings.push(d);
      return json({ created: [d], skipped: ["Text und Bemaßung wurden übergangen"], notes: ["Keine DXF-Einheit angegeben; als Millimeter gelesen"] });
    }
    const one = /^\/api\/drawings\/(\d+)$/.exec(path);
    if (one) {
      const id = Number(one[1]), d = st.drawings.find((x) => x.id === id);
      if (!d) return json({ detail: "Zeichnung nicht gefunden." }, 404);
      if (method === "PATCH") { Object.assign(d, JSON.parse(req.postData())); st.renamed.push(d.name); return json(d); }
      if (method === "DELETE") { st.drawings = st.drawings.filter((x) => x.id !== id); st.deleted.push(id); return json({ deleted: id }); }
      return json({ ...d, outer: d.preview.outer, holes: [] });
    }
    if (path === "/api/free-nesting/runs" && method === "POST") {
      st.started = JSON.parse(req.postData()); st.run = true; st.polls = 0;
      return json({ ...base, status: "running", rev: 0, step: 0, verify: null, exportable: false });
    }
    if (path === "/api/free-nesting/runs/r1" && method === "GET") {
      if (!st.run) return json({ detail: "Lauf nicht gefunden" }, 404);
      st.polls++;
      if (st.polls === 1) return json({ ...base, status: "running", step: 6, verify: null, exportable: false, layout, parts });
      if (st.polls === 2) return json({ ...base, status: "checking", rev: 2, step: 12, verify: null, exportable: false });
      const verify = validRun ? { valid: true, issues: [], minGap: 5.2, minSlack: 0.2, pairsChecked: 3 }
        : { valid: false, issues: ["Konsole#0 overlaps Konsole#1"], minGap: 0, minSlack: -5, pairsChecked: 3 };
      return json({ ...base, status: "done", rev: 2, step: 12, verify, exportable: validRun });
    }
    if (path === "/api/free-nesting/runs/r1/export") {
      st.exports.push(url.search);
      return route.fulfill({ status: 200, body: "x", headers: { "content-type": "application/dxf", "content-disposition": 'attachment; filename="freies-schachteln-r1-platte1.dxf"' } });
    }
    return json({ detail: "Test" }, 503);
  };
  return { st, handle };
}

async function open(hash, { role = "admin", width = 1280, srv, init, scheme } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme ?? "light", acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${hash}: ${e.message}`));
  await page.addInitScript((r) => {
    localStorage.setItem("gimel-token", "t");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: r }));
  }, role);
  if (init) await page.addInitScript(init);
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.startsWith("/api/")) return srv.handle(route, url, req);
    const file = url.pathname === "/app/" ? "index.html" : url.pathname.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  await page.goto(`http://internal.test/app/#/${hash}`);
  await page.locator(".app-sidebar").waitFor();
  return { page, context };
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// ---- pure parts first
{
  const s = cleanSettings({ sheetW: "x", spacing: -3, parts: [{ id: 1, qty: 3, gap: null }, { id: 1, qty: 9 }, { id: "z" }], preset: "nope", seed: 0 });
  assert.equal(s.sheetW, DEFAULT_SETTINGS.sheetW, "junk falls back to the default");
  assert.equal(s.spacing, DEFAULT_SETTINGS.spacing);
  assert.equal(s.seed, 1);
  assert.deepEqual(s.parts, [{ id: 1, qty: 3, gap: null }], "one row per drawing, no strings");
  assert.equal(settingsKey({ ...s }), settingsKey(cleanSettings(JSON.parse(JSON.stringify(s)))));
  assert.notEqual(settingsKey(s), settingsKey({ ...s, seed: 2 }));
  assert.notEqual(settingsKey(s), settingsKey({ ...s, parts: [{ id: 1, qty: 4, gap: null }] }));
  assert.equal(settingsKey({ ...s, cell: 99 }), settingsKey(s), "the cell only counts when manual");
  assert.match(blockers({ ...DEFAULT_SETTINGS })[0], /kein Teil/);
  assert.match(blockers({ ...s, parts: [{ id: 1, qty: 2001, gap: null }] }).join(" "), /2000/);
  assert.deepEqual(placedRing([[1, 0]], { rotation: 90, tx: 5, ty: 5 }), [[5, 6]], "90 degrees exactly");
  assert.equal(ringPath([[0, 0], [10, 0], [10, 4]], 4), "M0 4L10 4L10 0Z", "library shapes flip to screen");
}

async function scenario(n) {
  const srv = server();
  const { page, context } = await open("zeichnungen", { srv });
  try {
    // --- library
    await page.getByRole("heading", { name: "Zeichnungen", exact: true }).waitFor();
    await page.locator(".fn-table tbody tr").nth(1).waitFor();
    assert.equal(await page.locator(".fn-table tbody tr").count(), 2);
    assert.match(await page.locator(".fn-count").innerText(), /2 Zeichnungen/);
    assert.equal(await noOverflow(page), true);

    await page.getByLabel("Zeichnungen suchen").fill("decke");
    await page.waitForFunction(() => document.querySelectorAll(".fn-table tbody tr").length === 1);
    assert.match(await page.locator(".fn-table tbody tr").innerText(), /Deckel/);
    await page.getByLabel("Zeichnungen suchen").fill("");
    await page.waitForFunction(() => document.querySelectorAll(".fn-table tbody tr").length === 2);

    await page.getByRole("button", { name: "Kacheln" }).click();
    await page.locator(".fn-grid .fn-card").nth(1).waitFor();
    assert.equal(await page.getByRole("button", { name: "Kacheln" }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Tabelle" }).click();
    await page.locator(".fn-table").waitFor();

    await page.getByTestId("import-file").setInputFiles({ name: "Flansch 4.dxf", mimeType: "application/dxf", buffer: Buffer.from("0\nEOF\n") });
    await page.getByTestId("import-report").waitFor();
    const report = await page.getByTestId("import-report").innerText();
    assert.match(report, /Text und Bemaßung/);
    assert.match(report, /Millimeter/);
    assert.equal(decodeURIComponent(srv.st.imported[0]), "Flansch 4");
    await page.locator(".fn-table tbody tr").nth(2).waitFor();

    await page.getByTestId("import-file").setInputFiles({ name: "notiz.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await page.waitForFunction(() => document.querySelector("[data-testid=import-report]")?.textContent.includes("nur .dxf und .svg"));

    await page.getByRole("button", { name: "Punkte einfügen" }).click();
    const paste = page.getByRole("dialog", { name: "Punkte einfügen" });
    await paste.getByLabel("Name", { exact: true }).fill("Eingefügt");
    await paste.getByLabel("Punkte in Millimetern").fill("0,0 60,0 60,40 0,40");
    await paste.getByRole("button", { name: "Zeichnung anlegen" }).click();
    await paste.waitFor({ state: "detached" });
    await page.locator(".fn-table tbody tr", { hasText: "Eingefügt" }).waitFor();
    assert.equal(srv.st.created[0].text, "0,0 60,0 60,40 0,40");

    await page.getByRole("button", { name: "Deckel umbenennen" }).click();
    const ren = page.getByRole("dialog", { name: "Zeichnung umbenennen" });
    await ren.getByLabel("Name", { exact: true }).fill("Deckel neu");
    await ren.getByRole("button", { name: "Speichern" }).click();
    await page.locator(".fn-table tbody tr", { hasText: "Deckel neu" }).waitFor();

    await page.getByRole("button", { name: "Eingefügt löschen" }).click();
    await page.getByRole("button", { name: "Löschen", exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".fn-table tbody tr")].some((r) => r.textContent.includes("Eingefügt")));
    assert.equal(srv.st.deleted.length, 1);

    // --- to nesting
    await page.locator(".fn-table tbody tr", { hasText: "Konsole" }).getByRole("button", { name: "Zum Schachteln" }).click();
    await page.getByRole("heading", { name: "Freies Schachteln" }).waitFor();
    await page.locator("[data-testid=part-row]").waitFor();
    assert.match(await page.locator("[data-testid=part-row]").innerText(), /Konsole/);
    assert.equal(await page.evaluate(() => location.hash), "#/freies-schachteln", "the add parameter is gone again");

    // --- run
    await page.getByTestId("start").isEnabled();
    await page.getByLabel("Menge von Konsole").fill("2");
    await page.getByTestId("part-sum").waitFor();
    assert.match(await page.getByTestId("part-sum").innerText(), /2 Teile · 1 Art/);
    await page.getByLabel("Zeichnung aus der Bibliothek").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Hinzufügen" }).click();
    await page.locator("[data-testid=part-row]").nth(1).waitFor();
    await page.getByTestId("start").click();
    await page.waitForFunction(() => document.querySelector("[data-testid=run-status]")?.dataset.status === "done");
    assert.equal(srv.st.started.parts.length, 2);
    assert.equal(srv.st.started.parts[0].drawing_id, 1);
    assert.equal(srv.st.started.cell, null, "no manual cell unless manual");
    assert.equal(srv.st.started.max_steps, 150);
    assert.match(await page.getByTestId("verify").innerText(), /Geprüft/);
    assert.equal(await page.getByTestId("verify").getAttribute("data-valid"), "true");
    assert.equal(await page.getByTestId("util").innerText(), "59 %");
    assert.equal(await page.getByTestId("placed").innerText(), "3 / 3");
    assert.equal(await page.locator("[data-testid=sheet-0] path.p").count(), 3, "layout kept across the final answer that omits it");
    assert.match(await page.locator(".fn-label").innerText(), /kein Fertigungsauftrag/);
    assert.equal(await page.getByTestId("export-dxf").isEnabled(), true);
    assert.equal(await page.getByTestId("stale").count(), 0);

    // hover and keyboard
    await page.locator("[data-testid=sheet-0] path.p").first().hover();
    await page.waitForFunction(() => document.querySelector("[data-testid=readout]").textContent.includes("Konsole"));
    await page.locator("[data-testid=sheet-0]").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=sheet-0] path.p.hot").length === 1);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=sheet-0] path.p.hot").length === 0);

    // export
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-dxf").click()]);
    assert.equal(download.suggestedFilename(), "freies-schachteln-r1-platte1.dxf");
    assert.match(srv.st.exports[0], /format=dxf&sheet=1/);

    // stale: a changed setting after the run
    await page.getByLabel("Teileabstand (mm)").fill("9");
    await page.getByTestId("stale").waitFor();
    assert.match(await page.getByTestId("stale").innerText(), /Veraltet/);
    assert.match(await page.getByTestId("run-status").innerText(), /veraltet/);
    await page.getByLabel("Teileabstand (mm)").fill("5");
    await page.waitForFunction(() => !document.querySelector("[data-testid=stale]"));

    // settings survive a reload; the run is remembered for the tab
    await page.getByLabel("Teileabstand (mm)").fill("7");
    await page.reload();
    await page.getByLabel("Teileabstand (mm)").waitFor();
    assert.equal(await page.getByLabel("Teileabstand (mm)").inputValue(), "7");
    assert.equal(await page.locator("[data-testid=part-row]").count(), 2);
    await page.getByTestId("stale").waitFor();               // the remembered run used 5, now 7
    assert.equal(await noOverflow(page), true);
  } finally { await context.close(); }
  console.log(`  run ${n}/${RUNS} ok`);
}

for (let i = 1; i <= RUNS; i++) await scenario(i);

// ---- an invalid layout is not offered
{
  const srv = server({ validRun: false });
  const { page, context } = await open("freies-schachteln?add=1", { srv });
  await page.locator("[data-testid=part-row]").waitFor();
  await page.getByTestId("start").click();
  await page.waitForFunction(() => document.querySelector("[data-testid=verify]")?.dataset.valid === "false");
  assert.match(await page.getByTestId("verify").innerText(), /nicht zum Export freigegeben/);
  assert.equal(await page.getByTestId("export-dxf").isDisabled(), true);
  assert.match(await page.locator(".fn-issues").innerText(), /overlaps/);
  await context.close();
}

// ---- no storage at all, phone width, dark
{
  const srv = server();
  const { page, context } = await open("freies-schachteln?add=2", {
    srv, width: 375, scheme: "dark",
    init: () => {
      const boom = () => { throw new Error("storage blocked"); };
      const real = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k) { return k.startsWith("gimel-free") || k.startsWith("gimel-drawings") ? boom() : real.call(this, k); };
      const setReal = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { return k.startsWith("gimel-free") || k.startsWith("gimel-drawings") ? boom() : setReal.call(this, k, v); };
    },
  });
  await page.locator("[data-testid=part-row]").waitFor();
  assert.equal(await noOverflow(page), true, "no sideways scroll at 375 px");
  await page.getByTestId("start").click();
  await page.waitForFunction(() => document.querySelector("[data-testid=run-status]")?.dataset.status === "done");
  assert.equal(await noOverflow(page), true);
  const paper = await page.locator("[data-testid=sheet-0]").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(paper, "rgb(255, 255, 255)", "drawings stay on paper in the dark view");
  assert.equal(await page.getByTestId("start").isVisible(), true);
  await context.close();
}

// ---- workers
{
  const srv = server();
  const { page, context } = await open("zeichnungen", { role: "worker", srv });
  await page.getByText("Nur für das Büro").waitFor();
  const links = await page.locator(".app-sidebar .sidebar-link").allInnerTexts();
  assert.ok(!links.includes("Zeichnungen") && !links.includes("Freies Schachteln"), "hidden from workers");
  await context.close();
}

await browser.close();
assert.deepEqual(errors, [], "no page errors");
console.log(`Free nesting passed: library, import report, paste, rename, delete, run, hover and keys, export gate, stale marker, storage, 375 px, dark, workers (${RUNS} runs).`);
