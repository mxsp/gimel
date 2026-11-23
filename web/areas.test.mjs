// Run after npm run build: node areas.test.mjs ../gimel/webapp/dist
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] ?? "../gimel/webapp/dist";
const features = ["vision", "library"];
const BUERO = ["auftragserfassung", "buchhaltung", "kunden", "lager", "werkstoffe", "formen", "benutzer", "compliance", "admin"];
const LEITSTAND = ["optimierung", "disposition", "arbeitsvorrat", "arbeitsplaetze", "schachteln", "freies-schachteln", "zeichnungen", "kommissionierung",
  "bereitstellen", "produktion", "station/1", "grundriss/station/1",
  "grundriss/optimierung", "grundriss/arbeitsvorrat", "schachteln/IA-1"];
const SHARED = ["heute", "auftraege", "versand"];
// Entschlackte Seitenleiste: keine doppelten Unteransichten oder AppSwitcher-Ziele mehr.
const BUERO_LIST = ["Heute", "Auftragserfassung", "Aufträge", "Versand", "Buchhaltung", "Kalender", "Kunden", "Lager", "Werkstoffe", "Formen"];
const MENU_ADMIN = ["Benutzer", "Compliance", "Admin"];
const LEITSTAND_LIST = ["Heute", "Aufträge", "Disposition", "Schachteln", "Arbeitsvorrat",
  "Kommissionierung", "Produktion", "Versand"];
const WORKER_LIST = ["Heute", "Arbeitsvorrat", "Aufträge", "Kommissionierung", "Produktion", "Versand"];
const KEYS = { h: "heute", e: "auftragserfassung", a: "auftraege", d: "disposition", o: "arbeitsvorrat", s: "schachteln", j: "freies-schachteln", z: "zeichnungen",
  k: "kommissionierung", p: "produktion", i: "optimierung",
  v: "versand", r: "buchhaltung", u: "kunden", l: "lager", w: "werkstoffe" };

const browser = await chromium.launch();
const errors = [];

async function open(hash, { role = "admin", width = 1280, init } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(`${hash}: ${error.message}`));
  await page.addInitScript(role => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role }));
  }, role);
  if (init) await page.addInitScript(init);
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features } });
    if (path.startsWith("/api/")) return route.fulfill({ status: 503, json: { detail: "Test" } });
    const file = path === "/app/" ? "index.html" : path.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  await page.goto(`http://internal.test/app/#/${hash}`);
  await page.locator(".app-sidebar").waitFor();
  return page;
}

const shell = page => page.locator(".app-shell");
const area = page => shell(page).getAttribute("data-area");
const list = page => page.locator(".app-sidebar .sidebar-link").allInnerTexts();
const switchLink = (page, name) => page.locator(".area-switch").getByRole("link", { name, exact: true });
// Die Merkstelle schreibt ein Effekt nach dem Zeichnen: erst danach darf der Test weiter.
const settled = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 50))));
const isArea = async (page, value) => {
  await page.waitForFunction(v => document.querySelector(".app-shell").dataset.area === v, value, { timeout: 2000 });
  await settled(page);
};
const atRoute = async (page, route) => {
  await page.waitForFunction(r => location.hash === `#/${r}`, route, { timeout: 2000 });
  await settled(page);
};
async function chord(page, key) {
  await page.locator(".app-main").focus();
  await page.keyboard.press("g");
  await page.keyboard.press(key);
}
const stored = page => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("gimel-area")).map(k => [k, localStorage.getItem(k)]));

