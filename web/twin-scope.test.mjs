// Stapel, Nachbarhallen und Wechsel zwischen Ebenen/Hallen (task 40): node twin-scope.test.mjs
// Reine Teile ohne Browser: sceneScope, carrySelection, viewerFocus, viewerProbe.
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * from "./src/components/twin/twinScope.ts";
      export { viewerProbe, twinPart } from "./src/components/agent/twinContext.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
  alias: { "@agentlab": "../agentlab/web/src" },
  nodePaths: [process.cwd() + "/node_modules"],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const lvl = (id, hall_id, level, name, elevation_m = 0) => ({
  id, hall_id, level, level_name: name, elevation_m, height_m: 6, name, stations: 0, default: id === 1,
});
const hall1 = { id: 1, site_id: 1, name: "Halle 1", code: "H1", sort: 0, lat: 51.0, lon: 12.0, rotation_deg: 0,
  map_enabled: false, note: "", floors: [lvl(1, 1, -1, "KG"), lvl(2, 1, 0, "EG"), lvl(3, 1, 1, "1. OG")] };
const hall2 = { id: 2, site_id: 1, name: "Halle 2", code: "H2", sort: 1, lat: 51.0, lon: 12.001, rotation_deg: 90,
  map_enabled: false, note: "", floors: [lvl(4, 2, 0, "EG"), lvl(5, 2, 1, "1. OG")] };
const hall3 = { id: 3, site_id: 1, name: "Lager", code: "L", sort: 2, lat: 0, lon: 0, rotation_deg: 0,
  map_enabled: false, note: "", floors: [lvl(6, 3, 2, "2. OG")] };
const site = { id: 1, name: "Werk", code: "W", address: "", lat: 51, lon: 12, note: "", halls: [hall1, hall2, hall3] };
const otherSite = { ...site, id: 2, halls: [] };
const topo = { sites: [site], unsited_halls: [], unassigned_floors: [], default_floor_id: 2, default_site_id: 1 };
const ref = (hall, id) => ({ floor: hall.floors.find((f) => f.id === id), hall, site });
const plan = (id) => ({ id, name: `P${id}`, outline: [[0, 0], [20, 0], [20, 10], [0, 10]], zones: [], obstacles: [],
  doors: [], aisles: { nodes: [], edges: [] }, scale: 40, grid: 1, snap: 0.25, bg: "" });
const floors = Object.fromEntries([1, 2, 3, 4, 5, 6].map((id) => [id, plan(id)]));
const stations = [
  { id: 10, label: "Plotter", x: 5, y: 5, w: 4, h: 2, rotation: 0, floor_id: 2 },
  { id: 11, label: "Regal", x: 15, y: 5, w: 2, h: 6, rotation: 0, floor_id: 3 },
  { id: 12, label: "Stanze", x: 5, y: 5, w: 3, h: 3, rotation: 0, floor_id: 5 },
];

// --- sceneScope: aus und ohne Ebene
assert.deepEqual(m.sceneScope({ here: undefined, stack: "all", halls: [], floors, stations, topo, enabled: true }).ghosts, []);
const flat = m.sceneScope({ here: ref(hall1, 3), stack: "all", halls: [2], floors, stations, topo, enabled: false });
assert.equal(flat.ghosts.length, 0, "nur 3D zeigt den Stapel");
assert.ok(flat.activeOffset > 0, "1. OG liegt über dem EG, auch ohne 3D");
assert.deepEqual(flat.wanted, []);

// --- Stapel: alle Ebenen, Höhen über dem EG, KG darunter
const eg = m.sceneScope({ here: ref(hall1, 2), stack: "all", halls: [], floors, stations, topo, enabled: true });
assert.equal(eg.activeOffset, 0, "EG liegt auf dem Boden");
assert.deepEqual(eg.ghosts.map((g) => g.id).sort(), [1, 3]);
assert.ok(eg.ghosts.find((g) => g.id === 1).offset < 0, "KG unter dem Boden");
assert.ok(eg.ghosts.find((g) => g.id === 3).offset >= 6.8, "1. OG mindestens ein Geschoss + Spalt höher");
assert.deepEqual(eg.ghosts.find((g) => g.id === 3).stations.map((s) => s.id), [11]);
assert.deepEqual(eg.shownLevels, ["EG", "KG", "1. OG"], "aktive Ebene zuerst");

// Nur ausgewählte Ebenen; ungeladene stehen in ``wanted``, aber nicht im Bild.
const partial = m.sceneScope({ here: ref(hall1, 2), stack: [3], halls: [], floors: { 2: plan(2) }, stations, topo, enabled: true });
assert.deepEqual(partial.ghosts, []);
assert.deepEqual(partial.wanted, [3]);

