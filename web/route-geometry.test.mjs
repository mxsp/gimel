// Wege-Editor, reine Rechnungen: node route-geometry.test.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({ entryPoints: ["src/components/robots/routeGeometry.ts"], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
const g = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const hall = [[0, 0], [30, 0], [30, 20], [0, 20]];
const pillar = { name: "Säule", points: [[14, 9], [16, 9], [16, 11], [14, 11]] };
const station = { name: "Laser 1", points: g.stationPolygon({ x: 22, y: 5, w: 4, h: 2, rotation: 0 }, 0.15) };
const env = { outline: hall, obstacles: [pillar], stations: [station] };

// Längen: Pendel einfach, Umlauf doppelt; Rundkurs schließt.
const sq = [[2, 2], [12, 2], [12, 6], [2, 6]];
assert.equal(g.pathLength(sq, false), 24);
assert.equal(g.pathLength(sq, true), 28);
assert.equal(g.cycleLength(sq, false), 48);
assert.equal(g.cycleLength(sq, true), 28);

// Ein freier Weg hat keine Befunde.
assert.deepEqual(g.routeIssues(sq, true, env), []);

// Durch die Säule: Fehler am richtigen Abschnitt.
const through = g.routeIssues([[5, 10], [25, 10]], false, env);
assert.ok(through.some((i) => i.segment === 0 && i.level === "error" && i.text.includes("Säule")), JSON.stringify(through));

// Außerhalb der Halle: Punkt- und Abschnittsfehler.
const outside = g.routeIssues([[5, 5], [35, 5]], false, env);
assert.ok(outside.some((i) => i.point === 1 && i.level === "error"));
assert.ok(outside.some((i) => i.segment === 0 && i.text.includes("verlässt")));

// Durch eine Station: Hinweis, kein Fehler; Andocken am Rand ist frei.
const st = g.routeIssues([[18, 5], [27, 5]], false, env);
assert.ok(st.some((i) => i.level === "warning" && i.text.includes("Laser 1")));
assert.ok(!st.some((i) => i.level === "error"));
assert.deepEqual(g.routeIssues([[18, 5], [19.95, 5]], false, env), [], "an der Kante andocken");

// Gedrehte Station: Ecken stimmen.
const rot = g.stationPolygon({ x: 0, y: 0, w: 2, h: 2, rotation: 45 });
assert.ok(Math.abs(Math.hypot(...rot[0]) - Math.SQRT2) < 1e-9);
assert.ok(Math.abs(rot[0][0]) < 1e-9 || Math.abs(rot[0][1]) < 1e-9);

// Einrasten: Knoten vor Raster, sonst 0,5 m.
assert.deepEqual(g.snapPoint([10.2, 4.9], { nodes: [[10, 5]], grid: 0.5, radius: 0.5 }), { p: [10, 5], kind: "node" });
assert.deepEqual(g.snapPoint([10.8, 4.2], { nodes: [[10, 5]], grid: 0.5, radius: 0.5 }), { p: [11, 4], kind: "grid" });
assert.deepEqual(g.snapPoint([1.95, 2.1], { nodes: [], grid: 0.5, radius: 0.5, extra: [[2, 2]] }).kind, "point");

// Nächster Abschnitt und Einfügen.
const near = g.nearestSegment(sq, [12.4, 4], true);
assert.equal(near.index, 1);
assert.deepEqual(g.insertAfter(sq, 1, [12, 4]), [[2, 2], [12, 2], [12, 4], [12, 6], [2, 6]]);
const nearClose = g.nearestSegment(sq, [1.6, 4], true);
assert.equal(nearClose.index, 3, "Schlussabschnitt des Rundkurses");

// Vereinfachen: Doppelte und gerade Zwischenpunkte fallen weg, Ecken bleiben.
assert.deepEqual(g.simplify([[0, 0], [5, 0], [5, 0], [10, 0], [10, 5]]), [[0, 0], [10, 0], [10, 5]]);
assert.deepEqual(g.simplify([[0, 0], [10, 0], [5, 0]]), [[0, 0], [10, 0], [5, 0]], "Umkehr bleibt");

// Start verlegen.
assert.deepEqual(g.startAt(sq, 2), [[12, 6], [2, 6], [2, 2], [12, 2]]);

// Text hin und zurück.
const t = g.parseRouteText("6, 16\n14 16; (22, 16.5)");
assert.equal(t.error, "");
assert.deepEqual(t.route, [[6, 16], [14, 16], [22, 16.5]]);
assert.ok(g.parseRouteText("6, x").error);
assert.equal(g.routeText([[1.234, 2]]), "1.23, 2");

console.log("route geometry checks passed: Längen, Prüfung (Umriss, Hindernis, Station), Einrasten, Einfügen, Vereinfachen, Text.");
