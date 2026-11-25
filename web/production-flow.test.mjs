// Produktionsfluss-Graph Layout: node production-flow.test.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/components/productionFlowLayout.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const stations = [
  { id: 1, label: "Plattenregal", type: "warehouse", jobs: 2, minutes: 20 },
  { id: 2, label: "Plotter 1", type: "production", jobs: 5, minutes: 185 },
  { id: 3, label: "Plotter 2", type: "production", jobs: 1, minutes: 40 },
  { id: 4, label: "Packtisch", type: "shipping", jobs: 3, minutes: 35 },
  { id: 5, label: "Reserve", type: "production", jobs: 0, minutes: 0 },
];

const edges = [
  { from: 1, to: 2, kind: "supply", count: 4, metres: 18, exact: true, materials: ["EPDM"] },
  { from: 2, to: 4, kind: "dispatch", count: 3, metres: 24, exact: true, materials: ["EPDM"] },
];

const full = m.layoutProductionFlow(stations, edges);
assert.equal(full.nodes.length, 5);
assert.equal(full.edges.length, 2);
assert.equal(full.totalTransfers, 7);
assert.equal(full.totalMetres, 4 * 18 + 3 * 24);
assert.equal(full.bottleneck?.id, 2, "Plotter 1 (185 min) ist Engpass");
assert.ok(full.edges[0].strokeWidth > full.edges[1].strokeWidth, "Mehr Übergaben → breitere Kante");

// Spaltenreihenfolge: Lager (0) < Fertigung (1) < Versand (2)
const byId = new Map(full.nodes.map((n) => [n.id, n]));
assert.ok(byId.get(1).x < byId.get(2).x && byId.get(2).x < byId.get(4).x);

// Filter: nur aktive Stationen blendet Reserve (id 5) aus
const activeOnly = m.layoutProductionFlow(stations, edges, { onlyActive: true });
assert.equal(activeOnly.nodes.length, 4);
assert.ok(!activeOnly.nodes.some((n) => n.id === 5));

// Filter: nur Materialzufuhr
const supplyOnly = m.layoutProductionFlow(stations, edges, { kindFilter: "supply" });
assert.equal(supplyOnly.edges.length, 1);
assert.equal(supplyOnly.edges[0].from, 1);

console.log("production-flow.test.mjs: OK");