// --- Nachbarhallen: dieselben Stufen wie der Stapel, je Stufe ein Eintrag
const both = m.sceneScope({ here: ref(hall1, 2), stack: [3], halls: [2, 3], floors, stations, topo, enabled: true });
const h2 = both.neighbors.filter((n) => n.id === 2);
assert.deepEqual(h2.map((n) => n.floor.id).sort(), [4, 5], "EG und 1. OG auch nebenan");
assert.equal(h2.find((n) => n.floor.id === 4).elevation_m, 0, "EG nebenan auf derselben Höhe");
assert.equal(h2.find((n) => n.floor.id === 5).elevation_m, eg.ghosts.find((g) => g.id === 3).offset,
  "1. OG nebenan so hoch wie das 1. OG hier (gleiche Geschosshöhe)");
assert.ok(h2.every((n) => n.x !== null && n.y !== null && n.rotation_deg === 90), "Kartenlage beider Hallen");
assert.ok(Math.abs(h2[0].x) > 50, "Halle 2 liegt ~70 m östlich");
// Halle ohne passende Stufe: ihr EG fehlt auch, also die erste Ebene; ohne Anker keine Lage.
const lager = both.neighbors.filter((n) => n.id === 3);
assert.deepEqual(lager.map((n) => n.floor.id), [6]);
assert.equal(lager[0].x, null);
assert.deepEqual(both.shownHalls, ["Halle 2", "Lager"]);
assert.deepEqual(both.wanted.sort(), [3, 4, 5, 6]);
// Vom 1. OG aus: Höhen relativ zur aktiven Ebene.
const og = m.sceneScope({ here: ref(hall1, 3), stack: [], halls: [2], floors, stations, topo, enabled: true });
assert.deepEqual(og.neighbors.map((n) => [n.floor.id, n.elevation_m]), [[5, 0]], "1. OG nebenan auf Augenhöhe");
assert.deepEqual(og.neighbors[0].stations.map((s) => s.id), [12]);
assert.equal(m.neighborLevels(hall2, [7]).map((f) => f.id)[0], 4, "ohne Treffer das EG");

// --- carrySelection: gleiche Halle
const sel = { extra: [3], halls: [] };
assert.deepEqual(m.carrySelection(ref(hall1, 2), ref(hall1, 3), sel), { extra: [2], halls: [] },
  "die verlassene Ebene bleibt im Stapel, die neue ist nicht mehr zusätzlich");
assert.deepEqual(m.carrySelection(ref(hall1, 2), ref(hall1, 3), { extra: [], halls: [2] }), { extra: [], halls: [2] },
  "ohne Stapel kein Stapel");
assert.equal(m.carrySelection(ref(hall1, 2), ref(hall1, 2), sel), sel, "kein Wechsel, nichts zu tun");
// Andere Halle: dieselben Stufen, verlassene Halle bleibt sichtbar, wenn Hallen gezeigt wurden.
assert.deepEqual(m.carrySelection(ref(hall1, 2), ref(hall2, 4), { extra: [3], halls: [2] }), { extra: [5], halls: [1] });
assert.deepEqual(m.carrySelection(ref(hall1, 2), ref(hall2, 4), { extra: [], halls: [] }), { extra: [], halls: [] });
assert.deepEqual(m.carrySelection(ref(hall1, 2), ref(hall2, 4), { extra: [], halls: [] }, true), { extra: [], halls: [1] },
  "durch die Tür gegangen: die Halle bleibt");
assert.deepEqual(m.carrySelection(ref(hall1, 2), { ...ref(hall2, 4), site: otherSite }, { extra: [3], halls: [2] }),
  { extra: [], halls: [] }, "anderer Standort beginnt neu");

// --- viewerFocus: Blick und Nähe
const st = [
  { id: 1, label: "Vorn", x: 0, y: 10, w: 2, h: 2, rotation: 0 },
  { id: 2, label: "Seite", x: 3, y: 0, w: 2, h: 2, rotation: 0 },
  { id: 3, label: "Hinten", x: 0, y: -10, w: 2, h: 2, rotation: 0 },
];
const look = m.viewerFocus(st, [0, 0], 0);
assert.equal(look.ahead.label, "Vorn", "0° schaut nach +y");
assert.equal(look.nearest.label, "Seite");
assert.equal(look.nearest.distance_m, 2, "Abstand zur Gerätekante");
assert.equal(m.viewerFocus(st, [0, 0], 180).ahead.label, "Hinten");
assert.equal(m.viewerFocus(st, [0, 0], 90).ahead.label, "Seite");
assert.equal(m.viewerFocus(st, [0, 0], 45).ahead, null, "nichts im Kegel");
assert.equal(m.viewerFocus(st, [0, 0], null).ahead, null, "von oben: nur die nächste");
assert.equal(m.viewerFocus([{ ...st[0], rotation: 90, w: 10, h: 1 }], [0, 5], 0).nearest.distance_m, 0,
  "gedreht: 10 m lang in y-Richtung, man steht daran");

