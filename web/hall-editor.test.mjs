// Run after npm run build: node hall-editor.test.mjs ../gimel/twin/dist
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] && !process.argv[2].includes("webapp") ? process.argv[2] : "../gimel/twin/dist";
const base = { type: "production", subtype: "", y: 6, w: 6, h: 4, rotation: 0, colour: "#0a5b9c", active: true, routing: "smart_suggest",
  materials: [], thicknesses: [], assigned_users: [], queue_jobs: 0, queue_min: 0, capacity_min_per_day: 450, is_storage: false, note: "", label: "" };
const stations = [{ ...base, id: 1, label: "Plotter 1", x: 8 }, { ...base, id: 2, label: "Stanze mit sehr langem Namen", x: 20, w: 2, h: 2, colour: "#c4520a" }];
const floor = { name: "Halle", outline: [[0, 0], [54, 0], [54, 24], [0, 24]], zones: [], obstacles: [], doors: [], aisles: { nodes: [[1, 1], [2, 2]], edges: [[0, 1]] }, snap: 0.25, grid: 1 };

const browser = await chromium.launch();
const errors = [];
const VIEWBOX_TOL = 0.01;

async function open({ width = 1280, height = 800, touch = false, user = { name: "Test", role: "admin" }, expectEditor = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch });
  const page = await context.newPage();
  const writes = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("503")) errors.push(m.text()); });
  await page.addInitScript(u => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify(u));
  }, user);
  await page.route("**/*", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== "GET") {
      const body = req.postDataJSON();
      writes.push({ method: req.method(), path, body });
      return route.fulfill({ json: path === "/api/factory/floor" ? body : { ...stations[0], ...body } });
    }
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features: [] } });
    if (path === "/api/factory/floor") return route.fulfill({ json: floor });
    if (path === "/api/factory/stations") return route.fulfill({ json: stations });
    if (path.startsWith("/api/factory/settings/")) return route.fulfill({ json: { key: "x", value: "0" } });
    if (path === "/api/users" || path === "/api/products") return route.fulfill({ json: [] });
    if (path.startsWith("/api/")) return route.fulfill({ status: 503, json: { detail: "Test" } });
    const file = path === "/twin/" || path === "/twin" ? "twin.html" : path.replace(/^\/twin\//, "");
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  await page.goto("http://internal.test/twin/#/admin");
  if (expectEditor) await page.locator('.floor-station[role="button"]').first().waitFor();
  else await page.getByText("Nur mit einem Admin-Konto").waitFor();
  return { page, writes, close: () => context.close() };
}

const noOverflow = page => page.evaluate(() => {
  const main = document.querySelector(".app-main");
  return document.documentElement.scrollWidth <= document.documentElement.clientWidth && main.scrollWidth <= main.clientWidth;
});
const station = (page, name) => page.locator(`.floor-station[aria-label^="${name}"]`);
/** Wartet, bis der Ausschnitt dem Beobachter gefolgt ist: er kommt nach dem ersten Zeichnen. */
const fitted = page => page.waitForFunction(tol => {
  const svg = document.querySelector(".floor-svg");
  const box = svg.getBoundingClientRect();
  return Math.abs(svg.viewBox.baseVal.width / svg.viewBox.baseVal.height - box.width / box.height) < tol;
}, VIEWBOX_TOL);