try {
  // Jede Route öffnet als Deep Link in ihrem Bereich, eine gemeinsame im Büro.
  for (const [routes, expected] of [[BUERO, "buero"], [LEITSTAND, "leitstand"], [SHARED, "buero"]]) {
    for (const route of routes) {
      const page = await open(route);
      assert.equal(await area(page), expected, `${route} gehört zu ${expected}`);
      await page.context().close();
    }
  }

  // Die Leiste zeigt je Bereich genau seine Einträge; Verwaltung steht im Benutzermenü.
  let page = await open("kunden");
  assert.deepEqual(await list(page), BUERO_LIST);
  await page.getByRole("button", { name: /^Benutzermenü/ }).click();
  for (const name of MENU_ADMIN) await page.getByRole("menuitem", { name, exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await switchLink(page, "Büro").getAttribute("aria-current"), "true");
  assert.equal(await switchLink(page, "Leitstand").getAttribute("aria-current"), null);
  assert.equal(await switchLink(page, "Leitstand").getAttribute("href"), "#/arbeitsvorrat", "Leitstand beginnt am Arbeitsvorrat");

  // Ein Link in den anderen Bereich nimmt den Bereich mit; Unteransichten markieren ihre Hauptseite.
  await page.evaluate(() => { location.hash = "/optimierung"; });
  await isArea(page, "leitstand");
  assert.deepEqual(await list(page), LEITSTAND_LIST, "Optimierung ist als Reiter im Arbeitsvorrat integriert");
  assert.equal(await page.locator('.sidebar-link[aria-current="page"]').innerText(), "Arbeitsvorrat");
  assert.equal(await switchLink(page, "Büro").getAttribute("href"), "#/kunden", "Büro merkt sich die letzte Seite");
  await page.evaluate(() => { location.hash = "/zeichnungen"; });
  await page.waitForFunction(() => document.querySelector('.sidebar-link[aria-current="page"]')?.textContent === "Schachteln");
  assert.deepEqual(await list(page), LEITSTAND_LIST, "Zeichnungen nutzt Schachteln-Reiter ohne Extra-Eintrag");
  await page.evaluate(() => { location.hash = "/grundriss/optimierung"; });
  await page.waitForFunction(() => document.querySelector('.sidebar-link[aria-current="page"]')?.textContent === "Arbeitsvorrat");

  // Der Schalter führt zurück und die eigene Route bestimmt den Bereich.
  await switchLink(page, "Büro").click();
  await atRoute(page, "kunden");
  await isArea(page, "buero");
  assert.equal(await switchLink(page, "Leitstand").getAttribute("href"), "#/arbeitsvorrat");
  await page.context().close();

  // Eine gemeinsame Route behält den Bereich, und der Schalter wirkt auch dort.
  page = await open("arbeitsvorrat");
  await page.getByRole("link", { name: "Aufträge", exact: true }).click();
  await atRoute(page, "auftraege");
  assert.equal(await area(page), "leitstand", "Gemeinsame Route behält Leitstand");
  assert.deepEqual(await list(page), LEITSTAND_LIST);
  await page.getByRole("link", { name: "Versand", exact: true }).click();
  await atRoute(page, "versand");
  assert.equal(await area(page), "leitstand");
  await page.evaluate(() => { location.hash = "/kunden"; });
  await isArea(page, "buero");
  await page.getByRole("link", { name: "Heute", exact: true }).click();
  await atRoute(page, "heute");
  assert.equal(await area(page), "buero", "Gemeinsame Route behält Büro");
  await switchLink(page, "Leitstand").click();
  await atRoute(page, "versand");
  await isArea(page, "leitstand");
  // Büro zeigt zuletzt auf Heute, Leitstand steht auf Versand: beide gemeinsam.
  await switchLink(page, "Büro").click();
  await atRoute(page, "heute");
  await isArea(page, "buero");
  await page.goBack();
  await atRoute(page, "versand");
  assert.equal(await area(page), "buero", "Zurück auf eine gemeinsame Route ändert nichts");
  await page.context().close();

  // Der Schalter auf derselben Route: der Bereich wechselt ohne Navigation.
  page = await open("auftraege");
  await page.evaluate(() => { location.hash = "/arbeitsvorrat"; });
  await isArea(page, "leitstand");
  await page.evaluate(() => { location.hash = "/auftraege"; });
  await atRoute(page, "auftraege");
  await switchLink(page, "Büro").click();
  await isArea(page, "buero");
  await page.context().close();

  // Ein Neuladen auf einer gemeinsamen Route behält den Bereich.
  page = await open("arbeitsvorrat");
  await page.getByRole("link", { name: "Aufträge", exact: true }).click();
  await atRoute(page, "auftraege");
  await page.waitForFunction(() => localStorage.getItem("gimel-area-current") === "leitstand");
  await page.reload();
  await page.locator(".app-sidebar").waitFor();
  assert.equal(await area(page), "leitstand", "Neuladen behält Leitstand");
  assert.deepEqual(await list(page), LEITSTAND_LIST);
  await switchLink(page, "Büro").click();
  await isArea(page, "buero");
  await page.waitForFunction(() => localStorage.getItem("gimel-area-current") === "buero");
  await page.reload();
  await page.locator(".app-sidebar").waitFor();
  assert.equal(await area(page), "buero", "Neuladen behält Büro");
  await page.context().close();

  // Eine eigene Route schlägt den gemerkten Bereich, Unsinn im Speicher zählt nicht.
  page = await open("kunden", { init: () => localStorage.setItem("gimel-area-current", "leitstand") });
  assert.equal(await area(page), "buero");
  await page.context().close();
  page = await open("heute", { init: () => localStorage.setItem("gimel-area-current", "keller") });
  assert.equal(await area(page), "buero");
  await page.context().close();

  // Gespeichert wird die Wurzel, nie eine Nummer.
  page = await open("schachteln/IA-4711");
  await page.waitForFunction(() => localStorage.getItem("gimel-area-leitstand") === "schachteln");
  await page.evaluate(() => { location.hash = "/station/7"; });
  await page.waitForFunction(() => localStorage.getItem("gimel-area-leitstand") === "arbeitsvorrat");
  assert.ok(!JSON.stringify(await stored(page)).includes("4711"));
  await page.context().close();

  // Was diese Rolle nicht öffnen darf, ist kein Ziel; Fremdes auch nicht.
  const foreign = () => {
    localStorage.setItem("gimel-area-buero", "benutzer");
    localStorage.setItem("gimel-area-leitstand", "javascript:alert(1)");
  };
  page = await open("arbeitsvorrat", { role: "staff", init: foreign });
  assert.equal(await switchLink(page, "Büro").getAttribute("href"), "#/auftraege");
  await page.context().close();
  page = await open("kunden", { role: "staff", init: foreign });
  assert.equal(await switchLink(page, "Leitstand").getAttribute("href"), "#/arbeitsvorrat");
  await page.context().close();

  // Ohne Speicher läuft alles weiter, mit den Startseiten.
  page = await open("kunden", { init: () => {
    for (const name of ["getItem", "setItem"]) {
      const real = Storage.prototype[name];
      Storage.prototype[name] = function (key, ...rest) {
        if (String(key).startsWith("gimel-area")) throw new Error("gesperrt");
        return real.call(this, key, ...rest);
      };
    }
  } });
  await switchLink(page, "Leitstand").click();
  await atRoute(page, "arbeitsvorrat");
  await switchLink(page, "Büro").click();
  await atRoute(page, "auftraege");
  await isArea(page, "buero");
  await page.context().close();

  // Alle g-Tasten aus beiden Bereichen.
  for (const start of ["kunden", "arbeitsvorrat"]) {
    page = await open(start);
    for (const [key, route] of Object.entries(KEYS)) {
      await page.evaluate(s => { location.hash = `/${s}`; }, start);
      await atRoute(page, start);
      await isArea(page, start === "kunden" ? "buero" : "leitstand");
      await chord(page, key);
      await atRoute(page, route);
    }
    await page.evaluate(s => { location.hash = `/${s}`; }, start);
    await chord(page, "2");
    await isArea(page, "leitstand");
    await chord(page, "1");
    await isArea(page, "buero");
    await page.keyboard.press("?");
    const help = await page.locator(".shortcut-table").innerText();
    for (const line of ["Bereich Büro", "Bereich Leitstand", "Optimierung"]) assert.ok(help.includes(line), line);
    await page.context().close();
  }

  // Werker: dieselbe Liste wie zuvor, kein Schalter, keine neuen Tasten.
  for (const route of ["heute", "arbeitsvorrat", "optimierung", "auftraege"]) {
    page = await open(route, { role: "worker" });
    assert.deepEqual(await list(page), WORKER_LIST, `Werker auf ${route}`);
    assert.equal(await page.locator(".area-switch").count(), 0);
    assert.equal(await area(page), null);
    await page.context().close();
  }
  page = await open("optimierung", { role: "worker" });
  assert.equal(await page.locator('.sidebar-link[aria-current="page"]').innerText(), "Arbeitsvorrat");
  assert.deepEqual(await stored(page), [], "Werker speichern nichts");
  await page.evaluate(() => { location.hash = "/heute"; });
  await atRoute(page, "heute");
  for (const key of ["1", "2", "i"]) {
    await chord(page, key);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => location.hash), "#/heute", `Werker: g ${key} tut nichts`);
  }
  await chord(page, "o");
  await atRoute(page, "arbeitsvorrat");
  await page.keyboard.press("?");
  const workerHelp = await page.locator(".shortcut-table").innerText();
  for (const line of ["Bereich", "Optimierung"]) assert.ok(!workerHelp.includes(line), line);
  await page.context().close();

  // Dichte: nur die zwei Werte, gleicher Akzent.
  page = await open("kunden");
  const style = page => shell(page).evaluate(el => {
    const s = getComputedStyle(el);
    return { row: s.getPropertyValue("--g-row-h").trim(), control: s.getPropertyValue("--g-control-h").trim(),
      accent: s.getPropertyValue("--gimel-accent").trim(), link: document.querySelector("a.sidebar-link").getBoundingClientRect().height };
  });
  const buero = await style(page);
  assert.deepEqual([buero.row, buero.control, buero.link], ["34px", "30px", 34], "Büro wie bisher");
  await switchLink(page, "Leitstand").click();
  await isArea(page, "leitstand");
  const leitstand = await style(page);
  assert.deepEqual([leitstand.row, leitstand.control, leitstand.link], ["38px", "32px", 38]);
  assert.equal(leitstand.accent, buero.accent);
  await page.context().close();

  // Telefon: der Schalter ist ein Ziel von 44 px und bleibt beim Wischen stehen.
  page = await open("kunden", { width: 375 });
  for (const name of ["Büro", "Leitstand"]) {
    const box = await switchLink(page, name).boundingBox();
    assert.ok(box.height >= 44, `${name}: ${box.height}`);
  }
  await page.locator(".app-sidebar").evaluate(el => { el.scrollLeft = 200; });
  assert.ok((await switchLink(page, "Büro").boundingBox()).x >= 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.context().close();

  assert.deepEqual(errors, []);
  console.log(`Area checks passed: ${BUERO.length + LEITSTAND.length + SHARED.length} routes, lists, switch, memory, ${Object.keys(KEYS).length} g-keys from both areas, workers, density, phone.`);
} finally {
  await browser.close();
}
