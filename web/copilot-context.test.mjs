// Assistenten-Leiste: Ansichtsausschnitt (task 38 B): node copilot-context.test.mjs
// Reine Teile ohne Browser: Begrenzung der Meldung, Kurzzeile, Seitenkontext aus der Adresse,
// Zwillingskontext (Auswahl, Ebene, Darstellung, Befunde).
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * from "../agentlab/web/src/pageContext.ts";
      export { routeContext } from "./src/components/agent/routeContext.ts";
      export { twinPart } from "./src/components/agent/twinContext.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
  alias: { "@agentlab": "../agentlab/web/src" },
  nodePaths: [process.cwd() + "/node_modules"],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

// toWire: begrenzt und ohne Leeres
const big = m.toWire({
  route: "r".repeat(500), title: "t".repeat(500), active: true,
  entity: { type: "station", id: 3, label: "L".repeat(300) },
  selection: Array.from({ length: 50 }, (_, i) => ({ type: "station", id: i })),
  view: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, "v".repeat(300)])),
  facts: Array.from({ length: 40 }, () => "f".repeat(400)),
});
assert.equal(big.route.length, 120);
assert.equal(big.title.length, 120);
assert.equal(big.entity.label.length, 80);
assert.equal(big.selection.length, m.LIMITS.selection);
assert.equal(Object.keys(big.view).length, m.LIMITS.view);
assert.ok(Object.values(big.view).every((v) => v.length <= 80));
assert.equal(big.facts.length, m.LIMITS.facts);
assert.ok(big.facts.every((f) => f.length <= m.LIMITS.text));
assert.deepEqual(m.toWire({ route: "heute", active: false }), { route: "heute" });
assert.equal(m.toWire({ route: "x", active: true, entity: { type: "" } }).entity, undefined);

// Kurzzeile
assert.equal(m.contextChip({ route: "heute", active: true, title: "Heute" }), "Heute");
assert.equal(m.contextChip({ route: "g", active: true, title: "Grundriss", entity: { type: "station", label: "Laser 2" } }), "Grundriss · Laser 2");
assert.equal(m.contextChip({ route: "g", active: true, title: "Grundriss", selection: [{ type: "station" }, { type: "station" }] }), "Grundriss · 2 markiert");

// Seitenkontext aus der Adresse
assert.equal(m.routeContext("heute").title, "Heute");
assert.equal(m.routeContext("").title, "Heute");
const order = m.routeContext("auftraege/AB-26-0005");
assert.equal(order.title, "Aufträge");
assert.deepEqual(order.entity, { type: "order", id: "AB-26-0005", label: "AB-26-0005" });
assert.deepEqual(m.routeContext("grundriss/station/7").entity, { type: "station", id: 7 });
assert.equal(m.routeContext("produktion/IA-26-0001").entity.type, "workorder");
assert.equal(m.routeContext("auftragserfassung/neu").entity, undefined);
assert.equal(m.routeContext("grundriss").suggestions, undefined, "Zwilling meldet seine Fragen selbst");

// Zwillingskontext
const stations = [{ id: 1, label: "Plotter 1" }, { id: 2, label: "Stanze" }];
const part = m.twinPart({
  where: "portal", floor: { id: 9, name: "EG" }, floorLabel: "Halle 1 · EG", stations, selectedId: 2,
  mode: "three", step: 1,
  analysis: { summary: { danger: 1, warning: 2, info: 3 }, loads: [{ label: "Stanze", state: "over" }, { label: "X", state: "ok" }] },
  robots: [{}, {}], layers: { fluss: true, roboter: false },
});
assert.equal(part.title, "Digitaler Grundriss · Halle 1 · EG");
assert.deepEqual(part.entity, { type: "station", id: 2, label: "Stanze" });
assert.equal(part.view.mode, "3D");
assert.equal(part.view.zeitschritt, "Nach 1 Arbeitstag");
assert.equal(part.view.floor_id, 9);
assert.equal(part.view.anzeige_an, "fluss");
assert.ok(part.facts.some((f) => f.includes("1 kritisch, 2 Warnungen")));
assert.ok(part.facts.some((f) => f.includes("Überbucht: Stanze")));
assert.ok(part.facts.some((f) => f.includes("Prognose")));
assert.ok(part.suggestions.length <= 4 && part.suggestions[0].text.includes("Stanze"));
const studio = m.twinPart({ where: "studio", floor: null, stations: [], selectedId: null, mode: "iso", step: 0 });
assert.equal(studio.title, "Twin Studio");
assert.equal(studio.entity, undefined);
assert.equal(studio.view.mode, "Semi-3D");

console.log("copilot-context: ok");
