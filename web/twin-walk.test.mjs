// Treppe und Aufzug beim Begehen (task 38): node twin-walk.test.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * from "./src/components/twin/walkLevels.ts";
      export { buildTwinWorld } from "./src/components/twin/collision.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const floor = {
  id: 1, name: "Halle", outline: [[0, 0], [64, 0], [64, 32], [0, 32]], zones: [], obstacles: [],
  doors: [
    { name: "Tor Versand", x: 64, y: 8, width: 3, kind: "gate" },
    { name: "Treppe", x: 30, y: 32, width: 2.5, kind: "door" },
    { name: "Aufzug", x: 34, y: 32, width: 2.5, kind: "door" },
  ],
  aisles: { nodes: [], edges: [] }, scale: 40, grid: 1, snap: 0.25, bg: "",
};
const links = m.verticalLinks(floor, []);
assert.equal(links.length, 2, "Tore zählen nicht");
const stair = links.find((l) => l.kind === "stair"), lift = links.find((l) => l.kind === "lift");
assert.ok(stair && lift);
// Südwand: die Normale zeigt nach −y in die Halle
assert.ok(stair.ny < -0.99 && Math.abs(stair.nx) < 1e-6, "Normale zeigt in die Halle");

const a = m.arrivalSpot(lift);
assert.ok(a.pos[1] < 32 && a.pos[1] > 28, "man steht vor dem Aufzug, in der Halle");
assert.ok(Math.abs(a.pos[0] - 34) < 1e-6);

// Der Aufzug ist ein Hindernis; die Treppe ist begehbar, nur ihre Geländer
// sind Körper. Der Platz davor bleibt frei.
const world = m.buildTwinWorld({ ...floor, obstacles: [
  { name: "Aufzug", points: m.linkFootprint(lift) },
  ...m.stairRailFootprints(stair).map((points) => ({ name: "Treppe", points })),
] }, []);
const hit = (p) => world.query({ kind: "circle", x: p[0], y: p[1], r: 0.35 }, { groups: ["station", "obstacle", "wall"] }).length;
assert.ok(hit([34, 31.6]) > 0, "im Aufzugskörper steht man nicht");
assert.equal(hit(a.pos), 0, "vor dem Aufzug ist es frei");
assert.equal(hit([29, 31]), 0, "auf dem Treppenlauf steht man frei");
assert.ok(hit([30, 31]) > 0, "die Trennlinie ist ein Körper");
assert.ok(hit([28.5, 31]) > 0, "die Außenkante ist ein Körper");

// Reichweite
assert.equal(m.nearestLink(links, a.pos)?.kind, "lift");
assert.equal(m.nearestLink(links, [10, 10]), null, "weit weg: nichts");

// Ebenen: oben zuerst
const ch = m.levelChoices([{ id: 3, label: "KG", level: -1, elevation_m: -4 }, { id: 4, label: "EG", level: 0, elevation_m: 0 }, { id: 5, label: "1. OG", level: 1, elevation_m: 7 }]);
assert.deepEqual(ch.map((c) => c.label), ["1. OG", "EG", "KG"]);
assert.ok(m.rideMs("lift", 0, 1) < m.rideMs("stair", 0, 1), "Aufzug ist schneller");
assert.ok(m.rideMs("lift", 0, 3) <= 2400);
assert.equal(m.matchingLink(links, "lift", "Aufzug")?.name, "Aufzug");
assert.equal(m.linkKindOf({ name: "Tor", kind: "gate" }), null);

// Treppe: ein echter Lauf — rechts hinauf, links in den Schacht hinunter.
const levels = [
  { id: 3, label: "KG", level: -1, elevation_m: -4 },
  { id: 4, label: "EG", level: 0, elevation_m: 0 },
  { id: 5, label: "1. OG", level: 1, elevation_m: 7 },
];
assert.equal(m.nextLevel(levels, 4, "up")?.label, "1. OG");
assert.equal(m.nextLevel(levels, 4, "down")?.label, "KG");
assert.equal(m.nextLevel(levels, 5, "up"), null, "oben ist Schluss");
assert.equal(m.nextLevel(levels, 3, "down"), null, "unten ist Schluss");
assert.equal(m.stairLane(stair, [30 - 1, 31]), "up", "rechte Hälfte führt hinauf");
assert.equal(m.stairLane(stair, [30 + 1, 31]), "down", "linke Hälfte führt hinunter");
// Trittflächen: vorn auf dem Boden, an der Wand auf voller Höhe; links negativ.
const surface = (x, y) => m.stairSurface(stair, [x, y]);
assert.equal(surface(29.25, 28.4)?.height, 0, "vorn beginnt der Lauf auf dem Boden");
assert.ok(surface(29.25, 30.2).height > 0.2, "weiter oben liegt die Stufe höher");
assert.ok(Math.abs(surface(29.25, 32)?.height - m.STAIR_RISE_M) < 1e-6, "an der Wand ist oben Schluss");
assert.ok(Math.abs(surface(30.75, 32)?.height + m.STAIR_RISE_M) < 1e-6, "links geht es in den Schacht");
assert.equal(surface(29.25, 28), null, "weit vor dem Lauf ist keine Stufe");
assert.equal(m.stairStep(links, [29, 31])?.dir, "up");
assert.equal(m.atStair(lift, [34, 31]), null, "der Aufzug hat keinen Lauf");
// Drei Geländer, nicht ein Klotz; die Öffnung liegt über dem linken Lauf.
assert.equal(m.stairRailFootprints(stair).length, 3);
const well = m.stairWellHole(stair);
assert.ok(well && well.some(([x]) => x < 30), "der Schacht liegt auf der linken Hälfte");
const back = m.arrivalSpot(stair, "down");
assert.equal(m.stairLane(stair, back.pos), "down", "nach oben steht man auf der Seite, die zurückführt");
assert.equal(m.atStair(stair, back.pos), null, "die Ankunft löst nicht sofort wieder aus");
assert.equal(m.arrivalSpot(lift).pos[0], 34);
assert.match(m.stairHint(stair, levels[2], levels[0]), /rechts hinauf, links hinunter/);
assert.match(m.stairHint(stair, levels[2], null), /hinauf nach 1\. OG/);
assert.match(m.stairHint(stair, null, levels[0]), /hinunter nach KG/);
console.log("twin-walk ok");
