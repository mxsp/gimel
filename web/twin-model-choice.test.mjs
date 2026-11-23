// Neue Station: Modellart und Quader (task 38): node twin-model-choice.test.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export { buildDeviceModel } from "./src/components/twin/deviceModels.ts";
      export { MODEL_KINDS } from "./src/factory.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const st = (extra = {}) => ({
  id: 1, label: "Teststation", type: "production", subtype: "", x: 5, y: 5, w: 4, h: 2.5, rotation: 0,
  colour: "#106ba3", active: true, is_storage: false, model_file: "", machine_kind: "plotter", ...extra,
});
const draws = (g) => { let n = 0; g.traverse((o) => { if (o.isMesh) n++; }); return n; };

const auto = m.buildDeviceModel(st());
const box = m.buildDeviceModel(st({ model_kind: "box" }));
assert.ok(auto.name.includes("plotter") || auto.userData.device, "ohne Wahl: eingebautes Modell");
assert.ok(draws(box) <= 6, `Quader hat nur wenige Teile (${draws(box)})`);
assert.ok(draws(auto) > draws(box), "das Gerät ist feiner als der Quader");

// Jede wählbare Art baut etwas, auch an einer Station mit anderem Typ.
for (const k of m.MODEL_KINDS) {
  const g = m.buildDeviceModel(st({ type: "accounting", machine_kind: "", model_kind: k.value }));
  assert.ok(draws(g) > 0, `${k.value} baut ein Modell`);
}
// Wahl geht vor Typ: ein Lager als Plotter gezeichnet sieht aus wie der Plotter.
const asPlotter = m.buildDeviceModel(st({ type: "warehouse", is_storage: true, machine_kind: "", model_kind: "plotter" }));
const plotter = m.buildDeviceModel(st());
assert.equal(draws(asPlotter), draws(plotter), "gewählte Art geht vor dem Stationstyp");
console.log("twin-model-choice ok");
