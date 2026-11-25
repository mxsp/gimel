// Tür- & Zugangslogik: node door-logic.test.mjs
// Prüft Wand-Einrasten mit Eck-Klemmung, Rasterfang entlang der Wand,
// begehbare Wandöffnungen (keine Lücken für Fenster/Treppen/Aufzüge)
// und Schutz angrenzender Querwände.
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (entry) => {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
};

const f = await bundle("src/factory.ts");
const c = await bundle("src/components/twin/collision.ts");
const w = await bundle("src/components/twin/walkHalls.ts");

const rectOutline = [[0, 0], [20, 0], [20, 12], [0, 12]];
const floor = {
  ...f.EMPTY_FLOOR,
  outline: rectOutline,
  snap: 0.25,
};

// 1) Breites Hallentor (4 m) nahe Ecke (0.2, 0.1) darf NICHT über die Ecke hinausragen!
const gateNearCorner = f.snapDoorToWall(floor, [0.2, 0.1], "gate", 4.0);
assert.equal(gateNearCorner.snapped, true);
assert.equal(gateNearCorner.point[1], 0, "Rastet auf Nordwand y = 0");
assert.ok(gateNearCorner.point[0] >= 2.0, `Tormitte (${gateNearCorner.point[0]}) muss >= halbe Breite (2 m) von Ecke weg bleiben`);
assert.deepEqual(gateNearCorner.dir, [1, 0]);

// 2) Wand ist schmaler als Tor → zentriert sauber auf Wandmitte.
const narrowFloor = { ...floor, outline: [[0, 0], [3, 0], [3, 10], [0, 10]] };
const centeredGate = f.snapDoorToWall(narrowFloor, [0.2, 0.05], "gate", 4.0);
assert.deepEqual(centeredGate.point, [1.5, 0]);

// 3) Fenster, Treppen & Aufzüge schneiden KEINE Lücken in den unteren Wandsockel / Kollisionswand!
const nonPassable = [
  { name: "Fenster Nord", x: 10, y: 0, width: 3.0, kind: "window" },
  { name: "Treppe 1", x: 5, y: 0.2, width: 1.8, kind: "stair" },
  { name: "Aufzug 1", x: 15, y: 0.2, width: 2.0, kind: "lift" },
];
const intactWalls = c.wallPieces(rectOutline, nonPassable);
assert.equal(intactWalls.length, 4, "Fenster, Treppen und Aufzüge lassen alle 4 Außenwände geschlossen");

// 4) Echte Tür / Hallentor schneidet genau die eigene Wand, NICHT die senkrechte Nachbarwand!
const passable = [
  { name: "Hallentor 1", x: 2.25, y: 0, width: 4.0, kind: "gate" },
  { name: "Notausgang", x: 20, y: 6, width: 1.2, kind: "emergency" },
];
const cutWalls = c.wallPieces(rectOutline, passable);
// Nordwand (2 Stücke) + Ostwand (2 Stücke) + Südwand (1) + Westwand (1) = 6 Stücke
assert.equal(cutWalls.length, 6, `Erwartet 6 Wandstücke, erhalten ${cutWalls.length}`);
// Westwand (x=0, y=12 -> y=0) darf vom nahen Nordwand-Tor NICHT angeschnitten werden!
const westWall = cutWalls.find((s) => s.a[0] === 0 && s.b[0] === 0);
assert.ok(westWall, "Westwand bleibt vollständig erhalten");
assert.equal(Math.hypot(westWall.b[0] - westWall.a[0], westWall.b[1] - westWall.a[1]), 12);

// 5) Innenraum (Raumbox) mit Tür: wird zu begehbaren offenen Wandstücken statt massivem Block!
const roomObs = {
  name: "Bürokabine",
  kind: "room",
  points: [[4, 4], [10, 4], [10, 8], [4, 8]],
};
const roomDoor = { name: "Bürotür", x: 7, y: 4, width: 1.2, kind: "door" };
assert.equal(c.obstacleHasDoor(roomObs, [roomDoor]), true);
const roomFloor = { ...floor, obstacles: [roomObs], doors: [roomDoor] };
const roomWorld = c.buildTwinWorld(roomFloor, [], { openDoors: true });
// Durch die Bürotür bei (7, 4) hindurch ins Innere (7, 5.5) darf keine Kollision blockieren!
assert.equal(roomWorld.blocks({ kind: "circle", x: 7, y: 4, r: 0.28 }), false, "Türöffnung im Innenraum ist begehbar");
assert.equal(roomWorld.blocks({ kind: "circle", x: 7, y: 6, r: 0.28 }), false, "Inneres des Innenraums ist begehbar");
// Neben der Tür bei (5, 4) blockiert die Raumwand weiterhin.
assert.equal(roomWorld.blocks({ kind: "circle", x: 5, y: 4, r: 0.28 }), true, "Raumwand neben der Tür bleibt fest");

// 6) Zwei aneinanderstoßende Hallenwände: eine einzelne Tür in Halle 1 öffnet BEIDE Hallenwände!
const hall1 = {
  id: 1,
  label: "Halle 1",
  x: 0,
  y: 0,
  rotation_deg: 0,
  elevation_m: 0,
  floor: {
    ...f.EMPTY_FLOOR,
    id: 1,
    outline: [[0, 0], [20, 0], [20, 12], [0, 12]],
    doors: [{ name: "Durchgang", x: 20, y: 6, width: 2.0, kind: "door" }],
  },
  stations: [],
};
const hall2 = {
  id: 2,
  label: "Halle 2",
  x: 20,
  y: 0,
  rotation_deg: 0,
  elevation_m: 0,
  floor: {
    ...f.EMPTY_FLOOR,
    id: 2,
    outline: [[0, 0], [18, 0], [18, 12], [0, 12]],
    doors: [], // Halle 2 hat KEINE eigene Tür an der gemeinsamen Wand!
  },
  stations: [],
};
const combinedWorld = w.hallWalkWorld([hall1, hall2]);
assert.equal(
  combinedWorld.blocks({ kind: "circle", x: 20, y: 6, r: 0.3 }),
  false,
  "Durchgang zwischen zwei aneinanderstoßenden Hallenwänden ist auf beiden Seiten offen",
);
assert.equal(
  combinedWorld.blocks({ kind: "circle", x: 20, y: 2, r: 0.3 }),
  true,
  "Gemeinsame Hallenwand neben dem Durchgang bleibt fest",
);

console.log("door-logic.test.mjs: OK");