// --- viewerProbe
assert.deepEqual(m.viewerProbe("iso", null), { ansicht: "Semi-3D" });
const probe = m.viewerProbe("three", {
  x: 1, y: 2, floor_id: 9, eye_m: 1.6, heading_deg: 0, mode: "walk",
  focus: { ahead: { id: 1, label: "Vorn", distance_m: 9 }, nearest: null },
});
assert.equal(probe.ansicht, "begehen");
assert.equal(probe.standpunkt_ebene, 9);
assert.equal(probe.vor_mir, "Vorn");
assert.equal(probe.vor_mir_id, 1);
assert.equal(probe.blick_richtung, 0);
assert.equal(probe.naechste_station, undefined);

// --- twinPart: Stapel, Hallen, Begehen
const part = m.twinPart({
  where: "studio", floor: { id: 2, name: "EG" }, floorLabel: "Halle 1 · EG", stations: [], selectedId: null,
  mode: "three", step: 0, shownLevels: ["EG", "1. OG"], shownHalls: ["Halle 2"], walking: true,
});
assert.equal(part.view.ebenen_sichtbar, "EG, 1. OG");
assert.equal(part.view.hallen_sichtbar, "Halle 2");
assert.equal(part.view.begehen, true);
assert.ok(part.facts.some((f) => f.includes("übereinander (aktiv: EG)") && f.includes("daneben Halle 2")));
assert.equal(part.suggestions[0].title, "Was steht vor mir?");
assert.ok(part.suggestions.some((s) => s.title === "Ebenen vergleichen"));
assert.ok(part.suggestions.length <= 4);

// --- Häkchen je Halle und Ebene (Twin Studio)
const pick = m.sceneScope({ here: ref(hall1, 2), stack: "all", halls: [2], only: [1, 5], floors, stations, topo, enabled: true });
assert.deepEqual(pick.ghosts.map((g) => g.id), [1], "nur das gewählte KG, nicht der ganze Stapel");
assert.deepEqual(pick.neighbors.map((n) => n.floor.id), [5], "aus Halle 2 nur das gewählte 1. OG");
assert.equal(pick.neighbors[0].elevation_m, eg.ghosts.find((g) => g.id === 3).offset, "auf seiner eigenen Höhe");
assert.deepEqual(m.sceneScope({ here: ref(hall1, 2), stack: "all", halls: [2], only: [], floors, stations, topo, enabled: true }).neighbors, [],
  "leere Wahl: nur die aktive Ebene");
assert.deepEqual(m.defaultShown(ref(hall1, 3)).sort(), [5, 6],
  "Vorgabe: andere Hallen auf derselben Stufe, sonst ihr EG bzw. ihre erste Ebene");
assert.deepEqual(m.toggleHallFloors([], hall2, 2).sort(), [4, 5], "Hallen-Häkchen schaltet alle Ebenen ein");
assert.deepEqual(m.toggleHallFloors([4, 5, 1], hall2, 2), [1], "… und wieder aus");
assert.deepEqual(m.toggleHallFloors([], hall1, 2).sort(), [1, 3], "aktive Halle: alle außer der aktiven");
assert.equal(m.hallCheck([4], hall2, 2), "some");
assert.equal(m.hallCheck([4, 5], hall2, 2), "on");
assert.equal(m.hallCheck([], hall2, 2), "off");
assert.equal(m.hallCheck([], hall1, 2), "some", "aktive Halle ist nie aus");
assert.equal(m.hallCheck([1, 3], hall1, 2), "on");
assert.deepEqual(m.carryFloors(2, 3, [3, 5]), [5, 2], "neue aktive raus, verlassene rein");
assert.deepEqual(m.carryFloors(2, 3, []), [], "nur die aktive gezeigt: bleibt so");
assert.deepEqual(m.carryFloors(2, 4, [], true), [2], "hinübergegangen: die verlassene Ebene bleibt");
assert.deepEqual(m.carryFloors(2, 2, [5]), [5]);

console.log("twin-scope: ok");