try {
  // Der Plan ist die Hauptfläche: füllt die Höhe, viel Breite, kein Leerstreifen.
  {
    const { page, close } = await open();
    await fitted(page);
    const stage = await page.locator(".floor-stage").boundingBox();
    const main = await page.locator(".app-main").boundingBox();
    assert.ok(stage.width >= main.width * 0.62, `Breite ${stage.width}`);
    assert.ok(stage.height >= 460, `Höhe ${stage.height}`);
    assert.equal(await page.locator(".editor-rail").evaluate(r => r.getBoundingClientRect().width), 320);
    assert.ok((await page.locator(".editor-tools").boundingBox()).height <= 48, "eine Werkzeugzeile");
    const keys = await page.locator(".editor-keys").boundingBox();
    assert.ok(keys.x + keys.width <= main.x + main.width, "Hinweis nicht abgeschnitten");
    assert.ok(keys.y >= stage.y + stage.height, "Hinweis am Plan");
    assert.ok(await noOverflow(page));
    await close();
  }

  // Stationen neutral, Schrift in Pixeln, gedrehter und kleiner Block inklusive.
  {
    const { page, close } = await open();
    await fitted(page);
    const body = station(page, "Plotter 1").locator("rect").first();
    assert.equal(await body.getAttribute("fill"), "var(--g-floor-station)");
    for (const name of ["Plotter 1", "Stanze mit sehr langem Namen"]) {
      const size = await station(page, name).locator(".floor-station-label").evaluate(t => t.getBoundingClientRect().height);
      assert.ok(size >= 12, `${name}: ${size}`);
    }
    await close();
  }

  // Abschnitte klappen, die Daten darin bleiben.
  {
    const { page, close } = await open();
    const zones = page.getByRole("button", { name: "Betriebsschalter" });
    assert.equal(await zones.getAttribute("aria-expanded"), "false");
    await zones.focus();
    await page.keyboard.press("Enter");
    await page.getByText("All-for-all").waitFor();
    assert.equal(await zones.getAttribute("aria-expanded"), "true");
    await close();
  }

  // Bedienung unverändert: Klick trifft den Punkt, Pfeil schiebt, Farbe bleibt, Strg+Z, Esc, Speichern.
  {
    const { page, writes, close } = await open();
    await fitted(page);

    await station(page, "Plotter 1").click();
    await page.getByLabel("Name", { exact: true }).waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector('.floor-station[aria-label^="Plotter 1"]').getAttribute("transform").startsWith("translate(8.25 "));
    await page.locator('.floor-station-sel').waitFor();
    for (let i = 0; i < 100 && !writes.some(w => w.path === "/api/factory/stations/1"); i++) await page.waitForTimeout(20);
    const put = writes.find(w => w.path === "/api/factory/stations/1");
    assert.equal(put.body.colour, "#0a5b9c", "Gespeicherte Farbe bleibt");
    assert.equal(put.body.x, 8.25);

    // Klick im Plan landet in Metern dort, wo der Zeiger steht, trotz erweitertem Ausschnitt.
    await page.getByRole("button", { name: "Zeichnen" }).click();
    await page.getByRole("button", { name: "Leeren" }).click();
    const target = await page.evaluate(() => {
      const svg = document.querySelector(".floor-svg");
      const p = new DOMPoint(27, 12).matrixTransform(svg.getScreenCTM());
      return { x: p.x, y: p.y };
    });
    await page.mouse.click(target.x, target.y);
    await page.getByText("Hallenumriss — 1 Punkt").waitFor();
    assert.equal(await page.locator(".floor-card path[fill-opacity='0.09']").count(), 1, "Entwurf ist eine helle Fläche, keine schwarze");
    await page.getByRole("button", { name: "Maße als Tabelle" }).click();
    assert.equal(await page.locator(".draft-points-table input").first().inputValue(), "27");
    await page.keyboard.press("Escape");
    assert.ok(await noOverflow(page));

    await page.getByRole("button", { name: "Auswählen" }).click();
    await page.getByRole("tab", { name: "Halle" }).click();
    await page.getByLabel("Name der Halle").fill("Halle 2");
    await page.locator("h1").click();
    await page.keyboard.press("Control+z");
    await page.getByRole("button", { name: "gespeichert" }).waitFor();
    await page.keyboard.press("Control+Shift+z");
    await page.getByRole("button", { name: "Halle speichern" }).click();
    for (let i = 0; i < 100 && !writes.some(w => w.path === "/api/factory/floor"); i++) await page.waitForTimeout(20);
    assert.equal(writes.find(w => w.path === "/api/factory/floor").body.name, "Halle 2");

    await page.getByRole("button", { name: "Import / Export" }).click();
    await page.getByRole("button", { name: "Einspielen" }).waitFor();
    assert.ok((await page.locator(".bp5-dialog textarea").inputValue()).includes('"outline"'));
    await close();
  }

  // Telefon: ansehen, klarer Hinweis, nichts ändert etwas, die Geste gehört der Seite.
  {
    const { page, writes, close } = await open({ width: 375, height: 812, touch: true });
    await page.getByText("Bearbeiten braucht einen größeren Bildschirm").waitFor();
    assert.equal(await page.locator(".editor-tools").count(), 0);
    assert.equal(await page.locator(".editor-rail").count(), 0);
    assert.equal(await page.locator(".floor-svg").evaluate(s => getComputedStyle(s).touchAction), "pan-y pinch-zoom");
    assert.ok(await noOverflow(page));
    const small = await page.locator(".hall-summary-list button, .floor-toolbar button").evaluateAll(b => b.filter(x => x.getBoundingClientRect().height < 44).length);
    assert.equal(small, 0, "44 Pixel");
    await page.getByRole("button", { name: /Plotter 1/ }).last().click();
    await page.locator(".hall-summary-picked").waitFor();
    await page.keyboard.press("d");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(700);   // länger als die Speicherverzögerung von 500 ms
    assert.deepEqual(writes, []);
    await close();
  }

  // Anbindung: eine ferne Station ist „nicht angebunden“, der Pfadfinder schlägt einen Weg vor, erst Übernehmen ändert den Plan.
  {
    const { page, close } = await open();
    await fitted(page);
    await station(page, "Stanze mit sehr langem Namen").click();
    const link = page.locator('[data-testid="station-link"]');
    await link.waitFor();
    assert.match(await link.innerText(), /Nicht angebunden/);
    await page.locator('[data-testid="station-path"]').getByRole("button", { name: "Pfadfinder" }).click();
    const proposal = page.locator('[data-testid="path-proposal"]');
    await proposal.waitFor();
    assert.match(await proposal.innerText(), /angebunden/);
    assert.ok(await page.locator(".floor-proposal line").count() > 0, "Vorschlag gestrichelt im Plan");
    assert.match(await link.innerText(), /Nicht angebunden/, "vor Übernehmen ändert sich nichts");
    await proposal.getByRole("button", { name: "Übernehmen" }).click();
    await page.locator('[data-testid="station-link"]', { hasText: "Am Gangnetz" }).waitFor();
    await close();
  }

  // Das PIN-Konto (Rolle staff, Flag adminWork) bearbeitet die Halle; ein gewöhnliches Personalkonto sieht den Hinweis.
  {
    const { page, close } = await open({ user: { name: "Gimel-Betrieb", role: "staff", adminWork: true } });
    assert.equal(await page.getByText("Nur mit einem Admin-Konto").count(), 0);
    assert.ok(await page.locator('.floor-station[role="button"]').count() > 0, "PIN-Konto darf Halle bearbeiten");
    await close();
  }
  {
    const { page, close } = await open({ user: { name: "Meister", role: "staff" }, expectEditor: false });
    assert.equal(await page.locator('.floor-station[role="button"]').count(), 0);
    await close();
  }

  // Innenwand & Raumbox: keine Streupunkte, drehen, Fläche ziehen, Auswahl auf der Karte, Höhe & Art gespeichert, DXF-Abbrechen & Anzeige-Menü.
  {
    const { page, writes, close } = await open();
    await fitted(page);

    // Innenwand anlegen -> 4 Punkte, Klick ins Leere hängt keinen 5. Punkt an.
    await page.getByRole("button", { name: "Innenwand" }).click();
    await page.getByText("Hindernis — 4 Punkte").waitFor();
    const emptySpot = await page.evaluate(() => {
      const svg = document.querySelector(".floor-svg");
      const p = new DOMPoint(5, 5).matrixTransform(svg.getScreenCTM());
      return { x: p.x, y: p.y };
    });
    await page.mouse.click(emptySpot.x, emptySpot.y);
    await page.getByText("Hindernis — 4 Punkte").waitFor();

    // Drehen & Länge ändern.
    await page.getByRole("button", { name: "+90°" }).click();
    await page.getByRole("button", { name: "Anlegen" }).click();

    // Raumbox anlegen, Fläche ziehen und speichern.
    await page.getByRole("button", { name: "Raumbox" }).click();
    await page.getByText("Hindernis — 4 Punkte").waitFor();
    const boxCenter = await page.locator(".floor-draft-body").boundingBox();
    assert.ok(boxCenter, "Raumbox-Entwurf hat ziehbare Fläche");
    await page.mouse.move(boxCenter.x + boxCenter.width / 2, boxCenter.y + boxCenter.height / 2);
    await page.mouse.down();
    await page.mouse.move(boxCenter.x + boxCenter.width / 2 + 40, boxCenter.y + boxCenter.height / 2 + 20, { steps: 4 });
    await page.mouse.up();
    await page.getByRole("button", { name: "Anlegen" }).click();

    // Auswählen-Modus: Klick auf die Raumbox öffnet sie wieder zum Bearbeiten.
    await page.getByRole("button", { name: "Auswählen" }).click();
    await page.locator('.floor-obstacle[data-kind="room"]').first().click();
    await page.getByRole("button", { name: "Änderung übernehmen" }).waitFor();
    await page.getByRole("button", { name: "Änderung übernehmen" }).click();

    // Speichern: kind und height_m werden mitgeschickt.
    await page.getByRole("button", { name: "Halle speichern" }).click();
    for (let i = 0; i < 100 && !writes.some(w => w.path === "/api/factory/floor"); i++) await page.waitForTimeout(20);
    const savedFloor = writes.find(w => w.path === "/api/factory/floor").body;
    assert.equal(savedFloor.obstacles.length, 2);
    assert.equal(savedFloor.obstacles[0].kind, "wall");
    assert.equal(savedFloor.obstacles[1].kind, "room");
    assert.ok(savedFloor.obstacles[0].height_m > 0 && savedFloor.obstacles[1].height_m > 0);

    // DXF-Dialog: Abbrechen schließt das Fenster.
    await page.getByRole("button", { name: "DXF", exact: true }).click();
    await page.getByRole("dialog", { name: "Umriss aus DXF" }).waitFor();
    await page.getByRole("button", { name: "Abbrechen" }).click();
    await page.getByRole("dialog", { name: "Umriss aus DXF" }).waitFor({ state: "hidden" });

    // Anzeige-Popover öffnet nach oben und zeigt die Ebenen.
    await page.getByRole("button", { name: "Anzeige" }).click();
    await page.getByRole("menuitem", { name: "Hindernisse" }).waitFor();
    await page.keyboard.press("Escape");
    await close();
  }

  assert.deepEqual(errors, []);
  console.log("Hall editor checks passed: plan first, one toolbar, sections, neutral stations, editing unchanged, phone viewer.");
} finally {
  await browser.close();
}
