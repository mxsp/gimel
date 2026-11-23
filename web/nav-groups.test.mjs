// Navigation in Gruppen (Aufgabe 35 B): node nav-groups.test.mjs
// Reine Teile ohne Browser: areaNav, menuNav, toolsOpen, visibleNav, areaTarget und die (i)-Texte je Route.
import assert from "node:assert/strict";
import { build } from "esbuild";

// nav.ts merkt sich Bereiche im localStorage; in Node gibt es keinen, also ein kleiner Ersatz.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const out = await build({
  stdin: {
    contents: `export * from "./src/nav.ts"; export { PAGE_INFO, pageInfo, pageInfoKey } from "./src/ui/pageInfo.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
  nodePaths: [process.cwd() + "/node_modules"],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const features = ["vision", "library"];
const labels = (groups) => groups.flatMap((g) => g.items.map((i) => i.label));
const tools = (groups) => groups.find((g) => g.collapsible);

// Leitstand: Logik & Planung klar von Stationen und Fertigung getrennt; Unteransichten (Freies Schachteln, Zeichnungen, Optimierung) und AppSwitcher-Ziele (Twin Studio, Agent Lab) doppeln die Leiste nicht mehr.
{
  const groups = m.areaNav("admin", features, "leitstand");
  assert.deepEqual(groups.map((g) => g.label), ["Planung & Logik", "Stationen", "Fertigung"]);
  assert.deepEqual(groups[0].items.map((i) => i.label), ["Aufträge", "Disposition", "Schachteln"]);
  assert.deepEqual(groups[1].items.map((i) => i.label), ["Arbeitsvorrat"]);
  assert.deepEqual(groups[2].items.map((i) => i.label), ["Kommissionierung", "Produktion", "Versand"]);
  assert.equal(tools(groups), undefined, "Keine überflüssige Werkzeuge-Gruppe mehr");
  assert.ok(!labels(groups).includes("Benutzer") && !labels(groups).includes("Admin"));
}

// Büro: Auftragsweg + Stammdaten; Verwaltung steht im Kontomenü, Agent Lab im AppSwitcher.
{
  const groups = m.areaNav("admin", features, "buero");
  assert.deepEqual(groups.map((g) => g.label), ["Auftragsweg", "Stammdaten"]);
  assert.deepEqual(labels(groups),
    ["Auftragserfassung", "Aufträge", "Versand", "Buchhaltung", "Kalender", "Kunden", "Lager", "Werkstoffe", "Formen"]);
  assert.equal(tools(groups), undefined, "Im Büro gibt es keine Werkzeuge-Gruppe");
  assert.deepEqual(m.menuNav("admin", features).map((i) => i.label), ["Benutzer", "Compliance", "Admin"]);
  assert.deepEqual(m.menuNav("staff", features).map((i) => i.label), ["Compliance", "Admin"], "Benutzer nur für Admins");
  assert.deepEqual(m.menuNav("worker", features), [], "Werker haben keine Verwaltung");
  assert.deepEqual(m.externalMenuNav("admin", features), []);
}

// Werker: flache Liste nach Stationen, Fertigung und Halle.
{
  const groups = m.areaNav("worker", features, "leitstand");
  assert.equal(tools(groups), undefined);
  assert.deepEqual(labels(groups), ["Arbeitsvorrat", "Aufträge", "Kommissionierung", "Produktion",
    "Versand"]);
}

// Tasten bleiben: jede g-Taste zeigt weiter auf ihre Route, auch für Unteransichten und Menü-Einträge.
{
  const keyed = m.visibleNav("admin", features).flatMap((g) => g.items).filter((i) => i.key);
  const byKey = Object.fromEntries(keyed.map((i) => [i.key, i.route]));
  assert.equal(byKey.j, "freies-schachteln");
  assert.equal(byKey.i, "optimierung");
  assert.equal(byKey.z, "zeichnungen");
  assert.equal(Object.keys(byKey).length, new Set(Object.keys(byKey)).size, "keine doppelte Taste");
}

// Unteransichten markieren ihre Hauptseite in der Seitenleiste.
{
  const groups = m.areaNav("admin", features, "leitstand");
  assert.equal(m.toolsOpen(false, "grundriss", groups), false);
  assert.equal(m.navSection("grundriss/optimierung", "admin"), "arbeitsvorrat");
  assert.equal(m.navSection("optimierung", "admin"), "arbeitsvorrat");
  assert.equal(m.navSection("arbeitsplaetze", "admin"), "arbeitsvorrat");
  assert.equal(m.navSection("freies-schachteln", "admin"), "schachteln");
  assert.equal(m.navSection("zeichnungen", "admin"), "schachteln");
  assert.equal(m.activeStationId("station/7"), "7");
  assert.equal(m.activeStationId("grundriss/station/12"), "12");
  assert.equal(m.activeStationId("grundriss"), null);
  assert.equal(m.toolsOpen(true, "kunden", m.areaNav("admin", features, "buero")), false, "keine Gruppe, nichts offen");
}

// Der Bereichsschalter führt weiter auf eine gemerkte Menü-Seite, wenn die Rolle sie öffnen darf.
{
  store.clear();
  store.set("gimel-area-buero", "benutzer");
  assert.equal(m.areaTarget("buero", "admin", features), "benutzer");
  assert.equal(m.areaTarget("buero", "staff", features), "auftraege", "Benutzer ist für Personal kein Ziel");
  store.set("gimel-area-leitstand", "optimierung");
  assert.equal(m.areaTarget("leitstand", "admin", features), "optimierung", "eine Werkzeug-Seite bleibt Ziel");
}

// (i) „Wie funktioniert das?": jede Hash-Route der Leiste und des Menüs hat zwei Sätze.
{
  const routes = m.visibleNav("admin", features).flatMap((g) => g.items).filter((i) => !i.href).map((i) => i.route);
  for (const route of ["heute", ...routes]) {
    const text = m.pageInfo(route);
    assert.ok(text, `Erklärung für ${route}`);
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.equal(sentences.length, 2, `${route}: zwei Sätze, nicht ${sentences.length}`);
  }
  assert.equal(m.pageInfoKey("station/7"), "station");
  assert.equal(m.pageInfoKey("grundriss/station/7"), "station");
  assert.equal(m.pageInfoKey("grundriss/admin"), "grundriss/admin");
  assert.equal(m.pageInfoKey("grundriss/optimierung"), "optimierung");
  assert.equal(m.pageInfoKey("bereitstellen"), "kommissionierung");
  assert.equal(m.pageInfoKey("auftraege/AB-1"), "auftraege");
  assert.equal(m.pageInfoKey(""), "heute");
}

console.log("Nav groups passed: Leitstand (Planung & Logik / Stationen / Fertigung + 4 Werkzeuge + Assistenz), Büro (Auftragsweg / Stammdaten / Assistenz), Verwaltung im Menü, Werker flach, Tasten, Gruppe offen/zu, Bereichsziel, (i) je Route.");
