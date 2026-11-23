// Parität: derselbe Grundriss wie tests/core/test_aisle_connection.py, gleiche Meter wie Python.
// Run: node aisles.test.mjs  (bündelt src/factory.ts selbst, braucht keinen Build)
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "aisles-"));
const out = join(dir, "factory.mjs");
await build({ entryPoints: ["src/factory.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const f = await import(out);
const fx = JSON.parse(await readFile("../tests/core/fixtures/aisle_parity.json", "utf8"));

fx.pairs.forEach(([a, b], k) => {
  const r = f.routeMetres(fx.aisles, fx.points[a], fx.points[b], fx.obstacles, fx.outline);
  assert.ok(Math.abs(r.metres - fx.expected[k].metres) < 1e-5, `${a}→${b}: ${r.metres} ≠ ${fx.expected[k].metres}`);
  assert.equal(r.exact, fx.expected[k].exact, `${a}→${b} exact`);
  assert.equal(r.kind, fx.expected[k].kind, `${a}→${b} kind`);
  assert.equal(Boolean(r.warning), Boolean(fx.expected[k].warning), `${a}→${b} warning`);
});

// Pfadfinder: gleiche Weglängen wie Python (oder beide ohne Weg).
const pf = new f.Pathfinder(fx.outline, fx.obstacles.map((o) => o.points));
fx.pathfinder.forEach(([a, b], k) => {
  const way = pf.path(fx.points[a], fx.points[b]);
  const want = fx.pathfinder_expected[k];
  if (want === null) assert.equal(way, null, `${a}→${b} soll ohne Weg sein`);
  else assert.ok(way && Math.abs(f.polylineLength(way) - want) < 1e-5, `${a}→${b}: ${way && f.polylineLength(way)} ≠ ${want}`);
});

// Ein Weg von Hand gewinnt, und ein ungültiger fällt zurück: nur wenn der Standpunkt stimmt.
const net = { nodes: [[0, 5], [30, 5]], edges: [[0, 1]], paths: [{ station: 1, points: [[10, 9], [2, 9], [2, 5]] }] };
assert.equal(f.routeMetres(net, [10, 9], [30, 5]).kind, "manual");
assert.equal(f.routeMetres(net, [12, 9], [30, 5]).kind, "auto");
assert.equal(f.routeMetres({ ...net, paths: [] }, [10, 9], [30, 5]).kind, "auto");

// Vorschlag des Pfadfinders: hinter einer Wand wird ein freier Weg ans Netz vorgeschlagen.
const wallA = [[0, 6], [20, 6], [20, 7], [0, 7]];
const prop = f.proposeConnection({ nodes: [[0, 5], [30, 5]], edges: [[0, 1]] }, [5, 9], new f.Pathfinder(fx.outline, [wallA]));
assert.ok(prop && prop.nodes.length > 2);
const after = f.routeMetres(prop, [5, 9], [30, 5], [{ name: "W", points: wallA }], fx.outline);
assert.equal(after.exact, true);

// Ein Klick verbindet: Kante wird geteilt, danach liegt die Station am Netz.
const g = { nodes: [[0, 0], [20, 0]], edges: [[0, 1]] };
const next = f.connectStation([10, 4], g, [], []);
assert.equal(next.nodes.length, 4);
assert.equal(next.edges.length, 3);
assert.ok(f.aisleAttach([10, 4], next).dist < 1e-9);
// Wand davor: kein Klick-Anschluss.
const wall = [{ name: "W", points: [[-5, 1], [25, 1], [25, 2], [-5, 2]] }];
assert.equal(f.connectStation([10, 4], g, wall, []), null);
await rm(dir, { recursive: true });
console.log("aisles: ok");
