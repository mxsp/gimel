// Run after npm run build: the quick editor check, against the same cases as the server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "nesting-"));
execFileSync("node_modules/.bin/esbuild", ["src/nesting.ts", "--format=esm", `--outfile=${join(dir, "nesting.js")}`], { stdio: "ignore" });
writeFileSync(join(dir, "package.json"), '{"type":"module"}');
const { clampIndex, cornerSq, EDITOR_START, editorReducer, faults, faultTags, fillOf, firstFree, num, placed, ringGap } = await import(join(dir, "nesting.js"));

const circle = (r, n = 48) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);
const part = (tag, cx, cy, rings) => ({ tag, label: "", order_no: "", od: 0, di: 0, cx, cy, rot: 0, rings });
const rules = { gap: 5, margin: 5, trim_w: 0, trim_h: 0 };
const plate = (...placements) => ({ fmt: [1000, 1000], turned: false, placements });
const ring = [circle(200), circle(150)], disc = [circle(50)];

assert.deepEqual(faults(rules, plate(part("A", 300, 300, ring))), []);
assert.match(faults(rules, plate(part("A", 100, 300, ring)))[0].text, /Nutzfläche/);
assert.match(faults(rules, plate(part("A", 300, 300, disc), part("B", 320, 300, disc)))[0].text, /überlappt/);
assert.match(faults(rules, plate(part("A", 300, 300, disc), part("B", 403, 300, disc)))[0].text, /Abstand/);
assert.deepEqual(faults(rules, plate(part("A", 300, 300, disc), part("B", 407, 300, disc))), []);
assert.deepEqual(faults(rules, plate(part("A", 300, 300, ring), part("B", 300, 300, disc))), [], "a part in the hole is fine");
const edge = faults(rules, plate(part("A", 300, 300, ring), part("B", 400, 300, disc)));
assert.equal(edge.length, 1, "touching the hole edge is not");
assert.deepEqual([...faultTags(edge)].sort(), ["A", "B"]);
assert.deepEqual(placed({ cx: 10, cy: 20, rot: 90 }, [[1, 0]]), [[10, 21]]);
assert.equal(ringGap(circle(10), circle(10).map(([x, y]) => [x + 100, y])) > 79, true);
assert.equal(fillOf(rules, plate(part("A", 300, 300, disc))), 0.355);

// Eckschranke: wie corner_sq, quadriert, an der äußeren Ecke des Umrisskastens.
const corner = (max, extra = {}) => ({ ...rules, corner_max: max, ...extra });
const far = plate(part("A", 300, 300, disc));
const reach = Math.sqrt(cornerSq(rules, { minx: 0, miny: 0, maxx: 350, maxy: 350 }));
assert.deepEqual(faults(corner(null), far), [], "null is no limit");
assert.deepEqual(faults(corner(0), far), [], "0 means unknown, never zero");
assert.deepEqual(faults(corner(undefined), far), [], "a backend without the field is no limit");
assert.deepEqual(faults(corner(reach), far), [], "exactly on the limit is allowed");
const over = faults(corner(reach - 1), far);
assert.equal(over.length, 1);
assert.equal(over[0].tag, "A");
assert.match(over[0].text, /Nullecke/);
assert.match(over[0].text, /495,0 mm/, "German decimal in the fault");
assert.deepEqual(faults(corner(reach - 1, { trim_w: 20, trim_h: 20 }), far), [], "counted from the trimmed corner, like the core");
assert.equal(new Set(faults(corner(reach - 1), plate(part("A", 300, 300, disc), part("B", 500, 300, disc))).map((f) => f.tag)).size, 2);

// Erster freier Platz
const empty = plate();
assert.deepEqual(firstFree(rules, empty, part("N", 0, 0, disc)), [60, 60]);
assert.deepEqual(faults(rules, plate(part("A", 60, 60, disc), part("N", ...firstFree(rules, plate(part("A", 60, 60, disc)), part("N", 0, 0, disc)), disc))), []);
assert.deepEqual(firstFree(rules, plate(part("A", 500, 500, [circle(495)])), part("N", 0, 0, [circle(400)])), [500, 500], "no room: plate centre");
assert.deepEqual(firstFree(corner(60), empty, part("N", 0, 0, disc)), [500, 500], "the corner limit counts too");

assert.equal(num(1234.5, 1), "1.234,5");
assert.equal(num(2), "2");
assert.equal(num(1.5), "1,5");

// Editorzustand: rein, auch wenn StrictMode den Schritt zweimal rechnet.
const start = editorReducer(EDITOR_START, { type: "adopt", plates: [plate(part("A", 300, 300, disc))] });
assert.equal(start.dirty, false);
const step = { type: "change", fn: (e) => { e.plates[0].placements[0].cx += 5; e.plates.push(plate()); } };
const once = editorReducer(start, step);
assert.deepEqual(editorReducer(start, step), once, "same step, same result");
assert.equal(start.edit.plates[0].placements[0].cx, 300, "the old state stays untouched");
assert.equal(once.past.length, 1);
assert.equal(once.dirty, true);
const back = editorReducer(once, { type: "undo" });
assert.equal(back.edit, start.edit);
assert.equal(back.future.length, 1);
const again = editorReducer(back, { type: "redo" });
assert.equal(again.edit, once.edit);
assert.equal(editorReducer(start, { type: "undo" }), start, "nothing to undo");
assert.equal(editorReducer(start, { type: "redo" }), start, "nothing to redo");
assert.equal(editorReducer(editorReducer(back, step), { type: "redo" }).future.length, 0, "a new step clears redo");
assert.equal(clampIndex(3, back.edit.plates.length), 0, "undo took the plate away");
assert.equal(clampIndex(-1, 2), 0);
assert.equal(clampIndex(4, 0), 0);
console.log("Nesting geometry passed: margin, overlap, gap, part in a hole, rotation, fill, corner limit, first free spot, editor state.");
