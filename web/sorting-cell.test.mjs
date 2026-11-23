// Sortierzelle, reine Rechnungen: node sorting-cell.test.mjs
// Die Teileerkennung der Zelle ist eine Übersetzung von core/vision.py::match.
// Geprüft werden alle fünf Formen, gedrehte Lage, Maße, Fremdteil und Rauschen.
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (entry) => {
  const out = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
};
const forms = await bundle("src/components/robots/sortingCell/forms.ts");
const vision = await bundle("src/components/robots/sortingCell/teilerkennung.ts");
const { FORMS, ODD_FORM, placeRings } = forms;
const { classify, measureFromFrame, orientedBox, SURE } = vision;

const rng = (seed = 7) => {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
};

// 1. Jede offene Form wird bei sauberem Bild sicher erkannt.
for (const f of FORMS) {
  const hit = classify(placeRings(f.rings, -420, 16, 0));
  assert.equal(hit.form?.id, f.id, `${f.id} muss sich selbst treffen`);
  assert.ok(hit.confidence >= SURE, `${f.id}: ${hit.confidence} ist nicht sicher`);
  assert.equal(hit.sure, true);
  assert.equal(hit.ambiguous, 0);
  const nominal = orientedBox(f.rings[0]);
  assert.ok(Math.abs(hit.box.length_mm - nominal.length_mm) < 1, `${f.id}: Länge passt nicht`);
  assert.ok(Math.abs(hit.box.width_mm - nominal.width_mm) < 1, `${f.id}: Breite passt nicht`);
}

// 2. Drehung und Verschiebung auf dem Tisch ändern die Form nicht.
for (const f of FORMS) {
  for (const angle of [-70, -23.9, 0, 37, 88]) {
    const hit = classify(placeRings(f.rings, -419.9, 16.1, angle));
    assert.equal(hit.form?.id, f.id, `${f.id} bei ${angle}°`);
  }
}

// 3. Das umschreibende Rechteck misst die gedrehte Lage in Millimetern.
const rect = [[-50, -20], [50, -20], [50, 20], [-50, 20]];
const a = (30 * Math.PI) / 180;
const turned = rect.map(([x, y]) => [100 + x * Math.cos(a) - y * Math.sin(a), 200 + x * Math.sin(a) + y * Math.cos(a)]);
const box = orientedBox(turned);
assert.ok(Math.abs(box.length_mm - 100) < 0.01, `Länge ${box.length_mm}`);
assert.ok(Math.abs(box.width_mm - 40) < 0.01, `Breite ${box.width_mm}`);
assert.ok(Math.abs(Math.abs(box.angle_deg) - 30) < 0.01, `Winkel ${box.angle_deg}`);
assert.ok(Math.abs(box.x_mm - 100) < 0.01 && Math.abs(box.y_mm - 200) < 0.01, "Lage");

// 4. Ein Fremdteil ohne Template bleibt unbekannt — nie ein falscher Treffer.
const odd = classify(placeRings(ODD_FORM.rings, -420, 0, 12));
assert.equal(odd.form, null, "Fremdteil darf keiner Klasse zugeordnet werden");
assert.equal(odd.sure, false);

// 5. Rauschen senkt die Formübereinstimmung; die Schwelle bleibt SURE.
const clean = classify(placeRings(FORMS[0].rings, -420, 0, 0));
const noisy = classify(measureFromFrame(placeRings(FORMS[0].rings, -420, 0, 0), 1, rng(99)));
assert.ok(noisy.confidence < clean.confidence, `Rauschen muss treffen: ${noisy.confidence} < ${clean.confidence}`);
assert.ok(noisy.confidence >= 0 && noisy.confidence <= 1);

// 6. Dieselbe Form in mehreren Innenaufträgen ist keine Verwechslung; andere
//    Formen werden (wenn der Vorfilter sie zulässt) als Alternativen geführt.
const again = classify(placeRings(FORMS[2].rings, -420, 0, 0), { work_order: "IA-9999" });
assert.ok(again.alternatives.some((alt) => alt.sameShape && alt.work_order === "IA-9999"));
for (const alt of again.alternatives) {
  if (!alt.sameShape) assert.notEqual(alt.form.id, FORMS[2].id, "Alternative ist eine andere Form");
}

console.log("sorting-cell.test.mjs: OK (5 Formen, Drehung, Maße, Fremdteil, Rauschen, Alternativen)");
