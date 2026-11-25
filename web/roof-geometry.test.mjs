// Dach- und Mehrgeschoss-Geometrie: node roof-geometry.test.mjs
// Prüft Polygon-Klipping für Dachträger/Lichtbänder, nicht deckungsgleich
// gestapelte Geschosse, Verbindungslinien und 2D-Referenzfang.
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

const r = await bundle("src/components/twin/roofGeometry.ts");
const f = await bundle("src/factory.ts");

// 1) L-förmiger Hallenumriss (Ausschnitt rechts oben: x in [12, 30], z in [10, 20]).
const lShape = [
  [0, 0],
  [30, 0],
  [30, 10],
  [12, 10],
  [12, 20],
  [0, 20],
];

const { trusses, purlins } = r.roofTrussesAndPurlins(lShape);
assert.ok(trusses.length > 0, "L-Halle hat Dachträger");
assert.ok(purlins.length > 0, "L-Halle hat Pfetten");

// Kein einziger Träger- oder Pfetten-Mittelpunkt darf im leeren Ausschnitt (x > 12 && z > 10) liegen!
for (const seg of [...trusses, ...purlins]) {
  const mx = (seg.a[0] + seg.b[0]) / 2;
  const mz = (seg.a[1] + seg.b[1]) / 2;
  assert.ok(f.pointInPolygon([mx, mz], lShape), `Segment (${seg.a} -> ${seg.b}) muss innerhalb der L-Halle liegen`);
  assert.ok(!(mx > 12.1 && mz > 10.1), `Segment darf nicht in den Ausschnitt ragen (${mx}, ${mz})`);
}

// 2) Lichtbänder auf EG mit kleinerem, links aufsitzendem 1. OG (x in [0, 14], z in [0, 16]).
const egRect = [[0, 0], [40, 0], [40, 20], [0, 20]];
const ogLeft = [[0, 0], [14, 0], [14, 16], [0, 16]];
const skylights = r.roofSkylightStrips(egRect, [ogLeft]);
assert.ok(skylights.length > 0, "Freie Dachfläche rechts neben 1. OG bekommt Lichtbänder");
for (const s of skylights) {
  // Kein Lichtband darf unter dem 1. OG liegen.
  assert.ok(
    !f.pointInPolygon([s.cx, s.cz], ogLeft),
    `Lichtband (${s.cx}, ${s.cz}) darf nicht unter dem Obergeschoss liegen`,
  );
  assert.ok(f.pointInPolygon([s.cx, s.cz], egRect), "Lichtband liegt im EG-Umriss");
}

// 3) Streng innenliegendes Obergeschoss wird als Dachaussparung erkannt; versetztes nicht.
const ogInside = [[4, 4], [14, 4], [14, 14], [4, 14]];
const ogOverhang = [[-5, 4], [14, 4], [14, 14], [-5, 14]];
assert.equal(r.polygonStrictlyInside(ogInside, egRect), true);
assert.equal(r.polygonStrictlyInside(ogOverhang, egRect), false);

// 4) Geschoss-Verbindungslinien: gestapelte Ecken verbinden nur die Deckenfuge (6 -> 6.8),
//    auskragende Ecken führen als overhang-Lot auf y = 0.
const egSpan = { id: 1, offset: 0, height: 6, outline: egRect };
const ogSpan = { id: 2, offset: 6.8, height: 4, outline: ogOverhang };
const shafts = r.levelConnectorShafts(ogSpan, [egSpan, ogSpan]);
assert.equal(shafts.length, 4);
const stacked = shafts.filter((s) => !s.overhang);
const overhangs = shafts.filter((s) => s.overhang);
assert.equal(stacked.length, 2, "Zwei Ecken stehen über dem EG");
assert.equal(overhangs.length, 2, "Zwei Ecken kragen links aus");
for (const s of stacked) {
  assert.equal(s.y0, 6);
  assert.equal(s.y1, 6.8);
}
for (const s of overhangs) {
  assert.equal(s.y0, 0);
  assert.equal(s.y1, 6.8);
}

// 5) 2D-Referenzfang an Ecken und Kanten von Nachbarebenen.
const vHit = r.snapToReferenceLevels([14.1, 16.08], [{ outline: ogLeft }], 0.5);
assert.deepEqual(vHit, { point: [14, 16], kind: "vertex" });

const eHit = r.snapToReferenceLevels([7.2, 16.1], [{ outline: ogLeft }], 0.5);
assert.equal(eHit?.kind, "edge");
assert.equal(eHit?.point[1], 16);

const miss = r.snapToReferenceLevels([25, 25], [{ outline: ogLeft }], 0.5);
assert.equal(miss, null);

console.log("roof-geometry.test.mjs: OK");
